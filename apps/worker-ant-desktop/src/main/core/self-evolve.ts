/**
 * zx_20261016_3 批二 · M34 受控自进化 —— **提案台账 + 源码边界**（闸的存储半边）。
 *
 * 是什么：自产"规则/阈值/技能"这类**能改变引擎行为的东西**，一律先落一行 `pending` 提案，
 *   经人工闸（批四的 IPC + 面板）批准后才生效，且生效前存回滚点。本模块只做**存储与边界**，
 *   不建"自动生成并自动应用"的引擎——那正是红线（roadmap 原文：③ **绝不允许**自动改源码）。
 *
 * 为什么批二就先建它（诚实登记，↔ 方案 §0.4 纪律）：台账的**第一个真生产者**就是批二的自愈对策
 *   （熔断产出的"阈值调整"类对策以 `pending` 进本表）。若把建表推到批四，批二就只能"产对策却没有
 *   落点"，台账也会在建好之后仍是一张空表——那正是本仓反复治过的"做了没用上"。
 *   故：**DDL + 守卫 + 写入（`recordProposal`）** 随批二落地；批四补**读与人工闸**（`listProposals` /
 *   `decideProposal` / IPC / 面板）——已齐。
 *
 * ⚠ 红线守卫（康德·批判·先划界）：目标解析后落在**源码树**（`apps/` `packages/` `scripts/` `.github/`）
 *   ⇒ **拒**，且**落库前就拒**（`pending` 也不许）——不允许先把"改源码"这件事记进账里再说。
 */

// ⚠ **零运行期 import**（同 `four-causes.ts` / `healing-outcome.ts` 纪律）：renderer 要引本模块的
//   词表（`PROPOSAL_DECISIONS`）与判据，故不得 `import 'node:crypto'`——id 取全局 `crypto.randomUUID()`
//   （Node ≥20 的 webcrypto 全局，`agent-executor.ts` 已有先例）。`better-sqlite3` 仅类型引用，打包期擦除。
import type Database from 'better-sqlite3';

/** 提案种类（词表唯一真源）。 */
export const SELF_EVOLVE_KINDS = ['skill', 'rule', 'threshold'] as const;
export type SelfEvolveKind = (typeof SELF_EVOLVE_KINDS)[number];

/** 提案状态（词表唯一真源）：`pending` 待人工 → `approved`/`rejected`；`applied` 已生效（可回滚）→ `rolled_back`。 */
export const SELF_EVOLVE_STATUSES = ['pending', 'approved', 'rejected', 'applied', 'rolled_back'] as const;
export type SelfEvolveStatus = (typeof SELF_EVOLVE_STATUSES)[number];

/** 提案台账建表语句（**唯一真源**：生产与受控回归夹具同引此处，夹具不手抄）。 */
export const SELF_EVOLVE_DDL = `
  CREATE TABLE IF NOT EXISTS wa_self_evolve_proposals (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    payload_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    source TEXT,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    decided_at TEXT,
    decided_by TEXT,
    rollback_point TEXT,
    apply_result TEXT
  );
`;

/** 建表（**唯一入口**：生产启动、`recordProposal`、受控回归都走这里）。 */
export function ensureSelfEvolveTable(db: Database.Database): void {
  try {
    db.exec(SELF_EVOLVE_DDL);
  } catch { /* 建不出来不阻断启动；写入侧对缺表另有一层 try 兜底 */ }
}

/**
 * **源码树前缀**——目标落在这里即**拒**（红线：绝不自动改源码）。
 * 与仓库目录结构同一把尺；改目录结构须同步此表（本表是这一条红线的唯一真源）。
 * ⚠ 一律**小写**——比较前目标已折叠大小写（见 `assertProposalTargetAllowed`）。
 */
export const SOURCE_TREE_PREFIXES: readonly string[] = ['apps/', 'packages/', 'scripts/', '.github/'];

/**
 * 红线守卫：这条提案的目标**允不允许**动？
 *
 * 判据取"目标**是不是源码树里的路径**"：相对路径看前缀，绝对路径看是否含源码树段。
 * 非路径型目标（如 `policy.cascade_fail_threshold` 这类设置键）放行——那是本闸**允许**动的对象。
 *
 * 反证标本（批四 rr）：`target='apps/worker-ant-desktop/src/main/core/agent-executor.ts'` ⇒ 被拒。
 */
export function assertProposalTargetAllowed(target: string): { ok: true } | { ok: false; reason: string } {
  const raw = String(target ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty_target' };
  const p = raw.replace(/\\/g, '/');
  // ⚠ **大小写不敏感**：macOS 默认卷（APFS/HFS+）大小写不敏感 ⇒ `Apps/x.ts` 与 `apps/x.ts` 是**同一个文件**。
  //   若按原样比较，大写一个字母就绕过了这道红线（"拒得掉"是假象）。故一律折叠大小写后再判。
  const rel = p.replace(/^\.\//, '').toLowerCase();
  for (const pre of SOURCE_TREE_PREFIXES) {
    if (rel === pre.slice(0, -1) || rel.startsWith(pre)) return { ok: false, reason: 'source_mutation_forbidden' };
  }
  // 绝对路径：把每一段拆开看有没有源码树目录段（`/abs/…/worker-ant/apps/…`）。
  if (rel.startsWith('/')) {
    const segs = rel.split('/').filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      const cur = `${segs[i]}/`;
      if (SOURCE_TREE_PREFIXES.includes(cur)) return { ok: false, reason: 'source_mutation_forbidden' };
      if (segs[i] === '.github') return { ok: false, reason: 'source_mutation_forbidden' };
    }
  }
  return { ok: true };
}

export interface SelfEvolveProposal {
  id: string;
  kind: string;
  target: string;
  payload_json: string | null;
  status: string;
  source: string | null;
  note: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  rollback_point: string | null;
  apply_result: string | null;
}

/**
 * 落一条 **`pending`** 提案（**唯一写入口**：只此一处 INSERT）。
 *
 * ⚠ 守卫在**写之前**判：目标落源码树 ⇒ **不落库**、返回 `{ok:false, reason:'source_mutation_forbidden'}`。
 *   调用方（自愈熔断支）对 `ok:false` 只记审计日志——不静默、也不把它当"已提案"。
 */
export function recordProposal(
  db: Database.Database,
  o: { kind: SelfEvolveKind; target: string; payload?: unknown; source?: string; note?: string },
): { ok: true; id: string } | { ok: false; reason: string } {
  const g = assertProposalTargetAllowed(o.target);
  if (!g.ok) return g;
  try {
    ensureSelfEvolveTable(db);
    const id = crypto.randomUUID();
    db.prepare(
      "INSERT INTO wa_self_evolve_proposals (id, kind, target, payload_json, status, source, note) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
    ).run(id, o.kind, o.target, JSON.stringify(o.payload ?? {}), o.source ?? null, o.note ?? null);
    return { ok: true, id };
  } catch (err) {
    return { ok: false, reason: `write_failed: ${String(err)}` };
  }
}

/**
 * 同一目标**是否已有待批提案**——**去重守卫**，供"每 10 分钟一跳"的自愈扫描用。
 *
 * 为什么必要：熔断支（同异常 24h ≥3 次）**每一轮扫描都会再次命中**（异常还在，计数只增不减），
 * 若每次都投一条提案，台账十条一屏全是同一件事 ⇒ 人工闸被噪声淹没（"狼来了"）。
 * 故同一 `target` 只要有 `pending` 就不重复记账；已 `rejected` 的不算（那是"被否过"，可以有新理由再投）。
 */
export function hasPendingProposalFor(db: Database.Database, target: string): boolean {
  try {
    const r = db.prepare("SELECT COUNT(*) as c FROM wa_self_evolve_proposals WHERE target = ? AND status = 'pending'").get(target) as { c: number } | undefined;
    return !!r && r.c > 0;
  } catch {
    return false;
  }
}

/** 人工闸的三个动作（词表唯一真源，IPC 与面板同引一份，不各写一份字符串）。 */
export const PROPOSAL_DECISIONS = ['approve', 'reject', 'rollback'] as const;
export type ProposalDecision = (typeof PROPOSAL_DECISIONS)[number];

export interface DecideResult {
  ok: boolean;
  /** 决定后的状态（失败时给当下状态，便于界面如实显示"没动过"）。 */
  status?: SelfEvolveStatus;
  reason?: string;
  /** 给人看的一句话（落 `apply_result`，界面看得见）。 */
  detail?: string;
}

/** `wa_settings` 里某键的**原始值**：`null` = 该键**本就不存在**（与"存在且为空串"是两回事）。 */
function readSettingRaw(db: Database.Database, key: string): string | null {
  const r = db.prepare('SELECT value FROM wa_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? r.value : null;
}

/**
 * zx_20261027_3 M4「批了就用」：**自我优化规则**的唯一设置键。
 * 此前 `rule` 类提案只停在 `approved`（「尚无应用器」）——批了却什么也没发生，
 * 人工闸成了"点了没反应"。现由 `applyProposal` 真写入 JSON 字符串数组，执行期由
 * `buildTaskContext` 注入 system 块（`readSelfEvolveRules` 是唯一读出口）。
 */
export const SELF_EVOLVE_RULES_KEY = 'agent.self_rules';
/** 规则清单上限（条 / 单条字数 / 注入块总字数）——超限**拒写**或**整条丢弃**，不截半条。 */
export const SELF_EVOLVE_MAX_RULES = 10;
export const SELF_EVOLVE_MAX_RULE_CHARS = 600;
export const SELF_RULES_BLOCK_MAX_CHARS = 2000;
export const SELF_RULES_HEADING = '## 自我优化规则（人工批准，须遵守）';

/**
 * 读生效中的自我优化规则（**唯一读出口**；缺表/坏 JSON/非数组一律 `[]`，不抛）。
 * ⚠ 读侧宽容、写侧严格：`applyProposal` 遇到坏值**拒绝覆盖**（坏值可能是手改遗留，静默抹掉=毁数据）。
 */
export function readSelfEvolveRules(db: Database.Database): string[] {
  try {
    const raw = readSettingRaw(db, SELF_EVOLVE_RULES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((x) => x.trim());
  } catch {
    return [];
  }
}

/**
 * 把规则拼成执行期 system 块（纯函数，rr 直测）。
 * 总字数超 `maxChars` ⇒ 从**后往前整条丢弃**并在块尾如实说明丢了几条——
 * 半条规则比没有更危险（模型会照着半句走）。
 */
export function buildSelfRulesBlock(
  rules: readonly string[],
  maxChars = SELF_RULES_BLOCK_MAX_CHARS,
): { text: string; dropped: number } {
  if (rules.length === 0) return { text: '', dropped: 0 };
  const lines = rules.map((r) => `- ${r.replace(/\s+/g, ' ').trim()}`).filter((l) => l.length > 2);
  const kept: string[] = [];
  let used = SELF_RULES_HEADING.length;
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break;
    kept.push(line);
    used += line.length + 1;
  }
  const dropped = lines.length - kept.length;
  const tail = dropped > 0 ? `\n（另有 ${dropped} 条规则超出上下文预算，本次未注入）` : '';
  if (kept.length === 0) return { text: '', dropped };
  return { text: `${SELF_RULES_HEADING}\n${kept.join('\n')}${tail}`, dropped };
}

/**
 * `rule` 类提案的应用器（zx_20261027_3 M4）：载荷 `{ text }`，真写入 `agent.self_rules` 数组。
 * 拒绝写入的四种情形都**如实带原因**、状态停在 `approved`（不假装生效）：
 *   · 缺 `text`；· 单条超 `SELF_EVOLVE_MAX_RULE_CHARS`；· 已在清单中（去重）；· 已达 `SELF_EVOLVE_MAX_RULES` 条。
 * 另：现有值**不是字符串数组**（手改遗留/坏 JSON）⇒ 拒绝覆盖——写入侧严格，宁可不动也不毁旧值。
 */
function applyRuleProposal(db: Database.Database, row: SelfEvolveProposal): DecideResult & { rollbackPoint?: string } {
  let payload: { text?: unknown } = {};
  try { payload = JSON.parse(row.payload_json || '{}') as { text?: unknown }; } catch { /* 坏载荷按缺 text 处置 */ }
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) return { ok: false, status: 'approved', detail: '已批准；但提案载荷缺 text，无从应用' };
  if (text.length > SELF_EVOLVE_MAX_RULE_CHARS) {
    return { ok: false, status: 'approved', reason: 'rule_too_long', detail: `已批准；但规则 ${text.length} 字超过上限 ${SELF_EVOLVE_MAX_RULE_CHARS} 字，未生效` };
  }
  const previous = readSettingRaw(db, SELF_EVOLVE_RULES_KEY);
  let existing: string[] = [];
  if (previous !== null) {
    try {
      const parsed = JSON.parse(previous) as unknown;
      if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string')) throw new Error('not_string_array');
      existing = (parsed as string[]).map((x) => x.trim()).filter(Boolean);
    } catch {
      return { ok: false, status: 'approved', reason: 'rules_unreadable', detail: '已批准；但现有规则不是字符串数组，拒绝覆盖（防止毁掉旧值）' };
    }
  }
  if (existing.includes(text)) {
    return { ok: false, status: 'approved', reason: 'rule_duplicated', detail: '已批准；该规则已在生效清单中，未重复写入' };
  }
  if (existing.length >= SELF_EVOLVE_MAX_RULES) {
    return { ok: false, status: 'approved', reason: 'rule_limit', detail: `已批准；但规则已达上限 ${SELF_EVOLVE_MAX_RULES} 条，未生效（请先回滚旧规则）` };
  }
  try {
    const next = [...existing, text];
    db.prepare("INSERT OR REPLACE INTO wa_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(SELF_EVOLVE_RULES_KEY, JSON.stringify(next));
    return {
      ok: true,
      status: 'applied',
      rollbackPoint: JSON.stringify({ setting_key: SELF_EVOLVE_RULES_KEY, previous }),
      detail: `已应用：自我优化规则（现共 ${next.length} 条）`,
    };
  } catch (err) {
    return { ok: false, status: 'approved', reason: `apply_failed: ${String(err)}`, detail: `应用失败：${String(err)}` };
  }
}

/**
 * 应用一条提案（**唯一 apply 实现**；只由 `decideProposal{approve}` 调用——**无任何定时/自动路径**）。
 *
 * ⚠ **`threshold` 与 `rule` 有应用器**（zx_20261027_3 M4 起 `rule` 真写入
 *   `agent.self_rules` 并由执行期注入）。`skill` 仍无真生产者（台账里出现只会是人工投的），
 *   对它**不假装已生效**：回 `approved` 并如实说"尚无应用器"——`applied` 这个状态必须意味着
 *   "引擎行为真的变了"，否则它就成了又一个"标高而实空"。
 *
 * ⚠ **回滚点存的是"旧值本身"**：旧值**不存在** ⇒ 存 `previous: null`，回滚时**删键**（恢复"不存在"），
 *   而不是写回一个等价的默认值——"10 分钟"与"没设过"在账上、在设置页上都不是一回事。
 */
function applyProposal(db: Database.Database, row: SelfEvolveProposal): DecideResult & { rollbackPoint?: string } {
  if (row.kind === 'rule') return applyRuleProposal(db, row);
  if (row.kind !== 'threshold') {
    return { ok: false, status: 'approved', detail: `已批准；但 \`${row.kind}\` 类提案尚无应用器（不假装已生效）` };
  }
  let payload: { suggested?: unknown } = {};
  try { payload = JSON.parse(row.payload_json || '{}') as { suggested?: unknown }; } catch { /* 坏载荷按缺 suggested 处置 */ }
  const suggested = String(payload.suggested ?? '').trim();
  if (!suggested) return { ok: false, status: 'approved', detail: '已批准；但提案载荷缺 suggested，无从应用' };
  try {
    const previous = readSettingRaw(db, row.target);
    db.prepare("INSERT OR REPLACE INTO wa_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(row.target, suggested);
    return {
      ok: true,
      status: 'applied',
      rollbackPoint: JSON.stringify({ setting_key: row.target, previous }),
      detail: `已应用：${row.target} = ${suggested}（原值 ${previous ?? '未设置'}）`,
    };
  } catch (err) {
    return { ok: false, status: 'approved', reason: `apply_failed: ${String(err)}`, detail: `应用失败：${String(err)}` };
  }
}

/**
 * **人工闸**（唯一入口；IPC `selfEvolve:decide` 直通此处）。
 *
 * 状态迁移（其余一律 `bad_state` **原样不动**——不许"点了没反应但状态变了"）：
 *   · `approve`  —— 仅 `pending` ⇒ `applied`（有应用器）/ `approved`（无应用器，如实）；
 *   · `reject`   —— 仅 `pending` ⇒ `rejected`；
 *   · `rollback` —— 仅 `applied` ⇒ `rolled_back`（恢复 `rollback_point` 里的旧值）。
 *
 * ⚠ **红线守卫在 `decide` 再判一次**（与建表写口两处同判据）：写口被绕过（直插 SQL）的源码目标
 *   提案，在这里同样**动不了**——留 `pending` 并回 `source_mutation_forbidden`，由人工显式 `reject`。
 */
export function decideProposal(
  db: Database.Database,
  o: { id: string; decision: ProposalDecision; by?: string },
): DecideResult {
  const by = (o.by && String(o.by).trim()) || 'user';
  let row: SelfEvolveProposal | undefined;
  try {
    row = db.prepare(
      'SELECT id, kind, target, payload_json, status, source, note, created_at, decided_at, decided_by, rollback_point, apply_result FROM wa_self_evolve_proposals WHERE id = ?',
    ).get(o.id) as SelfEvolveProposal | undefined;
  } catch (err) {
    return { ok: false, reason: `read_failed: ${String(err)}` };
  }
  if (!row) return { ok: false, reason: 'not_found' };

  const setDecided = (status: SelfEvolveStatus, rollbackPoint: string | null, applyResult: string): SelfEvolveStatus => {
    db.prepare(
      "UPDATE wa_self_evolve_proposals SET status = ?, decided_at = datetime('now'), decided_by = ?, rollback_point = COALESCE(?, rollback_point), apply_result = ? WHERE id = ?",
    ).run(status, by, rollbackPoint, applyResult, o.id);
    return status;
  };

  if (o.decision === 'reject') {
    if (row.status !== 'pending') return { ok: false, status: row.status as SelfEvolveStatus, reason: 'bad_state' };
    return { ok: true, status: setDecided('rejected', null, '人工拒绝，未生效'), detail: '已拒绝' };
  }

  // ⚠ **红线守卫只拦"会改变世界"的两个动作**（`approve` / `rollback`）——`reject` 在上一支已返回。
  //   拒绝只是一句"不"，不改任何东西；若连拒都拦，被绕过塞进来的坏行就**永远钉在 `pending` 队列里**
  //   清不掉（"待批"变成"待批到永远"）。故守卫放在 `reject` **之后**：拒得掉，动不了。
  const guard = assertProposalTargetAllowed(row.target);
  if (!guard.ok) return { ok: false, status: row.status as SelfEvolveStatus, reason: guard.reason };

  if (o.decision === 'approve') {
    if (row.status !== 'pending') return { ok: false, status: row.status as SelfEvolveStatus, reason: 'bad_state' };
    const a = applyProposal(db, row);
    return { ok: a.ok, status: setDecided(a.status ?? 'approved', a.rollbackPoint ?? null, a.detail ?? ''), reason: a.reason, detail: a.detail };
  }

  // rollback：只有**真生效过**的才谈得上回滚
  if (row.status !== 'applied') return { ok: false, status: row.status as SelfEvolveStatus, reason: 'bad_state' };
  let rp: { setting_key?: unknown; previous?: unknown } = {};
  try { rp = JSON.parse(row.rollback_point || '{}') as { setting_key?: unknown; previous?: unknown }; } catch { /* 坏回滚点按缺处置 */ }
  const key = String(rp.setting_key ?? '').trim();
  if (!key) return { ok: false, status: row.status as SelfEvolveStatus, reason: 'no_rollback_point' };
  try {
    const previous = typeof rp.previous === 'string' ? rp.previous : null;
    if (previous === null) db.prepare('DELETE FROM wa_settings WHERE key = ?').run(key);
    else db.prepare("INSERT OR REPLACE INTO wa_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, previous);
    const detail = `已回滚：${key} 恢复为 ${previous ?? '未设置'}`;
    return { ok: true, status: setDecided('rolled_back', null, detail), detail };
  } catch (err) {
    return { ok: false, status: row.status as SelfEvolveStatus, reason: `rollback_failed: ${String(err)}` };
  }
}

/** 读提案（**只读出口**，供批四面板/IPC 用；空集/缺表一律 `[]`，不抛）。 */
export function listProposals(db: Database.Database, limit = 50): SelfEvolveProposal[] {
  const n = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 50));
  try {
    return db.prepare(
      'SELECT id, kind, target, payload_json, status, source, note, created_at, decided_at, decided_by, rollback_point, apply_result FROM wa_self_evolve_proposals ORDER BY created_at DESC, rowid DESC LIMIT ?',
    ).all(n) as SelfEvolveProposal[];
  } catch {
    return [];
  }
}
