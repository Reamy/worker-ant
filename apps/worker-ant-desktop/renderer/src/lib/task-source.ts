/** 任务来路词表（`wa_tasks.source`）：列表与详情页同引这一份；表外取值原样返回，不伪造成已知词。 */
const TASK_SOURCE_LABEL: Record<string, string> = {
  user: '你创建',
  agent: '智能体',
  'auto-decompose': '自动拆解',
  'auto-decompose-roll': '滚动拆解',
  cron: '定时',
  template: '模板',
};

export function taskSourceLabel(source: unknown): string {
  const s = String(source ?? '');
  return TASK_SOURCE_LABEL[s] || s;
}
