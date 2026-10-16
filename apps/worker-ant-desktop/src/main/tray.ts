import { Tray, Menu, nativeImage, BrowserWindow, app, type NativeImage } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;
let _win: BrowserWindow | null = null;
// 引擎状态 tooltip 基线(如「工蚁 · 运行中」) + 在场运行数叠加(D1 最小化在场)
let _engineTooltip = '工蚁';
let _runningCount = 0;
// D2 托盘运行任务菜单(在场快照→重建)
let _menuTasks: Array<{ taskId: string; title: string; elapsedSec: number; stale: boolean }> = [];
let _handlers: { onNavigate: (taskId: string) => void; onPause: (taskId: string) => void; onOpenIm?: () => void; onOpenOutbox?: () => void } = { onNavigate: () => {}, onPause: () => {} };
// zx_20260912 M2(海德格尔·在场): IM 未读条数——不在 IM 页时也让"有人来过"到场。
let _imUnread = 0;
// zx_20260912 M3(管子·度量衡): 出站最终未送达(dead)条数——账不只躺在 IM 页里, 不在 IM 页也要看得见。
let _outboxDead = 0;

function fmt(s: number): string {
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60 ? `${Math.round(s % 60)}s` : ''}` : `${s}s`;
}

function syncTooltip(): void {
  if (!tray) return;
  const parts: string[] = [];
  if (_runningCount > 0) parts.push(`执行中 ${_runningCount}`);
  if (_imUnread > 0) parts.push(`IM 未读 ${_imUnread}`);
  if (_outboxDead > 0) parts.push(`出站未送达 ${_outboxDead}`);
  tray.setToolTip(parts.length > 0 ? `${_engineTooltip} · ${parts.join(' · ')}` : _engineTooltip);
}

function rebuildMenu(): void {
  if (!tray) return;
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '显示主窗口',
      click: () => { if (_win) { _win.show(); _win.focus(); } },
    },
    { type: 'separator' },
  ];
  // zx_20260912 M2: 未读到场——点击走既有 notif:focus-task 跳转通道(main 注入 onOpenIm)，不新建托盘框架。
  if (_imUnread > 0) {
    template.push({ label: `IM 未读 ${_imUnread} 条 →`, click: () => _handlers.onOpenIm?.() });
    template.push({ type: 'separator' });
  }
  // zx_20260912 M3: 未送达到场——同一通道(main 注入 onOpenOutbox)，落页即自动展开补发账明细。
  if (_outboxDead > 0) {
    template.push({ label: `出站未送达 ${_outboxDead} 条 →`, click: () => _handlers.onOpenOutbox?.() });
    template.push({ type: 'separator' });
  }
  if (_menuTasks.length > 0) {
    template.push({ label: `执行中 ${_menuTasks.length}`, enabled: false });
    for (const t of _menuTasks) {
      template.push({
        label: `${t.stale ? '⚠ ' : ''}${t.title.slice(0, 22)} · ${fmt(t.elapsedSec)}`,
        submenu: [
          { label: '直达任务', click: () => _handlers.onNavigate(t.taskId) },
          { label: '暂停', click: () => _handlers.onPause(t.taskId) },
        ],
      });
    }
    template.push({ type: 'separator' });
  }
  template.push({
    label: '退出工蚁',
    click: () => { app.quit(); },
  });
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

export function createTray(mainWindow: BrowserWindow): Tray {
  // 使用简单的 16x16 图标作为托盘图标
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray-icon.png');
  let icon: NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error('icon empty');
  } catch {
    // 回退：创建一个简单的 16x16 占位图标
    icon = nativeImage.createEmpty();
  }

  if (process.platform === 'darwin') {
    icon = icon.resize({ width: 16, height: 16 });
    icon.setTemplateImage(true);
  }

  _win = mainWindow;
  tray = new Tray(icon);
  tray.setToolTip(_engineTooltip);
  rebuildMenu();

  // macOS: 点击托盘图标显示/隐藏窗口
  tray.on('click', () => {
    if (!_win) return;
    if (_win.isVisible()) {
      _win.hide();
    } else {
      _win.show();
      _win.focus();
    }
  });

  return tray;
}

/** 引擎状态 tooltip 基线(现有调用不变)；在场运行数(D1)由 updateTrayPresence 叠加 */
export function updateTrayStatus(status: string): void {
  const labels: Record<string, string> = {
    running: '工蚁 · 运行中',
    starting: '工蚁 · 启动中...',
    error: '工蚁 · 服务异常',
    stopped: '工蚁 · 已停止',
  };
  _engineTooltip = labels[status] ?? `工蚁 · ${status}`;
  syncTooltip();
}

/** D1(2026-09-08_1 空性·如实呈现实时): 在场运行数叠加进托盘 tooltip（count=0 还原引擎基线） */
export function updateTrayPresence(count: number): void {
  _runningCount = Math.max(0, Number(count) || 0);
  syncTooltip();
}

/** zx_20260912 M2(海德格尔·在场): IM 未读数叠加进 tooltip + 菜单项（与 updateTrayPresence 同构）。
 *  `onOpenIm` 只在首次/变更时注入；n 未变时不重建菜单（避免每轮扫描都重建托盘菜单）。 */
export function updateTrayImUnread(n: number, onOpenIm?: () => void): void {
  const next = Math.max(0, Number(n) || 0);
  const changed = next !== _imUnread || (!!onOpenIm && _handlers.onOpenIm !== onOpenIm);
  _imUnread = next;
  if (onOpenIm) _handlers.onOpenIm = onOpenIm;
  syncTooltip();
  if (changed) rebuildMenu();
}

/** zx_20260912 M3(管子·度量衡): 出站最终未送达(dead)条数叠加进 tooltip + 菜单项（与 updateTrayImUnread 同构）。
 *  数字与 20s 补发扫描**同源同尺**（同一 `outboxStats`）；n 未变时不重建菜单。 */
export function updateTrayOutboxDead(n: number, onOpenOutbox?: () => void): void {
  const next = Math.max(0, Number(n) || 0);
  const changed = next !== _outboxDead || (!!onOpenOutbox && _handlers.onOpenOutbox !== onOpenOutbox);
  _outboxDead = next;
  if (onOpenOutbox) _handlers.onOpenOutbox = onOpenOutbox;
  syncTooltip();
  if (changed) rebuildMenu();
}

/** D2(2026-09-08_1 事上磨练): 以在场快照重建托盘菜单——运行任务直达/暂停；空数组恢复基础菜单 */
export function setTrayRunningMenu(tasks: Array<{ taskId: string; title: string; elapsedSec: number; stale: boolean }>, handlers?: { onNavigate: (taskId: string) => void; onPause: (taskId: string) => void }): void {
  _menuTasks = tasks || [];
  if (handlers) _handlers = handlers;
  rebuildMenu();
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
  _win = null;
  _engineTooltip = '工蚁';
  _runningCount = 0;
  _imUnread = 0;
  _outboxDead = 0;
  _menuTasks = [];
}
