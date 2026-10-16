/**
 * zx_20260930 M13-4（亚里士多德·潜能与现实）: **视频抽帧**——把"画面"从"只有音轨"里救出一截。
 *
 * 病根：视频族此前**只走音轨**（`zx_20260924` M2），marker 写着"画面未处理"——**诚实但不完整**。
 *   用户发一段屏幕录制/操作演示，模型听到的是解说词、看不到画面里到底点了什么、报了什么错。
 *
 * 方案 §2-M13-4 的三条硬约束，逐条落在这里：
 *   ① 「抽取关键帧作为 image part 送入」——产物是 `<源名>.<摘要>.frame-001.jpg`，交给
 *      `attachment-inline.ts` 按**图片**那一支送进模型（MIME 仍取 `IMAGE_PREVIEW_MIME`，不另立一份）。
 *   ② 「**依赖 M10 的"按能力配图"**」——抽不抽的**决策**在装配层（`!visionOk` ⇒ 连抽都不抽），
 *      本模块只回答"抽得出来吗"。给非视觉模型塞 8 张图 = 白烧 token + 8 次 `image_url` 400。
 *   ③ 「须有**帧数预算**与"画面未处理"的如实告知补齐」——`VIDEO_FRAME_COUNT` 是帧数闸，
 *      `VIDEO_FRAME_INTERVAL_SEC × VIDEO_FRAME_COUNT` = 覆盖窗口；**窗口之外的部分永远没看过**，
 *      这句话由装配层写进 marker（见 `attachment-inline.ts` 的 `note` 与 `windowSeconds` 的用法）。
 *
 * ⚠ **判决读产物，不读退出码**（承 `normalizeToWav` 的同一条尺，也承 `zx_20260911_1`）：
 *   退出码 0 **不等于**写出了帧（被 SIGKILL 在写盘前的 ffmpeg 会留下一个空目录）；
 *   退出码非 0 **也不等于**没写出帧（`image2` 在末帧上偶发抱怨，而文件已经落了盘）。
 *   三种组合的处置见 `extractVideoFrames` 内注释。
 *
 * ⚠ **本模块零 electron**：只用 `node:*` 与 `./audio-transcribe.js`（复用同一套 ffmpeg io / 探针缓存 /
 *   超时常量 / 目标名去重手法），故受控回归能直跑真实现——承 `audio-transcribe.ts` 文件头那条纪律。
 *   **刻意不引 `logger.ts`**：失败已由返回值如实回传，不需要第二本账。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  AUDIO_IO, FFMPEG_BIN, NORMALIZE_TIMEOUT_MS, probeFfmpeg, srcHash,
  TRANSCRIBE_TMP_DIR, type AudioTranscribeIo,
} from './audio-transcribe.js';
import { IMAGE_MAX_BYTES } from './attachment-kinds.js';

/**
 * 帧数预算：**8 帧**。
 *
 * 取据（**如实标注，不假装是权威值**）：一轮多模态请求里 8 张 JPEG 是常见实践区间内的量级；
 *   再多既撑上下文预算，又超出"看个大概"的边际收益。**不是**任何端点的官方上限。
 */
export const VIDEO_FRAME_COUNT = 8;

/**
 * 抽帧间隔（秒）。取 1/90 ⇒ 覆盖窗口 = `8 × 90 = **720 秒 = 12 分钟**`——与音轨闸
 * （`MAX_AUDIO_SECONDS = 819` 秒，见 `audio-transcribe.ts`）**同一量级**：两者都只够到前十几分钟。
 * 故 marker 里"窗口之外没看过"那句是**必须**的，不是客套。
 */
export const VIDEO_FRAME_INTERVAL_SEC = 90;

/** 覆盖窗口（秒）——**由上面两个数派生**，不手写 720（手写的那个改了帧数即漂）。 */
export const VIDEO_FRAMES_WINDOW_SEC: number = VIDEO_FRAME_COUNT * VIDEO_FRAME_INTERVAL_SEC;

/**
 * 抽帧超时：与 `normalizeToWav` 同档（`NORMALIZE_TIMEOUT_MS`）。
 * 取 8 帧比全片转码轻，但源可能躺在网络盘上、也可能是个需要重建索引的坏容器——不另设一个更小的数。
 */
export const FRAME_EXTRACT_TIMEOUT_MS: number = NORMALIZE_TIMEOUT_MS;

/** 一帧的落盘信息。**只带路径与字节数**：读它的是装配层现成的 `InlineIo.readFile`，不在这里多养一条读口。 */
export interface FrameFile {
  path: string;
  size: number;
}

/**
 * 抽帧结果。`ok:true` 里**三件事都必须带出来**（缺一件，装配层就写不出那句如实话）：
 *   `frames` 送得进去的帧 · `windowSeconds`/`intervalSeconds` 覆盖窗口 · `dropped` 被尺寸闸拦下的帧数。
 */
export type VideoFramesResult =
  | { ok: true; frames: FrameFile[]; windowSeconds: number; intervalSeconds: number; dropped: number }
  | { ok: false; reason: string };

/**
 * 抽帧要用的 io ＝ 归一化那套（`probe`/`run`/`mkdirp`/`size`）**加一项目录列举**。
 *
 * `list` 为什么必须进 io：帧数是**数出来的**，不是算出来的——短的源少出几帧，只有列目录才知道
 * 真写了几张。若改成"按 `-frames:v 8` 假定 8 张"，短源就会得到 5 个 `null` 路径（假绿的一种）。
 */
export interface FramesIo extends AudioTranscribeIo {
  list(dir: string): Promise<string[]>;
}

/** 生产缺省 io。导出是为了让判据能组合出"真实现 + 一处替身"（同 `AUDIO_IO` 的理由）。 */
export const FRAMES_IO: FramesIo = {
  ...AUDIO_IO,
  async list(dir) {
    try { return await fs.readdir(dir); } catch { return []; }
  },
};

/**
 * 抽 `src` 的帧，落在 `dstDir`。
 *
 * ffmpeg 参数（**这一串本身就是判据面**，rr M-f-11 逐项核）：
 *   `-vf fps=1/90`  —— 每 90 秒取 1 帧（`fps` 滤镜作用在**源时间基**上 ⇒ 是"源上的 90 秒"）；
 *   `-frames:v 8`   —— 帧数闸：取满 8 张就停（与 `fps` 一起把"要不要扫完整个文件"钉死）；
 *   `-f image2 -y`  —— 按 `%03d` 序号写多张 JPEG。
 *
 * ⚠ **不跑 ffprobe 探时长**：多一跳会改 `io.run` 的**调用次数**，而那是既有夹具的判据面
 *   （`rr_zx_20260921` C18 把 argv 落盘、按"跑了几次"取证）——同 `normalizeToWav` 里的那条注记。
 *   短的源自然少出几帧，由下面的**目录列举**如实数出来，不靠猜。
 */
export async function extractVideoFrames(
  src: string,
  dstDir: string,
  io: FramesIo = FRAMES_IO,
): Promise<VideoFramesResult> {
  if (!src) return { ok: false, reason: 'frames_failed: 源路径为空' };
  if (!probeFfmpeg(io)) {
    return { ok: false, reason: `ffmpeg_missing: PATH 里找不到可执行的 ${FFMPEG_BIN}（或没有执行权限）` };
  }
  // 目标名带源**绝对路径**摘要（与 `normalizeToWav` 同一手法、同一把尺）：同名不同源的件不会互相
  //   覆盖，同一件重跑落同一名字（幂等），cwd 变了也不漂。帧名前缀**同时是**下面数产物的过滤器。
  const stem = `${path.basename(src, path.extname(src))}.${srcHash(src)}.frame-`;
  const pattern = path.join(dstDir, `${stem}%03d.jpg`);
  try {
    await io.mkdirp(dstDir);
    const r = await io.run(FFMPEG_BIN, [
      '-hide_banner', '-loglevel', 'error', '-i', src,
      '-vf', `fps=1/${VIDEO_FRAME_INTERVAL_SEC}`,
      '-frames:v', String(VIDEO_FRAME_COUNT),
      '-f', 'image2', '-y', pattern,
    ], FRAME_EXTRACT_TIMEOUT_MS);

    // ── 判决①：**先数产物**。前缀带摘要 ⇒ 只认本次自己的帧（同目录里别的任务/别的源的帧不算数，
    //   zx-20260929 M3「用完就收」把这些产物按 taskId 分目录，故同目录确实会有别人的东西）。
    const names = (await io.list(dstDir))
      .filter((n) => n.startsWith(stem) && n.endsWith('.jpg'))
      .sort();
    const empty = (dropped: number): VideoFramesResult => ({
      ok: true, frames: [], windowSeconds: VIDEO_FRAMES_WINDOW_SEC,
      intervalSeconds: VIDEO_FRAME_INTERVAL_SEC, dropped,
    });
    if (names.length === 0) {
      // 0 产物：四种来路**各说各的真因**，不挤成一句"抽不了"。
      if (r.error) return { ok: false, reason: `frames_failed: ffmpeg 起不来: ${r.error}` };
      if (r.timedOut) return { ok: false, reason: `frames_failed: 抽帧超时（${FRAME_EXTRACT_TIMEOUT_MS / 1000}s）` };
      if (r.code !== 0) {
        return { ok: false, reason: `frames_failed: ffmpeg 退出码 ${r.code}: ${(r.stderr ?? '').trim().slice(0, 300)}` };
      }
      // 退出码 0 且一帧没写出来：**源里没有可解码的画面**（纯音频流 / 坏容器 / 空文件）。
      //   这不是故障，是"这批字节里没有画面"——如实报**空集**，由装配层说"未抽到帧"。
      return empty(0);
    }

    // ── 判决②：有产物就是**成了**，退出码非 0 只是"末帧上抱怨了一句"（见文件头 ⚠）。
    //   回查每一帧的字节数：单帧撞上图片内联上限（10MB，一张 8K 静帧真够得着）就**不进上下文**
    //   并计数——丢的是这一帧，不是整件（其余帧照送，`dropped` 由装配层如实带出）。
    const frames: FrameFile[] = [];
    let dropped = 0;
    for (const n of names) {
      const fp = path.join(dstDir, n);
      const size = await io.size(fp);
      if (size === null || size === 0 || size > IMAGE_MAX_BYTES) { dropped++; continue; }
      frames.push({ path: fp, size });
    }
    if (frames.length === 0) return empty(dropped);
    return {
      ok: true, frames, windowSeconds: VIDEO_FRAMES_WINDOW_SEC,
      intervalSeconds: VIDEO_FRAME_INTERVAL_SEC, dropped,
    };
  } catch (e) {
    return { ok: false, reason: `frames_failed: ${(e as Error)?.message || String(e)}` };
  }
}

/**
 * 把 `InlineIo.extractFrames` 这个形状接到真件上（与 `makeAudioTranscriber` **同一形状、同一理由**：
 * 纯组合、零重依赖 ⇒ 受控回归跑的是生产真走的那个函数，不是照抄的等价物）。
 *
 * ⚠ 落点与音轨共用 `TRANSCRIBE_TMP_DIR`（按 taskId 分子目录）：任务收口时 `cleanTranscribeTmp`
 *   整目录删掉，**帧与 wav 一起收**，不多养一处收尾。落 `os.tmpdir()` 而**不落 `data/attachments/`**
 *   ——后者是**入站原件**的目录，往里塞派生物会让"哪些是用户给的件"失真（M1 约定）。
 */
export function makeFrameExtractor(
  dstDir: string = TRANSCRIBE_TMP_DIR,
  io?: FramesIo,
): (p: string) => Promise<VideoFramesResult> {
  return (p: string) => extractVideoFrames(p, dstDir, io);
}
