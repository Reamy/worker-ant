/**
 * zx_20261014_4 批二（罗尔斯·无知之幕 / 管子·度量衡 / 毛选·没有调查没有发言权）:
 * 「门」的**配对**与**凭据**——一台外部 AI 终端如何**进门**。
 *
 * 病根：批一开了门（默认关）、挂了门牌，但**进门无路**——门牌只**指路**（`pairing.endpoint`），
 *   真要走进来得有一套"申请 → 人批 → 拿凭据 → 出示凭据"的账。本轮把这条账建起来。
 *
 * 三条纪律：
 *   ① **凭据不经用户手**（罗尔斯·无知之幕）：用户只做一个动作——**点同意**；凭据由端点**直发终端**，
 *      不落桌面、不给用户抄。故 `approve` 不把明文回 IPC，终端的凭据只从 `pairStatus` 那条**轮询**路取。
 *   ② **只存 hash**（`secret_hash`）——明文入内存一次（`pendingDelivery`）、送达即弃；库中**永不落明文**。
 *   ③ **只回一次**（`delivered_at` 落地）——第二次轮询不再回凭据（免得凭据在链路上反复漂）。
 *
 * ⚠ **零 electron / 零 better-sqlite3**（只用 `node:crypto` + 最小库接口 `TerminalDb`）⇒ rr 直引跑真实现。
 * ⚠ 短码 `pair_code` 是**给人核对的**（6 位数字），**不是**凭据；凭据是 `key.secret`（32 字节随机）。
 * ⚠ 进程重启会丢掉"批准了但还没送达"的内存凭据 ⇒ 该次配对**作废**（终端拿不到、用户吊销重配即可）。
 *   这是"库只存 hash"的**必然后果**，如实不假装能补发（毛选·没有调查没有发言权：不编一个不存在的凭据）。
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** 只用到的库接口——使本模块可脱 better-sqlite3，在受控回归里跑真逻辑（同 `settings-bool.ts` 范式）。 */
export interface TerminalDb {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

export type TerminalStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

/** 库行形状（**门内之物**——`secret_hash`/`pair_code` 不外露，见 `TerminalPublic`）。 */
export interface TerminalRow {
  id: string;
  name: string;
  status: TerminalStatus;
  pair_code: string;
  key_prefix: string | null;
  secret_hash: string | null;
  capabilities_json: string;
  last_remote_addr: string | null;
  last_seen_at: string | null;
  created_at: string;
  approved_at: string | null;
  revoked_at: string | null;
  delivered_at: string | null;
}

/** 对外可见的终端行（面板用）——**不含** `secret_hash` / `pair_code`。 */
export interface TerminalPublic {
  id: string;
  name: string;
  status: TerminalStatus;
  capabilities: string[];
  key_prefix: string | null;
  last_remote_addr: string | null;
  last_seen_at: string | null;
  created_at: string;
  approved_at: string | null;
  revoked_at: string | null;
  /** 凭据是否**已送达**终端（未送达 ⇒ 终端还用不了；用户可据此决定吊销重配）。 */
  delivered: boolean;
}

/**
 * zx_20261014_4 批三: **`pending` 期的对外行**——比 `TerminalPublic` **多一样** `pair_code`。
 *   ⚠ 短码**不是凭据**（凭据只有 `key.secret`）——它是**给人核对**的：终端那头也显示同一个 6 位码，
 *   用户在面板上看着两边对得上，才点"同意"（罗尔斯·无知之幕：门外的人只该看见"足以核对它是谁"的那样，不多一样）。
 *   批准/拒绝之后短码即无用，故**不进** `TerminalPublic`（那本账里它只是噪声）。
 */
export interface PendingTerminalPublic extends TerminalPublic {
  pair_code: string;
}

/** 凭据 secret 的哈希（`sha256` hex）——库中只此一种形态。 */
export function hashTerminalSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** 凭据 key（`wt_` + 32 hex）；校验时按前 8 位取行（照 `ans_api_keys` 的 `key_prefix` 范式）。 */
function newTerminalKey(): string {
  return 'wt_' + randomBytes(16).toString('hex');
}

/** 6 位短码（`pending` 期给人核对"来的真是这个东西"；**非**凭据）。 */
export function generatePairCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * 批准后、**送达前**暂存于内存的明文凭据。
 * ⚠ 库中**永不落明文**（P-5）；故明文只能活在这里、送达即删。进程重启即失（见文件头注）。
 */
interface PendingDelivery { key: string; secret: string }
const pendingDelivery = new Map<string, PendingDelivery>();

/** 仅供受控回归清场（模块级内存态）。 */
export function __resetTerminalSecretsForTest(): void {
  pendingDelivery.clear();
}

function parseCaps(json: string | null | undefined): string[] {
  try {
    const p = JSON.parse(json || '[]');
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

function rowToPublic(r: TerminalRow): TerminalPublic {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    capabilities: parseCaps(r.capabilities_json),
    key_prefix: r.key_prefix,
    last_remote_addr: r.last_remote_addr,
    last_seen_at: r.last_seen_at,
    created_at: r.created_at,
    approved_at: r.approved_at,
    revoked_at: r.revoked_at,
    delivered: !!r.delivered_at,
  };
}

/** 终端申请进门：建一条 `pending` 行，回 `pairing_id` + `pair_code`（后者给人在面板上核对）。 */
export function createPairRequest(db: TerminalDb, name: string, remoteAddr?: string): { pairingId: string; pairCode: string } {
  const pairingId = randomUUID();
  const pairCode = generatePairCode();
  db.prepare(
    `INSERT INTO wa_external_terminals (id, name, status, pair_code, capabilities_json, last_remote_addr, last_seen_at)
     VALUES (?, ?, 'pending', ?, '[]', ?, datetime('now'))`,
  ).run(pairingId, name, pairCode, remoteAddr ?? null);
  return { pairingId, pairCode };
}

/** 全部终端（含各态），新的在前——面板"已授权终端"区块用。 */
export function listTerminals(db: TerminalDb): TerminalPublic[] {
  const rows = db.prepare('SELECT * FROM wa_external_terminals ORDER BY created_at DESC, id DESC').all() as TerminalRow[];
  return rows.map(rowToPublic);
}

/**
 * zx_20261016_2（维特根斯坦·意义即用法 / 罗尔斯·同一把尺）: 控制留痕行的「外部终端引用」——
 *   `terminal_id` ⇒ 终端名，**读时现查**（与 `taskRefsOf` **同一把尺**：不留渲染快照、查无不进 map）。
 *   ⚠ **逐条查**（非动态 `IN (?)` 拼占位符，承 `zx_20261003` §7）；条数 = 审计条数（默认 ≤ 50），代价可忽略。
 */
export function terminalNamesOf(db: TerminalDb, ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const stmt = db.prepare('SELECT name FROM wa_external_terminals WHERE id = ?');
  for (const id of new Set(ids)) {
    if (!id) continue;
    const row = stmt.get(id) as { name?: unknown } | undefined;
    if (!row) continue; // 查无此终端 ⇒ 不造名（调用方据此如实回退 id 前缀）
    out.set(id, String(row.name ?? ''));
  }
  return out;
}

/** 仅 `pending` 终端，早的在前——面板"待审批"区块用（先来先看）。带短码（见 `PendingTerminalPublic`）。 */
export function listPendingTerminals(db: TerminalDb): PendingTerminalPublic[] {
  const rows = db.prepare("SELECT * FROM wa_external_terminals WHERE status = 'pending' ORDER BY created_at ASC, id ASC").all() as TerminalRow[];
  return rows.map((r) => ({ ...rowToPublic(r), pair_code: r.pair_code }));
}

/**
 * 批准一台终端：铸发凭据（库只存 hash），明文入内存待终端轮询取走。
 * 只对 `pending` 行有效（重复批/批已否行 ⇒ 如实回 `not_pending`，不静默改状态）。
 */
export function approveTerminal(db: TerminalDb, pairingId: string, capabilities: string[] = []): { ok: true } | { ok: false; reason: string } {
  const row = db.prepare('SELECT * FROM wa_external_terminals WHERE id = ?').get(pairingId) as TerminalRow | undefined;
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'pending') return { ok: false, reason: `not_pending:${row.status}` };
  const key = newTerminalKey();
  const secret = randomBytes(32).toString('hex');
  const caps = (Array.isArray(capabilities) ? capabilities : []).filter((c): c is string => typeof c === 'string');
  db.prepare(
    `UPDATE wa_external_terminals SET status='approved', key_prefix=?, secret_hash=?, capabilities_json=?, approved_at=datetime('now') WHERE id=?`,
  ).run(key.slice(0, 8), hashTerminalSecret(secret), JSON.stringify(caps), pairingId);
  pendingDelivery.set(pairingId, { key, secret });
  return { ok: true };
}

/** 拒绝一台终端（只对 `pending` 行有效）。 */
export function rejectTerminal(db: TerminalDb, pairingId: string): { ok: true } | { ok: false; reason: string } {
  const row = db.prepare('SELECT * FROM wa_external_terminals WHERE id = ?').get(pairingId) as TerminalRow | undefined;
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'pending') return { ok: false, reason: `not_pending:${row.status}` };
  db.prepare(`UPDATE wa_external_terminals SET status='rejected' WHERE id=?`).run(pairingId);
  return { ok: true };
}

/** 吊销一台**已批准**终端：其凭据**立即**失效（`verifyTerminal` 查 `status`），并弃掉未送达的明文。 */
export function revokeTerminal(db: TerminalDb, terminalId: string): { ok: true } | { ok: false; reason: string } {
  const row = db.prepare('SELECT * FROM wa_external_terminals WHERE id = ?').get(terminalId) as TerminalRow | undefined;
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'approved') return { ok: false, reason: `not_approved:${row.status}` };
  db.prepare(`UPDATE wa_external_terminals SET status='revoked', revoked_at=datetime('now') WHERE id=?`).run(terminalId);
  pendingDelivery.delete(terminalId);
  return { ok: true };
}

/** 终端轮询配对结果的四种态；`approved` 时**首次**给凭据、之后只报"已送达"。 */
export type PairStatusResult =
  | { status: 'unknown' }
  | { status: 'pending' }
  | { status: 'rejected' }
  | { status: 'revoked' }
  | { status: 'approved'; credentials?: { key: string; secret: string }; note?: 'credentials_lost' };

/**
 * 终端轮询取凭据（**免凭据**端点，靠 `pairing_id` + `pair_code` 双因子自证——两者都对才算问的是自己那单）。
 * 短码不符一律当 `unknown`（不泄露"这单存在"）。
 */
export function pairStatus(db: TerminalDb, pairingId: string, pairCode: string): PairStatusResult {
  if (!pairingId || !pairCode) return { status: 'unknown' };
  const row = db.prepare('SELECT * FROM wa_external_terminals WHERE id = ?').get(pairingId) as TerminalRow | undefined;
  if (!row || row.pair_code !== pairCode) return { status: 'unknown' };
  if (row.status === 'pending') return { status: 'pending' };
  if (row.status === 'rejected') return { status: 'rejected' };
  if (row.status === 'revoked') return { status: 'revoked' };
  // approved：凭据**只回一次**（`delivered_at` 落地后不再回）。
  if (row.delivered_at) return { status: 'approved' };
  const cred = pendingDelivery.get(pairingId);
  if (!cred) return { status: 'approved', note: 'credentials_lost' };
  db.prepare(`UPDATE wa_external_terminals SET delivered_at = datetime('now') WHERE id = ?`).run(pairingId);
  pendingDelivery.delete(pairingId);
  return { status: 'approved', credentials: { key: cred.key, secret: cred.secret } };
}

export interface VerifiedTerminal { terminalId: string; capabilities: string[] }
export type VerifyResult =
  | { ok: true; terminal: VerifiedTerminal }
  | { ok: false; status: 401 | 403; reason: string };

/**
 * 校验一支凭据（`key.secret`）。
 *   401：缺凭据 / key 不认得 / secret 不符（**不区分**"key 不存在"与"secret 错"，免得成 oracle）。
 *   403：key 认得但**未处于 approved**（pending / rejected / revoked）。
 * 成功时**如实记** `last_seen_at` / `last_remote_addr`（"这台终端最后什么时候来过"）。
 */
export function verifyTerminal(db: TerminalDb, key: string, secret: string, remoteAddr?: string): VerifyResult {
  if (!key || !secret) return { ok: false, status: 401, reason: 'missing_credentials' };
  const row = db.prepare('SELECT * FROM wa_external_terminals WHERE key_prefix = ?').get(key.slice(0, 8)) as TerminalRow | undefined;
  if (!row || !row.secret_hash) return { ok: false, status: 401, reason: 'unknown_key' };
  const a = Buffer.from(row.secret_hash, 'utf8');
  const b = Buffer.from(hashTerminalSecret(secret), 'utf8');
  const same = a.length === b.length && timingSafeEqual(a, b);
  if (!same) return { ok: false, status: 401, reason: 'bad_secret' };
  if (row.status !== 'approved') return { ok: false, status: 403, reason: `not_approved:${row.status}` };
  try {
    db.prepare(`UPDATE wa_external_terminals SET last_seen_at = datetime('now'), last_remote_addr = ? WHERE id = ?`)
      .run(remoteAddr ?? row.last_remote_addr, row.id);
  } catch { /* 记见面时间失败不阻断校验 */ }
  return { ok: true, terminal: { terminalId: row.id, capabilities: parseCaps(row.capabilities_json) } };
}

/**
 * 配对/凭据**端口**——`inbound-gate.handleInboundRequest` 消费的窄面。
 * 定义在此（生产者侧），门模块只按结构消费（`import type`），不反向依赖。
 */
export interface PairingPort {
  requestPair(name: string, remoteAddr?: string): { pairingId: string; pairCode: string };
  pairStatus(pairingId: string, pairCode: string): PairStatusResult;
  verify(key: string, secret: string, remoteAddr?: string): VerifyResult;
}

/** 把一组真实现绑到某个 db 上，供门模块注入（rr 传内存库，生产传主库）。 */
export function createPairingPort(db: TerminalDb): PairingPort {
  return {
    requestPair: (name, remoteAddr) => createPairRequest(db, name, remoteAddr),
    pairStatus: (pairingId, pairCode) => pairStatus(db, pairingId, pairCode),
    verify: (key, secret, remoteAddr) => verifyTerminal(db, key, secret, remoteAddr),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// zx_20261016_1「应」批二/批三（周易·乾·文言「同声相应」/ 维特根斯坦·意义即用法 /
//   王阳明·知行合一 / 罗尔斯·无知之幕 / 庄子·不预设）:
//   **有人应门**——申请推得到人（批二·出站）+ 回复即审批（批三·入站）。
//
// ⚠ 下面四件（`buildPairNotice` / `parsePairReply` / `resolvePairTarget`）**都不触网、不碰 electron**，
//   只由 `TerminalDb` 读库（或压根不读）⇒ rr 直引跑真实现（承本文件既有纪律）。
// ⚠ **`pair_code` 不是凭据**：它在通知与回执里出现，只因它是**给人核对**的那一样
//   （门外的人只该看见"足以核对它是谁"的那样，不多一样）——凭据仍只经 `pairStatus` 轮询**直发终端**。
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 配对申请的**人话通知**（纯函数——rr 直引断言，承 `device-registry.ts` 零依赖范式）。
 *
 * 为什么文案里**同时给核对码与两条完整命令**：用户在 IM 里点不到"同意"按钮，只能**回一句话**；
 * 这句回话要能被 `parsePairReply` 认出来，就得**照抄**这里的形状（维特根斯坦·意义即用法：
 * 意义即用法——文案若与解析器各说各话，用户照做即失败，那是本仓「说明书与机器各说各话」的老病）。
 */
export function buildPairNotice(o: { name: string; pairCode: string }): string {
  return `🤖 有终端请求接入工蚁：「${o.name}」（核对码 ${o.pairCode}）。回复「同意接入 ${o.pairCode}」允许，回复「拒绝接入 ${o.pairCode}」拒绝。`;
}

/** 用户 IM 回复解析结果的形状（`code:null` = 没带核对码，靠"当前只有一条待批"来定；见 `resolvePairTarget`）。 */
export interface PairReply {
  kind: 'approve' | 'reject';
  code: string | null;
}

// 两条**整句锚定**的谓词：必须含「接入」二字（否则 `null`——**绝不能**吃掉任务审批的裸「同意」/「是」）。
// 尾部容错标点，允许用户手打句号/感叹号；中段 `\s*` 容忍手机输入法多打的空格。
const PAIR_APPROVE_RE = /^\s*(同意|允许|接受|通过)\s*接入\s*(\d{6})?\s*[!！。.]*\s*$/;
const PAIR_REJECT_RE = /^\s*(拒绝|不许|不接受)\s*接入\s*(\d{6})?\s*[!！。.]*\s*$/;

/**
 * 用户 IM 回复 → 配对审批意图；**不是配对回复**（含裸「同意」「是」）→ `null`。
 *
 * 「不预设」（庄子·齐物论）：本函数**只**认「(同意|拒绝) 接入 [码]」这一种句式，不猜用户还可能是别的意思。
 * 尤其**不含「接入」二字的一律 `null`**——那些仍归任务审批路（`core/im/options.ts` 的 `matchApprovalReply`），
 * 两路语义不混（反证标本见 rr P-2）。
 */
export function parsePairReply(text: string): PairReply | null {
  const t = String(text ?? '');
  const a = t.match(PAIR_APPROVE_RE);
  if (a) return { kind: 'approve', code: a[2] ?? null };
  const r = t.match(PAIR_REJECT_RE);
  if (r) return { kind: 'reject', code: r[2] ?? null };
  return null;
}

/** `resolvePairTarget` 的三态：定到唯一一条 / 多条待批**列候选不猜** / 无待批申请。 */
export type PairTargetResult =
  | { kind: 'ok'; pending: PendingTerminalPublic }
  | { kind: 'ambiguous'; pendings: PendingTerminalPublic[] }
  | { kind: 'none' };

/**
 * 把一条回复**定到**具体是哪张待批申请（庄子·不预设 / 承 `resolveDeviceByName` 歧义列候选不猜）。
 *
 * - **带码**：在待批列表里**恰一条**码相符 ⇒ `ok`；无相符（含码打错、申请已被别处批掉）⇒ `none`——**不猜**。
 * - **无码**：待批恰一条 ⇒ `ok`；**≥2 条** ⇒ `ambiguous`（**列候选，不批**——免得"同意接入"落在错的那台上）；
 *   `0` 条 ⇒ `none`。
 */
export function resolvePairTarget(db: TerminalDb, code: string | null): PairTargetResult {
  const pendings = listPendingTerminals(db);
  if (code) {
    const hits = pendings.filter((p) => p.pair_code === code);
    return hits.length === 1 ? { kind: 'ok', pending: hits[0] } : { kind: 'none' };
  }
  if (pendings.length === 1) return { kind: 'ok', pending: pendings[0] };
  if (pendings.length >= 2) return { kind: 'ambiguous', pendings };
  return { kind: 'none' };
}
