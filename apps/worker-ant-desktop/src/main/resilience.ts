import { app, powerMonitor, BrowserWindow } from 'electron';

let crashCount = 0;
const MAX_CRASH_RESTARTS = 3;
const CRASH_WINDOW_MS = 60_000; // 1分钟内最多重启3次
let firstCrashTime = 0;

// zx_20261011 M7: 关机收尾标志。`stopCore()` 期间事件循环仍在跑，此刻 pino transport worker
// 可能已随退出收摊——任何 logger 写入都会同步抛 `the worker has exited`。那不是"未捕获异常"，
// 更不是致命错误，静默即可（详见 plans/improve/zx_20261011.md M7）。
let _shuttingDown = false;

/** 由 `before-quit` 在收尾**之前**调用。 */
export function markShuttingDown(): void {
  _shuttingDown = true;
}
/**
 * 初始化崩溃自动重启和系统休眠恢复。
 * - 渲染进程崩溃：自动重载或退出
 * - 主进程崩溃：记录状态，下次启动恢复
 * - 系统休眠唤醒：通知渲染进程刷新连接
 */
export function initResilience(mainWindow: BrowserWindow): void {
  // 系统休眠唤醒 → 通知渲染进程刷新 IM 连接和 SSE
  if (powerMonitor) {
    powerMonitor.on('resume', () => {
      console.log('[工蚁] 系统从休眠中唤醒，通知前端刷新连接...');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('system:resume');
      }
    });

    powerMonitor.on('suspend', () => {
      console.log('[工蚁] 系统进入休眠');
    });

    // macOS: 屏幕解锁后刷新
    powerMonitor.on('unlock-screen', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('system:resume');
      }
    });
  }

  // 渲染进程崩溃处理
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[工蚁] 渲染进程崩溃:', details.reason, 'exitCode:', details.exitCode);
    const now = Date.now();
    if (now - firstCrashTime > CRASH_WINDOW_MS) {
      crashCount = 0;
      firstCrashTime = now;
    }
    crashCount++;

    if (crashCount <= MAX_CRASH_RESTARTS) {
      console.log(`[工蚁] 自动重启渲染进程 (${crashCount}/${MAX_CRASH_RESTARTS})...`);
      if (mainWindow.isDestroyed()) {
        app.relaunch();
        app.exit(0);
      } else {
        mainWindow.reload();
      }
    } else {
      console.error(`[工蚁] 渲染进程在${CRASH_WINDOW_MS/1000}秒内崩溃${crashCount}次，停止自动重启`);
      // 不再自动重启，让用户手动处理
    }
  });

  // 主进程未捕获异常 → 记录并重启
  process.on('uncaughtException', (err) => {
    // 关机收尾期：写日志撞已收摊的 transport worker 属预期竞态，静默（不冒充异常、不误判致命）。
    if (_shuttingDown) return;
    console.error('[工蚁] 未捕获异常:', err.message, err.stack);
    // 非致命错误（如网络超时）不重启
    if (isFatalError(err)) {
      console.error('[工蚁] 致命错误，准备重启...');
      app.relaunch();
      app.exit(1);
    }
  });
}

function isFatalError(err: Error): boolean {
  // 仅对内存溢出、V8引擎错误等致命问题重启
  const fatalPatterns = [
    'JavaScript heap out of memory',
    'FATAL ERROR',
    'v8::',
    'Cannot find module',
  ];
  const msg = err.message;
  return fatalPatterns.some(p => msg.includes(p));
}
