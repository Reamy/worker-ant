/**
 * zx_20260914 M1-4(维特根斯坦·意义即使用 / 海德格尔·上手): 会话项「看得懂」的**唯一判定处**。
 *
 * 病根: 会话项此前一律 `JSON.parse(message_json).text || message_json.slice(0,200)`——
 *   非文本消息（M1-2 之后如实到场，正文是 `[图片]` / `[文件 report.pdf 1.2MB]`）与"库里的坏数据"
 *   共用同一条兜底：界面上既分不出类型、也不知道该不该挂徽标。
 *
 * 口径一条（本函数最容易走偏的地方）: **本函数不另立类型词表**。人读标签由 main 的
 *   `nonTextPlaceholder` **一处**产出（词表在 `src/main/services/im-adapter.ts`），此处只从
 *   **已渲染的占位符**里把方括号前缀**读回**当作徽标。在 renderer 再抄一份 12 条映射
 *   = 词表的第二个落点，两处必然分叉（记忆在案：renderer 不在 src/main 的扫描面内，最易漏改）。
 *
 * 纯函数、零依赖 —— 受控复跑可直接 import 跑**真实现**（承既有手法「抽纯函数让 rr 跑真实现」）。
 */

export interface MessageView {
  /** 消息类型：`'text'` = 自由文本；其余为**平台原始类型**（main 侧原样带出，此处不翻译）。 */
  kind: string;
  /** 非文本的**类型徽标**文案（从 main 产出的占位符读回，如「图片」「文件」）；自由文本为空串。 */
  label: string;
  /** 该显示的正文：文本=原话；非文本=main 产出的占位符；解析不了=库中原文（截断，不裸抛 JSON）。 */
  text: string;
}

/** 占位符形如 `[图片]` / `[文件 report.pdf 1.2MB]` / `[其他消息(42)]`。
 *  取方括号内**第一个空白前**的一段作徽标（文件名/大小不混进徽标）。读不回（格式变了）则空串——
 *  宁可少一个徽标，也不显示一个可能已经过期的名。 */
const LABEL_RE = /^\[([^\]\s]+)/;

/** 兜底截断长度——与旧实现同值（`message_json?.slice(0,200)`），不借本轮改口径。 */
const RAW_FALLBACK = 200;

export function messageViewOf(messageJson: unknown): MessageView {
  const raw = typeof messageJson === 'string' ? messageJson : (messageJson == null ? '' : String(messageJson));
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
  } catch { /* 非 JSON ⇒ 按原文如实显示，不假装它是结构化消息 */ }
  if (!obj) return { kind: 'text', label: '', text: raw.slice(0, RAW_FALLBACK) };

  const kind = typeof obj.kind === 'string' && obj.kind ? obj.kind : 'text';
  // 自由文本：仍走旧口径的末位兜底（`text` 缺失/为空 ⇒ 显示库中原文），保证**没有空白行**；
  //   非文本必带 main 产出的占位符正文，无兜底可言。
  const text = typeof obj.text === 'string' && obj.text
    ? obj.text
    : (kind === 'text' ? raw.slice(0, RAW_FALLBACK) : '');
  if (kind === 'text') return { kind, label: '', text };
  const m = LABEL_RE.exec(text);
  return { kind, label: m ? m[1]! : '', text };
}
