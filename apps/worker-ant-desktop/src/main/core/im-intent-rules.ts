/**
 * zx_20261110_1 B1（维特根斯坦·意义即用法 / 亚里士多德·四因）:
 * IM 文本的**词表与判定**——纯函数、零 IO、零依赖，`im-intent.ts` 与 `im-commands.ts` 共用同一份。
 *
 * 病根：`分析/搜索/查一下/调查/写/生成` 被当成"建单动词"，于是「分析一下昨天的日志」
 * 直接建出任务；否定句「先别创建任务，看看进展」也被当成建单。
 *
 * 两级词表的**目的因**：
 *   - 强建单：用户明确要"造一个任务"（创建/新建/做一个/帮我做/build/create/make）；
 *   - 软研究：用户想"知道/得到点什么"（分析/搜索/查一下/调查/生成/写）——
 *     单独出现**不构成建单**，交给模型/澄清；只有与强建单词同行才落建单。
 *     注意：「帮我」**不是**软研究词（只是礼貌前缀）——「帮我看看进展」仍是纯查询。
 *   - 否定修饰：`先别/不要/不用/暂不/先不/无需/不必/别` 落在同一子句时，该子句的动词不算数。
 *   - 强查询与软研究并存 ⇒ `ambiguous`（问一句），不再默认建单。
 *
 * ⚠ 本模块**不 import 任何模块**：避免 `im-commands ↔ im-intent` 形成环。
 */

export type ImTextKind = 'create' | 'query' | 'ambiguous' | 'none';

// ====== zx_20261110_1 B2: 模型输出的**单 token**意图（严格相等，禁止子串命中）======

/** 模型只允许输出的四个词；「ambiguous」是规则/兜底的事，不交给模型。 */
export type ImIntentToken = 'start_task' | 'query_status' | 'create_task' | 'general_chat';

const INTENT_TOKENS = new Set<string>(['start_task', 'query_status', 'create_task', 'general_chat']);

/**
 * 模型回包正文 → 意图 token；不是**恰好一个**合法词 ⇒ `null`（调用方按"没有结论"处理）。
 *
 * 病根：此前用 `intent.includes('create_task')` 逐个子串试——模型回一句
 *   `I think create_task, but maybe query_status` 也会被判成建单，且**多给的那个词决定了副作用**。
 * 现在只容忍"外层包装"：大小写、首尾空白、引号/反引号/句末标点。正文多一个字就不认。
 *   ⚠ `includes` 只用于**集合成员判定**（Set.has），不是对模型输出的子串扫描。
 */
export function parseIntentToken(raw: string): ImIntentToken | null {
  const t = (raw || '')
    .trim()
    .toLowerCase()
    .replace(/^[`'"“”‘’\s]+/, '')
    .replace(/[`'"“”‘’。.!！?？\s]+$/, '');
  return INTENT_TOKENS.has(t) ? (t as ImIntentToken) : null;
}

export interface ImTextClassification {
  kind: ImTextKind;
  /** 人话证据（落 `route_reason`/回归详情，禁止失败字形）。 */
  evidence: string[];
  // zx_20261112_2 B2：**删掉数值置信**——它全仓零消费（只有 rr 读），路由另有一套 high/medium/low。
  //   同一件事两把尺；现在只留 `decideImIntent` 的那把（值从 0.95/0.9/0.5/0.2 变成一句话）。
  /** 句中存在否定修饰（无论最终判成什么）。 */
  negated: boolean;
}

/** 强建单：明确要创建一个任务。 */
export const STRONG_CREATE_RE = /(创建|新建|做一个|帮我做|建一个|建个|build|create|make)/i;
/** 软研究：想得到结果，但不必新建任务；单独出现不建单。「帮我」是礼貌前缀，不作研究词。 */
export const SOFT_RESEARCH_RE = /(分析|搜索|查一下|调查|生成|写)/i;
/** 查询信号：问状态/要信息。 */
export const QUERY_SIGNAL_RE = /(查看|查询|看看|查查|进展|状态|情况|告诉|status|progress|list|show|get)/i;
/**
 * 否定修饰。`别` 用负向后顾排除「特别/区别/分别/级别/性别/类别/告别」等构词，
 * 只认单独作否定用的「别」。
 */
export const NEGATION_RE = /(?:先别|不要|不用|暂不|先不|无需|不必|(?<![特区分级性类告])别)/;

function splitClauses(text: string): string[] {
  return text
    .split(/[，,。.!！?？;；\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 给一条文本出词法分类。**只看字面，不碰上下文**；上下文（群聊 @、@项目、LLM 补漏）在 `im-intent.ts`。
 */
export function classifyImText(text: string): ImTextClassification {
  const t = (text || '').trim();
  if (!t) return { kind: 'none', evidence: [], negated: false };

  const clauses = splitClauses(t);
  const negatedClauses = clauses.filter((c) => NEGATION_RE.test(c));
  const liveClauses = clauses.filter((c) => !NEGATION_RE.test(c));
  const live = liveClauses.join(' ');
  const negated = negatedClauses.length > 0;

  const strong = STRONG_CREATE_RE.test(live);
  const soft = SOFT_RESEARCH_RE.test(live);
  // 只在**非否定子句**里认查询信号：「先别查看状态」是叫人别查，不是查询。
  const query = QUERY_SIGNAL_RE.test(live);

  const evidence: string[] = [];
  if (strong) evidence.push('强建单词');
  if (soft) evidence.push('软研究词');
  if (query) evidence.push('查询信号');
  if (negated) {
    const what = [STRONG_CREATE_RE.test(negatedClauses.join(' ')) ? '建单' : '', SOFT_RESEARCH_RE.test(negatedClauses.join(' ')) ? '研究' : '']
      .filter(Boolean)
      .join('/');
    evidence.push(`否定修饰${what ? `(${what})` : ''}`);
  }

  // 强建单优先：即使同时带查询词，用户也是在要一个新任务。
  if (strong) return { kind: 'create', evidence, negated };
  // 软研究：单独出现不授权建单；与查询并存更该先问一句。
  if (soft) {
    if (query) evidence.push('软研究与查询并存→待澄清');
    else evidence.push('软研究单独出现→待澄清');
    return { kind: 'ambiguous', evidence, negated };
  }
  if (query) return { kind: 'query', evidence, negated };
  return { kind: 'none', evidence, negated };
}
