/**
 * zx_20261112_2 B1 M5：**跨机派发真 E2E**（验收入口，不随桌面打包）。
 *
 * 目的：证明「桌面建单 → ANS 选点 → 对端领活执行 → 回传收口」在**真实 ANS + 真实第二个节点**上跑通，
 *   而不是只在纯函数里自证。用生产同一套模块与同一处事实组装（`buildCreatedTaskDispatchFacts`），不另写判据。
 *
 * 前置：
 *   1. ANS 在 :27183 起好（`pnpm dev:ans`）。
 *   2. 第二个节点已起（见同目录 `headless-node.ts`，独立 data 目录）：
 *      `WA_DATA_DIR=data/_e2e_node apps/worker-ant-desktop/node_modules/.bin/tsx scripts/headless-node.ts \
 *         --data-dir data/_e2e_node --name wa-e2e --duration 300 --work`
 *
 * 用法：`apps/worker-ant-desktop/node_modules/.bin/tsx scripts/e2e_zx_20261112_2.ts`
 *
 * 退出码：0 = 派发成功且对端真建了任务、本地已收口（终态 completed/failed 均算收口）；
 *   1 = 任一步没成立（如实说哪一步，不把"派到了"冒充"跑成了"）。
 *
 * ⚠ 会往真 `data/worker-ant-server.db` 写入一条临时任务，结束前删除；`node.auto_dispatch_on_create` 复原。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initDatabase } from '../apps/worker-ant-desktop/src/main/database.js';
import { NODE_SETTING_KEYS, readNodeSetting, writeNodeSetting } from '../apps/worker-ant-desktop/src/main/core/node-identity.js';
import { makeAnsDispatchIo } from '../apps/worker-ant-desktop/src/main/core/node-dispatch-io.js';
import { driveRemoteSubtasks } from '../apps/worker-ant-desktop/src/main/core/node-remote-driver.js';
import { fetchNodes } from '../apps/worker-ant-desktop/src/main/core/node-list.js';
import {
  buildCreatedTaskDispatchFacts,
  dispatchCreatedTask,
  persistDispatchDecision,
} from '../apps/worker-ant-desktop/src/main/core/collab-dispatch.js';
import { routeCategoryForTask } from '../apps/worker-ant-desktop/src/main/core/task-routing.js';

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');
const remoteDbPath = path.join(dataDir, '_e2e_node', 'worker-ant-server.db');
const TITLE = '调研 2026 年主流向量数据库的选型';
const DESC = '对比 3 个方案，各一句优缺点，给出一页结论。';

function readSetting(db: DatabaseSync, key: string): string | null {
  try {
    const r = db.prepare('SELECT value FROM wa_settings WHERE key = ?').get(key) as { value?: string } | undefined;
    return r?.value ?? null;
  } catch { return null; }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function main(): Promise<void> {
  if (!fs.existsSync(remoteDbPath)) {
    console.error(`[e2e] 找不到第二节点库：${remoteDbPath}\n先按文件头启动 headless-node.ts`);
    process.exit(1);
  }
  const db = initDatabase(dataDir);
  const oldAuto = readSetting(db as never, NODE_SETTING_KEYS.autoDispatchOnCreate);
  const oldPart = readSetting(db as never, NODE_SETTING_KEYS.participate);
  const oldReason = readSetting(db as never, NODE_SETTING_KEYS.participateOffReason);
  let taskId = '';
  const evidence: Record<string, unknown> = { at: new Date().toISOString(), title: TITLE };

  try {
    // 1) 本机参与/角色：派发只需要 role=primary|observer + 已入网；参与态不影响"派出去"。
    writeNodeSetting(db as never, NODE_SETTING_KEYS.autoDispatchOnCreate, '1');

    // 2) 选一个有工作目录的项目（正例：任务不需要本机目录 ⇒ 应放行）。
    const proj = db.prepare(
      "SELECT id, name, working_dir FROM wa_projects WHERE status = 'active' AND trim(COALESCE(working_dir,'')) <> '' ORDER BY created_at DESC LIMIT 1",
    ).get() as { id: string; name: string; working_dir: string } | undefined;
    if (!proj) { console.error('[e2e] 没有带工作目录的 active 项目，无法验证"任务级"判据'); process.exit(1); }
    evidence.project = { id: proj.id, name: proj.name };
    evidence.projectHasWorkingDir = true;
    evidence.category = routeCategoryForTask(TITLE, DESC);

    // 3) 建一条临时任务（与真实建单同一形状）。
    taskId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO wa_tasks (id, project_id, title, description, priority, status, context_json) VALUES (?, ?, ?, ?, 1, 'pending', ?)",
    ).run(taskId, proj.id, TITLE, DESC, JSON.stringify({ source: 'e2e_zx_20261112_2' }));
    evidence.taskId = taskId;

    // 4) 生产同一处事实组装 → 派发。
    const facts = buildCreatedTaskDispatchFacts(db, {
      taskId, title: TITLE, description: DESC, hasAttachments: false, decomposed: false, projectId: proj.id,
    });
    evidence.facts = {
      settingOn: facts.settingOn, autoDispatchSource: facts.autoDispatchSource,
      teamUnlocked: facts.teamUnlocked, enrolled: facts.enrolled,
      needsLocalWorkspace: facts.needsLocalWorkspace, category: facts.category,
    };
    const outcome = await dispatchCreatedTask(db, { id: taskId, title: TITLE, description: DESC }, facts);
    persistDispatchDecision(db, taskId, outcome);
    evidence.dispatch = outcome;
    console.log(`[e2e] 派发结果：${JSON.stringify(outcome)}`);
    if (!outcome.ok) {
      console.error('[e2e] 派发未成立——见上（常见：对端未上线/卡类目不含 research/本机角色非 primary）');
      process.exitCode = 1;
      return;
    }

    // 5) 等对端建任务 + 本地收口。
    const dispatchIo = makeAnsDispatchIo(db as never);
    const localId = readNodeSetting(db as never, NODE_SETTING_KEYS.id) ?? '';
    let remoteSeen = false;
    let localStatus = 'pending';
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      if (!remoteSeen) {
        try {
          const rdb = new DatabaseSync(remoteDbPath, { readOnly: true });
          const row = rdb.prepare('SELECT id, title, status FROM wa_tasks WHERE title LIKE ? ORDER BY created_at DESC LIMIT 1').get(`%向量数据库%`) as { id?: string; title?: string; status?: string } | undefined;
          rdb.close();
          if (row?.id) { remoteSeen = true; evidence.remoteTask = row; }
        } catch { /* 对端库正被写，下一拍再试 */ }
      }
      await driveRemoteSubtasks(db as never, {
        io: dispatchIo,
        listLedger: () => fetchNodes(db as never, localId),
      });
      const t = db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(taskId) as { status?: string } | undefined;
      localStatus = t?.status ?? 'pending';
      if (localStatus === 'completed' || localStatus === 'failed' || localStatus === 'archived') break;
      await sleep(3000);
    }
    evidence.remoteTaskSeen = remoteSeen;
    evidence.localStatus = localStatus;
    const t2 = db.prepare('SELECT status, context_json FROM wa_tasks WHERE id = ?').get(taskId) as { status?: string; context_json?: string } | undefined;
    try { evidence.dispatchDecision = JSON.parse(t2?.context_json ?? '{}').dispatch_decision ?? null; } catch { /* 坏 JSON 如实不填 */ }
    console.log(`[e2e] 对端建任务=${remoteSeen} 本地终态=${localStatus}`);

    fs.mkdirSync(path.join(dataDir), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'baseline_zx_20261112_2.json'), JSON.stringify(evidence, null, 2));
    console.log(`[e2e] 证据已落 data/baseline_zx_20261112_2.json`);

    const ok = remoteSeen && (localStatus === 'completed' || localStatus === 'failed');
    if (!ok) { console.error('[e2e] 未达成端到端收口（对端没建任务，或本地未走到终态）'); process.exitCode = 1; }
  } finally {
    // 6) 清理：删除本次临时任务与其对话/成果，复原设置。
    try {
      if (taskId) {
        const run = (sql: string) => { try { db.prepare(sql).run(taskId); } catch { /* 表/行可能不存在 */ } };
        run('DELETE FROM wa_task_conversations WHERE task_id = ?');
        run('DELETE FROM wa_task_conversations WHERE task_id IN (SELECT id FROM wa_tasks WHERE parent_task_id = ?)');
        run('DELETE FROM wa_deliverables WHERE task_id = ?');
        run('DELETE FROM wa_deliverables WHERE task_id IN (SELECT id FROM wa_tasks WHERE parent_task_id = ?)');
        run('DELETE FROM wa_tasks WHERE parent_task_id = ?');
        run('DELETE FROM wa_tasks WHERE id = ?');
      }
      if (oldAuto === null) db.prepare('DELETE FROM wa_settings WHERE key = ?').run(NODE_SETTING_KEYS.autoDispatchOnCreate);
      else writeNodeSetting(db as never, NODE_SETTING_KEYS.autoDispatchOnCreate, oldAuto);
      if (oldPart === null) db.prepare('DELETE FROM wa_settings WHERE key = ?').run(NODE_SETTING_KEYS.participate);
      else writeNodeSetting(db as never, NODE_SETTING_KEYS.participate, oldPart);
      if (oldReason === null) db.prepare('DELETE FROM wa_settings WHERE key = ?').run(NODE_SETTING_KEYS.participateOffReason);
      else writeNodeSetting(db as never, NODE_SETTING_KEYS.participateOffReason, oldReason);
    } catch (e) { console.warn('[e2e] 清理失败（需人工核）：', (e as Error)?.message); }
    db.close();
  }
}

main().catch((e: unknown) => {
  console.error('[e2e] 未捕获异常：', e);
  process.exit(1);
});
