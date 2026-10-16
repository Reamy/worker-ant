/**
 * zx_20260913 M2-6(维特根斯坦·同一把尺 / G8+G9 教训): 成果「类型集合」判据的**唯一真源**。
 *
 * 病灶：同一件事——"哪些 type 算可验收 / 可自动标 ★"——此前以 `type = 'doc'` 硬编码散在 5 处
 * （1 写入点 + 3 读点 + 1 候选点），**渲染层另有 4 处手抄**（DeliverablesPage 验收徽标/版本钮/预览钮、
 * TaskDetailPage 预览与抽屉门）。任一集合调整都要手抄 9 遍 ⇒ 必有一处漏——这正是 G8/G9 两轮
 * 反复收口的病（G8：renderer 不在 src/main 扫描面内，故"三处手抄"；G9：概念名改动还牵用户可见文案）。
 *
 * 故本模块**零依赖**（不引 electron / better-sqlite3 / node:*，同 settings-bool 范式）：
 * ① 主进程与渲染层跨 root 引入**同一份代码**（renderer 9 处已按此引 settings-bool），
 * 而不是同一条规则的第二次实现；
 * ② 可被受控回归直接跑真实现。
 *
 * 分工：SQL 侧用 `typeIn()`（返回 `type IN (?,?)` 与**配套参数**，防调用方漏 bind）；
 * JS 侧用 `isAcceptanceType()`。二者读同一份 `ACCEPTANCE_TYPES`，不各写一遍。
 */
import { IMAGE_MAX_BYTES } from './attachment-kinds.js';

/**
 * 「可记录/透出验收」的成果类型。
 *
 * zx_20260913 M2-6 裁定（用户 D2）：由仅 `doc` 扩到 `doc`+`code`——真库 4 条 type='code' 成果
 * 此前既无验收徽标也无 per-doc 打标（同一件"代码写完没写完"的事，doc 有码无）。
 * 不含 daemon/mcp/a2a/ui：其"验收"以运行态(registered/running)表达，语义不同，不并入。
 */
export const ACCEPTANCE_TYPES = ['doc', 'code'] as const;

/**
 * 「可自动提升为主要成果 ★」的候选类型。
 *
 * zx_20260913 M2-5 裁定（用户 D2）：由仅 `doc` 扩到 doc/code/daemon/ui——此前一个任务的
 * daemon（守护进程，往往才是真交付物）永远不会被自动标 ★，而一份 .md 却会。
 * 不含 mcp/a2a：其交付形态是"注册到 ANS 的服务"，另行登记，不占任务内 primary 位。
 */
export const PRIMARY_TYPES = ['doc', 'code', 'daemon', 'ui'] as const;

export const PREVIEW_TYPES = ['doc', 'code'] as const;

/**
 * 「**文件型**成果」——交付就是**文件产出本身**，故任务收尾时随任务一并置 `completed`。
 *
 * zx_20260930 M3-f（用户裁定「并入 M3 修」）: 此前 `promoteTaskFileDeliverables` 硬写 `type = 'doc'`，
 *   于是 `code` 成果**挂到已完成任务下仍永远显示「草稿」**（真库实测 5 条 `code` 处在
 *   `status='draft'` 且其任务 `status='completed'`，其中多数任务早已交付）——"名"（草稿）与
 *   "实"（已随任务交付）不符。
 *
 * **不含 `ui`**（易误判，故写明）：本仓的 `ui` 不是"静态界面文件"，而是与 mcp/a2a/daemon 同族的
 *   **服务入口**——`create_deliverable` 工具描述原文即「mcp/daemon/a2a/ui 仅用于**独立运行的服务入口**」，
 *   真库在册的三条 `ui` 行（TrendRadar UI Dashboard / dsa-web-ui / tickflow-stock-panel）也都是被启动、
 *   被注册到 ANS 的服务，状态停在 `registered`。故它与服务型同族：交付形态是**在跑的服务**，
 *   生命周期是启停（`running`/`stopped`），不是"交付完成"。
 *   把它一并提升为 `completed` 会让「已完成」这个名同时指两件事（文件写完了 / 服务在跑）——
 *   正是本模块头注释说的那个病。
 */
export const FILE_DELIVERABLE_TYPES = ['doc', 'code'] as const;

/**
 * 「**服务型**成果」——交付形态是**一个在跑的服务入口**（被启动、被注册到 ANS），
 * 生命周期是启停（`running`/`stopped`），不是"文件写完"（`FILE_DELIVERABLE_TYPES` 的对偶面）。
 *
 * zx_20260930 M3-c（维特根斯坦·同一把尺）：此前这个集合在本仓以**裸字面量析取**手抄 ——
 *   `core/tools/write.ts` 的 `create_deliverable`/`register_deliverable` 各写两遍
 *   `type === 'mcp' || type === 'daemon' || type === 'a2a' || type === 'ui'`（共 4 处），
 *   而 `ipc/project.ipc.ts` 的 `deliverable:create`（GUI 手工建成果）**一处都没有**——
 *   于是同一条"什么算服务型"的规则，agent 侧有、GUI 侧无，一次点击就能登记出
 *   `type='mcp'` 的 `.md`。本常量是它的**唯一真源**，两侧同尺。
 */
export const SERVICE_TYPES = ['mcp', 'daemon', 'a2a', 'ui'] as const;

/** JS 侧读点唯一判据（与 `typeIn('', SERVICE_TYPES)` 同源）。 */
export function isServiceType(t: unknown): boolean {
  return (SERVICE_TYPES as readonly string[]).includes(String(t ?? ''));
}

/**
 * 「这个路径是文档吗」——`.md` / `.txt`。文件名后缀**不分大小写**（`REPORT.MD` 也是一份文档；
 * 此前逐字 `endsWith('.md')` 会让它从服务型校验下漏过去，而门禁判型用的又是扩展名小写表）。
 */
export function isDocPath(filePath: unknown): boolean {
  const p = String(filePath ?? '').toLowerCase();
  return p.endsWith('.md') || p.endsWith('.txt');
}

/**
 * 「这个路径是**工具模块/库**而非服务入口吗」——位于 `tools|modules|lib|plugins` 目录下。
 *
 * 依 `create_deliverable` 工具描述原文：「工具模块(如 `tools/xxx.py` 被已有 server import)
 * **不属于**服务入口，登记为 `type="doc"`」。故服务型校验须拦住它。
 *
 * zx_20260930 M3-c：真源由 `core/agent-executor.ts` 的内联 const **挪到此处**（同一正则一字未改），
 * 使 GUI/IPC 侧与 agent 侧引用**同一个函数**而不是各抄一条正则。
 */
export function isModuleFilePath(filePath: unknown): boolean {
  return /(^|\/)(tools|modules|lib|plugins)\//.test(String(filePath ?? '').replace(/\\/g, '/'));
}

/**
 * 「可就地内联预览」的图片扩展名 → MIME。**唯一词表**（M2-2）。
 *
 * 放在这里而不是 IPC 里：受控复跑要按**生产入参**验"白名单外不读盘"，若测试自己抄一份
 * 白名单，就只是在自我印证（记忆在案：夹具比生产宽松或乱抄，断言就不是真断言）。
 */
export const IMAGE_PREVIEW_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/**
 * 内联图片的大小上限（字节）。**10MB** = 用户 2026-09-14 裁定（方案 §5.3 D1，高于规划期建议的 4MB）。
 * 单点真源：IPC 判据与 rr 断言**读同一个值**，不各写一个数字（否则改一处忘另一处，判据先假绿）。
 *
 * zx_20260921 M2: 真源**挪到 `attachment-kinds.ts`**（那一侧要按"族"取上限，`image` 族就是本值）——
 * 此处改为**引用**而非再写一个字面量。对外契约（名字、值）一字未变，调用方无需改动。
 */
export const IMAGE_PREVIEW_MAX_BYTES = IMAGE_MAX_BYTES;

/** JS 侧读点唯一判据（与 SQL 侧 `typeIn('', ACCEPTANCE_TYPES)` 同源）。 */
export function isAcceptanceType(t: unknown): boolean {
  return (ACCEPTANCE_TYPES as readonly string[]).includes(String(t ?? ''));
}

/** 「能否就地预览」唯一判据——渲染层 3 处（列表预览钮 / 详情预览与抽屉门 / 快照缺失提示）共用。 */
export function isPreviewType(t: unknown): boolean {
  return (PREVIEW_TYPES as readonly string[]).includes(String(t ?? ''));
}

/** SQL 侧唯一构造器——返回 `type IN (?,?,…)` 与**配套参数**，避免调用方漏 bind。 */
export function typeIn(alias: string, types: readonly string[]): { sql: string; params: string[] } {
  const p = alias ? `${alias}.` : '';
  return { sql: `${p}type IN (${types.map(() => '?').join(',')})`, params: [...types] };
}
