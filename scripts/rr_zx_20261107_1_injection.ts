/**
 * zx_20261107_1 B4「实·通·信」受控回归 —— 注入 ROI 只读度量（管子·度量衡 / 夏克特·来源标注）。
 *
 * 钉住六件事：
 *   A 来源分账：五个词表来源按固定顺序给出（无行也给 0），词表外历史来源**如实保留**，
 *     合计与逐源逐项同值；项目口径与全库口径不混用；
 *   B 每任务明细：按最后更新时间倒序、`limit` 有界且多出的标 `truncated`、`bySource` 只列真有的来源；
 *   C 档位闸「先闸后读」：锁定 ⇒ 明细**零查询**且如实回拒因；合计全档可看；试用/过期两只标本；
 *   D 只读：不写注入行、不降权、不删记忆、不建新表；
 *   E 接线：写口与读口同引一处来源词表；IPC/预载/页面三跳齐全；不新增 Team 能力项。
 *
 * 纪律：零网络 / 零 electron / 零时钟；`now` 注入固定时刻；计数器有 0→1 正面断言。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildNotOlderThan, checkBuildPins, deriveBuildTag, stripKeepingLines } from './lib/rr-pins.js';
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
import {
  INJECTION_DETAIL_DEFAULT_LIMIT,
  INJECTION_DETAIL_MAX_LIMIT,
  injectionRoi,
  injectionRoiSummary,
  injectionTaskDetail,
  memoryInjectionStats,
} from '../apps/worker-ant-desktop/src/main/core/memory-injection-stats.js';
import {
  INJECTION_SOURCE,
  INJECTION_SOURCES,
  injectionSourceLabel,
} from '../apps/worker-ant-desktop/src/main/core/injection-sources.js';
import { TEAM_FEATURES } from '../apps/worker-ant-desktop/src/main/core/team-gate.js';
import { LICENSE_SETTING_KEYS } from '../apps/worker-ant-desktop/src/main/core/license.js';
import { estimateTokensFromChars } from '../apps/worker-ant-desktop/src/main/core/token-estimate.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'apps/worker-ant-desktop/src/main');
const CODE = (rel: string) => stripKeepingLines(fs.readFileSync(path.join(ROOT, rel), 'utf-8')).join('\n');

type AnyDb = import('better-sqlite3').Database;

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);
const near = (actual: number, expect: number, label: string) =>
  ok(Math.abs(actual - expect) < 1e-12, label, `${actual} vs ${expect}`);

const count = (db: DatabaseSync, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

/**
 * 生产同形夹具（列形状照 `database.ts` 与 `rr_zx_20261018_3` 的已证夹具）。
 * ⚠ 比生产宽或窄都是假的：宽则断言只是自我印证；窄则读语句抛错被 `try/catch` 吞成空 ⇒ 假绿。
 */
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', working_dir TEXT DEFAULT '', context_json TEXT DEFAULT '{}',
  sandbox_mode TEXT DEFAULT 'workspace', autonomous_mode TEXT DEFAULT 'off',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0,
  depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '', source TEXT DEFAULT 'user',
  acceptance_criteria TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  aggregate_version INTEGER DEFAULT 0, quality_score REAL);
CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL,
  embedding TEXT, memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5,
  reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '',
  valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0,
  exemplar_type TEXT, exemplar_context TEXT, use_count INTEGER DEFAULT 0, last_used_at TEXT,
  injected_count INTEGER DEFAULT 0, last_injected_at TEXT,
  similar_to TEXT DEFAULT '', last_reinforced_at TEXT, success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_context_injections (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source TEXT NOT NULL, ref_id TEXT NOT NULL,
  chars INTEGER NOT NULL DEFAULT 0, est_tokens INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_wa_context_injections_key ON wa_context_injections(task_id, source, ref_id);
`;

/** 先 `new` 服务类（建 FTS 触发器）再插行 —— 本仓明写的夹具顺序纪律。 */
const db = new DatabaseSync(':memory:');
db.exec(SCHEMA);
const memory = new MemoryManager(db as unknown as AnyDb, null as never);

const insProject = (id: string, name: string) =>
  db.prepare('INSERT INTO wa_projects (id, name, context_json) VALUES (?,?,?)').run(id, name, '{}');
const insTask = (id: string, pid: string, title: string, status: string) =>
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, description, status) VALUES (?,?,?,?,?)')
    .run(id, pid, title, '', status);
const insMem = (id: string, pid: string, content: string) =>
  db.prepare(`INSERT INTO wa_memories (id, project_id, task_id, content, memory_type, importance, valence, context_json, use_count, injected_count)
              VALUES (?,?,?,?,?,?,?,?,0,0)`)
    .run(id, pid, null, content, 'semantic', 0.8, 'neutral', JSON.stringify({ experience: 'direct' }));

/** 与读模型同尺：手插历史来源行时 est_tokens 也走真函数（不编数）。 */
const insLegacy = (id: string, task: string, source: string, ref: string, chars: number, outcome: string) =>
  db.prepare('INSERT INTO wa_context_injections (id, task_id, source, ref_id, chars, est_tokens, outcome) VALUES (?,?,?,?,?,?,?)')
    .run(id, task, source, ref, chars, estimateTokensFromChars(chars), outcome);

/** 许可库夹具（生产同形：`license.ts` 只读 `wa_settings` 的 key/value）。null = 未激活。 */
function settingsDb(trialStartIso: string | null): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec("CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))");
  if (trialStartIso) {
    d.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)').run(LICENSE_SETTING_KEYS.trialStartedAt, trialStartIso);
  }
  return d;
}
const NOW = new Date('2026-11-07T00:00:00.000Z');

/** 记录 SQL 的库代理：用来正面断言"锁定 ⇒ 明细一条查询都没发"。 */
function recording(real: DatabaseSync): { db: { prepare(sql: string): unknown }; sqls: string[] } {
  const sqls: string[] = [];
  return {
    db: {
      prepare(sql: string) {
        sqls.push(sql);
        return (real as unknown as { prepare(s: string): unknown }).prepare(sql);
      },
    },
    sqls,
  };
}

/** 注入行全文快照（判只读：条数与内容都不许动）。 */
const snapshot = (): string =>
  JSON.stringify(db.prepare('SELECT id, task_id, source, ref_id, chars, est_tokens, outcome FROM wa_context_injections ORDER BY id').all());

const src = (s: { sources: Array<{ source: string; injections: number; chars: number; completed: number; failed: number; pending: number }> }, key: string) =>
  s.sources.find((x) => x.source === key)!;

let injectedAtStart = 0;

function seed(): void {
  insProject('p1', '甲项目');
  insProject('p2', '乙项目');
  insTask('t1', 'p1', '甲任务一', 'completed');
  insTask('t2', 'p1', '甲任务二', 'failed');
  insTask('t3', 'p2', '乙任务', 'completed');
  insMem('m1', 'p1', '甲项目记忆第一条');
  insMem('m2', 'p1', '甲项目记忆第二条');
  insMem('m3', 'p2', '乙项目记忆');
}

// ═══ A｜来源分账 ═════════════════════════════════════════════════════════════
function sectionA(): void {
  console.log('\n【A】来源分账：六源固定顺序 + 历史来源不丢 + 合计逐项同值');

  // zx_20261113_1 B3「用」: 词表加第六源 position——按**更强形状**重定向，不删旧五源、不放宽。
  eq(INJECTION_SOURCES, ['memory', 'knowledge', 'knowledge_card', 'domain_pack', 'project_profile', 'position'],
    'A1 ★来源词表六源（写口/读口/界面同引这一处）');
  eq(Object.values(INJECTION_SOURCE).sort(), [...INJECTION_SOURCES].sort(), 'A2 常量映射与词表同集');
  eq(injectionSourceLabel('memory'), '记忆', 'A3 已知来源给人话名');
  eq(injectionSourceLabel('legacy_import'), 'legacy_import', 'A4 ★词表外历史来源原样上屏（不改写、不丢弃）');

  const before = injectionRoiSummary(db, 'p1');
  eq(before.totals.injections, 0, 'A5 0→1 前置：记录前合计为 0');

  const input = {
    knowledge: [{ ref_id: 'domain', chars: 120 }, { ref_id: 'conventions', chars: 80 }],
    memoryIds: ['m1'],
    domainPacks: [{ ref_id: 'dp-1', chars: 300 }],
    profiles: [{ ref_id: 'profile:abc', chars: 60 }],
    cards: [{ ref_id: 'kc-1', chars: 40 }],
  };
  const w1 = memory.recordContextInjections('t1', input);
  eq(w1, 6, 'A6 一次装配写 6 行（0→1 正面计数）');
  eq(memory.recordContextInjections('t1', input), 0, 'A7 ★重复装配同一批 ⇒ 0 新行（唯一键只留一行）');
  eq(memory.recordContextInjections('t2', { memoryIds: ['m2'] }), 1, 'A8 乙任务记住 1 行');
  eq(memory.recordContextInjections('t3', { knowledge: [{ ref_id: 'domain', chars: 50 }] }), 1, 'A9 丙任务知识 1 行');

  eq(memory.backfillInjectionOutcomes('t1', 'completed'), 6, 'A10 甲任务结局回填 6 行');
  eq(memory.backfillInjectionOutcomes('t2', 'failed'), 1, 'A11 乙任务结局回填 1 行');
  eq(memory.backfillInjectionOutcomes('t3', 'completed'), 1, 'A12 丙任务结局回填 1 行');
  eq(memory.backfillInjectionOutcomes('t1', 'failed'), 0, 'A13 ★已结清的账不再改写（只填 pending）');

  insLegacy('ci-legacy-1', 't1', 'legacy_import', 'old-1', 70, 'completed');
  insLegacy('ci-legacy-2', 't1', 'legacy_pending', 'old-2', 30, 'pending');
  injectedAtStart = count(db, 'wa_context_injections');
  eq(injectedAtStart, 10, 'A14 夹具注入行数 10（真写口 8 + 历史来源 2）');

  const s = injectionRoiSummary(db, 'p1');
  eq(s.sources.map((x) => x.source),
    [...INJECTION_SOURCES, 'legacy_import', 'legacy_pending'],
    'A15 ★六源固定顺序在前，词表外来源按名排序在后');

  const mem = src(s, 'memory');
  eq([mem.injections, mem.chars, mem.completed, mem.failed, mem.pending], [2, 16, 1, 1, 0], 'A16 记忆源 2 行 / 16 字 / 成败各 1');
  eq([src(s, 'knowledge').injections, src(s, 'knowledge').chars], [2, 200], 'A17 知识源 2 行 / 200 字');
  eq([src(s, 'domain_pack').injections, src(s, 'domain_pack').chars], [1, 300], 'A18 领域包 1 行 / 300 字');
  eq([src(s, 'project_profile').injections, src(s, 'project_profile').chars], [1, 60], 'A19 项目画像 1 行 / 60 字');
  eq([src(s, 'knowledge_card').injections, src(s, 'knowledge_card').chars], [1, 40], 'A20 知识卡 1 行 / 40 字');

  const t = s.totals;
  eq([t.injections, t.chars, t.completed, t.failed, t.pending, t.wasteChars], [9, 716, 7, 1, 1, 8],
    'A21 ★合计 9 行 / 716 字 / 7·1·1 / 白注入 8 字');
  near(t.successRate, 7 / 8, 'A22 成功率只按已结算行算（完成/完成+失败）');
  ok(t.label === '合计', 'A23 合计行有人话名');

  const sum = s.sources.reduce(
    (acc, x) => ({
      n: acc.n + x.injections, chars: acc.chars + x.chars, tokens: acc.tokens + x.estTokens,
      completed: acc.completed + x.completed, failed: acc.failed + x.failed, pending: acc.pending + x.pending,
      waste: acc.waste + x.wasteChars,
    }),
    { n: 0, chars: 0, tokens: 0, completed: 0, failed: 0, pending: 0, waste: 0 },
  );
  eq([sum.n, sum.chars, sum.tokens, sum.completed, sum.failed, sum.pending, sum.waste],
    [t.injections, t.chars, t.estTokens, t.completed, t.failed, t.pending, t.wasteChars],
    'A24 ★逐源相加 === 合计（一处口径，不是两套）');

  const p2 = injectionRoiSummary(db, 'p2');
  eq(p2.sources.map((x) => x.source), [...INJECTION_SOURCES],
    'A25 只有知识行的项目：六源仍全在（无行也给 0）');
  // 零来源个数由词表长度派生（p2 只有 1 个 knowledge 行），不手抄数字。
  eq(p2.sources.filter((x) => x.injections === 0).length, INJECTION_SOURCES.length - 1,
    'A26 ★零来源如实给 0（不是缺席）');
  eq([p2.totals.injections, p2.totals.chars, p2.totals.completed], [1, 50, 1], 'A27 项目口径只算本项目');

  const all = injectionRoiSummary(db);
  eq([all.totals.injections, all.totals.chars, all.totals.completed, all.totals.failed, all.totals.pending],
    [10, 766, 8, 1, 1], 'A28 全库口径 = 两项目相加');
  near(all.totals.successRate, 8 / 9, 'A29 全库成功率按已结算行');

  const legacy = memoryInjectionStats(db as unknown as AnyDb, 'p1');
  eq([legacy.injected, legacy.distinctMemories, legacy.completed, legacy.failed, legacy.pending, legacy.charsInjected, legacy.wasteChars],
    [2, 2, 1, 1, 0, 16, 8], 'A30 ★既有记忆口径读口不受影响（source=memory 专账）');

  eq(count(db, 'wa_context_injections'), injectedAtStart, 'A31 ★读模型只读：注入行数不动');
}

// ═══ B｜每任务明细 ═══════════════════════════════════════════════════════════
function sectionB(): void {
  console.log('\n【B】每任务明细：倒序 / 有界 / 只列真有来源');

  const setAt = (task: string, at: string) =>
    db.prepare('UPDATE wa_context_injections SET updated_at = ? WHERE task_id = ?').run(at, task);
  setAt('t1', '2026-11-07 10:00:00');
  setAt('t2', '2026-11-07 11:00:00');
  setAt('t3', '2026-11-07 09:00:00');

  const d = injectionTaskDetail(db, 'p1');
  eq(d.rows.map((r) => r.taskId), ['t2', 't1'], 'B1 ★按最后更新时间倒序（t2 11:00 → t1 10:00）');
  ok(!d.truncated, 'B2 未触上限 ⇒ 不标截断');
  const t1 = d.rows.find((r) => r.taskId === 't1')!;
  const t2 = d.rows.find((r) => r.taskId === 't2')!;
  eq([t1.title, t1.status, t1.lastAt], ['甲任务一', 'completed', '2026-11-07 10:00:00'], 'B3 任务名/状态/最后时刻如实');
  // 716（项目合计）− 8（乙任务的记忆行）= 708：甲任务含自己的记忆行 8 字。
  eq([t1.injections, t1.chars, t1.completed, t1.failed, t1.pending, t1.wasteChars], [8, 708, 7, 0, 1, 0],
    'B4 甲任务逐项与明细账同值');
  eq(t1.bySource.map((x) => x.source), ['domain_pack', 'knowledge', 'knowledge_card', 'legacy_import', 'legacy_pending', 'memory', 'project_profile'],
    'B5 ★bySource 按来源名排序且只列真有的来源');
  eq(t1.bySource.find((x) => x.source === 'knowledge')!.injections, 2, 'B6 来源内计数正确');
  eq(d.rows[0]!.bySource.map((x) => x.source), ['memory'], 'B7 ★单源任务不塞零来源');
  eq([t2.injections, t2.wasteChars], [1, 8], 'B8 失败任务白注入字数如实');

  const one = injectionTaskDetail(db, 'p1', 1);
  eq(one.rows.map((r) => r.taskId), ['t2'], 'B9 limit=1 只留最近一条');
  ok(one.truncated, 'B10 ★还有更多 ⇒ truncated=true（不静默截断）');

  eq(INJECTION_DETAIL_DEFAULT_LIMIT, 50, 'B11 默认明细条数 50');
  eq(INJECTION_DETAIL_MAX_LIMIT, 200, 'B12 明细上限 200（有界，不让一次读拖垮界面）');
  eq(injectionTaskDetail(db, 'p1', 10000).rows.length, 2, 'B13 超大 limit 被钳到上限后仍只返真有行');
  ok(!injectionTaskDetail(db, 'p1', 10000).truncated, 'B14 未超行数 ⇒ 不标截断');
  eq(injectionTaskDetail(db, 'p1', 0).rows.length, 1, 'B15 limit<1 钳到 1（不返空）');

  eq(injectionTaskDetail(db, 'p2').rows.map((r) => [r.taskId, r.injections]), [['t3', 1]], 'B16 项目口径明细');
  eq(injectionTaskDetail(db, 'p-none'), { rows: [], truncated: false }, 'B17 无注入的项目 ⇒ 空明细，不抛');
}

// ═══ C｜档位闸「先闸后读」 ═══════════════════════════════════════════════════
function sectionC(): void {
  console.log('\n【C】档位闸：合计全档可看；明细先过 Team「审计视图」闸，锁定 ⇒ 零查询');

  const community = settingsDb(null);
  const locked = injectionRoi(db as never, community as never, 'p1', { now: NOW, fingerprint: 'fp-test' });
  ok(!locked.detail.unlocked, 'C1 未激活（社区档）⇒ 明细锁定');
  ok(locked.detail.refusal.includes('审计视图') && locked.detail.refusal.includes('团队版'),
    'C2 ★拒因点名能力与档位（不是"操作失败"）', locked.detail.refusal);
  eq([locked.detail.rows, locked.detail.truncated], [[], false], 'C3 锁定 ⇒ 明细整块为空');
  // 六源 + 两个历史来源（数量由词表派生，不手抄）。
  eq(locked.summary.sources.length, INJECTION_SOURCES.length + 2, 'C4 ★合计账仍全档可看（锁的是明细，不是全部）');
  eq(locked.summary.totals.injections, 9, 'C5 锁定档的合计值照旧可核');

  const rec = recording(db);
  const lockedRec = injectionRoi(rec.db as never, community as never, 'p1', { now: NOW, fingerprint: 'fp-test' });
  ok(!lockedRec.detail.unlocked, 'C6 代理库上同样锁定');
  eq(rec.sqls.filter((s) => /GROUP BY\s+ci\.task_id/i.test(s)), [],
    'C7 ★★锁定 ⇒ 明细查询一条都没发（先闸后读，不是"查完再藏"）');
  ok(rec.sqls.some((s) => /GROUP BY\s+ci\.source/i.test(s)), 'C8 反证：代理确实记录了合计查询（不是空跑）');

  const trial = settingsDb('2026-11-01T00:00:00.000Z');
  const open = injectionRoi(db as never, trial as never, 'p1', { now: NOW, fingerprint: 'fp-test' });
  ok(open.detail.unlocked, 'C9 ★试用期内（kind=trial）⇒ 明细解锁');
  eq(open.detail.refusal, '', 'C10 解锁 ⇒ 无拒因');
  eq(open.detail.rows.map((r) => r.taskId), ['t2', 't1'], 'C11 解锁 ⇒ 明细照常给');

  const rec2 = recording(db);
  injectionRoi(rec2.db as never, trial as never, 'p1', { now: NOW, fingerprint: 'fp-test' });
  ok(rec2.sqls.some((s) => /GROUP BY\s+ci\.task_id/i.test(s)),
    'C12 ★反证：解锁时同一个判据真能抓到明细查询（C7 不是判据恒空）');

  const expired = injectionRoi(db as never, settingsDb('2026-01-01T00:00:00.000Z') as never, 'p1', { now: NOW, fingerprint: 'fp-test' });
  ok(!expired.detail.unlocked, 'C13 ★过期试用 ⇒ 锁定（不是"有设置就放行"）');

  const noDb = injectionRoi(db as never, null, 'p1', { now: NOW, fingerprint: 'fp-test' });
  ok(!noDb.detail.unlocked, 'C14 无许可库 ⇒ 锁定（fail-open 方向：能力不可用，页面不崩）');

  const limitedOpen = injectionRoi(db as never, trial as never, 'p1', { now: NOW, fingerprint: 'fp-test', limit: 1 });
  ok(limitedOpen.detail.truncated && limitedOpen.detail.rows.length === 1, 'C15 limit 透传到明细（不影响闸）');

  eq(count(db, 'wa_context_injections'), injectedAtStart, 'C16 ★三次闸判定 + 两次明细读取后注入行数仍不动');
}

// ═══ D｜只读 ═════════════════════════════════════════════════════════════════
function sectionD(): void {
  console.log('\n【D】只读：不改写注入行、不降权、不删记忆、不建新表');

  const file = CODE('apps/worker-ant-desktop/src/main/core/memory-injection-stats.ts');
  const roiPart = file.slice(file.indexOf('export interface InjectionSourceRoi'));
  ok(roiPart.length > 0, 'D1 定位到 ROI 读模型段');
  ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i.test(roiPart),
    'D2 ★读模型段没有任何写语句（账是事实，不是待优化的队列）');
  ok(!/CREATE\s+TABLE/i.test(file), 'D3 ★没有新表（沿用既有注入明细账）');

  const before = snapshot();
  const memBefore = JSON.stringify(db.prepare('SELECT id, use_count, injected_count, importance FROM wa_memories ORDER BY id').all());
  injectionRoiSummary(db, 'p1');
  injectionTaskDetail(db, 'p1');
  injectionRoi(db as never, settingsDb('2026-11-01T00:00:00.000Z') as never, 'p1', { now: NOW, fingerprint: 'fp-test' });
  eq(snapshot(), before, 'D4 ★注入行逐字段不变（读口不碰账）');
  eq(JSON.stringify(db.prepare('SELECT id, use_count, injected_count, importance FROM wa_memories ORDER BY id').all()),
    memBefore, 'D5 ★记忆不被降权、不被删除、计数不动');
}

// ═══ E｜接线与档位 ═══════════════════════════════════════════════════════════
function sectionE(): void {
  console.log('\n【E】接线：写读同源 + IPC/预载/页面三跳 + 不新增 Team 能力项');

  const mm = CODE('apps/worker-ant-desktop/src/main/core/memory-manager.ts');
  const wStart = mm.indexOf('recordContextInjections(');
  const wEnd = mm.indexOf('backfillInjectionOutcomes(');
  const writer = wStart >= 0 && wEnd > wStart ? mm.slice(wStart, wEnd) : '';
  ok(writer.includes('INJECTION_SOURCE.knowledge') && writer.includes('INJECTION_SOURCE.domainPack')
    && writer.includes('INJECTION_SOURCE.projectProfile') && writer.includes('INJECTION_SOURCE.knowledgeCard')
    && writer.includes('INJECTION_SOURCE.memory'), 'E1 ★五源写口同引自一处词表');
  // 每源一处写口——数量由词表长度派生（加第六源 position 不用改这里）。
  eq((writer.match(/INJECTION_SOURCE\./g) ?? []).length, INJECTION_SOURCES.length, 'E2 写口每源恰一处（不重不漏）');
  ok(!/'(memory|knowledge|knowledge_card|domain_pack|project_profile)'/.test(writer),
    'E3 ★写口不再手抄来源字面量（第二落点已收）');

  const stats = CODE('apps/worker-ant-desktop/src/main/core/memory-injection-stats.ts');
  ok(stats.includes("teamFeatureRefusal(licDb, 'audit_view'"), 'E4 ★明细复用既有「审计视图」软闸');
  const sIdx = stats.indexOf('const summary = injectionRoiSummary(db, projectId);');
  const gIdx = stats.indexOf('teamFeatureRefusal(licDb, \'audit_view\'');
  ok(sIdx >= 0 && gIdx > sIdx, 'E5 ★先算合计、再判闸、最后才查明细（语句次序即「先闸后读」）');

  const admin = CODE('apps/worker-ant-desktop/src/main/ipc/admin.ipc.ts');
  ok(admin.includes("ipcMain.handle('memory:injectionRoi'"), 'E6 IPC 处理器在册');
  ok(/injectionRoi\(db, db, projectId, \{ limit \}\)/.test(admin), 'E7 ★主进程把同一库同时喂给统计与闸');
  ok(/typeof input\?\.projectId === 'string'/.test(admin) && /typeof input\?\.limit === 'number'/.test(admin),
    'E8 入参逐项校验（字符串/数字，缺失即 undefined）');

  const preload = CODE('apps/worker-ant-desktop/renderer/src/lib/ipc.ts');
  ok(/injectionRoi: \(projectId\?: string, limit\?: number\)/.test(preload), 'E9 预载类型化调用在册');
  ok(/ipcCall<InjectionRoiView>\('memory:injectionRoi', \{ projectId, limit \}\)/.test(preload),
    'E10 ★通道名与入参两端一致（不是"头大脚轻"）');
  ok(preload.includes("from '../../../src/main/core/memory-injection-stats.js'"), 'E11 形状同引 main 真源');

  const page = CODE('apps/worker-ant-desktop/renderer/src/pages/MemoriesPage.tsx');
  ok(/admin\.injectionRoi\(projFilter \|\| undefined\)/.test(page), 'E12 页面按当前项目筛选取数');
  ok(page.includes('roi.summary.sources.map') && page.includes('roi.summary.totals'), 'E13 来源表与合计行上屏');
  ok(page.includes('roi.detail.unlocked') && page.includes('roi.detail.refusal'), 'E14 ★锁定档如实显示拒因');
  ok(page.includes('roi.detail.truncated'), 'E15 还有更多时如实标注');
  ok(page.includes('只读：不自动降权、不删记忆'), 'E16 面板明写只读边界');

  ok((TEAM_FEATURES as readonly string[]).includes('audit_view'), 'E17 闸挂在既有 Team 能力上');
  ok(!(TEAM_FEATURES as readonly string[]).some((f) => /inject|roi/i.test(f)),
    'E18 ★未为注入 ROI 新增 Team 能力项（不凑数）');

  const { tag } = deriveBuildTag(fs.readFileSync(path.join(DESKTOP, 'core/agent-executor.ts'), 'utf-8'));
  ok(buildNotOlderThan(tag, SELF_ROUND), 'E19 build 标识不早于脚本轮次（方向性派生）', `${tag} vs ${SELF_ROUND}`);
  ok(fs.existsSync(path.join(DESKTOP, 'core/injection-sources.ts')), 'E20 来源词表载体在册');
  checkBuildPins(ok, { rootDir: ROOT });
}

seed();
sectionA();
sectionB();
sectionC();
sectionD();
sectionE();

console.log(`\n[rr_${SELF_ROUND}_injection] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
