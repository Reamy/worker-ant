/**
 * zx_20261115_1「职·派」——岗位成真（M1）与协同真派（M4）的受控回归。
 *
 * 判据分组（本文件首批只覆盖 M1；M4 落地后在同文件续写 E/F 组）：
 *   S「基」构建钉 P1–P6 + 本轮方案在册。
 *   T「表」新增四列的 DDL 与读写往返（旧库补列后行为不变）。
 *   U「承」缺失字段**继承现有行**——知识包导入不得抹掉工具面/沙箱/派单设置（反证标本）。
 *   V「严」沙箱单调不放宽：岗位只能把项目档**调严**，永不调松（两只标本 + 反证）。
 *   W「窄」岗位工具白名单只做**交集**，绝不像 `allowTools` 那样把形态档外的工具救回来（反证）。
 *   X「派」岗位不参与派单 ⇒ 拒因 `position-local-only`；未指派/读不到 ⇒ 不拦（对照标本）。
 *   Y「线」四处读口在源码里各恰一处（静态钉 + 旧字面量反证）。
 *
 * 纪律：
 *   - 轮次钉由 checkBuildPins 从真源派生，不写「只为下一轮」的字面量；
 *   - 断言文案禁含失败字形（`pnpm rr:all` 汇总器按字形计数）；
 *   - 夹具按生产初始化顺序搭：先执行 DDL 再插数据行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, deriveBuildTag, stripKeepingLines } from './lib/rr-pins.js';
import {
  POSITIONS_DDL,
  POSITION_LIST_MAX,
  POSITION_PROMOTE_SUGGEST_MIN,
  POSITION_SANDBOX_SCOPES,
  createPosition,
  decidePositionLesson,
  getPosition,
  insertPositionLessonCandidate,
  lessonRelevance,
  listPositionLessons,
  listPositions,
  narrowSandboxScope,
  sanitizePosition,
  sanitizeDispatchPosition,
  selectPositionLessonsForInjection,
  setProjectPositionEnabled,
  updatePosition,
  type PositionDb,
  type PositionSandboxScope,
} from '../apps/worker-ant-desktop/src/main/core/positions.js';
// M2「账」：真实写口 0→1（夹具先建表再 new，顺序即纪律）。
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
// M3「分」：删项目的级联清理（唯一实现，直接跑真函数）。
import { deleteProjectCascade } from '../apps/worker-ant-desktop/src/main/core/project-engine.js';
import { restrictToolFaceByPosition, type ToolFaceScope } from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';
import {
  CREATE_DISPATCH_REASON_LABEL,
  decideCreateDispatch,
  dispatchPositionOfTask,
  taskPositionLocalOnly,
  type CreateDispatchFacts,
} from '../apps/worker-ant-desktop/src/main/core/collab-dispatch.js';
import { planOffloads } from '../apps/worker-ant-desktop/src/main/core/node-orchestrate.js';
import { capacityAvailable, capacityDisplay } from '../apps/worker-ant-desktop/src/main/core/tier-capacity.js';
import { resolveProjectDispatchMode } from '../apps/worker-ant-desktop/src/main/core/project-dispatch-mode.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(a: unknown, b: unknown, label: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `${JSON.stringify(a)} = ${JSON.stringify(b)}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const readSrc = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');
const codeOf = (rel: string): string => stripKeepingLines(readSrc(rel)).join('\n');
const selfRound = path.basename(__filename, '.ts').replace(/^rr_/, '');

/* ── S「基」 ────────────────────────────────────────────────────────────── */

function sectionS(): void {
  console.log('\n【S】构建钉与本轮方案');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

  const plan = readSrc(`plans/improve/${selfRound}.md`);
  ok(plan.includes(selfRound), 'S1 本轮方案在册且带轮次名');
  ok(plan.includes('意义即用法'), 'S2 方案立下「无读口不加字段」的纪律（防字段堆）');
  ok(plan.includes('feedback_json_column_overwrite_wipes_siblings'), 'S3 方案记下全列覆写抹兄弟键的既有病根');
  ok(plan.includes('本轮暂缓'), 'S4 方案如实记下本轮暂缓的三项（model/approval/output_template）');

  const { tag } = deriveBuildTag(readSrc(`${A}/src/main/core/agent-executor.ts`));
  ok(tag >= selfRound, 'S5 构建钉不早于本脚本轮次', `${tag} >= ${selfRound}`);
}

/* ── 夹具 ───────────────────────────────────────────────────────────────── */

/** 生产同源 DDL（`POSITIONS_DDL`）+ 被读口 JOIN 的最小邻表。 */
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, status TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE wa_tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending', position_id TEXT NOT NULL DEFAULT '',
      context_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );
    CREATE TABLE wa_context_injections (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source TEXT NOT NULL, ref_id TEXT NOT NULL,
      chars INTEGER NOT NULL DEFAULT 0, est_tokens INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_ctx_inj_u ON wa_context_injections (task_id, source, ref_id);
    -- M3「分」：deleteProjectCascade 会逐表清理；夹具须把它引用的每一张表都建出来，
    --   否则首条 DELETE 抛错会整笔事务回滚，测试就变成"假绿/假红"。
    CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, type TEXT, status TEXT);
    CREATE TABLE wa_notifications (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT);
    CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT);
    CREATE TABLE wa_deliverable_versions (id TEXT PRIMARY KEY, deliverable_id TEXT);
    CREATE TABLE wa_knowledge_triples (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE wa_project_knowledge (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE wa_project_knowledge_imports (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE wa_knowledge_imports (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE wa_project_profiles (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE wa_project_profile_history (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE wa_project_briefs (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE wa_project_domain_packs (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE wa_project_members (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE wa_memories (
      id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, memory_type TEXT DEFAULT 'episodic',
      content TEXT NOT NULL DEFAULT '', context_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(POSITIONS_DDL);
  db.prepare("INSERT INTO wa_projects (id, name, status) VALUES ('proj_a', '甲项目', 'active')").run();
  // `node:sqlite` 无 better-sqlite3 的 `.transaction()`——补最小等价垫片（同步执行，无嵌套）。
  (db as unknown as { transaction: (fn: () => void) => () => void }).transaction = (fn: () => void) => () => fn();
  return db;
}

/* ── T「表」 ────────────────────────────────────────────────────────────── */

function sectionT(): void {
  console.log('\n【T】新增四列的 DDL 与读写往返');
  const db = makeDb();
  const pdb = db as unknown as PositionDb;
  const cols = (db.prepare('PRAGMA table_info(wa_positions)').all() as Array<{ name: string }>).map((c) => c.name);
  for (const c of ['tools_json', 'mcp_json', 'sandbox_scope', 'participate']) {
    ok(cols.includes(c), `T1 表含新列 ${c}`);
  }

  const created = createPosition(pdb, {
    name: '甲岗',
    description: '负责核对',
    tools: ['read_file', 'search_content'],
    mcp: ['github'],
    sandboxScope: 'strict',
    participate: false,
  });
  ok(created.ok, 'T2 四字段随创建写入');
  if (created.ok) {
    eq(created.position.tools, ['read_file', 'search_content'], 'T3 工具白名单往返');
    eq(created.position.mcp, ['github'], 'T4 MCP 白名单往返');
    eq(created.position.sandboxScope, 'strict', 'T5 沙箱档往返');
    eq(created.position.participate, false, 'T6 参与派单往返');
  }

  // 缺省态：不传 ⇒ 空数组 / 空串 / 参与 —— 与旧库语义一致。
  const plain = createPosition(pdb, { name: '乙岗' });
  ok(plain.ok, 'T7 缺省四字段可创建');
  if (plain.ok) {
    eq(plain.position.tools, [], 'T8 缺省工具白名单为空（沿用形态面）');
    eq(plain.position.mcp, [], 'T9 缺省 MCP 为空（项目全部）');
    eq(plain.position.sandboxScope, '', 'T10 缺省沙箱档为空串（继承项目）');
    eq(plain.position.participate, true, 'T11 缺省参与派单为真');
  }
}

/* ── U「承」 ────────────────────────────────────────────────────────────── */

function sectionU(): void {
  console.log('\n【U】缺失字段继承现有行（知识包导入不得抹掉设置）');
  const db = makeDb();
  const pdb = db as unknown as PositionDb;
  const created = createPosition(pdb, {
    name: '财务',
    rules: ['先对齐口径'],
    tools: ['read_file'],
    mcp: ['erp'],
    sandboxScope: 'strict',
    participate: false,
  });
  ok(created.ok, 'U0 夹具：带四设置建岗');
  const id = created.ok ? created.position.id : '';

  // 知识包导入只带 规范/技能/知识 三段（`position-package.ts` 的真实入参形状）。
  const r = updatePosition(pdb, id, {
    name: '财务',
    category: 'custom',
    description: '',
    rules: ['先对齐口径', '复核后再付'],
    skills: [],
    knowledge: [],
  });
  ok(r.ok, 'U1 只带三段更新成功');
  const after = getPosition(pdb, id);
  eq(after?.tools, ['read_file'], 'U2 工具白名单未被抹掉（全列覆写反证）');
  eq(after?.mcp, ['erp'], 'U3 MCP 白名单未被抹掉');
  eq(after?.sandboxScope, 'strict', 'U4 沙箱档未被抹掉');
  eq(after?.participate, false, 'U5 参与派单未被抹掉');
  eq(after?.rules, ['先对齐口径', '复核后再付'], 'U6 三段本身按预期更新（不是"整行没动"）');

  // 显式给值仍能改（继承不是"不许改"）。
  const r2 = updatePosition(pdb, id, { name: '财务', tools: [], participate: true });
  const after2 = getPosition(pdb, id);
  ok(r2.ok, 'U7 显式给值更新成功');
  eq(after2?.tools, [], 'U8 显式空数组能把白名单清空（继承只作用于 undefined）');
  eq(after2?.participate, true, 'U9 显式布尔能把派单打开');

  // 无 fallback 时（新建）不继承任何东西。
  const clean = sanitizePosition({ name: '丙岗' });
  ok(clean.ok && clean.value.tools.length === 0, 'U10 无 fallback 时缺省为零值（新建路径）');
}

/* ── V「严」 ────────────────────────────────────────────────────────────── */

function sectionV(): void {
  console.log('\n【V】沙箱单调不放宽');
  eq(narrowSandboxScope('strict', 'workspace'), 'strict', 'V1 项目严格 + 岗位工作目录 ⇒ 仍严格（不放宽）');
  eq(narrowSandboxScope('strict', 'off'), 'strict', 'V2 项目严格 + 岗位不限制 ⇒ 仍严格（反证）');
  eq(narrowSandboxScope('workspace', 'strict'), 'strict', 'V3 项目工作目录 + 岗位严格 ⇒ 严格（可调严）');
  eq(narrowSandboxScope('off', 'workspace'), 'workspace', 'V4 项目不限制 + 岗位工作目录 ⇒ 工作目录');
  eq(narrowSandboxScope('workspace', ''), 'workspace', 'V5 岗位留空 ⇒ 原样继承项目');
  eq(narrowSandboxScope('nonsense', ''), 'workspace', 'V6 项目档非法 ⇒ 兜底工作目录（不放大到 off）');

  const scopes = POSITION_SANDBOX_SCOPES as readonly PositionSandboxScope[];
  eq([...scopes], ['', 'strict', 'workspace', 'off'], 'V7 沙箱档词表恰四值（含空串=继承）');

  const bad = sanitizePosition({ name: '丁', sandboxScope: 'loose' });
  ok(!bad.ok && bad.code === 'SANDBOX_SCOPE_INVALID', 'V8 非法沙箱档整块拒绝');
}

/* ── W「窄」 ────────────────────────────────────────────────────────────── */

function sectionW(): void {
  console.log('\n【W】岗位工具白名单只做交集');
  const face: ToolFaceScope = {
    kept: ['read_file', 'write_file', 'execute_command'],
    removed: ['deploy'],
    outside: [],
    restored: [],
  };

  const none = restrictToolFaceByPosition(face, []);
  eq(none.kept, face.kept, 'W1 空白名单 ⇒ 工具面原样（今日行为不变）');
  eq(none.removedByPosition, [], 'W2 空白名单 ⇒ 无岗位删除项');

  const narrowed = restrictToolFaceByPosition(face, ['read_file']);
  eq(narrowed.kept, ['read_file'], 'W3 白名单只留交集');
  eq(narrowed.removedByPosition, ['write_file', 'execute_command'], 'W4 被岗位删掉的逐项可数');

  // 反证：白名单里写形态档外的名字，**不会**把它救回来（与 allowTools 语义相反）。
  const rescue = restrictToolFaceByPosition(face, ['deploy']);
  eq(rescue.kept, [], 'W5 白名单写档外工具不会救回（kept 为空，不是出现 deploy）');
  ok(!rescue.kept.includes('deploy'), 'W6 档外工具绝不出现在 kept');

  // 反证：入参不被 mutate。
  eq(face.kept, ['read_file', 'write_file', 'execute_command'], 'W7 入参未被 mutate（纯函数）');
}

/* ── X「派」 ────────────────────────────────────────────────────────────── */

const BASE_FACTS: CreateDispatchFacts = {
  settingOn: true,
  teamUnlocked: true,
  enrolled: true,
  hasDependencies: false,
  hasAttachments: false,
  decomposed: false,
  category: 'research',
};

function sectionX(): void {
  console.log('\n【X】岗位不参与派单的拒因');
  const on = decideCreateDispatch({ ...BASE_FACTS });
  ok(on.eligible, 'X1 对照标本：无岗位约束时可派');

  const off = decideCreateDispatch({ ...BASE_FACTS, positionLocalOnly: true });
  ok(!off.eligible && off.reason === 'position-local-only', 'X2 岗位不参与 ⇒ 拒因 position-local-only');
  ok(!!CREATE_DISPATCH_REASON_LABEL['position-local-only'], 'X3 拒因有人话文案', CREATE_DISPATCH_REASON_LABEL['position-local-only']);

  // 岗位级意图优先于技术性排除：即便本机满载（无 localHasFreeSlot 限制），也先说岗位原因。
  const off2 = decideCreateDispatch({ ...BASE_FACTS, positionLocalOnly: true, autoDispatchSource: 'default', localHasFreeSlot: true });
  ok(off2.reason === 'position-local-only', 'X4 岗位原因先于 local-capacity 说');

  // 真库读口：三只标本（0 / 1 / 未指派）。
  const db = makeDb();
  const pdb = db as unknown as PositionDb;
  const p = createPosition(pdb, { name: '不出门的岗', participate: false });
  const q = createPosition(pdb, { name: '出门的岗', participate: true });
  const pid = p.ok ? p.position.id : '';
  const qid = q.ok ? q.position.id : '';
  db.prepare("INSERT INTO wa_tasks (id, project_id, position_id) VALUES ('t1','proj_a',?)").run(pid);
  db.prepare("INSERT INTO wa_tasks (id, project_id, position_id) VALUES ('t2','proj_a',?)").run(qid);
  db.prepare("INSERT INTO wa_tasks (id, project_id, position_id) VALUES ('t3','proj_a','')").run();
  db.prepare("INSERT INTO wa_tasks (id, project_id, position_id) VALUES ('t4','proj_a','pos_missing')").run();
  const asDb = db as unknown as Parameters<typeof taskPositionLocalOnly>[0];
  eq(taskPositionLocalOnly(asDb, 't1'), true, 'X5 participate=0 的任务 ⇒ 本机独占');
  eq(taskPositionLocalOnly(asDb, 't2'), false, 'X6 participate=1 ⇒ 可派');
  eq(taskPositionLocalOnly(asDb, 't3'), false, 'X7 未指派岗位 ⇒ 可派（不误伤）');
  eq(taskPositionLocalOnly(asDb, 't4'), false, 'X8 岗位行不存在 ⇒ 可派（读不到不拦）');
}

/* ── Y「线」 ────────────────────────────────────────────────────────────── */

function sectionY(): void {
  console.log('\n【Y】四处读口各恰一处（静态钉 + 旧字面量反证）');

  const ctx = codeOf(`${A}/src/main/core/exec-context.ts`);
  ok(/narrowSandboxScope\(/.test(ctx), 'Y1 沙箱装配走 narrowSandboxScope（唯一合成判据）');
  ok(/positionRow\?\.sandboxScope/.test(ctx), 'Y2 沙箱读岗位档');
  ok(/positionRow\?\.mcp/.test(ctx), 'Y3 MCP 装配读岗位白名单');
  const oldSandbox = /const sandboxMode = \(project\?\.sandbox_mode as string\) \|\| 'workspace';/.test(ctx);
  ok(!oldSandbox, 'Y4 旧的无岗位沙箱行已被替换（反证）');

  const ex = codeOf(`${A}/src/main/core/agent-executor.ts`);
  ok(/restrictToolFaceByPosition\(/.test(ex), 'Y5 工具面装配调用岗位交集');
  ok(/positionTools/.test(ex), 'Y6 岗位工具列表由上下文装配传入');

  const cd = codeOf(`${A}/src/main/core/collab-dispatch.ts`);
  // 只数**调用点**（`taskPositionLocalOnly(db, …)`）；定义处 `export function taskPositionLocalOnly(` 不算。
  const hits = cd.match(/taskPositionLocalOnly\(db,/g) ?? [];
  ok(hits.length === 2, 'Y7 两处派发事实构建都读岗位派单开关', `命中 ${hits.length}`);

  const pos = codeOf(`${A}/src/main/core/positions.ts`);
  ok(/export function narrowSandboxScope/.test(pos), 'Y8 沙箱合成为纯函数导出（可直跑）');
  ok(/fallback\?\.tools/.test(pos), 'Y9 工具白名单走继承');
}

/* ── Z「圈」 ────────────────────────────────────────────────────────────── */

function sectionZ(): void {
  console.log('\n【Z】经验按任务相关性排序（第二圈的挑法）');

  ok(lessonRelevance('对账要先核对银行流水再生成凭证', '核对银行流水') > 0,
    'Z1 相关经验得分为正（词面命中）');
  eq(lessonRelevance('对账要先核对银行流水再生成凭证', '编写前端组件样式'), 0,
    'Z2 不相关经验得分为 0');
  eq(lessonRelevance('任意经验', ''), 0, 'Z3 空任务文本 ⇒ 0（调用方回退时间序）');
  ok(lessonRelevance('用 read_file 读配置', 'read_file 的用法') > 0, 'Z4 拉丁词也参与匹配');

  const db = makeDb();
  const pdb = db as unknown as PositionDb;
  const p = createPosition(pdb, { name: '财务' });
  const pid = p.ok ? p.position.id : '';

  // 三条经验，两条相关度不同、一条无关；创建时刻越晚越"新"。
  const add = (taskId: string, content: string, created: string): void => {
    insertPositionLessonCandidate(pdb, { positionId: pid, taskId, projectId: 'proj_a', content, source: 'retrospective', reusable: true });
    db.prepare('UPDATE wa_position_lessons SET created_at = ?, status = ? WHERE task_id = ?').run(created, 'accepted', taskId);
  };
  add('t-old', '对账要先核对银行流水与回单', '2026-11-01 00:00:00');
  add('t-new', '生成报表前先固化会计期间', '2026-11-03 00:00:00');
  add('t-rel', '核对银行流水时逐笔比对回单', '2026-11-02 00:00:00');

  const noQuery = selectPositionLessonsForInjection(pdb, pid);
  eq(noQuery.map((l) => l.taskId), ['t-new', 't-rel', 't-old'],
    'Z5 无任务文本 ⇒ 逐字节沿用时间序（最近在前）');

  const withQuery = selectPositionLessonsForInjection(pdb, pid, undefined, '核对银行流水与回单');
  // `t-old` 逐字覆盖全部词元（8/8），`t-rel` 覆盖 6/8，`t-new` 为 0 ⇒ 相关性序 = old > rel > new。
  eq(withQuery.map((l) => l.taskId), ['t-old', 't-rel', 't-new'],
    'Z6 有任务文本 ⇒ 按相关性排序（与时间序恰好相反，证明不是"原样返回"）');
  ok(withQuery.length === 3, 'Z7 有文本时仍按 limit 取 3 条', `${withQuery.length}`);
  const top2 = withQuery.slice(0, 2);
  ok(!top2.some((l) => l.taskId === 't-new'), 'Z8 无关经验被挤出前二', top2.map((l) => l.taskId).join(','));
}

/* ── AA「数」 ───────────────────────────────────────────────────────────── */

function sectionAA(): void {
  console.log('\n【AA】复用次数由注入账派生 + 建议晋升');
  const db = makeDb();
  const pdb = db as unknown as PositionDb;
  const p = createPosition(pdb, { name: '财务' });
  const pid = p.ok ? p.position.id : '';
  insertPositionLessonCandidate(pdb, {
    positionId: pid, taskId: 't-1', projectId: 'proj_a', content: '核对流水', source: 'retrospective', reusable: true,
  });
  const lessonId = String((db.prepare('SELECT id FROM wa_position_lessons WHERE task_id = ?').get('t-1') as { id: string }).id);
  decidePositionLesson(pdb, lessonId, 'accepted', 'test');

  const before = listPositionLessons(pdb, pid)[0]!;
  eq(before.injectedCount, 0, 'AA1 未被注入过 ⇒ 0 次');
  ok(!before.promoteSuggested, 'AA2 0 次 ⇒ 不建议晋升');

  // 真写 3 条注入账（不同任务），计数应派生为 3。
  const ins = db.prepare('INSERT INTO wa_context_injections (id, task_id, source, ref_id, chars) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < POSITION_PROMOTE_SUGGEST_MIN; i++) {
    ins.run(`inj-${i}`, `task-${i}`, 'position', `lesson:${lessonId}`, 10);
  }
  const after = listPositionLessons(pdb, pid)[0]!;
  eq(after.injectedCount, POSITION_PROMOTE_SUGGEST_MIN, 'AA3 注入账 3 行 ⇒ 复用 3 次（派生而非另立计数器）');
  ok(after.promoteSuggested, 'AA4 达门槛且未晋升 ⇒ 建议晋升');

  // 反证：晋升后不再建议。
  db.prepare("UPDATE wa_position_lessons SET promoted_to = 'rules', promoted_at = datetime('now') WHERE id = ?").run(lessonId);
  const promoted = listPositionLessons(pdb, pid)[0]!;
  ok(!promoted.promoteSuggested, 'AA5 已晋升 ⇒ 不再建议（反证）');

  // 反证：pending 的经验就算被注入多次也不建议（只建议已采纳的）。
  insertPositionLessonCandidate(pdb, {
    positionId: pid, taskId: 't-2', projectId: 'proj_a', content: '另一条', source: 'retrospective', reusable: true,
  });
  const p2 = String((db.prepare('SELECT id FROM wa_position_lessons WHERE task_id = ?').get('t-2') as { id: string }).id);
  for (let i = 0; i < POSITION_PROMOTE_SUGGEST_MIN; i++) ins.run(`inj2-${i}`, `task2-${i}`, 'position', `lesson:${p2}`, 10);
  const pend = listPositionLessons(pdb, pid).find((l) => l.id === p2)!;
  eq(pend.injectedCount, POSITION_PROMOTE_SUGGEST_MIN, 'AA6 pending 经验同样能统计到注入次数');
  ok(!pend.promoteSuggested, 'AA7 pending ⇒ 不建议晋升（未采纳不算数）');
}

/* ── AB「账」 ───────────────────────────────────────────────────────────── */

function sectionAB(): void {
  console.log('\n【AB】注入账 lesson 类型 0→1（正面断言）');
  const db = makeDb();
  const pdb = db as unknown as PositionDb;
  const p = createPosition(pdb, { name: '财务' });
  const pid = p.ok ? p.position.id : '';
  insertPositionLessonCandidate(pdb, {
    positionId: pid, taskId: 't-x', projectId: 'proj_a', content: '核对流水', source: 'retrospective', reusable: true,
  });
  const lessonId = String((db.prepare('SELECT id FROM wa_position_lessons WHERE task_id = ?').get('t-x') as { id: string }).id);
  decidePositionLesson(pdb, lessonId, 'accepted', 'test');

  const count = (): number =>
    Number((db.prepare("SELECT COUNT(*) AS c FROM wa_context_injections WHERE source = 'position' AND ref_id LIKE 'lesson:%'").get() as { c: number }).c);
  eq(count(), 0, 'AB1 前置自证：lesson 类型注入账起初 0 行');

  const mm = new MemoryManager(db as never, null as never);
  eq(mm.recordContextInjections('t-second', { positions: [{ ref_id: `lesson:${lessonId}`, chars: 8 }] }), 1,
    'AB2 ★写口真写进去（返回 1，不是"不抛"）');
  eq(count(), 1, 'AB3 ★lesson 类型注入账 0→1');

  const row = db.prepare("SELECT source, outcome FROM wa_context_injections WHERE ref_id = ?").get(`lesson:${lessonId}`) as Record<string, unknown>;
  eq(row.source, 'position', 'AB4 归在 position 源下（不新开词表）');
  eq(row.outcome, 'pending', 'AB5 初始 pending（收口时回填）');
}

/* ── AC「级」 ───────────────────────────────────────────────────────────── */

function sectionAC(): void {
  console.log('\n【AC】删项目：解绑定、留经验（两种沉淀的分界）');
  const db = makeDb();
  const pdb = db as unknown as PositionDb;
  const p = createPosition(pdb, { name: '财务' });
  const pid = p.ok ? p.position.id : '';
  db.prepare("INSERT INTO wa_projects (id, name, status) VALUES ('proj_b', '乙项目', 'active')").run();
  setProjectPositionEnabled(pdb, 'proj_a', pid, true);
  setProjectPositionEnabled(pdb, 'proj_b', pid, true);

  // 在 proj_a 的任务上沉淀一条经验。
  db.prepare("INSERT INTO wa_tasks (id, project_id, position_id, title) VALUES ('t-a','proj_a',?,'甲任务')").run(pid);
  insertPositionLessonCandidate(pdb, {
    positionId: pid, taskId: 't-a', projectId: 'proj_a', content: '核对流水', source: 'retrospective', reusable: true,
  });

  const before = listPositionsCount(pdb, pid);
  eq(before, 2, 'AC1 前置自证：绑定两个项目 ⇒ projectCount=2');

  deleteProjectCascade(db as unknown as Parameters<typeof deleteProjectCascade>[0], 'proj_a');

  const after = listPositionsCount(pdb, pid);
  eq(after, 1, 'AC2 ★删项目后绑定行被清理（此前不在级联清单里，数组大于可见项目数）');
  const lessons = (db.prepare('SELECT COUNT(*) AS c FROM wa_position_lessons WHERE position_id = ?').get(pid) as { c: number }).c;
  eq(Number(lessons), 1, 'AC3 ★岗位经验行保留（经验属于岗位，是跨项目资产）');
  const visible = (db.prepare("SELECT COUNT(*) AS c FROM wa_projects WHERE status != 'archived'").get() as { c: number }).c;
  eq(Number(visible), 1, 'AC4 可见项目数 = 1');
  eq(after, Number(visible), 'AC5 ★岗位页项目数 = 可见项目数（口径自洽）');

  // 反证：经验行的项目引用成为历史，但不会被静默改写成别的项目。
  const row = db.prepare('SELECT project_id FROM wa_position_lessons WHERE position_id = ?').get(pid) as { project_id: string };
  eq(row.project_id, 'proj_a', 'AC6 历史 project_id 原样保留（不伪造、不置空）');
}

/** 岗位列表里的 projectCount（`listPositions` 的唯一来源）。 */
function listPositionsCount(pdb: PositionDb, id: string): number {
  return listPositions(pdb).find((r) => r.id === id)?.projectCount ?? -1;
}

/* ── AD「跨」 ───────────────────────────────────────────────────────────── */

function sectionAD(): void {
  console.log('\n【AD】跨项目复用可见（岗位以岗位为中心的证据）');
  const db = makeDb();
  const pdb = db as unknown as PositionDb;
  const p = createPosition(pdb, { name: '财务' });
  const pid = p.ok ? p.position.id : '';
  insertPositionLessonCandidate(pdb, {
    positionId: pid, taskId: 't-1', projectId: 'proj_a', content: '核对流水', source: 'retrospective', reusable: true,
  });
  const lessonId = String((db.prepare('SELECT id FROM wa_position_lessons WHERE task_id = ?').get('t-1') as { id: string }).id);
  decidePositionLesson(pdb, lessonId, 'accepted', 'test');

  db.prepare("INSERT INTO wa_projects (id, name, status) VALUES ('proj_b', '乙项目', 'active')").run();
  db.prepare("INSERT INTO wa_tasks (id, project_id, title) VALUES ('t-2','proj_a','同项目第二件')").run();
  db.prepare("INSERT INTO wa_tasks (id, project_id, title) VALUES ('t-3','proj_b','另一项目的一件')").run();

  const ins = db.prepare('INSERT INTO wa_context_injections (id, task_id, source, ref_id, chars) VALUES (?, ?, ?, ?, ?)');
  ins.run('i1', 't-1', 'position', `lesson:${lessonId}`, 10);
  ins.run('i2', 't-2', 'position', `lesson:${lessonId}`, 10);
  const same = listPositionLessons(pdb, pid)[0]!;
  eq(same.crossProjectCount, 1, 'AD1 只在一个项目里用上 ⇒ 跨项目数 1');

  ins.run('i3', 't-3', 'position', `lesson:${lessonId}`, 10);
  const cross = listPositionLessons(pdb, pid)[0]!;
  eq(cross.injectedCount, 3, 'AD2 三次注入 ⇒ 次数 3');
  eq(cross.crossProjectCount, 2, 'AD3 两个不同项目 ⇒ 跨项目数 2（可迁移的直接证据）');
}

/* ── AE「模」 ───────────────────────────────────────────────────────────── */

function sectionAE(): void {
  console.log('\n【AE】溢出外派按项目有效模式（不再恒收全局模式）');
  const ready = [{ id: 't1' }, { id: 't2' }];
  eq(planOffloads({ ready, localOccupied: 2, available: 0, mode: 'overflow' }), ['t1', 't2'],
    'AE1 溢出 + 本机跑满 ⇒ 取溢出件（对照标本）');
  eq(planOffloads({ ready, localOccupied: 2, available: 0, mode: 'capability' }), [],
    'AE2 非溢出模式 ⇒ 溢出路不接管（各走各的路）');
  eq(planOffloads({ ready, localOccupied: 2, available: 3, mode: 'overflow' }), [],
    'AE3 本机还有空位 ⇒ 不外派（知止）');

  // 静态钉：编排器把**解析后的**模式传下去，而不是全局模式。
  const orch = codeOf(`${A}/src/main/core/orchestrator.ts`);
  ok(/mode:\s*resolution\.mode/.test(orch), 'AE4 编排器传 resolution.mode（项目级显式设置才真正生效）');
  ok(!/mode:\s*mode\s*,/.test(orch), 'AE5 旧写法（传全局 mode）已不存在（反证）');

  // 项目模式解析：全局 off + 项目显式 overflow ⇒ 解析结果仍是 overflow（本轮回溯的上游）。
  const resolved = resolveProjectDispatchMode({
    projectMode: 'overflow', globalMode: 'off', enrolled: true, onlinePeers: 1, hasDivision: false,
  });
  eq(resolved.mode, 'overflow', 'AE6 全局 off + 项目显式 overflow ⇒ 有效模式 overflow');
}

/* ── AF「向」 ───────────────────────────────────────────────────────────── */

function sectionAF(): void {
  console.log('\n【AF】接/派两向 + 能力优先不受「本机有空」阻挡');

  const okOut = decideCreateDispatch({ ...BASE_FACTS, localParticipateOut: true });
  ok(okOut.eligible, 'AF1 允许派出去 ⇒ 可派（对照标本）');

  const offOut = decideCreateDispatch({ ...BASE_FACTS, localParticipateOut: false });
  ok(!offOut.eligible && offOut.reason === 'participate-out-off', 'AF2 关闭派出去 ⇒ 拒因 participate-out-off');
  ok(!!CREATE_DISPATCH_REASON_LABEL['participate-out-off'], 'AF3 拒因有人话文案', CREATE_DISPATCH_REASON_LABEL['participate-out-off']);

  // 能力优先：本机闲着不再是"留本机"的理由。
  const capFree = decideCreateDispatch({
    ...BASE_FACTS, capabilityMode: true, autoDispatchSource: 'default', localHasFreeSlot: true,
  });
  ok(capFree.eligible, 'AF4 ★能力优先 + 本机有空 ⇒ 仍可外派（此前被 local-capacity 恒拒）');

  // 反证：非能力优先的缺省开 + 本机有空 ⇒ 照旧拦（旧行为不回退）。
  const overflowFree = decideCreateDispatch({
    ...BASE_FACTS, capabilityMode: false, autoDispatchSource: 'default', localHasFreeSlot: true,
  });
  ok(!overflowFree.eligible && overflowFree.reason === 'local-capacity',
    'AF5 非能力优先 + 本机有空 ⇒ 仍 local-capacity（旧语义不回退）');

  // 缺键（旧调用方）⇒ 不改变旧行为。
  const legacyKey = decideCreateDispatch({ ...BASE_FACTS, autoDispatchSource: 'default', localHasFreeSlot: true });
  eq(legacyKey.reason, 'local-capacity', 'AF6 无 capabilityMode 键 ⇒ 按旧口径判（向后兼容）');

  // 接线：两处事实构建都读本机派向与项目能力模式。
  const cd = codeOf(`${A}/src/main/core/collab-dispatch.ts`);
  eq((cd.match(/effectiveNodeParticipateOut\(/g) ?? []).length, 2, 'AF7 两处派发事实都读「能否派出去」');
  eq((cd.match(/effectiveCapabilityMode\(/g) ?? []).length, 3, 'AF8 能力模式唯一判据一处定义 + 两处调用');

  // 「接」的每跳同步：心跳体带 participate、ANS 侧落列并在拉取口复核。
  const hb = codeOf(`${A}/src/main/core/node-heartbeat.ts`);
  ok(/participate === undefined \?/.test(hb), 'AF9 心跳体按"读得到才传"构造（读不到不冒名关）');
  const ans = codeOf('apps/ans-server/src/routes/nodes.ts');
  ok(/body\.participate !== undefined/.test(ans), 'AF10 ANS 心跳接收 participate 并落列');
  ok(/SELECT participate FROM ans_nodes WHERE node_id = \?/.test(ans), 'AF11 拉取口复核参与态（已 assigned 的不再被拉走）');
}

/* ── AG「界」 ───────────────────────────────────────────────────────────── */

function sectionAG(): void {
  console.log('\n【AG】岗位工具白名单随单过界（约束可过界，知识经验不行）');

  const base = { id: 'pos_x', name: '财务', version: 1, summary: '说明' };
  const withTools = sanitizeDispatchPosition({ ...base, tools: ['read_file', 'read_file', '', 'search_content'] });
  eq(withTools?.tools, ['read_file', 'search_content'], 'AG1 去重且丢空项');
  ok(!('tools' in (sanitizeDispatchPosition({ ...base, tools: [] }) ?? {})), 'AG2 空白名单 ⇒ 不出现该键（旧载荷字节不变）');
  ok(!('tools' in (sanitizeDispatchPosition(base) ?? {})), 'AG3 缺键 ⇒ 不出现该键');
  const bad = sanitizeDispatchPosition({ ...base, tools: [1, null, 'ok'] });
  eq(bad?.tools, ['ok'], 'AG4 坏项逐个丢弃，好项保留（不整键作废成"不限制"）');
  const many = sanitizeDispatchPosition({ ...base, tools: Array.from({ length: 50 }, (_, i) => `t${i}`) });
  ok((many?.tools ?? []).length <= POSITION_LIST_MAX, 'AG5 超限按上限截断', String((many?.tools ?? []).length));

  // 端到端：任务指派的岗位 → 随单段带 tools。
  const db = makeDb();
  const pdb = db as unknown as PositionDb;
  const p = createPosition(pdb, { name: '财务', tools: ['read_file'] });
  const pid = p.ok ? p.position.id : '';
  db.prepare("INSERT INTO wa_tasks (id, project_id, position_id, title) VALUES ('t-m5','proj_a',?,'核对')").run(pid);
  const seg = dispatchPositionOfTask(db as unknown as Parameters<typeof dispatchPositionOfTask>[0], 't-m5');
  eq(seg?.tools, ['read_file'], 'AG6 随单段带上岗位工具白名单');
  ok(typeof seg?.summary === 'string', 'AG7 摘要仍在（形状未被本轮改动）');

  // 接线：远端未指派岗位时用对端白名单收窄工具面。
  const ctx = codeOf(`${A}/src/main/core/exec-context.ts`);
  ok(/remotePositionTools/.test(ctx), 'AG8 上下文装配保留对端白名单');
  ok(/positionRow\?\.tools\?\.length \? positionRow\.tools : remotePositionTools/.test(ctx),
    'AG9 本机岗位优先、对端白名单兜底（只收窄）');
}

/* ── AH「名实」 ─────────────────────────────────────────────────────────── */

function sectionAH(): void {
  console.log('\n【AH】装饰数字收口：低档不再显示摸不到的上限');
  ok(!capacityAvailable('community', 'maxDevices'), 'AH1 社区档设备登记不可达（发现/接入归 Pro）');
  ok(capacityDisplay('community', 'maxDevices', '台').includes('需'), 'AH2 社区档显示「需…」而非数字', capacityDisplay('community', 'maxDevices', '台'));
  ok(capacityDisplay('pro', 'maxDevices', '台').includes('台'), 'AH3 专业档仍显示真实上限', capacityDisplay('pro', 'maxDevices', '台'));

  ok(!capacityAvailable('community', 'maxExternalTerminals'), 'AH4 社区档外部终端不可达');
  ok(!capacityAvailable('pro', 'maxExternalTerminals'), 'AH5 专业档外部终端同样不可达（Team 闸先拦）');
  ok(capacityAvailable('team', 'maxExternalTerminals'), 'AH6 团队档外部终端可用');

  ok(!capacityAvailable('community', 'maxKnowledgeCardsPerProject'), 'AH7 社区档知识卡不可达');
  ok(capacityAvailable('pro', 'maxKnowledgeCardsPerProject'), 'AH8 专业档知识卡可用');

  ok(!capacityAvailable('pro', 'maxTeamLibraryMemories'), 'AH9 专业档团队共享不可达');
  ok(capacityAvailable('team', 'maxTeamLibraryMemories'), 'AH10 团队档可用');

  // 不受影响的维度仍按旧口径（反证：没有把整张表一概改成"不可达"）。
  ok(capacityAvailable('community', 'maxIMChannels'), 'AH11 对照标本：IM 渠道社区档仍可用');
  eq(capacityDisplay('team', 'maxTeamLibraryMemories', '条'), '不限', 'AH12 团队档 0=不限 口径不变');

  // M7 说真话：四处改动的静态钉（各钉"改后的形状"与"旧假象已不在"）。
  const mem = readSrc(`${A}/renderer/src/pages/MemoriesPage.tsx`);
  ok(/q\.error/.test(mem) && /记忆列表读取失败/.test(mem), 'AH13 记忆页读失败如实说（不再伪装"暂无记忆"）');
  // 逐块点名：五个辅助加载各自 markFail/clearFail（不是"整页再没有 catch {}"——别处仍有合法的兜底）。
  ok((mem.match(/markFail\(/g) ?? []).length >= 5 && (mem.match(/clearFail\(/g) ?? []).length >= 5,
    'AH14 记忆页五个辅助块各自记录失败与恢复（空 catch 已清）',
    `${(mem.match(/markFail\(/g) ?? []).length}/${(mem.match(/clearFail\(/g) ?? []).length}`);
  const dash = readSrc(`${A}/renderer/src/pages/DashboardPage.tsx`);
  // 以 **JSX 文本形态**为判据（注释里复述旧字面量不算，那是给下一位读者看的病根说明）。
  ok(!/>单进程 Electron \+ IPC</.test(dash) && !/>连接正常</.test(dash), 'AH15 看板不再渲染写死常量');
  ok(/IPC 状态/.test(dash) && /读取失败/.test(dash), 'AH16 看板 IPC 状态改为真实读取结果');
  const audit = readSrc(`${A}/renderer/src/pages/AuditPage.tsx`);
  ok(/AUDIT_RESULT_LABEL/.test(audit) && /成功/.test(audit), 'AH17 审计结果走中文词表');
  ok(/setLimit/.test(audit) && /加载更多/.test(audit), 'AH18 审计可加载更多（不再写死 200）');
  const im = readSrc(`${A}/renderer/src/pages/IMPage.tsx`);
  ok(/confirmation: '待确认'/.test(im), 'AH19 IM 确认分支有中文词');
  ok(/intent_confidence/.test(im) && /CONFIDENCE_LABEL/.test(im), 'AH20 IM 置信度上屏（此前只写不读）');
}

function main(): void {
  sectionS();
  sectionT();
  sectionU();
  sectionV();
  sectionW();
  sectionX();
  sectionY();
  sectionZ();
  sectionAA();
  sectionAB();
  sectionAC();
  sectionAD();
  sectionAE();
  sectionAF();
  sectionAG();
  sectionAH();
  console.log(`\n[rr_zx_20261115_1] ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
