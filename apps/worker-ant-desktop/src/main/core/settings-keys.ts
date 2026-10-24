/**
 * zx_20261018_3 批四「度」: 引了原生/日志依赖的模块里那些**设置键**的零依赖落点。
 *
 * 为什么单列一个文件：同一个键要被**两处**读写——
 *   · 引擎读口 `task-accounting.resolveMachineConcurrencyLimit`（main，引 `node:os` 与 pino logger）
 *   · 设置页写口 `SettingsPage`（renderer，不能拖进 `node:os`/pino）
 * 把字面量放这里，两侧同引一份；否则又是"同一个键两处各抄一遍"，改一处漏一处。
 */
export const MACHINE_CONCURRENCY_SETTING_KEY = 'machine_max_concurrency';
