/**
 * zx_20260924_1 受控复跑 —— 「父任务从来没落过拆解标记」+「模板匹配容不下不规范输入」
 * （两处独立缺陷，用户 2026-09-24 点名先修，不计入本轮 M1–M8 批次门）。
 *
 * ── 缺陷B：`ipc/project.ipc.ts` 那条**落标 UPDATE** 从 2026-09-03 起就是坏的 ──────────────
 *   原写 `json_set(json_set(json_set(json_set(…` —— **5 组键值对只套 4 层** ⇒ SQLite 抛
 *   `near ",": syntax error`，被紧跟的 `catch` 吞成一条 `模板拆解失败(已忽略)` warn。
 *   后果：父任务永远拿不到 `template` / `matched_*`、「已拆分为N个子任务」回执也永远不落库，
 *   而 `match_count` 已 +1 —— 用户**只看见计数涨、收不到回执**；GUI「🧩 模板拆解」行永不显示。
 *   ⚠ 同一处还有**第二颗哑弹**：`json(?)` 喂的是**裸字符串**（`json('web_app')` / `json('keyword')`）
 *     ⇒ 即便括号补齐也照样 `malformed JSON`。两颗都得除。
 *   ⚠ 它活了 20 天，是因为 `rr_zx_20260913_3:261` 把**坏字面量整段钉住**当了判据——
 *     判据成了病根的守卫，谁也改不动它（同 `zx_20260920_1` ★「判据的自我印证」一族）。
 *
 * ── 缺陷C：模板识别匹配只读标题 ─────────────────────────────────────────────────────
 *   原判据 `matchText = 标题 || 描述前100字` —— **只要标题非空，描述就一个字都不参与匹配**。
 *   「某项目前端所需API接口识别」：标题里的 `前端`+`api` 命中 `web_app`(2)，而描述里白纸黑字的
 *   「形成…规划排期方案…写入 plans/backend/20260924.md」从未被读过 ⇒ 被误拆成
 *   「项目初始化（npm init）/核心功能实现/测试与注册产出物」，与"识别既有接口、产出规划 .md"南辕北辙。
 *   现：守卫与匹配**归一处**（`decideTemplateMatch`，`task:create` 与 `template:test` 同源），
 *   守卫扫「标题 + 描述」全文，匹配为「标题 ≥2 或 描述 ≥3」——描述这才第一次真正参与。
 *
 * §G 不变式门：
 *   G-1 **真源在位**：直接 `import` 生产符号（`decideTemplateMatch` / `matchTaskTemplate` /
 *       `isPlanningOrOptimizationIntent` / `TASK_TEMPLATES` / `loadTemplatePool`）——被删/改名 ⇒ 编译期失败，
 *       而不是"扫了个空、静默假绿"。
 *   G-2 **两只标本**：每条判据两侧都有真标本（该命中 / 该不命中），含第三态「本可命中但守卫拦下」；
 *       门槛类判据另配"刚好差一个"的标本（2 不够 / 3 够）。
 *   G-3 **扫描面自证**：凡"零命中"类断言一并报出扫描面。
 *
 * ⚠ 本脚本**不写任何轮次字面量**（`scripts/lib/rr-pins.ts` 的 P5 逐处点名 file:line）。
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins } from './lib/rr-pins.js';
import {
  decideTemplateMatch, matchTaskTemplate, isPlanningOrOptimizationIntent,
  TASK_TEMPLATES, loadTemplatePool,
} from '../apps/worker-ant-desktop/src/main/core/task-templates.js';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const MAIN = path.join(root, `${A}/src/main`);
const RENDERER = path.join(root, `${A}/renderer/src`);

// ── 夹具：内存库 + 真模板池（生产顺序：先建表、再 loadTemplatePool）─────────────
//   `ensurePool` 有模块级缓存，直接 new 出来的池是空的 ⇒ 必须显式重载，
//   否则下面所有匹配判据会在**空池**上跑（每条都该"不命中"）——那是自我印证式的假绿。
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE wa_task_templates (
  id TEXT PRIMARY KEY, name TEXT, category TEXT, description TEXT, subtasks TEXT, keywords TEXT,
  status TEXT, priority INTEGER, source TEXT, match_count INTEGER, created_at TEXT, updated_at TEXT
)`);
// ⚠ 夹具须**覆盖被断言的语句所触及的每一列**：首版漏了 `updated_at`，那条 UPDATE 一跑就抛
//   `no such column: updated_at`（夹具比生产**窄** ⇒ 与"夹具比生产宽松致假绿"是同一根病因的两面，
//   好在窄是**响亮**的失败，不会静默）。
db.exec(`CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT,
  parent_task_id TEXT, context_json TEXT, priority INTEGER, source TEXT, updated_at TEXT)`);
for (const t of Object.values(TASK_TEMPLATES)) {
  db.prepare('INSERT INTO wa_task_templates (id, name, category, description, subtasks, keywords, status, priority, source, match_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(t.id, t.name, t.category, t.description, JSON.stringify(t.subtasks), JSON.stringify(t.keywords), 'active', t.priority ?? 0, 'system', 0);
}
loadTemplatePool(db);
db.prepare("INSERT INTO wa_tasks (id, title, description, status, context_json) VALUES ('T-1', '占位', '', 'pending', '{\"client_request_id\":\"r-1\"}')").run();

// ── 探针工厂 ────────────────────────────────────────────────────────────────
/** 一条标本的判定摘要（判据只读这几个字段，便于两只标本并排看） */
function probe(title: string, description: string) {
  const d = decideTemplateMatch(db, title, description);
  const m = matchTaskTemplate(db, title, description);
  return {
    skip: d.skip,
    semanticText: d.semanticText,
    hitId: d.hit?.template.id ?? null,
    hitField: d.hit?.field ?? null,
    hitKeywords: d.hit?.hitKeywords ?? [],
    bareHitId: m?.template.id ?? null,
    /** 真建任务时**会不会**拆（skip 为空且命中了声明 ≥2 个子任务的模板） */
    wouldDecompose: d.skip === null && !!d.hit && d.hit.template.subtasks.length >= 2,
  };
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【A】缺陷C：模板识别匹配（真跑生产函数，非扫源码字符串）');

// A-1 该不命中 —— 用户报的那一条。守卫必须从**描述**里读出"规划/排期/方案"。
const a1 = probe(
  '某项目前端所需API接口识别',
  '识别既有 Java 后端所需接口，形成前端调用规划排期方案，写入 plans/backend/20260924.md',
);
ok(a1.skip === 'planning_intent' && !a1.wouldDecompose,
  'A-1 **该不命中**（用户报的那条）：标题含 `前端`+`api` 但描述声明了规划排期意图 ⇒ 不拆',
  `skip=${a1.skip} wouldDecompose=${a1.wouldDecompose}`);
// 同一标本的**另一只面**：只按关键词看它**确实**命中 web_app —— 说明拦住它的是守卫，不是"没命中"。
ok(a1.bareHitId === 'web_app',
  'A-1b 同标本：单看关键词它**确实**命中 web_app ⇒ 拦住它的是守卫、不是"没命中"（否则本判据的成因就记错了）',
  `单看匹配=${a1.bareHitId}`);
// A-1c **真入参**（逐字取自真库那条任务，非自造等价物——承 feedback_verify_roundtrip_at_production_input.md）：
//   上面 A-1 的描述是我压缩过的，压缩件可能恰好比真件"好判"。真件更长、守卫词更多，须逐字再验一次。
const REAL_SAMPLE_DESC = `请分析当前某项目微信小程序原型静态代码(目录：mini-mp)，从中识别所需要的后端API接口；
根据识别所需的后端API接口，根据某项目后端系统当前现状形成实现所需API接口的规划排期方案；

在形成最终可行优化方案的过程中，如有任何不明确之处，可随时使用中文与我交流、确认，并附上您的建议。
后端最终方案须以优化升级规划排期方案的形式，写入指定文件 plans/backend/20260924.md。
前端(小程序)识别的需要的后端API，写入指定文件 plans/mp/api.md。
方案内容需经确认后方可实施。`;
const a1c = probe('某项目前端所需API接口识别', REAL_SAMPLE_DESC);
ok(a1c.skip === 'planning_intent' && !a1c.wouldDecompose && a1c.bareHitId === 'web_app',
  'A-1c **真入参**（真库逐字描述）同判：守卫读得到描述 ⇒ 不拆；而单看关键词仍命中 web_app（成因不是"没命中"）',
  `skip=${a1c.skip} 单看匹配=${a1c.bareHitId} 描述长度=${REAL_SAMPLE_DESC.length}`);

// A-2 该不命中 —— 守卫扫**描述**（只看标题的旧口径下此条必绿 ⇒ 本判据是"守卫输入面"的正面证据）
const a2 = probe('启动 TrendRadar MCP Server 并注册', '完成后撰写总结，并评估是否需要优化');
ok(a2.skip === 'planning_intent' && !a2.wouldDecompose,
  'A-2 **该不命中**：标题本身 ≥2 命中，但**描述**里含"总结/优化" ⇒ 不拆（反证：守卫只看标题时此条会拆）',
  `skip=${a2.skip} 单看匹配=${a2.bareHitId}`);

// A-3 该命中 —— 真部署意图，标题驱动（旧口径也命中 ⇒ 不能因改口径把它改没了）
const a3 = probe('启动 TrendRadar MCP Server 并注册', '');
ok(a3.hitId === 'mcp_deploy' && a3.hitField === 'title' && a3.wouldDecompose,
  'A-3 **该命中**：真部署意图（标题驱动）⇒ 命中 mcp_deploy 且会拆解',
  `hit=${a3.hitId} field=${a3.hitField} kw=${a3.hitKeywords.join('/')}`);
ok(a3.hitKeywords.length >= 2,
  'A-3b 命中关键词取自**真正命中的那一侧**且 ≥2（标题门槛未被放宽）',
  `kw=${a3.hitKeywords.join('/')}`);

// A-4 该命中 —— **描述独立命中**：旧口径下这条路根本不存在（标题非空即屏蔽描述）
const a4 = probe('内部小工具站', '用 vite 起前端页面，后端 api 用 fastapi');
ok(a4.hitId === 'web_app' && a4.hitField === 'description' && a4.wouldDecompose,
  'A-4 **该命中**（描述独立驱动）：标题零命中、描述命中 3 个 ⇒ 命中 web_app（旧口径下此条必不命中）',
  `hit=${a4.hitId} field=${a4.hitField} kw=${a4.hitKeywords.join('/')}`);

// A-5 门槛的两只标本：描述 2 个词**不够**、3 个词**够**
const a5lo = probe('内部小工具站', '用 vite 起前端页面并用 api 调数据');
ok(a5lo.hitField !== 'description' && !a5lo.wouldDecompose,
  'A-5 **门槛下侧标本**：描述只命中 2 个关键词 ⇒ 不足 3，不靠描述命中（门槛没有形同虚设）',
  `hit=${a5lo.hitId} field=${a5lo.hitField}`);
ok(a4.wouldDecompose && a5lo.hitField === null,
  'A-5b 上/下两侧并排：3 个词命中、2 个词不命中 ⇒ 门槛值确实落在 3（不是"随便多一个就算"）',
  `3词=${a4.hitField} / 2词=${a5lo.hitField}`);

// A-6 该不命中 —— 显式子任务守卫（两条守卫的**先后**也要对：显式优先）
const a6 = probe('做两件事', '子任务A：搭建前端 api；子任务B：后端 api 与网站');
ok(a6.skip === 'explicit_subtasks' && !a6.wouldDecompose,
  'A-6 **该不命中**：描述已含显式子任务 ⇒ skip=explicit_subtasks（与规划意图守卫分属两态、不混为一谈）',
  `skip=${a6.skip}`);

// A-7 该不命中 —— 守卫函数自身两只标本
ok(isPlanningOrOptimizationIntent('项目功能优化') === true
  && isPlanningOrOptimizationIntent('搭建内部工具站') === false,
  'A-7 守卫函数两只标本：`项目功能优化`⇒真、`搭建内部工具站`⇒假（不是恒真/恒假）');

// A-8 语义兜底该喂哪段文本：与"谁在参与匹配"同一口径（标题为空才退描述）
const a8 = probe('', '部署一个 MCP 服务到测试机');
ok(a8.semanticText.length > 0 && a8.semanticText.startsWith('部署一个'),
  'A-8 标题为空 ⇒ 语义兜底退到描述前段（标题非空时仍只喂标题，避免长描述稀释相似度）',
  `semanticText=${a8.semanticText.slice(0, 18)}`);

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【B】口径归一处：调用面自证（扫描面一并报出，G-3）');

const ipcRel = 'ipc/project.ipc.ts';
const ipcSrc = fs.readFileSync(path.join(MAIN, ipcRel), 'utf-8');
const mainFiles: string[] = [];
(function walk(dir: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts')) mainFiles.push(p);
  }
})(MAIN);

// 扫描面：`src/main` 下全部 .ts，**但须剔除定义文件本身**——`export function decideTemplateMatch(`
// 也会被调用式正则命中，混进"调用点"里数（首版就是这么把 1 处定义 + 2 处调用数成 3 的吗？不，是
// `.every(endsWith ipcRel)` 把定义文件那处判红了——**不管哪种数法，定义与调用必须分开数**）。
const DEF_REL = 'core/task-templates.ts';
const readMain = (p: string): string => fs.readFileSync(p, 'utf-8');
const defSites = mainFiles.filter((p) => p.endsWith(DEF_REL));
// ⚠ 数"调用点"要按**出现次数**数，不能按**文件**数——两处调用恰在同一文件里，
//   按文件数会得 1（首版就把 2 处调用误报成"只有 1 处"，差点据此去查一个不存在的合并）。
//   反向同理：B-2 的"零命中"才是按文件数（它问的是"还有没有人在用旧 API"）。
const callOccurrences: Array<{ file: string }> = [];
for (const p of mainFiles) {
  if (p.endsWith(DEF_REL)) continue;
  const n = (readMain(p).match(/\bdecideTemplateMatch\(/g) || []).length;
  for (let i = 0; i < n; i++) callOccurrences.push({ file: p });
}
const oldApiSites = mainFiles.filter((p) => !p.endsWith(DEF_REL) && /(?<![A-Za-z])matchTemplate\(/.test(readMain(p)));
ok(defSites.length === 1,
  'B-0 **定义恰一处**（`core/task-templates.ts`；定义被删/搬走则本判据先红，后面"2 处调用"才有意义）',
  `扫描面 ${mainFiles.length} 个 .ts，定义 ${defSites.length} 处`);
ok(callOccurrences.length === 2 && callOccurrences.every((c) => c.file.endsWith(ipcRel)),
  'B-1 `decideTemplateMatch` 恰 2 处**调用**（按出现次数数，非按文件数），且都在 project.ipc.ts（task:create 与 template:test）',
  `扫描面 ${mainFiles.length} 个 .ts（剔除定义文件），命中 ${callOccurrences.length} 处，落在 ${new Set(callOccurrences.map((c) => path.basename(c.file))).size} 个文件`);
ok(oldApiSites.length === 0,
  'B-2 **零命中**：`src/main` 下再无旧 API `matchTemplate(` 的调用（口径不再有两个入口）',
  `扫描面 ${mainFiles.length} 个 .ts，命中 ${oldApiSites.length} 处`);
ok(/decideTemplateMatch\(db, title \|\| '', description \|\| ''\)/.test(ipcSrc),
  'B-1b task:create 把**标题与描述一并**交给同一判据（描述这才第一次真正参与）');
ok(/decideTemplateMatch\(db, titleText, descText\)/.test(ipcSrc),
  'B-1c 另一处在 `template:test`（两处各是**不同的**调用形 ⇒ 上面"2 处"不是同一行被数了两遍）');
ok(/\{ title, description \}: \{ title\?: string; description\?: string \}/.test(ipcSrc),
  'B-3 `template:test` 入参改为 `{ title, description }`（与创建侧同一组输入，才谈得上"同口径"）');
const rendererIpc = fs.readFileSync(path.join(RENDERER, 'lib/ipc.ts'), 'utf-8');
const rendererPage = fs.readFileSync(path.join(RENDERER, 'pages/TemplatesPage.tsx'), 'utf-8');
ok(/\btest: \(title: string, description\?: string\)/.test(rendererIpc)
  && /tplIpc\.test\(testTitle, testDesc\)/.test(rendererPage),
  'B-4 前端→后端对齐：renderer 的 `test(title, description)` 与页面两栏输入同形（不是"一头改了另一头没改"）');
ok(/skip: 'explicit_subtasks' \| 'planning_intent' \| null/.test(rendererIpc)
  && /setTestSkip\(r\.skip\)/.test(rendererPage),
  'B-5 `skip` 一路回传到界面（"本可命中但不会拆"这一态此前一个字都不说，用户无法据此改输入）');
const detail = fs.readFileSync(path.join(RENDERER, 'pages/TaskDetailPage.tsx'), 'utf-8');
ok(/c\.matched_field as 'title' \| 'description' \| undefined/.test(detail) && /命中\{matchedInfo\.field/.test(detail),
  'B-6 任务详情页透出「命中标题/命中描述」（描述现在能独立命中，用户须看得见是命中在哪一侧）');

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【C】缺陷B：**真跑**那条落标 UPDATE（从源码取出 SQL，逐键核对）');

const sqlRe = /db\.prepare\(`(UPDATE wa_tasks SET context_json = json_set\([\s\S]*?WHERE id = \?)`\)([\s\S]{0,400}?);/;
const sqlHit = ipcSrc.match(sqlRe);
ok(!!sqlHit, 'C-1 从 project.ipc.ts 取出落标 UPDATE（取不到则下面全条无从谈起，先自证扫描面）');
const sql = sqlHit?.[1] ?? '';
const paramCount = (sql.match(/\?/g) || []).length;
ok(paramCount === 6,
  'C-1b 该语句的占位符恰好 6 个 = 6 组键值对里的**值**（层数与键值对数解耦后，数错一处必红）',
  `实测 ${paramCount} 个`);

/** 落标后读回：连"既有键是否被保留"一起读（json_set 的语义是不动其它键） */
function readBack(): Record<string, unknown> {
  return db.prepare(`SELECT
      json_extract(context_json,'$.auto_decomposed')    AS ad,
      json_type   (context_json,'$.auto_decomposed')    AS ad_t,
      json_extract(context_json,'$.template')           AS tpl,
      json_extract(context_json,'$.matched_method')     AS method,
      json_extract(context_json,'$.matched_keywords')   AS kws,
      json_extract(context_json,'$.matched_similarity') AS sim,
      json_type   (context_json,'$.matched_similarity') AS sim_t,
      json_extract(context_json,'$.matched_field')      AS field,
      json_type   (context_json,'$.matched_field')      AS field_t,
      json_extract(context_json,'$.client_request_id')  AS keep
    FROM wa_tasks WHERE id = 'T-1'`).get() as Record<string, unknown>;
}

// C-2 真跑：一般路（关键词命中）
let threw = '';
try {
  db.prepare(sql).run('mcp_deploy', 'keyword', JSON.stringify(['mcp', 'server']), 0.87, 'title', 'T-1');
} catch (e) { threw = e instanceof Error ? e.message : String(e); }
ok(threw === '', 'C-2 **真跑不抛**（旧写法在此处抛 `near ",": syntax error`，被 catch 吞成一条 warn）',
  threw || '无异常');
const r1 = readBack();
ok(r1.ad_t === 'true' && r1.ad === 1, 'C-2b `$.auto_decomposed` 落 `true`（GUI 判据 `if (!c.template || !c.auto_decomposed) return null` 的前半）',
  `json_type=${String(r1.ad_t)}`);
ok(r1.tpl === 'mcp_deploy', 'C-2c `$.template` 落模板 id 为**字符串**（旧写法 `json(\'web_app\')` 会 malformed JSON）',
  `实测 ${JSON.stringify(r1.tpl)}`);
ok(r1.method === 'keyword', 'C-2d `$.matched_method` 落 `keyword`（同上，裸字符串是第二颗哑弹）',
  `实测 ${JSON.stringify(r1.method)}`);
let kws: unknown = null; try { kws = typeof r1.kws === 'string' ? JSON.parse(r1.kws) : null; } catch { kws = null; }
ok(Array.isArray(kws) && (kws as string[]).join('/') === 'mcp/server',
  'C-2e `$.matched_keywords` 落**数组**（不是被字符串化的数组）', `实测 ${String(r1.kws)}`);
ok(r1.sim === 0.87 && r1.sim_t === 'real',
  'C-2f `$.matched_similarity` 落**数字** 0.87（若按 TEXT 落库会变字符串 "0.87"，界面 `相似度 0.87` 就成了偷换类型）',
  `值=${String(r1.sim)} type=${String(r1.sim_t)}`);
ok(r1.field === 'title', 'C-2g `$.matched_field` 落 `title`（新增键：描述现在能独立命中，须记下命中的是哪一侧）',
  `实测 ${JSON.stringify(r1.field)}`);
ok(r1.keep === 'r-1', 'C-2h 幂等：`json_set` 不动既有键（`client_request_id` 仍在 ⇒ 不是整段覆盖 context_json）',
  `实测 ${JSON.stringify(r1.keep)}`);

// C-3 真跑：语义路 / 空值（`matched_field=''` 必须落成 JSON null，而不是空字符串）
let threw2 = '';
try {
  db.prepare(sql).run('data_analysis', 'semantic', JSON.stringify([]), 0.62, null, 'T-1');
} catch (e) { threw2 = e instanceof Error ? e.message : String(e); }
const r2 = readBack();
ok(threw2 === '' && r2.field_t === 'null' && r2.field === null,
  'C-3 语义路：`matched_field` 缺省时落 **JSON null**（不是 `""`——空串会让 `if (c.matched_field)` 判真把"没这回事"说成"命中标题"）',
  `type=${String(r2.field_t)} 值=${JSON.stringify(r2.field)}`);
ok(r2.sim === 0.62 && r2.kws === '[]',
  'C-3b 语义路相似度照常落在非空行上（覆盖写：第二次落标不因上次的值残留而假绿）',
  `sim=${String(r2.sim)} kws=${String(r2.kws)}`);

// C-4 参数顺序与 SQL 同源（SQL 跑得对 + 实参喂得对，两条合起来才算这条语句是活的）
const runArgs = (sqlHit?.[2] ?? '').replace(/\s+/g, ' ');
ok(/\.run\(tpl\.id, matchedMethod, JSON\.stringify\(hitKeywords\), matchedSimilarity, matchedField \|\| null, id\)/.test(runArgs),
  'C-4 实参顺序与 6 个占位符逐一对应（顺序错位不会报错、只会静默写错值——故单列一条）',
  runArgs.slice(0, 96));
// C-5 反证：多层套娃不再出现（"层数≠键值对数"这一病根形态被结构上移除）
ok(!/json_set\(json_set\(/.test(ipcSrc),
  'C-5 **反证**：project.ipc.ts 再无从 `json_set(json_set(` 起的手工套娃（改回旧形态此判据必红）',
  `扫描面 ${ipcSrc.length} 字节`);
// C-6 回执紧跟其后且中间无提前退出 ⇒ 落标不再抛，回执就一定会落
const atMark = sqlHit ? ipcSrc.indexOf(sqlHit[0]) : -1;
const atReceipt = ipcSrc.indexOf('[模板拆解] 任务匹配模板');
const between = atMark >= 0 && atReceipt > atMark ? ipcSrc.slice(atMark + sqlHit![0].length, atReceipt) : '';
ok(between.length > 0 && !/\breturn\b/.test(between) && !/\bthrow\b/.test(between),
  'C-6 落标 UPDATE 与「已拆分为N个子任务」回执之间**无提前 return/throw**' +
  '（落标一抛，回执就跟着不落——这正是此前"计数涨了、回执没到"的完整因果）',
  `间隔 ${between.length} 字节`);

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【S】build 钉（派生核对，不写轮次字面量）');
checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260924_1: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
