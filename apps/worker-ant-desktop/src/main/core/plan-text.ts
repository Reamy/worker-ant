/**
 * 方案文本的**纯函数**工具（零运行期依赖）。
 *
 * zx_20261117_1 M1「案」：`stripPlanBoilerplate` 原先住在 `task-archetype.ts`，而 `verification-issues.ts`
 * 是"零运行期依赖"的受控回归入口——若直接 import `task-archetype` 会把 logger/tool-registry 整链带进来。
 * 故把这段纯文本剥离下沉到本模块：`task-archetype` 与 `verification-issues` 共用**同一份**实现，
 * 不再各抄一份正则（第二份就是下一次分家的起点）。
 */

/**
 * 剥掉任务创建器注入的**方案样板前缀**，再交给关键词判定。
 *
 * 真标本：主任务「请开始按计划分步实施方案 plans/…」被判 `document`；T12「【方案单元 T12 · 批次 B4】详见 plans/…」
 * 同样被判 `document`——「方案」二字本身不是交付物，它只是**被实施的对象的引用**。
 * 只剥「按/依据/详见/参考 + 方案」与 `【方案单元…】`，**不剥**「写一份方案」这类真文档意图。
 */
export function stripPlanBoilerplate(text: string): string {
  return String(text ?? '')
    .replace(/【方案单元[^】]*】/g, ' ')
    // 路径可能含中文（真标本 `20261116-新后端易宝支付对接方案.md`），故用 `[^\s]+` 而非 `\w`。
    .replace(/(?:依据|按照|按|详见|参考|参见)\s*(?:[^\s/]+\/)*plans\/[^\s]+\.md/gi, ' ')
    .replace(/(?:按|依据|按照|参考|参见)\s*方案(?:实施|落地|执行|推进)?/g, ' ')
    .replace(/方案文件/g, ' ');
}
