/**
 * zx_20261110_1 B0「准·达」受控回归 —— 契约与测量固证。
 *
 * A 构建标识：源码唯一真源＝本脚本轮次（由文件名派生），P1–P6 全过；
 * B 测量口径：`scripts/measure-knowledge-reuse.ts` 在册且**只读**（源码不含写盘/写库调用）；
 * C 四本账口径：内存库夹具验证 `measureKnowledgeReuse` 的计数/字符/比率与空库回落。
 *
 * 纪律：轮次值由 `path.basename(__filename)` 派生后做方向性比较；断言文案不含失败字形。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, deriveBuildTag } from './lib/rr-pins.js';
import { measureKnowledgeReuse, formatLedger } from './measure-knowledge-reuse.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
// 方向性比较：源码 build 只须**不早于**本脚本轮次（写死等值＝下一轮必炸的哑雷）。
const roundOrd = (t: string): number => {
  const m = /^zx_(\d{8})(?:_(\d+))?$/.exec(t);
  return m ? Number(m[1]) * 1000 + Number(m[2] ?? 1) : -1;
};
const ROOT = path.join(__dirname, '..');
const EXEC = path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/agent-executor.ts');
const PLAN = path.join(ROOT, 'plans/improve', `${SELF_ROUND}.md`);
const DIST = path.join(ROOT, 'apps/worker-ant-desktop/dist');
const MEASURE = path.join(ROOT, 'scripts/measure-knowledge-reuse.ts');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

console.log(`\n【A】构建标识 ${SELF_ROUND}`);
{
  const execSrc = fs.readFileSync(EXEC, 'utf-8');
  const { tag, count } = deriveBuildTag(execSrc);
  eq(count, 1, 'A1 源码 build 轮次标识恰好 1 处');
  ok(roundOrd(tag) >= roundOrd(SELF_ROUND), 'A2 源码 build 不早于脚本轮次（文件名派生，方向性比较）', `${tag} vs ${SELF_ROUND}`);
  ok(fs.existsSync(PLAN), `A3 方案在册：plans/improve/${SELF_ROUND}.md`);
  checkBuildPins(ok, { distDir: DIST });
}

console.log('\n【B】测量口径只读');
{
  ok(fs.existsSync(MEASURE), 'B1 测量脚本在册：scripts/measure-knowledge-reuse.ts');
  const src = fs.readFileSync(MEASURE, 'utf-8');
  const writes = ['writeFile', 'writeFileSync', 'mkdir', 'mkdirSync', 'unlink', 'rmSync', 'rename', 'appendFile',
    'INSERT ', 'UPDATE ', 'DELETE ', 'CREATE TABLE', 'DROP TABLE']
    .filter((w) => src.includes(w));
  eq(writes, [], 'B2 测量脚本不含任何写盘/写库调用（只读口径）');
  ok(src.includes('readOnly: true'), 'B3 CLI 以 readOnly 打开生产库');
  ok(/key\}\|\$\{r\.count\}\|\$\{r\.chars\}\|\$\{r\.note\}/.test(src), 'B4 输出格式固定为 key|count|chars|note');
}

function sectionC(): void {
  console.log('\n【C】四本账口径（内存库夹具）');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE wa_context_injections (task_id TEXT, source TEXT, chars INTEGER, est_tokens INTEGER, outcome TEXT);
      CREATE TABLE wa_knowledge_cards (status TEXT, kind TEXT, tokens INTEGER);
      CREATE TABLE wa_domain_packs (id TEXT PRIMARY KEY, origin TEXT, dismissed_at TEXT);
      CREATE TABLE wa_project_domain_packs (project_id TEXT, pack_id TEXT);
      CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, task_id TEXT);
    `);
    const ins = db.prepare('INSERT INTO wa_context_injections (task_id, source, chars, est_tokens, outcome) VALUES (?,?,?,?,?)');
    ins.run('t1', 'memory', 10, 3, 'completed');
    ins.run('t2', 'memory', 5, 1, 'pending');
    ins.run('t1', 'knowledge', 7, 2, 'completed');
    ins.run('t3', 'knowledge', 3, 1, 'completed');
    const card = db.prepare('INSERT INTO wa_knowledge_cards (status, kind, tokens) VALUES (?,?,?)');
    card.run('active', 'business_fact', 30);
    card.run('active', 'pitfall', 10);
    card.run('archived', 'business_fact', 99);
    const pack = db.prepare('INSERT INTO wa_domain_packs (id, origin, dismissed_at) VALUES (?,?,?)');
    pack.run('P1', 'auto_candidate', null);
    pack.run('P2', 'auto_candidate', '2026-11-01');
    pack.run('P3', 'user', null);
    db.prepare('INSERT INTO wa_project_domain_packs (project_id, pack_id) VALUES (?,?)').run('proj', 'P1');
    const task = db.prepare('INSERT INTO wa_tasks (id, status) VALUES (?,?)');
    task.run('t1', 'completed');
    task.run('t2', 'completed');
    task.run('t3', 'completed');
    db.prepare('INSERT INTO wa_deliverables (id, task_id) VALUES (?,?)').run('d1', 't1');

    const rows = measureKnowledgeReuse(db as never);
    const find = (k: string) => rows.find((r) => r.key === k);

    eq(find('injection.memory')?.count, 2, 'C1 注入账按 source 计数');
    eq(find('injection.memory')?.chars, 15, 'C2 注入账字符求和');
    ok(String(find('injection.memory')?.note).includes('completed=1') && String(find('injection.memory')?.note).includes('rate=50.0%'),
      'C3 注入账完成数与完成率同口径', String(find('injection.memory')?.note));
    eq(find('injection.total')?.count, 4, 'C4 注入总账条数');

    eq(find('knowledge_card.active')?.count, 2, 'C5 知识卡按状态计数');
    eq(find('knowledge_card.active')?.chars, 40, 'C6 知识卡 token 求和');
    eq(find('knowledge_card.kind.business_fact')?.count, 2, 'C7 知识卡按 kind 计数');

    eq(find('domain_pack.auto_candidate')?.count, 2, 'C8 候选包按 origin 计数');
    ok(String(find('domain_pack.auto_candidate')?.note).includes('dismissed=1'), 'C9 候选包忽略数');
    eq(find('domain_pack.enabled')?.count, 1, 'C10 启用映射行数');
    eq(find('domain_pack.enabled_auto_candidate')?.count, 1, 'C11 自动候选包被启用数');

    eq(find('completion.tasks')?.count, 3, 'C12 完成账任务总数');
    eq(find('completion.with_knowledge')?.count, 2, 'C13 完成账带知识任务数（t1/t3 去重）');
    eq(find('completion.with_knowledge_and_deliverable')?.count, 1, 'C14 完成账知识×交付物交集');

    const lines = formatLedger(rows).split('\n');
    ok(lines.length > 0 && lines.every((l) => l.split('|').length === 4), 'C15 每行恰四列（key|count|chars|note）');
  } finally {
    db.close();
  }

  console.log('\n【D】空库/老库不阻断');
  const empty = new DatabaseSync(':memory:');
  try {
    const rows = measureKnowledgeReuse(empty as never);
    ok(rows.length >= 5, 'D1 缺表时仍返回账行（不抛）', `rows=${rows.length}`);
    ok(rows.every((r) => r.count === 0), 'D2 缺表时计数一律 0（未编造）');
    ok(rows.some((r) => r.key === 'completion.tasks'), 'D3 完成账键仍在（口径稳定）');
  } finally {
    empty.close();
  }
}

sectionC();

console.log(`\n汇总: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
