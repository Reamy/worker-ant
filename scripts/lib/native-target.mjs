/**
 * 目标平台（platform/arch）相关的公共设施：参数解析、原生二进制识别、目标树校验/剪除、
 * `@electron/rebuild` 调用、pnpm 跨平台调用。
 *
 * 为何要识别文件头而不是信 exit code：`@electron/rebuild` 的 `platform` 只影响
 *   **下载哪个平台的预编译件**，不能交叉编译；一旦预编译件缺失它就退回 node-gyp
 *   产出宿主平台二进制，而 CLI 仍以 0 退出。故必须回读产物里的 `.node` 头，证明
 *   它是目标平台，而不是"构建命令没报错"。
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { closeSync, openSync, readdirSync, readFileSync, readSync, rmSync } from 'node:fs';
import path from 'node:path';

export const SUPPORTED_PLATFORMS = ['darwin', 'win32', 'linux'];
export const SUPPORTED_ARCHS = ['x64', 'arm64'];

export function hostTarget() {
  const platform = process.platform;
  const arch = process.arch;
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    throw new Error(`不支持的宿主平台：${platform}（只支持 ${SUPPORTED_PLATFORMS.join('/')}）`);
  }
  if (!SUPPORTED_ARCHS.includes(arch)) {
    throw new Error(`不支持的宿主架构：${arch}（只支持 ${SUPPORTED_ARCHS.join('/')}）`);
  }
  return { platform, arch };
}

/**
 * 解析 `--platform=win32` / `--platform win32` / `--arch=x64`，缺省取宿主。
 * 返回 `{ platform, arch }`；遇到未知参数直接抛错（宁可拒绝，不猜）。
 */
export function parseTargetArgs(argv, { defaultTarget = hostTarget(), allowHelp = false } = {}) {
  let platform = defaultTarget.platform;
  let arch = defaultTarget.arch;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (allowHelp && (arg === '--help' || arg === '-h')) return { help: true };
    if (arg.startsWith('--platform=')) platform = arg.slice('--platform='.length);
    else if (arg === '--platform') platform = argv[++i];
    else if (arg.startsWith('--arch=')) arch = arg.slice('--arch='.length);
    else if (arg === '--arch') arch = argv[++i];
    else throw new Error(`未知参数：${arg}`);
    if (platform === undefined || arch === undefined) throw new Error('--platform/--arch 缺少取值');
  }

  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    throw new Error(`--platform 只支持 ${SUPPORTED_PLATFORMS.join('/')}，收到：${platform}`);
  }
  if (!SUPPORTED_ARCHS.includes(arch)) {
    throw new Error(`--arch 只支持 ${SUPPORTED_ARCHS.join('/')}，收到：${arch}`);
  }
  return { platform, arch };
}

/** 跨平台跑 pnpm：Windows 上 `pnpm` 是 .cmd 垫片，execFileSync 直接找不到。 */
export function runPnpm(args, opts = {}) {
  const execpath = process.env.npm_execpath;
  if (execpath && /\.(cjs|mjs|js)$/.test(execpath)) {
    return execFileSync(process.execPath, [execpath, ...args], { stdio: 'inherit', ...opts });
  }
  return execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
    stdio: 'inherit',
    ...opts,
    shell: process.platform === 'win32',
  });
}

const MACHO_CPU = new Map([
  [0x01000007, 'x64'],
  [0x0100000c, 'arm64'],
]);
const PE_MACHINE = new Map([
  [0x8664, 'x64'],
  [0xaa64, 'arm64'],
]);
const ELF_MACHINE = new Map([
  [0x3e, 'x64'],
  [0xb7, 'arm64'],
]);

function readHead(file, length = 8192) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const bytes = readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, bytes);
  } finally {
    closeSync(fd);
  }
}

function machoArchs(head) {
  // 文件头字节 cf fa ed fe / ce fa ed fe，按小端读出即 0xfeedfacf / 0xfeedface。
  const magicLE = head.readUInt32LE(0);
  if (magicLE === 0xfeedfacf || magicLE === 0xfeedface) {
    const cpu = head.readUInt32LE(4);
    return [MACHO_CPU.get(cpu)].filter(Boolean);
  }
  const magicBE = head.readUInt32BE(0);
  if (magicBE === 0xfeedfacf || magicBE === 0xfeedface) {
    const cpu = head.readUInt32BE(4);
    return [MACHO_CPU.get(cpu)].filter(Boolean);
  }
  // FAT_MAGIC / FAT_MAGIC_64（大端），universal 包里可能同时含两代架构
  const beMagic = head.readUInt32BE(0);
  if (beMagic === 0xcafebabe || beMagic === 0xcafebabf) {
    const is64 = beMagic === 0xcafebabf;
    const count = head.readUInt32BE(4);
    const entrySize = is64 ? 32 : 20;
    const archs = [];
    for (let i = 0; i < count; i++) {
      const offset = 8 + i * entrySize;
      if (offset + 4 > head.length) break;
      const cpu = head.readUInt32BE(offset);
      const arch = MACHO_CPU.get(cpu);
      if (arch && !archs.includes(arch)) archs.push(arch);
    }
    return archs;
  }
  return null;
}

/**
 * 读 `.node` 文件头，返回 `{ format, platform, archs }`；非原生/N 无法识别返回 null。
 * format: 'mach-o' | 'pe' | 'elf'；platform: 'darwin' | 'win32' | 'linux'。
 */
export function readNativeInfo(file) {
  let head;
  try {
    head = readHead(file);
  } catch {
    return null;
  }
  if (head.length < 20) return null;

  const macho = machoArchs(head);
  if (macho) return { format: 'mach-o', platform: 'darwin', archs: macho };

  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
    const machine = head.readUInt16LE(18);
    const arch = ELF_MACHINE.get(machine);
    return { format: 'elf', platform: 'linux', archs: arch ? [arch] : [] };
  }

  if (head[0] === 0x4d && head[1] === 0x5a && head.length >= 0x40) {
    const peOffset = head.readUInt32LE(0x3c);
    if (peOffset + 6 <= head.length && head.readUInt32BE(peOffset) === 0x50450000) {
      const machine = head.readUInt16LE(peOffset + 4);
      const arch = PE_MACHINE.get(machine);
      return { format: 'pe', platform: 'win32', archs: arch ? [arch] : [] };
    }
    return { format: 'pe', platform: 'win32', archs: [] };
  }

  return null;
}

export function matchesTarget(info, target) {
  if (!info) return false;
  return info.platform === target.platform && info.archs.includes(target.arch);
}

export function describeNative(info) {
  if (!info) return 'unreadable';
  return `${info.format}/${info.platform}/${info.archs.join('+') || 'unknown-arch'}`;
}

/** 遍历目录下所有真实 `.node` 文件（跳过软链，pnpm 闭包里软链会重复计数）。 */
export function findNativeFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.node')) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** 最近一层含 package.json 的祖先目录（用于把 .node 归到模块，判断模块是否还有目标平台件）。 */
function packageRootOf(file, stopAt) {
  let dir = path.dirname(file);
  while (dir.startsWith(stopAt) && dir !== stopAt) {
    try {
      readFileSync(path.join(dir, 'package.json'), 'utf-8');
      return dir;
    } catch {
      dir = path.dirname(dir);
    }
  }
  return null;
}

/**
 * 校验（并可剪除）一棵树里的原生件。
 * - 目标平台的 `.node` 保留；
 * - 非目标平台的 `.node` 剪除并记录（宿主遗留，如 `build/Release/test_extension.node`、
 *   `bin/<宿主平台>-<宿主架构>-<ABI>/`）；
 * - 若某个模块剪完后**一个目标平台原生件都不剩**，记入 `packagesWithoutTarget` —— 调用方须失败，
 *   因为运行期一定缺原生模块。
 * - 读不出格式的 `.node` 记入 `unreadable`（无法证明平台就不得放行）。
 */
export function enforceTargetNatives(root, target, { prune = true, log = () => {} } = {}) {
  const kept = [];
  const removed = [];
  const unreadable = [];

  for (const file of findNativeFiles(root)) {
    const info = readNativeInfo(file);
    if (!info) {
      unreadable.push(file);
      continue;
    }
    if (matchesTarget(info, target)) {
      kept.push({ file, info });
    } else {
      removed.push({ file, info });
      if (prune) {
        rmSync(file, { force: true });
        log(`剪除非目标原生件 ${describeNative(info)}: ${path.relative(root, file)}`);
      }
    }
  }

  const keptPackages = new Set();
  for (const { file } of kept) {
    const pkg = packageRootOf(file, root);
    if (pkg) keptPackages.add(pkg);
  }
  const brokenPackages = new Map();
  for (const { file, info } of removed) {
    const pkg = packageRootOf(file, root);
    if (!pkg || keptPackages.has(pkg)) continue;
    if (!brokenPackages.has(pkg)) brokenPackages.set(pkg, []);
    brokenPackages.get(pkg).push({ file: path.relative(root, file), info: describeNative(info) });
  }

  return {
    kept,
    removed,
    unreadable,
    packagesWithoutTarget: [...brokenPackages].map(([pkg, files]) => ({
      packageRoot: path.relative(root, pkg),
      files,
    })),
  };
}

/**
 * 只校验不剪除，供打包后回读。`strictBuild`：凡位于 `build/` 下的原生件必须是目标平台
 * （node-gyp-build / bindings 都优先加载 `build/Release`，宿主遗留会直接崩目标机）；
 * `prebuilds/` 下允许保留其它平台的件（bcrypt 这类 N-API 包本来就随包全平台预编译，
 * 只有目标平台目录会被加载）。
 */
export function verifyTargetNatives(root, target, { strictBuild = false } = {}) {
  const kept = [];
  const foreignBuild = [];
  const foreignOther = [];
  const unreadable = [];

  for (const file of findNativeFiles(root)) {
    const info = readNativeInfo(file);
    if (!info) {
      unreadable.push(file);
      continue;
    }
    if (matchesTarget(info, target)) {
      kept.push({ file, info });
    } else if (strictBuild && file.split(path.sep).includes('build')) {
      foreignBuild.push({ file, info });
    } else {
      foreignOther.push({ file, info });
    }
  }

  const keptPackages = new Set();
  for (const { file } of kept) {
    const pkg = packageRootOf(file, root);
    if (pkg) keptPackages.add(pkg);
  }
  const packagesWithoutTarget = new Set();
  for (const { file } of [...foreignBuild, ...foreignOther]) {
    const pkg = packageRootOf(file, root);
    if (pkg && !keptPackages.has(pkg)) packagesWithoutTarget.add(pkg);
  }

  return {
    kept,
    foreignBuild,
    foreignOther,
    unreadable,
    packagesWithoutTarget: [...packagesWithoutTarget].map((pkg) => path.relative(root, pkg)),
  };
}

/** 断言指定文件存在且是目标平台；不是就抛错（不靠 exit code 猜）。 */
export function assertNativeFile(file, target) {
  const info = readNativeInfo(file);
  if (!info) throw new Error(`原生件缺失或无法识别：${file}`);
  if (!matchesTarget(info, target)) {
    throw new Error(
      `原生件平台不符：${file} 是 ${describeNative(info)}，目标为 ${target.platform}/${target.arch}`,
    );
  }
  return info;
}

/**
 * 用 `@electron/rebuild` 的库 API 把模块重编/下载为目标平台。
 * 必须 `force`：它的跳过标记 `.forge-meta` 只写 `arch--ABI`、不含 platform，
 * 同架构跨平台（如 darwin-x64 → linux-x64）会被误判为"已构建"而静默跳过。
 */
export async function rebuildNativeForTarget({
  desktopDir,
  buildPath,
  electronVersion,
  target,
  modules = ['better-sqlite3'],
  log = () => {},
}) {
  const requireFromDesktop = createRequire(path.join(desktopDir, 'package.json'));
  const { rebuild } = requireFromDesktop('@electron/rebuild');

  const pending = rebuild({
    buildPath,
    electronVersion,
    platform: target.platform,
    arch: target.arch,
    force: true,
    onlyModules: modules,
    mode: 'sequential',
  });
  if (pending.lifecycle) {
    pending.lifecycle.on('module-found', (name) => log(`发现原生模块：${name}`));
    pending.lifecycle.on('module-done', (name) => log(`处理完成：${name}`));
    pending.lifecycle.on('module-skip', (name) => log(`跳过（已构建）：${name}`));
  }
  await pending;
}
