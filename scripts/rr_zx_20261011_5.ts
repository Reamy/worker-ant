/**
 * zx_20261011_5 受控复跑 —— 「名正而后事成」：首启体验（漏斗第一跳）。
 *
 * §M1 判据（模型可用性一处真源 + 首启评估）
 *   ① `deriveModelAvailability` **四例枚举**（空目录 / 有行零可用 / 有可用无 chat / 有可用含 chat）——
 *      两侧标本：`available:false` 的 chat 模型**不算**（只喂"该算"的样本 ⇒ "无条件算"也全票通过）。
 *   ② `assessSetup` 真值表：`needsSetup = 无项目 ∧ (未真配 ANS ∨ 无可用 chat)`——
 *      关键反证＝**有项目 ∧ 无模型 ⇒ 不弹**（老用户不因模型缺失被拦回向导）；
 *      并验「只在无项目∧已配 ANS 这格才探模型」（省一次网络往返）＋「read≠ok fail-open 退回旧判据」。
 *   ③ **不改旧真源**：`firstRunState` 返回形状与既有套件逐字段一致（`assessSetup` **只增**）。
 *   ④ `probeModelAvailability` **生产入参**（2026-10-12 实机回归闸）：喂 ANS 的**分页信封**
 *      `{data:[...],total,limit,offset}` ⇒ 目录条数正确（旧实现只认裸数组 ⇒ 信封被当空目录 ⇒
 *      首屏误报"尚无可用模型"）；并反证裸数组与信封**逐字段一致**、空信封仍判 0。
 *
 * §M2 接线（渲染层首屏空态）
 *   `setup.ipc.ts` 真调 `assessSetup` 且经 `ansSignedRequest` 打 `/api/v1/models`；
 *   `DashboardPage` 渲染模型未就绪 banner；**上屏到产物**（renderer 中文串，标识符被 minify）。
 *
 * §M3 软跳过（会话级，非标志）
 *   `App.tsx` 拦截加 `!dismissed`；`SetupPage` 有「先进去看看」；`onboardingSkip.ts` **零 localStorage**、
 *   全仓 `wa_onboarded` 仍**零处**（承 M14「按状态不按标志」——软跳过**不落盘**）。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 用生产函数：firstRunState/assessSetup/deriveModelAvailability/probeModelAvailability 一律调生产导出。
 *   G-2 两侧标本：四例枚举 + 真值表含反证格。
 *   G-4 不依赖真实墙钟/真实进程/真实 ANS：db 与 probe 皆为可注入替身。
 *   G-5 静态判据读**原文**（去注释在本仓是静默毁伤）——故本文件一律 `RD(...)`。
 *   G-6 无轮次字面量：本轮方案路径与脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { firstRunState, assessSetup } from '../apps/worker-ant-desktop/src/main/core/first-run.js';
import {
  deriveModelAvailability, extractModelCatalog, parseModelCapabilities, probeModelAvailability, type ModelProbe,
} from '../apps/worker-ant-desktop/src/main/core/model-availability.js';
import { ANS_DEFAULTS, type AnsCreds } from '../apps/worker-ant-desktop/src/main/core/ans-signed-request.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
/** 静态判据读**原文**（G-5）。 */
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
function walkSrc(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkSrc(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 本套件轮次标识由**载体自身**派生（G-6）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');

/* ── 可注入替身（G-4）──────────────────────────────────────────────────── */
function mkProjectDb(n: number): { prepare(sql: string): { get(): unknown } } {
  return { prepare(sql: string) { return { get() { return sql.includes('wa_projects') ? { n } : undefined; } }; } };
}
const DEV_CREDS: AnsCreds = { baseUrl: ANS_DEFAULTS.url, apiKey: ANS_DEFAULTS.apiKey, secretKey: ANS_DEFAULTS.secretKey };
const USER_CREDS: AnsCreds = { baseUrl: 'https://ans.example.com', apiKey: 'real-key', secretKey: 'real-secret' };

/** 造一个探针返回（`read` 默认 ok）。 */
function probeOf(p: Partial<ModelProbe>): ModelProbe {
  return { read: 'ok', note: '', catalog: 0, available: 0, hasChat: false, hasEmbedding: false, ...p };
}

async function main(): Promise<void> {
  // ═══ M1-① `deriveModelAvailability` 四例枚举 ═══════════════════════════════
  console.log('\n【M1-①】`deriveModelAvailability` 四例枚举（G-2 两侧标本，非只喂"该算"的样本）');
  {
    eq(deriveModelAvailability([]), { catalog: 0, available: 0, hasChat: false, hasEmbedding: false },
      'M1-1a 空目录 ⇒ 四数全 0');
    eq(deriveModelAvailability([{ id: 'a', available: false, capabilities: '["chat"]' }]),
      { catalog: 1, available: 0, hasChat: false, hasEmbedding: false },
      'M1-1b 有行但 `available!==true` ⇒ available=0，且 **chat 不算**（"有模型"≠"能用"）');
    eq(deriveModelAvailability([
      { id: 'e', available: true, capabilities: '["embedding"]' },
      { id: 'd', available: true, capabilities: ['embedding'] },
    ]), { catalog: 2, available: 2, hasChat: false, hasEmbedding: true },
      'M1-1c 两个可用 embedding（字符串 + 数组两种 capabilities 形态）⇒ hasEmbedding=true、hasChat=false');
    eq(deriveModelAvailability([
      { id: 'c', available: true, capabilities: '["chat","embedding"]' },
      { id: 'e', available: true, capabilities: ['embedding'] },
    ]), { catalog: 2, available: 2, hasChat: true, hasEmbedding: true },
      'M1-1d 有可用 chat ⇒ hasChat=true（本页答"跑得起来没有"须看这条）');
    // 边界：非数组入参（undefined / 字符串）⇒ 视作空目录，不抛。
    eq(deriveModelAvailability(undefined), { catalog: 0, available: 0, hasChat: false, hasEmbedding: false },
      'M1-1e `undefined` ⇒ 空目录（不抛）');
    eq(deriveModelAvailability('not-an-array'), { catalog: 0, available: 0, hasChat: false, hasEmbedding: false },
      'M1-1f 字符串入参 ⇒ 空目录（不抛）');
    // `parseModelCapabilities` 三态：坏 JSON ⇒ 空（不把"解析失败"当"有 chat"）。
    eq(parseModelCapabilities('{bad json'), [], 'M1-1g 坏 JSON ⇒ 空数组（不吞成"有 chat"）');
    eq(parseModelCapabilities(42), [], 'M1-1h 数字 ⇒ 空数组');
  }

  // ═══ M1-①b `probeModelAvailability` **生产入参**（分页信封）——2026-10-12 实机回归闸 ═════
  // 病根：`setup.ipc.ts` 喂的是**整个响应信封** `{data:[...],total,limit,offset}`（ANS `GET /api/v1/models`
  //   的现状，`routes/models.ts` 返回 `{ data, ...pageMeta }`），而派生只认裸数组 ⇒ 信封被当**空目录** ⇒
  //   首屏误报"ANS 中尚无可用模型"（该库实有 52 模型 / 4 可用端点）。此段喂**生产形状**（不是理想化的裸数组），
  //   钉住"信封 ⇒ 正确条数"这一跳——旧实现此格为 0，即本次实机缺陷。
  console.log('\n【M1-①b】`probeModelAvailability` 生产入参：分页信封 ⇒ 正确目录（实机回归闸）');
  {
    const rows = [
      { id: 'chat1', available: true, capabilities: '["chat"]' },
      { id: 'emb1', available: true, capabilities: '["embedding"]' },
      { id: 'noep', available: false, capabilities: '["chat"]' },
    ];
    const envelope = { data: rows, total: 3, limit: null, offset: 0 };
    const env = await probeModelAvailability({
      request: async () => ({ ok: true, status: 200, body: envelope }),
    });
    eq(env, { read: 'ok', note: '', catalog: 3, available: 2, hasChat: true, hasEmbedding: true },
      'M1-1i ★信封入参 ⇒ catalog=3（**旧实现此格为 0**，正是实机"尚无可用模型"的病根）');
    const bare = await probeModelAvailability({
      request: async () => ({ ok: true, status: 200, body: rows }),
    });
    eq(bare, env, 'M1-1j 裸数组入参 ⇒ 与信封**逐字段一致**（两形状只差一层壳）');
    eq(extractModelCatalog(envelope).length, 3, 'M1-1k `extractModelCatalog` 直接对信封取数 ⇒ 3');
    eq(extractModelCatalog({ data: [] }).length, 0, 'M1-1l ★反证：信封内 `data` 为空 ⇒ 0（不把空信封当"有"）');
    const emptyEnv = await probeModelAvailability({
      request: async () => ({ ok: true, status: 200, body: { data: [], total: 0, limit: null, offset: 0 } }),
    });
    eq({ c: emptyEnv.catalog, h: emptyEnv.hasChat }, { c: 0, h: false },
      'M1-1m ★反证：空信封 ⇒ catalog=0 且 hasChat=false（如实报"确实 0 个"）');
    const auth = await probeModelAvailability({ request: async () => ({ ok: false, status: 401 }) });
    eq(auth.read, 'auth', 'M1-1n 401 ⇒ read=auth（与 body 形状无关）');
  }

  // ═══ M1-② `assessSetup` 真值表（两侧标本 + 关键反证）════════════════════════
  console.log('\n【M1-②】`assessSetup` 真值表（含"有项目∧无模型⇒不弹"关键反证 + 省往返 + fail-open）');
  {
    // b1：无项目 ∧ 未真配 ANS（dev 缺省）⇒ 结论已定，**不该**探模型。
    let calls = 0;
    const probeChat = async () => { calls++; return probeOf({ catalog: 3, available: 2, hasChat: true }); };
    let r = await assessSetup(mkProjectDb(0), DEV_CREDS, probeChat);
    eq({ n: r.needsSetup, h: r.hasProject, a: r.ansUserConfigured, m: r.model },
      { n: true, h: false, a: false, m: null },
      'M1-2a 无项目 ∧ 未配 ANS ⇒ **弹**（旧判据已定，模型为 null）');
    ok(calls === 0, 'M1-2b ★省一次网络往返：结论已定的格**不探模型**（探针零调用）', `calls=${calls}`);

    // b2：无项目 ∧ 已配 ANS ∧ 探得 chat 可用 ⇒ 不弹。
    r = await assessSetup(mkProjectDb(0), USER_CREDS, probeChat);
    eq({ n: r.needsSetup, m: r.model?.hasChat }, { n: false, m: true },
      'M1-2c 无项目 ∧ 已配 ANS ∧ 有可用 chat ⇒ **不弹**（真跑得起来）');

    // b3：无项目 ∧ 已配 ANS ∧ **无 chat**（N1 洞）⇒ 弹——本轮的**主诉**。
    r = await assessSetup(mkProjectDb(0), USER_CREDS, async () => probeOf({ catalog: 41, available: 0 }));
    ok(r.needsSetup === true,
      'M1-2d ★主诉：无项目 ∧ 已配 ANS ∧ **无可用 chat** ⇒ **弹**（旧判据此处会漏，用户落到空白 Dashboard）');

    // b4：**有项目** ∧ 无 chat ⇒ 不弹（关键反证——老用户不因模型缺失被拦回向导，且不探模型）。
    calls = 0;
    const probeNoChat = async () => { calls++; return probeOf({ catalog: 41, available: 0 }); };
    r = await assessSetup(mkProjectDb(7), USER_CREDS, probeNoChat);
    eq({ n: r.needsSetup, m: r.model },
      { n: false, m: null },
      'M1-2e ★反证：**有项目** ∧ 无 chat ⇒ 不弹（老用户不被模型缺失拦回向导）');
    ok(calls === 0, 'M1-2f 有项目 ⇒ 结论已定，同样**不探模型**', `calls=${calls}`);

    // b5：probe 抛错 ⇒ fail-open 退回旧判据（读不动 ⇒ 少拦不可错拦），model=null。
    r = await assessSetup(mkProjectDb(0), USER_CREDS, async () => { throw new Error('boom'); });
    eq({ n: r.needsSetup, m: r.model }, { n: false, m: null },
      'M1-2g fail-open：探针**抛错** ⇒ 退回旧判据（已配 ANS ⇒ 不弹），model=null');

    // b6：探得 read='auth'（401 读不动）⇒ 同样 fail-open，但 model 保留如实 read 供首屏 banner。
    r = await assessSetup(mkProjectDb(0), USER_CREDS, async () => probeOf({ read: 'auth', note: 'HTTP 401' }));
    eq({ n: r.needsSetup, m: r.model?.read, note: r.model?.note },
      { n: false, m: 'auth', note: 'HTTP 401' },
      'M1-2h ★fail-open 但**如实**：401 读不动 ⇒ 退回旧判据，model 仍带 read/note（供首屏说"未认证"）');
  }

  // ═══ M1-③ 不改旧真源：`firstRunState` 形状不变（反证）══════════════════════════
  console.log('\n【M1-③】`firstRunState` 返回形状**逐字段不变**（`assessSetup` 只增不改）');
  {
    eq(firstRunState(mkProjectDb(0), DEV_CREDS), { needsSetup: true, hasProject: false, ansUserConfigured: false },
      'M1-3a 与既有套件 M14-1a **逐字段相同**（旧真源未被本轮改动）');
    eq(firstRunState(mkProjectDb(3), USER_CREDS), { needsSetup: false, hasProject: true, ansUserConfigured: true },
      'M1-3b 与既有套件 M14-1d 相同');
    const keys = Object.keys(await assessSetup(mkProjectDb(0), USER_CREDS, async () => probeOf({ hasChat: true }))).sort();
    eq(keys, ['ansUserConfigured', 'hasProject', 'model', 'needsSetup'],
      'M1-3c `assessSetup` 是 `firstRunState` 的**超集**（三旧字段 + model）');
  }

  // ═══ M2 接线（main + 渲染层 + 产物）════════════════════════════════════════
  console.log('\n【M2】接线：main 调真源 + 渲染层首屏空态**上屏到产物**');
  {
    const SETUP_IPC = stripKeepingLines(RD(`${A}/src/main/ipc/setup.ipc.ts`)).join('\n');
    ok(/assessSetup\(/.test(SETUP_IPC), 'M2-1 `setup.ipc.ts` 真调 `assessSetup`（去注释码）');
    ok(/'setup:model-availability'/.test(SETUP_IPC), 'M2-2 `setup.ipc.ts` 注册 `setup:model-availability` handler');
    ok(/ansSignedRequest\(/.test(SETUP_IPC) && /\/api\/v1\/models/.test(SETUP_IPC),
      'M2-3 模型探测经**全仓唯一出路** `ansSignedRequest` 打 `/api/v1/models`');
    const FIRSTRUN = RD(`${A}/src/main/core/first-run.ts`);
    ok(/export async function assessSetup/.test(FIRSTRUN), 'M2-4 `first-run.ts` 导出 `assessSetup`');

    const DASH = RD(`${A}/renderer/src/pages/DashboardPage.tsx`);
    ok(/模型未就绪/.test(DASH) && /setup:model-availability|modelAvailability/.test(DASH),
      'M2-5 `DashboardPage` 渲染"模型未就绪"banner（读 `modelAvailability`）');

    const assetsDir = path.join(root, A, 'renderer/dist/assets');
    const readChunk = (re: RegExp): string => {
      const fs2 = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter((f) => re.test(f)) : [];
      return fs2.length === 1 ? fs.readFileSync(path.join(assetsDir, fs2[0]!), 'utf-8') : '';
    };
    const dashJs = readChunk(/^DashboardPage-.*\.js$/);
    ok(dashJs.includes('模型未就绪'),
      'M2-6 ★**上屏到产物**：`模型未就绪` 真进了 DashboardPage 产物（"只写在源码、没打进 GUI"在此必红）',
      dashJs ? `命中=${dashJs.includes('模型未就绪')}` : 'chunk 缺席');
  }

  // ═══ M3 软跳过（会话级，非标志）+ 接线 ═══════════════════════════════════════
  console.log('\n【M3】向导软跳过：会话级豁免、**不落盘**（承 M14「按状态不按标志」）');
  {
    const APP = RD(`${A}/renderer/src/App.tsx`);
    ok(/setup\s*&&\s*!dismissed/.test(APP), 'M3-1 `ProtectedRoute` 拦截加 `&& !dismissed`（软跳过放行一次）');
    ok(/isOnboardingSkipped/.test(APP), 'M3-2 `App.tsx` 读会话级跳过（`isOnboardingSkipped`）');

    const SKIP = RD(`${A}/renderer/src/lib/onboardingSkip.ts`);
    ok(/export function skipOnboarding/.test(SKIP) && /export function isOnboardingSkipped/.test(SKIP),
      'M3-3 `onboardingSkip.ts` 导出读写两端');
    ok(!/localStorage/.test(stripKeepingLines(SKIP).join('\n')),
      'M3-4 ★软跳过**零 localStorage**（去注释码）——写进标志＝把判据退回"点没点过按钮"');
    const SETUP = RD(`${A}/renderer/src/pages/SetupPage.tsx`);
    ok(/先进去看看/.test(SETUP) && /skipOnboarding\(\)/.test(SETUP),
      'M3-5 `SetupPage` 有「先进去看看」按钮且调 `skipOnboarding()`');
    // 全仓 `wa_onboarded` 仍零处（承 M14-2f；软跳过**不新增**任何持久化标志）。
    const rFiles = walkSrc(path.join(root, A, 'renderer/src'));
    const stray = rFiles.filter((f) => RD(path.relative(root, f)).includes('wa_onboarded'));
    eq(stray.map((f) => path.relative(root, f)), [],
      'M3-6 ★`wa_onboarded` 全仓**零处**（软跳过未退化成持久化标志）');

    const setupJs = (() => {
      const fs2 = fs.existsSync(assetsDirPath()) ? fs.readdirSync(assetsDirPath()).filter((f) => /^SetupPage-.*\.js$/.test(f)) : [];
      return fs2.length === 1 ? fs.readFileSync(path.join(assetsDirPath(), fs2[0]!), 'utf-8') : '';
    })();
    ok(setupJs.includes('先进去看看'),
      'M3-7 ★**上屏到产物**：`先进去看看` 真进了 SetupPage 产物', setupJs ? `命中=${setupJs.includes('先进去看看')}` : 'chunk 缺席');
  }

  // ═══ S 哑雷自检 + build 钉 ═════════════════════════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 ★方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/${path.basename(__filename)}`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/${path.basename(__filename)}`);

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

/** 渲染层产物目录（抽函数免得上面两处重复拼接）。 */
function assetsDirPath(): string { return path.join(root, A, 'renderer/dist/assets'); }

main().catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261011_5 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261011_5: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
});
