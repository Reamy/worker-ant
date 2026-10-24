/**
 * 10.1: 声明式策略引擎（从原工蚁 policy-engine.ts 移植，内置默认策略，无 yaml 依赖）。
 * 支持条件: cost(费用/token), error_rate(失败率)
 * 支持动作: pause_task(暂停), notify_admin(通知), switch_model(切换策略)
 */
import { createLogger } from './logger.js';

const logger = createLogger('policy-engine');

interface PolicyCondition {
  type: 'cost' | 'error_rate';
  threshold: number;
  metric?: 'usd' | 'tokens';
  window?: number;
}

interface PolicyAction {
  type: 'pause_task' | 'notify_admin' | 'switch_model';
  message?: string;
  strategy?: string;
}

export interface Policy {
  name: string;
  description?: string;
  conditions: PolicyCondition[];
  actions: PolicyAction[];
}

export interface PolicyMetrics {
  taskCost?: number;
  taskTokens?: number;
  /**
   * zx_20261012_2 批一（口径归位）: 由裸 `number` 改 **`(window) => number`**。
   *
   * 窗口是**条件自己的**属性（`condition.window`），故"最近 N 个任务里有多少失败"这件事
   * 只能由**调用方**答——它才碰得到库。这个签名本身就是"`window` 必须被真读"的**类型层保证**：
   * 此前是 `number`，调用方自己数了个"全时段失败数"塞进来，`condition.window: 10` 写了也**从没人看**，
   * 于是项目历史 5 个失败 + 一个**刚开跑 1 秒**的新任务 ⇒ 5 ≥ 阈值 5 ⇒ 当场误熔断
   * （实机事故链见 plans/improve/zx_20261012_2.md §1.1）。
   */
  projectRecentFailures?: (window: number) => number;
}

/**
 * 内置默认策略（对应原 data/policies.yml）——**唯一真源**。
 * zx_20261012_2 批一: 导出供 `policy-config.loadPolicies` 作逐字段回落的底
 * （缺省阈值/窗口只此一份，种子表不手抄）。
 */
export const DEFAULT_POLICIES: Policy[] = [
  {
    name: 'budget_hard_limit',
    description: 'Token预算超限硬暂停',
    conditions: [{ type: 'cost', threshold: 3_000_000, metric: 'tokens' }],
    actions: [{ type: 'pause_task', message: '任务Token消耗超出预算上限，已暂停，请人工确认是否继续。' }],
  },
  {
    name: 'failure_cascade_guard',
    description: '项目连续失败过多时暂停',
    conditions: [{ type: 'error_rate', threshold: 5, window: 10 }],
    actions: [{ type: 'pause_task', message: '项目近期失败过多，已暂停新任务，请检查项目配置。' }],
  },
  {
    name: 'failure_notify',
    description: '项目近期有失败时通知',
    conditions: [{ type: 'error_rate', threshold: 3, window: 10 }],
    actions: [{ type: 'notify_admin', message: '项目近期任务失败率偏高，请关注。' }],
  },
];

export interface PolicyResult {
  triggered: boolean;
  actions: Array<{ type: string; message?: string; strategy?: string }>;
}

/**
 * 评估策略：根据当前指标返回触发的动作列表。
 * zx_20261012_2 批一: 新增 `policies` 形参（缺省 `DEFAULT_POLICIES`）——由**调用方**把
 *   `loadPolicies(db)` 读得的（可被用户改过的）策略传进来；本模块仍保持**零 DB 依赖**，只做判据。
 */
export function evaluatePolicies(metrics: PolicyMetrics, policies: readonly Policy[] = DEFAULT_POLICIES): PolicyResult {
  const actions: PolicyResult['actions'] = [];
  for (const policy of policies) {
    for (const condition of policy.conditions) {
      let triggered = false;
      if (condition.type === 'cost') {
        const value = condition.metric === 'tokens' ? (metrics.taskTokens ?? 0) : (metrics.taskCost ?? 0);
        if (value >= condition.threshold) triggered = true;
      } else if (condition.type === 'error_rate') {
        // zx_20261012_2 批一: `condition.window` **首次被真读**——取数（按该窗口）交给调用方答。
        const recent = metrics.projectRecentFailures?.(condition.window ?? 0) ?? 0;
        if (recent >= condition.threshold) triggered = true;
      }
      if (triggered) {
        logger.warn({ policy: policy.name }, '策略触发');
        for (const action of policy.actions) actions.push({ type: action.type, message: action.message, strategy: action.strategy });
        break;
      }
    }
  }
  return { triggered: actions.length > 0, actions };
}

/**
 * 强制重新加载策略。zx_20261012_2 批一（如实化）: **无缓存故无需 reload**——
 *   本模块不持有任何可变策略副本；每次 `evaluatePolicies` 都由调用方把策略
 *   （`policy-config.loadPolicies(db)` 现读库）传进来。保留本函数只为兼容既有 import，
 *   它**不读库、不缓存**，是一个有注的恒等空操作（此前注释只说"无需 reload"，没说为什么）。
 */
export function reloadPolicies(): void { /* 无缓存，策略每次由调用方传入 */ }
