/**
 * zx_20261109_1 B0：世界扫描**同一口径**的只读测量脚本。
 *
 * 用途：本轮所有性能数字（条目数 / 候选数 / 单次扫描耗时 / 最大事件循环延迟）
 * 一律由它当场量，禁止拿别处旧数字替代（方案 §实施纪律 7）。
 *
 * 只读：不接受任何写参数；对目标目录只做 readdir/stat。
 *
 * 用法：
 *   npx tsx scripts/measure-world-scan.ts <目录> [--repeat 2]
 *
 * 输出（每轮一组）：
 *   entries          递归枚举到的全部条目（含被跳过目录内部）
 *   dirs             其中目录条目数
 *   candidates       过 `isSampledWorkingFile` 后的文件数
 *   readdirMs        单次 readdir({recursive:true}) 耗时
 *   filterMs         逐条过滤耗时（与生产同款每 16384 条让出一拍）
 *   statAllMs        全量候选 stat 耗时（`listFilesWrittenSince` 口径，并发 64）
 *   legacyScanMs     旧实现完整一次扫描（readdir+过滤+全量 stat）
 *   sample2000Ms     采样 2000 条后 stat（`captureWorldSnapshot` 口径）
 *   maxLagMs         执行旧实现完整扫描期间的最大事件循环延迟
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import {
  isSampledWorkingFile,
  isSkippedWorkingPath,
  listFilesWrittenSince,
  sampleSnapshotCandidates,
  SNAPSHOT_FILE_LIMIT,
} from '../apps/worker-ant-desktop/src/main/core/world-snapshot.js';
import { walkWorkingDir } from '../apps/worker-ant-desktop/src/main/core/working-dir-walk.js';

const STAT_CONCURRENCY = 64;
const FILTER_YIELD_EVERY = 16384;

interface RoundResult {
  entries: number;
  dirs: number;
  candidates: number;
  readdirMs: number;
  filterMs: number;
  statAllMs: number;
  legacyScanMs: number;
  sample2000Ms: number;
  maxLagMs: number;
  /** zx_20261109_1 B1：目录级剪枝 walker 的对照指标 */
  walkerEntries: number;
  walkerDirs: number;
  walkerFiles: number;
  walkerMs: number;
  walkerMaxLagMs: number;
  setEqual: boolean;
  /** zx_20261109_1 B2：单条命令后 `listFilesWrittenSince` 的耗时（决定是否需要 run 级合并）。 */
  writtenMs: number;
  writtenCount: number;
}

async function statAll(paths: readonly string[]): Promise<number> {
  const t0 = performance.now();
  let done = 0;
  for (let i = 0; i < paths.length; i += STAT_CONCURRENCY) {
    const batch = await Promise.all(paths.slice(i, i + STAT_CONCURRENCY).map(async (p) => {
      try { await fsp.stat(p); return 1; } catch { return 0; }
    }));
    done += batch.reduce<number>((a, b) => a + b, 0);
  }
  void done;
  return performance.now() - t0;
}

async function legacyReadAndFilter(root: string): Promise<{ entries: number; dirs: number; candidates: string[]; readdirMs: number; filterMs: number }> {
  const t0 = performance.now();
  const entries = await fsp.readdir(root, { recursive: true, withFileTypes: true });
  const readdirMs = performance.now() - t0;
  let dirs = 0;
  const candidates: string[] = [];
  const t1 = performance.now();
  for (let i = 0; i < entries.length; i++) {
    if (i > 0 && i % FILTER_YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
    const e = entries[i]!;
    if (e.isDirectory()) dirs++;
    if (!e.isFile()) continue;
    const fp = path.join((e as unknown as { parentPath?: string }).parentPath || root, e.name);
    if (!isSampledWorkingFile(e.name, path.relative(root, fp))) continue;
    candidates.push(fp);
  }
  return { entries: entries.length, dirs, candidates, readdirMs, filterMs: performance.now() - t1 };
}

async function oneRound(root: string): Promise<RoundResult> {
  const hist = monitorEventLoopDelay({ resolution: 5 });
  hist.enable();
  hist.reset();
  const scan = await legacyReadAndFilter(root);
  const statAllMs = await statAll(scan.candidates);
  const legacyScanMs = scan.readdirMs + scan.filterMs + statAllMs;
  hist.disable();
  const maxLagMs = hist.max / 1e6;

  const sample = sampleSnapshotCandidates(scan.candidates, SNAPSHOT_FILE_LIMIT, root);
  const sample2000Ms = await statAll(sample);

  // zx_20261109_1 B1：同一目录下新 walker 的对照（含集合等价核验）
  const hist2 = monitorEventLoopDelay({ resolution: 5 });
  hist2.enable();
  hist2.reset();
  const tw = performance.now();
  const walk = await walkWorkingDir(root, {
    shouldSkipDir: (relDir) => isSkippedWorkingPath(relDir),
    shouldSkipFile: (name, rel) => !isSampledWorkingFile(name, rel),
  });
  const walkerMs = performance.now() - tw;
  hist2.disable();
  const walkerMaxLagMs = hist2.max / 1e6;
  const legacySet = new Set(scan.candidates);
  const walkerSet = new Set(walk.files.map((f) => f.abs));
  const setEqual = legacySet.size === walkerSet.size && [...legacySet].every((p) => walkerSet.has(p));

  // zx_20261109_1 B2：生产口径的单条命令盘点耗时（`registerFilesWrittenByCommand` 每命令付一次）
  const tw2 = performance.now();
  const written = await listFilesWrittenSince(root, 0);
  const writtenMs = performance.now() - tw2;

  return {
    entries: scan.entries,
    dirs: scan.dirs,
    candidates: scan.candidates.length,
    readdirMs: round2(scan.readdirMs),
    filterMs: round2(scan.filterMs),
    statAllMs: round2(statAllMs),
    legacyScanMs: round2(legacyScanMs),
    sample2000Ms: round2(sample2000Ms),
    maxLagMs: round2(maxLagMs),
    walkerEntries: walk.entriesScanned,
    walkerDirs: walk.dirsScanned,
    walkerFiles: walk.files.length,
    walkerMs: round2(walkerMs),
    walkerMaxLagMs: round2(walkerMaxLagMs),
    setEqual,
    writtenMs: round2(writtenMs),
    writtenCount: written.length,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith('--'));
  const repIdx = args.indexOf('--repeat');
  const repeat = repIdx >= 0 ? Math.max(1, Math.min(5, Number(args[repIdx + 1]) || 2)) : 2;
  if (!root) {
    console.error('用法: npx tsx scripts/measure-world-scan.ts <目录> [--repeat 2]');
    process.exit(2);
  }
  const abs = path.resolve(root);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) {
    console.error(`不是可读目录: ${abs}`);
    process.exit(2);
  }
  // 一次 `listFilesWrittenSince`（sinceMs=0 ⇒ 全量）作为生产函数本身的对照
  await listFilesWrittenSince(abs, 0);

  console.log(`目录: ${abs}`);
  const rounds: RoundResult[] = [];
  for (let i = 0; i < repeat; i++) {
    const r = await oneRound(abs);
    rounds.push(r);
    console.log(`  第 ${i + 1} 轮: ${JSON.stringify(r)}`);
  }
  if (rounds.length > 1) {
    const first = rounds[0]!;
    console.log(`  两次差异（readdir/legacyScan/maxLag）: ${JSON.stringify({
      readdirPct: pctDiff(first.readdirMs, rounds[1]!.readdirMs),
      legacyScanPct: pctDiff(first.legacyScanMs, rounds[1]!.legacyScanMs),
      maxLagPct: pctDiff(first.maxLagMs, rounds[1]!.maxLagMs),
    })}`);
  }
}

function pctDiff(a: number, b: number): number {
  const base = Math.max(a, b);
  return base > 0 ? Math.round((Math.abs(a - b) / base) * 10000) / 100 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
