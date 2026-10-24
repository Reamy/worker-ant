/**
 * zx_20260916_2 受控复跑 —— 「界面不得因工具而冻：热路径让出事件循环」。
 *
 * 病根（见 `plans/improve/zx_20260916_2.md` §1）：引擎整个跑在 Electron **主进程**里，而工具用**同步** I/O
 * 执行——`execSync` 跑多久，事件循环就被占多久，窗口既不收输入也不重绘，命令一回话界面立刻"恢复"。
 * 真库实测（真工作目录 `projects/a-stock-advisor`）：`grep -rn "decision_snapshot" .` 墙钟 22.83s，期间
 * **maxLag=22818ms**；换异步 spawn 后墙钟 22.86s、**maxLag=2ms**。⇒ 异步化买的不是"更快"，是"这段时间界面能动"。
 *
 * 本脚本判据（逐条照方案 §二 落）：
 *   §S1 判据 A（**可观察行为**，不设阈值）：一样大的活，**同步实现**在窗口内 tick **恰 0**、**异步实现** tick **≥1**。
 *       —— 承维特根斯坦「意义即用法」：不许用"感觉快了"结案，只许用"事件循环有没有走"结案。
 *       两侧**都跑真实现**：异步侧直引 `searchPathForPattern` / `captureWorldSnapshot`；同步侧是**改动前代码的复刻**
 *       （`readdirSync`+`statSync`+`readFileSync` 递归），作为对照臂——它必须"按死"事件循环，否则本判据无从谈起。
 *       ⚠ 对照臂"0 拍"必须是**窗口够长**下的 0 拍：故要求对照跑满 ≥2 拍时长，且确扫到全部文件（防空转）。
 *   §S2 判据 B：异步外壳 `runShellCommand` 五态——成功（含 cwd 生效）/ 非零退出（回话与 `execSync` 同形）/
 *       超时（★ **先证进程真活着、再证真被杀**，不是只把 promise 了结）/ 大输出截断（★ 反证：不限上限时确超限）/
 *       cwd 不存在（spawn error ⇒ 如实报错，不是无声挂起）。
 *   §S3 判据 C（静态）：**工具执行块内零阻塞式同步 I/O**——按**符号**切region（不按行号），逐个工具断言其
 *       `execute` 块内不出现 `execSync|spawnSync|readFileSync|writeFileSync|readdirSync|statSync|mkdirSync|…`；
 *       + 全文级不变量 `execSync(`/`spawnSync(` **零命中**（本轮的硬主张）；+ `shell-exec.ts` 全文零 `Sync(`；
 *       + `world-snapshot.ts` 三个 async 函数体内零 `\w+Sync(`、`compareSnapshots` 仍**是**纯函数（无 `await`）；
 *       + 步循环里的"工具结果超长落盘"一处（**每步都可能走到**）已改 `fsp`。
 *       ⚠ 每个 region 都配**在场断言**（region 非空 + 含本工具的真调用标记）：region 切错成空串时，
 *         "零同步"会**假绿**——这是本脚本最先要防的事（承 feedback「计数器类断言须有正面断言」）。
 *   §S4 build 钉（派生核对，不写轮次字面量）。
 *
 * ⚠ 本文件**不打开真库**（真库只读实测见方案 §1.4）；§S4 读 `dist` ⇒ **tsup 必须先于本脚本**。
 * ⚠ 本文件**不改变**任何生产行为：只把真实现拉起来跑，并数它有没有让出事件循环。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { engineExecSideFiles, stripStepScopePrefix } from './lib/rr-engine-src.js';
import { runShellCommand, truncationNote } from '../apps/worker-ant-desktop/src/main/core/shell-exec.js';
import { searchPathForPattern } from '../apps/worker-ant-desktop/src/main/core/tool-guards.js';
import { captureWorldSnapshot, SNAPSHOT_FILE_LIMIT } from '../apps/worker-ant-desktop/src/main/core/world-snapshot.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) => ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const RD = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');
const strip = (s: string) => stripKeepingLines(s).join('\n');
type AnyDb = import('better-sqlite3').Database;

// ── 事件循环"呼吸"探针 ────────────────────────────────────────────────────
/** 每 5ms 一拍；只数 `(t0,t1)` 窗口内的拍。窗口＝`fn()` 从开跑到回来的墙钟。 */
const TICK_MS = 5;
async function measureTicks(fn: () => Promise<void>): Promise<{ ms: number; ticks: number }> {
  let ticks = 0; let recording = false;
  const timer = setInterval(() => { if (recording) ticks++; }, TICK_MS);
  await new Promise((r) => setTimeout(r, TICK_MS * 4)); // 让 interval 先稳下来，别把"起表"本身算进窗口
  recording = true;
  const t0 = Date.now();
  await fn();
  const ms = Date.now() - t0;
  recording = false;
  clearInterval(timer);
  // ⚠ 对照臂（纯同步）跑完时，被饿死的定时器要等**宏任务**才补跑；`await fn()` 的续体是**微任务**，
  //   先于任何 timer 排空 ⇒ 此处 `recording=false` 一定发生在补拍之前。这正是"0 拍"能被如实读出的原因
  //   （若在此处 `await setTimeout(30)` 再收表，读到的是补跑的那一拍，等于把同步阻塞洗成"有呼吸"）。
  return { ms, ticks };
}

/** 改动前 `searchPathForPattern` 递归遍历的**复刻**（对照臂）：`readdirSync`+`statSync`+`readFileSync` */
function syncWalkControl(dir: string): number {
  let n = 0;
  const walkDir = (d: string, depth: number): void => {
    if (depth > 12) return;
    for (const name of fs.readdirSync(d)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walkDir(full, depth + 1);
      else if (st.size < 500_000) { fs.readFileSync(full, 'utf-8'); n++; }
    }
  };
  walkDir(dir, 0);
  return n;
}

const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitForPidFile(file: string, budgetMs: number): Promise<number | null> {
  const end = Date.now() + budgetMs;
  while (Date.now() < end) {
    try { const t = fs.readFileSync(file, 'utf-8').trim(); if (/^\d+$/.test(t)) return Number(t); } catch { /* 还没写出来 */ }
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}
async function waitGone(pid: number, budgetMs: number): Promise<boolean> {
  const end = Date.now() + budgetMs;
  while (Date.now() < end) { if (!isAlive(pid)) return true; await new Promise((r) => setTimeout(r, 20)); }
  return false;
}

// ── 符号切块（**不按行号**：行号是位置会漂，承 feedback「锚点须按符号不按行号」）──────
/** 从 `startRe` 命中的行起，切到其后首个 `endRe` 命中的行（不含）。找不到任一锚点则返回 ''（由在场断言判红）。 */
function between(src: string, startRe: RegExp, endRe: RegExp): string {
  const lines = src.split('\n');
  const s = lines.findIndex((l) => startRe.test(l));
  if (s < 0) return '';
  let e = lines.length;
  for (let i = s + 1; i < lines.length; i++) if (endRe.test(lines[i]!)) { e = i; break; }
  return lines.slice(s, e).join('\n');
}
/** 工具对象块：`    <name>: {` 起，到下一个同缩进（4 空格）的键止。工具体内部语句缩进 ≥8，不会误切。
 *  文件末尾那个工具（`register_deliverable`）之后没有下一个键 ⇒ 另以工具表的**收尾括号**（`  };`）为界，
 *  否则它会一直切到文件尾，把表外的函数算进来（本脚本首跑即因此红了 1 条）。 */
const TOOL_KEY = /^    [A-Za-z_][A-Za-z0-9_]*: \{$/;
const TOOLS_TABLE_END = /^  \};$/;
function toolBlock(src: string, tool: string): string {
  const lines = src.split('\n');
  const s = lines.findIndex((l) => l === `    ${tool}: {`);
  if (s < 0) return '';
  let e = lines.length;
  for (let i = s + 1; i < lines.length; i++) {
    if (TOOL_KEY.test(lines[i]!) || TOOLS_TABLE_END.test(lines[i]!)) { e = i; break; }
  }
  return lines.slice(s, e).join('\n');
}
/** 阻塞式同步 I/O 的**禁用集**（`existsSync` **不在**其中：它是单次探测、无数据搬运，且旧回话形状依赖它） */
const BLOCKING_SYNC = /(?:exec|spawn|readFile|writeFile|readdir|stat|mkdir|appendFile|copyFile|unlink|rmdir|symlink|chmod|access|open|opendir)Sync\(/;

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr_zx_20260916_2_'));
  const work = path.join(dir, 'work');
  const shDir = path.join(dir, 'shell');
  fs.mkdirSync(shDir, { recursive: true });

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S1】判据A：热路径必须让出事件循环（真实现，可观察行为，不设阈值）');
  // 真临时目录：30 个子目录 × 100 个文件 = 3000（> SNAPSHOT_FILE_LIMIT，顺带让快照走一次截断路径）
  const N_DIRS = 30; const PER_DIR = 100; const N_FILES = N_DIRS * PER_DIR;
  for (let d = 0; d < N_DIRS; d++) {
    const sub = path.join(work, `d${String(d).padStart(2, '0')}`);
    fs.mkdirSync(sub, { recursive: true });
    for (let i = 0; i < PER_DIR; i++) {
      fs.writeFileSync(path.join(sub, `f${String(i).padStart(3, '0')}.txt`),
        `alpha ${d}-${i}\nbeta\n${'z'.repeat(600)}\n`);
    }
  }
  ok(fs.readdirSync(work).length === N_DIRS, `夹具就位：真临时目录 ${N_DIRS} 子目录 / ${N_FILES} 文件`, work);

  // 对照臂：同步实现 —— 必须把事件循环按死（窗口内恰 0 拍）
  let syncScanned = 0; let syncRounds = 0;
  const syncM = await measureTicks(async () => {
    const deadline = Date.now() + TICK_MS * 30;
    do { syncScanned = syncWalkControl(work); syncRounds++; } while (Date.now() < deadline && syncRounds < 40);
  });
  ok(syncM.ticks === 0, '★ A-对照（同步实现）：窗口内 tick **恰 0** —— 命令/遍历跑多久，主进程就被按多久',
    `墙钟 ${syncM.ms}ms / ${syncRounds} 轮`);
  ok(syncRounds >= 1 && syncScanned === N_FILES && syncM.ms >= TICK_MS * 2,
    'A-对照的"0 拍"非空转得来：窗口 ≥2 拍、确扫到全部文件（否则 0 拍可能只是窗口太短）',
    `扫描 ${syncScanned} 文件 / ${syncM.ms}ms`);

  // 实验臂：真实现（改异步后）—— 窗口内必须 ≥1 拍
  let searchRes: Awaited<ReturnType<typeof searchPathForPattern>> | null = null;
  const asyncM = await measureTicks(async () => {
    searchRes = await searchPathForPattern({ pattern: 'ZZZ_NOT_PRESENT_ZZZ', workingDir: work, dirPath: work });
  });
  const sr = searchRes as ({ ok: true; matches: number } | { ok: false; error: string }) | null;
  ok(!!sr && sr.ok === true && sr.matches === 0, 'A-实验臂确实干完了活且确无命中（`searchPathForPattern` 真跑，不是空转）',
    JSON.stringify(sr));
  ok(asyncM.ticks >= 1, '★ A：同一份活改异步后，窗口内 tick **≥1** —— 事件循环在呼吸（界面不再陪着等）',
    `墙钟 ${asyncM.ms}ms / ${asyncM.ticks} 拍`);
  ok(asyncM.ms >= TICK_MS * 2, '两侧干的是同一量级的活（异步侧耗时同样远超两拍 ⇒ 窗口可比）', `${asyncM.ms}ms`);

  // 同一把尺量世界快照（本轮的第二个真实现；也是 §1.4 实测那处 669ms 冻结的来源）
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, working_dir TEXT DEFAULT '');
    CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT);
    CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, status TEXT, file_path TEXT);
  `);
  db.prepare('INSERT INTO wa_projects (id, name, working_dir) VALUES (?, ?, ?)').run('p1', '夹具', work);
  let snap: Record<string, unknown> | null = null;
  const snapM = await measureTicks(async () => { snap = await captureWorldSnapshot(db as unknown as AnyDb, 'p1'); });
  ok(snap !== null && Number((snap as { fileCount: number }).fileCount) === N_FILES,
    'A-快照臂确实干完了活：`fileCount` 记的是**真实总数**', `${N_FILES}`);
  ok(snapM.ticks >= 1, '★ A：`captureWorldSnapshot` 改异步后同样让出事件循环（原实现此处实测 maxLag=669ms）',
    `墙钟 ${snapM.ms}ms / ${snapM.ticks} 拍`);
  ok((snap as { truncated: boolean }).truncated === true
    && ((snap as { fileHashes: string[] }).fileHashes).length === SNAPSHOT_FILE_LIMIT,
    'A-快照：截断只作用于**样本**（截断标志与样本量同源于真源常量，不手抄 2000）',
    `样本 ${((snap as { fileHashes: string[] }).fileHashes).length} / 上限 ${SNAPSHOT_FILE_LIMIT}`);

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S2】判据B：异步外壳 `runShellCommand` 五态（回话形状须与 `execSync` 同形）');
  // 态① 成功 + cwd 生效
  const okRes = await runShellCommand('pwd', { cwd: shDir, timeoutMs: 10_000, maxBuffer: 1 << 20 });
  const pwdOut = okRes.stdout.trim();
  ok(okRes.ok === true && okRes.exitCode === 0 && pwdOut.length > 0, '态① 退出码 0 ⇒ ok=true 且回话在', JSON.stringify(pwdOut));
  const sameDir = pwdOut.length > 0
    && (() => { try { return fs.realpathSync(pwdOut) === fs.realpathSync(shDir); } catch { return false; } })();
  ok(sameDir, '态① cwd 真被执行（`pwd` 落回传入目录，未被吞成主进程 cwd）', `${pwdOut} vs ${shDir}`);
  ok(okRes.error === undefined && truncationNote(okRes) === '', '态① 成功时无 error、无截断尾巴（如实不添字）');

  // 态② 非零退出
  const badRes = await runShellCommand('printf oops >&2; exit 3', { cwd: shDir, timeoutMs: 10_000, maxBuffer: 1 << 20 });
  ok(badRes.ok === false && badRes.exitCode === 3, '态② 非零退出 ⇒ ok=false 且 exitCode 如实');
  ok((badRes.error ?? '').startsWith('Command failed:') && (badRes.error ?? '').includes('oops'),
    '态② error 与 `execSync` 同形（`Command failed:` + stderr）——模型看到的工具回话不变');
  ok(badRes.timedOut === false, '态② 非零退出**不**被记成超时（两种失败不混成一个符号）');

  // 态③ 超时：★ 先证活着，再证被杀
  const pidFile = path.join(shDir, 'pid.txt');
  const TO_MS = 1200;
  const toP = runShellCommand('echo $$ > pid.txt && exec sleep 30', { cwd: shDir, timeoutMs: TO_MS, maxBuffer: 1 << 20 });
  const pid = await waitForPidFile(pidFile, 800);
  ok(pid !== null && isAlive(pid), '态③ 超时用例**先证明进程真的活着**（否则"被杀"是空断言，测的只是 promise 了结）',
    `pid=${pid}`);
  const toRes = await toP;
  ok(toRes.timedOut === true && toRes.ok === false, '态③ 超时 ⇒ timedOut=true 且 ok=false');
  ok((toRes.error ?? '').includes('超时'), '态③ 超时被**如实标注**，不冒充成普通命令失败');
  ok(pid !== null && await waitGone(pid, 2000), '★ 态③ 进程组真被杀（`kill(pid,0)` 抛 ESRCH）——不是只把 promise 了结');

  // 态④ 大输出
  const BIG = 30_000;
  const fullRes = await runShellCommand(`seq 1 ${BIG}`, { cwd: shDir, timeoutMs: 20_000, maxBuffer: 8 << 20 });
  ok(fullRes.stdoutTruncated === false && Buffer.byteLength(fullRes.stdout) > 4096,
    '态④ 对照：不限上限时输出确 >4096 字节（防"截断"断言空转）', `${Buffer.byteLength(fullRes.stdout)}B`);
  const cutRes = await runShellCommand(`seq 1 ${BIG}`, { cwd: shDir, timeoutMs: 20_000, maxBuffer: 4096 });
  ok(cutRes.stdoutTruncated === true && Buffer.byteLength(cutRes.stdout) <= 4096,
    '★ 态④ 超上限 ⇒ 截断属实且不越界（旧实现在此处是**抛** ERR_CHILD_PROCESS_STDIO_MAXBUFFER 打断整步）',
    `${Buffer.byteLength(cutRes.stdout)}B`);
  ok(cutRes.ok === true && cutRes.exitCode === 0, '态④ 截断 ≠ 失败（退出码 0 仍判 ok）');
  ok(truncationNote(cutRes) !== '' && truncationNote(fullRes) === '', '态④ 截断尾巴只在真被截时出现（不许对未截的也说"已截断"）');

  // 态⑤ cwd 不存在（spawn error）
  const spawnErr = await runShellCommand('pwd', { cwd: path.join(dir, 'no_such_dir_zz'), timeoutMs: 5000, maxBuffer: 1 << 20 });
  ok(spawnErr.ok === false && spawnErr.exitCode === null && /ENOENT|no such file/i.test(spawnErr.error ?? ''),
    '态⑤ cwd 不存在 ⇒ 以 spawn error 如实返回（不是无声挂起、不是假装成功）', String(spawnErr.error).slice(0, 80));

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S3】判据C（静态）：工具执行块内零阻塞式同步 I/O（按符号切块，先证块非空）');
  const execSrc = strip(RD(`${A}/src/main/core/agent-executor.ts`));
  // zx_20260920_1 M1 就地订正：工具实现已**机械搬迁**到 `core/tools/*.ts`。工具体扫描面须是
  // 「执行体 ∪ 工具模块」——只扫执行体会切出**空块**，断言却报成"某工具没在场"（本轮实测 26 条此类假红）。
  // 下面两条按 `execSrc` 全文扫的断言（全文无 execSync/spawnSync、rawResult 截断段）保持原样，不受影响。
  const toolsDir = `${A}/src/main/core/tools`;
  const blockSrc = `${execSrc}\n${fs
    .readdirSync(path.join(root, toolsDir))
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => strip(RD(path.join(toolsDir, f))))
    .join('\n')}`;
  // zx_20261003 M8 就地改钉：`finalize_task` 的执行体已由 `control.ts` 机械搬迁至
  //   `core/tools/control-finalize.ts`（导出 `runFinalizeTask`）。按 `    finalize_task: {` 切出的块
  //   如今只剩一句委托（`return runFinalizeTask(deps, args);`），标记与其执行语句都在搬迁体里 ⇒
  //   该工具的"执行块"= **委托块（control.ts，含 `execute:` 那一跳） ∪ 搬迁体（control-finalize.ts 整份函数）**。
  //   两段任一含阻塞同步 I/O 即红（扫描面变宽只许更严）；禁用集与判据一字未改。
  const FINALIZE_BODY = strip(RD(path.join(toolsDir, 'control-finalize.ts')));
  // 每个工具块都配"在场标记"：块切空 / 切错，下述"零同步"会假绿——先用真调用标记把块钉住
  const TOOLS: Array<{ tool: string; marker: string }> = [
    { tool: 'bash', marker: 'runShellCommand(' },
    { tool: 'execute_command', marker: 'runShellCommand(' },
    { tool: 'run_privileged', marker: 'runShellCommand(' },
    { tool: 'git_clone', marker: 'runShellCommand(' },
    { tool: 'read_file', marker: 'paginateReadFile(' },
    { tool: 'write_file', marker: "fsp.mkdir(" },
    { tool: 'edit_file', marker: 'fsp.readFile(' },
    { tool: 'list_files', marker: 'fsp.readdir(' },
    { tool: 'file_retrieval', marker: 'fsp.readdir(' },
    { tool: 'search_content', marker: 'searchPathForPattern(' },
    // zx_20260930 M3-c：类型校验（旧标记 `isModuleFilePath(` 就是它）已随「校验→去重→落库→通报」四步
    //   一起收进共享起草处 ⇒ 本块改钉它**真正剩下的那一跳**：调共享起草处（块切错/切空照样红）。
    { tool: 'create_deliverable', marker: 'createDeliverable(db, {' },
    { tool: 'register_deliverable', marker: 'wa_deliverable_versions' },
    { tool: 'finalize_task', marker: 'checkMCPRegistrationIntegrity(' },
  ];
  for (const { tool, marker } of TOOLS) {
    // zx_20261003 M8 就地改钉：`finalize_task` 的体在 `control-finalize.ts` ⇒ 执行块取委托块 ∪ 搬迁体。
    const blk = toolBlock(blockSrc, tool) + (tool === 'finalize_task' ? `\n${FINALIZE_BODY}` : '');
    const m8Note = tool === 'finalize_task' ? '（M8 就地改钉：委托块 control.ts ∪ 搬迁体 control-finalize.ts）' : '';
    const present = blk.length > 0 && blk.includes('execute:') && blk.includes(marker);
    ok(present, `M2-在场：\`${tool}\` 块已按符号切出且含真调用标记（防"空块假绿"）${m8Note}`, `${blk.split('\n').length} 行 / ${marker}`);
    const hit = blk.match(BLOCKING_SYNC);
    ok(present && hit === null, `M2 零阻塞同步 I/O：\`${tool}\` 执行块内无 ${String(hit?.[0] ?? '')}${m8Note}`,
      hit ? `实测命中 ${hit[0]}` : '');
  }
  ok(!/(?<![A-Za-z0-9_])execSync\(|(?<![A-Za-z0-9_])spawnSync\(/.test(execSrc),
    '★ M1 全文级不变量：`agent-executor.ts` 内 `execSync(`/`spawnSync(` **零命中**（本轮硬主张：命令不再同步跑）');
  const shellSrc = strip(RD(`${A}/src/main/core/shell-exec.ts`));
  ok(!BLOCKING_SYNC.test(shellSrc), 'M1 `shell-exec.ts` 全文零同步 I/O（异步外壳本身不得再引入一处同步）',
    String(shellSrc.match(BLOCKING_SYNC)?.[0] ?? ''));
  ok(shellSrc.includes("from 'node:child_process'") && shellSrc.includes('spawn('),
    'M1 外壳确是真实现（真 `spawn`），不是空壳');

  // 世界快照：三个 async 函数体内零同步 I/O；`compareSnapshots` 仍是纯函数（不受 async 化波及）
  const wsSrc = strip(RD(`${A}/src/main/core/world-snapshot.ts`));
  const FN_END = /^(?:export |function |const |interface |\/\*\*)/;
  for (const fn of ['export async function captureWorldSnapshot(', 'export async function auditWorldConsistency(',
    'export async function generateFactSnapshot(']) {
    const body = between(wsSrc, new RegExp('^' + fn.replace(/[()]/g, '\\$&')), FN_END);
    const hit = body.match(/\w+Sync\(/);
    ok(body.length > 0 && body.includes('await '), `M3-在场：\`${fn.slice(0, -1)}\` 已是 async 且块非空`, `${body.split('\n').length} 行`);
    ok(hit === null, `M3 零同步：\`${fn.slice(0, -1)}\` 体内无 ${String(hit?.[0] ?? '')}`, hit ? `实测命中 ${hit[0]}` : '');
  }
  const cmp = between(wsSrc, /^export function compareSnapshots\(/, FN_END);
  ok(cmp.length > 0 && cmp.includes('writeDiffDump(') && !/\bawait\b/.test(cmp),
    'M3-边界：`compareSnapshots` **仍是纯函数**（无 `await`）——判据函数不受 async 化波及（调用方/rr 一字未改）');

  // tool-guards：`searchPathForPattern` 改异步后体内零同步 I/O（纯函数部分不受波及）
  const tgSrc = strip(RD(`${A}/src/main/core/tool-guards.ts`));
  const sp = between(tgSrc, /^export async function searchPathForPattern\(/, /^(?:export |function |const |interface )/);
  ok(sp.length > 0 && sp.includes('await fsp.'), 'M2-在场：`searchPathForPattern` 已是 async 且块非空', `${sp.split('\n').length} 行`);
  ok(sp.match(/\w+Sync\(/) === null, 'M2 零同步：`searchPathForPattern` 体内无同步 I/O',
    String(sp.match(/\w+Sync\(/)?.[0] ?? ''));
  ok(tgSrc.includes('export function paginateReadFile(') && tgSrc.includes('export function validateReadonlyBashCommand('),
    'M2-边界：同文件的纯函数（`paginateReadFile`/`validateReadonlyBashCommand`）仍在原处（判据外置结构未动）');

  // 步循环里的"工具结果超长落盘"（**每步都可能走到**，工具结果 >4096 字即落盘）
  // zx_20260929 M9：整段随 `onStepFinish` 闭包搬入 `core/exec-step.ts` ⇒ 面取执行体侧
  //   （`lib/rr-engine-src.ts` 一处真源）。否则切出**空块**、两条断言报成"没改异步"（真回归的形状）。
  //   `stripStepScopePrefix` 还原步内绑定（`d.ctx` → `ctx` 等）；本段针脚 `rawResult`/`resultStr`
  //   本是步内局部量 ⇒ 无 `d.` 前缀，还原对它们无影响。⚠ 上面 `execSrc` 的两条**全文级/清单级**断言
  //   （`agent-executor.ts` 内零 `execSync`/`spawnSync`、残留同步 I/O 清单）点的就是执行体这个文件本身
  //   ——那类"文件名即判据"，**不得**换面（换了会变松）。
  const stepFace = stripStepScopePrefix(engineExecSideFiles().map((p) => strip(RD(p))).join('\n'));
  const dump = between(stepFace, /rawResult\.length > 4096/, /resultStr = rawResult\.slice\(0, 800\)/);
  ok(dump.length > 0 && dump.includes('await fsp.writeFile(') && dump.includes('await fsp.mkdir('),
    'M2-步循环：超大工具结果落盘已改异步（`await fsp.mkdir`/`await fsp.writeFile`）', `${dump.split('\n').length} 行`);
  ok(dump.match(BLOCKING_SYNC) === null, 'M2 零同步：落盘处无阻塞式同步 I/O',
    String(dump.match(BLOCKING_SYNC)?.[0] ?? ''));

  // 残留清单：**不作判据**，只如实列给下一轮（免"下一轮字面量"哑雷，也不许静默）
  const residual: string[] = [];
  stripKeepingLines(RD(`${A}/src/main/core/agent-executor.ts`)).forEach((line, i) => {
    if (/\w+Sync\(/.test(line)) residual.push(`${i + 1}:${line.trim().slice(0, 72)}`);
  });
  console.log(`  · 残留同步 I/O（非判据，供下轮择要收拾；本轮已排查定性见方案 §十）${residual.length} 处：`);
  for (const r of residual) console.log(`      ${r}`);

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S4】build 钉（派生核对，不写轮次字面量）');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

  fs.rmSync(dir, { recursive: true, force: true });
}

void main().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260916_2: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
});
