import { useEffect, useRef } from 'react';

/**
 * 主进程实时任务事件（IPC task:event）负载子集。
 * 结构与 renderer/src/types/electron.d.ts 的 TaskEvent 对齐，取本仓库页面所需字段。
 */
export interface TaskStreamEvent {
  type: string;
  taskId?: string;
  task_id?: string;
  projectId?: string;
  newStatus?: string;
  new_status?: string;
  step?: number;
  text?: string;
  textDelta?: string;
  reasoningDelta?: string;
  [key: string]: unknown;
}

export type TaskEventHandler = (event: TaskStreamEvent) => void;

/**
 * 在组件生命周期内订阅一次主进程任务事件，handler 用 ref 始终指向最新回调，
 * 避免因 handler 每次渲染变化导致反复订阅/退订。
 */
export function useTaskEvents(handler: TaskEventHandler | undefined | null, enabled = true): void {
  const handlerRef = useRef<TaskEventHandler | null>(null);

  useEffect(() => {
    handlerRef.current = handler ?? null;
  }, [handler]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const api = window.electronAPI;
    if (!api || typeof api.onTaskEvent !== 'function') return;
    const unsubscribe = api.onTaskEvent((e) => {
      handlerRef.current?.(e as TaskStreamEvent);
    });
    return () => unsubscribe();
  }, [enabled]);
}
