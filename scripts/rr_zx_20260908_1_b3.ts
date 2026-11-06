/**
 * zx_20260908_1 批3 受控复跑（源码静态防回归；GUI 目视归 M4；绝不触碰开发库；tsx 运行）。
 * D1 最小化/离页在场可见: presence 扫描有在场任务 → 窗口标题「工蚁 · 执行中 N」+ 托盘 tooltip 叠加运行数(updateTrayPresence), 空转还原; ui.presence_minimize 开关。
 * D2 托盘运行任务菜单: presence.update 重建托盘菜单——每运行任务 直达/暂停(⚠无推进红标), 空数组恢复基础菜单; ui.tray_presence_menu 开关; 暂停走 interruptTask 同 GUI 路径。
 */
import fs from 'node:fs';
import path from 'node:path';
let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');

console.log('config 默认键');
const dts = rd('apps/worker-ant-desktop/src/main/database.ts');
ok(dts.includes("ui.presence_minimize") && dts.includes("ui.tray_presence_menu"), 'database 默认键 ui.presence_minimize/ui.tray_presence_menu=true');

console.log('D1/D2 源码接线');
const tray = rd('apps/worker-ant-desktop/src/main/tray.ts');
ok(tray.includes('export function updateTrayPresence') && tray.includes('执行中 ') && tray.includes('_runningCount'), 'tray.ts updateTrayPresence 在场 tooltip 叠加在案(空=还原引擎基线)');
ok(tray.includes('export function setTrayRunningMenu') && tray.includes('直达任务') && tray.includes("label: '暂停'") && tray.includes('⚠ '), 'tray.ts setTrayRunningMenu 运行任务菜单(直达/暂停/⚠红标)在案');
ok(tray.includes('_engineTooltip') && tray.includes('_menuTasks') && tray.includes('_handlers'), 'tray.ts 状态保持(引擎基线+在场任务+回调)在案');
const idx = rd('apps/worker-ant-desktop/src/main/index.ts');
ok(idx.includes("key = 'ui.presence_minimize'") && idx.includes("key = 'ui.tray_presence_menu'"), 'index.ts 在场扫描读 D1/D2 开关');
ok(idx.includes('mainWindow.setTitle(`工蚁 · 执行中') && idx.includes('updateTrayPresence('), 'index.ts D1 窗口标题+托盘在场数驱动在案(空还原 工蚁)');
ok(idx.includes('setTrayRunningMenu(') && idx.includes("notif:focus-task") && idx.includes("onPause:"), 'index.ts D2 托盘菜单(直达 send notif:focus-task/暂停)在案');
// zx_20260917 M1: 广播不再由调用方补发（`pauseTask` 一次写全状态/因/事件），故断言改钉
// 「托盘暂停仍走 interruptTask 这条同 GUI 的路径」——广播由 `interruptTask` 内的唯一写入口保证。
ok(idx.includes('interruptTask') && !idx.includes("newStatus: 'paused'"),
  'index.ts 托盘暂停走 interruptTask(同 GUI 暂停路径)，广播不再由调用方补发');

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
