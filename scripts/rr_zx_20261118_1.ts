/**
 * zx_20261118_1 「回」受控复跑。
 *
 * 分组（与方案 §3 批次一一对应）：
 *   F「回」任务完成态可回看文件变更——从 wa_event_log 回放 file.* 事件（M1/M2）
 *
 * 纪律（承 CLAUDE.md 与 auto-memory）：
 *   · 直引生产函数 / 真实现（被删/改名即编译期失败）。
 *   · 两侧标本同试；计数器类断言给 0→N 的正面值。
 *   · 断言文案不含失败字形；表结构走生产 `initDatabase`。
 *   · 夹具按生产初始化顺序：先 initDatabase，再插数据行。
 *   · 不以轮次字面量做等值断言；build 钉由 `checkBuildPins` 派生核对。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { checkBuildPins, buildNotOlderThan, stripKeepingLines } from './lib/rr-pins.js';
import { initDatabase } from '../apps/worker-ant-desktop/src/main/database.js';
import {
  collectFileChangeEvents,
  FILE_CHANGE_REPLAY_LIMIT,
  FILE_CHANGE_EVENT_TYPES,
} from '../apps/worker-ant-desktop/src/main/core/file-change-log.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ok ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261118-1-'));
let dbSeq = 0;
function mkdb(): Database.Database {
  const db = initDatabase(path.join(tmpRoot, `db-${++dbSeq}`));
  db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p','P',?)").run(tmpRoot);
  return db;
}

/** 直接插事件行（wa_event_log 无外键，但仍在 initDatabase 建表之后插）。 */
function ins(
  db: Database.Database,
  taskId: string,
  type: string,
  payload: unknown,
  at: string,
): void {
  db.prepare(
    `INSERT INTO wa_event_log (event_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, metadata, occurred_at)
     VALUES (?, ?, 'task', ?, 1, ?, '{}', ?)`,
  ).run(crypto.randomUUID(), type, taskId, typeof payload === 'string' ? payload : JSON.stringify(payload), at);
}

function hunk(sample: string): Record<string, unknown> {
  return {
    oldStart: 10, oldLines: 1, newStart: 10, newLines: 1,
    lines: [{ type: 'add', content: sample }, { type: 'del', content: 'old' }],
  };
}

const SELF = path.basename(__filename).replace(/\.ts$/, '');

// ── F 组「回」 ───────────────────────────────────────────────────────────────

// F1 取数：只取本任务的文件事件，按落库先后升序；步骤/别的任务不串入
{
  const db = mkdb();
  ins(db, 't-a', 'file.created', { seq: 1, filePath: '/w/a.md', action: 'created', content: 'A' }, '2026-11-18T01:00:01Z');
  ins(db, 't-a', 'task.step_finished', { step: 1, text: 'step' }, '2026-11-18T01:00:02Z');
  ins(db, 't-a', 'file.updated', { seq: 2, filePath: '/w/a.md', action: 'updated', hunks: [hunk('new')], additions: 1, deletions: 1, truncated: false }, '2026-11-18T01:00:03Z');
  ins(db, 't-a', 'file.edited', { seq: 3, filePath: '/w/b.py', action: 'edited', hunks: [hunk('x')], additions: 1, deletions: 1, truncated: false }, '2026-11-18T01:00:04Z');
  ins(db, 't-b', 'file.created', { seq: 9, filePath: '/w/other.md', action: 'created' }, '2026-11-18T01:00:05Z');

  const r = collectFileChangeEvents(db, 't-a');
  ok(r.items.length === 3 && r.total === 3, 'F1 只取本任务的三类文件事件（0→3）', `items=${r.items.length} total=${r.total}`);
  eq(r.items.map((i) => i.type), ['file.created', 'file.updated', 'file.edited'], 'F1 三种事件类型逐条保留');
  eq(r.items.map((i) => i.seq), [1, 2, 3], 'F1 按落库先后升序');
  ok(r.items.every((i) => i.filePath !== '/w/other.md'), 'F1 别的任务的事件不串入');
  ok(r.items.every((i) => typeof i.occurred_at === 'string' && i.occurred_at.length > 0), 'F1 每条带落库时刻');
  db.close();
}

// F2 保真：改动明细（hunks/additions/deletions/truncated）原样回放，不是只剩路径
{
  const db = mkdb();
  const payload = {
    seq: 1, filePath: '/w/daily.py', action: 'edited', size: 48108,
    hunks: [hunk('+52 行之一'), hunk('+52 行之二')], additions: 52, deletions: 52, truncated: true,
  };
  ins(db, 't-h', 'file.edited', payload, '2026-11-18T02:00:00Z');
  const r = collectFileChangeEvents(db, 't-h');
  const it = r.items[0] ?? {};
  eq(it.hunks, payload.hunks, 'F2 hunks 逐行原样保留');
  ok(it.additions === 52 && it.deletions === 52 && it.truncated === true, 'F2 增删行数与截断标记保真');
  ok(it.size === 48108 && it.action === 'edited', 'F2 其余载荷字段不缺');
  db.close();
}

// F3 有界：超过上限只回最近 N 条，total 仍如实计全量（丢的是最旧的那几条）
{
  const db = mkdb();
  const total = FILE_CHANGE_REPLAY_LIMIT + 5;
  for (let i = 0; i < total; i++) {
    ins(db, 't-limit', 'file.created', { seq: i, filePath: `/w/f${i}.txt`, action: 'created' }, `2026-11-18T03:00:${String(i % 60).padStart(2, '0')}Z`);
  }
  const r = collectFileChangeEvents(db, 't-limit');
  ok(r.items.length === FILE_CHANGE_REPLAY_LIMIT, `F3 显示条数封顶 ${FILE_CHANGE_REPLAY_LIMIT}`, `items=${r.items.length}`);
  ok(r.total === total, 'F3 总数如实计全量', `total=${r.total}`);
  ok(r.items[0]?.seq === 5, 'F3 丢弃的是最旧的 5 条（首条从 seq=5 起）', `first=${r.items[0]?.seq}`);
  ok(r.items[r.items.length - 1]?.seq === total - 1, 'F3 尾部保留最新一条', `last=${r.items[r.items.length - 1]?.seq}`);
  db.close();
}

// F4 空：只有步骤事件的任务不得编造文件变更
{
  const db = mkdb();
  ins(db, 't-empty', 'task.step_finished', { step: 1 }, '2026-11-18T04:00:00Z');
  const r = collectFileChangeEvents(db, 't-empty');
  ok(r.items.length === 0 && r.total === 0, 'F4 无文件事件时如实为空', `items=${r.items.length} total=${r.total}`);
  db.close();
}

// F5 脏行：非 JSON 与"合法 JSON 但缺 filePath"都不进清单；不抛，其余行照常返回
{
  const db = mkdb();
  ins(db, 't-dirty', 'file.created', { seq: 1, filePath: '/w/ok.md', action: 'created' }, '2026-11-18T05:00:00Z');
  ins(db, 't-dirty', 'file.updated', 'not-json', '2026-11-18T05:00:01Z');
  ins(db, 't-dirty', 'file.edited', { seq: 2, action: 'edited' }, '2026-11-18T05:00:02Z');
  ins(db, 't-dirty', 'file.created', { seq: 3, filePath: '', action: 'created' }, '2026-11-18T05:00:03Z');
  let threw: unknown = null;
  let r: ReturnType<typeof collectFileChangeEvents> | null = null;
  try { r = collectFileChangeEvents(db, 't-dirty'); } catch (e) { threw = e; }
  ok(threw === null, 'F5 脏载荷不抛错', threw ? String(threw) : '');
  ok(r !== null && r.items.length === 1 && r.items[0]?.filePath === '/w/ok.md', 'F5 非 JSON 与缺 filePath 均跳过、好行保留', `items=${r?.items.length}`);
  db.close();
}

// F6 接线（main）：events:taskReplay 真的取数并回包 files/fileTotal
{
  const code = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/ipc/admin.ipc.ts'), 'utf-8')).join('\n');
  ok(code.includes('collectFileChangeEvents(db, taskId)'), 'F6 events:taskReplay 调用生产取数函数');
  ok(/files:\s*fc\.items/.test(code), 'F6 回包含 files: fc.items');
  ok(/fileTotal:\s*fc\.total/.test(code), 'F6 回包含 fileTotal: fc.total');
}

// F7 接线（renderer）：回放填进 fileStream，标题按运行态切换
{
  const code = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/pages/TaskDetailPage.tsx'), 'utf-8')).join('\n');
  ok(code.includes('Array.isArray(r.files)'), 'F7 回放分支读取 r.files');
  ok(/setFileStream\(prev\s*=>\s*files\.length\s*>=\s*prev\.length\s*\?\s*files\.map/.test(code), 'F7 终态以日志回放窗口为准（实时仅兜底）');
  ok(code.includes("executingNow ? '实时文件变更' : '文件变更'"), 'F7 标题按运行态切换（终态不说实时）');
}

// F9 实时+回放：文件回放不得被"步骤已实时捕获"的早退门挡掉（审查 Important #1）
{
  const code = stripKeepingLines(fs.readFileSync(path.join(root, A, 'renderer/src/pages/TaskDetailPage.tsx'), 'utf-8')).join('\n');
  ok(!code.includes('if (stepStream.length > 0) return;'), 'F9 文件回放不再被 stepStream 早退门挡掉');
  ok(code.includes('const needSteps = stepStream.length === 0;'), 'F9 步骤回放按 needSteps 决定是否重复');
  ok(code.includes('if (needSteps) {'), 'F9 步骤/信号填充收进 needSteps 分支');
  ok(/setFileTotal\(typeof r\.fileTotal === 'number' \? Math\.max\(r\.fileTotal, files\.length\)/.test(code), 'F9 实时+回放混合路径也如实报总数');
}

// F8 build 钉（派生核对，无轮次字面量）
{
  checkBuildPins(ok);
  const src = fs.readFileSync(path.join(root, A, 'src/main/core/agent-executor.ts'), 'utf-8');
  const m = /build:\s*'(zx_\d{8}(?:_\d+)?)'/.exec(src);
  const tag = m?.[1] ?? '';
  ok(buildNotOlderThan(tag, SELF.replace(/^rr_/, '')), 'F8 build 不早于本套件轮次', `${tag} vs ${SELF}`);
  ok(typeof FILE_CHANGE_EVENT_TYPES !== 'undefined' && FILE_CHANGE_EVENT_TYPES.length === 3, 'F8 事件类型表恰三类');
}

// F10 一源：事件类型只在常量处手写一次，SQL 列表由它派生（审查 Minor #2）
{
  const src = stripKeepingLines(fs.readFileSync(path.join(root, A, 'src/main/core/file-change-log.ts'), 'utf-8')).join('\n');
  ok(/const EVENT_LIST_SQL = `\(\$\{FILE_CHANGE_EVENT_TYPES\.map/.test(src), 'F10 SQL 列表由事件类型常量派生');
  ok(!src.includes("('file.created','file.updated','file.edited')"), 'F10 无第二份手写类型清单');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
