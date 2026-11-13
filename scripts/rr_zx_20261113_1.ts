/**
 * zx_20261113_1「岗」——岗位成为跨项目的长期知识载体。
 *
 * 判据分组（随批次逐步补齐）：
 *   S「基」构建钉 P1–P6 + 本轮方案在册与四项拍板口径。
 *   L「积」复盘可迁移教训优先 / 摘要降级候选 / 精炼只动 pending / 存量回填幂等。
 *   U「用」注入词表含 position / 条目级选择 / 注入账 0→1 / 结果回填。
 *   P「晋」晋升到规范技能知识 / 去重重拒 / 满段拒不静默 / 撤回恢复。
 *   R「像」岗位画像计数与无数据口径。
 *   K「商」岗位知识包往返 / 坏包零写入 / Pro 闸两只标本。
 *
 * 纪律：
 *   - 轮次钉由 checkBuildPins 从真源派生，不写「只为下一轮」的字面量；
 *   - 断言文案禁含失败字形（汇总器按字形计数）；
 *   - 夹具按生产初始化顺序搭：先建服务/表，再插数据行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildNotOlderThan, checkBuildPins, deriveBuildTag, stripKeepingLines } from './lib/rr-pins.js';
import {
  POSITIONS_DDL,
  POSITION_ITEM_MAX,
  POSITION_LIST_MAX,
  POSITION_PROMOTE_TARGET_LABEL,
  buildPositionLessonCandidate,
  createPosition,
  decidePositionLesson,
  generatePositionLessonCandidate,
  getPosition,
  getPositionDetail,
  insertPositionLessonCandidate,
  listProjectPositionBoard,
  positionBlock,
  positionBlockDetail,
  positionProfile,
  promotePositionLesson,
  refinePositionLessonFromRetrospective,
  selectPositionLessonsForInjection,
  setProjectPositionEnabled,
  unpromotePositionLesson,
  type PositionDb,
} from '../apps/worker-ant-desktop/src/main/core/positions.js';
import { INJECTION_SOURCES, INJECTION_SOURCE_LABEL } from '../apps/worker-ant-desktop/src/main/core/injection-sources.js';
import {
  POSITION_PACKAGE_KIND,
  POSITION_PACKAGE_VERSION,
  buildPositionPackage,
  importPositionPackage,
  parsePositionPackage,
  positionLessonImportKey,
} from '../apps/worker-ant-desktop/src/main/core/position-package.js';
import { PRO_FEATURES, PRO_FEATURE_LABEL, proUnlocked } from '../apps/worker-ant-desktop/src/main/core/pro-gate.js';
// U 组：真实写口 0→1——构造 MemoryManager（夹具先建表再 new，顺序即纪律）。
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';

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

function sectionS(): void {
  console.log('\n【S】构建钉与本轮方案');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

  const selfRound = path.basename(__filename, '.ts').replace(/^rr_/, '');
  const plan = readSrc(`plans/improve/${selfRound}.md`);
  ok(plan.includes(selfRound), 'S1 本轮方案在册且带轮次名');
  ok(plan.includes('岗位成为跨项目') && plan.includes('项目为中心') && plan.includes('岗位为中心'),
    'S2 方案记下「项目/岗位各沉淀各的」这一刀（防实施时漂移）');
  ok(plan.includes('Pro 岗位知识包导出/导入') || plan.includes('岗位知识包导出/导入'),
    'S3 方案记下 Pro 档位强化方向（只挡搬运，不挡使用）');
  ok(plan.includes('授权起 dev 桌面') || plan.includes('GUI（已授权）'),
    'S4 方案记下 GUI 目视已获授权');
  ok(plan.includes('不新增智能设备品牌') || plan.includes('维持不新增品牌'),
    'S5 方案记下智能设备边界（40+ 品牌不写成已支持）');

  // 构建钉由脚本自身派生轮次做方向性比较，不手抄「本轮值」。
  const { tag, count } = deriveBuildTag(readSrc(`${A}/src/main/core/agent-executor.ts`));
  eq(count, 1, 'S6 源码 build 轮次标识恰好 1 处');
  ok(buildNotOlderThan(tag, selfRound), 'S7 构建钉不早于本脚本轮次', `${tag} >= ${selfRound}`);
}

/* ── B1「联」：项目详情岗位卡 ─────────────────────────────────────────────── */

/** 夹具：生产同源 DDL（positions）+ 被读模型 JOIN 的最小邻表。 */
function makeBoardDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, status TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE wa_tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending', position_id TEXT NOT NULL DEFAULT '',
      context_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );
    CREATE TABLE wa_memories (
      id TEXT PRIMARY KEY, task_id TEXT, memory_type TEXT DEFAULT 'episodic',
      content TEXT NOT NULL DEFAULT '', context_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE wa_context_injections (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source TEXT NOT NULL, ref_id TEXT NOT NULL,
      chars INTEGER NOT NULL DEFAULT 0, est_tokens INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(POSITIONS_DDL);
  db.prepare("INSERT INTO wa_projects (id, name, status) VALUES ('proj_a', '甲项目', 'active')").run();
  return db;
}

function sectionI(): void {
  console.log('\n【I】B1「联」项目详情岗位卡');
  const db = makeBoardDb();
  const pdb = db as unknown as PositionDb;
  const a = createPosition(pdb, { name: '甲岗', category: 'business', rules: ['先对齐口径'], skills: ['核对'], knowledge: [] });
  const b = createPosition(pdb, { name: '乙岗', category: 'tech', rules: [], skills: [], knowledge: [] });
  ok(a.ok && b.ok, 'I1 夹具：两个岗位创建成功');
  if (!a.ok || !b.ok) return;
  setProjectPositionEnabled(pdb, 'proj_a', a.position.id, true);

  const insTask = (id: string, status: string, positionId: string): void => {
    db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, position_id) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'proj_a', id, status, positionId);
  };
  insTask('t_a1', 'completed', a.position.id);
  insTask('t_a2', 'completed', a.position.id);
  insTask('t_a3', 'executing', a.position.id);
  insTask('t_b1', 'completed', b.position.id);

  db.prepare(`INSERT INTO wa_position_lessons (id, position_id, task_id, project_id, content, status)
              VALUES ('l_a1', ?, 't_a1', 'proj_a', '甲经验', 'pending')`).run(a.position.id);
  db.prepare(`INSERT INTO wa_position_lessons (id, position_id, task_id, project_id, content, status)
              VALUES ('l_b1', ?, 't_b1', 'proj_a', '乙经验', 'pending')`).run(b.position.id);

  const rows = listProjectPositionBoard(pdb, 'proj_a');
  eq(rows.length, 2, 'I2 项目卡列出全部岗位（含未启用/未绑定，不只可派的那批）');
  const ra = rows.find((r) => r.id === a.position.id);
  const rb = rows.find((r) => r.id === b.position.id);
  ok(!!ra && !!rb, 'I3 两个岗位都在投影里');
  eq(ra?.bound, true, 'I4 甲岗已绑定本项目');
  eq(rb?.bound, false, 'I5 乙岗未绑定');
  eq(ra?.taskTotal, 3, 'I6 甲岗本项目任务总数 = 3');
  eq(ra?.taskCompleted, 2, 'I7 甲岗完成数 = 2');
  eq(ra?.taskActive, 1, 'I8 甲岗在办数 = 1（executing 计在办）');
  eq(ra?.pendingLessons, 1, 'I9 甲岗本项目待审经验 = 1');
  eq(rb?.taskTotal, 1, 'I10 乙岗本项目任务数 = 1（未绑定也照实计）');
  eq(rows[0]?.id, a.position.id, 'I11 已绑定岗位排在前面');
  eq(listProjectPositionBoard(pdb, ''), [], 'I12 空项目 id ⇒ 空数组（不猜）');
  const missing = listProjectPositionBoard(pdb, 'no_such_project');
  ok(missing.every((r) => r.taskTotal === 0 && !r.bound), 'I13 未知项目 ⇒ 全零/未绑定，不编数据');

  // 静态接线：IPC 一跳 + 页面真用 + 卡不自己算数。
  const ipc = codeOf(`${A}/src/main/ipc/positions.ipc.ts`);
  ok(ipc.includes("ipcMain.handle('positions:projectBoard'") && ipc.includes('listProjectPositionBoard(db, projectId)'),
    'I14 IPC 接线：projectBoard 走同一读模型');
  const page = codeOf(`${A}/renderer/src/pages/ProjectDetailPage.tsx`);
  ok(page.includes('<ProjectPositionsCard projectId={id!} />'), 'I15 项目详情真挂载岗位卡（不是只建文件）');
  const card = codeOf(`${A}/renderer/src/components/ProjectPositionsCard.tsx`);
  ok(card.includes('positionsApi.projectBoard(projectId)') && card.includes('positionsApi.projectToggle('),
    'I16 卡只调 main 读/写口，不自造计数');
  ok(card.includes('岗位已停用') && card.includes('本项目还没有启用岗位'),
    'I17 卡如实区分「岗位停用」与「本项目未启用」两种空态');
  const mention = codeOf(`${A}/src/main/core/position-mention.ts`);
  ok(mention.includes('项目详情') && mention.includes('岗位'),
    'I18 IM 拒因指向「项目详情岗位」——B1 后该入口真实存在');
}

/* ── B2「积」：复盘可迁移教训优先 / 摘要降级 / 精炼只动 pending ───────────── */

function makeLessonDb(): { db: DatabaseSync; pdb: PositionDb; positionId: string } {
  const db = makeBoardDb();
  const pdb = db as unknown as PositionDb;
  const p = createPosition(pdb, { name: '复盘岗', category: 'analysis', rules: ['先对齐口径'], skills: [], knowledge: [] });
  if (!p.ok) throw new Error('夹具岗位创建失败');
  setProjectPositionEnabled(pdb, 'proj_a', p.position.id, true);
  return { db, pdb, positionId: p.position.id };
}

function insertLessonTask(
  db: DatabaseSync,
  id: string,
  positionId: string,
  opts: { status?: string; summary?: string; extraCtx?: Record<string, unknown> } = {},
): void {
  const ctx = {
    acceptance_check: { checked_at: '2026-11-13T00:00:00Z', criteria_total: 1, passed_total: 1 },
    completion_summary: opts.summary ?? '完成了这件事',
    ...(opts.extraCtx ?? {}),
  };
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, position_id, context_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'proj_a', id, opts.status ?? 'completed', positionId, JSON.stringify(ctx));
}

function insertRetro(
  db: DatabaseSync,
  id: string,
  taskId: string,
  lesson: string,
  opts: { action?: string; reusable?: boolean; type?: string; updatedAt?: string } = {},
): void {
  db.prepare('INSERT INTO wa_memories (id, task_id, memory_type, content, context_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(
      id, taskId, opts.type ?? 'retrospective', '[复盘]',
      JSON.stringify({ retrospective: { lesson, action: opts.action ?? '', reusable: opts.reusable ?? false } }),
      opts.updatedAt ?? '2026-11-13T00:00:00Z',
    );
}

function lessonsOf(db: DatabaseSync, taskId: string): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM wa_position_lessons WHERE task_id = ?').all(taskId) as Array<Record<string, unknown>>;
}

function sectionL(): void {
  console.log('\n【L】B2「积」岗位经验改取复盘可迁移教训');
  const { db, pdb, positionId } = makeLessonDb();

  // L1–L4 无复盘 ⇒ 摘要降级候选（可见、不可迁移）。
  insertLessonTask(db, 't_sum', positionId, { summary: '这次把报表跑通了' });
  const builtSum = buildPositionLessonCandidate(pdb, 't_sum');
  ok(builtSum.ok && builtSum.source === 'summary' && builtSum.reusable === false,
    'L1 无复盘 ⇒ 摘要降级候选（source=summary / reusable=0）');
  eq(generatePositionLessonCandidate(pdb, 't_sum'), true, 'L2 摘要候选 0→1');
  const sumRow = lessonsOf(db, 't_sum')[0]!;
  eq(sumRow.source, 'summary', 'L3 摘要候选来源落库为 summary');
  eq(Number(sumRow.reusable), 0, 'L4 摘要候选 reusable=0（不注入/不晋升的判据）');

  // L5–L9 有复盘 ⇒ 取 lesson(+action)，可迁移标记随复盘。
  insertLessonTask(db, 't_retro', positionId, { summary: '这段摘要会被复盘教训取代' });
  insertRetro(db, 'm_retro', 't_retro', '老栈传递依赖必须全量离线编译', { action: '启动前跑依赖树扫描', reusable: true });
  const builtRetro = buildPositionLessonCandidate(pdb, 't_retro');
  ok(builtRetro.ok && builtRetro.source === 'retrospective' && builtRetro.reusable === true,
    'L5 有复盘 ⇒ source=retrospective / reusable=1');
  ok(builtRetro.ok && builtRetro.content.includes('全量离线编译') && builtRetro.content.includes('依赖树扫描'),
    'L6 内容取复盘 lesson + action（下次怎么做）');
  eq(generatePositionLessonCandidate(pdb, 't_retro'), true, 'L7 复盘候选 0→1');
  const retroRow = lessonsOf(db, 't_retro')[0]!;
  eq(retroRow.source, 'retrospective', 'L8 复盘候选来源落库为 retrospective');
  eq(Number(retroRow.reusable), 1, 'L9 复盘可迁移标记落库为 1');

  // L10–L11 复盘判定不可复用 ⇒ 仍留档，但 reusable=0。
  insertLessonTask(db, 't_nonreuse', positionId);
  insertRetro(db, 'm_nonreuse', 't_nonreuse', '这个项目的接口命名很特别', { reusable: false });
  const builtNon = buildPositionLessonCandidate(pdb, 't_nonreuse');
  ok(builtNon.ok && builtNon.source === 'retrospective' && builtNon.reusable === false,
    'L10 复盘明确 reusable=false ⇒ 仍留档但不可迁移');

  // L12–L14 精炼：pending 摘要候选被复盘内容替换；已采纳候选不被改写。
  insertLessonTask(db, 't_refine', positionId, { summary: '旧的摘要' });
  eq(generatePositionLessonCandidate(pdb, 't_refine'), true, 'L11 先落摘要候选');
  insertRetro(db, 'm_refine', 't_refine', '先对齐验收标准再开工', { action: '开工前复述判据', reusable: true });
  eq(refinePositionLessonFromRetrospective(pdb, 't_refine'), true, 'L12 复盘后精炼 pending 候选');
  const refined = lessonsOf(db, 't_refine')[0]!;
  ok(String(refined.content).includes('先对齐验收标准') && !String(refined.content).includes('旧的摘要'),
    'L13 精炼后内容换成复盘教训');
  eq(refined.source, 'retrospective', 'L14 精炼后来源改成 retrospective');

  insertLessonTask(db, 't_decided', positionId, { summary: '已采纳的摘要' });
  generatePositionLessonCandidate(pdb, 't_decided');
  const decided = lessonsOf(db, 't_decided')[0]!;
  decidePositionLesson(pdb, String(decided.id), 'accepted');
  insertRetro(db, 'm_decided', 't_decided', '后台不得改写的人工结论', { reusable: true });
  eq(refinePositionLessonFromRetrospective(pdb, 't_decided'), false, 'L15 已采纳候选不被后台精炼');
  eq(lessonsOf(db, 't_decided')[0]!.content, '已采纳的摘要', 'L16 ★人工结论逐字保留（错误归因防线）');

  // L17–L19 准入与反证。
  insertLessonTask(db, 't_failed', positionId, { status: 'failed' });
  insertRetro(db, 'm_failed', 't_failed', '失败任务也有教训', { reusable: true });
  const builtFailed = buildPositionLessonCandidate(pdb, 't_failed');
  ok(!builtFailed.ok && builtFailed.reason === 'not_completed', 'L17 非完成状态 ⇒ 不生成（判定与旧口径一致）');

  insertLessonTask(db, 't_remote', positionId, { extraCtx: { assigned_node_id: 'node_remote' } });
  const builtRemote = buildPositionLessonCandidate(pdb, 't_remote');
  ok(!builtRemote.ok && builtRemote.reason === 'remote_assigned', 'L18 跨机派发 ⇒ 本机不沉淀');

  insertLessonTask(db, 't_arch', positionId);
  insertRetro(db, 'm_arch', 't_arch', '墓碑里的教训不该复活', { reusable: true, type: 'archived' });
  const builtArch = buildPositionLessonCandidate(pdb, 't_arch');
  ok(builtArch.ok && builtArch.source === 'summary', 'L19 ★墓碑/归档复盘不参与（回退摘要，不把死记忆当活教训）');

  // L20–L21 接线顺序：复盘先写、精炼后跑。
  const jobs = codeOf(`${A}/src/main/core/jobs/index.ts`);
  ok(jobs.indexOf('generateTaskRetrospective(taskId, projectId)') < jobs.indexOf('refinePositionLessonFromRetrospective(db, taskId)'),
    'L20 ★接线顺序：复盘生成在前、岗位精炼在后（反了只能拿到摘要）');
  const backfill = readSrc('scripts/backfill-position-lessons.ts');
  ok(backfill.includes('--apply') && backfill.includes('buildPositionLessonCandidate(pdb, id)'),
    'L21 存量回填 dry-run 默认、与派生同一把尺');
}

/* ── B3「用」：岗位注入记账、条目级明细、结果回填 ───────────────────────── */

function makeLedgerDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE wa_memories (
    id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL,
    memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5, reasoning TEXT DEFAULT '',
    source TEXT DEFAULT 'x', valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}',
    is_exemplar INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  d.exec('CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT)');
  d.exec(`CREATE TABLE wa_context_injections (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source TEXT NOT NULL, ref_id TEXT NOT NULL,
    chars INTEGER NOT NULL DEFAULT 0, est_tokens INTEGER NOT NULL DEFAULT 0,
    outcome TEXT NOT NULL DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')))`);
  d.exec('CREATE UNIQUE INDEX idx_wa_context_injections_key ON wa_context_injections(task_id, source, ref_id)');
  return d;
}

function sectionU(): void {
  console.log('\n【U】B3「用」岗位注入记账与条目级明细');

  eq((INJECTION_SOURCES as readonly string[]).includes('position'), true, 'U1 注入来源词表含 position');
  eq(INJECTION_SOURCE_LABEL.position, '岗位', 'U2 人话名「岗位」一处派生');

  const { db, pdb, positionId } = makeLessonDb();
  // 给岗位四段内容，确保 detail 能出五类条目。
  db.prepare("UPDATE wa_positions SET description = '把事做成', rules_json = '[\"先对齐口径\"]', skills_json = '[\"核对\",\"拆解\"]', knowledge_json = '[\"口径表在 wiki\"]' WHERE id = ?").run(positionId);

  const addLesson = (taskId: string, content: string, source: string, reusable: boolean): string => {
    insertPositionLessonCandidate(pdb, { positionId, taskId, projectId: 'proj_a', content, source, reusable });
    const row = db.prepare('SELECT id FROM wa_position_lessons WHERE task_id = ?').get(taskId) as { id: string };
    decidePositionLesson(pdb, row.id, 'accepted');
    return row.id;
  };
  const lOk = addLesson('t_u_ok', '先对齐验收标准再开工', 'retrospective', true);
  const lSummary = addLesson('t_u_sum', '项目摘要不该注入', 'summary', false);
  const lPending = insertPositionLessonCandidate(pdb, { positionId, taskId: 't_u_pending', projectId: 'proj_a', content: '还没采纳的经验', source: 'retrospective', reusable: true });
  const lPromoted = addLesson('t_u_promoted', '已晋升成规范的经验', 'retrospective', true);
  db.prepare("UPDATE wa_position_lessons SET promoted_to = 'rules', promoted_at = datetime('now') WHERE id = ?").run(lPromoted);

  const selected = selectPositionLessonsForInjection(pdb, positionId);
  eq(selected.map((l) => l.id), [lOk], 'U3 ★只选 accepted + reusable + 未晋升（摘要/未采纳/已晋升全不选）');
  ok(lPending && lSummary && lPromoted, 'U4 前置：三条反例都真的在库里');

  const pos = getPositionDetail(pdb, positionId)!.position;
  const detail = positionBlockDetail(pos, selected);
  const kinds = detail.items.map((i) => i.kind);
  ok(['description', 'rule', 'skill', 'knowledge', 'lesson'].every((k) => kinds.includes(k as never)),
    'U5 五个来源都出条目（说明/规范/技能/知识/经验）', kinds.join(','));
  ok(detail.items.every((i) => detail.text.includes(i.preview)), 'U6 ★每个条目都真在文本里（不写"没进文"的账）');
  ok(detail.items.every((i) => i.preview.length === Math.min(80, i.chars)),
    'U7 preview 恰是正文前 min(80, chars) 字（同一正文，不另算）');
  ok(detail.items.some((i) => i.kind === 'rule' && /^rule:[0-9a-f]{8}$/.test(i.refId)),
    'U8 规范 refId = `rule:<8hex>`（内容哈希，编辑后身份随内容变）');
  ok(detail.items.some((i) => i.kind === 'lesson' && i.refId === `lesson:${lOk}`),
    'U9 经验 refId = `lesson:<id>`（可按 id 下钻）');
  ok(!detail.text.includes('项目摘要不该注入') && !detail.text.includes('还没采纳的经验') && !detail.text.includes('已晋升成规范的经验'),
    'U10 ★反证：摘要/未采纳/已晋升经验都不进岗位块');
  eq(positionBlock(pos, selected), detail.text, 'U11 `positionBlock` 兼容壳与 detail 文本逐字相同');

  const headLen = `【岗位】${pos.name}`.length;
  const tiny = positionBlockDetail(pos, selected, headLen);
  eq(tiny.items.length, 0, 'U12 ★预算只够抬头 ⇒ 零条目（不写被截掉的账）');
  ok(tiny.text.includes('【岗位】'), 'U13 抬头仍在（超预算时也不吞掉岗位名）');

  // 真实写口：0→1、幂等、结果回填。
  const ld = makeLedgerDb();
  const mm = new MemoryManager(ld as never, null as never);
  const before = (ld.prepare("SELECT COUNT(*) AS c FROM wa_context_injections WHERE source = 'position'").get() as { c: number }).c;
  eq(before, 0, 'U14 ★前置自证：岗位注入账起初 0 行');
  eq(mm.recordContextInjections('t-1', {
    positions: [{ ref_id: `lesson:${lOk}`, chars: 12 }, { ref_id: 'rule:abcd1234', chars: 6 }],
  }), 2, 'U15 ★写口真写进去（返回 2，不是"不抛"）');
  const row = ld.prepare("SELECT source, ref_id, chars, est_tokens, outcome FROM wa_context_injections WHERE ref_id = ?").get(`lesson:${lOk}`) as Record<string, unknown>;
  eq([row.source, row.ref_id, row.chars, row.est_tokens, row.outcome], ['position', `lesson:${lOk}`, 12, 3, 'pending'],
    'U16 行内如实：来源/指向/字数/估 token（初记 pending）');
  eq(mm.recordContextInjections('t-1', { positions: [{ ref_id: `lesson:${lOk}`, chars: 12 }] }), 0,
    'U17 ★重复装配不记第二笔（唯一键幂等）');
  eq(mm.backfillInjectionOutcomes('t-1', 'completed'), 2, 'U18 收口回填两行 pending → completed');
  const done = ld.prepare("SELECT COUNT(*) AS c FROM wa_context_injections WHERE source = 'position' AND outcome = 'completed'").get() as { c: number };
  eq(done.c, 2, 'U19 ★结果可核：完成结局落回岗位注入行');

  // 静态接线：装配用条目级、执行体记账、详情上屏。
  const ctxCode = codeOf(`${A}/src/main/core/exec-context.ts`);
  ok(ctxCode.includes('positionBlockDetail(position, selectPositionLessonsForInjection(db, pid))'),
    'U20 ★执行期用条目级选择器（不是旧的 accepted 全量）');
  const execCode = codeOf(`${A}/src/main/core/agent-executor.ts`);
  ok(execCode.includes('positions: positionRows.map') && execCode.includes('injected_position'),
    'U21 ★执行体：注入账带 positions + 写 injected_position 快照');
  const page = codeOf(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  ok(page.includes('injected_position') && page.includes('岗位注入') && page.includes('POSITION_INJECT_KIND_LABEL'),
    'U22 任务详情真上屏岗位注入（类型/摘要/字数）');
}

/* ── B4「晋」：经验晋升到规范/技能/知识，可撤回 ─────────────────────────── */

function sectionP(): void {
  console.log('\n【P】B4「晋」经验晋升与撤回');
  const { db, pdb, positionId } = makeLessonDb();
  const addAccepted = (taskId: string, content: string, reusable = true): string => {
    insertPositionLessonCandidate(pdb, { positionId, taskId, projectId: 'proj_a', content, source: 'retrospective', reusable });
    const row = db.prepare('SELECT id FROM wa_position_lessons WHERE task_id = ?').get(taskId) as { id: string };
    decidePositionLesson(pdb, row.id, 'accepted');
    return row.id;
  };

  const l1 = addAccepted('t_p1', '先复述判据再开工');
  const before = getPosition(pdb, positionId)!;
  const r1 = promotePositionLesson(pdb, l1, 'rules');
  ok(r1.ok, 'P1 已采纳可迁移经验可晋升到规范');
  if (r1.ok) {
    ok(r1.position.rules.includes('先复述判据再开工'), 'P2 晋升后进入规范段');
    eq(r1.position.version, before.version + 1, 'P3 晋升使岗位版本 +1');
    eq(r1.lesson.promotedTo, 'rules', 'P4 经验标记 promoted_to=rules');
  }
  eq(selectPositionLessonsForInjection(pdb, positionId).map((l) => l.id), [], 'P5 ★晋升后不再作为经验重复注入');

  const again = addAccepted('t_p2', '先复述判据再开工');
  const dup = promotePositionLesson(pdb, again, 'rules');
  ok(!dup.ok && dup.code === 'ALREADY_IN_SECTION', 'P6 同一句已在规范 ⇒ 如实拒，不重复追加');

  const pending = insertPositionLessonCandidate(pdb, { positionId, taskId: 't_p3', projectId: 'proj_a', content: '还没采纳', source: 'retrospective', reusable: true });
  ok(pending, 'P7 前置：pending 经验写入');
  const pid3 = (db.prepare("SELECT id FROM wa_position_lessons WHERE task_id = 't_p3'").get() as { id: string }).id;
  const notAccepted = promotePositionLesson(pdb, pid3, 'rules');
  ok(!notAccepted.ok && notAccepted.code === 'NOT_ACCEPTED', 'P8 未采纳 ⇒ 不可晋升');

  const summary = addAccepted('t_p4', '项目摘要不该晋升', false);
  const notReusable = promotePositionLesson(pdb, summary, 'skills');
  ok(!notReusable.ok && notReusable.code === 'NOT_REUSABLE', 'P9 ★不可迁移（摘要）⇒ 不可晋升为岗位规范');

  const long = addAccepted('t_p5', '长'.repeat(POSITION_ITEM_MAX + 1));
  const tooLong = promotePositionLesson(pdb, long, 'knowledge');
  ok(!tooLong.ok && tooLong.code === 'LESSON_TOO_LONG', 'P10 超过单条上限 ⇒ 如实拒（不截半句）');

  // 满段：另建一个 20 条规范的岗位。
  const full = createPosition(pdb, { name: '满段岗', rules: Array.from({ length: POSITION_LIST_MAX }, (_, i) => `规范${i}`) });
  ok(full.ok, 'P11 前置：满段岗位创建');
  if (full.ok) {
    setProjectPositionEnabled(pdb, 'proj_a', full.position.id, true);
    insertPositionLessonCandidate(pdb, { positionId: full.position.id, taskId: 't_p6', projectId: 'proj_a', content: '再加一条', source: 'retrospective', reusable: true });
    const fid = (db.prepare("SELECT id FROM wa_position_lessons WHERE task_id = 't_p6'").get() as { id: string }).id;
    decidePositionLesson(pdb, fid, 'accepted');
    const fullRes = promotePositionLesson(pdb, fid, 'rules');
    ok(!fullRes.ok && fullRes.code === 'SECTION_FULL', 'P12 目标段已满 ⇒ 如实拒（不挤掉别人）');
  }

  // 撤回：原文仍在 ⇒ 移除并恢复注入资格；原文被改 ⇒ 拒绝。
  const u1 = unpromotePositionLesson(pdb, l1);
  ok(u1.ok, 'P13 撤回晋升成功');
  if (u1.ok) {
    ok(!u1.position.rules.includes('先复述判据再开工'), 'P14 撤回后从规范段移除');
    eq(u1.lesson.promotedTo, '', 'P15 撤回后清楚 promoted_to');
    ok(selectPositionLessonsForInjection(pdb, positionId).some((l) => l.id === l1), 'P16 撤回后恢复注入资格');
  }
  promotePositionLesson(pdb, l1, 'rules');
  const pos = getPosition(pdb, positionId)!;
  db.prepare("UPDATE wa_positions SET rules_json = ? WHERE id = ?")
    .run(JSON.stringify(['先复述判据再开工（人工改过）']), pos.id);
  const changed = unpromotePositionLesson(pdb, l1);
  ok(!changed.ok && changed.code === 'TEXT_CHANGED', 'P17 ★原文被人工改过 ⇒ 拒绝自动撤回（不按"差不多"删错）');

  // 静态接线：IPC 两跳 + 审计 + 页面按钮。
  const ipc = codeOf(`${A}/src/main/ipc/positions.ipc.ts`);
  ok(ipc.includes("ipcMain.handle('positions:promoteLesson'") && ipc.includes("ipcMain.handle('positions:unpromoteLesson'"),
    'P18 IPC 两跳在册');
  ok(ipc.includes("writeAudit('position.lesson_promote'") && ipc.includes("writeAudit('position.lesson_unpromote'"),
    'P19 晋升/撤回都留审计');
  const page = codeOf(`${A}/renderer/src/pages/PositionsPage.tsx`);
  ok(page.includes('positionsIpc.promoteLesson(') && page.includes('positionsIpc.unpromoteLesson(')
    && page.includes('POSITION_PROMOTE_TARGET_LABEL'),
    'P20 岗位页真接按钮（不是只建通道）');
  eq(POSITION_PROMOTE_TARGET_LABEL.rules, '规范', 'P21 晋升目标人话名一处派生');
}

/* ── B5「像」：岗位画像 ─────────────────────────────────────────────────── */

function sectionR(): void {
  console.log('\n【R】B5「像」岗位画像');
  const { db, pdb, positionId } = makeLessonDb();
  setProjectPositionEnabled(pdb, 'proj_a', positionId, true);

  insertLessonTask(db, 't_r1', positionId, { summary: '完成一' });
  insertLessonTask(db, 't_r2', positionId, { summary: '完成二' });
  insertLessonTask(db, 't_r3', positionId, { status: 'failed', summary: '失败一' });
  insertLessonTask(db, 't_r4', positionId, { status: 'executing', summary: '在办一' });

  const addLesson = (taskId: string, content: string, decision: 'accepted' | 'rejected'): string => {
    insertPositionLessonCandidate(pdb, { positionId, taskId, projectId: 'proj_a', content, source: 'retrospective', reusable: decision === 'accepted' });
    const id = (db.prepare('SELECT id FROM wa_position_lessons WHERE task_id = ?').get(taskId) as { id: string }).id;
    decidePositionLesson(pdb, id, decision);
    return id;
  };
  insertPositionLessonCandidate(pdb, { positionId, taskId: 't_rp', projectId: 'proj_a', content: '待审', source: 'retrospective', reusable: true });
  addLesson('t_ra', '采纳', 'accepted');
  addLesson('t_rr', '拒绝', 'rejected');
  const promoted = addLesson('t_rm', '已晋升', 'accepted');
  db.prepare("UPDATE wa_position_lessons SET promoted_to = 'rules', promoted_at = datetime('now') WHERE id = ?").run(promoted);

  const insInj = (id: string, taskId: string, outcome: string, tokens: number, chars: number): void => {
    db.prepare(`INSERT INTO wa_context_injections (id, task_id, source, ref_id, chars, est_tokens, outcome)
                VALUES (?, ?, 'position', ?, ?, ?, ?)`).run(id, taskId, `rule:${id}`, chars, tokens, outcome);
  };
  insInj('i1', 't_r1', 'completed', 10, 5);
  insInj('i2', 't_r3', 'failed', 20, 10);
  insInj('i3', 't_r4', 'pending', 30, 15);

  const p = positionProfile(pdb, positionId);
  ok(!!p, 'R1 画像可读');
  if (!p) return;
  eq([p.taskTotal, p.taskCompleted, p.taskFailed, p.taskActive, p.taskArchived],
    [4, 2, 1, 1, 0], 'R2 任务五态：总/完成/失败/在办/归档');
  eq(p.acceptancePassed, 2, 'R3 ★验收通过只数 completed 且 passed==criteria（失败/在办不算）');
  eq(p.projectCount, 1, 'R4 绑定且启用的项目数 = 1');
  eq([p.lessons.total, p.lessons.pending, p.lessons.accepted, p.lessons.rejected, p.lessons.promoted],
    [4, 1, 2, 1, 1], 'R5 经验四态 + 已晋升');
  eq([p.injections.available, p.injections.rows, p.injections.estTokens, p.injections.completed, p.injections.failed, p.injections.pending, p.injections.wasteChars],
    [true, 3, 60, 1, 1, 1, 10], 'R6 注入账：行/token/完成/失败/待结/失败浪费字数');
  ok(p.lastActive !== '', 'R7 最近活跃时刻非空（有任务时）');

  const empty = createPosition(pdb, { name: '空岗' });
  ok(empty.ok, 'R8 前置：空岗创建');
  if (empty.ok) {
    const ep = positionProfile(pdb, empty.position.id)!;
    eq([ep.taskTotal, ep.lessons.total, ep.injections.rows, ep.projectCount, ep.lastActive],
      [0, 0, 0, 0, ''], 'R9 ★无任务 ⇒ 全零 + 空活跃时刻（不编"一切正常"）');
  }

  // 注入账读不到 ⇒ available=false + 原因，不把读不到写成 0。
  const bare = makeLessonDb();
  bare.db.exec('DROP TABLE wa_context_injections');
  const bp = positionProfile(bare.pdb, bare.positionId)!;
  eq(bp.injections.available, false, 'R10 ★注入账表不可用 ⇒ available=false');
  ok(bp.injections.reason !== '', 'R11 失败原因如实带出');
  eq([bp.injections.rows, bp.injections.estTokens], [0, 0], 'R12 失败时数值保持 0（但已标不可用）');

  const ipc = codeOf(`${A}/src/main/ipc/positions.ipc.ts`);
  ok(ipc.includes("ipcMain.handle('positions:profile'") && ipc.includes('positionProfile(db, id)'),
    'R13 IPC 画像一跳走同一读模型');
  const page = codeOf(`${A}/renderer/src/pages/PositionsPage.tsx`);
  ok(page.includes('positionsIpc.profile(') && page.includes('还没有指派过任务') && page.includes('注入账不可用'),
    'R14 岗位页第一屏真用画像（空态/不可用态都说清）');
  ok(!page.includes('COUNT(*)'), 'R15 ★页面不自己写 SQL 计数（口径只在 main）');
}

/* ── B6「商」：岗位知识包导出/导入 + Pro 闸 ─────────────────────────────── */

function sectionK(): void {
  console.log('\n【K】B6「商」岗位知识包导出/导入');
  const { db, pdb, positionId } = makeLessonDb();
  const addAccepted = (taskId: string, content: string, reusable: boolean): void => {
    insertPositionLessonCandidate(pdb, { positionId, taskId, projectId: 'proj_a', content, source: 'retrospective', reusable });
    const id = (db.prepare('SELECT id FROM wa_position_lessons WHERE task_id = ?').get(taskId) as { id: string }).id;
    decidePositionLesson(pdb, id, 'accepted');
  };
  addAccepted('t_k1', '可迁移经验一', true);
  addAccepted('t_k2', '不可迁移经验二', false);
  insertPositionLessonCandidate(pdb, { positionId, taskId: 't_k3', projectId: 'proj_a', content: '未采纳的不导出', source: 'retrospective', reusable: true });
  db.prepare("UPDATE wa_positions SET rules_json = '[\"规范一\"]', skills_json = '[\"技能一\"]', knowledge_json = '[\"知识一\"]' WHERE id = ?").run(positionId);

  const built = buildPositionPackage(pdb, positionId);
  ok(built.ok, 'K1 导出成功');
  if (!built.ok) return;
  const pkg = built.value.package;
  eq([pkg.kind, pkg.version, pkg.position.name], [POSITION_PACKAGE_KIND, POSITION_PACKAGE_VERSION, '复盘岗'], 'K2 包头与岗位名');
  eq([pkg.position.rules, pkg.position.skills, pkg.position.knowledge], [['规范一'], ['技能一'], ['知识一']], 'K3 四段齐');
  eq(pkg.lessons.length, 2, 'K4 只导出已采纳（未采纳不导出）');
  eq(pkg.lessons.find((l) => l.content === '可迁移经验一')?.reusable, true, 'K5 ★reusable 标记随包走（可迁移=1）');
  eq(pkg.lessons.find((l) => l.content === '不可迁移经验二')?.reusable, false, 'K5b 不可迁移标记随包走（=0）');
  ok(built.value.fileName.startsWith('岗位-') && built.value.fileName.endsWith('.json'), 'K6 文件名可读且有后缀');

  const parsed = parsePositionPackage(JSON.stringify(pkg));
  ok(parsed.ok, 'K7 合法包可解析');
  if (!parsed.ok) return;
  eq(parsed.value.lessons.length, 2, 'K8 解析后经验数不变');

  const bad = (mut: (o: Record<string, unknown>) => void, label: string, code: string): void => {
    const o = JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>;
    mut(o);
    const r = parsePositionPackage(JSON.stringify(o));
    ok(!r.ok && r.code === code, label, r.ok ? 'parsed' : r.code);
  };
  bad((o) => { o.kind = 'x'; }, 'K9 坏 kind 拒绝', 'BAD_KIND');
  bad((o) => { o.version = 2; }, 'K10 坏版本拒绝', 'BAD_VERSION');
  bad((o) => { (o.position as Record<string, unknown>).name = ''; }, 'K11 空岗位名拒绝', 'BAD_SHAPE');
  bad((o) => { const l = o.lessons as Array<Record<string, unknown>>; l.push({ ...l[0] }); }, 'K12 包内重复经验拒绝', 'DUPLICATE_LESSON');
  bad((o) => { o.lessons = Array.from({ length: 101 }, (_, i) => ({ content: `经验${i}`, reusable: true })); }, 'K13 经验超量拒绝', 'TOO_MANY');

  // 导入到空库：新建岗位 + 经验 pending/imported。
  const fdb = makeBoardDb();
  const fpdb = fdb as unknown as PositionDb;
  eq((fdb.prepare('SELECT COUNT(*) AS c FROM wa_position_imports').get() as { c: number }).c, 0, 'K14 前置：导入回执 0 行');
  const first = importPositionPackage(fpdb, parsed.value, 'merge', 'pkg.json');
  ok(first.ok, 'K15 导入成功');
  if (!first.ok) return;
  eq([first.value.created, first.value.mode, first.value.addedLessons, first.value.skippedLessons], [true, 'merge', 2, 0], 'K16 新建岗位 + 两条经验');
  const imported = fpdb.prepare("SELECT content, status, origin, reusable, task_id, project_id FROM wa_position_lessons").all() as Array<Record<string, unknown>>;
  eq(imported.length, 2, 'K17 两条经验都落库');
  ok(imported.every((r) => r.status === 'pending' && r.origin === 'imported'), 'K17b ★导入经验一律 pending/imported（不自动采纳）');
  eq(imported.map((r) => Number(r.reusable)).sort(), [0, 1], 'K17c reusable 标记随包保留');
  ok(imported.every((r) => String(r.task_id).startsWith('imported:') && r.project_id === ''), 'K18 导入行不伪造本机任务/项目');
  eq((fdb.prepare('SELECT COUNT(*) AS c FROM wa_position_imports').get() as { c: number }).c, 1, 'K19 导入回执 0→1');

  const second = importPositionPackage(fpdb, parsed.value, 'merge', 'pkg.json');
  ok(second.ok, 'K20 重复导入成功');
  if (second.ok) eq([second.value.created, second.value.addedLessons, second.value.skippedLessons], [false, 0, 2], 'K21 ★重复经验跳过（不重复落行）');
  eq(positionLessonImportKey('同一句'), positionLessonImportKey('同一句'), 'K22 导入行 key 对同内容稳定');

  // merge 不覆盖本机内容；replace 必须显式且覆盖四段。
  const local = createPosition(fpdb, { name: '合并岗', rules: ['本机规范'] });
  ok(local.ok, 'K23 前置：本机同名岗位');
  const mergePkg = { ...parsed.value, position: { ...parsed.value.position, name: '合并岗', rules: ['本机规范', '包内规范'], skills: [], knowledge: [] }, lessons: [] };
  const merged = importPositionPackage(fpdb, mergePkg, 'merge');
  ok(merged.ok, 'K24 合并导入成功');
  if (merged.ok) {
    eq(merged.value.addedSections, 1, 'K25 只补缺失条目');
    ok(merged.value.position.rules.includes('本机规范') && merged.value.position.rules.includes('包内规范'), 'K26 ★merge 不覆盖本机已有规范');
  }
  const replacePkg = { ...parsed.value, position: { ...parsed.value.position, name: '合并岗', rules: ['包内规范'] }, lessons: [] };
  const replaced = importPositionPackage(fpdb, replacePkg, 'replace');
  ok(replaced.ok, 'K27 覆盖导入成功');
  if (replaced.ok) eq(replaced.value.position.rules, ['包内规范'], 'K28 ★replace 显式覆盖（本机旧规范被替换）');

  // Pro 闸：community 锁、pro/team/trial 放行。
  eq(proUnlocked({ tier: 'community', kind: 'license' }), false, 'K29 社区档 ⇒ 锁定');
  eq([proUnlocked({ tier: 'pro', kind: 'license' }), proUnlocked({ tier: 'team', kind: 'license' }), proUnlocked({ tier: 'community', kind: 'trial' })],
    [true, true, true], 'K30 Pro/Team/试用 ⇒ 放行');
  ok((PRO_FEATURES as readonly string[]).includes('position_transfer'), 'K31 能力词表含 position_transfer');
  ok(PRO_FEATURE_LABEL.position_transfer.includes('岗位知识包'), 'K32 人话名说清是岗位知识包');

  const ipc = codeOf(`${A}/src/main/ipc/positions.ipc.ts`);
  const gate = "proFeatureRefusal(db, 'position_transfer')";
  const exportBlock = ipc.slice(ipc.indexOf("ipcMain.handle('positions:export'"), ipc.indexOf("ipcMain.handle('positions:import'"));
  const importBlock = ipc.slice(ipc.indexOf("ipcMain.handle('positions:import'"));
  ok(exportBlock.includes(gate) && exportBlock.indexOf(gate) < exportBlock.indexOf('showSaveDialog'),
    'K33 ★导出：先闸后读后写（社区档不弹框、零文件）');
  ok(importBlock.includes(gate) && importBlock.indexOf(gate) < importBlock.indexOf('showOpenDialog'),
    'K33b ★导入：先闸后整包校验再写（社区档不弹框、零写入）');
  const pricing = codeOf(`${A}/src/main/core/pricing.ts`);
  const catalog = codeOf(`${A}/src/main/core/tier-catalog.ts`);
  ok(pricing.includes('岗位知识包导出/导入（跨机带走经验）') && catalog.includes('position_transfer'),
    'K34 价目表与兑现登记同句同键');
  const page = codeOf(`${A}/renderer/src/pages/PositionsPage.tsx`);
  ok(page.includes('positionsIpc.exportPackage(') && page.includes('positionsIpc.importPackage('),
    'K35 岗位页真接导出/导入（不是只建通道）');
}

async function main(): Promise<void> {
  sectionS();
  sectionI();
  sectionL();
  sectionU();
  sectionP();
  sectionR();
  sectionK();

  console.log(`\n[rr_zx_20261113_1] ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error('\nrr_zx_20261113_1 未捕获异常（复跑未跑完，不得读作通过）：', e);
  console.log(`\n[rr_zx_20261113_1] ${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
