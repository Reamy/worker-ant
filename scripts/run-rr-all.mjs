#!/usr/bin/env node
/**
 * 全量受控回归的并行编排（zx_20260915）。
 *
 * 为什么需要它：单脚本耗时的大头**不是断言**，而是 tsx 退出时的固定空转。
 * tsx 的 CLI 是"父进程 spawn 子进程"的守护结构（`tsx/dist/cli.mjs` 里有 `spawn`），
 * 凡模块图触及 `agent-executor.ts` 的脚本——不论 12 条断言还是 216 条——收摊一律 ~13s。
 * 实测 `rr_zx_20260911_3`：real 13.47s，而 user+sys 仅 3.37s（约 75% 纯等待）。
 * 对照：给一个 0.15s 的只读脚本加**一行** `await import(agent-executor.ts)` ⇒ 0.15s → 13.4s，
 * 且打点显示时间全花在 `process.exit(0)` **之后**（boot→imported 仅 62ms，之后才走完 13.3s）。
 *
 * 于是串行 56 个 = 221s，其中 ~193s（87%）压在这 12 个重脚本的空转上。
 * **并行是唯一不丢覆盖的提速手段**（删/合并脚本不解决问题：删一个 13s 的、留另一个 13s 的，
 * 只省 13s；且全仓 56 个脚本互相钉死——`rr_zx_20260912`/`_13`/`_14` 各有"接线在册"断言
 * 点名要求前序脚本存在且各自调用 `checkBuildPins`，还有反证 `rr_zx_19990101.ts`）。
 * 实测：-P 4 → 68s，-P 8 → 39s，-P 12 → 32s（串行 221s）。
 *
 * 判据：**脚本自身退出码**。已核对全仓 56 个脚本的三种写法，均为 `fail > 0` 时退出非零
 * （`fail === 0 ? 0 : 1` 19 个 / `fail > 0 ? 1 : 0` 13 个 / `if (fail > 0) process.exit(1)` 24 个）。
 * 另附**输出兜底**（数 `✗` 与汇总账里的 fail 数），防"退出码与账不符"——
 * 只有退出码与账都判为通过才算通过。
 *
 * 用法：
 *   node scripts/run-rr-all.mjs                # 全量（默认并发 8）
 *   node scripts/run-rr-all.mjs --jobs 12      # 换并发
 *   node scripts/run-rr-all.mjs 2026091        # 只跑名字含该子串的（可给多个）
 *   node scripts/run-rr-all.mjs --keep         # 保留日志目录并在结束时报出路径
 *
 * 输出：每个脚本一份完整日志落在系统临时目录；失败脚本就地打印尾部。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// ── 参数 ──────────────────────────────────────────────────────────────
// 逐 token 走，`--jobs` 的取值必须就地吃掉——否则那个数字会漏进过滤词，
// 变成"过滤词含 2 ⇒ 几乎全跑"（实测踩到：`--jobs 2` 跑了 56 个而不是子集）。
const filters = [];
let keep = false;
let jobs = 8;
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') keep = true;
    else if (a === '--jobs') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) {
        console.error('--jobs 需为正整数');
        process.exit(2);
      }
      jobs = n;
    } else if (a.startsWith('--')) {
      console.error(`未知参数：${a}`);
      process.exit(2);
    } else filters.push(a);
  }
}

// ── 定位 tsx（不依赖 PATH：pnpm workspace 里它在 app 的 node_modules）──
function resolveTsx() {
  if (process.env.RR_TSX) return process.env.RR_TSX;
  const cands = [
    path.join(ROOT, 'apps/worker-ant-desktop/node_modules/.bin/tsx'),
    path.join(ROOT, 'node_modules/.bin/tsx'),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  console.error('未找到 tsx，请先 `pnpm install`（或用 RR_TSX=<路径> 指定）');
  process.exit(2);
}
const TSX = resolveTsx();

// ── 发现脚本 ──────────────────────────────────────────────────────────
const all = fs
  .readdirSync(HERE)
  .filter((f) => f.startsWith('rr_zx_') && f.endsWith('.ts'))
  .sort();
const scripts = filters.length ? all.filter((f) => filters.some((s) => f.includes(s))) : all;
if (scripts.length === 0) {
  console.error(`无可跑脚本（扫描面 ${all.length} 个，过滤词 ${JSON.stringify(filters)}）`);
  process.exit(2);
}

// ── 汇总行解析（全仓有 6+ 种形态，逐一轮值与串行结果对齐过）────────────
const TALLY_RES = [
  /(\d+)\s*通过\s*[/,，]\s*(\d+)\s*失败/g, // 结果: 14 通过, 0 失败 / 216 通过 / 0 失败
  /通过\s*(\d+)\s*\/\s*失败\s*(\d+)/g, // ===== 复跑结果：通过 26 / 失败 0 =====
  /(\d+)\s*PASS\s*\/\s*(\d+)\s*FAIL/gi, // 结果：348 PASS / 0 FAIL
  /pass\s*=\s*(\d+)\s+FAIL\s*=\s*(\d+)/gi, // 结果: pass=100 fail=0
  /PASS\s*=\s*(\d+)\s+FAIL\s*=\s*(\d+)/gi, // PASS=12 FAIL=0
];
/** 取日志中**最靠后**出现的那个汇总（前面的可能是夹具复述）。 */
function parseTally(text) {
  let best = null;
  for (const re of TALLY_RES) {
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0;
      if (!best || at >= best.at) best = { at, pass: Number(m[1]), fail: Number(m[2]) };
    }
  }
  return best ? { pass: best.pass, fail: best.fail } : null;
}
/**
 * 兜底：数 `✗`。**只认这个记号**——它是 ok() 在失败分支唯一打印的字符。
 * 刻意不拿 `失败 <数字>` 做判据：断言标签里就有"连续失败 3 次"这类**叙述**，
 * 那样会把全绿的脚本判红（实测 rr_zx_20260911_2 / _20260912 两个假红，已改）。
 * 已核对全仓 56 份日志：✗ 计数与汇总账逐份一致，且无脚本把 ✗ 写进标签。
 *
 * ⚠ **脚本作者须知**：断言**详情串**里也不许出现 `✗`（不限于标签）。
 * rr_zx_20260921 曾把逐档核对的详情写成 `conversation:21✗`（本意是"本档不适用"），
 * 该断言**通过**却仍被这里计成一次失败记号 ⇒ 全量里假红。改用 `＋`/`－` 一类的符号表示"适用/不适用"。
 */
function countFailMarks(text) {
  return (text.match(/✗/g) || []).length;
}

// ── 编排 ──────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), `rr-all-${stamp}-`));
const t0 = Date.now();

function runOne(name) {
  return new Promise((resolve) => {
    const base = name.replace(/\.ts$/, '');
    const logPath = path.join(logDir, `${base}.log`);
    const out = fs.createWriteStream(logPath);
    const started = Date.now();
    const child = spawn(TSX, [path.join('scripts', name)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    child.on('error', (e) => out.end(`spawn 失败: ${e.message}\n`));
    child.on('close', (code) => {
      out.end(() => {
        const ms = Date.now() - started;
        const text = fs.readFileSync(logPath, 'utf-8');
        const tally = parseTally(text);
        const marks = countFailMarks(text);
        const refusedByExit = code !== 0;
        const refusedByText = marks > 0 || (tally?.fail ?? 0) > 0;
        resolve({
          base,
          ms,
          code,
          tally,
          marks,
          failed: refusedByExit || refusedByText,
          // 退出码与输出账不一致时点名，便于发现"退出码骗人"的新写法
          mismatch: refusedByExit !== refusedByText,
          logPath,
        });
      });
    });
  });
}

console.log(`rr 全量：${scripts.length}/${all.length} 个脚本，并发 ${jobs}，tsx=${path.relative(ROOT, TSX)}`);
console.log(`日志目录：${logDir}\n`);

const results = [];
let cursor = 0;
const tty = process.stdout.isTTY === true;
await Promise.all(
  Array.from({ length: Math.min(jobs, scripts.length) }, async () => {
    while (cursor < scripts.length) {
      const name = scripts[cursor++];
      const r = await runOne(name);
      results.push(r);
      const secs = (r.ms / 1000).toFixed(1).padStart(5);
      const account = r.tally ? `${r.tally.pass}/${r.tally.fail}` : `?/${r.marks || '?'}`;
      if (r.failed) console.log(`  ✗ ${r.base.padEnd(22)} ${secs}s  ${account}`);
      else if (!tty) console.log(`  ✓ ${r.base.padEnd(22)} ${secs}s  ${account}`);
      else process.stdout.write(`  ✓ ${r.base.padEnd(22)} ${secs}s  ${account}\n`);
    }
  }),
);

// ── 汇总 ──────────────────────────────────────────────────────────────
results.sort((a, b) => b.ms - a.ms);
const failed = results.filter((r) => r.failed);
const totalPass = results.reduce((s, r) => s + (r.tally?.pass ?? 0), 0);
const totalFail = results.reduce((s, r) => s + (r.tally?.fail ?? 0), 0);
const noTally = results.filter((r) => !r.tally);

console.log('\n' + '='.repeat(72));
console.log(
  `总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s   脚本 ${results.length}   断言 ${totalPass} 通过 / ${totalFail} 失败`,
);
console.log('最慢 5 个：');
for (const r of results.slice(0, 5)) console.log(`  ${(r.ms / 1000).toFixed(1).padStart(5)}s  ${r.base}`);

if (noTally.length) {
  console.log(
    `\n⚠ 未解析出汇总行的脚本（退出码 ${noTally.every((r) => r.code === 0) ? '全为 0' : '有非零'}，请人工过目）：`,
  );
  for (const r of noTally) console.log(`  ${r.base}  exit=${r.code}  ${r.logPath}`);
}

if (failed.length) {
  console.log(`\n✗ ${failed.length} 个脚本未通过：`);
  for (const r of failed) {
    console.log(
      `\n──── ${r.base}  exit=${r.code}  账=${r.tally ? `${r.tally.pass}/${r.tally.fail}` : '未解析'}  失败记号=${r.marks}  ${r.logPath}`,
    );
    const lines = fs.readFileSync(r.logPath, 'utf-8').trimEnd().split('\n');
    for (const l of lines.slice(-30)) console.log(`    ${l}`);
  }
  console.log(
    `\n══════ 结果：${results.length - failed.length} 通过 / ${failed.length} 失败 ══════` +
      (keep ? `\n日志目录：${logDir}` : ''),
  );
  process.exit(1);
}

const mismatched = results.filter((r) => r.mismatch);
if (mismatched.length) {
  console.log(`\n⚠ 退出码与输出账不一致（${mismatched.length} 个）——判据需复核：`);
  for (const r of mismatched) console.log(`  ${r.base}  exit=${r.code}  失败记号=${r.marks}`);
}

console.log(`\n══════ 结果：${results.length} 通过 / 0 失败 ══════` + (keep ? `\n日志目录：${logDir}` : ''));
process.exit(0);
