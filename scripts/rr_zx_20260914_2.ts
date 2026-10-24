/**
 * zx_20260914_2 受控复跑 —— M1「回得了话 · 消息到得了」（批 M1-A：main 侧）。
 *
 * ── 病根 ──
 *   M1-1 界面只能**看**（`im:conversations` 只读）、只能**重发别人的话**（`im:resend` 认 convId），
 *        不能自己说一句 ⇒ "回得了话"缺最后一环。而失败若自写一行 `'failed'`，就把
 *        「failed 对话行恰两处写者」这条不变量撑破（`rr_zx_20260913.ts:238`）。
 *   M1-2 非文本消息（图/文件/语音/视频）在**五家适配器**里一律 `return` 整条丢弃：
 *        用户以为"发了"，系统以为"没发"——两边都不知道对方不知道。更要命的是占位符若直接进
 *        指令管道，`[图片]`（恰 4 字）会触发兜底回话、长占位符（>4 字）会被**当自由文本建成任务**。
 *
 * ── 本文件怎么证的（承 feedback「rr 夹具须按生产初始化顺序」「往返须在生产入参上证」）──
 *   §S1 不是重写一遍 `im:send`，而是把**生产源码切片**取出来、用 `new Function` 挂上真库与**真
 *       `enqueueImOutbox`** 直接执行（生产分支 × 生产 SQL × 生产夹具）。SQL 改、失败分支改道、
 *       成功 INSERT 手写 status —— 任一处变动断言即红。渠道上限亦**从生产源码取出求值**，不手抄。
 *   §S2 五家适配器**各投一条非文本**，经**真 routeImMessage** 走完整入站链路，断言 inbound 行 0→1
 *       （正面断言，不只看"不抛"）；并反证"非文本不进指令管道"（同样入参不带 meta 即触发兜底回话）。
 *   §S3 落点穷举：五家适配器文件级各含非文本转正（断言名 = 扫描面，防只改四家）。
 *
 *   §S4 未读红点：**算只有一处**（全 `src/main/**` 扫 `COUNT(*)` × `'inbound'`，命中面恰 `im-unread.ts`）、
 *       **取只读**（handler 体内无写/无 refresh）、**两值同源**（`im:markRead` → `markImRead` → `refreshImUnread`
 *       → `computeImUnread` 同一条链），并用真 `im-unread.ts` 跑运行时：sink 序列如实、只读不改账。
 *   §S5 `messageViewOf` 直接 import **真实现**（纯函数零依赖）跑五类入参 + 反证（不裸抛 JSON / 不臆造徽标 /
 *       非 JSON 不抛）；并反证 renderer **不另立词表**（词表仍只在 im-adapter.ts 一处，此处只读回）。
 *   §S6 接线：本轮新增的每一处 main/renderer 代码**都有一条真调用**（防"做了没用上"）。
 *
 * ⚠ 本文件不打开任何真库（真库只读复核见 data/baseline_zx_20260914.json）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins } from './lib/rr-pins.js';
import { enqueueImOutbox } from '../apps/worker-ant-desktop/src/main/core/im/im-outbox.js';
import { sendManualImMessage, IM_SEND_TEXT_LIMIT } from '../apps/worker-ant-desktop/src/main/core/im/manual-send.js';
// zx_20260930 M2-d：出站长文本的**唯一发落点**——本脚本期望值由它派生（不抄常数）
import { fitOutboundText } from '../apps/worker-ant-desktop/src/main/core/im/im-text.js';
import { nonTextPlaceholder } from '../apps/worker-ant-desktop/src/main/services/im-adapter.js';
import { routeImMessage } from '../apps/worker-ant-desktop/src/main/services/im-router.js';
import { FeishuAdapter } from '../apps/worker-ant-desktop/src/main/services/feishu-adapter.js';
import { DingtalkAdapter } from '../apps/worker-ant-desktop/src/main/services/dingtalk-adapter.js';
import { WecomAdapter } from '../apps/worker-ant-desktop/src/main/services/wecom-adapter.js';
import { QqbotAdapter } from '../apps/worker-ant-desktop/src/main/services/qqbot-adapter.js';
import { WechatAdapter } from '../apps/worker-ant-desktop/src/main/services/wechat-adapter.js';
// M1-3 未读账**真实现**（模块本身 electron-free，故 rr 可直接跑它，不必切 handler 源码）
import { computeImUnread, refreshImUnread, markImRead, setImUnreadSink } from '../apps/worker-ant-desktop/src/main/core/im/im-unread.js';
// M1-4 渲染判定**真实现**（纯函数零依赖 —— 承「抽纯函数让 rr 跑真实现」）
import { messageViewOf } from '../apps/worker-ant-desktop/renderer/src/lib/messageView.js';
// M2-1 受限子集 Markdown **真实现**（renderer 下的 .tsx 亦被 tsx 直载、JSX 由 tsx 编译；
//   纯函数零依赖 ⇒ 承「抽纯函数让 rr 跑真实现」）。元素树断言直接在 React 元素对象上做，不需 DOM。
import { parseMarkdownSubset, parseInline } from '../apps/worker-ant-desktop/renderer/src/lib/markdown-subset.js';
import MarkdownSubset from '../apps/worker-ant-desktop/renderer/src/lib/markdown-subset.js';
// M2-3/M2-4 验收「一把尺」**真实现**（真函数、真 SQL）
import { annotateAcceptance, verifiedAcceptanceMap, markDeliverableAcceptanceVerified, docNotProbe } from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
// M2-2 白名单与上限**真源**（渲染层与 rr 读同一份，不手抄数字）
import { IMAGE_PREVIEW_MIME, IMAGE_PREVIEW_MAX_BYTES } from '../apps/worker-ant-desktop/src/main/core/deliverable-types.js';
// M2-2 图片预览判定/读取**真实现**（纯函数 + 注入 io ⇒ rr 可挂记调用替身证"未读盘"）
import { resolveImagePreview } from '../apps/worker-ant-desktop/src/main/core/image-preview.js';
// M2-5 工具元数据表**运行期真值**（注释里那个数字必须等于它）
import { TOOL_METAS } from '../apps/worker-ant-desktop/src/main/core/tool-registry.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) => ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
type AnyDb = import('better-sqlite3').Database;
const RD = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');
const app = (rel: string) => RD(`${A}/${rel}`);
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** 逐行**保留行号**地摘掉注释（供"读点定位"类断言；与 rr_zx_20260913 同法） */
function stripKeepingLines(s: string): string[] {
  let inBlock = false;
  return s.split('\n').map((l) => {
    let out = '';
    for (let i = 0; i < l.length; i++) {
      if (inBlock) { if (l[i] === '*' && l[i + 1] === '/') { inBlock = false; i++; } continue; }
      if (l[i] === '/' && l[i + 1] === '*') { inBlock = true; i++; continue; }
      if (l[i] === '/' && l[i + 1] === '/') break;
      out += l[i];
    }
    return out;
  });
}

// node:sqlite 无 better-sqlite3 的 .transaction()——补最小等价 shim（与其它 rr 同法）
const withTx = (d: DatabaseSync) => { (d as unknown as { transaction: unknown }).transaction = (fn: () => void) => () => fn(); return d; };

/** 夹具 schema：**照抄 database.ts 的 DDL**（含 DEFAULT——夹具比生产宽松即假绿）。
 *  `status TEXT DEFAULT 'sent'` 是「成功不手写 status」断言的立足点，必须与生产同字面。 */
const IM_SCHEMA = `
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, name TEXT DEFAULT '', config TEXT NOT NULL DEFAULT '{}', status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_im_conversations (
  id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, project_id TEXT,
  message_json TEXT DEFAULT '{}', direction TEXT DEFAULT 'inbound',
  created_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'sent', last_error TEXT DEFAULT '', outbox_id TEXT DEFAULT '');
CREATE TABLE wa_im_outbox (
  id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, task_id TEXT,
  kind TEXT DEFAULT 'notification', message TEXT DEFAULT '', attempts INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending', next_retry_at INTEGER,
  created_at TEXT DEFAULT (datetime('now')), last_error TEXT, last_attempt_at TEXT);
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
-- 反证段（§S2.3/§S2.4）要让占位符**走完整个路由**才现出"会被误处理"，故这几张表也要在。
-- 同样照抄 database.ts 的 DDL（列不齐即会在生产能过的地方抛错，反倒证明不了本想证的事）。
CREATE TABLE wa_projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', cron_schedule TEXT, working_dir TEXT DEFAULT '',
  context_json TEXT DEFAULT '{}', sandbox_mode TEXT DEFAULT 'workspace',
  owner_id TEXT, cron_timezone TEXT DEFAULT 'Asia/Shanghai',
  autonomous_mode TEXT DEFAULT 'off', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
  source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_task_conversations (
  id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL, content TEXT DEFAULT '',
  tool_calls TEXT, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
`;
const mkImDb = () => { const d = withTx(new DatabaseSync(':memory:')); d.exec(IM_SCHEMA); return d as unknown as AnyDb; };

/** 取 `needle` 之后**第一对花括号**包起来的整段（方法体）。不以圆括号收口——否则遇到
 *  `sendReply(a, b) { … }` 会在参数表的右括号处就"配平"收工，方法体整段取不到。 */
function methodBody(src: string, needle: string): string {
  const i = src.indexOf(needle);
  if (i < 0) return '';
  // zx_20260920 M4（订正的是**定位手法**，不是被测行为）：锚点有两种形态，须分开处置。
  //   (A) 锚点**本身就是声明头**（`async sendReply(`，以 `(` 收尾）——参数表在锚点**之后**，
  //       且参数表里可以自带花括号：`…, opts?: { recordConversation?: boolean }`。
  //       旧写法取锚点之后**第一个** `{`，切到的是**参数类型字面量**，方法体一个字都取不到
  //       ⇒ 对**正确代码**报"没有截断"（假红）。故此处须先配平 `(`/`)` 再取 `{`。
  //   (B) 锚点是**调用/声明的一段前缀**（`ipcMain.handle('im:unread',`，不以 `(` 收尾）——
  //       体就是其后的第一个 `{`（`async () => {`）。旧写法在此形态下是对的，**保持逐字不变**。
  //   同族教训：rr_zx_20260920 的 R-1「切到返回类型字面量」（feedback_criteria_must_be_satisfiable）。
  let b: number;
  if (needle.endsWith('(')) {
    const open = i + needle.length - 1;
    let pd = 0; let close = -1;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '(') pd++;
      else if (src[j] === ')') { pd--; if (pd === 0) { close = j; break; } }
    }
    if (close < 0) return '';
    b = src.indexOf('{', close);
  } else {
    b = src.indexOf('{', i);
  }
  if (b < 0) return '';
  let depth = 0;
  for (let j = b; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(b, j + 1); }
  }
  return '';
}

/** INSERT 的**列集**（跨文件同尺的对齐依据）。 */
const insertCols = (sql: string): string[] =>
  (/INSERT INTO wa_im_conversations\s*\(([^)]*)\)/.exec(sql)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);

/** 取适配器 `sendReply` 方法体——"在哪儿截"必须落在**出站正文**上，故只在方法体内找。 */
const sendReplyBody = (adapter: string): string => methodBody(stripComments(app(`src/main/services/${adapter}-adapter.ts`)), 'async sendReply(');

/** 受控复跑直调**生产函数本体**（`core/im/manual-send.ts`），不再切 handler 源码。
 *  理由有二：① `im:send` handler 整段含 TS 类型标注，`new Function` 无法直接执行；
 *  ② 抽真源让 rr 跑真实现（与 `im-conversations-query.ts` 同一手法），比"对着切片"更强。 */
function sendCall(db: AnyDb, adapters: Map<string, unknown>, emitted: Array<Record<string, unknown>>) {
  return (args: { channelId: string; externalUserId: string; text: string }) =>
    sendManualImMessage(
      {
        db: db as never,
        adapters: adapters as never,
        emit: (p: Record<string, unknown>) => { emitted.push(p); },
      },
      args,
    );
}

const convRows = (db: AnyDb) => db.prepare('SELECT id, direction, status, message_json, last_error FROM wa_im_conversations').all() as Array<Record<string, unknown>>;
const outboxRows = (db: AnyDb) => db.prepare('SELECT id, status, last_error, kind, task_id FROM wa_im_outbox').all() as Array<Record<string, unknown>>;
const errCode = (r: unknown) => (r as { error?: { code?: string } }).error?.code;

// ─────────────────────────────────────────────────────────────
// §S1 M1-1 `im:send`：生产切片 × 真库 × 真 enqueueImOutbox
// ─────────────────────────────────────────────────────────────
function s1Static(): void {
  console.log('\n[S1.1 `im:send` 真源在库（改 SQL / 改道 / 手写 status 即红）]');
  const src = stripComments(app('src/main/core/im/manual-send.ts'));
  ok(src.includes('SELECT channel_type FROM wa_im_channels WHERE id = ?'), '先查渠道类型（上限"按渠道取"的前提）');
  // ⚠ zx_20260920 M4：末位多了 `opts`。原判据钉的是**调用形状**（含右括号），改实现即红 ——
  //   改为钉**不变量**：① 确实 await 了适配器、`(externalUserId, <正文>)` 业务两参**次序未变**（尾随参数不设限）；
  //   ② 新半条：该跳**必须**传 `recordConversation:false`（落账归本函数，适配器只发不记）。
  // ⚠ zx_20260930 M2-d 重钉：② 那半条不变；① 的第二个实参由 `body`（用户敲的原文）变成 `fitted.text`
  //   （**定形后**那串）——这是本轮刻意的行为变更，不是改名：本函数既负责落账，就必须让
  //   「发出去的」与「账上记的」是**同一个值**，而不是两处各自算一遍（那正是"账与实物两个值"）。
  //   仍钉"两参次序 + 尾随参数不设限"这个不变量，只是把第二参钉到那条更严的路径上。
  ok(/const fitted = fitOutboundText\(channelType, body\);/.test(src),
    '发落经**唯一真源** `fitOutboundText(channelType, body)`（不在此另判"要不要截/要不要提示"）');
  ok(/await adapter\.sendReply\(externalUserId, fitted\.text, undefined, \{ recordConversation: false \}\)/.test(src),
    '★ 该跳发的是 `fitted.text`，且传 `recordConversation:false` —— 落账归本函数（适配器只发不记），'
    + '否则一次手发**两个气泡**；配上一条，账 = 实物同一串');

  // 跨文件同尺：手工回话的成功行与 `im:resend` 的成功行**列集逐字相同**（少一列即两处各说各话）
  const myCols = insertCols(src);
  const resendSql = (app('src/main/ipc/im.ipc.ts').match(/INSERT INTO wa_im_conversations[\s\S]{0,160}?'outbound', datetime\('now'\)\)/g) || [])
    .map((s) => insertCols(s)).filter((c) => c.length > 0);
  ok(myCols.length >= 6, `成功 INSERT 列集取到（${myCols.join(',')}）`);
  eq(resendSql.some((c) => JSON.stringify(c) === JSON.stringify(myCols)), true,
    '成功 INSERT 与 im:resend 同一列集（同尺，不是各拍一份）');
  ok(!/\bstatus\b/.test(src.slice(src.indexOf('INSERT INTO wa_im_conversations'), src.indexOf('emit({'))),
    '反证：成功 INSERT **不手写 status**（靠列 DEFAULT，一处真源）');
  ok(/enqueueImOutbox\(db, \{ channelId, externalUserId, taskId: '', kind: 'manual_reply', message: body \}, \(err as Error\)\.message \|\| String\(err\)\)/.test(src),
    "失败分支走 enqueueImOutbox（唯一记账点；taskId 传 '' 如实表示无关联任务）");
  ok(!/'failed'/.test(src), '反证：真源内**不含** \'failed\' 字面量（不可能自写第三处 failed 写者）');
  ok(src.includes("code: 'NO_ADAPTER'"), '无适配器有明确错误码（与 im:resend 同码）');

  console.log('\n[S1.1b 接线：im:send handler 只做委托，不另留一份判定（两处各写一份即红）]');
  const ipc = stripComments(app('src/main/ipc/im.ipc.ts'));
  ok(/ipcMain\.handle\('im:send'[\s\S]{0,220}?sendManualImMessage\(\{ db, adapters: activeAdapters \}, \{ channelId, externalUserId, text \}\)/.test(ipc),
    'handler 把真源函数与**同一张 activeAdapters** 一起传入（不是另建一张表）');
  ok(!/INSERT INTO wa_im_conversations[\s\S]{0,200}?'outbound', datetime\('now'\)\)[\s\S]{0,80}?manual/.test(ipc),
    '反证：handler 内不再自带手发 INSERT（判定搬走后不留复制品）');

  console.log('\n[S1.2 渠道上限来自生产、且与适配器真实截断点同值（"在哪儿截就在哪儿拦"）]');
  eq(IM_SEND_TEXT_LIMIT, { qqbot: 4000 }, '生产 IM_SEND_TEXT_LIMIT 恰 { qqbot: 4000 }（其余四家不设人为上限）');
  const qqBody = sendReplyBody('qqbot');
  ok(qqBody.length > 0, 'QQ `sendReply` 方法体取到');
  // zx_20260920 M4 补**前置断言**：切到的必须是**方法体**（含语句），不是参数类型字面量。
  //   没有这条时，定位手法一旦切错块，下面那条"没有截断"会变成**假红**——
  //   而一条对正确代码也红的判据，等于没有判据（真正有病时也一样看不见）。
  ok(/await |const |this\.|if \(/.test(qqBody) && qqBody.length > 60,
    '前置：切到的是**方法体**而非参数类型字面量（防定位切错块后的假红）', `len=${qqBody.length}`);
  // 改钉（zx_20260929 M8-a）：原来钉"适配器里那个数字 === 本表里的数字"——那钉的是**两处各有一个数**，
  //   只要求它们恰好相等；且截断是**静默**的（不告知）。现在适配器不再自带数字，改**取同一张表**、
  //   走**同一个截断函数**，故钉结构（"同一个真源"比"两个数相等"强：后者抄错一次就分家）。
  // 再改钉（zx_20260930 M2-d）：发落由 `im-text.ts` 的 `fitOutboundText` **一处判**（有上限才截并告知 /
  //   无上限不截只提示）⇒ 适配器里连上限表**也不该再直接读**了，它只答"交给谁定形"。
  //   钉"调用同一个发落函数"比钉"调用同一个截断函数"更强：后者仍允许各家自己决定要不要截。
  ok(/fitOutboundText\('qqbot',\s*text\)/.test(qqBody),
    "QQ 出站正文交**唯一发落点** `fitOutboundText('qqbot', text)`（该截该说只此一处判）");
  ok(!/clipWithNotice\(/.test(qqBody) && !/IM_SEND_TEXT_LIMIT/.test(qqBody),
    '反证：QQ 适配器不再直接读上限表 / 直接调截断（发落判据只许留在 im-text.ts 一处）');
  ok(!/text\.slice\(0,\s*\d+\)/.test(qqBody),
    '反证：QQ 不再自写裸 `slice(0, N)` —— 数字与"截了不说"都不许各拍一份');
  ok(/import \{[^}]*fitOutboundText[^}]*\} from '\.\.\/core\/im\/im-text\.js'/.test(app('src/main/services/qqbot-adapter.ts')),
    '前置：本家**确实 import 了**发落函数（防"切到的是别的块"与"调用了个悬空名"两种假绿）');
  for (const n of ['feishu', 'wechat', 'dingtalk', 'wecom']) {
    const body = sendReplyBody(n);
    ok(body.length > 0 && !/\btext\.slice\(/.test(body),
      `反证：${n} 的 sendReply 不截正文 ⇒ 界面也不该凭空设限`);
  }
}

async function s1Run(): Promise<void> {
  console.log('\n[S1.3 无适配器 ⇒ NO_ADAPTER 且不落任何行（防"报了错却记了账"）]');
  {
    const db = mkImDb();
    db.prepare("INSERT INTO wa_im_channels (id, channel_type) VALUES ('ch1', 'wechat-personal')").run();
    const send = sendCall(db, new Map(), []);
    const res = await send({ channelId: 'ch1', externalUserId: 'u1', text: '在吗' });
    eq(errCode(res), 'NO_ADAPTER', '无适配器 ⇒ NO_ADAPTER');
    eq(convRows(db).length, 0, '不落任何对话行');
    eq(outboxRows(db).length, 0, '不落任何补发账行');
  }

  console.log('\n[S1.4 校验失败 ⇒ 拒绝且不落行]');
  {
    const db = mkImDb();
    db.prepare("INSERT INTO wa_im_channels (id, channel_type) VALUES ('ch1', 'wechat-personal')").run();
    let called = 0;
    const adapters = new Map<string, unknown>([['ch1', { sendReply: async () => { called++; } }]]);
    const send = sendCall(db, adapters, []);
    eq(errCode(await send({ channelId: 'ch1', externalUserId: 'u1', text: '   ' })), 'NO_CONTENT', '全空白 ⇒ NO_CONTENT');
    eq(errCode(await send({ channelId: '', externalUserId: 'u1', text: 'x' })), 'BAD_REQUEST', '缺渠道 ⇒ BAD_REQUEST');
    eq(errCode(await send({ channelId: 'nope', externalUserId: 'u1', text: 'x' })), 'NOT_FOUND', '渠道不存在 ⇒ NOT_FOUND');
    eq(called, 0, '三种拒绝都**没走到适配器**');
    eq(convRows(db).length + outboxRows(db).length, 0, '三种拒绝均不落行');
  }

  console.log('\n[S1.5 上限按渠道取：qqbot 超 4000 拒且不落行；其余渠道同长度放行]');
  {
    const db = mkImDb();
    db.prepare("INSERT INTO wa_im_channels (id, channel_type) VALUES ('q', 'qqbot'), ('w', 'wechat-personal')").run();
    const sent: string[] = [];
    const adapters = new Map<string, unknown>([
      ['q', { sendReply: async (_u: string, t: string) => { sent.push(`q:${t.length}`); } }],
      ['w', { sendReply: async (_u: string, t: string) => { sent.push(`w:${t.length}`); } }],
    ]);
    const emitted: Array<Record<string, unknown>> = [];
    const send = sendCall(db, adapters, emitted);
    const long = 'x'.repeat(4001);
    const rq = await send({ channelId: 'q', externalUserId: 'u1', text: long }) as { error?: { code?: string; message?: string } };
    eq(rq.error?.code, 'TOO_LONG', 'qqbot 4001 字 ⇒ TOO_LONG');
    ok(String(rq.error?.message || '').includes('4000'), '错误文案**如实报出上限数字**（不代用户截断）', rq.error?.message);
    const rw = await send({ channelId: 'w', externalUserId: 'u1', text: long }) as { data?: { sent?: boolean; note?: string } };
    ok(!!rw.data?.sent, '同长度在 wechat-personal **放行**（证"上限按渠道取"而非一刀切）');
    ok(String(rw.data?.note || '').includes('主动推送'), '微信个人号如实附上配额口径提示（与 im:resend 同说）');
    // zx_20260930 M2-d 重钉：wechat-personal **没有**登记上限，但 4001 字已越过告知阈值
    //   ⇒ 本轮刻意改为"一字不截 + 末尾如实附一句"。期望长度**由生产函数派生**（不是抄来的常数）。
    eq(sent, [`w:${fitOutboundText('wechat-personal', long).text.length}`],
      '适配器恰被调用 1 次，且收到的是**本函数定形后**那串（qqbot 那次在 adapter 之前就被拒）');
    ok(fitOutboundText('wechat-personal', long).text.length > long.length,
      '（上面那条的**前提**：无上限通道超阈值确实会被附一句 —— 否则该断言与"发原文"无从分辨）');
    eq([emitted.length, emitted[0]?.channelType, emitted[0]?.pending], [1, 'wechat-personal', undefined],
      '成功恰发 1 条出站事件、带渠道类型、且**不带 pending**（"发出去了"就是发出去了）');
    const rows = convRows(db);
    eq(rows.length, 1, '恰 1 行落库（qqbot 拒绝不落行）');
    eq(rows[0]!.status, 'sent', '成功行 status 来自**列 DEFAULT**（非手写）');
    eq(rows[0]!.direction, 'outbound', '方向为 outbound');
    ok(String(rows[0]!.message_json).includes('"manual":true'), '手发消息如实标记 manual（与自动/重发可区分）');
    eq(rows[0]!.last_error, '', '成功行无错误原因');
  }

  console.log('\n[S1.6 失败 ⇒ 真 enqueueImOutbox：补发账 + failed 对话行 + 真原因一处记全]');
  {
    const db = mkImDb();
    db.prepare("INSERT INTO wa_im_channels (id, channel_type) VALUES ('ch1', 'wechat-personal')").run();
    const adapters = new Map<string, unknown>([['ch1', { sendReply: async () => { throw new Error('iLink 429 quota'); } }]]);
    const emitted: Array<Record<string, unknown>> = [];
    const send = sendCall(db, adapters, emitted);
    const res = await send({ channelId: 'ch1', externalUserId: 'u1', text: '你好' }) as { error?: { code?: string; message?: string } };
    eq(res.error?.code, 'SEND_FAILED', '失败 ⇒ SEND_FAILED（如实回话，不假装已送达）');
    ok(String(res.error?.message || '').includes('iLink 429 quota'), '错误回话带**真因**', res.error?.message);
    const ob = outboxRows(db);
    eq(ob.length, 1, '补发账恰 1 行（0→1 正面断言）');
    eq(ob[0]!.status, 'pending', '补发账落 pending（自动获得补发/重试）');
    eq(ob[0]!.kind, 'manual_reply', '手发失败如实记 kind=manual_reply');
    eq(ob[0]!.task_id, '', 'task_id 为空串（不塞假 id；列表 LEFT JOIN 得 null 标题）');
    eq(ob[0]!.last_error, 'iLink 429 quota', '真原因落在补发账上');
    const cv = convRows(db);
    eq(cv.length, 1, 'failed 对话行也落 1 行（未送达也到场）');
    eq(cv[0]!.status, 'failed', '对话行 status=failed 由 recordFailedConversation 写');
    eq(cv[0]!.last_error, 'iLink 429 quota', '对话行同带真原因（一处记账，两处同说）');
  }

  console.log('\n[S1.7 不变量回访（与 rr_zx_20260913 同一 8 文件扫描面）]');
  {
    const IM_FILES = [
      'src/main/core/im/im-outbox.ts', 'src/main/core/im/reply-accounting.ts', 'src/main/core/im/manual-send.ts', 'src/main/ipc/im.ipc.ts', 'src/main/services/im-router.ts',
      'src/main/services/wechat-adapter.ts', 'src/main/services/dingtalk-adapter.ts', 'src/main/services/wecom-adapter.ts',
      'src/main/services/feishu-adapter.ts', 'src/main/services/qqbot-adapter.ts',
      // zx_20260930 M2-c: 出站行的唯一落点（五家适配器 9 处内联已迁入）——扫描面跟着写入者走。
      'src/main/core/im/outbound-record.ts',
    ];
    const insertLines: Array<{ file: string; line: string }> = [];
    for (const f of IM_FILES) {
      for (const l of stripKeepingLines(app(f))) {
        if (l.includes('INSERT INTO wa_im_conversations')) insertLines.push({ file: path.basename(f), line: l });
      }
    }
    // zx_20260929 M8-c（**改钉更强的真源，非放宽**）：失败行的状态值已移入绑定参数
    //   （failed / blocked_quota 同一张表），`'failed'` 字面量只剩 im-outbox 一家 ⇒ 旧判据假红。
    //   改以**是否显式写 status 列**为据：列 DEFAULT='sent' 只管成功行，写 status 者即失败行写者。
    const statusWriters = insertLines.filter((x) => /\bstatus\b/.test(x.line));
    eq(statusWriters.map((x) => x.file).sort(), ['im-outbox.ts', 'im.ipc.ts', 'reply-accounting.ts'],
      'failed 对话行写入**恰三处**（im:send 的失败分支仍走 enqueueImOutbox；第三处是 zx_20260920 M2 的机器回话失败记账点）（以"写 status 列"为据）');
    eq(statusWriters.length, 3, '显式写 status 列的 INSERT 恰 3 处（im:send 成功行靠列 DEFAULT）');
    ok(!insertLines.some((x) => x.line.includes("'sent'")),
      '反证：无一 INSERT 手写 status=\'sent\'（送达态一处真源 = 列 DEFAULT）');
    // zx_20260930 M2-c（**改钉更强的真源，非放宽**）：出站行形状收成**一处**——旧判据"INSERT 读点 ≥10"
    //   在 9 处内联迁走后必然下跌，故改为钉**形状**（适配器零内联 + 落点含 task_id），下界只作自证。
    const ADAPTER_FILES = ['wechat', 'dingtalk', 'wecom', 'feishu', 'qqbot'].map((n) => `src/main/services/${n}-adapter.ts`);
    eq(ADAPTER_FILES.filter((f) => app(f).includes('INSERT INTO wa_im_conversations')), [],
      '五家适配器**零内联**出站 INSERT（出站行已迁入 `outbound-record.ts` 单一落点）');
    ok(/INSERT INTO wa_im_conversations[\s\S]{0,200}?task_id/.test(app('src/main/core/im/outbound-record.ts')),
      '落点那一句 INSERT 的**列清单含 task_id**（M2-c 靶心：这一行答得出"属于哪个任务"）');
    ok(insertLines.length >= 8, `对话表 INSERT 读点下界成立（实测 ${insertLines.length} ≥ 8；五家 9 处内联 → 落点 1 处，净减 8）`);
  }
}

// ─────────────────────────────────────────────────────────────
// §S2 M1-2 五家适配器非文本入站（真路由链路）
// ─────────────────────────────────────────────────────────────
type Handler = (from: string, text: string, chatType: string, ctx: string, meta?: Record<string, unknown>) => unknown;

/** 把适配器回调接到**真 routeImMessage** 上（生产入站链路），收集回话 */
function wire(adb: AnyDb, channelId: string, channelType: string) {
  const replies: string[] = [];
  const ictx = { db: adb, channelId, channelType, sendReply: async (_to: string, t: string) => { replies.push(t); } };
  return {
    replies,
    handler: (from: string, text: string, chatType: string, ctx: string, meta?: Record<string, unknown>) =>
      routeImMessage(ictx as never, from, text, chatType, ctx, meta as never),
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
/** 多让出几轮宏任务。M3 起入站链路多了 `await` 环节（取件落盘 + 回执），单次 tick 不足以保证走完。 */
const settle = async () => { for (let i = 0; i < 3; i++) await tick(); };

/**
 * 替身 `fetch`：把网络边界关掉（rr **不打真网**），按 URL 给应答，返回还原函数。
 *
 * 承「可注入的桩口：只包网络边界」的既有手法——`im-media.fetchInboundMedia` 走 `globalThis.fetch`，
 * 故这里替的是**边界**，被测的生产逻辑（分派/落盘/回话）一个字都没被替掉。
 */
function stubFetch(handler: (url: string) => { status?: number; json?: unknown; body?: Buffer; contentType?: string }): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String(input);
    const r = handler(url);
    const bytes = r.body ?? Buffer.from(JSON.stringify(r.json ?? {}));
    return new Response(bytes, { status: r.status ?? 200, headers: { 'content-type': r.contentType ?? 'application/json' } });
  }) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

async function s2(): Promise<void> {
  console.log('\n[S2.1 占位符一处真源（词表只有一份，五家不各抄）]');
  eq(nonTextPlaceholder('image'), '[图片]', 'image → [图片]');
  eq(nonTextPlaceholder('file', 'report.pdf', 1258291), '[文件 report.pdf 1.2MB]', 'file + 名字 + 大小 → 真值上屏');
  eq(nonTextPlaceholder('file', 'report.pdf'), '[文件 report.pdf]', '只给名字就不写大小（不编造）');
  eq(nonTextPlaceholder('voice'), '[语音]', 'voice → [语音]');
  eq(nonTextPlaceholder('3'), '[语音]', 'wechat type=3 → [语音]（有据映射：既有 extractText 即把 3 解读为语音）');
  eq(nonTextPlaceholder('2'), '[其他消息(2)]', '未知类型**原样带出**，不猜名字');

  console.log('\n[S2.2 五家各投一条非文本 ⇒ 恰 +1 行 inbound 且带类型标记（0→1 正面断言）]');
  { // ① 飞书
    // ⚠ zx_20260924 M3 订正：本夹具原断言「飞书：**不自动回话**」——那是 `image_key` **无人消费**时的真相。
    //   M3 起 `image_key` 成了**取件标识**（`im/v1/messages/{id}/resources/{key}?type=image`），
    //   "取了件就必须回一句"（成功的报落点、失败的明说没能落盘）——故这条按新语义拆成**两只标本**，
    //   并**关掉网络边界**（`stubFetch`）与用**临时 dataDir**（不往仓库写盘）：
    //     ①-1 取不到 token ⇒ 回"没能落盘"+真因，真因落在该行 `last_error`
    //     ①-2 取回字节 ⇒ 报落点，且**盘上真有那个文件、字节数相符**
    const feishuMsg = (id: string) => ({
      message: { message_type: 'image', content: JSON.stringify({ image_key: 'k1' }), chat_id: 'oc_x', chat_type: 'p2p', message_id: id },
      sender: { sender_type: 'user', sender_id: { open_id: 'uf' } },
    });
    const cast = (a: FeishuAdapter) => a as unknown as { handleSdkMessage(r: unknown): Promise<void> };

    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-m3-fs-fail-'));
    try { // ①-1 取件失败（拿不到 tenant token）
      const db = mkImDb();
      const w = wire(db, 'ch-f', 'feishu');
      const ad = new FeishuAdapter(db, 'ch-f', { appId: 'a', appSecret: 's' }, dir1);
      ad.onMessage(w.handler as never);
      const restore = stubFetch(() => ({ json: { code: 99, msg: 'invalid app' } }));
      try { await cast(ad).handleSdkMessage(feishuMsg('mf1')); } finally { restore(); }
      await settle();
      const rows = convRows(db);
      eq(rows.length, 1, '飞书 ①-1：inbound 行 0→1（**行照落**，不因取件失败回滚）');
      ok(String(rows[0]!.message_json).includes('"kind":"image"'), '飞书 ①-1：message_json 含 kind=image', String(rows[0]!.message_json));
      eq(w.replies.length, 1, '飞书 ①-1：**取了件就必须回一句**——不许把"我丢了"说成"我收了"');
      ok(/没能落盘/.test(w.replies[0] || ''), '飞书 ①-1：回话**明说"没能落盘"**', w.replies[0]);
      ok(String(rows[0]!.last_error || '').length > 0, '飞书 ①-1：真因落在该行 `last_error`（既有列，不新造列）', String(rows[0]!.last_error));
    } finally { fs.rmSync(dir1, { recursive: true, force: true }); }

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-m3-fs-ok-'));
    try { // ①-2 取件成功（token + 字节都取回）
      const db = mkImDb();
      const w = wire(db, 'ch-f2', 'feishu');
      const ad = new FeishuAdapter(db, 'ch-f2', { appId: 'a', appSecret: 's' }, dir2);
      ad.onMessage(w.handler as never);
      const seen: string[] = [];
      const restore = stubFetch((url) => {
        seen.push(url);
        if (url.includes('tenant_access_token')) return { json: { code: 0, tenant_access_token: 't-1' } };
        return { body: Buffer.from('PNGDATA-1234'), contentType: 'image/png' };
      });
      try { await cast(ad).handleSdkMessage(feishuMsg('mf2')); } finally { restore(); }
      await settle();
      const rows = convRows(db);
      eq(rows.length, 1, '飞书 ①-2：inbound 行 0→1');
      ok(/\/messages\/mf2\/resources\/k1\?type=image/.test(seen.join(' ')),
        '飞书 ①-2：取件地址按官方形状现拼 `…/messages/{id}/resources/{key}?type=image`（图片走 type=image）', seen.join(' '));
      const saved = /"saved_path":"([^"]+)"/.exec(String(rows[0]!.message_json))?.[1] || '';
      ok(saved.length > 0, '飞书 ①-2：落盘成功 ⇒ `saved_path` 写进入站行（"盘上哪一份"留在这一行）', saved);
      ok(saved.startsWith(path.join(dir2, 'attachments')), '飞书 ①-2：落在 `<dataDir>/attachments/`（**不另造落盘路径**）', saved);
      eq(saved ? fs.readFileSync(saved).length : -1, 12, '飞书 ①-2：盘上**真有那个文件且字节数相符**（不是只记了个路径）');
      eq(w.replies.length, 1, '飞书 ①-2：取了件回一句（落盘成功）');
      ok(/已落盘/.test(w.replies[0] || ''), '飞书 ①-2：回话报**落点**', w.replies[0]);
    } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
  }
  { // ② 企业微信（方案原文漏列的第五家）
    // ⚠ zx_20260924 M3 订正：原夹具只投 `{MsgType:'image'}`（**无 MediaId**）⇒ 走"平台没给路"那一支，
    //   断言「不自动回话」在当时为真，但它证不到取件路。现拆两只标本（承「两只标本」纪律）：
    //     ②-1 有 `MediaId`（自建应用回调的 PascalCase 字段）⇒ gettoken → media/get 取字节 → 落盘 + 回执
    //     ②-2 拿不到 token ⇒ 行照落 + 真因进 `last_error` + 回话**明说"没能落盘"**
    const wecomMsg = (id: string) => ({
      MsgType: 'image', FromUserName: 'uw', ToUserName: 'bot', MsgId: id, MediaId: 'MEDIA-1',
    });
    const dirW = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-m3-wc-'));
    try { // ②-1 取件成功
      const db = mkImDb();
      const w = wire(db, 'ch-w', 'wecom');
      const ad = new WecomAdapter(db, 'ch-w', { corpId: 'a', corpSecret: 's', agentId: '1' }, dirW);
      ad.onMessage(w.handler as never);
      const seen: string[] = [];
      const restore = stubFetch((url) => {
        seen.push(url);
        if (url.includes('/gettoken')) return { json: { errcode: 0, access_token: 'tok-1', expires_in: 7200 } };
        return { body: Buffer.from('WXMEDIA'), contentType: 'image/jpeg' };
      });
      try { await ad.handleMessagePayload(wecomMsg('mw1')); } finally { restore(); }
      await settle();
      const rows = convRows(db);
      eq(rows.length, 1, '企微 ②-1：inbound 行 0→1（此前 `MsgType !== \'text\'` 整条丢弃）');
      ok(String(rows[0]!.message_json).includes('"kind":"image"'), '企微 ②-1：message_json 含 kind=image');
      ok(seen.some((u) => /\/media\/get\?access_token=tok-1&media_id=MEDIA-1/.test(u)),
        '企微 ②-1：取件地址按官方形状现拼 `media/get?access_token=…&media_id=…`（token 走 query）', seen.join(' '));
      const saved = /"saved_path":"([^"]+)"/.exec(String(rows[0]!.message_json))?.[1] || '';
      ok(saved.startsWith(path.join(dirW, 'attachments')),
        '企微 ②-1：落在 `<dataDir>/attachments/`（**不另造落盘路径**）', saved);
      eq(saved ? fs.readFileSync(saved).length : -1, 7, '企微 ②-1：盘上真有那个文件且字节数相符');
      eq(w.replies.length, 1, '企微 ②-1：取了件回一句（成功报落点）');
      ok(/已落盘/.test(w.replies[0] || ''), '企微 ②-1：回话报落点', w.replies[0]);
      // ⚠ 已确认的边界（**挂账，不是判据**）：自建应用回调能否推送 `MsgType=file` 尚无官方依据
      //   （社区多为"不推送"）⇒ 本家取件路对 image/voice/video 成立，对 file 待联调。
    } finally { fs.rmSync(dirW, { recursive: true, force: true }); }

    const dirWf = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-m3-wc-fail-'));
    try { // ②-2 取件失败（拿不到 access_token）
      const db = mkImDb();
      const w = wire(db, 'ch-w2', 'wecom');
      const ad = new WecomAdapter(db, 'ch-w2', { corpId: 'a', corpSecret: 's', agentId: '1' }, dirWf);
      ad.onMessage(w.handler as never);
      const restore = stubFetch(() => ({ json: { errcode: 40013, errmsg: 'invalid corpid' } }));
      try { await ad.handleMessagePayload(wecomMsg('mw2')); } finally { restore(); }
      await settle();
      const rows = convRows(db);
      eq(rows.length, 1, '企微 ②-2：取件失败 ⇒ 行**照落**（不因取件失败回滚）');
      eq(w.replies.length, 1, '企微 ②-2：取了件就必须回一句——不许把"我丢了"说成"我收了"');
      ok(/没能落盘/.test(w.replies[0] || ''), '企微 ②-2：回话**明说"没能落盘"**', w.replies[0]);
      ok(String(rows[0]!.last_error || '').length > 0, '企微 ②-2：真因落在该行 `last_error`（既有列，不新造列）',
        String(rows[0]!.last_error));
      ok(!fs.existsSync(path.join(dirWf, 'attachments')),
        '企微 ②-2：**盘上没留半成品**（失败不落空文件，`attachments/` 都没建）');
    } finally { fs.rmSync(dirWf, { recursive: true, force: true }); }
  }
  { // ③ QQ
    // ⚠ zx_20260924 M3 订正：原夹具的附件**没有 `url`** ⇒ 同样只走到了"没路"那一支。现两只标本：
    //     ③-1 `attachments[0].url`（平台 CDN，**自带签名**）⇒ 收到即取（链接有时效，不做暂存）
    //     ③-2 无 `url` ⇒ **不尝试取件、不回话**（"没给路" ≠ "取件失败"，不许凭空多一句失败回话）
    const castQ = (a: QqbotAdapter) => a as unknown as { handleMessage(t: string, d: Record<string, unknown>): Promise<void> };
    const qqMsg = (id: string, withUrl: boolean) => ({
      author: { user_openid: 'uq' }, content: '', id,
      attachments: [{ content_type: 'image/jpeg', filename: 'pic.jpg', size: 2048, ...(withUrl ? { url: 'https://cdn.example/p.jpg?sig=1' } : {}) }],
    });

    const dirQ = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-m3-qq-ok-'));
    try { // ③-1 取件成功
      const db = mkImDb();
      const w = wire(db, 'ch-q', 'qqbot');
      const ad = new QqbotAdapter(db, 'ch-q', { appId: 'a', clientSecret: 's' }, dirQ);
      ad.onMessage(w.handler as never);
      const seen: string[] = [];
      const restore = stubFetch((url) => { seen.push(url); return { body: Buffer.from('CDNBYTES!'), contentType: 'image/jpeg' }; });
      try { await castQ(ad).handleMessage('C2C_MESSAGE_CREATE', qqMsg('mq1', true)); } finally { restore(); }
      await settle();
      const rows = convRows(db);
      eq(rows.length, 1, 'QQ ③-1：inbound 行 0→1（此前 `if (!content) return` 丢弃）');
      ok(String(rows[0]!.message_json).includes('"kind":"image"'), 'QQ ③-1：message_json 含 kind=image');
      ok(String(rows[0]!.message_json).includes('pic.jpg'), 'QQ ③-1：附件文件名如实带上（真值）');
      ok(String(rows[0]!.message_json).includes('"size_bytes":2048'), 'QQ ③-1：附件字节数如实带上（真值，非估算）');
      ok(seen.some((u) => u.includes('cdn.example/p.jpg')),
        'QQ ③-1：**直接 GET `attachments[0].url`**（平台 CDN 自带签名，故不带任何鉴权头）', seen.join(' '));
      const saved = /"saved_path":"([^"]+)"/.exec(String(rows[0]!.message_json))?.[1] || '';
      ok(saved.startsWith(path.join(dirQ, 'attachments')), 'QQ ③-1：落在 `<dataDir>/attachments/`', saved);
      ok(saved.endsWith('pic.jpg'), 'QQ ③-1：件名用平台声明的 `pic.jpg`（不是另起的 `im-<时间戳>`）', saved);
      eq(saved ? fs.readFileSync(saved).length : -1, 9, 'QQ ③-1：盘上真有那个文件且字节数相符');
      eq(w.replies.length, 1, 'QQ ③-1：取了件回一句');
      ok(/已落盘/.test(w.replies[0] || ''), 'QQ ③-1：回话报落点', w.replies[0]);
    } finally { fs.rmSync(dirQ, { recursive: true, force: true }); }

    { // ③-2 反证：没给 `url` ⇒ 不取件、不回话
      const db = mkImDb();
      const w = wire(db, 'ch-q2', 'qqbot');
      const ad = new QqbotAdapter(db, 'ch-q2', { appId: 'a', clientSecret: 's' });
      ad.onMessage(w.handler as never);
      const restore = stubFetch(() => { throw new Error('没给路却去取件了'); });
      try { await castQ(ad).handleMessage('C2C_MESSAGE_CREATE', qqMsg('mq2', false)); } finally { restore(); }
      await settle();
      const rows = convRows(db);
      eq(rows.length, 1, 'QQ ③-2：无 `url` ⇒ 行仍落（"收到过一条图"是事实）');
      ok(!String(rows[0]!.message_json).includes('saved_path'), 'QQ ③-2：没有 `saved_path`（没取件）');
      eq(w.replies.length, 0, 'QQ ③-2：**不回话**——"平台没给路"不是"取件失败"，凭它多一句失败回话就是谎报');
    }
  }
  { // ④ 钉钉
    // ⚠ zx_20260924 M3 订正：本夹具原喂 `{type:'MESSAGE', data:{msgtype:'image'}}`——**生产里不存在的形状**
    //   （官方 Stream 帧是 `{type:'CALLBACK', headers, data:"<JSON 字符串>"}`），故它一直假绿。
    //   现按官方协议喂**真帧**，并拆三只标本（承「夹具比生产宽松即假绿」）：
    //     ④-1 真帧（字符串 data）非文本 + `content.downloadCode` ⇒ **换取地址 → 取字节 → 落盘**
    //     ④-2 真帧文本 ⇒ 正文取自 `text.content`（原码读 `payload.content` ⇒ 文本从来没到场过）
    //     ④-3 反证：旧对象形状仍收（同一协议的两个形态），且**无 downloadCode ⇒ 不去取件、不回话**
    const cast = (a: DingtalkAdapter) => a as unknown as { handleMessage(d: Record<string, unknown>): Promise<void> };
    const frame = (inner: Record<string, unknown>, type = 'CALLBACK') => ({
      specVersion: '1.0', type, headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'h1' }, data: JSON.stringify(inner),
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-m3-dt-'));
    try { // ④-1 非文本真帧 ⇒ 两步取件 + 落盘
      const db = mkImDb();
      const w = wire(db, 'ch-d', 'dingtalk');
      const ad = new DingtalkAdapter(db, 'ch-d', { clientId: 'a', clientSecret: 's', robotCode: 'r' }, dir);
      ad.onMessage(w.handler as never);
      const seen: string[] = [];
      const restore = stubFetch((url) => {
        seen.push(url);
        // ⚠ 两步取件前还有**第三步**：`downloadCode` 换地址要带着 access_token 去换（`getAccessToken`）。
        //   桩若不认这个 URL，token 取不到 ⇒ 整条取件路在第一步就停住（夹具比生产"窄"的又一种形态）。
        if (url.includes('oauth2/accessToken')) return { json: { accessToken: 'tok-1', expireIn: 7200 } };
        if (url.includes('messageFiles/download')) return { json: { downloadUrl: 'https://dl.example/iAEI.file' } };
        return { body: Buffer.from('IMGBYTES'), contentType: 'image/jpeg' };
      });
      try {
        await cast(ad).handleMessage(frame({
          msgtype: 'picture', content: { downloadCode: 'dc1', pictureDownloadCode: 'p1' },
          senderStaffId: 'ud1', conversationType: '1', msgId: 'md1', // 每个标本换一个发送者：不然第 3 条会被**风暴闸**拦下（STORM_THRESHOLD=2）
        }));
      } finally { restore(); }
      await settle();
      const rows = convRows(db);
      eq(rows.length, 1, '钉钉 ④-1：inbound 行 0→1（真帧此前在 `type !== MESSAGE` 处就被丢掉）');
      ok(String(rows[0]!.message_json).includes('"kind":"picture"'), '钉钉 ④-1：message_json 含 kind=picture', String(rows[0]!.message_json));
      ok(seen.some((u) => u.includes('messageFiles/download')), '钉钉 ④-1：走官方两步法第一步（downloadCode → 临时地址）', seen.join(' '));
      ok(seen.some((u) => u.includes('dl.example')), '钉钉 ④-1：第二步 GET 那个临时地址取字节', seen.join(' '));
      const saved = /"saved_path":"([^"]+)"/.exec(String(rows[0]!.message_json))?.[1] || '';
      ok(saved.length > 0, '钉钉 ④-1：落盘成功 ⇒ `saved_path` 写进入站行', saved);
      ok(saved.endsWith('.jpg'),
        '钉钉 ④-1：**占位后缀 `.file` 未被当真**（官方明说下载名需自行换后缀）⇒ 按类型退回 `.jpg`（族判 image 才可能被内联）', saved);
      eq(saved ? fs.readFileSync(saved).length : -1, 8, '钉钉 ④-1：盘上真有那个文件且字节数相符');
      eq(w.replies.length, 1, '钉钉 ④-1：取了件回一句');
      ok(/已落盘/.test(w.replies[0] || ''), '钉钉 ④-1：回话报落点', w.replies[0]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }

    { // ④-2 文本真帧 ⇒ 正文取自 text.content
      const db = mkImDb();
      const w = wire(db, 'ch-d2', 'dingtalk');
      const ad = new DingtalkAdapter(db, 'ch-d2', { clientId: 'a', clientSecret: 's', robotCode: 'r' });
      ad.onMessage(w.handler as never);
      await cast(ad).handleMessage(frame({
        msgtype: 'text', text: { content: '钉钉你好' }, senderStaffId: 'ud2', conversationType: '1', msgId: 'md2',
      }));
      await settle();
      const rows = convRows(db);
      eq(rows.length, 1, '钉钉 ④-2：文本真帧到场（原码读 `payload.content` ⇒ 真字段在 `text.content` ⇒ 整条丢弃）');
      ok(String(rows[0]!.message_json).includes('钉钉你好'), '钉钉 ④-2：正文即 `text.content` 的真值', String(rows[0]!.message_json));
    }

    { // ④-3 反证：旧对象形状仍收；无 downloadCode ⇒ 不取件、不回话
      const db = mkImDb();
      const w = wire(db, 'ch-d3', 'dingtalk');
      const ad = new DingtalkAdapter(db, 'ch-d3', { clientId: 'a', clientSecret: 's', robotCode: 'r' });
      ad.onMessage(w.handler as never);
      await cast(ad).handleMessage({
        type: 'MESSAGE', data: { msgtype: 'image', senderStaffId: 'ud3', conversationType: '1', msgId: 'md3' },
      });
      await settle();
      eq(convRows(db).length, 1, '钉钉 ④-3：同一协议的另一形态（`data` 已是对象）仍被收下');
      ok(String(convRows(db)[0]!.message_json).includes('"kind":"image"'), '钉钉 ④-3：message_json 含 kind=image');
      eq(w.replies.length, 0, '钉钉 ④-3：**无 downloadCode ⇒ 无取件动作 ⇒ 不自动回话**（D3「默认不回」原样成立）');
    }
  }
  { // ⑤ 微信个人号（走完整 handleMessage：配额窗口 + 复活 + extractText）
    // ⚠ zx_20260920_1 M5 订正：本夹具原为 `image_item: { url: 'u' }`——那时 `url` 是**纯填充**、
    //   无人消费，故"不自动回话"能过。M5 起 `url` 成了**取件地址**（会被真去下载），
    //   于是这条断言被拆成**两只标本**（承「豁免/门槛类判据须用该命中与该不命中两只一起试」）：
    //     ⑤-1 **无取件地址** ⇒ 无取件动作 ⇒ 不自动回话（D3 原裁定，一字不改地继续成立）
    //     ⑤-2 **有取件地址但取不到** ⇒ 回的确该回（**"没能落盘"+真因**），且真因落在该行的 `last_error` 上
    //   ⑤-2 的 url 刻意**不可解析**（`u`）：`fetch` 在解析阶段即失败 ⇒ **不发任何网络请求**，夹具不依赖外网。
    const db = mkImDb();
    const w = wire(db, 'ch-p', 'wechat-personal');
    const ad = new WechatAdapter(db, 'ch-p', { base_url: 'http://x' }, '/tmp');
    ad.onMessage(w.handler as never);
    await (ad as unknown as { handleMessage(m: Record<string, unknown>): Promise<void> }).handleMessage({
      from_user_id: 'up', item_list: [{ type: 2, image_item: { file_name: 'pic.jpg', size: 12 } }],
    });
    await tick();
    const rows = convRows(db);
    eq(rows.length, 1, '微信：inbound 行 0→1（此前 extractText 返空 ⇒ `if (!text) return` 丢弃）');
    ok(String(rows[0]!.message_json).includes('"kind":"2"'), '微信：带**原始数值类型**（不猜名字）', String(rows[0]!.message_json));
    ok(String(rows[0]!.message_json).includes('pic.jpg'), '微信：平台给的件名如实带上（M5 起取 `*_item` 体里的真值）');
    eq(w.replies.length, 0, '微信 ⑤-1：**无取件地址 ⇒ 不自动回话**（无取件动作，D3「默认不回」原样成立）');

    const db2 = mkImDb();
    const w2 = wire(db2, 'ch-p', 'wechat-personal');
    const ad2 = new WechatAdapter(db2, 'ch-p', { base_url: 'http://x' }, '/tmp');
    ad2.onMessage(w2.handler as never);
    await (ad2 as unknown as { handleMessage(m: Record<string, unknown>): Promise<void> }).handleMessage({
      from_user_id: 'up', item_list: [{ type: 2, image_item: { url: 'u', file_name: 'pic.jpg' } }],
    });
    await tick();
    const rows2 = convRows(db2);
    eq(rows2.length, 1, '微信 ⑤-2：有取件地址 ⇒ 行照落（**不回滚**），行数仍 1');
    eq(w2.replies.length, 1, '微信 ⑤-2：**取了件就必须回一句**——不许把"我丢了"说成"我收了"');
    ok(/没能落盘/.test(w2.replies[0] || ''), '微信 ⑤-2：回话**明说"没能落盘"**（不是"已收到"了事）', w2.replies[0]);
    ok(/pic.jpg/.test(w2.replies[0] || ''), '微信 ⑤-2：回话带**真件名**', w2.replies[0]);
    ok(String(rows2[0]!.last_error || '').length > 0, '微信 ⑤-2：**真因落在该行的 `last_error`**（既有列，不新造列）', String(rows2[0]!.last_error));
  }

  console.log('\n[S2.3 反证：占位符若被当普通文本，会走错分支（故必须止步）]');
  {
    const db = mkImDb();
    const w = wire(db, 'ch-x', 'feishu');
    // 不带 meta（= 旧行为）：[图片] 恰 4 字 ⇒ 落「简单问候/兜底」分支 ⇒ 触发自动回话
    await w.handler('ux', nonTextPlaceholder('image'), 'direct', '');
    eq(convRows(db).length, 1, '不带 meta：仍入列 1 行');
    eq(w.replies.length, 1, '不带 meta：触发了自动回话 ⇒ 这正是"必须止步"的理由');
    // 长占位符（>4 字）命中 router 的建任务判据——此处只证判据成立（建任务需 wa_tasks，超本夹具范围）
    ok(nonTextPlaceholder('file', 'report.pdf', 1258291).length > 4,
      '长占位符 >4 字 ⇒ 命中 `msgText.length > 4` 建任务判据（不带 meta 就会被建成任务）');
  }
  {
    const db = mkImDb();
    const w = wire(db, 'ch-y', 'feishu');
    const ph = nonTextPlaceholder('file', 'report.pdf', 1258291);
    await w.handler('uy', ph, 'direct', '', { kind: 'file', fileName: 'report.pdf', sizeBytes: 1258291 });
    eq(convRows(db).length, 1, '带 meta ⇒ 仍如实落 1 行 inbound');
    eq(w.replies.length, 0, '带 meta ⇒ **零回话**（止步于记录，用户裁决 D3）');
    ok(String(convRows(db)[0]!.message_json).includes('"file_name":"report.pdf"'), 'meta 的文件名如实落进 message_json');
    ok(String(convRows(db)[0]!.message_json).includes('"size_bytes":1258291'), 'meta 的字节数如实落进 message_json');
  }

  console.log('\n[S2.4 反证：真空文本仍不入列（`if (!msgText) return;` 保留）]');
  {
    const db = mkImDb();
    const w = wire(db, 'ch-z', 'feishu');
    await w.handler('uz', '   ', 'direct', '');
    eq(convRows(db).length, 0, '全空白文本不落行（既有语义未被"非文本到场"带走）');
    await w.handler('uz', '[图片]', 'direct', '', {});
    eq(convRows(db).length, 1, '空 meta（无 kind）视为文本消息照常入列（不误伤既有路径）');
  }

  console.log('\n[S2.5 去重：非文本无正文可辨时不吞第二条；有平台 id 则按 id 去重]');
  {
    const db = mkImDb();
    const w = wire(db, 'ch-d1', 'wechat-personal');
    // 有 kind、无平台 id：正是"腾讯/iLink 不回 id"那类渠道。此处若沿用文本去重键，
    // 两条一模一样的 `[图片]` 会在 30s 窗口里被吞掉第二条——用户以为发了，系统以为没发。
    await w.handler('u1', nonTextPlaceholder('image'), 'direct', '', { kind: 'image' });
    await w.handler('u1', nonTextPlaceholder('image'), 'direct', '', { kind: 'image' });
    eq(convRows(db).length, 2, '同一用户连发两张图（无平台 id）⇒ **都记**（宁可可见重复，不可静默吞掉第二张）');
    // 反证：同两条若走文本路径（无 kind），30s 文本去重会吞掉第二条——对比即证"非文本不能沿用文本键"
    // 换用户：`isStorm` 按**用户**计数（模块级、跨渠道），同一用户在本脚本里已用了 2 次配额
    const db2 = mkImDb();
    const w2 = wire(db2, 'ch-d1b', 'wechat-personal');
    await w2.handler('u1b', nonTextPlaceholder('image'), 'direct', '');
    await w2.handler('u1b', nonTextPlaceholder('image'), 'direct', '');
    eq(convRows(db2).length, 1, '反证：不带 kind 时被文本去重吞成 1 条 ⇒ 非文本必须另立去重键');
  }
  {
    const db = mkImDb();
    const w = wire(db, 'ch-d2', 'feishu');
    await w.handler('u2', nonTextPlaceholder('image'), 'direct', '', { kind: 'image', messageId: 'MID-1' });
    await w.handler('u2', nonTextPlaceholder('image'), 'direct', '', { kind: 'image', messageId: 'MID-1' });
    eq(convRows(db).length, 1, '有平台消息 id ⇒ 同一 id 的重放仍被挡（去重能力不因非文本而丧失）');
    // 换一个 id（换用户以避开同一用户的防风暴窗口）⇒ 视为另一条
    await w.handler('u3', nonTextPlaceholder('image'), 'direct', '', { kind: 'image', messageId: 'MID-2' });
    eq(convRows(db).length, 2, '换 id ⇒ 另记一条（两张不同的图不混为一谈）');
  }

  console.log('\n[S2.6 落点穷举：五家适配器各含非文本转正（断言名 = 扫描面，防只改四家）]');
  {
    const adapters = ['feishu', 'wechat', 'qqbot', 'dingtalk', 'wecom'];
    const withPlaceholder: string[] = [];
    const withOwnLabelTable: string[] = [];
    for (const n of adapters) {
      const src = stripComments(app(`src/main/services/${n}-adapter.ts`));
      if (src.includes('nonTextPlaceholder(')) withPlaceholder.push(n);
      if (src.includes("'图片'")) withOwnLabelTable.push(n);
    }
    eq(withPlaceholder, adapters, `五家适配器均调用 nonTextPlaceholder（实测命中 ${withPlaceholder.join(',')}）`);
    eq(withOwnLabelTable, [], '反证：无一家自带类型词表（词表只有 im-adapter.ts 一处）');
    ok(!stripComments(app('src/main/services/feishu-adapter.ts')).includes("if (message.message_type !== 'text') return;"),
      '反证：飞书旧丢弃判据已让位');
    ok(!stripComments(app('src/main/services/wecom-adapter.ts')).includes("if (msgType !== 'text') return;"),
      '反证：企微旧丢弃判据已让位');
    const iface = stripComments(app('src/main/services/im-adapter.ts'));
    ok(/meta\?: ImMessageMeta/.test(iface), 'ImMessageHandler 第 5 参 `meta?` 为可选（既有 5 处调用不传即行为不变）');
    ok(/messageId\?: string/.test(iface), 'meta 含可选 messageId（非文本去重的依据）');
    // 既有调用方仍只传 4 参的位置参数不变（路由侧新增 meta 是**追加**）
    const router = stripComments(app('src/main/services/im-router.ts'));
    ok(/routeImMessage\(\s*ctx: ImContext, fromUser: string, text: string, chatType: string, contextToken: string,/.test(router),
      'routeImMessage 既有 5 个位置参数一字未动（meta 追加在末位）');
  }
}

// ─────────────────────────────────────────────────────────────
// §S4 M1-3 未读红点（一处算 · 一处推 · 显示端零记账）
// ─────────────────────────────────────────────────────────────
/** 递归列出目录下全部 `.ts`（`src/main/**` 就是本节的扫描面，断言名即照它写）。 */
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function s4Static(): void {
  console.log('\n[S4.1 未读"算"只落在 im-unread.ts（全 src/main/** 扫 COUNT(*) × inbound，落在他处即红）]');
  const hits: string[] = [];
  for (const f of walkTs(path.join(root, `${A}/src/main`))) {
    for (const l of stripKeepingLines(fs.readFileSync(f, 'utf-8'))) {
      if (l.includes('COUNT(*)') && l.includes("'inbound'")) hits.push(path.basename(f));
    }
  }
  // zx_20261003 M12: 该模块内现有**两道** inbound COUNT（总数 `computeImUnread` + 逐渠道
  //   `computeImUnreadByChannel`，同尺同 WHERE、只粒度不同）⇒ 按**文件**去重后仍须恰此一模块。
  //   本判据的真意是"未读账不在第二个模块各算一份"（显示端不得自算），去重照此，非放宽。
  eq([...new Set(hits)], ['im-unread.ts'], `扫描面 ${A}/src/main/**/*.ts 内 inbound 计数读点**全落在 im-unread.ts**（恰此一文件）`);

  console.log('\n[S4.2 `im:unread` **只读**（对它"看一眼"不该产生任何副作用）]');
  const ipc = stripComments(app('src/main/ipc/im.ipc.ts'));
  const readBody = methodBody(ipc, "ipcMain.handle('im:unread',");
  ok(readBody.length > 0, '`im:unread` handler 体内取到');
  ok(/computeImUnread\(_dbForIm\)/.test(readBody), '体内走 `computeImUnread`（与托盘同一个算）');
  ok(!/markImRead|refreshImUnread/.test(readBody), '反证：体内**不调** markImRead/refreshImUnread（不写账、不推显示端）');
  ok(!/INSERT|REPLACE|UPDATE/.test(readBody), '反证：体内**无任何写语句**');
  const markBody = methodBody(ipc, "ipcMain.handle('im:markRead',");
  ok(/markImRead\(_dbForIm[,)]/.test(markBody), '对照：`im:markRead` 才走 `markImRead`（两个通道各司其职；zx_20261002 M2 起收 channelId）');

  console.log('\n[S4.3 两值同源（一个数从同一个 COUNT 出发，故恒等）]');
  const un = stripComments(app('src/main/core/im/im-unread.ts'));
  ok(/return refreshImUnread\(db\);/.test(methodBody(un, 'export function markImRead(')), '`markImRead` 的返回值出自 `refreshImUnread`');
  ok(/computeImUnread\(db\)/.test(methodBody(un, 'export function refreshImUnread(')), '`refreshImUnread` 的 n 出自 `computeImUnread`');
  ok(/COUNT\(\*\)[\s\S]{0,120}?direction = 'inbound'/.test(methodBody(un, 'export function computeImUnread(')), '`computeImUnread` 是唯一那道 COUNT');

  console.log('\n[S4.4 推送口在既有 `task:event` 通道上（不新开通道、不加一本账）]');
  const idx = stripComments(app('src/main/index.ts'));
  ok(/setImUnreadSink\(\(n\) => \{[\s\S]{0,400}?mainWindow\.webContents\.send\('task:event', \{ type: 'im\.unread', unread: n \}\)/.test(idx),
    'sink 内同时喂托盘与 renderer（**同一份 n**，方案 §批 M1-B.1 的②）');
  ok(!/updateTrayImUnread\(computeImUnread|computeImUnread[\s\S]{0,80}?updateTrayImUnread/.test(idx),
    '反证：托盘侧不另算一遍（托盘与导航不可能对不上）');
}

async function s4Run(): Promise<void> {
  console.log('\n[S4.5 运行时：真 `im-unread.ts` × 真库 —— sink 序列如实、只读不改账]');
  const db = mkImDb();
  const seen: number[] = [];
  setImUnreadSink((n) => { seen.push(n); });
  try {
    // 账种子：把「上次确实在看」设在 2020。这样"之后到达"的行可由夹具**确定性**构造
    //（否则 getImLastReadAt 首次缺省取"此刻"，同秒插入的行 `created_at > since` 不成立，断言随机器快慢飘）。
    db.prepare("INSERT OR REPLACE INTO wa_settings (key, value) VALUES ('im_last_read_at', '2020-01-01 00:00:00')").run();
    const conv = (id: string, dir: string, at: string) =>
      db.prepare("INSERT INTO wa_im_conversations (id, channel_id, external_user_id, direction, created_at) VALUES (?, 'ch1', 'u1', ?, ?)").run(id, dir, at);

    conv('z', 'inbound', '2019-01-01 00:00:00'); // 读之前到达的——不该算未读
    conv('a', 'inbound', '2021-01-01 00:00:01');
    eq(computeImUnread(db), 1, '读之后到达的入站 0→1（正面断言；2019 那条**不计**）');
    conv('b', 'inbound', '2021-01-01 00:00:02');
    conv('c', 'outbound', '2021-01-01 00:00:03');
    eq(computeImUnread(db), 2, '第 2 条入站 +1；**出站不计入**（同一把尺量 inbound）');

    const ledger = () => (db.prepare("SELECT value FROM wa_settings WHERE key = 'im_last_read_at'").get() as { value?: string } | undefined)?.value;
    const seeded = ledger();
    computeImUnread(db); computeImUnread(db);
    eq(ledger(), seeded, '反证：`computeImUnread` 连调两次**账不动**（只读就是只读）');
    eq(seen, [], '反证：只读**不推显示端**（显示端只在 refresh 那一刻收到数）');

    eq(refreshImUnread(db), 2, 'refresh 把 2 报给显示端');
    conv('d', 'inbound', '2021-01-01 00:00:04');
    eq(refreshImUnread(db), 3, '再到达一条 ⇒ 3');
    eq(markImRead(db), 0, '标记已读 ⇒ **归零**（`im:markRead` 的返回值就是它）');
    conv('e', 'inbound', '2099-01-01 00:00:00');
    eq(refreshImUnread(db), 1, '已读之后又到达一条 ⇒ 回到 1（未读是"读之后到达的"，不是消息总数）');
    eq(seen, [2, 3, 0, 1], 'sink 序列如实（每个会改变未读的时刻恰推一次，含归零那一次）');
  } finally { setImUnreadSink(null); }
}

// ─────────────────────────────────────────────────────────────
// §S5 M1-4 `messageViewOf`（renderer 纯函数，直接跑真实现）
// ─────────────────────────────────────────────────────────────
function s5(): void {
  console.log('\n[S5.1 五类入参逐类（跑真实现，不是对着切片）]');
  eq(messageViewOf(JSON.stringify({ kind: 'text', text: '你好' })), { kind: 'text', label: '', text: '你好' },
    '自由文本：原话上屏、无徽标');
  eq(messageViewOf(JSON.stringify({ kind: 'image', text: '[图片]' })), { kind: 'image', label: '图片', text: '[图片]' },
    '图片：徽标=「图片」（从 main 产出的占位符读回）');
  eq(messageViewOf(JSON.stringify({ kind: 'file', text: '[文件 report.pdf 1.2MB]' })),
    { kind: 'file', label: '文件', text: '[文件 report.pdf 1.2MB]' },
    '文件：徽标只取方括号内**第一个空白前**一段（文件名/大小不混进徽标）');
  eq(messageViewOf(JSON.stringify({ kind: '3', text: '[语音]' })), { kind: '3', label: '语音', text: '[语音]' },
    '语音（微信原始数值类型）：kind 原样带出、徽标读回');
  eq(messageViewOf(JSON.stringify({ kind: '2', text: '[其他消息(2)]' })), { kind: '2', label: '其他消息(2)', text: '[其他消息(2)]' },
    '未知类型：**原样带出**不猜名字，正文即 main 的占位符');

  console.log('\n[S5.2 反证：不裸抛 JSON / 不臆造徽标 / 坏数据不抛]');
  const noText = messageViewOf(JSON.stringify({ kind: 'video' }));
  eq(noText, { kind: 'video', label: '', text: '' }, '非文本无占位符 ⇒ 正文为空、**不把 JSON 端上屏**');
  ok(!noText.text.includes('{'), '反证：上屏正文不含 `{`（没裸抛 JSON）');
  eq(messageViewOf('{"foo":1}'), { kind: 'text', label: '', text: '{"foo":1}' },
    '库里坏数据（是对象但无 kind/text）⇒ 按文本原样显示（截断），不抛');
  eq(messageViewOf('不是 JSON 的提示语'), { kind: 'text', label: '', text: '不是 JSON 的提示语' }, '非 JSON 入参：不抛，按原文如实显示');
  eq(messageViewOf(null), { kind: 'text', label: '', text: '' }, 'null 入参不抛（空正文，界面不留空白行之外的意外）');
  eq(messageViewOf(JSON.stringify([1, 2])), { kind: 'text', label: '', text: '[1,2]' }, '数组不被当作消息对象（按原文显示）');
  eq(messageViewOf(JSON.stringify({ kind: 'image', text: '图片来了' })).label, '',
    '反证：占位符格式若变（读不回）⇒ 徽标**留空**，不显示一个可能已过期的名');
  eq(messageViewOf('x'.repeat(500)).text.length, 200, '非 JSON 长文本截断到 200（与旧口径同值，不借本轮改口径）');

  console.log('\n[S5.3 反证：renderer **不另立词表**（词表仍只在 main 一处，此处只读回）]');
  const mv = stripComments(app('renderer/src/lib/messageView.ts'));
  ok(!mv.includes('图片'), '反证：messageView.ts 内**不含**「图片」这类词表字面量');
  ok(!/NON_TEXT_LABELS|LABEL_TABLE/.test(mv), '反证：不引用也不复制 main 的词表常量');
  ok(/LABEL_RE/.test(mv), '徽标靠从**已渲染占位符**里读回（方括号前缀正则）');
  ok(stripComments(app('src/main/services/im-adapter.ts')).includes("'图片'"), '词表仍只在 im-adapter.ts 一处（否则上面的"读回"也就没了源）');
}

// ─────────────────────────────────────────────────────────────
// §S6 接线（本轮每处新代码都必须有一条真调用——防"做了没用上"）
// ─────────────────────────────────────────────────────────────
function s6(): void {
  console.log('\n[S6.1 main 侧：注册了通道、且推送落在既有 task:event 上]');
  ok(/ipcMain\.handle\('im:unread'/.test(stripComments(app('src/main/ipc/im.ipc.ts'))), 'main 注册 `im:unread`（renderer 取初值有对口）');
  ok(/type: 'im\.unread', unread: n/.test(stripComments(app('src/main/index.ts'))), 'main 推 `im.unread`（§S4.4 已断言其上下文）');

  console.log('\n[S6.2 renderer 侧：封装 → 订阅 → 上屏，四环齐全]');
  ok(/unread: \(\) => ipcCall<\{ unread: number \}>\('im:unread'\)/.test(stripComments(app('renderer/src/lib/ipc.ts'))),
    '封装 `im.unread()` 指向 `im:unread`（端口名与 main 逐字相同）');
  const layout = stripComments(app('renderer/src/components/AppLayout.tsx'));
  ok(/event\.type === 'im\.unread'/.test(layout), 'AppLayout **订阅**推送（否则推了没人听）');
  ok(/im\.unread\(\)\.then/.test(layout), 'AppLayout 挂载**自取初值**（启动那次推送早于渲染进程订阅）');
  ok(/\{to === '\/im' && imUnread > 0 &&/.test(layout), '红点绑在 **/im 导航项**上（不是随便一个 span）');
  ok(/unread\?: number;/.test(RD(`${A}/renderer/src/types/electron.d.ts`)), 'TaskEvent 类型含 `unread`（缺则 renderer tsc 红——本批实测过一次）');

  console.log('\n[S6.3 输入框：真发 × 分流 × busy × 收件人有据]');
  const page = stripComments(app('renderer/src/pages/IMPage.tsx'));
  ok(/await im\.send\(convChannel, peer, body\)/.test(page), '确实调 `im.send`（不是只画了个框）');
  ok(/e\.key !== 'Enter' \|\| e\.shiftKey \|\| e\.nativeEvent\.isComposing/.test(page), 'Enter 发送 / Shift+Enter 换行 / **组字中不误发**');
  ok(/disabled=\{!convPeer\|\|uiBusy\.has\('im-send'\)/.test(page), 'busy 或无可回话对象时禁用（防同一 tick 双击发两条）');
  // zx_20261002 M3: 收件人判定从"每渲染现取 `convs[0]`"改为 `resolveReplyPeer`（显式选定优先，不给裸 id 输入口）。
  ok(/resolveReplyPeer\(replyPeer, convs\)/.test(page), '收件人取 `resolveReplyPeer`（选定优先、列表漂不顶人；仍不给裸 id 输入口）');
  ok(!/convs\[0\]\?\.external_user_id/.test(page), '反证：`convs[0]` 不再作收件人来源（zx_20261002 M3 的病根已除）');
  ok(/messageViewOf\(c\.message_json\)/.test(page), '会话项渲染真走 `messageViewOf`（不是导出即闲置）');
  ok(!/JSON\.parse\(c\.message_json\)/.test(page), '反证：旧的内联 `JSON.parse` 兜底已让位（判定只剩一处）');
}

// ─────────────────────────────────────────────────────────────
// §S7 批 M2-1：正文「读得动」——真跑受限子集渲染器（块解析 + 行内 + React 元素树）
// ─────────────────────────────────────────────────────────────
/** 从 React 元素树里递归收集 **字符串 type**（即宿主元素名：div/ul/li/a/script…）。
 *  组件元素（CodeBlock）的 type 是函数，故意不收——注入面只可能来自**宿主**标签。 */
function hostTags(node: unknown, acc: string[] = []): string[] {
  if (node === null || typeof node !== 'object') return acc;
  const n = node as { type?: unknown; props?: { children?: unknown } };
  if (typeof n.type === 'string') acc.push(n.type);
  const c = n.props?.children;
  for (const k of c === undefined ? [] : Array.isArray(c) ? c : [c]) hostTags(k, acc);
  return acc;
}
/** 取根元素的直接子节点数组（`<>…</>` 的 children 是数组，单个元素时也是数组）。 */
function rootChildren(node: unknown): unknown[] {
  const c = (node as { props?: { children?: unknown } } | null)?.props?.children;
  return c === undefined ? [] : Array.isArray(c) ? c : [c];
}
/** 取一串宿主节点里的**全部文本**（用于断言"原样落为文本"）。 */
function allText(node: unknown, acc: string[] = []): string[] {
  if (node === null || node === undefined) return acc;
  if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc; }
  if (typeof node !== 'object') return acc;
  const c = (node as { props?: { children?: unknown } }).props?.children;
  for (const k of c === undefined ? [] : Array.isArray(c) ? c : [c]) allText(k, acc);
  return acc;
}

function s7Markdown(): void {
  const mdSrc = app('renderer/src/lib/markdown-subset.tsx');
  console.log('\n[S7.1 块级解析：九类语法各一例，逐个对形状（不是"不抛"）]');
  const doc = [
    '# 一级标题',
    '',
    '普通段落一',
    '段落续行',
    '',
    '- 无序甲',
    '- 无序乙',
    '',
    '3. 有序丙',
    '4. 有序丁',
    '',
    '> 引用行',
    '',
    '---',
    '',
    '```ts',
    'const x = 1;',
    '```',
    '',
    '| 列一 | 列二 |',
    '| --- | --- |',
    '| a | b |',
  ].join('\n');
  const b = parseMarkdownSubset(doc);
  eq(b.map((x) => x.type), ['heading', 'paragraph', 'ul', 'ol', 'quote', 'hr', 'code', 'table'],
    '八类块按序识别（段落**合并续行**、`---` 是分隔线而非表格分隔）');
  eq(b[0], { type: 'heading', level: 1, text: '一级标题' }, '标题带 level 与文本');
  eq((b[1] as { text: string }).text, '普通段落一\n段落续行', '连续非空行合并为**一段**');
  eq((b[2] as { items: string[] }).items, ['无序甲', '无序乙'], '无序列表项');
  eq((b[3] as { start: number; items: string[] }).items, ['有序丙', '有序丁'], '有序列表项');
  ok((b[3] as { start: number }).start === 3, '`start` 取首项序号（不假设从 1 开始）');
  eq(b[6], { type: 'code', lang: 'ts', code: 'const x = 1;' }, '围栏块带语言信息串与正文');
  eq((b[7] as { header: string[] }).header, ['列一', '列二'], '表头单元');
  eq((b[7] as { rows: string[][] }).rows, [['a', 'b']], '数据行');
  eq(parseMarkdownSubset(''), [], '空串 ⇒ 空块（**空内容不是"一段空段落"**）');
  eq(parseMarkdownSubset(null), [], '非串入参 ⇒ 空块（不抛）');
  eq(parseMarkdownSubset('```\n未闭合'), [{ type: 'code', lang: '', code: '未闭合' }],
    '未闭合围栏按**到文末**收口（不吞掉剩余内容、也不报错）');

  console.log('\n[S7.2 行内：码/粗/斜/链 四类，且**协议白名单**才产出 <a>]');
  eq(parseInline('前 `code` 后').map((x) => x.type), ['text', 'code', 'text'], '行内码按反引号切分（奇段为码）');
  eq(parseInline('**粗** 与 *斜* 与 _斜2_').map((x) => x.type), ['strong', 'text', 'em', 'text', 'em'], '粗体/斜体三类');
  const link = parseInline('[名](https://example.com/a)');
  eq(link, [{ type: 'link', text: '名', href: 'https://example.com/a' }], 'http(s) 链接产出 link');
  eq(parseInline('[名](mailto:a@b.c)')[0]?.type, 'link', 'mailto 在白名单内');
  console.log('  -- 口径 2：非白名单协议**降级为纯文本**，不产出链接元素 --');
  const js = parseInline('[名](javascript:alert(1))');
  ok(js.every((x) => x.type !== 'link'), 'javascript: 不产出 link（降级为纯文本）');
  eq(js.map((x) => x.text).join(''), '[名](javascript:alert(1))', '降级后**原文不丢**（拼回逐字相同，用户看得见自己写了什么）');
  ok(js.every((x) => !('href' in x)), '反证：降级后的碎片**没有 href 字段**（不是"有 link 但 href 为空"）');
  const js2 = parseInline('[名](javascript:x)');
  eq(js2, [{ type: 'text', text: '[名](javascript:x)' }], '无括号的非白名单协议同样整段降级为一条文本');
  ok(parseInline('[名](data:text/html;base64,x)').every((x) => x.type !== 'link'), '反证：`data:` 协议也不在白名单（不是只防 javascript）');

  console.log('\n[S7.3 React 元素树：真跑默认导出，宿主标签逐个对上]');
  const el = MarkdownSubset({ source: '# 标题\n\n- 甲\n- 乙\n\n> 引\n\n---\n\n```\ncode\n```\n\n[走](https://e.com)' });
  const tags = hostTags(el);
  ok(tags.includes('ul') && tags.includes('li') && tags.includes('blockquote') && tags.includes('hr'),
    '无序表/引用/分隔线均落成对应宿主元素', tags.join(','));
  ok(tags.includes('a'), '白名单链接落成 `<a>`');
  const rc = rootChildren(el);
  ok(typeof (rc[0] as { type?: unknown })?.type === 'string'
    && String((rc[0] as { props?: { className?: string } }).props?.className || '').includes('font-semibold'),
    '标题落成**加粗块**（`text-lg`/`font-semibold`），不是裸露的 `#`');
  const ulel = rc.find((n) => (n as { type?: unknown }).type === 'ul') as { props?: { children?: unknown[] } };
  ok((ulel?.props?.children as unknown[] | undefined)?.length === 2, '列表项数 = 2（逐项成 li）');
  // 围栏块是**组件元素**（type 是函数），其内部宿主标签不会出现在未渲染的元素树里——
  // 故这里只断言 props 透传，宿主标签改在下面按**源码切片**断言（不在 rr 里跑 React 渲染器）。
  const cb = rc.find((n) => typeof (n as { type?: unknown }).type === 'function') as { props?: { code?: string; lang?: string } };
  eq(cb?.props?.code, 'code', '围栏块正文透传到 CodeBlock（元素未被执行、只取 props）');
  eq(cb?.props?.lang, '', '无语言信息串 ⇒ 空串（**不去猜**语言，如实留空）');
  eq(MarkdownSubset({ source: '' }), null, '空内容 ⇒ 返回 null（不留空壳）');
  // CodeBlock 自身的呈现：等宽 + 行号 + 复制按钮（源码切片断言，切片锚点=函数定义到下一处 top-level 注释）
  const cbSrc = mdSrc.slice(mdSrc.indexOf('export function CodeBlock'));
  ok(/<pre[\s\S]*?<code[\s\S]*?className="font-mono"/.test(cbSrc), '围栏块落成 `<pre > <code class="font-mono">`（等宽）');
  ok(/gutter/.test(cbSrc) && /\{i \+ 1\}/.test(cbSrc), '逐行**行号**（gutter 宽度按总行数定）');
  ok(/title="复制代码"/.test(cbSrc), '有复制按钮（标题即用途，不是图标猜谜）');
  ok(/\.catch\(\(\) => \{/.test(cbSrc) && !/已复制'/.test(cbSrc.split('.catch')[0] ?? ''),
    '复制**失败不假装成功**（`setCopied(true)` 只在 then 里）');
  ok(!/highlight/i.test(cbSrc), '反证：**不做语法高亮**（口径 1，如实标注而非假装）');

  console.log('\n[S7.4 反证：无注入面]');
  const evil = MarkdownSubset({ source: '<script>alert(1)</script>' });
  const etags = hostTags(evil);
  ok(!etags.includes('script'), '`<script>` 输入 ⇒ 输出**不含** script 宿主元素', etags.join(','));
  ok(!etags.some((t) => /^(script|iframe|object|embed|style|img|svg)$/.test(t)), '无任何危险宿主标签');
  ok(allText(evil).some((t) => t.includes('<script>alert(1)</script>')), '原样落为**文本**（看得见、不执行）');
  ok(!hostTags(MarkdownSubset({ source: '<img src=x onerror=alert(1)>' })).includes('img'),
    '`<img onerror>` 输入同样不成元素（受限子集只认 Markdown，不认 HTML）');
  ok(!/dangerouslySetInnerHTML/.test(stripComments(mdSrc)), '反证：渲染器自身不含 `dangerouslySetInnerHTML`');
  // 全仓扫描面 = renderer 的 src（.ts/.tsx）+ main 的 src；断言名与扫描面逐字一致
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'dist' && e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(e.name)) continue;
      if (/dangerouslySetInnerHTML/.test(stripComments(fs.readFileSync(p, 'utf-8')))) offenders.push(path.relative(root, p));
    }
  };
  walk(path.join(root, `${A}/src`));
  walk(path.join(root, `${A}/renderer/src`));
  eq(offenders, [], '全仓 `src` + `renderer/src` 内 `dangerouslySetInnerHTML` 命中数 = 0（防日后回退成注入式实现）');

  console.log('\n[S7.5 接线：四处预览共用同一入口（不是"写了没用上"）]');
  const delivPage = stripComments(app('renderer/src/pages/DeliverablesPage.tsx'));
  const drawer = stripComments(app('renderer/src/components/DeliverableDrawer.tsx'));
  const taskDetail = stripComments(app('renderer/src/pages/TaskDetailPage.tsx'));
  ok((delivPage.match(/<MarkdownSubset\s/g) || []).length === 2, '成果页**两处**预览（版本快照 + 当前内容）都接了');
  ok(/<MarkdownSubset\s/.test(drawer), '抽屉接了');
  ok(/<MarkdownSubset\s/.test(taskDetail), '任务详情接了');
  for (const [name, src] of [['DeliverablesPage', delivPage], ['DeliverableDrawer', drawer], ['TaskDetailPage', taskDetail]] as const) {
    ok(/from '\.\.\/lib\/markdown-subset'/.test(src), `${name} 引入的是**同一模块**（非各自一份实现）`);
  }
}

// ─────────────────────────────────────────────────────────────
// §S8 批 M2-2：图片成果就地预览 —— 跑**真实现**（读盘与否必须可证伪）
// ─────────────────────────────────────────────────────────────
function s8ImagePreview(): void {
  console.log('\n[S8.1 三个失败边界各自的 reason，且**都不读盘**（记调用，不看返回就下结论）]');
  const calls: string[] = [];
  const io = {
    statSync: (p: string) => { calls.push(`stat:${p}`); return fs.statSync(p); },
    readFileSync: (p: string) => { calls.push(`read:${p}`); return fs.readFileSync(p); },
  };
  const run = (fp: string | null, name: string) => { calls.length = 0; return resolveImagePreview(fp, name, io); };

  const pdf = run('/tmp/某报告.pdf', '某报告.pdf');
  eq(pdf, { ok: false, reason: 'unsupported' }, '`.pdf` ⇒ `unsupported`（白名单之外）');
  eq(calls, [], '反证：非白名单**连 stat 都没调**（读盘本身才是风险面）');

  eq(run(null, '无路径'), { ok: false, reason: 'unsupported' }, 'file_path 为空 ⇒ `unsupported`');
  eq(calls, [], '反证：无路径分支零 fs 调用');
  eq(run('', '无扩展名'), { ok: false, reason: 'unsupported' }, '无扩展名 ⇒ `unsupported`');
  eq(calls, [], '反证：无扩展名分支零 fs 调用');

  const oversizePath = path.join(os.tmpdir(), `rr_m2_big_${process.pid}.png`);
  fs.writeFileSync(oversizePath, Buffer.alloc(IMAGE_PREVIEW_MAX_BYTES + 1));
  try {
    const big = run(oversizePath, 'big.png');
    eq(big, { ok: false, reason: 'oversize', size: IMAGE_PREVIEW_MAX_BYTES + 1, limit: IMAGE_PREVIEW_MAX_BYTES },
      `超上限（${IMAGE_PREVIEW_MAX_BYTES} 字节）⇒ \`oversize\`，且带**实际 size 与 limit**（用户能自己判断差多少）`);
    eq(calls, [`stat:${oversizePath}`], '反证：超限只在 stat 后拦下，**未 readFileSync**');
  } finally { fs.rmSync(oversizePath, { force: true }); }

  // 目录须**带图片扩展名**才走得到 stat——无扩展名会先被判 `unsupported`（那是另一条边界，上面已证）
  const dirPath = path.join(os.tmpdir(), `rr_m2_dir_${process.pid}.png`);
  fs.mkdirSync(dirPath, { recursive: true });
  try {
    eq(run(dirPath, '目录.png'), { ok: false, reason: 'missing' }, '路径是目录 ⇒ `missing`（扩展名对但非普通文件）');
    eq(calls, [`stat:${dirPath}`], '反证：目录分支同样未读盘');
  } finally { fs.rmSync(dirPath, { recursive: true, force: true }); }
  const gone = run(path.join(os.tmpdir(), `rr_m2_gone_${process.pid}.png`), 'gone.png');
  eq(gone, { ok: false, reason: 'missing' }, '文件不存在 ⇒ `missing`（statSync 抛错被接住）');
  eq(calls[0]?.startsWith('stat:'), true, '缺失文件只走到 stat 就返回');

  console.log('\n[S8.2 白名单内正常文件 ⇒ 真读出 base64（与源字节逐字相同）]');
  const okPath = path.join(os.tmpdir(), `rr_m2_ok_${process.pid}.png`);
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(okPath, payload);
  try {
    calls.length = 0;
    const good = resolveImagePreview(okPath, 'ok.png', io);
    ok(good.ok === true, '`.png` 且文件在 ⇒ 读取成功');
    if (good.ok) {
      eq(good.mime, 'image/png', 'MIME 取自**真源表**（扩展名 → mime）');
      eq(good.size, payload.length, '回报实际字节数');
      eq(good.base64, payload.toString('base64'), 'base64 与源文件字节**逐字相同**（不是读了个别的文件）');
      ok(`data:${good.mime};base64,${good.base64}`.startsWith('data:image/png;base64,'), '拼出的 data URL 前缀是 `data:image/…`');
    }
    eq(calls, [`stat:${okPath}`, `read:${okPath}`], '正常分支：先 stat 后 read，各恰一次');
  } finally { fs.rmSync(okPath, { force: true }); }

  eq(Object.keys(IMAGE_PREVIEW_MIME), ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'],
    '白名单六项（用户裁定 D1：png/jpg/jpeg/gif/webp/svg）');
  calls.length = 0;
  const svg = resolveImagePreview('/tmp/x.svg', 'x.svg', io);
  eq(svg, { ok: false, reason: 'missing' },
    '`.svg` **在白名单内**（走到 stat 才因文件不存在而 missing ⇒ 证明它没被当成非图片拦掉）');
  ok(calls[0] === 'stat:/tmp/x.svg', '且确实走到了 stat（而非在扩展名判断处就被拦）');

  console.log('\n[S8.3 handler 只做取行、转壳（判定不在 IPC 层重写一份）]');
  const ipcNoCmt = stripComments(app('src/main/ipc/project.ipc.ts'));
  ok(/resolveImagePreview\(row\.file_path, row\.name, fs\)/.test(ipcNoCmt), 'handler 调**真实现**并注入真 `fs`');
  ok(/if \(!row\) return \{ data: \{ unsupported: true, reason: 'not_found' \} \}/.test(ipcNoCmt),
    '`not_found` 是 handler 独有的一层（行都没查到，轮不到判定）');
  ok(!/statSync\(fp\)/.test(ipcNoCmt) && !/IMAGE_PREVIEW_MIME\[/.test(ipcNoCmt),
    '反证：handler 内**没有**第二份白名单/stat 逻辑（判定只剩 core 一处）');

  console.log('\n[S8.4 renderer 侧不另立第二份白名单（词表只有一个落点）]');
  const drawerNoCmt = stripComments(app('renderer/src/components/DeliverableDrawer.tsx'));
  ok(/previewImage\(id\)/.test(drawerNoCmt), '抽屉真调 `deliverables.previewImage`');
  ok(!/\.png'|\.jpe?g'|\.gif'|\.webp'|\.svg'|image\/png/.test(drawerNoCmt),
    '反证：抽屉**不含**扩展名/MIME 字面量（不复制白名单，超限与否由 main 判）');
  ok(/setImg\(r\?\.dataUrl/.test(drawerNoCmt), '抽屉按 `dataUrl` 有无决定是否渲染');
  ok(!/'unsupported'|'not_found'|'missing'/.test(drawerNoCmt),
    '反证：`unsupported`/`missing`/`not_found` 一律**静默跳过**（不为每条非图片成果占一行"看不了"）');
  ok(/r\?\.reason === 'oversize' \?/.test(drawerNoCmt), '**只有** `oversize` 单独说话（那是用户能采取行动的一种）');
  ok(/previewImage: \(id: string\)/.test(stripComments(app('renderer/src/lib/ipc.ts'))), 'IPC 封装存在（端口名与 main 一致）');
}

// ─────────────────────────────────────────────────────────────
// §S9 批 M2-3/M2-4/M2-5：一把尺 · 归属同集 · 验收打标 · 名实相符
// ─────────────────────────────────────────────────────────────
function m2db(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, context_json TEXT, status TEXT);
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, task_id TEXT, type TEXT, name TEXT, file_path TEXT, status TEXT,
  acceptance_verified INTEGER DEFAULT 0, is_primary INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);`);
  return db;
}

function s9SameYardstick(): void {
  console.log('\n[S9-① M2-3① 探针谓词**只剩一处真源**（按读点穷举，不是只查我记得的那两个文件）]');
  const adminSrc = app('src/main/ipc/admin.ipc.ts');
  const adminNoCmt = stripComments(adminSrc);
  // zx_20260930 M4-1: 由"引了那把尺(docNotProbe)"升级为"引了共享**取数范围/计数真源**"——
  //   连谓词的拼装都不在 admin.ipc 手里，比只引探针片段更强，判据(真源唯一)不变。
  ok(/import \{[^}]*\b(countDeliverables|deliverableScopeSql)\b[^}]*\} from '\.\.\/core\/deliverable-lifecycle\.js'/.test(adminNoCmt),
    'admin.ipc.ts 引入共享取数范围/计数真源（而非自带一份写法）');
  ok(!/'%\/_probe%'/.test(adminNoCmt) && !/'%\/_verify%'/.test(adminNoCmt),
    'admin.ipc.ts **两处**（`:52` 与 `:176` 那两个内联谓词）均已不出现探针字面量');
  const hits: string[] = [];
  // zx_20260930 M3-g: 扫描模式由 `_probe%|_verify%|_tmp%` 改为 `NOT LIKE '%…(probe|verify|tmp)%'`，
  //   并把**真源自身**显式排除出扫描面。原模式既窄（只认 `_probe%` 这种"下划线紧跟词"的旧正字法，
  //   换个转义写法 `\_` 的内联拷贝就照不出来 = 断言名冒充覆盖面）又靠"恰好不等于真源写法"才拿到零命中。
  //   新模式的覆盖面 = "任何内联的探针 LIKE 片段（不论转义与否）"，且**正面**排除真源，不含侥幸。
  const INLINE_PROBE_RE = /NOT LIKE '%[^']*(probe|verify|tmp)%'/;
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'dist' && e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(e.name)) continue;
      if (p.endsWith(`core/deliverable-lifecycle.ts`)) continue;   // 真源本身，不在"内联重复"扫描面内
      // 命中的必须是**真实代码里的内联谓词**（注释已剥）
      if (INLINE_PROBE_RE.test(stripComments(fs.readFileSync(p, 'utf-8')))) hits.push(path.relative(root, p));
    }
  };
  walk(path.join(root, `${A}/src`));
  walk(path.join(root, `${A}/renderer/src`));
  eq(hits, [], '全仓内联探针谓词字面量剩余命中 = 0（真源只在 deliverable-lifecycle.docNotProbe；扫描面自证：真源已正面排除）');
  ok(INLINE_PROBE_RE.test(docNotProbe()), '扫描面自证：该模式**确实能命中真源那种写法**（否则上面的"零命中"是空转假绿）');
  ok(docNotProbe().includes("'%/\\_%probe%'"), '真源本身仍在（不是把尺子一起删了）');
  ok(docNotProbe('d').startsWith('(COALESCE(d.file_path, d.name)'), '真源支持**表别名**（JOIN 场景可用同一把尺）');

  console.log('\n[S9-② M2-3② `retiredCount` 与上方成果列表**同集合**（子树，非仅自身）]');
  const ipcNoCmt2 = stripComments(app('src/main/ipc/project.ipc.ts'));
  // 生产里是模板串 `${ownerIds.map(() => '?').join(',')}`（含 `)`，不能用 `[^)]*` 匹配）
  const m = ipcNoCmt2.match(/`SELECT COUNT\(\*\) AS c FROM wa_deliverables WHERE task_id IN \(\$\{[^}]*\}\) AND status = 'retired'`/);
  ok(!!m, '`retiredCount` 的 SQL 用 `task_id IN (…)`（与成果列表同句法）');
  ok(!/wa_deliverables WHERE task_id = \? AND status = 'retired'/.test(ipcNoCmt2),
    '反证：旧的"仅自身"写法 `task_id = ?` 已不在');
  const db = m2db();
  db.prepare("INSERT INTO wa_tasks (id, context_json) VALUES ('parent','{}'),('child','{}')").run();
  // 0 → 1 的**正面**断言：先证为 0，再 INSERT，再证为 1（不是只断言"不抛"）
  const ownerIds = ['parent', 'child'];
  const countSql = m![0].slice(1, -1).replace(/\$\{[^}]*\}/, '?,?');
  const runCount = () => (db.prepare(countSql).get(...ownerIds) as { c: number }).c;
  eq(runCount(), 0, '先证起点为 0（夹具干净）');
  db.prepare("INSERT INTO wa_deliverables (id, task_id, type, name, status) VALUES ('r1','child','doc','子任务产出','retired')").run();
  eq(runCount(), 1, '**子任务**退休 1 条 ⇒ 父任务视角计数 1（0→1 正面断言）');
  db.prepare("INSERT INTO wa_deliverables (id, task_id, type, name, status) VALUES ('r2','parent','doc','自身产出','retired')").run();
  eq(runCount(), 2, '再加自身 1 条 ⇒ 2（两把尺合一后是**求和**，不是二选一）');
  db.prepare("INSERT INTO wa_deliverables (id, task_id, type, name, status) VALUES ('r3','other','doc','他人产出','retired')").run();
  eq(runCount(), 2, '反证：**无关任务**的退休项不被计入（同集但不是全集）');

  console.log('\n[S9-③ M2-3③ `task:get` 的 acceptance 与列表**同一函数派生**]');
  ok((ipcNoCmt2.match(/annotateAcceptance\(db, /g) || []).length >= 3,
    '`annotateAcceptance` 在 project.ipc 里被**三处**消费（list / preview / task:get）',
    String((ipcNoCmt2.match(/annotateAcceptance\(db, /g) || []).length));
  // zx_20260930 就地订正（**改钉真契约，非放宽**）：原式把返回体**逐字**写成
  //   `{ task, conversations, deliverables, retrospective, retiredCount }`。M4-2 给任务详情加真分页，
  //   返回体**新增** `conversationsTotal`/`deliverablesTotal` ⇒ 逐字式恒红。改钉**不变量**：
  //   ①上一句 `annotateAcceptance` 收到的就是 `deliverables` 这个标识符；②紧随的 return 里
  //   `deliverables` 是**裸键**（回的是同一批，不是另派生一份）；③两个 total 一并回传（分页两口径）。
  const rt = ipcNoCmt2.match(/annotateAcceptance\(db, deliverables as Array<Record<string, unknown>>\);\s*return \{ data: \{([^}]*)\} \}/);
  const rtKeys = rt ? rt[1]!.split(',').map((k) => k.trim().split(':')[0]!.trim()).filter(Boolean) : [];
  ok(!!rt && ['task', 'conversations', 'deliverables'].every((k) => rtKeys.includes(k)),
    '`task:get` 返回体前确实调了它，且回的是**同一批** deliverables', rtKeys.join('/'));
  ok(!!rt && /(?:^|,)\s*deliverables\s*(?:,|$)/.test(rt[1]!),
    '返回体里的 `deliverables` 是**裸键**（不是 `deliverables: 另派生`）');
  ok(rtKeys.includes('conversationsTotal') && rtKeys.includes('deliverablesTotal'),
    '分页两总数一并回传（"已加载 K / 共 M"两个口径一次说清）', rtKeys.join('/'));
  // 扫描面**按读点写明**（承「断言名必须=扫描面」，不冒充覆盖面）：
  //   `deliverable:*` 那三条（list / preview / digest）+ task:get 里**不再有** acceptance_check 的 JSON 解析。
  //   注：`task:list` 用 `json_extract(t.context_json,'$.acceptance_check.…')` 取任务行的 p/t 计数，
  //   那是**任务级展示**（不是成果是否带 ✓），属另一处读点，本轮未收——如实写在方案 §批 M2 实施结果·挂账。
  const jsonExtract = (ipcNoCmt2.match(/json_extract\([^)]*acceptance_check/g) || []).length;
  const jsonParseAcc = (ipcNoCmt2.match(/JSON\.parse\([^)]*\)[\s\S]{0,40}?acceptance_check/g) || []).length;
  eq([jsonExtract, jsonParseAcc], [2, 0],
    'project.ipc 内 acceptance_check 读点：`json_extract` 2 处（**俱在 task:list**）、JSON 解析 0 处');
  const lc = stripComments(app('src/main/core/deliverable-lifecycle.ts'));
  // 判据锚在**解析结果**上，而非"出现过 JSON.parse 且含 context_json"——后者会把
  // `promoteTaskFileDeliverables`（读的是 `deliverable_unfulfilled`，另一件事）也算进来。
  const parses = lc.match(/JSON\.parse\([^)]*\)[^;\n]{0,120}?acceptance_check/g) || [];
  // zx_20260915 P0-2(d): 解析处**仍是一处**，但由 `verifiedAcceptanceMap` 下移一级到 `parseAcceptance`
  //   ——P0-2 要让「验过」与「没验」**同一遍解析**各取其图（合成一图会诱使每个读点各自再判一次 `verified`）。
  eq(parses.length, 1, 'core 内 `acceptance_check` 的 JSON 解析**恰一处**（`parseAcceptance`）');
  ok(/JSON\.parse\(row\.context_json/.test(lc.slice(lc.indexOf('function parseAcceptance('), lc.indexOf('function parseAcceptance(') + 700)),
    '那唯一一处就在 `parseAcceptance` 体内');
  ok(lc.slice(lc.indexOf('export function verifiedAcceptanceMap'), lc.indexOf('export function verifiedAcceptanceMap') + 220).includes('parseAcceptance(db, taskIds).verified'),
    '`verifiedAcceptanceMap` 是该解析处的**已核验视图**（委托，不是另起一条路）');
  // 消费方：两条打标入口(markDoc…/markDeliverable…)仍走 `verifiedAcceptanceMap`；
  //   `annotateAcceptance` P0-2 起改走 `parseAcceptance`（它要的正是**两态**，只看已核验那一半就答不了"没验"）。
  const vamUses = lc.match(/verifiedAcceptanceMap\(db, /g) || [];
  eq(vamUses.length, 2, '`verifiedAcceptanceMap` 被恰两处调用（markDocAcceptanceVerified / markDeliverableAcceptanceVerified）');
  ok(/parseAcceptance\(db, \[/.test(lc.slice(lc.indexOf('export function annotateAcceptance'), lc.indexOf('export function verifiedAcceptanceMap'))),
    '`annotateAcceptance` 改取两态视图 `parseAcceptance`（同一解析处，未核验那一半由它下发 `task_acceptance`）');
  const annBody = lc.slice(lc.indexOf('export function annotateAcceptance'), lc.indexOf('export function verifiedAcceptanceMap'));
  ok(!/JSON\.parse/.test(annBody), '反证：`annotateAcceptance` 自己**不解析**（委托给唯一解析处）');
  // zx_20260915 P0-2(d): 委托对象由 `verifiedAcceptanceMap`（只出"验过"）改为其**下层的同一解析处**
  //   `parseAcceptance`（一次解析出两态——只看"验过"那一半就答不了"没验"）。仍是委托，不是各走各的。
  ok(/parseAcceptance\(db, /.test(annBody), '且确实委托给了它（不是两条路各走各的）');

  const db2 = m2db();
  db2.prepare("INSERT INTO wa_settings (key, value) VALUES ('deliverable.show_acceptance','true'),('deliverable.per_doc_acceptance','true')").run();
  db2.prepare("INSERT INTO wa_tasks (id, context_json) VALUES ('t1', ?)")
    .run(JSON.stringify({ acceptance_check: { criteria_total: 4, passed_total: 3, checked_at: '2026-09-15 10:00:00', verified: true } }));
  db2.prepare("INSERT INTO wa_deliverables (id, task_id, type, name, status, acceptance_verified) VALUES ('d_doc','t1','doc','报告','completed',1)").run();
  db2.prepare("INSERT INTO wa_deliverables (id, task_id, type, name, status, acceptance_verified) VALUES ('d_ui','t1','ui','界面','completed',1)").run();
  db2.prepare("INSERT INTO wa_deliverables (id, task_id, type, name, status, acceptance_verified) VALUES ('d_raw','t1','doc','报告','completed',0)").run();
  const rows = db2.prepare('SELECT id, task_id, type, name, status, acceptance_verified FROM wa_deliverables ORDER BY id').all() as Array<Record<string, unknown>>;
  annotateAcceptance(db2, rows);
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  ok(!!byId.get('d_doc')!.acceptance, 'per-doc 下：`doc` 且已打标 ⇒ 下发 acceptance');
  eq(byId.get('d_doc')!.acceptance, { criteria_total: 4, passed_total: 3, checked_at: '2026-09-15 10:00:00' }, '下发的**就是** ctx 里那份结论（不重算）');
  ok(!byId.get('d_ui')!.acceptance, '反证：`ui` 类**不**下发（per-doc 口径 = 类型在册 且 本行已打标）');
  ok(!byId.get('d_raw')!.acceptance, '反证：`doc` 但**未打标** ⇒ 不下发（逐条如实）');
  db2.prepare("UPDATE wa_settings SET value = 'false' WHERE key = 'deliverable.per_doc_acceptance'").run();
  const rows2 = db2.prepare('SELECT id, task_id, type, name, status, acceptance_verified FROM wa_deliverables ORDER BY id').all() as Array<Record<string, unknown>>;
  annotateAcceptance(db2, rows2);
  const byId2 = new Map(rows2.map((r) => [r.id as string, r]));
  ok(!!byId2.get('d_ui')!.acceptance && !!byId2.get('d_raw')!.acceptance,
    'per_doc=false ⇒ 回落任务级扇出（三条全下发，含 `ui` 与未打标者）');
  db2.prepare("UPDATE wa_settings SET value = 'false' WHERE key = 'deliverable.show_acceptance'").run();
  const rows3 = db2.prepare('SELECT id, task_id, type, name, status, acceptance_verified FROM wa_deliverables ORDER BY id').all() as Array<Record<string, unknown>>;
  annotateAcceptance(db2, rows3);
  ok(rows3.every((r) => !r.acceptance), '总门控关 ⇒ **一律不下发**（与列表/预览/详情三处同一门）');
  ok(verifiedAcceptanceMap(db2, []).size === 0, '空任务集 ⇒ 空表（不查库、不抛）');
  ok(verifiedAcceptanceMap(db2, ['t1']).get('t1')?.passed_total === 3, '数据口径函数**不受展示开关影响**（digest 取数用）');
}

function s9Accept(): void {
  console.log('\n[S9-④ M2-4 标为已验收：真改库（0→1）+ 三类拒绝各自如实 + 打标 UPDATE 恰一处]');
  const db = m2db();
  db.prepare("INSERT INTO wa_settings (key, value) VALUES ('deliverable.show_acceptance','true')").run();
  db.prepare("INSERT INTO wa_tasks (id, context_json) VALUES ('t_ok', ?)")
    .run(JSON.stringify({ acceptance_check: { criteria_total: 2, passed_total: 2, checked_at: '2026-09-15 10:00:00', verified: true } }));
  db.prepare("INSERT INTO wa_tasks (id, context_json) VALUES ('t_unverified', ?)")
    .run(JSON.stringify({ acceptance_check: { criteria_total: 2, passed_total: 0, checked_at: '2026-09-15 10:00:00', verified: false } }));
  const ins = "INSERT INTO wa_deliverables (id, task_id, type, name, file_path, status, acceptance_verified) VALUES (?,?,?,?,?,?,0)";
  db.prepare(ins).run('a1', 't_ok', 'doc', '报告', '/x/report.md', 'completed');
  db.prepare(ins).run('a2', 't_ok', 'ui', '界面', '/x/ui.png', 'completed');
  db.prepare(ins).run('a3', null, 'doc', '手工成果', '/x/manual.md', 'completed');
  db.prepare(ins).run('a4', 't_unverified', 'doc', '未核验', '/x/draft.md', 'completed');
  db.prepare(ins).run('a5', 't_ok', 'doc', '探针', '/_probe_x.md', 'completed');
  db.prepare(ins).run('a6', 't_ok', 'doc', '已退休', '/x/old.md', 'retired');
  const val = (id: string) => Number((db.prepare('SELECT acceptance_verified AS v FROM wa_deliverables WHERE id = ?').get(id) as { v: number }).v);

  eq(val('a1'), 0, '先证起点 0（夹具干净，防"本来就是 1"的假绿）');
  const r1 = markDeliverableAcceptanceVerified(db, 'a1');
  eq(r1, { ok: true, changed: 1 }, '标一次 ⇒ `ok:true, changed:1`');
  eq(val('a1'), 1, '**acceptance_verified 0 → 1**（正面断言，不是"不抛"）');
  eq(markDeliverableAcceptanceVerified(db, 'a1'), { ok: true, changed: 0 }, '再标一次 ⇒ 幂等（`changed:0` 且仍 `ok`，界面据此说"此前已标记"）');
  eq(val('a1'), 1, '幂等重复点不把值改坏（仍为 1）');

  const rejects: Array<[string, string, string]> = [
    ['a2', 'not_acceptance_type', '非验收类型（`ui`）⇒ 拒绝'],
    ['a3', 'no_owning_task', '无产出任务的手工成果 ⇒ 拒绝'],
    ['a4', 'ctx_not_verified', '任务验收**未核验** ⇒ 拒绝（不凭空盖章）'],
    ['a5', 'not_in_register', '探针（不在册）⇒ 拒绝'],
    ['a6', 'not_in_register', '已 retired ⇒ 拒绝'],
  ];
  for (const [id, reason, label] of rejects) {
    const r = markDeliverableAcceptanceVerified(db, id);
    eq(r, { ok: false, changed: 0, reason }, label);
    eq(val(id), 0, `反证：${id} 被拒后**库值仍为 0**（拒绝就是真没改）`);
  }
  eq(markDeliverableAcceptanceVerified(db, 'nope'), { ok: false, changed: 0, reason: 'not_found' }, '不存在的 id ⇒ `not_found`');

  const lc = stripComments(app('src/main/core/deliverable-lifecycle.ts'));
  const updates = lc.match(/UPDATE wa_deliverables SET acceptance_verified = 1/g) || [];
  eq(updates.length, 1, '全仓 core 内 `SET acceptance_verified = 1` 的 UPDATE **恰一处**（任务级与 id 级共用 `markVerifiedWhere`）');
  ok(/id = \?/.test(lc) && /task_id = \?/.test(lc), '两个入口各自只传 WHERE 片段（写法不带第二份谓词）');
  const ipc = stripComments(app('src/main/ipc/project.ipc.ts'));
  ok(!/SET acceptance_verified = 1/.test(ipc), '反证：IPC 层**没有**第二处打标 SQL（M2-4 不得自成一套）');
  ok(/boolSetting\(accCfg\?\.value\)/.test(ipc), '`deliverable:accept` 过**总门控**（与列表/预览/详情同一开关）');
  ok(/'deliverable\.show_acceptance'/.test(ipc), '门控读的就是那个 key（不是另起的开关名）');
}

function s9NameMatches(): void {
  console.log('\n[S9-⑤ M2-5 名实相符：注释里的数字 = 运行期真值；`registry_id` 真出现在渲染面]');
  const trSrc = app('src/main/core/tool-registry.ts');
  const m = stripComments(trSrc).match(/\/\*\*[\s\S]*?\*\/\s*[\s\S]{0,80}?(\d+)\s*个工具的元数据表/) || trSrc.match(/(\d+)\s*个工具的元数据表/);
  ok(!!m, '注释里确有"N 个工具的元数据表"这句（锚点存在，否则下面的比对无意义）');
  const claimed = m ? Number(m[1]) : NaN;
  eq(claimed, TOOL_METAS.length, `注释数字 ${claimed} = 运行期 \`TOOL_METAS.length\` ${TOOL_METAS.length}（写死只会把漂移推迟到下一轮）`);
  ok(TOOL_METAS.length > 0 && new Set(TOOL_METAS.map((t) => t.name)).size === TOOL_METAS.length,
    '元数据表内 `name` 无重复（计数才有意义）');
  ok(/name: 'bash'/.test(trSrc) && /name: 'search_web'/.test(trSrc),
    '反证：多行写法的条目（`bash`/`search_web`）**确实在表里**——上一轮"少 4 条"正是单行 grep 漏了它们');

  const drawerNoCmt = stripComments(app('renderer/src/components/DeliverableDrawer.tsx'));
  ok(/registry_id/.test(drawerNoCmt), '抽屉源码出现 `registry_id`');
  const uses = drawerNoCmt.match(/data\??\.registry_id/g) || drawerNoCmt.match(/registry_id/g) || [];
  ok(uses.length >= 1, '`registry_id` 出现在**取值/渲染位置**（非仅类型声明）');
  ok(/注册端点/.test(app('renderer/src/components/DeliverableDrawer.tsx')),
    '且有**用户看得见的中文标签**（`注册端点：`）——取值落到了界面上，不是读了个变量就丢');
  ok(/shell:openExternal/.test(drawerNoCmt), 'http(s) 注册端点给的是**可点的外链**（不是死字符串）');
  ok(/registry_id\?: string/.test(app('renderer/src/components/DeliverableDrawer.tsx')), '类型位仍在（写入侧未停写）');
  ok(/registry_id/.test(app('src/main/ipc/project.ipc.ts')), '反证：写入侧**仍在写** `registry_id`（本轮只补渲染，不改数据）');
}

async function main(): Promise<void> {
  s1Static();
  await s1Run();
  await s2();
  s4Static();
  await s4Run();
  s5();
  s6();
  s7Markdown();
  s8ImagePreview();
  s9SameYardstick();
  s9Accept();
  s9NameMatches();
  console.log('\n[S3 轮级 build 钉子（P1–P6 派生一致性）]');
  checkBuildPins(ok, { distDir: path.join(root, `${A}/dist`) });
  console.log(`\n结果: pass=${pass} fail=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
