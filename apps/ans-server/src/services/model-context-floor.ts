/**
 * zx_20261018_3 批四「度」: 上下文门槛的**零依赖落点**。
 *
 * 为什么单列：同一套判定要被两处用——
 *   · ANS 匹配器 `resource-matcher.ts`（引 pino logger，模块级就建日志目录、拉传输线程）
 *   · 受控回归 `scripts/rr_zx_*.ts`（不能因 import 一个纯判定就在仓外建目录、拖住进程退出）
 * 这里只引 shared-types 里的**数据表**，无任何 I/O。
 */
import { MODEL_CAPABILITY_META, type ModelCapability } from '@worker-ant/shared-types';

function uniqueCaps(caps: string[]): string[] {
  return [...new Set(caps)];
}

/**
 * zx_20261002 M14: 请求能力集对应的**最小上下文门槛**——取各能力 `minContext` 的**最大值**。
 *
 * 真源是 `MODEL_CAPABILITY_META`。此前这里只对 `function-calling`/`structured_output`
 * **硬编码** `32000`，而表里视觉得 `8000`、推理得 `32000` 等声明**从不参与选型**——
 * 表里写了、代码不读（§1.5 行 3）。现在归一处读表。
 * 未在册的能力（脏值/自定义）**不贡献门槛**（同 `parseModelCapabilities` 的"认不出不猜"立场）。
 */
export function capabilityContextFloor(capabilities: string[]): number {
  let floor = 0;
  for (const c of uniqueCaps(capabilities)) {
    const meta = MODEL_CAPABILITY_META[c as ModelCapability];
    if (meta && meta.minContext > floor) floor = meta.minContext;
  }
  return floor;
}

/**
 * zx_20261018_3 批四「度」: **实际生效**的上下文门槛 = `max(能力类别下限, 请求方给的本任务体量)`。
 *
 * 单点导出给 `matchOptimalModel` 与 `explainMatchFailure` **共用**——两处若各算一份，
 * 诊断漏斗的"每步只加一个条件、末步与主查询同值"就不再成立（请求门槛会被漏出漏斗）。
 * 非法/缺省值（非数、≤0）**不设闸**（与 `ModelRequirements.minContextWindow` 的"未给则不设此闸"同义）。
 */
export function effectiveContextFloor(capabilities: string[], minContextWindow?: number): number {
  const requestFloor =
    Number.isFinite(Number(minContextWindow)) && Number(minContextWindow) > 0
      ? Math.floor(Number(minContextWindow))
      : 0;
  return Math.max(capabilityContextFloor(capabilities), requestFloor);
}
