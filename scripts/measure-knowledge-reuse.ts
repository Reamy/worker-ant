/**
 * zx_20261110_1 B0：项目业务域知识复用——**只读**测量脚本。
 *
 * 目的：把"知识有没有被复用"变成可前后对比的账，而不是口号。四本账：
 *   1. 注入账      —— `wa_context_injections` 按 source 的条数 / 字符 / token / 完成数；
 *   2. 知识卡账    —— `wa_knowledge_cards` 按状态与 kind；
 *   3. 候选包账    —— `wa_domain_packs` 按 origin / 已忽略 / 已启用；
 *   4. 完成账      —— 已完成任务里"带知识注入"与"产生交付物"的交集。
 *
 * 只读：CLI 以 `readOnly: true` 打开生产库；不写任何文件、不建表、不迁移。
 * 输出固定四列 `key|count|chars|note`，便于前后同口径对比。
 *
 * 用法：
 *   npx tsx scripts/measure-knowledge-reuse.ts            # data/worker-ant-server.db
 *   npx tsx scripts/measure-knowledge-reuse.ts <db 路径>  # 指定只读库
 *
 * rr 侧（`rr_zx_20261110_1_contract.ts`）直接调用导出的 `measureKnowledgeReuse(db)`，
 * 用内存库夹具验证口径，不碰生产库。
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 一行账：`key|count|chars|note`（chars 无意义时记 0）。 */
export interface LedgerRow {
  key: string;
  count: number;
  chars: number;
  note: string;
}

type AnyDb = { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[]; get: (...args: unknown[]) => unknown } };

function safeAll(db: AnyDb, sql: string, ...args: unknown[]): Array<Record<string, unknown>> {
  try {
    return db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

function safeGet(db: AnyDb, sql: string, ...args: unknown[]): Record<string, unknown> {
  try {
    return (db.prepare(sql).get(...args) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/**
 * 产出四本账（纯读取）。缺表/老库一律返回空账而不抛——测量不得因老库阻断。
 */
export function measureKnowledgeReuse(db: AnyDb): LedgerRow[] {
  const out: LedgerRow[] = [];

  // ── 1. 注入账（按 source）────────────────────────────────────────────
  const inj = safeAll(
    db,
    `SELECT source, COUNT(*) AS n, COALESCE(SUM(chars),0) AS chars, COALESCE(SUM(est_tokens),0) AS tok,
            SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) AS completed
       FROM wa_context_injections GROUP BY source ORDER BY source`,
  );
  for (const r of inj) {
    const source = String(r.source ?? '(unknown)');
    const n = num(r.n);
    const completed = num(r.completed);
    out.push({
      key: `injection.${source}`,
      count: n,
      chars: num(r.chars),
      note: `tok=${num(r.tok)} completed=${completed} rate=${n > 0 ? `${((completed / n) * 100).toFixed(1)}%` : 'n/a'}`,
    });
  }
  const injTotal = safeGet(db, 'SELECT COUNT(*) AS n, COALESCE(SUM(chars),0) AS chars FROM wa_context_injections');
  out.push({
    key: 'injection.total',
    count: num(injTotal.n),
    chars: num(injTotal.chars),
    note: `sources=${inj.length}`,
  });

  // ── 2. 知识卡账（按 status / kind）───────────────────────────────────
  const cards = safeAll(
    db,
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(tokens),0) AS tok
       FROM wa_knowledge_cards GROUP BY status ORDER BY status`,
  );
  for (const r of cards) {
    out.push({
      key: `knowledge_card.${String(r.status ?? '(unknown)')}`,
      count: num(r.n),
      chars: num(r.tok),
      note: `tokens=${num(r.tok)}`,
    });
  }
  const cardKinds = safeAll(
    db,
    `SELECT kind, COUNT(*) AS n FROM wa_knowledge_cards GROUP BY kind ORDER BY kind`,
  );
  for (const r of cardKinds) {
    out.push({ key: `knowledge_card.kind.${String(r.kind ?? '(unknown)')}`, count: num(r.n), chars: 0, note: '' });
  }

  // ── 3. 候选包账（资产 vs 启用 vs 忽略）───────────────────────────────
  const packs = safeAll(
    db,
    `SELECT origin, COUNT(*) AS n,
            SUM(CASE WHEN dismissed_at IS NULL THEN 0 ELSE 1 END) AS dismissed
       FROM wa_domain_packs GROUP BY origin ORDER BY origin`,
  );
  for (const r of packs) {
    out.push({
      key: `domain_pack.${String(r.origin ?? '(unknown)')}`,
      count: num(r.n),
      chars: 0,
      note: `dismissed=${num(r.dismissed)}`,
    });
  }
  const applied = safeGet(db, 'SELECT COUNT(*) AS n FROM wa_project_domain_packs');
  const autoApplied = safeGet(
    db,
    `SELECT COUNT(DISTINCT m.pack_id) AS n
       FROM wa_project_domain_packs m JOIN wa_domain_packs p ON p.id = m.pack_id
      WHERE p.origin = 'auto_candidate'`,
  );
  out.push({ key: 'domain_pack.enabled', count: num(applied.n), chars: 0, note: 'wa_project_domain_packs 行数' });
  out.push({ key: 'domain_pack.enabled_auto_candidate', count: num(autoApplied.n), chars: 0, note: '自动候选包被启用数' });

  // ── 4. 完成账（完成任务 × 知识注入 × 交付物）─────────────────────────
  const completed = safeGet(db, `SELECT COUNT(*) AS n FROM wa_tasks WHERE status = 'completed'`);
  const completedKnowledge = safeGet(
    db,
    `SELECT COUNT(DISTINCT t.id) AS n
       FROM wa_tasks t JOIN wa_context_injections ci ON ci.task_id = t.id
      WHERE t.status = 'completed' AND ci.source IN ('knowledge','knowledge_card')`,
  );
  const completedKnowledgeWithDeliverable = safeGet(
    db,
    `SELECT COUNT(DISTINCT t.id) AS n
       FROM wa_tasks t
       JOIN wa_context_injections ci ON ci.task_id = t.id AND ci.source IN ('knowledge','knowledge_card')
       JOIN wa_deliverables d ON d.task_id = t.id
      WHERE t.status = 'completed'`,
  );
  const cn = num(completed.n);
  const ck = num(completedKnowledge.n);
  out.push({ key: 'completion.tasks', count: cn, chars: 0, note: '已完成任务总数' });
  out.push({
    key: 'completion.with_knowledge',
    count: ck,
    chars: 0,
    note: `占完成 ${cn > 0 ? `${((ck / cn) * 100).toFixed(1)}%` : 'n/a'}`,
  });
  out.push({
    key: 'completion.with_knowledge_and_deliverable',
    count: num(completedKnowledgeWithDeliverable.n),
    chars: 0,
    note: `占带知识完成 ${ck > 0 ? `${((num(completedKnowledgeWithDeliverable.n) / ck) * 100).toFixed(1)}%` : 'n/a'}`,
  });

  return out;
}

export function formatLedger(rows: LedgerRow[]): string {
  return rows.map((r) => `${r.key}|${r.count}|${r.chars}|${r.note}`).join('\n');
}

function main(): void {
  const root = path.join(__dirname, '..');
  const args = process.argv.slice(2);
  const wantJson = args.includes('--json');
  const dbArg = args.find((a) => !a.startsWith('--'));
  const dbPath = dbArg ? path.resolve(dbArg) : path.join(root, 'data/worker-ant-server.db');
  const db = new DatabaseSync(dbPath, { readOnly: true } as never);
  try {
    const rows = measureKnowledgeReuse(db as unknown as AnyDb);
    if (wantJson) {
      // 同一份 rows 的机器可读出口；`measured_at` 用 UTC，与库内 `datetime('now')` 同基准。
      console.log(JSON.stringify({ db: dbPath, measured_at: new Date().toISOString(), rows }, null, 2));
    } else {
      console.log(`# db=${dbPath} (read-only)`);
      console.log(formatLedger(rows));
    }
  } finally {
    try { (db as unknown as { close: () => void }).close(); } catch { /* ignore */ }
  }
}

if (require.main === module) main();
