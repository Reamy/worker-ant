/**
 * zx_20261111_3「显」——五页第一行说清，IM 说错能改。
 *
 * 判据分组（随批次逐步补齐）：
 *   A「言」`core/next-action.ts` 纯函数：五页派生、优先级次序、unknown 三态、文案不含内部键。
 *   B「见」产出物关注计数与列表同 scope；模型/设置两页的取数口与三态。
 *   C「证」IM 回执自证与 10 分钟撤销（假时钟；计数器须有 0→1）。
 *   W「接线」五页各恰一处 NextActionBar；页面不再自带第二份判据。
 *
 * 纪律：
 *   - 夹具自建 DDL（不跑 initDatabase），顺序按生产初始化；
 *   - 文案断言只钉关键子串，不钉整句（改文案不该弄红判据）；
 *   - 不写"只为下一轮"的字面量；轮次钉由 checkBuildPins 从真源派生。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { routeImMessage } from '../apps/worker-ant-desktop/src/main/services/im-router.js';
import {
  STALL_AFTER_MS,
  nextActionForProject, nextActionForTask, nextActionForDeliverables, nextActionForModels, nextActionForSettings,
  type NextAction,
} from '../apps/worker-ant-desktop/src/main/core/next-action.js';
import { countUnverified } from '../apps/worker-ant-desktop/src/main/core/deliverable-attention.js';
import {
  UNDO_COMMAND_RE, UNDO_WINDOW_MS, decideUndo, intentEcho, undoRefusalText,
} from '../apps/worker-ant-desktop/src/main/core/im-echo.js';
import { checkBuildPins } from './lib/rr-pins.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(a: unknown, b: unknown, label: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `${JSON.stringify(a)} = ${JSON.stringify(b)}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const readSrc = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');

/** 内部键不得出现在给人看的句子里（`paused`/`pending`/`live` 这类是给机器的）。 */
const INTERNAL_KEY_RE = /\b(paused|pending|executing|live|queued|ghost|idle|terminal|failed|completed|archived)\b/i;

function assertHuman(a: NextAction, label: string): void {
  ok(!INTERNAL_KEY_RE.test(a.headline), `${label} 标题说人话（不含内部键）`, a.headline);
  ok(a.headline.length > 0, `${label} 标题非空`);
  ok(!a.action || (typeof a.action.label === 'string' && a.action.label.length > 0), `${label} 若给动作则有按钮文案`);
}

function sectionA(): void {
  console.log('\n【A】next-action 纯函数');

  // ── A0 五页对"空入参"一律 unknown（不得回落成 ok）──
  const empty = [
    nextActionForProject(null), nextActionForTask(undefined),
    nextActionForDeliverables(null), nextActionForModels(undefined), nextActionForSettings(null),
  ];
  eq(empty.map((x) => x.tone), ['unknown', 'unknown', 'unknown', 'unknown', 'unknown'],
    'A0 ★五页空入参一律 unknown（不把"没拿到"说成"没事"）');
  ok(empty.every((x) => /读不到/.test(x.headline)), 'A0b 空入参的标题点明"读不到"');

  // ── A1 项目：优先级次序（前档成立时后档被压住）──
  const pBase = { status: 'active', awaiting: 0, failed: 0, briefStatus: 'ready', briefStale: false, hasBriefSource: true };
  eq(nextActionForProject({ ...pBase, awaiting: 2, failed: 1 }).key, 'project.awaiting',
    'A1a 有等你回复的任务 ⇒ 压过"失败"与其余（先回话）');
  eq(nextActionForProject({ ...pBase, failed: 1, briefStale: true }).key, 'project.failed',
    'A1b 无待回复、有失败 ⇒ 失败优先于须知过期');
  eq(nextActionForProject({ ...pBase, briefStale: true }).key, 'project.brief_stale',
    'A1c 须知过期 ⇒ 压过"空闲"');
  eq(nextActionForProject({ ...pBase, briefStale: true, hasBriefSource: false }).key, 'project.brief_stale',
    'A1d 过期与无来源同时成立 ⇒ 先说过期（有旧须知可重建）');
  eq(nextActionForProject({ ...pBase, hasBriefSource: false }).key, 'project.no_source',
    'A1e 无工作目录且无描述 ⇒ 还差一步');
  // ★反证：`briefStale === null`（判不了）**不得**被当成过期
  eq(nextActionForProject({ ...pBase, briefStale: null }).key, 'project.idle',
    'A1f ★反证：过期与否判不出来时，不得冒充"已过期"');
  eq(nextActionForProject({ ...pBase, briefStatus: 'failed', briefError: '生成超时' }).key, 'project.brief_failed',
    'A1g 上次生成失败 ⇒ 指出并给重试');
  ok(nextActionForProject({ ...pBase, briefStatus: 'failed', briefError: '生成超时' }).detail === '生成超时',
    'A1h 失败原因原样带出（不磨成"失败"两个字）');
  // ★GUI 实测打出来的一个真偏差（2026-11-11）：曾用 `taskStats.total - completed` 报"还有 N 件没走完"，
  //   而归档件也被 `total` 计入 ⇒ 怡寿里 120 件里 21 件是归档件，界面上凭空多出"21 件没走完"。
  //   没有可靠的"未完成"数时不得编数——故该档已删除，这里反向钉住"不出现这类自造数"。
  ok(!/件任务没走完/.test(nextActionForProject({ ...pBase }).headline),
    'A1i ★反证：没有可靠的未完成数就不许说"还有 N 件没走完"（归档件会被算成未完成）');
  ok(nextActionForProject({ ...pBase }).headline === '暂无待办',
    'A1i-b 无待办时只说"暂无待办"（不说"正在跑"——跑没跑是执行态那把尺）');
  eq(nextActionForProject({ ...pBase, status: 'paused' }).key, 'project.paused',
    'A1j 已暂停 ⇒ 说暂停');
  eq(nextActionForProject({ ...pBase }).key, 'project.idle', 'A1k 一切正常 ⇒ 暂无待办');
  // ★取不到数就如实说，不得回落 ok
  eq(nextActionForProject({ ...pBase, loadError: 'IPC 超时' }).tone, 'unknown', 'A1l ★读失败 ⇒ unknown（不冒充正常）');
  ok(nextActionForProject({ ...pBase, loadError: 'IPC 超时' }).headline.includes('IPC 超时'),
    'A1m 读失败原因原样上屏');
  // 无按钮的情形
  ok(nextActionForProject({ ...pBase }).action === undefined, 'A1n "暂无待办"不摆按钮（不造动作）');

  // ── A2 任务：优先级次序 ──
  const tBase = { status: 'executing', awaitingInput: false, depState: 'met', execState: 'live', progressAgeMs: 5_000, pauseReason: '' };
  eq(nextActionForTask({ ...tBase, awaitingInput: true, depState: 'blocked' }).key, 'task.awaiting_input',
    'A2a 等回复 ⇒ 压过前置阻塞');
  eq(nextActionForTask({ ...tBase, depState: 'blocked' }).key, 'task.dep_blocked', 'A2b 前置永不可满足 ⇒ 动不了');
  eq(nextActionForTask({ ...tBase, depState: 'waiting' }).key, 'task.dep_waiting', 'A2c 前置会自动解锁 ⇒ 等着');
  eq(nextActionForTask({ ...tBase, depState: 'unresolved' }).key, 'task.dep_blocked', 'A2d 前置查不到 ⇒ 也算动不了');
  eq(nextActionForTask({ ...tBase, execState: 'ghost' }).key, 'task.ghost', 'A2e 幽灵态 ⇒ 必须给出口');
  eq(nextActionForTask({ ...tBase, progressAgeMs: STALL_AFTER_MS }).key, 'task.stalled',
    'A2f 到阈值 ⇒ 报"没有新进展"');
  eq(nextActionForTask({ ...tBase, progressAgeMs: STALL_AFTER_MS - 1 }).key, 'task.running',
    'A2g 未到阈值 ⇒ 仍说执行中（不误报卡住）');
  eq(nextActionForTask({ ...tBase, execState: 'queued' }).key, 'task.queued', 'A2h 排队中');
  eq(nextActionForTask({ ...tBase, execState: null, status: 'failed', pauseReason: '模型调用失败' }).key, 'task.failed',
    'A2i 失败 ⇒ 带原因给重试');
  eq(nextActionForTask({ ...tBase, execState: null, status: 'paused', pauseReason: '等你确认' }).key, 'task.paused',
    'A2j 暂停 ⇒ 带因由给继续');
  eq(nextActionForTask({ ...tBase, execState: null, status: 'pending' }).key, 'task.pending', 'A2k 未开始 ⇒ 给开始');
  eq(nextActionForTask({ ...tBase, execState: null, status: 'completed' }).key, 'task.completed', 'A2l 已完成');
  eq(nextActionForTask({ ...tBase, execState: null, status: 'archived' }).key, 'task.archived', 'A2m 已归档');
  ok(nextActionForTask({ ...tBase, execState: null, status: 'completed' }).action === undefined,
    'A2n 已完成不摆按钮');
  eq(nextActionForTask({ ...tBase, status: '' }).tone, 'unknown', 'A2o ★状态取不到 ⇒ unknown');
  eq(nextActionForTask(null).tone, 'unknown', 'A2p 任务数据缺失 ⇒ unknown');
  // "最后进展 X 前"由同一把时长尺给
  ok(nextActionForTask({ ...tBase, progressAgeMs: 125_000 }).detail === '最后进展 2 分钟前',
    'A2q 最后进展用统一时长换算',
    String(nextActionForTask({ ...tBase, progressAgeMs: 125_000 }).detail));

  // ── A3 产出物 ──
  eq(nextActionForDeliverables({ total: 10, unverified: 3, acceptanceEnabled: true }).key, 'deliverable.unverified',
    'A3a 未验收 ⇒ 先说未验收');
  ok(nextActionForDeliverables({ total: 10, unverified: 3, acceptanceEnabled: true }).action === undefined,
    'A3b ★不给假按钮：页内没有"只看未验收"的筛选，就不造一个点了没用的动作');
  eq(nextActionForDeliverables({ total: 0, unverified: 0, acceptanceEnabled: true }).key, 'deliverable.empty',
    'A3c 一件没有 ⇒ 说"还没有产出物"');
  eq(nextActionForDeliverables({ total: 5, unverified: 0, acceptanceEnabled: true }).key, 'deliverable.ok', 'A3d 全验收 ⇒ ok');
  // ★验收展示关掉时，不得说"均已验收"
  const accOff = nextActionForDeliverables({ total: 5, unverified: 0, acceptanceEnabled: false });
  ok(!accOff.headline.includes('均已验收'), 'A3g ★反证：验收展示关掉时不说"均已验收"（那不是我们知道的）');
  eq(nextActionForDeliverables({ total: null, unverified: 0, running: 0 }).tone, 'unknown',
    'A3e ★总量没取到 ⇒ unknown（0 件 ≠ 没取到）');
  eq(nextActionForDeliverables({ total: 5, loadError: '查询失败' }).tone, 'unknown', 'A3f ★读失败 ⇒ unknown');

  // ── A4 模型 ──
  eq(nextActionForModels({ read: 'ok', hasChat: true, available: 4, catalog: 52 }).key, 'model.ok', 'A4a 有可用对话模型 ⇒ ok');
  ok(nextActionForModels({ read: 'ok', hasChat: true, available: 4, catalog: 52 }).headline.includes('4'),
    'A4b 可用数上屏');
  eq(nextActionForModels({ read: 'ok', hasChat: false, available: 0, catalog: 52 }).key, 'model.no_chat',
    'A4c 目录有 52 条但没有可用对话模型 ⇒ 必须说"跑不起来"');
  ok(nextActionForModels({ read: 'ok', hasChat: false }).action?.id === 'open_models', 'A4d 没模型时给"去配置"');
  eq(nextActionForModels({ read: 'error', readNote: 'ECONNREFUSED' }).tone, 'unknown',
    'A4e ★读不动 ≠ 没有模型：ANS 不可达是 unknown');
  ok(nextActionForModels({ read: 'error', readNote: 'ECONNREFUSED' }).headline.includes('ECONNREFUSED'),
    'A4f 读失败原因原样上屏');

  // ── A5 设置 ──
  eq(nextActionForSettings({ ans: 'unconfigured', defaultModel: '' }).key, 'settings.ans_unconfigured',
    'A5a ANS 未配置 ⇒ 还差一步');
  eq(nextActionForSettings({ ans: 'configured', defaultModel: '' }).key, 'settings.ok', 'A5b 未指定默认模型 ⇒ 一切就绪');
  eq(nextActionForSettings({ ans: 'configured', defaultModel: 'deepseek-v4-flash' }).detail,
    '默认模型：deepseek-v4-flash', 'A5c 指定了默认模型 ⇒ 带上名字');
  eq(nextActionForSettings({ ans: 'configured', defaultModel: null }).tone, 'unknown',
    'A5d ★默认模型没取到 ⇒ unknown（不冒充"按自动选型"）');
  eq(nextActionForSettings({ ans: 'unknown', ansNote: 'ANS 探活超时' }).tone, 'unknown', 'A5e ANS 状态未知 ⇒ unknown');

  // ── A6 说人话 + 动作唯一 ──
  const samples: NextAction[] = [
    nextActionForProject({ ...pBase, awaiting: 1 }), nextActionForProject({ ...pBase, failed: 2 }),
    nextActionForProject({ ...pBase, briefStale: true }), nextActionForProject({ ...pBase, hasBriefSource: false }),
    nextActionForTask({ ...tBase, execState: 'ghost' }), nextActionForTask({ ...tBase, progressAgeMs: 3_600_000 }),
    nextActionForDeliverables({ total: 3, unverified: 1 }), nextActionForModels({ read: 'ok', hasChat: false }),
    nextActionForSettings({ ans: 'unconfigured' }),
  ];
  samples.forEach((a, i) => assertHuman(a, `A6-${i + 1}`));
  ok(samples.every((a) => a.action === undefined || typeof a.action.id === 'string'),
    'A6z 动作一律带 id（页面按 id 映射，core 不认识路由）');
}

function sectionB(): void {
  // ── B1 「未验收」计数判据（与列表徽标同一份 `acceptance`）──
  const rows = [
    { type: 'doc', status: 'active', acceptance: { passed_total: 1 } }, // 已验收
    { type: 'doc', status: 'active' },                                  // 未验收 → 计
    { type: 'code', status: 'active' },                                 // 未验收 → 计
    { type: 'doc', status: 'retired' },                                 // 退休件 → 不计
    { type: 'image', status: 'active' },                                // 非可验收类型 → 不计
    { type: 'daemon', status: 'active' },                               // 非可验收类型 → 不计
  ];
  eq(countUnverified(rows), 2, 'B1 未验收件数：只数可验收类型、未退休、且没有验收结论的行');
  eq(countUnverified([{ type: 'doc', status: 'active', acceptance: {} }]), 0,
    'B1-b ★两侧标本：有 `acceptance`（哪怕空对象）就不算未验收——判定权在 annotateAcceptance');
  eq(countUnverified([]), 0, 'B1-c 空清单 ⇒ 0（不是 null）');

  // ── B2 取数口与列表同 scope、同注解（静态接线钉）──
  const ipc = readSrc(`${A}/src/main/ipc/project.ipc.ts`);
  ok(/ipcMain\.handle\('deliverable:attention'/.test(ipc), 'B2a 新增取数口在册');
  ok(/const total = countDeliverables\(db, \{ includeRetired: false \}\)/.test(ipc),
    'B2b 总数复用 countDeliverables（与其它计数同一真源）');
  ok(/deliverableScopeSql\(\{ alias: 'd', includeRetired: false \}\)/.test(ipc),
    'B2c 未验收的行集与列表同一 scope（同一把尺）');
  ok(/annotateAcceptance\(db, rows\)/.test(ipc) && /countUnverified\(rows\)/.test(ipc),
    'B2d 先由 annotateAcceptance 标好再数（不在 SQL 里另写一份验收判据）');
  ok(/acceptanceEnabled \? true|const acceptanceEnabled = boolSetting/.test(ipc),
    'B2e 验收展示关闭时不解出一个假数');

  // ── B3 模型页：能不能跑用首启判据同一把尺 ──
  const models = readSrc(`${A}/renderer/src/pages/ModelsPage.tsx`);
  ok(/deriveModelAvailability\(models\)/.test(models), 'B3a 复用 deriveModelAvailability（不另判 hasChat）');
  ok(/hasChat: modelAvailability\.hasChat/.test(models), 'B3b 第一行喂的是同一把尺的结果');
  ok(/await ansProxy\.get<Model\[\]>\('\/api\/v1\/models'\)/.test(models)
    && !/tab === 'providers'\s*\n?\s*\? \[await ansProxy/.test(models),
    'B3c 两个 tab 都取模型目录（否则在供应商 tab 上无法回答"能不能跑"）');

  // ── B4 设置页：默认模型走既有读口，不猜 ──
  const settings = readSrc(`${A}/renderer/src/pages/SettingsPage.tsx`);
  ok(/invoke<string \| null>\('settings:get', 'model\.default_model'\)/.test(settings),
    'B4a 默认模型走 `settings:get`（与模型页同一键）');
  ok(/defaultModel: modelReadOk \? defaultModel : null/.test(settings),
    'B4b ★没取到就传 null（第一行说"未取得"，不冒充"按自动选型"）');
  ok(/id="settings-ans"/.test(settings), 'B4c "去配置"有真实落点（可滚到 ANS 卡）');
}

function sectionC(): void {
  const createDecision = { intent: 'create_task', route: 'create', confidence: 'high', reason: '含建单动词——按建单处理（创建）' };
  const startDecision = { intent: 'start_task', route: 'start', confidence: 'high', reason: '以启动词开头——按启动/恢复处理' };

  // ── C1 回执自证：只说"理解成什么 + 凭什么"，且承诺的撤销确实存在 ──
  const echo = intentEcho(createDecision);
  ok(!!echo && echo.includes('我理解成：建任务'), 'C1a 建单回执带「我理解成：建任务」', echo ?? '(null)');
  ok(!!echo && echo.includes(createDecision.reason), 'C1b 依据取路由自己的 reason（不另写一份"为什么"）');
  ok(!!echo && echo.includes('撤销') && echo.includes('10 分钟'), 'C1c 承诺撤销并写明窗口');
  const startEcho = intentEcho(startDecision);
  ok(!!startEcho && startEcho.includes('我理解成：启动任务'), 'C1d 启动回执也自证');
  ok(!!startEcho && !startEcho.includes('撤销'),
    'C1e ★反证：启动不承诺撤销（已经开始跑的事撤回不了，写了就是许诺做不到的事）');

  // ── C2 不该加这一行的：无副作用的路 / 没被受理的路 ──
  for (const [label, d] of [
    ['查询', { intent: 'query_status', route: 'query', confidence: 'high', reason: 'x' }],
    ['闲聊', { intent: 'general_chat', route: 'greeting', confidence: 'high', reason: 'x' }],
    ['帮助', { intent: 'general_chat', route: 'help', confidence: 'high', reason: 'x' }],
    ['群聊拒绝', { intent: 'create_task', route: 'group_gate', confidence: 'high', reason: 'x' }],
    ['确认分支', { intent: 'create_task', route: 'confirmation', confidence: 'medium', reason: 'x' }],
  ] as const) {
    eq(intentEcho(d as never), null, `C2 ${label}不加"我理解成"这一行（说了也没得改）`);
  }
  eq(intentEcho(null), null, 'C2z 无判定 ⇒ 不编一句');

  // ── C3 撤销窗：两侧标本（边界两侧都要有）──
  const now = 1_700_000_000_000;
  eq(decideUndo(undefined, now), { ok: false, reason: 'none' }, 'C3a 没有记录 ⇒ none');
  eq(decideUndo({ taskId: 't1', at: now - 1000 }, now), { ok: true, taskId: 't1' }, 'C3b 窗口内 ⇒ 可撤');
  eq(decideUndo({ taskId: 't1', at: now - UNDO_WINDOW_MS }, now).ok, true, 'C3c 恰在边界上 ⇒ 仍可撤（含端点）');
  eq(decideUndo({ taskId: 't1', at: now - UNDO_WINDOW_MS - 1 }, now), { ok: false, reason: 'expired' },
    'C3d 过界 1 毫秒 ⇒ 过期（边界另一侧）');
  eq(decideUndo({ taskId: 't1', at: now + 5_000 }, now), { ok: false, reason: 'expired' },
    'C3e ★时钟倒退/未来时刻 ⇒ 不可撤（不把异常当"刚刚"）');

  // ── C4 拒绝理由各不相同（别把三种情形说成一句话）──
  const texts = (['none', 'expired', 'running', 'gone'] as const).map(undoRefusalText);
  eq(new Set(texts).size, 4, 'C4a 四种拒绝各有各的话（没有/过期/已在跑/已不在）');
  ok(texts[2]!.includes('已经'), 'C4b "已在跑"明说不能撤并指路', texts[2]);
  ok(texts[1]!.includes('10 分钟'), 'C4c "过期"明说窗口', texts[1]);

  // ── C5 触发词：只认「撤销/撤回」，**不抢「取消」**（那是对审批/确认问句的答复）──
  ok(UNDO_COMMAND_RE.test('撤销') && UNDO_COMMAND_RE.test('撤回') && UNDO_COMMAND_RE.test('「撤销」'),
    'C5a 撤销/撤回/带引号都认');
  ok(!UNDO_COMMAND_RE.test('取消'), 'C5b ★不认「取消」——抢了会改审批/确认的既有语义');
  ok(!UNDO_COMMAND_RE.test('撤销任务A'), 'C5c 只认整句（不吞掉别的指令）');
  ok(!UNDO_COMMAND_RE.test('创建任务+撤销测试'), 'C5d ★反证：正文里含"撤销"不算撤销指令');

  // ── C6 接线：两处建单调用都带自证；撤销排在别路之前；建单成功即记账 ──
  const router = readSrc(`${A}/src/main/services/im-router.ts`);
  eq((router.match(/handleCreateTask\(ctx, fromUser, routeText, inboundId, intentEcho\(decision\)\)/g) ?? []).length, 2,
    'C6a 两条建单调用（规则路 + 模型路）都带自证');
  ok(/await handleUndo\(ctx, fromUser, routeText\)/.test(router), 'C6b 撤销已接入主分发');
  ok(router.indexOf('handleUndo(ctx, fromUser, routeText)') < router.indexOf("handleApprovalInbox(ctx, fromUser, routeText"),
    'C6c 撤销排在审批/授权台之前（"刚才那条错了"要能被听见）');
  ok(/lastCreatedImTask\.set\(`\$\{ctx\.channelType\}:\$\{toUser\}`, \{ taskId, at: Date\.now\(\) \}\)/.test(router),
    'C6d 建单成功即记下可撤的那一条');
  ok(/cleanupTaskExecutionJobs\(ctx\.db, verdict\.taskId\)/.test(router)
    && /archiveTask\(ctx\.db, \{ taskId: verdict\.taskId, reason: 'IM 撤销（创建后 10 分钟内）', expectStatus: st \}\)/.test(router),
    'C6e 撤销 = 先清排队作业、再归档（pending 只清作业不归档会被下一拍重新派）');
  ok(/st !== 'pending' && st !== 'paused'/.test(router) && /undoRefusalText\('running'\)/.test(router),
    'C6f ★已在跑如实拒绝，不假装撤销');

  const cmds = readSrc(`${A}/src/main/services/im-commands.ts`);
  ok(/name: '撤销刚建的任务'/.test(cmds) && /UNDO_COMMAND_RE\.test\(s\)/.test(cmds),
    'C6g 帮助表真有一条「撤销」，且谓词与路由器同一份正则');
}

// ── C7 端到端：真路由器 + 内存真库（建单 → 回执自证 → 撤销 → 归档）──
const SCHEMA = `
CREATE TABLE wa_projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', cron_schedule TEXT, working_dir TEXT DEFAULT '',
  context_json TEXT DEFAULT '{}', sandbox_mode TEXT DEFAULT 'workspace',
  owner_id TEXT, cron_timezone TEXT DEFAULT 'Asia/Shanghai',
  autonomous_mode TEXT DEFAULT 'off', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
  source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '', aggregate_version INTEGER DEFAULT 0,
  -- zx_20261111_3: quality_score 是生产迁移列（database.ts 的 ALTER），归档路要读它——
  --   夹具缺这一列会直接抛 no such column（夹具不许比生产窄）。
  quality_score REAL,
  -- zx_20261112_2: 生产迁移列（IM 建单会写它）；夹具不许比生产窄。
  position_id TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_task_conversations (
  id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL, content TEXT DEFAULT '',
  tool_calls TEXT, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_im_conversations (
  id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, project_id TEXT,
  message_json TEXT DEFAULT '{}', direction TEXT DEFAULT 'inbound',
  created_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'sent', last_error TEXT DEFAULT '', outbox_id TEXT DEFAULT ''
);
CREATE TABLE wa_jobs (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}', status TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3, scheduled_at TEXT, started_at TEXT,
  completed_at TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
`;

async function sectionC2(): Promise<void> {
  console.log('\n【C7】端到端：IM 建单 → 自证回执 → 「撤销」→ 归档');
  const db = new DatabaseSync(':memory:');
  (db as unknown as { transaction: unknown }).transaction = (fn: () => void) => () => fn();
  db.exec(SCHEMA);
  db.prepare("INSERT INTO wa_projects (id, name, status) VALUES ('p1', '项目一', 'active')").run();

  const replies: string[] = [];
  const ctx = { db, channelId: 'ch-1', channelType: 'wechat-personal', sendReply: async (_to: string, t: string) => { replies.push(t); } };
  // ⚠ 每个场景**换一个用户**：风暴闸是"同一用户 2 秒内第 3 条起判暴"（`STORM_THRESHOLD`），
  //   同一用户连发第三条会被静默压住——那不是被测行为，是夹具把路走窄了。
  const send = (user: string, text: string) => {
    // zx_20261112_1 B3: 回访用户入参——先落一条该用户历史 inbound，使首聊欢迎不混入回执拼接
    //（欢迎由 rr_zx_20261112_1 专测）。
    db.prepare("INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction) VALUES (?, 'ch-1', ?, '{\"seed\":true}', 'inbound')")
      .run(`seed-${Math.random().toString(36).slice(2)}`, user);
    return routeImMessage(ctx as never, user, text, 'p2p', 'ctx-0', undefined);
  };

  // ① 建单（短句 ⇒ paused，不会入队跑起来）
  const before = (db.prepare('SELECT COUNT(*) c FROM wa_tasks').get() as { c: number }).c;
  await send('u1', '创建任务+写周报');
  const after = (db.prepare('SELECT COUNT(*) c FROM wa_tasks').get() as { c: number }).c;
  eq(after - before, 1, 'C7a 建单：任务行 0→1（正面断言，不是"不抛"）');
  const created = db.prepare('SELECT id, status FROM wa_tasks ORDER BY rowid DESC LIMIT 1').get() as { id: string; status: string };
  eq(created.status, 'paused', 'C7b 短句建单落 paused（不自动开跑，撤销才有意义）');
  const createReply = replies.join('\n');
  ok(createReply.includes('我理解成：建任务'), 'C7c 回执带自证（Gui 上看到的与 rr 同源）');
  ok(createReply.includes('撤销'), 'C7d 回执告诉用户怎么改');

  // ② 撤销 ⇒ 归档
  replies.length = 0;
  await send('u1', '撤销');
  const afterUndo = db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(created.id) as { status: string };
  eq(afterUndo.status, 'archived', 'C7e 撤销把刚建的任务归档（0→1 的正面断言：状态真变了）');
  ok((replies[0] ?? '').includes('已撤销'), 'C7f 回执明说撤销成功', replies[0] ?? '');

  // ③ 没有可撤的时候（新用户从未建过单）⇒ 如实说"没有"，不是崩溃也不是静默
  replies.length = 0;
  await send('u-never', '撤销');
  ok((replies[0] ?? '').includes('没有可撤销'), 'C7g 没有可撤的建单时如实说「没有可撤销的」', replies.join(' | '));

  // ④ ★已在跑的不撤：建一条、再把它改成 executing，然后撤销 ⇒ 如实拒绝、状态不变
  replies.length = 0;
  await send('u-run', '创建任务+跑起来的那条');
  const newest = db.prepare('SELECT id FROM wa_tasks ORDER BY rowid DESC LIMIT 1').get() as { id: string };
  db.prepare("UPDATE wa_tasks SET status = 'executing' WHERE id = ?").run(newest.id);
  replies.length = 0;
  await send('u-run', '撤回');
  eq((db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(newest.id) as { status: string }).status, 'executing',
    'C7h ★已在跑的任务不被撤销（状态原样）');
  ok((replies[0] ?? '').includes('已经开始执行'), 'C7i 如实拒绝并指路（不假装撤销）', replies.join(' | '));
}

function sectionW(): void {
  const bar = readSrc(`${A}/renderer/src/components/NextActionBar.tsx`);
  ok(/import type \{ NextAction, NextActionId \} from '\.\.\/\.\.\/\.\.\/src\/main\/core\/next-action\.js'/.test(bar),
    'W-1 第一行组件从 core 取类型（不在这里另立一套形状）');
  ok(bar.includes('data-next-action={action.key}'), 'W-2 组件把 key 挂到 DOM 上（断言与目视都能对上）');
  ok(!/nextActionFor(Project|Task|Deliverables|Models|Settings)\(/.test(bar),
    'W-3 ★组件零判据：不在渲染层再调派生函数（优先级只在 core 一处）');

  const proj = readSrc(`${A}/renderer/src/pages/ProjectDetailPage.tsx`);
  ok(/import \{ nextActionForProject, type NextActionId \}/.test(proj), 'W-4 项目详情引同一份派生');
  eq((proj.match(/<NextActionBar /g) ?? []).length, 1, 'W-5 项目详情恰一处第一行');
  ok(proj.includes("'tasks:actionNeeded'") && !/FROM\s+wa_tasks/i.test(proj),
    'W-6 「等你回复/失败」复用全局账 tasks:actionNeeded（不新写 SQL）');
  ok(/it\.kind === 'await_input'/.test(proj) && /it\.kind === 'failed'/.test(proj),
    'W-7 两类件按账上的 kind 分说');
  ok(!/project\.awaiting/.test(proj),
    'W-8 ★反证：页面不自己写优先级键（键只在 core 里出现）');
  ok(/const projectNextAction = nextActionForProject\(\{/.test(proj), 'W-9 项目详情把事实喂给派生（接线那一跳按语句形状钉）');

  const task = readSrc(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  ok(/import \{ nextActionForTask, type NextActionId \}/.test(task), 'W-10 任务详情引同一份派生');
  eq((task.match(/<NextActionBar /g) ?? []).length, 1, 'W-11 任务详情恰一处第一行');
  ok(/depState: depInfo\.total > 0 \? depInfo\.state : 'met'/.test(task),
    'W-12 ★无前置 ⇒ met（"没有前置"不得被当成"前置未满足"）');
  ok(/progressAgeMs: ageMsOf\(lastProgressAt, nowTick\)/.test(task),
    'W-13 卡住时长复用既有换算（不在这里另写距离计算）');
  ok(!/key: 'task\./.test(task), 'W-14 ★反证：页面不自己写优先级键');
  ok(!/key: 'project\./.test(proj), 'W-15 ★反证：项目页同样不写优先级键');

  // ★GUI 目视照出的白屏根因（2026-11-11）：渲染层 import 了 `core/task-jobs.ts`，而它连带
  //   `core/logger.ts` 在模块求值期读 `process.env` ⇒ 渲染进程无 `process` ⇒ 任务详情整页白屏。
  //   判据搬到零依赖 `status-terms.ts`，这里双向钉住：渲染层不许再引 task-jobs；新模块确实零依赖。
  const statusTerms = readSrc(`${A}/src/main/core/status-terms.ts`);
  ok(!/^\s*import\s/m.test(statusTerms), 'W-19 `status-terms.ts` 零依赖（不引 logger/electron 等任何东西）');
  ok(statusTerms.includes('TERMINAL_STATUSES') && statusTerms.includes('export function isTerminalStatus'),
    'W-20 终态词表与判据真身在新模块');
  const taskJobs = readSrc(`${A}/src/main/core/task-jobs.ts`);
  ok(/import \{ TERMINAL_STATUSES, isTerminalStatus \} from '\.\/status-terms\.js'/.test(taskJobs)
    && /export \{ TERMINAL_STATUSES, isTerminalStatus \}/.test(taskJobs),
    'W-21 `task-jobs.ts` 原样转出（main 侧 40 处调用点不动）');
  // 渲染层全量反证：任何人再引 task-jobs 就会把白屏带回来
  const rendererFiles = fs.readdirSync(path.join(root, A, 'renderer/src'), { recursive: true })
    .filter((f): f is string => typeof f === 'string' && (f.endsWith('.ts') || f.endsWith('.tsx')));
  const offenders = rendererFiles.filter((f) => readSrc(`${A}/renderer/src/${f}`).includes('core/task-jobs'));
  eq(offenders, [], 'W-22 ★渲染层零处 import `core/task-jobs`（引它 = 白屏）');

  // 五页各恰一处，且都从 core 取派生（零重复实现）
  for (const [file, fn] of [
    ['pages/DeliverablesPage.tsx', 'nextActionForDeliverables'],
    ['pages/ModelsPage.tsx', 'nextActionForModels'],
    ['pages/SettingsPage.tsx', 'nextActionForSettings'],
  ] as const) {
    const src = readSrc(`${A}/renderer/src/${file}`);
    eq((src.match(/<NextActionBar /g) ?? []).length, 1, `W-16 ${file} 恰一处第一行`);
    ok(src.includes(`import { ${fn}, type NextActionId } from`), `W-17 ${file} 引同一份派生`);
    ok(!/key: '(project|task|deliverable|model|settings)\./.test(src), `W-18 ${file} 不写优先级键（★反证）`);
  }
}

async function main(): Promise<void> {
  sectionA();

  console.log('\n【B】产出物关注计数 / 模型 / 设置');
  sectionB();

  console.log('\n【C】IM 回执自证与撤销');
  sectionC();
  await sectionC2();

  console.log('\n【W】接线');
  sectionW();

  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

  console.log(`\n[rr_zx_20261111_3_next_action] ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error('\nrr_zx_20261111_3_next_action 未捕获异常（复跑未跑完，不得读作通过）：', e);
  console.log(`\n[rr_zx_20261111_3_next_action] ${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
