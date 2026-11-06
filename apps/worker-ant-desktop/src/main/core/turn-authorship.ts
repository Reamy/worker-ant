/**
 * zx_20260916_3 M5（O-F）：**「引擎代拟」消息的唯一识别处**。
 *
 * 病根（本轮实测⑥）：任务对话里 `role='user'` 的行有 18/34 行是**引擎自己写的指令**，文本形如
 * 「你是工蚁系统的AI助手。你的所有子任务已经全部完成，请现在整合所有产出…」——在对话流里
 * **跟人说的话一模一样**（GUI 气泡标签直接印 `user`），读史的人无从分辨是谁下的令。
 *
 * 为什么不把它们的 `role` 改成 `system`（最直观的改法）：
 *   恢复回放（`agent-executor` 组装历史时）**逐字跳过 `system` 行** ⇒ 反馈送不到执行体 —— 这正是
 *   zx_20260911_1 M2 把偏离提醒从 `system` 改成 `user` 的原因（教训就在那段代码的注释里）。
 *   也**不新增 role 取值**：那要穷举全部读取谓词（SQL 同行 / 内存判 / 抽成局部变量 / 第二个进程的词表落点，
 *   见 auto-memory `feedback_enum_value_sweep_readers`），代价远大于收益。
 * ⇒ 故采用方案 §7.1 的首选：**`role` 仍为 `user`（可达性一个字没动），内容首标可辨识**。
 *
 * 「哪些首标算代拟」**只在本文件枚举一次**。各写入点仍写自己的首标字面量——它们是**文案**（要跟句子连读），
 * 不是词表的定义处；回归会断言“表中每个首标在 `src/main` 里确有生产点”，防词表长成空话。
 *
 * ⚠ renderer 本是"词表的第二个落点"这一族病根的高发处（`src/main` 扫描面扫不到它、打包独立）——
 *   `feedback_enum_value_sweep_readers` 记的 G8/G9 两次翻车都在这里。本模块**不靠手抄镜像回避它**：
 *   `TaskDetailPage.tsx` 直接 `import { isEngineDraftedTurn } from '../../../src/main/core/turn-authorship.js'`
 *   ——renderer 能跨根 import **纯** main 模块（先例 `core/dep-graph.ts`，zx_20260913 M3-5）。
 *   ⇒ 全仓**只有这一份**首标词表。回归两向钉死：① 该 import 语句在册；② renderer **内不得出现**
 *   任何一条首标字面量（`mirrored.length === 0`）——即"第二份词表"若被人手抄回来，断言立刻变红。
 */

/** 引擎代拟消息首标（本次新增的那一个：此前唯一无任何首标的代拟指令） */
export const ENGINE_DRAFTED_TAG = '[引擎代拟]';

/**
 * 引擎代拟消息的首标**全集**。**真人说的话一律不在表内**——
 * `[IM回复]`（IM 原文）、`[用户选择: …]` / `[用户确认执行]`（人的动作经引擎誊写）、裸回复
 * （`task:resume` / `task:respond` 里用户自己敲的）都**不算代拟**：把人的话标成引擎的是另一种不实。
 *
 * 表的**范围**是「`role` 说不清来源的行」——即落库成 `role='user'` 的引擎文本。本表 7 个首标的落库 `role`
 * 均为 `'user'`（M5 落地时**逐个读生产点**核对，清单见方案 §7.4-1；机检只覆盖"每个首标确有生产点"，
 * 未覆盖"生产点的 role 恰为 user"——生产点有三种书写形态，就近找 `INSERT` 的写法会误命中邻近语句）。
 * 引擎写的、但 `role='system'` 的文本（如 `[目标偏离收敛]` 那条收敛注记）**不入表**：它的 `role` 本就如实、
 * GUI 已标 `system`，入表反而会把"role 已如实"也算成"需要贴首标"，让这张表的含义漂移。
 */
export const ENGINE_TURN_TAGS: readonly string[] = [
  ENGINE_DRAFTED_TAG,      // ai-task forceFinalizeMsg：子任务全完 ⇒ 强制整合指令（本轮新增标）
  '[系统恢复]',             // ai-task 自造恢复块（synthBlock）
  '[系统]',                 // D1 逐子交付摘要恢复 / 偏离回正继续 / SDK 降级重试
  '[待回复]',               // pause-settlement buildUnansweredBanner：悬置提问守卫
  '[目标偏离提醒]',          // agent-executor 省察克治
  '[产出内容不充分]',        // agent-executor 充分性校验未过
  '[来自任务 ',              // agent-executor send_message_to_task：引擎代投的兄弟任务消息
];

/** 这条会话是不是**引擎代拟**的？（真人发言 ⇒ false）——按首标判，不按 role 判 */
export function isEngineDraftedTurn(content: string | null | undefined): boolean {
  const s = String(content ?? '');
  return ENGINE_TURN_TAGS.some((t) => s.startsWith(t));
}

/** 给一段引擎代拟文本加上可辨识首标；**幂等**（已带任一引擎首标则原样返回，不叠标） */
export function markEngineDrafted(text: string): string {
  return isEngineDraftedTurn(text) ? text : `${ENGINE_DRAFTED_TAG} ${text}`;
}
