/**
 * zx_20260921（D2「引擎看不见附件内容」）：PDF 正文抽取——**要么取出真文字，要么如实说取不出来**。
 *
 * 病根：`read_file` 只读 utf-8，PDF 进了上下文**也只能是文件名**；模型拿到「report.pdf + 一个路径」，
 * 既不能摘要也不能问答。做这件事的第一原则**不是"能抽多少"而是"绝不把乱码当正文"**——模型对乱码的
 * 反应是**编**（硬着头皮把控制字符解释成内容），那比"读不了"糟得多。故本模块宁可返回 `ok:false`。
 *
 * 为什么零依赖：本仓刻意不引新 npm 依赖（新增原生模块会牵动 `scripts/rebuild-ans-native.sh` 的
 * Node/Electron ABI 切换）。故只用 `node:zlib` 解 FlateDecode，其余（对象扫描、CMap、内容流词法）全手写。
 *
 * **可读性判据**（本模块存在的核心理由）——**两道闸，任一不过即判失败**：
 *   ① `可读字符占比 < 0.6`（`READABLE_RATIO_MIN`）。取 0.6 的依据：真实正文即便夹着零星未映射字形
 *      （U+FFFD）或私有区码位，占比通常 >0.95；而「字形索引被当字节读」型乱码（子集字体最常见的
 *      失败形态，码常从 0x01 起）密集落在 C0/C1 控制区，实测占比 0.0%。0.6 落在两簇之间且明显偏向
 *      "宁可判失败"一侧——它要挡的是**假绿**（乱码被当正文），不是误杀。
 *   ② `未映射字节的 ASCII 占比 < 0.7`（`RAW_ASCII_RATIO_MIN`，样本 ≥24 时才判）。**① 单独一道不够**：
 *      latin1 解码下**全字节域随机数据自身的可读占比就有 ~75%**（0x20–0x7E 与 0xA0–0xFF 都算可读），
 *      实测 20 份随机字节内容流有 5 份能从闸①漏过去。合法的不带 ToUnicode 的简单字体 PDF，其字节流
 *      必然是 ASCII 主导的 WinAnsi/latin1 文本（西里尔/中日韩在 WinAnsi 里表示不出来，这类文档一定带
 *      ToUnicode）⇒ 第二道关正好卡住随机噪声、放行带重音符号的西欧文本。
 *   ⚠ **两道闸的实测边界（如实记录，不粉饰）**：`RAW_MIN_SAMPLE` 是"宁可放过不可误杀"的豁免——
 *      短串（一个项目符号、一个破折号、一句「Ça été」）天然非 ASCII 占比高，判了就是误杀合法文档。
 *      实测 **每 200 份全字节域随机**内容流仍有 **1–2 份（0.5%–1.0%）** 漏过两道闸（两次取样），
 *      漏过的都是 <24 字节的短串。这是刻意留下的取舍，不是为了好看；而**真实**失效形态
 *      （纯图形 PDF / 字形索引 CID / 加密）无一漏网。
 *
 * 注：`node:zlib` 之外只用 `Buffer` 与正则；本文件**不 import 任何仓库内模块**（可单测、可被 rr 直接 import）。
 *
 * ⚠ **不支持清单**（如实列出，覆盖面宁少报不多报）：
 *   - 不读交叉引用表（线性扫 `N G obj`）⇒ **对象流**（`/Type /ObjStm`，PDF 1.5+ 常见）里的页字典解析
 *     不到；这类文档走"扫全部含 BT 的流"兜底（正文多半仍能取出，但 `pages` 会退化成 1）。
 *   - `/Encrypt` 一律不解（不实现 RC4/AES）；只报 `encrypted`。
 *   - 非 FlateDecode 的过滤器（DCTDecode/JPXDecode/CCITTFax/LZW）一律跳过，不做解码。
 *   - CMap：不跟 `usecmap`，不处理 3/4 字节码位，不处理 `bfrange` 目标为代理对跨 BMP 的情况；
 *     同一 `/F1` 资源名在不同页指向不同字体时会串（先到先得）。
 *   - 无 ToUnicode 时按单字节 latin1 近似（不实现 PDFDocEncoding 的 0x18–0x1F 差异），
 *     故 WinAnsi 单字节字体的西欧重音符号可能不准。
 *   - 不解析 `/XObject` 引用做定向递归，而是**把全部含 `BT` 的可解流都当正文扫**（含 Form XObject、
 *     注释外观流）⇒ 极端情况下可能重复或串入非页正文内容。
 */
import zlib from 'node:zlib';

export const PDF_MAX_PAGES: number = 20;
export const PDF_MAX_CHARS: number = 40000;

/** 可读字符占比下限，低于它宁可判失败也不把乱码当正文（取值依据见文件头）。 */
const READABLE_RATIO_MIN = 0.6;

/**
 * **未经 ToUnicode 解释**的那部分字节里，ASCII 可打印字符的占比下限（样本 < `RAW_MIN_SAMPLE` 时不判）。
 *
 * 为什么单靠 `READABLE_RATIO_MIN` 不够：latin1 解码下**全字节域随机数据本身的"可读占比"就有 ~75%**
 * （0x20–0x7E 与 0xA0–0xFF 都算可读），实测 20 份随机字节内容流有 5 份能从 0.6 那道闸漏过去。
 * 而合法的不带 ToUnicode 的简单字体 PDF，其字节流必然是 **WinAnsi/latin1 的、ASCII 主导的**文本
 * （西里尔/中日韩在 WinAnsi 里根本表示不出来，这类文档一定带 ToUnicode）⇒ 用"ASCII 主导"再把一道关，
 * 正好卡住随机噪声、放行带重音符号的西欧文本。
 */
const RAW_ASCII_RATIO_MIN = 0.7;
/** 样本不足时不判——短串（一个项目符号、一个破折号）天然 100% 非 ASCII，判了就是误杀。 */
const RAW_MIN_SAMPLE = 24;

/** TJ 数组里字距调整小于此值即认为"这里有个空格"（-1000 ≈ 1em）。 */
const TJ_SPACE_THRESHOLD = -100;

export type PdfTextFailure = 'encrypted' | 'no_text_layer' | 'cid_unsupported' | 'parse_error';

export type PdfTextResult =
  | { ok: true; text: string; pages: number; truncated: boolean }
  | { ok: false; reason: PdfTextFailure; detail?: string };

/** 一个间接对象：`dict` 是 `obj` 与 `stream`/`endobj` 之间的原文（**不含流体内字节**）。 */
interface PdfObj {
  num: number;
  dict: string;
  hasStream: boolean;
  streamStart: number;
  streamEnd: number;
}

/** 一张 ToUnicode 映射：码位 → 真 Unicode。`codeBytes` 是每个码占的字节数（来自 codespacerange）。 */
interface CodeMap {
  map: Map<number, string>;
  codeBytes: number;
}

/** 抽取过程中的诊断计数——判 `cid_unsupported` 时要说得出「映射命中几个、落空几个」。 */
interface TextStats {
  ops: number;
  mapped: number;
  missed: number;
  blind: number;
  /** **未经 ToUnicode 解释**的字节数，以及其中 ASCII 可打印的个数（见 `RAW_ASCII_RATIO_MIN`）。 */
  rawChars: number;
  rawAscii: number;
}

type Operand =
  | { k: 'str'; b: string }
  | { k: 'num'; v: number }
  | { k: 'name'; v: string }
  | { k: 'arr'; items: Operand[] }
  | { k: 'other' };

export function extractPdfText(buf: Buffer, opts?: { maxPages?: number; maxChars?: number }): PdfTextResult {
  try {
    const maxPages = Math.max(1, Math.floor(opts?.maxPages ?? PDF_MAX_PAGES));
    const maxChars = Math.max(1, Math.floor(opts?.maxChars ?? PDF_MAX_CHARS));
    if (!Buffer.isBuffer(buf) || buf.length < 16) {
      return { ok: false, reason: 'parse_error', detail: `输入过小或非 Buffer（${Buffer.isBuffer(buf) ? buf.length : typeof buf} 字节）` };
    }

    // latin1 解码**逐字节保序**（1 字符 = 1 字节），故字符串下标即字节偏移，后续切片不必再换算。
    const s = buf.toString('latin1');
    if (!s.slice(0, 1024).includes('%PDF-')) {
      return { ok: false, reason: 'parse_error', detail: '缺少 %PDF- 魔数' };
    }

    const objs = findObjects(s);
    if (hasEncrypt(s, objs)) {
      return { ok: false, reason: 'encrypted', detail: '文档带 /Encrypt（本模块不解密）' };
    }

    // 一次遍历把流分成两类：ToUnicode CMap 与正文候选。
    const cmaps = new Map<number, CodeMap>();
    const streams = new Map<number, string>();
    for (const o of objs) {
      if (!o.hasStream) continue;
      const d = decodeStream(s, o, buf);
      if (!d || d.length === 0) continue;
      const t = d.toString('latin1');
      if (t.includes('beginbfchar') || t.includes('beginbfrange')) {
        const cm = parseCMap(t);
        if (cm) cmaps.set(o.num, cm);
      } else {
        streams.set(o.num, t);
      }
    }

    const { global, byObj } = buildFontMaps(objs, cmaps);
    const stats: TextStats = { ops: 0, mapped: 0, missed: 0, blind: 0, rawChars: 0, rawAscii: 0 };
    const pageObjs = objs.filter((o) => /\/Type\s*\/Page\b(?!s)/.test(o.dict));
    let pagesText: string[] = [];

    for (const p of pageObjs) {
      const fm = pageFontMap(p, objs, byObj) ?? global;
      let t = '';
      for (const content of resolveContents(p, streams)) {
        t += extractFromContent(content, (name) => fm.get(name) ?? null, stats);
      }
      pagesText.push(t);
    }

    // 兜底：页路径一个文本操作符都没捞到（对象流页字典、或夹具没有页对象）⇒ 扫全部含 BT 的可解流。
    if (stats.ops === 0 && streams.size > 0) {
      let t = '';
      for (const src of streams.values()) {
        if (!/\bBT\b/.test(src)) continue;
        t += extractFromContent(src, (name) => global.get(name) ?? null, stats);
      }
      if (t.trim()) pagesText = [t];
    }

    if (stats.ops === 0) {
      return {
        ok: false,
        reason: 'no_text_layer',
        detail: `未找到任何文本操作符（扫 ${objs.length} 个对象 / ${pageObjs.length} 个页 / ${streams.size} 个可解流）`,
      };
    }

    const pageCount = pageObjs.length > 0 ? pageObjs.length : 1;
    // 逐页清理再拼：内容流结尾本来就带换行（`ET`），直接 join 会在页间多出一整行空白。
    let text = cleanup(pagesText.slice(0, maxPages).map(cleanup).filter((t) => t.length > 0).join('\n'));
    if (!text) {
      return { ok: false, reason: 'no_text_layer', detail: `有 ${stats.ops} 个文本操作符但未产出可见字符` };
    }

    const ratio = readableRatio(text);
    const rawRatio = stats.rawChars >= RAW_MIN_SAMPLE ? stats.rawAscii / stats.rawChars : 1;
    if (ratio < READABLE_RATIO_MIN || rawRatio < RAW_ASCII_RATIO_MIN) {
      const why = ratio < READABLE_RATIO_MIN
        ? `可读字符占比 ${(ratio * 100).toFixed(1)}% < ${READABLE_RATIO_MIN * 100}%`
        : `未映射字节的 ASCII 占比 ${(rawRatio * 100).toFixed(1)}% < ${RAW_ASCII_RATIO_MIN * 100}%（样本 ${stats.rawChars}）`;
      return {
        ok: false,
        reason: 'cid_unsupported',
        detail:
          `${why}；ToUnicode 命中 ${stats.mapped} 字 / 未命中 ${stats.missed} 字 / 整串无覆盖 ${stats.blind} 次`,
      };
    }

    let truncated = pageCount > maxPages;
    if (text.length > maxChars) {
      let cut = text.slice(0, maxChars);
      if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // 别把代理对劈成半个
      text = cut;
      truncated = true;
    }
    return { ok: true, text, pages: pageCount, truncated };
  } catch (e) {
    return { ok: false, reason: 'parse_error', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── 对象与流 ───────────────────────────────────────────────────────────────

function findObjects(s: string): PdfObj[] {
  const out: PdfObj[] = [];
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const dictStart = m.index + m[0].length;
    const endObj = s.indexOf('endobj', dictStart);
    const limit = endObj < 0 ? s.length : endObj;
    const body = s.slice(dictStart, limit);
    // `stream` 必须是**关键字**（其后紧跟 EOL）——否则 `/Streams` 这类名字会被误认。
    const sm = /(?:[\s>]|^)stream(\r\n|\r|\n)/.exec(body);
    if (!sm) {
      out.push({ num: Number(m[1]), dict: body, hasStream: false, streamStart: 0, streamEnd: 0 });
      re.lastIndex = limit;
      continue;
    }
    const streamStart = dictStart + sm.index + sm[0].length;
    const dict = body.slice(0, sm.index);
    let streamEnd = -1;
    const lm = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    if (lm) {
      const cand = streamStart + Number(lm[1]);
      if (cand <= limit && /^\s*endstream/.test(s.slice(cand, cand + 24))) streamEnd = cand;
    }
    if (streamEnd < 0) {
      const e = s.indexOf('endstream', streamStart);
      streamEnd = e < 0 ? limit : e;
    }
    out.push({ num: Number(m[1]), dict, hasStream: true, streamStart, streamEnd });
    re.lastIndex = streamEnd; // 别扫进流体内（二进制里出现 "N 0 obj" 的概率不为零）
  }
  return out;
}

/**
 * `/Encrypt` 只落在**非流区**（trailer / 字典）⇒ 把流体内字节排掉再找，免得把「正文讲到加密算法」
 * 的文档误判成加密文件。
 */
function hasEncrypt(s: string, objs: PdfObj[]): boolean {
  if (!s.includes('/Encrypt')) return false;
  const withStream = objs.filter((o) => o.hasStream).sort((a, b) => a.streamStart - b.streamStart);
  if (withStream.length === 0) return true;
  let acc = '';
  let i = 0;
  for (const o of withStream) {
    if (o.streamStart < i) continue;
    acc += s.slice(i, o.streamStart);
    i = o.streamEnd;
  }
  acc += s.slice(i);
  return acc.includes('/Encrypt');
}

/** 解压一条流。FlateDecode（含 `[/FlateDecode]`）走 zlib；其余过滤器一律放弃（见文件头不支持清单）。 */
function decodeStream(s: string, o: PdfObj, buf: Buffer): Buffer | null {
  const raw = buf.subarray(o.streamStart, o.streamEnd);
  const f = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(o.dict);
  if (!f) return raw.length ? raw : null; // 未声明 Filter ⇒ 裸流
  if (!f[1].includes('/FlateDecode')) return null;
  try {
    return zlib.inflateSync(raw);
  } catch {
    try {
      return zlib.inflateRawSync(raw);
    } catch {
      return null; // 解压失败只跳过这一条流，不整体失败
    }
  }
}

// ── ToUnicode CMap ─────────────────────────────────────────────────────────

function hexUnits(hex: string): number[] {
  const h = hex.replace(/[^0-9A-Fa-f]/g, '');
  const out: number[] = [];
  for (let i = 0; i + 4 <= h.length; i += 4) out.push(parseInt(h.slice(i, i + 4), 16));
  return out;
}

function unitsToStr(units: number[]): string {
  if (units.length === 0) return '';
  let out = '';
  for (let i = 0; i < units.length; i += 512) out += String.fromCharCode(...units.slice(i, i + 512));
  return out;
}

function hexToStr(hex: string): string {
  return unitsToStr(hexUnits(hex));
}

/** 解析 `beginbfchar`/`beginbfrange`/`begincodespacerange`。认不出任何条目 ⇒ null（当它不存在）。 */
function parseCMap(text: string): CodeMap | null {
  const map = new Map<number, string>();
  let srcHexLen = 0;
  const noteWidth = (h: string) => { const n = h.replace(/[^0-9A-Fa-f]/g, '').length; if (n > srcHexLen) srcHexLen = n; };

  for (const blk of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f\s]+)>/g)) {
      const code = parseInt(p[1], 16);
      if (!Number.isFinite(code)) continue;
      noteWidth(p[1]);
      map.set(code, hexToStr(p[2]));
    }
  }
  for (const blk of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = blk[1];
    for (const p of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f\s]+)>|\[([\s\S]*?)\])/g)) {
      const lo = parseInt(p[1], 16);
      const hi = parseInt(p[2], 16);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 0xffff) continue;
      noteWidth(p[1]);
      if (p[3] !== undefined) {
        const units = hexUnits(p[3]);
        if (units.length === 0) continue;
        const span = hi - lo;
        for (let k = 0; k <= span; k++) {
          const u = units.slice();
          u[u.length - 1] = (u[u.length - 1] + k) & 0xffff;
          map.set(lo + k, unitsToStr(u));
        }
      } else {
        const list = Array.from(p[4].matchAll(/<([0-9A-Fa-f\s]+)>/g)).map((x) => hexToStr(x[1]));
        for (let k = 0; k < list.length; k++) map.set(lo + k, list[k]);
      }
    }
  }
  if (map.size === 0) return null;

  // codespacerange 是码宽的第一手信息（比从关键字长度猜可靠）；没有它才退回"见到的最大源码宽"。
  let csHexLen = 0;
  for (const blk of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    for (const p of blk[1].matchAll(/<([0-9A-Fa-f]+)>/g)) {
      if (p[1].length > csHexLen) csHexLen = p[1].length;
    }
  }
  const width = csHexLen || srcHexLen || 4;
  return { map, codeBytes: Math.max(1, Math.round(width / 2)) };
}

// ── 字体 → CMap 关联 ───────────────────────────────────────────────────────

function dictAt(src: string, lt: number): string {
  let depth = 0;
  let i = lt;
  while (i < src.length) {
    if (src[i] === '<' && src[i + 1] === '<') { depth++; i += 2; }
    else if (src[i] === '>' && src[i + 1] === '>') { depth--; i += 2; if (depth === 0) return src.slice(lt, i); }
    else i++;
  }
  return src.slice(lt);
}

function fontEntries(dictBody: string, byObj: Map<number, CodeMap>, into: Map<string, CodeMap>): void {
  for (const e of dictBody.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    const cm = byObj.get(Number(e[2]));
    if (cm && !into.has(e[1])) into.set(e[1], cm);
  }
}

function fontDicts(dict: string): string[] {
  const out: string[] = [];
  const re = /\/Font\s*<<|(\/Font\s+(\d+)\s+\d+\s+R)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(dict)) !== null) {
    if (m[2]) out.push(`__ref__${m[2]}`);
    else out.push(dictAt(dict, dict.indexOf('<<', m.index)));
  }
  return out;
}

function buildFontMaps(objs: PdfObj[], cmaps: Map<number, CodeMap>): { global: Map<string, CodeMap>; byObj: Map<number, CodeMap> } {
  const byObj = new Map<number, CodeMap>();
  for (const o of objs) {
    const m = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(o.dict);
    if (!m) continue;
    const cm = cmaps.get(Number(m[1]));
    if (cm) byObj.set(o.num, cm);
  }
  const global = new Map<string, CodeMap>();
  for (const o of objs) {
    for (const fd of fontDicts(o.dict)) {
      if (fd.startsWith('__ref__')) {
        const target = objs.find((x) => x.num === Number(fd.slice(7)));
        if (target) fontEntries(target.dict, byObj, global);
      } else {
        fontEntries(fd, byObj, global);
      }
    }
  }
  return { global, byObj };
}

/** 页自己的 `/Resources` → `/Font`；拿不到就返回 null，由调用方退到全局表。 */
function pageFontMap(page: PdfObj, objs: PdfObj[], byObj: Map<number, CodeMap>): Map<string, CodeMap> | null {
  const dict = page.dict;
  let res: string | null = null;
  const ind = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(dict);
  if (ind) {
    const o = objs.find((x) => x.num === Number(ind[1]));
    res = o ? o.dict : null;
  } else {
    const at = dict.indexOf('/Resources');
    if (at >= 0) {
      const lt = dict.indexOf('<<', at);
      if (lt >= 0) res = dictAt(dict, lt);
    }
  }
  if (!res) return null;
  const m = new Map<string, CodeMap>();
  for (const fd of fontDicts(res)) {
    if (!fd.startsWith('__ref__')) fontEntries(fd, byObj, m);
  }
  return m.size > 0 ? m : null;
}

function resolveContents(page: PdfObj, streams: Map<number, string>): string[] {
  const m = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(page.dict);
  if (!m) return [];
  const out: string[] = [];
  for (const r of m[1].matchAll(/(\d+)\s+\d+\s+R/g)) {
    const t = streams.get(Number(r[1]));
    if (t) out.push(t);
  }
  return out;
}

// ── 内容流词法 ─────────────────────────────────────────────────────────────

const WS = ' \t\r\n\f\0';
const DELIM = '()<>[]{}/%';

function readLiteral(src: string, i: number): { value: string; next: number } {
  const n = src.length;
  let depth = 1;
  let j = i + 1;
  let out = '';
  while (j < n) {
    const c = src[j];
    if (c === '\\') {
      const e = src[j + 1];
      if (e === undefined) { j++; break; }
      if (e === '\r' || e === '\n') { j += e === '\r' && src[j + 2] === '\n' ? 3 : 2; continue; } // 续行
      const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
      if (simple[e] !== undefined) { out += simple[e]; j += 2; continue; }
      if (e >= '0' && e <= '7') {
        let oct = e;
        let k = j + 2;
        while (oct.length < 3 && k < n && src[k] >= '0' && src[k] <= '7') { oct += src[k]; k++; }
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        j = k;
        continue;
      }
      out += e;
      j += 2;
      continue;
    }
    if (c === '(') { depth++; out += c; j++; continue; }
    if (c === ')') { depth--; if (depth === 0) break; out += c; j++; continue; }
    out += c;
    j++;
  }
  return { value: out, next: j + 1 };
}

function readHexString(src: string, i: number): { value: string; next: number } {
  const n = src.length;
  let j = i + 1;
  let h = '';
  while (j < n && src[j] !== '>') {
    const c = src[j];
    if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) h += c;
    j++;
  }
  if (h.length % 2) h += '0';
  let out = '';
  for (let k = 0; k < h.length; k += 2) out += String.fromCharCode(parseInt(h.slice(k, k + 2), 16));
  return { value: out, next: j + 1 };
}

function skipDict(src: string, i: number): number {
  const n = src.length;
  let depth = 0;
  let j = i;
  while (j < n) {
    if (src[j] === '<' && src[j + 1] === '<') { depth++; j += 2; }
    else if (src[j] === '>' && src[j + 1] === '>') { depth--; j += 2; if (depth === 0) return j; }
    else j++;
  }
  return n;
}

function readName(src: string, i: number): { value: string; next: number } {
  const n = src.length;
  let j = i + 1;
  let out = '';
  while (j < n && !WS.includes(src[j]) && !DELIM.includes(src[j])) {
    if (src[j] === '#' && /^[0-9A-Fa-f]{2}$/.test(src.slice(j + 1, j + 3))) {
      out += String.fromCharCode(parseInt(src.slice(j + 1, j + 3), 16));
      j += 3;
    } else {
      out += src[j];
      j++;
    }
  }
  return { value: out, next: j };
}

function readNumber(src: string, i: number): { value: number; next: number } | null {
  const m = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(src.slice(i, i + 24));
  if (!m) return null;
  const v = Number(m[0]);
  if (!Number.isFinite(v)) return null;
  return { value: v, next: i + m[0].length };
}

function readOp(src: string, i: number): { op: string; next: number } {
  const n = src.length;
  let j = i;
  while (j < n && /[A-Za-z*'"]/.test(src[j])) j++;
  if (j === i) return { op: src[i], next: i + 1 }; // 认不出的定界符：吃掉一字节，保证推进
  return { op: src.slice(i, j), next: j };
}

function noteRaw(bytes: string, stats: TextStats): void {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes.charCodeAt(i) & 0xff;
    stats.rawChars++;
    if ((b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d) stats.rawAscii++;
  }
}

/** 一个字符串 → 文字。有 CMap 用 CMap；整串一个码都没命中 ⇒ 退回单字节（并按 `blind` 记账）。 */
function showString(bytes: string, cm: CodeMap | null, stats: TextStats): string {
  if (!cm) { noteRaw(bytes, stats); return bytes; }
  const w = cm.codeBytes;
  let out = '';
  let hits = 0;
  let misses = 0;
  for (let i = 0; i + w <= bytes.length; i += w) {
    let code = 0;
    for (let k = 0; k < w; k++) code = (code << 8) | (bytes.charCodeAt(i + k) & 0xff);
    const ch = cm.map.get(code);
    if (ch !== undefined) { out += ch; hits++; } else misses++;
  }
  const rem = bytes.length % w;
  for (let i = bytes.length - rem; rem > 0 && i < bytes.length; i++) {
    const ch = cm.map.get(bytes.charCodeAt(i) & 0xff);
    if (ch !== undefined) { out += ch; hits++; } else misses++;
  }
  if (hits === 0 && misses > 0) {
    stats.blind++;
    noteRaw(bytes, stats);
    return bytes;
  }
  stats.mapped += hits;
  stats.missed += misses;
  return out;
}

function extractFromContent(src: string, pickCmap: (fontName: string) => CodeMap | null, stats: TextStats): string {
  let out = '';
  let cm: CodeMap | null = null;
  let ops: Operand[] = [];
  const arrStack: Operand[][] = [];
  const n = src.length;
  let i = 0;

  const push = (o: Operand) => {
    if (arrStack.length > 0) arrStack[arrStack.length - 1].push(o);
    else ops.push(o);
  };
  const newline = () => { if (out && !out.endsWith('\n')) out += '\n'; };
  const lastStr = (): string | null => {
    const o = ops[ops.length - 1];
    return o && o.k === 'str' ? o.b : null;
  };
  const show = (b: string) => { out += showString(b, cm, stats); };

  while (i < n) {
    const c = src[i];
    if (WS.includes(c)) { i++; continue; }
    if (c === '%') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    if (c === '(') { const r = readLiteral(src, i); push({ k: 'str', b: r.value }); i = r.next; continue; }
    if (c === '<') {
      if (src[i + 1] === '<') { i = skipDict(src, i); push({ k: 'other' }); continue; }
      const r = readHexString(src, i);
      push({ k: 'str', b: r.value });
      i = r.next;
      continue;
    }
    if (c === '[') { arrStack.push([]); i++; continue; }
    if (c === ']') { push({ k: 'arr', items: arrStack.pop() ?? [] }); i++; continue; }
    if (c === '/') { const r = readName(src, i); push({ k: 'name', v: r.value }); i = r.next; continue; }
    if (c === '{') {
      let d = 0;
      let j = i;
      while (j < n) {
        if (src[j] === '{') d++;
        else if (src[j] === '}') { d--; if (d === 0) { j++; break; } }
        j++;
      }
      i = j;
      push({ k: 'other' });
      continue;
    }
    if (c === ')' || c === '>' || c === '}') { i++; continue; }
    if (c === '+' || c === '-' || c === '.' || (c >= '0' && c <= '9')) {
      const r = readNumber(src, i);
      if (r) { push({ k: 'num', v: r.value }); i = r.next; continue; }
    }

    const { op, next } = readOp(src, i);
    i = next;
    switch (op) {
      case 'Tf': {
        for (let k = ops.length - 1; k >= 0; k--) {
          const o = ops[k];
          if (o.k === 'name') { cm = pickCmap(o.v); break; }
        }
        break;
      }
      case 'Tj': {
        stats.ops++;
        const b = lastStr();
        if (b !== null) show(b);
        break;
      }
      case 'TJ': {
        stats.ops++;
        for (let k = 0; k < ops.length; k++) {
          const o = ops[k];
          if (o.k !== 'arr') continue;
          for (const it of o.items) {
            if (it.k === 'str') show(it.b);
            // 负的字距调整量 ≈ 拉开了一个空格（启发式，阈值见常量）
            else if (it.k === 'num' && it.v < TJ_SPACE_THRESHOLD && out && !out.endsWith(' ')) out += ' ';
          }
        }
        break;
      }
      case "'":
      case '"': {
        stats.ops++;
        newline();
        const b = lastStr();
        if (b !== null) show(b);
        break;
      }
      case 'Td':
      case 'TD': {
        const last = ops[ops.length - 1];
        const prev = ops[ops.length - 2];
        if (prev && prev.k === 'num' && last && last.k === 'num' && last.v !== 0) newline();
        break;
      }
      case 'T*':
        newline();
        break;
      case 'ET':
        newline();
        break;
      default:
        break;
    }
    ops = [];
  }
  return out;
}

// ── 可读性与清理 ───────────────────────────────────────────────────────────

/** 可读 = 真能显示的字。控制字符、代理区、私有区、U+FFFD 一律算不可读（依据见文件头）。 */
function isReadableChar(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  if (c === 0xfffd) return false;
  if (c === 0x09 || c === 0x0a || c === 0x0d) return true;
  if (c < 0x20) return false;
  if (c >= 0x7f && c <= 0x9f) return false;
  if (c >= 0xd800 && c <= 0xdfff) return false;
  if (c >= 0xe000 && c <= 0xf8ff) return false;
  if (c === 0xfffe || c === 0xffff) return false;
  return true;
}

function readableRatio(text: string): number {
  let good = 0;
  let total = 0;
  for (const ch of text) {
    total++;
    if (isReadableChar(ch)) good++;
  }
  return total === 0 ? 0 : good / total;
}

function cleanup(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
