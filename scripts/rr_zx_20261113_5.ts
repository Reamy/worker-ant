/**
 * zx_20261113_5 受控复跑 —— 「见」：团队共享库看得见内容、墓碑不进候选。
 *
 * 判据：
 *   M1 墓碑/空正文不进候选；分享/导入拒空（两侧标本）。
 *   M2 预览与分享载荷同一次组装；五类 body 的可读形状。
 *   M3 领域包单包详情 + 项目详情入口接线（静态）。
 *
 * 纪律：
 *   - 轮次钉由 checkBuildPins 从真源派生，不写「只为下一轮」的字面量；
 *   - 断言文案禁含失败字形（汇总器按字形计数）；
 *   - 夹具按生产列形状搭：少列会在运行时抛 no such column，照出「假报零」以外的真缺陷。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import {
  TeamLibraryError, importItem, listLocalItems, previewLocalItem, previewTeamBody, shareItem,
} from '../apps/worker-ant-desktop/src/main/core/team-library.js';
import { parseDomainPackJson, readDomainPackDetail } from '../apps/worker-ant-desktop/src/main/core/domain-pack.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(a: unknown, b: unknown, label: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `${JSON.stringify(a)} = ${JSON.stringify(b)}`);
}
function thrownOf(fn: () => unknown): unknown {
  try { fn(); return null; } catch (e) { return e; }
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const readSrc = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');
const codeOf = (rel: string): string => stripKeepingLines(readSrc(rel)).join('\n');
const lib = (d: DatabaseSync) => d as unknown as Parameters<typeof listLocalItems>[0];

const PACK = {
  version: 2,
  name: '示例领域包',
  description: '回归夹具',
  sections: [
    { section: 'domain', content: '领域：回归夹具的术语与边界。' },
    { section: 'criteria', content: '验收：断言必须能红。' },
    { section: 'recipes', content: '配方：先写失败标本再修。' },
  ],
  source: { project_id: 'p1', project_name: '来源项目' },
  derived_at: '2026-11-13 10:00:00',
  training: false,
  omitted_sections: [],
};

const PROFILE = {
  version: 1,
  projectId: 'p1',
  generatedAt: '2026-11-13 09:00:00',
  sourceHash: 'h1',
  terms: '术语：工蚁',
  acceptance: '验收：跑 rr',
  recipes: '配方：先复现',
  runtime: {
    tasks: { total: 3, completed: 2, failed: 1, active: 0 },
    deliverables: { total: 2, byType: [] },
    calls: { total: 1, ok: 1, failed: 0, byKind: [] },
    injections: { knowledge: 0, domain_pack: 0, memory: 0, project_profile: 0 },
    lastModel: '',
  },
  lessons: ['不要相信假绿'],
};

function freshDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE wa_task_templates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT DEFAULT 'custom',
      description TEXT DEFAULT '', subtasks TEXT DEFAULT '[]', keywords TEXT DEFAULT '[]',
      status TEXT DEFAULT 'active', priority INTEGER DEFAULT 0, source TEXT DEFAULT 'user',
      match_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_memories (
      id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL, embedding TEXT,
      memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5, reasoning TEXT DEFAULT '',
      source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '', valence TEXT DEFAULT 'neutral',
      context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0, exemplar_type TEXT,
      exemplar_context TEXT, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_deliverables (
      id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT DEFAULT 'doc',
      name TEXT DEFAULT '', description TEXT DEFAULT '', file_path TEXT, status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_domain_packs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', pack_json TEXT NOT NULL,
      source_project_id TEXT, source_project_name TEXT DEFAULT '', origin TEXT DEFAULT 'user',
      dismissed_at TEXT, created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '');
    CREATE TABLE wa_project_profiles (
      project_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1,
      source_hash TEXT NOT NULL DEFAULT '', profile_json TEXT NOT NULL,
      generated_at TEXT DEFAULT (datetime('now')), enabled INTEGER NOT NULL DEFAULT 1,
      origin TEXT NOT NULL DEFAULT 'local', source_project_name TEXT DEFAULT '');
  `);
  return d;
}

/* ── M1 墓碑与空记忆 ─────────────────────────────────────────────────── */

function sectionM1(): void {
  console.log('\n【M1】墓碑/空正文不进候选；分享与导入都拒空');
  const d = freshDb();
  d.prepare("INSERT INTO wa_memories (id, content, memory_type, importance, reasoning) VALUES (?,?,?,?,?)")
    .run('live-1', '用户偏好中文回复', 'semantic', 0.9, '用户明确要求');
  d.prepare("INSERT INTO wa_memories (id, content, memory_type, importance, reasoning) VALUES (?,?,?,?,?)")
    .run('tomb-1', '', 'deleted', 1.0, '');
  d.prepare("INSERT INTO wa_memories (id, content, memory_type, importance, reasoning) VALUES (?,?,?,?,?)")
    .run('tomb-2', '被删但正文残留', 'deleted', 1.0, '');
  d.prepare("INSERT INTO wa_memories (id, content, memory_type, importance, reasoning) VALUES (?,?,?,?,?)")
    .run('empty-1', '   ', 'semantic', 0.8, '');
  d.prepare("INSERT INTO wa_task_templates (id, name, category) VALUES (?,?,?)").run('tpl-1', '周报模板', 'report');
  d.prepare("INSERT INTO wa_deliverables (id, name, type, status) VALUES (?,?,?,?)").run('del-1', '项目报告', 'doc', 'ready');

  const local = listLocalItems(lib(d));
  eq(local.memories.map((m) => m.localId), ['live-1'], 'M1-1 ★候选只剩活记忆（墓碑/空正文都被过滤）');
  eq(local.memories[0]?.title, '用户偏好中文回复', 'M1-2 活记忆标题取内容');
  ok(!local.memories.some((m) => m.title.includes('空记忆')), 'M1-3 候选里不再出现「(空记忆)」');
  eq([local.templates.length, local.deliverables.length], [1, 1], 'M1-4 其他列不受影响');

  const e1 = thrownOf(() => shareItem(lib(d), 'memory', 'tomb-1'));
  ok(e1 instanceof TeamLibraryError && /内容为空/.test(String((e1 as Error).message)),
    'M1-5 ★分享墓碑 ⇒ TeamLibraryError（不冒充可分享）', String((e1 as Error)?.message ?? ''));
  const e2 = thrownOf(() => shareItem(lib(d), 'memory', 'empty-1'));
  ok(e2 instanceof TeamLibraryError, 'M1-6 分享空白正文 ⇒ 同样拒');
  const e3 = thrownOf(() => shareItem(lib(d), 'memory', 'tomb-2'));
  ok(e3 === null, 'M1-7 反证：正文残留的墓碑行仍可读（过滤只认 memory_type/空正文，不误伤有字行）');

  const badItem = {
    id: 'shared-empty', kind: 'memory' as const, title: '空记忆',
    body: { content: '   ', memory_type: 'semantic', importance: 0.5 },
    source_node_id: 'n1', created_at: '', updated_at: '',
  };
  const e4 = thrownOf(() => importItem(lib(d), badItem));
  ok(e4 instanceof TeamLibraryError && /内容为空/.test(String((e4 as Error).message)),
    'M1-8 ★导入空内容 ⇒ 拒（不再把空壳洗成正文）', String((e4 as Error)?.message ?? ''));
  const cnt = () => (d.prepare("SELECT COUNT(*) c FROM wa_memories WHERE source='team_library'").get() as { c: number }).c;
  eq(cnt(), 0, 'M1-9 被拒后团队库导入记忆 0 行');

  const goodItem = { ...badItem, id: 'shared-ok', body: { content: '可导入的记忆', importance: 0.5 } };
  const good = thrownOf(() => importItem(lib(d), goodItem));
  ok(good === null, 'M1-10 反证：非空内容照常导入');
  eq(cnt(), 1, 'M1-11 导入计数 0→1（正面断言）');
  d.close();
}

/* ── M2 预览 ─────────────────────────────────────────────────────────── */

function sectionM2(): void {
  console.log('\n【M2】预览与分享载荷同一次组装；五类形状');
  const d = freshDb();
  d.prepare("INSERT INTO wa_domain_packs (id, name, description, pack_json, source_project_name) VALUES (?,?,?,?,?)")
    .run('pack-1', '示例领域包', '回归夹具', JSON.stringify(PACK), '来源项目');
  d.prepare("INSERT INTO wa_projects (id, name) VALUES (?,?)").run('p1', '示例项目');
  d.prepare("INSERT INTO wa_project_profiles (project_id, version, source_hash, profile_json, generated_at, enabled, origin, source_project_name) VALUES (?,?,?,?,?,?,?,?)")
    .run('p1', 1, 'h1', JSON.stringify(PROFILE), '2026-11-13 09:00:00', 1, 'local', '');
  d.prepare("INSERT INTO wa_task_templates (id, name, category, description, subtasks, keywords) VALUES (?,?,?,?,?,?)")
    .run('tpl-1', '周报模板', 'report', '每周汇总', JSON.stringify(['收集数据', '写摘要']), JSON.stringify(['周报']));
  d.prepare("INSERT INTO wa_memories (id, content, memory_type, importance, reasoning) VALUES (?,?,?,?,?)")
    .run('mem-1', '用户偏好中文回复', 'semantic', 0.9, '用户明确要求');
  d.prepare("INSERT INTO wa_deliverables (id, name, type, status, description) VALUES (?,?,?,?,?)")
    .run('del-1', '项目报告', 'doc', 'ready', '一期成果');

  // 域名包：预览 == 分享载荷的映射（同一次 shareItem 组装）
  const packShare = shareItem(lib(d), 'domain_pack', 'pack-1');
  const packView = previewLocalItem(lib(d), 'domain_pack', 'pack-1');
  const packShareSections = (packShare.body.sections as Array<{ content: string }>) ?? [];
  eq(packView.sections.map((s) => s.label), ['领域与术语', '验收与失败', '配方与样板'],
    'M2-1 领域包预览节名来自同一张节名表');
  eq(packView.sections.map((s) => s.content), packShareSections.map((s) => s.content),
    'M2-2 ★预览正文与分享载荷逐字节同源');
  eq(packView.rows.find((r) => r.label === '节数')?.value, '3', 'M2-3 元数据行：节数');
  ok(packView.note === undefined, 'M2-4 无省略节 ⇒ 不编 note');

  // 画像
  const profShare = shareItem(lib(d), 'project_profile', 'p1');
  const profView = previewLocalItem(lib(d), 'project_profile', 'p1');
  eq(profView.title, '示例项目', 'M2-5 画像预览标题取项目名');
  eq(profView.sections.map((s) => s.label), ['术语', '验收', '配方', '教训', '运行面'], 'M2-6 画像五节');
  eq((profShare.body.profile as { terms: string }).terms, '术语：工蚁', 'M2-7 预览读的是同一份画像 body');

  // 其余三类
  const tplView = previewTeamBody('template', '周报模板', shareItem(lib(d), 'template', 'tpl-1').body);
  eq(tplView.sections.map((s) => s.label), ['子任务', '关键词'], 'M2-8 模板：子任务/关键词两节');
  const memView = previewTeamBody('memory', 'x', shareItem(lib(d), 'memory', 'mem-1').body);
  eq([memView.sections[0]?.label, memView.sections[1]?.label], ['内容', '理由'], 'M2-9 记忆：内容/理由两节');
  const delView = previewTeamBody('deliverable', 'x', shareItem(lib(d), 'deliverable', 'del-1').body);
  ok(delView.sections.length === 0 && /只共享元数据/.test(delView.note ?? ''),
    'M2-10 成果：无正文 + 如实说明只元数据');

  // 反证：空记忆预览与分享同拒
  d.prepare("INSERT INTO wa_memories (id, content, memory_type) VALUES (?,?,?)").run('tomb-x', '', 'deleted');
  const e = thrownOf(() => previewLocalItem(lib(d), 'memory', 'tomb-x'));
  ok(e instanceof TeamLibraryError, 'M2-11 反证：空记忆预览也拒（与分享同一条路）');
  d.close();
}

/* ── M3 领域包详情 + 入口接线 ─────────────────────────────────────────── */

function sectionM3(): void {
  console.log('\n【M3】单包详情与入口接线');
  const d = freshDb();
  d.prepare("INSERT INTO wa_domain_packs (id, name, description, pack_json, source_project_name) VALUES (?,?,?,?,?)")
    .run('pack-1', '示例领域包', '回归夹具', JSON.stringify(PACK), '来源项目');
  const detail = readDomainPackDetail(lib(d) as never, 'pack-1');
  eq(detail?.sections.map((s) => s.label), ['领域与术语', '验收与失败', '配方与样板'], 'M3-1 详情返回三节（中文节名）');
  eq(detail?.omitted_labels, [], 'M3-2 无省略 ⇒ omitted_labels 空');
  eq(readDomainPackDetail(lib(d) as never, 'nope'), null, 'M3-3 不存在的包 ⇒ null（不造假空包）');
  d.prepare("INSERT INTO wa_domain_packs (id, name, description, pack_json) VALUES (?,?,?,?)")
    .run('broken', '坏包', '', '{not json');
  eq(readDomainPackDetail(lib(d) as never, 'broken'), null, 'M3-4 坏包 ⇒ null');
  ok(parseDomainPackJson(JSON.stringify(PACK)) !== null, 'M3-5 正向标本：合法包可解析');
  d.close();

  const page = codeOf('apps/worker-ant-desktop/renderer/src/pages/TeamLibraryPage.tsx');
  ok(page.includes('teamApi.localPreview') && page.includes('teamApi.preview'), 'M3-6 团队库接线两条预览通道');
  ok(page.includes('查看') && page.includes('TeamItemPreview'), 'M3-7 团队库每行有「查看」与弹层');
  const card = codeOf('apps/worker-ant-desktop/renderer/src/components/DomainPackCard.tsx');
  ok(card.includes('packsApi.detail') && card.includes('TeamItemPreview'), 'M3-8 领域包卡可查看详情');
  const detailPage = codeOf('apps/worker-ant-desktop/renderer/src/pages/ProjectDetailPage.tsx');
  ok(/el\.open\s*=\s*true/.test(detailPage) && detailPage.includes("project-knowledge-assets"),
    'M3-9 首屏「查看知识资产」会展开 details 再滚动');
  const ipc = codeOf('apps/worker-ant-desktop/src/main/ipc/packs.ipc.ts');
  ok(ipc.includes("'packs:detail'"), 'M3-10 packs:detail 通道在册');
  const dash = codeOf('apps/worker-ant-desktop/renderer/src/pages/DashboardPage.tsx');
  ok(dash.includes('worstHealthItem') && dash.includes('最差一面'),
    'M3-11 运维看板「整体状态」就地显示最差一面与依据');
  ok(/HEALTH_LEVEL_RANK/.test(dash) && !/const HEALTH_LEVEL_RANK/.test(dash),
    'M3-12 强弱序引真源（渲染层不另写一份）');
}

function main(): void {
  console.log('【S】构建钉');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  sectionM1();
  sectionM2();
  sectionM3();
  console.log(`\n[rr_zx_20261113_5] ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

try {
  main();
} catch (e: unknown) {
  console.error('\nrr_zx_20261113_5 未捕获异常（复跑未跑完，不得读作通过）：', e);
  console.log(`\n[rr_zx_20261113_5] ${pass} passed, ${fail + 1} failed`);
  process.exit(1);
}
