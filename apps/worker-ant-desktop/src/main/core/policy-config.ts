/**
 * zx_20261012_2 批一（「策略可配」）: 策略阈值/窗口的**唯一 DB 真源**。
 *
 * 病灶（plans/improve/zx_20261012_2.md §1.2-6）：阈值/窗口/动作全写死在 `policy-engine.ts` 的
 * `DEFAULT_POLICIES`，`wa_settings` 里一个 `policy.*` 键都没有 ⇒ 用户在 GUI 无处可调、只能 DB 直改；
 * 而 `reloadPolicies()` 又是有注的 no-op。本模块把「缺省回落 + 取数」收成**一处**：
 *   · `POLICY_OVERRIDES`（转自 `policy-keys.ts`，与渲染层共用）/ `policySettingDefaults()` ——
 *     五个数值键及其缺省（缺省**由 DEFAULT_POLICIES 派生**，不手抄）；
 *   · `loadPolicies(db)` —— 逐键读库，读不到/脏值一律回落缺省（键名与默认值只此一份）；
 *   · `countRecentFailures(db, projectId, window)` —— **唯一**的"窗内失败数"取数实现。
 *
 * `policy-engine` 保持**零 DB 依赖**（只做判据），取数与配置都在这一侧。
 */
import { DEFAULT_POLICIES, type Policy } from './policy-engine.js';
// 键名映射**纯数据**另置零依赖模块：主进程与渲染层两侧共用同一份，且不让渲染层经本模块
//   （→ policy-engine → logger(pino)）拖进 node 依赖。
import { POLICY_OVERRIDES, type PolicyOverride } from './policy-keys.js';
export { POLICY_OVERRIDES };
// 复用 `settings-bool` 的**最小库接口**（只 prepare().run()/.get()/.all()，故本模块可脱 better-sqlite3，
//   在受控回归里跑真逻辑）——结构同形即复用，不再抄第二份接口定义。
import type { BoolSettingDb as SettingsDb } from './settings-bool.js';

/** 某覆盖项的缺省值——**由 `DEFAULT_POLICIES` 现算**，不在此写第二份数字。 */
function defaultOf(o: PolicyOverride): number {
  const p = DEFAULT_POLICIES.find((x) => x.name === o.policy);
  const v = p?.conditions[o.conditionIndex]?.[o.field];
  return typeof v === 'number' ? v : 0;
}

/** 首启种子用：每个键 + 其缺省值（缺省由 `DEFAULT_POLICIES` 派生，不手抄）。 */
export function policySettingDefaults(): Array<[string, string]> {
  return POLICY_OVERRIDES.map((o) => [o.key, String(defaultOf(o))]);
}

/** 读一条**数值** setting（缺省回落给定值）。空 / 非有限数 / 负数一律按缺省处理。 */
function readNumberSetting(db: SettingsDb, key: string, fallback: number): number {
  try {
    const row = db.prepare('SELECT value FROM wa_settings WHERE key = ?').get(key) as { value?: string } | undefined;
    if (row?.value == null || row.value === '') return fallback;
    const n = Number(row.value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  } catch { return fallback; }
}

/**
 * 读库组装策略：以 `DEFAULT_POLICIES` 为底，逐键覆盖数值字段。
 * 返回**深拷贝**——调用方拿到的数组与 `DEFAULT_POLICIES` 不共享条件/动作对象，
 * 免"某处改了阈值，别处跟着变"（`DEFAULT_POLICIES` 是模块级常量，绝不可被就地改）。
 */
export function loadPolicies(db: SettingsDb): Policy[] {
  const clone: Policy[] = DEFAULT_POLICIES.map((p) => ({
    ...p,
    conditions: p.conditions.map((c) => ({ ...c })),
    actions: p.actions.map((a) => ({ ...a })),
  }));
  for (const o of POLICY_OVERRIDES) {
    const v = readNumberSetting(db, o.key, defaultOf(o));
    const c = clone.find((x) => x.name === o.policy)?.conditions[o.conditionIndex];
    if (c) c[o.field] = v;
  }
  return clone;
}

/**
 * 「项目最近 `window` 个任务里有多少个失败」——**唯一**实现。
 *
 * zx_20261012_2 批一（口径归位）：旧码写作
 *   `SELECT COUNT(*) FROM wa_tasks WHERE project_id=? AND status='failed' ORDER BY … LIMIT 10`
 * —— `COUNT(*)` 只回**一行**，`ORDER BY … LIMIT` 于是**空转**，数的其实是**全时段**失败数
 * （事故：项目历史 5 个失败 + 一个**刚开跑 1 秒**的新任务 ⇒ 5 ≥ 阈值 5 ⇒ 当场误熔断，§1.1）。
 * 正确口径：**先**按"最近 window 个"取行集，**再**在其中数 failed。
 *
 * `rowid` 作次级键求**确定性**——`created_at` 是秒级文本，同秒多行时 `LIMIT` 才有唯一答案。
 * `window <= 0` ⇒ 不设窗（数全部），与"条件没写 window"同向。
 */
export function countRecentFailures(db: SettingsDb, projectId: string, window: number): number {
  try {
    if (!(window > 0)) {
      return (db.prepare("SELECT COUNT(*) AS c FROM wa_tasks WHERE project_id = ? AND status = 'failed'").get(projectId) as { c: number }).c;
    }
    return (db.prepare(
      "SELECT COUNT(*) AS c FROM (SELECT status FROM wa_tasks WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) WHERE status = 'failed'"
    ).get(projectId, window) as { c: number }).c;
  } catch { return 0; }
}
