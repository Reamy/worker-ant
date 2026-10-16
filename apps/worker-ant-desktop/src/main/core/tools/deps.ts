/**
 * zx_20260920_1 M1（维特根斯坦「意义即用法」/ 管子·度量衡）: `buildTools()` 里那 57 个工具定义
 * 原先靠**隐式闭包**取用外层作用域的名字——搬进 `core/tools/*.ts` 后，这些名字必须**显式**给出。
 *
 * 本文件是那份**依赖面清单**：既让"工具体逐字节照搬、只把取值方式改成解构"成为可能，
 * 也让每个工具**实际依赖什么**从"读完整函数才能知道"变成"看这一份就知道"。
 *
 * ⚠ 对 `agent-executor.js` 的引用**一律 `import type`**（编译期擦除）⇒ 本文件与该模块**不构成运行时循环依赖**；
 * 而 `core/tools/*.ts` 只从本文件取**类型**、运行时值全由 `deps` 形参注入，故同样无环。
 */
import type Database from 'better-sqlite3';
import type * as AE from '../agent-executor.js';
import type { DeviceControlTransport } from './device.js';

export interface ToolDeps {
  // ---- 任务上下文（原 buildTools 的三个形参 + ctx）----
  ctx: AE.AgentContext;
  db: Database.Database;
  taskId: string;
  projectId: string;
  workingDir: string;

  /**
   * zx_20261002 M17-①（管子·度量衡）「先读后改」的**共享状态**：本任务内**模型已知内容**的文件集
   * （`read_file` 读过的、`write_file` 自建的/改写的）。键一律 `path.resolve` 归一——
   * 读侧与门禁侧**同一把尺**，否则 `/a/./b.txt` 与 `/a/b.txt` 会被当成两个文件。
   *
   * 同一份 Set 由 `read_file`（入册方）与 `edit_file`（门禁方）共享 ⇒ 这就是"提示词与门禁同源"的载体，
   * 也是「新增持久化枚举值须穷举读取谓词」里那类"两处各写一份就漂"的老形状之反例。
   */
  readFiles: Set<string>;

  // ---- 原 buildTools 体内的前置闭包（仍定义在 agent-executor.ts，此处只传引用）----
  // zx_20260930 M3-c: `isModuleFilePath` **已从此处移除**——它的真源挪到零依赖的
  // `core/deliverable-types.ts`，工具体与 IPC 两处**直接引用同一个函数**，
  // 不必再靠注入转发（同一规则不再有"注入的那份"与"直接引用的那份"两说）。
  pauseForDecision: (
    decisionType: string,
    question: string,
    options: string[] | null,
    context: Record<string, unknown>,
  ) => string;
  approvePathWrite: (resolvedPath: string) => Promise<{ allowed: boolean; reason?: string; response?: string }>;
  ensureSkillsLoaded: () => Promise<void>;

  /**
   * zx_20261004 M8（承 §3「真网络只走注入」）: 设备控制的**传动**（实际下发命令那一跳）。
   * 缺省走 `device.ts` 内的通用 HTTP 件（真机）；受控回归注入假实现 ⇒ **不触网**。
   */
  controlDevice?: DeviceControlTransport;

  // ---- 17 个被工具体引用的文件级助手（全部在 agent-executor.ts 另有引用 ⇒ 原地不动、只传引用）----
  ensureDocDeliverable: typeof AE.ensureDocDeliverable;
  checkAcceptanceCriteria: typeof AE.checkAcceptanceCriteria;
  mergePlanModeContext: typeof AE.mergePlanModeContext;
  syncQualityColumn: typeof AE.syncQualityColumn;
  registerFilesWrittenByCommand: typeof AE.registerFilesWrittenByCommand;
  interruptTask: typeof AE.interruptTask;
  logger: typeof AE.logger;
  archetypeForFile: typeof AE.archetypeForFile;
  formatInsufficiencyReasons: typeof AE.formatInsufficiencyReasons;
  ARTIFACT_WRITE_TOOLS: typeof AE.ARTIFACT_WRITE_TOOLS;
  realOutputEvidence: typeof AE.realOutputEvidence;
  fileSig: typeof AE.fileSig;
  addSideTokens: typeof AE.addSideTokens;
  checkMCPRegistrationIntegrity: typeof AE.checkMCPRegistrationIntegrity;
  expectedOutputMiss: typeof AE.expectedOutputMiss;
  docValidationTargets: typeof AE.docValidationTargets;
  assessCompletionQuality: typeof AE.assessCompletionQuality;
  completionCapFloors: typeof AE.completionCapFloors;
}
