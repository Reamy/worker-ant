/**
 * zx_20261011_4 M3（道德经·知止 / 维特根斯坦·意义即使用）: 跨机**编排**的左半场——把本机**跑不过来**的就绪
 *   子任务**真派出去**（接手 `planOffloads` 的决策，落成一次真动作）。
 *
 * 病根（`plans/improve/zx_20261011_4.md` §1 N1）：派活的**发送侧**此前只有人手点（「派活」卡 IPC）；
 *   引擎**从不自动派**——本机并发占满时，溢出待办只会干等，网络里闲着的他机永远接不到活。
 *   批一让了位（已外派的不抢跑）、批二能收回（远端回传收口），却**没人真派** ⇒ 两头通了，中间那口气没吹。
 *
 * 知止缺省（承 `planOffloads`）：**只有本机自己跑不过来时才外派**——mode 未开、本机还有空位、
 *   或没有在线可派对端，一律**不外派**（不自足者不外派，不惊扰既有行为）。
 *
 * ⚠ 本模块**不触网、不引 electron**：`io`/`emit`/`listPeers`/`readyTasks`/`teamRefusal`/`now` 皆可注入
 *   （真机装配在 `main/index.ts`；回归喂假）——故受控回归可不出网直跑真逻辑（同 `node-dispatcher.ts` 纪律）。
 * ⚠ **永不抛**：本拍的各种"不做"（未开/未入网/被档位拦/无对端/派发失败）装进 `note` 如实回报，由调用方
 *   （心跳拍）自行决定下一步——**不做**也要说得出理由，不静默。
 * ⚠ 状态载体**不新增**：外派标记仍写 `context_json` 三键（`node-orchestrate` 一处真源），本地任务**仍 `pending`**。
 */
import type Database from 'better-sqlite3';
import { createLogger } from './logger.js';
import { dispatchNodeRequest, type DispatchIo, type DispatchEventSink, type DispatchResult } from './node-dispatcher.js';
import {
  markRemoteAssigned,
  planOffloads,
  readOrchestrateMode,
  type OrchestrateDb,
  type OrchestrateMode,
} from './node-orchestrate.js';
import { isNodeEnrolled } from './node-heartbeat.js';
import { ensureNodeIdentity, type NodeSettingDb } from './node-identity.js';
import { fetchNodes, listDispatchablePeers } from './node-list.js';
import { projectScanVerdict, resolveProjectConcurrency } from './task-accounting.js';
import { teamFeatureRefusal, type TeamFeature } from './team-gate.js';
import type { LicenseSettingDb } from './license.js';
import type { AnsNode } from '@worker-ant/shared-types';
import { routeCategoryForTask } from './task-routing.js';
import { collectUpstreamSummaries } from './collab-dispatch.js';

const logger = createLogger('orchestrator');

/** Team 档能力项——多机协同（与协同面板/派活卡同一格）。 */
const ORCHESTRATE_FEATURE: TeamFeature = 'multi_node';

export interface OrchestrateDriveDeps {
  /** 注入 IO（缺省懒建真实现 `makeAnsDispatchIo(db)`，经 `dispatchNodeRequest` 内的解析）。 */
  io?: DispatchIo;
  /** 注入事件出口（缺省懒取 `eventBus.emit`）。 */
  emit?: DispatchEventSink;
  /** 取本机此刻**可派**对端（真机＝`fetchNodes` + `listDispatchablePeers`；回归喂假）。 */
  listPeers?: (nowMs: number) => Promise<AnsNode[]>;
  /**
   * 取某项目**就绪**任务行——**必给**（真源＝`TaskScheduler.getReadyTasks`：依赖满足 ∧ 未外派 ∧ `pending`）。
   *   ⚠ 不由本模块自写一份 SQL：排序/就绪判据都在那处，这两边一漂，外派的顺序就与本地拉起的不一致。
   */
  readyTasks: (projectId: string) => Array<Record<string, unknown>>;
  /** Team 软闸（缺省＝`teamFeatureRefusal(db,'multi_node')`）。返回串即如实拒因；`null` 即放行。 */
  teamRefusal?: () => string | null;
  /** `now` 注入（回归不依赖墙钟；缺省 `Date.now`）。 */
  now?: () => number;
  /** 每拍外派上限覆盖（缺省 `ORCHESTRATE_OVERFLOW_PER_TICK`）。 */
  maxPerTick?: number;
}

/** 一拍驱动的结局（供 rr 正面断言与日志）。 */
export interface OrchestrateDriveResult {
  /** 本拍读到的编排模式。 */
  mode: OrchestrateMode;
  /** 本机此刻**可派**对端数（N3 预查的读数；未走到预查时为 0）。 */
  peers: number;
  /** 本拍**真的写齐三键**的外派件数（派发出去了但归属没写上 ⇒ 不计）。 */
  offloaded: number;
  /** **没外派**的如实理由（`''`＝本拍确实派了、或本拍无事可派）；非空即"为什么没派"。 */
  note: string;
}

/** 缺省取对端：本机可派台账（`fetchNodes` 失败时如实回空——不编一份假台账）。 */
async function defaultListPeers(db: Database.Database, nowMs: number): Promise<AnsNode[]> {
  const localNodeId = ensureNodeIdentity(db as unknown as NodeSettingDb).id;
  const ledger = await fetchNodes(db, localNodeId);
  return listDispatchablePeers(ledger, nowMs);
}

/**
 * 本拍该扫哪些项目——**与调度器同一尺**（`projectScanVerdict`）：被暂停/完成/归档的项目不参与外派，
 *   否则"本机不跑的项目"反而被推给他机，静默越权（承 `zx_20260930 M11-7` 的同一判据）。
 */
function listScannableProjectIds(db: Database.Database, now: Date): string[] {
  try {
    const rows = db.prepare('SELECT id, status, context_json FROM wa_projects').all() as Array<{
      id: string;
      status: string;
      context_json: string | null;
    }>;
    return rows
      .filter((r) => {
        try {
          return projectScanVerdict(r, now).scan;
        } catch {
          return false;
        }
      })
      .map((r) => r.id);
  } catch {
    return [];
  }
}

/**
 * 子任务的**外派载荷**（真机上 B 端据 `payload.prompt` 建任务，见 `node-request-runner`）。
 *   取**标题 + 描述**拼成的"这件事是什么"；验收标准**另存一栏**（不混进 prompt——B 端要能分辨
 *   "要做什么"与"做到什么算数"，混成一句就分不开了）。
 *   全空（无标题无描述）⇒ 退回 `taskId`（不编一句摘要冒充"派来的内容"）。
 */
function taskDispatchPayload(db: Database.Database, taskId: string): Record<string, unknown> {
  const row = readTaskForDispatch(db, taskId);
  const prompt = [row?.title ?? '', row?.description ?? ''].map((s) => String(s).trim()).filter(Boolean).join('\n\n');
  const acceptance = String(row?.acceptance_criteria ?? '').trim();
  // zx_20261023_5 批一：溢出派发同样带上上游摘要（就绪件可能已有满足的前置）——
  //   远端靠它知道"前置做完了什么"，不靠一条跨机 DAG。
  const upstream = collectUpstreamSummaries(db, taskId);
  return {
    prompt: prompt || taskId,
    ...(acceptance ? { acceptance_criteria: acceptance } : {}),
    ...(upstream.length > 0 ? { upstream } : {}),
  };
}

/** 读外派所需的三个字段（载荷与类目同一次取数——不各查一遍，免得两处看到不同的行）。 */
function readTaskForDispatch(
  db: Database.Database,
  taskId: string,
): { title?: string | null; description?: string | null; acceptance_criteria?: string | null } | undefined {
  try {
    return db
      .prepare('SELECT title, description, acceptance_criteria FROM wa_tasks WHERE id = ?')
      .get(taskId) as { title?: string | null; description?: string | null; acceptance_criteria?: string | null } | undefined;
  } catch {
    return undefined;
  }
}

/**
 * 本件按**任务形态**该派给哪类节点；`null` = 不确定/对话形态 ⇒ 不外派（本地跑）。
 * 类目判据在 `task-routing.ts` 一处，本函数只做"读行 → 问它"。
 */
function taskRouteCategory(db: Database.Database, taskId: string): string | null {
  const row = readTaskForDispatch(db, taskId);
  return routeCategoryForTask(row?.title, row?.description);
}

/**
 * 一拍编排：**本机跑不过来**的就绪子任务，逐个派给网络里的他机。
 *
 * 前置闸（任一不过 ⇒ 直接返回，`note` 说明是哪一道）：
 *   ① `mode !== 'auto'`（缺省 `off`，不惊扰既有行为）；
 *   ② 本机未入网（没有身份就没有读回凭据，派出去也收不回）；
 *   ③ Team 软闸未开（多机协同属团队版能力）。
 * 预查（N3）：本机可派对端为空 ⇒ 不外派（免得造一张**永远没人接**的悬空单）。
 * 逐个外派：`planOffloads` 挑出溢出件 → **按任务形态取类目**（`task-routing`；判不出/对话形态 ⇒
 *   留本地跑，不硬派）→ `dispatchNodeRequest`（`requireTarget: true`：无合格对端即 409、不落悬空单）
 *   → `ok` 且知去向 ⇒ 写齐三键；`!ok`（角色不许/无目标/提交失败）⇒ **不外派**、本地跑（如实记日志，不假装派了）。
 *
 * ⚠ **永不抛**：整拍包在 try 内，异常退化成"本拍不派"并存 `note`。
 */
export async function driveOrchestration(
  db: Database.Database,
  deps: OrchestrateDriveDeps,
): Promise<OrchestrateDriveResult> {
  const odb = db as unknown as OrchestrateDb;
  const mode = (() => {
    try {
      return readOrchestrateMode(odb);
    } catch {
      return 'off' as OrchestrateMode;
    }
  })();

  if (mode !== 'auto') return { mode, peers: 0, offloaded: 0, note: `mode=${mode}（未开外派）` };

  try {
    if (!isNodeEnrolled(db as unknown as NodeSettingDb)) return { mode, peers: 0, offloaded: 0, note: 'not-enrolled' };

    const refusal = deps.teamRefusal
      ? deps.teamRefusal()
      : teamFeatureRefusal(db as unknown as LicenseSettingDb, ORCHESTRATE_FEATURE);
    if (refusal) return { mode, peers: 0, offloaded: 0, note: `team-gate: ${refusal}` };

    const nowMs = deps.now ? deps.now() : Date.now();
    let peers: AnsNode[];
    try {
      peers = deps.listPeers ? await deps.listPeers(nowMs) : await defaultListPeers(db, nowMs);
    } catch (e) {
      return { mode, peers: 0, offloaded: 0, note: `list-peers-failed: ${(e as Error)?.message || String(e)}` };
    }
    // N3 预查：没有可派的他机就不外派——派出去也没人接，只会留一张悬空单（知止）。
    if (peers.length === 0) return { mode, peers: 0, offloaded: 0, note: 'no-dispatchable-peer' };

    let offloaded = 0;
    let offered = 0;
    /** 真正尝试派出的件数（类目可路由、且过了 `planOffloads`）——与"选中但不可路由"分开记账。 */
    let attempted = 0;
    for (const projectId of listScannableProjectIds(db, new Date(nowMs))) {
      let running: number;
      let available: number;
      try {
        ({ running, available } = resolveProjectConcurrency(db, projectId));
      } catch {
        continue;
      }
      let ready: Array<Record<string, unknown>>;
      try {
        ready = deps.readyTasks(projectId);
      } catch (e) {
        logger.warn({ err: e, projectId }, '取就绪任务失败，本项目本拍不外派');
        continue;
      }
      const taskIds = planOffloads({
        ready,
        localOccupied: running,
        available,
        mode,
        ...(deps.maxPerTick !== undefined ? { maxPerTick: deps.maxPerTick } : {}),
      });
      offered += taskIds.length;

      for (const taskId of taskIds) {
        // 类目按**任务形态**取（真源 `task-routing`）；判不出/对话形态 ⇒ 留本地跑，不猜一个类目硬派。
        const category = taskRouteCategory(db, taskId);
        if (!category) {
          logger.info({ taskId }, '任务形态不可路由，本件不外派（本地跑）');
          continue;
        }
        attempted++;
        let r: DispatchResult;
        try {
          r = await dispatchNodeRequest(
            db,
            { category, payload: taskDispatchPayload(db, taskId), requireTarget: true },
            { ...(deps.io !== undefined ? { io: deps.io } : {}), ...(deps.emit !== undefined ? { emit: deps.emit } : {}) },
          );
        } catch (e) {
          logger.warn({ err: e, taskId }, '外派调用异常，本件不外派（本地跑）');
          continue;
        }
        // `!ok` ⇒ 不外派、本地跑（如实）：角色不许 / 未入网 / 提交失败——都不假装派了。
        if (!r.ok || !r.targetNodeId) {
          logger.info({ taskId, note: r.note }, '外派未成，本件留给本地调度器');
          continue;
        }
        if (markRemoteAssigned(db, taskId, { nodeId: r.targetNodeId, requestId: r.requestId })) {
          offloaded++;
          logger.info({ taskId, nodeId: r.targetNodeId, requestId: r.requestId }, '子任务已外派他机');
        } else {
          // 派发出去了却写不上归属（任务行没了/写失败）⇒ 本地不认领，如实告警（不静默：可能重复执行）。
          logger.warn({ taskId, requestId: r.requestId }, '外派已提交但他机归属写失败，本地仍待办（可能重复执行）');
        }
      }
    }

    // 三种"没派成"分开说：无溢出（没事可派）/ 形态不可路由（不该派、留本机）/ 真尝试了却没成。
    const note = offloaded > 0
      ? ''
      : attempted > 0
        ? `offload-failed (${attempted})`
        : offered > 0
          ? `unrouted (${offered})`
          : 'no-overflow';
    return { mode, peers: peers.length, offloaded, note };
  } catch (e) {
    logger.warn({ err: e }, '编排驱动异常，本拍不外派');
    return { mode, peers: 0, offloaded: 0, note: `drive-failed: ${(e as Error)?.message || String(e)}` };
  }
}
