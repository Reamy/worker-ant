/**
 * 检索层的**取用与择要**纯函数 —— 一处真源（zx_20260930 M7）。
 *
 * 为什么单开零依赖模块：这些算式此前**不存在**——病根是"检索层只有一把尺"：
 *   · §M7-d（Tulving《情景记忆的要素》）：`retrieveTaskRelevant` 只取 `retrieveLayered().longTerm`，
 *     而 longTerm 是 `search()` 的**一个混合分**（0.6·语义 + 0.25·提取强度 + 0.15·重要度）排出来的 top-K。
 *     情景记忆（"上次做类似任务时实际发生了什么"）与语义记忆（"这个项目里的通用知识"）在**同一个池里**
 *     按**同一个分**争名额 ⇒ 语义分高的那层把情景层整体挤出去；而两层的**可及性依据本就不同**：
 *     情景靠**时空情境**（近因：刚发生的更可能复现），语义靠**脱离情境的意义**（重要度 × 提取强度）。
 *   · §M7-e（米勒 7±2 / 巴德利·工作记忆）：注入侧此前按 `getWorkingMemory` 的**原序**（=写入序）铺开，
 *     没有任何"这条比那条更该进"的量；且**存储**的 7 条上限被当成**焦点**的上限用（FIFO 丢最旧）
 *     ⇒ 一条刚记下、还没被复述的笔记，会被下一条笔记挤掉并从**沉淀门**外消失（从未进长期记忆）。
 *     现拆成两个量：**池**（`WM_POOL_CAP`，防无界增长的硬界）与**焦点**（`WM_WINDOW_CAP`，7±2 注入窗口，
 *     按值择要并如实交代略去了哪几条）。
 *
 * 故本模块只放**纯函数**（无 DB、无 Date.now 隐式取用——`nowMs`/取值函数一律**参数传入**），
 * 使受控回归能直接跑**生产这一份实现**（G-1：不自造等价物）。生产调用点在 `memory-manager.ts`。
 *
 * zx_20260930 M7-e 另把 **`extractKeywords` 分词器**移入此处（原为 `MemoryManager._extractKeywords` 私有方法）：
 * 注入侧（`memory-context.ts`）要算"这条笔记与当下任务有多少共同词"，却**够不到**管理器的私有方法
 * （跨模块访问 private 即编译错）。与其在注入侧再抄一份分词（第二处真源），不如把它提到这个零依赖模块
 * ——管理器的 `_extractKeywords` 改为**委托**（签名不变，八处内部调用点与既有判据一字不改），
 * 两侧从此共用**同一份**分词实现。它是纯文本函数，不违本模块"零 DB"的定性。
 *
 * 运行时依赖只有 `./memory-decay.js`（零依赖模块）——`MemoryEntry` 是 `import type`，编译期即擦除，
 * 不成环、不为取个类型把管理器整块拖进脚本模块图。
 */
import type { MemoryEntry } from './memory-manager.js';
import { ageDaysSince } from './memory-decay.js';

// ══════════════════════════════════════════════════════════════════
// M7-d 任务相关记忆：情景 / 语义**分层检索后合并**
// ══════════════════════════════════════════════════════════════════

/** 检索层的两个层名（Tulving 情景/语义二分在检索层的落点）。 */
export type TaskMemoryLayer = 'episodic' | 'semantic';

/** 情景记忆的类型名（`wa_memories.memory_type`）。 */
export const MEM_TYPE_EPISODIC = 'episodic';

/** 一层里的一名候选：带**层名**、**层内排序键**与**层内名次**（名次供下游如实交代"按什么排的"）。 */
export interface LayeredTaskCandidate {
  mem: MemoryEntry;
  layer: TaskMemoryLayer;
  /** 层内排序键，**大者先**。两层用**不同的尺**——见 `splitTaskLayers` 注释。 */
  sortKey: number;
  /** 层内名次（0 起，已按 `sortKey` 降序）。 */
  rank: number;
}

/**
 * 情景层的排序键 ∈ (0,1]：`1 / (1 + 年龄天数)`。
 *
 * 为什么**只用 `created_at`** 而不复用 `memoryAgeDays`（三个语义时间戳取最新）：
 *   本层问的是"那件事**什么时候发生**的"（Tulving：情景记忆自带时空坐标）。`last_used_at` /
 *   `last_reinforced_at` 记的是**我们什么时候又用了它**，不是事件时刻——混进来会把"一条很旧但刚被
 *   检索过的情景"排到"昨天刚发生的情景"前面，恰好抹掉本层要的那把尺。
 *   `updated_at` 更不读（系统改写≠发生）。
 */
function episodicRecencyKey(createdAt: string | null | undefined, nowMs: number): number {
  return 1 / (1 + ageDaysSince(createdAt, nowMs));
}

/**
 * 把候选池**分成两层各排各的**（纯函数，不改入参）。
 *
 *   · **情景层**（`memory_type === 'episodic'`）：按 `episodicRecencyKey`（近因）降序。
 *   · **语义层**（其余全部——`semantic` / `procedural` / 复盘 / 教训 / 限制信念 … 皆属"脱情境的知识"）：
 *     按 `0.4·importance + 0.6·提取强度`降序，**与 `getProjectKnowledge` 同一把尺**
 *     （"重要度不一定最高、但近期真被用过"也算数）；提取强度由调用方传入（`strengthOf`），
 *     本模块不持 DB 句柄。
 *
 * 排序用 `Array.prototype.sort`（V8 稳定）⇒ `sortKey` 相等者**保持入参顺序**，
 * 而入参池来自 `search()` 的混合分降序 ⇒ 同键时以混合分定序，等于给两层各留一个自然的次键。
 */
export function splitTaskLayers(
  pool: MemoryEntry[],
  strengthOf: (m: MemoryEntry) => number,
  nowMs: number,
): { episodic: LayeredTaskCandidate[]; semantic: LayeredTaskCandidate[] } {
  const episodic: LayeredTaskCandidate[] = [];
  const semantic: LayeredTaskCandidate[] = [];
  for (const mem of pool) {
    if (mem.memory_type === MEM_TYPE_EPISODIC) {
      episodic.push({ mem, layer: 'episodic', sortKey: episodicRecencyKey(mem.created_at, nowMs), rank: 0 });
    } else {
      semantic.push({
        mem, layer: 'semantic',
        sortKey: 0.4 * (mem.importance ?? 0) + 0.6 * strengthOf(mem),
        rank: 0,
      });
    }
  }
  const byKey = (a: LayeredTaskCandidate, b: LayeredTaskCandidate) => b.sortKey - a.sortKey;
  episodic.sort(byKey);
  semantic.sort(byKey);
  episodic.forEach((c, i) => { c.rank = i; });
  semantic.forEach((c, i) => { c.rank = i; });
  return { episodic, semantic };
}

/**
 * **轮转交织**两层（各层都有代表），按 id 去重后取前 `topK` 条。
 *
 * 为什么是"交织"而不是"两段拼"或"全按分重排"：
 *   · 两段拼（情景全在前）只是把旧的偏袒**换个方向**——情景层有 4 条就吃掉 4 个名额；
 *   · 全按分重排又要一个**跨层的分**，而两层的 `sortKey` 量纲不同、不可比（一个 ∈(0,1] 的近因分，
 *     一个 [0,1] 的加权分）——拿它们比大小就是**第二处"一把尺量两件事"**。
 *   · 交织不引入新尺：只规定"回合"，名额按**层的产出量**自然分配（谁有货谁多进），
 *     且第一顺位给**情景层**——它正是此前被挤掉的那一层（修法不得沿原方向的偏袒再偏一次）。
 * 去重是**结构性冗余**的防御：两层按 `memory_type` 划分本已互斥，但池子若是外部拼来的，
 * 同一 id 可能两处都出现；此处按 id 挡住，故 `out.length` 恒 ≤ topK 且无重复。
 */
export function mergeTaskLayers(
  episodic: LayeredTaskCandidate[],
  semantic: LayeredTaskCandidate[],
  topK: number,
): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  const seen = new Set<string>();
  const take = (c: LayeredTaskCandidate | undefined) => {
    if (!c || out.length >= topK) return;
    const id = String(c.mem.id);
    if (seen.has(id)) return;
    seen.add(id);
    out.push(c.mem);
  };
  const rounds = Math.max(episodic.length, semantic.length);
  for (let i = 0; i < rounds && out.length < topK; i++) {
    take(episodic[i]);
    take(semantic[i]);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
// M7-f 图式重构召回（巴特莱特《记忆》：回忆是**按当下图式重建**，不是逐字回放）
// ══════════════════════════════════════════════════════════════════

/**
 * 何以"重建"落在**重排**而不是**删除**（这条是刻意的，不是遗漏）：
 *
 *   方案 §M7-f 的举例写的是「按当前任务重述/筛选」。**重述**是模型侧的活，纯函数做不了；
 *   **筛选**若落地为删除，等于在本轮刚撤掉装配层那道按位闸（M7-a：静默丢段是病根）之后，
 *   于检索层**再添一个静默丢点**——而且删的理由是"零相关"这种**分数边界**，不是段优先级那种可解释的序。
 *   故此处只重排：让**当下任务的需求**决定模型先读到哪几条，段级预算（`selectMemorySections`）
 *   随后按这把序裁尾。成员集一字不动 ⇒ 不新增任何"东西去哪了"的黑洞。
 *
 * 打分：`|关键词(记忆) ∩ 关键词(图式)| / |关键词(记忆)|` ——"这条记忆里有多少比例，是当下需求真正点到的"。
 *   分母取**记忆侧**而非图式侧：取图式侧时，一条只被一个需求词碰到的杂记忆与一条**通篇都是需求**的记忆
 *   得分同量级；取记忆侧则后者得 1.0——那才是"整条都被当下需求重构出来"的意思。
 *
 * 只在**真判得出**时标（承 M2-c）：图式或**任一**候选提不出关键词 ⇒ **整趟不动**，返回入参原序。
 *   不做"逐条判、判不出给零分"——那是把"不知道"混进"零分"，正是「只在真知道时标」要禁的。
 *   整池同进同退，也免了"半池按分、半池按位"的第三把尺。
 *
 * 并列时保持入参序（`Array.prototype.sort` 在 V8 稳定）：入参是 `mergeTaskLayers` 的交织结果，
 *   故并列者仍以 M7-d 那两把层内尺定序——本函数**不覆盖**上一跳的结论，只在它之上再做一次重建。
 */
export function applySchemaRecall(
  candidates: MemoryEntry[],
  schemaText: string,
  opts: { keywordsOf: (t: string) => string[] },
): MemoryEntry[] {
  if (candidates.length <= 1) return candidates;
  const schemaKw = new Set(opts.keywordsOf(schemaText).map((t) => t.toLowerCase()));
  if (schemaKw.size === 0) return candidates;
  const scored: Array<{ mem: MemoryEntry; affinity: number; seq: number }> = [];
  for (let i = 0; i < candidates.length; i++) {
    const mem = candidates[i]!;
    const kw = [...new Set(opts.keywordsOf(mem.content).map((t) => t.toLowerCase()))];
    if (kw.length === 0) return candidates; // 任一条判不出 ⇒ 整趟不动（见上）
    scored.push({ mem, affinity: kw.filter((k) => schemaKw.has(k)).length / kw.length, seq: i });
  }
  return scored
    .sort((a, b) => b.affinity - a.affinity || a.seq - b.seq)
    .map((s) => s.mem);
}

// ══════════════════════════════════════════════════════════════════
// 分词器（**一处真源**）：管理器与注入侧共用同一份
// ══════════════════════════════════════════════════════════════════

/**
 * 提取关键词（过滤虚词/停用词 + 中文 bigram 回退，最多 15 个）。
 *
 * 逐字照搬自 `memory-manager.ts` 原私有方法（**值/停用词表一字未动**）——本轮只搬位置，不改分词行为。
 * 为什么搬：注入侧要用它算「这条笔记与当下任务有多少共同词」（§M7-e），而私有方法跨模块够不到。
 */
export function extractKeywords(text: string): string[] {
  const stop = new Set(['的', '了', '在', '是', '和', '与', '及', '或', 'to', 'the', 'for', 'and', 'of', 'a', 'an', '一个', '这个', '那个', '我们', '进行', '需要', '可以', '以及', '通过', '使用', '根据', '任务', '项目', '文件', '内容', '实现', '完成', '处理', '请', '相关', '应该', '如果']);
  // 中文功能字：bigram 含这些字视为噪声丢弃（弥补无分隔符纯中文短语无法切词的短板）
  const stopChars = new Set(['的', '了', '在', '是', '和', '与', '及', '或', '吗', '呢', '啊', '吧', '呀', '这', '那', '个', '些', '也', '都', '就', '还', '而', '且', '但', '若', '则', '请', '给', '让', '被', '把']);

  // 1. 原有分隔符切分（英文/技术词/数字）
  const words = text.split(/[\s,，。、；：！？\n()（）:：/\[\]【】]+/).filter(w => w.length > 1 && !stop.has(w.toLowerCase()));

  // 2. 中文 bigram 回退：对无分隔符的中文连续片段提取 2-gram，捕获「部署/方案/失败」等 2 字实词
  const bigrams: string[] = [];
  const chineseRuns = text.match(/[一-鿿]{2,}/g) || [];
  for (const run of chineseRuns) {
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2);
      if (![...bg].some(c => stopChars.has(c)) && !stop.has(bg)) bigrams.push(bg);
    }
  }

  return [...new Set([...words, ...bigrams])].slice(0, 15);
}

// ══════════════════════════════════════════════════════════════════
// M7-e 工作记忆：**池**（存储）与**焦点**（注入）分开，各自按值
// ══════════════════════════════════════════════════════════════════

/**
 * 注入**焦点**的上限——即米勒 7±2。这是"一次注入几条"的量，**不是**存储上限。
 * 病根：旧实现把它当成 `context_json.working_memory` 的 FIFO 存储上限（`while (wm.length > 7) wm.shift()`），
 * 于是"焦点只有 7 格"被读成"只准记 7 条"——第 8 条笔记一落笔，第 1 条即被销毁，且**再无从沉淀**
 * （`promoteWorkingMemory` 只读还活着的那些）。
 */
export const WM_WINDOW_CAP = 7;

/**
 * **复述池**上限（存储）——防无界增长的一个**硬界**，不主张任何心理学含义（它不是那把尺）。
 * 取 12 的理据只有一条：比焦点（7）宽裕，使"按值择要"在**注入侧**真有取舍可做（池 ≤ 焦点时择要是空转），
 * 同时仍是个小常数。池满时按**同一个值算式**淘汰最低者（不是 FIFO：FIFO 恰好丢最旧，
 * 而新近度只是值的一个因子，值最低者才该出局）。
 */
export const WM_POOL_CAP = 12;

/** 复述强度饱和点：同一条内容被记录到第 3 次即视为"已充分复述"（强度见 `rankWorkingMemory`）。 */
export const WM_REHEARSAL_SATURATION = 3;

/**
 * 新近度的时间常数 τ（**小时**）——一次连续作业的时长量级。
 * 为什么是小时而非天：池里的条目属于**当前任务情境**，其"可及性"按小时变；用天作尺等于把整场任务当一瞬。
 * 写作 `exp(-小时/τ)`：τ=6h ⇒ 1h 前 0.85 / 6h 前 0.37 / 24h 前 0.018（跨日任务里旧笔记自然退场）。
 * 与 `memory-decay.ts` 的分工：那里管**已落库**记忆的年龄（天；三个语义时间戳）；
 * 这里管**任务内**便签的新近度（小时；只有 `ts` 一个时刻）。两处互不引用，各自一处真源。
 */
export const WM_RECENCY_TAU_HOURS = 6;

/**
 * 工作记忆条目（`wa_tasks.context_json.working_memory` 的一项）。
 *
 * `ts` 的语义是**最近一次被记录/复述的时刻**（同内容再记一次即复述：`n` 加一、`ts` 刷新）。
 * 旧实现无条件 push，同一内容记两遍就占两格、沉淀时靠内容哈希去重——即"复述"这件事
 * 在库里被记成了**两条**，而不是**一次更强的复述**。
 */
export interface WorkingMemoryItem {
  content: string;
  ts: string;
  /** 复述次数（缺省 1 = 只记录过一次；老数据无此列按 1 读）。 */
  n?: number;
  /**
   * zx_20261027_1 M5（维特根斯坦「不要想，要看」）：这条结论的出处是否**本任务真读过**。
   * `true` 只表示"引用的文件在本任务内被 read_file 读过"，**不表示结论一定正确**。
   * 缺省（老数据/未给出处）按 `false` 读——推断与实证不同权。
   */
  verified?: boolean;
  /** 出处文件（绝对路径由工具侧解析后落库）。 */
  file_path?: string;
}

/** 一条工作记忆的**可解释的量**：三个因子与它们的乘积。因子各自落在 [0,1]。 */
export interface WorkingMemoryValue {
  item: WorkingMemoryItem;
  /** 复述强度 = min(1, n / WM_REHEARSAL_SATURATION)。**下界不为 0**：只记过一次的笔记若值恒 0，就永远进不了焦点。 */
  strength: number;
  /** 任务相关度 = 该条关键词里也出现在任务文本里的比例（不可判时中性 1，见 `relevanceJudged`）。 */
  relevance: number;
  /** 新近度 = exp(−距今小时 / WM_RECENCY_TAU_HOURS)。 */
  recency: number;
  /** 相关度是否**真判得出**（任务文本与笔记都能提出关键词）。false ⇒ `relevance` 只是中性 1，账里须如实说明。 */
  relevanceJudged: boolean;
  /** 价值 = 强度 × 相关度 × 新近度（方案 §M7-e 的"可解释的量"）。 */
  value: number;
}

/**
 * 给每条工作记忆算价值并**降序**排（纯函数，不改入参）。
 *
 * 三点刻意的选择：
 *   · **成熟度 → 新近度**（就地订正方案 §M7-e 的第三个量）：方案原文写"强度 × 相关度 × **成熟度**"，
 *     而成熟度在长期记忆里的定义是「验证深度 × 龄期」（`MemoryManager.maturityOf`），**龄期越大越成熟**。
 *     工作记忆没有 `success_count`（只有一次任务内的十几次 `note`），也活不过这场任务，
 *     把"龄期越大越成熟"搬过来会得到一个**方向相反**的尺：越旧越该留、越新越该丢，
 *     恰与米勒/巴德利的"焦点装着**当下**的情境"相反，且刚记下的那条会当场出局。
 *     故第三个量取**新近度**，名字据实（名实相符），并在方案文件里记下这处订正。
 *   · **相关度不可判时不乘**：任务文本或笔记提不出关键词 ⇒ 中性 1 且 `relevanceJudged=false`
 *     （「只在真知道时标」）。不引入凭空的保底系数——那会把"不知道"伪装成一个数。
 *   · **同值时的次序**：并列则**新的在前**（稳定排序后按 `ts` 再定一次），使输出确定、不靠入参顺序。
 */
export function rankWorkingMemory(
  items: WorkingMemoryItem[],
  opts: { taskText: string; keywordsOf: (t: string) => string[]; nowMs: number },
): WorkingMemoryValue[] {
  const taskKw = new Set(opts.keywordsOf(opts.taskText).map((t) => t.toLowerCase()));
  return items.map((item) => {
    const n = Math.max(1, item.n ?? 1);
    const strength = Math.min(1, n / WM_REHEARSAL_SATURATION);
    const noteKw = [...new Set(opts.keywordsOf(item.content).map((t) => t.toLowerCase()))];
    const judged = taskKw.size > 0 && noteKw.length > 0;
    const relevance = judged ? noteKw.filter((k) => taskKw.has(k)).length / noteKw.length : 1;
    const hours = ageDaysSince(item.ts, opts.nowMs) * 24;
    const recency = Math.exp(-hours / WM_RECENCY_TAU_HOURS);
    return { item, strength, relevance, recency, relevanceJudged: judged, value: strength * relevance * recency };
  }).sort((a, b) => b.value - a.value || ageDaysSince(a.item.ts, opts.nowMs) - ageDaysSince(b.item.ts, opts.nowMs));
}

/**
 * 从池里按值取前 `cap` 条进**焦点**，其余如实作为 `dropped` 返回（供注入侧交代"略去了哪几条"）。
 * `cap <= 0` ⇒ 一条不取、全部算 dropped（调用方自行决定要不要注入这一段）。
 */
export function selectWorkingMemory(
  items: WorkingMemoryItem[],
  cap: number,
  opts: { taskText: string; keywordsOf: (t: string) => string[]; nowMs: number },
): { kept: WorkingMemoryValue[]; dropped: WorkingMemoryValue[] } {
  const ranked = rankWorkingMemory(items, opts);
  const n = Math.max(0, cap);
  return { kept: ranked.slice(0, n), dropped: ranked.slice(n) };
}
