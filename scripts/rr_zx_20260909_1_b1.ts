/**
 * zx_20260909_1 M1 受控复跑：域A 目标修正(A2 resolveImNotifyTargets 创建人优先) + 介入暂停通知(A1 markPauseNeeded 接线)。
 *
 * A2 = **真调生产函数** core/im/im-notify.ts resolveImNotifyTargets(补①§十三: 不再内存库复刻谓词,
 *  直接 import 生产模块对 node:sqlite 内存库执行, 断言生产行为本身); 覆盖 创建人=ctx.channel/externalUser,
 *  缺回落 origin 渠道最近 inbound, 不向无关渠道路人广播; 无 origin(GUI 任务)回落最近 1:1 私聊且排除群聊/房间[补②§十三];
 *  notify_to_creator=false 回旧全渠道。
 * A1 = 源码静态断言各 agent 判定介入分支已接 markPauseNeeded(理由正确)、用户主动暂停(interruptTask)不触发、每任务每次至多一条
 *  (A1 接线点分散于 agent-executor/ai-task 巨型文件, 无法 import 触发, 保留静态断言)。
 * 绝不触碰开发库。无 Electron 环境, 发送路径(pushImNotify→动态 import im.ipc)不触发。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveImNotifyTargets } from '../apps/worker-ant-desktop/src/main/core/im/im-notify.js';
import { engineSrc, stripStepScopePrefix } from './lib/rr-engine-src.js';
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (p?: string) => any };

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
// zx_20260929 M9: 读作**搬迁前的写法**——步回调搬到 `core/exec-step.ts` 后段内绑定统一前置了 `d.`，
//   本脚本大批针脚是按源码字面量写的（`pauseTask(db, {` 等），不还原就会报"11 处(期望13)"这类假红。
//   口径见 `lib/rr-engine-src.ts` 的 `stripStepScopePrefix`（还原 ≠ 放宽：扫描面仍是并集）。
const exe = stripStepScopePrefix(engineSrc());
const ait = rd('apps/worker-ant-desktop/src/main/core/jobs/ai-task.ts');
const idxt = rd('apps/worker-ant-desktop/src/main/index.ts');
const dbt = rd('apps/worker-ant-desktop/src/main/database.ts');
const iip = rd('apps/worker-ant-desktop/src/main/ipc/im.ipc.ts');
const mnf = rd('apps/worker-ant-desktop/src/main/core/im/im-notify.ts');

function mkdb(): any {
  const db = new DatabaseSync(':memory:') as any;
  db.exec(`CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT, status TEXT);
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, context_json TEXT, title TEXT);
CREATE TABLE wa_im_conversations (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, direction TEXT, created_at TEXT, message_json TEXT DEFAULT '{}');
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);`);
  return db;
}

// 补①(§十三): 真调生产 resolveImNotifyTargets(core/im/im-notify.ts) —— 不再复刻谓词。
// node:sqlite DatabaseSync 与 better-sqlite3 在同一 prepare/get/all/run 子集上兼容, 故直接转型传入。
const resolveTargets = (db: any, taskId: string, creatorOnly: boolean) =>
  resolveImNotifyTargets(db, taskId, creatorOnly);

console.log('A2·通知目标=创建人(补①: 真调生产 resolveImNotifyTargets 对内存库执行)');
{
  const db = mkdb();
  db.prepare("INSERT INTO wa_im_channels (id,channel_type,status) VALUES ('w','wechat','active'),('d','dingtalk','active')").run();
  db.prepare("INSERT INTO wa_im_conversations (id,channel_id,external_user_id,direction,created_at) VALUES ('c1','d','strangerD','inbound',datetime('now'))").run();
  db.prepare("INSERT INTO wa_im_conversations (id,channel_id,external_user_id,direction,created_at) VALUES ('c2','w','strangerW','inbound',datetime('now'))").run();
  db.prepare("INSERT INTO wa_tasks (id,context_json,title) VALUES ('t1','{\"source\":\"im\",\"channel\":\"wechat\",\"externalUser\":\"creatorA\"}','任务A')").run();
  const ts = resolveTargets(db, 't1', true);
  ok(ts.length === 1 && ts[0]!.channelType === 'wechat' && ts[0]!.externalUserId === 'creatorA',
    '有 origin → 只该创建人(wechat/creatorA), 不向 dingtalk 更近 inbound 路人广播', JSON.stringify(ts));
}
{
  const db = mkdb();
  db.prepare("INSERT INTO wa_im_channels (id,channel_type,status) VALUES ('d','dingtalk','active'),('w','wechat','active')").run();
  db.prepare("INSERT INTO wa_im_conversations (id,channel_id,external_user_id,direction,created_at) VALUES ('c1','d','creatorB','inbound',datetime('now'))").run();
  db.prepare("INSERT INTO wa_tasks (id,context_json,title) VALUES ('t2','{\"source\":\"im\",\"channel\":\"dingtalk\"}','任务B')").run();
  const ts = resolveTargets(db, 't2', true);
  ok(ts.length === 1 && ts[0]!.channelType === 'dingtalk' && ts[0]!.externalUserId === 'creatorB',
    'origin 缺 externalUser → 回落 origin 渠道最近 inbound 同人', JSON.stringify(ts));
}
{
  // 补②(§十三) 语义更新: 无 origin 不再早退(旧行为 0 目标=GUI 任务全量漏发), 但**只回落单一最近 1:1**——
  // 绝不"向无关渠道最近发言路人广播"(旧 M1 断言 length===0 已随本轮决策改写: 目标数恒为 1 而非 N)
  const db = mkdb();
  db.prepare("INSERT INTO wa_im_channels (id,channel_type,status) VALUES ('w','wechat','active'),('d','dingtalk','active')").run();
  db.prepare("INSERT INTO wa_im_conversations (id,channel_id,external_user_id,direction,created_at) VALUES ('c1','w','strangerW','inbound','2026-09-10 10:00:00')").run();
  db.prepare("INSERT INTO wa_im_conversations (id,channel_id,external_user_id,direction,created_at) VALUES ('c2','d','strangerD','inbound','2026-09-09 10:00:00')").run();
  db.prepare("INSERT INTO wa_tasks (id,context_json,title) VALUES ('t3','{}','GUI任务')").run();
  const ts = resolveTargets(db, 't3', true);
  ok(ts.length === 1 && ts[0]!.channelType === 'wechat' && ts[0]!.externalUserId === 'strangerW',
    'GUI/无 origin 任务 → 只回落单一最近 1:1(wechat/strangerW), 不跨渠道广播(非 2 目标)', JSON.stringify(ts));
}
{
  // 补②(§十三): 无 origin 任务回落最近一条 1:1 私聊(不再早退漏发); 群聊行不入围
  const db = mkdb();
  db.prepare("INSERT INTO wa_im_channels (id,channel_type,status) VALUES ('w','wechat','active')").run();
  db.prepare("INSERT INTO wa_im_conversations (id,channel_id,external_user_id,direction,created_at,message_json) VALUES ('c1','w','roomX@chatroom','inbound','2026-09-10 10:00:00','{\"chat_type\":\"group\"}')").run();
  db.prepare("INSERT INTO wa_im_conversations (id,channel_id,external_user_id,direction,created_at,message_json) VALUES ('c2','w','ownerDirect','inbound','2026-09-09 10:00:00','{\"chat_type\":\"direct\"}')").run();
  db.prepare("INSERT INTO wa_tasks (id,context_json,title) VALUES ('t4','{}','GUI任务')").run();
  const ts = resolveTargets(db, 't4', true);
  ok(ts.length === 1 && ts[0]!.channelType === 'wechat' && ts[0]!.externalUserId === 'ownerDirect',
    '补② 无 origin → 回落最近 1:1 私聊(更新群聊行更近但被排除, 取 ownerDirect 非 roomX@chatroom)', JSON.stringify(ts));
}
{
  // 补② 防误投: 仅有群聊 inbound 时不得回落(宁可不发, 不发群聊路人)
  const db = mkdb();
  db.prepare("INSERT INTO wa_im_channels (id,channel_type,status) VALUES ('w','wechat','active')").run();
  db.prepare("INSERT INTO wa_im_conversations (id,channel_id,external_user_id,direction,created_at,message_json) VALUES ('c1','w','roomX@chatroom','inbound',datetime('now'),'{\"chat_type\":\"group\"}')").run();
  db.prepare("INSERT INTO wa_im_conversations (id,channel_id,external_user_id,direction,created_at) VALUES ('c2','w','legacyRoom@chatroom','inbound',datetime('now'))").run();
  db.prepare("INSERT INTO wa_tasks (id,context_json,title) VALUES ('t5','{}','GUI任务')").run();
  const ts = resolveTargets(db, 't5', true);
  ok(ts.length === 0, '补② 仅群聊/房间 inbound → 不回落(绝不误投群聊路人, 含遗留无 chat_type 的房间号)', JSON.stringify(ts));
}
{
  const db = mkdb();
  db.prepare("INSERT INTO wa_im_channels (id,channel_type,status) VALUES ('w','wechat','active'),('d','dingtalk','active')").run();
  db.prepare("INSERT INTO wa_im_conversations (id,channel_id,external_user_id,direction,created_at) VALUES ('c1','w','strangerW','inbound',datetime('now'))").run();
  db.prepare("INSERT INTO wa_im_conversations (id,channel_id,external_user_id,direction,created_at) VALUES ('c2','d','strangerD','inbound',datetime('now'))").run();
  db.prepare("INSERT INTO wa_tasks (id,context_json,title) VALUES ('t3','{}','GUI任务')").run();
  const ts = resolveTargets(db, 't3', false);
  ok(ts.length === 2, 'notify_to_creator=false 回落旧全渠道行为(每渠道最近 inbound)', ts.map(t => t.channelType).join(','));
}

console.log('A1·agent 判定介入暂停 → pauseTask(note) → markPauseNeeded 接线(源码静态)');
{
  // zx_20260917 M1: 告因路径收口——各分支不再各自 `markPauseNeeded(db, taskId, …)`，而是把理由交给
  // **唯一写入口** `pauseTask` 的 `note`（"传即告知"），由入口转投 `markPauseNeeded`。
  // 故计数面从 `markPauseNeeded(` 改为 `pauseTask(...)` 中**带 `note:`** 的那些——与被计数的语义
  // （"该暂停要告知创建人"）逐字一致，计数仍为 11（见下逐种说明，一字未改）。
  const withNote = (() => {
    let n = 0;
    for (let i = exe.indexOf('pauseTask(db, {'); i >= 0; i = exe.indexOf('pauseTask(db, {', i + 1)) {
      // ⚠ 不能用裸 `includes('note:')`：`extraContext:{ pause_note: … }` 里含子串 `note:`，
      //    会把"不带 note 的分支"误计进来（该键与 `note` 是两码事）。前界排除标识符字符。
      // zx_20261023_3：扫描窗口从"后 400 字符"收到**该调用自身**（到第一个 `});` 为止）——
      //   `interruptTask` 在调用之后新增了 `note:` 结果键（如实回报有没有真中止），固定窗口会把它
      //   算成"带 note 的暂停分支"（实测 13→14）。按调用边界切是**更精确**的扫描面，不是放宽。
      const callEnd = exe.indexOf('});', i);
      const callText = exe.slice(i, callEnd >= 0 ? callEnd + 3 : i + 400);
      if (/(^|[^A-Za-z0-9_])note:/.test(callText)) n++;
    }
    return n;
  })();
  const pauseCalls = withNote;
  // zx_20260914 M0.5-3: 原 6 处；新增 2 处是「父等子任务而暂停」（finalize 收口闸 / run_close 闸）。
  // 二者与那 6 处**不是同一种暂停**——那 6 处是全局唯一的介入点。故计数改 8，且标签如实分开说，
  // 不让新加的 2 处冒充"介入暂停分支"（断言名须=扫描面）。
  // zx_20260915 P0-1: 再增 1 处——收尾「无真实产出证据」改置 paused（方案 §1.4(a) 硬闸），
  //   与既有 8 处**又不同种**：它既不是介入暂停、也不是等子，而是"引擎按判据认定无物可交付"。
  // zx_20260915 P0-3(c): 再增 1 处——收口时「有失败子任务未处置」改置 paused（第 4 种：非介入判定，
  //   也不是"等子"，而是"子已到头但结果不可接受"）。计数改 10，标签仍逐种如实分开，不混为一谈。
  // zx_20260916_1 M1(A1): 再增 1 处——run_close 收口时「验收**已核验且未通过**」改置 paused（第 5 种：
  //   与"无产出证据"同为"引擎按判据认定未达交付"，但判据是**公开账本** `acceptance_check` 而非结构指标；
  //   它把既有的 D1「过早结束且<60」那道闸多接一条入口，不是新拦点）。计数改 11。
  // zx_20260917 M1: 计数面改 `pauseTask(...note:)`（见上）；计数仍 11，逐种说明一字未改——
  //   "告知创建人"的**判据**从"分支里有没有 markPauseNeeded"变为"分支有没有把 note 交给唯一写入口"。
  // zx_20260923 M1-a/G2（T1 裁定）: 再增 1 处——SDK 连续失败两次、自动重试用尽后**落 `paused` 并带 note**
  //   （原先是 `throw` 冒到外层 catch 落 `failed`）。这是**第 6 种**：既非介入暂停、非等子、非内容判据，
  //   而是"外部依赖不可用且自动重试已耗尽"——故障与任务内容无关，记成 `failed` 是把外部故障记在任务头上。
  //   计数改 12，标签照例逐种分开说（新增的这一种**不得**被并进前 6 种里冒充"介入暂停"）。
  // zx_20260923_1 M2: 再增 1 处——run_close 收口时「**有验收判据、本轮却没判成**」改置 paused
  //   （`acceptance_unjudged`；口径见 `acceptance-check.ts` 的 `UNJUDGED_REASONS`）。它与上一条
  //   「验收未通过」**同族不同物**：判据同为公开账本 `acceptance_check`，但那条是"判了、判卷说不达标"，
  //   这条是"**题在、没判成**"——处置也不同（要人恢复重跑，不是核验产出）。计数改 13，
  //   标签照例逐种分开说，**不得**并进"验收未通过"里（合并即把两种要人做的事混成一件）。
  //   ⚠ 本扫描面是 `engineSrc()`（= `agent-executor.ts` ∪ `core/exec-*.ts`），故落在
  //     `exec-finalize.ts` 的分支同样入账——这正是"枚举新增须回填老台账"的一例（收口实测抓到）。
  ok(pauseCalls === 13, 'agent-executor 13 个暂停分支均经 pauseTask 带 note(即告知创建人)：6 个介入暂停(硬暂停级别2/无进展/产出多次未落盘/内容不充分/过早结束 + 补③ finalize partial 悬置) + 2 个等待子任务(finalize 收口闸/run_close 闸) + 1 个无产出证据(run_close，P0-1) + 1 个失败子未处置(blockFailedChildrenCompletion，P0-3c) + 1 个验收未通过(run_close 收口，zx_20260916_1 M1/A1) + 1 个验收未判成(run_close 收口，zx_20260923_1 M2) + 1 个 SDK 重试用尽(run 内，zx_20260923 M1-a/T1)', `出现 ${pauseCalls} 处(期望13)`);
  ok(exe.includes('疑似工具循环') && exe.includes('疑似空转') && exe.includes('产出文件多次未落盘') && exe.includes('充分性校验') && exe.includes('分未达交付标准'),
    'agent-executor 各分支理由文字正确(工具循环/空转/未落盘/不充分/过早结束质量)');
  // 补③(§十三): finalize partial 悬置分支(置 paused + paused_partial)须通知创建人
  {
    const ps = exe.indexOf("const finScore = (ctxJson.completion_quality as { score?: number })?.score ?? 70;");
    const pe = exe.indexOf("return JSON.stringify({ status: 'paused_partial'", ps);
    const pBody = ps >= 0 && pe > ps ? exe.slice(ps, pe) : '';
    ok(pBody.length > 0 && pBody.includes('pauseTask(db, {') && pBody.includes('note:') && pBody.includes('预算强制收尾且自评未达交付'),
      '补③ finalize partial 悬置(预算≥0.95 置 paused)已经 pauseTask 带 note 告知创建人(理由含 partial/低分)', pBody ? 'partial 分支已接线' : '未定位 partial 分支');
  }
  // zx_20260917 M1: 执行器不再直接依赖 im-notify（告因统一经 pauseTask → markPauseNeeded）
  ok(exe.includes("import { pauseTask } from './pause-task.js'"), 'agent-executor 顶部 import pauseTask(唯一写入口)');
  const goalCalls = (ait.match(/pauseTask\(db, \{ taskId, reason: PAUSE_REASON_GOAL_DEVIATION, note: GOAL_DEVIATION_PAUSE_REASON \}\)/g) || []).length;
  ok(goalCalls === 2, 'ai-task 目标偏离收敛(ai-task/resume 两处)均经 pauseTask 带 note 告知创建人', `出现 ${goalCalls} 处(期望2)`);
  ok(ait.includes("const GOAL_DEVIATION_PAUSE_REASON = '目标已多次偏离，已停止自动恢复，需人工介入") && ait.includes("import { pauseTask } from '../pause-task.js'"), 'ai-task 理由文字 + import pauseTask');
  const intStart = exe.indexOf('export function interruptTask');
  const intEnd = exe.indexOf('\nexport ', intStart);
  const intBody = intStart >= 0 && intEnd > intStart ? exe.slice(intStart, intEnd) : '';
  // zx_20260917 M1: 判据同义加强——除"体干净"外，再加"交给入口的 note 为空"这一**正面**依据：
  // `pauseTask` 是"传即告知"，故"用户主动暂停不通知"⇔"此处调用不带 note"。
  ok(intBody.length > 0 && !intBody.includes('markPauseNeeded') && !intBody.includes('pushImNotify') && !intBody.includes('sendImNotification')
    && intBody.includes('pauseTask(db, { taskId, reason: PAUSE_REASON_USER_INTERRUPT })'),
    '用户主动暂停(interruptTask)不触发 IM(体干净 + 交给入口的 note 为空)', intBody ? 'interruptTask 体干净' : '未定位 interruptTask');
  ok(mnf.includes('PAUSE_NOTIFY_COOLDOWN_MS') && mnf.includes('pauseNotifiedAt'), 'im-notify 每任务每次暂停至多一条(短窗去重 map+cooldown)');
  ok(mnf.includes('im.notify_pause_needed'), 'A1 开关 im.notify_pause_needed 消费于 im-notify');
}

console.log('A2/A1·共享助手接线(index pushImCompletion 收敛 / im.ipc 返回送达结果 / config 键)');
{
  ok(idxt.includes("import('./core/im/im-notify.js')") && idxt.includes('await pushImNotify(db, taskId, message)'),
    'index.pushImCompletion 收敛到共享 pushImNotify(创建人优先目标)');
  ok(mnf.includes("settingOf(db, 'im.notify_to_creator', 'true')") && mnf.includes('resolveImNotifyTargets(db, taskId, notifyToCreator)'),
    'pushImNotify 按 im.notify_to_creator 决定 creatorOnly / 回落旧行为');
  // 订正（M3 落地时）：契约由 `Promise<boolean>` 升级为 `Promise<{ok, error?}>`——boolean 把失败**原因**丢在 catch 里，
  //   账上只剩"未送达"三个字。判据改为：结果对象在位、无适配器即带**具体原因**回报（供 A3 补发判定，语义只增不减）。
  ok(iip.includes('Promise<{ ok: boolean; error?: string }>') && iip.includes("if (!adapter) return { ok: false, error: '[IM] 渠道适配器未运行' }") && iip.includes('return { ok: true };'),
    'sendImCompletionNotice 返回送达结果(无适配器/抛错→ok:false 带具体原因, 供 A3 补发判定)');
  ok(dbt.includes("ensureSetting('im.notify_to_creator', 'true')") && dbt.includes("ensureSetting('im.notify_pause_needed', 'true')"),
    'config ensureSetting 注册 im.notify_to_creator / im.notify_pause_needed');
  // 同步（zx_20260915 M2 · P0-4）：文案已从本文件**移出**到唯一构造器 `core/task-notice.ts`
  //   ——本文件此前手写 `⚠️ 任务「…」已暂停待复核：…（可在桌面处理/恢复）`，与 `wa_tasks.status` 各说各话。
  //   故断言改为钉**两件事**：①本文件不再自述文案（手写字面量零残留）②文案仍在（是搬家，不是删掉）。
  const tns = rd('apps/worker-ant-desktop/src/main/core/task-notice.ts');
  ok(!mnf.includes('⚠️ 任务「') && mnf.includes("buildTaskNotice(db, taskId, 'paused', { detail: reason })"),
    'A1 文案由单源构造器出(本文件零手写字面量, 暂停原因仍如实传入)',
    mnf.includes('⚠️ 任务「') ? '字面量仍残留' : '已移出到 task-notice');
  ok(tns.includes('⚠️') && tns.includes('待复核') && tns.includes('可在桌面处理/恢复'),
    'A1 文案含状态语气+待复核标记+桌面处理引导(不含新命令词)——载体已搬至 task-notice.ts');
  // 补⑤(§十三): im.* 三键 GUI 可点(此前只能 DB 直改) —— Settings 组 + 写 'true'/'false' 口径
  const setp = rd('apps/worker-ant-desktop/renderer/src/pages/SettingsPage.tsx');
  ok(setp.includes("key: 'notify_to_creator'") && setp.includes("key: 'notify_pause_needed'"),
    '补⑤ Settings 加「IM 通知」组两布尔开关行(notify_to_creator/notify_pause_needed)');
  ok(setp.includes('toggleIm') && /settings:set', `im\.\$\{key\}`, on \? 'true' : 'false'/.test(setp),
    '补⑤ im.* 布尔键写 true/false(与消费方 !==\'false\' 同口径, 非 0/1)');
  ok(setp.includes("commitOutboxMinutes") && setp.includes("'im.outbox_retry_min'"),
    '补⑤ 出站补发窗口(im.outbox_retry_min 分钟, 0=关)可视化编辑且钳位 0-1440');
  ok(idxt.includes("key = 'im.outbox_retry_min'") && /Math\.max\(0, Number\(cfg\?\.value \?\? '10'\) \|\| 0\)/.test(idxt),
    '补⑤ 窗口键消费于 main 补发定时器(缺省 10, 0=关), 与 GUI 写入同键');
}

console.log('\n结果: pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
