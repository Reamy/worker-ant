import { useCallback, useEffect, useRef, useState } from 'react';
import { useActivity, type ActivityEvent } from './activity';

/**
 * A1 (2026-09-04_2): 统一"读数据 + 保鲜"出口 —— 把页面数据拉取收敛为一条查询，
 * 返回 data/loading/error/updatedAt/stale/isLive/reload，并可在命中的实时事件到达时自动刷新。
 *
 * 设计背景（空性·无常）：界面数据皆是"某时点的事件流投影"；任何页面都应有保鲜语义——
 * 实时（有自动事件源）、新鲜（距最近刷新未超阈值）、或 stale（数据可能已过期，提示手动刷新）。
 */

export interface LiveEventMatch {
  type: string;
  projectId?: string;
  taskId?: string;
  task_id?: string;
}

export interface LiveQueryOptions {
  /** 命中即触发自动刷新的事件类型集合；留空 = 纯手动页（仅保鲜提示，不自动刷新） */
  liveTypes?: readonly string[];
  /** 事件级精筛（默认：liveTypes 内全部命中） */
  match?: (e: LiveEventMatch) => boolean;
  /** 距最近一次成功刷新超过该毫秒数即视为 stale（默认 90_000 = 1.5 分钟） */
  staleAfterMs?: number;
  /** 同批事件连续涌入时的合并刷新窗口（毫秒，默认 700） */
  debounceMs?: number;
  /** 每次成功刷新后（含首次）触发的副动作，用于同步同页其它次级数据 */
  onRefreshed?: () => void;
  /** false 时暂停订阅与取数（默认 true） */
  enabled?: boolean;
}

export interface LiveQuery<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** 最近一次成功刷新的 epoch 毫秒；null = 尚未成功 */
  updatedAt: number | null;
  /** 超过 staleAfterMs 未刷新 → true（无常：数据可能已过期） */
  stale: boolean;
  /** 已配置 liveTypes（存在预期自动刷新源） */
  isLive: boolean;
  /** 手动/事件驱动的统一刷新入口 */
  reload: () => Promise<void>;
}

export function useLiveQuery<T>(
  loader: () => Promise<T>,
  /** 变化即重取的依赖（页面过滤条件等）；loader 无需 useCallback，本 Hook 经 ref 取最新闭包 */
  key: readonly unknown[] = [],
  options: LiveQueryOptions = {},
): LiveQuery<T> {
  const { liveTypes = [], match, staleAfterMs = 90_000, debounceMs = 700, enabled = true } = options;
  const onRefreshedRef = useRef(options.onRefreshed);
  onRefreshedRef.current = options.onRefreshed;

  const { subscribe } = useActivity();

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // loader 经 ref 保存：取数时读取最新闭包（当前过滤条件），避免 loader 引用变化引发效应循环
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const doFetch = useCallback(async (showLoading: boolean) => {
    if (showLoading) setLoading(true);
    try {
      const result = await loaderRef.current();
      setData(result);
      setError(null);
      setUpdatedAt(Date.now());
      try { onRefreshedRef.current?.(); } catch { /* 副动作异常不阻塞主查询 */ }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // 挂载 / key 变化取数（首次显示加载态，后续切换条件不整页闪烁）
  const prevKeyRef = useRef<readonly unknown[]>(key);
  const isFirstRef = useRef(true);
  useEffect(() => {
    if (!enabled) return;
    const keyChanged = isFirstRef.current || key.some((k, i) => !Object.is(k, prevKeyRef.current[i]));
    prevKeyRef.current = key;
    if (keyChanged) {
      const wasFirst = isFirstRef.current;
      isFirstRef.current = false;
      void doFetch(wasFirst);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...key]);

  // 实时订阅：命中 liveTypes(+match) 的事件 → 防抖触发刷新
  const debounceRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!enabled || liveTypes.length === 0) return;
    return subscribe((e: ActivityEvent) => {
      if (!liveTypes.includes(e.type)) return;
      if (match) {
        const m: LiveEventMatch = { type: e.type, projectId: e.projectId, taskId: e.taskId };
        if (!match(m)) return;
      }
      if (debounceRef.current !== undefined) return;
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = undefined;
        void doFetch(false);
      }, debounceMs);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, liveTypes.join('|'), match, debounceMs, enabled, doFetch]);

  useEffect(() => () => { if (debounceRef.current !== undefined) window.clearTimeout(debounceRef.current); }, []);

  // 保鲜节拍：每 10s 推进 nowMs，驱动 stale 重算
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(() => setNowMs(Date.now()), 10_000);
    return () => window.clearInterval(t);
  }, [enabled]);

  const stale = updatedAt != null && nowMs - updatedAt > staleAfterMs;
  const isLive = liveTypes.length > 0 && enabled;

  const reload = useCallback(() => doFetch(true), [doFetch]);

  return { data, loading, error, updatedAt, stale, isLive, reload };
}

/**
 * 给"自维护 loader、不整体走 useLiveQuery"的页（如 Dashboard 的多端点 loadAll）
 * 提供轻量保鲜节拍：返回"距最近成功刷新超过 staleAfterMs"是否为 stale（无常标记）。
 */
export function useStaleness(updatedAt: number | null, staleAfterMs = 90_000, enabled = true): boolean {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(() => setNowMs(Date.now()), 10_000);
    return () => window.clearInterval(t);
  }, [enabled]);
  return updatedAt != null && nowMs - updatedAt > staleAfterMs;
}
