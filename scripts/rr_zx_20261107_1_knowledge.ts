/**
 * zx_20261107_1 B3「实·通·信」受控回归 —— 业务域知识包（巴特莱特·图式 / 赫布·共现 / 托尔文·语义记忆）。
 *
 * 钉住六件事：
 *   A 确定性聚类：同义异名合并、同名归一、不误并、连跑同值、各自有界；
 *   B 三源汇一：项目知识 / 知识卡 / 已启用领域包 → v2 可选 `business`，零 LLM；
 *   C 解析往返：v1 包照读、v2 字段保真、坏形状丢弃；
 *   D 共享体不丢字段：`shareItem` 的手抄白名单必须把 `business` 带走（两只标本 + 反证）；
 *   E 按需注入：有任务关键词只留命中，全不命中即空块；无关键词全留；
 *   F 接线与边界：整包 ≤400 token、业务块 ≤150 token、空则不写标题、只读不改写、Pro 闸复用。
 *
 * 纪律：零网络 / 零 electron / 零时钟；断言只做方向性与结构比较，不抄分数幻数。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildNotOlderThan, checkBuildPins, deriveBuildTag, stripKeepingLines } from './lib/rr-pins.js';
import {
  BUSINESS_INJECT_MAX_TOKENS,
  BUSINESS_MAX_RULES,
  BUSINESS_MAX_SCENARIOS,
  BUSINESS_MAX_TERMS,
  DOMAIN_PACK_INJECT_MAX_TOKENS,
  DOMAIN_PACK_VERSION,
  deriveBusinessDomain,
  deriveDomainPack,
  isEmptyBusinessDomain,
  parseBusinessDomain,
  parseDomainPackJson,
  renderBusinessBlock,
  renderDomainPackSection,
  type BusinessDomain,
  type DomainPackPayload,
} from '../apps/worker-ant-desktop/src/main/core/domain-pack.js';
import { PRO_FEATURES } from '../apps/worker-ant-desktop/src/main/core/pro-gate.js';
import { shareItem } from '../apps/worker-ant-desktop/src/main/core/team-library.js';
import { estimateTokensFromChars } from '../apps/worker-ant-desktop/src/main/core/token-estimate.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'apps/worker-ant-desktop/src/main');
const CODE = (rel: string) => stripKeepingLines(fs.readFileSync(path.join(ROOT, rel), 'utf-8')).join('\n');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

const count = (db: DatabaseSync, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

/** 生产同形夹具（列形状照 database.ts；卡表按生产列建，不靠缺表兜底假绿）。 */
function makeDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE wa_projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
    working_dir TEXT DEFAULT '', context_json TEXT DEFAULT '{}')`);
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
  d.exec(`CREATE TABLE wa_device_actions (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL, action TEXT NOT NULL,
    args_json TEXT DEFAULT '{}', result TEXT DEFAULT '', task_id TEXT DEFAULT '',
    actor_kind TEXT DEFAULT '', actor_ref TEXT DEFAULT '', plan_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`CREATE TABLE wa_knowledge_cards (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL DEFAULT 0.5,
    tokens INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`CREATE TABLE wa_domain_packs (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
    pack_json TEXT NOT NULL, source_project_id TEXT, source_project_name TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
  d.exec(`CREATE TABLE wa_project_domain_packs (
    project_id TEXT NOT NULL, pack_id TEXT NOT NULL,
    applied_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, pack_id))`);
  d.exec(`CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  return d;
}

function samplePack(over: Partial<DomainPackPayload> = {}): DomainPackPayload {
  return {
    version: DOMAIN_PACK_VERSION,
    name: '远端客厅经验',
    description: '可携带的三节',
    sections: [{ section: 'domain', content: '术语：场景=一组设备联动' }],
    source: { project_id: '', project_name: '远端项目' },
    derived_at: '2026-11-07T00:00:00.000Z',
    training: false,
    omitted_sections: [],
    ...over,
  };
}

/** p1 三源真源：项目知识（术语/约定/验收/配方）+ 五种知识卡 + 一份 v2 已启用包。 */
function seed(db: DatabaseSync): void {
  const p = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a);
  p(`INSERT INTO wa_projects (id, name, context_json) VALUES (?,?,?)`, 'p1', '智能家居',
    JSON.stringify({ language_game: { terminology: { 场景: '一组设备联动', 客户: '购买方' }, conventions: ['每个联动须有回退'] } }));
  p(`INSERT INTO wa_knowledge_triples (id, project_id, subject, predicate, object, confidence) VALUES (?,?,?,?,?,?)`,
    't1', 'p1', '客厅台灯', 'controlled_by', 'worker-ant', 0.9);
  p(`INSERT INTO wa_tasks (id, project_id, title, status, context_json, acceptance_criteria) VALUES (?,?,?,?,?,?)`,
    'k1', 'p1', '开灯与关门', 'completed', '{}', '灯亮且门锁上');
  p(`INSERT INTO wa_tasks (id, project_id, title, status, context_json, acceptance_criteria) VALUES (?,?,?,?,?,?)`,
    'k2', 'p1', '布置客厅', 'failed', JSON.stringify({ pause_reason: 'acceptance_failed' }), '');
  p(`INSERT INTO wa_task_templates (id, name, category, description, status, priority) VALUES (?,?,?,?,?,?)`,
    'tpl1', '布置客厅', 'home', '先清点后摆放', 'active', 5);
  p(`INSERT INTO wa_memories (id, project_id, content, memory_type, is_exemplar) VALUES (?,?,?,?,?)`,
    'm1', 'p1', '先清点再摆放，避免返工', 'semantic', 1);

  const cards: Array<[string, string, string, string]> = [
    ['c-term', 'term', '术语：客户方=购买方', 'project_knowledge:domain'],
    ['c-acc', 'acceptance', '[pending] 开灯与关门：验收 灯亮且门锁上', 'project_knowledge:criteria'],
    // 与项目知识·配方**不同文**：同文会被单源去重到先见的来路，测不出「卡 → 场景」这一跳。
    ['c-recipe', 'recipe', '模板（home）：开灯——先开主灯再开边灯', 'project_knowledge:recipes'],
    ['c-lesson', 'lesson', '先取快照再改，避免半途而废', 'wa_memories:retrospective'],
    ['c-pitfall', 'pitfall', '任务「布置客厅」验收未达：灯未亮', 'wa_memories:acceptance_failure'],
  ];
  for (const [id, kind, text, source] of cards) {
    p(`INSERT INTO wa_knowledge_cards (id, project_id, kind, text, source, status) VALUES (?,?,?,?,?, 'active')`,
      id, 'p1', kind, text, source);
  }

  // 已启用的 v2 包：术语同义（场景=同一释义）应并入 p1 的「场景」；规则与约定同文应去重。
  const remote = samplePack({
    name: '远端经验',
    business: {
      terms: [{ term: '场景', meaning: '一组设备联动', aliases: [], sources: ['远端'] }],
      rules: [{ rule: '每个联动须有回退', sources: ['远端'] }],
      scenarios: [{ scenario: '远端场景：一键关灯', sources: ['远端'] }],
    },
  });
  p(`INSERT INTO wa_domain_packs (id, name, description, pack_json, source_project_id, source_project_name)
     VALUES (?,?,?,?,?,?)`, 'dp-remote', '远端经验', '', JSON.stringify(remote), null, '远端项目');
  p(`INSERT INTO wa_project_domain_packs (project_id, pack_id) VALUES (?,?)`, 'p1', 'dp-remote');
}

// ═══ A｜确定性聚类 ═══════════════════════════════════════════════════════════
function sectionA(): void {
  console.log('\n【A】确定性聚类（零 LLM）');

  const merged = deriveBusinessDomain({
    terms: [
      { term: '客户', meaning: '购买方', source: 'a' },
      { term: '客户方', meaning: '购买方', source: 'b' },
    ],
  });
  eq(merged.terms.length, 1, 'A1 ★同义异名合并为一条');
  eq([merged.terms[0]?.term, merged.terms[0]?.aliases], ['客户', ['客户方']], 'A2 短名为主名，其余为别名');
  eq(merged.terms[0]?.sources, ['a', 'b'], 'A3 出处两侧都留（不丢来路）');

  const kept = deriveBusinessDomain({
    terms: [
      { term: '客户', meaning: '购买方' },
      { term: '客户经理', meaning: '负责客户关系的人' },
    ],
  });
  eq(kept.terms.length, 2, 'A4 ★不同名字不同释义不误并');

  const normalized = deriveBusinessDomain({
    terms: [
      { term: 'API 密钥', meaning: '调用凭据' },
      { term: 'api密钥', meaning: '调用凭据' },
    ],
  });
  eq([normalized.terms.length, normalized.terms[0]?.aliases.length], [1, 1],
    'A5 全/半角与空白归一后同名 ⇒ 同一条');

  const input = {
    terms: [{ term: '客户', meaning: '购买方' }],
    rules: [{ rule: '须有回退' }, { rule: '须有回退 ' }],
    scenarios: [{ scenario: '一键关灯' }, { scenario: '一键关灯' }],
  };
  eq(JSON.stringify(deriveBusinessDomain(input)), JSON.stringify(deriveBusinessDomain(input)),
    'A6 ★连跑两次逐字节相同');
  eq([deriveBusinessDomain(input).rules.length, deriveBusinessDomain(input).scenarios.length], [1, 1],
    'A7 规则/场景按归一文本去重');

  const many = deriveBusinessDomain({
    terms: Array.from({ length: 30 }, (_, i) => ({ term: `词${i}`, meaning: `义${i}` })),
    rules: Array.from({ length: 20 }, (_, i) => ({ rule: `规则${i}` })),
    scenarios: Array.from({ length: 10 }, (_, i) => ({ scenario: `场景${i}` })),
  });
  eq([many.terms.length, many.rules.length, many.scenarios.length],
    [BUSINESS_MAX_TERMS, BUSINESS_MAX_RULES, BUSINESS_MAX_SCENARIOS], 'A8 三类各自有界（20/12/8）');

  ok(isEmptyBusinessDomain({ terms: [], rules: [], scenarios: [] }), 'A9 全空判空');
  ok(!isEmptyBusinessDomain(merged), 'A10 非空判非空');
}

// ═══ B｜三源汇一 ═════════════════════════════════════════════════════════════
function sectionB(): void {
  console.log('\n【B】三源派生 → v2 业务域（项目知识 / 知识卡 / 领域包）');
  const db = makeDb();
  seed(db);
  const before = {
    cards: count(db, 'wa_knowledge_cards'),
    packs: count(db, 'wa_domain_packs'),
    applied: count(db, 'wa_project_domain_packs'),
    cardTexts: (db.prepare('SELECT text FROM wa_knowledge_cards ORDER BY id').all() as Array<{ text: string }>).map((r) => r.text),
  };
  const r = deriveDomainPack(db as never, 'p1', { now: '2026-11-07T00:00:00.000Z' });
  if (!r.ok) { ok(false, 'B0 前置：夹具应派生出包', r.reason); db.close(); return; }
  const biz = r.pack.business;
  ok(!!biz && !isEmptyBusinessDomain(biz), 'B1 ★派生包带业务域（v2 可选字段）');
  eq(r.pack.version, DOMAIN_PACK_VERSION, 'B2 包版本为当前词表值');
  if (!biz) { db.close(); return; }

  const termOf = (name: string) => biz.terms.find((t) => t.term === name || t.aliases.includes(name));
  ok(!!termOf('场景'), 'B3 ★项目知识·术语进业务域');
  const merged = termOf('客户');
  eq(merged ? [merged.term, merged.aliases] : null, ['客户', ['客户方']],
    'B4 ★知识卡与项目知识同义合并（客户 + 客户方）');
  ok(!!merged?.sources.includes('项目知识·术语') && !!merged?.sources.includes('知识卡·术语'),
    'B5 两条来路都写清', merged?.sources.join('、'));
  ok(!!termOf('场景')?.sources.includes('领域包·远端经验'), 'B6 ★已启用包的业务域可传递进来');

  ok(biz.rules.some((x) => x.rule === '每个联动须有回退'), 'B7 约定 → 规则');
  ok(biz.rules.some((x) => x.sources.includes('项目知识·约定')), 'B8 约定出处如实');
  ok(biz.rules.some((x) => x.sources.includes('知识卡·教训')), 'B9 教训卡 → 规则');
  ok(biz.rules.some((x) => x.sources.includes('知识卡·坑')), 'B10 坑卡 → 规则');
  eq(biz.rules.filter((x) => x.rule === '每个联动须有回退').length, 1,
    'B11 ★约定与包内同文规则去重（不重复占预算）');

  ok(biz.scenarios.some((x) => x.sources.includes('项目知识·验收')), 'B12 验收行 → 场景');
  ok(biz.scenarios.some((x) => x.sources.includes('项目知识·配方')), 'B13 配方行 → 场景');
  ok(biz.scenarios.some((x) => x.sources.includes('知识卡·验收')), 'B14 验收卡 → 场景');
  ok(biz.scenarios.some((x) => x.sources.includes('知识卡·配方')), 'B15 配方卡 → 场景');
  ok(biz.scenarios.some((x) => x.scenario.includes('一键关灯')), 'B16 远端包场景进来');

  const again = deriveDomainPack(db as never, 'p1', { now: '2026-11-07T00:00:00.000Z' });
  eq(JSON.stringify(again), JSON.stringify(r), 'B17 ★同夹具两次派生逐字节相同');

  eq([count(db, 'wa_knowledge_cards'), count(db, 'wa_domain_packs'), count(db, 'wa_project_domain_packs')],
    [before.cards, before.packs, before.applied], 'B18 ★派生只读：三张表行数不动');
  eq((db.prepare('SELECT text FROM wa_knowledge_cards ORDER BY id').all() as Array<{ text: string }>).map((x) => x.text),
    before.cardTexts, 'B19 ★已有知识卡原文不改写');
  db.close();
}

// ═══ C｜解析往返 ═════════════════════════════════════════════════════════════
function sectionC(): void {
  console.log('\n【C】解析往返：v1 照读、v2 保真、坏形状丢弃');

  const v1 = parseDomainPackJson(JSON.stringify(samplePack()))!;
  ok(!('business' in v1), 'C1 ★v1 包没有 business 字段（缺席，不补空壳）');

  const biz = deriveBusinessDomain({
    terms: [{ term: '场景', meaning: '一组设备联动' }],
    rules: [{ rule: '须有回退' }],
    scenarios: [{ scenario: '一键关灯' }],
  });
  const round = parseDomainPackJson(JSON.stringify(samplePack({ business: biz })))!;
  eq(round.business, biz, 'C2 ★v2 业务域 JSON 往返保真');

  ok(parseBusinessDomain('nope') === undefined, 'C3 坏形状（字符串）⇒ 缺席');
  ok(parseBusinessDomain({}) === undefined, 'C4 空对象 ⇒ 缺席');
  ok(parseBusinessDomain({ terms: [{ term: '' }] }) === undefined, 'C5 全空条目 ⇒ 缺席');
  const partial = parseBusinessDomain({ terms: [{ term: '客户', meaning: '购买方' }], rules: 'x' });
  eq([partial?.terms.length, partial?.rules.length], [1, 0], 'C6 ★坏的一类丢弃，好的一类照收');

  const capped = parseBusinessDomain({
    terms: Array.from({ length: 30 }, (_, i) => ({ term: `词${i}`, meaning: `义${i}` })),
  });
  eq(capped?.terms.length, BUSINESS_MAX_TERMS, 'C7 解析侧同样有界（截到上限，不无界读）');
}

// ═══ D｜共享体不丢字段 ═══════════════════════════════════════════════════════
function sectionD(): void {
  console.log('\n【D】共享体：手抄白名单必须带走 business');
  const db = makeDb();
  const insert = (id: string, pack: DomainPackPayload) => db.prepare(
    `INSERT INTO wa_domain_packs (id, name, description, pack_json, source_project_id, source_project_name)
     VALUES (?,?,?,?,?,?)`,
  ).run(id, pack.name, pack.description, JSON.stringify(pack), null, pack.source.project_name);

  const biz = deriveBusinessDomain({
    terms: [{ term: '场景', meaning: '一组设备联动' }],
    rules: [{ rule: '须有回退' }],
    scenarios: [{ scenario: '一键关灯' }],
  });
  insert('v2', samplePack({ name: '带业务域', business: biz }));
  insert('v1', samplePack({ name: '无业务域' }));

  const s2 = shareItem(db as never, 'domain_pack', 'v2');
  eq((s2.body as { business?: BusinessDomain }).business, biz, 'D1 ★★v2 业务域随共享体同行');
  ok(JSON.stringify(s2.body).includes('"business"'), 'D2 反证：body 里确有此键（不是断言自我印证）');

  const s1 = shareItem(db as never, 'domain_pack', 'v1');
  ok(!('business' in (s1.body as Record<string, unknown>)), 'D3 ★v1 包不凭空长出 business（缺席即缺席）');
  db.close();
}

const BIZ: BusinessDomain = {
  terms: [
    { term: '场景', meaning: '一组设备联动', aliases: ['场景组'], sources: ['项目知识·术语'] },
    { term: '客户', meaning: '购买方', aliases: [], sources: ['项目知识·术语'] },
  ],
  rules: [{ rule: '每个联动须有回退', sources: [] }],
  scenarios: [{ scenario: '开灯与关门：验收 灯亮且门锁上', sources: [] }],
};

// ═══ E｜按需注入 ═════════════════════════════════════════════════════════════
function sectionE(): void {
  console.log('\n【E】业务域按需注入（命中才留，全不命中即空）');

  const hit = renderBusinessBlock(BIZ, ['开灯']);
  ok(hit.includes('开灯与关门'), 'E1 ★关键词命中场景 ⇒ 入块');
  ok(!hit.includes('- 术语 客户') && !hit.includes('- 规则'), 'E2 ★未命中的术语/规则不入块');
  ok(hit.includes('### 业务域'), 'E3 块标题在');

  const termHit = renderBusinessBlock(BIZ, ['客户']);
  ok(termHit.includes('- 术语 客户：购买方'), 'E4 关键词命中术语 ⇒ 入块');
  ok(!termHit.includes('开灯与关门'), 'E5 未命中的场景不入块');

  eq(renderBusinessBlock(BIZ, ['完全无关的词']), '', 'E6 ★全不命中 ⇒ 空块（不塞无关经验）');
  eq(renderBusinessBlock(null), '', 'E7 无业务域 ⇒ 空串');
  eq(renderBusinessBlock({ terms: [], rules: [], scenarios: [] }), '', 'E8 空业务域 ⇒ 空串');
  eq(renderBusinessBlock(BIZ, ['开灯'], 1), '', 'E9 预算塞不下一条 ⇒ 空块（不截半句）');

  const all = renderBusinessBlock(BIZ, []);
  ok(all.includes('- 术语 场景') && all.includes('- 术语 客户') && all.includes('- 规则') && all.includes('- 场景'),
    'E10 无关键词 ⇒ 全留（判不出任务文本时不擅自丢）');
  ok(estimateTokensFromChars(all.length) <= BUSINESS_INJECT_MAX_TOKENS, 'E11 ★业务块自身 ≤150 token',
    `${estimateTokensFromChars(all.length)}`);
}

// ═══ F｜整段注入与预算 ═══════════════════════════════════════════════════════
function sectionF(): void {
  console.log('\n【F】整段注入：业务域计入整包成本，整段仍受 400 token 约束');

  const pack = {
    id: 'dp-1', name: '客厅经验', description: '', sections: [{ section: 'domain' as const, content: '术语：场景=一组设备联动' }],
    business: BIZ, source_project_name: '远端项目', applied_at: '2026-11-07 00:00:00',
  };
  // 任务文本须真能切出命中关键词（`extractKeywords` 走中文 bigram）：`开灯与关门` → 开灯/关门。
  const withTask = renderDomainPackSection([pack], DOMAIN_PACK_INJECT_MAX_TOKENS, '开灯与关门');
  ok(withTask.text.includes('### 业务域') && withTask.text.includes('开灯与关门'),
    'F1 ★给了任务文本 ⇒ 业务域按需入段');
  ok(!withTask.text.includes('- 术语 客户'), 'F2 未命中术语不入段');
  eq(withTask.injections.map((x) => x.ref_id), ['dp-1'], 'F3 逐包注入行 ref_id＝包 id');

  const noTask = renderDomainPackSection([pack], DOMAIN_PACK_INJECT_MAX_TOKENS);
  ok(noTask.text.includes('- 术语 客户') && noTask.text.includes('- 规则'),
    'F4 无任务文本 ⇒ 业务域全留（与 E10 同一把尺）');
  ok(estimateTokensFromChars(noTask.injections[0]!.chars) <= DOMAIN_PACK_INJECT_MAX_TOKENS,
    'F5 ★整包成本仍 ≤400 token');

  // 第二包塞不下 ⇒ 整包跳过并点名（绝不截字）。
  const big = { ...pack, id: 'dp-2', name: '超预算经验', sections: [{ section: 'domain' as const, content: 'x'.repeat(2000) }], business: undefined };
  const mixed = renderDomainPackSection([pack, big], DOMAIN_PACK_INJECT_MAX_TOKENS, '');
  eq(mixed.injections.length, 1, 'F6 ★塞不下的整包被跳过（只注入得下的一包）');
  ok(mixed.text.includes('超预算经验'), 'F7 ★被跳过的包被点名（不静默丢）');

  eq(renderDomainPackSection([], DOMAIN_PACK_INJECT_MAX_TOKENS).text, '', 'F8 无包 ⇒ 无段');
}

// ═══ G｜接线与边界 ═══════════════════════════════════════════════════════════
function sectionG(): void {
  console.log('\n【G】接线、只读与档位闸');

  const dp = CODE('apps/worker-ant-desktop/src/main/core/domain-pack.ts');
  ok(dp.includes('renderBusinessBlock(') && dp.includes('deriveBusinessDomain(') && dp.includes('parseBusinessDomain('),
    'G1 ★业务域三法在册（派生/解析/渲染）');
  ok(!/CREATE\s+TABLE/i.test(dp), 'G2 ★没有新表（storage 只加可选 JSON 字段）');

  const mc = CODE('apps/worker-ant-desktop/src/main/core/memory-context.ts');
  ok(/renderDomainPackSection\(applied,\s*DOMAIN_PACK_INJECT_MAX_TOKENS,\s*taskText\)/.test(mc),
    'G3 ★注入点把任务文本喂给业务域（按需）');

  const tl = CODE('apps/worker-ant-desktop/src/main/core/team-library.ts');
  ok(/business:\s*pack\.business/.test(tl), 'G4 ★共享体白名单带上 business');

  eq((dp.match(/proFeatureRefusal\(db, 'domain_pack'\)/g) ?? []).length, 2,
    'G5 ★生成与启用两处仍挂 Pro 闸（复用既有卖点，不新增第 10 项）');
  ok((PRO_FEATURES as readonly string[]).includes('domain_pack'), 'G6 `domain_pack` 仍在档位词表内');
  ok(!(PRO_FEATURES as readonly string[]).some((f) => /business/i.test(f)), 'G7 ★未为业务域另立新 Pro 项');

  ok(fs.existsSync(path.join(DESKTOP, 'core/domain-pack.ts')), 'G8 载体在册');
  // 构建标识与脚本同源（方向性：不写死轮次字面量）。
  const { tag } = deriveBuildTag(fs.readFileSync(path.join(DESKTOP, 'core/agent-executor.ts'), 'utf-8'));
  ok(buildNotOlderThan(tag, SELF_ROUND), 'G9 build 标识不早于脚本轮次（方向性派生）', `${tag} vs ${SELF_ROUND}`);
  checkBuildPins(ok, { rootDir: ROOT });
}

sectionA();
sectionB();
sectionC();
sectionD();
sectionE();
sectionF();
sectionG();

console.log(`\n[rr_${SELF_ROUND}_knowledge] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
