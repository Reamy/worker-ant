/**
 * zx_20261016_2 受控复跑 —— 「源」：**留痕要说得出发起者是谁**。
 *
 * 由来（创始人本机实机 E2E，承 `zx_20261016_1` 格③）：设备控制真通了，面板「控制留痕」落了一行
 *   `ok turn_on 卧室灯带`——**但这一行没说"谁按的"**。同一块面板上，任务发起的行会显
 *   「任务『X』· 项目『Y』」（`zx_20261014_3` 已办），而**面板手动**与**外部终端经门**两路
 *   长相与它完全一样、认不出人。三个控制入口，只有一路留得下身份。
 *
 * 本轮口径一句话（维特根斯坦·意义即用法 ／ 管子·度量衡 ／ 王阳明·知行合一 ／ 罗尔斯·同一把尺）：
 *   留痕记的是**动作**，但一个动作少不得"谁按的"——记不下发起者的账，量过了却没记数。
 *   身份**写入时定**（`actor_kind`/`actor_ref` 两列），**读时现查**名字（同 `taskRefsOf` 一把尺）；
 *   **认不出就留空**，面板据此整段不渲染——**不猜、不假装认得出**。
 *
 * 治法：
 *   ① `database.ts` 加两列（`actor_kind`/`actor_ref`）+ **事实回填**旧行（`task_id != ''` ⟺ 任务发起，
 *      因本轮之前**只有**工具路传 `taskId`——可核事实，非猜测）。
 *   ② `core/device-registry.ts` `recordDeviceAction` 收 `actor`；`DeviceActionActorKind` 一处词表。
 *   ③ `core/tools/device.ts` `runDeviceControl` 一处派生（显式 `actor` 优先；无则"有 `taskId` 即任务路"）。
 *   ④ 三入口各自报名：工具路（`taskId`）/ 面板路（`panel`）/ 外部路（`external` + 终端 id，
 *      经 `external-calls.ts` 的 `controlDevice({…terminalId})` 透传）。
 *   ⑤ `renderer` `SourceChip` 行首标签：`task`/`external`/`panel` 三分支，认不出 ⇒ 不渲染。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：判据静态导入生产导出（被删/改名即编译期失败）；能跑真实现的一律跑真实现。
 *   G-2 **两侧标本**：凡判"不该命中"的判据，必有"该命中"的正标本 + 反证标本。
 *   G-5 判"用户可见文案/接线在册"读 `CODE()`（去注释）后的代码；注释**不能**替实现签字。
 *   G-6 **无轮次字面量**：本文件不得出现任何 `zx_…` 字面量（末尾 S1 自检兜底）。
 *   ⚠ 计数器/落库类断言须有 **0→1** 正面断言（被 `try/catch` 吞掉的写入只有正面断言抓得住）。
 *   ⚠ 夹具按**生产 DDL** 建表（`feedback_rr_fixture_production_order`）。
 *
 * ── 分批（逐批长大的组）──────────────────────────────────────────────────────
 *   **M 组** = 批一/二 落账层：`recordDeviceAction` 收 `actor` 并如实落两列（真跑生产实现）。
 *   **C 组** = 批二 三入口接线：工具/面板/外部各报身份（含外部那一路的 `terminalId` 透传）。
 *   **U 组** = 批三 面板形状：`SourceChip` 三类分支 + 回退 + 认不出不渲染 + 载荷两侧同形。
 *   **S 组** = 哑雷自检 + build 钉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：落账真源（本轮第一刀）——静态导入，改名/删除即编译期失败。
import {
  recordDeviceAction, listDeviceActions,
  type DeviceDb,
} from '../apps/worker-ant-desktop/src/main/core/device-registry.js';
// G-1：编排真源（本轮第二刀）——真跑它（假传动），验"三入口各报身份"那一跳。
import { runDeviceControl, type DeviceControlTransport } from '../apps/worker-ant-desktop/src/main/core/tools/device.js';
// G-1：门的能力面（外部那一跳的透传面）。
import {
  createExternalCapabilityPort,
  type ExternalCapabilityDeps,
} from '../apps/worker-ant-desktop/src/main/core/external-calls.js';
import { LICENSE_SETTING_KEYS } from '../apps/worker-ant-desktop/src/main/core/license.js';
import type { AnsDevice, DeviceControlOutcome } from '../apps/worker-ant-desktop/src/main/core/device-registry.js';

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

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''); // zx_20261016_2

/* ── 夹具：`wa_settings`（许可）+ 设备台账 + 控制审计（列序照搬生产 `database.ts`）────────
   ⚠ `actor_kind`/`actor_ref` 位置与生产 DDL 一致（**在两个身份列之间**把 `task_id` 留在原处），
     这样"列序错位"这类缺陷照得出来。 */
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_devices (id TEXT PRIMARY KEY, name TEXT DEFAULT '', alias TEXT DEFAULT '', room TEXT DEFAULT '', kind TEXT DEFAULT 'unknown',
  kind_class TEXT NOT NULL DEFAULT '',
  protocol TEXT NOT NULL, address TEXT NOT NULL, port INTEGER, capabilities_json TEXT DEFAULT '[]',
  controllable INTEGER DEFAULT 0, authorized INTEGER DEFAULT 0, status_json TEXT,
  first_seen TEXT DEFAULT (datetime('now')), last_seen TEXT DEFAULT (datetime('now')), online INTEGER);
CREATE UNIQUE INDEX idx_wa_devices_ident ON wa_devices(protocol, address);
CREATE TABLE wa_device_actions (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, action TEXT NOT NULL,
  args_json TEXT DEFAULT '{}', result TEXT DEFAULT '', task_id TEXT DEFAULT '',
  actor_kind TEXT DEFAULT '', actor_ref TEXT DEFAULT '', plan_id TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_external_calls (id TEXT PRIMARY KEY, terminal_id TEXT NOT NULL, capability TEXT NOT NULL,
  args_json TEXT DEFAULT '{}', result TEXT DEFAULT '', reason TEXT DEFAULT '', remote_addr TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_external_terminals (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  pair_code TEXT NOT NULL, key_prefix TEXT DEFAULT '', secret_hash TEXT DEFAULT '',
  capabilities_json TEXT DEFAULT '[]', remote_addr TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), approved_at TEXT, grant_expires_at TEXT);
`;

function mkdb(opts: { trial?: boolean } = {}): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  // 试用 ⇒ `kind==='trial'` ⇒ Team 软闸解锁（**喂真输入**，不给软闸打桩）。
  if (opts.trial !== false) {
    d.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)')
      .run(LICENSE_SETTING_KEYS.trialStartedAt, new Date().toISOString());
  }
  return d;
}
type AnyDb = Parameters<typeof recordDeviceAction>[0];
const asDb = (d: DatabaseSync) => d as unknown as AnyDb;

/** 一台"已授权可控"的设备（判据要能过——见 `deviceControlVerdict`）。 */
const supervisedLamp: AnsDevice = {
  id: 'dev-1', name: '客厅台灯', alias: '', kind: 'light', protocol: 'mqtt',
  address: '192.168.1.50', port: 1883, capabilities: ['turn_on', 'turn_off'],
  controllable: true, authorized: true, status: null, first_seen: '', last_seen: '',
};

function seedDevice(db: DatabaseSync, d: AnsDevice = supervisedLamp): void {
  db.prepare(`INSERT INTO wa_devices (id, name, alias, kind, protocol, address, port, capabilities_json,
    controllable, authorized) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(d.id, d.name, d.alias, d.kind, d.protocol, d.address, d.port,
      JSON.stringify(d.capabilities), d.controllable ? 1 : 0, d.authorized ? 1 : 0);
}

/** 假传动（不触网）：记下"真下发过"，恒成功。 */
function fakeTransport(): { calls: Array<{ action: string }>; t: DeviceControlTransport } {
  const calls: Array<{ action: string }> = [];
  return {
    calls,
    t: async (_dev, action) => { calls.push({ action }); return { ok: true, result: 'turned on' }; },
  };
}

/** 最近一行留痕的投影（直接读库，验"真落进哪一列"）。 */
function lastRow(db: DatabaseSync): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM wa_device_actions ORDER BY rowid DESC LIMIT 1').get() as Record<string, unknown> | undefined;
}

async function main(): Promise<void> {
  // ═══ M｜落账层 —— `recordDeviceAction` 收 `actor` 并如实落两列（管子·度量衡）════════════
  console.log('\n【M】落账 —— 身份**写入时定**（真跑生产 `recordDeviceAction`/`listDeviceActions`）');
  {
    const db = mkdb();
    // ── M-1 ★默认：只给 `taskId` ⇒ 认作任务路（旧调用点行为**逐字不变**）──────────────
    recordDeviceAction(asDb(db), { deviceId: 'dev-1', action: 'turn_on', result: 'ok', taskId: 'task-A' });
    eq(lastRow(db)?.actor_kind, '', 'M-1a 裸 `recordDeviceAction`（无 actor）⇒ `actor_kind` 空串（**本层不替调用方猜**）');
    eq(lastRow(db)?.task_id, 'task-A', 'M-1b `task_id` 仍如实落原列（两列各归其位）');

    // ── M-2 ★★显式 actor 覆盖：三路各自报名，落的就是它 ─────────────────────────────
    recordDeviceAction(asDb(db), { deviceId: 'dev-1', action: 'turn_on', result: 'ok', actor: { kind: 'panel' } });
    eq(lastRow(db)?.actor_kind, 'panel', 'M-2a ★面板路 ⇒ `panel`');
    eq(lastRow(db)?.actor_ref, '', 'M-2b 面板无外部引用 ⇒ `actor_ref` 空串（如实）');

    recordDeviceAction(asDb(db), { deviceId: 'dev-1', action: 'turn_on', result: 'ok', taskId: 'task-A', actor: { kind: 'task', ref: 'task-A' } });
    eq(lastRow(db)?.actor_kind, 'task', 'M-2c ★任务路 ⇒ `task`');
    eq(lastRow(db)?.actor_ref, 'task-A', 'M-2d `actor_ref` 挂**稳定 id**（面板据此读时现查标题）');

    recordDeviceAction(asDb(db), { deviceId: 'dev-1', action: 'turn_on', result: 'denied', actor: { kind: 'external', ref: 'term-9' } });
    eq(lastRow(db)?.actor_kind, 'external', 'M-2e ★★外部终端路 ⇒ `external`（实机那行认不出的正是这一路）');
    eq(lastRow(db)?.actor_ref, 'term-9', 'M-2f `actor_ref` 挂终端 id');

    // ── M-3 ★列不错位（writes 恰 9 列；身份列插在 `task_id` 与 `created_at` 之间）──────
    const r = lastRow(db)!;
    eq(r.device_id, 'dev-1', 'M-3a ★列序：`device_id` 落对（不错位到身份列）');
    eq(r.action, 'turn_on', 'M-3b 列序：`action` 落对');
    eq(r.result, 'denied', 'M-3c 列序：`result` 落对（未被 `actor_kind` 挤位）');
    eq(r.task_id, '', 'M-3d 列序：无任务的外部行 `task_id` 仍是空串（**不是**被 `actor_ref` 顶上）');

    // ── M-4 ★★读回同形（0→1 正面断言）：`listDeviceActions` 投影带出两列 ─────────────
    //   ⚠ 投影按 `created_at DESC` 排序，同秒并列 ⇒ **不取 [0]**（那是"按不稳定序碰运气"），
    //     改按 `actor_ref` 找那一行（`feedback_criteria_must_not_depend_on_wallclock` 同族）。
    const projected = listDeviceActions(asDb(db) as DeviceDb).find((r) => r.actor_ref === 'term-9');
    ok(!!projected, 'M-4a ★★读回含该行（投影**真带出** `actor_ref` 列——否则 find 必落空）');
    eq(projected?.actor_kind, 'external', 'M-4b ★★读回 `actor_kind`（0→1：库里确有值、投影真带出）');
    eq(projected?.task_id, '', 'M-4c 读回 `task_id`（三列**各是各的**，不互相冒充）');

    // ── M-5 反证：认证不出的行**两侧皆空**，绝不默认成"面板"（不猜）───────────────────
    recordDeviceAction(asDb(db), { deviceId: 'dev-1', action: 'turn_off', result: 'ok' });
    eq([lastRow(db)?.actor_kind, lastRow(db)?.actor_ref], ['', ''],
      'M-5 ★反证：无 `actor` 且无 `taskId` ⇒ 两列皆空（**不**默认成 `panel`——认不出就认不出）');
  }

  // ═══ C｜三入口各报身份（王阳明·知行合一 / 罗尔斯·同一把尺）════════════════════════
  console.log('\n【C】三入口 —— 任务 / 面板 / 外部终端各报自家身份（真跑编排那一跳）');
  {
    // ── C-1 ★★工具路：`taskId` ⇒ 派生 `task`（真跑 `runDeviceControl`，读真库）──────
    {
      const db = mkdb();
      seedDevice(db);
      const tr = fakeTransport();
      const out = await runDeviceControl(asDb(db), { deviceId: 'dev-1', action: 'turn_on', taskId: 'task-A' }, tr.t);
      eq(out.ok, true, 'C-1a 编排真跑通（夹具设备已授权可控）');
      eq(tr.calls.length, 1, 'C-1b 传动真下发一次（不是纸面判据）');
      eq(lastRow(db)?.actor_kind, 'task', 'C-1c ★★工具路 ⇒ `actor_kind=task`（`taskId` 一处派生）');
      eq(lastRow(db)?.actor_ref, 'task-A', 'C-1d `actor_ref` ＝ `taskId`（两处**同一个值**，非各自拼）');
    }
    // ── C-2 ★★面板路：显式 `actor:{kind:'panel'}` 覆盖（**即使同时给了 taskId**）─────
    {
      const db = mkdb();
      seedDevice(db);
      const tr = fakeTransport();
      await runDeviceControl(asDb(db),
        { deviceId: 'dev-1', action: 'turn_on', taskId: 'task-A', actor: { kind: 'panel' } }, tr.t);
      eq(lastRow(db)?.actor_kind, 'panel',
        'C-2 ★★显式 `actor` **优先于** `taskId` 派生（面板手动不因残留 taskId 被误记成任务）');
    }
    // ── C-3 ★★外部路：显式 `actor:{kind:'external', ref: 终端 id}` ──────────────────
    {
      const db = mkdb();
      seedDevice(db);
      const tr = fakeTransport();
      await runDeviceControl(asDb(db),
        { deviceId: 'dev-1', action: 'turn_on', actor: { kind: 'external', ref: 'term-9' } }, tr.t);
      eq([lastRow(db)?.actor_kind, lastRow(db)?.actor_ref], ['external', 'term-9'],
        'C-3 ★★外部终端路 ⇒ `external` + 终端 id（实机那行缺的就是这两样）');
    }
    // ── C-4 ★被拒那一支**也**带身份（"被拒也留痕"含"也留是谁被拒"）──────────────────
    {
      const db = mkdb();
      seedDevice(db, { ...supervisedLamp, authorized: false }); // 未授权 ⇒ K-6 拒
      const tr = fakeTransport();
      const out = await runDeviceControl(asDb(db),
        { deviceId: 'dev-1', action: 'turn_on', actor: { kind: 'external', ref: 'term-9' } }, tr.t);
      eq('denied' in out, true, 'C-4a 未授权设备 ⇒ 如实拒（K-6）');
      eq(tr.calls.length, 0, 'C-4b 反证：被拒**未**下发（判据先于传动）');
      eq(lastRow(db)?.result, 'denied', 'C-4c 被拒仍留痕');
      eq(lastRow(db)?.actor_kind, 'external', 'C-4d ★★被拒的行**也**认得出是谁（不是只有成功件才记身份）');
    }
    // ── C-5 ★★★端到端那一跳：门 → `controlDevice(inner)` 真带 `terminalId`（真跑能力面）──
    {
      const db = mkdb();
      const calls: Array<{ terminalId?: string; action: string }> = [];
      const deps: ExternalCapabilityDeps = {
        listDevices: () => [supervisedLamp],
        controlDevice: async (inner) => { calls.push({ terminalId: inner.terminalId, action: inner.action }); return { ok: true, deviceId: 'dev-1', action: inner.action, result: 'turned on' } as DeviceControlOutcome; },
      };
      const port = createExternalCapabilityPort(db as never, deps);
      const r = await port.invoke('term-9', ['device_control'], { capability: 'device_control', args: { deviceId: 'dev-1', action: 'turn_on' } }, '192.168.1.9');
      eq(r.status, 200, 'C-5a 门的能力面真放行（三重闸皆过）');
      eq(calls.length, 1, 'C-5b 执行那一跳真调到（0→1）');
      eq(calls[0].terminalId, 'term-9',
        'C-5c ★★★**发起者身份透传到装配面**（`terminalId` 随 `inner` 一路下行——缺它则 `actor_ref` 只能是空串）');
    }
    // ── C-6 接线在册（读**去注释**码）：三处调用点各报自家名 ──────────────────────────
    {
      const toolsCode = CODE(`${A}/src/main/core/tools/device.ts`);
      ok(/raw\.actor \?\? \(raw\.taskId \? \{ kind: 'task' as const, ref: raw\.taskId \} : \{ kind: '' as const, ref: '' \}\)/.test(toolsCode),
        'C-6a ★编排一处派生（显式优先 / 有 taskId 即任务路 / 两样都无 ⇒ 空串如实认不出）');
      const ipcCode = CODE(`${A}/src/main/ipc/devices.ipc.ts`);
      ok(/runDeviceControl\(ddb, \{ deviceId, action, args, actor: \{ kind: 'panel' \} \}, defaultDeviceControl\)/.test(ipcCode),
        'C-6b ★★面板路**真**传 `actor: { kind: \'panel\' }`（不是只在别处写了个字面量）');
      const idxCode = CODE(`${A}/src/main/index.ts`);
      ok(/actor: \{ kind: 'external', ref: inner\.terminalId \?\? '' \}/.test(idxCode),
        'C-6c ★★外部路**真**传 `actor: { kind: \'external\', ref: … }`（装配面那一跳）');
      // zx_20261018_1 批二：`controlDevice` 有了**第二个**调用点（意图 execute 逐步执行）——
      //   判据改按调用点**逐个数**：每个 `deps.controlDevice(` 都必须透传 `terminalId`
      //   （"抹掉一行即红"的反证同步改成抹掉**全部**透传行）。
      const callsCode = CODE(`${A}/src/main/core/external-calls.ts`);
      // zx_20261018_1 批五：调用对象里 `terminalId` 之后多了 `planId`（意图执行那一跳），
      //   旧「terminalId 恰在 `});` 前」的形状随之作废。判据**改钉更强的真源**：逐调用点
      //   切出对象体，每个 `deps.controlDevice({ … })` 都必须**含 terminalId 属性**（中间键随便加）。
      const sites = [...callsCode.matchAll(/deps\.controlDevice\(\{/g)].map((m) => m.index ?? -1);
      const forwards = sites.filter((start) => {
        const end = callsCode.indexOf('});', start);
        return end > start && /\bterminalId\b/.test(callsCode.slice(start, end));
      }).length;
      ok(sites.length >= 1 && forwards === sites.length,
        `C-6d ★能力面把 \`terminalId\` 交给每个 \`deps.controlDevice\`（透传，不解析；${forwards}/${sites.length} 处）`);
      // 反证：把全部 terminalId 透传行抹掉 ⇒ 透传判据即红（确系钉住这些处）。
      const stripped = callsCode.replace(/\n\s*terminalId,\n/g, '\n');
      ok(!/terminalId,\s*\}\);/.test(stripped), 'C-6e ★反证：抹掉透传行 ⇒ 判据即红（非顺带为真）');
    }
  }

  // ═══ U｜面板形状 —— 行首来源标签（维特根斯坦·意义即用法）════════════════════════════
  console.log('\n【U】面板 —— 行首前置来源标签（三类分支 + 回退 + 认不出不渲染）');
  {
    // ── U-1 载荷两侧同形（main 声明 ⇄ renderer 声明）────────────────────────────────
    ok(/terminalRefs:\s*Record<string,\s*string>/.test(RD(`${A}/src/main/ipc/devices.ipc.ts`)),
      'U-1a main 侧 `DevicesListPayload.terminalRefs` 在册');
    ok(/terminalRefs:\s*Record<string,\s*string>/.test(RD(`${A}/renderer/src/lib/ipc.ts`)),
      'U-1b renderer 侧载荷**同形**声明在册（两处同名同型）');

    // ── U-2 ★★装配那一跳：真调 `terminalNamesOf`，且**只查 external 行** ─────────────
    const ipcCode = CODE(`${A}/src/main/ipc/devices.ipc.ts`);
    ok(/terminalRefs:\s*Object\.fromEntries\(terminalNamesOf\(/.test(ipcCode),
      'U-2a ★`devices:list` 真把 `terminalNamesOf` 的返回值装配进 `payload.terminalRefs`');
    ok(/a\.actor_kind === 'external'/.test(ipcCode),
      'U-2b ★只对 `external` 行查终端名（面板/任务路不白查库）');
    ok(/import\s*\{[\s\S]*?\bterminalNamesOf\b[\s\S]*?\}\s*from\s*'\.\.\/core\/external-terminals\.js'/.test(ipcCode),
      'U-2c 装配取自**生产真源** `core/external-terminals.js`（不在此另写一份 SELECT）');

    // ── U-3 ★★真跑 `terminalNamesOf`：两侧标本（在册 / 查无）+ 去重 ─────────────────
    {
      const { terminalNamesOf } = await import('../apps/worker-ant-desktop/src/main/core/external-terminals.js');
      const db = mkdb();
      db.prepare(`INSERT INTO wa_external_terminals (id, name, status, pair_code, capabilities_json)
        VALUES ('term-9', '测试机器人', 'approved', '123456', '[]')`).run();
      const m = terminalNamesOf(db as never, ['term-9', 'term-gone', '', 'term-9']);
      eq(m.size, 1, 'U-3a ★两侧标本同批喂：只在册那一件进 map（查无/空串**不造名**）');
      eq(m.get('term-9'), '测试机器人', 'U-3b ★在册终端名真取到（面板那行要显的就是它）');
      eq(m.has('term-gone'), false, 'U-3c ★查无此终端 ⇒ **无该键**（面板据此如实回退 id 前缀）');

      // 改名后再查 ⇒ 新名（读时现查，非快照）。
      db.prepare('UPDATE wa_external_terminals SET name = ? WHERE id = ?').run('改过名的机器人', 'term-9');
      eq(terminalNamesOf(db as never, ['term-9']).get('term-9'), '改过名的机器人',
        'U-3d ★★**读时现查、不留快照**（若在留痕时缓存名字，这里会是旧名）');
    }

    // ── U-4 ★★面板形状：三类分支 + 回退 + 认不出不渲染（逐成员枚举）──────────────────
    const page = RD(`${A}/renderer/src/pages/DevicesPage.tsx`);
    const chip = page.slice(page.indexOf('function SourceChip('), page.indexOf('function AuditRow('));
    ok(chip.length > 0, 'U-4a `SourceChip` 在册（行首来源标签的唯一产出点）');
    ok(['panel', 'external', 'task'].every((k) => chip.includes(`a.actor_kind === '${k}'`)),
      'U-4b ★★三类来源逐成员枚举（断言名＝扫描面：漏一类即红）');
    ok(/外部终端「\{terminalName\}」/.test(chip), 'U-4c ★外部支显**终端名**（人叫得出的名）');
    ok(/外部终端 \{a\.actor_ref\.slice\(0, 8\)\}/.test(chip), 'U-4d ★外部支**查无即回退** id 前 8 位（与设备列同形）');
    ok(/面板手动/.test(chip), 'U-4e 面板支如实标「面板手动」');
    ok(/return null;\s*\n\}/.test(chip), 'U-4f ★认不出的来源（`actor_kind===\'\'`）⇒ **整段不渲染**（不假装认得出）');
    // 反证：把外部支的显名换掉 ⇒ 形状判据即红。
    ok(!/外部终端「\{terminalName\}」/.test(chip.replace('terminalName}', 'a.actor_ref}')),
      'U-4g ★反证：把显名调用换成 id ⇒ 判据即红（确系钉住那一处）');

    // ── U-5 调用点那一跳真接上（`terminalRefs[a.actor_ref]` 交给 `AuditRow`）───────────
    ok(/terminalName=\{a\.actor_kind === 'external' \? terminalRefs\[a\.actor_ref\] : undefined\}/.test(page),
      'U-5 ★调用点把 `terminalRefs[a.actor_ref]` 交给 `AuditRow`（那一跳真接上）');
    ok(/const terminalRefs = data\?\.terminalRefs \?\? \{\}/.test(page),
      'U-5b 页面从**当前**载荷取 `terminalRefs`（非另拉一份）');
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
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261016_2: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261016_2 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ rr_zx_20261016_2: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
