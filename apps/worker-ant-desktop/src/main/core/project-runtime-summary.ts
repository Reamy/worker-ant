/**
 * zx_20261003 M4（柏拉图·洞穴喻 / 黑格尔·合理才存在）: 项目"运行面"聚合——守护进程与作业队列的**只读**账。
 *
 * 病根：项目知识全景（`ipc/project.ipc.ts` 的 `project:knowledgePanorama`）此前**只看得见记忆的影子**，
 * 看不见守护/作业这两个"环节"——交付物/调用/守护本是项目知识整体的一部分，未进整体则知识面不成立。
 * 本模块补的正是这两个环节，且**只读**：界面每次刷新都不该改库（承 `service-call-ledger.ts` 同一条纪律）。
 *
 * ⚠ **与 `describeServiceCalls` 不是同一件事，别合并**：
 *   · `wa_service_calls`（`service-call-ledger.ts`）记的是"**一次对外调用**"——MCP/A2A/守护的**启动动作**
 *     的成败与耗时。是**事件流水**（起过几次、成几次）。
 *   · 本模块量的是"**此刻的状态面**"——守护有几个在跑、作业队列积了多少。是**当前存量**。
 *   合并成一个数会把"起过 10 次、现在 1 个在跑"糊成一句（"用了才算数"的反面：混了两种量尺）。
 *
 * ⚠ **零 electron 依赖**：IPC 层引 electron（rr 够不着），故把聚合逻辑落在此处——rr 可拿内存库直跑真实现。
 */

/** 某一状态的行数。`status` 为空串 = 该列未登记（如实列出，不并入他档）。 */
export interface StatusCount { status: string; count: number }

export interface ProjectRuntimeSummary {
  /** 守护进程（`wa_deliverables.type='daemon'`）按状态计数 + 合计（`running` 即"此刻在跑"）。 */
  daemons: { total: number; byStatus: StatusCount[] };
  /**
   * 作业队列（`wa_jobs`）按状态计数 + 合计。
   *
   * **只算 payload 里点了本项目名的**（`json_extract(payload,'$.projectId')`）——作业表是**引擎全局**的
   * （`ai-task` / `resume-ai-task` 皆含 `projectId`），本项目无份的那些**不计入**；把别家的作业算到本项目头上，
   * 比"少算"更坏（承 K-3「如实」）。
   */
  jobs: { total: number; byStatus: StatusCount[] };
}

/** 行数组 → { total, byStatus }。空数组 ⇒ `{ total: 0, byStatus: [] }`——"零"是如实值，不是缺省。 */
function pack(rows: ReadonlyArray<{ status: string; cnt: number }>): { total: number; byStatus: StatusCount[] } {
  return {
    total: rows.reduce((a, r) => a + r.cnt, 0),
    byStatus: rows.map((r) => ({ status: r.status, count: r.cnt })),
  };
}

/**
 * 读某项目的运行面（只读）。**不写任何东西**。
 *
 * ⚠ 作业那半边**带 `json_valid(payload)` 前置闸**：`json_extract` 对**畸形 JSON** 会**抛错**，
 *   一件脏 payload 就能把整张全景打成 error（读完页变错误页）。脏行按"无法归属"跳过——
 *   如实少算，而不是让一行脏数据掀翻整台界面。
 */
export function describeProjectRuntime(db: { prepare(sql: string): { all(...args: unknown[]): unknown } }, projectId: string): ProjectRuntimeSummary {
  const pid = projectId || '';
  const daemonRows = db.prepare(
    `SELECT COALESCE(status, '') AS status, COUNT(*) AS cnt
     FROM wa_deliverables WHERE project_id = ? AND type = 'daemon' GROUP BY status`,
  ).all(pid) as Array<{ status: string; cnt: number }>;
  const jobRows = db.prepare(
    `SELECT COALESCE(status, '') AS status, COUNT(*) AS cnt
     FROM wa_jobs WHERE json_valid(payload) AND json_extract(payload, '$.projectId') = ? GROUP BY status`,
  ).all(pid) as Array<{ status: string; cnt: number }>;
  return { daemons: pack(daemonRows), jobs: pack(jobRows) };
}
