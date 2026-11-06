/**
 * 「以原题面新建」的草稿构造（zx_20261105_1 M9）。
 *
 * 归档不是黑洞：需要再做同一件事时，给一个明确出口——**照原题面另起一单**。
 * 但"另起"不是"复活"：原任务仍是 `archived`（终态不可覆写），草稿只读原行、一字不写。
 *
 * 为什么抽到 core 而不是内联在 IPC：与 M7 的 `buildCreateReplay` 同理——纯函数可在 rr 里
 * 切片执行并做行为断言（"原行不被改写"这种话，只读静态源码是证不出来的）。
 */

export interface ArchiveDraft {
  sourceTaskId: string;
  projectId: string;
  title: string;
  description: string;
  acceptance_criteria: string;
  parent_task_id: string | null;
}

export type ArchiveDraftResult =
  | { ok: true; draft: ArchiveDraft }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_ARCHIVED'; message: string };

/**
 * 只有已归档任务能出草稿——在途/已完成任务不用"另起一单"，它们自己就能继续/重试。
 * 标题只做一件有依据的事：去掉派单前缀 `[Sub] `（那是子任务标记，不是题面的一部分）；
 * `（第 N 次）` 后缀**保留**——它记录的是既往重复，换单重做时仍有信息量。
 */
export function buildArchiveDraft(row: Record<string, unknown> | null | undefined): ArchiveDraftResult {
  if (!row) return { ok: false, code: 'NOT_FOUND', message: '任务不存在' };
  if (String(row.status ?? '') !== 'archived') {
    return { ok: false, code: 'NOT_ARCHIVED', message: '只有已归档任务可用原题面新建' };
  }
  const title = String(row.title ?? '').replace(/^\[Sub\]\s*/i, '').trim();
  return {
    ok: true,
    draft: {
      sourceTaskId: String(row.id ?? ''),
      projectId: String(row.project_id ?? ''),
      title,
      description: String(row.description ?? ''),
      acceptance_criteria: String(row.acceptance_criteria ?? ''),
      parent_task_id: row.parent_task_id == null || row.parent_task_id === '' ? null : String(row.parent_task_id),
    },
  };
}
