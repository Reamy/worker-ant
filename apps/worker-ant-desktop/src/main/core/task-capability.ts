/**
 * zx_20261106_3 B1「协」（维特根斯坦·意义即用法 / 韩非·循名责实）: **任务需要什么能力**的唯一派生处。
 *
 * 病根：外派只看"本机是否溢出"，从不问"这件事需要什么、哪台机器更合适"。本模块把需求拆成
 *   类目 / 意图 / 设备品类三面，供 `node-match` 与 `capability-dispatch` 使用。
 *
 * 三条纪律：
 *   ① **只复用既有词表**（`NODE_CARD_CATEGORIES` / `publicIntents()` / `DEVICE_KIND_CLASSES`），不另写一份；
 *   ② **任一非法即整块作废**（模型写错一个词，整块不可信），调用方回退规则派生；
 *   ③ **写库只加一个键**（`context_json.dispatch_requirements`），用 `json_set` 合并不整份覆写——
 *      `context_json` 的兄弟键（附件/目标/方案等）不能被这一笔抹掉。
 *
 * ⚠ `derive` / `sanitize` 是**纯函数**（无 DB / 网络 / 时钟），rr 可直跑真实现。
 */
import type Database from 'better-sqlite3';
import { isNodeCardCategory, type NodeCardCategory } from '@worker-ant/shared-types';
import { DEVICE_KIND_CLASSES, type DeviceKindClass } from './device-kind.js';
import { publicIntents } from './intent-protocol.js';
import { classifyArchetypeKeyword, type TaskArchetype } from './task-archetype.js';
import { routeCategoryForArchetype, routeCategoryForTask } from './task-routing.js';

/** context_json 里的键名（唯一一处手写；读写同引）。 */
export const DISPATCH_REQUIREMENTS_KEY = 'dispatch_requirements';

export type RequirementsSource = 'rule' | 'decompose' | 'merged';

/** 一件任务的外派需求。`categories` 为空 ＝ 不满足任何能力面（对话/判不出），调用方不得据此外派。 */
export interface DispatchRequirements {
  categories: NodeCardCategory[];
  intents: string[];
  deviceClasses: DeviceKindClass[];
  /** 0..1；规则派生有类目 0.6、无类目 0.2；拆解声明 0.85。 */
  confidence: number;
  source: RequirementsSource;
}

const REQUIREMENT_SOURCES: readonly RequirementsSource[] = ['rule', 'decompose', 'merged'];

const INTENT_IDS = new Set(publicIntents().map((i) => i.id));
/** `unknown` 不算一类能力（无从匹配），声明它即视为非法。 */
const DEVICE_CLASSES = new Set<string>(DEVICE_KIND_CLASSES.filter((c) => c !== 'unknown'));

function unique<T>(arr: readonly T[]): T[] {
  return [...new Set(arr)];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * 把模型/旧账里的一段需求洗成合法形状；**任一项非法 ⇒ `null`**（整块作废，不挑着用）。
 * 允许空数组（＝该面没有要求），但键必须在场且为数组。
 */
export function sanitizeDispatchRequirements(raw: unknown): DispatchRequirements | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!isStringArray(o.categories) || !isStringArray(o.intents) || !isStringArray(o.deviceClasses)) return null;
  if (!o.categories.every((c) => isNodeCardCategory(c))) return null;
  if (!o.intents.every((i) => INTENT_IDS.has(i))) return null;
  if (!o.deviceClasses.every((d) => DEVICE_CLASSES.has(d))) return null;
  const confidence = typeof o.confidence === 'number' && Number.isFinite(o.confidence) && o.confidence >= 0 && o.confidence <= 1
    ? o.confidence
    : null;
  if (confidence === null) return null;
  if (typeof o.source !== 'string' || !(REQUIREMENT_SOURCES as readonly string[]).includes(o.source)) return null;
  return {
    categories: unique(o.categories as NodeCardCategory[]),
    intents: unique(o.intents),
    deviceClasses: unique(o.deviceClasses as DeviceKindClass[]),
    confidence,
    source: o.source as RequirementsSource,
  };
}

export interface DeriveRequirementsInput {
  title?: unknown;
  description?: unknown;
  /** 已由调用方判好的形态；给了就不再重判（避免同一段文字两处得出不同结论）。 */
  archetype?: TaskArchetype | null;
}

/**
 * 规则派生：只给**类目**（关键词形态 → 类目）；意图/设备品类规则判不出，**留空而不猜**。
 * 判不出类目（对话/模糊）⇒ `categories=[]`，置信度 0.2 —— 这是"不该外派"的诚实表达。
 */
export function deriveTaskRequirements(input: DeriveRequirementsInput): DispatchRequirements {
  const title = String(input.title ?? '').trim();
  const description = String(input.description ?? '').trim();
  const text = `${title} ${description}`.trim();
  if (!text && !input.archetype) {
    return { categories: [], intents: [], deviceClasses: [], confidence: 0, source: 'rule' };
  }
  const archetype = input.archetype ?? classifyArchetypeKeyword(text);
  const category = input.archetype !== undefined
    ? (input.archetype ? routeCategoryForArchetype(input.archetype) : null)
    : routeCategoryForTask(title, description);
  if (!category) {
    return { categories: [], intents: [], deviceClasses: [], confidence: 0.2, source: 'rule' };
  }
  return { categories: [category], intents: [], deviceClasses: [], confidence: 0.6, source: 'rule' };
}

/** 模型给的一串能力词 → 需求；任一词不在三份词表里 ⇒ `null`（整块回退）。 */
export function requirementsFromCapabilityWords(words: unknown): DispatchRequirements | null {
  if (!isStringArray(words)) return null;
  const categories: NodeCardCategory[] = [];
  const intents: string[] = [];
  const deviceClasses: DeviceKindClass[] = [];
  for (const w of words) {
    if (isNodeCardCategory(w)) categories.push(w);
    else if (INTENT_IDS.has(w)) intents.push(w);
    else if (DEVICE_CLASSES.has(w)) deviceClasses.push(w as DeviceKindClass);
    else return null;
  }
  return {
    categories: unique(categories),
    intents: unique(intents),
    deviceClasses: unique(deviceClasses),
    confidence: 0.85,
    source: 'decompose',
  };
}

/** 由任务行（标题/描述/已存需求）取需求：合法存档优先，否则规则派生。 */
export function requirementsForTask(input: {
  title?: unknown;
  description?: unknown;
  contextJson?: string | Buffer | null;
}): DispatchRequirements {
  let ctx: Record<string, unknown> = {};
  try {
    const s = Buffer.isBuffer(input.contextJson) ? input.contextJson.toString('utf-8') : String(input.contextJson ?? '');
    const parsed = s ? JSON.parse(s) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ctx = parsed as Record<string, unknown>;
  } catch { /* 坏 JSON 按无存档处理 */ }
  const stored = sanitizeDispatchRequirements(ctx[DISPATCH_REQUIREMENTS_KEY]);
  return stored ?? deriveTaskRequirements({ title: input.title, description: input.description });
}

/**
 * 写需求：**只 `json_set` 一个键**（不整份覆写），任务不存在/写失败 ⇒ `false`（如实）。
 * 调用方在派发前后都可以调；重复写同值是幂等的。
 */
export function writeDispatchRequirements(
  db: Database.Database,
  taskId: string,
  req: DispatchRequirements,
): boolean {
  try {
    const r = db
      .prepare("UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json,'{}'), '$.dispatch_requirements', json(?)), updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(req), taskId) as { changes?: number } | undefined;
    return (r?.changes ?? 0) > 0;
  } catch {
    return false;
  }
}
