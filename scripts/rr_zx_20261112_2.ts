/**
 * zx_20261112_2「派·识·安·数·档·面」——协同真派 / IM 认得准 / 设备先问在线 / 用量账对账 / 档位差得开 / 项目详情一屏清。
 *
 * 判据分组（随批次逐步补齐）：
 *   S「基」构建钉 P1–P6 + 本轮方案在册与四条拍板口径。
 *   A「派」任务级外派判据、参与恢复、策略三态、派发结局上屏、真 E2E 证据。
 *   B「识」问候白名单、标题脚手架、@项目/@岗位歧义、任务名澄清、LLM 补漏、置信度一把尺。
 *   C「安」设备在线前置、可控通道分档、终端配对私聊闸与审计。
 *   D「数」模型用量名字→id 归一、幂等回填、两本账计数、embedding 计数、质量账上包。
 *   E「档」档位数字零改与商业文档对码。
 *   F「面」项目详情首屏摘要、动作唯一化、失败可见。
 *
 * 纪律：
 *   - 夹具自建 DDL（不跑 initDatabase），顺序按生产初始化；
 *   - 文案断言只钉关键子串，不钉整句；
 *   - 不写「只为下一轮」的字面量；轮次钉由 checkBuildPins 从真源派生；
 *   - 断言文案禁含失败字形（汇总器按字形计数）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import {
  CREATE_DISPATCH_REASON_LABEL,
  REPO_BOUND_TOKENS,
  decideAutoDispatchPolicy,
  decideCreateDispatch,
  mergeDispatchDecision,
  taskNeedsLocalWorkspace,
  type CreateDispatchFacts,
} from '../apps/worker-ant-desktop/src/main/core/collab-dispatch.js';
import { NODE_SETTING_KEYS } from '../apps/worker-ant-desktop/src/main/core/node-identity.js';
import { restoreLicenseParticipation, shouldRestoreLicenseParticipation } from '../apps/worker-ant-desktop/src/main/core/node-heartbeat.js';
import { GREETING_PATTERNS, decideImIntent } from '../apps/worker-ant-desktop/src/main/core/im-intent.js';
import { classifyImText } from '../apps/worker-ant-desktop/src/main/core/im-intent-rules.js';
import { splitTaskInput } from '../apps/worker-ant-desktop/src/main/core/im/task-input.js';
import { parseTaskPauseResume } from '../apps/worker-ant-desktop/src/main/services/im-commands.js';
import { positionMentionRefusalText, resolvePositionMention } from '../apps/worker-ant-desktop/src/main/core/position-mention.js';
import {
  POSITIONS_DDL,
  seedBuiltinPositions,
  setPositionEnabled,
  setProjectPositionEnabled,
} from '../apps/worker-ant-desktop/src/main/core/positions.js';
import { deviceControlVerdict } from '../apps/worker-ant-desktop/src/main/core/device-registry.js';
import { DEVICE_CONTROL_CHANNEL_LABEL, deviceControlChannel } from '../apps/worker-ant-desktop/src/main/core/device-transport.js';
import { backfillModelRefs, callCountOf, resolveModelId } from '../apps/ans-server/src/services/model-ref.js';
import { TIER_LIMITS } from '../apps/worker-ant-desktop/src/main/core/feature-limits.js';
import { PRO_FEATURES, PRO_FEATURE_LABEL } from '../apps/worker-ant-desktop/src/main/core/pro-gate.js';
import { TEAM_FEATURES, TEAM_FEATURE_LABEL } from '../apps/worker-ant-desktop/src/main/core/team-gate.js';

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
const codeOf = (rel: string): string => stripKeepingLines(readSrc(rel)).join('\n');

function sectionS(): void {
  console.log('\n【S】构建钉与本轮方案');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

  const selfRound = path.basename(__filename, '.ts').replace(/^rr_/, '');
  const plan = readSrc(`plans/improve/${selfRound}.md`);
  ok(plan.includes(selfRound), 'S1 本轮方案在册且带轮次名');
  // 四条拍板口径是本轮的范围护栏：若被删，说明范围漂移了（不钉整句，只钉关键短语）。
  ok(plan.includes('判据下沉任务级') && plan.includes('设备侧只做「安全与说清」'),
    'S2 方案记下外派判据下沉与设备侧范围（防实施时漂移）');
  ok(plan.includes('暂无经 ANS 记账的调用') && plan.includes('embedding 只报次数'),
    'S3 方案记下用量账缺口与 embedding 计数口径');
}

// ── 以下分组随 B1–B6 逐批填充；B0 只保证入口在册、收尾账可被汇总器读到 ──
async function sectionA(): Promise<void> {
  console.log('\n【A】B1「派」任务级判据 / 参与恢复 / 策略三态 / 结局上屏');

  // A：任务级工作目录判据——先假设需要，只有证据充分才放行。
  eq(taskNeedsLocalWorkspace({ projectHasWorkingDir: false, category: 'code', title: '修复登录' }), false,
    'A-01 项目无工作目录 ⇒ 判据不适用（不因它拒派）');
  eq(taskNeedsLocalWorkspace({ projectHasWorkingDir: true, category: 'research', title: '调研一下主流向量库的选型' }), false,
    'A-02 纯调研且题面无仓库信号 ⇒ 不需要本机目录');
  eq(taskNeedsLocalWorkspace({ projectHasWorkingDir: true, category: 'code', title: '修复登录超时并提交 PR' }), true,
    'A-03 代码类 ⇒ 需要本机目录');
  eq(taskNeedsLocalWorkspace({ projectHasWorkingDir: true, category: 'research', title: '分析这个代码库的依赖风险' }), true,
    'A-04 research 但题面含「代码库」⇒ 仍需本机目录（类目不是唯一证据）');
  eq(taskNeedsLocalWorkspace({ projectHasWorkingDir: true, category: 'text', title: '写一份周报' }), true,
    'A-05 文本类 ⇒ 仍按需要本机目录（可能写 docs/）');
  eq(taskNeedsLocalWorkspace({ projectHasWorkingDir: true, category: 'research', title: '调研向量库', hasAttachments: true }), true,
    'A-06 有附件 ⇒ 留本机');
  ok(REPO_BOUND_TOKENS.length > 0 && REPO_BOUND_TOKENS.every((re) => re instanceof RegExp),
    'A-07 仓库信号词表是一组正则（可直引、可扩展）');

  const baseFacts: CreateDispatchFacts = {
    settingOn: true, autoDispatchSource: 'explicit', localHasFreeSlot: false,
    teamUnlocked: true, enrolled: true, hasDependencies: false,
    hasAttachments: false, decomposed: false, category: 'research',
  };
  const newDecision = decideCreateDispatch({ ...baseFacts, needsLocalWorkspace: false, hasWorkingDir: true });
  eq({ eligible: newDecision.eligible, reason: newDecision.reason }, { eligible: true, reason: 'eligible' },
    'A-08 任务级判 false 时，项目有工作目录也能派');
  const legacyDecision = decideCreateDispatch({ ...baseFacts, hasWorkingDir: true });
  eq(legacyDecision.reason, 'has-working-dir',
    'A-09 旧调用方只传 hasWorkingDir ⇒ 行为与旧版一致（兼容不漂）');
  const codeDecision = decideCreateDispatch({ ...baseFacts, needsLocalWorkspace: true });
  eq(codeDecision.reason, 'has-working-dir', 'A-10 任务级判 true ⇒ 仍拒（理由不变）');
  ok(CREATE_DISPATCH_REASON_LABEL['has-working-dir'].includes('本机工作目录'),
    'A-11 理由人话点名「本机工作目录」（不是只说"有目录"）');

  // B：参与态来由与恢复。
  eq(NODE_SETTING_KEYS.participateOffReason, 'node.participate_off_reason', 'A-12 参与来由键名只此一处');
  const hbSrc = codeOf(`${A}/src/main/core/node-heartbeat.ts`);
  ok(hbSrc.includes("participateOffReason, 'license'") && hbSrc.includes('restoreLicenseParticipation'),
    'A-13 许可关记 license，并提供恢复路径');
  const ipcSrc = codeOf(`${A}/src/main/ipc/nodes.ipc.ts`);
  ok(ipcSrc.includes("node.participate ? '' : 'user'"), 'A-14 用户手关记 user（永不自动恢复）');
  // 恢复判据不能拿 `effectiveNodeParticipate` 当第三项（它自身含 participate!=='0'，合取恒假）。
  eq([
    shouldRestoreLicenseParticipation({ participate: '0', offReason: 'license', teamUnlocked: true }),
    shouldRestoreLicenseParticipation({ participate: '0', offReason: null, teamUnlocked: true }),
    shouldRestoreLicenseParticipation({ participate: '0', offReason: 'user', teamUnlocked: true }),
    shouldRestoreLicenseParticipation({ participate: '0', offReason: 'license', teamUnlocked: false }),
    shouldRestoreLicenseParticipation({ participate: '1', offReason: 'license', teamUnlocked: true }),
  ], [true, false, false, false, false],
    'A-14b 只在「值 0 ∧ 来由 license ∧ 许可解锁」时恢复；真库现存无来由的 0 不被翻');
  const hbFn = codeOf(`${A}/src/main/core/node-heartbeat.ts`);
  ok(hbFn.includes('shouldRestoreLicenseParticipation({') && !hbFn.includes('participate === \'0\' && offReason === \'license\' && effectiveNodeParticipate'),
    'A-14c 对账路用的是纯判据，不是恒假的旧合取');
  const licIpc = codeOf(`${A}/src/main/ipc/license.ipc.ts`);
  ok(licIpc.includes('reconcileNodeParticipation'), 'A-14d 许可激活成功后触发一次参与回补（不等下次启动）');

  function memDb(rows: Record<string, string>): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    // 与生产同列：`writeNodeSetting` 的 upsert 会写 `updated_at`（少一列 ⇒ 写入静默失败、断言假红）。
    db.exec('CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
    for (const [k, v] of Object.entries(rows)) db.prepare('INSERT INTO wa_settings(key, value) VALUES (?, ?)').run(k, v);
    return db;
  }
  const baseRows = {
    'node.id': 'n-test', 'node.participate': '0', 'node.participate_off_reason': 'license',
    ans_server_url: 'http://127.0.0.1:27183', ans_api_key: 'k', ans_secret_key: 's',
  };

  // A-15：许可恢复 ⇒ 本地恢复参与，且 ANS 收到 participate=true。
  {
    const db = memDb(baseRows);
    const calls: Array<Record<string, unknown>> = [];
    const fake = (async (_c: unknown, _p: string, opts: { body?: Record<string, unknown> }) => {
      calls.push(opts?.body ?? {});
      return { ok: true, response: { json: async () => ({}) } } as never;
    }) as never;
    const r = await restoreLicenseParticipation(db as never, { request: fake });
    ok(r.changed === true && r.note === 'restored', 'A-15 许可恢复 ⇒ 参与回补（changed/restored）', JSON.stringify(r));
    const part = db.prepare("SELECT value FROM wa_settings WHERE key = 'node.participate'").get() as { value?: string };
    const reason = db.prepare("SELECT value FROM wa_settings WHERE key = 'node.participate_off_reason'").get() as { value?: string };
    eq({ p: part?.value, r: reason?.value }, { p: '1', r: '' }, 'A-16 回补后本地值为 1、来由清空');
    eq(calls.length >= 1 && calls[0]!.participate === true, true, 'A-17 回补真 PATCH 到 ANS（participate=true）');
  }

  // A-18：PATCH 期间用户手关 ⇒ 不覆盖用户意志，并纠正 ANS。
  {
    const db = memDb(baseRows);
    const calls: Array<Record<string, unknown>> = [];
    let first = true;
    const fake = (async (_c: unknown, _p: string, opts: { body?: Record<string, unknown> }) => {
      calls.push(opts?.body ?? {});
      if (first) {
        first = false;
        db.prepare("UPDATE wa_settings SET value = 'user' WHERE key = 'node.participate_off_reason'").run();
      }
      return { ok: true, response: { json: async () => ({}) } } as never;
    }) as never;
    const r = await restoreLicenseParticipation(db as never, { request: fake });
    const part = db.prepare("SELECT value FROM wa_settings WHERE key = 'node.participate'").get() as { value?: string };
    eq({ changed: r.changed, note: r.note, p: part?.value }, { changed: false, note: 'user-changed', p: '0' },
      'A-18 用户中途手关 ⇒ 不回补、本地仍为 0');
    eq(calls.map((c) => c.participate), [true, false], 'A-19 并发改动 ⇒ 再发一次纠正 PATCH（false）');
  }

  // C：三态策略语义（同一纯函数）。
  eq(decideAutoDispatchPolicy({ raw: '0', teamUnlocked: true, enrolled: true }).enabled, false, 'A-20 显式 0 ⇒ 关');
  eq(decideAutoDispatchPolicy({ raw: '1', teamUnlocked: true, enrolled: true }).source, 'explicit', 'A-21 显式 1 ⇒ 总是外派');
  eq(decideAutoDispatchPolicy({ raw: '', teamUnlocked: true, enrolled: true }).source, 'default', 'A-22 空串 ⇒ 缺省（满负荷才溢出）');
  eq(decideAutoDispatchPolicy({ raw: '', teamUnlocked: false, enrolled: true }).enabled, false, 'A-23 非团队档 ⇒ 缺省不开');
  ok(ipcSrc.includes("mode === 'default'") && ipcSrc.includes("mode === 'always'"),
    'A-24 写口接受三态 mode（旧 enabled 布尔仍认）');
  const peersSrc = codeOf(`${A}/renderer/src/pages/PeersPage.tsx`);
  ok(peersSrc.includes('满负荷才外派') && peersSrc.includes('总是外派') && peersSrc.includes('worker 只接不分'),
    'A-25 面板给出三态切换与四项前置条件（角色说清）');

  // D：结局合并只动一个键。
  {
    const raw = JSON.stringify({ attachments: [{ path: '/a' }], goal: 'x', dispatch_decision: null });
    const { json, parsed } = mergeDispatchDecision(raw, { attempted: true, ok: false, reason: 'no-peer', at: 'T' });
    const o = JSON.parse(json) as Record<string, unknown>;
    eq(parsed, true, 'A-26 合法 JSON ⇒ parsed=true');
    eq([o.attachments, o.goal], [[{ path: '/a' }], 'x'], 'A-27 兄弟键逐字节保留（附件/目标）');
    eq((o.dispatch_decision as Record<string, unknown>).reason, 'no-peer', 'A-28 只覆盖 dispatch_decision');
    ok(!('_parse_error' in o), 'A-29 合法输入不写 _parse_error');
  }
  {
    const { parsed, json } = mergeDispatchDecision('not-json', { attempted: false, ok: false, reason: 'x', at: 'T' });
    const o = JSON.parse(json) as Record<string, unknown>;
    eq({ parsed, err: o._parse_error }, { parsed: false, err: true }, 'A-30 坏 JSON ⇒ 如实标 _parse_error');
  }
  {
    const { parsed, json } = mergeDispatchDecision(null, { attempted: false, ok: false, reason: 'x', at: 'T' });
    const o = JSON.parse(json) as Record<string, unknown>;
    eq({ parsed, keys: Object.keys(o).sort() }, { parsed: true, keys: ['dispatch_decision'] }, 'A-31 空上下文 ⇒ 只起一个键，不谎称解析');
  }

  // E：接线静态钉（端到端对齐：建单写账 → task:get 解析 → 任务详情上屏）。
  const projSrc = codeOf(`${A}/src/main/ipc/project.ipc.ts`);
  ok(projSrc.includes('persistDispatchDecision(db, id, dispatchOutcome)'), 'A-32 建单路径落派发结局');
  ok(projSrc.includes('dispatchDecision,') && projSrc.includes('CREATE_DISPATCH_REASON_LABEL'),
    'A-33 task:get 解析并回传 dispatchDecision（含人话 label）');
  const tdSrc = codeOf(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  ok(tdSrc.includes('派发结局') && tdSrc.includes('dispatchDecision'),
    'A-34 任务详情上屏派发结局（已派/未派/外派未成）');
  ok(tdSrc.includes('留在本机：') && tdSrc.includes('外派未成：'), 'A-35 未派与外派失败分别说清');
}
function sectionB(): void {
  console.log('\n【B】B2「识」问候白名单 / 标题脚手架 / 岗位认领 / 歧义澄清 / LLM 补漏');

  // A：三字问候不再吞指令。
  ok(GREETING_PATTERNS.every((re) => !re.test('查一下') && !re.test('没搞定') && !re.test('删了吧')),
    'B-01 「查一下」「没搞定」「删了吧」不再算问候');
  ok(GREETING_PATTERNS.some((re) => re.test('你好') && re.test('谢谢') && re.test('收到')),
    'B-02 明确客套话仍算问候');
  eq([decideImIntent({ text: '查一下' }).route, decideImIntent({ text: '没搞定' }).route], ['ambiguous', 'ambiguous'],
    'B-03 三字短句走澄清，不早退成问候');
  eq(decideImIntent({ text: '你好' }).route, 'greeting', 'B-04 真问候仍走问候');

  // B：标题脚手架（长词优先 + 量词可选）。
  eq(splitTaskInput('创建一个任务：写周报').title, '写周报', 'B-05 「创建一个任务：写周报」标题为「写周报」');
  eq(splitTaskInput('新建任务 修复登录').title, '修复登录', 'B-06 「新建任务 修复登录」标题正确');
  eq(splitTaskInput('帮我做 周报').title, '周报', 'B-07 「帮我做 周报」标题正确');
  eq(splitTaskInput('创建任务：复核Y1摘要，输出差异 @demo-weekly').title, '复核Y1摘要',
    'B-08 旧形状（创建任务：…）逐字不变');

  // C：非句首暂停/继续（旧判据漏掉的危险形状）。
  eq(parseTaskPauseResume('把刚才那个任务暂停'), { action: 'pause', query: '' },
    'B-09 「把刚才那个任务暂停」认出来（问句里没有名字 ⇒ 空 query 让用户选）');
  eq(parseTaskPauseResume('那个任务继续'), { action: 'resume', query: '' },
    'B-10 「那个任务继续」认出来');
  eq(parseTaskPauseResume('暂停 写周报'), { action: 'pause', query: '写周报' },
    'B-11 句首暂停 + 任务名仍按旧形状解析');
  eq(parseTaskPauseResume('我要继续'), null, 'B-12 裸「我要继续」不算指令（仍可作在途任务的回复）');

  // D：@岗位（精确名 / 停用 / 未在本项目启用 / 不存在）。
  const db = new DatabaseSync(':memory:');
  db.exec(POSITIONS_DDL);
  seedBuiltinPositions(db as never);
  eq(resolvePositionMention(db as never, '财务', '').kind, 'ok', 'B-13 精确岗位名 ⇒ ok');
  eq(resolvePositionMention(db as never, '财务部', '').kind, 'none', 'B-14 不做模糊匹配（财务部 ≠ 财务）');
  setPositionEnabled(db as never, 'pos_finance', false);
  eq(resolvePositionMention(db as never, '财务', '').kind, 'disabled', 'B-15 岗位停用 ⇒ disabled');
  ok(positionMentionRefusalText({ kind: 'disabled', id: 'x', name: '财务' }).includes('启用'),
    'B-16 停用话术给可行动下一步');
  setPositionEnabled(db as never, 'pos_finance', true);
  eq(resolvePositionMention(db as never, '财务', 'p-1').kind, 'not-in-project',
    'B-17 项目未启用 ⇒ not-in-project（不是静默丢）');
  setProjectPositionEnabled(db as never, 'p-1', 'pos_finance', true);
  eq(resolvePositionMention(db as never, '财务', 'p-1').kind, 'ok', 'B-18 项目启用后可预绑');

  // E：接线静态钉（路由确实接上了，而不是只建了模块）。
  const routerSrc = codeOf(`${A}/src/main/services/im-router.ts`);
  ok(routerSrc.includes('resolvePositionMention') && routerSrc.includes('position_id, context_json'),
    'B-19 IM 建单接上岗位解析并落 position_id');
  ok(routerSrc.includes('没找到项目「') && routerSrc.includes('classifyImText(msgText).kind === \'create\''),
    'B-20 @项目 0 命中先澄清，强建单才新建');
  ok(routerSrc.includes("json_extract(context_json,'$.externalUser') = ?") && routerSrc.includes('ORDER BY datetime(updated_at) DESC, rowid DESC LIMIT 5'),
    'B-21 「开始+任务名」按本用户作用域 + 最近更新取前 5，不再全库盲选');
  ok(routerSrc.includes('buildDisambiguation(\'resume\'') && routerSrc.includes('disambiguationPrompt(\'resume\''),
    'B-22 多命中复用 5 分钟编号澄清');
  ok(routerSrc.includes('auxModelRequest()') && !routerSrc.includes("excludeCapabilities: ['reasoning']"),
    'B-23 意图分类走辅助路唯一档（排除 reasoning 由 auxModelRequest 一处定义，路由不手写）');
  ok(routerSrc.includes('buildLlmContext') && routerSrc.includes('上一条消息'),
    'B-24 补漏提示带最小上下文（项目/任务/上一条）');
  ok(routerSrc.includes('理解服务暂时不可用'), 'B-25 模型失败与「没听懂」话术分开');
  ok(routerSrc.includes('暂停|停下|继续|恢复|取消|撤销|撤回'), 'B-26 指令样表补上暂停/继续/撤销族');
  eq('confidence' in classifyImText('创建任务'), false, 'B-27 数值置信那把死尺已收掉（只剩 high/medium/low）');
}
function sectionC(): void {
  console.log('\n【C】B3「安」设备在线前置 / 传动分档 / 终端审批收口');

  const dev = (over: Record<string, unknown>) => ({
    id: 'd1', name: '客厅台灯', kind: 'light', protocol: 'mqtt', address: '10.0.0.2', port: 1883,
    controllable: true, authorized: true, online: true, capabilities: [], ...over,
  } as never);

  eq(deviceControlVerdict(dev({ online: false })), {
    ok: false, reason: 'offline',
    how: '「客厅台灯」当前不在线（设备/平台上报为离线）。请确认供电与网络；设备恢复上报后状态会自动变为在线，再重试。',
  }, 'C-01 在线为 false ⇒ 拒绝并给下一步');
  eq(deviceControlVerdict(dev({ online: null })).ok, true, 'C-02 在线未知（null）⇒ 不拦（未知不等于离线）');
  eq(deviceControlVerdict(dev({ online: true })).ok, true, 'C-03 在线且已授权 ⇒ 放行');
  eq(deviceControlVerdict(dev({ online: false, kind: 'lock' })).reason, 'high_risk',
    'C-04 高危仍先于离线拒（门锁即便离线也只说高危）');
  eq(deviceControlVerdict(dev({ online: false, controllable: false })).reason, 'not_controllable',
    'C-05 自述不可控先于离线');
  eq(deviceControlVerdict(dev({ online: false, authorized: false })).reason, 'offline',
    'C-06 离线先于未授权（不让用户白授权）');

  eq(deviceControlChannel({ protocol: 'mqtt' }), 'mqtt', 'C-07 MQTT 传动');
  eq(deviceControlChannel({ protocol: 'miio' }), 'miio', 'C-08 miIO 传动');
  eq(deviceControlChannel({ protocol: 'cloud' }), 'cloud', 'C-09 云端传动');
  eq(deviceControlChannel({ protocol: 'mdns' }), 'http', 'C-10 mDNS 发现只能回退通用 HTTP（如实）');
  eq(deviceControlChannel({ protocol: 'ssdp' }), 'http', 'C-11 SSDP 同上');
  eq(deviceControlChannel({ protocol: '' }), 'none', 'C-12 无协议 ⇒ none');
  ok(DEVICE_CONTROL_CHANNEL_LABEL.none.includes('仅发现') && DEVICE_CONTROL_CHANNEL_LABEL.http.includes('成功率'),
    'C-13 文案如实：仅发现 / HTTP 成功率取决于设备');

  const routerSrc = codeOf(`${A}/src/main/services/im-router.ts`);
  ok(routerSrc.includes("if (chatType !== 'direct')") && routerSrc.includes('终端接入审批只在'),
    'C-14 终端配对补私聊闸（群聊不办）');
  ok(routerSrc.includes('pairAttemptRefusal') && routerSrc.includes('PAIR_ATTEMPT_MAX = 5'),
    'C-15 终端配对尝试限流（10 分钟 5 次）');
  ok(routerSrc.includes("action: 'terminal.approve'") && routerSrc.includes("action: 'terminal.reject'"),
    'C-16 终端配对放行/拒绝都留审计');
  const devIpc = codeOf(`${A}/src/main/ipc/devices.ipc.ts`);
  ok(devIpc.includes('recordAudit') && devIpc.includes("action: authorized ? 'device.authorize' : 'device.revoke'"),
    'C-17 GUI 设备授权补审计（与 IM 台同一把尺）');
  const devicesPage = codeOf(`${A}/renderer/src/pages/DevicesPage.tsx`);
  ok(devicesPage.includes('deviceControlChannel(dev)') && devicesPage.includes('仅发现'),
    'C-18 设备行显示本机传动；无传动写「仅发现」');
}
function sectionD(): void {
  console.log('\n【D】B4「数」用量账：名字 → 唯一 id / 幂等回填 / 两本账计数 / embedding 与质量账');

  const adb = new DatabaseSync(':memory:');
  adb.exec('CREATE TABLE ans_ai_models (id TEXT PRIMARY KEY, name TEXT)');
  adb.exec('CREATE TABLE ans_billing_records (model_id TEXT)');
  adb.exec('CREATE TABLE ans_model_quality_logs (model_id TEXT)');
  const insModel = adb.prepare('INSERT INTO ans_ai_models (id, name) VALUES (?, ?)');
  insModel.run('uuid-1', 'qwen3.5:9b');
  insModel.run('deepseek-v4-flash', 'deepseek-v4-flash');
  insModel.run('dup-a', '同名模型');
  insModel.run('dup-b', '同名模型');
  const insB = adb.prepare('INSERT INTO ans_billing_records (model_id) VALUES (?)');
  for (const v of ['qwen3.5:9b', 'qwen3.5:9b', 'deepseek-v4-flash', 'uuid-1', 'gone-model']) insB.run(v);
  adb.prepare('INSERT INTO ans_model_quality_logs (model_id) VALUES (?)').run('qwen3.5:9b');

  eq(resolveModelId(adb as never, 'qwen3.5:9b'), 'uuid-1', 'D-01 名字唯一命中 ⇒ 换成该 id');
  eq(resolveModelId(adb as never, 'uuid-1'), 'uuid-1', 'D-02 已是现有 id ⇒ 原样');
  eq(resolveModelId(adb as never, 'deepseek-v4-flash'), 'deepseek-v4-flash', 'D-03 id 恰好等于名字 ⇒ 原样（不误换）');
  eq(resolveModelId(adb as never, '同名模型'), '同名模型', 'D-04 同名多模型 ⇒ 不猜，保留原值');
  eq(resolveModelId(adb as never, 'gone-model'), 'gone-model', 'D-05 无同名模型 ⇒ 保留孤儿账');
  eq(resolveModelId(adb as never, ''), '', 'D-06 空引用 ⇒ 空');

  const count = (table: string, id: string) => (adb.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE model_id = ?`).get(id) as { c: number }).c;
  eq([count('ans_billing_records', 'qwen3.5:9b'), count('ans_billing_records', 'uuid-1')], [2, 1], 'D-07 回填前：2 条按名字 + 1 条按 id');
  backfillModelRefs(adb as never);
  eq([count('ans_billing_records', 'qwen3.5:9b'), count('ans_billing_records', 'uuid-1')], [0, 3], 'D-08 回填后：全部归到 uuid-1');
  eq([count('ans_model_quality_logs', 'uuid-1'), count('ans_billing_records', 'gone-model')], [1, 1],
    'D-09 质量账同样归位；孤儿行原样保留');
  const before = (adb.prepare('SELECT COUNT(*) AS c FROM ans_billing_records WHERE model_id = ?').get('uuid-1') as { c: number }).c;
  backfillModelRefs(adb as never);
  eq((adb.prepare('SELECT COUNT(*) AS c FROM ans_billing_records WHERE model_id = ?').get('uuid-1') as { c: number }).c, before,
    'D-10 回填幂等（第二次跑不再改任何行）');

  eq([callCountOf(0, 23), callCountOf(2, 3), callCountOf(-1, 4), callCountOf(3, 1)], [23, 3, 4, 3],
    'D-11 调用数 = 两账取较大者（不双计；桌面只写计费 / 两份都写 / 只质量三种形态都对）');

  const billingSrc = readSrc('apps/ans-server/src/routes/billing.ts');
  eq((billingSrc.match(/resolveModelId\(db, body\.model_id\)/g) || []).length, 2,
    'D-12 两条记账写口（records/quality）都走归一');
  ok(readSrc('apps/ans-server/src/db/schema.ts').includes('backfillModelRefs(db)'), 'D-13 启动迁移调用回填');
  const modelsSrc = readSrc('apps/ans-server/src/routes/models.ts');
  eq((modelsSrc.match(/callCountOf\(/g) || []).length, 2, 'D-14 模型页与供应商页同一计数口径');
  ok(modelsSrc.includes('qualityCount > 0'), 'D-15 质量分只在有质量行时算（不把「没评过」算成 0 分）');
  ok(codeOf(`${A}/renderer/src/pages/ModelsPage.tsx`).includes('暂无经 ANS 记账的调用'),
    'D-16 空数据文案不说成「没使用」');
  ok(codeOf(`${A}/src/main/core/memory-manager.ts`).includes("endpoint_id: 'memory-embed'"),
    'D-17 embedding 成功调用只报次数');
  ok(codeOf(`${A}/src/main/core/exec-step.ts`).includes("'/api/v1/billing/quality'"),
    'D-18 桌面每步补质量账（供选型学习）');
}
function sectionE(): void {
  console.log('\n【E】B5「档」价格与上限零改 / 协同旗舰口径 / 商业文档');

  eq({ community: TIER_LIMITS.community.maxNodes, pro: TIER_LIMITS.pro.maxNodes, team: TIER_LIMITS.team.maxNodes },
    { community: 1, pro: 1, team: 20 }, 'E-01 协同节点上限逐档不变（1 / 1 / 20）');
  eq({ pro: TIER_LIMITS.pro.maxProjectConcurrency, team: TIER_LIMITS.team.maxProjectConcurrency },
    { pro: 8, team: 16 }, 'E-02 并发数字不变');
  // zx_20261113_1 B6 新增 Pro 键 `position_transfer`——原「项数不变」是只为当轮成立的字面量。
  //   按更强形状重定向：键不重复、每个键都有人话名（新增一项不必回来改数字，但漏名会红）。
  ok(new Set(PRO_FEATURES).size === PRO_FEATURES.length, 'E-03a Pro 能力键不重复');
  ok(new Set(TEAM_FEATURES).size === TEAM_FEATURES.length, 'E-03b Team 能力键不重复');
  ok(PRO_FEATURES.every((k) => (PRO_FEATURE_LABEL[k] ?? '').trim().length > 0), 'E-03c 每个 Pro 键有人话名');
  ok(TEAM_FEATURES.every((k) => (TEAM_FEATURE_LABEL[k] ?? '').trim().length > 0), 'E-03d 每个 Team 键有人话名');

  const lic = readSrc('business-plan/license-tiers.md');
  ok(lic.includes('### 2.22') && lic.includes('价格与上限数字零改') && lic.includes('协同旗舰从「有闸」到「有真链路」'),
    'E-04 档位文档 §2.22 在册且写明数字零改');
  ok(lic.includes('只有**本机双节点**E2E') && lic.includes('远端仓库同步'),
    'E-05 档位文档写明诚实边界（无双真机、无远端仓库同步）');
  const biz = readSrc('business-plan/plans/biz_20261022.md');
  ok(biz.includes('## §19 「派·识·安·数」那一刀') && biz.includes('可核对口径') && biz.includes('诚实边界'),
    'E-06 商业方案 §19 在册（一句话 / 可核对 / 诚实边界 / 真源）');
  const peers = codeOf(`${A}/renderer/src/pages/PeersPage.tsx`);
  ok(peers.includes('不需要本机工作目录') && peers.includes('任务详情第一屏可见'),
    'E-07 锁定档位的升级页如实写外派范围（不夸成全自动多机）');
}
function sectionF(): void {
  console.log('\n【F】B6「面」项目详情首屏 / 动作唯一化 / 失败可见 / Cron 校验');

  const src = codeOf(`${A}/renderer/src/pages/ProjectDetailPage.tsx`);
  ok(src.includes('进度') && src.includes('未完成') && src.includes('阻塞 {blockers.length}'),
    'F-01 首屏一条「进度 + 风险 + 待办」摘要（阻塞数可直达里程碑）');
  ok(src.includes('更多操作（状态）') && src.includes('<details'),
    'F-02 状态操作收进「更多操作」折叠（主操作不再三处并列）');
  ok(src.includes("window.confirm('确定把项目标记为「完成」吗"),
    'F-03 「完成」是不可逆动作，先确认再执行');
  ok(src.includes('qualityError') && src.includes('headerError') && src.includes('ctxError')
    && src.includes('质量数据读取失败') && src.includes('项目头部刷新失败'),
    'F-04 三处失败如实上屏（不再被 catch 吞成"没有数据"）');
  ok(!src.includes('catch { setQualityStats(null); }'), 'F-05 质量读取不再静默置空（反证旧形状已消失）');
  ok(src.includes('cronValid') && src.includes('Cron 需 5 段') && src.includes('disabled={!cronValid}'),
    'F-06 Cron 五段校验：非法即字段级红字，且不可保存');
  ok(src.includes('NextActionBar'), 'F-07 第一行结论条仍在（上轮成果不因本轮改动丢失）');
}

async function main(): Promise<void> {
  sectionS();
  await sectionA();
  sectionB();
  sectionC();
  sectionD();
  sectionE();
  sectionF();

  console.log(`\n[rr_zx_20261112_2] ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error('\nrr_zx_20261112_2 未捕获异常（复跑未跑完，不得读作通过）：', e);
  console.log(`\n[rr_zx_20261112_2] ${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
