/**
 * zx_20260909 批1 受控复跑（node:sqlite 内存库语义 + 源码静态防回归；绝不触碰开发库；tsx 运行，用法同 rr_zx_20260908_1_b1.ts）。
 *
 * Y1 完成/失败回 IM「主要成果摘要化」: im-reply 纯逻辑——selectSummaryDoc 挑应报 doc(★primary已完成→最新已完成→最新在制)、
 *      describeAcceptance 如实徽标(✓已验收 p/t / 验收 p/t / 无)、displayDocName basename、normalizeSnippet 单行限长、buildSummaryBlock 摘要块;
 *      ai-task buildCompletionNotice 在 im.completion_summary!=false 时先走摘要块(不再丢产出文件前 800 字), false 回旧原文。
 * Y2a 断点 busy ack: im-router 落入 LLM 意图耗时处理前先回一次性 ack(im.busy_ack=0 关)。Y2b 超长运行一次在场回话: index presence 扫描,
 *      running≥阈值分钟且本 run 未回过 → pushImCompletion 进度行(每 run 至多一次, im.long_running_progress_min=0 关)。
 * Y3 收口: notify_quiet_mute_critical main 原生弹窗一致(toast 已消费, 原生缺位); createReconnect 死代码删除; im_wechat_heartbeat=自维护诊断台账保留。
 * 复用同一 im-reply.ts 纯模块(防测试与实作漂移)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { selectSummaryDoc, displayDocName, describeAcceptance, normalizeSnippet, buildSummaryBlock } from '../apps/worker-ant-desktop/src/main/core/im-reply.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
const ai = rd('apps/worker-ant-desktop/src/main/core/jobs/ai-task.ts');
const idx = rd('apps/worker-ant-desktop/src/main/index.ts');
const router = rd('apps/worker-ant-desktop/src/main/services/im-router.ts');
const nsvc = rd('apps/worker-ant-desktop/src/main/core/notification-service.ts');
const adapter = rd('apps/worker-ant-desktop/src/main/services/im-adapter.ts');
const db = rd('apps/worker-ant-desktop/src/main/database.ts');

console.log('Y1 selectSummaryDoc 确定性选择');
ok(selectSummaryDoc([
  { id: 'draft_new', name: 'd.md', type: 'doc', status: 'draft', created_at: '2026-09-09T09:00:00Z' },
  { id: 'done_old', name: 'a.md', type: 'doc', status: 'completed', is_primary: 1, created_at: '2026-09-01T00:00:00Z' },
])?.id === 'done_old', '★primary 已完成 doc 优先(即使非最新)', 'done_old 带 is_primary=1');
ok(selectSummaryDoc([
  { id: 'done_new', name: 'b.md', type: 'doc', status: 'completed', is_primary: 0, created_at: '2026-09-09T09:00:00Z' },
  { id: 'done_old2', name: 'a.md', type: 'doc', status: 'completed', created_at: '2026-09-01T00:00:00Z' },
])?.id === 'done_new', '无 primary → 最新已完成');
ok(selectSummaryDoc([
  { id: 'd1', name: 'x.md', type: 'doc', status: 'draft', created_at: '2026-09-01T00:00:00Z' },
  { id: 'd2', name: 'y.md', type: 'doc', status: 'draft', created_at: '2026-09-09T00:00:00Z' },
  { id: 'ui1', name: 'ui', type: 'ui', status: 'completed', created_at: '2026-09-10T00:00:00Z' },
])?.id === 'd2', '仅 doc 参与, 无已完成 → 最新在制(ui 不参与)');
ok(selectSummaryDoc([{ id: 'ret', name: 'r.md', type: 'doc', status: 'retired', created_at: '2026-09-01T00:00:00Z' }]) === null, '全 retired/无 doc → null(走旧兜底)');
ok(selectSummaryDoc([]) === null, '空数组 → null');

console.log('Y1 describeAcceptance / displayDocName / normalizeSnippet');
ok(describeAcceptance({ criteria_total: 3, passed_total: 3, checked_at: '2026-09-09' }) === '✓已验收 3/3', '验收全过 → ✓已验收 p/t');
ok(describeAcceptance({ criteria_total: 3, passed_total: 2, checked_at: '2026-09-09' }) === '验收 2/3', '验收未全过 → 验收 p/t');
ok(describeAcceptance({ criteria_total: 0, passed_total: 0, checked_at: '2026-09-09' }) === null, 'criteria=0 → null(不虚报)');
ok(describeAcceptance(undefined) === null, '无验收记录 → null(如实)');
ok(displayDocName({ name: '/a/b/报告.md' }) === '报告.md', 'name 含路径 → basename');
ok(displayDocName({ name: '报告.md' }, null) === '报告.md', '无路径 → 原名');
ok(normalizeSnippet('第一行标题\n\n第二行  细节内容 换行', 30).length <= 31, 'normalize 单行化+限长(≤max+…1)');
ok(normalizeSnippet('短文本', 100) === '短文本', '短文本不截断');

console.log('Y1 buildSummaryBlock 组装');
const b1 = buildSummaryBlock({ name: '方案.md', version: 3, accDesc: '✓已验收 3/3', inDraft: false, snippet: '正文 一句话摘要' });
ok(b1.startsWith('📄 主要成果：方案.md v3（✓已验收 3/3）'), '完成+验收 → 名+v+✓验收徽标', b1.split('\n')[0]);
ok(b1.includes('\n') && b1.split('\n')[1]!.startsWith('正文'), '第二行=一句摘要');
const b2 = buildSummaryBlock({ name: 'x.md', version: 1, accDesc: null, inDraft: true, snippet: '' });
ok(b2 === '📄 主要成果：x.md v1（在制）', '在制无验收 → （在制）徽标');
const b3 = buildSummaryBlock({ name: '', accDesc: '✓已验收 1/1' });
ok(b3 === '', '空名不产出');

console.log('Y1 ai-task 接线(源码静态)');
ok(ai.includes("from '../im-reply.js'"), 'ai-task import im-reply');
// zx_20260910_3 M3(G3): 判据归一为 boolSetting（默认 true 语义不变）——断言随之更新为规范形
ok(ai.includes("key = 'im.completion_summary'") && ai.includes('boolSetting(sumCfg?.value)'), 'ai-task 读 im.completion_summary 门控(默认 true)');
ok(ai.includes('selectSummaryDoc(') && ai.includes('describeAcceptance(') && ai.includes('buildSummaryBlock('), 'ai-task 实际调用 im-reply 纯逻辑');
ok(ai.includes("SELECT MAX(version) AS v FROM wa_deliverable_versions"), 'ai-task 取最新版本号 vN');
const rawHeadCount = (ai.match(/readFileSync\(deliv\.file_path, 'utf-8'\)\.slice\(0, 800\)/g) || []).length;
ok(rawHeadCount <= 1, '旧"丢前800字"路径仅保留为 fallback(≤1 处)', `旧读文件头 800 处=${rawHeadCount}`);

console.log('Y2a busy ack(im-router)');
ok(router.includes("key = 'im.busy_ack'") && router.includes('⏳ 收到，正在理解你的消息'), 'im-router LLM 意图前 busy ack + 读 im.busy_ack');
ok(router.indexOf("key = 'im.busy_ack'") < router.indexOf('classifyIntentWithLLM'), 'busy ack 判定先于 classifyIntentWithLLM(防静默走廊)');

console.log('Y2b 超长运行一次在场回话(index)');
ok(idx.includes("key = 'im.long_running_progress_min'") && idx.includes('longRunNotified'), 'index 读阈值键 + 有去重账(longRunNotified)');
ok(idx.includes('pushImCompletion(') && idx.includes('⏳ 任务「'), 'index 进度行经 pushImCompletion 推送');
ok(idx.includes('elapsedSec >= lpMin * 60') && idx.includes('!longRunNotified.has(key)'), '≥阈值分钟 且 本 run 未回过 → 才发(每 run 至多一次)');
ok(idx.includes('if (longRunNotified.size > 400)'), '去重账有界防胀');

console.log('Y1/Y2 共用推送实现复用(index pushImCompletion)');
ok(idx.includes('const pushImCompletion = async') && idx.includes('sendImNotification: (taskId: string, projectId: string, message: string) => pushImCompletion('), '完成/失败与进度回话共用 pushImCompletion(同一会话路由, 不复制逻辑)');

console.log('Y3 收口');
ok(nsvc.includes("notify_quiet_mute_critical") && nsvc.includes("sval(db, 'notify_quiet_mute_critical') === '1'"), 'notification-service main 消费 notify_quiet_mute_critical(原生与 toast 一致静音 critical)');
ok(!/export function createReconnect/.test(adapter), 'im-adapter createReconnect 死代码已删除');
const wechat = rd('apps/worker-ant-desktop/src/main/services/wechat-adapter.ts');
ok(wechat.includes('im_wechat_heartbeat') && wechat.includes('recordHeartbeat'), 'im_wechat_heartbeat 为 wechat 自维护诊断台账(轮询写, 保留非死键)');
ok(db.includes("ensureSetting('im.completion_summary', 'true')") && db.includes("ensureSetting('im.busy_ack', 'true')") && db.includes("ensureSetting('im.long_running_progress_min', '15')"), 'database ensureSetting 注册 3 个 im.* 默认键');

console.log('\n结果: pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
