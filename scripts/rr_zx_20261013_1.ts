/**
 * zx_20261013_1 受控复跑 —— 批一「称器于事」：**能力匹配把关**（硬需缺 ⇒ 如实拒，不静默跑）。
 *
 * 本轮口径一句话（维特根斯坦·意义即使用 ／ 管子·度量衡 ／ 道德经·知不知上·损有余而补不足 ／
 *   毛选·实事求是·主要矛盾 ／ 王阳明·知行合一）：
 *   凡是系统已经知道"这个任务要什么能力"、却没按它去配的地方，要么真配上，要么如实说出为什么配不上。
 *
 * 病根（实测）：`capabilities` 长期是一张**平表**（底线 + 形态附加 + `vision`），全被当作硬需发给 ANS；
 *   而 ANS 两段式选型在**全中池为空**时会主动降到**部分命中**并带 `capabilityMatch:'partial'`；
 *   桌面侧 `compareModelCapabilities` 得 `missing` 后**只写会话行 + `logger.warn`，不拦**
 *   ⇒ 「要 `vision` 的任务拿到无 `vision` 的模型」被装配层逐件 omit 图片**掩盖**过去、任务照判"成功"。
 *
 * 治法：把能力由**平表**升为**分档表**（真源 `CAPABILITY_DEMAND`，在 `model-request.ts`）——
 *   · `hard`（缺即残废）`vision`/`chat`/`function-calling` ⇒ **如实拒**（写 `[选型失败]` + 抛）；
 *   · `soft`（缺可续跑）`code`/`reasoning` ⇒ 沿用既有 `[能力不符]`/`[降级选型]` 留痕（GUI 可见），续跑。
 *   一键回退：`engine.model_capability_gate = 'false'` ⇒ 逐字回本批前的"只记不拦"。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：判据一律静态导入生产导出（被删/改名即编译期失败）。
 *   G-2 **两侧标本**：凡判"硬需缺即拒"的判据，反面标本（够能力、不该拒）一并喂。
 *   G-5 判"用户可见文案还在不在"读 `stripKeepingLines` 后的代码（`CODE()`）；判"接线在册"读原文（`RD()`）。
 *   G-6 **无轮次字面量**：本轮方案路径/脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 *   ⚠ 夹具外键照搬生产 DDL 且 `PRAGMA foreign_keys = ON`（承 rr_zx_20261012_1 教训）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：分档真源 + 把关唯一实现，**静态导入**（改名/删除即编译期失败）。
import { CAPABILITY_DEMAND, assessCapabilityGate, capabilityGateMessage } from '../apps/worker-ant-desktop/src/main/core/model-request.js';
// G-1：批二 GUI 挂件——**跑生产实现本体**（落盘+形状+写者），不另造一条链。
import { importLocalAttachments } from '../apps/worker-ant-desktop/src/main/services/task-attachments.js';
import { appendTaskAttachments } from '../apps/worker-ant-desktop/src/main/services/pending-media.js';
// G-1：跑**生产选型段**本体（把关闸就落在它里面）。
import { selectModelForTask } from '../apps/worker-ant-desktop/src/main/core/exec-model-select.js';
// G-1：回退开关所依赖的白名单真源。
import { BOOL_SETTING_KEYS, boolSetting } from '../apps/worker-ant-desktop/src/main/core/settings-bool.js';
// G-1：批三 首启导览的**闸**（零 import 纯判定）——直跑真实现，不另写一份真值表。
import { shouldShowTour, parseTourDone } from '../apps/worker-ant-desktop/renderer/src/lib/tourGate.js';
// G-1：收口缺陷——retry **携带用户自述输入**的真函数（纯判定，直跑真实现 + 一处白名单真源）。
import { carryRetryContext, RETRY_CARRIED_CTX_KEYS } from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
// G-1：批五 MQTT 适配层——纯映射 + 编排 + 发现 io（假 IO ⇒ 不触网；真客户端只走惰性 `import('mqtt')`）。
import {
  MQTT_ADDR_SEP, DEFAULT_DISCOVERY_TOPIC, DEFAULT_MQTT_PORT,
  mqttAddress, mqttBrokerHost, mqttDeviceId, mqttTopicSegment,
  mqttDiscoveryToDevice, mqttCommandTopic, mqttCommandPayload, mqttBrokerUrl,
  mqttResultText, mqttAbsentText, mqttFailureText,
  parseMqttBroker, resolveMqttConfig,
  mqttDeviceControl, mqttDiscoveryIo,
  type MqttIo, type MqttSubscribeIo,
} from '../apps/worker-ant-desktop/src/main/core/device-mqtt.js';
// G-1：控制**派发**真源（`defaultDeviceControl` 的选路只此一处）+ 编排（`runDeviceControl`）。
import { runDeviceControl, defaultDeviceControl } from '../apps/worker-ant-desktop/src/main/core/tools/device.js';
// G-1：发现编排（`startDeviceDiscovery` 主体 + `composeDiscoveryIo` 并联）。
import { composeDiscoveryIo, startDeviceDiscovery, stopDeviceDiscovery, type DiscoveryIo } from '../apps/worker-ant-desktop/src/main/core/device-discovery.js';
// G-1：台账真源（落账/授权/审计——判据说一不二）。
import {
  upsertDiscovered, listDevices, setDeviceAuthorized, listDeviceActions, findDeviceByIdentity,
  type AnsDevice,
} from '../apps/worker-ant-desktop/src/main/core/device-registry.js';

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** 等值断言（把实际值一并打出——红的时候要能立刻看出"差在哪"）。 */
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');
const countOcc = (hay: string, needle: string): number => hay.split(needle).length - 1;

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''); // zx_20261013_1

type AnyDb = import('better-sqlite3').Database;

/* ── 夹具：选型段沿途要碰的表（外键照搬生产 `database.ts`）────────────────── */
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, description TEXT DEFAULT '', status TEXT DEFAULT 'active',
  owner_id TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id), parent_task_id TEXT DEFAULT '',
  title TEXT DEFAULT '', description TEXT DEFAULT '', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0,
  context_json TEXT DEFAULT '{}', depends_on TEXT DEFAULT '', source TEXT DEFAULT 'test',
  acceptance_criteria TEXT DEFAULT '', quality_score REAL, aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT REFERENCES wa_tasks(id), role TEXT NOT NULL,
  content TEXT DEFAULT '', tool_calls TEXT, token_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));
-- 批五：设备台账 + 控制审计（外键/唯一键照搬生产 database.ts——去重键 protocol+address 是"同一设备"的唯一判据）
CREATE TABLE wa_devices (id TEXT PRIMARY KEY, name TEXT DEFAULT '', alias TEXT DEFAULT '',
  kind TEXT DEFAULT 'unknown',
  protocol TEXT NOT NULL, address TEXT NOT NULL, port INTEGER, capabilities_json TEXT DEFAULT '[]',
  controllable INTEGER DEFAULT 0, authorized INTEGER DEFAULT 0, status_json TEXT,
  first_seen TEXT DEFAULT (datetime('now')), last_seen TEXT DEFAULT (datetime('now')), online INTEGER);
CREATE UNIQUE INDEX idx_wa_devices_ident ON wa_devices(protocol, address);
CREATE TABLE wa_device_actions (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, action TEXT NOT NULL,
  args_json TEXT DEFAULT '{}', result TEXT DEFAULT '', task_id TEXT DEFAULT '',
  actor_kind TEXT DEFAULT '', actor_ref TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')));
`;
const mkdb = (): AnyDb => {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  d.exec('PRAGMA foreign_keys = ON');
  return d as unknown as AnyDb;
};

/** 一份合法 ANS `getOptimalModel` 回包。端点用**环回未监听端口** ⇒ 探活确定性快速失败，不碰真网。 */
const selPayload = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'm-primary', model_name: 'qwen3.5:9b', url: 'http://127.0.0.1:1', api_key: 'k1',
  max_output_tokens: 4096, context_window: 128_000,
  input_price_per_1k: 0, output_price_per_1k: 0,
  capabilities: ['chat', 'function-calling'],
  capabilityMatch: 'full',
  sameProviderFallback: null, crossProviderFallback: null, fallback: null, ...o,
});

const convsOf = (db: AnyDb, taskId: string): string[] =>
  (db.prepare('SELECT content FROM wa_task_conversations WHERE task_id = ? ORDER BY rowid').all(taskId) as Array<{ content: string }>)
    .map((r) => r.content);

/** 跑一次**生产** `selectModelForTask`（连同它落下的会话行一并取回——"账"是本组主要取证）。 */
async function pickSel(db: AnyDb, taskId: string, opts: {
  archetype?: string;
  taskCtxJson?: string;
  payload?: Record<string, unknown>;
  settings?: Record<string, string>;
} = {}): Promise<{ thrown: string | null; modelCapabilities: string[] | null; conv: string[] }> {
  // ⚠ 会话行有 `task_id REFERENCES wa_tasks(id)`（生产 FK 开）⇒ 先补项目/任务父行，否则 INSERT 当场被拒、
  //   留痕**一行都落不下**——夹具不备父行而断言"账在"是自我印证（承 rr_zx_20261012_1 教训）。
  db.prepare("INSERT OR IGNORE INTO wa_projects (id, name) VALUES ('p-cap', '能力把关')").run();
  db.prepare("INSERT OR IGNORE INTO wa_tasks (id, project_id, status) VALUES (?, 'p-cap', 'executing')").run(taskId);
  for (const [k, v] of Object.entries(opts.settings ?? {})) {
    db.prepare("INSERT OR REPLACE INTO wa_settings (key, value) VALUES (?, ?)").run(k, v);
  }
  try {
    const r = await selectModelForTask({
      db: db as never, taskId, projectId: 'p-cap', taskCtxJson: opts.taskCtxJson ?? '{}',
      ansClient: { getOptimalModel: async () => selPayload(opts.payload) } as never,
      archetype: (opts.archetype ?? 'conversation') as never, modelStrategy: 'balanced',
    });
    return { thrown: null, modelCapabilities: 'modelCapabilities' in r ? r.modelCapabilities : null, conv: convsOf(db, taskId) };
  } catch (e) {
    return { thrown: (e as Error).message, modelCapabilities: null, conv: convsOf(db, taskId) };
  }
}

/** 一件**图片族**附件的任务上下文（判族退扩展名 `.png` ⇒ `image` ⇒ 需 `vision`；不需要真文件）。 */
const IMAGE_CTX = JSON.stringify({ attachments: [{ kind: 'image', fileName: 'photo.png' }] });

// ══════════════════════════════════════════════════════════════════
async function main(): Promise<void> {

  // ═══ A｜分档真源（纯函数直跑真实现）══════════════════════════════════════════════
  console.log('\n【A】能力分档真源 `CAPABILITY_DEMAND`（纯函数直测，两侧标本）');
  {
    // ── A-0 分档表**逐成员枚举**（不用幻数计数——"断言名冒充覆盖面"老病）────────────────
    const hard = Object.entries(CAPABILITY_DEMAND).filter(([, v]) => v === 'hard').map(([k]) => k).sort();
    const soft = Object.entries(CAPABILITY_DEMAND).filter(([, v]) => v === 'soft').map(([k]) => k).sort();
    eq(hard, ['chat', 'function-calling', 'vision'],
      'A-0a `hard` 档**逐一枚举**＝底线两项 + `vision`（缺即残废：不成对话／调不动工具／图根本看不见）');
    eq(soft, ['code', 'reasoning'],
      'A-0b `soft` 档**逐一枚举**＝形态附加两项（缺可续跑，但须对用户可见）');

    // ── A-1 ★该命中侧：硬需缺 ⇒ 分到 hardMissing ──────────────────────────────────
    const hit = assessCapabilityGate(['chat', 'function-calling', 'vision'], { capabilities: ['chat', 'function-calling'] });
    eq([hit.got, hit.hardMissing, hit.softMissing], [['chat', 'function-calling'], ['vision'], []],
      'A-1 ★★该命中：要 `vision` 而实得无 ⇒ `hardMissing=[vision]`（不再无声放过）');

    // ── A-2 ★反证（不该命中）：够能力 ⇒ hardMissing 空 ─────────────────────────────
    const full = assessCapabilityGate(['chat', 'function-calling', 'vision'], { capabilities: ['chat', 'function-calling', 'vision'] });
    eq([full.hardMissing, full.softMissing], [[], []],
      'A-2 ★反证：实得含全部所需 ⇒ 两级 missing 皆空（不冤枉一个有能力的模型）');

    // ── A-3 ★软需缺：归 softMissing，**不**归 hardMissing（主要矛盾：不搞一刀切全拦）────────
    const softMiss = assessCapabilityGate(['chat', 'function-calling', 'code'], { capabilities: ['chat', 'function-calling'] });
    eq([softMiss.hardMissing, softMiss.softMissing], [[], ['code']],
      'A-3 ★软需 `code` 缺 ⇒ 落在 `softMissing`（可续跑），**不**升为硬拒');

    // ── A-4 ★反证：回包**不带** `capabilities` ⇒ 无从比对，不编"不符" ─────────────────────
    const unknown = assessCapabilityGate(['chat', 'function-calling', 'vision'], { model_name: 'x' });
    eq([unknown.got, unknown.hardMissing, unknown.softMissing], [null, [], []],
      'A-4 ★反证：清单缺席 ⇒ `got:null` 且两级皆空（"无从比对"≠"不具备"——不许替不知道的事实签字）');

    // ── A-5 ★fail-open：未登表的能力一律按软（日后新增能力不因漏登记而硬拦死任务）───────────
    const unreg = assessCapabilityGate(['chat', 'cap-not-yet-registered'], { capabilities: ['chat'] });
    eq([unreg.hardMissing, unreg.softMissing], [[], ['cap-not-yet-registered']],
      'A-5 ★未表态能力 ⇒ 落软档（fail-open）——"漏登记"不得变成"莫名硬拒"');

    // ── A-6 ★批四：拒绝理由**逐字**成文（纯函数，三段俱到；两侧标本）─────────────────────
    eq(capabilityGateMessage({ demand: ['chat', 'function-calling', 'vision'], got: ['chat', 'function-calling'], hardMissing: ['vision'], modelName: 'qwen3.5:9b' }),
      '本任务硬需能力 [vision] 无模型可满足（本任务需 [chat, function-calling, vision]，选用模型 qwen3.5:9b 实得 [chat, function-calling]）',
      'A-6a ★该命中：理由**逐字**三段俱到（要什么／给了谁／实得什么——缺一段用户就看不出"差在哪"）');
    eq(capabilityGateMessage({ demand: ['vision'], got: null, hardMissing: ['vision'], modelName: null }),
      '本任务硬需能力 [vision] 无模型可满足（本任务需 [vision]，选用模型 未知 实得 []）',
      'A-6b ★反证（边界）：`got:null`（回包未带清单）⇒ 实得空、模型名"未知"——**如实成文，不编**');
  }

  // ═══ B｜生产把关（真跑 selectModelForTask，账为核心取证）══════════════════════════
  console.log('\n【B】选型段把关（真跑 `selectModelForTask`，两侧标本 + 一键回退）');
  {
    // ── B-1 ★★该命中：图片任务拿到无 vision 模型（ANS 部分命中）⇒ **如实拒** ────────────
    {
      const db = mkdb();
      const r = await pickSel(db, 't-cap-1', {
        archetype: 'conversation', taskCtxJson: IMAGE_CTX,
        payload: { capabilities: ['chat', 'function-calling'], capabilityMatch: 'partial' },
      });
      // 批四：理由由纯函数成文 ⇒ 这里**逐字**钉（此前只正则一个片段，措辞漂了也不响）。
      eq(r.thrown, capabilityGateMessage({ demand: ['chat', 'function-calling', 'vision'], got: ['chat', 'function-calling'], hardMissing: ['vision'], modelName: 'qwen3.5:9b' }),
        'B-1a ★★硬需 `vision` 无模型可满足 ⇒ **抛出**，且理由**逐字**同源于 `capabilityGateMessage`（不再让装配层 omit 图片把缺口掩盖成"成功"）');
      ok(r.conv.some((c) => c.startsWith('[选型失败]') && /vision/.test(c)),
        'B-1b ★账：落一条 `[选型失败] … vision …` 会话行（用户可在详情页读到为什么没开跑）',
        `账=${JSON.stringify(r.conv.slice(-2))}`);
    }

    // ── B-2 ★反证：同一图片任务，模型**带** vision ⇒ 不拒、正常返回 ────────────────────
    {
      const db = mkdb();
      const r = await pickSel(db, 't-cap-2', {
        archetype: 'conversation', taskCtxJson: IMAGE_CTX,
        payload: { capabilities: ['chat', 'function-calling', 'vision'], capabilityMatch: 'full' },
      });
      eq([r.thrown, r.modelCapabilities], [null, ['chat', 'function-calling', 'vision']],
        'B-2 ★反证：模型够能力 ⇒ 不拒，且回传**实得清单**供装配层判闸（同一件事不两处算）');
    }

    // ── B-3 ★软需缺不拦：`code` 形态拿到无 `code` 的模型 ⇒ 续跑（只留痕） ────────────────
    {
      const db = mkdb();
      const r = await pickSel(db, 't-cap-3', {
        archetype: 'code',
        payload: { capabilities: ['chat', 'function-calling'], capabilityMatch: 'partial' },
      });
      eq(r.thrown, null,
        'B-3a ★软需 `code` 缺 ⇒ **不拒**（主要矛盾：先抓 vision，不搞"任何能力缺都拦"）');
      ok(r.conv.some((c) => c.includes('[能力不符]') || c.includes('[降级选型]')),
        'B-3b ★但缺口**可见**：仍留 `[能力不符]`/`[降级选型]` 一行（GUI 可读，非静默）',
        `账=${JSON.stringify(r.conv.filter((c) => c.includes('能力') || c.includes('降级')))}`);
    }

    // ── B-4 ★一键回退：开关关 ⇒ 硬需缺也**逐字回旧行为**（只记不拦）─────────────────────
    {
      const db = mkdb();
      const r = await pickSel(db, 't-cap-4', {
        archetype: 'conversation', taskCtxJson: IMAGE_CTX,
        payload: { capabilities: ['chat', 'function-calling'], capabilityMatch: 'partial' },
        settings: { 'engine.model_capability_gate': 'false' },
      });
      eq(r.thrown, null,
        'B-4 ★回退闸：`engine.model_capability_gate=false` ⇒ 硬需缺**不抛**（一键回本批前"只记不拦"）');
    }

    // ── B-5 ★反证（边界）：回包无 `capabilities` ⇒ **不设闸**（不因"不知道"就拒任务）──────────
    {
      const db = mkdb();
      const r = await pickSel(db, 't-cap-5', {
        archetype: 'conversation', taskCtxJson: IMAGE_CTX,
        payload: { capabilities: undefined, capabilityMatch: undefined },
      });
      eq(r.thrown, null,
        'B-5 ★边界：ANS 回包不带能力清单 ⇒ 不拒（"无从比对"≠"不具备"，与 A-4 同一条尺）');
    }
  }

  // ═══ C｜一处真源 + 接线（静态，两侧标本）══════════════════════════════════════════
  console.log('\n【C】真源与接线（静态，防"判据一份、实现另一份"）');
  {
    const ems = CODE(`${A}/src/main/core/exec-model-select.ts`);
    // ── C-1 ★接线：生产选型段**真调**把关实现 ──────────────────────────────────────
    ok(/assessCapabilityGate\(modelCaps, modelResult\)/.test(ems),
      'C-1a ★生产调用方**真接线**：`assessCapabilityGate(modelCaps, modelResult)`（只定义不调＝"做了没用上"）');
    eq(countOcc(ems, 'assessCapabilityGate('), 1,
      'C-1b ★把关调用**恰一处**（多了就是第二道关、两边迟早分家）');
    // ── C-2 ★开关名与白名单**同源**（写口与读口不是两份名单）────────────────────────
    ok(ems.includes("readBoolSetting(db, 'engine.model_capability_gate')"),
      'C-2a ★读口用**全名** `engine.model_capability_gate`（非拼接、非别名）');
    ok(BOOL_SETTING_KEYS.includes('engine.model_capability_gate') && boolSetting(undefined) === true,
      'C-2b ★该键在 `BOOL_SETTING_KEYS` 白名单内且**缺省即开**（`boolSetting(undefined)===true`）');
    // ── C-3 ★反证：分档**不再**在选型段里第二次发生（"分档真源"只此一份）─────────────────
    eq(countOcc(ems, "'hard'"), 0,
      'C-3 ★反证：选型段内**零** hard 字面量——分档判据只住在 `CAPABILITY_DEMAND` 一处');
    // ── C-4 ★该命中侧：分档真源确在 model-request（`assessCapabilityGate` 定义处）────────
    const mrSrc = CODE(`${A}/src/main/core/model-request.ts`);
    ok(/export function assessCapabilityGate\(/.test(mrSrc) && /export const CAPABILITY_DEMAND/.test(mrSrc),
      'C-4 ★唯一实现：`assessCapabilityGate` 与 `CAPABILITY_DEMAND` 同在 `model-request.ts`（复算 `missing` 不另立第二本账）');
    ok(/compareModelCapabilities\(demand, reply\)/.test(mrSrc) && countOcc(mrSrc, 'demand.filter((c) => !got.includes(c))') === 1,
      'C-4b ★复算归一处：缺口仍由 `compareModelCapabilities` 现算（分档只**分**它已算出的 `missing`）');
    // ── C-5 ★批四：措辞一处真源（执行体只落账+抛，不自己拼那句话）───────────────────────
    eq(countOcc(ems, '本任务硬需能力'), 0,
      'C-5a ★反证：选型段**零**该话术字面量——措辞只在 `capabilityGateMessage` 一处（改口径不必扫两处）');
    eq(countOcc(ems, 'capabilityGateMessage('), 1,
      'C-5b ★选型段调用**恰一处** `capabilityGateMessage(`（只定义不调＝"抽了没用上"）');
    // ── C-6 ★"一键回退"**可达**：GUI 有读写口（只在白名单里注册≠用户点得到）───────────────
    const stp = CODE(`${A}/renderer/src/pages/SettingsPage.tsx`);
    ok(/boolSetting\(all\['engine\.model_capability_gate'\]\)/.test(stp),
      'C-6a ★GUI **读**口：`boolSetting(all[\'engine.model_capability_gate\'])`（面板显示真值，不自造缺省）');
    ok(/invoke\('settings:set', 'engine\.model_capability_gate'/.test(stp),
      'C-6b ★GUI **写**口：`settings:set \'engine.model_capability_gate\'`（无写口 ⇒ "一键回退"只存在于 DB 直改）');
    ok(stp.includes('启用能力把关'),
      'C-6c ★用户可见文案「启用能力把关」在册（入口可达，不只是背面接线）');
    // 反证：抹掉写口 ⇒ 同判据为否 ⇒ 判据抓得住"一键回退不可达"
    ok(!/invoke\('settings:set', 'engine\.model_capability_gate'/.test(
        stp.replace(/invoke\('settings:set', 'engine\.model_capability_gate'/, '')),
      'C-6d ★反证：抹掉写口后同判据为否 ⇒ 抓得住"一键回退不可达"');
  }

  // ═══ D｜批二 · GUI 挂件（本地件 → 同一条链：落盘 `im-media` / 形状 `attachmentEntry` / 写者 `appendTaskAttachments`）═══
  console.log('\n【D】批二 GUI 挂件（生产实现直跑 + 一处真源 + 接线，两侧标本）');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-att-'));
    const when = new Date('2026-10-13T03:04:05.000Z');
    const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    try {
      // ── D-1 ★该命中：一件 `.png` ⇒ 一条 entry（落盘真发生、形状真同源）──────────────────
      {
        const p = path.join(tmp, 'report.png');
        const r = importLocalAttachments(tmp, [p], { now: when, io: { readFile: () => PNG_HEAD, statSize: () => PNG_HEAD.length } });
        const e = (r.entries[0] ?? {}) as Record<string, unknown>;
        eq([r.failures.length, r.entries.length], [0, 1], 'D-1a ★成功一件 ⇒ 恰一条 entry、零失败');
        eq([e.kind, e.channel, e.fileName, e.at], ['image', 'desktop', 'report.png', when.toISOString()],
          'D-1b ★形状同源：`kind`=族名（`familyOf` 判）、`channel`=`desktop`、件名=basename、`at`=ISO');
        ok(typeof e.path === 'string' && path.resolve(String(e.path)).split(path.sep).includes('attachments')
          && String(e.path).includes(path.join('attachments', '20261013')),
          'D-1c ★盘上路径落在 `<dataDir>/attachments/<UTC 日>/` 之下（日期用 **UTC**，与库内同一时钟基准）', String(e.path));
        ok(fs.existsSync(String(e.path)) && fs.statSync(String(e.path)).size === PNG_HEAD.length,
          'D-1d ★★**字节真落盘**且大小相符（不是"记了一条、盘上没有"）', `${fs.existsSync(String(e.path)) ? fs.statSync(String(e.path)).size : 'missing'}B`);
      }

      // ── D-2 ★反证（先判后读）：超族上限件 ⇒ 拒而不整读（readFile 抛=不许被调）─────────────
      {
        const cap = 10 * 1024 * 1024; // `.png` ⇒ image 族上限（真源 `attachment-kinds.IMAGE_MAX_BYTES`）
        const r = importLocalAttachments(tmp, [path.join(tmp, 'big.png')], {
          now: when, io: { readFile: () => { throw new Error('不应被读取——超限件须在读之前就拒'); }, statSize: () => cap + 1 },
        });
        eq([r.entries.length, r.failures.length], [0, 1], 'D-2a ★超限件 ⇒ 零 entry、恰一条失败');
        ok(/超过上限/.test(String(r.failures[0]?.error)), 'D-2b ★失败**带真因**（超上限，含实测/上限字节数）', r.failures[0]?.error);
      }

      // ── D-3 ★反证：读盘失败 ⇒ 记真因，**不抛**（一件坏件不得把整批吞掉/把动作搞挂）──────────
      {
        const r = importLocalAttachments(tmp, [path.join(tmp, 'locked.pdf')], {
          now: when, io: { readFile: () => { throw new Error('EACCES 假因：拒绝访问'); }, statSize: () => 10 },
        });
        eq([r.entries.length, r.failures.length], [0, 1], 'D-3a ★读盘抛 ⇒ 转成一条失败（永不上抛）');
        ok(/EACCES/.test(String(r.failures[0]?.error)), 'D-3b ★失败原样带出读盘真因（不吞、不改写成"未知原因"）', r.failures[0]?.error);
      }

      // ── D-4 ★反证（边界）：空白路径既不产 entry 也不产 failure（"没请求"≠"失败"）──────────
      {
        const r = importLocalAttachments(tmp, ['', '   '], { now: when, io: { readFile: () => PNG_HEAD, statSize: () => 1 } });
        eq([r.entries.length, r.failures.length], [0, 0], 'D-4 ★空白项跳过：两数组皆空（不把"空"编造成"挂了一件失败的"）');
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

    // ── D-5 ★写者：追加不覆盖（真跑 sqlite；"第二件顶掉第一件"是不可见的丢失）──────────────
    {
      const db = mkdb();
      db.prepare("INSERT OR IGNORE INTO wa_projects (id, name) VALUES ('p-att', '附件')").run();
      db.prepare("INSERT INTO wa_tasks (id, project_id, status) VALUES ('t-att', 'p-att', 'pending')").run();
      const nOf = (): number => (db.prepare("SELECT json_array_length(json_extract(COALESCE(context_json,'{}'),'$.attachments')) AS n FROM wa_tasks WHERE id='t-att'").get() as { n: number }).n;
      appendTaskAttachments(db as never, 't-att', [{ path: '/x/a.png', kind: 'image', channel: 'desktop' }]);
      eq(nOf(), 1, 'D-5a 首次挂件 ⇒ 落 1 件');
      appendTaskAttachments(db as never, 't-att', [{ path: '/x/b.png', kind: 'image', channel: 'desktop' }]);
      eq(nOf(), 2, 'D-5b ★★追加不覆盖：第二次挂件 ⇒ 2 件（先前那件没被顶掉）');
      appendTaskAttachments(db as never, 't-att', []);
      eq(nOf(), 2, 'D-5c ★空数组 ⇒ 不写（"没有"不得把既有件盖成 `[]`）');
    }

    // ── D-6 ★接线：建任务路 + 详情页路**真调**生产实现（只定义不调＝"做了没用上"）───────────
    {
      const pipc = CODE(`${A}/src/main/ipc/project.ipc.ts`);
      ok(pipc.includes('importLocalAttachments(dataDir, attachment_paths)'),
        'D-6a ★建任务路真调 `importLocalAttachments(dataDir, attachment_paths)`');
      ok(/appendTaskAttachments\(db, id, imported\.entries\)/.test(pipc),
        'D-6b ★建任务路落库走**唯一写者** `appendTaskAttachments`（不另写 json_set）');
      ok(pipc.includes("ipcMain.handle('task:attachFiles'"),
        'D-6c ★`task:attachFiles` 通道在册（详情页「挂附件」的路）');
      eq([countOcc(pipc, 'appendTaskAttachments('), countOcc(pipc, 'importLocalAttachments(')], [2, 2],
        'D-6d ★两条路（建任务/详情页）各调一次**同一对**生产件——恰两处，无第三条路自造实现');
      ok(/attachment_paths\?: string\[\]/.test(pipc), 'D-6e `task:create` 签名收 `attachment_paths`');
    }

    // ── D-7 ★一处真源（反证"第二套实现"）：本模块只**编排**，不自己落盘/写库 ────────────────
    {
      const ta = CODE(`${A}/src/main/services/task-attachments.ts`);
      ok(/from '\.\/im-media\.js'/.test(ta) && ta.includes('saveInboundMedia('),
        'D-7a 落盘走 `im-media` 真源（不另造落盘）');
      ok(/from '\.\/pending-media\.js'/.test(ta) && ta.includes('attachmentEntry('),
        'D-7b 形状走 `attachmentEntry` 真源（不另写形状字面量）');
      eq(countOcc(ta, 'writeFileSync('), 0, 'D-7c ★反证：本模块零 `writeFileSync`——落盘只在 `im-media` 一处');
      eq(countOcc(ta, 'json_set('), 0, 'D-7d ★反证：本模块零 `json_set`——写库只在 `pending-media` 一处');
    }

    // ── D-8 ★跨层接线：preload / 类型 / renderer 三处都补齐（renderer 是词表第二落点）─────────
    {
      const pre = CODE(`${A}/src/preload/index.ts`);
      ok(pre.includes('dialog:openFiles'), 'D-8a preload 暴露多选对话框通道 `dialog:openFiles`');
      ok(pre.includes('webUtils.getPathForFile'), 'D-8b 拖拽件取路径走 `webUtils.getPathForFile`（Electron ≥32 的唯一口）');
      const ipcLib = CODE(`${A}/renderer/src/lib/ipc.ts`);
      ok(/attachment_paths: attachmentPaths/.test(ipcLib), 'D-8c renderer `tasks.create` 真送 `attachment_paths`');
      ok(ipcLib.includes("'task:attachFiles'"), 'D-8d renderer `tasks.attachFiles` 通道在册');
      const t1 = CODE(`${A}/src/preload/types.ts`);
      const t2 = CODE(`${A}/renderer/src/types/electron.d.ts`);
      ok(t1.includes('openFilesDialog') && t1.includes('getPathForFile'), 'D-8e preload 类型声明补齐');
      ok(t2.includes('openFilesDialog') && t2.includes('getPathForFile'),
        'D-8f renderer 类型声明补齐（**第二落点**——不补则 GUI 编译不过，是"做了没用上"的常见形状）');
    }

    // ── D-9 ★用户可见入口：新建面板选/拖入口 + 详情页挂件动作真接线 ──────────────────────────
    {
      const tp = CODE(`${A}/renderer/src/pages/TasksPage.tsx`);
      ok(tp.includes('openFilesDialog'), 'D-9a 新建任务面板有**选文件**入口');
      ok(tp.includes('getPathForFile'), 'D-9b 新建任务面板有**拖拽**入口');
      const td = CODE(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
      ok(/tasks\.attachFiles\(/.test(td), 'D-9c 详情页「挂附件」真调 `tasks.attachFiles`');
    }
  }

  // ═══ E｜批三 · 首启一次性导览（词表同源 + 两态 + 一处写口，反证"第二份词表"）═══════════
  console.log('\n【E】批三 首启导览（真跑闸 + 同源反证 + 接线，两侧标本）');
  {
    // ── E-1 ★两态真源：一次性标记 ∧ 会话级跳过（真值表，三格）────────────────────────────
    eq(shouldShowTour({ done: false, skipped: false }), true,
      'E-1a ★该弹：未落库 ∧ 未跳过 ⇒ 弹');
    eq(shouldShowTour({ done: true, skipped: false }), false,
      'E-1b ★★一次性：**落库**过后 ⇒ 永不重弹（"一次性"三字的全部兑现处）');
    eq(shouldShowTour({ done: false, skipped: true }), false,
      'E-1c ★★会话级：本次跳过 ⇒ 不弹（且见 E-5d：**不落库**——刷新仍如实引导）');

    // ── E-2 ★落库值解析：只有确凿的"看过"才算看过 ─────────────────────────────────────
    eq([parseTourDone('1'), parseTourDone('true'), parseTourDone('TRUE')], [true, true, true],
      'E-2a ★`1`/`true`（忽略大小写）⇒ 已看过');
    eq([parseTourDone(null), parseTourDone(''), parseTourDone('0'), parseTourDone('yes')], [false, false, false, false],
      'E-2b ★反证：缺省/空/`0`/怪值 ⇒ **未看过**（宁可按没看过如实引导，不静默吞掉整个导览）');

    // ── E-3 ★★词表同源：导航表只一处，侧栏从它引入（反证：自持第二份 ⇒ 红）─────────────────
    const layout = CODE(`${A}/renderer/src/components/AppLayout.tsx`);
    const nav = CODE(`${A}/renderer/src/lib/navConfig.ts`);
    eq(countOcc(layout, 'const NAV_GROUPS'), 0,
      'E-3a ★★反证：`AppLayout` **不再**自持导航表——词表已提为真源，侧栏改从 `navConfig` 引入');
    ok(/import \{ NAV_GROUPS \} from '\.\.\/lib\/navConfig'/.test(layout),
      'E-3b ★侧栏**从真源引入** `NAV_GROUPS`（不是"复制一份过去"）');
    ok(/export const NAV_GROUPS/.test(nav) && /export function tourEntries\(\)/.test(nav),
      'E-3c ★真源同处导出导航表与**派生**条目 `tourEntries()`（凡带 `tour` 者入册）');

    // ── E-4 ★★导览组件不自持词表（"第二份词表"是 `biz_20261011 §3` 点名要避的）────────────
    const tour = CODE(`${A}/renderer/src/components/TourOverlay.tsx`);
    ok(/import \{ tourEntries/.test(tour) && tour.includes('tourEntries()'),
      'E-4a ★导览词表**从导航配置派生**（`tourEntries()`），不手写入口清单');
    {
      // 反证：导航 label 若出现在导览组件里，就是第二份词表（注释已剥离，只认代码）。
      const labels = ['协同面板', 'AI模型', '技能', 'MCP服务', '项目', '任务', '产出物', 'IM渠道', '系统记忆'];
      const leaked = labels.filter((l) => countOcc(tour, `'${l}'`) > 0);
      eq(leaked, [], 'E-4b ★★反证：导览组件**零**导航 label 字面量（手写第二份词表 ⇒ 此处即红）');
    }

    // ── E-5 ★落点接线：弹一次 ∧ 一处写口 ∧ 跳过不落库 ──────────────────────────────────
    const dash = CODE(`${A}/renderer/src/pages/DashboardPage.tsx`);
    ok(dash.includes("invoke<string | null>('settings:get', TOUR_SETTING_KEY)"),
      'E-5a ★读口：按**同一常量** `TOUR_SETTING_KEY` 读一次性标记');
    ok(/invoke\('settings:set', TOUR_SETTING_KEY, '1'\)/.test(dash),
      'E-5b ★写口：走完落库（写 `1`）');
    eq(countOcc(dash, "'settings:set', TOUR_SETTING_KEY"), 1,
      'E-5c ★写口**恰一处**（多了就是两处各记各的）');
    ok(/skipOnboarding\(\)/.test(dash),
      'E-5d ★跳过走**会话级**软跳过 `skipOnboarding()`（复用既有出口，**不落库** ⇒ 刷新仍如实引导）');
    ok(/<TourOverlay onDone=/.test(dash),
      'E-5e ★浮层真挂上（只定义不挂＝"做了没用上"）');
    eq(countOcc(tour, "'settings:set'"), 0,
      'E-5f ★反证：导览组件**自己不写库**——落点只在调用方，一处写口好核查');

    // ── E-6 ★锚点：侧栏入口带 `data-tour`（浮层据此定位高亮）───────────────────────────
    ok(/data-tour=\{to\}/.test(layout),
      'E-6 ★侧栏 NavLink 带 `data-tour={to}`（锚点由**同一份** `to` 派生，不另写第二套路由串）');

    // ── E-7 ★零依赖：闸模块不引任何东西（渲染层引不炸 ∧ rr 直跑得动）─────────────────────
    const gateSrc = CODE(`${A}/renderer/src/lib/tourGate.ts`);
    ok(!/^\s*import\s/m.test(gateSrc),
      'E-7 ★`tourGate` 零 import（rr 直跑真实现、渲染层引不炸——与 `attachment-kinds` 同款）');
  }

  // ═══ F｜批五 · 适配层首切片（真跑生产实现；假 IO ⇒ 不触网；两侧标本 + 反证）═══════════════
  console.log('\n【F】批五 MQTT 适配层首切片（纯映射 + 编排 + 派发 + 发现落账；反证"旧桩/第二条路"）');
  {
    const MQTT_SRC = `${A}/src/main/core/device-mqtt.ts`;
    const DEV_TOOLS_SRC = `${A}/src/main/core/tools/device.ts`;
    const DEV_IPC_SRC = `${A}/src/main/ipc/devices.ipc.ts`;
    /** 一台"MQTT 灯"夹具（`cmd:`/`state:` 自述齐备——判据全由能力串派生，不预设）。 */
    const mqttLamp = (o: Partial<AnsDevice> = {}): AnsDevice => ({
      id: 'd-mqtt-1', name: '客厅灯', alias: '', kind: 'light', protocol: 'mqtt',
      address: mqttAddress('192.168.1.9', 'lamp1'), port: DEFAULT_MQTT_PORT,
      capabilities: ['mqtt', 'cmd:home/lamp1/set', 'state:home/lamp1/state'],
      controllable: true, authorized: false, status: null, first_seen: '', last_seen: '', ...o,
    });

    // ── F-1 ★纯映射：地址约定 `broker#deviceId` 可逆（去重键须含设备身份，不能只剩 broker）────────
    eq([mqttAddress('192.168.1.9', 'lamp1'), MQTT_ADDR_SEP], ['192.168.1.9#lamp1', '#'],
      'F-1a 台账地址＝`broker#deviceId`（分隔符取自真源常量 `MQTT_ADDR_SEP`）');
    {
      const addr = mqttAddress('192.168.1.9', 'lamp1');
      eq([mqttBrokerHost(addr), mqttDeviceId(addr)], ['192.168.1.9', 'lamp1'],
        'F-1b ★可逆：同一地址**取回** broker 与 deviceId（同 broker 上两台设备不撞去重键）');
      eq([mqttBrokerHost('192.168.1.9'), mqttDeviceId('192.168.1.9')], ['192.168.1.9', '192.168.1.9'],
        'F-1c 反证（边界）：无分隔符 ⇒ 原样返回（"没找到分隔符"≠"没有主机"）');
      eq([mqttBrokerUrl(mqttLamp()), mqttBrokerUrl(mqttLamp({ port: null }))],
        ['mqtt://192.168.1.9:1883', 'mqtt://192.168.1.9:1883'],
        'F-1d broker URL：端口缺省取 `DEFAULT_MQTT_PORT`（`port:null` 亦兜底，不留 `:null`）');
    }

    // ── F-2 ★主题段归一：通配符/分隔符/空白一律洗掉（防设备自述把命令发到别人的主题）────────────
    eq([mqttTopicSegment('workerant/+/#'), mqttTopicSegment('/lamp1'), mqttTopicSegment(''), mqttTopicSegment('a b')],
      ['workerant', 'lamp1', 'device', 'a_b'],
      'F-2 ★`/`+`#`/空白 ⇒ 洗成 `_` 并去首尾；洗空 ⇒ 兜底 `device`（通配符注入被挡在主题之外）');

    // ── F-3 ★纯映射（两侧标本）：自述 JSON → DiscoveredDevice；认不出 ⇒ null ──────────────────
    {
      const dev = mqttDiscoveryToDevice(
        'workerant/discovery/living-room-lamp',
        JSON.stringify({ id: 'lamp1', name: '客厅灯', kind: 'light', cmd: 'home/lamp1/set', state: 'home/lamp1/state', model: 'X1' }),
        '192.168.1.9', DEFAULT_MQTT_PORT,
      );
      eq(dev && [dev.protocol, dev.address, dev.port, dev.name],
        ['mqtt', '192.168.1.9#lamp1', DEFAULT_MQTT_PORT, '客厅灯'],
        'F-3a ★该命中：协议 `mqtt`／地址带 broker 前缀／端口与自述名俱到');
      eq(dev?.capabilities, ['mqtt', 'cmd:home/lamp1/set', 'state:home/lamp1/state'],
        'F-3b ★能力**全取自述**（`cmd:`/`state:` 原样记入，本机不预设）');
      eq([dev?.kind, dev?.controllable], ['light', true],
        'F-3c ★`kind` 经既有 `deriveDeviceKind`（与 mDNS/SSDP 同一把尺）；自述带命令主题 ⇒ 自称可控');
      // 反证：id 缺省 ⇒ 取主题末段，命令主题随之派生（"没给 id 也能被点着"，不是"缺字段就丢件"）
      const d2 = mqttDiscoveryToDevice('workerant/discovery/plug-7', JSON.stringify({ kind: 'switch' }), '192.168.1.9', null);
      eq([d2?.address, d2?.capabilities, d2?.kind], ['192.168.1.9#plug-7', ['mqtt', 'cmd:plug-7/set'], 'switch'],
        'F-3d ★反证：自述无 `id` ⇒ 取主题末段、命令主题派生 `<id>/set`');
      // 反证：非 JSON／`null`／数组／标量／空 ⇒ 一律 null（不硬塞、不猜）
      eq(['not json', 'null', '[1,2]', '42', ''].map((r) => mqttDiscoveryToDevice('t/x', r, 'h', null)),
        [null, null, null, null, null],
        'F-3e ★★反证：非 JSON／`null`／数组／标量／空 ⇒ 一律 `null`（认不出即不入账，不硬塞）');
    }

    // ── F-4 ★broker 解析（纯函数，两侧标本）──────────────────────────────────────────────
    eq(parseMqttBroker('192.168.1.9'), { host: '192.168.1.9', port: DEFAULT_MQTT_PORT }, 'F-4a 裸 `host` ⇒ 缺省端口 1883');
    eq(parseMqttBroker('mqtt://192.168.1.9:8884'), { host: '192.168.1.9', port: 8884 }, 'F-4b 带 scheme + 显式端口 ⇒ 照收');
    eq(parseMqttBroker('mqtts://broker.local'), { host: 'broker.local', port: 8883 }, 'F-4c `mqtts://` ⇒ 缺省端口 8883（TLS 非 1883）');
    eq(parseMqttBroker('ws://h:9001/path'), { host: 'h', port: 9001 }, 'F-4d `ws://` + 路径 ⇒ 去路径、取主机与端口');
    eq([parseMqttBroker('  '), parseMqttBroker(null), parseMqttBroker(undefined)], [null, null, null],
      'F-4e ★反证：空／缺省 ⇒ `null`（没有 broker 就是没有，不编一个默认的）');

    // ── F-5 ★配置解析：**缺省关**（连 broker 是可被察觉的网络行为，须人显式开）────────────────
    {
      const off = resolveMqttConfig(() => null);
      eq([off.enabled, off.broker, off.discoveryTopic], [false, null, DEFAULT_DISCOVERY_TOPIC],
        'F-5a ★★缺省 ⇒ `enabled:false` + `broker:null` + 默认发现主题（**不是** `boolSetting` 那族"缺省即开"）');
      const get = (m: Record<string, string>) => (k: string): string | null => m[k] ?? null;
      const on = resolveMqttConfig(get({ 'device.mqtt.enabled': '1', 'device.mqtt.broker': '192.168.1.9' }));
      eq([on.enabled, on.broker], [true, { host: '192.168.1.9', port: DEFAULT_MQTT_PORT }],
        'F-5b 开关开 ∧ 有 broker ⇒ 启用');
      const noBroker = resolveMqttConfig(get({ 'device.mqtt.enabled': 'true' }));
      eq([noBroker.enabled, noBroker.broker], [false, null],
        'F-5c ★反证：开关开但**没配 broker** ⇒ 仍不启用（缺 broker 的"开"没有意义）');
      const onWord = resolveMqttConfig(get({ 'device.mqtt.enabled': 'on', 'device.mqtt.broker': 'h', 'device.mqtt.discovery_topic': 'my/#' }));
      eq([onWord.enabled, onWord.discoveryTopic], [true, 'my/#'],
        'F-5d `on` 亦作开；发现主题可由设置覆盖（不与缺省混为一谈）');
    }

    // ── F-6 ★编排（假 IO ⇒ 不触网）：命令主题/载荷/回执/失败，人话逐字同源 ─────────────────────
    {
      eq(mqttCommandTopic(mqttLamp()), 'home/lamp1/set', 'F-6a 命令主题取自述 `cmd:` 能力（不自造）');
      const seen: Array<{ topic: string; payload: string }> = [];
      const okIo: MqttIo = { async publish(_d, topic, payload) { seen.push({ topic, payload }); return { ok: true, ack: 'ON' }; } };
      const r = await mqttDeviceControl(mqttLamp(), 'turn_on', {}, okIo);
      eq([r.ok, r.result], [true, mqttResultText('home/lamp1/set', 'ON')],
        'F-6b ★成功：人话**逐字**同源于 `mqttResultText`');
      eq(seen, [{ topic: 'home/lamp1/set', payload: mqttCommandPayload('turn_on', {}) }],
        'F-6c ★发布**恰一次**：主题＝自述 `cmd`，载荷＝`{action,...args}` JSON（动作与参数一体）');
      const noAck = await mqttDeviceControl(mqttLamp(), 'turn_off', {}, { async publish() { return { ok: true, ack: null }; } });
      eq([noAck.ok, noAck.result], [true, mqttResultText('home/lamp1/set', null)],
        'F-6d ★无状态回执 ⇒ 以 broker PUBACK 为准并**如实说明**设备没回（不假装"设备已确认"）');
      const bad = await mqttDeviceControl(mqttLamp(), 'turn_on', {}, { async publish() { return { ok: false, error: 'broker 拒收：denied' }; } });
      eq([bad.ok, bad.result], [false, mqttFailureText('broker 拒收：denied')],
        'F-6e ★失败：原因**原样**带出（`mqttFailureText` 逐字，不吞不改写）');
      const threw = await mqttDeviceControl(mqttLamp(), 'turn_on', {}, { async publish() { throw new Error('socket 断了'); } });
      eq([threw.ok, threw.result], [false, mqttFailureText('socket 断了')],
        'F-6f ★反证（边界）：发布**抛异常** ⇒ 转成失败人话，不上抛（"没预料的崩"也不得变成假成功）');
    }

    // ── F-7 ★反证：诚实缺席（未装客户端）——文案逐字 + 接线在册（真客户端在场，故只静态核那一跳）──
    eq(mqttAbsentText(), '本机未安装 MQTT 客户端（`mqtt`）——该设备暂不可经本机控制（如实告知，不假装成功）。',
      'F-7a ★缺席人话**逐字**（"没装"≠"操作失败"——不许把缺席写成失败）');
    {
      const src = CODE(MQTT_SRC);
      eq(countOcc(src, 'if (!client) return { ok: false, result: mqttAbsentText() }'), 1,
        'F-7b ★接线在册：客户端为 `null` 时**唯一一跳**回 `mqttAbsentText()`（不是那句"操作失败"）');
      ok(/defaultMqttIo\(\): Promise<MqttIo \| null> \{[\s\S]{0,80}?if \(!connect\) return null;/.test(src),
        'F-7c ★`defaultMqttIo` 在客户端缺席时返 `null`（缺席由此传导到 F-7b 那一跳）');
      ok(!/^\s*import\s[^\n]*from 'mqtt'/m.test(src) && src.includes("await import('mqtt')"),
        'F-7d ★惰性契约：**无**顶层静态 `import … from \'mqtt\'`，只有 `await import(\'mqtt\')`（不装客户端也照跑）');
    }

    // ── F-8 ★编排层闸（跑生产 `runDeviceControl`）：未授权**不触传动**（两侧标本，承 M9-A）──────────
    {
      const db = mkdb();
      const d = upsertDiscovered(db as never, { name: '灯', kind: 'light', protocol: 'http', address: '192.168.1.20', port: 8080, capabilities: ['switch'], controllable: true });
      let calls = 0;
      const spy = async (): Promise<{ ok: boolean; result: string }> => { calls++; return { ok: true, result: '已下发' }; };
      const unauth = await runDeviceControl(db as never, { deviceId: d.id, action: 'turn_on' }, spy);
      eq([unauth.ok, (unauth as { denied?: boolean }).denied, calls], [false, true, 0],
        'F-8a ★★未授权 ⇒ 被拒且**传动零调用**（闸在编排里，未授权绝不真发命令）');
      eq(listDeviceActions(db as never, d.id).map((a) => a.result), ['denied'],
        'F-8b ★★账：被拒也留一行 `denied`（"全量留痕"含拒绝件——0→1 正面断言）');
      setDeviceAuthorized(db as never, d.id, true);
      const auth = await runDeviceControl(db as never, { deviceId: d.id, action: 'turn_on' }, spy);
      eq([auth.ok, auth.result, calls], [true, '已下发', 1],
        'F-8c ★反证：授权后 ⇒ 传动**恰调用一次**、结果原样回（同一把尺，不是"一律拒"）');
      eq(listDeviceActions(db as never, d.id).map((a) => a.result).sort(), ['denied', 'ok'],
        'F-8d ★账（多一行）：两次控制两条审计俱在（同秒时刻不判序，只判俱在）');
    }

    // ── F-9 ★派发**一处**：`mqtt`→适配层、其余→HTTP；SSRF 各核各的对象（两侧标本）────────────
    {
      const seen: string[] = [];
      const r1 = await defaultDeviceControl(mqttLamp(), 'turn_on', {}, { async publish() { seen.push('pub'); return { ok: true, ack: null }; } });
      eq([r1.ok, seen.length], [true, 1], 'F-9a ★局域网 broker ⇒ 走 MQTT 适配层（发布恰一次）');
      const wan = mqttLamp({ address: mqttAddress('203.0.113.5', 'lamp1') });
      const seen2: string[] = [];
      const r2 = await defaultDeviceControl(wan, 'turn_on', {}, { async publish() { seen2.push('pub'); return { ok: true, ack: null }; } });
      eq([r2.ok, seen2.length, /非局域网/.test(r2.result)], [false, 0, true],
        'F-9b ★★反证：非局域网 broker ⇒ **拒出站且零发布**（围栏核的是 broker 主机这一对象）');
      const httpDev: AnsDevice = { ...mqttLamp(), id: 'd-http', protocol: 'http', address: '203.0.113.9', port: 80, capabilities: ['switch'] };
      const r3 = await defaultDeviceControl(httpDev, 'turn_on', {});
      eq([r3.ok, /MQTT broker/.test(r3.result), /设备地址/.test(r3.result)], [false, false, true],
        'F-9c ★反证（选路）：非 MQTT 设备 ⇒ 走 HTTP 分支（拒因用 HTTP 措辞"设备地址"，不是 MQTT 的"broker"——两路确为两条）');
    }

    // ── F-10 ★发现 io（假订阅面 ⇒ 不触网）：自述 → 落账 端到端；认不出**跳过**不拖垮 ───────────
    {
      const db = mkdb();
      let capturedTopic = ''; let emit: ((t: string, p: string) => void) | null = null; let stopped = 0;
      const fakeSub: MqttSubscribeIo = {
        subscribe(topic, onMessage) { capturedTopic = topic; emit = onMessage; },
        stop() { stopped++; },
      };
      const discovered: string[] = [];
      startDeviceDiscovery(db as never, {
        io: mqttDiscoveryIo({ brokerHost: '192.168.1.9', brokerPort: DEFAULT_MQTT_PORT, io: fakeSub }),
        onDiscovered: (row) => discovered.push(row.id),
      });
      eq(capturedTopic, DEFAULT_DISCOVERY_TOPIC, 'F-10a ★订阅的是发现主题（缺省 `workerant/discovery/#`）');
      emit!('workerant/discovery/lamp1', JSON.stringify({ name: '客厅灯', kind: 'light' }));
      const rows = listDevices(db as never);
      eq([rows.length, rows[0]?.protocol, rows[0]?.address, discovered.length], [1, 'mqtt', '192.168.1.9#lamp1', 1],
        'F-10b ★★端到端：MQTT 自述**真落台账**（发现→入账走既有那一面），回调报一次');
      emit!('workerant/discovery/lamp1', 'garbage not json');
      eq(listDevices(db as never).length, 1, 'F-10c ★反证：认不出的载荷**跳过**（不新增行、不拖垮整轮）');
      emit!('workerant/discovery/lamp1', JSON.stringify({ name: '客厅灯改名', kind: 'light' }));
      eq([listDevices(db as never).length, findDeviceByIdentity(db as never, 'mqtt', '192.168.1.9#lamp1') != null], [1, true],
        'F-10d ★反证（幂等）：同一身份再发 ⇒ **仍一行**（去重键 `protocol+address` 收束，不重复入账）');
      stopDeviceDiscovery();
      eq(stopped, 1, 'F-10e ★收摊：停发现 ⇒ 订阅面停止一次（socket 不留半开）');
    }

    // ── F-11 ★并联（mDNS/SSDP 与 MQTT 并跑）：`composeDiscoveryIo` 两路皆起、两路皆停 ─────────
    {
      const started: string[] = []; const halted: string[] = [];
      const mk = (tag: string): DiscoveryIo => ({ start() { started.push(tag); }, stop() { halted.push(tag); } });
      startDeviceDiscovery(mkdb() as never, { io: composeDiscoveryIo(mk('mdns'), mk('mqtt')) });
      eq(started, ['mdns', 'mqtt'], 'F-11a ★并联：两路俱起（单 io 装不下的多路发现收成一个）');
      stopDeviceDiscovery();
      eq(halted, ['mdns', 'mqtt'], 'F-11b ★收摊：两路俱停');
    }

    // ── F-12 ★反证（静态）：旧桩话术零命中 ∧ 选路恰一处 ∧ IPC 用派发（不是各取各的）────────────
    {
      const tools = CODE(DEV_TOOLS_SRC);
      eq(countOcc(tools, 'MQTT 控制面本轮未启用'), 0,
        'F-12a ★★反证：旧桩那句「MQTT 控制面本轮未启用」**零命中**（桩已被真适配层替掉）');
      eq(countOcc(tools, "dev.protocol === 'mqtt'"), 1,
        'F-12b ★选路**恰一处**（`defaultDeviceControl` 内）——多了即两处分家');
      eq(countOcc(tools, 'mqttDeviceControl('), 1,
        'F-12c ★`mqttDeviceControl` 在派发处**恰调用一次**（只定义不调＝"做了没用上"）');
      const ipc = CODE(DEV_IPC_SRC);
      //   ⚠ zx_20261016_2 批二**重定向**（承 feedback_retarget_assertions_to_stronger_source）：
      //     面板路新带 `actor: { kind: 'panel' }`（留痕据此认得出"面板手动按的"）⇒ 旧逐字形状作废。
      //     **不删不放宽**：改为同时钉 ① 仍走**同一派发** `defaultDeviceControl` ② 新带 `actor` 且 `kind` 逐字 `panel`。
      ok(/runDeviceControl\(ddb, \{ deviceId, action, args,[\s\S]*?\}, defaultDeviceControl\)/.test(ipc)
        && /actor: \{ kind: 'panel' \}/.test(ipc),
        'F-12d ★★面板控制走**同一派发** `defaultDeviceControl`（与工具体同源）**且**如实标 `actor.kind=\'panel\'`（zx_20261016_2 发起者）');
      eq(countOcc(ipc, 'httpDeviceControl'), 0, 'F-12e ★反证：IPC 层**零** `httpDeviceControl`——选路只在适配层一处');
      eq([countOcc(ipc, 'mqttDiscoveryIo('), countOcc(ipc, 'composeDiscoveryIo(')], [1, 1],
        'F-12f ★发现：MQTT 一路并入并联（`mqttDiscoveryIo` 与 `composeDiscoveryIo` 各恰一处）');
      eq(countOcc(CODE(MQTT_SRC), 'boolSetting'), 0,
        'F-12g ★反证：MQTT 适配层**不用** `boolSetting`（那族"缺省即开"；本键缺省关，两族不并）');
    }

    // ── F-13 ★跨层接线（renderer 是词表第二落点）：面板配置块 + IPC 通道 + 构建 external ────────
    {
      const ipcLib = CODE(`${A}/renderer/src/lib/ipc.ts`);
      ok(ipcLib.includes("'devices:mqtt_status'") && /mqttStatus:/.test(ipcLib),
        'F-13a renderer `devices.mqttStatus` 通道在册（面板据此读真源态）');
      const page = CODE(`${A}/renderer/src/pages/DevicesPage.tsx`);
      ok(/function MqttConfigBlock\(/.test(page) && page.includes('devicesApi.mqttStatus()'),
        'F-13b ★面板挂件**读 main 侧真源**（不自己判"能不能连"）');
      ok(page.includes("'settings:set', 'device.mqtt.enabled'"),
        'F-13c ★写口：面板把 `device.mqtt.enabled` 落库（与 F-5 读口同一键名）');
      ok(/<MqttConfigBlock \/>/.test(page), 'F-13d ★挂件**真挂上**（只定义不挂＝"做了没用上"）');
      ok(page.includes('默认关闭'), 'F-13e ★用户可见文案声明**默认关闭**（连 broker 是可被察觉的网络行为）');
      ok(/external:\s*\[[^\]]*'mqtt'/.test(CODE(`${A}/tsup.config.ts`)),
        'F-13f ★构建接线：`mqtt` 在 tsup `external` 内（否则被 eager 打进静态 chunk ⇒ 惰性即失效）');
    }

    // ── F-14 ★产物核实（dist）：惰性 `import("mqtt")` 存活 ∧ 零 mqtt 库代码被打进 ─────────────
    {
      const distDir = path.join(root, A, 'dist');
      const jsFiles = (fs.readdirSync(distDir, { recursive: true }) as string[]).filter((f) => f.endsWith('.js'));
      const bodies = jsFiles.map((f) => fs.readFileSync(path.join(distDir, f), 'utf-8'));
      const bundled = jsFiles.filter((_f, i) => bodies[i].includes('mqtt-packet'));
      eq(bundled, [], 'F-14a ★★反证：dist **零** mqtt 库代码（`mqtt-packet` 零命中——惰性未被 eager 内联）');
      ok(bodies.some((b) => b.includes('import("mqtt")')),
        'F-14b ★`import("mqtt")` 在产物中存活（运行时动态 import 未被静态化）');
    }
  }

  // ═══ G｜收口缺陷：retry 只清机器跑的、不清人写的（真函数直跑 + 接线 + 反证）══════════════
  console.log('\n【G】retry 携带用户自述输入（真跑 `carryRetryContext` + 接线 + 反证）');
  {
    // ── G-1 ★真函数直跑：只挑用户自述输入；运行指标一概不带（"从零重跑"仍成立）─────────────
    const prev = {
      attachments: [{ fileName: 'photo.png', kind: 'image' }],
      task_goal: { goal: '把灯调成暖光' },
      scheme_ref: { plan_task_id: 'plan-1' },
      // 机器跑的运行指标——**不得**跨重跑带上：
      budget_usage_ratio: 0.93, tokens_used: 12345, completion_quality: 88,
      attachments_outcomes: [{ fileName: 'photo.png', status: 'inlined' }],
    };
    eq(Object.keys(carryRetryContext(prev)).sort(), ['attachments', 'scheme_ref', 'task_goal'],
      'G-1a ★恰带三件用户自述输入（挂的件 / 纠的目标 / 关联的方案）');
    ok(!('budget_usage_ratio' in carryRetryContext(prev)) && !('tokens_used' in carryRetryContext(prev)),
      'G-1b ★反证：运行指标（budget/tokens）**不**随行 ⇒ "从零重跑"仍成立');
    ok(!('attachments_outcomes' in carryRetryContext(prev)),
      'G-1c ★反证：上轮附件去向（每轮重算）不随行——带上它会拿旧去向冒充新装配');
    eq(carryRetryContext({}), {}, 'G-1d 无这些键 ⇒ 不多添键（不凭空造一个空 attachments）');
    eq(carryRetryContext(null), {}, 'G-1e 坏/空 ctx ⇒ 空对象（不抛，重试照走）');
    const acct = CODE(`${A}/src/main/core/task-accounting.ts`);
    ok(/RETRY_CARRIED_CTX_KEYS\s*=\s*\[[^\]]*'attachments'/.test(acct) && /carryRetryContext[\s\S]{0,400}RETRY_CARRIED_CTX_KEYS/.test(acct),
      'G-1f ★白名单真源 `RETRY_CARRIED_CTX_KEYS` 在册且被函数消费（键名只此一处，IPC 层不另抄）');

    // ── G-2 ★接线：retry 段**读旧 ctx → carry → 合并**，不得退回"裸对象整体覆写"──────────────
    const pjIpc = CODE(`${A}/src/main/ipc/project.ipc.ts`);
    const retrySeg = pjIpc.slice(pjIpc.indexOf("ipcMain.handle('task:retry'"), pjIpc.indexOf("ipcMain.handle('task:resume'"));
    ok(/\.\.\.carryRetryContext\(prevCtx\)/.test(retrySeg),
      'G-2a ★retry 的 `ctxMeta` 由 `carryRetryContext(prevCtx)` 展开（用户输入跨重跑带上）');
    ok(/SELECT\b[^;]*\bcontext_json\b[^;]*FROM wa_tasks/.test(retrySeg) && /prevCtx\s*=\s*JSON\.parse\(task\.context_json/.test(retrySeg),
      'G-2b ★`prevCtx` 取自**旧 `context_json`**（不是自造空对象——否则"携带"是假的）');
    ok(/context_json = \?,/.test(retrySeg) && /retried_at:/.test(retrySeg),
      'G-2c retry 仍整体重建 ctx（运行指标清空语义不变，`retried_*` 标记照旧）');
    // 反证：抠掉 carry 展开口后，retry 段**不再**提及任何用户输入键 ⇒ 断言确系钉住那一处，
    //   谁把它退回"裸对象覆写"（老病复发）即红。注释已被 `CODE()` 剥除，故中文说明不干扰。
    const withoutCarry = retrySeg.replace(/\.\.\.carryRetryContext\(prevCtx\),/, '');
    ok(!/attachments|task_goal|scheme_ref/.test(withoutCarry),
      'G-2d ★反证：抠掉 carry 展开口 ⇒ retry 段零用户输入键残留（退化回"裸覆写"必红）');
  }

  // ═══ S｜哑雷自检 + build 钉（派生核对，不写轮次字面量）════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 ★方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261013_1: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261013_1 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ rr_zx_20261013_1: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
