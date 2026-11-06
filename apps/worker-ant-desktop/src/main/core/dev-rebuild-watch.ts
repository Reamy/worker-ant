/**
 * zx_20261106_1 M6「见」（维特根斯坦·意义即使用 / 毛选·不打无准备之仗）:
 * **进程跑的是哪份磁盘代码，得让人知道**——dev 下 `tsup` 重写 dist 后，正在运行的 Electron
 * 仍持有启动时加载的旧模块图；现象是"改了没生效 / 通知莫名不发"，只能靠猜反推。
 *
 * ⚠ 这是**护栏，不是根因修复**：根因在 M1——通知路径改静态接线，不再依赖启动时可被清理的 chunk。
 *   本模块只负责让"旧进程跑新磁盘"这件事**可见**。
 *
 * 四条纪律：
 *  ① 只在 dev 启动（`main/index.ts` 以 `isDev` 分支为唯一入口；打包版不重构建，不该起定时器）。
 *  ② 一次变化只提示一次（按 mtime 去重，不刷屏）。
 *  ③ 读不到入口文件不算变化（重建过程中的瞬态缺文件不打扰）。
 *  ④ 定时器 `unref()`，退出由 `stop()` 清理。
 *
 * ⚠ 零 electron 依赖；stat / 定时器 / 提示全可注入（rr 不依赖墙钟与真实文件系统）。
 */
export const DEV_REBUILD_WATCH_INTERVAL_MS = 60_000;

/** 提示文案（rr 按符号引用，不手抄字面量）。 */
export const DEV_REBUILD_NOTICE = {
  title: '工蚁：检测到运行中重构建',
  body: '桌面端仍在运行旧代码，请重启以加载新构建。',
} as const;

export interface DevRebuildWatchDeps {
  /** 被监视的入口文件（dev 即 `dist/main/index.js`，tsup 每次重构建都会重写它）。 */
  entryPath: string;
  /** 取 mtime（毫秒）；读不到返回 null——不当作变化。 */
  statMtime: (p: string) => number | null;
  /** 发生变化时提示一次（生产实现＝`log.warn` + 系统通知）。 */
  onStale: (prevMs: number | null, curMs: number) => void;
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void; cancel: () => void };
  intervalMs?: number;
}

export interface DevRebuildWatcher {
  /** 立即比对一次（rr / 测试用；生产由定时器驱动）。返回是否判定为"变了"。 */
  tick(): boolean;
  stop(): void;
}

const defaultSetInterval = (fn: () => void, ms: number): { cancel: () => void } => {
  const t = setInterval(fn, ms);
  t.unref?.();
  return { cancel: () => clearInterval(t) };
};

export function startDevRebuildWatch(deps: DevRebuildWatchDeps): DevRebuildWatcher {
  const intervalMs = deps.intervalMs ?? DEV_REBUILD_WATCH_INTERVAL_MS;
  const setInt = deps.setInterval ?? defaultSetInterval;
  let last = deps.statMtime(deps.entryPath);
  const tick = (): boolean => {
    const cur = deps.statMtime(deps.entryPath);
    if (cur === null || cur === last) return false;
    const prev = last;
    last = cur;
    deps.onStale(prev, cur);
    return true;
  };
  const handle = setInt(tick, intervalMs);
  return {
    tick,
    stop() { handle.cancel(); },
  };
}
