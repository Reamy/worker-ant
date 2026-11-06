#!/usr/bin/env node
/**
 * 按目标平台打包桌面端：切原生模块（better-sqlite3 / bcrypt）→ 生成 ANS 运行时闭包 →
 * electron-builder → **回读安装件里的 `.node` 头**证明平台对得上。
 *
 * 为何不用 `pnpm dist --win`：
 *   ① 包脚本里的 `rebuild:native`（electron-rebuild CLI）没有 `--platform`，只会产出宿主平台的
 *      better-sqlite3；跨平台打出来的包一加载就 ABI/平台不符。
 *   ② `stage:ans` 也默认宿主平台，闭包内 ANS 的 better-sqlite3 会与目标平台不一致。
 *   ③ npm script 里的 `&&` / `$?` 在 Windows cmd 下不可移植。
 *
 * 为何要 mutation 后再恢复：electron-builder 从 `apps/worker-ant-desktop/node_modules`（pnpm 软链）
 *   收集生产依赖，只能让工作区里的模块先变成目标平台。构建结束（含失败）后把 better-sqlite3
 *   恢复宿主，避免跨平台构建弄坏本机 dev。
 *
 * bcrypt 不参与 electron-rebuild：它用 node-gyp-build，自带全平台 N-API `prebuilds/`；
 *   但其加载顺序**优先 build/Release**，故宿主遗留的 build/Release 必须删掉，交给 prebuilds。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNativeFile,
  describeNative,
  findNativeFiles,
  hostTarget,
  matchesTarget,
  parseTargetArgs,
  readNativeInfo,
  rebuildNativeForTarget,
  verifyTargetNatives,
} from './lib/native-target.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = path.join(repoRoot, 'apps/worker-ant-desktop');
const releaseDir = path.join(desktopDir, 'release');
const stageScript = path.join(repoRoot, 'scripts/stage-ans-runtime.mjs');

const log = (msg) => console.log(`[build-target] ${msg}`);
const fail = (msg) => {
  throw new Error(msg);
};

const argv = process.argv.slice(2);
const unsigned = argv.includes('--unsigned');
let target;
try {
  target = parseTargetArgs(argv.filter((a) => a !== '--unsigned'));
} catch (err) {
  console.error(`[build-target] ✗ ${err.message}`);
  process.exit(1);
}

const host = hostTarget();
const platformFlag = { darwin: '--mac', win32: '--win', linux: '--linux' }[target.platform];
log(`目标平台：${target.platform}/${target.arch}（宿主 ${host.platform}/${host.arch}${unsigned ? '，未签名' : ''}）`);

function resolveFromDesktop(id) {
  return createRequire(path.join(desktopDir, 'package.json')).resolve(id);
}

function electronVersion() {
  const p = path.join(desktopDir, 'node_modules/electron/package.json');
  if (!existsSync(p)) fail(`找不到 electron（${p}）——请先在 apps/worker-ant-desktop 下 pnpm install`);
  return JSON.parse(readFileSync(p, 'utf-8')).version;
}

function runNode(script, args, opts = {}) {
  execFileSync(process.execPath, [script, ...args], { stdio: 'inherit', ...opts });
}

/** 去掉模块里非目标平台的 `.node`（`prebuilds/` 除外：那是随包全平台 N-API 件）。 */
function pruneForeignOutsidePrebuilds(moduleDir, moduleName) {
  if (!existsSync(moduleDir)) return;
  for (const file of findNativeFiles(moduleDir)) {
    if (file.split(path.sep).includes('prebuilds')) continue;
    const info = readNativeInfo(file);
    if (matchesTarget(info, target)) continue;
    rmSync(file, { force: true });
    log(`剪除 ${moduleName} 的非目标原生件 ${describeNative(info)}：${path.relative(moduleDir, file)}`);
  }
}

function assertBcryptLoadable() {
  const dir = path.join(desktopDir, 'node_modules/bcrypt');
  const candidates = [];
  for (const sub of ['build/Release', `prebuilds/${target.platform}-${target.arch}`]) {
    const p = path.join(dir, sub);
    if (existsSync(p)) candidates.push(...findNativeFiles(p));
  }
  const ok = candidates.find((file) => matchesTarget(readNativeInfo(file), target));
  if (!ok) {
    fail(
      `bcrypt 没有可加载的 ${target.platform}/${target.arch} 原生件（检查 prebuilds/ 与 build/Release）`,
    );
  }
  log(`bcrypt 可加载件：${path.relative(dir, ok)}（${describeNative(readNativeInfo(ok))}）`);
}

async function switchNativesToTarget(ev) {
  // bcrypt：删宿主 build/Release，让 node-gyp-build 回落到自带 N-API prebuilds
  pruneForeignOutsidePrebuilds(path.join(desktopDir, 'node_modules/bcrypt'), 'bcrypt');
  // better-sqlite3：prebuild-install 下载目标平台件到 build/Release；bindings 只认这里
  pruneForeignOutsidePrebuilds(path.join(desktopDir, 'node_modules/better-sqlite3'), 'better-sqlite3');
  await rebuildNativeForTarget({
    desktopDir,
    buildPath: desktopDir,
    electronVersion: ev,
    target,
    log,
  });
  const mainLib = path.join(desktopDir, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
  const info = assertNativeFile(mainLib, target);
  log(`better-sqlite3 已是 ${describeNative(info)}`);
  assertBcryptLoadable();
}

function locateUnpacked() {
  if (target.platform !== 'darwin') {
    // electron-builder 对 win32 的输出目录是 `win-unpacked`（不是 `win32-unpacked`），
    // linux 则是 `linux-unpacked`；按 platform 直拼会找不到 Windows 产物。
    const dirName = target.platform === 'win32' ? 'win-unpacked' : `${target.platform}-unpacked`;
    return path.join(releaseDir, dirName);
  }
  for (const name of [`mac-${target.arch}`, 'mac']) {
    const p = path.join(releaseDir, name);
    if (existsSync(p) && readdirSync(p).some((n) => n.endsWith('.app'))) return p;
  }
  const match = readdirSync(releaseDir).find((n) => {
    if (!n.startsWith('mac')) return false;
    const p = path.join(releaseDir, n);
    return existsSync(p) && readdirSync(p).some((x) => x.endsWith('.app'));
  });
  return match ? path.join(releaseDir, match) : null;
}

function checkReport(report, label) {
  if (report.unreadable.length > 0) {
    fail(`${label} 有无法识别的 .node：\n  - ${report.unreadable.join('\n  - ')}`);
  }
  if (report.foreignBuild.length > 0) {
    const lines = report.foreignBuild.map((x) => `${x.file} (${describeNative(x.info)})`);
    fail(`${label} 的 build/Release 里仍有非目标平台原生件：\n  - ${lines.join('\n  - ')}`);
  }
  if (report.packagesWithoutTarget.length > 0) {
    fail(`${label} 有模块没有任何目标平台原生件：\n  - ${report.packagesWithoutTarget.join('\n  - ')}`);
  }
}

function requireKept(report, needle, label) {
  if (!report.kept.some(({ file }) => file.includes(needle))) {
    fail(`${label} 未找到 ${needle} 的目标平台原生件`);
  }
}

function verifyPackaged() {
  const unpacked = locateUnpacked();
  if (!unpacked || !existsSync(unpacked)) fail(`找不到打包产物目录（release/ 下）`);
  const resources =
    target.platform === 'darwin'
      ? path.join(unpacked, readdirSync(unpacked).find((n) => n.endsWith('.app')), 'Contents/Resources')
      : path.join(unpacked, 'resources');

  const ansRoot = path.join(resources, 'ans-server');
  const appRoot = path.join(resources, 'app.asar.unpacked');
  if (!existsSync(ansRoot)) fail(`安装件里缺 ANS 运行时：${ansRoot}`);
  if (!existsSync(appRoot)) fail(`安装件里缺 app.asar.unpacked：${appRoot}`);

  const ansReport = verifyTargetNatives(ansRoot, target, { strictBuild: true });
  checkReport(ansReport, 'ans-server');
  requireKept(ansReport, 'better-sqlite3', 'ans-server');

  const appReport = verifyTargetNatives(appRoot, target, { strictBuild: true });
  checkReport(appReport, 'app.asar.unpacked');
  requireKept(appReport, 'better-sqlite3', 'app.asar.unpacked');
  requireKept(appReport, 'bcrypt', 'app.asar.unpacked');

  log(
    `打包产物校验通过：ans-server ${ansReport.kept.length} 个目标原生件，` +
      `app.asar.unpacked ${appReport.kept.length} 个（跨平台 prebuilds 不计）`,
  );
  log(`产物目录：${unpacked}`);
}

async function build() {
  for (const [file, hint] of [
    [path.join(desktopDir, 'dist/main/index.js'), 'pnpm build'],
    [path.join(desktopDir, 'renderer/dist/index.html'), 'pnpm build'],
  ]) {
    if (!existsSync(file)) fail(`缺构建产物 ${file}——请先运行 \`${hint}\``);
  }

  if (target.platform === 'darwin' && !unsigned) {
    runNode(path.join(repoRoot, 'scripts/require-notarize-env.mjs'), []);
  }

  const ev = electronVersion();
  log(`切换原生模块到 ${target.platform}/${target.arch}（electron ${ev}）`);
  await switchNativesToTarget(ev);

  log(`生成 ANS 运行时闭包（${target.platform}/${target.arch}）`);
  runNode(stageScript, [`--platform=${target.platform}`, `--arch=${target.arch}`], { cwd: repoRoot });

  const cli = resolveFromDesktop('electron-builder/out/cli/cli.js');
  const args = [cli, platformFlag, `--${target.arch}`, '-c.npmRebuild=false'];
  if (target.platform === 'darwin' && unsigned) {
    args.push('-c.mac.identity=null', '-c.mac.notarize=false');
  }
  log(`electron-builder ${args.slice(1).join(' ')}`);
  execFileSync(process.execPath, args, { cwd: desktopDir, stdio: 'inherit' });

  verifyPackaged();
}

async function restoreHostNatives() {
  if (target.platform === host.platform && target.arch === host.arch) return;
  try {
    await rebuildNativeForTarget({
      desktopDir,
      buildPath: desktopDir,
      electronVersion: electronVersion(),
      target: host,
      log,
    });
    log(`已把 better-sqlite3 恢复为宿主 ${host.platform}/${host.arch}（本机 dev 不受影响）`);
  } catch (err) {
    console.error(`[build-target] ✗ 恢复宿主原生模块失败，请手动跑 pnpm rebuild:native：${err?.message ?? err}`);
    process.exitCode = 1;
  }
}

try {
  await build();
} catch (err) {
  console.error(`[build-target] ✗ ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  await restoreHostNatives();
}
