/**
 * zx_20260921 M4（D1「附件落盘 → 上下文」断的那一截之音频段）：音频件 → 文字。
 *
 * 两件事**分开说**，因为它们的失败不是一回事，混成一句就是失实：
 *   - `normalizeToWav`：把任意音频归一成 16k 单声道 wav。靠**外部可执行** ffmpeg。
 *   - `transcribeAudio`：把 wav 交给 ANS 选出的 `audio` 能力模型，要它吐文字。
 * 本机没农具就说没农具（`ffmpeg_missing`）——**别把"没装 ffmpeg"说成"这段音频没内容"**。
 *
 * ⚠ ffmpeg **不进 `package.json`、不进 build 钉**：它是外部可执行文件，不是 npm 依赖；进包会让
 *   `scripts/rebuild-ans-native.sh` 的 Node/Electron ABI 切换多一个面。同理本文件**不新增任何依赖**。
 *   （本机 `/usr/local/bin/ffmpeg` 存在，但这**不构成**任何判据的前提——见下。）
 *
 * ⚠ **本模块零 electron 依赖**（只用 `node:*`、`./model-request.js` 与**零 import** 的
 *   `./attachment-kinds.js`），故受控回归能直跑真实现——同 `memory-manager.ts` / `model-request.ts`
 *   的既有手法。也**刻意不引 `logger.ts`**：pino 会拖进 transport 与日志目录，是 rr 直跑真实现的
 *   无谓负担；失败已由返回值如实回传，不需要第二本账。
 *
 * ⚠ **判据不许依赖"本机恰好装了 ffmpeg"**（否则换台机器就假红/假绿）：`io` / `deps` 全部可注入，
 *   且探针缓存**按 io 对象分别存**（见 `probeCache`）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveChatCompletionsUrl } from '@worker-ant/ans-client';

import { buildModelRequest, describeModelSelectionFailure } from './model-request.js';
import { probeMediaDurationSec } from './media-probe.js';
// zx_20260930 M12: 音轨闸的两把尺都**由真源派生**（族上限那张表），不在这里另写 25MB / 13 分钟。
import { FAMILY_MAX_BYTES } from './attachment-kinds.js';

/** ffmpeg 可执行文件；env 覆盖口是给 rr 注入假件用的（真路径不进码） */
export const FFMPEG_BIN: string = process.env.WA_FFMPEG_BIN?.trim() || 'ffmpeg';

export const PROBE_TIMEOUT_MS: number = 5_000;
export const NORMALIZE_TIMEOUT_MS: number = 60_000;
export const TRANSCRIBE_TIMEOUT_MS: number = 120_000;
export const DEFAULT_MAX_OUTPUT_TOKENS: number = 2048;

/**
 * zx_20261018_1 批六：长音频分段转写。
 *
 * 短路径（≤ `MAX_AUDIO_SECONDS` ≈ 13.6 分钟）**逐字不变**：一次归一化 + 一次转写。
 * 超过单段上限的音频才走长路径：ffmpeg 按 `LONG_SEGMENT_SECONDS` 切段、逐段转写、
 * 按 `[mm:ss]` 边界标记合并。总时长上限 `LONG_MAX_SECONDS`——超过即**如实拒**，
 * 不无限切段吃盘（3 小时录成 wav ≈ 345MB，切出 18 段已是这套流程能承受的上界）。
 */
export const LONG_SEGMENT_SECONDS: number = 600;
export const LONG_MAX_SECONDS: number = 3 * 60 * 60;
/** 3 小时音频的切段解码是重活，不能沿用短路径的 60s */
export const SEGMENT_TIMEOUT_MS: number = 30 * 60_000;

/** 超时后先礼后兵：SIGTERM 之后给宽限，再 SIGKILL（同 `shell-exec.ts`） */
const KILL_GRACE_MS = 2_000;
/** stderr 只留够定位问题的头一段；ffmpeg 出错能刷出几百行 */
const MAX_STDERR_CHARS = 2_000;

/**
 * 向 ANS 要"能干音频的模型"的能力词。
 *
 * ⚠ **它住在这里是裁定，不是"迁就现状"**（zx_20261002 M15 复核）：`model-request.ts` M15 起**已有**
 *   按附件族驱动的能力槽位（`ATTACHMENT_FAMILY_CAPABILITIES`），但那张表说的是"**执行模型**需具备
 *   什么"——而音频**不经执行模型**（`attachment-inline.ts` 先本地转写成文字再喂），故其 `audio` 行
 *   **刻意留空**。本模块是"要一个能收音频的模型"这一跳的**唯一责任人**，`AUDIO_CAPABILITY` 就该
 *   住在这里、**不回迁** `model-request.ts`（迁过去等于把"音频走专用跳"这条正确分路，抹平成表里一行）。
 *   另**同时作为 rr 判据 C19 的取数口**（判据从这里 import，不在夹具里手抄 `'audio'`，否则断言证的是夹具自己）。
 *
 * **这个词指什么**（zx_20260921_1 M4 定死的语义；权威字据在 `packages/shared-types/src/models.ts`
 *   的 `AUDIO_CAPABILITY_SEMANTICS`，此处**逐字复述同一句**，改一处即须改另一处）：
 *   `audio` = 能在 chat/completions 请求里接收音频输入。
 *
 * **据此明确不登记**（登记了就是把下面这些选进转写器，全是假阳性）：
 *   - 只有 `/v1/audio/transcriptions` **专用转写口**的（如 Voxtral）——不收 chat 形状的音频 part；
 *   - 走 **WebSocket realtime** 通道的（如 Grok Voice）——不是 `chat/completions`；
 *   - **合成方向**的（各家 TTS）——音频是**输出**，不是输入。
 *   公开资料互相矛盾、未实测的（gpt-5.5 / glm-5.2）**不打标**，留白待实测，不替用户选边。
 */
export const AUDIO_CAPABILITY: string = 'audio';

/**
 * 转写指令。**"听不清就写 [听不清]"不是客套**：转写模型对噪声段的默认行为是**顺着语气编一句通顺的**，
 * 而下游拿它当用户原话读。宁可留空标记，不可补全。
 */
const TRANSCRIBE_PROMPT =
  '请把这段音频转成文字，只输出转写结果，不要解释、不要加说话人标注。听不清的片段写 [听不清]，不要猜测内容。';

export interface FfmpegRun {
  code: number | null;
  timedOut: boolean;
  /** spawn **本身**失败（二进制不存在/无执行权限）；与"进程跑起来但退出码非 0"是两回事 */
  error?: string;
  stderr?: string;
}

export interface AudioTranscribeIo {
  /** ffmpeg 是否真跑得起来（**同步**：`probeFfmpeg` 的签名就是同步的） */
  probe(bin: string): boolean;
  /**
   * 跑一次 ffmpeg 直到退出。
   * ⚠ 异步而非 `execSync`：引擎整个跑在 Electron 主进程里，同步等一次转码＝窗口这几十秒不重绘
   *   （`shell-exec.ts` 头注释的实测：22.83s 命令 ⇒ 事件循环 maxLag=22818ms）。
   */
  run(bin: string, args: string[], timeoutMs: number): Promise<FfmpegRun>;
  mkdirp(dir: string): Promise<void>;
  /** 文件字节数；不存在或读不到返回 null */
  size(p: string): Promise<number | null>;
  /** 删掉一个临时文件（长音频切段的「用后即删」；失败不抛） */
  remove(p: string): Promise<void>;
}

/**
 * 生产缺省的 io（真 spawn / 真 stat）。
 *
 * **导出**是为了让判据能**组合**出"真实现 + 一处替身"的 io——
 * 例如 `{ ...AUDIO_IO, probe: () => true }` 配一个真 shell 桩冒充 ffmpeg：
 * 这样 `normalizeToWav` 走的仍是生产那份 spawn/超时/收 stderr 的实现，
 * 只是"ffmpeg 这个可执行"被换成了确定性的桩。**判据不自我印证**（承本轮 §7 头号风险）。
 */
export const AUDIO_IO: AudioTranscribeIo = {
  probe(bin) {
    try {
      const r = spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS });
      return r.status === 0 && !r.error;
    } catch {
      return false;
    }
  },
  run(bin, args, timeoutMs) {
    return new Promise<FfmpegRun>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (e) {
        resolve({ code: null, timedOut: false, error: (e as Error)?.message || String(e) });
        return;
      }
      let stderr = '';
      let timedOut = false;
      let killTimer: NodeJS.Timeout | null = null;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* 已经退出了 */ }
        killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已经退出了 */ } }, KILL_GRACE_MS);
      }, timeoutMs);
      child.stderr?.on('data', (d: Buffer) => {
        if (stderr.length >= MAX_STDERR_CHARS) return;
        stderr += d.toString().slice(0, MAX_STDERR_CHARS - stderr.length);
      });
      const finish = (code: number | null, error?: string) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve({ code, timedOut, error, stderr });
      };
      child.on('error', (e: Error) => finish(null, e.message));
      child.on('close', (code: number | null) => finish(code));
    });
  },
  async mkdirp(dir) { await fs.mkdir(dir, { recursive: true }); },
  async size(p) {
    try { return (await fs.stat(p)).size; } catch { return null; }
  },
  async remove(p) {
    try { await fs.rm(p, { force: true }); } catch { /* 清理失败不影响转写结果 */ }
  },
};

/**
 * 探针结果缓存，**按 io 对象分别存**（WeakMap）。
 *
 * 为什么不干脆一个全局布尔：注入桩是测试替身，把它的答案缓存成全局的，同进程里"先问假件、再问真件"
 * 就会拿到上一次的答案——假绿与假红都从这儿来。默认 io 是**单例对象**，故生产侧"一个批次只探一次"
 * （而不是每件音频 spawn 一次 `ffmpeg -version`）的省法照旧成立。
 */
const probeCache = new WeakMap<AudioTranscribeIo, Map<string, boolean>>();

export function probeFfmpeg(io: AudioTranscribeIo = AUDIO_IO): boolean {
  let perIo = probeCache.get(io);
  if (!perIo) {
    perIo = new Map();
    probeCache.set(io, perIo);
  }
  const hit = perIo.get(FFMPEG_BIN);
  if (hit !== undefined) return hit;
  let ok = false;
  // 探针自己抛（桩返回怪东西/权限异常）也按"没有"处理：探针的意义是回答"能用吗"，不是报告为什么不能。
  try { ok = io.probe(FFMPEG_BIN) === true; } catch { ok = false; }
  perIo.set(FFMPEG_BIN, ok);
  return ok;
}

/**
 * 源路径的短摘要，供目标名去重（见 `normalizeToWav`）。
 *
 * **导出**供 `video-frames.ts` 复用（zx_20260930 M13-4）：视频的帧文件名要与它的 wav 用**同一把**
 *   去重尺，否则"同一件视频的两批产物"会在 `os.tmpdir()` 里各留一份、且名字对不上。
 *   抄一份等价实现就是本仓反复记过的"同一条规则的第二次实现"（G8/G9）。
 */
export function srcHash(src: string): string {
  return createHash('sha1').update(path.resolve(src)).digest('hex').slice(0, 8);
}

/**
 * 归一化产物（16k 单声道 16bit wav）的**每秒钟字节数**：16000 Hz × 1 ch × 2 B = **32,000 B/s**。
 *
 * ⚠ 这与 `attachment-kinds.ts` 头注释里写的"32,001 B/s（实测）"**不是矛盾**：那个数是"44 字节 RIFF 头
 *   ÷ 1 秒"凑出来的含头实测值；这里要的是**斜率**（每多一秒多多少字节），取整 32,000。44 字节是**常数**、
 *   不随时长增长，故两者只在 ~1 秒处相等。
 */
export const WAV_BYTES_PER_SEC = 32_000;

/** 音轨允许送进转写的**字节上限** ＝ 该族上限（`attachment-kinds.FAMILY_MAX_BYTES.audio`，25MB）。 */
export const AUDIO_CAP_BYTES: number = FAMILY_MAX_BYTES.audio;

/**
 * 由上面两个数**派生**的音轨时长上限（秒）——**不再手写一个"13 分钟"**（手写的那个换了族上限即漂）。
 * 25MB ÷ 32,000 B/s = **819 秒 ≈ 13.6 分钟**。
 */
export const MAX_AUDIO_SECONDS: number = Math.floor(AUDIO_CAP_BYTES / WAV_BYTES_PER_SEC);

/**
 * 把 `src` 归一成 16k 单声道 wav，落在 `dstDir`，返回**实际产物路径**。
 * 失败一律 `ok:false`：`ffmpeg_missing`（没这个可执行）/ `normalize_failed`（起不来、退出码非 0、超时、没产物、产物超限）。
 *
 * zx_20260930 M12（音轨闸）：**加 `-t`（时长上限）与产物体积上限**。此前 ffmpeg 参数里没有任何时长限制
 *   ——一件 3 小时的录音会先被转成 ~345MB 的 wav 落盘，再原样交给端点（端点音频单件上限 25MB）⇒
 *   要么端点拒、要么**半个文件被静默送走**。"送走一半"比"送不出去"更坏：模型会拿前半段当整段总结。
 *   故这道闸的裁定是：**按上限截断，并把"截了"这件事如实带出去**（`truncated`，由调用方写进 marker）。
 */
export async function normalizeToWav(
  src: string,
  dstDir: string,
  io: AudioTranscribeIo = AUDIO_IO,
): Promise<
  | { ok: true; path: string; truncated: boolean; capSeconds: number }
  | { ok: false; reason: string; detail?: string }
> {
  if (!src) return { ok: false, reason: 'normalize_failed', detail: '源路径为空' };
  if (!probeFfmpeg(io)) {
    return { ok: false, reason: 'ffmpeg_missing', detail: `PATH 里找不到可执行的 ${FFMPEG_BIN}（或没有执行权限）` };
  }
  // 目标名带源**绝对路径**的摘要：`a.mp3` 与 `a.m4a` 归一到同一目录会都叫 `a.wav`，后者把前者**静默覆盖**
  // ⇒ 两件音频抢一份转写结果。由绝对路径派生 ⇒ 同一件重跑落同一名字（幂等），cwd 变了也不漂。
  const dst = path.join(dstDir, `${path.basename(src, path.extname(src))}.${srcHash(src)}.wav`);
  try {
    await io.mkdirp(dstDir);
    const r = await io.run(
      FFMPEG_BIN,
      // `-t` 是**输出**侧选项（必须排在 `-i <源>` 之后），只用截断产物、不改时间轴。
      ['-hide_banner', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', '16000', '-t', String(MAX_AUDIO_SECONDS), '-f', 'wav', '-y', dst],
      NORMALIZE_TIMEOUT_MS,
    );
    if (r.error) return { ok: false, reason: 'normalize_failed', detail: `ffmpeg 起不来: ${r.error}` };
    if (r.timedOut) return { ok: false, reason: 'normalize_failed', detail: `转码超时（${NORMALIZE_TIMEOUT_MS / 1000}s）` };
    if (r.code !== 0) {
      return { ok: false, reason: 'normalize_failed', detail: `ffmpeg 退出码 ${r.code}: ${(r.stderr ?? '').trim().slice(0, 300)}` };
    }
    // 退出码 0 **不等于**写出了东西：假件（或被 SIGKILL 在写盘前的 ffmpeg）会留下 0 字节/不存在的文件，
    // 拿它去转写等于把"没转成"说成"音频没内容"。故必须回查产物。
    const size = await io.size(dst);
    if (!size) return { ok: false, reason: 'normalize_failed', detail: `ffmpeg 退出码 0 但产物不存在或为空: ${dst}` };
    // 体积闸：`-t` 之外再回查一次，是防"`-t` 没被这份 ffmpeg 认下 / 源容器时长元数据有假"——上界由
    //   **产物本身**决定，而不是由我们发给 ffmpeg 的那个数决定（承 `zx_20260911_1`「判型由产物本身定」）。
    if (size > AUDIO_CAP_BYTES) {
      return {
        ok: false,
        reason: 'normalize_failed',
        detail: `转码产物 ${size} 字节超过 ${AUDIO_CAP_BYTES} 字节上限（${MAX_AUDIO_SECONDS}s × ${WAV_BYTES_PER_SEC} B/s）`,
      };
    }
    // 「有没有被截断」的推断：wav 体积随时长**线性**增长（固定码率）⇒ 体积抵到 `-t` 那一档，源就至少有
    //   那么长。**刻意不再跑一次 ffprobe 探源时长**：`io.run` 的**调用次数**是既有夹具的判据面
    //   （`rr_zx_20260921` C18 把 argv 落盘、按"跑了几次"取证），多一跳会打乱它。
    // ⚠ 这是**推断不是读数**：源恰好 819 秒时我们也会说"可能被截"——调用方写 marker 时按"可能"措辞。
    const truncated = size >= MAX_AUDIO_SECONDS * WAV_BYTES_PER_SEC;
    return { ok: true, path: dst, truncated, capSeconds: MAX_AUDIO_SECONDS };
  } catch (e) {
    return { ok: false, reason: 'normalize_failed', detail: (e as Error)?.message || String(e) };
  }
}

// zx_20261018_2 批二：时长探针搬到 `media-probe.ts`（视频抽帧也要用同一件事）。
//   本模块**只做长路径的调用方**，不再私藏一份实现。⚠ 只在**长路径**里调用：短路径多跑一次 ffmpeg
//   会改既有夹具的调用次数面（`rr_zx_20260921` C18）。

/**
 * 段边界标记 `[mm:ss]`：偏移分钟数不封顶（3 小时 ⇒ `[180:00]`），与 R-50 的 `[00:00]/[10:00]/[20:00]` 同一把尺。
 */
export function formatSegmentMarker(offsetSec: number): string {
  const mm = Math.floor(offsetSec / 60);
  const ss = offsetSec % 60;
  return `[${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}]`;
}

/**
 * 长音频：切 10 分钟/段 → 逐段转写 → 按 `[mm:ss]` 合并。
 *
 * 失败一律 `ok:false` 且**说得出断在哪一段**；某段失败**不把前面段冒充全文成功**（R-51）。
 * 临时段文件**用后即删**（成功与失败两条路都删，R-53）。
 * 总时长超上限**在切段之前**就拒（R-54）——先切再拒等于让盘先吃掉 3 小时×32KB/s。
 */
export async function transcribeLongAudio(
  src: string,
  dstDir: string,
  deps: TranscribeDeps,
  io: AudioTranscribeIo = AUDIO_IO,
): Promise<{ ok: true; text: string; segments: number } | { ok: false; reason: string; detail?: string }> {
  if (!src) return { ok: false, reason: 'normalize_failed', detail: '源路径为空' };
  if (!probeFfmpeg(io)) {
    return { ok: false, reason: 'ffmpeg_missing', detail: `PATH 里找不到可执行的 ${FFMPEG_BIN}（或没有执行权限）` };
  }
  const duration = await probeMediaDurationSec(src, io);
  if (duration === null) {
    return {
      ok: false,
      reason: 'duration_unknown',
      detail: `ffmpeg 读不出 ${path.basename(src)} 的时长，无法按 ${LONG_SEGMENT_SECONDS / 60} 分钟分段转写`,
    };
  }
  if (duration > LONG_MAX_SECONDS) {
    return {
      ok: false,
      reason: 'audio_too_long',
      detail: `音频约 ${Math.ceil(duration / 60)} 分钟，超过上限 ${Math.ceil(LONG_MAX_SECONDS / 60)} 分钟（3 小时）——请先切分再发`,
    };
  }
  const segments = Math.max(1, Math.ceil(duration / LONG_SEGMENT_SECONDS));
  const stem = `${path.basename(src, path.extname(src))}.${srcHash(src)}.seg`;
  const segPaths = Array.from({ length: segments }, (_, i) =>
    path.join(dstDir, `${stem}${String(i).padStart(3, '0')}.wav`));
  const clean = async (): Promise<void> => {
    for (const p of segPaths) await io.remove(p);
  };
  try {
    await io.mkdirp(dstDir);
  } catch (e) {
    return { ok: false, reason: 'segment_failed', detail: (e as Error)?.message || String(e) };
  }
  const r = await io.run(FFMPEG_BIN, [
    '-hide_banner', '-loglevel', 'error', '-i', src,
    '-ac', '1', '-ar', '16000',
    '-f', 'segment', '-segment_time', String(LONG_SEGMENT_SECONDS), '-reset_timestamps', '1',
    path.join(dstDir, `${stem}%03d.wav`),
  ], SEGMENT_TIMEOUT_MS);
  if (r.error) {
    await clean();
    return { ok: false, reason: 'segment_failed', detail: `ffmpeg 起不来: ${r.error}` };
  }
  if (r.timedOut) {
    await clean();
    return { ok: false, reason: 'segment_failed', detail: `切段超时（${SEGMENT_TIMEOUT_MS / 1000}s）` };
  }
  if (r.code !== 0) {
    await clean();
    return { ok: false, reason: 'segment_failed', detail: `ffmpeg 退出码 ${r.code}: ${(r.stderr ?? '').trim().slice(0, 300)}` };
  }

  const parts: string[] = [];
  for (let i = 0; i < segments; i++) {
    const seg = segPaths[i]!;
    const tr = await transcribeAudio(seg, deps);
    await io.remove(seg); // 用后即删：不让 3 小时的段文件在盘上躺到任务收口
    if (!tr.ok) {
      await clean();
      return {
        ok: false,
        reason: 'segment_failed',
        detail: `第 ${i + 1} 段转写失败：${tr.detail ?? tr.reason}`,
      };
    }
    parts.push(`${formatSegmentMarker(i * LONG_SEGMENT_SECONDS)} ${tr.text}`);
  }
  await clean();
  return { ok: true, text: parts.join('\n'), segments };
}

export interface AudioEndpoint {
  url: string;
  api_key: string;
  model_name: string;
  max_output_tokens?: number;
}

/**
 * zx_20260921_1 M2: 选型**失败**——与"选出来了"不同的第三种结果。
 *
 * 为什么要单独一个形状：ANS 零命中回的是 `{error:{code,message,diagnostics}}`（HTTP 200）。
 * 早先适配层拿它当**模型对象**收，`url` 自然取不到 ⇒ 返回 `null` ⇒ 四种成因在桌面侧
 * **全挤成同一句"无 audio 能力模型可给"**。成因不是我们发明的，是 ANS 说的；把它原样带出来即可。
 */
export interface ModelSelectionFailure {
  error: string;
}

export interface TranscribeDeps {
  /**
   * 选型。生产传入 `ansClient.getOptimalModel`——**同一条** ANS 选型路，不另开一条。
   * 返回 null / 字段不齐 ＝ "无 `audio` 能力模型可给"，**这是如实结论而非异常**，须落 `transcribe_failed`。
   * 返回 `{error}` ＝ 选型口**说得出为什么**（M2），其文本直接作为 `detail`。
   */
  selectModel(req: Record<string, unknown>): Promise<AudioEndpoint | null | undefined | ModelSelectionFailure>;
  /** 提交转写；缺省 = 直接打端点的 OpenAI 兼容口（`postChatCompletion`） */
  chat?(
    endpoint: AudioEndpoint,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{ ok: true; text: string } | { ok: false; detail: string }>;
  /** 读音频字节；缺省 = `node:fs/promises` */
  readFile?(p: string): Promise<Buffer>;
  timeoutMs?: number;
}

/**
 * 选型请求：**走 `model-request.ts` 的真源组装**（底线能力、策略键、`maxCostPer1k` 在场性都由它定），
 * 本模块只在其上**追加** `audio`。C19 要防的正是"另抄一份请求形状"——那样夹具证的是夹具自己。
 */
export function buildAudioModelRequest(): Record<string, unknown> {
  const base = buildModelRequest({ archetype: 'conversation', strategy: 'cost-optimal' });
  const caps = Array.isArray(base.capabilities) ? (base.capabilities as string[]) : [];
  return { ...base, capabilities: [...caps, AUDIO_CAPABILITY] };
}

// zx_20261018_2 批一: `describeModelSelectionFailure` 已迁入零依赖的 `model-request.ts`
//   （视觉子调用同引一份措辞）。本文件从那里 import，**不另写实现**；rr 的取数口一并重定向
//   到真源模块（承「改旧断言＝改钉更强的新真源」——不删、不放宽）。

/** OpenAI `input_audio.format` 只认 wav/mp3（`@ai-sdk/openai` 对 audio/wav|audio/mp3|audio/mpeg 的映射同此） */
function audioFormatOf(p: string): 'wav' | 'mp3' {
  return p.toLowerCase().endsWith('.mp3') ? 'mp3' : 'wav';
}

/**
 * `input_audio.data` 的 data URL 前缀。**逐字照抄实测通过的那一个**——
 * 不是 `data:audio/wav;base64,`（那个没跑过，是否被收下**未知**）。
 */
export const AUDIO_DATA_URL_PREFIX = 'data:;base64,';

/**
 * **已知要求 data URL 前缀**（即：把 `input_audio.data` 当 **URL** 解析）的接收方 host。
 *
 * ⚠ 这张表说的是**接收方的属性**，不是我们的偏好——故**只收实测过的**：
 *   `dashscope.aliyuncs.com` 于 2026-09-21 用真语音 + 真 Key 跑过两支对照
 *   （裸 base64 ⇒ HTTP 400 `InternalApiError`/`URL does not appear to be valid`；加前缀 ⇒ HTTP 200 且逐字转写正确）。
 *   **没跑过的 host 一律不列**——列进去就等于替它下结论（承 §1.2：只用"该命中"标本验证，任何过宽变体都会全票通过）。
 */
export const AUDIO_DATA_URL_HOSTS: readonly string[] = ['dashscope.aliyuncs.com'];

/** 端点 host（小写）。url 解析不出来返回空串——**说不出来就说不知道**，不猜。 */
function hostOf(endpoint: AudioEndpoint): string {
  try { return new URL(endpoint.url).hostname.toLowerCase(); } catch { return ''; }
}

export type AudioDataShape = 'data-url' | 'raw';

/**
 * `input_audio.data` 该长什么样 —— **由接收方定**（维特根斯坦 §43：意义即用法。
 * 这个字段的"意义"不是"音频的 base64"，而是**接收方会拿它做什么**：DashScope 拿它当 URL 解析，那它就是 URL）。
 *
 * 缺省 `'raw'`（**保守默认 = OpenAI 官方形状**）：OpenAI `gpt-4o-audio-preview` 要的就是裸 base64，
 * 一律加前缀会把 OpenAI 家族打坏。**形状是接收方的属性，不是我们的偏好。**
 */
export function audioDataShapeOf(endpoint: AudioEndpoint): AudioDataShape {
  const h = hostOf(endpoint);
  return h !== '' && AUDIO_DATA_URL_HOSTS.includes(h) ? 'data-url' : 'raw';
}

/**
 * 把音频字节变成 `input_audio` part —— **唯一一处**做这件事的地方。
 *
 * ⚠ 判据不许在夹具里另写一份等价物（那证的是夹具自己）：`rr_zx_20260921.ts` C19 与
 *   `rr_zx_20260921_1.ts` C1–C3 都**调这个函数**，期望形状则由 `audioDataShapeOf` 现算。
 */
export function buildInputAudioPart(
  endpoint: AudioEndpoint,
  bytes: Buffer,
  format: 'wav' | 'mp3',
): { type: 'input_audio'; input_audio: { data: string; format: string } } {
  const b64 = bytes.toString('base64');
  const data = audioDataShapeOf(endpoint) === 'data-url' ? `${AUDIO_DATA_URL_PREFIX}${b64}` : b64;
  return { type: 'input_audio', input_audio: { data, format } };
}

/**
 * "错误体像不像『你给的不是一个合法 URL』"——**只认已见过的几个特征串**，不做语义推断，不猜。
 * 特征取自 2026-09-21 那条真 400：`The provided URL does not appear to be valid. Ensure it is correctly formatted.`
 */
const URL_SHAPED_ERROR_MARKERS: readonly string[] = [
  'does not appear to be valid',
  'invalid url',
  'url is not valid',
  'invalidurl',
];

/**
 * 端点拒收时，若错误体像"URL 不合法"且我们发的是**裸 base64** ⇒ 追加一句提示。
 *
 * ⚠ 三条纪律：
 *   1. **提示不是结论**——文案自己就说破了。我们不"装作知道"，也不静默（承本模块头注释的失败分流纪律）。
 *   2. 原错误体**原样在前**（`detail` 已带），提示只**追加**——判别信号不能被我方文案淹掉。
 *   3. 判据取自**载体自身**：形状问 `audioDataShapeOf`，不在这条分支里另抄一份 host 判断
 *      （`AUDIO_DATA_URL_HOSTS` 是唯一的 host 真源，故 `'raw'` ⟺ "host 不在已知表里"）。
 */
function withDataUrlHint(endpoint: AudioEndpoint, detail: string, rawBody: string): string {
  if (audioDataShapeOf(endpoint) !== 'raw') return detail;
  const low = rawBody.toLowerCase();
  if (!URL_SHAPED_ERROR_MARKERS.some((m) => low.includes(m))) return detail;
  return `${detail}（该接收方可能要求 \`${AUDIO_DATA_URL_PREFIX}\` 前缀——这是提示，不是结论）`;
}

/**
 * 默认提交口：端点的 OpenAI 兼容 chat/completions。
 */
async function postChatCompletion(
  endpoint: AudioEndpoint,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ ok: true; text: string } | { ok: false; detail: string }> {
  const url = resolveChatCompletionsUrl(endpoint.url);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.api_key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    // 错误体照抄前 300 字：端点不收 `input_audio` 时，判别信号就藏在这段里（如 `unknown variant`），
    // 截没了就只能靠猜"是端点不收还是我发错了"。
    if (!res.ok) return { ok: false, detail: withDataUrlHint(endpoint, `HTTP ${res.status}: ${raw.slice(0, 300)}`, raw) };
    let data: unknown;
    try { data = JSON.parse(raw); } catch { return { ok: false, detail: `响应非 JSON: ${raw.slice(0, 200)}` }; }
    const content = (data as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
    if (typeof content !== 'string') return { ok: false, detail: `响应无 choices[0].message.content: ${raw.slice(0, 200)}` };
    return { ok: true, text: content };
  } catch (e) {
    // 超时（`AbortSignal.timeout` 抛 TimeoutError）也走这里 ⇒ 与其它失败同归 `ok:false`，绝不外抛。
    return { ok: false, detail: (e as Error)?.message || String(e) };
  }
}

/**
 * 把 wav 转成文字。**超时与失败都转成 `ok:false`，绝不抛**——调用方在任务执行循环里，
 * 抛出去顶掉的是整轮执行，代价远大于"这一件没转成"。
 */
export async function transcribeAudio(
  wavPath: string,
  deps: TranscribeDeps,
): Promise<{ ok: true; text: string } | { ok: false; reason: string; detail?: string }> {
  const timeoutMs = deps.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS;
  try {
    const read = deps.readFile ?? ((p: string) => fs.readFile(p));
    const bytes = await read(wavPath);
    if (!bytes?.length) return { ok: false, reason: 'transcribe_failed', detail: `音频为空: ${wavPath}` };

    const matched = await deps.selectModel(buildAudioModelRequest());
    // zx_20260921_1 M2: 选型口**说出了原因**就原样带出。这一步须在字段门槛**之前**——
    //   失败形状的 `url` 本来就取不到，混进下面那句"无 audio 能力模型可给"就又把成因抹平了。
    if (matched && 'error' in matched) {
      return { ok: false, reason: 'transcribe_failed', detail: matched.error };
    }
    // 字段门槛与 `agent-executor.ts` 取模型处同形：少一个字段就调不通，早判比拼出个半截请求强。
    if (!matched?.url || !matched?.api_key || !matched?.model_name) {
      return { ok: false, reason: 'transcribe_failed', detail: '无 audio 能力模型可给（ANS 选型未返回可用端点）' };
    }

    const body: Record<string, unknown> = {
      model: matched.model_name,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: TRANSCRIBE_PROMPT },
            buildInputAudioPart(matched, bytes, audioFormatOf(wavPath)),
          ],
        },
      ],
      temperature: 0,
      max_tokens: matched.max_output_tokens || DEFAULT_MAX_OUTPUT_TOKENS,
    };

    const chat = deps.chat ?? postChatCompletion;
    const r = await chat(matched, body, timeoutMs);
    if (!r.ok) return { ok: false, reason: 'transcribe_failed', detail: r.detail };
    const text = r.text.trim();
    // 空文本不是"这段音频没话说"就是"模型拒答"，两者都**没有**可给下游的字；当成成功会把空串混进上下文。
    if (!text) return { ok: false, reason: 'transcribe_failed', detail: '模型返回空文本' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, reason: 'transcribe_failed', detail: (e as Error)?.message || String(e) };
  }
}

/** 生产传进来的选型口形状（`ansClient.getOptimalModel`）——**只取这一个方法**，不把整个客户端拖进本模块。 */
export interface OptimalModelClient {
  getOptimalModel(params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * 归一化中间产物的缺省落点。
 *
 * ⚠ 落 `os.tmpdir()` 而**不落 `data/attachments/`**：后者是**入站原件**的目录（M1 约定，回执里给用户
 *   看的就是它），往里塞派生物会让"哪些是用户给的件"这件事失真。
 */
export const TRANSCRIBE_TMP_DIR: string = path.join(os.tmpdir(), 'wa-audio-transcribe');

/**
 * 一次任务运行的归一化落点（zx_20260929 M3「用完就收」）。
 *
 * 病根：`TRANSCRIBE_TMP_DIR` 是**一个全局目录**，`normalizeToWav` 生成的 `*.wav` **只进不出**——
 *   跑过的每件音视频都在 `os.tmpdir()` 里留一份全量 WAV（一小时录音 ≈ 600MB），
 *   一直躺到操作系统自己清理；任务早收口了，盘却还占着。
 * 现：按 `taskId` 分一层子目录，任务收口时**整目录**删掉（`cleanTranscribeTmp`）。
 *
 * ⚠ 目录名从 `taskId` 派生且**洗掉路径分隔符**：`taskId` 是库里的值，往哪写不该由它决定。
 *   但洗字符集**不够**：点号在允许集里，`'.'`/`'..'` 洗过之后仍是点号，`path.join` 会把它们
 *   **折到父目录去**（`transcribeTmpDirFor('..')` 得到本色之上一级）。那种目录 `cleanTranscribeTmp`
 *   出于安全会拒绝删（见下），于是那些运行的 WAV **永远收不掉**——既不越界、也不泄漏，
 *   只是悄悄从"用完就收"退回"只进不出"。
 *   ⇒ 判据落在**派生结果本身**而不是字符集：算出来**没落回本色之内**就退到一个安全名。
 *   （按结构判，不按枚举危险字符判：将来再放宽字符集也不会重新捅出这个洞。）
 */
export function transcribeTmpDirFor(taskId: string): string {
  const safe = String(taskId ?? '').replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
  const base = path.resolve(TRANSCRIBE_TMP_DIR);
  const joined = path.join(TRANSCRIBE_TMP_DIR, safe);
  if (!path.resolve(joined).startsWith(base + path.sep)) return path.join(TRANSCRIBE_TMP_DIR, 'unknown');
  return joined;
}

/**
 * 收掉一次运行留下的归一化产物。**永不抛**——收尾失败不该把一个已经跑完的任务判成失败
 * （与 `exec-finalize.ts` 里"清除失败不影响收口"同一取舍）。
 *
 * ⚠ 只删 `transcribeTmpDirFor` 造出来的**子**目录：本色（`TRANSCRIBE_TMP_DIR` 本身）不收，
 *   收了会把并发跑着的别的任务的产物一起端掉。
 */
export async function cleanTranscribeTmp(dir: string | undefined): Promise<void> {
  if (!dir) return;
  const base = path.resolve(TRANSCRIBE_TMP_DIR);
  const target = path.resolve(dir);
  if (target === base || !target.startsWith(base + path.sep)) return;
  try { await fs.rm(target, { recursive: true, force: true }); } catch { /* 清理失败不影响收口 */ }
}

/**
 * 把 `InlineIo.transcribeAudio` 这个形状接到真件上（墨子·摹略万物之然）。
 *
 * 两段**分开说**：先 `normalizeToWav`（要 ffmpeg），再 `transcribeAudio`（要 ANS 选出一个真能干
 * `audio` 的模型）。任一段断都返回 `ok:false` + **说出断在哪一段**——"没装 ffmpeg"与"没有能听音频的
 * 模型"是两回事，混成一句就是失实。
 *
 * ⚠ **本函数住在 `audio-transcribe.ts` 而不是 `agent-executor.ts`**（2026-09-21 就地订正）：它由
 *   `normalizeToWav` + `transcribeAudio` + 一个选型口**纯组合**而成，零 electron、零重依赖。长在
 *   agent-executor 里，受控回归就只能**照抄一份等价物**来试——那证的是夹具自己，正是本轮 §7 点名
 *   的头号风险（判据自我印证）。搬到这里之后，C16–C18 跑的是**生产真走的那个函数**。
 *
 * `dstDir` / `io` 可注入：判据据此**不写进真 tmp**、也**不依赖"本机恰好装了 ffmpeg"**。
 */
export function makeAudioTranscriber(
  ansClient: OptimalModelClient,
  dstDir: string = TRANSCRIBE_TMP_DIR,
  io?: AudioTranscribeIo,
): (p: string) => Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  return async (p: string) => {
    const norm = await normalizeToWav(p, dstDir, io);
    // `detail` 一并带上（与下面的转写段同形）：`ffmpeg_missing` 说得清"没有农具"，
    // 说不清"PATH 里找不到还是没执行权限"——而后者才是用户去修的那一刻要看的话。
    if (!norm.ok) return { ok: false, reason: norm.detail ? `${norm.reason}: ${norm.detail}` : norm.reason };

    const deps: TranscribeDeps = {
      selectModel: async (req) => {
        const m = await ansClient.getOptimalModel(req);
        // zx_20260921_1 M2: 先认**失败形状**，再说成功形状。此前这里只认成功形状，
        //   零命中回包（`{error:{…}}`）被当模型对象收下 → `url` 取不到 → 返回 `null` → 一句静默。
        const fail = describeModelSelectionFailure(m);
        if (fail) return { error: fail };
        const url = typeof m?.url === 'string' ? m.url : '';
        const api_key = typeof m?.api_key === 'string' ? m.api_key : '';
        const model_name = typeof m?.model_name === 'string' ? m.model_name : '';
        // 不是 error 形状、字段却不齐 —— 这**不是**"没有 audio 模型"，而是选型口回了意料之外的形状。
        //   两种情形的处置相同（不往下走），但话得说实话。
        if (!url || !api_key || !model_name) {
          return { error: `ANS 选型回包形状不认识（无 error 键，也缺 url/api_key/model_name；回包键：${Object.keys(m ?? {}).join(', ') || '空'}）` };
        }
        return { url, api_key, model_name, max_output_tokens: typeof m.max_output_tokens === 'number' ? m.max_output_tokens : undefined };
      },
      timeoutMs: TRANSCRIBE_TIMEOUT_MS,
    };

    // zx_20261018_1 批六「听」：短/长**在这里分路**，调用方（agent-executor 注入的音频/视频音轨
    //   两条支路）不需要各判一次。「超限」的问法是**产物本身**——`normalizeToWav` 已按体积回查
    //   给出 `truncated`（M12 的同一把尺），不另探一次时长；短音频因此**零新增 ffmpeg 调用**。
    if (norm.truncated) {
      const long = await transcribeLongAudio(p, dstDir, deps, io);
      if (long.ok) return { ok: true, text: long.text };
      // 读不出时长 ⇒ 退回既有「只转前 N 秒 + 如实告知不完整」的出口：这条老路本身是诚实的
      //   （明说后段未转写），不因新增长路径而把「分不了段」升级成「整件失败」。
      if (long.reason === 'duration_unknown') {
        const r = await transcribeAudio(norm.path, deps);
        if (!r.ok) return { ok: false, reason: r.detail ? `${r.reason}: ${r.detail}` : r.reason };
        return {
          ok: true,
          text: `[音频较长，已按本机上限只转写**前 ${norm.capSeconds} 秒**（${Math.round(norm.capSeconds / 60)} 分钟）`
            + `；其后段**未转写**，下面的内容是**不完整**的——若后段重要，请把音频切成多段分别发。]\n${r.text}`,
        };
      }
      // 超上限 / 某段失败 ⇒ **如实失败**，不拿"前 13 分钟"冒充全文（R-51 / R-54）。
      return { ok: false, reason: long.detail ? `${long.reason}: ${long.detail}` : long.reason };
    }

    const r = await transcribeAudio(norm.path, deps);
    if (!r.ok) return { ok: false, reason: r.detail ? `${r.reason}: ${r.detail}` : r.reason };
    return { ok: true, text: r.text };
  };
}
