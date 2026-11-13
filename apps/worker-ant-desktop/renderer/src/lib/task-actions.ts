/**
 * zx_20261112_1 B4「诊」——任务操作**分层**的唯一真源（零依赖纯模块）。
 *
 * 病根：任务详情页的动作栏是一串按状态**各写一遍**的条件按钮（挂附件 / 执行 / 暂停 / 恢复 /
 *   追加输入 / 重试 / 完成 / 归档 / 重新执行 / 删除 混排），于是
 *   ① 同一张任务在不同状态下"哪个是主操作"要靠用户自己读完全部按钮；
 *   ② 危险动作（中止/归档/删除）与日常动作同色同排，误点成本高；
 *   ③ 新增状态时忘改一处就是"按钮消失"，且没有任何判据能说清"这个状态该有哪些动作"。
 *
 * 治法：把「状态 → {primary, secondary, danger}」收成**一处纯映射**。页面只负责画，
 *   handler 原样复用（不改任何动作语义，确认弹窗仍在各 handler 内）。
 *
 * 口径：
 *   - **至多一个** `primary`。机器自己在跑/在排的态（planning/preparing/investigating）
 *     没有"该由人点的下一件事" ⇒ `null`，不硬凑一个。
 *   - `secondary` 进「更多操作」折叠，但**仍可达**（不是删除）。
 *   - `danger` 单独一组、红色、各处 handler 自带确认。
 */

export type TaskActionKey =
  | 'attach'
  | 'execute'
  | 'pause'
  | 'interrupt'
  | 'resume'
  | 'requeue'
  | 'reply'
  | 'inject'
  | 'retry'
  | 'rerun'
  | 'complete'
  | 'archive'
  | 'delete'
  | 'create_from_original';

export const ACTION_LABEL: Record<TaskActionKey, string> = {
  attach: '挂附件',
  execute: '执行',
  pause: '暂停',
  interrupt: '中止',
  resume: '恢复',
  requeue: '放回队列',
  reply: '回复',
  inject: '追加输入',
  retry: '重试',
  rerun: '重新执行',
  complete: '标记完成',
  archive: '归档',
  delete: '删除',
  create_from_original: '以原题面新建',
};

/**
 * 按钮说明（`title`）。与动作键同处一表，页面不手抄第二份。
 * `inject` 的说明按状态分：执行中是"注入"，已完成是"重新打开并继续"——两件事，不能合成一句。
 */
export function actionTitle(key: TaskActionKey, status?: string): string {
  switch (key) {
    case 'attach': return '挂本地文件：落盘并写进任务上下文，下一次执行/回复即带上';
    case 'execute': return '执行';
    case 'pause': return status === 'stabilizing' ? '暂停（转人工暂停态，可随时恢复）' : '暂停';
    case 'interrupt': return '中止（立即中断当前执行）';
    case 'resume': return '恢复（保留对话继续）';
    case 'requeue': return '确认并放回队列（等下一轮调度自动拉起）';
    case 'reply': return '回复（输入内容后恢复任务）';
    case 'inject': return status === 'completed'
      ? '追加输入（任务重新打开并带此输入继续）'
      : '追加输入（执行中注入提示，任务带新输入继续）';
    case 'retry': return '重试（清空对话从零开始）';
    case 'rerun': return '重新执行';
    case 'complete': return '标记完成';
    case 'archive': return '归档（放弃）——弃 ≠ 败：它不再计入失败，也不阻塞父任务收口';
    case 'delete': return '删除';
    case 'create_from_original': return '以原题面新建：标题/描述/验收标准取自本任务，原任务仍保持已归档';
  }
}

export interface TaskActionLayout {
  /** 至多一个；`null` = 这个态没有"该由人点的下一件事"（机器在跑/在排）。 */
  primary: TaskActionKey | null;
  /** 「更多操作」折叠内。 */
  secondary: TaskActionKey[];
  /** 红色一组，handler 自带确认。 */
  danger: TaskActionKey[];
}

const RUNNING = new Set(['executing', 'running']);

/** 状态 → 动作分层。未知状态：不猜动作（只有挂附件），不抛。 */
export function taskActionLayout(status: string): TaskActionLayout {
  const s = String(status || '');
  let primary: TaskActionKey | null = null;
  if (s === 'pending') primary = 'execute';
  else if (RUNNING.has(s)) primary = 'pause';
  else if (s === 'paused') primary = 'resume';
  else if (s === 'failed') primary = 'retry';
  else if (s === 'stabilizing') primary = 'requeue';
  else if (s === 'completed') primary = 'inject';
  else if (s === 'archived') primary = 'create_from_original';

  const secondary: TaskActionKey[] = ['attach'];
  if (RUNNING.has(s)) secondary.push('inject');
  // 「烹小鲜」冷却态的两个人工出口：横幅给「放回队列」，这里给「转人工暂停」（可随时恢复）。
  if (s === 'stabilizing') secondary.push('pause');
  if (s === 'paused' || s === 'failed') secondary.push('reply', 'complete');
  if (s === 'completed') secondary.push('rerun');

  const danger: TaskActionKey[] = [];
  if (RUNNING.has(s)) danger.push('interrupt');
  if (['pending', 'planning', 'paused', 'failed', 'stabilizing'].includes(s)) danger.push('archive');
  if (['completed', 'failed', 'archived'].includes(s)) danger.push('delete');

  return { primary, secondary, danger };
}
