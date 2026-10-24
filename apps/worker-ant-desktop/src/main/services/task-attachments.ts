/**
 * zx_20261013_1 批二（管子·度量衡 / 道德经·损有余而补不足）: **桌面 GUI 挂件——本地选文件 → 落盘 → 并进任务上下文**。
 *
 * 病根（方案 §0 K7）：媒体只能从 IM 五家**入站**进来（`services/im-media.ts` 落盘 → `pending-media.ts`
 * 写 `context_json.attachments`），而桌面 GUI **没有把本地文件挂到任务上的路**——用户手上就有一份
 * 报告/截图，却只能先发给微信机器人再让工蚁捡回来。**件就在手边，路没修**。
 *
 * 本模块就是那条路。它与 IM 入站**共用同一条链**，不另造第二条：
 *   · 落盘与清洗 —— `saveInboundMedia`（`im-media.ts` 的唯一落盘真源，含 basename 清洗 / 同名不覆盖 / 根围栏）；
 *   · 落库形状 —— `attachmentEntry`（`pending-media.ts` 的形状真源，IM 路同一函数）；
 *   · 落库写者 —— `appendTaskAttachments`（同一处写者）；
 *   · 族判定 —— `familyOf`（`attachment-kinds.ts` 与装配层 `attachment-inline.ts` 同一把尺）。
 * 故此后**装配链**（`buildAttachmentParts` / `attachmentsNeedVision` / 能力把关）对 GUI 挂件天然生效，
 * 无需第二套实现——这正是"件，无论从哪来，都进同一道门"。
 *
 * 为什么 `channel='desktop'`：`attachmentEntry` 的 `channel` 记"从哪个渠道来的"（同一件日后可能从多家
 *   进来，排查时要分得开）。GUI 不是 IM 五家之一，用 `'desktop'` 一词与它们并列。
 *
 * ⚠ **本模块运行时零 electron / 零 better-sqlite3**（`pending-media.ts` 的 `better-sqlite3` 是**类型引**
 *   编译期即抹除，`im-media.ts` / `attachment-kinds.ts` 皆零该依赖）⇒ 受控回归可直跑真实现
 *   （`readFile` 可注入，夹具不必碰真盘）。承 `pending-media` / `pause-settlement` 的既有范式。
 */
import fs from 'node:fs';
import path from 'node:path';
import { familyOf, readCapBytes } from '../core/attachment-kinds.js';
import { saveInboundMedia } from './im-media.js';
import { attachmentEntry, type PendingMedia } from './pending-media.js';

/** 一件本地文件的落盘+形状结果；失败的各自**如实带真因**（不让一件坏件把整批吞掉）。 */
export interface LocalAttachmentFailure {
  filePath: string;
  error: string;
}

export interface ImportedLocalAttachments {
  /** 可直接交给 `appendTaskAttachments` 的 `context_json.attachments[i]` 形状项（成功的那几件）。 */
  entries: Array<Record<string, unknown>>;
  /** 没落成的，逐件带真因（GUI 据此如实上屏，不静默）。 */
  failures: LocalAttachmentFailure[];
}

export interface ImportLocalAttachmentsIo {
  /** 读一件本地文件的字节。缺省 `fs.readFileSync`；夹具可注入以不碰真盘。 */
  readFile?: (p: string) => Buffer;
  /** 盘上字节数（**先判后读**，防一件超大文件把整读撑爆主进程内存）。缺省 `fs.statSync`；取不到 ⇒ `null`。 */
  statSize?: (p: string) => number | null;
}

/**
 * 把一批**本地绝对路径**变成 `context_json.attachments[]` 的条目（同时把字节落进 `data/attachments/`）。
 *
 * 逐件独立成败：一件读不了/落不了 ⇒ 记进 `failures` 并继续下一件（见 `ImportLocalAttachments`）。
 * **永不抛**——挂件是给任务加料，不是任务的必要条件；坏一件不该把整条创建/挂件动作搞挂。
 *
 * 落盘文件名取**源文件 basename**（`saveInboundMedia` 内部再清洗保底），故 `familyOf(extname(basename))`
 * 与装配层按 `path.extname(path)` 判族同源——件落盘后带真扩展名，族判定两处必然一致。
 */
export function importLocalAttachments(
  dataDir: string,
  filePaths: readonly string[],
  opts?: { channelType?: string; now?: Date; io?: ImportLocalAttachmentsIo },
): ImportedLocalAttachments {
  const now = opts?.now ?? new Date();
  const channel = opts?.channelType ?? 'desktop';
  const readFile = opts?.io?.readFile ?? ((p: string) => fs.readFileSync(p));
  const statSize = opts?.io?.statSize ?? ((p: string) => { try { return fs.statSync(p).size; } catch { return null; } });
  const entries: Array<Record<string, unknown>> = [];
  const failures: LocalAttachmentFailure[] = [];

  for (const raw of filePaths) {
    const filePath = String(raw ?? '').trim();
    if (!filePath) continue;
    try {
      const name = path.basename(filePath);
      // **先判后读**：一件超过本族上限的文件（上限真源 `attachment-kinds.readCapBytes`，与 `read_file`
      //   同一把尺）在此如实拒，**不整读**——GUI 挂件是主进程内的同步动作，一个 2GB 文件足以把进程撑死。
      //   这与装配层的"超限 ⇒ 不内联"是两道独立的闸：此处挡的是"读不进内存"，那里挡的是"不进上下文"。
      const cap = readCapBytes(path.extname(name));
      const sizeOnDisk = statSize(filePath);
      if (sizeOnDisk !== null && sizeOnDisk > cap) {
        failures.push({ filePath, error: `件大小 ${sizeOnDisk}B 超过上限 ${cap}B` });
        continue;
      }
      const buf = readFile(filePath);
      // 族按**扩展名**判（与装配层同一把尺的先手那一步；装配层还会在判族时按魔数复核）。
      //   `kind` 存族名（而非 IM 那种平台数字类型）——它只是"这件是什么"的一条记录，装配层判族不靠它。
      const kind = familyOf(path.extname(name));
      const saved = saveInboundMedia(dataDir, { kind, fileName: name }, buf, now);
      if (!saved.ok) {
        failures.push({ filePath, error: saved.error });
        continue;
      }
      const media: PendingMedia = { kind, path: saved.path, fileName: name, sizeBytes: saved.bytes };
      entries.push(attachmentEntry(media, channel, now));
    } catch (e) {
      failures.push({ filePath, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    }
  }
  return { entries, failures };
}
