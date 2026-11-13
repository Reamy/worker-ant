/**
 * zx_20261108_1 B8（老子·自知者明 / 维特根斯坦·意义即用法）:
 * **最小无头节点**——第二台机器上的工蚁节点（不起 GUI，只做注册 / 心跳 / 领活 / 回传）。
 *
 * 为什么复用生产模块而不另写一条执行路：注册（`node-heartbeat`）、中转消费（`node-request-worker`）、
 *   执行器（`node-request-runner`）、网络出口（`ans-signed-request`）在生产里都**只有一处实现**；
 *   无头入口只负责"把库打开、把凭据给它、把三条循环接起来"，不重写任何判据。
 *
 * 用法（宿主机或容器内）：
 *   ANS_SERVER_URL=http://host.docker.internal:27183 \
 *   ANS_API_KEY=<用户级 key> ANS_SECRET_KEY=<secret> \
 *   WA_DATA_DIR=/data WA_NODE_NAME=wa-docker-linux \
 *   apps/worker-ant-desktop/node_modules/.bin/tsx scripts/headless-node.ts --duration 180
 *
 *   参数：--data-dir <路径>  --name <节点名>  --duration <秒>  --heartbeat-sec <秒>  --once  --work
 *
 *   `--work`：额外起本机引擎的**最小作业消费**（`TaskScheduler` + `registerAiTaskHandlers`）。
 *     不加它，中继任务只会被 `enqueueJob` 落成 pending 作业、无人消费（`job-enqueuer` 头注释：
 *     裸插作业要等重启恢复）——"领回来却跑不了"不是路，如实要么不领、要么真能跑。
 *
 * 退出码：0 = 已在 ANS 注册且至少一次心跳成功；1 = 未注册或心跳一次都没成（如实，不冒充成功）；2 = 参数错误。
 *
 * ⚠ 这是**验收/测试入口**（放 `scripts/`，不随桌面打包）。它直接调 `enrollWithToken`，
 *   绕过了 GUI 的 Team 闸（`nodes:ipc` 那一跳）——闸是产品面，不是注册机制本身；本轮只用它验跨机闭环。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase } from '../apps/worker-ant-desktop/src/main/database.js';
import { NODE_SETTING_KEYS, ensureNodeIdentity, writeNodeSetting } from '../apps/worker-ant-desktop/src/main/core/node-identity.js';
import {
  collectNodeEnv,
  enrollWithToken,
  isNodeEnrolled,
  makeAnsHeartbeatSend,
  nodeEnrollmentReason,
  requestEnrollmentToken,
  startNodeHeartbeat,
} from '../apps/worker-ant-desktop/src/main/core/node-heartbeat.js';
import { startNodeRequestWorker } from '../apps/worker-ant-desktop/src/main/core/node-request-worker.js';
import { makeAnsRequestIo } from '../apps/worker-ant-desktop/src/main/core/node-request-io.js';
import { makeRelayRunner } from '../apps/worker-ant-desktop/src/main/core/node-request-runner.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dataDir = arg('data-dir') ?? process.env.WA_DATA_DIR ?? path.join(process.cwd(), 'data-headless');
const durationSec = Number(arg('duration') ?? 120);
const heartbeatSec = Number(arg('heartbeat-sec') ?? 6);
const nodeName = arg('name') ?? process.env.WA_NODE_NAME ?? '';
const once = process.argv.includes('--once');
const work = process.argv.includes('--work');
if (!Number.isFinite(durationSec) || durationSec < 0 || !Number.isFinite(heartbeatSec) || heartbeatSec < 1) {
  console.error('参数错误：--duration 需 ≥0，--heartbeat-sec 需 ≥1');
  process.exit(2);
}

async function main(): Promise<void> {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = initDatabase(dataDir);
  // 生产模块只认"能 prepare 的最小库接口"；better-sqlite3 的 Database 形状兼容。
  const settingDb = db as unknown as Parameters<typeof isNodeEnrolled>[0];

  // 顺序有讲究：`ensureNodeIdentity` 在 identity 不存在时会把 name 写成 hostname，
  // 先写 name 会被它覆盖——故先让身份落定，再覆盖名字。
  ensureNodeIdentity(settingDb);
  if (nodeName.trim()) writeNodeSetting(settingDb, NODE_SETTING_KEYS.name, nodeName.trim());
  const identity = ensureNodeIdentity(settingDb);
  console.log(`[headless] 数据目录 ${dataDir}`);
  console.log(`[headless] node.id=${identity.id}  name=${identity.name}  platform=${os.platform()}  arch=${os.arch()}`);

  if (!isNodeEnrolled(settingDb)) {
    const tok = await requestEnrollmentToken(settingDb, { timeoutMs: 10_000 });
    console.log(`[headless] 申请注册令牌：${tok.ok ? 'ok' : `失败 — ${tok.note}`}`);
    if (!tok.ok) {
      console.error(`[headless] 无法取到注册令牌（判据=${nodeEnrollmentReason(settingDb)}）`);
      db.close();
      process.exit(1);
    }
    const res = await enrollWithToken(settingDb, { timeoutMs: 20_000 });
    console.log(
      `[headless] 注册：${res.enrolled ? `ok  resource_group=${res.resourceGroup ?? '?'}` : `未成 — ${res.reason}`}`,
    );
  }
  if (!isNodeEnrolled(settingDb)) {
    console.error(`[headless] 未入网（判据=${nodeEnrollmentReason(settingDb)}）——不冒充在线`);
    db.close();
    process.exit(1);
  }

  // --work：起最小作业消费。**必须先于 worker.poll()** 装好入队闸——`makeRelayRunner` 建任务后调
  //   `enqueueJob`，而 `enqueueJob` 只在注入了 `scheduler.enqueue` 时才进内存队列（否则裸插等重启）。
  let stopWork: (() => void) | null = null;
  if (work) {
    const { TaskScheduler } = await import('../apps/worker-ant-desktop/src/main/core/task-scheduler.js');
    const { registerAiTaskHandlers } = await import('../apps/worker-ant-desktop/src/main/core/jobs/ai-task.js');
    const { setJobEnqueuer } = await import('../apps/worker-ant-desktop/src/main/core/job-enqueuer.js');
    const { resolveAnsCreds } = await import('../apps/worker-ant-desktop/src/main/core/ans-signed-request.js');
    const { AnsClient } = await import('@worker-ant/ans-client');
    const creds = resolveAnsCreds(db as unknown as Parameters<typeof resolveAnsCreds>[0]);
    const ansClient = new AnsClient({ serverUrl: creds.baseUrl, apiKey: creds.apiKey, secretKey: creds.secretKey });
    const scheduler = new TaskScheduler(db as never);
    setJobEnqueuer((type, payload) => scheduler.enqueue(type, payload));
    registerAiTaskHandlers(
      { db: db as never, dataDir, getAnsClient: async () => ansClient as never },
      scheduler as never,
    );
    scheduler.start();
    stopWork = () => scheduler.stop();
    console.log('[headless] 作业消费已启动（scheduler + ai-task）');
  }

  let okTicks = 0;
  let lastError = '';
  const events: string[] = [];
  const worker = startNodeRequestWorker({
    nodeId: ensureNodeIdentity(settingDb).id,
    io: makeAnsRequestIo(db),
    runner: makeRelayRunner({ db }),
    onEvent: (e) => {
      const line = `${e.type} request=${e.requestId ?? '-'} category=${e.category ?? '-'} status=${e.status ?? '-'}`;
      events.push(line);
      console.log(`[headless] 事件 ${line}`);
    },
  });

  const heartbeat = startNodeHeartbeat(settingDb, {
    send: makeAnsHeartbeatSend(settingDb),
    intervalSec: heartbeatSec,
    onTick: (info) => {
      if (info.ok) okTicks++;
      else lastError = info.state.lastError ?? 'unknown';
      // 与生产同拍：心跳结束后拉一轮中转待办（worker 自带 busy 闸，不重入）。
      void worker.poll();
    },
  });

  if (once) {
    await heartbeat.tick();
  } else {
    await new Promise<void>((r) => setTimeout(r, durationSec * 1000));
  }
  heartbeat.stop();
  stopWork?.();

  const env = collectNodeEnv(settingDb);
  console.log(
    `[headless] 汇总 ${JSON.stringify({
      node_id: ensureNodeIdentity(settingDb).id,
      platform: env.platform,
      arch: env.arch,
      cpu_count: env.cpu_count,
      total_mem_mb: Math.round(env.total_mem / 1024 / 1024),
      disk_free_gb: env.disk_free === null ? null : Math.round((env.disk_free / 1024 ** 3) * 10) / 10,
      heartbeat_ok_ticks: okTicks,
      heartbeat_failures: lastError ? { lastError } : 0,
      request_events: events,
    })}`,
  );

  db.close();
  process.exit(okTicks > 0 ? 0 : 1);
}

void main();
