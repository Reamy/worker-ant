/**
 * zx_20261018_2 批一（管子·度量衡 / 维特根斯坦·意义即使用）: `view_image` 的**视觉子调用**。
 *
 * 病根（承 `tools/media.ts` 头注释的实测结论）：AI SDK v4 的图片型 tool result 在
 *   OpenAI 兼容 chat/completions 上会退化成一段 base64 文本——**像素到不了主模型**。
 *   `view_image` 此前只能回元数据 + 一句"请用户重发"，等于"看不了"。
 *
 * 治法：**换一条真到得了像素的路**——由本模块向 ANS 要一个 `vision` 模型，
 *   把降质后的图作为 **user message 的 image part** 发过去（这条通道是通的），
 *   再把视觉模型返回的**文字观察**交回主模型。
 *
 * 三条纪律：
 *   ① **二手就是二手**：交回主模型的必须标明"这是视觉模型的观察，不是原件像素"——
 *      否则主模型会把别人的转述当成自己的亲眼所见（`zx_20260920_1`「用了才算数」同族）。
 *   ② **失败说得清**：选型零命中 / 无 vision / 读不了 / 降不到上限 / 生成失败 / 空回答，
 *      六种成因各有各的话；**不拿一句"看不了"抹平**（承 `audio-transcribe.ts` 的两段分说）。
 *   ③ **零 electron 静态依赖**：降质走 `image-downscale.ts`（`nativeImage` 动态 import），
 *      生成走**动态** `import('ai')` ⇒ rr 注入桩即可直跑本模块，不碰 electron / SDK。
 *
 * ⚠ 本模块**不碰记忆/台账**：观察文本只作为工具结果回到本轮上下文。
 *   把"对某张图的二手观察"写进长期记忆，等于让一次可能出错的猜测获得永久效力。
 */
import { FAMILY_MAX_BYTES } from './attachment-kinds.js';
import { electronDownscale, type DownscaledImage } from './image-downscale.js';
import { buildModelRequest, compareModelCapabilities, describeModelSelectionFailure } from './model-request.js';

/**
 * 视觉子调用的选型。与主执行模型**分开选**：主模型可能没有 `vision`，
 * 而这条子路只需要一个能收图的模型，不该因此把整单任务硬拦死。
 */
export function buildVisionModelRequest(): Record<string, unknown> {
  return buildModelRequest({ archetype: 'conversation', strategy: 'cost-optimal', hasMedia: true });
}

/** 视觉子调用的能力声明（回验 ANS 给的模型带不带图输入）。 */
export const VISION_DEMAND: readonly string[] = ['vision'];

/**
 * 发给视觉模型的最大图片字节数。
 *
 * 取 4MB 而非图片族上限 10MB：图片要经 base64 放进请求体（膨胀 ~4/3），
 * 多家 OpenAI 兼容端点的单图输入上限在 4–20MB 之间；4MB 是能让绝大多数端点收下的工程上界。
 * **降质阶梯照旧**（`image-downscale.ts`，与附件内联同一份实现）——同一张图两条路压出同一组候选。
 */
export const VISION_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/** 视觉调用是旁路 LLM，超时与验收核对同档（30s）偏紧，取 60s 给大图/慢端点留余量。 */
export const VISION_TIMEOUT_MS = 60_000;

export const VISION_DEFAULT_MAX_TOKENS = 1024;

/**
 * 给视觉模型的提示词。**要事实，不要发挥**：
 * 看图模型最常见的失实是"把看不清的东西说成确定的"。故显式要求标不确定、禁止猜。
 */
export const VISION_PROMPT = [
  '请客观描述这张图片的内容，供另一个只能读文字的 AI 继续工作。',
  '要求：',
  '1. 先说**整体是什么**（照片/截图/图表/文档扫描/界面等）；',
  '2. 再说**可读出的关键信息**：若含文字，逐字给出主要文字（保持原文，不要翻译）；若为图表，说明坐标轴、趋势与关键数值；若为界面截图，说明可见控件与状态；',
  '3. **看不清就说看不清**，用「无法辨认」标注；不要根据文件名、常识或上下文补充图中不存在的内容；',
  '4. 不要评价、不要建议、不要寒暄；',
  '5. 中文作答，尽量控制在 500 字以内。',
].join('\n');

export interface VisionEndpoint {
  url: string;
  api_key: string;
  model_name: string;
  capabilities?: string[];
  max_output_tokens?: number;
}

export type ImageDescribeResult =
  | {
      ok: true;
      /** 视觉模型给出的观察文本（已 trim） */
      text: string;
      /** 实际使用的模型名（落进工具结果，便于用户追） */
      model: string;
      /** 发给视觉模型的字节数（降质后） */
      bytes: number;
      mimeType: string;
    }
  | {
      ok: false;
      /** 机器可读的成因（与 detail 分开：前者可被断言，后者给人看） */
      reason:
        | 'selection_failed'
        | 'no_vision_model'
        | 'read_failed'
        | 'downscale_failed'
        | 'too_large'
        | 'generation_failed'
        | 'empty';
      detail: string;
    };

export interface ImageDescribeDeps {
  /**
   * 选型。生产传 `ctx.getAnsClient().getOptimalModel`。返回值**形状未知**——
   * 本模块自己认失败形状 / 字段是否齐，不要求调用方先解一遍。
   */
  selectModel(req: Record<string, unknown>): Promise<unknown>;
  /** 读盘；缺省 `node:fs/promises` */
  readFile?(p: string): Promise<Buffer>;
  /** 盘上字节数；缺省不预判（直接进降质阶梯） */
  statSize?(p: string): number | null;
  /** 降质；缺省 `image-downscale.electronDownscale`（electron 动态 import）。返回 `null` = 降不动。 */
  downscaleImage?(p: string, maxBytes: number): Promise<DownscaledImage | null>;
  /** 真正的视觉调用；缺省 `defaultGenerate`（AI SDK，动态 import） */
  generate?(
    endpoint: VisionEndpoint,
    image: DownscaledImage,
    prompt: string,
  ): Promise<{ ok: true; text: string } | { ok: false; detail: string }>;
  maxOutputTokens?: number;
}

/** 读 `unknown` 回包里的字符串字段——只说得出确定的事。 */
function strField(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  return typeof v === 'string' ? v : '';
}

/**
 * 生产缺省的视觉调用：`createSafeProvider` + `provider.chat(model_name)` + `generateText`。
 * 图片作为 **user message 的 image part** 发送——这是实测能到像素的那条通道（见文件头）。
 */
async function defaultGenerate(
  endpoint: VisionEndpoint,
  image: DownscaledImage,
  prompt: string,
  maxTokens: number,
): Promise<{ ok: true; text: string } | { ok: false; detail: string }> {
  const [{ generateText }, { createSafeProvider }] = await Promise.all([
    import('ai'),
    import('./ai-provider.js'),
  ]);
  const provider = createSafeProvider({ baseURL: endpoint.url, apiKey: endpoint.api_key });
  const r = await generateText({
    model: provider.chat(endpoint.model_name),
    temperature: 0.1,
    maxTokens,
    abortSignal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image', image: image.data, mimeType: image.mimeType },
      ],
    }],
  });
  const text = (r.text ?? '').trim();
  if (!text) return { ok: false, detail: '视觉模型返回了空文本' };
  return { ok: true, text };
}

/**
 * 把"看一张盘上的图"接到真件上。**永不抛**：所有失败都变成 `{ok:false, reason, detail}`——
 * 工具层据此如实回话，绝不因一次旁路调用把任务打挂。
 */
export function makeImageDescriber(
  deps: ImageDescribeDeps,
): (p: string) => Promise<ImageDescribeResult> {
  const readFile = deps.readFile ?? ((p: string) => import('node:fs/promises').then((m) => m.readFile(p)));
  const statSize = deps.statSize;
  const downscale = deps.downscaleImage ?? electronDownscale;
  const generate = deps.generate
    ?? ((ep, img, prompt) => defaultGenerate(ep, img, prompt, deps.maxOutputTokens ?? VISION_DEFAULT_MAX_TOKENS));

  return async (p: string): Promise<ImageDescribeResult> => {
    // ① 选型：先认失败形状，再说字段齐不齐（与音频路同一把尺）。
    let picked: unknown;
    try {
      picked = await deps.selectModel(buildVisionModelRequest());
    } catch (e) {
      return { ok: false, reason: 'selection_failed', detail: e instanceof Error ? e.message : String(e) };
    }
    const fail = describeModelSelectionFailure(picked);
    if (fail) return { ok: false, reason: 'selection_failed', detail: fail };
    const m = (picked ?? {}) as Record<string, unknown>;
    const endpoint: VisionEndpoint = {
      url: strField(m, 'url'),
      api_key: strField(m, 'api_key'),
      model_name: strField(m, 'model_name'),
      capabilities: Array.isArray(m.capabilities) ? (m.capabilities as unknown[]).map(String) : undefined,
      max_output_tokens: typeof m.max_output_tokens === 'number' ? m.max_output_tokens : undefined,
    };
    if (!endpoint.url || !endpoint.api_key || !endpoint.model_name) {
      return {
        ok: false,
        reason: 'no_vision_model',
        detail: `ANS 选型回包形状不认识（无 error 键，也缺 url/api_key/model_name；回包键：${Object.keys(m).join(', ') || '空'}）`,
      };
    }
    // ② 回验：回包带了能力清单且**不含 vision** ⇒ 这个模型看不了图，不硬发。
    //    清单缺席 ⇒ 无从比对（与 `compareModelCapabilities` 同一条尺：不替它下结论），放行。
    const cmp = compareModelCapabilities(VISION_DEMAND, picked);
    if (cmp && cmp.missing.length > 0) {
      return {
        ok: false,
        reason: 'no_vision_model',
        detail: `ANS 选出的模型 ${endpoint.model_name} 实得能力 [${cmp.got.join(', ')}]，缺 [${cmp.missing.join(', ')}]`,
      };
    }

    // ③ 读盘 + 有界预判（盘上已知超过图片族上限时，连读都不读）。
    try {
      const size = statSize ? statSize(p) : null;
      const familyCap = FAMILY_MAX_BYTES.image;
      if (size !== null && size > familyCap) {
        return {
          ok: false,
          reason: 'too_large',
          detail: `图片 ${size} 字节超过图片族上限 ${familyCap} 字节`,
        };
      }
    } catch {
      // 取不到盘上尺寸不是失败：降质阶梯手里有字节就行（承 `attachment-inline.ts` 的 statSize 缺省语义）。
    }
    let raw: Buffer;
    try {
      raw = await readFile(p);
    } catch (e) {
      return { ok: false, reason: 'read_failed', detail: e instanceof Error ? e.message : String(e) };
    }
    if (raw.length === 0) return { ok: false, reason: 'read_failed', detail: '盘上文件为空' };

    // ④ 降质：与附件内联**同一份阶梯**。降不动 ≠ 读不了——单独成因，话也单独说。
    const image = await downscale(p, VISION_IMAGE_MAX_BYTES);
    if (!image) {
      return {
        ok: false,
        reason: 'downscale_failed',
        detail: `无法把图片压到 ${VISION_IMAGE_MAX_BYTES} 字节以内（本机图片解码不可用或格式不受支持）`,
      };
    }

    // ⑤ 生成。旁路失败同样如实成文。
    try {
      const r = await generate(endpoint, image, VISION_PROMPT);
      if (!r.ok) return { ok: false, reason: 'generation_failed', detail: r.detail };
      const text = r.text.trim();
      if (!text) return { ok: false, reason: 'empty', detail: '视觉模型返回了空文本' };
      return { ok: true, text, model: endpoint.model_name, bytes: image.data.length, mimeType: image.mimeType };
    } catch (e) {
      return { ok: false, reason: 'generation_failed', detail: e instanceof Error ? e.message : String(e) };
    }
  };
}
