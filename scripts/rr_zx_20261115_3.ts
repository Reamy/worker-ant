/**
 * zx_20261115_3「归·传·简」——产出物归属/贡献两本账、项目详情里程碑口径、后续批次回归。
 *
 * 分组：
 *   S「钉」构建钉与本轮方案在册（派生，不写"只为下一轮"的字面量）。
 *   A「尺」isProbePath（JS）与 docNotProbe（SQL）同一批标本对拍。
 *   B「账」listTaskArtifacts：归属 ∪ 贡献、跨归属不夺、探针不计、已删如实。
 *   C「补」planClaimRegistrations / registerClaimedArtifacts：有界、幂等、skip 理由。
 *   D「回」readDeliveredOutputs 含贡献账；回执核对在 outputs≥1 时可 verified。
 *   E「详」detectMilestones 不再笛卡尔积：口径真值 + 空项目空态。
 *
 * 纪律：零网络 / 零墙钟依赖；夹具按生产初始化顺序（先建表再插行）；断言文案不含失败字形。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, deriveBuildTag } from './lib/rr-pins.js';
import { isProbePath, docNotProbe } from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
import {
  ARTIFACT_BACKFILL_LIMIT,
  listTaskArtifacts,
  planClaimRegistrations,
  registerClaimedArtifacts,
} from '../apps/worker-ant-desktop/src/main/core/task-artifacts.js';
import { readDeliveredOutputs } from '../apps/worker-ant-desktop/src/main/core/task-outcome.js';
import { verifyRemoteReceipt } from '../apps/worker-ant-desktop/src/main/core/node-receipt.js';
import { detectMilestones } from '../apps/worker-ant-desktop/src/main/core/project-analytics.js';
import { defaultPositionForProject } from '../apps/worker-ant-desktop/src/main/core/positions.js';
import { BOOL_SETTING_KEYS } from '../apps/worker-ant-desktop/src/main/core/settings-bool.js';
import { suggestDomainPacksForTask } from '../apps/worker-ant-desktop/src/main/core/domain-pack-suggest.js';
import { buildContextLedgerView } from '../apps/worker-ant-desktop/src/main/core/context-ledger-view.js';
import {
  availableToolNames,
  narrowToolFace,
  buildToolFaceBrief,
  TOOL_FACE_BRIEF_REMOVED_MAX,
  type TaskArchetype,
} from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';
import { toolRegistry } from '../apps/worker-ant-desktop/src/main/core/tool-registry.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const selfRound = path.basename(__filename, '.ts').replace(/^rr_/, '');
const readSrc = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');

const SCHEMA = `
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT DEFAULT '', status TEXT DEFAULT 'active',
  context_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, parent_task_id TEXT DEFAULT '', title TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0, acceptance_criteria TEXT DEFAULT '',
  depends_on TEXT DEFAULT '', context_json TEXT DEFAULT '{}', position_id TEXT DEFAULT '', source TEXT DEFAULT 'user',
  quality_score REAL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_files (task_id TEXT NOT NULL, path TEXT NOT NULL, via TEXT DEFAULT '',
  first_at TEXT DEFAULT (datetime('now')), last_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (task_id, path));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL DEFAULT 'doc',
  name TEXT DEFAULT '', description TEXT DEFAULT '', file_path TEXT, status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  is_primary INTEGER DEFAULT 0, acceptance_verified INTEGER DEFAULT 0, verified_via TEXT);
CREATE TABLE wa_event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, aggregate_type TEXT, aggregate_id TEXT,
  event_type TEXT, payload TEXT, occurred_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_knowledge_triples (id TEXT PRIMARY KEY, project_id TEXT, subject TEXT, predicate TEXT, object TEXT);
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_positions (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT DEFAULT 'custom', description TEXT DEFAULT '',
  skills_json TEXT, rules_json TEXT, knowledge_json TEXT, tools_json TEXT, mcp_json TEXT, sandbox_scope TEXT DEFAULT '',
  participate INTEGER DEFAULT 1, enabled INTEGER DEFAULT 1, builtin INTEGER DEFAULT 0, version INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_project_positions (project_id TEXT NOT NULL, position_id TEXT NOT NULL, enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, position_id));
CREATE TABLE wa_domain_packs (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', pack_json TEXT NOT NULL,
  source_project_id TEXT, source_project_name TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')), origin TEXT NOT NULL DEFAULT 'user', dismissed_at TEXT);
CREATE TABLE wa_project_domain_packs (project_id TEXT NOT NULL, pack_id TEXT NOT NULL,
  applied_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, pack_id));
`;

type AnyDb = import('better-sqlite3').Database;

function fixture(): AnyDb {
  const d = new DatabaseSync(':memory:') as unknown as AnyDb;
  d.exec(SCHEMA);
  d.prepare("INSERT INTO wa_projects (id, name) VALUES ('P-1', '测试项目')").run();
  d.prepare("INSERT INTO wa_tasks (id, project_id, title, status) VALUES ('T-A', 'P-1', 'A', 'completed')").run();
  d.prepare("INSERT INTO wa_tasks (id, project_id, title, status) VALUES ('T-B', 'P-1', 'B', 'completed')").run();
  return d;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-rr-artifacts-'));
function touch(name: string): string {
  const p = path.join(tmp, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `# ${name}\n`);
  return p;
}
function insertDeliv(db: AnyDb, o: { id: string; taskId: string | null; filePath: string | null; status?: string; type?: string }): void {
  db.prepare('INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(o.id, 'P-1', o.taskId, o.type ?? 'doc', path.basename(o.filePath ?? o.id), o.filePath, o.status ?? 'completed');
}
function claim(db: AnyDb, taskId: string, p: string, via = 'write_file'): void {
  db.prepare('INSERT OR REPLACE INTO wa_task_files (task_id, path, via) VALUES (?, ?, ?)').run(taskId, p, via);
}

/* ── S：构建钉与方案在册 ─────────────────────────────────────────────────── */

function sectionS(): void {
  console.log('\n【S】构建钉与本轮方案');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  const plan = readSrc(`plans/improve/${selfRound}.md`);
  ok(plan.includes(selfRound), 'S1 本轮方案在册且带轮次名');
  ok(plan.includes('task-artifacts') || plan.includes('归属·贡献'), 'S2 方案记下归属/贡献两本账');
  ok(plan.includes('isProbePath') || plan.includes('同一批标本对拍'), 'S3 方案记下探针两尺对拍');
  ok(plan.includes('detectMilestones') && plan.includes('笛卡尔积'), 'S4 方案记下项目详情笛卡尔积修复');
  const { tag } = deriveBuildTag(readSrc(`${A}/src/main/core/agent-executor.ts`));
  ok(tag >= selfRound, 'S5 构建钉不早于本脚本轮次', `${tag} >= ${selfRound}`);
  ok(plan.includes('两物理机') && (plan.includes('不宣称') || plan.includes('未验')),
    'S6 诚实边界：两物理机未验如实登记');
}

/* ── A：探针两尺对拍 ─────────────────────────────────────────────────────── */

const PROBE_SPECIMENS: Array<{ p: string; probe: boolean; note: string }> = [
  { p: '/a/b/report.md', probe: false, note: '正常文档' },
  { p: '/a/_probe_x.py', probe: true, note: '_ 段 + probe' },
  { p: '/a/0_probe.md', probe: true, note: '1 位数字前缀' },
  { p: '/a/00_probe2.md', probe: true, note: '2 位数字前缀' },
  { p: '/a/12_verify.md', probe: true, note: '2 位数字 + verify' },
  { p: '/a/1_tmp.log', probe: true, note: '1 位数字 + tmp' },
  { p: '/a/verify_push_20260910.py', probe: false, note: '无 /_ 与数字前缀（旧偏宽尺误伤）' },
  { p: '/a/2026_verify_report.md', probe: false, note: '四位日期前缀刻意不认' },
  { p: '/a/_f20_probe.py', probe: true, note: '_f20_probe' },
  { p: '/a/b/_x/verify.txt', probe: true, note: '% 可跨 /（镜像 SQL 偏宽）' },
  { p: '/a/_probe_x.PY', probe: true, note: 'LIKE 大小写不敏感' },
  { p: '/a/0_PROBE.md', probe: false, note: 'GLOB 大小写敏感（数字形态不认大写）' },
  { p: '/a/foo_probe.md', probe: false, note: '无 /_ 锚点' },
  { p: '', probe: false, note: '空串' },
];

function sectionA(): void {
  console.log('\n【A】探针两尺：isProbePath(JS) 与 docNotProbe(SQL)');
  const db = new DatabaseSync(':memory:') as unknown as AnyDb;
  db.exec('CREATE TABLE t (file_path TEXT, name TEXT)');
  const ins = db.prepare('INSERT INTO t (file_path, name) VALUES (?, NULL)');
  for (const s of PROBE_SPECIMENS) ins.run(s.p);
  // docNotProbe 为真 = 非探针；故"是探针" = WHERE NOT (docNotProbe)
  const sqlProbes = new Set(
    (db.prepare(`SELECT file_path AS p FROM t WHERE NOT ${docNotProbe('')}`).all() as Array<{ p: string }>).map((r) => r.p),
  );
  for (const s of PROBE_SPECIMENS) {
    const sql = sqlProbes.has(s.p);
    const js = isProbePath(s.p);
    eq(js, s.probe, `A-${PROBE_SPECIMENS.indexOf(s) + 1} JS 判据：${s.note}`);
    ok(js === sql, `A-${PROBE_SPECIMENS.indexOf(s) + 1}p 两尺同判：${JSON.stringify(s.p)}（JS=${js} SQL=${sql}）`);
  }
  db.close();
  ok(isProbePath('/a/_probe_x.py') === true && isProbePath('/a/report.md') === false, 'A-15 两只反向标本（有/无）');
}

/* ── B：归属 ∪ 贡献 ──────────────────────────────────────────────────────── */

function sectionB(): void {
  console.log('\n【B】listTaskArtifacts：归属 ∪ 贡献');
  const db = fixture();
  const fA = touch('shared/report.md');
  const fB = touch('onlyB/notes.md');
  const fProbe = touch('tmp/_probe_scratch.py');
  const fGone = path.join(tmp, 'gone/missing.md');
  insertDeliv(db, { id: 'D-A', taskId: 'T-A', filePath: fA });
  claim(db, 'T-B', fA);      // B 写过 A 归属的文件
  claim(db, 'T-B', fB);      // B 写、无归属
  claim(db, 'T-B', fProbe);  // 探针：不计
  claim(db, 'T-B', fGone);   // 盘上已删

  const aofA = listTaskArtifacts(db, { taskIds: ['T-A'], projectId: 'P-1' });
  eq(aofA.length, 1, 'B1 A 名下 1 条（归属）');
  eq([aofA[0]!.claimed, aofA[0]!.ownerTaskId, aofA[0]!.claimedByTaskId], [false, 'T-A', null], 'B2 归属行不带贡献者');

  const aofB = listTaskArtifacts(db, { taskIds: ['T-B'], projectId: 'P-1', includeMissing: true });
  const shared = aofB.find((x) => x.path === fA);
  ok(!!shared, 'B3 B 的账里有"写过的共享文件"', JSON.stringify(aofB.map((x) => path.basename(x.path ?? ''))));
  eq([shared?.claimed, shared?.ownerTaskId, shared?.claimedByTaskId, shared?.deliverableId], [true, 'T-A', 'T-B', 'D-A'],
    'B4 跨归属：归属者仍是 A，贡献者是 B（不夺归属）');
  const ownB = aofB.find((x) => x.path === fB);
  eq([ownB?.claimed, ownB?.ownerTaskId, ownB?.deliverableId, ownB?.status], [true, null, null, 'written'],
    'B5 无归属的写作账：claimed 且 owner 为空，状态如实 written');
  ok(!aofB.some((x) => x.path === fProbe), 'B6 探针命名不计（宁少不多）');
  const gone = aofB.find((x) => x.path === fGone);
  eq([!!gone, gone?.exists], [true, false], 'B7 已删文件：详情仍列出且标 exists=false');
  const aofBNoMissing = listTaskArtifacts(db, { taskIds: ['T-B'], projectId: 'P-1', includeMissing: false });
  ok(!aofBNoMissing.some((x) => x.path === fGone), 'B8 includeMissing=false：回执口径不含已删文件');

  // 退休归属不列
  insertDeliv(db, { id: 'D-R', taskId: 'T-A', filePath: touch('shared/retired.md'), status: 'retired' });
  ok(!listTaskArtifacts(db, { taskIds: ['T-A'], projectId: 'P-1' }).some((x) => x.deliverableId === 'D-R'),
    'B9 retired 归属不列（与 deliverableScopeSql 同尺）');
  // 去重：同一路径归属+贡献只出 1 条
  const both = listTaskArtifacts(db, { taskIds: ['T-A', 'T-B'], projectId: 'P-1' });
  eq(both.filter((x) => x.path === fA).length, 1, 'B10 同一路径只出 1 条（归属优先）');
  db.close();
}

/* ── C：补登记 ───────────────────────────────────────────────────────────── */

function sectionC(): void {
  console.log('\n【C】planClaimRegistrations / registerClaimedArtifacts');
  const db = fixture();
  const unreg = touch('c/unregistered.md');
  const registered = touch('c/registered.md');
  const probe = touch('c/_verify_probe.py');
  claim(db, 'T-B', unreg);
  claim(db, 'T-B', registered);
  claim(db, 'T-B', probe);
  claim(db, 'T-B', path.join(tmp, 'c/gone.md'));
  insertDeliv(db, { id: 'D-REG', taskId: 'T-A', filePath: registered });

  const plan = planClaimRegistrations(db, { taskId: 'T-B', projectId: 'P-1' });
  eq(plan.candidates, [unreg], 'C1 只有"盘上仍在 ∧ 非探针 ∧ 无登记行"的进入候选');
  const reasons = Object.fromEntries(plan.entries.filter((e) => e.path).map((e) => [path.basename(e.path), e.reason]));
  eq([reasons['registered.md'], reasons['_verify_probe.py'], reasons['gone.md']], ['registered', 'probe', 'missing'],
    'C2 三条跳过各有具名理由');

  const before = (db.prepare('SELECT task_id FROM wa_deliverables WHERE id = ?').get('D-REG') as { task_id: string }).task_id;
  const r1 = registerClaimedArtifacts(db, { taskId: 'T-B', projectId: 'P-1', via: 'rr' });
  eq(r1.created, 1, 'C3 补登记 0→1（正面断言）');
  const created = db.prepare('SELECT project_id, task_id, type, status, file_path FROM wa_deliverables WHERE id = ?').get(r1.ids[0]) as
    { project_id: string; task_id: string; type: string; status: string; file_path: string };
  eq([created.project_id, created.task_id, created.type, created.status, created.file_path], ['P-1', 'T-B', 'doc', 'draft', unreg],
    'C4 新行归属本任务、type=doc、草稿、路径不变');
  const after = (db.prepare('SELECT task_id FROM wa_deliverables WHERE id = ?').get('D-REG') as { task_id: string }).task_id;
  eq(after, before, 'C5 已有归属行不被改 task_id（不夺归属）');
  const r2 = registerClaimedArtifacts(db, { taskId: 'T-B', projectId: 'P-1', via: 'rr' });
  eq(r2.created, 0, 'C6 幂等：再跑不重复建行');

  // 上限：25 个未登记文件 ⇒ 20 建 + 5 limit
  const db2 = fixture();
  for (let i = 0; i < ARTIFACT_BACKFILL_LIMIT + 5; i++) claim(db2, 'T-B', touch(`cap/f${i}.md`));
  const plan2 = planClaimRegistrations(db2, { taskId: 'T-B', projectId: 'P-1' });
  eq([plan2.candidates.length, plan2.entries.filter((e) => e.reason === 'limit').length], [ARTIFACT_BACKFILL_LIMIT, 5],
    'C7 上限 20：超出如实记 limit（不静默吞）');
  db2.close();
  db.close();
}

/* ── D：回执清单含贡献 ───────────────────────────────────────────────────── */

function sectionD(): void {
  console.log('\n【D】readDeliveredOutputs 与回执核对');
  const db = fixture();
  const shared = touch('d/shared.md');
  const own = touch('d/own.md');
  insertDeliv(db, { id: 'D-1', taskId: 'T-A', filePath: shared });
  insertDeliv(db, { id: 'D-2', taskId: 'T-B', filePath: own });
  claim(db, 'T-B', shared);
  const outs = readDeliveredOutputs(db as never, 'T-B');
  eq(outs.map((o) => o.name).sort(), ['own.md', 'shared.md'].sort(), 'D1 产出清单 = 归属 ∪ 贡献（两只都在）');
  ok(outs.length >= 1, 'D2 outputs ≥ 1（跨机回执不再恒空）');

  const verified = verifyRemoteReceipt({
    localTaskId: 'L-1',
    result: { taskId: 'L-1', taskStatus: 'completed', outputs: outs },
    hasLocalEvent: true,
    checkedAt: '2026-11-15T00:00:00.000Z',
  });
  eq([verified.verdict, verified.missing], ['verified', []], 'D3 outputs≥1 且台账有痕 ⇒ verified');
  const noOut = verifyRemoteReceipt({
    localTaskId: 'L-1',
    result: { taskId: 'L-1', taskStatus: 'completed', outputs: [] },
    hasLocalEvent: true,
    checkedAt: '2026-11-15T00:00:00.000Z',
  });
  eq([noOut.verdict, noOut.missing], ['self-reported', ['outputs']], 'D4 outputs=0 仍不放行（判据未放宽）');
  db.close();
}

/* ── E：项目详情里程碑口径 ───────────────────────────────────────────────── */

function sectionE(): void {
  console.log('\n【E】detectMilestones：不再笛卡尔积');
  const db = fixture();
  // 5 个完成任务 × 40 产出物 × 40 三元组：旧实现 completed 会被重复累加成 8000
  for (let i = 0; i < 5; i++) {
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status) VALUES (?, 'P-1', ?, 'completed')").run(`T5-${i}`, `t${i}`);
  }
  for (let i = 0; i < 40; i++) {
    insertDeliv(db, { id: `DX-${i}`, taskId: 'T5-0', filePath: touch(`e/d${i}.md`) });
    db.prepare("INSERT INTO wa_knowledge_triples (id, project_id, subject, predicate, object) VALUES (?, 'P-1', 's', 'p', 'o')").run(`KX-${i}`);
  }
  eq(detectMilestones(db, 'P-1'), [], 'E1 5 个完成任务的真值不触发门槛（旧口径会虚高到 8000 触发三条）');

  // 12 个完成任务 × 3 产出物：只应触发 phase_transition，且理由里的数是真值
  const db2 = fixture();
  // 夹具自带的 T-A/T-B 也置非完成——否则"已完成"是 14 而不是 12，断言就会在抄另一个数。
  db2.prepare("UPDATE wa_tasks SET status = 'pending' WHERE id IN ('T-A','T-B')").run();
  for (let i = 0; i < 12; i++) {
    db2.prepare("INSERT INTO wa_tasks (id, project_id, title, status) VALUES (?, 'P-1', ?, 'completed')").run(`T12-${i}`, `t${i}`);
  }
  for (let i = 0; i < 3; i++) insertDeliv(db2, { id: `D12-${i}`, taskId: 'T12-0', filePath: touch(`e2/d${i}.md`) });
  const s2 = detectMilestones(db2, 'P-1');
  eq(s2.length, 1, 'E2 12 完成 / 3 产出 ⇒ 只触发阶段转换');
  ok(String(s2[0]?.reason).includes('已完成12个任务') && String(s2[0]?.reason).includes('产出3个交付物'),
    'E3 理由里的数是真值（12 / 3，不是笛卡尔积后的 36）', String(s2[0]?.reason));

  const db3 = fixture();
  eq(detectMilestones(db3, 'P-1'), [], 'E4 空项目 ⇒ 空建议');
  db3.close();
  db2.close();
  db.close();
}

/* ── F：GUI 两栏与补齐按钮（静态接线） ───────────────────────────────────── */

function sectionF(): void {
  console.log('\n【F】任务详情：归属/贡献两栏与补齐按钮');
  const ipc = readSrc(`${A}/src/main/ipc/project.ipc.ts`);
  ok(/listTaskArtifacts\(db,\s*\{[\s\S]{0,200}taskIds:\s*ownerIds/.test(ipc),
    'F1 task:get 用同一读口取两本账（taskIds=子树）');
  ok(/claimedArtifacts,\s*artifactsNote,/.test(ipc), 'F2 详情回执同时带「贡献账」与「0 产出解释」');
  ok(ipc.includes('不是"没有产出"') && ipc.includes('不是"读不到"'),
    'F3 0 产出有两句人话：写了但登记在别处 / 确实没写文件');
  ok(/ipcMain\.handle\('task:backfill-artifacts'/.test(ipc)
    && /registerClaimedArtifacts\(db,\s*\{[^}]*taskId:\s*id/.test(ipc),
    'F4 补齐按钮走同一个 registerClaimedArtifacts（不另写建行逻辑）');
  ok(/promoteTaskFileDeliverables\(db,\s*id,\s*'manual_backfill'\)/.test(ipc),
    'F5 已完成任务补登记后立即归位（不永久草稿）');

  const ta = readSrc(`${A}/renderer/src/components/task/TaskArtifacts.tsx`);
  ok(ta.includes('参与产出') && ta.includes('补齐本任务文件账') && ta.includes('登记在任务'),
    'F6 产出物块：参与产出栏 + 补齐按钮 + 归属在别处的标注');
  ok(/note && <p/.test(ta), 'F7 0 产出解释在块内如实上屏（不是空列表）');
  const td = readSrc(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  ok(/claimed=\{claimedArtifacts\}/.test(td) && /note=\{artifactsNote\}/.test(td)
    && /task:backfill-artifacts/.test(td),
    'F8 详情页三处接线：两栏、解释、补齐动作');
}

/* ── G：项目默认岗位 ─────────────────────────────────────────────────────── */

function sectionG(): void {
  console.log('\n【G】项目默认岗位：只在"恰好一个"成立');
  const db = fixture();
  const addPos = (id: string, name: string, enabled = 1): void => {
    db.prepare("INSERT INTO wa_positions (id, name, enabled) VALUES (?, ?, ?)").run(id, name, enabled);
  };
  const bind = (pid: string, posId: string, enabled = 1): void => {
    db.prepare('INSERT OR REPLACE INTO wa_project_positions (project_id, position_id, enabled) VALUES (?, ?, ?)').run(pid, posId, enabled);
  };
  eq(defaultPositionForProject(db, 'P-1'), null, 'G1 0 个绑定 ⇒ null（不猜）');
  addPos('pos_fin', '财务'); bind('P-1', 'pos_fin');
  eq(defaultPositionForProject(db, 'P-1'), { id: 'pos_fin', name: '财务' }, 'G2 恰 1 个启用绑定 ⇒ 默认它');
  addPos('pos_tax', '税务'); bind('P-1', 'pos_tax');
  eq(defaultPositionForProject(db, 'P-1'), null, 'G3 2 个绑定 ⇒ null（不替用户选）');
  db.prepare("UPDATE wa_project_positions SET enabled = 0 WHERE project_id = 'P-1' AND position_id = 'pos_tax'").run();
  eq(defaultPositionForProject(db, 'P-1'), { id: 'pos_fin', name: '财务' }, 'G4 第二个解绑 ⇒ 回到唯一');
  db.prepare("UPDATE wa_positions SET enabled = 0 WHERE id = 'pos_fin'").run();
  eq(defaultPositionForProject(db, 'P-1'), null, 'G5 唯一那个停用 ⇒ null（停用不默认）');
  eq(defaultPositionForProject(db, 'P-9'), null, 'G6 项目无绑定 ⇒ null');

  const ipc = readSrc(`${A}/src/main/ipc/project.ipc.ts`);
  ok(/position_explicit !== true/.test(ipc) && /defaultPositionForProject\(db,\s*projectId\)/.test(ipc),
    'G7 task:create：显式选择优先，未显式才用默认');
  ok(/task\.position_defaulted = positionDefaulted/.test(ipc), 'G8 默认指派如实回执（界面可显示"已按默认，可改"）');
  const posIpc = readSrc(`${A}/src/main/ipc/positions.ipc.ts`);
  ok(/defaultId:\s*defaultPositionForProject\(db,\s*projectId\)\?\.id/.test(posIpc),
    'G9 positions:forProject 与建单默认同一派生（界面预选不另算）');
  const im = readSrc(`${A}/src/main/services/im-router.ts`);
  ok(/defaultPositionForProject\(db as never,\s*proj\.id\)/.test(im)
    && /defaultPositionForProject\(ctx\.db as never,\s*projectId\)/.test(im),
    'G10 IM 两条建单路（编号选择 / 直建）都走同一默认');
  ok(BOOL_SETTING_KEYS.includes('position.default_from_project'), 'G11 开关在白名单（可被设置页渲染）');
  const settings = readSrc(`${A}/renderer/src/pages/SettingsPage.tsx`);
  ok(settings.includes("'position.default_from_project'"), 'G12 设置页有专属开关行（用户点得到）');
  const tasks = readSrc(`${A}/renderer/src/pages/TasksPage.tsx`);
  ok(/positionTouchedRef/.test(tasks) && tasks.includes('项目默认岗位') && /positionTouchedRef\.current\)/.test(tasks),
    'G13 建单表单：预选默认 + 显式选择后不再被覆盖');
  db.close();
}

/* ── H：候选领域包按题面建议 ─────────────────────────────────────────────── */

function sectionH(): void {
  console.log('\n【H】领域包建议：命中才推、只读、不越过滤');
  const db = fixture();
  const packJson = JSON.stringify({
    version: 2,
    name: 'A股投顾 · 领域包',
    sections: [
      { section: 'domain', content: '- 决策信号：买卖方向与理由\n- 目标价：当日目标\n- 仓位上限：单票不超过 20%' },
      { section: 'criteria', content: '- 验收：信号带版本号与指令号' },
    ],
  });
  const insPack = (id: string, o: { dismissed?: string | null; source?: string | null } = {}): void => {
    db.prepare('INSERT INTO wa_domain_packs (id, name, description, pack_json, source_project_id, origin, dismissed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, `${id} · 领域包`, '', packJson, o.source ?? 'P-OTHER', 'auto_candidate', o.dismissed ?? null);
  };
  insPack('pk1');
  const hit = suggestDomainPacksForTask(db as never, 'P-1', '生成今日决策信号与目标价，按仓位上限核对', 2);
  eq(hit.map((h) => h.id), ['pk1'], 'H1 题面命中术语 ⇒ 建议该包');
  ok(hit[0]!.hits.includes('决策信号') && hit[0]!.hits.includes('目标价'), 'H2 命中词条是真名（不是打分）', JSON.stringify(hit[0]!.hits));
  eq(suggestDomainPacksForTask(db as never, 'P-1', '重写 README 并补单元测试', 2), [], 'H3 0 命中 ⇒ 不硬推');

  insPack('pk_dismissed', { dismissed: '2026-11-15 00:00:00' });
  eq(suggestDomainPacksForTask(db as never, 'P-1', '决策信号与目标价', 5).map((h) => h.id), ['pk1'], 'H4 已忽略的包不再建议');

  insPack('pk_applied');
  db.prepare("INSERT INTO wa_project_domain_packs (project_id, pack_id) VALUES ('P-1','pk_applied')").run();
  eq(suggestDomainPacksForTask(db as never, 'P-1', '决策信号与目标价', 5).map((h) => h.id), ['pk1'], 'H5 已启用的包不再建议');

  insPack('pk_own', { source: 'P-1' });
  eq(suggestDomainPacksForTask(db as never, 'P-1', '决策信号与目标价', 5).map((h) => h.id), ['pk1'], 'H6 本项目派生的包不向本项目建议');

  const before = (db.prepare('SELECT COUNT(*) AS c FROM wa_project_domain_packs').get() as { c: number }).c;
  suggestDomainPacksForTask(db as never, 'P-1', '决策信号与目标价', 5);
  const after = (db.prepare('SELECT COUNT(*) AS c FROM wa_project_domain_packs').get() as { c: number }).c;
  eq([before, after], [1, 1], 'H7 建议只读：不写库、不自动启用（0→0）');

  const ipc = readSrc(`${A}/src/main/ipc/knowledge.ipc.ts`);
  ok(/ipcMain\.handle\('packs:suggestForTask'/.test(ipc) && /suggestDomainPacksForTask\(db,\s*projectId/.test(ipc),
    'H8 IPC 接线：同源函数 + 项目校验');
  const tasks = readSrc(`${A}/renderer/src/pages/TasksPage.tsx`);
  ok(tasks.includes('领域经验包') && /packsApi\.suggestForTask/.test(tasks) && /packsApi\.apply/.test(tasks),
    'H9 建单弹窗：就地建议 + 启用仍走 packs:apply（Pro 闸）');
  db.close();
}

/* ── I：上下文成本账（七源 + 注入摘要） ─────────────────────────────────── */

function sectionI(): void {
  console.log('\n【I】上下文账：已记录 / 未记录 / 读失败三态');
  const raw = JSON.stringify({
    execution_metrics: {
      token_breakdown: {
        tokens: { system: 100, memory: 50, knowledge: 10, tools: 200, history: 0, user: 5, output: 30 },
        chars: { system: 400, memory: 200, knowledge: 40, tools: 800, history: 0, user: 20, output: 120 },
        totalTokens: 395,
        totalChars: 1580,
        budgetTokens: 1200,
        trimmedChars: { knowledge: 40, memory: 20 },
        overBudget: false,
      },
    },
    cost_estimate: { inputTokens: 9000, outputTokens: 1200, cost: 0.0123 },
  });
  const okView = buildContextLedgerView(raw);
  eq([okView.error, okView.ledger?.totalTokens, okView.ledger?.budgetTokens, okView.ledger?.overBudget],
    ['', 395, 1200, false], 'I1 七源/总额/预算/超限如实');
  eq([okView.ledger?.tokens?.tools, okView.ledger?.trimmedChars?.knowledge, okView.ledger?.inputTokens, okView.ledger?.cost],
    [200, 40, 9000, 0.0123], 'I2 工具面 token / 已裁 / 实报 / 费用各取真源');
  eq(buildContextLedgerView('{}'), { ledger: null, error: '' }, 'I3 旧任务无分账 ⇒ null + 空错误（未记录 ≠ 0）');
  ok(buildContextLedgerView('{bad').error.includes('解析失败'), 'I4 坏 JSON ⇒ 如实报错（不吞成"没有账"）');
  eq(buildContextLedgerView('{"execution_metrics":{"token_breakdown":null}}').ledger, null, 'I5 分账为 null ⇒ 未记录');

  const ipc = readSrc(`${A}/src/main/ipc/project.ipc.ts`);
  ok(/buildContextLedgerView\(ctxJson\)/.test(ipc) && /contextLedger, contextLedgerError, injectionSummary/.test(ipc),
    'I6 task:get 回传三件：账 / 错因 / 注入摘要');
  const comp = readSrc(`${A}/renderer/src/components/task/TaskContextLedger.tsx`);
  ok(comp.includes("injectionSourceLabel") && comp.includes('上下文与成本') && comp.includes('未记录') && comp.includes('不是"0 token"'),
    'I7 组件：来源人话名同源 + 未记录不冒充 0');
  ok(!/INJECTION_SOURCE_LABEL\s*=/.test(comp), 'I8 渲染层不复制第二份来源词表（只引 main 侧）');
  const td = readSrc(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  ok(/<TaskContextLedger ledger=\{contextLedger\}/.test(td) && /applyContextLedger/.test(td),
    'I9 详情页接线：两处读点同一写入 + 渲染');
}

/* ── J：工具面简报瘦身（只删重复、不删能力） ─────────────────────────────── */

function sectionJ(): void {
  console.log('\n【J】工具面简报：不再重复 schema 已有的保留名');
  const allNames = toolRegistry.listNames();
  const full: Record<string, unknown> = Object.fromEntries(allNames.map((n) => [n, {}]));
  const archetypes: TaskArchetype[] = ['code', 'research', 'document', 'analysis', 'configuration', 'conversation'];
  for (const arch of archetypes) {
    const face = narrowToolFace(arch, full);
    const brief = buildToolFaceBrief(arch, '测试', face.kept, face.removed.length, face.removed);
    // 旧格式（本条瘦身之前）的长度，用于对照"真省了多少"
    const oldStyle = `[工具面·测试] 本形态**只注入**本档 ${face.kept.length} 个工具：${face.kept.join(', ')}。`
      + `其余 ${face.removed.length} 个工具在本形态下**不可用**（详见其 schema 不在本轮工具表内）；`
      + `若你认为确需其中某个能力，请说明用途并改用手头工具达成，不要虚构工具名。`;
    const tokens = new Set(brief.split(/[\s,，、：:；;]+/));
    ok(!face.kept.some((n) => tokens.has(n)), `J-${arch} 保留工具名不再逐个重复`);
    ok(face.removed.length === 0 || face.removed.slice(0, TOOL_FACE_BRIEF_REMOVED_MAX).every((n) => brief.includes(n)),
      `J-${arch} 移除名单仍在（"为什么调不到"的线索不丢）`);
    ok(face.removed.length === 0 || brief.length < oldStyle.length,
      `J-${arch} 字符数确实下降（${face.removed.length} 个移除命名）`, `${oldStyle.length} → ${brief.length}`);
  }
  // 上限：60 个移除名 ⇒ 只列 40 + "等 60 个"
  const many = Array.from({ length: 60 }, (_, i) => `tool_${i}`);
  const capped = buildToolFaceBrief('conversation', '测试', ['read_file'], 60, many);
  ok(capped.includes('tool_0') && capped.includes(`tool_${TOOL_FACE_BRIEF_REMOVED_MAX - 1}`)
    && !capped.includes(`tool_${TOOL_FACE_BRIEF_REMOVED_MAX}`),
    'J-cap 名单封顶 40（第 0 与第 39 在、第 40 不在）');
  ok(capped.includes('等 60 个'), 'J-cap2 超出部分如实报数');
  // 零收窄：仍是一句带过，且不含"不可用"
  const wide = buildToolFaceBrief('code', '测试', allNames, 0, []);
  ok(!wide.includes('不可用') && wide.length < 120, 'J-wide 零收窄一句带过（旧格式未变长）', wide);

  const ae = readSrc(`${A}/src/main/core/agent-executor.ts`);
  ok(/buildToolFaceBrief\(archetype, adaptiveStrategy\.label, toolFace\.kept, toolFace\.removed\.length, toolFace\.removed\)/.test(ae),
    'J-wire 执行体把**移除名单**传进简报（不是只传计数）');
}

function main(): void {
  console.log(`rr ${selfRound} — 归·传·简`);
  sectionS();
  sectionA();
  sectionB();
  sectionC();
  sectionD();
  sectionE();
  sectionF();
  sectionG();
  sectionH();
  sectionI();
  sectionJ();
  console.log(`\n—— ${pass} passed, ${fail} failed ——`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  if (fail > 0) process.exit(1);
}

main();
