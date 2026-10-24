/**
 * 项目详情「自适应策略 / 多维度健康视图 / 调参历史」词表的**唯一真源**。
 *
 * 病根（与 `status-view.ts`／`deliverable-view.ts` 同一病形）：面板把**内部键**直接打给用户——
 * 模型档显示 `capability-best`，健康指标显示 `costEfficiency`/`deadlineRisk`，调参历史里
 * 还夹着状态码 `completed`/`failed` 与裸浮点 `0.4499999999999999`。内部键是机器协议的一部分，
 * 不该成为用户读到的词；"看不懂"还会被误读成"系统没数据"。
 *
 * 取值域源头（改这些域时两处须同批）：
 * - 模型档：`src/main/core/feedback-engine.ts` 的 `MODEL_TIER_LADDER`（另含 ANS 侧 `latency-optimal`）；
 * - 健康视图：`src/main/ipc/project.ipc.ts` 的 `project:healthViews`；
 * - 调参历史：`feedback-engine.ts` 写入 `strategy_adjustments` 的字符串形。
 *
 * 不认识的值**如实回显原值**（调用方用 `statusText`）——"不认识"不等于"可以编一个中文名"。
 */

export const MODEL_STRATEGY_LABEL: Record<string, string> = {
  'cost-optimal': '成本优先',
  balanced: '均衡',
  'capability-best': '能力优先',
  'latency-optimal': '延迟优先',
};

/** 健康视图三视角（`project:healthViews` 的顶层键）。 */
export const HEALTH_VIEW_LABEL: Record<string, string> = {
  investor: '投资人',
  developer: '开发者',
  manager: '管理者',
};

/**
 * 健康指标键 → 中文名。键域与 `project:healthViews` 的返回对象**同集**；
 * 指标值本身是 0–100 的合成分（无单位可加），故只译名、不改值。
 */
export const HEALTH_METRIC_LABEL: Record<string, string> = {
  // 投资人
  roi: '投入产出',
  costEfficiency: '成本效率',
  valueDeliveryRate: '价值交付率',
  // 开发者
  codeQuality: '代码质量',
  toolHealth: '工具健康度',
  technicalDebt: '技术债',
  errorRate: '错误率',
  // 管理者
  velocity: '近7日完成率',
  resourceUtilization: '资源利用率',
  deadlineRisk: '延期风险',
  blockedTaskCount: '阻塞任务数',
  // 与上方橙色说明句同指（`parkedTaskCount` 除指标行外还有一句「N 个待办未自动拉起」）
  parkedTaskCount: '待办搁置数',
};

/** 调参历史里的内部字段名 → 中文名（`feedback-engine.ts` 的写入形：`model: …`、`maxSteps: …`、`temperature: …`）。 */
const ADJUSTMENT_FIELD_LABEL: Array<[RegExp, string]> = [
  [/\bmodel:\s*/g, '模型策略：'],
  [/\bmaxSteps:\s*/g, '最大步数：'],
  [/\btemperature:\s*/g, '温度：'],
  // 熔断文案里的从句形（`…暂不升：model 保持 capability-best`）
  [/\bmodel 保持/g, '模型策略保持'],
];

/**
 * 历史调参字符串的**展示形**：只换词、不改值。
 * 浮点收敛到两位——库内存的是连乘结果（`0.24999999999999994`），原样打给用户是机器口音。
 */
export function formatStrategyAdjustment(text: unknown): string {
  let s = String(text ?? '');
  for (const [re, label] of ADJUSTMENT_FIELD_LABEL) s = s.replace(re, label);
  for (const [key, label] of Object.entries(MODEL_STRATEGY_LABEL)) s = s.split(key).join(label);
  return s.replace(/(\d+\.\d{3,})/g, (m) => String(Math.round(Number(m) * 100) / 100));
}

/** `strategy_adjustments[].adjustments`：数组逐条 `；` 连接（此前 `JSON.stringify` 会把引号/方括号一起上屏）。 */
export function formatStrategyAdjustments(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => formatStrategyAdjustment(v)).join('；');
  if (value && typeof value === 'object') return formatStrategyAdjustment(JSON.stringify(value));
  return formatStrategyAdjustment(value);
}

/** 温度等小数：两位；空值 `—`（"没记过"不伪造成 0）。 */
export function formatStrategyNumber(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Number(v).toFixed(digits);
}
