/**
 * zx_20260921 M2（亚里士多德·潜能与现实 / 维特根斯坦·意义即使用）: **把盘上的件变成模型真能看见的内容**。
 *
 * 病根（方案 §1 D2）：M1 已把"盘上哪一份"记进 `context_json.attachments`，但**没有人读它**——
 * 图片进上下文只是一行文字里的文件名，模型既不能看图也不能摘要 PDF。本模块就是那个读者：
 * 按族分派（图片内联 / PDF 抽正文 / 音频转写），**每件都给出一条如实的去向**。
 *
 * 三条**反直觉的**纪律，写在这里免得后人改错：
 *   ① **宁可说"办不到"，绝不拿乱码/空内容充数**。图片超限就降质、降不动就 `omitted` 并说明；
 *      PDF 抽不出正文（CID 字形无 ToUnicode / 加密 / 纯图形）就 `failed` 并说明真因 + **盘上路径**
 *      （用户仍可自行取件）。模型对"半截乱码"的反应是**编**，那比"读不了"糟得多。
 *   ② **判族看"内容"，扩展名只是兜底**（zx_20260930 M13-1 起）：入站 `kind` 是**数字**
 *      （`zx_20260914` M1-2 的刻意裁定，2026-09-21 复核维持），`familyOf('2')` 只能是 `binary`——
 *      这是**旧口径的落点**，故此前只能退而求其次读扩展名（落盘名带真扩展名，`saveInboundMedia`
 *      保 basename）。M13-1 把最后一层也补上了：**先嗅前 16 字节的魔数**（`sniffFileType`），
 *      与扩展名冲突时**用魔数、并把冲突写进这件自己的 marker**（「不静默改用扩展名」）；
 *      嗅不出才落回扩展名——承 `zx_20260911_1`「判型由产物本身定」。
 *   ③ **marker 里那句话，不许把"做了一半"说成"做到了"**：视频的 `note` **永远在场**
 *      （未接抽帧器 / 无 vision / 抽帧失败 / 一帧未得 / 抽到了几帧、覆盖多长，各有各的措辞，
 *      见视频支），音频的 `truncated` 由转写器带出——宁可承认覆盖不全，也不让模型以为它看过全片。
 *
 * ⚠ **本模块静态零 electron 依赖**：图片降质要用的 `nativeImage` 走**动态** `import('electron')`
 *   （只在真的要降质那一支、且只执行一次路径）⇒ 受控回归直接 `import` 本模块即可跑真实现，
 *   注入自己的 `io` 桩后**根本不会碰到 electron**。承 `memory-manager.ts` 的既有手法（运行时依赖极轻）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ImagePart, TextPart } from 'ai';
import { familyOf, maxBytesOf, sniffFileType, SNIFF_HEAD_BYTES, type AttachmentFamily } from './attachment-kinds.js';
// zx_20261003 M3: 读盘头部**唯一实现**（本模块与选型层 `exec-model-select.ts` 共用）——
//   判族的嗅探口必须两侧读同一种字节，否则同一件东西在选型期与装配期会得出不同的族（M3 病根）。
import { readHeadFromFile } from './file-head.js';
import { IMAGE_PREVIEW_MIME } from './deliverable-types.js';
import { extractPdfText, PDF_MAX_PAGES, type PdfTextResult } from './pdf-text.js';
import { extractDocText, isDocTextExt, DOC_MAX_CHARS, type DocTextResult } from './doc-text.js';
// zx_20260930 M13-4: **只引类型**——`video-frames.ts` 运行时要拖进 `audio-transcribe.ts`
//   （进而拖进 `ans-client` / `model-request.ts`）。本模块被 ~10 个 rr 直接 import，
//   平白给它加一条运行边，等于让那些脚本每次多加载一整张模块图。类型引在编译后**不存在**。
import type { VideoFramesResult } from './video-frames.js';
// zx_20260924 M7: 三态字面量与中文文案的**唯一真源**——renderer 引不动本模块（见文件头 ⚠），
//   故那边引 `attachment-outcome.ts`，这里只引类型，两侧不得各写一份。
import type { AttachmentOutcomeStatus } from './attachment-outcome.js';

/**
 * 一件附件的**去向**。`inlined` = 内容真进了上下文；`omitted` = 本就不打算内联（超限/此路不通）；
 * `failed` = 打算内联但没成（读不了/抽不出）。**三者都必须能说出为什么**——
 * "有一件没进去"这件事本身要看得见，否则就是本轮的病根换了个地方复发。
 */
export interface AttachmentOutcome {
  path: string;
  family: AttachmentFamily;
  status: AttachmentOutcomeStatus;
  reason?: string;
  bytes?: number;
  fileName?: string;
  /**
   * 这件附件**给模型看的那句话**（与 `parts` 里那条 marker 文本**同一份字面量**）。
   *
   * 带出来是为了让落库方（`persistTurnMessage`）能写"图片以 `[已内联图片 <件名>]` 占位"时
   * **引用而非重抄**——抄一份措辞就有了第二个真源，改一处忘另一处（G8/G9 的老病）。
   */
  marker: string;
}

export interface DownscaledImage { data: Buffer; mimeType: string }

/** 可注入的桩口——**rr 分双态全靠它**（判据不许依赖"本机恰好有 electron / ffmpeg"）。 */
export interface InlineIo {
  readFile: (p: string) => Buffer;
  /**
   * 盘上字节数（zx_20260929 M3「有界读盘」）。**可选**：缺省或抛/取不到 ⇒ `null`
   * ⇒ 退回"先读后判"，行为与旧实现一致（`rr_zx_20260921` 的 C8/C9 正是"盘上是 68 字节的小 PNG、
   * 注入的却是 10MB+1 的字节"——盘上尺寸**故意**与注入字节不一致，那里只能靠读后那道闸）。
   */
  statSize?: (p: string) => number | null;
  /** 图片降质（零新增依赖：走 electron `nativeImage`）。返回 `null` = 降不动。 */
  downscaleImage: (p: string, maxBytes: number) => Promise<DownscaledImage | null>;
  /** PDF 抽正文（M3）。 */
  extractPdf: (buf: Buffer) => PdfTextResult;
  /** 文档族其余格式抽正文（zx_20260924 M1：txt/md/json/csv/docx）。缺省 ⇒ 文档支走原 `not_yet_supported`。 */
  extractDoc?: (buf: Buffer, ext: string) => DocTextResult;
  /** 音频转写（M4）。缺省 ⇒ 音频族一律 `omitted('transcriber_unavailable')`，**不假装能转**。 */
  transcribeAudio?: (p: string) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  /**
   * 读**头部若干字节**用于魔数嗅探（zx_20260930 M13-1）。**可选**：缺省或抛/取不到 ⇒ `null`
   * ⇒ 退回"只看扩展名"的旧判族（`rr_zx_20260921` 的 C7/C8/C9 夹具都没有这一项，它们证的就是那条退路）。
   *
   * ⚠ 读的是**盘上真的前 N 字节**（与 `statSize` 同一路数）：注入的 `readFile` 与盘上内容可以
   *   不是同一个东西（C8/C9 正是"盘上是 68 字节小 PNG、注入 10MB+1 字节"），嗅探不替它们做主。
   */
  readHead?: (p: string, n: number) => Uint8Array | null;
  /**
   * 视频抽帧（zx_20260930 M13-4）。**可选**：缺省 ⇒ 视频支只转写音轨、画面一律如实说"未处理"
   *   （`rr_zx_20260924` M2-3/M2-4 的夹具正是这个形态，见那里的登记语）。
   */
  extractFrames?: (p: string) => Promise<VideoFramesResult>;
}

/**
 * zx_20260930 M10: 装配层的**外部裁定**。此前本函数对"模型能不能看见它"一无所知，
 * 于是图片**无条件** push 成 `image` part——非视觉模型收到 `image_url`，要么 400，要么白烧 token。
 */
export interface BuildAttachmentPartsOptions {
  /**
   * 本轮**实际在用**的模型自陈具备的能力清单（`exec-model-select` 由 `compareModelCapabilities`
   * 回验得到；`undefined` = 回包没带清单）。
   *
   * 清单在场且**不含 `vision`** ⇒ 图片族一律不送进模型，逐件记 `omitted(model_lacks_vision)`。
   * ⚠ 清单**缺席**时**不设闸**：那是"无从比对"，不是"不具备"——替它断言一句我们并不知道的话，
   *   与本模块"宁可说办不到、绝不拿乱码充数"是同一条尺的反面（那条是**有话要说清**，这条是**没话别编**）。
   */
  modelCapabilities?: readonly string[];
}

/** 逐条说明文本的**预算**：最多 5 条，溢出合并——防附件多到把上下文预算吃光（参考 openclaw `media-attachment-outcomes.ts`）。 */
export const INLINE_MARKER_BUDGET = 5;

/** 降质阶梯（参考 openclaw `image-ops.ts` 的质量阶梯）：**先缩尺寸、再降质量**，命中即停。 */
const DOWNSCALE_SCALES = [1, 0.6, 0.35] as const;
const DOWNSCALE_QUALITIES = [75, 55, 35] as const;

/**
 * 生产缺省的图片降质：`nativeImage` 动态 import（见文件头第 ⚠ 条）。
 *
 * 失败一律返回 `null`（**不抛**）：降不了质是**降级**，不该把整条上下文装配搞挂——
 * 调用方据此记 `omitted` 并如实说明，用户仍能拿到盘上原件。
 */
async function electronDownscale(p: string, maxBytes: number): Promise<DownscaledImage | null> {
  try {
    const { nativeImage } = await import('electron');
    const img = nativeImage.createFromPath(p);
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    if (!width || !height) return null;
    for (const scale of DOWNSCALE_SCALES) {
      const resized = scale === 1 ? img : img.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: 'good',
      });
      for (const q of DOWNSCALE_QUALITIES) {
        const data = resized.toJPEG(q);
        if (data.length > 0 && data.length <= maxBytes) return { data, mimeType: 'image/jpeg' };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function defaultIo(): InlineIo {
  return {
    readFile: (p) => fs.readFileSync(p),
    statSize: (p) => {
      try { return fs.statSync(p).size; } catch { return null; }
    },
    downscaleImage: electronDownscale,
    extractPdf: (buf) => extractPdfText(buf),
    extractDoc: (buf, ext) => extractDocText(buf, ext),
    // zx_20261003 M3: 改引 `readHeadFromFile`（纯搬移）——「读前 N 字节」不再是本模块私产，
    //   而与选型层共用同一实现（理由见 `file-head.ts` 头注释）。行为与本文件旧内联版逐字一致。
    readHead: readHeadFromFile,
  };
}

/**
 * 把 `context_json.attachments` 里的件装配成模型能吃的 parts。
 *
 * **永不抛**：任何一件出问题都只影响它自己的 `outcome`。装配期抛一次，整条上下文就没有了——
 * 那是"因为一张图读不了，任务连话都不说了"，代价与收益完全不成比例。
 */
export async function buildAttachmentParts(
  items: ReadonlyArray<unknown>,
  io?: Partial<InlineIo>,
  opts?: BuildAttachmentPartsOptions,
): Promise<{ parts: Array<TextPart | ImagePart>; outcomes: AttachmentOutcome[] }> {
  const eff: InlineIo = { ...defaultIo(), ...io };
  const caps = opts?.modelCapabilities;
  /**
   * zx_20260930 M10: 视觉闸。清单**在场且不含 `vision`** ⇒ 图片族一律不送进模型；
   * 清单**缺席** ⇒ **不设闸**（见 `BuildAttachmentPartsOptions`）。
   */
  const visionOk = !caps || caps.includes('vision');
  const parts: Array<TextPart | ImagePart> = [];
  const outcomes: AttachmentOutcome[] = [];
  const markers: string[] = [];
  /** M10：因模型不具备 `vision` 而未送进模型的图片件数（供循环结束后补一句总数）。 */
  let noVisionSkipped = 0;

  for (const raw of items) {
    const item = (raw ?? {}) as { path?: unknown; fileName?: unknown; kind?: unknown };
    const p = typeof item.path === 'string' ? item.path : '';
    if (!p) continue;
    const fileName = typeof item.fileName === 'string' && item.fileName ? item.fileName : path.basename(p);
    const ext = path.extname(p).toLowerCase();
    const declared = familyOf(ext || String(item.kind ?? ''));

    /**
     * zx_20260930 M13-1: **魔数优先**。判族由"纯扩展名"升级为"看一眼前 16 字节"。
     *   · 嗅得出且**与扩展名一致** ⇒ 什么都不说（`conflict` 留空，见下）。
     *   · 嗅得出且**不一致** ⇒ 族改用魔数那一侧，并把冲突写进**这一件自己的** marker。
     *     ⚠ 「**不静默改用扩展名**」是方案原文：悄悄改掉，用户就永远不知道自己的文件被误认过。
     *   · 嗅不出（`null`） ⇒ 原扩展名判出的族照旧（这是**退路**，不是失败）。
     * 位置刻意在 `visionOk` 闸**之前**：一件名叫 `.txt` 的 PNG 必须先被认出是图片，
     *   才谈得上"本轮模型有没有 vision"（rr M-f-8 钉的就是这个先后）。
     */
    const sniffed = sniffFileType(eff.readHead ? eff.readHead(p, SNIFF_HEAD_BYTES) : null);
    const family = sniffed && sniffed.family !== declared ? sniffed.family : declared;
    /** 族/名不一致时那句可说的话。**只在换族时非空**——一致时说一句"它们一样"纯属噪音。 */
    const conflict = family !== declared
      ? `；按内容判为 ${family}，与扩展名「${ext || '(无)'}」不符`
      : '';
    // 魔数只在**换族**时接管扩展名：`.docx` 的魔数是 ZIP，但族同为 `document`（⇒ 不换），
    //   若无条件改成 `.docx`，真 `.pdf`/真 `.doc` 的精确扩展名就会被抹掉。
    const effExt = sniffed && conflict ? (sniffed.ext ?? ext) : ext;

    const done = (o: Omit<AttachmentOutcome, 'marker'>, marker: string): void => {
      // 冲突话折进**这一件自己的** marker：逐件 marker 与 `parts` 里那条是同源字面量（见接口注），
      //   在这里统一拼，就不必在十几个 `done(...)` 调用点各写一遍（G8/G9 老病：同一句话的多处副本）。
      const m = conflict ? `${marker}${conflict}` : marker;
      outcomes.push({ ...o, marker: m });
      markers.push(m);
    };

    const max = maxBytesOf(family);
    /**
     * 超限的**唯一一处处置**（两条来路共用：① 盘上尺寸先判 ② 读后长度兜底）：
     *   只有图片有降质手段；其余族超限就是超限（**不截断文件冒充完整**）。
     *
     * zx_20261003 M2-②：两条出路的 marker 都补"怎么办"——只说"没进来"是**半句话**，
     *   用户拿不到下一条路（参照 CoPaw 超限落盘提示：告知去向 + 可执行的替代动作）。
     */
    const overLimit = async (n: number): Promise<void> => {
      if (family !== 'image') {
        done({ path: p, fileName, family, status: 'omitted', reason: 'over_limit', bytes: n },
          `[未内联附件 ${fileName}：${n} 字节超过 ${max} 字节上限；可压缩或切成多段后重发]`);
        return;
      }
      const small = await eff.downscaleImage(p, max);
      if (!small) {
        done({ path: p, fileName, family, status: 'omitted', reason: 'over_limit_no_downscale', bytes: n },
          `[未内联图片 ${fileName}：${n} 字节超过上限且无法降质，原件在 ${p}；可先缩小尺寸后重发]`);
        return;
      }
      parts.push({ type: 'image', image: small.data, mimeType: small.mimeType });
      done({ path: p, fileName, family, status: 'inlined', bytes: small.data.length },
        `[已内联图片 ${fileName}（已降质，原件 ${n} 字节）]`);
    };

    // zx_20260930 M10: 模型不具备 `vision` ⇒ 图片**不送进模型**。
    //   位置刻意在**读盘之前**：不送进去的东西不必读、更不必降质（省一次整读），故它先于下面两道尺寸闸。
    //   `bytes` **不给**——没读过，就不许说它多大（"能说出为什么"不等于"能编一个数"）。
    //   与图族另外两条出路（超限未内联、非光栅）**同形**：都是 `omitted` + `reason` + 一句给模型看的话。
    if (family === 'image' && !visionOk) {
      noVisionSkipped++;
      done({ path: p, fileName, family, status: 'omitted', reason: 'model_lacks_vision' },
        `[未送图片 ${fileName}：本轮模型不具备 vision 能力；原件在 ${p}]`);
      continue;
    }

    // zx_20260929 M3 有界读盘：**先按盘上尺寸判超限、再决定要不要整读**（上限口径取既有
    //   `FAMILY_MAX_BYTES`，**不新造常量**）。旧序是"整读进内存再看长度"——一件 100MB+1 的视频
    //   要先吃满 100MB 才被判超限。`statSize` 取不到 ⇒ `null` ⇒ 直落下面"读后判"那道闸
    //   （`rr_zx_20260921` C8/C9 是"盘上 68 字节 + 注入 10MB+1 字节"的标本，**只有**读后那道闸抓得住）。
    //   读后那道闸**刻意不删**：盘上尺寸与真正读到的字节可以不是同一个东西（注入、竞态）。
    const sizeOnDisk = eff.statSize ? eff.statSize(p) : null;
    if (max > 0 && sizeOnDisk !== null && sizeOnDisk > max) {
      await overLimit(sizeOnDisk);
      continue;
    }

    let buf: Buffer | null = null;
    try {
      buf = eff.readFile(p);
    } catch (e) {
      done({ path: p, fileName, family, status: 'failed', reason: `read_failed: ${e instanceof Error ? e.message : String(e)}` },
        `[未能读取附件 ${fileName}：文件不在或不可读]`);
      continue;
    }

    if (max > 0 && buf.length > max) {
      await overLimit(buf.length);
      continue;
    }

    if (family === 'image') {
      const mime = IMAGE_PREVIEW_MIME[effExt] ?? '';
      // 矢量图（`.svg`）不给模型当图片看——视觉接口收的是光栅图，喂进去只会要一个 400。
      if (!mime.startsWith('image/') || mime === 'image/svg+xml') {
        done({ path: p, fileName, family, status: 'omitted', reason: `not_raster_image(${effExt || 'no_ext'})` },
          `[未内联图片 ${fileName}：非光栅格式，模型看不了；原件在 ${p}]`);
        continue;
      }
      parts.push({ type: 'image', image: buf, mimeType: mime });
      done({ path: p, fileName, family, status: 'inlined', bytes: buf.length }, `[已内联图片 ${fileName}]`);
      continue;
    }

    if (family === 'document' && effExt === '.pdf') {
      const r = eff.extractPdf(buf);
      if (r.ok) {
        const shown = Math.min(r.pages, PDF_MAX_PAGES);
        const head = r.truncated
          ? `[附件 ${fileName} 第 1-${shown} 页（共 ${r.pages} 页，已截断）]`
          : `[附件 ${fileName} 第 1-${r.pages} 页]`;
        parts.push({ type: 'text', text: `${head}\n${r.text}` });
        done({ path: p, fileName, family, status: 'inlined', bytes: buf.length }, `[已内联 PDF ${fileName} 正文 ${r.text.length} 字]`);
      } else {
        // 抽不出**不是**失败得说不清的事：真因 + 盘上路径一起给，用户仍可自行取件。
        // `detail` **不许丢**：`cid_unsupported` 只说得清"没抽出来"，说不清"为什么"
        //   （"可读字符占比 1.7% < 60%"才是用户拿去判断"这份 PDF 还能不能救"的那句话）。
        //   与音频支同形（`makeAudioTranscriber` 也是 `${r.reason}: ${r.detail}`）——同一轮里两条支路一个写法。
        const why = r.detail ? `${r.reason}：${r.detail}` : r.reason;
        done({ path: p, fileName, family, status: 'failed', reason: why, bytes: buf.length },
          `[未能读取 PDF ${fileName} 正文（${why}）；原件在 ${p}]`);
      }
      continue;
    }

    // zx_20260924 M1：文档族的**其余格式**（txt/md/json/csv/docx）。此前这些一律落到本函数末尾的
    //   `not_yet_supported`——用户发进来的报告/笔记模型只看得见文件名。**`.doc` 也走这支**：
    //   它由 `doc-text.ts` 如实判 `doc_legacy_unsupported`（不是"没认出来"，是"认得但本轮不解析"），
    //   两者在 marker 里措辞不同，用户据此知道该转存还是该换格式。
    if (family === 'document' && eff.extractDoc && isDocTextExt(effExt)) {
      const r = eff.extractDoc(buf, effExt);
      if (r.ok) {
        const head = r.truncated
          ? `[附件 ${fileName} 正文（已截断至 ${DOC_MAX_CHARS} 字）]`
          : `[附件 ${fileName} 正文]`;
        parts.push({ type: 'text', text: `${head}\n${r.text}` });
        done({ path: p, fileName, family, status: 'inlined', bytes: buf.length },
          `[已内联文档 ${fileName} 正文 ${r.text.length} 字${r.truncated ? '（已截断）' : ''}]`);
      } else {
        // 与 PDF 支、音频支**同形**：真因 + `detail` 一起给、盘上路径一起给（同一轮里三条支路一个写法）。
        const why = r.detail ? `${r.reason}：${r.detail}` : r.reason;
        done({ path: p, fileName, family, status: 'failed', reason: why, bytes: buf.length },
          `[未能读取文档 ${fileName} 正文（${why}）；原件在 ${p}]`);
      }
      continue;
    }

    if (family === 'audio') {
      if (!eff.transcribeAudio) {
        done({ path: p, fileName, family, status: 'omitted', reason: 'transcriber_unavailable', bytes: buf.length },
          `[未内联音频 ${fileName}：本机无法转写；原件在 ${p}]`);
        continue;
      }
      let tr: { ok: true; text: string } | { ok: false; reason: string };
      try {
        tr = await eff.transcribeAudio(p);
      } catch (e) {
        tr = { ok: false, reason: `transcribe_threw: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (tr.ok) {
        parts.push({ type: 'text', text: `[附件 ${fileName} 音频转写]\n${tr.text}` });
        done({ path: p, fileName, family, status: 'inlined', bytes: buf.length }, `[已内联音频转写 ${fileName} ${tr.text.length} 字]`);
      } else {
        done({ path: p, fileName, family, status: 'failed', reason: tr.reason, bytes: buf.length },
          `[未能转写音频 ${fileName}（${tr.reason}）；原件在 ${p}]`);
      }
      continue;
    }

    // zx_20260924 M2：视频族的**音轨那一半**——`normalizeToWav` 对容器不可知（它把输入交给 ffmpeg 拆），
    //   所以这里与音频支**同一把转写器**（`eff.transcribeAudio`，`agent-executor.ts` 注入的 `makeAudioTranscriber`）。
    // zx_20260930 M13-4：再补**画面那一半**（抽帧）。两半**各自如实**——`note` 这句永远在场，
    //   说不清"画面到没到"就等于把"只听了声音"说成"看过视频"（`zx_20260920_1`「用了才算数」同族）。
    if (family === 'video') {
      if (!eff.transcribeAudio) {
        done({ path: p, fileName, family, status: 'omitted', reason: 'transcriber_unavailable', bytes: buf.length },
          `[未内联视频 ${fileName}：本机无法转写音轨；原件在 ${p}]`);
        continue;
      }
      let tr: { ok: true; text: string } | { ok: false; reason: string };
      try {
        tr = await eff.transcribeAudio(p);
      } catch (e) {
        tr = { ok: false, reason: `transcribe_threw: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (!tr.ok) {
        // 抽帧只挂在**转写成功**那一支（见下），故这里必然没有画面 ⇒ 一并说清，不留半句。
        done({ path: p, fileName, family, status: 'failed', reason: tr.reason, bytes: buf.length },
          `[未能转写视频 ${fileName} 的音轨（${tr.reason}）；画面未处理；原件在 ${p}]`);
        continue;
      }
      /** 给模型看的"画面怎么了"。**四种取值**覆盖抽帧的每一处断点，一种都不许静默。 */
      let note = '画面未处理';
      /**
       * zx_20261003 M2（海德格尔·遮蔽即失真）：**显式降级留痕**。
       *
       * 无 vision 时画面进不去，但**音轨那半是真内联的** ⇒ `status` 仍是 `inlined`——
       * 改成 `omitted`/`failed` 都是**新的**失实（把进了音轨的视频说成"没进去"），且方案明令
       * 「**不得**把'无 vision'变成硬失败（任务照跑）」。故降级由 `reason` 承载：它随 `outcomes`
       * 落库、在「本次附件」显示为「原因：…」——此前 `done(...)` 恒记 `inlined` 且无 `reason`，
       * "画面没送进去"这件事**被遮蔽成完全成功**。
       */
      let degradedReason: string | undefined;
      const frameParts: ImagePart[] = [];
      if (!visionOk) {
        // ① 模型没有 vision ⇒ **连抽都不抽**。抽了也送不进去，白烧一次 ffmpeg 与 8 张图的尺寸
        //    （方案 §2-M13-4 原文：「依赖 M10 的按能力配图，否则等于给非视觉模型塞图」）。
        //    M2-② 补"怎么办"：用户只知"画面没来"没有用，得知道**下一条路**在哪。
        note = '画面未处理（本轮模型不具备 vision 能力，未抽帧；如需看画面，可改用具备 vision 的模型后重发）';
        degradedReason = 'model_lacks_vision_frames';
      } else if (!eff.extractFrames) {
        // ② 装配层没接抽帧器 ⇒ 说"本机没接"，**不是**"抽不到帧"（两件事的处置不同，混成一句就是失实）。
        note = '画面未处理（本机未接抽帧器）';
      } else {
        let fr: VideoFramesResult | null = null;
        try {
          fr = await eff.extractFrames(p);
        } catch (e) {
          fr = { ok: false, reason: `frames_threw: ${e instanceof Error ? e.message : String(e)}` };
        }
        if (!fr.ok) {
          // ③ 抽帧真失败 ⇒ 真因原样带出，**音轨那半照旧内联**（丢的是画面，不是整件）。
          note = `画面未处理（抽帧失败：${fr.reason}）`;
        } else {
          for (const f of fr.frames) {
            const fm = IMAGE_PREVIEW_MIME[path.extname(f.path).toLowerCase()] ?? '';
            // 认不出格式的帧不硬塞（与图片支 `not_raster_image` 同一口径：MIME 不在真源表里就不送）。
            if (!fm.startsWith('image/')) continue;
            try {
              frameParts.push({ type: 'image', image: eff.readFile(f.path), mimeType: fm });
            } catch { /* 单帧读不了只丢这一帧：整件仍以音轨 + 其余帧如实交付 */ }
          }
          const win = `前 ${fr.windowSeconds} 秒内每 ${fr.intervalSeconds} 秒 1 帧`;
          if (frameParts.length > 0) {
            // M2-②："窗口之外没看过"是**必须**说的（`zx_20260930` M13-4 文件头原文），且补"怎么办"——
            //   覆盖窗口是固定的（帧数 × 间隔），长片其后段画面永远抽不到，用户得知道可以切段重发。
            note = `画面已抽 ${frameParts.length} 帧（${win}${fr.dropped ? `；另 ${fr.dropped} 帧超过图片上限未送` : ''}；`
              + `若视频长于该窗口，其后段画面本轮未覆盖，可切段后重发）`;
          } else if (fr.dropped > 0) {
            note = `画面未处理（抽到 ${fr.dropped} 帧但均超过图片上限）`;
          } else {
            // ④ 抽帧成功却一帧没有：**源里没有可解码的画面**（纯音频流/坏容器/空文件）。
            note = '画面未处理（未抽到帧）';
          }
        }
      }
      parts.push({ type: 'text', text: `[附件 ${fileName} 音轨转写；${note}]\n${tr.text}` });
      // 帧排在转写之后：模型先读"这是什么"，再看图。且**只在真有帧时**才 push（空数组不产生空 part）。
      if (frameParts.length > 0) parts.push(...frameParts);
      done({ path: p, fileName, family, status: 'inlined', ...(degradedReason ? { reason: degradedReason } : {}), bytes: buf.length },
        `[已内联视频 ${fileName} 的音轨转写 ${tr.text.length} 字；${note}]`);
      continue;
    }

    // 二进制 / 未认出的文档格式：本轮不内联。**理由写进说明**，不留一个沉默的洞。
    //   zx_20261003 M2-②：补"怎么办"——"不支持"三个字对用户没有出口，得给一条能走的替代路。
    done({ path: p, fileName, family, status: 'omitted', reason: `not_yet_supported(${family}${effExt ? ` ${effExt}` : ''})`, bytes: buf.length },
      `[未内联附件 ${fileName}（${family}${effExt ? ` ${effExt}` : ''}）：本轮不支持，原件在 ${p}；可转成文本或图片后重发]`);
  }

  // zx_20260930 M10: 「已跳过 N 张」的**一句总数**。逐件 marker 说得清"哪一张、为什么"，但件数多到
  //   被 `INLINE_MARKER_BUDGET` 截断时，剩下的只有"[另有 M 件附件未逐条列出]"——那句话把
  //   "因为模型看不到"与"因为超限/读不了"混成一件。故在**首位**补一句总数：预算先切的正是首位，
  //   它必不会被截掉。
  if (noVisionSkipped > 0) {
    markers.unshift(`[本轮模型不具备 vision 能力：${noVisionSkipped} 张图片未送进模型]`);
  }

  if (markers.length > 0) {
    const shown = markers.slice(0, INLINE_MARKER_BUDGET);
    if (markers.length > INLINE_MARKER_BUDGET) shown.push(`[另有 ${markers.length - INLINE_MARKER_BUDGET} 件附件未逐条列出]`);
    parts.push({ type: 'text', text: shown.join('\n') });
  }

  return { parts, outcomes };
}
