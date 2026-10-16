/**
 * zx_20260908_1 批1 受控复跑（node:sqlite 内存库语义 + 源码静态防回归；绝不触碰开发库；tsx 运行，用法同 rr_zx_20260907_b1.ts）。
 * A1 已验证配方同任务去重归并: agent-executor A1a 分支——同 taskId 已有一条 verified receipt(同 docPaths 重叠) → 归并更新(更新 content/importance/context_json)而非新增,
 *      消除同任务重复配方(实库 taskId 54313d29 重复 3 条)→ §3 不再注入同款; memory.receipt_dedup 开关(false=现行为 append)。
 * A2 有效样板按"被应用证据"优先注入: getExemplars effectRank 排序——context.applied.count>0 且 last_success=true 加权 0.1(importance 仍主键) → §3 有效样板排前;
 *      generateExemplarContext 读 memory.exemplar_effect_rank 开关。
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
dbm.exec(`CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT, memory_type TEXT, importance REAL DEFAULT 0.5, valence TEXT, source TEXT, use_count INTEGER DEFAULT 0, reusable_experience INTEGER, is_exemplar INTEGER DEFAULT 0, exemplar_type TEXT, exemplar_context TEXT, context_json TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);`);

console.log('A1 同任务 receipt 去重归并语义');
// 已有同任务 receipt(exemplar good, receipt.docPaths=含 cost_check 文件名)
dbm.prepare("INSERT INTO wa_memories (id,project_id,task_id,content,memory_type,importance,valence,source,is_exemplar,exemplar_type,context_json) VALUES ('e1','p','t1','[已验证成果配方]旧','semantic',0.85,'positive','outcome_exemplar',1,'good','{\"reusable_experience\":1,\"receipt\":{\"taskId\":\"t1\",\"docPaths\":\"cost_check_x.md\",\"acceptance\":{\"criteria_total\":3,\"passed_total\":3},\"has_gist\":true}}')").run();
// 复刻 agent-executor A1 去重谓词：同 taskId+source+is_exemplar+exemplar_type=good，docPaths 重叠 → existingId
const dedupQuery = dbm.prepare("SELECT id, context_json FROM wa_memories WHERE task_id = ? AND source = 'outcome_exemplar' AND is_exemplar = 1 AND exemplar_type = 'good'");
function findExisting(taskId: string, curPathsStr: string): string | null {
  const curNames = curPathsStr.split('、').filter(Boolean);
  const sameRows = dedupQuery.all(taskId);
  for (const r of sameRows) {
    try {
      const cj = JSON.parse(r.context_json || '{}');
      const oldNames = String(cj.receipt?.docPaths || '').split('、').filter(Boolean);
      if (curNames.some((c: string) => oldNames.some((o: string) => c.includes(o) || o.includes(c)))) return r.id;
    } catch { /* skip */ }
  }
  return null;
}
ok(findExisting('t1', 'cost_check_x.md') === 'e1', 'A1 同 doc 二次 finalize 命中既有 receipt(归并而非新增)', 'existingId=e1');
ok(findExisting('t1', 'other_doc.md') === null, 'A1 不同 doc(无重叠)不命中 → 可另立配方(防误并多 doc)');
// 归并更新：content 刷新 + importance 抬 MAX(0.85) + context_json 保留既有 reusable/applied 键并刷新 receipt
const mergeCtx = JSON.parse(dbm.prepare("SELECT context_json FROM wa_memories WHERE id='e1'").get().context_json || '{}');
mergeCtx.applied = { count: 2, last_success: true };
mergeCtx.receipt = { taskId: 't1', docPaths: 'cost_check_x.md', acceptance: { criteria_total: 3, passed_total: 3 }, has_gist: true, sufficiency: true };
dbm.prepare("UPDATE wa_memories SET content = ?, importance = MAX(importance, 0.85), context_json = ?, updated_at = datetime('now') WHERE id = ?").run('[已验证成果配方]新', JSON.stringify(mergeCtx), 'e1');
const e1 = dbm.prepare("SELECT content, importance, context_json cj FROM wa_memories WHERE id='e1'").get();
ok(e1.content === '[已验证成果配方]新' && e1.importance >= 0.85, 'A1 归并更新 content 刷新 + importance≥0.85');
ok(JSON.parse(e1.cj).reusable_experience === 1 && JSON.parse(e1.cj).applied.count === 2, 'A1 归并不丢既有键(reusable/applied)');
const cnt = dbm.prepare("SELECT COUNT(*) c FROM wa_memories WHERE task_id='t1' AND source='outcome_exemplar'").get().c;
ok(cnt === 1, 'A1 归并路径不新增(同任务仍 1 条)', `count=${cnt}`);

console.log('A2 有效样板按被应用证据排序语义');
// applied 有效(.7+0.1=0.8) 应排在 无 applied(.78) 之前；effectRank=false 时保持纯 importance(.78 在前)
function rank(list: Array<{ importance: number; applied: number; lastSuccess: boolean }>, effectRank: boolean) {
  const arr = list.map((x) => ({ ...x }));
  arr.sort((a, b) => {
    const sa = a.importance + (effectRank && a.applied > 0 && a.lastSuccess ? 0.1 : 0);
    const sb = b.importance + (effectRank && b.applied > 0 && b.lastSuccess ? 0.1 : 0);
    if (sa !== sb) return sb - sa;
    return 0;
  });
  return arr;
}
const pool = [
  { id: 'A', importance: 0.78, applied: 0, lastSuccess: false },   // 高 importance 但从未被应用
  { id: 'B', importance: 0.7, applied: 3, lastSuccess: true },     // 实证被采纳成功 → +0.1=0.8
  { id: 'C', importance: 0.6, applied: 0, lastSuccess: false },
];
const ranked = rank(pool, true);
ok(ranked[0].id === 'B', 'A2 effectRank: 被应用且成功样板(B)排至首位(0.8>0.78)', `top=${ranked[0].id}`);
const plain = rank(pool, false);
ok(plain[0].id === 'A', 'A2 effectRank=false 回退纯 importance(A 0.78 在前)', `top=${plain[0].id}`);

console.log('config 默认键');
const dts = rd('apps/worker-ant-desktop/src/main/database.ts');
ok(dts.includes("memory.receipt_dedup") && dts.includes("'true'"), 'database 默认键 memory.receipt_dedup=true');
ok(dts.includes("memory.exemplar_effect_rank") && dts.includes("'true'"), 'database 默认键 memory.exemplar_effect_rank=true');

console.log('源码静态防回归');
const ae = engineSrc();
ok(ae.includes("key = 'memory.receipt_dedup'") && ae.includes("task_id = ? AND source = 'outcome_exemplar' AND is_exemplar = 1 AND exemplar_type = 'good'"), 'agent-executor A1 去重谓词在案(同任务 exemplar good)');
ok(ae.includes("existingId") && ae.includes("importance = MAX(importance, 0.85), context_json") && ae.includes("SET content = ?"), 'agent-executor A1 归并更新(update content+importance+ctx)在案');
ok(ae.includes("else {") && ae.includes('ctx.memory.storeText(') && ae.includes("markExemplar(memId, 'good'"), 'agent-executor A1 未命中仍走新增 storeText+markExemplar');
ok(ae.includes('[已验证成果配方]') && ae.includes("source: 'outcome_exemplar'") && ae.includes('reusableExperience: true'), 'agent-executor 保留 outcome_exemplar 源标签+reusable(旧回归兼容)');
const mm = rd('apps/worker-ant-desktop/src/main/core/memory-manager.ts');
ok(mm.includes("effectRank = false") && mm.includes("0.1") && mm.includes("context_json as cj") && mm.includes(".applied?.count"), 'memory-manager getExemplars effectRank 加权排序在案(importance 仍主键)');
ok(mm.includes("key = 'memory.exemplar_effect_rank'") && mm.includes("this.getExemplars(projectId, 'good', 3, effectRank)"), 'generateExemplarContext 读开关并传 effectRank');

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
