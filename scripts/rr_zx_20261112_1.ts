/**
 * zx_20261112_1「任·答·诊·衡」——岗位在册可派活 / 跨机认岗 / IM 有问必答 / 任务可诊断 / 档位一把尺。
 *
 * 判据分组（随批次逐步补齐）：
 *   S「基」构建钉 P1–P6 + 本轮方案在册。
 *   A「岗」`core/positions.ts`：四段有界、内置种子幂等、注入块上限、打分只作建议。
 *   B「任」任务岗位绑定、岗位详情一次性派活、position 注入块、收口候选与人工采纳。
 *   C「答」IM 首聊欢迎、帮助 10 条、暂停/继续、任务名候选澄清（假时钟）。
 *   D「诊」任务操作分层、子任务树、失败证据、模型可用性五因、ANS 连接测试接线。
 *   E「衡」类目忙闲降权、节点卡岗位公示、派发摘要边界、跨机闸派生、文档对码。
 *
 * 纪律：
 *   - 夹具自建 DDL（不跑 initDatabase），顺序按生产初始化；
 *   - 文案断言只钉关键子串，不钉整句（改文案不该弄红判据）；
 *   - 不写"只为下一轮"的字面量；轮次钉由 checkBuildPins 从真源派生。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { routeImMessage } from '../apps/worker-ant-desktop/src/main/services/im-router.js';
import {
  BUILTIN_IM_COMMANDS,
  WELCOME_COMMAND_NAMES,
  buildWelcomeText,
  parseTaskPauseResume,
} from '../apps/worker-ant-desktop/src/main/services/im-commands.js';
import {
  DISAMBIGUATION_TTL_MS,
  buildDisambiguation,
  findActiveTasks,
  isDisambiguationExpired,
  pauseRefusal,
  pickDisambiguation,
  resumeRefusal,
} from '../apps/worker-ant-desktop/src/main/core/im-task-target.js';
// B4「诊」：动作分层与子任务树是零依赖纯模块（renderer/src/lib），模型可用性同引 main 侧的同一把尺。
import { taskActionLayout, ACTION_LABEL, actionTitle, type TaskActionKey } from '../apps/worker-ant-desktop/renderer/src/lib/task-actions.js';
import { buildTaskTree, flattenTaskTree, familyProgress } from '../apps/worker-ant-desktop/renderer/src/lib/task-tree.js';
import { describeModelAvailability } from '../apps/worker-ant-desktop/renderer/src/lib/model-availability.js';
import { endpointTestLine } from '../apps/worker-ant-desktop/renderer/src/lib/probe-models.js';
import { collectDescendants, TASK_FAMILY_MAX_DEPTH } from '../apps/worker-ant-desktop/src/main/core/task-family.js';
import {
  BUILTIN_POSITION_NAMES,
  POSITION_BLOCK_ITEMS,
  POSITION_BLOCK_MAX,
  POSITION_DISPATCH_SUMMARY_MAX,
  POSITION_LESSON_MAX,
  POSITIONS_DDL,
  createPosition,
  decidePositionLesson,
  deletePosition,
  generatePositionLessonCandidate,
  getPosition,
  getPositionByName,
  getPositionDetail,
  insertPositionLessonCandidate,
  listAcceptedLessons,
  listPositions,
  listProjectEnabledPositions,
  positionBlock,
  positionDispatchSummary,
  resolveTaskPosition,
  sanitizeDispatchPosition,
  sanitizePosition,
  scorePositionsForTask,
  seedBuiltinPositions,
  setPositionEnabled,
  setProjectPositionEnabled,
  updatePosition,
  type PositionDb,
} from '../apps/worker-ant-desktop/src/main/core/positions.js';
// B5「衡」：类目忙闲、跨机认岗、档位一把尺、载荷边界。
import {
  CLASS_PRESSURE_PENALTY_MAX,
  CLASS_PRESSURE_RATIO,
  POSITION_BONUS_MAX,
  classPressurePenalty,
  matchNode,
  positionBonus,
  type NodeMatchProfile,
} from '../apps/worker-ant-desktop/src/main/core/node-match.js';
import {
  classRunningOfRows,
  deriveClassRunning,
  emptyClassRunning,
  sanitizeClassRunning,
} from '../apps/worker-ant-desktop/src/main/core/node-class-load.js';
import {
  requirementsForTask,
  sanitizeDispatchRequirements,
  type DispatchRequirements,
} from '../apps/worker-ant-desktop/src/main/core/task-capability.js';
import { NODE_CARD_POSITIONS_MAX, deriveCardPositions } from '../apps/worker-ant-desktop/src/main/core/node-card.js';
import { teamUnlocked } from '../apps/worker-ant-desktop/src/main/core/team-gate.js';
import { TIER_LIMITS } from '../apps/worker-ant-desktop/src/main/core/feature-limits.js';
import {
  capabilityPrereqRefusal,
  resolveProjectDispatchMode,
} from '../apps/worker-ant-desktop/src/main/core/project-dispatch-mode.js';
import { buildDispatchPayload, dispatchPositionOfTask } from '../apps/worker-ant-desktop/src/main/core/collab-dispatch.js';
import { relayPosition } from '../apps/worker-ant-desktop/src/main/core/node-request-runner.js';
// 渲染层同引（岗位标签/六类目条的真源），与页面共用同一份投影。
import { classLoadView, nodePositions } from '../apps/worker-ant-desktop/renderer/src/lib/node-view.js';

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

  // 方案里写死的边界是实施期的护栏：这两条口径若被删，说明范围漂移了。
  // 轮次名由本脚本文件名派生（feedback: 断言不得写「只为下一轮」的字面量）。
  const selfRound = path.basename(__filename, '.ts').replace(/^rr_/, '');
  const plan = readSrc(`plans/improve/${selfRound}.md`);
  ok(plan.includes(selfRound), 'S1 本轮方案在册且带轮次名');
  ok(plan.includes('一次性派活') && plan.includes('公示 + 摘要'),
    'S2 方案记下岗位派活与跨机岗位口径（防实施时漂移）');
}

// ── 以下分组随 B1–B5 逐批填充；B0 只保证入口在册、收尾账可被汇总器读到 ──

/** 夹具：生产同源 DDL（positions）+ 被读模型 JOIN 的最小邻表。 */
function makePositionsDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT '');
    CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, status TEXT NOT NULL DEFAULT 'active');
    -- zx_20261112_1 B2: 收口候选读 status/position_id/context_json；与生产列同名同缺省。
    CREATE TABLE wa_tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending', position_id TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '', context_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(POSITIONS_DDL);
  db.prepare("INSERT INTO wa_projects (id, name, status) VALUES ('proj_a', '甲项目', 'active')").run();
  db.prepare("INSERT INTO wa_projects (id, name, status) VALUES ('proj_arch', '已归档项目', 'archived')").run();
  db.prepare("INSERT INTO wa_tasks (id, title) VALUES ('task_a', '把周报跑通')").run();
  db.prepare("INSERT INTO wa_tasks (id, title) VALUES ('task_b', '把口径对齐')").run();
  return db;
}

function sectionA(): void {
  console.log('\n【A】岗位实体');
  const db = makePositionsDb();
  const pdb = db as unknown as PositionDb;
  const builtinCount = BUILTIN_POSITION_NAMES.length;

  // A1–A3 内置种子：首次播种 = 内置数；再播 0 条；库内不重复。
  eq(seedBuiltinPositions(pdb), builtinCount, 'A1 首次播种 = 内置岗位数');
  eq(seedBuiltinPositions(pdb), 0, 'A2 再播 0 条（幂等）');
  eq(listPositions(pdb).length, builtinCount, 'A3 播种后库内恰好内置数');

  // A4 删掉的内置岗不因重播复活（seed marker 生效）。
  const pm = getPositionByName(pdb, '项目经理');
  ok(!!pm, 'A4 可按名取到内置岗位');
  if (pm) deletePosition(pdb, pm.id);
  eq(seedBuiltinPositions(pdb), 0, 'A5 删除后重播不复活内置岗');
  eq(listPositions(pdb).length, builtinCount - 1, 'A6 删除后岗位数减一');

  // A7–A12 四段校验：非法整块拒绝，且不落库。
  const before = listPositions(pdb).length;
  eq(sanitizePosition({ name: '   ' }).ok, false, 'A7 空名称拒绝');
  eq((sanitizePosition({ name: 'x'.repeat(81) }) as { code?: string }).code, 'NAME_TOO_LONG', 'A8 名称超长拒绝');
  eq((sanitizePosition({ name: '复核岗', description: 'x'.repeat(801) }) as { code?: string }).code, 'DESCRIPTION_TOO_LONG', 'A9 说明超长拒绝');
  eq((sanitizePosition({ name: '复核岗', rules: Array.from({ length: 21 }, (_, i) => `规范${i}`) }) as { code?: string }).code, 'LIST_TOO_MANY', 'A10 规范超条拒绝');
  eq((sanitizePosition({ name: '复核岗', skills: ['x'.repeat(201)] }) as { code?: string }).code, 'ITEM_TOO_LONG', 'A11 单条超长拒绝');
  const rejected = createPosition(pdb, { name: '复核岗', description: 'x'.repeat(801) });
  eq(rejected.ok, false, 'A12 超长岗位写入被拒');
  eq(listPositions(pdb).length, before, 'A13 被拒后不落库（条数不变）');

  const dedup = sanitizePosition({ name: '去重岗', rules: ['同一条', '同一条'] });
  ok(dedup.ok && dedup.value.rules.length === 1, 'A14 列表去重');
  ok(dedup.ok && dedup.value.category === 'custom', 'A15 分类缺省 custom');

  // A16–A19 创建 / 同名 / 更新版本。
  const custom = createPosition(pdb, {
    name: '数据分析师', category: 'analysis', description: '把数据变成结论',
    rules: ['先对齐口径'], skills: ['SQL', '数据分析'], knowledge: ['口径表在 wiki'],
  });
  ok(custom.ok, 'A16 合法岗位创建成功');
  if (!custom.ok) return;
  eq((createPosition(pdb, { name: '数据分析师' }) as { code?: string }).code, 'DUPLICATE_NAME', 'A17 同名岗位拒绝');
  eq(listPositions(pdb).length, before + 1, 'A18 只落一条自定义岗位');
  const upd = updatePosition(pdb, custom.position.id, { name: '数据分析师', description: '新说明', skills: ['SQL'] });
  ok(upd.ok && upd.position.version === 2, 'A19 更新后版本 +1');
  const dupUpd = updatePosition(pdb, custom.position.id, { name: '架构师' });
  eq((dupUpd as { code?: string }).code, 'DUPLICATE_NAME', 'A20 改名撞既有岗拒绝');
  eq(getPosition(pdb, custom.position.id)?.version, 2, 'A21 撞名失败不涨版本');

  // A22–A26 项目启用 / 禁用岗位可选性。
  setProjectPositionEnabled(pdb, 'proj_a', custom.position.id, true);
  eq(listProjectEnabledPositions(pdb, 'proj_a').map((p) => p.id), [custom.position.id], 'A22 绑定后项目可指派');
  setPositionEnabled(pdb, custom.position.id, false);
  eq(listProjectEnabledPositions(pdb, 'proj_a').length, 0, 'A23 岗位停用即撤下');
  setPositionEnabled(pdb, custom.position.id, true);
  setProjectPositionEnabled(pdb, 'proj_a', custom.position.id, false);
  eq(listProjectEnabledPositions(pdb, 'proj_a').length, 0, 'A24 项目解绑即撤下');
  setProjectPositionEnabled(pdb, 'proj_a', custom.position.id, true);
  setProjectPositionEnabled(pdb, 'proj_arch', custom.position.id, true);
  const detail = getPositionDetail(pdb, custom.position.id);
  eq(detail?.projects.map((p) => p.id), ['proj_a'], 'A25 详情不列已归档项目');
  ok(detail?.projects[0]?.enabled === true, 'A26 详情回显启用态');

  // A27–A33 经验候选：重跑不重复；pending 不注入；采纳才注入；拒绝永不注入。
  eq(insertPositionLessonCandidate(pdb, { positionId: custom.position.id, taskId: 'task_a', projectId: 'proj_a', content: '口径先找 wiki' }), true, 'A27 首写候选 0→1');
  eq(insertPositionLessonCandidate(pdb, { positionId: custom.position.id, taskId: 'task_a', projectId: 'proj_a', content: '重复内容' }), false, 'A28 同任务重跑不再插');
  eq(insertPositionLessonCandidate(pdb, { positionId: custom.position.id, taskId: 'task_b', projectId: 'proj_a', content: '拒绝的经验' }), true, 'A29 第二条候选写入');
  const lessons = getPositionDetail(pdb, custom.position.id)?.lessons ?? [];
  eq(lessons.length, 2, 'A30 两条候选均在册');
  ok(lessons[0]?.taskTitle === '把周报跑通' || lessons[1]?.taskTitle === '把周报跑通', 'A31 候选带任务标题');
  const pendingBlock = positionBlock(custom.position, lessons);
  ok(!pendingBlock.includes('口径先找 wiki'), 'A32 pending 经验不注入');
  const firstLesson = lessons.find((l) => l.taskId === 'task_a')!;
  ok(decidePositionLesson(pdb, firstLesson.id, 'accepted').ok, 'A33 pending → accepted');
  eq((decidePositionLesson(pdb, firstLesson.id, 'accepted') as { code?: string }).code, 'ALREADY_DECIDED', 'A34 已决不可再决');
  eq(listAcceptedLessons(pdb, custom.position.id).length, 1, 'A35 采纳经验在册 1 条');
  const acceptedBlock = positionBlock(getPosition(pdb, custom.position.id)!, listAcceptedLessons(pdb, custom.position.id));
  ok(acceptedBlock.includes('口径先找 wiki'), 'A36 采纳经验进入注入');
  const secondLesson = (getPositionDetail(pdb, custom.position.id)?.lessons ?? []).find((l) => l.taskId === 'task_b')!;
  ok(decidePositionLesson(pdb, secondLesson.id, 'rejected').ok, 'A37 第二条置为拒绝');
  const afterReject = positionBlock(getPosition(pdb, custom.position.id)!, listAcceptedLessons(pdb, custom.position.id));
  ok(!afterReject.includes('拒绝的经验'), 'A38 拒绝经验不注入');

  // A39–A43 有界注入：≤1200 且超预算整段停（低优先级不越位）。
  const fat = {
    // 说明恰好塞得进、但只剩不到 7 字余量：规范整段放不下（不截半句、不越位）。
    name: '长文岗', description: 'x'.repeat(POSITION_BLOCK_MAX - 15),
    rules: ['规范甲'], skills: ['技能甲'], knowledge: ['知识甲'],
  };
  const fatBlock = positionBlock(fat, []);
  ok(fatBlock.length <= POSITION_BLOCK_MAX, `A39 注入块不超上限（${fatBlock.length} ≤ ${POSITION_BLOCK_MAX}）`);
  ok(fatBlock.includes('说明：') && !fatBlock.includes('规范甲'), 'A40 说明占满预算后低优先级不越位');
  const tight = positionBlock({ name: '窄岗', description: 'y'.repeat(100), rules: ['规范'], skills: [], knowledge: [] }, [], 60);
  ok(tight.length <= 60 && !tight.includes('规范'), 'A41 自定义预算同样整段停');
  const noName = positionBlock({ name: '', description: 'x', rules: [], skills: [], knowledge: [] });
  eq(noName, '', 'A42 无名称不产块');

  // A43–A46 跨机摘要：≤600，只带说明/规范，绝不带知识与经验。
  const summary = positionDispatchSummary({
    name: '摘要岗', description: '对外说明', rules: ['公开规范'], skills: [], knowledge: ['内部知识'],
  });
  ok(summary.length <= POSITION_DISPATCH_SUMMARY_MAX, 'A43 摘要不超 600 字');
  ok(summary.includes('对外说明') && summary.includes('公开规范'), 'A44 摘要含说明与规范');
  ok(!summary.includes('内部知识') && !summary.includes('口径先找 wiki'), 'A45 摘要不含知识与经验');
  const fatSummary = positionDispatchSummary({ name: '长摘要', description: 'z'.repeat(900), rules: ['规范'], skills: [], knowledge: [] }, 600);
  ok(fatSummary.length <= POSITION_DISPATCH_SUMMARY_MAX && !fatSummary.includes('规范'), 'A46 摘要超预算整段停');

  // A47–A50 建议打分：确定性、命中去重、零文本空。
  const pool = [
    { id: 'pos_x', name: '数据分析师', category: 'analysis', skills: ['SQL', '数据分析'], rules: [], knowledge: [] },
    { id: 'pos_y', name: '测试', category: 'tech', skills: ['回归测试'], rules: [], knowledge: [] },
  ];
  const s1 = scorePositionsForTask(pool, '帮我用 SQL 做数据分析');
  const s2 = scorePositionsForTask(pool, '帮我用 SQL 做数据分析');
  eq(s1, s2, 'A47 打分为确定性结果');
  eq(s1[0]?.positionId, 'pos_x', 'A48 命中多者排前');
  eq(s1[0]?.hits.length, new Set(s1[0]?.hits).size, 'A49 命中词去重');
  eq(scorePositionsForTask(pool, '   ').length, 0, 'A50 空文本不出建议');

  // A51–A55 删除岗位：解除绑定、保留经验、如实回报。
  const del = deletePosition(pdb, custom.position.id);
  eq(del, { deleted: true, unboundProjects: 2, keptLessons: 2 }, 'A51 删除回报绑定/经验数');
  eq(getPosition(pdb, custom.position.id), null, 'A52 岗位已删');
  const kept = db.prepare('SELECT COUNT(*) AS n FROM wa_position_lessons WHERE position_id = ?').get(custom.position.id) as { n: number };
  eq(Number(kept.n), 2, 'A53 经验行保留在库');
  eq(listAcceptedLessons(pdb, custom.position.id).length, 1, 'A54 保留的经验仍可读');
  eq(deletePosition(pdb, custom.position.id), { deleted: false, unboundProjects: 0, keptLessons: 0 }, 'A55 再删如实回报未删');

  // A56–A60 接线在册：DDL/种子/IPC/路由/导航/页面消费同一套真源。
  const dbCode = codeOf('apps/worker-ant-desktop/src/main/database.ts');
  ok(dbCode.includes('POSITIONS_DDL') && dbCode.includes('seedBuiltinPositions'), 'A56 database 执行同源 DDL 并播种');
  const indexCode = codeOf('apps/worker-ant-desktop/src/main/index.ts');
  ok(indexCode.includes('initPositionsIpc(db)'), 'A57 main 注册岗位 IPC');
  const ipcCode = codeOf('apps/worker-ant-desktop/src/main/ipc/positions.ipc.ts');
  const channels = ['positions:list', 'positions:get', 'positions:create', 'positions:update', 'positions:toggle',
    'positions:delete', 'positions:projectToggle', 'positions:lessons', 'positions:decideLesson'];
  ok(channels.every((c) => ipcCode.includes(`'${c}'`)), 'A58 九个 IPC 通道齐备');
  const navCode = codeOf('apps/worker-ant-desktop/renderer/src/lib/navConfig.ts');
  ok(navCode.includes("to: '/positions'"), 'A59 导航含岗位入口');
  const appCode = codeOf('apps/worker-ant-desktop/renderer/src/App.tsx');
  ok(appCode.includes('PositionsPage') && appCode.includes('path="/positions"'), 'A60 路由在册');
  const pageCode = codeOf('apps/worker-ant-desktop/renderer/src/pages/PositionsPage.tsx');
  ok(pageCode.includes('positionsIpc.get') && pageCode.includes('positionsIpc.decideLesson'),
    'A61 管理页消费岗位 IPC（详情/经验确认）');
}

function sectionB(): void {
  console.log('\n【B】任务指派、岗位派活与收口沉淀');
  const db = makePositionsDb();
  const pdb = db as unknown as PositionDb;

  // B1–B5 块序与注入接线：position 紧随 self_rules、且在稳定前缀之外（岗位随任务变，混进前缀会毁缓存）。
  const ctxCode = codeOf('apps/worker-ant-desktop/src/main/core/exec-context.ts');
  const orderSrc = ctxCode.match(/CONTEXT_BLOCK_ORDER = \[([\s\S]*?)\] as const/)?.[1] ?? '';
  const order = [...orderSrc.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  eq(order[order.indexOf('self_rules') + 1], 'position', 'B1 position 块紧随 self_rules');
  ok(order.includes('position'), 'B2 块序从真源解析到 position');
  const stableSrc = ctxCode.match(/STABLE_PREFIX_BLOCKS = \[([\s\S]*?)\] as const/)?.[1] ?? '';
  const stable = [...stableSrc.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  ok(stable.length > 0 && !stable.includes('position'), 'B3 position 不进稳定前缀（任务相关）');
  ok(ctxCode.includes('if (pid)') && ctxCode.indexOf("add('position'") > ctxCode.indexOf('if (pid)'),
    'B4 岗位块只在 pid 非空分支内 add（未指派上下文不变）');
  // zx_20261113_1 B3「用」：执行期改用**条目级**选择器——按更强形状重定向（不是放宽）。
  ok(ctxCode.includes('resolveTaskPosition(db, projectId, pid)')
    && ctxCode.includes('positionBlockDetail(position')
    && ctxCode.includes('selectPositionLessonsForInjection(db, pid)'),
    'B5 注入读「岗位 + 可迁移经验」同一真源（条目级选择器）');

  // B6–B13 可指派判据：岗位启用 ∧ 项目绑定启用，缺一不可。
  const pos = createPosition(pdb, { name: '派活岗', description: '把事做成', rules: ['先对齐验收'], skills: ['执行'], knowledge: [] });
  ok(pos.ok, 'B6 建立派活岗位');
  if (!pos.ok) return;
  const pid = pos.position.id;
  eq(resolveTaskPosition(pdb, 'proj_a', pid), null, 'B7 项目未启用 ⇒ 不可指派');
  setProjectPositionEnabled(pdb, 'proj_a', pid, true);
  eq(resolveTaskPosition(pdb, 'proj_a', pid)?.id, pid, 'B8 已启用 ⇒ 可指派');
  setPositionEnabled(pdb, pid, false);
  eq(resolveTaskPosition(pdb, 'proj_a', pid), null, 'B9 岗位停用 ⇒ 不可指派');
  setPositionEnabled(pdb, pid, true);
  setProjectPositionEnabled(pdb, 'proj_a', pid, false);
  eq(resolveTaskPosition(pdb, 'proj_a', pid), null, 'B10 项目解绑 ⇒ 不可指派');
  setProjectPositionEnabled(pdb, 'proj_a', pid, true);
  eq(resolveTaskPosition(pdb, 'proj_arch', pid), null, 'B11 其他项目未绑定 ⇒ 不可指派');
  eq(resolveTaskPosition(pdb, '', pid), null, 'B12 空项目 ⇒ null');
  eq(resolveTaskPosition(pdb, 'proj_a', ''), null, 'B13 空岗位 ⇒ null');

  let seq = 0;
  const insertTask = (patch: { status?: string; positionId?: string; ctx?: Record<string, unknown> } = {}): string => {
    const id = `t_b${++seq}`;
    db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, position_id, context_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'proj_a', id, patch.status ?? 'completed', patch.positionId ?? '', JSON.stringify(patch.ctx ?? {}));
    return id;
  };
  const passedCtx = (summary = '先对齐口径再动手，最后按判据复核。') => ({
    acceptance_check: { checked_at: '2026-11-12T00:00:00Z', criteria_total: 2, passed_total: 2 },
    completion_summary: summary,
  });
  const lessonCount = (taskId: string): number =>
    Number((db.prepare('SELECT COUNT(*) AS n FROM wa_position_lessons WHERE task_id = ?').get(taskId) as { n: number }).n);

  // B14–B28 收口候选：完成+验收通过+有摘要才沉淀；其余一律零候选。
  const okTask = insertTask({ positionId: pid, ctx: passedCtx('先对齐口径再动手，收口按判据复核') });
  eq(generatePositionLessonCandidate(pdb, okTask), true, 'B14 完成+验收通过+有摘要 ⇒ 生成候选 0→1');
  eq(generatePositionLessonCandidate(pdb, okTask), false, 'B15 同一任务重跑不再生成');
  eq(lessonCount(okTask), 1, 'B16 同一任务只落 1 条候选');
  const okLessons = (getPositionDetail(pdb, pid)?.lessons ?? []).filter((l) => l.taskId === okTask);
  ok((okLessons[0]?.content ?? '').length <= POSITION_LESSON_MAX, 'B17 候选内容 ≤300 字');
  ok((okLessons[0]?.content ?? '').includes('对齐口径'), 'B18 候选内容取自既有收口摘要');

  const noAccept = insertTask({ positionId: pid, ctx: { completion_summary: '有摘要没验收' } });
  eq(generatePositionLessonCandidate(pdb, noAccept), false, 'B19 未验收 ⇒ 零候选');
  const failedAccept = insertTask({ positionId: pid, ctx: { acceptance_check: { checked_at: '2026-11-12T00:00:00Z', criteria_total: 2, passed_total: 1 }, completion_summary: '有一条没过' } });
  eq(generatePositionLessonCandidate(pdb, failedAccept), false, 'B20 验收未通过 ⇒ 零候选');
  const failedTask = insertTask({ status: 'failed', positionId: pid, ctx: passedCtx() });
  eq(generatePositionLessonCandidate(pdb, failedTask), false, 'B21 非完成状态 ⇒ 零候选');
  const archivedTask = insertTask({ status: 'archived', positionId: pid, ctx: passedCtx() });
  eq(generatePositionLessonCandidate(pdb, archivedTask), false, 'B22 归档 ⇒ 零候选');
  const dispatched = insertTask({ positionId: pid, ctx: { ...passedCtx(), assigned_node_id: 'node_remote_1' } });
  eq(generatePositionLessonCandidate(pdb, dispatched), false, 'B23 跨机派发 ⇒ 本机不沉淀');
  const emptySummary = insertTask({ positionId: pid, ctx: { acceptance_check: { checked_at: '2026-11-12T00:00:00Z', criteria_total: 1, passed_total: 1 }, completion_summary: '   ' } });
  eq(generatePositionLessonCandidate(pdb, emptySummary), false, 'B24 无收口摘要 ⇒ 零候选');
  const unassigned = insertTask({ ctx: passedCtx() });
  eq(generatePositionLessonCandidate(pdb, unassigned), false, 'B25 未指派岗位 ⇒ 零候选');
  eq(generatePositionLessonCandidate(pdb, 'no_such_task'), false, 'B26 任务不存在 ⇒ false');
  eq(generatePositionLessonCandidate(pdb, ''), false, 'B27 空任务 id ⇒ false');
  const ghostPos = createPosition(pdb, { name: '将被删除岗' });
  if (ghostPos.ok) {
    setProjectPositionEnabled(pdb, 'proj_a', ghostPos.position.id, true);
    const ghostTask = insertTask({ positionId: ghostPos.position.id, ctx: passedCtx() });
    deletePosition(pdb, ghostPos.position.id);
    eq(generatePositionLessonCandidate(pdb, ghostTask), false, 'B28 岗位已删 ⇒ 零候选');
  }

  // B29–B38 注入可观测：pending 不进、采纳进、拒绝不进、禁用即撤、上界生效。
  const resolved = resolveTaskPosition(pdb, 'proj_a', pid);
  ok(!!resolved, 'B29 可解析到岗位');
  if (!resolved) return;
  ok(!positionBlock(resolved, listAcceptedLessons(pdb, pid)).includes('先对齐口径再动手'), 'B30 pending 候选不进注入');
  ok(decidePositionLesson(pdb, okLessons[0]!.id, 'accepted').ok, 'B31 采纳候选');
  const acceptedBlock = positionBlock(resolveTaskPosition(pdb, 'proj_a', pid)!, listAcceptedLessons(pdb, pid));
  ok(acceptedBlock.includes('先对齐口径再动手'), 'B32 采纳后进入注入');
  ok(acceptedBlock.length <= POSITION_BLOCK_MAX, 'B33 注入总长 ≤1200');
  const many = positionBlock({ name: '多规范岗', description: '', rules: ['规一', '规二', '规三', '规四', '规五'], skills: [], knowledge: [] }, []);
  ok(many.includes('规一') && many.includes('规三') && !many.includes('规四'), 'B34 规范最多 3 条');
  const pos2 = createPosition(pdb, { name: '经验岗' });
  if (pos2.ok) {
    setProjectPositionEnabled(pdb, 'proj_a', pos2.position.id, true);
    for (let i = 0; i < 4; i++) {
      insertPositionLessonCandidate(pdb, { positionId: pos2.position.id, taskId: `les_${i}`, projectId: 'proj_a', content: `经验${i}` });
    }
    for (const l of (getPositionDetail(pdb, pos2.position.id)?.lessons ?? [])) decidePositionLesson(pdb, l.id, 'accepted');
    const b = positionBlock(getPosition(pdb, pos2.position.id)!, listAcceptedLessons(pdb, pos2.position.id));
    const hits = ['经验0', '经验1', '经验2', '经验3'].filter((s) => b.includes(s));
    eq(hits.length, POSITION_BLOCK_ITEMS, 'B35 经验最多 3 条');
    setPositionEnabled(pdb, pos2.position.id, false);
    const gate = resolveTaskPosition(pdb, 'proj_a', pos2.position.id);
    eq(gate ? positionBlock(gate, listAcceptedLessons(pdb, pos2.position.id)) : '', '', 'B36 岗位停用 ⇒ 下一轮注入块为空');
    setPositionEnabled(pdb, pos2.position.id, true);
    const reGate = resolveTaskPosition(pdb, 'proj_a', pos2.position.id);
    ok(!!reGate && positionBlock(reGate, listAcceptedLessons(pdb, pos2.position.id)) !== '', 'B37 重新启用 ⇒ 注入恢复');
  }
  const rejectTask = insertTask({ positionId: pid, ctx: passedCtx('这条经验会被拒绝') });
  generatePositionLessonCandidate(pdb, rejectTask);
  const rejectLesson = (getPositionDetail(pdb, pid)?.lessons ?? []).find((l) => l.taskId === rejectTask)!;
  decidePositionLesson(pdb, rejectLesson.id, 'rejected');
  ok(!positionBlock(resolveTaskPosition(pdb, 'proj_a', pid)!, listAcceptedLessons(pdb, pid)).includes('这条经验会被拒绝'), 'B38 拒绝的经验不注入');

  // B39–B50 接线在册：建单/读面/派活/注入消费同一套真源，且无第二条执行链。
  const projCode = codeOf('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
  ok(projCode.includes('resolveTaskPosition(db, projectId, wantedPositionId)'), 'B39 建单先验岗位可指派');
  ok(projCode.indexOf('resolveTaskPosition(db, projectId, wantedPositionId)') < projCode.indexOf('INSERT INTO wa_tasks (id, project_id'),
    'B40 先验后插（不落名不副实的指派）');
  ok(projCode.includes('position: positionInfo'), 'B41 任务详情回传岗位派生量');
  ok(projCode.includes('t.position_id, p.name AS position_name'), 'B42 列表/子任务回传岗位名');
  ok(projCode.includes('LEFT JOIN wa_positions p ON p.id = t.position_id'), 'B43 岗位名读时 JOIN（不存第二份）');
  ok(projCode.includes('FROM wa_tasks t LEFT JOIN wa_positions p ON p.id = t.position_id\n        WHERE t.project_id = ?'),
    'B44 普通任务列表不被岗位过滤（派活走同一条列表）');
  const posIpcCode = codeOf('apps/worker-ant-desktop/src/main/ipc/positions.ipc.ts');
  ok(posIpcCode.includes("'positions:forProject'") && posIpcCode.includes('listProjectEnabledPositions'), 'B45 项目可指派岗位 IPC 在册');
  const rendererIpc = codeOf('apps/worker-ant-desktop/renderer/src/lib/ipc.ts');
  ok(rendererIpc.includes("'positions:forProject'"), 'B46 渲染层消费可指派岗位 API');
  ok(rendererIpc.includes('positionId?: string') && rendererIpc.includes('positionId }'), 'B47 建单 API 透传 positionId');
  const tasksPage = codeOf('apps/worker-ant-desktop/renderer/src/pages/TasksPage.tsx');
  ok(tasksPage.includes('positionsApi.forProject'), 'B48 建单弹窗按项目取可指派岗位');
  ok(tasksPage.includes('scorePositionsForTask(positionOptions') && tasksPage.includes('建议：'), 'B49 岗位建议只提示且带命中依据');
  ok(tasksPage.includes("positionId:''") && tasksPage.includes('不指派岗位'), 'B50 默认不自动指派');
  ok(tasksPage.includes('position_name') && tasksPage.includes('岗：'), 'B51 任务列表说得出指派岗位');
  const positionsPage = codeOf('apps/worker-ant-desktop/renderer/src/pages/PositionsPage.tsx');
  ok(positionsPage.includes('派活') && positionsPage.includes('dispatchProjects'), 'B52 岗位详情有派活入口');
  ok(positionsPage.includes('detail.projects.filter((p) => p.enabled)'), 'B53 派活只列已启用该岗位的项目');
  ok(positionsPage.includes('disabled={!detail.position.enabled || dispatchProjects.length === 0'), 'B54 无可用项目/岗位停用 ⇒ 按钮禁用');
  ok(positionsPage.includes('tasksIpc.create(') && positionsPage.includes('detail.position.id'), 'B55 派活复用任务建单并固定岗位');
  ok(positionsPage.includes('/tasks/${newId}'), 'B56 建完跳转任务详情');
  ok(!positionsPage.includes('source:'), 'B57 派出任务不新增来源枚举（source 仍走缺省）');
  const detailPage = codeOf('apps/worker-ant-desktop/renderer/src/pages/TaskDetailPage.tsx');
  ok(detailPage.includes('未指派岗位') && detailPage.includes('岗位：'), 'B58 详情头部有岗位徽标且未指派不空白');
  const schedulerCode = codeOf('apps/worker-ant-desktop/src/main/core/task-scheduler.ts');
  const engineCode = codeOf('apps/worker-ant-desktop/src/main/core/project-engine.ts');
  ok(!schedulerCode.includes('position_id') && !engineCode.includes('position_id'),
    'B59 调度/拆解无第二条以岗位为起点的执行链');
}
// ── C「答」：真路由器 + 内存库；首聊欢迎 / 帮助十条 / 暂停继续 / 任务候选澄清 ──

const IM_CH = 'wechat-personal';

/** 夹具：只含 IM 路由触得到的表；列名与生产同名（缺省沿用生产缺省，夹具不得比生产宽松）。 */
function makeImDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT DEFAULT 'active',
      context_json TEXT DEFAULT '{}', working_dir TEXT DEFAULT ''
    );
    CREATE TABLE wa_tasks (
      id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
      priority INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE wa_im_conversations (
      id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, project_id TEXT,
      message_json TEXT DEFAULT '{}', direction TEXT DEFAULT 'inbound',
      created_at TEXT DEFAULT (datetime('now')), status TEXT DEFAULT 'sent',
      last_error TEXT DEFAULT '', outbox_id TEXT DEFAULT '', task_id TEXT DEFAULT '',
      intent TEXT DEFAULT '', route TEXT DEFAULT '', route_reason TEXT DEFAULT '', intent_confidence TEXT DEFAULT ''
    );
    CREATE TABLE wa_task_conversations (
      id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL, content TEXT DEFAULT '',
      tool_calls TEXT, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE wa_jobs (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}', status TEXT DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3, scheduled_at TEXT, started_at TEXT,
      completed_at TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
  `);
  db.prepare("INSERT INTO wa_projects (id, name, status) VALUES ('proj_c', '丙项目', 'active')").run();
  return db;
}

const statusOf = (db: DatabaseSync, id: string): string =>
  String((db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status?: string } | undefined)?.status ?? '');

function seedImTask(db: DatabaseSync, id: string, title: string, status: string): void {
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, status) VALUES (?, ?, ?, ?)').run(id, 'proj_c', title, status);
}

/**
 * 把一条消息接到**真 routeImMessage**上。`prior: false` 表示"本渠道第一次来"（会收到欢迎）；
 * 缺省 `true` 先落一条入站行处老用户态——本组绝大多数标本验的是指令本身，不该被欢迎语挤到 `replies[1]`。
 */
async function sendIm(
  db: DatabaseSync, from: string, text: string,
  opts: { chatType?: string; prior?: boolean; meta?: Record<string, unknown> } = {},
): Promise<string[]> {
  if (opts.prior !== false) {
    db.prepare("INSERT INTO wa_im_conversations (id, channel_id, external_user_id, direction) VALUES (?, 'ch-c', ?, 'inbound')")
      .run(crypto.randomUUID(), from);
  }
  const replies: string[] = [];
  const ctx = { db, channelId: 'ch-c', channelType: IM_CH, sendReply: async (_to: string, t: string) => { replies.push(t); } };
  await routeImMessage(ctx as never, from, text, opts.chatType ?? 'p2p', 'ctx-c', opts.meta as never);
  return replies;
}

async function sectionC(): Promise<void> {
  console.log('\n【C】IM 欢迎/帮助/暂停继续/任务候选澄清');

  // C1–C7 首聊欢迎：每渠道每用户终身一次；同一句不叠发。
  {
    const db = makeImDb();
    const r = await sendIm(db, 'u_c_welcome', '你好', { prior: false });
    eq(r.length, 1, 'C1 首条私聊只回一条（欢迎已发 ⇒ 问候不再重复）');
    ok((r[0] ?? '').includes('👋'), 'C2 首条私聊发的是欢迎语');
    ok((r[0] ?? '').includes('暂停任务') && (r[0] ?? '').includes('继续任务'), 'C3 欢迎里看得见暂停/继续（照做真能用）');
    ok(!(r[0] ?? '').includes('• 输入项目命令关键词'), 'C4 不再叠发旧的问候长文');
  }
  {
    const db = makeImDb();
    await sendIm(db, 'u_c_welcome2', '你好', { prior: false });
    const r2 = await sendIm(db, 'u_c_welcome2', '谢谢', { prior: true });
    eq(r2.length, 1, 'C5 老用户一条消息只回一条');
    ok(!r2[0]!.includes('👋'), 'C6 老用户不再收到欢迎（1→0 反证）');
    ok(r2[0]!.includes('你好！我是工蚁'), 'C7 老用户问候落到常规问候语');
  }
  {
    const db = makeImDb();
    const r = await sendIm(db, 'u_c_group', '你好', { prior: false, chatType: 'group' });
    ok(!r.some((t) => t.includes('👋')), 'C8 群聊首条不发欢迎（只对私聊）');
    eq(r.length, 1, 'C9 群聊里的闲聊照常回一句（允许面未变）');
  }
  {
    const db = makeImDb();
    const r = await sendIm(db, 'u_c_help', '帮助', { prior: false });
    eq(r.length, 1, 'C10 首条就是「帮助」⇒ 只回帮助全表，不叠欢迎');
    ok((r[0] ?? '').includes('创建任务') && !(r[0] ?? '').includes('👋'), 'C11 帮助内容与欢迎互不重复');
  }

  // C12–C15 帮助表十条 + 欢迎逐行取表（文案与谓词同源）。
  {
    const names = BUILTIN_IM_COMMANDS.map((c) => c.name);
    eq(names.length, 10, 'C12 帮助表恰十条');
    ok(names.indexOf('暂停任务') === names.indexOf('启动任务') + 1
      && names.indexOf('继续任务') === names.indexOf('启动任务') + 2,
      'C13 暂停/继续紧跟启动（帮助顺序 = 谓词判定顺序）');
    const welcome = buildWelcomeText();
    let allDerived = true;
    for (const name of WELCOME_COMMAND_NAMES) {
      const cmd = BUILTIN_IM_COMMANDS.find((c) => c.name === name);
      if (!cmd || !welcome.includes(cmd.example)) allDerived = false;
    }
    ok(allDerived, 'C14 欢迎每一行都逐字取自指令表（改表即改欢迎）');
    ok(welcome.includes('回复「帮助」查看全部指令'), 'C15 欢迎给出看全表的抓手');
  }

  // C16–C21 暂停/继续谓词与接线：只在 im-commands，路由不自留第二份。
  {
    eq(parseTaskPauseResume('暂停 写周报 @丙项目'), { action: 'pause', query: '写周报' }, 'C16 暂停+任务名（去掉 @mention）');
    eq(parseTaskPauseResume('继续「写周报」'), { action: 'resume', query: '写周报' }, 'C17 继续+引号任务名');
    eq(parseTaskPauseResume('开始 写周报'), null, 'C18 启动动词不归暂停/继续');
    eq(parseTaskPauseResume('恢复'), { action: 'resume', query: '' }, 'C19 裸「恢复」⇒ 空任务名（列候选）');
    eq(parseTaskPauseResume('取消暂停'), null, 'C20 「取消暂停」不被误认（不抢确认问句的答复）');
    const routerCode = codeOf('apps/worker-ant-desktop/src/main/services/im-router.ts');
    const cmdCode = codeOf('apps/worker-ant-desktop/src/main/services/im-commands.ts');
    ok(!/const\s+(PAUSE_REGEX|RESUME_REGEX)\s*=/.test(routerCode) && /export const PAUSE_REGEX/.test(cmdCode),
      'C21 暂停/继续谓词只在 im-commands（路由不自留第二份）');
    ok(routerCode.includes('parseTaskPauseResume') && routerCode.includes('buildWelcomeText'),
      'C22 路由经同一张表取谓词与欢迎文案');
    const iDis = routerCode.indexOf('handleTaskDisambiguation(ctx, fromUser');
    const iPause = routerCode.indexOf('handleTaskPauseResume(ctx, fromUser');
    const iNum = routerCode.indexOf('handleNumberSelection(ctx, fromUser');
    ok(iDis >= 0 && iPause > iDis && iNum > iPause,
      'C23 澄清答复、暂停/继续都排在纯编号选择之前（编号不被别路吃掉）');
  }

  // C24–C27 暂停：落状态 + 作废残留执行作业（0→1 式正面断言）。
  {
    const db = makeImDb();
    seedImTask(db, 't_run', '写周报（运行中）', 'running');
    db.prepare("INSERT INTO wa_jobs (id, type, payload, status) VALUES ('j_old', 'ai-task', ?, 'pending')")
      .run(JSON.stringify({ taskId: 't_run', projectId: 'proj_c', source: 'scheduler' }));
    const r = await sendIm(db, 'u_c_pause', '暂停 写周报');
    eq(statusOf(db, 't_run'), 'paused', 'C24 暂停把 running 落成 paused');
    ok((r[0] ?? '').includes('已暂停任务'), 'C25 回执如实说暂停了哪个任务');
    const job = db.prepare("SELECT status, error FROM wa_jobs WHERE id = 'j_old'").get() as { status: string; error: string };
    eq([job.status, job.error], ['done', 'superseded_by_pause'], 'C26 残留执行作业被作废（带因由）');
  }
  {
    const db = makeImDb();
    seedImTask(db, 't_paused', '整理台账', 'paused');
    const r = await sendIm(db, 'u_c_pause2', '暂停 台账');
    ok((r[0] ?? '').includes('已经在暂停中'), 'C27 已暂停 ⇒ 如实拒绝，不重复动作');
  }

  // C28–C33 继续：落回 pending + 入队 resume-ai-task（initiator=user）；非暂停态如实拒绝。
  {
    const db = makeImDb();
    seedImTask(db, 't_p2', '恢复周报', 'paused');
    seedImTask(db, 't_run2', '正在跑的周报', 'running');
    const before = Number((db.prepare('SELECT COUNT(*) AS n FROM wa_jobs').get() as { n: number }).n);
    const r = await sendIm(db, 'u_c_resume', '继续 恢复周报');
    eq(statusOf(db, 't_p2'), 'pending', 'C28 继续把 paused 落回 pending');
    const after = Number((db.prepare('SELECT COUNT(*) AS n FROM wa_jobs').get() as { n: number }).n);
    eq(after - before, 1, 'C29 恢复作业 0→1');
    const job = db.prepare('SELECT type, payload FROM wa_jobs ORDER BY rowid DESC LIMIT 1').get() as { type: string; payload: string };
    eq(job.type, 'resume-ai-task', 'C30 入队的是 resume-ai-task');
    ok(job.payload.includes('"initiator":"user"'), 'C31 载荷标明人工发起（不被当作系统自恢复）');
    ok((r[0] ?? '').includes('已继续任务'), 'C32 回执如实说继续了哪个任务');
    const r2 = await sendIm(db, 'u_c_resume2', '继续 正在跑的周报');
    ok((r2[0] ?? '').includes('任务正在执行'), 'C33 正在执行 ⇒ 拒绝继续并说原因');
  }

  // C34–C39 多候选 ⇒ 5 分钟时效的编号澄清；未选中的不动。
  {
    const db = makeImDb();
    seedImTask(db, 't_d1', '周报整理一', 'pending');
    seedImTask(db, 't_d2', '周报整理二', 'running');
    const r = await sendIm(db, 'u_c_multi', '暂停 周报整理');
    ok((r[0] ?? '').includes('找到 2 个匹配的任务'), 'C34 多候选 ⇒ 列编号澄清');
    ok((r[0] ?? '').includes('1.') && (r[0] ?? '').includes('2.'), 'C35 澄清问句带编号');
    eq([statusOf(db, 't_d1'), statusOf(db, 't_d2')], ['pending', 'running'], 'C36 澄清前不动任何任务');
    const r2 = await sendIm(db, 'u_c_multi', '1');
    eq(statusOf(db, 't_d2'), 'paused', 'C37 回复编号命中（同刻按 rowid 倒序 ⇒ 后插的在前）');
    eq(statusOf(db, 't_d1'), 'pending', 'C38 未被选中的任务不动');
    ok((r2[0] ?? '').includes('已暂停任务'), 'C39 编号答复直接执行并回执');
  }

  // C40–C43 澄清过期（假时钟）：超 5 分钟的编号如实作废，不执行。
  {
    const db = makeImDb();
    seedImTask(db, 't_e1', '报告核对一', 'pending');
    seedImTask(db, 't_e2', '报告核对二', 'pending');
    const r = await sendIm(db, 'u_c_exp', '暂停 报告核对');
    ok((r[0] ?? '').includes('找到 2 个匹配的任务'), 'C40 建立待澄清');
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + DISAMBIGUATION_TTL_MS + 1000;
      const r2 = await sendIm(db, 'u_c_exp', '2');
      ok((r2[0] ?? '').includes('超过 5 分钟'), 'C41 过期编号如实说作废（不静默执行）');
    } finally { Date.now = realNow; }
    eq([statusOf(db, 't_e1'), statusOf(db, 't_e2')], ['pending', 'pending'], 'C42 过期后不执行任何任务');
    const p = buildDisambiguation('pause', ['a', 'b'], 1_000);
    eq(isDisambiguationExpired(p, 1_000 + DISAMBIGUATION_TTL_MS - 1), false, 'C43 5 分钟内仍有效');
    eq(isDisambiguationExpired(p, 1_000 + DISAMBIGUATION_TTL_MS), true, 'C44 到点即作废');
    eq(pickDisambiguation(p, '2'), 'b', 'C45 编号 2 ⇒ 第二条');
    eq(pickDisambiguation(p, '3'), null, 'C46 越界编号不给候选');
    eq(pickDisambiguation(p, 'abc'), null, 'C47 非纯数字不给候选');
  }

  // C48–C51 0 命中：如实说没找到 + 列活跃任务；且**不暂存编号选择**。
  {
    const db = makeImDb();
    seedImTask(db, 't_n1', '整理台账', 'pending');
    const r = await sendIm(db, 'u_c_nomatch', '暂停 不存在的任务名');
    ok((r[0] ?? '').includes('没找到名字含'), 'C48 0 命中如实说没找到');
    ok((r[0] ?? '').includes('整理台账'), 'C49 同时列出当前活跃任务（给下一步的抓手）');
    const r2 = await sendIm(db, 'u_c_nomatch', '1');
    eq(statusOf(db, 't_n1'), 'pending', 'C50 0 命中后不复用编号（不把"随便挑"变成默认动作）');
    ok(!(r2[0] ?? '').includes('已暂停任务'), 'C51 编号回复不会落到未被指名的任务上');
  }

  // C52–C54 执行前复核（TOCTOU）：列表之后变终态 ⇒ 拒绝，不把终态打回 paused。
  {
    const db = makeImDb();
    seedImTask(db, 't_r1', '核对报表一', 'pending');
    seedImTask(db, 't_r2', '核对报表二', 'pending');
    const r = await sendIm(db, 'u_c_race', '暂停 核对报表');
    ok((r[0] ?? '').includes('找到 2 个匹配的任务'), 'C52 建立候选');
    db.prepare("UPDATE wa_tasks SET status = 'completed' WHERE id = 't_r2'").run();
    const r2 = await sendIm(db, 'u_c_race', '1');
    ok((r2[0] ?? '').includes('已完成'), 'C53 执行前复核状态（列表后变成终态 ⇒ 拒绝并说原因）');
    eq(statusOf(db, 't_r2'), 'completed', 'C54 终态不被打回 paused');
  }

  // C55–C56 状态合法性矩阵（纯函数，唯一判据）。
  {
    eq(pauseRefusal('running'), null, 'C55 运行中可暂停');
    eq(pauseRefusal('paused'), '任务已经在暂停中，无需再暂停。', 'C56 paused 拒绝暂停');
    eq(pauseRefusal('completed'), '任务已完成，无需暂停。', 'C57 completed 拒绝暂停');
    eq(pauseRefusal('failed'), '任务已经结束（失败），无需暂停。', 'C58 failed 拒绝暂停');
    eq(pauseRefusal('archived'), '任务已归档，无需暂停。', 'C59 archived 拒绝暂停');
    eq(resumeRefusal('paused'), null, 'C60 paused 可继续');
    eq(resumeRefusal('failed'), null, 'C61 failed 可继续');
    eq(resumeRefusal('completed'), '任务已完成，无需继续。', 'C62 completed 拒绝继续');
    eq(resumeRefusal('archived'), '任务已归档，不能再继续。', 'C63 archived 拒绝继续');
    eq(resumeRefusal('pending'), '任务已在队列里等待执行，无需继续。', 'C64 pending 拒绝继续');
    eq(resumeRefusal('running'), '任务正在执行，无需继续。', 'C65 running 拒绝继续');
  }

  // C66–C67 活跃任务检索：标题子串、大小写不敏感、终态排除、项目限定。
  {
    const db = makeImDb();
    seedImTask(db, 't_f1', 'Alpha 周报', 'pending');
    seedImTask(db, 't_f2', 'alpha 月报', 'running');
    seedImTask(db, 't_f3', 'alpha 归档', 'archived');
    const pdb = db as unknown as Parameters<typeof findActiveTasks>[0];
    eq(findActiveTasks(pdb, { projectId: 'proj_c', query: 'ALPHA' }).map((x) => x.id).sort(), ['t_f1', 't_f2'],
      'C66 标题子串匹配且大小写不敏感、终态排除');
    eq(findActiveTasks(pdb, { projectId: 'other', query: 'alpha' }).length, 0, 'C67 指定项目时只在该项目内找');
  }
}
function sectionD(): void {
  console.log('\n【D】任务详情分层、子任务成树、模型可用性说清');
  const PAGE = `${A}/renderer/src/pages/TaskDetailPage.tsx`;
  const MODELS = `${A}/renderer/src/pages/ModelsPage.tsx`;
  const SETTINGS = `${A}/renderer/src/pages/SettingsPage.tsx`;
  const PROJECT_IPC = `${A}/src/main/ipc/project.ipc.ts`;
  const page = codeOf(PAGE);

  // ── ① 动作分层：每个态至多一个主操作；暂停态的主操作就是恢复 ──
  const known = ['pending', 'planning', 'preparing', 'executing', 'running', 'paused', 'failed', 'stabilizing', 'completed', 'archived', 'investigating'];
  for (const s of known) {
    const l = taskActionLayout(s);
    const all: TaskActionKey[] = [...(l.primary ? [l.primary] : []), ...l.secondary, ...l.danger];
    ok(new Set(all).size === all.length, `D-1 ${s} 动作不重复登记（主/次/危互斥）`, all.join(','));
  }
  const pausedLayout = taskActionLayout('paused');
  ok(
    pausedLayout.primary === 'resume'
      && ![...pausedLayout.secondary, ...pausedLayout.danger].includes('pause'),
    'D-2 ★暂停态主操作=恢复，且整个布局里没有「暂停」（同一坐标点不出反向动作）',
  );
  ok(taskActionLayout('executing').primary === 'pause' && taskActionLayout('running').primary === 'pause',
    'D-3 执行/运行态主操作=暂停（与 D-2 成两侧标本）');
  ok(['planning', 'preparing', 'investigating'].every((s) => taskActionLayout(s).primary === null),
    'D-4 机器在跑/在排的态不硬凑主操作（primary=null）');
  const unknown = taskActionLayout('no-such-status');
  ok(unknown.primary === null && unknown.secondary.includes('attach') && unknown.danger.length === 0,
    'D-5 未知状态不猜动作（只留挂附件），不抛');
  const runningDanger = taskActionLayout('running').danger;
  const pendingDanger = taskActionLayout('pending').danger;
  const completedDanger = taskActionLayout('completed').danger;
  ok(runningDanger.includes('interrupt') && !pendingDanger.includes('interrupt'),
    'D-6 中止只在运行态进危险组（排队态没有可中止的执行体）');
  ok(pendingDanger.includes('archive') && completedDanger.includes('delete') && !completedDanger.includes('archive'),
    'D-7 归档与删除按态分列（完成态可删；排队态可归档）');
  ok(taskActionLayout('archived').primary === 'create_from_original',
    'D-8 已归档态的主操作是「以原题面新建」（原任务仍保持归档）');
  ok((Object.keys(ACTION_LABEL) as TaskActionKey[]).every((k) => ACTION_LABEL[k].length > 0 && actionTitle(k, 'completed').length > 0),
    'D-9 每个动作都有按钮名与说明（不摆无字按钮）');
  ok(actionTitle('inject', 'completed') !== actionTitle('inject', 'executing'),
    'D-10 追加输入按状态分说：已完成=重新打开，执行中=注入');
  ok(page.includes('taskActionLayout(task.status)') && page.includes('data-task-action-bar') && !page.includes('<ActionSlot>'),
    'D-11 页面操作栏由 taskActionLayout 派生（旧的 ActionSlot 直写条件已退场）');
  for (const [key, handler] of [
    ['attach', 'handleAttachFiles'], ['execute', 'handleStatus'], ['interrupt', 'handleInterrupt'],
    ['delete', 'handleDelete'], ['create_from_original', 'handleArchiveDraft'],
  ] as const) {
    ok(new RegExp(`case '${key}': void ${handler}\\(`).test(page),
      `D-12 ${key} 仍转调原 handler（分层只改摆法，不改动作语义）`);
  }
  ok(/case 'execute': void handleStatus\(task\.id, 'running'\)/.test(page)
    && /case 'pause': void handleStatus\(task\.id, 'paused'\)/.test(page),
    'D-12b 执行/暂停仍走原状态迁移入参（分层没有偷换目标态）');
  // sticky（烹小鲜）冷却态不带进新分层时会被"收成一处"顺手收掉——两只出口逐项钉住。
  const stabLayout = taskActionLayout('stabilizing');
  ok(stabLayout.primary === 'requeue' && stabLayout.secondary.includes('pause') && stabLayout.danger.includes('archive'),
    'D-12c ★stabilizing 两个人工出口都在（放回队列 + 转人工暂停），归档仍在危险组（分层不得丢出口）');

  // ── ② 子任务成树：孤儿/成环/深度；族进度用终态同源 ──
  const rows = [
    { id: 'b', status: 'completed', parent_task_id: 'a' },
    { id: 'c', status: 'executing', parent_task_id: 'a' },
    { id: 'd', status: 'paused', parent_task_id: 'b' },
    { id: 'e', status: 'completed', parent_task_id: 'missing' },
  ];
  const tree = buildTaskTree(rows, 'a');
  eq(tree.map((n) => n.task.id).sort(), ['b', 'c', 'e'], 'D-13 父=根或孤儿 ⇒ 提升为根（每行都上树）');
  const bNode = tree.find((n) => n.task.id === 'b');
  eq(bNode?.children.map((n) => n.task.id), ['d'], 'D-14 孙任务挂在其父之下（不再与直系子平铺）');
  eq(bNode?.children[0]?.depth, 1, 'D-15 深一层 depth+1');
  const flat = flattenTaskTree(tree, new Set());
  ok(flat.find((r) => r.task.id === 'd')?.depth === 1, 'D-16 摊平后保留深度');
  ok(!flattenTaskTree(tree, new Set(['b'])).some((r) => r.task.id === 'd'), 'D-17 折叠父行后孙子行不渲染');
  const cyc = [
    { id: 'x', status: 'pending', parent_task_id: 'y' },
    { id: 'y', status: 'pending', parent_task_id: 'x' },
  ];
  const cycIds = flattenTaskTree(buildTaskTree(cyc, 'a'), new Set()).map((r) => r.task.id);
  eq(cycIds.sort(), ['x', 'y'], 'D-18 成环行各出现恰一次（不丢行、不死循环）');
  const prog = familyProgress(rows);
  eq({ total: prog.total, done: prog.done, running: prog.running, waiting: prog.waiting },
    { total: 4, done: 2, running: 1, waiting: 1 }, 'D-19 族进度：完成 2/4、运行 1、等你处理 1');
  eq(familyProgress([...rows, { id: 'f', status: 'pending', parent_task_id: 'a' }]).waiting, 1,
    'D-20 待执行不冒充「等你处理」（队列里的事不算在等人）');
  eq(familyProgress([]).total, 0, 'D-21 空集 total=0（调用方据此不渲染 0/0）');
  ok(page.includes('familyRows.map') && page.includes('完成 {famProgress.done} / {famProgress.total}'),
    'D-22 族卡按树渲染并上屏完成/总数');
  ok(page.includes('marginLeft: depth * 14') && page.includes('toggleChildCollapse'),
    'D-23 深度缩进与折叠开关真实接线');

  // ── ③ 子任务收集（main 侧）：整棵子树、有界深度、防环 ──
  const graph: Record<string, string[]> = { a: ['b', 'c'], b: ['d'], c: [], d: ['a'] };
  const got = collectDescendants((pid) => (graph[pid] ?? []).map((id) => ({ id })), 'a');
  eq(got.map((g) => g.id), ['b', 'c', 'd'], 'D-24 广度优先收齐孙任务，环不回卷（seen 含根）');
  eq(collectDescendants((pid) => (graph[pid] ?? []).map((id) => ({ id })), 'a', 1).map((g) => g.id),
    ['b', 'c'], 'D-25 深度上限如实截断');
  ok(TASK_FAMILY_MAX_DEPTH >= 2, 'D-26 子树深度上限在册（不无限下钻）');

  // ── ④ 失败说得出证据：入口 + 空证据如实 ──
  ok(page.includes('查看运行证据') && page.includes('id="run-evidence"'),
    'D-27 失败卡有「查看运行证据」且证据块有真实落点');
  ok(page.includes('本次运行未留证据（没有可核对的命令记录）。'),
    'D-28 无证据时如实说「未留证据」，不摆空块');
  ok(page.includes('setShowRunEvidence(true)') && /task\?\.status === 'failed'/.test(page),
    'D-29 入口只在失败态出现（不让人在成功任务上找不存在的证据）');

  // ── ⑤ 模型可用性五因：两侧标本（每因都有「成立」与「不成立」） ──
  const base = { enabled: 1, available: true, has_endpoint: true, capabilities: '["chat"]', providerEnabled: 1, requireChat: true };
  const v = (patch: Record<string, unknown>) => describeModelAvailability({ ...base, ...patch });
  ok(v({}).usable === true, 'D-30 端点/Key/chat 齐备且服务端确认 ⇒ 可用');
  eq(v({ enabled: 0 }).reason, 'disabled', 'D-31 已禁用（且优先于其它因）');
  eq(v({ enabled: 0, available: false }).reason, 'disabled', 'D-32 禁用优先于「未知」');
  eq(v({ providerEnabled: 0 }).reason, 'provider_disabled', 'D-33 供应商已禁用');
  eq(v({ has_endpoint: false }).reason, 'no_endpoint', 'D-34 待配置端点');
  eq(v({ capabilities: '["embedding"]' }).reason, 'no_chat_capability', 'D-35 缺 chat 能力（跑不出成果）');
  ok(v({ capabilities: '["embedding"]', requireChat: false }).usable === true,
    'D-36 不要 chat 时 embedding 也判可用（requireChat 才是那道闸）');
  eq(v({ available: false }).label, '可用性未知', 'D-37 服务端明确 false ⇒ 知道它现在不可用');
  eq(v({ available: undefined }).label, '未返回钥匙状态', 'D-38 服务端没返回 ⇒ 不知道（不猜可用）');
  const reasons = ['disabled', 'provider_disabled', 'no_endpoint', 'no_chat_capability', 'unknown'] as const;
  const views = [
    v({ enabled: 0 }), v({ providerEnabled: 0 }), v({ has_endpoint: false }),
    v({ capabilities: '["embedding"]' }), v({ available: undefined }),
  ];
  ok(views.every((x) => x.reason !== null && x.title.length > 0),
    'D-39 五因都有一句「凭什么」的说明（不只换个颜色）');
  eq(views.map((x) => x.reason), [...reasons], 'D-40 原因枚举按优先级逐项可达（五因恰五枚）');

  // ── ⑥ 接线：徽标、测试结果、ANS 连接测试、子树查询 ──
  const modelsSrc = readSrc(MODELS);
  ok(modelsSrc.includes('describeModelAvailability') && modelsSrc.includes('availabilityOf(m, providers)'),
    'D-41 模型页徽标走唯一真源（含所属供应商上下文）');
  ok(modelsSrc.includes('requireChat: true'), 'D-42 模型页问的是「能不能跑任务」⇒ 要求 chat');
  ok(modelsSrc.includes('title={b.title}'), 'D-43 徽标带 title（看不见的原因有处可查）');
  ok(modelsSrc.includes('endpointTestLine') && modelsSrc.includes("'测试连接'"),
    'D-44 每行有「测试连接」，结果用一句话说清');
  const probeSrc = readSrc(`${A}/renderer/src/lib/probe-models.ts`);
  ok(probeSrc.includes('连接正常') && probeSrc.includes('连接失败'),
    'D-45 测试结果成功带延迟、失败带原因（不再一律「不可用」）');
  const settingsSrc = readSrc(SETTINGS);
  ok(settingsSrc.includes('adminApi.health') && settingsSrc.includes('HEALTH_LEVEL_LABEL'),
    'D-46 设置页「测试连接」复用健康自检探针与三态词表');
  ok(settingsSrc.includes('data-ans-test') && settingsSrc.includes("'测试连接'") && settingsSrc.includes('ansTest'),
    'D-47 设置页结果就地显示（不弹 alert，失败留原因）');
  const ipcSrc = codeOf(PROJECT_IPC);
  ok(ipcSrc.includes('collectDescendants(') && ipcSrc.includes('t.parent_task_id') && ipcSrc.includes('LEFT JOIN wa_positions'),
    'D-48 tasks:children 收整棵子树且保留岗位名 JOIN（列投影不走样）');
}
function sectionE(): void {
  console.log('\n【E】类目忙闲与跨机认岗');

  // ── ① 六类目在跑数：显式类目优先、形态兜底、判不出不记；未知与全 0 是两件事 ──
  const explicitResearch = JSON.stringify({
    dispatch_requirements: { categories: ['research'], intents: [], deviceClasses: [], confidence: 0.85, source: 'decompose' },
  });
  const classRows = [
    { title: '实现登录模块', description: '', context_json: null },
    { title: '随便看看', description: '', context_json: explicitResearch },
    { title: '今天天气不错', description: '', context_json: null },
  ];
  eq(classRunningOfRows(classRows),
    { text: 0, code: 1, research: 1, media: 0, device: 0, project_task: 0 },
    'E-1 显式类目入桶、无存档按形态兜底、判不出的不记（不猜）');
  eq(classRunningOfRows([]), emptyClassRunning(), 'E-2 空集 ⇒ 六类全 0（已知确实没在跑）');
  ok(JSON.stringify(emptyClassRunning()) !== JSON.stringify(null), 'E-3 全 0 与「未知(null)」是两种值（上游可区分）');
  const multiCat = JSON.stringify({
    dispatch_requirements: { categories: ['code', 'research'], intents: [], deviceClasses: [], confidence: 0.85, source: 'decompose' },
  });
  eq(classRunningOfRows([{ title: 'x', description: '', context_json: multiCat }]).code, 1, 'E-4 一件事声明多类目时逐类各计一次（code）');
  eq(classRunningOfRows([{ title: 'x', description: '', context_json: multiCat }]).research, 1, 'E-5 同上（research）');

  const full = { text: 1, code: 2, research: 3, media: 4, device: 5, project_task: 6 };
  eq(sanitizeClassRunning(full), full, 'E-6 六键齐全的非负数原样认下');
  eq(sanitizeClassRunning({ text: 1, code: 2, research: 3, media: 4, device: 5 }), null,
    'E-7 少一类即 null（少报一类不等于这一类空闲）');
  eq(sanitizeClassRunning({ ...full, media: -1 }), null, 'E-8 负数 ⇒ null（不洗成 0）');
  eq(sanitizeClassRunning({ ...full, media: '4' }), null, 'E-9 字符串数 ⇒ null（不替对端转数）');
  eq(sanitizeClassRunning(null), null, 'E-10 无值 ⇒ null');

  const classDb = new DatabaseSync(':memory:');
  classDb.exec(`CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT, context_json TEXT)`);
  const insClass = classDb.prepare('INSERT INTO wa_tasks (id,title,description,status,context_json) VALUES (?,?,?,?,?)');
  insClass.run('c1', '实现登录模块', '', 'executing', null);
  insClass.run('c2', '随便看看', '', 'planning', explicitResearch);
  insClass.run('c3', '实现登录模块', '', 'completed', null);
  eq(deriveClassRunning(classDb as unknown as { prepare(sql: string): { all(...a: unknown[]): unknown[] } }),
    { text: 0, code: 1, research: 1, media: 0, device: 0, project_task: 0 },
    'E-11 读库只数占位三态（completed 不算在跑）');
  eq(deriveClassRunning({ prepare() { throw new Error('no table'); } } as unknown as { prepare(sql: string): { all(...a: unknown[]): unknown[] } }),
    null, 'E-12 读不到任务表 ⇒ null（不写全 0 冒充空闲）');

  // ── ② 岗位加成：点名且公示命中才 +0.05；未点名/未上报/未命中一律 0 ──
  const mkReq = (patch: Partial<DispatchRequirements> = {}): DispatchRequirements => ({
    categories: [], intents: [], deviceClasses: [], confidence: 0.6, source: 'rule', ...patch,
  });
  const baseProfile: NodeMatchProfile = {
    nodeId: 'n1', isLocal: false, online: true,
    categories: ['text', 'code', 'research', 'media', 'device', 'project_task'],
    intents: [], deviceClasses: [], freeRatio: 0.8, weight: 5, reliability: null,
  };
  ok(positionBonus({ positions: ['p1'] }, mkReq({ positionId: 'p1' })) === POSITION_BONUS_MAX,
    'E-13 点名岗位且本节点公示含它 ⇒ +0.05');
  ok(positionBonus({ positions: ['p2'] }, mkReq({ positionId: 'p1' })) === 0,
    'E-14 公示不含该岗位 ⇒ 0（不惩罚、不猜）');
  ok(positionBonus({}, mkReq({ positionId: 'p1' })) === 0, 'E-15 未上报岗位 ⇒ 0（缺省不是「全都不匹配」）');
  ok(positionBonus({ positions: ['p1'] }, mkReq()) === 0, 'E-16 任务未点名岗位 ⇒ 0（岗位只作加成，不当必填）');
  ok(POSITION_BONUS_MAX <= 0.05, 'E-17 加成上限 ≤0.05（不压过七面主分）');
  const noPos = matchNode(baseProfile, mkReq());
  const withPosUnused = matchNode({ ...baseProfile, positions: ['p1'], classRunning: full, machineLimit: 8 }, mkReq());
  ok(noPos.score === withPosUnused.score && noPos.reason === withPosUnused.reason,
    'E-18 无岗位要求、无类目要求时，新字段在场也不改分与理由（逐字节等价）');
  const hitPos = matchNode({ ...baseProfile, positions: ['p1'] }, mkReq({ positionId: 'p1' }));
  ok(hitPos.reason.includes('岗位匹配:+0.05'), 'E-19 命中岗位时理由里说明加成（不只在分里悄悄加）');
  ok(!matchNode({ ...baseProfile, positions: ['p2'] }, mkReq({ positionId: 'p1' })).reason.includes('岗位匹配'),
    'E-20 未命中时理由不出现岗位一行（没有的事不上屏）');

  // ── ③ 类目拥挤：达 ceil(上限×0.75) 起压、封顶 −0.10、只压分不否决 ──
  ok(CLASS_PRESSURE_RATIO === 0.75 && Math.ceil(8 * CLASS_PRESSURE_RATIO) === 6,
    'E-21 门槛=ceil(上限×0.75)：8 槽 ⇒ 6 起压');
  const press = (n: number, limit = 8, categories: 'code'[] = ['code']) =>
    classPressurePenalty({ classRunning: { ...emptyClassRunning(), code: n }, machineLimit: limit }, mkReq({ categories }));
  ok(press(5).penalty === 0, 'E-22 5/8 未达门槛 ⇒ 不扣');
  ok(Math.abs(press(6).penalty - CLASS_PRESSURE_PENALTY_MAX / 3) < 1e-9, 'E-23 6/8 起扣 1/3 档');
  ok(Math.abs(press(8).penalty - CLASS_PRESSURE_PENALTY_MAX) < 1e-9, 'E-24 8/8 封顶 −0.10');
  ok(press(4, 4).penalty > 0 && Math.abs(press(4, 4).penalty - CLASS_PRESSURE_PENALTY_MAX) < 1e-9,
    'E-25 4 槽机器跑满同样封顶（门槛按比例算，不写死 6）');
  ok(press(8).note === '类目忙:编码 已占 8/8 槽位', 'E-26 理由说清哪个类目、已占几槽（界面直接上屏）');
  ok(classPressurePenalty({ classRunning: full, machineLimit: 8 }, mkReq()).penalty === 0,
    'E-27 任务无类目要求 ⇒ 不扣（不拿无关类目的拥挤罚人）');
  ok(classPressurePenalty({ classRunning: null, machineLimit: 8 }, mkReq({ categories: ['code'] })).penalty === 0,
    'E-28 在跑数未知 ⇒ 不扣（未知不装很挤）');
  ok(classPressurePenalty({ classRunning: full, machineLimit: null }, mkReq({ categories: ['code'] })).penalty === 0,
    'E-29 上限未知/0 ⇒ 不扣（没有分母不算比例）');
  const plenty = matchNode({
    ...baseProfile, classRunning: { ...emptyClassRunning(), project_task: 8 }, machineLimit: 8,
  }, mkReq({ categories: ['project_task'] }));
  ok(plenty.veto === null && plenty.score > 0, 'E-30 拥挤只压分、不否决（派不派仍由七面合议）');
  ok(Math.abs(CLASS_PRESSURE_PENALTY_MAX - 0.1) < 1e-9, 'E-31 扣分上限在册（≤0.10）');

  // ── ④ 容量+岗位在匹配里的合成：压分可把命中加成吃掉，但不越界 ──
  const combined = matchNode({
    ...baseProfile, positions: ['p1'], classRunning: { ...emptyClassRunning(), code: 8 }, machineLimit: 8,
  }, mkReq({ categories: ['code'], positionId: 'p1' }));
  const plain = matchNode({ ...baseProfile, classRunning: { ...emptyClassRunning(), code: 8 }, machineLimit: 8 },
    mkReq({ categories: ['code'] }));
  ok(Math.abs((combined.score - plain.score) - POSITION_BONUS_MAX) < 1e-9
    || combined.score === 1 || plain.score === 0,
  'E-32 同压分条件下命中岗位恰好多 0.05（两个修正各计各的，不互相吞并）');

  // ── ⑤ 岗位需求：坏 positionId 只丢该字段；任务行显式值覆盖存档值 ──
  const badPos = sanitizeDispatchRequirements({
    categories: ['code'], intents: [], deviceClasses: [], confidence: 0.8, source: 'decompose', positionId: 42,
  });
  ok(badPos !== null && badPos.categories.join(',') === 'code' && badPos.positionId === undefined,
    'E-33 坏 positionId 只丢该字段，不连带作废三面需求');
  const storedPos = requirementsForTask({
    title: 'x', contextJson: JSON.stringify({
      dispatch_requirements: { categories: ['research'], intents: [], deviceClasses: [], confidence: 0.8, source: 'decompose', positionId: 'old' },
    }),
    positionId: 'row',
  });
  ok(storedPos.positionId === 'row' && storedPos.categories.join(',') === 'research',
    'E-34 任务行显式岗位覆盖存档岗位，其余需求原样保留');

  // ── ⑥ 跨机载荷：无岗位时形状不变；有岗位时带摘要且不含知识与经验 ──
  const dispatchTask = { id: 't1', title: '甲', description: '乙', acceptanceCriteria: '丙' };
  const barePayload = buildDispatchPayload(dispatchTask);
  eq(Object.keys(barePayload).sort(), ['acceptance_criteria', 'description', 'prompt', 'title'],
    'E-35 无岗位/无上游 ⇒ 载荷仍是旧四键');
  eq(JSON.stringify(buildDispatchPayload(dispatchTask)), JSON.stringify(buildDispatchPayload(dispatchTask, [], null)),
    'E-36 空上游/空岗位与缺省参数逐字节相同');
  const posPayload = { id: 'p1', name: '财务', version: 2, summary: '说明' };
  eq(buildDispatchPayload(dispatchTask, undefined, posPayload).position, posPayload,
    'E-37 有岗位时随载荷带 id/名称/版本/摘要');

  const pdb2 = makePositionsDb();
  const made = createPosition(pdb2 as unknown as PositionDb, {
    name: '财务岗', description: '对外说明', rules: ['公开规范'], knowledge: ['内部知识'], enabled: true,
  });
  ok(made.ok === true, 'E-38 夹具：岗位创建成功');
  if (made.ok) {
    pdb2.prepare('UPDATE wa_tasks SET position_id = ? WHERE id = ?').run(made.position.id, 'task_a');
    const relayed = dispatchPositionOfTask(pdb2 as unknown as Parameters<typeof dispatchPositionOfTask>[0], 'task_a');
    ok(relayed !== null && relayed.id === made.position.id && relayed.version === made.position.version,
      'E-39 任务有岗位 ⇒ 派单段带 id/版本（本地指派可跨机认岗）');
    ok(relayed !== null && relayed.summary.length <= POSITION_DISPATCH_SUMMARY_MAX
      && relayed.summary.includes('财务岗') && relayed.summary.includes('公开规范'),
      'E-40 摘要 ≤600 且含说明/规范');
    ok(relayed !== null && !relayed.summary.includes('内部知识'), 'E-41 摘要不含岗位知识（知识不出本机）');
    const wide = sanitizeDispatchPosition({ ...posPayload, summary: 'x'.repeat(700) });
    ok(wide !== null && wide.summary.length === POSITION_DISPATCH_SUMMARY_MAX, 'E-42 对端摘要入口再截到 600');
    eq(sanitizeDispatchPosition({ id: 'p1', name: '财务', summary: 's' }), null,
      'E-43 缺版本 ⇒ null（坏形不注入）');
    eq(sanitizeDispatchPosition({ id: 'p1', name: '财务', version: 2, summary: 7 }), null,
      'E-44 摘要非字符串 ⇒ null');
  }
  eq(dispatchPositionOfTask(pdb2 as unknown as Parameters<typeof dispatchPositionOfTask>[0], 'task_b'), null,
    'E-45 任务未指派岗位 ⇒ 派单段不出现（旧载荷形状不变）');
  const relayReq = (payload: unknown) => relayPosition({ payload } as unknown as Parameters<typeof relayPosition>[0]);
  eq(relayReq({ position: posPayload }), posPayload, 'E-46 中继侧洗过再来（合法岗位上下文认下）');
  eq(relayReq({ position: { id: 'p', name: 'n' } }), null, 'E-47 中继侧坏形 ⇒ null（不落半截）');
  eq(relayReq({}), null, 'E-48 中继侧无岗位键 ⇒ null');

  // ── ⑦ 接线：远端只写 dispatch_position（绝不伪造本地指派）；执行期只注入有界摘要 ──
  const relaySrc = codeOf(`${A}/src/main/core/node-request-runner.ts`);
  ok(relaySrc.includes('[DISPATCH_POSITION_KEY]: position') && !relaySrc.includes('position_id'),
    'E-49 中继上下文只写 dispatch_position，代码里没有 position_id 写口');
  const execSrc = codeOf(`${A}/src/main/core/exec-context.ts`);
  ok(execSrc.includes('【岗位·来自对端】') && execSrc.includes('sanitizeDispatchPosition'),
    'E-50 执行期把对端岗位摘要如实标源注入（不冒充本机岗位）');
  const posSrc = codeOf(`${A}/src/main/core/positions.ts`);
  ok(posSrc.includes('ctx[DISPATCH_POSITION_KEY] !== undefined') && /return false/.test(posSrc),
    'E-51 对端岗位任务不沉淀成本机经验候选（经验不跨机回流）');
  const capSrc = codeOf(`${A}/src/main/core/capability-dispatch.ts`);
  ok(capSrc.includes('positions: cardPositionIdsOf(card)')
    && capSrc.includes('classRunning: classRunningOfStatus(node.status)')
    && capSrc.includes('machineLimit: machineLimitOfStatus(node.status)'),
  'E-52 对端画像同带岗位/类目在跑/上限（他机与本机同一把尺）');
  const orchSrc = codeOf(`${A}/src/main/core/orchestrator.ts`);
  ok(orchSrc.includes('positions: cap.positionIds') && orchSrc.includes('positionId: row.position_id')
    && orchSrc.includes('classRunning: cap.classRunning') && orchSrc.includes('machineLimit: cap.machineLimit'),
  'E-53 本机画像也带岗位与类目在跑（两侧同尺，不只手严对端）');
  const hbSrc = codeOf(`${A}/src/main/core/node-heartbeat.ts`);
  ok(hbSrc.includes('class_running: classRunning'), 'E-54 心跳快照上报 class_running（上游据此压分）');
  const cardSrc = codeOf(`${A}/src/main/core/node-card.ts`);
  ok(cardSrc.includes('deriveCardPositions') && cardSrc.includes('positions:'), 'E-55 能力卡公示岗位');
  ok(NODE_CARD_POSITIONS_MAX === 50, 'E-56 岗位公示上限 50 条（卡随心跳走，有界）');

  // ── ⑧ 卡上岗位：只 id/名称/版本；按名升序、有界 ──
  const cardDb = makePositionsDb();
  for (let i = 0; i < 60; i += 1) {
    createPosition(cardDb as unknown as PositionDb, { name: `岗位${String(i).padStart(2, '0')}`, enabled: true });
  }
  const cardPositions = deriveCardPositions(cardDb as unknown as PositionDb);
  ok(cardPositions.length === NODE_CARD_POSITIONS_MAX, 'E-57 卡上岗位恰 50 条（第 51 条起截掉）');
  eq(Object.keys(cardPositions[0] ?? {}).sort(), ['id', 'name', 'version'], 'E-58 每条只有 id/名称/版本（说明/知识/经验不出本机）');
  ok(cardPositions[0]?.name === '岗位00', 'E-59 按名称升序（与面板次序同一把尺）');
  setPositionEnabled(cardDb as unknown as PositionDb, cardPositions[0]!.id, false);
  ok(!deriveCardPositions(cardDb as unknown as PositionDb).some((p) => p.id === cardPositions[0]!.id),
    'E-60 停用岗位不再公示（只列已启用者）');

  // ── ⑨ 档位一把尺：解锁只看「能纳入几台节点」，试用特判留在 team-gate 一处 ──
  ok(teamUnlocked({ tier: 'community', kind: 'none' }) === false, 'E-61 社区版锁团队能力（maxNodes=1）');
  ok(teamUnlocked({ tier: 'pro', kind: 'none' }) === false, 'E-62 专业版锁团队能力（maxNodes=1）');
  ok(teamUnlocked({ tier: 'team', kind: 'none' }) === true, 'E-63 团队版解锁（maxNodes=20）');
  ok(teamUnlocked({ tier: 'community', kind: 'trial' }) === true, 'E-64 试用期按团队能力放行（kind 特判仍在这一处）');
  const tgSrc = codeOf(`${A}/src/main/core/team-gate.ts`);
  ok(!/tier\s*===\s*'team'/.test(tgSrc) && tgSrc.includes('maxNodes'),
    'E-65 team-gate 不再拿档位名当判据（改读 maxNodes）');
  const pdSrc = codeOf(`${A}/src/main/core/project-dispatch-mode.ts`);
  ok(!/tier\s*===\s*'team'/.test(pdSrc) && pdSrc.includes('teamUnlocked'),
    'E-66 派发模式前置条件同引 team-gate（不另写一份档位判断）');
  // 所有读 `multi_node` 的源文件都不得再用档位名自判团队能力（注释剥离后扫）。
  const mainDir = path.join(root, A, 'src/main');
  const multiReaders = (fs.readdirSync(mainDir, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(mainDir, f))
    .filter((abs) => codeOf(path.relative(root, abs)).includes("'multi_node'"))
    .filter((abs) => !abs.endsWith('team-gate.ts'));
  ok(multiReaders.length >= 3, 'E-67 default multi_node 读取面非空（扫描有靶）');
  ok(multiReaders.every((abs) => !/tier\s*===\s*'team'/.test(codeOf(path.relative(root, abs)))),
    'E-68 读 multi_node 的文件里没有第二把「档位名」尺');

  ok(capabilityPrereqRefusal({ tier: 'team', enrolled: true, onlinePeers: 1 }) === '',
    'E-69 团队版+已入网+有在线对端 ⇒ 能力优先前提齐备');
  ok(capabilityPrereqRefusal({ tier: 'pro', enrolled: true, onlinePeers: 3 }).includes('需要团队版'),
    'E-70 专业版：如实说需要团队版（不静默降级）');
  ok(capabilityPrereqRefusal({ tier: 'team', enrolled: false, onlinePeers: 3 }).includes('尚未加入'),
    'E-71 未入网：如实说未加入网络');
  ok(capabilityPrereqRefusal({ tier: 'team', enrolled: true, onlinePeers: 0 }).includes('没有在线可派对端'),
    'E-72 无在线他机：如实说没有可派对端');
  ok(capabilityPrereqRefusal({ tier: 'community', kind: 'trial', enrolled: true, onlinePeers: 1 }) === '',
    'E-73 试用期同走团队尺（kind 传入后前提通过）');
  const resolveMode = (patch: Record<string, unknown>) => resolveProjectDispatchMode({
    globalMode: 'overflow', tier: 'team', enrolled: true, onlinePeers: 2, hasDivision: false, ...patch,
  } as Parameters<typeof resolveProjectDispatchMode>[0]);
  eq(resolveMode({ projectMode: 'off' }).mode, 'off', 'E-74 项目显式关闭一律尊重（用户说停就停）');
  eq(resolveMode({ projectMode: 'capability' }).mode, 'capability', 'E-75 显式能力优先且前提成立 ⇒ 直接用');
  eq(resolveMode({ projectMode: 'capability', tier: 'pro' }).mode, 'overflow',
    'E-76 显式能力优先但前提不满足 ⇒ 退回全局偏好（不硬派）');
  eq(resolveMode({ projectMode: 'off', tier: 'pro' }).mode, 'off', 'E-77 「关」不被档位不足改写（off 优先）');
  eq(resolveMode({ hasDivision: true }).mode, 'capability', 'E-78 未显式且有分工登记 ⇒ 默认能力优先');
  eq(resolveMode({ hasDivision: false }).mode, 'overflow', 'E-79 无分工登记 ⇒ 按全局偏好');
  eq(resolveMode({ globalMode: 'off', hasDivision: true }).mode, 'off', 'E-80 全局总闸关 ⇒ 连分工项目也不派');
  ok(resolveMode({ projectMode: 'capability', tier: 'pro' }).reason.includes('需要团队版'),
    'E-81 退回时把缺什么说清（不作哑降级）');

  // ── ⑩ 文档对码：license-tiers §1 的数字与 TIER_LIMITS 逐一相等 ──
  const mdLines = readSrc('business-plan/license-tiers.md').split('\n');
  const cellsOf = (line: string): string[] => line.split('|').slice(1, -1).map((c) => c.trim());
  const headerLine = mdLines.find((l) => l.trimStart().startsWith('| 档位 |'));
  ok(!!headerLine, 'E-82 license-tiers §1 总表在册');
  const headerCells = headerLine ? cellsOf(headerLine) : [];
  const rowOfTier = (tier: string): string[] | undefined =>
    mdLines.map(cellsOf).find((cells) => (cells[0] ?? '').replace(/`/g, '') === tier);
  const cellNum = (cell: string | undefined): number | null => {
    const m = (cell ?? '').replace(/\*/g, '').trim().match(/^(\d+)/);
    return m ? Number(m[1]) : null;
  };
  const matchesLimit = (cell: string | undefined, value: number): boolean =>
    value === 0
      ? (cell ?? '').includes('不限') || cellNum(cell) === 0
      : cellNum(cell) === value;
  const DIMS: Array<[keyof typeof TIER_LIMITS['community'], string]> = [
    ['maxProjectConcurrency', '单项目并发上限'],
    ['maxProjects', '项目总数上限'],
    ['maxMembers', '本机账号上限'],
    ['maxNodes', '协同节点上限（含本机）'],
    ['maxDevices', '设备登记上限'],
    ['maxExternalTerminals', '外部终端上限'],
    ['maxA2AServers', 'A2A 服务上限'],
    ['maxKnowledgeCardsPerProject', '每项目知识卡上限'],
    ['maxTeamLibraryMemories', '团队共享记忆导入上限'],
    ['maxIMChannels', 'IM 渠道上限'],
    ['maxTaskTemplates', '任务模板上限（用户自建）'],
    ['maxCloudAccounts', '设备云账号上限'],
  ];
  for (const tier of ['community', 'pro', 'team'] as const) {
    const row = rowOfTier(tier);
    ok(!!row, `E-83.${tier} 表中该档行在册`);
    for (const [key, title] of DIMS) {
      const idx = headerCells.indexOf(title);
      ok(idx > 0 && matchesLimit(row?.[idx], TIER_LIMITS[tier][key]),
        `E-84.${tier}.${key} 表与 TIER_LIMITS 一致`);
    }
  }
  ok(!!rowOfTier('（试用）') || mdLines.some((l) => l.includes('（试用）')),
    'E-85 试用档在表中如实单列（视同团队版）');

  // ── ⑪ 渲染层：岗位标签与六类目条同源投影；未上报/未知如实说 ──
  const fakeNode = (card: unknown): Parameters<typeof nodePositions>[0] => ({ card } as never);
  eq(nodePositions(fakeNode({ positions: [{ id: 'p1', name: '财务', version: 2 }, { id: '', name: '坏', version: 1 }] })),
    { reported: true, items: [{ id: 'p1', name: '财务', version: 2 }] },
    'E-86 岗位逐条洗形（坏条目丢弃），已上报标记为真');
  eq(nodePositions(fakeNode({})), { reported: false, items: [] },
    'E-87 旧卡没有 positions 键 ⇒ 未上报（不是「没有岗位」）');
  const classEnv = { class_running: { text: 0, code: 2, research: 0, media: 0, device: 0, project_task: 1 } } as never;
  eq(classLoadView(classEnv).map((r) => r.running), [0, 2, 0, 0, 0, 1],
    'E-88 六类目条按固定词表序取值（面板次序不跳）');
  eq(classLoadView({ class_running: null } as never).every((r) => r.running === null), true,
    'E-89 未上报 ⇒ 六类全 null，面板应说「未知」');
  const viewSrc = readSrc(`${A}/renderer/src/lib/node-view.ts`);
  ok(viewSrc.includes('class_running: classRunningOf(s.class_running)') && viewSrc.includes('NODE_CARD_CATEGORIES'),
    'E-90 渲染层解析同引六类词表（不手抄第二份）');
  const peersSrc = readSrc(`${A}/renderer/src/pages/PeersPage.tsx`);
  ok(peersSrc.includes('nodePositions(node)') && peersSrc.includes('未上报'),
    'E-91 节点卡渲染岗位，未上报如实说（不画成「没有岗位」）');
  ok(peersSrc.includes('classLoadView(env)') && peersSrc.includes('类目在飞') && peersSrc.includes("'未知'"),
    'E-92 六类目条上屏，未知如实标（不画 0）');
  const settingsSrcE = readSrc(`${A}/renderer/src/pages/SettingsPage.tsx`);
  const usageDims = ['设备登记', '外部终端', 'A2A 服务', 'IM 渠道', '任务模板', '设备云账号', '每项目知识卡', '团队共享记忆'];
  ok(usageDims.every((d) => settingsSrcE.includes(`label="${d}`)),
    'E-93 设置页八维容量逐项可核对（当前/上限同一把尺）');
}

async function main(): Promise<void> {
  sectionS();
  sectionA();
  sectionB();
  await sectionC();
  sectionD();
  sectionE();

  console.log(`\n[rr_zx_20261112_1] ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error('\nrr_zx_20261112_1 未捕获异常（复跑未跑完，不得读作通过）：', e);
  console.log(`\n[rr_zx_20261112_1] ${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
