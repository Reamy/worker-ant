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
  devices: AnsDevice[];
  questions: NodeDispatchRecord[];
}

export function buildApprovalInbox(db: ApprovalInboxDb): ApprovalInbox {
  return { devices: pendingDevices(db), questions: pendingQuestions(db) };
}

export function deviceDisplayName(dev: AnsDevice): string {
  return dev.alias || dev.name || shortCode(dev.id);
}

export function formatDeviceCandidate(dev: AnsDevice): string {
  const extra = [dev.room, dev.kind_class || dev.kind].filter((x) => x && x.trim() !== '').join(' / ');
  return `「${deviceDisplayName(dev)}」${extra ? `（${extra}）` : ''} 码 ${shortCode(dev.id)}`;
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
  const parts = [formatDeviceList(inbox.devices, limit), formatQuestionList(inbox.questions, limit)];
  if (inbox.devices.length === 0 && inbox.questions.length === 0) {
    return '当前没有待授权的设备，也没有待答的跨机问题。';
  }
  parts.push('回复「允许设备 <码>」/「拒绝设备 <码>」/「回答 <码> <答案>」。');
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
