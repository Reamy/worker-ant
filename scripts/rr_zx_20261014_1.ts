/**
 * zx_20261014_1 受控复跑 —— 「名」：设备，要叫得出名字、按名字使唤。
 *
 * 本轮口径一句话（道德经·名可名非常名 ／ 维特根斯坦·意义即用法·私人语言不成立 ／
 *   罗尔斯·同一把尺 ／ 毛选·反对本本主义）：
 *   设备有两个名——**它自述的名**（每次发现被覆写）与**我们叫它的名**（发现永不写）；
 *   面板与留痕要显的是"我们叫它什么"，而这个名字必须**真能用来控制**（意义即用法）。
 *
 * 三处病根（实测，方案 §0.2）：
 *   ① `DevicesPage` 留痕行只印 `device_id.slice(0,8)`——一串 uuid 前缀，人认不出是哪台；
 *   ② 台账无"别名"列（`name` 是设备自述、每次发现被覆写）⇒ 用户无处安放"我叫它什么"；
 *   ③ `device_control`/`device_status` 只收 `deviceId` ⇒ 按名使唤落不了地（名字只是装饰）。
 *
 * 治法：① 留痕由 `deviceCallName`（`alias || name`）现查取名、设备不在台账才回退 id 前缀；
 *   ② 新列 `alias`（`setDeviceAlias` 唯一写点，`upsertDiscovered` 绝不写它）；
 *   ③ `resolveDeviceByName`（id → 别名 → 自述名，同名多台如实列候选不猜）+ 工具收 `name`。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：判据一律静态导入生产导出（被删/改名即编译期失败）。
 *   G-2 **两侧标本**：凡判"发现不覆写别名"，反面标本（同一次发现**确**覆写了自述名）一并喂。
 *   G-4 **不依赖真实墙钟**：许可试用起点按"现在 − 1 天"注入，不钉绝对时刻。
 *   G-6 **无轮次字面量**：本轮方案路径/脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 *   ⚠ 夹具 DDL 照搬生产 `database.ts` 的 `wa_devices`（含迁移后的 `alias` 列）——夹具比生产宽松则自证。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：三处真源**静态导入**（被删/改名即编译期失败，而非"扫个空、静默假绿"）。
import { deviceCallName } from '../apps/worker-ant-desktop/src/main/core/device-name.js';
import {
  upsertDiscovered, listDevices, getDevice, setDeviceAlias, setDeviceAuthorized,
  resolveDeviceByName, listDeviceActions,
  type AnsDevice,
} from '../apps/worker-ant-desktop/src/main/core/device-registry.js';
import { deviceTools } from '../apps/worker-ant-desktop/src/main/core/tools/device.js';

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** 等值断言（把实际值一并打出——红时立刻看得出差在哪）。 */
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
/** 判"用户可见文案/调用形状"读去注释后的代码；判"接线在册"读原文。 */
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');
const countOcc = (hay: string, needle: string): number => hay.split(needle).length - 1;

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''); // zx_20261014_1

/* ── 夹具：`wa_settings`（许可）+ 设备台账 + 控制审计（列序照搬生产 `database.ts`）──────── */
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_devices (id TEXT PRIMARY KEY, name TEXT DEFAULT '', alias TEXT DEFAULT '', room TEXT DEFAULT '', kind TEXT DEFAULT 'unknown',
  protocol TEXT NOT NULL, address TEXT NOT NULL, port INTEGER, capabilities_json TEXT DEFAULT '[]',
  controllable INTEGER DEFAULT 0, authorized INTEGER DEFAULT 0, status_json TEXT,
  first_seen TEXT DEFAULT (datetime('now')), last_seen TEXT DEFAULT (datetime('now')), online INTEGER);
CREATE UNIQUE INDEX idx_wa_devices_ident ON wa_devices(protocol, address);
CREATE TABLE wa_device_actions (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, action TEXT NOT NULL,
  args_json TEXT DEFAULT '{}', result TEXT DEFAULT '', task_id TEXT DEFAULT '',
  actor_kind TEXT DEFAULT '', actor_ref TEXT DEFAULT '', plan_id TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')));
`;
/** 建库：可带一条试用许可（试用⇒Team 档能力放行，让工具真跑起来）。 */
function mkdb(opts: { trial?: boolean } = {}): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  if (opts.trial) {
    // G-4：试用起点按"现在 − 1 天"注入（不钉绝对时刻）；试用档落 pro ⇒ `kind==='trial'` 放行。
    d.prepare('INSERT INTO wa_settings (key,value) VALUES (?,?)')
      .run('license.trial_started_at', new Date(Date.now() - 86_400_000).toISOString());
  }
  return d;
}
type AnyDb = Parameters<typeof listDevices>[0];
const asDb = (d: DatabaseSync) => d as unknown as AnyDb;

/** 落一台设备（走生产 `upsertDiscovered`，不手写 INSERT——否则夹具与生产语义漂开）。 */
function seed(db: DatabaseSync, o: { name: string; address: string; alias?: string; authorized?: boolean }): AnsDevice {
  const dev = upsertDiscovered(asDb(db), {
    name: o.name, kind: 'light', protocol: 'http', address: o.address, port: 80,
    capabilities: ['switch'], controllable: true,
  });
  if (o.alias) setDeviceAlias(asDb(db), dev.id, o.alias);
  if (o.authorized) setDeviceAuthorized(asDb(db), dev.id, true);
  return getDevice(asDb(db), dev.id)!;
}

async function main(): Promise<void> {
  // ═══ A｜响有名（批一：控制留痕显"我们叫它什么"）══════════════════════════════════
  console.log('\n【A】响有名 —— 留痕显名（道德经·名可名非常名）');
  {
    // ── A1 ★`deviceCallName` 三态（真实现直跑，两侧标本）───────────────────────────
    eq(deviceCallName({ name: '客厅灯', alias: '小灯' }), '小灯', 'A1a ★别名在场 ⇒ 用**我们**叫它的名');
    eq(deviceCallName({ name: '客厅灯', alias: '' }), '客厅灯', 'A1b 无别名 ⇒ 回退设备**自述**名');
    eq(deviceCallName({ name: '客厅灯', alias: '   ' }), '客厅灯', 'A1c 纯空白别名 ⇒ 视同无（trim 后回退）');
    eq(deviceCallName({ name: '客厅灯' }), '客厅灯', 'A1d 老行（无 alias 字段）⇒ 仍回退自述名（缺列不炸）');

    // ── A2 ★面板留痕行：名字优先、id 前 8 位**回退**（不把 uuid 前缀当唯一显示）─────────
    const devpg = RD(`${A}/renderer/src/pages/DevicesPage.tsx`);
    ok(devpg.includes("from '../../../src/main/core/device-name.js'"),
      'A2a 面板**运行期** import main 零依赖真源 `device-name`（非 type-only——漂了会各叫各的名）');
    const auditBody = devpg.slice(devpg.indexOf('function AuditRow('), devpg.indexOf('function MqttConfigBlock('));
    // 形状：`dev ? <span…>{deviceCallName(dev)}</span> : <span…>{a.device_id.slice(0, 8)}</span>`（显名 / 回退）。
    const auditShape = (s: string) =>
      /\{dev\s*\?\s*<span[\s\S]*?>\{deviceCallName\(dev\)\}<\/span>\s*:\s*<span[\s\S]*?>\{a\.device_id\.slice\(0, 8\)\}<\/span>\}/.test(s);
    ok(auditBody.length > 0 && auditShape(auditBody),
      'A2b ★留痕行＝**名字优先**、id 前 8 位**回退**（设备在场显名；不在台账才显 id，不假装它还在）');
    ok(!auditShape(auditBody.replace(/deviceCallName\(dev\)/g, 'dev.address')),
      'A2c ★反证：把显名调用换成别的 ⇒ 形状判据即红（确系钉住那一处，非顺带为真）');
    ok(devpg.includes('deviceById.get(a.device_id)') && /new Map\(devices\.map\(/.test(devpg),
      'A2d 留痕按 `device_id` 从**当前**台账现查（`deviceById` map）——取此刻的值，非落库快照');

    // ── A3 ★留痕**不**冗余存名：名字会变，快照存的是"当时的名字"（与"此刻叫什么"是两件事）───
    const regCode = CODE(`${A}/src/main/core/device-registry.ts`);
    const recFn = regCode.slice(regCode.indexOf('export function recordDeviceAction('), regCode.indexOf('export function listDeviceActions('));
    ok(recFn.length > 0 && !/\bname\b|\balias\b/.test(recFn),
      'A3 ★`recordDeviceAction` 只写 device_id/action/args/result/task_id——**不**冗余存名（名字取自现查台账）', `${recFn.length} 字符`);
  }

  // ═══ B｜名副其实（批二：别名列 + 改名口）════════════════════════════════════════
  console.log('\n【B】名副其实 —— 别名列与改名口（道德经·名可名非常名）');
  {
    // ── B1 生产 DDL + 幂等迁移在册（老库补列）─────────────────────────────────────
    const dbts = RD(`${A}/src/main/database.ts`);
    ok(/CREATE TABLE IF NOT EXISTS wa_devices \([\s\S]{0,400}?alias TEXT DEFAULT ''/.test(dbts),
      'B1a 生产建表含 `alias` 列（新库直接有）');
    ok(/ALTER TABLE wa_devices ADD COLUMN alias TEXT DEFAULT ''/.test(dbts),
      'B1b 幂等迁移在册（老库补列——DDL 须与迁移同形，否则老库读 alias 即炸）');

    // ── B2 台账模块读 alias（一处投影）───────────────────────────────────────────
    const regCode = CODE(`${A}/src/main/core/device-registry.ts`);
    ok(/const DEVICE_COLUMNS = 'id, name, alias,/.test(regCode),
      'B2a `DEVICE_COLUMNS` 含 alias（读写两侧同形，SELECT 不带它则读不出）');
    ok(/alias: String\(row\.alias \?\? ''\)/.test(regCode),
      'B2b `rowToDevice` 读 alias（缺列/空 ⇒ 空串，不抛）');

    // ── B3 ★★两只标本：再发现**不覆写**别名 vs **确**覆写自述名（真实现直跑）───────────
    const db = mkdb();
    const d1 = upsertDiscovered(asDb(db), {
      name: '客厅灯', kind: 'light', protocol: 'http', address: '192.168.1.10', port: 80,
      capabilities: ['switch'], controllable: true,
    });
    eq(d1.alias, '', 'B3a 首见：别名落**空串**（不从自述名顺手抄一个——两件事混作一件）');
    setDeviceAlias(asDb(db), d1.id, '小灯');
    const d2 = upsertDiscovered(asDb(db), {
      name: '客厅灯（新固件）', kind: 'light', protocol: 'http', address: '192.168.1.10', port: 80,
      capabilities: ['switch', 'dim'], controllable: true,
    });
    eq(d2.alias, '小灯', 'B3b ★再发现**不覆写**别名（我们叫它的名，不被设备自述冲掉）');
    eq(d2.name, '客厅灯（新固件）', 'B3c ★同一次再发现**确**覆写了自述名（"设备是什么"照刷——两件事分得清）');
    eq(d2.id, d1.id, 'B3d 幂等：同一 `protocol+address` 不新增行（去重键仍只此一判据）');
    eq(listDevices(asDb(db)).length, 1, 'B3e 台账仍只 1 行（两次发现＝一台设备）');

    // ── B4 ★反证：再发现的 UPDATE 语句**不含** alias（纪律落在语句形状上，不靠自觉）──────
    const updSeg = CODE(`${A}/src/main/core/device-registry.ts`)
      .slice(CODE(`${A}/src/main/core/device-registry.ts`).indexOf("UPDATE wa_devices SET name = ?"),
        CODE(`${A}/src/main/core/device-registry.ts`).indexOf('} else {'));
    ok(updSeg.length > 0 && !/\balias\b/.test(updSeg),
      'B4 ★反证：再发现的 `UPDATE … SET name=?, kind=?, …` **无** alias 赋值（发现只刷自述）');

    // ── B5 ★`setDeviceAlias` 三态 + 边界（真实现直跑）──────────────────────────────
    eq(getDevice(asDb(db), d1.id)?.alias, '小灯', 'B5a 写别名后现查可得');
    setDeviceAlias(asDb(db), d1.id, '   ');
    eq(getDevice(asDb(db), d1.id)?.alias, '', 'B5b 纯空白 ⇒ **清除**别名（回到自述名——合法操作，非错误）');
    setDeviceAlias(asDb(db), d1.id, 'x'.repeat(100));
    eq(getDevice(asDb(db), d1.id)?.alias.length, 64, 'B5c 长度上限 64（要进候选/提示语，不限长会被撑爆）');
    eq(setDeviceAlias(asDb(db), 'no-such-id', 'a'), null, 'B5d 设备不存在 ⇒ `null`（不凭空造行）');
    const before = getDevice(asDb(db), d1.id)!.last_seen;
    setDeviceAlias(asDb(db), d1.id, '再改一次');
    eq(getDevice(asDb(db), d1.id)!.last_seen, before, 'B5e ★改名**不动** last_seen（改名不是"见到它"——写了即伪造在场）');

    // ── B6 改名出口：在册、调唯一写点、**不经** Team 档闸（本地元数据非动作）───────────
    const dipc = RD(`${A}/src/main/ipc/devices.ipc.ts`);
    const renameSeg = CODE(`${A}/src/main/ipc/devices.ipc.ts`)
      .slice(CODE(`${A}/src/main/ipc/devices.ipc.ts`).indexOf("ipcMain.handle('devices:rename'"),
        CODE(`${A}/src/main/ipc/devices.ipc.ts`).indexOf("ipcMain.handle('devices:control'"));
    ok(renameSeg.length > 0, 'B6a `devices:rename` 出口在册');
    ok(/setDeviceAlias\(/.test(renameSeg), 'B6b 改名口调 `setDeviceAlias`（唯一写点，不另写一份 UPDATE）');
    ok(!/teamFeatureRefusal/.test(renameSeg),
      'B6c ★改名**不经** Team 档闸——软闸只管**动作**出口（discover/authorize/control/cloud_sync），改名是本地元数据');
    // zx_20261017_1 批八: 设备动作出口增至四个（新增 `devices:cloud_sync`）——
    //   幻数「恰 3 处」改钉**更强的新真源**：逐 handler 枚举 + 档位映射（名字与档位都钉住，总数派生）。
    // zx_20261018_1 批五: 增至五个（新增 `devices:intent_execute`——执行意图动作；预览 `intent_preview`
    //   **刻意不在其中**：它只"看"，不碰设备，与 `devices:list` 同一先例）。
    // zx_20261023_5 批三: 增至六个（新增 `devices:miio_token`——写设备 token 是**动作**、不是本地元数据；
    //   与 `devices:rename` 的"只改别名"不同：token 一旦写入即可控制设备）。
    const DEVICE_GATED: Array<[string, string]> = [
      ['devices:discover', 'device_discovery'],
      ['devices:authorize', 'device_control'],
      ['devices:control', 'device_control'],
      ['devices:cloud_sync', 'device_discovery'],
      ['devices:intent_execute', 'device_control'],
      ['devices:miio_token', 'device_control'],
    ];
    const deviceBodyOf = (handler: string): string => {
      const code = CODE(`${A}/src/main/ipc/devices.ipc.ts`);
      const start = code.indexOf(`ipcMain.handle('${handler}'`);
      if (start < 0) return '';
      const next = code.indexOf('ipcMain.handle(', start + 1);
      return next < 0 ? code.slice(start) : code.slice(start, next);
    };
    ok(DEVICE_GATED.every(([h, f]) => deviceBodyOf(h).includes(`teamFeatureRefusal(licDb, '${f}')`)),
      'B6d ★反证（回归护栏）：设备动作出口逐 handler 枚举且档位映射正确——改名未偷加也未误删');
    eq(countOcc(dipc, 'teamFeatureRefusal('), DEVICE_GATED.length,
      'B6d-b 档位闸总数＝枚举的动作出口数（由枚举派生，不写幻数）——改名口不在其中');

    // ── B7 渲染层接线：API + 面板入口（接线那一跳）────────────────────────────────
    const ripc = RD(`${A}/renderer/src/lib/ipc.ts`);
    ok(/rename:\s*\(deviceId: string, alias: string\)/.test(ripc) && /'devices:rename'/.test(ripc),
      'B7a 渲染层 `devices.rename` API 在册（走 `devices:rename`）');
    ok(RD(`${A}/renderer/src/pages/DevicesPage.tsx`).includes('devicesApi.rename('),
      'B7b 面板改名入口调 `devicesApi.rename`（那一跳真接上了）');
  }

  // ═══ C｜呼之即应（批三：按名解析 + 工具收名）══════════════════════════════════════
  console.log('\n【C】呼之即应 —— 按名使唤（维特根斯坦·意义即用法 / 罗尔斯·同一把尺）');
  {
    const db = mkdb();
    const lamp = seed(db, { name: '客厅灯', address: '192.168.1.30', alias: '小台灯', authorized: true });
    const fan = seed(db, { name: '落地扇', address: '192.168.1.31' });
    seed(db, { name: 'Desk', address: '192.168.1.32', alias: 'DeskLamp' });

    // ── C1 三路解析：id / 别名 / 自述名（+ 归一）─────────────────────────────────
    const rId = resolveDeviceByName(asDb(db), lamp.id);
    ok(rId.ok && rId.device.id === lamp.id, 'C1a 按 **id** 解析（uuid 精确）');
    const rAlias = resolveDeviceByName(asDb(db), '小台灯');
    ok(rAlias.ok && rAlias.device.id === lamp.id, 'C1b 按 **别名**解析');
    const rName = resolveDeviceByName(asDb(db), '落地扇');
    ok(rName.ok && rName.device.id === fan.id, 'C1c 按 **自述名**解析');
    ok(resolveDeviceByName(asDb(db), '  小台灯 ').ok, 'C1d 归一：前后空白不碍事');
    ok(resolveDeviceByName(asDb(db), 'desklamp').ok, 'C1e 归一：大小写不敏感（`DeskLamp` ← `desklamp`）');
    ok(resolveDeviceByName(asDb(db), 'DeskLamp').ok && resolveDeviceByName(asDb(db), 'Desk').ok === true,
      'C1f ★别名与自述名**各自可达**（别名档不遮蔽自述名档）');

    // ── C2 ★★歧义两只标本：同别名多台 / 同自述名多台 ⇒ 列候选、不猜 ─────────────────
    const a1 = seed(db, { name: 'A灯', address: '192.168.1.40', alias: '同一个名' });
    const a2 = seed(db, { name: 'B灯', address: '192.168.1.41', alias: '同一个名' });
    const rAmbAlias = resolveDeviceByName(asDb(db), '同一个名');
    ok(!rAmbAlias.ok && rAmbAlias.reason === 'ambiguous' && rAmbAlias.candidates.length === 2,
      'C2a ★同**别名**多台 ⇒ `ambiguous` 并列 2 候选（绝不替用户猜一台）',
      rAmbAlias.ok ? 'ok' : `${rAmbAlias.reason}/${rAmbAlias.candidates.length}`);
    ok(!rAmbAlias.ok && [a1.id, a2.id].every((id) => rAmbAlias.candidates.some((c) => c.id === id)),
      'C2c 候选确系那两台（逐 id 点名，非空占位）');
    seed(db, { name: '同名灯', address: '192.168.1.50' });
    seed(db, { name: '同名灯', address: '192.168.1.51' });
    const rAmbName = resolveDeviceByName(asDb(db), '同名灯');
    ok(!rAmbName.ok && rAmbName.reason === 'ambiguous' && rAmbName.candidates.length === 2,
      'C2b ★同**自述名**多台 ⇒ `ambiguous` 并列 2 候选',
      rAmbName.ok ? 'ok' : `${rAmbName.reason}/${rAmbName.candidates.length}`);

    // ── C3 ★未命中 ⇒ not_found 候选为空（不把"查无此名"当成"随便一台"）─────────────
    const rNo = resolveDeviceByName(asDb(db), '并不存在的灯');
    ok(!rNo.ok && rNo.reason === 'not_found' && rNo.candidates.length === 0,
      'C3a ★查无此名 ⇒ `not_found`，候选**为空**（不猜）');
    ok(!resolveDeviceByName(asDb(db), '   ').ok, 'C3b 空/纯空白键 ⇒ 不匹配（不当成"匹配全部"）');

    // ── C4 ★别名档先于自述名档（跨档：别名的指派比设备自称更权威）───────────────────
    const p = seed(db, { name: 'P自述', address: '192.168.1.60', alias: '共享名' });
    seed(db, { name: '共享名', address: '192.168.1.61' });
    const rP = resolveDeviceByName(asDb(db), '共享名');
    ok(rP.ok && rP.device.id === p.id,
      'C4 ★别名档先于自述名档：别名命中即返（别名的指派更权威）', rP.ok ? rP.device.name : rP.reason);

    // ── C5 工具收 `name`（静态形状：参数、required、解析在编排之前）──────────────────
    const dtool = CODE(`${A}/src/main/core/tools/device.ts`);
    ok(countOcc(dtool, "name: { type: 'string'") >= 2,
      'C5a `device_control`/`device_status` **均**声明 `name` 入参（按名使唤的入口）', `${countOcc(dtool, "name: { type: 'string'")} 处`);
    ok(/required: \['action'\]/.test(dtool) && !/required: \['deviceId'\]/.test(dtool),
      'C5b `device_control` 的 required 为 `[\'action\']`（id/name 二选一，action 必填；旧"必须给 id"已除）');
    ok(/await runDeviceControl\(ddb, \{ deviceId: r\.dev\.id/.test(dtool),
      'C5c ★编排收到的是**解析所得 id**（name→id 真落地，非把名字当 id 传）');
    // zx_20261018_1 批五：`device_intent` 也调 `runDeviceControl`（意图执行那一跳），
    //   整文件 `indexOf` 会先撞上后者 ⇒ 判据**收窄到 device_control 工具体**（更严，不是放宽）。
    const controlBody = dtool.slice(dtool.indexOf('device_control:'), dtool.indexOf('device_intent:'));
    ok(controlBody.indexOf('resolveOrError(raw)') >= 0
      && controlBody.indexOf('resolveOrError(raw)') < controlBody.indexOf('await runDeviceControl(ddb,'),
      'C5d ★先按名解析为在册设备，再交 `runDeviceControl`（审计/状态挂真 id；范围＝device_control 工具体）');
    ok(dtool.includes('call_name: deviceCallName(d)'),
      'C5e `list_devices` 回 `call_name`（AI 拿到"叫得出"的名，才知道该用什么名去控）');
    //   ⚠ zx_20261016_2 批二**重定向**（承 feedback_retarget_assertions_to_stronger_source）：
    //     `runDeviceControl` 收 `actor?`（发起者身份）⇒ 旧"签名逐字不变"作废。**不删不放宽**——
    //     改为钉**更强**的两面：① 旧四参**逐字仍在**（scripts 直调面零改动即兼容）；② 新 `actor?` 在册。
    ok(/raw: \{[\s\S]*?deviceId: string; action: string; args\?: Record<string, unknown>; taskId\?: string;/.test(dtool)
      && /actor\?: \{ kind: DeviceActionActorKind; ref\?: string \}/.test(dtool),
      'C5f ★★`runDeviceControl` 签名**向后兼容**（`deviceId`/`action`/`args`/`taskId` 逐字仍在）**且**新收 `actor?`（zx_20261016_2 发起者）');

    // ── C6 ★★端到端：面板/AI 用**名字**真控到设备（跑生产 `deviceTools`，假传动不触网）──
    const tdb = mkdb({ trial: true }); // 试用 ⇒ Team 档放行，工具真跑
    const lamp2 = seed(tdb, { name: '台灯', address: '192.168.1.70', alias: '书桌灯', authorized: true });
    const calls: string[] = [];
    const tools = deviceTools({
      db: tdb, taskId: 'task-by-name',
      controlDevice: async (dev: AnsDevice, action: string) => { calls.push(`${dev.id}:${action}`); return { ok: true, result: 'done' }; },
    } as unknown as Parameters<typeof deviceTools>[0]);
    const listRaw = await tools.list_devices.execute();
    ok(listRaw.includes('"call_name":"书桌灯"'),
      'C6a `list_devices` 实测回 `call_name`＝别名（AI 看得到"该用哪个名"）', listRaw.slice(0, 120));

    const ctlRaw = await (tools.device_control.execute as (a: unknown) => Promise<string>)({ name: '书桌灯', action: 'turn_on' });
    const ctl = JSON.parse(ctlRaw) as { ok?: boolean; deviceId?: string; result?: string };
    ok(ctl.ok === true && ctl.deviceId === lamp2.id,
      'C6b ★★**按名控制成功**：`device_control({name})` 解析成真设备并下发（意义即用法——名字真能用来控）', ctlRaw);
    eq(calls[0], `${lamp2.id}:turn_on`, 'C6b-2 传动收到的正是那台设备与那个动作（名字→设备→下发）');
    eq(calls.length, 1, 'C6c 传动**恰一次**（名字→设备→下发，无重复下发）');

    const audit = listDeviceActions(asDb(tdb));
    ok(audit.length === 1 && audit[0].device_id === ctl.deviceId && audit[0].result === 'ok',
      'C6d ★审计挂**真 device_id**（非名字——留痕与台账同一把尺）', JSON.stringify(audit[0] ?? {}));

    // 歧义/未命中：**不**下发、**不**落审计（没有可挂靠的设备 id）
    const ambRaw = await (tools.device_control.execute as (a: unknown) => Promise<string>)({ name: '并不存在的灯', action: 'turn_on' });
    ok(!JSON.parse(ambRaw).ok, 'C6e 未命中 ⇒ 工具如实回 `ok:false`（不猜设备、不下发）');
    eq(calls.length, 1, 'C6f ★反证：未命中**未**触发传动（仍恰 1 次），也未落审计');
    eq(listDeviceActions(asDb(tdb)).length, 1, 'C6g ★反证：未命中**未**落审计（查无此名没有可挂靠的 device_id）');

    // `device_status` 同样按名可达
    const stRaw = await (tools.device_status.execute as (a: unknown) => Promise<string>)({ name: '书桌灯' });
    ok(JSON.parse(stRaw).id === ctl.deviceId, 'C6h `device_status({name})` 与按名控制解析到**同一台**');
  }

  // ═══ D｜实测登记（批四：SUBACK 疑点先实测再定修否）═══════════════════════════════
  console.log('\n【D】实测登记 —— 先实测再定修否（毛选·反对本本主义）');
  {
    const planPath = path.join(root, `plans/improve/${SELF_ROUND}.md`);
    const plan = fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf-8') : '';
    ok(plan.includes('SUBACK'),
      'D1 本轮方案在册且载明 SUBACK 疑点的实测（先实测后定修，非本本主义）');
    ok(/未复现|无缺陷/.test(plan),
      'D2 实测结论如实入册（真机未复现 ⇒ 不臆造修复；根因推测与证据边界一并记明）');
    // zx_20261014_4 订正（**按真源现址重定向，非放宽**，承 `feedback_retarget_assertions_to_stronger_source`）：
    //   实测探针 `e2e-mqtt-device.mjs` 已由 `apps/worker-ant-desktop/` 移入 `data/`——`data/` 是 gitignored 区，
    //   ⇒ 本探针"未入库"成为**结构性事实**（而非"只是没 `git add`"），正是暂留探针的既定去处。
    //   断言随真源现址重定向：仍**恰一处**、仍判**存在性**，只是地址改为此刻事实；若日后再迁，
    //   仍按符号重定向而非放宽为"两处皆可"（放宽会让"探针其实已丢"也变绿）。
    ok(fs.existsSync(path.join(root, 'data/e2e-mqtt-device.mjs')),
      'D3 实测脚本暂留在册（后续复跑凭据）——现址 `data/e2e-mqtt-device.mjs`');
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

// ⚠ `catch` 不可省：夹具/断言抛异常时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261014_1: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261014_1 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ rr_zx_20261014_1: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
