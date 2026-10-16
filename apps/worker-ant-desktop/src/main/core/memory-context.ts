/**
 * zx_20260924_1 M7-c：`buildMemoryContext` 从 `agent-executor.ts` **整块外迁**至此。
 *
 * 为什么迁：执行体是"一步步执行任务"的地方，而"要往上下文里塞哪几段记忆"是**另一件事**——
 * 后者在 F9 里正是"没有一把量真活的尺子"的那半边：段的取舍（值/优先级/整段省略）与预算真源
 * （`CTX_MEMORY_MAX_CHARS`）分散两处，谁都量不了它。迁出后本模块可被**真装配**路径
 * （`exec-context.ts` 的 `buildTaskContext`）就地度量，见 `scripts/rr_zx_20260924_1_b7.ts`。
 *
 * 预算**以参数传入**（`budgetChars`）而非 import 常量：`CTX_MEMORY_MAX_CHARS` 的真源仍在执行体
 * （C35 钉它必须仍可从 `agent-executor.ts` import），若此处 import 之即成
 * `memory-context ⇄ agent-executor` **循环 import**。参数化后本模块零依赖执行体。
 *
 * 迁出的还有 `memoryConfTag`——它是本函数的辅助，然而执行体侧「注入明细」渲染处**另有一处调用点**；
 * 留在原地会逼出上面那条循环，故一并迁出（`export`）、由执行体 import 取用。
 *
 * `MEM_OVERHEAD` 由函数内局部常量上提为**模块级导出**：原断言钉的是字符串
 * `'const MEM_OVERHEAD = 220'`，上提后改钉符号，判据只强不弱（"预算 = 上限 − 开销"仍在，
 * 且从此可被直接 import 度量）。
 *
 * ⚠ 扫描面：本模块已并入 `scripts/lib/rr-engine-src.ts` 的 `engineSrcFiles()`——
 *   凡本意是"某功能的实现必须经由某个写口"的判据，迁移前后扫到的**并集内容几乎不变**
 *   （记忆装配代码从执行体挪到这里，仍在并集内），故这是"扫描面跟着实现走"，不是放宽。
 */
import type { MemoryManager, MemoryEntry } from './memory-manager.js';
// zx_20261014_4 批五: 「项目域知识」段——把批四派生的**零 LLM 事实册**按任务形态择节注入（取代 panorama 段）。
//   择节/折算两把尺同出 `core/project-knowledge.ts`（与节词表同处，免得分家）；
//   节的人话名亦取该处 `PROJECT_KNOWLEDGE_SECTION_LABEL`（标题只此一处真源，不手抄）。
import { selectKnowledgeForInject, KNOWLEDGE_INJECT_MAX_TOKENS, PROJECT_KNOWLEDGE_SECTION_LABEL } from './project-knowledge.js';
// zx_20260930 M7-e: 工作记忆的**焦点择要**（池 → 焦点 7±2）与分词器同出 `core/memory-select.js`
//   （零依赖纯模块）。此前本模块按 `getWorkingMemory` 的**原序**铺开，没有任何"这条比那条更该进"的尺；
//   分词器也从管理器私有方法提到了该模块——否则这里够不到它，只能抄第二份（那是第二处真源）。
import { selectWorkingMemory, WM_WINDOW_CAP, extractKeywords, type WorkingMemoryValue } from './memory-select.js';
// zx_20261012_1 批一（M29 静默失败清零）: 各段装配的空 catch 换为 `recordMemoryFailure` —— 降级不变，但留痕。
import { recordMemoryFailure, MEM_FAIL } from './memory-failure.js';


// zx_20260911_5 M4-1（艾宾浩斯·系列位置 + 米勒/巴德利·工作记忆 + 道德经·知止）:
// 记忆块按**段**取舍。旧实现由 truncateCtx 按**位**掐尾，而最贴当前任务的段（工作记忆/已知盲区/负空间/
// 复盘教训/心中贼/验收失败预警）**恰在 parts 末尾** ⇒ 预算一满整段被丢（E8）。现改为：段带优先级，
// 按**值**整段保留/整段省略，越界如实标注。
export type MemSectionPriority = 'high' | 'mid' | 'low';
// zx_20260912 M4: `ids` = 该段**真正写进文本**的记忆 id（可选，无记忆来源的段不带）。
// 取舍按原对象过滤 ⇒ 省略段的 id 随之被省略，"记账即事实"由此成立。
export interface MemSection { name: string; priority: MemSectionPriority; text: string; ids?: string[] }

// 段优先级表（M4-2）：高=最贴当前任务；低=泛化背景；其余为中。
export const MEM_SECTION_PRIORITY: Record<string, MemSectionPriority> = {
  // zx_20261014_4 批五: `项目知识全景`（LLM 每轮重综合的散文）已**退役**，其消费位置由
  //   `项目域知识`（零 LLM 事实册，见 `project-knowledge.ts`）**接管**——同为泛化背景 ⇒ 同为 'low'。
  项目域知识: 'low',
  记忆有效性: 'low',
  跨项目知识迁移: 'low',
  任务关键约束: 'high',
  任务立志: 'high',
  工作记忆: 'high',
  已知盲区提醒: 'high',
  负空间提醒: 'high',
  复盘教训: 'high',
  心中贼提醒: 'high',
  验收失败预警: 'high',
};
export function sectionPriority(name: string): MemSectionPriority {
  return MEM_SECTION_PRIORITY[name] ?? 'mid';
}

/**
 * 整段取舍（不掐半句）：超预算按「低→中→高」逐段丢弃，同级内后位先丢；至少保留 1 段。
 * 渲染保持原序——按**值**选，不按位排（不无谓重排叙事顺序）。
 */
export function selectMemorySections(sections: MemSection[], maxChars: number): { kept: MemSection[]; omitted: MemSection[]; chars: number } {
  const SEP = 2; // '\n\n'
  const sizeOf = (arr: MemSection[]) => arr.reduce((n, s) => n + s.text.length, 0) + Math.max(0, arr.length - 1) * SEP;
  const rank: Record<MemSectionPriority, number> = { low: 0, mid: 1, high: 2 };
  const alive = new Set<number>(sections.map((_, i) => i));
  // 丢弃顺序：优先级低者先；同级内后位先（保留更靠前的"主干"表述）
  const order = sections.map((s, i) => ({ s, i })).sort((a, b) => rank[a.s.priority] - rank[b.s.priority] || b.i - a.i);
  const current = () => sections.filter((_, i) => alive.has(i));
  for (const { i } of order) {
    if (alive.size <= 1) break;
    if (sizeOf(current()) <= maxChars) break;
    alive.delete(i);
  }
  const kept = sections.filter((_, i) => alive.has(i));
  const omitted = sections.filter((_, i) => !alive.has(i));
  return { kept, omitted, chars: sizeOf(kept) };
}
/**
 * 包裹开销预留（`<memory-context>` 标签 + 引言 + 段间分隔 + 省略注记）。
 * zx_20260924_1 M7-c：原为 `buildMemoryContext` 内的局部常量，上提为模块级导出——
 * 算式 "有效预算 = 上限 − 开销" 由此可被直接 import 度量。
 */
export const MEM_OVERHEAD = 220;

/**
 * 工作记忆择要的**如实交代**（zx_20260930 M7-e）。
 *
 * 为什么注记写在**段文本里**而不是段对象上：`meta` 的形状被既有判据钉死
 * （`{sections, kept, omitted, chars}` 四个数按字面核），"略去哪几条"又是本段**自己的**事——
 * 故与「（记忆预算：已省略 N 段：…）」同法，写在要读它的人眼前。
 * 未发生择要（一条未丢）时返回空串："没省略"不必印一句"省略了 0 条"占地方。
 */
export function wmOmitNote(poolSize: number, keptSize: number, dropped: WorkingMemoryValue[]): string {
  if (dropped.length === 0) return '';
  const names = dropped.slice(0, 3).map((d) => d.item.content.replace(/\s+/g, ' ').slice(0, 20)).join('、');
  return `\n\n（工作记忆：池中 ${poolSize} 条，按「复述次数 × 任务相关度 × 新近度」择要 ${keptSize} 条进焦点，略去 ${dropped.length} 条：${names}${dropped.length > 3 ? '…' : ''}）`;
}

/**
 * Phase 2.1: 构建项目记忆上下文，注入Agent系统提示。
 * 检索策略：项目知识(Top5) + 近期经验(Top3) + 通用智慧(Top2)
 */
/**
 * Phase B: 生成记忆可信度/来源/亲历标注标签（源监控展示）。Phase A: 增加成熟度标注。
 *
 * ⚠ 必须 `export`：本函数有**两个**调用方——本模块内的 \`buildMemoryContext\`（4 处）与执行体
 *   \`agent-executor.ts\` 的「注入明细」渲染（1 处）。它是**共享**辅助而非本模块私有，
 *   故随迁出模块一并导出（若留在执行体则执行体 ↔ 本模块互为依赖，成循环）。
 */
export function memoryConfTag(memory: MemoryManager, m: MemoryEntry, taskText?: string): string {
  let t = memory.confidenceOf(m) < 0.55 ? '（可信度低，谨慎参考）' : '';
  try {
    const ctx = JSON.parse(m.context_json || '{}') as { evidence?: { file_path?: string; verified?: boolean }; experience?: string; staleness?: unknown; applicability?: { conditions?: unknown; stability?: string } };
    const ev = ctx.evidence;
    if (ev?.file_path) t += `（来源: ${ev.file_path.split('/').pop()}）`;
    else if (ev?.verified) t += '（已验证）';
    if (ctx.experience === 'direct') t += '（亲历）';
    else if (ctx.experience === 'inferred') t += '（推断）';
    if (ctx.staleness) t += '（可能过时）';
    // Phase A (2026-08-27) 空性·缘起：适用条件标注（易变/条件可能已变）
    if (ctx.applicability) {
      if (ctx.applicability.stability === 'volatile') t += '（易变·无常）';
      if (taskText && memory.applicabilityMismatch(m, taskText)) t += '（条件可能已变）';
    }
  } catch (err) { recordMemoryFailure(MEM_FAIL.contextTag, err); }
  // Phase A 大器晚成：成熟度标注（暂定/成熟）
  try {
    const mat = memory.maturityOf(m);
    if (mat < 0.25) t += '（暂定·未成熟）';
    else if (mat >= 0.6) t += '（成熟）';
  } catch (err) { recordMemoryFailure(MEM_FAIL.contextTag, err); }
  return t;
}

// ⚠ 迁出后**全部参数都改为必填形**（`T | undefined` 而非 `T?`）：TS 不允许必填参数排在可选参数之后，
//   而 `budgetChars` 必须必填——若给它默认值就得在这里再写一个 6000，那是**第二处预算真源**
//   （旧断言明禁"另立阈值"）；若做成可选又留下"忘了传预算"的静默口子。故改为"全必填、可传 undefined"，
//   漏传预算即**编译错**（比运行时默认值更强）。调用方多为脚本，多写几个 `undefined` 是无害的代价。
export function buildMemoryContext(memory: MemoryManager, projectId: string, taskId: string | undefined, principalContradiction: string | undefined, taskGoal: { goal: string; success_criteria: string; investigate: string[] } | null | undefined, excludeIds: ReadonlySet<string> | undefined, budgetChars: number): { context: string; accessedIds: string[]; meta: { sections: number; kept: number; omitted: number; chars: number }; segmentChars: Array<{ name: string; chars: number; kept: boolean }> } {
  const parts: MemSection[] = [];
  // zx_20260911_5 M4-1: 每段带名带级，供 selectMemorySections 按值整段取舍
  // zx_20260912 M4(王阳明·知行合一 · 夏克特·错误归因): 段还须带**自己的记忆 id**——取舍之后才谈得上"谁真被用过"。
  const add = (name: string, text: string, ids?: string[]) => {
    parts.push(ids && ids.length > 0 ? { name, priority: sectionPriority(name), text, ids } : { name, priority: sectionPriority(name), text });
  };
  // 段间/跨 run 去重的**候选集**（不代表"已入文"——是否入文由 selectMemorySections 之后的 kept 段说了算）
  const candidateIds: string[] = [];
  // zx_20260904_4 T3 (2026-09-04): 跨 run 去重——先前已注入的记忆本次不再重复注入（多次 resume 省 Token）
  const excluded = excludeIds ?? new Set<string>();
  const notExcluded = <T extends { id: string }>(arr: T[]): T[] => arr.filter((m) => !excluded.has(m.id));
  // zx_20260905 批2 (2026-09-05): 段间去重——同一记忆仅在第一处出现（检索函数跨段重复命中会以文本重复入文浪费 token）。
  // 以 candidateIds 为参照：仅保留尚未出现者并记入 candidateIds；调用方须把 kept 的 id 一并交给 add（段 ↔ id 对应）
  const appendFresh = <T extends { id: string }>(arr: T[]): T[] => {
    const seen = new Set(candidateIds);
    const kept = arr.filter((m) => !seen.has(m.id));
    for (const m of kept) candidateIds.push(m.id);
    return kept;
  };

  // zx_20260911_5 M4-3（纯省算，不改语义）: findSimilarTasks 同参在本函数内被调 3 次（4 段 / A1 段 / 11 段）
  // ——一次取、多处用。检索谓词与结果不变。
  let similarTasksCache: Array<{ id: string; title: string; status: string; similarity: number }> | null = null;
  const getSimilarTasks = (): Array<{ id: string; title: string; status: string; similarity: number }> => {
    if (!similarTasksCache && taskId) similarTasksCache = memory.findSimilarTasks(projectId, taskId, 3);
    return similarTasksCache ?? [];
  };

  // Phase 3.2: 读当前任务原型，作为编码语境匹配的基准
  const currentArchetype = taskId ? memory.getTaskArchetype(taskId) : null;
  // Phase 3.1/3.2: 任务文本（前瞻记忆触发 + 线索依赖提取的检索查询）
  const taskText = taskId ? memory.getTaskText(taskId) : '';

  // 0. 项目域知识（维特根斯坦·不要想，要看：知识不从"综合"里来，从**已发生的事实**里来。
  //    zx_20261014_4 批五——以**零 LLM 事实册**（批四 `deriveProjectKnowledge` 落库者）**取代**
  //    原先 `retrieveByType('panorama')` 的 LLM 每轮重综合段：花钱、不可复现、越写越长的病根在此结清。
  //    择节按任务形态（`selectKnowledgeForInject`：整节取舍、绝不截字），预算为本段自身的**上界**——
  //    全局预算仍由 `budgetChars` 持有（此处不再吃第二份预算）。
  //    ⚠ 防御式探方法：rr 的多数桩不含 `listDomainKnowledge`（那是本轮的**新**读口）⇒ 缺失即无此段，
  //      且**不**记 `recordMemoryFailure`（"桩没有这个方法"不是生产故障，不该污染失败账）。
  try {
    const book = typeof memory.listDomainKnowledge === 'function' ? memory.listDomainKnowledge(projectId) : [];
    const picked = selectKnowledgeForInject(book, currentArchetype, KNOWLEDGE_INJECT_MAX_TOKENS);
    if (picked.length > 0) {
      add('项目域知识', '## 项目域知识\n' + picked
        .map((e) => `### ${PROJECT_KNOWLEDGE_SECTION_LABEL[e.section]}\n${e.content}`).join('\n'));
    }
  } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '项目域知识' }); }

  // 0b. 记忆有效性摘要（实事求是：实践检验——哪些类型记忆真有用）
  try {
    const stats = memory.buildMemoryEffectivenessStats(projectId);
    if (stats.length > 0) {
      add('记忆有效性', '## 记忆有效性\n' + stats.slice(0, 5).map(s => `- ${s.memoryType}: 成功率 ${Math.round(s.successRate * 100)}%（${s.sampleCount}样本）`).join('\n'));
    }
  } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '记忆有效性' }); }

  // 0c. 执行打法（具体问题具体分析——该类型任务的已验证/避免工具）
  if (currentArchetype) {
    try {
      const playbook = memory.buildExecutionPlaybook(projectId);
      const approach = playbook[currentArchetype];
      if (approach) {
        add('执行打法', '## 执行打法\n' + `[${currentArchetype}] ${approach}`);
      }
    } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '执行打法' }); }
  }

  // 0d. 任务关键约束（毛选·主要矛盾——决定成败的那一点，集中精力于此，勿平均用力）
  if (principalContradiction) {
    add('任务关键约束', '## 任务关键约束\n本任务成败关键：' + principalContradiction + '。集中精力于主要矛盾，勿平均用力。');
  }

  // 0e. 任务立志（王阳明·立志 + 毛选·调查研究——明确核心目标+成功标准+先调查）
  if (taskGoal?.goal) {
    const inv = taskGoal.investigate && taskGoal.investigate.length > 0
      ? `\n执行前请先调查：${taskGoal.investigate.join('、')}`
      : '';
    add('任务立志', '## 任务立志\n核心目标：' + taskGoal.goal + (taskGoal.success_criteria ? `\n成功标准：${taskGoal.success_criteria}` : '') + inv);
  }

  // 1. 同项目 semantic/procedural → Top 5
  try {
    const semantic = memory.retrieveByType('semantic', projectId, 3, currentArchetype, taskText);
    const procedural = memory.retrieveByType('procedural', projectId, 3, currentArchetype, taskText);
    const knowledge = appendFresh(notExcluded([...semantic, ...procedural]
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 5)));
    if (knowledge.length > 0) {
      add('项目知识', '## 项目知识\n' + knowledge.map((m, i) => {
        const valenceTag = m.valence === 'positive' ? '✓' : m.valence === 'negative' ? '✗' : '';
        const confTag = memoryConfTag(memory, m, taskText);
        return `${i + 1}. ${valenceTag}${m.content.slice(0, 300)}${confTag}`;
      }).join('\n'), knowledge.map(m => m.id));
    }
  } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '项目知识' }); }

  // 2. 同项目 episodic → Top 3（最近的）
  try {
    const episodic = appendFresh(notExcluded(memory.retrieveByType('episodic', projectId, 3, currentArchetype, taskText)));
    if (episodic.length > 0) {
      add('近期经验', '## 近期经验\n' + episodic.map((m, i) => {
        const valenceTag = m.valence === 'positive' ? '✓' : m.valence === 'negative' ? '✗' : '';
        const confTag = memoryConfTag(memory, m, taskText);
        return `${i + 1}. ${valenceTag}${m.content.slice(0, 300)}${confTag}`;
      }).join('\n'), episodic.map(m => m.id));
    }
  } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '近期经验' }); }

  // 3. 范例记忆（exemplar）→ Top 2
  // zx_20260913 M4-3(记账即事实): 此前只传文本、不传 ids ⇒ 既不能跨 run 排除（每次 resume 重复注入），
  // 也永不计 `use_count`（"被用过"这一事实对范例永远不成立，A2 的有效样板排序因此长不出数据）。
  try {
    const exemplarIds: string[] = [];
    const exemplarCtx = memory.generateExemplarContext(projectId, { excluded, outIds: exemplarIds });
    if (exemplarCtx) add('范例记忆', exemplarCtx, exemplarIds);
  } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '范例记忆' }); }

  // 4. 相似历史任务（提取线索，家族相似）→ 同项目 Top3 + 跨项目 Top2
  if (taskId) {
    try {
      const similar = getSimilarTasks();
      const cross = memory.findCrossProjectSimilarTasks(projectId, taskId, 2);
      const simItems = [
        ...similar.map(s => `[同项目 ${s.similarity}%] ${s.title}（${s.status}）`),
        ...cross.map(s => `[跨项目 ${s.similarity}%] ${s.title}（${s.projectName}）`),
      ];
      if (simItems.length > 0) {
        add('相似历史任务', '## 相似历史任务\n以下是与当前任务相似的历史任务（可参考其经验与产出）：\n' + simItems.map((s, i) => `${i + 1}. ${s}`).join('\n'));
      }
    } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '相似历史任务' }); }
  }

  // 4b. 跨项目知识迁移（维特根斯坦家族相似 + 从群众中来到群众中去——注入跨项目已验证的高价值知识）
  if (taskId) {
    try {
      // zx_20260913 M4-3: 补 ids ⇒ 跨 run 排除 + 记账（取回后过滤，与 `notExcluded` 同尺）
      const crossKnowledge = appendFresh(notExcluded(memory.getCrossProjectKnowledge(projectId, taskId, 3)));
      if (crossKnowledge.length > 0) {
        add('跨项目知识迁移', '## 跨项目知识迁移\n以下是从其他相似项目迁移来的已验证高价值知识（标注来源，仅供参考）：\n' + crossKnowledge.map((k, i) => `${i + 1}. [${k.projectName}·${k.memoryType}] ${k.content}`).join('\n'), crossKnowledge.map(k => k.id));
      }
    } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '跨项目知识迁移' }); }
  }

  // 5. 任务相关记忆（三层检索长期层——语义相关，弥补类型检索不看任务相关性）
  // zx_20260930 M7-f（巴特莱特·图式重构召回）: 图式 = **当下任务的需求**（主要矛盾 + 立志三问 +
  //   要调查的项），**不是题面**（题面是本段上游检索自己的取数源，拿它当图式＝同一把逐字尺再量一遍）。
  //   本函数是唯一同时握有这三样东西的地方（它们正是本函数的入参），故图式在此拼、作为第四个实参传下去。
  //   缺哪一样就少拼哪一样；三样都缺 ⇒ 传 `''` ⇒ 管理器侧判不出图式、原序返回（旧口径）。
  const schemaText = [principalContradiction ?? '', taskGoal?.goal ?? '', taskGoal?.success_criteria ?? '', ...(taskGoal?.investigate ?? [])]
    .filter((s) => s.trim().length > 0).join('。');
  if (taskId) {
    try {
      const relevant = appendFresh(notExcluded(memory.retrieveTaskRelevant(taskId, projectId, 5, schemaText)));
      if (relevant.length > 0) {
        add('任务相关记忆', '## 任务相关记忆\n以下是与当前任务语义相关的历史记忆（可复用其结论）：\n' + relevant.map((m, i) => {
          const confTag = memoryConfTag(memory, m, taskText);
          return `${i + 1}. ${m.content.slice(0, 300)}${confTag}`;
        }).join('\n'), relevant.map(m => m.id));
      }
    } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '任务相关记忆' }); }
  }

  // 5b. 线索依赖提取（编码特异性——关键词线索匹配，弥补纯语义检索的"记得有但找不到"）
  if (taskId && taskText) {
    try {
      const cueHits = appendFresh(notExcluded(memory.retrieveByCue(taskText, projectId, 4)));
      if (cueHits.length > 0) {
        add('线索匹配记忆', '## 线索匹配记忆\n以下是与当前任务关键词线索相关的历史记忆（可复用其结论）：\n' + cueHits.map((m, i) => {
          const confTag = memoryConfTag(memory, m, taskText);
          return `${i + 1}. ${m.content.slice(0, 300)}${confTag}`;
        }).join('\n'), cueHits.map(m => m.id));
      }
    } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '线索匹配记忆' }); }
  }

  // 6. 高频复用知识（getProjectKnowledge）—— B1 (2026-08-31) 去机械门控，按 id 去重后补充注入（与第1段 semantic/procedural 无重叠才注入）
  // zx_20260913 M4-1(维特根斯坦·意义即使用): 段名与标题此前与第1段**同名** `## 项目知识`，但两者取数谓词与排序函数皆不同：
  // 段1 = retrieveByType('semantic'|'procedural') 按 importance 取 top5；本段 = 同表 semantic、importance>=0.3、
  // 按 0.4*importance+0.6*retrievalStrength 排序取 3（memory-manager.ts:643-652）——**含"重要度不高但近期真被用过"的知识**。
  // 同名两段 ⇒ 模型无从分辨某条来自哪把尺（D5 裁定：语义确有区分 ⇒ 分名，不合并）。改名后与段1 无前缀歧义。
  try {
    const fresh = appendFresh(notExcluded(memory.getProjectKnowledge(projectId, 3)));
    if (fresh.length > 0) {
      add('高频复用知识', '## 高频复用知识\n以下为近期检索中**确实被取用过**的项目语义知识（按提取强度排序，重要度不一定最高）：\n' + fresh.map((m, i) => `${i + 1}. ${m.content.slice(0, 300)}`).join('\n'), fresh.map(m => m.id));
    }
  } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '高频复用知识' }); }

  // 7. 知识图谱关联（家族相似性——实体关系）
  if (taskId) {
    try {
      const triples = memory.retrieveKnowledgeGraphContext(taskId, projectId, 5);
      if (triples.length > 0) {
        add('相关知识关联', '## 相关知识关联\n' + triples.map(t => `- ${t.subject} ─[${t.predicate}]→ ${t.object}`).join('\n'));
      }
    } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '相关知识关联' }); }
  }

  // 8. 前瞻记忆触发（记住未来要做的事——事件型/时间型命中即注入）
  if (taskId && taskText) {
    try {
      const triggered = appendFresh(notExcluded(memory.getTriggeredProspective(projectId, taskText)));
      if (triggered.length > 0) {
        for (const m of triggered) { memory.markProspectiveTriggered(m.id); }
        add('前瞻记忆', '## 前瞻记忆（待办提醒）\n以下是你之前登记的未来意图，现已触发，请结合当前任务处理：\n' + triggered.map((m, i) => `${i + 1}. ${m.content.slice(0, 300)}`).join('\n'), triggered.map(m => m.id));
      }
    } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '前瞻记忆' }); }
  }

  // 9. 工作记忆（任务内临时情境：**池**里按值择要进**焦点**，7±2；略去哪几条如实交代）
  // zx_20260930 M7-e（米勒 7±2 / 巴德利·工作记忆）：旧实现按 `getWorkingMemory` 的**原序**（=写入序）铺开，
  //   没有"这条比那条更该进"的量——第 8 条笔记一落笔，第 1 条就可能因存储上限出局且**再无从沉淀**。
  //   现分两把尺：存储是**池**（`WM_POOL_CAP`，硬件界），注入是**焦点**（`WM_WINDOW_CAP`，7±2）。
  //   择要算式与本处够不到的分词器同出 `core/memory-select.js`（**一处真源**，避免注入侧自造第二把尺）。
  if (taskId) {
    try {
      const pool = memory.getWorkingMemory(taskId);
      if (pool.length > 0) {
        const { kept, dropped } = selectWorkingMemory(pool, WM_WINDOW_CAP, {
          taskText, keywordsOf: extractKeywords, nowMs: Date.now(),
        });
        if (kept.length > 0) {
          add('工作记忆', '## 工作记忆（当前任务情境）\n' + kept.map((w, i) => `${i + 1}. ${w.item.content.slice(0, 300)}`).join('\n') + wmOmitNote(pool.length, kept.length, dropped));
        }
      }
    } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '工作记忆' }); }
  }

  // 10. 知识盲区提示（知不知，上——已知盲区命中则主动提醒避免重复尝试）
  if (taskId && taskText) {
    try {
      const unknowns = appendFresh(notExcluded(memory.retrieveUnknownHits(taskText, projectId, 3)));
      if (unknowns.length > 0) {
        add('已知盲区提醒', '## 已知盲区提醒\n以下是你之前登记的知识盲区，若当前任务涉及请谨慎处理或升级到人工：\n' + unknowns.map((m, i) => `${i + 1}. ${m.content.slice(0, 300)}`).join('\n'), unknowns.map(m => m.id));
      }
    } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '已知盲区提醒' }); }
  }

  // 10b. 负空间提醒（有无相生——已知试过失败/刻意回避的事项，命中则预警避免重复踩坑）
  if (taskId && taskText) {
    try {
      const negatives = appendFresh(notExcluded(memory.retrieveNegativeHits(taskText, projectId, 3)));
      if (negatives.length > 0) {
        add('负空间提醒', '## 负空间提醒\n以下是你之前登记为「试过失败/刻意回避」的事项，若当前任务涉及请避免重复该做法：\n' + negatives.map((m, i) => `${i + 1}. ${m.content.slice(0, 300)}`).join('\n'), negatives.map(m => m.id));
      }
    } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '负空间提醒' }); }
  }

  // 10c. 复盘教训（实践论「再认识」——历史任务复盘出的偏差与教训，供当前任务参考）
  try {
    const retrospectives = appendFresh(notExcluded(memory.retrieveByType('retrospective', projectId, 2)));
    if (retrospectives.length > 0) {
      add('复盘教训', '## 复盘教训\n以下是本项目历史任务的复盘教训（计划与实际的偏差），参考可避免重复偏差：\n' + retrospectives.map((m, i) => `${i + 1}. ${m.content.slice(0, 300)}`).join('\n'), retrospectives.map(m => m.id));
    }
  } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '复盘教训' }); }

  // 10d. 心中贼提醒（王阳明·破心中贼——历史自我设限信念，提醒先客观评估是否真不可行，别急着放弃）
  try {
    const beliefs = appendFresh(notExcluded(memory.retrieveByType('limiting_belief', projectId, 2)));
    if (beliefs.length > 0) {
      add('心中贼提醒', '## 心中贼提醒\n以下是你此前在失败任务中流露的自我设限信念，若当前任务涉及请先客观评估是否真不可行，别急着放弃：\n' + beliefs.map((m, i) => `${i + 1}. ${m.content.slice(0, 300)}`).join('\n'), beliefs.map(m => m.id));
    }
  } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '心中贼提醒' }); }

  // 10e. 识别纠错（B2/C1 毛选实践论——历史识别偏差教训，供当前识别参考，识别随实践校准）
  try {
    const corrections = appendFresh(notExcluded(memory.retrieveByType('archetype_correction', projectId, 3)));
    if (corrections.length > 0) {
      add('识别纠错', '## 识别纠错\n以下是你此前对任务类型的识别偏差教训（识别随实践校准），参考可避免重复误判：\n' + corrections.map((m, i) => `${i + 1}. ${m.content.slice(0, 300)}`).join('\n'), corrections.map(m => m.id));
    }
  } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '识别纠错' }); }

  // 10f. 验收失败预警（B2 毛选实践论——历史验收失败模式，执行时预警避免重复踩坑）
  try {
    const acceptanceFails = appendFresh(notExcluded(memory.retrieveByType('acceptance_failure', projectId, 3)));
    if (acceptanceFails.length > 0) {
      add('验收失败预警', '## 验收失败预警\n以下是本项目历史任务的验收失败模式（finalize 前请重点核对，避免重复踩坑）：\n' + acceptanceFails.map((m, i) => `${i + 1}. ${m.content.slice(0, 300)}`).join('\n'), acceptanceFails.map(m => m.id));
    }
  } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '验收失败预警' }); }

  // A1 (2026-09-01): 历史同类经验注入（毛选实践论——从实践中来；随 memoryContext system 消息送达 Agent，勿再写会话行）
  if (taskId) {
    try {
      // zx_20260913 M4-3: 同 范例记忆——补 ids 以支持跨 run 排除与记账
      const expIds: string[] = [];
      const expA1 = memory.getSimilarTaskExperience(projectId, taskId, 3, getSimilarTasks(), { excluded, outIds: expIds });
      if (expA1) add('历史同类经验', expA1, expIds);
    } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '历史同类经验' }); }
  }

  // 10g. 同类验收标准参考（A3 毛选实践论/王阳明事上磨练——从最近同类成功/失败任务的 acceptance_criteria 提炼，finalize 前对照历史验收标准自查）
  if (currentArchetype) {
    try {
      const peerTasks = memory.getPeerAcceptanceCriteria(projectId, currentArchetype, 3);
      if (peerTasks.length > 0) {
        add('同类验收标准参考', '## 同类验收标准参考\n以下是历史同类任务（' + currentArchetype + '）的验收标准（finalize 前请对照自查，确保同类达标项均已覆盖）：\n' + peerTasks.map((t, i) => `${i + 1}. [${t.status === 'completed' ? '成功' : '失败'}]「${t.title}」验收标准：${t.acceptance_criteria.slice(0, 300)}`).join('\n'));
      }
    } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '同类验收标准参考' }); }
  }

  // 11. Phase D 检索失败自省（知道感/舌尖现象——历史有相似任务但常规检索未命中，深度检索补救或显式声明未检索到）
  if (taskId && taskText) {
    try {
      const similar = getSimilarTasks();
      if (similar.length > 0 && candidateIds.length < 2) {
        const recovered = memory.deepRetrieve(taskText, projectId, taskId, 5);
        if (recovered.length > 0) {
          add('记忆检索提示', '## 记忆检索提示\n本任务与历史相似任务但常规检索未命中，已深度检索到以下线索（供参考）：\n' + recovered.map((r, i) => `${i + 1}. ${r.content.slice(0, 200)}`).join('\n'));
        } else {
          add('记忆检索提示', `## 记忆检索提示\n已知晓：本任务与历史任务相似（如「${similar[0]!.title}」），但未检索到直接相关记忆，请谨慎处理或询问用户。`);
        }
      }
    } catch (err) { recordMemoryFailure(MEM_FAIL.contextSection, err, { section: '记忆检索提示' }); }
  }

  if (parts.length === 0) return { context: '', accessedIds: [], meta: { sections: 0, kept: 0, omitted: 0, chars: 0 }, segmentChars: [] };

  // zx_20260911_5 M4-1/M4-4（道德经·知止 + 管子·度量衡）: 按**值**整段取舍，预算内留高优先级；
  // 越界整段省略并**如实标注**省略了几段、分别是哪些（旧实现整块交给 truncateCtx 按位掐尾，无任何交代）。
  //
  const noteOf = (om: MemSection[]): string => om.length > 0
    ? `\n\n（记忆预算：已省略 ${om.length} 段：${om.map(s => s.name).join('、')}）`
    : '';
  const sel = selectMemorySections(parts, Math.max(0, budgetChars - MEM_OVERHEAD));
  const { kept, omitted } = sel;

  // zx_20260929 M4 —— **「把注记计入预算」经实测未采用**（管子·度量衡：先量，再判；量出来的是真数）。
  //   原设想（方案 §M4 原文）：注记"已省略 N 段：…"在 `MEM_OVERHEAD=220` 之外另长出来，段名一多就挤过上限。
  //   24 段富夹具 A/B 实测（同一夹具扫 `budgetChars`，改前 / 改后各跑一次）**否掉了这条**：
  //     · 真包裹长 W = 64（由真输出 `context.length − meta.chars` 测出），净余量 = 220 − 64 = **156**；
  //       注记最长 **160**（23 段全被省略、点名 22 个段名时）⇒ 非保底支越界**上界仅 4 字**
  //       （须恰好 `kept` 一段且其长度 == 预算），保底支（至留 1 段而它本身超预算）则可越很多。
  //     · 保底支：budget 200/260 时渲染 289 > 上限，改前改后**逐字节相同**——预留在该支是 no-op：
  //       最后一段不能丢（丢了是更坏的违约），故缩预算缩不出任何变化。
  //     · 非保底支：budget 400/600/900 时改前**本就不越界**（316/532/774 全落在上限内），
  //       而预留实打实地**白丢一段**（kept 2→1 / 3→2 / 4→3）；budget ≥1500 两版完全一致。
  //   ⇒ 预留只减少交付内容、从不阻止越界，故**不做**（越界那 4 字上界另在 `rr_zx_20260929` D 组实测钉住，
  //     免得后人当缺陷重修一遍——本仓已有"判据自身不成立"的先例）。"注记是上下文的一部分"仍成立，
  //     但它的兑现处是下面的 `meta.chars`（账＝实），不是预算。
  const omittedNote = noteOf(omitted);

  // zx_20260912 M4（王阳明·知行合一 · 艾宾浩斯·提取强度 · 夏克特·错误归因）:
  // 「记账即事实」——被整段省略的记忆**没进过上下文**，就不得记 use_count、不得算作本次注入。
  // 省略注记与 keptIds 同出上面这一次划分 ⇒ 注记点名的段 = 未计入的段（同一份划分的两面）。
  const keptIds = [...new Set(kept.flatMap(s => s.ids ?? []))];

  // Phase 1.3: 批量记录记忆访问追踪（use_count + last_used_at）——只记**真正入文**者
  try { memory.recordAccess(keptIds); } catch (err) { recordMemoryFailure(MEM_FAIL.contextRecordAccess, err); }

  // zx_20260929 M4（管子·度量衡：量出来的要与写出来的对得上）: `meta.chars` 记**真正写进上下文的
  //   字符数**（保留段 + 段间分隔 + 注记）——账＝实。旧实现只记 `sel.chars`（保留段），漏掉注记 ⇒
  //   上游按它算水位时，**越是大段省略反而报得越"省"**（实测：注记 88 字时旧账报 2590、真写 2682）。
  //   本句即上条"注记是上下文的一部分"的兑现处——**账里要算它，预算里不必为它让路**（见上条实测）。
  const chars = sel.chars + omittedNote.length;
  // zx_20261002 M9-③（米勒 7±2 / 巴德利·工作记忆 · 管子·度量衡）: **逐段字节账**。
  //   此前只有聚合量（`meta.chars` / 上游 `memoryCtxChars`）——"注入了 2600 字"说得出来，
  //   但"这 2600 字花在哪几段、哪段最贵、哪段被整段省略了"说不出来 ⇒「注入多、命中差」不可量化。
  //   ⚠ **放在返回对象的兄弟字段、不塞进 `meta`**：`meta` 的四键形状被既有判据按字面核
  //     （`rr_zx_20260930` G-a-27 明写"一字未动"），那是上一轮为「注记写在段文本里」这条结论立的界，
  //     本轮**不去动它**——新账另起一栏即够（它服务的读者是水位/诊断，不是既有四键的读者）。
  //   语义：`kept=false` 的段**没进过上下文**（其字节不计入 `chars`），与 `accessedIds` 同一次划分。
  const keptSet = new Set(kept);
  const segmentChars = parts.map(s => ({ name: s.name, chars: s.text.length, kept: keptSet.has(s) }));
  return {
    context: `<memory-context>
[以下是本项目的相关记忆，请参考这些经验来完成当前任务]
${kept.map(s => s.text).join('\n\n')}${omittedNote}
</memory-context>`,
    accessedIds: keptIds,
    meta: { sections: parts.length, kept: kept.length, omitted: omitted.length, chars },
    segmentChars,
  };
}
