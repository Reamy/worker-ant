/**
 * zx_20260910_3 批6 受控复跑（M4：`project-engine.ts` 孤儿修复收口；**真实现** `ProjectEngine.getById` + node:sqlite 真 SQL；绝不触碰开发库）。
 *
 * 病灶（E14）：`_enrichProject` 的活跃度取数语句有两处错，且改好却一直漂在工作区、从未提交：
 *   ① `SELECT created_at FROM wa_task_conversations c JOIN wa_tasks t ...`——对话与任务表同名列 ⇒ SQLite 抛
 *      `ambiguous column name: created_at` 被 catch 吞掉 ⇒ `activityMs` 回退项目行 `updated_at`（任务执行不 bump）
 *      ⇒ 长期活跃的项目被判 dormant/stale（**实际可观测症状**）。
 *   ② `Math.round(m * 86400000)`——julianday 转 Unix 毫秒未减 2440587.5 天文偏移 ⇒ 时间落在公元 8700+ 年、
 *      `age` 恒 0 ⇒ 全部误判活跃。**被 ① 遮蔽**（修复前该语句从未跑通），修 ① 漏 ② 即复发。
 *
 * S1 纯函数式 julianday 偏移换算（防"日期纪元算错"复发的结构性断言）
 * S2 真 SQL·消歧：naive 写法确抛 ambiguous，`c.created_at` 写法通（内存库）
 * S3 端到端·真 `ProjectEngine.getById`：活跃项目（项目行陈旧 + 会话新）修复后 healthy / 纯陈旧 dormant /
 *    2 天前 stale / 有运行任务恒 healthy + `lastActive` 如实
 * S4 静态接线：源含偏移与消歧、归属已订正为本轮 M4、无 `zx_20260909 修复` 错标
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ProjectEngine } from '../apps/worker-ant-desktop/src/main/core/project-engine.js';
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (p?: string) => any };

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const PE = 'apps/worker-ant-desktop/src/main/core/project-engine.ts';
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const DAY = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────
console.log('S1 纯函数·julianday → Unix 毫秒（2440587.5 天文偏移）');
const toMs = (julian: number) => Math.round((julian - 2440587.5) * 86400000);
const toMsUnfixed = (julian: number) => Math.round(julian * 86400000);
ok(toMs(2440587.5) === 0, 'julianday 2440587.5（1970-01-01）→ 0 ms', String(toMs(2440587.5)));
ok(toMsUnfixed(2440587.5) === Math.round(2440587.5 * 86400000) && toMsUnfixed(2440587.5) > 2e14,
  '旧公式把同一时刻算成 ~2.1e14 ms（公元 8700+ 年）——正是"age 恒 0"之源', String(toMsUnfixed(2440587.5)));
{
  // J2000.0 = 2451545.0（2000-01-01 12:00 UTC）——独立权威常数，非回环自证
  ok(toMs(2451545.0) === Date.UTC(2000, 0, 1, 12, 0, 0),
    '修复公式对 J2000.0 精确还原 946728000000 ms', String(toMs(2451545.0)));
  const jdNow = Date.now() / 86400000 + 2440587.5;
  const broken = new Date(toMsUnfixed(jdNow));
  ok(broken.getUTCFullYear() > 8000, '旧公式对"当下"落公元 8000+ 年 ⇒ age=Math.max(0,now-未来)=0 ⇒ 恒判活跃', String(broken.getUTCFullYear()));
}

// ─────────────────────────────────────────────────────────────
console.log('S2 真 SQL·消歧（ambiguous column 实证）');
function mkdb(): any {
  const db = new DatabaseSync(':memory:') as any;
  db.exec(`CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT, context_json TEXT);
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, updated_at TEXT, created_at TEXT, status TEXT);
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, created_at TEXT, token_count INTEGER DEFAULT 0);
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, status TEXT, type TEXT, file_path TEXT, name TEXT, created_at TEXT);`);
  return db;
}
const NAIVE_SQL = `
  SELECT MAX(julianday(u)) AS m FROM (
    SELECT updated_at AS u FROM wa_tasks WHERE project_id = ?
    UNION ALL SELECT created_at FROM wa_task_conversations c JOIN wa_tasks t ON c.task_id = t.id AND t.project_id = ?
    UNION ALL SELECT created_at FROM wa_deliverables WHERE project_id = ?
    UNION ALL SELECT updated_at FROM wa_projects WHERE id = ?
  )`;
const FIXED_SQL = NAIVE_SQL.replace('SELECT created_at FROM wa_task_conversations', 'SELECT c.created_at FROM wa_task_conversations');
{
  const db = mkdb();
  let threw = ''; try { db.prepare(NAIVE_SQL).all('x', 'x', 'x', 'x'); } catch (e: any) { threw = String(e?.message || e); }
  ok(/ambiguous column name: created_at/.test(threw), '★naive `created_at` 写法确抛 ambiguous column（异常被 catch 吞 ⇒ 回退项目行）', threw || '(未抛)');
  let okFixed = true; try { db.prepare(FIXED_SQL).all('x', 'x', 'x', 'x'); } catch { okFixed = false; }
  ok(okFixed, '★`c.created_at` 消歧后语句可通（修复即在此）');
}

// ─────────────────────────────────────────────────────────────
console.log('S3 端到端·真 ProjectEngine.getById（活跃度分类如实）');
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
function seed(): any {
  const db = mkdb();
  const mk = (id: string, projUpdatedMsAgo: number) =>
    db.prepare('INSERT INTO wa_projects (id,name,updated_at,context_json) VALUES (?,?,?,?)').run(id, id, iso(projUpdatedMsAgo), '{}');
  // p_active: 项目行陈旧(30d) + 会话新(1h) → 修复后 healthy（修复前因回退项目行 ⇒ dormant）
  mk('p_active', 30 * DAY);
  db.prepare("INSERT INTO wa_tasks (id,project_id,updated_at,status) VALUES ('t_a','p_active',?, 'completed')").run(iso(30 * DAY));
  db.prepare("INSERT INTO wa_task_conversations (id,task_id,created_at) VALUES ('c_a','t_a',?)").run(iso(60 * 60 * 1000));
  // p_dormant: 全部陈旧(30d)
  mk('p_dormant', 30 * DAY);
  db.prepare("INSERT INTO wa_tasks (id,project_id,updated_at,status) VALUES ('t_d','p_dormant',?, 'completed')").run(iso(30 * DAY));
  // p_stale: 2 天前
  mk('p_stale', 2 * DAY);
  db.prepare("INSERT INTO wa_tasks (id,project_id,updated_at,status) VALUES ('t_s','p_stale',?, 'completed')").run(iso(2 * DAY));
  // p_running: 陈旧 + 运行中任务 → 恒 healthy
  mk('p_running', 30 * DAY);
  db.prepare("INSERT INTO wa_tasks (id,project_id,updated_at,status) VALUES ('t_r','p_running',?, 'executing')").run(iso(30 * DAY));
  return db;
}
{
  const engine = new ProjectEngine(seed() as any);
  const a = engine.getById('p_active') as any;
  ok(a?.staleness === 'healthy', '★活跃项目（项目行陈旧但会话 1h 前）→ healthy（修复前回退项目行 ⇒ dormant）', String(a?.staleness));
  const ageA = Date.now() - new Date(a.lastActive).getTime();
  ok(Math.abs(ageA - 60 * 60 * 1000) < 5000, '★lastActive 如实取到"会话 1h 前"（非项目行 30d 前）', `${(ageA / 60000).toFixed(1)} 分钟前`);

  const d = engine.getById('p_dormant') as any;
  ok(d?.staleness === 'dormant', '纯陈旧 30d 无新活动 → dormant', String(d?.staleness));
  const s = engine.getById('p_stale') as any;
  ok(s?.staleness === 'stale', '2 天前活动 → stale（1d < age ≤ 7d）', String(s?.staleness));
  const r = engine.getById('p_running') as any;
  ok(r?.staleness === 'healthy', '有执行中任务 → healthy（runningNow 优先，与活动时间无关）', String(r?.staleness));
}

// ─────────────────────────────────────────────────────────────
console.log('S4 静态接线（归属订正 + 两处修复同源）');
{
  const code = stripComments(rd(PE));
  const raw = rd(PE);
  ok(/m - 2440587\.5\) \* 86400000/.test(code), '源码含 `(m - 2440587.5) * 86400000` 偏移换算');
  ok(!/Math\.round\(\s*mRow\.m \* 86400000\s*\)/.test(code), '源码无 `m * 86400000` 旧写法残留');
  ok(/SELECT c\.created_at FROM wa_task_conversations/.test(code), '源码含 `c.created_at` 消歧');
  ok(!/SELECT created_at FROM wa_task_conversations c/.test(code), '源码无 naive `created_at` 残留');
  ok(!/zx_20260909 修复/.test(raw), '★注释不再误标为 `zx_20260909 修复`（该轮提交中无此改动）');
  ok(/zx_20260910_3 M4 修复/.test(raw), '★归属订正为本轮 `zx_20260910_3 M4`');
  ok(/遮蔽/.test(raw), '注释如实记「② 被 ① 遮蔽」——修一漏一即复发');
}

console.log('\n结果: pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
