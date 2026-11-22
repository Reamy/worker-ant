/**
 * zx_20261122_1 「省·自·夜」受控复跑。
 *
 * 分组：
 *   A 模型实绩聚合（单数/成功率/p50·p90/均成本）
 *   B 项目内建议（相关非因果、样本阈值）
 *   C 自省生产者（拒绝留痕 → rule 提案，去重/阈值/红线）
 *   D 自省影响（批准前后同类拒绝频率）
 *   E 模型页接线
 *   F 待办/事件（提案影响上屏、新建发 knowledge.changed）
 *   G 暗色真源（token / 首屏脚本 / ui.theme / purple 残留）
 *   H 暗色兼容层（旧类在暗色作用域有映射）
 *   I 反证与静态（只读/不自动应用/无档位键）
 *   J 构建钉
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
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261122-1-'));
let dbSeq = 0;
function mkdb(): Database.Database {
  return initDatabase(path.join(tmpRoot, `db-${++dbSeq}`));
}

const NOW = Date.parse('2026-11-22T00:00:00Z');

function utc(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString().slice(0, 19).replace('T', ' ');
}

function seedProject(db: Database.Database, id: string, name: string): void {
  db.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run(id, name);
}

function seedTask(
  db: Database.Database,
  input: { id: string; model: string; status: string; tokens?: number | null; cost?: number | null; projectId?: string; daysAgo?: number },
): void {
  const pid = input.projectId ?? 'p1';
  const ctx = JSON.stringify({
    last_model: input.model,
    ...(input.tokens === null ? {} : { execution_metrics: { totalTokens: input.tokens ?? 100 } }),
    ...(input.cost === null ? {} : { cost_estimate: { cost: input.cost ?? 1 } }),
  });
  db.prepare(
    'INSERT INTO wa_tasks (id, project_id, title, status, context_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(input.id, pid, input.id, input.status, ctx, utc((input.daysAgo ?? 1) * 86_400_000));
}

// ==================== A：模型实绩聚合 ====================
async function runA(): Promise<void> {
  console.log('\n[A] 模型实绩聚合');
  let perf: typeof import('../apps/worker-ant-desktop/src/main/core/model-performance.js');
  try { perf = await import('../apps/worker-ant-desktop/src/main/core/model-performance.js'); }
  catch (e) { fail++; console.error(`  FAIL 模块在场 — ${(e as Error).message}`); return; }

  const empty = mkdb();
  seedProject(empty, 'p1', '项目甲');
  const ev = perf.collectModelPerformance(empty, { now: NOW });
  eq(ev.rows, [], '空库 ⇒ 无行');
  eq(ev.samples, { tasks: 0, completed: 0, failed: 0 }, '空库样本为 0');

  const db = mkdb();
  seedProject(db, 'p1', '项目甲');
  seedTask(db, { id: 'a1', model: 'm-a', status: 'completed', tokens: 100, cost: 1 });
  seedTask(db, { id: 'a2', model: 'm-a', status: 'completed', tokens: 200, cost: 2 });
  seedTask(db, { id: 'a3', model: 'm-a', status: 'completed', tokens: 300, cost: 3 });
  seedTask(db, { id: 'a4', model: 'm-a', status: 'failed', tokens: 999, cost: 99 });
  seedTask(db, { id: 'b1', model: 'm-b', status: 'completed', tokens: 50, cost: 0 });
  seedTask(db, { id: 'b2', model: 'm-b', status: 'completed', tokens: 70, cost: 0 });
  seedTask(db, { id: 'c1', model: 'm-c', status: 'completed', tokens: null, cost: null });
  seedTask(db, { id: 'old', model: 'm-a', status: 'completed', tokens: 1, cost: 1, daysAgo: 100 });

  const r = perf.collectModelPerformance(db, { now: NOW });
  const by = Object.fromEntries(r.rows.map((x) => [x.model, x]));
  eq(by['m-a']?.tasks, 4, 'm-a 单数（含 failed）');
  eq(by['m-a']?.completed, 3, 'm-a 完成数');
  eq(by['m-a']?.failed, 1, 'm-a 失败数');
  eq(by['m-a']?.successRate, 0.75, 'm-a 成功率');
  eq(by['m-a']?.tokensP50, 200, 'm-a p50（线性插值）');
  eq(by['m-a']?.tokensP90, 280, 'm-a p90（线性插值）');
  eq(by['m-a']?.avgCost, 2, 'm-a 均成本只算 completed');
  eq(by['m-b']?.successRate, null, '分母 <3 ⇒ 成功率 null');
  eq(by['m-b']?.tokensP50, 60, 'p50 仍可报（仅 completed）');
  eq(by['m-b']?.avgCost, 0, '成本 0 是合法值（不补 null）');
  eq(by['m-c']?.tokensP50, null, '无 token ⇒ null');
  eq(by['m-c']?.avgCost, null, '无 cost ⇒ null');
  eq(r.rows.some((x) => x.tasks === 5), false, '窗口外任务不计');
  eq(r.samples.tasks, 7, '窗口内样本数');

  const bad = mkdb();
  bad.prepare('DROP TABLE wa_tasks').run();
  eq(perf.collectModelPerformance(bad, { now: NOW }).rows, [], '缺任务表 ⇒ 空行（不抛）');
}

// ==================== B：项目内建议 ====================
async function runB(): Promise<void> {
  console.log('\n[B] 项目内建议');
  let perf: typeof import('../apps/worker-ant-desktop/src/main/core/model-performance.js');
  try { perf = await import('../apps/worker-ant-desktop/src/main/core/model-performance.js'); }
  catch (e) { fail++; console.error(`  FAIL 模块在场 — ${(e as Error).message}`); return; }

  const db = mkdb();
  seedProject(db, 'p1', '项目甲');
  seedProject(db, 'p2', '项目乙');
  for (let i = 0; i < 10; i++) seedTask(db, { id: `A${i}`, model: 'm-a', status: 'completed', tokens: 200, cost: 2 });
  for (let i = 0; i < 10; i++) seedTask(db, { id: `B${i}`, model: 'm-b', status: 'completed', tokens: 100, cost: 1 });
  for (let i = 0; i < 10; i++) seedTask(db, { id: `P2${i}`, model: 'm-p2', status: 'completed', tokens: 1, cost: 99, projectId: 'p2' });

  const r = perf.collectModelPerformance(db, { now: NOW, projectId: 'p1' });
  eq(r.rows.map((x) => x.model).sort(), ['m-a', 'm-b'], '只看本项目模型');
  ok(r.recommendation?.model === 'm-b' && r.recommendation.vsModel === 'm-a', '成本低且成功率相近 ⇒ 推荐 m-b');
  ok(r.recommendation?.reason.includes('相关'), '理由写明相关非因果');
  ok(!r.recommendation?.reason.includes('省 X%'), '不承诺省比');

  const global = perf.collectModelPerformance(db, { now: NOW });
  eq(global.rows.length, 3, '不传项目 ⇒ 全部模型');
  eq(global.recommendation, null, '全局不跨项目给建议');

  // 成功率跌破容忍带 ⇒ 不建议
  const db2 = mkdb();
  seedProject(db2, 'p1', '项目甲');
  for (let i = 0; i < 20; i++) seedTask(db2, { id: `x${i}`, model: 'm-a', status: 'completed', tokens: 100, cost: 2 });
  for (let i = 0; i < 8; i++) seedTask(db2, { id: `y${i}`, model: 'm-b', status: 'completed', tokens: 50, cost: 1 });
  for (let i = 0; i < 2; i++) seedTask(db2, { id: `z${i}`, model: 'm-b', status: 'failed', tokens: 50, cost: 1 });
  const r2 = perf.collectModelPerformance(db2, { now: NOW, projectId: 'p1' });
  eq(r2.recommendation, null, '成功率低 10 个百分点（超出 5 点容忍）⇒ 不建议');

  // 成本未知 ⇒ 不建议
  const db3 = mkdb();
  seedProject(db3, 'p1', '项目甲');
  for (let i = 0; i < 5; i++) seedTask(db3, { id: `u${i}`, model: 'm-a', status: 'completed', tokens: 100, cost: 1 });
  for (let i = 0; i < 5; i++) seedTask(db3, { id: `v${i}`, model: 'm-b', status: 'completed', tokens: 100, cost: null });
  eq(perf.collectModelPerformance(db3, { now: NOW, projectId: 'p1' }).recommendation, null, '成本未知 ⇒ 不建议');
}

function seedDenials(db: Database.Database, kind: string, count: number, msAgo: number, prefix: string): void {
  const at = utc(msAgo);
  for (let i = 0; i < count; i++) {
    db.prepare(
      'INSERT INTO wa_task_runtime_evidence (id, task_id, tool, ok, deny_reason, created_at) VALUES (?, ?, ?, 0, ?, ?)',
    ).run(`${prefix}-${i}`, 't1', 'bash', `deny_kind=${kind}; 夹具拒绝`, at);
  }
}

// ==================== C：自省生产者 ====================
async function runC(): Promise<void> {
  console.log('\n[C] 自省生产者');
  let scan: typeof import('../apps/worker-ant-desktop/src/main/core/self-evolve-scan.js');
  let se: typeof import('../apps/worker-ant-desktop/src/main/core/self-evolve.js');
  try {
    scan = await import('../apps/worker-ant-desktop/src/main/core/self-evolve-scan.js');
    se = await import('../apps/worker-ant-desktop/src/main/core/self-evolve.js');
  } catch (e) { fail++; console.error(`  FAIL 模块在场 — ${(e as Error).message}`); return; }

  const db = mkdb();
  se.ensureSelfEvolveTable(db);
  seedDenials(db, 'illegal_char', 19, 86_400_000, 'i');
  const below = scan.generateDenialRuleProposals(db, { now: NOW });
  eq(below.created, [], '19 次（<20）⇒ 不立规');
  ok(below.skipped.some((s) => s.kind === 'illegal_char' && s.reason === 'below_threshold'), '低于阈值如实记');

  seedDenials(db, 'illegal_char', 1, 86_400_000, 'i2');
  const at20 = scan.generateDenialRuleProposals(db, { now: NOW });
  eq(at20.created.map((x) => x.kind), ['illegal_char'], '20 次 ⇒ 立一条 rule 提案');
  const row = db.prepare("SELECT kind, target, status, payload_json, source FROM wa_self_evolve_proposals WHERE id = ?").get(at20.created[0]!.proposalId) as Record<string, unknown>;
  eq(row.kind, 'rule', '提案类为 rule');
  eq(row.status, 'pending', '只落 pending（不自动应用）');
  ok(String(row.target).startsWith('self_rules.') && !String(row.target).startsWith('apps/'), 'target 非源码树');
  ok(String(row.source) === 'denial_audit', '来源可辨');
  const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
  eq(payload.denyKind, 'illegal_char', '载荷带 denyKind');
  eq(payload.evidenceCount, 20, '载荷带证据次数');
  ok(typeof payload.text === 'string' && (payload.text as string).length > 10, '载荷带可读规则文本');

  const again = scan.generateDenialRuleProposals(db, { now: NOW });
  eq(again.created, [], '同 target 已有 pending ⇒ 不重复投');
  ok(again.skipped.some((s) => s.kind === 'illegal_char' && s.reason === 'pending_exists'), '去重原因如实');

  // 规则已在生效清单 ⇒ 不重复投
  db.prepare("INSERT OR REPLACE INTO wa_settings (key, value, updated_at) VALUES ('agent.self_rules', ?, datetime('now'))")
    .run(JSON.stringify([scan.DENIAL_RULE_TEMPLATES.redirection]));
  seedDenials(db, 'redirection', 25, 86_400_000, 'r');
  const existing = scan.generateDenialRuleProposals(db, { now: NOW });
  ok(existing.skipped.some((s) => s.kind === 'redirection' && s.reason === 'rule_exists'), '同文本已生效 ⇒ 不重复投');

  seedDenials(db, 'mystery_kind', 25, 86_400_000, 'm');
  const unknown = scan.generateDenialRuleProposals(db, { now: NOW });
  ok(unknown.skipped.some((s) => s.kind === 'mystery_kind' && s.reason === 'no_template'), '无模板 ⇒ 不立规');

  const bad = mkdb();
  bad.prepare('DROP TABLE wa_task_runtime_evidence').run();
  eq(scan.generateDenialRuleProposals(bad, { now: NOW }).created, [], '缺证据表 ⇒ 空结果（不抛）');
  eq(scan.parseDenyKind('nope'), '', '非标准前缀 ⇒ 空 kind');
}

// ==================== D：自省影响 ====================
async function runD(): Promise<void> {
  console.log('\n[D] 自省影响');
  let imp: typeof import('../apps/worker-ant-desktop/src/main/core/self-evolve-impact.js');
  let se: typeof import('../apps/worker-ant-desktop/src/main/core/self-evolve.js');
  try {
    imp = await import('../apps/worker-ant-desktop/src/main/core/self-evolve-impact.js');
    se = await import('../apps/worker-ant-desktop/src/main/core/self-evolve.js');
  } catch (e) { fail++; console.error(`  FAIL 模块在场 — ${(e as Error).message}`); return; }

  const db = mkdb();
  se.ensureSelfEvolveTable(db);
  const decided = utc(10 * 86_400_000); // NOW - 10 天
  const insertProposal = (id: string, status: string, payload: unknown): void => {
    db.prepare(
      "INSERT INTO wa_self_evolve_proposals (id, kind, target, payload_json, status, source, note, created_at, decided_at) VALUES (?, 'rule', 'self_rules.illegal_char', ?, ?, 'test', '', ?, ?)",
    ).run(id, JSON.stringify(payload), status, decided, decided);
  };
  insertProposal('p-applied', 'applied', { denyKind: 'illegal_char', windowDays: 30 });
  insertProposal('p-pending', 'pending', { denyKind: 'illegal_char', windowDays: 30 });
  insertProposal('p-nokind', 'applied', { windowDays: 30 });

  // before: 30 次落在 [decided-30d, decided)；after: 5 次落在 [decided, now)
  seedDenials(db, 'illegal_char', 30, 15 * 86_400_000, 'b');
  seedDenials(db, 'illegal_char', 5, 5 * 86_400_000, 'a');

  const applied = db.prepare("SELECT * FROM wa_self_evolve_proposals WHERE id = 'p-applied'").get() as Record<string, unknown>;
  const r = imp.ruleProposalImpact(db, applied as never, { now: NOW });
  ok(r !== null, '已生效 rule 提案可算影响');
  if (r) {
    eq(r.denyKind, 'illegal_char', '带 denyKind');
    eq(r.before, 30, '批准前计数');
    eq(r.after, 5, '批准后计数');
    eq(r.verdict, 'better', '频率降到 0.7 以下 ⇒ better');
    ok(Math.abs(r.daysSince - 10) < 0.01, '观察天数按天归一');
  }
  const pending = db.prepare("SELECT * FROM wa_self_evolve_proposals WHERE id = 'p-pending'").get() as Record<string, unknown>;
  eq(imp.ruleProposalImpact(db, pending as never, { now: NOW }), null, 'pending 不谈前后');
  const noKind = db.prepare("SELECT * FROM wa_self_evolve_proposals WHERE id = 'p-nokind'").get() as Record<string, unknown>;
  eq(imp.ruleProposalImpact(db, noKind as never, { now: NOW }), null, '缺 denyKind ⇒ null');

  // 观察不足 3 天 ⇒ insufficient
  const db2 = mkdb();
  se.ensureSelfEvolveTable(db2);
  const d2 = utc(86_400_000);
  db2.prepare("INSERT INTO wa_self_evolve_proposals (id, kind, target, payload_json, status, decided_at) VALUES ('q', 'rule', 'self_rules.illegal_char', ?, 'applied', ?)")
    .run(JSON.stringify({ denyKind: 'illegal_char', windowDays: 30 }), d2);
  seedDenials(db2, 'illegal_char', 5, 2 * 86_400_000, 'q');
  const short = imp.ruleProposalImpact(db2, db2.prepare("SELECT * FROM wa_self_evolve_proposals WHERE id='q'").get() as never, { now: NOW });
  eq(short?.verdict, 'insufficient', '观察 <3 天 ⇒ insufficient');

  // 频率升到 1.2 倍以上 ⇒ worse
  const db3 = mkdb();
  se.ensureSelfEvolveTable(db3);
  db3.prepare("INSERT INTO wa_self_evolve_proposals (id, kind, target, payload_json, status, decided_at) VALUES ('w', 'rule', 'self_rules.illegal_char', ?, 'applied', ?)")
    .run(JSON.stringify({ denyKind: 'illegal_char', windowDays: 30 }), decided);
  seedDenials(db3, 'illegal_char', 30, 15 * 86_400_000, 'wb');
  seedDenials(db3, 'illegal_char', 20, 5 * 86_400_000, 'wa');
  const worse = imp.ruleProposalImpact(db3, db3.prepare("SELECT * FROM wa_self_evolve_proposals WHERE id='w'").get() as never, { now: NOW });
  eq(worse?.verdict, 'worse', '频率升到 1.2 倍以上 ⇒ worse');
}

// ==================== E：模型页接线 ====================
function runE(): void {
  console.log('\n[E] 模型页接线');
  const read = (rel: string): string => fs.readFileSync(path.join(root, A, rel), 'utf-8');

  const ipc = read('src/main/ipc/admin.ipc.ts');
  ok(ipc.includes("ipcMain.handle('models:performance'"), 'models:performance 在册');
  const page = read('renderer/src/pages/ModelsPage.tsx');
  ok(page.includes("'models:performance'"), '模型页调实绩接口');
  ok(page.includes('模型实绩') && page.includes('样本不足'), '页面上屏实绩与样本不足');
  ok(page.includes('相关，非因果'), '建议标注相关性');
  ok(page.includes('projectsApi.modelOverride.set'), '项目默认走既有写口');
  ok(page.includes('setDefaultModelTo'), '全局默认走既有写口');
  ok(!/useEffect\([^)]*modelOverride\.set/s.test(page), '不在 effect 里自动写默认');
  ok(page.includes('formatTokens') && page.includes('formatMoney'), 'token/成本与全站同尺');
}

// ==================== F：待办/事件 ====================
function runF(): void {
  console.log('\n[F] 待办/事件');
  const read = (rel: string): string => fs.readFileSync(path.join(root, A, rel), 'utf-8');

  const inboxCore = read('src/main/core/knowledge-inbox.ts');
  ok(inboxCore.includes('rulesInEffect') && inboxCore.includes('ruleProposalImpact'), '读模型带「已生效规则 + 影响」');
  const page = read('renderer/src/pages/InboxPage.tsx');
  ok(page.includes('已生效的自省规则'), '待办中心有已生效规则区');
  ok(page.includes('批准前') && page.includes('批准后'), '上屏批准前后同类拒绝');
  ok(page.includes("admin.selfEvolveDecide(p.id, 'rollback')"), '变差可回滚');

  const jobs = read('src/main/core/jobs/index.ts');
  ok(jobs.includes("scheduler.register('self-evolve-scan'"), '巡检作业在册');
  ok(jobs.includes('generateDenialRuleProposals') && jobs.includes('emitKnowledgeChanged'), '新建提案后发瞬态线');
  ok(!jobs.includes("decideProposal("), '巡检不自动批准');
}

// ==================== G：暗色真源 ====================
function runG(): void {
  console.log('\n[G] 暗色真源');
  const read = (rel: string): string => fs.readFileSync(path.join(root, A, rel), 'utf-8');

  const css = read('renderer/src/index.css');
  ok(css.includes('@theme'), '浅色 token 仍在 @theme');
  ok(css.includes('html.wa-dark'), '暗色作用域在册（html.wa-dark）');
  for (const pair of [['--color-paper', '#14130f'], ['--color-ink', '#f2eee4'], ['--color-surface', '#1c1a15'], ['--color-accent', '#8fb3c7'], ['--color-cinnabar', '#d9775e']]) {
    ok(new RegExp(`${pair[0]}:\\s*${pair[1]}`, 'i').test(css), `暗色 token：${pair[0]} = ${pair[1]}`);
  }
  const html = read('renderer/index.html');
  ok(html.includes("localStorage.getItem('wa.theme')") && html.includes('dataset.theme'), '首屏内联脚本在册（无闪）');
  ok(html.includes('prefers-color-scheme'), 'system 跟随系统');

  const theme = read('renderer/src/lib/theme.ts');
  ok(theme.includes("THEME_SETTING_KEY = 'ui.theme'") && theme.includes("THEME_STORAGE_KEY = 'wa.theme'"), '主题键单一真源');
  ok(/export type ThemeChoice = 'system' \| 'light' \| 'dark'/.test(theme), '三态词表');
  ok(theme.includes('export function initTheme') && theme.includes('export async function setTheme'), 'init/set 在册');
  ok(theme.includes("classList.toggle('wa-dark'"), '应用时切 wa-dark 类（token 生效点）');
  ok(read('renderer/src/main.tsx').includes('initTheme()'), '挂载前初始化');

  const settings = read('renderer/src/pages/SettingsPage.tsx');
  ok(settings.includes('界面 · 主题') && settings.includes('setTheme('), '设置页可切换主题');
  ok(settings.includes('跟随系统'), '设置页有 system 选项');

  // 产出物验证行：暗色下曾因 `bg-emerald-50/50`（浅底未映射）+ `text-gray-500` 而几乎看不清。
  // 该行直连 token，不再依赖兼容层。
  const tdp = read('renderer/src/pages/TaskDetailPage.tsx');
  ok(tdp.includes('bg-ok-soft/50') && tdp.includes('border-ok/30') && tdp.includes('text-ink-soft'), '产出物验证行用语义 token');

  // 产出物管理：窄窗时表格必须可横向滚动（原 `overflow-hidden` 会把右侧列裁掉）。
  const deliv = read('renderer/src/pages/DeliverablesPage.tsx');
  ok(deliv.includes('overflow-x-auto') && /<table className="w-full min-w-\[/.test(deliv), '产出物表窄窗可横向滚动');

  // 源码里不再有 purple/violet 类（CSS 的暗色兜底除外）
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!/\.(tsx?|ts)$/.test(ent.name)) continue;
      const text = fs.readFileSync(p, 'utf-8');
      if (/(?:bg|text|border|hover:bg)-(?:purple|violet)-/.test(text)) offenders.push(path.relative(root, p));
    }
  };
  walk(path.join(root, A, 'renderer/src'));
  eq(offenders, [], '源码无 purple/violet 类残留');

  // zx_20261122_1 补修：blue/indigo 旧类须已迁到 accent token。
  // 暗色兼容层**不映射** blue/indigo（见 index.css 迁移注释）；残留即意味着暗色下
  // 「深蓝字 + 深色底」对比不足（需求理解卡 `text-indigo-800` 即此形态）。
  const legacy: string[] = [];
  const walkLegacy = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walkLegacy(p); continue; }
      if (!/\.(tsx?|ts)$/.test(ent.name)) continue;
      const text = fs.readFileSync(p, 'utf-8');
      if (/(?:bg|text|border|ring|accent|hover:bg|hover:text|hover:ring|focus:ring)-(?:blue|indigo)-/.test(text)) {
        legacy.push(path.relative(root, p));
      }
    }
  };
  walkLegacy(path.join(root, A, 'renderer/src'));
  eq(legacy, [], '源码无 blue/indigo 类残留（暗色不映射它们）');
}

// ==================== H：暗色兼容层 ====================
function runH(): void {
  console.log('\n[H] 暗色兼容层');
  const css = fs.readFileSync(path.join(root, A, 'renderer/src/index.css'), 'utf-8');
  // 只取暗色作用域块，避免把浅色/其他规则算进来
  const darkStart = css.indexOf('html.wa-dark');
  const darkBlob = darkStart >= 0 ? css.slice(darkStart) : '';
  const need = [
    '.bg-white', '.bg-gray-50', '.bg-gray-900', '.text-gray-800', '.text-gray-500',
    '.border-gray-200', '.border-gray-300', '.hover\\:bg-gray-50', '.bg-amber-50',
    '.text-amber-700', '.bg-red-50', '.text-red-700', '.bg-green-50', '.bg-sky-50', '.bg-teal-50',
  ];
  for (const sel of need) {
    ok(darkBlob.includes(`html.wa-dark ${sel}`), `暗色映射：${sel}`);
  }
  ok(darkBlob.includes('[class~="bg-accent"][class~="text-white"]'), '暗色主色底改深字（白字对比不足）');
  // 语义底/字/线的 -50 透明度变体与 -200/300 边框：存量页面大量使用，
  // 不映射会留下「浅底 + 暗色字」或「亮边框」的失配（产出物验证行即其一）。
  const needMore = [
    '[class~="bg-emerald-50/50"]', '[class~="bg-red-50/50"]', '[class~="bg-amber-50/50"]', '[class~="bg-sky-50/50"]',
    '.border-emerald-200', '.border-red-200', '.border-amber-300', '.border-emerald-300',
    '.text-emerald-500', '.bg-green-200', '.text-amber-900', '.text-sky-900',
    '.bg-gray-200', '.bg-gray-300', '.bg-stone-50',
  ];
  for (const sel of needMore) {
    ok(darkBlob.includes(`html.wa-dark ${sel}`), `暗色映射（补）：${sel}`);
  }
  ok(!/^\.bg-white\s*\{/m.test(css), '不全局改 .bg-white（只在暗色作用域）');
  ok(!/^\.text-gray-800\s*\{/m.test(css), '不全局改 .text-gray-800');
}

// ==================== I：反证与静态 ====================
function runI(): void {
  console.log('\n[I] 反证与静态');
  const read = (rel: string): string => fs.readFileSync(path.join(root, A, rel), 'utf-8');

  const perf = read('src/main/core/model-performance.ts');
  ok(!/\b(INSERT|UPDATE|DELETE)\b/i.test(perf), '实绩读模型不写库');
  ok(!/from\s+'electron'/.test(perf) && !/fetch\(|node:https?/.test(perf) && !/openai|generateText|streamText/.test(perf), '实绩读模型零 electron/网络/LLM');

  const scan = read('src/main/core/self-evolve-scan.ts');
  ok(scan.includes('recordProposal') && !scan.includes('decideProposal('), '自省只投提案，不自动批准');
  ok(!scan.includes("kind: 'skill'") && !scan.includes('"skill"'), '不产 skill 提案（无应用器）');
  ok(!/INSERT\s+INTO\s+wa_settings/i.test(scan), '不直接写规则清单（应用仍走人工闸）');
  ok(scan.includes('self_rules.') && !scan.includes('apps/'), 'target 非源码树');
  ok(!/from\s+'electron'/.test(scan) && !/fetch\(|node:https?/.test(scan), '自省零 electron/网络');

  const impact = read('src/main/core/self-evolve-impact.ts');
  ok(!/\b(INSERT|UPDATE|DELETE)\b/i.test(impact) && !/from\s+'electron'/.test(impact), '影响复盘只读、零 electron');

  const inbox = read('src/main/core/knowledge-inbox.ts');
  ok(!/\bINSERT\b|\bUPDATE\b|\bDELETE\b/i.test(inbox), '知识待办读模型不写库');

  const tier = read('src/main/core/tier-catalog.ts') + read('src/main/core/pro-gate.ts') + read('src/main/core/team-gate.ts');
  ok(!/model_perf|modelPerf|self_evolve_scan|selfEvolveScan|dark_theme/i.test(tier), '未新增档位能力键');

  const jobs = read('src/main/core/jobs/index.ts');
  ok(!/decideProposal\(/.test(jobs), '巡检不自动批准提案');
}

(async () => {
  await runA();
  await runB();
  await runC();
  await runD();
  runE();
  runF();
  runG();
  runH();
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
