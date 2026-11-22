/**
 * zx_20261121_3 「用·见」受控复跑。
 *
 * 分组：
 *   A 知识待办读模型（四组：经验 / 技能 / 领域包 / 提案）
 *   B 读模型判据（聚合、忽略、已启用、失败不回落 0）
 *   C 任务侧（本任务待审经验）
 *   D 首行（completed + pendingLessonCount）
 *   E UI/IPC 接线
 *   F 实时事件（knowledge.changed）
 *   G 反证与静态（无自动采纳/自动启用；零 LLM/网络/electron）
 *   H 构建钉
 *   I 设计真源（token / 原语 / 12 页页头 / 动效纪律）
 *
 * 纪律：断言文案不含失败字形；夹具按生产初始化顺序；不写“只为下一轮”的字面量；
 *       build 由 `checkBuildPins` 派生核对。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { checkBuildPins, buildNotOlderThan } from './lib/rr-pins.js';
import { initDatabase } from '../apps/worker-ant-desktop/src/main/database.js';

let pass = 0;
let fail = 0;
let skipped = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ok ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}
function skip(label: string): void { skipped++; console.log(`  · SKIP ${label}`); }

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const SELF = path.basename(__filename).replace(/\.ts$/, '');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261121-3-'));
let dbSeq = 0;
function mkdb(): Database.Database {
  return initDatabase(path.join(tmpRoot, `db-${++dbSeq}`));
}

const PACK_JSON = (projectId: string, projectName: string, term: string): string => JSON.stringify({
  version: 1,
  name: `${projectName} · 领域包`,
  description: '夹具',
  sections: [{ section: 'domain', content: `${term}：夹具术语` }],
  source: { project_id: projectId, project_name: projectName },
  derived_at: '2026-11-21T00:00:00.000Z',
  training: false,
  omitted_sections: [],
});

/** 建项目/任务/岗位三张最小底表（不 seed 内置岗位，计数清楚）。 */
function seedBase(db: Database.Database): void {
  db.exec(`
    INSERT INTO wa_projects (id, name) VALUES ('p1', '项目甲'), ('p2', '项目乙');
    INSERT INTO wa_tasks (id, project_id, title, status) VALUES ('t1', 'p1', '任务一', 'completed'), ('t2', 'p2', '任务二', 'completed');
    INSERT INTO wa_positions (id, name) VALUES ('pos1', '夹具财务'), ('pos2', '夹具税务');
  `);
}

function seedLesson(
  db: Database.Database,
  input: { id: string; positionId: string; taskId: string; projectId: string; status?: string; content?: string; reusable?: number; origin?: string; verifiedAt?: string | null },
): void {
  db.prepare(
    `INSERT INTO wa_position_lessons
       (id, position_id, task_id, project_id, content, status, source, reusable, origin, verified_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'summary', ?, ?, ?, datetime('now'))`,
  ).run(
    input.id, input.positionId, input.taskId, input.projectId,
    input.content ?? '经验正文', input.status ?? 'pending',
    input.reusable ?? 1, input.origin ?? 'local',
    input.verifiedAt === undefined ? '2026-11-21T00:00:00.000Z' : input.verifiedAt,
  );
}

function seedPack(
  db: Database.Database,
  input: { id: string; sourceProjectId: string; sourceProjectName: string; origin?: string; dismissedAt?: string | null; updatedAt?: string },
): void {
  db.prepare(
    `INSERT INTO wa_domain_packs (id, name, description, pack_json, source_project_id, source_project_name, origin, dismissed_at, created_at, updated_at)
     VALUES (?, ?, '', ?, ?, ?, ?, ?, datetime('now'), ?)`,
  ).run(
    input.id, `${input.sourceProjectName} · 领域包`, PACK_JSON(input.sourceProjectId, input.sourceProjectName, input.id),
    input.sourceProjectId, input.sourceProjectName, input.origin ?? 'auto_candidate',
    input.dismissedAt ?? null, input.updatedAt ?? '2026-11-21 00:00:00',
  );
}

function seedProposal(db: Database.Database, id: string, status: string): void {
  db.prepare(
    "INSERT INTO wa_self_evolve_proposals (id, kind, target, payload_json, status, note, created_at) VALUES (?, 'threshold', 'k', '{}', ?, '夹具', datetime('now'))",
  ).run(id, status);
}

// ==================== A：知识待办读模型 ====================
async function runA(): Promise<void> {
  console.log('\n[A] 知识待办读模型');
  let mod: typeof import('../apps/worker-ant-desktop/src/main/core/knowledge-inbox.js');
  let se: typeof import('../apps/worker-ant-desktop/src/main/core/self-evolve.js');
  try {
    mod = await import('../apps/worker-ant-desktop/src/main/core/knowledge-inbox.js');
    se = await import('../apps/worker-ant-desktop/src/main/core/self-evolve.js');
  } catch (e) { fail++; console.error(`  FAIL 模块在场 — ${(e as Error).message}`); return; }

  // 空库（有提案表）⇒ 四组 ok/0
  const db = mkdb();
  se.ensureSelfEvolveTable(db);
  seedBase(db);
  const empty = mod.buildKnowledgeInbox(db as never);
  for (const k of ['lessons', 'skills', 'packs', 'proposals'] as const) {
    eq(empty[k].status, 'ok', `${k} 空库为 ok`);
    eq(empty[k].status === 'ok' ? empty[k].count : -1, 0, `${k} 空库计数为 0`);
  }

  // 各插 1 行 ⇒ 计数从 0 变 1
  seedLesson(db, { id: 'l1', positionId: 'pos1', taskId: 't1', projectId: 'p1' });
  db.prepare("INSERT INTO wa_position_skills (id, position_id, name, description, steps_json, status) VALUES ('s1','pos1','技能一','说明','[\"第一步\"]','draft')").run();
  seedPack(db, { id: 'pk1', sourceProjectId: 'p1', sourceProjectName: '项目甲' });
  seedProposal(db, 'pr1', 'pending');
  const one = mod.buildKnowledgeInbox(db as never);
  eq(one.lessons.status === 'ok' ? one.lessons.count : -1, 1, '经验计数 0 变 1');
  eq(one.skills.status === 'ok' ? one.skills.count : -1, 1, '技能计数 0 变 1');
  eq(one.packs.status === 'ok' ? one.packs.count : -1, 1, '领域包计数 0 变 1');
  eq(one.proposals.status === 'ok' ? one.proposals.count : -1, 1, '提案计数 0 变 1');
  eq(one.skills.status === 'ok' ? one.skills.items[0]?.stepsPreview : '', '第一步', '技能步骤摘要');
  eq(one.lessons.status === 'ok' ? one.lessons.items[0]?.positionName : '', '夹具财务', '经验带岗位名');
  eq(one.lessons.status === 'ok' ? one.lessons.items[0]?.projectName : '', '项目甲', '经验带项目名');
  eq(one.lessons.status === 'ok' ? one.lessons.items[0]?.taskTitle : '', '任务一', '经验带任务标题');

  // 只收 pending / draft
  seedLesson(db, { id: 'l2', positionId: 'pos2', taskId: 't2', projectId: 'p2', status: 'accepted' });
  db.prepare("INSERT INTO wa_position_skills (id, position_id, name, description, steps_json, status) VALUES ('s2','pos2','技能二','','[]','approved')").run();
  seedProposal(db, 'pr2', 'applied');
  const filtered = mod.buildKnowledgeInbox(db as never);
  eq(filtered.lessons.status === 'ok' ? filtered.lessons.count : -1, 1, '已采纳经验不进待办');
  eq(filtered.skills.status === 'ok' ? filtered.skills.count : -1, 1, '已批技能不进待办');
  eq(filtered.proposals.status === 'ok' ? filtered.proposals.count : -1, 1, '已生效提案不进待办');

  // limit：计数不截断、条目有界；0 ⇒ 缺省；超大 ⇒ 钳 100
  for (let i = 0; i < 4; i++) seedLesson(db, { id: `lx${i}`, positionId: 'pos1', taskId: `tx${i}`, projectId: 'p1' });
  const lim = mod.buildKnowledgeInbox(db as never, { limit: 2 });
  eq(lim.lessons.status === 'ok' ? lim.lessons.count : -1, 5, '计数不随 limit 截断');
  eq(lim.lessons.status === 'ok' ? lim.lessons.items.length : -1, 2, '条目按 limit 有界');
  const lim0 = mod.buildKnowledgeInbox(db as never, { limit: 0 });
  ok(lim0.lessons.status === 'ok' && lim0.lessons.items.length > 2, 'limit=0 回落缺省（不返回空）');

  // 读不到 ≠ 0：缺表 ⇒ 该组 error；其余组照常
  const bad = mkdb();
  bad.prepare('DROP TABLE wa_position_lessons').run();
  const broken = mod.buildKnowledgeInbox(bad as never);
  eq(broken.lessons.status, 'error', '缺经验表 ⇒ error（不回落 0）');
  eq(broken.skills.status, 'ok', '缺经验表不影响技能组');
  eq(broken.proposals.status, 'error', '缺提案表 ⇒ error（不回落 0）');

  // 坏 steps JSON 不抛
  const badJson = mkdb();
  seedBase(badJson);
  badJson.prepare("INSERT INTO wa_position_skills (id, position_id, name, description, steps_json, status) VALUES ('s9','pos1','坏','','{bad','draft')").run();
  const bj = mod.buildKnowledgeInbox(badJson as never);
  eq(bj.skills.status === 'ok' ? bj.skills.items[0]?.stepsPreview : 'X', '', '坏 steps JSON ⇒ 空摘要（不抛）');
}

// ==================== B：读模型判据 ====================
async function runB(): Promise<void> {
  console.log('\n[B] 读模型判据');
  let mod: typeof import('../apps/worker-ant-desktop/src/main/core/knowledge-inbox.js');
  let se: typeof import('../apps/worker-ant-desktop/src/main/core/self-evolve.js');
  try {
    mod = await import('../apps/worker-ant-desktop/src/main/core/knowledge-inbox.js');
    se = await import('../apps/worker-ant-desktop/src/main/core/self-evolve.js');
  } catch (e) { fail++; console.error(`  FAIL 模块在场 — ${(e as Error).message}`); return; }

  const db = mkdb();
  se.ensureSelfEvolveTable(db);
  seedBase(db);
  seedPack(db, { id: 'pkA', sourceProjectId: 'p1', sourceProjectName: '项目甲', updatedAt: '2026-11-21 01:00:00' });
  seedPack(db, { id: 'pkB', sourceProjectId: 'p1', sourceProjectName: '项目甲2', updatedAt: '2026-11-21 02:00:00' });
  seedPack(db, { id: 'pkC', sourceProjectId: 'p2', sourceProjectName: '项目乙', dismissedAt: '2026-11-21 03:00:00' });

  const r = mod.buildKnowledgeInbox(db as never);
  const packs = r.packs.status === 'ok' ? r.packs.items : [];
  eq(packs.map((p) => p.packId).sort(), ['pkA', 'pkB'], '候选包收未忽略的两条（已忽略不复活）');
  const pkA = packs.find((p) => p.packId === 'pkA');
  eq(pkA?.projects.map((x) => x.id), ['p2'], '来源项目自己不出现（只建议给别的项目）');
  eq(pkA?.sourceProjectName, '项目甲', '带来源项目名');
  ok(Boolean(pkA?.sectionPreview), '带内容预览');

  // 同一包建议多项目 ⇒ 一条 item、多项目
  seedPack(db, { id: 'pkD', sourceProjectId: 'p1', sourceProjectName: '项目甲', updatedAt: '2026-11-21 04:00:00' });
  db.prepare("INSERT INTO wa_project_domain_packs (project_id, pack_id) VALUES ('p2', 'pkD')").run();
  const p3 = mkdb();
  // 三项目场景：pkD 从 p1 派生，p2/p3 都可建议（p2 已启用 ⇒ 只剩 p3）
  se.ensureSelfEvolveTable(p3);
  p3.exec("INSERT INTO wa_projects (id, name) VALUES ('p1','甲'),('p2','乙'),('p3','丙')");
  seedPack(p3, { id: 'pkD', sourceProjectId: 'p1', sourceProjectName: '甲' });
  p3.prepare("INSERT INTO wa_project_domain_packs (project_id, pack_id) VALUES ('p2', 'pkD')").run();
  const p3r = mod.buildKnowledgeInbox(p3 as never);
  const p3packs = p3r.packs.status === 'ok' ? p3r.packs.items : [];
  eq(p3packs.length, 1, '同一包多项目建议聚合成一条');
  eq(p3packs[0]?.projects.map((x) => x.id), ['p3'], '已启用项目从该项目列表排除');

  // 提案只认 pending，计数与条目一致
  seedProposal(db, 'prA', 'pending');
  seedProposal(db, 'prB', 'rejected');
  const rr = mod.buildKnowledgeInbox(db as never);
  eq(rr.proposals.status === 'ok' ? rr.proposals.count : -1, 1, '提案只数 pending');
}

// ==================== C：任务侧 ====================
async function runC(): Promise<void> {
  console.log('\n[C] 任务侧');
  let mod: typeof import('../apps/worker-ant-desktop/src/main/core/knowledge-inbox.js');
  try { mod = await import('../apps/worker-ant-desktop/src/main/core/knowledge-inbox.js'); }
  catch (e) { fail++; console.error(`  FAIL 模块在场 — ${(e as Error).message}`); return; }

  const db = mkdb();
  seedBase(db);
  seedLesson(db, { id: 'tl1', positionId: 'pos1', taskId: 't1', projectId: 'p1' });
  seedLesson(db, { id: 'tl2', positionId: 'pos2', taskId: 't2', projectId: 'p2' });
  seedLesson(db, { id: 'tl3', positionId: 'pos1', taskId: 't3', projectId: 'p1', status: 'accepted' });

  const t1 = mod.pendingLessonsForTask(db as never, 't1');
  eq(t1.status === 'ok' ? t1.count : -1, 1, '只回本任务待审经验');
  eq(t1.status === 'ok' ? t1.items[0]?.id : '', 'tl1', '不串到别的任务');
  eq(t1.status === 'ok' ? t1.items[0]?.content : '', '经验正文', '带经验正文');
  const empty = mod.pendingLessonsForTask(db as never, '');
  eq(empty.status === 'ok' ? empty.count : -1, 0, '空 taskId ⇒ ok/0');

  const bad = mkdb();
  bad.prepare('DROP TABLE wa_position_lessons').run();
  const broken = mod.pendingLessonsForTask(bad as never, 't1');
  eq(broken.status, 'error', '缺表 ⇒ error（不回落 0）');
}

// ==================== D：首行 ====================
async function runD(): Promise<void> {
  console.log('\n[D] 首行');
  let na: typeof import('../apps/worker-ant-desktop/src/main/core/next-action.js');
  try { na = await import('../apps/worker-ant-desktop/src/main/core/next-action.js'); }
  catch (e) { fail++; console.error(`  FAIL 模块在场 — ${(e as Error).message}`); return; }

  const one = na.nextActionForTask({ status: 'completed', pendingLessonCount: 1 });
  eq(one.key, 'task.lesson_pending', '已完成 + 1 条待审 ⇒ 首行改口');
  eq(one.tone, 'act', '待审经验是「该我办」');
  eq(one.action?.id, 'review_lesson', '动作指向本页经验卡');
  ok(one.headline.includes('1'), 'headline 带真实条数', one.headline);

  for (const v of [0, null, undefined] as const) {
    const r = na.nextActionForTask({ status: 'completed', pendingLessonCount: v });
    eq(r.key, 'task.completed', `已完成 + ${String(v)} ⇒ 与旧行为一致`);
  }
  const failed = na.nextActionForTask({ status: 'failed', pendingLessonCount: 3 });
  eq(failed.key, 'task.failed', '失败首行不被经验抢走');
  const paused = na.nextActionForTask({ status: 'paused', pendingLessonCount: 3 });
  eq(paused.key, 'task.paused', '暂停首行不被经验抢走');

  eq(na.resolveNextActionRoute('review_lesson', 'completed'), 'ignore', 'review_lesson 走页内处理');
  eq(na.resolveNextActionRoute('start_task', 'pending'), 'start', '既有路由不变');
}

// ==================== E：UI/IPC 接线 ====================
function runE(): void {
  console.log('\n[E] UI/IPC 接线');
  const read = (rel: string): string => fs.readFileSync(path.join(root, A, rel), 'utf-8');

  const ipc = read('src/main/ipc/knowledge.ipc.ts');
  ok(ipc.includes("ipcMain.handle('knowledge:inbox'"), 'knowledge:inbox 在册');
  ok(ipc.includes("ipcMain.handle('knowledge:forTask'"), 'knowledge:forTask 在册');

  const lib = read('renderer/src/lib/ipc.ts');
  ok(lib.includes("'knowledge:inbox'") && lib.includes("'knowledge:forTask'"), '渲染层 IPC 信封在册');

  const inbox = read('renderer/src/pages/InboxPage.tsx');
  ok(inbox.includes('knowledgeApi.inbox'), '待办中心调知识读模型');
  ok(inbox.includes('positionsApi.decideLesson'), '经验采纳/忽略走既有写口');
  ok(inbox.includes('positionsApi.skillDecide'), '技能批准/驳回走既有写口');
  ok(inbox.includes('packs.apply') && inbox.includes('packs.dismiss'), '领域包启用/忽略走既有写口');
  ok(inbox.includes('admin.selfEvolveDecide'), '提案决定走既有写口');
  ok(inbox.includes('批量采纳'), '经验支持勾选批量采纳');
  ok(inbox.includes('读取失败'), '读失败如实上屏（不冒充没有）');

  const detail = read('renderer/src/pages/TaskDetailPage.tsx');
  ok(detail.includes('knowledgeApi.forTask'), '任务详情调本任务待审经验');
  ok(detail.includes('decideTaskLesson') && detail.includes('positionsApi.decideLesson'), '任务详情就地决定');
  ok(detail.includes("id=\"task-lesson-card\""), '经验卡锚点在场');
  ok(detail.includes("review_lesson"), '首行动作接线');

  ok(!/FROM\s+wa_/i.test(inbox) && !/FROM\s+wa_/i.test(detail), '页面不手写 SQL');
  const app = read('renderer/src/App.tsx');
  ok(!app.includes('/knowledge'), '没有新增第 29 个知识页（复用 /inbox）');

  const bell = read('renderer/src/components/ActionNeeded.tsx');
  ok(bell.includes('knowledgeApi.inbox'), '铃铛计入知识待办');
  ok(bell.includes("'knowledge.changed'"), '铃铛订阅知识变化');
  ok(bell.includes('知识待办') && bell.includes('/inbox#knowledge'), '铃铛只给入口（不直接批）');
  ok(!bell.includes('decideLesson') && !bell.includes('skillDecide'), '铃铛不直接做知识决定');
}

// ==================== F：实时事件 ====================
function runF(): void {
  console.log('\n[F] 实时事件');
  const read = (rel: string): string => fs.readFileSync(path.join(root, A, rel), 'utf-8');

  const ev = read('src/main/core/refresh-events.ts');
  ok(ev.includes('emitKnowledgeChanged') && ev.includes("emitTransient('knowledge.changed'"), '发点是瞬态事件');
  ok(!/emit\('knowledge\.changed'/.test(ev), '不进不可变事件日志');

  const main = read('src/main/index.ts');
  ok(main.includes("eventBus.on('knowledge.changed'"), '主进程转发到渲染层');

  const act = read('renderer/src/lib/activity.tsx');
  ok(act.includes("'knowledge.changed'"), '活动词表登记');

  ok(read('src/main/ipc/positions.ipc.ts').includes("emitKnowledgeChanged('position.lesson_decide'"), '经验决定后发');
  ok(read('src/main/ipc/positions.ipc.ts').includes("emitKnowledgeChanged('position.skill_decide'"), '技能决定后发');
  ok(read('src/main/ipc/packs.ipc.ts').includes("emitKnowledgeChanged('packs.apply'"), '包启用后发');
  ok(read('src/main/ipc/knowledge.ipc.ts').includes("emitKnowledgeChanged('packs.dismiss'"), '包忽略后发');
  ok(read('src/main/ipc/admin.ipc.ts').includes("emitKnowledgeChanged('self_evolve.decide'"), '提案决定后发');
}

// ==================== G：反证与静态 ====================
function runG(): void {
  console.log('\n[G] 反证与静态');
  const read = (rel: string): string => fs.readFileSync(path.join(root, A, rel), 'utf-8');

  const inbox = read('src/main/core/knowledge-inbox.ts');
  ok(!/\b(run|exec)\(/.test(inbox), '读模型不写库');
  ok(!/from\s+'electron'/.test(inbox) && !/fetch\(|node:https?|bonjour/.test(inbox), '读模型零 electron / 零网络');
  ok(!/openai|createSafeProvider|generateText|streamText/.test(inbox), '读模型零 LLM');

  const pack = read('src/main/core/domain-pack.ts');
  const candStart = pack.indexOf('export function ensureAutoCandidateDomainPack');
  const candEnd = pack.indexOf('/** 预览边界', candStart);
  const candBody = candStart >= 0 && candEnd > candStart ? pack.slice(candStart, candEnd) : '';
  ok(candBody.length > 0 && !/applyDomainPack\(/.test(candBody), '候选包生成不自动启用');

  const tier = read('src/main/core/tier-catalog.ts') + read('src/main/core/pro-gate.ts') + read('src/main/core/feature-limits.ts');
  ok(!/knowledge_inbox|knowledgeInbox/.test(tier), '未新增档位能力键');

  const pages = read('renderer/src/pages/InboxPage.tsx') + read('renderer/src/pages/TaskDetailPage.tsx');
  ok(!/decision\s*[:=]\s*'accepted'[\s\S]{0,40}auto/i.test(pages), '页面没有「自动采纳」开关');
  ok(!/自动采纳|自动启用/.test(pages) || pages.includes('不会自动生效'), '页面不宣称自动决定');

  const git = fs.readFileSync(path.join(root, 'apps/worker-ant-desktop/src/main/core/positions.ts'), 'utf-8');
  ok(git.includes('人工确认') || git.includes('人工采纳'), '经验仍以人工确认为准');
}

// ==================== I：设计真源 ====================
function runI(): void {
  console.log('\n[I] 设计真源');
  const read = (rel: string): string => fs.readFileSync(path.join(root, A, rel), 'utf-8');

  const css = read('renderer/src/index.css');
  ok(css.includes('@theme'), 'index.css 有 @theme（token 唯一真源）');
  for (const token of ['--color-paper', '--color-ink', '--color-line', '--color-accent', '--color-cinnabar', '--font-sans', '--font-display', '--font-mono', '--radius-card', '--shadow-card']) {
    ok(css.includes(token), `token 在册：${token}`);
  }
  ok(css.includes('prefers-reduced-motion'), '尊重减少动效');
  ok(css.includes('@utility tnum') && css.includes('@utility measure'), '等宽数字与正文栏宽工具在册');

  const ui = read('renderer/src/components/ui/index.ts');
  for (const name of ['PageHeader', 'Card', 'Section', 'Button', 'EmptyState', 'ErrorState', 'Skeleton', 'Stat', 'Pill']) {
    ok(ui.includes(name), `原语在册：${name}`);
  }

  const pages = [
    'DashboardPage', 'TasksPage', 'ProjectsPage', 'ProjectDetailPage', 'PositionsPage',
    'PeersPage', 'DevicesPage', 'MemoriesPage', 'DeliverablesPage', 'SettingsPage',
  ];
  for (const p of pages) {
    const src = read(`renderer/src/pages/${p}.tsx`);
    ok(src.includes('PageHeader'), `${p} 使用统一页头`);
  }
  ok(read('renderer/src/pages/TaskDetailPage.tsx').includes("from '../components/ui'"), '任务详情使用共用原语');
  ok(read('renderer/src/pages/InboxPage.tsx').includes("from '../components/ui'"), '待办中心使用共用原语');
}

(async () => {
  await runA();
  await runB();
  await runC();
  await runD();
  runE();
  runF();
  runG();
  runI();

  {
    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
    const src = fs.readFileSync(path.join(root, A, 'src/main/core/agent-executor.ts'), 'utf-8');
    const m = /build:\s*'(zx_\d{8}(?:_\d+)?)'/.exec(src);
    const tag = m?.[1] ?? '';
    ok(buildNotOlderThan(tag, SELF.replace(/^rr_/, '')), 'build 不早于本套件轮次', `${tag} vs ${SELF}`);
    ok(fs.existsSync(path.join(root, 'plans/improve', `${SELF.replace(/^rr_/, '')}.md`)), '本轮方案文件在场');
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  if (fail > 0) process.exitCode = 1;
})();
