/**
 * zx_20260920_1 M5（庄子·无用之用 / 金刚经·不住相）: **入站媒体落盘**。
 *
 * 病根（方案 §1.4）：五家适配器对非文本入站只产出一个 `kind`（真类型），**没有"去哪儿取件"这一项**——
 * 于是下游无论如何都拿不到字节，`data/attachments/` **目录根本不存在**。上轮把"收到过一条图"
 * 记成了事实（列在），但**路不填**：行里有 `kind`，盘上无文件，回话里也没有件名。
 *
 * 本模块**零依赖**（只用 node 内建 `fs`/`path`/`crypto`，不引 electron / better-sqlite3），故可被受控回归直跑真实现——
 * "文件真到了盘上、字节数相符、路径没穿越"这些话，只有跑一遍才算证过。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
// 标签表**只此一份**（`im-adapter.ts` 导出）。本模块仍保持"零外部依赖"：`im-adapter.ts` 自身
//   **没有任何 import**（纯接口 + 该常量），故不引入 electron / better-sqlite3，受控回归仍可直跑。
import { NON_TEXT_LABELS } from './im-adapter.js';
// 根校验（zx_20260930 M1）：写侧与**只读取件**（`resolveAttachmentRead`）共用同一份口径——
//   `path-fence.ts` 同为**零依赖**（只用 node:os / node:path），不破坏本模块"可被受控回归直跑"的前提。
import { isInsideRoot } from '../core/path-fence.js';

/**
 * 落盘根目录名（**跨端契约**，与 `NOTIFICATION_PAYLOAD_DIR` 同待遇 ⇒ 须登记）。
 * 稳定小写复数，与 `task_outputs/`、`notification_payloads/` 同族。
 */
export const ATTACHMENTS_DIR = 'attachments';

/** 一件入站媒体：**去哪儿取件** + 平台给的真件名/大小（+ 平台给了就问得着的那把钥匙）。 */
export interface InboundMedia {
  kind: string;
  /** 取件地址（平台给了才有）。没有它 = 拿不到字节。 */
  mediaUrl?: string;
  fileName?: string;
  sizeBytes?: number;
  /**
   * 平台给的**对称密钥**（`Buffer`，已归一成裸字节）。
   *
   * ⚠ 它不是"额外的可选项"，是**这件能不能算到手**的一部分：iLink 的 CDN 真件是
   *   AES-ECB **密文**（2026-09-24 实机取证，见 `decryptAesEcb`）。没有它 ⇒ 按明文件落盘。
   *   平台没给钥匙的平台（钉钉/企微/飞书/QQ）此字段恒缺席，行为与从前**逐字相同**。
   */
  aesKey?: Buffer;
}

/**
 * 从 iLink `item_list` 里认出非文本件。
 *
 * 形状依据：文本是 `{type:1, text_item:{text}}`，语音是 `{type:3, voice_item:{…}}`，
 * 其余类型**原样带出 `type`**（本仓既有纪律：类型名不猜）。媒体体名按平台惯例是 `<name>_item`
 * （`image_item` / `file_item` / `video_item` …）——此处**不硬编码具体类型**，只按"第一个带 type 的 item
 * 里，除 `type` 外那个对象字段"取，从而对新类型天然生效。
 *
 * ⚠ kind 带 `String(typed.type)`（**数字**）：这是 zx_20260914 M1-2 的**刻意裁定**——"未知类型
 *   **原样带出**，不猜名字"，被 `rr_zx_20260914_2.ts` **三处**钉死（`nonTextPlaceholder('2')` ⇒
 *   `[其他消息(2)]`、微信 inbound 的 `message_json` 含 `"kind":"2"`、renderer `messageViewOf` 按
 *   `'3'`/`'2'` 读回），且**存量行的 `message_json` 里就是数字**。M9 复核一度改成"从平台字段名
 *   `image_item` 推 `image`"（更可读），但那是**动上一轮的契约**（+三处判据 +换端可见文案），
 *   **改回数字**，并由**用户于 2026-09-21 裁定「保持现状（数字）」**（方案 §5 五-17）。
 *   代价**如实记着、已随裁定一并接受**（同处 §5 五-18）：`NON_TEXT_LABELS` 与 `extOf` 的 `byKind`
 *   两张表按**类型名**建 ⇒ 微信的数字 kind 在它们上面**取不到**：真机发图回执显示「已收到其他消息(2)」、
 *   无名件**推不出扩展名**。平台侧 `*_item` 字段名（`image_item`…）M5 起已可用，若日后**翻案**，
 *   此处在场、改法明确。
 *
 * ⚠ 平台字段名**已实机取证**（2026-09-24，方案 §5）：取件地址与钥匙**嵌在 `media` 里**——
 *   `file_item.media.full_url` / `file_item.media.aes_key`（`image_item` 另有顶层 `aeskey`），
 *   件名在顶层 `file_name`，明文长度在顶层 `len`（值是**字符串**）。
 *   此前那份候选名（顶层 `url`/`file_url`/`media_url`/`download_url`）是**推定的形状**，
 *   真帧上**一个都不命中** ⇒ 行里有 kind、无地址 ⇒ 既不落盘、也不报错（`data/attachments/` 一直不存在）。
 *   **两套候选并存**：真形状优先，旧候选留作兜底（`rr_zx_20260920_1.ts` §F2 的标本用的就是旧形状）。
 *   取不到就是**没有**（不编造）——下游据此如实回"没能落盘"。
 */
export function mediaFromIlinkItems(items: unknown[]): InboundMedia | undefined {
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const typed = item as Record<string, unknown>;
    if (typed.type === 1) continue;       // 文本：走正文，不是媒体
    const mediaKey = Object.keys(typed).find((k) => k !== 'type' && k.endsWith('_item'));
    if (!mediaKey) continue;
    const body = typed[mediaKey];
    if (typeof body !== 'object' || body === null) continue;
    const b = body as Record<string, unknown>;
    // 真形状的**取件三元组**嵌在 `media` 里（`full_url` / `aes_key`），件名与 `len` 在顶层。
    const nested = (b.media && typeof b.media === 'object' ? b.media : {}) as Record<string, unknown>;
    const pick = (names: string[]): unknown => {
      for (const src of [nested, b]) {
        for (const n of names) if (src[n] !== undefined && src[n] !== null && src[n] !== '') return src[n];
      }
      return undefined;
    };
    const strOf = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const numOf = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);
    // ⚠ 带**数字** `type`（见文件头 ⚠）：这是上一轮的契约裁定，非本补丁范围。
    const media: InboundMedia = { kind: String(typed.type) };
    const url = strOf(pick(['full_url', 'url', 'file_url', 'media_url', 'download_url']));
    if (url) media.mediaUrl = url;
    const name = strOf(pick(['file_name', 'fileName', 'name']));
    if (name) media.fileName = name;
    // `len` 是 iLink 的**明文长度**（字符串）——放首位；旧候选名留作其他平台/旧形状的兜底。
    const size = numOf(pick(['len', 'size', 'file_size', 'size_bytes']));
    if (size !== undefined) media.sizeBytes = size;
    // 没有钥匙 ≠ 出错：那是"这件是明文件"。（真帧里 2/4/5 型恒带钥匙；1 型文本不走此处、3 型语音若带 ASR 文本亦不走此处。）
    const key = aesKeyOf(pick(['aes_key', 'aeskey']));
    if (key) media.aesKey = key;
    return media;
  }
  return undefined;
}

/**
 * 归一平台的 `aes_key`（zx_20260924 实机取证的真形状）。
 *
 * 同一帧里**一把钥匙有两种写法**：
 *  - `file_item.media.aes_key` / `image_item.media.aes_key` = `"M2Vh…YTY="`
 *    —— **base64 过的 32 个十六进制字符**；
 *  - `image_item.aeskey` = `"3ea4…c3a6"` —— 就是那 32 个十六进制字符本身。
 * 两者解出来是**同一把 16 字节 AES-128 钥匙**（实测：两种写法归一后逐字节相等）。
 *
 * 其余形状**不猜**（返回 `undefined` ⇒ 不尝试解密、如实走"没钥匙"这条路）：宁可说"没能落盘"，
 * 也不拿一把瞎猜的钥匙去解，更不把解出来的垃圾当用户发的件存下来。
 */
export function aesKeyOf(raw: unknown): Buffer | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  if (/^[0-9a-fA-F]{32}$/.test(s)) return Buffer.from(s, 'hex');           // 裸十六进制（`image_item.aeskey`）
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return undefined;                 // 不是 base64 形状 ⇒ 不猜
  const dec = Buffer.from(s, 'base64');
  // base64 壳里装的**还是**十六进制串 ⇒ 再解一层（`media.aes_key` 的写法）。
  if (dec.length === 32 && /^[0-9a-fA-F]{32}$/.test(dec.toString('latin1'))) return Buffer.from(dec.toString('latin1'), 'hex');
  return dec.length === 16 || dec.length === 24 || dec.length === 32 ? dec : undefined;
}

/**
 * AES-ECB 解密（iLink 的 CDN 真件**是密文**；2026-09-24 实机取证）。
 *
 * 算法与模式取自**实测**而非推定：真帧 `file_item.media.aes_key` 归一后的 16 字节钥匙，
 * 对 CDN 取回的 1616 字节作 `aes-128-ecb` 解密 ⇒ **1610 字节**，其 md5 与 `file_item.md5`
 * 逐字相同、并与用户发的原件 `data/测试.txt` 字节一致。PKCS#7 填充（1616 = 1610 + 6B）。
 *
 * ⚠ **解不开一律 `ok:false`**：绝不"解不开也照存"——存下去的是密文，而回执会说"已落盘"；
 *   用户从微信发来一张图、盘上躺着一段谁也打不开的字节，是本轮明令要治的**那种**谎报。
 */
export function decryptAesEcb(buf: Buffer, key: Buffer): MediaFetchResult {
  const algo = key.length === 16 ? 'aes-128-ecb' : key.length === 24 ? 'aes-192-ecb' : key.length === 32 ? 'aes-256-ecb' : '';
  if (!algo) return { ok: false, error: `不认识的密钥长度 ${key.length}B（无法解密）` };
  try {
    const d = crypto.createDecipheriv(algo, key, null);
    return { ok: true, buf: Buffer.concat([d.update(buf), d.final()]) };
  } catch (e) {
    return { ok: false, error: `解密失败：${(e as Error).message.slice(0, 160)}` };
  }
}

/**
 * 平台下载地址里的**占位后缀**（不是真件名）。
 *
 * 依据：钉钉官方「下载机器人接收消息的文件内容」页面**明说**下载下来的文件名形如
 * `iAEI******IVAiYgXNCKMGzSsRB85j_Z7zCM0CYA.file`，**要开发者自行替换成真后缀**（示例换成 `.mp4`）。
 * 信它 = 每张钉钉图都存成 `.file` ⇒ `familyOf('.file')` 判 `binary` ⇒ **永远不内联**（M3 的病根换地方复发）。
 * 故此处把它当"没有后缀"看，退到 `byKind` 按平台给的**类型名**推断——那才是真信息。
 *
 * ⚠ 只影响**平台没给件名**时的兜底名（`saveInboundMedia` 优先用 `media.fileName`）：
 *   用户真发了个 `report.file`，这个名字来自平台声明的 `fileName`，不经此处，不受影响。
 */
const PLACEHOLDER_EXTS = new Set(['.file']);

/** 按 URL 后缀或 kind 猜扩展名（猜不出返回空串——**不编造**）。 */
function extOf(media: InboundMedia): string {
  try {
    if (media.mediaUrl) {
      const p = new URL(media.mediaUrl, 'http://x').pathname;
      const e = path.extname(p);
      if (/^\.[A-Za-z0-9]{1,6}$/.test(e) && !PLACEHOLDER_EXTS.has(e.toLowerCase())) return e;
    }
  } catch { /* 不是合法 URL，退到 kind 推断 */ }
  // `picture`/`media` 是**钉钉/飞书**对"图片/视频"的类型名（钉钉 `msgtype=picture`、飞书 `message_type=media`），
  //   与既有的 `image`/`video` 同义——进这张表只做"类型名 → 约定后缀"的翻译，不改任何判族逻辑。
  //
  // zx_20260924 补**微信的数值类型**（`'2'/'3'/'4'/'5'`）。依据是**实机取证的真帧**，不是推定：
  //   iLink 的 `type` 2/3/4/5 在帧里分别挂在 `image_item`/`voice_item`/`file_item`/`video_item` 上
  //   ⇒ 数字与类型名是**同一件事的两种写法**，故与上表同名同值（翻译，不是编造）。
  //   ⚠ 这**不动** `kind` 的形状契约（行里存的仍是数字、回执仍是「其他消息(2)」——用户 2026-09-21
  //   裁定，见上）；本表只回答"**没有平台件名时**兜底名带什么后缀"，与"行里存什么"是两件事。
  //   不补的代价是实的：微信发图/发视频（平台不给 `file_name`）落成**无后缀**文件 ⇒ `familyOf` 判
  //   `binary` ⇒ M2「视频→音轨转写」在微信这条路上**永远不触发**（做了没用上）。
  const byKind: Record<string, string> = {
    image: '.jpg', img: '.jpg', picture: '.jpg', file: '.bin', document: '.bin',
    voice: '.amr', audio: '.amr', video: '.mp4', media: '.mp4',
    '2': '.jpg', '3': '.amr', '4': '.bin', '5': '.mp4',
  };
  return byKind[media.kind] ?? '';
}

/**
 * 落盘文件名。
 *
 * **安全**：平台给的字符串**一律只取 basename**（`../../etc/passwd` ⇒ `passwd`）——
 * 用它直接拼路径就是路径穿越。空名/纯点/全非法字符退到 `im-<时间戳>-<6位随机><扩展名>`。
 */
export function safeMediaFileName(media: InboundMedia, now = Date.now(), rand = Math.random): string {
  const raw = (media.fileName ?? '').trim();
  const base = raw ? path.basename(raw).replace(/^\.+/, '') : '';
  // 控制字符写成 `\u0000-\u001f` 转义，**勿嵌入真控制字节**——它在编辑器 / git / 代码审阅里不可见，会被误读成 `[ -/` 区间（本轮我已据此误判过一次）。
  const cleaned = base.replace(/[\u0000-\u001f\u007f\/\\:*?"<>|]/g, '_').trim();
  if (cleaned) return cleaned;
  const suffix = rand().toString(36).slice(2, 8).padEnd(6, '0');
  return `im-${now}-${suffix}${extOf(media)}`;
}

/** 落盘根（`<dataDir>/attachments`）。 */
export function attachmentsRoot(dataDir: string): string {
  return path.join(dataDir, ATTACHMENTS_DIR);
}

/** 当天子目录（UTC `YYYYMMDD`，与库内 `datetime('now')` 同一时钟基准——本仓 DB 时刻是 UTC）。 */
export function attachmentsDayDir(dataDir: string, now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return path.join(attachmentsRoot(dataDir), `${y}${m}${d}`);
}

export type SaveMediaResult =
  | { ok: true; path: string; bytes: number; fileName: string }
  | { ok: false; error: string };

/**
 * 把一件媒体写到 `<dataDir>/attachments/<YYYYMMDD>/<件名>`。
 *
 * 失败**如实返回真因**（调用方须把这条真因写进入站行的 `last_error`，不得吞掉——
 * 承「失败行必带真因」的既有纪律）。**同名不覆盖**：追加 `-2`/`-3`…（同一时刻两张同名图不得互相盖掉）。
 */
export function saveInboundMedia(
  dataDir: string,
  media: InboundMedia,
  content: Buffer | Uint8Array,
  now: Date = new Date(),
): SaveMediaResult {
  try {
    const dir = attachmentsDayDir(dataDir, now);
    fs.mkdirSync(dir, { recursive: true });
    const base = safeMediaFileName(media, now.getTime());
    let target = path.join(dir, base);
    const ext = path.extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${stem}-${i}${ext}`);
    // 纵深防御：即便 basename 被绕过，也必须在 attachments 根之下（不依赖上层是否记得校验）
    //   根校验口径归 `path-fence.isInsideRoot`（读侧 `resolveAttachmentRead` 读的是同一处，
    //   不是各写一段 `startsWith` —— 少拼一个 `path.sep` 那类放宽是静默的）。
    if (!isInsideRoot(target, attachmentsRoot(dataDir))) {
      return { ok: false, error: `目标路径越出 ${ATTACHMENTS_DIR}/（已拒绝写入）` };
    }
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    fs.writeFileSync(target, buf);
    // `fileName` = **盘上那个名字**（= `path.basename(path)`）：同名时它是 `…-2.jpg`，**不是**平台原名。
    //   回执里的「件名」另走 `media.fileName`（平台声明的那一个）——两个事实各自为真，别在此处混用。
    return { ok: true, path: target, bytes: buf.length, fileName: path.basename(target) };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) };
  }
}

export type AttachmentReadReason = 'no_path' | 'url' | 'not_absolute' | 'out_of_root' | 'missing';

export type AttachmentReadResult =
  | { ok: true; path: string }
  | { ok: false; reason: AttachmentReadReason; error: string };

/** URL 方案前缀。与 `shell:showItemInFolder` 的同名判定同形（两处护的都是"别把地址当路径"）。 */
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * IM 件**只读取件**的入口守卫（zx_20260930 M1「件要显形」的读侧那一半）。
 *
 * 病根：`message_json` 里**早就有**「这件在盘上哪儿」（入站 `saved_path` / 出站 `media.path`），
 * 而界面把它当一行灰字占位符显示——**看得出"收到过一件"，看不出那件是什么、更打不开**。
 * 打开它的这一步，就是本函数：把行里的那个串变成"**可以打开的那一个盘上文件**"，越界即如实拒。
 *
 * 范围**硬限**在 `<dataDir>/attachments/` 根内，五种理由各自**分词**（渲染层据此各说各的话，
 * 不笼统一句"打不开"）：
 *   ① 空 ⇒ `no_path`；② URL 方案（**含 `file://`**）⇒ `url`——那是"取件地址"不是盘上路径，
 *      放行它等于绕开本围栏；③ 相对路径 ⇒ `not_absolute`。第三条是**刻意**的：`saved_path` 由
 *      `saveInboundMedia` 写、**恒为绝对**，此处若肯解析相对路径，"相对谁"（cwd？dataDir？）
 *      本身就得再定一条规则——那正是第二套路径规则的起点；
 *   ④ 不在根下 ⇒ `out_of_root`（口径归 `path-fence.isInsideRoot`，**不新造一套路径规则**）；
 *   ⑤ 盘上没有 / 不是文件 ⇒ `missing`。
 *
 * ⚠ **本函数只判"能不能读"：不设限额、不读字节、不判 MIME**。限额与内联口径归
 *   `resolveAudioPreview` / `resolveImagePreview`（各自读盘之前先判一次，与成果预览同一把尺）；
 *   两件事分开的好处是越界时**一个字节都不读**。
 * ⚠ 它只用在**只读**那一条路上：别把它拼进"另存"的前置（另存的落点由用户经系统对话框选）。
 */
export function resolveAttachmentRead(dataDir: string, candidate: string | undefined | null): AttachmentReadResult {
  const raw = String(candidate ?? '').trim();
  if (!raw) return { ok: false, reason: 'no_path', error: '这条消息没有记录件在盘上的路径' };
  if (URL_SCHEME_RE.test(raw)) return { ok: false, reason: 'url', error: '这是取件地址，不是盘上的路径' };
  if (!path.isAbsolute(raw)) return { ok: false, reason: 'not_absolute', error: '件路径不是绝对路径（已拒绝按当前目录解析）' };
  if (!isInsideRoot(raw, attachmentsRoot(dataDir))) {
    return { ok: false, reason: 'out_of_root', error: `件路径越出 ${ATTACHMENTS_DIR}/（已拒绝读取）` };
  }
  const resolved = path.resolve(raw);
  try {
    // `isFile()` 一并挡掉目录（根自身也在此列）与设备文件——`readFileSync` 一个目录会抛 EISDIR，
    //   但那时错误来自 fs 而非本守则，理由就说不清了。
    if (!fs.statSync(resolved).isFile()) return { ok: false, reason: 'missing', error: '盘上这个路径不是文件' };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, reason: 'missing', error: `盘上找不到这件${code ? `（${code}）` : ''}` };
  }
  return { ok: true, path: resolved };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 展示用相对路径（`attachments/<YYYYMMDD>/<件名>`）。
 *
 * ⚠ 由落盘路径**自身**从最后一次出现的 `attachments` 段起算，**不**再由路径反推 `dataDir`——
 *   反推要恰好知道中间隔了几层（`dirname` 几次），层数一改（如加一层分片目录）就静默算错；
 *   上一版按 `attachmentsRoot(dirname(dirname(savedPath)))` 就多拼出一段 `attachments/attachments`。
 */
function shownAttachmentPath(savedPath: string): string {
  const parts = path.resolve(savedPath).split(path.sep);
  const i = parts.lastIndexOf(ATTACHMENTS_DIR);
  return (i >= 0 ? parts.slice(i) : parts.slice(-2)).join('/');
}

/**
 * 落盘回执文案（**判在用户可见串**，M-C）。
 *
 * 两支都**含真件名**：成功说"已落盘到哪儿"，失败**必须说出"没能落盘"**——
 * 把"我丢了"说成"我收了"是本轮明令要治的那类谎报。
 * 这一句是**固定文案的落地回执**，不是把媒体交给模型自由发挥（上轮 D3 裁定「默认不回」不被推翻）。
 */
/** 入站媒体**下载**上限（字节）。**一处真源**：五家适配器共用，谁都不许各写一个数。 */
export const INBOUND_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
/** 取件超时（毫秒）。整件一个总预算——**没有分块超时**：分块只会把"慢"变成"半个文件"。 */
export const INBOUND_MEDIA_TIMEOUT_MS = 20_000;

/** 可注入的桩口。**只包网络边界**（`fetch`），不动本模块其余逻辑 ⇒ 受控回归能真跑下载+落盘全链。 */
export interface MediaFetchIo {
  fetch?: typeof fetch;
}

export type MediaFetchResult = { ok: true; buf: Buffer } | { ok: false; error: string };

/**
 * 取件（zx_20260924 M3）。**本函数是"平台给的路 → 盘上的字节"这一步的唯一实现**——
 * wechat 原先把它写在自己类里（`persistInboundMedia`/`downloadMedia` 两个私有方法），
 * 其余四家若各再抄一份，就是"同一条规则的第五次实现"（G8/G9 的老病）。故收归此处，五家共引。
 *
 * **永不抛**：失败如实返回真因（调用方须写进入站行的 `last_error`，不得吞掉）。
 *
 * ⚠ **HTTP 200 也可能是失败**：企微 `/media/get` 在 `media_id` 失效时回 **200 + `{"errcode":…,"errmsg":…}`**，
 *   字节根本不是文件。故此处对 `content-type` 是 JSON **且**解出的对象带错误键（`errcode`/`code`/`error`）
 *   的响应判为失败并把平台的原文带出来——**不把一段 JSON 当作"用户发的文件"落盘**。
 *   （真有人发了个含 `errcode` 键的 `.json` 件时会被误判，这是**已知且可接受**的取舍：
 *     误判成"没能落盘"是响亮的，误判成"落盘成功"是静默的。）
 */
export async function fetchInboundMedia(
  url: string,
  headers: Record<string, string> = {},
  io?: MediaFetchIo,
): Promise<MediaFetchResult> {
  const doFetch = io?.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INBOUND_MEDIA_TIMEOUT_MS);
  try {
    const resp = await doFetch(url, { headers, signal: controller.signal });
    if (!resp.ok) return { ok: false, error: `取件 HTTP ${resp.status}` };
    const declared = Number(resp.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > INBOUND_MEDIA_MAX_BYTES) {
      return { ok: false, error: `件大小 ${declared}B 超过上限 ${INBOUND_MEDIA_MAX_BYTES}B` };
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > INBOUND_MEDIA_MAX_BYTES) {
        controller.abort();
        return { ok: false, error: `件大小超过上限 ${INBOUND_MEDIA_MAX_BYTES}B` };
      }
      chunks.push(Buffer.from(chunk));
    }
    const buf = Buffer.concat(chunks);
    // 错误信封的判定**必须在收完字节之后**：`resp.text()` 会把 body 消费掉，此后再读 `resp.body` 会抛
    //   `Body is unusable` ⇒ 真有人发了个 `.json` 件时会被判成"没能落盘"（**响亮的误报**，但仍是不实之言）。
    //   先收字节再判信封，两个目的（限额、辨错误）都不丢。
    const ctype = (resp.headers.get('content-type') ?? '').toLowerCase();
    if (ctype.includes('json')) {
      const env = asErrorEnvelope(buf.toString('utf-8'));
      if (env) return { ok: false, error: env };
    }
    return { ok: true, buf };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.includes('abort') ? `取件超时（${INBOUND_MEDIA_TIMEOUT_MS / 1000}s）` : msg.slice(0, 200) };
  } finally { clearTimeout(timer); }
}

/** 认出平台的**错误信封**（200 + JSON）。认不出 ⇒ `null`（＝这不是错误形状，按正常响应走）。 */
function asErrorEnvelope(text: string): string | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (!o || typeof o !== 'object') return null;
    const code = o.errcode ?? o.code ?? o.error;
    if (code === undefined || code === 0 || code === '0' || code === '') return null;
    const why = typeof o.errmsg === 'string' ? o.errmsg : (typeof o.message === 'string' ? o.message : '');
    return `平台返回错误码 ${String(code)}${why ? `：${why}` : ''}`;
  } catch { return null; }
}

export type PersistMediaResult = { savedPath?: string; mediaError?: string; bytes?: number };

/**
 * 取件 + （按需解密） + 落盘（M3 起的**唯一**入口）。**只如实返回结果，不在此回话**——用户可见串的唯一出口是 im-router。
 *
 * `mediaUrl` 缺席 ⇒ 返回 `{}`（＝**不尝试、不报错**）：这是"本平台/本条没给路"，不是"取件失败"；
 * 混为一谈会让没实现入站媒体的路径凭空多出一句失败回话。
 *
 * 平台给了钥匙（`media.aesKey`）⇒ 取回的是**密文**，**先解密再落盘**；解不开 ⇒ 如实 `mediaError`，
 * **一个字节都不写**（见 `decryptAesEcb`）。返回的 `bytes` 是**盘上真件的字节数**，供调用方以实测覆盖平台自报的大小。
 */
export async function persistInboundMedia(
  dataDir: string,
  media: InboundMedia,
  opts?: { headers?: Record<string, string>; io?: MediaFetchIo },
): Promise<PersistMediaResult> {
  const url = media.mediaUrl;
  if (!url) return {};
  const got = await fetchInboundMedia(url, opts?.headers ?? {}, opts?.io);
  if (!got.ok) return { mediaError: got.error };
  let content = got.buf;
  if (media.aesKey) {
    const dec = decryptAesEcb(got.buf, media.aesKey);
    if (!dec.ok) return { mediaError: dec.error };
    content = dec.buf;
  }
  const r = saveInboundMedia(dataDir, media, content);
  return r.ok ? { savedPath: r.path, bytes: r.bytes } : { mediaError: r.error };
}

export function mediaReceiptText(input: {
  kind: string;
  fileName?: string;
  sizeBytes?: number;
  savedPath?: string;
  error?: string;
}): string {
  const label = NON_TEXT_LABELS[input.kind] ?? `其他消息(${input.kind})`;
  const name = input.fileName ? `「${input.fileName}」` : '';
  const size = typeof input.sizeBytes === 'number' && Number.isFinite(input.sizeBytes) ? `(${formatBytes(input.sizeBytes)})` : '';
  if (input.savedPath) {
    return `📎 已收到${label}${name}${size}，已落盘到 ${shownAttachmentPath(input.savedPath)}`;
  }
  return `📎 已收到${label}${name}${size}，但**没能落盘**（${input.error || '原因未记录'}）。`;
}
