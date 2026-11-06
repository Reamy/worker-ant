/**
 * zx_20261004 M12（管子·势 / 孙子·以逸待劳 / 维特根斯坦·意义即用法）:
 * 工蚁侧**中转队列消费者**——心跳周期内"顺手"把 AI 终端经 ANS 派来的类目级请求领回来做掉。
 *
 * 为什么是"拉"不是"被推"（§1.2）：本机**无监听端口** ⇒ 他者不能直连工蚁；唯一形态是
 *   `AI 终端 → ANS 登记请求 → 工蚁心跳周期拉取 → 本地执行 → 回传`。这与"以逸待劳"同形：
 *   工蚁主动按自己的节奏去取，不必为他者开一个门。
 *
 * 一条请求的一生（本模块只管中间三段）：
 *   ① **拉**（`io.list`）——只拿 ANS 判给**本节点**的 `assigned` 件（越权由 ANS 侧按 key 资源组挡）；
 *   ② **限定工具面**（`categoryToolFace`）——**类目级**：按类目挑一个**原型档**，只给该档工具。
 *      "类目级 ⇒ 不下钻项目/文件"是**刻意**的：请求方是外部终端，不该借一次调用触达本机项目面。
 *   ③ **跑 + 回传**（`runner` + `io.report`）——执行器**注入**（真机接任务引擎，回归喂假），
 *      回传失败**不谎报成功**：这一件下轮仍 `assigned`，会被重拉（**至少一次**语义，如实注释，不假装恰好一次）。
 *
 * ⚠ 本模块**不触网**：拉/跑/报三件事全是注入的接口（`RequestIo` / `RequestRunner`），
 *   真机在 `main/index.ts` 接到 `ansSignedRequest` 与任务引擎；受控回归喂假 ⇒ 不出网也能跑真逻辑。
 */
import {
  isNodeCardCategory,
  type AnsNodeRequest,
  type NodeCardCategory,
} from '@worker-ant/shared-types';
import { availableToolNames, type TaskArchetype } from './task-archetype.js';

/**
 * 类目 → 原型档 的**唯一映射**（M12）。
 *
 * 为何要一层映射而不是"类目名即原型名"：两者**取值域刻意不同**（承 `shared-types/nodes.ts` 的注释）——
 *   `project_task` 是"能力自述"里的类目，`task-archetype` 里没有同名档；`text` 对应的是 `conversation`。
 * 逐项都能说出**为什么是这一档**：
 *   - `text`        → `conversation`：对话档（最窄，只读 + 资源 + 收口）；
 *   - `code`        → `code`：编码档；
 *   - `research`    → `research`：调研档；
 *   - `media`       → `document`：**含 media 工具面且不含 shell** 的档（媒体活不该顺带跑命令）；
 *   - `device`      → `code`：`device` 类工具只在 `code`/`configuration` 两档放开，取 `code`；
 *   - `project_task`→ `code`：接"一整件事"，给最完整的一档（写 + shell + 控制 + 设备）。
 */
export const CATEGORY_ARCHETYPE: Record<NodeCardCategory, TaskArchetype> = {
  text: 'conversation',
  code: 'code',
  research: 'research',
  media: 'document',
  device: 'code',
  project_task: 'code',
};

/**
 * 按请求**类目**取工具面（**纯函数**，供受控回归直跑真实现）。
 * 未识别的类目 ⇒ `archetype: null`（**拒办**，不擅自给一个"默认档"——默认档即越权）。
 */
export function categoryToolFace(category: string): { archetype: TaskArchetype | null; tools: string[] } {
  if (!isNodeCardCategory(category)) return { archetype: null, tools: [] };
  const archetype = CATEGORY_ARCHETYPE[category];
  return { archetype, tools: availableToolNames(archetype) };
}

/**
 * 一次执行的结局（回传 `status` 三档；`result` 原样交回请求方）。
 * zx_20261030_1 M3「止」：`cancelled` = 派活方叫停后**真停**的如实回报（既不是完成，也不是失败）。
 */
export interface RequestRunResult {
  status: 'done' | 'error' | 'cancelled';
  result: Record<string, unknown>;
}

/**
 * zx_20261030_1 M2「见」：执行体→派活方的**进度**回调——`step` 为已完成步数，`total` 未知即 `null`
 * （界面据此说"第 N/M 步"或"已进行 X 分钟"，不编百分比）。
 */
export type ProgressReporter = (p: { step: number; total: number | null; note: string }) => void;

/**
 * 执行器（注入点）：真机接任务引擎（建一件本机内建任务并跑），回归喂假。
 * 收 `tools`（该档工具名单）与 `archetype`——执行方据此**限定工具面**，而不是拿到整机。
 * 第 4 参 `progress`（M2，**可选**）：执行体在步进时调用；不接也不报 ⇒ 派活方显示「对方未上报进度」。
 */
export type RequestRunner = (
  req: AnsNodeRequest,
  tools: string[],
  archetype: TaskArchetype,
  progress?: ProgressReporter,
  /**
   * zx_20261030_1 M3「止」：**叫停探针**（可选）。执行体在检查点调用；返回 `true` 即须**真停**
   *   在途执行并如实回传 `cancelled`。不传 ⇒ 不支持停止（旧执行体），跑完按真实结局回传。
   */
  cancelled?: () => Promise<boolean>,
) => Promise<RequestRunResult>;

/** 拉取 / 回传接口（注入点）：真机走 `ans-client`，回归喂假。 */
export interface RequestIo {
  list(nodeId: string): Promise<AnsNodeRequest[]>;
  report(id: string, report: { node_id: string; status: 'done' | 'error' | 'cancelled'; result?: Record<string, unknown> }): Promise<unknown>;
  /**
   * zx_20261030_1 M2：上报进度（**可选**——旧调用方不实现也能编译；缺省即"不上报"，界面如实说）。
   * 失败**由实现方自己吞并记因**（进度是尽力而为，不该把一件正在跑的活报死）。
   */
  progress?(id: string, p: { node_id: string; step: number; total: number | null; note: string }): Promise<unknown>;
  /**
   * zx_20261030_1 M3：查询派活方**是否已叫停**（`GET /requests/:id` 的 `cancel_requested`）。
   * **可选**——旧调用方不实现即"不支持停止"，执行方会跑完并按真实结局回传（界面如实说，不谎称已停）。
   * 查询失败按"未叫停"处理（拉不到 ≠ 已停；一件正在跑的活不该因探针失败被判停）。
   */
  cancelStatus?(id: string): Promise<boolean>;
}

export interface NodeRequestEvent {
  type: 'node.request_received' | 'node.request_completed';
  requestId: string;
  category: string;
  /**
   * 回传终态时携带（`received` 时为 `undefined`）。
   * zx_20261030_1 M3：新增 `cancelled`——派活方叫停后真停的如实回报（既不是完成，也不是失败）。
   */
  status?: 'done' | 'error' | 'cancelled';
  result?: Record<string, unknown>;
  /** 请求方 key 前缀（`received` 时即带上，便于 M13 面板即刻显示"谁派的"）。 */
  requesterKeyPrefix: string;
  /**
   * 派来的那份**请求载荷**（真机上＝`{ prompt }`）。与出站侧同病同治：台账行若不记"派来的是什么"，
   * 用户翻账只看见"有人派过一单"，认不出是哪件活（承 zx_20261011 M9 追加批）。
   */
  requestPayload?: Record<string, unknown>;
}

/**
 * 把 worker 的**回调事件**翻成**事件溯源落库**的 `(type, data)`——**一处真源**（zx_20261011 M10 修）。
 *
 * 病根（E2E 实测坐实）：`main/index.ts` 的 `onEvent` 此前**手抄白名单**（只列
 *   requestId/category/requesterKeyPrefix/status/result）。M9 给事件加了 `requestPayload`，
 *   worker 侧已发、出站侧（`node-dispatcher` 经 `(type,data)=>eventBus.emit` **整体透传**）已显，
 *   **唯独入站这一跳被白名单滤掉** ⇒ B 端台账永远缺"派来的是什么"（A 事件有载荷、B 事件无）。
 *   白名单即改写者：字段一增就漏。故此处**整体透传**——唯一剔除的是 `type`（它是落库的**事件键**，不是 data 成员）。
 *
 * ⚠ 抽成**具名纯函数**的用意：接线那一跳由此**可被 rr 直跑真实现**（M10-1a/b），
 *   而非像我 M9-4 那样只静态读源码——**静态判据照不出这一跳**（正是本批病根）。
 */
export function nodeRequestEventToLog(e: NodeRequestEvent): { type: NodeRequestEvent['type']; data: Record<string, unknown> } {
  const { type, ...data } = e;
  return { type, data };
}

export interface NodeRequestWorkerOpts {
  nodeId: string;
  io: RequestIo;
  runner: RequestRunner;
  /** 每件请求的**到场/收口**回调（M13）——真机接 `eventBus`（持久化事件），回归用于断言。异常不外溢。 */
  onEvent?: (e: NodeRequestEvent) => void;
}

export interface NodeRequestWorkerHandle {
  /** 拉一轮并把拿到的件办掉（真机挂在心跳 `onTick` 里）。返回本次处理的件数。**永不抛**。 */
  poll(): Promise<number>;
}

/**
 * 起消费者。**不**自起定时器——由心跳 `onTick` 驱动（"与心跳同拍"，不另开一条时钟）。
 */
export function startNodeRequestWorker(opts: NodeRequestWorkerOpts): NodeRequestWorkerHandle {
  const { nodeId, io, runner } = opts;
  const emit = (e: NodeRequestEvent) => { try { opts.onEvent?.(e); } catch { /* 面板刷新失败不该改这一件的结局 */ } };
  let busy = false;

  const poll = async (): Promise<number> => {
    // 心跳可能比上一轮 poll 快（慢执行时）⇒ 用 busy 闸防**同进程内**重入；跨进程的重复执行由 ANS
    //   侧"回传即 done"来收敛（回传失败 ⇒ 下轮重拉 ⇒ **至少一次**，如实注释不假装恰好一次）。
    if (busy) return 0;
    busy = true;
    try {
      let requests: AnsNodeRequest[];
      try {
        requests = await io.list(nodeId);
      } catch {
        return 0; // 拉取失败 = 这次没取到，不把任何一件改成别的状态（如实）。
      }
      let handled = 0;
      for (const req of requests) {
        emit({ type: 'node.request_received', requestId: req.id, category: req.category, requesterKeyPrefix: req.requester_key_prefix, requestPayload: req.payload ?? {} });
        const face = categoryToolFace(req.category);
        let outcome: RequestRunResult;
        if (!face.archetype) {
          outcome = { status: 'error', result: { error: `unsupported category: ${req.category}` } };
        } else {
          // M2：进度上报**尽力而为**——`io.progress` 缺省（旧调用方）即不上报；失败只吞不抛
          //   （一件正在跑的活不该因"进度没送出去"而被判失败）。
          const reportProgress: ProgressReporter = (p) => {
            if (!io.progress) return;
            void io.progress(req.id, { node_id: nodeId, step: p.step, total: p.total, note: p.note }).catch(() => { /* 进度是尽力而为 */ });
          };
          // M3：叫停探针——`io.cancelStatus` 缺省（旧调用方）即不支持停止；探针失败按"未叫停"
          //   （拉不到 ≠ 已停，不能凭探针故障把在跑的活判停）。
          const cancelProbe = io.cancelStatus
            ? () => io.cancelStatus!(req.id).catch(() => false)
            : undefined;
          try {
            outcome = await runner(req, face.tools, face.archetype, reportProgress, cancelProbe);
          } catch (e) {
            outcome = { status: 'error', result: { error: (e as Error)?.message || String(e) } };
          }
        }
        try {
          await io.report(req.id, { node_id: nodeId, status: outcome.status, result: outcome.result });
        } catch {
          // 回传失败：**不谎报**；这件仍 `assigned`，下一轮会重拉（至少一次）。
          emit({ type: 'node.request_completed', requestId: req.id, category: req.category, status: 'error', result: { error: 'result report failed' }, requesterKeyPrefix: req.requester_key_prefix });
          handled++;
          continue;
        }
        emit({ type: 'node.request_completed', requestId: req.id, category: req.category, status: outcome.status, result: outcome.result, requesterKeyPrefix: req.requester_key_prefix });
        handled++;
      }
      return handled;
    } finally {
      busy = false;
    }
  };

  return { poll };
}
