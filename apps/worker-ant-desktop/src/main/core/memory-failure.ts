/**
 * zx_20261012_1 批一（M29 · 夏克特·错误归因 / 维特根斯坦·一个规则一处）:
 * **记忆子系统的失败计数与如实上报**——把散在十余处的 `catch {}`（静默吞错）收成**一处真源**。
 *
 * 病根（静默失败）：记忆子系统里大量最佳努力的读取/组装/写入被 `catch {}` 吞掉——**既不计数、也不留痕**。
 * 后果是"记忆这一路到底有没有在坏、坏在哪一环"根本无从回答：检索空了、注入少了、计数没涨，
 * 全都被解释成"本来就没有"，而不是"这一步抛了"。夏克特七宗罪里的**错误归因**（把失败读成"无事发生"）
 * 与**可暗示性**（把失败悄悄替换成一个默认值）正由此滋生。
 *
 * 治法（不是"给每个 catch 加一行日志"就算，那会造出第二把不一致的尺）：
 * ① **一个具名枚举**（`MEM_FAIL`）容纳所有可归因的环节——各处**只准引符号，禁手写字符串**，
 *    于是"有哪些失败面"在这一处说得清、可枚举、可被静态扫面钉住；
 * ② `recordMemoryFailure` 同时做两件事——**如实**（`logger.warn` 带 kind/err.message/ctx）与
 *    **计数**（模块级 `Map<string, number>`），供 rr 与 IPC 读快照；
 * ③ 本模块**零业务依赖**（只引 logger），可被受控回归直引跑真实现（同 memory-lifecycle 范式）。
 *
 * ⚠ **不改任何回退分支的返回值**：本模块只负责"记一笔"，调用点原有的兜底返回（`return []` / `return ''`）
 *   一律保持逐字不变——那是"降级可用"，不是"假装没坏"。记一笔是给降级**留痕**，不是取消降级。
 */
import { createLogger } from './logger.js';

const logger = createLogger('memory');

/**
 * 记忆失败环节的**具名枚举**（唯一真源）。
 *
 * 命名约定：`<子系统>.<环节>`。凡新增一处 `recordMemoryFailure` 调用，**必须**先在此登记——
 * 手写裸字符串会被静态判据照出（本轮 rr 的 M29 组按 `MEM_FAIL.` 前缀数调用面）。
 */
export const MEM_FAIL = {
  /** 装配一段项目记忆上下文（buildMemoryContext 的各段 try 块）— ctx.section 指明段名 */
  contextSection: 'context.section',
  /** 可信度/来源/成熟度的标注标签生成失败 */
  contextTag: 'context.tag',
  /** 批量记录记忆访问追踪（use_count / last_used_at）失败 */
  contextRecordAccess: 'context.recordAccess',
  /** 列举前瞻记忆失败 */
  prospectiveList: 'prospective.list',
  /** 解析前瞻记忆的触发条件 JSON 失败（退化为不触发，不注入） */
  prospectiveParse: 'prospective.parse',
  /** 取命中触发的前瞻记忆失败 */
  prospectiveGetTriggered: 'prospective.getTriggered',
  /** 标记前瞻记忆已触发失败（可能致同一意图重复触发） */
  prospectiveMark: 'prospective.mark',
  /** 扫描到期前瞻记忆失败 */
  prospectiveScan: 'prospective.scan',
  /** 检索知识图谱关联失败（退化为无图上下文） */
  kgQuery: 'kg.query',
  /** LLM 三元组提取失败（回退到正则） */
  kgExtractLlm: 'kg.extractLlm',
  /** 强化：计数器自增失败 */
  reinforceBumpCount: 'reinforce.bumpCount',
  /** 强化：写回 importance/时间戳失败 */
  reinforceApply: 'reinforce.apply',
  /** 强化：整轮失败 */
  reinforceRun: 'reinforce.run',
  /** 共现（赫布）强化：同期入文者互相加权失败 */
  cooccurBump: 'cooccur.bump',
  /** 工作记忆：入池失败 */
  workingMemoryAdd: 'workingMemory.add',
  /** 记账：应用强化写回失败 */
  applicationRecord: 'application.record',
  /** 整合：合并（融为一条）失败 */
  consolidateMerge: 'consolidate.merge',
  /** 辩证扬弃：单对失败 */
  sublatePair: 'sublate.pair',
  /** 辩证扬弃：整轮失败 */
  sublateRun: 'sublate.run',
  /** 抽象：标记已抽象失败 */
  abstractMark: 'abstract.mark',
  /** 抽象：整轮失败 */
  abstractRun: 'abstract.run',
  /** 再巩固：单对失败 */
  reconsolidatePair: 'reconsolidate.pair',
  /** 再巩固：整轮失败 */
  reconsolidateRun: 'reconsolidate.run',
} as const;

export type MemFailKind = (typeof MEM_FAIL)[keyof typeof MEM_FAIL];

/** 模块级计数器（键 = `MEM_FAIL` 的取值）。进程内累计，供快照读取。 */
const _counts = new Map<string, number>();

/** 取 err 的可读消息（unknown ⇒ 安全取值，不假设它是 Error）。 */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 记一笔记忆失败：**如实**（warn 带 kind / 消息 / 上下文）+ **计数**。
 *
 * 调用点须知：本函数**不抛**（内部不 throw），故可安全地用于 `catch` 块内接管一次静默吞错——
 * 它把"吞掉"升级为"吞掉但留痕"。返回值恒为 `void`（不回传任何东西，避免调用点依赖它做控制流）。
 */
export function recordMemoryFailure(kind: MemFailKind, err: unknown, ctx?: Record<string, unknown>): void {
  _counts.set(kind, (_counts.get(kind) ?? 0) + 1);
  logger.warn({ kind, errMsg: errMessage(err), ...(ctx ?? {}) }, '记忆子系统失败（已降级，留有痕）');
}

/** 失败计数快照（只读副本）。供 rr 断言与 IPC 读取。 */
export function memoryFailureSnapshot(): Record<string, number> {
  return Object.fromEntries(_counts);
}

/** 清零（供 rr/测试在夹具起跑前重置，避免跨用例串味）。 */
export function resetMemoryFailureCounters(): void {
  _counts.clear();
}
