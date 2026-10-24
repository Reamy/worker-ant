/**
 * 记忆重要度刻度 —— **一处真源**（zx_20260920_1 M7「用了才算数」）。
 *
 * 病根：写侧基线恒 `0.5`、读侧门槛恒 `0.6`，两条式子**分居两处、谁也没把另一条当约束**
 *   ⇒ `synthesizeProjectKnowledge` 的「≥3 条 importance ≥0.6」对**按基线写入的记忆恒不可满足**：
 *   真库 774 行 `max(importance)` 恰为 0.5、`>= 0.6` **零行**、`panorama` **恒 0**（闭环死锁）。
 *
 * ⚠ **不变式：`MEM_IMPORTANCE_DEFAULT >= PANORAMA_MIN_IMPORTANCE`**（受控回归 C15 钉死）。
 *   一旦低于它，新写入的记忆**出生即不可被整合**，上面的死锁原样复现。
 *
 * 取值 `0.6 / 0.6` 的三条实测依据（详见方案 §M7 细化规划）：
 *   ① **读侧不得低于 0.6**：存量 17 条 `semantic` 的 importance 恰为 0.5，下调即**改变存量的含义**
 *      （它们会立刻变成"可被整合"），与用户裁定「只修新写入，存量不动」相悖；
 *   ② **写侧必须 ≥ 读** ⇒ `>= 0.6`；
 *   ③ **写侧不得取 0.7**（曾列为候选）：`challengeOverconfident` 的候选集是
 *      `importance >= 0.6 AND use_count = 0 AND last_reinforced_at IS NULL` —— **新写入的记忆三个条件全中**，
 *      而它靠 `if (r.importance < 0.7 && !isVolatile) continue` 这一道闸放过它们。取 0.7 ⇒
 *      每条新记忆出生即被逐轮 `confidence_penalty × 0.8`（下限 0.2、是**检索惩罚项**）—— 那不是"更安全的余量"，
 *      是**换一种病**；且 0.7 会连带把两个 `>= 0.7` 读点（长期记忆注入、semantic/procedural 注入）对新写入整体放开。
 *
 * 如实边界：写 = 读 ⇒ 新记忆**出生即在门槛上**，`0.6 → 0.59` 需 `0.1·d > ln(0.6/0.59)` ≈ **4.0 小时**，
 *   即新记忆约在此窗口内可被整合，此后随 Ebbinghaus 衰减**合法掉出** —— 门槛的区分力由此保留
 *   （不是"写高即恒真"）。边缘情形如实记：一个项目若在 4 小时内攒不满 3 条新记忆，panorama 仍不生成。
 *
 * 本文件是**纯模块（零 import）**：主进程、渲染层、受控回归三边同引一份。渲染层不在 `src/main` 的扫描面内，
 * 同类词表此前在渲染层被手抄过多份并各自漂移，故这里刻意不引任何东西，让跨根直引成为可能
 * （`renderer/src` 内已有 11 个文件这样引用 main 的纯模块）。
 */
export const MEM_IMPORTANCE_DEFAULT = 0.6;
export const PANORAMA_MIN_IMPORTANCE = 0.6;

/**
 * 全景综合的**相对名次门槛**（zx_20261002 M9-②）—— 与上面的绝对刻度配对使用。
 *
 * 病根（本轮实测定性）：`importance` 是**时间函数**（Ebbinghaus 衰减），而真库活记忆已跌到
 *   **0.02–0.28**（26 条活记忆里 9 条项目内记忆无一过 0.3）。任何**绝对**刻度都会随记忆变老而
 *   **结构性失效**——闸在册、却永不落（真库 `panorama` 恒 0）。这正是 §1 那条「应无所住／
 *   错误归因」：把"可整合"绑在一个会自己走低的量上。
 *
 * 故「够不够综合」**补一把同项目相对名次的尺**：项目内候选记忆（semantic/procedural/
 *   retrospective/negative）齐 `PANORAMA_TOP_K` 条即触发。绝对刻度因此**降级为质量排序**
 *   ——绝对支的高价值记忆排在前，但不再是唯一准入。
 *
 * ⚠ 与上面两个常量的关系：不变式 `MEM_IMPORTANCE_DEFAULT >= PANORAMA_MIN_IMPORTANCE` **仍然成立、
 *   仍须维持**（受控回归 C15 钉死）——它守的是"绝对支对新写入非空"这一支；本常量只放宽**准入条数**，
 *   绝不改写入基线（方案 §1 明禁"靠调低基线让闸恒真"：那是把"写高即恒真"换一种病）。
 * ⚠ 取值 3：与旧代码里那个硬编码的 `if (memories.length < 3) return null` **同值**——本迁移
 *   只是把那个散落的字面量收进真源，不改变"至少 3 条才谈得上综合成体系"这一口径。
 */
export const PANORAMA_TOP_K = 3;

/**
 * 记忆**类型 / 来源**的名字 —— 与上面的刻度同属"一个概念，一个值"（zx_20260930 M5）。
 *
 * 病根形状：`failure_knowledge` / `subagent_experience` 这两类**读侧在册、写侧为零**——
 *   读侧把名字写死在 SQL 里（`exec-context.ts`）、统计里（`project.ipc.ts`）；一旦写侧由别处
 *   拼一个近义串（`'failure_knowledge '`、`'failureKnowledge'`），查询恒空而**无人报错**：
 *   写进去的和读出来的是两个概念，两边各自都"没错"。
 *
 * 故名字**只在此处定义一次**，读写两侧同引（本文件零 import，三边可直引——见文件头）。
 * ⚠ 改这里的值等于改表内既存行的可读性：存量行仍存旧串，**不得**靠改这里去"迁移"。
 */
export const MEM_TYPE_FAILURE_KNOWLEDGE = 'failure_knowledge';
export const MEM_TYPE_SUBAGENT_EXPERIENCE = 'subagent_experience';

/**
 * 来源 `user_correction` —— 用户纠正。三条既有机制**已在册、此前根本不可达**（写侧为零）：
 *   ① 置信顶分 0.95（`memory-manager.ts` 的来源分表）；
 *   ② `sameSourceReplace` **永不覆盖**用户来源（同文件早退）；
 *   ③ 衰减豁免（`isCore` ⇒ λ×0.2、半衰期×5）。
 * 本轮补上写侧后它们才第一次生效，故这些名字必须与 `memory-manager.ts` 里判 source 的那几处**同值**。
 */
export const MEM_SOURCE_USER_CORRECTION = 'user_correction';
