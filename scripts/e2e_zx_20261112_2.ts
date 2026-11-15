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
// zx_20261115_2 M3：E2E 也必须像生产那样**落事件台账**——否则 `hasTaskEvent` 恒假，
//   回执永远只能到 `self-reported`（真机首次跑通就是这么暴露的）。桌面启动块同一跳：`setEventStore`。
import { eventBus } from '../apps/worker-ant-desktop/src/main/core/event-bus.js';
import { EventStore } from '../apps/worker-ant-desktop/src/main/core/event-store.js';
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
// zx_20261115_2 M3：收口判据抽到纯函数——只认 completed + 回执 verified + 产出清单；`failed` 不再算通过。
import { judgeRelayE2E } from './lib/e2e-judge.js';

const root = path.join(__dirname, '..');
// zx_20261115_2 M3：**本地库可隔离**——若用户真开着桌面（其调度器会认领 data/ 里的 pending 任务），
//   E2E 用 `E2E_DATA_DIR` 指向一份真库副本，自己跑、不跟桌面抢同一张表。
const evidenceDir = path.join(root, 'data');
const dbDir = process.env.E2E_DATA_DIR ? path.resolve(process.env.E2E_DATA_DIR) : evidenceDir;
const remoteDbPath = path.join(
  process.env.E2E_REMOTE_DIR ? path.resolve(process.env.E2E_REMOTE_DIR) : path.join(evidenceDir, '_e2e_node'),
  'worker-ant-server.db',
);
// zx_20261115_2 M3：`E2E_SIMPLE=1` 走"一句话可完成、必落一个文件"的小题面（验证成功收口）；
//   缺省保留原研究题面（验证有界终止：即便跑不完也会在树时窗前收口）。
const SIMPLE = process.env.E2E_SIMPLE === '1';
const TITLE = SIMPLE ? '调研一句话结论：向量数据库与关系数据库的核心差异' : '调研 2026 年主流向量数据库的选型';
// ⚠ 题面**不得**出现"工作目录/文件/目录/写入/仓库"等 REPO_BOUND_TOKENS（会判"需本机工作目录"而拒派），
//   但又要模型真落一个交付物（否则回执缺 outputs）。折中：点名一个具体文件名（不是通用"文件/目录"词）。
const DESC = SIMPLE
  // 真机已验证：这条调研题在远端跑出 quality=80、单根不拆解、约 2–3 分钟完成。
  // 但模型是随机的——只在对话里答/只写文件不登记产出（真标本 outputs=0）。
  // 故把**工具调用次序**写成显式清单（三个工具名都不在 REPO_BOUND_TOKENS 里）。
  ? '对比缓存与会话存储两种场景下 Redis 与 PostgreSQL 的取舍，给出三点可执行的选型结论。\n'
    + '完成前必须按顺序调用：① write_file 把结论写入 relay-ok.md；'
    + '② register_deliverable 登记 relay-ok.md（type=doc）；③ finalize_task。'
    + '缺少第②步不要 finalize。'
  : '对比 3 个方案，各一句优缺点，给出一页结论。';
const ACCEPTANCE = SIMPLE ? 'relay-ok.md 存在，且包含三点可执行的选型结论。' : '';
const REMOTE_MARKER = '%向量数据库%';

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
  const db = initDatabase(dbDir);
  // 与 `main/index.ts` 启动块同跳：事件总线挂上 EventStore，派发/收口事件才真落 `wa_event_log`。
  eventBus.setEventStore(new EventStore(db as never));
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
      "INSERT INTO wa_tasks (id, project_id, title, description, acceptance_criteria, priority, status, context_json) VALUES (?, ?, ?, ?, ?, 1, 'pending', ?)",
    ).run(taskId, proj.id, TITLE, DESC, ACCEPTANCE, JSON.stringify({ source: 'e2e_zx_20261112_2' }));
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
    // zx_20261115_2 M3：**指定第二节点**——ANS 自动选可能选中本机（本机也入网且参与），
    //   而本机没有起中转消费者，活会等到超时。目标 id 从第二节点自己的库读（不是手写常量）。
    let targetNodeId = '';
    try {
      const rdb = new DatabaseSync(remoteDbPath, { readOnly: true });
      targetNodeId = String((rdb.prepare("SELECT value FROM wa_settings WHERE key = 'node.id'").get() as { value?: string } | undefined)?.value ?? '');
      // zx_20261115_2 M3：清掉上一轮留在中转项目里的同名交付件——否则模型读到旧文件就不写/不登记，
      //   回执缺 outputs（真标本：连续三次 outputs=0，模型直接 read_file 了上一轮的 relay-ok.md）。
      const wd = String((rdb.prepare("SELECT working_dir FROM wa_projects WHERE name LIKE 'AI 终端中转%' LIMIT 1").get() as { working_dir?: string } | undefined)?.working_dir ?? '');
      if (wd) { try { fs.rmSync(path.join(wd, 'relay-ok.md'), { force: true }); } catch { /* 清不掉不影响派发 */ } }
      rdb.close();
    } catch { targetNodeId = ''; }
    evidence.targetNodeId = targetNodeId || null;
    // 注入同一个 eventBus 出口（与 `main/index.ts` 同源）：确保派发事件真落 `wa_event_log`，
    //   否则 `hasTaskEvent` 拿不到痕，回执永远只能到 `self-reported`。
    const outcome = await dispatchCreatedTask(db, { id: taskId, title: TITLE, description: DESC }, facts, {
      emit: (type, data) => eventBus.emit(type, data as Record<string, unknown>),
      ...(targetNodeId ? { targetNodeId } : {}),
    });
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
    // zx_20261115_1 M6：等待窗口可配。研究类任务在真机上要拆解 + 跑数分钟，300s 常不够；
    //   缺省仍是 300s（不改变既有行为），端到端验证用 `E2E_WAIT_MS` 放宽。
    const waitMs = Number(process.env.E2E_WAIT_MS ?? 300_000);
    const deadline = Date.now() + (Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 300_000);
    while (Date.now() < deadline) {
      if (!remoteSeen) {
        try {
          const rdb = new DatabaseSync(remoteDbPath, { readOnly: true });
          const row = rdb.prepare('SELECT id, title, status FROM wa_tasks WHERE title LIKE ? ORDER BY created_at DESC LIMIT 1').get(REMOTE_MARKER) as { id?: string; title?: string; status?: string } | undefined;
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
    let localCtx: Record<string, unknown> = {};
    try { const parsed = JSON.parse(t2?.context_json ?? '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) localCtx = parsed as Record<string, unknown>; } catch { /* 坏 JSON 如实不填 */ }
    evidence.dispatchDecision = localCtx.dispatch_decision ?? null;
    // zx_20261115_2 M3：回执与产出清单从本机落账的 `remote_result` 读（与 node-remote-driver 同源）。
    const remoteResult = localCtx.remote_result && typeof localCtx.remote_result === 'object' && !Array.isArray(localCtx.remote_result)
      ? localCtx.remote_result as Record<string, unknown> : null;
    const receipt = remoteResult?.receipt && typeof remoteResult.receipt === 'object' && !Array.isArray(remoteResult.receipt)
      ? remoteResult.receipt as Record<string, unknown> : null;
    const outputs = Array.isArray(remoteResult?.outputs) ? remoteResult.outputs as unknown[] : null;
    const receiptVerdict = typeof receipt?.verdict === 'string' ? String(receipt.verdict) : null;
    const judgement = judgeRelayE2E({ remoteSeen, localStatus, receiptVerdict, outputs });
    evidence.remoteReceipt = receipt;
    evidence.outputsCount = outputs ? outputs.length : 0;
    evidence.judgement = judgement;
    console.log(`[e2e] 对端建任务=${remoteSeen} 本地终态=${localStatus} 回执=${receiptVerdict ?? '无'} 产出=${outputs ? outputs.length : 0} 判据=${judgement.ok ? '通过' : '未通过'}`);

    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'baseline_zx_20261112_2.json'), JSON.stringify(evidence, null, 2));
    fs.writeFileSync(path.join(evidenceDir, 'baseline_zx_20261115_2_e2e.json'), JSON.stringify(evidence, null, 2));
    console.log(`[e2e] 证据已落 data/baseline_zx_20261112_2.json 与 data/baseline_zx_20261115_2_e2e.json`);

    if (!judgement.ok) {
      console.error(`[e2e] 未达成成功收口：${judgement.reasons.join('；')}`);
      process.exitCode = 1;
    }
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
