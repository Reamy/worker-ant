/**
 * zx_20261012_2 批一（策略可配）: 五个可配策略数值键的**唯一名单**——**零依赖**纯数据模块。
 *
 * 为什么单列一个文件：主进程侧（`policy-config` 读库 + 缺省回落）与渲染层（设置页表单）
 * 都需这份映射；而 `policy-config` 经 `policy-engine → logger(pino)` 带出 node 依赖，
 * 渲染层**不可**引它（会把 pino 拖进浏览器包）。故把"键名 → 策略字段"这份纯数据抽出，
 * 两侧共用同一份——不各写一遍（键名散多处即分家，旧病）。
 *
 * 中文标签/说明**不在此**：那是用户可见文案，属渲染层（第二落点纪律：词表两侧各自穷举）。
 */
export interface PolicyOverride {
  key: string;
  policy: string;
  conditionIndex: number;
  field: 'threshold' | 'window';
}

export const POLICY_OVERRIDES: readonly PolicyOverride[] = [
  { key: 'policy.cascade_fail_threshold', policy: 'failure_cascade_guard', conditionIndex: 0, field: 'threshold' },
  { key: 'policy.cascade_fail_window', policy: 'failure_cascade_guard', conditionIndex: 0, field: 'window' },
  { key: 'policy.notify_fail_threshold', policy: 'failure_notify', conditionIndex: 0, field: 'threshold' },
  { key: 'policy.notify_fail_window', policy: 'failure_notify', conditionIndex: 0, field: 'window' },
  { key: 'policy.budget_tokens', policy: 'budget_hard_limit', conditionIndex: 0, field: 'threshold' },
];
