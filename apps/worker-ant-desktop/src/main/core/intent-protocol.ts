/**
 * 意图协议（zx_20261018_1 批二「意」）——**唯一的意图词表与参数校验处**。
 *
 * 口径（维特根斯坦·意义即用法 ／ 道德经·名可名非常名）：外部终端说一句"人话意图"，
 *   本机把它落成**计划**（`intent-plans`）。协议面只认这里列出的 intent 名与参数，
 *   门外报来的任何多余键都**不进入**计划（`utterance` 只落账，不参与解析）。
 *
 * ⚠ 这里**只做词表与形状校验**，不做设备匹配（设备/房间解析在 `home-intent.ts`，
 *   批五接上；本模块不依赖台账，判据可直跑）。
 */
export const INTENT_CAPABILITY = 'intent_control' as const;

/** 本轮开放的意图只有一条（R-37 逐项枚举，不放宽成 `>=`）。 */
export const HOME_COMFORT_INTENT = 'home.comfort';

export type ComfortFeeling = 'hot' | 'cold' | 'dark' | 'bright';

export interface IntentParamSpec {
  key: string;
  label: string;
  required: boolean;
  /** 枚举取值；缺省＝自由字符串。 */
  values?: readonly string[];
}

export interface IntentDescriptor {
  id: string;
  label: string;
  params: IntentParamSpec[];
}

export const COMFORT_FEELINGS: readonly ComfortFeeling[] = ['hot', 'cold', 'dark', 'bright'];

export const INTENTS: readonly IntentDescriptor[] = [
  {
    id: HOME_COMFORT_INTENT,
    label: '居家舒适',
    params: [
      { key: 'room', label: '房间', required: true },
      { key: 'feeling', label: '感受', required: true, values: COMFORT_FEELINGS },
    ],
  },
];

export function intentNames(): string[] {
  return INTENTS.map((i) => i.id);
}

export function findIntent(id: string): IntentDescriptor | null {
  return INTENTS.find((i) => i.id === id) ?? null;
}

export type IntentValidation =
  | { ok: true; intent: string; params: Record<string, unknown> }
  | { ok: false; status: 400; body: { error: 'unknown_intent' | 'invalid_params'; allowed: string[]; errors?: string[] } };

/**
 * 校验门外报来的 `{intent, params}`。
 *   · 未知意图 ⇒ `unknown_intent` + **允许的意图名**（R-13）；
 *   · 未知参数/缺必填/取值不在枚举 ⇒ `invalid_params` + 逐条原因 + 允许的意图名；
 *   · 只回**词表内**的参数（多余键被丢弃，绝不进入计划——R-20 的根）。
 */
export function validateIntent(raw: { intent?: unknown; params?: unknown }): IntentValidation {
  const allowed = intentNames();
  if (typeof raw.intent !== 'string' || raw.intent.trim() === '') {
    return { ok: false, status: 400, body: { error: 'unknown_intent', allowed } };
  }
  const intent = raw.intent.trim();
  const spec = findIntent(intent);
  if (!spec) return { ok: false, status: 400, body: { error: 'unknown_intent', allowed } };

  const params = raw.params;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return { ok: false, status: 400, body: { error: 'invalid_params', allowed, errors: ['params 须为对象'] } };
  }
  const src = params as Record<string, unknown>;
  const errors: string[] = [];
  const out: Record<string, unknown> = {};
  const known = new Set(spec.params.map((p) => p.key));
  for (const key of Object.keys(src)) {
    if (!known.has(key)) errors.push(`不认识的参数：${key}`);
  }
  for (const p of spec.params) {
    const v = src[p.key];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      if (p.required) errors.push(`缺少参数：${p.label}（${p.key}）`);
      continue;
    }
    if (typeof v !== 'string') {
      errors.push(`参数 ${p.key} 须为字符串`);
      continue;
    }
    const trimmed = v.trim();
    if (p.values && !p.values.includes(trimmed)) {
      errors.push(`参数 ${p.key} 取值须为 ${p.values.join('/')} 之一`);
      continue;
    }
    out[p.key] = trimmed;
  }
  if (errors.length > 0) return { ok: false, status: 400, body: { error: 'invalid_params', allowed, errors } };
  return { ok: true, intent, params: out };
}

/** 门外 `/capabilities` 里能看的意图清单——**只有 id/label/参数名**，不含任何设备相关信息。 */
export interface PublicIntentDescriptor {
  id: string;
  label: string;
  params: Array<{ key: string; label: string; required: boolean; values?: string[] }>;
}

export function publicIntents(): PublicIntentDescriptor[] {
  return INTENTS.map((i) => ({
    id: i.id,
    label: i.label,
    params: i.params.map((p) => (p.values ? { key: p.key, label: p.label, required: p.required, values: [...p.values] } : { key: p.key, label: p.label, required: p.required })),
  }));
}
