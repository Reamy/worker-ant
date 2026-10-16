/**
 * zx_20260924_1 M1（柏拉图·各司其职 / 维特根斯坦·意义即使用）:
 * **一条内置 IM 指令 = 名字 + 示例文案 + 匹配谓词**，三者**同一处**。
 *
 * 病根（方案 §1.1 F1）：帮助文案（`im-router.ts` 的 `handleHelp`）是**手写**的一串「示例」，
 * 而真正决定消息走哪条路的是另一个文件里的四个正则 + `handleRememberPreference` 的偏好正则 +
 * `core/im/options.ts` 的审批词——**两份手抄，必然漂移**。实测到的漂移：帮助写「记住：…」，
 * 而偏好谓词六条里**一条都不认**它 ⇒ 用户照帮助输入「记住：每周五出周报」，
 * 落进的是**建任务路**（得到的是「已创建任务」）。这是本仓「说明书与机器各说各话」族的样本之一。
 *
 * 治法：文案与谓词同源——`BUILTIN_IM_COMMANDS` 是帮助那一栏的**唯一产出点**，
 * 也是**路由器谓词的唯一来源**（`im-router.ts` 从这里 import，不再自留一份正则）。
 * 受控回归（`scripts/rr_zx_20260924_1_b1.ts`）把**示例原文**喂真路由器，逐条验证"照帮助做真能成"。
 *
 * ── 为什么下面这三样**刻意不在表内**（混进来会改变语义）──
 *  1. `COMMAND_LIKE_REGEX`（仍在 `im-router.ts`）：它**不是一条指令**，是"这条消息**像**指令"
 *     的**过滤器**（命中它会被挡在 `handleAgentReply` 之外）。一张"用户可用的指令表"里
 *     列一个"被排除项"，名实不符。
 *  2. **纯编号选择**（`handleNumberSelection`，步骤-2）：它是**上下文相关**的应答——同一个「2」
 *     在"项目候选暂存"下选项目、在"审批选项"下选选项、其余情况下选暂停任务列表的第 2 个。
 *     它没有固定的"示例文案"可以写进帮助（写「回复编号」也说不清是哪个列表的编号）。
 *  3. `im_commands` 表驱动的**项目自配关键词**：真源在`wa_projects.context_json.im_commands`，
 *     由 `handleHelp` 的**第二段**（按项目分组）现场投影。它是**每个项目各自的资产**、
 *     随项目增删而变，收进内置表等于把动态数据抄进常量表。
 *
 * ⚠ 本模块**零 electron 依赖**（只 import `core/im/options.ts`），故受控回归可直跑真实现。
 */
import { matchApprovalReply } from '../core/im/options.js';
// zx_20261016_1 批三: 配对审批的**谓词真源**在 `external-terminals.ts`（`parsePairReply`），此处不另抄一份正则。
import { parsePairReply } from '../core/external-terminals.js';

// ====== 四个内置动词的谓词（**自 `im-router.ts` 逐字迁入**，语义一字未改）======

/** 启动/恢复类动词的**整句开头**（裸「开始」也算——它走"列编号"分支）。 */
export const START_REGEX = /^(开始|启动|执行|运行|run|start|resume)/i;
/** 查询类**子串**（不限于整句开头：`QUERY_REGEX` 与 `CREATE_REGEX` 的先后决定它是否是纯查询）。 */
export const QUERY_REGEX = /(查看|查询|进展|状态|情况|告诉|status|progress|list|show|get|帮助|help)/i;
/** 「帮助」的**认领式**：整句匹配，不吃带"帮助"的自由文本（zx_20260911_4 M3-1，零新增命令词）。 */
export const HELP_REGEX = /^(帮助|help)[!！。.?？\s]*$/i;
/** 建任务类**子串**。 */
export const CREATE_REGEX = /(创建|新建|做一个|帮我|build|create|make|写|生成|分析|搜索|查一下|帮我做|调查)/i;

// ====== 偏好类谓词（**唯一一份**；`handleRememberPreference` 与本表共用）======

/**
 * 偏好内容的**最短长度**守卫：`记住：ab` 这种两字残句不落库（不是偏好，是手滑）。
 * 与既有六条保持一致——不是新加的尺度。
 */
export const PREFERENCE_MIN_CHARS = 3;

/**
 * 偏好类谓词表（顺序即判定顺序：**首个命中者胜**）。
 *
 * zx_20260924_1 M1 / 用户裁定 J-5：**补上 `^记住[：:]\s*(.+)`**。依据是"用户实际会说的话"
 * （维特根斯坦·意义即使用）：帮助里写的例子就是这个形状，而它此前**一条都不匹配**。
 * 取 (a) 补谓词、**不改帮助文案**——改文案只是把病藏起来（`记住：X` 仍会落成建任务）。
 *
 * ⚠ 新谓词**追加在末位**：既有输入的首个命中者不变（行为对既有用例逐字兼容）。
 */
export const PREFERENCE_PATTERNS: readonly RegExp[] = [
  /记住我偏好[：:]\s*(.+)/i,
  /记住.*偏好[：:]\s*(.+)/i,
  /我的偏好[是：:]\s*(.+)/i,
  /我的习惯[是：:]\s*(.+)/i,
  /我习惯\s*(.+)/i,
  /我喜欢\s*(.+)/i,
  /^记住[：:]\s*(.+)/, // ← M1 就地订正（J-5）
];

/**
 * 偏好类消息 → 该记住的**内容**（已 trim）；不是偏好（或内容过短）→ `null`。
 *
 * 这是"路由器认不认这条偏好"的**唯一实现**：`handleRememberPreference` 调它落库，
 * 本表 `BUILTIN_IM_COMMANDS` 的「记住偏好」行也调它——**同一份谓词**，结构上不可能再漂。
 *
 * ⚠ 返回值**未截断**（`handleRememberPreference` 落库前再 `slice(0, 200)`）——
 *   截断是**落库侧**的容量约定，不是"算不算偏好"的判据，两者混在一处会让本函数名实不符。
 */
export function matchRememberPreference(msgText: string): string | null {
  for (const pattern of PREFERENCE_PATTERNS) {
    const m = msgText.match(pattern);
    if (m && m[1]) {
      const content = m[1].trim();
      return content.length >= PREFERENCE_MIN_CHARS ? content : null;
    }
  }
  return null;
}

// ====== 内置指令表（帮助那一栏的**唯一产出点**）======

export interface BuiltinImCommand {
  /** 帮助里的显示名（第一列）。 */
  name: string;
  /** 帮助里的示例文案（第二列）——用户照它输入就该能用。 */
  example: string;
  /**
   * 受控回归用的**具体**输入。示例里带 `…` 占位时（「记住：…」）只能是这一条；
   * 其余各条**恰等于**示例中第一个「…」里的原文（回归会逐条核对这个相等性 ⇒ 文案与受测输入同源）。
   */
  probe: string;
  /**
   * 判定谓词 = **路由器真正用的那一份**（不是另抄一份正则）。
   * ⚠ 谓词可能**宽于**示例（如「系统状态」的 `QUERY_REGEX` 也认"进展"）——那是路由器的真实语义，
   *   帮助承诺的是"照示例输入能用"，不是"只有示例能用"。
   * ⚠ 审批回复的 `match` 是**词**级判据（`options.ts` 的 `matchApprovalReply` 空选项集）；
   *   它**生效**还取决于"本渠道本用户确有悬置的待审批项"（队列路 / DB 回退路）——
   *   帮助文案说的就是这个前提下的可用输入。无待审批项时，一句「是」会落到问候/兜底。
   */
  match: (text: string) => boolean;
}

/**
 * 内置指令表（**顺序即帮助里的展示顺序**）。
 *
 * ⚠ 改这里的 `example` 就是改用户看到的帮助文案——**一处改，两处生效**（这正是本模块存在的理由）。
 */
export const BUILTIN_IM_COMMANDS: readonly BuiltinImCommand[] = [
  {
    name: '创建任务',
    example: '「创建任务+标题」',
    probe: '创建任务+标题',
    match: (s) => CREATE_REGEX.test(s),
  },
  {
    name: '启动任务',
    example: '「开始+任务名」；或先「开始」再回复编号',
    probe: '开始+任务名',
    match: (s) => START_REGEX.test(s),
  },
  {
    name: '系统状态',
    example: '「查看系统状态」',
    probe: '查看系统状态',
    match: (s) => QUERY_REGEX.test(s),
  },
  {
    name: '审批回复',
    example: '回「是」/「否」，或选项编号/文本',
    probe: '是',
    // 审批词的真源在 `core/im/options.ts`，**此处不另写一份**确认/拒绝词表。
    match: (s) => matchApprovalReply([], s) !== null,
  },
  {
    name: '记住偏好',
    example: '「记住：…」',
    probe: '记住：每周五出周报',
    match: (s) => matchRememberPreference(s) !== null,
  },
  {
    // zx_20261016_1 批三: 外部终端申请接入时，用户可在 IM 里**直接审批**（不必回电脑前面板）。
    //   ⚠ 生效前提：**本机确有待批的接入申请**（名字不带核对码、待批多条时列候选）。
    name: '接入审批',
    example: '「同意接入 …」；或「拒绝接入 …」（…＝核对码）',
    probe: '同意接入 123456',
    match: (s) => parsePairReply(s) !== null,
  },
];
