/**
 * zx_20261118_2 M3「名」——工具级根围栏：`write_file` 写 `/tmp` 不建成果行，写工作目录内仍建。
 *
 * 为什么单独一套件：`tools.write_file.execute` 是 async，而主套件 `rr_zx_20261118_2.ts`
 * 是 CJS（用 `__dirname`），不能顶层 await；独立成小套件后由全量编排器同批发现
 * （P4 认 `rr_<tag>_*.ts`），且不把主套件的同步形状改成 async。
 *
 * 纪律：直引生产 `writeTools` 与 `ensureDocDeliverable`；夹具按生产初始化顺序
 * （先 `initDatabase`，再插项目/任务行）；两侧标本同试（根外 0 行 / 根内 1 行）。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { initDatabase } from '../apps/worker-ant-desktop/src/main/database.js';
import { writeTools } from '../apps/worker-ant-desktop/src/main/core/tools/write.js';
// `ensureDocDeliverable` 的生产导出面在 agent-executor（`writeTools` 的注入源；`rr_zx_20261022_1` 同引这里）。
import { ensureDocDeliverable } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';

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

async function main(): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261118-2-c3-'));
  const db = initDatabase(path.join(tmpRoot, 'db'));
  const ws = path.join(tmpRoot, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p', 'P', ?)").run(ws);
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, status) VALUES ('t-m3', 'p', '写件', 'executing')").run();

  const deps = {
    ctx: {}, db, taskId: 't-m3', projectId: 'p', workingDir: ws,
    approvePathWrite: async () => ({ allowed: true }),
    ensureDocDeliverable,
    ARTIFACT_WRITE_TOOLS: new Set<string>(),
    logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    readFiles: new Set<string>(),
  } as unknown as Parameters<typeof writeTools>[0];
  const tools = writeTools(deps);

  // 根外（/tmp）：写入本身成功，但不登记成果
  const outside = path.join(os.tmpdir(), `rr-m3-out-${crypto.randomUUID()}.txt`);
  const out = JSON.parse(String(await tools.write_file.execute({ filePath: outside, content: 'tmp' })));
  ok(out.ok === true, 'C3 根外写入本身成功');
  ok(!out.deliverableId, 'C3 根外写入不返回 deliverableId');
  eq((db.prepare('SELECT COUNT(*) c FROM wa_deliverables WHERE file_path = ?').get(outside) as { c: number }).c, 0, 'C3 根外写入不建成果行');

  // 根内：仍登记成果（证明围栏不是"一律不登记"）
  const inside = path.join(ws, 'inside.txt');
  const inn = JSON.parse(String(await tools.write_file.execute({ filePath: inside, content: 'root' })));
  ok(inn.ok === true && !!inn.deliverableId, 'C3 根内写入仍登记成果', JSON.stringify(inn));
  eq((db.prepare('SELECT COUNT(*) c FROM wa_deliverables WHERE file_path = ?').get(inside) as { c: number }).c, 1, 'C3 根内成果行恰 1 条');

  // edit_file 两条真路径：根外编辑不建成果/不写版本；根内编辑仍写版本（不是把版本快照整条路关掉）
  const outEdit = JSON.parse(String(await tools.edit_file.execute({ filePath: outside, old_string: 'tmp', new_string: 'tmp2' })));
  ok(outEdit.ok === true, 'C3 根外编辑本身成功');
  eq((db.prepare('SELECT COUNT(*) c FROM wa_deliverables WHERE file_path = ?').get(outside) as { c: number }).c, 0, 'C3 根外编辑不建成果行');
  eq((db.prepare('SELECT COUNT(*) c FROM wa_deliverable_versions WHERE file_path = ?').get(outside) as { c: number }).c, 0, 'C3 根外编辑不写版本行');

  const inEdit = JSON.parse(String(await tools.edit_file.execute({ filePath: inside, old_string: 'root', new_string: 'root2' })));
  ok(inEdit.ok === true, 'C3 根内编辑本身成功');
  const verRows = (db.prepare('SELECT COUNT(*) c FROM wa_deliverable_versions WHERE file_path = ?').get(inside) as { c: number }).c;
  ok(verRows >= 1, 'C3 根内编辑仍写版本行（证明不是整条版本快照被关掉）', `rows=${verRows}`);

  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`  FAIL C3 未捕获异常 — ${(e as Error)?.message ?? String(e)}`);
  console.log('\n0 passed, 1 failed');
  process.exit(1);
});
