#!/usr/bin/env node
/**
 * 改动面选套件（advisory）——zx_20261027_3 M7「测得快」。
 *
 * 病根：全量 `pnpm rr:all` 要并行跑上百个套件（~40s 起），轮内改一行也全量纯属浪费；
 *   但**按改动猜**会漏覆盖，所以本脚本只做**建议**，不改变收口口径。
 *
 * ⚠ 边界（写死，防下一轮把这里当证据）：**收口一律 `pnpm rr:all`**。
 *   本脚本选中与否都**不是**收口证据；它只服务轮内的受影响面自查。
 *
 * 选法：
 *   1. 取 `git diff --name-only HEAD`（含已暂存）+ 未跟踪文件；
 *   2. 变更落在公共底座 ⇒ **直接全量**（一改全动，猜不如不猜）：
 *      `core/agent-executor.ts` / `database.ts` / `core/exec-context.ts` /
 *      `packages/shared-types/**` / `scripts/lib/**`；
 *   3. 否则按「rr 脚本源码是否出现变更模块的 basename」逐套件匹配；
 *   4. 一个都没命中 ⇒ **全量**（不拿"看起来不相干"赌覆盖）。
 *
 * 用法：
 *   pnpm rr:changed            # 只打印建议
 *   node scripts/rr-changed.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8' }).trim();
}

let diff = '';
let untracked = '';
try {
  diff = git(['diff', '--name-only', 'HEAD']);
  untracked = git(['ls-files', '--others', '--exclude-standard']);
} catch (e) {
  console.error(`读改动面失败（git 不可用？）：${e.message}`);
  process.exit(2);
}

const changed = [...new Set(
  [...diff.split('\n'), ...untracked.split('\n')].map((s) => s.trim()).filter(Boolean),
)].sort();

/** 公共底座：动一处等于动全部。 */
const FORCED = [
  'apps/worker-ant-desktop/src/main/core/agent-executor.ts',
  'apps/worker-ant-desktop/src/main/database.ts',
  'apps/worker-ant-desktop/src/main/core/exec-context.ts',
];
const FORCED_PREFIXES = [
  'packages/shared-types/',
  'scripts/lib/',
];
const forcedBy = (f) =>
  FORCED.includes(f) ? f : FORCED_PREFIXES.find((p) => f.startsWith(p)) ?? null;

const all = fs
  .readdirSync(HERE)
  .filter((f) => f.startsWith('rr_zx_') && f.endsWith('.ts'))
  .sort();

console.log('改动面选套件（advisory）');
console.log(`  工作树变更：${changed.length} 个文件`);
for (const f of changed) console.log(`    ${f}`);

if (changed.length === 0) {
  console.log('\n无改动可推 ⇒ 不猜；要跑就跑全量。');
  console.log('  pnpm rr:all');
  console.log('\n⚠ 收口一律 pnpm rr:all（本选择不是收口证据）。');
  process.exit(0);
}

const forced = changed.map((f) => [f, forcedBy(f)]).filter(([, why]) => why);
if (forced.length > 0) {
  console.log('\n强制全量（公共底座变动）：');
  for (const [f, why] of forced) console.log(`    ${f}  ← ${why === f ? '底座模块' : `前缀 ${why}`}`);
  console.log(`\n选中 ${all.length}/${all.length}（全量）：`);
  console.log('  pnpm rr:all');
  console.log('\n⚠ 收口一律 pnpm rr:all（本选择不是收口证据）。');
  process.exit(0);
}

/**
 * 只取**代码模块名**：`.../tier-usage.ts` → `tier-usage`；`x.d.ts` → `x`。
 * 文档 / 根配置（如 `package.json`）不是模块——拿它的 basename（`package`）去匹配
 * 会误中一大片套件（实测 26 个），建议就失去意义。非代码文件不产生匹配词。
 */
const CODE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const tokenOf = (f) => {
  if (!(f.startsWith('apps/') || f.startsWith('packages/') || f.startsWith('scripts/'))) return null;
  if (!CODE_EXT.some((e) => f.endsWith(e))) return null;
  return path.basename(f).replace(/\.d\.ts$/, '').replace(/\.[^.]+$/, '') || null;
};
const tokens = [...new Set(changed.map(tokenOf).filter(Boolean))];

const picked = [];
for (const name of all) {
  const src = fs.readFileSync(path.join(HERE, name), 'utf-8');
  const hits = tokens.filter((t) => src.includes(t));
  if (hits.length > 0) picked.push({ name, hits });
}

if (picked.length === 0) {
  console.log('\n无命中套件 ⇒ 全量（不拿"看起来不相干"赌覆盖）。');
  console.log(`\n选中 ${all.length}/${all.length}（全量）：`);
  console.log('  pnpm rr:all');
  console.log('\n⚠ 收口一律 pnpm rr:all（本选择不是收口证据）。');
  process.exit(0);
}

console.log(`\n选中 ${picked.length}/${all.length} 个套件（按命中模块）：`);
for (const { name, hits } of picked) console.log(`    ${name}  ← ${hits.join('、')}`);
const filters = picked.map((p) => p.name.replace(/\.ts$/, '')).join(' ');
console.log(`\n轮内自查：\n  pnpm rr:all ${filters}`);
console.log('\n⚠ 收口一律 pnpm rr:all（本选择不是收口证据）。');
process.exit(0);
