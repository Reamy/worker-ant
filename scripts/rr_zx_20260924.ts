/**
 * zx_20260924 受控复跑 —— 「件，要进得来、看得见、发得出」。
 *
 * 病根（`plans/improve/zx_20260924.md` §1）：附件这条链**每一截都差最后一段**——
 *   M1 文档族：`.txt/.md/.json/.csv/.docx` 在装配层一律落 `not_yet_supported` ⇒ 模型只看得见文件名。
 *   M2 视频族：`FAMILY_MAX_BYTES.video = 0` 是"永不内联"的可执行表达 ⇒ 视频连音轨都没人转。
 *   M3 入站媒体：只有微信一家真能把入站媒体换成字节；企微的 `handleMessagePayload` 是**死代码**。
 *   M4 出站发件：`ImAdapter` 只有 `sendText` ⇒ 成果件发不回去。
 *   M5 完成回件：任务完成只推文本通知，登记的 primary 成果**不进 IM**。
 *   M6 模型选型：能力只在**选型前**下发，回包**从不回验**；ANS 侧 `/optimal` 有两处实现、只有一处生效。
 *   M7 去向可见：`outcomes` 只变成一句会话文本，**renderer 零处引用** `attachments`。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 批次门（`RR_STAGE`）—— 承 `zx_20260920_1` 起各轮的骨架纪律：
 *   每条判据登记其**所属批次**；`RR_STAGE=Mn` 时只要求 ≤Mn 为绿，更晚的批次打 `⏳`、不计入失败。
 *   `RR_STAGE` 为空 = **全部必须绿**（M8 收口用）。
 *
 * §G 不变式门（不受批次管辖）：
 *   G-1 **真源在位**：本轮直接 `import` 生产符号（不是扫源码字符串）——符号被删/改名 ⇒ **编译期失败**，
 *       而不是"扫了个空、静默假绿"。
 *   G-2 **两只标本**：凡"该命中/该不命中"类判据，两侧都要有真标本（只有一侧 ⇒ 过宽的变体全票通过）。
 *   G-3 **扫描面自证**：凡"零命中"类断言必须同时报出扫描面（承 `zx_20260920_1 §G-1`）。
 *
 * ⚠ 本脚本**不写任何轮次字面量**（`scanBuildPins` 的前向/反向钉一处都不许有）：build 标识一律经
 *   `checkBuildPins` **派生**核对（`scripts/lib/rr-pins.ts`），开新轮只改源码一处。
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins } from './lib/rr-pins.js';
import { extractDocText, isDocTextExt, DOC_MAX_CHARS } from '../apps/worker-ant-desktop/src/main/core/doc-text.js';
import { buildAttachmentParts } from '../apps/worker-ant-desktop/src/main/core/attachment-inline.js';
import { familyOf, maxBytesOf, FAMILY_MAX_BYTES, IMAGE_MAX_BYTES }
  from '../apps/worker-ant-desktop/src/main/core/attachment-kinds.js';
import { mediaTools } from '../apps/worker-ant-desktop/src/main/core/tools/media.js';
import { buildDeliverableTree, commonDirPrefix }
  from '../apps/worker-ant-desktop/src/main/core/deliverable-tree.js';
import { fetchInboundMedia, safeMediaFileName, mediaReceiptText, INBOUND_MEDIA_MAX_BYTES,
  mediaFromIlinkItems, aesKeyOf, decryptAesEcb, persistInboundMedia, saveInboundMedia, attachmentsRoot, ATTACHMENTS_DIR }
  from '../apps/worker-ant-desktop/src/main/services/im-media.js';
import { planPrimaryPush, formatBytes, describePrimaryPushOutcome, describePrimaryPushFile, describePrimaryPushSkip, PRIMARY_PUSH_SKIP_LABEL, PRIMARY_PUSH_MAX_FILES, PRIMARY_PUSH_MAX_BYTES }
  from '../apps/worker-ant-desktop/src/main/core/im-primary-push.js';
// M6: 辅助路能力档 / 能力回验 / 成本上限读端。`model-request.ts` 的静态链只到
//   `attachment-kinds.ts`（本文件已在引）与 `task-archetype.js`（**仅类型**，编译期擦除）⇒ 不牵 electron 可直跑真实现。
import { auxModelRequest, buildModelRequest, compareModelCapabilities, matchFailureSummary, readMaxCostPer1k, MAX_COST_PER_1K_KEY, AUX_LLM_CAPABILITIES, AUX_LLM_EXCLUDE_CAPABILITIES, AUX_LLM_STRATEGY, taskHasMedia }
  from '../apps/worker-ant-desktop/src/main/core/model-request.js';
// §2e: 「件挂到**本条文字最终落到的那张任务**上」——取件出口与真路由都**直 import**（符号被删/改名 ⇒
//   编译期失败，而不是"扫了个空、静默假绿"）。判"挂上了没有"一律用生产那份 `taskHasMedia`，不自抄谓词。
import { attachPendingMediaToTask, takePendingMedia } from '../apps/worker-ant-desktop/src/main/services/pending-media.js';
import { routeImMessage, STORM_WINDOW_MS } from '../apps/worker-ant-desktop/src/main/services/im-router.js';
// M7: 附件去向的词表与跨进程视图——零依赖纯模块，主进程落库与 renderer 上屏引同一份。
import { toAttachmentOutcomeViews, parseAttachmentOutcomeViews, ATTACHMENT_OUTCOME_STATUSES, ATTACHMENT_STATUS_LABEL }
  from '../apps/worker-ant-desktop/src/main/core/attachment-outcome.js';

let pass = 0; let fail = 0; let pending = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const ORDER = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'] as const;
type Batch = (typeof ORDER)[number];
const STAGE = (process.env.RR_STAGE || '').trim() as Batch | '';
/** STAGE 为空 ⇒ 全部须绿；否则只要求 ≤STAGE 的批次为绿（更晚的如实标"待实施"，不计入失败）。 */
const required = (b: Batch): boolean => STAGE === '' || ORDER.indexOf(b) <= ORDER.indexOf(STAGE);

/**
 * 登记一条**受批次门管辖**的判据。
 * ⚠ 未实施批次的判据**必须仍然求值**（不能短路成 false 了事）：本文件要的是"红**为什么**红"。
 */
function crit(b: Batch, cond: boolean, label: string, detail?: string): void {
  if (!required(b)) {
    pending++;
    console.log(`  ⏳ [${b}] ${label}${cond ? ' —— **已提前为真**' : ''}`);
    return;
  }
  if (cond) { pass++; console.log(`  ✓ [${b}] ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ [${b}] ${label}${detail ? ` — ${detail}` : ''}`); }
}

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const MAIN = path.join(root, `${A}/src/main`);

/**
 * 去注释——凡"这句**代码**在场"类断言必须先过它。
 * 本仓教训：`blob.includes('…')` 这类子串判据会被**注释里的同名字样**骗过（`zx_20260912` 的指纹病根）。
 * 只剥 `//` 行注释与 `/* *\/` 块注释两种形态；`https://` 前的 `:` 使得 URL 不被误剥。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ── 夹具生成器（模块作用域：多批共用同一份）────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 手写一个**真合法**的 ZIP（本地头 + 中央目录 + EOCD）——用来造 `.docx` 标本。
 * 为什么手写：本仓不许引新依赖（zip 库会牵动 ABI 脚本），而 `.docx` 判据要餵的是
 * **真 zip 字节**（`zlib.deflateRawSync` 真 DEFLATE），不是"长得像 zip 的一坨"。
 */
function makeZip(entries: Array<{ name: string; data: Buffer; store?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const method = e.store ? 0 : 8;
    const payload = e.store ? e.data : zlib.deflateRawSync(e.data);
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, payload);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + payload.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** 一份最小 `.docx` 的 `word/document.xml`：两段正文 + 一张两格表格 + 一个 XML 实体。 */
const DOCX_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
  + '<w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>Revenue </w:t></w:r><w:r><w:t>&amp; margin</w:t></w:r></w:p>'
  + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>'
  + '<w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
  + '</w:body></w:document>';

/** 该 XML 剥完标签后**应当**长成的样子（段落各自换行、单元格间 `\t`、`&amp;` → `&`）。 */
const DOCX_EXPECT = 'Quarterly report\nRevenue & margin\nA\n\tB';

function makeDocx(xml = DOCX_XML, store = false): Buffer {
  return makeZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>'), store },
    { name: 'word/document.xml', data: Buffer.from(xml, 'utf8'), store },
  ]);
}

/** GBK 字节级标本（`中文语言` 的 GBK 码位）——**不是**文本往返，是直接给字节。 */
const GBK_BYTES = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xd3, 0xef, 0xd1, 0xd4]);

function tmpdir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rr20260924-${tag}-`));
}

async function main(): Promise<void> {
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【G】不变式门：真源在位（直 import 判型，不是扫源码）');
  {
    ok(typeof extractDocText === 'function' && typeof isDocTextExt === 'function' && DOC_MAX_CHARS === 40000,
      'G-1 `doc-text.ts` 的三个导出面（`extractDocText` / `isDocTextExt` / `DOC_MAX_CHARS=40000`）都在位',
      `extractDocText=${typeof extractDocText} isDocTextExt=${typeof isDocTextExt} DOC_MAX_CHARS=${DOC_MAX_CHARS}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M1】文档族内联：txt / md / json / csv / docx');
  {
    // ── M1-a **仓内依赖闭包自证**：本模块能被 rr 直跑真实现，靠的就是这条 ────────────────
    //   凡引了仓库内模块（`./x.js` / `../y.js`），`import` 就会拖进 electron / better-sqlite3，
    //   rr 只能退化成"照抄一份等价物"——那正是本仓反复吃过的"判据的自我印证"。
    {
      const DPATH = path.join(MAIN, 'core/doc-text.ts');
      const src = fs.readFileSync(DPATH, 'utf-8');
      const relOf = (s: string) => [...s.matchAll(/^\s*import\s[^;]*?from\s+'(\.[^']*)'/gm)].map((m) => m[1]!);
      const repoImports = relOf(src);
      // ⚠ zx_20260930 M12 **就地订正**（登记语）：**判据前提被本轮设计合法改变，非放宽**。
      //   原判据钉的是"本文件零处仓内 import"。M12 把"哪些扩展名算纯文本"的真源收进**零依赖**的
      //   `attachment-kinds.ts`（renderer 侧也要读同一份），故本模块**新增且仅新增**这一处仓内 import。
      //   它要护的性质从来不是"零处"这个字面，而是**"rr 直跑真实现"**（被引模块不得拖进
      //   electron / better-sqlite3 / pino）。故改钉**那条性质本身**：每个仓内依赖的**目标文件自身**
      //   也零仓内 import ⇒ 传递闭包仍然只有 `node:*`。（"零处"钉的本来也是这个性质的一个**特例**。）
      const closure = repoImports.map((spec) => {
        const target = path.resolve(path.dirname(DPATH), spec).replace(/\.js$/, '.ts');
        const exists = fs.existsSync(target);
        return { spec, exists, rel: exists ? relOf(fs.readFileSync(target, 'utf-8')) : ['(目标不存在)'] };
      });
      const badClosure = closure.filter((c) => !c.exists || c.rel.length > 0);
      ok(badClosure.length === 0,
        'G-3 扫描面自证：`doc-text.ts` 的每个仓内依赖，其**目标文件自身零仓内 import** ⇒ '
        + '依赖闭包里只有 `node:*`，rr 直跑真实现、无需桩'
        + '（M12 起本模块有 1 处仓内 import：`./attachment-kinds.js`——它零 import，故性质不变）',
        `仓内 import ${repoImports.length} 处：${repoImports.join(', ') || '(无)'}`
        + `／可疑 ${badClosure.map((c) => c.spec).join(', ') || '(无)'}`);
      const specs = closure.filter((c) => c.exists).map((c) => c.spec);
      ok(specs.length === 1 && specs[0] === './attachment-kinds.js',
        'G-3b 这**一处**就是 M12 收进去的判限真源（不是随手多加的第二个依赖）',
        `实测 ${specs.length} 处：${specs.join(', ') || '(无)'}`);
    }

    // ── M1-b 纯文本：**该命中**（合法 UTF-8 逐字取出）──────────────────────────────────
    {
      const cases: Array<[string, Buffer, string]> = [
        ['.txt', Buffer.from('plain text'), 'plain text'],
        ['.md', Buffer.from('# Title\n\nbody line'), '# Title\n\nbody line'],
        ['.json', Buffer.from('{"a":1,"b":"中文"}'), '{"a":1,"b":"中文"}'],
        ['.csv', Buffer.from('a,b\n1,2'), 'a,b\n1,2'],
        ['.txt', Buffer.from('中文内容 UTF-8 正常'), '中文内容 UTF-8 正常'],
      ];
      const got = cases.map(([ext, buf, want]) => {
        const r = extractDocText(buf, ext);
        return { ext, ok: r.ok && r.text === want && r.truncated === false, r };
      });
      crit('M1', got.every((g) => g.ok),
        'M1-1 **该命中**：`.txt/.md/.json/.csv` 合法 UTF-8 ⇒ 逐字取出（中文不走 latin1、不落替换符）+ `truncated:false`',
        got.filter((g) => !g.ok).map((g) => `${g.ext}:${JSON.stringify(g.r).slice(0, 60)}`).join(' ') || `5/5 对上（含中文标本）`);
    }

    // ── M1-c BOM：UTF-8 BOM 剥掉、UTF-16LE/BE 认得出（**BOM 先于 NUL 判**）────────────────
    {
      const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom text')]);
      const u16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('wide text', 'utf16le')]);
      const beBody = Buffer.from('wide text', 'utf16le');
      for (let i = 0; i < beBody.length; i += 2) { const t = beBody[i]!; beBody[i] = beBody[i + 1]!; beBody[i + 1] = t; }
      const u16be = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);
      const rs = [utf8Bom, u16le, u16be].map((b) => extractDocText(b, '.txt'));
      crit('M1', rs.every((r) => r.ok && r.text === 'bom text' || (r.ok && r.text === 'wide text')),
        'M1-2 **该命中**：UTF-8 BOM 被剥掉、UTF-16LE/BE 认得出——**BOM 判定先于 NUL 判定**'
        + '（UTF-16 的 ASCII 文本天然一半是 0x00，顺序颠倒会被 NUL 闸全误杀）',
        rs.map((r) => JSON.stringify(r).slice(0, 40)).join(' | '));
    }

    // ── M1-d 编码闸：**该不命中**（GBK 无 BOM）＋ 反向标本（合法中文不误杀）────────────────
    //   ⚠ 两只标本一起试：只餵 GBK 的话，"一律判 unsupported_encoding"这个过宽变体也全票通过。
    {
      const gbk = extractDocText(Buffer.concat([GBK_BYTES, GBK_BYTES, GBK_BYTES, GBK_BYTES]), '.txt');
      const legit = extractDocText(Buffer.from('这是一份正常的中文 UTF-8 文档，用来当反向标本。', 'utf8'), '.txt');
      crit('M1', gbk.ok === false && gbk.reason === 'unsupported_encoding'
        && typeof gbk.detail === 'string' && gbk.detail.includes('UTF-8')
        && legit.ok === true,
        'M1-3 **该不命中/该命中两侧**：GBK 无 BOM ⇒ `unsupported_encoding` + detail 写明"无法按 UTF-8 解码"'
        + '（**不猜 GBK**）；而合法中文 UTF-8 ⇒ **不误杀**',
        `gbk=${JSON.stringify(gbk).slice(0, 70)} | legit.ok=${legit.ok}`);
    }

    // ── M1-e 二进制闸：**该不命中**（NUL 成片）＋ 反向标本（文本恒 0 个 NUL）──────────────
    {
      const bin = extractDocText(Buffer.concat([Buffer.from('PK'), Buffer.alloc(512)]), '.txt');
      const txt = extractDocText(Buffer.from('no nul here at all'), '.txt');
      crit('M1', bin.ok === false && bin.reason === 'binary'
        && typeof bin.detail === 'string' && bin.detail.includes('NUL')
        && txt.ok === true,
        'M1-4 **该不命中/该命中两侧**：挂了 `.txt` 的真二进制（成片 NUL）⇒ `binary` + detail 报出**占比**；'
        + '而真文本（0 个 NUL）⇒ **不误杀**',
        `bin=${JSON.stringify(bin).slice(0, 70)} | txt.ok=${txt.ok}`);
    }

    // ── M1-f docx：**该命中**（DEFLATE 与 STORE 两条路都要通）────────────────────────────
    {
      const deflated = extractDocText(makeDocx(), '.docx');
      const stored = extractDocText(makeDocx(DOCX_XML, true), '.docx');
      crit('M1', deflated.ok && deflated.text === DOCX_EXPECT && stored.ok && stored.text === DOCX_EXPECT,
        'M1-5 **该命中**：真 `.docx`（手写真合法 zip）⇒ 段落各自换行、单元格间 `\\t`、`&amp;` 解成 `&`、'
        + '正文与写进去的**逐字相等**；DEFLATE(8) 与 STORE(0) **两条压缩法都通**',
        `deflate=${deflated.ok ? JSON.stringify(deflated.text) : JSON.stringify(deflated).slice(0, 60)} | stored.ok=${stored.ok}`);
    }

    // ── M1-g docx 失败形态：**该不命中**（不是 zip / zip 里没有 document.xml）──────────────
    {
      const notZip = extractDocText(Buffer.from('just words, not a docx at all........'), '.docx');
      const emptyZip = extractDocText(makeZip([{ name: 'word/styles.xml', data: Buffer.from('<s/>') }]), '.docx');
      crit('M1', notZip.ok === false && notZip.reason === 'parse_error'
        && typeof notZip.detail === 'string' && notZip.detail.includes('document.xml')
        && emptyZip.ok === false && emptyZip.reason === 'parse_error',
        'M1-6 **该不命中**：不是 zip ⇒ `parse_error` + 真因在场；是真 zip 但没有 `word/document.xml` ⇒ 同样如实拒绝'
        + '（**不返回空正文充数**）',
        `notZip=${JSON.stringify(notZip).slice(0, 70)} | emptyZip.reason=${String(emptyZip.ok === false ? emptyZip.reason : '')}`);
    }

    // ── M1-h `.doc` 与不认识的门：**该不命中**（认得但不解析 vs 根本不归我管）──────────────
    {
      const doc = extractDocText(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), '.doc');
      const pdf = extractDocText(Buffer.from('%PDF-1.4'), '.pdf');
      crit('M1', doc.ok === false && doc.reason === 'doc_legacy_unsupported'
        && typeof doc.detail === 'string' && /\.docx|\.txt/.test(doc.detail)
        && pdf.ok === false && pdf.reason === 'parse_error',
        'M1-7 **该不命中**：老 `.doc`（OLE 头）⇒ `doc_legacy_unsupported` + **可行动作**（转存 `.docx`/`.txt`）；'
        + '`.pdf` 走错门 ⇒ `parse_error`（PDF 归 `pdf-text.ts`，**不在本模块**）',
        `doc=${JSON.stringify(doc).slice(0, 80)} | pdf.reason=${String(pdf.ok === false ? pdf.reason : '')}`);
    }

    // ── M1-i `isDocTextExt`：两侧都试（认下的 / 不认的）─────────────────────────────────
    {
      // ⚠ zx_20260930 M12 **就地订正**（登记语）：**判据前提被本轮设计合法改变，非放宽**。
      //   `.log` 原在**假**侧，M12「源码内联」把源码/配置/日志纳入 `TEXT_EXTS`（方案 §2-M12 逐字点名 `.log`）
      //   ⇒ 移到**真**侧；假侧以 `.bin`（仍是"不归文本管"的二进制）取代，标本数不减、两侧仍各有多件。
      const yes = ['.txt', '.md', '.json', '.csv', '.doc', '.docx', '.DOCX', '.log', '.ts'].map((e) => [e, isDocTextExt(e)] as const);
      const no = ['.pdf', '.png', '.bin', '.exe', ''].map((e) => [e, isDocTextExt(e)] as const);
      crit('M1', yes.every(([, v]) => v) && no.every(([, v]) => !v),
        'M1-8 **两侧标本**：`.txt/.md/.json/.csv/.doc/.docx`（含大小写）+ M12 新纳入的 `.log/.ts` 判真；'
        + '`.pdf/.png/.bin/.exe/空` 判假——**`.pdf` 必须判假**，否则文档支会与 PDF 支争夺同一件（路由顺序变了也不该双处理）',
        `真=${yes.map(([e]) => e).join('/')} 假=${no.map(([e]) => e).join('/')}`);
    }

    // ── M1-j 装配层端到端：真文件 → `buildAttachmentParts`（**真实现，不注入 io**）─────────
    {
      const dir = tmpdir('inline');
      try {
        fs.writeFileSync(path.join(dir, 'notes.md'), Buffer.from('# 笔记\n\n正文一\n正文二'));
        fs.writeFileSync(path.join(dir, 'legacy.doc'), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
        fs.writeFileSync(path.join(dir, 'gbk.txt'), Buffer.concat([GBK_BYTES, GBK_BYTES, GBK_BYTES]));
        fs.writeFileSync(path.join(dir, 'report.docx'), makeDocx());

        const items = ['notes.md', 'legacy.doc', 'gbk.txt', 'report.docx']
          .map((f) => ({ path: path.join(dir, f), fileName: f }));
        const { parts, outcomes } = await buildAttachmentParts(items);

        const byName = new Map(outcomes.map((o) => [o.fileName, o]));
        const md = byName.get('notes.md');
        const doc = byName.get('legacy.doc');
        const gbk = byName.get('gbk.txt');
        const dx = byName.get('report.docx');
        const mdText = parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
        const docPath = path.join(dir, 'legacy.doc');

        crit('M1', md?.status === 'inlined' && mdText.includes('# 笔记') && mdText.includes('正文二'),
          'M1-9 **该命中**：`.md` 经装配层真进上下文（正文在 parts 里，不只是 marker 里有件名）',
          md ? `status=${md.status} marker=${md.marker}` : '(无 outcome)');

        crit('M1', doc?.status === 'failed' && String(doc.reason).includes('doc_legacy_unsupported')
          && doc.marker.includes(docPath),
          'M1-10 **该不命中**：老 `.doc` ⇒ `failed` + 真因 + **盘上路径在 marker 里在场**'
          + '（"用户仍可自行取件"这条退路的入口——路径丢了，这句话就是空头支票）',
          doc ? `reason=${String(doc.reason).slice(0, 40)} marker=${doc.marker}` : '(无 outcome)');

        crit('M1', gbk?.status === 'failed' && String(gbk.reason).includes('unsupported_encoding')
          && gbk.marker.includes(path.join(dir, 'gbk.txt')),
          'M1-11 **该不命中**：GBK `.txt` ⇒ `failed(unsupported_encoding)`，**不拿乱码充正文**',
          gbk ? `status=${gbk.status} reason=${String(gbk.reason).slice(0, 50)}` : '(无 outcome)');

        crit('M1', dx?.status === 'inlined' && mdText.includes('Quarterly report'),
          'M1-12 **该命中**：`.docx` 经装配层真进上下文（同一份真 zip 标本走通整条链）',
          dx ? `status=${dx.status} marker=${dx.marker}` : '(无 outcome)');

        // 兜底仍在、且仍然**如实**：`.bin` 不归文档族管，须仍落"本轮不支持 + 原件在 …"。
        fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.alloc(64, 7));
        const { outcomes: outs2 } = await buildAttachmentParts([{ path: path.join(dir, 'blob.bin'), fileName: 'blob.bin' }]);
        const blob = outs2[0];
        crit('M1', !!blob && blob.status === 'omitted' && String(blob.reason).startsWith('not_yet_supported')
          && blob.marker.includes(path.join(dir, 'blob.bin')),
          'M1-13 **该不命中**：非文档族（`.bin`）仍走末尾兜底 `not_yet_supported` + 原件路径'
          + '——**新增支路没有把"挡在外面的东西"变成沉默的洞**',
          blob ? `status=${blob.status} reason=${blob.reason}` : '(无 outcome)');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    // ── M1-k 工具出口：`read_document` 的 docx 路（`.txt` 那侧由 `rr_zx_20260921` C21b 就地订正后钉住）──
    {
      const dir = tmpdir('tool');
      try {
        fs.writeFileSync(path.join(dir, 'report.docx'), makeDocx());
        fs.writeFileSync(path.join(dir, 'gbk.txt'), Buffer.concat([GBK_BYTES, GBK_BYTES, GBK_BYTES]));
        const media = mediaTools({ workingDir: dir } as unknown as Parameters<typeof mediaTools>[0]) as unknown as {
          read_document: { execute: (a: { filePath: string }) => Promise<string> };
        };
        const outDocx = await media.read_document.execute({ filePath: 'report.docx' });
        const outGbk = JSON.parse(await media.read_document.execute({ filePath: 'gbk.txt' })) as Record<string, unknown>;
        crit('M1', outDocx === `[report.docx 正文]\n${DOCX_EXPECT}`,
          'M1-14 **该命中**：工具出口 `read_document` 对 `.docx` 返回"抬头 + 正文逐字相等"',
          `out=${JSON.stringify(outDocx).slice(0, 70)}`);
        crit('M1', outGbk.ok === false && String(outGbk.reason).includes('unsupported_encoding')
          && String(outGbk.note).includes('原件在') && String(outGbk.note).includes('gbk.txt'),
          'M1-15 **该不命中**：工具出口对非 UTF-8 文本 ⇒ `ok:false` + 真因 + **盘上路径在场**（`note`）',
          `out=${JSON.stringify(outGbk).slice(0, 90)}`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // zx_20260930 M13-4 登记：本组标题原为「只取音轨」——**判据前提被本轮设计合法改变，非放宽**。
  //   视频支自此同时取"画面那一半"（抽帧），本组钉的仍是**音轨那半 + 如实性**：
  //   本组夹具**都没接抽帧器** ⇒ 落"画面未处理（本机未接抽帧器）"，故下面每条断言一字未改。
  //   画面四态的逐态措辞与抽帧器的判决，由 `rr_zx_20260930` M-f-25…M-f-31 钉。
  console.log('\n【M2】视频族的**音轨那一半**：真转写、且画面到不了时**如实说**');
  {
    // ── M2-1 判族与上限：视频有上限且 > 0；`binary` 仍恒 0（**两侧**）──────────────────────
    {
      const fams: Array<[string, string]> = [
        ['video/mp4', 'video'], ['.mov', 'video'], ['mkv', 'video'], ['.webm', 'video'],
        ['.bin', 'binary'], ['', 'binary'], ['application/octet-stream', 'binary'],
      ];
      const got = fams.map(([inp]) => familyOf(inp));
      ok(got.slice(0, 4).every((f) => f === 'video') && got.slice(4).every((f) => f === 'binary'),
        'M2-1 **两侧标本**：`video/mp4`/`.mov`/`mkv`/`.webm` ⇒ `video`；`.bin`/空/`application/octet-stream` ⇒ `binary`'
        + '（**不认识的族不许猜成能内联的那一族**）',
        fams.map(([i], k) => `${i || '(空)'}→${got[k]}`).join(' '));
      ok(maxBytesOf('video') === 100 * 1024 * 1024 && maxBytesOf('video') > 0
        && maxBytesOf('binary') === 0 && FAMILY_MAX_BYTES.image === IMAGE_MAX_BYTES,
        'M2-2 上限：`video` 恰 100MB（>0 ⇒ 可内联）；`binary` **仍恒 0**（反向：别把"放行视频"顺手放宽成"放行一切"）；'
        + '`image` 仍与 `IMAGE_MAX_BYTES` 同源（真源未分叉）',
        `video=${maxBytesOf('video')} binary=${maxBytesOf('binary')} image=${FAMILY_MAX_BYTES.image}`);
    }

    // ── M2-3 装配层端到端：真视频文件 → 真实现（只注入转写桩，不注入别处）────────────────
    //   ⚠ 转写桩是**必须**注入的：真转写要 ANS 端点，rr 里没有（且判据不许依赖本机恰好有模型）。
    //     注入面只有 `transcribeAudio` 一项 ⇒ 走通的仍是生产的判族/上限/marker/组装全链。
    {
      const dir = tmpdir('video');
      try {
        const vp = path.join(dir, 'clip.mp4');
        fs.writeFileSync(vp, Buffer.from('not-a-real-mp4-but-bytes-are-what-matter'));
        const item = { path: vp, fileName: 'clip.mp4' };

        const seen: string[] = [];
        const good = await buildAttachmentParts([item], {
          transcribeAudio: async (p: string) => { seen.push(p); return { ok: true, text: '大家好，这是会议录音。' }; },
        });
        const o = good.outcomes[0];
        const allText = good.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
        crit('M2', o?.status === 'inlined' && o?.family === 'video'
          && allText.includes('大家好，这是会议录音。'),
          'M2-3 **该命中**：`.mp4` ⇒ `inlined` 且**转写正文真进了 parts**（不只是 marker 里有件名）'
          + '——"音轨进上下文"是这台机器上真发生的事',
          o ? `status=${o.status} family=${o.family} 正文在场=${allText.includes('大家好')}` : '(无 outcome)');
        // zx_20260930 M13-4 登记：判据前提被本轮设计**合法**改变，非放宽。视频支那句话升级为**四态**
        //   （不具备 vision 未抽帧 / 本机未接抽帧器 / 抽帧失败 / 未抽到帧），抽到时还说"已抽 N 帧"。
        //   本夹具**没接抽帧器** ⇒ 落"画面未处理（本机未接抽帧器）"。这里钉的仍是**共同前缀**「画面未处理」
        //   ——凡是"画面到不了"的态**都必须**说这句；四态各自的措辞由 `rr_zx_20260930` M-f-25…M-f-31 钉。
        crit('M2', !!o && o.marker.includes('画面未处理') && o.marker.includes('音轨转写')
          && o.marker.includes('clip.mp4') && o.marker.length > '画面未处理'.length,
          'M2-4 **该命中（如实性）**：marker **必须**写出"画面未处理"——'
          + '模型拿到的是**语音**不是**画面**，不写清用户就会以为它看过视频（`zx_20260920_1`「用了才算数」同族）',
          o ? `marker=${o.marker}` : '(无 outcome)');
        crit('M2', seen.length === 1 && seen[0] === vp,
          'M2-5 转写桩**收到的就是视频原件路径**（`normalizeToWav` 对容器不可知 ⇒ 无需先抽音轨落盘）',
          `桩收到 ${seen.length} 次：${seen.join(',')}`);

        // ── 三种失败形态各一（**每一件都要说得出为什么**）──────────────────────────────
        const noTr = (await buildAttachmentParts([item])).outcomes[0];
        crit('M2', noTr?.status === 'omitted' && noTr.reason === 'transcriber_unavailable'
          && noTr.marker.includes(vp),
          'M2-6 **该不命中**：没有转写器 ⇒ `omitted(transcriber_unavailable)` + 原件路径在场'
          + '（**不假装能转**，也不沉默）',
          noTr ? `status=${noTr.status} reason=${noTr.reason}` : '(无 outcome)');

        const threw = (await buildAttachmentParts([item], {
          transcribeAudio: async () => { throw new Error('ffmpeg 起不来'); },
        })).outcomes[0];
        crit('M2', threw?.status === 'failed' && String(threw.reason).startsWith('transcribe_threw')
          && threw.marker.includes(vp),
          'M2-7 **该不命中**：转写器**抛** ⇒ `failed(transcribe_threw: …)`（抛异常 ≠ 静默通过；'
          + '也 ≠ 说成"视频里没声音"）+ 原件路径在场',
          threw ? `status=${threw.status} reason=${String(threw.reason).slice(0, 60)}` : '(无 outcome)');

        const refused = (await buildAttachmentParts([item], {
          transcribeAudio: async () => ({ ok: false, reason: 'ffmpeg_missing: PATH 里找不到' }),
        })).outcomes[0];
        crit('M2', refused?.status === 'failed' && String(refused.reason).includes('ffmpeg_missing')
          && refused.marker.includes(vp),
          'M2-8 **该不命中**：转写器**明说办不到** ⇒ `failed` + 真因（`ffmpeg_missing`）**原样带出**'
          + '（不是挤成一句"转不了"）+ 原件路径在场',
          refused ? `reason=${String(refused.reason).slice(0, 60)}` : '(无 outcome)');

        // ── 超限：**真超限**（sparse 文件秒建，省内存；读进来仍是 100MB+1 字节）──────────
        const big = path.join(dir, 'huge.mp4');
        const fd = fs.openSync(big, 'w');
        fs.ftruncateSync(fd, 100 * 1024 * 1024 + 1);
        fs.closeSync(fd);
        const over = await buildAttachmentParts([{ path: big, fileName: 'huge.mp4' }], {
          transcribeAudio: async () => ({ ok: true, text: '不该被调用' }),
        });
        const ov = over.outcomes[0];
        const ovText = over.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
        crit('M2', ov?.status === 'omitted' && ov.reason === 'over_limit'
          && ov.bytes === 100 * 1024 * 1024 + 1
          && ov.marker.includes(String(100 * 1024 * 1024 + 1)) && !ovText.includes('不该被调用'),
          'M2-9 **该不命中**：真 100MB+1 的视频 ⇒ `omitted(over_limit)`，marker 报出**真字节数与上限**、'
          + '转写器**根本没被调用**——超限是"不内联"，**不是**"截断一半当完整"',
          ov ? `status=${ov.status} reason=${ov.reason} bytes=${ov.bytes}` : '(无 outcome)');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    // ── M2-10 顺序纪律（源码面）：视频支必须在末尾兜底**之前**，否则永远够不到 ────────────
    //   上面的行为判据已能证明"这条支路是活的"；本条只把**结构位置**也钉住，防日后有人把兜底上移。
    {
      const src = fs.readFileSync(path.join(MAIN, 'core/attachment-inline.ts'), 'utf-8');
      const iVideo = src.indexOf("if (family === 'video')");
      const iFloor = src.indexOf('not_yet_supported(${family}');
      crit('M2', iVideo > 0 && iFloor > 0 && iVideo < iFloor,
        'M2-10 视频支在源序上**早于**末尾兜底（兜底上移会让视频静默退回"本轮不支持"）',
        `video@${iVideo} 兜底@${iFloor}`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M3】入站媒体：平台给的路 → 盘上的字节（五家同一条链）');
  {
    // ── M3-a 一处真源（G-3 扫描面自证 + 两只标本）────────────────────────────────────
    //   M3 之前**只有微信一家**有取件实现（两个私有方法 + 自定的 20MB 上限）；若五家各抄一份，
    //   就是"同一条规则的第五次实现"（G8/G9 的老病）。本判据把"**只有一个实现**、五家都调它"钉住：
    //   正面 —— 五个适配器文件都出现 `persistInboundMedia(`（**数得出来**，不是"没扫到"）；
    //   反面 —— 没有任何适配器自带下载实现（`saveInboundMedia(` / `fetchInboundMedia(` 零命中）。
    {
      const ADAPTERS = ['wechat', 'wecom', 'dingtalk', 'feishu', 'qqbot'] as const;
      const srcs = ADAPTERS.map((n) => [n, fs.readFileSync(path.join(MAIN, `services/${n}-adapter.ts`), 'utf-8')] as const);
      const callsIt = srcs.filter(([, s]) => s.includes('persistInboundMedia(')).map(([n]) => n);
      const ownImpl = srcs.filter(([, s]) => /\b(saveInboundMedia|fetchInboundMedia)\s*\(/.test(s)).map(([n]) => n);
      crit('M3', callsIt.length === ADAPTERS.length && ownImpl.length === 0,
        'M3-1 **两侧标本**：五个适配器**都**走 `im-media.persistInboundMedia`（取件+落盘唯一实现），'
        + '且没有任何一家自带下载实现（`saveInboundMedia`/`fetchInboundMedia` 在适配器层零调用）',
        `扫了 ${srcs.length} 个适配器文件；调 persistInboundMedia 的 ${callsIt.length} 家（${callsIt.join(',')}）；`
        + `自带实现的 ${ownImpl.length} 家${ownImpl.length ? `（${ownImpl.join(',')}）` : ''}`);
      // ⚠ 微信那个**同名私有包装**（只加平台专属请求头后转调真实现）仍在——故上面数的是"调用"，不是"改名"。
      //   本判据若日后变成"零命中"，说明有人把微信的自研下载搬回来了：那是本判据要拦的东西。
    }

    // ── M3-b 取件实现直跑（真实现 + 只注入网络边界；**两只标本 × 两组**）──────────────────
    //   承「抽纯函数/注入桩口让 rr 跑真实现」：`fetchInboundMedia` 的 io 只替 `fetch`，其余逻辑全真。
    {
      const mkResp = (body: Buffer, contentType: string, headers: Record<string, string> = {}) =>
        new Response(body, { status: 200, headers: { 'content-type': contentType, ...headers } });
      const io = (r: Response) => ({ fetch: (async () => r) as unknown as typeof fetch });

      // ①-该命中：真字节 ⇒ 原样取回
      const okBytes = await fetchInboundMedia('https://cdn.example/a.jpg', {}, io(mkResp(Buffer.from('IMGBYTES'), 'image/jpeg')));
      crit('M3', okBytes.ok && okBytes.buf.length === 8 && okBytes.buf.toString() === 'IMGBYTES',
        'M3-2 **该命中**：真字节（`image/jpeg`）⇒ `ok:true` 且字节逐字相等（不是"状态 200 就算成功"）',
        okBytes.ok ? `${okBytes.buf.length}B` : `fail=${okBytes.error}`);

      // ②-该命中（**这条是订正后的形状**）：`content-type: application/json` 但**不是错误信封** ⇒ 仍算成功。
      //   旧实现先 `resp.text()` 再读 `resp.body` —— body 已被消费 ⇒ 抛 `Body is unusable` ⇒
      //   真有人发了个 `.json` 件会被判"没能落盘"。本判据连同它一起钉住。
      const rawJson = '{"a":1,"note":"用户发的真 json 件"}';
      const jsonFile = await fetchInboundMedia('https://cdn.example/a.json', {}, io(mkResp(Buffer.from(rawJson), 'application/json')));
      crit('M3', jsonFile.ok && jsonFile.buf.toString('utf-8') === rawJson,
        'M3-3 **该命中**：`application/json` 但**无错误键** ⇒ 仍取回（JSON 件不是错误信封；'
        + 'body 只许读一次——先 `text()` 后读 `body` 会抛 `Body is unusable`）',
        jsonFile.ok ? jsonFile.buf.toString('utf-8').slice(0, 40) : `fail=${jsonFile.error}`);

      // ③-该不命中：HTTP 200 + 平台错误信封 ⇒ **不许把一段 JSON 当用户发的文件落盘**
      const env = await fetchInboundMedia('https://qyapi.weixin.qq.com/cgi-bin/media/get',
        {}, io(mkResp(Buffer.from('{"errcode":40001,"errmsg":"invalid media_id"}'), 'application/json')));
      crit('M3', !env.ok && /40001/.test(env.error),
        'M3-4 **该不命中**：HTTP **200** + `{"errcode":40001}` ⇒ `ok:false` 且把平台原文（40001）带出来'
        + '（企微 `media_id` 失效就是这个形状——把它当"用户发的文件"落盘是静默的谎）',
        env.ok ? `误判成功 ${env.buf.length}B` : env.error);

      // ④-该不命中：声明超限 ⇒ 早退，**不下载**
      const over = await fetchInboundMedia('https://cdn.example/huge.bin',
        {}, io(mkResp(Buffer.from('x'), 'application/octet-stream', { 'content-length': String(INBOUND_MEDIA_MAX_BYTES + 1) })));
      crit('M3', !over.ok && /上限/.test(over.error) && over.error.includes(String(INBOUND_MEDIA_MAX_BYTES)),
        'M3-5 **该不命中**：声明 `content-length` 超上限 ⇒ `ok:false` 且**报出上限真值**（数从真源取，不手抄）',
        over.ok ? '误判成功' : over.error);
    }

    // ── M3-c 落盘件名：平台下载地址里的**占位后缀**不当真（三只标本）──────────────────────
    //   依据：钉钉官方「下载机器人接收消息的文件内容」明说下载名形如 `…Z7zCM0CYA.file`，**须自行换后缀**。
    //   信它 ⇒ 每张钉钉图存成 `.file` ⇒ `familyOf('.file')='binary'` ⇒ **永远不内联**（病根换地方复发）。
    {
      const name = (m: Parameters<typeof safeMediaFileName>[0]) => safeMediaFileName(m, 1700000000000, () => 0.5);
      const placeholder = name({ kind: 'picture', mediaUrl: 'https://x.example/iAEIxxx.file' });
      const real = name({ kind: 'file', mediaUrl: 'https://cdn.example/report.pdf' });
      const noName = name({ kind: 'audio', mediaUrl: 'https://x.example/blob.file' });
      crit('M3', placeholder.endsWith('.jpg') && real.endsWith('.pdf') && noName.endsWith('.amr'),
        'M3-6 **三只标本**：占位后缀 `.file` **不当真**（按平台类型名退回 `.jpg`）；真后缀 `.pdf` 照用；'
        + '类型 `audio` + 占位后缀 ⇒ 退回 `.amr`（`byKind` 是真源，逐条对得上）',
        `${placeholder} / ${real} / ${noName}`);
      // 反向：**用户真发了个 `.file` 件**时，名字来自平台声明的 fileName，不经这条推断（不受影响）。
      const userFile = name({ kind: 'file', fileName: 'report.file', mediaUrl: 'https://x.example/iAEIxxx.file' });
      crit('M3', userFile === 'report.file',
        'M3-7 **反向**：平台**声明的**件名 `.file` 原样保留（占位后缀的处置只作用于"没有件名时的兜底名"）',
        userFile);
    }

    // ── M3-d 用户可见串：两支都含真件名，失败**必须**说"没能落盘"─────────────────────────
    {
      const good = mediaReceiptText({ kind: 'picture', fileName: 'pic.jpg', sizeBytes: 2048, savedPath: '/d/attachments/20260924/pic.jpg' });
      const bad = mediaReceiptText({ kind: 'picture', fileName: 'pic.jpg', error: '取件 HTTP 403' });
      crit('M3', /pic\.jpg/.test(good) && /已落盘/.test(good) && /attachments\/20260924\/pic\.jpg/.test(good)
        && /pic\.jpg/.test(bad) && /没能落盘/.test(bad) && /403/.test(bad),
        'M3-8 **两支都在场**：成功报**落点**（`attachments/<日期>/<件名>`）、失败报**真因**并**明说"没能落盘"**'
        + '（把"我丢了"说成"我收了"是本轮明令要治的那类谎报）',
        `${good.slice(0, 40)} | ${bad.slice(0, 40)}`);
    }

    // ── M3-e 接线：`dataDir` 必须**从生产入口**流到五家（否则落盘根是空串 ⇒ 写到 CWD 去）──────
    {
      const ipc = fs.readFileSync(path.join(MAIN, 'ipc/im.ipc.ts'), 'utf-8');
      const wired = ['dingtalk', 'qqbot', 'feishu', 'wecom', 'wechat-personal'].filter((t) =>
        new RegExp(`case '${t}':\\s*adapter = new \\w+\\(db, channelId, config, dataDir\\)`).test(ipc));
      crit('M3', wired.length === 5,
        'M3-9 **接线**：`createAdapter` 把 `dataDir` 传给**五家**（此前只有微信拿到它 ⇒ 其余四家结构上不可能落盘）',
        `扫了 im.ipc.ts：五家里 ${wired.length} 家带 dataDir（${wired.join(',')}）`);
    }

    // ⚠ 入站链路的**端到端**（适配器 → 真 `routeImMessage` → 入站行 → `last_error` → 回执 → 盘上字节）
    //   由 `rr_zx_20260914_2.ts` §S2.2 承载（该处五家各两只标本，含本次新补的企微/QQ 取件正反两面）。
    //   此处**刻意不重搭一遍路由夹具**：同一条链两处各搭一份，只会让两边各自漂移。
    // ⚠ 已挂账（如实，不是判据）：钉钉 Stream 官方要求处理完**回一个带 `messageId` 的响应帧**（否则平台重投），
    //   本实现未回 ⇒ 实机联调需观察是否出现重投（重投的文本消息会重复落行）。

    // ── M3-f 微信 iLink 的**真形状**（2026-09-24 实机取证；本批是 E2E 当场照出来的缺陷的修复）──────
    //   缺陷：`mediaFromIlinkItems` 只在 `*_item` 的**顶层**找 `url`/`file_url`/…（那份候选名是**推定的**），
    //     而真帧把取件地址与钥匙**嵌在 `media` 里** ⇒ **一个都不命中** ⇒ 行里有 `kind`、无地址
    //     ⇒ 既不落盘也不报错（`data/attachments/` 自 M5 起从未存在，`saved_path`/`media_error` 全表 0 行）。
    //   第二层：真件在 CDN 上**是 AES-128-ECB 密文**（下面 M3-12 用样本钥匙做往返钉住）。
    //   ⚠ 标本里的 `aes_key` 是**合成样本**（与真帧**同形状**：base64 过的 32 位十六进制串 / 裸十六进制串）；
    //     真帧原值自 zx_20261005 M20 开源扫描起**移出源码**——真实密钥不进公开仓（见仓库根 `.gitleaksignore`）。
    //     `full_url` 同为同形状的假地址（真地址里的 `encrypted_query_param` 指向用户那件，不落进仓库）。
    {
      const SAMPLE_FILE_KEY_HEX = '0123456789abcdef0123456789abcdef'; //gitleaks:allow（合成样本，非凭据）
      const SAMPLE_FILE_KEY_B64 = Buffer.from(SAMPLE_FILE_KEY_HEX, 'ascii').toString('base64');
      const SAMPLE_IMG_KEY_HEX = 'fedcba9876543210fedcba9876543210'; //gitleaks:allow（合成样本，非凭据）
      const fakeUrl = 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=XXX&taskid=1';
      // 真帧形状（逐键取自 `/tmp/m7_inputs/ilink-raw.jsonl` 的原样字段名）
      const realFileItem = {
        type: 4,
        file_item: { media: { encrypt_query_param: 'XXX', aes_key: SAMPLE_FILE_KEY_B64, full_url: fakeUrl },
          file_name: '测试.txt', md5: 'b9e2484a941e50654fe2250e28a9a224', len: '1610' },
      };
      const realImgItem = {
        type: 2,
        image_item: { aeskey: SAMPLE_IMG_KEY_HEX,
          media: { encrypt_query_param: 'YYY', aes_key: Buffer.from(SAMPLE_IMG_KEY_HEX, 'utf8').toString('base64'), full_url: fakeUrl },
          mid_size: 23673, thumb_size: 3636, thumb_height: 135, thumb_width: 180, hd_size: 998138 },
      };

      // ③-该命中：**嵌在 `media` 里**的取件三元组（地址/钥匙）与顶层件名/长度都认出来
      const gotFile = mediaFromIlinkItems([{ type: 1, text_item: { text: 'hi' } }, realFileItem]);
      crit('M3', gotFile?.mediaUrl === fakeUrl && gotFile?.fileName === '测试.txt' && gotFile?.sizeBytes === 1610
        && gotFile?.aesKey?.length === 16,
        'M3-10 ★**该命中**（真帧形状）：取件地址/钥匙**嵌在 `media` 里**也认得出，件名 `file_name`、'
        + '明文长度 `len`（字符串）一并带出（原先只在顶层找 `url` 一族 ⇒ 真帧一个都不命中）',
        `url=${gotFile?.mediaUrl ? '有' : '无'} 名=${gotFile?.fileName ?? '-'} 大小=${gotFile?.sizeBytes ?? '-'} `
        + `钥匙=${gotFile?.aesKey ? `${gotFile.aesKey.length}B` : '无'}`);

      // ③-该命中：图片件**不给件名**时不得编造，但钥匙（两种写法）与地址仍须到手
      const gotImg = mediaFromIlinkItems([realImgItem]);
      crit('M3', gotImg?.mediaUrl === fakeUrl && gotImg?.fileName === undefined && gotImg?.aesKey?.length === 16,
        'M3-11 ★**该命中**（图片件）：平台**没给件名**就如实没有（`fileName === undefined`，不编造），'
        + '而地址与钥匙照样到手（`image_item.aeskey` 与 `media.aes_key` 是同一把钥匙的两种写法）',
        `名=${gotImg?.fileName ?? '（无）'} 钥匙=${gotImg?.aesKey ? `${gotImg.aesKey.length}B` : '无'}`);

      // ③-该命中：钥匙归一 —— **真帧的两种写法必须解出同一把 16 字节钥匙**
      const kA = aesKeyOf(SAMPLE_FILE_KEY_B64); const kB = aesKeyOf(SAMPLE_FILE_KEY_HEX);
      crit('M3', !!kA && !!kB && kA.equals(kB) && kA.toString('hex') === SAMPLE_FILE_KEY_HEX,
        'M3-12 **钥匙归一**：`media.aes_key`（base64 过的十六进制串）与 `image_item.aeskey`（裸十六进制）'
        + '解出**同一把** 16 字节钥匙（合成样本，两种写法逐字节相等）',
        `base64写法=${kA?.toString('hex') ?? '-'} / 裸十六进制写法=${kB?.toString('hex') ?? '-'}`);
      //   该不命中：认不出的形状 ⇒ `undefined`（**不猜**，宁可如实说"没能落盘"）
      const kBad = [aesKeyOf('not-a-key'), aesKeyOf(12345 as unknown), aesKeyOf(''), aesKeyOf('ab')];
      crit('M3', kBad.every((k) => k === undefined),
        'M3-13 **该不命中**：认不出的钥匙形状（非 base64 / 非字符串 / 空串 / 长度不对）一律 `undefined`'
        + '——不拿瞎猜的钥匙去解，更不把解出来的垃圾当用户发的件存下',
        kBad.map((k) => (k ? `${k.length}B` : 'undefined')).join(','));

      // ④ 往返（**本轮最要紧的一条**）：样本钥匙 + 真算法 ⇒ 盘上存的必须是**解密后**的字节
      //   证法：用同一把钥匙把一段**已知明文**加密成密文，喂给生产的 `persistInboundMedia`，再读盘比对。
      //   （尺寸刻意取 1610 → 密文 1616，与真帧的 len/md5 同规模。）
      const plain = Buffer.alloc(1610, 0);
      for (let i = 0; i < plain.length; i++) plain[i] = (i * 31 + 7) & 0xff;
      plain.write('测试.txt 的内容', 0, 'utf-8');
      const key = kA!;
      const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
      const cipherBytes = Buffer.concat([cipher.update(plain), cipher.final()]);
      const tmpMedia = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-24-ilink-'));
      try {
        const io = (r: Response) => ({ fetch: (async () => r) as unknown as typeof fetch });
        const got = await persistInboundMedia(tmpMedia,
          { kind: '4', mediaUrl: fakeUrl, fileName: '测试.txt', sizeBytes: 1610, aesKey: key },
          { io: io(new Response(cipherBytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } })) });
        const onDisk = got.savedPath && fs.existsSync(got.savedPath) ? fs.readFileSync(got.savedPath) : null;
        crit('M3', !!onDisk && onDisk.equals(plain) && got.bytes === plain.length,
          '★ M3-14 **往返（解密后才算到手）**：样本钥匙 + `aes-128-ecb` 的密文经生产链路 ⇒ 盘上是**明文**'
          + '（逐字节相等）、`bytes` 报的是**盘上真件的字节数**（把密文原样存下来正是"回执说已落盘、'
          + '盘上躺着谁也打不开的字节"那种谎）',
          onDisk ? `盘上 ${onDisk.length}B（${got.savedPath!.split('/').slice(-2).join('/')}）`
            + (onDisk.equals(plain) ? ' 与明文逐字节相等' : ' ⚠与明文不符') : `未落盘：${got.mediaError ?? '无原因'}`);
        //   反向（该不命中的一半）：**没有钥匙**的平台/件 ⇒ 原样落盘，不尝试解密（行为与从前逐字相同）
        const gotPlain = await persistInboundMedia(tmpMedia,
          { kind: 'file', mediaUrl: fakeUrl, fileName: 'report.pdf' },
          { io: io(new Response(Buffer.from('PLAINBYTES'), { status: 200, headers: { 'content-type': 'application/pdf' } })) });
        const diskPlain = gotPlain.savedPath ? fs.readFileSync(gotPlain.savedPath, 'utf-8') : null;
        crit('M3', diskPlain === 'PLAINBYTES',
          'M3-15 **该不命中**：平台**没给钥匙**（钉钉/企微/飞书/QQ 恒不带宽）⇒ 原样落盘、不尝试解密'
          + '（新增的解密分支不许改变既有四家的行为）', diskPlain ?? `未落盘：${gotPlain.mediaError ?? '无原因'}`);

        // ④-该不命中：解不开 ⇒ **如实失败、一个字节都不写**（绝不"解不开也照存"）
        const bad = Buffer.alloc(20, 9);   // 20 不是 16 的整数倍 ⇒ ECB 必抛
        const before = fs.existsSync(attachmentsRoot(tmpMedia)) ? fs.readdirSync(attachmentsRoot(tmpMedia), { recursive: true }).length : 0;
        const gotBad = await persistInboundMedia(tmpMedia,
          { kind: '4', mediaUrl: fakeUrl, fileName: 'broken.txt', aesKey: key },
          { io: io(new Response(bad, { status: 200, headers: { 'content-type': 'application/octet-stream' } })) });
        const after = fs.existsSync(attachmentsRoot(tmpMedia)) ? fs.readdirSync(attachmentsRoot(tmpMedia), { recursive: true }).length : 0;
        crit('M3', !gotBad.savedPath && !!gotBad.mediaError && /解密/.test(gotBad.mediaError) && after === before,
          '★ M3-16 **该不命中（fail-closed）**：密文解不开 ⇒ `mediaError` 带真因、**`savedPath` 缺席**、'
          + '**盘上文件数不变**（承"回执必须说没能落盘"：静默存下一段谁也打不开的字节才是谎报）',
          `saved=${gotBad.savedPath ?? '（无）'} err=${gotBad.mediaError ?? '（无）'} 文件数 ${before}→${after}`);

        // ── M3-g 微信**数值类型**的兜底后缀（E2E 当场照出的第二处；真帧即证据）─────────────────
        //   真帧里 `type` 2/3/4/5 分别挂在 `image_item`/`voice_item`/`file_item`/`video_item` 上
        //   ⇒ 数字与类型名是同一件事的两种写法，故按类型名那半边翻译过来。**不动 kind 的形状契约**
        //   （行里仍是数字、回执仍是「其他消息(2)」——用户 2026-09-21 裁定，见 im-media 文件头）。
        //   不补的代价是**实的**：微信发视频不给 `file_name` ⇒ 落成无后缀 ⇒ `familyOf` 判 `binary`
        //   ⇒ M2「视频→音轨转写」在微信这条路上**永远不触发**（做了没用上）。
        const named = (m: Parameters<typeof safeMediaFileName>[0]) => safeMediaFileName(m, 1700000000000, () => 0.5);
        const nImg = named({ kind: '2' }); const nVid = named({ kind: '5' }); const nFile = named({ kind: '4' });
        const nUnknown = named({ kind: '9' });   // 表外（真帧里 type 9 不存在；此样本证"不认识就不编造"）
        crit('M3', familyOf(path.extname(nImg)) === 'image' && familyOf(path.extname(nVid)) === 'video'
          && familyOf(path.extname(nFile)) === 'binary',
          'M3-17 ★微信**数值类型**的兜底后缀：`2` ⇒ `.jpg`（图片族）、`5` ⇒ `.mp4`（**视频族**——'
          + 'M2 的「视频→音轨」全靠这条路才够得着）、`4` ⇒ `.bin`（文件件平台恒给 `file_name`，这是兜底）',
          `2⇒${nImg} / 5⇒${nVid} / 4⇒${nFile}`);
        crit('M3', path.extname(nUnknown) === '' && familyOf(path.extname(nUnknown)) === 'binary',
          'M3-18 **该不命中**：表外的类型**不编造后缀**（`im-<ts>-<rand>` 无后缀 ⇒ 判 `binary` ⇒ 如实不内联），'
          + '这是"猜得出才猜、猜不出就如实"的另一半', nUnknown);
        //   反向：平台**给了真件名**时，兜底后缀不得越权覆盖
        const nReal = named({ kind: '2', fileName: '截图.PNG' });
        crit('M3', nReal === '截图.PNG',
          'M3-19 **反向**：平台**声明的**件名原样保留（`byKind` 只管"没有件名时的兜底名"）', nReal);
      } finally { fs.rmSync(tmpMedia, { recursive: true, force: true }); }
      //   词表落点自证：真实存储根名与扫描面（承 G-3；也是本批"落盘根"这一契约的在场证明）
      ok(ATTACHMENTS_DIR === 'attachments' && path.basename(attachmentsRoot('/x')) === ATTACHMENTS_DIR,
        `M3-20 落盘根仍是 \`${ATTACHMENTS_DIR}/\`（本批新增的解密写在它之下，不改目录契约）`);
      //   —— 反向（源码面）：**没有第二份解密实现**（同一条规则的第二次实现正是本仓反复治过的病）
      const mediaSrcM3f = fs.readFileSync(path.join(MAIN, 'services/im-media.ts'), 'utf-8');
      const decImpls = [...mediaSrcM3f.matchAll(/createDecipheriv\(/g)].length;
      const adaptersWithDecrypt = ['wechat', 'wecom', 'dingtalk', 'feishu', 'qqbot']
        .filter((n) => /createDecipheriv\(/.test(fs.readFileSync(path.join(MAIN, `services/${n}-adapter.ts`), 'utf-8')));
      crit('M3', decImpls === 1 && adaptersWithDecrypt.length === 0,
        'M3-21 **一处真源（两侧标本）**：解密实现只有 `im-media` 一处（`createDecipheriv(` 命中 '
        + `${decImpls} 次）、五个适配器**零处**各自解密（平台差异只表现在"钥匙从哪个键读"，不是各写一份算法）`,
        `扫了 im-media + 5 个适配器：${decImpls} 处实现，适配器层 ${adaptersWithDecrypt.length} 处`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ⚠ §2e（同批落地；用户 2026-09-24 裁定）——「件挂到**本条文字最终落到的那张任务**上」
  //
  //   实机 E2E 当场照出（2026-09-24 16:02–16:04，真库 `worker-ant-server.db`）：盘上有件、入站行有
  //   `saved_path`，而 `context_json.attachments` 空、`[附件已内联进上下文]` 当日**零次**——
  //   病因**不在**落盘链（那一段已绿），而在**路由次序**：件原先只在**建任务路**（`handleCreateTask`）
  //   被取用，而「先发件、再说话」那句**自然语言**先被 `handleAgentReply` 当"对该用户暂停任务的回复"
  //   接走（本文件步骤1）⇒ **根本走不到建任务路** ⇒ 件停在盘上无人认领；agent 自己 `ls` 附件目录
  //   用 `read_file` 顶上，用户目的**侥幸达成**，而设计的挂载链**一次都没跑**（"做了没用上"）。
  //
  //   修法：取件收成**一个出口** `attachPendingMediaToTask`——回复路挂到被恢复的任务、建任务路挂到新任务，
  //   两条路同一句纪律「**不落任务就不消费件**」（取件是取即消费的，放在早退之前 ⇒ 一次追问就把件吃了）。
  //
  //   ⚠ 为什么旧 rr（`rr_zx_20260921` C1/C2）全绿却漏了这件事：那两只标本的夹具里**没有暂停任务**，
  //     故 `handleAgentReply` 返回 false、建任务路被走到——**夹具比生产宽松，断言只在自我印证**。
  //     本块的第一件事就是把那只标本补上（**暂停任务在场**），且一律跑真 `routeImMessage`。
  {
    // 夹具：照抄 `database.ts` 的 DDL。比 M1 那只多一张 `wa_jobs`——**回复路**会 `enqueueJob`
    //   （恢复作业），缺表会在插入原子句处抛，而在这里抛意味着"本该证的事没证到"。
    const SCHEMA_2E = `
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, name TEXT DEFAULT '', config TEXT NOT NULL DEFAULT '{}', status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_im_conversations (
  id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, project_id TEXT,
  message_json TEXT DEFAULT '{}', direction TEXT DEFAULT 'inbound',
  created_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'sent', last_error TEXT DEFAULT '', outbox_id TEXT DEFAULT '');
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
  avatar_url TEXT, role TEXT DEFAULT 'viewer', auth_provider TEXT DEFAULT 'authjs',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', cron_schedule TEXT, working_dir TEXT DEFAULT '',
  context_json TEXT DEFAULT '{}', sandbox_mode TEXT DEFAULT 'workspace',
  owner_id TEXT, cron_timezone TEXT DEFAULT 'Asia/Shanghai',
  autonomous_mode TEXT DEFAULT 'off', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
  source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_task_conversations (
  id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL, content TEXT DEFAULT '',
  tool_calls TEXT, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_jobs (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now'))
);
`;
    type Db2e = {
      prepare: (sql: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
      exec: (s: string) => void;
    };
    const CH2E = 'ch-2e';
    const newDb2e = (): Db2e => {
      const d = new DatabaseSync(':memory:') as unknown as Db2e;
      d.exec(SCHEMA_2E);
      d.prepare('INSERT INTO wa_im_channels (id, channel_type, name) VALUES (?, ?, ?)').run(CH2E, 'wechat', '§2e 标本渠道');
      return d;
    };
    /** 假 `ImContext`：`sendReply` 只**收下**回话，不发网络（契约要求"永不 reject"）。 */
    const ctxOf = (db: Db2e, replies: string[]) => ({
      db: db as never, channelId: CH2E, channelType: 'wechat',
      sendReply: async (_to: string, text: string) => { replies.push(text); },
    });
    /** 真落盘一件（走生产 `saveInboundMedia`），返回其**真路径**——期望值不许手写。 */
    const putMedia = (fileName: string, body: string) => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-24-2e-'));
      const r = saveInboundMedia(dataDir, { kind: '2', fileName, mediaUrl: `https://x.invalid/${fileName}`, sizeBytes: Buffer.byteLength(body) }, Buffer.from(body));
      return r;
    };
    /** 送一件「盘上已有」的件（形状与适配器交给 `routeImMessage` 的**一致**：非文本 ⇒ 只落行、早退）。 */
    const sendMedia = async (db: Db2e, user: string, fileName: string, realPath: string, body: string) =>
      routeImMessage(ctxOf(db, []) as never, user, `[图片 ${fileName}]`, 'direct', '',
        { kind: '2', fileName, savedPath: realPath, sizeBytes: Buffer.byteLength(body) });
    /** 送一句文字（真走完整路由链：偏好/编号/审批/回复/命令/问候/…/建任务）。 */
    const sendText = async (db: Db2e, user: string, text: string) =>
      routeImMessage(ctxOf(db, []) as never, user, text, 'direct', '', undefined);
    /**
     * **风暴闸是生产行为，夹具得按它说话**：同一用户 2 秒内第 3 条起**判暴 ⇒ 落库但暂缓处理**
     *   （`stormVerdict`）。首版夹具"先发件、再说话"连发三条，当场被闸住 ⇒ 正题全红——
     *   那是**夹具比生产宽松的镜像**：生产里用户也隔几秒才说下一句。
     *   故连发满两条就歇一个窗口。窗口值取**导出常量**（不手写 2000）。
     */
    const pace = () => new Promise<void>((resolve) => setTimeout(resolve, STORM_WINDOW_MS + 60));
    const lastTaskId = (db: Db2e) =>
      (db.prepare('SELECT id FROM wa_tasks ORDER BY rowid DESC LIMIT 1').get() as { id: string } | undefined)?.id ?? '';
    const taskOf = (db: Db2e, id: string) => {
      const t = db.prepare('SELECT context_json, status FROM wa_tasks WHERE id = ?').get(id) as { context_json: string; status: string } | undefined;
      return t ? { ctx: JSON.parse(t.context_json) as Record<string, unknown>, status: t.status } : undefined;
    };
    const attsOf = (ctx: Record<string, unknown> | undefined): Array<{ path?: string }> =>
      (Array.isArray(ctx?.attachments) ? ctx!.attachments as Array<{ path?: string }> : []);
    /** 该用户入站行里**带件**的那一行（消费标记就写在它身上）；按 `rowid` 倒序 = 最近一件。 */
    const consumedOf = (db: Db2e, user: string): unknown => {
      const r = db.prepare(
        "SELECT message_json FROM wa_im_conversations WHERE direction = 'inbound' AND external_user_id = ? "
        + "AND json_extract(message_json,'$.saved_path') IS NOT NULL ORDER BY rowid DESC LIMIT 1"
      ).get(user) as { message_json: string } | undefined;
      return r ? (JSON.parse(r.message_json) as Record<string, unknown>).media_consumed_at : undefined;
    };
    const taskCount = (db: Db2e) => (db.prepare('SELECT COUNT(*) AS n FROM wa_tasks').get() as { n: number }).n;

    // ── N1（本块的正题）：**暂停任务在场**时，一句话把件挂到**被恢复的那张任务**上 ────────────────
    {
      const db = newDb2e();
      const USER = 'u-2e-n1';
      const saved = putMedia('摘要用件.txt', '件的内容');
      const realPath = saved.ok ? saved.path : '';
      // ① 先造出一张**暂停任务**——走**真路由**（6 字、≤10 ⇒ `isShortMessage` ⇒ `paused`），不手写任务行。
      await sendText(db, USER, '分析这个文件');
      const taskId = lastTaskId(db);
      const beforeCtx = taskOf(db, taskId)?.ctx;
      crit('M3', !!taskId && beforeCtx?.externalUser === USER && taskOf(db, taskId)?.status === 'paused',
        'N1 前提：**暂停任务在场**（真路由建出，不手写任务行）——`status=paused` 且 '
        + '`context_json.channel/externalUser` 与 IM 维度同源（这正是旧 rr 夹具缺的那一格）',
        taskId ? `task=${taskId.slice(0, 8)} status=${taskOf(db, taskId)?.status} user=${String(beforeCtx?.externalUser)}` : '没建出任务');
      crit('M3', taskHasMedia(beforeCtx) === false,
        'N1 挂件**之前**：这张任务 `taskHasMedia` 为假（后面"由假变真"的正面断言因此才有信息量）',
        `attachments=${attsOf(beforeCtx).length} 件`);
      // ② 件先到：非文本，**止步不回话、不建任务、不消费**（"先发件、再说话"的前半）
      await sendMedia(db, USER, '摘要用件.txt', realPath, '件的内容');
      crit('M3', taskCount(db) === 1 && realPath !== '' && (consumedOf(db, USER) ?? null) === null,
        'N1 前提前半：件先到时**不建任务**（任务数仍为 1）且**尚未被消费**——取件是取即消费，'
        + '不能在任何"这件事还没决定"的位置就先把它吃掉',
        `任务数=${taskCount(db)} 消费标记=${JSON.stringify(consumedOf(db, USER) ?? null)}`);
      // ③ 一句话 —— 本块的正题：**它落到哪张任务，件就挂到哪张任务**
      await pace();     // 前两条已占满窗口，第三条要等一个窗口（生产的闸，不是判据的让步）
      await sendText(db, USER, '把这个文件内容摘要一下');
      const after = taskOf(db, taskId);
      const atts = attsOf(after?.ctx);
      crit('M3', atts.length === 1 && atts[0]!.path === realPath && taskHasMedia(after?.ctx) === true,
        '★ N1 **正题（实机缺陷的靶心）**：暂停任务在场时，一句自然语言把件挂到**被恢复的那张任务**上——'
        + '`attachments` 恰 1 件、`path` = 真落盘路径、生产那份 `taskHasMedia` 由 **false 变 true**'
        + '（实机病因：这句话被 `handleAgentReply` 在建任务路之前接走 ⇒ 件停在盘上无人认领）',
        after ? `attachments=${atts.length} 件 · taskHasMedia=${taskHasMedia(after.ctx)} · status=${after.status}` : '任务不见了');
      crit('M3', typeof consumedOf(db, USER) === 'string',
        'N1 取即消费**落库**：件那一行的 `media_consumed_at` 键在场（重启后仍不会重复取件）',
        typeof consumedOf(db, USER) === 'string' ? String(consumedOf(db, USER)) : '（无）');
      crit('M3', after?.status === 'pending',
        'N1 挂件与**恢复**是同一件事的两面：这条回复确实把任务从 `paused` 拉回 `pending`'
        + '（件挂上了、任务却没动 ⇒ 件仍然看不见）', `status=${after?.status ?? '（无）'}`);
      //   行为面自证"只剩一个出口"：件已被消费 ⇒ 直调真源也再取不到（与 N6 的源码面同源、两侧都要有）
      const again = takePendingMedia(db as never, { channelId: CH2E, externalUser: USER });
      crit('M3', again === undefined,
        'N1 同源行为自证：件已被挂走 ⇒ 直调真源 `takePendingMedia` 再取为 `undefined`'
        + '（"取即消费"不是一句话，是库里的标记）', again ? `竟然又取到 ${again.path}` : 'undefined');
    }

    // ── N3 追加**不覆盖**：已有件的任务再挂一件 ⇒ 两件都在，先前那件一笔未动 ────────────────────
    {
      const db = newDb2e();
      const USER = 'u-2e-n3';
      const m1 = putMedia('第一件.txt', 'AAA'); const m2 = putMedia('第二件.txt', 'BBB');
      const p1 = m1.ok ? m1.path : ''; const p2 = m2.ok ? m2.path : '';
      await sendText(db, USER, '分析这个文件');
      const taskId = lastTaskId(db);
      await sendMedia(db, USER, '第一件.txt', p1, 'AAA');
      await pace();
      await sendText(db, USER, '把这个文件内容摘要一下');
      const one = attsOf(taskOf(db, taskId)?.ctx);
      // 任务跑完再暂停是常态（引擎等用户输入）——把它**再置回 paused**，看第二次挂件会不会覆盖掉第一件。
      //   （这一步是夹具的手（真路由跑不出"第二次暂停"），故如实写在判据话里。）
      db.prepare("UPDATE wa_tasks SET status = 'paused' WHERE id = ?").run(taskId);
      await sendMedia(db, USER, '第二件.txt', p2, 'BBB');
      await pace();
      // ⚠ 第二句**必须换一句**：入站去重按 `渠道:用户:正文`，同正文 30s 内**第二次直接丢掉**
      //   （首版同句复用 ⇒ 当场被去重挡下、N3 红——**又一道生产的闸，夹具得按它说话**）。
      await sendText(db, USER, '再看看第二件写了什么');
      const two = attsOf(taskOf(db, taskId)?.ctx);
      crit('M3', one.length === 1 && two.length === 2 && two[0]!.path === p1 && two[1]!.path === p2,
        '★ N3 追加**不覆盖**：第二次挂件后两件都在、**先前那件 `path` 逐字未变**'
        + '（覆盖会让先前那件在账上"从未存在过"——件还躺在盘上，却没有任何一句话说得清它是谁）',
        `第一次后=${one.length} 件 · 第二次后=${two.length} 件 [0]=${two[0]?.path?.split('/').pop() ?? '-'} [1]=${two[1]?.path?.split('/').pop() ?? '-'}`);
    }

    // ── N4 **该不命中**：这句话**没落到任何任务**（问候早退）⇒ 件一个都不许被消费 ──────────────────
    //   "不落任务就不消费件"的另一半。只钉"该挂上时挂上了"，把取件挪到早退之前的实现**照样全绿**——
    //   而那种实现里，用户一次追问就把件吃掉（不可见的丢失）。
    {
      const db = newDb2e();
      const USER = 'u-2e-n4';
      const saved = putMedia('别被吃掉.txt', 'keep me');
      const p = saved.ok ? saved.path : '';
      await sendMedia(db, USER, '别被吃掉.txt', p, 'keep me');
      await sendText(db, USER, '你好');            // 问候分支：早退，不建任务、不恢复任务
      crit('M3', taskCount(db) === 0 && (consumedOf(db, USER) ?? null) === null,
        '★ N4 **该不命中（早退不消费）**：没有暂停任务时一句问候不落任何任务 ⇒ 件**仍未被消费**'
        + '（`media_consumed_at` 缺席）——取件若被放在早退之前，用户一次追问就把件吃了',
        `任务数=${taskCount(db)} 消费标记=${JSON.stringify(consumedOf(db, USER) ?? null)}`);
    }

    // ── N5 **设计边界（如实钉住）**：裸编号是对"选哪一个"的回答，不是**给任务的输入** ⇒ 不挂件 ──────
    //   同一条口径：件挂在「**作为那条任务工作输入**」的那句话上。审批答复（确认/选项编号）、编号选择、
    //   `开始+任务名` 是**对某个悬置提问的决定**或**选任务的动作**——把件挂上去只让"我到底在答复什么"说不清。
    //   故刻意不挂，且留下的件**不动**（下一句真正干活的话仍取得到它）。
    {
      const db = newDb2e();
      const USER = 'u-2e-n5';
      const saved = putMedia('编号别挂.txt', 'no');
      const p = saved.ok ? saved.path : '';
      await sendText(db, USER, '分析这个文件');       // 造一张暂停任务（等着被编号选中）
      const taskId = lastTaskId(db);
      await sendMedia(db, USER, '编号别挂.txt', p, 'no');
      await pace();
      await sendText(db, USER, '1');                 // 编号选择：恢复任务，但**不**挂件
      const after = taskOf(db, taskId);
      crit('M3', attsOf(after?.ctx).length === 0 && (consumedOf(db, USER) ?? null) === null
        && after?.status === 'pending',
        'N5 **刻意不挂**（编号选择）：裸编号把任务恢复了（`status=pending`）却**不消费**件'
        + '（`attachments` 零件、`media_consumed_at` 缺席）——件留给下一句真正干活的话；'
        + '被这里吃掉才是不可见的丢失',
        `attachments=${attsOf(after?.ctx).length} 件 · 消费标记=${JSON.stringify(consumedOf(db, USER) ?? null)} · status=${after?.status ?? '（无）'}`);
    }

    // ── N6 **一处取件出口**（源码面；扫描面自证，承 G-3）──────────────────────────────────────
    //   实机病因的**结构性**那一半：取件原先只有建任务路一个调用点——"某条新路忘了取件"的温床。
    //   现在两条路共用 `attachPendingMediaToTask` ⇒ `im-router` 里**不该再有** `takePendingMedia(`。
    {
      const routerSrc = stripComments(fs.readFileSync(path.join(MAIN, 'services/im-router.ts'), 'utf-8'));
      const bareTake = [...routerSrc.matchAll(/\btakePendingMedia\s*\(/g)].length;
      const viaHelper = [...routerSrc.matchAll(/\battachPendingMediaToTask\s*\(/g)].length;
      const importLine = (routerSrc.match(/import\s*\{[^}]*\}\s*from\s*'\.\/pending-media\.js'/) ?? [''])[0]!;
      crit('M3', bareTake === 0 && viaHelper === 2
        && /\battachPendingMediaToTask\b/.test(importLine) && !/\btakePendingMedia\b/.test(importLine),
        '★ N6 **一处取件出口**：`im-router.ts`（去注释后）直调 `takePendingMedia(` **0 处**、'
        + '经 `attachPendingMediaToTask(` **2 处**（建任务路 + 回复路），且它 import 的是后者'
        + '——取即消费的时机只剩一个出口（散落两处正是"某条新路忘了取件"的温床）',
        `扫描面 im-router.ts（去注释 ${routerSrc.split('\n').length} 行）· takePendingMedia=${bareTake} 处 / `
        + `attachPendingMediaToTask=${viaHelper} 处 · import 行=「${importLine.trim().slice(0, 64)}」`);
      const pmSrc = stripComments(fs.readFileSync(path.join(MAIN, 'services/pending-media.ts'), 'utf-8'));
      const pmCalls = [...pmSrc.matchAll(/\btakePendingMedia\s*\(/g)].length;
      crit('M3', pmCalls === 2,
        'N6 同源自证：`pending-media.ts`（去注释）里 `takePendingMedia(` 恰 **2 处**（**定义** 1 + '
        + '唯一出口内的**调用** 1）——真源那一侧也数得清，不是"扫了个空"',
        `pending-media.ts（去注释）命中 ${pmCalls} 处`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M4】出站发件：件发得出去，且补发**不降级为文本**');
  {
    // ── M4-a 契约：「能力是行为，不是标签」——**不声明即不支持**（运行时查原型，不扫源码）──────
    //   查的是 `Adapter.prototype.sendMedia` **在不在**，即"这个类有没有这条通道"这一**运行期事实**；
    //   写成"渠道名单里有微信 ⇒ 不支持"就把能力变成了标签，新增渠道会默认**装成能发**。
    {
      const ADAPTERS = ['wechat', 'wecom', 'feishu', 'dingtalk', 'qqbot'] as const;
      const declared: string[] = []; const undeclared: string[] = [];
      for (const n of ADAPTERS) {
        const mod = (await import(`../${A}/src/main/services/${n}-adapter.js`)) as Record<string, unknown>;
        const cls = Object.values(mod).find((v) => typeof v === 'function') as { prototype: Record<string, unknown> } | undefined;
        (cls && typeof cls.prototype.sendMedia === 'function' ? declared : undeclared).push(n);
      }
      crit('M4', declared.length === 4 && undeclared.length === 1 && undeclared[0] === 'wechat',
        'M4-1 **两侧标本**：四家声明了 `sendMedia`（真能发件），**微信个人号没声明**——「不支持」在代码里就是'
        + '"没有这个方法"；iLink 只有文本通道、无上传接口，故不假装有（也不静默降级成发个文件名）',
        `扫了 ${ADAPTERS.length} 个适配器类；声明 ${declared.length} 家（${declared.join(',')}）；`
        + `未声明 ${undeclared.length} 家（${undeclared.join(',') || '无'}）`);
    }

    // ── M4-b 能力表与上面的**运行时事实**逐家对齐（表不许比实现多许诺）────────────────────────
    {
      const { channelCapabilities } = await import(`../${A}/src/main/core/im/channel-capabilities.js`);
      const wx = channelCapabilities('wechat-personal');
      const four = ['qqbot', 'dingtalk', 'feishu', 'wecom'].map((t) => channelCapabilities(t).media);
      const unknown = channelCapabilities('no-such-channel-type');
      crit('M4', wx.media === false && /不支持发送文件/.test(wx.note) && four.every(Boolean) && unknown.media === false,
        'M4-2 能力表**按实现如实登记**：微信个人号 `media:false` 且文案明说"不支持发送文件"；四家 `media:true`；'
        + '未知渠道类型 `media:false`（不默认许诺——"没登记"不等于"支持"）',
        `wechat=${wx.media} / 四家=${four.join(',')} / 未知=${unknown.media}`);
    }

    // ── M4-c 落账与补发：**真表 + 真函数**（node:sqlite 夹具照抄 database.ts 的 DDL）────────────
    //   `defaultSend` 拉不到（它 `await import im.ipc.js` ⇒ electron），但**映射与读回**这两段是纯逻辑，
    //   能真跑就真跑：`enqueueImOutbox` 写 → 回读 → `retryOutboxEntry`（注入 send 抓 entry）。
    {
      const outbox = (await import(`../${A}/src/main/core/im/im-outbox.js`)) as typeof import('../apps/worker-ant-desktop/src/main/core/im/im-outbox.js');
      const CH_DDL = "CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, name TEXT DEFAULT '', config TEXT NOT NULL DEFAULT '{}', status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')));";
      const CONV_DDL = `CREATE TABLE wa_im_conversations (
  id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, message_json TEXT DEFAULT '{}',
  direction TEXT DEFAULT 'inbound', created_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'sent', last_error TEXT DEFAULT '', outbox_id TEXT DEFAULT '');`;
      const OLD_DDL = `CREATE TABLE wa_im_outbox (
  id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, task_id TEXT,
  kind TEXT DEFAULT 'notification', message TEXT DEFAULT '', attempts INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending', next_retry_at INTEGER,
  created_at TEXT DEFAULT (datetime('now')), last_error TEXT, last_attempt_at TEXT);`;
      const NEW_DDL = `CREATE TABLE wa_im_outbox (
  id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, task_id TEXT,
  kind TEXT DEFAULT 'notification', message TEXT DEFAULT '', attempts INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending', next_retry_at INTEGER,
  created_at TEXT DEFAULT (datetime('now')), last_error TEXT, last_attempt_at TEXT,
  media_path TEXT, media_kind TEXT);`;
      const mkDb = (ddl: string) => {
        const d = new DatabaseSync(':memory:');
        d.exec(CH_DDL); d.exec(CONV_DDL); d.exec(ddl);
        // zx_20260924_1 M8: **补上渠道行**——生产里 `wa_im_channels` 行是先在的（适配器登记时落库），
        //   本夹具此前只建表不插行 ⇒ `channel_type` 取回空串 ⇒ 能力表兜底 `media:false`。
        //   M8 的补发前置闸（发不了件的渠道上的件**如实拒绝**）真读这一列，会把下面 ④ 的件行先拦下
        //   （拦得并不错：渠道行都没有，`sendImMedia` 会抛"渠道适配器未运行"，件本来也发不出去）。
        //   ④ 测的是 `entryFromRow` 的映射，故按**能发件**的类型把渠道行补上，让件真走到 send。
        d.prepare("INSERT INTO wa_im_channels (id, channel_type, name, status) VALUES ('ch-1', 'qqbot', '夹具渠道', 'running')").run();
        return d as unknown as Parameters<typeof outbox.enqueueImOutbox>[0];
      };

      // ①-**该命中**：件入账 ⇒ 两列真写回（**回读**取值，不是"没抛就算写了"）
      const dbNew = mkDb(NEW_DDL);
      outbox.enqueueImOutbox(dbNew, {
        channelId: 'ch-1', externalUserId: 'u1', taskId: 't1', kind: 'notification',
        message: '', mediaPath: '/d/attachments/20260924/r.pdf', mediaKind: 'file',
      }, '发送失败（模拟）');
      const rowNew = dbNew.prepare('SELECT * FROM wa_im_outbox').get() as Record<string, unknown> | undefined;
      crit('M4', rowNew?.media_path === '/d/attachments/20260924/r.pdf' && rowNew?.media_kind === 'file' && rowNew?.status === 'pending',
        'M4-3 **该命中**：件落账后 `media_path`/`media_kind` 真写回（**回读**取值——本仓刚因"报错被 catch 吞掉"'
        + '热热闹闹跑了二十天没落过库，此处不重蹈）',
        `media_path=${String(rowNew?.media_path)} media_kind=${String(rowNew?.media_kind)}`);

      // ②-**该不命中**：文本件走**同一函数** ⇒ 两列为空（否则"人人变件"）
      const dbTxt = mkDb(NEW_DDL);
      outbox.enqueueImOutbox(dbTxt, { channelId: 'ch-1', externalUserId: 'u2', taskId: 't2', kind: 'notification', message: '任务已完成' });
      const rowTxt = dbTxt.prepare('SELECT * FROM wa_im_outbox').get() as Record<string, unknown> | undefined;
      crit('M4', rowTxt?.message === '任务已完成' && (rowTxt?.media_path ?? null) === null,
        'M4-4 **该不命中**：文本件走**同一函数**落账，`media_path` 为空 ⇒ 补发仍走 `sendImMessage`'
        + '（新加了列，不等于从今往后什么都记成"件"）',
        `media_path=${JSON.stringify(rowTxt?.media_path ?? null)}`);

      // ③-**兼容标本**：旧形状表（无 media_* 列；六份历史 rr 夹具就是这个形状）⇒ 件照样落账
      const dbOld = mkDb(OLD_DDL);
      let warned = '';
      const ow = console.warn; console.warn = (...m: unknown[]) => { warned = m.map(String).join(' '); };
      try {
        outbox.enqueueImOutbox(dbOld, {
          channelId: 'ch-1', externalUserId: 'u3', taskId: 't3', kind: 'notification',
          message: '', mediaPath: '/d/x.pdf', mediaKind: 'file',
        });
      } finally { console.warn = ow; }
      const rowOld = dbOld.prepare('SELECT * FROM wa_im_outbox').get() as Record<string, unknown> | undefined;
      crit('M4', rowOld?.id != null && rowOld?.status === 'pending' && /media_path 列缺失/.test(warned),
        'M4-5 **兼容标本**：旧库/旧夹具（无 `media_*` 列）件**照样落账**（落账语句只碰旧列），缺列时 `console.warn`'
        + '**如实报警**——静默变通的后果是补发把件退化成一条只有文件名的文字，账上却记"已送达"',
        `落账=${rowOld?.id != null} warn=${warned ? `有（${warned.slice(0, 30)}）` : '无'}`);

      // ④-补发同形：真 `retryOutboxEntry`（注入 send 抓 entry）——件行给件、文本行给文本
      const captured: Array<{ mediaPath?: string; message: string }> = [];
      const send = async (e: { mediaPath?: string; message: string }): Promise<boolean> => { captured.push(e); return true; };
      const rNew = await outbox.retryOutboxEntry(dbNew, String(rowNew?.id), { send });
      const rTxt = await outbox.retryOutboxEntry(dbTxt, String(rowTxt?.id), { send });
      crit('M4', rNew.ok && rTxt.ok && captured[0]?.mediaPath === '/d/attachments/20260924/r.pdf' && captured[1]?.mediaPath === undefined,
        'M4-6 **两条路一把尺**：真 `retryOutboxEntry` 从行里读回的 entry —— 件行带 `mediaPath`（补发走 `sendMedia`）、'
        + '文本行不带（走 `sendImMessage`）。判据只看这两列**在不在**，不猜 `message` 像不像路径。'
        + '（两条补发路共用 `entryFromRow` 这**一个**映射点，此处验的是它。）',
        `件=${String(captured[0]?.mediaPath)} / 文本=${String(captured[1]?.mediaPath)}`);

      // ⑤-失败账**同一本**：件行的补发失败照样写 outbox 行与 `failed` 对话行（不因"是文件"另开一本账）
      const convs = dbOld.prepare("SELECT status, message_json FROM wa_im_conversations WHERE outbox_id IS NOT NULL AND outbox_id != ''").all() as Array<Record<string, unknown>>;
      crit('M4', convs.length === 1 && convs[0]?.status === 'failed' && /📎 x\.pdf/.test(String(convs[0]?.message_json)),
        'M4-7 **同一本账**：件落账同时补一条 `failed` 对话行、预览取件名（`message` 为空也不留一行空白）'
        + '——件与文本走的是同一套 `recordFailedConversation`，没有第二条记账规则',
        `件行对应的对话行 ${convs.length} 条：${String(convs[0]?.message_json).slice(0, 60)}`);
    }

    // ── M4-d 严格入口：**能力探测**，不是渠道白名单（源码面——`im.ipc.ts` 顶层拉 electron，rr 里跑不起来）──
    //   zx_20260924_1 M8 **加严**：那句话不再在 `sendImMedia` 里手写，改为引用 `channel-capabilities.ts` 的
    //   共享真源 `MEDIA_UNSUPPORTED_TEXT`（同一份同时喂着能力表 `note`、两条补发路的前置拒绝、界面禁用钮 title）。
    //   旧判据只核"这段函数体里有那句话"——**换到别处再写一句同义的照样过**（这正是本仓"两套口径并存"的老病根）。
    //   新判据一次核三件事：① 函数体引用的**是那个共享标识符**、且句子的**字面量已不在此处**（手抄即红）；
    //   ② 该标识符在能力表里**确实被声明成**这句话——比对值取自 import 的运行时符号，不在本脚本手抄；
    //   ③ 能力表 `note` **由它拼出**（第二份同义文案的另一处老巢）。三件全中才算这条成立。
    {
      const ipc = stripComments(fs.readFileSync(path.join(MAIN, 'ipc/im.ipc.ts'), 'utf-8'));
      const si = ipc.indexOf('export async function sendImMedia');
      const body = si >= 0 ? ipc.slice(si, ipc.indexOf('\n}', si)) : '';
      const cap = (await import(`../${A}/src/main/core/im/channel-capabilities.js`)) as typeof import('../apps/worker-ant-desktop/src/main/core/im/channel-capabilities.js');
      const capSrc = stripComments(fs.readFileSync(path.join(MAIN, 'core/im/channel-capabilities.ts'), 'utf-8'));
      const refsShared = body.includes('MEDIA_UNSUPPORTED_TEXT');
      const noLiteral = !body.includes(cap.MEDIA_UNSUPPORTED_TEXT);
      const declared = capSrc.includes(`MEDIA_UNSUPPORTED_TEXT = '${cap.MEDIA_UNSUPPORTED_TEXT}'`);
      // ③ 必须是**内插那个标识符**，不是"碰巧写着同一句话"——`note.includes(值)` 那种写法对
      //    "手抄一份同值文案"是**放行**的（实测：把 `\${MEDIA_UNSUPPORTED_TEXT}` 换成手写的同一句，
      //    `includes` 仍为真、判据照绿），故这里查的是源码里的内插写法；再叠一道运行期回读，
      //    防"内插是写了但拼出来是空的"（两头都真才算它由真源拼出）。
      const wxLine = capSrc.split('\n').find(l => l.includes("'wechat-personal'")) || '';
      const noteFromIt = wxLine.includes('${MEDIA_UNSUPPORTED_TEXT}')
        && cap.channelCapabilities('wechat-personal').note.includes(cap.MEDIA_UNSUPPORTED_TEXT);
      crit('M4', si >= 0 && /if \(!adapter\.sendMedia\)/.test(body) && refsShared && noLiteral
        && /adapter\.sendMedia\(toUser/.test(body) && declared && noteFromIt,
        'M4-8 **能力探测，不是渠道名单**（M8 加严：核的是**共享真源**，不是"这段话在不在"）：`sendImMedia` 按'
        + '`!adapter.sendMedia` 判"发不了件"并**如实抛出**，且那句话取自 `channel-capabilities.ts` 的'
        + '`MEDIA_UNSUPPORTED_TEXT`（函数体不再手写该句；能力表以它声明、`wechat-personal` 的 `note` 由它拼出）'
        + '（写成 `type !== "wechat-personal"` 这类名单，则新增渠道会默认装成能发；写成本地在别处重发一遍文件名，'
        + '则用户以为收到件、实际只收到一行字）',
        `扫描面：im.ipc.ts 的 \`sendImMedia\` 函数体（${si >= 0 ? `切出 ${body.length} 字符` : '**切不出**'}）`
        + ` / 引用共享标识符=${refsShared} 函数体内无字面量=${noLiteral} 声明处=${declared} note 由它拼=${noteFromIt}`);
    }

    // ── M4-e `defaultSend` 的补发分支在场（同源码面；它 `await import im.ipc.js` ⇒ 无法在 rr 里真跑）────
    {
      const src = stripComments(fs.readFileSync(path.join(MAIN, 'core/im/im-outbox.ts'), 'utf-8'));
      const i = src.indexOf('async function defaultSend');
      const j = src.indexOf('export function reviveQuotaBlockedOutbox');
      const body = i >= 0 && j > i ? src.slice(i, j) : '';
      const iBranch = body.indexOf('if (row.mediaPath)');
      crit('M4', i > 0 && j > i && iBranch >= 0
        && body.indexOf('sendImMedia(') > iBranch && body.indexOf('sendImMessage(') > iBranch,
        'M4-9 **补发不降级**：`defaultSend` 有 `if (row.mediaPath)` 分支，两支**都在场**（件走 `sendImMedia`、'
        + '文本走 `sendImMessage`）——M4-6 验的是映射，这条验的是那一跳真的分了两支',
        `扫描面：im-outbox.ts 的 \`defaultSend\` 函数体（${i > 0 && j > i ? `切出 ${body.length} 字符` : '**切不出**'}）`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M5】任务完成时自动推主成果：**只推来源会话** · 超限改说明 · 失败落同一本账');
  {
    // ── M5-a..e 判据是**纯函数**（`sizeOf` 注入 ⇒ rr 不必真造 20MB 件，仍按两侧标本钉死）────────
    const items = [
      { id: 'f1', name: '报告.md', file_path: '/d/out/report.md' },
      { id: 'f2', name: '图表.png', file_path: '/d/out/chart.png' },
      { id: 'f3', name: '无路径.md', file_path: '' },
      { id: 'f4', name: '盘上已删.md', file_path: '/d/out/gone.md' },
      { id: 'f5', name: '空文件.txt', file_path: '/d/out/empty.txt' },
      { id: 'f6', name: '没登记路径.md' },
    ];
    // 契约：`null` = 盘上没有（取不到字节数）；`0` = 存在但是空文件（照样算一件）。
    const sizeOf = (p: string): number | null => (p.endsWith('gone.md') ? null : p.endsWith('empty.txt') ? 0 : 1024);
    const planA = planPrimaryPush(items, { sizeOf });
    crit('M5', planA.files.map((f) => f.id).join(',') === 'f1,f2,f5'
      && planA.skipped.map((s) => `${s.id}:${s.reason}`).join(',') === 'f3:missing_path,f4:not_on_disk,f6:missing_path',
      'M5-1 **四态穷尽**：有路径且在盘上的发；空串 / 键整个缺 ⇒ `missing_path`；`sizeOf` 取不到 ⇒ `not_on_disk`；'
      + '**0 字节的空文件照发**（"存在但是空"与"盘上没有"是两件事，用户要采取的动作也不同：前者可直接取、后者要重产出）',
      `发=${planA.files.map((f) => f.id).join(',')} 未发=${planA.skipped.map((s) => `${s.id}:${s.reason}`).join(',')}`);

    crit('M5', planA.files[0]?.kind === 'file' && planA.files[1]?.kind === 'image' && planA.files[2]?.kind === 'file',
      'M5-2 **判型由产物本身定**：`.png` 走图片通路（IM 侧可预览）、`.md`/`.txt` 走文件通路——按**扩展名**定，'
      + '不看登记标签（承 zx_20260911_1）；IM 只有这两条路，故不按附件族细分',
      `kind=[${planA.files.map((f) => `${f.name}=${f.kind}`).join(' ')}]`);

    // ── M5-b 单件闸的**两侧**：恰等于上限 ⇒ 发；上限 +1 ⇒ 不发并**报出实际大小** ────────────
    const capA = planPrimaryPush([{ id: 'e1', name: '恰好.md', file_path: '/d/e1' }], { sizeOf: () => 1000, maxBytes: 1000 });
    const capB = planPrimaryPush([{ id: 'e2', name: '超1字节.md', file_path: '/d/e2' }], { sizeOf: () => 1001, maxBytes: 1000 });
    crit('M5', capA.files.length === 1 && capB.files.length === 0 && capB.skipped.length === 1
      && capB.skipped[0]?.reason === 'over_bytes' && capB.skipped[0]?.bytes === 1001,
      'M5-3 **闸的两侧**：`bytes === 上限` ⇒ 照发（不搞"≥ 就拒"的偏严一侧）；`上限 + 1` ⇒ **不推件**、'
      + '并**如实带上实际字节数**（只写"超限"用户不知道该重产出还是该自己下载，也看不出差多少）',
      `恰好上限 ⇒ 发 ${capA.files.length} 件；超 1 字节 ⇒ 发 ${capB.files.length} 件、理由=${String(capB.skipped[0]?.reason)}`
      + `（实际 ${String(capB.skipped[0]?.bytes)} 字节）`);

    // ── M5-c 件数闸**切在收集之后**：前 N 件发、第 N+1 件起**点名**记 `over_count` ──────────
    const four = [1, 2, 3, 4].map((i) => ({ id: `c${i}`, name: `件${i}.md`, file_path: `/d/c${i}.md` }));
    const planC = planPrimaryPush(four, { sizeOf: () => 10 });
    crit('M5', planC.files.map((f) => f.id).join(',') === 'c1,c2,c3'
      && planC.skipped.length === 1 && planC.skipped[0]?.id === 'c4'
      && planC.skipped[0]?.reason === 'over_count' && planC.skipped[0]?.bytes === undefined,
      'M5-4 **件数闸切在收集后**：4 件候选 ⇒ 发前 3 件、第 4 件**点名**记 `over_count`——边收边截的话'
      + '"剩下为什么没发"就只剩一个数字，说不出是哪几件；`over_count` **不带字节数**'
      + '（与"这件多大"无关，带上反而把人引去怀疑大小）',
      `发=${planC.files.map((f) => f.id).join(',')} 未发=${planC.skipped.map((s) => `${s.id}:${s.reason}`).join(',')}`);

    // ── M5-d 两个常量就是**裁定值**，标签**一处出**（少一态=有件不知为何没发；多一态=有话说不出）────
    crit('M5', PRIMARY_PUSH_MAX_FILES === 3 && PRIMARY_PUSH_MAX_BYTES === 20 * 1024 * 1024
      && Object.keys(PRIMARY_PUSH_SKIP_LABEL).sort().join(',') === 'missing_path,not_on_disk,over_bytes,over_count',
      'M5-5 **常量即裁定**：件数上限 3（`is_primary` 是**互斥谓词** ⇒ 正常恒 1 件，余量是给历史/手工多标的）；'
      + '单件 20MB（主流 IM 单文件上限多在 20–30MB 一档，取偏严侧当"不依赖具体平台"的稳妥值）；'
      + '四个未推原因的面向用户短标签**恰四键**（renderer/日志/IM 文本同引此处，勿手抄第二份）',
      `maxFiles=${PRIMARY_PUSH_MAX_FILES} maxBytes=${PRIMARY_PUSH_MAX_BYTES}（${formatBytes(PRIMARY_PUSH_MAX_BYTES)}）`
      + ` 标签键=${Object.keys(PRIMARY_PUSH_SKIP_LABEL).join(',')}`);

    // ── M5-e 收口文案**两头都在**：先说发了哪些、再说哪些为什么没发 ──────────────────────
    const msgA = describePrimaryPushOutcome(planA);
    crit('M5', msgA.includes('本次附上主要成果 3 件：') && msgA.includes('报告.md（1.0 KB）')
      && msgA.includes('以下未能附上：') && msgA.includes('没有盘上路径') && msgA.includes('盘上已不存在'),
      'M5-6 文案**两头都在**：既**逐件列出**"发了哪些"（带人读大小），也**逐条说明**"为什么没发"——'
      + '只报一句"有几件没发"等于把"自己下载还是重新产出"的选择权从用户手里拿走',
      `首行=${JSON.stringify(msgA.split('\n')[0])} 共 ${msgA.split('\n').length} 行`);

    const msgOnly = describePrimaryPushOutcome({ files: [], skipped: planA.skipped });
    const msgNone = describePrimaryPushOutcome(capA);
    crit('M5', msgOnly.split('\n')[0] === '主要成果未能附上：' && !msgOnly.includes('本次附上主要成果')
      && !msgNone.includes('未能附上') && msgNone.includes('本次附上主要成果 1 件：'),
      'M5-7 **文案的两侧标本**：一件都没发出去时首句是「主要成果未能附上：」（不说"本次附上 0 件"这种废话）；'
      + '全部发出去时**不出现**"未能附上"段（凭空多一段空的"以下未能附上"就是把话说过头）',
      `全跳过首句=${JSON.stringify(msgOnly.split('\n')[0])}；全发出含"未能附上"=${msgNone.includes('未能附上')}`);

    crit('M5', describePrimaryPushFile(planA.files[0]!) === '📎 主要成果：报告.md（1.0 KB）'
      && describePrimaryPushSkip({ id: 'x', name: '大件.zip', reason: 'over_bytes', bytes: 30 * 1024 * 1024 })
        === '大件.zip（30.0 MB）未推送：单件超限（上限 20.0 MB）',
      'M5-8 **超限那句把差多少说出来**（实际大小与上限都在），且件预览行取"件名 + 人读大小"'
      + '——它是进补发账的 `message`，保证失败那条对话行不是一片空白',
      `预览行=${JSON.stringify(describePrimaryPushFile(planA.files[0]!))}`);

    // ── M5-f **两路判据刻意不同**：件只投来源会话，文本可回落最近私聊（真跑 `im-notify.js`）──────
    //   `im-notify.js` 的静态链（task-notice → settings-bool / pause-reason / dep-graph / task-accounting）
    //   **零依赖、不拉 electron** ⇒ rr 里起得来；`im.ipc.js` 是函数内 `await import`，不在静态链上。
    {
      const notify = (await import(`../${A}/src/main/core/im/im-notify.js`)) as
        typeof import('../apps/worker-ant-desktop/src/main/core/im/im-notify.js');
      const d = new DatabaseSync(':memory:');
      d.exec("CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, context_json TEXT DEFAULT '{}');");
      d.exec("CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, status TEXT DEFAULT 'active');");
      d.exec(`CREATE TABLE wa_im_conversations (
  id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, message_json TEXT DEFAULT '{}',
  direction TEXT DEFAULT 'inbound', created_at TEXT DEFAULT (datetime('now')));`);
      d.exec(`INSERT INTO wa_im_channels (id, channel_type, status) VALUES
  ('ch-dt','dingtalk','active'), ('ch-wx','wechat-personal','active'), ('ch-old','qqbot','inactive');`);
      d.exec(`INSERT INTO wa_tasks (id, context_json) VALUES
  ('t-im','{"channel":"dingtalk","externalUser":"u-dt"}'),
  ('t-im-nouser','{"channel":"dingtalk"}'),
  ('t-im-deadch','{"channel":"qqbot","externalUser":"u-q"}'),
  ('t-gui','{}');`);
      // 群聊(11:00)与房间(12:00)都**比唯一那条 1:1(09:00) 新** —— 排除谓词失效时挑出来的就是它们。
      d.exec(`INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, created_at) VALUES
  ('c1','ch-dt','u-dt-recent','{"chat_type":"direct"}','inbound','2026-09-24 08:00:00'),
  ('c2','ch-wx','u-wx','{"chat_type":"direct"}','inbound','2026-09-24 09:00:00'),
  ('c3','ch-wx','u-group','{"chat_type":"group"}','inbound','2026-09-24 11:00:00'),
  ('c4','ch-wx','12345@chatroom','{"chat_type":"direct"}','inbound','2026-09-24 12:00:00');`);
      const fdb = d as unknown as Parameters<typeof notify.resolveImOriginTarget>[0];

      const oIm = notify.resolveImOriginTarget(fdb, 't-im');
      crit('M5', oIm?.channelId === 'ch-dt' && oIm?.externalUserId === 'u-dt' && oIm?.channelType === 'dingtalk',
        'M5-9 **IM 任务把件投回来源会话**：`ctx.channel`/`ctx.externalUser` 原样取回（不"猜"、不"归并"、不另挑一处）',
        `目标=${JSON.stringify(oIm)}`);

      const oNoUser = notify.resolveImOriginTarget(fdb, 't-im-nouser');
      crit('M5', oNoUser?.channelId === 'ch-dt' && oNoUser?.externalUserId === 'u-dt-recent',
        'M5-10 **缺收件人只在该渠道内回落**：`ctx` 没记 `externalUser` ⇒ 取**该来源渠道**最近一条 inbound'
        + '（不是"全库最近说话的人"——那是文本路的回落法，件不能这么做）',
        `目标=${JSON.stringify(oNoUser)}`);

      const oGui = notify.resolveImOriginTarget(fdb, 't-gui');
      const txtGui = notify.resolveImNotifyTargets(fdb, 't-gui', true);
      crit('M5', oGui === null && txtGui.length === 1 && txtGui[0]?.channelId === 'ch-wx' && txtGui[0]?.externalUserId === 'u-wx',
        'M5-11 **★两条路判据刻意不同（同夹具、同任务）**：GUI 任务（无 `ctx.channel`）⇒ **推件路** `null`（不推），'
        + '而**文本路**照旧回落到最近一条 1:1 私聊 ⇒ 1 条。这不是"不一致"，是两条路**各自取证**：'
        + '文字可以投给"最近说过话的人"（保 GUI 任务可达，zx_20260909_1 A2 的有意行为），**一个 20MB 的件不行**。'
        + '群聊(11:00)/房间(12:00)都新于那条 1:1(09:00) 却**都没被选中** ⇒ 排除谓词真在生效',
        `推件路=${String(oGui)}；文本路=${JSON.stringify(txtGui)}`);

      const oDead = notify.resolveImOriginTarget(fdb, 't-im-deadch');
      const txtDead = notify.resolveImNotifyTargets(fdb, 't-im-deadch', true);
      crit('M5', oDead === null && txtDead.length === 0,
        'M5-12 **有来源渠道却解析不出 ⇒ 不回落**（原件行为，必须保住）：`ctx.channel="qqbot"` 而该渠道已 `inactive` ⇒ '
        + '推件路 `null`、文本路也**空**。把这种情形也"回落到最近私聊"，等于开始给与本次任务无关的人发件/发消息，'
        + '而账面上会显得"通知更可靠了"',
        `推件路=${String(oDead)}；文本路 ${txtDead.length} 条`);
    }

    // ── M5-g 接线面（判据已在上面真跑；此处钉"接上了没有 / 是不是一处真源"）────────────────
    {
      const isrc = stripComments(fs.readFileSync(path.join(MAIN, 'core/im/im-notify.ts'), 'utf-8'));
      const i = isrc.indexOf('export async function pushPrimaryDeliverables');
      const body = i >= 0 ? isrc.slice(i) : '';
      const kinds = (body.match(/enqueueImOutbox\(/g) || []).length;
      const texts = (body.match(/sendTextToTargets\(/g) || []).length;
      crit('M5', i > 0 && body.includes('resolveImOriginTarget(db, taskId)') && body.includes('if (!target)')
        && body.includes('不推送主成果') && body.includes('is_primary = 1') && body.includes("'primary_deliverable'")
        && kinds === 1 && body.includes('mediaPath: f.path') && texts === 2,
        'M5-13 **推件接上了，且只接来源会话**：候选集 = `is_primary = 1` 且非 `retired`；无来源会话 ⇒ **不推**并'
        + '`console.log` **如实记因**（静默不推的话"件没到"就一条线索都没有）；**发件失败走 `enqueueImOutbox` 这同一本账**'
        + '（带 `mediaPath` ⇒ 补发按件发，不降级成文件名）；超限 / 有件没附上都经 `sendTextToTargets` 出说明**恰 2 处**',
        `扫描面：im-notify.ts 的 \`pushPrimaryDeliverables\` 函数体（切出 ${body.length} 字符）；`
        + `enqueueImOutbox=${kinds} 处、sendTextToTargets=${texts} 处`);

      const ctxReads = (isrc.match(/SELECT context_json FROM wa_tasks/g) || []).length;
      const sends = (isrc.match(/sendImCompletionNotice\(/g) || []).length;
      const ledgers = (isrc.match(/enqueueImOutbox\(/g) || []).length;
      // zx_20261013_2 批一（重定向 · 承 feedback_retarget_assertions_to_stronger_source）：
      //   原判据写死 `ledgers === 2`＝**幻数计数**——批一给文本路补了第三个失败出口
      //   （"取发送模块失败"转落**同一本**账，与 `r.ok===false` 同形）后即假红，而**不变量本身并未破坏**。
      //   幻数计数→**逐成员枚举**：改钉**结构关系**——全文每一处 `enqueueImOutbox(` 都必须落在
      //   `sendTextToTargets`（文本失败）或 `pushPrimaryDeliverables`（发件失败）体内
      //   （体外落账点 = 0），且全文无对 `wa_im_outbox` 的裸 INSERT。这比"恰好两处"更强：
      //   它禁的是"另开一个落账点"，而"同一本账"恰恰是这个意思。
      const cut = (marker: string, endMarker: string): string => {
        const a = isrc.indexOf(marker);
        if (a < 0) return '';
        const b = isrc.indexOf(endMarker, a + marker.length);
        return isrc.slice(a, b < 0 ? undefined : b);
      };
      const textBody = cut('async function sendTextToTargets', 'export async function pushPrimaryDeliverables');
      const primBody = cut('export async function pushPrimaryDeliverables', 'export function markPauseNeeded');
      const inText = (textBody.match(/enqueueImOutbox\(/g) || []).length;
      const inPrim = (primBody.match(/enqueueImOutbox\(/g) || []).length;
      crit('M5', ctxReads === 1 && sends === 1 && ledgers === inText + inPrim && inText >= 1 && inPrim === 1
        && !/INSERT INTO wa_im_outbox/.test(isrc),
        'M5-14 **两件事各只有一处真源**：读 `ctx.channel`/`ctx.externalUser` 的 SQL 全文**恰 1 处**'
        + '（`taskOriginField`——两条路同引，不再各写一份"怎么找来源渠道"，那正是 G8/G9 的老病）；'
        + '`sendImCompletionNotice(` **恰 1 处**（在 `sendTextToTargets` 里）⇒ 文本与件说明走同一条发送路；'
        + '★**落账只此两条失败出口**：全文 `enqueueImOutbox(` 的每一处都落在 `sendTextToTargets`（文本失败；'
        + '含 `r.ok===false` 与"取发送模块失败"两条同账出口）或 `pushPrimaryDeliverables`（发件失败）**体内**'
        + '（`ledgers === inText + inPrim` ⇒ 体外落账点 = 0，即"都指向同一个落账函数"），'
        + '且全文没有对 `wa_im_outbox` 的裸 INSERT ⇒ 件与文本**同一本账**、同一套退避与终态，'
        + '不会出现"正文到了、说明没到"或"补发页只统计得到文字"两条真相',
        `context_json 读点=${ctxReads} 处；发送=${sends} 处；落账=${ledgers} 处（文本体 ${inText} + 发件体 ${inPrim}）；`
        + `裸 INSERT INTO wa_im_outbox=${/INSERT INTO wa_im_outbox/.test(isrc) ? '**有**' : '无'}`);
    }

    // ── M5-h 完成路的接线：**两条出口一把尺**，且**不塞进四路共引的既有通知回调** ────────────
    {
      const aiTask = stripComments(fs.readFileSync(path.join(MAIN, 'core/jobs/ai-task.ts'), 'utf-8'));
      const sites = aiTask.split('ctx.sendImPrimaryDeliverables(').length - 1;
      crit('M5', sites === 2 && aiTask.includes('sendImPrimaryDeliverables?: (taskId: string, projectId: string) => void;')
        && /statusRow\?\.status === 'completed'[\s\S]{0,160}sendImPrimaryDeliverables/.test(aiTask)
        && /taskRow\?\.status === 'completed'[\s\S]{0,160}sendImPrimaryDeliverables/.test(aiTask),
        'M5-15 **两条完成出口一把尺**：`ctx.sendImPrimaryDeliverables(` 全文**恰 2 处**'
        + '（`ai-task` 首跑完成 + `resume-ai-task` 恢复完成；只接一处则"恢复后干完的任务"永不推件），'
        + '且两处都在 `status === \'completed\'` 之下（失败/暂停也甩个 20MB 文件，那不叫推成果）；'
        + '**另起一个回调**而不塞进 `sendImNotification`——后者被完成/失败/暂停/超长在场四路共引',
        `调用点=${sites} 处`);

      const idx = stripComments(fs.readFileSync(path.join(MAIN, 'index.ts'), 'utf-8'));
      crit('M5', idx.includes('sendImPrimaryDeliverables:')
        && idx.includes("import('./core/im/im-notify.js')") && idx.includes('pushPrimaryDeliverables'),
        'M5-16 **主进程真接上**：`index.ts` 把 `ctx.sendImPrimaryDeliverables` 接到 `pushPrimaryDeliverables`'
        + '（动态 import，避免启动即拉整棵 IM 树）；整段 `catch` 吞掉 ⇒ 推件失败不阻断任务收尾',
        `index.ts 命中=${idx.includes('sendImPrimaryDeliverables:')} / 动态 import=${idx.includes("import('./core/im/im-notify.js')")}`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // §M6 模型选型：辅助路能力档归一处 · 能力回验 · 成本上限写端 · `/optimal` 归一处。
  //
  // ⚠ **分工如实（先读这段再读判据）**：`resolveOptimalModel` 的**回包形状**（价格二键在场、三级降级链
  //   三键在场、`capabilities` 纯追加且零命中路不带）由 **ANS 侧 vitest** 钉
  //   （`apps/ans-server/src/__tests__/models-routes.test.ts` 的 `M6-b` / `M6-a` 两例，直调该函数）。
  //   **不搬进 rr**，理由是结构性的：全仓 **没有任何 rr 脚本在运行时 import ans-server 源码**——
  //   `optimal-model.ts → security.ts → @worker-ant/ans-client + pino + fs.mkdirSync(data/logs)`，
  //   一引就把 ANS 的导入副作用带进回归进程。rr 对 ANS 只有"**读文本**"这一种接触（见本段 M6-9）。
  //   故此处只钉**能在 rr 里真跑的那一半**，外加 ANS 的**归一处事实**（可由文本判定）。
  console.log('\n【M6】模型选型：辅助路能力档一处 · 能力回验 · 成本上限写端 · `/optimal` 归一处');
  {
    // ── M6-1 档的**逐字形状**（含键序）────────────────────────────────────────────────
    //   `rr_zx_20260921` 的 C21b 按 `JSON.stringify` 与本函数逐字比对拆解请求 ⇒ 键序漂了那边就红。
    //   故这里把**键序**也当判据，不是"内容对就行"。
    const aux = auxModelRequest();
    const auxJson = JSON.stringify(aux);
    crit('M6', auxJson === '{"capabilities":["chat"],"strategy":"cost-optimal","excludeCapabilities":["reasoning"]}'
      && AUX_LLM_CAPABILITIES.join(',') === 'chat' && AUX_LLM_EXCLUDE_CAPABILITIES.join(',') === 'reasoning'
      && AUX_LLM_STRATEGY === 'cost-optimal',
      'M6-1 **档的逐字形状**：辅助路请求**恰三键**、键序 `capabilities,strategy,excludeCapabilities`、值逐字'
      + '（`[\'chat\']` / `cost-optimal` / `[\'reasoning\']`）——键序是被下游 `JSON.stringify` 比对吃住的，'
      + '不是"内容对就行"',
      `JSON.stringify(auxModelRequest()) = ${auxJson}`);

    // ── M6-2 **另一侧标本**：主执行路**不带** exclude、且能力里**有** reasoning ────────────
    //   G-2：只钉辅助路的话，"把全仓都改成排除 reasoning"这个把主路也一起改坏的变体照样全票通过。
    const mainReq = buildModelRequest({ archetype: 'research', strategy: 'cost-optimal' });
    const mainCaps = mainReq.capabilities as string[];
    crit('M6', !('excludeCapabilities' in mainReq) && mainCaps.includes('reasoning') && !mainCaps.includes('vision')
      && !('maxCostPer1k' in mainReq),
      'M6-2 **另一侧标本**：主执行路（`research` 形态）**不带** `excludeCapabilities`、能力里**有** `reasoning`'
      + '——正是辅助路排除的那一个；且 `maxCostPer1k` **未配置时该键根本不出现**'
      + '（键在场且为 0 会被 ANS 读成"只要免费模型"，把付费模型一次筛没）',
      `主路键=[${Object.keys(mainReq).join(',')}] 能力=[${mainCaps.join(',')}]`);

    // ── M6-3 可选策略**只动 strategy**，且每次发**新数组**（档不是共享可变物）──────────────
    const auxBal = auxModelRequest({ strategy: 'balanced' });
    crit('M6', auxBal.strategy === 'balanced'
      && JSON.stringify(auxBal.capabilities) === '["chat"]'
      && JSON.stringify(auxBal.excludeCapabilities) === '["reasoning"]'
      && aux.capabilities !== auxBal.capabilities && aux.excludeCapabilities !== auxBal.excludeCapabilities,
      'M6-3 **只动 strategy、且每次发新数组**：`{strategy:\'balanced\'}` 改的**只是** strategy 这一键'
      + '（顺手改能力口径是另一件事，会悄悄挪动选到谁）；且两次调用拿到的是**不同数组实例**'
      + '——同引用的话，任一调用点 `push` 一下就把档改了、改的还是所有人',
      `balanced=${JSON.stringify(auxBal)}｜能力同引用=${aux.capabilities === auxBal.capabilities} 排除同引用=${aux.excludeCapabilities === auxBal.excludeCapabilities}`);

    // ── M6-4 档是**唯一真源**：全 `src/main` 去注释面 1 处定义 + 19 处调用，零手写 exclude ──
    //   扫描面自证（G-3）：报出扫了多少文件、命中分布在哪；"零命中"必须连扫描面一起说。
    const m6src = (fs.readdirSync(MAIN, { recursive: true }) as string[])
      .filter((rel) => rel.endsWith('.ts'))
      .map((rel) => ({ rel: rel.split(path.sep).join('/'), src: stripComments(fs.readFileSync(path.join(MAIN, rel), 'utf-8')) }));
    const sites = m6src
      .map((f) => ({ rel: f.rel, n: f.src.split('auxModelRequest(').length - 1 }))
      .filter((s) => s.n > 0);
    const totalHits = sites.reduce((a, s) => a + s.n, 0);
    const defHits = sites.filter((s) => s.rel === 'core/model-request.ts').reduce((a, s) => a + s.n, 0);
    const callFiles = sites.filter((s) => s.rel !== 'core/model-request.ts');
    const handWritten = m6src
      .filter((f) => f.rel !== 'core/model-request.ts' && /excludeCapabilities\s*:\s*\[\s*['"]reasoning['"]/.test(f.src))
      .map((f) => f.rel);
    //   zx_20261004 M14：`memory-manager.ts` 的 kg 读取函数整体迁至 `core/memory-kg.ts`，
    //   其中一个调用点随之搬家（memory-manager 13→12、memory-kg 0→1）——**总量与"零手写"两钉不变**，
    //   仅按新分布回填文件数与落点（病根=手写 exclude，未动）。
    //   zx_20261018_2 批七：巩固簇迁至 `core/memory-consolidation.ts`，两个调用点随之搬家
    //   （memory-manager 12→10、memory-consolidation 0→2）——同样**总量与"零手写"两钉不变**，仅回填分布。
    //   zx_20261029_1「知」：新增辅助路调用点 `core/project-brief-job.ts`（读仓生成项目须知，balanced）
    //   ⇒ 总量 20→21（定义仍 1、调用 20）、文件数 7→8；**"零手写 exclude"这一定钉不变**。
    //   zx_20261029_2「通」：新增辅助路调用点 `core/intent-model-plan.ts`（规则未中时由模型出计划）
    //   ⇒ 总量 21→22（定义仍 1、调用 21）、文件数 8→9；**"零手写 exclude"这一定钉不变**。
    crit('M6', totalHits === 22 && defHits === 1 && callFiles.length === 9 && handWritten.length === 0,
      'M6-4 **档的唯一真源**：去注释面 `auxModelRequest(` 全 `src/main` 恰 **22** 处 = **1 定义 + 21 调用**，'
      + '调用点落在 **9 个文件**（agent-executor 3 / memory-consolidation 2 / memory-kg 1 / memory-manager 10 / output-validator 1 / jobs 1 / task-decompose 1 / project-brief-job 1 / intent-model-plan 1），'
      + '且**除档自身外零处**手写 `excludeCapabilities: [\'reasoning\']`——病根正是这些调用处曾各写一份、'
      + '与主路口径互斥；**数字是钉**：新加调用点会让此处变红，逼人回来确认它确实走了本档',
      `扫描面 ${m6src.length} 个 .ts；总命中 ${totalHits}（定义 ${defHits} + 调用 ${totalHits - defHits}）；`
      + `分布 ${callFiles.map((s) => `${s.rel}=${s.n}`).join(' ')}；手写 exclude 违规 ${handWritten.length} 处${handWritten.length ? `：${handWritten.join(', ')}` : ''}`);

    // ── M6-5 `compareModelCapabilities` **三态**（缺 / 空 / 无从比对）──────────────────────
    const cmpMiss = compareModelCapabilities(['chat', 'vision'], { capabilities: ['chat'] });
    const cmpOk = compareModelCapabilities(['chat'], { capabilities: ['chat', 'code'] });
    const cmpNulls = [
      compareModelCapabilities(['chat'], { model_name: 'x' }),
      compareModelCapabilities(['chat'], null),
      compareModelCapabilities(['chat'], { capabilities: 'chat' }),
    ];
    crit('M6', cmpMiss?.missing.join(',') === 'vision' && cmpMiss?.got.join(',') === 'chat'
      && cmpOk?.missing.length === 0 && cmpOk?.got.join(',') === 'chat,code'
      && cmpNulls.every((x) => x === null),
      'M6-5 **回验三态**：需求 ⊄ 实得 ⇒ **逐个点名** `missing`（不只说"不匹配"）；实得**多于**需求 ⇒ `missing` 空'
      + '（多是好事，如文档形态要 `chat` 而模型还会 `code`）；回包**没带** `capabilities`（旧 ANS / 非数组）'
      + '⇒ `null`——**既不报"相符"也不报"不符"**（编一个结论比不说更坏）。**三态缺一不可**：'
      + '只钉前两态的话，"回包没带就当作相符"这个变体全票通过',
      `缺=[${cmpMiss?.got.join(',')}]-[${cmpMiss?.missing.join(',')}] 多=${JSON.stringify(cmpOk)} 无从比对=${cmpNulls.map(String).join(',')}`);

    // ── M6-6 选型失败摘要：**取不出就如实少说**，且只有一处会去挖它 ─────────────────────
    const withSum = matchFailureSummary({ error: { code: 'NOT_FOUND', diagnostics: { summary: '能力闸归零：4 → 0' } } });
    const noSum = [
      matchFailureSummary({ error: { code: 'NOT_FOUND' } }),
      matchFailureSummary(undefined),
      matchFailureSummary({ error: 'boom' }),
      matchFailureSummary({ error: { diagnostics: { summary: 42 } } }),
    ];
    // `describeModelSelectionFailure` 真去调它（动态引，取的是零依赖的 `model-request.ts`——
    //   zx_20261018_2 批一迁址，取数口随真源重定向；本模块不再牵 ans-client）。
    const at = (await import(`../${A}/src/main/core/model-request.js`)) as
      typeof import('../apps/worker-ant-desktop/src/main/core/model-request.js');
    const said = at.describeModelSelectionFailure({ error: { code: 'NOT_FOUND', message: '没有找到匹配的模型', diagnostics: { summary: '能力闸归零：4 → 0' } } });
    const saidBare = at.describeModelSelectionFailure({ error: { code: 'NOT_FOUND', message: '没有找到匹配的模型' } });
    const summaryDiggers = m6src.filter((f) => f.rel !== 'core/model-request.ts' && /\.diagnostics\b/.test(f.src)).map((f) => f.rel);
    crit('M6', withSum === '能力闸归零：4 → 0' && noSum.every((s) => s === '')
      && typeof said === 'string' && said.includes('能力闸归零：4 → 0')
      && typeof saidBare === 'string' && !saidBare.includes('（')
      && summaryDiggers.length === 0,
      'M6-6 **取不出就如实少说**：`matchFailureSummary` 认的是**形状**（`error.diagnostics.summary` 是字符串）'
      + '——键缺 / 非对象 / `summary` 是数字 一律空串（**不替 ANS 编一句**）；`describeModelSelectionFailure` '
      + '**真去调它**（有摘要时括号里带成因，没有时**不出括号**，承 `rr_zx_20260921_1` 的 M2 标本）；'
      + '且**除本函数外零处**代码再挖 `.diagnostics`（同一判据写两处迟早分家，G8/G9 老病）'
      + '——扫描面自证：' + `${m6src.length} 个 .ts 里去注释面命中 ${summaryDiggers.length} 处`,
      `有摘要=${JSON.stringify(said)}｜无摘要=${JSON.stringify(saidBare)}｜挖 diagnostics 的其它落点=${summaryDiggers.length} 处`);

    // ── M6-7 成本上限**读端**的口径：脏值一律当"未配置"，`0` 不是"不限" ─────────────────
    const fakeDb = (value: string | undefined) => readMaxCostPer1k({
      prepare: () => ({ get: () => (value === undefined ? undefined : { value }) }),
    });
    const c05 = fakeDb('0.05');
    const zeros = [fakeDb('0'), fakeDb('-1'), fakeDb('abc'), fakeDb(''), fakeDb(undefined)].map((x) => String(x));
    crit('M6', MAX_COST_PER_1K_KEY === 'engine.model_max_cost_per1k' && c05 === 0.05
      && zeros.every((z) => z === 'undefined'),
      'M6-7 **`0` 不是"不限"**：`readMaxCostPer1k` 对 `0` / 负数 / 非数 / 空串 / 键缺席一律按**未配置**'
      + '（`undefined`）——0 在 ANS 侧是"只要免费模型"的**合法上限**，把脏值读成 0 会让整池付费模型凭空消失；'
      + '键名取**导出常量**（写端与本处同键，不手抄）',
      `KEY=${MAX_COST_PER_1K_KEY}｜'0.05'⇒${String(c05)}｜脏值⇒[${zeros.join(',')}]`);

    // ── M6-8 成本上限**写端**（GUI）接线：键经 import 引入、规范化与读端同口径 ─────────────
    //   承本仓既例：renderer 不在 `src/main` 扫描面内，且引不动 main 的运行时 ⇒ 只扫**去注释面**的接线。
    const settings = stripComments(fs.readFileSync(
      path.join(root, A, 'renderer/src/pages/SettingsPage.tsx'), 'utf-8'));
    crit('M6', settings.includes("import { MAX_COST_PER_1K_KEY } from '../../../src/main/core/model-request.js';")
      && settings.includes('invoke(\'settings:set\', MAX_COST_PER_1K_KEY, v)')
      && settings.includes('Number.isFinite(n) && n > 0 ? String(n) : \'\'')
      && settings.includes('commitMaxCostPer1k(e.target.value)')
      && !settings.includes("'engine.model_max_cost_per1k'"),
      'M6-8 **写端接线**：`SettingsPage` 的成本上限（a）**键名经 import** 自读端真源'
      + '（去注释面**零处**手写 `\'engine.model_max_cost_per1k\'`——手抄即第二份真源）；'
      + '（b）失焦提交 `settings:set`；（c）规范化式 `Number.isFinite(n) && n > 0 ? String(n) : \'\'` '
      + '与读端 `readMaxCostPer1k` **同口径**（`0`/脏值写空串 = 未配置，而非写 0 变成"只要免费模型"）',
      `import 命中=${settings.includes('MAX_COST_PER_1K_KEY } from')} 手写键=${settings.includes("'engine.model_max_cost_per1k'")} 提交点=${settings.includes("commitMaxCostPer1k(e.target.value)")}`);

    // ── M6-e① ans-client 的缓存闸：**成功才入缓存**（零命中回 200 + 错误体，别再冻一分钟）────
    //   两侧标本：错误体 ⇒ 第二次仍要真发请求（未入缓存）；成功体 ⇒ 第二次命中缓存（call 数不增）。
    //   直引 `packages/ans-client/src/client.ts`（深引 src，不经 barrel——barrel 会拉 MCP/A2A SDK）：
    //   它的静态链只有 `crypto.js`(node:crypto) 与 `cache.js`(纯 Map)，且 SDK 两处是 `import type`（编译期擦除）。
    //   注入手法：替掉实例上的 `request`（TS 的 `private` 只在编译期，运行时可观测），故这是**真行为判据**，
    //   不是"源码里写着"那种骗得过自己的断言。
    {
      const { AnsClient } = await import('../packages/ans-client/src/client.js');
      const drive = async (reply: unknown): Promise<number> => {
        const c = new AnsClient({ serverUrl: 'http://127.0.0.1:1', apiKey: 'k', secretKey: 's' });
        let calls = 0;
        (c as unknown as { request: (p: string, o: unknown) => Promise<unknown> }).request =
          async () => { calls++; return reply; };
        await c.getOptimalModel({ capabilities: ['chat'] } as never);
        await c.getOptimalModel({ capabilities: ['chat'] } as never);
        return calls;
      };
      const errCalls = await drive({ error: { code: 'NOT_FOUND', message: '没有找到匹配的模型' } });
      const okCalls = await drive({ id: 'm1', model_name: 'gpt-4o', url: 'https://x/v1', api_key: 'sk' });
      crit('M6', errCalls === 2 && okCalls === 1,
        'M6-e① **只缓存真的点到名的那一份**：零命中（HTTP 200 + `{error}` 体）**不入缓存**'
        + '——否则一次瞬时漏斗空转被固化成一分钟内"这批能力没有模型"，而配额刷新/端点恢复后它本已成立；'
        + '成功路（带 `id`）照旧入缓存（同参第二次不再发请求）。判据取**正向**（认成功形状）：'
        + '将来多出一种预料外的失败形状时，它自然不入缓存，不会被当成成功冻住',
        `错误体 ⇒ request 调用 ${errCalls} 次（期望 2 = 未缓存）；成功体 ⇒ ${okCalls} 次（期望 1 = 已缓存）`);
    }

    // ── M6-9 ANS 侧 `/api/v1/models/optimal` **恰一份实现**（文本面；回包形状见 §M6 开头的分工）──
    let ansSrc = '';
    (function walk(d: string): void {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); }
        else if (e.name.endsWith('.ts')) ansSrc += '\n' + stripComments(fs.readFileSync(p, 'utf-8'));
      }
    })(path.join(root, 'apps/ans-server/src'));
    const routeDecls = ansSrc.split("'/api/v1/models/optimal'").length - 1;
    const resolveUses = ansSrc.split('resolveOptimalModel(').length - 1;
    const deadMsg = ['请在ANS中注册AI模型并配置端点', '请在ANS中配置模型端点的API Key']
      .filter((s) => ansSrc.includes(s));
    crit('M6', routeDecls === 1 && resolveUses === 2 && deadMsg.length === 0,
      'M6-9 **同名路径只能有一份实现**：去注释面全 `ans-server/src`（除 `__tests__`）里 '
      + '`\'/api/v1/models/optimal\'` 路径**恰 1 处声明**、`resolveOptimalModel(` **恰 2 处**'
      + '（1 定义 + `index.ts` 薄壳 1 调用），死掉那份的两个**独有文案**（`请在ANS中注册AI模型并配置端点` / '
      + '`请在ANS中配置模型端点的API Key`）**全仓零命中**。'
      + '病根是 Elysia **后注册者胜**：两份回包形状不同（价格与三级降级链只有活体有），'
      + '"注册顺序"这个与业务无关的偶然事实会静默决定调用方拿不拿得到价格',
      `路由声明 ${routeDecls} 处；resolveOptimalModel ${resolveUses} 处（定义 1 + 调用 1）；死实现独有文案命中 ${deadMsg.length} 处`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // §M7 附件去向：**词表一处** · 落库与上屏同一形状 · 老任务不编事实
  console.log('\n【M7】本次附件去处：词表一处 · 落库/上屏同一形状 · 老任务不编事实');
  {
    // ── M7-1 落库视图：件名回退 basename，可选键**缺就不出现**（不是空串占位）──────────────
    const views = toAttachmentOutcomeViews([
      { path: '/d/a/report.pdf', family: 'document', status: 'inlined', bytes: 0 },
      { path: '/d/a/no-name.png', family: 'image', status: 'omitted', reason: 'over_limit' },
      { path: '', fileName: '平台给的名.mp3', family: 'audio', status: 'failed', reason: '' },
    ]);
    crit('M7', views[0]?.fileName === 'report.pdf' && views[0]?.bytes === 0
      && !('reason' in (views[0] as object))
      && views[1]?.fileName === 'no-name.png' && views[1]?.reason === 'over_limit'
      && !('bytes' in (views[1] as object))
      && views[2]?.fileName === '平台给的名.mp3' && !('reason' in (views[2] as object)),
      'M7-1 **落库视图**：件名缺就回退到盘上 basename（上屏不许出现空名一行）；'
      + '`bytes: 0` **键在场**（0 字节是合法事实，与"没这个数"两回事）；'
      + '`reason` 缺 / 空串 ⇒ **键根本不出现**（写成 `reason: \'\'` 会让页面多渲染一行空"原因："）',
      `[0]=${JSON.stringify(views[0])} [1]=${JSON.stringify(views[1])}`);

    // ── M7-2 读侧收敛**两侧**：老任务 ⇒ 空数组；坏行 ⇒ 逐条丢弃（不是整块炸掉）─────────────
    const parsed = parseAttachmentOutcomeViews([
      { fileName: 'ok.md', family: 'document', status: 'inlined', path: '/d/ok.md' },
      { family: 'image', status: 'omitted', path: '/d/x.png', reason: 'over_limit' },
      { path: '/d/bad-status.md', status: 'unknown' },
      { status: 'inlined' },
      null,
      'not-an-object',
      { path: '/d/no-name.txt', status: 'failed' },
    ]);
    const parses = [undefined, null, {}, 'x', 42].map((r) => parseAttachmentOutcomeViews(r).length);
    crit('M7', parsed.length === 3 && parsed[0]?.fileName === 'ok.md'
      // ⚠ 读侧的兜底取**原路径**（写侧才回退 basename）——两侧兜底**刻意不同**，此处逐字钉住：
      //   写侧保证"落库的每行都有非空件名"，故读侧这条路只对**非本模块写出**的脏行生效；
      //   若哪天有人把读侧也改成 basename，这一条会红并逼人回来看这个不对称是不是有意为之。
      && parsed[1]?.fileName === '/d/x.png' && !('bytes' in (parsed[1] as object))
      && parsed[2]?.fileName === '/d/no-name.txt'
      && parses.every((n) => n === 0),
      'M7-2 **读侧收敛两侧**：库里躺着的是**历史各轮写下的 JSON**，内容可能缺字段——'
      + '`status` 不在册 / 缺 `path` / `null` / 非对象 的行**逐条丢弃**（不是整块炸）；'
      + '而**老任务没有此键**（`undefined`/`null`/非数组）⇒ **空数组** ⇒ 页面**整块不渲染**'
      + '（显示"0 个附件"是个编造出来的事实）。扫描面自证：本例餵了 7 行原始数据，收敛出 '
      + `${parsed.length} 行、丢掉 ${7 - parsed.length} 行`,
      `收敛=[${parsed.map((p) => `${p.fileName}:${p.status}`).join(' ')}] ｜ 非数组五态 ⇒ [${parses.join(',')}]`);

    // ── M7-3 写-读**回环一致**（同一形状的第二次落地点，漂了就两边对不上）──────────────────
    const roundTrip = parseAttachmentOutcomeViews(JSON.parse(JSON.stringify(views)));
    crit('M7', JSON.stringify(roundTrip) === JSON.stringify(views),
      'M7-3 **写-读回环**：`toAttachmentOutcomeViews` 写出、经 `JSON.stringify/parse` 一圈、'
      + '再 `parseAttachmentOutcomeViews` 读回 ⇒ **逐字段相等**（这是"落库与上屏同一形状"的可执行表达；'
      + '两侧各写一份映射的话，回环就会在某天悄悄丢一个字段而无人察觉）',
      `回环=${JSON.stringify(roundTrip) === JSON.stringify(views)}`);

    // ── M7-4 词表**唯一**：取值集合与文案表键集合必须同进同出 ────────────────────────────
    crit('M7', ATTACHMENT_OUTCOME_STATUSES.join(',') === 'inlined,omitted,failed'
      && Object.keys(ATTACHMENT_STATUS_LABEL).sort().join(',') === 'failed,inlined,omitted'
      && ATTACHMENT_STATUS_LABEL.omitted === '未内联' && ATTACHMENT_STATUS_LABEL.inlined === '内联'
      && ATTACHMENT_STATUS_LABEL.failed === '失败',
      'M7-4 **词表一处**：三态取值与中文文案表**键集合相同**（加一态时两处同时报类型错，'
      + '这就是它俩在同一模块的理由）；`omitted` 的中文刻意是**「未内联」而非「已省略」**——'
      + '前者说"没进上下文"这个事实，后者容易被读成"系统主动丢了它"，而用户据此决定要不要自己去看原件',
      `取值=[${ATTACHMENT_OUTCOME_STATUSES.join(',')}] 文案=${JSON.stringify(ATTACHMENT_STATUS_LABEL)}`);

    // ── M7-5 renderer 是**词表的第二个落点**：引同一份，且页内零处手写中文三态 ─────────────
    const detail = stripComments(fs.readFileSync(
      path.join(root, A, 'renderer/src/pages/TaskDetailPage.tsx'), 'utf-8'));
    const zhHits = (['内联', '未内联'] as const).filter((w) => detail.includes(w));
    crit('M7', detail.includes('parseAttachmentOutcomeViews') && detail.includes('ATTACHMENT_STATUS_LABEL')
      && detail.includes('const [showAtts, setShowAtts] = useState(false);')
      && detail.includes('（{atts.length} 件）')
      && /atts\.length > 0 &&/.test(detail)
      && zhHits.length === 0,
      'M7-5 **第二落点引同一份**：`TaskDetailPage` 引 `parseAttachmentOutcomeViews` 与 '
      + '`ATTACHMENT_STATUS_LABEL`（去注释面**零处**手写「内联」/「未内联」——手抄即第二份词表，G8/G9 老病）；'
      + '默认**折叠**（`useState(false)`）且折叠头**报件数**（折叠态连几件都看不见就叫"消失"不叫"折叠"）；'
      + '`atts.length > 0 &&` ⇒ 无件时**整块不渲染**',
      `引解析=${detail.includes('parseAttachmentOutcomeViews')} 引文案=${detail.includes('ATTACHMENT_STATUS_LABEL')} `
      + `默认折叠=${detail.includes('useState(false)')} 件数头=${detail.includes('（{atts.length} 件）')} 手写中文=${zhHits.length} 处`);

    // ── M7-6 主进程**真落库**：单键单次 `json_set` + 写后回读 + 既有 `attachments` 一字不动 ──
    const exec = stripComments(fs.readFileSync(path.join(MAIN, 'core/agent-executor.ts'), 'utf-8'));
    const setCalls = exec.split(`'$.attachments_outcomes'`).length - 1;
    const readCalls = exec.split('json_array_length(json_extract').length - 1;
    const legacyWrites = exec.match(/\$\.attachments'/g)?.length ?? 0;
    crit('M7', setCalls === 2 && readCalls === 1
      && exec.includes("json_set(COALESCE(context_json,'{}'), '$.attachments_outcomes', json(?))")
      && legacyWrites === 0,
      'M7-6 **落库是真写的**：`\'$.attachments_outcomes\'` **恰 2 处**（1 处 `json_set` 写 + 1 处 '
      + '`json_array_length(json_extract(...))` 回读）；写入是**单次 `json_set` + 单组 path/value**'
      + '（层数恒为 1，不随键值对数漂——本仓 2026-09-24 刚因"手工套娃少一层"吞过一次语法错），'
      + '数组走 `json(?)` 包一层；**写后回读**（不验就等于没写）；'
      + '且**零处**动既有 `attachments` 键（那是入站来件登记，与"去向"是两件事）',
      `attachments_outcomes 落点=${setCalls} 回读=${readCalls} 旧 attachments 写入=${legacyWrites} 处`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // §2c 追加界面优化（用户 2026-09-24 点名）——**不受 M1–M8 批次门管辖**（独立于批次排期）。
  // ⚠ 这三条的病根在 renderer，但 renderer 引不动（React 页 + 打包器）。治法承本仓既例：
  //   把**规则**放进零依赖 main 模块（`core/deliverable-tree.ts`），rr 钉规则、渲染层引同一份；
  //   只有"接线在不在"这类才扫渲染层源码（扫的是**去注释面**，防注释里的同名字样骗过判据）。
  // ⚠ G-2 两侧标本：每条"该命中"都配一只"该不命中"（剥前缀 / **不剥**；并段 / **不并**）。
  console.log('\n【UI】§2c 任务详情界面：记忆注入上移折叠 · 事件时间线折叠 · 产出物目录树');
  {
    interface Row { id: string; name: string; file_path?: string }

    // ── UI-1 公共前缀**该剥**（多件共享一长段绝对前缀 ⇒ 逐段展开就是纯噪音）────────────
    const samePrefix: Row[] = [
      { id: 'a', name: 'e1', file_path: '/Users/u/proj/code/src/alpha.md' },
      { id: 'b', name: 'e2', file_path: '/Users/u/proj/code/src/deep/beta.md' },
      { id: 'c', name: 'e3', file_path: '/Users/u/proj/code/readme.md' },
    ];
    const t1 = buildDeliverableTree(samePrefix);
    ok(JSON.stringify(t1.commonPrefix) === JSON.stringify(['Users', 'u', 'proj', 'code'])
      && t1.root.length === 2
      && t1.root.map((n) => n.name).join(',') === 'src,readme.md',
      'UI-1 **公共前缀该剥**：三件共享 `/Users/u/proj/code` ⇒ 剥到该处，根下只剩 `src` 与 `readme.md`（不再逐段挂 4 层噪音）',
      `commonPrefix=${JSON.stringify(t1.commonPrefix)} root=[${t1.root.map((n) => n.name).join(', ')}]`);

    // ── UI-2 前缀**不该剥**（差异在首段 ⇒ 没有公共目录段，不许"为好看"砍掉真实差异）──────
    //    两侧标本的另一侧：只有 UI-1 的话，一个"永远剥掉首段"的过宽实现照样全票通过。
    const diffPrefix: Row[] = [
      { id: 'd', name: 'f1', file_path: '/left/x/a.md' },
      { id: 'd2', name: 'f2', file_path: '/left/y/b.md' },
      { id: 'e', name: 'f3', file_path: '/right/z/c.md' },
    ];
    const t2 = buildDeliverableTree(diffPrefix);
    const left2 = t2.root[0];
    ok(t2.commonPrefix.length === 0
      && t2.root.map((n) => n.name).join(',') === 'left,right/z'
      && left2?.kind === 'dir' && left2.name === 'left' && left2.count === 2,
      'UI-2 **差异不剥**：首段就分岔（`left` vs `right`）⇒ `commonPrefix` 为空，两族的真实首段名都留着'
      + '（`left` 因有 `x`/`y` 两支而保持单段名；`right` 只有一条独路 `z` ⇒ 并段，两者各按各自事实）',
      `commonPrefix=${JSON.stringify(t2.commonPrefix)} root=[${t2.root.map((n) => n.name).join(', ')}]`);

    // ── UI-3 没有盘上路径的件**不塞假目录**（空 / 只有分隔符 / 全空白三态都算"没有"）──────
    const noPathRows: Row[] = [
      { id: 'p', name: '有路径', file_path: '/r/a.md' },
      { id: 'q', name: '空串', file_path: '' },
      { id: 'r', name: '只有斜杠', file_path: '/' },
      { id: 's', name: '只有反斜杠', file_path: '\\\\' },
      { id: 't', name: '全空白' },
      { id: 'u', name: '空白路径', file_path: '   ' },
    ];
    const t3 = buildDeliverableTree(noPathRows);
    const leafNames3: string[] = [];
    (function collect(ns: typeof t3.root): void { for (const n of ns) { if (n.kind === 'dir') collect(n.children); else leafNames3.push(n.name); } })(t3.root);
    ok(t3.noPath.length === 5 && leafNames3.length === 1
      && t3.noPath.every((x) => x.id !== 'p') && t3.noPath.map((x) => x.id).join(',') === 'q,r,s,t,u',
      'UI-3 **无路径不编造归属**：空串 / `/` / `\\` / 缺键 / 全空白 五件全部落 `noPath` 桶，树里只有唯一有路径的那件',
      `noPath=[${t3.noPath.map((x) => x.id).join(',')}] 树内叶子=[${leafNames3.join(',')}]`);

    // ── UI-4 **摆法不是筛选**：展平（树 + noPath）逐条等于原集合（不丢件、不重件）────────
    //    正反两面都断言：**数量**相等（防丢/防重）且 **id 集合**相等（防"数量对但换了件"）。
    const mixed: Row[] = [
      { id: '1', name: 'n1', file_path: '/Users/u/p/x/a.md' },
      { id: '2', name: 'n2', file_path: '/Users/u/p/x/b.md' },
      { id: '3', name: 'n3', file_path: '/Users/u/p/y/c.md' },
      { id: '4', name: 'n4', file_path: '/Users/u/p/y/z/d.md' },
      { id: '5', name: 'n5' },
      { id: '6', name: 'n6', file_path: '/Users/u/p/e.md' },
    ];
    const t4 = buildDeliverableTree(mixed);
    const flat4: Row[] = [];
    (function collect(ns: typeof t4.root): void { for (const n of ns) { if (n.kind === 'dir') collect(n.children); else flat4.push(n.item); } })(t4.root);
    const ids4 = new Set(flat4.map((x) => x.id));
    ok(flat4.length + t4.noPath.length === mixed.length
      && ids4.size === flat4.length
      && mixed.every((m) => ids4.has(m.id) || t4.noPath.some((n) => n.id === m.id)),
      'UI-4 **摆法不筛件**：树 6 条（含 noPath 1 条）与传入**逐条相等**——数量相等且 id 集合一一对上',
      `树内=${flat4.map((x) => x.id).join(',')} noPath=${t4.noPath.map((x) => x.id).join(',')} 传入=${mixed.length} 条`);

    // ── UI-5 单子目录链**该并**；有分叉**不并**（两侧标本）──────────────────────────────
    const chain: Row[] = [
      { id: 'c1', name: 'x', file_path: '/r/src/main/java/com/a/b/C.java' },
      { id: 'c1b', name: 'x', file_path: '/r/kotlin/K.kt' },
    ];
    const t5a = buildDeliverableTree(chain);
    // ⚠ 按**名字**找、不按 `root[0]`——同层按名字序，`kotlin` 排在 `src/…` 前（本轮实测踩过：按位置取只得 `kotlin`）
    const chainTop = t5a.root.find((n) => n.kind === 'dir' && n.name === 'src/main/java/com/a/b');
    ok(!!chainTop && chainTop.kind === 'dir' && chainTop.count === 1
      && chainTop.children.length === 1 && chainTop.children[0]!.kind === 'file',
      'UI-5 **单链并段**：`src`→`main`→`java`→`com`→`a`→`b` 六层独路并成**一行**（缩进不再吃掉版面；'
      + '真库 Java 包路径会挂到 8–10 层，正是这条要治的）',
      `链标本根节点=[${t5a.root.map((n) => `${n.kind}:${n.name}`).join(', ')}]；命中并段节点=${chainTop?.kind === 'dir' ? `dir「${chainTop.name}」(count=${chainTop.count})` : '**未找到**'}`);
    const fork: Row[] = [
      { id: 'c2', name: 'x', file_path: '/r/src/main/java/A.java' },
      { id: 'c3', name: 'x', file_path: '/r/src/main/kotlin/B.kt' },
      { id: 'c4', name: 'x', file_path: '/r/other/O.txt' },
    ];
    const t5b = buildDeliverableTree(fork);
    const forkTop = t5b.root.find((n) => n.kind === 'dir' && n.name === 'src/main');
    ok(!!forkTop && forkTop.kind === 'dir' && forkTop.children.length === 2
      && forkTop.children.every((c) => c.kind === 'dir' && c.count === 1 && c.children.length === 1),
      'UI-5b **分叉不并**：`src/main` 下分 `java`/`kotlin` 两支 ⇒ 并到此为止（两端各自只有 1 件，故都不再并）',
      `分叉标本根节点=[${t5b.root.map((n) => `${n.kind}:${n.name}`).join(', ')}]；\`src/main\` 直接子节点=${forkTop?.kind === 'dir' ? forkTop.children.map((c) => c.name).join(',') : '**未找到**'}`);

    // ── UI-6 count 是**后代**件数（不是直接子件数）——折叠/缩进时靠它看出分量 ─────────────
    const counts: Row[] = [
      { id: 'k1', name: 'n', file_path: '/r/dir1/sub1/a.md' },
      { id: 'k2', name: 'n', file_path: '/r/dir1/sub1/b.md' },
      { id: 'k3', name: 'n', file_path: '/r/dir1/sub2/c.md' },
      { id: 'k4', name: 'n', file_path: '/r/other/o.txt' },
    ];
    const t6 = buildDeliverableTree(counts);
    const dir1 = t6.root[0];
    ok(dir1?.kind === 'dir' && dir1.name === 'dir1' && dir1.count === 3
      && dir1.children.every((c) => c.kind === 'dir' && c.count === (c.name === 'sub1' ? 2 : 1)),
      'UI-6 **count 是后代件数**：`dir1` 直接挂着 0 个文件，但仍报 **3**（= 两个子目录各自后代数之和）',
      `dir1.count=${dir1?.kind === 'dir' ? dir1.count : 'n/a'} 子节点=${dir1?.kind === 'dir' ? dir1.children.map((c) => `${c.name}=${c.count}`).join(' ') : 'n/a'}`);

    // ── UI-7 同层**目录在前、文件叶在后**（目录树的常规读法，不让文件把目录冲散）─────────
    const orderRows: Row[] = [
      { id: 'o1', name: 'z', file_path: '/r/aaa.md' },
      { id: 'o2', name: 'a', file_path: '/r/dirz/b.md' },
      { id: 'o3', name: 'm', file_path: '/r/dira/c.md' },
    ];
    const t7 = buildDeliverableTree(orderRows);
    ok(t7.root.map((n) => `${n.kind}:${n.name}`).join(',') === 'dir:dira,dir:dirz,file:aaa.md',
      'UI-7 **目录在前**：同层里 `dira`/`dirz` 两个目录排在文件 `aaa.md` 之前（各自内部再按名字序）',
      `根序=[${t7.root.map((n) => `${n.kind}:${n.name}`).join(', ')}]`);

    // ── UI-8 两种分隔符都认（盘上路径可能出自 Windows 侧）──────────────────────────────
    const winRows: Row[] = [
      { id: 'w1', name: 'n', file_path: 'C:\\proj\\code\\a.md' },
      { id: 'w2', name: 'n', file_path: 'C:\\proj\\code\\d\\b.md' },
    ];
    const t8 = buildDeliverableTree(winRows);
    ok(JSON.stringify(t8.commonPrefix) === JSON.stringify(['C:', 'proj', 'code']) && t8.noPath.length === 0,
      'UI-8 **反斜杠同认**：`C:\\proj\\code\\…` 与正斜杠同样切段（`commonDirPrefix` 的 `[/\\\\]`）',
      `commonPrefix=${JSON.stringify(t8.commonPrefix)}`);
    ok(JSON.stringify(commonDirPrefix([])) === '[]',
      'UI-8b **空输入不失守**：`commonDirPrefix([])` 返回 `[]`（不是抛错、不是 `undefined`）',
      `commonDirPrefix([])=${JSON.stringify(commonDirPrefix([]))}`);

    // ── UI-9 渲染层**接线**（这三条的病根在 renderer，规则对了还得真接上）────────────────
    const page = stripComments(fs.readFileSync(
      path.join(root, A, 'renderer/src/pages/TaskDetailPage.tsx'), 'utf-8'));
    const iMem = page.indexOf('{memBlock}');
    const iAtts = page.indexOf('{attsBlock}');
    const iDelivs = page.indexOf('{delivsBlock}');
    ok(iMem > 0 && iAtts > iMem && iDelivs > iAtts,
      'UI-9 **渲染顺序 = 记忆注入 → 本次附件 → 产出物**（用户要的"记忆注入在产出物上面"；'
      + '把 M7 建立的"一进一出"整族留在产出物之前，而不是拆开）',
      `三个渲染落点的字符位置：mem=${iMem} atts=${iAtts} delivs=${iDelivs}`);
    ok(page.includes('const [showMem, setShowMem] = useState(false);')
      && page.includes('const [showEvents, setShowEvents] = useState(false);'),
      'UI-9b **默认折叠**：`showMem`/`showEvents` 初值都是 `false`（折叠态下报条数，见两处折叠头）',
      '两处 useState(false) 均在去注释面命中');
    const memSites = page.split('memoryInjection.map(').length - 1;
    ok(memSites === 1 && page.includes('buildDeliverableTree(delivs)'),
      'UI-9c **一个落点**：`memoryInjection.map(` 全页**恰 1 处**（上移不是复制——原处那份已删），'
      + '且产出物块真调 `buildDeliverableTree(delivs)`（不是把树函数引进来当摆设）',
      `memoryInjection 渲染点=${memSites} 处；buildDeliverableTree 调用=${page.includes('buildDeliverableTree(delivs)') ? '在场' : '**不在场**'}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S】build 钉（派生核对，不写轮次字面量；**不受批次门管辖**）');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

main().catch((e: unknown) => {
  console.error('\n💥 rr_zx_20260924 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260924: ${pass} 通过 / ${fail} 失败${pending ? ` / ${pending} 待实施(不计入)` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
});
