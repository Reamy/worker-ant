/**
 * zx_20261004 M2/M3（管子·势 / 老子·如实）: 本机**环境如实上报**与**在线态同一把尺**。
 *
 * M2 采集：`collectNodeEnv()` 一份快照——平台/架构/主机名/CPU 数、**真 CPU 利用率**、负载、内存、磁盘可用 +
 *   **派单填充率**（`wa_jobs` running 数 ÷ `PROJECT_CONCURRENCY_DEFAULT`）+ **机器余力**。
 *
 * zx_20261007 M2 正名：`dispatch_fill_ratio`（旧名 `busy_ratio`）回答的是"**我给自己派了几成活**"，
 *   **不是**"这台机器还剩多少力"——旧名把"我方派单填充"说成了"机器忙闲"，是名实不符。真正的
 *   "机器还剩多少力"由 `capacity_free_ratio` 承担（CPU 利用率 + 内存压力 + 剩余槽，**三源取严**）。
 *   `task-accounting.ts` 的 `PROJECT_CONCURRENCY_DEFAULT` 仍是**那唯一一份**分母（填充率与剩余槽同源）。
 *
 * M2 上报：`startNodeHeartbeat()` 周期性经 `ansSignedRequest`（全仓到 ANS 的**唯一出路**）POST
 *   `/api/v1/nodes/heartbeat`。发送函数 **注入**（`send`）——真机用 `makeAnsHeartbeatSend(db)`，
 *   受控回归喂假发送，两侧跑的是**同一个** `startNodeHeartbeat` 主体。
 *
 * M3 如实：失败**不静默**——按 `ansFailureNote` 形状把"HTTP 500 / 无响应（尝试 N 次）"留在 `lastError`
 *   与日志里；断网期间 `stale_since` 记**缺口起点**（"不知道就不说成在线"），恢复后下一跳清空，
 *   并把缺口起点捎进本次 status 载荷（ANS 侧据此可标注"这段数据是陈的"）。
 */
import fs from 'node:fs';
import os from 'node:os';
import { ansFailureNote, ansSignedRequest, isPlaceholderApiKey, resolveAnsCreds, type AnsSettingDb } from './ans-signed-request.js';
import { PROJECT_CONCURRENCY_DEFAULT } from './task-accounting.js';
import { createCpuSampler, type CpuSampler } from './cpu-sampler.js';
import {
  NODE_SETTING_KEYS,
  ensureNodeIdentity,
  readNodeHeartbeatSec,
  readNodeSetting,
  writeNodeSetting,
  type NodeIdentity,
  type NodeSettingDb,
} from './node-identity.js';
import { isNodeRole, type NodeRegistrationRequest, type NodeCard } from '@worker-ant/shared-types';
import { buildNodeCard } from './node-card.js';
import type { DeviceDb } from './device-registry.js';
import { resolveTeamGate } from './team-gate.js';
import type { ResolveLicenseOpts } from './license.js';

/** 本机环境快照——**一份**，喂心跳与喂本机行（M6）同源。 */
export interface NodeEnvSnapshot {
  platform: string;
  arch: string;
  hostname: string;
  cpu_count: number;
  /** 真 CPU 利用率（0–100）；**首次采样无基线 ⇒ `null`**（见 `cpu-sampler.ts`）。 */
  cpu_usage_percent: number | null;
  /** 1 分钟 load average；**Windows 上恒为 0 故取 `null`**（"没有这个数"≠"空闲"）。 */
  load_avg1: number | null;
  total_mem: number;
  free_mem: number;
  /** 磁盘可用/总量（字节）；取不到卷信息时为 `null`（"不知道"不等于 0）。 */
  disk_free: number | null;
  disk_total: number | null;
  /** 本机 running 作业数（快照时刻实测）。 */
  jobs_running: number;
  /** 派单容量分母——`PROJECT_CONCURRENCY_DEFAULT` 一处真源。 */
  concurrency_default: number;
  /** **派单填充率** = jobs_running / concurrency_default（旧名 `busy_ratio`，语义是"我方派了多少活"，非机器忙闲）。 */
  dispatch_fill_ratio: number;
  /** **机器余力**（0–1，1=全空）：CPU 余量 / 内存余量 / 剩余槽 **三源取严**（最紧的那一项）；全不可知 ⇒ `null`。 */
  capacity_free_ratio: number | null;
  collected_at: string;
}

export interface CollectEnvOpts {
  /** 取磁盘可用量的卷路径；缺省 `process.cwd()`。 */
  dataDir?: string;
  /** 注入时钟（受控回归用）；缺省 `Date.now`。 */
  now?: number;
  /** 注入 CPU 采样器（受控回归用）；缺省模块级单例（真机）。 */
  cpuSampler?: CpuSampler;
}

/** 真机用的 CPU 采样器单例——有状态，全进程共用一个（回归各造各的，见 `cpu-sampler.ts` 注释）。 */
const defaultCpuSampler: CpuSampler = createCpuSampler();

/** 采集本机环境快照。任何一处取不到都**如实留空/留 null**，不编一个像真的值。 */
export function collectNodeEnv(db: NodeSettingDb, opts: CollectEnvOpts = {}): NodeEnvSnapshot {
  const jobsRunning = (() => {
    try {
      const row = db.prepare("SELECT COUNT(*) AS c FROM wa_jobs WHERE status = 'running'").get() as { c?: number } | undefined;
      return typeof row?.c === 'number' ? row.c : 0;
    } catch {
      return 0;
    }
  })();

  let diskFree: number | null = null;
  let diskTotal: number | null = null;
  try {
    const st = fs.statfsSync(opts.dataDir ?? process.cwd());
    diskFree = Number(st.bavail) * Number(st.bsize);
    diskTotal = Number(st.blocks) * Number(st.bsize);
    // 取不到卷信息（Windows 某些路径 / 权限）⇒ 保持 null，不谎报 0。
    if (!Number.isFinite(diskFree) || !Number.isFinite(diskTotal)) { diskFree = null; diskTotal = null; }
  } catch { /* disk_free/disk_total 留 null */ }

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const denom = PROJECT_CONCURRENCY_DEFAULT;

  // M1：真 CPU 利用率（两次采样做差；首次返回 null）。
  const cpuUsage = (opts.cpuSampler ?? defaultCpuSampler).sample().percent;

  // M2：机器余力 = 三源取严（最紧的一项即瓶颈）。任一源不可知则只用可知者；全不可知 ⇒ null。
  const cpuSpare = cpuUsage == null ? null : Math.max(0, (100 - cpuUsage) / 100);
  const memSpare = totalMem > 0 ? Math.max(0, freeMem / totalMem) : null;
  const slotSpare = denom > 0 ? Math.max(0, (denom - jobsRunning) / denom) : null;
  const spares = [cpuSpare, memSpare, slotSpare].filter((v): v is number => v != null);
  const capacityFree = spares.length > 0 ? Math.round(Math.min(...spares) * 10000) / 10000 : null;

  return {
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    cpu_count: os.cpus().length,
    cpu_usage_percent: cpuUsage,
    // Windows 上 os.loadavg() 恒 [0,0,0]——那是"没有这个数"，不是"空闲"，如实留 null。
    load_avg1: process.platform === 'win32' ? null : (os.loadavg()[0] ?? null),
    total_mem: totalMem,
    free_mem: freeMem,
    disk_free: diskFree,
    disk_total: diskTotal,
    jobs_running: jobsRunning,
    concurrency_default: denom,
    dispatch_fill_ratio: denom > 0 ? jobsRunning / denom : 0,
    capacity_free_ratio: capacityFree,
    collected_at: new Date(opts.now ?? Date.now()).toISOString(),
  };
}

/** 一次上报的结局——`ok=false` 时 `note` 是人可读的原因（`ansFailureNote` 形状）。 */
export interface HeartbeatSendResult {
  ok: boolean;
  note: string;
}

/**
 * 上报函数（注入点）：真机 `makeAnsHeartbeatSend(db)`，回归喂假。
 *
 * M11：第三参 `card` 是**能力卡**——随**既有心跳**上送（ANS 的 `/nodes/heartbeat` **本已支持**
 * `body.card → card_json`，无需新端点）。回归侧据此断言"卡真的随心跳出了门"。
 */
export type HeartbeatSend = (nodeId: string, status: NodeEnvSnapshot & { stale_since?: string }, card: NodeCard) => Promise<HeartbeatSendResult>;

export interface NodeHeartbeatState {
  /** 最近一次**成功**上报的时刻（ISO）。 */
  lastOkAt: string | null;
  /** 最近一次**失败**的原因（`ansFailureNote` 形状）；成功后清空。 */
  lastError: string | null;
  /** 连续失败次数（成功归零）。 */
  consecutiveFailures: number;
  /** 断网缺口起点（ISO）：首跳失败置位，下一跳成功清空。**在线判断只认 `lastOkAt` 与它。** */
  staleSince: string | null;
}

export interface NodeHeartbeatHandle {
  /** 手动推一跳（回归与"启动即报一次"共用）。**永不抛**。 */
  tick(): Promise<void>;
  stop(): void;
  getState(): NodeHeartbeatState;
}

export interface StartHeartbeatOpts {
  send: HeartbeatSend;
  /** 心跳周期（秒）；缺省读 `node.heartbeat_sec` → 共享缺省。 */
  intervalSec?: number;
  /** 缺省 true（立即 tick 一次 + 起定时器）；回归传 false 手动驱动。 */
  autoStart?: boolean;
  /** 注入时钟（受控回归用）；缺省 `Date.now`。 */
  now?: () => number;
  /**
   * 每跳**结束后**回调（M4）——真机把它接到 `eventBus.emitTransient('node.heartbeat', …)`，
   * 让协同面板在本机这一跳成败/忙闲变化时即时刷。**注入**而非此处直接引 eventBus：
   * 本模块不依赖事件总线（rr 直引真实现时不该被拖进 Electron 那一坨）。异常不外溢。
   */
  onTick?: (info: { ok: boolean; nodeId: string; env: NodeEnvSnapshot; state: NodeHeartbeatState }) => void;
}

/** 真机上报函数：解析身份 → 签名 POST `/api/v1/nodes/heartbeat`（失败原因按同一形状留痕）。 */
export function makeAnsHeartbeatSend(db: NodeSettingDb): HeartbeatSend {
  const credsDb = db as unknown as AnsSettingDb;
  return async (nodeId, status, card) => {
    const r = await ansSignedRequest(resolveAnsCreds(credsDb), '/api/v1/nodes/heartbeat', {
      method: 'POST',
      body: { node_id: nodeId, status, card },
    });
    return r.ok ? { ok: true, note: '' } : { ok: false, note: ansFailureNote(r) };
  };
}

/**
 * 起心跳。缺省立即推一跳（不让面板等一个周期才见到本机）并起定时器；回归传 `autoStart:false` 手动 tick。
 * `tick()` 与定时器共用同一主体 ⇒ 判据跑的就是生产那条路。
 */
export function startNodeHeartbeat(db: NodeSettingDb, opts: StartHeartbeatOpts): NodeHeartbeatHandle {
  const nowFn = opts.now ?? (() => Date.now());
  const intervalSec = opts.intervalSec ?? readNodeHeartbeatSec(db);
  const intervalMs = Math.max(1000, Math.floor(intervalSec * 1000));

  const state: NodeHeartbeatState = { lastOkAt: null, lastError: null, consecutiveFailures: 0, staleSince: null };
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = async (): Promise<void> => {
    const identity = ensureNodeIdentity(db);
    const env = collectNodeEnv(db);
    // 恢复中的那一跳：把缺口起点捎进载荷（`stale_since` 在**下一跳**才消失——此处 state 尚未清）。
    const payload = state.staleSince ? { ...env, stale_since: state.staleSince } : env;
    // M11：能力卡随心跳上送。`platform` 取**同一份** env（不另采），免得卡与 status 各报各的平台。
    const card = buildNodeCard(identity, db as unknown as DeviceDb, env.platform);
    let result: HeartbeatSendResult;
    try {
      result = await opts.send(identity.id, payload, card);
    } catch (e) {
      result = { ok: false, note: (e as Error)?.message || String(e) };
    }
    if (result.ok) {
      state.lastOkAt = new Date(nowFn()).toISOString();
      state.lastError = null;
      state.consecutiveFailures = 0;
      state.staleSince = null;
    } else {
      state.consecutiveFailures += 1;
      state.lastError = result.note;
      if (state.staleSince === null) state.staleSince = new Date(nowFn()).toISOString();
      console.warn(`[工蚁] 节点心跳上报失败：${result.note}`);
    }
    // 回调整体 try——面板刷新失败不该把这一跳的成败记成另一回事。
    try { opts.onTick?.({ ok: result.ok, nodeId: identity.id, env, state: { ...state } }); } catch { /* 忽略 */ }
  };

  if (opts.autoStart !== false) {
    timer = setInterval(() => { void tick(); }, intervalMs);
    void tick();
  }

  return {
    tick,
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    getState() { return { ...state }; },
  };
}

export interface EnrollOpts {
  serverUrl?: string;
  platform?: string;
  capabilities?: string[];
  timeoutMs?: number;
  /** zx_20261011_1 M1：许可解析选项（受控回归注入指纹/公钥；真机缺省）。 */
  licenseOpts?: ResolveLicenseOpts;
}

/**
 * zx_20261011_1 M1（承 C2/M6 许可闸 · 管子·度量衡）：**生效参与**——"这台机器此刻接不接派单"的**唯一判据**。
 *
 * 一条式子，两个因子（谁也别绕过谁）：
 *   - **许可**：`resolveTeamGate(db).unlocked`（team 档 ∨ 试用）。锁 ⇒ 不参与派单（多机协同属团队能力）。
 *   - **用户设置**：`node.participate !== '0'`（缺省参与，与 ANS 列默认 `1` 同一取值）。
 *
 * 为何**不**新增一列/一闸：许可所管的就是"接不接派单"，而 `participate` 本就是这件事的开关——
 *   再开一闸即两把尺量同一件事（承 §1.4、M12「一个概念一个值」）。故注册与改档**皆按此式上报** `participate`。
 *   `db` 既是节点设置库又是许可设置库（同 `wa_settings` 表）⇒ 一次读尽，见 `ipc/nodes.ipc.ts` 的 `licDb === db`。
 */
export function effectiveNodeParticipate(db: NodeSettingDb, opts: ResolveLicenseOpts = {}): boolean {
  if (!resolveTeamGate(db, opts).unlocked) return false;
  return readNodeSetting(db, NODE_SETTING_KEYS.participate) !== '0';
}

export interface EnrollResult {
  enrolled: boolean;
  reason: string;
  nodeId: string;
  resourceGroup?: string;
  /** 本次调用**真把**共享默认 key 换成了本节点专属 key（`enrolled===true` 时恒真；其余情形不设）——
   *  供调用方向用户提示"默认 key 已换"（zx_20261004 §4 #7：防用户以为还在用共享默认 key）。 */
  keyUpgraded?: boolean;
}

/**
 * 「本机**已在 ANS 注册**」的判定**首因**（zx_20261012 加固）。
 *
 * 旧判据只看 `node.resource_group` 绑定本机 id——那是一枚**一次性写下的旧印记**（注册成功时写、
 *   全仓再无清写口），**不看手里那把 key 是不是注册所得**。于是 key 被退回内置占位（如 `dev-key`）时
 *   判据仍为真 ⇒ `ensureNodeEnrolled` 走 `already-enrolled` **短路** ⇒ 本机**永久不自愈**，
 *   且为一个自己并未真正加入的网络持续起心跳/中转（ANS 侧每拍回 **403** `Key is not bound to node`）。
 *
 * 故补为**三条件**：① `node.resource_group` 绑定本机 id；② 本机 `ans_api_key` 非空且**非内置占位**
 *   （判据 `isPlaceholderApiKey`，占位真源只此一处）；③ 若曾记下注册所得 key 前缀
 *   （`node.enrolled_key_prefix`），须与当前 key 相符——**未记 ⇒ 视为旧装（本轮之前注册），按②放行**，
 *   免迁移期误伤（一旦重注册即记前缀、转强判据）。
 */
export type NodeEnrollmentReason =
  | 'enrolled'
  | 'no-identity'
  | 'no-resource-group'
  | 'placeholder-credential'
  | 'key-mismatch';

export function nodeEnrollmentReason(db: NodeSettingDb): NodeEnrollmentReason {
  const id = readNodeSetting(db, NODE_SETTING_KEYS.id);
  if (id === null) return 'no-identity';
  if (readNodeSetting(db, NODE_SETTING_KEYS.resourceGroup) !== `node:${id}`) return 'no-resource-group';
  const key = readNodeSetting(db, NODE_SETTING_KEYS.ansApiKey);
  if (!key || isPlaceholderApiKey(key)) return 'placeholder-credential';
  const prefix = readNodeSetting(db, NODE_SETTING_KEYS.enrolledKeyPrefix);
  if (prefix !== null && key.slice(0, 8) !== prefix) return 'key-mismatch';
  return 'enrolled';
}

/**
 * 「本机**已在 ANS 注册**」的**唯一判据**——`nodeEnrollmentReason` 的**薄壳**（同源，定义恰一处）。
 *
 * ⚠ `node.id` 单独存在只说明本机**自称**是谁，**不代表** ANS 认了这个身份——故不能拿"有 id"当"已注册"。
 *   启动接线（`index.ts`）据此决定**要不要**起心跳/中转——本机未注册时心跳必 **404**（`Node not found`）、
 *   中转必 **403**（`Key is not bound to node`），停了才是对的（不"参与一个自己没加入的网络"）。
 */
export function isNodeEnrolled(db: NodeSettingDb): boolean {
  return nodeEnrollmentReason(db) === 'enrolled';
}

/**
 * 自助注册（K-9）：`node.enrollment_token` 有值且本机**尚未注册**（`nodeEnrollmentReason` 非 `enrolled`）
 * ⇒ 经 `enrollNode`（无 key 的公开路，先有 key 才能签名的鸡生蛋由此破）令牌换 key，成功后写回
 * `ans_api_key` / `ans_secret_key` / `node.resource_group` / `node.enrolled_key_prefix`。**永不抛**——
 * 注册失败是"这次没成"，不该阻断启动；原因如实装进返回值。
 *
 * ⚠ 「已注册」的判据是 `nodeEnrollmentReason`（**三条件**，zx_20261012）：`node.id` 单独存在只说明
 *   本机自称是谁，不代表 ANS 认了这个身份；`node.resource_group` 又只是**一次性旧印记**（无清写口）。
 *   误判"已注册"⇒ 永远不去换 key，心跳恒 401/403 且静默。
 */
export async function ensureNodeEnrolled(db: NodeSettingDb, opts: EnrollOpts = {}): Promise<EnrollResult> {
  const identity: NodeIdentity = ensureNodeIdentity(db);
  const bound = readNodeSetting(db, NODE_SETTING_KEYS.resourceGroup);
  // 判据与 `isNodeEnrolled` 同源（不再内联同一比较）；`bound` 只用于回填返回值。
  if (isNodeEnrolled(db)) {
    return { enrolled: false, reason: 'already-enrolled', nodeId: identity.id, resourceGroup: bound ?? undefined };
  }
  const token = readNodeSetting(db, NODE_SETTING_KEYS.enrollmentToken);
  if (!token) return { enrolled: false, reason: 'no-enrollment-token', nodeId: identity.id };

  const roleRaw = readNodeSetting(db, NODE_SETTING_KEYS.role);
  const creds = resolveAnsCreds(db as unknown as AnsSettingDb);
  const req: NodeRegistrationRequest = {
    enrollment_token: token,
    node_id: identity.id,
    name: identity.name,
    platform: opts.platform ?? os.platform(),
    ...(isNodeRole(roleRaw) ? { role: roleRaw } : {}),
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    // zx_20261011_1 M1：注册那一刻即按**生效参与**上报（许可锁 ⇒ 落 0，一次到位，不必等启动对账）。
    participate: effectiveNodeParticipate(db, opts.licenseOpts),
  };

  try {
    const { enrollNode } = await import('@worker-ant/ans-client');
    const res = await enrollNode(opts.serverUrl ?? creds.baseUrl, req, { timeoutMs: opts.timeoutMs ?? 30_000 });
    writeNodeSetting(db, NODE_SETTING_KEYS.ansApiKey, res.api_key);
    // zx_20261012：记下**注册所得 key** 的前 8 字符（与 ANS 侧 `key_prefix` 同口径），
    //   供 `nodeEnrollmentReason` 判"手里这把是不是注册发的那把"（旧装无此项 ⇒ 按非占位放行）。
    writeNodeSetting(db, NODE_SETTING_KEYS.enrolledKeyPrefix, res.api_key.slice(0, 8));
    writeNodeSetting(db, NODE_SETTING_KEYS.ansSecretKey, res.secret);
    writeNodeSetting(db, NODE_SETTING_KEYS.resourceGroup, res.resource_group);
    console.log(`[工蚁] 节点已注册：${res.node_id}（资源组 ${res.resource_group}）`);
    return { enrolled: true, reason: 'ok', nodeId: identity.id, resourceGroup: res.resource_group, keyUpgraded: true };
  } catch (e) {
    const reason = `enroll-failed: ${(e as Error)?.message || String(e)}`;
    console.warn(`[工蚁] 节点注册失败：${reason}`);
    return { enrolled: false, reason, nodeId: identity.id };
  }
}

/** 读本机注册令牌（`node.enrollment_token`）——**只此一处**读它（调用方只需判"有没有"，不回显全值）。 */
export function readEnrollmentToken(db: NodeSettingDb): string | null {
  return readNodeSetting(db, NODE_SETTING_KEYS.enrollmentToken);
}

/**
 * 写本机注册令牌（zx_20261010_1 M1）——**全仓唯一写点**。
 *
 * 此前该键**只读不写**（`ensureNodeEnrolled` 读它，却无任何入口写它）⇒ 干净 clone 恒无令牌、
 * 恒 `no-enrollment-token` ⇒ 多机协同在本仓**实质不可加入**（上一轮 §5 挂账）。本函数把"配令牌"
 * 从一句空话补成可操作的一步。写失败**如实返回 false**（不静默吞——否则界面以为配上了）。
 */
export function writeEnrollmentToken(db: NodeSettingDb, token: string): boolean {
  return writeNodeSetting(db, NODE_SETTING_KEYS.enrollmentToken, token);
}

/** 一次「申请令牌」的结局——`ok=false` 时 `note` 是人可读原因（`ansFailureNote` 形状）。 */
export interface RequestTokenResult {
  ok: boolean;
  token: string | null;
  note: string;
}

/**
 * 向 ANS **申请**一枚注册令牌（zx_20261010_1 M1）——用本机既有 ANS 凭据签名
 *   `POST /api/v1/nodes/enrollment-tokens`（ANS 侧端点**已在**，无须新造），取 `data.token` 并**写回**
 *   `node.enrollment_token`（下一步 `ensureNodeEnrolled` 读的正是它）。
 *
 * ⚠ **签令牌 ≠ 注册**：前者证明"你有权邀请"，后者才是"你入网"。故本函数**只**调令牌端点；
 *   注册一律经 `ensureNodeEnrolled`（全仓**唯一** `enrollNode` 调用处）——两件事拆开，各留各的痕。
 * ⚠ `request` **注入**（缺省 `ansSignedRequest`）：受控回归喂假 ⇒ 判据不碰真实网络（承 G-4）。
 * ⚠ **永不抛**：没成功如实装进返回值（`ok=false` + `note`），由调用方决定怎么上屏。
 */
export async function requestEnrollmentToken(
  db: NodeSettingDb,
  opts: { request?: typeof ansSignedRequest; timeoutMs?: number } = {},
): Promise<RequestTokenResult> {
  const request = opts.request ?? ansSignedRequest;
  const r = await request(resolveAnsCreds(db as unknown as AnsSettingDb), '/api/v1/nodes/enrollment-tokens', {
    method: 'POST',
    body: { created_by: 'desktop', note: '' },
    timeoutMs: opts.timeoutMs ?? 5000,
  });
  if (!r.ok) return { ok: false, token: null, note: ansFailureNote(r) };
  try {
    const body = (await r.response!.json()) as { data?: { token?: unknown } };
    const token = typeof body.data?.token === 'string' && body.data.token ? body.data.token : null;
    if (!token) return { ok: false, token: null, note: '响应里没有令牌串（ANS 版本可能不匹配）' };
    // 取到了却写不进 ⇒ 也必须如实报失败（否则界面以为配上了，下一步 `ensureNodeEnrolled` 却读不到）。
    if (!writeEnrollmentToken(db, token)) return { ok: false, token: null, note: '令牌已取到但**落库失败**（查 wa_settings 写权限）' };
    return { ok: true, token, note: '' };
  } catch (e) {
    return { ok: false, token: null, note: `响应解析失败 — ${(e as Error)?.message || String(e)}` };
  }
}

/**
 * 「注册」这一动作（zx_20261010_1 M1）——**复用** `ensureNodeEnrolled`（不写第二份注册实现）。
 * 供面板就地注册调用；启动接线读的是同一个函数。
 */
export function enrollWithToken(db: NodeSettingDb, opts: EnrollOpts = {}): Promise<EnrollResult> {
  return ensureNodeEnrolled(db, opts);
}

/** 一次「启动期参与对账」的结局——`changed=true` 表示真向 ANS 报了一个新的参与态。 */
export interface ReconcileResult {
  changed: boolean;
  /** 人可读处置说明（`not-enrolled` / `ok` / `already-off` / `reconcile-failed: …`）。 */
  note: string;
}

/**
 * zx_20261011_1 M1：**启动期参与对账一次**——把"本地生效参与"与"ANS 记账"对齐。
 *
 * 为何要一次对账：许可可能在**离线期间**过期（如试用到期），而"关掉参与"必须**送达 ANS** 才生效
 *   （`DISPATCHABLE_WHERE` 看的是 ANS 那一列）。若只在用户点面板时才同步，则"许可过期后没再点过面板"
 *   的机器会**一直挂着 participate=1 继续被派单**——闸虚。故启动时按**生效参与**核一次，不一致就补报。
 *
 * 判据与注册**同源**（`effectiveNodeParticipate`）：本地设了"不参与"（`'0'`）是用户意志，**不覆盖**；
 *   唯"本地参与 ∧ 许可锁"这一种不一致才动手——把 ANS 侧改为 `participate:false`，成功后**镜像本地**
 *   （写 `'0'`，使下一跳 `effectiveNodeParticipate` 与 ANS 一致，不留"下次启动再报一次"的抖动）。
 *
 * ⚠ **永不抛**：对账失败只如实记日志，**不阻断启动**（网络不通/ANS 没起时不比启动更重要）。
 * ⚠ `request` **注入**（缺省 `ansSignedRequest`）：受控回归喂假 ⇒ 判据不碰真实网络。
 */
export async function reconcileNodeParticipation(
  db: NodeSettingDb,
  opts: { request?: typeof ansSignedRequest; timeoutMs?: number; licenseOpts?: ResolveLicenseOpts } = {},
): Promise<ReconcileResult> {
  try {
    if (!isNodeEnrolled(db)) return { changed: false, note: 'not-enrolled' };
    // 本地已明确置"不参与" ⇒ 用户意志，不动（ANS 侧应已在置此值时同步过）。
    if (readNodeSetting(db, NODE_SETTING_KEYS.participate) === '0') return { changed: false, note: 'already-off' };
    // 生效参与为真（许可未锁）⇒ 与 ANS 侧一致，无须补报。
    if (effectiveNodeParticipate(db, opts.licenseOpts)) return { changed: false, note: 'ok' };

    // 至此：本地参与但许可锁 ⇒ 向 ANS 报 participate=false，成功后镜像本地。
    const nodeId = readNodeSetting(db, NODE_SETTING_KEYS.id);
    if (!nodeId) return { changed: false, note: 'not-enrolled' };
    const request = opts.request ?? ansSignedRequest;
    const r = await request(resolveAnsCreds(db as unknown as AnsSettingDb), `/api/v1/nodes/${nodeId}`, {
      method: 'PATCH',
      body: { participate: false },
      timeoutMs: opts.timeoutMs ?? 5000,
    });
    if (!r.ok) {
      const note = `reconcile-failed: ${ansFailureNote(r)}`;
      console.warn(`[工蚁] 启动期参与对账失败：${note}`);
      return { changed: false, note };
    }
    writeNodeSetting(db, NODE_SETTING_KEYS.participate, '0');
    console.log('[工蚁] 许可未解锁——本机已退出派单（participate=false 已报 ANS）');
    return { changed: true, note: 'ok' };
  } catch (e) {
    const note = `reconcile-failed: ${(e as Error)?.message || String(e)}`;
    console.warn(`[工蚁] 启动期参与对账异常：${note}`);
    return { changed: false, note };
  }
}
