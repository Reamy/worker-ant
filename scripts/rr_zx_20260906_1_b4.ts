/**
 * zx_20260906_1 批4 受控复跑（源码静态防回归；GUI/事件/通知实时行为归桌面实机复核；用法同 rr_zx_20260906_1_b1.ts）。
 * S1 4a awaiting_input 实时：TasksPage 事件分支消费 awaiting_input；main 两处暂停路径(门禁/ask_user)补发 status_changed(paused)。
 * S2 4b 处置即已读：notification-service 按任务 markTaskRead；status_changed→执行类状态自动清读。
 * S3 4c 焦点去扰：recordNotification 命中当前观看任务即置已读(不制造新未读/徽标)。
 *
 * zx_20260915 M4/P0-6 同步：S2/S3 的实现整体**搬入** `notification-core.ts`（零 electron，使受控回归
 * 能直跑真实现），`notification-service.ts` 退化为装配壳并 re-export。故本文件 S2/S3 的扫描面
 * **随实现搬家**——若继续扫旧文件，下面几条会因"扫不到"而红；若两条计数都归 0 则更糟（判据恒真）。
 * 行为语义一字未改，仅换了落点。
 * S4 4d 子面板/项目卡刷新：ProjectDetail 子面板按 activeTab 随事件重载(memory.changed 亦触发)；ProjectsPage liveTypes 补 deliverable.status_changed。
 * S5 4e 铃去重覆盖：NotificationBell 覆盖 status_changed(new_status=completed) 兜底。
 */
import fs from 'node:fs';
import path from 'node:path';
import { engineExecSideFiles } from './lib/rr-engine-src.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const app = (...s: string[]) => fs.readFileSync(path.join(ROOT, 'apps/worker-ant-desktop', ...s), 'utf-8');
const exe = app('src/main/core/agent-executor.ts');
/**
 * zx_20260929 M9：「每个暂停点都经唯一写入口 `pauseTask` 且带因」这条判据的**本意是执行体这一侧**，
 * 而 `executeTask` 的收尾段（含 D1 闸那一处暂停）已整段外移到 `core/exec-close.ts`
 * ⇒ 若仍只扫 `agent-executor.ts`，暂停点计数会**少一截**（实测 10 处 < 在册 11 处下限）。
 * 落点取自 `lib/rr-engine-src.ts` 的**一处真源**（并集**减**工具段：工具侧的暂停是另一条路、另有判据），
 * 免得下次搬迁再漏一处。扩面**只许更严**——下限 11 与"未带因 0"两条一字未动。
 */
const execSurface = engineExecSideFiles()
  .map((p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')).join('\n');
const notif = app('src/main/core/notification-service.ts');
// zx_20260915 M4/P0-6：S2/S3 的实现落点（详见文件头同步说明）
const notifCore = app('src/main/core/notification-core.ts');
const tp = app('renderer/src/pages/TasksPage.tsx');
const pdPage = app('renderer/src/pages/ProjectDetailPage.tsx');
const pp = app('renderer/src/pages/ProjectsPage.tsx');
const bell = app('renderer/src/components/NotificationBell.tsx');

console.log('S1 4a awaiting_input 实时');
ok(tp.includes("event.type === 'task.awaiting_input'"), 'TasksPage 事件分支消费 awaiting_input(300ms 防抖 reload)');
ok(tp.includes('待审批/待回复实时'), 'TasksPage 注释锚(消除伪滞留)');
// zx_20260910_1 M3: 原断言按字面 '补发 status_changed' 计数===2（ask_user/门禁），M3 补 8 处系统侧暂停点后字面不再成立(脆)；
// 改为「置 paused 点与补发点逐一对齐」——扫每个 paused UPDATE，其后限宽窗内须有 status_changed(paused) 补发。
// zx_20260917 M1: 该「按邻近窗配对」的判据整体退役——「置暂停」已收成**唯一写入口** `pauseTask`
// （状态 / 因 / 事件**一次写全**），补发点由"逐站点各补一处"变为"结构上只有一处"，
// 于是本条的语义（每个暂停点都广播 paused）由**结构**保证，不再靠窗宽近似。判据随之改为：
//   ① 执行器每个暂停分支都经 `pauseTask`（计数 ≥11，与 M3 起在册的 11 个分支同尺）；
//   ② 每个调用点都带 `reason:`（因由必填——"无因暂停"在类型层不可表达）；
//   ③ 广播**确实由** `pauseTask` 发出（跨文件：唯一写入口里 newStatus:'paused' 在册）。
const pauseSites: number[] = [];
for (let i = execSurface.indexOf('pauseTask(db, {'); i >= 0; i = execSurface.indexOf('pauseTask(db, {', i + 1)) pauseSites.push(i);
const unpaired = pauseSites.filter((i) => !execSurface.slice(i, i + 600).includes('reason:'));
ok(pauseSites.length >= 11 && unpaired.length === 0,
  `执行体一侧每个暂停点均经 pauseTask 且带因（${pauseSites.length} 处暂停点，未带因 ${unpaired.length}）`
  + '——扫描面=执行体∪`exec-*.ts`（不含工具段）',
  unpaired.length > 0 ? `未带因行: ${unpaired.map(i => execSurface.slice(0, i).split('\n').length).join(',')}` : undefined);
const pauseWriter = app('src/main/core/pause-task.ts');
ok(pauseWriter.includes("eventBus") && pauseWriter.includes("'task.status_changed'") && pauseWriter.includes("newStatus: 'paused'"),
  '唯一写入口 pauseTask 内发出 status_changed(paused)（广播与落库同一次写全，无"漏补一处"之可能）');

console.log('S2 4b 处置即已读');
ok(notifCore.includes('export function markTaskRead'), '通知核提供 markTaskRead（M4 起落点在 notification-core）');
// M4 起「执行类状态集」抽成具名常量 `EXECUTING_STATUSES`（与 markTaskRead 触发条件共用一份）。
// 先正面断言该常量**确有**那四个状态（防"常量被清空而 includes 仍可编译"），再断言触发点消费它。
ok(/EXECUTING_STATUSES[^=]*=\s*\[[^\]]*'executing'[^\]]*'running'[^\]]*'pending'[^\]]*'preparing'[^\]]*\]/.test(notifCore),
  '执行类状态集 EXECUTING_STATUSES 含四态（executing/running/pending/preparing，M4 抽常量）');
ok(notifCore.includes('EXECUTING_STATUSES.includes(ns)'), 'status_changed→执行类状态自动 markTaskRead(处置即已读)');
ok(notifCore.includes('同任务旧通知(awaiting_input/failed)随之已读'), '注释锚(铃/dock 不残留)');
ok(notif.includes('EXECUTING_STATUSES'), '装配壳 re-export 该常量（旧 import 点零改动，见 M4 头注释）');

console.log('S3 4c 焦点去扰');
ok(notifCore.includes('currentTaskId === f.taskId'), 'recordNotification 命中当前观看任务判断');
ok(notifCore.includes("read_at, created_at) VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))"), '观看任务通知落库即置已读(不制造新未读/徽标)');

console.log('S4 4d 子面板/项目卡刷新');
ok(pdPage.includes('activeTabRef') && pdPage.includes('loadMemories()') && pdPage.includes('loadMilestones()'), 'ProjectDetail 子面板按 activeTab 随事件重载');
ok(pdPage.includes("e.type === 'memory.changed'"), 'memory.changed 触发 memories 重载');
ok(pp.includes("'deliverable.status_changed'") && pp.includes("'task.awaiting_input'"), 'ProjectsPage liveTypes 补 deliverable.status_changed/awaiting_input');

console.log('S5 4e 铃去重覆盖');
// zx_20260915 M4/P0-6：变量由 `completedViaStatus` 改名 `notableViaStatus` 并把状态集抽成
// `NOTABLE_VIA_STATUS`（与 main 侧 notification-core 的 status_changed 落行分支同集：completed/paused/failed，
// 后者为 P0-6 新增的两态）。原断言钉字面量"completed"否定了这一合理收口，故改钉**行为**：
// 兜底存在 + 状态集含 completed + 消费 `new_status ?? newStatus` 两种载荷形态。
ok(bell.includes('notableViaStatus') && /NOTABLE_VIA_STATUS[^=]*=\s*new Set\(\[[^\]]*'completed'/.test(bell)
  && bell.includes('new_status ?? (e as { new_status?: string; newStatus?: string }).newStatus'),
  'NotificationBell 覆盖 status_changed 兜底（含 completed；M4 起状态集抽为 NOTABLE_VIA_STATUS）');

console.log(`结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
