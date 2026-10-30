/**
 * zx_20261030_1「协」受控回归 —— 择其能，尽其用，止其可止。
 *
 * 九组判据（照方案 §4.1）：
 *   R 可靠性排序：样本 0 ⇒ 0.5；拉普拉斯（3 成功恰 0.8，5 成功 > 0.8）；3 失败 < 0.3；
 *     取消不计入；窗口只取最近 50 条；满载高分节点不得越过空闲低分节点。
 *   P 进度：有事件 ⇒ step/total 两真数；无 ⇒ null（界面标「对方未上报进度」，不退化成 0%）。
 *   C 取消：检查点真停（步数不再增长、轮询不再继续）、账记 cancelled、任务归档、产物仍在；
 *     起手前叫停不建任务；归档失败不谎称已停；已终态优先于叫停。
 *   V 回执：verified / self-reported / failed 三态各一标本 + 缺项人话 + 驱动接线。
 *   K 集群：聚合数=逐行数之和、离线不计 running、瓶颈文案当且仅当满载/排队。
 *   Q 容量：五维到顶即拒（Note 含 N/M）、已存在行一条不少、运行中任务不受影响。
 *   B 项目知识：水位只前移且第二次只读增量；候选包 origin=auto_candidate 且未启用、忽略不复活；
 *     相似项目 ≤3 且附理由、空输入给空。
 *   T 卖点：三档真实清单全兑现；反向两只标本（多一句/少一句）都被点名。
 *   G/H 构建钉与收口卫生。
 *
 * 纪律：零网络 / 零 electron；夹具自建 DDL（列形状照抄生产）；计数器带 0→1 正面断言；
 *   不以真实墙钟为判据（进度节流注入 0）；本套件不自写「只为下一轮」字面量。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import {
  MIN_RELIABLE_SAMPLES,
  RELIABILITY_WINDOW,
  explainSelection,
  parseCapacity,
  rankDispatchCandidates,
  reliabilityOf,
  type RankableNode,
  type RequestOutcomeRow,
} from '../apps/ans-server/src/routes/node-ranking.js';
import {
  RELAY_PROJECT_NAME,
  makeRelayRunner,
  relayProgressOf,
} from '../apps/worker-ant-desktop/src/main/core/node-request-runner.js';
import {
  ensureNodeRequestRunsTable,
  findNodeRequestRun,
  type NodeRequestLedgerDb,
} from '../apps/worker-ant-desktop/src/main/core/node-request-ledger.js';
import { buildClusterView, readLocalClusterCounts } from '../apps/worker-ant-desktop/src/main/core/node-cluster.js';
import { receiptNote, verifyRemoteReceipt } from '../apps/worker-ant-desktop/src/main/core/node-receipt.js';
import type { NodeDispatchRecord } from '../apps/worker-ant-desktop/src/main/core/node-dispatch-log.js';
import {
  recordDispatchProgress,
  dispatchProgress,
  resetDispatchProgressCache,
} from '../apps/worker-ant-desktop/src/main/core/node-progress-cache.js';
import {
  capacityLimit,
  capacityRefusal,
  countApprovedTerminals,
  countDevices,
  countTeamLibraryMemories,
} from '../apps/worker-ant-desktop/src/main/core/tier-capacity.js';
import { TIER_LIMITS } from '../apps/worker-ant-desktop/src/main/core/feature-limits.js';
import { PRICING } from '../apps/worker-ant-desktop/src/main/core/pricing.js';
import { benefitCoverageProblems } from '../apps/worker-ant-desktop/src/main/core/tier-catalog.js';
import { distillKnowledgeCards, recordPitfallCandidate } from '../apps/worker-ant-desktop/src/main/core/knowledge-cards.js';
import {
  absorbProjectIncrement,
  advanceWatermark,
  readWatermark,
  unabsorbedCount,
} from '../apps/worker-ant-desktop/src/main/core/knowledge-watermark.js';
import {
  dismissAutoCandidateDomainPack,
  ensureAutoCandidateDomainPack,
  listDomainPacks,
  listSuggestedDomainPacks,
} from '../apps/worker-ant-desktop/src/main/core/domain-pack.js';
import { similarProjects } from '../apps/worker-ant-desktop/src/main/core/project-similarity.js';
import {
  __resetDeviceCapacityRefusalsForTest,
  findDeviceByIdentity,
  getDeviceCapacityRefusals,
  upsertDiscovered,
} from '../apps/worker-ant-desktop/src/main/core/device-registry.js';
import { approveTerminal, terminalReasonToError } from '../apps/worker-ant-desktop/src/main/core/external-terminals.js';
import { TeamLibraryError, importItem } from '../apps/worker-ant-desktop/src/main/core/team-library.js';
import { LICENSE_SETTING_KEYS } from '../apps/worker-ant-desktop/src/main/core/license.js';
import type { AnsNode, AnsNodeRequest } from '@worker-ant/shared-types';
import { ROUND_RE, checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';

const ROOT = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const MAIN = `${A}/src/main/core`;
/** 本轮标识**由载体自身派生**（不写「只为下一轮」的字面量）。 */
const SELF_ROUND = path.basename(__filename, '.ts').replace(/^rr_/, '');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}
function readText(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}
function readCode(rel: string): string {
  return stripKeepingLines(readText(rel)).join('\n');
}
function thrownOf(fn: () => unknown): unknown {
  try { fn(); return null; } catch (e) { return e; }
}
function writeDb(d: DatabaseSync) {
  return {
    prepare: (sql: string) => d.prepare(sql),
    transaction: (fn: () => void) => () => { fn(); },
  } as unknown as Parameters<typeof distillKnowledgeCards>[0];
}
const asBetter = (d: DatabaseSync) => d as unknown as import('better-sqlite3').Database;
const asLedger = (d: DatabaseSync) => d as unknown as NodeRequestLedgerDb;

// ══════════════════════════════════════════════════════════════════════
// R 可靠性排序（ANS 派单择机）——纯函数
// ══════════════════════════════════════════════════════════════════════

function sectionR(): void {
  console.log('\n【R】M1：择其能——可靠性只认既有行');
  const row = (status: string, claimed: string | null = null, done: string | null = null): RequestOutcomeRow =>
    ({ status, claimed_at: claimed, done_at: done });
  const doneRows = (n: number, latMs = 1000): RequestOutcomeRow[] =>
    Array.from({ length: n }, (_, i) => {
      const c = '2026-10-30 01:00:00';
      const d = new Date(Date.parse(`${c.replace(' ', 'T')}Z`) + latMs).toISOString().slice(0, 19).replace('T', ' ');
      return row('done', c, d);
    });
  const errRows = (n: number): RequestOutcomeRow[] => Array.from({ length: n }, () => row('error'));

  // R-1 样本 0 ⇒ 中性 0.5（"还没跑过"不是劣迹）
  {
    const r = reliabilityOf([]);
    eq([r.successRate, r.samples, r.failures, r.avgLatencyMs], [0.5, 0, 0, null], 'R-1 样本 0 ⇒ 0.5 / samples 0 / 无均耗');
  }
  // R-2 拉普拉斯：3 成功恰 0.8（方案写「>0.8」在 3 样本下不可满足 ⇒ 以 5 成功证严格大于）
  {
    const r3 = reliabilityOf(doneRows(3));
    ok(Math.abs(r3.successRate - 0.8) < 1e-9, 'R-2 3 成功 0 失败 ⇒ 恰 0.8（拉普拉斯，不外推 100%）', String(r3.successRate));
    const r5 = reliabilityOf(doneRows(5));
    ok(r5.successRate > 0.8 && r5.samples === 5, 'R-3 5 成功 0 失败 ⇒ 严格 > 0.8', String(r5.successRate));
  }
  // R-4 3 失败 < 0.3；且不出现 0
  {
    const r = reliabilityOf(errRows(3));
    ok(r.successRate < 0.3 && r.successRate > 0, 'R-4 0 成功 3 失败 ⇒ < 0.3 且 > 0', String(r.successRate));
    eq([r.samples, r.failures], [3, 3], 'R-5 失败数照实记账');
  }
  // R-6 取消不计入分子分母（用户叫停不是节点的过错）
  {
    const r = reliabilityOf([...doneRows(2), row('cancelled', '2026-10-30 01:00:00', '2026-10-30 01:00:01'), ...errRows(1)]);
    eq([r.samples, r.failures], [3, 1], 'R-6 取消不进分母（done2+error1+cancelled1 ⇒ samples 3）');
    ok(Math.abs(r.successRate - 0.6) < 1e-9, 'R-7 取消不进分子（3/5 = 0.6）', String(r.successRate));
  }
  // R-8 窗口只取最近 50 条（输入按时间降序）
  {
    eq(RELIABILITY_WINDOW, 50, 'R-8 窗口常量 = 50');
    const rows = [...doneRows(50), ...errRows(10)];
    const r = reliabilityOf(rows);
    eq([r.samples, r.failures], [50, 0], 'R-9 默认窗口只读前 50 条（后 10 条错误不计入）');
    const narrow = reliabilityOf([...doneRows(1), ...errRows(1)], 2);
    eq([narrow.samples, narrow.failures], [2, 1], 'R-10 显式窗口 2 只取两条');
  }
  // R-11 均耗只认两端都可解析的行
  {
    // 注意：夹具时刻只精确到秒 ⇒ 用 2000ms（1500ms 会被截成 1000ms）。
    const r = reliabilityOf([row('done', null, null), ...doneRows(2, 2000)]);
    eq(r.avgLatencyMs, 2000, 'R-11 均耗=可解析行均值（缺端起止的行不计）');
    eq(reliabilityOf([row('done')]).avgLatencyMs, null, 'R-12 无可用起止 ⇒ 均耗 null（不编 0）');
  }

  // R-13 层级第一键：满载高分节点不得越过空闲低分节点
  {
    const full: RankableNode = {
      node_id: 'full', weight: 10, status_json: JSON.stringify({ capacity_free_ratio: 0, free_slots: 0 }),
      last_seen_at: '2026-10-30 11:59:00',
      reliability: reliabilityOf(doneRows(10)),
    };
    const free: RankableNode = {
      node_id: 'free', weight: 1, status_json: JSON.stringify({ capacity_free_ratio: 0.5, free_slots: 2 }),
      last_seen_at: '2026-10-30 11:58:00',
      reliability: reliabilityOf([]),
    };
    const ranked = rankDispatchCandidates([full, free]);
    eq(ranked.map((c) => c.nodeId), ['free', 'full'], 'R-13 空闲低权重节点排在满载高权重节点之前');
    eq(ranked.map((c) => c.group), ['free', 'full'], 'R-14 层级（free/full）先于一切分数');
  }
  // R-15 同层同分才看「稳」「快」
  {
    const a: RankableNode = {
      node_id: 'aa', weight: 2, status_json: JSON.stringify({ capacity_free_ratio: 0.5 }),
      last_seen_at: null, reliability: reliabilityOf(doneRows(4, 1000)),
    };
    const b: RankableNode = {
      node_id: 'bb', weight: 1, status_json: JSON.stringify({ capacity_free_ratio: 1 }),
      last_seen_at: null, reliability: reliabilityOf([]),
    };
    const ranked = rankDispatchCandidates([b, a]);
    eq(ranked.map((c) => c.nodeId), ['aa', 'bb'], 'R-15 同分（2×0.5 与 1×1）时成功率高的在前');
    const snap = explainSelection(ranked[0]!);
    ok(snap.reason.includes('历史 4 单，成功率 83%（失败 0），均耗 1s'), 'R-16 理由如实带样本/成功率/均耗', snap.reason);
  }
  // R-17 样本不足时排序用中性且如实说"样本不足"
  {
    const two: RankableNode = {
      node_id: 'two', weight: 1, status_json: JSON.stringify({ capacity_free_ratio: 0.5 }),
      last_seen_at: null, reliability: reliabilityOf(doneRows(2)),
    };
    const tr = rankDispatchCandidates([two])[0]!;
    eq([tr.reliability.samples, tr.reliability.successRate], [2, 0.5], 'R-17 samples 2 ⇒ 排序用中性 0.5（samples 照实）');
    ok(explainSelection(tr).reason.includes('样本不足，按中性 50% 排序'), 'R-18 理由明写「样本不足」', explainSelection(tr).reason);
    ok(MIN_RELIABLE_SAMPLES === 3, 'R-19 可靠样本下限 = 3（与理由同源）');
  }
  // R-20 脏容量值一律按未知；0 是"已知满负荷"而非未知
  {
    eq(parseCapacity('{"capacity_free_ratio":1.5}'), { ratio: null, freeSlots: null }, 'R-20 越界比例按未知');
    eq(parseCapacity('{"capacity_free_ratio":0}').ratio, 0, 'R-21 比例 0 是已知值（与 null 不同）');
    eq(parseCapacity('not json'), { ratio: null, freeSlots: null }, 'R-22 坏 JSON 按未知');
    eq(parseCapacity('{"free_slots":3.7}').freeSlots, 3, 'R-23 槽位取整（不编小数）');
  }
}

// ══════════════════════════════════════════════════════════════════════
// P 进度上报与上屏
// ══════════════════════════════════════════════════════════════════════

const EVENT_DDL = `CREATE TABLE wa_event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL DEFAULT '',
  aggregate_id TEXT NOT NULL DEFAULT '',
  payload TEXT DEFAULT '{}',
  metadata TEXT DEFAULT '{}',
  occurred_at TEXT DEFAULT (datetime('now')))`;

function sectionP(): void {
  console.log('\n【P】M2：见——进度只印真数');
  // P-0 事件表缺失 ⇒ null（如实"没进度"）
  {
    const d = new DatabaseSync(':memory:');
    eq(relayProgressOf(asBetter(d), 't1'), null, 'P-1 事件表缺失 ⇒ null（不编 0 步）');
  }
  // P-2 有事件 ⇒ step/total/note 三真数
  {
    const d = new DatabaseSync(':memory:');
    d.exec(EVENT_DDL);
    const ins = d.prepare('INSERT INTO wa_event_log (event_type, aggregate_type, aggregate_id, payload) VALUES (?,?,?,?)');
    ins.run('task.estimated', 'task', 't1', JSON.stringify({ steps: 5 }));
    ins.run('task.step_finished', 'task', 't1', JSON.stringify({ toolCalls: '  Read   file  ' }));
    ins.run('task.step_finished', 'task', 't1', JSON.stringify({ toolCalls: 'Write  report.md' }));
    ins.run('task.step_finished', 'task', 'other', JSON.stringify({ toolCalls: '别家的步' }));
    eq(relayProgressOf(asBetter(d), 't1'), { step: 2, total: 5, note: 'Write report.md' },
      'P-2 step=已完成步数 / total=最近估时 / note=最近一步（且只数本任务）');
  }
  // P-3 表在但无行 ⇒ 0 步且 total 未知（不是 null——界面仍可显示"尚未走完第一步"）
  {
    const d = new DatabaseSync(':memory:');
    d.exec(EVENT_DDL);
    eq(relayProgressOf(asBetter(d), 'none'), { step: 0, total: null, note: '' }, 'P-3 表在无行 ⇒ step 0 / total null');
  }
  // P-4 非法估时（0/负数/非数）⇒ total null，不拿脏值当分母
  {
    const d = new DatabaseSync(':memory:');
    d.exec(EVENT_DDL);
    d.prepare('INSERT INTO wa_event_log (event_type, aggregate_type, aggregate_id, payload) VALUES (?,?,?,?)')
      .run('task.estimated', 'task', 't2', JSON.stringify({ steps: 0 }));
    eq(relayProgressOf(asBetter(d), 't2')?.total, null, 'P-4 估时 0 ⇒ total null（不出现 0/0 分母）');
  }
  // P-5 进度缓存：按请求隔离、清后可读空
  {
    resetDispatchProgressCache();
    recordDispatchProgress('r1', { step: 2, total: 5, note: '读文件', at: '2026-10-30T01:00:00.000Z' });
    eq(dispatchProgress('r1')?.step, 2, 'P-5 缓存回读 step=2');
    eq(dispatchProgress('r2'), null, 'P-6 未上报的单 ⇒ null（不串单）');
    recordDispatchProgress('r1', null);
    eq(dispatchProgress('r1'), null, 'P-7 清空后 ⇒ null');
    resetDispatchProgressCache();
  }
  // P-8 产物只对"还在路上"的单透出进度；无进度时界面如实标「对方未上报进度」
  {
    const log = readCode(`${MAIN}/node-dispatch-log.ts`);
    ok(log.includes("rec.status === 'pending' ? dispatchProgress(rec.requestId) : null"),
      'P-8 只有 pending 的行透出进度（已收口不挂旧进度）');
    const page = readText(`${A}/renderer/src/pages/PeersPage.tsx`);
    ok(page.includes('对方未上报进度'), 'P-9 无进度 ⇒ 如实「对方未上报进度」（不退化成 0%）');
    // 只认**渲染分支体**：注释里说"不退化成 0%"是允许的，屏幕上出现 0% 才是病。
    const noProgressBranch = page.slice(page.indexOf('if (!p) {'), page.indexOf('if (!p) {') + 220);
    ok(noProgressBranch.includes('对方未上报进度') && !noProgressBranch.includes('%'),
      'P-10 ★无进度分支不出现任何百分比', noProgressBranch.replace(/\s+/g, ' ').trim().slice(0, 100));
    ok(page.includes('最近一步') && page.includes('第 ${Math.min(p.step, p.total)}/${p.total} 步'),
      'P-11 文案写「最近一步」与「第 N/M 步」（不写"正在"）');
    ok(page.includes('已超出估时'), 'P-12 步数超估时如实标注');
  }
}

// ══════════════════════════════════════════════════════════════════════
// C 取消协议（真 runner + 内存真库）
// ══════════════════════════════════════════════════════════════════════

const RELAY_DDL = `
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0, source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '',
  quality_score REAL,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL,
  status TEXT DEFAULT 'draft', name TEXT, file_path TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverable_versions (id TEXT PRIMARY KEY, deliverable_id TEXT, file_path TEXT,
  content_snapshot TEXT DEFAULT '', size INTEGER DEFAULT 0, changed_by TEXT,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')));
${EVENT_DDL};`;

function freshRelayDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(RELAY_DDL);
  d.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run('relay-proj', RELAY_PROJECT_NAME);
  return d;
}
function relayCount(d: DatabaseSync, sql: string, ...p: unknown[]): number {
  return Number((d.prepare(sql).get(...(p as never[])) as { c: number }).c);
}
function newestTask(d: DatabaseSync): string {
  const row = d.prepare('SELECT id FROM wa_tasks ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as { id?: string } | undefined;
  return String(row?.id ?? '');
}
function mkReq(id: string): AnsNodeRequest {
  return {
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
    created_at: '2026-10-30 01:00:00',
    claimed_at: null,
    done_at: null,
  };
}

async function sectionC(): Promise<void> {
  console.log('\n【C】M3：止其可止——真停而不是挂起');
  // C-1 正常完成：回传附产出清单元数据
  {
    const d = freshRelayDb();
    ensureNodeRequestRunsTable(asLedger(d));
    let slept = 0;
    const progress: Array<{ step: number }> = [];
    const runner = makeRelayRunner({
      db: asBetter(d), pollMs: 1, progressMinIntervalMs: 0,
      sleep: async () => {
        slept++;
        if (slept === 1) {
          const tid = newestTask(d);
          d.prepare('INSERT INTO wa_deliverables (id, project_id, task_id, type, status, name) VALUES (?,?,?,?,?,?)')
            .run('del-1', 'relay-proj', tid, 'file', 'registered', '报告.md');
          d.prepare("UPDATE wa_tasks SET status = 'completed', context_json = ? WHERE id = ?")
            .run(JSON.stringify({ completion_summary: '做完了' }), tid);
        }
      },
    });
    const out = await runner(mkReq('r-done'), [], 'conversation', (p) => progress.push(p));
    eq(out.status, 'done', 'C-1 正常收口 done');
    eq((out.result as { outputs?: unknown }).outputs, [{ name: '报告.md', type: 'file' }], 'C-2 ★完成回传附产出清单（仅元数据）');
    ok(progress.length >= 1, 'C-3 起手即报一次进度（不等第一步走完）', `上报 ${progress.length} 次`);
    eq(findNodeRequestRun(asLedger(d), 'r-done')?.status, 'done', 'C-4 收口入账 done');
  }
  // C-5 起手后叫停：检查点真停（步数不再增长、轮询不再继续）、账 cancelled、任务归档、产物仍在
  {
    const d = freshRelayDb();
    ensureNodeRequestRunsTable(asLedger(d));
    let cancelled = false;
    let slept = 0;
    const runner = makeRelayRunner({
      db: asBetter(d), pollMs: 1, progressMinIntervalMs: 0,
      sleep: async () => {
        slept++;
        const tid = newestTask(d);
        if (slept === 1) {
          d.prepare("UPDATE wa_tasks SET status = 'executing' WHERE id = ?").run(tid);
          d.prepare('INSERT INTO wa_event_log (event_type, aggregate_type, aggregate_id, payload) VALUES (?,?,?,?)')
            .run('task.step_finished', 'task', tid, JSON.stringify({ toolCalls: '读文件' }));
          d.prepare('INSERT INTO wa_deliverables (id, project_id, task_id, type, status, name) VALUES (?,?,?,?,?,?)')
            .run('del-mid', 'relay-proj', tid, 'file', 'registered', '半成品.md');
        } else if (slept === 2) {
          cancelled = true;
        }
      },
    });
    const out = await runner(mkReq('r-cancel'), [], 'conversation', undefined, async () => cancelled);
    const tid = String((out.result as { taskId?: string }).taskId ?? '');
    eq(out.status, 'cancelled', 'C-5 检查点叫停 ⇒ 回传 cancelled');
    ok((out.result as { cancelled?: boolean }).cancelled === true, 'C-6 结果明确标 cancelled');
    eq(slept, 2, 'C-7 ★叫停后不再轮询（睡眠恰 2 次，未继续空转）');
    eq(relayProgressOf(asBetter(d), tid)?.step, 1, 'C-8 ★步数停在 1（检查点后不再增长）');
    eq(findNodeRequestRun(asLedger(d), 'r-cancel')?.status, 'cancelled', 'C-9 账记 cancelled（既非成也非败）');
    eq((d.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(tid) as { status?: string })?.status, 'archived',
      'C-10 任务真归档（不是 pause 幽灵）');
    eq(relayCount(d, "SELECT COUNT(*) AS c FROM wa_deliverables WHERE task_id = ? AND name = '半成品.md'", tid), 1,
      'C-11 产物仍在（叫停不抹已产出）');
    // C-12 重拉同一 req.id ⇒ 原样重放 cancelled，不建第二件
    const again = await runner(mkReq('r-cancel'), [], 'conversation', undefined, async () => cancelled);
    eq(again.status, 'cancelled', 'C-12 重放状态仍 cancelled');
    eq(String((again.result as { taskId?: string }).taskId ?? ''), tid, 'C-13 重放仍是同一 taskId');
    eq(relayCount(d, 'SELECT COUNT(*) AS c FROM wa_tasks'), 1, 'C-14 ★重放不新建任务');
  }
  // C-15 起手前叫停：不建任务、不落账
  {
    const d = freshRelayDb();
    ensureNodeRequestRunsTable(asLedger(d));
    const runner = makeRelayRunner({
      db: asBetter(d), pollMs: 1, sleep: async () => {},
    });
    const out = await runner(mkReq('r-early'), [], 'conversation', undefined, async () => true);
    eq(out.status, 'cancelled', 'C-15 起手前叫停 ⇒ cancelled');
    eq((out.result as { note?: string }).note, 'cancelled before start', 'C-16 理由如实「起手前已叫停」');
    eq(relayCount(d, 'SELECT COUNT(*) AS c FROM wa_tasks'), 0, 'C-17 ★不建任务（0 行）');
    eq(findNodeRequestRun(asLedger(d), 'r-early'), null, 'C-18 不落账');
  }
  // C-19 归档失败不谎称已停
  {
    const d = freshRelayDb();
    ensureNodeRequestRunsTable(asLedger(d));
    let cancelled = false;
    let slept = 0;
    const runner = makeRelayRunner({
      db: asBetter(d), pollMs: 1, sleep: async () => {
        slept++;
        const tid = newestTask(d);
        if (slept === 1) d.prepare("UPDATE wa_tasks SET status = 'executing' WHERE id = ?").run(tid);
        if (slept === 2) { cancelled = true; d.prepare('DELETE FROM wa_tasks WHERE id = ?').run(tid); }
      },
    });
    const out = await runner(mkReq('r-lost'), [], 'conversation', undefined, async () => cancelled);
    eq(out.status, 'error', 'C-19 归档没落笔 ⇒ 如实 error（不谎称已停）');
    ok(String((out.result as { error?: string }).error ?? '').includes('could not be archived'),
      'C-20 错误说明叫停未能生效', String((out.result as { error?: string }).error ?? ''));
    eq(findNodeRequestRun(asLedger(d), 'r-lost')?.status, 'error', 'C-21 账记 error（不记 cancelled）');
  }
  // C-22 已终态优先于叫停：同一拍既完成又叫停 ⇒ 如实回真实结局
  {
    const d = freshRelayDb();
    ensureNodeRequestRunsTable(asLedger(d));
    let cancelled = false;
    const runner = makeRelayRunner({
      db: asBetter(d), pollMs: 1, sleep: async () => {
        const tid = newestTask(d);
        d.prepare("UPDATE wa_tasks SET status = 'completed' WHERE id = ?").run(tid);
        cancelled = true;
      },
    });
    const out = await runner(mkReq('r-race'), [], 'conversation', undefined, async () => cancelled);
    eq(out.status, 'done', 'C-22 ★终态判定先于叫停（已完成的活不被改写成停止）');
  }
  // C-23 接线：真停走 archiveTask（不是 pauseTask）
  {
    const src = readCode(`${MAIN}/node-request-runner.ts`);
    const stop = src.slice(src.indexOf('const stopNow'), src.indexOf('ensureNodeRequestRunsTable(ledgerDb)'));
    ok(stop.includes("archiveTask(db, { taskId, reason: 'node_request_cancelled' })"), 'C-23 ★真停调用 archiveTask（通知在途执行体）');
    ok(!stop.includes('pauseTask('), 'C-24 真停不落回 pauseTask（不留恢复幽灵）');
  }
}

// ══════════════════════════════════════════════════════════════════════
// V 回执核对
// ══════════════════════════════════════════════════════════════════════

function sectionV(): void {
  console.log('\n【V】M4：认——三档回执，不越界');
  const at = '2026-10-30T01:00:00.000Z';
  const good = { taskId: 't1', taskStatus: 'completed', outputs: [{ name: 'a.md', type: 'file' }] };
  // V-1 verified：身份/终态/产出/本机痕四样全
  {
    const r = verifyRemoteReceipt({ localTaskId: 't1', result: good, hasLocalEvent: true, checkedAt: at });
    eq([r.verdict, r.missing, r.outputCount], ['verified', [], 1], 'V-1 四样齐 ⇒ verified');
    eq(receiptNote(r), '回执核对通过（1 项产物）', 'V-2 通过文案只说到回执自洽');
  }
  // V-3 self-reported：缺产出清单 ⇒ 自报，缺失项非空
  {
    const r = verifyRemoteReceipt({
      localTaskId: 't1', result: { taskId: 't1', taskStatus: 'completed', outputs: [] },
      hasLocalEvent: true, checkedAt: at,
    });
    eq([r.verdict, r.missing], ['self-reported', ['outputs']], 'V-3 无产出 ⇒ self-reported 且 missing 非空');
    eq(receiptNote(r), '对方自报完成，回执不全（缺：无产出清单）', 'V-4 自报文案点明缺项');
  }
  // V-5 无本机事件 ⇒ self-reported（缺 event）
  {
    const r = verifyRemoteReceipt({ localTaskId: 't1', result: good, hasLocalEvent: false, checkedAt: at });
    eq([r.verdict, r.missing], ['self-reported', ['event']], 'V-5 本机无痕 ⇒ self-reported（缺 event）');
  }
  // V-6 failed：任务号不符 / 终态非法
  {
    const r = verifyRemoteReceipt({ localTaskId: 't-local', result: good, hasLocalEvent: true, checkedAt: at });
    eq([r.verdict, r.missing], ['failed', ['taskId']], 'V-6 ★任务号不符 ⇒ failed（不记完成）');
    const r2 = verifyRemoteReceipt({
      localTaskId: 't1', result: { taskId: 't1', taskStatus: 'failed' }, hasLocalEvent: true, checkedAt: at,
    });
    eq([r2.verdict, r2.missing], ['failed', ['terminal']], 'V-7 终态非 completed ⇒ failed');
    ok(receiptNote(r2).includes('不记完成'), 'V-8 失败文案明说「不记完成」', receiptNote(r2));
  }
  // V-9 无清单键 ⇒ outputCount null（不把"没报"伪造成 0 项）
  {
    const r = verifyRemoteReceipt({
      localTaskId: 't1', result: { taskId: 't1', taskStatus: 'completed' }, hasLocalEvent: true, checkedAt: at,
    });
    eq(r.outputCount, null, 'V-9 缺 outputs 键 ⇒ outputCount null（不是 0）');
    eq(r.missing, ['outputs'], 'V-10 同样记为缺产出清单');
  }
  // V-11 驱动接线：failed 走 failed 收口；完成文案不越界说"本机验收"
  {
    const drv = readCode(`${MAIN}/node-remote-driver.ts`);
    ok(drv.includes('verifyRemoteReceipt({') && drv.includes('hasTaskEvent(db, taskId, assign.requestId)'),
      'V-11 驱动按本机事件痕核对回执');
    ok(drv.includes("if (receipt.verdict === 'failed')") && drv.includes('markTaskFailed'),
      'V-12 ★回执不符 ⇒ 本机如实 failed');
    ok(drv.includes('只核回执自洽，未重跑其产出'), 'V-13 完成文案守住边界（不冒称本机验收）');
    ok(drv.includes('[协同·回执不符]'), 'V-14 不符时留痕可读');
  }
}

// ══════════════════════════════════════════════════════════════════════
// K 集群聚合视图
// ══════════════════════════════════════════════════════════════════════

function ansNode(over: Partial<AnsNode> & { node_id: string }): AnsNode {
  return {
    name: over.node_id,
    api_key_prefix: 'kp',
    resource_group: 'rg',
    platform: 'darwin',
    role: 'worker',
    weight: 1,
    participate: true,
    capabilities: [],
    card: null,
    status: null,
    enrolled_at: '2026-10-01 00:00:00',
    last_seen_at: '2026-10-30 11:59:00',
    ...over,
  } as AnsNode;
}

function sectionK(): void {
  console.log('\n【K】M4：一屏答能/闲/稳/堵');
  const nowMs = Date.parse('2026-10-30T12:00:00Z');
  const dispatches = [
    { targetNodeId: 'peer1', status: 'done', durationMs: 1000 },
    { targetNodeId: 'peer1', status: 'done', durationMs: 1000 },
    { targetNodeId: 'peer1', status: 'done', durationMs: 1000 },
    { targetNodeId: 'peer1', status: 'error', durationMs: 1000 },
    { targetNodeId: 'peer1', status: 'cancelled', durationMs: 5000 },
    { targetNodeId: 'peer1', status: 'pending', durationMs: null },
    { targetNodeId: 'peer2', status: 'done', durationMs: 500 },
  ] as unknown as NodeDispatchRecord[];

  const nodes = [
    ansNode({
      node_id: 'local', name: '本机', role: 'coordinator',
      status: { machine_limit: 4, running_tasks: 9, free_slots: 9, cpu_usage_percent: 10, free_mem: 4, total_mem: 8, disk_free: 50, disk_total: 100 },
      card: { categories: ['text', 'code', 'bogus'] },
      last_seen_at: '2026-10-30 11:59:50',
    }),
    ansNode({
      node_id: 'peer1', name: '客厅', status: { machine_limit: 2, free_slots: 0, running_tasks: 1, cpu_usage_percent: 50 },
      last_seen_at: '2026-10-30 11:59:55',
    }),
    ansNode({ node_id: 'peer2', name: '书房', status: { running_tasks: 5 }, last_seen_at: '2026-10-30 10:00:00' }),
  ];

  const view = buildClusterView({
    nodes, localNodeId: 'local', localName: '本机', localRole: 'coordinator',
    local: { running: 2, queued: 2 }, dispatches, localTier: 'pro', nowMs,
  });

  eq(view.nodes.map((n) => n.id), ['local', 'peer1', 'peer2'], 'K-1 排序：本机置顶 → 在线优先 → 名字');
  eq(view.nodes.map((n) => n.tier), ['pro', null, null], 'K-2 ★本机档位读得到；他机档位不猜（null）');
  eq(view.nodes.map((n) => n.capabilities), [['text', 'code'], [], []], 'K-3 能力类目过滤非法值（不伪装全知）');
  eq(view.nodes[0]!.freeSlots, 2, 'K-4 ★本机空闲槽位=上限-实时占用（不信自身快照的 free_slots）');
  eq([view.nodes[0]!.running, view.nodes[0]!.queued], [2, 2], 'K-5 本机 running/queued 取实时计数');
  eq([view.nodes[1]!.running, view.nodes[1]!.queued], [1, 1], 'K-6 他机 running 取心跳、queued 取我方未收口派单');
  eq([view.nodes[1]!.successRate, view.nodes[1]!.latency], [0.75, 1000], 'K-7 ★成功率/均耗只认已收口单（取消不进分母）');
  eq(view.nodes[2]!.successRate, null, 'K-8 样本 < 3 ⇒ 成功率 null（不拿一单当"稳"）');
  eq([view.nodes[0]!.mem, view.nodes[0]!.disk], [0.5, 0.5], 'K-9 内存/磁盘可用比由既有字段派生');

  eq(view.totals, { online: 2, running: 3, queued: 3, offline: 1, atCapacity: 1 }, 'K-10 ★聚合数=逐行数之和，离线不计 running');
  eq(view.totals.running, view.nodes.filter((n) => n.online).reduce((s, n) => s + (n.running ?? 0), 0),
    'K-11 ★running 合计恰等于在线行之和（离线行不贡献）');
  eq(view.bottlenecks, ['1 台在线节点已满载', '3 单在排队，1 台空闲节点可接'], 'K-12 ★瓶颈文案非空且给出可接节点数');

  // K-13 没堵 ⇒ 不说堵
  const calm = buildClusterView({
    nodes: [ansNode({ node_id: 'a', status: { machine_limit: 4, free_slots: 2, running_tasks: 0 } })],
    localNodeId: 'a', localName: 'a', localRole: 'worker', local: { running: 0, queued: 0 },
    dispatches: [], localTier: 'community', nowMs,
  });
  eq(calm.bottlenecks, [], 'K-13 ★无满载无排队 ⇒ 瓶颈列表为空');
  eq(calm.totals.atCapacity, 0, 'K-14 未满载不计入 atCapacity');

  // K-15 槽位不可知 ⇒ 不说满载；离线行一律不算满载
  const unknown = buildClusterView({
    nodes: [
      ansNode({ node_id: 'u', status: { running_tasks: 9 } }),
      ansNode({ node_id: 'off', status: { free_slots: 0, machine_limit: 2 }, last_seen_at: '2026-10-29 00:00:00' }),
    ],
    localNodeId: 'me', localName: '本机', localRole: 'worker', local: { running: 0, queued: 0 },
    dispatches: [], localTier: 'community', nowMs,
  });
  eq(unknown.totals.atCapacity, 0, 'K-15 ★槽位未知或离线 ⇒ 不判满载（不知道就不说）');
  eq(unknown.nodes.length, 3, 'K-16 ★本机不在台账 ⇒ 合成一行（面板不丢本机）');
  eq(unknown.nodes[0]!.id, 'me', 'K-17 合成行仍置顶');

  // K-18 本机实时计数读口
  {
    const d = new DatabaseSync(':memory:');
    d.exec("CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, status TEXT)");
    const ins = d.prepare('INSERT INTO wa_tasks (id, status) VALUES (?, ?)');
    for (const [i, s] of ['executing', 'executing', 'planning', 'pending', 'pending', 'pending', 'completed'].entries()) {
      ins.run(`t${i}`, s);
    }
    eq(readLocalClusterCounts(d as never), { running: 3, queued: 3 }, 'K-18 ★执行中(含 preparing/planning) 与排队分两账');
    const empty = new DatabaseSync(':memory:');
    eq(readLocalClusterCounts(empty as never), { running: 0, queued: 0 }, 'K-19 表缺失 ⇒ 0（面板不因一张表缺而空）');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Q 容量真闸（五维）
// ══════════════════════════════════════════════════════════════════════

const BASE_DDL = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  working_dir TEXT DEFAULT '', context_json TEXT DEFAULT '{}');
CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL,
  memory_type TEXT DEFAULT 'semantic', importance REAL DEFAULT 0.5, reasoning TEXT DEFAULT '',
  source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '', valence TEXT DEFAULT 'neutral',
  context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0, exemplar_type TEXT,
  exemplar_context TEXT, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_project_knowledge (id TEXT PRIMARY KEY, project_id TEXT, section TEXT, content TEXT,
  source_ref TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (project_id, section));
CREATE TABLE wa_project_knowledge_imports (project_id TEXT, section TEXT, content TEXT,
  precedence INTEGER DEFAULT 0, source_hash TEXT DEFAULT '',
  PRIMARY KEY (project_id, section));
CREATE TABLE wa_knowledge_cards (id TEXT PRIMARY KEY, project_id TEXT, kind TEXT NOT NULL,
  text TEXT NOT NULL, source TEXT NOT NULL, confidence REAL DEFAULT 0.5, tokens INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active', updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (project_id, kind, source, text));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT,
  status TEXT, name TEXT, file_path TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL,
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', acceptance_criteria TEXT DEFAULT '');
`;

function freshBaseDb(opts: { trial?: boolean } = {}): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(BASE_DDL);
  if (opts.trial) {
    d.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)')
      .run(LICENSE_SETTING_KEYS.trialStartedAt, new Date().toISOString());
  }
  return d;
}

function sectionQ(): void {
  console.log('\n【Q】M5：限——到顶即拒，既有不动');
  // Q-1 尺：五维上限逐项钉（community/pro/team）
  {
    eq(
      ['maxDevices', 'maxExternalTerminals', 'maxA2AServers', 'maxKnowledgeCardsPerProject', 'maxTeamLibraryMemories']
        .map((f) => capacityLimit('community', f as never)),
      [5, 1, 1, 8, 200], 'Q-1 社区版五维上限逐项钉死');
    eq(
      ['maxDevices', 'maxExternalTerminals', 'maxA2AServers', 'maxKnowledgeCardsPerProject', 'maxTeamLibraryMemories']
        .map((f) => capacityLimit('pro', f as never)),
      [30, 3, 3, 24, 2000], 'Q-2 专业版五维上限逐项钉死');
    eq(
      ['maxDevices', 'maxExternalTerminals', 'maxA2AServers', 'maxKnowledgeCardsPerProject', 'maxTeamLibraryMemories']
        .map((f) => capacityLimit('team', f as never)),
      [200, 20, 10, 60, 0], 'Q-3 ★团队版五维上限逐项钉死（团队记忆不限）');
    ok(TIER_LIMITS.team.maxKnowledgeCardsPerProject === 60, 'Q-4 知识卡上限取自体派生常量（不手抄）');
  }
  // Q-5 判据：等于上限即拒，Note 含 N/M 与"已存在不受影响"
  {
    ok(capacityRefusal('community', 'maxDevices', 4).ok, 'Q-5 未到上限 ⇒ 放行');
    const v = capacityRefusal('community', 'maxDevices', 5);
    ok(!v.ok, 'Q-6 到上限 ⇒ 拒（天花板不是"再多一张也行"）');
    ok(v.note.includes('已用 5/5') && v.note.includes('已存在的记录不受影响'), 'Q-7 拒因给人话 N/M 与边界说明', v.note);
    ok(capacityRefusal('team', 'maxTeamLibraryMemories', 99999).ok, 'Q-8 上限 0 ⇒ 不限');
  }
  // Q-9 设备：第五台进、第六台拒；已有行一条不少；拒绝计数 0→1
  {
    const d = freshBaseDb();
    d.exec(`CREATE TABLE wa_devices (id TEXT PRIMARY KEY, name TEXT DEFAULT '', alias TEXT DEFAULT '',
      room TEXT DEFAULT '', kind TEXT DEFAULT 'unknown', kind_class TEXT NOT NULL DEFAULT '',
      protocol TEXT NOT NULL, address TEXT NOT NULL, port INTEGER, capabilities_json TEXT DEFAULT '[]',
      controllable INTEGER DEFAULT 0, authorized INTEGER DEFAULT 0, status_json TEXT,
      first_seen TEXT DEFAULT (datetime('now')), last_seen TEXT DEFAULT (datetime('now')), online INTEGER,
      UNIQUE (protocol, address))`);
    __resetDeviceCapacityRefusalsForTest();
    const add = (i: number) => upsertDiscovered(d as never, { name: `设备${i}`, kind: 'light', protocol: 'mdns', address: `10.0.0.${i}` });
    const accepted = [1, 2, 3, 4, 5].map((i) => add(i) !== null);
    eq(accepted, [true, true, true, true, true], 'Q-9 社区版前五台设备照常入账');
    eq(countDevices(d as never), 5, 'Q-10 计数 0→5');
    eq(add(6), null, 'Q-11 ★第六台被拒（不落库）');
    eq(countDevices(d as never), 5, 'Q-12 拒后行数不变（已存在行一条不少）');
    eq(getDeviceCapacityRefusals().count, 1, 'Q-13 ★拒绝计数 0→1（不是静默拦）');
    const updated = add(1);
    ok(updated !== null, 'Q-14 ★再发现既有设备不受闸影响（更新照常）');
    eq(findDeviceByIdentity(d as never, 'mdns', '10.0.0.1')?.id, updated?.id, 'Q-15 既有设备身份未变');
  }
  // Q-16 外部终端：批准已满 ⇒ capacity: 前缀；重复批先按 not_pending（分因不混）
  {
    const d = freshBaseDb();
    d.exec(`CREATE TABLE wa_external_terminals (id TEXT PRIMARY KEY, name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', pair_code TEXT NOT NULL, key_prefix TEXT,
      secret_hash TEXT, capabilities_json TEXT NOT NULL DEFAULT '[]', last_remote_addr TEXT,
      last_seen_at TEXT, created_at TEXT DEFAULT (datetime('now')), approved_at TEXT,
      revoked_at TEXT, delivered_at TEXT, grant_expires_at TEXT)`);
    const ins = d.prepare('INSERT INTO wa_external_terminals (id, name, status, pair_code) VALUES (?,?,?,?)');
    ins.run('term-ok', '已批', 'approved', 'c1');
    ins.run('term-wait', '待批', 'pending', 'c2');
    eq(countApprovedTerminals(d as never), 1, 'Q-16 已批准终端计数 = 1');
    const r = approveTerminal(d as never, 'term-wait');
    ok(!r.ok && r.ok === false && r.reason.startsWith('capacity:'), 'Q-17 ★到上限再批 ⇒ capacity: 前缀', r.ok === false ? r.reason : '');
    ok(r.ok === false && r.reason.includes('已用 1/1') && r.reason.includes('外部终端'), 'Q-18 拒因含维度名与 N/M');
    eq((d.prepare("SELECT status FROM wa_external_terminals WHERE id='term-ok'").get() as { status?: string })?.status,
      'approved', 'Q-19 已批准终端一条不动');
    eq((d.prepare("SELECT status FROM wa_external_terminals WHERE id='term-wait'").get() as { status?: string })?.status,
      'pending', 'Q-20 被拒的仍待批（状态不被静默改）');
    const again = approveTerminal(d as never, 'term-ok');
    ok(again.ok === false && again.reason === 'not_pending:approved', 'Q-21 ★重复批按 not_pending 分因，不误报容量', again.ok === false ? again.reason : '');
    // 拒因上屏前剥机器前缀（core 的 `capacity:` 是分因标记，不是人话）——两侧各钉一只标本。
    const cap = terminalReasonToError('capacity:社区版外部终端已达上限（已用 1/1）。已存在的记录不受影响；升级档位可提高上限。');
    ok(cap.code === 'CAPACITY_REACHED' && cap.message.startsWith('社区版外部终端已达上限') && !cap.message.includes('capacity:'),
      'Q-21b ★容量拒因上屏不带机器前缀', cap.message.slice(0, 60));
    const np = terminalReasonToError('not_pending:approved');
    ok(np.code === 'INVALID_STATE' && np.message.includes('approved'), 'Q-21c 反证：not_pending 分因照旧（前缀剥离不吞分因）', np.message);
  }
  // Q-22 团队共享记忆：200 条已导入 ⇒ 再导入被拒，既有一条不少
  {
    const d = freshBaseDb();
    const ins = d.prepare('INSERT INTO wa_memories (id, content, source) VALUES (?,?,?)');
    for (let i = 0; i < 200; i++) ins.run(`m${i}`, `共享记忆 ${i}`, 'team_library');
    eq(countTeamLibraryMemories(d as never), 200, 'Q-22 计数 0→200');
    const item = {
      id: 'shared-1', kind: 'memory' as const, title: '共享记忆', body: { content: '再来一条', importance: 0.5 },
      source_node_id: 'n1', created_at: '2026-10-30 01:00:00', updated_at: '2026-10-30 01:00:00',
    };
    const err = thrownOf(() => importItem(d as never, item));
    ok(err instanceof TeamLibraryError, 'Q-23 ★到顶再导入 ⇒ TeamLibraryError（IPC 可原样上屏）');
    ok(String((err as Error)?.message ?? '').includes('已用 200/200'), 'Q-24 拒因含 N/M', String((err as Error)?.message ?? ''));
    eq(countTeamLibraryMemories(d as never), 200, 'Q-25 被拒后既有 200 条一条不少');
  }
  // Q-26 A2A：到顶拒 + 拨端口之前判
  {
    const v = capacityRefusal('team', 'maxA2AServers', 10);
    ok(!v.ok && v.note.includes('已用 10/10'), 'Q-26 团队版 A2A 到 10 台即拒', v.note);
    ok(capacityRefusal('team', 'maxA2AServers', 9).ok, 'Q-27 未到顶照常放行');
    const src = readCode(`${MAIN}/a2a-runtime.ts`);
    const iGate = src.indexOf("capacityRefusal(resolveLicenseTier(opts.db), 'maxA2AServers'");
    // 只认**调用处**（`function allocatePort(): number` 的定义也含 `allocatePort()`，会误判先后）。
    const iPort = src.indexOf('= allocatePort();');
    ok(iGate > 0 && iPort > iGate, 'Q-28 ★容量闸在移交给 spawn/拨端口之前');
    ok(src.includes('A2A 服务无法启动：${verdict.note}'), 'Q-29 拒因带中文前缀原样上屏');
  }
  // Q-30 知识卡：团队版 61 条待并入 ⇒ 落 60、清 1；社区版一个不落（Pro 闸在先）
  {
    const d = freshBaseDb({ trial: true });
    // 走**生产写口**落 pending（其 id = cardId(...)）——若手写 `pend-N`，并入时 UNIQUE 冲突只改原行、
    //   清理段按 cardId 比对 ⇒ 会把刚并入的 60 张一并删掉，夹具失真会把真实现判红。
    for (let i = 1; i <= 61; i++) {
      recordPitfallCandidate(writeDb(d), 'p1', { taskTitle: `任务 ${String(i).padStart(2, '0')}`, failedItems: `要点 ${String(i).padStart(2, '0')}` });
    }
    eq(relayCount(d, "SELECT COUNT(*) AS c FROM wa_knowledge_cards WHERE project_id='p1' AND status='pending'"), 61,
      'Q-30a 夹具：生产写口落 61 条待并入');
    const res = distillKnowledgeCards(writeDb(d), 'p1');
    eq([res.cards, res.promoted, res.pruned], [60, 60, 1], 'Q-30 ★团队版上限 60：落 60、并入 60、清 1');
    eq(relayCount(d, "SELECT COUNT(*) AS c FROM wa_knowledge_cards WHERE project_id='p1' AND status='active'"), 60,
      'Q-31 表内 active 恰 60 张');
    const c = freshBaseDb();
    const ins2 = c.prepare('INSERT INTO wa_knowledge_cards (id, project_id, kind, text, source, confidence, tokens, status) VALUES (?,?,?,?,?,?,?,?)');
    ins2.run('pend-a', 'p1', 'pitfall', '社区版待并入要点', 'acceptance_check', 0.5, 4, 'pending');
    eq(distillKnowledgeCards(writeDb(c), 'p1'), { cards: 0, promoted: 0, pruned: 0 }, 'Q-32 ★社区版蒸馏直接返零（Pro 闸在先）');
    eq(relayCount(c, 'SELECT COUNT(*) AS c FROM wa_knowledge_cards'), 1, 'Q-33 社区版不写不删（待并入行原样留着）');
  }
}

// ══════════════════════════════════════════════════════════════════════
// B 项目知识增量与推荐
// ══════════════════════════════════════════════════════════════════════

const KNOWLEDGE_DDL = `
CREATE TABLE wa_knowledge_triples (id TEXT PRIMARY KEY, project_id TEXT, subject TEXT NOT NULL,
  predicate TEXT NOT NULL, object TEXT NOT NULL, confidence REAL DEFAULT 0.5, source TEXT DEFAULT 'x',
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_service_calls (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, kind TEXT, target TEXT,
  operation TEXT, ok INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0, error TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, status TEXT, payload TEXT DEFAULT '{}');
CREATE TABLE wa_task_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT DEFAULT 'custom',
  description TEXT DEFAULT '', subtasks TEXT DEFAULT '[]', keywords TEXT DEFAULT '[]',
  status TEXT DEFAULT 'active', priority INTEGER DEFAULT 0, source TEXT DEFAULT 'user',
  match_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_project_profiles (project_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1,
  source_hash TEXT NOT NULL DEFAULT '', profile_json TEXT NOT NULL,
  generated_at TEXT DEFAULT (datetime('now')), enabled INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL DEFAULT 'local', source_project_name TEXT DEFAULT '');
CREATE TABLE wa_domain_packs (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  pack_json TEXT NOT NULL, source_project_id TEXT, source_project_name TEXT DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'user', dismissed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_project_domain_packs (project_id TEXT NOT NULL, pack_id TEXT NOT NULL,
  applied_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, pack_id));
CREATE TABLE wa_knowledge_watermarks (project_id TEXT PRIMARY KEY, last_event_id INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT DEFAULT (datetime('now')), last_event_at TEXT DEFAULT '');
CREATE TABLE wa_device_actions (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, action TEXT NOT NULL,
  args_json TEXT DEFAULT '{}', result TEXT DEFAULT '', task_id TEXT DEFAULT '', actor_kind TEXT DEFAULT '',
  actor_ref TEXT DEFAULT '', plan_id TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
`;

function freshKnowledgeDb(): DatabaseSync {
  const d = freshBaseDb();
  d.exec(KNOWLEDGE_DDL);
  d.exec(EVENT_DDL);
  return d;
}

function sectionB(): void {
  console.log('\n【B】M6：荐——水位只前移，候选只建议');
  // B-1 水位：第一次吸收派生一次；第二次无新事件只记"跑过"，不再派生
  {
    const d = freshKnowledgeDb();
    d.prepare('INSERT INTO wa_projects (id, name) VALUES (?,?)').run('p1', '智能家居');
    const ins = d.prepare('INSERT INTO wa_event_log (event_type, aggregate_type, aggregate_id, payload, occurred_at) VALUES (?,?,?,?,?)');
    ins.run('task.created', 'project', 'p1', '{}', '2026-10-30 01:00:00');
    ins.run('task.completed', 'project', 'p1', '{}', '2026-10-30 01:01:00');
    let deriveCalls = 0;
    const derivation = {
      derive: () => { deriveCalls++; return [{ section: 'domain' as const, content: '术语：场景=一组设备联动', sourceRef: 'fake' }]; },
      upsert: () => 1,
    };
    const absorb = () => absorbProjectIncrement(
      d as unknown as Parameters<typeof absorbProjectIncrement>[0], 'p1',
      { derivation, runCandidate: false },
    );
    const first = absorb();
    eq([first.absorbedEvents, first.toEventId, deriveCalls, first.sections], [2, 2, 1, 1], 'B-1 首次吸收读 2 条事件并派生一次');
    eq([readWatermark(d as never, 'p1').lastEventId, unabsorbedCount(d as never, 'p1')], [2, 0], 'B-2 水位推到最新且积压清零');
    const second = absorb();
    eq([second.absorbedEvents, deriveCalls], [0, 1], 'B-3 ★第二次无新事件 ⇒ 不再全量派生（只读增量）');
    eq(readWatermark(d as never, 'p1').lastEventId, 2, 'B-4 水位不回退');
  }
  // B-5 水位只前移：MAX(旧, 新)
  {
    const d = freshKnowledgeDb();
    advanceWatermark(d as never, 'p1', 9, { eventAt: '2026-10-30 02:00:00' });
    advanceWatermark(d as never, 'p1', 3, { eventAt: '2026-10-30 01:00:00' });
    const wm = readWatermark(d as never, 'p1');
    eq([wm.lastEventId, wm.lastEventAt], [9, '2026-10-30 02:00:00'], 'B-5 ★回拨水位不生效（MAX-only）');
  }
  // B-6 候选包：origin=auto_candidate、未启用、按来源项目去重、忽略后不复活
  {
    const d = freshKnowledgeDb();
    d.prepare('INSERT INTO wa_projects (id, name, context_json) VALUES (?,?,?)').run(
      'p1', '智能家居',
      JSON.stringify({ language_game: { terminology: { 场景: '一组设备联动' }, conventions: ['图表须带误差棒'] } }),
    );
    d.prepare('INSERT INTO wa_projects (id, name) VALUES (?,?)').run('p2', '别的项目');
    const first = ensureAutoCandidateDomainPack(
      d as unknown as Parameters<typeof ensureAutoCandidateDomainPack>[0], 'p1');
    ok(first !== null && first.created, 'B-6 首次吸收生成候选包', JSON.stringify(first));
    const packs = listDomainPacks(d as never);
    eq([packs.length, packs[0]?.origin, packs[0]?.dismissed_at], [1, 'auto_candidate', null],
      'B-7 ★候选包 origin=auto_candidate 且未忽略');
    eq(relayCount(d, 'SELECT COUNT(*) AS c FROM wa_project_domain_packs'), 0, 'B-8 ★候选包未自动启用（0 条启用关系）');
    const again = ensureAutoCandidateDomainPack(
      d as unknown as Parameters<typeof ensureAutoCandidateDomainPack>[0], 'p1');
    ok(again !== null && again.created === false && again.id === first?.id, 'B-9 同项目只留一份（更新不新增）');
    eq(listSuggestedDomainPacks(d as never, 'p2').length, 1, 'B-10 别的项目能看到建议');
    eq(listSuggestedDomainPacks(d as never, 'p1').length, 0, 'B-11 来源项目自己看不到自己的候选');
    ok(dismissAutoCandidateDomainPack(d as never, first!.id), 'B-12 忽略候选生效');
    eq(listSuggestedDomainPacks(d as never, 'p2').length, 0, 'B-13 忽略后不再出现在建议里');
    eq(ensureAutoCandidateDomainPack(
      d as unknown as Parameters<typeof ensureAutoCandidateDomainPack>[0], 'p1'), null,
      'B-14 ★忽略过的候选不再复活');
  }
  // B-15 相似项目：≤3 且附理由；输入不足给空
  {
    const d = freshKnowledgeDb();
    const insP = d.prepare('INSERT INTO wa_projects (id, name, description) VALUES (?,?,?)');
    insP.run('pt', '智能家居 温控 设备', '客厅温控与设备联动');
    for (const id of ['c1', 'c2', 'c3', 'c4']) insP.run(id, '智能家居 温控 设备', '客厅温控与设备联动');
    insP.run('empty', '', '');
    const sims = similarProjects(d as never, 'pt');
    eq(sims.length, 3, 'B-15 ★相似项目最多 3 个');
    ok(sims.every((s) => s.reasons.length > 0), 'B-16 每个推荐都附理由（无据不推荐）', JSON.stringify(sims.map((s) => s.reasons)));
    ok(sims.every((s) => s.reasons.some((r) => r.includes('共同术语'))), 'B-17 理由含「共同术语」');
    eq(similarProjects(d as never, 'empty'), [], 'B-18 ★输入不足 ⇒ 空列表（不拿随机三个凑数）');
  }
}

// ══════════════════════════════════════════════════════════════════════
// T 卖点兑现
// ══════════════════════════════════════════════════════════════════════

function sectionT(): void {
  console.log('\n【T】M7：卖点逐条兑现');
  for (const tier of ['community', 'pro', 'team'] as const) {
    eq(benefitCoverageProblems(tier, PRICING[tier].benefits), [], `T-${tier} 真实价目表全兑现（${PRICING[tier].benefits.length} 条）`);
  }
  // T-反向一：多一句无闸卖点 ⇒ 点名"未登记兑现方式"
  {
    const extra = [...PRICING.pro.benefits, '凭空卖点：不限设备'];
    const problems = benefitCoverageProblems('pro', extra);
    eq(problems.length, 1, 'T-1 多一句 ⇒ 恰一条问题');
    ok(problems[0]!.startsWith('凭空卖点：不限设备') && problems[0]!.includes('未登记兑现方式'),
      'T-2 ★无闸卖点被点名', problems[0]);
  }
  // T-反向二：少一句已登记卖点 ⇒ 点名"价目表没有这句"
  {
    const dropped = PRICING.team.benefits[PRICING.team.benefits.length - 1]!;
    const problems = benefitCoverageProblems('team', PRICING.team.benefits.slice(0, -1));
    ok(problems.length === 1 && problems[0]!.includes('已登记但价目表没有这句'), 'T-3 ★删一句 ⇒ 登记腐化被点名', problems[0]);
    ok(problems[0]!.startsWith(dropped), 'T-4 点名的是被删的那一句', problems[0]);
  }
}

// ══════════════════════════════════════════════════════════════════════
// G 构建钉
// ══════════════════════════════════════════════════════════════════════

function sectionG(): void {
  console.log('\n【G】构建钉');
  checkBuildPins(ok, { distDir: path.join(ROOT, `${A}/dist`) });
}

// ══════════════════════════════════════════════════════════════════════
// H 收口卫生
// ══════════════════════════════════════════════════════════════════════

function sectionH(): void {
  console.log('\n【H】收口卫生');
  ok(ROUND_RE.test(SELF_ROUND), 'H-1 本轮标识由载体自身派生且格式合法', SELF_ROUND);

  const selfLines = stripKeepingLines(fs.readFileSync(__filename, 'utf-8'));
  const dud = selfLines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /(?:eq\([^,)]*,\s*|===?\s*|!==?\s*)'zx_\d{8}(?:_\d+)?'/.test(line));
  ok(dud.length === 0, 'H-2 本套件无「只为下一轮」字面量', dud.map((x) => `${x.i + 1}:${x.line.trim()}`).join(' | '));

  const selfText = fs.readFileSync(__filename, 'utf-8');
  const badGlyphs = [0x2717, 0x2713].map((c) => String.fromCodePoint(c));
  ok(!badGlyphs.some((g) => selfText.includes(g)), 'H-3 本套件文案无失败/通过字形（全量汇总器按失败字形计数）');
  ok(/通过 \/ .*失败/.test(selfText), 'H-4 收尾行如实印出断言数（通过 / 失败）');
}

async function main(): Promise<void> {
  console.log(`rr_${SELF_ROUND} 受控回归（协：择其能，尽其用，止其可止）`);
  sectionR();
  sectionP();
  await sectionC();
  sectionV();
  sectionK();
  sectionQ();
  sectionB();
  sectionT();
  sectionG();
  sectionH();
  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
}

main().then(() => {
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`rr_${SELF_ROUND} 未捕获异常（复跑未跑完，不得读作通过）：`, e);
  fail++;
  console.log(`\nFAIL rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
