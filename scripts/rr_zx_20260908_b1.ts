/**
 * zx_20260908 批1 受控复跑（node:sqlite 内存库语义 + 源码静态防回归；绝不触碰开发库；tsx 运行，用法同 rr_zx_20260907_b1.ts）。
 * A1a 已验证成果配方收口: finalize 通过+验收全过+doc产出 → content 升级为[已验证成果配方](doc正文摘录+验收逐条+内容校验),
 *      importance≥0.85 + markExemplar('good') + context_json 溯源 receipt(保留 reusable_experience)。
 * A1b 自动晋升死路修复: jobs 自动晋升补写 exemplar_type='good' → 晋升行可被 getExemplars('good') 消费进 §3。
 * A2 空转治理(为道日损): memory.consolidation_idle_skip(默认true,0关) 闲置项目跳过 LLM 密集 Phase;非 LLM 卫生保留。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { engineSrc } from './lib/rr-engine-src.js';
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (p?: string) => any };

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
const dbm = new DatabaseSync(':memory:') as any;
dbm.exec(`CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, content TEXT, memory_type TEXT, importance REAL DEFAULT 0.5, valence TEXT, source TEXT, use_count INTEGER DEFAULT 0, reusable_experience INTEGER, is_exemplar INTEGER DEFAULT 0, exemplar_type TEXT, context_json TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, status TEXT);
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT, updated_at TEXT);
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);`);

console.log('A1b 自动晋升死路修复语义');
dbm.prepare("INSERT INTO wa_memories (id, project_id, content, memory_type, importance, valence, source, use_count, is_exemplar) VALUES ('m1','p','high-use positive semantic','semantic',0.9,'positive','agent_execution',6,0)").run();
// 模拟 jobs 自动晋升 SQL(现补 exemplar_type='good')
const prom = dbm.prepare("UPDATE wa_memories SET is_exemplar = 1, exemplar_type = 'good' WHERE use_count >= 5 AND valence = 'positive' AND memory_type IN ('semantic','procedural') AND is_exemplar = 0").run();
ok(prom.changes === 1, 'A1b 自动晋升命中(use_count>=5 positive semantic)');
const m1 = dbm.prepare("SELECT is_exemplar ie, exemplar_type et FROM wa_memories WHERE id='m1'").get();
ok(m1.ie === 1 && m1.et === 'good', 'A1b 晋升行补写 exemplar_type=good(死路修复)', `type=${m1.et}`);
const cons = dbm.prepare("SELECT COUNT(*) c FROM wa_memories WHERE is_exemplar=1 AND exemplar_type='good'").get().c;
ok(cons === 1, 'A1b 晋升行现可被 getExemplars(good) 消费进 §3');

console.log('A1a 已验证成果配方语义');
dbm.prepare("INSERT INTO wa_memories (id, project_id, content, memory_type, importance, source, reusable_experience, valence, context_json) VALUES ('m2','p','x','semantic',0.5,'outcome_exemplar',1,'neutral','{\"reusable_experience\":1}')").run();
dbm.prepare("UPDATE wa_memories SET importance = MAX(importance, 0.85) WHERE id = 'm2'").run();
dbm.prepare("UPDATE wa_memories SET is_exemplar = 1, exemplar_type = 'good' WHERE id = 'm2'").run();
// 溯源 receipt 元数据并入 context_json(保留 reusable_experience 既有位)
const m2ctx = JSON.parse(dbm.prepare("SELECT context_json FROM wa_memories WHERE id='m2'").get().context_json || '{}');
m2ctx.receipt = { taskId: 't1', docPaths: 'a.md', acceptance: { criteria_total: 2, passed_total: 2 }, has_gist: true };
dbm.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?').run(JSON.stringify(m2ctx), 'm2');
const r2 = dbm.prepare("SELECT importance, is_exemplar ie, exemplar_type et, context_json cj FROM wa_memories WHERE id='m2'").get();
ok(r2.importance >= 0.85, 'A1a importance 抬高≥0.85', `importance=${r2.importance}`);
ok(r2.ie === 1 && r2.et === 'good', 'A1a 标记 exemplar(good/outcome_success)');
ok(JSON.parse(r2.cj).receipt?.acceptance?.passed_total === 2, 'A1a context_json 溯源 receipt 并入');
ok('reusable_experience' in JSON.parse(r2.cj), 'A1a 既有 context 字段(reusable)未丢失');

console.log('A2 闲置项目门控语义(近7天无任务/记忆活动=跳过 LLM 巩固)');
dbm.prepare("INSERT INTO wa_projects (id,status) VALUES ('act','active'),('idl','active')").run();
dbm.prepare("INSERT INTO wa_tasks (id,project_id,title,status,updated_at) VALUES ('ta1','act','t','completed',datetime('now','-1 day'))").run();
dbm.prepare("INSERT INTO wa_memories (id,project_id,content,memory_type,updated_at) VALUES ('ma1','act','a','semantic',datetime('now','-1 hour'))").run();
dbm.prepare("INSERT INTO wa_memories (id,project_id,content,memory_type,updated_at) VALUES ('mi1','idl','b','semantic',datetime('now','-30 days'))").run();
const cutoffMs = Date.now() - 7 * 86_400_000;
const actRows = dbm.prepare("SELECT id AS project_id, (SELECT MAX(t.updated_at) FROM wa_tasks t WHERE t.project_id = p.id) AS last_task, (SELECT MAX(m.updated_at) FROM wa_memories m WHERE m.project_id = p.id AND m.memory_type != 'archived') AS last_mem FROM wa_projects p WHERE p.id IN ('act','idl')").all();
const activeSet = new Set<string>();
for (const r of actRows) {
  const lu = Math.max(r.last_task ? new Date(r.last_task.replace(' ', 'T') + 'Z').getTime() : 0, r.last_mem ? new Date(r.last_mem.replace(' ', 'T') + 'Z').getTime() : 0);
  if (lu >= cutoffMs) activeSet.add(r.project_id);
}
ok(activeSet.has('act') && !activeSet.has('idl'), 'A2 近活动项目保留 / 闲置项目(30天无活动)判空闲', `active=[${[...activeSet].join(',')}]`);
dbm.prepare("INSERT INTO wa_settings (key,value) VALUES ('memory.consolidation_idle_skip','0')").run();
const off = dbm.prepare("SELECT value v FROM wa_settings WHERE key='memory.consolidation_idle_skip'").get().v;
ok(off === '0', 'A2 0=关闭(回退全部执行)');

console.log('源码静态防回归');
const dts = rd('apps/worker-ant-desktop/src/main/database.ts');
ok(dts.includes('memory.consolidation_idle_skip') && dts.includes("'true'"), 'database 默认键 memory.consolidation_idle_skip=true');
const jobs = rd('apps/worker-ant-desktop/src/main/core/jobs/index.ts');
const recentLoops = (jobs.match(/for \(const \{ project_id \} of recentProjects\)/g) || []).length;
ok(recentLoops >= 7, 'jobs consolidate LLM Phase 循环切到 recentProjects(≥7)', `count=${recentLoops}`);
ok(jobs.includes('idleSkipped') && jobs.includes('为道日损'), 'jobs A2 闲置跳过留痕日志在案');
ok(jobs.includes("exemplar_type = 'good'"), 'jobs A1b 自动晋升补 exemplar_type=good 在案');
const ae = engineSrc();
ok(ae.includes('[已验证成果配方]') && ae.includes('产出摘录') && ae.includes('content_snapshot'), 'agent-executor A1a receipt 组合在案');
ok(ae.includes('MAX(importance, 0.85)') && ae.includes("markExemplar(memId, 'good'"), 'agent-executor A1a importance≥0.85 + exemplar good 在案');
ok(ae.includes("source: 'outcome_exemplar'") && ae.includes('reusableExperience: true'), 'agent-executor 保留 outcome_exemplar 源标签(旧回归兼容)');
ok(ae.includes('mCtx.receipt =') && ae.includes('has_gist'), 'agent-executor A1a receipt 溯源并入 context_json 在案');
ok(ae.includes("type = 'doc' AND status IN ('draft','registered','completed')"), 'agent-executor A2 doc 过滤含 draft(承接死路修正)');

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
