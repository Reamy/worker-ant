/**
 * zx_20261029_2 M2「通」: 舒适意图的**模型兜底**（规则排不出时才走这一跳）。
 *
 * 分工：
 *   · `home-intent.ts` 的 `planHomeComfort` 是**确定性规则**（零模型、零延迟）；
 *   · 本模块只在规则失败、且房间里确有「品类已识别 + 已过 K-6」的设备时，请模型补一份计划；
 *   · 模型回包**整份校验**——任一步不合规就整份丢弃（不落半份），随后 `resolveComfortIntent`
 *     还会按 `call_name` 映射回**当前台账**并再跑一次 K-6。**不新增第二份安全闸**。
 *
 * 口径（庄子·不预设 / 维特根斯坦·意义即用法）：
 *   ① 输入只含**脱敏设备清单**（`call_name` / `kind_class` / `room` / `actions`）——不给地址、端口、协议；
 *   ② 输出只认 `{steps:[{call_name, action, args?, reason?}]}`；`call_name` 必须在清单内；
 *   ③ `action` 必须在该设备 `actions` 或该 `kind_class` 的动作白名单内；`set_mode` **一律禁用**
 *      （冷/热只调温，不替用户选模式——与规则表同一口径）；
 *   ④ 步数 ≤ 设备数；参数做最小类型/范围校验（`set_temperature` 16–30°C）；
 *   ⑤ 有界：单次调用、超时 20s、输出 ≤ 1024 token。
 *
 * ⚠ 零 electron / 零网络：生成器可注入（rr 喂假生成器直跑真实现）；生产缺省
 *   `createSafeProvider + generateText` 动态 import（同 `project-brief-job.ts` 范式）。
 */
import type { AnsDevice } from './device-registry.js';
import { deviceControlVerdict } from './device-registry.js';
import { deviceCallName } from './device-name.js';
import { deviceKindClassOf, devicesInRoom } from './home-intent.js';
import type { DeviceKindClass } from './device-kind.js';
import type { IntentStep } from './intent-plans.js';
import type { ComfortFeeling } from './intent-protocol.js';
import { auxModelRequest } from './model-request.js';

/** 单次模型调用超时——兜底是"补一手"，不是让用户等到天荒地老。 */
export const INTENT_MODEL_TIMEOUT_MS = 20_000;
/** 模型输出上界（计划里定死 ≤1024）。 */
export const INTENT_MODEL_MAX_OUTPUT_TOKENS = 1024;

/**
 * 类目 → **可接受的动作白名单**（与 `COMFORT_RULES` 同一套词，但不绑定具体感受）。
 * 表外类目为空 ⇒ 模型只能按设备自述能力清单行事（认不出就归 `unknown`，根本进不了清单）。
 */
export const MODEL_ACTION_WHITELIST: Partial<Record<DeviceKindClass, readonly string[]>> = {
  curtain: ['open', 'close', 'stop'],
  aircon: ['turn_on', 'turn_off', 'set_temperature'],
  light: ['turn_on', 'turn_off', 'set_brightness'],
  fan: ['turn_on', 'turn_off', 'set_speed'],
  switch: ['turn_on', 'turn_off'],
};

/** 无论如何不许模型写的动作——"冷/热"只调温，不替用户选模式。 */
export const MODEL_FORBIDDEN_ACTIONS: readonly string[] = ['set_mode'];

/** 模型能看到的设备行（**脱敏**：无地址/端口/协议/授权态）。 */
export interface ModelPlanDevice {
  call_name: string;
  kind_class: DeviceKindClass;
  room: string;
  actions: string[];
}

function modelActionsOf(cls: DeviceKindClass): readonly string[] {
  return MODEL_ACTION_WHITELIST[cls] ?? [];
}

/**
 * 台账 → 模型可见清单：只取**同房间**、品类**已识别**、且已过 K-6 的设备。
 * 与 `resolveComfortIntent` 的 `usable` 同一把尺（两处都走 `deviceKindClassOf` + `deviceControlVerdict`）。
 */
export function modelPlanDevices(devices: AnsDevice[], room: string): ModelPlanDevice[] {
  return devicesInRoom(devices, room)
    .map((d) => ({ dev: d, cls: deviceKindClassOf(d) }))
    .filter(({ cls }) => cls !== 'unknown')
    .filter(({ dev }) => deviceControlVerdict(dev).ok)
    .map(({ dev, cls }) => ({
      call_name: deviceCallName(dev),
      kind_class: cls,
      room: String(dev.room ?? ''),
      actions: [...new Set([...modelActionsOf(cls), ...(dev.capabilities ?? [])])],
    }));
}

/** 提示词里的感受人话（与面板词表同义；不改词表真源，只在这里作提示语）。 */
const FEELING_HINT: Record<ComfortFeeling, string> = {
  hot: '有点热',
  cold: '有点冷',
  dark: '太暗',
  bright: '想更亮',
};

/** 组装模型提示词（**只**含脱敏设备清单与感受；不出现地址/协议/用户身份）。 */
export function buildModelPlanPrompt(input: {
  room: string;
  feeling: ComfortFeeling;
  devices: ModelPlanDevice[];
}): string {
  return [
    '你是智能家居的舒适度规划器。请在给定设备清单中，为一个房间的一条舒适意图排出可执行步骤。',
    '',
    `房间：${input.room}`,
    `感受：${input.feeling}（${FEELING_HINT[input.feeling]}）`,
    '',
    '可用设备（JSON）：',
    JSON.stringify(input.devices, null, 2),
    '',
    '要求：',
    '- 只输出一个 JSON 对象，形状：{"steps":[{"call_name":"...","action":"...","args":{...},"reason":"..."}]}',
    '- 每步的 call_name 必须来自上面的设备清单（原样照抄，不得编造）。',
    '- action 只能选该设备 actions 里列出的词，或该类目的常用动作（窗帘 open/close；空调 set_temperature；灯 turn_on/turn_off）。',
    '- 严禁 set_mode：冷/热只调温，不要替用户选模式。',
    '- set_temperature 的唯一参数是 temperature，取值 16–30 的整数。',
    '- 步骤数不得超过设备数量；能少做就少做，不要做清单之外的额外操作。',
    '- 不要输出任何解释文字或 Markdown 代码围栏，只输出 JSON。',
  ].join('\n');
}

export type ModelPlanParseResult =
  | { ok: true; steps: IntentStep[] }
  | { ok: false; reason: string };

function asPlainObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 从可能带围栏/前后缀的模型文本里抠出 JSON 主体。 */
function extractJsonObject(text: string): string {
  const raw = String(text ?? '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw;
}

/**
 * 整份校验模型计划。**任一不符 ⇒ 整份拒绝**（不落半份、不猜）。
 * `devices` 必须是 `modelPlanDevices` 的产物（`actions` 已含类目白名单）。
 */
export function parseModelPlan(text: string, devices: ModelPlanDevice[]): ModelPlanParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(text));
  } catch {
    return { ok: false, reason: 'model_not_json' };
  }
  const body = asPlainObject(parsed);
  if (!body) return { ok: false, reason: 'model_not_object' };
  if (!Array.isArray(body.steps)) return { ok: false, reason: 'model_steps_missing' };
  if (body.steps.length === 0) return { ok: false, reason: 'model_steps_empty' };
  if (body.steps.length > devices.length) return { ok: false, reason: 'model_steps_too_many' };

  const byName = new Map(devices.map((d) => [d.call_name, d]));
  const steps: IntentStep[] = [];
  for (const raw of body.steps) {
    const step = asPlainObject(raw);
    if (!step) return { ok: false, reason: 'model_step_not_object' };
    const callName = typeof step.call_name === 'string' ? step.call_name.trim() : '';
    const action = typeof step.action === 'string' ? step.action.trim() : '';
    if (!callName) return { ok: false, reason: 'model_step_call_name_missing' };
    if (!action) return { ok: false, reason: 'model_step_action_missing' };
    if (MODEL_FORBIDDEN_ACTIONS.includes(action)) return { ok: false, reason: 'model_forbidden_action' };

    const dev = byName.get(callName);
    if (!dev) return { ok: false, reason: 'model_unknown_device' };
    const allowed = dev.actions.includes(action) || modelActionsOf(dev.kind_class).includes(action);
    if (!allowed) return { ok: false, reason: 'model_action_not_allowed' };

    let args: Record<string, unknown> | undefined;
    if (step.args !== undefined && step.args !== null) {
      const a = asPlainObject(step.args);
      if (!a) return { ok: false, reason: 'model_args_not_object' };
      args = { ...a };
    }
    if (action === 'set_temperature') {
      const t = args?.temperature;
      if (typeof t !== 'number' || !Number.isFinite(t) || t < 16 || t > 30) {
        return { ok: false, reason: 'model_temperature_out_of_range' };
      }
    }
    if (action === 'set_brightness') {
      const b = args?.brightness;
      if (b !== undefined && (typeof b !== 'number' || !Number.isFinite(b) || b < 1 || b > 100)) {
        return { ok: false, reason: 'model_brightness_out_of_range' };
      }
    }

    const reason = typeof step.reason === 'string' && step.reason.trim() ? step.reason.trim().slice(0, 200) : undefined;
    steps.push({
      call_name: callName,
      action,
      ...(args ? { args } : {}),
      ...(reason ? { reason } : {}),
    });
  }
  return { ok: true, steps };
}

export interface IntentGenerateInput {
  baseURL: string;
  apiKey: string;
  model: string;
  prompt: string;
  signal: AbortSignal;
  maxTokens: number;
}

export interface IntentGenerateResult {
  text: string;
}

export type IntentGenerateFn = (input: IntentGenerateInput) => Promise<IntentGenerateResult>;

/** 生产缺省：AI SDK v4 `generateText` + 唯一 provider 工厂（动态 import，避免 rr 拉进 provider）。 */
const defaultGenerate: IntentGenerateFn = async (input) => {
  const [{ generateText }, { createSafeProvider }] = await Promise.all([
    import('ai'),
    import('./ai-provider.js'),
  ]);
  const provider = createSafeProvider({ baseURL: input.baseURL, apiKey: input.apiKey });
  const r = await generateText({
    model: provider(input.model),
    prompt: input.prompt,
    temperature: 0.1,
    maxTokens: input.maxTokens,
    abortSignal: input.signal,
  });
  return { text: r.text ?? '' };
};

/** 只取本模块用得到的那个方法（窄面便于注入/夹具）。 */
export interface IntentModelClient {
  getOptimalModel(params: Record<string, unknown>): Promise<unknown>;
}

export interface ComfortModelRunDeps {
  getAnsClient(): Promise<IntentModelClient>;
  generate?: IntentGenerateFn;
}

/**
 * 跑一次模型兜底。**永不抛出**：取不到模型 / 超时 / 回包不合规都返回 `{ok:false, reason}`，
 * 由 `resolveComfortIntent` 原样回规则的失败原因（不假装执行、不落半份计划）。
 */
export async function runComfortModelPlan(
  input: { room: string; feeling: ComfortFeeling; devices: AnsDevice[] },
  deps: ComfortModelRunDeps,
): Promise<{ ok: true; steps: IntentStep[] } | { ok: false; reason: string }> {
  const usable = modelPlanDevices(input.devices, input.room);
  if (usable.length === 0) return { ok: false, reason: 'no_usable_device' };

  let client: IntentModelClient;
  try {
    client = await deps.getAnsClient();
  } catch {
    return { ok: false, reason: 'ans_unavailable' };
  }

  const m = (await client.getOptimalModel(auxModelRequest({ strategy: 'balanced' }))) as
    | { url?: string; api_key?: string; model_name?: string }
    | null
    | undefined;
  if (!m?.url || !m?.api_key || !m?.model_name) return { ok: false, reason: 'no_model' };

  const generate = deps.generate ?? defaultGenerate;
  let text = '';
  try {
    const r = await generate({
      baseURL: m.url,
      apiKey: m.api_key,
      model: m.model_name,
      prompt: buildModelPlanPrompt({ room: input.room, feeling: input.feeling, devices: usable }),
      signal: AbortSignal.timeout(INTENT_MODEL_TIMEOUT_MS),
      maxTokens: INTENT_MODEL_MAX_OUTPUT_TOKENS,
    });
    text = String(r?.text ?? '');
  } catch (e) {
    return { ok: false, reason: `model_call_failed: ${(e as Error)?.message || String(e)}` };
  }
  return parseModelPlan(text, usable);
}
