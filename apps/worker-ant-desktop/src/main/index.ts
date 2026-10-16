import { app, BrowserWindow, shell, dialog, powerSaveBlocker, Notification } from 'electron';
import path from 'path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import { createTray, destroyTray, updateTrayStatus, updateTrayPresence, setTrayRunningMenu, updateTrayImUnread, updateTrayOutboxDead } from './tray.js';
import { setImUnreadSink, refreshImUnread } from './core/im/im-unread.js';
import { imChannelEnabledSql } from './core/im/im-channel-status.js';
import { registerIpcHandlers, setAnsDb } from './ipc-handlers.js';
import { initAuthIpc } from './ipc/auth.ipc.js';
import { initProjectIpc, stopAllRuntimeProcesses } from './ipc/project.ipc.js';
import { initImIpc, stopAllImAdapters } from './ipc/im.ipc.js';
import { initAdminIpc, initSkillIpc, initMemoryIpc } from './ipc/admin.ipc.js';
import { initLicenseIpc } from './ipc/license.ipc.js';
import { initAnsIpc } from './ipc/ans.ipc.js';
// zx_20261005 M14: 首启引导 IPC（`setup:state`）——判"要不要弹安装向导"从 localStorage 标志改为**按状态**。
import { initSetupIpc } from './ipc/setup.ipc.js';
import { initNodesIpc } from './ipc/nodes.ipc.js';
import { initDevicesIpc } from './ipc/devices.ipc.js';
import { initExternalIpc, type InboundControl, type InboundStatusPayload } from './ipc/external.ipc.js';
// zx_20261014_4 批三（管子·度量衡 / 道德经·善闭无关楗而不可开）: 「门」的**能力面 + 起停控制面**。
//   ⚠ 一律**静态**引入：`device-registry` / `tools/device` / `external-terminals` 本已在模块图内
//     （经 `devices.ipc.ts` / `external.ipc.ts` 静态引），`inbound-gate` 只多一个 `node:http`。
//     起停那一跳在此（装配层），不在 IPC 层——IPC 只做"翻译 + 软闸"（见 `external.ipc.ts` 头注释）。
import {
  startInboundGate, stopInboundGate, isInboundRunning, inboundRunningPort, inboundLastError,
} from './core/inbound-gate.js';
import { createPairingPort, buildPairNotice, type PairingPort } from './core/external-terminals.js';
import { pushImOwnerNotice } from './core/im/im-notify.js';
import { createExternalCapabilityPort } from './core/external-calls.js';
import { listDevices, resolveDeviceByName, type DeviceControlOutcome } from './core/device-registry.js';
import { deviceCallName } from './core/device-name.js';
import { runDeviceControl, defaultDeviceControl } from './core/tools/device.js';
import { ensureNodeIdentity } from './core/node-identity.js';
// zx_20261010_1 M3: 起心跳/中转的可注入 starter（注册成功后可再调 ⇒ 免重启即时生效）。
import { setNodeRuntimeStarter } from './core/node-runtime.js';
// zx_20261005 M22: Team 档软闸（仅类型；运行时判据在启动块内动态 import，见下）。
import type { TeamGate } from './core/team-gate.js';
// zx_20261012：仅类型引用「为何未入网」枚举（真源在 `node-heartbeat.ts`），打包期擦除。
import type { NodeEnrollmentReason } from './core/node-heartbeat.js';
import { eventBus } from './core/event-bus.js';
import { boolSetting, readBoolSetting, normalizeBooleanSettingValues } from './core/settings-bool.js';
import { EventStore } from './core/event-store.js';
import { registerProjectors } from './core/event-projectors.js';
import { TaskScheduler } from './core/task-scheduler.js';
import { setJobEnqueuer, enqueueJob } from './core/job-enqueuer.js';
import { registerAiTaskHandlers } from './core/jobs/ai-task.js';
import { registerAllJobs } from './core/jobs/index.js';
import { MemoryManager } from './core/memory-manager.js';
import { registerOAuthProtocol, onOAuthCallback, openOAuthInBrowser } from './auth-oauth.js';
import { initAutoUpdater, startPeriodicUpdateCheck } from './auto-updater.js';
import { initResilience, markShuttingDown } from './resilience.js';
import { flushLoggersSync } from './core/logger.js';
import { initDatabase } from './database.js';
import { setAnsRuntimeMode } from './core/ans-signed-request.js';
import { startupSelfCheck } from './core/architectural-invariants.js';
import { rebuildPendingApprovalsOnStartup, registerPendingApproval } from './services/im-router.js';
import { formatOptions } from './core/im/options.js';
import type Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
// zx_20261005 M16: 把"构建形态"灌进 ANS 身份解析（生产不得内置 dev-key/dev-secret）。
//   在**任何** `resolveAnsCreds` 之前设一次——此处是 main 模块顶层，早于下文所有调用点。
setAnsRuntimeMode(isDev);
// 数据目录：开发阶段复用现有 data/ 目录，发布后使用 userData
const dataDir = isDev
  ? path.resolve(__dirname, '..', '..', '..', '..', 'data')
  : app.getPath('userData');
// zx_20261005 M21: 仓库根（dev 下 ANS 源码与 tsx 的落点基准）。
// zx_20261006 M3: 改由 `findRepoRoot`（按 `pnpm-workspace.yaml` 上溯）**一处真源**派生——
//   原先此处手写四级、而 `ipc/ans.ipc.ts` 因层级不同干脆没传（用户手点「一键拉起」恒 `no-entry`）。

// 通知目录契约：所有子进程（cron 脚本 / 守护进程 / IM 命令）通过该环境变量
// 将推送 .txt 写入 F3 监听目录，否则 Python 脚本会落到错误的默认路径导致推送丢失
process.env.NOTIFICATION_PAYLOAD_DIR = path.join(dataDir, 'notification_payloads');

// cron 心跳文件：位于 NOTIFICATION_PAYLOAD_DIR 的上级 data 目录，
// 供 A股项目的 alert_dashboard 守护进程判断 cron 是否存活（心跳 30 分钟内=存活）。
// 每次 cron_run_command 执行后更新 last_fire，否则守护进程会误判 cron 不存活而反复兜底。
const CRON_HEARTBEAT_FILE = path.join(dataDir, 'cron_heartbeat.json');

function writeCronHeartbeat(projectId: string, cronExpression: string, success: boolean): void {
  try {
    fs.writeFileSync(CRON_HEARTBEAT_FILE, JSON.stringify({
      project_id: projectId,
      cron_expression: cronExpression,
      last_fire: new Date().toISOString(),
      success,
    }));
  } catch (e) {
    console.error('[Cron] 心跳写入失败:', (e as Error).message);
  }
}

let db: Database.Database | null = null;
let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let _scheduler: TaskScheduler | null = null;
// zx_20261004 M2: 节点心跳句柄（停止时清定时器；失败态由 `getState()` 供面板/诊断取用）。
let _nodeHeartbeat: { stop(): void } | null = null;
// zx_20261004 M12: 中转队列消费者（**不自起时钟**——由心跳 `onTick` 每跳驱动一轮，见下面的接线）。
let _nodeRequestWorker: { poll(): Promise<number> } | null = null;

// zx_20261011 M7: 集中登记本进程创建的周期/延迟定时器，退出时一并清除。
// 起因：`stopCore()` 是 async，其间事件循环仍在跑；未清的定时器到点触发并写日志，撞上随退出
// 收摊的 pino transport worker ⇒ `ThreadStream.write` 同步抛"未捕获异常"噪音（且末几行日志会丢）。
const shutdownTimers: NodeJS.Timeout[] = [];
function trackShutdownTimer<T extends NodeJS.Timeout>(t: T): T {
  shutdownTimers.push(t);
  return t;
}

async function startCore(): Promise<void> {
  console.log('[工蚁] 核心引擎已就绪（单进程 IPC 模式）');
  updateTrayStatus('running');
}

async function stopCore(): Promise<void> {
  updateTrayStatus('stopped');
  // zx_20261011 M7: **先清定时器**——再往下任何 await 都会让事件循环跑到到点的回调，
  //   而此刻 logger 的 worker 可能已收摊（写日志即抛）。清在最前，把"到点触发"的可能掐断。
  for (const t of shutdownTimers) { try { clearInterval(t); } catch { /* 已清/无效句柄，忽略 */ } }
  shutdownTimers.length = 0;
  // zx_20261005 M21: 回收**本进程拉起的** ANS（用户自配的服务不动）。
  try { const { stopManagedAns } = await import('./core/ans-supervisor.js'); if (stopManagedAns()) console.log('[工蚁] 已回收本机托管的 ANS'); } catch { /* 未托管/已退出 */ }
  // zx_20261014_4 批一: 关**入站门**（有界关闭；未起/已关为幂等空操作）。
  try { stopInboundGate(); } catch { /* 未起/已关 */ }
  // zx_20261016_1 批一: 关**控制路径**的 MQTT 连接（修复前恒不关停 ⇒ broker 侧连接数不回落）。
  try { const { closeMqttClients } = await import('./core/device-mqtt.js'); closeMqttClients(); } catch { /* 未装/已关 */ }
  await stopAllImAdapters();
  stopAllRuntimeProcesses();
  try { const { stopSelfHealingMonitor } = await import('./core/self-healing-monitor.js'); stopSelfHealingMonitor(); } catch {}
  if (_nodeHeartbeat) { _nodeHeartbeat.stop(); _nodeHeartbeat = null; }
  if (_scheduler) { _scheduler.stop(); _scheduler = null; }
  if (db) {
    db.close();
    db = null;
    console.log('[工蚁] 数据库已关闭');
  }
}


function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: '工蚁',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.on("console-message", (_e, level, msg) => console.log("[renderer:" + level + "]", msg));
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => { console.error("[工蚁] 页面加载失败:", desc, url); });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.loadURL(`file://${path.join(__dirname, '..', '..', 'renderer', 'dist', 'index.html')}`);
  } else {
    mainWindow.loadURL(`file://${path.join(__dirname, '..', '..', 'renderer', 'dist', 'index.html')}`);
  }

  // 关闭窗口时隐藏到托盘，而不是退出
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 单实例锁（Windows/Linux OAuth 协议处理需要）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, _argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  // 阻止 macOS App Nap 节流：Electron GUI 应用窗口不可见时，App Nap 会节流 main 进程的
  // 长 setTimeout，导致 node-cron（基于 setTimeout 调度）的 cron 定时任务不触发，
  // 盘前/午间/盘后推送随之失效。powerSaveBlocker 阻止应用挂起，保证定时器持续运行。
  powerSaveBlocker.start('prevent-app-suspension');

  // 初始化数据库（单进程架构核心）
  try {
    db = initDatabase(dataDir);
  } catch (err) {
    console.error('[工蚁] 数据库初始化失败:', err);
    dialog.showErrorBox('启动失败', `数据库初始化失败:\n${(err as Error).message}`);
    app.quit();
    return;
  }

  setAnsDb(db);
  registerIpcHandlers();
  initAuthIpc(db);
  // A1 (2026-08-31): memory 声明提前，供 initProjectIpc 语义模板匹配懒加载
  let memory: MemoryManager | undefined;
  initProjectIpc(db, dataDir, () => memory);
  // zx_20260930 M5: 传 `memory` 的惰性取用（与上一行 `initProjectIpc` 同形）——本行执行时它尚未构造。
  initImIpc(db, dataDir, () => memory);
  // zx_20260930 M14-3: 真健康自检的三个外部世界——心跳文件路径、调度器活体（**惰性取用**：
  //   本行执行时 `_scheduler` 尚未构造，与上一行 `initImIpc` 传 `() => memory` 同形）、磁盘量取卷。
  initAdminIpc(db, { heartbeatFile: CRON_HEARTBEAT_FILE, getScheduler: () => _scheduler, dataDir });
  // zx_20261005 M8: 许可 IPC（license:status / license:activate / app:version）——激活走验签落库，
  //   不经通用 settings:set（那条路能塞坏 key 绕过校验）。
  initLicenseIpc(db);
  // zx_20261005 M21（K-11）：ANS 端口/托管 IPC（缺省地址真源 + 状态 + 显式拉起/停止）。
  initAnsIpc(db);
  // zx_20261005 M14: 首启引导状态（`setup:state`）——渲染层据此判是否拦到安装向导。
  // zx_20261012_1 批四: 增传 `dataDir`——示例项目载入要落盘（工作目录 + `task_outputs/`）。
  initSetupIpc(db, dataDir);
  // A3 (2026-09-03): 通知中心 IPC（list/unread/markRead/markAllRead + 角标刷新）
  const { initNotificationsIpc } = await import('./ipc/notifications.ipc.js');
  initNotificationsIpc(db);
  // zx_20261004 M4/M5/M6: 协同面板 IPC（nodes:list / nodes:update / nodes:card）。
  initNodesIpc(db);
  // zx_20261004 M9/M10: 设备面板 IPC（devices:list / discover / stop / authorize / control）。
  //   ⚠ 只注册**出口**，不起发现——起发现是用户显式动作（面板按钮），见 devices.ipc.ts 头注释。
  initDevicesIpc(db);
  // zx_20261014_4 批三（管子·度量衡 / 道德经·善闭无关楗而不可开 / 罗尔斯·无知之幕）: 「门」的
  //   **起停控制面**——启动那一跳（`teamGate.unlocked` 之后）与用户开关那一跳（`external:setInbound`）
  //   **共用这一条路**（`applyInboundDoor`），不各写一份起停次序。
  //   ⚠ "真起、真停"= 既写库（`node.external_inbound`）又真开/关 socket——只写库=重启才生效（名实不符）。
  //   ⚠ 能力面的**设备传动**在此装配（`createExternalCapabilityPort` 的 `controlDevice`）——"按名解析成
  //     哪台设备"由装配层决定（复用 `resolveDeviceByName`），`core/external-calls.ts` 不掺和台账语义。
  const applyInboundDoor = async (enabled: boolean): Promise<{ started: boolean; reason: string; port: number }> => {
    if (!enabled) { stopInboundGate(); return { started: false, reason: 'disabled', port: 0 }; }
    const identity = ensureNodeIdentity(db!);
    const capability = createExternalCapabilityPort(db!, {
      listDevices: () => listDevices(db!),
      controlDevice: async (inner): Promise<DeviceControlOutcome> => {
        // 「按名使唤」的解析移交装配层（工具/面板/门**同一把尺**：`resolveDeviceByName`）。
        //   解析失败**如实回**（含歧义时并列候选），**不猜**、**不落设备审计**（没有可挂靠的设备 id）——
        //   与 `tools/device.ts` 的 `resolveOrError` 同纪律；门的留痕仍由 `external-calls` 记下这一笔。
        let deviceId = (inner.deviceId ?? '').trim();
        if (!deviceId) {
          const key = (inner.name ?? '').trim();
          if (!key) {
            return { ok: false, denied: true, reason: 'unknown_device', deviceId: '', action: inner.action,
              error: '须提供 deviceId 或 name', how_to_authorize: '先用 capabilities 取设备清单，再按 call_name 指定一台。' };
          }
          const r = resolveDeviceByName(db!, key);
          if (!r.ok) {
            const how = r.reason === 'ambiguous'
              ? `「${key}」匹配到多台设备，无法确定是哪一台——请改用 deviceId：${r.candidates.map((c) => `${deviceCallName(c)}（${c.id}）`).join('、')}`
              : `设备不存在：${key}（先用 capabilities 取设备清单核对名/id）`;
            return { ok: false, denied: true, reason: r.reason === 'ambiguous' ? 'ambiguous_device' : 'unknown_device',
              deviceId: '', action: inner.action, error: `控制被拒（${r.reason}）`, how_to_authorize: how };
          }
          deviceId = r.device.id;
        }
        // 编排（闸 K-6 → 传动 → 审计 → 状态 → 事件）**只此一份**（`runDeviceControl`）——门不另写次序。
        // zx_20261016_2: 把**发起者**如实带下去（`external:<terminal_id>`）——留痕才答得出"这台终端按的"。
        return runDeviceControl(db!, {
          deviceId, action: inner.action, args: inner.args,
          actor: { kind: 'external', ref: inner.terminalId ?? '' },
        }, defaultDeviceControl);
      },
    });
    // zx_20261016_1 批二（王阳明·知行合一 / 维特根斯坦·意义即用法）: 配对申请**推得到人**——
    //   门开了就得**有人应声**（用户不在电脑前，也能在 IM 里把机器人放进来，kickoff §四 场景第③步）。
    //   病根：`createPairRequest` 是唯一新申请入口却**零通知**（面板只能靠 5 秒轮询，离开电脑就批不了）。
    //   治法：`requestPair` 之外**旁挂**一跳推送——**非阻塞、不阻断配对**（机器人照常轮询 `pair/status`），
    //   失败**不静默**（`pushImOwnerNotice` 自带日志 + 失败落 `wa_im_outbox` 补发账）。
    const basePairing = createPairingPort(db!);
    const pairing: PairingPort = {
      ...basePairing,
      requestPair: (name, remoteAddr) => {
        const r = basePairing.requestPair(name, remoteAddr);
        void pushImOwnerNotice(db!, buildPairNotice({ name, pairCode: r.pairCode }), 'external_pairing')
          .catch((e: unknown) => console.error('[工蚁] 配对申请推送失败：', (e as Error).message));
        return r;
      },
    };
    const res = startInboundGate({
      enabled: true,
      nodeName: () => identity.name,
      agentVersion: app.getVersion(),
      pairing,
      capability,
    });
    return res;
  };

  /** 门的实况——`enabled` 是**用户意图**（库值），`running` 是**真在监听**；二者皆如实，不互相推断。 */
  const inboundStatus = (): InboundStatusPayload => {
    const running = isInboundRunning();
    const lastErr = inboundLastError();
    return {
      enabled: readBoolSetting(db!, 'node.external_inbound'),
      running,
      port: running ? inboundRunningPort() : null,
      detail: running
        ? `入站门已开（监听 :${inboundRunningPort()}）——局域网内可被 AI 终端发现与配对。`
        : lastErr
          ? `入站门未开：${lastErr}`
          : '入站门已关（node.external_inbound=false）。',
    };
  };

  // zx_20261014_4 批二/批三: 外部终端 IPC——配对人侧（listPending/list/approve/reject/revoke）+ 门态/开关/留痕。
  //   ⚠ 只注册出口，**不**把凭据回给渲染层——凭据只从门端点直发终端（见 external.ipc.ts 头注释）。
  initExternalIpc(db, {
    status: inboundStatus,
    setEnabled: async (on: boolean) => {
      // 真起/真停 + 写库（**同一事务语义**：先落库再起停 ⇒ 起不来时库值仍如实反映用户意图）。
      db!.prepare('INSERT OR REPLACE INTO wa_settings (key,value,updated_at) VALUES (?,?,datetime(\'now\'))')
        .run('node.external_inbound', on ? 'true' : 'false');
      const res = await applyInboundDoor(on);
      console.log(res.started
        ? `[工蚁] 入站门已开（监听 :${res.port}）——局域网内可被 AI 终端发现与配对`
        : `[工蚁] 入站门${on ? `未开（${res.reason}）` : '已关'}`);
      return inboundStatus();
    },
  } satisfies InboundControl);

  // A1 事件溯源：持久化事件到 wa_event_log + 状态投影
  eventBus.setEventStore(new EventStore(db));
  registerProjectors(db, eventBus);

  // 任务调度器：启动 Job 消费 + Cron + 超时检测
  const scheduler = new TaskScheduler(db);
  _scheduler = scheduler;

  // zx_20261004 M2(K-9 令牌自助注册 / K-5 一节点一 key): 本机若配了 `node.enrollment_token` 且尚未注册
  //   ⇒ 令牌换 key 并**写回 `ans_api_key`/`ans_secret_key`**。必须排在下面读取身份三元组之前——
  //   下面 `resolveAnsCreds(db)` 的落点就是这两键，晚一步则本 session 仍以缺省身份出场（K-5 名存实亡）。
  //   超时有界(5s)：未配令牌时此调用不触网、立即返回；配了令牌而 ANS 不可达时最多拖 5s 启动，不阻断。
  // zx_20261005 M22（Team 档软闸 / 管子·度量衡）: **多机协同**（注册 / 心跳 / 中转消费）仅 **Team 档或试用期**启用。
  //   判据**只此一处**（`core/team-gate.ts`）——锁定即本机**不注册为节点、不心跳、不消费中转**（＝「停用」）；
  //   面板仍可见并提示升级（见 PeersPage）。此处算一次，下面心跳块复用同一结果。
  let teamGate: TeamGate | null = null;
  let nodeKeyUpgraded = false;
  // zx_20261010 M7（维特根斯坦·意义即使用）: 「档位解锁」≠「已是这个协作网络的一员」——本机**已注册**
  //   是起心跳/中转的**第二道闸**（判据 `isNodeEnrolled`，与 `ensureNodeEnrolled` 同源）。二者各管一件事。
  let nodeEnrolled = false;
  // zx_20261012: 未入网的**首因**（`nodeEnrollmentReason`）——供下面如实说清"为什么没起心跳/中转"。
  let nodeEnrollReason: NodeEnrollmentReason | null = null;
  try {
    const { resolveTeamGate } = await import('./core/team-gate.js');
    teamGate = resolveTeamGate(db);
    if (teamGate.unlocked) {
      const { ensureNodeEnrolled, isNodeEnrolled, nodeEnrollmentReason } = await import('./core/node-heartbeat.js');
      const enrollRes = await ensureNodeEnrolled(db, { timeoutMs: 5000 });
      // zx_20261004 §4 #7：注册成功即"共享默认 key 已换成节点专属 key"。此刻通知服务尚未装配
      //   （`setupTaskNativeNotifications` 在其后），故只记下事实，待装配完成后补发一次提示（见下）。
      if (enrollRes.keyUpgraded) nodeKeyUpgraded = true;
      // 注册成败/早已注册**一律以此判据为准**（`enrollRes.enrolled` 区分不出"本次注册成功"与"早注册过"，
      //   两者都该放行；未注册才拦）。
      nodeEnrolled = isNodeEnrolled(db);
      nodeEnrollReason = nodeEnrollmentReason(db);
    } else {
      console.log(`[工蚁] 多机协同未启用（${teamGate.tierLabel}）——跳过节点注册`);
    }
  } catch (e) { console.warn('[工蚁] 节点自助注册跳过:', (e as Error).message); }

  // zx_20261014_4 批一/批三（道德经·善闭无关楗而不可开 / 罗尔斯·无知之幕 / 管子·度量衡）: **入站门**——
  //   让局域网里别的 AI 终端**找得到**本机、**认得清**它是什么、**进得来**（而**默认关**）。开关
  //   `node.external_inbound` 在 `database.ts` **显式** seed `'false'`（`boolSetting` 缺省即开 ⇒ 不 seed
  //   即等于敞着门）。三道闸**皆过**才起：① 用户开关（默认关）；② **Team 档位**（`external_terminal`
  //   属 Team 档，批三新增——未解锁即不起，与心跳/中转同一把尺）；③ 端口监听本身。
  //   起不来**如实记因**（照 ANS 代起 M2 纪律），不假装在跑；关停挂在 `stopCore`（before-quit 路径）。
  //   ⚠ 排在档位解析**之后**（复用同一结果 `teamGate`，不重算第二遍——一处真源）。
  //     此处**不**复写那个调用形状：`rr_zx_20261005_team` 的 M22-11 按**原文**数它在 `index.ts` 的出现次数，
  //     注释里再写一遍会把它数成"算了两次"（承 G-5：静态判据读原文，去注释在本仓是静默毁伤）。
  try {
    if (!readBoolSetting(db!, 'node.external_inbound')) {
      console.log('[工蚁] 入站门默认关闭（node.external_inbound=false）');
    } else if (!teamGate?.unlocked) {
      console.log(`[工蚁] 入站门未开（「外部终端接入」属团队版能力，当前为${teamGate?.tierLabel ?? '未知档位'}）`);
    } else {
      const res = await applyInboundDoor(true);
      console.log(res.started
        ? `[工蚁] 入站门已开（监听 :${res.port}）——局域网内可被 AI 终端发现与配对`
        : `[工蚁] 入站门未开（${res.reason}）`);
    }
  } catch (e) { console.warn('[工蚁] 入站门跳过:', (e as Error).message); }

  // zx_20261011_1 M1（承 C2/M6 许可闸）: **启动期参与对账一次**——许可若在离线期间过期，
  //   本机可能仍挂着 `participate=1` 被 ANS 继续派单（闸虚）。此处按**生效参与**（许可 ∧ 用户设置）
  //   核一次：不一致则 PATCH ANS 报 `participate:false` 并镜像本地。best-effort、**不阻断启动**（不 await）。
  //   ⚠ 无条件跑（不受上面 `teamGate.unlocked` 分支所限）——"许可已锁但此前注册过"正是要治的形态。
  try {
    const { reconcileNodeParticipation } = await import('./core/node-heartbeat.js');
    void reconcileNodeParticipation(db);
  } catch (e) { console.warn('[工蚁] 参与对账跳过:', (e as Error).message); }

  // zx_20261009 M1（道德经·善闭无关楗而不可开 / 维特根斯坦·意义即使用）: 打包版首启时本机无任何可用凭据
  //   ⇒ 桌面到 ANS 的签名请求**必 401**（用户所见 `Invalid API key`）。此处**在构建任何 ANS 客户端之前**
  //   为本机铸一对"自己人"凭据并落库——此后 `resolveAnsCreds` 一处真源**同时**喂客户端与代起子进程（M2 下发）。
  //   两道闸：① dev 吃 dev-key（非空 ⇒ 不铸，dev 的通道仍是 `.env`）；② 用户把 ANS 配到**远端**时绝不铸
  //   （随机 key 远端不认，且会顶掉"未配置⇒安装向导"语义）。**先于客户端构造**，故不留"先建的客户端拿空凭据"窗口。
  try {
    const { resolveAnsCreds, ansCredentialsConfigured } = await import('./core/ans-signed-request.js');
    const { isLocalUrl } = await import('./core/ans-supervisor.js');
    const { mintLocalAnsCreds } = await import('./core/ans-local-creds.js');
    const curCreds = resolveAnsCreds(db);
    if (!ansCredentialsConfigured(curCreds) && isLocalUrl(curCreds.baseUrl)) {
      const pair = mintLocalAnsCreds(db, { apiKey: curCreds.apiKey, secretKey: curCreds.secretKey });
      if (pair.minted) {
        console.log(pair.persisted
          ? '[工蚁] 已为本机 ANS 铸一对专属凭据（首启自举：客户端与代起子进程自此同源）'
          : '[工蚁] 已为本机 ANS 铸凭据但**落库失败**——本次代起子进程拿得到，客户端下轮仍读不到（查 wa_settings 写权限）');
      }
    }
  } catch (e) { console.warn('[工蚁] 本机 ANS 凭据自举跳过:', (e as Error).message); }

  // Phase 1: 初始化 ANS 客户端 + 记忆管理器（ai-task 强化反馈 + 后台作业共用）
  let ansClientForJobs: import('@worker-ant/ans-client').AnsClient | undefined;
  try {
    const { AnsClient } = await import('@worker-ant/ans-client');
    // zx_20260930 M9: 身份三元组取 `resolveAnsCreds` **一处真源**（DB `wa_settings` → env → 缺省）。
    //   此前本处手抄了一遍（缺省又是三个字面量），`registerToAns` / `ipc-handlers.getAnsClient` 各再抄一遍。
    const { resolveAnsCreds } = await import('./core/ans-signed-request.js');
    const jobsCreds = resolveAnsCreds(db);
    const ac = new AnsClient({ serverUrl: jobsCreds.baseUrl, apiKey: jobsCreds.apiKey, secretKey: jobsCreds.secretKey });
    ansClientForJobs = ac as unknown as import('@worker-ant/ans-client').AnsClient;
    memory = new MemoryManager(db, ansClientForJobs);
    // Phase A (2026-08-26): 加载已批准的记忆衍生技能到 skill-registry + 注册技能审批 IPC
    if (memory) {
      initSkillIpc(db, memory);
      initMemoryIpc(db, memory);
      try { await memory.loadSkillsFromDb(); } catch (e) { console.warn('[工蚁] 已批准技能加载跳过:', (e as Error).message); }
    }
  } catch (e) { console.warn('[工蚁] ANS/Memory初始化跳过:', (e as Error).message); }

  // zx_20261005 M21（K-11 / ③）：ANS 托管——本地且不可达且开关开 ⇒ 代起（**不阻塞启动**）。
  //   ① 用户在设置里把 ANS 配到远端时**绝不代起**（`isLocalUrl` 把关）；
  //   ② 打包版未随包提供 ANS 入口 ⇒ 如实回 `no-entry`，不假装托管；
  //   ③ `WA_ANS_AUTOSTART=0` 全局急停（rr/CI 用，防回归期误拉）。
  // zx_20261009 M3：打包版**随包带了 ANS 依赖闭包**（`Resources/ans-server/`，见 `scripts/stage-ans-runtime.mjs`）
  //   ⇒ 走 `ELECTRON_RUN_AS_NODE=1 process.execPath` 那条路（原生模块即 Electron ABI，与包内自洽）。
  //   cwd 按 ANS 既有约定摆位：`<userData>/ans/apps` ⇒ 其数据/日志/插件安装目录落在 `<userData>/data/**`。
  void (async () => {
    try {
      const { resolveAnsCreds } = await import('./core/ans-signed-request.js');
      const { ensureAnsStarted, findRepoRoot } = await import('./core/ans-supervisor.js');
      const packagedEntry = path.join(process.resourcesPath, 'ans-server', 'dist', 'index.js');
      const res = await ensureAnsStarted(resolveAnsCreds(db!), {
        isDev,
        repoRoot: findRepoRoot(__dirname) ?? undefined,
        packaged: app.isPackaged && fs.existsSync(packagedEntry)
          ? {
            entry: packagedEntry,
            cwd: path.join(app.getPath('userData'), 'ans', 'apps'),
            workerDataDir: path.join(app.getPath('userData'), 'worker-ant-data'),
          }
          : undefined,
        autoStart: readBoolSetting(db!, 'ans_auto_start'),
      });
      if (res.started && res.reachable) console.log('[工蚁] ANS 已由本机托管拉起');
      // zx_20261006 M2：把"启动即死"如实说清并给出**出路**——原实现只留一句 20s 后的
      //   `start-timeout`（听着像"慢"，实为"已死"），用户无从知道该做什么。
      // zx_20261009 M5：加"秒退且无遗言"这一形态后，此因属**疑似**（非 ABI 的秒退也可能落入）⇒ 如实标注形态，不把话说死。
      else if (res.reason === 'native-abi-mismatch')
        console.warn('[工蚁] ANS 未能由本机托管：**疑似 ABI 不符**（better-sqlite3 若为 Electron ABI，系统 node 加载不了）。\n'
          + (res.stderrTail?.trim()
            ? `        进程遗言：${res.stderrTail.trim().split('\n')[0]}\n`
            : '        进程秒退且无输出（原生模块加载即被信号终止的典型形态）。\n')
          + '        ⇒ 另开一个终端先跑 `pnpm dev:ans`（会把它重建回 Node.js ABI 并起 ANS），再启动桌面端。');
      else if (res.reason === 'child-exited')
        console.warn(`[工蚁] ANS 托管进程启动即退出：${res.stderrTail?.trim().split('\n')[0] || '(无输出)'}`);
      else if (!res.reachable && res.reason !== 'remote') console.log(`[工蚁] ANS 未就绪（${res.reason}）`);
    } catch (e) { console.warn('[工蚁] ANS 托管跳过:', (e as Error).message); }
  })();

  // zx_20260909 Y1/Y2b(空性·如实): IM 回话统一推送——供任务完成/失败通知与"超长运行一次在场回话"共用(同一会话路由)。
  // zx_20260909_1 M1(A2 空性·假名/毛选·群众路线): 目标解析抽到 core/im/im-notify.ts(通知目标=任务创建人,
  //  不再向任务无关渠道"最近发言路人"广播); im.notify_to_creator=false 回落旧全渠道行为。
  const pushImCompletion = async (taskId: string, _projectId: string, message: string): Promise<void> => {
    if (!db) return;
    try {
      const { pushImNotify } = await import('./core/im/im-notify.js');
      await pushImNotify(db, taskId, message);
    } catch { /* 完成/进度回话失败不阻断 */ }
  };

  registerAiTaskHandlers({
    db,
    dataDir,
    memory,
    getAnsClient: async () => {
      if (!db) throw new Error('DB not initialized');
      const { AnsClient } = await import('@worker-ant/ans-client');
      // zx_20260930 M9: 身份三元组取 `resolveAnsCreds` **一处真源**（DB `wa_settings` → env → 缺省）。
      //   此前本处手抄了一遍同样的顺序，`registerToAns` 又抄一遍（且 secret 缺省写成 `''`）——
      //   同一件事三处各写，任一处漏读 `ans_secret_key` 就那一路恒 401 且看不出为什么。
      const { resolveAnsCreds } = await import('./core/ans-signed-request.js');
      const { baseUrl: url, apiKey: key, secretKey: secret } = resolveAnsCreds(db);
      const client = new AnsClient({ serverUrl: url, apiKey: key, secretKey: secret });
      return client as unknown as { getOptimalModel: (params: Record<string, unknown>) => Promise<Record<string, unknown>> };
    },
    sendImNotification: (taskId: string, projectId: string, message: string) => pushImCompletion(taskId, projectId, message),
    // zx_20260924 M5: 完成时推主成果文件（只推来源会话；无来源会话不推，由 pushPrimaryDeliverables 内部如实记因）。
    sendImPrimaryDeliverables: (taskId: string) => {
      if (!db) return;
      void import('./core/im/im-notify.js')
        .then(({ pushPrimaryDeliverables }) => pushPrimaryDeliverables(db!, taskId))
        .catch(() => { /* 推件失败不阻断 */ });
    },
    sendImAskUser: async ({ channel, toUser, question, taskId, options }: { channel: string; toUser: string; question: string; taskId: string; options?: string[] }) => {
      if (!db) return;
      try {
        // 查找启用中的渠道。M2-1: 优先"该任务自身渠道 + 该用户确在此渠道有过会话"的那一个，
        // 无则回落旧行为(按类型 LIMIT 1)——同类型多渠道路由到别人那条时，问谁、补发去哪都跟着错。
        // M6：口径＝「启用中」（同 core/im/im-channel-status.ts）——旧谓词只认健康态，
        // degraded/error/pending 渠道会被整条排除，问询**连 outbox 都不落**（静默丢）。
        const ch = (db.prepare(
          `SELECT c.id FROM wa_im_channels c WHERE c.channel_type = ? AND ${imChannelEnabledSql('c')} AND EXISTS (SELECT 1 FROM wa_im_conversations v WHERE v.channel_id = c.id AND v.external_user_id = ?) LIMIT 1`
        ).get(channel, toUser) ?? db.prepare(`SELECT id FROM wa_im_channels WHERE channel_type = ? AND ${imChannelEnabledSql()} LIMIT 1`).get(channel)) as { id: string } | undefined;
        if (!ch) return;
        // zx_20260911_2 M1(维特根斯坦·语言游戏 / 王阳明·知行合一): 登记审批队列——此前只发消息不登记，
        // 运行中队列恒空 ⇒ 用户回「是」/选项时无审批可命中(病根①)。登记在前、发送在后，避免快回复先到。
        // 选项登记取自**结构化 options**（调用方的真源），不从展示文案反推：question 入参是发出去的 IM 文案
        // （`[待回复] …\n选项: A / B`，无方括号），parseOptions 只会把前言与首选项熔成一段 ⇒ 选项匹配失效。
        const pid = (db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(taskId) as { project_id: string } | undefined)?.project_id || '';
        registerPendingApproval(channel, toUser, {
          taskId, projectId: pid, question,
          options: options && options.length ? formatOptions(options) : undefined,
          createdAt: Date.now(),
        });
        // M2-1(海德格尔·上手状态 / 王阳明·知行合一): 接住发送结果——此前返回值被丢弃，
        // 发送失败时会同时留下「审批已登记」与「问句没到」(用户永远等不到、也无处可查)。
        // 失败即落**既有** outbox 补发账(kind='ask_user')，接进 A3 短窗补发这条老路。
        const { sendImCompletionNotice } = await import('./ipc/im.ipc.js');
        const r = await sendImCompletionNotice(ch.id, toUser, taskId, question);
        if (!r.ok) {
          const { enqueueImOutbox } = await import('./core/im/im-outbox.js');
          // M3: 真原因一并入账（无适配器 / 适配器抛错各自的真实原因）
          enqueueImOutbox(db, { channelId: ch.id, externalUserId: toUser, taskId, kind: 'ask_user', message: question }, r.error);
        }
      } catch {}
    },
  }, scheduler);
  scheduler.start();

  // zx_20260909_1 M3(C1 一次性回填): 存量已验收任务的真实 doc 回填 per-doc 验收位(wa_settings 迁移标记守护, 仅首启一次)
  try {
    const { backfillDocAcceptanceVerified } = await import('./core/deliverable-lifecycle.js');
    backfillDocAcceptanceVerified(db);
  } catch { /* 回填失败不阻断启动 */ }

  // zx_20260911_4 D5④(实践论·如实归位): 存量"已 completed 但带陈旧标记而永停 draft"的 doc 一次性归位
  // (migration.doc_promote_stale_marker 守护, 仅首启一次; 复用既有判据, 不写第二套 SQL)
  try {
    const { backfillStaleMarkerDocPromotion } = await import('./core/deliverable-lifecycle.js');
    backfillStaleMarkerDocPromotion(db);
  } catch { /* 回填失败不阻断启动 */ }

  // zx_20260920_1 M3(面三·判据 C8): 存量"父任务已 completed 而自身仍 draft"的 doc 一次性归位
  // (migration.doc_promote_human_completed 守护, 仅首启一次; 复用同一判据 promoteTaskFileDeliverables)
  try {
    const { backfillHumanCompletedDocPromotion } = await import('./core/deliverable-lifecycle.js');
    backfillHumanCompletedDocPromotion(db);
  } catch { /* 回填失败不阻断启动 */ }

  // zx_20260910_3 M3(G3 名实相符): 布尔 setting 库值规范化——'0'→'false' / '1'→'true' 同义改写，
  // 使"关"在库里只有一种写法(与 boolSetting 口径一致)。迁移标记守护，仅首启一次；失败不阻断启动。
  try {
    normalizeBooleanSettingValues(db as unknown as Parameters<typeof normalizeBooleanSettingValues>[0]);
  } catch { /* 规范化失败不阻断启动 */ }

  // zx_20260907 M5 修(2026-09-08): 注入 GUI「执行」即时派发回调——task:updateStatus('running') 经此入内存队列
  // 立即执行(此前裸插 DB 作业只能等重启恢复,且 executeTask CAS 不认 running → 任务假"运行中"不执行)
  try {
    const { setTaskRunEnqueuer, setResumeEnqueuer } = await import('./ipc/project.ipc.js');
    setTaskRunEnqueuer((taskId, projectId) => scheduler.enqueue('ai-task', { taskId, projectId }));
    // zx_20260908 实机复核修: resume/respond/inject 恢复作业同样入内存队列即时执行(此前裸插 DB 无人消费)
    // zx_20260915 P0-5(c): 载荷（含 `initiator:'user'`）由 project.ipc 构造，此处只负责"投递"——
    //   非用户路（调度器/D1/cron/重试六条）不传 `initiator`，由处理器取缺省 `'system'`，守卫据此区分两种恢复。
    setResumeEnqueuer((payload) => scheduler.enqueue('resume-ai-task', payload));
  } catch {}

  // zx_20260915 P0-5(a): 答复记账的事件出口注入（pause-settlement 保持零 electron 依赖，由装配处接线）
  try {
    const { setAnswerEmitter } = await import('./core/pause-settlement.js');
    setAnswerEmitter((type, data) => eventBus.emit(type, data));
  } catch {}

  // zx_20260914 M0.5-1: 作业入队的**一处真源**——抽 core/job-enqueuer.ts，全仓调用点一律改调它。
  // 此前 17 处绕过 enqueue 直接裸插 wa_jobs：内存队列只由 enqueue/启动恢复填充，故裸插作业在运行期
  // 一律不被消费（"IM 回了『已启动』、作业却躺着不动"、"自恢复一轮其实跑不起来"），只能等下次重启。
  // 该缺陷已被修过三次(zx_20260907 M5 / zx_20260908 实机复核 / zx_20260909 Z1)，每次只修一处、余者仍在。
  setJobEnqueuer((type, payload) => scheduler.enqueue(type, payload));

  // L2: 注册后台作业（embed-memory + background-review + consolidate-memories）
  if (memory && ansClientForJobs) {
    registerAllJobs({ db, ansClient: ansClientForJobs, scheduler, memory });
    console.log('[工蚁] 后台作业已注册 (embed-memory + background-review + consolidate)');
  }

  // zx_20261004 M2/M3(管子·势 / 老子·如实): 节点心跳——周期性把本机环境/忙闲如实上报 ANS。
  //   发送函数取 `makeAnsHeartbeatSend(db)`（签名请求唯一出路）；身份三元组**每跳重解析**，
  //   故上面自助注册写回的 key 自然被下一跳采纳（无需重启）。失败不静默：`ansFailureNote` 形状留痕。
  //
  // zx_20261004 M12（孙子·以逸待劳）: 中转队列消费者**与心跳同拍**——本机无监听端口，"被推"不可能，
  //   只能每跳顺手去 **拉**（`node-request-worker` 头注释）。`io`/`runner` 皆注入：真机 = `makeAnsRequestIo`
  //   （`ansSignedRequest` 唯一出路）+ `makeRelayRunner`（落本机内建任务）；回归喂假 ⇒ 不出网跑真逻辑。
  if (!teamGate?.unlocked) {
    // zx_20261005 M22（Team 档软闸）：锁定即**不心跳、不消费中转**（＝「停用」，见方案批六 M22）。
    console.log('[工蚁] 多机协同未启用——节点心跳/中转未启动');
  } else if (!nodeEnrolled) {
    // zx_20261010 M7：档位已解锁（试用/Team）但本机**未注册**（注册令牌无任何入口 ⇒ 干净 clone 恒如此）
    //   ⇒ 心跳必 404、中转必 403（每拍刷屏）。此处如实说清、**不起**这两条循环（不"参与一个自己没加入的网络"）。
    // zx_20261012：带上**首因**——`placeholder-credential` 即"本机 ANS 凭据仍是内置占位（非注册所得）"，
    //   正是"只闻 ANS 侧 403 告警、不见桌面侧原因"的那一类；此处给出一句可行动的诊断。
    console.log(`[工蚁] 多机协同已解锁，但本机尚未在 ANS 注册（原因：${nodeEnrollReason ?? '未知'}）——节点心跳/中转未启动`);
  } else {
    // zx_20261010_1 M3（维特根斯坦·意义即使用）: 起心跳/中转的那段收进下面具名 `startNodeRuntime()`，
    //   装配期注册为可注入 starter ⇒ `nodes:enroll` 注册成功后可**再调**它（免重启即时生效）。
    void startNodeRuntime();
  }

  // zx_20261010_1 M3: 注册 starter——`nodes:enroll` 注册成功后调 `startNodeRuntime()` 即起心跳/中转。
  //   幂等由 `startNodeRuntime` 自负（已在跑 ⇒ 直接 `true`，不起第二条循环）。函数声明提升，故此处先注册后定义无碍。
  setNodeRuntimeStarter(startNodeRuntime);

  /**
   * 起节点心跳 + 中转消费（zx_20261010_1 M3 从启动块内联段抽出，供启动期与注册成功期共用）。
   *   - **幂等**：已在跑（`_nodeHeartbeat`/`_nodeRequestWorker` 任一非空）⇒ 直接 `true`（不起第二条循环）。
   *   - **如实**：起不来 ⇒ `false`（不假装起了——"不知道"≠"起来了"）。
   * 具名函数声明**置于本闸块之后**：rr 受控回归对 `main/index.ts` 的文本序断言因此不受影响
   *   （档位闸 → 已注册闸 → 起心跳的先后次序仍成立）。
   */
  async function startNodeRuntime(): Promise<boolean> {
    if (!db) return false; // 无库 ⇒ 如实 false（兼收窄 `db`——`let` 的控制流收窄不进嵌套函数体）
    if (_nodeHeartbeat || _nodeRequestWorker) return true;
    try {
      const { startNodeHeartbeat, makeAnsHeartbeatSend } = await import('./core/node-heartbeat.js');
      const { ensureNodeIdentity } = await import('./core/node-identity.js');
      const { startNodeRequestWorker, nodeRequestEventToLog } = await import('./core/node-request-worker.js');
      const { makeAnsRequestIo } = await import('./core/node-request-io.js');
      const { makeRelayRunner } = await import('./core/node-request-runner.js');
      // zx_20261011_1 M4（双向澄清）: 同一份真 IO（拉待办/回传 + 提问/读答）**一份两用**——
      //   既喂 worker，又绑成 asker 供 `ask_user` 向上游提问（有界等待）。绑一次即够（io 无状态）。
      const requestIo = makeAnsRequestIo(db);
      // zx_20261011_4 M2: 跨机编排的右半场——读回"已外派他机"的本地子任务并收口（远端 done/error ⇒
      //   本地真变、父任务真恢复）。跑在**心跳同拍**（`onTick`）。`driverDb` 在闭包外先取：`db` 是模块级
      //   `let`，其非 null 收窄不进箭头函数体（承 `node-clarify` 那处的同一约束）。
      const { makeAnsDispatchIo } = await import('./core/node-dispatch-io.js');
      const { driveRemoteSubtasks } = await import('./core/node-remote-driver.js');
      // zx_20261011_4 M3: 跨机编排的**左半场**——本机并发占满时把溢出子任务**真派出去**（同拍）。
      const { driveOrchestration } = await import('./core/orchestrator.js');
      const dispatchIo = makeAnsDispatchIo(db);
      const driverDb = db;
      const { setRequestAsker, askRequester, resolveClarifyWaitMs } = await import('./core/node-clarify.js');
      // zx_20261011_2 M3: 等作答上限改由设置 `node.clarify_wait_sec` 解析（缺省 180s）——读口**一处真源**。
      //   ⚠ 在闭包**外**先求值：`db` 是模块级 `let`，其非 null 收窄不进箭头函数体（tsc 红）。
      const clarifyWaitMs = resolveClarifyWaitMs(db);
      setRequestAsker((id, question) => askRequester(id, question, { io: requestIo, timeoutMs: clarifyWaitMs }));
      // 到场/收口（M13）：入**不可变事件日志**（两件合看即这次调用的一生），面板据此刻画调用记录。
      _nodeRequestWorker = startNodeRequestWorker({
        nodeId: ensureNodeIdentity(db).id,
        io: requestIo,
        runner: makeRelayRunner({ db }),
        onEvent: (e) => {
          // ⚠ **不再手抄白名单**（M10 修）：整对象透传（唯剔 `type` 作落库键）——见 `nodeRequestEventToLog`。
          //   白名单会漏新增字段（M9 的 `requestPayload` 就漏了⇒B 端台账缺"派来的是什么"）。
          const { type, data } = nodeRequestEventToLog(e);
          void eventBus.emit(type, data);
        },
      });
      _nodeHeartbeat = startNodeHeartbeat(db, {
        send: makeAnsHeartbeatSend(db),
        // M4：每跳结束发**瞬态** `node.heartbeat`（仅内存，不落事件表——高频噪声）——协同面板据此
        //   在本机负载/成败变化的当口即时刷新，不必等下一拍 ANS 台账（`node.presence_changed` 只管档位）。
        onTick: (info) => {
          void eventBus.emitTransient('node.heartbeat', { nodeId: info.nodeId, ok: info.ok, dispatchFillRatio: info.env.dispatch_fill_ratio, cpuUsagePercent: info.env.cpu_usage_percent, jobsRunning: info.env.jobs_running, lastError: info.state.lastError });
          // M12: 与心跳同拍拉一轮（worker 自带 `busy` 闸——慢执行时下一跳直接返回，不重入；**不 await**，
          //   免得一件长活把心跳本身的节拍也拖住）。
          void _nodeRequestWorker?.poll();
          // zx_20261011_4 M2: 同拍读回"已外派他机"的子任务并收口（同一纪律：**不 await**，一件慢读不拖心跳）。
          void driveRemoteSubtasks(driverDb, { io: dispatchIo });
          // zx_20261011_4 M3: 同拍把"本机跑不过来"的溢出子任务派给对端（知止：本机有空位/未开开关 ⇒ 不派）。
          //   `readyTasks` 真源＝调度器的 `getReadyTasks`（就绪判据/排序与本地拉起**同一份**，不自写第二套）；
          //   `_scheduler` 是模块级 `let`，用 `?.` 取（未构造 ⇒ 空表 ⇒ 本拍不外派，不报错）。
          void driveOrchestration(driverDb, {
            io: dispatchIo,
            readyTasks: (projectId) => _scheduler?.getReadyTasks(projectId) ?? [],
          });
        },
      });
      console.log('[工蚁] 节点心跳已启动');
      return true;
    } catch (e) {
      console.warn('[工蚁] 节点心跳启动跳过:', (e as Error).message);
      return false;
    }
  }

  // Phase 3.1: 前瞻记忆时间型空闲周期扫描（每 60s，due_at 到期弹原生通知）
  if (memory) {
    const memoryRef = memory;
    trackShutdownTimer(setInterval(() => {
      try {
        const due = memoryRef.scanDueProspective(Date.now());
        for (const m of due) {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('task:event', { type: 'prospective.due', projectId: m.projectId, content: m.content });
          }
          if (Notification.isSupported()) {
            const n = new Notification({ title: '工蚁·前瞻记忆到期', body: m.content.slice(0, 100) });
            n.show();
          }
        }
      } catch (e) { /* 扫描失败不影响主流程 */ }
    }, 60_000));
  }

  // D1 (2026-09-04_2): 长任务心跳扫描——对 running 的 ai-task/resume 每 ~20s 发一次 task.heartbeat 瞬态
  // （离开任务详情也"知天下"：仍在推进·tokens·已运行时长；不入 wa_event_log，防日志洪泛）
  // zx_20260908 D1/D4: 同一扫描聚合「执行在场快照」广播 presence.update（running 数/最长/最近心跳/无推进 staleSec），
  // 供 AppLayout 全局在场条与 D4 僵尸"运行中"无推进反色（如实不假名：状态以 wa_tasks.updated_at 为心跳锚，reaper >10min 兜底失败）。
  let presenceHadTasks = false; // 场条清场：上次有在场任务、本次空 → 发空列表让 UI 收起（防残留已结束任务）
  // zx_20260909 Y2b(少则得·如实): 超长运行一次在场回话去重账——key=`${taskId}::${started_at}`, 每 run 至多一次; 有界防胀
  const longRunNotified = new Map<string, number>();
  trackShutdownTimer(setInterval(() => {
    if (!db) return;
    try {
      const running = db.prepare("SELECT payload, started_at FROM wa_jobs WHERE status = 'running' AND type IN ('ai-task','resume-ai-task')").all() as Array<{ payload: string; started_at: string | null }>;
      const now = Date.now();
      const presenceTasks: Array<{ taskId: string; projectId?: string; title: string; tokens: number; elapsedSec: number; staleSec: number; updatedAt: string | null }> = [];
      const presenceRunKeys: string[] = []; // 与 presenceTasks 对齐: 每项 job started_at, 供超长回话"每 run 一次"判重
      for (const j of running) {
        const payload = (() => { try { return JSON.parse(j.payload) as { taskId?: string; projectId?: string }; } catch { return {} as { taskId?: string; projectId?: string }; } })();
        const tid = payload.taskId;
        if (!tid) continue;
        const st = j.started_at ? new Date(j.started_at.replace(' ', 'T') + 'Z').getTime() : 0;
        if (!st || now - st < 20_000) continue;
        const elapsedSec = Math.floor((now - st) / 1000);
        const tok = db.prepare('SELECT COALESCE(SUM(token_count), 0) AS t FROM wa_task_conversations WHERE task_id = ?').get(tid) as { t: number };
        const tRow = db.prepare('SELECT title, updated_at FROM wa_tasks WHERE id = ?').get(tid) as { title: string; updated_at: string | null } | undefined;
        const title = tRow?.title || '';
        eventBus.emitTransient('task.heartbeat', { taskId: tid, task_id: tid, projectId: payload.projectId, title, tokens: tok.t, heartbeatElapsedSec: elapsedSec }).catch(() => {});
        const upMs = tRow?.updated_at ? new Date(tRow.updated_at.replace(' ', 'T') + 'Z').getTime() : 0;
        presenceTasks.push({ taskId: tid, projectId: payload.projectId, title, tokens: tok.t, elapsedSec, staleSec: upMs ? Math.max(0, Math.floor((now - upMs) / 1000)) : 0, updatedAt: tRow?.updated_at ?? null });
        presenceRunKeys.push(j.started_at || '');
      }
      // D1/D2 (2026-09-08_1 空性·如实呈现实时 / 事上磨练): 最小化/离页在场可见(窗口标题+托盘 tooltip 带运行数)
      // + 托盘运行任务菜单(直达/暂停, ⚠无推进红标)——收口上轮 D1 缺口, 不展开窗口亦可处置僵尸。
      try {
        const cfgMin = db.prepare("SELECT value FROM wa_settings WHERE key = 'ui.presence_minimize'").get() as { value?: string } | undefined;
        const cfgTray = db.prepare("SELECT value FROM wa_settings WHERE key = 'ui.tray_presence_menu'").get() as { value?: string } | undefined;
        const minimizeOn = boolSetting(cfgMin?.value);
        const trayMenuOn = boolSetting(cfgTray?.value);
        if (presenceTasks.length > 0) {
          if (minimizeOn && mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(`工蚁 · 执行中 ${presenceTasks.length}`);
          updateTrayPresence(minimizeOn ? presenceTasks.length : 0);
          if (trayMenuOn) {
            setTrayRunningMenu(presenceTasks.map((t) => ({ taskId: t.taskId, title: t.title || t.taskId.slice(0, 8), elapsedSec: t.elapsedSec, stale: t.staleSec > 120 })), {
              onNavigate: (taskId) => { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); mainWindow.webContents.send('notif:focus-task', { type: 'presence.navigate', taskId }); } },
              // zx_20260917 M1: 广播由 `interruptTask` 内的 `pauseTask` 发出（因由 `user_interrupt`）——
              //   此处原先"调用方自取 project_id 再补发 emit"（同 zx_20260910_1 M3 那类分家），现不再补。
              onPause: (taskId) => { try { if (!db) return; void (async () => { const { interruptTask } = await import('./core/agent-executor.js'); interruptTask(db, taskId); })(); } catch { /* 托盘暂停失败忽略 */ } },
            });
          }
        } else {
          if (mainWindow && !mainWindow.isDestroyed() && mainWindow.getTitle() !== '工蚁') mainWindow.setTitle('工蚁');
          updateTrayPresence(0);
          if (trayMenuOn) setTrayRunningMenu([]);
        }
      } catch { /* 标题/托盘在场更新失败不影响主流程 */ }
      // zx_20260909 Y2b(少则得·克制 / 空性·如实): 超长运行一次在场回话——仍在 wa_jobs running 的 ai-task/resume 运行 ≥
      // 阈值分钟且本 run 未回过 → 回一条"仍在执行"进度(每 run 至多一次); im.long_running_progress_min=0 关闭。
      try {
        const lpCfg = db.prepare("SELECT value FROM wa_settings WHERE key = 'im.long_running_progress_min'").get() as { value?: string } | undefined;
        const lpMin = Math.max(0, Number(lpCfg?.value ?? '15') || 0);
        if (lpMin > 0 && presenceTasks.length > 0) {
          for (let i = 0; i < presenceTasks.length; i++) {
            const p = presenceTasks[i];
            const key = `${p.taskId}::${presenceRunKeys[i] || ''}`;
            if (p.elapsedSec >= lpMin * 60 && !longRunNotified.has(key)) {
              longRunNotified.set(key, now);
              const mins = Math.floor(p.elapsedSec / 60);
              const ttl = p.title || p.taskId.slice(0, 8);
              void pushImCompletion(p.taskId, p.projectId || '', `⏳ 任务「${ttl}」仍在执行（已 ${mins} 分钟），完成或需你回复时会再通知。`);
            }
          }
          if (longRunNotified.size > 400) { const it = longRunNotified.keys(); while (longRunNotified.size > 200) longRunNotified.delete(it.next().value as string); }
        }
      } catch { /* 超长进度回话失败不影响主流程 */ }
      if (presenceTasks.length > 0) {
        eventBus.emitTransient('presence.update', { tasks: presenceTasks }).catch(() => {});
        presenceHadTasks = true;
      } else if (presenceHadTasks) {
        eventBus.emitTransient('presence.update', { tasks: [] }).catch(() => {});
        presenceHadTasks = false;
      }
    } catch { /* 扫描失败不影响主流程 */ }
  }, 20_000));

  // zx_20260904_7 优化① (2026-09-04): 张力自动调节周期扫描——对 active 项目的 autoAdjust 张力按规则移滑块（每 5 分钟）
  trackShutdownTimer(setInterval(() => {
    if (!db) return;
    try {
      const active = db.prepare("SELECT id FROM wa_projects WHERE status='active'").all() as Array<{ id: string }>;
      if (active.length === 0) return;
      void (async () => {
        const { evaluateAutoTensions } = await import('./core/tension-engine.js');
        for (const p of active) {
          try {
            const changes = evaluateAutoTensions(db, p.id);
            if (changes.length > 0) {
              console.log('[张力自动调节]', p.id.slice(0, 8), JSON.stringify(changes));
              // zx_20260905 批6 (2026-09-05): 张力自调结果实时回推 UI——此前仅 console.log，项目页策略/瓶颈为"死区"
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('task:event', { type: 'tension.auto_adjusted', projectId: p.id, changes });
              }
            }
          } catch { /* 单项目自动调节失败跳过 */ }
        }
      })();
    } catch { /* 张力自动调节失败不影响主流程 */ }
  }, 5 * 60 * 1000));

  // zx_20260912 M3(管子·度量衡 / 海德格尔·在场): 出站**最终未送达**(dead)——账不只躺在 IM 页里，
  //  不在 IM 页也要看得见(托盘 tooltip + 菜单项「出站未送达 N 条 →」，点击走既有 notif:focus-task 通道)。
  const onOpenOutbox = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
    mainWindow.webContents.send('notif:focus-task', { type: 'im.outbox' });
  };
  // 与补发扫描**同源同尺**(同一 outboxStats)：菜单/tooltip 的数字不是另算的一份。
  const reconcileOutboxDead = () => {
    if (!db) return;
    import('./core/im/im-outbox.js').then(({ outboxStats }) => {
      if (db) updateTrayOutboxDead(outboxStats(db).dead, onOpenOutbox);
    }).catch(() => {});
  };

  // zx_20260909_1 M2(A3 空性·无常 / 道德经·知止): IM 出站失败补发——每 20s 扫 wa_im_outbox 到期 pending 短窗退避重发
  // (im.outbox_retry_min 分钟窗口, 0=关; 次数有界默认 3、退避 1/2/4 min; 成功 sent/超窗超次 dead)。不碰 F3 文件目录契约。
  // zx_20260912 M3: 同一次 tick 顺带对账 dead 数；`min<=0` 关的是**补发**，不是**看得见**——仍对账。
  trackShutdownTimer(setInterval(() => {
    if (!db) return;
    try {
      const cfg = db.prepare("SELECT value FROM wa_settings WHERE key = 'im.outbox_retry_min'").get() as { value?: string } | undefined;
      const min = Math.max(0, Number(cfg?.value ?? '10') || 0);
      if (min > 0) {
        import('./core/im/im-outbox.js').then(({ retryImOutbox }) => retryImOutbox(db!, min)).catch(() => {});
      }
      reconcileOutboxDead();
    } catch { /* outbox 补发扫描失败不影响主流程 */ }
  }, 20_000));

  // 启动恢复：重建待审批队列（扫描 paused/failed + [等待用户输入]，1h内）
  try {
    rebuildPendingApprovalsOnStartup(db);
  } catch (e) { console.warn('[工蚁] 审批队列恢复跳过:', (e as Error).message); }

  // 架构不变量8项自检 + 简化审计 + 自愈监控（5s后，避免与启动竞争）
  trackShutdownTimer(setTimeout(() => {
    try { startupSelfCheck(db!); } catch (e) { console.warn('[工蚁] 架构自检失败:', (e as Error).message); }
    import('./core/simplification-audit.js').then(({ runSimplificationAudit }) => { try { runSimplificationAudit(db!); } catch (e) { console.warn('[工蚁] 简化审计失败:', (e as Error).message); } }).catch(() => {});
    import('./core/self-healing-monitor.js').then(({ startSelfHealingMonitor }) => { try { startSelfHealingMonitor(db!); } catch (e) { console.warn('[工蚁] 自愈监控启动失败:', (e as Error).message); } }).catch(() => {});
    import('./core/system-bootstrap.js').then(({ startPeriodicInvariantCheck }) => { try { trackShutdownTimer(startPeriodicInvariantCheck(db!)); } catch (e) { console.warn('[工蚁] 定期架构抽查启动失败:', (e as Error).message); } }).catch(() => {});
  }, 5000));

  // 注册活跃项目的 cron 定时作业（提取为可复用函数，供项目更新时重新注册）
  const runCronHandler = async (projectId: string) => {
    if (!db) return;
    // 重新读取项目最新配置（cron_run_command/cron_create_task 可能已更新）
    const projRow = db.prepare("SELECT status, context_json, working_dir, cron_schedule FROM wa_projects WHERE id = ?").get(projectId) as { status: string; context_json: string; working_dir: string; cron_schedule: string } | undefined;
    if (!projRow || projRow.status !== 'active') return;
    const ctxJson = JSON.parse(projRow.context_json || '{}');

    // FIX-B: 优先执行 cron_run_command（直接执行外部脚本，绕过 AI Agent）
    const runCmd = ctxJson.cron_run_command as string | undefined;
    if (runCmd) {
      try {
        // 先更新心跳（cron 已触发）——盘后 run_scheduled.py 长流程要跑 20+ 分钟，
        // 若只在执行完成后才写心跳，期间守护进程会误判「cron 不存活」而兜底重跑，导致重复推送。
        writeCronHeartbeat(projectId, projRow.cron_schedule || '', true);
        const { exec } = await import('node:child_process');
        // 用异步 exec（回调）而非 execSync：execSync 会同步阻塞主进程，cron 脚本
        // 卡住时（如盘前简报数据源/LLM 慢）直接导致界面假死。异步化后不阻塞事件循环。
        await new Promise<void>((resolve, reject) => {
          exec(runCmd, {
            cwd: projRow.working_dir || undefined,
            timeout: 30 * 60 * 1000,
            maxBuffer: 10 * 1024 * 1024,
            encoding: 'utf-8',
          }, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        console.log(`[Cron] cron_run_command 执行成功: ${runCmd.slice(0, 80)}`);
        // 更新 cron 心跳，让 A股守护进程识别 cron 存活，避免误判兜底
        writeCronHeartbeat(projectId, projRow.cron_schedule || '', true);
      } catch (e) {
        console.error(`[Cron] cron_run_command 执行失败:`, (e as Error).message?.slice(0, 500));
        writeCronHeartbeat(projectId, projRow.cron_schedule || '', false);
      }
      // 脚本生成 .txt 通知文件，由 F3 定时推送(im-router.ts)发送 IM，无需额外处理
      return;
    }

    // cron_create_task 模板创建 AI 任务（仅无 cron_run_command 时）
    const tmpl = ctxJson.cron_create_task as { title?: string; description?: string; priority?: number } | undefined;
    if (tmpl?.title) {
      const taskId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO wa_tasks (id, project_id, title, description, priority, status, source, context_json) VALUES (?, ?, ?, ?, ?, 'pending', 'cron', ?)"
      ).run(taskId, projectId, tmpl.title, tmpl.description || '', tmpl.priority ?? 0, JSON.stringify({ source: 'cron', cron_triggered: true }));
      enqueueJob(db, 'ai-task', { taskId, projectId, source: 'cron' });
      console.log(`[Cron] 定时触发: 项目=${projectId.slice(0, 8)} 任务=${taskId.slice(0, 8)}`);
      return;
    }

    // 无命令无模板 → 恢复 source=cron 的暂停任务
    const cronTasks = db.prepare("SELECT id FROM wa_tasks WHERE project_id = ? AND status = 'paused' AND source = 'cron' ORDER BY updated_at DESC").all(projectId) as Array<{ id: string }>;
    if (cronTasks.length > 0) {
      for (const t of cronTasks) {
        db.prepare("UPDATE wa_tasks SET status = 'pending' WHERE id = ?").run(t.id);
        // zx_20260915 P0-5(e): 该 `pending` 转移此前**无事件**（事件溯源里不存在，界面停在 paused 需手刷）——
        //   D1 那处已于 M2 · P0-3(d) 补发，本处是同一病最后一个漏网的转移。
        //   本次转 `pending` 后由调度器扫描（`task-scheduler.ts:405-413` 的 `getReadyTasks`）自动入队
        //   `resume-ai-task`，载荷**仅 `{taskId}`**（无 message、无 initiator）⇒ 处理器取缺省 `'system'`、
        //   自造 `[系统恢复]` 块；故"有未答复提问"时守卫会以 `[待回复]` 横幅替掉自造块（「继续」不等于「同意」）。
        eventBus.emit('task.status_changed', { taskId: t.id, task_id: t.id, projectId, newStatus: 'pending', new_status: 'pending' }).catch(() => {});
      }
      console.log(`[Cron] 恢复 ${cronTasks.length} 个暂停的 cron 任务: 项目=${projectId.slice(0, 8)}`);
    }
  };

  const registerProjectCron = (projectId: string) => {
    if (!db) return;
    const projRow = db.prepare("SELECT cron_schedule, cron_timezone FROM wa_projects WHERE id = ? AND status = 'active'").get(projectId) as { cron_schedule: string; cron_timezone: string } | undefined;
    scheduler.unregisterCronJob(projectId);
    if (!projRow?.cron_schedule) return;
    try {
      scheduler.registerCronJob(projectId, projRow.cron_schedule, projRow.cron_timezone || 'Asia/Shanghai', () => runCronHandler(projectId));
      console.log(`[Cron] 已注册定时作业: 项目=${projectId.slice(0, 8)} cron="${projRow.cron_schedule}"`);
    } catch (e) { console.error(`[Cron] 注册失败: 项目=${projectId.slice(0, 8)}`, (e as Error).message); }
  };

  const activeProjects = db.prepare("SELECT id FROM wa_projects WHERE status = 'active' AND cron_schedule IS NOT NULL AND cron_schedule != ''").all() as Array<{ id: string }>;
  for (const proj of activeProjects) {
    registerProjectCron(proj.id);
  }
  console.log(`[Cron] 已注册 ${activeProjects.length} 个项目的定时作业`);

  // 注入 cron 重新注册回调（供 project.ipc.ts 项目更新时调用）
  try {
    const { setCronRegistrar } = await import('./ipc/project.ipc.js');
    setCronRegistrar(registerProjectCron);
  } catch {}

  // 任务完成 IM 通知已移至 ai-task.ts 的 F2 逻辑（智能内容 + 遍历所有渠道），此处不再重复推送

  // Phase 2.1: 事件总线 → 渲染进程实时推送（任务状态变更）
  const forwardToRenderer = (channel: string, data: Record<string, unknown>) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('task:event', { type: channel, ...data });
    }
  };
  eventBus.on('task.completed', async (e) => { forwardToRenderer('task.completed', e.data as Record<string, unknown>); });
  eventBus.on('task.failed', async (e) => { forwardToRenderer('task.failed', e.data as Record<string, unknown>); });
  eventBus.on('task.status_changed', async (e) => { forwardToRenderer('task.status_changed', e.data as Record<string, unknown>); });
  eventBus.on('task.awaiting_input', async (e) => { forwardToRenderer('task.awaiting_input', e.data as Record<string, unknown>); });
  // Phase A (2026-08-28): 逐步执行流 + 记忆注入可视化实时推送
  eventBus.on('task.step_finished', async (e) => { forwardToRenderer('task.step_finished', e.data as Record<string, unknown>); });
  // D1 (2026-09-02): token 级流式——瞬态事件转发（不持久化，见 emitTransient）
  eventBus.on('task.step_streaming', async (e) => { forwardToRenderer('task.step_streaming', e.data as Record<string, unknown>); });
  // D1 (2026-09-04_2): 长任务心跳简报——瞬态转发（不入 wa_event_log）
  eventBus.on('task.heartbeat', async (e) => { forwardToRenderer('task.heartbeat', e.data as Record<string, unknown>); });
  // zx_20260908 D1: 全局「执行在场」快照转发（AppLayout 在场条）
  eventBus.on('presence.update', async (e) => { forwardToRenderer('presence.update', e.data as Record<string, unknown>); });
  eventBus.on('task.memory_injected', async (e) => { forwardToRenderer('task.memory_injected', e.data as Record<string, unknown>); });
  // Phase A/B (2026-08-28 zx_1): 任务目标显性化 + 目标达成监控信号实时推送
  eventBus.on('task.goal_identified', async (e) => { forwardToRenderer('task.goal_identified', e.data as Record<string, unknown>); });
  eventBus.on('task.goal_deviation', async (e) => { forwardToRenderer('task.goal_deviation', e.data as Record<string, unknown>); });
  eventBus.on('task.execution_signal', async (e) => { forwardToRenderer('task.execution_signal', e.data as Record<string, unknown>); });
  eventBus.on('task.estimated', async (e) => { forwardToRenderer('task.estimated', e.data as Record<string, unknown>); });
  // Phase 1: 实时文件变更事件转发
  eventBus.on('file.created', async (e) => { forwardToRenderer('file.created', e.data as Record<string, unknown>); });
  eventBus.on('file.updated', async (e) => { forwardToRenderer('file.updated', e.data as Record<string, unknown>); });
  eventBus.on('file.edited', async (e) => { forwardToRenderer('file.edited', e.data as Record<string, unknown>); });
  // 终核整改 (2026-09-03): 补齐 project/deliverable 事件转发——A1 Dashboard 事件刷新与 Deliverables 列表订阅了这两类，
  // 不转发则"新交付物注册/项目状态变化"不会触发实时刷新（此前仅 task.*/file.* 被转发）
  eventBus.on('project.status_changed', async (e) => { forwardToRenderer('project.status_changed', e.data as Record<string, unknown>); });
  // zx_20260909 X2①(知行合一): 方案里程碑变更转发——前端 DeliveryDigestCard 订阅即刷(终结虚构 'milestone.done' 死监听)
  eventBus.on('project.milestone_changed', async (e) => { forwardToRenderer('project.milestone_changed', e.data as Record<string, unknown>); });
  eventBus.on('deliverable.registered', async (e) => { forwardToRenderer('deliverable.registered', e.data as Record<string, unknown>); });
  eventBus.on('deliverable.status_changed', async (e) => { forwardToRenderer('deliverable.status_changed', e.data as Record<string, unknown>); });
  // A2 (2026-09-04_2): 渠道启停事件转发 —— Dashboard 已启用渠道数/IM 页实时（此前 channel.* 空转不转发）
  eventBus.on('channel.started', async (e) => { forwardToRenderer('channel.started', e.data as Record<string, unknown>); });
  eventBus.on('channel.stopped', async (e) => { forwardToRenderer('channel.stopped', e.data as Record<string, unknown>); });
  // zx_20260912 M1(海德格尔·在场): 运行期状态跃迁转发——此前适配器内部跃迁(重连/降级/放弃)永不为人知,
  // 界面只能显示启动那一刻的假「运行中」。瞬态事件，仅内存通知（真相已落 wa_im_channels.status）。
  eventBus.on('channel.status_changed', async (e) => { forwardToRenderer('channel.status_changed', e.data as Record<string, unknown>); });
  // zx_20260906 批4 (4a/4d): IM 入站消息 + 记忆沉淀 实时转发——瞬态事件，仅内存通知（不落事件日志/Webhook）
  eventBus.on('im.message_inbound', async (e) => { forwardToRenderer('im.message_inbound', e.data as Record<string, unknown>); });
  // zx_20260911_2 M3: 出站对称转发——此前只有入站可见，工蚁回了什么/补发是否成功在界面上不可见
  eventBus.on('im.message_outbound', async (e) => { forwardToRenderer('im.message_outbound', e.data as Record<string, unknown>); });
  eventBus.on('memory.changed', async (e) => { forwardToRenderer('memory.changed', e.data as Record<string, unknown>); });
  // zx_20261004 M4: 协同面板实时——档位变更（持久化事件）与心跳（瞬态）各走一条转发。
  //   面板订阅 `node.presence_changed`（useLiveQuery），心跳那条供"本机忙闲即时刷"。
  eventBus.on('node.presence_changed', async (e) => { forwardToRenderer('node.presence_changed', e.data as Record<string, unknown>); });
  eventBus.on('node.heartbeat', async (e) => { forwardToRenderer('node.heartbeat', e.data as Record<string, unknown>); });
  // zx_20261004 M10: 设备面板实时——发现（持久化）与状态流转（持久化）各走一条转发。
  eventBus.on('device.discovered', async (e) => { forwardToRenderer('device.discovered', e.data as Record<string, unknown>); });
  eventBus.on('device.status_changed', async (e) => { forwardToRenderer('device.status_changed', e.data as Record<string, unknown>); });
  // zx_20261004 M13: 调用记录实时——到场/收口各一条（持久化，面板 `nodes:requests` 订阅即刷）。
  eventBus.on('node.request_received', async (e) => { forwardToRenderer('node.request_received', e.data as Record<string, unknown>); });
  eventBus.on('node.request_completed', async (e) => { forwardToRenderer('node.request_completed', e.data as Record<string, unknown>); });
  // zx_20261011 M3/M4: 出站（本机派出去）实时——派出/读回收口各一条（持久化，面板 `nodes:dispatches` 订阅即刷）。
  eventBus.on('node.request_dispatched', async (e) => { forwardToRenderer('node.request_dispatched', e.data as Record<string, unknown>); });
  eventBus.on('node.request_result', async (e) => { forwardToRenderer('node.request_result', e.data as Record<string, unknown>); });
  // zx_20261011_2 D8（维特根斯坦·一个规则一处 / 插头要插上）: 双向澄清的两跳同样要送渲染层——
  //   `PeersPage` 的 `DispatchLedger` 已把 `node.request_question`/`node.request_answered` 列进 `liveTypes`，
  //   但此前**主进程没转发这两类**（清单里只有上四条）⇒ 台账两个孔有插头、墙上没线：
  //   B 发问 / 本机作答**落了库却到不了面板** ⇒ 「待作答」块不即时上屏，只能手动刷新才见（实机照出）。
  //   ⇒ 四类事件**一律**转发（枚举同 `liveTypes`，一一对应）。
  eventBus.on('node.request_question', async (e) => { forwardToRenderer('node.request_question', e.data as Record<string, unknown>); });
  eventBus.on('node.request_answered', async (e) => { forwardToRenderer('node.request_answered', e.data as Record<string, unknown>); });

  // A2 (2026-09-03): 原生系统通知（关键事态 + 聚焦/当前页判定 + 点击跳转任务详情）
  const { setupTaskNativeNotifications, showSystemNotification } = await import('./core/notification-service.js');
  setupTaskNativeNotifications({ db, eventBus });
  // zx_20261004 §4 #7：自助注册换掉共享默认 key 后**一次性**提示（放在通知服务装配之后，
  //   故上面只记事实）。`showSystemNotification` 自身守开关/免打扰（早于本行调用会因 db 未注入而静默）。
  if (nodeKeyUpgraded) {
    showSystemNotification('本机已启用独立节点 key', '自助注册成功：已用本节点专属 key 替换共享默认 key（识别为独立工蚁）。');
  }

  registerOAuthProtocol();

  // OAuth 回调
  onOAuthCallback(async (token, refreshToken) => {
    if (mainWindow) {
      mainWindow.webContents.send('oauth:callback', { token, refreshToken });
    }
  });

  // 1. 关键路径：数据库 → 窗口（用户感知启动完成）
  try {
    await startCore();
  } catch (err) {
    console.error('[工蚁] 服务启动失败:', err);
    dialog.showErrorBox('启动失败', `后端服务启动失败:\n${(err as Error).message}`);
    app.quit();
    return;
  }

  createWindow();

  // 2. 窗口后再初始化非关键功能（延迟加载，不影响首屏）
  if (mainWindow) {
    createTray(mainWindow);
    initResilience(mainWindow);
    // zx_20260912 M2-3(海德格尔·在场): 托盘 IM 未读账——把记账模块的显示端接到托盘，并注入
    // 「点未读 → 开主窗并跳 IM 页」的既有跳转通道（与 setTrayRunningMenu 的 onNavigate 同一路径：
    // restore/show/focus + notif:focus-task）；随后按库里 im_last_read_at 对现存未读一次性对账
    // （应用重启后未读不丢）。
    const onOpenIm = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show(); mainWindow.focus();
      mainWindow.webContents.send('notif:focus-task', { type: 'im.navigate' });
    };
    // zx_20260914 M1-3(维特根斯坦·同一把尺): 未读只在 main 算一次（`computeImUnread`），托盘与导航
    //   **同源同尺**——显示端一律不自己记账，否则必然对不上（方案①"本地自增"已证有竞态，见方案 §批 M1-B.1）。
    //   走既有 `task:event` 通道（preload/事件表零改动，与本文件另几处直接 send 同法）；
    //   「已读归零」那一刻也由此抵达：markImRead → refreshImUnread → 此处。
    setImUnreadSink((n) => {
      updateTrayImUnread(n, onOpenIm);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('task:event', { type: 'im.unread', unread: n });
      }
    });
    if (db) refreshImUnread(db);
    // zx_20260912 M3: 启动先对一次出站 dead 账(与 20s tick 同源同尺)——
    //  应用重启后「未送达」不丢，用户开屏即见。
    reconcileOutboxDead();
  }

  // 3. 延迟启动：自动更新检查 + ANS 预热（5s 后，避免抢占启动资源）
  trackShutdownTimer(setTimeout(async () => {
    initAutoUpdater();
    if (!isDev) startPeriodicUpdateCheck();
    // K2: 预连接 ANS 减少首次 API 调用延迟
    // zx_20260930 M9: 改走 `ansSignedRequest`（与其余各处**同一条出路**）。此前这行只读
    //   `process.env.ANS_SERVER_URL`——**不看 DB**，用户把 ANS 配到别处时，预热探的是另一台机器。
    try {
      const { resolveAnsCreds, ansSignedRequest } = await import('./core/ans-signed-request.js');
      const resp = await ansSignedRequest(resolveAnsCreds(db), '/api/v1/health', { timeoutMs: 5000, retries: 0 });
      if (resp.ok) console.log('[工蚁] ANS 预热连接成功');
    } catch { console.log('[工蚁] ANS 预热连接跳过（服务不可达）'); }
  }, 5000));

  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
});

// macOS: 所有窗口关闭后不退出（符合 macOS 惯例）
app.on('window-all-closed', () => {
  // 不退出，用户通过托盘菜单退出
});

app.on('before-quit', async (event) => {
  if (!isQuitting) {
    event.preventDefault();
    isQuitting = true;
    // zx_20261011 M7: 先立"关机中"旗——此后 `uncaughtException` 静默（收尾期写日志撞已退 worker 属预期）。
    markShuttingDown();
    destroyTray();
    await stopCore();
    // 收尾已毕：把各 transport worker 的缓冲冲出，再硬退（否则末几行日志随进程消失而丢）。
    flushLoggersSync();
    app.exit(0);
  }
});
