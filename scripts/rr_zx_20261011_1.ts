/**
 * zx_20261011_1 受控复跑 —— C2 挂账三项 + 双向澄清 + IM 收口。
 *
 * 本轮口径一句话（维特根斯坦·意义即使用）：**谁派得起、接得住、问得通、说得清**。
 *
 * 病根（本轮规划 §1）：
 *   M1 C2/M6 —— 「许可闸」此前只管 IPC/工具那一层，**注册上送 ANS 的 `participate` 恒 1** ⇒
 *      锁定的机器照旧进派单候选（闸虚）；且许可**离线过期**后没人把 ANS 侧 `participate` 拉回 0。
 *   M2 C2/M8 —— 回传 `POST /requests/:id/result` **无幂等守卫**：迟到的第二笔回传会覆写终态。
 *   M3 C2/M9 —— **接收侧**有 `isDispatchable` 闸，**派发侧**（提交请求）谁都放行 ⇒ observer 也能派。
 *   M4 双向澄清 —— 只有"派出去-收回结果"一条单向路，B 遇疑问无从问 A。
 *   M5 IM 收口 —— 中转任务收口取"答得到的东西"散在两处（runner 与 IM 适配各一份）。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：判据一律静态导入生产导出（被删/改名即编译期失败）。
 *   G-2 **两侧标本**：凡判"命中/放行"的判据，反面标本（不命中）一并喂。
 *   G-4 **不碰真实网络**：到 ANS 的请求一律**注入假实现**；许可 fixture 注入 `fingerprint` 不采真机。
 *   G-5 静态判据读**原文**（去注释在本仓是静默毁伤）——一律 `RD(...)`。
 *   G-6 **无轮次字面量**：本轮方案路径/脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：判据引用的生产符号**全部静态导入** ⇒ 被删/改名即编译期失败（而非"扫了个空、静默假绿"）。
import { effectiveNodeParticipate, reconcileNodeParticipation } from '../apps/worker-ant-desktop/src/main/core/node-heartbeat.js';
import { NODE_SETTING_KEYS } from '../apps/worker-ant-desktop/src/main/core/node-identity.js';
import type { NodeSettingDb } from '../apps/worker-ant-desktop/src/main/core/node-identity.js';
import type { AnsRequestResult } from '../apps/worker-ant-desktop/src/main/core/ans-signed-request.js';
// M3（C2/M9）：派发侧闸——桌面短路行为 + 三档真值表。
import { answerQuestion, dispatchNodeRequest } from '../apps/worker-ant-desktop/src/main/core/node-dispatcher.js';
// M4（双向澄清）：有界等待的提问器 + 键名/解析器 + 装配注册（G-1 静态导入 ⇒ 删/改名即编译期失败）。
import { askRequester, getRequestAsker, requestIdOf, setRequestAsker, NODE_REQUEST_ID_KEY } from '../apps/worker-ant-desktop/src/main/core/node-clarify.js';
import type { ClarifyIo } from '../apps/worker-ant-desktop/src/main/core/node-clarify.js';
// G-1：`canDispatch` 自**源**导入（运行时值；承仓内其它 rr 引 `shared-types/src/*.js` 的惯例）。
import { canDispatch, NODE_QUESTION_STATUSES } from '../packages/shared-types/src/nodes.js';

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** 等值断言（把实际值一并打出——红的时候要能立刻看出"差在哪"）。 */
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
/** 静态判据读**原文**（G-5：去注释在本仓是静默毁伤）。 */
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''); // zx_20261011_1

/* ── 夹具 ────────────────────────────────────────────────────────────────── */

/** `wa_settings` 单表夹具（`readNodeSetting` / 许可 `readSetting` 的**同一张表**——同库同表）。 */
function settingDb(settings: Record<string, string> = {}): NodeSettingDb {
  const d = new DatabaseSync(':memory:');
  d.exec("CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))");
  for (const [k, v] of Object.entries(settings)) d.prepare('INSERT INTO wa_settings (key,value) VALUES (?,?)').run(k, v);
  return d as unknown as NodeSettingDb;
}

/** 许可**已解锁**的设置：走**试用**支（`kind==='trial'` ⇒ `unlocked`）——无须私钥签一份真许可。 */
function unlockedSettings(extra: Record<string, string> = {}, now: Date = new Date()): Record<string, string> {
  return { 'license.trial_started_at': now.toISOString(), ...extra };
}
/** 许可**锁定**的设置：空表（无 key、无试用）⇒ `kind==='none'`、`tier='community'`。 */
function lockedSettings(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra };
}

/** 固定许可解析选项（G-4：不采真机指纹、不取墙钟——冻结基准时刻）。 */
const NOW = new Date('2026-10-11T00:00:00.000Z');
const LIC_OPTS = { now: NOW, fingerprint: 'RR-FP-0000' };

/** 假请求结果（G-4：受控回归喂假 ⇒ 不碰真实网络）。`new Response` 提供真 `.json()`。 */
const okRes = (body: unknown): AnsRequestResult => ({ ok: true, status: 200, response: new Response(JSON.stringify(body), { status: 200 }), attempts: 1 });
const failRes: AnsRequestResult = { ok: false, status: 503, attempts: 1 };

/** 记录一次注入请求的调用（路径/体/次数）——判"真发了什么"。 */
interface CallCapture { calls: Array<{ path: string; method?: string; body?: unknown }> }
type ReconcileRequest = Parameters<typeof reconcileNodeParticipation>[1] extends { request?: infer R } ? R : never;
function captureRequest(cap: CallCapture, res: AnsRequestResult): NonNullable<ReconcileRequest> {
  return (async (_creds: unknown, p: string, o?: { method?: string; body?: unknown }) => {
    cap.calls.push({ path: p, method: o?.method, body: o?.body });
    return res;
  }) as unknown as NonNullable<ReconcileRequest>;
}

/** 一个**已注册**的节点设置（`node.resource_group === 'node:'+id` ∧ 非占位 `ans_api_key` 是"已注册"真形状）。 */
const ENROLLED = { [NODE_SETTING_KEYS.id]: 'nid-rr', [NODE_SETTING_KEYS.resourceGroup]: 'node:nid-rr', [NODE_SETTING_KEYS.ansApiKey]: 'wa_rr_enrolled_key' };

async function main(): Promise<void> {
  // ═══ A｜`effectiveNodeParticipate` 四态真值表（两侧标本：真/假各造）══════════
  console.log('\n【A】生效参与 = 许可 ∧ 用户设置（管子·度量衡：一把尺量两个因子）');
  {
    eq(effectiveNodeParticipate(settingDb(unlockedSettings()), LIC_OPTS), true,
      'A-1 解锁 ∧ 未设 participate ⇒ **true**（缺省参与，与 ANS 列默认 1 同值）');
    eq(effectiveNodeParticipate(settingDb(unlockedSettings({ [NODE_SETTING_KEYS.participate]: '1' })), LIC_OPTS), true,
      'A-2 解锁 ∧ participate=1 ⇒ true');
    eq(effectiveNodeParticipate(settingDb(unlockedSettings({ [NODE_SETTING_KEYS.participate]: '0' })), LIC_OPTS), false,
      'A-3 ★解锁 ∧ 用户显式关（0）⇒ **false**（用户意志优先，许可不越俎）');
    eq(effectiveNodeParticipate(settingDb(lockedSettings()), LIC_OPTS), false,
      'A-4 ★锁定 ∧ 未设 ⇒ **false**（闸有齿：许可锁即不参与）');
    eq(effectiveNodeParticipate(settingDb(lockedSettings({ [NODE_SETTING_KEYS.participate]: '1' })), LIC_OPTS), false,
      'A-5 ★★**本轮病根标本**：锁定 ∧ 本地仍写着 1 ⇒ **false**（旧实现此处会照发 1 ⇒ 闸虚）');
  }

  // ═══ B｜启动期对账 `reconcileNodeParticipation`（行为两侧 + 真发了什么）══════
  console.log('\n【B】启动对账（老子·知止：不一致就补报，一致则不动）');
  {
    // 未注册 ⇒ 早退，不触网（"参与一个自己没加入的网络"是无意义的）。
    {
      const cap: CallCapture = { calls: [] };
      const r = await reconcileNodeParticipation(settingDb(lockedSettings()), { request: captureRequest(cap, okRes({})), licenseOpts: LIC_OPTS });
      eq([r.changed, r.note, cap.calls.length], [false, 'not-enrolled', 0],
        'B-1 ★未注册 ⇒ `not-enrolled` 且**不发请求**（早早退——报名都没报，谈何退赛）');
    }
    // 已注册 ∧ 本地已关 ⇒ 用户意志，不动。
    {
      const cap: CallCapture = { calls: [] };
      const db = settingDb(lockedSettings({ ...ENROLLED, [NODE_SETTING_KEYS.participate]: '0' }));
      const r = await reconcileNodeParticipation(db, { request: captureRequest(cap, okRes({})), licenseOpts: LIC_OPTS });
      eq([r.changed, r.note, cap.calls.length], [false, 'already-off', 0],
        'B-2 已注册 ∧ 本地已关 ⇒ `already-off` 且**不发请求**（不覆盖用户意志）');
    }
    // 已注册 ∧ 解锁 ⇒ 一致，不动。
    {
      const cap: CallCapture = { calls: [] };
      const r = await reconcileNodeParticipation(settingDb(unlockedSettings(ENROLLED)), { request: captureRequest(cap, okRes({})), licenseOpts: LIC_OPTS });
      eq([r.changed, r.note, cap.calls.length], [false, 'ok', 0],
        'B-3 已注册 ∧ 解锁 ⇒ `ok` 且**不发请求**（一致则不动——省一次无谓往返）');
    }
    // 已注册 ∧ 本地参与 ∧ 锁定 ⇒ 真 PATCH participate:false，成功后镜像本地为 0。
    {
      const cap: CallCapture = { calls: [] };
      const db = settingDb(lockedSettings({ ...ENROLLED, [NODE_SETTING_KEYS.participate]: '1' }));
      const r = await reconcileNodeParticipation(db, { request: captureRequest(cap, okRes({ data: {} })), licenseOpts: LIC_OPTS });
      eq([r.changed, r.note, cap.calls.length], [true, 'ok', 1],
        'B-4 ★★**本轮主路**：已注册 ∧ 参与 ∧ 锁定 ⇒ `changed=true` 且**真发一次**请求');
      eq(cap.calls[0], { path: '/api/v1/nodes/nid-rr', method: 'PATCH', body: { participate: false } },
        'B-5 ★请求形状：`PATCH /api/v1/nodes/<id>`，体 `{participate:false}`（路径取 node_id，非内部 UUID）');
      eq(effectiveNodeParticipate(db, LIC_OPTS), false,
        'B-6 ★★对账后**本地已镜像为关** ⇒ 生效参与 false（下一跳不再重复报，不留抖动）');
    }
    // 失败侧：HTTP 503 ⇒ changed=false、note 带 reconcile-failed、**不镜像本地**（好让下次启动再试）。
    {
      const cap: CallCapture = { calls: [] };
      const db = settingDb(lockedSettings({ ...ENROLLED, [NODE_SETTING_KEYS.participate]: '1' }));
      const r = await reconcileNodeParticipation(db, { request: captureRequest(cap, failRes), licenseOpts: LIC_OPTS });
      ok(r.changed === false && r.note.startsWith('reconcile-failed'),
        'B-7 ★两侧标本：请求失败（503）⇒ `changed=false` + `reconcile-failed`（如实报因，不假装报成功了）', r.note);
      eq([cap.calls.length, effectiveNodeParticipate(db, LIC_OPTS)], [1, false],
        'B-8 失败时**不镜像本地**（本地仍参与、许可仍锁 ⇒ 下次启动会再试一次，而非一失败就当成已对齐）');
    }
    // 注入 request 抛异常 ⇒ 兜底不抛（"永不抛"是启动接线的前提）。
    {
      const r = await reconcileNodeParticipation(
        settingDb(lockedSettings({ ...ENROLLED, [NODE_SETTING_KEYS.participate]: '1' })),
        { request: (async () => { throw new Error('boom'); }) as unknown as NonNullable<ReconcileRequest>, licenseOpts: LIC_OPTS },
      );
      ok(r.changed === false && r.note.includes('boom'),
        'B-9 ★注入请求**抛** ⇒ 兜底不抛、如实记因（启动接线敢 `void` 它，正因它永不抛）', r.note);
    }
  }

  // ═══ C｜接线静态（读原文，G-5）：注册上送 + 启用点 + ANS 落库 ══════════════
  console.log('\n【C】接线（毛泽东·实践论：写下的须真被走到）');
  {
    const HB = RD(`${A}/src/main/core/node-heartbeat.ts`);
    ok(HB.includes('participate: effectiveNodeParticipate(db, opts.licenseOpts)'),
      'C-1 ★★**注册那一刻按生效参与上报**（req 字面量里含 `participate: effectiveNodeParticipate(...)`——否则闸虚）');
    ok(HB.includes('export function effectiveNodeParticipate('),
      'C-2 生效参与是**具名导出**（判据可直跑真实现，非内联两份）');

    const IDX = RD(`${A}/src/main/index.ts`);
    eq((IDX.match(/reconcileNodeParticipation\(db\)/g) ?? []).length, 1,
      'C-3 ★启动期对账**恰一处**（一处真源；多写一处即两处各修各的）');
    ok(/void reconcileNodeParticipation\(db\)/.test(IDX),
      'C-4 ★**不 await**（best-effort——网络不畅不该拖住启动；故只 `void`）');

    const ANS = RD('apps/ans-server/src/routes/nodes.ts');
    ok(ANS.includes('body.participate === false ? 0 : 1'),
      'C-5 ★ANS 注册**真按请求落 participate**（缺省 1 向后兼容；`false` 才落 0）');
    ok(/participate: t\.Optional\(t\.Boolean\(\)\)/.test(ANS),
      'C-6 ANS 注册体 schema 收了 `participate`（缺则被 exact-mirror 挡在体校验外）');

    const ST = RD('packages/shared-types/src/nodes.ts');
    ok(/participate\?: boolean;/.test(ST),
      'C-7 共享登记请求类型含 `participate?`（两侧契约一处真源）');
  }

  // ═══ D｜M2 协议幂等（终态一次；读原文，G-5）══════════════════════════════════
  console.log('\n【D】C2/M8 协议幂等（老子·知止：终态一到，不再被改写）');
  {
    const ANS = RD('apps/ans-server/src/routes/nodes.ts');
    const hIdx = ANS.indexOf("'/requests/:id/result'");
    const hBody = hIdx >= 0 ? ANS.slice(hIdx, ANS.indexOf('.post(', hIdx + 10)) : '';
    ok(hIdx >= 0, 'D-1 回传端点 `POST /requests/:id/result` 在场');
    const forbIdx = hBody.indexOf('is not the target of request');
    const guardIdx = hBody.indexOf("row.status === 'done' || row.status === 'error'");
    ok(guardIdx >= 0, 'D-2 ★终态守卫在册（`row.status === \'done\' || row.status === \'error\'`）');
    ok(forbIdx >= 0 && guardIdx > forbIdx,
      'D-3 ★**双校验先跑、守卫后置**（非目标节点的重复投递仍 403——幂等不越权）',
      `403@${forbIdx} < guard@${guardIdx}`);
    // 守卫块内**不 UPDATE**（原样回既有；否则等于又改写了一次）。
    const guardBlock = guardIdx >= 0 ? hBody.slice(guardIdx, hBody.indexOf('\n          }', guardIdx)) : '';
    ok(guardBlock.length > 0 && !/UPDATE\s+ans_node_requests/.test(guardBlock),
      'D-4 ★守卫块内**无 UPDATE**（原样回 `toNodeRequest(row)`——不多写一笔）');
  }

  // ═══ E｜M3 C2/M9 角色语义（孔子·正名：什么角色，做什么事）════════════════════
  console.log('\n【E】C2/M9 角色语义（派发侧闸：worker 只接不分）');
  {
    eq([canDispatch({ role: 'primary' }), canDispatch({ role: 'worker' }), canDispatch({ role: 'observer' })],
      [true, false, true],
      'E-1 ★★三档真值表：primary 能分 / worker **只接不分** / observer 能分不能接');

    // 假 io（G-4：不碰真网）——记 `submit` 调用次数，判"到底触没触 io"。
    type DispatchDb = Parameters<typeof dispatchNodeRequest>[0];
    type DispatchIo = NonNullable<NonNullable<Parameters<typeof dispatchNodeRequest>[2]>['io']>;
    const mkIo = (): { box: { calls: number }; io: DispatchIo } => {
      const box = { calls: 0 };
      const io = {
        submit: async () => { box.calls++; return {} as never; },
        get: async () => { box.calls++; return {} as never; },
      } as unknown as DispatchIo;
      return { box, io };
    };

    // 反证 worker 只接不分：如实拒 + **不触 io**（本地先短路，省一趟注定 400 的往返）。
    {
      const { box, io } = mkIo();
      const db = settingDb({ ...ENROLLED, [NODE_SETTING_KEYS.role]: 'worker' }) as unknown as DispatchDb;
      const r = await dispatchNodeRequest(db, { category: 'project_task' }, { io, emit: () => undefined });
      ok(r.ok === false && r.note.startsWith('role-cannot-dispatch'),
        'E-2 ★★worker 档派活 ⇒ 如实拒（`role-cannot-dispatch`），结局如实装填', r.note);
      eq(box.calls, 0, 'E-3 ★**短路在提交之前**：io.submit 一次都没被调（不是"先发了再拦"）');
    }
    // 两侧标本：primary 档**真派**（io 恰一次）——否则 E-2 可能只因 io 坏而"绿"。
    {
      const { box, io } = mkIo();
      const db = settingDb({ ...ENROLLED, [NODE_SETTING_KEYS.role]: 'primary' }) as unknown as DispatchDb;
      const r = await dispatchNodeRequest(db, { category: 'project_task' }, { io, emit: () => undefined });
      ok(r.ok === true && box.calls === 1,
        'E-4 ★两侧标本：primary 档**真触 io 一次**（反证 E-2 的短路是角色所致，非 io 坏）', `ok=${r.ok} io=${box.calls}`);
    }
    // 反证 observer 仍可派（只分不接——"接不接"由 ANS 侧 DISPATCHABLE_WHERE 管）。
    {
      const { box, io } = mkIo();
      const db = settingDb({ ...ENROLLED, [NODE_SETTING_KEYS.role]: 'observer' }) as unknown as DispatchDb;
      const r = await dispatchNodeRequest(db, { category: 'project_task' }, { io, emit: () => undefined });
      ok(r.ok === true && box.calls === 1,
        'E-5 ★反证 observer 仍可派（只分不接；"不能接"是选目标时的事，非派发侧）', `ok=${r.ok} io=${box.calls}`);
    }
    // 未设角色 ⇒ 缺省 worker（与 ANS 列默认同值）⇒ 同样拒。
    {
      const { box, io } = mkIo();
      const db = settingDb(ENROLLED) as unknown as DispatchDb;
      const r = await dispatchNodeRequest(db, { category: 'project_task' }, { io, emit: () => undefined });
      ok(r.ok === false && r.note.startsWith('role-cannot-dispatch') && box.calls === 0,
        'E-6 未设角色 ⇒ 缺省 worker ⇒ 同样拒（新机默认只接不分，须先升档才派得出去）', r.note);
    }

    // 接线静态（读原文，G-5）：ANS 侧同源闸 + 桌面侧同源短路 + 判据在共享真源。
    const ANS = RD('apps/ans-server/src/routes/nodes.ts');
    ok(ANS.includes('canDispatch({ role: rrow.role })') && ANS.includes('cannot dispatch'),
      'E-7 ★ANS 侧**同源判据**拦 worker 派发（请求方身份由凭据派生，非请求体自报）');
    const DISP = RD(`${A}/src/main/core/node-dispatcher.ts`);
    ok(DISP.includes('!canDispatch({ role: localRole })'),
      'E-8 ★桌面侧**同源判据**本地先短路（同 `canDispatch`——一个规则一处）');
    const ST = RD('packages/shared-types/src/nodes.ts');
    ok(/export function canDispatch\(node: Pick<AnsNode, 'role'>\): boolean/.test(ST),
      "E-9 判据 `canDispatch` 在共享真源、取 `Pick<AnsNode,'role'>`（不绑具体取数形状）");
  }

  // ═══ F｜M4 双向澄清（维特根斯坦·意义即用法：问得通，才有答）════════════════════
  console.log('\n【F】M4 双向澄清（B 端问得上、A 端答得回、有界等待，退路仍是 M11 自决）');
  {
    // F-1 `requestIdOf`：只认中继任务（`context_json` 的 `node_request_id` 键）；两侧标本。
    eq(requestIdOf(JSON.stringify({ [NODE_REQUEST_ID_KEY]: 'rq-1' })), 'rq-1',
      'F-1a 从中继任务的 `context_json` 读出派单 id');
    eq([requestIdOf('{}'), requestIdOf('not json'), requestIdOf(null), requestIdOf(JSON.stringify({ [NODE_REQUEST_ID_KEY]: '' }))],
      [null, null, null, null],
      'F-1b 非中继任务 / 脏 json / 空串 / 缺值 ⇒ 一律 `null`（不编一个假 id 去撞别人的单）');

    // F-2 有界等待：第一轮就答到 ⇒ 立即返回，不空转。
    {
      const io = { ask: async () => undefined, readAnswer: async () => '答案A' } as unknown as ClarifyIo;
      let sleeps = 0;
      const a = await askRequester('rq-1', { question: 'q' }, { io, now: () => 0, sleep: async () => { sleeps++; } });
      ok(a === '答案A' && sleeps === 0, 'F-2 ★答到即回（不空转时钟/睡眠）', `a=${a} sleeps=${sleeps}`);
    }
    // F-3 有界：一直没答 ⇒ deadline 到即 `null`（睡眠有界，不无限等拖死任务）。
    {
      const io = { ask: async () => undefined, readAnswer: async () => null } as unknown as ClarifyIo;
      let t = 0; let sleeps = 0;
      const a = await askRequester('rq-1', { question: 'q' }, {
        io, timeoutMs: 100, pollMs: 30, now: () => t, sleep: async () => { sleeps++; t += 30; },
      });
      ok(a === null && sleeps > 0 && sleeps <= 5,
        'F-3 ★★一直无作答 ⇒ 有界到 deadline 即 `null`（退回自决，不假装答过）', `a=${a} sleeps=${sleeps}`);
    }
    // F-4 提问即失败 ⇒ 立刻 `null`（永不抛；不进入等待循环）。
    {
      const io = { ask: async () => { throw new Error('boom'); }, readAnswer: async () => 'x' } as unknown as ClarifyIo;
      let sleeps = 0;
      const a = await askRequester('rq-1', { question: 'q' }, { io, now: () => 0, sleep: async () => { sleeps++; } });
      ok(a === null && sleeps === 0, 'F-4 提问失败 ⇒ 立刻 `null`（永不抛；不空等）', `a=${a} sleeps=${sleeps}`);
    }
    // F-5 读答瞬时失败 ⇒ 继续轮询（给网络抖动留一次机会），仍是有界。
    {
      let t = 0; let calls = 0;
      const io = {
        ask: async () => undefined,
        readAnswer: async () => { calls++; if (calls <= 2) throw new Error('flap'); return '迟到答案'; },
      } as unknown as ClarifyIo;
      const a = await askRequester('rq-1', { question: 'q' }, { io, timeoutMs: 1000, pollMs: 10, now: () => t, sleep: async () => { t += 10; } });
      ok(a === '迟到答案', 'F-5 ★读答瞬时失败不当场放弃（继续轮询）——抖过即拿到', `a=${a} calls=${calls}`);
    }
    // F-6 asker 注册往返 + 解除（装配处一处真源）。
    {
      const prev = getRequestAsker();
      setRequestAsker(async () => 'x');
      const on = getRequestAsker() !== null;
      setRequestAsker(null);
      const off = getRequestAsker() === null;
      setRequestAsker(prev);
      ok(on && off, 'F-6 提问器可注册 / 可解除（`setRequestAsker(null)` 即断线——"没接线"≠"问了没人答"）');
    }

    // F-7/F-8 A 端作答核心 `answerQuestion`：未入网短路 + 入网真作答并落账（注入假 io，G-4）。
    {
      type DispatchDb = Parameters<typeof dispatchNodeRequest>[0];
      const emitted: string[] = [];
      let answeredCalls = 0;
      const io = {
        submit: async () => ({} as never),
        get: async () => ({} as never),
        answer: async (id: string, answer: string) => {
          answeredCalls++;
          return { id, category: 'project_task', target_node_id: 't', status: 'assigned', answer: { answer } } as never;
        },
      } as unknown as NonNullable<NonNullable<Parameters<typeof dispatchNodeRequest>[2]>['io']>;
      const emit = (ty: string) => { emitted.push(ty); };
      const rNot = await answerQuestion(settingDb({}) as unknown as DispatchDb, { id: 'rq-1', answer: 'a' }, { io, emit });
      ok(rNot.ok === false && rNot.note === 'not-enrolled' && answeredCalls === 0,
        'F-7 ★未入网 ⇒ 如实拒 `not-enrolled`，且 io.answer 一次未调（没有身份就没有作答凭据）', rNot.note);
      const rOk = await answerQuestion(settingDb({ ...ENROLLED }) as unknown as DispatchDb, { id: 'rq-1', answer: 'a' }, { io, emit });
      ok(rOk.ok === true && answeredCalls === 1 && emitted.includes('node.request_answered'),
        'F-8 ★入网 ⇒ 真作答（io 恰一次）+ 落 `node.request_answered`（A 端台账右半）',
        `ok=${rOk.ok} io=${answeredCalls} emit=${emitted.join('|')}`);
    }

    // ── 接线静态（读原文，G-5）──
    const CTRL = RD(`${A}/src/main/core/tools/control.ts`);
    const askIdx = CTRL.indexOf('getRequestAsker()');
    const refusalIdx = CTRL.indexOf('noInteractionAskRefusal(ctxJson)');
    ok(askIdx >= 0 && refusalIdx > askIdx,
      'F-9 ★★次序即判据：`ask_user` **先问上游**（getRequestAsker）再退 M11 自决（noInteractionAskRefusal）——把"无人可答"与"有答者却不问"分开',
      `asker@${askIdx} < refusal@${refusalIdx}`);
    ok(CTRL.includes('requestIdOf(ctxJson)'),
      'F-10 `ask_user` 由 `context_json` 判"这是不是派来的活"（非中继任务不向上游问）');

    const RUNNER = RD(`${A}/src/main/core/node-request-runner.ts`);
    ok(RUNNER.includes('[NODE_REQUEST_ID_KEY]: req.id'),
      'F-11 ★写口一处真源：中继任务落库时把 `NODE_REQUEST_ID_KEY` 写进 context（键名共享常量，不手抄字符串）');

    const DISP = RD(`${A}/src/main/core/node-dispatcher.ts`);
    ok(/export async function answerQuestion\(/.test(DISP) && DISP.includes("'node.request_question'") && DISP.includes("'node.request_answered'"),
      'F-12 ★A 端作答核心 `answerQuestion` 在册；读回端落 `node.request_question` / `node.request_answered`');
    ok(DISP.includes("!eventAlreadyRecorded(db, request.id, 'node.request_question')")
      && DISP.includes("!eventAlreadyRecorded(db, request.id, 'node.request_answered')"),
      'F-13 ★问答落账**幂等**（面板有界轮询反复读回不重复落）——各按 eventAlreadyRecorded 守卫');

    const EB = RD(`${A}/src/main/core/event-bus.ts`);
    ok(/'node\.request_question': \{ aggregate_type: 'node_dispatch'/.test(EB)
      && /'node\.request_answered': \{ aggregate_type: 'node_dispatch'/.test(EB),
      'F-14 ★两类澄清事件**同属出站聚合 `node_dispatch`**（与 dispatched/result 同一本账）');

    const LOG = RD(`${A}/src/main/core/node-dispatch-log.ts`);
    ok(LOG.includes("'node.request_question', 'node.request_answered'")
      && LOG.includes("rec.questionStatus = 'asked'") && LOG.includes("rec.questionStatus = 'answered'"),
      'F-15 ★出站台账聚合四类事件；问题态分记 `asked` / `answered`（与 `status` 分开——一问一答各留痕）');

    const IPC = RD(`${A}/src/main/ipc/nodes.ipc.ts`);
    ok(IPC.includes("'nodes:answer-question'") && IPC.includes('teamFeatureRefusal(licDb'),
      'F-16 ★作答 IPC 口过 Team 软闸（与派发口径同源）');

    const ST = RD('packages/shared-types/src/nodes.ts');
    eq(NODE_QUESTION_STATUSES.join(','), 'asked,answered', 'F-17 问答状态词表在共享真源（asked/answered）');
    ok(/awaiting_answer/.test(ST), 'F-18 `awaiting_answer` 在共享状态机（可答中间态——工蚁提问后转入）');

    const ANS = RD('apps/ans-server/src/routes/nodes.ts');
    ok(ANS.includes("'/requests/:id/question'") && ANS.includes("'/requests/:id/answer'"),
      'F-19 ★ANS 侧两跳在册：B 端提问 / A 端作答');
    ok(/const byTarget = row\.target_node_id != null/.test(ANS) && ANS.includes('!byNode && !byTarget && !byPrefix'),
      'F-20 ★读回端放行**目标方**（B 端须轮询自己那一单的作答；第三方仍 403——无知之幕不破）');
    ok(ANS.includes("if (row.question_status === 'answered') return { data: toNodeRequest(row) };"),
      'F-21 ★作答幂等：已答的重复作答原样回既有（不覆盖答案、不翻状态）');

    const RIPC = RD(`${A}/renderer/src/lib/ipc.ts`);
    ok(RIPC.includes("'nodes:answer-question'"),
      'F-22 renderer ipc 侧的作答口在册（词表第二落点）');
    const PEERS = RD(`${A}/renderer/src/pages/PeersPage.tsx`);
    ok(PEERS.includes('answerQuestion') && PEERS.includes('QuestionBlock') && PEERS.includes("rec.questionStatus === 'asked'"),
      'F-23 ★派活面板两端 UI：待答块（QuestionBlock）据 questionStatus === \'asked\' 上屏');
  }

  // ═══ S｜哑雷自检 + build 钉（派生核对，不写轮次字面量）══════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 ★方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261011_1: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261011_1 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ rr_zx_20261011_1: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
