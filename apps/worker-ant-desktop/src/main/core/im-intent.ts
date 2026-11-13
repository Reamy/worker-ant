/**
 * zx_20261108_1 B3（维特根斯坦·意义即使用 / 管子·度量衡）: **IM 消息理解**的纯函数——
 * 一条消息"为什么被当成任务/查询/闲聊"在这里定，路由只执行、库与界面只核对。
 *
 * 病根：此前建单判据里有一条 `msgText.length > 4`——**字数**被当成"想干活"的证据，
 *   于是「今天天气不错」「客厅有点热」这类随口一说都会变成任务；用户事后只能看到"已创建任务"，
 *   却无从知道是哪条规则把它推下去的。群聊里没 @ 机器人时，命令也会被照单全收。
 *
 * 三条硬边界：
 *   1. **规则优先、LLM 只补漏**：显式帮助/查询/启动/建单/@项目 都在本地判定；只有规则全不命中，
 *      才允许把 LLM 的结果喂回本函数（`llmIntent`）——LLM 不能推翻显式规则。
 *   2. **不再以字数建单**：长度只作为"值不值得问模型"的成本闸，留在路由层且不参与意图判定。
 *   3. **群聊 fail-closed**：`chatType === 'group'` 且平台未证实"@ 了我"（`mentionsBot !== true`）时，
 *      只受理查询/帮助/问候；命令与建单一律回「群里请 @我 再下指令」，其余静默。
 *
 * ⚠ 纯函数、零 IO、零时钟：受控回归直引跑真实现。
 */
import { HELP_REGEX, QUERY_REGEX, START_REGEX } from '../services/im-commands.js';
// zx_20261110_1 B1（维特根斯坦·意义即用法）: 词表与判定收进纯规则模块——强建单/软研究/查询/否定四族词一处，
//   LLM 不再被「分析/搜索/写」这类软研究词骗成建单。`im-commands.ts` 与本模块共用同一份，不再各留一套正则。
import { classifyImText, type ImIntentToken } from './im-intent-rules.js';

export type ImIntent = ImIntentToken | 'ambiguous';

/**
 * 路由去向。前九个是 `decideImIntent` 的产出；其余供路由记录"上下文分支已认领"，
 * 不为它们的语义在本模块另立一份判定（偏好/编号/审批等仍各走原路）。
 */
export type ImRoute =
  | 'help' | 'query' | 'start' | 'create' | 'greeting' | 'llm' | 'ambiguous'
  | 'group_gate' | 'group_silent'
  | 'preference' | 'selection' | 'terminal_pair' | 'approval' | 'agent_reply' | 'command'
  // zx_20261110_1 B2: 中置信模型判定先请用户确认（问题与答复两行都记这条路）。
  | 'confirmation';

export type ImConfidence = 'low' | 'medium' | 'high';

export interface ImIntentInput {
  text: string;
  chatType?: string;
  /** 平台**证实**本条 @ 了机器人；`undefined` = 平台未提供该信息（按未 @ 处理）。 */
  mentionsBot?: boolean;
  /** 消息里仍有 `@项目名`（机器人 mention 已剥离）。 */
  hasProjectMention?: boolean;
  /** 规则全不命中时由 LLM 给出的候选；显式规则命中时**不采纳**。 */
  llmIntent?: ImIntent | null;
}

export interface ImIntentDecision {
  intent: ImIntent;
  route: ImRoute;
  reason: string;
  confidence: ImConfidence;
}

/** 群聊未 @ 机器人时的统一拒绝话术（路由与回归共用一处）。 */
export const GROUP_REFUSAL_TEXT = '群里请 @我 再下指令。';

/** 规则未命中、也没有可靠的 LLM 结论时，**不建任务**，反问一句并给两个例子。 */
export const AMBIGUOUS_TEXT =
  '你是想建任务、查进度，还是只是聊聊？例如「创建任务+标题」或「查看系统状态」。如需帮助，输入「帮助」。';

/** 模型判为闲聊时的回话——**不建任务**，并保留"怎么继续"的出口。 */
export const GENERAL_CHAT_TEXT =
  '收到。我是工蚁 AI 助手，可以帮你建任务或查进度；如需帮助，输入「帮助」查看可用指令。';

/** 系统状态类显式查询（保留旧路由的专用模式，与 QUERY_REGEX 同层使用）。 */
export const SYSTEM_QUERY_PATTERNS: readonly RegExp[] = [
  /系统情况/, /系统状态/, /工蚁.*情况/, /工蚁.*状态/, /整体.*情况/, /运行.*状态/, /how.*system/i,
];

/**
 * 问候/致谢（整句白名单）。
 *
 * zx_20261112_2 B2：**删掉**旧的 `^[一-龥]{1,3}$`——它把「查一下」「没搞定」「删了吧」
 *   这类 1–3 字的正常指令一律判成问候并吞掉（还记成 high 置信）。问候只能是**明确的客套话**，
 *   不在白名单里的短句一律往下走查询/澄清，宁可多问一句，不替用户把指令吃掉。
 */
export const GREETING_PATTERNS: readonly RegExp[] = [
  /^(你好|您好|在吗|在不在|哈喽|嗨|谢谢|多谢|收到|好的|好|嗯|哦|早|早安|晚安|辛苦了|hi|hello|thanks|ok)[!！。.？?\s]*$/i,
];

/**
 * 显式查询：系统状态专用模式，或 `classifyImText` 判为查询（强查询、无软件研究词）。
 * 软研究（分析/搜索/写…）与查询并存时 `classifyImText` 给 `ambiguous` ⇒ 这里**不抢答**，
 *   交给下游 LLM/澄清——这是「先别创建任务，看看进展」不再建单的落点。
 */
export function isExplicitQuery(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (SYSTEM_QUERY_PATTERNS.some((p) => p.test(t))) return true;
  const cls = classifyImText(t);
  if (cls.kind === 'query') return true;
  if (cls.kind === 'create' || cls.kind === 'ambiguous') return false;
  return QUERY_REGEX.test(t);
}

export function isGreeting(text: string): boolean {
  return GREETING_PATTERNS.some((p) => p.test(text.trim()));
}

/**
 * zx_20261110_1 B2: `route_reason` 的**来源标注**——审计要能分清"规则认的"与"模型补的"。
 * 确认分支不走判定层（那是路由的上下文认领），其来源由路由在 `route_reason` 里自述。
 */
export function decisionSourceLabel(decision: ImIntentDecision): '规则' | '模型' {
  // `confirmation` 是"模型判了中置信、路由改记成待确认"——来源仍是模型，不是规则。
  return decision.route === 'llm' || decision.route === 'confirmation' ? '模型' : '规则';
}

/** 把来源接在理由末尾（不改既有措辞，旧断言里的关键词仍在）。 */
export function withDecisionSource(decision: ImIntentDecision): string {
  return `${decision.reason}（来源：${decisionSourceLabel(decision)}）`;
}

/**
 * 剥离机器人 mention——**只剥平台标记与开头那一个 @ 称呼**，项目 `@项目名` 原样留给建单路。
 *
 * - 飞书正文里的 `@_user_1`、QQ/其他平台的 `<@!id>` 是**平台占位符**，出现在哪里都剥；
 * - 只有平台**证实**本条 @ 了机器人（`mentionsBot === true`）才剥开头的 `@名字`，
 *   否则不动（不知道哪个是机器人，宁可让建单路按原样解析，也不误吃用户的 @项目名）。
 */
export function stripBotMention(text: string, mentionsBot?: boolean): string {
  let out = text.replace(/@_user_\d+/g, ' ').replace(/<@!?[A-Za-z0-9_-]+>/g, ' ');
  if (mentionsBot) out = out.replace(/^[\s:：,，]*@[^\s@，。,\.！!？?：:；;、]+/, ' ');
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

function llmDecision(llmIntent: ImIntent): ImIntentDecision {
  switch (llmIntent) {
    case 'start_task':
      return { intent: 'start_task', route: 'llm', reason: '规则未命中，模型判为启动——按启动处理', confidence: 'medium' };
    case 'query_status':
      return { intent: 'query_status', route: 'llm', reason: '规则未命中，模型判为查询——按查询处理', confidence: 'medium' };
    case 'create_task':
      return { intent: 'create_task', route: 'llm', reason: '规则未命中，模型判为建单——按建单处理', confidence: 'medium' };
    case 'general_chat':
      return { intent: 'general_chat', route: 'llm', reason: '规则未命中，模型判为闲聊——回一句，不建任务', confidence: 'medium' };
    default:
      return { intent: 'ambiguous', route: 'ambiguous', reason: '规则未命中，模型也未给出可用结论', confidence: 'low' };
  }
}

/**
 * 给一条 IM 文本出**意图判定**。规则次序按方案：帮助 → 查询 → 启动 → 建单/@项目 → 问候 → LLM → 待澄清；
 * 群聊未 @ 机器人的判定**覆盖**启动/建单（拒绝），但不影响查询/帮助/问候。
 */
export function decideImIntent(input: ImIntentInput): ImIntentDecision {
  const text = stripBotMention(input.text, input.mentionsBot);
  const inGroupNoMention = input.chatType === 'group' && input.mentionsBot !== true;

  if (!text) {
    return { intent: 'ambiguous', route: 'group_silent', reason: '消息只有 @ 机器人、没有正文——不当作指令', confidence: 'low' };
  }

  // 1 显式帮助：群聊也受理（它不是指令，是"怎么用"）。
  if (HELP_REGEX.test(text)) {
    return { intent: 'general_chat', route: 'help', reason: '显式「帮助」——回能力清单，不建任务', confidence: 'high' };
  }

  // 2 显式查询：群聊未 @ 也照答（查询不改世界）。
  if (isExplicitQuery(text)) {
    return {
      intent: 'query_status',
      route: 'query',
      reason: inGroupNoMention ? '群聊未 @ 我，但这是查询——照答' : '含查询信号且无强建单动词——按查询处理',
      confidence: 'high',
    };
  }

  // 3 显式启动：群聊未 @ ⇒ 拒绝。
  if (START_REGEX.test(text)) {
    return inGroupNoMention
      ? { intent: 'start_task', route: 'group_gate', reason: '群聊未 @ 我，启动指令不受理', confidence: 'high' }
      : { intent: 'start_task', route: 'start', reason: '以启动词开头——按启动/恢复处理', confidence: 'high' };
  }

  // 4 显式建单 / @项目：群聊未 @ ⇒ 拒绝。软研究词（分析/搜索/写…）单独出现**不授权建单**。
  const cls = classifyImText(text);
  const isCreate = cls.kind === 'create' || input.hasProjectMention === true;
  if (isCreate) {
    return inGroupNoMention
      ? { intent: 'create_task', route: 'group_gate', reason: '群聊未 @ 我，建单指令不受理', confidence: 'high' }
      : {
          intent: 'create_task',
          route: 'create',
          reason: input.hasProjectMention === true
            ? '带 @项目名——按建单处理'
            : `含建单动词——按建单处理（${cls.evidence.join('/')}）`,
          confidence: 'high',
        };
  }

  // 5 问候/致谢：闲聊，不建任务（群聊也回，属于"闲聊"允许面）。
  if (isGreeting(text)) {
    return { intent: 'general_chat', route: 'greeting', reason: '问候/致谢——回一句，不建任务', confidence: 'high' };
  }

  // 6 群聊未 @：不猜、不建单（fail-closed，也不烧模型）。
  if (inGroupNoMention) {
    return { intent: 'ambiguous', route: 'group_silent', reason: '群聊未 @ 我，且不是查询/问候——静默不处理', confidence: 'low' };
  }

  // 7 LLM 只补"规则全不命中"。
  if (input.llmIntent && input.llmIntent !== 'ambiguous') return llmDecision(input.llmIntent);

  return {
    intent: 'ambiguous',
    route: 'ambiguous',
    reason: '规则未命中、也没有可靠的模型结论——不建任务，请用户说明想做什么',
    confidence: 'low',
  };
}
