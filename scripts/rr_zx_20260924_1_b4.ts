/**
 * zx_20260924_1 批次 M4 受控复跑 —— 「装了的要通电，没通电的要说清」
 * （对应方案 §1.5 F5 / §1.6 F6 与 §M4；用户裁定 J-3 = 只修失效的硬拒 + 如实登记，不改命令拦截面）
 *
 * ── M4-a：沙箱的硬边界，此前一句空话 ─────────────────────────────────────────────
 *   `core/sandbox.ts` 的 `SENSITIVE_PATHS` 里四项 `~/.ssh/` `~/.gnupg/` `~/.aws/` `~/.config/`
 *   **死两遍**：
 *     ① 与恒为绝对路径的 `resolved` 比对（`resolved.startsWith('~/.ssh/')` 永远为假）；
 *     ② 整块敏感检查被 `if (!isInsideWorkspace && !isInsideUserHome)` 包住，而这四项**恰恰全在家目录内**
 *        ⇒ 目标在家目录时根本不进那个循环。
 *   结果 `~/.ssh/id_rsa` 直落**软边界**分支（`allowed:false` 但 `approvable:true`）⇒ 用户点一次审批，
 *   就能拿到写 `authorized_keys` 的放行 —— 注释里写的"硬边界，不可审批"与实现相反。
 *   现：`~` 归一到 `homeDir()`（与 `~/` 展开同用一处，不写第二份展开），家目录**不再**享受整块豁免。
 *
 * ── M4-b：零调用的闸门如实登记 ───────────────────────────────────────────────────
 *   `spawnSandboxed`（sandbox-runtime.ts）与 `validateBashCommand`（sandbox.ts）零调用方；
 *   `PathRules` 的 `denyPaths`/`allowPaths` 与 `enforcePathScope` 的 `mode==='strict'` 分支同样零调用。
 *   本脚本**就地复核**这三条结论（复核不成立则如实报回，而不是照着错前提写注记）。
 *
 * §G 不变式门：
 *   G-1 **真源在位**：`enforcePathScope` / `homeDir` / `isDangerousRemovalPath` 都是**直接 import 生产实现**
 *       真跑（不是在本脚本里抄一份等价物 —— 那叫「判据的自我印证」，本仓大忌）；符号被删/改名 ⇒ 编译期先红。
 *   G-2 **两只标本一起试**：每条判据两侧都有真标本（该硬拒 / 该放行 / 该不命中），
 *       且"该放行"与"该硬拒"**同处一个家目录下**——只试一侧的话，任何过宽或过窄的变体都会全票通过。
 *   G-3 **扫描面自证**：凡"零命中"类断言一并报出扫描面，并配一把"该非空"的负向对照自证扫描器非恒假。
 *
 * ⚠ 本脚本**不写任何轮次字面量**（`scripts/lib/rr-pins.ts` 的 P5 会全量点名 file:line）；
 *   本脚本自己的轮次标识一律由 `path.basename(__filename)` 派生。
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkBuildPins } from './lib/rr-pins.js';
import {
  enforcePathScope, homeDir, isDangerousRemovalPath,
} from '../apps/worker-ant-desktop/src/main/core/sandbox.js';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const MAIN = path.join(root, `${A}/src/main`);

// 家目录**与生产同一处**（就是 enforcePathScope 内部用的那个函数）——本脚本不另写 os.homedir()，
// 否则"生产按哪个家目录判、判据按哪个家目录试"就成了两件事，判据会在错的样本上全绿。
const HOME = homeDir();
// 工作目录刻意设在**家目录之内**：这样"该硬拒"（~/.ssh）与"该放行"（家目录普通文件）用的是同一个 home，
// 两条判据合起来才能证"家目录这道 gate 真的开了，且没开过头"。
const WS = path.join(HOME, 'projects', 'wa', 'ws');
const MODE = 'workspace' as const;

console.log(`\n【A】该硬拒：家目录内的敏感子目录（改前一律是"可审批放行"）`);
console.log(`  标本基准：home=${HOME} ws=${WS}`);

for (const rel of ['.ssh/id_rsa', '.aws/credentials', '.gnupg/x', '.config/x']) {
  const r = enforcePathScope(path.join(HOME, rel), WS, MODE);
  ok(r.allowed === false && r.approvable !== true,
    `A-1 **该硬拒**：<home>/${rel} ⇒ allowed:false 且**不带** approvable（硬边界，不可审批）`,
    `allowed=${r.allowed} approvable=${String(r.approvable)} resolved=${r.resolvedPath}`);
}

// A-2 改写形（`~/…` 而非绝对路径）：这一条专测"`~` 归一"那段——若归一没做，它会同 A-1 一样落软边界，
//     或被 `validatePathSafety` 之外的路径处理漏掉。用生产入参形状（工具里模型写的就是 `~/.ssh/id_rsa`）。
const tilde = enforcePathScope('~/.ssh/id_rsa', WS, MODE);
ok(tilde.allowed === false && tilde.approvable !== true,
  'A-2 **该硬拒**（`~/` 写法）：`~/.ssh/id_rsa` 与绝对路径同判 ⇒ 归一真的生效了（不是只在绝对路径上成立）',
  `allowed=${tilde.allowed} approvable=${String(tilde.approvable)} resolved=${tilde.resolvedPath}`);
ok(tilde.resolvedPath === path.join(HOME, '.ssh', 'id_rsa'),
  'A-2b 归一的落点是**本脚本与生产共用的那个 homeDir()**（展开结果 = path.join(homeDir(), ".ssh", "id_rsa")）',
  `resolved=${tilde.resolvedPath}`);

// A-3 目录本身（`resolved === abs` 那一支）也要拒：只写 startsWith(abs + sep) 的话，`~/.ssh` 这个**目录本身**会漏网
const dirItself = enforcePathScope(path.join(HOME, '.ssh'), WS, MODE);
ok(dirItself.allowed === false && dirItself.approvable !== true,
  'A-3 敏感目录**本身**（`<home>/.ssh`，无尾随子路径）同样硬拒（覆盖 `resolved === abs` 那一支）',
  `allowed=${dirItself.allowed} approvable=${String(dirItself.approvable)}`);

console.log(`\n【B】该放行：不得因为修敏感路径而误伤正常写入`);

// B-1 家目录内**普通**文件仍是软边界 —— 这是"gate 开了但没开过头"的那只标本：
//     若 `/Users` 那条特例没跟着搬家（或搬了不生效），下面这条会变成硬拒。
const notes = enforcePathScope(path.join(HOME, 'notes.txt'), WS, MODE);
ok(notes.allowed === false && notes.approvable === true,
  'B-1 **该放行**：<home>/notes.txt ⇒ 仍是软边界（allowed:false + approvable:true）。' +
  '家目录内的普通文件从来就是软边界，本批不许把它变成硬拒',
  `allowed=${notes.allowed} approvable=${String(notes.approvable)} reason=${notes.reason}`);
// B-1b 与 A-1 并排：同一个家目录下，`.ssh` 硬、`notes.txt` 软 ⇒ 敏感判定是"按目录"而非"按家目录整块"
const sshAgain = enforcePathScope(path.join(HOME, '.ssh', 'id_rsa'), WS, MODE);
ok(sshAgain.allowed === false && sshAgain.approvable !== true && notes.approvable === true,
  'B-1b **两侧并排**（同一 home）：`.ssh/id_rsa` 硬拒 / `notes.txt` 软放行 —— ' +
  '证明敏感检查是"逐项命中"而不是"家目录一律拒"（过宽变体会被这条抓住）',
  `ssh.approvable=${String(sshAgain.approvable)} notes.approvable=${String(notes.approvable)}`);

// B-2 工作目录内普通文件：必须**原样放行**（本批唯一的行为改动不该波及工作目录）
const inWs = enforcePathScope(path.join(WS, 'a.txt'), WS, MODE);
ok(inWs.allowed === true, 'B-2 **该放行**：工作目录内普通文件 ⇒ allowed:true（工作目录仍是任务自己的地盘）',
  `allowed=${inWs.allowed} resolved=${inWs.resolvedPath}`);
const wsItself = enforcePathScope(WS, WS, MODE);
ok(wsItself.allowed === true, 'B-2b 工作目录**本身**也放行（`resolved === wsResolved` 那一支）',
  `allowed=${wsItself.allowed}`);

console.log(`\n【C】该不命中：比较必须带分隔符（防过宽）`);

// C-1 同名前缀：`.ssh-backup` 不是 `.ssh`。裸 `startsWith` 会把它误判成敏感目录 ⇒ 一刀切硬拒。
const backup = enforcePathScope(path.join(HOME, 'projects', 'foo', '.ssh-backup', 'x'), WS, MODE);
ok(backup.allowed === false && backup.approvable === true,
  'C-1 **该不命中**：<home>/projects/foo/.ssh-backup/x 不得被判成 `~/.ssh` ⇒ 仍是普通软边界',
  `allowed=${backup.allowed} approvable=${String(backup.approvable)} reason=${backup.reason}`);
const cfgBak = enforcePathScope(path.join(HOME, 'projects', 'foo', '.config.bak', 'x'), WS, MODE);
ok(cfgBak.approvable === true,
  'C-1b 第二只同名前缀标本：`.config.bak` 也不得判成 `~/.config`（不是只对 `.ssh` 恰巧成立）',
  `approvable=${String(cfgBak.approvable)}`);

console.log(`\n【D】反证与"行为不变"清单`);

// D-0 前提：反证标本必须真的在**本机家目录之外**，否则这条判据自己就站不住
const OTHER = '/Users/otheruser/x';
ok(OTHER !== HOME && !OTHER.startsWith(HOME + path.sep),
  'D-0 反证标本的前提成立：`/Users/otheruser/x` 不在本机家目录内（前提不成立时下面的断言无意义）',
  `home=${HOME}`);
const other = enforcePathScope(OTHER, WS, MODE);
ok(other.allowed === false && other.approvable !== true,
  'D-1 **反证**：别人家目录里的路径仍**硬拒**（`/Users` 那条例外只放行"当前用户"的家目录，没把家目录外一并放掉）',
  `allowed=${other.allowed} approvable=${String(other.approvable)} reason=${other.reason}`);

// D-2 行为不变清单：这些项本批一个字都不该动（各配一只标本，防止"顺手改坏"）
const unchanged: Array<[string, string, boolean]> = [
  ['/etc/passwd', path.join('/', 'etc', 'passwd'), false],
  ['/proc/', path.join('/', 'proc', 'cpuinfo'), false],
  ['/sys/', path.join('/', 'sys', 'x'), false],
  ['/dev/', path.join('/', 'dev', 'null'), false],
  ['/root/', path.join('/', 'root', 'x'), false],
  ['.env（家目录内）', path.join(HOME, '.env'), true],
  ['node_modules/（家目录内）', path.join(HOME, 'projects', 'foo', 'node_modules', 'x'), true],
  ['.git/（家目录内）', path.join(HOME, 'projects', 'foo', '.git', 'config'), true],
];
for (const [name, p, soft] of unchanged) {
  const r = enforcePathScope(p, WS, MODE);
  ok(soft ? r.approvable === true : (r.allowed === false && r.approvable !== true),
    `D-2 行为不变：${name} ⇒ ${soft ? '仍走软边界' : '仍硬拒'}`,
    `allowed=${r.allowed} approvable=${String(r.approvable)} resolved=${r.resolvedPath}`);
}

// D-3 家目录口径归一后，`isDangerousRemovalPath` 的既有语义不受影响（它改用了同一个 homeDir()）
ok(isDangerousRemovalPath('~') === true && isDangerousRemovalPath(path.join(HOME, 'x')) === false
  && isDangerousRemovalPath(path.join(HOME, 'x')) === false && isDangerousRemovalPath('/') === true
  && isDangerousRemovalPath('~/x') === false,
  'D-3 家目录口径归一后 `isDangerousRemovalPath` 语义不变（两只标本：`~` 家目录本身⇒危险、`~/x` 子路径⇒不危险）',
  `~=${isDangerousRemovalPath('~')} ~/x=${isDangerousRemovalPath('~/x')}`);

console.log(`\n【F】M4-b 零调用核对（扫描面 = src/main 下全部 .ts，定义文件剔除后另计）`);

const mainFiles: string[] = [];
(function walk(dir: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts')) mainFiles.push(p);
  }
})(MAIN);
const srcOf = (p: string) => fs.readFileSync(p, 'utf-8');
const DEF_SB = path.join(MAIN, 'core/sandbox.ts');
const DEF_RT = path.join(MAIN, 'core/sandbox-runtime.ts');
const sandboxSrc = srcOf(DEF_SB);
const rtSrc = srcOf(DEF_RT);

/** 在扫描面内按**出现次数**数某个调用形（剔除定义文件本身） */
function occurrencesOut(re: RegExp, defFiles: string[]): Array<{ file: string; n: number }> {
  const out: Array<{ file: string; n: number }> = [];
  for (const p of mainFiles) {
    if (defFiles.includes(p)) continue;
    const n = (srcOf(p).match(re) || []).length;
    if (n) out.push({ file: path.relative(root, p), n });
  }
  return out;
}
const fmt = (sites: Array<{ file: string; n: number }>) => sites.map(s => `${s.file}×${s.n}`).join(' ') || '(零命中)';

ok(mainFiles.length > 50 && sandboxSrc.includes('export function enforcePathScope('),
  'F-0 扫描面自证：src/main 下 .ts 数 > 50，且定义文件确实在扫描面内（否则"零命中"只是扫了个空）',
  `${mainFiles.length} 个 .ts`);

// F-1 spawnSandboxed：零调用 + 整个 sandbox-runtime 模块无人 import
const spawnSites = occurrencesOut(/\bspawnSandboxed\(/g, [DEF_RT]);
ok(spawnSites.length === 0, 'F-1 **零调用（复核属实）**：`spawnSandboxed(` 在 src/main 内零调用点', fmt(spawnSites));
const rtImporters = mainFiles.filter(p => p !== DEF_RT && /from\s+'[^']*sandbox-runtime\.js'/.test(srcOf(p)));
ok(rtImporters.length === 0,
  'F-1b 连带事实复核：整个 `sandbox-runtime.ts` 无外部 import ⇒ 进程级 Seatbelt 隔离从未生效',
  rtImporters.length ? rtImporters.map(p => path.relative(root, p)).join(' ') : `扫描面 ${mainFiles.length} 个 .ts，零导入`);

// F-2 validateBashCommand：零调用
const vbcSites = occurrencesOut(/\bvalidateBashCommand\(/g, [DEF_SB]);
ok(vbcSites.length === 0, 'F-2 **零调用（复核属实）**：`validateBashCommand(` 零调用点 ⇒ 网络/进程拦截从未接线', fmt(vbcSites));

// F-3/F-4 唯一的调用面：enforcePathScope 两处，且都不带 rules、不传 strict
const scopeSites = occurrencesOut(/\benforcePathScope\(/g, [DEF_SB]);
const scopeTotal = scopeSites.reduce((s, x) => s + x.n, 0);
ok(scopeTotal === 2 && scopeSites.every(s => s.file.endsWith('core/tools/write.ts')),
  'F-3 调用面自证：`enforcePathScope` 恰 2 处调用，且都在 core/tools/write.ts（与方案 §1.5 记的一致）',
  `实测 ${scopeTotal} 处：${fmt(scopeSites)}`);
const writeSrc = srcOf(path.join(MAIN, 'core/tools/write.ts'));
const writeCalls = [...writeSrc.matchAll(/enforcePathScope\(([^)]*)\)/g)].map(m => m[1]!.replace(/\s+/g, ' ').trim());
ok(writeCalls.length === 2 && writeCalls.every(a => a.endsWith("'workspace'")),
  'F-4 两处调用都只传三参、第三参恒为 `\'workspace\'` ⇒ `PathRules`（无 rules 实参）与 `mode===\'strict\'` 分支零调用属实',
  writeCalls.join(' | '));
// ⚠ 扫描面**按名字的唯一性分开定**：`allowPaths` 与 sandbox-runtime.ts 里 `spawnSandboxed` 的
//   opts 形参**撞名**（那是 Seatbelt profile 的放行目录，与 `PathRules` 是两个东西）——
//   合并成一条正则数会把 5 处同名形参记成"有调用方"，故 `denyPaths`（唯一）与 `allowPaths`（须剔同名形参）分列。
const denySites = occurrencesOut(/\bdenyPaths\b/g, [DEF_SB]);
ok(denySites.length === 0, 'F-5 **零调用（复核属实）**：`denyPaths`（PathRules 专有，名唯一）在定义文件之外零出现', fmt(denySites));
const allowSites = occurrencesOut(/\ballowPaths\b/g, [DEF_SB, DEF_RT]);
ok(allowSites.length === 0,
  'F-5b **零调用（复核属实）**：`allowPaths` 除 sandbox.ts 与 sandbox-runtime.ts（同名形参，非 PathRules）外零出现',
  `${fmt(allowSites)}（已剔除 sandbox-runtime.ts 的 ${(rtSrc.match(/\ballowPaths\b/g) || []).length} 处同名形参）`);

// F-6 负向对照：同一把尺量一个**确有**调用点的符号，必须非空（否则上面的"零命中"全是假绿）
const ccSites = occurrencesOut(/\bclassifyBashCommand\(/g, [DEF_SB]);
ok(ccSites.length >= 1,
  'F-6 **扫描器自证非恒假**：同一把尺量 `classifyBashCommand(` 应命中（它在 tools/shell.ts 有真实调用点）',
  fmt(ccSites));
const promptSites = occurrencesOut(/\bgetSandboxPrompt\(/g, [DEF_SB]);
ok(promptSites.length === 1 && promptSites[0]!.file.endsWith('core/exec-context.ts'),
  'F-7 提示词那一路的调用面复核：`getSandboxPrompt(` 恰 1 处、在 exec-context.ts（方案 §1.6 记的调用面）',
  fmt(promptSites));

console.log(`\n【G】M4-b 登记注记在位（本轮只登记，不接线、不删、不改提示词措辞）`);

const SELF = path.basename(__filename);
const selfTag = SELF.match(/^rr_(zx_\d{8}(?:_\d+)?)_b4\.ts$/)?.[1] ?? '';
ok(selfTag !== '', 'G-0 本脚本轮次标识由**文件名派生**（不手抄字面量，故不会成为"只为下一轮"的哑雷）', SELF);

const noteRe = /当前无调用方，见 `plans\/improve\/(zx_\d{8}(?:_\d+)?)\.md` §4/g;
const notesInSpan = (src: string, a: number, b: number) => (a >= 0 && b > a ? [...src.slice(a, b).matchAll(noteRe)].length : -1);
const sbNotes = [...sandboxSrc.matchAll(noteRe)].map(m => m[1]!);
const rtNotes = [...rtSrc.matchAll(noteRe)].map(m => m[1]!);
ok(sbNotes.length === 3, 'G-1 sandbox.ts 恰三处注记（PathRules / strict 分支 / validateBashCommand）',
  `实测 ${sbNotes.length} 处`);
ok(rtNotes.length === 1, 'G-2 sandbox-runtime.ts 恰一处注记（spawnSandboxed）', `实测 ${rtNotes.length} 处`);
// 落点须与符号对齐：注释写在第 3 个函数头上、却声称登记第 1 个，等于没登记
const iRules = sandboxSrc.indexOf('export interface PathRules');
const iStrict = sandboxSrc.indexOf("if (mode === 'strict') {");
const iVbc = sandboxSrc.indexOf('export function validateBashCommand(');
ok(notesInSpan(sandboxSrc, iRules - 520, iRules) === 1,
  'G-1a PathRules 那处注记落在其**声明之前**的头注释里（锚点按符号取，不按行号）', `锚点偏移 ${iRules}`);
ok(notesInSpan(sandboxSrc, iStrict, iStrict + 420) === 1,
  'G-1b strict 分支内一处（谈的是"从未被执行过"，必须落在分支体内而非别处）', `锚点偏移 ${iStrict}`);
ok(notesInSpan(sandboxSrc, iVbc - 800, iVbc) === 1,
  'G-1c validateBashCommand 头注释里一处', `锚点偏移 ${iVbc}`);
// 方向性比较：注记指向的轮次**不得早于**本脚本轮次（由载体自身派生，非字面量等值断言）
const noteTags = [...new Set([...sbNotes, ...rtNotes])];
ok(noteTags.length > 0 && noteTags.every(t => t >= selfTag),
  'G-3 注记指向的轮次**不早于**本脚本轮次（方向性比较 ⇒ 下一轮把注记改指向新方案也不会引红）',
  `本脚本派生 ${selfTag} / 注记指向 ${noteTags.join(',')}`);
ok(noteTags.every(t => fs.existsSync(path.join(root, 'plans/improve', `${t}.md`))),
  'G-4 注记指向的方案文件**在册**（指向一份不存在的方案等于没登记）',
  noteTags.map(t => `plans/improve/${t}.md`).join(' '));

// G-5 对外可见文案本批**未动**：V-4「提示词说禁 curl/wget、实现不拦」本轮只登记 ⇒ 措辞原样保留
ok(/禁止 curl\/wget 等网络操作（git clone除外）/.test(sandboxSrc),
  'G-5 提示词措辞未被本批改动（V-4 属待裁决：登记，不改措辞、不接线）—— 修改此句必红，逼下轮先裁后改');

console.log(`\n【S】build 钉（派生核对，不写轮次字面量）`);
checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260924_1_b4: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
