/**
 * zx_20260906 批4 受控复跑（node 内存事件总线 + 源接线断言，绝不触碰开发库/生产活跃项目）。
 * S1 (总线) 新事件类型 im.message_inbound / memory.changed 可被 eventBus 订阅并经 emitTransient 送达（瞬态，不落事件日志）。
 * S2 (4a) IM 入站实时：im-router 落库后 emitTransient im.message_inbound；index 转发；IMPage 订阅刷新正在查看渠道；TaskEvent 类型含 channelId。
 * S3 (4b) TaskDetail 消费 task.heartbeat：事件分支处理 + 活跃脉冲/长单步 banner；不整表刷新。
 * S4 (4c) 通知跨通道归一 + 免打扰：main popup 聚焦不弹原生/ui_dnd 总开关；renderer ToastProvider 尊重 ui_dnd；Settings 提供开关。
 * S5 (4d) 记忆沉淀实时：memory-manager 写点经节流 scheduleMemoryChanged → memory.changed；index 转发；MemoriesPage liveTypes 含 memory.changed；activity 广播但不入环缓冲。
 * 用法：./apps/worker-ant-desktop/node_modules/.bin/tsx scripts/rr_zx_20260906_b4.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { eventBus } from '../apps/worker-ant-desktop/src/main/core/event-bus.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const R = (rel: string) => path.resolve(__dirname, '../apps/worker-ant-desktop', rel);
const read = (rel: string) => fs.readFileSync(R(rel), 'utf-8');
const imRouter = read('src/main/services/im-router.ts');
const indexSrc = read('src/main/index.ts');
const eventBusSrc = read('src/main/core/event-bus.ts');
const memoryMgr = read('src/main/core/memory-manager.ts');
const notifSvc = read('src/main/core/notification-service.ts');
const tdPage = read('renderer/src/pages/TaskDetailPage.tsx');
const imPage = read('renderer/src/pages/IMPage.tsx');
const memPage = read('renderer/src/pages/MemoriesPage.tsx');
const toastLib = read('renderer/src/lib/toast.tsx');
const actLib = read('renderer/src/lib/activity.tsx');
const settingsPage = read('renderer/src/pages/SettingsPage.tsx');
const electronTypes = read('renderer/src/types/electron.d.ts');

console.log('S1 事件总线新增类型');
let gotIm: Record<string, unknown> | null = null;
let gotMem: Record<string, unknown> | null = null;
const onIm = (e: { data: Record<string, unknown> }) => { gotIm = e.data; };
const onMem = (e: { data: Record<string, unknown> }) => { gotMem = e.data; };
eventBus.on('im.message_inbound', onIm as never);
eventBus.on('memory.changed', onMem as never);
(async () => {
  await eventBus.emitTransient('im.message_inbound', { channelId: 'ch1', channel_id: 'ch1', preview: '你好', createdAt: new Date().toISOString() } as never);
  await eventBus.emitTransient('memory.changed', { projectId: 'p1', project_id: 'p1', memory_types: ['procedural'] } as never);
  ok(gotIm !== null && gotIm!.channelId === 'ch1', 'emitTransient im.message_inbound 可达订阅者', `channelId=${gotIm?.channelId}`);
  ok(gotMem !== null && gotMem!.memory_types === 'procedural' || (Array.isArray((gotMem as { memory_types?: unknown } | null)?.memory_types) && (gotMem as { memory_types: string[] }).memory_types.includes('procedural')), 'emitTransient memory.changed 可达订阅者');
})();

console.log('S2 (4a) IM 入站实时接线');
// zx_20260911_2 M3: union 新增 im.message_outbound，原断言按"相邻字面"匹配过于脆弱——改为在 EventType 行内分别校验两成员在册。
const eventTypeLine = eventBusSrc.split('\n').find(l => l.startsWith('export type EventType')) || '';
ok(eventTypeLine.includes("'im.message_inbound'") && eventTypeLine.includes("'memory.changed'"), 'EventType union 含 im.message_inbound/memory.changed');
ok(imRouter.includes("emitTransient('im.message_inbound'") && imRouter.includes("from_user_id: fromUser") && imRouter.includes("preview: text.slice(0, 60)"),
  'im-router 入站落库后发射 im.message_inbound（含 channelId/preview）');
ok(indexSrc.includes("eventBus.on('im.message_inbound'") && indexSrc.includes("eventBus.on('memory.changed'"),
  'index.ts 转发 im.message_inbound / memory.changed 到 renderer');
// 订正（zx_20260912 M2-4 落地时）：实时入站由 `showConvs(cid)`（重置回最新 50 条）改为
// `prependNewConvs(cid)`（只前插新行，保留已翻出的旧页）——"正在查看该渠道即时刷新"这一**能力**不变。
ok(imPage.includes("event.type === 'im.message_inbound'") && imPage.includes('convChannelRef.current')
  && (imPage.includes('void prependNewConvs(cid)') || imPage.includes('void showConvs(cid)')),
  'IMPage 订阅 im.message_inbound → 正在查看该渠道即时刷新');
ok(electronTypes.includes('channelId?: string') && electronTypes.includes('channel_id?: string'), 'TaskEvent 类型含 channelId/channel_id');

console.log('S3 (4b) TaskDetail 心跳消费');
ok(tdPage.includes("event.type === 'task.heartbeat'") && tdPage.includes('setHeartbeat(') && tdPage.includes('setHeartbeat(null)'),
  'TaskDetail 事件分支消费 task.heartbeat（活跃脉冲，无整表刷新 return 早退）');
ok(tdPage.includes('hbFresh') && tdPage.includes('长步骤') && tdPage.includes('heartbeatElapsedSec'),
  '长单步"伪冻结"补丁：hbFresh 计算 + 长步骤推进 banner（含心跳时长）');

console.log('S4 (4c) 通知归一 + 免打扰接线');
ok(notifSvc.includes("if (focused) return;") && notifSvc.includes("ui_dnd") && notifSvc.includes('聚焦时主呈现=应用内 toast'),
  'main popup 聚焦不弹原生（主呈现=toast）+ ui_dnd 总开关（六路降为一路中心记录）');
ok(toastLib.includes("if (s.ui_dnd === '1') return;"), 'renderer ToastProvider 尊重 ui_dnd（toast/声音一并收敛）');
ok(settingsPage.includes("'ui_dnd'") && settingsPage.includes('免打扰总开关'), 'Settings 提供免打扰总开关');

console.log('S5 (4d) 记忆沉淀实时接线');
ok(memoryMgr.includes('scheduleMemoryChanged(') && memoryMgr.includes("emitTransient('memory.changed'") && memoryMgr.includes('3000'),
  'memory-manager 写点经节流 scheduleMemoryChanged(≤3s 聚合) 发射 memory.changed');
ok((memoryMgr.match(/scheduleMemoryChanged\(/g) || []).length >= 7,
  // zx_20261004 M14：前瞻簇（storeProspective）已随迁出本文件、其"记忆已变"经宿主面 scheduleChanged 注入，
  //   故本文件内的直连写点示例相应更新（判据为 ≥7 下界，未放宽）。
  '多写点已接线（store/storeText/storeUserPreference/storeUnknown/storeNegative + 宿主面 scheduleChanged 等 ≥7 处）');
ok(memPage.includes("'memory.changed'") && memPage.includes("liveTypes: ['task.memory_injected', 'memory.changed']"),
  'MemoriesPage useLiveQuery liveTypes 含 memory.changed（后台沉淀实时刷新）');
ok(actLib.includes('BROADCAST_ONLY_TYPES') && actLib.includes("'im.message_inbound', 'memory.changed'"),
  'activity 仅广播不入环缓冲（避免 IM 入站/记忆沉淀刷 Activity 页）');

setTimeout(() => {
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}, 50);
