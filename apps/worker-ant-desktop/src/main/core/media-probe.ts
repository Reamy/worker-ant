/**
 * zx_20261018_2 批二（管子·度量衡 / 维特根斯坦·一个规则一处）: **媒体时长的唯一探针**。
 *
 * 病根：`probeAudioDurationSec` 原先藏在 `audio-transcribe.ts` 里（长音频切段要用），而视频抽帧
 *   **刻意不探时长**（旧注记："多跑一次 ffmpeg 会改既有夹具 `io.run` 的调用次数"）——于是
 *   `8 帧 × 90 秒 = 720 秒` 成了**固定覆盖窗口**，12 分钟之后的画面永远没被看过。
 *   批二让视频也需要"这一次到底多长"，同一件事就有两个调用方 ⇒ 探针搬到这里**一处实现**。
 *
 * ⚠ **为什么这里是动态 `import('./audio-transcribe.js')`**：`FFMPEG_BIN` / `PROBE_TIMEOUT_MS` /
 *   `AUDIO_IO` 的**真源**在 `audio-transcribe.ts`（不许抄第二份）；而音频侧现在反过来要引用本模块的
 *   `probeMediaDurationSec` ⇒ 静态互引就是一个运行时环。把值放在**函数体内**动态取，模块图仍是单向的，
 *   且 Node 会缓存该 import，每次探针只是多一次查表。类型引用仍是静态 `import type`（编译期擦除）。
 *
 * ⚠ **不引 ffprobe**：ffmpeg 是这套流程唯一的外部可执行。`ffmpeg -i <src>` 不带输出时退出码为 1，
 *   但元数据已经打在 stderr 上；`io.run` 本来就收 stderr，故读数不需要第二条通道、也不需要第二件农具。
 */
import type { AudioTranscribeIo } from './audio-transcribe.js';

/** ffmpeg 读时长的那一行（`Duration: 00:25:00.00`）。 */
const FFMPEG_DURATION_RE = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;

/**
 * 从 ffmpeg 的 stderr 里读时长（秒）；读不出 ⇒ `null`。
 * 导出是为了让判据能**只测读数**（不跑进程）：`hh:mm:ss` 三段换算 + 小数秒。
 */
export function parseFfmpegDuration(stderr: string | undefined): number | null {
  if (!stderr) return null;
  const m = FFMPEG_DURATION_RE.exec(stderr);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * 源媒体时长（秒）；读不出 ⇒ `null`（**说不出来就说不知道**，不按文件名/体积猜）。
 *
 * `io` 缺省用 `AUDIO_IO`（真 spawn）。判据注入桩 io ⇒ 不依赖"本机恰好装了 ffmpeg"。
 */
export async function probeMediaDurationSec(
  src: string,
  io?: AudioTranscribeIo,
): Promise<number | null> {
  if (!src) return null;
  const { FFMPEG_BIN, PROBE_TIMEOUT_MS, AUDIO_IO } = await import('./audio-transcribe.js');
  const eff = io ?? AUDIO_IO;
  const r = await eff.run(FFMPEG_BIN, ['-hide_banner', '-i', src], PROBE_TIMEOUT_MS);
  return parseFfmpegDuration(r.stderr);
}
