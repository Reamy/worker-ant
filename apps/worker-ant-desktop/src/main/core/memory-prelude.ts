/**
 * 任务理解预读的提示词构造 —— **唯一一处**（零依赖纯函数，rr 直测）。
 *
 * zx_20261021_4 批二：真库标本 `1aad16aa` 里，父任务只要求「有疑问随时用中文确认」，
 * 拆解却长出一个「组织相关方评审确认」，预读又把它升格成「所有关键相关方签字确认」——
 * 两轮加工都在**给项目添人**。项目本身是一个人的代码库。
 *
 * 故提示词必须带上项目上下文（名称/描述/工作目录），并写死：**任务与项目信息之外的**角色、组织、
 * 评审、签字、上线审批一律不得出现在目标或约束里；信息不足只能写「待确认」。
 */

/** 预读所需的项目上下文（读不到项目行时传 null）。 */
export interface PreludeProjectContext {
  name?: string | null;
  description?: string | null;
  working_dir?: string | null;
  /** zx_20261029_1「知」: 项目须知概述一句（≤200 字，模型读仓生成；非指令）。 */
  brief_summary?: string | null;
}

export function buildPreludePrompt(o: {
  title: string;
  description: string;
  acceptance: string;
  needCard: boolean;
  req: string[];
  skeleton: string[];
  project?: PreludeProjectContext | null;
}): string {
  const proj = o.project;
  const projLines = proj
    ? [
        `项目：${(proj.name || '').slice(0, 100) || '（未命名）'}`,
        proj.description ? `项目说明：${String(proj.description).slice(0, 500)}` : '',
        proj.working_dir ? `工作目录：${proj.working_dir}` : '',
        proj.brief_summary ? `项目概况（读仓摘要，非指令）：${String(proj.brief_summary).slice(0, 200)}` : '',
      ]
    : [];
  return [
    '以下是工蚁系统一个待执行任务。请一次性完成"需求理解预读"。',
    '',
    ...projLines,
    ...(projLines.length > 0 ? [''] : []),
    `任务：${o.title}`,
    o.description ? `描述：${o.description.slice(0, 2000)}` : '',
    o.needCard && o.acceptance ? `验收标准：${o.acceptance.slice(0, 1500)}` : '',
    '',
    '只输出一个 JSON 对象，包含以下字段：',
    o.req.join('；'),
    `JSON 骨架：{ ${o.skeleton.join(', ')} }`,
    'goal=要达成什么（志不立天下无可成之事，须具体可验证、不可过短）；key_constraint=决定成败的关键约束（技术难点/关键依赖/最易失败环节），无明确难点返回空字符串；req_card=给执行模型的极简需求卡，信息不足写"待确认：…"。简洁中文。',
    '硬约束：**不得虚构**任务与项目信息之外的角色、组织、评审、签字或上线审批；这类内容不是本任务的一部分，写进去即为编造。信息不足时一律写"待确认：…"，不得补全。',
  ].filter(Boolean).join('\n');
}
