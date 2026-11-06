/**
 * zx_20261010_1 M3（维特根斯坦·意义即使用 / 本仓注入范式）: 「注册成功 ⇒ 心跳/中转**立刻**起得来」。
 *
 * 病根：起这两条循环的代码**内联**在 `main/index.ts` 启动块里，只在进程启动那一刻判一次
 *   `nodeEnrolled`（zx_20261010 M7 的第二道闸）⇒ 用户在面板上**就地**注册成功后，仍须**重启桌面**
 *   才生效——"注册了却还是不在线"。
 *
 * 治法：把"起心跳 + 起中转消费"那段收成**可注入的 starter**——`index.ts` 装配时
 *   `setNodeRuntimeStarter(fn)` 注册、启动时调一次；`nodes:enroll` 在注册成功后**再调**一次。
 *   与 `setJobEnqueuer` / `setAnswerEmitter` / `setResumeEnqueuer` 同一惯用法（把"启动期才知道的
 *   接线"注入给运行期可调的模块），不在本模块直接引 electron / better-sqlite3。
 *
 * 零 electron 依赖：本模块只持一个函数引用，故可被受控回归**直引跑真实现**。
 */

/** 起节点运行时（心跳 + 中转消费）——返回"这一调是否让它处于运行态"（已在跑＝true）。 */
export type NodeRuntimeStarter = () => Promise<boolean>;

let starter: NodeRuntimeStarter | null = null;

/** 装配处（`main/index.ts`）注册 starter；传 `null` 解除（回归/测试用）。 */
export function setNodeRuntimeStarter(fn: NodeRuntimeStarter | null): void {
  starter = fn;
}

/**
 * 尝试起节点心跳/中转。未注册 starter ⇒ `false`（**如实**，不假装起了——"不知道"≠"起来了"）。
 * 幂等由 starter **自负**（多次调用不该起出两条循环）。
 */
export async function startNodeRuntime(): Promise<boolean> {
  if (!starter) return false;
  try {
    return await starter();
  } catch {
    return false;
  }
}
