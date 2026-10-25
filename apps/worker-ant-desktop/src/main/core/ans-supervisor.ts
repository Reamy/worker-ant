/**
 * ANS 托管（zx_20261005 M21 / K-11）——桌面端在需要时**拉起本地 ANS**，退出时只回收自己拉起的那一个。
 *
 * 病根（商业化"快速上手"第一跳）：干净机器上双击桌面端，ANS 没起 ⇒ 一切模型/技能/MCP 调用静默失败，
 *   用户看到的是"点了没反应"。此前只在 5s 预热里 `console.log('ANS 预热连接跳过')`——**静默 warn**。
 *
 * 本模块把"是否该拉起 / 拉得起吗 / 拉完到没到"收成**一处判断**，且全部可注入（fetch/spawn/时钟）
 *   ⇒ 受控回归可直跑真实现，不必真起服务。**零 electron 依赖**（同 `ans-signed-request.ts` 范式）。
 *
 * 四条纪律：
 *   ① **只拉本地的**——用户把 ANS 配到远端时，绝不擅自起本地进程（`isLocalUrl` 把关）。
 *   ② **只杀自己拉起的**——`stopManagedAns` 只针对本进程 spawn 的子进程，不动用户自配的服务。
 *   ③ **拉不起就如实说**——打包版未随包提供 ANS 入口 ⇒ 返回 `no-entry`，不假装已托管。
 *   ④ **拉起命令须真跑得起来**（zx_20261006 M1/M2 补）——命令里那个文件必须是**能被 node 解析的
 *      JS 入口**（`resolveTsxCli` 取 `dist/cli.mjs`，**不是** `.bin/tsx` 这个 sh 垫片）；且子进程
 *      一死即报因（`child-exited` / `native-abi-mismatch`）并附 stderr 遗言，不久拖成 `start-timeout`。
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ansApiKeysEnvValue, type AnsCredPair } from './ans-signed-request.js';

/** 本地主机名白名单（含 IPv6 的 `::1` 与其 URL 形态 `[::1]`）。 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** 该 URL 是否指向本机（决定"可否由桌面端代起"）。非 URL / 远端 ⇒ false。 */
export function isLocalUrl(raw: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(raw).hostname);
  } catch {
    return false;
  }
}

export interface ProbeOpts {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * ANS 可达性探测：有 HTTP 响应即算"进程在"（含 401/404——服务在跑但未认证/无此路由，
 * 都与"根本没起"是两回事）。网络错/超时 ⇒ false。**不抛**。
 */
export async function probeAns(baseUrl: string, opts: ProbeOpts = {}): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 1500;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/health`;
    const resp = await fetchImpl(url, { signal: ac.signal });
    return !!resp && (resp.ok || resp.status === 401 || resp.status === 404);
  } catch {
    return false; // 不可达 / 超时 / 连接被拒——都归"没在跑"
  } finally {
    clearTimeout(timer);
  }
}

export interface LaunchCommand {
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * 打包版代起（zx_20261009 M3）：包内的 ANS 运行时。
 *
 * ⚠ 打包版**不跑系统 node**，而是 `ELECTRON_RUN_AS_NODE=1 process.execPath` —— 于是 better-sqlite3
 *   用的是 **Electron ABI**，与包内其它原生模块同源 ⇒ dev 下那条"ABI 互斥"（`run.sh` rebuild 成
 *   Electron ABI vs 代起用系统 node）在包内**自然消失**。
 */
export interface PackagedAnsOpts {
  /** 包内入口（`<Resources>/ans-server/dist/index.js`）。**须真存在**——不存在即如实 `no-entry`。 */
  entry: string;
  /**
   * ANS 的工作目录。ANS 的**数据/日志/插件安装**目录皆由 cwd **上溯两级**派生
   *   （`schema.ts` DATA_DIR / `logger.ts` LOG_DIR / `plugin-marketplace.ts` INSTALL_DIR 同一约定）
   *   ⇒ 调用方须按该约定摆位：`<数据根>/a/b` ⇒ 数据落在 `<数据根>/data`。
   * ⚠ `plugin-marketplace.ts` 的 `DATA_ROOT`（worker-ant-data）上溯**三级**、与前者不同，
   *   故须另经 `workerDataDir` 显式给（那一路本身就有 `WORKER_ANT_DATA_DIR` env 逃生口）。
   */
  cwd: string;
  /** 覆盖 Electron 可执行（测试用）。缺省 `process.execPath`。 */
  electronExec?: string;
  /** `WORKER_ANT_DATA_DIR`（上溯三级的那一路，与 `cwd` 约定不同源 ⇒ 显式给）。 */
  workerDataDir?: string;
}

export interface LaunchOpts {
  isDev?: boolean;
  repoRoot?: string;
  port?: number;
  /** 覆盖 node 可执行（测试/自定义环境）。缺省取 `WA_NODE_BIN` 或 `node`。 */
  nodeExec?: string;
  /** 覆盖 tsx 可执行路径（测试用）。 */
  tsxPath?: string;
  /** 打包版代起（提供即走**包内**分支，与 dev 分支互斥）。 */
  packaged?: PackagedAnsOpts;
}

/**
 * 「仓库根」单一真源：自 `fromDir` 上溯至含 `pnpm-workspace.yaml` 的目录。
 *
 * 此前该值在 `main/index.ts` 手写 `path.resolve(__dirname,'..','..','..','..')`，
 *   而 `ipc/ans.ipc.ts` 因层级不同（多一层 `ipc/`）**干脆没传** ⇒ 用户手点「一键拉起」恒 `no-entry`。
 * 改按**标志文件上溯**，各调用点不必自算层级（层级一挪就失配）。打包版（asar 内）上溯不到 ⇒ `null`
 *   ——与"打包版无 ANS 入口"同向，调用点据此如实回 `no-entry`。
 */
export function findRepoRoot(fromDir: string): string | null {
  let dir = path.resolve(fromDir);
  for (let i = 0; i < 16; i++) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 定位 tsx 的**真 JS 入口**（`dist/cli.mjs`）。
 *
 * ⚠ 绝不可用 `node_modules/.bin/tsx`：那是 **sh 垫片**（首行 `#!/bin/sh`），`node <它>` 会被
 *   node 当 JavaScript 解析 ⇒ `SyntaxError: missing ) after argument list`，进程当场死。
 *   （zx_20261005 M21 原始实现正是此病；且 `.bin/tsx` 还是 tsup peer 上浮的幻影 bin。）
 * ⚠ `tsx/package.json` 的 exports **未导出** `./dist/cli.mjs`（`ERR_PACKAGE_PATH_NOT_EXPORTED`），
 *   故先经 `tsx/package.json` 定出包目录，再取其下 `dist/cli.mjs`。
 * 解析锚定 **ans-server**（它 `devDependencies` 里真声明了 `tsx`），不依赖桌面的幻影 bin。
 */
export function resolveTsxCli(repoRoot: string): string | null {
  try {
    const req = createRequire(path.join(repoRoot, 'apps/ans-server/package.json'));
    const cli = path.join(path.dirname(req.resolve('tsx/package.json')), 'dist', 'cli.mjs');
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

/**
 * 解析"如何拉起本地 ANS"。
 *
 * - **打包（`opts.packaged` 在场）**：`ELECTRON_RUN_AS_NODE=1 <electron> <Resources>/ans-server/dist/index.js`
 *   （包内随了 ANS 依赖闭包 ⇒ 无需系统 node / tsx；原生模块即 Electron ABI，自洽）。入口不存在 ⇒ `null`。
 * - **dev**：`node <tsx 真入口> apps/ans-server/src/index.ts`（用**系统 node**——ANS 的
 *   better-sqlite3 是 Node ABI，绝不能用 Electron 的 `process.execPath`，否则原生模块 ABI 不符直接崩）。
 * - **dev 但 tsx 解析不到**：同样 `null`（"无入口"如实），不凭空拼一条注定跑不起来的命令。
 */
export function resolveAnsLaunchCommand(opts: LaunchOpts = {}): LaunchCommand | null {
  if (opts.packaged) {
    const { entry, cwd, electronExec, workerDataDir } = opts.packaged;
    // 包内入口**须真在**——不存在即如实回 null（由调用方报 `no-entry`），不假装托管。
    if (!existsSync(entry)) return null;
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    if (opts.port != null) env.ANS_SERVER_PORT = String(opts.port);
    if (workerDataDir) env.WORKER_ANT_DATA_DIR = workerDataDir;
    return { cmd: electronExec ?? process.execPath, args: [entry], cwd, env };
  }
  if (!opts.isDev) return null;
  const repoRoot = opts.repoRoot;
  if (!repoRoot) return null;
  const tsx = opts.tsxPath ?? resolveTsxCli(repoRoot);
  if (!tsx) return null;
  const entry = path.join(repoRoot, 'apps/ans-server/src/index.ts');
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.port != null) env.ANS_SERVER_PORT = String(opts.port);
  return {
    cmd: opts.nodeExec ?? process.env.WA_NODE_BIN ?? 'node',
    args: [tsx, entry],
    cwd: repoRoot,
    env,
  };
}

export type StartReason =
  | 'reachable' | 'disabled' | 'remote' | 'no-entry' | 'started' | 'start-timeout' | 'spawn-failed'
  // zx_20261006 M2：子进程**启动即死**的如实两态——原实现把 stdio 的 stderr 位设为 ignore，遗言整个扔掉，
  //   于是"早死了"被静默拖成 20s 后的 `start-timeout`（听着像"慢"，实为"已死"）。
  | 'native-abi-mismatch' | 'child-exited';

/** 子进程遗言里的 ABI 不符特征（better-sqlite3 被 electron-rebuild 换成 Electron ABI 时）。 */
const ABI_MISMATCH_RE = /NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|different Node\.js version/i;

/**
 * zx_20261009 M5：ABI 不符的**第二种到场方式**——实测里原生模块 ABI 不符常表现为**秒退 + stderr 全空**
 *   （进程在加载原生模块时即被信号杀掉，来不及写一字遗言）。只认文本的旧实现于是把它降级成笼统的
 *   `child-exited`（把"ABI 冲突"说成"随便死了"，名实不符，用户拿不到那条自救提示）。
 * 判据取**合取**：stderr 空 ∧ 存活时长 ≤ 此阈值 ⇒ 归入 ABI 疑似。正常慢启不受影响（那时子进程还活着）。
 */
const FAST_DEATH_MS = 2_000;

/** stderr 尾保留上限（有界，防崩溃进程刷屏）。 */
const STDERR_TAIL_MAX = 2048;

export interface StartResult {
  /** 本次调用**是否真的新起了**一个子进程。 */
  started: boolean;
  /** 调用返回时 ANS 是否可达。 */
  reachable: boolean;
  reason: StartReason;
  /** 子进程死亡时其 stderr 尾（据实上屏；非死亡路径为 `undefined`）。 */
  stderrTail?: string;
}

export interface EnsureOpts extends LaunchOpts, ProbeOpts {
  /** 应用层开关（设置 `ans_auto_start`）。false ⇒ 不自动拉起（用户仍可显式 `ans:start` 走 force）。 */
  autoStart?: boolean;
  /** 显式用户动作：忽略 `autoStart`/`WA_ANS_AUTOSTART` 的"自动"闸。 */
  force?: boolean;
  /** 拉起后等待可达的上限（ms）。 */
  readyTimeoutMs?: number;
  spawnImpl?: typeof spawn;
  /** 注入的 sleep（测试免真等）。 */
  sleepImpl?: (ms: number) => Promise<void>;
}

let managedChild: ChildProcess | null = null;
let managedPid: number | null = null;
let lastReason: StartReason | 'idle' = 'idle';
let startInFlight = 0;

/** 托管现状（供 IPC 上屏：是否由本机托管 / 子进程 PID / 最近一次判断因）。 */
export function ansSupervisorState(): { managed: boolean; pid: number | null; reason: string } {
  return { managed: managedChild !== null, pid: managedPid, reason: lastReason };
}

/**
 * 是否**正有一次 `ensureAnsStarted` 在跑**（拉起的同步段已进、尚未收场）。
 *
 * 2026-10-25 实测：打包版首启时渲染层与代起并发——`setup:state` 的模型探针常跑到 ANS 监听之前，
 *   拿到 ECONNREFUSED 就按 fail-open 判"不拦"，真新用户于是绕过安装向导。首启判据据此**有界等**它
 *   （`core/ans-start-grace.ts`）。与 `managed` 分家：`managed` 答"子进程在不在"，本判据答"此刻有没有人在拉"。
 */
export function ansStartInFlight(): boolean {
  return startInFlight > 0;
}

/** 全局急停（rr/CI 用；任何 autoStart 都不生效）。 */
function autoStartKilled(): boolean {
  return process.env.WA_ANS_AUTOSTART === '0';
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 对外入口——只多一层「本次拉起仍在进行」的计数（`ansStartInFlight()`），供首启判据在模型探针前
 * 有界等待（`core/ans-start-grace.ts`）。其余语义全在 `ensureAnsStartedOnce`。
 */
export async function ensureAnsStarted(creds: { baseUrl: string } & Partial<AnsCredPair>, opts: EnsureOpts = {}): Promise<StartResult> {
  startInFlight++;
  try { return await ensureAnsStartedOnce(creds, opts); }
  finally { startInFlight--; }
}

/**
 * 确保 ANS 可用：可达即返回；不可达且满足"本地 ∧ 有入口 ∧ 开关开"才拉起，并**有界等待**到可达。
 * 任意一步不满足都**如实回因**（不抛、不静默）。
 *
 * zx_20261009 M2：`creds` 除 `baseUrl` 外可带身份两半——**确要代起**时随子进程 env 下发
 *   `ANS_API_KEYS`（ANS 侧 env 回退即认），"服务是我起的"于是"客户端也认得出我"。缺任一半 ⇒ 不注入。
 */
async function ensureAnsStartedOnce(creds: { baseUrl: string } & Partial<AnsCredPair>, opts: EnsureOpts = {}): Promise<StartResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const probe = () => probeAns(creds.baseUrl, { fetchImpl, timeoutMs: opts.timeoutMs });

  if (await probe()) { lastReason = 'reachable'; return { started: false, reachable: true, reason: 'reachable' }; }

  if (!opts.force && (autoStartKilled() || opts.autoStart === false)) {
    lastReason = 'disabled'; return { started: false, reachable: false, reason: 'disabled' };
  }
  if (!isLocalUrl(creds.baseUrl)) {
    lastReason = 'remote'; return { started: false, reachable: false, reason: 'remote' };
  }
  const cmd = resolveAnsLaunchCommand(opts);
  if (!cmd) { lastReason = 'no-entry'; return { started: false, reachable: false, reason: 'no-entry' }; }

  // zx_20261009 M2（维特根斯坦·意义即使用）: 凭据的意义在**两侧用同一对**——只写在一侧的凭据没有意义。
  //   代起前把本机凭据随子进程 env 下发（ANS 侧 `getSecrets` 的 env 回退按 `key:secret` 认），
  //   于是无需先在 `ans_api_keys` 建行、也无需 `ANS_ENCRYPTION_KEY`。缺任一半 ⇒ 不注入（不发半对）。
  const envValue = ansApiKeysEnvValue({ apiKey: creds.apiKey ?? '', secretKey: creds.secretKey ?? '' });
  if (envValue) cmd.env.ANS_API_KEYS = envValue;

  // 子进程遗言与死讯（声明于 try 外，供下方等待循环据实判因）。
  let stderrTail = '';
  let exited = false;
  let spawnFailed = false;
  let livedMs: number | null = null; // 存活时长（死时记；用于区分"秒退"与"活了很久才死"）
  let notifyExit: () => void = () => { /* spawn 成功后替换 */ };
  const exitedPromise = new Promise<void>((resolve) => { notifyExit = resolve; });

  const spawnAt = Date.now();
  try {
    // 打包版首启时 `<userData>/ans/apps` 还不存在：直接 spawn 会以 cwd ENOENT 失败
    //   （实测 0.2.1 候选包首启抛未捕获 `spawn … ENOENT`，ANS 永远代起不来）。
    //   cwd 由本函数保证存在，调用方不必各自记得先建目录。
    mkdirSync(cmd.cwd, { recursive: true });
    const child = (opts.spawnImpl ?? spawn)(cmd.cmd, cmd.args, {
      cwd: cmd.cwd, env: cmd.env, stdio: ['ignore', 'ignore', 'pipe'], detached: false,
    } as SpawnOptions);
    // spawn 的失败有**同步抛**与**异步 error 事件**两态；后者不接住就是未捕获异常
    //   （ENOENT/EACCES 走这条），且不会发 exit ⇒ 等待循环空转到 start-timeout，名实不符。
    child.on('error', (err: Error) => {
      spawnFailed = true;
      stderrTail = `${stderrTail}spawn error: ${err.message}`.slice(-STDERR_TAIL_MAX);
      exited = true;
      livedMs = Date.now() - spawnAt;
      notifyExit();
      if (managedChild === child) { managedChild = null; managedPid = null; }
    });
    // zx_20261006 M2：接住遗言——原实现把 stdio 的 stderr 位设为 ignore，子进程崩溃的原因整个扔掉，
    //   只剩一句 20s 后的 `start-timeout`（把"早死了"说成"慢"）。
    child.stderr?.on('data', (chunk: unknown) => {
      stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_MAX);
    });
    child.on('exit', () => {
      exited = true;
      livedMs = Date.now() - spawnAt;
      notifyExit();
      if (managedChild === child) { managedChild = null; managedPid = null; }
    });
    managedChild = child;
    managedPid = child.pid ?? null;
  } catch (e) {
    console.warn('[工蚁] ANS 拉起失败:', (e as Error).message);
    lastReason = 'spawn-failed'; return { started: false, reachable: false, reason: 'spawn-failed' };
  }

  // 有界等待（ANS 首次启动含库初始化，给足 ~20s，但绝不无限等；**子进程一死即返**，不等满窗口）。
  const sleep = opts.sleepImpl ?? defaultSleep;
  const deadline = Date.now() + (opts.readyTimeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    if (exited) {
      // spawn 本身失败（异步 error 事件）：如实回 `spawn-failed`，且 `started:false`
      //   ——进程根本没起来，不能记成"起过又死了"。
      if (spawnFailed) {
        lastReason = 'spawn-failed';
        return { started: false, reachable: false, reason: 'spawn-failed', stderrTail };
      }
      // zx_20261009 M5：ABI 不符有两种到场方式——① 遗言里带 `NODE_MODULE_VERSION`（Node 打印后退出）；
      //   ② **秒退且 stderr 全空**（原生模块加载即被信号杀掉）。旧实现只认 ①，真 ABI 冲突于是落到
      //   笼统的 `child-exited`（用户拿不到"先跑 pnpm dev:ans"那条自救提示）。此处并认两态。
      const emptyFastDeath = stderrTail.trim() === '' && livedMs !== null && livedMs <= FAST_DEATH_MS;
      const reason: StartReason = ABI_MISMATCH_RE.test(stderrTail) || emptyFastDeath ? 'native-abi-mismatch' : 'child-exited';
      lastReason = reason;
      return { started: true, reachable: false, reason, stderrTail };
    }
    await Promise.race([sleep(500), exitedPromise]);
    if (await probe()) { lastReason = 'started'; return { started: true, reachable: true, reason: 'started' }; }
  }
  lastReason = 'start-timeout'; return { started: true, reachable: false, reason: 'start-timeout' };
}

/** 回收**本进程拉起的** ANS（用户自配的服务不动）。返回是否真的杀了点什么。 */
export function stopManagedAns(): boolean {
  if (!managedChild) return false;
  try { managedChild.kill('SIGTERM'); } catch { /* 已退出 */ }
  managedChild = null; managedPid = null;
  return true;
}

/**
 * 退出路径专用的回收：先礼后兵——SIGTERM 之后有界等它自己走，等不到再补 SIGKILL。
 *
 * 打包版 ANS 是 `ELECTRON_RUN_AS_NODE` 的 Electron 二进制：**实测不响应 SIGTERM**
 * （2026-10-24 发信号后 3s 仍存活，`sample` 显示它照常空转在事件循环里）。
 * 只发 SIGTERM 的旧版于是每次退出都留下一个名为「工蚁」的孤儿进程——从用户视角看
 * 就是"退出了但工蚁还在跑"。
 */
export async function stopManagedAnsAndWait(opts: { graceMs?: number } = {}): Promise<boolean> {
  const child = managedChild;
  if (!child) return false;
  let graceTimer: NodeJS.Timeout | undefined;
  const gone = new Promise<boolean>((resolve) => {
    if (typeof child.once !== 'function') { resolve(true); return; }
    child.once('exit', () => { if (graceTimer) clearTimeout(graceTimer); resolve(true); });
    graceTimer = setTimeout(() => resolve(false), opts.graceMs ?? 1_000);
  });
  stopManagedAns();
  const exited = await gone;
  if (!exited) { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
  return true;
}
