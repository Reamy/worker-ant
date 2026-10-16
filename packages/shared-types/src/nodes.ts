/**
 * zx_20261004 M1/M5：工蚁**节点**（一台工蚁桌面）的共享词汇表——**唯一真源**。
 *
 * 为什么要放在 `shared-types`：本文件的三样东西被**两侧**同时读——
 *   ANS（`ans-server`，注册/心跳/列表）与桌面（`worker-ant-desktop`，身份/角色/在线判定）。
 *   若各写一份字符串，则"角色"这个概念的取值会随两处漂移（承 K-11、auto-memory
 *   `feedback_enum_value_sweep_readers` 的"第二落点"教训）。
 */
import { parseDbTime } from './db-time.js';

/**
 * 节点角色（K-11：预设三档，**不加自定义角色**）。
 *  - `primary`  主节点：默认承接派单的首选；
 *  - `worker`   工作节点：可被派单（缺省角色）；
 *  - `observer` 观察者：只上报状态、不承接派单。
 */
export const NODE_ROLES = ['primary', 'worker', 'observer'] as const;
export type NodeRole = (typeof NODE_ROLES)[number];

/** 缺省角色——注册未指定时用（与 ANS 侧列默认值 `'worker'` 同一取值）。 */
export const DEFAULT_NODE_ROLE: NodeRole = 'worker';

/** 运行期收窄：任何来自网络/DB 的 `role` 都必须先过这里，再落库/上屏。 */
export function isNodeRole(value: unknown): value is NodeRole {
  return typeof value === 'string' && (NODE_ROLES as readonly string[]).includes(value);
}

/**
 * 角色的人话名——与 `NODE_ROLES` **同处**（M5）。
 *
 * 为何不放渲染层：角色的**取值域**在 `NODE_ROLES`，这里再列一遍三个键即"词表的第二落点"——
 * 若将来加第四档（K-11 明令本轮不加），只改渲染层那张表就会漏掉新档（承 auto-memory
 * `feedback_enum_value_sweep_readers`）。故与枚举并列，读的人一眼看见"加一档要动两行"。
 * 类型键取 `NodeRole` ⇒ 漏一档是**编译期**错误，不是运行期回显英文 key。
 */
export const NODE_ROLE_LABEL: Record<NodeRole, string> = {
  primary: '主节点',
  worker: '工作节点',
  observer: '观察者',
};

/**
 * **可派单**判据（M5）——"谁承得住派单"的**唯一处**（M12 的选目标、面板的角标都读它）。
 *
 * 两条都要满足：
 *  - `participate` —— 用户在面板上关掉"参与"即郑重地退出派单（观察者之外，工作节点也能退）；
 *  - `role !== 'observer'` —— 观察者**只上报不承接**（K-11），即便误把 participate 置真也不派。
 *
 * 取 `Pick<AnsNode,…>`（而非整个 `AnsNode`）⇒ 台账行/入参皆可喂，判据不绑在某个具体的取数形状上。
 */
export function isDispatchable(node: Pick<AnsNode, 'role' | 'participate'>): boolean {
  return node.participate && node.role !== 'observer';
}

/**
 * **可派单方**判据（zx_20261011_1 M3，C2/M9 角色语义）——"谁分得出去活"的**唯一处**。
 *
 * 与 `isDispatchable`（谁**接得住**）**并列**：一个管"分"、一个管"接"，取名与语义都成对：
 *   - `primary`  主节点：既能分也能接；
 *   - `observer` 观察者：**只分不接**（不承接，但可作为派发方——它是有身份的节点）；
 *   - `worker`   工作节点：**只接不分**（缺省角色）。
 *
 * 取 `Pick<AnsNode,'role'>`（台账行/入参皆可喂，判据不绑具体取数形状——同 `isDispatchable` 的理由）。
 * **非节点终端（无角色）不受此判据管**：AI 终端没有 role，另面（承 §1.3）。
 */
export function canDispatch(node: Pick<AnsNode, 'role'>): boolean {
  return node.role === 'primary' || node.role === 'observer';
}

/**
 * M3：**在线/离线同一把尺**——判活阈值的**唯一处**。
 *
 * ANS 的 `GET /nodes` 派生 `online` 与桌面协同面板派生 `online` **同读此常量**
 * （ANS 只回 `last_seen_at`，判活由消费方按同一阈值算），避免"两处各写一个数"。
 * 取 90s ＝ 3× 缺省心跳间隔（30s）——容忍连丢两次心跳仍判在线。
 */
export const NODE_OFFLINE_SEC = 90;

/**
 * **在线判据**——`last_seen_at`（库内 UTC）距今 ≤ `NODE_OFFLINE_SEC`。**唯一处**。
 *
 * zx_20261011_4 M3：由 renderer 的 `node-view.ts` 上移至此。为何上移——本判据现在**两侧都要**：
 *   renderer 的派活下拉（D2）与 main 侧编排的 N3 预查（`core/orchestrator.ts`）必须**同一把尺**，
 *   否则"面板上看得见的可派对端"与"编排器愿意派的"会分家（承 `isDispatchable` 同处的理由）。
 *   上移后 renderer 从 `node-view.ts` 转出（re-export），两处仍是**一枚实现**。
 *
 * 无记录 ⇒ 离线（`null`／空串／非法 ⇒ `false`——"不知道就不说成在线"）。时刻解析走共享真源
 *   `parseDbTime`（库内时间不带 `Z`，直喂 `new Date` 会差 8 小时，见 `db-time.ts`）。
 */
export function isNodeOnline(lastSeenAt: string | null | undefined, nowMs: number): boolean {
  const d = parseDbTime(lastSeenAt);
  if (!d) return false;
  return nowMs - d.getTime() <= NODE_OFFLINE_SEC * 1000;
}

/** 缺省心跳间隔（秒）；桌面设置项 `node.heartbeat_sec` 未配时用它。 */
export const NODE_HEARTBEAT_SEC_DEFAULT = 30;

/** 节点注册请求（`POST /api/v1/nodes/register`，**令牌闸**，非 HMAC）。 */
export interface NodeRegistrationRequest {
  /** 由 ANS 侧签发的注册令牌（一次性/有限次/可过期）。 */
  enrollment_token: string;
  /** 节点自报的稳定标识（桌面 `core/node-identity.ts` 生成，一节点一个）。 */
  node_id: string;
  /** 展示名（缺省取 `os.hostname()`）。 */
  name?: string;
  /** 平台串（如 `darwin/arm64`）。 */
  platform?: string;
  /** 角色（缺省 `DEFAULT_NODE_ROLE`）。 */
  role?: NodeRole;
  /** 能力自述（首批留空；M11 起由工具面派生）。 */
  capabilities?: string[];
  /**
   * zx_20261011_1 M1（承 C2/M6 许可闸）：**注册时即按「生效参与」上报**，缺省 `true`。
   *
   * 为何随注册上报而非另开一闸：许可所管的就是"这台机器**接不接派单**"——与 `participate`
   * 是**同一件事**（一个概念一个值，承 §1.4）。故不新增字段、不新增接口，只让注册那一刻
   * 就把本地算好的生效值带上（缺省 `true` ⇒ 老客户端不带此字段时 ANS 仍落 `1`，向后兼容）。
   */
  participate?: boolean;
}

/** 节点注册响应——**`secret` 仅此一次返回**，桌面须立即落库。 */
export interface NodeRegistrationResult {
  node_id: string;
  api_key: string;
  secret: string;
  /** 一节点一资源组（K-5），形如 `node:<node_id>`。 */
  resource_group: string;
}

/** 心跳请求体（`POST /api/v1/nodes/heartbeat`，HMAC）——`status` 为环境/负载如实上报。 */
export interface NodeHeartbeatRequest {
  node_id: string;
  /** 环境/负载快照（`collectNodeEnv()` 的产物；ANS 原样存 `status_json`）。 */
  status?: Record<string, unknown>;
  /** 能力卡（M11 起上送；ANS 原样存 `card_json`）。 */
  card?: Record<string, unknown>;
}

/** 节点的对上面（`GET /api/v1/nodes` 的 `data` 元素；JSON 列已解出）。 */
export interface AnsNode {
  node_id: string;
  name: string;
  api_key_prefix: string;
  resource_group: string;
  platform: string;
  role: NodeRole;
  weight: number;
  participate: boolean;
  capabilities: string[];
  card: Record<string, unknown> | null;
  /** 环境/负载快照；从未心跳过为 `null`。 */
  status: Record<string, unknown> | null;
  enrolled_at: string;
  last_seen_at: string | null;
}

/** 改档请求（`PATCH /api/v1/nodes/:nodeId`）——缺省字段不动。 */
export interface NodePatch {
  name?: string;
  role?: NodeRole;
  weight?: number;
  participate?: boolean;
}

/** 列表响应（`GET /api/v1/nodes`）——分页元信息与 `utils/pagination.ts` 同形。 */
export interface NodeListResult {
  data: AnsNode[];
  total: number;
  limit: number | null;
  offset: number;
  has_more: boolean;
}

// ==================== M11 能力卡（类目级，K-10） ====================

/**
 * 能力卡的**类目词表**（K-10：类目级，不下钻具体工具名）——**唯一真源**。
 *
 * 取"类目"而非"工具名单"：工具名会随版本增删（`TOOL_METAS` 一改就漂），
 * 而类目是**稳定的能力承诺**——AI 终端据类目判"这台机器能不能接这类活"，
 * 不必知道它内部有几个工具、叫什么（维特根斯坦·词的意义在用法，不在名单长度）。
 *
 * ⚠ 与 `task-archetype.ts` 的 `ARCHETYPE_TOOL_CATEGORIES` **不是**同一张表：
 *   那张表是"任务原型 → 放行哪些工具类别"（**执行闸**），这里"节点 → 自称能做哪些类目"（**能力自述**）。
 *   前者收窄执行面，后者是对外承诺；两者取值域**刻意不一致**（如 `project_task` 只在此处）。
 */
export const NODE_CARD_CATEGORIES = ['text', 'code', 'research', 'media', 'device', 'project_task'] as const;
export type NodeCardCategory = (typeof NODE_CARD_CATEGORIES)[number];

/** 运行期收窄：来自网络/DB 的类目串须先过这里（承 `feedback_enum_value_sweep_readers`）。 */
export function isNodeCardCategory(value: unknown): value is NodeCardCategory {
  return typeof value === 'string' && (NODE_CARD_CATEGORIES as readonly string[]).includes(value);
}

/**
 * 类目的人话名——与 `NODE_CARD_CATEGORIES` **同处**（承 `NODE_ROLE_LABEL` 的理由）：
 * 取值域在此，人话名也在此；类型键取 `NodeCardCategory` ⇒ 词表增删一格是**编译期**错，
 * 不是渲染层悄悄回显英文 key（承 auto-memory `feedback_enum_value_sweep_readers`）。
 */
export const NODE_CARD_CATEGORY_LABEL: Record<NodeCardCategory, string> = {
  text: '对话',
  code: '代码',
  research: '研究',
  media: '媒体',
  device: '设备',
  project_task: '任务',
};

/**
 * 能力卡（M11）——随**既有心跳**上送（`NodeHeartbeatRequest.card`），ANS 原样存 `card_json`。
 *
 * 用 `type` 别名而非 `interface`：结构类型下可直接赋给 `Record<string, unknown>`（心跳 `card` 字段的形状），
 * 不必额外加索引签名（interface 无隐式索引签名，赋给 `Record` 会报错）。
 */
export type NodeCard = {
  name: string;
  node_id: string;
  platform: string;
  /** **仅列本机实际可做者**（由工具面/台账派生，不手抄——空台账的机器不自称能控设备）。 */
  categories: NodeCardCategory[];
};

// ==================== M12 中转队列（AI 终端 → ANS → 工蚁 → 回传） ====================

/**
 * 中转请求状态机（M12；zx_20261011_1 M4 增 `awaiting_answer`）：
 * `pending`（无可派节点，等）→ `assigned`（已选目标，工蚁待拉）
 * → **`awaiting_answer`（工蚁遇上需澄清的事，已提问、等派活方作答——M4 双向澄清）**
 * → `done`/`error`（工蚁回传终态）。
 *
 * ⚠ `awaiting_answer` 是 `assigned` 与终态之间的**一个可答中间态**，不是终态：作答后回 `assigned`
 *   （工蚁可继续跑）、或等不到答案时由工蚁按 M11 自决后照常走到 `done`/`error`。
 *   ⚠ 读点须知（承 auto-memory `feedback_enum_value_sweep_readers`）：凡"是否终态"的判据须**显式列**
 *     `done`/`error`（如 `node-dispatcher.ts`），**不可**写成 `!== 'pending'` 之类——否则会把
 *     `awaiting_answer` 误当终态收口。
 */
export const NODE_REQUEST_STATUSES = ['pending', 'assigned', 'awaiting_answer', 'done', 'error'] as const;
export type NodeRequestStatus = (typeof NODE_REQUEST_STATUSES)[number];

export function isNodeRequestStatus(value: unknown): value is NodeRequestStatus {
  return typeof value === 'string' && (NODE_REQUEST_STATUSES as readonly string[]).includes(value);
}

/**
 * 澄清问答的**问题状态**（M4）——`asked`（已提问，等作答）→ `answered`（已作答）。
 * 与请求 `status` **分开记**：`status` 管"这一单走到哪一步"，`question_status` 管"这一问答没答"
 *   （同一单可先后多问；`answer` 只留最近一次答——够本轮"一问一答"用，多轮留待后继）。
 */
export const NODE_QUESTION_STATUSES = ['asked', 'answered'] as const;
export type NodeQuestionStatus = (typeof NODE_QUESTION_STATUSES)[number];

export function isNodeQuestionStatus(value: unknown): value is NodeQuestionStatus {
  return typeof value === 'string' && (NODE_QUESTION_STATUSES as readonly string[]).includes(value);
}

/** 澄清**问题**（M4）：B 端（中继执行体）遇需澄清时提问（`POST /requests/:id/question` 的载荷）。 */
export interface NodeQuestion {
  question: string;
  /** 可选项（可选）；无则自由作答。 */
  options?: string[];
}

/** 澄清**作答**（M4）：A 端（派活方）答（`POST /requests/:id/answer` 的载荷）。 */
export interface NodeAnswer {
  answer: string;
}

/** 中转请求行（`ans_node_requests` 的投影；JSON 列已解出）。 */
export interface AnsNodeRequest {
  id: string;
  category: string;
  payload: Record<string, unknown>;
  /** 请求方（AI 终端）的 key 前缀——**仅前缀**，便于事后追责、不泄全键。 */
  requester_key_prefix: string;
  /**
   * zx_20261011 M1：请求方若**本身是一台工蚁节点**，其 `node_id`（否则 `null`）。
   *   **由调用方 key 的资源组派生**（`node:<id>`），**非**请求体自报——防冒名读他人结果。
   *   `GET /requests/:id` 的读回鉴权据此判定"你是不是请求方"。
   */
  requester_node_id: string | null;
  /** 选中的目标节点；无可派节点时为 `null`（`pending`）。 */
  target_node_id: string | null;
  status: NodeRequestStatus;
  result: Record<string, unknown> | null;
  /**
   * zx_20261011_1 M4（双向澄清）：B 端（中继执行体）最近一次**提问**（无则 `null`）。
   *   A 端读回端（`GET /requests/:id`）据此上屏"待答问题"。
   */
  question: NodeQuestion | null;
  /** 最近一次**作答**（无则 `null`）；与 `question` 配对，靠 `question_status` 判"答没答"。 */
  answer: NodeAnswer | null;
  /** 问题状态机（`asked`/`answered`）；从未提问为 `null`。 */
  question_status: NodeQuestionStatus | null;
  created_at: string;
  claimed_at: string | null;
  done_at: string | null;
}

/** 提交请求体（`POST /api/v1/nodes/requests`）——类目级，凭请求方自己的 key 提交。 */
export interface NodeRequestSubmit {
  category: string;
  payload?: Record<string, unknown>;
  /**
   * zx_20261011 M2：**手动指定目标**（可选）。留空 = ANS 按负载/权重**自动选**。
   *   指定时 ANS 以**同源判据**校验（可派 ∧ 在线 ∧ 卡含该类目）；不合格 ⇒ `400` 如实告知差在哪，**不伪造目标**。
   */
  target_node_id?: string;
}

/** 工蚁回传体（`POST /api/v1/nodes/requests/:id/result`）。 */
export interface NodeRequestResultReport {
  node_id: string;
  status: 'done' | 'error';
  result?: Record<string, unknown>;
}
