/**
 * zx_20261002 受控复跑 —— 「看得见、拆得动、学得会、配得上」。
 *
 * 本轮口径（方案 §0）：**接线了却零发生的，不算实现**。判据只认三件事之一——
 * 真跑生产实现、按语句形状钉接线那一跳、或反证旧路径仍在（证"没接上"）。
 *
 * 分组（方案 §2/§3，随里程碑推进增补）：
 *   A · M1 IM 跨页提醒可达（通道判据三态 · 文案派生 · 载荷补件 · 门控出口）
 *   B · M2 未读按会话归零（按渠道水位 · 全部已读覆盖已标渠道 · 回落全局 · 显示端不自算）
 *   C · M3 回话对象显式（四象限 · 不回落列表头 · 每行可达 · 出站契约不变）
 *   D · M4 会话区读得舒服（去写死高度 · 方向标注上屏 · 序未变）
 *   E · M5 到点即拆 + M6 三路同源（真跑生产实现 · 门未过则零 HTTP）
 *   F · M7 拆解溯源可见（引擎路三闸派生 · 徽标上屏 · 产物内中文串 · 两路并存）
 *   G · M8 依赖账实（① 悬空前置留痕一次性 · ② 子串匹配改精确解析 · ③ 一处派生规则三层边界）
 *   H · M13 可用性备用不回验（裁定落进注释 · 零行为变更 · 与降级路成对照）
 *   J · M9 记忆原料与三闸可达（真 MemoryManager 计数 0→1 · 门槛从源码派生 · 相对名次支 · 逐段字节账）
 *   K · M10 成功拆解质量门台账（生成 0→1 · 质量门未放宽两只标本 · 上游漏斗卡点 · 一处真源三层 · 上屏）
 *   L · M11 项目调用记账（真源表写 0→1 · 只读 · 三写点接线 · import 面恰五处[zx_20261003 M5 加知识综合一处] · 夹具=生产 DDL · 上屏）
 *   M · M12 自优化闭环（复验闭环 · 熔断键归一 · 留档"变才写" · 第六态上屏）
 *   N · M15 附件按族派生能力需求（表穷举 · video 真触发 · 回归面 · 端到端派生 · 一处真源 · audio 分路登记）
 *   O · M16 列存在性判据（生产 DDL 建库核列 · 可证伪两侧 · 两处真死查询真跑 0→1）
 *   P · M17 工具规则对齐（先读后改门禁真跑 · 新建文件不判死 · 编码闸一处真源 · GBK 不再误判）
 *   I · 哑雷专项 + build 钉
 *
 * §判据纪律（逐条对上本仓 auto-memory）：
 *   G-1 **用生产函数、不自造等价实现**：本文件直 import 生产纯模块（`lib/im-reminder.ts` 同 `convDelivery.ts` 之形）。
 *   G-2 **每条判据都能被合法数据满足**，且**有区分度**：正反两侧各给一只真标本。
 *   G-5 静态判据一律读**原文**（不去注释）——锚点钉**符号/语句形状**；「块内零处 X」须自证块非空。
 *   G-6 **无轮次字面量**：不改 `build`；轮次相关定位一律由 `path.basename(__filename)` 派生。
 *
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins } from './lib/rr-pins.js';
// A · M1：通道判据/文案派生一律调**生产导出**（G-1：不自造一份等价实现再拿它自证）
import {
  imReminderChannel, isImRoute, imInboundNotice, formatBytes,
} from '../apps/worker-ant-desktop/renderer/src/lib/im-reminder.js';
// B · M2：未读账**真实现**（模块 electron-free ⇒ rr 直跑生产函数，不切 handler 源码）
import {
  computeImUnread, markImRead, setImUnreadSink,
} from '../apps/worker-ant-desktop/src/main/core/im/im-unread.js';
// C · M3：收件人判定**真实现**（纯函数 ⇒ rr 直跑，不切 `IMPage` 源码；先例 `convDelivery.ts`）
import { resolveReplyPeer, replyPeerNotice } from '../apps/worker-ant-desktop/renderer/src/lib/reply-peer.js';
// E · M5/M6：到点即拆的**真实现**（`ai-task` 的 electron-free 面 ⇒ rr 直跑；直 import 先例 rr_zx_20260915）
import { tryAutoDecomposeAtStart } from '../apps/worker-ant-desktop/src/main/core/jobs/ai-task.js';
import { loadDecompositionPatterns } from '../apps/worker-ant-desktop/src/main/core/task-decompose.js';
import { PAUSE_REASON_CHILDREN_INCOMPLETE } from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';
// G · M8：依赖账实的**真实现**（`warnDepsUnresolved` 直跑内存库、`analyzeBlockers` 直跑、`parseDepIds` 是与调度器同一把尺）
import { warnDepsUnresolved } from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import { parseDepIds } from '../apps/worker-ant-desktop/src/main/core/dep-graph.js';
import { analyzeBlockers } from '../apps/worker-ant-desktop/src/main/core/project-analytics.js';
// J · M9：记忆三闸的**真实现**（真 `MemoryManager` × 内存库；门槛/谓词一律从源码**派生**，不手抄）
import * as memMod from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
import { buildMemoryContext } from '../apps/worker-ant-desktop/src/main/core/memory-context.js';
// K · M10：成功拆解质量门台账（生成路与台账路**同一实现**；真跑内存库证 0→1 + 反证质量门未放宽）
import { autoCreateTemplatesFromSuccesses, describeAutoTemplateGates } from '../apps/worker-ant-desktop/src/main/core/task-templates.js';
// L · M11：调用记账真源（写 0→1 · 只读聚合 · 三类**都出栏**）——真跑生产实现，不切 handler 源码
import {
  recordServiceCall, describeServiceCalls, SERVICE_CALL_KINDS, SERVICE_CALL_KIND_LABEL,
} from '../apps/worker-ant-desktop/src/main/core/service-call-ledger.js';
// M · M12：自优化闭环（复验 · 熔断键归一 · 留档）——真跑生产实现；账本 DDL 取**生产导出**（同 M-g 先例）
import {
  tryHeal, runHealthScan, confirmPendingHeals, logHealing,
  PENDING_RECHECK_CONFIRM_MS, logHealthTransitions, logInvariantTransitions, SELF_HEALING_LOGS_DDL,
} from '../apps/worker-ant-desktop/src/main/core/self-healing-monitor.js';
import { HEAL_OUTCOMES, HEAL_OUTCOME_LABEL } from '../apps/worker-ant-desktop/src/main/core/healing-outcome.js';
// N · M15：附件按族派生能力需求（表=一处真源；判族/派生一律调**生产导出**，不自造等价实现）
import {
  attachmentsNeedVision, deriveModelCapabilities, buildModelRequest, ATTACHMENT_FAMILY_CAPABILITIES,
} from '../apps/worker-ant-desktop/src/main/core/model-request.js';
// O · M16：**列存在性**判据（生产 DDL 原文建库核列）+ 语句字面量抽出（真跑生产 SQL，不手抄一份）
import {
  buildSchemaFromSources, scanPreparedSql, extractPrepareLiterals, referencedTables, candidateColumns,
} from './lib/sql-columns.js';
// P · M17：工具规则对齐——「先读后改」门禁**真跑生产工具表**（`buildTools`，与生产同一装配点）；
//   编码闸一侧真跑 `validateOutput`（生产导出），不自造等价实现。
import { buildTools } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { validateOutput } from '../apps/worker-ant-desktop/src/main/core/output-validator.js';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string): void =>
  ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RD = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');

// ══════════════════════════════════════════════════════════════════
// 【A】M1 IM 跨页提醒可达
// ══════════════════════════════════════════════════════════════════
function groupA(): void {
  console.log('\n【A】M1 IM 跨页提醒可达（判据直跑生产纯函数 + 源码接线形状）');

  // A1 「该走哪条通道」三态 —— 四象限都要标本（只用"该提醒"的样本 ⇒ 任何过宽变体全票通过）
  eq(imReminderChannel({ visible: true, onImPage: true }), 'none', 'A1-a ★硬约束：可见且在 IM 页 ⇒ 不打扰');
  eq(imReminderChannel({ visible: true, onImPage: false }), 'toast', 'A1-b 可见但不在 IM 页 ⇒ 应用内 toast');
  eq(imReminderChannel({ visible: false, onImPage: true }), 'native', 'A1-c 不可见（即便在 IM 页）⇒ 原生横幅');
  eq(imReminderChannel({ visible: false, onImPage: false }), 'native', 'A1-d 不可见且不在 IM 页 ⇒ 原生横幅');

  // A2 路由判据 —— 反例含**前缀形似**（#/imx）以证不是松 startsWith（否则 #/imx 会被误判进 IM 页）
  ok(isImRoute('#/im'), 'A2-a #/im 是 IM 页');
  ok(isImRoute('#/im?conv=1'), 'A2-b 带查询串的 #/im 是 IM 页');
  ok(isImRoute('#/im/x'), 'A2-c 子路由 #/im/x 是 IM 页');
  ok(!isImRoute('#/imx'), 'A2-d ★前缀形似 #/imx **不是** IM 页（证非松匹配）');
  ok(!isImRoute('#/dashboard'), 'A2-e 非 IM 页');
  ok(!isImRoute(''), 'A2-f 空路由不是 IM 页');

  // A3 文案派生 —— 结构化字段进文案，缺字段**不编造**
  const text = imInboundNotice({ channelName: '客服一号', fromUser: '张三', preview: '你好在吗' });
  eq(text.title, '客服一号 · 张三', 'A3-a 标题 = 渠道名 · 发件人');
  eq(text.body, '你好在吗', 'A3-b 文本消息正文 = 预览');
  const media = imInboundNotice({ channelType: 'wechat', fromUser: '李四', kind: 'image', fileName: 'photo.png', sizeBytes: 2048, preview: '' });
  ok(media.body.includes('图片'), 'A3-c 媒体正文带类型标签');
  ok(media.body.includes('photo.png'), 'A3-d 媒体正文带件名');
  ok(media.body.includes('2.0 KB'), 'A3-e 媒体正文带大小');
  ok(imInboundNotice({}).title.includes('未知联系人'), 'A3-f ★字段缺失如实说"未知联系人"，不编造');
  eq(formatBytes(undefined), '', 'A3-g 大小缺失 ⇒ 空串（不写 0 B 冒充有值）');

  // A4 接线形状（读**原文**，不去注释；锚点钉语句形状）
  const layout = RD(`${A}/renderer/src/components/AppLayout.tsx`);
  ok(layout.includes('imReminderChannel') && layout.includes('showNotification'),
    'A4-a ① AppLayout 接线 `showNotification`（renderer 首个真调用点）且判据同源');
  const toast = RD(`${A}/renderer/src/lib/toast.tsx`);
  ok(toast.includes('imReminderChannel') && toast.includes("'/im'"),
    'A4-b ③ 可见不在 IM 页 → 应用内 toast，点击回 `/im`');

  const svc = RD(`${A}/src/main/core/notification-service.ts`);
  const svcFn = /export function showSystemNotification[\s\S]*?\n\}/.exec(svc)?.[0] ?? '';
  ok(svcFn.length > 200, 'A4-c ★扫描面自证：`showSystemNotification` 函数体非空（否则下面"含开关"是空转假绿）', `${svcFn.length} 字符`);
  ok(svcFn.includes('isEnabled') && svcFn.includes('ui_dnd'),
    'A4-d `notifications:show` 与任务通知**同一把尺**（读 `ui_system_notifications` + `ui_dnd`）');

  const ipc = RD(`${A}/src/main/ipc-handlers.ts`);
  const ipcBlock = /ipcMain\.handle\('notifications:show'[\s\S]*?\n  \}\);/.exec(ipc)?.[0] ?? '';
  ok(ipcBlock.length > 100, 'A4-e ★扫描面自证：`notifications:show` 处理器块非空', `${ipcBlock.length} 字符`);
  ok(!ipcBlock.includes('new Notification'), 'A4-f ★反证旧路径：处理器**不再**裸发 `new Notification`（接线即绕过开关的病根已除）');
  ok(ipcBlock.includes('showSystemNotification'), 'A4-g 处理器改走门控出口 `showSystemNotification`');

  const router = RD(`${A}/src/main/services/im-router.ts`);
  const payload = /emitTransient\('im\.message_inbound'[\s\S]*?\n    \}\);/.exec(router)?.[0] ?? '';
  ok(payload.length > 100, 'A4-h ★扫描面自证：入站瞬态载荷块非空', `${payload.length} 字符`);
  ok(payload.includes('channelName'), 'A4-i ② 载荷补 `channelName`');
  ok(payload.includes('fileName') && payload.includes('sizeBytes') && payload.includes('kind'),
    'A4-j ② 载荷补 件名 / 件大小 / 件类型');

  // A5 「恰一份实现」：通道判据只在 `im-reminder.ts` 定义一次，两个消费点都 import 它
  const defs: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${ent.name}`;
      if (ent.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(ent.name) && RD(rel).includes('export function imReminderChannel')) defs.push(rel);
    }
  };
  walk(`${A}/renderer/src`);
  eq(defs.length, 1, 'A5-a ★「一处实现」：全 renderer 恰有 1 处 `export function imReminderChannel`', defs.join(', '));
  eq(defs[0], `${A}/renderer/src/lib/im-reminder.ts`, 'A5-b 唯一定义落在 `lib/im-reminder.ts`');
}

// ══════════════════════════════════════════════════════════════════
// 【B】M2 未读按会话归零
// ══════════════════════════════════════════════════════════════════
type AnyDb = import('better-sqlite3').Database;

/** 夹具 schema：**照抄 database.ts 的 DDL**（列/DEFAULT 宽松即假绿）。 */
const M2_SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_im_conversations (
  id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, project_id TEXT,
  message_json TEXT DEFAULT '{}', direction TEXT DEFAULT 'inbound',
  created_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'sent', last_error TEXT DEFAULT '', outbox_id TEXT DEFAULT ''
);
`;

/** 取 `needle` 之后**第一对花括号**包起来的整段（函数体）。 */
function bodyOf(src: string, needle: string): string {
  const i = src.indexOf(needle);
  if (i < 0) return '';
  const b = src.indexOf('{', i);
  if (b < 0) return '';
  let d = 0;
  for (let j = b; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) return src.slice(b, j + 1); }
  }
  return '';
}

/** 摘注释：既去块注释也去整行注释（供"每处调用都传参"这类**语句形状**判据，免受注释里举例的干扰）。 */
const stripC = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 遍历目录下所有 `.ts`，对**原文**（不去注释）逐文件回灌：供全-src 计数类判据（"恰 1 处定义/恰 N 处调用"）。 */
function walkSrc(dir: string, fn: (relPath: string, src: string) => void): void {
  for (const ent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${ent.name}`;
    if (ent.isDirectory()) walkSrc(rel, fn);
    else if (/\.ts$/.test(ent.name)) fn(rel, RD(rel));
  }
}

/** 建夹具库：全局水位钉在 2020（否则首次缺省="此刻"，同秒插入的行 `created_at > since` 不成立、断言随机器飘）。 */
function mkM2Db(): AnyDb {
  const d = new DatabaseSync(':memory:') as unknown as AnyDb;
  d.exec(M2_SCHEMA);
  d.prepare("INSERT OR REPLACE INTO wa_settings (key, value) VALUES ('im_last_read_at', '2020-01-01 00:00:00')").run();
  return d;
}
const m2Inbound = (d: AnyDb, id: string, ch: string, at: string): void => {
  d.prepare("INSERT INTO wa_im_conversations (id, channel_id, direction, created_at) VALUES (?, ?, 'inbound', ?)").run(id, ch, at);
};

function groupB(): void {
  console.log('\n【B】M2 未读按会话归零（真实现 × 真库 · 显示端不自算）');

  // B1 两渠道各 1 条未读 ⇒ 2（0→2 正面断言；"计数器类断言须有值从 0 变 1"）
  const d1 = mkM2Db();
  ok(computeImUnread(d1) === 0, 'B1-a 空库未读为 0（基线）');
  m2Inbound(d1, 'a1', 'chA', '2021-01-01 00:00:01');
  ok(computeImUnread(d1) === 1, 'B1-b 一条入站 ⇒ 0→1（正面断言）');
  m2Inbound(d1, 'b1', 'chB', '2021-01-01 00:00:02');
  eq(computeImUnread(d1), 2, 'B1-c 两渠道各 1 条 ⇒ 合计 2');

  // B2 打开 chA ⇒ **只清 chA**（此前的病根：清一个渠道等于清全部）
  const seen: number[] = [];
  setImUnreadSink((n) => { seen.push(n); });
  eq(markImRead(d1, 'chA'), 1, 'B2-a 打开 chA ⇒ 未读 2→1（chA 归零）');
  eq(computeImUnread(d1), 1, 'B2-b 反证：chB 的未读**未被抹平**（打开 A 不影响 B，病根已除）');
  eq(seen, [1], 'B2-c markImRead 向显示端推**恰一次**，且推的是 main 算出的数（显示端不自算）');
  setImUnreadSink(null);
  ok((d1.prepare("SELECT COUNT(*) AS n FROM wa_settings WHERE key = 'im_read_at:chA'").get() as { n: number }).n === 1,
    'B2-d chA 的渠道水位**真落库**（`im_read_at:chA` 在册，非内存态）');
  ok((d1.prepare("SELECT COUNT(*) AS n FROM wa_settings WHERE key = 'im_read_at:chB'").get() as { n: number }).n === 0,
    'B2-e 反证：chB **无**渠道水位（从未被打开 ⇒ 回落到全局水位，历史不因此被算成未读）');

  // B3 从未打开过的渠道回落全局水位：早于全局水位的历史入站**不计**
  const d2 = mkM2Db();
  m2Inbound(d2, 'old', 'chC', '2019-01-01 00:00:00');
  eq(computeImUnread(d2), 0, 'B3 未打开过的渠道：早于全局水位的历史入站**不计**未读（回落语义）');

  // B4 ★「全部已读」必须**覆盖已在册的渠道水位**——否则显式标记过的渠道会漏掉（UPDATE 分支的判别断言）
  const d3 = mkM2Db();
  // 手工把 chA 的渠道水位设在**过去**（不用 markImRead，因为它会写成"此刻"，无法再被"此刻"覆盖）
  d3.prepare("INSERT OR REPLACE INTO wa_settings (key, value) VALUES ('im_read_at:chA', '2020-06-01 00:00:00')").run();
  m2Inbound(d3, 'x1', 'chA', '2020-09-01 00:00:00'); // 晚于渠道水位(2020-06) ⇒ 计入
  eq(computeImUnread(d3), 1, 'B4-a 该条经**渠道水位**计入（晚于 im_read_at:chA，与全局水位无关）');
  eq(markImRead(d3), 0, 'B4-b 全部已读（无参）⇒ 未读归 0');
  ok((d3.prepare("SELECT value FROM wa_settings WHERE key = 'im_read_at:chA'").get() as { value: string }).value !== '2020-06-01 00:00:00',
    'B4-c ★「全部已读」把**已在册的渠道水位**一并推进（若删掉那条 UPDATE，此断言与 B4-b 同红）');

  // B5 无参/带参两条路都活：全读之后再按渠道归零仍然有效
  const d4 = mkM2Db();
  m2Inbound(d4, 'y1', 'chD', '2021-01-01 00:00:00');
  eq(markImRead(d4), 0, 'B5-a 全部已读 ⇒ 0');
  m2Inbound(d4, 'y2', 'chD', '2099-01-01 00:00:00'); // 远在后 ⇒ 一个"读之后到达"的确定性标本
  eq(computeImUnread(d4), 1, 'B5-b 全读之后又来 1 条 ⇒ 回到 1');

  // ── 静态：接线形状（读**原文**；锚点钉符号/语句形状；块内零处即自证块非空）──
  const unSrc = RD(`${A}/src/main/core/im/im-unread.ts`);
  const un = stripC(unSrc);
  ok(/CHAN_KEY = \(channelId: string\): string => `im_read_at:\$\{channelId\}`/.test(un),
    'B6-a 渠道水位键由**唯一一处** `CHAN_KEY` 派生（`im_read_at:<id>`）');
  const cu = bodyOf(un, 'export function computeImUnread(');
  ok(cu.length > 120, 'B6-b ★扫描面自证：`computeImUnread` 函数体非空', `${cu.length} 字符`);
  ok(/COALESCE\(\(SELECT value FROM wa_settings WHERE key = 'im_read_at:' \|\| c\.channel_id\), \?\)/.test(cu),
    'B6-c 未读额按**每渠道各自的水位**算，无该渠道水位则回落全局（COALESCE 同一条 SQL 内）');
  const mr = bodyOf(un, 'export function markImRead(');
  ok(mr.length > 120, 'B6-d ★扫描面自证：`markImRead` 函数体非空', `${mr.length} 字符`);
  ok(/if \(channelId\)/.test(mr) && /CHAN_KEY\(channelId\)/.test(mr), 'B6-e 带参 ⇒ 只写该渠道水位');
  ok(/UPDATE wa_settings SET value = \?, updated_at = datetime\('now'\) WHERE key LIKE 'im_read_at:%'/.test(mr),
    'B6-f ★无参（全部已读）⇒ 全局水位 + **已在册渠道水位一并推进**（两处同尺，缺一即 B4-c 红）');

  const ipcSrc = RD(`${A}/src/main/ipc/im.ipc.ts`);
  const markIpc = bodyOf(ipcSrc, "ipcMain.handle('im:markRead',");
  ok(markIpc.length > 60, 'B7-a ★扫描面自证：`im:markRead` 处理器块非空', `${markIpc.length} 字符`);
  ok(/ipcMain\.handle\('im:markRead', async \(_event, channelId\?: string\)/.test(ipcSrc)
    && /markImRead\(_dbForIm, typeof channelId === 'string'/.test(markIpc),
    'B7-b IPC 层收并透传 `channelId` 到唯一真源（renderer 只报"在看哪条"，不算未读）');
  ok(!/markImRead\(_dbForIm\)/.test(bodyOf(ipcSrc, "ipcMain.handle('im:unread',")),
    'B7-c 反证：只读通道 `im:unread` **不**走 markImRead（看一眼不产生副作用）');

  const rIpc = RD(`${A}/renderer/src/lib/ipc.ts`);
  ok(/markRead: \(channelId\?: string\) => ipcCall<\{ unread: number \}>\('im:markRead', channelId\)/.test(rIpc),
    'B8 renderer ipc 面 `markRead` 透传 `channelId`（签名与 main 对齐）');

  const pageSrc = RD(`${A}/renderer/src/pages/IMPage.tsx`);
  const page = stripC(pageSrc);
  ok(!/useEffect\(\(\) => \{ void im\.markRead\(\)\.catch\(\(\) => \{\}\); \}, \[\]\)/.test(page),
    'B9-a ★反证旧路径：IMPage **挂载不再清零**（打开 /im 停在渠道列表 ⇒ 红点仍在）');
  // zx_20261003 M12：该处 markRead 现**随后刷新逐渠道红点**（`…then(() => refreshUnreadByChannel()).catch(…)`）
  //   ——钉的是同一条更强的真源：仍**带渠道**清、且清完把红点账一并刷新（不是放宽，是钉住新形状）。
  ok(/void im\.markRead\(channelId\)\.then\(\(\) => refreshUnreadByChannel\(\)\)\.catch\(\(\) => \{\}\)/.test(page),
    'B9-b 打开**该渠道**对话 ⇒ 清该渠道未读，并随即刷新逐渠道红点（zx_20261003 M12 后仍**带渠道**、零无参）');
  ok(/document\.visibilityState === 'visible' && cid\) void im\.markRead\(cid\)/.test(page),
    'B9-c 窗口转回可见时，若正开着某渠道 ⇒ 只清**该渠道**');
  ok(/document\.visibilityState === 'visible' && cid === convChannelRef\.current\) \{[\s\S]{0,80}?im\.markRead\(cid\)/.test(page),
    'B9-d 正看着时新入站 ⇒ 仅当入站渠道**恰是当前打开的那个**才算看过（收窄，不再"任意渠道入站即清零"）');
  ok(!/im\.markRead\(\)/.test(page),
    'B9-e ★每处 `im.markRead` 调用都带渠道参数（**零处**无参调用 ⇒ 显示端不会误清全局）');

  const app = RD(`${A}/renderer/src/App.tsx`);
  ok(/im\.navigate/.test(app), 'B10 跨页跳转通道仍在（`im.navigate` ⇒ 跳 IM 页，未因本轮改动失落）');
}

// ══════════════════════════════════════════════════════════════════
// 【C】M3 回话对象显式（收件人**不随列表漂**）
// ══════════════════════════════════════════════════════════════════
function groupC(): void {
  console.log('\n【C】M3 回话对象显式（真实现四象限 · 反证旧路径 · 每行可达）');
  const one = [{ external_user_id: 'u1' }];
  // C1 四象限——每象限一只真标本；缺"已选却不在列"这一只，任何"回落列表"的变体都能全票通过
  eq(resolveReplyPeer('u9', one),
    { peer: 'u9', selected: true, missing: true },
    'C1-a ★已选定且**不在当前列表**（列表头是别人）⇒ 仍发 u9，只如实标 missing（**不许回落列表头**）');
  eq(resolveReplyPeer('u1', one),
    { peer: 'u1', selected: true, missing: false },
    'C1-b 已选定且在场 ⇒ 用它，missing 假');
  eq(resolveReplyPeer(null, [{ external_user_id: 'u1' }, { external_user_id: 'u2' }]),
    { peer: 'u1', selected: false, missing: false },
    'C1-c 未选定 ⇒ 取列表最新一条作**默认**（与既有"明写最新一条"同值）');
  eq(resolveReplyPeer(null, []),
    { peer: '', selected: false, missing: false },
    'C1-d 未选定且列表空 ⇒ 空串（界面据此禁用输入框，不编造收件人）');
  eq(resolveReplyPeer('', one),
    { peer: 'u1', selected: false, missing: false },
    'C1-e 空串视同**未选定**（falsy 分支）⇒ 仍落到列表头');
  eq(resolveReplyPeer(null, [{ external_user_id: null }, { external_user_id: 'u2' }]).peer, '',
    'C1-f 列表头条用户为空 ⇒ 收件人为空串（不拿下一条冒充最新）');

  // C2 提示只在"已选且不在列"时说——其余情形不啰嗦（否则满屏都是提示，等于没有提示）
  ok(replyPeerNotice(resolveReplyPeer('u9', one)) !== null, 'C2-a 已选但不在当前筛选结果 ⇒ 有如实提示');
  eq(replyPeerNotice(resolveReplyPeer('u1', one)), null, 'C2-b 已选且在列 ⇒ 无话可说（null）');
  eq(replyPeerNotice(resolveReplyPeer(null, one)), null, 'C2-c 未选定（默认最新一条）⇒ 无话可说（null）');

  // C3 「恰一份实现」：判定只在 `lib/reply-peer.ts` 定义一次
  const defs: string[] = [];
  const walkC = (dir: string): void => {
    for (const ent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${ent.name}`;
      if (ent.isDirectory()) walkC(rel);
      else if (/\.(ts|tsx)$/.test(ent.name) && RD(rel).includes('export function resolveReplyPeer')) defs.push(rel);
    }
  };
  walkC(`${A}/renderer/src`);
  eq(defs.length, 1, 'C3-a ★「一处实现」：全 renderer 恰有 1 处 `export function resolveReplyPeer`', defs.join(', '));
  eq(defs[0], `${A}/renderer/src/lib/reply-peer.ts`, 'C3-b 唯一定义落在 `lib/reply-peer.ts`');

  // C4 接线形状（读**原文**，不去注释；锚点钉语句形状）
  const pageSrc = RD(`${A}/renderer/src/pages/IMPage.tsx`);
  const page = stripC(pageSrc);
  const callN = (page.match(/resolveReplyPeer\(replyPeer, convs\)/g) ?? []).length;
  eq(callN, 3, 'C4-a 标签 / 发送(`handleSend`) / 发件(`handlePickMedia`) 三处**同一函数**同尺（恰 3 处调用）');
  ok(!/convs\[0\]\?\.external_user_id/.test(page),
    'C4-b ★反证旧路径：`convs[0]?.external_user_id` 作收件人来源**零处**（列表漂顶人的病根已除）');
  ok(/setReplyPeer\(list\[0\]\?\.external_user_id \|\| null\)/.test(page),
    'C4-c 打开渠道时把**当时的最新一条**快照为默认对象（显式绑定，非每渲染现取）');
  ok(/onClick=\{\(\)=>setReplyPeer\(c\.external_user_id\)\}/.test(page),
    'C4-d 每条会话都有**指定回话对象**入口（旧对象也可主动点名，不再只有"发给最新一条"一个口）');
  ok(/peerView\.selected&&/.test(page) && /peerNotice&&/.test(page),
    'C4-e 标签**上屏**：显式选定有徽标、且"不在筛选结果仍将发给他"如实提示');
  const closeBtn = /setConvChannel\(null\);setConvs\(\[\]\);setReplyPeer\(null\);/.test(page);
  ok(closeBtn, 'C4-f 关闭对话面板一并清选定（否则重开别的渠道会短暂继承上一个人）');
  // 出站契约不变（只改绑定来源）——发件仍走 `im.sendMedia(convChannel, peer, …)`
  ok(/im\.sendMedia\(convChannel, peer,/.test(page), 'C4-g 出站契约未变：发件仍 `im.sendMedia(convChannel, peer, …)`（只改绑定来源）');
}

// ══════════════════════════════════════════════════════════════════
// 【D】M4 会话区读得舒服（视口自适应 · 方向恒倒序且**显式标注**）
// ══════════════════════════════════════════════════════════════════
function groupD(): void {
  console.log('\n【D】M4 会话区读得舒服（去写死高度 · 方向标注上屏 · 序未变）');
  const page = stripC(RD(`${A}/renderer/src/pages/IMPage.tsx`));
  ok(!/space-y-2 h-64 overflow-y-auto/.test(page),
    'D1-a ★反证旧路径：会话区**不再**写死 `h-64`（256px 一屏看不到几条）');
  ok(/className="space-y-2 h-\[55vh\] min-h-\[20rem\] overflow-y-auto"/.test(page),
    'D1-b 视口自适应：`h-[55vh]` + `min-h-[20rem]`（高度随窗口，仍有下限防塌）');
  // 用户当场裁定 = **保留序**（零行为变更）——故两条取数 SQL 必须**逐字未动**（证没借"加标注"偷改方向）。
  // 按**语句形状**钉（不数 `ORDER BY rowid DESC` 的出现次数：注释里也会引这句，数字会随注释增删而飘）。
  const q = RD(`${A}/src/main/core/im/im-conversations-query.ts`);
  ok(/AND rowid < \? ORDER BY rowid DESC LIMIT \$\{CONV_PAGE_SIZE\}/.test(q),
    'D2-a ★裁定兑现：更早页游标 SQL 的倒序**逐字未动**（改序须配套滚动锚定，本轮不做）');
  ok(/WHERE \$\{filter\} ORDER BY rowid DESC LIMIT \$\{CONV_PAGE_SIZE\} OFFSET \?/.test(q),
    'D2-b ★裁定兑现：首屏/翻页 SQL 的倒序**逐字未动**');
  // 方向是"用户看得见的一件事"——须**上屏**，不能只活在 SQL 注释里
  ok(/最新在上 · 往下更早/.test(page), 'D3-a 方向**显式标注**上屏（不再让收件人/阅读者靠箭头方向猜）');
  // renderer 是词表的**第二个落点**：minify 后仍须能在产物里搜到这句中文串（搜标识符会假绿）
  const assetsDir = path.join(root, A, 'renderer/dist/assets');
  const imChunk = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir).filter((f) => /^IMPage-.*\.js$/.test(f))
    : [];
  ok(imChunk.length === 1, 'D3-b ★扫描面自证：renderer 产物恰 1 份 `IMPage-*.js`（否则下面搜串是空转假绿）', imChunk.join(', '));
  const imJs = imChunk.length === 1 ? fs.readFileSync(path.join(assetsDir, imChunk[0]!), 'utf-8') : '';
  ok(imJs.includes('最新在上'), 'D3-c ★产物内**真含**该标注（搜中文串；标识符被 minify 掉，搜符号会假绿）');
  ok(imJs.includes('h-[55vh]') || imJs.includes('55vh'), 'D3-d ★产物内**真含**自适应高度（Tailwind 生成的真 CSS 值落到 chunk 里）');
}

// ══════════════════════════════════════════════════════════════════
// 【E】M5 到点即拆 + M6 三路同源（真跑生产实现 · 门未过则零 HTTP）
// ══════════════════════════════════════════════════════════════════
//   夹具为**真库形状**（列名/空值口径照 `database.ts` 的 DDL），不是"比生产宽松"的窄表：
//   凡被断言的语句触及的每一列都在。HTTP 只有一处出口（`postDecomposeChat` 的 `fetch`），
//   故用计数 stub 就能把"闸未过 ⇒ 一次都没问模型"钉成正面断言（0→1），而不是"没抛错"。
const M5_SCHEMA = `
CREATE TABLE wa_projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', context_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', priority INTEGER DEFAULT 0,
  depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '', source TEXT DEFAULT 'user',
  acceptance_criteria TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_task_conversations (
  id TEXT PRIMARY KEY, task_id TEXT REFERENCES wa_tasks(id),
  role TEXT NOT NULL, content TEXT DEFAULT '', tool_calls TEXT,
  token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
-- zx_20261014_4 批五: 「项目域知识」段（§K）的取数表——零 LLM 派生事实册（原 §0 panorama 注入段已退役，低优先段的载体换到这里）。
CREATE TABLE wa_project_knowledge (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, section TEXT NOT NULL,
  content TEXT NOT NULL, source_ref TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_wa_project_knowledge_sec ON wa_project_knowledge(project_id, section);
`;

function m5Db(opts: {
  title?: string; description?: string; context?: Record<string, unknown>;
  setting?: string; projectContext?: Record<string, unknown>;
} = {}): AnyDb {
  const d = new DatabaseSync(':memory:') as unknown as AnyDb;
  d.exec(M5_SCHEMA);
  d.prepare('INSERT INTO wa_projects (id, name, context_json) VALUES (?, ?, ?)')
    .run('P-1', '演示项目', JSON.stringify(opts.projectContext ?? {}));
  d.prepare('INSERT INTO wa_tasks (id, project_id, title, description, status, context_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run('T-1', 'P-1', opts.title ?? '占位', opts.description ?? '', 'pending', JSON.stringify(opts.context ?? {}));
  if (opts.setting !== undefined) {
    d.prepare("INSERT OR REPLACE INTO wa_settings (key, value) VALUES ('engine.plan_auto_decompose', ?)").run(opts.setting);
  }
  return d;
}
const m5ChildCount = (d: AnyDb): number =>
  (d.prepare("SELECT COUNT(*) AS c FROM wa_tasks WHERE parent_task_id = 'T-1'").get() as { c: number }).c;
const m5Parent = (d: AnyDb) =>
  d.prepare("SELECT status, context_json FROM wa_tasks WHERE id = 'T-1'").get() as { status: string; context_json: string };
const m5Children = (d: AnyDb) =>
  d.prepare("SELECT status, source, context_json, acceptance_criteria FROM wa_tasks WHERE parent_task_id = 'T-1' ORDER BY priority DESC").all() as
  Array<{ status: string; source: string; context_json: string; acceptance_criteria: string }>;

/**
 * 3 条（含 1 条依赖）的最小可拆模板；1 条用于"拆不出"标本。
 *
 * zx_20261016_3 M33-b（改钉更强真源，非放宽）：模板条目**增 `purpose`**——`parseDecomposition`
 *   自本轮起把"无目的因的条目"拒掉（four-causes.ts `hasFinalCause`），故喂进来的回话必须**四因俱全**，
 *   否则 E5/E6 里的 3 条与 1 条会先被解析口滤掉，判据判的就不是它自称的那件事了。
 *   ⚠ E6 仍**只**试「条数不足（1 < 2）」这一道门：给了 purpose 才排除"被目的因门滤掉"的歧义。
 */
const M5_TMPL3 = [
  { title: '克隆仓库', description: '克隆代码到工作区', acceptance_criteria: '仓库就位', purpose: '让后续步骤有代码可改' },
  { title: '安装依赖', description: 'pnpm 安装依赖', acceptance_criteria: '依赖装好', purpose: '让服务能跑起来', dependsOn: [1] },
  { title: '启动服务', description: '启动 dev 服务', acceptance_criteria: '端口可访问', purpose: '验证改动可运行', dependsOn: [2] },
];
const M5_TMPL1 = [{ title: '只有一个', description: 'x', acceptance_criteria: '', purpose: '凑数用' }];

/**
 * 真跑 `tryAutoDecomposeAtStart`，喂桩：`fetch` 假装 ANS 端点的 chat 回话，`getAnsClient` 计数。
 * 两处计数都只记"真的走到那一步"——闸未过时两次皆 0（这正是 M5 的"开关关 ⇒ 逐字回旧行为"）。
 */
async function m5Run(db: AnyDb, tmpl: unknown[] | 'throw'): Promise<{ r: boolean; deps: number; chat: number }> {
  const counts = { deps: 0, chat: 0 };
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    counts.chat++;
    if (tmpl === 'throw') throw new Error('network down');
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(tmpl) } }] }) };
  }) as unknown as typeof fetch;
  try {
    const r = await tryAutoDecomposeAtStart(db, {
      taskId: 'T-1', projectId: 'P-1',
      getAnsClient: async () => {
        counts.deps++;
        return { getOptimalModel: async () => ({ url: 'http://ans.local/v1', api_key: 'k', model_name: 'm' }) };
      },
    });
    return { r, ...counts };
  } finally {
    globalThis.fetch = origFetch;
  }
}

/** 从 `sig` 之后 body 起花括号配对取整段函数体（`bodyOf` 会被形参里的 `{` 骗到，此处专用）。 */
function fnBody(src: string, sig: string): string {
  const i = src.indexOf(sig);
  if (i < 0) return '';
  const anchor = src.indexOf('Promise<boolean> {', i);
  const b = anchor < 0 ? -1 : src.indexOf('{', anchor);
  if (b < 0) return '';
  let d = 0;
  for (let j = b; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) return src.slice(b, j + 1); }
  }
  return '';
}

async function groupE(): Promise<void> {
  console.log('\n【E】M5 到点即拆 + M6 三路同源（真跑生产实现 · 门未过则零 HTTP）');

  // E1 闸①：寻常任务（短描述、非规划类）⇒ 不动手，且**零 HTTP**
  {
    const db = m5Db({ title: '整理桌面文档', description: '把文件按日期归归类' });
    const { r, deps, chat } = await m5Run(db, M5_TMPL3);
    eq(r, false, 'E1-a 短描述非规划类 ⇒ 不拆（返回 false）');
    eq(m5ChildCount(db), 0, 'E1-b 未建任何子任务');
    eq({ deps, chat }, { deps: 0, chat: 0 }, 'E1-c ★闸① 拦下 ⇒ **零 HTTP**（取端点/发对话一次都没有）');
  }

  // E2 闸②：复杂/规划类但**非顶层**（depth=1）⇒ 不动手，零 HTTP（防每层各拆一次 ⇒ 成本失控）
  {
    const db = m5Db({ title: '优化方案设计', description: '给这条链路出一个优化方案', context: { depth: 1 } });
    const { r, deps, chat } = await m5Run(db, M5_TMPL3);
    eq(r, false, 'E2-a 复杂档但 depth=1 ⇒ 不拆（只对顶层动手）');
    eq(m5ChildCount(db), 0, 'E2-b 未建任何子任务');
    eq({ deps, chat }, { deps: 0, chat: 0 }, 'E2-c ★闸② 在取端点之前 ⇒ 零 HTTP');
  }

  // E3 闸③：曾拆过（持久标记）⇒ 不再拆，零 HTTP（防"子全完成 ⇒ 父恢复 ⇒ 再拆"的回环）
  {
    const db = m5Db({ title: '优化方案设计', description: '给这条链路出一个优化方案', context: { auto_decomposed: true } });
    const { r, deps, chat } = await m5Run(db, M5_TMPL3);
    eq(r, false, 'E3-a 带 `$.auto_decomposed=true` ⇒ 不再拆');
    eq({ deps, chat }, { deps: 0, chat: 0 }, 'E3-b ★闸③ 在取端点之前 ⇒ 零 HTTP');
  }

  // E4 开关关 ⇒ 逐字回旧行为：闸①②③都过，唯独 `engine.plan_auto_decompose='false'` 拦住，仍零 HTTP
  {
    const db = m5Db({ title: '优化方案设计', description: '给这条链路出一个优化方案', setting: 'false' });
    const { r, deps, chat } = await m5Run(db, M5_TMPL3);
    eq(r, false, 'E4-a 开关关 ⇒ 不拆（逐字回旧行为）');
    eq(m5ChildCount(db), 0, 'E4-b 未建任何子任务');
    eq({ deps, chat }, { deps: 0, chat: 0 }, 'E4-c ★开关判据在**取依赖之前** ⇒ 关着也一次 HTTP 不打');
  }

  // E5 命中：真拆、父 paused 等子、三件落盘（子行 / 持久标记 / 会话留痕）
  {
    const db = m5Db({ title: '优化方案设计', description: '给这条链路出一个优化方案' });
    const { r, deps, chat } = await m5Run(db, M5_TMPL3);
    eq(r, true, 'E5-a 复杂/规划类顶层任务 ⇒ 拆解并挂起父（返回 true）');
    eq({ deps, chat }, { deps: 1, chat: 1 }, 'E5-b 门全过 ⇒ 恰问一次端点、恰发一次拆解对话');
    eq(m5ChildCount(db), 3, 'E5-c 子任务 **0→3**（模板 3 条全部落库）');
    const p = m5Parent(db);
    eq(p.status, 'paused', 'E5-d 父任务置 **paused** 等子');
    ok(p.status !== 'planning', 'E5-e ★反死锁：父**不是** planning（`CHAIN_BUSY_STATUSES` 含它 ⇒ 会永久挡住自己的子）');
    const pctx = JSON.parse(p.context_json) as Record<string, unknown>;
    eq(pctx.pause_reason, PAUSE_REASON_CHILDREN_INCOMPLETE, 'E5-f 暂停因有据（children_incomplete，复用既有判据码）');
    eq(pctx.auto_decomposed, true, 'E5-g 持久标记 `$.auto_decomposed=true` 落盘（防回环的承重件）');
    const kids = m5Children(db);
    ok(kids.length === 3 && kids.every((k) => k.status === 'pending'), 'E5-h 三个子任务一律 pending（无前置者立即可派发）');
    ok(kids.every((k) => k.source === 'auto-decompose'), 'E5-i 子任务 source=auto-decompose（与 IM/模板两路同形）');
    ok(kids.every((k) => (JSON.parse(k.context_json) as Record<string, unknown>).auto_decomposed === true),
      'E5-j ★M6 字段一致：子任务 context_json 亦带同层键 `auto_decomposed=true`');
    ok(kids.every((k) => typeof k.acceptance_criteria === 'string'), 'E5-k 子任务带 acceptance_criteria 列');
    const conv = db.prepare(
      "SELECT content FROM wa_task_conversations WHERE task_id = 'T-1' AND content LIKE '[智能拆解]%'").all() as Array<{ content: string }>;
    eq(conv.length, 1, 'E5-l 会话流留痕**恰一条** [智能拆解]');
    ok(conv[0]!.content.includes('任务启动'), 'E5-m 留痕带来源词「任务启动」（启动路口径，与计划模式路可区分）');
  }

  // E6 拆不出（模板 < 2）⇒ **不建、不编造**，父状态不动、照旧单任务跑
  {
    const db = m5Db({ title: '优化方案设计', description: '给这条链路出一个优化方案' });
    const { r, deps } = await m5Run(db, M5_TMPL1);
    eq(r, false, 'E6-a 模型只拆出 1 条（<2）⇒ 视为没拆成，返回 false');
    eq(m5ChildCount(db), 0, 'E6-b ★不建、不编造：一条子任务也没建');
    eq(m5Parent(db).status, 'pending', 'E6-c 父任务状态**未被改动**（仍 pending，照旧单任务跑）');
    eq(deps, 1, 'E6-d 如实：确实问到了模型（这不是"没跑到"，是"跑到了但结论是拆不出"）');
  }

  // E6.5 调用不通（fetch 抛）⇒ 如实降级，不阻断执行
  {
    const db = m5Db({ title: '优化方案设计', description: '给这条链路出一个优化方案' });
    const { r } = await m5Run(db, 'throw');
    eq(r, false, 'E6-e 拆解对话抛错 ⇒ 如实返回 false（按单任务照跑，不阻断执行）');
    eq(m5ChildCount(db), 0, 'E6-f 抛错路同样不建任何子任务');
  }

  // E7 回环反证成对标本：有标记 ⇒ 不拆（闸③承重）；同一夹具**去掉标记** ⇒ 真再拆
  {
    const db1 = m5Db({ title: '优化方案设计', description: '给这条链路出一个优化方案', context: { auto_decomposed: true } });
    db1.prepare("INSERT INTO wa_tasks (id, project_id, title, description, status, parent_task_id, context_json) VALUES ('K-1', 'P-1', '旧子', '', 'completed', 'T-1', '{}')").run();
    const { r: r1, deps: d1, chat: c1 } = await m5Run(db1, M5_TMPL3);
    eq(r1, false, 'E7-a ★回环反证：曾拆过（有标记）且子已终态 ⇒ **不再拆**（否则恢复父后会无限重拆）');
    eq({ deps: d1, chat: c1 }, { deps: 0, chat: 0 }, 'E7-b 且**零 HTTP**（闸③ 在取端点之前）');
    eq(m5ChildCount(db1), 1, 'E7-c 有标记侧子任务数不变（仍只有那个已完成的 K-1）');

    const db2 = m5Db({ title: '优化方案设计', description: '给这条链路出一个优化方案' });
    db2.prepare("INSERT INTO wa_tasks (id, project_id, title, description, status, parent_task_id, context_json) VALUES ('K-1', 'P-1', '旧子', '', 'completed', 'T-1', '{}')").run();
    const { r: r2, chat: c2 } = await m5Run(db2, M5_TMPL3);
    eq(r2, true, 'E7-d ★对照：同一夹具去掉标记 ⇒ 真再拆（证上面"不拆"来自标记本身，而非别处条件）');
    eq(c2, 1, 'E7-e 对照一侧确实发了拆解对话');
    eq(m5ChildCount(db2), 4, 'E7-f 无标记侧 = 已完成 1 + 新拆 3');
  }

  // ── 静态：接线那一跳按**语句形状**钉；helper 段内零处 `status='planning'` 反证死锁 ──
  const ait = RD(`${A}/src/main/core/jobs/ai-task.ts`);
  const call = 'if (await tryAutoDecomposeAtStart(db, { taskId, projectId, getAnsClient: ctx.getAnsClient })) return;';
  const ci = ait.indexOf(call);
  ok(ci > 0, 'E8-a 接线在册：ai-task 处理器按语句形状调用 `tryAutoDecomposeAtStart(...)`');
  const ei = ait.indexOf('const result = await executeTask(');
  ok(ei > 0 && ci < ei, 'E8-b ★位置在册：拆解钩子在 `executeTask` **之前**（先问该不该拆，再决定要不要执行它）');
  const helper = fnBody(ait, 'export async function tryAutoDecomposeAtStart(');
  ok(helper.length > 400, 'E8-c ★扫描面自证：helper 函数体非空', `${helper.length} 字符`);
  ok(!/status\s*=\s*'planning'/.test(helper), 'E8-d ★反证死锁：helper **零处**写 `status=\'planning\'`（改回 planning 即永久挡子）');
  ok(/pauseTask\(\s*\{?/.test(helper) && /PAUSE_REASON_CHILDREN_INCOMPLETE/.test(helper),
    'E8-e 走既有「父等子」形状 `pauseTask(..., children_incomplete)`（不新造第二套）');
  ok(/decomposedBefore\(db, opts\.taskId\)/.test(helper), 'E8-f 启动路**两道都问**：`decomposedBefore` 在 helper 体内承重');

  // ── M6：历史拆解模式的**唯一取法与唯一写法**（真跑） ──
  eq(loadDecompositionPatterns(m5Db({ projectContext: { decomposition_patterns: { web_app: 3, api: 2 } } }), 'P-1'),
    'web_app类: 约3个子任务、api类: 约2个子任务',
    'E9-a 真跑：项目历史模式 → prompt 那句「历史拆解模式参考」的唯一拼法');
  eq(loadDecompositionPatterns(m5Db({ projectContext: { decomposition_patterns: { web_app: 3 } } }), null), undefined,
    'E9-b 无 projectId ⇒ undefined（不问库）');
  eq(loadDecompositionPatterns(m5Db(), 'P-1'), undefined, 'E9-c 项目无 decomposition_patterns ⇒ undefined（不编造历史）');
  eq(loadDecompositionPatterns(m5Db({ projectContext: { decomposition_patterns: {} } }), 'P-1'), undefined, 'E9-d 空对象 ⇒ undefined');

  const defs: string[] = [];
  const walkE = (dir: string): void => {
    for (const ent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${ent.name}`;
      if (ent.isDirectory()) walkE(rel);
      else if (ent.name.endsWith('.ts') && RD(rel).includes('export function loadDecompositionPatterns(')) defs.push(rel);
    }
  };
  walkE(`${A}/src`);
  eq(defs.length, 1, 'E9-e ★「一处实现」：`src` 下恰 1 处 `export function loadDecompositionPatterns`', defs.join(', '));
  const ctrl = RD(`${A}/src/main/core/tools/control.ts`);
  const imr = RD(`${A}/src/main/services/im-router.ts`);
  eq((ctrl.match(/loadDecompositionPatterns\(/g) ?? []).length, 1, 'E9-f 引擎路（control.ts）恰 1 处调用');
  eq((imr.match(/loadDecompositionPatterns\(/g) ?? []).length, 1, 'E9-g IM 路（im-router.ts）恰 1 处调用');
  eq((ait.match(/loadDecompositionPatterns\(/g) ?? []).length, 1, 'E9-h 启动路（ai-task.ts）恰 1 处调用');
  eq((ctrl.match(/patterns: loadDecompositionPatterns\(db, projectId\)/g) ?? []).length, 1,
    'E9-i ★引擎路**补传** patterns（M6 verbatim：`control.ts` 传 `loadDecompositionPatterns(db, projectId)`，与 IM 路同源）');
  ok(!/Object\.entries\(patterns\)\.map/.test(imr), 'E9-j ★反证旧路径：im-router 内联的 `Object.entries(patterns).map` 已除（不再第二份拼法）');
  const ins = bodyOf(RD(`${A}/src/main/core/task-decompose.ts`), 'export function planSubtasksFromTemplate(');
  ok(ins.length > 400, 'E9-k ★扫描面自证：`planSubtasksFromTemplate` 函数体非空', `${ins.length} 字符`);
  for (const col of ['title', 'description', 'depends_on', 'acceptance_criteria']) {
    ok(ins.includes(col), `E9-l 拆解产物 INSERT 含列 \`${col}\`（真源：task-decompose.ts 的 INSERT）`);
  }

  // ── M6 收官：三路写下的拆解标记**逐字同一句** ──
  const MARK_SQL = "UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json,'{}'), '$.auto_decomposed', json('true')), updated_at = datetime('now') WHERE id = ?";
  ok(ait.includes(MARK_SQL) && ctrl.includes(MARK_SQL) && imr.includes(MARK_SQL),
    'E10 ★三路（启动/引擎/IM）标记 UPDATE **逐字同一句**（键名/写法同形 ⇒ 一处改三处一起改）');
}

// ══════════════════════════════════════════════════════════════════
// 【F】M7 拆解溯源可见（无模板的引擎路也上屏 · 模板路不受影响）
// ══════════════════════════════════════════════════════════════════
//   renderer 无独立测试宿主，判据沿用本文件 D 组的**两条腿**：①页面**语句形状**（去注释，防史注冒充实现）
//   ②**产物内中文串**（minify 后标识符不可搜，只能搜文案例）。两条腿都须在场——只搜串会被注释骗过。
function groupF(): void {
  console.log('\n【F】M7 拆解溯源可见（引擎路不再恒隐藏）');
  const pageRaw = RD(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  const page = stripC(pageRaw);

  // F1 ★不误伤：模板路判据**逐字仍在**（有模板者照旧走"模板拆解"，本轮没把它删掉/放宽）
  ok(/if \(!c\.template \|\| !c\.auto_decomposed\) return null;/.test(page),
    'F1 模板路判据未动：`matchedInfo` 仍要求 `template && auto_decomposed`');

  // F2 新判据**三闸齐备**（按语句形状钉；不数出现次数——注释里也会引同一句，数字会随注释增删而飘）
  const ds = page.indexOf('const engineDecomposed');
  const de = page.indexOf('const budgetUsage');
  const der = ds >= 0 && de > ds ? page.slice(ds, de) : '';
  ok(der.length > 100, 'F2-a 扫描面自证：派生段非空（否则下面三条是空转假绿）', `${der.length} 字节`);
  ok(/!matchedInfo/.test(der) && /auto_decomposed === true/.test(der) && /familyChildren\.length > 0/.test(der),
    'F2-b ★引擎路判据三闸：无模板 ∧ 标记为真 ∧ **确有子任务**（标记也落在子任务身上 ⇒ 不靠它一个词自证）');

  // F3 ★上屏：徽标挂在 `{engineDecomposed && …}` 上——**去注释后**才成立，排除"史注里写了这句话"的冒充
  ok(/\{engineDecomposed && <p[\s\S]{0,240}?🧩 引擎自动拆解/.test(page),
    'F3 ★引擎徽标真挂在渲染条件上（读原文去注释；史注引同句不算实现）');

  // F4 ★产物两条腿：扫描面自证 + 中文串真在（minify 后搜标识符会假绿）
  const assetsDir = path.join(root, A, 'renderer/dist/assets');
  const tdpChunk = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter((f) => /^TaskDetailPage-.*\.js$/.test(f)) : [];
  ok(tdpChunk.length === 1, 'F4-a ★扫描面自证：产物恰 1 份 `TaskDetailPage-*.js`', tdpChunk.join(', '));
  const tdpJs = tdpChunk.length === 1 ? fs.readFileSync(path.join(assetsDir, tdpChunk[0]!), 'utf-8') : '';
  ok(tdpJs.includes('引擎自动拆解') && tdpJs.includes('无匹配模板'),
    'F4-b ★产物内**真含**引擎徽标 + 派生说明（不是只在源码里躺着）');

  // F5 ★两路**并存**而非顶替：模板路文案仍在（若本轮误删老徽标，这条会红）
  ok(tdpJs.includes('模板拆解'),
    'F5 ★两路徽标同存：模板路"模板拆解" + 引擎路"引擎自动拆解"（改名顶替即红）');
}

// ══════════════════════════════════════════════════════════════════
// 【G】M8 依赖账实（① 悬空前置留痕 · ② 子串匹配改精确解析 · ③ 一处派生规则）
// ══════════════════════════════════════════════════════════════════
//   ① ② 都**真跑生产实现**（直 import；夹具照 `database.ts` 的 DDL 全列在场，不比生产宽松）。
//   标本一律**成对**：该命中的真命中、该不命中的真不命中——只用"该命中"的样本 ⇒ 任何过宽变体全票通过。
function groupG(): void {
  console.log('\n【G】M8 依赖账实（① 留痕 ② 精确解析 ③ 一处派生）');
  // ── M8-① 「写错的前置 id」不再静默放行 ───────────────────────────────
  const gDb = (taskDeps: string, depRows: Array<{ id: string; status: string; title: string }>): AnyDb => {
    const d = new DatabaseSync(':memory:') as unknown as AnyDb;
    d.exec(M5_SCHEMA);
    d.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run('P-1', '演示项目');
    d.prepare('INSERT INTO wa_tasks (id, project_id, title, status, depends_on, context_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run('T-1', 'P-1', '本任务', 'pending', taskDeps, '{}');
    for (const r of depRows) {
      d.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, ?, ?, ?, ?)')
        .run(r.id, 'P-1', r.title, r.status, '{}');
    }
    return d;
  };
  const gWarnRows = (d: AnyDb): Array<{ content: string }> =>
    d.prepare("SELECT content FROM wa_task_conversations WHERE task_id = 'T-1' AND role = 'system'").all() as Array<{ content: string }>;

  // G1-a 无前置 ⇒ 一声不出（否则每 10s 每任务都刷 -> 噪声把真警告淹掉）
  eq(warnDepsUnresolved(gDb('', []), 'T-1'), null, 'G1-a 无前置 ⇒ 不写留痕');
  // G1-b 前置已完成 ⇒ `met`，不写
  eq(warnDepsUnresolved(gDb('D1', [{ id: 'D1', status: 'completed', title: '前置' }]), 'T-1'), null, 'G1-b 前置已 completed（met）⇒ 不写留痕');
  // G1-c ★真标本：前置查不到 ⇒ 恰写一条，文案取 `depBlockInfo` 真源（"前置任务不存在"）+ 点明已放行
  {
    const d = gDb('GHOST-1', []);
    const r = warnDepsUnresolved(d, 'T-1');
    const rows = gWarnRows(d);
    eq(r, { unknownIds: ['GHOST-1'] }, 'G1-c1 ★返回值点名查不到的 id');
    eq(rows.length, 1, 'G1-c2 ★恰写 1 条留痕（计数器类判据取 0→1 正面形）');
    ok(rows[0]!.content.startsWith('[WARN]') && rows[0]!.content.includes('前置任务不存在') && rows[0]!.content.includes('放行启动'),
      'G1-c3 ★文案取 `depBlockInfo` 唯一真源 + 点明「已按无前置放行」', rows[0]?.content?.slice(0, 60));
    ok((JSON.parse((d.prepare("SELECT context_json AS c FROM wa_tasks WHERE id = 'T-1'").get() as { c: string }).c) as { dep_unresolved_warned?: unknown }).dep_unresolved_warned === true,
      'G1-c4 ★留痕后就地落标记 `$.dep_unresolved_warned`（保留既有键）');
    // G1-d ★一次性：再跑一次不再写（否则每次派发重刷同一条）
    eq(warnDepsUnresolved(d, 'T-1'), null, 'G1-d ★第二次调用不再写（一次性，防水位被自己的重复刷高）');
    eq(gWarnRows(d).length, 1, 'G1-d2 ★留痕数仍为 1（不是"没抛"——正面数它没涨）');
  }
  // G1-e ★不误伤①：前置仍在推进（waiting）——本就拦得住启动，不在此喊（那类有既有出口）
  eq(warnDepsUnresolved(gDb('D1', [{ id: 'D1', status: 'pending', title: '前置' }]), 'T-1'), null,
    'G1-e 前置 pending（waiting，本就拦住启动）⇒ 不写留痕');
  // G1-f ★不误伤②：前置已 failed（dead）——真相是"被死前置卡住"，不是"放行"
  eq(warnDepsUnresolved(gDb('D1', [{ id: 'D1', status: 'failed', title: '前置' }]), 'T-1'), null,
    'G1-f 前置 failed（dead）⇒ 不写留痕（dead 有既有文案出口）');
  // G1-g ★不误伤③：dead + 查不到 混合 ⇒ `classifyDep` 折叠归 dead ⇒ 不写（名字须与事实一致）
  eq(warnDepsUnresolved(gDb('D1,GHOST-1', [{ id: 'D1', status: 'failed', title: '前置' }]), 'T-1'), null,
    'G1-g dead+unknown 混合 ⇒ 归 dead，不写成"放行"');
  // G1-h 接线那一跳按**语句形状**钉：调用点在拆解钩子**之后**（拆解成功则转等子、本任务不开跑，账由子任务各记）
  {
    const at = RD(`${A}/src/main/core/jobs/ai-task.ts`);
    const iHook = at.indexOf('await tryAutoDecomposeAtStart(db,');
    const iWarn = at.indexOf('const depWarn = warnDepsUnresolved(db, taskId);');
    ok(iHook > 0 && iWarn > iHook, 'G1-h ★接线：`warnDepsUnresolved` 真在 `ai-task` 处理器内、且压在拆解钩子**之后**');
  }

  // ── M8-② 子串匹配 → 精确解析（真跑 `analyzeBlockers`）────────────────────
  {
    const d = new DatabaseSync(':memory:') as unknown as AnyDb;
    d.exec(M5_SCHEMA);
    d.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run('P-1', '演示项目');
    const ins = d.prepare("INSERT INTO wa_tasks (id, project_id, title, status, depends_on, priority, context_json) VALUES (?, 'P-1', ?, 'pending', ?, 0, '{}')");
    ins.run('abc', '短 id 任务', '');          // 待判候选：id 是另一 id 的前缀
    ins.run('abcdef', '长 id 任务', 'zzz');    // `depends_on` 里含子串 'abc'（旧码会把 abc 算成它的前置）
    ins.run('TD', '真前置任务', '');            // 真标本：确有下游依赖它
    ins.run('T3', '真下游任务', 'TD');
    const blockers = analyzeBlockers(d, 'P-1');
    const byId = new Map(blockers.map((b) => [b.taskId, b]));
    // G2-a ★真标本先立住（同时自证夹具/查询面真的在工作——空数组会让下面那条"不含"变成空转假绿）
    ok(byId.get('TD')?.blockedCount === 1, 'G2-a ★真依赖被算出：`TD` 有 1 个下游依赖者', JSON.stringify([...byId.keys()]));
    // G2-b ★反证旧病：`abc` 不再是任何任务的"前置"（旧 `.includes` 会把它算上）
    ok(!byId.has('abc'), 'G2-b ★前缀 id 不再被子串误命中（旧 `.includes` 在此必误报）', JSON.stringify(blockers));
    // G2-c ★标本有区分度：两把尺在这条数据上**结论相反**（否则上面那条反证无意义）
    ok('abcdef'.includes('abc') && !parseDepIds('abcdef').includes('abc'),
      'G2-c ★标本有区分度：`abcdef` 含子串 `abc`，但精确解析后不含（两把尺结论相反）');
    // G2-d 全仓零处遗留子串判据。此处**特意摘注释**再看：判据问的是"**活代码**还在用旧尺吗"，
    //   而本轮史注**故意**引了旧写法 `other.depends_on.includes(task.id)` 作对照（记录病根）——
    //   原文判据会被自己的史注喂红（假红）；真相在活代码里。故两条腿：活代码零旧尺 + 活代码真走新尺。
    const srcStripped = stripC(RD(`${A}/src/main/core/project-analytics.ts`));
    ok(!/depends_on\.includes\(/.test(srcStripped) && /parseDepIds\(other\.depends_on\)\.includes\(task\.id\)/.test(srcStripped),
      'G2-d ★唯一解析器：`project-analytics` **活代码**已无 `depends_on.includes(`，改走 `parseDepIds`（史注引旧写法不算）');
  }

  // ── M8-③ 保留单列 + 一处派生规则（裁定落在**本处**）──────────────────────
  {
    // G3-a 唯一换算：全 `src` 恰 1 处定义、恰 2 处调用（两条拆解写点；IM 路经 `planSubtasksFromTemplate` 走同一份）
    //   计数前先摘注释：注释里也引 `decomposePriority(…)` 举例（本仓史注习惯）⇒ 原文计数必虚高。
    //   定义那一跳本身也命中调用正则（`export function ` 后即标识符）⇒ 同文件减去 1，否则「调用面」把自己算进去。
    const defs: string[] = [];
    const calls: string[] = [];
    walkSrc(`${A}/src/main`, (f, raw) => {
      const s = stripC(raw);
      const isDef = /export function decomposePriority\(/.test(s);
      if (isDef) defs.push(f);
      let n = (s.match(/(?<![\w.])decomposePriority\(/g) ?? []).length;
      if (isDef) n -= 1;
      for (let i = 0; i < n; i++) calls.push(f);
    });
    eq(defs.length, 1, 'G3-a1 ★「一处换算」：全 `src` 恰 1 处 `export function decomposePriority`', defs.join(', '));
    eq(calls.length, 2, 'G3-a2 ★调用面恰 2 处（`planSubtasksFromTemplate` 内 + `project.ipc` 模板拆解；史注不计）', calls.join(', '));
    // G3-b 唯一排序口径：摘注释后计数（原文会把史注里的 `ORDER BY priority DESC` 举例也数进来）
    let asc = 0;
    let desc = 0;
    walkSrc(`${A}/src/main`, (_f, raw) => {
      const s = stripC(raw);
      asc += (s.match(/ORDER BY priority ASC/gi) ?? []).length;
      desc += (s.match(/ORDER BY priority DESC/gi) ?? []).length;
    });
    ok(desc >= 2, 'G3-b1 扫描面自证：`ORDER BY priority DESC` 在册（≥2 处真读点）', `实测 ${desc}`);
    eq(asc, 0, 'G3-b2 ★反证唯一口径：全 `src` **零处** `ORDER BY priority ASC`（不并存第二套序）');
    // G3-c ★裁定与三层边界落在**本处**（写侧/读侧/显示侧；显示侧点名 renderer 同列）
    const acct = RD(`${A}/src/main/core/task-accounting.ts`);
    const dp = acct.slice(acct.indexOf('export function decomposePriority(') - 3000);
    ok(/M8-③/.test(acct) && /保留单列 \+ 一处派生规则/.test(acct) && /写侧/.test(dp) && /读侧/.test(dp) && /显示侧/.test(dp) && /PRIORITY_LABEL/.test(dp),
      'G3-c ★裁定落进本处：三层边界（写侧/读侧/显示侧）齐备，且点名显示侧同读 `PRIORITY_LABEL` 那一列');
  }
}

// ══════════════════════════════════════════════════════════════════
// 【H】M13 可用性备用不回验（裁定落进注释 · 反证"没加了回验闸" · 与降级路成对照）
// ══════════════════════════════════════════════════════════════════
//   本组钉的是**裁定**本身（判据即"注释里把理由写死了、且行为没动"）——不是新行为。
//   H1/H2/H4 读**原文**（裁定的载体就是注释；去注释等于把判据删了）；H3 读**语句形状**（去注释）。
function groupH(): void {
  console.log('\n【H】M13 可用性备用不回验（裁定已定案 · 零行为变更）');
  const src = RD(`${A}/src/main/core/exec-model-select.ts`);
  const stripped = stripC(src);

  // H1 裁定文本在 `applySwap` 的 JSDoc 里（切片自证非空，否则下面"含…"只是空转）
  const iDecl = src.indexOf('const applySwap = (hop: EndpointHop, apiKeyPolicy:');
  const doc = iDecl > 0 ? src.slice(Math.max(0, iDecl - 2600), iDecl) : '';
  ok(doc.length > 500, 'H1-a 切片自证：`applySwap` 前的 JSDoc 段非空', `${doc.length} 字节`);
  ok(/可用性备用不回验/.test(doc), 'H1-b ★裁定名号落在本处：`可用性备用不回验`');
  ok(/裁定/.test(doc) && /取不到可行动作/.test(doc) && /判死/.test(doc),
    'H1-c ★理由写死（不是空口号）：点明"回验取不到可行动作"+ 抛会**判死**任务');

  // H2 ★"已定案"而非"待裁定"：旧措辞「须另立裁定」已从本处消除（防下一轮当缺陷复述）
  ok(!/须另立裁定/.test(doc), 'H2 ★本处不再是"待裁定"：`须另立裁定` 字样已消除');

  // H3 ★零行为变更（读**去注释**的语句形状）：`tier2/tier3` 满足条件即**直接**换，
  //   中间**没有**插入任何 `compareModelCapabilities` 回验——若有人加回验，`{` 与 swap 之间必有非空白语句 ⇒ 本正则断。
  ok(/if \(tier2Ok\) \{\s*applySwap\(tier2!, 'reuse'\);/.test(stripped),
    'H3-a ★可性备用换路那一跳**直接**换（`if (tier2Ok) {` 之后立刻 swap，中间无回验）');
  ok(/else if \(tier3\?\.url\) \{\s*applySwap\(tier3, 'reuse'\);/.test(stripped),
    'H3-b ★跨 provider 备用同形状（`else if (tier3?.url) {` 之后立刻 swap）');

  // H4 ★对照组：降级路（`sdk_fallback`）**仍**有"换完再回验 + 如实抛出"——证"不回验"是**分路裁定**，
  //   不是本轮把回验**统一删掉**（若误删那一支，本条红）。
  ok(/compareModelCapabilities\(modelCaps, sdkFallbackCfg\)/.test(stripped) && /throw new Error\(why\)/.test(stripped),
    'H4 ★对照：降级路 `sdk_fallback` 仍"回验 + 缺能力即抛"（两条路两把尺，非一刀切删回验）');
}

// ══════════════════════════════════════════════════════════════════
// 【J】M9 记忆原料与三闸可达
// ══════════════════════════════════════════════════════════════════
//   本组只跑**真 `MemoryManager` × 内存库**（G-1：不自造等价实现）；门槛/谓词一律**从源码就地派生**
//   （改实现即改判据的输入，不手抄 0.6 / 3）。夹具 schema 照 `database.ts` 的 DDL（base + 全部 ALTER
//   合并），并按**生产初始化顺序**搭：先 `exec(DDL)` → 再 `new MemoryManager`（`initFts` 建触发器）
//   → 最后插行（顺序颠倒则触发器建于行后 ⇒ 首次 UPDATE 命中未索引 rowid 抛错被吞 ⇒ 断言假绿）。
const M9_MEM_DDL = `
CREATE TABLE wa_memories (
  id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT,
  content TEXT NOT NULL, embedding TEXT, memory_type TEXT DEFAULT 'episodic',
  importance REAL DEFAULT 0.5, reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution',
  user_id TEXT DEFAULT '', valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}',
  is_exemplar INTEGER DEFAULT 0, exemplar_type TEXT, exemplar_context TEXT, updated_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  use_count INTEGER DEFAULT 0, last_used_at TEXT, similar_to TEXT DEFAULT '',
  last_reinforced_at TEXT, success_count INTEGER DEFAULT 0, failure_count INTEGER DEFAULT 0,
  deleted_at TEXT, deleted_reason TEXT DEFAULT '', deleted_fingerprint TEXT DEFAULT ''
);`;

function m9Fixture(): { d: AnyDb; mm: memMod.MemoryManager; reached: () => boolean } {
  const d = new DatabaseSync(':memory:') as unknown as AnyDb;
  d.exec(M5_SCHEMA + M9_MEM_DDL);
  let reached = false;
  // ansClient 桩：闸未过时函数在**调它之前**就 `return null` ⇒「是否被调用」即「门槛是否被跨过」。
  const mm = new memMod.MemoryManager(d as never, { getOptimalModel: async () => { reached = true; return null; } } as never);
  d.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run('p1', '本项目');
  d.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, ?, ?, ?, ?)')
    .run('T-1', 'p1', '演示任务', 'pending', '{}');
  return { d, mm, reached: () => reached };
}
const m9Ins = (d: AnyDb, id: string, type: string, imp: number, success = 0, use = 0, content = ''): void => {
  d.prepare(`INSERT INTO wa_memories (id, project_id, content, memory_type, importance, success_count, use_count, valence, context_json)
             VALUES (?, 'p1', ?, ?, ?, ?, ?, 'neutral', '{}')`).run(id, content || `${type}:${id}`, type, imp, success, use);
};
const m9Imp = (d: AnyDb, id: string): number =>
  (d.prepare('SELECT importance FROM wa_memories WHERE id = ?').get(id) as { importance: number }).importance;
const m9Row = (d: AnyDb, id: string): { success_count: number; use_count: number; importance: number } =>
  d.prepare('SELECT success_count, use_count, importance FROM wa_memories WHERE id = ?').get(id) as { success_count: number; use_count: number; importance: number };
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

async function groupJ(): Promise<void> {
  console.log('\n【J】M9 记忆原料与三闸可达（真 MemoryManager × 内存库；门槛从源码派生）');

  // ── ① `success_count` 写侧**已接线**（真库"活行恒 0"是**口径**，不是缺口）────────────
  //   J-1 正面（"值从 0 变 1"）：本 run 真入文（`memory_used_ids_run`）⇒ 成功强化真加计数 + 加价值。
  {
    const fx = m9Fixture();
    const id = fx.mm.storeText({ project_id: 'p1', task_id: 'T-1', content: '情景：改引擎后先跑 tsup', type: 'episodic', source: 'agent_execution' });
    ok(id.length > 0, 'J-1 前置：`storeText` 真写入一行（拿到非空 id）');
    eq(m9Imp(fx.d, id), 0.6, 'J-1 前置：按基线写入的 importance = MEM_IMPORTANCE_DEFAULT（0.6）');
    // 本 run 的真入文集合（`agent-executor` 每 run 覆写此键）
    fx.d.prepare("UPDATE wa_tasks SET context_json = ? WHERE id = 'T-1'").run(JSON.stringify({ memory_used_ids_run: [id] }));
    const touched = fx.mm.reinforceMemories('T-1', 'p1', true, 90);
    eq(touched, 1, 'J-1-a ★接线那一跳：`reinforceMemories` 真认领 1 条（走 per-run 支）');
    const r = m9Row(fx.d, id);
    eq(r.success_count, 1, 'J-1-b ★计数器**值从 0 变 1**（write 侧非"接线了却零发生"）');
    ok(near(r.importance, 0.69), 'J-1-c 成功强化真加价值（0.6 + 0.1×0.9 = 0.69）', String(r.importance));
    eq(r.use_count, 0, 'J-1-d ★**两本账分开**：强化只动 `success_count`，不冒充检索访问（`use_count` 仍 0）');
  }
  //   J-1e 老任务（无 per-run 键）⇒ 只记计数、不动价值——"不知道"时宁可不奖不罚（M6 语义）。
  {
    const fx = m9Fixture();
    const id = fx.mm.storeText({ project_id: 'p1', task_id: 'T-1', content: '情景：老任务落回 union', type: 'episodic' });
    fx.d.prepare("UPDATE wa_tasks SET context_json = ? WHERE id = 'T-1'").run(JSON.stringify({ injected_memory_ids: [id] }));
    const touched = fx.mm.reinforceMemories('T-1', 'p1', true, 90);
    const r = m9Row(fx.d, id);
    eq([touched, r.success_count, near(r.importance, 0.6)], [1, 1, true],
      'J-1e ★老任务支：仍计 `success_count`（0→1）但 importance **原样**（无 per-run 凭据 ⇒ 不奖不罚）');
  }

  // ── ① 抽象闸谓词**从源码派生** + 两只标本（该命中 / 该不命中）─────────────────────────
  {
    const mmSrc = stripC(RD(`${A}/src/main/core/memory-manager.ts`));
    const gate = /memory_type = 'episodic' AND success_count >= (\d+)/.exec(mmSrc);
    ok(!!gate, 'J-2 前置：`abstractSemanticKnowledge` 的候选谓词**从源码就地取得出**', gate?.[0] ?? '(取不到)');
    const thr = Number(gate?.[1] ?? 0);
    ok(thr >= 1, 'J-2 前置·自证：门槛是个真正整数（不是 0/空串冒充）', String(thr));
    const pred = gate?.[0] ?? '';
    const cnt = (d: AnyDb) => (d.prepare(`SELECT COUNT(*) c FROM wa_memories WHERE project_id = 'p1' AND ${pred} OR 0`).get() as { c: number }).c;
    const d1 = m9Fixture().d; m9Ins(d1, 'e-ok', 'episodic', 0.6, thr);
    eq(cnt(d1), 1, `J-2-a ★该命中标本：episodic × success_count=${thr} ⇒ 候选 1（谓词能被合法数据满足）`);
    const d2 = m9Fixture().d; m9Ins(d2, 'e-off', 'episodic', 0.6, thr - 1);
    eq(cnt(d2), 0, `J-2-b ★该不命中标本：success_count=${thr - 1} ⇒ 候选 0（有区分度，非全票通过）`);
    const d3 = m9Fixture().d; m9Ins(d3, 's-ok', 'semantic', 0.6, thr);
    eq(cnt(d3), 0, 'J-2-c ★类型域承重：`semantic` 即便 success_count 够也不进本闸（`memory_type` 过滤真在起作用）');
    //   J-2d 因果闭合：`success_count` 只在"真用上且成功"时 +1，而"用上"必已 `recordAccess`（use_count +1）
    //   ⇒ 恒有 `use_count >= success_count` ⇒ 凡够抽象闸者必够改型闸（`use_count>=3`）。
    const d4 = m9Fixture().d; m9Ins(d4, 'e-both', 'episodic', 0.6, thr, thr);
    eq(cnt(d4), 1, 'J-2-d ★同一行同时够两闸（success 与 use 皆 = thr）——这正是旧序被改型闸"搬走"的那一批');
    d4.prepare("UPDATE wa_memories SET memory_type = 'semantic' WHERE memory_type = 'episodic' AND use_count >= 3").run();
    eq(cnt(d4), 0, 'J-2-e ★反证：**先改型**（旧序）⇒ 候选被搬空、本闸看到的恒为 0（结构性空转的真形状）');
  }
  //   J-2f 接线那一跳：生产 `jobs` 里抽象**真压在**改型之前（否则 J-2-e 的搬空在每轮都发生）。
  {
    const jobsSrc = stripC(RD(`${A}/src/main/core/jobs/index.ts`));
    const iAbs = jobsSrc.indexOf('abstractSemanticKnowledge(project_id)');
    const iProm = jobsSrc.indexOf("SET memory_type = 'semantic' WHERE memory_type = 'episodic' AND use_count >= 3");
    ok(iAbs > 0 && iProm > iAbs, 'J-2f ★接线：`abstractSemanticKnowledge` 真跑在 `use_count>=3` 改型**之前**（防候选被 100% 搬走）', `abs@${iAbs} < promo@${iProm}`);
  }

  // ── ② 全景闸：绝对门槛 ∪ **相对名次**（0→1：衰减到 0.2 也能触发）────────────────────
  {
    // 该命中标本：候选恰 `PANORAMA_TOP_K` 条、importance 全 0.2（**低于**绝对门槛，模拟衰减）⇒ 相对支救活
    const K = memMod.PANORAMA_TOP_K;
    ok(K >= 1, 'J-3 前置：`PANORAMA_TOP_K` 从**模块命名空间**取真值（不手抄 3）', String(K));
    const A1 = m9Fixture();
    for (let i = 0; i < K; i++) m9Ins(A1.d, `m${i}`, i % 2 === 0 ? 'semantic' : 'procedural', 0.2);
    const hi = (A1.d.prepare(`SELECT COUNT(*) c FROM wa_memories WHERE project_id='p1' AND memory_type IN ('semantic','procedural','retrospective','negative') AND importance >= ${memMod.PANORAMA_MIN_IMPORTANCE}`).get() as { c: number }).c;
    eq(hi, 0, 'J-3 前提：绝对支命中 **0 条**（importance 全 0.2 < 门槛）——旧口径下此闸必 `return null`');
    await A1.mm.synthesizeProjectKnowledge('p1');
    ok(A1.reached(), 'J-3 ★值从 0 变 1：相对名次支真跨过门槛去要模型（旧口径在此恒 0）');

    // 该不命中标本：比 TOP_K 少一条 ⇒ 连相对支也不够 ⇒ 不触发（有区分度）
    const A2 = m9Fixture();
    for (let i = 0; i < K - 1; i++) m9Ins(A2.d, `m${i}`, 'semantic', 0.2);
    await A2.mm.synthesizeProjectKnowledge('p1');
    ok(!A2.reached(), `J-3b ★该不命中标本：候选 ${K - 1} 条 < TOP_K ⇒ 模型一次未被调用`);

    // 绝对支**一字未改**（读**原文**：史注与模板串都在）：不改绝对门槛的语义与串面，只**并列**一支。
    ok(RD(`${A}/src/main/core/memory-manager.ts`).includes('importance >= ${PANORAMA_MIN_IMPORTANCE}'),
      'J-3c ★绝对支原地保留：原文里 `importance >= ${PANORAMA_MIN_IMPORTANCE}` 一字未动（相对支只并列、不替换）');
  }
  //   J-4 一处真源：`PANORAMA_TOP_K` 全 `src/main` 恰 1 处定义；门槛比较真读它（不再硬编码 3）。
  {
    const defs: string[] = [];
    walkSrc(`${A}/src/main`, (f, raw) => { if (stripC(raw).includes('export const PANORAMA_TOP_K')) defs.push(f); });
    eq(defs.length, 1, 'J-4-a ★「一处真源」：全 `src/main` 恰 1 处 `export const PANORAMA_TOP_K`', defs.join(', '));
    const mmStrip = stripC(RD(`${A}/src/main/core/memory-manager.ts`));
    ok(mmStrip.includes('memories.length < PANORAMA_TOP_K'), 'J-4-b 门槛比较真读真源（`memories.length < PANORAMA_TOP_K`）');
    ok(!mmStrip.includes('memories.length < 3'), 'J-4-c ★反证旧写死：活代码里**零**处 `memories.length < 3`（散落字面量已收进真源）');
  }

  // ── ③ 逐段字节账（`segmentChars`）：兄弟字段、不塞 meta；账＝实 ─────────────────────
  {
    const fx = m9Fixture();
    // zx_20261014_4 批五：低优先段改由「项目域知识」（§K）承载（原 `memory_type='panorama'` 的 §0 注入段已退役）。
    fx.d.prepare(`INSERT INTO wa_project_knowledge (id, project_id, section, content, source_ref) VALUES (?,?,?,?,?)`)
      .run('k1', 'p1', 'entities', 'x'.repeat(400), 'wa_knowledge_triples');
    const budgetWide = 5000;
    const w = buildMemoryContext(fx.mm, 'p1', undefined, '这一跳的成败关键', null, undefined, budgetWide);
    const wKept = w.segmentChars.filter((s) => s.kept).reduce((n, s) => n + s.chars, 0);
    ok(Array.isArray(w.segmentChars) && w.segmentChars.length === w.meta.sections,
      'J-5-a ★逐段账与段数同长（每段一条；`segmentChars.length === meta.sections`）', `${w.segmentChars.length}/${w.meta.sections}`);
    eq(Object.keys(w.meta).sort(), ['chars', 'kept', 'omitted', 'sections'],
      'J-5-b ★meta 四键形状**一字未动**（新账另起兄弟栏，不污染既有判据 rr_zx_20260930 G-a-27）');
    eq(w.meta.omitted, 0, 'J-5-c 宽预算：一段未省（omitted=0）');
    ok(w.meta.chars === wKept + Math.max(0, w.meta.kept - 1) * 2,
      'J-5-d ★账＝实（宽预算）：`chars` = 保留段字节 + 段间分隔（kept-1 个 \\n\\n）', `${w.meta.chars} vs ${wKept}+${Math.max(0, w.meta.kept - 1) * 2}`);
    eq(w.segmentChars.filter((s) => !s.kept).length, 0, 'J-5-e 宽预算：逐段账里无"未入文"段');

    // 窄预算：低优先级段（项目域知识）被整段省略 ⇒ 该段 kept=false、其字节**不计入** chars；注记另算。
    const budgetNarrow = 260;
    const n = buildMemoryContext(fx.mm, 'p1', undefined, '这一跳的成败关键', null, undefined, budgetNarrow);
    ok(n.meta.omitted > 0, 'J-5-f 窄预算：真发生整段省略（omitted>0）——否则下面"未入文段"是空转');
    const pan = n.segmentChars.find((s) => s.name === '项目域知识');
    ok(!!pan && pan.kept === false, 'J-5-g ★被省略段在逐段账里如实标 `kept:false`（点名到段，不只报个总数）');
    const nKept = n.segmentChars.filter((s) => s.kept).reduce((acc, s) => acc + s.chars, 0);
    ok(n.meta.chars > nKept + Math.max(0, n.meta.kept - 1) * 2,
      'J-5-h ★账＝实（窄预算）：`chars` **>** 保留段字节 ⇒ 省略注记真被计入账（越省越报得"省"的旧病已除）', `${n.meta.chars} vs ${nKept}`);
    //   同一预算下 `segmentChars` 与 `accessedIds` 同一次划分：未入文段**不产生** accessedIds。
    ok(n.meta.kept === n.segmentChars.filter((s) => s.kept).length,
      'J-5-i 逐段账与 kept 计数同源（同一次整段划分的两面）');
  }
}

// ══════════════════════════════════════════════════════════════════
// 【K】M10 成功拆解质量门台账（生成 0→1 · 质量门未放宽 · 上游卡点 · 一处真源 · 上屏）
//   病根：这条流水线**接线了却零发生且零得无声**（三条 continue + catch{return 0}）。
//   故本组的正面判据是"**值从 0 变 1**"（真生成），并**逐条门**给出该命中/该不命中两只标本，
//   以证"看得见"是**加在**质量门之上，而非把门放宽到"看起来可达"。
// ══════════════════════════════════════════════════════════════════
const M10_SCHEMA = M5_SCHEMA + `
CREATE TABLE wa_task_templates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT DEFAULT 'custom',
  description TEXT DEFAULT '', subtasks TEXT DEFAULT '[]', keywords TEXT DEFAULT '[]',
  status TEXT DEFAULT 'active', priority INTEGER DEFAULT 0,
  source TEXT DEFAULT 'user', match_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
`;
function m10Db(): AnyDb {
  const d = new DatabaseSync(':memory:') as unknown as AnyDb;
  d.exec(M10_SCHEMA);
  d.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run('P-1', '演示项目');
  return d;
}
/** 造一个标了 auto_decomposed 的父任务 + n 个子任务（子任务带 priority 与链式 depends_on）。 */
function m10Parent(d: AnyDb, id: string, archetype: string, status: string, childCount: number): void {
  d.prepare('INSERT INTO wa_tasks (id, project_id, title, description, status, context_json, parent_task_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'P-1', `父任务 ${id}`, '描述文本', status, JSON.stringify({ auto_decomposed: true, archetype }), '');
  for (let i = 0; i < childCount; i++) {
    d.prepare('INSERT INTO wa_tasks (id, project_id, title, description, status, parent_task_id, priority, acceptance_criteria, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`${id}-c${i}`, 'P-1', `步骤${i + 1}`, `做步骤${i + 1}`, 'pending', id, i, `验收${i + 1}`, i > 0 ? `${id}-c${i - 1}` : '');
  }
}
const tplCount = (d: AnyDb): number => (d.prepare('SELECT COUNT(*) c FROM wa_task_templates').get() as { c: number }).c;

function groupK(): void {
  console.log('\n【K】M10 成功拆解质量门台账（生成 0→1 · 门未放宽 · 上游卡点 · 上屏）');

  // ── 生成路真产出（0→1 正面）+ 结构字段原样（dependsOn 未被重构破坏）─────────────────
  {
    const d = m10Db();
    m10Parent(d, 'A1', 'mcp_deploy', 'completed', 3);
    m10Parent(d, 'A2', 'mcp_deploy', 'completed', 3);
    m10Parent(d, 'A3', 'mcp_deploy', 'completed', 3);
    eq(tplCount(d), 0, 'K-1 前置：夹具起始 0 条模板（否则下面的 0→1 是空转）');
    eq(autoCreateTemplatesFromSuccesses(d), 1, 'K-1-a ★值从 0 变 1：3 样本 × 成功率 100% ⇒ 真生成 1 条 auto 模板');
    const row = d.prepare("SELECT id, category, subtasks, keywords, source, priority, status FROM wa_task_templates WHERE source = 'auto'").get() as
      { id: string; category: string; subtasks: string; keywords: string; source: string; priority: number; status: string } | undefined;
    ok(!!row, 'K-1-b 模板真落库（source=auto）');
    eq(row?.category, 'mcp_deploy', 'K-1-c 分类取 archetype（生成路口径未变）');
    eq(row?.priority, -1, 'K-1-d 低权重 priority=-1（不抢内置模板）');
    eq(row?.status, 'active', 'K-1-e 生成即启用');
    const subs = JSON.parse(row?.subtasks ?? '[]') as Array<{ title: string; dependsOn?: number[] }>;
    eq(subs.length, 3, 'K-1-f 子任务结构取自代表父任务（3 条）');
    eq(subs[1]?.dependsOn, [1], 'K-1-g ★zx_20260921 M6 的 dependsOn 保留未被本次重构破坏（同批序号 c0→1,c1→2…）');
    eq(autoCreateTemplatesFromSuccesses(d), 0, 'K-1-h 二次调用 0（防重：该 archetype 已有 auto 模板）');
    eq(describeAutoTemplateGates(d).gates.map(g => g.verdict), ['duplicate-exists'], 'K-1-i ★台账如实：二次后该组判定为 duplicate-exists');
  }

  // ── 质量门**未放宽**：样本门（该不命中 2 条 / 该命中 3 条）──────────────────────────
  {
    const d = m10Db();
    m10Parent(d, 'B1', 'webapp_x', 'completed', 3);
    m10Parent(d, 'B2', 'webapp_x', 'completed', 3);
    eq(autoCreateTemplatesFromSuccesses(d), 0, 'K-2-a ★不放宽：2 样本 ⇒ 不生成');
    eq(describeAutoTemplateGates(d).gates.map(g => g.verdict), ['insufficient-samples'], 'K-2-b ★台账点名该组被"样本<3"卡住（不再无声）');
    m10Parent(d, 'B3', 'webapp_x', 'completed', 3);
    eq(autoCreateTemplatesFromSuccesses(d), 1, 'K-2-c ★该命中标本：补到 3 样本 ⇒ 生成（有区分度，非全票拦）');
  }

  // ── 质量门**未放宽**：成功率门（1/3=33% 拦；对照组见 K-1 的 3/3=100% 放行）──────────
  {
    const d = m10Db();
    m10Parent(d, 'C1', 'etl', 'completed', 3);
    m10Parent(d, 'C2', 'etl', 'failed', 3);
    m10Parent(d, 'C3', 'etl', 'failed', 3);
    eq(autoCreateTemplatesFromSuccesses(d), 0, 'K-3-a ★不放宽：成功率 1/3=33% < 50% ⇒ 不生成');
    eq(describeAutoTemplateGates(d).gates.map(g => g.verdict), ['low-success-rate'], 'K-3-b ★台账点名该组被"成功率<50%"卡住');
  }

  // ── 台账**只读**（界面一刷新不得写库）+ 与生成路同一实现 ──────────────────────────
  {
    const d = m10Db();
    m10Parent(d, 'D1', 'mcp_deploy', 'completed', 3);
    m10Parent(d, 'D2', 'mcp_deploy', 'completed', 3);
    m10Parent(d, 'D3', 'mcp_deploy', 'completed', 3);
    const t0 = tplCount(d);
    const r = describeAutoTemplateGates(d);
    eq(r.created, 0, 'K-4-a 台账 `created` 恒 0（只读，不冒充写入）');
    eq(r.gates.map(g => g.verdict), ['passed'], 'K-4-b 过门的组在台账里看得见（`passed`）');
    eq(tplCount(d), t0, 'K-4-c ★只读性：调台账后模板表**一行未变**（否则界面每次刷新都在写库）');
    eq(autoCreateTemplatesFromSuccesses(d), 1, 'K-4-d ★同一判据驱动生成路：真生成 1 条（台账与生成是同一实现，非两把尺）');
  }

  // ── 上游漏斗：卡点如实指向**第一处见零**（真库现状 = 无自动拆解任务）───────────────
  {
    const d = m10Db();
    m10Parent(d, 'E1', 'x', 'completed', 3);
    d.prepare("UPDATE wa_tasks SET context_json = '{}' WHERE id = 'E1'").run(); // 有父任务、无 auto_decomposed
    const r = describeAutoTemplateGates(d);
    ok(r.funnel.parentTasks > 0 && r.funnel.autoDecomposed === 0, 'K-5-a 漏斗如实：有父任务、无自动拆解',
      JSON.stringify(r.funnel));
    eq(r.blockedAt, 'auto-decomposed', 'K-5-b ★卡点指向**上游**（M5/M6 的产出尚未积累），而非某一质量门');
    eq(r.gates, [], 'K-5-c 无候选组 ⇒ 逐组判定为空（不是"全票通过"）');
    const d2 = m10Db();
    m10Parent(d2, 'F1', 'y', 'pending', 3);
    m10Parent(d2, 'F2', 'y', 'running', 3);
    eq(describeAutoTemplateGates(d2).blockedAt, 'terminal', 'K-5-d ★另一级也能被点名（有自动拆解、无终态 ⇒ terminal）');
  }

  // ── 一处真源三层 + 接线那一跳 + 上屏（含 renderer 产物内中文串）────────────────────
  {
    const raw = RD(`${A}/src/main/core/task-templates.ts`);
    const tpl = stripC(raw);
    eq((raw.match(/NOT LIKE '%"template":"mcp_deploy"%'/g) ?? []).length, 1,
      'K-6-a ★一处真源：内置模板排除串在 task-templates.ts 里**恰 1 处**（重构前 stats/rep 各一份=2 处）');
    eq((tpl.match(/GROUP BY json_extract\(context_json, '\$\.archetype'\)/g) ?? []).length, 1,
      'K-6-b 候选分组 SQL 恰 1 份（生成与台账共用同一次评估，不重写第二份）');
    ok(/export function autoCreateTemplatesFromSuccesses[\s\S]*?evaluateAutoTemplateGates\(db\)/.test(tpl),
      'K-6-c 生成路**真调**共享评估器');
    ok(/export function describeAutoTemplateGates[\s\S]*?evaluateAutoTemplateGates\(db\)/.test(tpl),
      'K-6-d 台账路**真调**同一评估器');
    const jobs = RD(`${A}/src/main/core/jobs/index.ts`);
    ok(stripC(jobs).includes('describeAutoTemplateGates(db)'), 'K-6-e ★接线：consolidate 作业每轮真调台账');
    ok(jobs.includes('M10 自动模板台账'), 'K-6-f ★零产出时也有话说（此前只有 autoCreated>0 才出话）');
    ok(RD(`${A}/src/main/ipc/project.ipc.ts`).includes("'template:auto-gate'"), 'K-6-g IPC 通道在册');
    ok(RD(`${A}/renderer/src/lib/ipc.ts`).includes("'template:auto-gate'"), 'K-6-h renderer 取值点接上');
    const page = stripC(RD(`${A}/renderer/src/pages/TemplatesPage.tsx`));
    ok(page.includes('自动模板台账') && page.includes('BLOCK_LABEL'), 'K-6-i ★上屏：TemplatesPage 真渲染台账（标题串 + 卡点标签表）');
    const assetsDir = path.join(root, A, 'renderer/dist/assets');
    const chunk = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter(f => /^TemplatesPage-.*\.js$/.test(f)) : [];
    ok(chunk.length === 1, 'K-6-j ★扫描面自证：renderer 产物恰 1 份 `TemplatesPage-*.js`', chunk.join(','));
    const js = chunk.length === 1 ? fs.readFileSync(path.join(assetsDir, chunk[0]!), 'utf-8') : '';
    ok(js.includes('自动模板台账'), 'K-6-k ★产物内**真含**台账标题（搜中文串；标识符被 minify，搜符号会假绿）');
    ok(js.includes('样本 < 3') || js.includes('成功率 < 50%'), 'K-6-l ★产物内真含质量门文案（"卡在哪条门"也上屏）');
  }
}

// ══════════════════════════════════════════════════════════════════
// 【L】M11 项目调用记账（真源表写 0→1 · 只读 · 三写点接线 · import 面恰**五**处[zx_20261003 M5 加知识综合] · 夹具=生产 DDL · 上屏）
//   病根：MCP 调用失败只在连接池内存里数（重启即失忆）、A2A 启动**零记账**、守护进程只有心跳。
//   三条硬约束（方案 M11）：① 只收账**不据此做决策**（import 面须恰为**五**处，多一个消费方即红）；
//   ② 一处真源表，禁散落 `context_json`；③ 写必须 best-effort，但真写了没有由 **0→1 正面断言**看住。
// ══════════════════════════════════════════════════════════════════
// 夹具 DDL 是 database.ts 的**第二落点**（刻意手抄，好让 L-8 的"逐列一致"有区分度——
//   若夹具改由生产源码 exec 出来，那条比对就成了自我印证）。
const M11_SCHEMA = M5_SCHEMA + `
CREATE TABLE wa_service_calls (
  id TEXT PRIMARY KEY,
  project_id TEXT DEFAULT '',
  task_id TEXT DEFAULT '',
  kind TEXT NOT NULL,
  target TEXT DEFAULT '',
  operation TEXT DEFAULT '',
  ok INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  error TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
`;
function m11Db(): AnyDb {
  const d = new DatabaseSync(':memory:') as unknown as AnyDb;
  d.exec(M11_SCHEMA);
  d.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run('P-1', '演示项目');
  d.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run('P-2', '另一项目');
  return d;
}
const svcCount = (d: AnyDb): number => (d.prepare('SELECT COUNT(*) c FROM wa_service_calls').get() as { c: number }).c;

function groupL(): void {
  console.log('\n【L】M11 项目调用记账（真源表写 0→1 · 只读 · 三写点接线 · import 面恰四处 · 上屏）');

  // ── 写 0→1 + 聚合如实 + 三类**都出栏** ───────────────────────────────────────────
  {
    const d = m11Db();
    eq(svcCount(d), 0, 'L-1-a 前置：夹具起始 0 笔（否则下面的 0→1 是空转）');
    recordServiceCall(d, { projectId: 'P-1', taskId: 'T1', kind: 'mcp', target: 'svc/tool', operation: 'call', ok: true, durationMs: 12 });
    eq(svcCount(d), 1, 'L-1-b ★值从 0 变 1：一次真写 ⇒ 一行落库（不是只"没抛"）');
    recordServiceCall(d, { projectId: 'P-1', kind: 'a2a', target: 'agent-a', operation: 'start', ok: true, durationMs: 300 });
    recordServiceCall(d, { projectId: 'P-1', kind: 'daemon', target: 'svc-a', operation: 'start', ok: false, durationMs: 40, error: 'EADDRINUSE' });
    const r = describeServiceCalls(d, 'P-1');
    eq(r.total, 3, 'L-1-c 聚合如实：共 3 笔');
    eq([r.ok, r.failed], [2, 1], 'L-1-d 成败分别计数（ok=2 / failed=1）');
    eq(r.byKind.map(k => k.kind), ['mcp', 'a2a', 'daemon'], 'L-1-e ★三类**都出栏**、序取 SERVICE_CALL_KINDS（"零调用"与"没这一栏"是两回事）');
    eq(r.byKind.map(k => k.calls), [1, 1, 1], 'L-1-f 每类各 1 笔');
    eq(r.byKind.map(k => k.failed), [0, 0, 1], 'L-1-g 失败只落在 daemon 那栏');
    eq(r.byKind[2].lastError, 'EADDRINUSE', 'L-1-h 最近失败原因如实（daemon 该命中）');
    eq(r.byKind[0].lastError, null, 'L-1-i ★该不命中侧：mcp 无失败 ⇒ lastError 为 null（不是空串冒充）');
    eq(r.byKind[1].avgMs, 300, 'L-1-j 均耗时取真值（a2a 单笔 300ms）');
    eq(r.byKind[0].lastAt != null, true, 'L-1-k 有调用的类目 lastAt 有值');
  }

  // ── 零调用类目仍出栏（不被藏起来）+ 项目隔离 ────────────────────────────────────
  {
    const d = m11Db();
    recordServiceCall(d, { projectId: 'P-2', kind: 'mcp', target: 'x/y', operation: 'call', ok: true, durationMs: 5 });
    const r = describeServiceCalls(d, 'P-2');
    eq(r.byKind.map(k => k.calls), [1, 0, 0], 'L-2-a ★零调用类目仍出栏（calls=0），不被藏起来');
    eq(r.byKind.map(k => k.lastAt), [r.byKind[0].lastAt, null, null], 'L-2-b 零调用类目 lastAt=null（不编造时刻）');
    eq(describeServiceCalls(d, 'P-999').total, 0, 'L-3-a ★项目隔离：查无此项目 ⇒ 0 笔（不串味）');
    eq(describeServiceCalls(d, 'P-2').total, 1, 'L-3-b 另一项目各算各的');
  }

  // ── 只读性（界面每次刷新都不该改库）+ 读侧实现内零写语句 ──────────────────────────
  {
    const d = m11Db();
    recordServiceCall(d, { projectId: 'P-1', kind: 'mcp', target: 't', operation: 'call', ok: true, durationMs: 1 });
    const n0 = svcCount(d);
    describeServiceCalls(d, 'P-1'); describeServiceCalls(d, 'P-1'); describeServiceCalls(d, 'P-1');
    eq(svcCount(d), n0, 'L-4-a ★只读性：三次读聚合 ⇒ 表一行未变');
    const ledSrc = stripC(RD(`${A}/src/main/core/service-call-ledger.ts`));
    const rdBody = bodyOf(ledSrc, 'export function describeServiceCalls');
    ok(rdBody.length > 0 && !/\b(INSERT|UPDATE|DELETE)\b/.test(rdBody), 'L-4-b ★读侧实现内**零写语句**（不是"碰巧没写"）', `${rdBody.length} 字节`);
  }

  // ── best-effort：真源表不存在时**不抛**（三个写点都在用户可见路径上）──────────────
  {
    const bare = new DatabaseSync(':memory:') as unknown as AnyDb;
    bare.exec(M5_SCHEMA);
    let threw = false;
    try { recordServiceCall(bare, { projectId: 'P-1', kind: 'mcp', target: 't', operation: 'call', ok: true, durationMs: 3 }); }
    catch { threw = true; }
    ok(!threw, 'L-5-a ★best-effort：真源表不存在时记账**不抛**（记账失败绝不弄崩真调用）');
    eq((bare.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='wa_service_calls'").get() as { c: number }).c, 0,
      'L-5-b 反证：确实没建表（不是"建了表所以不抛"）');
    const ledSrc = stripC(RD(`${A}/src/main/core/service-call-ledger.ts`));
    const wrBody = bodyOf(ledSrc, 'export function recordServiceCall');
    ok(/try\s*\{[\s\S]*\}\s*catch/.test(wrBody), 'L-5-c ★写侧实现**带** try/catch（best-effort 落在实现里，不只写在注释里）');
  }

  // ── 截断与时长归一（超长 stderr 撑不爆账 / 负数与 NaN 不进账）──────────────────────
  {
    const d = m11Db();
    recordServiceCall(d, { projectId: 'P-1', kind: 'mcp', target: 't', operation: 'call', ok: false, durationMs: -5, error: 'x'.repeat(600) });
    recordServiceCall(d, { projectId: 'P-1', kind: 'mcp', target: 't2', operation: 'call', ok: false, durationMs: NaN });
    const rows = d.prepare('SELECT duration_ms dm, length(error) le FROM wa_service_calls ORDER BY rowid').all() as Array<{ dm: number; le: number }>;
    eq(rows[0]?.le, 500, 'L-6-a ★超长错误截断到 500（截断而非丢弃）');
    eq(rows[0]?.dm, 0, 'L-6-b 负耗时归一为 0（不写负数进账）');
    eq(rows[1]?.dm, 0, 'L-6-c NaN 耗时归一为 0');
  }

  // ── recent 倒序：created_at 秒级 ⇒ 须按 rowid 定序（不能按 uuid 主键）──────────────
  {
    const d = m11Db();
    recordServiceCall(d, { projectId: 'P-1', kind: 'mcp', target: 'first', operation: 'call', ok: true, durationMs: 1 });
    recordServiceCall(d, { projectId: 'P-1', kind: 'mcp', target: 'second', operation: 'call', ok: true, durationMs: 1 });
    eq(describeServiceCalls(d, 'P-1').recent.map(x => x.target), ['second', 'first'],
      'L-7-a ★最近明细按真插入序倒排（同秒落两笔仍分得清先后）');
  }

  // ── 夹具=生产 DDL（逐列一致；夹具落后/宽松 ⇒ 断言只是自我印证）────────────────────
  {
    const prodSrc = RD(`${A}/src/main/database.ts`);
    const m = prodSrc.match(/CREATE TABLE IF NOT EXISTS wa_service_calls \(([\s\S]*?)\n\s*\)/);
    ok(!!m, 'L-8-a 从 database.ts 原文解析出 wa_service_calls 的 CREATE TABLE 块（列定义真源）');
    const prodCols = (m?.[1] ?? '').split('\n').map(l => l.trim()).filter(l => /^[a-z_]+\s+[A-Z]/.test(l)).map(l => l.split(/\s+/)[0]!);
    const fx = m11Db();
    const fxCols = (fx.prepare('PRAGMA table_info(wa_service_calls)').all() as Array<{ name: string }>).map(c => c.name);
    eq(fxCols, prodCols, 'L-8-b ★夹具 DDL 与生产**逐列一致**', `夹具=${fxCols.join(',')} 生产=${prodCols.join(',')}`);
    ok(prodCols.includes('kind') && prodCols.includes('duration_ms') && prodCols.includes('ok'),
      'L-8-c 生产列含 项目+调用对象+动作+成败+耗时 五要素所依赖的列（kind/target/operation/ok/duration_ms 之要者）');
  }

  // ── 一处真源 + import 面**恰五处**（守住"只收账、不据此做决策"；M5 那处为只读知识综合）─────────────
  {
    const dbSrc = stripC(RD(`${A}/src/main/database.ts`));
    eq((dbSrc.match(/CREATE TABLE IF NOT EXISTS wa_service_calls/g) ?? []).length, 1, 'L-9-a ★一处建表：database.ts 里恰 1 处');
    eq((dbSrc.match(/CREATE INDEX IF NOT EXISTS idx_wa_service_calls_project/g) ?? []).length, 1, 'L-9-b 索引恰 1 处');
    const importers: string[] = [];
    const walkAll = (dir: string): void => {
      for (const ent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${ent.name}`;
        if (ent.isDirectory()) walkAll(rel);
        else if (/\.tsx?$/.test(ent.name) && !/\.d\.ts$/.test(ent.name)) {
          if (/\bfrom\s+'[^']*service-call-ledger\.js'/.test(RD(rel))) importers.push(rel);
        }
      }
    };
    walkAll(`${A}/src`); walkAll(`${A}/renderer/src`);
    const want = [
      `${A}/renderer/src/components/ServiceCallCard.tsx`,
      `${A}/renderer/src/lib/ipc.ts`,
      `${A}/src/main/core/project-knowledge-materials.ts`, // zx_20261003 M5：panorama 综合纳入「调用账成败」作旁证
      `${A}/src/main/core/tools/resource.ts`,
      `${A}/src/main/ipc/project.ipc.ts`,
    ].sort();
    // ⚠ 就地改钉（zx_20261003 M5）：消费方由**四→五**——M5 让 `synthesizeProjectKnowledge` 综合项目知识全景时
    //   纳入「调用账成败」作**旁证**（经 `project-knowledge-materials.ts` 只读调 `describeServiceCalls`）。
    //   这不违约束①「只收账、不据此做决策」：知识综合是**只读喂文本**给 LLM，**非**调度/选型/熔断路径，
    //   也不回写、不据以自动动作。新增消费方属该 pin 的**本意**（多一个即须**显式**登记并说明缘由）。
    eq(importers.slice().sort(), want, 'L-9-c ★import 面**恰五处**（M11 四处 + M5 知识综合一处；新增消费方即变红 ⇒ 守住"只收账、不据此做决策"）', importers.join(','));
    ok(!/recordServiceCall\(|describeServiceCalls\(/.test(stripC(RD(`${A}/renderer/src/components/ServiceCallCard.tsx`))),
      'L-9-d ★渲染层只取词表/类型，**不调**记账写读（记账是 main 侧的事）');
    ok(!/recordServiceCall\(|describeServiceCalls\(/.test(stripC(RD(`${A}/renderer/src/lib/ipc.ts`))),
      'L-9-e 同上（renderer/src/lib/ipc.ts）');
  }

  // ── 三写点接线（按语句形状钉那一跳）────────────────────────────────────────────
  {
    const resSrc = stripC(RD(`${A}/src/main/core/tools/resource.ts`));
    eq((resSrc.match(/recordServiceCall\(db, \{/g) ?? []).length, 2, 'L-10-a ★MCP 调用：成功/失败两出口各记一笔（恰 2 处）');
    const ipcSrc = stripC(RD(`${A}/src/main/ipc/project.ipc.ts`));
    eq((ipcSrc.match(/recordStart\('daemon'/g) ?? []).length, 4, 'L-10-b ★守护进程启动：4 出口（端口占用/启动即退出/成功/spawn 抛）各记一笔');
    eq((ipcSrc.match(/recordStart\('a2a'/g) ?? []).length, 2, 'L-10-c ★A2A 启动：成功/失败两出口各记一笔');
    ok(/recordStart\('a2a', false,[\s\S]{0,200}?throw a2aErr/.test(ipcSrc), 'L-10-d ★A2A 失败**记完再原样抛出**（外层 START_FAILED 契约不变）');
    const syncBody = bodyOf(RD(`${A}/src/main/ipc/project.ipc.ts`), 'if (alreadyRunning) {');
    ok(syncBody.length > 0 && !syncBody.includes('recordStart'), 'L-10-e ★"已在运行⇒同步状态"那一支**不记**（那次没发生调用；记账不得编造）', `${syncBody.length} 字节`);
    ok(!RD(`${A}/src/main/core/mcp-client-pool.ts`).includes('wa_service_calls'), 'L-10-f ★反证旧路径：连接池内**没有第二本账**（记账只在 resource.ts 那一跳）');
  }

  // ── 读侧 IPC + 上屏（含 renderer 产物内中文串）────────────────────────────────────
  {
    const ipcSrc = RD(`${A}/src/main/ipc/project.ipc.ts`);
    ok(/ipcMain\.handle\('service-calls:project'/.test(ipcSrc), 'L-11-a IPC 通道在册');
    ok(RD(`${A}/renderer/src/lib/ipc.ts`).includes("'service-calls:project'"), 'L-11-b renderer 取值点接上');
    ok(stripC(RD(`${A}/renderer/src/pages/ProjectDetailPage.tsx`)).includes('<ServiceCallCard'), 'L-11-c ★上屏：ProjectDetailPage 真渲染调用账卡');
    const cardRaw = RD(`${A}/renderer/src/components/ServiceCallCard.tsx`);
    ok(cardRaw.includes('外部调用账') && cardRaw.includes('只收账，不参与任何决策') && cardRaw.includes('未发生过'),
      'L-11-d 卡内文案齐全（标题 / 边界声明 / 零调用）');
    const assetsDir = path.join(root, A, 'renderer/dist/assets');
    const chunks = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter(f => /^ProjectDetailPage-.*\.js$/.test(f)) : [];
    ok(chunks.length === 1, 'L-11-e ★扫描面自证：renderer 产物恰 1 份 ProjectDetailPage-*.js', chunks.join(','));
    const js = chunks.length === 1 ? fs.readFileSync(path.join(assetsDir, chunks[0]!), 'utf-8') : '';
    ok(js.includes('外部调用账'), 'L-11-f ★产物内**真含**卡标题（搜中文串；标识符被 minify，搜符号会假绿）');
    ok(js.includes('只收账'), 'L-11-g ★产物内真含边界声明（"只收账"上屏）');
    ok(js.includes('MCP 工具调用') && js.includes('A2A 服务启动') && js.includes('守护进程启动'),
      'L-11-h ★产物内三类中文名齐全（renderer 用的是 main 侧**同一份词表**，非自带第二份）');
  }

  // ── 词表真源（类目枚举一处；读侧据此把零调用类目也列出）──────────────────────────
  {
    eq(SERVICE_CALL_KINDS, ['mcp', 'a2a', 'daemon'], 'L-12-a 类目枚举一处真源');
    eq(Object.keys(SERVICE_CALL_KIND_LABEL), ['mcp', 'a2a', 'daemon'], 'L-12-b 词表与枚举同键同序');
  }
}

// ══════════════════════════════════════════════════════════════════
// 【M】M12 自优化闭环（复验闭环 · 熔断键归一 · 结果留档"变才写" · 第六态上屏）
//   三条病根（方案 M12）：① `healed` 曾是**终局**——只表示"当次动作做成了"，真库 12 行 healed
//   却同类反复，正是"做成了 ≠ 站住了"的实证；② 熔断键**掺了具体实例名**，同类不同名各自计数、
//   24h≥3 永不触发；③ 健康/不变量结论只在 logger 里冒一句，无法长期累计。
//   判据纪律：真跑生产 `tryHeal`/`runHealthScan`（不造等价物）；复验两侧都要标本（该降 / 该转正）。
// ══════════════════════════════════════════════════════════════════
// 夹具 DDL：`M5_SCHEMA` + 健康扫描所触及的每一张表（wa_deliverables / wa_jobs）
//   + **生产导出的**账本 DDL（`SELF_HEALING_LOGS_DDL`，同 M-g：账本结构不手抄第二份，免自我印证）。
//   ⚠ zx_20261002 M16-②：此前夹具给 `wa_jobs` 补了 `updated_at`、又造了 `ans_audit_logs`——生产**都没有**
//     （真列见 `database.ts` 的 `wa_jobs` 建表；`ans_audit_logs` 是 ANS 侧表，见 `self-healing-monitor.ts` 行内理由）。
//     夹具比生产"宽"正是**断言假绿**的来路：读 `wa_jobs.updated_at` 的那句在夹具里跑得通、在生产里抛
//     `no such column` 被 `catch` 吞成静默。此处删两处，令夹具与生产**同宽**。
const M12_SCHEMA = M5_SCHEMA + `
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, name TEXT,
  type TEXT, status TEXT, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT, payload TEXT, status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')), started_at TEXT, completed_at TEXT, scheduled_at TEXT, error TEXT);
` + SELF_HEALING_LOGS_DDL;

function m12Db(): AnyDb {
  const d = new DatabaseSync(':memory:') as unknown as AnyDb;
  d.exec(M12_SCHEMA);
  return d;
}
interface M12Log { anomaly: string; action: string; success: number; outcome: string | null; detail: string | null }
const m12Rows = (d: AnyDb): M12Log[] =>
  d.prepare('SELECT anomaly, action, success, outcome, detail FROM wa_self_healing_logs ORDER BY rowid ASC').all() as M12Log[];
const m12Count = (d: AnyDb): number =>
  (d.prepare('SELECT COUNT(*) c FROM wa_self_healing_logs').get() as { c: number }).c;

function groupM(): void {
  console.log('\n【M】M12 自优化闭环（复验闭环 · 熔断键归一 · 留档"变才写" · 第六态上屏）');

  // ── ① 复验闭环：做成了 ⇒ pending_recheck；复发 ⇒ 降 failed；满期未复发 ⇒ 转正 healed ─────────
  {
    const d = m12Db();
    eq(m12Count(d), 0, 'M-1-a 起手账空（下面 0→1 才是正面断言）');
    const r1 = tryHeal(d as never, 't1', '守护进程无心跳', '标记为stale', () => 'healed',
      'target: t1 · 守护进程「守一」');
    const rows1 = m12Rows(d);
    eq(rows1.length, 1, 'M-1-b ★值从 0 变 1：一次真处置 ⇒ 一行落库（不是只"没抛"）');
    eq([r1, rows1[0]?.outcome, rows1[0]?.success], ['pending_recheck', 'pending_recheck', 0],
      'M-1-c ★★"做成了"记 `pending_recheck` 而**不是** `healed`——当次动作做成与病已消是两件事'
      + '（真库 12 行 healed 却同类反复，正是把它当终局的结果）');
    ok((rows1[0]?.detail ?? '').includes('待下轮复验'), 'M-1-d 账上标明"待下轮复验"（诊断页据此说清它还没转正）');

    // 复发：同类异常再次到来 ⇒ 上一笔"待复验"降 failed（在熔断判定之前，复发本身就是证据）
    const r2 = tryHeal(d as never, 't2', '守护进程无心跳', '标记为stale', () => 'healed');
    const rows2 = m12Rows(d);
    eq(rows2.length, 2, 'M-1-e 复发那一笔各自留账（共 2 行）');
    eq([rows2[0]?.outcome, rows2[0]?.success], ['failed', 0],
      'M-1-f ★★复发 ⇒ 上一笔降 `failed`（"复发即 failed，非 healed"）——不是机器动手失败，'
      + '而是**上一笔处置没站住**，账目如实');
    ok((rows2[0]?.detail ?? '').includes('复验复发'), 'M-1-g 降级原因落在 detail（可长期追"哪一笔没站住"）');
    eq([r2, rows2[1]?.outcome], ['pending_recheck', 'pending_recheck'], 'M-1-h 新一笔仍是"待复验"（尚未被证实，也尚未复发）');

    // 转正：满期（>5min）未复发 ⇒ confirmPendingHeals 记 healed / success=1
    d.prepare("UPDATE wa_self_healing_logs SET created_at = datetime('now','-6 minutes') WHERE rowid = (SELECT MAX(rowid) FROM wa_self_healing_logs)").run();
    confirmPendingHeals(d as never);
    const rows3 = m12Rows(d);
    eq([rows3[1]?.outcome, rows3[1]?.success], ['healed', 1],
      'M-1-i ★★满期未复发 ⇒ 转正 `healed`/`success=1`（"站住了"才有资格叫 healed）');
    ok((rows3[1]?.detail ?? '').includes('复验通过'), 'M-1-j 转正据落在 detail（满期未见同类复发）');
    eq(rows3[0]?.outcome, 'failed', 'M-1-k ★已降级那笔**不被**转正（转正只认"仍待复验"，不翻旧案）');
  }

  // ── ① 负标本：fresh pending 不该被转正（只用"该转正"的样本分不清"满期"与"无条件全转"）──────
  {
    const d = m12Db();
    tryHeal(d as never, 't1', 'X', 'a', () => 'healed');   // 刚落库，created_at = 此刻
    confirmPendingHeals(d as never);
    eq(m12Rows(d)[0]?.outcome, 'pending_recheck',
      'M-1-l ★该不命中侧：**刚**落库的"待复验"不被转正（证其按满期裁，非无条件全转）');
  }

  // ── ① 边界：只降"待复验"，不碰 `recorded`（它本就没声称"修好了"）─────────────────────────
  {
    const d = m12Db();
    logHealing(d as never, { anomaly: 'Y', action: '仅记录', outcome: 'recorded', detail: '只是记了一笔' });
    tryHeal(d as never, 't1', 'Y', 'a', () => 'healed');
    eq(m12Rows(d)[0]?.outcome, 'recorded',
      'M-1-m 同类复发**只降** `pending_recheck`，不把 `recorded` 也算作"没站住"（它从未声称修好）');
  }

  // ── ① 复验窗口的时长与 SQL 形状（静态：窗口须 < 扫描间隔；时刻由参数注入不写死）────────────
  {
    ok(PENDING_RECHECK_CONFIRM_MS > 0 && PENDING_RECHECK_CONFIRM_MS < 10 * 60 * 1000,
      'M-1-n 复验窗口 ∈ (0, 10min)：小于扫描间隔 ⇒ 上一轮处置至少被观察一个完整间隔',
      `${PENDING_RECHECK_CONFIRM_MS}ms`);
    const body = bodyOf(stripC(RD(`${A}/src/main/core/self-healing-monitor.ts`)), 'export function confirmPendingHeals');
    ok(body.length > 100 && /datetime\('now', \?\)/.test(body),
      'M-1-o 转正时刻走**参数化** `datetime(\'now\', ?)`（不把 5min 写死在 SQL 里——窗口一处真源）');
  }

  // ── ② 熔断键归一：四个 `tryHeal` 调用点一律传**异常类型**（不带实例名）───────────────────────
  {
    const src = stripC(RD(`${A}/src/main/core/self-healing-monitor.ts`));
    const scanBody = bodyOf(src, 'export function runHealthScan');
    ok(scanBody.length > 500, 'M-2-a ★扫描面自证：`runHealthScan` 函数体非空', `${scanBody.length} 字节`);
    const keys = [...scanBody.matchAll(/tryHeal\(db,\s*[^,]+,\s*'([^']+)'/g)].map((m) => m[1]);
    eq(keys, ['守护进程无心跳', '任务执行超时', '作业运行超时'],
      'M-2-b ★★三个调用点的 `anomaly` **恰是异常类型**（它们既是熔断键也是复验键）'
      + '（zx_20261002 M16-②：原第 5 处「断路器频繁跳闸」连同 `ans_audit_logs` 查询一并**显式删除**——'
      + '那张表在 ANS 侧、桌面主库永远查不到、且全仓无生产者，理由写死在 `self-healing-monitor.ts`）');
    eq((scanBody.match(/tryHeal\(db, /g) ?? []).length, 3, 'M-2-c 恰 3 处 `tryHeal(db, …)`（多一处/少一处即红）');
    ok(!/守护进程\$\{sd\.name\}/.test(scanBody) && !/任务\$\{st\.title\}/.test(scanBody)
      && !/作业\$\{oj\.type\}/.test(scanBody) && !/断路器频繁跳闸\(30min内>3次\)/.test(scanBody),
      'M-2-d ★★反证旧路径：四个键**不再**掺实例名/窗口数（改前 `守护进程${sd.name}(id)…` 这类'
      + '同类不同名各自计数 ⇒ 24h≥3 永不触发，正是病根）');
  }

  // ── ② 行为标本：4 个**不同名**的陈旧守护 ⇒ 归一到一个键 ⇒ 触发熔断（旧的按实例名永不触发）────
  {
    const d = m12Db();
    for (const [id, name] of [['D1', '甲'], ['D2', '乙'], ['D3', '丙'], ['D4', '丁']] as const) {
      d.prepare("INSERT INTO wa_deliverables (id, name, type, status, updated_at) VALUES (?, ?, 'daemon', 'running', datetime('now','-20 minutes'))").run(id, name);
    }
    eq(m12Count(d), 0, 'M-2-e 起手账空（0→4 的正面断言）');
    runHealthScan(d as never);
    const rows = m12Rows(d);
    eq(rows.length, 4, 'M-2-f ★四个陈旧守护**各留一笔账**（守护一项，非零发生）');
    eq(new Set(rows.map((r) => r.anomaly)).size, 1,
      'M-2-g ★★四笔**同键**（`守护进程无心跳`）——实例名进 detail、不进键；改前四个不同名 ⇒ 四键、各自 count=1');
    eq(rows.map((r) => r.outcome), ['failed', 'failed', 'failed', 'skipped_alarm'],
      'M-2-h ★★前三笔被后到的复发逐笔降 `failed`，第四笔触发 24h≥3 ⇒ `skipped_alarm`——'
      + '这正是"归一后才可能发生"的熔断；按实例名计数时**永不**达到阈值');
    ok((rows[0]?.detail ?? '').includes('守护进程「'),
      'M-2-i 实例信息如实落在 detail（归一丢的是**计数键**，不是可读性）');
  }

  // ── ③ 留档"变才写"：健康面 / 不变量项，状态不变不写、变则各留一笔 ───────────────────────────
  {
    const d = m12Db();
    eq(m12Count(d), 0, 'M-3-a 起手账空');
    logHealthTransitions(d as never, [{ key: 'ans', level: 'ok', evidence: 'ANS 可达' }]);
    eq(m12Count(d), 1, 'M-3-b ★值从 0 变 1：一面首见 ⇒ 留一笔');
    eq([m12Rows(d)[0]?.anomaly, m12Rows(d)[0]?.action, m12Rows(d)[0]?.outcome],
      ['健康检查: ans', '留档:ok', 'recorded'], 'M-3-c 键按面归一、`action` 记新状态、`outcome=recorded`（只记录没动手）');
    logHealthTransitions(d as never, [{ key: 'ans', level: 'ok', evidence: 'ANS 可达（再问一次）' }]);
    eq(m12Count(d), 1, 'M-3-d ★值未变 ⇒ **不写**（诊断页每开一次都问一遍，无条件写会把账淹掉）');
    logHealthTransitions(d as never, [{ key: 'ans', level: 'degraded', evidence: 'ANS 延迟偏高' }]);
    eq(m12Count(d), 2, 'M-3-e 变则留一笔（degraded）');
    eq(m12Rows(d)[1]?.action, '留档:degraded', 'M-3-f 新状态如实落账（变迁才是要长期累计的东西）');

    logInvariantTransitions(d as never, [{ name: 'inv1', passed: true, severity: 'info', description: '通过' }]);
    eq(m12Rows(d).filter((r) => r.anomaly === '架构不变量: inv1').length, 1, 'M-3-g 不变量项首见 ⇒ 一笔（`留档:pass`）');
    eq(m12Rows(d)[m12Rows(d).length - 1]?.action, '留档:pass', 'M-3-h 通过态记 `pass`');
    logInvariantTransitions(d as never, [{ name: 'inv1', passed: false, severity: 'error', description: '违反' }]);
    const inv = m12Rows(d).filter((r) => r.anomaly === '架构不变量: inv1');
    eq([inv.length, inv[inv.length - 1]?.action], [2, '留档:error'],
      'M-3-i 由过转违 ⇒ 再留一笔 `留档:error`（严重级入键，便于按级过滤）');
  }

  // ── ③ 接线那一跳（静态：三处真调用点，且 SQL 不越 IPC 边界）─────────────────────────────
  {
    const ipc = RD(`${A}/src/main/ipc/admin.ipc.ts`);
    ok(ipc.includes('logHealthTransitions(db, report.items)'), 'M-3-j 健康检查出口接上留档（`admin:health`）');
    ok(ipc.includes('logInvariantTransitions(db, invariants)'), 'M-3-k 不变量出口接上留档（`admin:diagnostics`）');
    ok(!stripC(ipc).includes('wa_self_healing_logs'),
      'M-3-l ★SQL 留在 core：handler 侧**零** `wa_self_healing_logs` 字面量（IPC 边界不递 SQL，同 b6 F-5）');
    const boot = RD(`${A}/src/main/core/system-bootstrap.ts`);
    ok(boot.includes('logInvariantTransitions(db, results)'),
      'M-3-m ★小时节拍也留档（不是只在用户开页时才记——诊断页不开的那些天也要有变迁账）');
  }

  // ── ④ 词表 + 上屏（第六态真进了 renderer 产物）─────────────────────────────────────────
  {
    ok((HEAL_OUTCOMES as readonly string[]).includes('pending_recheck'), 'M-4-a 真源词表含 `pending_recheck`');
    eq(HEAL_OUTCOME_LABEL.pending_recheck, '待复验', 'M-4-b 中文标签一处真源');
    const dash = RD(`${A}/renderer/src/pages/DashboardPage.tsx`);
    ok(/pending_recheck:\s*'bg-/.test(dash), 'M-4-c 上屏：`HEAL_OUTCOME_CLASS` 给 `pending_recheck` 配了色（六态俱全）');
    const assetsDir = path.join(root, A, 'renderer/dist/assets');
    const chunks = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter((f) => /^DashboardPage-.*\.js$/.test(f)) : [];
    ok(chunks.length === 1, 'M-4-d ★扫描面自证：renderer 产物恰 1 份 DashboardPage-*.js', chunks.join(','));
    const js = chunks.length === 1 ? fs.readFileSync(path.join(assetsDir, chunks[0]!), 'utf-8') : '';
    ok(js.includes('待复验'),
      'M-4-e ★产物内**真含**"待复验"（搜中文串；标识符被 minify，搜符号会假绿）——新态确实上了屏');
  }
}

// ══════════════════════════════════════════════════════════════════
// 【N】M15 附件按族派生能力需求
// ══════════════════════════════════════════════════════════════════
//   病根：`attachmentsNeedVision` 旧为"只认 image"（`attachNeedVision` 硬编码族名）。一件视频虽被
//   `attachment-inline.ts` 抽帧成 image part，执行模型却从不因此被要 `vision`——而抽帧那支**恰以
//   `visionOk` 为闸**（模型无 vision ⇒ 连抽都不抽）⇒ 视频画面**永远送不进去**且账上无声。
//   本组：① 表穷举且自证非空；② video 真触发（新行为的正面断言）；③ 回归面（image 要 / 其余不要）；
//   ④ 端到端派生→请求体两跳都吃到；⑤ 一处真源（表外无第二张族表）；⑥ audio 刻意在**他跳**（登记）。
function groupN(): void {
  console.log('\n【N】M15 附件按族派生能力需求（表=一处真源 · video 真触发 · audio 刻意留在他跳）');
  const mr = RD(`${A}/src/main/core/model-request.ts`);

  // ── N1 表穷举 + 自证非空（"块内零处"类须自证块非空，否则断言空转假绿）────────────────
  const famKeys = Object.keys(ATTACHMENT_FAMILY_CAPABILITIES).sort();
  eq(famKeys, ['audio', 'binary', 'document', 'image', 'video'],
    'N1-a 表**穷举** `AttachmentFamily` 全五族（新增族不在此表态即本断言断）');
  ok(ATTACHMENT_FAMILY_CAPABILITIES.image.length > 0 && ATTACHMENT_FAMILY_CAPABILITIES.video.length > 0,
    'N1-b ★扫描面自证：至少两族真的给了能力（否则下面"派生"是空转）',
    `image=${JSON.stringify(ATTACHMENT_FAMILY_CAPABILITIES.image)} / video=${JSON.stringify(ATTACHMENT_FAMILY_CAPABILITIES.video)}`);
  ok(ATTACHMENT_FAMILY_CAPABILITIES.image.includes('vision') && ATTACHMENT_FAMILY_CAPABILITIES.video.includes('vision'),
    'N1-c ★`vision` 只由 image/video 两族给（一个概念落在两族，非拍脑袋）');

  // ── N2 ★新行为：video 真触发 `vision`（改动前为 false）───────────────────────────────
  ok(attachmentsNeedVision([{ fileName: 'clip.mp4' }]) === true
    && attachmentsNeedVision([{ path: '/tmp/a.mov' }]) === true,
    'N2-a ★视频族触发 `vision`（改动前 false ⇒ 抽帧被 `visionOk` 挡死、画面永远进不去）',
    `mp4=${attachmentsNeedVision([{ fileName: 'clip.mp4' }])} / mov=${attachmentsNeedVision([{ path: '/tmp/a.mov' }])}`);

  // ── N3 回归面：image 仍要；audio/document/binary 不要；空/缺席不要（与 rr_zx_20260921 C11b 同尺）──
  ok(attachmentsNeedVision([{ fileName: 'a.png' }]) === true
    && attachmentsNeedVision([{ fileName: 'a.mp3' }]) === false
    && attachmentsNeedVision([{ fileName: 'a.pdf' }]) === false
    && attachmentsNeedVision([{ fileName: 'a.bin' }]) === false
    && attachmentsNeedVision([]) === false
    && attachmentsNeedVision(undefined) === false,
    'N3 回归面：PNG 要 / MP3·PDF·未知不要 / 空·缺席不要（与 rr_zx_20260921 C11b 同一把尺）',
    `mp3=${attachmentsNeedVision([{ fileName: 'a.mp3' }])} / pdf=${attachmentsNeedVision([{ fileName: 'a.pdf' }])} / bin=${attachmentsNeedVision([{ fileName: 'a.bin' }])}`);

  // ── N4 ★端到端：附件 → 派生 → **请求体**两跳都真吃到 `vision`（派生≠请求，两处都要验）────
  const vidCaps = deriveModelCapabilities('document', { hasMedia: attachmentsNeedVision([{ fileName: 'clip.mp4' }]) });
  const audCaps = deriveModelCapabilities('document', { hasMedia: attachmentsNeedVision([{ fileName: 'a.mp3' }]) });
  ok(vidCaps.includes('vision') && !audCaps.includes('vision'),
    'N4-a ★视频任务派生含 `vision`；音频任务**不**含（音频要的是 `audio`，不是收图）',
    `vid=[${vidCaps.join(',')}] / aud=[${audCaps.join(',')}]`);
  const vidReq = buildModelRequest({ archetype: 'document', strategy: 'balanced', hasMedia: attachmentsNeedVision([{ fileName: 'clip.mp4' }]) });
  ok((vidReq.capabilities as string[]).includes('vision'),
    'N4-b ★**请求体**那一跳也真带 `vision`（派生对了但请求没吃，等于没改）',
    `capabilities=[${(vidReq.capabilities as string[]).join(',')}]`);

  // ── N5 ★一处真源：`attachmentsNeedVision` **读表**派生，表外无第二张族表 ────────────────
  const visionBody = bodyOf(mr, 'export function attachmentsNeedVision');
  ok(visionBody.length > 0 && /ATTACHMENT_FAMILY_CAPABILITIES\s*\[/.test(visionBody),
    'N5-a ★`attachmentsNeedVision` **读表**派生（不是又写一张 image/video 扩名表）',
    `${visionBody.length} 字节`);
  const famHits = (mr.match(/familyOf\(/g) ?? []).length;
  ok(famHits >= 2, 'N5-b 判族仍走 `attachment-kinds.familyOf`（不另写扩展名表）', `${famHits} 处`);
  ok(!/familyOf\([^)]*\)\s*===\s*'image'/.test(mr),
    "N5-c ★旧写法 `familyOf(...) === 'image'` 已消除（族→能力映射唯表一处）");

  // ── N6 ★audio 刻意在**他跳**：表内空 + 转写专用一跳自持 `audio`（这是登记过的分路，不是遗漏）──
  ok(ATTACHMENT_FAMILY_CAPABILITIES.audio.length === 0,
    'N6-a 表内 audio 行**显式空**（`audio` 不经执行模型通道——音频先被本地转写成文字再喂）');
  const at = RD(`${A}/src/main/core/audio-transcribe.ts`);
  const audioBody = bodyOf(at, 'export function buildAudioModelRequest');
  ok(audioBody.length > 0 && /AUDIO_CAPABILITY/.test(audioBody),
    'N6-b ★音频能力 `audio` 由转写专用一跳**自持**（`audio-transcribe.ts`；执行模型从不接收音频字节）',
    `${audioBody.length} 字节`);

  // ── N7 ★接线那一跳（语句形状）：exec-model-select 仍把 `needsVision` 喂给派生与请求体 ──────
  const exe = RD(`${A}/src/main/core/exec-model-select.ts`);
  ok(/deriveModelCapabilities\(\s*archetype\s*,\s*\{\s*hasMedia:\s*needsVision\s*\}\)/.test(exe)
    && /buildModelRequest\(\{[\s\S]{0,240}?hasMedia:\s*needsVision/.test(exe),
    'N7 ★生产把 `needsVision`（M15 起含视频族）喂给能力派生与请求体——表改了，这一跳真吃到');
}

// ══════════════════════════════════════════════════════════════════
// 【O】M16 列存在性判据（K-5）+ 两处真死查询修复（真跑）
//   病根：`.prepare(...)` 写了一个**本库不存在的表/列**，SQLite 在执行那刻才报 `no such table/column`，
//   而调用点几乎都裹在 `try/catch` 里 ⇒ 查询**恒失败且无人知道**（本轮四处：`tool_name` / `ans_audit_logs`
//   / `wa_jobs.updated_at` / `wa_invite_tokens.used`）。判据 = 生产 DDL 建库 → `PRAGMA table_info` 取列
//   → 扫全 main 的 `.prepare` 字面量逐条核对（`lib/sql-columns.ts`）。本节同时证它**能证伪**。
// ══════════════════════════════════════════════════════════════════
function groupO(): void {
  console.log('\n【O】M16 列存在性判据 + 死查询修复（真跑生产 SQL）');

  // ── O-1 判据本体：扫面自证 + 修复版必绿 ─────────────────────────────────────────────
  const mainDir = path.join(root, `${A}/src/main`);
  const built = buildSchemaFromSources([mainDir]);
  eq(built.failed, [], 'O-1-a ★schema 自证：生产 DDL 全部建得起（`failed` 非空 ⇒ 判据"核不了"，须与"没毛病"分开）');
  ok(built.tables.size > 20, 'O-1-b ★schema 自证：从真源抽出的表数 > 20（判据非空转）', `${built.tables.size} 张`);
  const scan = scanPreparedSql(root, [mainDir], built.tables);
  ok(scan.checked > 1000, 'O-1-c ★扫描面自证：**真被核对**的语句数 > 1000（否则"零处"是没扫到）', `${scan.checked} 条`);
  ok(scan.parsed > scan.checked, 'O-1-d 跳过的语句**如实计数**（不假装核过）',
    `parsed=${scan.parsed} checked=${scan.checked} skip未知表/插值/PRAGMA=${scan.skippedByUnknownTable}/${scan.skippedInterpolated}/${scan.skippedPragma}`);
  eq(scan.findings, [], 'O-1-e ★★修复版**必绿**：全 main 的 `.prepare` SQL 列名与真 schema 逐一对上，零处不存在');
  ok(!scan.findings.some((f) => f.name === 'tool_name' || f.name === 'ans_audit_logs'
    || f.name === 'wa_jobs.updated_at' || f.name === 'used'),
    'O-1-f ★反证四处旧名：`tool_name`/`ans_audit_logs`/`wa_jobs.updated_at`/`used` 均不在 findings');

  // ── O-2 可证伪（K-5 硬约束）：HEAD 形状标本喂进**同一套判据**，必红 ────────────────────
  {
    const cols = (t: string): string[] => built.tables.get(t) ?? [];
    // ① admin:toolStats 的 `tool_name`（`wa_task_conversations` 从无此列）
    const headToolStats = "SELECT tool_name, COUNT(*) AS call_count FROM wa_task_conversations GROUP BY tool_name";
    ok(referencedTables(headToolStats).includes('wa_task_conversations'),
      'O-2-a 前置：HEAD 标本身引用的表在 schema 内（故它够格进列核对，不走"未知表跳过"）');
    ok(candidateColumns(headToolStats, built.tables).includes('tool_name') && !cols('wa_task_conversations').includes('tool_name'),
      'O-2-b ★HEAD 标本**必红**：`tool_name` 被判为候选列且真表无它 ⇒ 若源码仍这么写，O-1-e 立刻响');
    // ② 自愈第 5 项的 `ans_audit_logs`（ANS 侧表）——用**归档原文**里的真语句作标本（非手抄）
    const archSrc = RD('apps/_archive/worker-ant-server/src/services/self-healing-monitor.ts');
    const headAudit = extractPrepareLiterals(archSrc).find((s) => s.includes('ans_audit_logs')) ?? '';
    ok(headAudit.length > 0, 'O-2-c 前置：归档原文里找得到那条 `ans_audit_logs` 真语句（标本非手抄）', `${headAudit.length} 字节`);
    ok(referencedTables(headAudit).includes('ans_audit_logs') && !built.tables.has('ans_audit_logs'),
      'O-2-d ★HEAD 标本**必红**：`ans_audit_logs` 不在桌面真源 ⇒ 判"表不存在"（正是它在本库恒失败之因）');
    // ③ 孤儿作业的 `wa_jobs.updated_at`（`UPDATE wa_jobs SET col=…` ⇒ 由**未限定列**判据抓）
    const headOrphan = "UPDATE wa_jobs SET status = 'failed', updated_at = datetime('now') WHERE id = ?";
    ok(candidateColumns(headOrphan, built.tables).includes('updated_at') && !cols('wa_jobs').includes('updated_at'),
      'O-2-e ★HEAD 标本**必红**：`wa_jobs.updated_at` 被判为列引用，真表无此列（生产 wa_jobs 列见 `database.ts`）');
    // ④ 邀请码的 `wa_invite_tokens.used`（真列是 `used_at`）
    const headInvite = 'INSERT INTO wa_invite_tokens (id, token, expires_at, used) VALUES (?, ?, ?, 0)';
    ok(candidateColumns(headInvite, built.tables).includes('used') && !cols('wa_invite_tokens').includes('used')
      && cols('wa_invite_tokens').includes('used_at'),
      'O-2-f ★HEAD 标本**必红**：`used` 被判为候选列、真表无（真列是 `used_at`）');
  }

  // ── O-3 反证旧名（源码层，去注释后）：旧列名在 `.prepare` 里一个不剩 ─────────────────────
  {
    const healStripped = stripC(RD(`${A}/src/main/core/self-healing-monitor.ts`));
    ok(!/ans_audit_logs/.test(healStripped),
      'O-3-a ★`self-healing-monitor.ts`（去注释）**零**处 `ans_audit_logs`（第 5 项整条查询已显式删除）');
    const updJob = extractPrepareLiterals(healStripped).find((s) => /UPDATE\s+wa_jobs\b/i.test(s)) ?? '';
    ok(updJob.length > 0 && !/updated_at/.test(updJob),
      'O-3-b ★孤儿作业那条 UPDATE **不再**写 `updated_at`（真表无此列；改前每次抛、被吞成假账）', updJob.slice(0, 90));
    const authStripped = stripC(RD(`${A}/src/main/ipc/auth.ipc.ts`));
    const inviteSqls = extractPrepareLiterals(authStripped).filter((s) => s.includes('wa_invite_tokens'));
    eq(inviteSqls.length, 3, 'O-3-c 邀请链恰 3 条语句（建 / 验 / 核销）——扫面自证');
    ok(inviteSqls.every((s) => !/\bused\b/.test(s)),
      'O-3-d ★三条语句**零**处旧列 `used`（`\\bused\\b` 不匹配 `used_at`，故这是真反证）');
    ok(inviteSqls.some((s) => /INSERT INTO wa_invite_tokens/.test(s))
      && inviteSqls.some((s) => /used_at IS NULL/.test(s))
      && inviteSqls.some((s) => /SET used_at =/.test(s)),
      'O-3-e 建/验/核销三条**各自**用到 `used_at`（不是只改了其中一条）');
  }

  // ── O-4 真跑修复后的生产语句（0→1）：语句字面量**从源码抽出**，非另抄一份 ────────────────
  {
    const d = new DatabaseSync(':memory:') as unknown as AnyDb;
    d.exec(M5_SCHEMA + `
CREATE TABLE wa_invite_tokens (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')), expires_at TEXT NOT NULL, used_by TEXT, used_at TEXT);
`);
    // ① admin:toolStats —— 真工具调用是 `role='tool'` 且 content 形如 `[<名>] <结果>`（exec-step 落款）
    const adminSql = extractPrepareLiterals(RD(`${A}/src/main/ipc/admin.ipc.ts`))
      .find((s) => s.includes('wa_task_conversations') && /AS tool_name/.test(s)) ?? '';
    ok(adminSql.length > 0, 'O-4-a ★从源码抽出 toolStats 真语句（不手抄，免自我印证）', `${adminSql.length} 字节`);
    // `wa_task_conversations.task_id` 有 FK（node:sqlite 默认 `foreign_keys=ON`）⇒ 先落一条父任务
    d.prepare("INSERT INTO wa_tasks (id, title) VALUES ('tk', 'fixture-task')").run();
    const insConv = d.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?, 'tk', 'tool', ?)");
    insConv.run('c1', '[read_file] ok: 3 lines');
    insConv.run('c2', '[read_file] [错误] 文件不存在');
    const stats = d.prepare(adminSql).all() as Array<{ tool_name: string; call_count: number; error_count: number }>;
    eq(stats.length, 1, 'O-4-b ★0→1：真语句跑出 1 行（修复前查 `tool_name` 列 ⇒ 恒抛 ⇒ 卡片**从不出现**）');
    eq([stats[0]?.tool_name, stats[0]?.call_count, stats[0]?.error_count], ['read_file', 2, 1],
      'O-4-c ★工具名由 `role=\'tool\'` 的 content 派生；错误计数由 `[错误]` 标记派生（2 次调用、1 次错）');

    // ② 邀请链 —— 真跑建/验/核销三步
    const inviteSqls = extractPrepareLiterals(RD(`${A}/src/main/ipc/auth.ipc.ts`))
      .filter((s) => s.includes('wa_invite_tokens'));
    const ins = inviteSqls.find((s) => /^\s*INSERT/.test(s))!;
    const sel = inviteSqls.find((s) => /used_at IS NULL/.test(s))!;
    const upd = inviteSqls.find((s) => /SET used_at/.test(s))!;
    const futureIso = new Date(Date.now() + 3600_000).toISOString();
    d.prepare(ins).run('inv1', 'tok-abc', futureIso);
    eq((d.prepare('SELECT COUNT(*) c FROM wa_invite_tokens').get() as { c: number }).c, 1,
      'O-4-d ★0→1：建码真落一行（修复前写 `used` 列 ⇒ 恒抛 ⇒ 邀请**整体不可用**）');
    ok(d.prepare(sel).get('tok-abc') !== undefined, 'O-4-e 未用且未过期 ⇒ 验码**选中**（`used_at IS NULL` 成立）');
    d.prepare(upd).run('tok-abc');
    eq(d.prepare(sel).get('tok-abc'), undefined, 'O-4-f ★核销后**不再**选中（0→1 的正面断言）');
    ok((d.prepare("SELECT used_at FROM wa_invite_tokens WHERE id='inv1'").get() as { used_at: string | null }).used_at !== null,
      'O-4-g 核销真落库（`used_at` 非空）');
  }
}

// ══════════════════════════════════════════════════════════════════
// 【P】M17 工具规则对齐 ClaudeCode
//   ①「先读后改」：`edit_file` 未读过的文件**拒绝**（原仅 hint）——真跑生产工具表（`buildTools`）；
//     门禁**不是硬墙**：照 hint 读一次即可继续；新建文件走不到门禁（旧 `ENOENT` 路），不放死既有任务。
//   ② 编码闸一处真源：`output-validator` 三处读盘改走 `doc-text.decodePlainText`——真跑 `validateOutput`
//     证"GBK 成果不再被误判为内容不足"，并给出旧尺读法的反证标本。
// ══════════════════════════════════════════════════════════════════
async function groupP(): Promise<void> {
  console.log('\n【P】M17 工具规则对齐（先读后改门禁真跑 · 编码闸一处真源）');

  // ── P 行为面：真跑生产工具表（装配点 = `buildTools`，与生产同一份）────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr02-m17-'));
  try {
    type Tool = { execute: (a: never) => Promise<string> };
    const tools = buildTools({ db: {} } as never, 'tkP', 'pjP', tmp) as unknown as Record<string, Tool>;
    // 夹具自证：围栏放行（tmp 不在敏感表内），否则下面"被拦下的"可能是**围栏**拦的（假绿）。
    fs.writeFileSync(path.join(tmp, 'probe.txt'), 'PROBE');
    eq(await tools.read_file.execute({ filePath: 'probe.txt' } as never), 'PROBE',
      'P-0 ★夹具自证：围栏放行、`read_file` 整读回原文（下面拦下的才是"门禁"拦的）');
    // 清掉 probe 的名字便于后续独立；同一份 readFiles 里多一枚键不影响其它断言。
    const edit = async (filePath: string, old_string: string, new_string: string) =>
      JSON.parse(await tools.edit_file.execute({ filePath, old_string, new_string } as never)) as Record<string, unknown>;
    const read = (filePath: string) => tools.read_file.execute({ filePath } as never);
    const write = (filePath: string, content: string) => tools.write_file.execute({ filePath, content } as never);

    // P-1 ★门禁真拦 + 拒绝发生在写盘之前（文件一字未动）
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'AAA\nBBB\n');
    const blocked = await edit('a.txt', 'BBB', 'CCC');
    ok(typeof blocked.error === 'string' && blocked.error.includes('先读后改'),
      'P-1 ★未读过就改 ⇒ 门禁拒绝，error 就是规则本体（与提示词同一字符串）', JSON.stringify(blocked).slice(0, 110));
    eq(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf-8'), 'AAA\nBBB\n',
      'P-1-b ★被拦下 ⇒ 文件**一字未动**（拒绝在 `writeFile` 之前）');

    // P-2 ★读后放行（门禁可恢复，不是硬墙）——同一份 readFiles 里入册后即通过
    await read('a.txt');
    const okEdit = await edit('a.txt', 'BBB', 'CCC');
    eq(okEdit.ok, true, 'P-2 ★先 `read_file` ⇒ 再 `edit_file` 放行（照 hint 读一次即可继续）');
    eq(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf-8'), 'AAA\nCCC\n', 'P-2-b ★替换真落盘');

    // P-3 ★write_file 自建的文件免读（"模型自己写的内容已知"那类合法放行）
    await write('b.txt', 'ONE\nTWO\n');
    const okNew = await edit('b.txt', 'TWO', 'THREE');
    eq(okNew.ok, true, 'P-3 ★本任务 `write_file` 自建 ⇒ 免读直接 edit（`确实无需读全文` 的合法放行）');
    eq(fs.readFileSync(path.join(tmp, 'b.txt'), 'utf-8'), 'ONE\nTHREE\n', 'P-3-b ★落盘正确');

    // P-4 ★键归一：相对写法读过、绝对写法再改 ⇒ 认同一份（两侧都 `path.resolve`）
    fs.writeFileSync(path.join(tmp, 'c.txt'), 'X1\nX2\n');
    await read('c.txt');
    const absEdit = await edit(path.join(tmp, 'c.txt'), 'X2', 'X3');
    eq(absEdit.ok, true, 'P-4 ★相对读过、绝对再改仍放行（键归一同一把尺，否则同一文件被判成两件）');
    eq(fs.readFileSync(path.join(tmp, 'c.txt'), 'utf-8'), 'X1\nX3\n', 'P-4-b ★落盘正确');

    // P-5 ★新建文件不判死（反侧）：走旧「文件不存在」路，仍指向 write_file
    const missing = await edit('nope.txt', 'a', 'b');
    ok(typeof missing.error === 'string' && missing.error.includes('文件不存在')
      && String(missing.hint ?? '').includes('write_file'),
      'P-5 ★新建文件走 edit_file ⇒ 仍回旧「文件不存在」并指向 write_file（先读后改**没有**把这条路判死）',
      JSON.stringify(missing).slice(0, 110));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ── P-6 一处真源（静态，读原文）：规则文案只在 write.ts 定义一次，提示词走同一常量 ─────────
  const ws = RD(`${A}/src/main/core/tools/write.ts`);
  const ae = RD(`${A}/src/main/core/agent-executor.ts`);
  const SENT = '先读后改：修改文件前必须先用 read_file';
  eq((ws.match(/export const EDIT_FILE_READ_FIRST/g) ?? []).length, 1,
    'P-6-a ★`EDIT_FILE_READ_FIRST` 在 write.ts 定义**恰一处**');
  eq((ws.match(new RegExp(SENT, 'g')) ?? []).length, 1,
    'P-6-b ★文案本体只在定义处出现一次（description 与门禁都**引用常量**，不手抄）');
  ok(ws.split('\n').filter((l) => l.includes('EDIT_FILE_READ_FIRST')).length >= 3,
    'P-6-c ★write.ts 内至少三处引用常量（定义 / `edit_file.description` / 门禁 error）',
    `${ws.split('\n').filter((l) => l.includes('EDIT_FILE_READ_FIRST')).length} 处`);
  ok(/import \{ writeTools, EDIT_FILE_READ_FIRST \} from '\.\/tools\/write\.js'/.test(ae)
    && /\$\{EDIT_FILE_READ_FIRST\}/.test(ae),
    'P-6-d ★系统提示词**引用同一常量**（提示词与门禁同源，不是各写一份文案）');
  eq((ae.match(new RegExp(SENT, 'g')) ?? []).length, 0,
    'P-6-e ★系统提示词内**零**处手抄文案（全靠插值；手抄即"两处一份"的老形状）');

  // ── P-7 编码闸一处真源（静态）：三处读盘全过 `decodePlainText` ─────────────────────────
  const ov = RD(`${A}/src/main/core/output-validator.ts`);
  eq((ov.match(/readFileSync\([^)]*['"]utf-8['"]\)/g) ?? []).length, 0,
    'P-7-a ★`output-validator` 零处 `readFileSync(…,\'utf-8\')`（三处全过闸）');
  eq((ov.match(/function readTextThroughGate/g) ?? []).length, 1, 'P-7-b ★闸只有一份实现');
  eq((ov.match(/readTextThroughGate\(/g) ?? []).length, 4,
    'P-7-c ★一处定义 + 三处调用（`quickFileCheckAdaptive` / `quickFileCheck` / `llmSufficiencyCheck` 全走它）');
  ok(/import \{ decodePlainText \} from '\.\/doc-text\.js'/.test(ov),
    'P-7-d ★与 `read_file` **同一函数**（`doc-text.decodePlainText`），非另写一把尺');

  // ── P-8 ★GBK 不再误判（真跑 `validateOutput`）+ 旧尺读法的反证标本 ─────────────────────
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rr02-m17b-'));
  try {
    // 0xB0 0xA1 是 GBK「啊」；按 UTF-8 解 ⇒ 每个字节 U+FFFD（非法续字节）。造 >500 字节避开"文件过小"。
    const gbkBuf = Buffer.from(Array.from({ length: 400 }, () => [0xb0, 0xa1]).flat());
    const gbkPath = path.join(tmp2, 'gbk.md');
    fs.writeFileSync(gbkPath, gbkBuf);
    const res = await validateOutput({} as never, gbkPath, 'document');
    const issues = res.quickCheck.issues.join('；');
    ok(issues.includes('无法按 UTF-8/BOM 解码'),
      'P-8-a ★GBK 成果 ⇒ 如实报"解码不了"（不是"文件过小/缺少标题"那类内容判词）', issues.slice(0, 120));
    ok(!issues.includes('缺少') && !issues.includes('过小'),
      'P-8-b ★不再把"读错"冒充"内容不足"（旧 `…,\'utf-8\'` 解出 U+FFFD ⇒ 逐条判缺）');
    // 旧尺读法的反证标本：证明"为什么会误判"
    const legacy = gbkBuf.toString('utf-8');
    ok((legacy.match(/�/g) ?? []).length > legacy.length * 0.5,
      'P-8-c ★反证标本：旧写法解出过半是 U+FFFD（旧尺为何会逐条判"内容不足"）',
      `${(legacy.match(/�/g) ?? []).length}/${legacy.length}`);

    // P-9 该不命中：合法 UTF-8 文档快检照旧通过（闸只拦"解不出"，不误伤正常成果）
    fs.writeFileSync(path.join(tmp2, 'good.md'), '# 标题\n\n' + '正文内容'.repeat(200) + '\n\n结论：方案可行\n');
    const g = await validateOutput({} as never, path.join(tmp2, 'good.md'), 'document');
    ok(g.quickCheck.passed === true,
      'P-9 ★该不命中：合法 UTF-8 文档（>500B · 有标题 · 有结论）快检照旧通过', JSON.stringify(g.quickCheck.issues));
  } finally {
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════════
// 【I】哑雷专项 + build 钉
// ══════════════════════════════════════════════════════════════════
function groupI(): void {
  console.log('\n【I】哑雷专项 + build 钉（轮次一律由载体自身派生，不写轮次字面量）');
  const selfSrc = fs.readFileSync(__filename, 'utf-8');
  ok(selfSrc.length > 2000, 'I-1 扫描面自证：本文件源码非空（否则下面的"零命中"是空转假绿）', `${selfSrc.length} 字节`);
  const pat = new RegExp("'zx_\\d{8}(?:_\\d+)?'", 'g');
  const hits = (selfSrc.match(pat) ?? []).filter((s) => {
    const y = Number(s.slice(4, 8));
    return y >= 2020 && y <= 2030;
  });
  eq(hits, [], 'I-2 ★本文件内**零**处「只为下一轮为真」的轮次字面量（否则是只对下一轮引爆的哑雷）');
  const THIS = path.basename(__filename).replace(/\.ts$/, '');
  const relPlan = path.join('plans/improve', `${THIS.slice(3)}.md`);
  ok(fs.existsSync(path.join(root, relPlan)), 'I-3 ★方向性自指（由载体自身派生，非抄来的常量）：本轮方案文件在场', relPlan);
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

async function main(): Promise<void> {
  groupA();
  groupB();
  groupC();
  groupD();
  await groupE();
  groupF();
  groupG();
  groupH();
  await groupJ();
  groupK();
  groupL();
  groupM();
  groupN();
  groupO();
  await groupP();
  groupI();
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261002: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
