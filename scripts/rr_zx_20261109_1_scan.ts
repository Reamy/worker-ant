/**
 * zx_20261109_1 B0「轻·准」受控回归 —— 扫描契约。
 *
 * A 构建标识：源码唯一真源＝本脚本轮次（由文件名派生），P1–P6 全过；
 * B 测量口径：`scripts/measure-world-scan.ts` 在册且**只读**（源码不含写盘调用）；
 * C 采样谓词语义钉：`isSampledWorkingFile` 的边界（隐藏文件/跳过目录/根下 dist 文件/隐藏目录内文件）
 *   ——B1 改用目录级剪枝遍历后，这四条是"采样面不许变"的基准。
 *
 * 纪律：轮次值由 `path.basename(__filename)` 派生后做方向性比较；断言文案不含失败字形。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, deriveBuildTag } from './lib/rr-pins.js';
import {
  captureWorldSnapshot, isSampledWorkingFile, isSkippedWorkingPath, scanWorkingDirOnce, snapshotFromScan,
  auditWorldConsistency, type WorkingDirScan,
} from '../apps/worker-ant-desktop/src/main/core/world-snapshot.js';
import { walkWorkingDir } from '../apps/worker-ant-desktop/src/main/core/working-dir-walk.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
// 方向性比较：源码 build 只须**不早于**本脚本轮次（写死等值＝下一轮必炸的哑雷）。
const roundOrd = (t: string): number => {
  const m = /^zx_(\d{8})(?:_(\d+))?$/.exec(t);
  return m ? Number(m[1]) * 1000 + Number(m[2] ?? 1) : -1;
};
const ROOT = path.join(__dirname, '..');
const EXEC = path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/agent-executor.ts');
const PLAN = path.join(ROOT, 'plans/improve', `${SELF_ROUND}.md`);
const DIST = path.join(ROOT, 'apps/worker-ant-desktop/dist');
const MEASURE = path.join(ROOT, 'scripts/measure-world-scan.ts');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

console.log(`\n【A】构建标识 ${SELF_ROUND}`);
{
  const execSrc = fs.readFileSync(EXEC, 'utf-8');
  const { tag, count } = deriveBuildTag(execSrc);
  eq(count, 1, 'A1 源码 build 轮次标识恰好 1 处');
  ok(roundOrd(tag) >= roundOrd(SELF_ROUND), 'A2 源码 build 不早于脚本轮次（文件名派生，方向性比较）', `${tag} vs ${SELF_ROUND}`);
  ok(fs.existsSync(PLAN), `A3 方案在册：plans/improve/${SELF_ROUND}.md`);
  checkBuildPins(ok, { distDir: DIST });
}

console.log('\n【B】测量口径只读');
{
  ok(fs.existsSync(MEASURE), 'B1 测量脚本在册：scripts/measure-world-scan.ts');
  const src = fs.readFileSync(MEASURE, 'utf-8');
  const writes = ['writeFile', 'writeFileSync', 'mkdir', 'mkdirSync', 'unlink', 'rmSync', 'rename', 'appendFile']
    .filter((w) => src.includes(w));
  eq(writes, [], 'B2 测量脚本不含任何写盘调用（只读口径）');
  ok(/monitorEventLoopDelay/.test(src), 'B3 测量脚本用事件循环延迟直方图量 max lag');
}

console.log('\n【C】采样谓词语义钉（B1 剪枝遍历的基准）');
{
  eq(isSampledWorkingFile('.gitignore', '.gitignore'), false, 'C1 隐藏文件不收录');
  eq(isSampledWorkingFile('a.ts', 'node_modules/pkg/a.ts'), false, 'C2 node_modules 下文件不收录');
  eq(isSampledWorkingFile('dist', 'dist'), false, 'C3 根下名为 dist 的文件不收录（按相对路径判）');
  eq(isSampledWorkingFile('build', 'src/build'), false, 'C4 任意层 build 目录下条目不收录');
  eq(isSampledWorkingFile('a.txt', '.foo/a.txt'), true, 'C5 隐藏目录内的普通文件仍收录（旧语义）');
  eq(isSampledWorkingFile('a.ts', 'src/a.ts'), true, 'C6 普通源文件收录');
  eq(isSampledWorkingFile('a.ts', '.venv_x/a.ts'), false, 'C7 .venv_* 变体不收录');
}

// ── B1：目录级剪枝遍历 ────────────────────────────────────────────────
async function sectionDE(): Promise<void> {
console.log('\n【D】B1 集合等价（旧 readdir+过滤 vs 新剪枝 walker）');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-scan-rr-'));
  try {
    const mk = (p: string) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), p); };
    mk('src/a.ts');
    mk('src/deep/b.ts');
    mk('.foo/hidden.txt');
    mk('.bar/nested/c.txt');
    mk('node_modules/pkg/index.js');
    mk('node_modules/pkg/sub/x.js');
    for (let i = 0; i < 40; i++) mk(`node_modules/pkg/f${i}.js`);
    mk('src/node_modules/x.js');
    mk('build/out.js');
    mk('target/classes/X.class');
    mk('output/x.txt');
    mk('.venv_x/lib.py');
    mk('.github/workflows/ci.yml');
    fs.writeFileSync(path.join(root, 'dist'), 'dist-file');
    fs.mkdirSync(path.join(root, 'release/dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'release/dist/inner.js'), 'inner');
    mk('root.ts');
    fs.writeFileSync(path.join(root, '.gitignore'), 'x');
    fs.symlinkSync(path.join(root, 'src'), path.join(root, 'linkdir'));
    fs.symlinkSync(path.join(root, 'src/a.ts'), path.join(root, 'link.ts'));
    // 深层：d1/d2/d3 内文件收录；d4 只列目录、内容不收（旧 generateFactSnapshot 的深度语义）
    mk('d1/d2/d3/f.txt');
    mk('d1/d2/d3/d4/g.txt');

    // 旧实现（逐字照抄改造前 `listFilesWrittenSince`/`captureWorldSnapshot` 的取集合逻辑）
    const entries = await fsp.readdir(root, { recursive: true, withFileTypes: true });
    const legacy = new Set<string>();
    for (const e of entries) {
      if (!e.isFile()) continue;
      const fp = path.join((e as unknown as { parentPath?: string }).parentPath || root, e.name);
      if (!isSampledWorkingFile(e.name, path.relative(root, fp))) continue;
      legacy.add(path.relative(root, fp).split(path.sep).join('/'));
    }
    const legacyEntryCount = entries.length;

    const walk = await walkWorkingDir(root, {
      shouldSkipDir: (relDir) => isSkippedWorkingPath(relDir),
      shouldSkipFile: (name, rel) => !isSampledWorkingFile(name, rel),
    });
    const fresh = new Set(walk.files.map((f) => f.rel.split(path.sep).join('/')));

    eq([...fresh].sort(), [...legacy].sort(), 'D1 文件集合逐元素相同（比集合不比计数）');
    ok(walk.entriesScanned < legacyEntryCount, 'D2 剪枝后实际检查条目数少于旧全树枚举', `${walk.entriesScanned} < ${legacyEntryCount}`);
    ok(walk.truncatedScan === false, 'D3 未触发上限');
    // ── 四类边界标本 ──
    ok(legacy.has('.foo/hidden.txt') && fresh.has('.foo/hidden.txt'), 'D4 反证：隐藏目录内普通文件仍被收录（未误剪隐藏目录）');
    ok(legacy.has('.bar/nested/c.txt') && fresh.has('.bar/nested/c.txt'), 'D5 反证：另一隐藏目录内的文件仍被收录');
    ok(!fresh.has('node_modules/pkg/index.js'), 'D6 node_modules 整棵不下沉');
    ok(!fresh.has('src/node_modules/x.js'), 'D7 任意层 node_modules 不下沉');
    ok(!fresh.has('build/out.js') && !fresh.has('target/classes/X.class') && !fresh.has('output/x.txt'), 'D8 build/target/output 不下沉');
    ok(!fresh.has('.venv_x/lib.py') && !fresh.has('.github/workflows/ci.yml'), 'D9 .venv_*/.github 不下沉');
    ok(!fresh.has('dist'), 'D10 根下名为 dist 的普通文件被最终谓词排除');
    ok(!fresh.has('release/dist/inner.js'), 'D11 任意层名为 dist 的目录不下沉');
    ok(!fresh.has('linkdir/a.ts') && !fresh.has('link.ts'), 'D12 符号链接目录不进入、符号链接文件不收录（与旧实现同）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('\n【E】B1 fact snapshot 深度/顺序等价');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-scan-rr-fact-'));
  try {
    const mk = (p: string) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), p); };
    mk('src/a.ts');
    mk('.foo/hidden.txt');
    mk('node_modules/pkg/index.js');
    mk('build/out.js');
    mk('d1/d2/d3/f.txt');
    mk('d1/d2/d3/d4/g.txt');
    fs.symlinkSync(path.join(root, 'src/a.ts'), path.join(root, 'link.ts'));

    // 旧实现（逐字照抄改造前 `generateFactSnapshot` 的内联 walk）
    const legacy: string[] = [];
    const oldWalk = async (dir: string, depth = 0): Promise<void> => {
      if (depth > 3) return;
      let es;
      try { es = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        if (e.name.startsWith('.') || isSkippedWorkingPath(e.name)) continue;
        const rel = path.relative(root, path.join(dir, e.name)).split(path.sep).join('/');
        if (e.isDirectory()) { legacy.push(`${rel}/`); await oldWalk(path.join(dir, e.name), depth + 1); }
        else {
          try { const st = await fsp.stat(path.join(dir, e.name)); legacy.push(`${rel} (${st.size})`); } catch { /* skip */ }
        }
      }
    };
    await oldWalk(root);

    const fresh: string[] = [];
    await walkWorkingDir(root, {
      maxDepth: 3,
      includeNonFiles: true,
      statMode: 'all',
      shouldSkipDir: (_relDir, name) => name.startsWith('.') || isSkippedWorkingPath(name),
      shouldSkipFile: (name) => name.startsWith('.') || isSkippedWorkingPath(name),
      onDir: (rel) => fresh.push(`${rel}/`),
      onFile: (f) => { if (f.size != null) fresh.push(`${f.rel} (${f.size})`); },
    });
    eq(fresh, legacy, 'E1 目录+文件清单（含顺序与深度边界）逐元素相同');
    ok(fresh.includes('d1/d2/d3/d4/'), 'E2 深度 4 目录仍被列出（旧语义）');
    ok(!fresh.some((s) => s.startsWith('d1/d2/d3/d4/g.txt')), 'E3 深度 4 目录内文件不收录（旧语义）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

}

// ── B2：一次扫描两用 ──────────────────────────────────────────────────
async function sectionF(): Promise<void> {
console.log('\n【F】B2 一次扫描两用（快照同形 / 注入扫描被审计真用 / 截断不冒充全量）');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-scan-rr-b2-'));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE wa_projects (id TEXT PRIMARY KEY, working_dir TEXT);
             CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT, context_json TEXT);
             CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, status TEXT, file_path TEXT);`);
    db.prepare('INSERT INTO wa_projects (id, working_dir) VALUES (?, ?)').run('P', root);
    db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?,?,?,?,?)')
      .run('T', 'P', '标题', 'running', '{}');
    db.prepare('INSERT INTO wa_deliverables (id, project_id, name, status, file_path) VALUES (?,?,?,?,?)')
      .run('D1', 'P', 'd', 'draft', path.join(root, 'docs/b.md'));
    const mk = (p: string) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), p); };
    mk('src/a.ts');
    mk('src/deep/c.ts');
    mk('docs/b.md');
    mk('node_modules/x/i.js'); // 剪枝：不收录

    const scan = await scanWorkingDirOnce(root);
    ok(scan != null && scan.files.length === 3, 'F1 扫描可用且采样面不变（node_modules 不收）', `files=${scan?.files.length}`);
    const fromScan = snapshotFromScan(db as never, 'P', scan) as Record<string, unknown>;
    const legacy = await captureWorldSnapshot(db as never, 'P') as Record<string, unknown>;
    const pick = (s: Record<string, unknown>) => ({
      fileCount: s.fileCount, truncated: s.truncated, fileHashes: s.fileHashes,
      taskStates: s.taskStates, deliverableStates: s.deliverableStates,
    });
    eq(pick(fromScan), pick(legacy),
      'F2 `snapshotFromScan` 与 `captureWorldSnapshot` 同形（fileCount/truncated/样本哈希/任务与产出物状态逐项相同）');
    ok(Array.isArray(fromScan.fileHashes) && (fromScan.fileHashes as string[]).length === 3,
      'F3 样本哈希条数 = 收录文件数（size 由 statMode:all 一次带出，不再二次 stat）');

    // ── F4 注入扫描被**真用**：扫描后才落盘的文件不在"命令窗口写入"里 ──
    const stale = path.join(root, 'src/old.txt');
    fs.writeFileSync(stale, 'old');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(stale, old, old);
    const before = await scanWorkingDirOnce(root); // 此刻 later.txt 尚不存在
    fs.writeFileSync(path.join(root, 'src/later.txt'), 'later');
    let raw = '';
    const ctxWrite = (id: string) => { raw = (db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json; };
    db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?,?,?,?,?)').run('T2', 'P', 't', 'running', '{}');
    await auditWorldConsistency(db as never, 'T2', 'P', () => {}, {
      runStartedAtMs: Date.now() - 60_000, scan: Promise.resolve(before),
    });
    ctxWrite('T2');
    const ch = ((JSON.parse(raw).finalize_checks || []) as string[]).find((c) => c.includes('第二通道')) || '';
    ok(ch.includes('src/a.ts') && !ch.includes('later.txt') && !ch.includes('src/old.txt'),
      'F4 审计用的就是注入的扫描（窗口内 `src/a.ts` 在册；扫描后才写的 `later.txt` **不在**清单里——'
      + '若审计自行重扫，它必然出现；`old.txt` mtime 早于窗口也不在）', ch.slice(0, 200));

    // ── F5 截断不得冒充"无写入/没变化" ──
    const tiny: WorkingDirScan = {
      root, entriesScanned: 4, dirsScanned: 1, truncatedScan: true,
      files: [{ abs: path.join(root, 'src/a.ts'), rel: 'src/a.ts', size: 3, mtimeMs: Date.now() }],
    };
    db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?,?,?,?,?)').run('T3', 'P', 't', 'running', '{}');
    await auditWorldConsistency(db as never, 'T3', 'P', () => {}, {
      runStartedAtMs: Date.now() - 60_000, fileMutationCount: 1, scan: Promise.resolve(tiny),
    });
    ctxWrite('T3');
    const ch3 = ((JSON.parse(raw).finalize_checks || []) as string[]).find((c) => c.includes('工作目录过大')) || '';
    ok(ch3.includes('工作目录过大') && ch3.includes('不是全量'),
      'F5 截断 ⇒ 明写"工作目录过大/未完成全量盘点/不是全量"（扫描条目数一并落账）', ch3.slice(0, 160));
    ok(!ch3.includes('无写入') && !ch3.includes('未写文件'),
      'F6 截断文案**不含**"无写入/未写文件"（不知道就说不全，不说成没写过）');

    // ── F7 扫描不可用 ≠ 没写过 ──
    db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?,?,?,?,?)').run('T4', 'P', 't', 'running', '{}');
    await auditWorldConsistency(db as never, 'T4', 'P', () => {}, {
      runStartedAtMs: Date.now() - 60_000, scan: Promise.resolve(null),
    });
    ctxWrite('T4');
    const ch4 = ((JSON.parse(raw).finalize_checks || []) as string[]).find((c) => c.includes('扫描不可用')) || '';
    ok(ch4.length > 0, 'F7 扫描不可用 ⇒ 如实记"未做窗口盘点"（不写成"写入 0 个"）', ch4);
  } finally {
    try { db.close(); } catch { /* ignore */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
}

sectionDE().then(() => sectionF()).then(() => {
  console.log(`\n汇总: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
