/**
 * zx_20260924 M7（维特根斯坦·语言游戏 / 道德经「名可名，非常名」）: 附件**去向**这一件事的唯一词表。
 *
 * 病根：`buildAttachmentParts` 算出的 `outcomes` 在 `agent-executor.ts` 里**只被拼成会话文本**，
 *   渲染层全仓 grep `attachments` 零命中——用户不知道这次任务带了什么件、每件去了哪里。
 *   M7 把它结构化落 `context_json.attachments_outcomes` 并上屏；上屏就要有中文词，
 *   而 **renderer 是词表的第二个落点**（G8/G9 的老病）：若在页面里再写一份 `inlined→内联`，
 *   改一处忘另一处是结构性的必然。
 *
 * ⚠ **本模块零依赖**（不引 electron / better-sqlite3 / node:*，同 `attachment-kinds`/`settings-bool` 范式）：
 *   主进程落库与渲染层上屏跨 root 引**同一份**取值与文案。
 *   `attachment-inline.ts` 引了 `node:fs`/`ai`，renderer 引不动，故三态字面量与文案在本模块成文，
 *   那边与这边都从这**一处**取（那边只引类型，编译期擦除，不把依赖带进 renderer）。
 */

/** 一件附件的去向后**只有这三种**（与 `AttachmentOutcome.status` 是同一个字面量集合）。 */
export type AttachmentOutcomeStatus = 'inlined' | 'omitted' | 'failed';

/** 全量取值。加一态时，下面的文案表与消费点会同时报类型错——这就是它在这里的理由。 */
export const ATTACHMENT_OUTCOME_STATUSES: readonly AttachmentOutcomeStatus[] = ['inlined', 'omitted', 'failed'];

/**
 * 三态的用户可见文案。**不许在 renderer 再写第二份**。
 *
 * `omitted` 的中文刻意用「未内联」而不是「已省略」：前者说的是"没进上下文"这个事实，
 * 后者容易被读成"系统主动丢了它"。同一件事实的两种读法，用户据此决定要不要自己去看原件。
 */
export const ATTACHMENT_STATUS_LABEL: Readonly<Record<AttachmentOutcomeStatus, string>> = {
  inlined: '内联',
  omitted: '未内联',
  failed: '失败',
};

/**
 * 落库与上屏的**同一形状**：`context_json.attachments_outcomes` 里的一条。
 *
 * 字段名是**跨进程契约**（main 写 / renderer 读），定了就不再改；改则两侧同改。
 * `marker` **刻意不落**——那句给模型看的话已在会话文本里（`persistTurnMessage`），
 * 再存一份就是同一措辞的第二个真源。
 */
export interface AttachmentOutcomeView {
  /** 件名（盘上 basename 或平台给的名字）。 */
  fileName: string;
  /** 族（`image`/`audio`/`video`/`document`/`binary`）。**原样展示**——中文译名在 main 侧不存在，
   *  在这里造一个就是新词表（承 G8/G9：不许在这一侧另起一份）。 */
  family: string;
  status: AttachmentOutcomeStatus;
  /**
   * 为什么是这个去向。**原样展示，不翻译、不归一**——
   * 它是各支路当场给出的真因（`over_limit`、`cid_unsupported：可读字符占比 1.7% < 60%`），
   * 任何"把它归成几个大类"的加工都会把用户需要的细节磨掉，且必然成为第二份词表。
   */
  reason?: string;
  /** 盘上路径：`omitted`/`failed` 时用户仍可自行取件——这是"没进去"之外最有用的一条信息。 */
  path: string;
  bytes?: number;
}

/** 落库侧的入参形状（只声明要用的那几个字段，免得本模块反向依赖 `attachment-inline.ts` 而成环）。 */
export interface OutcomeLike {
  path: string;
  fileName?: string;
  family: string;
  status: AttachmentOutcomeStatus;
  reason?: string;
  bytes?: number;
}

/** 装配结果 → 落库视图（纯函数）。件名回退到盘上 basename，保证上屏**不会出现空名一行**。 */
export function toAttachmentOutcomeViews(outcomes: ReadonlyArray<OutcomeLike>): AttachmentOutcomeView[] {
  return outcomes.map((o) => ({
    fileName: o.fileName || o.path.slice(o.path.lastIndexOf('/') + 1) || o.path,
    family: o.family,
    status: o.status,
    ...(o.reason ? { reason: o.reason } : {}),
    path: o.path,
    ...(typeof o.bytes === 'number' ? { bytes: o.bytes } : {}),
  }));
}

/**
 * 读侧的**收敛**：把 `context_json` 里的原始值（`unknown`）变成视图数组。
 *
 * 为什么不在 renderer 里直接 `as AttachmentOutcomeView[]`：库里躺着的是**历史各轮写下的 JSON**，
 * 形状归 main 管而内容可能缺字段。这里逐条校验、丢弃不成形的行——**老任务没有此键 ⇒ 空数组**，
 * 页面据此"不显示该块"，而不是显示"0 个附件"（那是个编造出来的事实）。
 */
export function parseAttachmentOutcomeViews(raw: unknown): AttachmentOutcomeView[] {
  if (!Array.isArray(raw)) return [];
  const out: AttachmentOutcomeView[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const v = r as Record<string, unknown>;
    const status = v.status as AttachmentOutcomeStatus;
    if (typeof v.path !== 'string' || !ATTACHMENT_OUTCOME_STATUSES.includes(status)) continue;
    out.push({
      fileName: typeof v.fileName === 'string' && v.fileName ? v.fileName : v.path,
      family: typeof v.family === 'string' ? v.family : '',
      status,
      ...(typeof v.reason === 'string' && v.reason ? { reason: v.reason } : {}),
      path: v.path,
      ...(typeof v.bytes === 'number' ? { bytes: v.bytes } : {}),
    });
  }
  return out;
}
