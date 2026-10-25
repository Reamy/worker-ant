/**
 * zx_20261005 受控复跑 —— 批二「卖得动 · 之三」（ANS 上手第一跳：端口单源 / 绑定失败如实 / 桌面托管）。
 *
 * 按实施排期逐批转绿（`RR_STAGE=Mn` 只要求 ≤Mn 的批次为绿，更晚的批次打 ⏳ 不计入失败；
 * `RR_STAGE` 为空 = 全部须绿，收口用）。批序见下方 `ORDER`。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §M21 判据（批二 / K-11）——「一条规则一处；拉不起就如实说」。
 *
 * ① 端口**单源**（管子·度量衡一处）：`ANS_DEFAULT_PORT` 是 ANS 监听默认与全部客户端默认的**唯一尺**——
 *    `ANS_DEFAULT_BASE_URL` 由 host+port **派生**（真源自身也不手写整串）；桌面 `core/ans-signed-request.ts`
 *    的缺省 url、`core/mcp-client-pool.ts` 的兜底模板、renderer 的可见文案**三处消费方**皆由此派生/过桥；
 *    `src/main` 内**零** ANS 地址整串字面量（残留第二份 ⇒ 用户把 ANS 配到别处时那一路探的是别的机器）。
 *    renderer 是词表**第二落点**（无 shared-types 依赖，经 `ans:defaults` IPC 过桥；判据钉"与之同值"）。
 *
 * ② 绑定失败**如实**（毛选·不打无准备之仗）：端口被占时 `@elysiajs/node` 底层 srvx 把 listen 错误
 *    `.catch(()=>{})` **吞掉** ⇒ `try{ listen }catch` 永不触发、进程照打"已启动"——一句**谎**。
 *    两侧标本：`app.listen` **不抛**（旧写法为何无效）+ `raw.ready()` **抛 EADDRINUSE**（新写法为何有效）；
 *    结构性反证：`process.exit(1)` 分支**先于**"已启动"日志（占口时不可能打出"已启动"）。
 *
 * ③ 桌面**托管**（K-11）：`core/ans-supervisor.ts` 四条纪律——**只拉本地的**（`isLocalUrl`）、
 *    **只杀自己拉起的**（`stopManagedAns`）、**拉不起就如实说**（打包版 ⇒ `no-entry`）、
 *    **拉起命令须真跑得起来**（zx_20261006 M1/M2 补：真入口 + 一死即报因）。
 *    全部可注入（fetch/spawn/时钟）⇒ 本套件直跑**真实现**（零 electron 依赖），逐因穷举九个 `reason`。
 *
 * ④ **起得来**（zx_20261006 M1/M2/M3，缺陷修复轮）——M21-3i 原判据是**假绿**：断言名写「指向**真入口**」，
 *    字面却钉 `node_modules/.bin/tsx`，而那是 **sh 垫片**（`node <它>` 必 `SyntaxError`）；且八个
 *    `ensureAnsStarted` 用例**全注入 `spawnImpl`** ⇒ 那条真命令从未被执行过。本轮改钉**更强真源**
 *    （交给 node 的文件须**能被 node 解析**：`node --check`），并补"启动即死"两态（`native-abi-mismatch`
 *    / `child-exited`）与「用户手点 `ans:start` 恒 `no-entry`」（漏传 `isDev`/`repoRoot`）的接线钉。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：isLocalUrl/probeAns/resolveAnsLaunchCommand/ensureAnsStarted/stopManagedAns 一律调生产导出。
 *   G-2 **两侧标本**：本地/远端、可达/不可达、起得来/起不来，两侧都要能被本文件抓红。
 *   G-4 **不依赖真实墙钟**：假 fetch + 注入 `sleepImpl` / `readyTimeoutMs=0` 决定等待与超时。
 *   G-5 静态判据读**原文**（去注释在本仓是静默毁伤）——故本文件一律 `RD(...)`，不 `strip`。
 *   G-6 **无轮次字面量**：本轮方案路径与脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync, type spawn } from 'node:child_process';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：判据引用的生产符号**全部静态导入** ⇒ 被删/改名即**编译期失败**（而非"扫了个空、静默假绿"）。
import { ANS_DEFAULT_HOST, ANS_DEFAULT_PORT, ANS_DEFAULT_BASE_URL } from '../packages/shared-types/src/ans-defaults.js';
import {
  isLocalUrl, probeAns, resolveAnsLaunchCommand, ensureAnsStarted, stopManagedAns, ansSupervisorState, ansStartInFlight,
  resolveTsxCli, findRepoRoot,
} from '../apps/worker-ant-desktop/src/main/core/ans-supervisor.js';
// zx_20261009「自己人」握手批（H1）：凭据一处真源 + 代起即发凭据——G-1 一律调生产导出。
import { ansApiKeysEnvValue } from '../apps/worker-ant-desktop/src/main/core/ans-signed-request.js';
import { mintLocalAnsCreds } from '../apps/worker-ant-desktop/src/main/core/ans-local-creds.js';
import { generateCredentialPair } from '../packages/ans-client/src/crypto.js';
// M5 桌面侧「说得清」：401/读失败/真无模型 三分——判据直调**无 React 依赖**的生产导出（不扫文案）。
import { probeModelsLine } from '../apps/worker-ant-desktop/renderer/src/lib/probe-models.js';

// ── 批次门（排期序）────────────────────────────────────────────────────────
const ORDER = ['M21', 'H1', 'H2'] as const;
type Batch = (typeof ORDER)[number];
const STAGE = (process.env.RR_STAGE || '').trim() as Batch | '';
const required = (b: Batch): boolean => STAGE === '' || ORDER.indexOf(b) <= ORDER.indexOf(STAGE);

let pass = 0; let fail = 0; let pending = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** 登记一条**受批次门管辖**的判据；未实施批次的判据**仍求值**（要的是"红为什么红"），只是不计入失败。 */
function crit(b: Batch, cond: boolean, label: string, detail?: string): void {
  if (!required(b)) { pending++; console.log(`  ⏳ [${b}] ${label}${cond ? ' —— **已提前为真**' : ''}`); return; }
  if (cond) { pass++; console.log(`  ✓ [${b}] ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ [${b}] ${label}${detail ? ` — ${detail}` : ''}`); }
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
/** 递归收集某目录下全部 `.ts`（用于"零处残留"扫描面）。 */
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/_ans\.ts$/, ''); // zx_20261005

/* ── 可注入的替身（G-4：不碰真网络 / 真进程 / 真时钟）──────────────────────── */

type AnyFetch = typeof fetch;
/** 固定状态码的假 fetch（`status=0` ⇒ 未响应）。 */
const mkFetch = (status: number): AnyFetch =>
  (async () => ({ ok: status >= 200 && status < 300, status })) as unknown as AnyFetch;
/** 连接被拒的假 fetch（ANS 没起时真实形态）。 */
const refusedFetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as AnyFetch;
/** 挂起直到 abort 的假 fetch（测超时）。 */
const hangingFetch = ((_u: string, init?: { signal?: AbortSignal }) => new Promise((_res, rej) => {
  init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
})) as unknown as AnyFetch;

interface SpawnSpy { calls: number; killed: string[] }
/** 假 spawn：只实现 supervisor 用到的 `pid` / `.on('exit')` / `.kill()`。 */
function mkSpawn(spy: SpawnSpy, pid = 4242, throwErr?: Error): typeof spawn {
  return ((_cmd: string, _args: string[], _opts: unknown) => {
    spy.calls++;
    if (throwErr) throw throwErr;
    const child = { pid, on: () => child, kill: (sig?: string) => { spy.killed.push(sig ?? ''); return true; } };
    return child;
  }) as unknown as typeof spawn;
}
const noSleep = async (): Promise<void> => { /* 免真等 */ };

/**
 * 假 spawn：子进程**启动即死**——先把遗言推给 `stderr`，再发 `exit`（复刻真实崩溃的时序）。
 *
 * 为什么需要它：原八个用例只覆盖"起得来/起不来（探不到）"，**没有**"进程死了"这一态——
 *   于是 `stdio:'ignore'` 把遗言扔掉、把"早死了"拖成 20s 后的 `start-timeout` 这一病，判据照不出来。
 */
function mkDeadSpawn(spy: SpawnSpy, stderrText: string): typeof spawn {
  return ((_cmd: string, _args: string[], _opts: unknown) => {
    spy.calls++;
    const dataCbs: Array<(c: unknown) => void> = [];
    const exitCbs: Array<() => void> = [];
    const child = {
      pid: 5150,
      stderr: {
        on: (ev: string, cb: (c: unknown) => void) => { if (ev === 'data') dataCbs.push(cb); return child.stderr; },
      },
      on: (ev: string, cb: () => void) => { if (ev === 'exit') exitCbs.push(cb); return child; },
      kill: (sig?: string) => { spy.killed.push(sig ?? ''); return true; },
    };
    queueMicrotask(() => { for (const cb of dataCbs) cb(stderrText); for (const cb of exitCbs) cb(); });
    return child;
  }) as unknown as typeof spawn;
}

/**
 * 假 spawn：**启动本身失败**（真实形态是 `child.on('error')` 异步事件，不是同步抛）。
 *
 * 为什么需要它：`cwd` 不存在时的 ENOENT 走的是异步 `error` 事件，旧实现没接 ⇒
 *   变成进程级未捕获异常，等待循环也收不到 `exit`（实测打包版首启）。同步抛的替身照不出这一态。
 */
function mkErrorSpawn(spy: SpawnSpy, err: Error): typeof spawn {
  return ((_cmd: string, _args: string[], _opts: unknown) => {
    spy.calls++;
    const errCbs: Array<(e: Error) => void> = [];
    const child = {
      pid: undefined,
      stderr: { on: () => child.stderr },
      on: (ev: string, cb: (e: Error) => void) => { if (ev === 'error') errCbs.push(cb); return child; },
      kill: () => true,
    };
    queueMicrotask(() => { for (const cb of errCbs) cb(err); });
    return child;
  }) as unknown as typeof spawn;
}

/** 计 tick 的 sleep：第 4 次即抛（若"一死即返"失效，这里**当场红**，而不是挂死整个套件）。 */
function mkCountingSleep(state: { n: number }): () => Promise<void> {
  return async (): Promise<void> => {
    state.n++;
    if (state.n > 3) throw new Error('未在子进程退出后立即返回（疑似仍在等满窗口）');
  };
}

const LOCAL = 'http://localhost:27183';

async function main(): Promise<void> {
  // ═══ M21-① 端口单源 ═══════════════════════════════════════════════════════
  console.log('\n【M21-①】端口单源（管子·度量衡一处——改端口只改一处）');
  {
    crit('M21', ANS_DEFAULT_PORT !== 3001,
      'M21-1a 默认端口已离 `3001`（Node/框架最常撞口——商业化"快速上手"第一跳就卡在这）', `port=${ANS_DEFAULT_PORT}`);
    crit('M21', ANS_DEFAULT_PORT > 1024 && ANS_DEFAULT_PORT < 32768,
      'M21-1b 端口在特权口之上、Linux 临时端口起点(32768)之下（不与内核随机分配的临时口相撞）', `port=${ANS_DEFAULT_PORT}`);

    const DEF = 'packages/shared-types/src/ans-defaults.ts';
    const defTxt = RD(DEF);
    eq((defTxt.match(/ANS_DEFAULT_BASE_URL\s*=/g) ?? []).length, 1,
      'M21-1c ★地址真源在 shared-types **只定义一次**（多一份 ⇒ "改端口只改一处"当场作废）');
    crit('M21', defTxt.includes('`http://${ANS_DEFAULT_HOST}:${ANS_DEFAULT_PORT}`'),
      'M21-1d ★整串由 host+port **派生**（真源文件自身也不手写 `localhost:27183` 整串）');
    eq(ANS_DEFAULT_BASE_URL, `http://${ANS_DEFAULT_HOST}:${ANS_DEFAULT_PORT}`,
      'M21-1e 导出值与 host+port 一致（判据用**派生值**当针，不写死整串）');

    // 消费方一/二：src/main 两处（改端口必失配的旧病根）
    const SIGNED = `${A}/src/main/core/ans-signed-request.ts`;
    const POOL = `${A}/src/main/core/mcp-client-pool.ts`;
    crit('M21', /from '@worker-ant\/shared-types'/.test(RD(SIGNED)) && /url:\s*ANS_DEFAULT_BASE_URL/.test(RD(SIGNED)),
      'M21-1f 消费方一 `ans-signed-request.ts` 缺省 url 由真源**派生**（原为手写整串）');
    crit('M21', /from '@worker-ant\/shared-types'/.test(RD(POOL)) && /\$\{ANS_DEFAULT_BASE_URL\}\/mcp\//.test(RD(POOL)),
      'M21-1g 消费方二 `mcp-client-pool.ts` 兜底模板由真源**派生**（原为 `http://localhost:3001/mcp/…`）');

    // 消费方三：renderer（词表**第二落点**——不直引 shared-types，经 IPC 过桥）
    const SET = `${A}/renderer/src/pages/SettingsPage.tsx`;
    const AKP = `${A}/renderer/src/pages/ApiKeysPage.tsx`;
    crit('M21', RD(SET).includes(ANS_DEFAULT_BASE_URL) && /ansApi\.defaults\(\)/.test(RD(SET)),
      'M21-1h 消费方三·设置页：地址缺省走 `ans:defaults` IPC，且文案里的整串**与真源同值**（第二落点）');
    crit('M21', RD(AKP).includes(ANS_DEFAULT_BASE_URL) && /ansApi\.defaults\(\)/.test(RD(AKP)),
      'M21-1i 消费方三·密钥页：curl 示例同法取真源（不再手抄 `localhost:3001`）');
    crit('M21', !/from '@worker-ant\/shared-types'/.test(RD(SET)) && !/from '@worker-ant\/shared-types'/.test(RD(AKP)),
      'M21-1j 反证：renderer **不直引** shared-types（无该 workspace 依赖，直引会跛——故必须过桥）');

    // 零处残留：src/main 内不得再手写 **任一** 形态的 ANS 地址整串
    const mainFiles = walkTs(path.join(root, A, 'src/main'));
    const bad3001 = mainFiles.filter((f) => RD(path.relative(root, f)).includes("'http://localhost:3001'"));
    eq(bad3001.map((f) => path.relative(root, f)).sort(), [],
      'M21-1k ★`src/main` 内**零** `\'http://localhost:3001\'` 整串字面量（残留第二份 ⇒ 改端口必失配）');
    const bad27183 = mainFiles.filter((f) => RD(path.relative(root, f)).includes("'http://localhost:27183'"));
    eq(bad27183.map((f) => path.relative(root, f)).sort(), [],
      'M21-1l ★`src/main` 内**零** `\'http://localhost:27183\'` 手写整串（真源派生 ⇒ 谁都不许再抄一份）');

    // IPC 过桥（ans.ipc.ts）
    const ipc = RD(`${A}/src/main/ipc/ans.ipc.ts`);
    crit('M21', /ANS_DEFAULT_BASE_URL/.test(ipc) && ipc.includes("'ans:defaults'"),
      'M21-1m `ans:defaults` IPC 由真源过桥（renderer 取值的唯一来路）');
    crit('M21', ["'ans:status'", "'ans:start'", "'ans:stop'"].every((c) => ipc.includes(c)),
      'M21-1n 托管三通道在册（status/start/stop——渲染层据此显示与动作）');
  }

  // ═══ M21-② 绑定失败如实 ═══════════════════════════════════════════════════
  console.log('\n【M21-②】绑定失败如实（毛选·不打无准备之仗——绝不"假启动"）');
  {
    const IDX = 'apps/ans-server/src/index.ts';
    const idx = RD(IDX);
    crit('M21', /import\s*\{[^}]*ANS_DEFAULT_PORT[^}]*\}\s*from\s*'@worker-ant\/shared-types'/.test(idx),
      'M21-2a ans-server 端口真源**静态导入**（非手写常量）');
    crit('M21', /ANS_SERVER_PORT\s*\?\?\s*ANS_DEFAULT_PORT/.test(idx),
      'M21-2b ★端口单源：`ANS_SERVER_PORT` 仅作显式**逃生口**，缺省即真源');
    crit('M21', /\.raw\b/.test(idx) && /await\s+ansSrv\?\.ready\?\.\(\)/.test(idx),
      'M21-2c ★从 `app.listen` 回调取回 srvx Server 并 `await ready()`（真实绑定结果**在此浮现**）');
    crit('M21', /EADDRINUSE/.test(idx) && /process\.exit\(1\)/.test(idx),
      'M21-2d ★绑定失败**如实报因**（EADDRINUSE 提示改端口）+ **退非 0**');
    const exitAt = idx.indexOf('process.exit(1)');
    crit('M21', exitAt > 0 && idx.indexOf("'ANS 服务端已启动'") > exitAt,
      'M21-2e ★结构性反证："已启动"日志在如实退出分支**之后**（端口被占时**不可能**打出"已启动"——旧写法正打这句谎）');

    // M21-2f（收口补钉，E5 照出）：仓库根 `.env` 是**可选**的——干净 clone 里 `.env` 被 .gitignore
    //   排除、必然不存在，而 `loadEnvFile` 对缺失路径**直接抛 ENOENT**。旧写法顶格
    //   `loadEnvFile('../../.env')` ⇒ 干净机 `pnpm dev:ans` 必崩（第三个 E5 缺陷）。
    //   此处把修复**钉成形状**：先 `existsSync` 探在否、再决定是否加载；且守卫之外不得另有裸调用
    //   （防"守卫在、裸调用也在"两处并存——那样守卫等于没加）。
    crit('M21', /if\s*\(\s*existsSync\(\s*'\.\.\/\.\.\/\.env'\s*\)\s*\)\s*loadEnvFile\(/.test(idx),
      'M21-2f ★`.env` 加载**先判在否**（`existsSync` 守卫先于 `loadEnvFile`——否则干净 clone 无 .env 即 ENOENT 崩溃）');
    crit('M21', !/(^|[;{}])\s*loadEnvFile\(/m.test(idx),
      'M21-2f′ 无裸 `loadEnvFile(`（守卫之外不得另有调用——防"守卫在、裸调用也在"两处并存）');

    // ── 两侧标本：直跑 elysia + @elysiajs/node 的**真实绑定**语义（零原生模块依赖）──
    // 解析出各自的 ESM 产物（`exports` 的 `import` 条件）——不猜路径，经 package.json 定位。
    const req = createRequire(path.join(root, 'apps/ans-server/src/index.ts'));
    const pkgDir = (n: string) => path.dirname(req.resolve(`${n}/package.json`));
    const { Elysia } = await import(pathToFileURL(path.join(pkgDir('elysia'), 'dist/index.mjs')).href);
    const { node: nodeAdapter } = await import(pathToFileURL(path.join(pkgDir('@elysiajs/node'), 'dist/index.mjs')).href);

    // 占一个空闲端口当"另一个 ANS"。
    // ⚠ **不许**指定 host（尤其不许写 `127.0.0.1`）：`@elysiajs/node` 让 srvx 绑 `::`（全接口，双栈），
    //   而 srvx 又硬编 `reusePort: true`——若占口者只绑 `127.0.0.1`/`::1`，那是**另一个地址**，
    //   内核按 SO_REUSEPORT 放行、srvx 照绑不误（实测 `ready()` 也不报错）。唯有占口者同绑 `::`
    //   才构成真冲突——正是实测里 `net.createServer().listen(port)`（不指定 host）的形态。
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, r));
    const takenPort = (blocker.address() as net.AddressInfo).port;
    try {
      let listenThrew = false;
      let srv: { ready?: () => Promise<unknown> } | undefined;
      const app = new Elysia({ adapter: nodeAdapter() });
      try {
        app.listen(takenPort, (info: unknown) => {
          srv = (info as { raw?: { ready?: () => Promise<unknown> } } | undefined)?.raw;
        });
      } catch { listenThrew = true; }

      let readyThrew = false; let errCode = '';
      try { await srv?.ready?.(); } catch (e) { readyThrew = true; errCode = (e as NodeJS.ErrnoException)?.code ?? ''; }

      crit('M21', !listenThrew,
        'M21-2f 两侧标本·一侧：端口被占时 `app.listen` **不抛** ⇒ `try{ listen }catch` 抓不到（旧写法必"假启动"）');
      crit('M21', readyThrew && errCode === 'EADDRINUSE',
        'M21-2g 两侧标本·另一侧：`raw.ready()` **抛 EADDRINUSE** ⇒ 真实绑定结果在此浮现（M21-② 取法有效）', `code=${errCode}`);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  }

  // ═══ M21-③ 桌面托管 ═══════════════════════════════════════════════════════
  console.log('\n【M21-③】桌面托管（K-11——只拉本地的 / 只杀自己拉起的 / 拉不起就如实说）');
  {
    // ── isLocalUrl：两侧标本（本机三形态 true；远端 / LAN / 非 URL false）──
    const local = ['http://localhost:27183', 'http://127.0.0.1:27183', 'http://[::1]:3001'];
    const remote = ['https://ans.example.com', 'http://10.0.0.5:27183', 'http://192.168.1.5:3001', 'not a url', ''];
    eq(local.map(isLocalUrl), local.map(() => true), 'M21-3a `isLocalUrl` 认全本机三形态（localhost / 127.0.0.1 / [::1]）');
    eq(remote.map(isLocalUrl), remote.map(() => false),
      'M21-3b ★`isLocalUrl` 判**远端**为 false（含 LAN IP `10.0.0.5`——探到的是别的机器，绝不代起）');

    // ── probeAns：两侧标本（有响应即"进程在"；无响应/超时即 false）──
    eq(await probeAns(LOCAL, { fetchImpl: mkFetch(200) }), true, 'M21-3c `probeAns` 200 ⇒ true');
    eq(await probeAns(LOCAL, { fetchImpl: mkFetch(401) }), true, 'M21-3d `probeAns` 401 ⇒ true（服务在跑、只是未认证）');
    eq(await probeAns(LOCAL, { fetchImpl: mkFetch(404) }), true, 'M21-3e `probeAns` 404 ⇒ true（服务在跑、只是无此路由）');
    eq(await probeAns(LOCAL, { fetchImpl: refusedFetch }), false, 'M21-3f `probeAns` 连接被拒 ⇒ false（"没起"）');
    eq(await probeAns(LOCAL, { timeoutMs: 10, fetchImpl: hangingFetch }), false, 'M21-3g `probeAns` 挂起超时 ⇒ false（有界，不无限等）');

    // ── resolveAnsLaunchCommand：dev 有据 / 打包如实无入口 ──
    const dev = resolveAnsLaunchCommand({ isDev: true, repoRoot: root, port: 27183, nodeExec: 'my-node' });
    crit('M21', dev !== null && dev.cmd === 'my-node', 'M21-3h dev 模式解析出启动命令（node 可执行可覆盖）');
    // zx_20261006 M4 **重钉**（原判据是假绿，非放宽）：原字面 `args[0].endsWith('node_modules/.bin/tsx')`，
    //   而断言名却写「指向**真入口**」——`.bin/tsx` 是 **sh 垫片**（首行 `#!/bin/sh`），`node <它>` 必
    //   `SyntaxError`；且八个 `ensureAnsStarted` 用例全注入 `spawnImpl`，那条真命令**从未被执行**。
    //   改钉**更强真源**：交给 node 的那个文件必须**存在**且**能被 node 解析**（`node --check`）——
    //   这一条与实现细节无关，且直接杀死"垫片充入口"这一病。
    const tsxCli = dev?.args[0] ?? '';
    const parseableByNode = tsxCli !== '' && fs.existsSync(tsxCli) && (() => {
      try { execFileSync(process.execPath, ['--check', tsxCli], { stdio: 'ignore' }); return true; }
      catch { return false; }
    })();
    crit('M21', !!dev && dev.args[1] === path.join(root, 'apps/ans-server/src/index.ts') && dev.cwd === root
      && dev.env.ANS_SERVER_PORT === '27183' && parseableByNode,
      'M21-3i ★dev 命令指向**真入口**：交给 node 的文件**可被 node 解析**（`node --check`）——以系统 node 跑 tsx（绝不用 Electron 的 execPath——原生模块 ABI 不符必崩）',
      `tsx=${path.basename(tsxCli)}`);
    crit('M21', tsxCli !== '' && !tsxCli.includes(path.join('node_modules', '.bin')),
      'M21-3i′ ★反证：命令**不再**指向 `node_modules/.bin`（那里是 sh 垫片，`node <它>` 必 SyntaxError）');
    crit('M21', (resolveTsxCli(root) ?? '').endsWith(path.join('dist', 'cli.mjs')),
      'M21-3i″ `resolveTsxCli` 取的是包内 `dist/cli.mjs`（真 JS 入口），非幻影 bin',
      resolveTsxCli(root) ?? '(null)');
    eq(resolveAnsLaunchCommand({ isDev: true, repoRoot: '' }), null, 'M21-3j dev 但无 repoRoot ⇒ null（无从拉起）');
    eq(resolveAnsLaunchCommand({ isDev: false, repoRoot: root }), null,
      'M21-3k ★打包版 ⇒ null（首版未随包提供 ANS 入口 ⇒ 如实 `no-entry`，**不假装托管**）');

    // ── findRepoRoot：仓库根**一处真源**（两侧标本）──
    // zx_20261006 M3：此前 `main/index.ts` 手写四级、`ipc/ans.ipc.ts` 干脆没传（层级不同）⇒ 手点恒 no-entry。
    eq(findRepoRoot(path.join(root, A, 'src', 'main')), root,
      'M21-3k′ `findRepoRoot` 自任意子目录**上溯**到含 `pnpm-workspace.yaml` 的仓库根');
    eq(findRepoRoot(path.join(root, A, 'src', 'main', 'ipc')), root,
      'M21-3k″ ★多一层 `ipc/` 也得上溯到**同一个根**（旧实现正是按固定层级硬算 ⇒ 少传一层就分家）');
    eq(findRepoRoot(path.parse(root).root), null,
      'M21-3k‴ 反证：上溯不到标志文件 ⇒ `null`（打包版 asar 内即此形态 ⇒ 如实回 `no-entry`，不自造路径）');

    // ── ensureAnsStarted：逐因穷举七态 ──
    // (1) reachable：探到即返回，**不起进程**
    const sp1: SpawnSpy = { calls: 0, killed: [] };
    const r1 = await ensureAnsStarted({ baseUrl: LOCAL }, { autoStart: true, fetchImpl: mkFetch(200), spawnImpl: mkSpawn(sp1) });
    eq([r1.started, r1.reachable, r1.reason], [false, true, 'reachable'], 'M21-3l 已达 ⇒ `reachable`（不起进程）');
    eq(sp1.calls, 0, 'M21-3m ★该起的不漏、不该起的不起：探到可达时 spawn **零调用**');

    // (2) disabled（设置关）
    const sp2: SpawnSpy = { calls: 0, killed: [] };
    const r2 = await ensureAnsStarted({ baseUrl: LOCAL }, { autoStart: false, isDev: true, repoRoot: root, fetchImpl: refusedFetch, spawnImpl: mkSpawn(sp2) });
    eq([r2.started, r2.reachable, r2.reason], [false, false, 'disabled'], 'M21-3n 开关关 ⇒ `disabled`（不可达也不起）');
    eq(sp2.calls, 0, 'M21-3o `disabled` 时 spawn 零调用');

    // (3) disabled（env 全局急停）
    const prevKill = process.env.WA_ANS_AUTOSTART;
    process.env.WA_ANS_AUTOSTART = '0';
    try {
      const sp3: SpawnSpy = { calls: 0, killed: [] };
      const r3 = await ensureAnsStarted({ baseUrl: LOCAL }, { isDev: true, repoRoot: root, fetchImpl: refusedFetch, spawnImpl: mkSpawn(sp3) });
      eq([r3.started, r3.reachable, r3.reason], [false, false, 'disabled'],
        'M21-3p ★`WA_ANS_AUTOSTART=0` 全局急停生效（rr/CI 防回归期误拉真进程）');
      eq(sp3.calls, 0, 'M21-3q 急停时 spawn 零调用');
    } finally {
      if (prevKill === undefined) delete process.env.WA_ANS_AUTOSTART; else process.env.WA_ANS_AUTOSTART = prevKill;
    }

    // (4) remote
    const sp4: SpawnSpy = { calls: 0, killed: [] };
    const r4 = await ensureAnsStarted({ baseUrl: 'http://10.0.0.5:27183' }, { autoStart: true, isDev: true, repoRoot: root, fetchImpl: refusedFetch, spawnImpl: mkSpawn(sp4) });
    eq([r4.started, r4.reachable, r4.reason], [false, false, 'remote'], 'M21-3r 远端不可达 ⇒ `remote`（**绝不**代起本地进程）');
    eq(sp4.calls, 0, 'M21-3s ★远端时 spawn 零调用（用户把 ANS 配到别处，本机不该擅自起一个）');

    // (5) no-entry
    const sp5: SpawnSpy = { calls: 0, killed: [] };
    const r5 = await ensureAnsStarted({ baseUrl: LOCAL }, { autoStart: true, isDev: false, repoRoot: root, fetchImpl: refusedFetch, spawnImpl: mkSpawn(sp5) });
    eq([r5.started, r5.reachable, r5.reason], [false, false, 'no-entry'], 'M21-3t 打包版无入口 ⇒ `no-entry`（如实告知，不假装托管）');
    eq(sp5.calls, 0, 'M21-3u `no-entry` 时 spawn 零调用');

    // 至此**从未**成功拉起 ⇒ `stopManagedAns` 必须如实回 false（"只杀自己拉起的"）
    eq(stopManagedAns(), false, 'M21-3v ★`stopManagedAns` 无托管子进程时 ⇒ false（**不动**用户自配的服务）');
    eq(ansSupervisorState().managed, false, 'M21-3w 托管状态如实为 `managed:false`');

    // (6) started：先不可达、拉起后可达
    let probeN = 0;
    const flipFetch = (async () => { probeN++; if (probeN === 1) throw new Error('ECONNREFUSED'); return { ok: true, status: 200 }; }) as unknown as AnyFetch;
    const sp6: SpawnSpy = { calls: 0, killed: [] };
    const r6 = await ensureAnsStarted({ baseUrl: LOCAL }, {
      autoStart: true, isDev: true, repoRoot: root, fetchImpl: flipFetch, spawnImpl: mkSpawn(sp6, 7777), sleepImpl: noSleep,
    });
    eq([r6.started, r6.reachable, r6.reason], [true, true, 'started'], 'M21-3x 拉起后可达 ⇒ `started`/`reachable`（有界等待内探到）');
    eq(sp6.calls, 1, 'M21-3y 恰好拉起一次（不重复起）');
    const st = ansSupervisorState();
    eq([st.managed, st.pid, st.reason], [true, 7777, 'started'], 'M21-3z 托管现状如实上屏（managed / 子进程 pid / 最近判断因）');

    // 回收：只杀自己拉起的那一个
    eq(stopManagedAns(), true, 'M21-3aa 回收本进程拉起的 ANS ⇒ true');
    eq(sp6.killed, ['SIGTERM'], 'M21-3ab 发给子进程的是 SIGTERM（优雅退出，非 SIGKILL）');
    eq(ansSupervisorState().managed, false, 'M21-3ac 回收后托管状态归零');
    eq(stopManagedAns(), false, 'M21-3ad 二次回收 ⇒ false（无子进程可杀）');

    // (7) start-timeout：拉起成功但等待窗口内始终不可达（`readyTimeoutMs=0` ⇒ 立刻到期，不真等）
    const sp7: SpawnSpy = { calls: 0, killed: [] };
    const r7 = await ensureAnsStarted({ baseUrl: LOCAL }, {
      autoStart: true, isDev: true, repoRoot: root, fetchImpl: refusedFetch, spawnImpl: mkSpawn(sp7), readyTimeoutMs: 0, sleepImpl: noSleep,
    });
    eq([r7.started, r7.reachable, r7.reason], [true, false, 'start-timeout'],
      'M21-3ae 起了但超时仍不可达 ⇒ `start-timeout`（**有界**等待，绝不无限等）');
    stopManagedAns(); // 清理该子进程，避免干扰后续用例

    // (8) spawn-failed：拉起本身失败
    const sp8: SpawnSpy = { calls: 0, killed: [] };
    const r8 = await ensureAnsStarted({ baseUrl: LOCAL }, {
      autoStart: true, isDev: true, repoRoot: root, fetchImpl: refusedFetch, spawnImpl: mkSpawn(sp8, 0, new Error('EACCES: 权限不足')),
    });
    eq([r8.started, r8.reachable, r8.reason], [false, false, 'spawn-failed'], 'M21-3af 拉起失败 ⇒ `spawn-failed`（如实回因，不静默）');

    // (9) native-abi-mismatch：**启动即死**，且遗言点名 ABI 不符（zx_20261006 M2 新增态）
    const abiState = { n: 0 };
    const spAbi: SpawnSpy = { calls: 0, killed: [] };
    const ABI_MSG = "Error: The module '...better_sqlite3.node' was compiled against a different Node.js "
      + 'version using NODE_MODULE_VERSION 130. This version of Node.js requires NODE_MODULE_VERSION 127.';
    const rAbi = await ensureAnsStarted({ baseUrl: LOCAL }, {
      autoStart: true, isDev: true, repoRoot: root, fetchImpl: refusedFetch,
      spawnImpl: mkDeadSpawn(spAbi, ABI_MSG), readyTimeoutMs: 60_000, sleepImpl: mkCountingSleep(abiState),
    });
    eq([rAbi.started, rAbi.reachable, rAbi.reason], [true, false, 'native-abi-mismatch'],
      'M21-3ag ★子进程启动即死于 **ABI 不符** ⇒ 如实回 `native-abi-mismatch`（**不再**静默拖成 `start-timeout`）');
    eq(abiState.n, 1, 'M21-3ah ★**一死即返**：只睡 1 个 tick 就返回（`readyTimeoutMs` 是 60s ⇒ 未等满窗口）');
    crit('M21', /NODE_MODULE_VERSION/.test(rAbi.stderrTail ?? ''),
      'M21-3ai ★遗言随结果回（stderr 尾＝成因**证据**，而非一句无据的"未就绪"）');

    // (10) child-exited：同样启动即死，但遗言与 ABI 无关 ⇒ 与上一态**分家**
    const deadState = { n: 0 };
    const spDead: SpawnSpy = { calls: 0, killed: [] };
    const rDead = await ensureAnsStarted({ baseUrl: LOCAL }, {
      autoStart: true, isDev: true, repoRoot: root, fetchImpl: refusedFetch,
      spawnImpl: mkDeadSpawn(spDead, 'Error: 某个与 ABI 无关的致命错误'), readyTimeoutMs: 60_000, sleepImpl: mkCountingSleep(deadState),
    });
    eq([rDead.started, rDead.reachable, rDead.reason], [true, false, 'child-exited'],
      'M21-3aj ★非 ABI 的启动即死 ⇒ `child-exited`（与 `native-abi-mismatch` 两侧分家，不混为一谈）');
    eq(deadState.n, 1, 'M21-3ak 同上：一死即返');
    eq(ansSupervisorState().managed, false,
      'M21-3al 子进程已退出 ⇒ 托管态**如实归零**（不留一个已死的"托管中"假象）');

    // (11) native-abi-mismatch 的**第二形态**（zx_20261009 M5）：秒退 ∧ stderr 全空。
    //   实测里原生模块 ABI 不符常表现为进程**加载即被信号杀掉**、来不及写一字遗言 ⇒ 只认文本的旧实现
    //   把它降级成笼统的 `child-exited`（用户拿不到"先跑 pnpm dev:ans"那条自救提示）。此处逼它仍归 ABI 疑似。
    const silentState = { n: 0 };
    const spSilent: SpawnSpy = { calls: 0, killed: [] };
    const rSilent = await ensureAnsStarted({ baseUrl: LOCAL }, {
      autoStart: true, isDev: true, repoRoot: root, fetchImpl: refusedFetch,
      spawnImpl: mkDeadSpawn(spSilent, ''), readyTimeoutMs: 60_000, sleepImpl: mkCountingSleep(silentState),
    });
    eq([rSilent.started, rSilent.reachable, rSilent.reason], [true, false, 'native-abi-mismatch'],
      'M5-1 ★秒退且 **stderr 全空** ⇒ 亦归 `native-abi-mismatch`（旧实现只认遗言文本 ⇒ 降级成 `child-exited`）');
    eq(silentState.n, 1, 'M5-2 同上：一死即返（秒退不被拖成 `start-timeout`）');
    eq((rSilent.stderrTail ?? ''), '', 'M5-3 如实回空遗言（不编造"证据"；归因是形态学的，与遗言两回事）');

    // (11b) zx_20261024_4 追补：`ansStartInFlight()` —— 首启判据"此刻有没有人在拉"的**唯一读出**。
    //   病根：打包版首启渲染层与异步代起并发，模型探针跑到 ANS 监听之前 ⇒ fail-open 放行真新用户。
    //   `core/ans-start-grace.ts` 据此有界等待；须真做到"进同步段即为真、全部收场才为假"。
    {
      let release1!: () => void;
      const gate1 = new Promise<void>((r) => { release1 = r; });
      const gatedFetch1 = (async () => { await gate1; throw new Error('ECONNREFUSED'); }) as unknown as AnyFetch;
      let release2!: () => void;
      const gate2 = new Promise<void>((r) => { release2 = r; });
      const gatedFetch2 = (async () => { await gate2; throw new Error('ECONNREFUSED'); }) as unknown as AnyFetch;

      eq(ansStartInFlight(), false, 'M21-3ax 静默态 ⇒ 无代起在拉（基线 0）');
      // `autoStart:false` ⇒ 探针一失败即回 `disabled`，不 spawn。
      const p1 = ensureAnsStarted({ baseUrl: LOCAL }, { autoStart: false, fetchImpl: gatedFetch1 });
      eq(ansStartInFlight(), true, 'M21-3ay ★一进同步段即为真（渲染层此刻问，能如实读到"有人在拉"）');
      const p2 = ensureAnsStarted({ baseUrl: LOCAL }, { autoStart: false, fetchImpl: gatedFetch2 });
      release1();
      await p1;
      eq(ansStartInFlight(), true, 'M21-3az ★计数语义：一次已收场、另一次仍在拉 ⇒ 仍为真（不被先收场的清掉）');
      release2();
      await p2;
      eq(ansStartInFlight(), false, 'M21-3ba 全部收场 ⇒ 归零（有界等待据此交棒）');
      // 反证：失败/未开启的收场也要归零（不是"只在成功路径清"）。
      await ensureAnsStarted({ baseUrl: LOCAL }, { autoStart: false, fetchImpl: refusedFetch });
      eq(ansStartInFlight(), false, 'M21-3bb 反证：`disabled` 收场后同样归零（finally 语义，两条出口一致）');
    }

    // (12) M5 桌面侧「说得清」：401（未认证）/ 读失败 / 真无模型 **三分**（病：把没认证说成没配模型）
    //   zx_20261010 M3 扩参后同钉（签名 `{models}` → `{catalog, available, hasChat, hasEmbedding}`）。
    const authLine = probeModelsLine({ read: 'auth', note: 'ANS request failed (401): {"error":{"code":"UNAUTHORIZED"}}', catalog: 0, available: 0, hasChat: false, hasEmbedding: false });
    eq([authLine.ok, /未认证/.test(authLine.text) && !/尚无可用模型/.test(authLine.text)], [false, true],
      'M5-4 ★401（未认证）⇒ 说"未认此凭据"，**不**降级成"尚无可用模型"（名实不符即此病）');
    const errLine = probeModelsLine({ read: 'error', note: 'boom', catalog: 0, available: 0, hasChat: false, hasEmbedding: false });
    eq([errLine.ok, /读取模型列表失败/.test(errLine.text) && /boom/.test(errLine.text)], [false, true],
      'M5-5 可达但读不动（非 401）⇒ 说"读失败"并带原因，亦不冒充"无模型"');
    const zeroLine = probeModelsLine({ read: 'ok', note: '', catalog: 0, available: 0, hasChat: false, hasEmbedding: false });
    eq([zeroLine.ok, /尚无可用模型/.test(zeroLine.text)], [false, true],
      'M5-6 ★确读得到且 0 个 ⇒ **才**说"请在 ANS 配置模型"（三个 read 态就此分家）');
    const okLine = probeModelsLine({ read: 'ok', note: '', catalog: 3, available: 3, hasChat: true, hasEmbedding: false });
    eq([okLine.ok, /已接入 3 个可用模型/.test(okLine.text) && /chat 已就位/.test(okLine.text)], [true, true],
      'M5-7 可用>0 且含 chat ⇒ 绿且明写 chat 就位（正面标本：三分之外的那一路仍在）');

    // (12b) zx_20261010 M3：**目录条数 ≢ 可用条数**——干净 ANS 目录 41、零端点，旧实现亮绿"已接入 41 个模型"。
    //   两只新标本：(a) 可用 0 ⇒ 不得说"已接入"；(b) 可用>0 但无 chat ⇒ 不绿但如实分列 embedding 就位。
    const catOnly = probeModelsLine({ read: 'ok', note: '', catalog: 41, available: 0, hasChat: false, hasEmbedding: false });
    eq([catOnly.ok, /已接入/.test(catOnly.text), /无一个配置了可用端点/.test(catOnly.text)], [false, false, true],
      'M5-8 ★目录 41 / 可用 0 ⇒ **不得**亮绿、**不得**说"已接入"（旧实现取 `ms.length`=41 即此名实不符）');
    const embOnly = probeModelsLine({ read: 'ok', note: '', catalog: 41, available: 5, hasChat: false, hasEmbedding: true });
    eq([embOnly.ok, /缺可用 chat 模型/.test(embOnly.text), /embedding 已就位/.test(embOnly.text)], [false, true, true],
      'M5-9 可用 5 但**无 chat** ⇒ 不绿（本页答"跑起来没有"），且分列 chat 缺 / embedding 就位两个独立前提');

    // (12c) zx_20261010 M5：向导②**就地配端点**——原先只叫"去配置"却无路可达（首启守卫把模型页弹回 ⇒ 走不通）。
    //   钉四件：走生产接口 / 带 api_key / 仅缺 chat 时出现 / 保存后重探。静态读原文（G-5）。
    const setupSrc = RD(`${A}/renderer/src/pages/SetupPage.tsx`);
    eq(/\/api\/v1\/models\/\$\{[^}]+\}\/endpoints/.test(setupSrc), true,
      'M5-10 ★向导②内嵌写端点：走生产接口 `POST /api/v1/models/:id/endpoints`（不自造接口）');
    eq(/api_key:\s*\w+/.test(setupSrc), true,
      'M5-11 写端点请求体带 `api_key`（"配 Key"须真发出去，不能只写 URL）');
    eq(/!probe\.hasChat/.test(setupSrc), true,
      'M5-12 配置区仅在 `!hasChat` 时出现（有可用 chat 就不该再让人配）');
    eq(/endpoints`[\s\S]{0,300}?runProbe\(\)/.test(setupSrc), true,
      'M5-13 保存端点后**重探**（配置生效须反映到绿灯，而非停在旧态）');

    // ── 接线（main 启动时托管 / 退出时回收 / 用户手点 `ans:start`）──
    const mi = RD(`${A}/src/main/index.ts`);
    crit('M21', /core\/ans-supervisor\.js/.test(mi) && /ensureAnsStarted\(/.test(mi),
      'M21-3am main 启动接线 `ensureAnsStarted`（不阻塞启动的异步块）');
    // M21-3an 收口改钉（zx_20261005 收口）：原判据只要求键名**在场**（`/ans_auto_start/`），
    //   而裸 `row?.value !== 'false'` 旁路同样满足 ⇒ 一个绕过 `settings-bool` 单源的读法也能过。
    //   收口全量回归由 `rr_zx_20260910_3_b3` S4 照出（index.ts 有裸 `!== 'false'`）。
    //   现钉「**经单源读**」（`readBoolSetting(… 'ans_auto_start')`）——键名在场 + 走同一判据，两件同钉。
    crit('M21', /readBoolSetting\([^)]*'ans_auto_start'/.test(mi),
      'M21-3an 应用层开关 `ans_auto_start` **经 settings-bool 单源读取**（不得用裸 `!== \'false\'` 旁路）');
    // 改钉更强载体（v0.2.1 退出修复）：退出路径改用 `stopManagedAnsAndWait()`——它才是"退出时
    //   真正把托管 ANS 收干净"的那个（SIGTERM 收不掉会在宽限期后补 SIGKILL）。
    crit('M21', /await stopManagedAnsAndWait\(\)/.test(mi), 'M21-3ao 退出接线 `await stopManagedAnsAndWait()`（回收本机托管的 ANS 并等它真的走）');
    crit('M21', /isDev/.test(mi) && /repoRoot/.test(mi),
      'M21-3ap 传入 `isDev`/`repoRoot`（打包版据此如实回 `no-entry`）');

    // zx_20261006 M3：**用户手点**那条路（`ipc/ans.ipc.ts`）原先两个参数都没传 ⇒ 恒 `no-entry`。
    const aipc = RD(`${A}/src/main/ipc/ans.ipc.ts`);
    crit('M21', /ensureAnsStarted\(\s*creds\s*,\s*\{[^}]*\bisDev\b[^}]*\brepoRoot\b[^}]*\}/.test(aipc),
      'M21-3aq ★`ans:start` 的调用**带** `isDev`/`repoRoot`（原实现裸传 `creds` ⇒ 用户手点「一键拉起」**恒** `no-entry`）');
    crit('M21', !/ensureAnsStarted\(\s*creds\s*\)/.test(aipc),
      'M21-3ar ★反证：不再有"裸传 `creds`"的调用（那正是恒 `no-entry` 的旧形态）');

    const sup = RD(`${A}/src/main/core/ans-supervisor.ts`);
    crit('M21', !/from 'electron'/.test(sup),
      'M21-3as 反证：`ans-supervisor` **零 electron 依赖**（故本套件能直跑真实现——同上 `ans-signed-request` 范式）');
    crit('M21', /Promise\.race\(\[sleep\(/.test(sup) && /ABI_MISMATCH_RE/.test(sup),
      'M21-3at 反证：`ensureAnsStarted` 确实**监听子进程死讯**（`Promise.race` + 遗言判因），非只睡满窗口');
    crit('M21', !/stdio:\s*'ignore'/.test(sup),
      'M21-3au ★反证：不再 `stdio:\'ignore\'`——那会把子进程的遗言整个扔掉（"早死了"于是被说成"慢"）');
  }

  // ═══ M6 zx_20261010 ANS 控制台时间戳取**本地**时区 ═════════════════════════
  // 病根：`translateTime: 'HH:MM:ss'`（**无前缀**）⇒ pino-pretty 按 **UTC** 打印，本地 15:41 打成 [07:41]
  //   且**不标注时区**（读者按本地读即差 8 小时；实测 pino-pretty 13：无前缀格式串走 UTC）。
  //   桌面端 `main/core/logger.ts` 与归档前的旧 server 皆用 `SYS:` 前缀，唯 ANS 漏 ⇒ 两进程日志不可并读。
  console.log('\n【M6】ANS 控制台时间戳取本地时区（管子·度量衡：同一把尺）');
  {
    const ansLog = RD('apps/ans-server/src/utils/logger.ts');
    const deskLog = RD(`${A}/src/main/core/logger.ts`);
    ok(/translateTime:\s*'SYS:HH:MM:ss'/.test(ansLog),
      'M6-1 ★ANS 控制台时间戳取**本地**时区（`SYS:` 前缀——pino-pretty 对无前缀格式串按 UTC 输出）');
    ok(!/translateTime:\s*'HH:MM:ss'/.test(ansLog),
      "M6-2 ★反证：不再有**裸** `translateTime: 'HH:MM:ss'`（那正是打未标注 UTC 的旧形态）");
    ok(/translateTime:\s*'SYS:HH:MM:ss'/.test(deskLog),
      'M6-3 与桌面端 `main/core/logger.ts` **同一把尺**（两进程日志时刻可直接并读，不错 8 小时）');
  }

  // ═══ H1 zx_20261009「自己人」握手批 ═══════════════════════════════════════
  // 病根：发布版首启时本机 ANS 与桌面**没有共同身份**——桌面 `ans_api_key` 空、ANS 无 `ans_api_keys` 行
  //   ⇒ 桌面到 ANS 的签名请求必 401 `Invalid API key`。dev 之所以好，只因 `.env` 的 dev-key 与 ANS
  //   的 env 回退**碰巧对齐**——那是"恰好"，不是机制。
  // 治法（一处真源）：桌面**首启铸**一对"自己人"凭据落 `wa_settings`（M1）；代起本机 ANS 时随子进程
  //   env 下发 `ANS_API_KEYS=<key>:<secret>`（M2）⇒ 客户端与子进程用**同一对**。判据一律调生产导出（G-1）。
  console.log('\n【H1】「自己人」——凭据一处真源 + 代起即发凭据（道德经·善闭无关楗而不可开）');
  {
    const h1 = (cond: boolean, label: string, detail?: string): void => crit('H1', cond, label, detail);
    const h1eq = (actual: unknown, expect: unknown, label: string): void => {
      const a = JSON.stringify(actual); const e = JSON.stringify(expect);
      h1(a === e, label, `${a} vs ${e}`);
    };

    // ── M1 凭据一处真源：首启铸币（两侧标本）──────────────────────────────
    const store = new Map<string, string>();
    const fdb = {
      prepare: (_sql: string) => ({
        get: (k: unknown) => (store.has(String(k)) ? { value: store.get(String(k)) } : undefined),
        run: (k: unknown, v: unknown) => { store.set(String(k), String(v)); return {}; },
      }),
    };
    const SEQ = { n: 0 };
    const gen = (): { apiKey: string; secretKey: string } => { SEQ.n++; return { apiKey: 'wa_rr_minted', secretKey: 'rr-minted-secret' }; };

    const empty = mintLocalAnsCreds(fdb, { apiKey: '', secretKey: '' }, gen);
    h1eq([empty.minted, empty.persisted, empty.apiKey, empty.secretKey], [true, true, 'wa_rr_minted', 'rr-minted-secret'],
      'H1-1 ★标本·空：缺凭据 ⇒ **真铸**（`minted:true`）且落库成功（`persisted:true`）');
    h1eq([store.get('ans_api_key'), store.get('ans_secret_key')], ['wa_rr_minted', 'rr-minted-secret'],
      'H1-2 ★铸出的那一对**真落进 `wa_settings`**（正面断言读回同一对，非只"不抛"）');

    const keep = mintLocalAnsCreds(fdb, { apiKey: 'user-k', secretKey: 'user-s' }, gen);
    h1eq([keep.minted, keep.apiKey, keep.secretKey, SEQ.n], [false, 'user-k', 'user-s', 1],
      'H1-3 ★标本·齐备：已有凭据 ⇒ 原样返还（`minted:false`）且**生成器零调用**（绝不覆盖用户已配的身份）');
    h1eq(store.get('ans_api_key'), 'wa_rr_minted',
      'H1-4 反证：齐备标本**不动**库里的旧值（覆盖 = 把用户已配好的身份悄悄换掉）');

    // 生成器形态：与 ANS 认的那把尺**同形**（key `wa_`+base64url(32)、secret 64 hex），且两 key 相异。
    const pairA = generateCredentialPair();
    h1(/^wa_[A-Za-z0-9_-]{32}$/.test(pairA.apiKey) && /^[0-9a-f]{64}$/.test(pairA.secretKey),
      'H1-5 ★生成器形态：apiKey `wa_`+base64url(32)、secret 64 hex（ANS 侧 `verifyHmacSignature` 认的**同一把尺**）');
    h1(generateCredentialPair().apiKey !== pairA.apiKey,
      'H1-5′ 两次生成相异（常量凭据＝没有身份——"每次都同一对"等于谁都进得来）');

    // ── M2 代起即发凭据（正面 + 反面）──────────────────────────────────────
    const envSpec = (c: { apiKey?: string; secretKey?: string }): string | null =>
      ansApiKeysEnvValue({ apiKey: c.apiKey ?? '', secretKey: c.secretKey ?? '' });
    h1eq(envSpec({ apiKey: 'k', secretKey: 's' }), 'k:s', 'H1-6 `ANS_API_KEYS` 取值形态 `key:secret`（ANS env 回退按此认）');
    h1(envSpec({ apiKey: 'k' }) === null && envSpec({ secretKey: 's' }) === null && envSpec({}) === null,
      'H1-7 ★反面：缺任一半 ⇒ `null`（**宁可如实不注入，也不发半对**——半对必 401 且看不出为什么）');

    const seenEnv: Array<{ ANS_API_KEYS?: string } | undefined> = [];
    const captureSpawn = ((_c: string, _a: string[], o?: { env?: { ANS_API_KEYS?: string } }) => {
      seenEnv.push(o?.env);
      const child = { pid: 9090, on: () => child, kill: () => true };
      return child;
    }) as unknown as typeof spawn;

    const rFull = await ensureAnsStarted({ baseUrl: LOCAL, apiKey: 'wa_rr_full', secretKey: 'rr-secret' }, {
      autoStart: true, isDev: true, repoRoot: root, fetchImpl: refusedFetch, spawnImpl: captureSpawn,
      readyTimeoutMs: 0, sleepImpl: noSleep,
    });
    h1eq([rFull.started, rFull.reason], [true, 'start-timeout'], 'H1-8 正面标本：确要代起（子进程真被 spawn ⇒ `started:true`）');
    h1eq(seenEnv[0]?.ANS_API_KEYS, 'wa_rr_full:rr-secret',
      'H1-9 ★★代起**即发凭据**：子进程 env 收到 `ANS_API_KEYS=<本机同一对>`（两侧用同一对，ANS env 回退即认）');
    stopManagedAns();

    seenEnv.length = 0;
    const rHalf = await ensureAnsStarted({ baseUrl: LOCAL, apiKey: 'wa_only_key' }, {
      autoStart: true, isDev: true, repoRoot: root, fetchImpl: refusedFetch, spawnImpl: captureSpawn,
      readyTimeoutMs: 0, sleepImpl: noSleep,
    });
    h1(typeof rHalf.reason === 'string' && !String(seenEnv[0]?.ANS_API_KEYS ?? '').startsWith('wa_only_key'),
      'H1-10 ★反面标本：只给 key 半 ⇒ **不注入**（子进程 env 里绝不出现那半对）',
      String(seenEnv[0]?.ANS_API_KEYS ?? '(未设)'));
    stopManagedAns();

    // ── 接线（M1 的**顺序**即病根所系）────────────────────────────────────
    const miX = RD(`${A}/src/main/index.ts`);
    const iMint = miX.indexOf('mintLocalAnsCreds(');
    const iClient = miX.indexOf('new AnsClient(');
    h1(iMint >= 0 && iClient >= 0 && iMint < iClient,
      'H1-11 ★★铸币**先于**首个 `new AnsClient(`（先建的客户端拿空凭据 ⇒ 401 病根不除——顺序即契约）',
      `mint@${iMint} client@${iClient}`);
    h1(/isLocalUrl\(curCreds\.baseUrl\)/.test(miX) && /!ansCredentialsConfigured\(curCreds\)/.test(miX),
      'H1-12 ★两道闸：仅「尚无齐备凭据 ∧ 地址在**本机**」才铸（远端不铸——随机 key 远端不认，且会顶掉"未配置⇒向导"语义）');
  }

  // ═══ H2 zx_20261009 包内 ANS 代起（M3，路线甲）══════════════════════════════
  // 病根：打包版此前**恒** `no-entry`（`resolveAnsLaunchCommand` 首行 `if (!opts.isDev) return null`）⇒
  //   干净机器双击安装件，ANS 没起、一切模型/技能/MCP 静默失败——"点了没反应"。
  // 治法（路线甲）：ANS 运行时随包（`extraResources` → `Resources/ans-server/`），打包版用
  //   `ELECTRON_RUN_AS_NODE=1 process.execPath <entry>` 代起（Electron ABI ⇒ dev 的 ABI 互斥在包内消失）。
  console.log('\n【H2】「包内代起」——随包闭包 + ELECTRON_RUN_AS_NODE（毛选·不打无准备之仗）');
  {
    const h2 = (cond: boolean, label: string, detail?: string): void => crit('H2', cond, label, detail);
    const h2eq = (actual: unknown, expect: unknown, label: string): void => {
      const a = JSON.stringify(actual); const e = JSON.stringify(expect);
      h2(a === e, label, `${a} vs ${e}`);
    };

    // ── 行为判据（G-1 直调生产 `resolveAnsLaunchCommand`；入口用真存在的临时文件）──
    const P_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ans-pkg-'));
    const P_ENTRY = path.join(P_DIR, 'index.js');
    fs.writeFileSync(P_ENTRY, '');
    const P_CWD = path.join(P_DIR, 'ans', 'apps');
    const P_DATA = path.join(P_DIR, 'worker-ant-data');

    const pcmd = resolveAnsLaunchCommand({ isDev: false, packaged: { entry: P_ENTRY, cwd: P_CWD, workerDataDir: P_DATA }, port: 27999 });
    h2(pcmd !== null, 'H2-1 ★打包版有入口（此前 `if (!opts.isDev) return null` ⇒ 恒 `no-entry`——本轮要消的正是它）');
    h2eq(pcmd?.cmd, process.execPath, 'H2-2 入口可执行 = Electron 自身（`process.execPath`，非系统 node / 非 tsx）');
    h2eq(pcmd?.args, [P_ENTRY], 'H2-3 args 恰为「包内入口」一个（**不**沿用 dev 的 `[tsx, src/index.ts]`——包里无 tsx、无 src）');
    h2eq(pcmd?.env.ELECTRON_RUN_AS_NODE, '1',
      'H2-4 ★★`ELECTRON_RUN_AS_NODE=1`——缺它则 Electron 按 GUI 起来、根本不当 node 跑脚本');
    h2eq(pcmd?.env.ANS_SERVER_PORT, '27999', 'H2-5 端口随 env 下发（`ANS_SERVER_PORT` 逃生口）');
    h2eq(pcmd?.env.WORKER_ANT_DATA_DIR, P_DATA,
      'H2-6 `WORKER_ANT_DATA_DIR` **显式**给（plugin-marketplace 的 DATA_ROOT 上溯**三级**、与 cwd 的两级约定**不同源**）');
    h2eq(pcmd?.cwd, P_CWD, 'H2-7 `cwd` = 数据根上溯**两级**处（schema DATA_DIR / logger LOG_DIR / plugin INSTALL_DIR 同一约定）');

    h2eq(resolveAnsLaunchCommand({ packaged: { entry: P_ENTRY, cwd: P_CWD, electronExec: '/tmp/rr-fake-electron' } })?.cmd,
      '/tmp/rr-fake-electron', 'H2-8 `electronExec` 可注入（测试 / 自定义环境）');

    h2eq(resolveAnsLaunchCommand({ packaged: { entry: path.join(P_DIR, 'nope.js'), cwd: P_CWD } }), null,
      'H2-9 ★反证：包内入口**不存在** ⇒ `null`（如实回 `no-entry`，不假装托管——M21 的诚实回退仍在）');

    h2(resolveAnsLaunchCommand({ isDev: true, repoRoot: root, packaged: { entry: P_ENTRY, cwd: P_CWD } })?.env.ELECTRON_RUN_AS_NODE === '1',
      'H2-10 ★packaged 分支**优先于** dev（打包版绝不误走 `resolveTsxCli`）');
    h2eq(resolveAnsLaunchCommand({ isDev: false, repoRoot: root }), null,
      'H2-11 反证：`isDev:false` 且**无** packaged ⇒ `null`（不凭空拼一条注定跑不起来的命令）');

    // ── 打包分支同样「代起即发凭据」（M2 的一处注入对两分支都生效）──────────
    const seenPkg: Array<{ ANS_API_KEYS?: string; ELECTRON_RUN_AS_NODE?: string } | undefined> = [];
    const capturePkg = ((_c: string, _a: string[], o?: { env?: { ANS_API_KEYS?: string; ELECTRON_RUN_AS_NODE?: string } }) => {
      seenPkg.push(o?.env);
      const child = { pid: 9191, on: () => child, kill: () => true };
      return child;
    }) as unknown as typeof spawn;
    const rPkg = await ensureAnsStarted({ baseUrl: LOCAL, apiKey: 'wa_pkg', secretKey: 'pkg-secret' }, {
      autoStart: true, isDev: false, packaged: { entry: P_ENTRY, cwd: P_CWD },
      fetchImpl: refusedFetch, spawnImpl: capturePkg, readyTimeoutMs: 0, sleepImpl: noSleep,
    });
    h2eq([rPkg.started, seenPkg[0]?.ANS_API_KEYS, seenPkg[0]?.ELECTRON_RUN_AS_NODE], [true, 'wa_pkg:pkg-secret', '1'],
      'H2-12 ★★打包版代起：**既**带 `ELECTRON_RUN_AS_NODE` **又**发凭据（M2 注入在打包分支同样成立）');
    stopManagedAns();

    // ── 首启目录自建 + 异步 error 不泄漏 ────────────────────────────────────
    //  实测（0.2.1 候选包首启）：`<userData>/ans/apps` 尚不存在，spawn 以 ENOENT 失败；
    //  旧实现无 `error` 监听 ⇒ 进程级未捕获异常，ANS 永远代起不来。
    const E_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ans-err-'));
    const E_ENTRY = path.join(E_DIR, 'index.js');
    fs.writeFileSync(E_ENTRY, '');
    const E_CWD = path.join(E_DIR, 'ans', 'apps'); // 刻意**不**预先创建

    // (a) cwd 由代起侧建好（正常启动路径的前提）
    const dirState = { n: 0 };
    await ensureAnsStarted({ baseUrl: LOCAL }, {
      autoStart: true, isDev: false, packaged: { entry: E_ENTRY, cwd: E_CWD },
      fetchImpl: refusedFetch, spawnImpl: mkSpawn({ calls: 0, killed: [] }), readyTimeoutMs: 0, sleepImpl: noSleep,
    });
    h2(fs.existsSync(E_CWD), 'H2-21 ★代起前自建 `cwd`（首启时 `<userData>/ans/apps` 不存在，不建则 spawn ENOENT）');
    stopManagedAns();

    // (b) 异步 error 如实归 `spawn-failed`，且 `started:false`（进程从未起来）
    const errSpy: SpawnSpy = { calls: 0, killed: [] };
    const rErr = await ensureAnsStarted({ baseUrl: LOCAL }, {
      autoStart: true, isDev: false, packaged: { entry: E_ENTRY, cwd: E_CWD },
      fetchImpl: refusedFetch, spawnImpl: mkErrorSpawn(errSpy, new Error('spawn ENOENT')),
      readyTimeoutMs: 60_000, sleepImpl: mkCountingSleep(dirState),
    });
    h2eq([rErr.started, rErr.reachable, rErr.reason], [false, false, 'spawn-failed'],
      'H2-22 ★★spawn 异步 `error` ⇒ `spawn-failed` 且 `started:false`（此前：未捕获异常 + 空等成 start-timeout）');
    h2(/spawn error: spawn ENOENT/.test(rErr.stderrTail ?? ''), 'H2-23 失败原因随结果回（`stderrTail` 为据）');

    const sup = RD(`${A}/src/main/core/ans-supervisor.ts`);
    h2(/child\.on\('error'/.test(sup) && /mkdirSync\(cmd\.cwd/.test(sup),
      'H2-24 静态接线：`error` 监听与 `cwd` 自建都在生产函数里（不是只在替身里的自我印证）');

    fs.rmSync(E_DIR, { recursive: true, force: true });

    // ── 静态接线（接口一致性：算出路径 == 随包落点，改一处必弄红）────────────
    const mi = RD(`${A}/src/main/index.ts`);
    h2(/process\.resourcesPath/.test(mi) && /app\.isPackaged/.test(mi) && /findRepoRoot\(__dirname\)/.test(mi),
      'H2-13 接线：`main/index.ts` 以 `process.resourcesPath` 定位包内入口，且 `app.isPackaged` 把关（dev 仍走 tsx 路）');
    h2(/path\.join\(process\.resourcesPath,\s*'ans-server',\s*'dist',\s*'index\.js'\)/.test(mi),
      'H2-14 ★★入口路径一致性：`Resources/ans-server/dist/index.js` 与 electron-builder 的 `to: ans-server` **同源**（改一处即弄红）');

    const yml = RD(`${A}/electron-builder.yml`);
    h2(/extraResources:/.test(yml) && /from:\s*ans-runtime/.test(yml) && /to:\s*ans-server/.test(yml),
      'H2-15 ★随包：`electron-builder.yml` 的 `extraResources` 把 `ans-runtime` 带到 `Resources/ans-server`');

    const pkg = JSON.parse(RD(`${A}/package.json`)) as { scripts?: Record<string, string> };
    h2(/stage:ans/.test(pkg.scripts?.pack ?? '') && /stage:ans/.test(pkg.scripts?.dist ?? ''),
      'H2-16 ★打包前一跳：`pack`/`dist` 先跑 `stage:ans`（否则 extraResources 的 `from` 目录不存在 ⇒ 随包**落空**）');
    h2eq(pkg.scripts?.['stage:ans'], 'node ../../scripts/stage-ans-runtime.mjs', 'H2-17 `stage:ans` 指向随包脚本（一处真源）');

    const stg = RD('scripts/stage-ans-runtime.mjs');
    h2(/deploy/.test(stg) && /--prod/.test(stg),
      'H2-18 随包脚本走 `pnpm deploy --prod` 生成依赖闭包（ANS 产物仍 external 依赖 elysia/pino/zod，只带 index.js 起不来）');
    h2(/src\/data/.test(stg) && /dist\/data/.test(stg),
      'H2-19 ★补 `dist/data ← src/data`（漏则包内 ANS **真**无模型——把 M5 要治的"假无模型"变成"真无模型"）');
    h2(/electron-rebuild/.test(stg) && /nlink/.test(stg),
      'H2-20 ★闭包内 electron-rebuild 成 Electron ABI，且**先验** link count=1（硬链就地重编会污染全局 store）');

    fs.rmSync(P_DIR, { recursive: true, force: true });
  }

  // ═══ S 哑雷自检 + build 钉 ═════════════════════════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量；**不受批次门管辖**）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 ★方向性自指（由载体自身派生，非抄来的常量）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}_ans.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}_ans.ts`);

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261005_ans 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261005_ans: ${pass} 通过 / ${fail} 失败${pending ? ` / ${pending} 待实施(不计入)` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
});
