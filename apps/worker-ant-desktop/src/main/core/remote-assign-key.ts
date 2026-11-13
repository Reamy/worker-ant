/**
 * zx_20261112_1 B2「任」: 外派键名的**零依赖落点**。
 *
 * 病根：渲染层要用 `positions.ts` 的纯判据（岗位建议打分 / 岗位块拼装），而 `positions.ts`
 *   判「是否外派」须引键名真源。若直接引 `node-orchestrate.ts`，则连带 `node-identity.ts`
 *   的 `node:crypto` / `node:os` 进入浏览器构建，Vite 直接报 `"randomUUID" is not exported
 *   by "__vite-browser-external"`。故键名下沉到此零依赖模块，`node-orchestrate.ts` 原样转出，
 *   既有导入点一处不用改——键名仍只此一处真源。
 */
export const REMOTE_ASSIGN_NODE_KEY = 'assigned_node_id';
