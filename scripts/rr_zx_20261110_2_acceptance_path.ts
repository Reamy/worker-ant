/**
 * zx_20261110_2 B6 复跑 —— 「核得清」：判据路径的来源阶梯、验收账的显式证据、"无产出 ≠ 无工作"。
 *
 * 病根：
 *   · 事故 `68c0a607`——判据点名的文件**确实存在**，只是登记在父任务名下（工程级查重把行留在别的任务上）
 *     ⇒ 旧实现只认"本任务产出物 + 工作目录"，判据被记 `criteria_path_missing`，整个任务按"判据缺陷"暂停；
 *   · `score<20` 分支把"账上没产出物"直接当"什么都没做"：87 步、真改了一批文件的任务被记 `failed`。
 *
 * 判据（与方案 §B6 对齐）：
 *   P-1 本任务已登记且盘上存在 ⇒ `own`；登记了但盘上已没 ⇒ **不**算解析成功（陈旧登记不得洗成"可核"）；
 *   P-2 工作目录基底**先于**跨任务：同一引用两处都在时，来源是 `working_dir`（先近后远）；
 *   P-3 只有父/兄弟任务登记（本任务与基底都无）⇒ `project_deliverable:<taskId>`，并给本任务成果打上
 *       `acceptance_verified=1` + `verified_via='criteria:<ref>'`；**父任务自己那行不动**；
 *   P-4 真不存在 ⇒ 仍 `criteria_path_missing`（`missing` 非空）；
 *   P-5 两个同名后缀 ⇒ `ambiguous`，不解析（不猜一个名字给判卷模型）；
 *   P-6 retired / 探针行不被回写；任务级验收未核 ⇒ 拒绝写（`skipped='not_verified'`）；
 *   G-1 87 步 + 有改动 + 无产出物 ⇒ `pause_changed`（不是失败）；无改动 ⇒ `fail_no_output`；
 *       取不到证据 ⇒ `fail_no_output` 且**明说**未取得（不把"不知道"说成"没动"）；
 *   G-2 静态接线：执行体该分支先取证据再决定、暂停因由在册、载荷带 `ambiguous_paths`/`criteria_path_resolved`、
 *       DDL 有 `verified_via`。
 *
 * 纪律：真源直 import（`resolveCriteriaPaths` / `markTaskVerifiedVia` / `output-change-evidence` 本尊）；
 *       文案不含失败字形；无"只本轮为真"的字面量（轮次由 `path.basename(__filename)` 派生方向性比较）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines, buildNotOlderThan } from './lib/rr-pins.js';
import { resolveCriteriaPaths } from '../apps/worker-ant-desktop/src/main/core/acceptance-paths.js';
import { markTaskVerifiedVia } from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
import {
  classifyChangeEvidence, decideNoOutputDisposition, collectChangeEvidence,
  CHANGE_EVIDENCE_LIST_LIMIT, NO_OUTPUT_CHANGE_MIN_STEPS,
} from '../apps/worker-ant-desktop/src/main/core/output-change-evidence.js';
import { PAUSE_REASON_LABEL } from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';

type AnyDb = import('better-sqlite3').Database;

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const SELF_ROUND = /^(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''))?.[1] ?? '';
const A = 'apps/worker-ant-desktop';
const CODE = (rel: string) => stripKeepingLines(fs.readFileSync(path.join(root, rel), 'utf-8')).join('\n');

const SCHEMA = `
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT DEFAULT 'active',
  working_dir TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', priority INTEGER DEFAULT 0,
  depends_on TEXT DEFAULT '', parent_task_id TEXT '', source TEXT DEFAULT 'user',
  acceptance_criteria TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT,
  type TEXT NOT NULL, name TEXT DEFAULT '', description TEXT DEFAULT '', file_path TEXT,
  registry_id TEXT, status TEXT DEFAULT 'draft',
  acceptance_verified INTEGER DEFAULT 0, verified_via TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
`;

function mkdb(): AnyDb {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare("INSERT INTO wa_projects (id, name) VALUES ('p1', '项目')").run();
  return db as unknown as AnyDb;
}
function addTask(db: AnyDb, id: string, contextJson = '{}', status = 'executing'): void {
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'p1', `任务 ${id}`, status, contextJson);
}
function addDeliv(db: AnyDb, id: string, taskId: string, filePath: string, extra: { status?: string; verified?: number } = {}): void {
  db.prepare(`INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path, status, acceptance_verified)
              VALUES (?, 'p1', ?, 'doc', ?, ?, ?, ?)`)
    .run(id, taskId, path.basename(filePath), filePath, extra.status ?? 'extracted', extra.verified ?? 0);
}
function delivOf(db: AnyDb, id: string): { acceptance_verified: number | null; verified_via: string | null } {
  return db.prepare('SELECT acceptance_verified, verified_via FROM wa_deliverables WHERE id = ?').get(id) as
    { acceptance_verified: number | null; verified_via: string | null };
}
const exists = (p: string): boolean => { try { return fs.existsSync(p); } catch { return false; } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-acc-path-'));
const WD = path.join(TMP, 'wd');
const OUT = path.join(TMP, 'shared');
function touch(rel: string): string {
  const abs = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'x');
  return abs;
}

async function main(): Promise<void> {
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  {
    const src = CODE(`${A}/src/main/core/agent-executor.ts`);
    const tag = /build:\s*'(zx_[0-9_]+)'/.exec(src)?.[1] ?? '';
    ok(!!tag && buildNotOlderThan(tag, SELF_ROUND), 'K-7 当前 build 快照不早于本脚本轮次（方向性比较）', `${tag} vs ${SELF_ROUND}`);
  }

  fs.mkdirSync(WD, { recursive: true });
  touch('wd/src/own.ts');
  const parentDoc = touch('shared/notes/api-spec.md');
  const dupA = touch('shared/a/fee/x.vue');
  const dupB = touch('shared/b/fee/x.vue');
  const baseHit = touch('wd/docs/guide.md');

  // ═══ P-1｜own 命中；陈旧登记不算解析成功 ═══════════════════════════════
  console.log('\n【P-1】本任务已登记 + 盘上存在 ⇒ `own`；登记了但盘上没有 ⇒ 不算解析成功');
  {
    const r = resolveCriteriaPaths({
      refs: ['src/own.ts', 'src/ghost.ts'],
      ownDeliverables: [
        { taskId: 'c1', path: path.join(WD, 'src/own.ts') },
        { taskId: 'c1', path: path.join(WD, 'src/ghost.ts') }, // 盘上不存在
      ],
      projectDeliverables: [],
      bases: [WD],
      exists,
    });
    eq(r.results[0]?.resolved_from, 'own', 'P-1a 已登记且存在 ⇒ 来源 `own`');
    eq(r.results[1]?.resolved, false, 'P-1b 登记了但盘上没有 ⇒ **不**算解析成功（陈旧登记不得洗成可核）');
    eq(r.missing, ['src/ghost.ts'], 'P-1c 未解析逐条进 `missing`');
  }

  // ═══ P-2｜工作目录先于跨任务 ═════════════════════════════════════════
  console.log('\n【P-2】工作目录基底**先于**跨任务：先近后远');
  {
    const r = resolveCriteriaPaths({
      refs: ['docs/guide.md'],
      ownDeliverables: [],
      projectDeliverables: [{ taskId: 'parent', path: path.join(TMP, 'elsewhere/docs/guide.md') }],
      bases: [WD],
      exists,
    });
    eq(r.results[0]?.resolved_from, 'working_dir', 'P-2a 基底命中 ⇒ `working_dir`（不被更远的登记抢走）');
    eq(r.results[0]?.resolved_as, baseHit, 'P-2b `resolved_as` 即盘上那份文件');
    eq(r.crossTask.length, 0, 'P-2c 未发生跨任务解析');
  }

  // ═══ P-3｜父/兄弟登记 ⇒ project_deliverable:<taskId> ═════════════════
  console.log('\n【P-3】父任务登记、本任务与基底都无 ⇒ `project_deliverable:<parent>`');
  {
    const r = resolveCriteriaPaths({
      refs: ['notes/api-spec.md'],
      ownDeliverables: [],
      projectDeliverables: [{ taskId: 'parent', path: parentDoc }],
      bases: [WD],
      exists,
    });
    eq(r.results[0]?.resolved_from, 'project_deliverable:parent', 'P-3a 来源记作 `project_deliverable:<taskId>`');
    eq(r.results[0]?.resolved_as, parentDoc, 'P-3b `resolved_as` 是父任务登记的那份文件');
    eq(r.missing, [], 'P-3c 解析成功 ⇒ 不再进 `missing`（不会误判 `criteria_path_missing`）');
    eq(r.crossTask.length, 1, 'P-3d 跨任务解析单独成账（供回写）');
  }

  // ═══ P-4｜真不存在 ═════════════════════════════════════════════════
  console.log('\n【P-4】阶梯走完仍无命中 ⇒ 仍 `criteria_path_missing`');
  {
    const r = resolveCriteriaPaths({
      refs: ['missing/thing.ts'],
      ownDeliverables: [],
      projectDeliverables: [{ taskId: 'parent', path: parentDoc }],
      bases: [WD],
      exists,
    });
    eq(r.results[0]?.resolved, false, 'P-4a 无法解析');
    eq(r.missing, ['missing/thing.ts'], 'P-4b 仍记缺（不因"走过阶梯"就放行）');
    eq(r.ambiguous, [], 'P-4c 这不是歧义，是"确实没有"');
  }

  // ═══ P-5｜同名后缀两处 ⇒ 歧义不猜 ═══════════════════════════════════
  console.log('\n【P-5】两个同名后缀 ⇒ `ambiguous`，不解析');
  {
    const r = resolveCriteriaPaths({
      refs: ['fee/x.vue'],
      ownDeliverables: [],
      projectDeliverables: [
        { taskId: 'sib-a', path: dupA },
        { taskId: 'sib-b', path: dupB },
      ],
      bases: [WD],
      exists,
    });
    eq(r.results[0]?.resolved, false, 'P-5a 多命中 ⇒ 不解析（不猜一个名字给判卷模型）');
    eq(r.ambiguous, ['fee/x.vue'], 'P-5b 单独记 `ambiguous`（与"真不存在"分得开）');
    ok((r.results[0]?.ambiguous?.length ?? 0) === 2, 'P-5c 两个候选都在账上', `${r.results[0]?.ambiguous?.length}`);

    // 唯一后缀则解析（不是"只要多段就歧义"）。
    const one = resolveCriteriaPaths({
      refs: ['notes/api-spec.md'], ownDeliverables: [],
      projectDeliverables: [{ taskId: 'parent', path: parentDoc }, { taskId: 'sib', path: dupA }],
      bases: [WD], exists,
    });
    eq(one.results[0]?.resolved_from, 'project_deliverable:parent', 'P-5d 唯一后缀仍解析（歧义只对真多命中生效）');
  }

  // ═══ 快照档 ═══════════════════════════════════════════════════════
  console.log('\n【P-5e】快照清单唯一后缀命中 ⇒ `working_dir`');
  {
    const r = resolveCriteriaPaths({
      refs: ['deep/snap.md'], ownDeliverables: [], projectDeliverables: [], bases: [WD],
      snapshotPaths: [path.join(WD, 'deep/snap.md')], exists: () => false,
    });
    eq(r.results[0]?.resolved_from, 'working_dir', 'P-5e 快照唯一命中记 `working_dir`');
    const two = resolveCriteriaPaths({
      refs: ['snap.md'], ownDeliverables: [], projectDeliverables: [], bases: [WD],
      snapshotPaths: [path.join(WD, 'a/snap.md'), path.join(WD, 'b/snap.md')], exists: () => false,
    });
    eq(two.ambiguous, ['snap.md'], 'P-5f 快照里两处同名 ⇒ 仍不猜');
  }

  // ═══ P-6｜回写：只动本任务、只动未验的 doc、要任务级已核 ══════════
  console.log('\n【P-6】子任务成果按 `criteria:<ref>` 打标——只动自己那行，retired/探针不动');
  {
    const db = mkdb();
    addTask(db, 'child', JSON.stringify({ acceptance_check: { verified: true, checked_at: '2026-11-11T00:00:00Z', passed: 1, total: 1, failed: [] } }));
    addTask(db, 'parent', '{}');
    addDeliv(db, 'd-child', 'child', path.join(WD, 'src/own.ts'));
    addDeliv(db, 'd-parent', 'parent', parentDoc);
    addDeliv(db, 'd-retired', 'child', path.join(WD, 'src/old.ts'), { status: 'retired' });
    addDeliv(db, 'd-probe', 'child', path.join(WD, 'src/_probe.md'));

    const before = db.prepare("SELECT COUNT(*) AS n FROM wa_deliverables WHERE acceptance_verified = 1").get() as { n: number };
    eq(before.n, 0, 'P-6a 起点：已验行 0（计数器正面断言的起点）');

    const res = markTaskVerifiedVia(db, 'child', [{ ref: 'notes/api-spec.md', resolvedFrom: 'project_deliverable:parent' }]);
    eq(res.changed, 1, 'P-6b 只动了本任务那 1 行（0→1 的正面断言）');
    eq(delivOf(db, 'd-child'), { acceptance_verified: 1, verified_via: 'criteria:notes/api-spec.md' }, 'P-6c 本任务成果：打标 + 留证');
    eq(delivOf(db, 'd-parent').acceptance_verified, 0, 'P-6d **父任务自己那行不动**（不跨任务乱标）');
    eq(delivOf(db, 'd-retired').acceptance_verified, 0, 'P-6e retired 行不动');
    eq(delivOf(db, 'd-probe').acceptance_verified, 0, 'P-6f 探针行不动');
    const after = db.prepare("SELECT COUNT(*) AS n FROM wa_deliverables WHERE acceptance_verified = 1").get() as { n: number };
    eq(after.n, 1, 'P-6g 全表已验行恰为 1（没有顺手多标）');

    // 幂等：再跑一次不重复改。
    eq(markTaskVerifiedVia(db, 'child', [{ ref: 'notes/api-spec.md', resolvedFrom: 'project_deliverable:parent' }]).changed, 0,
      'P-6h 二次调用不再改（已验行不再重打）');

    // 无跨任务证据 ⇒ 不写。
    eq(markTaskVerifiedVia(db, 'child', [{ ref: 'docs/guide.md', resolvedFrom: 'working_dir' }]).skipped, 'no_evidence',
      'P-6i 只有 `working_dir` 证据 ⇒ 拒绝写（本因由只认跨任务回指）');

    // 任务级验收未核 ⇒ 拒绝写（"没核成的账不得盖章"）。
    addTask(db, 'unverified', '{}');
    addDeliv(db, 'd-unv', 'unverified', path.join(WD, 'src/own.ts'));
    eq(markTaskVerifiedVia(db, 'unverified', [{ ref: 'notes/api-spec.md', resolvedFrom: 'project_deliverable:parent' }]).skipped,
      'not_verified', 'P-6j 任务级验收未核 ⇒ `not_verified`（不凭空打标）');
    eq(delivOf(db, 'd-unv').acceptance_verified, 0, 'P-6k 未核任务成果保持未验');
    db.close();
  }

  // ═══ G-1｜无产出 ≠ 无工作 ═════════════════════════════════════════
  console.log('\n【G-1】`score<20`：有改动且步数够 ⇒ 暂停待补登记；无改动/取不到 ⇒ 维持失败');
  {
    const since = 1_000_000;
    const scan = {
      root: WD,
      files: [
        { abs: path.join(WD, 'src/a.ts'), rel: 'src/a.ts', size: 1, mtimeMs: since + 5 },
        { abs: path.join(WD, 'src/b.ts'), rel: 'src/b.ts', size: 1, mtimeMs: since + 3 },
        { abs: path.join(WD, 'old.ts'), rel: 'old.ts', size: 1, mtimeMs: since - 50_000 },
      ],
    };
    const changed = classifyChangeEvidence(scan, since, 4);
    eq(changed.kind, 'changed', 'G-1a 有 mtime ≥ 起点 ⇒ `changed`');
    eq(changed.total, 2, 'G-1b 只数本轮的（旧文件不算）');
    eq(changed.files, ['src/a.ts', 'src/b.ts'], 'G-1c 按 mtime 新→旧、相对工作目录');

    const d1 = decideNoOutputDisposition(changed, { steps: 87 });
    eq(d1.action, 'pause_changed', 'G-1d 87 步 + 有改动 + 无产出物 ⇒ **暂停**（不是失败）');
    ok(d1.note.includes('2 个文件') && d1.note.includes('补登记'), 'G-1e 附注说清"改了几个文件、请补登记"', d1.note);

    const few = decideNoOutputDisposition(changed, { steps: NO_OUTPUT_CHANGE_MIN_STEPS - 1 });
    eq(few.action, 'fail_no_output', 'G-1f 步数不够 ⇒ 维持失败（几步就跑完的不算"做了一半"）');

    const unchanged = classifyChangeEvidence({ root: WD, files: [{ abs: path.join(WD, 'old.ts'), rel: 'old.ts', size: 1, mtimeMs: since - 1 }] }, since, 5);
    eq(unchanged.kind, 'none', 'G-1g 全早于起点 ⇒ `none`');
    const d2 = decideNoOutputDisposition(unchanged, { steps: 87 });
    eq(d2.action, 'fail_no_output', 'G-1h 无改动 ⇒ 维持 failed');
    ok(d2.note.includes('5 次写调用'), 'G-1i `none` 且记到写调用 ⇒ 明说"盘上无对应落盘"', d2.note);

    const unavailable = await collectChangeEvidence({ workingDir: '', sinceMs: since, writeCalls: 2 });
    eq(unavailable.kind, 'unavailable', 'G-1j 工作目录为空 ⇒ `unavailable`（不冒充"没改动"）');
    const d3 = decideNoOutputDisposition(unavailable, { steps: 87 });
    eq(d3.action, 'fail_no_output', 'G-1k 取不到证据 ⇒ 维持 failed');
    ok(d3.note.includes('未能取得改动证据'), 'G-1l 但附注**明说**未取得（不把"不知道"说成"没动"）', d3.note);

    eq(classifyChangeEvidence(null, since, 0).kind, 'unavailable', 'G-1m 扫描失败（`null`）不得退化成 `none`');
    eq(CHANGE_EVIDENCE_LIST_LIMIT <= 20, true, 'G-1n 列表上限有界（不把整棵树塞进账）');
  }

  // ═══ G-2｜静态接线 ═════════════════════════════════════════════════
  console.log('\n【G-2】静态接线：证据先于判定、因由在册、载荷与 DDL 同步');
  {
    const src = CODE(`${A}/src/main/core/agent-executor.ts`);
    const iBlock = src.indexOf('if (qualityScore.score < 20)');
    const iFail = src.indexOf('markTaskFailed(db, taskId)', iBlock);
    const block = iBlock >= 0 && iFail > iBlock ? src.slice(iBlock, iFail + 30) : '';
    ok(iBlock >= 0, 'G-2a `score<20` 分支定位在册');
    ok(block.includes('collectChangeEvidence(') && /reason: PAUSE_REASON_OUTPUT_INSUFFICIENT_BUT_CHANGED/.test(block),
      'G-2b 该分支内证据 → 暂停因由，且暂停支 `return` 早于 `markTaskFailed`（顺序即语义）',
      `block=${block.length}B`);
    ok(src.includes('decideNoOutputDisposition('), 'G-2c 去向由纯函数决定（rr 可直测）');
    ok(/extraContext[\s\S]{0,200}change_evidence/.test(src), 'G-2d 改动证据随暂停落账（事后可复核）');

    const pr = CODE(`${A}/src/main/core/pause-reason.ts`);
    ok(/PAUSE_REASON_OUTPUT_INSUFFICIENT_BUT_CHANGED\s*=\s*'output_insufficient_but_changed'/.test(pr), 'G-2e 因由码字面量在册');
    ok(typeof PAUSE_REASON_LABEL['output_insufficient_but_changed'] === 'string'
      && PAUSE_REASON_LABEL['output_insufficient_but_changed'].length > 0, 'G-2f 因由人有话可读（词表一处）');
    ok(/PAUSE_REASON_OUTPUT_INSUFFICIENT_BUT_CHANGED;/.test(pr), 'G-2g 取值域收录（无因暂停在类型层不可表达）');

    const acc = CODE(`${A}/src/main/core/acceptance-check.ts`);
    ok(acc.includes('ambiguous_paths'), 'G-2h 载荷带 `ambiguous_paths`');
    ok(acc.includes('criteria_path_resolved'), 'G-2i 载荷带 `criteria_path_resolved`（解析来源留证）');

    const ex = CODE(`${A}/src/main/core/exec-acceptance.ts`);
    ok(ex.includes('resolveCriteriaPaths('), 'G-2j 判卷前走来源阶梯');
    ok(/criteriaPathMissing: missing, ambiguousPaths: ambiguous, criteriaPathResolved: pathResolved/.test(ex),
      'G-2k 三种结局一并入账（缺/歧义/已解析）');
    ok(ex.includes('markTaskVerifiedVia(db, taskId'), 'G-2l 真通过后按跨任务证据回写本任务成果');
    ok(/payload\.verified === true && decided\.outcome\.ran && decided\.outcome\.passed/.test(ex),
      'G-2m 只在"真通过"上回写（未核/未过不得盖章）');

    const ddl = CODE(`${A}/src/main/database.ts`);
    ok(/ALTER TABLE wa_deliverables ADD COLUMN verified_via TEXT/.test(ddl), 'G-2n DDL 有 `verified_via`（可空，try 包裹）');
    const dl = CODE(`${A}/src/main/core/deliverable-lifecycle.ts`);
    ok(dl.includes('export function markTaskVerifiedVia'), 'G-2o 回写入口唯一（`markTaskVerifiedVia`）');
    ok(/markTaskVerifiedVia[\s\S]{0,900}markVerifiedWhere\(db, 'task_id = \?', \[taskId\]/.test(dl),
      'G-2p 回写走同一 `markVerifiedWhere`（验收打标仍只有一处 UPDATE）');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
