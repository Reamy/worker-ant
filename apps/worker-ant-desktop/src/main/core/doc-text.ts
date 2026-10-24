/**
 * zx_20260924 M1（维特根斯坦·意义即使用 / 康德·概念无直观则空）：**文档族的其余格式也要有明确去向**。
 *
 * 病根：`zx_20260921` 只把 PDF 接上了（`pdf-text.ts`），文档族里的 `.txt/.md/.json/.csv/.docx`
 * 在 `attachment-inline.ts:219` 一律落 `not_yet_supported`——用户发进来一份 `.docx` 报告或一份 `.md` 笔记，
 * 模型只拿到一个文件名，既不能摘要也不能问答。本模块把这几种格式补上：
 * **要么取出真文字，要么如实说取不出来**。
 *
 * 与 `pdf-text.ts` 同一手法：**纯 `Buffer → 结果`**，只用 `node:zlib` 与一个**自身零 import** 的仓内模块。
 * 为什么零外部依赖：本仓刻意不引新 npm 依赖（新增原生模块会牵动 `scripts/rebuild-ans-native.sh` 的
 * Node/Electron ABI 切换）。故 rr 可直接 `import` 本模块跑**真实现**，无需桩。
 *
 * ⚠ **zx_20260930 M12 就地订正**：此处原先写的是"**零仓库 import**"。M12 把"哪些扩展名算纯文本"的
 *   真源收进 `attachment-kinds.ts`（本模块改引它的 `TEXT_EXTS`），那条**字面口径已不成立**——如实改成
 *   "**依赖闭包内无重依赖**"：本模块引的每一个仓内模块其自身**零仓内 import**（`attachment-kinds.ts`
 *   头部就写着"本模块零 import"）⇒ 传递闭包仍只有 `node:*`，"rr 直跑真实现"这条**性质不变**。
 *   受控回归里钉这条的判据（`rr_zx_20260924` G-3）已同步改钉**这个性质**，不是把数字改小了事。
 *
 * **两道闸，宁可判失败也不把乱码当正文**（模型对乱码的反应是**编**，那比"读不了"糟得多）：
 *   ① `NUL 字节占比 > 1%`（`NUL_RATIO_MAX`）⇒ `binary`。真 UTF-8 文本里 NUL **恒为 0**；
 *      抽样窗口内出现成片 NUL，说明这件东西根本不是文本（压缩包 / 可执行 / 被改了扩展名的二进制）。
 *      这是"判型由产物本身定"（承 `zx_20260911_1`）在**文本**这一族的落点。
 *   ② 无 BOM 且按 UTF-8 解码后 `U+FFFD 占比 > 2%`（`REPLACEMENT_RATIO_MAX`）⇒ `unsupported_encoding`。
 *      GBK/Shift-JIS 等按 UTF-8 解码时双字节序列大多非法，替换率实测通常 > 20%；而合法 UTF-8 文本的
 *      U+FFFD 只可能来自作者自己写下的替换符（极罕见）。2% 落在两簇之间且明显偏向"宁可判失败"一侧——
 *      它要挡的是**假绿**（GBK 被当正文喂给模型），不是误杀。
 *      **不猜 GBK**：猜错一次就是把一份乱码当正文（用户 2026-09-24 裁决：如实拒绝并说明，不猜编码）。
 *
 * ⚠ **如实登记的边界**（宁少报不多报）：
 *   - BOM 只认 UTF-8 / UTF-16LE / UTF-16BE。**无 BOM 的 UTF-16 会被判 `binary`**——ASCII 文本的
 *     UTF-16 每两字节一个 0x00，NUL 占比 50%，闸①先响。这是保守取舍（不确定就别猜），不是漏做。
 *   - **非 UTF-8 的西欧文本（latin1/Windows-1252）同样判 `unsupported_encoding`**——本模块只认
 *     UTF-8 与带 BOM 的 UTF-16，其余一律如实拒绝（同上：不猜）。
 *   - `.doc`（OLE 复合文档）**不解析**，一律 `doc_legacy_unsupported`；用户仍可自行取件。
 *   - `.docx` 走手写 ZIP 解析：**不支持 ZIP64**（>4GB 条目）与加密条目；只取 `word/document.xml`，
 *     **不取批注 / 脚注 / 页眉 / 域代码**（`w:instrText` 与 `w:delText` 会随标签一起被剥掉或留下一部分）。
 *   - `.xlsx` 只取**单元格缓存值**（`sharedStrings` / `inlineStr` / `<v>`）：公式取 Excel 保存时的
 *     计算结果，**不求值**；批注、图表、图片、条件格式、隐藏列全不取。工作表按 `workbook.xml`
 *     的声明顺序输出；解析不到 workbook 时按 `xl/worksheets/sheetN.xml` 文件序，名称记作 `Sheet N`。
 *   - `.pptx` 只取幻灯片正文的 `<a:t>`：**不取演讲者备注 / 图表 / SmartArt / 图片替代文字**；
 *     页序按 `presentation.xml` 的 `sldIdLst`（拿不到时按文件名数字序）。空白页仍保留页号。
 *   - `detail` **不带盘上路径**（与 `pdf-text.ts` 同形）——路径由**调用方**在 marker/文案里拼
 *     （`attachment-inline.ts` 与 `tools/media.ts` 两处调用点都拼"原件在 …"）。这是调用点的判据，
 *     不是本模块的事；本模块保持"零 fs 语义"才能被 rr 直接跑。
 */
import zlib from 'node:zlib';

// zx_20260930 M12: "哪些扩展名算纯文本"的真源**只有一份**（`attachment-kinds.TEXT_EXTS`）——
//   本模块与装配层/renderer 两侧读同一份，不再各持一张表。
import { TEXT_EXTS } from './attachment-kinds.js';

/** 与 `PDF_MAX_CHARS` 同量级：两者都是"一件附件最多往上下文里放多少字"的同一档预算。 */
export const DOC_MAX_CHARS: number = 40000;

/** 判二进制/判编码的抽样窗口（字节）。取 8K：够看到一段有代表性的字节分布，又不至于被大文件拖慢。 */
const SAMPLE_BYTES = 8192;

/** NUL 占比上限。真文本恒为 0，取 1% 是给"夹了零星 NUL 的畸形文本"留的余量（取值依据见文件头闸①）。 */
const NUL_RATIO_MAX = 0.01;

/** 替换字符（U+FFFD）占比上限（无 BOM 时）。取值依据见文件头闸②。 */
const REPLACEMENT_RATIO_MAX = 0.02;

export type DocTextFailure = 'binary' | 'unsupported_encoding' | 'doc_legacy_unsupported' | 'parse_error';

export type DocTextResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; reason: DocTextFailure; detail?: string };

/**
 * 按 UTF-8 / BOM 判定的纯文本扩展名。**由真源派生**（`attachment-kinds.TEXT_EXTS`）。
 *
 * zx_20260930 M12 前这里是 4 个字的字面量（`.txt/.md/.json/.csv`）⇒ 用户附进来的 `.ts/.yaml/.log`
 * 一律落 `not_yet_supported`（源码进不了上下文）。清单本身挪到零依赖的 `attachment-kinds.ts`，
 * 本处只做 `Set` 包装（查表 O(1)）。
 */
const PLAIN_TEXT_EXTS = new Set<string>(TEXT_EXTS);

/**
 * 本模块**认下**的扩展名。调用方（`attachment-inline.ts` / `tools/media.ts`）用它判"该不该走这条路"——
 * 导出的理由是**词表只能有一份**（手抄第二份就是 G8/G9 的老病：改一处忘另一处）。
 */
export function isDocTextExt(ext: string): boolean {
  const e = (ext || '').toLowerCase();
  return e === '.doc' || e === '.docx' || e === '.xlsx' || e === '.pptx' || PLAIN_TEXT_EXTS.has(e);
}

export function extractDocText(buf: Buffer, ext: string): DocTextResult {
  if (!Buffer.isBuffer(buf)) {
    return { ok: false, reason: 'parse_error', detail: `输入非 Buffer（${typeof buf}）` };
  }
  const e = (ext || '').toLowerCase();
  if (e === '.doc') {
    // **不看内容、只看扩展名**：真 .doc 的头是 OLE 复合文档（D0 CF 11 E0 A1 B1 1A E1），解析它要
    // OLE 目录 + Word 二进制格式两套实现，收益未裁定（§4 挂账）⇒ 如实拒绝，并给出**可行动作**。
    return {
      ok: false,
      reason: 'doc_legacy_unsupported',
      detail: '老 .doc（OLE 复合文档）不支持直接解析；请转存为 .docx 或 .txt 后重发',
    };
  }
  if (e === '.docx') return extractDocx(buf);
  if (e === '.xlsx') return extractXlsx(buf);
  if (e === '.pptx') return extractPptx(buf);
  if (PLAIN_TEXT_EXTS.has(e)) return extractPlainText(buf);
  return {
    ok: false,
    reason: 'parse_error',
    // ⚠ 不再把整张清单列进这句话（M12 后它有 50+ 项，列出来是噪音、且每加一个扩展名就得改文案）。
    detail: `不支持的文档扩展名 ${ext || '(无)'}（本模块认下 ${PLAIN_TEXT_EXTS.size} 种纯文本/源码/配置/日志扩展名，外加 .doc/.docx/.xlsx/.pptx；PDF 归 pdf-text.ts）`,
  };
}

/** 收尾：截断到预算之内，并把"截过"这件事**如实带出来**（调用方据此在抬头里写"已截断"）。 */
function clip(text: string): DocTextResult {
  if (text.length > DOC_MAX_CHARS) {
    return { ok: true, text: text.slice(0, DOC_MAX_CHARS), truncated: true };
  }
  return { ok: true, text, truncated: false };
}

function stripBomChar(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** UTF-16BE：Node 只有 `utf16le`，逐对换字节即可（字节级交换，代理对不受影响）。 */
function decodeUtf16Be(buf: Buffer): string {
  const n = buf.length - (buf.length % 2);
  const swapped = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i += 2) {
    swapped[i] = buf[i + 1]!;
    swapped[i + 1] = buf[i]!;
  }
  return swapped.toString('utf16le');
}

/**
 * **纯文本解码闸**——`extractDocText`（附件预算）与 `read_file`（点名整读）**共用这一把尺**。
 *
 * 为什么抽成一处（zx_20260930 M12）：判"这是不是可解码的文本"若在两处各写一遍，就是"这处有闸那处
 *   没有"（本轮 §M12「判限口径统一」）。旧 `read_file` 直接 `readFile(…, 'utf-8')`：一份 GBK 文件
 *   **静默**变成一坨 U+FFFD 喂给模型——模型对乱码的反应是**编**，比"读不了"糟得多（与文件头闸②同理）。
 *
 * **本函数不截断**（与 `DocTextResult.truncated` 无关）：闸只判"能不能解"，不做字符预算——
 *   `extractDocText` 之后才 `clip`；而 `read_file` 要**整读后按行分页**，先截字符会把行边界弄错
 *   （正是 `zx_20260913` M4-5 修过的病）。
 */
export function decodePlainText(
  buf: Buffer,
): { ok: true; text: string } | { ok: false; reason: DocTextFailure; detail?: string } {
  if (!Buffer.isBuffer(buf)) {
    return { ok: false, reason: 'parse_error', detail: `输入非 Buffer（${typeof buf}）` };
  }
  if (buf.length === 0) return { ok: true, text: '' };

  // ① BOM 先判：UTF-16 的 ASCII 文本天然一半是 NUL，**先谈 NUL 会把它们全误杀**。
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { ok: true, text: stripBomChar(buf.subarray(2).toString('utf16le')) };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { ok: true, text: stripBomChar(decodeUtf16Be(buf.subarray(2))) };
  }
  const hasUtf8Bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const body = hasUtf8Bom ? buf.subarray(3) : buf;

  // ② NUL 闸：真二进制挂了文本扩展名。
  const n = Math.min(body.length, SAMPLE_BYTES);
  let nul = 0;
  for (let i = 0; i < n; i++) if (body[i] === 0) nul++;
  if (n > 0 && nul / n > NUL_RATIO_MAX) {
    return {
      ok: false,
      reason: 'binary',
      detail: `抽样 ${n} 字节中 ${nul} 个 NUL 字节（${((nul / n) * 100).toFixed(1)}%），判为二进制而非文本`,
    };
  }

  // ③ 编码闸：只认 UTF-8，不猜 GBK。
  const text = body.toString('utf8');
  const m = Math.min(text.length, SAMPLE_BYTES);
  let bad = 0;
  for (let i = 0; i < m; i++) if (text.charCodeAt(i) === 0xfffd) bad++;
  if (m > 0 && bad / m > REPLACEMENT_RATIO_MAX) {
    return {
      ok: false,
      reason: 'unsupported_encoding',
      detail: `抽样 ${m} 字符中 ${bad} 个无法按 UTF-8 解码（${((bad / m) * 100).toFixed(1)}%），疑似 GBK 等非 UTF-8 编码；请转存为 UTF-8 后重发`,
    };
  }
  return { ok: true, text: stripBomChar(text) };
}

function extractPlainText(buf: Buffer): DocTextResult {
  const d = decodePlainText(buf);
  if (!d.ok) return d;
  // CRLF 归一在**闸之后**：闸看的是原文（`\r` 是合法字符），归一属于"取出来怎么排版"。
  return clip(d.text.replace(/\r\n?/g, '\n'));
}

// ── .docx：手写 ZIP 读 + `word/document.xml` 剥标签 ────────────────────────────────

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  localOffset: number;
}

/**
 * 从**中央目录**（不是本地头）取条目。为什么：`datalen` 在"流式写入"的包里可能写在本地头里为 0
 * （数据描述符跟在数据后面），而中央目录里的尺寸**恒为权威**。Word/WPS 保存的 docx 两处都在，
 * 读权威那一份不亏。
 */
function findEocd(buf: Buffer): number {
  const SIG_EOCD = 0x06054b50;
  if (buf.length < 22) return -1;
  const minStart = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 中央目录**全量**（`.xlsx`/`.pptx` 要按目录判工作表/幻灯片的存在与次序）。
 * 不是合法 ZIP（含 ZIP64 的 `count=0xFFFF`）⇒ `null`，由调用方如实报 `parse_error`。
 */
function listZipEntries(buf: Buffer): ZipEntry[] | null {
  const eocd = findEocd(buf);
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) return null; // ZIP64：本模块刻意不支持
  let p = cdOffset;
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) return null;
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({ name, method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function findZipEntry(buf: Buffer, want: string): ZipEntry | null {
  return listZipEntries(buf)?.find((e) => e.name === want) ?? null;
}

function readZipEntry(buf: Buffer, e: ZipEntry): Buffer {
  const lh = e.localOffset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) {
    throw new Error('本地文件头签名不符');
  }
  // ⚠ 本地头的 name/extra 长度**可能与中央目录不同**（extra 字段尤其常见）⇒ 必须重读本地头再算偏移。
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const start = lh + 30 + nameLen + extraLen;
  if (start + e.compSize > buf.length) throw new Error('数据段越界（可能是不支持的 ZIP64）');
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`不支持的压缩方法 ${e.method}（本模块只解 STORE/DEFLATE）`);
}

function decodeEntities(s: string): string {
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const v = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(v) || v < 0 || v > 0x10ffff) return m;
      try {
        return String.fromCodePoint(v);
      } catch {
        return m;
      }
    }
    switch (body) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'nbsp': return '\u00A0';
      default: return m; // 认不出的一律**原样留下**，不猜
    }
  });
}

/**
 * `word/document.xml` → 纯文本。**段落/换行/单元格边界必须先换成真字符再剥标签**——
 * 顺序颠倒（先剥标签再找边界）边界信息就随标签一起没了，几十段会连成一行。
 */
function xmlToText(xml: string): string {
  let s = xml;
  s = s.replace(/<\/w:p\s*>/g, '\n');
  s = s.replace(/<\/w:tr\s*>/g, '\n');
  s = s.replace(/<\/w:tc\s*>/g, '\t');
  s = s.replace(/<w:br\b[^>]*\/?>/g, '\n');
  s = s.replace(/<w:tab\b[^>]*\/?>/g, '\t');
  s = s.replace(/<[^>]*>/g, ''); // 其余标签（含属性）全剥——属性值不会被当正文取出
  s = decodeEntities(s);
  return s.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
}

function extractDocx(buf: Buffer): DocTextResult {
  if (buf.length < 22) return { ok: false, reason: 'parse_error', detail: `文件过小（${buf.length} 字节），不是有效的 .docx` };
  const entry = findZipEntry(buf, 'word/document.xml');
  if (!entry) {
    return { ok: false, reason: 'parse_error', detail: '不是有效的 .docx（未在 ZIP 中央目录里找到 word/document.xml）' };
  }
  let xml: Buffer;
  try {
    xml = readZipEntry(buf, entry);
  } catch (e) {
    return { ok: false, reason: 'parse_error', detail: `解压 word/document.xml 失败：${e instanceof Error ? e.message : String(e)}` };
  }
  return clip(xmlToText(xml.toString('utf8')));
}

// ── .xlsx / .pptx：同一套手写 ZIP，按 OOXML 部件取正文 ──────────────────────────

/** ZIP 内部路径一律正斜杠、无前导斜杠（OOXML 的 `Target` 可能写成绝对路径）。 */
function normalizePartPath(p: string): string {
  let s = p.replace(/\\/g, '/').trim();
  while (s.startsWith('/')) s = s.slice(1);
  return s;
}

type PartRead =
  | { ok: true; xml: string }
  | { ok: false; missing: true }
  | { ok: false; error: string };

/** 读一个 XML 部件。缺件与解压失败**分开报**：前者常可退回文件序，后者是件坏了。 */
function readXmlPart(buf: Buffer, entries: ZipEntry[], name: string): PartRead {
  const e = entries.find((x) => normalizePartPath(x.name) === name);
  if (!e) return { ok: false, missing: true };
  try {
    const xml = readZipEntry(buf, e).toString('utf8');
    return { ok: true, xml: xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 从单个标签原文里取属性值（属性次序不保证，故逐名找，不按位置切）。 */
function xmlAttr(tag: string, name: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`\\b${esc}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? '') : '';
}

/** 把 OOXML 关系表里 `Id → 部件路径` 收成一张图。`base` 是 `Target` 的相对根（无前导斜杠时用）。 */
function relTargets(xml: string, base: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = xmlAttr(m[0], 'Id');
    const target = xmlAttr(m[0], 'Target');
    if (!id || !target) continue;
    const abs = target.startsWith('/') ? target : `${base}/${target}`;
    out.set(id, normalizePartPath(abs));
  }
  return out;
}

/** `xl/worksheets/sheet12.xml` → 12（拿不到数字 ⇒ 0，排在前面但不参与命名）。 */
function partNum(name: string): number {
  const m = /(\d+)\.xml$/i.exec(normalizePartPath(name));
  return m ? Number(m[1]) : 0;
}

// ── .xlsx ──────────────────────────────────────────────────────────────────

/** `sharedStrings.xml` → 下标表。富文本 `<r><t>` 按出现次序拼接；注音（`rPh`）不取。 */
function sharedStringsOf(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const body = si[1]
      .replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
      .replace(/<phoneticPr\b[^>]*\/?>/g, '');
    let t = '';
    for (const m of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) t += decodeEntities(m[1]);
    out.push(t);
  }
  return out;
}

/** 单元格文本：`inlineStr` 取 `<is>` 里的 `<t>`，其余取 `<v>`（共享串按索引回查）。 */
function cellText(cellTag: string, cellBody: string, shared: string[]): string {
  const type = xmlAttr(cellTag, 't');
  if (type === 'inlineStr') {
    let t = '';
    for (const m of cellBody.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) t += decodeEntities(m[1]);
    return t;
  }
  const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cellBody);
  if (!vm) return '';
  const raw = decodeEntities(vm[1]);
  if (type === 's') {
    const idx = Number(raw);
    return Number.isInteger(idx) && idx >= 0 && idx < shared.length ? shared[idx]! : '';
  }
  // 数值 / 布尔 / 错误 / 公式缓存值：原样输出，**不求值**（见文件头边界）。
  return raw;
}

/** `A1` / `AB12` → 0 基列号；无引用或不是列名 ⇒ -1。 */
function columnIndex(ref: string): number {
  const m = /^([A-Za-z]+)/.exec(ref);
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 一张工作表 → 行文本。行序取 XML 出现序；稀疏列按单元格引用补制表符，行尾空格不出。 */
function sheetText(xml: string, shared: string[]): string {
  const lines: string[] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    let auto = 0;
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = `<c${c[1]}>`;
      const body = c[2] ?? '';
      const at = columnIndex(xmlAttr(tag, 'r'));
      const idx = at >= 0 ? at : auto;
      while (cells.length < idx) cells.push('');
      cells[idx] = cellText(tag, body, shared);
      auto = Math.max(auto, idx + 1);
    }
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length > 0) lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

interface SheetRef {
  name: string;
  target: string;
}

/** 工作表次序：`workbook.xml` 的 `<sheet>` 声明序 + 关系表定位；任何一步拿不到 ⇒ null（调用方退回文件序）。 */
function declaredSheets(buf: Buffer, entries: ZipEntry[]): SheetRef[] | null {
  const wb = readXmlPart(buf, entries, 'xl/workbook.xml');
  const rels = readXmlPart(buf, entries, 'xl/_rels/workbook.xml.rels');
  if (!wb.ok || !rels.ok) return null;
  const rel = relTargets(rels.xml, 'xl');
  const out: SheetRef[] = [];
  for (const m of wb.xml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const target = rel.get(xmlAttr(m[0], 'r:id'));
    if (!target) continue;
    out.push({ name: xmlAttr(m[0], 'name') || `Sheet ${out.length + 1}`, target });
  }
  return out.length > 0 ? out : null;
}

function sheetsByFilename(entries: ZipEntry[]): SheetRef[] {
  return entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(normalizePartPath(e.name)))
    .sort((a, b) => partNum(a.name) - partNum(b.name))
    .map((e) => ({ name: `Sheet ${partNum(e.name)}`, target: normalizePartPath(e.name) }));
}

function extractXlsx(buf: Buffer): DocTextResult {
  const entries = listZipEntries(buf);
  if (!entries) {
    return { ok: false, reason: 'parse_error', detail: '不是有效的 .xlsx（未找到可读的 ZIP 中央目录）' };
  }
  const sharedPart = readXmlPart(buf, entries, 'xl/sharedStrings.xml');
  const shared = sharedPart.ok ? sharedStringsOf(sharedPart.xml) : [];
  const sheets = declaredSheets(buf, entries) ?? sheetsByFilename(entries);
  if (sheets.length === 0) {
    return { ok: false, reason: 'parse_error', detail: '不是有效的 .xlsx（ZIP 里没找到任何工作表）' };
  }
  const parts: string[] = [];
  for (const s of sheets) {
    const r = readXmlPart(buf, entries, s.target);
    const body = r.ok ? sheetText(r.xml, shared) : `（工作表内容读取失败：${s.target}）`;
    parts.push(`【工作表 ${s.name}】${body ? `\n${body}` : ''}`);
  }
  return clip(parts.join('\n\n'));
}

// ── .pptx ──────────────────────────────────────────────────────────────────

/** 一页 slide 的正文：段落内 `<a:t>` 直接拼接，段间换行；空页返回空串（调用方仍保留页号）。 */
function slideText(xml: string): string {
  const paras: string[] = [];
  for (const p of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    let t = '';
    for (const m of p[1].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)) t += decodeEntities(m[1]);
    if (t.trim()) paras.push(t);
  }
  return paras.join('\n').trim();
}

/** 幻灯片次序：`presentation.xml` 的 `sldIdLst` + 关系表；拿不到 ⇒ 文件名数字序。 */
function slideTargets(buf: Buffer, entries: ZipEntry[]): string[] {
  const pres = readXmlPart(buf, entries, 'ppt/presentation.xml');
  const rels = readXmlPart(buf, entries, 'ppt/_rels/presentation.xml.rels');
  if (pres.ok && rels.ok) {
    const rel = relTargets(rels.xml, 'ppt');
    const lst = /<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/.exec(pres.xml);
    if (lst) {
      const out: string[] = [];
      for (const m of lst[1].matchAll(/<p:sldId\b[^>]*\/?>/g)) {
        const target = rel.get(xmlAttr(m[0], 'r:id'));
        if (target) out.push(target);
      }
      if (out.length > 0) return out;
    }
  }
  return entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(normalizePartPath(e.name)))
    .sort((a, b) => partNum(a.name) - partNum(b.name))
    .map((e) => normalizePartPath(e.name));
}

function extractPptx(buf: Buffer): DocTextResult {
  const entries = listZipEntries(buf);
  if (!entries) {
    return { ok: false, reason: 'parse_error', detail: '不是有效的 .pptx（未找到可读的 ZIP 中央目录）' };
  }
  const slides = slideTargets(buf, entries);
  if (slides.length === 0) {
    return { ok: false, reason: 'parse_error', detail: '不是有效的 .pptx（ZIP 里没找到任何幻灯片）' };
  }
  const parts = slides.map((target, i) => {
    const r = readXmlPart(buf, entries, target);
    const body = r.ok ? slideText(r.xml) : `（幻灯片内容读取失败：${target}）`;
    return body ? `【第 ${i + 1} 页】\n${body}` : `【第 ${i + 1} 页】`;
  });
  return clip(parts.join('\n\n'));
}
