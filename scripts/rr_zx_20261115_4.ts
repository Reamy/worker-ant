/**
 * zx_20261115_4「岗·识·启」——岗位真上场（A/B/C）、IM 真听懂（D/E）、岗位成团队资产（F）。
 *
 * 判据分组：
 *   S「基」构建钉 P1–P6 + 本轮方案在册。
 *   A「派」补派 / 改派 / 解绑岗位（真写口 0→1；终态拒改；未绑定拒；值未变不写）。
 *   B「问」IM 缺岗位三态（none / reuse / ask）+ 开关可关。
 *   C「账」没沉淀就说为什么（带岗位才留痕；不带岗位不刷噪音）。
 *   D「法」`项目#名称` 语法（含全角；老语法逐字节零回归）。
 *   E「话」回执说人话（带原话摘录、不带内部词；禁词扫描）。
 *   F「墙」岗位知识团队共享（只带已采纳经验；导入一律待审）。
 *
 * 纪律（承 CLAUDE.md）：
 *   - 轮次钉由 checkBuildPins 从真源派生，不写「只为下一轮」的字面量；
 *   - 断言文案禁含失败字形（`pnpm rr:all` 汇总器按字形计数）；
 *   - 夹具按生产初始化顺序搭：先 DDL 再插数据行；
 *   - 计数器类断言必须有「值从 0 变 1」的正面断言。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import {
  POSITIONS_DDL,
  applyTaskPositionChange,
  createPosition,
  explainNoLesson,
  generatePositionLessonCandidateDetailed,
  insertPositionLessonCandidate,
  type PositionDb,
} from '../apps/worker-ant-desktop/src/main/core/positions.js';
import { markCompletedRun } from '../apps/worker-ant-desktop/src/main/core/postlude.js';
import { parseImTargets, splitTaskInput } from '../apps/worker-ant-desktop/src/main/core/im/task-input.js';
import { ECHO_EXCERPT_MAX, intentEcho } from '../apps/worker-ant-desktop/src/main/core/im-echo.js';
import { importItem, shareItem, type TeamLibraryDb } from '../apps/worker-ant-desktop/src/main/core/team-library.js';
import { TEAM_ITEM_KINDS } from '../packages/shared-types/src/team.js';
import {
  positionPromptDecision,
  positionPromptText,
  positionReuseNote,
} from '../apps/worker-ant-desktop/src/main/core/im/position-prompt.js';

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

/* ── 夹具 ─────────────────────────────────────────────────────────────── */

/** 最小任务表（只用本组断言需要的列；POSITIONS_DDL 负责岗位三表）。 */
const TASKS_DDL = `
  CREATE TABLE IF NOT EXISTS wa_tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    position_id TEXT NOT NULL DEFAULT '',
    acceptance_criteria TEXT NOT NULL DEFAULT '',
    context_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(POSITIONS_DDL);
  db.exec(TASKS_DDL);
  return db;
}

/** `createPosition` 自生成 id —— 夹具按名取回（不手抄内部 id 规则）。 */
function seedPosition(db: DatabaseSync, _id: string, name: string): void {
  createPosition(db as unknown as PositionDb, { name, category: 'custom', description: '', skills: [], rules: [], knowledge: [] });
}

function posIdByName(db: DatabaseSync, name: string): string {
  const row = db.prepare('SELECT id FROM wa_positions WHERE name = ?').get(name) as { id?: string } | undefined;
  return String(row?.id ?? '');
}

function bindPosition(db: DatabaseSync, projectId: string, positionId: string, enabled = 1): void {
  db.prepare('INSERT OR REPLACE INTO wa_project_positions (project_id, position_id, enabled) VALUES (?, ?, ?)')
    .run(projectId, positionId, enabled);
}

function insertTask(db: DatabaseSync, o: { id: string; projectId: string; status?: string; positionId?: string; ctx?: Record<string, unknown>; createdAt?: string }): void {
  db.prepare(
    'INSERT INTO wa_tasks (id, project_id, title, status, position_id, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(o.id, o.projectId, o.id, o.status ?? 'pending', o.positionId ?? '', JSON.stringify(o.ctx ?? {}), o.createdAt ?? '2026-11-15 08:00:00');
}

function taskPosition(db: DatabaseSync, taskId: string): string {
  const row = db.prepare('SELECT position_id FROM wa_tasks WHERE id = ?').get(taskId) as { position_id?: string } | undefined;
  return String(row?.position_id ?? '');
}

/* ── S「基」 ─────────────────────────────────────────────────────────── */

function sectionS(): void {
  console.log('\n【S】构建钉与本轮方案');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

/* ── A「派」补派 / 改派 / 解绑（M1）───────────────────────────────────── */

function sectionA(): void {
  console.log('\n【A】补派 / 改派 / 解绑岗位');
  const db = freshDb();
  seedPosition(db, 'p_fin', '财务');
  seedPosition(db, 'p_tax', '税务');
  const fin = posIdByName(db, '财务');
  const tax = posIdByName(db, '税务');
  ok(!!fin && !!tax, 'A0 夹具：两个岗位已建', `${fin} / ${tax}`);
  bindPosition(db, 'proj_a', fin);
  bindPosition(db, 'proj_a', tax);

  // A1 补派：0 → 1（正面断言，不只看"不抛"）
  insertTask(db, { id: 't_a1', projectId: 'proj_a' });
  const r1 = applyTaskPositionChange(db as unknown as PositionDb, 't_a1', fin);
  eq(r1, { ok: true, changed: true, from: '', to: fin, projectId: 'proj_a' }, 'A1a 补派返回 changed=true 且 from 为空');
  eq(taskPosition(db, 't_a1'), fin, 'A1b ★真写口：task.position_id 由空变财务（0→1）');

  // A2 值未变 ⇒ 不写（changed=false；updated_at 不动）
  const before = (db.prepare('SELECT updated_at FROM wa_tasks WHERE id = ?').get('t_a1') as { updated_at?: string }).updated_at;
  const r2 = applyTaskPositionChange(db as unknown as PositionDb, 't_a1', fin);
  eq(r2, { ok: true, changed: false, from: fin, to: fin, projectId: 'proj_a' }, 'A2a 值未变 ⇒ changed=false（"点保存"不刷空改动）');
  eq((db.prepare('SELECT updated_at FROM wa_tasks WHERE id = ?').get('t_a1') as { updated_at?: string }).updated_at, before, 'A2b updated_at 未被无谓改写');

  // A3 改派：fin → tax
  const r3 = applyTaskPositionChange(db as unknown as PositionDb, 't_a1', tax);
  eq(r3, { ok: true, changed: true, from: fin, to: tax, projectId: 'proj_a' }, 'A3a 改派 changed=true');
  eq(taskPosition(db, 't_a1'), tax, 'A3b 真改成税务');

  // A4 未在本项目启用的岗位 ⇒ 拒，且原值逐字节不变
  seedPosition(db, 'p_gone', '未绑定岗');
  const unbound = posIdByName(db, '未绑定岗');
  const r4 = applyTaskPositionChange(db as unknown as PositionDb, 't_a1', unbound);
  ok(r4.ok === false && r4.code === 'POSITION_NOT_IN_PROJECT', 'A4a 未绑定岗位 ⇒ POSITION_NOT_IN_PROJECT', JSON.stringify(r4));
  eq(taskPosition(db, 't_a1'), tax, 'A4b ★拒绝时 position_id 逐字节不变');

  // A5 终态任务拒改
  insertTask(db, { id: 't_a5', projectId: 'proj_a', status: 'completed', positionId: fin });
  const r5 = applyTaskPositionChange(db as unknown as PositionDb, 't_a5', tax);
  ok(r5.ok === false && r5.code === 'TASK_TERMINAL', 'A5a 已完成任务 ⇒ TASK_TERMINAL', JSON.stringify(r5));
  eq(taskPosition(db, 't_a5'), fin, 'A5b ★历史归属不被改写');
  insertTask(db, { id: 't_a5b', projectId: 'proj_a', status: 'archived', positionId: fin });
  const r5b = applyTaskPositionChange(db as unknown as PositionDb, 't_a5b', tax);
  ok(r5b.ok === false && r5b.code === 'TASK_TERMINAL', 'A5c 归档任务同样拒改', JSON.stringify(r5b));

  // A6 解绑：非空 → 空（正面断言）
  const r6 = applyTaskPositionChange(db as unknown as PositionDb, 't_a1', '');
  eq(r6, { ok: true, changed: true, from: tax, to: '', projectId: 'proj_a' }, 'A6a 解绑 changed=true');
  eq(taskPosition(db, 't_a1'), '', 'A6b ★真解绑：position_id 由税务变空');

  // A7 任务不存在
  const r7 = applyTaskPositionChange(db as unknown as PositionDb, 't_nope', fin);
  ok(r7.ok === false && r7.code === 'NOT_FOUND', 'A7 任务不存在 ⇒ NOT_FOUND', JSON.stringify(r7));

  // A8 停用岗位同样拒（岗位 enabled=0）
  db.prepare('UPDATE wa_positions SET enabled = 0 WHERE id = ?').run(tax);
  const r8 = applyTaskPositionChange(db as unknown as PositionDb, 't_a5b', tax);
  ok(r8.ok === false && r8.code === 'TASK_TERMINAL', 'A8 终态判定先于岗位判定（次序固定）', JSON.stringify(r8));
  insertTask(db, { id: 't_a8', projectId: 'proj_a' });
  const r8b = applyTaskPositionChange(db as unknown as PositionDb, 't_a8', tax);
  ok(r8b.ok === false && r8b.code === 'POSITION_NOT_IN_PROJECT', 'A8b 停用岗位 ⇒ 拒（resolveTaskPosition 同一把尺）', JSON.stringify(r8b));

  // A9 接线：IPC 真调 core 写口（不内联第二份判据）
  const ipc = codeOf(`${A}/src/main/ipc/project.ipc.ts`);
  ok(/applyTaskPositionChange\(db, id, positionId\)/.test(ipc), 'A9a task:update 调 core 写口（唯一判据）');
  ok(/positionId\?: string;/.test(ipc), 'A9b 入参声明了可选 positionId');
  ok(/position\.task_assign/.test(ipc) && /position\.task_unassign/.test(ipc), 'A9c 指派/解绑各落一条审计');
  ok(!/SELECT project_id, status, position_id FROM wa_tasks/.test(ipc), 'A9d 反证：IPC 里不再内联一份任务行查询判据');
}

/* ── B「问」缺岗位三态（M2）───────────────────────────────────────────── */

function sectionB(): void {
  console.log('\n【B】IM 缺岗位：不问 / 沿用 / 问一次');
  const db = freshDb();
  for (const n of ['财务', '税务', '复核']) seedPosition(db, '', n);
  const fin = posIdByName(db, '财务');
  const tax = posIdByName(db, '税务');
  const rev = posIdByName(db, '复核');
  ok(!!fin && !!tax && !!rev, 'B0 夹具：三个岗位已建');

  const base = { externalUser: 'u1', channelType: 'wechat', mentionedPosition: false, enabled: true, nowMs: 1_800_000_000_000 };

  // B1 项目 0 岗位 ⇒ 不问
  eq(positionPromptDecision(db as unknown as PositionDb, { ...base, projectId: 'proj_empty' }),
    { kind: 'none', reason: 'too_few' }, 'B1 项目没绑岗位 ⇒ 不问（不打扰不用岗位的人）');

  // B2 恰好 1 个 ⇒ 仍不问（"项目默认岗位"那条路已覆盖）
  bindPosition(db, 'proj_one', fin);
  eq(positionPromptDecision(db as unknown as PositionDb, { ...base, projectId: 'proj_one' }),
    { kind: 'none', reason: 'too_few' }, 'B2 恰好 1 个 ⇒ 不问（既有默认指派行为零变化）');

  // B3 3 个且无历史 ⇒ 问一次，带 3 个候选
  bindPosition(db, 'proj_many', fin);
  bindPosition(db, 'proj_many', tax);
  bindPosition(db, 'proj_many', rev);
  const ask = positionPromptDecision(db as unknown as PositionDb, { ...base, projectId: 'proj_many' });
  ok(ask.kind === 'ask', 'B3a ≥2 个岗位且无历史 ⇒ ask', ask.kind);
  if (ask.kind === 'ask') {
    eq(ask.options.length, 3, 'B3b 候选 3 个全列出');
    eq(ask.truncated, false, 'B3c 未超上限 ⇒ truncated=false');
    const text = positionPromptText(ask);
    ok(text.includes('0. 直接派'), 'B3d ★追问永远给出口（0. 直接派）', text.split('\n').pop() ?? '');
    ok(text.includes('财务') && text.includes('税务') && text.includes('复核'), 'B3e 候选逐个点名（编号可核对）');
  }

  // B4 有历史（该用户该渠道在该项目派过财务）⇒ 沿用
  insertTask(db, {
    id: 't_b4', projectId: 'proj_many', status: 'completed', positionId: fin,
    ctx: { source: 'im', externalUser: 'u1', channel: 'wechat' },
  });
  const reuse = positionPromptDecision(db as unknown as PositionDb, { ...base, projectId: 'proj_many' });
  ok(reuse.kind === 'reuse', 'B4a 有历史 ⇒ reuse（问一次之后记住）', reuse.kind);
  if (reuse.kind === 'reuse') {
    eq({ id: reuse.positionId, name: reuse.positionName }, { id: fin, name: '财务' }, 'B4b 沿用的正是上次那个岗位');
    ok(positionReuseNote(reuse).includes('财务'), 'B4c 回执明说"沿用上次岗位：财务"（不是猜的）');
  }

  // B5 已 @岗位 ⇒ 不问（不覆盖用户显式选择）
  eq(positionPromptDecision(db as unknown as PositionDb, { ...base, projectId: 'proj_many', mentionedPosition: true }),
    { kind: 'none', reason: 'mentioned' }, 'B5 已 @岗位 ⇒ 不问');

  // B6 开关关 ⇒ 三种情形一律不问
  eq(positionPromptDecision(db as unknown as PositionDb, { ...base, projectId: 'proj_many', enabled: false }),
    { kind: 'none', reason: 'disabled' }, 'B6 开关 position.ask_when_multiple 关 ⇒ 一律不问');

  // B7 空项目 id ⇒ 不问
  eq(positionPromptDecision(db as unknown as PositionDb, { ...base, projectId: '' }),
    { kind: 'none', reason: 'no_project' }, 'B7 没有项目 ⇒ 不在此处问（项目还没定）');

  // B8 历史岗位已停用 ⇒ 不沿用（退回 ask）
  db.prepare('UPDATE wa_positions SET enabled = 0 WHERE id = ?').run(fin);
  const afterDisable = positionPromptDecision(db as unknown as PositionDb, { ...base, projectId: 'proj_many' });
  eq(afterDisable.kind, 'ask', 'B8 上次的岗位已停用 ⇒ 不沿用，重新问');
  db.prepare('UPDATE wa_positions SET enabled = 1 WHERE id = ?').run(fin);

  // B9 历史来自**别的渠道** ⇒ 不算（沿用以"此渠道"为界）
  insertTask(db, {
    id: 't_b9', projectId: 'proj_other', status: 'completed', positionId: fin,
    ctx: { source: 'im', externalUser: 'u1', channel: 'feishu' },
  });
  bindPosition(db, 'proj_other', fin);
  bindPosition(db, 'proj_other', tax);
  eq(positionPromptDecision(db as unknown as PositionDb, { ...base, projectId: 'proj_other' }).kind, 'ask',
    'B9 别的渠道的历史不算数（沿用以同渠道为界）');

  // B10 候选超上限 ⇒ truncated=true 且只列前 N
  const db2 = freshDb();
  for (let i = 0; i < 12; i++) seedPosition(db2, '', `岗${i}`);
  const many = db2.prepare('SELECT id FROM wa_positions ORDER BY name').all() as Array<{ id: string }>;
  for (const p of many) bindPosition(db2, 'proj_x', p.id);
  const ask2 = positionPromptDecision(db2 as unknown as PositionDb, { ...base, projectId: 'proj_x' });
  ok(ask2.kind === 'ask' && ask2.truncated === true, 'B10 候选超过上限 ⇒ truncated=true（如实说"还有更多"）');
  if (ask2.kind === 'ask') eq(ask2.options.length, 8, 'B10b 只列前 8 个（菜单不刷屏）');

  // B11 接线：三处真接上（判据调用、追问支路、编号回执）
  const router = codeOf(`${A}/src/main/services/im-router.ts`);
  ok(/positionPromptDecision\(ctx\.db as never,/.test(router), 'B11a 建单路真调判据');
  ok(/pendingPositionSelections\.set\(/.test(router), 'B11b 追问后暂存待答');
  ok(/pendingPositionSelections\.get\(posKey\)/.test(router), 'B11c 编号回复真读待答（不是只写不读）');
  ok(/position\.ask_when_multiple/.test(router), 'B11d 开关真被读（不是只进白名单）');
}

/* ── C「账」没沉淀就说为什么（M3）────────────────────────────────────── */

const CONV_DDL = `
  CREATE TABLE IF NOT EXISTS wa_task_conversations (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, token_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

function convLines(db: DatabaseSync, taskId: string): string[] {
  return (db.prepare("SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'system'").all(taskId) as Array<{ content?: string }>)
    .map((r) => String(r.content ?? ''));
}

function lessonCount(db: DatabaseSync, taskId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM wa_position_lessons WHERE task_id = ?').get(taskId) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

function sectionC(): void {
  console.log('\n【C】没沉淀就说为什么');
  const db = freshDb();
  db.exec(CONV_DDL);
  seedPosition(db, '', '财务');
  const fin = posIdByName(db, '财务');
  bindPosition(db, 'proj_c', fin);

  // C1 带岗位、已完成、无验收 ⇒ 不沉淀，且**说得出原因**
  insertTask(db, { id: 't_c1', projectId: 'proj_c', status: 'completed', positionId: fin });
  const d1 = generatePositionLessonCandidateDetailed(db as unknown as PositionDb, 't_c1');
  eq({ written: d1.written, reason: d1.reason }, { written: false, reason: 'acceptance_not_passed' }, 'C1a 无验收 ⇒ written=false 且 reason=acceptance_not_passed');
  ok(explainNoLesson('acceptance_not_passed').includes('验收没有通过'), 'C1b 拒因译成人话（不是把机器词丢给用户）');
  markCompletedRun(db as never, 't_c1', 'run-1');
  const c1 = convLines(db, 't_c1');
  eq(c1.filter((l) => l.startsWith('[岗位经验]')).length, 1, 'C1c ★★带岗位的任务收口后留下恰一行「为什么没沉淀」');
  ok(c1.some((l) => l.includes('验收没有通过')), 'C1d 那一行是人话（含原因）');

  // C2 不带岗位 ⇒ 一个字都不刷（反证：不制造噪音）
  insertTask(db, { id: 't_c2', projectId: 'proj_c', status: 'completed' });
  markCompletedRun(db as never, 't_c2', 'run-1');
  eq(convLines(db, 't_c2').filter((l) => l.startsWith('[岗位经验]')), [], 'C2 ★反证：没指派岗位的任务不出现该行');

  // C3 正常路径 ⇒ 候选 0→1，且**不**出现"没沉淀"行
  insertTask(db, {
    id: 't_c3', projectId: 'proj_c', status: 'completed', positionId: fin,
    ctx: { acceptance_check: { checked_at: '2026-11-15 08:00:00', verified: true, criteria_total: 2, passed_total: 2 }, completion_summary: '把报销单核完并生成凭证草稿' },
  });
  eq(lessonCount(db, 't_c3'), 0, 'C3a 收口前候选 0 条');
  markCompletedRun(db as never, 't_c3', 'run-1');
  eq(lessonCount(db, 't_c3'), 1, 'C3b ★真写口：候选 0→1');
  eq(convLines(db, 't_c3').filter((l) => l.startsWith('[岗位经验]')), [], 'C3c 沉淀成功时不写"没沉淀"行（名实相符）');

  // C4 同一任务再次收口（两个出口各调一次）⇒ 不重复刷行
  markCompletedRun(db as never, 't_c1', 'run-2');
  eq(convLines(db, 't_c1').filter((l) => l.startsWith('[岗位经验]')).length, 1, 'C4 重复收口不重复刷行（按任务去重）');

  // C5 已沉淀过的任务再收口 ⇒ 不说"没沉淀"（"早就有了"不是"这单没沉淀"）
  markCompletedRun(db as never, 't_c3', 'run-2');
  eq(convLines(db, 't_c3').filter((l) => l.startsWith('[岗位经验]')), [], 'C5 已沉淀 ⇒ 不把"早就有"说成"没沉淀"');

  // C6 验收未通过 ⇒ 原因分家（不是与"没验收"混成一句）
  insertTask(db, {
    id: 't_c6', projectId: 'proj_c', status: 'completed', positionId: fin,
    ctx: { acceptance_check: { checked_at: '2026-11-15 08:00:00', verified: true, criteria_total: 3, passed_total: 1 } },
  });
  const d6 = generatePositionLessonCandidateDetailed(db as unknown as PositionDb, 't_c6');
  eq(d6.reason, 'acceptance_not_passed', 'C6 验收未通过同样归 acceptance_not_passed（同一道门）');

  // C7 接线：postlude 真调详细版 + 只对带岗位的任务说
  const postlude = codeOf(`${A}/src/main/core/postlude.ts`);
  ok(/generatePositionLessonCandidateDetailed\(/.test(postlude), 'C7a postlude 调详细版（带得回原因）');
  ok(/hasPosition/.test(postlude), 'C7b 只在带岗位时留痕（不刷噪音）');
  ok(/content LIKE '\[岗位经验\]%'/.test(postlude), 'C7c 按任务去重（重复收口不刷两行）');
}

/* ── D「法」`项目#名称` 语法（M4）────────────────────────────────────── */

function sectionD(): void {
  console.log('\n【D】听得懂 项目#名称');
  // D1 基本形（需求 §4.1 原文）
  eq(parseImTargets('@财务 项目#怡寿里 审核报销'),
    { mentions: ['财务'], hashProjects: ['怡寿里'], quoted: [] },
    'D1 `@岗位 + 项目#项目名` 各自归位');
  // D2 全角 ＃
  eq(parseImTargets('项目＃怡寿里 审核报销').hashProjects, ['怡寿里'], 'D2 全角 ＃ 同样认');
  // D3 标题不再留 `项目#xxx`
  eq(splitTaskInput('项目#怡寿里 审核本周报销单').title, '审核本周报销单', 'D3 标题剥离落点标记（不留 项目#）');
  // D4 老语法逐字节零回归
  eq(splitTaskInput('@怡寿里 审核本周报销单'), { title: '审核本周报销单', description: '' },
    'D4 老 `@项目` 语法切分逐字节不变（零回归）');
  eq(parseImTargets('@怡寿里 审核报销'), { mentions: ['怡寿里'], hashProjects: [], quoted: [] },
    'D4b 老语法不进 hashProjects（两路不混）');
  // D5 `项目#` 只可能是项目，不会被当成岗位
  eq(parseImTargets('项目#财务 开票').mentions, [], 'D5 ★`项目#财务` 不进 @ 候选（不会被认成岗位）');
  // D6 不带 `项目` 前缀的 `#话题` 不当项目（不改变既有语义）
  eq(parseImTargets('整理 #标签 清单').hashProjects, [], 'D6 ★`#话题` 不被当项目（只有 项目# 才是项目）');
  // D7 引出引号任务名的老能力不变
  eq(parseImTargets('创建任务「周报」').quoted, ['周报'], 'D7 引号任务名解析零回归');

  // D8 接线：先解析 hash、且 hash 缺失时不静默新建
  const router = codeOf(`${A}/src/main/services/im-router.ts`);
  ok(/for \(const hp of hashProjects\)/.test(router), 'D8a 建单路先解析 hashProjects');
  ok(/!hashProjects\.includes\(missName\)/.test(router), 'D8b ★hash 项目缺失时不走"强建单⇒新建项目"（不静默新建）');
  ok(/parseImTargets\(msgText\)/.test(router), 'D8c 解析只此一份实现（core），路由只转调');
  const input = codeOf(`${A}/src/main/core/im/task-input.ts`);
  ok(/HASH_PROJECT_RE/.test(input), 'D8d 标题切分同样剥 hash（同一份正则）');
}

/* ── E「话」回执说人话（M5）───────────────────────────────────────────── */

/** 用户可见的回执构建点（扫描面就是这三处；SQL/审计不在其中）。 */
const ECHO_SURFACES = [
  `${A}/src/main/core/im-echo.ts`,
  `${A}/src/main/services/im-commands.ts`,
  `${A}/src/main/core/task-notice.ts`,
];
/** 内部术语（出现在用户可见文案里即为假话——它们是给开发者看的账）。 */
const JARGON = ['强建单', '规则未命中', '模型判为', 'route_reason', '终态', 'UTC'];

function sectionE(): void {
  console.log('\n【E】回执说人话');
  const createD = { intent: 'create_task', route: 'create', confidence: 'high', reason: '含建单动词——按建单处理（强建单词）' };
  const startD = { intent: 'start_task', route: 'start', confidence: 'high', reason: '规则未命中，模型判为启动' };

  const e1 = intentEcho(createD, '帮我把报销单核一下');
  ok(!!e1 && e1.includes('我理解成：建任务'), 'E1a 建单回执仍是「我理解成：建任务」');
  ok(!!e1 && e1.includes('帮我把报销单核一下'), 'E1b ★回显用户原话');
  ok(!!e1 && !e1.includes('强建单') && !e1.includes(createD.reason), 'E1c ★反证：内部术语不上屏');
  ok(!!e1 && e1.includes('撤销') && e1.includes('10 分钟'), 'E1d 撤销承诺与窗口仍在');

  const e2 = intentEcho(startD, '启动周报');
  ok(!!e2 && e2.includes('启动任务') && e2.includes('启动周报'), 'E2 启动回执带原话');
  ok(!!e2 && !e2.includes('模型判为'), 'E2b 启动不带"模型判为"');

  eq(intentEcho({ ...createD, route: 'query' } as never, '查一下进度'), null, 'E3 查询/闲聊不加这一行（零回归）');
  eq(intentEcho(null, 'x'), null, 'E3b 无判定 ⇒ 不编一句');

  // E4 摘录封顶（长句不把回执撑成一屏）
  const longRaw = '甲'.repeat(120);
  const e4 = intentEcho(createD, longRaw) ?? '';
  ok(e4.includes('甲'.repeat(ECHO_EXCERPT_MAX)) && !e4.includes('甲'.repeat(ECHO_EXCERPT_MAX + 1)), 'E4 摘录封顶 40 字');

  // E5 扫描面：剥离注释后，三处回执模块**零内部术语**（承 `feedback_static_sweep_comment_strip`）
  const hits: string[] = [];
  for (const rel of ECHO_SURFACES) {
    const code = stripKeepingLines(readSrc(rel)).join('\n');
    for (const w of JARGON) if (code.includes(w)) hits.push(`${rel}:${w}`);
  }
  eq(hits, [], 'E5 ★三处用户可见回执模块（剥注释后）零内部术语');

  // E6 不再用 `${d.reason}` 拼用户话
  const echoCode = stripKeepingLines(readSrc(ECHO_SURFACES[0]!)).join('\n');
  ok(!/\$\{[^}]*\breason\b[^}]*\}/.test(echoCode), 'E6 反证：回执不再插值 reason');

  // E7 接线：两处建单调用都传原话（否则摘录恒空——"传了参数没用上"正是本仓常见病）
  const router = codeOf(`${A}/src/main/services/im-router.ts`);
  eq((router.match(/intentEcho\(decision, routeText\)/g) ?? []).length, 2,
    'E7 两处建单调用都传 routeText（摘录非空）');
}

/* ── G「启」首启三步真走通（M6）───────────────────────────────────────── */

function sectionG(): void {
  console.log('\n【G】首启三步真走通');
  const setup = codeOf(`${A}/renderer/src/pages/SetupPage.tsx`);
  // G1 三步（不是四步）
  const m = setup.match(/const STEPS = \[([^\]]*)\] as const;/);
  const steps = (m?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  eq(steps.length, 3, 'G1 STEPS 恰三步（用户点名"三步引导"）');
  ok(steps[0]!.includes('接通 AI 资源'), 'G1b 第一步把"连接"与"自检"合成一件事', steps[0]);
  ok(!setup.includes('四步'), 'G1c 源码里不再出现"四步"字样（名实相符）');
  // G2 自检结果同屏：saveAndProbe 不再跳步
  ok(!/setStep\(1\);\s*\n\s*await runProbe\(\)/.test(setup), 'G2 "保存并自检"不再跳步（结果同屏）');
  // G3 步进索引自洽：三块 step 0/1/2
  for (const i of [0, 1, 2]) ok(new RegExp(`\\{step === ${i} && \\(`).test(setup), `G3 存在 step === ${i} 的正文块`);
  ok(!/\{step === 3 && \(/.test(setup), 'G3b 不再有第四块');

  // G4 偏好向导的"跳过"与首启向导同一处置（否则被弹回，名不副实）
  const wizard = codeOf(`${A}/renderer/src/pages/PreferencesWizardPage.tsx`);
  ok(/skipOnboarding\(\);\s*navigate\('\/'\)/.test(wizard), 'G4 ★偏好向导"跳过"先置会话豁免再跳（不再被弹回）');
  ok(/import \{ skipOnboarding \}/.test(wizard), 'G4b 豁免走同一份实现（不新造状态）');

  // G5 导览可重看（此前只有一次性标记、无入口）
  const settings = codeOf(`${A}/renderer/src/pages/SettingsPage.tsx`);
  ok(/settings:set', 'onboarding\.tour_done', '0'/.test(settings), 'G5 ★设置页真清一次性标记');
  ok(/const resetTour = async/.test(settings) && /重置并回到首页/.test(settings), 'G5b 有按钮、有实现（不是只写库的暗开关）');

  // G6 上屏到产物（renderer 须先 build）
  const assets = path.join(root, A, 'renderer/dist/assets');
  let chunk = '';
  try {
    const f = fs.readdirSync(assets).find((n) => /^SetupPage-.*\.js$/.test(n));
    if (f) chunk = fs.readFileSync(path.join(assets, f), 'utf-8');
  } catch { /* 产物缺失由断言如实红 */ }
  ok(chunk.includes('三步跑出你的第一个成果'), 'G6 ★上屏到产物：三步文案真进了 SetupPage chunk');
  ok(!chunk.includes('四步跑出你的第一个成果'), 'G6b 反证：旧"四步"文案已不在产物里');
}

/* ── F「墙」岗位知识团队共享（M7）─────────────────────────────────────── */

function sectionF(): void {
  console.log('\n【F】岗位知识团队共享');
  const db = freshDb();
  // 岗位四段里先有内容，才能验证"只补不覆盖"
  createPosition(db as unknown as PositionDb, {
    name: '财务', category: 'business', description: '资金与账务',
    rules: ['每个数都有来源与口径'], skills: ['账务核算'], knowledge: [],
  });
  const fin = posIdByName(db, '财务');
  // 三条经验：已采纳 / 待审 / 已拒 —— 分享体只该带第一条
  insertPositionLessonCandidate(db as unknown as PositionDb, { positionId: fin, taskId: 't_acc', projectId: 'p1', content: '先核对再解释', source: 'retrospective', reusable: true });
  insertPositionLessonCandidate(db as unknown as PositionDb, { positionId: fin, taskId: 't_pend', projectId: 'p1', content: '待审的经验', source: 'summary' });
  insertPositionLessonCandidate(db as unknown as PositionDb, { positionId: fin, taskId: 't_rej', projectId: 'p1', content: '被拒的经验', source: 'summary' });
  db.prepare("UPDATE wa_position_lessons SET status = 'accepted', reusable = 1 WHERE task_id = 't_acc'").run();
  db.prepare("UPDATE wa_position_lessons SET status = 'rejected' WHERE task_id = 't_rej'").run();

  const payload = shareItem(db as unknown as TeamLibraryDb, 'position', fin);
  eq(payload.kind, 'position', 'F1a 分享类型为 position');
  const sharedLessons = (payload.body.lessons as Array<{ content?: string }>).map((l) => String(l.content ?? ''));
  eq(sharedLessons, ['先核对再解释'], 'F1b ★只带已采纳经验（待审/已拒不出本机）');
  ok(String((payload.body.position as { name?: string }).name) === '财务', 'F1c 体里带岗位四段');
  ok(!JSON.stringify(payload.body).includes('proj'), 'F1d 反证：不带本机项目 id（跨机无意义）');

  // F2 导入到另一台"机器"（同构空库）⇒ 建岗位 + 四段 + 经验落**待审**
  const db2 = freshDb();
  const item = { id: 'team_1', kind: 'position' as const, title: payload.title, body: payload.body, source_node_id: 'node_a', created_at: '', updated_at: '' };
  const imported = importItem(db2 as unknown as TeamLibraryDb, item as never);
  ok(imported.target === 'wa_positions' && !!imported.id, 'F2a 导入落到 wa_positions', JSON.stringify(imported));
  const p2 = posIdByName(db2, '财务');
  ok(!!p2, 'F2b 对端真建出「财务」岗位');
  const lessons2 = db2.prepare('SELECT content, status, origin FROM wa_position_lessons WHERE position_id = ?').all(p2) as Array<{ content?: string; status?: string; origin?: string }>;
  eq(lessons2.length, 1, 'F2c 经验 0→1 条');
  eq({ status: lessons2[0]?.status, origin: lessons2[0]?.origin }, { status: 'pending', origin: 'imported' }, 'F2d ★★导入经验一律待审 + origin=imported（永不自动采纳）');

  // F3 再导入一次（同包）⇒ 四段只补不覆盖、经验不重复
  const db3 = freshDb();
  createPosition(db3 as unknown as PositionDb, { name: '财务', category: 'custom', description: '', rules: ['本机已有的规范'], skills: [], knowledge: [] });
  const p3 = posIdByName(db3, '财务');
  importItem(db3 as unknown as TeamLibraryDb, item as never);
  const rules3 = JSON.parse((db3.prepare('SELECT rules_json FROM wa_positions WHERE id = ?').get(p3) as { rules_json: string }).rules_json) as string[];
  ok(rules3.includes('本机已有的规范'), 'F3a ★不覆盖本机已有条目');
  ok(rules3.includes('每个数都有来源与口径'), 'F3b 缺失条目补进来（merge 语义）');
  importItem(db3 as unknown as TeamLibraryDb, item as never);
  const n3 = (db3.prepare('SELECT COUNT(*) AS n FROM wa_position_lessons WHERE position_id = ?').get(p3) as { n?: number }).n;
  eq(Number(n3), 1, 'F3c 重复导入不重复落经验（内容去重）');

  // F4 坏包如实拒（不把损坏转嫁给下一个节点）
  let threw = '';
  try { importItem(freshDb() as unknown as TeamLibraryDb, { ...item, body: { kind: 'worker-ant-position', version: 1 } } as never); }
  catch (e) { threw = (e as Error).message; }
  ok(threw.includes('岗位知识包'), 'F4 坏包 ⇒ 明确拒因（不是静默落一个空岗位）', threw);

  // F5 词表与列：kind 由 shared-types 派生（ANS 校验与界面列同源，不手抄第二份）
  const kinds = TEAM_ITEM_KINDS as readonly string[];
  ok(kinds.includes('position'), 'F5a 共享类型词表含 position');
  const page = codeOf(`${A}/renderer/src/pages/TeamLibraryPage.tsx`);
  ok(/payload\.local\.positions/.test(page), 'F5b 界面列能取到岗位候选（不是只加类型不给入口）');
}

/* ── main ─────────────────────────────────────────────────────────────── */

function main(): void {
  sectionS();
  sectionA();
  sectionB();
  sectionC();
  sectionD();
  sectionE();
  sectionG();
  sectionF();
  console.log(`\n══════ 结果：${pass} 通过 / ${fail} 失败 ══════`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
