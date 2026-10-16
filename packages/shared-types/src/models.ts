/** AI供应商 */
export interface AiProvider {
  id: string;
  name: string;
  base_url: string | null;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
}

/**
 * `audio` 标的**语义裁定**（zx_20260921_1 M4 定死）。
 *
 * 一句话：`audio` = **能在 `chat/completions` 请求里接收音频输入**。
 *
 * 此前这个词被读成"所有语音能力"（识别 + 合成），于是两类**假阳性**混了进来：
 * - 只有 `/v1/audio/transcriptions` **专用转写口**的模型（如 Voxtral）——不收 chat 形状的音频 part
 * - **合成方向**的模型（各家 TTS）——音频是**输出**，不是输入
 * 还有走 WebSocket realtime 通道的（如 Grok Voice），同样不是 `chat/completions`。
 *
 * ⚠ 这里是「这个名字指什么」的裁定，不是"怎么发请求"的实现；调用形状见
 * `apps/worker-ant-desktop/src/main/core/audio-transcribe.ts` 的 `AUDIO_CAPABILITY`。
 */
export const AUDIO_CAPABILITY_SEMANTICS = '能在 chat/completions 请求里接收音频输入';

/** 按 {@link AUDIO_CAPABILITY_SEMANTICS} **明确不登记** `audio` 的类别（登记了就是假阳性）。 */
export const AUDIO_CAPABILITY_NOT_REGISTERED =
  '不登记：/v1/audio/transcriptions 专用转写口（Voxtral）· WebSocket realtime 语音通道（Grok Voice）· 合成方向的 TTS 模型';

/**
 * 公开资料**互相矛盾**、未实测 ⇒ **不打标、不替用户选边**（《实践论》：没实测过的不下结论）。
 * 打标与否留给实测之后裁决。
 */
export const AUDIO_CAPABILITY_CONTESTED = '待实测（暂不打标）：gpt-5.5、glm-5.2';

/** AI模型能力标签 */
export type ModelCapability =
  | 'chat' // 基础文本对话
  | 'function-calling' // Tool/Function Calling (Agent核心能力)
  | 'structured_output' // JSON Mode / Structured Output
  | 'vision' // 图片理解(输入)
  | 'embedding' // 文本向量嵌入
  | 'reasoning' // 深度推理/Thinking模式
  | 'streaming' // SSE/流式输出
  | 'code' // 代码生成专项
  | 'image-generation' // 图片生成(输出)
  | 'audio' // 音频输入（chat/completions 里收），见 AUDIO_CAPABILITY_SEMANTICS
  | 'translation'; // zx_20260930 M15-⑦：活库在册（`qwen3.5:9b`）——此前只在这张表外"野生"存在

/** 模型能力元数据：描述、是否影响路由、所需最低context */
export const MODEL_CAPABILITY_META: Record<
  ModelCapability,
  { label: string; description: string; minContext: number; category: 'core' | 'advanced' | 'specialized' }
> = {
  chat: { label: '对话', description: '基础文本生成与对话能力', minContext: 4000, category: 'core' },
  'function-calling': {
    label: '函数调用',
    description: 'Tool/Function Calling，Agent执行工具的核心能力',
    minContext: 32000,
    category: 'core',
  },
  structured_output: {
    label: '结构化输出',
    description: 'JSON Mode/Structured Output，生成严格格式的JSON',
    minContext: 16000,
    category: 'advanced',
  },
  vision: { label: '视觉理解', description: '图片/图像内容识别与理解', minContext: 8000, category: 'advanced' },
  embedding: {
    label: '向量嵌入',
    description: '文本转向量嵌入，用于语义搜索和记忆检索',
    minContext: 512,
    category: 'core',
  },
  reasoning: {
    label: '深度推理',
    description: 'Thinking/推理模式，逐步思考复杂问题。注意：此模式下tool_choice不兼容',
    minContext: 32000,
    category: 'specialized',
  },
  streaming: { label: '流式输出', description: 'SSE流式输出，边生成边返回', minContext: 4000, category: 'core' },
  code: { label: '代码生成', description: '代码生成与补全专项能力', minContext: 16000, category: 'specialized' },
  'image-generation': {
    label: '图片生成',
    description: '根据文本描述生成图片',
    minContext: 4000,
    category: 'specialized',
  },
  audio: { label: '音频输入', description: AUDIO_CAPABILITY_SEMANTICS, minContext: 4000, category: 'specialized' },
  // zx_20260930 M15-⑦：补上活库在册的第 11 值（此前 ANS 侧无枚举校验，故这个值一直在库里"说得通"、
  //   在表里"查不到"；补进本表后本表即 **ANS schema 的真源**，两边同集）。label/描述按本表句式给。
  translation: { label: '翻译', description: '多语种翻译专项能力', minContext: 4000, category: 'specialized' },
};

/**
 * 模型名称 → **建议能力**（按数组顺序**首个命中者胜** ⇒ 具体规则必须排在泛化规则之前）。
 *
 * ⚠ zx_20260929 M6-3「一个词一个表」：`tip` 是**必填**。此前本表与 renderer 各存一份
 *   （renderer 那份带 `tip`/`caps`、本表带 `add`/`remove`），两处**值已互相漂开**
 *   （`deepseek-r1` 是否带 `function-calling`、`gpt-4o` 的正则、泛化 `qwen|deepseek|llama` 规则
 *   只有 renderer 那份有）。既然本表是**在册的真源**，就把两边**并**到这里、renderer 改引本表
 *   （renderer 可跨 root import 纯模块，`zx_20260916_3` E-1 已有先例）——
 *   并的原则是**一条建议都不丢**：renderer 的 `tip`、泛化规则、`mistral` 供应商提示全部并入。
 */
export const MODEL_NAME_CAPABILITY_HINTS: Array<{
  pattern: RegExp;
  add: ModelCapability[];
  remove?: ModelCapability[];
  /** 界面上给用户看的一句人话（必填：`tip?: string` 会在 renderer 印出"undefined（*建议能力）"）。 */
  tip: string;
}> = [
  {
    pattern: /gpt-4o|gpt-4\.\d|o1|o3|o4/i,
    add: ['chat', 'function-calling', 'structured_output', 'vision', 'reasoning', 'streaming', 'code'],
    tip: 'OpenAI旗舰模型',
  },
  {
    pattern: /gpt-4.*mini/i,
    add: ['chat', 'function-calling', 'structured_output', 'vision', 'streaming'],
    tip: 'OpenAI轻量模型',
  },
  {
    pattern: /claude.*opus/i,
    add: ['chat', 'function-calling', 'vision', 'reasoning', 'streaming', 'code'],
    tip: 'Anthropic旗舰，深度推理最强',
  },
  {
    pattern: /claude.*sonnet/i,
    add: ['chat', 'function-calling', 'vision', 'streaming', 'code'],
    tip: 'Anthropic均衡型',
  },
  { pattern: /claude.*haiku/i, add: ['chat', 'function-calling', 'vision', 'streaming'], tip: 'Anthropic轻量模型' },
  {
    pattern: /gemini.*pro/i,
    add: ['chat', 'function-calling', 'structured_output', 'vision', 'reasoning', 'streaming', 'code'],
    tip: 'Google旗舰，多模态+长上下文',
  },
  {
    pattern: /gemini.*flash/i,
    add: ['chat', 'function-calling', 'structured_output', 'vision', 'streaming'],
    tip: 'Google轻量模型',
  },
  // zx_20260929 M6-3 ★就地订正：本表原写 `add` 含 `function-calling`，而 renderer 那份的 `tip` 写的是
  //   「不支持 function-calling」——**两份自相矛盾**。以事实为准（实践中，deepseek-r1 不发 function-calling）：
  //   本机真库 `ans-server.db` 两行标本同向——`deepseek-r1` = `["reasoning","streaming"]`、
  //   `deepseek-r1:14b`(ollama) = `["chat","code"]`，**都没有 `function-calling`**。
  //   故去 `add` 里的该项、并写进 `remove`（去掉这个错标，而不是换个标）。
  {
    pattern: /deepseek.*r1/i,
    add: ['chat', 'reasoning', 'streaming', 'code'],
    remove: ['structured_output', 'function-calling'],
    tip: '推理模型，不支持 function-calling',
  },
  {
    pattern: /deepseek.*v3/i,
    add: ['chat', 'function-calling', 'streaming', 'code', 'structured_output'],
    tip: 'DeepSeek通用模型',
  },
  { pattern: /deepseek.*chat/i, add: ['chat', 'function-calling', 'streaming'], tip: 'DeepSeek对话模型' },
  // 泛化兜底（zx_20260929 M6-3 并入）：必须排在上述 `deepseek.*` 具体规则**之后**（首个命中者胜）。
  //   本机真库的 `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-coder-v2:16b` 都只有它兜得住。
  { pattern: /deepseek/i, add: ['chat', 'function-calling', 'streaming'], tip: 'DeepSeek通用模型' },
  {
    pattern: /qwen.*max/i,
    add: ['chat', 'function-calling', 'vision', 'streaming', 'code', 'reasoning'],
    tip: 'Qwen旗舰',
  },
  { pattern: /qwen.*plus/i, add: ['chat', 'function-calling', 'vision', 'streaming', 'code'], tip: 'Qwen均衡型' },
  { pattern: /qwen.*coder/i, add: ['chat', 'function-calling', 'streaming', 'code'], tip: 'Qwen代码专项' },
  { pattern: /qwen.*vl/i, add: ['chat', 'vision', 'streaming'], tip: 'Qwen视觉理解专项' },
  // 同上：泛化兜底排最后（本机真库的 `qwen3.5:9b` / `qwen3-omni-flash` 只有它兜得住）。
  { pattern: /qwen/i, add: ['chat', 'function-calling', 'vision', 'streaming'], tip: 'Qwen通用模型' },
  // ⚠ 原为 `/llama.*\d+b/`（要求名字里带尺寸），改为泛化 `/llama/i`：本表是**建议**，宁可建议得宽一点，
  //   也不要"名字里没写 8b 就一条建议都不给"（并入原则：不丢建议）。
  { pattern: /llama/i, add: ['chat', 'function-calling', 'streaming', 'code'], tip: 'Meta Llama开源' },
  { pattern: /mixtral|mistral/i, add: ['chat', 'function-calling', 'streaming', 'code'], tip: 'Mistral 系列开源模型' },
  {
    pattern: /text-embedding|embed/i,
    add: ['embedding'],
    remove: ['chat', 'function-calling', 'vision', 'streaming', 'code'],
    tip: '嵌入模型，仅用于向量化',
  },
  {
    pattern: /dall-e|imagen|stable.*diffusion|flux|midjourney/i,
    add: ['image-generation'],
    remove: ['chat', 'function-calling', 'streaming'],
    tip: '图像生成模型',
  },
  // ⚠ `audio` **刻意不在**这条的 `add` 里（zx_20260921_1 M4）：whisper 走 `/v1/audio/transcriptions`
  //   专用转写口、tts 是**合成**方向，按 `AUDIO_CAPABILITY_SEMANTICS` 两者都是假阳性。
  //   保留 `remove` 是因为它们确实不是对话模型——去掉这些标，而不是换一个错的标。
  {
    pattern: /whisper|tts/i,
    add: [],
    remove: ['chat', 'function-calling', 'vision', 'streaming', 'code'],
    tip: '转写/合成模型，不是对话模型；按 audio 的定义不该打 audio 标',
  },
];

/** 常见供应商的默认模型能力建议 */
export const PROVIDER_CAPABILITY_HINTS: Record<string, ModelCapability[]> = {
  openai: [
    'chat',
    'function-calling',
    'structured_output',
    'vision',
    'reasoning',
    'streaming',
    'code',
    'embedding',
    'image-generation',
    'audio',
  ],
  anthropic: ['chat', 'function-calling', 'vision', 'reasoning', 'streaming', 'code'],
  google: ['chat', 'function-calling', 'structured_output', 'vision', 'reasoning', 'streaming', 'code', 'embedding'],
  deepseek: ['chat', 'function-calling', 'reasoning', 'streaming', 'code'],
  qwen: ['chat', 'function-calling', 'vision', 'reasoning', 'streaming', 'code', 'embedding'],
  ollama: ['chat', 'function-calling', 'vision', 'embedding', 'streaming'],
  openrouter: [
    'chat',
    'function-calling',
    'structured_output',
    'vision',
    'reasoning',
    'streaming',
    'code',
    'embedding',
  ],
  groq: ['chat', 'function-calling', 'streaming'],
  // zx_20260929 M6-3 并入：只有 renderer 那份手抄表有 `mistral`（本表有 `openrouter`、它没有）——
  //   合并取并集，两边各自认得的那一个都留下。
  mistral: ['chat', 'function-calling', 'streaming', 'code'],
};

/** AI模型 */
export interface AiModel {
  id: string;
  provider_id: string;
  name: string;
  capabilities: ModelCapability[];
  context_window: number;
  max_output_tokens: number;
  input_price_per_1k: number;
  output_price_per_1k: number;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
}

/** 模型端点（包含实际调用地址和API Key引用） */
export interface ModelEndpoint {
  id: string;
  model_id: string;
  url: string;
  api_key_ref: string;
  api_key?: string; // 解密后的API Key（仅/optimal端点返回）
  model_name?: string;
  max_output_tokens?: number; // 模型最大输出token数
  context_window?: number; // 模型上下文窗口大小
  priority: number;
  weight: number;
  status: 'active' | 'disabled';
  created_at: string;
}

/** 模型匹配请求 */
export interface ModelRequirements {
  capabilities?: ModelCapability[];
  maxCostPer1k?: number;
  preferredProvider?: string;
  strategy?: MatchStrategy;
  /** 排除具备这些能力的模型（如排除 reasoning，避免 thinking 耗尽小 maxTokens 导致空输出） */
  excludeCapabilities?: ModelCapability[];
}

/** 匹配策略 */
export type MatchStrategy = 'cost-optimal' | 'latency-optimal' | 'capability-best' | 'balanced';

/** 创建AI供应商的输入 */
export interface CreateAiProviderInput {
  name: string;
  base_url?: string;
}

/** 创建AI模型的输入 */
export interface CreateAiModelInput {
  provider_id: string;
  name: string;
  capabilities?: ModelCapability[];
  context_window?: number;
  max_output_tokens?: number;
  input_price_per_1k?: number;
  output_price_per_1k?: number;
}

/** 创建模型端点的输入 */
export interface CreateModelEndpointInput {
  model_id: string;
  url: string;
  api_key: string;
  priority?: number;
  weight?: number;
}
