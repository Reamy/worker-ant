/**
 * zx_20260912 受控复跑（「如实在场：状态须是活的 · 事件须到场 · 未送达须记因」）。
 *
 * 覆盖：
 *   M0 基线固证（S1 baseline JSON 落盘且结构完整 / S2 五家适配器与接口在位 / S3 运行态写入点穷举
 *                 / S4 outbox 加列前基线 schema 与四态计数 / S5 事件缺口基线 / S6 复用锚点在位
 *                 / S7 上一轮 M1 下钻能力不回归 / S8 rr 计数）；
 *   M1 运行态须是活的（待实施：reporter → DB+事件 / 连续失败→degraded / diagnose 读心跳 / 界面局部刷新）；
 *   M2 事件须到场（待实施：扫码/重发/补发发事件 / 托盘未读 / 分页游标）；
 *   M3 未送达须记因（待实施：last_error/last_attempt_at 落库 + 逐行可见 + dead 全局可达）；
 *   M4 记忆记账即事实（待实施：recordAccess/accessedIds 改 kept 集）；
 *   M5 收口注记（待实施：build 刷 zx_20260912 / 全量 rr / 三绿）；
 *   M6 核实后订正（外部独立核实查出：status 读口径未同源）——「启用中」谓词归一处真源
 *      （S1 真源唯一 / S2 六站点引用且旧谓词清零 / S3 反证非空转 / S4 行为面 / S5 名下无虚
 *       / S6 生产入参端到端：degraded 渠道仍被解析为通知目标，旧谓词下候选集为空）。
 *
 * 断言两类（承 zx_20260911_2 §九 与 feedback「往返/闭环类判据须在生产入参上证」）：
 *   静态断言一律 `stripComments` 后再比对，防注释里的关键词造成假阳性；
 *   行为断言动态 import **真实现**，输入取**真库逐条入参**（见下 REAL_ROWS）。
 *
 * ⚠ M0 断言的写法纪律：**一律写成"子集/下界"式**——因为 M1–M5 会往同一批文件里**加**东西
 *   （新事件类型、新列、新上报点、新界面元素）。若写成"恰好等于"或"不存在"，本轮后续批次
 *   一落地就会把 M0 自己弄红。基线闸门只负责"底子还在"，不负责"不许加"。
 *
 * 本文件不打开任何真库（真库只读实测见 data/baseline_zx_20260912.json）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { listOutbox, outboxStats } from '../apps/worker-ant-desktop/src/main/core/im/im-outbox.js';
import { buildConversationsQuery } from '../apps/worker-ant-desktop/src/main/core/im/im-conversations-query.js';
// zx_20260924_1 M7-c: `buildMemoryContext` 整块迁出到 `core/memory-context.js`，预算以实参传入。
//   预算真源仍是执行体的 `CTX_MEMORY_MAX_CHARS`（C35 钉其可从执行体 import）⇒ 此处 import 常量当实参，
//   不另写字面量（本脚本 S5 仍钉"执行体里的常量恰为 6000"）。
import { buildMemoryContext } from '../apps/worker-ant-desktop/src/main/core/memory-context.js';
import { CTX_MEMORY_MAX_CHARS } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import type { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
import { WechatAdapter } from '../apps/worker-ant-desktop/src/main/services/wechat-adapter.js';
import { QqbotAdapter } from '../apps/worker-ant-desktop/src/main/services/qqbot-adapter.js';
import { DingtalkAdapter } from '../apps/worker-ant-desktop/src/main/services/dingtalk-adapter.js';
import { FeishuAdapter } from '../apps/worker-ant-desktop/src/main/services/feishu-adapter.js';
import { WecomAdapter } from '../apps/worker-ant-desktop/src/main/services/wecom-adapter.js';
import type { ImStatusReport } from '../apps/worker-ant-desktop/src/main/services/im-adapter.js';
import {
  checkBuildPins, deriveBuildTag, scanBuildPins, listStrayPinLiterals, stripKeepingLines,
} from './lib/rr-pins.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) => ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const A = 'apps/worker-ant-desktop';
const RD = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf-8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// node:sqlite 无 better-sqlite3 的 .transaction()——补最小等价 shim（同步执行，无嵌套）
const withTx = (d: DatabaseSync) => { (d as unknown as { transaction: unknown }).transaction = (fn: () => void) => () => fn(); return d; };
type AnyDb = import('better-sqlite3').Database;

// ── 基线 schema 夹具：**逐字照抄** database.ts:247-258 加列前的 10 列（M3 加列前快照）──
const BASELINE_OUTBOX_COLS = [
  'id', 'channel_id', 'external_user_id', 'task_id', 'kind',
  'message', 'attempts', 'status', 'next_retry_at', 'created_at',
] as const;

// 订正（M3 落地时）：夹具补 last_error/last_attempt_at——`listOutbox` 的 SELECT 已含这两列，
//   夹具不补则 M0/S4 的 `listOutbox(db)` 会以 "no such column: o.last_error" 直接抛。
const SCHEMA = `
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, description TEXT, status TEXT, context_json TEXT, updated_at TEXT, priority INTEGER);
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT, name TEXT, config TEXT, status TEXT, created_at TEXT);
CREATE TABLE wa_im_outbox (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, task_id TEXT, kind TEXT DEFAULT 'notification', message TEXT DEFAULT '', attempts INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', next_retry_at INTEGER, created_at TEXT DEFAULT (datetime('now')), last_error TEXT, last_attempt_at TEXT);
CREATE TABLE wa_im_conversations (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, message_json TEXT, direction TEXT, created_at TEXT);
`;
const mkdb = (): AnyDb => { const d = withTx(new DatabaseSync(':memory:')); d.exec(SCHEMA); return d as unknown as AnyDb; };

// ── 生产入参夹具（真库 data/worker-ant-server.db，2026-09-12 只读实测）──
// 真库 4 行的 channel/user/kind/message 逐字照抄（正文截断处补全为完整句，供全文断言）。
const REAL_CHANNEL = 'e7fd4565-4f7e-49fb-a9ad-1aa832db6311';
const REAL_CHANNEL_NAME = '微信工蚁';
const REAL_USER = 'o9cq80x7XC8w9TolIfPuHbpTqaZA@im.wechat';
const REAL_ROWS: Array<{ id: string; kind: string; msg: string; attempts: number; status: string; created_at: string }> = [
  { id: '9bf94524', kind: 'notification', msg: '✅ 任务「20260911-1 方案实施」已完成。\n📄 主要成果：A股智能投资顾问系统', attempts: 3, status: 'dead', created_at: '2026-09-11 03:37:51' },
  { id: '95464104', kind: 'notification', msg: '✅ 任务「[Sub] 取回 A_20260911_1 实施所需的精确源码片段」已完成。', attempts: 3, status: 'dead', created_at: '2026-09-11 03:22:19' },
  { id: '3dadf56b', kind: 'pause_needed', msg: '⚠️ 任务「20260911-1 方案实施」已暂停待复核：产出内容多次未通过充分性校验。', attempts: 3, status: 'dead', created_at: '2026-09-11 03:21:42' },
  { id: '86dcd34c', kind: 'pause_needed', msg: '⚠️ 任务「20260910方案核实」已暂停待复核：目标已多次偏离，已停止自动恢复。', attempts: 3, status: 'sent', created_at: '2026-09-10 06:56:04' },
];
function seedReal(db: AnyDb): void {
  db.prepare('INSERT INTO wa_im_channels (id, channel_type, name, status) VALUES (?, ?, ?, ?)')
    .run(REAL_CHANNEL, 'wechat-personal', REAL_CHANNEL_NAME, 'running');
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, status) VALUES ('t-real', 'p1', '20260910方案核实', 'paused')").run();
  const ins = db.prepare('INSERT INTO wa_im_outbox (id, channel_id, external_user_id, task_id, kind, message, attempts, status, next_retry_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (const r of REAL_ROWS) ins.run(r.id, REAL_CHANNEL, REAL_USER, r.id === '86dcd34c' ? 't-real' : null, r.kind, r.msg, r.attempts, r.status, null, r.created_at);
}

const ADAPTERS = ['wechat-adapter', 'qqbot-adapter', 'dingtalk-adapter', 'feishu-adapter', 'wecom-adapter'] as const;

async function m0(): Promise<void> {
  // ── S1 baseline JSON 落盘且结构完整（实践论：先看事实再看方案）────────────────
  console.log('\n[M0/S1 baseline JSON 落盘与结构]');
  {
    const p = path.join(__dirname, '..', 'data', 'baseline_zx_20260912.json');
    let raw = ''; let j: Record<string, unknown> | null = null;
    try { raw = fs.readFileSync(p, 'utf-8'); j = JSON.parse(raw) as Record<string, unknown>; } catch { /* 未落盘 */ }
    ok(j !== null, 'data/baseline_zx_20260912.json 存在且可解析', j ? '' : '(缺失)');
    if (j) {
      eq(j.round, 'zx_20260912', 'round 标识为本轮');
      const ev = j.evidence as Record<string, unknown> | undefined;
      ok(!!ev, '含 evidence 段');
      for (const k of ['M0_adapterStatusTransitions', 'M0_eventGap', 'M0_outboxSchema', 'M0_dbMeasurements', 'M0_memoryBookkeeping']) {
        ok(!!(ev && ev[k]), `evidence.${k} 在位（M0 五项实测各得其位）`);
      }
      ok(!!j.progress, '含 progress 段（各批次进度可复跑核对）');
      const reg = j.regressionBaseline as { rrCountBefore?: number } | undefined;
      eq(reg?.rrCountBefore, 45, '如实记录本轮前 rr 基数为 45');
    }
  }

  // ── S2 五家适配器与接口在位，且都曾以 getStatus() 自述状态 ────────────────────
  console.log('\n[M0/S2 五家适配器 + ImAdapter 接口在位]');
  {
    const iface = stripComments(RD(`${A}/src/main/services/im-adapter.ts`));
    ok(/getStatus\(\):\s*string/.test(iface), 'ImAdapter 接口声明 getStatus(): string');
    ok(/start\(\)/.test(iface) && /stop\(\)/.test(iface), '接口声明 start()/stop()（本轮只加可选上报点，不改契约）');
    ok(!/setStatusReporter/.test(iface) || /setStatusReporter\??\s*\(/.test(iface), 'setStatusReporter 如已加，须为可选（向后兼容）');
    for (const a of ADAPTERS) {
      const src = stripComments(RD(`${A}/src/main/services/${a}.ts`));
      ok(/getStatus\(\)\s*\{/.test(src), `${a}.ts 实现 getStatus()`);
    }
  }

  // ── S3 运行态写入点穷举：全仓 5 处，且**运行期无人写**（本轮主矛盾的直接依据）──
  console.log('\n[M0/S3 wa_im_channels.status 写入点穷举（5 处）]');
  {
    const files = ['ipc/im.ipc.ts', 'services/wechat-adapter.ts', 'services/qqbot-adapter.ts',
      'services/dingtalk-adapter.ts', 'services/feishu-adapter.ts', 'services/wecom-adapter.ts']
      .map(f => [f, stripComments(RD(`${A}/src/main/${f}`))] as const);
    const count = files.reduce((n, [, s]) => n + (s.match(/UPDATE wa_im_channels SET status/g) || []).length, 0);
    ok(count >= 5, `UPDATE wa_im_channels SET status 写入点 ≥ 5（基线 5 处）`, String(count));
    const ipc = files.find(([f]) => f === 'ipc/im.ipc.ts')![1];
    // 订正（M1 落地时）：基线 4 处（启动恢复/占位/start/stopAll）**一处在不在**；M1 在 wireStatusReporter 里
    // 又加 1 处（运行期上报的唯一落库出口）⇒ 写成下界，否则基线闸门会被本轮的正当增补弄红。
    const ipcWrites = (ipc.match(/UPDATE wa_im_channels SET status/g) || []).length;
    ok(ipcWrites >= 4, 'im.ipc.ts 写入点 ≥ 4（基线 4 处：启动恢复/占位/start/stopAll）', String(ipcWrites));
    const wx = files.find(([f]) => f === 'services/wechat-adapter.ts')![1];
    // 订正（M1 落地时）：基线唯一内联落库点（扫码成功）已改为经 reporter 上报 ⇒ 内联点清零；下界式留痕。
    const wxInline = (wx.match(/UPDATE wa_im_channels SET status/g) || []).length;
    ok(wxInline <= 1, 'wechat-adapter.ts 内联落库 ≤1（基线 1 处「扫码成功」；M1 已统一走 reporter）', String(wxInline));
    // 基线事实：qqbot/dingtalk/feishu/wecom **运行期零内联落库**（M1 起经 reporter 上报，仍无内联写入）
    for (const a of ['qqbot-adapter', 'dingtalk-adapter', 'feishu-adapter', 'wecom-adapter']) {
      const s = files.find(([f]) => f === `services/${a}.ts`)![1];
      eq((s.match(/UPDATE wa_im_channels SET status/g) || []).length, 0, `${a}.ts 无内联落库（运行期状态经 reporter 单一出口）`);
    }
  }

  // ── S4 outbox 加列前 schema 快照 + 四态计数（M3 的直接依据）────────────────────
  console.log('\n[M0/S4 wa_im_outbox 加列前 schema 与真库四态]');
  {
    const dbSrc = stripComments(RD(`${A}/src/main/database.ts`));
    const start = dbSrc.indexOf('CREATE TABLE IF NOT EXISTS wa_im_outbox (');
    const end = start >= 0 ? dbSrc.indexOf('\n  )`', start) : -1;
    const block = start >= 0 && end > start ? dbSrc.slice(start, end) : '';
    ok(block.length > 0, 'database.ts 内定位到 wa_im_outbox DDL 块');
    // 子集式：M3 会加 last_error/last_attempt_at，但底下 10 列**一列都不许少**
    const missing = BASELINE_OUTBOX_COLS.filter(c => !new RegExp(`(^|[\\s,(])${c}\\s`).test(block));
    eq(missing, [], '加列前 10 列一列不少（M3 只许加不许减）');
    // 订正（M3 落地时）：原断言 `!/last_error/ && !/last_attempt_at/`（"基线无此两列"）在本轮加列后**必然转红**——
    //   它把"当时的缺口"写成了"永久不该有"。缺口证据改从 baseline JSON 读（那里**冻结**了加列前的 10 列表），
    //   本处只保留"底子还在"的子集式断言。
    {
      const bj = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'baseline_zx_20260912.json'), 'utf-8')) as {
        evidence?: { M0_outboxSchema?: { columns?: string[] } };
      };
      const cols = bj.evidence?.M0_outboxSchema?.columns ?? [];
      eq(cols.length, 10, 'baseline JSON 冻结了加列前的 10 列表（缺口证据落盘，不靠现场推断）');
      ok(!cols.includes('last_error') && !cols.includes('last_attempt_at'), 'baseline 快照里确无失败原因列（M3 的缺口证据，取自冻结记录）');
    }
    // M3 加列后：两列**必须在**（与上面的"一列不少"合起来 = 只加不减）
    ok(/last_error\s+TEXT/.test(block), 'M3 后 DDL 含 last_error TEXT');
    ok(/last_attempt_at\s+TEXT/.test(block), 'M3 后 DDL 含 last_attempt_at TEXT');
    // 行为侧：真库 4 行逐态计数（dead=3 / sent=1，与用户所见数字一致）
    const db = mkdb(); seedReal(db);
    eq(outboxStats(db), { pending: 0, blocked_quota: 0, dead: 3, sent: 1, other: 0 }, '真库 4 行四态穷尽计数');
    eq(listOutbox(db).length, 4, 'listOutbox 真库 4 行全返（下钻链路在 _5 M1 即已可用）');
    const dead = listOutbox(db, { status: 'dead' });
    eq(dead.length, 3, 'status=dead 过滤 = 真库 3 条');
    ok(dead.every(r => r.channel_name === REAL_CHANNEL_NAME), 'LEFT JOIN 渠道名可达（「微信工蚁」）');
    ok(listOutbox(db).find(r => r.id === '86dcd34c')?.task_title === '20260910方案核实', 'task_id 命中时带出任务标题');
  }

  // ── S5 事件缺口基线：既有 4 类在，status_changed 尚缺（缺口记在 baseline，不作"不存在"断言）──
  console.log('\n[M0/S5 事件类型基线与缺口]');
  {
    const eb = stripComments(RD(`${A}/src/main/core/event-bus.ts`));
    const union = eb.slice(eb.indexOf('export type EventType ='), eb.indexOf(';', eb.indexOf('export type EventType =')));
    for (const t of ['channel.started', 'channel.stopped', 'im.message_inbound', 'im.message_outbound']) {
      ok(union.includes(`'${t}'`), `EventType 含既有 '${t}'（本轮复用同一通道，不新建机制）`);
    }
    // 承 zx_20260911_2：瞬态与持久事件共用同一 handlers map ⇒ emitTransient 同样到达 eventBus.on 订阅者
    const ebAll = RD(`${A}/src/main/core/event-bus.ts`);
    ok(/on\(type: EventType[\s\S]{0,200}this\.handlers\.get\(type\)/.test(ebAll), 'on() 订阅落在 handlers.get(type) 同一张表');
    ok(/emitTransient[\s\S]{0,300}const handlers = this\.handlers\.get\(type\)/.test(ebAll), 'emitTransient 读同一张表（瞬态事件同样到达 on 订阅者）');
    // 基线缺口如实记录在 baseline JSON（M1 补 channel.status_changed 后此处**仍须绿**）
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'baseline_zx_20260912.json'), 'utf-8')) as {
      evidence?: { M0_eventGap?: { missing?: unknown[]; forwardingWhitelist?: string } };
    };
    const miss = j.evidence?.M0_eventGap?.missing ?? [];
    ok(Array.isArray(miss) && miss.length >= 3, '缺口清单如实落盘（≥3 项）', `${(miss as unknown[]).length} 项`);
    ok(!!j.evidence?.M0_eventGap?.forwardingWhitelist, 'index.ts 转发白名单行号已固证（M1/M2 接线点）');
  }

  // ── S6 复用锚点在位（本轮不新建托盘/事件/迁移机制，只接既有）──────────────────
  console.log('\n[M0/S6 既有复用锚点在位]');
  {
    const ipc = stripComments(RD(`${A}/src/main/ipc/im.ipc.ts`));
    ok(/function createAdapter\(/.test(ipc), 'createAdapter 工厂在位（M1 reporter 的**唯一**接线点，两路径共用）');
    eq((ipc.match(/createAdapter\(/g) || []).length, 3, 'createAdapter 定义 1 + 调用 2（启动恢复 :73 / im:startChannel :157）');
    const tray = stripComments(RD(`${A}/src/main/tray.ts`));
    ok(/export function updateTrayPresence\(/.test(tray), 'tray.updateTrayPresence 在位（M2 未读角标同构实现）');
    ok(/export function setTrayRunningMenu\(/.test(tray), 'tray.setTrayRunningMenu 在位（M2/M3 菜单项复用同一 onNavigate 路径）');
    ok(/onNavigate/.test(tray), '托盘跳转回调 onNavigate 在位');
    const idx = stripComments(RD(`${A}/src/main/index.ts`));
    for (const t of ['channel.started', 'channel.stopped', 'im.message_inbound', 'im.message_outbound']) {
      ok(idx.includes(`eventBus.on('${t}'`), `index.ts 已转发 '${t}' → renderer（新事件照此加一行）`);
    }
    const dbsrc = stripComments(RD(`${A}/src/main/database.ts`));
    ok(/const migrations\b/.test(dbsrc) || /migrations\.push\(/.test(dbsrc) || /ALTER TABLE/.test(dbsrc), '幂等迁移数组/ALTER 机制在位（M3 加列走同一处）');
    const outbox = stripComments(RD(`${A}/src/main/core/im/im-outbox.ts`));
    for (const fn of ['enqueueImOutbox', 'listOutbox', 'outboxStats', 'retryOutboxEntry', 'retryImOutbox']) {
      ok(new RegExp(`export (async )?function ${fn}\\(`).test(outbox), `im-outbox.ts 导出 ${fn}（M3 在其上加"原因"列）`);
    }
  }

  // ── S7 上一轮 M1 能力不回归（用户点名的"能看 4 条"是本轮前提，不得回退）────────
  console.log('\n[M0/S7 _5 M1 补发账下钻能力在位（本轮只加"原因"，不重做）]');
  {
    const page = stripComments(RD(`${A}/renderer/src/pages/IMPage.tsx`));
    ok(/outboxOpen/.test(page), 'IMPage 有 outboxOpen 明细开合态（_5 M1）');
    ok(/im:outboxList/.test(page), 'IMPage 调 im:outboxList 取逐条明细（_5 M1）');
    ok(/im:outboxRetry/.test(page), 'IMPage 调 im:outboxRetry 单条补发（_5 M1）');
    ok(/查看明细|收起明细/.test(RD(`${A}/renderer/src/pages/IMPage.tsx`)), '界面上有「查看明细/收起明细」入口（_5 M1）');
    // 两处 return-from-fetch 已在 renderer 侧解包（ipcCall 解 {data} 信封）
    const ipcTs = RD(`${A}/renderer/src/lib/ipc.ts`);
    ok(/data/.test(ipcTs) && /IpcError/.test(ipcTs), 'renderer ipcCall 解 {data} 信封、错误抛 IpcError（链路通）');
  }

  // ── S8 rr 计数（单调下界，防误删不锁死）───────────────────────────────────────
  console.log('\n[M0/S8 rr 脚本计数]');
  {
    const rrFiles = fs.readdirSync(__dirname).filter(f => f.startsWith('rr_') && f.endsWith('.ts'));
    ok(rrFiles.length >= 46, 'rr 脚本不少于 46（本轮 45 → 46）', String(rrFiles.length));
    ok(rrFiles.includes('rr_zx_20260912.ts'), '本轮脚本在位');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// M1 运行态须是活的（海德格尔·在场）
// 断言策略：**出口契约静态钉死 + 适配器侧行为实证**。
//   行为侧用真实现 + 真入参（无网的错误路径 4 家全可测；wechat 用真 token 文件走"已保存令牌"路径），
//   IPC 侧（wireStatusReporter）因依赖 electron 无法动态 import ⇒ 只做静态断言，
//   两半合起来覆盖「适配器上报 → 落库 + 发事件」这条链。
// ══════════════════════════════════════════════════════════════════════════════
async function m1(): Promise<void> {
  // ── S1 接口与装配点：(1) 契约可选 (2) 唯一接线点 (3) 事件类型 + 转发 ──────────
  console.log('\n[M1/S1 上报器契约 · 唯一接线点 · 事件与转发]');
  {
    const iface = RD(`${A}/src/main/services/im-adapter.ts`);
    ok(/export interface ImStatusReport\b/.test(iface), 'ImStatusReport 类型导出（status + 可选 detail）');
    ok(/export type ImStatusReporter\s*=/.test(iface), 'ImStatusReporter 类型导出');
    ok(/setStatusReporter\?\(reporter: ImStatusReporter\)/.test(iface), 'setStatusReporter 为**可选**成员（未实现的适配器行为完全不变）');

    const ipc = stripComments(RD(`${A}/src/main/ipc/im.ipc.ts`));
    ok(/function wireStatusReporter\(/.test(ipc), 'wireStatusReporter 在位');
    ok(/wireStatusReporter\(db, adapter, channelId\)/.test(ipc), 'wireStatusReporter 在 createAdapter 内被调用（唯一接线点 ⇒ 两条启动路径同时生效）');
    ok(/adapter\.setStatusReporter\(\(report\)/.test(ipc), 'createAdapter 装配 setStatusReporter');
    ok(/UPDATE wa_im_channels SET status = \? WHERE id = \?/.test(ipc), '上报时落库 wa_im_channels.status（唯一真源）');
    ok(/emitTransient\('channel\.status_changed'/.test(ipc), "上报时发瞬态事件 'channel.status_changed'（高频，不进不可变事件日志）");
    ok(/status: report\.status/.test(ipc) && /detail: report\.detail \|\| ''/.test(ipc), '事件载荷带 status + detail（界面可如实说明"到了哪一步"）');

    const eb = stripComments(RD(`${A}/src/main/core/event-bus.ts`));
    const union = eb.slice(eb.indexOf('export type EventType ='), eb.indexOf(';', eb.indexOf('export type EventType =')));
    ok(union.includes("'channel.status_changed'"), "EventType 含 'channel.status_changed'");
    // 瞬态的**判据**：不在 EVENT_AGGREGATE_MAP 内（否则会被 emit 持久化 + 触发 webhook）
    const aggStart = eb.indexOf('const EVENT_AGGREGATE_MAP');
    const aggBlock = eb.slice(aggStart, eb.indexOf('};', aggStart));
    ok(!aggBlock.includes('channel.status_changed'), 'channel.status_changed **不在** EVENT_AGGREGATE_MAP（瞬态，不持久化）');
    ok(aggBlock.includes("'channel.started'") && aggBlock.includes("'channel.stopped'"), 'channel.started/stopped 仍在聚合表（持久事件语义不变，不回归）');

    const idx = stripComments(RD(`${A}/src/main/index.ts`));
    ok(/eventBus\.on\('channel\.status_changed'/.test(idx), "index.ts 已转发 'channel.status_changed' → renderer");
    ok(/forwardToRenderer\('channel\.status_changed'/.test(idx), '转发走既有 forwardToRenderer（不新建通道）');
  }

  // ── S2 五家适配器上报出口齐备（子集式：出口必须在，跃迁点各自各异）────────────
  console.log('\n[M1/S2 五家适配器：单一出口 report() + 运行期跃迁点]');
  {
    for (const a of ADAPTERS) {
      const s = stripComments(RD(`${A}/src/main/services/${a}.ts`));
      ok(/private report\(status: string, detail\?: string\): void/.test(s), `${a}.ts 有唯一出口 report(status, detail?)`);
      ok(/this\.statusReporter\?\.\(\{ status/.test(s), `${a}.ts 经 reporter 上报（可缺省，缺省即行为不变）`);
      ok(/setStatusReporter\(reporter: ImStatusReporter\): void/.test(s), `${a}.ts 实现 setStatusReporter`);
    }
    const wx = stripComments(RD(`${A}/src/main/services/wechat-adapter.ts`));
    ok(/const DEGRADED_AFTER_FAILURES = 3/.test(wx), 'wechat 降级阈值 = 连续失败 3 次（有界、可读）');
    ok(/private reportPollHealth\(failures: number, detail: string\)/.test(wx), 'wechat 有 poll 健康→状态 的专用跃迁函数');
    ok(/reportPollHealth\(\(hb\.consecutive_failures as number\) \|\| 0/.test(wx), 'pollLoop 错误路径调 reportPollHealth（携 consecutive_failures）');
    ok(/recordHeartbeat\('ok'/.test(wx) && /reportPollHealth\(\(hb\.consecutive_failures as number\) \|\| 0, ''\)/.test(wx), 'pollLoop 正常路径同样调（恢复正常 ⇒ 回到 running）');
    ok(/while \(this\.running\)/.test(wx), 'pollLoop 循环语义不变（只加上报，未改退出条件）');
    const qq = stripComments(RD(`${A}/src/main/services/qqbot-adapter.ts`));
    ok(/this\.report\('running', 'Bot 已连接'\)/.test(qq), 'qqbot READY → running（此前只改内存）');
    ok(/this\.report\('degraded', `连接断开，重连中（第 \$\{this\.reconnectAttempts\} 次）`\)/.test(qq), 'qqbot 重连（无上限）→ degraded（如实示人：没放弃但不健康）');
    const dt = stripComments(RD(`${A}/src/main/services/dingtalk-adapter.ts`));
    ok(/this\.report\('degraded', `连接断开，重连中（第 \$\{this\.reconnectAttempts\} 次）`\)/.test(dt), 'dingtalk 重连 → degraded');
    ok(/this\.report\('error', '重连失败（已达最大次数 5）'\)/.test(dt), 'dingtalk 达上限 → error（明确的放弃点，带原因）');
    const fs1 = stripComments(RD(`${A}/src/main/services/feishu-adapter.ts`));
    ok(/onReady: \(\) => \{ this\.report\('running'/.test(fs1), 'feishu 接 SDK onReady → running');
    ok(/onReconnecting: \(\) => \{ this\.report\('degraded'/.test(fs1), 'feishu 接 SDK onReconnecting → degraded');
    ok(/onReconnected: \(\) => \{ this\.report\('running'/.test(fs1), 'feishu 接 SDK onReconnected → running');
    ok(/onError: \(err: Error\) => \{ this\.report\('error'/.test(fs1), 'feishu 接 SDK onError → error');
    ok(/handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS/.test(fs1), 'feishu 设握手超时（不设则 SDK 可无限挂住、任何回调都不触发）');
    ok(!/this\.status = 'running';\n\s*console\.log\(`\[IM:feishu\] SDK 长连接已启动/.test(fs1), 'feishu 不再在 start() 里直写 running（握手未成不得冒充已就绪）');
  }

  // ── S3 行为：缺配置的五家（除 wechat 需网络）**失败即如实上报 error** ──────────
  console.log('\n[M1/S3 行为：start() 失败路径如实上报（真实现 + 真入参，无网可达）]');
  {
    const cases: Array<[string, (db: AnyDb) => { setStatusReporter: (r: (x: ImStatusReport) => void) => void; start: () => Promise<void> }]> = [
      ['qqbot', db => new QqbotAdapter(db, REAL_CHANNEL, {})],
      ['dingtalk', db => new DingtalkAdapter(db, REAL_CHANNEL, {})],
      ['feishu', db => new FeishuAdapter(db, REAL_CHANNEL, {})],
      ['wecom', db => new WecomAdapter(db, REAL_CHANNEL, {})],
    ];
    for (const [name, make] of cases) {
      const db = mkdb();
      db.prepare('INSERT INTO wa_im_channels (id, channel_type, name, status) VALUES (?,?,?,?)').run(REAL_CHANNEL, name, '未配置', 'inactive');
      const a = make(db);
      const got: ImStatusReport[] = [];
      a.setStatusReporter(r => got.push(r));
      let threw = false;
      try { await a.start(); } catch { threw = true; }
      ok(threw, `${name}.start() 缺配置即抛（调用方须能感知失败）`);
      eq(got.map(g => g.status), ['starting', 'error'], `${name} 上报序列 = starting → error`);
      ok(!!got[1] && typeof got[1].detail === 'string' && got[1].detail.length > 0, `${name} 的 error 带具体原因（detail 非空）`, got[1]?.detail);
    }
  }

  // ── S4 行为：wechat 走「已保存令牌」真文件入参 → starting → running；stop 不经 report ──
  console.log('\n[M1/S4 行为：wechat 已保存令牌启动（真 token 文件）+ stop 语义]');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-m1-wx-'));
    fs.mkdirSync(path.join(dir, '.wechat-personal'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.wechat-personal', 'acct-real.json'), JSON.stringify({
      token: 'tok-real', base_url: 'https://ilinkai.weixin.qq.com', account_id: 'acct-real',
      scanner_user_id: 'u1', saved_at: '2026-09-12T00:00:00.000Z',
    }));
    const db = mkdb();
    db.prepare('INSERT INTO wa_im_channels (id, channel_type, name, status) VALUES (?,?,?,?)').run(REAL_CHANNEL, 'wechat-personal', REAL_CHANNEL_NAME, 'inactive');
    const a = new WechatAdapter(db, REAL_CHANNEL, {}, dir);
    const got: ImStatusReport[] = [];
    a.setStatusReporter(r => got.push(r));
    await a.start();
    ok(got.length >= 2, '启动了上报（≥2 条）', String(got.length));
    eq(got[0]?.status, 'starting', '第一条 = starting');
    eq(got[1]?.status, 'running', '第二条 = running（走已保存令牌路径）');
    eq(a.getStatus(), 'running', 'getStatus() 与上报一致（单一真源：report 改内存）');
    await a.stop();
    eq(a.getStatus(), 'inactive', 'stop() → inactive');
    ok(!got.some(g => g.status === 'inactive'), "stop() **不上报** inactive（停止由 im:stopChannel 统一写库发事件；退出时 stopAll 故意不写库以免破坏下次启动恢复）");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── S5 复用/vs 新增的边界：在用渠道口径 + diagnose 如实 ──────────────
  console.log('\n[M1/S5 口径：在用判定含 degraded · 诊断增「运行健康」· 渠道状态比对实况]');
  {
    const ipc = stripComments(RD(`${A}/src/main/ipc/im.ipc.ts`));
    // 订正（M6 落地时）：原断言钉的是 `=== 'running' || === 'degraded'`——那是 M1 的**半拉子实现**
    // （error/pending 仍被排除）。M6 统一为「非 inactive」后该形态必红，按同一纪律改钉新口径，
    // 并补一条"旧半拉子形态已不存在"，防实现被回退而不自知。
    ok(/adapter\.getStatus\(\) !== 'inactive'/.test(ipc), "getEnabledChannels 视「非 inactive」为在用（degraded/pending/error 皆不排除，不缩小 F3 推送覆盖面）");
    ok(!/=== 'running' \|\| adapter\.getStatus\(\) === 'degraded'/.test(ipc), "M1 的半拉子形态（只补 degraded）已不存在");
    ok(/check: '运行健康'/.test(ipc), "im:diagnose 新增「运行健康」项");
    ok(/key = 'im_wechat_heartbeat'/.test(ipc), '运行健康直接读既有心跳键 im_wechat_heartbeat（该键此前只写不读，本轮起用于诊断）');
    ok(/consecutive_failures/.test(ipc) && /last_ok_at/.test(ipc), '诊断读连续失败数与最近成功时刻');
    ok(/实况=\$\{adapterStatus\}（不一致）/.test(ipc), '「渠道状态」比对 DB 记录 vs 适配器实况，不一致即不通过（界面与真实相反须显形）');
  }

  // ── S6 GUI：降级可见 + 不闪（静默刷新）+ 启停在途态 ───────────────────────────
  console.log('\n[M1/S6 GUI：degraded 可见 · 面板不被卸载 · 启停在途态]');
  {
    const page = RD(`${A}/renderer/src/pages/IMPage.tsx`);
    const pageC = stripComments(page);
    ok(/degraded:\s*\{\s*label:'降级·重连中'/.test(pageC), 'CH_STATUS_META 含 degraded「降级·重连中」（不再冒充运行中）');
    ok(/async function refreshChannels\(\)[\s\S]{0,200}?im\.channels\(\)/.test(pageC), '有 refreshChannels 静默刷新实现');
    ok(!/refreshChannels\(\) \{ setLoading\(true\)/.test(pageC), '静默刷新**不**置 setLoading(true)（否则整页 spinner 会卸载正在看的面板）');
    ok(/event\.type === 'channel\.started' \|\| event\.type === 'channel\.stopped'\) void refreshChannels\(\)/.test(pageC), 'channel.started/stopped 处理改走静默刷新');
    ok(/event\.type === 'channel\.status_changed'/.test(pageC), 'IMPage 订阅 channel.status_changed');
    ok(/setStatusDetail\(/.test(pageC) && /event\.detail/.test(pageC), 'IMPage 记下 detail 并显示（"到了哪一步/为何失败"）');
    ok(/busyChannels/.test(pageC), '启停按钮有在途态（busyChannels）');
    ok(/disabled=\{busyChannels\.has\(ch\.id\)\}/.test(pageC), '在途时按钮禁用（防重复点击）');
    // G8 后形态更新：该入口不再是"手抄字面量清单的尾巴"，而是词表 `start` 字段（有值即显示，值即措辞）。
    // 原断言钉的是 `'degraded') && <button onClick={()=>handleStart` 这一**实现形态**；行为等同，改钉新形态。
    ok(/const sm\s*=\s*statusMeta\(ch\.status\)/.test(pageC) && /sm\.start&&/.test(pageC)
      && /degraded:\s*\{[^}]*start:'强制重启'/.test(pageC),
      'degraded 渠道提供「强制重启」入口（经词表 start 字段，不再靠手抄清单）');
    const decl = stripComments(RD(`${A}/renderer/src/types/electron.d.ts`));
    ok(/interface TaskEvent \{/.test(decl) && /status\?: string;/.test(decl) && /detail\?: string;/.test(decl), 'TaskEvent 类型补 status/detail（renderer 侧类型与转发载荷对齐，否则 build 不过）');
  }
}

// ══ M2 事件须到场 ══════════════════════════════════════════════════════════════
// 断言策略（与 M1 同一纪律）：能行为实证的一律实证（真实现 + 真入参）；IPC 侧依赖 electron
// 无法动态 import，改为**静态钉死 SQL/出口**，并把生产 SQL 原文取出在内存库上跑语义实证。
async function m2(): Promise<void> {
  const IM_UNREAD = `${A}/src/main/core/im/im-unread.ts`;
  const { computeImUnread, markImRead, getImLastReadAt, refreshImUnread, setImUnreadSink } =
    await import('../apps/worker-ant-desktop/src/main/core/im/im-unread.js');
  const { retryOutboxEntry, retryImOutbox } = await import('../apps/worker-ant-desktop/src/main/core/im/im-outbox.js');
  const { eventBus } = await import('../apps/worker-ant-desktop/src/main/core/event-bus.js');

  // ── S1 扫码到到场：事件为主，轮询降为兜底 ──────────────────────────────────
  console.log('\n[M2/S1 扫码到到场：事件驱动收口 + 轮询降兜底]');
  {
    const pageC = stripComments(RD(`${A}/renderer/src/pages/IMPage.tsx`));
    ok(/qrChannelRef/.test(pageC), '扫码弹窗所看渠道有 ref（事件到达时能判"是否正是这个弹窗"）');
    // G8 后形态更新：收口条件由"裸比 'running'/'error'"改为词表 qrClose（与下方兜底轮询**同一份决定**）。
    // 行为等同（running⇒ok、error⇒fail），且从此两处不可能再各写一份清单。
    ok(/if \(q && cid === q\.id\)[\s\S]{0,320}?statusMeta\(String\(event\.status \?\? ''\)\)\.qrClose[\s\S]{0,120}?qr === 'ok'\) \{ closeQr\(\); \}/.test(pageC), 'channel.status_changed(status=running) → 即时收口弹窗（扫码成功；经词表 qrClose）');
    ok(/qr === 'fail'\) \{ closeQr\(\); setError\(String\(event\.detail/.test(pageC), 'channel.status_changed(status=error) → 收口并如实显示原因（过期/失败不再冒充"加载中"）');
    ok(/\},5000\);/.test(pageC) && /轮询降为\*\*兜底\*\*/.test(RD(`${A}/renderer/src/pages/IMPage.tsx`)), '轮询间隔 2000→5000 且注明"兜底"（事件为主，不再靠轮询当主通道）');
  }

  // ── S2 重发/补发到场：复用 im.message_outbound（不新增事件名）────────────────
  console.log('\n[M2/S2 重发/补发到场：静默改库 → 发事件]');
  {
    const ipc = stripComments(RD(`${A}/src/main/ipc/im.ipc.ts`));
    ok(/emitOutboundMessage\(\{ channelId, channelType, toUser: externalUserId, preview: text \}\)/.test(ipc), 'im:resend 插会话后发 im.message_outbound（此前静默）');
    const ox = stripComments(RD(`${A}/src/main/core/im/im-outbox.ts`));
    ok(/function emitRetriedOutbound\(db: DB/.test(ox), 'im-outbox 有补发成功上报出口 emitRetriedOutbound');
    const sites = (ox.match(/emitRetriedOutbound\(/g) || []).length;
    ok(sites === 3, 'emitRetriedOutbound 定义 1 处 + 调用 2 处（单条补发 / 自动补发各一），实为 ' + sites);
    ok(/emitTransient\('im\.message_outbound'/.test(stripComments(RD(`${A}/src/main/core/im/outbound-event.ts`))), '复用既有 im.message_outbound（未新增事件名）');

    // 行为：真实现 + 真入参，补发成功必须发事件（含渠道类型与正文预览）
    const d = mkdb(); seedReal(d);
    const seen: Array<Record<string, unknown>> = [];
    eventBus.on('im.message_outbound', (e) => { seen.push(e.data); });
    d.prepare("UPDATE wa_im_outbox SET status = 'pending', next_retry_at = 1 WHERE id = '9bf94524'").run();
    const r1 = await retryOutboxEntry(d, '9bf94524', { send: async () => true, now: Date.now() });
    await new Promise((res) => setImmediate(res));
    ok(r1.ok === true, '单条手动补发成功（真实现）', r1.status);
    ok(seen.length === 1, '单条补发成功 → 发出 1 条 im.message_outbound（此前 0 条）', String(seen.length));
    ok(seen[0]?.channelId === REAL_CHANNEL && seen[0]?.channelType === 'wechat-personal', '事件载荷带真渠道 id + 渠道类型');
    ok(seen[0]?.toUser === REAL_USER && typeof seen[0]?.preview === 'string' && (seen[0]!.preview as string).length > 0, '事件载荷带收件人 + 正文预览');
    ok(!('pending' in (seen[0] ?? {})), '补发成功的事件**不带** pending 标记（pending 只用于"未送达入账"）');

    // 自动补发路径（retryImOutbox）同样要到场（created_at 须在补发窗口内，否则按超窗转 dead 是既有语义）
    d.prepare("UPDATE wa_im_outbox SET status = 'pending', next_retry_at = 1, created_at = datetime('now') WHERE id = '95464104'").run();
    await retryImOutbox(d, 60, { send: async () => true, now: Date.now() });
    await new Promise((res) => setImmediate(res));
    ok(seen.length === 2, '自动补发成功 → 同样发事件（两条路径都不静默）', String(seen.length));
  }

  // ── S3 未读账：唯一真源 + 入站+1 + 在看即归零 + 只走托盘 ─────────────────────
  console.log('\n[M2/S3 未读账：唯一真源 im_last_read_at + 托盘角标（不新增通知）]');
  {
    const SETTINGS = "CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))";
    const insConv = (d: AnyDb, dir: string, at: string) =>
      d.prepare("INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, created_at) VALUES (?,?,?,?,?,?)")
        .run(`c-${Math.random().toString(36).slice(2, 10)}`, REAL_CHANNEL, REAL_USER, '{}', dir, at);

    // (a) 首次缺省 = 当前时刻：历史会话不得被算成未读
    const d1 = mkdb(); d1.exec(SETTINGS); seedReal(d1);
    const t0 = getImLastReadAt(d1);
    ok(!!t0 && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t0), '首次读取即落库当前时刻（UTC 秒级，与 created_at 同口径）', t0);
    ok(getImLastReadAt(d1) === t0, '二次读取取回落库值（不覆盖，账稳定）');
    insConv(d1, 'inbound', '1999-01-01 00:00:00');
    ok(computeImUnread(d1) === 0, '早于已读时刻的历史入站 **不计**未读（缺省值防历史全会话洪水）');

    // (b) 入站+1 / 出站不计 / 归零
    const d2 = mkdb(); d2.exec(SETTINGS); seedReal(d2);
    d2.prepare("INSERT INTO wa_settings (key, value) VALUES ('im_last_read_at', '2000-01-01 00:00:00')").run();
    insConv(d2, 'inbound', '2001-01-01 00:00:00');
    insConv(d2, 'inbound', '2001-01-01 00:00:00');
    insConv(d2, 'inbound', '2001-01-01 00:00:00');
    insConv(d2, 'outbound', '2001-01-01 00:00:00');
    insConv(d2, 'outbound', '2001-01-01 00:00:00');
    ok(computeImUnread(d2) === 3, '未读 = 3（只计 inbound；出站 2 条不计）', String(computeImUnread(d2)));
    const sink: number[] = [];
    setImUnreadSink((n) => sink.push(n));
    ok(refreshImUnread(d2) === 3 && sink[sink.length - 1] === 3, '未读数同步到显示端（sink 收到 3）', JSON.stringify(sink));
    ok(markImRead(d2) === 0 && sink[sink.length - 1] === 0, '「确实在看 IM」→ 立刻归零（sink 收到 0）', JSON.stringify(sink));
    // 归零后再来 1 条入站（时刻取真实"已读之后 1 分钟"，与生产入站同形）
    const nextAt = new Date(Date.now() + 60_000).toISOString().slice(0, 19).replace('T', ' ');
    insConv(d2, 'inbound', nextAt);
    ok(computeImUnread(d2) === 1, '归零后再来 1 条入站 → 未读 1（账单调，不累积漂移）', String(computeImUnread(d2)));
    setImUnreadSink(null);

    // (c) 静态：接线点与显示端
    const router = stripComments(RD(`${A}/src/main/services/im-router.ts`));
    ok(/refreshImUnread\(ctx\.db\)/.test(router), 'im-router 在入站落库后刷新未读账（唯一入站真源）');
    const tray = stripComments(RD(`${A}/src/main/tray.ts`)).replace(/^\s*\/\/.*$/gm, '');
    ok(/let _imUnread = 0/.test(tray), '托盘持有未读态 _imUnread');
    ok(/if \(_imUnread > 0\) parts\.push\(`IM 未读 \$\{_imUnread\}`\)/.test(tray), 'tooltip 追加「· IM 未读 N」（与「执行中 N」同构）');
    ok(/label: `IM 未读 \$\{_imUnread\} 条 →`/.test(tray), '菜单项「IM 未读 N 条 →」');
    ok(/click: \(\) => _handlers\.onOpenIm\?\.\(\)/.test(tray), '菜单项点击走注入的 onOpenIm（复用既有跳转通道，不新建托盘框架）');
    ok(/export function updateTrayImUnread\(n: number, onOpenIm\?: \(\) => void\)/.test(tray), 'updateTrayImUnread 与 updateTrayPresence 同构（导出、纯计数）');
    ok(!/new Notification\(/.test(tray), '托盘路径**不新增系统通知**（用户对打断敏感：未读只在托盘示人）');
    const idx = stripComments(RD(`${A}/src/main/index.ts`));
    // zx_20260914 M1-3: sink 体**仍是"把显示端接到托盘并注入 onOpenIm"**，只是显示端从一个变两个
    //   （同一份 n 又推给 renderer 的导航红点）。原断言把 sink 体钉成单行字面量，现改为断言托盘那一次调用
    //   落在 **sink 块内**——意图不变、不因并列第二个显示端而误红（renderer 半场由 rr_zx_20260914_2 §S4.4 钉）。
    ok(/setImUnreadSink\(\(n\) => \{[\s\S]{0,500}?updateTrayImUnread\(n, onOpenIm\)/.test(idx),
      'main 把显示端接到托盘并注入 onOpenIm（sink 内；允许并列第二个显示端）');
    ok(/mainWindow\.webContents\.send\('notif:focus-task', \{ type: 'im\.navigate' \}\)/.test(idx), "点击走既有 notif:focus-task 通道（type='im.navigate'）");
    ok(/if \(db\) refreshImUnread\(db\)/.test(idx), '启动时按库里已读时刻对现存未读一次性对账（重启不丢）');
    const app = stripComments(RD(`${A}/renderer/src/App.tsx`));
    ok(/type === 'im\.navigate'\) \{ navigate\('\/im'\); return; \}/.test(app), "renderer 认 type='im.navigate' → 跳 IM 页");
    const pageC = stripComments(RD(`${A}/renderer/src/pages/IMPage.tsx`));
    // zx_20261002 M2 订正（**非回归**）：挂载即清零是**缺陷本身**（方案 §1.1-5：打开 /im 默认停在渠道列表，
    //   红点在"尚未读任何对话"时消失）。原断言把缺陷钉成正确行为，现反转为「挂载**不清零**」+「点开该渠道才清」。
    ok(!/useEffect\(\(\) => \{ void im\.markRead\(\)\.catch\(\(\) => \{\}\); \}, \[\]\)/.test(pageC),
      'zx_20261002 M2 反证：IMPage 挂载**不再**清零（打开 /im 停在渠道列表，红点仍在）');
    // zx_20261003 M12：该处 markRead 现**随后刷新逐渠道红点**（`…then(() => refreshUnreadByChannel()).catch(…)`）
    //   ——钉同一条更强的真源：仍**带渠道**清、且清完把红点账一并刷新（非放宽）。
    ok(/void im\.markRead\(channelId\)\.then\(\(\) => refreshUnreadByChannel\(\)\)\.catch\(\(\) => \{\}\)/.test(pageC),
      '打开**该渠道**的对话才清该渠道未读（markRead 收 channelId，清后刷新逐渠道红点）');
    ok(/document\.visibilityState === 'visible'[\s\S]{0,160}?im\.markRead\(cid\)/.test(pageC), '正在看时新入站也归零，但**仅该渠道**且**窗口隐藏时不算**（否则最小化也吞掉未读）');
    const ipcTxt = stripComments(RD(`${A}/src/main/ipc/im.ipc.ts`));
    ok(/ipcMain\.handle\('im:markRead'/.test(ipcTxt) && /markImRead\(_dbForIm[,)]/.test(ipcTxt), "im:markRead IPC 走唯一真源 markImRead（收 channelId，只清该渠道）");
    ok(/markRead: \(channelId\?: string\) => ipcCall<\{ unread: number \}>\('im:markRead', channelId\)/.test(stripComments(RD(`${A}/renderer/src/lib/ipc.ts`))), 'renderer ipc 面导出 markRead（透传 channelId）');
    // 未读账模块本身必须与 Electron 解耦（否则入站热路径与回归脚本都被拖上 GUI）
    ok(!/from '\.\.\/\.\.\/tray\.js'/.test(RD(IM_UNREAD)) && /setImUnreadSink/.test(RD(IM_UNREAD)), 'im-unread 与托盘解耦（sink 注入），不 import electron');
  }

  // ── S4 分页不漂移：rowid 游标（生产 SQL 原文在内存库上实证）─────────────────
  // 订正（zx_20260913 M1-5 落地时，**非回归**）：取数 SQL 由 `im.ipc.ts` 内联抽出为唯一出口
  //   `core/im/im-conversations-query.ts`——故不再从 ipc 刮字符串，改为**动态 import 生产 builder**
  //   直接取 SQL/参数跑真库（跑的是真函数，比刮文本更强）。游标单调 / 不重不漏 / OFFSET 反证 全部保留。
  console.log('\n[M2/S4 分页不漂移：rowid 游标取代 OFFSET]');
  {
    const ipc = stripComments(RD(`${A}/src/main/ipc/im.ipc.ts`));
    const qmod = RD(`${A}/src/main/core/im/im-conversations-query.ts`);
    ok(/beforeSeq\?: number/.test(ipc), 'im:conversations 接受 beforeSeq 游标参数');
    ok(/export function buildConversationsQuery/.test(qmod), '取数条件唯一出口 buildConversationsQuery（真源）');

    const cursorQ = buildConversationsQuery({ channelId: REAL_CHANNEL, beforeSeq: 1 });
    const firstQ = buildConversationsQuery({ channelId: REAL_CHANNEL, offset: 0 });
    ok(/AND rowid < \? ORDER BY rowid DESC/.test(cursorQ.sql), '游标页 SQL：rowid < 界 + ORDER BY rowid DESC（同一把尺）');
    ok(/ORDER BY rowid DESC LIMIT 50 OFFSET \?/.test(firstQ.sql), '首页 SQL 同样按 rowid 排序（不再用不稳定的 created_at DESC）');

    // 行为：把**生产 builder 产出的** SQL 在内存库上跑——连续实时插入下翻页不重不漏
    const d = mkdb(); seedReal(d);
    const ins = d.prepare("INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, created_at) VALUES (?,?,?,?,?,?)");
    for (let i = 0; i < 120; i++) ins.run(`conv-${String(i).padStart(3, '0')}`, REAL_CHANNEL, REAL_USER, '{}', 'inbound', '2026-09-12 00:00:00'); // created_at 全同秒 ⇒ 旧排序必并列
    const first = d.prepare(firstQ.sql).all(...firstQ.params) as Array<{ id: string; seq: number }>;
    ok(first.length === 50, '首页 50 条', String(first.length));
    // 实时插入 3 条（模拟用户翻页时新消息到达）
    for (let i = 0; i < 3; i++) ins.run(`fresh-${i}`, REAL_CHANNEL, REAL_USER, '{}', 'inbound', '2026-09-12 00:00:00');
    const oldest = first[first.length - 1]!.seq;
    const curQ = buildConversationsQuery({ channelId: REAL_CHANNEL, beforeSeq: oldest });
    const second = d.prepare(curQ.sql).all(...curQ.params) as Array<{ id: string; seq: number }>;
    const seenIds = new Set(first.map((r) => r.id));
    ok(second.length === 50, '游标页 50 条', String(second.length));
    ok(second.every((r) => !seenIds.has(r.id)), '游标页与首页**零重复**（新插入 3 条未把窗口顶偏）');
    const union = new Set([...first, ...second].map((r) => r.id));
    ok(union.size === 100, '两页合计恰 100 条不同记录（不漏）', String(union.size));
    ok(second.every((r) => r.seq < oldest), '游标页全部严格早于边界 seq（游标单调，不受插入影响）');
    // 反证：同一场景下 OFFSET 会漂移（证明改动的必要性，而非无病呻吟）
    const offsetQ = buildConversationsQuery({ channelId: REAL_CHANNEL, offset: 50 });
    const offsetPage2 = d.prepare(offsetQ.sql).all(...offsetQ.params) as Array<{ id: string }>;
    ok(offsetPage2.some((r) => seenIds.has(r.id)), '反证：OFFSET=50 的旧口径在新插入后**与首页重复**（漂移真实存在）');

    const pageC = stripComments(RD(`${A}/renderer/src/pages/IMPage.tsx`));
    ok(/seq: number/.test(pageC), 'Conversation 类型含 seq（与 main 的 rowid AS seq 对齐）');
    ok(/im\.conversations\(convChannel, \{ beforeSeq: oldestSeq, \.\.\.convFilter\(\) \}\)/.test(pageC), '「加载更多」按游标取页（并带上当前筛选，同一把尺）');
    ok(!/im\.conversations\(convChannel, convs\.length\)/.test(pageC), '「加载更多」不再用已加载条数当 OFFSET');
    // zx_20260930 M2-a：签名由裸 `(channelId: string)` 扩为带 `expect?`、返 `{ok, landed}`——
    //   乐观气泡的退场条件从"取数没报错"改成"那一行**真在返回集里**"。原判据钉的是**旧形状**，
    //   合法扩展即红。改钉**更强的真源**：名字/async 仍在，且"退场判据"确实由本函数交回调用方。
    ok(/async function prependNewConvs\(channelId: string/.test(pageC), '实时入站走前插（prependNewConvs）');
    ok(/prependNewConvs\(channelId: string, expect\?: \{ text: string; afterSeq: number \}\)/.test(pageC),
      '★ 前插收「期望行」入参（M2-a：退场按"那一行真在集里"判，不再按"取数没报错"）');
    ok(/Promise<\{ ok: boolean; landed: boolean \}>/.test(pageC),
      '★ IM 页内确有 `{ok, landed}` 这一返回形状（"没送达"与"发出了但这屏还没取到"两种话得以分开说）');
    ok(/const maxSeq = Math\.max\(\.\.\.prev\.map\(c => Number\(c\.seq\) \|\| 0\)\)/.test(pageC)
      && /const fresh = list\.filter\(c => \(Number\(c\.seq\) \|\| 0\) > maxSeq\)/.test(pageC)
      && /return \[\.\.\.fresh, \.\.\.updated\]/.test(pageC),
      '前插只加 seq 更大的新行，保留用户已翻出的旧页');
    ok(/incoming\.has\(c\.id\) \? \{ \.\.\.c, \.\.\.incoming\.get\(c\.id\)! \} : c/.test(pageC),
      '（M1-4 增量）同 id 就地更新——补发成功后该行由 failed 翻 sent 即时可见');
    ok(/void prependNewConvs\(cid\)/.test(pageC) && !/cid === convChannelRef\.current\) \{ void showConvs\(cid\); \}/.test(pageC), '入站事件不再 showConvs 重置（翻页进度/滚动位置不丢）');
  }
}

// ══ M3 未送达须记因、全局可达 ═══════════════════════════════════════════════════
// 断言策略（与 M1/M2 同一纪律）：
//   **能行为实证的一律实证**——记因与"语义不回归"都用真实现 + 真库入参在内存库上跑；
//   `im.ipc.ts`（sendImCompletionNotice 所在）静态 import electron，本脚本无法动态 import
//   ⇒ 该侧只静态钉死**出口契约与调用点**，缺口在此断言里如实写出（不假装测过）。
async function m3(): Promise<void> {
  const DB_SRC = RD(`${A}/src/main/database.ts`);
  const { ImSendError, ImQuotaError, isImSendError, isImQuotaError } =
    await import('../apps/worker-ant-desktop/src/main/core/im/im-errors.js');
  const { retryOutboxEntry, retryImOutbox, enqueueImOutbox } = await import('../apps/worker-ant-desktop/src/main/core/im/im-outbox.js');

  // ── S1 加列走法：DDL + 幂等迁移两处齐备，且**在加列前基座上可重复施加** ────────
  console.log('\n[M3/S1 last_error/last_attempt_at 加列（DDL + 幂等 ALTER，两处）]');
  {
    ok(/last_error\s+TEXT/.test(DB_SRC) && /last_attempt_at\s+TEXT/.test(DB_SRC), 'DDL 含两列（新库直接建全）');
    const alters = DB_SRC.match(/"ALTER TABLE wa_im_outbox ADD COLUMN (?:last_error|last_attempt_at) TEXT"/g) || [];
    eq(alters.length, 2, 'migrations 数组含两条加列 ALTER（旧库补列，生产原文）');
    ok(/for \(const sql of migrations\)[\s\S]{0,120}?try \{ db\.exec\(sql\); \} catch/.test(DB_SRC),
      '迁移逐条 try/catch（列已存在即跳过）——加列天然幂等');

    // 行为：以**加列前 10 列基座**（真库实测快照，见 baseline JSON）施加上产原文 ALTER，重复施加不炸
    const base10 = `CREATE TABLE wa_im_outbox (${BASELINE_OUTBOX_COLS.map(c => `${c} ${/attempts|next_retry_at/.test(c) ? 'INTEGER' : 'TEXT'}`).join(', ')})`;
    const d0 = withTx(new DatabaseSync(':memory:'));
    d0.exec(base10);
    const colsOf = () => (d0.prepare('PRAGMA table_info(wa_im_outbox)').all() as Array<{ name: string }>).map(c => c.name);
    eq(colsOf().length, 10, '基座 = 加列前 10 列（旧库形态）');
    let firstThrew = false;
    try { for (const s of alters) d0.exec(JSON.parse(s)); } catch { firstThrew = true; }
    ok(!firstThrew, '上游原文 ALTER 在旧库基座上施加成功');
    const c1 = colsOf();
    ok(c1.includes('last_error') && c1.includes('last_attempt_at'), '施加后两列在位（旧库升级到 12 列）', String(c1.length));
    let secondThrew = false;
    try { for (const s of alters) d0.exec(JSON.parse(s)); } catch { secondThrew = true; }
    ok(secondThrew, '重复施加（旧库已升级过的情形）就地抛「duplicate column」——正是 runner 要吞的那一种');
  }

  // ── S2 记因入口：真原因从栈上进账（不只"未送达"三个字）────────────────────────
  console.log('\n[M3/S2 失败真原因落库（真实现 + 真库入参）]');
  {
    ok(isImSendError(new ImSendError('x')), 'isImSendError 认本类');
    ok(!isImSendError(new ImQuotaError('x')) && !isImQuotaError(new ImSendError('x')), '两类型互不误判（配额 ≠ 普通失败，各自处置不变）');

    // **初次失败**（首投没送到 → 落账那一刻的原因）——方案验收的首条
    const de = mkdb(); seedReal(de);
    enqueueImOutbox(de, { channelId: REAL_CHANNEL, externalUserId: REAL_USER, taskId: '', kind: 'notification', message: '初次未送达的消息' }, '[IM] 渠道适配器未运行');
    const er = de.prepare("SELECT last_error, last_attempt_at, attempts, status FROM wa_im_outbox WHERE message = ?").get('初次未送达的消息') as
      { last_error: string | null; last_attempt_at: string | null; attempts: number; status: string };
    eq(er.last_error, '[IM] 渠道适配器未运行', '初次失败的原因随落账一并入库（首投就不静默）');
    ok(!!er.last_attempt_at, '初次失败的尝试时刻同样在案');
    ok(er.status === 'pending' && er.attempts === 0, '落账仍是 pending/attempts=0（既有落账语义不变，只多记一句原因）', `${er.status}/${er.attempts}`);
    // 不带原因落账（旧调用点形态）⇒ NULL，界面如实说"原因未记录"，不回填猜测
    enqueueImOutbox(de, { channelId: REAL_CHANNEL, externalUserId: REAL_USER, taskId: '', kind: 'notification', message: '无原因的落账' });
    const er2 = de.prepare("SELECT last_error FROM wa_im_outbox WHERE message = ?").get('无原因的落账') as { last_error: string | null };
    ok(er2.last_error === null, '不传原因 ⇒ last_error 为 NULL（不拿空话冒充原因）');

    const REASON = '微信网关 502：会话已过期，需重新扫码';
    const d = mkdb(); seedReal(d);
    const r = await retryOutboxEntry(d, '95464104', { send: async () => { throw new ImSendError(REASON); }, now: Date.now() });
    const row = d.prepare('SELECT status, attempts, last_error, last_attempt_at FROM wa_im_outbox WHERE id = ?').get('95464104') as
      { status: string; attempts: number; last_error: string | null; last_attempt_at: string | null };
    eq(row.last_error, REASON, '失败真原因落库（补发那几条为何没送到，答得出了）');
    ok(!!row.last_attempt_at && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.last_attempt_at),
      '最近尝试时刻落库（UTC 秒级，与 created_at 同口径）', String(row.last_attempt_at));
    ok(r.error === REASON && row.status === 'dead', '同一次失败的原因既回给调用方、也进账（两处同一句话）', r.error);

    // 未记到原因的行：如实说"原因未记录"，不拿空话冒充原因（界面侧 outboxReason 的取值前提）
    const d2 = mkdb(); seedReal(d2);
    const bare = d2.prepare('SELECT last_error, last_attempt_at FROM wa_im_outbox WHERE id = ?').get('9bf94524') as
      { last_error: string | null; last_attempt_at: string | null };
    ok(bare.last_error === null && bare.last_attempt_at === null, '从未尝试过的存量行两列为 NULL（界面据此如实显示，不回填猜测）');

    // 注入 send 抛**普通** Error：既有语义（状态/次数都不动）逐字保留，只额外记因
    const d3 = mkdb(); seedReal(d3);
    d3.prepare("UPDATE wa_im_outbox SET status='pending', next_retry_at=1, created_at=datetime('now') WHERE id='9bf94524'").run();
    const r3 = await retryOutboxEntry(d3, '9bf94524', { send: async () => { throw new Error('注入的普通异常'); } });
    const row3 = d3.prepare('SELECT status, attempts, last_error FROM wa_im_outbox WHERE id = ?').get('9bf94524') as
      { status: string; attempts: number; last_error: string | null };
    ok(row3.status === 'pending' && row3.attempts === 3 && r3.status === 'pending',
      '注入 send 抛普通异常：状态/次数**原样不动**（_4/_5 既有注入语义不回归）', `${row3.status}/${row3.attempts}`);
    eq(row3.last_error, '注入的普通异常', '但原因仍记下（记因不改变处置，只补上"为什么"）');

    // 配额类：不烧次数、标 blocked_quota，同样记因
    const d4 = mkdb(); seedReal(d4);
    d4.prepare("UPDATE wa_im_outbox SET status='pending', next_retry_at=1, created_at=datetime('now') WHERE id='9bf94524'").run();
    const r4 = await retryOutboxEntry(d4, '9bf94524', { send: async () => { throw new ImQuotaError('推送配额已耗尽'); } });
    const row4 = d4.prepare('SELECT status, attempts, last_error FROM wa_im_outbox WHERE id = ?').get('9bf94524') as
      { status: string; attempts: number; last_error: string | null };
    ok(row4.status === 'blocked_quota' && row4.attempts === 3 && r4.quota === true,
      '配额类：不烧次数、标 blocked_quota（既有分工不变）', `${row4.status}/${row4.attempts}`);
    eq(row4.last_error, '推送配额已耗尽', '配额类同样记因（等待的是什么条件，账上看得见）');
  }

  // ── S3 语义不回归：ImSendError 与 send=false **逐字同一径** ────────────────────
  console.log('\n[M3/S3 ImSendError ≡ send=false（次数/状态/退避三项全等）]');
  {
    const FIXED = Date.now();
    const mkPending = (d: AnyDb, id: string) => d.prepare(
      "INSERT INTO wa_im_outbox (id, channel_id, external_user_id, task_id, kind, message, attempts, status, next_retry_at, created_at) VALUES (?, ?, ?, NULL, 'notification', 'x', 0, 'pending', 1, datetime('now'))"
    ).run(id, REAL_CHANNEL, REAL_USER);

    /** 连失败 3 次，逐步记录 (attempts, status, 退避分钟)。 */
    const trail = async (id: string, boom: () => Promise<boolean>): Promise<Array<[number, string, number | null]>> => {
      const out: Array<[number, string, number | null]> = [];
      for (let i = 0; i < 3; i++) {
        await retryOutboxEntry(d, id, { send: boom, now: FIXED });
        const r = d.prepare('SELECT attempts, status, next_retry_at FROM wa_im_outbox WHERE id = ?').get(id) as
          { attempts: number; status: string; next_retry_at: number | null };
        out.push([r.attempts, r.status, r.next_retry_at == null ? null : Math.round((r.next_retry_at - FIXED) / 60_000)]);
      }
      return out;
    };
    const d = mkdb(); seedReal(d);
    mkPending(d, 'm3-send'); mkPending(d, 'm3-false'); mkPending(d, 'm3-quota');
    const byThrow = await trail('m3-send', async () => { throw new ImSendError('boom'); });
    const byFalse = await trail('m3-false', async () => false);
    eq(byThrow, byFalse, 'ImSendError 与 send=false **逐字同一径**（次数/状态/退避三项全等）');
    eq(byThrow, [[1, 'pending', 1], [2, 'pending', 2], [3, 'dead', 2]] as Array<[number, string, number | null]>,
      '1 次→pending(退避 1m) / 2 次→pending(退避 2m) / 3 次→dead（上限 3 与 1-2-4 退避不变）');

    // 配额类在**自动补发**路径同样不烧次数（既有语义，本轮只加记因）
    const dq = mkdb(); seedReal(dq);
    mkPending(dq, 'm3-auto-quota');
    await retryImOutbox(dq, 60, { send: async () => { throw new ImQuotaError('未持有 token'); }, now: FIXED });
    const rq = dq.prepare('SELECT status, attempts, last_error FROM wa_im_outbox WHERE id = ?').get('m3-auto-quota') as
      { status: string; attempts: number; last_error: string | null };
    ok(rq.status === 'blocked_quota' && rq.attempts === 0, '自动补发遇配额：不烧次数、标 blocked_quota（_4 M2-2 语义不变）', `${rq.status}/${rq.attempts}`);
    eq(rq.last_error, '未持有 token', '自动补发路径同样记因');

    // 超窗终态也记因（此前是"超窗"两字，不说为什么走到这一步）
    const dw = mkdb(); seedReal(dw);
    dw.prepare("UPDATE wa_im_outbox SET status='pending', next_retry_at=1, created_at='2000-01-01 00:00:00' WHERE id='9bf94524'").run();
    await retryImOutbox(dw, 10, { send: async () => true, now: FIXED });
    const rw = dw.prepare('SELECT status, last_error FROM wa_im_outbox WHERE id = ?').get('9bf94524') as { status: string; last_error: string | null };
    ok(rw.status === 'dead' && /超过补发窗口/.test(rw.last_error || ''), '超窗转 dead 也记因（为什么放弃，账上说得清）', String(rw.last_error));
  }

  // ── S4 sendImCompletionNotice 新契约 + 调用点带因（静态；electron 侧缺口如实）──
  console.log('\n[M3/S4 首投失败即带因入账（im.ipc 出口契约 + 两处调用点）]');
  {
    const ipcRaw = RD(`${A}/src/main/ipc/im.ipc.ts`);
    const ipc = stripComments(ipcRaw);
    ok(/export async function sendImCompletionNotice\([\s\S]{0,200}?Promise<\{ ok: boolean; error\?: string \}>/.test(ipc),
      'sendImCompletionNotice 契约改为「带回真原因」的结果对象（此前 boolean 把原因丢在 catch 里）');
    ok(/if \(!adapter\) return \{ ok: false, error: '\[IM\] 渠道适配器未运行' \}/.test(ipc), '无适配器：如实回报具体原因');
    ok(/catch \(err\) \{\s*return \{ ok: false, error: \(err as Error\)\.message \|\| String\(err\) \};/.test(ipc), '适配器抛错：原因原样上抛（不再吞成 false）');
    ok(/export async function sendImMessage\([\s\S]{0,300}?if \(!adapter\) throw new Error\('\[IM\] 渠道适配器未运行'\)/.test(ipc),
      'sendImMessage（严格发送，补发用）仍**抛出**——outbox 的配额/普通失败分流依赖它，不能被本改动带偏');

    const notify = stripComments(RD(`${A}/src/main/core/im/im-notify.ts`));
    ok(/const r = await sendImCompletionNotice\(tg\.channelId, tg\.externalUserId, taskId, message\);\s*if \(!r\.ok\)[\s\S]{0,220}?enqueueImOutbox\(db, \{[\s\S]{0,160}?\}, r\.error\)/.test(notify),
      'im-notify 首投失败把 r.error 一并入账（完成/失败/介入暂停/超长进度共用此出口）');
    const idx = stripComments(RD(`${A}/src/main/index.ts`));
    ok(/const r = await sendImCompletionNotice\(ch\.id, toUser, taskId, question\);\s*if \(!r\.ok\)[\s\S]{0,260}?enqueueImOutbox\(db, \{[\s\S]{0,180}?\}, r\.error\)/.test(idx),
      'index.ts ask_user 首投失败同样带因入账');

    // 缺口如实：im.ipc.ts 静态 import electron ⇒ 本脚本不能动态 import 它，
    //   上面的"首投失败带因"只有静态钉死（出口契约 + 调用点形参）；真正的发送行为由 S2/S3 在
    //   真实现 im-outbox 上覆盖（那里注入的 send 走的正是 im.ipc 的同一类型分流）。
    ok(/from 'electron'/.test(ipcRaw), '缺口如实：im.ipc.ts 依赖 electron，故该侧只做静态断言（不假装测过发送行为）');
  }

  // ── S5 逐行可见 + dead 全局可达：界面答得出"为什么"，不在 IM 页也看得见 ─────────
  console.log('\n[M3/S5 界面记因逐行可见 · dead 托盘可达（不在 IM 页也示人）]');
  {
    const pageC = stripComments(RD(`${A}/renderer/src/pages/IMPage.tsx`));
    ok(/function outboxReason\(r: OutboxRow\): string/.test(pageC), 'IMPage 有 outboxReason：原因显示走单一出口');
    ok(/失败原因：/.test(pageC), '逐行显示「失败原因：…」（此前只有"尝试 N 次"）');
    ok(/原因未记录（本次未送达）/.test(pageC) && /尚未尝试补发/.test(pageC),
      '无原因时**如实**分两种说：「尚未尝试补发」/「原因未记录」——不拿空话冒充原因');
    ok(/last_error\s*:\s*string\s*\|\s*null/.test(pageC) && /last_attempt_at\s*:\s*string\s*\|\s*null/.test(pageC), 'OutboxRow 类型含两列（与 main 的 SELECT 对齐，否则 build 不过）');
    ok(/最终未送达（已放弃：超窗\/超次）/.test(pageC), 'dead 组标题写明**为何**放弃（超窗/超次），不只说"已放弃"');
    ok(/手动补发：计入当日推送配额[\s\S]{0,60}?1\/2\/4[\s\S]{0,40}?3 次转/.test(pageC), '补发按钮 tooltip 明示配额口径 + 退避/上限规则（点击前可知代价）');

    // 意图单例：IM 页是 lazy 分包，托盘点击可能先于挂载 ⇒ 先落意图、挂载时消费
    const intent = RD(`${A}/renderer/src/lib/uiIntent.ts`);
    ok(/export function requestImOutbox\(\)/.test(intent) && /export function consumeImOutboxRequest\(\): boolean/.test(intent),
      'uiIntent 提供 request/consume（pending 意图单例）');
    ok(/取走即清|_pendingOutbox = false/.test(intent), '意图取走即清（正常进 IM 页不会莫名展开）');
    const app = stripComments(RD(`${A}/renderer/src/App.tsx`));
    ok(/type === 'im\.outbox'\) \{ requestImOutbox\(\); navigate\('\/im'\); return; \}/.test(app),
      "renderer 认 type='im.outbox'：**先落意图再跳转**（复用既有 notif:focus-task 通道）");
    ok(/if \(consumeImOutboxRequest\(\)\) \{ setOutboxOpen\(true\); void loadOutboxRows\(\); \}/.test(pageC),
      'IMPage 挂载即消费意图：落页即展开明细（"跳过去了但没展开"不再发生）');

    // 托盘：与 _imUnread 同构
    const tray = stripComments(RD(`${A}/src/main/tray.ts`));
    ok(/let _outboxDead = 0/.test(tray), '托盘持有 _outboxDead（与 _imUnread/_runningCount 同构）');
    ok(/if \(_outboxDead > 0\) parts\.push\(`出站未送达 \$\{_outboxDead\}`\)/.test(tray), 'tooltip 追加「· 出站未送达 N」');
    ok(/label: `出站未送达 \$\{_outboxDead\} 条 →`/.test(tray), '菜单项「出站未送达 N 条 →」');
    ok(/click: \(\) => _handlers\.onOpenOutbox\?\.\(\)/.test(tray), '菜单点击走注入的 onOpenOutbox（复用既有跳转通道）');
    ok(/export function updateTrayOutboxDead\(n: number, onOpenOutbox\?: \(\) => void\)/.test(tray), 'updateTrayOutboxDead 与 updateTrayImUnread 同构');
    ok(/if \(changed\) rebuildMenu\(\)/.test(tray), 'n 未变不重建菜单（与 updateTrayImUnread 同一收敛口径）');
    ok(/_outboxDead = 0;/.test(tray), 'destroyTray 复位（不留上一会话的账）');

    // main：**同源同尺** + 关补发不等于关可见
    const idx = stripComments(RD(`${A}/src/main/index.ts`));
    ok(/const reconcileOutboxDead = \(\) => \{[\s\S]{0,260}?outboxStats\(db\)\.dead/.test(idx),
      '对账取 outboxStats(db).dead ——与补发扫描**同一份统计**，菜单数字不是另算的');
    ok(/mainWindow\.webContents\.send\('notif:focus-task', \{ type: 'im\.outbox' \}\)/.test(idx), "onOpenOutbox 走既有 notif:focus-task（type='im.outbox'）");
    // 同一段 20s tick 内：min<=0 只跳过补发这一支，对账**不受 min 影响**
    ok(/if \(min > 0\) \{[\s\S]{0,200}?retryImOutbox\(db!, min\)\)/.test(idx),
      '`min<=0` 不再提前 return（原为 `if (min <= 0) return;`）——只跳过**补发**这一支');
    ok(/if \(min > 0\) \{[\s\S]{0,400}?reconcileOutboxDead\(\);/.test(idx),
      '同一次 20s tick 里对账：关补发时 dead 仍到场（关的是"补发"，不是"看得见"）');
    ok(/if \(db\) refreshImUnread\(db\);\s*reconcileOutboxDead\(\);/.test(idx), '启动先对一次（重启后「未送达」不丢）');
  }

  // ── S6 存量真库账：3 条 dead 现在**答得出为什么**（真行入参，只读判定）─────────
  console.log('\n[M3/S6 真库 3 条 dead 的记因能力（存量行为 NULL ⇒ 界面如实说"原因未记录"）]');
  {
    const d = mkdb(); seedReal(d);
    const dead = d.prepare("SELECT id, last_error FROM wa_im_outbox WHERE status = 'dead'").all() as Array<{ id: string; last_error: string | null }>;
    eq(dead.length, 3, '真库 dead 行数与用户所见一致（3 条）');
    ok(dead.every(r => r.last_error === null), '存量 dead 两列为 NULL（迁移不回填猜测——历史原因已不可考，如实说"未记录"）');
    // 用户点名的 3 条 dead 行 id 逐字在册，便于日后核对
    eq(dead.map(r => r.id).sort(), ['3dadf56b', '95464104', '9bf94524'], '用户点名的 3 条 dead 行逐字在册（可逐条核对）');
  }
}

// ═══════════════ M4 记忆记账即事实（王阳明·知行合一 / 夏克特·错误归因 / 艾宾浩斯·提取强度） ═══════════════
async function m4(): Promise<void> {
  console.log('\n=== M4 记忆记账即事实：被省略的记忆不得记「用过」 ===');

  // ── 夹具：假 MemoryManager + 记录 recordAccess 入参（**真实现**动态跑，断言记账事实） ──
  // zx_20261014_4 批五 **就地换承载**（不动判据，只换真源）：此前那个**低优先且带记忆 id** 的段是
  //   `项目知识全景`（§0）——批五已**退役**该注入段（消费位由零 LLM 的 `项目域知识` 接管，而后者是
  //   **派生事实册、非 `wa_memories` 行、无记忆 id**）。「整段省略 ⇒ 该段的记忆 id 不记账 / 不进排除集」
  //   这条不变量必须继续被钉，故低优先 id 段的**新载体**取 `跨项目知识迁移`（同为 'low'，且**带**记忆 id）。
  //   段与 id 的新对应：跨项目知识迁移→x1（**低**优先，长，必被省）；范例记忆→无 id（**中**优先，超长，必被省）；
  //   近期经验→e1（**中**优先，短，因"同级内后位先丢"被 范例记忆 挡在前面而存活）。
  //   kept 侧刻意选**经 `notExcluded` 包装**的段（近期经验/跨项目迁移 ✓；已知盲区提醒等段**未**包装，跨 run 排除对其不生效——既有事实，S2 要用上排除机制）。
  const CROSS_MARK = 'CROSS-MARK-跨项目知识迁移';
  const EPI_MARK = 'EPI-MARK-近期经验';
  let exemplarText = '## 范例记忆\n' + 'e'.repeat(7000); // 超长中优先段：逼出「低+中」两段皆省
  const accessCalls: string[][] = [];
  const stub = (over: Record<string, unknown> = {}) => ({
    getTaskArchetype: () => null, getTaskText: () => '实现 X 功能',
    retrieveByType: (t: string) => (t === 'episodic'
      ? [{ id: 'e1', content: EPI_MARK, importance: 0.8, valence: 'positive', memory_type: 'episodic', context_json: '{}' }]
      : []),
    buildMemoryEffectivenessStats: () => [], buildExecutionPlaybook: () => ({}),
    generateExemplarContext: () => exemplarText,
    findSimilarTasks: () => [], findCrossProjectSimilarTasks: () => [],
    getCrossProjectKnowledge: () => [{ id: 'x1', projectName: '项目X', memoryType: 'semantic', content: CROSS_MARK + 'c'.repeat(900) }],
    retrieveTaskRelevant: () => [], retrieveByCue: () => [], getProjectKnowledge: () => [],
    retrieveUnknownHits: () => [], retrieveKnowledgeGraphContext: () => [], getTriggeredProspective: () => [],
    markProspectiveTriggered: () => {}, getWorkingMemory: () => [], retrieveNegativeHits: () => [],
    getSimilarTaskExperience: () => '', getPeerAcceptanceCriteria: () => [], deepRetrieve: () => [],
    memoryConfTag: () => '', confidenceOf: () => 1, maturityOf: () => 1, applicabilityMismatch: () => false,
    recordAccess: (ids: string[]) => { accessCalls.push([...ids]); },
    ...over,
  }) as unknown as MemoryManager;
  const goal = { goal: '完成本轮实施', success_criteria: 'rr 全绿', investigate: [] };

  // ── S1 越界不记账 + kept 照记（同一次运行同时证明两件相反的事，防"修成不记"）──
  console.log('\n[M4/S1 越预算 ⇒ 省略段不记账；kept 段照记（真实现 + 假 memory 记入参）]');
  {
    accessCalls.length = 0;
    const r = buildMemoryContext(stub(), 'p1', 't1', 'X'.repeat(30), goal, undefined, CTX_MEMORY_MAX_CHARS);
    // 先证明这一跑**真的**发生了省略（否则下面全是空断言）
    eq(r.meta.omitted, 2, `本次确有两段越界被省略（sections=${r.meta.sections} kept=${r.meta.kept}）`);
    ok(r.context.includes('已省略 2 段：范例记忆、跨项目知识迁移'), '省略注记逐段点名（按装配原序：中(范例记忆)、低(跨项目迁移)）');
    ok(!r.context.includes(CROSS_MARK), '被省略段（跨项目知识迁移）确实没进上下文文本（前提成立，非空断言）');
    ok(r.context.includes(EPI_MARK), 'kept 段（近期经验）确实进了上下文文本');
    // 记账集
    eq(accessCalls.length > 0 ? accessCalls[accessCalls.length - 1] : null, ['e1'],
      'recordAccess 只记 kept 段的 id（e1），**不含被省略段的 x1**');
    eq(r.accessedIds, ['e1'], '返回 accessedIds 只含真正入文者（e1），不含 x1');
    ok(!r.accessedIds.includes('x1'), '被整段省略的记忆未被记成「用过」（本轮病根：旧实现此处为 [pano1,e1]）');
  }

  // ── S2 被省略者**不会**因此被永久排除（下一 run 预算宽裕时仍可注入）──────
  console.log('\n[M4/S2 省略 ≠ 永久排除：下一 run 预算宽裕时本节仍可被注入（行为对照）]');
  {
    accessCalls.length = 0;
    const mem = stub();
    const r1 = buildMemoryContext(mem, 'p1', 't1', 'X'.repeat(30), goal, undefined, CTX_MEMORY_MAX_CHARS);
    exemplarText = ''; // 第二 run：范例记忆不再占预算 ⇒ 预算宽裕
    const r2 = buildMemoryContext(mem, 'p1', 't1', 'X'.repeat(30), goal, new Set(r1.accessedIds), CTX_MEMORY_MAX_CHARS);
    ok(r2.context.includes(CROSS_MARK), 'r1 被省略的 x1 在 r2 仍被注入（未被写入排除集 ⇒ 非永久排除）');
    eq(r2.accessedIds, ['x1'], 'r2 的记账集正是 x1；r1 已入文的 e1 被排除集正确挡掉（排除机制非空转）');
    exemplarText = '## 范例记忆\n' + 'e'.repeat(7000); // 还原，防后续用例串味
  }

  // ── S3 同源：注记点名的段 = 未计入记账的段（同一份 kept/omitted 划分）──────
  // zx_20260924_1 M7-c：装配函数整块迁到 `core/memory-context.ts` ⇒ 切块锚点随之改（原锚点
  //   `'\n/** 任务类型引导 */'` 在新模块**不存在**，不改就是切出空块、三条断言全假绿式地报红）。
  console.log('\n[M4/S3 注记与记账同源（不再两处各算）]');
  {
    const memSrc = stripComments(RD(`${A}/src/main/core/memory-context.ts`));
    const fnStart = memSrc.indexOf('export function buildMemoryContext(');
    const body = fnStart >= 0 ? memSrc.slice(fnStart) : ''; // 该函数现为模块内最后一个声明（到文件尾）
    ok(body.includes('  return {\n    context: `<memory-context>'), `切块自证：装配函数体切到（块长 ${body.length}）`);
    ok(/const sel = selectMemorySections\(/.test(body) && /const \{ kept, omitted \} = sel;/.test(body),
      'kept/omitted 取自这一次 selectMemorySections（单一真源；zx_20260929 M4 起改为"先接 `sel` 再解构"——'
      + '`chars` 不再直接从它取，见 S3b 账＝实）');
    ok(/const keptIds = \[\.\.\.new Set\(kept\.flatMap\(s => s\.ids \?\? \[\]\)\)\]/.test(body), 'keptIds 由**同一份 kept** 推出（与注记同源，非另算）');
    // zx_20260929 M4 就地订正：原判据断言"记账集**先于**注记成形"这一**语句次序**。M4 为把注记计入 `meta.chars`
    //   而把 `omittedNote` 前移到 `keptIds` 之前 ⇒ 次序不再成立。但次序从来不是不变量：互补性由**唯一那次
    //   `sel` 划分**保证（注记只读 `omitted`、记账集只读 `kept`，二者是 `sel` 的两面），与该次序无关。
    //   故改钉**真不变量**（同源互补），不保留一个只为旧写法为真的次序断言（"改旧断言=改钉更强的新真源"）。
    ok(/const omittedNote = noteOf\(omitted\);/.test(body) && /om\.map\(s => s\.name\)/.test(body),
      '注记**只读 omitted**（`noteOf(omitted)`，实现内 `om.map(s => s.name)`）、记账集只读 `kept` ⇒ '
      + '同出上面那一次 `sel` 划分 ⇒ 点名的段必不含于记账集（结构互补，与语句先后无关）');
  }

  // ── S4 下游闭合：排除集与界面明细都取自同一 accessedIds ────────────────
  console.log('\n[M4/S4 下游三处同源（排除集 / memory_injected 事件 / 注入快照）]');
  {
    const src = stripComments(RD(`${A}/src/main/core/agent-executor.ts`));
    ok(/if \(built\.accessedIds\.length > 0\) \{\s*[\s\S]{0,700}?injected_memory_ids = \[\.\.\.new Set\(\[\.\.\.prevInjected, \.\.\.built\.accessedIds\]\)\]/.test(src),
      '跨 run 排除集只写真正入文者（被省略者不进 priorInjectedIds）');
    ok(/const placeholders = built\.accessedIds\.map\(\(\) => '\?'\)/.test(src), '界面「注入明细」查询同样取 accessedIds（未入文者不上界面）');
    ok(src.includes("eventBus.emit('task.memory_injected'"), 'memory_injected 事件仍在（事件名与载荷字段零改动）');
    ok(src.includes('memoryCtxSections: memoryCtxMeta?.sections') && src.includes('memoryCtxOmitted: memoryCtxMeta?.omitted'),
      'context_watermark.memoryCtx* 口径不变（仍读 meta）');
  }

  // ── S5 红线静态：数值未动 / 谓词未动 / 记账位置在取舍之后 ──────────────
  // zx_20260924_1 M7-c：装配函数与取舍纯函数整块迁到 `core/memory-context.ts`。
  //   订正口径（**只增不减**）：实现类判据改扫新模块；`CTX_MEMORY_MAX_CHARS` **仍在执行体**（照旧扫执行体）；
  //   并补两条反向条（执行体里不再有装配算式 / 新模块里不出现 6000）——迁一半留一半即红。
  console.log('\n[M4/S5 红线：数值与检索谓词未动，记账改到取舍之后（装配侧扫新模块）]');
  {
    const src = stripComments(RD(`${A}/src/main/core/agent-executor.ts`));
    const memSrc = stripComments(RD(`${A}/src/main/core/memory-context.ts`));
    const fnStart = memSrc.indexOf('export function buildMemoryContext(');
    const body = fnStart >= 0 ? memSrc.slice(fnStart) : '';
    ok(src.includes('const CTX_MEMORY_MAX_CHARS = 6000;'), 'CTX_MEMORY_MAX_CHARS 仍为 6000 且**仍在执行体**（不改数值）');
    ok(memSrc.includes('export const MEM_OVERHEAD = 220'), 'MEM_OVERHEAD 仍为 220（不改数值；上提为模块级导出）');
    ok(!/\b6000\b/.test(memSrc), '★反向条：新模块内不出现 6000（预算真源不被搬成第二处）');
    ok(!src.includes('selectMemorySections(parts'), '★反向条：执行体内不再有装配侧预算算式');
    ok(!/memory\.recordAccess\(uniqueIds\)/.test(body), '旧记账点（取舍之前、一次性记全量）已不存在');
    ok(body.indexOf('selectMemorySections(parts') < body.indexOf('memory.recordAccess(keptIds)'),
      '记账**在取舍之后**（先定谁入文，再记谁被用）');
    ok(memSrc.includes('export interface MemSection { name: string; priority: MemSectionPriority; text: string; ids?: string[] }'),
      'MemSection 增可选 ids（selectMemorySections 签名与算法一字未动）');
    // 检索谓词：13 个含记忆的段必须各自把 id 交给 add（下界式，允许将来再加段）
    // zx_20261014_4 批五 就地改钉（**换真源，非放宽**）：`项目知识全景`（原先那段**带 id 的低优先段**）已退役；
    //   其消费位由 `项目域知识` 接管——后者是**派生事实册**（非 `wa_memories` 行），**不**带记忆 id。
    //   故正则**放宽到两种命名形**（`m => m.id` 与 `k => k.id` 都收——比原先更严：漏写任一形的段现在也会被数进来），
    //   阈值随之由 14 落回 13：**数变是因为段真的少了一个**，不是因为门槛松了。
    const idSites = (body.match(/\.map\([a-zA-Z]+ => [a-zA-Z]+\.id\)/g) || []).length;
    ok(idSites >= 13, `含记忆的段逐段接线 id（实测 ${idSites} ≥ 13；panorama 退役后的基准）`);
    ok(body.includes('listDomainKnowledge(') && body.includes('selectKnowledgeForInject('),
      '§K「项目域知识」真被消费：经 listDomainKnowledge 取派生事实册、selectKnowledgeForInject 预算内择节');
    const predicates = ["listDomainKnowledge(", "retrieveByType('semantic'", "retrieveByType('procedural'",
      "retrieveByType('episodic'", "retrieveByType('retrospective'", "retrieveByType('limiting_belief'",
      "retrieveByType('archetype_correction'", "retrieveByType('acceptance_failure'",
      'retrieveTaskRelevant(', 'retrieveByCue(', 'getProjectKnowledge(', 'getTriggeredProspective(',
      'retrieveUnknownHits(', 'retrieveNegativeHits('];
    ok(predicates.every(p => body.includes(p)), `全部检索谓词在册未动（${predicates.length} 条锚点）`);
    ok(/export function selectMemorySections\(sections: MemSection\[\], maxChars: number\): \{ kept: MemSection\[\]; omitted: MemSection\[\]; chars: number \}/.test(memSrc),
      'selectMemorySections 签名未动（取舍算法零回归）');
  }
}

// ══════════════════════════════════════════════════════════════════════
// M5 收口：build 标识的**派生一致性**（不再手抄轮次字面量）
//   病根与改法见 plans/improve/zx_20260912.md §M5 与 scripts/lib/rr-pins.ts。
//   ⚠ 本段 P6 / S3 读 `dist`，故 **tsup 必须先于本脚本**。
// ══════════════════════════════════════════════════════════════════════
async function m5(): Promise<void> {
  const ROOT = path.join(__dirname, '..');
  const SCRIPTS = path.join(ROOT, 'scripts');
  const SRC = path.join(ROOT, `${A}/src/main/core/agent-executor.ts`);
  const DIST = path.join(ROOT, `${A}/dist`);
  const PLANS = path.join(ROOT, 'plans/improve');
  const realSrc = fs.readFileSync(SRC, 'utf-8');
  const { tag } = deriveBuildTag(realSrc);

  // 收集式 ok：把 checkBuildPins 的播报收进内存，供"点名某一条判据"用
  const collect = () => {
    const rec: Array<{ cond: boolean; label: string; detail: string }> = [];
    return { rec, sink: (cond: boolean, label: string, detail?: string) => { rec.push({ cond, label, detail: detail ?? '' }); } };
  };

  // 夹具字面量刻意经 q() 拼接：夹具是**数据**，不是本扫描器要核的"钉子"。
  // 直接写死会让本脚本自身被扫成"残留钉子"（S3/S5 必红）——这是"扫全量"的必然代价，如实处理，不为此放宽扫描面。
  const q = (s: string) => "'" + s + "'";

  console.log('\n[M5/S1 派生化：真源码单一真源 + 人造双值必被计数]');
  {
    const d = deriveBuildTag(realSrc);
    ok(d.count === 1 && d.tag === tag, `真源码 build 轮次标识恰好 1 处（${d.tag}）`, `count=${d.count}`);
    eq(deriveBuildTag(`const a = { build: ${q('zx_19000101')} };\nconst b = { build: ${q('zx_20000202')} };\n`).count, 2,
      '人造"陈旧第二值"源 → count=2（计数判据非空转）');
  }

  console.log('\n[M5/S2 扫描器：真钉认得出、注释与自轮常量不误认、行号可定位]');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-pins-scan-'));
    fs.writeFileSync(path.join(tmp, 'rr_fixture_ok.ts'), [
      `const ROUND = ${q('zx_11010101')};`,            // L1 前向钉（真钉）
      `const PREV_ROUND = ${q('zx_10990101')};`,       // L2 自轮常量 → 词界豁免
      `// ok(/build: ${q('zx_20990101')}/.test(x));`,  // L3 注释里的假钉 → 必须不计
      `ok(/build: ${q('zx_11010101')}/.test(x));`,     // L4 前向钉
      `ok(!/build: ${q('zx_10990102')}/.test(x));`,    // L5 反向钉
    ].join('\n') + '\n');
    const pins = scanBuildPins(tmp, tmp);
    eq(pins.map(p => [p.line, p.kind, p.value]),
      [[1, 'forward', 'zx_11010101'], [4, 'forward', 'zx_11010101'], [5, 'reverse', 'zx_10990102']],
      '只认真钉：行号 / 前反向 / 取值全对');
    ok(!pins.some(p => p.value === 'zx_20990101'), '注释里的假钉未被计入（防假阳性）');
    ok(!pins.some(p => p.value === 'zx_10990101'), '自轮常量 PREV_ROUND 未被计入（词界豁免）');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n[M5/S3 全量现状：P1–P6 全绿（8 条判据，含产物同值）]');
  {
    const { rec, sink } = collect();
    checkBuildPins(sink, { distDir: DIST });
    eq(rec.length, 8, 'P1–P6 共 8 条判据在册');
    ok(rec.every(r => r.cond), 'P1–P6 全绿', rec.filter(r => !r.cond).map(r => `${r.label}：${r.detail}`).join('｜'));
    ok(rec.some(r => r.label.includes('产物内 build 值与源码同值')), '其中含"产物 build 值与源码同值"（真源已烧进产物）');
  }

  console.log('\n[M5/S4 反证非空转：改一处即红，且点名 file:line]');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-pins-bad-'));
    // (a) 人造双值源 → P1 必须红
    const badSrc = path.join(tmp, 'synthetic-executor.ts');
    fs.writeFileSync(badSrc, `const a = { build: ${q('zx_19000101')} };\nconst b = { build: ${q('zx_20000202')} };\n`);
    const a = collect();
    checkBuildPins(a.sink, { rootDir: tmp, srcPath: badSrc, scriptsDir: tmp, plansDir: PLANS });
    const p1 = a.rec.find(r => r.label.includes('恰好 1 处'));
    ok(!!p1 && p1.cond === false, '人造双值源 → P1「恰好 1 处」判红', p1 ? p1.detail : '(未播报)');

    // (b) 前向钉取值不对 → P5 前向必须红，且 detail 点名 file:line
    fs.writeFileSync(path.join(tmp, 'rr_fixture_bad.ts'), `ok(/build: ${q('zx_11010101')}/.test(x));\n`);
    const b = collect();
    checkBuildPins(b.sink, { rootDir: tmp, srcPath: SRC, scriptsDir: tmp, plansDir: PLANS });
    const p5f = b.rec.find(r => r.label.includes('全量前向钉均等于真源'));
    ok(!!p5f && p5f.cond === false && p5f.detail.includes('rr_fixture_bad.ts:1'),
      '取值不对的前向钉 → P5 判红并点名 file:line', p5f ? p5f.detail : '(未播报)');

    // (c) 反向钉被写成真源值 → P5 反向必须红
    fs.writeFileSync(path.join(tmp, 'rr_fixture_bad.ts'), `ok(!/build: '${tag}'/.test(x));\n`);
    const c = collect();
    checkBuildPins(c.sink, { rootDir: tmp, srcPath: SRC, scriptsDir: tmp, plansDir: PLANS });
    const p5r = c.rec.find(r => r.label.includes('全量反向钉均不等于真源'));
    ok(!!p5r && p5r.cond === false, '反向钉写成真源值 → 反向判据判红', p5r ? p5r.detail : '(未播报)');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n[M5/S5 字面量清零：rr 脚本里不再有待维护的轮次字面量]');
  {
    eq(listStrayPinLiterals(SCRIPTS, ['rr_zx_20260909_fixes.ts'], ROOT), [],
      '除历史负钉外，rr 脚本无任何 build 轮次字面量（下一轮开新轮只需改源码一处）');
    const all = scanBuildPins(SCRIPTS, ROOT);
    eq(all.length, 1, '全量 rr 脚本仅剩 1 处钉');
    eq([all[0]!.kind, path.basename(all[0]!.file)], ['reverse', 'rr_zx_20260909_fixes.ts'],
      '该处即 09_fixes 的历史负钉（反向；其"钉格式不钉轮次"的改法正是本轮的先例）');
    ok(all[0]!.value !== tag, '历史负钉取值非本轮（不会与本轮真源混淆）');
  }

  console.log('\n[M5/S6 接线在册：派生模块被 9 个脚本真实调用（防"写了没用上"）]');
  {
    ok(fs.existsSync(path.join(SCRIPTS, 'lib/rr-pins.ts')), 'scripts/lib/rr-pins.ts 在位');
    const wired = [
      'rr_zx_20260910_3_b5.ts', 'rr_zx_20260910_5.ts', 'rr_zx_20260910_6.ts',
      'rr_zx_20260911_1.ts', 'rr_zx_20260911_2.ts', 'rr_zx_20260911_3.ts',
      'rr_zx_20260911_4.ts', 'rr_zx_20260911_5.ts', 'rr_zx_20260912.ts',
    ];
    const missing = wired.filter(f => !RD(`scripts/${f}`).includes("from './lib/rr-pins.js'") || !RD(`scripts/${f}`).includes('checkBuildPins('));
    eq(missing, [], `9 个脚本均已 import 且调用 checkBuildPins（实测 ${wired.length - missing.length}/${wired.length}）`);
    ok(realSrc.includes('rr 侧**不再手抄本行值**'), '源码写值处已就地注明"rr 侧不再手抄本行值"（纪律随真源同处）');
  }
}

/** 递归列出目录下所有 `.ts`（跳过 node_modules / dist）。 */
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * `wa_im_channels` 的**读**谓词（行保持式去注释后逐行看）：
 * 含表名 + `status` 参与比较，且**不是**写语句（`UPDATE … SET status` / `INSERT INTO …`）。
 * 命中即"绕过真源手抄口径"。
 */
const IM_STATUS_READ_RE = /wa_im_channels/;
const IM_STATUS_CMP_RE = /status\s*(?:IN\s*\(|=|!=|<>)/;
function imStatusReadViolations(root: string, files: string[]): string[] {
  const bad: string[] = [];
  for (const f of files) {
    stripKeepingLines(fs.readFileSync(f, 'utf-8')).forEach((line, i) => {
      if (!IM_STATUS_READ_RE.test(line) || !IM_STATUS_CMP_RE.test(line)) return;
      if (/SET\s+status|INSERT\s+INTO/.test(line)) return;
      bad.push(`${path.relative(root, f)}:${i + 1}`);
    });
  }
  return bad;
}

/**
 * **变量中转**的读谓词（G7 后加严）。旧判据要求"表名与之同行"，故
 * `const dbStatus = ch.status; … dbStatus === 'active'` 这类**抽出到局部变量**再比较的读点漏网——
 * `im:diagnose` 的「渠道状态」正是如此（`SELECT * FROM wa_im_channels` 在几行之前，比较那行只剩变量名）。
 * 判据盯**裸标识符**与旧口径字面量的比较，且**只审"读该表"的文件**（含 `FROM wa_im_channels`）。
 *
 * 为何要**按文件**限定：裸标识符比较 `x === 'running'` 在本仓是**任务/项目/作业**状态的通用写法
 * （实测 `ai-task.ts:329` 的 `curStatus`、`project.ipc.ts:669` 的 `status` 都是任务状态）——
 * 若不限定，判据会先变成狼来了，再被人关掉。限定到"读该表的文件"后，本仓恰好只余 im.ipc.ts 一处。
 *
 * 两条已知边界（**不在本判据覆盖内**，仍靠 S2 站点清单点名与人工审视）：
 *   · 成员表达式 `ch.status === 'active'`——`(?<![.\w$])` 已排除，因 `x.status` 同样是全仓通用写法；
 *   · 渠道状态被当参数传进**不读该表**的文件后比较——该文件不含表名，不被纳入审查。
 */
const IM_STATUS_TABLE_READ_RE = /FROM\s+wa_im_channels\b/;
const IM_STATUS_VAR_CMP_RE = /(?<![.\w$])[A-Za-z_$][\w$]*\s*(?:===|!==|==|!=)\s*'(?:active|running)'/;
function imStatusVarCompareViolations(root: string, files: string[]): string[] {
  const bad: string[] = [];
  for (const f of files) {
    const lines = stripKeepingLines(fs.readFileSync(f, 'utf-8'));
    if (!lines.some(l => IM_STATUS_TABLE_READ_RE.test(l))) continue;
    lines.forEach((line, i) => {
      if (IM_STATUS_VAR_CMP_RE.test(line)) bad.push(`${path.relative(root, f)}:${i + 1}`);
    });
  }
  return bad;
}

/**
 * renderer（IMPage）内"**渠道对象**裸比字面量"的读点：`ch`＝列表行、`cur`＝兜底轮询取回的行。
 * G8 前，渠道状态在界面侧是**三处各自手抄的清单**（徽标映射 / 启停按钮显隐 / 扫码收口），
 * 本判据即盯它们——四处决定归词表后应为空集。
 * 已知边界（明写，不冒充全覆盖）：
 *   · 不收 `event.status` 载荷（其比较已由词表承担，S7 有点名断言）；
 *   · 不收 `q.status` 的 'expired'/'error'/'unsupported'——那是 **im:getQr 端点自己的**状态词表
 *     （同形不同义，'error' 二者同拼写），归 QR 契约而非渠道词表。
 */
const chanObjCmp = (src: string): string[] =>
  [...src.matchAll(/\b(?:ch|cur)\.status\s*(?:===|!==|==|!=)\s*'/g)].map(m => m[0]!);

async function m6(): Promise<void> {
  // M6（外部独立核实后订正）：`wa_im_channels.status` 的**读口径归一处真源**。
  // 病根：M1 让运行期开始落 degraded/pending/error，而各处手抄的 `status IN ('active','running')`
  // 是 M1 **之前**「启用中」的代理谓词 ⇒ 静默收窄成「健康中」⇒ 降级/失败渠道被排除：
  //   通知目标解析 return（连 outbox 都不落，反噬 M3「未送达须记因」）／启动恢复集漏渠（重启后网关静默缺失）。
  // 而 295 条断言全绿——因为只钉了内存版那一处，SQL 版零断言。本段补上"读取谓词穷举"这把尺。
  const ROOT = path.join(__dirname, '..');
  const MAIN = path.join(ROOT, `${A}/src/main`);
  const SCOPE = `${A}/src/main/core/im/im-channel-status.ts`;
  const mainFiles = walkTs(MAIN);

  console.log('\n[M6/S1 真源唯一：谓词字面量在 src/main 全树恰好 1 处]');
  {
    const hits: string[] = [];
    for (const f of mainFiles) {
      stripKeepingLines(fs.readFileSync(f, 'utf-8')).forEach((line, i) => {
        if (line.includes("status IS NOT 'inactive'")) hits.push(`${path.relative(ROOT, f)}:${i + 1}`);
      });
    }
    ok(hits.length === 1, `谓词字面量恰好 1 处（防"又滚成手抄"）`, `实测 ${hits.length} 处：${hits.join(' ') || '(未找到)'}`);
    ok(hits.length === 1 && hits[0]!.startsWith(`${SCOPE}:`), '该处即真源模块 core/im/im-channel-status.ts');
  }

  console.log('\n[M6/S2 六处站点：均引用真源 · 旧谓词清零（逐处点名，证"决定"非"漏改"）]');
  {
    const sites: Array<[string, number, string]> = [
      [`${A}/src/main/core/im/im-notify.ts`, 1, '通知目标解析（排除即静默丢，连 outbox 不落）'],
      [`${A}/src/main/index.ts`, 2, 'ask_user 渠道解析（两条谓词：该用户会话优先 + 按类型回落）'],
      [`${A}/src/main/ipc/admin.ipc.ts`, 1, 'Dashboard 渠道计数'],
      [`${A}/src/main/ipc/im.ipc.ts`, 1, '启动恢复集（漏则重启后网关静默缺失）'],
      [`${A}/src/main/core/architectural-invariants.ts`, 1, '同类型重复在用（旧谓词令该不变量恒不触发）'],
    ];
    for (const [file, want, what] of sites) {
      const code = stripKeepingLines(RD(file)).join('\n');
      const got = [...code.matchAll(/imChannelEnabledSql\(/g)].length;
      ok(got === want, `${file} 引用真源 ${want} 处 — ${what}`, `实测 ${got} 处`);
      ok(/import\s*\{[^}]*imChannelEnabledSql[^}]*\}\s*from\s*'[^']*im-channel-status\.js'/.test(code),
        `${file} 经 import 引入同一真源模块（防"同名局部拼串"）`);
    }
    eq(imStatusReadViolations(ROOT, mainFiles), [],
      '全 src/main 树无"表名同行"的绕过真源读谓词（含旧 `IN (\'active\',\'running\')` / `= \'active\'`）');
    eq(imStatusVarCompareViolations(ROOT, mainFiles), [],
      '读该表的文件里无"经局部变量中转后与旧口径比较"的读谓词（G7 类：抽出 ch.status 再判 active/running）');
    // G7：诊断项「渠道状态」**只答一致性**（记录 vs 实况），不得再用旧口径判"是否健康"——
    // 否则 degraded/pending 渠道在"记录与实况一致"时反被判 ❌（本项要确认的正是这件事）。
    const ipcDiagnose = stripKeepingLines(RD(`${A}/src/main/ipc/im.ipc.ts`)).join('\n');
    ok(/check: '渠道状态', pass: !diverged/.test(ipcDiagnose),
      '「渠道状态」＝只判一致性（pass: !diverged），不再叠加旧口径 `=== \'active\' || === \'running\'`');
    ok(/adapterStatus !== dbStatus/.test(ipcDiagnose),
      '该判定的事实源仍是"DB 记录 vs 适配器实况"（未换尺子：不是改成"看适配器是否 running"这类）');
    const inv = stripKeepingLines(RD(`${A}/src/main/core/architectural-invariants.ts`)).join('\n');
    ok(!/wa_im_channels\s+WHERE\s+status\s*=\s*'active'/.test(inv),
      '「同类型重复」不变量不再用 `status = \'active\'`（该值现义＝"启用但无适配器"，对在跑实例恒不触发）');
  }

  console.log('\n[M6/S3 反证非空转：人造旧谓词 → S1/S2 同一把尺必红]');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-im-scope-'));
    const bad = path.join(tmp, 'stale.ts');
    fs.writeFileSync(bad, [
      "const a = db.prepare(\"SELECT id FROM wa_im_channels WHERE status IN ('active','running')\").all();",
      "const b = db.prepare(\"SELECT COUNT(*) FROM wa_im_channels WHERE status = 'active'\").get();",
      "const c = db.prepare('UPDATE wa_im_channels SET status = ? WHERE id = ?').run(s, id);",
      "const d = db.prepare(`SELECT id FROM wa_im_channels WHERE ${imChannelEnabledSql()}`).all();",
      "const dbStatus = (ch.status as string) || 'unknown';",
      "const stale = dbStatus === 'active' || dbStatus === 'running';",
    ].join('\n') + '\n');
    eq(imStatusReadViolations(ROOT, [bad]).map(v => path.basename(v)),
      ['stale.ts:1', 'stale.ts:2'],
      '两条"表名同行"的手抄读谓词被判红；写语句与"引真源"的行不误报（判据真在判、且不空转）');
    eq(imStatusVarCompareViolations(ROOT, [bad]).map(v => path.basename(v)),
      ['stale.ts:6'],
      'G7 类（抽出 ch.status 成局部变量再判 active/running）在同一把尺下被判红（旧判据看不见它）');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n[M6/S4 行为面：谓词空值安全 + 恢复集口径含"非健康但未停用"]');
  {
    const scope = stripKeepingLines(RD(SCOPE)).join('\n');
    ok(/const ENABLED = "status IS NOT 'inactive'"/.test(scope),
      '用 IS NOT（空值安全）：DDL 该列无 NOT NULL，`!=` 会把 NULL 行整行滤掉');
    const ipc = stripKeepingLines(RD(`${A}/src/main/ipc/im.ipc.ts`)).join('\n');
    ok(/adapter\.getStatus\(\) !== 'inactive'/.test(ipc), '在跑适配器筛选＝非 inactive（error/pending 也纳入）');
    ok(!/function getActiveChannels/.test(ipc), '旧名 getActiveChannels 已改名 getEnabledChannels（名实相符）');
    ok(/startF3NotificationPush\(db, getEnabledChannels\)/.test(ipc), 'F3 推送已接线到新函数（防"改了名没接上"）');
    ok(/channel_type IN \('wechat-personal','dingtalk','qqbot','feishu','wecom'\) AND \$\{imChannelEnabledSql\(\)\}/.test(ipc),
      '启动恢复集＝渠道类型白名单 ＋ 启用中（degraded/error 不再漏）');
  }

  console.log('\n[M6/S6 行为面（生产入参）：degraded/error 渠道仍被解析为通知目标——旧谓词下此处静默 return]');
  {
    const db = mkdb();
    // 生产入参：真库那条渠道（wechat-personal ＋ 真用户），只把 status 换成 M1 起才会出现的运行态值。
    db.prepare('INSERT INTO wa_im_channels (id, channel_type, name, status) VALUES (?,?,?,?)')
      .run(REAL_CHANNEL, 'wechat-personal', REAL_CHANNEL_NAME, 'degraded');
    db.prepare('INSERT INTO wa_im_channels (id, channel_type, name, status) VALUES (?,?,?,?)')
      .run('c-dingtalk', 'dingtalk', '钉钉', 'error');
    // GUI 建任务的常态：context_json 无 origin channel ⇒ 走"最近一条 1:1 私聊 inbound"回落
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES ('t-gui','p1','GUI任务','completed','{}')").run();
    db.prepare("INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, created_at) VALUES ('v1', ?, ?, '{\"chat_type\":\"direct\"}', 'inbound', '2026-09-12 10:00:00')")
      .run(REAL_CHANNEL, REAL_USER);

    const { resolveImNotifyTargets } = await import('../apps/worker-ant-desktop/src/main/core/im/im-notify.js');
    const targets = resolveImNotifyTargets(db, 't-gui', true);
    eq(targets.map(t => [t.channelId, t.externalUserId]), [[REAL_CHANNEL, REAL_USER]],
      'degraded 渠道被解析为唯一通知目标（这正是 G1 的静默丢弃点）');

    // 反证非空转：同一夹具上跑**旧谓词**，候选集为空 ⇒ 目标解析必 return 0 条、连 outbox 都不落。
    const old = db.prepare("SELECT COUNT(*) as c FROM wa_im_channels WHERE status IN ('active','running')").get() as { c: number };
    eq(old.c, 0, '同一夹具下旧谓词候选数 = 0（证明上面那条断言不是恒真：旧口径确会静默丢）');
  }

  console.log('\n[M6/S5 名下无虚：字段/标签/口径同名一义]');
  {
    const adm = stripKeepingLines(RD(`${A}/src/main/ipc/admin.ipc.ts`)).join('\n');
    ok(/enabledChannels: enabled\.c/.test(adm), 'admin:health 返回 enabledChannels（原 activeChannels 与口径不符）');
    const dash = RD(`${A}/renderer/src/pages/DashboardPage.tsx`);
    ok(/enabledChannels: number/.test(dash), 'renderer HealthData 类型同步改名（接口参数一致，防"改了 main 没改 renderer"）');
    ok(/label:'已启用渠道',value:health\?\.enabledChannels/.test(dash), 'Dashboard 标签改「已启用渠道」并取新字段');
    ok(!/activeChannels/.test(adm + dash), 'admin.ipc/DashboardPage 无 activeChannels 残留（口径字段名）');
    // N1（收口后复核修）：上面那条断言的**覆盖面比名字窄**——同一概念名「活跃」在渠道域另有三处存活，
    // 且其中不变量文案是 user-visible（DashboardPage 诊断页渲染 description/detail/guidance）。
    const inv = stripKeepingLines(RD(`${A}/src/main/core/architectural-invariants.ts`)).join('\n');
    ok(!/活跃实例/.test(inv), '不变量文案不再称「活跃实例」（谓词已是「启用中」，名实须相符）');
    ok(/已启用实例/.test(inv) && /imChannelEnabledSql\(\)/.test(inv),
      '改后＝「已启用实例」且谓词仍引真源（防"只改文案"或"只改口径"两向空转）');
    const router = stripKeepingLines(RD(`${A}/src/main/services/im-router.ts`)).join('\n');
    // zx_20261003 M9 就地改钉：F3 段（含注入端口声明）搬入 `services/f3-notification-push.ts`（im-router 仅再导出）。
    //   负向并入 F3 文件（旧名不得在任何一处存活，覆盖面比原先**更宽**）；正向指向端口**现居**的 F3 文件。
    const f3push = stripKeepingLines(RD(`${A}/src/main/services/f3-notification-push.ts`)).join('\n');
    ok(!/getActiveChannels/.test(router + f3push),
      'F3 注入端口名归正 getActiveChannels → getEnabledChannels（M6 只改了生产者 im.ipc，漏了端口/参数名）');
    ok(/getEnabledChannels: \(\) =>/.test(f3push), '正向：端口/参数名确为 getEnabledChannels（防只删不补）——端口声明现居 `f3-notification-push.ts`（**M9 就地改钉**）');
    // 已知边界（不冒充全覆盖）：本判据**不**作全仓「活跃」禁用——「活跃项目/活跃任务」（wa_projects/wa_tasks）、
    // 项目「活跃度/活跃时段」与运行中适配器实例（im.ipc 的 activeAdapters「活跃的 IM 适配器实例」）均为**别义**，
    // 合法且普遍；故只按渠道域站点逐个点名，不用裸词全仓扫描（否则先变狼来了）。
  }

  console.log('\n[M6/S7 跨进程词表同尺（G8）：main 会落的每个 status ⇒ renderer 词表必须已"决定"]');
  {
    // 病根：M6 把 **main 侧**读口径归了一处真源，但 renderer 拿不到那条 SQL 谓词（跨进程、且那里只有裸 status 字符串），
    // 于是"渠道状态词表"在界面侧又是**三处各自手抄的清单**（徽标映射 / 启停按钮显隐 / 扫码收口）。
    // 后果不是观感问题：`starting` 因三处都漏而**两个按钮皆无**——而 starting 确会落库
    // （五家 adapter 启动即 `report('starting')`；feishu 握手未成时**一直停在** starting，onReady 才转 running）
    // ⇒ 卡在 starting 的渠道，用户在界面上**无任何手段可干预**（既不能停、也不能强制重启）。
    // ⇒ 本段把 renderer 侧也纳入同一把尺：词表唯一（一张 Record 表）＋ 取值全集与 main 落库取值交叉核对。
    const landed = new Set<string>();
    // 来源①：适配器运行期上报 `this.report('<status>'…)`。
    for (const f of walkTs(path.join(MAIN, 'services'))) {
      for (const m of stripKeepingLines(fs.readFileSync(f, 'utf-8')).join('\n').matchAll(/this\.report\(\s*'([^']+)'/g)) landed.add(m[1]!);
    }
    // 来源②：im.ipc.ts 直接写库（'inactive'=用户停用、'active'=无适配器渠道的兜底标记）。
    const ipcSrc7 = stripKeepingLines(RD(`${A}/src/main/ipc/im.ipc.ts`)).join('\n');
    for (const m of ipcSrc7.matchAll(/UPDATE\s+wa_im_channels\s+SET\s+status\s*=\s*'([^']+)'/gi)) landed.add(m[1]!);
    ok(landed.size >= 6, `main 侧落库取值抽到 ${landed.size} 个（非空转：抽取失效会在本条显形）`, [...landed].sort().join(','));
    ok(/UPDATE\s+wa_im_channels\s+SET\s+status\s*=\s*'inactive'/.test(ipcSrc7),
      'SQL 形态的抽取未失效（inactive 被抽到）——上一条的"≥6"不靠适配器单边凑数');

    const page = stripKeepingLines(RD(`${A}/renderer/src/pages/IMPage.tsx`)).join('\n');
    const unionSrc = /type\s+ChannelStatus\s*=\s*([^;]+);/.exec(page)?.[1] ?? '';
    const known = new Set([...unionSrc.matchAll(/'([^']+)'/g)].map(m => m[1]!));
    ok(known.size >= 6, `renderer 词表解析到 ${known.size} 个取值（同上，防"两边都解析为空 ⇒ 恒真"）`, [...known].sort().join(','));
    eq([...landed].filter(s => !known.has(s)).sort(), [],
      'main 会落的每个 status 都在 renderer 词表内（缺一个即"徽标错/无钮可点"——starting 曾如此）');
    // 只做**单向**核对：renderer 多认历史值（'stopped' 旧库可能存在）不构成缺陷。反向核对会变成维护负担。

    // 词表自身的纪律：TS 穷举（编译期）＋ 未收录兜底（运行期 fail-open）。
    ok(/const CH_STATUS_META:\s*Record<ChannelStatus,\s*ChannelStatusMeta>/.test(page),
      '词表以 `Record<ChannelStatus,…>` 声明 ⇒ 新增取值未作决定时 typecheck 直接红（已实证：加 \'future_state\' ⇒ TS2741）');
    ok(/CH_STATUS_META\[s as ChannelStatus\]\s*\?\?\s*UNKNOWN_STATUS_META/.test(page),
      '未收录取值走「未知状态」兜底且两钮皆给（不冒充「已停止」＝假话；与 main 侧"非 inactive 即试一次"同一失败方向）');

    // 四处消费点逐个点名（G7 教训：判据必须能看见"值经成员访问/局部变量中转"的形态）。
    ok(/statusMeta\(String\(event\.status \?\? ''\)\)\.qrClose/.test(page), '扫码事件收口走词表 qrClose（含 ok/fail 两态）');
    ok(/statusMeta\(cur\.status\)\.qrClose\s*===\s*'ok'/.test(page), '扫码兜底轮询同尺（此前此处多认一个 \'active\'——两处清单不一致）');
    ok(/const sm\s*=\s*statusMeta\(ch\.status\)/.test(page), '渠道行只取一次词表（徽标/启停/说明色共用同一份决定）');
    ok(/sm\.start&&/.test(page) && /title=\{sm\.start\}/.test(page),
      '「启动」按钮的显隐与措辞同出词表**一个字段**（有值即显示）——无从"显示了却忘记写措辞"');
    ok(/sm\.stop&&/.test(page), '「停止」按钮显隐同出词表');
    ok(/sm\.alarm\?/.test(page), '状态说明行告警色同出词表');
    eq(['label', 'cls', 'start', 'stop', 'alarm', 'qrClose'].filter(f => !new RegExp(`\\.${f}\\b`).test(page)), [],
      '词表六个字段均有消费点（无"加了字段没人读"的半拉子）');

    // 裸比：只盯**渠道对象**（ch=列表行 / cur=轮询取回的行）上的字面量比较（边界见 chanObjCmp 注释）。
    eq(chanObjCmp(page), [], 'IMPage 内无"渠道对象裸比字面量"的读点（四处决定已全部归词表）');
    // 反证非空转：同一把尺跑在 **G8 前的三处旧手抄清单**上必红——否则判据只是"恰好绿"。
    const PRE_G8 = [
      "{(ch.status==='inactive'||ch.status==='stopped'||ch.status==='error'||ch.status==='degraded')&&<button onClick={()=>handleStart(ch.id)}",
      "{(ch.status==='active'||ch.status==='running'||ch.status==='pending'||ch.status==='degraded')&&<button onClick={()=>handleStop(ch.id)}",
      "if(cur&&(cur.status==='running'||cur.status==='active')){ closeQr(); setChannels(list); return; }",
    ].join('\n');
    eq(chanObjCmp(PRE_G8).length, 10,
      'G8 前三处旧清单在同一把尺下被判红 10 处（启停各 4 条 + 扫码 2 条）——证明判据真在判');
    ok(!chanObjCmp(PRE_G8).some(s => s.includes("'starting'")),
      '旧清单里 starting 一次都没出现（正是"两钮皆无"的成因：不是判错，是没人写它）');
  }
}

async function main(): Promise<void> {
  console.log('=== rr_zx_20260912 受控复跑 ===');
  await m0();
  await m1();
  await m2();
  await m3();
  await m4();
  await m5();
  await m6();
  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}
void main();
