/**
 * zx_20261101_1 M1「授」（道德经·善闭无关楗而不可开 / 维特根斯坦·意义即使用）:
 * **IM 授权台的纯逻辑**——命令解析、短码解析、待办组装与文案，全部只读/纯函数。
 *
 * 为什么单独成模块：
 *   ① 命令词表与解析**只此一份**——路由、帮助文案、受控回归同引它，不再各抄一遍正则；
 *   ② 零 electron 依赖（只引设备台账与派发台账的读模型），rr 可直跑真实现；
 *   ③ 与「终端配对审批」同一位阶但**真源不同**：配对读 `wa_external_terminals`（持久行），
 *      本台读 `wa_devices`（设备授权）与 `wa_event_log` 的 `node_dispatch`（跨机问答）。
 *
 * ⚠ **不认得的句子不冒充命令**（返回 `null`）：不能把用户闲聊吞成"操作失败"。
 * ⚠ **短码歧义即列候选、不猜**（同 `resolveDeviceByName` 的纪律）。
 * ⚠ 高危设备（门锁/安防）**永不入台**：既不出现在待办清单，也不接受 IM 授权。
 */

import type { AnsDevice } from '../device-registry.js';
import { isHighRiskKind, listDevices, resolveDeviceByName } from '../device-registry.js';
import type { NodeDispatchRecord } from '../node-dispatch-log.js';
import { listNodeDispatchRecords } from '../node-dispatch-log.js';
// zx_20261104_3 M3「联」: 待接入终端并入授权台——桌面 /inbox 与 IM「授权待办」读**同一份**三本账。
import type { PendingTerminalPublic } from '../external-terminals.js';
import { listPendingTerminals } from '../external-terminals.js';

/** 读库的最小接口（与 `DeviceDb` / `DispatchLogDb` 结构兼容）。 */
export interface ApprovalInboxDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): unknown;
  };
}

/** 待办一次最多列几条（Miller 7±2：再多就该让用户用筛选命令）。 */
export const MAX_INBOX_ITEMS = 7;

/** 短码：UUID 前 8 位，够短、可粘贴；歧义时列候选而不是截得更短。 */
export function shortCode(id: string): string {
  return String(id ?? '').slice(0, 8);
}

export type ApprovalCommand =
  | { kind: 'allow_device'; code: string }
  | { kind: 'deny_device'; code: string }
  | { kind: 'answer'; code: string; answer: string }
  | { kind: 'list_devices' }
  | { kind: 'list_questions' }
  | { kind: 'list_all' };

const ALLOW_DEVICE = /^允许设备(?:[:：\s]+)(\S+)$/;
const DENY_DEVICE = /^拒绝设备(?:[:：\s]+)(\S+)$/;
const ANSWER_QUESTION = /^回答(?:[:：\s]+)(\S+)\s+([\s\S]+)$/;
const LIST_DEVICES = /^(待授权设备|待授权|待批准设备)$/;
const LIST_QUESTIONS = /^(待答问题|待回答|待回答问题)$/;
const LIST_ALL = /^(授权待办|审批待办|授权待办事项)$/;
const ALLOW_BARE = /^允许设备[:：]?$/;
const DENY_BARE = /^拒绝设备[:：]?$/;

/** 归一输入：全角空格转半角，trim（含行尾换行），再去首部 @提及。trim 须**先于**剥 @。 */
function normalizeInput(text: string): string {
  return String(text ?? '')
    .replace(/　/g, ' ')
    .trim()
    .replace(/^[@＠]\S+[ \t]*/, '')
    .trim();
}

/** 短码/名称末尾的用户标点（「允许设备 3f2a。」）不属于码本身。 */
function stripTrailingPunctuation(code: string): string {
  return code.replace(/[，,。.！!？?；;：:]+$/g, '').trim();
}

/**
 * 把一条 IM 文本解析成授权台命令；**不是命令 ⇒ `null`**（交回原管线，不认领）。
 * 支持的形状（帮助文案与谓词同源，见 `im-commands.ts` 的登记）：
 *   `允许设备 <码>` / `拒绝设备 <码>` / `回答 <码> <答案>` /
 *   `待授权设备` / `待答问题` / `授权待办`；裸「允许设备」等同于查清单。
 */
export function parseApprovalCommand(text: string): ApprovalCommand | null {
  const s = normalizeInput(text);
  if (!s) return null;

  if (ALLOW_BARE.test(s)) return { kind: 'list_devices' };
  if (DENY_BARE.test(s)) return { kind: 'list_devices' };

  const allow = s.match(ALLOW_DEVICE);
  if (allow) {
    const code = stripTrailingPunctuation(allow[1]);
    return code ? { kind: 'allow_device', code } : null;
  }

  const deny = s.match(DENY_DEVICE);
  if (deny) {
    const code = stripTrailingPunctuation(deny[1]);
    return code ? { kind: 'deny_device', code } : null;
  }

  const answer = s.match(ANSWER_QUESTION);
  if (answer) {
    const code = stripTrailingPunctuation(answer[1]);
    const body = answer[2].trim();
    return code && body ? { kind: 'answer', code, answer: body } : null;
  }

  if (LIST_DEVICES.test(s)) return { kind: 'list_devices' };
  if (LIST_QUESTIONS.test(s)) return { kind: 'list_questions' };
  if (LIST_ALL.test(s)) return { kind: 'list_all' };
  return null;
}

export type DeviceResolution =
  | { kind: 'ok'; device: AnsDevice }
  | { kind: 'ambiguous'; candidates: AnsDevice[] }
  | { kind: 'not_found' };

/**
 * 按短码找设备：先按 id 前缀（≥4 位，避免一位字符命中一片），再按别名/自述名精确匹配。
 * 多台命中 ⇒ 列候选，**不替用户挑**。
 */
export function resolveDeviceByCode(db: ApprovalInboxDb, code: string): DeviceResolution {
  const c = stripTrailingPunctuation(code).toLowerCase();
  if (!c) return { kind: 'not_found' };

  const all = listDevices(db);
  if (c.length >= 4) {
    const hits = all.filter((d) => d.id.toLowerCase().startsWith(c));
    if (hits.length === 1) return { kind: 'ok', device: hits[0] };
    if (hits.length > 1) return { kind: 'ambiguous', candidates: hits };
  }

  const byName = resolveDeviceByName(db, code);
  if (byName.ok) return { kind: 'ok', device: byName.device };
  if (byName.reason === 'ambiguous') return { kind: 'ambiguous', candidates: byName.candidates };
  return { kind: 'not_found' };
}

export type QuestionResolution =
  | { kind: 'ok'; record: NodeDispatchRecord }
  | { kind: 'ambiguous'; candidates: NodeDispatchRecord[] }
  | { kind: 'not_found' };

/** 本机派出、且对端正等着回答的单（`pending` + `asked`）。 */
export function pendingQuestions(db: ApprovalInboxDb): NodeDispatchRecord[] {
  return listNodeDispatchRecords(db, 200).filter(
    (r) => r.status === 'pending' && r.questionStatus === 'asked' && r.question !== null,
  );
}

/** 按短单号找待答问题；多单命中 ⇒ 列候选。 */
export function resolveQuestionByCode(db: ApprovalInboxDb, code: string): QuestionResolution {
  const c = stripTrailingPunctuation(code).toLowerCase();
  if (c.length < 4) return { kind: 'not_found' };
  const hits = pendingQuestions(db).filter((r) => r.requestId.toLowerCase().startsWith(c));
  if (hits.length === 1) return { kind: 'ok', record: hits[0] };
  if (hits.length > 1) return { kind: 'ambiguous', candidates: hits };
  return { kind: 'not_found' };
}

/** 待授权设备：可控、未授权、非高危。发现只读设备不入台，高危设备永不放权。 */
export function pendingDevices(db: ApprovalInboxDb): AnsDevice[] {
  return listDevices(db).filter((d) => !d.authorized && d.controllable && !isHighRiskKind(d.kind));
}

export interface ApprovalInbox {
  terminals: PendingTerminalPublic[];
  devices: AnsDevice[];
  questions: NodeDispatchRecord[];
}

export function buildApprovalInbox(db: ApprovalInboxDb): ApprovalInbox {
  return {
    terminals: listPendingTerminals(db),
    devices: pendingDevices(db),
    questions: pendingQuestions(db),
  };
}

export function deviceDisplayName(dev: AnsDevice): string {
  return dev.alias || dev.name || shortCode(dev.id);
}

export function formatDeviceCandidate(dev: AnsDevice): string {
  const extra = [dev.room, dev.kind_class || dev.kind].filter((x) => x && x.trim() !== '').join(' / ');
  return `「${deviceDisplayName(dev)}」${extra ? `（${extra}）` : ''} 码 ${shortCode(dev.id)}`;
}

/** zx_20261104_3 M3：待接入终端的人话名（自述名优先，缺名才用 id 前 8 位——不编名字）。 */
export function terminalDisplayName(t: PendingTerminalPublic): string {
  return t.name?.trim() || shortCode(t.id);
}

/** 待接入终端一行：名字 / 来路 / **核对码**（终端那头也显示同一个 6 位码，两边对得上才批）。 */
export function formatTerminalCandidate(t: PendingTerminalPublic): string {
  // zx_20261106_3 B7：`discovery` 来路同样如实说（它是"按地址探测到"，不冒充局域网）。
  const sourceLabel = t.source === 'lan' ? '局域网发现' : t.source === 'discovery' ? 'A2A 地址发现' : '';
  const where = [t.last_remote_addr, sourceLabel].filter((x) => x && x.trim() !== '').join(' / ');
  return `「${terminalDisplayName(t)}」${where ? `（${where}）` : ''} 核对码 ${t.pair_code}`;
}

export function formatTerminalList(terminals: PendingTerminalPublic[], limit = MAX_INBOX_ITEMS): string {
  if (terminals.length === 0) return '待接入终端：无。';
  const lines = [`待接入终端（${terminals.length}）`];
  for (const t of terminals.slice(0, limit)) lines.push(`· ${formatTerminalCandidate(t)}`);
  if (terminals.length > limit) lines.push(`…还有 ${terminals.length - limit} 台，回复「授权待办」查看全部。`);
  return lines.join('\n');
}

export function formatQuestionCandidate(rec: NodeDispatchRecord): string {
  const q = rec.question?.question ?? '';
  const options = rec.question?.options?.length ? `（可选：${rec.question.options.join(' / ')}）` : '';
  const where = rec.targetNodeId ? ` · ${rec.targetNodeId}` : '';
  return `码 ${shortCode(rec.requestId)} · ${rec.category || '跨机任务'}${where}\n  ${q}${options}`;
}

export function formatDeviceList(devices: AnsDevice[], limit = MAX_INBOX_ITEMS): string {
  if (devices.length === 0) return '待授权设备：无。';
  const lines = [`待授权设备（${devices.length}）`];
  for (const d of devices.slice(0, limit)) lines.push(`· ${formatDeviceCandidate(d)}`);
  if (devices.length > limit) lines.push(`…还有 ${devices.length - limit} 台，回复「待授权设备」查看全部。`);
  return lines.join('\n');
}

export function formatQuestionList(records: NodeDispatchRecord[], limit = MAX_INBOX_ITEMS): string {
  if (records.length === 0) return '待答问题：无。';
  const lines = [`待答问题（${records.length}）`];
  for (const r of records.slice(0, limit)) lines.push(`· ${formatQuestionCandidate(r)}`);
  if (records.length > limit) lines.push(`…还有 ${records.length - limit} 条，回复「待答问题」查看全部。`);
  return lines.join('\n');
}

export function formatApprovalInbox(inbox: ApprovalInbox, limit = MAX_INBOX_ITEMS): string {
  // zx_20261104_3 M3：三段同列（终端 / 设备 / 问题）——**只有三类皆空**才说"没有待办"，
  //   不把"终端 0 件"说成"没有待办"（名实）。
  if (inbox.terminals.length === 0 && inbox.devices.length === 0 && inbox.questions.length === 0) {
    return '当前没有待接入的终端、待授权的设备，也没有待答的跨机问题。';
  }
  const parts = [
    formatTerminalList(inbox.terminals, limit),
    formatDeviceList(inbox.devices, limit),
    formatQuestionList(inbox.questions, limit),
    '回复「同意接入 <核对码>」/「拒绝接入 <核对码>」/「允许设备 <码>」/「拒绝设备 <码>」/「回答 <码> <答案>」。',
  ];
  return parts.join('\n');
}

/** 同一批候选的并列清单（歧义时交回用户挑）。 */
export function formatDeviceCandidates(candidates: AnsDevice[], limit = MAX_INBOX_ITEMS): string {
  const shown = candidates.slice(0, limit).map((d) => `· ${formatDeviceCandidate(d)}`).join('\n');
  const more = candidates.length > limit ? `\n…还有 ${candidates.length - limit} 台。` : '';
  return `匹配到 ${candidates.length} 台设备，请用更长的码或回复设备名：\n${shown}${more}`;
}

export function formatQuestionCandidates(candidates: NodeDispatchRecord[], limit = MAX_INBOX_ITEMS): string {
  const shown = candidates.slice(0, limit).map((r) => `· ${formatQuestionCandidate(r)}`).join('\n');
  const more = candidates.length > limit ? `\n…还有 ${candidates.length - limit} 条。` : '';
  return `匹配到 ${candidates.length} 条待答问题，请用更长的码：\n${shown}${more}`;
}

/**
 * 允许/拒绝前的可行动检查：返回人话原因；`null` = 可以执行。
 * ⚠ `deny` 对已授权设备是**撤回**（合法操作），所以只有"本就只读"与"高危"两种无需动作。
 */
export function deviceActionRefusal(dev: AnsDevice, action: 'allow' | 'deny'): string | null {
  if (isHighRiskKind(dev.kind)) {
    return `「${deviceDisplayName(dev)}」属门锁/安防类高危设备，IM 不开放授权；如确需控制，请在本机直接操作。`;
  }
  if (action === 'allow') {
    if (!dev.controllable) return `「${deviceDisplayName(dev)}」自述不具备可控能力（只读设备），无法授权控制。`;
    if (dev.authorized) return `「${deviceDisplayName(dev)}」已授权控制，无需重复。`;
    return null;
  }
  if (!dev.authorized) return `「${deviceDisplayName(dev)}」本就是只读（未授权），未做改动。`;
  return null;
}

/** M2 的推送文案：一次发现多台时聚合为一条（最多 5 台，其余引导查清单）。 */
export function buildDeviceAuthNotice(devices: AnsDevice[], limit = 5): string {
  const shown = devices.slice(0, limit);
  const lines = [`发现 ${devices.length} 台可控制设备，尚未授权：`];
  for (const d of shown) lines.push(`· ${formatDeviceCandidate(d)}`);
  if (devices.length > limit) lines.push(`…还有 ${devices.length - limit} 台，回复「待授权设备」查看全部。`);
  lines.push('回复「允许设备 <码>」开启控制，或「拒绝设备 <码>」保持只读。高危设备不在 IM 审批范围内。');
  return lines.join('\n');
}

/**
 * zx_20261104_3 M2：跨机任务**收口**的人话状态词（`done`/`error`/`cancelled` 三档；其余原样）。
 *   与节点台账的状态词分开：那边说"Pending/Assigned"，这里说用户听得懂的话。
 */
export function remoteResultStatusWord(status: string): string {
  if (status === 'done') return '已完成';
  if (status === 'error') return '失败';
  if (status === 'cancelled') return '已停止';
  return status;
}

/**
 * zx_20261104_3 M2：单条「跨机任务有结果了」——单号短码 / 状态 / 目标节点 / 派单理由。
 *   只从 `node.request_result` 载荷取这四样（不为此伪造整条台账行）；`selection` 由 ANS 原样带回。
 *   缺理由时明说"派单理由未提供"，不编。
 */
export function formatRemoteResultNotice(
  rec: Pick<NodeDispatchRecord, 'requestId' | 'category' | 'targetNodeId'> & {
    status: string;
    selection?: Record<string, unknown> | null;
  },
): string {
  const where = rec.targetNodeId ? rec.targetNodeId.slice(0, 8) : '目标未定';
  const reasonRaw = rec.selection && typeof rec.selection.reason === 'string' ? rec.selection.reason.trim() : '';
  const reason = reasonRaw ? `派单理由：${reasonRaw}` : '派单理由未提供';
  return `· ${rec.category || '跨机任务'} ${shortCode(rec.requestId)} → ${where} · ${remoteResultStatusWord(rec.status)} · ${reason}`;
}

/** 聚合多条收口通知（最多 `limit` 行；其余引导去桌面端看）。空批 ⇒ `''`（不发空消息）。 */
export function buildRemoteResultNotice(
  recs: Array<Pick<NodeDispatchRecord, 'requestId' | 'category' | 'targetNodeId'> & {
    status: string;
    selection?: Record<string, unknown> | null;
  }>,
  limit = 5,
): string {
  if (recs.length === 0) return '';
  const lines = [`跨机任务有结果了（${recs.length}）：`];
  for (const r of recs.slice(0, limit)) lines.push(formatRemoteResultNotice(r));
  if (recs.length > limit) lines.push(`…还有 ${recs.length - limit} 条，到桌面端「协同」页查看。`);
  return lines.join('\n');
}

/**
 * M3 的推送文案：哪一单、问什么、怎么答。
 * 入参取 `Pick` 而非整条台账行——推送这一跳只从 `node.request_question` **事件载荷**取四样，
 *   不必为此伪造 `dispatchedAt`/`status` 等与文案无关的字段（少一处"编数据"的口子）。
 */
export function buildRemoteQuestionNotice(
  rec: Pick<NodeDispatchRecord, 'requestId' | 'category' | 'targetNodeId' | 'question'>,
): string {
  const q = rec.question?.question ?? '';
  const options = rec.question?.options?.length ? `\n选项：${rec.question.options.join(' / ')}` : '';
  const where = rec.targetNodeId ? ` · ${rec.targetNodeId}` : '';
  return `跨机任务在等你回答（码 ${shortCode(rec.requestId)} · ${rec.category || '任务'}${where}）\n`
    + `问题：${q}${options}\n`
    + `回复「回答 ${shortCode(rec.requestId)} 你的答案」即可继续。`;
}
