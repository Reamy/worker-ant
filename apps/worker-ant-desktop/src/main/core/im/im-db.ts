/**
 * IM 子树共用的**最小库接口**（同 `task-notice.TaskNoticeDb` / `task-accounting.AccountingDb` 范式）。
 *
 * 为什么单列一处：`core/im/*` 全程只用 `prepare().get/all/run`，从不用 `exec/pragma/transaction`
 * （已核，全子树零命中）。而 `task-terminal.markTaskFailed` 的入参刻意只要求最小面
 * （`TaskTerminalDb`，受控回归才能脱 better-sqlite3 跑真实现）——若本子树的函数还按
 * `better-sqlite3.Database` 收参，那条"一处发"的接线就非写 `as` 断言不可，而断言一写，
 * "接口对不对"就没人审了（本仓既有纪律）。
 *
 * 故把形状收成一处：**一个概念一个类型**。真 `Database` 结构上满足它 ⇒ 既有调用方一律不用改；
 * `node:sqlite` 夹具亦满足它 ⇒ 两种库都能跑真实现。
 */
export interface ImDb {
  prepare(sql: string): {
    run(...args: unknown[]): { changes?: number };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}
