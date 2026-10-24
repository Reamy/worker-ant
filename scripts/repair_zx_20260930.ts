/**
 * zx_20260930 M3-f 一次性数据修复（**默认 dry-run**，`--apply` 才写库）。
 *
 * 修的是「非 doc 成果恒 draft」这条**存量后果**（病根见方案 §1 基线第 3 行；判据见 `rr_zx_20260930` §C-f）。
 *
 * 病根两截，本轮各修一截，**这次的存量回填只认第二截**：
 *   ① 类型判据硬写 `type = 'doc'` ⇒ `promoteTaskFileDeliverables` 从不提升 `code` 成果（**已修**：改走
 *      集合真源 `typeIn('', FILE_DELIVERABLE_TYPES)`）；
 *   ② 探针尺 `%/_{kw}%` 里的 `_` 在 SQLite LIKE 中是**单字符通配符**而非字面下划线 ⇒ 该式实为
 *      "路径里含 kw"，把 `scripts/verify_push_20260910.py` 这类**正常命名**误判为探针而排除（**已修**：`\_` + `ESCAPE`）。
 *
 * 回填范围（**用户 2026-09-30 裁定**）：只回填 `type='code'` 的 draft 行。
 *   —— 修①+修②后，生产谓词在真库上放行 6 条（5 code + 1 doc）。那条 doc
 *   （`…/.probe_retired_20260918/tickflow-stock-panel/data/backend.log`）是**手工造的隔离目录**里的一枚残留日志，
 *   "隔离目录里的日志算不算成果"是**产品判断**，不是本轮的缺陷范畴 ⇒ **刻意不动**，doc 行一律不碰。
 *   ⇒ 本脚本对 doc 行是**只读**的，并在步5 用"doc 行 status 分布逐字不变"作反证（该不命中标本）。
 *
 * ⚠ 与生产**同尺**：候选谓词不手抄——`docNotProbe`/`typeIn`/`FILE_DELIVERABLE_TYPES` 全部从生产模块取，
 *   提升动作也走生产 `setDeliverableStatus(db, id, 'completed', 'task_completed')`（与 `promoteTaskFileDeliverables` 的 via 一致）。
 *   本脚本只做两处**刻意**的窄化：① 类型窄到 `code`；② 不跑验收打标那一腿（见步5 偏差登记）。
 *
 * ⚠ 全程单事务；备份在事务外先行（`VACUUM INTO` 不能入事务）。
 * ⚠ 桌面端在跑时会持有内存态（调度器/事件总线），故 `--apply` 前自检 Electron 进程，命中即拒绝（与 `run.sh` 同旨）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  docNotProbe,
  typeIn,
  setDeliverableStatus,
} from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
import { FILE_DELIVERABLE_TYPES } from '../apps/worker-ant-desktop/src/main/core/deliverable-types.js';

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data/worker-ant-server.db');
const BAK_PATH = path.join(ROOT, 'data/worker-ant-server.db.bak_zx_20260930_M3f');
const VIA = 'task_completed';
const SOURCE = 'zx_20260930 M3-f 存量回填';

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');

function die(msg: string): never { console.error(`\n✗ ${msg}`); process.exit(1); }
function step(n: number, title: string): void { console.log(`\n── 步${n} ${title}`); }
function eq(a: unknown, b: unknown, label: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) die(`${label}\n  实际：${JSON.stringify(a)}\n  期望：${JSON.stringify(b)}`);
  console.log(`  ✓ ${label} — ${JSON.stringify(a)}`);
}

function electronRunning(): boolean {
  try { return execFileSync('pgrep', ['-f', 'worker-ant-desktop'], { encoding: 'utf-8' }).trim().length > 0; }
  catch { return false; }   // pgrep 无匹配时退出码 1
}

interface Cand {
  id: string; type: string; name: string; file_path: string | null;
  task_id: string; task_title: string | null;
}

/**
 * 与 `promoteTaskFileDeliverables` **同一谓词**（同一批真源函数拼出，非手抄），
 * 只是把 `task_id = ?` 换成"任务状态为 completed"的**全库**扫描，并 JOIN 出任务名供人工核对。
 */
function candidates(db: DatabaseSync): Cand[] {
  const ft = typeIn('d', FILE_DELIVERABLE_TYPES);
  const rows = db.prepare(
    `SELECT d.id, d.type, d.name, d.file_path, d.task_id, t.title AS task_title
       FROM wa_deliverables d JOIN wa_tasks t ON t.id = d.task_id
      WHERE t.status = 'completed' AND d.status = 'draft'
        AND ${ft.sql} AND ${docNotProbe('d')}
      ORDER BY d.type, d.name`,
  ).all(...ft.params) as unknown as Cand[];
  // `deliverable_unfulfilled.forced === true` 是生产里的**红线**（预算强制收尾/产出未达标不提升）。
  // 生产用 `JSON.parse` 后判值——此处同样按值判，不用 `json_extract`（后者遇坏 JSON 会抛，判据就会从"红线"变成"崩溃"）。
  const forced = new Set<string>();
  for (const t of db.prepare("SELECT id, context_json FROM wa_tasks WHERE status = 'completed'").all() as Array<{ id: string; context_json: string | null }>) {
    try {
      const ctx = JSON.parse(t.context_json ?? '{}') as { deliverable_unfulfilled?: { forced?: boolean } };
      if (ctx.deliverable_unfulfilled?.forced === true) forced.add(t.id);
    } catch { /* 坏 JSON 不构成红线（与生产同：解析失败即视为无标记） */ }
  }
  return rows.filter((r) => !forced.has(r.task_id));
}

/** 真库上 doc/code 各状态的分布——用于步5 的"doc 一行没动"反证。 */
function distByType(db: DatabaseSync, type: 'doc' | 'code'): Record<string, number> {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM wa_deliverables WHERE type = ? GROUP BY status ORDER BY status').all(type) as Array<{ status: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

function main(): void {
  console.log(`zx_20260930 M3-f 存量回填 — ${APPLY ? '【APPLY 写库】' : '【dry-run 只读】'}`);
  if (!fs.existsSync(DB_PATH)) die(`库不存在：${DB_PATH}`);

  step(0, '前置自检');
  if (APPLY && electronRunning() && !FORCE) {
    die('桌面端（worker-ant-desktop）正在运行，持有内存态。请退出后重试，或确知风险时加 --force。');
  }
  console.log(APPLY ? '  （未检出桌面端进程）' : '  dry-run 不写库，跳过进程自检');

  step(1, '备份（VACUUM INTO 一致性快照，含 WAL 内容）');
  if (APPLY) {
    if (fs.existsSync(BAK_PATH) && !FORCE) die(`备份已存在，拒绝覆盖：${path.relative(ROOT, BAK_PATH)}（确认无需保留后移走，或加 --force）`);
    if (fs.existsSync(BAK_PATH)) console.log(`  ! --force 覆盖既有备份`);
    const b = new DatabaseSync(DB_PATH);
    try { b.exec(`VACUUM INTO '${BAK_PATH.replace(/'/g, "''")}'`); } finally { b.close(); }
    console.log(`  ✓ ${path.relative(ROOT, BAK_PATH)}（${(fs.statSync(BAK_PATH).size / 1048576).toFixed(1)} MB）`);
  } else {
    console.log(`  将写入：${path.relative(ROOT, BAK_PATH)}`);
  }

  step(2, '候选集（生产同谓词，全库 completed 任务下的 draft 文件型成果）');
  const db = new DatabaseSync(DB_PATH);
  let done = false;
  try {
    const all = candidates(db);
    const code = all.filter((r) => r.type === 'code');
    const doc = all.filter((r) => r.type === 'doc');
    const byStatus = (s: string) => db.prepare('SELECT COUNT(*) AS n FROM wa_deliverables WHERE status = ?').get(s) as { n: number };
    console.log(`  候选 ${all.length} 条（code ${code.length} / doc ${doc.length}）`);
    for (const r of all) console.log(`    [${r.type}] ${r.name}  ← 任务《${r.task_title ?? '(无题)'}》  ${r.file_path ?? ''}`);
    console.log(`  修前 draft 总数：${byStatus('draft').n}`);

    step(3, '范围断言：本脚本只动 code（doc 行一律不碰）');
    // 「该命中 / 该不命中」两只标本同试：code 必须非空（否则下面的"提升"是空转），
    // 且施加动作的集合**恰**等于 code 集合 ⇒ 任何 doc 都不可能被本脚本写。
    if (code.length === 0) die('code 候选为 0 —— 要么已回填过，要么病根未修（本脚本无事可做，如实退出）');
    const target = code.map((r) => r.id).sort();
    eq(target.length, code.length, `施加集合 = code 候选（${code.length} 条），不含任何 doc`);
    console.log(`  反证（该不命中）：${doc.length} 条 doc 留在 draft，本脚本只读——${doc.map((r) => r.name).join(' / ') || '(无)'}`);

    const docDistBefore = distByType(db, 'doc');

    step(4, APPLY ? '施加：draft → completed（走生产 setDeliverableStatus）' : '干跑：将施加的变更（未写库）');
    let promoted = 0;
    if (APPLY) db.exec('BEGIN');
    try {
      for (const r of code) {
        if (!APPLY) { console.log(`    将 ${r.name} → completed`); promoted++; continue; }
        const res = setDeliverableStatus(db as never, r.id, 'completed', VIA);
        if (!res.changed) die(`行 ${r.id}（${r.name}）未发生状态变更（expected: draft → completed）`);
        promoted++;
        console.log(`    ✓ ${r.name} → completed（事件已发，via=${VIA}）`);
      }
      if (APPLY) db.exec('COMMIT');
      done = true;
    } catch (e) {
      if (APPLY) { try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ } }
      throw e;
    }

    step(5, '复跑不变量与反证');
    eq(promoted, code.length, `本次提升行数 == code 候选数（${SOURCE}）`);
    const after = candidates(db).filter((r) => r.type === 'code').length;
    // 两态各钉各的（不是"恒真"判据）：写库后必须**由 N 变 0**；dry-run 必须**仍是 N**（否则说明它偷偷写了库）。
    eq(after, APPLY ? 0 : code.length,
      APPLY ? `做完后同谓词下 code draft 残留 = 0（正面：${code.length} → 0）` : `dry-run 只读自证：code draft 仍为 ${code.length}（未写库）`);
    eq(distByType(db, 'doc'), docDistBefore, '反证（该不命中）：doc 行的 status 分布**逐字未变**（一条都没动）');
    const byStatus2 = (s: string) => db.prepare('SELECT COUNT(*) AS n FROM wa_deliverables WHERE status = ?').get(s) as { n: number };
    console.log(`  修后 draft 总数：${byStatus2('draft').n}${APPLY ? '' : '（dry-run，未变）'}`);
    console.log(APPLY ? '\n✅ 回填完成。' : '\n✅ dry-run 通过（加 --apply 才写库）。');
  } finally {
    if (!done && APPLY) { try { db.exec('ROLLBACK'); } catch { /* noop */ } }
    db.close();
  }
}

main();
