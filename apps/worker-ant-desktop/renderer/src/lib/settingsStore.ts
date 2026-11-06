import { useSyncExternalStore } from 'react';
import { invoke } from './ipc';

/**
 * C1 (2026-09-04_2): 设置响应式 store —— 免打扰/声音等规则运行中即时生效（不重启）。
 * 初始化读取 wa_settings 全量，随后：
 *  - main `settings:set` 广播 `settings:changed` → 合并更新；
 *  - 页面主动改后亦可调 `refreshSettings()` 全量回读兜底。
 * 无常·知止：规则不再"挂载时读一次"，改即热更，toast/声音即时按新矩阵决策。
 */

let cache: Record<string, string> = {};
const listeners = new Set<() => void>();

function emit(): void { listeners.forEach((l) => { try { l(); } catch { /* ignore */ } }); }

export async function refreshSettings(): Promise<Record<string, string>> {
  try {
    const all = await invoke<Record<string, string>>('settings:getAll');
    cache = all || {};
  } catch { /* 读取失败保留旧值 */ }
  emit();
  return cache;
}

export function patchSetting(key: string, value: string): void {
  cache = { ...cache, [key]: value };
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function getSnapshot(): Record<string, string> { return cache; }

function getServerSnapshot(): Record<string, string> { return {}; }

/** React hook：返回当前设置 map；main 推送/refresh 后触发重渲染 */
export function useSettings(): Record<string, string> {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** 免打扰时段判定（可跨午夜；空值=未启用）——用最新设置，运行时即时 */
export function isQuietTimeActive(settings: Record<string, string>): boolean {
  const start = settings.notify_quiet_start?.trim() || '';
  const end = settings.notify_quiet_end?.trim() || '';
  if (!start || !end) return false;
  const toMin = (hh: string): number | null => { const m = /^(\d{1,2}):(\d{2})$/.exec(hh); if (!m) return null; return Number(m[1]) * 60 + Number(m[2]); };
  const a = toMin(start); const b = toMin(end);
  if (a == null || b == null) return false;
  const now = new Date();
  const n = now.getHours() * 60 + now.getMinutes();
  return a <= b ? n >= a && n < b : n >= a || n < b;
}

// 模块初始化：非浏览器环境注册设置变更订阅并回读一次
if (typeof window !== 'undefined') {
  const api = window.electronAPI;
  if (api && typeof api.onSettingsChanged === 'function') {
    api.onSettingsChanged(({ key, value }) => patchSetting(key, value));
  }
  void refreshSettings();
}
