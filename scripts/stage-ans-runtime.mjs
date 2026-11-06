#!/usr/bin/env node
/**
 * 打包前置：把 ANS 运行时**整份摆进**桌面仓库（`apps/worker-ant-desktop/ans-runtime/`），
 * 供 electron-builder 经 `extraResources` 随包带到 `Resources/ans-server/`（zx_20261009 M3 路线甲）。
 *
 * 为何要"整份"：ANS 的 `dist/index.js` 是 tsup 产物，**node_modules 仍是 external**（elysia/pino/zod/…）
 *   ⇒ 只带一个 index.js 起不来。故须带**依赖闭包**（`pnpm deploy --prod`）。
 *
 * 为何是 Electron ABI：打包版代起跑的是 `ELECTRON_RUN_AS_NODE=1 process.execPath`（Electron 二进制）
 *   ⇒ 闭包里的 better-sqlite3 必须编成 **Electron ABI**，否则一加载即 `NODE_MODULE_VERSION` 不符。
 *   （dev 的 ABI 互斥在包内因此消失——**全包只有一个 better-sqlite3**，同源。）
 *
 * 为何在**闭包内**就地 rebuild 是安全的：重编前先把原生产物与 pnpm store 的硬链断开
 *   （CI 的 store 与工作区同盘，pnpm 默认用硬链；就地重编会写穿到 store）。断开后 link count = 1，
 *   判据由脚本自身复核（见 detachFromStore / assertLinkCount）。
 *
 * 为何必须补 `dist/data/*.json`：`src/index.ts` 以 `dirname(import.meta.url)/data/*.json` 取推荐资源；
 *   dev 跑 `tsx src/index.ts` ⇒ 命中 `src/data/`；打包跑 `dist/index.js` ⇒ 须命中 `dist/data/`。
 *   漏补则包内 ANS **真**无模型（把 M5 要治的"假无模型"变成"真无模型"）。
 *
 * 目标平台（zx_20261104_2）：`--platform=darwin|win32|linux`、`--arch=x64|arm64`，缺省取宿主。
 *   闭包里的 better-sqlite3 必须换成**目标平台**的 Electron ABI 预编译件；`@electron/rebuild`
 *   的 platform 只负责下载目标平台的预编译件（不能交叉编译），故构建后一律回读 `.node` 头复核，
 *   非目标平台的宿主遗留（test_extension.node / bin/<宿主>）剪除，主库不是目标平台直接失败。
 */
import {
  assertNativeFile,
  describeNative,
  enforceTargetNatives,
  findNativeFiles,
  hostTarget,
  parseTargetArgs,
  rebuildNativeForTarget,
  runPnpm,
} from './lib/native-target.mjs';
import {
  copyFileSync,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ansDir = path.join(repoRoot, 'apps/ans-server');
const desktopDir = path.join(repoRoot, 'apps/worker-ant-desktop');
const STAGING = path.join(desktopDir, 'ans-runtime');

const log = (msg) => console.log(`[stage-ans] ${msg}`);
const die = (msg) => { console.error(`[stage-ans] ✗ ${msg}`); process.exit(1); };

let target;
try {
  target = parseTargetArgs(process.argv.slice(2));
} catch (err) {
  die(err.message);
}
const host = hostTarget();
log(`目标平台：${target.platform}/${target.arch}（宿主 ${host.platform}/${host.arch}）`);

/** 读 electron 版本（闭包内无 electron 依赖，须显式喂给 electron-rebuild）。 */
function electronVersion() {
  const p = path.join(desktopDir, 'node_modules/electron/package.json');
  if (!existsSync(p)) die(`找不到 electron（${p}）——请先在 apps/worker-ant-desktop 下 pnpm install`);
  return JSON.parse(readFileSync(p, 'utf-8')).version;
}

/** 断开与 pnpm store 的硬链：复制到新 inode 再覆盖，使就地重编不写穿到全局 store。 */
function detachFromStore(file) {
  if (statSync(file).nlink === 1) return false;
  const tmp = `${file}.detach-${process.pid}`;
  copyFileSync(file, tmp);
  rmSync(file, { force: true });
  renameSync(tmp, file);
  return true;
}

/** 复核"就地重建安全"的前提：闭包里的原生产物不是硬链（link count === 1）。 */
function assertLinkCount(file) {
  const n = statSync(file).nlink;
  if (n !== 1) die(`原生产物 link count=${n}（>1 表示硬链到 store，就地重编会污染全局）: ${file}`);
}


// ── 步骤 1：清场 ────────────────────────────────────────────────
log(`清场 ${STAGING}`);
rmSync(STAGING, { recursive: true, force: true });

// ── 步骤 2：构建 ANS（tsup）──────────────────────────────────────
log('构建 ANS（pnpm --filter @worker-ant/ans-server build）');
runPnpm(['--filter', '@worker-ant/ans-server', 'build'], { cwd: repoRoot });

// ── 步骤 3：补 dist/data/*.json（否则包内 ANS 真·无模型）──────────
const srcData = path.join(ansDir, 'src/data');
const distData = path.join(ansDir, 'dist/data');
if (!existsSync(path.join(ansDir, 'dist/index.js'))) die('构建未产出 dist/index.js');
rmSync(distData, { recursive: true, force: true });
cpSync(srcData, distData, { recursive: true, filter: (s) => path.basename(s) !== '.gitignore' });
log(`补 dist/data ← src/data（${readdirSync(distData).join(', ')}）`);

// ── 步骤 4：依赖闭包（pnpm deploy --prod）───────────────────────
// ⚠ 只能走 `--filter` 形态：pnpm 9 裸跑 `pnpm deploy`（在包目录内）报
//   `ERR_PNPM_NOTHING_TO_DEPLOY`（实测）。而 `--filter` 又有一个 pnpm 的怪癖：主闭包落在
//   **绝对目标**（正确），但 `.bin` 垫片按**被 filter 的包目录**再拼一次目标 ⇒ 在
//   `apps/ans-server/` 下另生一棵 `apps/…/ans-runtime` 影子树（实测）。故部署后**顺手清掉**它。
log(`生成依赖闭包 → ${STAGING}`);
runPnpm(['--filter', '@worker-ant/ans-server', 'deploy', '--prod', STAGING], { cwd: repoRoot });
rmSync(path.join(ansDir, 'apps'), { recursive: true, force: true });
if (!existsSync(path.join(STAGING, 'dist/index.js'))) die('闭包内无 dist/index.js');
if (!existsSync(path.join(STAGING, 'dist/data/recommended-models.json'))) die('闭包内无 dist/data（随包 ANS 将无模型）');

// ── 步骤 4.5：剪掉"解析后跑出闭包或已悬空"的软链 ──────────────────
// pnpm deploy 会在 `.pnpm/node_modules/@worker-ant/` 下留一条**自指软链**
//   `ans-server -> ../../../../../../ans-server`（指向仓库里的 apps/ans-server，不是闭包内副本）。
// 它在仓库里能解析，随包进 `.app` 后目标不存在 ⇒ electron-builder 的 readDirectoryAndSign
// 以 `stat ENOENT` 中断，整包失败（2026-10-24 实测）。运行期这类软链在包内也不可能成立，
// 一律剪除；闭包本体（`.pnpm/<pkg>@…/node_modules/…`）仍是真实副本，不受影响。
function pruneEscapingSymlinks(root) {
  const removed = [];
  const rootReal = realpathSync(root);
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        let real = null;
        try { real = realpathSync(full); } catch { real = null; }
        if (real === null || (real !== rootReal && !real.startsWith(rootReal + path.sep))) {
          removed.push(`${path.relative(root, full)} -> ${readlinkSync(full)}`);
          rmSync(full, { force: true });
        }
      } else if (e.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(root);
  return removed;
}

const pruned = pruneEscapingSymlinks(STAGING);
if (pruned.length > 0) {
  log(`剪除跑出闭包/悬空的软链 ${pruned.length} 条：`);
  for (const p of pruned) log(`  - ${p}`);
}

// ── 步骤 5：剪掉运行期不需要的（源码/测试/构建配置）──────────────
for (const junk of ['src', '.turbo', 'vitest.config.ts', 'tsconfig.json']) {
  rmSync(path.join(STAGING, junk), { recursive: true, force: true });
}
for (const f of readdirSync(STAGING)) {
  if (/^tsup\..*\.config\.ts$/.test(f)) rmSync(path.join(STAGING, f), { force: true });
}

// ── 步骤 6：闭包内原生模块重编为**目标平台**的 Electron ABI ─────────
const natives = findNativeFiles(path.join(STAGING, 'node_modules/.pnpm'));
if (natives.length === 0) die('闭包内未找到任何 .node —— 依赖闭包不完整');
let detached = 0;
for (const n of natives) {
  if (detachFromStore(n)) detached++;
  assertLinkCount(n);
}
log(`闭包内原生产物 ${natives.length} 个，全部 link count=1（就地重编安全）`);
if (detached > 0) log(`已断开硬链 ${detached} 个（pnpm store → 本地副本），重编不会污染 store`);

const ev = electronVersion();
log(`electron-rebuild better-sqlite3 → ${target.platform}/${target.arch}（Electron ABI，electron ${ev}）`);
try {
  await rebuildNativeForTarget({
    desktopDir,
    buildPath: STAGING,
    electronVersion: ev,
    target,
    log,
  });
} catch (err) {
  die(`原生模块重建失败：${err?.message ?? err}`);
}

// ── 步骤 7：回读产物平台（不信 exit code）──────────────────────────
const mainLib = path.join(STAGING, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
try {
  const info = assertNativeFile(mainLib, target);
  log(`主库校验通过：better_sqlite3.node 是 ${describeNative(info)}`);
} catch (err) {
  die(err.message);
}

const report = enforceTargetNatives(STAGING, target, { log });
if (report.unreadable.length > 0) {
  die(`以下 .node 无法识别格式（不能证明平台，拒绝放行）：\n  - ${report.unreadable.join('\n  - ')}`);
}
if (report.packagesWithoutTarget.length > 0) {
  const lines = report.packagesWithoutTarget.map(
    (p) => `${p.packageRoot}（${p.files.map((f) => `${f.file}=${f.info}`).join(', ')}）`,
  );
  die(`以下模块没有任何目标平台原生件：\n  - ${lines.join('\n  - ')}`);
}
log(`原生件校验完成：保留 ${report.kept.length} 个目标平台件，剪除 ${report.removed.length} 个宿主遗留`);

log(`✓ 就绪：${STAGING}（${target.platform}/${target.arch}，electron-builder 经 extraResources 带到 Resources/ans-server/）`);
