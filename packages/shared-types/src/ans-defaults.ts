/**
 * ANS 服务默认地址——**唯一真源**（zx_20261005 M21 / K-11）。
 *
 * 病根：ANS 的监听端口与客户端默认地址原本散在三处各写死一份
 * （`apps/ans-server/src/index.ts` 的 `listen`、桌面 `core/ans-signed-request.ts` 的
 *  `ANS_DEFAULTS.url`、`core/mcp-client-pool.ts` 的兜底模板串）——改一处必失配，
 * 且默认端口 `3001` 是 Node/框架最常撞的端口之一，商业化"快速上手"第一跳就卡在这。
 *
 * 一条规则一处：改**这里**即改 ANS 监听默认与全部客户端默认。
 * 选 `27183` 之故：非 Node/框架常用口（非 3000/3001/5173/8000/9410/9411 一族），
 * 且**低于 Linux 临时端口起点 32768**（避免与内核随机分配的临时端口相撞）。
 *
 * ⚠ 头两行是 `baseUrl` 的**两个输入**，`ANS_DEFAULT_BASE_URL` 由它们派生——
 *   任何消费方都不得再手写 `localhost:27183` 整串（判据钉此为"零处"）。
 */
export const ANS_DEFAULT_HOST = 'localhost';
export const ANS_DEFAULT_PORT = 27183;
export const ANS_DEFAULT_BASE_URL = `http://${ANS_DEFAULT_HOST}:${ANS_DEFAULT_PORT}`;
