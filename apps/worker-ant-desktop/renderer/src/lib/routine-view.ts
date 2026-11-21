/**
 * zx_20261120_1 M3：岗位例行的人话词表（**lib/ 一处**，页面不自持第二份）。
 *
 * 与 main 侧 `RoutineSkipReason` / `ROUTINE_RUN_STATUSES` 一一对应；词表外的值原样显示
 * （不假装它属于某一态）。
 */
export const ROUTINE_SKIP_LABEL: Record<string, string> = {
  routine_disabled: '例行已停用',
  project_inactive: '项目不在启用状态',
  position_disabled: '岗位已停用',
  binding_disabled: '该岗位未在此项目启用',
  previous_run_open: '上一单还没结束（等人或还在跑）',
  period_duplicate: '这一期已经跑过',
  bad_fire_time: '触发时刻无法识别',
  not_found: '例行已不存在',
};

export const ROUTINE_RUN_STATUS_LABEL: Record<string, string> = {
  created: '已建单',
  completed: '完成',
  failed: '失败',
  archived: '已归档',
  skipped: '跳过',
};

export function routineSkipLabel(reason: string | null | undefined): string {
  const s = String(reason ?? '');
  return ROUTINE_SKIP_LABEL[s] ?? s;
}

export function routineStatusLabel(status: string | null | undefined): string {
  const s = String(status ?? '');
  return ROUTINE_RUN_STATUS_LABEL[s] ?? s;
}
