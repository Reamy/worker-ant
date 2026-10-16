/**
 * zx_20260921 M2（维特根斯坦·意义即使用）: **附件的"族"与"尺寸上限"这一张表**。
 *
 * 病根（方案 §1 D2）：盘上有件、库里也记下了路径（M1 已接），但**没有任何一处按"这是什么件"分派**——
 * 图片/文档/音频进了上下文一律只是一行文字。M2 起要按族分派：图片内联、PDF 抽文本、音频转写。
 * 分派前先得有"族"这个概念，且**只能有一份**：三处（main 分派 / rr 断言 / 日后 renderer 提示）各写一份
 * 就会重演 G8/G9 那类"同一条规则的第二、第三次实现"。
 *
 * ⚠ **本模块零 import**（不引 electron / better-sqlite3 / node:*，同 `deliverable-types`/`settings-bool` 范式）：
 * ① 主进程与渲染层可跨 root 引**同一份代码**；② 受控回归可直接跑真实现。
 * 承既有纪律：**"引了"≠"打包器没摇树掉"**（`zx_20260920_1`）——新增引用后须核产物。
 *
 * ⚠ **不许再造词表**：图片的"扩展名 → MIME"真源是 `deliverable-types.ts` 的 `IMAGE_PREVIEW_MIME`，
 * 本模块**只做族归属**，不复制那张表。`MIME_TO_FAMILY` 与它量的是两件事（族 vs 具体 MIME），不是重复。
 */

export type AttachmentFamily = 'image' | 'audio' | 'video' | 'document' | 'binary';

/**
 * 图片内联上限（字节）。**10MB = 用户 2026-09-14 裁定**（方案 §5.3 D1，高于规划期建议的 4MB）。
 *
 * ⚠ 这个数字**原先写在 `deliverable-types.ts`**（`IMAGE_PREVIEW_MAX_BYTES`）。M2 需要按族取上限，
 * 若在此处再写一个 `10 * 1024 * 1024` 就有了两份——正是"改一处忘另一处、判据先假绿"的形状。
 * 故**真源挪到本模块**（零依赖，两侧都能引），`deliverable-types` 改引本模块、名字不变（对外契约不动）。
 */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 各族的**内联**字节上限。
 *
 * 取值依据（**如实标注，不假装是权威值**）：
 *   · `image` 10MB —— 用户裁定，有据。
 *   · `audio` 25MB —— 对齐 OpenAI 兼容端点的音频单件上限；本机转码到 16k 单声道 wav 后通常远小于此。
 *   · `document` 20MB —— **工程估计**（PDF 抽正文按字符数再设闸，见 `pdf-text.ts` 的 `PDF_MAX_CHARS`）。
 *   · `video` 100MB —— **用户 2026-09-24 裁定**（见下）。
 *   · `binary` 0 —— **本轮不内联**（0 是"永不内联"的可执行表达，而不是"留待调大"的占位值）。
 */
export const FAMILY_MAX_BYTES: Readonly<Record<AttachmentFamily, number>> = {
  image: IMAGE_MAX_BYTES,
  audio: 25 * 1024 * 1024,
  document: 20 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  binary: 0,
};

/**
 * 视频族的 100MB 是**两道闸里取小的那个**，两条依据都写在这里（`zx_20260924` M2）：
 *
 *   ① **内存闸**——视频**整文件**先 `readFileSync` 进内存（`attachment-inline.ts`），上限即内存上限。
 *      100MB 是"单件能安全读进主进程"的量级，再大就该让用户先剪，而不是让进程去赌。
 *   ② **转写闸**——真正喂给模型的是**音轨**，不是画面：`normalizeToWav` 转 16k 单声道 wav
 *      恒为 **32,001 B/s**（实测），而端点音频单件上限 25MB（见 `audio` 行）⇒ 音轨 ≤ ~13 分钟。
 *      即 **100MB 的视频里，能被用上的只有它的前 ~13 分钟音轨**——超过的部分不是"没内联"，
 *      是**内联了也听不到**。这一条不写进 marker（marker 说"画面未处理"，见下），
 *      但要在这里留档：**别把 100MB 读成"画面/完整视频进了上下文"**。
 *
 * 为什么不设成"更大"：本模块的 0 与 100MB 都是**可执行的判决**，不是占位。视频**不抽帧**（画面真的没进去），
 * marker 必须如实说"画面未处理"，否则用户会以为模型看过画面（`zx_20260920_1`「用了才算数」同族）。
 */

/**
 * zx_20260930 M12: **纯文本 / 源码 / 配置 / 日志**的扩展名——`doc-text.ts` 认下的那一份清单的**唯一真源**。
 *
 * 病根（方案 §2-M12「源码内联」）：`doc-text.ts` 原先自持一份 4 项的清单（`.txt/.md/.json/.csv`），
 * 用户附进来一份 `.ts` / `.yaml` / `.log`，开局一律落 `not_yet_supported`——**源码与日志恰恰是最该
 * 进上下文的东西**（工蚁的活儿大半是读码、读配置、读日志）。
 *
 * **真源为什么落这里而不是 `doc-text.ts`**：判"这件是不是文本"的第二个落点在装配层与 renderer
 * （`attachment-inline.ts` 要按族分派、`deliverable-types` 侧按扩展名取 MIME），而 `doc-text.ts` 引
 * `node:zlib`——renderer 进不去。本模块**零 import**（见文件头），两侧都引得动。
 * 下面的 `EXT_TO_FAMILY` 里这些扩展名**由本清单派生**，不手抄第二份：否则"族"与"文本清单"两张表
 * 必然各自漂移（G8/G9 老病：同一条规则的第二、第三次实现）。
 *
 * ⚠ **`.doc`/`.docx` 不在本清单**：它们是**复合/压缩容器**，要走 `doc-text.ts` 的 ZIP 解析，
 *   不是"按 UTF-8 直读"那一支。族归 `document` 但**不由本清单派生**（见下）。
 */
export const TEXT_EXTS: readonly string[] = [
  // 纯文本 / 结构化文本
  '.txt', '.md', '.markdown', '.rst', '.tex', '.csv', '.tsv', '.json', '.jsonl',
  // 源码
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.swift', '.dart', '.lua', '.r', '.pl',
  '.vue', '.svelte', '.sh', '.bash', '.zsh', '.bat', '.ps1', '.sql',
  // 配置 / 日志
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.properties', '.log', '.xml',
  // 样式
  '.css', '.scss', '.less',
];

/**
 * zx_20260930 M12: 「族上限为 0」的那些件（`binary`／认不出的扩展名）在**点名整读**时的兜底上限。
 *
 * 与族上限的**分工**（两者不是同一件事，别合并）：
 *   · `FAMILY_MAX_BYTES` 回答"**这一族**最多允许多大进上下文"，其 0 是 `binary` 行的**判决**
 *     ——「永不内联」（见上）。0 是"不内联"，**不是**"不留闸"。
 *   · `read_file` 是**点名要读这一件**（用户/模型把路径给了出来），0 在这儿会被误读成"随便读多大"。
 *     ⇒ 给"族上限为 0"的那些补一个兜底整读上限，而不是复用 0。
 *
 * 20MB 的取据：与 `document` 族同档。它回答的是同一个问题——"一件东西最多允许多大进主进程内存"——
 * 只是判不出族的那些件先前**没有落点**（旧 `read_file` 压根没有闸，见方案 §2-M12「判限口径统一」）。
 *
 * ⚠ **不许写成 `10 * 1024 * 1024`**：`rr_zx_20260921` C11 钉住该字面量在本文件**只出现一次**
 *   （图片上限的单点真源）。再写一个"数字长得一样但各管各的"就是打那颗钉的脸。
 */
export const READ_FALLBACK_MAX_BYTES: number = 20 * 1024 * 1024;

/**
 * 一次**点名整读**（`read_file`）的字节上限 —— 所有"读盘上限"的单一取数口。
 *
 * 有族上限的取族上限；族上限为 0（`binary`／认不出的扩展名）的取 `READ_FALLBACK_MAX_BYTES`。
 * `view_image` / `read_document` / 装配层各自 `maxBytesOf(familyOf(...))` 也是同一张表，
 * 差别只在"0 怎么读"——它们那里 0 是"此路不通，如实拒绝"，这里 0 是"补一个兜底再读"。
 */
export function readCapBytes(mimeOrExt: string): number {
  const cap = maxBytesOf(familyOf(mimeOrExt));
  return cap > 0 ? cap : READ_FALLBACK_MAX_BYTES;
}

/** MIME 主类型 / 常见 MIME / 裸扩展名 → 族。`MIME_TO_FAMILY` 只收有据的那些。 */
export const MIME_TO_FAMILY: Readonly<Record<string, AttachmentFamily>> = {
  'image/png': 'image', 'image/jpeg': 'image', 'image/gif': 'image',
  'image/webp': 'image', 'image/bmp': 'image', 'image/tiff': 'image',
  'audio/wav': 'audio', 'audio/x-wav': 'audio', 'audio/wave': 'audio',
  'audio/mpeg': 'audio', 'audio/mp3': 'audio', 'audio/ogg': 'audio',
  'audio/mp4': 'audio', 'audio/m4a': 'audio', 'audio/x-m4a': 'audio',
  'audio/webm': 'audio', 'audio/flac': 'audio', 'audio/aac': 'audio',
  'video/mp4': 'video', 'video/quicktime': 'video', 'video/webm': 'video',
  'video/x-msvideo': 'video', 'video/mpeg': 'video',
  'application/pdf': 'document',
  'text/plain': 'document', 'text/markdown': 'document', 'text/csv': 'document',
  'application/json': 'document',
  'application/msword': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
};

/** 裸扩展名（含点）→ 族。**只管族**；图片的具体 MIME 仍归 `IMAGE_PREVIEW_MIME`。 */
const EXT_TO_FAMILY: Readonly<Record<string, AttachmentFamily>> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image',
  '.webp': 'image', '.bmp': 'image', '.tif': 'image', '.tiff': 'image', '.svg': 'image',
  '.wav': 'audio', '.mp3': 'audio', '.ogg': 'audio', '.m4a': 'audio',
  '.flac': 'audio', '.aac': 'audio', '.opus': 'audio', '.amr': 'audio', '.silk': 'audio',
  '.mp4': 'video', '.mov': 'video', '.mkv': 'video', '.avi': 'video', '.webm': 'video',
  // `.doc`/`.docx` 是压缩容器（走 `doc-text.ts` 的 ZIP 支），`.pdf` 归 `pdf-text.ts`——
  //   三者都不在 `TEXT_EXTS`（那张表说的是"按 UTF-8 直读"），故仍**逐个写明**。
  '.pdf': 'document', '.doc': 'document', '.docx': 'document',
  // zx_20260930 M12: 纯文本/源码/配置/日志 —— **由 `TEXT_EXTS` 派生**，不手抄第二份。
  ...Object.fromEntries(TEXT_EXTS.map((e) => [e, 'document'] as const)),
};

/**
 * 判族。接受三种入参（**调用方不必先自己判断自己给的是哪种**）：
 *   MIME（`image/jpeg`）· 带点扩展名（`.jpg`）· 裸扩展名（`jpg`）。
 *
 * **不认识的 ⇒ `binary`**（而不是抛、也不是猜成图片）：不认识的件会走 `omitted` + 如实说明，
 *   这比"猜错了当图片喂给模型"诚实。承既有口径：**判型由产物本身定**（`zx_20260911_1`），不靠登记标签。
 */
export function familyOf(mimeOrExt: string): AttachmentFamily {
  const s = String(mimeOrExt ?? '').trim().toLowerCase();
  if (!s) return 'binary';
  const byMime = MIME_TO_FAMILY[s];
  if (byMime) return byMime;
  const ext = s.startsWith('.') ? s : `.${s}`;
  return EXT_TO_FAMILY[ext] ?? 'binary';
}

/** 该族的内联上限。未知族按 `binary`（0）—— 同样取"不内联"这一侧，不取"大方放行"。 */
export function maxBytesOf(family: AttachmentFamily): number {
  return FAMILY_MAX_BYTES[family] ?? 0;
}

/**
 * zx_20260930 M13-1（维特根斯坦·看它怎么做，别听它怎么说）: **魔数嗅探**——族不再只由扩展名定。
 *
 * 病根：`familyOf(ext)` 只看名字。一份 PDF 被改名成 `.bin` 就落 `not_yet_supported(binary)`
 *   （模型只看得见文件名）；一张 PNG 被平台落成无后缀就再也进不了上下文。**名字是当事人的自述，
 *   头部字节才是它此刻的样子**（承 `zx_20260911_1`「判型由产物本身定」）。
 *
 * 纪律（方案 §2-M13-1 原文）：「魔数**优先**、扩展名/MIME 冲突时**如实标记**。**不静默改用扩展名**。」
 *   ⇒ 两侧不一致时**用魔数那一侧的族**（并给装配层一句可说的冲突话）；一致时**什么都不说**——
 *   "什么都没说"在这里是一条**正面判据**（见 `rr_zx_20260930` M-f-5），不是遗漏。
 *
 * ⚠ **本函数只返回"族"与**可选**的更精确扩展名，不返回 MIME**：图片的具体 MIME 仍由
 *   `IMAGE_PREVIEW_MIME`（`deliverable-types.ts`）一张表管，这里再写一份就是 G8/G9 老病。
 *
 * ⚠ **刻意不入表的三类**（入了就是造假阳性，比不判更坏）：
 *   · **BMP（`42 4D`）/ TIFF（`49 49 2A 00`、`4D 4D 00 2A`）**：判族只能得出 `image`，而
 *     `IMAGE_PREVIEW_MIME` 里**没有**这两个 MIME ⇒ 装配层会拿空 MIME 走 `not_raster_image` 那句
 *     "非光栅格式，模型看不了"——对一张 BMP 而言这是**假话**（它是光栅，只是本机不内联它）。
 *     宁可嗅不出来（保持原扩展名判族），也不吐一句错的原因。
 *   · **裸 MPEG 帧同步 `FF Fx`**：`FF FE` 正是 **UTF-16LE BOM** ⇒ 会把 M12 刚能解码的 UTF-16 文本
 *     判成音频（**真回归**）。带 `ID3` 头的 mp3 仍认（见下），裸流不认——这是**有意的缺口**，
 *     不是遗漏。
 */
export const SNIFF_HEAD_BYTES = 16;

/** 嗅探结论：族 + **可选的**更精确扩展名（只在魔数与扩展名**不一致**时由装配层采信，见上）。 */
export interface SniffedType {
  family: AttachmentFamily;
  ext?: string;
}

/** 短于它就什么都不判：3 字节以内的头既装不下任何签名，也容易被随机数据撞上。 */
const SNIFF_MIN_BYTES = 3;

function headAt(head: Uint8Array, at: number, sig: readonly number[]): boolean {
  if (at < 0 || head.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (head[at + i] !== sig[i]) return false;
  return true;
}

/** 逐字节 `String.fromCharCode`（**不引 `Buffer`**：本模块要能被 renderer import，见文件头）。 */
function headAscii(head: Uint8Array, at: number, len: number): string {
  if (at < 0 || head.length < at + len) return '';
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(head[at + i]);
  return s;
}

/**
 * 从**头部字节**判族。说不准就 `null`（**不猜**）——`null` 的语义是"没有依据"，
 * 调用方据此保留原扩展名判出的族，**不是**把它读成 `binary`。
 */
export function sniffFileType(head: Uint8Array | null | undefined): SniffedType | null {
  if (!head || head.length < SNIFF_MIN_BYTES) return null;

  // ── 容器族：RIFF 的**真类型在偏移 8**（`RIFF????WAVE` / `RIFF????WEBP` / `RIFF????AVI `）。
  //    光看 `RIFF` 判不出族（wav/webp/avi 三种），故逐个点名；都不中 ⇒ 落到下面继续判。
  if (headAt(head, 0, [0x52, 0x49, 0x46, 0x46])) {
    if (headAt(head, 8, [0x57, 0x41, 0x56, 0x45])) return { family: 'audio', ext: '.wav' };
    if (headAt(head, 8, [0x57, 0x45, 0x42, 0x50])) return { family: 'image', ext: '.webp' };
    if (headAt(head, 8, [0x41, 0x56, 0x49, 0x20])) return { family: 'video', ext: '.avi' };
  }

  // ── ISO-BMFF（`<4字节盒长>ftyp<4字节品牌>`）：**同一个盒子既装 mp4 也装 m4a**，品牌名分族。
  //    盒长前三字节恒为 0（`ftyp` 盒本身只有 ~24 字节）⇒ 拿它当双保险，免得把 `xxxxftyp…`
  //    这种**内容里带 ftyp 四个字母的文本**误判成视频。
  if (head[0] === 0 && head[1] === 0 && head[2] === 0 && headAt(head, 4, [0x66, 0x74, 0x79, 0x70])) {
    const brand = headAscii(head, 8, 4);
    if (brand === 'M4A ' || brand === 'M4B ' || brand === 'F4A ' || brand === 'mp4a') return { family: 'audio', ext: '.m4a' };
    if (brand === 'qt  ') return { family: 'video', ext: '.mov' };
    // 品牌表外（isom/mp42/M4V…）：盒子本身就把"这是 mp4 家族"说死了 ⇒ 判 `video`，不猜 `audio`。
    return { family: 'video', ext: '.mp4' };
  }

  // ── 图片（**只列 `IMAGE_PREVIEW_MIME` 认得的那几个**，见文件头 ⚠ 关于 BMP/TIFF 的那条）────
  if (headAt(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { family: 'image', ext: '.png' };
  if (headAt(head, 0, [0xff, 0xd8, 0xff])) return { family: 'image', ext: '.jpg' };
  if (headAt(head, 0, [0x47, 0x49, 0x46, 0x38])) return { family: 'image', ext: '.gif' };

  // ── 文档 ─────────────────────────────────────────────────────────────────────
  if (headAt(head, 0, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { family: 'document', ext: '.pdf' }; // `%PDF-`
  // ZIP：**这里只说"是个 ZIP 容器"**，扩展名给 `.docx`——它是本仓**唯一**会解析的 ZIP 支
  //   （`doc-text.ts` 找不到 `word/document.xml` 会如实判 `parse_error`，不假装是 Word 文件）。
  //   真 `.docx` 走的正是这一支、且族与名一致 ⇒ 不会有冲突话（见 rr M-f-6）。
  if (headAt(head, 0, [0x50, 0x4b, 0x03, 0x04])) return { family: 'document', ext: '.docx' };
  // OLE 复合文档（`.doc`/`.xls`/`.ppt` 同一个头）——本仓只解析 `.doc`。
  if (headAt(head, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { family: 'document', ext: '.doc' };

  // ── 音频 ─────────────────────────────────────────────────────────────────────
  // `ID3` 后紧跟**版本号**（2/3/4 ⇒ ≤ 0x0F）：只有这一格能挡住"以 ID3 三个字母开头的普通文本"
  //   （`ID3v2 is a tag format…` 的第 4 字节是 `v`=0x76）。**本表唯一一处"看一眼第 4 字节"的理由。**
  if (headAt(head, 0, [0x49, 0x44, 0x33]) && head[3] <= 0x0f) return { family: 'audio', ext: '.mp3' };
  if (headAt(head, 0, [0x4f, 0x67, 0x67, 0x53])) return { family: 'audio', ext: '.ogg' };  // `OggS`
  if (headAt(head, 0, [0x66, 0x4c, 0x61, 0x43])) return { family: 'audio', ext: '.flac' }; // `fLaC`

  // ── 视频（容器级）─────────────────────────────────────────────────────────────
  // EBML（matroska 与 webm 同一个头）：**分不出 mkv 还是 webm**，故不出扩展名——族已经是"视频"了，
  //   从一个我们并不知道的事实里挑一个说法就是编。
  if (headAt(head, 0, [0x1a, 0x45, 0xdf, 0xa3])) return { family: 'video' };

  return null;
}
