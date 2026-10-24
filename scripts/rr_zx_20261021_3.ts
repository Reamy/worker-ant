/**
 * zx_20261021_3 受控复跑 —— 「传」：领域包可携带、能力卡可自述、档位卖点可兑现。
 *
 * 分组（与本轮方案 §2 一一对应）：
 *   A 派生确定性　B 应用幂等（0→1）　C 注入账　D 有界诚实（整节丢弃）
 *   E Pro 闸两只标本　F 共享往返（导入≠启用）　G 能力卡六键与隐私　H 接线/口径
 *
 * 纪律（承 CLAUDE.md 与 auto-memory）：
 *   · 用**生产函数**直引（被删/改名即编译期失败，不扫空字符串冒充覆盖）。
 *   · 计数器类断言一律给 **0→1 / 1→0** 正面值，不以"不抛"代替。
 *   · 夹具按**生产初始化顺序**与生产列同形（缺表/少列一律红，而不是被 try/catch 吞成假绿）。
 *   · 不写"只为下一轮"的字面量：build 轮次由 `checkBuildPins` 从真源派生核对。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import {
  DOMAIN_PACK_INJECT_MAX_TOKENS,
  DOMAIN_PACK_MAX_CHARS,
  DOMAIN_PACK_SECTION_LABEL,
  DOMAIN_PACK_SECTIONS,
  DOMAIN_PACK_VERSION,
  applyDomainPack,
  createDomainPack,
  deriveDomainPack,
  domainPackInjectionStats,
  insertDomainPack,
  listAppliedDomainPacks,
  listDomainPacks,
  parseDomainPackJson,
  renderDomainPackSection,
  unapplyDomainPack,
  type DomainPackPayload,
} from '../apps/worker-ant-desktop/src/main/core/domain-pack.js';
import { deriveProjectKnowledge } from '../apps/worker-ant-desktop/src/main/core/project-knowledge.js';
import { buildMemoryContext } from '../apps/worker-ant-desktop/src/main/core/memory-context.js';
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
import { PRO_FEATURES, PRO_FEATURE_LABEL } from '../apps/worker-ant-desktop/src/main/core/pro-gate.js';
import { benefitCoverageProblems, BENEFIT_COVERAGE } from '../apps/worker-ant-desktop/src/main/core/tier-catalog.js';
import { PRICING } from '../apps/worker-ant-desktop/src/main/core/pricing.js';
import { LICENSE_SETTING_KEYS } from '../apps/worker-ant-desktop/src/main/core/license.js';
import {
  TEAM_ITEM_KIND_LABEL,
  TEAM_ITEM_KINDS,
  type TeamItem,
} from '../packages/shared-types/src/team.js';
import { importItem, listLocalItems, shareItem } from '../apps/worker-ant-desktop/src/main/core/team-library.js';
import { buildAgentCard } from '../apps/worker-ant-desktop/src/main/core/inbound-gate.js';
import { EXTERNAL_CAPABILITIES } from '../apps/worker-ant-desktop/src/main/core/external-calls.js';
import { INTENTS } from '../apps/worker-ant-desktop/src/main/core/intent-protocol.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}
const thrownOf = (fn: () => unknown): unknown => {
  try { fn(); return null; } catch (e) { return e; }
};

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');
const count = (db: DatabaseSync, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

/** 生产同形的九类既有表 + 领域包两表 + 设置表（`license.ts` 只读 key/value 两列）。 */
function makePackDb(opts: { trial?: boolean } = {}): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE wa_knowledge_triples (
    id TEXT PRIMARY KEY, project_id TEXT, subject TEXT NOT NULL, predicate TEXT NOT NULL,
    object TEXT NOT NULL, confidence REAL DEFAULT 0.5, source TEXT DEFAULT 'x',
    created_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`CREATE TABLE wa_deliverables (
    id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT, status TEXT, name TEXT, file_path TEXT,
    created_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`CREATE TABLE wa_service_calls (
    id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, kind TEXT, target TEXT, operation TEXT,
    ok INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0, error TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, status TEXT, payload TEXT)`);
  d.exec(`CREATE TABLE wa_tasks (
    id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, status TEXT DEFAULT 'pending',
    context_json TEXT DEFAULT '{}', acceptance_criteria TEXT DEFAULT '')`);
  // 列形状照抄生产（database.ts）：`listLocalItems` 按 `updated_at` / `importance` 排序，
  //   夹具少列会在**运行时**抛 no such column，从而照出"假报零"以外的真缺陷。
  d.exec(`CREATE TABLE wa_task_templates (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT DEFAULT 'custom',
    description TEXT DEFAULT '', subtasks TEXT DEFAULT '[]', keywords TEXT DEFAULT '[]',
    status TEXT DEFAULT 'active', priority INTEGER DEFAULT 0, source TEXT DEFAULT 'user',
    match_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`CREATE TABLE wa_memories (
    id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL, embedding TEXT,
    memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5, reasoning TEXT DEFAULT '',
    source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '', valence TEXT DEFAULT 'neutral',
    context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0, exemplar_type TEXT,
    exemplar_context TEXT, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`CREATE TABLE wa_projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
    working_dir TEXT DEFAULT '', context_json TEXT DEFAULT '{}')`);
  d.exec(`CREATE TABLE wa_device_actions (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL, action TEXT NOT NULL,
    args_json TEXT DEFAULT '{}', result TEXT DEFAULT '', task_id TEXT DEFAULT '',
    actor_kind TEXT DEFAULT '', actor_ref TEXT DEFAULT '', plan_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')))`);
  // 生产同形（database.ts）：资产表与启用关系**刻意分两表**。
  d.exec(`CREATE TABLE wa_domain_packs (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
    pack_json TEXT NOT NULL, source_project_id TEXT, source_project_name TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`CREATE TABLE wa_project_domain_packs (
    project_id TEXT NOT NULL, pack_id TEXT NOT NULL,
    applied_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, pack_id))`);
  // zx_20261022_3 批八：共享库第五类画像的资产表（逐列照抄 database.ts）。
  //   缺此表 ⇒ `listLocalItems` 的画像读语句运行时抛 no such table（本套件实测踩中）。
  d.exec(`CREATE TABLE wa_project_profiles (
    project_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1,
    source_hash TEXT NOT NULL DEFAULT '', profile_json TEXT NOT NULL,
    generated_at TEXT DEFAULT (datetime('now')), enabled INTEGER NOT NULL DEFAULT 1,
    origin TEXT NOT NULL DEFAULT 'local', source_project_name TEXT DEFAULT '')`);
  d.exec(`CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  if (opts.trial) {
    d.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)')
      .run(LICENSE_SETTING_KEYS.trialStartedAt, new Date().toISOString());
  }
  return d;
}

/** p1 的三节真源；p2 作不串味反证。 */
function seedKnowledge(d: DatabaseSync): void {
  const p = (sql: string, ...a: unknown[]) => d.prepare(sql).run(...a);
  p(`INSERT INTO wa_projects (id, name, context_json) VALUES (?,?,?)`, 'p1', '智能家居',
    JSON.stringify({ language_game: { terminology: { 场景: '一组设备联动' }, conventions: ['图表须带误差棒'] } }));
  p(`INSERT INTO wa_knowledge_triples (id, project_id, subject, predicate, object, confidence) VALUES (?,?,?,?,?,?)`,
    't1', 'p1', '客厅台灯', 'controlled_by', 'worker-ant', 0.9);
  p(`INSERT INTO wa_knowledge_triples (id, project_id, subject, predicate, object, confidence) VALUES (?,?,?,?,?,?)`,
    'tx', 'p2', '别家的东西', 'belongs_to', '别的项目', 0.99);
  p(`INSERT INTO wa_tasks (id, project_id, title, status, context_json, acceptance_criteria) VALUES (?,?,?,?,?,?)`,
    'k1', 'p1', '开灯与关门', 'pending', '{}', '灯亮且门锁上');
  p(`INSERT INTO wa_tasks (id, project_id, title, status, context_json, acceptance_criteria) VALUES (?,?,?,?,?,?)`,
    'k2', 'p1', '布置客厅', 'failed', JSON.stringify({ pause_reason: 'acceptance_failed' }), '');
  p(`INSERT INTO wa_tasks (id, project_id, title, status, context_json, acceptance_criteria) VALUES (?,?,?,?,?,?)`,
    'kx', 'p2', '别家的任务', 'failed', JSON.stringify({ pause_reason: 'no_output' }), '别家判据');
  p(`INSERT INTO wa_task_templates (id, name, category, description, status, priority) VALUES (?,?,?,?,?,?)`,
    'tpl1', '布置客厅', 'home', '先清点后摆放', 'active', 5);
  p(`INSERT INTO wa_memories (id, project_id, content, memory_type, is_exemplar) VALUES (?,?,?,?,?)`,
    'm1', 'p1', '先清点再摆放，避免返工', 'semantic', 1);
  p(`INSERT INTO wa_memories (id, project_id, content, memory_type, is_exemplar) VALUES (?,?,?,?,?)`,
    'mx', 'p2', '别家的样板', 'semantic', 1);
}

/** 一条可落库的包（派生真源之外的最小形状；用于 B/C/F 组）。 */
function samplePack(over: Partial<DomainPackPayload> = {}): DomainPackPayload {
  return {
    version: DOMAIN_PACK_VERSION,
    name: '客厅自动化经验',
    description: '可携带的三节',
    sections: [
      { section: 'domain', content: '术语：场景＝一组设备联动' },
      { section: 'criteria', content: '验收：灯亮且门锁上' },
    ],
    source: { project_id: 'p1', project_name: '智能家居' },
    derived_at: '2026-10-21T00:00:00.000Z',
    training: false,
    omitted_sections: [],
    ...over,
  };
}

/** buildMemoryContext 的桩：缺的方法一律抛，由生产侧的逐段 try/catch 兜住（同既有套件范式）。 */
function memoryStub(input: {
  applied?: ReturnType<typeof listAppliedDomainPacks>;
  knowledge?: Array<{ section: 'domain'; content: string }>;
}): MemoryManager {
  const h: Record<string, unknown> = {
    getTaskArchetype: () => null,
    getTaskText: () => '',
    listAppliedDomainPacks: () => input.applied ?? [],
    listDomainKnowledge: () => input.knowledge ?? [],
  };
  return new Proxy({} as Record<string, unknown>, {
    get: (_t, k) => {
      if (k in h) return h[String(k)];
      return () => { throw new Error(`未桩化: ${String(k)}`); };
    },
  }) as unknown as MemoryManager;
}

/** 注入账夹具：MemoryManager 构造要先有 `wa_memories`（FTS 触发器建于行之前，顺序即纪律）。 */
function makeLedgerDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE wa_memories (
    id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL,
    memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5, reasoning TEXT DEFAULT '',
    source TEXT DEFAULT 'x', valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}',
    is_exemplar INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  d.exec('CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT)');
  d.exec(`CREATE TABLE wa_context_injections (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source TEXT NOT NULL, ref_id TEXT NOT NULL,
    chars INTEGER NOT NULL DEFAULT 0, est_tokens INTEGER NOT NULL DEFAULT 0,
    outcome TEXT NOT NULL DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')))`);
  d.exec('CREATE UNIQUE INDEX idx_wa_context_injections_key ON wa_context_injections(task_id, source, ref_id)');
  d.exec('CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT)');
  d.prepare('INSERT INTO wa_tasks (id, project_id, title) VALUES (?,?,?)').run('t-1', 'p1', '搬经验');
  d.exec(`CREATE TABLE wa_domain_packs (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', pack_json TEXT NOT NULL,
    source_project_id TEXT, source_project_name TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`INSERT INTO wa_domain_packs (id, name, description, pack_json, source_project_id, source_project_name)
          VALUES ('dp-1', '客厅自动化经验', '可携带的三节', '{}', 'p1', '智能家居')`);
  return d;
}

async function main(): Promise<void> {
  // ═══ A｜派生确定性 ═══════════════════════════════════════════════════════════
  console.log('\n【A】派生：只取三节、可复现、不夹带不可迁移项');
  let trialDb: DatabaseSync | null = null;
  {
    const d = makePackDb();
    seedKnowledge(d);
    const r = deriveDomainPack(d as never, 'p1', { now: '2026-10-21T00:00:00.000Z' });
    if (!r.ok) { ok(false, 'A-0 前置：夹具应派生出包', r.reason); }
    else {
      const pack = r.pack;
      eq(pack.sections.map((s) => s.section), [...DOMAIN_PACK_SECTIONS],
        'A-1 ★节恰为词表三节（domain / criteria / recipes），按词表序');
      eq([pack.version, pack.training], [DOMAIN_PACK_VERSION, false],
        'A-2 版本与 `training:false` 写死（包格式契约的一部分）');
      const full = deriveProjectKnowledge(d as never, 'p1').map((s) => s.section);
      ok(full.includes('entities') || full.includes('index') || full.includes('runtime'),
        'A-3 前置：整册确有词表外的节（否则"A-4 只取三节"无从成立）', full.join(','));
      ok(pack.sections.every((s) => (DOMAIN_PACK_SECTIONS as readonly string[]).includes(s.section)),
        'A-4 ★包内无词表外的节（entities / artifacts / services / usage / index / runtime 一概不带）');
      const raw = JSON.stringify(pack);
      ok(!/sourceRef|entities|artifacts|services|usage|"index"|runtime/.test(raw),
        'A-5 ★★包体全文不含 `sourceRef` 与不可迁移节名（本机出处不入包）');
      const again = deriveDomainPack(d as never, 'p1', { now: '2026-10-21T00:00:00.000Z' });
      eq(JSON.stringify(again), JSON.stringify(r), 'A-6 ★同一夹具两次派生逐字节相同（时间戳由入参钉住）');
      eq(pack.omitted_sections, [], 'A-7 未超界 ⇒ 零丢弃（"全带走了"是如实值）');
      eq(pack.source, { project_id: 'p1', project_name: '智能家居' }, 'A-8 出处＝项目 id + 项目名');
    }
    const fresh = makePackDb();
    const empty = deriveDomainPack(fresh as never, 'p-none', { now: '2026-10-21T00:00:00.000Z' });
    ok(!empty.ok && /暂无/.test(empty.reason), 'A-9 空库 ⇒ 如实说"没得带"，不伪造空包');
    fresh.close();
    // 另一侧：同一空项目在**有全局模板**的库里仍带得出 recipes——模板本就无 project_id，
    //   这是既有语义（`project-knowledge` 头注写明"全局模板"），不在这里另立一套。
    const onlyGlobal = deriveDomainPack(d as never, 'p-none', { now: '2026-10-21T00:00:00.000Z' });
    eq(onlyGlobal.ok ? onlyGlobal.pack.sections.map((s) => s.section) : onlyGlobal.reason,
      ['recipes'], 'A-10 ★全局模板不随项目走：空项目也能带走它（如实，不是串味）');
    d.close();
  }

  // ═══ B｜应用幂等（0→1 / 1→0）════════════════════════════════════════════════
  console.log('\n【B】应用是"关系表加一行"，幂等且可撤');
  {
    const d = makePackDb({ trial: true });
    trialDb = d;
    // 试用档夹具同时备好 p1 的真源——C/E 组要在这份库上真派生（不另造桩数据）。
    seedKnowledge(d);
    const packId = insertDomainPack(d as never, samplePack());
    eq(count(d, 'wa_domain_packs'), 1, 'B-0 资产落库 0→1');
    eq(count(d, 'wa_project_domain_packs'), 0, 'B-1 ★前置自证：启用映射起初 0 行（导入/落库≠启用）');
    const r1 = applyDomainPack(d as never, 'p1', packId);
    eq([r1.applied, count(d, 'wa_project_domain_packs')], [true, 1], 'B-2 ★首次应用 applied=true 且映射 0→1');
    const r2 = applyDomainPack(d as never, 'p1', packId);
    eq([r2.applied, r2.reason, count(d, 'wa_project_domain_packs')], [false, 'already_applied', 1],
      'B-3 ★再次应用是"本来就在"，不重复插行');
    eq(unapplyDomainPack(d as never, 'p1', packId), true, 'B-4 取消启用真删了一行');
    eq(count(d, 'wa_project_domain_packs'), 0, 'B-5 ★映射 1→0');
    eq(unapplyDomainPack(d as never, 'p1', packId), false, 'B-6 再撤一次返回 false（幂等，不抛）');
    const miss = applyDomainPack(d as never, 'p1', 'no-such-pack');
    eq([miss.applied, miss.reason, count(d, 'wa_project_domain_packs')], [false, 'no_such_pack', 0],
      'B-7 包不存在 ⇒ 如实拒，且不建悬空映射');
    eq(applyDomainPack(d as never, '', packId).reason, 'no_such_project', 'B-8 项目 id 为空 ⇒ 如实拒');
  }

  // ═══ C｜注入账：文与账同一次构造 ═════════════════════════════════════════════
  console.log('\n【C】注入：整包进段、逐包记一行；省略即零行');
  let appliedPackId = '';
  let appliedPackName = '';
  {
    const d = trialDb!;
    const created = createDomainPack(d as never, 'p1');
    if (!created.ok) { ok(false, 'C-0 前置：试用档应能生成', created.reason); }
    else {
      appliedPackId = created.id;
      appliedPackName = created.pack.name;
      applyDomainPack(d as never, 'p1', created.id);
      const applied = listAppliedDomainPacks(d as never, 'p1');
      eq([applied.length, applied[0]?.id, applied[0]?.sections.length], [1, created.id, 3],
        'C-1 已启用包读回：1 个、三节齐全');

      const out = buildMemoryContext(memoryStub({ applied }), 'p1', undefined, undefined, null, undefined, 60_000);
      ok(out.domainPackText.startsWith('## 领域包'), 'C-2 ★`buildMemoryContext` 真装配出「领域包」段');
      eq(out.domainPackInjections.map((x) => x.ref_id), [created.id],
        'C-3 ★注入行恰 1 行且 `ref_id`＝包 id');
      ok((out.domainPackInjections[0]?.chars ?? 0) > 0, 'C-4 字数 > 0（不是空账）',
        String(out.domainPackInjections[0]?.chars));

      const none = buildMemoryContext(memoryStub({ applied: [] }), 'p1', undefined, undefined, null, undefined, 60_000);
      eq([none.domainPackText, none.domainPackInjections.length], ['', 0],
        'C-5 ★未启用 ⇒ 段为空、账零行（没有"注入过"这回事）');

      // 预算不足：段被 `selectMemorySections` 整段省略 ⇒ 同样零行（不写空账）。
      const tiny = buildMemoryContext(
        memoryStub({
          applied,
          knowledge: [{ section: 'domain', content: '术语：'.padEnd(300, '甲') }],
        }),
        'p1', undefined, undefined, null, undefined, 300,
      );
      ok(tiny.knowledgeText.length > 0, 'C-6 前置：本项目事实段在场（证明预算真的起作用，而不是没内容）');
      eq([tiny.domainPackText, tiny.domainPackInjections.length], ['', 0],
        'C-7 ★★整段被预算省略 ⇒ 零行注入账（入文与记账同一把尺）');

      // 真实写口：0→1 且唯一键幂等。
      const ld = makeLedgerDb();
      const mm = new MemoryManager(ld as never, null as never);
      const before = (ld.prepare("SELECT COUNT(*) AS c FROM wa_context_injections WHERE source = 'domain_pack'").get() as { c: number }).c;
      eq(before, 0, 'C-8 ★前置自证：注入账起初 0 行');
      const w1 = mm.recordContextInjections('t-1', { domainPacks: [{ ref_id: 'dp-1', chars: 42 }] });
      eq(w1, 1, 'C-9 ★写口真写进去（返回 1，不是"不抛"）');
      const row = ld.prepare("SELECT source, ref_id, chars, est_tokens, outcome FROM wa_context_injections WHERE task_id = 't-1'").get() as
        Record<string, unknown>;
      eq([row.source, row.ref_id, row.chars, row.est_tokens, row.outcome],
        ['domain_pack', 'dp-1', 42, 11, 'pending'],
        'C-10 行内四样如实：来源/指向/字数/估 token（初记 pending）');
      eq(mm.recordContextInjections('t-1', { domainPacks: [{ ref_id: 'dp-1', chars: 42 }] }), 0,
        'C-11 ★重复装配不记第二笔（唯一键天生幂等）');
      eq(count(ld, 'wa_context_injections'), 1, 'C-12 ★行数仍是 1');
      const stats = domainPackInjectionStats(ld as never, 'p1');
      eq([stats.injections, stats.chars, stats.packs.length, stats.packs[0]?.pack_id, stats.packs[0]?.name],
        [1, 42, 1, 'dp-1', '客厅自动化经验'],
        'C-13 ★读口可下钻：行数/字数按项目聚合，并 JOIN 出包名（记了有人看）');
      ld.close();
    }
  }

  // ═══ D｜有界诚实：整节丢弃，绝不截半句 ═══════════════════════════════════════
  console.log('\n【D】超界：按 recipes → criteria → domain 整节丢弃并如实登记');
  {
    const d = makePackDb();
    // 领域节靠 terminology 撑大（该处无条数上限），验收与配方各按上限灌满。
    const terminology: Record<string, string> = {};
    for (let i = 0; i < 300; i++) terminology[`术语${i}`] = `${'甲'.repeat(38)}${i}`;
    d.prepare('INSERT INTO wa_projects (id, name, context_json) VALUES (?,?,?)')
      .run('p1', '大项目', JSON.stringify({ language_game: { terminology } }));
    for (let i = 0; i < 10; i++) {
      d.prepare('INSERT INTO wa_tasks (id, project_id, title, status, acceptance_criteria) VALUES (?,?,?,?,?)')
        .run(`k${i}`, 'p1', `任务${i}`, 'pending', `${'验'.repeat(300)}${i}`);
      d.prepare('INSERT INTO wa_task_templates (id, name, category, description, status, priority) VALUES (?,?,?,?,?,?)')
        .run(`tpl${i}`, `模板${i}`, 'big', `${'说明'.repeat(80)}${i}`, 'active', i);
    }
    const derived = deriveProjectKnowledge(d as never, 'p1');
    const picked = derived.filter((s) => (DOMAIN_PACK_SECTIONS as readonly string[]).includes(s.section));
    const total = picked.reduce((n, s) => n + s.content.length, 0);
    ok(total > DOMAIN_PACK_MAX_CHARS,
      'D-1 ★前置自证：夹具三节合计真的超过上限（否则"有界"这条全是空转）', `${total} > ${DOMAIN_PACK_MAX_CHARS}`);
    const r = deriveDomainPack(d as never, 'p1', { now: '2026-10-21T00:00:00.000Z' });
    if (!r.ok) {
      // 全丢光是合法结局（见 D-5），本夹具预期仍留 domain。
      ok(false, 'D-2 本夹具预期仍留领域节', r.reason);
    } else {
      const kept = r.pack.sections;
      ok(kept.length > 0 && kept.length < picked.length,
        'D-2 ★丢了一些、留了一些（不是全留也不是全丢）', kept.map((s) => s.section).join(','));
      eq(r.pack.omitted_sections, ['recipes', 'criteria'],
        'D-3 ★丢弃次序 = 低价值先走（配方 → 验收），domain 最后');
      const sumKept = kept.reduce((n, s) => n + s.content.length, 0);
      ok(sumKept <= DOMAIN_PACK_MAX_CHARS, 'D-4 ★留下部分不越界', `${sumKept} <= ${DOMAIN_PACK_MAX_CHARS}`);
      // 绝不截字：留下的每一节与真源**逐字节相等**。
      for (const s of kept) {
        const src = picked.find((p) => p.section === s.section)!;
        ok(s.content === src.content, `D-5 ★★留下的 ${s.section} 节与真源逐字节相等（不是截半句）`);
      }
      ok(r.pack.sections.every((s) => !s.content.endsWith('…') || s.content === picked.find((p) => p.section === s.section)!.content),
        'D-6 包内没有"自己加的省略号"式截断');
    }

    // 极端：domain 一节就超上限 ⇒ 全丢光 ⇒ 如实拒，且不落库。
    const dx = makePackDb();
    const huge: Record<string, string> = {};
    for (let i = 0; i < 600; i++) huge[`词${i}`] = `${'乙'.repeat(38)}${i}`;
    dx.prepare('INSERT INTO wa_projects (id, name, context_json) VALUES (?,?,?)')
      .run('p1', '超大项目', JSON.stringify({ language_game: { terminology: huge } }));
    const all = deriveDomainPack(dx as never, 'p1', { now: '2026-10-21T00:00:00.000Z' });
    ok(!all.ok && /整节丢弃后无可携带内容/.test(all.reason),
      'D-7 ★单节即超界 ⇒ 全丢后如实说"没得带"，不硬塞半句');
    eq(count(dx, 'wa_domain_packs'), 0, 'D-8 派生失败 ⇒ 零落库（没有半成品包）');
    dx.close();
    d.close();
  }

  // ═══ E｜Pro 闸（两只标本）═══════════════════════════════════════════════════
  console.log('\n【E】闸在"生成/启用"，不在"注入/撤销"');
  {
    const com = makePackDb();
    seedKnowledge(com);
    const c1 = createDomainPack(com as never, 'p1');
    ok(!c1.ok && c1.code === 'FEATURE_REQUIRED' && c1.reason.includes(PRO_FEATURE_LABEL.domain_pack) && c1.reason.includes('专业版'),
      'E-1 ★社区档生成被拒：拒因含人话名与升级指引', c1.ok ? 'ok' : c1.reason);
    eq(count(com, 'wa_domain_packs'), 0, 'E-2 ★★被拒 ⇒ 真的一行没落（不是"先写再回滚"）');
    const pid = insertDomainPack(com as never, samplePack());
    const a1 = applyDomainPack(com as never, 'p1', pid);
    ok(a1.applied === false && typeof a1.refusal === 'string' && a1.refusal.includes('专业版'),
      'E-3 ★社区档启用被拒（另一侧标本：同一判据、不同动作口）');
    eq(count(com, 'wa_project_domain_packs'), 0, 'E-4 被拒 ⇒ 映射零行');
    com.prepare('INSERT INTO wa_project_domain_packs (project_id, pack_id) VALUES (?,?)').run('p1', pid);
    eq(unapplyDomainPack(com as never, 'p1', pid), true,
      'E-5 ★★撤销**永不挂闸**：社区档也撤得掉（用户必须能收回带在身上的东西）');
    com.close();

    const trial = trialDb!;
    const packsBefore = count(trial, 'wa_domain_packs');
    const t1 = createDomainPack(trial as never, 'p1');
    ok(t1.ok, 'E-6 ★另一侧标本：试用（＝专业版能力）⇒ 放行生成');
    eq(count(trial, 'wa_domain_packs'), packsBefore + 1, 'E-7 资产计数真 +1（生成真落库）');
    // 清掉 C 组留下的启用关系，让下面看到干净的 0→1（否则只是"又多了一行"）。
    if (appliedPackId) unapplyDomainPack(trial as never, 'p1', appliedPackId);
    const a2 = applyDomainPack(trial as never, 'p1', t1.ok ? t1.id : '');
    eq([a2.applied, count(trial, 'wa_project_domain_packs')], [true, 1], 'E-8 试用档启用 ⇒ 映射 0→1');

    // 降级：删掉试用起点 ⇒ 已应用的包**仍注入**；但**新生成**被拒。
    trial.prepare('DELETE FROM wa_settings WHERE key = ?').run(LICENSE_SETTING_KEYS.trialStartedAt);
    const stillApplied = listAppliedDomainPacks(trial as never, 'p1');
    const rendered = renderDomainPackSection(stillApplied);
    eq([stillApplied.length, rendered.injections.length], [1, 1],
      'E-9 ★★降级不回收：已启用的包照样读回、照样注入（软闸不破坏已生效的东西）');
    const after = createDomainPack(trial as never, 'p1');
    ok(!after.ok && after.code === 'FEATURE_REQUIRED', 'E-10 ★降级后**新造**的仍被拒（闸只管"获得与搬运"）');
  }

  // ═══ F｜共享往返：导入 ≠ 启用 ══════════════════════════════════════════════
  console.log('\n【F】共享往返：体保真、导入只落资产、类目拒绝文案由词表派生');
  {
    const d = makePackDb({ trial: true });
    const localId = insertDomainPack(d as never, samplePack({ source: { project_id: '', project_name: '远端项目' } }));
    const shared = shareItem(d as never, 'domain_pack', localId);
    eq([shared.kind, shared.title, shared.body.training, shared.body.sections.length],
      ['domain_pack', '客厅自动化经验', false, 2],
      'F-1 ★共享体：类目/名称/`training:false`/节数随行');
    const remote: TeamItem = {
      id: 'remote-pack', kind: 'domain_pack', title: '远端经验',
      body: {
        version: 1, name: '远端经验', description: '对端整理',
        sections: [{ section: 'criteria', content: '验收：并发不超过 4' }],
        source: { project_id: 'peer-p', project_name: '远端项目' },
        derived_at: '2026-10-21T00:00:00.000Z', training: false, omitted_sections: [],
      },
      source_node_id: 'peer-9', created_at: '2026-10-21 00:00:00', updated_at: '2026-10-21 00:00:00',
    };
    const before = count(d, 'wa_domain_packs');
    const imported = importItem(d as never, remote);
    eq([imported.kind, imported.target, count(d, 'wa_domain_packs')], ['domain_pack', 'wa_domain_packs', before + 1],
      'F-2 ★导入落到资产表（计数 +1）');
    eq(count(d, 'wa_project_domain_packs'), 0,
      'F-3 ★★导入 ≠ 启用：映射表仍是 0 行（不替用户做决定）');
    const row = d.prepare('SELECT source_project_id, source_project_name, pack_json FROM wa_domain_packs WHERE id = ?')
      .get(imported.id) as Record<string, unknown>;
    eq([row.source_project_id, row.source_project_name], [null, '远端项目'],
      'F-4 ★跨机项目 id 置 NULL（只留项目名作出处）');
    const body = parseDomainPackJson(row.pack_json)!;
    eq([body.training, body.source.project_id, body.sections.length], [false, '', 1],
      'F-5 ★包体内 training 保真、内层 project_id 亦置空串');
    const e = thrownOf(() => importItem(d as never, { ...remote, kind: 'bogus' as never }));
    ok(e instanceof Error && e.message.includes('共享类型'), 'F-6 词表外类目 ⇒ 拒绝（不落库）');

    // 类目词表：人话名覆盖全部五种，且 ANS 报错文案**由词表派生**（不手抄）。
    // zx_20261022_3 批八：`project_profile` 入册（4→5；逐成员枚举仍不放宽）。
    eq([...TEAM_ITEM_KINDS], ['template', 'memory', 'deliverable', 'domain_pack', 'project_profile'],
      'F-7 ★共享类型词表五类（唯一定处 shared-types）');
    for (const k of TEAM_ITEM_KINDS) ok(TEAM_ITEM_KIND_LABEL[k].length > 0, `F-8 人话名非空：${k}`);
    const ansTeam = CODE('apps/ans-server/src/routes/team.ts');
    ok(/TEAM_ITEM_KINDS\.join\(/.test(ansTeam), 'F-9 ★ANS 报错文案由 `TEAM_ITEM_KINDS` 派生（不手抄类目串）');
    ok(!/template\s*\/\s*memory\s*\/\s*deliverable/.test(ansTeam), 'F-10 ★反证：ANS 里没有手抄的三类旧串');
    const local = listLocalItems(d as never);
    eq([local.templates.length, local.memories.length, local.deliverables.length, local.domainPacks.length, local.profiles.length],
      [0, 0, 0, 2, 0], 'F-11 候选五列俱在（领域包列真读到本机资产；画像表可读且本夹具无画像）');
    d.close();
  }

  // ═══ G｜能力卡：类目公开、清单遮蔽 ═══════════════════════════════════════════
  console.log('\n【G】门牌六键；类目/意图由真源派生，实例清单零出现');
  {
    const card = buildAgentCard('阳台的工蚁', '0.1.0');
    eq(Object.keys(card).sort(),
      ['agent_version', 'intents', 'name', 'offered_capabilities', 'pairing', 'protocol'],
      'G-1 ★顶层恰六键（无第七样）');
    eq(card.offered_capabilities.map((c) => c.key), [...EXTERNAL_CAPABILITIES],
      'G-2 ★能力类目 ⊆ 且＝`EXTERNAL_CAPABILITIES`（派生，不手抄）');
    ok(card.offered_capabilities.every((c) => c.requires_approval === true),
      'G-3 每一项都"须经配对与勾选"');
    eq(card.intents.map((i) => i.id), INTENTS.map((i) => i.id),
      'G-4 ★意图目录＝`INTENTS` 的 id 集（派生）');
    const json = JSON.stringify(card);
    ok(!/"(devices|rooms|room_id|device_id|node_id|alias|address|port|status_json|authorized|call_name)"/.test(json),
      'G-5 ★★卡全文无设备清单/实例/网络坐标/授权态字段', json);
    const room = card.intents.flatMap((i) => i.params).find((p) => p.key === 'room');
    eq(room, { key: 'room', label: '房间', required: true },
      'G-6 ★★房间参数无枚举（协议词汇可以公开，屋里有哪些房间不行）');

    // 负面标本：库里塞一台设备，卡内容一字不变（卡不读库）。
    const d = makePackDb();
    d.exec(`CREATE TABLE wa_devices (id TEXT PRIMARY KEY, name TEXT, alias TEXT, kind TEXT,
      protocol TEXT, address TEXT, port INTEGER, authorized INTEGER)`);
    const before = JSON.stringify(buildAgentCard('阳台的工蚁', '0.1.0'));
    d.prepare('INSERT INTO wa_devices (id, name, alias, kind, protocol, address, port, authorized) VALUES (?,?,?,?,?,?,?,?)')
      .run('dev-1', '客厅台灯', '台灯', 'light', 'mqtt', '192.168.1.50', 1883, 1);
    const after = JSON.stringify(buildAgentCard('阳台的工蚁', '0.1.0'));
    eq(after, before, 'G-7 ★★反证：库里多一台设备，门牌一字不变（也就无从泄露设备行）');
    const body = CODE(`${A}/src/main/core/inbound-gate.ts`);
    const fn = body.slice(body.indexOf('export function buildAgentCard'));
    const fnBody = fn.slice(0, fn.indexOf('\n}\n'));
    ok(!/wa_devices|listDevices|\bdb\b/.test(fnBody), 'G-8 ★门牌组装体不触库（静态反证）');
    d.close();
  }

  // ═══ H｜接线与口径 ═══════════════════════════════════════════════════════════
  console.log('\n【H】接线：GUI / IPC / 装配 / 价目兑现 / 账本注释 / build 钉');
  {
    // renderer：项目详情真有「领域包」页签，且真引卡组件（不是只加了个字符串）。
    const pd = CODE(`${A}/renderer/src/pages/ProjectDetailPage.tsx`);
    ok(/import DomainPackCard from '\.\.\/components\/DomainPackCard'/.test(pd),
      'H-1 ★项目详情真引 `DomainPackCard`');
    ok(/\{k:'packs',l:'领域包'\}/.test(pd), 'H-2 页签「领域包」在册');
    ok(/activeTab === 'packs'/.test(pd) && /<DomainPackCard/.test(pd),
      'H-3 ★页签渲染分支真挂卡（不是只摆一个标签）');
    ok(/setPackTick\(/.test(pd), 'H-4 事件刷新与既有页签同形（tick 重挂）');

    // renderer：共享库第 4 列由词表派生。
    const tl = CODE(`${A}/renderer/src/pages/TeamLibraryPage.tsx`);
    ok(/TEAM_ITEM_KINDS\.map\(/.test(tl), 'H-5 ★共享库列由 `TEAM_ITEM_KINDS` 派生（不手抄四类）');
    ok(/domainPacks/.test(tl), 'H-6 领域包候选真有取数映射');

    // IPC：五个通道在册，且启动时真注册。
    const ipc = CODE(`${A}/src/main/ipc/packs.ipc.ts`);
    const channels = [...ipc.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]!);
    eq(channels.sort(), ['packs:apply', 'packs:derive', 'packs:list', 'packs:stats', 'packs:unapply'],
      'H-7 ★五个通道逐成员枚举');
    ok(/proFeatureRefusal|FEATURE_REQUIRED/.test(ipc), 'H-8 闸拒走 `FEATURE_REQUIRED`（与知识导出同形）');
    const idx = CODE(`${A}/src/main/index.ts`);
    ok(/import \{ initPacksIpc \}/.test(idx) && /initPacksIpc\(db\)/.test(idx),
      'H-9 ★启动真注册（不是只建了文件）');

    // 执行器：注入行真被交到写口，且沿用"入文才记账"的裁剪判定。
    const ex = CODE(`${A}/src/main/core/agent-executor.ts`);
    ok(/built\.domainPackInjections/.test(ex) && /domainPacks: domainPackRows/.test(ex),
      'H-10 ★注入行真传进 `recordContextInjections`');
    ok(/memoryDomainPackText && !memTextAfterTrim\.includes\(memoryDomainPackText\)/.test(ex),
      'H-11 ★与知识包同一把尺：只记**真入文**的注入（裁剪后不在文里就不记账）');

    // 价目表与兑现方式同集：三档零问题（卖点句都必须有人兑现）。
    for (const tier of ['community', 'pro', 'team'] as const) {
      eq(benefitCoverageProblems(tier, PRICING[tier].benefits), [], `H-12 ★${tier} 档卖点全部有兑现方式`);
    }
    ok(BENEFIT_COVERAGE.pro.some((e) => e.benefit === '领域包（跨项目携带项目经验）'
      && e.target.kind === 'capability' && e.target.keys.includes('domain_pack')),
      'H-13 ★Pro 卖点「领域包」指向真能力键（不是空话）');
    eq([...PRO_FEATURES].filter((f) => f === 'domain_pack'), ['domain_pack'],
      'H-14 `domain_pack` 在 Pro 词表内且恰一次');

    // 账本注释：`source` 枚举写明第三值。
    const dbSrc = RD(`${A}/src/main/database.ts`);
    ok(/`source`[^\n]*∈[^\n]*memory\|knowledge\|domain_pack|source.*memory\|knowledge\|domain_pack/.test(dbSrc),
      'H-15 ★`wa_context_injections` 头注的 source 枚举含 `domain_pack`');
    ok(/CREATE TABLE IF NOT EXISTS wa_project_domain_packs/.test(dbSrc),
      'H-16 生产建表含启用关系表（与资产表分开）');

    // build 钉（P1–P6 派生核对；P6 读 dist ⇒ tsup 须先于本套件）。
    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

main().catch((e: unknown) => {
  console.error('\n💥 rr_zx_20261021_3 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261021_3: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
});
