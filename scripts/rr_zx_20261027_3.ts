/**
 * zx_20261027_3 受控复跑 —— 「合」：人机各得其位，诸器各显其实。
 *
 * 本套件按批次生长（M1 → M7），每批完成即补对应断言；收口时全量再跑一遍。
 *
 * 纪律（承 auto-memory）：
 *   G-1 用生产函数：M1 排序走真 `rankDispatchCandidates` / `parseCapacity` / `describeNode`；
 *   G-2 两侧标本：已知有余力 / 余力未知 / 已知满负荷 / 非法值；MQTT 跳过 vs 云直查；
 *   G-6 零轮次字面量：本轮标识由 `path.basename(__filename)` 派生，方向性比较；
 *   ⚠ 断言文案不含失败字形（`pnpm rr:all` 按日志字形计数）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import {
  beginNodeRequestRun,
  ensureNodeRequestRunsTable,
  findNodeRequestRun,
  finishNodeRequestRun,
  markNodeRequestRunLost,
  type NodeRequestLedgerDb,
} from '../apps/worker-ant-desktop/src/main/core/node-request-ledger.js';
import { makeRelayRunner, RELAY_PROJECT_NAME } from '../apps/worker-ant-desktop/src/main/core/node-request-runner.js';
import type { AnsNodeRequest } from '@worker-ant/shared-types';
import {
  describeNode,
  parseCapacity,
  rankDispatchCandidates,
  type RankableNode,
} from '../apps/ans-server/src/routes/node-ranking.js';
import {
  livePatchFromProviderState,
  selectStateRefreshTargets,
} from '../apps/worker-ant-desktop/src/main/core/device-state-refresh.js';
import {
  LICENSE_SETTING_KEYS,
  resolveLicenseState,
  type LicenseSettingDb,
} from '../apps/worker-ant-desktop/src/main/core/license.js';
import { TIER_LABEL, TIER_LIMITS } from '../apps/worker-ant-desktop/src/main/core/feature-limits.js';
import { tierCatalog } from '../apps/worker-ant-desktop/src/main/core/tier-catalog.js';
import { proFeatureRefusal } from '../apps/worker-ant-desktop/src/main/core/pro-gate.js';
import { teamFeatureRefusal } from '../apps/worker-ant-desktop/src/main/core/team-gate.js';
import { nodeQuotaCheck } from '../apps/worker-ant-desktop/src/main/core/node-quota.js';
import { upgradeDifferences } from '../apps/worker-ant-desktop/src/main/core/tier-usage.js';
import {
  SELF_EVOLVE_DDL,
  SELF_EVOLVE_MAX_RULE_CHARS,
  SELF_EVOLVE_MAX_RULES,
  SELF_EVOLVE_RULES_KEY,
  buildSelfRulesBlock,
  decideProposal,
  readSelfEvolveRules,
  recordProposal,
} from '../apps/worker-ant-desktop/src/main/core/self-evolve.js';
import {
  CONTEXT_BLOCK_ORDER,
  STABLE_PREFIX_BLOCKS,
  buildTaskContext,
} from '../apps/worker-ant-desktop/src/main/core/exec-context.js';
import {
  AGENT_CARD_FIELDS,
  INBOUND_AGENT_CARD_PATH,
  INBOUND_WELL_KNOWN_PATH,
  buildAgentCard,
  handleInboundRequest,
  resolveAdvertisedUrl,
} from '../apps/worker-ant-desktop/src/main/core/inbound-gate.js';
import {
  DEFAULT_TERMINAL_CAPABILITIES,
  EXTERNAL_CAPABILITIES,
  EXTERNAL_CAPABILITY_LABEL,
  EXTERNAL_CAPABILITY_NOTE,
  TASK_REQUEST_MAX_ACCEPTANCE,
  TASK_REQUEST_MAX_PROMPT,
  createExternalCapabilityPort,
  isInvocableCapability,
  offeredCapabilities,
  type TaskRequestOutcome,
} from '../apps/worker-ant-desktop/src/main/core/external-calls.js';
import {
  CARD_OUTCOME_MIN_SAMPLES,
  CARD_OUTCOME_WEIGHT,
  cardOutcomeStats,
  listKnowledgeCardsWithUsage,
  selectKnowledgeCardsForInject,
  type CardOutcomeStat,
  type KnowledgeCard,
} from '../apps/worker-ant-desktop/src/main/core/knowledge-cards.js';
import {
  buildProjectProfile,
  currentProfileSourceHash,
  insertImportedProfile,
  listProjectProfileHistory,
  readProjectProfile,
  refreshProjectProfileIfEnabled,
  saveProjectProfile,
  setProjectProfileEnabled,
} from '../apps/worker-ant-desktop/src/main/core/project-profile.js';
import { buildMemoryContext } from '../apps/worker-ant-desktop/src/main/core/memory-context.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

/** 本轮标识由载体自身派生（G-6）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');

function node(node_id: string, weight: number, status: Record<string, unknown> | null, seen = '2026-10-27 01:00:00'): RankableNode {
  return { node_id, weight, status_json: status === null ? null : JSON.stringify(status), last_seen_at: seen };
}
const ids = (list: ReadonlyArray<{ nodeId: string }>): string[] => list.map((c) => c.nodeId);

async function main(): Promise<void> {
  // ═══ A｜M1a 派单择机：三层排序（真纯函数，四类标本）════════════════════════════════════════
  console.log('\n【A】M1a 派单择机三层排序');
  {
    // A-1 ★已知余力**优先于**未知：低权重真闲机压过高权重未知机（旧策 COALESCE 1.0 的反面）
    const knownFree = node('n-known', 1, { capacity_free_ratio: 0.1 });
    const unknownHeavy = node('n-unknown', 9, { os: 'x' });
    const r1 = rankDispatchCandidates([unknownHeavy, knownFree]);
    eq(ids(r1), ['n-known', 'n-unknown'], 'A-1 ★已知余力优先于未知（未知不再冒充满血 1.0）');
    eq(r1[0]!.group, 'free', 'A-2 已知余力归 free 层');
    ok(Math.abs(r1[0]!.score - 0.1) < 1e-9, 'A-3 free 层分数=weight×ratio', String(r1[0]!.score));
    eq(r1[1]!.group, 'unknown', 'A-4 缺 capacity_free_ratio 归 unknown 层');
    ok(Math.abs(r1[1]!.score - 9) < 1e-9, 'A-5 unknown 层分数=weight（不乘余力）', String(r1[1]!.score));
  }
  {
    // A-6 ★全未知 ⇒ 按权重降序（未知不被排除，也不受罚）
    const r = rankDispatchCandidates([
      node('n-u1', 2, { os: 'x' }),
      node('n-u2', 7, { os: 'x' }),
      node('n-u3', 5, null),
    ]);
    eq(ids(r), ['n-u2', 'n-u3', 'n-u1'], 'A-6 ★全未知按权重降序');
    ok(r.every((c) => c.group === 'unknown'), 'A-7 三台全归 unknown 层');
  }
  {
    // A-8 ★已知满负荷（ratio=0）恒排最后，哪怕权重最高
    const r = rankDispatchCandidates([
      node('n-full', 100, { capacity_free_ratio: 0 }),
      node('n-unknown', 1, { os: 'x' }),
      node('n-free', 0.5, { capacity_free_ratio: 0.6 }),
    ]);
    eq(ids(r), ['n-free', 'n-unknown', 'n-full'], 'A-8 ★满负荷权重再高也排在未知之后');
    eq(r[2]!.group, 'full', 'A-9 ratio=0 归 full 层（已知满 ≠ 未知）');
  }
  {
    // A-10 ★非法 ratio 按未知处理（脏值不是事实）；合法边界 0/1 各归其层
    const bad = [1.7, -0.2, 42];
    for (const v of bad) {
      eq(parseCapacity(JSON.stringify({ capacity_free_ratio: v })), { ratio: null, freeSlots: null }, `A-10 非法 ratio ${v} ⇒ null`);
    }
    eq(parseCapacity(JSON.stringify({ capacity_free_ratio: '0.5' })).ratio, null, 'A-11 字符串 ratio ⇒ null（不当数字猜）');
    eq(parseCapacity(JSON.stringify({ capacity_free_ratio: 1 })).ratio, 1, 'A-12 边界 1 合法');
    eq(parseCapacity(JSON.stringify({ capacity_free_ratio: 0 })).ratio, 0, 'A-13 边界 0 合法（且非 null）');
    eq(parseCapacity(JSON.stringify({ free_slots: 3.7 })).freeSlots, 3, 'A-14 free_slots 取整');
    eq(parseCapacity(JSON.stringify({ free_slots: -1 })).freeSlots, null, 'A-15 负槽位 ⇒ null');
    eq(parseCapacity('not-json').ratio, null, 'A-16 坏 JSON ⇒ 全未知');
    eq(parseCapacity(null), { ratio: null, freeSlots: null }, 'A-17 null status ⇒ 全未知');
    const r = rankDispatchCandidates([
      node('n-bad', 100, { capacity_free_ratio: 1.7 }),
      node('n-ok', 1, { capacity_free_ratio: 0.3 }),
    ]);
    eq(ids(r), ['n-ok', 'n-bad'], 'A-18 ★非法 ratio 不得凭权重越过合法空闲机');
    eq(r[1]!.group, 'unknown', 'A-19 非法 ratio 归 unknown 层');
  }
  {
    // A-20 层内/层间确定性：分数 → free_slots 降序（null 排在已知之后）→ last_seen 降序 → node_id 升序
    const r = rankDispatchCandidates([
      node('n-b', 1, { capacity_free_ratio: 0.5 }, '2026-10-27 01:00:00'),
      node('n-a', 1, { capacity_free_ratio: 0.5 }, '2026-10-27 01:00:00'),
      node('n-newer', 1, { capacity_free_ratio: 0.5 }, '2026-10-27 02:00:00'),
      node('n-slots', 1, { capacity_free_ratio: 0.5, free_slots: 4 }, '2026-10-27 01:00:00'),
    ]);
    eq(ids(r), ['n-slots', 'n-newer', 'n-a', 'n-b'], 'A-20 ★同分时槽位→新近→id 三级兜底（结果确定）');
  }
  {
    // A-21 快照理由如实；手动目标走同一口径
    const auto = describeNode(node('n-free', 2, { capacity_free_ratio: 0.25, free_slots: 3 }));
    ok(auto.reason.includes('已知余力 25%') && auto.reason.includes('剩余槽位 3') && auto.reason.includes('净收益 2 × 0.25 = 0.50'),
      'A-21 ★自动择机理由含余力/槽位/净收益', auto.reason);
    const unknown = describeNode(node('n-u', 4, null));
    ok(unknown.reason.includes('余力未知（不惩罚）'), 'A-22 未知理由说明"不惩罚"', unknown.reason);
    const full = describeNode(node('n-f', 7, { capacity_free_ratio: 0 }));
    ok(full.reason.includes('已知满负荷') && full.reason.includes('之后'), 'A-23 满负荷理由说明排位次序', full.reason);
  }

  // ═══ B｜M1a 接线与落库（源码形状）══════════════════════════════════════════════════════════
  console.log('\n【B】M1a 接线：路由不再用 SQL 排序，快照落库');
  {
    const nodes = CODE('apps/ans-server/src/routes/nodes.ts');
    ok(nodes.includes("from './node-ranking.js'"), 'B-1 路由导入纯函数模块');
    ok(nodes.includes('rankDispatchCandidates('), 'B-2 ★自动择机走纯函数排序');
    ok(!/capacity_free_ratio/.test(nodes), 'B-3 ★路由源码不再含 capacity_free_ratio（旧 SQL 排序已移除）');
    ok(/INSERT INTO ans_node_requests[\s\S]*selection_json/.test(nodes), 'B-4 ★INSERT 写入 selection_json');
    ok(nodes.includes('手动指定：'), 'B-5 手动目标理由带「手动指定：」前缀（不冒充自动择机）');

    const schema = CODE('apps/ans-server/src/db/schema.ts');
    ok(/ans_node_requests[\s\S]*selection_json TEXT/.test(schema), 'B-6 建表含 selection_json');
    ok(schema.includes('ALTER TABLE ans_node_requests ADD COLUMN selection_json TEXT'),
      'B-7 旧库补列迁移在场（try/ALTER/catch 范式）');
    const types = CODE('packages/shared-types/src/nodes.ts');
    ok(/selection\s*:\s*Record<string, unknown> \| null/.test(types), 'B-8 共享类型暴露 selection');
  }

  // ═══ C｜M1b 设备状态直查（纯函数 + 接线）════════════════════════════════════════════════════
  console.log('\n【C】M1b 设备状态直查');
  {
    const dev = (id: string, protocol: string) => ({ id, name: id, protocol, address: 'x' });
    const sel = selectStateRefreshTargets([
      dev('d-cloud', 'cloud'),
      dev('d-miio', 'miio'),
      dev('d-mqtt', 'mqtt'),
      dev('d-mdns', 'mdns'),
      dev('d-other', 'zzz'),
    ]);
    eq(sel.targets.map((d) => d.id), ['d-cloud', 'd-miio'], 'C-1 ★只直查 cloud / miio');
    eq(sel.skipped.map((d) => d.id), ['d-mqtt', 'd-mdns', 'd-other'], 'C-2 其余逐条登记跳过原因');
    ok(sel.skipped[0]!.reason.includes('已有实时订阅'), 'C-3 ★MQTT 跳过理由指明"已有实时订阅"', sel.skipped[0]!.reason);

    eq(livePatchFromProviderState({ ok: false, error: 'boom' }), null, 'C-4 ★查询失败不写（不抹旧值）');
    eq(livePatchFromProviderState({ ok: false, state: { x: 1 }, unsupported: true }), null, 'C-5 unsupported 不写');
    eq(livePatchFromProviderState({ ok: true, state: [1, 2] }), null, 'C-6 数组态不写（形状非法）');
    const patch = livePatchFromProviderState({ ok: true, state: { power: 'on' } });
    ok(patch !== null && patch.source === 'provider' && patch.attributes.power === 'on',
      'C-7 ★成功写回 source=provider（不冒充上行）');

    const reg = CODE(`${A}/src/main/core/device-registry.ts`);
    ok(reg.includes("source: 'state' | 'attributes' | 'provider'"), 'C-8 live 来源枚举含 provider');
    const diag = CODE(`${A}/src/main/core/device-diagnostics.ts`);
    ok(diag.includes("live.source === 'provider'") && diag.includes('直查 · 云 Provider / 米家 miIO'),
      'C-9 ★面板如实标「直查」来源');
    const ipc = CODE(`${A}/src/main/ipc/devices.ipc.ts`);
    ok(ipc.includes("ipcMain.handle('devices:refresh_states'"), 'C-10 IPC 处理器在册');
    ok(ipc.includes('selectStateRefreshTargets(listDevices(ddb))'), 'C-11 ★同一选择口径（生产函数）');
    ok(ipc.includes('setDeviceLiveState(ddb, dev.id, patch)'), 'C-12 直查结果写回既有 live');
    const rIpc = CODE(`${A}/renderer/src/lib/ipc.ts`);
    ok(rIpc.includes("'devices:refresh_states'"), 'C-13 renderer 包装接线');
    const page = CODE(`${A}/renderer/src/pages/DevicesPage.tsx`);
    ok(page.includes("document.visibilityState === 'visible'"), 'C-14 ★仅页面可见时轮询');
    ok(page.includes('setInterval(') && page.includes('30_000'), 'C-15 轮询周期 30s');
    ok(page.includes('devicesApi.refreshStates()'), 'C-16 手动「刷新状态」与轮询同一入口');
  }

  // ═══ D｜M2 一单一跑：同一 req.id 的执行账（真函数 + 内存真库）═════════════════════════════
  console.log('\n【D】M2 一单一跑（真 runner + 真 SQL）');
  {
    const DDL = `
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0, source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL,
  file_path TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverable_versions (id TEXT PRIMARY KEY, deliverable_id TEXT, file_path TEXT,
  content_snapshot TEXT DEFAULT '', size INTEGER DEFAULT 0, changed_by TEXT,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')));`;

    const freshDb = (): DatabaseSync => {
      const d = new DatabaseSync(':memory:');
      d.exec(DDL);
      d.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run('relay-proj', RELAY_PROJECT_NAME);
      return d;
    };
    const count = (d: DatabaseSync, sql: string, ...p: unknown[]): number =>
      Number((d.prepare(sql).get(...(p as never[])) as { c: number }).c);
    const asLedger = (d: DatabaseSync) => d as unknown as NodeRequestLedgerDb;
    const asBetter = (d: DatabaseSync) => d as unknown as import('better-sqlite3').Database;
    const mkReq = (id: string): AnsNodeRequest => ({
      id,
      category: 'text',
      payload: { prompt: '整理一份清单' },
      requester_key_prefix: 'ext',
      requester_node_id: null,
      target_node_id: 'me',
      status: 'assigned',
      result: null,
      question: null,
      answer: null,
      question_status: null,
      selection: null,
      created_at: '2026-10-27 01:00:00',
      claimed_at: null,
      done_at: null,
    });
    /** 等一轮后把最新建的任务收口（模拟调度器把它跑完）。 */
    const completeNewest = (d: DatabaseSync, status = 'completed'): void => {
      d.prepare(
        "UPDATE wa_tasks SET status = ?, context_json = ? WHERE id = (SELECT id FROM wa_tasks ORDER BY created_at DESC, rowid DESC LIMIT 1)",
      ).run(status, JSON.stringify({ completion_summary: '做完了' }));
    };
    const runnerFor = (d: DatabaseSync) => {
      let slept = 0;
      return makeRelayRunner({
        db: asBetter(d),
        pollMs: 1,
        sleep: async () => {
          slept++;
          if (slept === 1) completeNewest(d);
        },
      });
    };

    // D-0 账的四种状态语义（直接跑真函数）
    {
      const d = freshDb();
      ensureNodeRequestRunsTable(asLedger(d));
      eq(findNodeRequestRun(asLedger(d), 'r0'), null, 'D-0 无账 ⇒ null');
      beginNodeRequestRun(asLedger(d), 'r0', 't0');
      eq(findNodeRequestRun(asLedger(d), 'r0')?.status, 'running', 'D-1 begin ⇒ running');
      finishNodeRequestRun(asLedger(d), 'r0', 'done', { taskId: 't0', summary: 's' });
      const done = findNodeRequestRun(asLedger(d), 'r0');
      eq(done?.status, 'done', 'D-2 finish ⇒ done');
      eq(JSON.parse(done?.result_json ?? '{}'), { taskId: 't0', summary: 's' }, 'D-3 结果原样入账');
      markNodeRequestRunLost(asLedger(d), 'r0');
      eq(findNodeRequestRun(asLedger(d), 'r0')?.status, 'run_lost', 'D-4 崩溃遗留 ⇒ run_lost');
      beginNodeRequestRun(asLedger(d), 'r0', 't0b');
      const reborn = findNodeRequestRun(asLedger(d), 'r0');
      eq([reborn?.status, reborn?.task_id, reborn?.result_json], ['running', 't0b', null],
        'D-5 重建 ⇒ running 且换号、旧结果清空');
    }

    // D-6 已收口 ⇒ 原样重放，不建任务
    for (const st of ['done', 'error'] as const) {
      const d = freshDb();
      ensureNodeRequestRunsTable(asLedger(d));
      beginNodeRequestRun(asLedger(d), 'r-replay', 't-old');
      finishNodeRequestRun(asLedger(d), 'r-replay', st, { taskId: 't-old', taskStatus: st === 'done' ? 'completed' : 'failed', summary: '旧果' });
      const out = await runnerFor(d)(mkReq('r-replay'), [], 'conversation');
      eq(out.status, st, `D-6 ${st} 重放状态一致`);
      eq(out.result, { taskId: 't-old', taskStatus: st === 'done' ? 'completed' : 'failed', summary: '旧果' },
        `D-7 ${st} 重放结果逐字相同`);
      eq(count(d, 'SELECT COUNT(*) AS c FROM wa_tasks'), 0, `D-8 ${st} 重放不建新任务`);
    }

    // D-9 账说在跑、任务行还在 ⇒ 续等同一件（不建新任务、不重新入队）
    {
      const d = freshDb();
      d.prepare("INSERT INTO wa_tasks (id, project_id, title, status) VALUES ('t-live', 'relay-proj', '旧任务', 'executing')").run();
      ensureNodeRequestRunsTable(asLedger(d));
      beginNodeRequestRun(asLedger(d), 'r-live', 't-live');
      const out = await runnerFor(d)(mkReq('r-live'), [], 'conversation');
      eq(out.status, 'done', 'D-9 续等后正常收口');
      eq((out.result as { taskId?: string }).taskId, 't-live', 'D-10 ★续等返回的仍是原 taskId');
      eq(count(d, 'SELECT COUNT(*) AS c FROM wa_tasks'), 1, 'D-11 未新建任务');
      eq(count(d, 'SELECT COUNT(*) AS c FROM wa_jobs'), 0, 'D-12 未重复入队');
      eq(findNodeRequestRun(asLedger(d), 'r-live')?.status, 'done', 'D-13 收口已入账');
    }

    // D-14 账说在跑、任务行没了（崩溃遗留）⇒ 记 run_lost 后重建一次
    {
      const d = freshDb();
      ensureNodeRequestRunsTable(asLedger(d));
      beginNodeRequestRun(asLedger(d), 'r-lost', 't-gone');
      const out = await runnerFor(d)(mkReq('r-lost'), [], 'conversation');
      const tid = String((out.result as { taskId?: string }).taskId ?? '');
      ok(tid !== '' && tid !== 't-gone', 'D-14 ★run_lost ⇒ 重建新任务（换号）', tid);
      eq(count(d, 'SELECT COUNT(*) AS c FROM wa_tasks'), 1, 'D-15 仍只有一行任务');
      const row = findNodeRequestRun(asLedger(d), 'r-lost');
      eq([row?.status, row?.task_id], ['done', tid], 'D-16 账已指向新任务且收口');
    }

    // D-17 ★同一 req.id 连跑两次（第一次已收口）⇒ 任务表只多一行、两次同一 taskId
    {
      const d = freshDb();
      ensureNodeRequestRunsTable(asLedger(d));
      const runner = runnerFor(d);
      const first = await runner(mkReq('r-twice'), [], 'conversation');
      const second = await runner(mkReq('r-twice'), [], 'conversation');
      const t1 = String((first.result as { taskId?: string }).taskId ?? '');
      const t2 = String((second.result as { taskId?: string }).taskId ?? '');
      eq([first.status, second.status], ['done', 'done'], 'D-17 两次都如实 done');
      ok(t1 !== '', 'D-18 第一次有 taskId', t1);
      eq(t2, t1, 'D-19 ★第二次返回同一 taskId（不重建）');
      eq(count(d, 'SELECT COUNT(*) AS c FROM wa_tasks'), 1, 'D-20 ★wa_tasks 只多一行（0→1）');
      eq(count(d, 'SELECT COUNT(*) AS c FROM wa_jobs'), 1, 'D-21 只入队一次');
    }

    // D-22 建单后 setup 半途失败 ⇒ 账落 error（不留"无账任务"，重拉也不再建第二件）
    {
      const d = freshDb();
      ensureNodeRequestRunsTable(asLedger(d));
      // 让 updateContext 失败：把 wa_tasks 的 context_json 列改名，create 仍能写、update 会抛。
      d.exec('ALTER TABLE wa_tasks RENAME COLUMN context_json TO context_json_renamed');
      const out = await runnerFor(d)(mkReq('r-setup-fail'), [], 'conversation');
      eq(out.status, 'error', 'D-22 setup 失败如实报错');
      ok(String((out.result as { error?: string }).error ?? '').includes('setup failed'), 'D-23 错误原因说明是 setup 失败');
      eq(findNodeRequestRun(asLedger(d), 'r-setup-fail')?.status, 'error', 'D-24 ★半途失败也入账（不留无账任务）');
      eq(count(d, 'SELECT COUNT(*) AS c FROM wa_tasks'), 1, 'D-25 失败前建的那一行仍在账上（不消失）');
    }

    // D-26 静态接线：runner 使用账本、worker 的「至少一次」注释如实指向重放
    {
      const runner = CODE(`${A}/src/main/core/node-request-runner.ts`);
      ok(runner.includes('ensureNodeRequestRunsTable(ledgerDb)'), 'D-26 runner 起手建账/查账');
      // zx_20261030_1 M3：终态集增 `cancelled`——已叫停的件重拉须照样重放（否则会把停掉的活复活），
      //   钉点同步上移到三态形（钉的面更大，不放宽）。
      ok(runner.includes("if (prior && (prior.status === 'done' || prior.status === 'error' || prior.status === 'cancelled'))"), 'D-27 ★已收口走重放（含叫停终态）');
      ok(runner.includes('markNodeRequestRunLost(ledgerDb, req.id)'), 'D-28 崩溃遗留标 run_lost 后可重建');
      ok(runner.includes('finishNodeRequestRun(ledgerDb, req.id, finalStatus, result)'), 'D-29 终态入账');
      ok(runner.includes('finishNodeRequestRun(ledgerDb, req.id, \'error\', result)'), 'D-30 暂停/超时失败也入账');
      const schemaInLedger = CODE(`${A}/src/main/core/node-request-ledger.ts`);
      ok(/request_id TEXT PRIMARY KEY/.test(schemaInLedger) && schemaInLedger.includes("status = 'running'"),
        'D-31 账表主键=request_id，状态机词表在此一处');
    }
  }

  // ═══ E｜M3 试得真：试用授予档追上价目表宣称 + 升级差异看得见席位 ═════════════════════════
  console.log('\n【E】M3 试得真');
  {
    const NOW = new Date('2026-10-27T01:00:00.000Z');
    const FP = 'AAAA-BBBB-CCCC-DDDD';
    const licDb = (settings: Record<string, string> = {}): LicenseSettingDb => {
      const d = new DatabaseSync(':memory:');
      d.exec("CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))");
      for (const [k, v] of Object.entries(settings)) d.prepare('INSERT INTO wa_settings (key,value) VALUES (?,?)').run(k, v);
      return d as unknown as LicenseSettingDb;
    };
    const trialDb = licDb({ [LICENSE_SETTING_KEYS.trialStartedAt]: new Date(NOW.getTime() - 86_400_000).toISOString() });
    const st = resolveLicenseState(trialDb, { now: NOW, fingerprint: FP });
    const grants = tierCatalog().trial.grantsTier;

    eq([st.kind, st.tier], ['trial', grants],
      'E-1 ★试用态档位＝价目表宣称的授予档（`tier-catalog.trial.grantsTier`，本脚本不写死档名）');
    ok(st.tierLabel === TIER_LABEL[st.tier] && st.detail.includes(TIER_LABEL[st.tier]),
      'E-2 试用态 `tierLabel`/`detail` 说的也是这一档（宣称与实得一把尺）', st.detail);
    eq([proFeatureRefusal(trialDb, 'knowledge_export', { now: NOW, fingerprint: FP }), teamFeatureRefusal(trialDb, 'multi_node', { now: NOW, fingerprint: FP })],
      [null, null],
      'E-3 ★★试用真解锁：Pro 能力与 Team 能力**各一条**都返回 null（若只升到 pro，Team 这条即红）');

    // 节点闸两侧标本：同一台账（本机 + 另 1 台），授予档放行、社区档拦下。
    const ledger = { nodes: [{ node_id: 'local' }, { node_id: 'peer-1' }], localNodeId: 'local' };
    const trialCheck = nodeQuotaCheck(grants, ledger as never);
    const communityCheck = nodeQuotaCheck('community', ledger as never);
    eq([trialCheck.refusal, communityCheck.refusal === null], [null, false],
      'E-4 ★★节点闸两侧：授予档放行第二台；社区档**同一台账**即拦（单侧标本抓不住过宽/过窄变体）');
    ok(!!communityCheck.refusal && communityCheck.refusal.includes(String(TIER_LIMITS.community.maxNodes)),
      'E-5 社区拒因带**真实上限数**（由 `TIER_LIMITS` 派生）', communityCheck.refusal ?? '');

    // 升级差异：Pro → Team 必须同时看得见「协同节点」与「本机账号」两类实差。
    const up = upgradeDifferences('pro', 'team');
    eq(up.toTier, 'team', 'E-6 Pro 的下一档＝Team（由 `LICENSE_TIERS` 顺序派生）');
    ok(up.quotas.includes(`${TIER_LIMITS.team.maxNodes} 台协同节点`),
      'E-7 ★升级差异含协同节点上限（数值取 `TIER_LIMITS`，不抄字面量）', up.quotas.join('、'));
    ok(up.quotas.includes(`本机账号 ${TIER_LIMITS.team.maxMembers}`),
      'E-8 ★升级差异含本机账号上限（此前只用于计数、升级面板看不见——本轮补齐）', up.quotas.join('、'));
    eq(upgradeDifferences('community', 'pro').quotas.filter((q) => q.startsWith('本机账号')), [],
      'E-9 反证：社区→Pro 不列本机账号行（两档同为 1，只列**确实变化**的口径）');
    eq(upgradeDifferences('team'), { toTier: null, toLabel: null, capabilities: [], quotas: [] },
      'E-10 顶层档无升级路径 ⇒ 差异为空（不编卖点）');

    // 渲染层接线（原文形状）——试用行说授予档与剩余天数；价目说明由 catalog 派生。
    const page = RD('apps/worker-ant-desktop/renderer/src/pages/SettingsPage.tsx');
    ok(/lic\?\.kind === 'trial' && lic\.trialDaysLeft != null/.test(page) && page.includes('trialDaysLeft'),
      'E-11 设置页试用行显示剩余天数与授予档能力（不再只印档位名）');
    ok(page.includes('catalog.trial.grantsLabel') && page.includes('catalog.trial.grantsTier'),
      'E-12 试用说明由 `catalog.trial` 派生（并发/节点/本机账号上限同源，不另写一份）');
    const licRaw = RD(`${A}/src/main/core/license.ts`);
    ok(/tier: 'team', kind: 'trial'/.test(licRaw) && licRaw.includes('trialGrantsTier'),
      'E-13 试用分支落 `team`，注释指回 `trialGrantsTier`（不写死一处孤立决定）');
  }

  // ═══ F｜M4 批了就用：规则类提案真写入 + 真进执行提示词 ═══════════════════════════════════
  console.log('\n【F】M4 批了就用');
  {
    eq(SELF_EVOLVE_RULES_KEY, 'agent.self_rules', 'F-1 规则唯一设置键（读/写/回滚同引一处）');
    eq([buildSelfRulesBlock([]).text, buildSelfRulesBlock([]).dropped], ['', 0], 'F-2 无规则 ⇒ 不注入空块');
    const two = buildSelfRulesBlock(['先读后写', '报错要说清原因']);
    ok(two.text.startsWith('## 自我优化规则') && two.text.includes('- 先读后写') && two.text.includes('- 报错要说清原因') && two.dropped === 0,
      'F-3 规则逐条成行，标题与内容同块');
    const longRules = ['甲'.repeat(300), '乙'.repeat(300)];
    const cut = buildSelfRulesBlock(longRules, 330);
    ok(cut.dropped === 1 && cut.text.includes('甲'.repeat(300)) && !cut.text.includes('乙'),
      'F-4 ★超预算**整条丢弃**（保住第一条、第二条一字不进；不截半条）', `dropped=${cut.dropped}`);
    eq([buildSelfRulesBlock(longRules, 10).text, buildSelfRulesBlock(longRules, 10).dropped], ['', 2],
      'F-5 ★★连第一条都放不下 ⇒ 整块不注入，丢弃条数如实计');

    // 真台账 + 真应用器（内存库）
    const runDb = new DatabaseSync(':memory:');
    runDb.exec("CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))");
    runDb.exec(SELF_EVOLVE_DDL);
    const db = runDb as never;
    const p1 = recordProposal(db, { kind: 'rule', target: SELF_EVOLVE_RULES_KEY, payload: { text: '  先读后写  ' }, source: 'rr' });
    ok(p1.ok, 'F-6 规则提案落 pending');
    const a1 = p1.ok ? decideProposal(db, { id: p1.id, decision: 'approve' }) : null;
    eq([a1?.ok, a1?.status], [true, 'applied'], 'F-7 ★批准即生效（不再停在 approved 的"尚无应用器"）');
    eq(readSelfEvolveRules(db), ['先读后写'], 'F-8 ★★0→1 正面断言：读出口真读到这条规则（trim 后）');

    const pDup = recordProposal(db, { kind: 'rule', target: SELF_EVOLVE_RULES_KEY, payload: { text: '先读后写' } });
    const aDup = pDup.ok ? decideProposal(db, { id: pDup.id, decision: 'approve' }) : null;
    eq([aDup?.ok, aDup?.status, aDup?.reason], [false, 'approved', 'rule_duplicated'],
      'F-9 重复规则被拒且如实带因（不静默重复写入）');

    const pEmpty = recordProposal(db, { kind: 'rule', target: SELF_EVOLVE_RULES_KEY, payload: {} });
    const aEmpty = pEmpty.ok ? decideProposal(db, { id: pEmpty.id, decision: 'approve' }) : null;
    eq([aEmpty?.ok, aEmpty?.status], [false, 'approved'],
      'F-10 ★载荷为空 ⇒ 状态停在 approved（applied 不出现——没生效就不许说生效）');
    const pLong = recordProposal(db, { kind: 'rule', target: SELF_EVOLVE_RULES_KEY, payload: { text: '长'.repeat(SELF_EVOLVE_MAX_RULE_CHARS + 1) } });
    const aLong = pLong.ok ? decideProposal(db, { id: pLong.id, decision: 'approve' }) : null;
    eq([aLong?.ok, aLong?.reason], [false, 'rule_too_long'], 'F-11 单条超字数上限 ⇒ 拒写并带因');

    // 填到上限：已有 1 条，再补到 MAX 条后，第 MAX+1 条被拒。
    for (let i = 2; i <= SELF_EVOLVE_MAX_RULES; i++) {
      const p = recordProposal(db, { kind: 'rule', target: SELF_EVOLVE_RULES_KEY, payload: { text: `规则第 ${i} 条` } });
      if (p.ok) decideProposal(db, { id: p.id, decision: 'approve' });
    }
    eq(readSelfEvolveRules(db).length, SELF_EVOLVE_MAX_RULES, `F-12 规则清单真到上限 ${SELF_EVOLVE_MAX_RULES} 条`);
    const pOver = recordProposal(db, { kind: 'rule', target: SELF_EVOLVE_RULES_KEY, payload: { text: '第 11 条' } });
    const aOver = pOver.ok ? decideProposal(db, { id: pOver.id, decision: 'approve' }) : null;
    eq([aOver?.ok, aOver?.status, aOver?.reason], [false, 'approved', 'rule_limit'],
      'F-13 ★第 11 条被拒且带原因（上限由常量派生，不写死数字）');
    eq(readSelfEvolveRules(db).length, SELF_EVOLVE_MAX_RULES, 'F-14 被拒的第 11 条**未落库**（计数不变）');

    // 回滚恢复旧值（此前的旧值不存在 ⇒ 删键）
    const back = p1.ok ? decideProposal(db, { id: p1.id, decision: 'rollback' }) : null;
    ok(back?.ok === true && back.status === 'rolled_back', 'F-15 回滚成功（applied → rolled_back）');
    ok(!readSelfEvolveRules(db).includes('先读后写'), 'F-16 ★回滚后该规则从读出口消失');

    // 坏旧值：拒绝覆盖（不毁数据）
    const badDb = new DatabaseSync(':memory:');
    badDb.exec("CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))");
    badDb.exec(SELF_EVOLVE_DDL);
    badDb.prepare('INSERT INTO wa_settings (key,value) VALUES (?,?)').run(SELF_EVOLVE_RULES_KEY, '{"not":"array"}');
    const pBad = recordProposal(badDb as never, { kind: 'rule', target: SELF_EVOLVE_RULES_KEY, payload: { text: '新规则' } });
    const aBad = pBad.ok ? decideProposal(badDb as never, { id: pBad.id, decision: 'approve' }) : null;
    const rawAfter = badDb.prepare('SELECT value FROM wa_settings WHERE key = ?').get(SELF_EVOLVE_RULES_KEY) as { value?: string } | undefined;
    eq([aBad?.ok, aBad?.reason, rawAfter?.value], [false, 'rules_unreadable', '{"not":"array"}'],
      'F-17 ★旧值不是字符串数组 ⇒ 拒绝覆盖（写入侧严格，宁可不写也不毁旧值）');

    // 真装配：批准后的规则真的出现在下一次任务的 system 块里；回滚后再装配即消失。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr_f_'));
    const ctxDb = new DatabaseSync(':memory:');
    ctxDb.exec(`
      CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT DEFAULT '', working_dir TEXT DEFAULT '',
        context_json TEXT DEFAULT '{}', sandbox_mode TEXT DEFAULT 'workspace', autonomous_mode TEXT DEFAULT 'off');
      CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT DEFAULT '', status TEXT DEFAULT 'pending',
        source TEXT DEFAULT 'user', context_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, type TEXT DEFAULT '', name TEXT DEFAULT '',
        status TEXT DEFAULT 'draft', file_path TEXT);
      CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, content TEXT DEFAULT '',
        memory_type TEXT DEFAULT 'episodic', created_at TEXT DEFAULT (datetime('now')));
    `);
    ctxDb.prepare("INSERT INTO wa_projects (id, name, context_json) VALUES ('p1', '项目甲', '{}')").run();
    ctxDb.exec(SELF_EVOLVE_DDL);
    const assembled = async () => buildTaskContext({
      ctx: { dataDir: dir } as never,
      db: ctxDb as never,
      taskId: 't1', projectId: 'p1',
      project: { sandbox_mode: 'off' },
      workingDir: dir,
      title: '任务甲', description: '描述甲',
      archetype: 'document' as never,
      adaptiveStrategy: { label: '文档', priorityTools: [] } as never,
      complexityLevel: 'simple' as never,
      userPrefs: '', memoryContext: '', successContext: '', subagentSystemPrompt: undefined,
      projCtxJson: {}, maxTokens: 100_000, maxCost: 0, costSrc: 'none', costGateActive: false,
      historySummary: '', recentConversations: [],
    });
    const textOf = (a: Awaited<ReturnType<typeof assembled>>) =>
      a.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    const before = await assembled();
    ok(!textOf(before).includes('## 自我优化规则'), 'F-18 无规则 ⇒ 装配上下文里没有该块（不是空标题）');
    const pCtx = recordProposal(ctxDb as never, { kind: 'rule', target: SELF_EVOLVE_RULES_KEY, payload: { text: '每次改文件前先读一遍' } });
    const aCtx = pCtx.ok ? decideProposal(ctxDb as never, { id: pCtx.id, decision: 'approve' }) : null;
    const withRule = await assembled();
    ok(aCtx?.status === 'applied' && textOf(withRule).includes('## 自我优化规则') && textOf(withRule).includes('每次改文件前先读一遍'),
      'F-19 ★★批准一条规则 ⇒ 下一次任务上下文的 system 块含该句（0→1 端到端）');
    if (pCtx.ok) decideProposal(ctxDb as never, { id: pCtx.id, decision: 'rollback' });
    const afterRollback = await assembled();
    ok(!textOf(afterRollback).includes('每次改文件前先读一遍'), 'F-20 ★回滚 ⇒ 再装配该句消失（生效与失效同一把尺）');

    // 接线：块序/稳定前缀/注入点在 exec-context 一处
    ok((CONTEXT_BLOCK_ORDER as readonly string[]).includes('self_rules') && (STABLE_PREFIX_BLOCKS as readonly string[]).includes('self_rules'),
      'F-21 `self_rules` 在块序与稳定前缀内（规则不随任务漂，换任务不毁前缀）');
    const ec = CODE(`${A}/src/main/core/exec-context.ts`);
    ok(ec.includes("add('self_rules', block.text)"),
      'F-22 注入点是 `add(\'self_rules\', …)`（内容由读出口+纯函数组出）');
    ok(ec.includes('readSelfEvolveRules(db)') && ec.includes('buildSelfRulesBlock(rules)'),
      'F-23 ★读设置与拼块各只经一处出口（不在装配里另写 JSON.parse）');
    const se = CODE(`${A}/src/main/core/self-evolve.ts`);
    ok(/if \(row\.kind === 'rule'\) return applyRuleProposal\(db, row\)/.test(se),
      'F-24 ★rule 走真应用器（不是"尚无应用器"分支）');
    ok(se.includes("reason: 'rule_limit'") && se.includes('SELF_EVOLVE_MAX_RULES'),
      'F-25 上限拒因与常量同源');
  }

  // ═══ G｜M5 叫得动（标准门牌 + 任务请求能力）══════════════════════════════════════════════
  console.log('\n【G】M5 叫得动 —— 门牌字段单源 / 双路径 / 任务请求闸与在途闸');
  {
    // ── M5a 门牌 ────────────────────────────────────────────────────────────────
    ok(new Set(AGENT_CARD_FIELDS).size === AGENT_CARD_FIELDS.length,
      'G-1 门牌字段清单无重复（单源逐成员）', String(AGENT_CARD_FIELDS.length));
    const card = buildAgentCard('阳台的工蚁', '9.9.9');
    eq(Object.keys(card), [...AGENT_CARD_FIELDS],
      'G-2 ★★门牌键序＝`AGENT_CARD_FIELDS`（漏/多/乱序即红——不各写一份）');
    eq([card.version, card.agent_version, card.url], ['9.9.9', '9.9.9', null],
      'G-3 版本两字段同值；未给入口 ⇒ `url:null`（不编地址）');
    eq(card.capabilities, { streaming: false, pushNotifications: false },
      'G-4 推流/推送如实报 false（门只做发现）');
    eq(card.skills.map((s) => s.id), offeredCapabilities().map((c) => c.key),
      'G-5 ★技能 id 由能力类目派生（加一类能力，门牌自动跟上）');
    ok(card.skills.every((s) => Object.keys(s).sort().join('|') === 'description|id|name|tags' && s.tags.includes('worker-ant')),
      'G-6 技能条目恰四字段，且带 `worker-ant` 标签');

    const only = (address: string, family: 'IPv4' | 'IPv6', internal: boolean) =>
      [{ address, family, internal, netmask: '', mac: '' }] as never;
    eq(resolveAdvertisedUrl(27184, { lo0: only('127.0.0.1', 'IPv4', true), en0: only('192.168.1.9', 'IPv4', false) } as never),
      'http://192.168.1.9:27184', 'G-7 ★入口＝首个非回环 IPv4 + 入站端口');
    eq(resolveAdvertisedUrl(27184, { lo0: only('127.0.0.1', 'IPv4', true), en0: only('fe80::1', 'IPv6', false) } as never),
      null, 'G-8 只有回环/IPv6 ⇒ `null`（取不到就如实留空）');
    eq(resolveAdvertisedUrl(27184, { utun9: only('203.0.113.7', 'IPv4', false), en0: only('10.1.2.3', 'IPv4', false) } as never),
      'http://10.1.2.3:27184', 'G-9 ★局域网配对优先私网地址（不把公网口递给街坊）');

    const deps = { nodeName: () => '阳台的工蚁', agentVersion: '9.9.9', cardUrl: 'http://192.168.1.9:27184' };
    const a = await handleInboundRequest({ method: 'GET', path: INBOUND_WELL_KNOWN_PATH, headers: {}, remoteAddress: '192.168.1.44' }, deps);
    const b = await handleInboundRequest({ method: 'GET', path: INBOUND_AGENT_CARD_PATH, headers: {}, remoteAddress: '192.168.1.44' }, deps);
    eq([a.status, b.status], [200, 200], 'G-10 两个 well-known 路径皆 200');
    eq(a.body, b.body, 'G-11 ★★同一份门牌（同一组装函数，不是第二套）');
    eq((a.body as { url: string }).url, 'http://192.168.1.9:27184', 'G-12 门牌如实报入口地址');
    const cardJson = JSON.stringify(a.body);
    ok(!/"(devices|rooms|room_id|device_id|node_id|alias|address|port|status_json|authorized|call_name)"/.test(cardJson),
      'G-13 ★★反证：标准门牌仍无实例清单 / 网络坐标 / 授权态字段');
    ok(!/jsonrpc|JSON-RPC|a2a_compat/i.test(cardJson),
      'G-14 ★不宣称 JSON-RPC 兼容（门牌只做发现，调用仍走配对后的 `/api/v1/*`）');
    const gateSrc = CODE(`${A}/src/main/core/inbound-gate.ts`);
    ok(/path === INBOUND_WELL_KNOWN_PATH \|\| path === INBOUND_AGENT_CARD_PATH/.test(gateSrc)
      && (gateSrc.match(/body: buildAgentCard\(/g) ?? []).length === 1,
      'G-15 ★★两个路径共用一个 `buildAgentCard(` 调用（门牌只组装一次）');

    // ── M5b 任务请求 ────────────────────────────────────────────────────────────
    ok((EXTERNAL_CAPABILITIES as readonly string[]).includes('task_request')
      && EXTERNAL_CAPABILITY_LABEL.task_request === '任务请求'
      && EXTERNAL_CAPABILITY_NOTE.task_request.includes('默认不给'),
      'G-16 ★`task_request` 在册、人话名「任务请求」、说明点明默认不给');
    ok(!(DEFAULT_TERMINAL_CAPABILITIES as readonly string[]).includes('task_request'),
      'G-17 ★默认不授予（与设备控制同档，须桌面显式勾选）');
    ok(isInvocableCapability('task_request') && !isInvocableCapability('intent_control'),
      'G-18 ★任务请求可经 `/invoke` 直调；意图仍只走意图协议');

    const doorDb = (unlocked: boolean): DatabaseSync => {
      const d = new DatabaseSync(':memory:');
      d.exec('CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT)');
      d.exec(`CREATE TABLE wa_external_calls (
        id TEXT PRIMARY KEY,
        terminal_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        args_json TEXT DEFAULT '{}',
        result TEXT DEFAULT '',
        reason TEXT DEFAULT '',
        remote_addr TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      )`);
      if (unlocked) {
        d.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)')
          .run(LICENSE_SETTING_KEYS.trialStartedAt, new Date().toISOString());
      }
      return d;
    };
    const cnt = (d: DatabaseSync) => Number((d.prepare('SELECT COUNT(*) AS n FROM wa_external_calls').get() as { n: number }).n);
    const last = (d: DatabaseSync) =>
      d.prepare('SELECT * FROM wa_external_calls ORDER BY rowid DESC LIMIT 1').get() as Record<string, unknown> | undefined;
    const noDevice = async () => ({ ok: false as const, denied: true as const, reason: 'not_used' });

    {
      // 未勾选：闸在跑之前，执行器零调用；被拒也留痕。
      const d = doorDb(true);
      let calls = 0;
      const port = createExternalCapabilityPort(d as never, {
        listDevices: () => [], controlDevice: noDevice,
        runTask: async () => { calls++; return { ok: true as const, taskId: 't', taskStatus: 'completed', summary: 's' }; },
      } as never);
      const r = await port.invoke('t1', [], { capability: 'task_request', args: { prompt: '整理会议纪要' } }, '192.168.1.9');
      eq([r.status, (r.body as { error: string }).error, calls], [403, 'capability_not_granted', 0],
        'G-19 ★未勾选 ⇒ 403 `capability_not_granted`，执行器零调用（先问再动）');
      eq([last(d)?.result, last(d)?.reason], ['denied', 'capability_not_granted'], 'G-20 被拒也留痕（reason 记档位）');
      d.close();
    }
    {
      // 勾选后：执行器恰一次、回包四键、留痕 0→1。
      const d = doorDb(true);
      const seen: Array<Record<string, unknown>> = [];
      const port = createExternalCapabilityPort(d as never, {
        listDevices: () => [], controlDevice: noDevice,
        runTask: async (input: Record<string, unknown>) => {
          seen.push(input);
          return { ok: true as const, taskId: 'task-42', taskStatus: 'completed', summary: '已整理' };
        },
      } as never);
      const before = cnt(d);
      const r = await port.invoke('t1', ['task_request'],
        { capability: 'task_request', args: { prompt: '  整理会议纪要  ', acceptance_criteria: '输出摘要' } }, '192.168.1.9');
      eq([r.status, r.body],
        [200, { ok: true, taskId: 'task-42', taskStatus: 'completed', summary: '已整理' }],
        'G-21 ★★勾选后执行器被调一次并原样回 `{ok,taskId,taskStatus,summary}`');
      eq(seen, [{ prompt: '整理会议纪要', acceptanceCriteria: '输出摘要', terminalId: 't1' }],
        'G-22 入参裁剪后转交（prompt 去空白，终端身份随行）');
      eq([cnt(d) - before, last(d)?.result], [1, 'ok'], 'G-23 ★留痕 0→1 且 `result=ok`');
      d.close();
    }
    {
      // 烂请求分因 400，且**不**污染账（与缺 capability 同族）。
      const d = doorDb(true);
      let calls = 0;
      const port = createExternalCapabilityPort(d as never, {
        listDevices: () => [], controlDevice: noDevice,
        runTask: async () => { calls++; return { ok: true as const, taskId: 'x', taskStatus: 'completed', summary: '' }; },
      } as never);
      const before = cnt(d);
      const r1 = await port.invoke('t1', ['task_request'], { capability: 'task_request', args: { prompt: '   ' } });
      const r2 = await port.invoke('t1', ['task_request'], { capability: 'task_request', args: { prompt: '甲'.repeat(TASK_REQUEST_MAX_PROMPT + 1) } });
      const r3 = await port.invoke('t1', ['task_request'],
        { capability: 'task_request', args: { prompt: '做点什么', acceptance_criteria: '乙'.repeat(TASK_REQUEST_MAX_ACCEPTANCE + 1) } });
      eq([r1.status, (r1.body as { error: string }).error, r2.status, (r2.body as { error: string }).error, r3.status, (r3.body as { error: string }).error],
        [400, 'prompt_required', 400, 'prompt_too_long', 400, 'acceptance_criteria_too_long'],
        'G-24 ★烂请求分因 400（空 / prompt 超长 / 验收标准超长各自回码）');
      eq([cnt(d), before, calls], [0, 0, 0], 'G-25 ★★烂请求不污染账，也不触发执行（三条皆零）');
      d.close();
    }
    {
      // 未装配执行器：503 且留痕（不假装跑过）。
      const d = doorDb(true);
      const port = createExternalCapabilityPort(d as never, { listDevices: () => [], controlDevice: noDevice } as never);
      const r = await port.invoke('t1', ['task_request'], { capability: 'task_request', args: { prompt: '整理会议纪要' } });
      eq([r.status, (r.body as { error: string }).error, last(d)?.reason],
        [503, 'task_runner_unavailable', 'task_runner_unavailable'],
        'G-26 ★未装配执行器 ⇒ 503 且如实留痕');
      d.close();
    }
    {
      // 在途闸：同一终端同时 1 件；收口即解除。
      const d = doorDb(true);
      let release!: (v: TaskRequestOutcome) => void;
      const pending = new Promise<TaskRequestOutcome>((res) => { release = res; });
      const port = createExternalCapabilityPort(d as never, {
        listDevices: () => [], controlDevice: noDevice, runTask: () => pending,
      } as never);
      const first = port.invoke('t9', ['task_request'], { capability: 'task_request', args: { prompt: '长任务' } });
      const second = await port.invoke('t9', ['task_request'], { capability: 'task_request', args: { prompt: '第二件' } });
      eq([second.status, (second.body as { error: string }).error, last(d)?.reason], [429, 'busy', 'busy'],
        'G-27 ★★同一终端第二件在途 ⇒ 429 `busy`（且留痕）');
      release({ ok: true, taskId: 'task-long', taskStatus: 'completed', summary: 'done' });
      const done = await first;
      eq([done.status, (done.body as { ok: boolean }).ok], [200, true], 'G-28 第一件收口 ⇒ 200（在途闸不吞已放行的件）');
      const third = await port.invoke('t9', ['task_request'], { capability: 'task_request', args: { prompt: '第三件' } });
      eq(third.status, 200, 'G-29 ★在途闸随收口解除（不是永久占位）');
      d.close();
    }
    {
      // Team 未解锁：先问档位（在途闸之前）。
      const d = doorDb(false);
      let calls = 0;
      const port = createExternalCapabilityPort(d as never, {
        listDevices: () => [], controlDevice: noDevice,
        runTask: async () => { calls++; return { ok: true as const, taskId: 'x', taskStatus: 'completed', summary: '' }; },
      } as never);
      const r = await port.invoke('t1', ['task_request'], { capability: 'task_request', args: { prompt: '整理会议纪要' } });
      eq([r.status, (r.body as { error: string }).error, calls], [403, 'team_required', 0],
        'G-30 ★Team 未解锁 ⇒ 403 `team_required`，执行器零调用');
      d.close();
    }
    // 接线：装配面真接 `makeRelayRunner`（不是只声明 `runTask` 却没人接）。
    const idx = CODE(`${A}/src/main/index.ts`);
    ok(/runTask:\s*async/.test(idx) && /makeRelayRunner\(\{ db: db! \}\)/.test(idx) && /requester_node_id: null/.test(idx),
      'G-31 ★★装配面真接 `makeRelayRunner`（外部终端无上游可答 ⇒ `requester_node_id: null`）');
  }

  // ═══ H｜M6 越用越准（知识卡结局反馈 + 画像自动跟随）══════════════════════════════════════
  console.log('\n【H】M6 越用越准 —— 卡按成/败微调 / 画像随项目走且不越权');
  {
    // ── M6a 卡按结局微调 ──────────────────────────────────────────────────────
    eq([CARD_OUTCOME_MIN_SAMPLES, CARD_OUTCOME_WEIGHT], [3, 3],
      'H-1 ★样本门槛 3、修正权重 ±3（能翻同级卡序，不压过 10 分档差）');

    const P1 = 'p1';
    const mkLearnDb = (): DatabaseSync => {
      const d = new DatabaseSync(':memory:');
      d.exec(`
        CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT DEFAULT '',
          status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}',
          created_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE wa_context_injections (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source TEXT NOT NULL,
          ref_id TEXT NOT NULL, chars INTEGER DEFAULT 0, est_tokens INTEGER DEFAULT 0,
          outcome TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE wa_knowledge_cards (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
          text TEXT NOT NULL, source TEXT DEFAULT '', confidence REAL DEFAULT 0.5, tokens INTEGER DEFAULT 0,
          status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE wa_project_knowledge (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, section TEXT NOT NULL,
          content TEXT NOT NULL, source_ref TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE wa_project_knowledge_imports (project_id TEXT NOT NULL, section TEXT NOT NULL,
          content TEXT NOT NULL, precedence INTEGER DEFAULT 0, source_hash TEXT DEFAULT '',
          imported_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, section));
        CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, type TEXT DEFAULT 'file',
          status TEXT DEFAULT 'draft', created_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE wa_service_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, kind TEXT, ok INTEGER);
        CREATE TABLE wa_project_profiles (project_id TEXT PRIMARY KEY, version INTEGER DEFAULT 1,
          source_hash TEXT DEFAULT '', profile_json TEXT NOT NULL, generated_at TEXT DEFAULT (datetime('now')),
          enabled INTEGER DEFAULT 1, origin TEXT DEFAULT 'local', source_project_name TEXT DEFAULT '');
        CREATE TABLE wa_project_profile_history (project_id TEXT NOT NULL, source_hash TEXT NOT NULL,
          version INTEGER DEFAULT 1, profile_json TEXT NOT NULL, generated_at TEXT DEFAULT '',
          replaced_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, source_hash));
      `);
      return d;
    };
    const task = (d: DatabaseSync, id: string, projectId: string, status: string) =>
      d.prepare('INSERT INTO wa_tasks (id, project_id, status) VALUES (?, ?, ?)').run(id, projectId, status);
    const inj = (d: DatabaseSync, id: string, taskId: string, source: string, refId: string) =>
      d.prepare('INSERT INTO wa_context_injections (id, task_id, source, ref_id) VALUES (?, ?, ?, ?)')
        .run(id, taskId, source, refId);
    const addCard = (d: DatabaseSync, id: string, kind: string, text: string, status = 'active', conf = 0.5) =>
      d.prepare('INSERT INTO wa_knowledge_cards (id, project_id, kind, text, confidence, tokens, status) VALUES (?, ?, ?, ?, ?, 10, ?)')
        .run(id, P1, kind, text, conf, status);
    const seedBook = (d: DatabaseSync, section: string, content: string) =>
      d.prepare('INSERT INTO wa_project_knowledge (id, project_id, section, content) VALUES (?, ?, ?, ?)')
        .run(`k-${section}`, P1, section, content);
    const profileCount = (d: DatabaseSync) =>
      Number((d.prepare('SELECT COUNT(*) AS n FROM wa_project_profiles').get() as { n: number }).n);
    const historyCount = (d: DatabaseSync) =>
      Number((d.prepare('SELECT COUNT(*) AS n FROM wa_project_profile_history').get() as { n: number }).n);

    {
      const d = mkLearnDb();
      task(d, 't1', P1, 'completed');
      task(d, 't2', P1, 'completed');
      task(d, 't3', P1, 'failed');
      task(d, 't4', P1, 'completed');
      task(d, 't5', P1, 'completed');
      task(d, 't6', P1, 'running');
      task(d, 't7', 'p2', 'completed');                       // 另一个项目
      inj(d, 'i1', 't1', 'knowledge_card', 'kc-a');
      inj(d, 'i2', 't2', 'knowledge_card', 'kc-a');
      inj(d, 'i3', 't3', 'knowledge_card', 'kc-a');
      inj(d, 'i4', 't1', 'knowledge', 'kc-a');                // 同 ref、异 source：不进卡账
      inj(d, 'i5', 't1', 'knowledge_card', 'kc-b');
      inj(d, 'i6', 't4', 'knowledge_card', 'kc-b');
      inj(d, 'i7', 't5', 'knowledge_card', 'kc-b');
      inj(d, 'i8', 't7', 'knowledge_card', 'kc-a');           // 异项目：不进本项目账
      inj(d, 'i9', 't6', 'knowledge_card', 'kc-d');           // 在途：只计注入

      const stats = cardOutcomeStats(d as never, P1);
      eq(stats.get('kc-a'), { injected: 3, completed: 2, failed: 1 },
        'H-2 ★★按**任务终态**汇总（异 source、异项目各不混入）');
      eq(stats.get('kc-b'), { injected: 3, completed: 3, failed: 0 }, 'H-3 全成卡：3 注入 / 3 成 / 0 败');
      eq(stats.get('kc-d'), { injected: 1, completed: 0, failed: 0 },
        'H-4 ★在途任务只计注入，不记成也不记败（不预支结局）');
      ok(!stats.has('kc-c') && stats.size === 3, 'H-5 只出现真有注入的卡 id（不造空条目）',
        `size=${stats.size}`);
      d.close();
    }

    const cardOf = (id: string, kind: KnowledgeCard['kind'], text: string): KnowledgeCard => ({
      id, projectId: P1, kind, text, source: 'rr', confidence: 0.5, tokens: 10,
    });
    const A_CARD = cardOf('kc-aaa', 'term', '甲的术语正文');
    const B_CARD = cardOf('kc-bbb', 'term', '乙的术语正文');
    const pickIds = (statsMap?: Map<string, CardOutcomeStat>): string[] =>
      selectKnowledgeCardsForInject([A_CARD, B_CARD], null, '', 150, statsMap).map((c) => c.id);

    eq(pickIds(), ['kc-aaa', 'kc-bbb'], 'H-6 无结局账 ⇒ 同级同分按 id 定序（基线）');
    eq(pickIds(new Map([['kc-bbb', { injected: 3, completed: 3, failed: 0 }]])), ['kc-bbb', 'kc-aaa'],
      'H-7 ★★样本恰 3 且全成 ⇒ 乙卡 +3 反超（结果真算进选卡）');
    eq(pickIds(new Map([['kc-bbb', { injected: 2, completed: 1, failed: 1 }]])), ['kc-aaa', 'kc-bbb'],
      'H-8 ★反证：样本 2 不足门槛 ⇒ 不调整（一两件偶发不改写经验）');
    eq(pickIds(new Map([['kc-aaa', { injected: 3, completed: 0, failed: 3 }]])), ['kc-bbb', 'kc-aaa'],
      'H-9 ★全败的卡降序（−3 与 +3 同一把尺的两向）');
    eq(selectKnowledgeCardsForInject(
      [cardOf('kc-term', 'term', '术语一条'), cardOf('kc-recipe', 'recipe', '配方一条')], 'code', '', 150,
      new Map([['kc-term', { injected: 9, completed: 9, failed: 0 }]]),
    ).map((c) => c.id), ['kc-recipe', 'kc-term'],
      'H-10 ★±3 不压过形态亲和度的 10 分档差（code 任务里配方仍先于术语）');

    {
      // 面板行 = 卡 + 结局账（唯一组装处）。
      const d = mkLearnDb();
      addCard(d, 'kc-x', 'recipe', '配方卡正文', 'active', 0.8);
      addCard(d, 'kc-y', 'pitfall', '待并入的坑', 'pending');
      addCard(d, 'kc-z', 'term', '无账术语卡', 'active', 0.7);
      task(d, 't1', P1, 'completed');
      task(d, 't2', P1, 'failed');
      inj(d, 'j1', 't1', 'knowledge_card', 'kc-x');
      inj(d, 'j2', 't2', 'knowledge_card', 'kc-x');
      eq(listKnowledgeCardsWithUsage(d as never, P1).map((u) => [u.id, u.kindLabel, u.injected, u.completed, u.failed]), [
        ['kc-x', '配方', 2, 1, 1],
        ['kc-z', '术语', 0, 0, 0],
      ], 'H-11 ★面板行：pending 卡不上屏，无账卡如实为零（不编数）');
      d.close();
    }

    {
      // 端到端：成效账经 `buildMemoryContext` 改真注入顺序。
      type Mem = Parameters<typeof buildMemoryContext>[0];
      let statsCalls = 0;
      const base = {
        listKnowledgeCards: () => [A_CARD, B_CARD],
        knowledgeCardStats: () => {
          statsCalls++;
          return new Map<string, CardOutcomeStat>([['kc-bbb', { injected: 3, completed: 3, failed: 0 }]]);
        },
        listProjectProfile: () => null,
        listDomainKnowledge: () => [],
        listAppliedDomainPacks: () => [],
        buildMemoryEffectivenessStats: () => [],
        buildExecutionPlaybook: () => ({}),
        retrieveByType: () => [],
        getProjectKnowledge: () => [],
        retrieveKnowledgeGraphContext: () => [],
        getTriggeredProspective: () => [],
        getWorkingMemory: () => [],
        retrieveUnknownHits: () => [],
        retrieveNegativeHits: () => [],
        findSimilarTasks: () => [],
        getTaskArchetype: () => null,
        getTaskText: () => '',
        generateExemplarContext: () => '',
        recordInjection: () => { /* 装配用例不落账 */ },
      };
      const ctx = buildMemoryContext(base as unknown as Mem, P1, undefined, undefined, null, undefined, 20000);
      ok(ctx.cardText.indexOf('乙的术语正文') >= 0
        && ctx.cardText.indexOf('乙的术语正文') < ctx.cardText.indexOf('甲的术语正文'),
        'H-12 ★★端到端：结局账让乙卡先进上下文（同一次装配，不另算一遍）');
      eq(ctx.cardInjections.map((x) => x.ref_id), ['kc-bbb', 'kc-aaa'], 'H-13 留账顺序与选卡顺序一致');
      eq(statsCalls, 1, 'H-14 成效账每轮装配只读一次');
      const noStats = buildMemoryContext(
        { ...base, knowledgeCardStats: undefined } as unknown as Mem,
        P1, undefined, undefined, null, undefined, 20000,
      );
      ok(noStats.cardText.indexOf('甲的术语正文') < noStats.cardText.indexOf('乙的术语正文'),
        'H-15 反证：旧桩无成效读口 ⇒ 基线序，不因缺方法而崩');
    }

    {
      // 接线：成效真进选卡；读口单源委托。
      const mc = CODE(`${A}/src/main/core/memory-context.ts`);
      ok(mc.includes('memory.knowledgeCardStats(projectId)')
        && mc.includes('selectKnowledgeCardsForInject(cards, currentArchetype, taskText, CARD_INJECT_MAX_TOKENS, cardStats)'),
        'H-16 ★★结局账真进选卡（同一处调用带 stats，不另择一次）');
      const mm = CODE(`${A}/src/main/core/memory-manager.ts`);
      ok(/knowledgeCardStats\(projectId: string\): Map<string, CardOutcomeStat> \{\s*return cardOutcomeStats\(this\.db, projectId\);/.test(mm),
        'H-17 ★读口单源：`knowledgeCardStats` 委托 `cardOutcomeStats`（不另写 SQL）');
    }

    // ── M6b 画像自动跟随 ──────────────────────────────────────────────────────
    {
      const d = mkLearnDb();
      seedBook(d, 'domain', '术语：订单号以 SO 开头');
      const r = refreshProjectProfileIfEnabled(d as never, P1);
      eq([r.refreshed, r.reason, profileCount(d)], [false, 'no_profile', 0],
        'H-18 ★无画像 ⇒ 不自动新建（首次生成仍由用户点）');

      const built = buildProjectProfile(d as never, P1, { now: '2026-10-27T00:00:00.000Z' });
      ok(built.ok, 'H-19 夹具自检：有知识书即可生成画像');
      if (!built.ok) throw new Error('H-19 fixture');
      saveProjectProfile(d as never, built.profile);
      const hash1 = built.profile.sourceHash;
      eq([profileCount(d), historyCount(d)], [1, 0], 'H-20 首次落库：画像 1 行、旧版 0 行');
      const same = refreshProjectProfileIfEnabled(d as never, P1);
      eq([same.refreshed, same.reason, historyCount(d)], [false, 'unchanged', 0],
        'H-21 输入未变 ⇒ 不动、不归档');

      seedBook(d, 'criteria', '- [x] 金额一律用分表示');
      const upd = refreshProjectProfileIfEnabled(d as never, P1);
      eq([upd.refreshed, upd.reason], [true, 'updated'], 'H-22 ★★知识书变了 ⇒ 自动跟随（已启用才动）');
      const stored = readProjectProfile(d as never, P1);
      eq([historyCount(d), profileCount(d)], [1, 1], 'H-23 ★计数器 0→1：旧版恰归档一行，画像仍是一行');
      ok(stored?.sourceHash === currentProfileSourceHash(d as never, P1) && stored.sourceHash !== hash1,
        'H-24 新画像指纹＝当前输入（不是旧指纹冒充新的）');
      eq([stored?.enabled, listProjectProfileHistory(d as never, P1)[0]?.sourceHash], [true, hash1],
        'H-25 ★★自动跟随不改启停；被替换的旧版在留痕里（可回溯）');
      const again = refreshProjectProfileIfEnabled(d as never, P1);
      eq([again.reason, historyCount(d)], ['unchanged', 1], 'H-26 同输入再跟一次 ⇒ unchanged，不重复归档');
      d.close();
    }
    {
      const d = mkLearnDb();
      seedBook(d, 'domain', '术语：订单号以 SO 开头');
      const built = buildProjectProfile(d as never, P1);
      if (!built.ok) throw new Error('H-27 fixture');
      saveProjectProfile(d as never, built.profile);
      setProjectProfileEnabled(d as never, P1, false);
      seedBook(d, 'criteria', '- [x] 金额一律用分表示');
      const r = refreshProjectProfileIfEnabled(d as never, P1);
      eq([r.refreshed, r.reason, historyCount(d)], [false, 'disabled', 0],
        'H-27 ★反证：用户停用 ⇒ 即便输入变了也不自动改（启停是用户的）');
      d.close();
    }
    {
      const d = mkLearnDb();
      seedBook(d, 'domain', '术语：订单号以 SO 开头');
      const built = buildProjectProfile(d as never, P1);
      if (!built.ok) throw new Error('H-28 fixture');
      const ins = insertImportedProfile(d as never, P1, built.profile, { sourceProjectName: '隔壁项目' });
      setProjectProfileEnabled(d as never, P1, true);
      seedBook(d, 'criteria', '- [x] 金额一律用分表示');
      const r = refreshProjectProfileIfEnabled(d as never, P1);
      const stored = readProjectProfile(d as never, P1);
      eq([ins, r.refreshed, r.reason], ['imported', false, 'imported'],
        'H-28 ★★导入画像不按本机输入重算（指纹来自来源项目，重算会把带来的资产悄悄换掉）');
      eq([stored?.origin, stored?.sourceHash, historyCount(d)], ['imported', built.profile.sourceHash, 0],
        'H-29 导入画像原样保留（未换版、未归档）');
      d.close();
    }
    {
      const d = mkLearnDb();
      seedBook(d, 'domain', '术语：订单号以 SO 开头');
      const built = buildProjectProfile(d as never, P1);
      if (!built.ok) throw new Error('H-30 fixture');
      saveProjectProfile(d as never, built.profile);
      d.prepare('DELETE FROM wa_project_knowledge').run();
      const r = refreshProjectProfileIfEnabled(d as never, P1);
      eq([r.refreshed, r.reason, historyCount(d)], [false, 'no_facts', 0],
        'H-30 事实清空 ⇒ 无得画（不写空画像冒充新版）');
      d.close();
    }
    {
      // 归档由**写口自身**保证：手动刷新与自动跟随同一把尺。
      const d = mkLearnDb();
      seedBook(d, 'domain', '术语：订单号以 SO 开头');
      const p1 = buildProjectProfile(d as never, P1, { now: 'aa' });
      if (!p1.ok) throw new Error('H-31 fixture');
      saveProjectProfile(d as never, p1.profile);
      seedBook(d, 'criteria', '- [x] 金额一律用分表示');
      const p2 = buildProjectProfile(d as never, P1, { now: 'bb' });
      if (!p2.ok) throw new Error('H-32 fixture');
      saveProjectProfile(d as never, p2.profile);
      eq([historyCount(d), listProjectProfileHistory(d as never, P1)[0]?.version], [1, 1],
        'H-31 ★写口自身归档旧版（不只靠自动跟随那条路）');
      saveProjectProfile(d as never, p2.profile);
      eq(historyCount(d), 1, 'H-32 同指纹重存不重复归档（主键去重）');
      d.close();
    }

    {
      // 收尾接线与面板读口。
      const ai = CODE(`${A}/src/main/core/jobs/ai-task.ts`);
      eq((ai.match(/refreshProjectProfileIfEnabled\(db, /g) ?? []).length, 2,
        'H-33 ★收尾两路（主执行 + 恢复执行）都接线');
      const prof = CODE(`${A}/src/main/core/project-profile.ts`);
      ok(prof.includes("reason: 'imported'") && prof.includes("reason: 'updated'"),
        'H-34 跟随的结局说得出口（imported 跳过 / updated 更新各一码）');
      const ipc = CODE(`${A}/src/main/ipc/knowledge.ipc.ts`);
      ok(ipc.includes("ipcMain.handle('knowledge:cards'") && ipc.includes('listKnowledgeCardsWithUsage('),
        'H-35 ★IPC 面板是卡+成效的唯一组装（渲染层不另拼一份）');
      const rdr = CODE(`${A}/renderer/src/lib/ipc.ts`);
      ok(rdr.includes("cards: (projectId: string)") && rdr.includes("ipcCall<KnowledgeCardUsage[]>('knowledge:cards'"),
        'H-36 渲染层读口在册');
      const pack = CODE(`${A}/renderer/src/components/KnowledgePackCard.tsx`);
      ok(pack.includes('knowledge.cards(projectId)')
        && pack.includes('注入 {c.injected} · 成 {c.completed} / 败 {c.failed}'),
        'H-37 ★卡与结局账同屏（注入 N / 成 M / 败 K）');
      ok(pack.includes('profile.history') && pack.includes('历史版本'),
        'H-38 画像留痕条数上屏（"换过几版"可回溯）');
    }
  }

  // ═══ I｜M7 测得快（改动面选套件，advisory）═══════════════════════════════════════════════
  console.log('\n【I】M7 测得快 —— 按改动面选套件，收口口径不变');
  {
    const pkg = JSON.parse(RD('package.json')) as { scripts?: Record<string, string> };
    eq(pkg.scripts?.['rr:changed'], 'node scripts/rr-changed.mjs',
      'I-1 `pnpm rr:changed` 在册（根脚本入口）');
    const src = RD('scripts/rr-changed.mjs');
    ok(src.includes('收口一律 `pnpm rr:all`') && src.includes("'apps/worker-ant-desktop/src/main/core/agent-executor.ts'")
      && src.includes("'apps/worker-ant-desktop/src/main/database.ts'")
      && src.includes("'apps/worker-ant-desktop/src/main/core/exec-context.ts'")
      && src.includes("'packages/shared-types/'") && src.includes("'scripts/lib/'"),
      'I-2 ★公共底座清单写死（一改全动：执行器/建库/上下文装配/共享类型/rr 工具）');

    // 真跑：在临时 git 仓里按两类改动各跑一次（不碰本仓工作树）。
    const mkRepo = (modules: Record<string, string>): string => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-changed-'));
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.copyFileSync(path.join(root, 'scripts/rr-changed.mjs'), path.join(dir, 'scripts/rr-changed.mjs'));
      fs.writeFileSync(path.join(dir, 'scripts/rr_zx_99990101.ts'), '// 与改动无关的套件\n');
      fs.writeFileSync(path.join(dir, 'scripts/rr_zx_99990102.ts'), "import '../apps/demo/src/tier-usage.js';\n");
      for (const [rel, body] of Object.entries(modules)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), body);
      }
      const gitc = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=rr', '-c', 'user.email=rr@example.com', ...args], { cwd: dir, encoding: 'utf-8' });
      gitc('init', '-q');
      gitc('add', '-A');
      gitc('commit', '-qm', 'base');
      return dir;
    };
    const runPick = (dir: string): string =>
      execFileSync(process.execPath, [path.join(dir, 'scripts/rr-changed.mjs')], { cwd: dir, encoding: 'utf-8' });

    {
      const dir = mkRepo({ 'apps/demo/src/tier-usage.ts': 'export const x = 1;\n' });
      try {
        fs.appendFileSync(path.join(dir, 'apps/demo/src/tier-usage.ts'), '\n');
        const out = runPick(dir);
        ok(out.includes('rr_zx_99990102.ts  ← tier-usage') && !out.includes('rr_zx_99990101.ts  ←'),
          'I-3 ★按模块 basename 选中引用它的套件（无关套件不被选）');
        ok(out.includes('pnpm rr:all rr_zx_99990102'), 'I-4 给出可直接跑的窄命令（子集不是全量）');
        ok(out.includes('收口一律 pnpm rr:all'), 'I-5 ★★输出自带边界：收口仍须 rr:all（建议不是证据）');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
    {
      const dir = mkRepo({
        'apps/worker-ant-desktop/src/main/core/agent-executor.ts': 'export const x = 1;\n',
      });
      try {
        fs.appendFileSync(path.join(dir, 'apps/worker-ant-desktop/src/main/core/agent-executor.ts'), '\n');
        const out = runPick(dir);
        ok(out.includes('强制全量') && out.includes('公共底座变动'),
          'I-6 ★★改公共底座 ⇒ 直接全量（不按 basename 猜）');
        ok(out.includes('选中 2/2（全量）'), 'I-7 全量分支也点明"选中 N/M（全量）"', out.split('\n').find((l) => l.includes('选中')));
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
    {
      // 无命中 ⇒ 全量（不拿"看起来不相干"赌覆盖）。
      const dir = mkRepo({ 'apps/demo/src/unheard-of.ts': 'export const x = 1;\n' });
      try {
        fs.appendFileSync(path.join(dir, 'apps/demo/src/unheard-of.ts'), '\n');
        const out = runPick(dir);
        ok(out.includes('无命中套件 ⇒ 全量') && out.includes('选中 2/2（全量）'),
          'I-8 ★无命中 ⇒ 全量（宁多跑，不赌覆盖）');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  }

  // ═══ K｜构建钉（P1–P6）═══════════════════════════════════════════════════════════════════
  console.log('\n【K】构建钉（P1–P6）');
  {
    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }

  // ═══ S｜自指（G-6 派生核对）═══════════════════════════════════════════════════════════════
  console.log('\n【S】自指');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S-1 本文件零 build 轮次字面量（不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S-2 ★方向性自指：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)), 'S-3 本套件在册（脚本名由载体派生）');
  }
}

// ⚠ `catch` 不可省：夹具/断言抛异常时若只挂 `finally`，`process.exit` 会在 Node 报告
//   unhandled rejection 之前把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行通过假象。
main().then(() => {
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} ${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\n${SELF_ROUND} 未捕获异常（复跑未跑完，不得读作通过）：`, e);
  fail++;
  console.log(`\nFAIL ${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
