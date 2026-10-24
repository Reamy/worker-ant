import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTaskEvents, type TaskStreamEvent } from '../hooks/useTaskEvents';

export interface ActivityEvent {
  seq: number;
  type: string;
  taskId?: string;
  projectId?: string;
  title: string;
  level: 'info' | 'warn' | 'error';
  ts: string;
  raw: TaskStreamEvent;
}

export interface ActivityContextValue {
  /** 最近关键事件 ring buffer（不含高频瞬态流式事件） */
  events: ActivityEvent[];
  /** 订阅全局实时事件；返回退订函数 */
  subscribe(cb: (e: ActivityEvent) => void): () => void;
}

const ActivityContext = createContext<ActivityContextValue | null>(null);

/** 高频瞬态事件不入 activity 缓冲（token 级流式 / 长任务心跳），避免刷屏 */
const STREAMING_TYPES = new Set(['task.step_streaming', 'task.heartbeat']);
/** zx_20260906 批4 (4a/4d): 仅向订阅者广播、不入活动环缓冲（避免 ActivityPage 被 IM 入站/记忆沉淀刷屏；MemoriesPage 等仍需订阅消费） */
// zx_20261004 M4: `node.heartbeat` 同列——它每 ~30s 一发，是运行期噪声（协同面板据它刷"本机在场"），
//   但不应在活动页堆成一行行 'node.heartbeat'。档位变更 `node.presence_changed` **不入此列**：低频且值得留痕。
const BROADCAST_ONLY_TYPES = new Set(['im.message_inbound', 'memory.changed', 'node.heartbeat']);

const TITLE_MAP: Record<string, string> = {
  'task.completed': '任务完成',
  'task.failed': '任务失败',
  'task.awaiting_input': '任务等待你输入',
  'task.status_changed': '任务状态变更',
  'task.step_finished': '任务步骤完成',
  'task.memory_injected': '记忆已注入',
  'task.goal_identified': '目标已识别',
  'task.goal_deviation': '目标偏离',
  'task.execution_signal': '执行信号',
  'task.estimated': '任务预估',
  'project.status_changed': '项目状态变更',
  'deliverable.registered': '交付物已注册',
  'file.created': '文件已创建',
  'file.updated': '文件已更新',
  'file.edited': '文件已编辑',
  'deliverable.status_changed': '产出物状态变更',
  // zx_20261018_2 批六：三类瞬态刷新事件（低频；活动页给一行人话，不显示裸类型名）。
  'deliverable.runtime_changed': '产出物运行态变更',
  'external.status_changed': '外部终端门态变更',
  'external.call_recorded': '外部终端调用留痕',
  'external.lan_changed': '局域网终端出现',
  'im.message_inbound': 'IM 收到新消息',
  'memory.changed': '记忆已沉淀',
  // zx_20261004 M4: 节点档位/在场变更（低频、持久化）——活动页可见"谁何时改了档"。
  'node.presence_changed': '节点档位变更',
};

function levelOf(type: string): ActivityEvent['level'] {
  if (type.includes('failed') || type.includes('error')) return 'error';
  if (type.includes('deviation') || type.includes('warning') || type === 'task.awaiting_input') return 'warn';
  return 'info';
}

function titleOf(type: string, raw: TaskStreamEvent): string {
  const base = TITLE_MAP[type] ?? type;
  // 任务名优先（主进程转发事件时补 `taskTitle`）；缺名才退回 id 前 8 位。
  const name = typeof raw.taskTitle === 'string' ? raw.taskTitle.trim() : '';
  if (name) return `${base} · ${name}`;
  const id = raw.taskId ?? raw.task_id ?? raw.projectId;
  return id ? `${base} · ${id.slice(0, 8)}` : base;
}

export function ActivityProvider({ children }: { children: React.ReactNode }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const listeners = useRef(new Set<(e: ActivityEvent) => void>());
  const seq = useRef(0);

  const dispatch = useCallback((e: TaskStreamEvent) => {
    if (STREAMING_TYPES.has(e.type)) return;
    const act: ActivityEvent = {
      seq: ++seq.current,
      type: e.type,
      taskId: e.taskId ?? e.task_id,
      projectId: e.projectId,
      title: titleOf(e.type, e),
      level: levelOf(e.type),
      ts: new Date().toISOString(),
      raw: e,
    };
    listeners.current.forEach((l) => {
      try {
        l(act);
      } catch {
        /* 单个订阅者异常不影响其余 */
      }
    });
    if (BROADCAST_ONLY_TYPES.has(e.type)) return;
    setEvents((prev) => [...prev.slice(-99), act]);
  }, []);

  // 全局只订阅一次主进程任务事件，所有页面经 subscribe 共享
  useTaskEvents(dispatch, true);

  const subscribe = useCallback((cb: (e: ActivityEvent) => void) => {
    listeners.current.add(cb);
    return () => {
      listeners.current.delete(cb);
    };
  }, []);

  const value = useMemo<ActivityContextValue>(() => ({ events, subscribe }), [events, subscribe]);

  return <ActivityContext.Provider value={value}>{children}</ActivityContext.Provider>;
}

export function useActivity(): ActivityContextValue {
  const ctx = useContext(ActivityContext);
  if (!ctx) throw new Error('useActivity 必须在 <ActivityProvider> 内使用');
  return ctx;
}
