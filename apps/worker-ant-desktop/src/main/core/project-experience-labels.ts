/**
 * zx_20261121_1 M4「数·尺」：项目经验账的**纯词表**（零依赖，渲染层可引）。
 *
 * 只放阈值、人话名与“已知拒绝类别 → 确定性建议”的映射。
 * 派生/取数/渲染在 `project-experience.ts`（链上有 better-sqlite3，渲染层不得引）。
 */

/** 经验段自身的 token 上界（从既有 400 token 知识预算内替换，不新增总量）。 */
export const EXPERIENCE_INJECT_MAX_TOKENS = 120;
/** 统计窗口（天）。 */
export const EXPERIENCE_WINDOW_DAYS = 90;
/** 证据门槛：完成单数 / 单形态样本 / 工具调用总数 / 坑总数 / 失败因总数。 */
export const EXPERIENCE_MIN_COMPLETED = 5;
export const EXPERIENCE_MIN_ARCHETYPE_TASKS = 3;
export const EXPERIENCE_MIN_TOOL_CALLS = 10;
export const EXPERIENCE_MIN_PITFALLS = 3;
export const EXPERIENCE_MIN_FAILURES = 3;

/** 已知 `deny_kind` → 可执行建议。未知 kind 不给建议（只计数）。 */
export const PITFALL_ADVICE: Record<string, string> = {
  illegal_char: 'bash 不支持换行/管道/命令替换；拆成多条只读命令，写文件用 write_file。',
  exploration_limit: '探索配额耗尽；先用 search_content 定位目标文件，别枚举整树。',
  redirect: '重定向写文件被禁止；改用 write_file。',
  not_in_whitelist: '命令不在只读白名单；换等价只读命令，或走 execute_command 的特权路径。',
  destructive: '破坏性命令被拦；走确认/特权路径，不要重试原命令。',
};

export const PITFALL_LABEL: Record<string, string> = {
  illegal_char: '命令含非法字符/换行/管道',
  exploration_limit: '探索配额耗尽',
  redirect: '重定向写文件被拒',
  not_in_whitelist: '命令不在只读白名单',
  destructive: '破坏性命令被拦',
  other: '其他拒绝',
};

/** 经验来源（注入账 `source`）。 */
export const EXPERIENCE_INJECTION_SOURCE = 'project_experience';
export const EXPERIENCE_SECTION_TITLE = '项目经验';

/** 纯文本里最多保留的失败因/坑条数。 */
export const EXPERIENCE_TOP_PITFALLS = 2;
export const EXPERIENCE_TOP_FAILURES = 2;
