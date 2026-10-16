/**
 * zx_20261012 受控复跑 —— 「自知者明」：**「已注册」判据须认得本机此刻的凭据**。
 *
 * 本轮口径一句话（道德经·自知者明 / 维特根斯坦·意义即使用 / 毛选·实事求是）：
 *   「已注册」的含义就是它放行的**行为**（起心跳 / 收派活）；一个**永不失效**的判据等于没有判据。
 *   本机须**正确认知自己**是不是网络一员——判据增②③即"明"（照见凭据**此刻**的样子），
 *   而非拿一次性旧印记（`node.resource_group`，全仓无清写口）当"明"。
 *
 * 病根（本轮方案 §Context）：`isNodeEnrolled` 旧判据只看 `node.resource_group === 'node:'+id`——
 *   key 被退回内置占位（如 `dev-key`）时判据仍真 ⇒ `ensureNodeEnrolled` 走 `already-enrolled`
 *   **短路** ⇒ 永久不自愈，且为一个自己并未真正加入的网络持续起心跳/中转（ANS 侧每拍回 403
 *   `Key is not bound to node`）。治法：判据补为**三条件**（旧条件 ∧ 非占位凭据 ∧ [记了前缀则须相符]）。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：判据一律静态导入生产导出（被删/改名即编译期失败）。
 *   G-2 **两侧标本**：凡判"命中/放行/收窄"的判据，反面标本（不命中）一并喂。
 *   G-4 **不碰真实网络/墙钟**：到 ANS 的请求一概不触发（标本均在校验前短路返回）。
 *   G-5 判"用户可见文案还在不在"读 `stripKeepingLines` 后的代码（注释里提到旧文案不构成本文之病）。
 *   G-6 **无轮次字面量**：本轮方案路径/脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 *   ⚠ 计数器类断言一律**正面**（"值从 0 变 1"），不只断言"不抛"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：判据引用的生产符号**全部静态导入** ⇒ 被删/改名即编译期失败（而非"扫了个空、静默假绿"）。
import {
  isNodeEnrolled,
  nodeEnrollmentReason,
  ensureNodeEnrolled,
} from '../apps/worker-ant-desktop/src/main/core/node-heartbeat.js';
import { NODE_SETTING_KEYS } from '../apps/worker-ant-desktop/src/main/core/node-identity.js';
import { isPlaceholderApiKey, ANS_DEFAULTS } from '../apps/worker-ant-desktop/src/main/core/ans-signed-request.js';

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
/** 静态判据读**原文**；判"用户可见文案还在不在"用 `CODE()`（G-5）。 */
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''); // zx_20261012

/* ── 夹具 ────────────────────────────────────────────────────────────────── */

/** 最小 `wa_settings` 库（节点身份/凭据只此一表）——按 `main/database.ts` DDL 摘相关列。 */
function settingDb(entries: Record<string, string>): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec("CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))");
  for (const [k, v] of Object.entries(entries)) d.prepare('INSERT INTO wa_settings (key,value) VALUES (?,?)').run(k, v);
  return d;
}
/** 一个**真已注册**的本机（新真形状：`id` ∧ `resource_group=node:<id>` ∧ 非占位 `ans_api_key`）。 */
const enrolledSettings = (id = 'n-rr'): Record<string, string> => ({
  [NODE_SETTING_KEYS.id]: id,
  [NODE_SETTING_KEYS.resourceGroup]: `node:${id}`,
  [NODE_SETTING_KEYS.ansApiKey]: 'wa_rr_enrolled_key',
});

async function main(): Promise<void> {
  // ═══ A｜「已注册」判据两侧标本（G-2：该命中 ∧ 不该命中，逐条喂）═══════════════
  console.log('\n【A】「已注册」判据三条件两侧标本（毛选·实事求是：依据须是本机此刻的真凭据）');
  {
    // —— 不该命中（逐条件各造一反面标本）——
    eq(nodeEnrollmentReason(settingDb({})), 'no-identity',
      'A-1 无 `node.id`（本机连"自称是谁"都不曾写下）⇒ `no-identity`');
    eq(nodeEnrollmentReason(settingDb({ [NODE_SETTING_KEYS.id]: 'n1' })), 'no-resource-group',
      'A-2 仅 `node.id`、`resource_group` 缺 ⇒ `no-resource-group`（旧实现把这一步当成"可参与"）');
    eq(nodeEnrollmentReason(settingDb({ [NODE_SETTING_KEYS.id]: 'n1', [NODE_SETTING_KEYS.resourceGroup]: 'node:other', [NODE_SETTING_KEYS.ansApiKey]: 'wa_rr_enrolled_key' })), 'no-resource-group',
      'A-3 `resource_group` 指向**别机** ⇒ `no-resource-group`（若判据写成"有值即已注册"则此红）');

    // ★★ 本轮病标本：旧印记（resource_group 绑本机）在场 ∧ key 退回内置占位 ⇒ **判未注册**
    //    （判据若写成旧式"只看 resource_group"则此红——**这就是本轮的存在意义**）
    const bugDb = settingDb({ [NODE_SETTING_KEYS.id]: 'n-bug', [NODE_SETTING_KEYS.resourceGroup]: 'node:n-bug', [NODE_SETTING_KEYS.ansApiKey]: ANS_DEFAULTS.apiKey });
    eq(nodeEnrollmentReason(bugDb), 'placeholder-credential',
      'A-4 ★★本轮病标本：`resource_group` 绑本机 ∧ key=`dev-key`（内置占位）⇒ `placeholder-credential`（旧式判据在此为 `enrolled`）');
    eq(isNodeEnrolled(bugDb), false,
      'A-5 ★★薄壳随动：病标本 `isNodeEnrolled` = **false**（占位 key 的机器认清自己"并未真入网"）');
    eq(nodeEnrollmentReason(settingDb({ [NODE_SETTING_KEYS.id]: 'n-e', [NODE_SETTING_KEYS.resourceGroup]: 'node:n-e', [NODE_SETTING_KEYS.ansApiKey]: '' })), 'placeholder-credential',
      'A-6 空 key ⇒ 同判 `placeholder-credential`（`!key` 与占位同因）');
    eq(nodeEnrollmentReason(settingDb({ ...enrolledSettings('n-m'), [NODE_SETTING_KEYS.enrolledKeyPrefix]: 'OTHERKEY' })), 'key-mismatch',
      'A-7 曾记前缀（`enrolled_key_prefix`）而当前 key 不符 ⇒ `key-mismatch`（手里这把不是注册发的那把）');

    // —— 该命中（两条正例：旧装无前缀放行 ∧ 新装前缀相符）——
    eq(nodeEnrollmentReason(settingDb(enrolledSettings('n-legacy'))), 'enrolled',
      'A-8 **旧装放行**：绑定本机 ∧ 非占位 key ∧ **无前缀** ⇒ `enrolled`（免迁移期误伤：老装一旦重注册即记前缀、转强判据）');
    const key = 'wa_rr_enrolled_key';
    eq(nodeEnrollmentReason(settingDb({ ...enrolledSettings('n-new'), [NODE_SETTING_KEYS.enrolledKeyPrefix]: key.slice(0, 8) })), 'enrolled',
      'A-9 **新装前缀相符**：绑定本机 ∧ 非占位 key ∧ 前缀 = `key.slice(0,8)` ⇒ `enrolled`');
    eq(isNodeEnrolled(settingDb(enrolledSettings('n-ok'))), true,
      'A-10 该命中侧：`isNodeEnrolled` = true（过窄变体"恒 false"在此红）');
    // 占位判据**一处真源**（与 `ANS_DEFAULTS` 同处，`'dev-key'` 不散落）。
    eq([isPlaceholderApiKey(undefined), isPlaceholderApiKey(''), isPlaceholderApiKey(ANS_DEFAULTS.apiKey), isPlaceholderApiKey('wa_rr_enrolled_key')],
      [true, true, true, false],
      'A-11 `isPlaceholderApiKey` 四态：undefined / 空串 / 内置占位 ⇒ true；真 key ⇒ false');
  }

  // ═══ B｜`ensureNodeEnrolled` 在病标本上**不再短路**（锁已解）+ 该短路侧仍短路 ═══════
  console.log('\n【B】自助注册闸：病标本不再 `already-enrolled`（锁已解），真已注册仍短路（不误伤）');
  {
    const bugDb = settingDb({ [NODE_SETTING_KEYS.id]: 'n-bug', [NODE_SETTING_KEYS.resourceGroup]: 'node:n-bug', [NODE_SETTING_KEYS.ansApiKey]: ANS_DEFAULTS.apiKey });
    // 病标本无令牌 ⇒ 判据放开后**落到**"无令牌"这一如实原因（未触网：无令牌在校验前即返）。
    const bugRes = await ensureNodeEnrolled(bugDb as unknown as Parameters<typeof ensureNodeEnrolled>[0], { serverUrl: 'http://127.0.0.1:1' });
    ok(bugRes.reason !== 'already-enrolled',
      'B-1 ★★锁已解：病标本 `ensureNodeEnrolled` **不再**短路为 `already-enrolled`（旧式判据在此恒短路 ⇒ 永久不自愈）', bugRes.reason);
    eq(bugRes.reason, 'no-enrollment-token',
      'B-1\' 病标本落到**如实首因** `no-enrollment-token`（无令牌可换，属"这次没成"，不是"已注册"）');

    // 该短路侧：真已注册（新真形状）⇒ 仍 `already-enrolled`（不因本轮加固而误伤真成员）。
    const goodDb = settingDb(enrolledSettings('n-good'));
    const goodRes = await ensureNodeEnrolled(goodDb as unknown as Parameters<typeof ensureNodeEnrolled>[0], { serverUrl: 'http://127.0.0.1:1' });
    eq(goodRes.reason, 'already-enrolled',
      'B-2 该短路侧：真已注册 ⇒ 仍 `already-enrolled`（确实入网者不被重注册打扰）');
  }

  // ═══ C｜静态接线（去注释码，G-5；反证"占位判据只有一处真源"）═══════════════════
  console.log('\n【C】静态接线：真写前缀 / 零 `dev-key` 字面量 / 上屏如实 / 一处真源');
  {
    const HB = CODE(`${A}/src/main/core/node-heartbeat.ts`);
    const iKey = HB.indexOf('NODE_SETTING_KEYS.ansApiKey, res.api_key');
    const iPre = HB.indexOf('NODE_SETTING_KEYS.enrolledKeyPrefix, res.api_key.slice(0, 8)');
    ok(iKey >= 0 && iPre > iKey,
      'C-1 ★注册成功处**真写** `node.enrolled_key_prefix`（`res.api_key.slice(0, 8)`），紧随 `ansApiKey` 写之后',
      `ansApiKey@${iKey} · prefix@${iPre}`);
    ok(!/'dev-key'/.test(HB),
      'C-2 ★★`node-heartbeat.ts` 内**零** `\'dev-key\'` 字面量（占位判据只有一处真源，禁第二份实现）');
    eq((HB.match(/export function nodeEnrollmentReason\(/g) ?? []).length, 1,
      'C-3 `nodeEnrollmentReason` 定义**恰一处**（首因判据）');
    eq((HB.match(/export function isNodeEnrolled\(/g) ?? []).length, 1,
      'C-4 `isNodeEnrolled` 定义**恰一处**（薄壳，名不变——保 M7-8）');
    ok(/export function isNodeEnrolled\(db: NodeSettingDb\): boolean \{\s*return nodeEnrollmentReason\(db\) === 'enrolled';\s*\}/.test(HB),
      'C-5 ★`isNodeEnrolled` 是**薄壳**：体只 `return nodeEnrollmentReason(db) === \'enrolled\'`（不自造第二份判据）');

    // 占位判据一处真源：`'dev-key'` 只许出现在 `ANS_DEFAULTS` 一处（其所在文件里恰一次）。
    const ASR = CODE(`${A}/src/main/core/ans-signed-request.ts`);
    eq((ASR.match(/'dev-key'/g) ?? []).length, 1,
      'C-6 ★`ans-signed-request.ts` 内 `\'dev-key\'` 字面量**恰一处**（`ANS_DEFAULTS.apiKey`）');
    ok(/export function isPlaceholderApiKey\([\s\S]{0,200}ANS_DEFAULTS\.apiKey/.test(ASR),
      'C-7 `isPlaceholderApiKey` 的占位真源来自 `ANS_DEFAULTS.apiKey`（不另写一份字符串）');

    // 上屏如实（M2）：IPC 回传首因 ∧ 入职卡说人话 ∧ 日志带因。
    const IPC = CODE(`${A}/src/main/ipc/nodes.ipc.ts`);
    ok(/reason:\s*nodeEnrollmentReason\(settingDb\)/.test(IPC),
      'C-8 `nodes:enroll-state` 回传 `reason: nodeEnrollmentReason(settingDb)`（与 `isNodeEnrolled` 同源）');
    const IDX = CODE(`${A}/src/main/index.ts`);
    ok(/nodeEnrollReason\s*=\s*nodeEnrollmentReason\(db\)/.test(IDX),
      'C-9 `index.ts` 未入网分支取首因 `nodeEnrollReason = nodeEnrollmentReason(db)`');
    eq((IDX.match(/isNodeEnrolled\(db\)/g) ?? []).length, 1,
      'C-10 ★`index.ts` 内 `isNodeEnrolled(db)` 仍**恰一处**（保 M7-5/6 静态钉）');
    const PEERS = RD(`${A}/renderer/src/pages/PeersPage.tsx`);
    ok(PEERS.includes("reason === 'placeholder-credential'") && PEERS.includes('非注册所得'),
      'C-11 入职卡按 `reason` 补**一行**诚实话（占位凭据 ⇒ 非注册所得，不计为协同网络一员）');
    ok(PEERS.includes('es.data?.enrolled === false'),
      'C-12 既有两支**原样保留**（`es.data?.enrolled === false` 仍在场——不弄红 rr_zx_20261010_1/_3）');
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
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261012: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261012 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ rr_zx_20261012: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
