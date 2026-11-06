/**
 * zx_20260920_1 M1 的**就地适配**：工具实现从 `agent-executor.ts` 机械搬迁到了 `core/tools/*.ts`。
 *
 * 本仓大量 rr 断言是**按源码切块**的静态判据（"`write_file` 体内走同一个写口"、"`finalize_task` 块内含
 * 验收"、"全文无 `execSync`"…）。它们的**本意**是"某功能的实现必须经由某个写口/判据"，而实现写在哪
 * 个文件、哪一行**只是当时的落点**。搬迁后仍只读 `agent-executor.ts` 的脚本会切出**空块**，
 * 断言却报成"某功能没接线 / 块没在场"——读起来像真回归，实为扫描面没跟着走（本轮实测 26 个脚本、上百条假红）。
 *
 * 故统一取源口径为**「执行体 ∪ exec-* 拆出模块 ∪ 工具模块」**：
 *   · 执行体在前 ⇒ 若某个工具将来搬回执行体，仍优先命中执行体那份，无需再改脚本；
 *   · 返回**原始文本**（不 strip）——各脚本既有的去注释口径（`stripComments`/`strip`/`stripKeepingLines`）
 *     由调用方自行施加，本函数不替它们决定。
 *
 * zx_20260921 M8: `executeTask` 按职责拆出 `core/exec-*.ts`（认领/选型/预算/上下文/收口），
 *   同一批"按源码切块"的静态判据会再次切到空块 ⇒ 扫描面同步并入 `core/exec-*.ts`。
 *
 * zx_20260924_1 M7-c: `buildMemoryContext` + 段优先级表/`selectMemorySections`/`memoryConfTag`
 *   整块迁出到 `core/memory-context.ts`（文件名不带 `exec-` 前缀，故显式并入清单）。
 *   本意是"记忆装配必须经由共享写口 `add(...)`/`selectMemorySections(...)`"的那批判据
 *   （rr_zx_20260913_4 §S0 等）若不跟着走就会**切到空块** ⇒ 报成"段名分家/notExcluded 接线没了"。
 *   并入后并集**内容几乎不变**（这批代码从执行体挪到这里、仍在并集内）⇒ 是"扫描面跟着实现走"。
 *
 * 不变的纪律：**扫描面变宽只许让判据更严**（如"全文无 `execSync`"变成横跨三者），
 * 若某条断言因此由绿转红，那是**真发现**（模块里确有该残留），须按回归处理而非回退扫描面。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const EXECUTOR = 'apps/worker-ant-desktop/src/main/core/agent-executor.ts';
const CORE_DIR = 'apps/worker-ant-desktop/src/main/core';
const TOOLS_DIR = 'apps/worker-ant-desktop/src/main/core/tools';
/** 迁出模块中**不以 `exec-` 命名**者（命名约定由 `readDir` 的过滤式给不出，故显式列出）。 */
const CORE_EXTRA_FILES = ['memory-context.ts'];

/**
 * 执行体源码 ∪ `core/exec-*.ts`（M8 拆出模块） ∪ 全部工具模块源码
 * （各段内按文件名排序，拼接次序稳定 ⇒ 切块结果可复现）。
 *
 * ⚠ 段序是**判据语义**的一部分，非随便排：执行体第一、工具模块最后，`exec-*.ts` 夹在中间——
 *   "全文无 X" 这类断言横跨三段，任何一段含 X 即转红（只许更严）。
 *
 * @param rel 相对仓库根的执行体路径；默认即 `agent-executor.ts`（留参是为了将来若再有搬迁可复用）。
 */
export function engineSrc(rel: string = EXECUTOR): string {
  return engineSrcFiles(rel)
    .map((p) => fs.readFileSync(path.join(ROOT, p), 'utf-8'))
    .join('\n');
}

/**
 * 上面那个扫描面的**文件清单**（仓库相对路径，次序即 `engineSrc()` 的拼接次序）。
 *
 * 给两类脚本用：① 需要**逐文件施加自己的去注释口径**（`strip(p)` 吃路径不吃文本）；
 * ② 需要在断言详情里报出"扫了几个文件 / 命中的是哪个"。两类都不该自己重抄一遍目录约定——
 * 扫描面是**一处真源**，抄第二份就会在下次搬迁时又漏一处。
 *
 * ⚠ 凡**本意就是"某个特定文件"**的判据（如"`agent-executor.ts` 内不再含工具定义"、
 *   "executor 从 `task-archetype` 导入的名字都得用上"）**不得**改用它——那类判据的**文件本身就是判据**，
 *   换成并集只会**变松**（违"扫描面变宽只许更严"）。本函数只服务于"实现落在哪只是落点"的那一类。
 */
export function engineSrcFiles(rel: string = EXECUTOR): string[] {
  const readDir = (dir: string, filter: (f: string) => boolean) =>
    fs.readdirSync(path.join(ROOT, dir)).filter(filter).sort().map((f) => path.join(dir, f));
  return [
    rel,
    ...readDir(CORE_DIR, (f) => f.startsWith('exec-') && f.endsWith('.ts')),
    ...CORE_EXTRA_FILES.map((f) => path.join(CORE_DIR, f)).filter((f) => fs.existsSync(path.join(ROOT, f))),
    ...readDir(TOOLS_DIR, (f) => f.endsWith('.ts')),
  ];
}

/**
 * zx_20260929 M9：`engineSrcFiles()` **去掉工具模块段** ＝「**执行体侧**」扫描面
 * （`执行体 ∪ exec-*.ts ∪ core/memory-context.ts`）。
 *
 * 为什么另有一把尺而不是一律用并集：有一批判据的**本意是「执行体这一侧恰有一处」**并对**另一侧另有同形断言**
 *   ——典型如「run 收口门与 finalize 门各一处」（收口在执行体侧、finalize 在 `tools/control.ts`，
 *   两者**分别**点到、各判一次"恰一处"）。这类断言若整份改用 `engineSrc()`（含工具段），
 *   同一处调用会被**计入两次** ⇒ 从"两侧各一处"退化成"合计 ≥1"，是**放宽**（违"扫描面变宽只许更严"）。
 *   故需要的是"并集但**不含**工具段"，不是更大的并集。
 *
 * 落点来源仍是 `engineSrcFiles()`（**一处真源**），本函数只是按段**减**掉工具段——
 *   刻意**不**自己重抄目录约定：下次搬迁时工具段增删，两个面自动同进退。
 */
export function engineExecSideFiles(rel: string = EXECUTOR): string[] {
  const toolsPrefix = `${TOOLS_DIR}/`;
  return engineSrcFiles(rel).filter((p) => !p.startsWith(toolsPrefix));
}

/**
 * zx_20260929 M9：把**注入的 `d.` 前缀**还原掉——读作「搬迁前的那份文字」。
 *
 * 病：M9 把 `executeTask` 的步回调（`onStepFinish` 体）整段搬到 `core/exec-step.ts`，段内对执行体
 *   53 个绑定统一前置 `d.`（`d.stepCount++`、`d.loopRun = …`）。而本仓大批 rr 判据是**按源码里的
 *   字面量**断言的（`/let totalCostUsed = 0;/`、`/const costRatio = costGateActive && maxCost > 0 …/`…）。
 *   文字搬去哪个文件只是落点（`engineSrcFiles()` 已解决这一层），但**绑定的拼法**也变了——
 *   于是判据切不到针脚、报成"该功能没接线"，读起来像真回归，实为"针脚跟着落点绑定了变量名"。
 *   M9 实测一次搬迁打红 8 个套件、几十条此类假红。
 *
 * 法：成员名从 `StepScope` 接口**按符号取**（`exec-step.ts` 一处真源，不另抄名单），
 *   只删**紧邻该成员名之前**的那个 `d.`。实测并集内 `d.<成员>` 共 290 处、**全部落在 `exec-step.ts`**、
 *   文件外 0 处 ⇒ 对并集做整体还原与"只对 exec-step.ts 做"逐字等价，无须（也不该）在本文件里
 *   硬编码 "exec-step.ts" 这个文件名——文件名是落点，成员名单才是判据。
 *
 * ⚠ 这不**放宽**任何判据：它把文字还原成"同一份代码搬迁前的写法"，而扫描面仍是并集（只许更严）。
 *   反而**修正**了反向断言：若生产里真写了 `d.restarts < 3`，还原后 `restarts < 3` 命中 ⇒ 判红，
 *   而这正是那条「旧 `< 3` 已消」判据**本来**要抓的东西。
 *
 * ⚠ 将来若再做一次这种"注入前缀"的机械搬迁，须把新接口名一并纳入（或参数化）；否则同一族假红复发。
 */
export function stripStepScopePrefix(text: string, interfaceFile = 'exec-step.ts', interfaceName = 'StepScope'): string {
  const p = path.join(ROOT, CORE_DIR, interfaceFile);
  if (!fs.existsSync(p)) return text;
  const iface = fs.readFileSync(p, 'utf-8').match(new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`));
  if (!iface) return text;
  const members = [...new Set([...iface[1].matchAll(/get (\w+)\(\)/g)].map((m) => m[1]))];
  if (members.length === 0) return text;
  return text.replace(new RegExp(`\\bd\\.(${members.join('|')})\\b`, 'g'), '$1');
}

