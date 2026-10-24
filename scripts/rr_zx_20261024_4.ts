/**
 * zx_20261024_4 受控复跑 —— 「根」：打包版的 cwd 是 `/`，数据目录不能按 cwd 推。
 *
 * 起因（2026-10-24 用户实测）：公开仓 0.2.0 安装包首次启动报
 *   `ENOENT: no such file or directory, mkdir '/data'`（随后 `_flushSync failed`）。
 *   根因：40 处 `const logger = createLogger(...)` 在 import 阶段求值，`getLogDir()` 按
 *   `process.cwd()` 上溯 `../../data`；Finder 启动的 cwd 是 `/` ⇒ `/data`。
 *
 * 分组：
 *   Z-1 真源：`packagedUserDataDir()` 在非 Electron 运行时如实返回 null（本脚本即标本）
 *   Z-2 三个消费点同走一处真源（logger / notify-dir / project-engine）
 *   Z-3 接线那一跳：装配层把 dataDir 交给 core（`initProjectIpc` / `admin:logs`）
 *   Z-4 两侧标本：打包版优先 userData；dev/rr 的仓库 `data/` 兜底**仍在**
 *   Z-5 版本显示：侧栏版本走 `app:version` 真源，不再写死字面量（0.2.0 曾把崩溃版显示成"已更新"）
 *
 * 纪律（承 CLAUDE.md 与 auto-memory）：
 *   · 直引生产函数（被删/改名即编译期失败，不扫字符串冒充）。
 *   · 两侧标本同试（打包版 / dev 各一只，缺一侧即过宽）。
 *   · 断言文案不含失败字形（`pnpm rr:all` 汇总器按字形计数）。
 *   · 不写"只为下一轮"的字面量：本轮文件路径取自载体自身（`__filename` 定 base）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { packagedUserDataDir } from '../apps/worker-ant-desktop/src/main/core/app-paths.js';
import { resolveNotificationDir } from '../apps/worker-ant-desktop/src/main/core/notify-dir.js';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ok ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop/src/main';
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf-8');
const stripped = (p: string): string => stripKeepingLines(read(p)).join('\n');

const AP = `${A}/core/app-paths.ts`;
const LOGGER = `${A}/core/logger.ts`;
const NOTIFY = `${A}/core/notify-dir.ts`;
const ENGINE = `${A}/core/project-engine.ts`;
const ADMIN = `${A}/ipc/admin.ipc.ts`;
const PROJECT_IPC = `${A}/ipc/project.ipc.ts`;
const APP_LAYOUT = 'apps/worker-ant-desktop/renderer/src/components/AppLayout.tsx';

// ── Z-1 真源 ──────────────────────────────────────────────────────────
function groupZ1(): void {
  console.log('\n【Z-1】真源 `packagedUserDataDir()`（非 Electron 运行时如实返回 null）');
  // 本脚本跑在 node/tsx，`require('electron')` 得到的是可执行文件路径字符串、取不到 app。
  eq(packagedUserDataDir(), null, '非 Electron 运行时返回 null（dev/rr 走既有兜底）');

  const src = stripped(AP);
  ok(/isPackaged/.test(src), '只在 `app.isPackaged` 为真时取 userData');
  ok(/getPath\(\s*['"]userData['"]\s*\)/.test(src), '取的是 Electron 的 userData（不自己拼 Application Support）');
  ok(/try\s*\{[\s\S]*catch/.test(src), 'require 失败被捕获（缺 Electron 时不让整棵模块图崩）');
}

// ── Z-2 消费点同源 ────────────────────────────────────────────────────
function groupZ2(): void {
  console.log('\n【Z-2】三个消费点同走一处真源');
  for (const [label, file] of [['logger', LOGGER], ['notify-dir', NOTIFY], ['project-engine', ENGINE]] as const) {
    const src = stripped(file);
    ok(/packagedUserDataDir\(\)/.test(src), `${label} 引用了打包版真源`);
    ok(/\.\.\/\.\.\/data/.test(src), `${label} 的 dev 兜底仍在（dev/rr 行为不变）`);
  }

  // 次序钉：日志目录必须**先**判打包版，再回落 cwd —— 反了就等于没修。
  const loggerSrc = stripped(LOGGER);
  const fnBody = loggerSrc.slice(loggerSrc.indexOf('function getLogDir'));
  const atPacked = fnBody.indexOf('packagedUserDataDir()');
  const atCwd = fnBody.indexOf(`'../../data/logs'`);
  ok(atPacked >= 0 && atCwd > atPacked, 'getLogDir 先取打包版真源、后回落 cwd', `packed@${atPacked} cwd@${atCwd}`);
}

// ── Z-3 接线那一跳 ────────────────────────────────────────────────────
function groupZ3(): void {
  console.log('\n【Z-3】装配层把 dataDir 交给 core');
  const projectIpc = stripped(PROJECT_IPC);
  ok(/setProjectDataDir\(dataDir\)/.test(projectIpc), '`initProjectIpc` 把注入的 dataDir 交给 ProjectEngine');
  ok(projectIpc.indexOf('setProjectDataDir(dataDir)') < projectIpc.indexOf('new ProjectEngine(db)'),
    '赋值发生在项目引擎被使用之前');

  const adminSrc = stripped(ADMIN);
  ok(/healthDeps\.dataDir[\s\S]{0,120}logs/.test(adminSrc), '`admin:logs` 的日志目录取注入的 dataDir');
}

// ── Z-4 两侧标本 ──────────────────────────────────────────────────────
function groupZ4(): void {
  console.log('\n【Z-4】两侧标本（打包版 / dev 各一只）');
  // 打包版标本：cwd 为 `/` 时，旧写法会得到 `/data/logs`（本轮病症的本体）。
  const oldStyle = path.resolve('/', '../../data/logs');
  eq(oldStyle, '/data/logs', '旧写法在 cwd=/ 时落 `/data/logs`（病症复现标本）');
  // 真源在非 Electron 下为 null ⇒ 新写法回落仓库布局，路径与旧写法**逐字相同**（dev 不变）。
  ok(packagedUserDataDir() === null, 'dev 标本：真源为空，覆盖不到仓库布局');

  // notify-dir 未注入时的解析：本运行时（repo 根）应落在 `<…>/data/notification_payloads`，
  // 不是根路径 `/data`（那正是打包版会踩的坑）。
  const nd = resolveNotificationDir();
  ok(path.isAbsolute(nd) && nd.endsWith(path.join('data', 'notification_payloads')), 'notify 目录落在某个 data/ 下', nd);
  ok(!nd.startsWith('/data/'), 'notify 目录不落在根 `/data`（打包版坑位）', nd);
}

// ── Z-5 版本显示 ──────────────────────────────────────────────────────
function groupZ5(): void {
  console.log('\n【Z-5】侧栏版本显示（真源而非写死字面量）');
  const src = stripped(APP_LAYOUT);
  ok(/license\.appVersion\(\)/.test(src), 'AppLayout 经 `license.appVersion()` 取版本（main 侧 `app.getVersion()`）');
  ok(!/v\d+\.\d+\.\d+/.test(src), '源码里不再有写死的版本字面量（每次发版都会过期）');
  ok(/\{appVersion &&/.test(src), '取到才渲染（浏览器态/通道缺失时不显示假版本）');
}

function groupP(): void {
  console.log('\n【P】build 钉（P1–P6 共用真源）');
  checkBuildPins(ok, { rootDir: root });
}

try {
  groupZ1();
  groupZ2();
  groupZ3();
  groupZ4();
  groupZ5();
  groupP();
} catch (e) {
  fail++;
  console.error(`  FAIL 套件异常：${(e as Error)?.stack || String(e)}`);
} finally {
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}
