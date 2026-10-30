/**
 * zx_20261022_3 受控复跑 —— 「信」：所言即所测，所授即所控。
 *
 * 分组（与本轮方案 §2 一一对应；按批实施，逐批补入）：
 *   A 一把尺量余力（批一）
 *   B 两机真通路（批二，独立脚本 `rr_zx_20261022_3_two_node.ts`）　C 设备显态与诊断（批三）　D 设备安全收口（批四）
 *   E 终端凭据可恢复（批五）　F 模型降级不丢硬需（批六）
 *   G 知识包往返（批七）　H 项目画像与 Team 共享（批八）　I 档位差异可见（批九）
 *
 * 纪律（承 CLAUDE.md 与 auto-memory）：
 *   · 直引**生产函数**（被删/改名即编译期失败，不扫字符串冒充）。
 *   · 两侧标本同试；计数器类断言给 0→1 正面值，不以"不抛"代替。
 *   · 断言文案不含失败字形（`pnpm rr:all` 汇总器按字形计数）。
 *   · 不写"只为下一轮"的字面量：build 轮次由 `checkBuildPins` 从真源派生核对。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { collectNodeEnv } from '../apps/worker-ant-desktop/src/main/core/node-heartbeat.js';
import {
  PROJECT_CONCURRENCY_DEFAULT,
  PROJECT_RUNNING_STATUSES,
  MACHINE_CONCURRENCY_SETTING_KEY,
  countMachineRunning,
  resolveMachineConcurrencyLimit,
} from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import { readNodeEnv, slotFillView } from '../apps/worker-ant-desktop/renderer/src/lib/node-view.js';
import {
  aggregateDiscoveryErrors,
  liveAbsentNote,
  liveSourceLabel,
  liveStateOf,
  liveStateSummary,
  probeHttpEndpoint,
  type HttpFetchLike,
} from '../apps/worker-ant-desktop/src/main/core/device-diagnostics.js';
import {
  currentMqttAuth,
  MQTT_TOPIC_NAMESPACE,
  mqttConnectOptions,
  mqttDiscoveryToDevice,
  mqttDiscoveryIo,
  mqttDeviceControl,
  mqttCommandTopic,
  mqttCommandTopicWarning,
  mqttStatusPayload,
  probeMqttBroker,
  resolveMqttAuth,
  resolveMqttConfig,
  setMqttSettingsProvider,
  deviceStateTopics,
  validateMqttTopic,
  type MqttAuth,
  type MqttClientLike,
  type MqttSubscribeIo,
} from '../apps/worker-ant-desktop/src/main/core/device-mqtt.js';
import { deviceLiveStateOf, type AnsDevice } from '../apps/worker-ant-desktop/src/main/core/device-registry.js';
import { unregisterDeviceProvider } from '../apps/worker-ant-desktop/src/main/core/device-provider.js';
import {
  createTuyaProvider,
  probeTuya,
  registerTuyaCloudProvider,
  TUYA_REGION_HOSTS,
  TUYA_SETTING_ACCESS_ID,
  TUYA_SETTING_ACCESS_SECRET,
  type TuyaConfig,
  type TuyaHttp,
} from '../apps/worker-ant-desktop/src/main/core/providers/tuya-cloud.js';
import {
  defaultDeviceControl,
  deviceStatusPayload,
  httpDeviceControl,
  isCloudMetadataAddress,
  isLanAddress,
  lanAddressRefusal,
} from '../apps/worker-ant-desktop/src/main/core/tools/device.js';
import {
  SECRET_MASK,
  SECRET_SETTING_KEYS,
  isSecretMaskValue,
  isSecretSettingKey,
  redactedSettingValue,
} from '../apps/worker-ant-desktop/src/main/core/secret-settings.js';
import {
  approveTerminal,
  createPairRequest,
  hashTerminalSecret,
  pairStatus,
  reissueTerminalCredential,
  revokeTerminal,
  verifyTerminal,
  __resetTerminalSecretsForTest,
  type TerminalDb,
  type TerminalRow,
} from '../apps/worker-ant-desktop/src/main/core/external-terminals.js';
import { selectModelForTask, type AnsClientLike } from '../apps/worker-ant-desktop/src/main/core/exec-model-select.js';
import { fallbackCapabilityShortfall, hardCapabilityDegradeNote } from '../apps/worker-ant-desktop/src/main/core/model-request.js';
import {
  BOOL_SETTING_KEYS,
  readBoolSetting,
  readBoolSettingDefaultOff,
} from '../apps/worker-ant-desktop/src/main/core/settings-bool.js';
import {
  KNOWLEDGE_PACK_KIND,
  KNOWLEDGE_PACK_MAX_CHARS,
  KNOWLEDGE_PACK_VERSION,
  importKnowledgeForProject,
  isKnowledgeImportMode,
  listKnowledgeImports,
  parseKnowledgePackage,
  type KnowledgePackage,
} from '../apps/worker-ant-desktop/src/main/core/knowledge-import.js';
import {
  KNOWLEDGE_EXPORT_DIR,
  exportKnowledgeForProject,
  knowledgePackHeader,
  writeKnowledgeExport,
} from '../apps/worker-ant-desktop/src/main/core/knowledge-export.js';
import {
  KNOWLEDGE_INJECT_MAX_TOKENS,
  PROJECT_KNOWLEDGE_SECTION_LABEL,
  listProjectKnowledge,
  previewProjectKnowledge,
  selectKnowledgeForInject,
} from '../apps/worker-ant-desktop/src/main/core/project-knowledge.js';
// zx_20261022_3 批八：项目画像（确定性派生/渲染/落库/注入账）与 Team 第五类共享。
import {
  PROFILE_INJECT_MAX_TOKENS,
  PROFILE_LINE_MAX_CHARS,
  PROJECT_PROFILE_VERSION,
  buildProjectProfile,
  currentProfileSourceHash,
  insertImportedProfile,
  parseProjectProfileJson,
  profileInjectionStats,
  profileRefId,
  readProjectProfile,
  renderProjectProfile,
  saveProjectProfile,
  setProjectProfileEnabled,
  type ProjectProfile,
} from '../apps/worker-ant-desktop/src/main/core/project-profile.js';
import { TEAM_FEATURE_LABEL, TEAM_FEATURES, teamFeatureRefusal } from '../apps/worker-ant-desktop/src/main/core/team-gate.js';
import { TeamLibraryError, importItem, shareItem } from '../apps/worker-ant-desktop/src/main/core/team-library.js';
import { buildMemoryContext } from '../apps/worker-ant-desktop/src/main/core/memory-context.js';
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
import { estimateTokensFromChars } from '../apps/worker-ant-desktop/src/main/core/token-estimate.js';
import { TEAM_ITEM_KINDS, TEAM_ITEM_KIND_LABEL } from '../packages/shared-types/src/team.js';
import { PRO_FEATURES, PRO_FEATURE_LABEL } from '../apps/worker-ant-desktop/src/main/core/pro-gate.js';
import { PRICING } from '../apps/worker-ant-desktop/src/main/core/pricing.js';
import { BENEFIT_COVERAGE, tierCatalog } from '../apps/worker-ant-desktop/src/main/core/tier-catalog.js';
import { LICENSE_SETTING_KEYS } from '../apps/worker-ant-desktop/src/main/core/license.js';
// zx_20261022_3 批九：档位用量读模型（计数/升级差异/回话层增强）与两侧真源。
import {
  PROJECT_QUOTA_UNLOCK_TIER,
  refusalWithContext,
  tierUsageCounts,
  upgradeDifferences,
  usageContextLine,
  usageRatio,
} from '../apps/worker-ant-desktop/src/main/core/tier-usage.js';
import { LICENSE_TIERS, TIER_LABEL, TIER_LIMITS } from '../apps/worker-ant-desktop/src/main/core/feature-limits.js';
import { countProjects, projectQuotaRefusal } from '../apps/worker-ant-desktop/src/main/core/project-quota.js';
import { countSeats } from '../apps/worker-ant-desktop/src/main/core/seat-quota.js';

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

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');
/** 查"代码里有没有"一律去注释；查"面板文案"读原文。 */
const strip = (rel: string): string => stripKeepingLines(read(rel)).join('\n');

const NODE_HEARTBEAT_SRC = `${A}/src/main/core/node-heartbeat.ts`;
const NODE_VIEW_TS = `${A}/renderer/src/lib/node-view.ts`;
const PEERS_PAGE = `${A}/renderer/src/pages/PeersPage.tsx`;
const ELECTRON_D_TS = `${A}/renderer/src/types/electron.d.ts`;
const MAIN_INDEX = `${A}/src/main/index.ts`;
const DEVICES_PAGE = `${A}/renderer/src/pages/DevicesPage.tsx`;
const DEVICES_IPC = `${A}/src/main/ipc/devices.ipc.ts`;
const RENDERER_IPC = `${A}/renderer/src/lib/ipc.ts`;
const DEVICE_TOOL = `${A}/src/main/core/tools/device.ts`;
const HA_SRC = `${A}/src/main/core/device-homeassistant.ts`;
const DEVICE_MQTT = `${A}/src/main/core/device-mqtt.ts`;
const ADMIN_IPC = `${A}/src/main/ipc/admin.ipc.ts`;
const SETTINGS_PAGE = `${A}/renderer/src/pages/SettingsPage.tsx`;
const SETUP_PAGE = `${A}/renderer/src/pages/SetupPage.tsx`;
const EXTERNAL_IPC = `${A}/src/main/ipc/external.ipc.ts`;
const EXTERNAL_TERMINALS_CORE = `${A}/src/main/core/external-terminals.ts`;

/* ── 夹具：逐列照抄 database.ts 中 collectNodeEnv 触达的表（不缺列、不放宽）── */
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, status TEXT DEFAULT 'pending', type TEXT DEFAULT '');
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, status TEXT DEFAULT 'pending');
`;
type AnyDb = import('better-sqlite3').Database;
function mkdb(withTasks = true): AnyDb {
  const d = new DatabaseSync(':memory:');
  d.exec(withTasks ? SCHEMA : SCHEMA.replace(/CREATE TABLE wa_tasks[^;]*;/, ''));
  return d as unknown as AnyDb;
}
const addJob = (db: AnyDb, id: string, status: string): void => {
  db.prepare('INSERT INTO wa_jobs (id, status, type) VALUES (?, ?, ?)').run(id, status, 'ai-task');
};
const addTask = (db: AnyDb, id: string, status: string): void => {
  db.prepare('INSERT INTO wa_tasks (id, status) VALUES (?, ?)').run(id, status);
};

// ───────────────────────── A 一把尺量余力（批一）─────────────────────────
function groupA(): void {
  // A-1 机器上限取执行闸那一份真源：未配置按 CPU 派生；配置了按配置。
  {
    const db = mkdb();
    const derived = collectNodeEnv(db, { cpus: 4, dataDir: root });
    eq(derived.machine_limit, resolveMachineConcurrencyLimit(db as never, { cpus: 4 }).limit,
      'A-1 ★上限与执行闸同源：machine_limit == resolveMachineConcurrencyLimit().limit（cpus=4 ⇒ 3）');
    ok(derived.machine_limit === 3,
      'A-1b 未配置时由 CPU 派生（cpus=4 ⇒ 3），与执行闸同一个派生函数',
      `limit=${derived.machine_limit}`);

    db.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)').run(MACHINE_CONCURRENCY_SETTING_KEY, '5');
    const configured = collectNodeEnv(db, { cpus: 4, dataDir: root });
    ok(configured.machine_limit === 5,
      'A-2 **用户配置优先**：machine_max_concurrency=5 ⇒ 心跳上限 5（与执行闸读同一 setting 键）',
      `limit=${configured.machine_limit}`);
  }

  // A-3 槽位占位只认 running 三态（与 countMachineRunning 逐值一致）。
  {
    const db = mkdb();
    addTask(db, 't-pending', 'pending');
    addTask(db, 't-exec', 'executing');
    addTask(db, 't-prep', 'preparing');
    addTask(db, 't-plan', 'planning');
    addTask(db, 't-done', 'completed');
    const env = collectNodeEnv(db, { cpus: 4, dataDir: root });
    eq(env.running_tasks, countMachineRunning(db as never),
      `A-3 ★占位计数与执行闸同一个函数：running_tasks == countMachineRunning()（三态 ${PROJECT_RUNNING_STATUSES.join('/')}）`);
    ok(env.running_tasks === 3 && env.free_slots === 0 && env.slot_fill_ratio === 1,
      'A-3\'\' 三态共 3 件占满 3 槽：pending/completed **不**计入（两侧标本）',
      `tasks=${env.running_tasks} · free=${env.free_slots} · fill=${env.slot_fill_ratio}`);
  }

  // A-4 **两把尺不混**：派单作业满、机器槽位空 ⇒ 派单 1 而槽位 0、余力仍 > 0。
  {
    const db = mkdb();
    for (let i = 0; i < PROJECT_CONCURRENCY_DEFAULT; i++) addJob(db, `j${i}`, 'running');
    addJob(db, 'j-done', 'done');
    const env = collectNodeEnv(db, { cpus: 4, dataDir: root });
    // 余力是 CPU/内存/槽位**三源取严**，故只断言"不高于槽位余量"这一不变式——
    // 不拿"此刻机器恰好有余力"当判据（那会随并发负载翻脸，正是本轮的病）。
    ok(env.dispatch_fill_ratio === 1 && env.slot_fill_ratio === 0
      && env.running_tasks === 0 && env.free_slots === 3
      && (env.capacity_free_ratio == null
        || env.capacity_free_ratio <= env.free_slots / env.machine_limit),
      'A-4 ★派单满 ≠ 机器满：jobs 满（dispatch=1）而 tasks=0 ⇒ 槽位 0/3；融合余力取严（不高于槽位余量），作业数不参与槽位',
      `dispatch=${env.dispatch_fill_ratio} · slot=${env.slot_fill_ratio} · capacity=${env.capacity_free_ratio}`);
    ok(env.jobs_running === PROJECT_CONCURRENCY_DEFAULT && env.concurrency_default === PROJECT_CONCURRENCY_DEFAULT,
      'A-4\'\' 派单口径原义保留：jobs_running/concurrency_default 仍是 jobs ÷ 项目缺省并发',
      `${env.jobs_running}/${env.concurrency_default}`);
  }

  // A-5 满槽 ⇒ 槽位余量 0 ⇒ 三源取严的余力 0。
  {
    const db = mkdb();
    for (let i = 0; i < 3; i++) addTask(db, `t${i}`, 'executing');
    const env = collectNodeEnv(db, { cpus: 4, dataDir: root });
    ok(env.capacity_free_ratio === 0 && env.slot_fill_ratio === 1 && env.free_slots === 0,
      'A-5 满槽 ⇒ 槽位余量 0 ⇒ 余力 0（取严，不取平均）',
      `capacity=${env.capacity_free_ratio}`);
  }

  // A-6 读不到任务表 ⇒ null（"不知道"≠"全空"）：不把 0 冒充成"槽位都空着"。
  {
    const db = mkdb(false);
    const env = collectNodeEnv(db, { cpus: 4, dataDir: root });
    ok(env.running_tasks === null && env.free_slots === null && env.slot_fill_ratio === null,
      'A-6 无 wa_tasks ⇒ running_tasks/free_slots/slot_fill_ratio 全 null（不谎报 0）',
      `tasks=${env.running_tasks} · free=${env.free_slots} · fill=${env.slot_fill_ratio}`);
  }

  // A-7 上报 → ANS status_json → 面板投影：新字段值不漂。
  {
    const db = mkdb();
    addTask(db, 't1', 'executing');
    addTask(db, 't2', 'planning');
    const env = collectNodeEnv(db, { cpus: 4, dataDir: root });
    const view = readNodeEnv({ status: JSON.parse(JSON.stringify(env)) as Record<string, unknown> });
    ok(view != null && view.machine_limit === env.machine_limit && view.running_tasks === env.running_tasks
      && view.free_slots === env.free_slots && view.slot_fill_ratio === env.slot_fill_ratio,
      'A-7 ★往返不漂：JSON 往返（=ANS status_json）后投影四字段与采集值相等',
      `limit ${view?.machine_limit} · tasks ${view?.running_tasks} · slots ${view?.free_slots}`);
    eq(slotFillView(view), { label: '2 / 3', ratio: 2 / 3 },
      'A-7\'\' 槽位呈现 = `running / limit`（2 / 3），不拿作业数冒充');
  }

  // A-8 展示层三态：无快照 / 旧版快照 / 有值。
  {
    eq(slotFillView(null), { label: '无快照', ratio: null }, 'A-8 无 status ⇒ 如实"无快照"');
    const legacy = readNodeEnv({ status: { platform: 'darwin' } });
    eq(slotFillView(legacy), { label: '旧版快照', ratio: null },
      'A-8b 旧版快照（无 machine_limit/running_tasks）⇒ 如实"旧版快照"，不拿 0 冒充空槽');
    const partial = readNodeEnv({ status: { machine_limit: 4, running_tasks: 1 } });
    eq(slotFillView(partial), { label: '1 / 4', ratio: 0.25 },
      'A-8c 无 slot_fill_ratio 时按两字段现算（旧版心跳 + 新面板亦能显示）');
  }

  // A-9 五落点接线：采集用同一把尺 / 瞬态事件捎新字段 / 面板真调 / 类型声明齐。
  {
    const hb = strip(NODE_HEARTBEAT_SRC);
    ok(/countMachineRunning\(/.test(hb) && /resolveMachineConcurrencyLimit\(/.test(hb)
      && /runningTasks\s*\/\s*machineLimit/.test(hb),
      'A-9 采集侧：槽位率 = runningTasks / machineLimit，两值皆取自执行闸真源函数');
    const mainSrc = strip(MAIN_INDEX);
    ok(/slotFillRatio:\s*info\.env\.slot_fill_ratio/.test(mainSrc)
      && /runningTasks:\s*info\.env\.running_tasks/.test(mainSrc)
      && /machineLimit:\s*info\.env\.machine_limit/.test(mainSrc),
      'A-9\'\' 瞬态事件 `node.heartbeat` 捎上三字段（面板即时刷新有据）');
    ok(/slotFillRatio\?:\s*number \| null/.test(strip(ELECTRON_D_TS)),
      'A-9b `electron.d.ts` 声明 `slotFillRatio`（IPC 边界类型不缺席）');
    const page = strip(PEERS_PAGE);
    ok(/slotFillView\(env\)/.test(page) && /机器槽位/.test(page) && /env\.machine_limit/.test(page)
      && /数据陈旧/.test(page),
      'A-9c 面板真调 `slotFillView`、显"机器槽位"与陈旧标，不自造换算');
    ok(fs.existsSync(path.join(root, NODE_VIEW_TS)),
      'A-10 投影模块在位（本套件直引它跑 A-7/A-8，不另造等价实现）');
  }
}

// ───────────────────── C 设备显态与诊断（批三）─────────────────────
async function groupC(): Promise<void> {
  // C-1 凭据解析：用户名 trim、密码不 trim、TLS 缺省关、证书校验缺省开（显式关才关）。
  {
    const get = (m: Record<string, string>) => (k: string): string | null => m[k] ?? null;
    const auth = resolveMqttAuth(get({
      'device.mqtt.username': '  alice  ',
      'device.mqtt.password': ' p@ss ',
      'device.mqtt.tls': '1',
    }));
    eq(auth, { username: 'alice', password: ' p@ss ', tls: true, rejectUnauthorized: true },
      'C-1 ★凭据解析：用户名去空白、密码原样（首尾空格可能是密码）、TLS 开 ⇒ 证书校验缺省仍开');
    const off = resolveMqttAuth(get({ 'device.mqtt.reject_unauthorized': '0' }));
    ok(off.rejectUnauthorized === false && off.tls === false && off.username === '' && off.password === '',
      'C-1b 显式 `reject_unauthorized=0` 才关校验；未配即匿名 + TLS 关（两侧标本）');

    const cfg = resolveMqttConfig(get({ 'device.mqtt.enabled': '1', 'device.mqtt.broker': '192.168.1.9:1883' }));
    ok(cfg.enabled && cfg.broker?.host === '192.168.1.9' && cfg.broker.port === 1883
      && cfg.discoveryTopic === 'workerant/discovery/#',
      'C-2 开且配了 broker 才算启用；发现主题取缺省');
    const noBroker = resolveMqttConfig(get({ 'device.mqtt.enabled': '1' }));
    ok(noBroker.enabled === false && noBroker.broker === null,
      'C-2b 只开不配 broker ⇒ 未启用（缺 broker 的"开"没有意义）');

    // 状态回包**白名单**：密码明文永不进渲染层，只回"配没配"。
    const payload = mqttStatusPayload(cfg, true, { enabled: false, prefix: 'homeassistant' });
    ok(payload.passwordSet === false && !JSON.stringify(payload).includes('password":'),
      'C-3 ★状态回包无 password 字段（白名单逐字段抄，不 spread）');
    const withPw = mqttStatusPayload({ ...cfg, password: 'TOP_SECRET' }, true, { enabled: false, prefix: 'x' });
    ok(withPw.passwordSet === true && !JSON.stringify(withPw).includes('TOP_SECRET'),
      'C-3b 配了密码 ⇒ 只回 passwordSet=true，明文不出现在 JSON 任一处');

    const opts = mqttConnectOptions({ username: 'alice', password: 'TOP_SECRET', tls: true, rejectUnauthorized: false }, 'cid-1');
    ok(opts.username === 'alice' && opts.password === 'TOP_SECRET' && opts.rejectUnauthorized === false
      && opts.reconnectPeriod === 0 && opts.clientId === 'cid-1',
      'C-4 连接选项带凭据与证书开关（重连关闭：诊断/控制不无限重试）');
    const anon = mqttConnectOptions({ username: '', password: '', tls: false, rejectUnauthorized: true }, 'cid-2');
    ok(!('username' in anon) && !('password' in anon) && anon.rejectUnauthorized === true,
      'C-4b 空用户名/密码**不发**（匿名 broker 合法），证书校验缺省 true');
  }

  // C-5 MQTT 探活：独立连接、等 CONNACK、数保留消息、必断、回包不含凭据。
  {
    interface FakeCapture {
      url?: string;
      opts?: Record<string, unknown>;
      topic?: string;
      ended: boolean;
    }
    function fakeFactory(b: {
      fail?: boolean;
      messages?: string[];
      subscribeThrows?: boolean;
    }): { connect: (url: string, opts?: Record<string, unknown>) => MqttClientLike; cap: FakeCapture } {
      const cap: FakeCapture = { ended: false };
      const client: MqttClientLike = {
        connected: false,
        on(ev: string, cb: (...args: unknown[]) => void): void {
          if (ev === 'connect' && !b.fail) {
            setTimeout(() => { client.connected = true; cb(); }, 0);
          }
          if (ev === 'error' && b.fail) {
            setTimeout(() => cb(new Error('CONNACK 拒绝：Not authorized')), 0);
          }
          if (ev === 'message') {
            for (const t of b.messages ?? []) setTimeout(() => cb(t), 1);
          }
        },
        publish(_t: string, _p: string, _o: Record<string, unknown>, cb: (err?: Error) => void): void { cb(); },
        subscribe(topic: string): void {
          cap.topic = topic;
          if (b.subscribeThrows) throw new Error('订阅被拒');
        },
        end(): void { cap.ended = true; },
      };
      const connect = (url: string, opts?: Record<string, unknown>): MqttClientLike => {
        cap.url = url; cap.opts = opts; return client;
      };
      return { connect, cap };
    }
    const auth: MqttAuth = { username: 'alice', password: 'TOP_SECRET', tls: false, rejectUnauthorized: true };

    await (async () => {
      let tick = 1000;
      const now = (): number => { tick += 12; return tick; };
      const f = fakeFactory({ messages: ['homeassistant/x/config', 'homeassistant/x/config', 'homeassistant/y/config'] });
      const r = await probeMqttBroker({
        host: '192.168.1.9', port: 1883, topic: 'homeassistant/#', auth,
        waitMs: 20, connect: f.connect, now,
      });
      ok(r.ok && r.protocol === 'mqtt' && r.endpoint === '192.168.1.9:1883' && r.topics === 2,
        'C-5 ★探活成功：报连接耗时与主题数（同一主题重复到达按一条计）',
        `topics=${r.topics} · ${r.detail}`);
      ok(f.cap.url === 'mqtt://192.168.1.9:1883' && f.cap.opts?.username === 'alice'
        && f.cap.opts?.password === 'TOP_SECRET'
        && String(f.cap.opts?.clientId ?? '').startsWith('worker-ant-test-'),
        'C-5b 连接用 mqtt:// + 当前凭据；clientId 带 test 前缀（与控制/发现的连接各用各的 id）');
      ok(f.cap.topic === 'homeassistant/#' && f.cap.ended === true,
        'C-5c 订阅了被测主题且**必断**（诊断不留常驻连接）');
      ok(r.latencyMs === 12,
        'C-5d 耗时按注入时钟量（started 与 ended 各取一次 ⇒ 12ms），不编造', `${r.latencyMs}`);
      ok(!JSON.stringify(r).includes('TOP_SECRET'),
        'C-5e ★探活回包不含密码（detail/endpoint 均无凭据）');

      const tlsF = fakeFactory({ messages: [] });
      const rt = await probeMqttBroker({
        host: '192.168.1.9', port: null, topic: 'x/#',
        auth: { ...auth, tls: true, rejectUnauthorized: false }, waitMs: 5, connect: tlsF.connect,
      });
      ok(rt.ok && rt.protocol === 'mqtts' && rt.endpoint === '192.168.1.9:8883'
        && tlsF.cap.url === 'mqtts://192.168.1.9:8883' && tlsF.cap.opts?.rejectUnauthorized === false,
        'C-6 TLS ⇒ mqtts:// 且缺省端口 8883；证书校验开关随凭据传递');

      const subF = fakeFactory({ subscribeThrows: true });
      const rs = await probeMqttBroker({
        host: '192.168.1.9', port: 1883, topic: 'x/#', auth, waitMs: 5, connect: subF.connect,
      });
      ok(rs.ok && rs.topics === 0,
        'C-6b 订阅被拒 ≠ 连接失败：CONNACK 过即回 ok，条数如实 0（不把半程当全通）');

      const badF = fakeFactory({ fail: true });
      const rb = await probeMqttBroker({
        host: '192.168.1.9', port: 1883, topic: 'x/#', auth, waitMs: 5, connect: badF.connect,
      });
      ok(!rb.ok && rb.topics === 0 && rb.detail.includes('Not authorized') && badF.cap.ended,
        'C-7 连接失败如实带 broker 原话，且仍断开连接（finally 收摊）');
      ok(!JSON.stringify(rb).includes('TOP_SECRET'),
        'C-7b 失败回包同样不含密码（错误文案只带 broker 原因）');
    })();
  }

  // C-8 HTTP 探活：一次有界 GET、不跟重定向、超时/拒连如实回因。
  {
    await (async () => {
      let seen: { url?: string; init?: { method: string; redirect: string; signal: AbortSignal } } = {};
      const okFetch: HttpFetchLike = async (url, init) => { seen = { url, init }; return { status: 204 }; };
      let tick = 0;
      const r = await probeHttpEndpoint('192.168.1.5', 8080, { fetchFn: okFetch, now: () => (tick += 10) });
      ok(r.ok && r.statusCode === 204 && r.endpoint === 'http://192.168.1.5:8080/' && r.protocol === 'http',
        'C-8 ★HTTP 探活成功：报状态码与规范化 endpoint', `${r.detail}`);
      ok(seen.init?.method === 'GET' && seen.init?.redirect === 'manual'
        && seen.url === 'http://192.168.1.5:8080/',
        'C-8b 只发一次 GET 且 `redirect: manual`（探活不成为跳板）');
      ok(r.latencyMs === 10,
        'C-8c 耗时按注入时钟量（10ms），不碰墙钟');

      const timeoutFetch: HttpFetchLike = async () => {
        const e = new Error('The operation was aborted due to timeout');
        e.name = 'TimeoutError';
        throw e;
      };
      const rt = await probeHttpEndpoint('192.168.1.5', 8080, { fetchFn: timeoutFetch, timeoutMs: 250 });
      ok(!rt.ok && rt.detail.includes('超时（>250ms）'),
        'C-9 超时如实说"超时 + 阈值"（不把超时叫失败原因含糊）', rt.detail);

      const refusedFetch: HttpFetchLike = async () => { throw new Error('connect ECONNREFUSED 192.168.1.5:8080'); };
      const rr = await probeHttpEndpoint('192.168.1.5', 8080, { fetchFn: refusedFetch });
      ok(!rr.ok && rr.detail.includes('ECONNREFUSED'),
        'C-9b 连不上带原始原因（ECONNREFUSED 不吞）', rr.detail);

      const bad = await probeHttpEndpoint('bad host', null, { fetchFn: okFetch });
      ok(!bad.ok && bad.detail.startsWith('地址无法组成') && bad.latencyMs === 0,
        'C-9c 地址认不出 ⇒ 如实说地址问题，且不发请求', bad.detail);
    })();
  }

  // C-10 实时状态投影：面板与工具体同一份判据。
  await (async () => {
    eq(liveStateOf(null), null, 'C-10 无 status ⇒ live 为 null（"没收到过"≠"空状态"）');
    eq(liveStateOf({}), null, 'C-10b status 无 live 键 ⇒ null');
    eq(liveStateOf({ live: { state: 'ON', attributes: { brightness: 80 }, at: '2026-10-22T01:02:03.000Z', source: 'state' } }),
      { state: 'ON', attributes: { brightness: 80 }, at: '2026-10-22T01:02:03.000Z', source: 'state' },
      'C-10c 投影原样透传 state/attributes/at/source');
    eq(liveStateOf({ live: { state: 'ON', attributes: {}, at: 't', source: 'attributes', attributes_error: '坏 JSON' } }),
      { state: 'ON', attributes: {}, at: 't', source: 'attributes', attributes_error: '坏 JSON' },
      'C-10d 属性解析失败如实带上 attributes_error（空串则不出现）');
    eq(deviceLiveStateOf({ live: { state: 'OFF', attributes: {}, at: 't', source: 'state' } }),
      liveStateOf({ live: { state: 'OFF', attributes: {}, at: 't', source: 'state' } }),
      'C-10e ★台账投影与面板投影同一实现（registry 委托 diagnostics，不各猜一遍）');

    eq(liveSourceLabel('state'), 'MQTT 订阅 · 状态主题（state）', 'C-11 来源人话：state 主题');
    eq(liveSourceLabel('attributes'), 'MQTT 订阅 · 属性主题（jattr）', 'C-11b 来源人话：属性主题');

    const live = { state: 'ON', attributes: { brightness: 80, color_temp: 300 }, at: 't', source: 'state' as const };
    eq(liveStateSummary(live), 'ON · brightness=80 color_temp=300',
      'C-12 摘要 = 状态原文 + 属性键值（不另造词）');
    eq(liveStateSummary({ state: '', attributes: { a: 1, b: 2, c: 3, d: 4, e: 5 }, at: '', source: 'state' }),
      'a=1 b=2 c=3 d=4 …（共 5 项）',
      'C-12b 属性多于 4 项 ⇒ 截断并如实报总数');
    eq(liveStateSummary({ state: '', attributes: {}, at: '', source: 'state' }),
      '（设备已上报，但内容为空）',
      'C-12c 空内容也说"已上报但为空"（不显示空白）');
    ok(liveAbsentNote().includes('控制快照'),
      'C-13 无上行时的说明点名"只有最近一次控制快照"', liveAbsentNote());

    eq(aggregateDiscoveryErrors([]), { count: 0, unique: [], summary: '' },
      'C-14 无告警 ⇒ 空摘要（面板不显示横幅）');
    const agg = aggregateDiscoveryErrors(['a', 'b', 'a', '   ', '']);
    eq({ count: agg.count, unique: agg.unique }, { count: 3, unique: ['a', 'b'] },
      'C-14b ★原始条数如实 3，去重后 2 类（空白项剔除，不粉饰）');
    ok(agg.summary.includes('3 条') && agg.summary.includes('（2 类）') && agg.summary.includes('a'),
      'C-14c 一句话告警带条数/类数/首条原文', agg.summary);
    const one = aggregateDiscoveryErrors(['x']);
    ok(one.summary.includes('1 条') && !one.summary.includes('类）'),
      'C-14d 只有一类时不写"（1 类）"（无信息量的话不刷屏）');

    // C-15 device_status 载荷：来源/采集说明是 live 的**兄弟键**，不塞进 live（旧断言形状不变）。
    const dev = (over: Partial<AnsDevice> = {}): AnsDevice => ({
      id: 'd1', name: '台灯', alias: '', room: '', kind: 'light', protocol: 'mqtt',
      address: '192.168.1.20', port: 1883, capabilities: ['state'], controllable: true,
      authorized: true, online: null, status: null,
      first_seen: '2026-10-20 00:00:00', last_seen: '2026-10-22 00:00:00', ...over,
    });
    const withLive = deviceStatusPayload(dev({
      status: { last_action: 'on', last_ok: true, live: { state: 'ON', attributes: { brightness: 80 }, at: '2026-10-22T01:00:00.000Z', source: 'state' } },
    }));
    eq(withLive.live, { state: 'ON', attributes: { brightness: 80 }, at: '2026-10-22T01:00:00.000Z', source: 'state' },
      'C-15 ★有上行时 live 形状原样（既有回归逐字段钉死的形状不变）');
    eq(withLive.live_source_label, 'MQTT 订阅 · 状态主题（state）',
      'C-15b 来源说明是兄弟键 live_source_label（与面板同一句）');
    ok(!('live_note' in withLive) && withLive.status != null && !('live' in (withLive.status as object)),
      'C-15c 有上行时不给 live_note；控制快照 status 不复读 live（分名不互相冒充）');
    ok((withLive.status as Record<string, unknown>).last_action === 'on',
      'C-15d 控制快照字段保留');

    const noLive = deviceStatusPayload(dev({ status: { last_action: 'off', last_ok: true } }));
    ok(noLive.live === null && noLive.live_note === liveAbsentNote()
      && !('live_source_label' in noLive),
      'C-16 无上行 ⇒ live=null 且 live_note 如实说明"只有控制快照"（不假装实时）');

    // C-17 涂鸦 getState：设备详情摊成 values；online 只透传不编。
    const cfg: TuyaConfig = { region: 'cn', accessId: 'AKID_X', accessSecret: 'SECRET_X' };
    const makeHttp = (detail: { status: number; body: string }): TuyaHttp => async (url) => {
      if (url.includes('/v1.0/token')) {
        return { status: 200, body: JSON.stringify({ success: true, result: { access_token: 'tk', expire_time: 7200 } }) };
      }
      if (url.includes('/v1.0/devices/dev-1')) return detail;
      return { status: 404, body: 'not found' };
    };
    const provider = createTuyaProvider(cfg, {
      http: makeHttp({
        status: 200,
        body: JSON.stringify({ success: true, result: { online: true, status: [{ code: 'switch_1', value: true }, { code: 'bright_value', value: 80 }] } }),
      }),
      now: () => new Date(1_700_000_000_000),
    });
    ok(typeof provider.getState === 'function', 'C-17 Provider 暴露 getState');
    const st = await provider.getState!('dev-1');
    eq(st, { ok: true, state: { values: { switch_1: true, bright_value: 80 }, online: true } },
      'C-17b ★设备详情 status 数组摊成 values；online 透传');
    const noOnline = createTuyaProvider(cfg, {
      http: makeHttp({ status: 200, body: JSON.stringify({ success: true, result: { status: { switch_1: false } } }) }),
    });
    const st2 = await noOnline.getState!('dev-1');
    eq(st2, { ok: true, state: { values: { switch_1: false } } },
      'C-17c 云没答 online ⇒ state 里不出现 online（不猜"在线"）');
    const st5 = await createTuyaProvider(cfg, { http: makeHttp({ status: 500, body: 'boom' }) }).getState!('dev-1');
    ok(!st5.ok && String(st5.error).includes('HTTP 500'),
      'C-18 设备详情 500 ⇒ 如实带 HTTP 状态', st5.ok ? '（意外成功）' : st5.error);
    const st4 = await createTuyaProvider(cfg, {
      http: makeHttp({ status: 200, body: JSON.stringify({ success: false, code: 1004, msg: 'sign invalid' }) }),
    }).getState!('dev-1');
    ok(!st4.ok && String(st4.error).includes('code=1004') && String(st4.error).includes('sign invalid'),
      'C-18b 云信封失败 ⇒ 带官方 code/msg', st4.ok ? '（意外成功）' : st4.error);

    // C-19 涂鸦探活：令牌 + 一页设备读 total；永不回凭据。
    let tick = 0;
    const probeHttp: TuyaHttp = async (url) => {
      tick += 5;
      if (url.includes('/v1.0/token')) {
        return { status: 200, body: JSON.stringify({ success: true, result: { access_token: 'tk', expire_time: 7200 } }) };
      }
      if (url.includes('/v1.0/devices')) {
        return { status: 200, body: JSON.stringify({ success: true, result: { total: 3, devices: [{ id: 'a' }] } }) };
      }
      return { status: 404, body: 'not found' };
    };
    const pr = await probeTuya(cfg, { http: probeHttp, now: () => new Date(1_700_000_000_000 + tick) });
    ok(pr.ok && pr.target === 'tuya' && pr.protocol === 'https'
      && pr.endpoint === TUYA_REGION_HOSTS.cn && pr.deviceCount === 3,
      'C-19 ★探活成功：区域端点 + 官方 total 台数', pr.detail);
    ok(pr.detail.includes('3 台设备'),
      'C-19b 人话说清"账号下 3 台设备"');
    ok(!JSON.stringify(pr).includes('SECRET_X') && !JSON.stringify(pr).includes('AKID_X'),
      'C-19c ★探活回包不含 accessId/secret');

    const failProbe = await probeTuya(cfg, {
      http: async (url) => url.includes('/token')
        ? { status: 200, body: JSON.stringify({ success: false, code: 1004, msg: 'sign invalid' }) }
        : { status: 500, body: 'x' },
    });
    ok(!failProbe.ok && failProbe.detail.includes('code=1004'),
      'C-20 令牌失败 ⇒ 如实带官方错误码（不报"连接成功"）', failProbe.detail);

    // C-21 注册版：未配置 ⇒ unsupported + 原因；配置后委托真实现。
    try {
      const unconfigured = registerTuyaCloudProvider(() => null);
      const us = await unconfigured.getState!('dev-1');
      ok(us.ok === false && us.unsupported === true && String(us.error).includes('未配置'),
        'C-21 ★未配置凭据 ⇒ unsupported + 原因（不是"设备离线"，也不编状态）');
      unregisterDeviceProvider('tuya');

      const configured = registerTuyaCloudProvider(
        (k) => (k === TUYA_SETTING_ACCESS_ID ? 'AKID_X' : k === TUYA_SETTING_ACCESS_SECRET ? 'SECRET_X' : null),
        { http: makeHttp({ status: 200, body: JSON.stringify({ success: true, result: { status: [{ code: 'switch_1', value: true }] } }) }) },
      );
      const cs = await configured.getState!('dev-1');
      eq(cs, { ok: true, state: { values: { switch_1: true } } },
        'C-21b 配置齐 ⇒ 注册版走同一 getState 真实现');
    } finally {
      unregisterDeviceProvider('tuya');
    }

    // C-22 设置读口注入（控制路取当前凭据的唯一通道）；清场回匿名。
    try {
      setMqttSettingsProvider((k) => (k === 'device.mqtt.username' ? 'bob' : k === 'device.mqtt.password' ? 'PW' : null));
      eq(currentMqttAuth(), { username: 'bob', password: 'PW', tls: false, rejectUnauthorized: true },
        'C-22 注入设置读口后控制路取到当前凭据（控制窄面没有传 auth 的口）');
    } finally {
      setMqttSettingsProvider(null);
    }
    eq(currentMqttAuth(), { username: '', password: '', tls: false, rejectUnauthorized: true },
      'C-22b 清场 ⇒ 匿名（全局单例不漏到下一条用例）');

    // C-23 接线：面板真调、IPC 真注册、工具体真用、HA 订阅真带凭据。
    const page = strip(DEVICES_PAGE);
    ok(/liveStateOf\(/.test(page) && /liveStateSummary\(/.test(page) && /liveSourceLabel\(/.test(page),
      'C-23 面板真调实时状态投影三函数（不自造摘要）');
    ok(/aggregateDiscoveryErrors\(/.test(page) && /查看明细/.test(page),
      'C-23b 发现告警聚合上屏且明细可展开');
    ok(/devicesApi\.test\('mqtt'\)/.test(page) && /devicesApi\.test\('ha'\)/.test(page)
      && /devicesApi\.test\('tuya'\)/.test(page) && /devicesApi\.test\('http', dev\.id\)/.test(page),
      'C-23c 四个"测试连接"入口都真调 IPC（不是只画按钮）');
    ok(/device\.mqtt\.username/.test(page) && /device\.mqtt\.tls/.test(page)
      && /device\.mqtt\.reject_unauthorized/.test(page) && /password !== ''/.test(page),
      'C-23d 凭据字段可保存；密码留空不覆盖（不拿空串抹掉已配密码）');
    ok(!page.includes('s.password'),
      'C-23e 面板不从状态回包读密码（回包本就没有；输入框只写不读）');

    const ipc = strip(DEVICES_IPC);
    ok(/ipcMain\.handle\('devices:test'/.test(ipc) && /probeMqttBroker\(/.test(ipc)
      && /probeTuya\(/.test(ipc) && /probeHttpEndpoint\(/.test(ipc),
      'C-24 IPC 注册 devices:test 且四路各走真探针');
    // zx_20261022_3 批四：围栏入口由布尔 `isLanAddress` 换为带因由的 `lanAddressRefusal`
    //   （元数据端点须单独说清）。判据**钉更强形状**：面板侧接的正是那一个真源，且不自写第二把尺。
    ok(/lanAddressRefusal\(dev\.address\)/.test(ipc) && !/function isLanAddress\(/.test(ipc),
      'C-24b HTTP 探活沿用局域网围栏（与 device_control 同一把尺，且带拒绝因由）');
    ok(/setMqttSettingsProvider\(/.test(ipc) && /mqttStatusPayload\(/.test(ipc),
      'C-24c IPC 注入设置读口 + 状态回包走唯一落点');
    ok(/devices:test/.test(strip(RENDERER_IPC)),
      'C-24d 渲染层 IPC 客户端声明 devices:test');

    const tool = strip(DEVICE_TOOL);
    ok(/live_source_label/.test(tool) && /live_note/.test(tool),
      'C-25 device_status 载荷给来源说明与无上行说明（模型读得到）');
    const ha = strip(HA_SRC);
    ok(/auth: opts\.auth/.test(ha),
      'C-25b HA 订阅把同一 broker 的凭据传下去（共用 broker 不各读一遍设置）');
  })();
}

// ───────────────────────── D 设备安全收口（批四）─────────────────────────
async function groupD(): Promise<void> {
  // ── D-1 密钥键词表：显式名单 + 后缀兜底，两侧标本 ────────────────────────────
  {
    ok(SECRET_SETTING_KEYS.every((k) => isSecretSettingKey(k)),
      'D-1a 显式名单四键全部判为密钥', SECRET_SETTING_KEYS.join(','));
    ok(['future.svc.app_secret', 'im.x.client_secret', 'device.x.password', 'a.token', 'x_api_key', 'y_secret_key']
      .every((k) => isSecretSettingKey(k)),
      'D-1b 后缀兜底：名字像密钥的新键同样过界即脱敏（不必改名单）');
    ok(['ans_server_url', 'notify_quiet_start', 'im.outbox_retry_min', 'device.mqtt.username', 'secrets_of_old', '', '  ']
      .every((k) => !isSecretSettingKey(k)),
      'D-1c ★反证：非密钥键（含相似词 `secrets_of_old`）一律不脱敏——不拿"像"当"是"');
  }

  // ── D-2 读侧脱敏三态（配置/空/缺 × 密钥/非密钥）─────────────────────────────
  {
    eq(redactedSettingValue('ans_secret_key', '真密钥'), SECRET_MASK,
      'D-2a ★已配置的密钥 ⇒ 只回占位符（明文不过 IPC）');
    eq(redactedSettingValue('ans_secret_key', ''), null,
      'D-2b ★反证：未配置的密钥键 ⇒ `null`（不拿 `***` 谎称已配置）');
    eq(redactedSettingValue('ans_api_key', null), null, 'D-2c 缺行 ⇒ `null`');
    eq(redactedSettingValue('ans_server_url', 'http://h:27183'), 'http://h:27183',
      'D-2d 非密钥键原样（脱敏不得误伤普通设置）');
  }

  // ── D-3 写口挡回：占位符不得覆盖真密钥 ─────────────────────────────────────
  {
    ok(isSecretMaskValue('ans_secret_key', SECRET_MASK), 'D-3a 密钥键 + 占位符 ⇒ 判为"写回占位符"');
    ok(!isSecretMaskValue('ans_secret_key', '真密钥'), 'D-3b ★反证：真实新值照常写');
    ok(!isSecretMaskValue('ans_server_url', SECRET_MASK), 'D-3c ★反证：非密钥键收到 `***` 不算遮挡（不当成密钥）');
  }

  // ── D-4 IPC 接线：读口/状态口/写口/广播四处同一真源 ─────────────────────────
  {
    const admin = strip(ADMIN_IPC);
    ok(/settings:get'[\s\S]{0,400}?redactedSettingValue\(key, row\?\.value \?\? null\)/.test(admin),
      'D-4a `settings:get` 走脱敏（不开第二处判据）');
    ok(/settings:getAll'[\s\S]{0,500}?rows\.forEach\(r => \{ const v = redactedSettingValue\(r\.key, r\.value\); if \(v != null\) map\[r\.key\] = v; \}\)/.test(admin),
      'D-4b ★`settings:getAll` 逐行脱敏，未配置项**不入 map**（null 不冒充值）');
    ok(!/return \{ data: row\?\.value/.test(admin),
      'D-4c ★反证：读口不再原样回明文');
    ok(/settings:secretStatus'[\s\S]{0,400}?for \(const k of SECRET_SETTING_KEYS\) out\[k\] = false/.test(admin),
      'D-4d 新口 `settings:secretStatus` 以同一名单铺满 false（缺行也如实"未配置"）');
    ok(/settings:secretStatus'[\s\S]{0,600}?isSecretSettingKey\(r\.key\)\) out\[r\.key\] = String\(r\.value \?\? ''\) !== ''/.test(admin),
      'D-4e 状态口只回**布尔**（值从 0 变 1 靠数据行驱动，不回明文）');
    ok(/if \(isSecretMaskValue\(key, value\)\) \{[\s\S]{0,200}?code: 'SECRET_MASKED'/.test(admin),
      'D-4f ★写口拒收占位符（旧界面/漏改调用点不得把真密钥覆盖成 `***`）');
    ok(/const emitted = redactedSettingValue\(key, value\) \?\? '';/.test(admin)
      && /webContents\.send\('settings:changed', \{ key, value: emitted \}\)/.test(admin),
      'D-4g ★广播同样脱敏（读口堵了、广播又漏出去＝白堵）');
  }

  // ── D-5 渲染层两页：不回声占位符、留空即不改 ───────────────────────────────
  {
    for (const [tag, page, loadPattern, guardKey] of [
      ['SettingsPage', SETTINGS_PAGE,
        /setAnsConfig\(\{ ans_server_url: all\.ans_server_url \|\| defUrl, ans_api_key: '', ans_secret_key: '' \}\)/,
        'ansConfig.ans_api_key'],
      ['SetupPage', SETUP_PAGE,
        /setAnsForm\(\{ url: all\?\.ans_server_url \|\| defUrl, apiKey: '', secretKey: '' \}\)/,
        'ansForm.apiKey'],
    ] as const) {
      const src = strip(page);
      ok(loadPattern.test(src),
        `D-5a ${tag} 载入即置空密钥输入（不把读口的值回声进表单）`);
      ok(/settings:secretStatus/.test(src), `D-5b ${tag} 从状态口取「是否已配置」`);
      ok(new RegExp(`if \\(${guardKey.replace('.', '\\.')} !== ''\\) await invoke\\('settings:set', 'ans_api_key'`).test(src),
        `D-5c ${tag} 密钥非空才写（留空＝不修改）`);
      ok(/已配置（留空不修改）/.test(read(page)), `D-5d ${tag} 占位文案如实（已配置/未配置可辨）`);
    }
  }

  // ── D-6 地址围栏：云元数据端点先拒，其余局域网照旧 ─────────────────────────
  {
    ok(['169.254.169.254', '169.254.170.2', 'fd00:ec2::254', '[fd00:ec2::254]', ' 169.254.169.254 ']
      .every((a) => isCloudMetadataAddress(a)),
      'D-6a 云元数据端点四形（IMDS / ECS / IPv6 / 带方括号与空白）全部认出');
    ok(['192.168.1.20', '169.254.1.1', '8.8.8.8'].every((a) => !isCloudMetadataAddress(a)),
      'D-6b ★反证：普通私网/链路本地/公网不误判成元数据端点');
    const meta = lanAddressRefusal('169.254.169.254') ?? '';
    ok(meta.includes('云元数据端点') && meta.includes('拒绝出站'),
      'D-6c ★因由单独说清（是"云身份"不是笼统的"非局域网"）', meta);
    ok(!isLanAddress('169.254.169.254') && !isLanAddress('169.254.170.2') && !isLanAddress('[fd00:ec2::254]'),
      'D-6d ★元数据端点一律不放行（先于 169.254/16 的链路本地放行）');
    ok(isLanAddress('169.254.1.1') && isLanAddress('169.254.3.9'),
      'D-6e ★★反证：真链路本地设备仍放行（不是把整段砍掉）');
    ok(isLanAddress('10.0.0.5') && isLanAddress('172.16.3.9') && isLanAddress('192.168.1.20')
      && isLanAddress('127.0.0.1') && isLanAddress('fe80::1') && isLanAddress('printer.local'),
      'D-6f 私网/回环/IPv6 LL/.local 照旧放行');
    ok(!isLanAddress('8.8.8.8') && !isLanAddress('172.32.0.1') && !isLanAddress('example.com') && !isLanAddress(''),
      'D-6g ★反证：公网/越界/主机名/空照旧拒（原有判据不松）');

    const http = await httpDeviceControl(
      { id: 'x', name: 'x', alias: '', kind: 'light', protocol: 'http', address: '169.254.169.254', port: 80, room: '', online: null,
        capabilities: [], controllable: true, authorized: false, status: null, first_seen: '', last_seen: '' },
      'turn_on', {},
    );
    ok(!http.ok && http.result.includes('云元数据端点'),
      'D-6h ★★HTTP 控制对元数据端点**未发请求**即拒（结果即人话因由）', http.result);
    const mq = await defaultDeviceControl(
      { id: 'x', name: 'x', alias: '', kind: 'light', protocol: 'mqtt', address: '169.254.169.254#lamp1', port: 1883, room: '', online: null,
        capabilities: ['mqtt'], controllable: true, authorized: false, status: null, first_seen: '', last_seen: '' },
      'turn_on', {},
    );
    ok(!mq.ok && mq.result.startsWith('MQTT broker：') && mq.result.includes('云元数据端点'),
      'D-6i ★★MQTT 派发核的是 broker（不是设备地址）且同样先拒', mq.result);
    const ipc = strip(DEVICES_IPC);
    ok(/devices:test'[\s\S]{0,2200}?lanAddressRefusal\(dev\.address\)[\s\S]{0,300}?code: 'UNSAFE_ADDRESS'/.test(ipc),
      'D-6j 面板探活与工具体同一把尺（`lanAddressRefusal` 一处真源）');
    ok(!/function isLanAddress\(/.test(ipc) && !/169\.254\.0\.0\/16/.test(ipc),
      'D-6k ★反证：面板不自写第二把尺');
  }

  // ── D-7 主题合法性判据（纯函数，两侧标本）──────────────────────────────────
  {
    eq(MQTT_TOPIC_NAMESPACE, 'workerant/', 'D-7a 命名空间唯一真源');
    eq(validateMqttTopic('workerant/lamp1/set', 'lamp1', true), { ok: true, reason: '' },
      'D-7b 合规自述主题放行');
    const wild = validateMqttTopic('workerant/lamp1/+', 'lamp1', true);
    ok(!wild.ok && wild.reason.includes('通配符'), 'D-7c ★通配符拒（`+`/`#` 都会把命令发到别人的主题）', wild.reason);
    ok(!validateMqttTopic('workerant/lamp1/#', 'lamp1', true).ok, 'D-7d `#` 同拒');
    ok(!validateMqttTopic('workerant/lam\u0001p/set', 'lamp1', true).ok, 'D-7e 控制字符拒');
    ok(!validateMqttTopic('/workerant/lamp1/set', 'lamp1', true).ok
      && !validateMqttTopic('workerant/lamp1/set/', 'lamp1', true).ok
      && !validateMqttTopic('workerant//lamp1/set', 'lamp1', true).ok,
      'D-7f 空层级（首/尾/连续 `/`）拒');
    ok(!validateMqttTopic('home/lamp1/set', 'lamp1', true).ok,
      'D-7g ★自述件须在 `workerant/` 前缀下');
    ok(!validateMqttTopic('workerant/lamp2/set', 'lamp1', true).ok,
      'D-7h ★须含本设备标识（同 broker 上别家设备的主题不得被认领）');
    eq(validateMqttTopic('home/lamp1/set', 'lamp1', false), { ok: true, reason: '' },
      'D-7i ★HA 件只核可发布性（`homeassistant/…` 是 HA 的命名空间，不套工蚁前缀）');
    ok(!validateMqttTopic('', '', true).ok && !validateMqttTopic('workerant/lamp1/' + 'a'.repeat(65536), 'lamp1', true).ok,
      'D-7j 空主题/超长拒');
  }

  // ── D-8 发现映射：自述主题合规才采用，不合规回落 + 可见告警 ─────────────────
  {
    const warns: string[] = [];
    const good = mqttDiscoveryToDevice(
      'workerant/discovery/lamp1',
      JSON.stringify({ id: 'lamp1', name: '客厅灯', kind: 'light',
        cmd: 'workerant/lamp1/set', state: 'workerant/lamp1/state', jattr: 'workerant/lamp1/attr' }),
      '192.168.1.9', 1883, (m) => warns.push(m),
    );
    eq(good?.capabilities, ['mqtt', 'cmd:workerant/lamp1/set', 'state:workerant/lamp1/state', 'jattr:workerant/lamp1/attr'],
      'D-8a 合规自述原样记入（含新增 `jattr:` 属性主题）');
    eq(warns.length, 0, 'D-8b ★反证：合规不放告警（不拿"总是告警"冒充收口）');

    warns.length = 0;
    const bad = mqttDiscoveryToDevice(
      'workerant/discovery/lamp1',
      JSON.stringify({ id: 'lamp1', cmd: 'home/lamp1/set', state: 'workerant/lamp1/#', jattr: 'workerant/other/attr' }),
      '192.168.1.9', 1883, (m) => warns.push(m),
    );
    eq(bad?.capabilities, ['mqtt', 'cmd:lamp1/set'],
      'D-8c ★坏自述：命令主题回落 `<id>/set`；通配符 state / 别家 jattr 一律不采用');
    eq([warns.length, warns[0]?.includes('不合规'), warns[0]?.includes('回落默认主题「lamp1/set」'),
      warns[1]?.includes('不使用该上行主题'), warns[2]?.includes('不使用该上行主题')],
    [3, true, true, true, true],
    'D-8d ★★三条坏自述各记一条可见告警（改道不静默）', warns.join(' | '));
    eq(mqttDiscoveryToDevice('workerant/discovery/lamp1', JSON.stringify({ id: 'lamp1' }), 'h', null)?.capabilities,
      ['mqtt', 'cmd:lamp1/set'],
      'D-8e ★无自述命令主题 ⇒ 仍派生 `<id>/set`（既有设备契约不变）');
  }

  // ── D-9 发布前再校验（防御发现后的脏数据/手工改库）──────────────────────────
  {
    const dev = (caps: string[], address = '192.168.1.9#lamp1'): AnsDevice => ({
      id: 'd-mqtt-1', name: '客厅灯', alias: '', room: '', kind: 'light', protocol: 'mqtt',
      address, port: 1883, capabilities: caps, controllable: true, authorized: true,
      status: null, online: null, first_seen: '', last_seen: '',
    });
    const good = dev(['mqtt', 'cmd:workerant/lamp1/set', 'state:workerant/lamp1/state']);
    eq([mqttCommandTopic(good), mqttCommandTopicWarning(good)], ['workerant/lamp1/set', null],
      'D-9a 合规自述 ⇒ 原样用、无告警');
    const dirty = dev(['mqtt', 'cmd:home/lamp1/set']);
    eq(mqttCommandTopic(dirty), 'lamp1/set', 'D-9b ★脏数据（前缀不合规）⇒ 回落默认主题');
    ok(mqttCommandTopicWarning(dirty)?.includes('已回落默认主题「lamp1/set」'),
      'D-9c ★★回落有话说（告警进控制结果，不静默改道）', mqttCommandTopicWarning(dirty) ?? '');
    const ha = dev(['mqtt', 'ha:light', 'cmd:homeassistant/light/lamp1/set']);
    eq([mqttCommandTopic(ha), mqttCommandTopicWarning(ha)], ['homeassistant/light/lamp1/set', null],
      'D-9d ★HA 件不套工蚁前缀（`homeassistant/…` 照发）');
    const haDirty = dev(['mqtt', 'ha:light', 'cmd:homeassistant/#']);
    eq([mqttCommandTopic(haDirty), mqttCommandTopicWarning(haDirty)?.includes('通配符')],
      ['lamp1/set', true],
      'D-9e ★HA 件同样不得把通配符当发布目标');

    const seen: Array<{ t: string; p: string }> = [];
    const r = await mqttDeviceControl(dirty, 'turn_on', {}, {
      async publish(_d, topic, payload) { seen.push({ t: topic, p: payload }); return { ok: true, ack: null }; },
    });
    ok(r.ok && r.result.startsWith('⚠') && r.result.includes('已回落默认主题'),
      'D-9f ★★控制结果**先给告警**再给人话（用户看得到改道）', r.result);
    eq(seen, [{ t: 'lamp1/set', p: mqttCommandPayloadForTest('turn_on') }],
      'D-9g 告警与改道一致：真发到的是回落主题');
    const r2 = await mqttDeviceControl(good, 'turn_on', {}, { async publish() { return { ok: true, ack: null }; } });
    ok(r2.ok && !r2.result.includes('⚠'), 'D-9h ★反证：合规设备的结果里没有告警噪声');
  }

  // ── D-10 上行主题只收可订阅的（一条脏自述不得让本机订上 `#`）────────────────
  {
    const clean = { capabilities: ['mqtt', 'state:workerant/lamp1/state', 'jattr:workerant/lamp1/attr'] };
    eq(deviceStateTopics(clean), { state: 'workerant/lamp1/state', attributes: 'workerant/lamp1/attr' },
      'D-10a 合规上行主题照订');
    const dirty = { capabilities: ['mqtt', 'state:workerant/#', 'jattr:workerant/lamp1/+'] };
    eq(deviceStateTopics(dirty), { state: null, attributes: null },
      'D-10b ★★通配符上行主题一律丢（否则一条脏自述就让本机订全量）');
  }

  // ── D-11 告警通道真接上（发现 io → onError，0→1）────────────────────────────
  {
    const errors: string[] = [];
    const found: AnsDevice[] = [];
    let emit: ((t: string, p: string) => void) | null = null;
    const fake: MqttSubscribeIo = { subscribe(_topic, cb) { emit = cb; }, stop() {} };
    const dio = mqttDiscoveryIo({
      brokerHost: '192.168.1.9', brokerPort: 1883, io: fake, onError: (m) => errors.push(m),
    });
    dio.start((d) => found.push(d));
    emit!('workerant/discovery/lamp1', JSON.stringify({ id: 'lamp1', cmd: 'home/lamp1/set' }));
    eq([found.length, errors.length], [1, 1],
      'D-11a ★★坏自述仍入账（回落）且告警经既有 `onError` 上屏（0→1 正面断言）');
    ok(errors[0]?.includes('不合规'), 'D-11b 告警原文带因由', errors[0] ?? '');
    eq(found[0]?.capabilities, ['mqtt', 'cmd:lamp1/set'], 'D-11c 入账的正是回落后的主题');
    dio.stop();
  }
}

/** D-9 用：与生产同形的载荷（`{action}`）——不引私有函数，按契约字面构造。 */
function mqttCommandPayloadForTest(action: string): string {
  return JSON.stringify({ action });
}

/* ── E 组夹具：逐列照抄 database.ts 的 wa_external_terminals（含迁移新增列）── */
const TERMINAL_SCHEMA = `
CREATE TABLE wa_external_terminals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  pair_code TEXT NOT NULL,
  key_prefix TEXT,
  secret_hash TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  last_remote_addr TEXT,
  last_seen_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  approved_at TEXT,
  revoked_at TEXT,
  delivered_at TEXT,
  grant_expires_at TEXT
);
`;
function mkTerminalDb(): TerminalDb {
  const d = new DatabaseSync(':memory:');
  d.exec(TERMINAL_SCHEMA);
  return d as unknown as TerminalDb;
}
function termRow(db: TerminalDb, id: string): TerminalRow {
  return db.prepare('SELECT * FROM wa_external_terminals WHERE id = ?').get(id) as TerminalRow;
}

// ─────────────────── E 终端凭据可恢复（批五）───────────────────
function groupE(): void {
  __resetTerminalSecretsForTest();
  {
    const db = mkTerminalDb();
    const { pairingId, pairCode } = createPairRequest(db, '书房的终端', '192.168.1.20');
    eq(approveTerminal(db, pairingId, ['device_control'], { ttlDays: 30 }), { ok: true }, 'E-1a 批准成功');
    const before = termRow(db, pairingId);
    // 模拟**进程重启**：只在内存的明文尽失（库只存 hash，这是硬约束的必然后果）。
    __resetTerminalSecretsForTest();
    eq(pairStatus(db, pairingId, pairCode), { status: 'approved', note: 'credentials_lost' },
      'E-1b 重启后轮询如实回 credentials_lost（不编一把不存在的钥匙）');
    eq(pairStatus(db, pairingId, pairCode), { status: 'approved', note: 'credentials_lost' },
      'E-1c 反复轮询仍是同一句话（重试不会「生出」凭据）');

    // E-2 重签：换钥匙、授权面不动
    const r = reissueTerminalCredential(db, pairingId);
    ok(r.ok === true, 'E-2a 重签成功');
    eq(r.ok ? [r.message.includes('旧凭据已作废'), r.message.includes('下次轮询')] : [false, false], [true, true],
      'E-2b 回话写明「旧凭据已作废 / 新凭据将在终端下次轮询时送达」');
    const after = termRow(db, pairingId);
    ok(after.key_prefix !== before.key_prefix, 'E-2c ★key_prefix 已换（旧钥匙不再在册）');
    ok(after.secret_hash !== before.secret_hash, 'E-2d ★secret_hash 已换（旧 secret 不再有效）');
    ok(after.secret_hash === null || !after.secret_hash.includes('wt_'),
      'E-2e 库中仍是 sha256 形态，未落任何明文钥匙');
    eq(
      [after.delivered_at, after.capabilities_json, after.grant_expires_at, after.approved_at, after.status],
      [null, before.capabilities_json, before.grant_expires_at, before.approved_at, 'approved'],
      'E-2f 授权面不动：仍未送达、能力/到期/批准时刻原样（重签＝换钥匙，不是延长授权）',
    );

    // E-3 取新凭据一次、真能用；旧前缀不再解析出终端
    const s = pairStatus(db, pairingId, pairCode) as { status: string; credentials?: { key: string; secret: string } };
    ok(!!s.credentials?.key && !!s.credentials?.secret, 'E-3a 重签后首次轮询取得新凭据');
    const creds = s.credentials ?? { key: '', secret: '' };
    eq(verifyTerminal(db, creds.key, creds.secret, '192.168.1.20').ok, true, 'E-3b 新凭据通过校验（真能用）');
    eq(pairStatus(db, pairingId, pairCode), { status: 'approved' }, 'E-3c 第二次轮询不再回凭据（仍只此一次）');
    eq(verifyTerminal(db, (before.key_prefix ?? '') + 'x'.repeat(24), 'whatever'), { ok: false, status: 401, reason: 'unknown_key' },
      'E-3d ★旧 key 前缀查无此行（旧钥匙整把失效，不是只换了一半）');

    // E-4 已送达 ⇒ 不重签（换钥匙等于把一台好好能用的终端踢出门）
    eq(reissueTerminalCredential(db, pairingId), { ok: false, reason: 'already_delivered' },
      'E-4a ★已送达终端不得重签');
  }

  // E-5 状态不符如实拒（不静默改状态）
  {
    const db = mkTerminalDb();
    const p = createPairRequest(db, '还在等人的终端');
    eq(reissueTerminalCredential(db, p.pairingId), { ok: false, reason: 'not_approved:pending' },
      'E-5a pending 状态下重签被拒');
    approveTerminal(db, p.pairingId, []);
    revokeTerminal(db, p.pairingId);
    eq(reissueTerminalCredential(db, p.pairingId), { ok: false, reason: 'not_approved:revoked' },
      'E-5b 已吊销终端重签被拒（要复位请重新配对）');
    eq(reissueTerminalCredential(db, 'no-such-terminal'), { ok: false, reason: 'not_found' },
      'E-5c 不存在的终端被拒');
  }

  // E-6 接线：main 出口 + 拒因人话 + 面板按钮（只在「未送达」出现，且不是自动触发）
  {
    const ipc = strip(EXTERNAL_IPC);
    ok(/ipcMain\.handle\('external:reissue'/.test(ipc), 'E-6a main 注册了 external:reissue 出口');
    ok(/reissueTerminalCredential\(tdb,/.test(ipc), 'E-6b 走同一个 core 编排（无第二份状态机）');
    // 拒因→人话的**唯一一处**在 core（zx_20261030_1 M8 起）：main 出口只转调、不自带第二份映射——
    // 两处各写一遍正是 `capacity:` 机器前缀漏上屏的来路。
    const terminalsCore = strip(EXTERNAL_TERMINALS_CORE);
    ok(/already_delivered/.test(terminalsCore), 'E-6c already_delivered 有专门人话（不是 INTERNAL 兜底）');
    ok(/terminalReasonToError/.test(ipc) && !/function reasonToError/.test(ipc),
      'E-6c2 main 出口转调 core 的唯一映射（不自带第二份）');
    ok(/emitExternalStatusChanged\('external:reissue'/.test(ipc), 'E-6d 重签后广播刷新（面板不等轮询）');
    const rIpc = strip(RENDERER_IPC);
    ok(/reissue: \(terminalId: string\) => ipcCall<\{ ok: true; message\?: string \}>\('external:reissue'/.test(rIpc),
      'E-6e renderer ipc 有 reissue 且回包带 message');
    const page = read(PEERS_PAGE);
    ok(/\{!t\.delivered && \(/.test(page), 'E-6f 按钮只在「未送达」时出现');
    ok(/重新签发凭据/.test(page), 'E-6g 按钮文案是用户能懂的动作名');
    eq((page.match(/externalApi\.reissue\(/g) ?? []).length, 1, 'E-6h 重签恰有一处调用点（只在点击处理里，不在轮询/effect 中）');
    ok(/旧凭据已作废|下次轮询/.test(page), 'E-6i 结果区把下一步告诉用户');
  }
}

// ─────────────────── F 模型降级不丢硬需（批六）───────────────────
const MODEL_SELECT_SRC = `${A}/src/main/core/exec-model-select.ts`;
const MODEL_REQUEST_SRC = `${A}/src/main/core/model-request.ts`;
const SETTINGS_BOOL_SRC = `${A}/src/main/core/settings-bool.ts`;
const GATEWAY_SRC = 'apps/ans-server/src/routes/gateway.ts';

/**
 * 选型夹具：只建 `selectModelForTask` 真会读的表（逐列照抄，不放宽）。
 * IM 三表使 `pushImNotify` 能**真解析出目标**并落意图账——否则"通知了"只能断言"不抛"。
 */
const MODEL_SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT, content TEXT, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT, status TEXT DEFAULT 'active');
CREATE TABLE wa_im_conversations (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, direction TEXT, message_json TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_im_notify_log (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, kind TEXT, suppressed INTEGER DEFAULT 0, at INTEGER);
`;
function mkModelDb(): AnyDb {
  const d = new DatabaseSync(':memory:');
  d.exec(MODEL_SCHEMA);
  d.prepare("INSERT INTO wa_im_channels (id, channel_type, status) VALUES ('ch1','wechat','active')").run();
  d.prepare('INSERT INTO wa_im_conversations (id, channel_id, external_user_id, direction, message_json) VALUES (?,?,?,?,?)')
    .run('c1', 'ch1', 'u1', 'inbound', JSON.stringify({ chat_type: 'direct' }));
  return d as unknown as AnyDb;
}
const setSetting = (db: AnyDb, key: string, value: string): void => {
  db.prepare('INSERT OR REPLACE INTO wa_settings (key, value) VALUES (?, ?)').run(key, value);
};
/** 任务上下文带一件**图片**：`deriveModelCapabilities` 因此要求硬需 `vision`（不是写死的清单）。 */
const VISION_TASK_CTX = JSON.stringify({ attachments: [{ path: '/nonexistent/photo.png', fileName: 'photo.png' }] });
const convContents = (db: AnyDb, taskId: string): string[] =>
  (db.prepare('SELECT content FROM wa_task_conversations WHERE task_id = ? ORDER BY rowid').all(taskId) as Array<{ content: string }>)
    .map((r) => r.content);
const modelReply = (tier2Caps: string[], tier3Caps: string[] | null): Record<string, unknown> => ({
  id: 'm-main',
  url: 'https://main.example/v1',
  api_key: 'k-main',
  model_name: 'main-model',
  capabilities: ['chat', 'function-calling', 'vision'],
  context_window: 128000,
  sameProviderFallback: {
    url: 'https://t2.example/v1', api_key: 'k2', model_name: 't2-model',
    capabilities: tier2Caps, context_window: 128000,
  },
  crossProviderFallback: tier3Caps
    ? { url: 'https://t3.example/v1', api_key: 'k3', model_name: 't3-model', capabilities: tier3Caps, context_window: 128000 }
    : null,
});

async function groupF(): Promise<void> {
  // F-0 两条判据各司其职：缺省即开 vs 缺省关（同一张表、同一条缺失值，结论必须相反）。
  {
    const db = mkModelDb();
    eq(
      [readBoolSetting(db, 'engine.capability_strict_fallback'), readBoolSettingDefaultOff(db, 'engine.capability_strict_fallback')],
      [true, false],
      'F-0a ★同一未配置键：缺省即开判据读真、缺省关判据读假（严格模式不会因"没设过"被悄悄点开）',
    );
    setSetting(db, 'engine.capability_strict_fallback', '1');
    eq(readBoolSettingDefaultOff(db, 'engine.capability_strict_fallback'), true, 'F-0b 历史写法 1 认作开');
    setSetting(db, 'engine.capability_strict_fallback', 'on');
    eq(readBoolSettingDefaultOff(db, 'engine.capability_strict_fallback'), true, 'F-0c 历史写法 on 认作开');
    setSetting(db, 'engine.capability_strict_fallback', 'false');
    eq(readBoolSettingDefaultOff(db, 'engine.capability_strict_fallback'), false, 'F-0d false 认作关');
    setSetting(db, 'engine.capability_strict_fallback', '');
    eq(readBoolSettingDefaultOff(db, 'engine.capability_strict_fallback'), false, 'F-0e 脏值（空串）按缺省关办');
    ok(BOOL_SETTING_KEYS.includes('engine.capability_strict_fallback'), 'F-0f 开关在布尔键白名单内（规范化迁移会把它写成 true/false 单一写法）');
  }

  // F-0g 降级后果人话：只对**硬需**成文；软需/空不编后果。
  {
    const vision = hardCapabilityDegradeNote(['vision']);
    const fc = hardCapabilityDegradeNote(['function-calling']);
    ok(vision.includes('图片附件将被省略'), 'F-0g vision 的后果说得出「图看不见」');
    ok(fc.includes('工具调用不可用'), 'F-0h function-calling 的后果说得出「工具调不动」');
    eq(hardCapabilityDegradeNote(['code', 'reasoning']), '', 'F-0i 软需缺不产生降级后果文案（各判据分档）');
    eq(hardCapabilityDegradeNote([]), '', 'F-0j 无缺口不成文');
    const short = fallbackCapabilityShortfall({
      modelName: 'm-x', demand: ['chat', 'vision'], got: ['chat'], hardMissing: ['vision'],
    });
    eq(
      [short.includes('m-x'), short.includes('缺本任务硬需能力 [vision]'), short.includes('其能力清单为 [chat]')],
      [true, true, true],
      'F-0k 备用缺口话术三段俱到（谁/缺什么/实得什么），且由具名函数一处成文',
    );
  }

  const realFetch = globalThis.fetch;
  // 探活只认 t2/t3 可达：主端点恒不可用，把流程逼进三级降级链。
  globalThis.fetch = (async (input: unknown) =>
    ({ ok: String(input).includes('t2.') || String(input).includes('t3.') }) as Response) as typeof fetch;
  try {
    const base = 'task-F';

    // F-1 能力齐全优先：tier2 缺 vision、tier3 全齐 ⇒ 选 tier3（哪怕 tier2 排名更靠前）
    {
      const db = mkModelDb();
      const ans: AnsClientLike = { getOptimalModel: async () => modelReply(['chat', 'function-calling'], ['chat', 'function-calling', 'vision']) };
      const r = await selectModelForTask({
        db, taskId: `${base}-1`, projectId: 'p1', taskCtxJson: VISION_TASK_CTX,
        ansClient: ans, archetype: 'code', modelStrategy: 'balanced',
      });
      ok(!('stopped' in r), 'F-1a 选型完成（未拦）');
      const name = 'stopped' in r ? '' : String(r.modelResult.model_name);
      eq(name, 't3-model', 'F-1b ★备用里能力齐的那一跳被优先选中（不按 tier2 偶然次序跳过）');
      eq(convContents(db, `${base}-1`).filter((c) => c.startsWith('[降级选型]')).length, 0,
        'F-1c 选中的那一跳不缺硬需 ⇒ 不写降级选型行（无病不报）');
    }

    // F-1d 对照面：tier2 本身全齐 ⇒ 仍选 tier2（"能力齐全优先"不改变既有排序）
    {
      const db = mkModelDb();
      const ans: AnsClientLike = { getOptimalModel: async () => modelReply(['chat', 'function-calling', 'vision'], ['chat', 'function-calling', 'vision']) };
      const r = await selectModelForTask({
        db, taskId: `${base}-2`, projectId: 'p1', taskCtxJson: VISION_TASK_CTX,
        ansClient: ans, archetype: 'code', modelStrategy: 'balanced',
      });
      const name = 'stopped' in r ? '' : String(r.modelResult.model_name);
      eq(name, 't2-model', 'F-1d 首选备用已齐 ⇒ 不越级（偏好只在"能避免降级"时起作用）');
    }

    // F-2 缺省关：降级继续，但**可见**（会话行 + IM 意图账 0→1）
    {
      const db = mkModelDb();
      const ans: AnsClientLike = { getOptimalModel: async () => modelReply(['chat', 'function-calling'], ['chat', 'function-calling']) };
      let threw = '';
      let r: Awaited<ReturnType<typeof selectModelForTask>> | null = null;
      try {
        r = await selectModelForTask({
          db, taskId: `${base}-3`, projectId: 'p1', taskCtxJson: VISION_TASK_CTX,
          ansClient: ans, archetype: 'code', modelStrategy: 'balanced',
        });
      } catch (e) { threw = (e as Error).message; }
      eq(threw, '', 'F-2a ★未配置严格备用（缺省关）⇒ 不抛，任务照常开工');
      const lines = convContents(db, `${base}-3`);
      const degrade = lines.filter((c) => c.startsWith('[降级选型]'));
      eq(degrade.length, 1, 'F-2b 恰写一条 [降级选型]（第二本账不另立）');
      ok(degrade[0]?.includes('缺本任务硬需能力 [vision]') === true, 'F-2c 写清缺哪项（vision）');
      ok(degrade[0]?.includes('图片附件将被省略') === true, 'F-2d 写清这单会怎样降级（后果，不是术语）');
      ok(degrade[0]?.includes('严格备用') === true, 'F-2e 告知用户可改为如实拒（动作可达）');
      eq(lines.filter((c) => c.startsWith('[选型失败]')).length, 0, 'F-2f 缺省关时不写选型失败');
      const intent = db.prepare("SELECT COUNT(*) AS c FROM wa_im_notify_log WHERE kind = 'model_degrade'").get() as { c: number };
      eq(intent.c, 1, 'F-2g ★IM 意图账 0→1：降级经用户可达通道告知（不是只写日志）');
      const notifyRow = db.prepare("SELECT task_id FROM wa_im_notify_log WHERE kind = 'model_degrade'").get() as { task_id: string } | undefined;
      eq(notifyRow?.task_id, `${base}-3`, 'F-2h 意图账指向本任务（不是别的任务的账）');
      ok(!('stopped' in (r as object)), 'F-2i 返回的是选型结果');
      const picked = r as Awaited<ReturnType<typeof selectModelForTask>>;
      eq('stopped' in picked ? '' : picked.modelCapabilities, ['chat', 'function-calling'],
        'F-2j 回传的清单是**实际在用**那一跳的（下游据此省略图片，而不是按首选清单误判有 vision）');
    }

    // F-3 严格模式：如实拒，不静默降级；且**不**消耗一条 IM 通知（拒在告知前）
    for (const [value, label] of [['true', 'true'], ['1', '1']] as const) {
      const db = mkModelDb();
      setSetting(db, 'engine.capability_strict_fallback', value);
      const ans: AnsClientLike = { getOptimalModel: async () => modelReply(['chat', 'function-calling'], ['chat', 'function-calling']) };
      let threw = '';
      try {
        await selectModelForTask({
          db, taskId: `${base}-4-${label}`, projectId: 'p1', taskCtxJson: VISION_TASK_CTX,
          ansClient: ans, archetype: 'code', modelStrategy: 'balanced',
        });
      } catch (e) { threw = (e as Error).message; }
      ok(threw.startsWith('[选型失败]'), `F-3a 严格备用=${label} ⇒ 如实拒（[选型失败] 开头）`);
      ok(threw.includes('严格备用'), `F-3b 严格备用=${label} ⇒ 拒因说得出是哪把开关`);
      const lines = convContents(db, `${base}-4-${label}`);
      eq(lines.filter((c) => c.startsWith('[选型失败]')).length, 1, `F-3c 严格备用=${label} ⇒ 会话里恰一条选型失败`);
      eq(lines.filter((c) => c.startsWith('[降级选型]')).length, 0, `F-3d 严格备用=${label} ⇒ 不写「降级继续」`);
      const intent = db.prepare("SELECT COUNT(*) AS c FROM wa_im_notify_log WHERE kind = 'model_degrade'").get() as { c: number };
      eq(intent.c, 0, `F-3e 严格备用=${label} ⇒ 不先发一条"降级"再拒（账与行为一致）`);
    }

    // F-3f 显式 false ⇒ 回到"降级继续"（开关能关得掉）
    {
      const db = mkModelDb();
      setSetting(db, 'engine.capability_strict_fallback', 'false');
      const ans: AnsClientLike = { getOptimalModel: async () => modelReply(['chat', 'function-calling'], null) };
      let threw = '';
      try {
        await selectModelForTask({
          db, taskId: `${base}-5`, projectId: 'p1', taskCtxJson: VISION_TASK_CTX,
          ansClient: ans, archetype: 'code', modelStrategy: 'balanced',
        });
      } catch (e) { threw = (e as Error).message; }
      eq(threw, '', 'F-3f 显式 false ⇒ 不抛（一键回退可用）');
    }

    // F-4 接线：读端用**缺省关**那一条；网关补同一把上下文尺；面板可控
    {
      const src = strip(MODEL_SELECT_SRC);
      ok(/readBoolSettingDefaultOff\(db, 'engine\.capability_strict_fallback'\)/.test(src),
        'F-4a 引擎读本键走 readBoolSettingDefaultOff（缺省关判据）');
      ok(!/readBoolSetting\(db, 'engine\.capability_strict_fallback'\)/.test(src),
        'F-4b ★没有一处用"缺省即开"判据读本键（同一键两把尺即本轮病根）');
      ok(/pushImNotify\(db, taskId, line, 'model_degrade'\)/.test(src), 'F-4c 降级经既有 IM 通知通道发出');
      const sb = strip(SETTINGS_BOOL_SRC);
      ok(/export function readBoolSettingDefaultOff/.test(sb), 'F-4d 缺省关判据是具名导出（可被回归直跑）');
      const mr = strip(MODEL_REQUEST_SRC);
      ok(/export function hardCapabilityDegradeNote/.test(mr), 'F-4e 后果文案是零依赖纯函数（措辞一处）');
      ok(/fallbackCapabilityShortfall\(/.test(src) && !src.includes('本任务硬需能力'),
        'F-4l ★执行体不另抄缺口话术：调 `fallbackCapabilityShortfall`，段内零该短语字面量');
      ok(/export function fallbackCapabilityShortfall/.test(mr),
        'F-4m 备用缺口话术与最终闸话术同住 `model-request.ts`（两句事实不同、三段结构同尺）');
      const gw = strip(GATEWAY_SRC);
      ok(/minContextWindow: t\.Optional\(t\.Number\(\)\)/.test(gw), 'F-4f /gateway/chat body schema 收 minContextWindow');
      ok(/minContextWindow \}/.test(gw), 'F-4g 网关把 minContextWindow 真传给匹配器（收而不传=假接线）');
      const page = read(SETTINGS_PAGE);
      ok(/toggleStrictFallback/.test(page), 'F-4h 设置页有严格备用的写入口');
      ok(/<Switch on=\{strictFallback\} onToggle=\{toggleStrictFallback\} \/>/.test(page), 'F-4i 设置页开关已渲染（承诺的开关须点得到）');
      ok(/sf === 'true' \|\| sf === '1' \|\| sf === 'on'/.test(page), 'F-4j 面板读端与引擎同口径认三种"开"写法');
      ok(/engine\.capability_strict_fallback', on \? 'true' : 'false'/.test(page), 'F-4k 面板写入 true/false 与规范化迁移同写法');
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ─────────────────── G 知识包往返（批七）───────────────────
const KNOWLEDGE_SRC = `${A}/src/main/core/project-knowledge.ts`;
const KNOWLEDGE_EXPORT_SRC = `${A}/src/main/core/knowledge-export.ts`;
const KNOWLEDGE_IMPORT_SRC = `${A}/src/main/core/knowledge-import.ts`;
const KNOWLEDGE_IPC_SRC = `${A}/src/main/ipc/knowledge.ipc.ts`;
const KNOWLEDGE_CARD = `${A}/renderer/src/components/KnowledgePackCard.tsx`;
const DB_SRC = `${A}/src/main/database.ts`;
const PROJECT_ENGINE_SRC = `${A}/src/main/core/project-engine.ts`;
const CORE_DIR = `${A}/src/main/core`;

/**
 * 夹具：只建导入/导出/读册**真会触达**的表，列形状照抄 `database.ts`（不放宽）。
 * ⚠ 导入表两兄弟**必须建**：`listProjectKnowledge` 合并读它们，漏建即抛（不让夹具比生产宽松）。
 * ⚠ `node:sqlite` 无 `db.transaction()` 而 `importKnowledgeForProject` 内含一支事务 ⇒ 补垫片。
 */
const KNOWLEDGE_SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, description TEXT, working_dir TEXT, context_json TEXT DEFAULT '{}');
CREATE TABLE wa_project_knowledge (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, section TEXT NOT NULL, content TEXT NOT NULL,
  source_ref TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_wa_project_knowledge_sec ON wa_project_knowledge(project_id, section);
CREATE TABLE wa_project_knowledge_imports (
  project_id TEXT NOT NULL, section TEXT NOT NULL, content TEXT NOT NULL,
  precedence INTEGER NOT NULL DEFAULT 0, source_hash TEXT NOT NULL DEFAULT '',
  imported_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, section));
CREATE TABLE wa_knowledge_imports (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_project_id TEXT DEFAULT '',
  source_hash TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'merge',
  sections INTEGER NOT NULL DEFAULT 0, imported INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0, conflicts INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT DEFAULT (datetime('now')));
`;
function mkKnowledgeDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(KNOWLEDGE_SCHEMA);
  (d as unknown as { transaction: (fn: () => void) => () => void }).transaction = (fn) => () => fn();
  for (const id of ['p-a', 'p-b', 'p-c', 'p-d', 'p-e']) {
    d.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run(id, id);
  }
  return d;
}
/** 许可判据注入固定 now/指纹：不碰墙钟、不碰本机（与生产同一条 `resolveLicenseState` 链）。 */
const KNOWLEDGE_NOW = new Date('2026-10-22T03:00:00.000Z');
const KNOWLEDGE_LICENSE = { now: KNOWLEDGE_NOW, fingerprint: 'RR-0000-0000-0000' };
const setSettingK = (d: DatabaseSync, key: string, value: string): void => {
  d.prepare('INSERT OR REPLACE INTO wa_settings (key, value) VALUES (?, ?)').run(key, value);
};
/** 试用期 = 专业版能力（与生产同一判据；起算点固定在 2 天前，14 天内）。 */
const enableKnowledgeTrial = (d: DatabaseSync): void =>
  setSettingK(d, LICENSE_SETTING_KEYS.trialStartedAt, '2026-10-20T00:00:00.000Z');
const seedDerived = (d: DatabaseSync, pid: string, section: string, content: string, sourceRef = 'rr_fixture'): void => {
  d.prepare(
    'INSERT OR REPLACE INTO wa_project_knowledge (id, project_id, section, content, source_ref) VALUES (?, ?, ?, ?, ?)',
  ).run(`k-${pid}-${section}`, pid, section, content, sourceRef);
};
const bookOf = (d: DatabaseSync, pid: string): Array<{ section: string; content: string }> =>
  listProjectKnowledge(d as never, pid).map((e) => ({ section: e.section, content: e.content }));
/** 导入侧会碰的两张表各自的真实行数（「零写入」须以此断言，不以"不抛"代替）。 */
const knowledgeCounts = (d: DatabaseSync, pid: string): number[] => [
  (d.prepare('SELECT COUNT(*) AS c FROM wa_project_knowledge_imports WHERE project_id = ?').get(pid) as { c: number }).c,
  (d.prepare('SELECT COUNT(*) AS c FROM wa_knowledge_imports WHERE project_id = ?').get(pid) as { c: number }).c,
];
/** 造一份**形状合法**的包文本（与 `writeKnowledgeExport` 同形：包头 + 每节一行）。 */
const packText = (sections: Array<[string, string]>, projectId = 'p-src'): string => {
  const at = KNOWLEDGE_NOW.toISOString();
  const rows = sections.map(([section, content]) => JSON.stringify({
    instruction: 'x',
    input: 'x',
    output: content,
    meta: { source: 'knowledge_pack', project_id: projectId, section, generated_at: at },
    training: false,
  }));
  return [JSON.stringify(knowledgePackHeader(projectId, at, rows.length)), ...rows].join('\n') + '\n';
};
function mustParse(text: string): KnowledgePackage {
  const r = parseKnowledgePackage(text);
  if (!r.ok) throw new Error(`夹具包不合法：${r.code} ${r.message}`);
  return r.pkg;
}

function groupG(): void {
  // G-1 出门再进门：导出 → 解析 → 导入新项目，两册逐节内容一致；G-2 二次导入零变化；G-7 空册边界。
  {
    const db = mkKnowledgeDb();
    enableKnowledgeTrial(db);
    seedDerived(db, 'p-a', 'entities', '客厅 ─[位于]→ 一楼', 'wa_knowledge_triples');
    seedDerived(db, 'p-a', 'artifacts', 'code:2 · doc:1', 'wa_deliverables');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261022-3-'));
    try {
      const out = writeKnowledgeExport('p-a', listProjectKnowledge(db as never, 'p-a'), dir, KNOWLEDGE_NOW);
      eq(out.rows, 2, 'G-1a 导出只数节行：两节 ⇒ rows=2（包头不计入）');
      ok(path.dirname(out.filePath).endsWith(KNOWLEDGE_EXPORT_DIR) && path.basename(out.filePath).startsWith('p-a-'),
        'G-1b 落盘在 knowledge_exports 目录、文件名带项目 id');
      const text = fs.readFileSync(out.filePath, 'utf-8');
      const lines = text.trimEnd().split('\n');
      const header = JSON.parse(lines[0]!) as Record<string, unknown>;
      eq([header.kind, header.version, header.sections, header.training],
        [KNOWLEDGE_PACK_KIND, KNOWLEDGE_PACK_VERSION, 2, false],
        'G-1c ★首行是自描述包头（kind/version/sections/training 四键如实），导入侧只认它');
      ok(lines.slice(1).every((l) => JSON.parse(l).training === false),
        'G-1d 每节行仍带 training:false（仅导出，不训练）');

      const parsed = parseKnowledgePackage(text);
      ok(parsed.ok, 'G-1e 自产包能被导入侧整包识别（往返闭合）');
      if (parsed.ok) {
        eq(parsed.pkg.sections.map((s) => s.section), ['entities', 'artifacts'],
          'G-1f 包内节名与次序如实（不猜、不补空节）');
        eq(parsed.pkg.projectId, 'p-a', 'G-1g 包记来源项目 id（账可回查）');
        const r = importKnowledgeForProject(db as never, 'p-b', parsed.pkg, { license: KNOWLEDGE_LICENSE });
        ok(r.ok, 'G-1h 试用档导入成功（走真 Pro 判据链）');
        if (r.ok) {
          eq([r.result.imported, r.result.skipped, r.result.conflicts, r.result.sections, r.result.mode],
            [2, 0, 0, 2, 'merge'], 'G-1i 首次导入：写入 2 / 跳过 0 / 冲突 0（缺省 merge）');
          eq(r.result.sourceHash.length, 64, 'G-1j 导入账记原文 sha256（64 位十六进制）');
        }
        eq(bookOf(db, 'p-b'), bookOf(db, 'p-a'),
          'G-1k ★导出 → 新项目导入：两册逐节内容一致（搬过来的是同一本书）');
        const refs = listProjectKnowledge(db as never, 'p-b').map((e) => e.sourceRef);
        eq(refs, [`knowledge_import:${parsed.pkg.sourceHash.slice(0, 12)}`, `knowledge_import:${parsed.pkg.sourceHash.slice(0, 12)}`],
          'G-1l 导入节出处如实标 knowledge_import:<hash12>（不冒充本项目派生）');
        const ledger = listKnowledgeImports(db as never, 'p-b');
        eq(ledger.length, 1, 'G-1m 导入账 0→1（有写口就有读口）');
        eq([ledger[0]!.source_project_id, ledger[0]!.mode, ledger[0]!.imported, ledger[0]!.sections],
          ['p-a', 'merge', 2, 2], 'G-1n 账记来源项目/模式/写入数/包内节数');

        // G-2 同一份包再导一次：知识零变化，只多一行审计。
        const before = JSON.stringify(bookOf(db, 'p-b'));
        const r2 = importKnowledgeForProject(db as never, 'p-b', parsed.pkg, { license: KNOWLEDGE_LICENSE });
        ok(r2.ok, 'G-2a 二次导入不报错（幂等而非拒绝）');
        if (r2.ok) {
          eq([r2.result.imported, r2.result.skipped, r2.result.conflicts], [0, 2, 0],
            'G-2b ★二次导入零变化：写入 0 / 跳过 2 / 冲突 0');
        }
        eq(JSON.stringify(bookOf(db, 'p-b')), before, 'G-2c 册内容一字节不变（幂等判据看节，不看账）');
        const led2 = listKnowledgeImports(db as never, 'p-b');
        eq([led2.length, led2[0]!.imported], [2, 0],
          'G-2d 审计多一行且最近一行是第二次（写入 0）——"有人导过一次"不是知识变化');
      }

      // G-7 空册往返的边界：导得出、导不回，且拒因说得出。
      const emptyOut = writeKnowledgeExport('p-empty', [], dir, KNOWLEDGE_NOW);
      eq(emptyOut.rows, 0, 'G-7a 空册 rows=0（不伪造占位行）');
      const emptyParsed = parseKnowledgePackage(fs.readFileSync(emptyOut.filePath, 'utf-8'));
      ok(!emptyParsed.ok && emptyParsed.code === 'EMPTY',
        'G-7b ★空册导出只有包头 ⇒ 导入侧如实拒「没有可导入的知识」（不是无法归类的空文件）');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // G-3 冲突两模式：merge 不覆盖（派生者胜）、replace 覆盖（precedence=1 胜此后派生）。
  {
    const db = mkKnowledgeDb();
    enableKnowledgeTrial(db);
    seedDerived(db, 'p-c', 'entities', 'OLD-ENTITIES');
    const pkg = mustParse(packText([['entities', 'PKG-ENTITIES'], ['artifacts', 'PKG-ARTIFACTS']]));
    const r = importKnowledgeForProject(db as never, 'p-c', pkg, { license: KNOWLEDGE_LICENSE });
    ok(r.ok, 'G-3a merge 导入完成');
    if (r.ok) {
      eq([r.result.imported, r.result.skipped, r.result.conflicts], [1, 0, 1],
        'G-3b ★merge：缺的节补上（1）、同名不同内容记冲突且不覆盖（1）');
    }
    const afterMerge = new Map(listProjectKnowledge(db as never, 'p-c').map((e) => [e.section, e.content]));
    eq(afterMerge.get('entities'), 'OLD-ENTITIES', 'G-3c 冲突节保留本项目内容（合并模式不夺权）');
    eq(afterMerge.get('artifacts'), 'PKG-ARTIFACTS', 'G-3d 缺的节真补进来（不只是计数好看）');
    eq(
      (db.prepare('SELECT section, precedence FROM wa_project_knowledge_imports WHERE project_id = ? ORDER BY section')
        .all('p-c') as Array<{ section: string; precedence: number }>)
        .map((x) => ({ section: String(x.section), precedence: Number(x.precedence) })),
      [{ section: 'artifacts', precedence: 0 }],
      'G-3e merge 只写补进来的那一节（precedence=0）；被冲突挡下的节不写行',
    );
    // precedence 0 不压派生：本项目此后又发生同样的事实 ⇒ 派生（更新）者胜。
    seedDerived(db, 'p-c', 'artifacts', 'NEW-FACT');
    eq(new Map(listProjectKnowledge(db as never, 'p-c').map((e) => [e.section, e.content])).get('artifacts'),
      'NEW-FACT',
      'G-3f ★precedence 0：项目新派生的事实胜过合并带进来的旧内容（旧包不压新事实）');

    const db2 = mkKnowledgeDb();
    enableKnowledgeTrial(db2);
    seedDerived(db2, 'p-d', 'entities', 'OLD-ENTITIES');
    const pkg2 = mustParse(packText([['entities', 'PKG-ENTITIES'], ['artifacts', 'PKG-ARTIFACTS']]));
    const r3 = importKnowledgeForProject(db2 as never, 'p-d', pkg2, { mode: 'replace', license: KNOWLEDGE_LICENSE });
    ok(r3.ok, 'G-3g replace 导入完成');
    if (r3.ok) {
      eq([r3.result.imported, r3.result.skipped, r3.result.conflicts, r3.result.mode], [2, 0, 0, 'replace'],
        'G-3h ★replace：同名不同内容被覆盖、缺的补上，冲突不计（显式覆盖不是冲突）');
    }
    const pref = db2.prepare(
      'SELECT precedence FROM wa_project_knowledge_imports WHERE project_id = ? AND section = ?',
    ).get('p-d', 'entities') as { precedence: number } | undefined;
    eq(Number(pref?.precedence), 1, 'G-3i 覆盖由 precedence=1 表达（读侧同一判据，不另设标志）');
    seedDerived(db2, 'p-d', 'entities', 'EVEN-NEWER');
    eq(new Map(listProjectKnowledge(db2 as never, 'p-d').map((e) => [e.section, e.content])).get('entities'),
      'PKG-ENTITIES',
      'G-3j ★precedence 1：显式覆盖胜过此后派生（与 G-3f 两种优先级各一只标本）');
  }

  // G-4 Pro 闸：社区档拒且零写入（连账不写）；闸在项目存在性之前；试用放行；注入不挂闸。
  {
    const db = mkKnowledgeDb(); // 无许可、无试用 ⇒ community
    const pkg = mustParse(packText([['entities', 'X']]));
    const r = importKnowledgeForProject(db as never, 'p-e', pkg, { license: KNOWLEDGE_LICENSE });
    ok(!r.ok && r.code === 'FEATURE_REQUIRED', 'G-4a 社区档导入被拒（FEATURE_REQUIRED）');
    ok(!r.ok && r.message.includes(PRO_FEATURE_LABEL.knowledge_import),
      'G-4b 拒因说得出是哪项能力（原样可上屏）');
    eq(knowledgeCounts(db, 'p-e'), [0, 0],
      'G-4c ★拒时两表皆零写入（连导入账都不写——拒在动作之前）');
    const ghost = importKnowledgeForProject(db as never, 'p-missing', pkg, { license: KNOWLEDGE_LICENSE });
    ok(!ghost.ok && ghost.code === 'FEATURE_REQUIRED',
      'G-4d 闸在项目存在性之前（社区档不泄露"项目在不在"）');

    enableKnowledgeTrial(db);
    const t = importKnowledgeForProject(db as never, 'p-e', pkg, { license: KNOWLEDGE_LICENSE });
    ok(t.ok && t.result.imported === 1, 'G-4e 试用期内放行（0→1；试用=专业版能力，同一判据链）');

    const expired = mkKnowledgeDb();
    setSettingK(expired, LICENSE_SETTING_KEYS.trialStartedAt, '2026-08-01T00:00:00.000Z');
    const e2 = importKnowledgeForProject(expired as never, 'p-e', pkg, { license: KNOWLEDGE_LICENSE });
    ok(!e2.ok && e2.code === 'FEATURE_REQUIRED', 'G-4f 试用过期 ⇒ 回落社区档并如实拒');

    // 闸只挡"搬运"，不挡"使用"：社区档照样预览/注入已在本册的知识。
    const community = mkKnowledgeDb();
    seedDerived(community, 'p-a', 'entities', '社区档仍可注入');
    const pv = previewProjectKnowledge(community as never, 'p-a');
    ok(pv.selected.length === 1 && pv.selected[0]!.content === '社区档仍可注入',
      'G-4g ★社区档预览/注入照常（降档不会把已经知道的知识废掉）');
    eq(projectKnowledgeGateCalls(), [], 'G-4h 知识册读侧/预览/注入零闸调用（一处也没有）');
  }

  // G-5 畸形包**原子拒**：每种错都有自己的码；拒绝发生在写入之前（两表零写入）。
  {
    const db = mkKnowledgeDb();
    enableKnowledgeTrial(db);
    const good = packText([['entities', 'A']]);
    const goodHeader = JSON.parse(good.split('\n')[0]!) as Record<string, unknown>;
    const goodRow = good.split('\n')[1]!;
    const cases: Array<[string, string, string]> = [
      ['EMPTY', '', '空文本'],
      ['EMPTY', packText([]), '只有包头、无一节'],
      ['TOO_LARGE', 'x'.repeat(KNOWLEDGE_PACK_MAX_CHARS + 1), '超字符上限'],
      ['BAD_HEADER', '{not json', '首行不是 JSON'],
      ['BAD_HEADER', JSON.stringify({ ...goodHeader, kind: 'other-pack' }) + '\n' + goodRow, 'kind 不符'],
      ['BAD_VERSION', JSON.stringify({ ...goodHeader, version: 999 }) + '\n' + goodRow, '版本不受支持'],
      ['SECTION_COUNT_MISMATCH', JSON.stringify({ ...goodHeader, sections: 2 }) + '\n' + goodRow, '声明 2 实 1（截断/拼接）'],
      ['BAD_ROW', JSON.stringify(goodHeader) + '\n{not json}\n', '数据行坏 JSON'],
      ['BAD_ROW', JSON.stringify(goodHeader) + '\n' + JSON.stringify({ output: 'A' }) + '\n', '数据行缺 meta.section'],
      ['UNKNOWN_SECTION', packText([['nope', 'A']]), '节名不在词表'],
      ['DUPLICATE_SECTION', packText([['entities', 'A'], ['entities', 'B']]), '同一节出现两次'],
    ];
    for (const [code, text, why] of cases) {
      const p = parseKnowledgePackage(text);
      eq(p.ok ? 'ok' : p.code, code, `G-5 畸形包整包拒：${why} ⇒ ${code}`);
    }
    eq(knowledgeCounts(db, 'p-e'), [0, 0],
      'G-5z 畸形包一路只到解析：两表零写入（坏包不会留下半册）');
  }

  // G-6 接线：校验先于写入、IPC/渲染层/卡片三处都接上、两张表在册、级联清干净、卖点两端兑现。
  {
    const ipc = strip(KNOWLEDGE_IPC_SRC);
    const parseAt = ipc.indexOf('parseKnowledgePackage(');
    const importAt = ipc.indexOf('importKnowledgeForProject(');
    ok(parseAt > 0 && importAt > parseAt, 'G-6a ★IPC 先整包校验、后导入（坏包到不了写入）');
    ok(/'knowledge:import'/.test(ipc) && /'knowledge:imports'/.test(ipc), 'G-6b 两个通道都已注册');
    ok(/isKnowledgeImportMode\(input\.mode\)/.test(ipc) && /BAD_MODE/.test(ipc),
      'G-6c 未知模式如实拒（不猜成 merge）');
    ok(/st\.size > KNOWLEDGE_PACK_MAX_CHARS \* 4/.test(ipc),
      'G-6d 读文件前先按字节粗判上限（不把任意大文件整读进内存）');
    ok(isKnowledgeImportMode('merge') && isKnowledgeImportMode('replace') && !isKnowledgeImportMode('append'),
      'G-6e 模式词表两值（未知值不认）');

    const ripc = strip(RENDERER_IPC);
    ok(/'knowledge:import'/.test(ripc) && /'knowledge:imports'/.test(ripc), 'G-6f 渲染层 IPC 客户端两条通道齐');
    const card = read(KNOWLEDGE_CARD);
    ok(/openFileDialog/.test(card) && /knowledge\.import\(/.test(card), 'G-6g 卡片可选文件并真调导入');
    ok(/mode === 'replace' && !window\.confirm/.test(card),
      'G-6h 覆盖模式须二次确认（缺省合并不动已有节）');
    ok(/await load\(\)/.test(card) && /导入 JSONL/.test(card), 'G-6i 导入后刷新预览（看到的就是导入后的真册）');

    const dbs = strip(DB_SRC);
    ok(/CREATE TABLE IF NOT EXISTS wa_project_knowledge_imports/.test(dbs)
      && /CREATE TABLE IF NOT EXISTS wa_knowledge_imports/.test(dbs)
      && /idx_wa_knowledge_imports_project/.test(dbs),
      'G-6j 导入内容表与导入账表（含索引）都在生产建表段');
    const pe = strip(PROJECT_ENGINE_SRC);
    eq([
      (pe.match(/DELETE FROM wa_project_knowledge WHERE project_id = \?/g) ?? []).length,
      (pe.match(/DELETE FROM wa_project_knowledge_imports WHERE project_id = \?/g) ?? []).length,
      (pe.match(/DELETE FROM wa_knowledge_imports WHERE project_id = \?/g) ?? []).length,
    ], [1, 1, 1], 'G-6k 删项目级联清三张表（导入的知识不成为孤儿）');

    ok((PRO_FEATURES as readonly string[]).includes('knowledge_import')
      && PRO_FEATURE_LABEL.knowledge_import === '项目知识包导入',
      'G-6l Pro 能力词表登记 knowledge_import（人话名可上屏）');
    const benefit = '项目知识包（预览注入常开 + JSONL 导出/导入）';
    ok(PRICING.pro.benefits.includes(benefit), 'G-6m 价目表卖点与代码兑现同一句话');
    const cov = BENEFIT_COVERAGE.pro.find((c) => c.benefit === benefit);
    eq(cov?.target.kind === 'capability' ? [...cov.target.keys] : [],
      ['knowledge_export', 'knowledge_import'],
      'G-6n ★一句卖点指回两项真闸（导出＋导入），不是只兑现一半');

    const literalHolders = fs.readdirSync(path.join(root, CORE_DIR))
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => fs.readFileSync(path.join(root, CORE_DIR, f), 'utf-8').includes(`'${KNOWLEDGE_PACK_KIND}'`));
    eq(literalHolders, ['knowledge-import.ts'], 'G-6o 包标识字面量只住一处（导出引常量，不另抄第二份）');

    const exp = strip(KNOWLEDGE_EXPORT_SRC);
    // zx_20261022_3 批八：包头多带一个可选画像实参 ⇒ 旧判据按符号重定向为四参调用，
    //   钉的是"节数取自 rows.length、画像取自库内同一份"（判据只强不弱，不放宽）。
    ok(/knowledgePackHeader\(projectId, generatedAt, rows\.length, profile\)/.test(exp),
      'G-6p 导出把真实节数与画像写进包头（sections 自校验才有意义；画像随包走）');
    ok(/from '\.\/knowledge-import\.js'/.test(exp) && /KNOWLEDGE_PACK_KIND/.test(exp),
      'G-6q 导出侧引同一份 kind/version 常量（不另抄字面量）');
    const imp = strip(KNOWLEDGE_IMPORT_SRC);
    ok(/proFeatureRefusal\(db, 'knowledge_import'/.test(imp),
      'G-6r 导入闸落在 core 动作口（IPC 不另写档位判断）');
  }
}

// ─────────────────── H 项目画像与 Team 共享（批八）───────────────────
const PROFILE_SRC = `${A}/src/main/core/project-profile.ts`;
const MEMORY_CONTEXT_SRC = `${A}/src/main/core/memory-context.ts`;
const MEMORY_MANAGER_SRC = `${A}/src/main/core/memory-manager.ts`;
const TEAM_LIBRARY_SRC = `${A}/src/main/core/team-library.ts`;
const TEAM_GATE_SRC = `${A}/src/main/core/team-gate.ts`;
const TEAM_IPC_SRC = `${A}/src/main/ipc/team.ipc.ts`;
const TEAM_PAGE = `${A}/renderer/src/pages/TeamLibraryPage.tsx`;

/**
 * 夹具：只建画像**真会触达**的表，列形状照抄 `database.ts`（不放宽）。
 * ⚠ `wa_project_profiles` / `wa_context_injections` 的唯一键也要建：幂等与"重复注入只记一行"
 *   正是本批判据，夹具缺它就只能测出假绿。
 */
const PROFILE_SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, description TEXT, working_dir TEXT, context_json TEXT DEFAULT '{}');
CREATE TABLE wa_project_knowledge (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, section TEXT NOT NULL, content TEXT NOT NULL,
  source_ref TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_wa_project_knowledge_sec ON wa_project_knowledge(project_id, section);
CREATE TABLE wa_project_knowledge_imports (
  project_id TEXT NOT NULL, section TEXT NOT NULL, content TEXT NOT NULL,
  precedence INTEGER NOT NULL DEFAULT 0, source_hash TEXT NOT NULL DEFAULT '',
  imported_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, section));
CREATE TABLE wa_knowledge_imports (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_project_id TEXT DEFAULT '',
  source_hash TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'merge',
  sections INTEGER NOT NULL DEFAULT 0, imported INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0, conflicts INTEGER NOT NULL DEFAULT 0,
  imported_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}');
CREATE TABLE wa_deliverables (
  id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL,
  name TEXT DEFAULT '', description TEXT DEFAULT '', file_path TEXT, status TEXT DEFAULT 'draft');
CREATE TABLE wa_service_calls (
  id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', task_id TEXT DEFAULT '', kind TEXT NOT NULL,
  target TEXT DEFAULT '', operation TEXT DEFAULT '', ok INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0,
  error TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_context_injections (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source TEXT NOT NULL, ref_id TEXT NOT NULL,
  chars INTEGER NOT NULL DEFAULT 0, est_tokens INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_wa_context_injections_key ON wa_context_injections(task_id, source, ref_id);
CREATE TABLE wa_project_profiles (
  project_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1,
  source_hash TEXT NOT NULL DEFAULT '', profile_json TEXT NOT NULL,
  generated_at TEXT DEFAULT (datetime('now')), enabled INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL DEFAULT 'local', source_project_name TEXT DEFAULT '');
`;
function mkProfileDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(PROFILE_SCHEMA);
  (d as unknown as { transaction: (fn: () => void) => () => void }).transaction = (fn) => () => fn();
  for (const [id, name] of [['p-a', '项目甲'], ['p-b', '项目乙'], ['p-c', '项目丙'], ['p-empty', '空项目']]) {
    d.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run(id, name);
  }
  return d;
}
/** 一本"九节里该露的都露了"的册：术语/验收/配方/服务/实体/使用实况各有内容。 */
function seedProfileBook(d: DatabaseSync): void {
  seedDerived(d, 'p-a', 'domain', '术语：客厅\n高频实体：灯×3\n约定：先读后写');
  seedDerived(d, 'p-a', 'criteria', '- [done] 开灯\n- [doing] 关灯\n失败 2026-10-01 客厅服务超时');
  seedDerived(d, 'p-a', 'recipes', '- 模板：先查设备再下发');
  seedDerived(d, 'p-a', 'services', 'device: 3 次（成 1 / 败 2）');
  seedDerived(d, 'p-a', 'entities', '客厅 ─[位于]→ 一楼');
  seedDerived(d, 'p-a', 'usage', '执行 开灯 ×2');
}
function mustBuild(d: DatabaseSync, pid: string, now = '2026-10-22T02:00:00.000Z'): ProjectProfile {
  const r = buildProjectProfile(d as never, pid, { now });
  if (!r.ok) throw new Error(`夹具画像不成立：${r.reason}`);
  return r.profile;
}
/** 抛错的**如实文案**（非预期异常也算进来，不吞成空串）。 */
function thrownBy(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) {
    return e instanceof TeamLibraryError ? (e as Error).message : `非预期错误：${(e as Error)?.message ?? String(e)}`;
  }
}

function groupH(): void {
  // H-1 确定性派生：同输入同画像；书或运行面一变指纹就变；字符上限只从这里出。
  {
    const db = mkProfileDb();
    seedProfileBook(db);
    const b1 = mustBuild(db, 'p-a', '2026-10-22T01:00:00.000Z');
    const b2 = mustBuild(db, 'p-a', '2026-10-22T09:00:00.000Z');
    const noAt = (p: ProjectProfile) => ({ ...p, generatedAt: '' });
    eq(noAt(b1), noAt(b2), 'H-1a 确定性：同输入 ⇒ 同画像（仅 generatedAt 不同）');
    eq(b1.terms.split('\n'), ['术语：客厅', '高频实体：灯×3', '约定：先读后写'],
      'H-1b 术语只取知识书 domain 的术语/约定类行（不整段照搬）');
    eq(b1.acceptance.split('\n'), ['- [done] 开灯', '- [doing] 关灯'],
      'H-1c 验收只取 criteria 的逐条判据（失败行归教训，不混入验收）');
    eq(b1.recipes, '- 模板：先查设备再下发', 'H-1d 配方取 recipes 的逐行');
    eq(b1.lessons, ['失败 2026-10-01 客厅服务超时', '服务「device」失败 2 次（共 3 次）'],
      'H-1e 教训只来自已发生的失败（验收失败因由 + 服务败次）');
    eq([b1.runtime.tasks.total, b1.runtime.deliverables.total, b1.runtime.calls.total], [0, 0, 0],
      'H-1f 空运行面如实记 0（不编样本）');

    const h0 = currentProfileSourceHash(db as never, 'p-a');
    eq(h0, b1.sourceHash, 'H-1g 输入指纹与画像自记同值（同一把尺）');
    db.prepare('INSERT INTO wa_tasks (id, project_id, title, status) VALUES (?, ?, ?, ?)')
      .run('t-hash', 'p-a', '新任务', 'completed');
    ok(currentProfileSourceHash(db as never, 'p-a') !== h0, 'H-1h 运行面变了 ⇒ 指纹变（过期标记有据）');
    const h1 = currentProfileSourceHash(db as never, 'p-a');
    seedDerived(db, 'p-a', 'entities', '客厅 ─[位于]→ 一楼\n厨房 ─[位于]→ 一楼');
    ok(currentProfileSourceHash(db as never, 'p-a') !== h1, 'H-1i 知识书变了 ⇒ 指纹变');

    saveProjectProfile(db as never, b1);
    ok(readProjectProfile(db as never, 'p-a')!.sourceHash !== currentProfileSourceHash(db as never, 'p-a'),
      'H-1j ★书/运行面变动后画像判"过期"，但内容不被自动覆盖（同一行还在）');

    seedDerived(db, 'p-a', 'domain', `术语：${'x'.repeat(400)}`);
    const long = mustBuild(db, 'p-a').terms.split('\n')[0]!;
    ok(long.length <= PROFILE_LINE_MAX_CHARS + 1 && long.endsWith('…'),
      'H-1k 超长行按 PROFILE_LINE_MAX_CHARS 截断并如实加省略号', `${long.length} 字`);
  }

  // H-2 落库/启用/读数：刷新不改用户的启用选择；坏画像不冒充。
  {
    const db = mkProfileDb();
    seedProfileBook(db);
    const b = mustBuild(db, 'p-a');
    eq(parseProjectProfileJson(JSON.stringify(b)), b, 'H-2a 合法画像原样可解析（导入/共享/读库同一把尺）');
    eq(parseProjectProfileJson({ ...b, version: 999 }), null, 'H-2b 版本不符 ⇒ 拒（不猜成 v1）');
    eq(parseProjectProfileJson({ version: PROJECT_PROFILE_VERSION }), null, 'H-2c 缺 runtime ⇒ 拒');

    saveProjectProfile(db as never, b, { enabled: false });
    const s1 = readProjectProfile(db as never, 'p-a')!;
    eq([s1.enabled, s1.origin, s1.sourceProjectName], [false, 'local', ''],
      'H-2d 首次落库按传入 enabled；来源记 local');
    saveProjectProfile(db as never, mustBuild(db, 'p-a'));
    eq(readProjectProfile(db as never, 'p-a')!.enabled, false, 'H-2e ★刷新画像不改用户启用选择（enabled 不在更新列）');
    ok(setProjectProfileEnabled(db as never, 'p-a', true) && readProjectProfile(db as never, 'p-a')!.enabled,
      'H-2f 启用开关真改一行');
    eq(setProjectProfileEnabled(db as never, 'p-c', true), false, 'H-2g 无画像的项目改开关 ⇒ 如实 false');
    eq(profileRefId(b), `profile:${b.sourceHash.slice(0, 12)}`, 'H-2h 注入账 ref_id 记的是"哪一版画像"');

    const empty = buildProjectProfile(db as never, 'p-empty');
    ok(!empty.ok && empty.reason.includes('暂无可生成画像'), 'H-2i 无事实的项目 ⇒ 如实 no-facts（不伪造空画像）');
  }

  // H-3 渲染：整行取舍、预算内交代余量、一行都装不下 ⇒ null（绝不喂半句）。
  {
    const db = mkProfileDb();
    seedProfileBook(db);
    const b = mustBuild(db, 'p-a');
    const full = renderProjectProfile(b, PROFILE_INJECT_MAX_TOKENS)!;
    ok(full !== null && full.text.startsWith('## 项目画像') && full.text.includes('术语与约定：'),
      'H-3a 渲染段自带头部与术语');
    eq(full.tokens, estimateTokensFromChars(full.text.length), 'H-3b token 折算与唯一口径同值');
    ok(full.tokens <= PROFILE_INJECT_MAX_TOKENS,
      `H-3c 满额渲染不超 ${PROFILE_INJECT_MAX_TOKENS} token`, `${full.tokens} token`);
    eq(renderProjectProfile(b, 1), null, 'H-3d 预算装不下第一行 ⇒ null（不裁半句）');
    const tight = renderProjectProfile(b, 12);
    ok(tight !== null && tight.text.includes('…（余部未注入）'),
      'H-3e 装不下余行 ⇒ 如实交代"余部未注入"');
    ok(tight === null || tight.tokens <= 12, 'H-3f 余量注记本身也吃同一笔预算');
  }

  // H-4 注入账：0→1 正面计数、唯一键去重、收口回填只改 pending。
  {
    const db = mkProfileDb();
    seedProfileBook(db);
    const b = mustBuild(db, 'p-a');
    const rendered = renderProjectProfile(b, PROFILE_INJECT_MAX_TOKENS)!;
    db.prepare('INSERT INTO wa_tasks (id, project_id, title, status) VALUES (?, ?, ?, ?)')
      .run('t-1', 'p-a', '注入任务', 'running');

    type Recorder = (this: { db: unknown }, taskId: string, input: { profiles?: Array<{ ref_id: string; chars: number }> }) => number;
    type Backfill = (this: { db: unknown }, taskId: string, outcome: 'completed' | 'failed') => number;
    const record = MemoryManager.prototype.recordContextInjections as unknown as Recorder;
    const backfill = MemoryManager.prototype.backfillInjectionOutcomes as unknown as Backfill;
    const injection = { ref_id: profileRefId(b), chars: rendered.text.length };

    eq(record.call({ db }, 't-1', { profiles: [injection] }), 1, 'H-4a ★画像注入记账 0→1（正面计数）');
    eq(record.call({ db }, 't-1', { profiles: [injection] }), 0,
      'H-4b 同一任务同一版画像重复装配 ⇒ 不重复记账（唯一键 + OR IGNORE）');
    const row = db.prepare('SELECT source, ref_id, chars, est_tokens, outcome FROM wa_context_injections WHERE task_id = ?')
      .get('t-1') as { source: string; ref_id: string; chars: number; est_tokens: number; outcome: string };
    eq([row.source, row.ref_id, row.chars, row.est_tokens, row.outcome],
      ['project_profile', profileRefId(b), rendered.text.length, estimateTokensFromChars(rendered.text.length), 'pending'],
      'H-4c 账行五列与渲染同一次构造（不靠二次解析猜边界）');

    const st0 = profileInjectionStats(db as never, 'p-a');
    eq([st0.injections, st0.completed, st0.failed], [1, 0, 0], 'H-4d 画像注入成效可读（有写口就有读口）');
    eq(backfill.call({ db }, 't-1', 'completed'), 1, 'H-4e 任务收口回填 pending 行');
    eq(backfill.call({ db }, 't-1', 'failed'), 0, 'H-4f 已结清的账不再改写（同一任务同一注入只记一次结局）');
    const st1 = profileInjectionStats(db as never, 'p-a');
    eq([st1.injections, st1.completed, st1.failed], [1, 1, 0], 'H-4g 成效读数与回填一致');
    eq(profileInjectionStats(db as never, 'p-b').injections, 0, 'H-4h 别项目的账不串味（按 task 归属）');
  }

  // H-5 Team 闸：只闸"搬运"（分享/导入）；社区档拒、试用期放；词表登记人话名。
  {
    const community = mkProfileDb();
    const refusal = teamFeatureRefusal(community as never, 'project_profile_share');
    ok(typeof refusal === 'string' && refusal.includes('项目画像共享'),
      'H-5a 社区档分享画像 ⇒ 如实拒且点名能力（不写"操作失败"了事）');
    ok((TEAM_FEATURES as readonly string[]).includes('project_profile_share'),
      'H-5b Team 能力词表登记 project_profile_share');
    eq(TEAM_FEATURE_LABEL.project_profile_share, '项目画像共享', 'H-5c 拒因用的人话名一处真源');
    ok((TEAM_ITEM_KINDS as readonly string[]).includes('project_profile'),
      'H-5d 共享库第五类 project_profile 在词表（界面列由它派生）');
    eq(TEAM_ITEM_KIND_LABEL.project_profile, '项目画像', 'H-5e 第五类的人话名在词表');

    const trial = mkProfileDb();
    enableKnowledgeTrial(trial);
    eq(teamFeatureRefusal(trial as never, 'project_profile_share', KNOWLEDGE_LICENSE), null,
      'H-5f 试用期放行（同一判据链，不另写 ||）');
  }

  // H-6 分享/导入：体只带画像；导入缺省不启用；同名同版跳过、异版冲突——一律不覆盖。
  {
    const db = mkProfileDb();
    seedProfileBook(db);
    const b = mustBuild(db, 'p-a');
    saveProjectProfile(db as never, b);

    const shared = shareItem(db as never, 'project_profile', 'p-a');
    eq([shared.kind, shared.title], ['project_profile', '项目甲'], 'H-6a 分享标题取项目名');
    const body = shared.body as { version: number; profile: ProjectProfile; source_project_name: string };
    eq([body.version, body.source_project_name, body.profile.sourceHash],
      [PROJECT_PROFILE_VERSION, '项目甲', b.sourceHash], 'H-6b 分享体只带画像本身与出处项目名');
    ok(!JSON.stringify(shared.body).includes('file_path') && !JSON.stringify(shared.body).includes('working_dir'),
      'H-6c ★共享体不带本机路径（不把机器内部面转嫁给下一个节点）');

    type Item = Parameters<typeof importItem>[1];
    const item = { kind: 'project_profile', title: shared.title, body: shared.body } as unknown as Item;
    const r1 = importItem(db as never, item, { projectId: 'p-b' });
    eq([r1.kind, r1.id, r1.target], ['project_profile', 'p-b', 'wa_project_profiles'],
      'H-6d 导入落到目标项目（画像一项目一份）');
    const s1 = readProjectProfile(db as never, 'p-b')!;
    eq([s1.enabled, s1.origin, s1.sourceProjectName], [false, 'imported', '项目甲'],
      'H-6e ★导入画像默认不启用（导入≠启用），来源可回查');

    ok(thrownBy(() => importItem(db as never, item, { projectId: 'p-b' })).includes('同一版'),
      'H-6f 同版重复导入 ⇒ 如实"跳过"（不写第二份）');
    saveProjectProfile(db as never, { ...b, projectId: 'p-b', sourceHash: 'other-hash' });
    ok(thrownBy(() => importItem(db as never, item, { projectId: 'p-b' })).includes('未覆盖'),
      'H-6g ★异版不覆盖目标已有画像（冲突如实拒）');
    eq(readProjectProfile(db as never, 'p-b')!.sourceHash, 'other-hash', 'H-6h 冲突拒后目标画像一字节未动');

    ok(thrownBy(() => importItem(db as never, item, {})).includes('指定目标项目'),
      'H-6i 未选目标项目 ⇒ 如实拒（不静默挑一个）');
    ok(thrownBy(() => importItem(db as never, item, { projectId: 'p-zzz' })).includes('目标项目不存在'),
      'H-6j 目标项目不存在 ⇒ 如实拒');
    ok(thrownBy(() => shareItem(db as never, 'project_profile', 'p-c')).includes('项目画像不存在'),
      'H-6k 无画像的项目不可分享（不冒充成功）');
  }

  // H-7 知识包往返**包含画像**：导出带、解析留、导入落且不启用；坏画像整包拒。
  {
    const db = mkProfileDb();
    seedProfileBook(db);
    enableKnowledgeTrial(db);
    const b = mustBuild(db, 'p-a');
    saveProjectProfile(db as never, b);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261022-3-h-'));
    try {
      const out = exportKnowledgeForProject(db as never, 'p-a', dir, KNOWLEDGE_LICENSE);
      if (!out.ok) throw new Error(`导出失败：${out.message}`);
      const text = fs.readFileSync(out.result.filePath, 'utf-8');
      const lines = text.trimEnd().split('\n');
      const header = JSON.parse(lines[0]!) as Record<string, unknown>;
      const hp = header.profile as { version?: number; sourceHash?: string } | undefined;
      eq([hp?.version, hp?.sourceHash], [PROJECT_PROFILE_VERSION, b.sourceHash],
        'H-7a 包头带画像（版本与指纹与库内同一份）');

      const pkg = mustParse(text);
      ok(pkg.profile !== null && pkg.profile!.sourceHash === b.sourceHash, 'H-7b 解析保留画像');

      const imp = importKnowledgeForProject(db as never, 'p-b', pkg, { license: KNOWLEDGE_LICENSE });
      ok(imp.ok && imp.result.profile === 'imported', 'H-7c 往返导入画像（0→1 新写入）');
      const s = readProjectProfile(db as never, 'p-b')!;
      eq([s.enabled, s.origin], [false, 'imported'], 'H-7d 往返导入的画像同样缺省不启用');

      const imp2 = importKnowledgeForProject(db as never, 'p-b', pkg, { license: KNOWLEDGE_LICENSE });
      ok(imp2.ok && imp2.result.profile === 'skipped' && imp2.result.imported === 0,
        'H-7e 二次导入同包 ⇒ 画像与节都落 skipped（幂等）');

      const bad = parseKnowledgePackage([
        JSON.stringify({ ...header, profile: { version: 999 } }),
        ...lines.slice(1),
      ].join('\n') + '\n');
      eq(bad.ok ? 'ok' : bad.code, 'BAD_PROFILE', 'H-7f 坏画像 ⇒ BAD_PROFILE 整包拒（不静默丢画像只导节）');
      eq(knowledgeCounts(db, 'p-b'), [6, 2], 'H-7g 坏包未写入任何一张表（6 节 + 恰好两次导入账）');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // H-8 接线：建表/级联/IPC 三通道/渲染层/两页；本机生成与注入零档位闸。
  {
    ok(/CREATE TABLE IF NOT EXISTS wa_project_profiles/.test(strip(DB_SRC)),
      'H-8a 生产建表段有 wa_project_profiles');
    eq((strip(PROJECT_ENGINE_SRC).match(/DELETE FROM wa_project_profiles WHERE project_id = \?/g) ?? []).length, 1,
      'H-8b 删项目级联清画像（不留孤儿）');

    const ipc = strip(KNOWLEDGE_IPC_SRC);
    for (const ch of ['knowledge:profile', 'knowledge:profileGenerate', 'knowledge:profileEnabled']) {
      ok(ipc.includes(`'${ch}'`), `H-8c IPC 已注册 ${ch}`);
    }
    ok(!/proFeatureRefusal|resolveLicenseState/.test(ipc),
      'H-8d ★画像三通道零档位闸（本机生成/启停/读，社区档照常自用）');
    const ripc = strip(RENDERER_IPC);
    ok(/'knowledge:profileGenerate'/.test(ripc) && /'knowledge:profileEnabled'/.test(ripc),
      'H-8e 渲染层 IPC 客户端三条画像通道齐');
    const card = read(KNOWLEDGE_CARD);
    ok(/knowledge\.profileGenerate\(/.test(card) && /knowledge\.profileEnabled\(/.test(card),
      'H-8f 知识包卡真有生成与启停的写入口（承诺的开关须点得到）');
    ok(/项目画像/.test(card) && /profile\.stale/.test(card),
      'H-8g 卡上可见画像与"过期且不自动覆盖"的如实提示');

    const mc = strip(MEMORY_CONTEXT_SRC);
    // zx_20261023_5 批二：知识卡也占同一份 400-token 预算 ⇒ 钉**双扣**形状（比旧单扣更强）。
    ok(/Math\.max\(0, KNOWLEDGE_INJECT_MAX_TOKENS - profileTokens - cardTokens\)/.test(mc),
      'H-8h ★知识书预算从画像与知识卡实际 token 里扣（总预算不增）');
    ok(/renderProjectProfile\(stored\.profile, PROFILE_INJECT_MAX_TOKENS\)/.test(mc)
      && /profileRefId\(stored\.profile\)/.test(mc),
      'H-8i 注入段与逐段留账都调画像模块（不另写渲染/ref_id）');
    ok(/if \(stored\?\.enabled\)/.test(mc), 'H-8j 未启用 ⇒ 不入文（启用才是用户动作）');
    ok(/'project_profile'/.test(strip(MEMORY_MANAGER_SRC)), 'H-8k 注入账写口认 project_profile 源');

    const tlib = strip(TEAM_LIBRARY_SRC);
    ok(/kind === 'project_profile'/.test(tlib) && /insertImportedProfile\(db as never, projectId/.test(tlib),
      'H-8l 共享库第五类真有分享/导入两支');
    const tipc = strip(TEAM_IPC_SRC);
    ok(/profileShareGate/.test(tipc) && (tipc.match(/profileShareGate\(db\)/g) ?? []).length >= 2,
      'H-8m ★Team 闸只落在分享与导入两跳（搬运被闸、使用不被闸）');
    ok(/teamFeatureRefusal\(db as unknown as LicenseSettingDb, 'project_profile_share'\)/.test(tipc),
      'H-8n 闸种取 team-gate 真源，不在 IPC 另写判据');

    const teamPage = read(TEAM_PAGE);
    ok(/kind === 'project_profile'\) return payload\.local\.profiles/.test(teamPage),
      'H-8o 第五列候选取 local.profiles（与主进程载荷字段对齐）');
    ok(/item\.kind === 'project_profile' \? targetProjectId : null/.test(teamPage),
      'H-8p 画像导入真把目标项目 id 传到 IPC');
    ok(/xl:grid-cols-5/.test(teamPage) && /默认未启用/.test(teamPage),
      'H-8q 五列齐且如实写明"导入默认不启用"');

    const teamBenefit = '项目画像共享（跨节点带项目画像）';
    ok(PRICING.team.benefits.includes(teamBenefit), 'H-8r 价目表卖点含项目画像共享');
    const cov = BENEFIT_COVERAGE.team.find((c) => c.benefit === teamBenefit);
    eq(cov?.target.kind === 'capability' ? [...cov.target.keys] : [], ['project_profile_share'],
      'H-8s ★卖点指回真闸 project_profile_share（不是只写在文案里）');
    ok(/PROFILE_INJECT_MAX_TOKENS = 200/.test(strip(PROFILE_SRC)),
      'H-8t 画像自身的注入上限是具名常量（一处真源）');
    ok(/teamUnlocked/.test(strip(TEAM_GATE_SRC)) && /kind === 'trial'/.test(strip(TEAM_GATE_SRC)),
      'H-8u 试用期判据仍住 team-gate（与档位对照表同一处）');
  }

  // H-9 Token 总账：画像 + 减法后的知识书 ≤ 400；未启用时知识书回满 400。
  {
    const db = mkProfileDb();
    seedDerived(db, 'p-a', 'entities', 'E'.repeat(800));            // ≈200 token
    seedDerived(db, 'p-a', 'domain', `术语：${'Y'.repeat(796)}`);   // ≈200 token
    seedDerived(db, 'p-a', 'usage', 'U'.repeat(400));              // ≈100 token
    const built = mustBuild(db, 'p-a');
    saveProjectProfile(db as never, built);
    const stored = readProjectProfile(db as never, 'p-a')!;
    const rendered = renderProjectProfile(stored.profile, PROFILE_INJECT_MAX_TOKENS)!;
    const pt = rendered.tokens;
    const book = listProjectKnowledge(db as never, 'p-a');
    const basePicked = selectKnowledgeForInject(book, null, KNOWLEDGE_INJECT_MAX_TOKENS);
    const reducedPicked = selectKnowledgeForInject(book, null, Math.max(0, KNOWLEDGE_INJECT_MAX_TOKENS - pt));
    const cost = (arr: typeof book) => arr.reduce((n, e) => n + estimateTokensFromChars(e.content.length), 0);

    ok(basePicked.some((e) => e.section === 'domain'),
      'H-9a 对照：无画像时 400 token 预算下 domain 节装得下');
    ok(!reducedPicked.some((e) => e.section === 'domain') && reducedPicked.length > 0,
      'H-9b ★画像占预算后 domain 让出（整节取舍，不截字）');
    ok(pt + cost(reducedPicked) <= KNOWLEDGE_INJECT_MAX_TOKENS,
      `H-9c 画像 + 知识书合计不超原预算 ${KNOWLEDGE_INJECT_MAX_TOKENS}`, `${pt}+${cost(reducedPicked)}`);

    type Mem = Parameters<typeof buildMemoryContext>[0];
    const base = {
      listProjectProfile: () => stored,
      listDomainKnowledge: () => book,
      listAppliedDomainPacks: () => [],
      buildMemoryEffectivenessStats: () => [],
      buildExecutionPlaybook: () => ({}),
      retrieveByType: () => [],
      getProjectKnowledge: () => [],
      retrieveKnowledgeGraphContext: () => [],
      getTriggeredProspective: () => [],
      getWorkingMemory: () => [],
      retrieveUnknownHits: () => [],
      retrieveNegativeHits: () => [],
      findSimilarTasks: () => [],
      getTaskArchetype: () => null,
      getTaskText: () => '',
      recordInjection: () => { /* 本用例只量装配，不落账（H-4 已单独量写口） */ },
    };
    const ctx = buildMemoryContext(base as unknown as Mem, 'p-a', undefined, undefined, null, undefined, 20000);
    eq(ctx.profileText, rendered.text, 'H-9d 入文画像与渲染同文（不二次改写）');
    eq(ctx.profileInjections, [{ ref_id: profileRefId(stored.profile), chars: rendered.text.length }],
      'H-9e 画像注入明细与文同一次构造');
    const labels = [...ctx.knowledgeText.matchAll(/### ([^\n]+)/g)].map((m) => m[1]);
    eq(labels, reducedPicked.map((e) => PROJECT_KNOWLEDGE_SECTION_LABEL[e.section]),
      'H-9f ★知识书真按"400 − 画像 token"择节（注入路径与 H-9b 同一把尺）');

    const off = buildMemoryContext(
      { ...base, listProjectProfile: () => ({ ...stored, enabled: false }) } as unknown as Mem,
      'p-a', undefined, undefined, null, undefined, 20000,
    );
    eq([off.profileText, off.profileInjections.length], ['', 0], 'H-9g 停用 ⇒ 画像零入文零记账');
    const offLabels = [...off.knowledgeText.matchAll(/### ([^\n]+)/g)].map((m) => m[1]);
    eq(offLabels, basePicked.map((e) => PROJECT_KNOWLEDGE_SECTION_LABEL[e.section]),
      'H-9h ★停用后知识书回到 400 预算（不白白缩水）');
    ok(cost(basePicked) <= KNOWLEDGE_INJECT_MAX_TOKENS, 'H-9i 对照侧本身不超预算（判据可被合法数据满足）');
  }
}

/* ───────────────────── I 档位差异可见（批九）───────────────────── */
const PROJECTS_PAGE = `${A}/renderer/src/pages/ProjectsPage.tsx`;
const LICENSE_IPC_SRC = `${A}/src/main/ipc/license.ipc.ts`;
const PROJECT_IPC_SRC = `${A}/src/main/ipc/project.ipc.ts`;
const IM_ROUTER_SRC = `${A}/src/main/services/im-router.ts`;
const NODES_IPC_SRC = `${A}/src/main/ipc/nodes.ipc.ts`;

/**
 * 夹具：档位用量**真会触达**的表，列形状照抄 `database.ts`（不放宽）。
 * `wa_users` 的 `email NOT NULL` 与 `wa_projects.name NOT NULL` 一并照抄——
 * 夹具比生产宽松，断言就只是在自我印证。
 */
const USAGE_SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
  avatar_url TEXT, role TEXT DEFAULT 'viewer', auth_provider TEXT DEFAULT 'authjs',
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', cron_schedule TEXT, working_dir TEXT DEFAULT '',
  context_json TEXT DEFAULT '{}', sandbox_mode TEXT DEFAULT 'workspace',
  owner_id TEXT, cron_timezone TEXT DEFAULT 'Asia/Shanghai',
  autonomous_mode TEXT DEFAULT 'off', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}');
`;
function mkUsageDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(USAGE_SCHEMA);
  return d;
}

function groupI(): void {
  const NOW = new Date('2026-10-22T02:00:00.000Z');
  // 指纹与时刻都注入：判据不依赖真机/墙钟。
  const opts = { now: NOW, fingerprint: 'rr-fingerprint' };
  const registered = new Set<string>([
    ...Object.values(PRO_FEATURE_LABEL),
    ...Object.values(TEAM_FEATURE_LABEL),
  ]);
  // zx_20261030_1 M4（改旧断言＝钉更强的真源）: 上限口径已扩到**九维**（M5 增设备/外部终端/A2A/知识卡/
  //   团队共享记忆）——期望文案仍逐维由 `TIER_LIMITS` 派生（不写死数值，也不写死"只有四维"）。
  const quotaOf = (l: (typeof TIER_LIMITS)[keyof typeof TIER_LIMITS]): string[] => [
    l.maxProjects === 0 ? '不限项目' : `${l.maxProjects} 个项目`,
    `并发 ${l.maxProjectConcurrency}`,
    // zx_20261023_1「称」: 升级差异的档位上限改列**协同节点**（席位降为本机账号口径，不再作卖点）。
    l.maxNodes === 0 ? '不限协同节点' : `${l.maxNodes} 台协同节点`,
    // zx_20261027_3 M3「试得真」: 本机账号同样是档位实差 ⇒ 升级面板逐档列。
    l.maxMembers === 0 ? '不限本机账号' : `本机账号 ${l.maxMembers}`,
    // zx_20261030_1 M5「限」: 五个容量维度（0 = 不限，不写成 "0 台"）。
    l.maxDevices === 0 ? '不限设备登记' : `设备登记 ${l.maxDevices} 台`,
    l.maxExternalTerminals === 0 ? '不限外部终端' : `外部终端 ${l.maxExternalTerminals} 台`,
    l.maxA2AServers === 0 ? '不限 A2A 服务' : `A2A 服务 ${l.maxA2AServers} 个`,
    l.maxKnowledgeCardsPerProject === 0 ? '不限每项目知识卡' : `每项目知识卡 ${l.maxKnowledgeCardsPerProject} 张`,
    l.maxTeamLibraryMemories === 0 ? '不限团队共享记忆' : `团队共享记忆 ${l.maxTeamLibraryMemories} 条`,
  ];
  const quotaShapes = LICENSE_TIERS.flatMap((t) => quotaOf(TIER_LIMITS[t]));
  /** 两档之间**确实变化**的上限（与上述同一套形状逐维对齐）。 */
  const diffQuotas = (a: (typeof TIER_LIMITS)[keyof typeof TIER_LIMITS], b: (typeof TIER_LIMITS)[keyof typeof TIER_LIMITS]): string[] => {
    const A = quotaOf(a);
    const B = quotaOf(b);
    return B.filter((text, i) => text !== A[i]);
  };

  // I-1 用量计数与库同源：0→1 正面值；上限取 TIER_LIMITS，不另立计数。
  {
    const db = mkUsageDb();
    const zero = tierUsageCounts(db as never, { ...opts, cpus: 4 });
    eq([zero.tier, zero.kind, zero.tierLabel], ['community', 'none', TIER_LABEL.community],
      'I-1a 无许可 ⇒ community（与 resolveLicenseState 同一次解析）');
    eq([zero.projects, zero.seats], [{ used: 0, limit: 1 }, { used: 0, limit: 1 }],
      'I-1b 空库 0/1：上限取 TIER_LIMITS，不写死字面量');
    eq(zero.concurrency, { perProjectMax: 3, machineLimit: 3 },
      'I-1c 并发两把尺：单项目取档位上限、整机取 CPU 派生（cpus=4 ⇒ 3）');

    db.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run('p1', '甲');
    db.prepare('INSERT INTO wa_users (id, email) VALUES (?, ?)').run('u1', 'u1@example.com');
    const one = tierUsageCounts(db as never, { ...opts, cpus: 4 });
    eq([one.projects.used, one.seats.used], [1, 1],
      'I-1d ★各新增一行后用量 0→1（计数器须有正面值，不以"不抛"代替）');
    eq([one.projects.used, one.seats.used], [countProjects(db as never), countSeats(db as never)],
      'I-1e 与既有计数函数同值（读数复用真源，不另数一遍）');

    db.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)').run(MACHINE_CONCURRENCY_SETTING_KEY, '5');
    eq(tierUsageCounts(db as never, { ...opts, cpus: 4 }).concurrency.machineLimit, 5,
      'I-1f 用户配置优先：整机上限读设置（与执行闸同一个 setting 键）');
    ok(usageRatio(1, 1) === '1/1' && usageRatio(3, 0) === '3（不限）',
      'I-1g 用量写法：`0 = 不限`，不把不限档写成 0/0');
  }

  // I-2 档位上限随许可态走：试用**授予档**由 tier-catalog 同一对纯函数派生（zx_20261027_3 M3「试得真」：试用即团队），
  //   能力行取 catalog 本档对照行。
  {
    const db = mkUsageDb();
    db.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)')
      .run(LICENSE_SETTING_KEYS.trialStartedAt, '2026-10-20T02:00:00.000Z');
    const trialTier = tierCatalog().trial.grantsTier;
    const trialLimits = TIER_LIMITS[trialTier];
    const c = tierUsageCounts(db as never, { ...opts, cpus: 4 });
    eq([c.tier, c.kind], [trialTier, 'trial'],
      'I-2a 试用档由 tier-catalog 派生（试用即团队——与两道软闸同一次解析）');
    eq([c.projects.limit, c.concurrency.perProjectMax, c.seats.limit],
      [trialLimits.maxProjects, trialLimits.maxProjectConcurrency, trialLimits.maxMembers],
      'I-2b 试用上限随授予档（项目/并发/本机账号全取 TIER_LIMITS，不写死数值）');
    ok(c.features.some((f) => f.key === 'image_vision' && f.included),
      'I-2c 能力行逐项取 tier-catalog 本档 included（不另写卖点）');
    ok(c.features.every((f) => f.included && f.upgradeLabel === null),
      'I-2d 授予档已含全部能力 ⇒ 无「升级到某档」提示（对照表同一份）');
    // 反面标本：只用"全都包含"的样本 ⇒ included 判据过宽也全票通过。社区档取另一侧。
    const community = tierUsageCounts(mkUsageDb() as never, { ...opts, cpus: 4 });
    const unlockRow = tierCatalog().tiers.find((r) =>
      r.capabilities.some((x) => x.key === 'multi_node' && x.included))!;
    ok(community.features.some((f) => f.key === 'multi_node' && !f.included && f.upgradeLabel === unlockRow.label),
      'I-2e ★反面标本：社区档 `multi_node` 未含，且 upgradeLabel = 最早含它的档（由同一对照表反查，不写死档名）');
  }

  // I-3 升级差异只由"已注册能力 + TIER_LIMITS 派生上限"构成。
  {
    const up = upgradeDifferences('community');
    eq([up.toTier, up.toLabel], ['pro', TIER_LABEL.pro],
      'I-3a 缺省目标＝下一档（由 LICENSE_TIERS 派生）');
    eq(up.quotas, diffQuotas(TIER_LIMITS.community, TIER_LIMITS.pro),
      'I-3b 上限差异只列确实变化项（九维逐枚举；不变维不列）');
    const proIncluded = tierCatalog().tiers.find((r) => r.tier === 'pro')!.capabilities
      .filter((c) => c.included).map((c) => c.label);
    const teamIncluded = tierCatalog().tiers.find((r) => r.tier === 'team')!.capabilities
      .filter((c) => c.included).map((c) => c.label);
    eq(up.capabilities, proIncluded,
      'I-3c ★能力差异 = 目标档新增的已注册能力（不多不少）');

    const up2 = upgradeDifferences('pro');
    // 四维逐枚举、期望文案由 TIER_LIMITS 派生（zx_20261027_3 M3：本机账号也是档位实差，须列）。
    const proL = TIER_LIMITS.pro;
    const teamL = TIER_LIMITS.team;
    eq(up2.quotas, diffQuotas(proL, teamL),
      'I-3d 逐档派生：Pro→Team 只列**确实变化**的上限（九维逐枚举）');
    eq(up2.capabilities, teamIncluded.filter((l) => !proIncluded.includes(l)),
      'I-3e Pro→Team 只列 Team 新增那几项（Pro 已有的不重复卖）');

    const none = { toTier: null, toLabel: null, capabilities: [], quotas: [] };
    eq(upgradeDifferences('team'), none, 'I-3f 顶层无升级路径（不编"升级到某档"）');
    eq(upgradeDifferences('team', 'community'), none, 'I-3g 反向/同档不产生差异');
    eq(upgradeDifferences('community', 'community'), none, 'I-3h 同档无差异');

    const diffs = LICENSE_TIERS.map((t) => upgradeDifferences(t)).filter((d) => d.toTier !== null);
    ok(diffs.length > 0 && diffs.every((d) =>
      d.capabilities.every((l) => registered.has(l)) && d.quotas.every((q) => quotaShapes.includes(q))),
      'I-3i ★升级差异不含未注册卖点：能力名 ∈ PRO/TEAM 词表，上限 ∈ TIER_LIMITS 派生形状', `${diffs.length} 档`);
    eq(PROJECT_QUOTA_UNLOCK_TIER, LICENSE_TIERS.find((t) => TIER_LIMITS[t].maxProjects === 0),
      'I-3j 解锁档由 TIER_LIMITS 派生（不写死档名）');
  }

  // I-4 撞闸回话：判据原句一字不改，只在其后追加真实用量与升级差异。
  {
    const db = mkUsageDb();
    db.prepare('INSERT INTO wa_users (id, email) VALUES (?, ?)').run('u1', 'u1@example.com');
    db.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run('p1', '甲');
    const base = projectQuotaRefusal(db as never, opts);
    ok(base != null && base === `当前为${TIER_LABEL.community}，最多可创建 1 个项目（已有 1 个）。升级档位后可创建更多。`,
      'I-4a 判据原句仍由 project-quota 单独产生（本模块不改判据）');
    const withCtx = refusalWithContext(db as never, base!, { ...opts, requiredTier: PROJECT_QUOTA_UNLOCK_TIER });
    ok(withCtx.startsWith(`${base}\n`),
      'I-4b ★回话 = 原句逐字节保留 + 换行追加（判据仍然只有一处）');
    ok(withCtx.includes('当前用量：项目 1/1') && withCtx.includes('本机账号 1/1') && withCtx.includes('项目并发上限 3'),
      'I-4c 追加段含真实用量（项目/本机账号/并发同把尺）');
    const gain = withCtx.match(/升级.+?可获得：([^。]+)。$/);
    const items = gain ? gain[1]!.split('、') : [];
    ok(gain !== null && items.length > 0 && items.every((x) => registered.has(x) || quotaShapes.includes(x)),
      'I-4d ★回话里的升级项逐项可核对（能力 ∈ 注册词表 / 上限 ∈ 派生形状）', items.join('、'));
    ok(items.includes('不限项目'),
      'I-4e 撞项目上限时差异如实指向"不限项目"');

    const teamBase = teamFeatureRefusal(db as never, 'multi_node', opts);
    const teamCtx = refusalWithContext(db as never, teamBase!, { ...opts, requiredTier: 'team' });
    ok(teamBase != null && teamCtx.startsWith(`${teamBase}\n`)
      && teamCtx.includes(TEAM_FEATURE_LABEL.multi_node),
      'I-4f Team 撞闸同法：原句保留 + 追加用量与 Team 差异');
    ok(!/无限|专属客服|永久免费/.test(teamCtx),
      'I-4g 无注册来源的卖点词不出现（只从 catalog/TIER_LIMITS 取）');

    eq(refusalWithContext(null, base!), base!, 'I-4h 无库 ⇒ 原句原样（fail-open 方向，不编用量）');
    eq(refusalWithContext(db as never, ''), '', 'I-4i 空拒因不追加');

    const counts = tierUsageCounts(db as never, opts);
    ok(usageContextLine(counts).endsWith('。') && !usageContextLine(counts).includes('\n'),
      'I-4j 单行用量段无内嵌换行（IM 括号内可直接引用）');
  }

  // I-5 接线：出口、渲染层、以及各处撞闸回话都接上了同一模块。
  {
    const lic = strip(LICENSE_IPC_SRC);
    ok(/ipcMain\.handle\('license:usage'/.test(lic) && /tierUsage\(db, \{ localNodeId \}\)/.test(lic),
      'I-5a 真 IPC 出口 license:usage 直调 tierUsage（带本机节点 id）');
    ok(/usage: \(\) => ipcCall<TierUsagePayload>\('license:usage'\)/.test(strip(RENDERER_IPC)),
      'I-5b renderer 同引 main 类型，只走这一个出口（不重算用量）');

    const settings = read(SETTINGS_PAGE);
    ok(/licenseApi\.usage\(\)/.test(settings) && /<UsageBar label="项目"/.test(settings)
      && /<UsageBar label="本机账号"/.test(settings),
      'I-5c 设置页上屏项目/本机账号用量条（带上限进度）');
    ok(/usage\.nodes\.unavailable/.test(settings) && /不可用（/.test(settings),
      'I-5d 节点台账读不到如实"不可用 + 原因"（不写 0 台在线）');
    ok(/购买渠道筹备中（入口即将开放）/.test(settings),
      'I-5e 购买地址为空 ⇒ 显示筹备中，不摆死按钮（PURCHASE_URL 单源）');

    const projects = read(PROJECTS_PAGE);
    ok(/项目已用 \{usage\.projects\.used\}\/\{projectLimit\}/.test(projects)
      && /upgradeGains\.join\('、'\)/.test(projects),
      'I-5f 项目页撞顶如实显示已用/上限 + 真实升级差异');

    const reProject = /refusalWithContext\(db, refusal, \{ requiredTier: PROJECT_QUOTA_UNLOCK_TIER \}\)/g;
    eq((strip(PROJECT_IPC_SRC).match(reProject) ?? []).length, 2,
      'I-5g 项目新建/克隆两个写入落点都追加用量（漏一处即量不到）');
    const im = strip(IM_ROUTER_SRC);
    eq([
      (im.match(/refusalWithContext\(ctx\.db, refusal, \{ requiredTier: PROJECT_QUOTA_UNLOCK_TIER \}\)/g) ?? []).length,
      (im.match(/\.replace\(\/\\n\/g, ''\)/g) ?? []).length,
    ], [2, 2], 'I-5h IM 两处建项目落点同样带用量，且括号内行内化（不塞换行）');
    // zx_20261023_1「称」: 节点数闸（`nodeQuotaCheck`）也是 Team 档回话，且同样带用量差异。
    //   期望值由**源码的形状**派生（Team 闸调用数 + 节点数闸数），不写死某个总数——
    //   将来再加闸而忘带 context 时，这个等式会红（数量对不上）。
    {
      const nodesCode = strip(NODES_IPC_SRC);
      const teamGateCalls = (nodesCode.match(/teamFeatureRefusal\(licDb/g) ?? []).length;
      const nodeQuotaGates = (nodesCode.match(/nodeQuotaCheck\(/g) ?? []).length;
      eq((nodesCode.match(/requiredTier: 'team'/g) ?? []).length, teamGateCalls + nodeQuotaGates,
        'I-5i 节点侧每处 Team 闸（含节点数闸）的回话都带用量与升级差异');
    }
    // zx_20261023_5 批三：设备侧新增 `devices:miio_token` 写口闸 ⇒ 幻数 5 改为由**闸调用数派生**
    //   （每处 `teamFeatureRefusal(licDb` 都须带用量回话；多一处带/少一处带皆红）。
    {
      const devicesCode = strip(DEVICES_IPC);
      const teamGateCalls = (devicesCode.match(/teamFeatureRefusal\(licDb/g) ?? []).length;
      eq((devicesCode.match(/requiredTier: 'team'/g) ?? []).length, teamGateCalls,
        'I-5j 设备侧每处 Team 闸的回话都带用量（由闸调用数派生）');
    }
    ok(/requiredTier: 'team'/.test(strip(EXTERNAL_IPC)) && /requiredTier: 'team'/.test(strip(TEAM_IPC_SRC)),
      'I-5k 外部终端与团队共享的 Team 闸同样带上用量');
  }
}

/** 知识册读侧源码里 `proFeatureRefusal` 的出现次数（用于 G-4h 的"零闸"断言）。 */
function projectKnowledgeGateCalls(): string[] {
  return strip(KNOWLEDGE_SRC).split(/\r?\n/).filter((l) => l.includes('proFeatureRefusal'));
}

async function main(): Promise<void> {
  console.log('\n=== zx_20261022_3 A 一把尺量余力 ===');
  groupA();
  console.log('\n=== zx_20261022_3 C 设备显态与诊断 ===');
  await groupC();
  console.log('\n=== zx_20261022_3 D 设备安全收口 ===');
  await groupD();
  console.log('\n=== zx_20261022_3 E 终端凭据可恢复 ===');
  groupE();
  console.log('\n=== zx_20261022_3 F 模型降级不丢硬需 ===');
  await groupF();
  console.log('\n=== zx_20261022_3 G 知识包往返 ===');
  groupG();
  console.log('\n=== zx_20261022_3 H 项目画像与 Team 共享 ===');
  groupH();
  console.log('\n=== zx_20261022_3 I 档位差异可见 ===');
  groupI();

  // build 钉（P1–P6 派生核对；P6 读 dist ⇒ tsup 须先于本套件）。
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

main().then(() => {
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} rr_zx_20261022_3: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error('套件异常：', e);
  console.log(`\nFAIL rr_zx_20261022_3: ${pass} 通过 / ${fail + 1} 失败\n`);
  process.exit(1);
});
