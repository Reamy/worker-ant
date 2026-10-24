/**
 * zx_20260921 M5（维特根斯坦·不要拿"我说了"当"我做了"）: 附件**按需读**的两个工具。
 *
 * M2 只解决"**开局**把入站附件内联进上下文"；任务跑到一半遇到盘上的图/PDF（自己产出的、
 * 或路径来自上下文而非附件的）时，模型没有任何手段看一眼。本模块补的就是这一截。
 *
 * ⚠ **方案 §M5 点名的"待坐实"已坐实，结论是"不通"**（2026-09-21）：
 *   原设想是 `view_image` 返回 **AI SDK v4 的图片型 tool result**
 *   （`{type:'image', data, mimeType}`，`ai@4.3.19` 的 `ToolResultContent` 确实支持，见 `ai/dist/index.d.ts:543-550`）。
 *   但**工具结果回灌到模型**这最后一跳走的是 `@ai-sdk/openai@1.3.24` 的
 *   `convertToOpenAIChatMessages`——它对 `role:'tool'` 只做一件事：
 *   `messages.push({ role:'tool', tool_call_id, content: JSON.stringify(toolResponse.result) })`，
 *   **`toolResponse.content`（图片 part 就挂在这里）整个不用**。responses 路同形
 *   （`function_call_output.output = JSON.stringify(part.result)`）。而本仓模型一律经
 *   `createSafeProvider`（`core/ai-provider.ts`）走 OpenAI 兼容 chat/completions（`provider(model_name)`
 *   ⇒ `OpenAIChatLanguageModel`）。
 *   ⇒ 真跑（rr C20-C23 / `M5-4`）实测的**精确形状**是：图片 part **不是"被静默丢弃"**，
 *   而是**退化成一段 JSON 文本**——`role:'tool'` 的 `content` 里出现 `{type:'image',data:'<base64>'…}`
 *   这个**对象经 JSON 序列化后的字符串**，请求体中**没有** `image_url` part。模型收到一坨 base64
 *   字符：**看不见图，还白烧 token**。（"丢弃"是读文档时的猜测，"退化"才是实测的结论——
 *   两者的退路相同，但如实登记须用后者。）
 *   ⇒ 按方案预置的退路**退为"工具返回文字式提示"**。判据（rr C20-C23）跑的是**真** AI SDK 工具循环
 *   （真 `generateText` + 真 `createSafeProvider`，只把 `fetch` 换成桩）——不是读文档得出的结论。
 *
 * **退路之下仍要如实**：既然像素到不了模型，`view_image` 就**不许**装作送到了。它给出
 * ① 真从盘上读得出的**元数据**（格式/字节数/尺寸），② 一句**说得出为什么**的话，③ **可行动作**
 * （把它作为附件重发，走 M2 的开局内联那条真能送达的路）。**"看不了"要说成"看不了"**，
 * 让模型据此改道，而不是让它以为图已经在眼前、进而凭空编造图里的内容。
 *
 * zx_20261018_2 批一（见）：**像素仍不进主模型的上下文**，但换了一条真到得了像素的路——
 *   由 `image-describe.ts` 向 ANS 要一个 `vision` 模型，把降质后的图作为 user message 的
 *   image part 发过去，再把**文字观察**交回主模型。故工具结果新增 `described` / `observation`：
 *   `observation` 是**二手观察**（视觉模型说的），不是主模型的亲眼所见——标记与免责句必须同场。
 *   该子调用属 Pro 能力（`image_vision`）：社区档仍拿到元数据，只是 `described:false` + 如实拒因。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { jsonSchema } from 'ai';
import type { ToolDeps } from './deps.js';
import { familyOf, maxBytesOf, TEXT_EXTS } from '../attachment-kinds.js';
import { IMAGE_PREVIEW_MIME } from '../deliverable-types.js';
import { extractPdfText, PDF_MAX_PAGES, PDF_WINDOW_MAX_PAGES } from '../pdf-text.js';
import { extractDocText, isDocTextExt, DOC_MAX_CHARS } from '../doc-text.js';
// zx_20260929 M3（J-1）：只读围栏与 `read_file` **同一把尺**（`..` 遍历 / 敏感路径硬拒）。
//   走**零依赖**的 `path-fence.ts`——`sandbox.ts` 引 `logger.ts`（pino 在模块加载时起 transport
//   与日志目录），而本模块被 17 个 rr 受控回归经 `core/tools/*` 引入，不该平白拖进 pino。
import { readPathGuard } from '../path-fence.js';
// zx_20261018_2 批一：视觉子调用的**档位闸**只此一处（`pro-gate.ts`），本工具不另写档位判断。
import { proFeatureRefusal } from '../pro-gate.js';

/**
 * 图片尺寸：走 **electron `nativeImage` 的动态 import**（与 `attachment-inline.ts` 同一手法）。
 * 取不到（非光栅/矢量/无 electron/读不了）一律 `null`——**降级不是失败**，调用方据此少说一句尺寸，
 * 不许因此把整件说成"读不了"。
 */
async function imageSize(p: string): Promise<{ width: number; height: number } | null> {
  try {
    const { nativeImage } = await import('electron');
    const img = nativeImage.createFromPath(p);
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    return width && height ? { width, height } : null;
  } catch {
    return null;
  }
}

export function mediaTools(deps: ToolDeps) {
  const { workingDir } = deps;

  return {
    view_image: {
      description:
        '查看一张**盘上的**图片：返回格式、字节数与像素尺寸；并在可用时**请一个视觉模型看图**，'
        + '把它的**文字观察**带回来（`observation` 字段）。'
        + '⚠ 那是**二手观察**（视觉模型说的），不是你自己亲眼所见；有疑问时请以元数据与用户确认为准。'
        + '⚠ 视觉子调用是专业版能力；未启用时只返回元数据并如实说明。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: { filePath: { type: 'string', description: '图片路径（相对 working_dir 或绝对）' } },
        required: ['filePath'],
      }),
      execute: async (args: { filePath: string }) => {
        // zx_20260929 M3（J-1）：只读围栏（`..` / 敏感路径硬拒）——与 `read_file` 同一把尺。
        const g = readPathGuard(args.filePath, workingDir);
        if (!g.ok) return JSON.stringify({ error: g.error });
        const fp = g.resolved;
        // zx_20260929 M3 有界读盘：**先 `stat` 判上限、再整读**（上限口径取既有 `FAMILY_MAX_BYTES`，
        //   不新造常量）。旧序是"整读进内存再看长度"——11MB 的图要先吃满 11MB 才被判超限。
        //   `stat` 失败（不存在/不可读）与旧 `readFile` 失败**同一句回话**（判据 C20b③ 钉的就是它）。
        let st: Awaited<ReturnType<typeof fsp.stat>>;
        try {
          st = await fsp.stat(fp);
        } catch (e) {
          return JSON.stringify({ error: `图片不存在或不可读: ${fp}（${e instanceof Error ? e.message : String(e)}）` });
        }
        const bytes0 = st.size;
        const ext = path.extname(fp).toLowerCase();
        const mime = IMAGE_PREVIEW_MIME[ext] ?? '';
        const family = familyOf(ext);
        if (family !== 'image' || !mime.startsWith('image/') || mime === 'image/svg+xml') {
          return JSON.stringify({
            path: fp, bytes: bytes0, family, mimeType: mime || null,
            error: `不是可查看的位图（${ext || '无扩展名'}）：模型只能看图，矢量图/非图文件看不了。文本类文件请用 read_file，PDF/Word 文档请用 read_document。`,
          });
        }
        const max = maxBytesOf(family);
        if (max > 0 && bytes0 > max) {
          return JSON.stringify({
            path: fp, bytes: bytes0, mimeType: mime,
            error: `图片 ${bytes0} 字节超过 ${max} 字节上限。`,
          });
        }
        let bytes: Buffer;
        try {
          bytes = await fs.promises.readFile(fp);
        } catch (e) {
          return JSON.stringify({ error: `图片不存在或不可读: ${fp}（${e instanceof Error ? e.message : String(e)}）` });
        }
        const size = await imageSize(fp);
        const meta = {
          path: fp,
          bytes: bytes.length,
          mimeType: mime,
          width: size?.width ?? null,
          height: size?.height ?? null,
        };

        // zx_20261018_2 批一：像素进不了**主模型**的上下文（见文件头实测结论），
        //   但可以让**视觉模型**看，再把文字观察带回来。两件事分开说：
        //   `delivered` 说的是"像素有没有进你（主模型）的上下文"——永远是 false；
        //   `described` 说的是"有没有人替你看了这张图"。
        const refusal = proFeatureRefusal(deps.db, 'image_vision');
        if (refusal) {
          return JSON.stringify({
            ...meta,
            delivered: false,
            described: false,
            visionNote: refusal,
            note: '像素内容**未送达模型**（本托管方为 OpenAI 兼容 chat/completions，工具结果只传文本）。'
              + '若确需看见它，可使用专业版的图片内容理解，或用 ask_user 请用户把这张图作为附件重发；'
              + '否则请只依据上面的元数据，不要凭文件名臆测图像内容。',
          });
        }
        if (!deps.describeImage) {
          return JSON.stringify({
            ...meta,
            delivered: false,
            described: false,
            visionNote: '视觉子调用不可用（本运行未注入 describer）',
            note: '像素内容**未送达模型**（本托管方为 OpenAI 兼容 chat/completions，工具结果只传文本）。'
              + '若确需看见它，请用 ask_user 请用户把这张图作为附件重发；否则请只依据上面的元数据，不要凭文件名臆测图像内容。',
          });
        }
        const desc = await deps.describeImage(fp);
        if (!desc.ok) {
          return JSON.stringify({
            ...meta,
            delivered: false,
            described: false,
            visionNote: `视觉子调用未成功（${desc.reason}）：${desc.detail}`,
            note: '像素内容**未送达模型**，且视觉子调用未成功——请依据上面的元数据，不要凭文件名臆测图像内容。'
              + '若确需看见它，请用 ask_user 请用户把这张图作为附件重发。',
          });
        }
        return JSON.stringify({
          ...meta,
          delivered: false,
          described: true,
          model: desc.model,
          observation: `<image-observation>\n${desc.text}\n</image-observation>`,
          note: '以上 observation 来自**视觉模型的二手观察**，不是原件像素、也不是你的亲眼所见；'
            + '涉及关键细节时请核对元数据或向用户确认，不要把它当成逐像素事实继续推断。',
        });
      },
    },

    read_document: {
      // zx_20260930 M12：认下的扩展名清单**由真源派生**（`TEXT_EXTS`）——手列一份就会与
      //   `doc-text.ts` 各自漂（M12 前这里写死的四件正是"清单只有一份"被打脸的那一处）。
      description:
        `抽取一份**文档**的正文文本：PDF（默认前 ${PDF_MAX_PAGES} 页；Pro 专业版可指定起始页、单次最多 ${PDF_WINDOW_MAX_PAGES} 页）、`
        + '`.docx` Word、`.xlsx` 表格（单元格缓存值，不重算公式）、`.pptx` 演示文稿（按页分段），'
        + '以及纯文本/源码/配置/日志'
        + `（本工具认下 ${TEXT_EXTS.length} 种扩展名，如 .txt/.md/.json/.csv/.ts/.log/.yaml；最多前 40000 字）。`
        + '抽不出会**如实说明原因**（扫描件无文字层 / CID 字形无 ToUnicode / 加密 / 老 .doc / 非 UTF-8 编码 / 解析失败）。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          filePath: { type: 'string', description: '文档路径（相对 working_dir 或绝对）' },
          startPage: {
            type: 'integer',
            minimum: 1,
            description: `PDF 起始页（1 基，默认 1）。从第 ${PDF_MAX_PAGES + 1} 页起属 Pro 长文档能力。仅对 PDF 生效。`,
          },
          maxPages: {
            type: 'integer',
            minimum: 1,
            description: `PDF 本次最多取多少页（默认 ${PDF_MAX_PAGES}，Pro 上限 ${PDF_WINDOW_MAX_PAGES}）。仅对 PDF 生效。`,
          },
        },
        required: ['filePath'],
      }),
      execute: async (args: { filePath: string; startPage?: number; maxPages?: number }) => {
        // zx_20260929 M3（J-1）：只读围栏（`..` / 敏感路径硬拒）——与 `read_file` / `view_image` 同一把尺。
        const g = readPathGuard(args.filePath, workingDir);
        if (!g.ok) return JSON.stringify({ error: g.error });
        const fp = g.resolved;
        // zx_20260929 M3 有界读盘：**先 `stat` 判上限、再整读**（上限口径取既有 `FAMILY_MAX_BYTES`，
        //   不新造常量）。文档族上限 20MB：旧序是"整读进内存再看长度"，一份 500MB 的 PDF 要先吃满
        //   500MB 才可能被下游拦下。**非文档族上限为 0 = 不设限**（它们随后会在下面的扩展名分派里被
        //   如实拒掉，故"读多大"这件事由族上限那一档管、不在这里另设一个数）。
        //   ⚠ zx_20260930 M12 订正：`.log` 自 M12 起归**文档族**（`TEXT_EXTS` 纳入源码/配置/日志），
        //   故"非文档族"的例子不再是 `.log`——旧注释与旧判据（C21b 该不命中①）都按 `.bin` 重钉。
        //   `stat` 失败与旧 `readFile` 失败**同一句回话**（C21b 该不命中②钉的是这个串）。
        let st: Awaited<ReturnType<typeof fsp.stat>>;
        try {
          st = await fsp.stat(fp);
        } catch (e) {
          return JSON.stringify({ error: `文件不存在或不可读: ${fp}（${e instanceof Error ? e.message : String(e)}）` });
        }
        const ext = path.extname(fp).toLowerCase();
        const docMax = maxBytesOf(familyOf(ext));
        if (docMax > 0 && st.size > docMax) {
          return JSON.stringify({
            path: fp, bytes: st.size,
            error: `文档 ${st.size} 字节超过 ${docMax} 字节上限。`,
          });
        }
        let bytes: Buffer;
        try {
          bytes = await fs.promises.readFile(fp);
        } catch (e) {
          return JSON.stringify({ error: `文件不存在或不可读: ${fp}（${e instanceof Error ? e.message : String(e)}）` });
        }
        if (ext === '.pdf') {
          // zx_20261018_3 批六：**先过档位闸，再读盘**。为什么闸在这里而不是 `attachment-inline`：
          //   开局内联仍按社区口径（前 20 页），"指哪读哪"只发生在本工具的显式请求上。
          const intArg = (v: unknown, def: number): number => {
            const n = Math.floor(Number(v));
            return Number.isFinite(n) && n >= 1 ? n : def;
          };
          const startPage = intArg(args.startPage, 1);
          const maxPages = intArg(args.maxPages, PDF_MAX_PAGES);
          if (maxPages > PDF_WINDOW_MAX_PAGES) {
            // 不静默截短：用户要 500 页却"悄悄只给 200"与假零同族（判据要能被合法请求满足，也要能如实说不）。
            return JSON.stringify({
              path: fp, bytes: bytes.length, ok: false,
              reason: `单次最多 ${PDF_WINDOW_MAX_PAGES} 页；本次请求 ${maxPages} 页——已拒绝（不静默截短）`,
            });
          }
          if (startPage > PDF_MAX_PAGES || maxPages > PDF_MAX_PAGES) {
            const refusal = proFeatureRefusal(deps.db, 'long_document');
            if (refusal) {
              return JSON.stringify({ path: fp, bytes: bytes.length, ok: false, reason: refusal, note: `原件在 ${fp}` });
            }
          }
          const r = extractPdfText(bytes, { startPage, maxPages });
          if (!r.ok) {
            // 与 `attachment-inline.ts` 的 PDF 支**同形**：真因 + `detail` 一起给，`detail` 不许丢
            //   （"可读字符占比 1.7% < 60%"才是用户拿去判断"这份 PDF 还能不能救"的那句话）。
            const why = r.detail ? `${r.reason}：${r.detail}` : r.reason;
            return JSON.stringify({ path: fp, bytes: bytes.length, ok: false, reason: why });
          }
          // 抬头只报**本次窗口**（不是"总页数"）：页窗口 ≠ 全篇，"第 6-10 页（共 30 页）"里
          //   前半句是本工具真读到的，后半句是文档的真规模，两者都不许含糊。
          const span = r.firstPage === r.lastPage ? `第 ${r.firstPage} 页` : `第 ${r.firstPage}-${r.lastPage} 页`;
          const head = r.truncated && r.firstPage === 1
            ? `[${path.basename(fp)} ${span}（共 ${r.pages} 页，已截断）]`
            : `[${path.basename(fp)} ${span}（共 ${r.pages} 页）]`;
          return `${head}\n${r.text}`;
        }
        // zx_20260924 M1：文档族的其余格式（txt/md/json/csv/docx/xlsx/pptx，以及**认得但不解析**的老 .doc）。
        if (isDocTextExt(ext)) {
          if (args.startPage !== undefined || args.maxPages !== undefined) {
            return JSON.stringify({
              path: fp, bytes: bytes.length, ok: false,
              reason: `${ext} 不支持 startPage/maxPages（页窗口只对 PDF 生效）；本工具按整份抽取，受 ${DOC_MAX_CHARS} 字预算`,
            });
          }
          const r = extractDocText(bytes, ext);
          if (!r.ok) {
            const why = r.detail ? `${r.reason}：${r.detail}` : r.reason;
            // 路径在场：`doc_legacy_unsupported`/`unsupported_encoding` 的**唯一可行动作**就是
            //   用户自己去取件或转存，所以这句不是装饰、是那条退路的入口。
            return JSON.stringify({ path: fp, bytes: bytes.length, ok: false, reason: why, note: `原件在 ${fp}` });
          }
          const head = r.truncated
            ? `[${path.basename(fp)} 正文（已截断至 ${DOC_MAX_CHARS} 字）]`
            : `[${path.basename(fp)} 正文]`;
          return `${head}\n${r.text}`;
        }
        return JSON.stringify({
          path: fp, bytes: bytes.length,
          error: `本工具只抽 PDF 与文档族正文（.txt/.md/.json/.csv/.docx/.xlsx/.pptx）；${ext || '(无扩展名)'} 不在其中——`
            + '纯文本可用 read_file，图片用 view_image，老 .doc 请转存为 .docx。',
        });
      },
    },
  };
}
