/**
 * zx_20260930 M1（维特根斯坦·意义即使用 / 海德格尔·上手状态）: IM 一「件」的**显形判定**唯一处。
 *
 * 病根（方案 §1.1）：`wa_im_conversations.message_json` 里其实**已经**记着「这件在盘上哪儿」
 * （入站扁平 `saved_path`；出站嵌套 `media.path`），但**没有任何一处按 kind 分派渲染**——
 * 图片、语音、PDF 在界面上同长一行灰字占位符（`[图片]` / `[其他消息(3)]`）。
 * 这是"件在盘上，路没修"的第二种形态：**看得出"收到过一件"，看不出那件是什么、更打不开**。
 *
 * ⚠ **本模块零依赖**（只引 `attachment-kinds` / `deliverable-types` 这两张同样零依赖的表，
 *   不引 electron / better-sqlite3 / node:*）：
 *   ① 主进程与渲染层跨 root 引**同一份代码**（`IMPage` 直接用它判该出哪种控件），
 *      在 renderer 再抄一份"什么算图片"就是同一条规则的第二处载体（G8/G9 的老病）；
 *   ② 受控回归可直跑真实现——形状解析与"该出哪种控件"全在本文件里，可断言。
 *
 * 两种形状**都读**（同一件事在库里有两种写法是既成事实，不是新约定；把其中一种"改齐"会动到
 * 五家适配器 + 补发账两条路，超出本轮）：
 *   · 入站（`im-router` 写）：`{ kind, file_name, size_bytes, saved_path, media_error }` —— 扁平；
 *   · 出站（`im-outbox.mediaJson` 与各家适配器写）：`{ text, media: { path, kind, name? } }` —— 嵌套。
 * 两者都不认识 ⇒ `null`（＝按普通文本走），**不猜**。
 */
import { FAMILY_MAX_BYTES, familyOf, type AttachmentFamily } from '../attachment-kinds.js';
import { IMAGE_PREVIEW_MIME } from '../deliverable-types.js';

/** 界面上该出哪种控件——**与"族"不是一回事**：族说"这是什么"，本档说"界面拿它怎么办"。 */
export type ImMediaRender = 'image' | 'audio' | 'video' | 'file';

export interface ImMediaRef {
  /** `image`=缩略图 · `audio`=播放条 · `video`=播放器 · `file`=件名+大小+打开/另存。 */
  render: ImMediaRender;
  /** 附件族（唯一判据在 `attachment-kinds`）。 */
  family: AttachmentFamily;
  /** 盘上绝对路径。空串只在**只有 `media_error`、没有 `saved_path`** 时出现（＝这件没到手）。 */
  path: string;
  /** 声明的件名（平台/发送方给了才有；路径兜底为盘上那个名字）。 */
  fileName: string;
  /** 字节数（入站是平台自报；出站形状没有此字段）。 */
  sizeBytes?: number;
  /** 非空 ＝ 这件**没到手**（`media_error`）——界面须**写出原因**，不许显示成普通文本。 */
  error?: string;
  /** 扩展名（含点、小写）；判不出为空串。 */
  ext: string;
}

/**
 * 件名/路径 → 扩展名（含点、小写）。
 *
 * **不引 `node:path`**（本模块要能在渲染层跑），故手写：按最后一个 `.` 切，且**点为首字符时
 * 视为无扩展名**——`.bashrc` 不是"扩展名为 bashrc"的件。
 */
export function extOf(nameOrPath: string | undefined | null): string {
  const base = String(nameOrPath ?? '').split(/[\\/]/).pop() || '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

/** 路径末段（同上，不引 `node:path`）。 */
export function baseNameOf(p: string | undefined | null): string {
  return String(p ?? '').split(/[\\/]/).pop() || '';
}

/**
 * 音频「扩展名 → MIME」。**与图片那张表刻意分开**：`IMAGE_PREVIEW_MIME` 属成果预览口径、
 * 键集与用途都不同（那张表里没有也不该有音频），合成一张就会在任一侧增删时误伤另一侧。
 * 只收**有据**的类型（`attachment-kinds` 的音频族 + 常见音频后缀）；不在表内 ⇒ 不做音频控件（见下）。
 */
export const AUDIO_PREVIEW_MIME: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.weba': 'audio/webm',
  '.flac': 'audio/flac', '.amr': 'audio/amr', '.wma': 'audio/x-ms-wma',
  '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
};

/** 音频内联上限 ＝ **该族的上限**（`attachment-kinds` 的 `FAMILY_MAX_BYTES.audio`，25MB）。
 *  不另写一个数字——族上限改了这里跟着改，判据与实现读同一个值。 */
export const AUDIO_PREVIEW_MAX_BYTES: number = FAMILY_MAX_BYTES.audio;

/** 浏览器**能直接解码**的音频 MIME（判据取自 MIME，不另立一份扩展名清单）。 */
const BROWSER_PLAYABLE_AUDIO_MIME: ReadonlySet<string> = new Set([
  'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/flac',
]);

/**
 * 该扩展名的音频**能不能在浏览器里直接放**——返回非空即"多不能"。
 *
 * 为什么要说这句：微信语音落下来是 `.amr`，Chromium **解不了**——播放条会出现在那儿、按下去没反应，
 * 用户读成"文件坏了/发丢了"。**没反应也是一种沉默**，故须在控件旁如实标注，并指向"另存"那条出口。
 */
export function audioPlayNote(ext: string): string {
  const mime = AUDIO_PREVIEW_MIME[String(ext ?? '').toLowerCase()];
  if (!mime || BROWSER_PLAYABLE_AUDIO_MIME.has(mime)) return '';
  return '此格式浏览器多不能直接播放；可用「另存」留存后用本地播放器打开';
}

/**
 * 视频「扩展名 → MIME」。**与图片/音频两张表刻意分开**（理由同上）：三张表的键集与用途都不同，
 * 合成一张就会在任一侧增删时误伤另一侧。只收**有据**的类型（`attachment-kinds` 视频族的扩展名 +
 * `.m4v`/`.ogv` 两个常见同族后缀）；不在表内 ⇒ 不做视频控件（见 `renderOf`）。
 */
export const VIDEO_PREVIEW_MIME: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.ogv': 'video/ogg', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
};

/** 视频内联上限 ＝ **该族的上限**（`attachment-kinds` 的 `FAMILY_MAX_BYTES.video`，100MB）。
 *  不另写一个数字——族上限改了这里跟着改，判据与实现读同一个值。 */
export const VIDEO_PREVIEW_MAX_BYTES: number = FAMILY_MAX_BYTES.video;

/** 浏览器**能直接解码**的视频 MIME（判据取自 MIME，不另立一份扩展名清单）。
 *  Chromium 只稳认 mp4(H.264) / webm / ogg 三种容器；mkv / avi / mov 多不能直接播。 */
const BROWSER_PLAYABLE_VIDEO_MIME: ReadonlySet<string> = new Set([
  'video/mp4', 'video/webm', 'video/ogg',
]);

/**
 * 该扩展名的视频**能不能在浏览器里直接放**——返回非空即"多不能"（与 `audioPlayNote` 同形同口径）。
 *
 * 为什么要说这句：手机发来的 `.mov` / `.mkv` / `.avi`，Chromium 多半解不了——播放器会出现在那儿、
 * 按下去没反应，用户读成"视频坏了/发丢了"。**没反应也是一种沉默**，故须在控件旁如实标注，
 * 并指向"另存"那条出口。
 */
export function videoPlayNote(ext: string): string {
  const mime = VIDEO_PREVIEW_MIME[String(ext ?? '').toLowerCase()];
  if (!mime || BROWSER_PLAYABLE_VIDEO_MIME.has(mime)) return '';
  return '此格式浏览器多不能直接播放；可用「另存」留存后用本地播放器打开';
}

/**
 * 一「件」该出哪种控件。**图片复用成果预览的同一张白名单**（`IMAGE_PREVIEW_MIME`）——
 * 白名单外（如 `.bmp`/`.svg` 之外的位图）**不当图渲染**，退到 `file`（件名+大小+打开），
 * 与"成果图片预览"同一口径：宁可给一条打不开的路径，也不给一个加载不出来的 `<img>`。
 */
function renderOf(ext: string, family: AttachmentFamily): ImMediaRender {
  if (IMAGE_PREVIEW_MIME[ext]) return 'image';
  // 族是音频**且**有已知 MIME 才给播放条；族是音频但 MIME 认不出（如 `.silk`）⇒ 退到 `file`，
  //   不给一个注定播不动的控件（"控件的存在"本身就是一句承诺）。
  if (family === 'audio' && AUDIO_PREVIEW_MIME[ext]) return 'audio';
  // 同上：族是视频**且**有已知 MIME 才给播放器；族是视频但 MIME 认不出 ⇒ 退到 `file`。
  if (family === 'video' && VIDEO_PREVIEW_MIME[ext]) return 'video';
  return 'file';
}

function build(path: string, fileName: string, sizeBytes: number | undefined, error: string | undefined): ImMediaRef {
  // 判族**以盘上那个路径为准**、件名兜底：`saved_path` 的末段是**盘上真实的样子**，
  //   而平台给的 `file_name` 可能是占位名（钉钉下载下来恒叫 `….file`，`im-media` 已把它当"没有后缀"）。
  const ext = extOf(path) || extOf(fileName);
  const family = familyOf(ext);
  return {
    render: renderOf(ext, family),
    family,
    path,
    fileName,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(error ? { error } : {}),
    ext,
  };
}

/**
 * 从一行的 `message_json` 里认出「这件」。认不出 ⇒ `null`（普通文本行，或库里的坏数据）。
 *
 * 解析顺序**先是出站的嵌套形状**：`media.path` 是出站行的**专有**键（入站从不写它），
 * 先判它可避免一条既有 `media` 又有 `saved_path` 的行（理论上不该有）被误判成入站。
 */
export function imMediaOf(messageJson: unknown): ImMediaRef | null {
  const raw = typeof messageJson === 'string' ? messageJson : (messageJson == null ? '' : String(messageJson));
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
  } catch { /* 非 JSON ⇒ 不是媒体行（按普通文本如实显示，不假装它是结构化的） */ }
  if (!obj) return null;

  const nested = obj.media && typeof obj.media === 'object' && !Array.isArray(obj.media)
    ? (obj.media as Record<string, unknown>)
    : null;
  const nestedPath = typeof nested?.path === 'string' ? nested.path.trim() : '';
  if (nestedPath) {
    const rawName = typeof nested?.name === 'string' ? nested.name.trim() : '';
    return build(nestedPath, rawName || baseNameOf(nestedPath), undefined, undefined);
  }

  // 入站扁平形状：`saved_path`（成功）与 `media_error`（失败）**互斥**——`im-router` 只在真发生时写一个。
  const saved = typeof obj.saved_path === 'string' ? obj.saved_path.trim() : '';
  const err = typeof obj.media_error === 'string' ? obj.media_error.trim() : '';
  if (!saved && !err) return null;
  const rawName = typeof obj.file_name === 'string' ? obj.file_name.trim() : '';
  const size = typeof obj.size_bytes === 'number' && Number.isFinite(obj.size_bytes) && obj.size_bytes >= 0
    ? obj.size_bytes
    : undefined;
  return build(saved, rawName || (saved ? baseNameOf(saved) : ''), size, err || undefined);
}

/** 只取用到的两个方法（与 `image-preview` 的 `PreviewIo` 同形，避免把 node 类型面铺到调用方）。 */
export interface MediaReadIo {
  statSync(p: string): { isFile(): boolean; size: number };
  readFileSync(p: string): { toString(encoding: 'base64'): string };
}

export type MediaReadOutcome =
  | { ok: true; mime: string; size: number; base64: string }
  | { ok: false; reason: 'unsupported' | 'missing' | 'oversize'; size?: number; limit?: number };

/**
 * 音频件的可内联性判定。与 `resolveImagePreview` **同形同口径**（三条边界，每条都在读盘之前）：
 *   ①认不出 MIME ⇒ `unsupported`；②须是**既有文件**（缺失/目录 ⇒ `missing`）；
 *   ③上限 `AUDIO_PREVIEW_MAX_BYTES`，超限**只 stat 不 read**（大件整读进主进程才是风险面）。
 *
 * 三种失败**分别回报**——渲染层据此各说各的话，不笼统一句"放不了"。
 * `io` 是**注入**的（不直接 `import fs`）：受控回归挂一个记调用的替身，把"没读盘"变成可证伪的事实。
 */
export function resolveAudioPreview(
  filePath: string | null | undefined,
  name: string | null | undefined,
  io: MediaReadIo,
): MediaReadOutcome {
  const fp = filePath || '';
  const ext = extOf(fp) || extOf(name);
  const mime = AUDIO_PREVIEW_MIME[ext];
  if (!mime || !fp) return { ok: false, reason: 'unsupported' };
  let size = 0;
  try {
    const st = io.statSync(fp);
    if (!st.isFile()) return { ok: false, reason: 'missing' };
    size = st.size;
  } catch { return { ok: false, reason: 'missing' }; }
  if (size > AUDIO_PREVIEW_MAX_BYTES) return { ok: false, reason: 'oversize', size, limit: AUDIO_PREVIEW_MAX_BYTES };
  return { ok: true, mime, size, base64: io.readFileSync(fp).toString('base64') };
}

/**
 * 视频件的可内联性判定。与 `resolveAudioPreview` **同形同口径**（三条边界，每条都在读盘之前）：
 *   ①认不出 MIME ⇒ `unsupported`；②须是**既有文件**（缺失/目录 ⇒ `missing`）；
 *   ③上限 `VIDEO_PREVIEW_MAX_BYTES`，超限**只 stat 不 read**（大件整读进主进程才是风险面）。
 *
 * 三种失败**分别回报**——渲染层据此各说各的话，不笼统一句"放不了"。
 * `io` 是**注入**的（不直接 `import fs`）：受控回归挂一个记调用的替身，把"没读盘"变成可证伪的事实。
 */
export function resolveVideoPreview(
  filePath: string | null | undefined,
  name: string | null | undefined,
  io: MediaReadIo,
): MediaReadOutcome {
  const fp = filePath || '';
  const ext = extOf(fp) || extOf(name);
  const mime = VIDEO_PREVIEW_MIME[ext];
  if (!mime || !fp) return { ok: false, reason: 'unsupported' };
  let size = 0;
  try {
    const st = io.statSync(fp);
    if (!st.isFile()) return { ok: false, reason: 'missing' };
    size = st.size;
  } catch { return { ok: false, reason: 'missing' }; }
  if (size > VIDEO_PREVIEW_MAX_BYTES) return { ok: false, reason: 'oversize', size, limit: VIDEO_PREVIEW_MAX_BYTES };
  return { ok: true, mime, size, base64: io.readFileSync(fp).toString('base64') };
}

/** 件大小的人读串（`1.2MB` / `834B`）。与 `im-adapter` 的 `formatBytes` 同口径——那个是私有的
 *  （且 `im-adapter.ts` 有"零 import"的既定不变量，不能反向引本模块），故此处供渲染层取用。 */
export function formatMediaSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
