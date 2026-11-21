/**
 * 探索配额账的**持久化形状**（zx_20261120_2 M3「衡」）。
 *
 * 病根：`ExploreQuotaLedger` 是每次 `executeTask` 新建的内存账，跨恢复/重启清零——
 * 一个任务 4 次 run 就等于 4×20 次探索额度，"硬线 20"名不副实。
 * 本模块只负责把账落成 `context_json.shell_explore` 一格（单键写入，不整体覆写），
 * 以及从 context 里读回；计数与判定仍归 `ExploreQuotaLedger` 一处。
 *
 * 空态约定：没有该键 / 形状不对 ⇒ 空账（从 0 起），**不猜**、不报错。
 */

/** context_json 里的单键名（改它须同步 `tool-registry.ts` 的 hydrate 调用点与 rr）。 */
export const EXPLORE_LEDGER_KEY = 'shell_explore';

export interface ExploreLedgerSnapshot {
  /** 按 `quotaKey` 的计数（当前只有 `shell_explore` 一本）。 */
  counts: Record<string, number>;
  /** 已响过软告警的 `quotaKey`（跨 run 只响一次）。 */
  softWarned: string[];
}

/** 只接受非负整数计数；坏值丢弃（不把 NaN/负值带进账）。 */
function cleanCounts(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(v);
    if (typeof k === 'string' && k && Number.isFinite(n) && n > 0) out[k] = Math.floor(n);
  }
  return out;
}

function cleanSoftWarned(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((x): x is string => typeof x === 'string' && x.length > 0))];
}

/** `context_json`（对象或 JSON 字符串）→ 账快照；读不到/坏形状 ⇒ 空账。 */
export function readExploreLedger(ctxJson: unknown): ExploreLedgerSnapshot {
  let obj: Record<string, unknown> | null = null;
  if (typeof ctxJson === 'string') {
    try { obj = JSON.parse(ctxJson || '{}') as Record<string, unknown>; } catch { obj = null; }
  } else if (ctxJson && typeof ctxJson === 'object' && !Array.isArray(ctxJson)) {
    obj = ctxJson as Record<string, unknown>;
  }
  const raw = obj?.[EXPLORE_LEDGER_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { counts: {}, softWarned: [] };
  const r = raw as Record<string, unknown>;
  return { counts: cleanCounts(r.counts), softWarned: cleanSoftWarned(r.softWarned) };
}

/**
 * 把账写回 `context_json` 的**单键**（不整体覆写——兄弟键一个不丢）。
 * 传入的 `ctxJson` 由调用方负责落库（本函数只改内存对象）。
 */
export function writeExploreLedger(ctxJson: Record<string, unknown>, snap: ExploreLedgerSnapshot): void {
  const counts = cleanCounts(snap.counts);
  const softWarned = cleanSoftWarned(snap.softWarned);
  // 从未探索过的任务**不写空键**：老任务的 context_json 形状逐字不变（全量回归不因多一个空键漂移）。
  if (Object.keys(counts).length === 0 && softWarned.length === 0) {
    delete ctxJson[EXPLORE_LEDGER_KEY];
    return;
  }
  ctxJson[EXPLORE_LEDGER_KEY] = { counts, softWarned };
}

/** 落库所需的最小库形状（只用 get/run；与生产 `Database` 可直传）。 */
export interface ExploreLedgerDb {
  prepare(sql: string): { get(...args: any[]): any; run(...args: any[]): any };
}

/** 账本的最小能力面（`ExploreQuotaLedger` 直传；rr 可用假账本）。 */
export interface ExploreLedgerLike {
  hydrate(snap: ExploreLedgerSnapshot): void;
  snapshot(): ExploreLedgerSnapshot;
}

/** 从任务 context 恢复探索账；读不到/坏 JSON ⇒ 空账（不抛、不阻断执行）。 */
export function hydrateExploreLedger(db: ExploreLedgerDb, taskId: string, ledger: ExploreLedgerLike): void {
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined;
    ledger.hydrate(readExploreLedger(row?.context_json ?? '{}'));
  } catch { /* 恢复失败按空账，如实从 0 起 */ }
}

/**
 * 步回调包装：每步结算后若账有变化，只用 `json_set` 写 `$.shell_explore` 一格
 * （不重写整份 context，兄弟键一个不丢）。步逻辑本身仍归 `createStepHandler` 一处。
 */
export function createExploreLedgerPersistingStepHandler<E>(
  base: (event: E) => Promise<void>,
  ledger: ExploreLedgerLike,
  db: ExploreLedgerDb,
  taskId: string,
): (event: E) => Promise<void> {
  let last = JSON.stringify(ledger.snapshot());
  return async (event: E): Promise<void> => {
    await base(event);
    const snap = JSON.stringify(ledger.snapshot());
    if (snap === last) return;
    last = snap;
    try {
      db.prepare("UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json,'{}'), '$.shell_explore', json(?)) WHERE id = ?")
        .run(snap, taskId);
    } catch { /* 记账失败不阻断执行 */ }
  };
}
