/**
 * zx_20260924_1 M10 受控复跑 —— 「查了要说清跳过了什么」（F15）
 *
 * 病根：`core/tool-guards.ts` 的 `scanFile` 开头 `if (st.size >= 500_000) return;`、目录遍历里
 * 再过滤一遍 `st.size < 500_000` —— 被体积闸挡下的文件**一声不吭**。于是命中 0 时返回
 * `{ ok:true, matches:0, results:[] }`，「**查了但没有**」与「**根本没查**」是同一个符号，
 * 模型据此把「大文件里没有 X」当成结论（真库标本：`mini-mp/openapi.yaml` 659,754 字节，从未被搜过）。
 *
 * 改法（**只如实登记，不扩能力面**）：返回值增 `skipped { count, reason, samples }`，
 * **零命中时尤其必须给出**；**单文件模式一并登记**（`dirPath` 直指大文件时同样静默返回 0 命中，
 * 是同一条病根的第二处）；工具 `description` 同步写清上限（模型据此知道该改用 `read_file`）。
 * 阈值 `CONTENT_SEARCH_MAX_FILE_BYTES` **一字不动**（有意为之的性能闸；索引化/分片搜索属能力扩张，本轮不做）。
 *
 * §判据门（本仓纪律）：
 *   G-1 **真源在位**：直接 `import` 生产符号（`searchPathForPattern` + 三个常量 + 真工具表
 *       `readonlyTools`）——被删/改名 ⇒ 编译期失败，而不是"扫了个空、静默假绿"。
 *   G-2 **两只标本一起试**：该跳过的（大文件**且首行就含探针**）与该命中的（小文件含探针）
 *       同处一次扫描；反侧另配"全是小文件"与"小文件里真没有"两只。
 *   G-3 **"0 变 1"式正面断言**：改前 `skipped` 字段**根本不存在** ⇒ `skipped.count === 1` 是正面证据，
 *       不是"不抛就算过"。
 *   G-4 **门槛标本**：`MAX-1` 与 `MAX` 两件（"刚好差一个字节"），尺寸由常量派生、不手抄。
 *   G-5 **扫描面自证**：凡计数类断言一并报出实测值。
 *
 * ⚠ 本脚本**不写任何轮次字面量**（`scripts/lib/rr-pins.ts` 的 P5 逐处点名 file:line）。
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 须先于本脚本**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkBuildPins } from './lib/rr-pins.js';
import {
  searchPathForPattern, CONTENT_SEARCH_MAX_FILE_BYTES, CONTENT_SEARCH_MAX_FILE_LABEL,
  CONTENT_SEARCH_SKIP_SAMPLES_MAX,
} from '../apps/worker-ant-desktop/src/main/core/tool-guards.js';
import { readonlyTools } from '../apps/worker-ant-desktop/src/main/core/tools/readonly.js';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const MAIN = path.join(root, `${A}/src/main`);

/** 体积闸门槛（**派生**自真源，不手抄 500000）。 */
const MAX = CONTENT_SEARCH_MAX_FILE_BYTES;
/** 探针词：只用它来"证明文件里确实有"，不是轮次标识。 */
const TOKEN = 'ZZ_B10_PROBE_TOKEN_ZZ';
const ABSENT = 'ZZ_B10_TOKEN_THAT_NO_FILE_HAS_ZZ';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr_b10_'));

/** 造一个**恰好 `bytes` 字节**的文件；`withToken` 为真时**首行就含探针**。 */
function writeSized(file: string, bytes: number, withToken: boolean): number {
  const head = withToken ? `${TOKEN}\n` : 'plain-head-line\n';
  const headBuf = Buffer.from(head, 'utf-8');
  const pad = Buffer.alloc(Math.max(0, bytes - headBuf.length), 0x78 /* 'x' */);
  fs.writeFileSync(file, Buffer.concat([headBuf, pad]));
  return fs.statSync(file).size;
}
const mk = (...p: string[]) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

// ═════════════════════════════════════════════════════════════════════════
(async () => {
console.log('\n【A】正：目录模式——大文件该跳过、小文件该命中、另有一件小文件该不命中（**同一次扫描并排**）');

const dA = mk('a_dir');
writeSized(path.join(dA, 'big.txt'), MAX + 12_345, true);        // 该跳过：≥门槛**且首行含探针**
fs.writeFileSync(path.join(dA, 'small_hit.txt'), `${TOKEN}\nsecond line\n`); // 该命中
fs.writeFileSync(path.join(dA, 'small_miss.txt'), 'nothing here\n');        // 该不命中

const rA = await searchPathForPattern({ pattern: TOKEN, workingDir: dA });
ok(rA.ok, 'A-0 前置：扫描本身成功（不抛、返回 ok）', rA.ok ? '' : rA.error);
const aBigHas = fs.readFileSync(path.join(dA, 'big.txt'), 'utf-8').includes(TOKEN);
const aMissHas = fs.readFileSync(path.join(dA, 'small_miss.txt'), 'utf-8').includes(TOKEN);
// 两只标本的**自证**：跳过的那件里**确实有**这个词 ⇒ 早退不是"因为里面没有"（否则本判据的成因就记错了）。
ok(aBigHas && !aMissHas,
  'A-0b 标本自证：被跳过的大文件里**确实含**探针、不命中的小文件里**确实没有**（两句并排，排除"跳过=里面没有"的混淆）',
  `大文件含探针=${aBigHas} 小文件含探针=${aMissHas}`);

if (rA.ok) {
  ok(rA.scope === 'dir' && rA.matches === 1 && rA.results[0]?.file === 'small_hit.txt',
    'A-1 **该命中只数命中那件**：`matches === 1` 且落在 `small_hit.txt`（大文件里那行**没有被数进来**）',
    `matches=${rA.matches} files=${rA.results.map((x) => x.file).join(',')}`);
  // ★ "0 变 1"式正面断言：改动前 `skipped` 字段**根本不存在**（`undefined.count` 会抛），
  //   故这条不是"不抛就算过"，而是"新事实确实被登记了"。
  ok(rA.skipped?.count === 1,
    'A-2 ★ **该跳过被如实登记**：`skipped.count === 1`（改前无此字段；这一格记的就是那只 500KB+ 的文件）',
    `count=${String(rA.skipped?.count)} reason=${rA.skipped?.reason?.slice(0, 40)}…`);
  ok(rA.skipped?.samples?.length === 1 && rA.skipped.samples[0] === 'big.txt',
    'A-3 `samples` 给出被跳过的**相对路径**（与 `results[].file` 同一套口径，二者可并排比对）',
    `samples=${JSON.stringify(rA.skipped?.samples)}`);
  ok((rA.skipped?.reason ?? '').includes(String(MAX)) && (rA.skipped?.reason ?? '').length > 0,
    'A-4 `reason` 如实写清**是体积上限**且含门槛值本身（不是一句"跳过了一些文件"）',
    `含门槛值 ${String(MAX)}=${(rA.skipped?.reason ?? '').includes(String(MAX))}`);
} else {
  ok(false, 'A-1~A-4 因 A-0 失败无从谈起');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【B】正：单文件模式——`dirPath` 直指大文件（同一条病根的**第二处**）');

const rB1 = await searchPathForPattern({ pattern: TOKEN, workingDir: dA, dirPath: 'big.txt' });
if (rB1.ok) {
  ok(rB1.scope === 'file' && rB1.matches === 0,
    'B-1 单文件模式命中 0（文件里其实**有**这个词——A-0b 已证 ⇒ 这个 0 是"跳过"造成的，不是"没有"）',
    `matches=${rB1.matches}`);
  ok(rB1.skipped?.count === 1 && rB1.skipped.samples[0] === 'big.txt',
    'B-2 ★ **单文件模式同样如实登记**：`skipped.count === 1` 且 samples 含 `big.txt`（改前此处静默返回 0）',
    `count=${String(rB1.skipped?.count)} samples=${JSON.stringify(rB1.skipped?.samples)}`);
} else { ok(false, 'B-1/B-2 因路径不存在失败', rB1.error); }

const rB3 = await searchPathForPattern({ pattern: TOKEN, workingDir: dA, dirPath: 'small_hit.txt' });
ok(rB3.ok && rB3.matches === 1 && rB3.skipped?.count === 0,
  'B-3 单文件模式的**反侧标本**：小文件照常扫描、`skipped.count === 0`（不是"单文件模式恒报跳过了 1 个"）',
  rB3.ok ? `matches=${rB3.matches} skipped=${rB3.skipped.count}` : rB3.error);

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【C】反（防过宽）：「查了但真没有」与「根本没查」在返回值上必须分得开');

const dC = mk('c_dir');
fs.writeFileSync(path.join(dC, 'only_small_a.txt'), `${TOKEN}\n`);
fs.writeFileSync(path.join(dC, 'only_small_b.txt'), 'irrelevant\n');
const rC1 = await searchPathForPattern({ pattern: TOKEN, workingDir: dC });
ok(rC1.ok && rC1.skipped?.count === 0 && rC1.skipped.samples.length === 0,
  'C-1 **全是小文件 ⇒ `skipped.count === 0`**（不得恒报"跳过了 1 个"——这是判"字段被写死"的那只标本）',
  rC1.ok ? `matches=${rC1.matches} skipped=${rC1.skipped.count} samples=${JSON.stringify(rC1.skipped.samples)}` : rC1.error);

const rC2 = await searchPathForPattern({ pattern: ABSENT, workingDir: dC });
ok(rC2.ok && rC2.matches === 0 && rC2.skipped?.count === 0,
  'C-2 **真没有**：`matches === 0` **且** `skipped.count === 0`（与 B-1「matches 0 但 skipped 1」并排 ⇒ 两件事分得开）',
  rC2.ok ? `matches=${rC2.matches} skipped=${rC2.skipped.count}` : rC2.error);
if (rC1.ok && rB1.ok && rC2.ok) {
  ok(rB1.matches === rC2.matches && rB1.skipped.count !== rC2.skipped.count,
    'C-3 两样本并排：`matches` 都是 0，而 `skipped.count` 一个 1 一个 0 ⇒ 光看 matches 区分不出的两件事，现在**返回值上**分得开',
    `大文件: matches=0 skipped=${rB1.skipped.count} ｜ 小文件真没有: matches=0 skipped=${rC2.skipped.count}`);
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【D】边界：恰好差一个字节（尺寸由常量派生，不手抄）');

const dD = mk('d_edge');
const sizeLo = writeSized(path.join(dD, 'edge_below.txt'), MAX - 1, true);
const sizeHi = writeSized(path.join(dD, 'edge_at.txt'), MAX, true);
ok(sizeLo === MAX - 1 && sizeHi === MAX,
  'D-0 前置：两件标本**确实**恰好是门槛下 1 字节与门槛本身（尺寸读回核对，不是"我以为是"）',
  `${sizeLo} / ${sizeHi}（门槛 ${MAX}）`);
const rD = await searchPathForPattern({ pattern: TOKEN, workingDir: dD });
ok(rD.ok && rD.matches === 1 && rD.results[0]?.file === 'edge_below.txt',
  'D-1 **门槛下侧被扫**：`MAX-1` 字节那件（同样含探针）照常命中 ⇒ 判据是"≥"而非"见大就跳"',
  rD.ok ? `matches=${rD.matches} files=${rD.results.map((x) => x.file).join(',')}` : rD.error);
ok(rD.ok && rD.skipped?.count === 1 && rD.skipped.samples[0] === 'edge_at.txt',
  'D-2 **门槛上侧被登记**：恰好 `MAX` 字节那件被跳过 ⇒ 门槛值确实落在 `MAX`（不是"随便大一点就算"）',
  rD.ok ? `skipped=${rD.skipped.count} samples=${JSON.stringify(rD.skipped.samples)}` : rD.error);

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【E】`samples` 只取前几条（如实登记 ≠ 把全量路径塞回上下文）');

const dE = mk('e_many');
const manyN = CONTENT_SEARCH_SKIP_SAMPLES_MAX + 2;
for (let i = 0; i < manyN; i++) writeSized(path.join(dE, `big_${String(i).padStart(2, '0')}.txt`), MAX, true);
const rE = await searchPathForPattern({ pattern: TOKEN, workingDir: dE });
ok(rE.ok && rE.skipped?.count === manyN,
  `E-1 跳过大文件 ${manyN} 件时 \`count\` 数**全**（count 是"有几个"，不是"给了几条"）`,
  rE.ok ? `count=${rE.skipped.count}` : rE.error);
ok(rE.ok && rE.skipped?.samples.length === CONTENT_SEARCH_SKIP_SAMPLES_MAX,
  `E-2 \`samples\` 截到上限 ${CONTENT_SEARCH_SKIP_SAMPLES_MAX} 条（上限派生自真源常量，不手抄数字）`,
  rE.ok ? `samples=${rE.skipped.samples.length} 条` : rE.error);

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【F】边界裁定：被 `fileTypes` 排除的文件**不在扫描面内**，不记成"跳过"（如实 ≠ 见大就报）');

const dF = mk('f_types');
writeSized(path.join(dF, 'in_scope.txt'), MAX, true);   // 用户在扫描面内 ⇒ 该记
writeSized(path.join(dF, 'out_scope.bin'), MAX, true);  // 被用户显式过滤掉 ⇒ 不该记
const rF1 = await searchPathForPattern({ pattern: TOKEN, workingDir: dF, fileTypes: '.txt' });
ok(rF1.ok && rF1.skipped?.count === 1 && rF1.skipped.samples[0] === 'in_scope.txt',
  'F-1 带 `fileTypes` 时只记**扫描面内**那件（`.txt`）——被显式过滤的 `.bin` 不算"跳过"',
  rF1.ok ? `count=${rF1.skipped.count} samples=${JSON.stringify(rF1.skipped.samples)}` : rF1.error);
const rF2 = await searchPathForPattern({ pattern: TOKEN, workingDir: dF });
ok(rF2.ok && rF2.skipped?.count === 2,
  'F-2 不带 `fileTypes` 时两件都进扫描面 ⇒ `count === 2`（反证 F-1 的 1 不是"只数得出一件"）',
  rF2.ok ? `count=${rF2.skipped.count} samples=${JSON.stringify(rF2.skipped.samples)}` : rF2.error);

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【G】接线：模型看得到的说明与返回值（**真跑生产工具表**，不是扫源码字符串）');

const roSrc = fs.readFileSync(path.join(MAIN, 'core/tools/readonly.ts'), 'utf-8');
const scBlock = (() => {
  // 按符号切块（工具名 → 下一个同缩进的键），不按行号。
  const lines = roSrc.split('\n');
  const s = lines.findIndex((l) => l === '    search_content: {');
  if (s < 0) return '';
  let e = lines.length;
  for (let i = s + 1; i < lines.length; i++) {
    if (/^    [A-Za-z_][A-Za-z0-9_]*: \{$/.test(lines[i]!) || lines[i] === '  };') { e = i; break; }
  }
  return lines.slice(s, e).join('\n');
})();
ok(scBlock.length > 0, 'G-0 前置：按符号切出 `search_content` 工具体（切不到则下面两条无从谈起）', `${scBlock.split('\n').length} 行`);
ok(/skipped: r\.skipped/.test(scBlock),
  'G-1 `execute` 把 `skipped` 一并带出（漏了它，生产里那句"如实"就只活在判据里、模型永远看不到）');
ok(scBlock.includes('CONTENT_SEARCH_MAX_FILE_LABEL') && scBlock.includes('read_file'),
  'G-2 `description` 同步写清上限并指向 `read_file`，且门槛值**派生**自常量（不是手抄一份"500KB"）');

// 真跑工具表：`readonlyTools` 的构造不触库（`db`/`ctx` 只在各 execute 内部用），故喂最小 deps 即可。
// zx_20261002 M17-①: `readFiles` 是「先读后改」的共享状态（生产由 `buildTools` 建），夹具同形给一份空集。
const tools = readonlyTools({ workingDir: dA, ctx: {}, db: {}, taskId: 'probe', projectId: 'probe', readFiles: new Set<string>() } as never);
const scDesc = tools.search_content.description;
ok(typeof scDesc === 'string' && scDesc.includes(String(MAX)) && scDesc.includes(CONTENT_SEARCH_MAX_FILE_LABEL)
  && scDesc.includes('read_file'),
  'G-3 **模型真读到的**说明里确有体积上限（含 `MAX` 与派生标签两种写法）与 `read_file` 指引',
  `description=${String(scDesc).slice(0, 72)}…`);
const scOut = await tools.search_content.execute({ pattern: TOKEN });
const scJson: Record<string, unknown> = JSON.parse(scOut);
ok(scJson.matches === 1 && typeof scJson.skipped === 'object' && scJson.skipped !== null
  && (scJson.skipped as { count: number }).count === 1,
  'G-4 真跑 `execute` 的 **JSON 载荷**里有 `skipped`（工具层的"另一道出口"没有把它丢掉——SSE/落库那条路才谈得上如实）',
  `payload keys=${Object.keys(scJson).join(',')} skipped=${JSON.stringify(scJson.skipped)}`);
const scOutFile = await tools.search_content.execute({ pattern: TOKEN, dirPath: 'big.txt' });
const scJsonFile: Record<string, unknown> = JSON.parse(scOutFile);
ok(scJsonFile.matches === 0 && (scJsonFile.skipped as { count: number } | undefined)?.count === 1,
  'G-5 单文件模式经 `execute` 出口同样带出 `skipped`（G-4 的反侧：0 命中的那次**不是**什么都没说）',
  `matches=${String(scJsonFile.matches)} skipped=${JSON.stringify(scJsonFile.skipped)}`);

fs.rmSync(tmp, { recursive: true, force: true });

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【S】build 钉（派生核对，不写轮次字面量）');
checkBuildPins(ok, { distDir: path.join(root, 'apps/worker-ant-desktop/dist') });

console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260924_1_b10: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
})();
