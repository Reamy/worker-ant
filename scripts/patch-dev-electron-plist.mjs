#!/usr/bin/env node
/**
 * zx_20261113_2 M2「通」——给 dev 用的 Electron.app 补本地网络声明（幂等）。
 *
 * 为什么需要：dev 桌面跑的是 `node_modules/.pnpm/electron-<版本>/dist/Electron.app`，它的 Info.plist
 *   是 Electron 官方默认值，没有 `NSLocalNetworkUsageDescription`。macOS 15+ 的本地网络隐私
 *   在缺这个键时**不弹授权框、直接拒绝** LAN 访问（子进程表现为 EHOSTUNREACH）。
 *   打包版由 `electron-builder.yml` 的 `mac.extendInfo` 覆盖；dev 版由本脚本补。
 *
 * 用法：
 *   node scripts/patch-dev-electron-plist.mjs            # 补当前安装的 Electron.app
 *   node scripts/patch-dev-electron-plist.mjs <plist>    # 补指定 plist（rr 用临时 plist）
 *
 * 幂等：键已存在则 replace，不存在则 insert；重复跑不产生重复项。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

export const LOCAL_NETWORK_DESCRIPTION = '工蚁需要访问局域网，以发现设备、连接本地服务与调试目标';
export const BONJOUR_SERVICES = ['_workerant._tcp', '_workerant-terminal._tcp'];

/** 找当前 pnpm 安装的 Electron.app/Contents/Info.plist（不写死版本号）。 */
export function findDevElectronPlist() {
  const pnpmDir = path.join(ROOT, 'node_modules', '.pnpm');
  if (!fs.existsSync(pnpmDir)) return null;
  for (const name of fs.readdirSync(pnpmDir)) {
    if (!/^electron@/.test(name)) continue;
    const plist = path.join(pnpmDir, name, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Info.plist');
    if (fs.existsSync(plist)) return plist;
  }
  return null;
}

function hasKey(plist, key) {
  try {
    execFileSync('plutil', ['-extract', key, 'raw', plist], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function setValue(plist, key, type, value) {
  const args = hasKey(plist, key)
    ? ['-replace', key, `-${type}`, value]
    : ['-insert', key, `-${type}`, value];
  execFileSync('plutil', [...args, plist], { stdio: 'ignore' });
}

/** 补齐两个键；返回 `{ patched: boolean }`（已存在同值也算 patched=false 之外的成功）。 */
export function patchPlist(plist) {
  if (!fs.existsSync(plist)) throw new Error(`plist 不存在：${plist}`);
  setValue(plist, 'NSLocalNetworkUsageDescription', 'string', LOCAL_NETWORK_DESCRIPTION);
  setValue(plist, 'NSBonjourServices', 'json', JSON.stringify(BONJOUR_SERVICES));
  return { patched: true };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const target = process.argv[2] || findDevElectronPlist();
  if (!target) {
    console.error('未找到 Electron.app/Contents/Info.plist；请先 `pnpm install` 或用参数指定。');
    process.exit(1);
  }
  patchPlist(target);
  console.log(`已补齐本地网络声明：${target}`);
}
