/**
 * zx_20260906_2 批4 受控复跑（源码静态接线防回归；绝不触碰开发库；经桌面 node_modules/.bin/tsx 运行）。
 * S1 4c search.global IPC：只读检索 项目/任务/产出物/里程碑，名称/标题 LIKE、排除 retired/archived、LIMIT 6。
 * S2 4c CommandPalette：200ms 防抖调 search.global；对象分组渲染；openObj 路由直达；failed 任务 inline 重试。
 * S3 4b NotificationBell：renderItem 顶层 div(可内嵌按钮)；retryFailed 用 task:resume + markTaskRead + fetchList；failed 行 ↻ 重试 + stopPropagation。
 * S4 4b ActionNeeded：retryTask(task:resume) + inline 重试按钮。
 * S5 4a Dashboard(承接4f·终核修正)：heartbeat.tokens 与 totalTokens 同源(对话 token_count)故不叠加(防双计/防造假)——Token 卡主值=已入账 totalTokens；
 *    执行中经 liveRunCount/liveMaxSec 派生出「执行中 N · 最长 … 心跳在线」副行随 heartbeat 每~20s 跳动(长单步不静止)。
 * （GUI 交互行为归桌面实机复核 §十 F2-F4。）
 */
import fs from 'node:fs';
import path from 'node:path';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const ROOT = path.join(__dirname, '..');
const ipc = fs.readFileSync(path.join(ROOT, 'apps/worker-ant-desktop/src/main/ipc/project.ipc.ts'), 'utf-8');
const cp = fs.readFileSync(path.join(ROOT, 'apps/worker-ant-desktop/renderer/src/components/CommandPalette.tsx'), 'utf-8');
const bell = fs.readFileSync(path.join(ROOT, 'apps/worker-ant-desktop/renderer/src/components/NotificationBell.tsx'), 'utf-8');
const actn = fs.readFileSync(path.join(ROOT, 'apps/worker-ant-desktop/renderer/src/components/ActionNeeded.tsx'), 'utf-8');
const dash = fs.readFileSync(path.join(ROOT, 'apps/worker-ant-desktop/renderer/src/pages/DashboardPage.tsx'), 'utf-8');

console.log('S1 4c search.global IPC(只读)');
// zx_20260930 就地订正（**切块按 handler 自身边界，非放宽**）：原切块 =「`search.global` 起、到
//   `deliverable:start` 止」——那是把一个**无关通道名**当右界。M4-2 在两者之间插了 `deliverable:facets`
//   （内含 3 处 `FROM wa_deliverables`）⇒ 本段的"四表各 1 处"当场变 4 处而红：**判的已不是
//   search.global 了**（判据面被新代码侵入，属"ILL 判据"，非生产缺陷）。改为按**该 handler 自己的
//   边界**切：`ipcMain.handle('<ch>'` 起，到**下一个** `ipcMain.handle(` 止 —— 此后任何通道插到
//   哪里都不再影响本段，且本段的语义（"这个处理函数体内的四表检索各一次"）不变、不更宽。
const handlerSeg = (src: string, ch: string): string => {
  const i = src.indexOf(`ipcMain.handle('${ch}'`);
  if (i < 0) return '';
  const j = src.indexOf('ipcMain.handle(', i + 1);
  return src.slice(i, j < 0 ? src.length : j);
};
const sg = ipc.indexOf("ipcMain.handle('search.global'");
ok(sg > -1, 'search.global handler 存在(project.ipc)');
const sgSeg = handlerSeg(ipc, 'search.global');
// 自证切块非空且确到下一 handler 为止：本段必须**不含**任何 `ipcMain.handle(`（只含自身那一处表头）
ok(sgSeg.length > 0 && (sgSeg.match(/ipcMain\.handle\(/g) || []).length === 1, '切块自证：本段只含自身表头（未越界吞下一个 handler）', String(sgSeg.length));
ok(sgSeg.includes('const kw = (q || \'\').trim()') && sgSeg.includes('if (!kw) return { data: empty }'), '空关键词 → 空结果(不空转)');
ok((sgSeg.match(/FROM wa_projects/g) || []).length === 1 && (sgSeg.match(/FROM wa_tasks/g) || []).length === 1 && (sgSeg.match(/FROM wa_deliverables/g) || []).length === 1 && (sgSeg.match(/FROM wa_plan_milestones/g) || []).length === 1, '四表检索(项目/任务/产出物/里程碑)');
ok(sgSeg.includes("status NOT IN ('archived')") && sgSeg.includes("status != 'retired'"), '排除 归档任务/退休产出物');
ok((sgSeg.match(/LIMIT 6/g) || []).length === 4, '各 ≤6(轻量,不整表)');
ok(sgSeg.includes("return { data: { projects, tasks, deliverables, milestones } }"), 'data 结构四类');

console.log('S2 4c CommandPalette');
ok(cp.includes("import { invoke } from '../lib/ipc'"), '引入 invoke');
ok(cp.includes("'search.global', { q: s }") && cp.includes('setTimeout') && cp.includes(', 200)'), '200ms 防抖调 search.global');
ok(cp.includes("openObj(row.kind, row.o)"), '对象行点击直达(openObj)');
ok(cp.includes('navigate(`/projects/${String(o.id)}`)') && cp.includes('navigate(`/tasks/${String(o.id)}`)'), '项目→项目详情 / 任务→任务详情 直达');
ok(cp.includes("navigate(`/tasks/${tid}`)"), '产出物 → 所属任务详情(无独立详情页落到任务最实)');
ok(cp.includes("row.kind === 'task' && String(row.o.status) === 'failed'"), 'failed 任务对象项提供重试入口条件');
ok(cp.includes("invoke('task:resume', { id: String(o.id) })"), '重试复用 task:resume(恢复语义)');

console.log('S3 4b NotificationBell inline 重试');
ok(bell.includes('const retryFailed = async (it: NotifItem)'), 'retryFailed 存在');
ok(bell.includes("invoke('task:resume', { id: it.task_id })"), 'retryFailed 调 task:resume');
ok(bell.includes('markTaskRead(it.task_id)') && bell.includes('void fetchList()'), '重试后 markTaskRead(处置即已读)+刷新列表');
const riIdx = bell.indexOf('const renderItem = (it: NotifItem) =>');
ok(riIdx > -1 && bell.slice(riIdx).includes('<div role="button" tabIndex={0}'), 'renderItem 顶层改为 div(可内嵌动作按钮,不再整行 button)');
ok(bell.includes("e.stopPropagation(); retryFailed(it)"), '重试按钮 stopPropagation(不触发前往)');
ok(bell.includes('↻ 继续') && bell.includes('如需清空重跑请到任务详情用「重试」'), 'failed 快捷动作标「↻ 继续」并 title 说明语义(task:resume 保留对话,非清空重跑)');

console.log('S4 4b ActionNeeded inline 重试');
ok(actn.includes('const retryTask = async (it: ActionItem)') && actn.includes("invoke('task:resume', { id: it.id })"), 'retryTask(task:resume) 存在');
ok(actn.includes('↻ 继续') && actn.includes('retryTask(it)'), 'failed 项 inline「↻ 继续」(task:resume 保留对话)');

console.log('S5 4a Dashboard(承接4f·终核修正：不双计不造假)');
ok(dash.includes('const liveRunCount = Object.keys(heartbeats).length') && dash.includes('const liveMaxSec = Object.values(heartbeats).reduce'), 'liveRunCount/liveMaxSec 派生自 heartbeats');
ok(dash.includes('value:formatToken(stats?.totalTokens)'), 'Token 卡主值=已入账 totalTokens(未叠加心跳 token)');
ok(!dash.includes('实时 +{formatToken('), '无「实时 +token」重复叠加(双计已修正)');
ok(dash.includes('心跳在线'), '执行中 Token 卡带「心跳在线」副行(随 heartbeat 跳动·长单步不静止)');
ok(dash.includes('不重复叠加心跳 token(同源于对话 token_count)'), '副行 title 如实说明口径');
ok(dash.includes('animate: liveRunCount > 0'), '执行中 Token 卡带脉冲');

console.log(`结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
