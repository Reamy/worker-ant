#!/usr/bin/env node
// 只读诊断：原生模块「代码签名 ↔ 磁盘 mtime」现状。
//
// 真源：plans/improve/zx_20261009_1.md §1。用途——再遇桌面/node 秒退（SIGKILL、无遗言）时，
// **先查真源**：给出每个原生模块的 codesign flags / CDHash / mtime / nlink / 验签结果，
// 并打印内核命中的自查命令。免去"扫文案 / 看现象"式的假判据。
//
// 本文件同时是**"哪些原生模块会被加载"的唯一真源**：`--list` 供 scripts/resign-native-macos.sh 消费。
//   载入集 = 实测 dlopen 结果（`process.dlopen` 钩子）：
//     bcrypt          → bcrypt/build/Release/bcrypt_lib.node
//     better-sqlite3  → better-sqlite3/build/Release/better_sqlite3.node（首次 new Database 时）
//   二者即内核日志命中的同一批。bcrypt 的 prebuilds/（各平台）与 bin/ 之流**不加载**，故不入清单。
//
// 用法：node scripts/diag-cs-sig.mjs [--list | 路径...]
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUFFIXES = [
  '/better-sqlite3/build/Release/better_sqlite3.node',
  '/bcrypt/build/Release/bcrypt_lib.node',
];

function walk(dir, out = []) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && SUFFIXES.some((s) => p.endsWith(s))) out.push(p);
  }
  return out;
}

const targets = () => walk(join(ROOT, 'node_modules/.pnpm')).sort();

const args = process.argv.slice(2);
if (args[0] === '--list') {
  for (const f of targets()) console.log(f);
  process.exit(0);
}

function codesignDvvv(file) {
  // ⚠ codesign 的诊断走 **stderr**；spawnSync 才能取到（execFileSync 成功时不回 stderr）。
  const r = spawnSync('codesign', ['-dvvv', file], { encoding: 'utf8' });
  return (r.stdout || '') + (r.stderr || '');
}
function verify(file) {
  const r = spawnSync('codesign', ['--verify', '--strict', file], { encoding: 'utf8' });
  return r.status === 0 ? 'pass' : 'FAIL: ' + (r.stderr || '').trim().split('\n').pop();
}

const paths = args.length > 0 ? args : targets();
if (paths.length === 0) {
  console.log('未找到目标原生模块（node_modules 是否已安装？）');
  process.exit(0);
}

console.log(`平台: ${process.platform}  Node: ${process.version}`);
console.log(`仓库根: ${ROOT}\n`);
for (const f of paths) {
  const info = codesignDvvv(f);
  const flags = (info.match(/flags=(\S+)/) || [])[1] || '(未签名/读取失败)';
  const cdhash = (info.match(/CandidateCDHash sha256=(\w+)/) || [])[1] || '(无)';
  const st = statSync(f);
  console.log(`● ${f.replace(ROOT + '/', '')}`);
  console.log(`    flags = ${flags}`);
  console.log(`    cdhash= ${cdhash}`);
  console.log(`    mtime = ${Math.floor(st.mtimeMs / 1000)} (${new Date(st.mtimeMs).toISOString()})  nlink=${st.nlink}`);
  console.log(`    verify= ${verify(f)}`);
  if (flags.includes('linker-signed')) console.log('    ⚠ linker-signed：适用"mtime 须与签发时一致"启发式 ⇒ 重签：bash scripts/resign-native-macos.sh');
}
console.log('\n— 内核命中自查（真源）—');
console.log(`  log show --last 30m --predicate 'eventMessage CONTAINS "cs_invalid_page"'`);
console.log('  命中形如：rejecting invalid page ... better_sqlite3.node (cs_mtime:… != mtime:…)');
