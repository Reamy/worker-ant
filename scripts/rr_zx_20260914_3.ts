/**
 * zx_20260914 M3 受控复跑（技能/记忆「用得上」+ 如实计量）。
 *
 * 覆盖 M3-1..M3-3：
 *   M3-1 技能可发现：新增 `list_skills` 工具，模型开跑即可拿到技能清单（此前 `listSkills` 只被 import、
 *        从未被调用 ⇒ "有定义无使用"）；懒加载抽为 `ensureSkillsLoaded` 一处（`skill` 与 `list_skills` 共用，
 *        漏调的一方会看到**空清单**，而"清单为空"与"确实没技能"不可区分）。
 *   M3-1b 第二落点：`list_skills` 还须登记 `tool-registry.TOOL_METAS`——`listReadOnlyNames()` 供 Step1
 *        只读工具集派生，缺登即被剔出只读步，而"第一步先看看有哪些技能"正是只读步最需要的场景。
 *   M3-2 panorama 不自毁：归档 UPDATE 加例外——panorama 是全项目唯一一条整合产物，
 *        被"遗忘/精简"掉等于整块理性认识凭空消失（真库曾因此 panorama=0）。
 *   M3-3 含水如计量：`context_watermark` 增分项 `toolsCount`/`toolsChars`，**不入** waterPct（D4 裁定）。
 *
 * 断言两类：
 *   ① 行为断言跑**真实现**——`buildTools`（真函数 × 内存库）、`list_skills.execute` 真调用、
 *      `MemoryManager.runConsolidationPipeline`（真类 × 内存库真行）；
 *      panorama 例外还做**生产 SQL 就地取出再执行**的对照（去掉例外 ⇒ 同一份 SQL 会归档掉 panorama）。
 *   ② 静态断言一律**读原文**（sc. zx_20260929 `aeSrc()` 就地订正）；关键项附**反证**（判据须有区分度）。
 *
 * ⚠ 本文件不打开任何真库（真库只读实测见 data/baseline_zx_20260914.json）。
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildTools } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
import { TOOL_METAS, toolRegistry } from '../apps/worker-ant-desktop/src/main/core/tool-registry.js';
import { checkBuildPins } from './lib/rr-pins.js';
import { MEM_LIVE_SQL } from '../apps/worker-ant-desktop/src/main/core/memory-lifecycle.js';
import { engineSrc } from './lib/rr-engine-src.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) => ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

import fs from 'node:fs';
const A = 'apps/worker-ant-desktop';
const RD = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf-8');
type AnyDb = import('better-sqlite3').Database;

// 夹具 schema 按 database.ts DDL 摘取相关列（NOT NULL 照抄，防"夹具比生产宽松"的假绿）
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', context_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', priority INTEGER DEFAULT 0,
  depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '', acceptance_criteria TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL,
  embedding TEXT, memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5,
  reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '',
  valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0,
  exemplar_type TEXT, exemplar_context TEXT, use_count INTEGER DEFAULT 0, last_used_at TEXT,
  similar_to TEXT DEFAULT '', last_reinforced_at TEXT, success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT, content TEXT,
  tool_calls TEXT, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_approvals (project_id TEXT, kind TEXT, command_fingerprint TEXT);
`;
const mkdb = (): AnyDb => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d as unknown as AnyDb; };

// ⚠ **zx_20260929 就地订正**：静态判据**一律读原文**，不再 `stripComments`。
//   实测：`stripComments(engineSrc())` 把 475,549 字符**静默**削到 335,278（−140,271 = −29.5%），
//   且削掉的是**真代码**（`return` 460→442、`await` 115→114）——病根是源码里某个字符串内的**裸 `/*`**
//   会让非贪婪匹配一路吞到很远的 `*/`。**去注释本身就是一个会静默改写被测量对象的变换**
//   （同 zx_20260928 的教训）；判据要"钉在符号上"，靠的是**锚点形状**，不是先把源码整容。
//   本文件已复核：改读原文后逐条断言结论不变（注释关键词未造成假阳性）。
const aeSrc = () => engineSrc();
const mmSrc = () => RD(`${A}/src/main/core/memory-manager.ts`);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);

// zx_20260914 M3-1 复跑所用：内存库 + 指向必然连不上的 ANS（同步技能不外呼、结果确定）
const mkCtx = (): AnyDb => {
  const db = mkdb();
  db.prepare("INSERT INTO wa_settings (key,value) VALUES ('ans_server_url','http://127.0.0.1:1')").run();
  return db;
};

// ══════════════════════════════════════════════════════════════════
// S10 M3-1 技能清单"真拿得到"（真 buildTools × 真 list_skills.execute）
// ══════════════════════════════════════════════════════════════════
async function s10Skills(): Promise<void> {
  console.log('\n[S10 M3-1 `list_skills` 真源在册 · 真调用 · 一处懒加载]');
  const ae = aeSrc();

  // ⚠ 必须**动态** import 技能模块：tsx(CJS) 下，静态 `import` 走 require、`await import('./x.js')`
  //   走 ESM 加载器，**同一文件是两个模块实例**（实测：静态侧 registerSkill 后动态侧纹丝不动）。
  //   工具的懒加载用的是动态 import ⇒ 夹具若用静态 import 注册，注册进的是**另一个实例**，
  //   断言只会看到空清单（"清单为空"与"确实没技能"不可区分）。故此处与生产同路径。
  const sk = await import(path.join(__dirname, '..', A, 'src/main/core/skill-registry.js')) as unknown as {
    listSkills: () => Array<{ name: string }>;
    registerSkill: (d: { name: string; description: string; category: string }) => void;
  };

  // ── ① 工具在册（真跑 buildTools，不是查源码里有没有字符串）──
  const db = mkCtx();
  const tools = buildTools({ db } as never, 't1', 'p1', process.cwd()) as unknown as Record<string, { execute?: (a: unknown) => Promise<string> }>;
  ok(!!tools.list_skills && typeof tools.list_skills.execute === 'function',
    '`list_skills` 在 `buildTools` 在册且可执行（真跑返回值，非源码子串匹配）');

  const call = async (): Promise<Array<{ name: string; description: string; category: string }>> =>
    JSON.parse(await tools.list_skills!.execute!({})) as Array<{ name: string; description: string; category: string }>;

  // ── ② 0→2 正面断言：注册 2 个夹具技能 ⇒ 清单恰 +2 ──
  const before = await call();
  ok(!before.some(s => s.name === 'M3夹具甲' || s.name === 'M3夹具乙'),
    '前提：两个夹具技能**注册前**不在清单里（否则下面的 +2 无从判起）', `注册前 ${before.length} 条`);
  const namesBefore = before.map(s => s.name);
  sk.registerSkill({ name: 'M3夹具甲', description: '夹具技能甲', category: 'custom' });
  sk.registerSkill({ name: 'M3夹具乙', description: '夹具技能乙', category: 'custom' });
  const after = await call();
  eq(after.length, before.length + 2, `注册 2 个 ⇒ 清单恰 +2（${before.length} → ${after.length}，0→2 正面断言）`);
  ok(after.some(s => s.name === 'M3夹具甲') && after.some(s => s.name === 'M3夹具乙'),
    '两个夹具技能都在返回清单里（按名可辨，不是只多了两条无名条目）');
  ok(after.every(s => typeof s.name === 'string' && typeof s.description === 'string' && typeof s.category === 'string'),
    '每条都带 name/description/category（模型据以选技能）');
  // 与真源同尺：返回的就是 `listSkills()` 的全量，而不是另一份手抄清单
  eq(after.length, sk.listSkills().length, '返回条数 === 真源 `listSkills().length`（同一份清单，非第二份）');
  // 反证：`list_skills` **不是**只回内置那几条的固定清单（把 before 里已知的名字全去掉，仍应剩夹具两条）
  eq(after.filter(s => !namesBefore.includes(s.name)).map(s => s.name).sort(), ['M3夹具甲', 'M3夹具乙'].sort(),
    '反证：新增项恰为夹具两条（清单是**活**的：既有 .agents/ANS 来源，也认新注册的）');

  // ── ③ 反证：`skill` 描述不再谎称"调用 skill 时返回列表" ──
  ok(!ae.includes('调用 skill 时返回的可用技能列表'),
    '反证：`skill` 参数描述**不再**含旧措辞（旧话把"列表在哪"指给了不返回列表的工具）');
  ok(/技能名称（用 list_skills 查询可用技能）/.test(ae) && /可用技能清单用 list_skills 查询/.test(ae),
    '`skill` 的描述与 name 参数描述都**指向 `list_skills`**（名实相符）');

  // ── ④ 懒加载一处：两个工具共用同一份判定 ──
  // ⚠ **zx_20260929 M1 就地订正（判据形状，非源码）**：原判据把**进程级布尔**钉成真源——
  //   `eq((ae.match(/_agentSkillsLoaded = true/g)||[]).length, 1)` / 同 `_ansSkillsSynced`。
  //   而这两枚布尔的**病**正在于"进程级"：`_agentSkillsLoaded` 使换项目后不再重扫项目级
  //   `.agents/skills`；`_ansSkillsSynced` 使 ANS 同步失败也永久置位（抖一次即本进程永不重试）。
  //   ⇒ 记账已迁 `skill-registry.ts`（按 workingDir 幂等 / 只在成功时置位且失败可重试）。
  //   本条要的**意图**是"懒加载只有一处实现、两个工具共用它"，与记账放在哪无关，故改钉**更强的真源**：
  //   布尔已消失 + 代之以按作用域的 Once 出口。
  // 判据钉**赋值形状**（`名字 = …`）而非名字本身：读原文时名字也会出现在解释它的注释里，
  // 而注释不产生赋值——这正是"锚点形状"要区分的东西。
  eq((ae.match(/_agentSkillsLoaded\s*=[^=]/g) || []).length, 0,
    '进程级布尔 `_agentSkillsLoaded` 的**赋值**已整体消失（zx_20260929 M1：其"进程级"正是病根）');
  eq((ae.match(/_ansSkillsSynced\s*=[^=]/g) || []).length, 0,
    '进程级布尔 `_ansSkillsSynced` 的**赋值**已整体消失（同上；ANS 同步记账改由 skill-registry 持有）');
  ok(/syncSkillsFromAnsOnce\(/.test(ae), '`ensureSkillsLoaded` 改调 `syncSkillsFromAnsOnce`（只在成功时置位、失败可重试）');
  eq((ae.match(/await ensureSkillsLoaded\(\)/g) || []).length, 2, '`ensureSkillsLoaded()` 被 **2 处**调用（`list_skills` + `skill`），漏调方会看到空清单');
  ok(!/loadAgentSkills\(workingDir\)/.test(ae.replace(/const ensureSkillsLoaded[\s\S]*?\n  \};/, '')),
    '反证：`loadAgentSkills(workingDir)` 只出现在 `ensureSkillsLoaded` 体内（没有第二份懒加载）');
}

// ══════════════════════════════════════════════════════════════════
// S10b M3-1 第二落点：TOOL_METAS（缺登则被剔出 Step1 只读步）
// ══════════════════════════════════════════════════════════════════
function s10bRegistry(): void {
  console.log('\n[S10b M3-1 第二落点 `TOOL_METAS`：登记与否决定它在不在只读步]');
  const db = mkCtx();
  const tools = buildTools({ db } as never, 't1', 'p1', process.cwd()) as unknown as Record<string, unknown>;

  ok(toolRegistry.listReadOnlyNames().includes('list_skills'),
    '真调 `toolRegistry.listReadOnlyNames()` 含 `list_skills`（Step1 只读工具集正是由它派生）');
  ok(!toolRegistry.listReadOnlyNames().includes('skill'),
    '反证：`skill`（写操作）**不在**只读集里——证明上一条是"真登记"而非"整表都算只读"');
  ok(tools.list_skills !== undefined && toolRegistry.getMeta('list_skills') !== undefined,
    '实现（`buildTools`）与元数据（`TOOL_METAS`）**两处都在**（只在一处 ⇒ Step1 缺它，或治理面漏一条）');

  eq(Object.keys(tools).sort(), TOOL_METAS.map(t => t.name).sort(),
    '`buildTools` 键集 === `TOOL_METAS` 名集（两处工具词表**同尺**，不多不少）');

  // ⚠ 必须读**原文**：该数字恰在块注释里，任何形式的"去注释"都会把它抹掉——那样断言永远拿不到锚点
  const m = RD(`${A}/src/main/core/tool-registry.ts`).match(/(\d+)\s*个工具的元数据表/);
  ok(!!m, '注释里确有"N 个工具的元数据表"这句（锚点存在，比对才有意义）');
  eq(m ? Number(m[1]) : NaN, TOOL_METAS.length,
    `注释数字 = 运行期 \`TOOL_METAS.length\`（${TOOL_METAS.length}）——写死只会把漂移推迟到下一轮`);
}

// ══════════════════════════════════════════════════════════════════
// S11 M3-2 panorama 不自毁（真 MemoryManager × 内存库真行）
// ══════════════════════════════════════════════════════════════════
function s11Panorama(): void {
  console.log('\n[S11 M3-2 panorama 免归档：三条可达路径真跑，对照 semantic 仍会被归档]');
  // zx_20261018_2 批七「见简」：归档/巩固簇搬入 `memory-consolidation.ts`（只搬不改义）——
  //   静态扫描面按符号重定向到**两者之和**（四处归档语句总量不变，逐类判据一字未动）。
  const mm = mmSrc() + '\n' + RD(`${A}/src/main/core/memory-consolidation.ts`);

  // ── 静态：归档语句穷举 + 按**判据**分三类（各类的可达性依据不同）──
  // 语句在源码里均单行 ⇒ 用 `[^\n]*`。**不可用 `[^"]*`**：`:1077` 的 SQL 内含 `\"conflict_flag\"`，
  //   会在第一个 `"` 处截断，于是"冲突类"被误判成"非冲突类"（首版即栽在此）。
  // 还须把捕获到的 **TS 源码文本**还原成 SQL：`\"` 是 JS 字符串转义，不还原则 LIKE 模式多一个反斜杠、
  //   永不匹配（首版的反证即因此假绿：语句"跑成功"但一行未中）。四处语句中只用到 `\"` 这一种转义。
  // zx_20260930 M8 就地订正（**跑的还是同一份生产 SQL**，非放宽）：M8 起这些 UPDATE 里的归档排除
  //   片段改为插值 `${MEM_LIVE_SQL}`（一处真源，含 `deleted` 档）。此前直接 `prepare(源码文本)` 能跑，
  //   是因为文本里没有模板插值；现在会把字面 `${MEM_LIVE_SQL}` 喂给 SQLite ⇒ `unrecognized token: "$"`。
  //   两条路：①把 SQL 手抄进本脚本（=「判据的自我印证」，本仓已复发两次，**不取**）；
  //   ②把插值**按真源解出来**再跑 —— 取的仍是生产那一句（含它自己在真源里写的 WHERE 片段），
  //   只是补上 TS 模板在这一跳会做的替换。取 ②。
  const archSites = (mm.match(/UPDATE wa_memories SET memory_type = 'archived'[^\n]*/g) || [])
    .map(s => s.replace(/\\"/g, '"')                        // 去 JS 字符串转义
      .replace(/[`'"]\s*,?\s*$/, '')                        // 去 SQL 字面量收尾的引号/反引号（可省逗号）
      .replace(/\$\{MEM_LIVE_SQL\}/g, MEM_LIVE_SQL));       // 解模板插值 → 与生产运行期同一份 SQL
  eq(archSites.length, 4, '归档 UPDATE 语句**穷举恰 4 处**（扫描面 = 管理器+巩固模块；增删一处即须复核）');
  ok(archSites.every(s => !s.includes('${')), '自证：四处 SQL 的模板插值已全部解出（否则会以 `$` 报错，而非静默跑空）');
  const byImportance = archSites.filter(s => s.includes('importance <'));
  const byFlag = archSites.filter(s => s.includes('conflict_flag') && !s.includes('importance <'));
  const byId = archSites.filter(s => s.includes('WHERE id = ?'));
  eq([byImportance.length, byFlag.length, byId.length], [2, 1, 1],
    '四处分三类：衰减/精简（判据 importance）2 · 过期冲突（判据 conflict_flag）1 · 反题按 id 1');
  for (const s of [...byImportance, ...byFlag]) {
    ok(s.includes("'panorama'"), `可达类携带 panorama 例外：${s.replace(/\s+/g, ' ').slice(0, 92)}…`);
  }
  ok(byId.every(s => !s.includes('panorama')),
    '反证：判据有区分度——按 id 归档那一处**不**含 panorama（若全含，则抓不出"漏改的那处"）');

  // ── 可达性依据（逐类给证据，而非"我判断不可达"）──
  ok(/older\.source === 'user_instruction' \|\| older\.source === 'user_correction'/.test(mm),
    '过期冲突类**可达**：该分支把 `conflict_flag` 打在 **newer** 上（不限于 agent 写入方），panorama 正是"后写"方');
  ok(/valenceConflict && overlapRatio > 0\.5/.test(mm),
    '效价冲突类**不可达**：要求效价相反，而 panorama 恒 neutral');
  ok(/type: 'panorama', source: 'synthesis'/.test(mm),
    'panorama 写入固定 source = synthesis（故不会被当"用户纠正方"覆盖内容）');
  ok(/if \(antithesis\.source === 'user_instruction' \|\| antithesis\.source === 'user_correction'\) continue;/.test(mm),
    '按 id 归档类**不可达**：反题为用户指令/纠正即跳过扬弃；而 panorama 对立面恰是用户指令时才会被标（见上一条）');
  eq((mm.match(/ctx\.conflict_flag = true/g) || []).length, 2, '写 `conflict_flag` 恰 2 处（可达面正由这两处决定）');

  // ── 夹具：★ 先 new MemoryManager 再插行（生产顺序：引擎启动即 new，行是其后经应用写入的）──
  const typeOf = (d: AnyDb, id: string) => (d.prepare('SELECT memory_type FROM wa_memories WHERE id = ?').get(id) as { memory_type: string }).memory_type;
  const ctxOf = (d: AnyDb, id: string) => JSON.parse((d.prepare('SELECT context_json FROM wa_memories WHERE id = ?').get(id) as { context_json: string }).context_json) as Record<string, unknown>;
  const archivedCount = (d: AnyDb) => d.prepare("SELECT COUNT(*) c FROM wa_memories WHERE memory_type = 'archived'").get() as { c: number };
  const insMem = (d: AnyDb, id: string, content: string, type: string, source: string, importance: number, ctxJson: string, at: string) =>
    d.prepare(`INSERT INTO wa_memories (id, project_id, content, memory_type, source, importance, valence, use_count, context_json, created_at, updated_at)
               VALUES (?,?,?,?,?,?,'neutral',0,?,?,?)`).run(id, 'p1', content, type, source, importance, ctxJson, at, at);
  const withProject = (): AnyDb => { const d = mkdb(); d.prepare("INSERT INTO wa_projects (id, name) VALUES ('p1','本项目')").run(); return d; };
  const d40 = daysAgo(40); const d41 = daysAgo(41); const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // ── 场景1：衰减/精简路径（判据 importance）──
  const db1 = withProject();
  const mgr1 = new MemoryManager(db1 as never, {} as never);
  insMem(db1, 'pano1', '【概况】本项目全景：整合认识', 'panorama', 'synthesis', 0.05, '{}', d40);
  insMem(db1, 'sem1', '一条早已无用且久未使用的语义记忆', 'semantic', 'agent_execution', 0.05, '{}', d40);
  const r1 = mgr1.runConsolidationPipeline('p1');
  ok(r1.forgotten + r1.pruned >= 1, '管线**真归档过**——否则"panorama 还在"只是因为管线没干活', JSON.stringify(r1));
  eq(typeOf(db1, 'pano1'), 'panorama', 'panorama（importance 0.05）跑完管线**仍是 panorama**——它本会被归档');
  eq(typeOf(db1, 'sem1'), 'archived', '对照：同条件的 semantic **被归档**（例外只对 panorama 生效，没修坏衰减/精简）');
  eq(archivedCount(db1), { c: 1 }, '归档总数恰 1（不是"一条都没归档"，也不是"全归档了"）');

  // ── 场景2：过期冲突路径（可达性用**真管线**证，不靠推断）──
  const db2 = withProject();
  const mgr2 = new MemoryManager(db2 as never, {} as never);
  // 用户指令更早 ⇒ 成为 older；panorama 更晚 ⇒ 成为 newer。两者共享 token（判据是重叠率，非语义冲突）
  insMem(db2, 'ui1', '关键约束 alpha beta gamma', 'semantic', 'user_instruction', 0.9, '{}', d41);
  insMem(db2, 'pano2', '关键约束 alpha beta gamma 【概况】本项目全景：整合认识', 'panorama', 'synthesis', 0.8, '{}', d40);
  const r2 = mgr2.runConsolidationPipeline('p1');
  eq(r2.conflicts, 1, '① 真管线检出 1 处矛盾（否则下面的"被打标"无从谈起）', JSON.stringify(r2));
  eq(ctxOf(db2, 'pano2').conflict_flag, true,
    '② **可达性实证**：`conflict_flag` 真被打在了 **panorama** 上（不是打在用户指令上）');
  eq(ctxOf(db2, 'pano2').conflict_with, 'ui1', '打标所指的对象是那条用户指令（判据 token 重叠 ≥0.3）');
  eq(typeOf(db2, 'pano2'), 'panorama',
    '③ 同一次管线里 panorama **没被"过期冲突"清掉**——updated_at 已 40 天 > 7 天，本该命中（0→1 正面断言）');
  eq(r2.pruned, 0, '④ 冲突精简直击 0（未修则此处为 1：那条被清掉的正是 panorama）');
  eq(typeOf(db2, 'ui1'), 'semantic', '⑤ 用户指令未被归档（冲突以"打标"处理，不是删一方）');

  // ── 反证：把例外从句子里摘掉 ⇒ **同一份生产 SQL** 立刻归档掉 panorama ──
  const db3 = withProject();
  insMem(db3, 'panoLow', '【概况】本项目全景：整合认识', 'panorama', 'synthesis', 0.05, '{}', d40);
  insMem(db3, 'panoFlagged', '【概况】本项目全景：整合认识', 'panorama', 'synthesis', 0.8, '{"conflict_flag":true}', d40);
  let strippedRan = 0;
  for (const s of [...byImportance, ...byFlag]) {
    const stripped = s.replace(/ AND memory_type NOT IN \('archived', 'panorama'\)/, " AND memory_type != 'archived'");
    if (stripped === s) continue; // 未含例外者不动（本段只想验"例外是承重的"）
    db3.prepare(stripped).run('p1', now);
    strippedRan++;
  }
  eq(strippedRan, 3, '三处可达生产 SQL 都可就地取出并跑（对照实验的前提成立）');
  eq(typeOf(db3, 'panoLow'), 'archived',
    '反证：摘掉例外后，按 importance 的两条把 panorama 归档了 ⇒ 例外是承重的');
  eq(typeOf(db3, 'panoFlagged'), 'archived',
    '反证：摘掉例外后，按 conflict_flag 的那条**也**把 panorama 归档了（即首版漏改的那条）');
}

// ══════════════════════════════════════════════════════════════════
// S12 M3-3 水位分项如实计量（真 buildTools × 静态口径）
// ══════════════════════════════════════════════════════════════════
function s12Watermark(): void {
  console.log('\n[S12 M3-3 `toolsCount`/`toolsChars` 分项：计量如实，且**不入** waterPct（D4 裁定）]');
  const ae = aeSrc();

  const db = mkCtx();
  const tools = buildTools({ db } as never, 't1', 'p1', process.cwd()) as unknown as Record<string, unknown>;
  const toolsCount = Object.keys(tools).length;
  const toolsChars = JSON.stringify(tools).length;
  eq(toolsCount, TOOL_METAS.length, `运行期 toolsCount(${toolsCount}) === TOOL_METAS.length（工具集与元数据表同尺）`);
  ok(toolsChars > 0, '`toolsChars > 0`（防"加了字段永远是 0"）', `${toolsChars} 字符`);

  ok(ae.includes('toolsCount, toolsChars') && /const toolsChars = JSON\.stringify\(tools\)\.length/.test(ae),
    '`context_watermark` 字面量真含 `toolsCount`/`toolsChars`，且取自 `JSON.stringify(tools).length`（函数被丢弃 ⇒ 恰是下发的 schema 体积）');

  // 口径：waterPct 仍只由 messages 派生（未纳入工具 schema）
  // ⚠ **zx_20260921 M2 就地订正（判据形状，非源码）**：原判据把**逐元素表达式**钉成了字面量
  //   `String(m.content || '').length`。M2 起 `messages` 的 `content` 可以是
  //   `Array<TextPart|ImagePart>`，而 `String([{…}])` 恒得 `[object Object]`（一张 2MB 的图与一段短文本
  //   估成**同一个常数**）⇒ 该表达式**必须**换成 `contentChars(m.content)`，否则估算闸形同虚设。
  //   本条要的**意图**是"水位的字符量**只由 messages 派生**（不并入 tools schema）"，与逐元素怎么算无关。
  //   故改判意图：被测对象仍是 `messages`，且逐元素走的是**收得住数组 content** 的那把口。
  // ⚠ **zx_20261012_3 批二 就地订正（判据形状，非源码）**：原判据把分度式钉成字面量
  //   `Math.ceil(ctxAssembledChars / 4)`。批二把字符→token 的分度**收成一处真源**
  //   （`token-estimate.ts` 的 `estimateTokensFromChars`）⇒ 此处按**符号**重定向到新载体，
  //   并**加强**为"本地不许再手写一份 `Math.ceil(…/4)`"（改钉更强的新真源，不是放宽）。
  //   本条要的**意图**不变：`approxTokens` **只由** `messages` 字符数派生。
  ok(/ctxAssembledChars = messages\.reduce\(\s*\(a, m\)\s*=>\s*a \+ contentChars\(m\.content\)\s*,\s*0\)/.test(ae)
    && /const approxTokens = estimateTokensFromChars\(ctxAssembledChars\)/.test(ae)
    && !/Math\.ceil\(\s*ctxAssembledChars\s*\/\s*4\s*\)/.test(ae),
    '`approxTokens` 仍只由 `messages` 字符数派生（口径不变；逐元素走 `contentChars` 收得住数组 content；分度引 `estimateTokensFromChars` 一处真源）');
  const waterLine = ae.split('\n').find(l => l.includes('const waterPct =')) ?? '';
  ok(!/tools/i.test(waterLine), '反证：`waterPct` 那一行**不含 tools**——分项未被偷偷并入预警口径', waterLine.trim());

  // 顺序：工具集须先于水位块构造（否则分项恒 undefined）
  const iTools = ae.indexOf('const tools = buildTools(');
  const iWater = ae.indexOf('latestCtx.context_watermark =');
  ok(iTools > 0 && iWater > 0 && iTools < iWater, '`buildTools` 调用**先于**水位落库（否则 toolsCount 恒 undefined）',
    `buildTools@${iTools} < context_watermark@${iWater}`);
  eq((ae.match(/const tools = buildTools\(/g) || []).length, 1, '`buildTools` 调用**恰一处**（前移未留下第二份构造）');
}

// ══════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  await s10Skills();
  s10bRegistry();
  s11Panorama();
  s12Watermark();
  console.log('\n[S13 轮级 build 钉子（P1–P6 派生一致性）]');
  checkBuildPins(ok, { distDir: path.join(__dirname, '..', `${A}/dist`) });
  console.log(`\n结果: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

void main();
