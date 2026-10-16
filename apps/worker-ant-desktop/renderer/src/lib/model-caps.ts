/**
 * 模型 `capabilities` 字段解析——**一处真源已在 main** `core/model-availability.ts`（zx_20261011_5 上移）。
 *
 * 此前本文件自带一份实现（zx_20261010 M2 收成），`SetupPage`/`ModelsPage` 同引。本轮把实现上移 main，
 *   renderer **反引**（`../../../src/main/core/model-availability.js`，与 `DashboardPage` 引
 *   `core/health-check.js` 的既有范式一致）——两处各判一次终会各说各话，故只留一处。
 */
export { parseModelCapabilities as parseCapabilities } from '../../../src/main/core/model-availability.js';
