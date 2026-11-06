/**
 * 受控回归的 build 标识**派生**模块（zx_20260912 M5）。
 *
 * 病根（见 plans/improve/zx_20260912.md §M5）：`run_features.build` 的轮次标识被**手抄**进各轮 rr 脚本，
 * 每开新轮须逐个手改 8 个旧脚本；`rr_zx_20260911_4/_5` 还各自手抄一份"哪 6 个文件要改"的清单，逐轮滚长（本轮实测 37 处 / 10 文件）。
 * 先例已判明：`rr_zx_20260909_fixes.ts` 早在 `zx_20260910_3` 就被改成"钉格式、不钉具体轮次"，理由写在原地注释里。
 *
 * 本模块把结论推到全部脚本：**轮次标识只有一处手写**（`agent-executor.ts` 的 `build:` 值，即"真源"），
 * rr 侧一律**派生**该值再核对一致性——不再有可"停更"的字面量。
 *
 * 判据（全部无字面量）：
 *   P1 源码 `build: 'zx_…'` **恰好 1 处** —— 陈旧残留比"等于某个具体值"更本质（严格强于旧的 `!/build: '<上轮>'/`）
 *   P2 形如 `zx_YYYYMMDD[_x]`
 *   P3 `plans/improve/<tag>.md` 在册 —— 写出的标签必须有方案为据
 *      （**作用域＝开发树**：`plans/improve` 不存在时豁免，见 `checkBuildPins` 内注释——发布面快照里该判据无所指）
 *   P4 `scripts/rr_<tag>.ts` 或 `scripts/rr_<tag>_*.ts` 在册 —— 标签必须有复跑脚本为据
 *   P5 全量 `rr_*.ts` 中每处**前向钉 == tag**、每处**反向钉 != tag**（逐处点名 file:line）
 *   P6 已构建时 `dist` 含 tag —— 源码 ↔ 产物同值
 */
import fs from 'node:fs';
import path from 'node:path';

export type OkFn = (cond: boolean, label: string, detail?: string) => void;

export interface BuildPin {
  /** 相对 rootDir 的路径（如 `scripts/rr_zx_20260910_6.ts`） */
  file: string;
  /** 1 起的真实行号（行保持式去注释，不因块注释换行而移位） */
  line: number;
  value: string;
  /** 前向钉＝该值"必须出现"；反向钉＝该值"不许出现" */
  kind: 'forward' | 'reverse';
}

export const ROUND_RE = /^zx_\d{8}(_\d+)?$/;

/**
 * 行保持式去注释：逐行推进块注释状态，**行号不移位**。
 * 既有脚本的 `stripComments` 用 `/\*[\s\S]*?\*\//` 整体替换会吞掉块注释内的换行，
 * 令其后所有行号前移（本轮实测：11_5 的 `540` 被扫成 `500`），故本模块不复用它。
 * 已知代价：字符串里的 `//` 会被当行注释截断（钉所在行不含此形，实测 37 处皆然）。
 */
export function stripKeepingLines(src: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    let i = 0;
    let acc = '';
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end < 0) { i = line.length; break; }
        inBlock = false;
        i = end + 2;
        acc += ' ';
      } else {
        const b = line.indexOf('/*', i);
        const l = line.indexOf('//', i);
        if (l >= 0 && (b < 0 || l < b)) { acc += line.slice(i, l); i = line.length; break; }
        if (b >= 0) { acc += line.slice(i, b); inBlock = true; i = b + 2; }
        else { acc += line.slice(i); i = line.length; }
      }
    }
    out.push(acc);
  }
  return out;
}

/** 钉形：`build: 'zx_…'` / `ROUND = 'zx_…'` / `includes('zx_…')`。词界负向断言防 `PREV_ROUND = '…'`、`SELF_ROUND = '…'` 被误判为本轮钉。 */
const PIN_RE = /(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g;

/** 从源码文本派生轮次标识及其**出现次数**（count > 1 即"陈旧残留"）。只认轮次形值，不认任意 `build: 'x'`。 */
export function deriveBuildTag(srcText: string): { tag: string; count: number } {
  const code = stripKeepingLines(srcText).join('\n');
  const hits = [...code.matchAll(/build:\s*'(zx_[0-9_]+)'/g)].map((m) => m[1]!);
  return { tag: hits[0] ?? '', count: hits.length };
}

/** 枚举脚本目录下 `rr_*.ts` 里的全部 build 钉（前向/反向），带真实 `file:line`。 */
export function scanBuildPins(scriptsDir: string, rootDir = repoRoot()): BuildPin[] {
  const pins: BuildPin[] = [];
  for (const name of fs.readdirSync(scriptsDir).filter((f) => f.startsWith('rr_') && f.endsWith('.ts')).sort()) {
    const lines = stripKeepingLines(fs.readFileSync(path.join(scriptsDir, name), 'utf-8'));
    lines.forEach((line, idx) => {
      for (const m of line.matchAll(PIN_RE)) {
        const pre = line.slice(0, m.index);
        pins.push({
          file: path.relative(rootDir, path.join(scriptsDir, name)),
          line: idx + 1,
          value: m[1]!,
          kind: pre.includes('!') ? 'reverse' : 'forward',
        });
      }
    });
  }
  return pins;
}

export function repoRoot(): string {
  return path.join(__dirname, '..', '..');
}

export interface PinCheckOpts {
  rootDir?: string;
  scriptsDir?: string;
  srcPath?: string;
  plansDir?: string;
  /** 传 '' 或省略即跳过 P6（未构建时） */
  distDir?: string;
}

/** 由 tag 派生**源码中恰好一处 build 值**所在行号（供报错定位）；无则 0。 */
function buildTagLine(srcText: string): number {
  const lines = stripKeepingLines(srcText);
  for (let i = 0; i < lines.length; i++) if (/build:\s*'zx_[0-9_]+'/.test(lines[i]!)) return i + 1;
  return 0;
}

/**
 * 播报整套判据（P1–P6）。调用方给 `ok` 回调即可——断言口径只有这一处，9 个 rr 脚本共用同一把尺。
 */
export function checkBuildPins(ok: OkFn, opts: PinCheckOpts = {}): void {
  const rootDir = opts.rootDir ?? repoRoot();
  const scriptsDir = opts.scriptsDir ?? path.join(rootDir, 'scripts');
  const srcPath = opts.srcPath ?? path.join(rootDir, 'apps/worker-ant-desktop/src/main/core/agent-executor.ts');
  const plansDir = opts.plansDir ?? path.join(rootDir, 'plans/improve');
  const rel = (p: string) => path.relative(rootDir, p);

  // ── P1 单一真源 ────────────────────────────────────────────────
  const srcText = fs.readFileSync(srcPath, 'utf-8');
  const { tag, count } = deriveBuildTag(srcText);
  ok(count === 1, `${rel(srcPath)} 中 build 轮次标识恰好 1 处（防陈旧残留）`, `实测 ${count} 处：${tag || '(未找到)'}`);
  ok(ROUND_RE.test(tag), 'build 标识格式合法（zx_YYYYMMDD[_x]）', tag || '(未找到)');

  // ── P3/P4 有据可查（标签须有方案与复跑脚本为据）──────────────────
  if (tag) {
    // P3 的**作用域**（zx_20261016_5「界」）：只对**开发树**成立——标签是本仓开发时写下的，方案也只在本仓。
    //   发布面快照（`publish-oss.ts` 已排 `plans/`）里没有 `plans/improve` ⇒ 该判据**无所指**，
    //   故**豁免而非放宽**：本地开发树上 `plans/improve` 恒在 ⇒ 走的仍是原来那条严格支，强度不变。
    //   （本地若误删 `plans/`，各套件自身的 S2「本轮方案文件在场」会红——这道网不靠 P3 兜。）
    //   ⚠ 豁免**只记一行说明、不调 ok** ⇒ 不得把"没考"记成"考过了"。
    if (fs.existsSync(plansDir)) {
      ok(fs.existsSync(path.join(plansDir, `${tag}.md`)), `方案在册：plans/improve/${tag}.md`);
    } else {
      console.log(`  · P3 豁免：本树无 ${rel(plansDir)}（发布面快照），「方案在册」判据不适用`);
    }
    const selfScript = fs.existsSync(path.join(scriptsDir, `rr_${tag}.ts`))
      || fs.readdirSync(scriptsDir).some((f) => f.startsWith(`rr_${tag}_`) && f.endsWith('.ts'));
    ok(selfScript, `复跑脚本在册：scripts/rr_${tag}.ts（或 rr_${tag}_*.ts）`);
  }

  // ── P5 全量钉子与真源一致 ──────────────────────────────────────
  const pins = scanBuildPins(scriptsDir, rootDir);
  const strayForward = pins.filter((p) => p.kind === 'forward' && p.value !== tag);
  const strayReverse = pins.filter((p) => p.kind === 'reverse' && p.value === tag);
  ok(strayForward.length === 0, `全量前向钉均等于真源 ${tag}（实测 ${pins.filter((p) => p.kind === 'forward').length} 处）`,
    strayForward.map((p) => `${p.file}:${p.line}=${p.value}`).join(' '));
  ok(strayReverse.length === 0, `全量反向钉均不等于真源 ${tag}（实测 ${pins.filter((p) => p.kind === 'reverse').length} 处）`,
    strayReverse.map((p) => `${p.file}:${p.line}=${p.value}`).join(' '));

  // ── P6 源码 ↔ 产物同值 ─────────────────────────────────────────
  if (opts.distDir) {
    let blob = '';
    let n = 0;
    try {
      const files = fs.readdirSync(opts.distDir, { recursive: true })
        .filter((f): f is string => typeof f === 'string' && f.endsWith('.js'));
      n = files.length;
      blob = files.map((f) => fs.readFileSync(path.join(opts.distDir!, f), 'utf-8')).join('\n');
    } catch { /* 未构建 */ }
    ok(n > 0, `dist 构建产物在位（${n} 个 .js）`, n ? '' : '(请先 tsup)');
    if (n > 0) {
      // 取**产物里的 build 值本身**（引号无关），而非"含该子串"——注释里的轮次名会造成假阳性（本轮实测踩到）。
      const hits = [...blob.matchAll(/build\s*:\s*['"](zx_[0-9_]+)['"]/g)].map((m) => m[1]!);
      ok(hits.length === 1 && hits[0] === tag, `产物内 build 值与源码同值（${tag}，源码行 ${buildTagLine(srcText)}）`,
        hits.length ? `实测 ${hits.length} 处：${hits.join(',')}` : '(产物内未找到 build 值，请先 tsup)');
    }
  }
}

/** 统计仍写死的 build 钉字面量（S5 用）：返回 `file:line=value` 列表，可排除个别历史文件。 */
export function listStrayPinLiterals(scriptsDir: string, exclude: string[] = [], rootDir = repoRoot()): string[] {
  return scanBuildPins(scriptsDir, rootDir)
    .filter((p) => !exclude.includes(path.basename(p.file)))
    .map((p) => `${p.file}:${p.line}=${p.value}`);
}
