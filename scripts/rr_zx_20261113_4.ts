/**
 * zx_20261113_4「业」——项目业务知识自己长出来、推荐有据、注入有据。
 *
 * 判据分组（随批次逐步补齐）：
 *   S「基」构建钉 P1–P6 + 本轮方案在册与边界。
 *   Y「成」项目画像自动成型（B1）。
 *   R「荐」候选领域包按相似度推荐与预览（B2）。
 *   I「注」多包注入按任务相关性排序（B3）。
 *
 * 纪律：
 *   - 轮次钉由 checkBuildPins 从真源派生，不写「只为下一轮」的字面量；
 *   - 断言文案禁含失败字形（汇总器按字形计数）；
 *   - 夹具按生产初始化顺序搭：先建表/服务，再插数据行；
 *   - 计数器类断言必须有 0→1 的正面证据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildNotOlderThan, checkBuildPins, deriveBuildTag, stripKeepingLines } from './lib/rr-pins.js';
import { BOOL_SETTING_KEYS } from '../apps/worker-ant-desktop/src/main/core/settings-bool.js';
import {
  PROFILE_BOOTSTRAP_MAX_PER_RUN,
  ensureProjectProfileBootstrapped,
  profileBootstrapDecision,
  projectsMissingProfile,
} from '../apps/worker-ant-desktop/src/main/core/project-profile.js';
import { scoreProjectPair, similarProjects } from '../apps/worker-ant-desktop/src/main/core/project-similarity.js';
import {
  listSuggestedDomainPacks,
  previewDomainPackSections,
  rankDomainPacksForInject,
  rankSuggestedPacks,
  renderDomainPackSection,
  type AppliedDomainPack,
} from '../apps/worker-ant-desktop/src/main/core/domain-pack.js';
import { estimateTokensFromChars } from '../apps/worker-ant-desktop/src/main/core/token-estimate.js';
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';

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

/* ── S「基」轮次在册与构建钉 ─────────────────────────────────────────────── */

function sectionS(): void {
  console.log('\n【S】构建钉与本轮方案');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

  const selfRound = path.basename(__filename, '.ts').replace(/^rr_/, '');
  const plan = readSrc(`plans/improve/${selfRound}.md`);
  ok(plan.includes(selfRound), 'S1 本轮方案在册且带轮次名');
  ok(
    plan.includes('ensureProjectProfileBootstrapped') &&
      plan.includes('rankSuggestedPacks') &&
      plan.includes('rankDomainPacksForInject'),
    'S2 方案记下画像 bootstrap、候选排序与注入排序三个新符号',
  );
  ok(plan.includes('不自动启用任何外来领域包'), 'S3 方案记下“候选永不自动启用”的边界');
  ok(plan.includes('profile_auto_bootstrap') && plan.includes('不改价格'), 'S4 方案记下自动成型开关与零价改口径');

  const { tag, count } = deriveBuildTag(readSrc(`${A}/src/main/core/agent-executor.ts`));
  eq(count, 1, 'S5 源码 build 轮次标识恰好 1 处');
  ok(buildNotOlderThan(tag, selfRound), 'S6 构建钉不早于本脚本轮次', `${tag} >= ${selfRound}`);
}

/* ── Y「成」项目画像自动成型（B1） ─────────────────────────────────────── */

function profileFixtureDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, description TEXT DEFAULT '',
      status TEXT DEFAULT 'active', updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_project_knowledge (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      section TEXT NOT NULL, content TEXT NOT NULL, source_ref TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_project_knowledge_imports (project_id TEXT NOT NULL, section TEXT NOT NULL,
      content TEXT NOT NULL, precedence INTEGER DEFAULT 0, source_hash TEXT DEFAULT '');
    CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', status TEXT DEFAULT 'pending',
      context_json TEXT DEFAULT '{}');
    CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', type TEXT DEFAULT '');
    CREATE TABLE wa_service_calls (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', kind TEXT NOT NULL,
      ok INTEGER DEFAULT 0);
    CREATE TABLE wa_context_injections (source TEXT, task_id TEXT);
    CREATE TABLE wa_project_profiles (project_id TEXT PRIMARY KEY, version INTEGER, source_hash TEXT,
      profile_json TEXT, generated_at TEXT, enabled INTEGER DEFAULT 1, origin TEXT DEFAULT 'local',
      source_project_name TEXT DEFAULT '');
    CREATE TABLE wa_project_profile_history (project_id TEXT, source_hash TEXT, version INTEGER,
      profile_json TEXT, generated_at TEXT, replaced_at TEXT);
  `);
  return db;
}

function sectionY(): void {
  console.log('\n【Y】项目画像自动成型（B1）');

  eq([
    profileBootstrapDecision({ autoEnabled: false, hasProfile: false, hasFacts: true }),
    profileBootstrapDecision({ autoEnabled: true, hasProfile: true, hasFacts: true }),
    profileBootstrapDecision({ autoEnabled: true, hasProfile: false, hasFacts: false }),
    profileBootstrapDecision({ autoEnabled: true, hasProfile: false, hasFacts: true }),
  ], ['disabled', 'exists', 'no_facts', 'create'], 'Y1 bootstrap 判据四态');

  const db = profileFixtureDb();
  const prof = (): number => (db.prepare('SELECT COUNT(*) c FROM wa_project_profiles').get() as { c: number }).c;
  const insProj = db.prepare('INSERT INTO wa_projects (id, name, status) VALUES (?, ?, ?)');
  insProj.run('p1', '有事实项目', 'active');
  insProj.run('p2', '已归档项目', 'archived');
  insProj.run('p3', '空项目', 'active');
  insProj.run('p4', '导入画像项目', 'active');
  db.prepare("INSERT INTO wa_tasks (id, project_id, status) VALUES ('t1', 'p1', 'completed')").run();
  db.prepare("INSERT INTO wa_tasks (id, project_id, status) VALUES ('t2', 'p2', 'completed')").run();
  db.prepare("INSERT INTO wa_tasks (id, project_id, status) VALUES ('t3', 'p4', 'completed')").run();
  db.prepare(`INSERT INTO wa_project_profiles (project_id, version, source_hash, profile_json, generated_at, enabled, origin)
              VALUES ('p4', 1, 'imported-hash', '{"imported":true}', '2026-01-01T00:00:00.000Z', 0, 'imported')`).run();

  eq(projectsMissingProfile(db as never, 10), ['p1'], 'Y2 缺画像清单：排除已归档/空项目/已有画像（含导入）');
  eq(prof(), 1, 'Y3 夹具起始画像 1 行（导入那条）');

  const first = ensureProjectProfileBootstrapped(db as never, 'p1', { autoEnabled: true });
  eq(first.reason, 'created', 'Y4 有事实且无画像 ⇒ 新建');
  eq(prof(), 2, 'Y5 计数器 0→1：p1 画像入库（1 条导入 + 1 条新生）');
  const p1 = db.prepare("SELECT enabled, origin FROM wa_project_profiles WHERE project_id = 'p1'").get() as { enabled: number; origin: string };
  eq([p1.enabled, p1.origin], [1, 'local'], 'Y6 新画像默认启用、来源 local');

  const again = ensureProjectProfileBootstrapped(db as never, 'p1', { autoEnabled: true });
  eq(again.reason, 'exists', 'Y7 幂等：第二次不重建');
  eq(prof(), 2, 'Y8 幂等后仍 2 行');

  eq(ensureProjectProfileBootstrapped(db as never, 'p3', { autoEnabled: true }).reason, 'no_facts', 'Y9 无事实项目不建空壳');
  eq(ensureProjectProfileBootstrapped(db as never, 'p1', { autoEnabled: false }).reason, 'disabled', 'Y10 开关关 ⇒ 不自动建');

  const importedBefore = db.prepare("SELECT profile_json, enabled FROM wa_project_profiles WHERE project_id = 'p4'").get() as { profile_json: string; enabled: number };
  eq(ensureProjectProfileBootstrapped(db as never, 'p4', { autoEnabled: true }).reason, 'exists', 'Y11 导入画像 ⇒ 不覆盖');
  const importedAfter = db.prepare("SELECT profile_json, enabled FROM wa_project_profiles WHERE project_id = 'p4'").get() as { profile_json: string; enabled: number };
  eq(importedAfter, importedBefore, 'Y12 导入画像内容与启停原样保留');

  eq(projectsMissingProfile(db as never, 10), [], 'Y13 bootstrap 后缺画像清单为空');
  ok(PROFILE_BOOTSTRAP_MAX_PER_RUN >= 1, 'Y14 补跑上限为正数', String(PROFILE_BOOTSTRAP_MAX_PER_RUN));

  const jobs = codeOf(`${A}/src/main/core/jobs/index.ts`);
  eq((jobs.match(/readBoolSetting\(db, 'profile_auto_bootstrap'\)/g) ?? []).length, 1, 'Y15 夜间作业只读一次开关');
  ok(jobs.includes('ensureProjectProfileBootstrapped(db, pid, { autoEnabled: true })'), 'Y16 夜间作业真调 bootstrap');
  ok(jobs.includes('projectsMissingProfile(db, PROFILE_BOOTSTRAP_MAX_PER_RUN)'), 'Y17 存量项目有界补跑');

  ok(BOOL_SETTING_KEYS.includes('profile_auto_bootstrap'), 'Y18 开关进主进程白名单');
  const settingsPage = codeOf('apps/worker-ant-desktop/renderer/src/pages/SettingsPage.tsx');
  ok(settingsPage.includes("'profile_auto_bootstrap'"), 'Y19 设置页有真实读写键（第二落点）');
  ok(settingsPage.includes('toggleProfileAutoBootstrap'), 'Y20 设置页有专属开关行');
  ok(settingsPage.includes('项目画像自动成型'), 'Y21 开关文案上屏');

  db.close();
}

/* ── R「荐」候选领域包按相似度推荐与预览（B2） ─────────────────────────── */

function similarityFixtureDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, description TEXT DEFAULT '',
      status TEXT DEFAULT 'active', updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_project_profiles (project_id TEXT PRIMARY KEY, version INTEGER, source_hash TEXT,
      profile_json TEXT, generated_at TEXT, enabled INTEGER DEFAULT 1, origin TEXT DEFAULT 'local',
      source_project_name TEXT DEFAULT '');
    CREATE TABLE wa_project_knowledge (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, section TEXT NOT NULL,
      content TEXT NOT NULL, source_ref TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_project_knowledge_imports (project_id TEXT NOT NULL, section TEXT NOT NULL,
      content TEXT NOT NULL, precedence INTEGER DEFAULT 0, source_hash TEXT DEFAULT '');
    CREATE TABLE wa_knowledge_cards (project_id TEXT, kind TEXT, status TEXT);
    CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', type TEXT DEFAULT '');
    CREATE TABLE wa_domain_packs (id TEXT PRIMARY KEY, name TEXT, description TEXT DEFAULT '',
      pack_json TEXT NOT NULL, source_project_id TEXT, source_project_name TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
      origin TEXT DEFAULT 'user', dismissed_at TEXT);
    CREATE TABLE wa_project_domain_packs (project_id TEXT, pack_id TEXT, applied_at TEXT);
  `);
  const ins = db.prepare('INSERT INTO wa_projects (id, name, description) VALUES (?, ?, ?)');
  ins.run('p1', 'erp 项目 甲', '订单 库存 接口');
  ins.run('p2', 'erp 项目 乙', '订单 库存 报表');
  ins.run('p3', '股票 行情 分析', '行情 指标 回测');
  return db;
}

function sectionR(): void {
  console.log('\n【R】候选领域包按相似度推荐与预览（B2）');

  const db = similarityFixtureDb();
  const sim12 = scoreProjectPair(db as never, 'p1', 'p2');
  ok(!!sim12, 'R1 共同术语/描述 ⇒ 有相似度');
  ok((sim12?.score ?? 0) > 0 && (sim12?.reasons.length ?? 0) > 0, 'R2 相似度带分与理由', JSON.stringify(sim12));
  ok(scoreProjectPair(db as never, 'p1', 'p3') === null, 'R3 无交集 ⇒ null（不凑数）');
  ok(scoreProjectPair(db as never, 'p1', 'p1') === null, 'R4 自己比自己 ⇒ null');

  const sims = similarProjects(db as never, 'p1');
  eq(sims.map((s) => s.projectId), ['p2'], 'R5 重构不改行为：similarProjects 仍只推荐有据的 p2');
  eq(sims[0]?.reasons, sim12?.reasons, 'R6 两条路径的理由同源');

  const ranked = rankSuggestedPacks([
    { id: 'b', updated_at: '2026-01-01', similarity: { score: 0.5, reasons: [] } },
    { id: 'a', updated_at: '2026-01-02', similarity: { score: 0.9, reasons: [] } },
    { id: 'c', updated_at: '2026-01-03' },
  ]);
  eq(ranked.map((r) => r.id), ['a', 'b', 'c'], 'R7 排序：分高者先，无依据排后但不隐藏');
  const tie = rankSuggestedPacks([
    { id: 'x', updated_at: '2026-01-01', similarity: { score: 0.5, reasons: [] } },
    { id: 'y', updated_at: '2026-01-02', similarity: { score: 0.5, reasons: [] } },
  ]);
  eq(tie.map((r) => r.id), ['y', 'x'], 'R8 同分按 updated_at 降序（确定性）');

  const long = `${'A'.repeat(60)}。${'B'.repeat(100)}`;
  const preview = previewDomainPackSections({
    sections: [
      { section: 'domain', content: long },
      { section: 'criteria', content: '判据一' },
      { section: 'recipes', content: '配方一' },
      { section: 'entities', content: '第四节不该出现' },
    ],
  });
  eq(preview.length, 3, 'R9 预览最多 3 节');
  ok(preview[0]!.snippet.endsWith('。…'), 'R10 长内容在句末标点处收口', preview[0]!.snippet.slice(-12));
  ok(preview[0]!.snippet.length <= 62, 'R11 摘要有界（≤ 句末 + 省略号）');
  ok(preview.every((p) => p.label !== ''), 'R12 每节有中文名');

  // 候选清单：来源相似者在前、无依据者仍返回；本项派生/已忽略/已启用都不出现。
  const insPack = db.prepare(`INSERT INTO wa_domain_packs
    (id, name, description, pack_json, source_project_id, source_project_name, updated_at, origin, dismissed_at)
    VALUES (?, ?, '', ?, ?, ?, ?, 'auto_candidate', ?)`);
  const packJson = (name: string, content: string): string =>
    JSON.stringify({ version: 2, name, description: '', sections: [{ section: 'domain', content }] });
  insPack.run('pk-a', '乙·领域包', packJson('乙·领域包', long), 'p2', 'erp 项目 乙', '2026-01-01', null);
  insPack.run('pk-b', '丙·领域包', packJson('丙·领域包', '股票 行情'), 'p3', '股票 行情 分析', '2026-01-02', null);
  insPack.run('pk-own', '甲·领域包', packJson('甲·领域包', '自己的'), 'p1', 'erp 项目 甲', '2026-01-03', null);
  insPack.run('pk-dismissed', '已忽略', packJson('已忽略', '忽略'), 'p2', 'erp 项目 乙', '2026-01-04', '2026-01-05');
  insPack.run('pk-applied', '已启用', packJson('已启用', '启用'), 'p2', 'erp 项目 乙', '2026-01-05', null);
  db.prepare("INSERT INTO wa_project_domain_packs (project_id, pack_id) VALUES ('p1', 'pk-applied')").run();

  const suggested = listSuggestedDomainPacks(db as never, 'p1', 5);
  eq(suggested.map((p) => p.id), ['pk-a', 'pk-b'], 'R13 候选排除本项目/已忽略/已启用，且相似者在前');
  ok(!!suggested[0]!.similarity, 'R14 相似来源带推荐依据');
  ok(suggested[0]!.similarity!.reasons.length > 0, 'R15 推荐依据是"为什么像"的原句');
  ok(!suggested[1]!.similarity, 'R16 无交集来源如实缺席相似度（不编 0 分）');
  eq(suggested[0]!.preview?.length, 1, 'R17 候选带内容预览');

  // 接线：首屏状态一次回齐三块；候选卡显示依据与预览。
  const ipc = codeOf(`${A}/src/main/ipc/knowledge.ipc.ts`);
  ok(ipc.includes("'knowledge:business-status'"), 'R18 首屏状态 IPC 在册');
  ok(ipc.includes('appliedPacks') && ipc.includes('suggestedPacks'), 'R19 首屏状态回齐画像/已启用/待采纳');
  const inbox = codeOf('apps/worker-ant-desktop/renderer/src/components/KnowledgeInboxCard.tsx');
  ok(inbox.includes('p.similarity') && inbox.includes('相似度'), 'R20 候选卡显示相似度与理由');
  ok(inbox.includes('看内容预览'), 'R21 候选卡有内容预览入口');
  const detail = codeOf('apps/worker-ant-desktop/renderer/src/pages/ProjectDetailPage.tsx');
  ok(detail.includes('knowledge.businessStatus'), 'R22 项目详情接了首屏状态');
  ok(detail.includes('project-knowledge-assets'), 'R23 首屏状态可直达知识资产区');
  eq((detail.match(/onChanged=\{\(\) => void loadBusinessStatus\(\)\}/g) ?? []).length, 3,
    'R24 画像/收件箱/领域包三处动作都会刷新首屏状态');

  db.close();
}

/* ── I「注」多包注入按任务相关性排序（B3） ─────────────────────────────── */

function sectionI(): void {
  console.log('\n【I】多包注入按任务相关性排序（B3）');

  const mkPack = (id: string, name: string, content: string): AppliedDomainPack => ({
    id,
    name,
    description: '',
    sections: [{ section: 'domain', content }],
    source_project_name: '',
    applied_at: '',
  });
  const A = mkPack('a', '甲包', '订单 库存 接口');
  const B = mkPack('b', '乙包', '股票 行情 指标');

  eq(rankDomainPacksForInject([A, B], ['订单']).map((p) => p.id), ['a', 'b'], 'I1 命中甲包 ⇒ 甲先');
  eq(rankDomainPacksForInject([A, B], ['股票']).map((p) => p.id), ['b', 'a'], 'I2 命中乙包 ⇒ 乙先');
  eq(rankDomainPacksForInject([A, B], ['无关词']).map((p) => p.id), ['a', 'b'], 'I3 全不命中 ⇒ 原序');
  eq(rankDomainPacksForInject([B, A], []).map((p) => p.id), ['b', 'a'], 'I4 无关键词 ⇒ 原序');
  eq(rankDomainPacksForInject([A, B], ['订单']).map((p) => p.id), rankDomainPacksForInject([A, B], ['订单']).map((p) => p.id), 'I5 同输入同输出（确定性）');

  // 命中者先占预算；未命中者被整包跳过并点名。
  const costA = estimateTokensFromChars(
    `### 领域包：甲包\n### 领域与术语\n订单 库存 接口`.length,
  );
  const rendered = renderDomainPackSection([B, A], costA + 1, '订单 接口');
  ok(rendered.text.includes('甲包'), 'I6 命中包进入上下文');
  ok(!rendered.text.includes('乙包') || !rendered.text.includes('股票 行情 指标'), 'I7 未命中包被跳过（不占预算）');
  ok(rendered.text.includes('未注入：乙包'), 'I8 被跳过的包在段末点名');
  eq(rendered.injections.map((x) => x.ref_id), ['a'], 'I9 注入账只记真进上下文的包');

  // 无 taskText ⇒ 逐字节保持既有格式（零行为变化）。
  const plain = renderDomainPackSection([A, B], 10_000);
  const expected = [
    '## 领域包',
    '### 领域包：甲包',
    '### 领域与术语',
    '订单 库存 接口',
    '### 领域包：乙包',
    '### 领域与术语',
    '股票 行情 指标',
  ].join('\n');
  eq(plain.text, expected, 'I10 无任务文本 ⇒ 输出逐字节不变');

  // 注入账 0→1：真 MemoryManager × 生产写口（唯一键去重）。
  const idb = new DatabaseSync(':memory:');
  idb.exec(`
    CREATE TABLE wa_memories (id TEXT PRIMARY KEY, content TEXT, memory_type TEXT, project_id TEXT);
    CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE wa_context_injections (id TEXT PRIMARY KEY, task_id TEXT, source TEXT, ref_id TEXT,
      chars INTEGER, est_tokens INTEGER, outcome TEXT, UNIQUE(task_id, source, ref_id));
  `);
  const mm = new MemoryManager(idb as never, {} as never);
  const cnt = () => (idb.prepare("SELECT COUNT(*) c FROM wa_context_injections WHERE source = 'domain_pack'").get() as { c: number }).c;
  eq(cnt(), 0, 'I11 注入账起始 0 行');
  const w1 = mm.recordContextInjections('t1', { domainPacks: [{ ref_id: 'a', chars: 10 }] });
  eq([w1, cnt()], [1, 1], 'I12 真写口 0→1');
  const w2 = mm.recordContextInjections('t1', { domainPacks: [{ ref_id: 'a', chars: 10 }] });
  eq([w2, cnt()], [0, 1], 'I13 唯一键去重：重复注入不重复记账');
  idb.close();

  const card = codeOf('apps/worker-ant-desktop/renderer/src/components/DomainPackCard.tsx');
  ok(card.includes('完成 {st.completed} / 失败 {st.failed}'), 'I14 逐包成效上屏');
  ok(card.includes('尚未注入'), 'I15 无样本如实说「尚未注入」');
}

function main(): void {
  sectionS();
  sectionY();
  sectionR();
  sectionI();

  console.log(`\n[rr_zx_20261113_4] ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

try {
  main();
} catch (e: unknown) {
  console.error('\nrr_zx_20261113_4 未捕获异常（复跑未跑完，不得读作通过）：', e);
  console.log(`\n[rr_zx_20261113_4] ${pass} passed, ${fail + 1} failed`);
  process.exit(1);
}
