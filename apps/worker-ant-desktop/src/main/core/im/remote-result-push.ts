/**
 * zx_20261104_3 M2「联」（维特根斯坦·意义即使用 / 毛选·不打无准备之仗）:
 * **跨机任务收口后，人不在电脑前也知道**——把 `node.request_result` 接成 IM 私聊通知。
 *
 * 病根：外派的任务收口只落事件日志与面板；用户离开电脑后，"那单跑完了没有"只能回来点开看
 *   —— 本轮既已把子任务派得出去，收口这一跳也得**送得回来**。
 *
 * 三条纪律（同 `device-auth-push.ts`）：
 *  ① **只报真结局**：只认 `done` / `error` / `cancelled` 三档（其余非终态不推）。
 *  ② **一次窗口一条**：5 秒窗口内同批收口聚合成一条（最多 5 行，其余引导去桌面端）；按 `requestId` 去重
 *     （同一单被多次读回也不重复报——发端幂等之外再加一层，防面板轮询把同一结局重放）。
 *  ③ **旁路不阻断**：推送失败如实打日志，不影响事件转发与台账落库。
 *
 * ⚠ 零 electron 依赖；定时器可注入（rr 不依赖墙钟）。
 */
import type { NodeDispatchRecord } from '../node-dispatch-log.js';
import { buildRemoteResultNotice } from './approval-inbox.js';
import { createLogger } from '../logger.js';

const log = createLogger('im-remote-result');

/** 聚合窗口：首个收口到达后等这么久，把同批结果并成一条。 */
export const REMOTE_RESULT_PUSH_WINDOW_MS = 5000;

/** 一次推送最多列几行（透传 `buildRemoteResultNotice`，其余引导查桌面端）。 */
export const REMOTE_RESULT_PUSH_MAX_LINES = 5;

/** 计入通知的最小形状（`node.request_result` 载荷能直接满足）。 */
export type RemoteResultNoticeInput = Pick<NodeDispatchRecord, 'requestId' | 'category' | 'targetNodeId'> & {
  status: string;
  selection?: Record<string, unknown> | null;
};

/** 只报这三档（其余非终态 / 未知值一律不推）。 */
export function isNotifiableResultStatus(status: unknown): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled';
}

export interface RemoteResultPushDeps {
  /** 真发（生产＝`pushImOwnerNotice`）；失败由本模块记录，不抛给事件链。 */
  push(message: string, kind: string): Promise<void>;
  /** 计时器（rr 注入同步假钟；返回句柄用于清除）。 */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void; cancel?: () => void };
  windowMs?: number;
  /** 一次最多列几行（透传文案函数）。 */
  limit?: number;
  /** 出错留痕（缺省写按天日志；rr 可收集）。 */
  onError?: (err: unknown) => void;
}

export interface RemoteResultPusher {
  /** 一条收口事件的载荷；非终态 / 坏形状一律忽略。 */
  onResult(data: RemoteResultNoticeInput | null | undefined): void;
  /** 立刻冲刷窗口（rr / 退出前用；生产通常让定时器自己到点）。 */
  flush(): void;
}

const defaultSetTimer = (fn: () => void, ms: number): { unref?: () => void; cancel: () => void } => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
};

export function createRemoteResultPusher(deps: RemoteResultPushDeps): RemoteResultPusher {
  const windowMs = deps.windowMs ?? REMOTE_RESULT_PUSH_WINDOW_MS;
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const onError = deps.onError ?? ((err: unknown) => log.error({ kind: 'remote_result', outcome: 'error', error: (err as Error)?.message || String(err) }, '跨机收口推送失败'));
  let buffer: RemoteResultNoticeInput[] = [];
  let timer: { unref?: () => void; cancel?: () => void } | null = null;

  const flush = (): void => {
    if (timer?.cancel) timer.cancel();
    timer = null;
    const batch = buffer;
    buffer = [];
    if (batch.length === 0) return;
    const message = buildRemoteResultNotice(batch, deps.limit ?? REMOTE_RESULT_PUSH_MAX_LINES);
    if (!message) return;
    void deps.push(message, 'remote_result').catch(onError);
  };

  return {
    onResult(data) {
      if (!data || typeof data.requestId !== 'string' || data.requestId.length === 0) return;
      if (!isNotifiableResultStatus(data.status)) return;
      // 同一单只报一次（后到的是同一结局的重放，不重复打扰）。
      if (buffer.some((r) => r.requestId === data.requestId)) return;
      buffer.push(data);
      if (!timer) timer = setTimer(flush, windowMs);
    },
    flush,
  };
}
