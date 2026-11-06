/**
 * 记忆的**年龄基准**、**半衰期**与**衰减**——一处真源（zx_20260930 M6）。
 *
 * 为什么单开一个零依赖模块：这三个量原来散在 `memory-manager.ts` 四处（14 / 21 / 30 / ≈7 天），
 * 各写各的指数；而**衰减那一条读的是 `updated_at`** —— 可 `updated_at` 是「最后一次被写」，
 * 不是「最后一次被用」，它会被十几处**系统写**刷新（`sameSourceReplace` / `_applyReinforcement` /
 * 冲突合并 / 工具改写 `control.ts` …）⇒ 每一次系统改写都把衰减钟归零，于是"年龄"名实不符。
 * 故此处只认**语义时间戳**：
 *   · `last_used_at`       —— 被检索入文（`recordAccess`）
 *   · `last_reinforced_at` —— 被实践加固（成败反馈）
 *   · `created_at`         —— 落库时刻
 * 三者取最大；`updated_at` **永不参与**。
 *
 * 零 import（同 `memory-constants.ts` 一把尺）：main / rr 双侧都能直接引，判据不必自造等价物。
 */

const MS_PER_DAY = 86_400_000;

/**
 * 半衰期（天）——**按记忆类型派生**，理据逐条写在值旁边。
 * 改这里的值＝改生产行为（记忆活多久、注入多少、token 花多少），故值必须跟着理据走。
 */
export const MEM_HALF_LIFE_DAYS: Record<string, number> = {
  // 情景：一次性事件的"上次这样成了"，最不可外推 ⇒ 最短
  episodic: 7,
  // 可复用的认识与打法：事实、配方、复盘、教训、子代理经验、限制信念
  semantic: 30,
  procedural: 30,
  retrospective: 30,
  prospective: 30,
  failure_knowledge: 30,
  subagent_experience: 30,
  limiting_belief: 30,
  // 用户偏好：人不容易变（且它是注入时的最高优先源之一，忘掉＝每次都问一遍）
  preference: 90,
  // 负空间警告：忘掉会重犯 ⇒ 宁可留
  negative: 90,
  // 整合产物：全项目仅一条，忘掉等于整块理性认识凭空消失
  panorama: 90,
  default: 30,
};

/**
 * 另外三条曲线的**尺度常数**（原来散在 `memory-manager.ts` 里当裸字面量：14 / 21 / 30）。
 *
 * 与上面的半衰期表的关系要说清（《管子》·度量衡）：
 *   · 上面那张表是**衰减曲线**（存储强度随时间打折）——那一路写的是**真半衰期**（`0.5 ** (age/hl)`）；
 *   · 这三条按既有写法是 `exp(-age/τ)` 的**时间常数 τ**，不是半衰期。二者差一个 `ln2`：
 *     `exp(-age/τ)` 的有效半衰期 = `τ·ln2`（14 → 9.7 天 / 21 → 14.6 天 / 30 → 20.8 天）。
 *   故**名字据实写作 τ**，且**值一律不动**——本轮收的是"散落的尺归一处"，不是"顺手改曲线"。
 *   谁要把它改成真半衰期，那是**改生产行为**，须单独立论（既有注释里"半衰期 14 天"是名实不符的旧话）。
 */
export const RETRIEVAL_TAU_DAYS = 14;
export const MATURITY_TAU_DAYS = 21;
export const CONFIDENCE_TAU_DAYS = 30;

/** 效价调制：正面经验衰减更慢（半衰期 ×2）、负面更快（×0.5）。沿用既有语义，只把"率"改述为"半衰期"。 */
const VALENCE_FACTOR: Record<string, number> = { positive: 2, negative: 0.5, neutral: 1 };

/** 核心记忆豁免：半衰期 ×5（原 λ×0.2 的同一件事，改述为半衰期倍数）。 */
export const CORE_HALF_LIFE_FACTOR = 5;
/** 核心记忆的"高使用"门槛（`use_count ≥ 该值` 即豁免）。 */
export const CORE_USE_COUNT = 10;

export interface DecaySubject {
  memory_type?: string | null;
  valence?: string | null;
  source?: string | null;
  use_count?: number | null;
  is_exemplar?: number | null;
  last_used_at?: string | null;
  last_reinforced_at?: string | null;
  created_at?: string | null;
}

/**
 * 库时刻串 → 毫秒。**唯一真源**（原在 `memory-manager.ts`，M6 移入此处避开循环依赖，
 * 由 `memory-manager.ts` 原样再导出，`project-engine.ts` 等既有引点一字不改）。
 *
 * `datetime('now')` 是**无时区**的 UTC 串，`new Date(s)` 会按**本地**解析 ⇒ 本机 UTC+8 下凭空多算
 * 8 小时。故：带 `Z`/偏移的按原样，否则把空格换成 `T` 并补 `Z`。
 * 空串 / `null` 返 `NaN`（**不是 0**）——"没有值"与"零时刻"是两回事，调用方须自己选守卫。
 */
export function dbTimeMs(raw: string | null | undefined): number {
  const s = raw == null ? '' : String(raw).trim();
  if (!s) return NaN;
  return new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : s.replace(' ', 'T') + 'Z').getTime();
}

/** 距今多少天（`NaN` ⇒ 0 天，即"取不到时刻就当作刚发生"，不制造负年龄）。 */
export function ageDaysSince(raw: string | null | undefined, nowMs: number = Date.now()): number {
  const ms = dbTimeMs(raw);
  return Number.isNaN(ms) ? 0 : Math.max(0, (nowMs - ms) / MS_PER_DAY);
}

/**
 * 记忆的**年龄**：三个语义时间戳里最新的那个距今天数。
 * 刻意**不读 `updated_at`**：系统改写（降权、合并冲突、工具改写内容）只说明"被写过"，
 * 不说明"被用过"；拿它当年龄会让每一次系统改写都白送一轮新的半衰期。
 */
export function memoryAgeDays(mem: DecaySubject, nowMs: number = Date.now()): number {
  const stamps = [mem.last_used_at, mem.last_reinforced_at, mem.created_at]
    .map((s) => dbTimeMs(s))
    .filter((ms) => !Number.isNaN(ms));
  if (stamps.length === 0) return 0;
  return Math.max(0, (nowMs - Math.max(...stamps)) / MS_PER_DAY);
}

/** 该记忆是否属"核心"（用户指令/纠正、高使用、范例、负空间警告）。 */
export function isCoreMemory(mem: DecaySubject): boolean {
  return mem.source === 'user_instruction' || mem.source === 'user_correction'
    || (mem.use_count ?? 0) >= CORE_USE_COUNT || mem.is_exemplar === 1
    || mem.memory_type === 'negative';
}

export function baseHalfLifeDays(memoryType?: string | null): number {
  return MEM_HALF_LIFE_DAYS[memoryType ?? ''] ?? MEM_HALF_LIFE_DAYS.default!;
}

/** 该记忆的**有效半衰期**（天）= 类型基准 × 效价 × 核心豁免。 */
export function halfLifeDays(mem: DecaySubject): number {
  const base = baseHalfLifeDays(mem.memory_type);
  const valence = VALENCE_FACTOR[mem.valence ?? 'neutral'] ?? 1;
  const core = isCoreMemory(mem) ? CORE_HALF_LIFE_FACTOR : 1;
  return base * valence * core;
}

/**
 * 衰减因子 ∈ (0,1]：`0.5 ** (age / halfLife)`。
 * 写作 `0.5 **` 而非 `exp(-λ·age)`——同一件事，但"半衰期"这个名字直接看得见（λ 的半衰期是隐式的）。
 */
export function decayFactor(mem: DecaySubject, ageDays?: number, nowMs: number = Date.now()): number {
  const age = ageDays ?? memoryAgeDays(mem, nowMs);
  const hl = halfLifeDays(mem);
  if (!(hl > 0)) return 1;
  return Math.pow(0.5, age / hl);
}
