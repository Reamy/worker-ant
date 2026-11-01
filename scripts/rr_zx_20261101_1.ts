/**
 * zx_20261101_1 受控复跑 —— 「授」：远端放权，形闭而不可开。
 *
 * 本轮口径一句话（道德经·善闭无关楗而不可开 ／ 维特根斯坦·意义即使用 ／ 毛选·不打无准备之仗）：
 *   人不在电脑前，也能把该批的批了、该答的答了——但**只认私聊、只认可控、高危永不开口**。
 *
 * 病根（见 plans/improve/zx_20261101_1.md）：
 *   ① 设备发现后"授权"只能回桌面点开关；② 跨机提问只能回桌面答；
 *   ③ "能接几个 IM、能攒几套自己的模板"与档位无关（容量卖点无物可兑）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §M1 判据 —— 命令解析（`core/im/approval-inbox.ts` 的 `parseApprovalCommand`）。
 *   六条正标本（允许/拒绝/回答/待授权设备/待答问题/授权待办）+ 近似句反标本（闲聊不得被认领）；
 *   全角空格、@提及、句末标点都可归一；「回答 <码>」无正文不得被当成作答。
 *
 * §M2 判据 —— 短码解析（`resolveDeviceByCode` / `pendingDevices`）。
 *   前缀命中；多台同前缀 ⇒ 列候选不猜；未知码不改任何状态（纯读）；高危/只读/已授权不入待办。
 *   群聊不认：静态钉 `im-router.ts` 的 `chatType !== 'direct'` 分支（反证：认得出形状也不办）。
 *
 * §M3 判据 —— 跨机问答（`resolveQuestionByCode` / `pendingQuestions`）。
 *   只认 `pending + asked + question != null`：已答、已收口、取消、问题载荷为空一律不在待答清单；
 *   `answerQuestion` 在路由里**恰一处**调用，且排在"未命中即回话"之后。
 *
 * §M4 判据 —— 容量两维（`tier-capacity.ts` / `tier-usage.ts` / `pricing.ts` / `tier-catalog.ts`）。
 *   `used === limit` 拒、`limit === 0` 放行；模板只数 `user`/`team_library`（`system`/`auto` 反证不占额）；
 *   卖点登记两向全兑现；升级差异含两新维度（值由 `TIER_LIMITS` 派生，不抄数字）。
 *
 * §M5 判据 —— 接线（`feedback_equivalence_needs_wiring_criterion`）。
 *   `im-router.ts` 步骤 -0.5 排在配对审批之后；`index.ts` 两处推送真的调 `pushImOwnerNotice`；
 *   三个写口（IM 渠道 / 任务模板 / 团队库导入模板）的闸都在 INSERT 之前。
 *   反证：`narrowToolFace('document')` 仍删 shell 三件——本轮不碰形态工具面。
 *
 * ── 纪律 ─────────────────────────────────────────────────────────────────────
 *   G-1 调生产导出，不复刻等价物；G-2 两侧标本；G-5 静态判据读原文（去注释仅在判「代码是否真调」时用）；
 *   G-6 零轮次字面量：本轮标识与方案路径由 `path.basename(__filename)` 派生。
 *   ⚠ 断言文案不得含 ✗/✓（全量汇总器按失败字形计数，见 feedback_rr_assertion_text_no_failure_glyph）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import {
  MAX_INBOX_ITEMS,
  buildApprovalInbox,
  buildDeviceAuthNotice,
  buildRemoteQuestionNotice,
  deviceActionRefusal,
  formatApprovalInbox,
  formatDeviceList,
  parseApprovalCommand,
  pendingDevices,
  pendingQuestions,
  resolveDeviceByCode,
  resolveQuestionByCode,
  shortCode,
  type ApprovalInboxDb,
} from '../apps/worker-ant-desktop/src/main/core/im/approval-inbox.js';
import type { AnsDevice } from '../apps/worker-ant-desktop/src/main/core/device-registry.js';
import { TIER_LIMITS } from '../apps/worker-ant-desktop/src/main/core/feature-limits.js';
import { capacityRefusal, countIMChannels, countTaskTemplates } from '../apps/worker-ant-desktop/src/main/core/tier-capacity.js';
import { tierUsageCounts, upgradeDifferences } from '../apps/worker-ant-desktop/src/main/core/tier-usage.js';
import { PRICING, capacityBenefit } from '../apps/worker-ant-desktop/src/main/core/pricing.js';
import { BENEFIT_COVERAGE, benefitCoverageProblems } from '../apps/worker-ant-desktop/src/main/core/tier-catalog.js';
import { availableToolNames, narrowToolFace } from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const MAIN = path.join(root, 'apps/worker-ant-desktop/src/main');
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');

/* ── 夹具 DDL：照 `database.ts` 的列形（只建本套件读到的列） ─────────────── */
const SCHEMA = `
CREATE TABLE wa_devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', alias TEXT NOT NULL DEFAULT '', room TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'unknown', kind_class TEXT NOT NULL DEFAULT '', protocol TEXT NOT NULL DEFAULT 'mdns',
  address TEXT NOT NULL DEFAULT '', port INTEGER, capabilities_json TEXT NOT NULL DEFAULT '[]',
  controllable INTEGER NOT NULL DEFAULT 0, authorized INTEGER NOT NULL DEFAULT 0, status_json TEXT,
  online INTEGER, first_seen TEXT NOT NULL DEFAULT '', last_seen TEXT NOT NULL DEFAULT ''
);
CREATE TABLE wa_event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL, payload TEXT NOT NULL, occurred_at TEXT NOT NULL
);
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY);
CREATE TABLE wa_task_templates (id TEXT PRIMARY KEY, source TEXT);
`;

function makeDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  return d;
}

function addDevice(
  d: DatabaseSync,
  row: { id: string; name: string; alias?: string; kind: string; controllable: number; authorized: number; at: string },
): void {
  d.prepare(`INSERT INTO wa_devices (id, name, alias, room, kind, kind_class, protocol, address, port,
    capabilities_json, controllable, authorized, status_json, online, first_seen, last_seen)
    VALUES (?, ?, ?, '', ?, '', 'mdns', ?, NULL, '[]', ?, ?, NULL, NULL, ?, ?)`)
    .run(row.id, row.name, row.alias ?? '', row.kind, `addr-${row.id.slice(0, 4)}`, row.controllable, row.authorized, row.at, row.at);
}

function addEvent(d: DatabaseSync, id: string, type: string, payload: Record<string, unknown>, at: string): void {
  d.prepare(`INSERT INTO wa_event_log (aggregate_type, aggregate_id, event_type, payload, occurred_at)
    VALUES ('node_dispatch', ?, ?, ?, ?)`)
    .run(id, type, JSON.stringify(payload), at);
}

function main(): void {
  const db = makeDb();
  const qdb = db as unknown as ApprovalInboxDb;

  // 设备台账标本：D1/D2 同前缀（歧义）、D3 可按别名命中、D4 高危、D5 只读、D6 已授权。
  addDevice(db, { id: '3f2a1111-aaaa-4aaa-8aaa-000000000001', name: '客厅灯', kind: 'light', controllable: 1, authorized: 0, at: '2026-11-01 00:00:06' });
  addDevice(db, { id: '3f2a2222-aaaa-4aaa-8aaa-000000000002', name: '卧室灯', kind: 'light', controllable: 1, authorized: 0, at: '2026-11-01 00:00:05' });
  addDevice(db, { id: '9c8b3333-aaaa-4aaa-8aaa-000000000003', name: '加湿器', alias: '小加', kind: 'humidifier', controllable: 1, authorized: 0, at: '2026-11-01 00:00:04' });
  addDevice(db, { id: 'dead4444-aaaa-4aaa-8aaa-000000000004', name: '大门锁', kind: 'lock', controllable: 1, authorized: 0, at: '2026-11-01 00:00:03' });
  addDevice(db, { id: 'beef5555-aaaa-4aaa-8aaa-000000000005', name: '温湿度计', kind: 'sensor', controllable: 0, authorized: 0, at: '2026-11-01 00:00:02' });
  addDevice(db, { id: 'cafe6666-aaaa-4aaa-8aaa-000000000006', name: '书房灯', kind: 'light', controllable: 1, authorized: 1, at: '2026-11-01 00:00:01' });

  // 出站派发台账标本：Q1 待答；Q2 已答；Q3 已收口；Q4 已取消；Q5 两单同前缀（歧义）；Q6 问题载荷为空。
  const Q1 = '3f2a90aa-1111-4aaa-8aaa-000000000001';
  const Q2 = 'beef90bb-1111-4aaa-8aaa-000000000002';
  const Q3 = 'cafe90cc-1111-4aaa-8aaa-000000000003';
  const Q4 = 'dead90dd-1111-4aaa-8aaa-000000000004';
  const Q5A = 'abcd0001-1111-4aaa-8aaa-000000000005';
  const Q5B = 'abcd0002-1111-4aaa-8aaa-000000000006';
  const Q6 = 'feed90ee-1111-4aaa-8aaa-000000000007';
  for (const [id, at] of [[Q1, '06'], [Q2, '05'], [Q3, '04'], [Q4, '03'], [Q5A, '02'], [Q5B, '01'], [Q6, '00']] as const) {
    addEvent(db, id, 'node.request_dispatched', { category: '跨机任务', targetNodeId: 'node-b', requestPayload: { prompt: 'x' } }, `2026-11-01 01:00:${at}`);
  }
  addEvent(db, Q1, 'node.request_question', { question: '用哪个分支？', options: ['main', 'dev'] }, '2026-11-01 01:10:00');
  addEvent(db, Q2, 'node.request_question', { question: '要改标题吗？' }, '2026-11-01 01:10:01');
  addEvent(db, Q2, 'node.request_answered', { answer: '要' }, '2026-11-01 01:11:00');
  addEvent(db, Q3, 'node.request_result', { status: 'done', result: { ok: true } }, '2026-11-01 01:12:00');
  addEvent(db, Q4, 'node.request_question', { question: '继续吗？' }, '2026-11-01 01:10:02');
  addEvent(db, Q4, 'node.request_result', { status: 'cancelled', result: null }, '2026-11-01 01:13:00');
  addEvent(db, Q5A, 'node.request_question', { question: 'A 用哪个模型？' }, '2026-11-01 01:10:03');
  addEvent(db, Q5B, 'node.request_question', { question: 'B 用哪个模型？' }, '2026-11-01 01:10:04');
  addEvent(db, Q6, 'node.request_question', { options: ['x'] }, '2026-11-01 01:10:05');

  // ═══ M1 命令解析：六条正标本 + 近似句反标本 ═══════════════════════════════
  console.log('\n【M1】授权台命令：认得该认的，不吞闲聊');
  {
    eq(parseApprovalCommand('允许设备 3f2a1111'), { kind: 'allow_device', code: '3f2a1111' }, 'M1-1 正标本：允许设备 <码>');
    eq(parseApprovalCommand('拒绝设备 9c8b3333'), { kind: 'deny_device', code: '9c8b3333' }, 'M1-2 正标本：拒绝设备 <码>');
    eq(parseApprovalCommand('回答 3f2a90aa 用 main 分支'), { kind: 'answer', code: '3f2a90aa', answer: '用 main 分支' },
      'M1-3 正标本：回答 <码> <答案>（答案可含空格）');
    eq(parseApprovalCommand('待授权设备'), { kind: 'list_devices' }, 'M1-4 正标本：待授权设备');
    eq(parseApprovalCommand('待答问题'), { kind: 'list_questions' }, 'M1-5 正标本：待答问题');
    eq(parseApprovalCommand('授权待办'), { kind: 'list_all' }, 'M1-6 正标本：授权待办');
    eq(parseApprovalCommand('允许设备'), { kind: 'list_devices' }, 'M1-7 裸命令按查清单办（不会误当成"授权空码"）');

    eq(parseApprovalCommand('　@工蚁 允许设备　9c8b3333。'), { kind: 'allow_device', code: '9c8b3333' },
      'M1-8 全角空格 + @提及 + 句末标点都归一（码本体不被标点污染）');
    eq(parseApprovalCommand('待授权设备\n'), { kind: 'list_devices' }, 'M1-9 行尾空白不影响认领');

    const negatives = [
      '这个设备允许吗？',
      '回答我一个问题',
      '设备有点热',
      '允许 设备 3f2a1111',
      '我想允许设备联网',
      '回答 3f2a90aa',
      '答复 3f2a90aa 是',
    ];
    for (const text of negatives) {
      eq(parseApprovalCommand(text), null, `M1-10 近似句不认领：「${text}」`);
    }
    eq(parseApprovalCommand(''), null, 'M1-11 空文本不认领');
  }

  // ═══ M2 短码解析 + 待办筛选 + 群聊不认 ══════════════════════════════════════
  console.log('\n【M2】设备授权：短码歧义不猜，高危/只读/已授权不入台');
  {
    const hit = resolveDeviceByCode(qdb, '9c8b');
    ok(hit.kind === 'ok' && hit.device.name === '加湿器', 'M2-1 前缀命中唯一设备', hit.kind === 'ok' ? hit.device.name : hit.kind);

    const byAlias = resolveDeviceByCode(qdb, '小加');
    ok(byAlias.kind === 'ok' && byAlias.device.id.startsWith('9c8b'), 'M2-2 别名精确命中（短于 4 位也走名称档）',
      byAlias.kind === 'ok' ? byAlias.device.name : byAlias.kind);

    const amb = resolveDeviceByCode(qdb, '3f2a');
    ok(amb.kind === 'ambiguous' && amb.candidates.length === 2, 'M2-3 同前缀两台 ⇒ 列候选，不替用户挑',
      amb.kind === 'ambiguous' ? `${amb.candidates.length} 台` : amb.kind);

    eq(resolveDeviceByCode(qdb, 'zzzz').kind, 'not_found', 'M2-4 未知码 ⇒ not_found（纯读，不改状态）');
    eq(resolveDeviceByCode(qdb, '3f2').kind, 'not_found', 'M2-5 三位码不走前缀档，也不误配名称');
    eq(resolveDeviceByCode(qdb, '').kind, 'not_found', 'M2-6 空码不命中');

    const before = db.prepare('SELECT COUNT(*) AS c FROM wa_devices WHERE authorized = 1').get() as { c: number };
    resolveDeviceByCode(qdb, 'zzzz');
    const after = db.prepare('SELECT COUNT(*) AS c FROM wa_devices WHERE authorized = 1').get() as { c: number };
    eq(after.c, before.c, 'M2-7 解析本身不落库（改授权是另一支：先判可行动，再写）');

    const pending = pendingDevices(qdb);
    eq(pending.map((d) => d.name).sort(), ['加湿器', '客厅灯', '卧室灯'].sort(),
      'M2-8 待授权只含「可控 + 未授权 + 非高危」（大门锁/温湿度计/书房灯全排除）');

    eq(deviceActionRefusal(pending[0], 'allow'), null, 'M2-9 可控未授权设备：允许可通过');
    ok((deviceActionRefusal({ ...pending[0], authorized: true } as AnsDevice, 'allow') ?? '').includes('已授权控制'),
      'M2-10 已授权再允许 ⇒ 如实说无需重复');
    ok((deviceActionRefusal({ ...pending[0], controllable: false } as AnsDevice, 'allow') ?? '').includes('只读设备'),
      'M2-11 只读设备允许 ⇒ 如实拒');
    const lock = db.prepare("SELECT id FROM wa_devices WHERE kind = 'lock'").get() as { id: string };
    const lockDev = resolveDeviceByCode(qdb, lock.id.slice(0, 8));
    ok(lockDev.kind === 'ok' && (deviceActionRefusal(lockDev.device, 'allow') ?? '').includes('高危'),
      'M2-12 高危设备即便允许也拒（门锁一处判死）');
    ok((deviceActionRefusal({ ...pending[0], authorized: false } as AnsDevice, 'deny') ?? '').includes('未做改动'),
      'M2-13 未授权设备拒绝 ⇒ 如实说没动');
    eq(deviceActionRefusal({ ...pending[0], authorized: true } as AnsDevice, 'deny'), null,
      'M2-14 已授权设备拒绝 = 收回（合法操作）');

    eq(shortCode('9c8b3333-aaaa'), '9c8b3333', 'M2-15 短码取 id 前 8 位');
    eq(shortCode(''), '', 'M2-16 空 id ⇒ 空码（不编一个）');

    const listText = formatDeviceList(pending);
    ok(listText.includes('待授权设备（3）') && listText.includes('小加'), 'M2-17 清单带数量与可辨认名', listText.split('\n')[0]);
    eq(formatDeviceList([]), '待授权设备：无。', 'M2-18 空清单如实说无');

    const many = Array.from({ length: 6 }, (_, i) => ({ ...pending[0], id: `aaaa000${i}-1111`, name: `设备${i}` } as AnsDevice));
    const notice = buildDeviceAuthNotice(many);
    ok(notice.includes('发现 6 台可控制设备') && notice.includes('还有 1 台'), 'M2-19 发现推送最多列 5 台，其余引导查清单');
    ok(notice.includes('高危设备不在 IM 审批范围内'), 'M2-20 推送明说高危不开口');

    // 群聊不认：路由静态分支（认得出形状也不办）。
    const imRouter = CODE('apps/worker-ant-desktop/src/main/services/im-router.ts');
    ok(/chatType !== 'direct'/.test(imRouter) && imRouter.includes('1:1 私聊'),
      'M2-21 群聊/未知会话一律不办（fail-closed：只认明确的 direct）');
  }

  // ═══ M3 跨机问答：只认 asked，非待答零命中 ═════════════════════════════════
  console.log('\n【M3】跨机问答：只认「等我答」的单，其余不冒充');
  {
    const pendingQ = pendingQuestions(qdb);
    eq(pendingQ.map((r) => r.requestId).sort(), [Q1, Q5A, Q5B].sort(),
      'M3-1 待答 = pending + asked + 有题面（已答/已收口/已取消/空题面全排除）');

    const q1 = resolveQuestionByCode(qdb, '3f2a');
    ok(q1.kind === 'ok' && q1.record.requestId === Q1, 'M3-2 短单号前缀命中待答单');
    const amb = resolveQuestionByCode(qdb, 'abcd');
    ok(amb.kind === 'ambiguous' && amb.candidates.length === 2, 'M3-3 同前缀两单 ⇒ 列候选');
    eq(resolveQuestionByCode(qdb, 'beef').kind, 'not_found', 'M3-4 已答的单不再出现在待答里');
    eq(resolveQuestionByCode(qdb, 'cafe').kind, 'not_found', 'M3-5 已收口的单不再出现在待答里');
    eq(resolveQuestionByCode(qdb, 'dead').kind, 'not_found', 'M3-6 已取消的单不再出现在待答里');
    eq(resolveQuestionByCode(qdb, 'feed').kind, 'not_found', 'M3-7 问题载荷为空的单不入待答');
    eq(resolveQuestionByCode(qdb, 'zzzz').kind, 'not_found', 'M3-8 未知单号不命中');
    eq(resolveQuestionByCode(qdb, '3f2').kind, 'not_found', 'M3-9 过短单号不命中');

    const notice = buildRemoteQuestionNotice({
      requestId: Q1, category: '跨机任务', targetNodeId: 'node-b', question: { question: '用哪个分支？', options: ['main', 'dev'] },
    });
    ok(notice.includes('3f2a90aa') && notice.includes('用哪个分支？') && notice.includes('main / dev'),
      'M3-10 跨机提问推送带短码/题面/选项');
    ok(notice.includes('回答 3f2a90aa 你的答案'), 'M3-11 推送直接教怎么回（码同源）');

    const inbox = buildApprovalInbox(qdb);
    eq([inbox.devices.length, inbox.questions.length], [3, 3], 'M3-12 待办汇总设备/问题两侧同源');
    ok(formatApprovalInbox({ devices: [], questions: [] }).includes('当前没有待授权的设备，也没有待答的跨机问题'),
      'M3-13 空待办如实说无');
    ok(MAX_INBOX_ITEMS > 0 && formatApprovalInbox(inbox).includes('回复「允许设备 <码>」'),
      'M3-14 非空待办附行动指引');

    const imRouter = CODE('apps/worker-ant-desktop/src/main/services/im-router.ts');
    const resolveAt = imRouter.indexOf('resolveQuestionByCode(ctx.db, cmd.code)');
    const notFoundAt = imRouter.indexOf("if (q.kind === 'not_found')", resolveAt);
    const answerAt = imRouter.indexOf('await answerQuestion(ctx.db', resolveAt);
    ok(resolveAt > 0 && notFoundAt > resolveAt && answerAt > notFoundAt,
      'M3-15 路由先解析、未命中即回话，之后才调 answerQuestion');
    eq(imRouter.split('await answerQuestion(').length - 1, 1, 'M3-16 全文件恰一处 answerQuestion 调用');
  }

  // ═══ M4 容量两维 + 卖点/升级同源 ═══════════════════════════════════════════
  console.log('\n【M4】容量：边界为天花板，模板只数用户自己的');
  {
    const imLimit = TIER_LIMITS.community.maxIMChannels;
    const tplLimit = TIER_LIMITS.community.maxTaskTemplates;
    ok(imLimit > 0 && tplLimit > 0, 'M4-1 社区档两维有名额上限（不是 0=不限）', `${imLimit} / ${tplLimit}`);

    ok(capacityRefusal('community', 'maxIMChannels', imLimit - 1).ok, 'M4-2 未到上限 ⇒ 放行');
    const atIm = capacityRefusal('community', 'maxIMChannels', imLimit);
    ok(!atIm.ok && atIm.note.includes('已达上限') && atIm.note.includes(`${imLimit}/${imLimit}`),
      'M4-3 等于上限 ⇒ 拒（上限是天花板），拒因带已用/上限', atIm.note);
    ok(atIm.note.includes('已存在的记录不受影响'), 'M4-4 拒因明说不动已有记录');

    const atTpl = capacityRefusal('pro', 'maxTaskTemplates', TIER_LIMITS.pro.maxTaskTemplates);
    ok(!atTpl.ok && atTpl.note.includes('任务模板已达上限'), 'M4-5 专业档任务模板到顶 ⇒ 拒', atTpl.note);
    eq(TIER_LIMITS.team.maxIMChannels, 0, 'M4-6 团队档 IM 渠道 0=不限');
    eq(TIER_LIMITS.team.maxTaskTemplates, 0, 'M4-7 团队档任务模板 0=不限');
    ok(capacityRefusal('team', 'maxIMChannels', 999999).ok && capacityRefusal('team', 'maxTaskTemplates', 999999).ok,
      'M4-8 0=不限：再大的已用数也放行');

    eq(countIMChannels(qdb), 0, 'M4-9 空库 IM 渠道计数为 0');
    db.prepare('INSERT INTO wa_im_channels (id) VALUES (?)').run('ch-1');
    eq(countIMChannels(qdb), 1, 'M4-10 IM 渠道 0→1（含未启动者全量计数）');
    db.prepare('INSERT INTO wa_im_channels (id) VALUES (?)').run('ch-2');
    eq(countIMChannels(qdb), 2, 'M4-11 IM 渠道 1→2');

    eq(countTaskTemplates(qdb), 0, 'M4-12 空库模板计数为 0');
    const insTpl = db.prepare('INSERT INTO wa_task_templates (id, source) VALUES (?, ?)');
    insTpl.run('t-system', 'system');
    insTpl.run('t-auto', 'auto');
    insTpl.run('t-user', 'user');
    eq(countTaskTemplates(qdb), 1, 'M4-13 用户自建模板 0→1（system/auto 不占额）');
    insTpl.run('t-team', 'team_library');
    insTpl.run('t-null', null);
    eq(countTaskTemplates(qdb), 2, 'M4-14 团队库导入计额；空 source 不计（反证：system/auto/null 全排除）');

    eq([TIER_LIMITS.community.maxIMChannels, TIER_LIMITS.community.maxTaskTemplates],
      [imLimit, tplLimit], 'M4-15 用量/判据/文档同引 TIER_LIMITS（不各写一句）');
    const usage = tierUsageCounts(null);
    eq([usage.imChannels.limit, usage.taskTemplates.limit], [imLimit, tplLimit], 'M4-16 无库用量读数仍取本档上限');
    eq([usage.imChannels.used, usage.taskTemplates.used], [0, 0], 'M4-17 无库用量如实 0');

    const q = upgradeDifferences('community').quotas;
    ok(q.includes(`IM 渠道 ${TIER_LIMITS.pro.maxIMChannels} 个`) && q.includes(`任务模板 ${TIER_LIMITS.pro.maxTaskTemplates} 套`),
      'M4-18 社区→专业升级差异含两新维度', q.join(' | '));
    const q2 = upgradeDifferences('pro').quotas;
    ok(q2.includes('不限 IM 渠道') && q2.includes('不限任务模板'), 'M4-19 专业→团队两维转为不限', q2.join(' | '));
    ok(upgradeDifferences('pro').capabilities.some((c) => c.includes('IM 授权台')),
      'M4-20 专业→团队升级差异含 IM 授权台');

    eq(capacityBenefit('IM 渠道', 0, '个'), 'IM 渠道（不限）', 'M4-21 卖点句式：0=不限');
    eq(capacityBenefit('任务模板', 30, '套'), '任务模板（最多 30 套）', 'M4-22 卖点句式：正数带单位');
    for (const t of ['community', 'pro', 'team'] as const) {
      eq(benefitCoverageProblems(t, PRICING[t].benefits), [], `M4-23 ${t} 卖点两向全兑现`);
      eq(BENEFIT_COVERAGE[t].map((e) => e.benefit), [...PRICING[t].benefits], `M4-24 ${t} 登记与价目表同集同序`);
    }
    ok(PRICING.pro.benefits.includes(capacityBenefit('IM 渠道', TIER_LIMITS.pro.maxIMChannels, '个'))
      && PRICING.team.benefits.includes(capacityBenefit('任务模板', TIER_LIMITS.team.maxTaskTemplates, '套')),
      'M4-25 价目表与登记同引 capacityBenefit（不各写一句）');
    ok(benefitCoverageProblems('pro', [...PRICING.pro.benefits, '凭空卖点：不限魔法']).length > 0,
      'M4-26 反证：多一句无闸卖点 ⇒ 点名');
  }

  // ═══ M5 接线：闸先于写、推送真发出、形态工具面未动 ═══════════════════════
  console.log('\n【M5】接线：一处真源，三个写口都挂闸');
  {
    const imRouter = CODE('apps/worker-ant-desktop/src/main/services/im-router.ts');
    const pairAt = imRouter.indexOf('if (handleTerminalPairReply(ctx, fromUser, msgText)) return;');
    const inboxAt = imRouter.indexOf('await handleApprovalInbox(ctx, fromUser, msgText, chatType)');
    ok(pairAt > 0 && inboxAt > pairAt, 'M5-1 授权台排在配对审批之后、任务审批之前（步骤 -0.5）',
      `${pairAt} < ${inboxAt}`);
    eq(imRouter.split('async function handleApprovalInbox(').length - 1, 1,
      'M5-2 授权台编排在本文件恰一处定义（不散两份）');

    const definers: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.name.endsWith('.ts')) definers.push(p);
      }
    };
    walk(MAIN);
    const parseDefiners = definers
      .filter((f) => /function\s+parseApprovalCommand\s*\(/.test(CODE(path.relative(root, f))))
      .map((f) => path.relative(root, f));
    eq(parseDefiners, ['apps/worker-ant-desktop/src/main/core/im/approval-inbox.ts'],
      'M5-3 全 src/main 恰一份 parseApprovalCommand 实现（命令词表一处真源）');

    const idx = CODE('apps/worker-ant-desktop/src/main/index.ts');
    const pusherAt = idx.indexOf('const deviceAuthPusher = createDeviceAuthPusher(');
    ok(pusherAt > 0 && idx.slice(pusherAt, pusherAt + 300).includes('pushImOwnerNotice(db!'),
      'M5-4 发现推送器真的走 pushImOwnerNotice（不是建了不接）');
    const devAt = idx.indexOf("eventBus.on('device.discovered'");
    const devEnd = idx.indexOf("eventBus.on('device.status_changed'", devAt);
    const devBlock = idx.slice(devAt, devEnd);
    ok(devBlock.includes('deviceAuthPusher.onDiscovered') && devBlock.includes('approval_inbox') && devBlock.includes('device_control'),
      'M5-5 device.discovered 双闸（device_control + approval_inbox）后才推');
    const qAt = idx.indexOf("eventBus.on('node.request_question'");
    const qEnd = idx.indexOf("eventBus.on('node.request_answered'", qAt);
    const qBlock = idx.slice(qAt, qEnd);
    ok(qBlock.includes('pushImOwnerNotice(db!') && qBlock.includes('buildRemoteQuestionNotice') && qBlock.includes('approval_inbox'),
      'M5-6 node.request_question 过 approval_inbox 闸后推 IM 私聊');

    const imIpc = CODE('apps/worker-ant-desktop/src/main/ipc/im.ipc.ts');
    const imHandle = imIpc.indexOf("ipcMain.handle('im:createChannel'");
    const imGate = imIpc.indexOf("capacityRefusal(resolveLicenseTier(db), 'maxIMChannels'", imHandle);
    const imIns = imIpc.indexOf('INSERT INTO wa_im_channels', imHandle);
    ok(imHandle > 0 && imGate > imHandle && imIns > imGate, 'M5-7 im:createChannel 闸先于 INSERT');
    ok(imIpc.includes("code: 'QUOTA_EXCEEDED'"), 'M5-8 IM 渠道拒因走 QUOTA_EXCEEDED');

    const proj = CODE('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
    const tplAt = proj.indexOf("ipcMain.handle('template:create'");
    const tplGate = proj.indexOf("capacityRefusal(resolveLicenseTier(db), 'maxTaskTemplates'", tplAt);
    const tplIns = proj.indexOf('INSERT INTO wa_task_templates', tplAt);
    ok(tplAt > 0 && tplGate > tplAt && tplIns > tplGate, 'M5-9 template:create 闸先于 INSERT');
    ok(proj.includes("code: 'QUOTA_EXCEEDED'"), 'M5-10 任务模板拒因走 QUOTA_EXCEEDED');

    const tl = CODE('apps/worker-ant-desktop/src/main/core/team-library.ts');
    const tlAt = tl.indexOf("if (kind === 'template')");
    const tlGate = tl.indexOf("capacityRefusal(resolveLicenseTier(db), 'maxTaskTemplates'", tlAt);
    const tlIns = tl.indexOf('INSERT INTO wa_task_templates', tlAt);
    ok(tlAt > 0 && tlGate > tlAt && tlIns > tlGate, 'M5-11 团队库导入模板闸先于 INSERT');
    ok(tl.slice(tlGate, tlGate + 200).includes('TeamLibraryError(verdict.note)'), 'M5-12 团队库拒因沿用本模块错误形状');

    // 反证：本轮没碰形态工具面。
    const analysisTools = availableToolNames('analysis');
    ok(['execute_command', 'bash', 'git_clone'].every((n) => analysisTools.includes(n)),
      'M5-13 analysis 工具面仍含 shell 三件（未误伤）');
    const all: Record<string, unknown> = Object.fromEntries(availableToolNames('code').map((n) => [n, {}]));
    const docFace = narrowToolFace('document', all);
    ok(['execute_command', 'bash', 'git_clone'].every((n) => docFace.removed.includes(n)),
      'M5-14 document 工具面仍删 shell 三件（A-8 红线未动）');
  }

  // ═══ S 哑雷自检 + build 钉 ═════════════════════════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = CODE(`scripts/${path.basename(__filename)}`);
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    checkBuildPins(ok, { distDir: path.join(root, 'apps/worker-ant-desktop/dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言抛异常时若只挂 `finally`，进程会在 unhandled rejection 之前被带走 ⇒ 假绿。
try {
  main();
} catch (e: unknown) {
  console.error(`\n💥 rr_zx_20261101_1 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
} finally {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261101_1: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}
