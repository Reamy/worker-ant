/**
 * zx_20261010_1 受控复跑 —— 「入了网，才叫一员」（令牌输入 / 申请入口 + 注册后即时生效）。
 *
 * 病根（上一轮 §5 挂账）：`node.enrollment_token` **全仓只读不写** ⇒ 干净 clone 永无令牌
 *   ⇒ `ensureNodeEnrolled` 恒返 `no-enrollment-token` ⇒ 多机协同在本仓**实质不可加入**。
 *   界面却写着「若已配 `node.enrollment_token`…」——一句**没有用法的话**（维特根斯坦·意义即使用）。
 *
 * 判据分三层：
 *   A. **core 单源（行为两侧）**：令牌读写往返；申请喂**假 request** 成功/失败两态（失败**不写**）；
 *      注册复用（不写第二份 `enrollNode` 调用）。
 *   B. **IPC 三出口接线**：`nodes:enroll` / `nodes:request-token` 各过 Team 软闸；`nodes:enroll-success`
 *      分支调 `startNodeRuntime()`（免重启）；`nodes:enroll-state` 读同源判据。
 *   C. **即时生效接线**：`index.ts` 起心跳仍**恰一处**（M3 抽具名函数未裂成两份）+ starter 注册在册。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：判据一律调生产导出（静态导入 ⇒ 被删/改名即编译期失败）。
 *   G-2 **两侧标本**：申请成功/失败两态都喂——只喂成功则"恒 ok=true"的过宽变体全票通过。
 *   G-4 **不碰真实网络**：`requestEnrollmentToken` 的 `request` 一律**注入假实现**；注册路只走
 *       "无令牌"分支（不触 `enrollNode` 的真网络）。
 *   G-5 静态判据读**原文**（去注释在本仓是静默毁伤）——一律 `RD(...)`，不 `strip`。
 *   G-6 **无轮次字面量**：本轮方案路径与脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：判据引用的生产符号**全部静态导入** ⇒ 被删/改名即编译期失败（而非"扫了个空、静默假绿"）。
import {
  enrollWithToken, readEnrollmentToken, requestEnrollmentToken, writeEnrollmentToken,
} from '../apps/worker-ant-desktop/src/main/core/node-heartbeat.js';
import type { NodeSettingDb } from '../apps/worker-ant-desktop/src/main/core/node-identity.js';
import { setNodeRuntimeStarter, startNodeRuntime } from '../apps/worker-ant-desktop/src/main/core/node-runtime.js';
import type { AnsRequestResult } from '../apps/worker-ant-desktop/src/main/core/ans-signed-request.js';

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
/** 静态判据读**原文**（G-5：去注释在本仓是静默毁伤——"注释里写着有、代码里没有"正是要防的形态）。 */
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
/** 递归收集某目录下全部 `.ts`（静态判据扫**整个 main src**，不是单文件——防"另开一处"绕过）。 */
function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(p, out);
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。
 *  本套件名带 `_1` 数字后缀（非 `_<字母>`），故只剥 `rr_` 前缀与 `.ts` 后缀——不套用 `_team` 那类正则。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''); // zx_20261010_1

/* ── 夹具 ────────────────────────────────────────────────────────────────── */

/** `wa_settings` 单表夹具（`readNodeSetting`/`writeNodeSetting` 的真读面）。DDL 与生产 `database.ts` 同形。 */
function settingDb(settings: Record<string, string> = {}): NodeSettingDb {
  const d = new DatabaseSync(':memory:');
  d.exec("CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))");
  for (const [k, v] of Object.entries(settings)) d.prepare('INSERT INTO wa_settings (key,value) VALUES (?,?)').run(k, v);
  return d as unknown as NodeSettingDb;
}
/** **无表**库——`writeNodeSetting` 必落 false（验"落库失败如实返回"这一侧）。 */
function bareDb(): NodeSettingDb { return new DatabaseSync(':memory:') as unknown as NodeSettingDb; }

/** 假请求结果（G-4：受控回归喂假 ⇒ 不碰真实网络）。`new Response` 提供真 `.json()`。 */
const okRes = (body: unknown): AnsRequestResult => ({ ok: true, status: 201, response: new Response(JSON.stringify(body), { status: 201 }), attempts: 1 });
const failRes: AnsRequestResult = { ok: false, status: 401, attempts: 1 };

async function main(): Promise<void> {
  // ═══ A｜core 单源（行为两侧）═══════════════════════════════════════════════
  console.log('\n【A】令牌读写 + 申请（行为两侧 / 维特根斯坦·意义即使用：这个键终于有了用法）');
  {
    const db = settingDb();
    eq(readEnrollmentToken(db), null, 'A-1 未写过 ⇒ `null`（不是空串——"没有"与"空值"分得开）');
    eq(writeEnrollmentToken(db, 'enr-0001'), true, 'A-2 写口落库成功 ⇒ `true`');
    eq(readEnrollmentToken(db), 'enr-0001', 'A-3 ★**往返**：写进去的读回来是同一个值（键与读写共用一个真源）');
    writeEnrollmentToken(db, 'enr-0002');
    eq(readEnrollmentToken(db), 'enr-0002', 'A-4 再写覆盖（不是"只认第一次"）');
    eq(writeEnrollmentToken(bareDb(), 'enr-x'), false, 'A-5 ★无 `wa_settings` 表 ⇒ **如实 `false`**（落库失败不假装成功——否则界面以为配上了）');

    // ── 申请：喂假 request（两侧标本）──
    const db2 = settingDb();
    const okR = await requestEnrollmentToken(db2, { request: async () => okRes({ data: { token: 'enr-from-ans' } }) });
    eq([okR.ok, okR.token], [true, 'enr-from-ans'], 'A-6 ★申请成功体 ⇒ `ok=true` 且取到令牌串');
    eq(readEnrollmentToken(db2), 'enr-from-ans', 'A-7 ★★**写回**：申请即落 `node.enrollment_token`（下一步注册读的正是它——两步不脱节）');

    const db3 = settingDb();
    const failR = await requestEnrollmentToken(db3, { request: async () => failRes });
    eq([failR.ok, failR.token, readEnrollmentToken(db3)], [false, null, null],
      'A-8 ★★两侧标本：失败体（401）⇒ `ok=false`、无令牌、**不写**（若实现"无论成败都写"则此红）');
    ok(failR.note.length > 0 && failR.note.includes('HTTP 401'),
      'A-9 失败**如实报因**（`ansFailureNote` 形状：含 `HTTP 401`——不是一句"失败了"）', failR.note);

    const db4 = settingDb();
    writeEnrollmentToken(db4, 'enr-keep');
    const noTok = await requestEnrollmentToken(db4, { request: async () => okRes({ data: {} }) });
    eq([noTok.ok, readEnrollmentToken(db4)], [false, 'enr-keep'],
      'A-10 ★近似标本：响应 `ok` 但**无 token 串** ⇒ 也算失败、且**不覆盖**已存令牌（防 ANS 版本不匹配时把好令牌写没）');
    ok(noTok.note.includes('令牌'), 'A-11 该失败原因说明"响应里没有令牌串"（人可读）', noTok.note);
  }

  // ═══ A｜注册复用（不写第二份）═════════════════════════════════════════════
  {
    const r = await enrollWithToken(settingDb());
    eq(r.reason, 'no-enrollment-token', 'A-12 无令牌 ⇒ `enrollWithToken` 走 `no-enrollment-token`（不触网，如实说"没得注册"）');
    const HB = RD(`${A}/src/main/core/node-heartbeat.ts`);
    const ewIdx = HB.indexOf('export function enrollWithToken(');
    const ewBody = ewIdx >= 0 ? HB.slice(ewIdx, HB.indexOf('\n}', ewIdx)) : '';
    ok(ewBody.includes('ensureNodeEnrolled('),
      'A-13 ★`enrollWithToken` **复用** `ensureNodeEnrolled`（不写第二份注册——注册实现一处，见 B-1）');
  }

  // ═══ B｜单源静态：注册路恰一处 + 令牌写口恰一处 ═══════════════════════════
  console.log('\n【B】单源静态（道德经·六十四章：合抱之木生于毫末——一环一环各归一处）');
  {
    const mainSrc = walkTs(path.join(root, `${A}/src/main`)).map((f) => fs.readFileSync(f, 'utf-8')).join('\n');
    eq((mainSrc.match(/enrollNode\(/g) ?? []).length, 1,
      'B-1 ★**注册调用全仓恰一处**（`enrollNode(` 只在 `ensureNodeEnrolled` 内——申请路只签令牌，不注册）');
    eq((mainSrc.match(/writeNodeSetting\([^)]*enrollmentToken/g) ?? []).length, 1,
      'B-2 ★**令牌写口全仓恰一处**（`writeNodeSetting(…enrollmentToken…)` 只此一处——`writeEnrollmentToken` 体内）');
  }

  // ═══ C｜IPC 三出口接线（读原文，G-5）══════════════════════════════════════
  console.log('\n【C】加入之门（IPC 三出口 / 毛泽东·实践论：这条路得真能走）');
  {
    const NIPC = RD(`${A}/src/main/ipc/nodes.ipc.ts`);
    // zx_20261011 订正（**强化非放宽**）：M4 新增 `nodes:dispatch` **写口也过同一道 Team 软闸** ⇒ 闸数 3→4。
    // zx_20261011_1 M4 再订正：双向澄清的**作答写口** `nodes:answer-question` 与派发同闸 ⇒ 闸数 4→5（面再扩，非放宽）。
    // zx_20261011_3 再订正：删除离线节点的**写口** `nodes:delete` 同闸 ⇒ 闸数 5→6（面再扩，非放宽）。
    //   逐 handler 取体核闸（新增写口若漏闸即红），原五处仍须在。
    const NODE_GATED = ['nodes:update', 'nodes:enroll', 'nodes:request-token', 'nodes:dispatch', 'nodes:answer-question', 'nodes:delete'];
    const bodyOf = (h: string): string => {
      const i = NIPC.indexOf(`ipcMain.handle('${h}'`);
      if (i < 0) return '';
      const j = NIPC.indexOf('ipcMain.handle(', i + 10);
      return NIPC.slice(i, j < 0 ? NIPC.length : j);
    };
    const gateOf = (h: string): boolean => bodyOf(h).includes("teamFeatureRefusal(licDb, 'multi_node')");
    ok(NODE_GATED.every(gateOf),
      'C-1 ★**六个动作出口各一道 Team 软闸**（update / enroll / request-token / dispatch / answer-question / delete——漏一处即可绕过）',
      NODE_GATED.map((h) => `${h}=${gateOf(h)}`).join(' · '));
    // zx_20261018_1 批一订正（**强化非放宽**）：`nodes:confirm-auto-dispatch` 是首次入网引导写口。
    //   它的闸在 **core 一处**（`applyAutoDispatchOnboarding` 先 `teamFeatureRefusal` 再写），IPC 侧
    //   只在失败时**归因**（`ok=false` 且 Team 锁 ⇒ TEAM_REQUIRED）——故与上面六个"先闸后做"的写口
    //   分列核对，不混为一谈；两处各须在场（漏归因 ⇒ 前端只看到 INTERNAL，用户不知道是档位）。
    const CORE_GATED = ['nodes:confirm-auto-dispatch'];
    ok(CORE_GATED.every((h) => gateOf(h)),
      'C-1b ★引导写口 `nodes:confirm-auto-dispatch` 的 Team 锁如实归因（core 已先闸，IPC 只归因）',
      CORE_GATED.map((h) => `${h}=${gateOf(h)}`).join(' · '));
    // C-2 由**枚举派生**（不再写死 6）：每个 `code: 'TEAM_REQUIRED'` 必须落在上述某个 handler 体内
    //   （漏列的写口即红）——这同时是"新增写口若漏闸"的反证。
    const ALL_GATED = [...NODE_GATED, ...CORE_GATED];
    const nTotal = (NIPC.match(/code: 'TEAM_REQUIRED'/g) ?? []).length;
    const nInHandlers = ALL_GATED.reduce((n, h) => n + (bodyOf(h).match(/code: 'TEAM_REQUIRED'/g) ?? []).length, 0);
    eq(nTotal, nInHandlers,
      'C-2 每处 `code: \'TEAM_REQUIRED\'` 都在枚举的 handler 体内（钉 `code:` 调用形状，避开注释里的裸词）');
    ok(ALL_GATED.every((h) => (bodyOf(h).match(/code: 'TEAM_REQUIRED'/g) ?? []).length === 1),
      'C-2b 七个出口各恰一处如实回 `TEAM_REQUIRED`（6 先闸 + 1 归因）',
      ALL_GATED.map((h) => `${h}=${(bodyOf(h).match(/code: 'TEAM_REQUIRED'/g) ?? []).length}`).join(' · '));

    const enrIdx = NIPC.indexOf("ipcMain.handle('nodes:enroll'");
    const rtIdx = NIPC.indexOf("ipcMain.handle('nodes:request-token'");
    const esIdx = NIPC.indexOf("ipcMain.handle('nodes:enroll-state'");
    const enrBody = enrIdx >= 0 && rtIdx > enrIdx ? NIPC.slice(enrIdx, rtIdx) : '';
    ok(enrBody.includes("teamFeatureRefusal(licDb, 'multi_node')") && enrBody.includes('startNodeRuntime()'),
      'C-3 ★★`nodes:enroll`：过软闸 **且** 成功支调 `startNodeRuntime()`（免重启起心跳/中转——本轮 Q3）');
    ok(enrBody.indexOf('teamFeatureRefusal(') >= 0 && enrBody.indexOf('teamFeatureRefusal(') < enrBody.indexOf('startNodeRuntime()'),
      'C-4 ★**闸在起之前**：锁定即不注册、不起心跳（先判后做，反了则锁定档也能入网）');

    const rtBody = rtIdx >= 0 ? NIPC.slice(rtIdx, NIPC.indexOf('ipcMain.handle(', rtIdx + 10)) : '';
    ok(rtBody.length > 0 && !/data: \{[^}]*token:/.test(rtBody),
      'C-5 ★`nodes:request-token` **不回传全令牌**（面板无需展示——令牌已写回 settings、注册随即用它）');

    ok(esIdx >= 0 && NIPC.slice(esIdx).includes('isNodeEnrolled(settingDb)') && NIPC.slice(esIdx).includes('readEnrollmentToken(settingDb)'),
      'C-6 ★`nodes:enroll-state` 读**同源判据**（`isNodeEnrolled` + `readEnrollmentToken`——入职卡据此决定显不显示）');

    const RIPC = RD(`${A}/renderer/src/lib/ipc.ts`);
    ok(["'nodes:enroll'", "'nodes:request-token'", "'nodes:enroll-state'"].every((s) => RIPC.includes(s)),
      'C-7 渲染层三通道在册（preload 是通用透传 ⇒ 无需逐通道声明，但通道名须对得上）');
  }

  // ═══ D｜即时生效接线（M3）════════════════════════════════════════════════════
  console.log('\n【D】即时生效（可注入 starter / 维特根斯坦·意义即使用：注册成功那一刻就起得来）');
  {
    const IDX = RD(`${A}/src/main/index.ts`);
    eq((IDX.match(/startNodeHeartbeat\(db/g) ?? []).length, 1,
      'D-1 ★起心跳**仍恰一处**（M3 抽出具名函数后未裂成两份——一处真源）');
    eq((IDX.match(/setNodeRuntimeStarter\(/g) ?? []).length, 1,
      'D-2 装配期注册 starter **恰一次**（`index.ts` 一处）');
    ok(IDX.includes('async function startNodeRuntime(): Promise<boolean>'),
      'D-3 ★starter 是**具名函数声明**（提升 ⇒ 置于闸块之后不破坏 M7 文本序断言）');
    eq((IDX.match(/void startNodeRuntime\(\)/g) ?? []).length, 1,
      'D-4 启动时**调一次**（`else { void startNodeRuntime(); }`——行为与今日等价）');

    // ── 行为：`startNodeRuntime` 未注册 starter ⇒ 如实 false（零 electron，可直引跑真实现）──
    setNodeRuntimeStarter(null);
    eq(await startNodeRuntime(), false, 'D-5 ★未注册 starter ⇒ **如实 `false`**（不假装起了——"不知道"≠"起来了"）');
    setNodeRuntimeStarter(async () => true);
    eq(await startNodeRuntime(), true, 'D-6 注册 starter ⇒ 透传其返回值（`true`）');
    setNodeRuntimeStarter(async () => { throw new Error('boom'); });
    eq(await startNodeRuntime(), false, 'D-7 ★starter **抛** ⇒ 兜底 `false`（异常不漏给调用方——注册成功支不该被拖崩）');
    setNodeRuntimeStarter(null);
  }

  // ═══ E｜renderer 第二落点（入职卡）═════════════════════════════════════════
  console.log('\n【E】入职卡（renderer 第二落点：词表须穷举到界面）');
  {
    const PEERS = RD(`${A}/renderer/src/pages/PeersPage.tsx`);
    ok(PEERS.includes('function EnrollCard(') && PEERS.includes('es.data?.enrolled === false'),
      'E-1 ★入职卡**仅在未入网时出现**（`enrolled === false` 才显——已入网换成"等待台账收录"提示）');

    // 产物（minify 后标识符搜不到，中文串可搜）——须先跑 renderer build。
    const assetsDir = path.join(root, `${A}/renderer/dist/assets`);
    const chunks = fs.existsSync(assetsDir)
      ? fs.readdirSync(assetsDir).filter((f) => /^PeersPage-.*\.js$/.test(f)) : [];
    eq(chunks.length, 1, 'E-2 PeersPage 产物 chunk 恰一个（renderer 已构建）');
    if (chunks.length === 1) {
      const c = fs.readFileSync(path.join(assetsDir, chunks[0]!), 'utf-8');
      ok(['加入本 ANS 的协同网络', '一键申请', '粘贴注册令牌（enr-…）', '用已存令牌注册'].every((s) => c.includes(s)),
        'E-3 ★产物含**两条路**的用户可见文案（粘贴令牌 / 一键申请——空话补成了可操作的门）');
      ok(c.includes('团队版'), 'E-4 升级文案仍在册（M22 未被子卡挤掉）');
    }
  }

  // ═══ S｜哑雷自检 + build 钉（派生核对，不写轮次字面量）══════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 ★方向性自指（由载体自身派生，非抄来的常量）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261010_1: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261010_1 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ rr_zx_20261010_1: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
