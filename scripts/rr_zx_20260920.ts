/**
 * zx_20260920 受控复跑 —— 「沉默不是一种」。
 *
 * 病根（`plans/improve/zx_20260920.md` §1.2）：用户发出一条消息后，「没反应」**不是一个状态，是四种**——
 *   而其中三种**连账都没有**，事后无人（包括 agent 自己）能查出当时究竟发生了哪一种。
 *   S1 风暴丢弃发生在落库**之前**（`isStorm` 的 `return` 排在 `INSERT INTO wa_im_conversations` 前面）
 *      ⇒ 那条消息不落库、不回话、不告警，GUI 对话里查不到。
 *   S2 32 个回话点里 14 处 `.catch(() => {})`，而 `ctx.sendReply` 的构造处**也**只 `console.warn`
 *      ⇒ 两层空吞叠加：用户收不到，GUI 也**没有一行**记录"这句话没送出去"。
 *   S3 审批回执晚于状态变更（`resumeWithQuota` + `enqueueJob` 先于 `ctx.sendReply`）⇒ 回执失败即账实不符。
 *   S4 补发成功既翻旧行（`flipConversationSent`）又插新行（五个适配器各自 INSERT）⇒ 同一句话两行。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §P 判据 P（**静态**·沉默的四个出口位置）：扫描面 = 去注释后的生产源码。
 *   ⚠ 一律**去注释**（`stripKeepingLines`）：本轮的病根正是"注释与代码各说各话"，不去注释则判据会被
 *     那句"说了要做对的话"喂饱 —— 假绿经典形态（承 zx_20260918 同名教训）。
 *   P-1 **正面**：`routeImMessage` 内，风暴判定的 `return` **必须晚于**落库；且风暴判定**仍在**（缺席不算通过）。
 *   P-2 **反证**：`isDuplicate` 的 `return` **仍在**落库**之前** —— 它是防平台 webhook 重放，语义正当，
 *       本轮**刻意不动**（方案 §2.5-D2）。钉子在此，防下一轮有人"顺手统一"把防重放改成落库后再判、
 *       反而生出重复行。
 *   P-3：`im-router.ts` 内形如 `.catch(() => {})` 的**空吞**计数 == 0（14 处全清）；
 *       只统计**逐字空吞**，不误伤 `.catch(e => …)` 这类如实处理。
 *   P-4：写**失败/条件缺失**对话行的 INSERT **恰 3 处**（通知记账 + 手动重发失败 + **本轮新增**的人机回话失败），
 *       并**反向**断言"不得出现第四处"。⚠ 本条与 `rr_zx_20260913.ts` 的 `=== 2` 断言是**同一件事**——
 *       那是**有意扩围**（新增第三处的**语义**：人机回话失败），改它时必须同时加反向断言，否则等于把门拆了。
 *       ⚠ zx_20260929 M8-c 订正识别方式：锚在**列清单含 `status`**，不再靠 `'failed'` 字面量
 *       （状态值已移入绑定参数，`failed`/`blocked_quota` 同一张表；详见 `FAILED_WRITER_RE` 注释）。
 *   P-5：五个适配器的 `sendReply` 签名含可选 `opts`，且落行前的闸是**共用真源** `shouldRecordConversation(opts)`
 *       ——**并须确实包住**「插对话行 + 发事件」二者（"字符串在场" ≠ "被它管辖"），且闸内**不得**含真实发送动作。
 * §R 判据 R（**静态**·不许顺手放宽）：
 *   R-1 风暴阈值仍是「2 秒内第 3 条」、冷却仍 15 秒（不得借本轮把阈值放宽来"消掉"问题）。
 *   R-2 `autoStartDaemons` 复起集 / `isRealDeliverableRow` 白名单**一字未改**（zx_20260918 已钉，本轮不碰）。
 *   R-3 `wa_im_conversations.status` 列 DEFAULT 仍 `'sent'` —— 成功 INSERT **不得**手写 status
 *       （承 zx_20260913 的"列 DEFAULT 一处真源"；本轮的第三处 failed 写者**必须**写 status，故 R-3 只约束
 *        **成功**那一类 INSERT）。⚠ zx_20260929 M8-c 订正判据形状：改为断言「**无任何** INSERT 手写
 *        `status='sent'`」+「显式写 status 列的 INSERT 恰 3 处」——旧写法靠 `'failed'` 反推"成功行"，
 *        M8-c 后会把两处失败行写者误判成越界。
 * §Q 判据 Q（**行为**·真实现，不复刻 SQL）—— 随批次追加：
 *   Q-1（M1 风暴可见）· Q-2（M2 回话失败落账）· Q-3（M4 补发不再两行：真补发路径跑通 + 两只标本试判据）·
 *   Q-4（M5 记忆产量坐实）。
 * §S 判据 S：`checkBuildPins(ok, { distDir })`（P1–P6 全套）。
 *
 * ⚠ 本文件**不打开真库**、不改任何生产行为（真库实况见 `data/baseline_zx_20260920.json`）。
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**（P6 取产物内 build 值本身）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { routeImMessage, stormVerdict, STORM_NOTICE, STORM_COOLDOWN_MS } from '../apps/worker-ant-desktop/src/main/services/im-router.js';
import type { StormState } from '../apps/worker-ant-desktop/src/main/services/im-router.js';
import { accountOutboundFailure } from '../apps/worker-ant-desktop/src/main/core/im/reply-accounting.js';
import { shouldRecordConversation } from '../apps/worker-ant-desktop/src/main/services/im-adapter.js';
import type { ImSendOpts } from '../apps/worker-ant-desktop/src/main/services/im-adapter.js';
import { enqueueImOutbox, retryOutboxEntry } from '../apps/worker-ant-desktop/src/main/core/im/im-outbox.js';
import { sendManualImMessage } from '../apps/worker-ant-desktop/src/main/core/im/manual-send.js';
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
// zx_20260920_1 M7: 门槛 SQL 现由**模板字面量**拼出 `${PANORAMA_MIN_IMPORTANCE}` ⇒ Q-4 就地取出时
//   要把令牌**代回真值**，故按命名空间取常量模块（**不手抄 0.6**：真源是 `core/memory-constants.ts`）。
import * as memConsts from '../apps/worker-ant-desktop/src/main/core/memory-constants.js';
// zx_20260930 M6: Q-4 ④ 的期望值改由**生产同一个函数**给出（`decayFactor` + `memoryAgeDays`），
//   不另写一份 `0.5**(age/hl)` —— 半衰期分档与"年龄取哪个时间戳"的真源都在 `core/memory-decay.ts`。
import { decayFactor, memoryAgeDays, MEM_HALF_LIFE_DAYS } from '../apps/worker-ant-desktop/src/main/core/memory-decay.js';
import type { DecaySubject } from '../apps/worker-ant-desktop/src/main/core/memory-decay.js';
import { eventBus } from '../apps/worker-ant-desktop/src/main/core/event-bus.js';

type AnyDb = {
  prepare: (sql: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
  exec: (s: string) => void;
};

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) => ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const MAIN = path.join(root, `${A}/src/main`);

/** 扫源码一律**去注释**：本轮判据问的是"代码此刻怎么做"，不是"注释曾说什么"。 */
const strip = (p: string) => stripKeepingLines(fs.readFileSync(p, 'utf-8')).join('\n');
const relOf = (p: string) => path.relative(root, p);

/** 递归收集 `src/main` 下全部 `.ts`（P-4 的扫描面是**整个 src/main**）。 */
function walkTs(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

/** 取 `from` 起**第一个** `{` 的配对花括号块原文（按**符号 + 配对括号**界定，不按行号）。 */
function braceBlock(src: string, from: number): string {
  if (from < 0) return '';
  const open = src.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(open, j + 1); }
  }
  return '';
}

/** Q-1b / Q-2 共用的对话表结构（与生产 `wa_im_conversations` 的列一一对应：DEFAULT 一字不差）。 */
const CONV_DDL = `CREATE TABLE wa_im_conversations (
  id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, project_id TEXT,
  message_json TEXT DEFAULT '{}', direction TEXT DEFAULT 'inbound',
  created_at TEXT DEFAULT (datetime('now')), status TEXT DEFAULT 'sent',
  last_error TEXT DEFAULT '', outbox_id TEXT DEFAULT '');`;

/** 命中的行号（1 起）+ 行的**字符偏移**——行号只用于报点，判据本身按符号。 */
function hitsOf(src: string, re: RegExp): Array<{ line: number; at: number; text: string }> {
  const out: Array<{ line: number; at: number; text: string }> = [];
  let at = 0;
  src.split('\n').forEach((t, i) => {
    re.lastIndex = 0;
    if (re.test(t)) out.push({ line: i + 1, at, text: t.trim() });
    at += t.length + 1;
  });
  return out;
}

/**
 * 函数**体**原文——先配对**参数表**的 `)`，再从那里找配对花括号。
 *
 * ⚠ 不能直接 `braceBlock(src, i)`：`function stormVerdict(prev, now): { next: StormState; storm: boolean; … } {`
 *   的返回值**类型字面量**里就有 `{`，那会先被当成函数体 ⇒ 切出一个只有三个字段名的类型块，
 *   里面当然搜不到任何常量名。（M1 首版就这么写的，实测把一条**正确代码**判成了红 ——
 *   "判据不可能被合法实现满足" 的假红，与 zx_20260916「判据须能被合法数据满足」同族。）
 */
function fnBodyOf(src: string, from: number): string {
  if (from < 0) return '';
  const open = src.indexOf('(', from);
  if (open < 0) return '';
  let depth = 0;
  let close = -1;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '(') depth++;
    else if (src[j] === ')') { depth--; if (depth === 0) { close = j; break; } }
  }
  if (close < 0) return '';
  // 参数表之后每个 `{` 起算的配对块都是候选：返回**类型字面量**与**函数体**长得一样
  //   （都是 `{ … }`），靠"跳过类型"这类规则区分只会把函数体也一起跳掉。
  //   可判别的差异只有一个：**函数体里有 return**（类型字面量里没有）。取"含 return 且最长"的那个。
  const cands: string[] = [];
  for (let k = close + 1; k < Math.min(src.length, close + 800); k++) {
    if (src[k] !== '{') continue;
    const b = braceBlock(src, k);
    if (b) cands.push(b);
  }
  const bodies = cands.filter((b) => /\breturn\b/.test(b)).sort((a, b) => b.length - a.length);
  return bodies[0] ?? '';
}

/** `routeImMessage` 的函数体原文（按符号 + 配对括号切；找不到返回 ''）。 */
function routeBody(src: string): string {
  const i = src.search(/(?:export\s+)?async\s+function\s+routeImMessage\s*\(/);
  return fnBodyOf(src, i);
}

/** 风暴判定点在函数体内的偏移（`isStorm(` / `stormVerdict(` 两代写法都认）；找不到返回 -1。 */
function stormDecisionAt(body: string): number {
  const a = body.search(/\b(?:isStorm|stormVerdict)\s*\(/);
  return a;
}

/** 形如 `.catch(() => {})` 的**空吞**（逐字空吞；`.catch(e => …)` / `.catch(() => { 记账 })` 不算）。 */
const EMPTY_CATCH_RE = /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g;
const countEmptyCatch = (s: string) => (s.match(EMPTY_CATCH_RE) || []).length;

/**
 * **回话点**上的空吞：只看"这条语句本身是 `sendReply`"的那些。
 *
 * 为什么不能直接数全文件：`im-router.ts` 里还有一条 `eventBus.emitTransient('im.message_inbound', …).catch(() => {})`
 * —— 它是**瞬态事件**（不落事件日志、漏收即漏收），与"用户的一句话没送出去"是两回事。
 * 判据若把两者并成一个数，要么**假红**（那条本来就不该进本轮范围），要么逼着把瞬态事件也做成落账 —— 越界。
 *
 * ⚠ 定位**必须走真调用**：先前用"向前找最近的 `;`/`{`/`}`"做过一版，**实测漏掉 6/14 处**——
 *   `ctx.sendReply(fromUser, \`✅ 已确认，任务「${task.title}」…\`).catch(…)` 里模板字面量的 `}`
 *   被当成了语句边界，`sendReply` 二字被切在窗口外。**假绿**正是这么来的（一个数少算一半）。
 *   故改为**从 `sendReply(` 起按括号/引号状态机扫到配对右括号**，再问紧跟其后的是什么。
 */
const SEND_REPLY_RE = /\b(?:ctx\.)?sendReply\s*\(/g;

/** 从 `from`（`(` 之后）扫到配对右括号，返回右括号的下一个位置；扫不到返回 -1。 */
function matchCallEnd(src: string, from: number): number {
  let i = from;
  const stack: string[] = ['paren'];
  let guard = 0;
  while (i < src.length && stack.length > 0 && guard++ < 20_000) {
    const c = src[i]!;
    const top = stack[stack.length - 1];
    if (top === 'sq' || top === 'dq') {
      if (c === '\\') { i += 2; continue; }
      if ((top === 'sq' && c === "'") || (top === 'dq' && c === '"')) { stack.pop(); i++; continue; }
      i++; continue;
    }
    if (top === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); i++; continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push('tplcode'); i += 2; continue; }
      i++; continue;
    }
    // 代码态：paren / brace / tplcode
    if (c === "'") { stack.push('sq'); i++; continue; }
    if (c === '"') { stack.push('dq'); i++; continue; }
    if (c === '`') { stack.push('tpl'); i++; continue; }
    if (c === '(') { stack.push('paren'); i++; continue; }
    if (c === '{') { stack.push('brace'); i++; continue; }
    if (c === '}') { if (top === 'tplcode' || top === 'brace') stack.pop(); i++; continue; }
    if (c === ')') { if (top === 'paren') { stack.pop(); i++; continue; } i++; continue; }
    i++;
  }
  return stack.length === 0 ? i : -1;
}

/** 回话点上的空吞：**逐处点名**（返回 1 起行号）。 */
function emptyCatchOnSendReplyHits(s: string): number[] {
  const out: number[] = [];
  for (const m of s.matchAll(SEND_REPLY_RE)) {
    const end = matchCallEnd(s, m.index! + m[0].length);
    if (end < 0) continue;
    if (/^\s*\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(s.slice(end, end + 80))) {
      out.push(s.slice(0, m.index).split('\n').length);
    }
  }
  return out;
}
const emptyCatchOnSendReply = (s: string) => emptyCatchOnSendReplyHits(s).length;

/**
 * 写**失败 / 条件缺失**对话行的 INSERT：`INSERT INTO wa_im_conversations` 的**列清单**里含 `status`。
 * zx_20260929 M8-c 订正（**改钉更强的真源，非放宽**）：旧判据靠 `'failed'` 字面量识别失败行，
 *   M8-c 把状态值移入**绑定参数**（`failed` / `blocked_quota` 同一张表）后，只剩 im-outbox 一家
 *   还写字面量 ⇒ 旧判据会把 IM手发、机器回话两处**误判成"没有失败行写者"**。
 *   新判据锚在**列清单**上：成功行一律靠列 DEFAULT='sent'（不写 status 列），故写 status 列者即失败行写者。
 */
const FAILED_WRITER_RE = /INSERT\s+INTO\s+wa_im_conversations\s*\([^)]*\bstatus\b[^)]*\)/;

async function main(): Promise<void> {
  const router = strip(path.join(MAIN, 'services/im-router.ts'));
  const ipc = strip(path.join(MAIN, 'ipc/im.ipc.ts'));
  const exe = strip(path.join(MAIN, 'core/agent-executor.ts'));
  const body = routeBody(router);

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M1·判据 P-1】风暴丢弃必须发生在**落库之后**（丢可以，丢得看不见不行）');
  {
    ok(body.length > 0, 'P-1 前置：`routeImMessage` 函数体**非空**（按符号切得出——切不出则下面全是假绿）');
    const iStorm = stormDecisionAt(body);
    const iInsert = body.indexOf('INSERT INTO wa_im_conversations');
    ok(iInsert >= 0, 'P-1 前置：函数体内**确有** `INSERT INTO wa_im_conversations`（落库点在场）');
    ok(iStorm >= 0, '★ P-1 正面：风暴判定**仍在**（把它整个删掉也算"不再丢"？不——那只是把防刷屏一起拆了，不是本轮的意思）');
    ok(iStorm >= 0 && iInsert >= 0 && iStorm > iInsert,
      '★ P-1 正面：风暴判定的 `return` **晚于**落库 —— 风暴命中的那条消息**已入库**（GUI 里看得见），只是不再往下走指令管道');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M1·判据 P-2】反证：去重**仍在**落库之前（防 webhook 重放，本轮**刻意不动**）');
  {
    const iDedup = body.search(/\bisDuplicate\s*\(/);
    const iInsert = body.indexOf('INSERT INTO wa_im_conversations');
    ok(iDedup >= 0, '★ P-2 正面：`isDuplicate` 判定**仍在**（防平台重放的那道闸没被顺手拆掉）');
    ok(iDedup >= 0 && iInsert >= 0 && iDedup < iInsert,
      '★ P-2 反证：`isDuplicate` 的 `return` **仍早于**落库 —— 若被"顺手统一"到落库之后，平台重放就会**真的**生出重复行');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M2·判据 P-3】回话失败**不得空吞**：`im-router.ts` 内**回话点**上的 `.catch(() => {})` 计数为 0');
  {
    const n = emptyCatchOnSendReply(router);
    const rel = relOf(path.join(MAIN, 'services/im-router.ts'));
    const hits = emptyCatchOnSendReplyHits(router).map((l) => `${rel}:${l}`);
    ok(countEmptyCatch(router) >= n,
      `P-3 前置：文件内空吞总数（${countEmptyCatch(router)}）≥ 回话点空吞数（${n}）—— 防"定位手法把该数的漏掉"的假绿`);
    eq(n, 0,
      `★ P-3 回话点空吞计数 == 0（实测 ${n} 处）—— 失败统一由 \`sendReply\` 一处负责，调用点不再各吞各的${hits.length ? `\n     逐处：${hits.join('、')}` : ''}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M2·判据 P-4】写 `failed` 对话行的 INSERT **恰 3 处**（有意扩围，非放宽——故附反向断言）');
  {
    const FILES = walkTs(MAIN).map((p) => ({ rel: relOf(p), src: strip(p) }));
    ok(FILES.length > 20, `P-4 前置：扫描面非退化（src/main 下 ${FILES.length} 个 .ts —— 防"扫描面悄悄变空"的假绿）`);
    const writers = FILES.flatMap((f) => hitsOf(f.src, FAILED_WRITER_RE).map((h) => `${f.rel}:${h.line}`));
    eq(writers.length, 3,
      `★ P-4 写 failed 行的 INSERT **恰 3 处**（实测 ${writers.length}）\n     逐处：${writers.join('、')}\n     语义各为：通知记账 / 手动重发失败 / 人机回话失败`);
    ok(writers.length < 4,
      '★ P-4 反证：**不得出现第四处** —— 四处以上即意味着有写路径绕开了这三处约定，门等于被拆了');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M4·判据 P-5】五家适配器共用**同一判据**（`shouldRecordConversation`），且该判据**确实包住**落行与到场');
  {
    const ADAPTERS = ['wechat-adapter.ts', 'dingtalk-adapter.ts', 'wecom-adapter.ts', 'feishu-adapter.ts', 'qqbot-adapter.ts'];
    for (const a of ADAPTERS) {
      const src = strip(path.join(MAIN, 'services', a));
      const sig = /async\s+sendReply\s*\(([^)]*)\)/.exec(src);
      ok(!!sig, `P-5 前置：${a} 的 \`sendReply\` 签名取得到`);
      ok(!!sig && /opts\?\s*:/.test(sig[1]!), `★ P-5 ${a}：\`sendReply\` 仍含可选 \`opts\``);
      // ① 判据走**共用真源**，不各写一遍字面量（散成五份 ⇒ 改一处漏四处，且散写后判据无从复跑）
      const GATE_RE = /if\s*\(\s*shouldRecordConversation\(\s*opts\s*\)\s*\)\s*\{/;
      ok(GATE_RE.test(src),
        `★ P-5 ${a}：落行前的闸是 **\`shouldRecordConversation(opts)\`**（共用真源，不各写 \`opts?.recordConversation !== false\`）`);
      ok(!/opts\?\.recordConversation\s*!==\s*false/.test(src),
        `★ P-5 ${a} 反证：本文件内**不再**出现内联判据 —— 否则真源仍有两份，"改一处"就不成立`);
      // ② 闸**确实包住**"落账"这一跳 —— "字符串在场" ≠ "被它管辖"（串到闸外一样能让上面两条变绿）。
      //    ⚠ zx_20260930 M2-c：落账的两步（`INSERT INTO wa_im_conversations` + `emitOutboundMessage`）已
      //    收进**共享出站写口** `core/im/outbound-record.ts` ⇒ 闸块里不该再见到这两串字面量本身，
      //    该见的是**调那个写口**。下面同时钉两头（本块调写口 / 写口内含那两步），不是放宽。
      const gated = braceBlock(src, src.search(GATE_RE));
      ok(gated.length > 0, `P-5 前置：${a} 的闸**块**切得出`);
      ok(gated.includes('recordOutboundConversation('),
        `★ P-5 ${a}：闸**包住**了「落账」这一跳（调共享写口 \`recordOutboundConversation\`，块长 ${gated.length}）—— 漏之则补发仍多一行`);
      ok(!gated.includes('INSERT INTO wa_im_conversations') && !gated.includes('emitOutboundMessage('),
        `★ P-5 ${a} 反证：落账两步已**不在**本文件内联（收进共享写口）；本块若重现其字面量 ⇒ 真源又散成两份`);
      ok(!gated.includes('fetch(') && !gated.includes('await '),
        `★ P-5 ${a} 反证：闸**只管落账**，不含真实发送动作（\`fetch\` / \`await\`）—— 否则 \`recordConversation:false\` 会连"发"都不发了`);
    }
    // 正面钉住另一半：共享写口**内含**那两步（否则上面对五家的"调写口"全票通过，写口却是空壳）
    const obr = strip(path.join(MAIN, 'core', 'im', 'outbound-record.ts'));
    ok(obr.includes('INSERT INTO wa_im_conversations') && obr.includes('emitOutboundMessage('),
      '★ P-5 共享写口 `core/im/outbound-record.ts` **内含**「插对话行 + 发 `im.message_outbound`」两步（五家的落账都归这一处）');
    eq((obr.match(/INSERT INTO wa_im_conversations/g) || []).length, 1,
      '★ P-5 共享写口内 `INSERT INTO wa_im_conversations` **恰 1 处**（一个消息一行，落账只此一处）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M1·判据 Q-1a】风暴判定（**纯函数·真实现**）：窗内第 3 条起判暴，冷却里只提示一次，出窗即复位');
  {
    const t0 = 1_700_000_000_000;
    let st: StormState | undefined;
    const run = (t: number) => { const v = stormVerdict(st, t); st = v.next; return v; };
    const seq = [t0, t0 + 100, t0 + 200, t0 + 300, t0 + STORM_COOLDOWN_MS + 1_000].map(run);
    eq(seq.map((v) => v.storm), [false, false, true, true, false],
      '★ Q-1a 判暴时序：窗内前两条**照常处理**、第 3 条起判暴、冷却期内继续判暴、**出窗即复位**（冷却不是永久静音）');
    eq(seq.map((v) => v.firstInCooldown), [false, false, true, false, false],
      '★ Q-1a 提示时序：全序列里 `firstInCooldown` **恰一次**为真 —— 冷却期内只提示一次（D3：提示本身不许变成刷屏）');
    eq(seq[2]!.next.cooldownUntil - (t0 + 200), STORM_COOLDOWN_MS,
      '★ Q-1a 冷却长度取载体自身的 `STORM_COOLDOWN_MS`（不抄常量）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M1·判据 Q-1b】行为·真实现：`routeImMessage` 连收 3 条 ⇒ **3 行都在**、回话恰 1 条（+ 旧次序反证）');
  {
    // ⚠ 用**非文本**消息做标本（`meta.kind` 有值）：它在落库后即止步（不走指令/建任务管道），
    //   故本判据**不需要 LLM、不需要 agent loop**，跑的是**真实现**的这一段而不是它的复刻。
    const mk = () => { const d = new DatabaseSync(':memory:') as unknown as AnyDb; d.exec(CONV_DDL); return d; };
    const rowsOf = (d: AnyDb, ch: string) => (d.prepare("SELECT COUNT(*) AS c FROM wa_im_conversations WHERE channel_id = ? AND direction = 'inbound'").get(ch) as { c: number }).c;

    const db = mk();
    const replies: string[] = [];
    const ctx = { db, channelId: 'ch-storm', channelType: 'wechat-personal', sendReply: async (_to: string, t: string) => { replies.push(t); } };
    for (let i = 0; i < 3; i++) {
      await routeImMessage(ctx as never, 'u-storm', `[图片${i}]`, 'private', '', { kind: 'image' } as never);
    }
    eq(rowsOf(db, 'ch-storm'), 3,
      '★ Q-1b 三条**一条都没丢**：风暴命中不再是"证据消失"，而是"处理降级"（旧次序下这里会是 2 —— 见下面的反证）');
    eq(replies.length, 1,
      `★ Q-1b 回话**恰 1 条**（实测 ${replies.length}）：冷却期内只提示一次，其余静默——但静默的那两条**在库里看得见**`);
    eq(replies[0], STORM_NOTICE, '★ Q-1b 提示文案取载体自身的 `STORM_NOTICE`（不抄字面量）');

    // 反证（判据非空转）：按**旧次序**（判定先于落库）跑同一夹具 —— 第 3 条进不了库
    const dbOld = mk();
    let st: StormState | undefined;
    for (let i = 0; i < 3; i++) {
      const v = stormVerdict(st, Date.now());
      st = v.next;
      if (v.storm) continue;                       // ← 旧行为：判定在落库之前，命中即丢
      dbOld.prepare("INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction) VALUES (?,?,?,?, 'inbound')")
        .run(`old-${i}`, 'ch-storm', 'u-storm', '{}');
    }
    eq(rowsOf(dbOld, 'ch-storm'), 2,
      '★ Q-1b 反证：**旧次序**下同一夹具只留 2 行 —— 故上面的"3"是真修出来的，不是"夹具本来就会给 3"');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M2·判据 Q-2】行为·真实现：机器回话失败 ⇒ **落 1 行 failed + 真因**、**不入 outbox**（D4）');
  {
    // ⚠ 用**真实现** `accountOutboundFailure`（生产函数本体），不复刻它的 SQL。
    const DDL = `${CONV_DDL}
      CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT DEFAULT '', status TEXT DEFAULT 'running');
      CREATE TABLE wa_im_outbox (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, task_id TEXT DEFAULT '', kind TEXT DEFAULT '', message TEXT DEFAULT '', attempts INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', next_retry_at INTEGER);`;
    const mk = () => {
      const d = new DatabaseSync(':memory:') as unknown as AnyDb;
      d.exec(DDL);
      d.prepare("INSERT INTO wa_im_channels (id, channel_type) VALUES ('ch-acc', 'wechat-personal')").run();
      return d;
    };
    const failedOf = (d: AnyDb) => d.prepare("SELECT COUNT(*) AS c FROM wa_im_conversations WHERE status = 'failed' AND direction = 'outbound'").get() as { c: number };
    const outboxOf = (d: AnyDb) => d.prepare('SELECT COUNT(*) AS c FROM wa_im_outbox').get() as { c: number };

    const db = mk();
    const before = failedOf(db).c;
    eq(before, 0, 'Q-2 前置：夹具起点 failed 行为 0（下面"0 → 1"要的是**真增量**，不是碰巧非零）');

    const evts: Array<Record<string, unknown>> = [];
    eventBus.on('im.message_outbound', (e) => evts.push(e as unknown as Record<string, unknown>));

    // ① 一次失败 ⇒ 恰 1 行，且**真因原样落库**
    accountOutboundFailure(db, { channelId: 'ch-acc', externalUserId: 'u1', text: '✅ 已确认，任务「样例」继续执行。', error: '[IM:wechat] 发送回复失败 ret=1001 msg=invalid context_token' });
    const after = failedOf(db).c;
    eq(after, 1, `★ Q-2a 落账"0 → 1"：一条回话没送到 ⇒ **恰 1 行** failed（实测 ${after}）—— 此前这一行**根本不存在**，用户与 GUI 都无从知道`);
    const row = db.prepare("SELECT message_json, last_error, outbox_id, external_user_id, channel_id FROM wa_im_conversations WHERE status = 'failed'").get() as Record<string, unknown>;
    eq(String(row.last_error), '[IM:wechat] 发送回复失败 ret=1001 msg=invalid context_token',
      '★ Q-2a **带真因**：`last_error` 落的是适配器抛上来的那句原话（不是"未送达"三个字）—— 与 zx_20260912 M3「记因」同一把尺');
    ok(String(row.message_json).includes('样例') && String(row.message_json).includes('已确认'),
      '★ Q-2a 正文**原样**落库（不截断成摘要）—— 落库的是证据');
    eq(String(row.outbox_id ?? ''), '', '★ Q-2a **不关联 outbox**（没有补发账）⇒ 界面据 `outbox_id` 为空走 `im:resend` 就地补发口');
    eq(outboxOf(db).c, 0,
      '★ Q-2a **D4：不入 outbox** —— 机器回话是对某句话的应答，迟到的自动重试＝骚扰且烧配额；补发账行数仍为 0');

    // ② 第二次失败 ⇒ 各带各的原因（不会互相覆盖/串味）
    accountOutboundFailure(db, { channelId: 'ch-acc', externalUserId: 'u1', text: '✅ 已启动任务「另一件」', error: '[IM:wechat] 主动推送配额已耗尽 used=5/limit=5' });
    eq(failedOf(db).c, 2, '★ Q-2a 两条失败 ⇒ 2 行（不是把上一条覆盖掉）');
    eq((db.prepare("SELECT COUNT(*) AS c FROM wa_im_conversations WHERE last_error LIKE '%配额已耗尽%'").get() as { c: number }).c, 1,
      '★ Q-2a 第二条带的是**它自己**的原因（按原因查得到 1 行）');

    // ③ 到场：事件名仍是既有的 `im.message_outbound`，且**不置 `pending`**
    eq(evts.length, 2, `★ Q-2a 两次失败 ⇒ 两次出站事件（实测 ${evts.length}）—— 正看着该渠道的 GUI 立即前插这行，不用等刷新`);
    eq(evts.map((e) => e.type), ['im.message_outbound', 'im.message_outbound'],
      '★ Q-2a 复用**既有事件名**（不新增事件名 —— 承 zx_20260911_5「一处通道」）');
    ok(evts.every((e) => (e.data as Record<string, unknown>).pending === undefined),
      '★ Q-2a **不置 `pending`**：该标记的语义是"已入补发账"（见 outbound-event.ts）；本行不入账，置 true 会让横幅口径与账目对不上');

    // ④ 接线：两个 `ImContext.sendReply` 构造**都**落账 —— 且都把真因传进来
    const ipc = strip(path.join(MAIN, 'ipc/im.ipc.ts'));
    const ctors = hitsOf(ipc, /sendReply:\s*async\s*\(toUser,\s*replyText\)\s*=>\s*\{/g);
    eq(ctors.length, 2, `★ Q-2b ` + '`ImContext.sendReply` 构造**恰 2 处**（启动恢复 + im:startChannel，实测 ' + ctors.length + '）—— 多一处即意味着有路径没走这套');
    const wired = ctors.filter((c) => {
      // 按**符号 + 配对花括号**切这一个构造体的原文（不按行号、不按"往后两行"这类会漂的窗口）
      const blk = braceBlock(ipc, c.at);
      return blk.includes('accountOutboundFailure(') && /catch\s*\(err\)/.test(blk) && /error:\s*\(err as Error\)\.message/.test(blk);
    });
    eq(wired.length, 2,
      `★ Q-2b 两处构造**都**含「catch + accountOutboundFailure + 真因 (err as Error).message」（实测 ${wired.length}/2）—— 漏一处则那条路径上"回话没送到"仍无行`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M4·判据 Q-3】行为·真实现：补发成功**一消息一行**（`recordConversation:false` 是承重的，不是装饰）');
  {
    // ⚠ 三跳里**发送那一跳**在 rr 里驱动不了（`im.ipc.ts` 顶层 `import { ipcMain } from 'electron'`），
    //   故拆两段：**行为**跑真补发路径（`enqueueImOutbox` + `retryOutboxEntry` + `flipConversationSent`，
    //   send 用注入的适配器落账动作），**接线**用静态断言钉住 `false` 确实被递到那一跳。两段合起来覆盖整条链。

    // ① 判据本身：**两只标本一起试** —— 只用"该不落行"的标本，任何**过宽**变体都会全票通过
    //    （承 feedback「豁免/门槛类判据须用该命中+该不命中两只标本一起试」）。
    //    这也是把 `opts?.recordConversation !== false` 收成一处真源的**直接好处**：判据此刻可被复跑直调。
    ok(shouldRecordConversation() === true, '★ Q-3 不传 ⇒ **落行**（既有调用方行为逐字不变）');
    ok(shouldRecordConversation({}) === true, '★ Q-3 空对象 ⇒ 落行（「没说」不等于「说了不」）');
    ok(shouldRecordConversation({ recordConversation: true }) === true, '★ Q-3 显式 `true` ⇒ 落行');
    ok(shouldRecordConversation({ recordConversation: false }) === false, '★ Q-3 **显式 `false` ⇒ 不落行**（补发路径全靠这一支）');

    // ② 行为：跑**真**补发路径，看**对话行数**
    const DDL = `${CONV_DDL}
      CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT DEFAULT '', status TEXT DEFAULT 'running');
      CREATE TABLE wa_im_outbox (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, task_id TEXT DEFAULT '', kind TEXT DEFAULT '', message TEXT DEFAULT '', attempts INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', next_retry_at INTEGER, last_error TEXT DEFAULT '', last_attempt_at TEXT);`;
    const mk = () => {
      const d = new DatabaseSync(':memory:') as unknown as AnyDb;
      d.exec(DDL);
      d.prepare("INSERT INTO wa_im_channels (id, channel_type) VALUES ('ch-retry', 'wechat-personal')").run();
      return d;
    };
    const rowsOf = (d: AnyDb) => (d.prepare("SELECT COUNT(*) AS c FROM wa_im_conversations WHERE channel_id = 'ch-retry' AND direction = 'outbound'").get() as { c: number }).c;
    const statusesOf = (d: AnyDb) => (d.prepare("SELECT status FROM wa_im_conversations WHERE channel_id = 'ch-retry' AND direction = 'outbound'").all() as Array<{ status: string }>).map((r) => r.status);

    const TEXT = '周二复盘已生成，详见成果单。';
    /** 适配器**发送成功之后**的落账动作 —— 即五家适配器共用 `shouldRecordConversation` 把关的那一段。 */
    const adapterRecords = (d: AnyDb, opts?: { recordConversation?: boolean }) => {
      if (shouldRecordConversation(opts)) {
        d.prepare("INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, created_at) VALUES (?, ?, ?, ?, 'outbound', datetime('now'))")
          .run(crypto.randomUUID(), 'ch-retry', 'u-retry', JSON.stringify({ text: TEXT }));
      }
    };
    const seed = (d: AnyDb): string => {
      enqueueImOutbox(d as never, { channelId: 'ch-retry', externalUserId: 'u-retry', taskId: '', kind: 'manual_reply', message: TEXT }, '首次发送失败：网络不可达');
      return (d.prepare('SELECT id FROM wa_im_outbox').get() as { id: string }).id;
    };

    // 修后：补发那一跳传 `false` ⇒ 只有原行被翻正，**不新增第二行**
    const dNew = mk();
    const idNew = seed(dNew);
    eq(rowsOf(dNew), 1, '★ Q-3 前置：首次失败已落 **1 行** failed（补发账 ↔ 对话行 1:1，这是一切的前提）');
    const outNew = await retryOutboxEntry(dNew as never, idNew, { send: async () => { adapterRecords(dNew, { recordConversation: false }); return true; } });
    eq(outNew.status, 'sent', '★ Q-3 前置：补发这一步**真的成功了**（状态确为 sent —— 否则下面的行数毫无意义）');
    eq(rowsOf(dNew), 1, `★ Q-3 **一消息一行**：补发成功后仍是 **1 行**（实测 ${rowsOf(dNew)}）—— 这正是 S4 病根，旧行为此处是 2`);
    eq(statusesOf(dNew), ['sent'], '★ Q-3 原行被 `flipConversationSent` 翻回 `sent`（不是"多出一行 sent、旧行仍挂在 failed"）');

    // 反证（判据非空转）：同一夹具、只把那一跳改回**旧行为**（不传 opts）⇒ 多出一行
    const dOld = mk();
    const idOld = seed(dOld);
    await retryOutboxEntry(dOld as never, idOld, { send: async () => { adapterRecords(dOld); return true; } });
    eq(rowsOf(dOld), 2,
      '★ Q-3 反证：那一跳若不传 recordConversation:false，同一夹具留下 **2 行**（实测 ' + rowsOf(dOld) + '）—— 故上面那个「1」是真省下来的，不是夹具本来就给 1');

    // ③ 接线：那个 `false` **从哪来** —— 补发路径确实传了它，且 `sendImMessage` 把它**原样**递到适配器
    const outboxSrc = strip(path.join(MAIN, 'core/im/im-outbox.ts'));
    const dsAt = outboxSrc.indexOf('async function defaultSend');
    const ds = braceBlock(outboxSrc, dsAt);
    ok(dsAt >= 0 && ds.length > 0, 'Q-3 前置：`defaultSend` 函数体切得出（切不出则下面两条是假绿）');
    ok(/recordConversation:\s*false/.test(ds),
      '★ Q-3 `defaultSend` 生产发送那一跳**确实**传 `{ recordConversation: false }` —— 否则行为段的「1 行」只是夹具的巧合');
    ok(/sendReply\(\s*toUser\s*\|\|\s*''\s*,\s*message\s*,\s*undefined\s*,\s*opts\s*\)/.test(ipc),
      '★ Q-3 `sendImMessage` 把第 4 参 `opts` **原样**递给 `adapter.sendReply`（不改写、不丢弃 —— 中间那一跳漏传，两端都白做）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M4·判据 Q-3b】扩围（同一病根的另两处出口）：手发 / 重发也是**一个消息一行**');
  {
    // ⚠ M4 方案原文只点名了补发账那一跳（`defaultSend`）。**核验时又查出两处同形出口**：
    //   `sendManualImMessage`（`im:send` = GUI 手发 → 本函数）与 `im:resend` handler——
    //   二者都是"适配器插一行 + 调用方再插一行"，一次动作在对话里出现**两个气泡**。
    //   只在 `defaultSend` 一处传 `false` 会让"一个消息一行"这条不变量在**三条路里有两条是假的**。
    //   故就地扩围（与 M2 的 P-4 "2 处→3 处"同性质：**有意扩围**，非放宽），并各自钉住。

    // ① 手发路径 **行为**：`sendManualImMessage` 依赖全可注入（db / adapters / emit），可跑真实现
    const DDL = `${CONV_DDL}
      CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT DEFAULT '', status TEXT DEFAULT 'running');
      CREATE TABLE wa_im_outbox (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, task_id TEXT DEFAULT '', kind TEXT DEFAULT '', message TEXT DEFAULT '', attempts INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', next_retry_at INTEGER, last_error TEXT DEFAULT '', last_attempt_at TEXT);`;
    const mk = () => {
      const d = new DatabaseSync(':memory:') as unknown as AnyDb;
      d.exec(DDL);
      d.prepare("INSERT INTO wa_im_channels (id, channel_type) VALUES ('ch-manual', 'feishu')").run();
      return d;
    };
    const rowsOf = (d: AnyDb) => (d.prepare("SELECT COUNT(*) AS c FROM wa_im_conversations WHERE channel_id = 'ch-manual' AND direction = 'outbound'").get() as { c: number }).c;

    const TEXT = '帮我看看这周的成果单。';
    const mkAdapter = (d: AnyDb, seen: Array<ImSendOpts | undefined>, obeyFlag: boolean) => ({
      sendReply: async (_to: string, _t: string, _ctx?: string, opts?: ImSendOpts) => {
        seen.push(opts);
        // 适配器"发送成功后自记一行"的动作：生产的五家由 `shouldRecordConversation` 把关；
        // `obeyFlag:false` 即模拟**旧行为**（无视该开关、照记不误）。
        if (!obeyFlag || shouldRecordConversation(opts)) {
          d.prepare("INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, created_at) VALUES (?, ?, ?, ?, 'outbound', datetime('now'))")
            .run(crypto.randomUUID(), 'ch-manual', 'u-m', JSON.stringify({ text: TEXT }));
        }
      },
    });

    const seen: Array<ImSendOpts | undefined> = [];
    const d1 = mk();
    const r1 = await sendManualImMessage(
      { db: d1 as never, adapters: new Map([['ch-manual', mkAdapter(d1, seen, true)]]), emit: () => {} },
      { channelId: 'ch-manual', externalUserId: 'u-m', text: TEXT },
    );
    ok('data' in r1 && r1.data.sent === true, 'Q-3b 前置：这次手发**真的成功了**（否则下面的行数毫无意义）');
    eq(rowsOf(d1), 1, `★ Q-3b **一个手发消息恰 1 行**（实测 ${rowsOf(d1)}）—— 旧行为此处是 2（适配器一行 + 本函数一行）`);
    eq(seen, [{ recordConversation: false }],
      '★ Q-3b 手发那一跳**确实把 `false` 递给了适配器**（这是"1 行"的**因**，不是巧合；只数行数会被"适配器恰好没记"蒙混过去）');

    // 反证：同一夹具、适配器**无视**该开关（= 旧行为）⇒ 两个气泡
    const d2 = mk();
    const r2 = await sendManualImMessage(
      { db: d2 as never, adapters: new Map([['ch-manual', mkAdapter(d2, [], false)]]), emit: () => {} },
      { channelId: 'ch-manual', externalUserId: 'u-m', text: TEXT },
    );
    ok('data' in r2, 'Q-3b 反证前置：该次也成功');
    eq(rowsOf(d2), 2, `★ Q-3b 反证：适配器若照旧自记一行，同一夹具留下 **2 行**（实测 ${rowsOf(d2)}）—— 故"1"是真修出来的`);

    // ② 重发路径（`im:resend` handler 在 `ipcMain.handle` 内，rr 驱动不了 ⇒ 只能静态钉**那一跳**）
    const manualSrc = strip(path.join(MAIN, 'core/im/manual-send.ts'));
    // 第 2 参不钉具体表达式（M2-d 起是 `fitted.text`：长回复按上限截、无上限只提示），
    //   只钉**这一跳**的第 4 参——`false` 才是本判据的标的；把第 2 参也钉死会与 M2 的截断真源互相绑架。
    const mManualGate = /await adapter\.sendReply\(\s*externalUserId\s*,\s*([\w.$]+)\s*,\s*undefined\s*,\s*\{\s*recordConversation:\s*false\s*\}\s*\)/.exec(manualSrc);
    ok(!!mManualGate,
      `★ Q-3b \`sendManualImMessage\` 的发送那一跳**确实**传 \`{ recordConversation: false }\`（上段行为测试的另一半：真源那行${mManualGate ? `；第2参 ${mManualGate[1]}` : ''}）`);
    ok(/await adapter\.sendReply\(externalUserId, text, undefined, \{ recordConversation: false \}\)/.test(ipc),
      '★ Q-3b `im:resend` handler 的发送那一跳**同样**传 `false`（否则一次重发两个气泡；此路在 electron 内，只能静态钉）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M5·判据 Q-4】记忆零产量坐实：摘掉「同 type 逐轮 ×0.5」后，全景门槛由**恒不可满足**变为**可达**');
  {
    // 坐实（真库只读：`data/baseline_zx_20260920.json`）：`wa_memories` 774 行里 `panorama` **0**、`prospective` **0**，
    //   而 `importance` 的最大值是 semantic 的 0.5，其余成堆 2.5e-29 / 7.2e-43 ——
    //   这两个数**恰是 2 的整数次幂**（0.5^95、0.5^140），只有"反复乘 0.5"造得出来。
    //   出处是 `runConsolidationPipeline` 里那段自称「冲突解决」的块：判据只是 `GROUP BY memory_type HAVING cnt > 1`,
    //   而**同类型不止一条 ≠ 冲突**（真库 semantic 77 条是 77 条独立知识）；它无下界、每轮管线各打一次。
    //   后果不止"降权"：`retrieveByType` 对 semantic 要求 `importance >= 0.3`（两轮即检索不到）；
    //   而 `synthesizeProjectKnowledge` 的门槛「≥3 条 importance ≥0.6」被它压成**恒不可满足**。
    //   ⇒ 判定为**路径断**（非"数据还没来"），故就地摘除该块；冲突交给同一管道下方的 `detectAndResolveConflicts`
    //     （它有真的重叠率/效价判据，只打 `superseded` 标、**不动 importance**）。
    const memSrc = strip(path.join(MAIN, 'core/memory-manager.ts'));

    // ① 全景门槛的**生产 SQL 就地取出**（不另写等价 SQL；改实现即改此处判据的输入）
    // ⚠ zx_20260920_1 M7 **就地订正**（本判据先如实变红，才改的——不是事后放宽）：
    //   生产那条 SQL 由**双引号串**改成了**模板字面量**：M7 把门槛 `importance >= 0.6` 改为读
    //   `PANORAMA_MIN_IMPORTANCE`，以兑现"**写刻度 / 读门槛同源**"（这正是 §1.6 死锁的解）。
    //   原正则只认 `"…"` ⇒ 取不出 ⇒ 下面 `prepare('')` 抛 `statement has been finalized`（复跑中断）。
    //   订正**不削弱本判据**：仍然"就地取生产那条 SQL、不另写等价 SQL"，只是
    //   ① 不再假设引号形状（双引号串/模板字面量皆认）；
    //   ② 把源码里的 `${TOKEN}` 用**常量真值**代回 —— 值由 `core/memory-constants.ts` **派生**，不手抄 0.6。
    //   取不出 / 代不回 ⇒ 紧随其后的自证 `ok()` 红，**不会**静默退化成空 SQL 去比大小。
    const gateM = /["`](SELECT content, memory_type FROM wa_memories[^"`]+)["`]/.exec(memSrc);
    const GATE_SQL = (gateM?.[1] ?? '').replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (tok, name: string) => {
      const v = (memConsts as unknown as Record<string, unknown>)[name];
      return typeof v === 'number' ? String(v) : tok;
    });
    ok(!!gateM, 'Q-4 前置：`synthesizeProjectKnowledge` 的门槛 SQL 从源码**就地取得出**（双引号串 / 模板字面量皆认）');
    ok(GATE_SQL.length > 0 && !/\$\{/.test(GATE_SQL),
      'Q-4 前置·自证：SQL 里的 `${…}` 令牌已**全部代回常量真值**（代不回即红，不静默变空串）',
      GATE_SQL.slice(0, 64));

    const MEM_DDL = `CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
      CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
        status TEXT DEFAULT 'active', context_json TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL,
        embedding TEXT, memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5,
        reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '',
        valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0,
        exemplar_type TEXT, exemplar_context TEXT, use_count INTEGER DEFAULT 0, last_used_at TEXT,
        similar_to TEXT DEFAULT '', last_reinforced_at TEXT, success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));`;
    const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString().replace('T', ' ').slice(0, 19);
    const gateRows = (d: AnyDb) => (d.prepare(GATE_SQL).all('p1') as unknown[]).length;
    const impOf = (d: AnyDb, id: string) => (d.prepare('SELECT importance FROM wa_memories WHERE id = ?').get(id) as { importance: number }).importance;
    /** 夹具时间一律用 **SQLite 自己的 `datetime('now', …)`**（= 生产写入格式：UTC、无时区）。
     *  ⚠ 不可用 `toISOString()` 造——那自带 `Z`，会绕过"无时区串该按谁解析"这个被测点。 */
    const insert = (d: AnyDb, id: string, content: string, type: string, imp: number, source: string, createdMod: string, updatedMod = '+0 minutes') =>
      d.prepare(`INSERT INTO wa_memories (id, project_id, content, memory_type, importance, source, use_count, valence, context_json, created_at, updated_at)
                 VALUES (?, 'p1', ?, ?, ?, ?, 0, 'neutral', '{}', datetime('now', ?), datetime('now', ?))`)
        .run(id, content, type, imp, source, createdMod, updatedMod);
    /** zx_20260930 M6: 补一列 `last_used_at`（语义时间戳）——`insert` 默认不写它（⇒ 年龄落回 `created_at`）。 */
    const markUsed = (d: AnyDb, id: string, mod: string) =>
      d.prepare("UPDATE wa_memories SET last_used_at = datetime('now', ?) WHERE id = ?").run(mod, id);

    /** 夹具：★ 先 `new MemoryManager` **再**插行（生产顺序：引擎启动即 new，行是其后经应用写入的）。 */
    const mkMem = (): { d: AnyDb; mm: MemoryManager; reached: () => boolean } => {
      const d = new DatabaseSync(':memory:') as unknown as AnyDb;
      d.exec(MEM_DDL);
      let reached = false;
      // ansClient 桩：门槛没通过时函数在**调它之前**就 `return null` ⇒ "是否被调用"即"门槛是否被跨过"。
      const mm = new MemoryManager(d as never, { getOptimalModel: async () => { reached = true; return null; } } as never);
      d.prepare("INSERT INTO wa_projects (id, name) VALUES ('p1','本项目')").run();
      return { d, mm, reached: () => reached };
    };
    /** 五条内容两两**无重叠 token**（冲突判据是**重叠率**、非语义）⇒ 真冲突检测器不会打标，本段只问"打折器在不在"。
     *  `created_at` 各不同（`ORDER BY created_at DESC` 才有确定的最"新"）。
     *  ⚠ M6 起衰减的**年龄不读 `updated_at`**，而读 `last_used_at`/`last_reinforced_at`/`created_at` 三者取最大；
     *    本夹具不写前两者 ⇒ 年龄 = `created_at` 龄（最老一条仅 4 小时）⇒ semantic 衰减因子 0.5^(4/24/30)≈0.996
     *    ⇒ 取整后 importance 一分不减，仍能隔离出"打折器"这一个变量。 */
    const seedFive = (d: AnyDb) => {
      insert(d, 's1', '语义一 构建前先跑 tsup', 'semantic', 0.7, 'agent_execution', '-240 minutes');
      insert(d, 's2', '语义二 ANS 是唯一前置服务', 'semantic', 0.7, 'agent_execution', '-180 minutes');
      insert(d, 's3', '语义三 数据目录在仓库根', 'semantic', 0.7, 'agent_execution', '-120 minutes');
      insert(d, 'p1i', '程序一 改引擎后跑 rr 全量', 'procedural', 0.7, 'agent_execution', '-60 minutes');
      insert(d, 'p2i', '程序二 改界面后跑 vite build', 'procedural', 0.7, 'agent_execution', '-30 minutes');
    };

    // ② 正面（"值从 0 变 1"）：跑**真管线** 7 轮 —— importance 一分不减、门槛**真被跨过**
    const A1 = mkMem();
    seedFive(A1.d);
    eq(gateRows(A1.d), 5, `Q-4 前提：夹具里够门槛的记忆 5 条（≥3 才谈得上后面的"跨过"）`);
    const r1 = A1.mm.runConsolidationPipeline('p1');
    ok(r1.pruned === 0 && r1.forgotten === 0, 'Q-4 前提：本轮管线**没归档也没精简**（否则"还在"可能只是管线没干活）', JSON.stringify(r1));
    for (let k = 0; k < 6; k++) A1.mm.runConsolidationPipeline('p1');
    eq([impOf(A1.d, 's2'), impOf(A1.d, 's3')], [0.7, 0.7],
      '★ Q-4 正面：**非最新**的同类型记忆跑 7 轮真管线后 importance **一分不减**（0.7；旧写法此处是 0.7×0.5⁷≈0.0055）');
    eq(gateRows(A1.d), 5, `★ Q-4 正面：7 轮之后够门槛的记忆**仍是 5 条**（旧写法此处缩到 2 条 ⇒ 门槛恒不可满足）`);
    await A1.mm.synthesizeProjectKnowledge('p1');
    ok(A1.reached(), '★ Q-4 **值从 0 变 1**：`synthesizeProjectKnowledge` 真**跨过了门槛**去要模型（旧写法此处置 0——它在门槛处就 return null，从不调模型）');

    // ③ 反证：同一夹具 + **旧写法**（那段被摘掉的 ×0.5）⇒ 门槛塌到 2 条、模型**从不被调用**
    //    ⚠ 这段 SQL 是**已删代码的标本**，刻意写死：它必须**不随生产源码改动而变**，否则反证失效。
    const applyOldDemotion = (d: AnyDb) => {
      const types = d.prepare("SELECT memory_type, COUNT(*) as cnt FROM wa_memories WHERE project_id = ? AND memory_type != 'episodic' GROUP BY memory_type HAVING cnt > 1").all('p1') as Array<{ memory_type: string }>;
      for (const { memory_type } of types) {
        const rows = d.prepare("SELECT id, importance FROM wa_memories WHERE project_id = ? AND memory_type = ? ORDER BY created_at DESC").all('p1', memory_type) as Array<{ id: string; importance: number }>;
        for (let i = 1; i < rows.length; i++) d.prepare('UPDATE wa_memories SET importance = ? WHERE id = ?').run(rows[i]!.importance * 0.5, rows[i]!.id);
      }
    };
    const A2 = mkMem();
    seedFive(A2.d);
    applyOldDemotion(A2.d);
    eq([impOf(A2.d, 's1'), impOf(A2.d, 's2')], [0.35, 0.35], '★ Q-4 反证：旧写法一轮就把非最新行砍半（0.7→0.35）—— 摘掉的那个打折器确实是承重的');
    for (let k = 0; k < 6; k++) applyOldDemotion(A2.d);
    eq(gateRows(A2.d), 2, `★ Q-4 反证：旧写法 7 轮后够门槛的只剩 **2 条**（每类只保住各自的"最新"一条）⇒ **绝对门槛**不可满足`);
    await A2.mm.synthesizeProjectKnowledge('p1');
    // ★ zx_20261002 M9-② **就地改判**（本判据如实变红，才改的——不是事后放宽）：
    //   本夹具正是 M9-② 要救的那一类真相——同项目候选 5 条、低于绝对门槛的 3 条**并非不存在**，
    //   只是被 Ebbinghaus 衰减到 0.35。旧口径下这类项目永远综合不出全景（真库 panorama 恒 0）。
    //   M9-② 补了**相对名次支**（项目内候选齐 `PANORAMA_TOP_K` 条即够）⇒ 本夹具（5 条候选）被救活，
    //   `reached()` 由"必为 false"转为"应为 true"。
    //   ⚠ 本判据改写**不削弱**承重结论：旧写法的**价值毁伤**仍在上一行（`gateRows(A2.d)===2`）与更上一行
    //   （0.7→0.35）钉着——"摘掉的那个打折器确实是承重的"这一条**一字未动**，改的只是"跨门槛与否"的**结论**，
    //   因为门槛本身在 M9-② 里**宽了**（绝对 ∪ 相对），旧结论已不是本轮的真事实。
    ok(A2.reached(), '★ Q-4（M9-② 改判）：相对名次支救活——候选 5 条 ≥ TOP_K ⇒ 模型**真被调用**（绝对支仍只够 2 条，见上一行）');

    // ④ 衰减**没有**被一并废掉，且它的**年龄基准**已换成语义时间戳（M6）：`updated_at` 永不参与。
    const A4 = mkMem();
    // `old`：`created_at`/`updated_at` 都在 **60 天前**（模拟"被系统反复改写"），而 **`last_used_at` 是 20 天前**——
    //   年龄须按 20 天算。沿用 `updated_at`（60 天）会得另一个数，故"基准换对了"这条反证是承重的。
    //   （夹具只给 `updated_at`/`created_at` 老化、**不给任何系统写**，即"系统改写不得刷新年份"的最小形状。）
    insert(A4.d, 'fresh', '语义 刚被用过', 'semantic', 0.7, 'agent_execution', '-60 minutes', '-60 minutes');
    markUsed(A4.d, 'fresh', '+0 minutes');
    insert(A4.d, 'old', '语义 二十天未触', 'semantic', 0.7, 'agent_execution', '-60 days', '-60 days');
    markUsed(A4.d, 'old', '-20 days');
    A4.mm.runConsolidationPipeline('p1');
    /** 期望值取自**生产的同一个函数**（`decayFactor` 内部用 `memoryAgeDays` + 类型分档半衰期），不另写一份算式。 */
    const expected = (imp: number, subj: DecaySubject) => Math.max(0, Math.round(imp * decayFactor(subj) * 100) / 100);
    const rowOf = (id: string) => A4.d.prepare(
      'SELECT memory_type, valence, source, use_count, is_exemplar, last_used_at, last_reinforced_at, created_at, updated_at FROM wa_memories WHERE id = ?',
    ).get(id) as DecaySubject & { updated_at: string | null };
    const oldRow = rowOf('old');
    const asIfUpdatedAt = { ...oldRow, last_used_at: null, last_reinforced_at: null, created_at: oldRow.updated_at };
    const ageIfUpdated = memoryAgeDays(asIfUpdatedAt);
    eq(MEM_HALF_LIFE_DAYS.semantic, 30, 'Q-4 前提：semantic 的半衰期真源 = 30 天（类型分档，非旧写法"所有类型一律 ≈7 天"）');
    ok(ageIfUpdated > 59 && expected(0.7, oldRow) !== expected(0.7, asIfUpdatedAt),
      `Q-4 前提：年龄若沿用 \`updated_at\`（${ageIfUpdated.toFixed(1)} 天）会得 ${expected(0.7, asIfUpdatedAt)}，与按 \`last_used_at\` 算的 ${expected(0.7, oldRow)} **可分辨** —— 反证才成立`);
    eq(impOf(A4.d, 'old'), expected(0.7, oldRow),
      `★ Q-4 正面：年龄取 **last_used_at（20 天）** ⇒ ${expected(0.7, oldRow)}（\`created_at\`/\`updated_at\` 都在 60 天前，沿用它们会得 ${expected(0.7, asIfUpdatedAt)}）`);
    eq(impOf(A4.d, 'fresh'), 0.7, '★ Q-4 正面：刚被使用（age≈0）的记忆**不衰减**（0.7 原样）—— 衰减仍在，只是基准换成了语义时间戳');
    eq(gateRows(A4.d), 1, '★ Q-4：衰减仍然承重（20 天那条退出门槛，刚用过那条留在门槛内）');

    // ⑤ 冲突**没有**被一并删掉：真冲突检测器仍在本管道里干活（同重叠率判据、只打标不动 importance）
    const A3 = mkMem();
    insert(A3.d, 'ui1', '关键约束 alpha beta gamma', 'semantic', 0.9, 'user_instruction', '-300 minutes');
    insert(A3.d, 's4', '关键约束 alpha beta gamma 的补充说明', 'semantic', 0.9, 'agent_execution', '-10 minutes');
    const r3 = A3.mm.runConsolidationPipeline('p1');
    eq(r3.conflicts, 1, '★ Q-4 正面：摘掉打折器后，真冲突仍被 `detectAndResolveConflicts` 检出恰 1 处（不是"把冲突处理一起删了"）', JSON.stringify(r3));
    eq(JSON.parse((A3.d.prepare("SELECT context_json FROM wa_memories WHERE id = 's4'").get() as { context_json: string }).context_json).conflict_flag, true,
      '★ Q-4：冲突**真打上了标**（`conflict_flag` 落在较新那条上——判据是 token 重叠率，与价值无关）');
    eq(impOf(A3.d, 'ui1'), 0.9, '★ Q-4：用户指令的 importance **未被冲突处理改动**（冲突只打标 + 降检索权 ×0.6，不是砍价值）');


    // ⑤ 静态：摘掉的那句**不在**源码里（去注释后取，防被本段说明注释喂饱），且冲突归属明确
    ok(!memSrc.includes('importance * 0.5, rows[i]'), '★ Q-4 静态：`importance * 0.5` 的逐轮打折**已不在** `memory-manager.ts`（去注释后取；注释里"已删"的话骗不过本条）');
    ok(/detectAndResolveConflicts\(projectId\)/.test(memSrc), '★ Q-4 静态：冲突仍由 `detectAndResolveConflicts` 在同一管道内处理（摘掉的是重复实现，不是能力）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【R】不许顺手放宽：风暴阈值 / 复起集 / 成功 INSERT 的 status 真源');
  {
    // R-1 风暴阈值：仍「2 秒内第 3 条」+ 冷却 15 秒。
    // 取数须**从载体自身**读（常量定义处），不写字面量——否则改的是判据、不是阈值。
    // zx_20261003 M9 就地改钉：风暴判定（阈值常量 + `stormVerdict`）搬入 `core/im-storm-guard.ts`
    //   （im-router 仅再导出，故文件顶部的 import 不动）。扫描面指向代码**现居**的文件。
    const stormSrc = strip(path.join(MAIN, 'core/im-storm-guard.ts'));
    const num = (name: string): number | null => {
      const m = new RegExp(`${name}\\s*=\\s*([0-9_]+)`).exec(stormSrc);
      return m ? Number(m[1]!.replace(/_/g, '')) : null;
    };
    const i = stormSrc.search(/(?:function\s+(?:isStorm|stormVerdict)\s*\(|const\s+stormVerdict\s*=)/);
    const blk = fnBodyOf(stormSrc, i);
    ok(blk.length > 0, 'R-1 前置：风暴判定函数体**非空**（切得出）——扫描面 `core/im-storm-guard.ts`（**M9 就地改钉**）');
    // 双侧前置：切到的必须**是函数体**。判据：体内有 return 语句；类型字面量里没有。
    // 没有这条，"切错了块 ⇒ 搜不到常量名" 会伪装成"实现没用常量"的**假红**（M1 首版即如此）。
    ok(/return\s*\{/.test(blk), 'R-1 前置：切到的是**函数体**（内含 return）而非返回类型字面量 —— 防切错块后的假红');
    eq(num('STORM_WINDOW_MS'), 2_000, '★ R-1 风暴窗仍是 **2 秒**（不得借本轮把窗放宽来"消掉"风暴）——扫描面 `core/im-storm-guard.ts`（**M9 就地改钉**）');
    eq(num('STORM_COOLDOWN_MS'), 15_000, '★ R-1 冷却仍是 **15 秒**（提示本身也不许变成刷屏）');
    eq(num('STORM_THRESHOLD'), 2, '★ R-1 判暴阈值仍是 **2**（⇒「第 3 条」起判暴，一字未动）');
    const used = ['STORM_WINDOW_MS', 'STORM_COOLDOWN_MS', 'STORM_THRESHOLD'].filter((n) => blk.includes(n));
    eq(used.length, 3, `★ R-1 判定函数**确实在用**这三个阈值（实测引用 ${used.join('、') || '无'}）—— 防"常量改了但函数没用它"的假绿`);

    // R-2 复起集与成果面（zx_20260918 R-1/R-2 已钉，本轮不碰）
    //   ⚠ `autoStartDaemons` 在 **core/daemon-supervisor.ts**（zx_20261004 M15 纯搬移至此），
    //     不在 im.ipc.ts —— 找错文件会得到空块，而空块上断言 `.includes(...)` 是**假红**、
    //     断言 `.includes('draft')` 是**假绿**。判据语句一字未改，只换扫描面。
    const projectIpc = strip(path.join(MAIN, 'core/daemon-supervisor.ts'));
    const j = projectIpc.indexOf('function autoStartDaemons');
    const daemonBlk = braceBlock(projectIpc, j);
    ok(j >= 0 && daemonBlk.includes("status IN ('running', 'stale', 'completed')"),
      "★ R-2 `autoStartDaemons` 的挑选集**仍是** ('running','stale','completed')（本轮治的是「看不见」，不是「多拉起」）");
    ok(!daemonBlk.includes('draft'), '★ R-2 反证：该函数体内**不含 `draft`**');
    const k = exe.indexOf('function isRealDeliverableRow');
    const realBlk = exe.slice(k, exe.indexOf('\n}\n', k));
    ok(realBlk.includes("['running', 'registered', 'stopped', 'completed']"),
      '★ R-2 `isRealDeliverableRow` 的 daemon 白名单**一字未改**');

    // R-3 成功 INSERT **不写 status**（列 DEFAULT 一处真源）；写失败/条件缺失的那三类**必须**写 status。
    //   zx_20260929 M8-c 订正（**改钉更强的真源，非放宽**）：失败行的状态值已移入**绑定参数**
    //   （failed / blocked_quota 同表），"是不是失败行"不能再靠 `'failed'` 字面量识别 ——
    //   旧写法会把 IM手发、机器回话两处**误判成"成功 INSERT 手写了 status"**。
    //   改锚不变量：**没有任何 INSERT 手写 `'sent'`**（成功行一律走列 DEFAULT）。
    const INSERTS = walkTs(MAIN).flatMap((p) => {
      const src = strip(p);
      return hitsOf(src, /INSERT\s+INTO\s+wa_im_conversations/).map((h) => {
        const stmt = src.slice(h.at, h.at + 320);
        const cols = stmt.split(')')[0]!;
        return { rel: relOf(p), line: h.line, writesStatus: /\bstatus\b/.test(cols), manualSent: /'sent'/.test(stmt) };
      });
    });
    ok(INSERTS.length >= 8, `R-3 前置：对话表 INSERT 点非退化（实测 ${INSERTS.length} 处）`);
    const manualSent = INSERTS.filter((x) => x.manualSent);
    eq(manualSent.length, 0,
      `★ R-3 无**任何** INSERT 手写 status='sent'（实测越界 ${manualSent.length} 处）—— 列 DEFAULT 'sent' 是唯一真源${manualSent.length ? `\n     越界：${manualSent.map((s) => `${s.rel}:${s.line}`).join('、')}` : ''}`);
    const statusInserts = INSERTS.filter((x) => x.writesStatus);
    eq(statusInserts.length, 3,
      `★ R-3 另一半：显式写 status 列的 INSERT **恰 3 处**（= 失败/条件缺失行写者）—— 实测 ${statusInserts.length} 处\n     逐处：${statusInserts.map((s) => `${s.rel}:${s.line}`).join('、')}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S】build 钉（派生核对，不写轮次字面量）');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告
//   unhandled rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().catch((e: unknown) => {
  console.error('\n💥 rr_zx_20260920 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260920: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
});
