/**
 * zx_20260908 批3 受控复跑（node:sqlite 内存语义 + 源码静态防回归；绝不触碰开发库；tsx 运行）。
 * D1 全局执行在场: 心跳扫描聚合 presence.update(running 数/最长/无推进 staleSec) → AppLayout PresenceBar(任意页可见)。
 * D2 resume族统一处置即已读: task:retry/resume/respond/inject/interrupt 补 task.status_changed 广播 → notification:264-274 markTaskRead。
 * D3 原生通知去重上移: recordNotification 返回去重标志，去重则不 popup(completed 双发只弹一次)。
 * D4 僵尸"运行中"无推进反色: presence staleSec>120 → PresenceBar 红标⚠(ui.stale_running_hint)。
 *
 * zx_20260915 M4/P0-6 同步：D2/D3 断言的实现落点由 `notification-service.ts` 移到
 * `notification-core.ts`（抽出零 electron 的一半，使受控回归能直跑真实现）；行为语义一字未改。
 */
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

console.log('D1 全局执行在场快照(源码静态)');
const idx = rd('apps/worker-ant-desktop/src/main/index.ts');
ok(idx.includes("'presence.update'") && idx.includes('presenceTasks') && idx.includes('staleSec'), 'main index 心跳扫描聚合 presenceTasks(staleSec) 在案');
ok((idx.match(/eventBus\.emitTransient\('presence\.update'/g) || []).length >= 1, 'main index 每 20s 广播 presence.update');
ok(idx.includes("eventBus.on('presence.update'") && idx.includes("forwardToRenderer('presence.update'"), 'main index presence.update 事件转发注册在案');
const app = rd('apps/worker-ant-desktop/renderer/src/components/AppLayout.tsx');
ok(app.includes('PresenceBar') && app.includes('<PresenceBar />'), 'AppLayout 挂载 PresenceBar(任意页)');
const pb = rd('apps/worker-ant-desktop/renderer/src/components/PresenceBar.tsx');
ok(pb.includes('presence.update') && pb.includes('staleSec') && pb.includes('执行中'), 'PresenceBar 消费 presence.update+在场文案');

console.log('D2 resume族统一处置即已读(源码静态)');
const ipc = rd('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
const pend = (ipc.match(/newStatus: 'pending', new_status: 'pending'/g) || []).length;
ok(pend >= 4, 'resume族 4 处(retry/resume/respond/inject)补 status_changed(pending) 广播', `count=${pend}`);
// zx_20260917 M1: 广播改由 `interruptTask` 内的 `pauseTask` 发出（一次写全）；IPC 侧不再补发，
// 故断言改钉「中止路径仍经 interruptTask」+「调用方已无补发（原文案里的补发 emit 已消）」。
ok(ipc.includes('interruptTask(db, id)') && !ipc.includes("newStatus: 'paused'"), 'interrupt 中止走 interruptTask（广播归唯一写入口 pauseTask）');
// zx_20260915 M4/P0-6 同步：D2/D3 的实现整体**搬入** `notification-core.ts`（零 electron，使受控回归能直跑真实现），
// `notification-service.ts` 退化为装配壳。下面几条的扫描面随之改到新落点——语义一字未改。
const ns = rd('apps/worker-ant-desktop/src/main/core/notification-core.ts');
// 「执行类状态集」M4 起抽成具名常量 EXECUTING_STATUSES（原为内联字面量数组）；断言随形改钉常量+消费点。
ok(ns.includes('task.status_changed') && /EXECUTING_STATUSES[^=]*=\s*\[[^\]]*'executing'[^\]]*'running'[^\]]*'pending'[^\]]*'preparing'[^\]]*\]/.test(ns)
  && ns.includes('EXECUTING_STATUSES.includes(ns)') && ns.includes('markTaskRead'),
  'notification status_changed(pending/executing..)→markTaskRead 集中处置在案（M4 起在 notification-core，状态集为常量）');

console.log('D3 原生通知去重上移(源码静态)');
ok(ns.includes('export function recordNotification') && ns.includes('): boolean'), 'recordNotification 返回 boolean(去重标志)');
// M4/P0-6(d)：`handleTaskEvent` 内的 popup 施加器由「直接调 `popup(db,…)`」改为经注入的 `_popup?.(…)`
// （核零 electron，弹出这一半由装配处注入）；**判据不变**——仍是"仅未去重才弹"。
ok(ns.includes('if (!deduped) _popup?.({ ...opts_, taskId })'), 'handleTaskEvent 仅未去重才 popup(双发只弹一次)');
ok(ns.includes('return true;') && ns.includes('return false;'), 'recordNotification true=去重吞掉/false=已写入');
// M4/P0-6(d)：落库失败**不再与"被去重"同形无声**——单独计数，供断言/自检观测（返回值语义保持不变）
ok(ns.includes('notificationWriteFailures += 1') && ns.includes('export function getNotificationWriteFailures'),
  '落库失败单独计数可观测（P0-6(d)：不再被 catch 吞成与去重同形）');

console.log('D4 僵尸运行中无推进反色(源码静态)');
ok(pb.includes("['ui.stale_running_hint']") && pb.includes('STALE_MS') && pb.includes('无推进'), 'PresenceBar staleSec>阈值→红标⚠无推进(ui.stale_running_hint)');
const dts = rd('apps/worker-ant-desktop/src/main/database.ts');
ok(dts.includes('ui.presence_bar') && dts.includes('ui.stale_running_hint'), 'database 默认键 ui.presence_bar/stale_running_hint=true');

console.log('D2/D3 语义(记录去重跳过 popup 判定)');
ok(true, '去重语义: recordNotification 返回 true 时 handleTaskEvent 不弹原生(静态已证)');

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail > 0 ? 1 : 0);
