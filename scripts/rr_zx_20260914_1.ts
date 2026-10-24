/**
 * zx_20260914_1 受控复跑 —— M0.6「一次点击只该创建一个任务」。
 *
 * ── 病根（真库实证）──
 *   `task:create` handler 开头即无条件 INSERT ⇒ 快速连点两次「创建」= 两次并发 IPC = 两行。
 *   实证：任务 f07ad74a 与 8d9be3f8 相隔 286ms 各建一份；8d9be3f8 还各自跑完一整个生命周期
 *   （goal_identified / status_changed / 拆解子任务），用户随后手工删掉多出的那份。
 *   为何 renderer 的 `creating` 标志挡不住：React state 在**同一 tick 的两次点击**之间来不及更新，
 *   两次调用都读到 creating=false ⇒ 必须由**主进程**判重，而判重的前提是"两次调用带同一个键"。
 *
 * ── 改法（两层，各有其不可替代之处）──
 *   主进程（判据层）：`context_json.client_request_id` 幂等键；**同一同步段**内先查后插，命中即返回既有行。
 *   renderer（体验层）：一次表单会话生成一个键（`createReqIdRef` + `useEffect(..., [showOpen])`），
 *     在途标志 disabled 按钮 —— 挡"看得见的连点"；主进程去重兜"挡不住的"。
 *
 * ── 本文件怎么证的（承 feedback「往返/闭环须在生产入参上证」「rr 夹具须按生产初始化顺序」）──
 *   §S1 不是在测试里重写一遍判重逻辑，而是把**生产源码切片**取出来、用 `new Function` 挂上真库**直接执行**
 *       （生产分支 × 生产 SQL × 生产夹具）。切片一变（SQL 改、分支改序、出现 await），断言即红。
 *   §S2 库真值：第二次调用除返回既有行外，**不产生任何库变更**（全表前后快照逐字比对）。
 *   §S3 渲染层按读点穷举：两处 handleCreate × 在途标志、两处按钮 disabled、键"一会话一个"。
 *   §S4 调用面穷举：renderer 内 task 创建调用点恰 2 处（断言名 = 扫描面）。
 *
 * ⚠ 本文件不打开任何真库（真库只读实测见 data/baseline_zx_20260914.json）。
 * ⚠ 本批实施期为热修（当时 build 仍 zx_20260913）；**zx_20260914 M4 收口已刷值**，本脚本现接轮级 build 闸。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins } from './lib/rr-pins.js';
// zx_20260916_3 M1：切片窗口内新增的槽位闸以**真实现**注入（不在脚本里复刻判据）
import { childBreadthRefusal } from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) => ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const RD = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
type AnyDb = import('better-sqlite3').Database;

/** 取 `head` 匹配处起、**括号配平**至调用结束的实参文本（不含外层括号） */
function extractCall(src: string, head: RegExp): string {
  const m = head.exec(src);
  if (!m) return '';
  let i = m.index + m[0].length; let depth = 1; const start = i;
  for (; i < src.length && depth > 0; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
  }
  return src.slice(start, i - 1);
}
/** 按**顶层**逗号切分实参（括号/方括号/花括号内的逗号不算分隔符） */
function splitTopLevelArgs(s: string): string[] {
  if (!s.trim()) return [];
  const out: string[] = []; let depth = 0; let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

// 夹具 schema 按 database.ts DDL 摘取被生产 SQL/快照触及的表（NOT NULL 照抄，防"夹具比生产宽松"的假绿）
const SCHEMA = `
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT,
  title TEXT NOT NULL, description TEXT DEFAULT '', status TEXT DEFAULT 'pending',
  context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
  source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '',
  aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT,
  role TEXT NOT NULL, content TEXT DEFAULT '', tool_calls TEXT,
  token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL DEFAULT '{}',
  metadata TEXT DEFAULT '{}', occurred_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')));
`;
const mkdb = (): AnyDb => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d as unknown as AnyDb; };

// ─────────────────────────────────────────────────────────────────────────────
// §S1 生产分支即真实现：源码切片 × 真库
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n【S1】主进程判据层——源码切片直接执行（生产分支 × 生产 SQL）');

const ipcSrc = stripComments(RD(`${A}/src/main/ipc/project.ipc.ts`));

// 切片边界：自 `const reqId =` 起，至 INSERT 语句**之后**的第一条稳定代码 `let schemePlanId` 止。
// 用**代码**（而非注释）作右界——注释会被 stripComments 摘掉，且"改行数"不该让切片跑偏；只有改到切片内容才会。
// ⚠ zx_20260916_3 M1 订正锚点：右界原为 `if (parent_task_id) {`——当时该块是 INSERT **之后**的
//   "回填 parent_task_id" UPDATE。M1 把**父任务存在性校验 + 槽位闸**前移到 INSERT 之前，于是同一行
//   在文件中出现了**两次**，`indexOf` 取到的是**前面**那次 ⇒ 切片被截断在 INSERT 之前（`id` 未定义、
//   "查在插之前"判红）。这正是本仓已记的教训「锚点须按符号、不得依赖位置」的又一次实例：
//   改取 `let schemePlanId` 这一在后、且**语义无关**的稳定符号，切片含义（算键→查→早退→插入）一字不变。
const SLICE_START = 'const reqId = typeof client_request_id';
const SLICE_END = 'let schemePlanId';
const s0 = ipcSrc.indexOf(SLICE_START);
const s1 = ipcSrc.indexOf(SLICE_END, s0);
const branch = s0 >= 0 && s1 > s0 ? ipcSrc.slice(s0, s1) : '';
ok(branch.length > 0, '已从源码就地取出「算键→查→命中早退→插入」整段（生产真源，非测试重写）', `长度 ${branch.length}`);

// 判据的形状也一并钉住（切片取到的是不是我们要的那一段）
ok(branch.includes("json_extract(context_json, '$.client_request_id') = ?"), '切片含幂等键查询（键落 context_json，不新增列）');
ok(branch.includes('if (hit) return { data: hit };'), '切片含"命中即返回既有行"早退（不是查了不用）');
ok(branch.indexOf('if (hit) return { data: hit };') < branch.indexOf('INSERT INTO wa_tasks'),
  '查在插之前（顺序即语义：先判后写，不是先写后判）');
ok(!/\bawait\b/.test(branch), '窗口断言：查—插整段**不含 await**（跨 await 就会两次并发各自查到"无"再各自插，去重形同虚设）');

/** 把生产切片挂上真库执行——参数名与生产 handler 解构名逐字一致 */
// ⚠ zx_20260916_3 M1：切片窗口内新增了「父任务存在性校验 + 槽位闸」一段（它是 INSERT 前的同步代码，
//   落在同一去重窗口内是**对的**——跨窗口才会让并发去重失效）。故补两个自由变量：`parent_task_id`
//   （本脚本一律传 undefined：夹具不建父子链，该分支自然不进入）与 `childBreadthRefusal`（真实现）。
const mkCreate = (db: AnyDb) => new Function(
  'db', 'crypto', 'projectId', 'title', 'description', 'priority', 'acceptance_criteria', 'client_request_id',
  'parent_task_id', 'childBreadthRefusal',
  `${branch}\nreturn { data: db.prepare('SELECT * FROM wa_tasks WHERE id = ?').get(id) };`,
) as (db: AnyDb, crypto: { randomUUID: () => string }, projectId: string, title: string,
  description: string | undefined, priority: number | undefined, acceptance_criteria: string | undefined,
  client_request_id: string | undefined, parent_task_id: string | undefined,
  childBreadthRefusal: (db: AnyDb, taskId: string) => string | null) => { data: { id: string } };

const cryptoShim = { randomUUID };
const create = (db: AnyDb, key: string | undefined, title = '同名任务', projectId = 'p1') =>
  mkCreate(db)(db, cryptoShim, projectId, title, '', 0, '', key, undefined, childBreadthRefusal);
const rowCount = (db: AnyDb) => (db.prepare('SELECT count(*) AS c FROM wa_tasks').get() as { c: number }).c;
const snap = (db: AnyDb) => {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((r) => r.name).sort();
  return tables.map((t) => [t, JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all())]);
};

// ── ① 0→1 正向：同键两次 ⇒ 恰 1 行，且第二次返回**同一 id** ──
{
  const db = mkdb();
  eq(rowCount(db), 0, '起步 0 行（0 态，正面断言的前提）');
  const r1 = create(db, 'key-A');
  eq(rowCount(db), 1, '第一次调用 ⇒ 0→1（真插了一行）');
  const r2 = create(db, 'key-A');
  eq(rowCount(db), 1, '同键第二次调用 ⇒ **仍恰 1 行**（去重生效，不是又插一行）');
  eq(r2.data.id, r1.data.id, '第二次返回的是**既有那一行**（同一 id，调用方拿到的就是同一个任务）');
  const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(r1.data.id) as { context_json: string };
  eq(JSON.parse(row.context_json), { client_request_id: 'key-A' }, '幂等键确实落进 context_json（下次才查得到）');
  eq(rowCount(db), 1, '键落位后仍是 1 行（写键不是新增行）');
}

// ── ② 反证①：不带键连调两次 ⇒ 仍 2 行（证明断言抓的是"去重"，不是"恒只插一行"）──
{
  const db = mkdb();
  create(db, undefined);
  create(db, undefined);
  eq(rowCount(db), 2, '反证①：无键调用**不去重**（2 行）——不拿"同标题 N 秒内"猜意图，相似≠同一');
}

// ── ③ 反证②：键不同 ⇒ 2 行（合法的同名任务不被误伤）──
{
  const db = mkdb();
  create(db, 'key-A');
  create(db, 'key-B');
  eq(rowCount(db), 2, '反证②：键不同 ⇒ 2 行（两次真实意图各建一份，同名不算重）');
}

// ── ④ 反证③：把去重分支整段摘掉 ⇒ 同键两次必 2 行（证明①真的抓得住缺陷）──
{
  const db = mkdb();
  const stripped = branch.replace(/const reqId = [\s\S]*?if \(hit\) return \{ data: hit \};\n {6}\}/, 'const reqId = null;\n      ');
  ok(stripped !== branch, '反证③前提：能构造出"无去重"分支（切片确实变了）');
  const noDedupe = new Function('db', 'crypto', 'projectId', 'title', 'description', 'priority', 'acceptance_criteria', 'client_request_id',
    'parent_task_id', 'childBreadthRefusal',
    `${stripped}\nreturn { data: { id } };`) as (db: AnyDb, crypto: { randomUUID: () => string }, projectId: string,
      title: string, description: string | undefined, priority: number | undefined,
      acceptance_criteria: string | undefined, client_request_id: string | undefined,
      parent_task_id: string | undefined, childBreadthRefusal: (db: AnyDb, taskId: string) => string | null) => { data: { id: string } };
  const callCreate = (f: typeof noDedupe, k: string | undefined) => f(db, cryptoShim, 'p1', '同名任务', '', 0, '', k, undefined, childBreadthRefusal);
  callCreate(noDedupe, 'key-A');
  callCreate(noDedupe, 'key-A');
  eq(rowCount(db), 2, '反证③：摘掉去重分支 ⇒ 同键两次 2 行（正是 M0.6 修前的实机现象）⇒ ①的判据真的抓得住缺陷');
}

// ── ⑤ 跨项目不误伤：同键不同项目 ⇒ 各自建（键的作用域是项目内）──
{
  const db = mkdb();
  create(db, 'key-A', '任务', 'p1');
  create(db, 'key-A', '任务', 'p2');
  eq(rowCount(db), 2, '同键但**不同项目** ⇒ 2 行（键域=项目内，不跨项目吞掉另一个项目的创建）');
}

// ─────────────────────────────────────────────────────────────────────────────
// §S2 库真值：第二次调用不产生任何库变更
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n【S2】第二次调用除返回既有行外不产生任何库变更（含 wa_event_log）');
{
  const db = mkdb();
  const r1 = create(db, 'key-C');
  db.prepare('INSERT INTO wa_event_log (event_id, event_type, aggregate_type, aggregate_id, occurred_at) VALUES (?,?,?,?,?)')
    .run(randomUUID(), 'task.goal_identified', 'task', r1.data.id, new Date().toISOString());
  db.prepare('INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?,?,?,?)')
    .run(randomUUID(), r1.data.id, 'system', '首次创建产生的一句话');
  const before = snap(db);
  ok(db.prepare('SELECT count(*) AS c FROM wa_event_log').get() !== undefined, '夹具含 wa_event_log（快照覆盖到事件账）');
  const r2 = create(db, 'key-C');
  eq(snap(db), before, '第二次调用前后**全表快照逐字相同** ⇒ 不新增任务行/对话/事件（第二次生命周期的根被掐断）');
  eq(r2.data.id, r1.data.id, '且返回既有 id（早退发生在任何副作用之前）');

  // 反向：无键的第二次调用**会**产生新的库变更（证明快照比对真的敏感，不是恒等）
  const before2 = snap(db);
  create(db, undefined);
  ok(JSON.stringify(snap(db)) !== JSON.stringify(before2), '反证：无键再调一次 ⇒ 快照**变了**（说明上面的"逐字相同"是判据抓出来的，不是比对失灵）');
}

// ─────────────────────────────────────────────────────────────────────────────
// §S3 渲染层按读点穷举（断言名 = 扫描面）
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n【S3】渲染层两处入口均：在途标志 + 一会话一键 + 按钮禁用');
{
  // ipc 层声明是**元数真源**：页面实参个数由此**派生**，不手抄字面数（否则加参即误判——批二加 attachmentPaths 即此）。
  const ipc = stripComments(RD(`${A}/renderer/src/lib/ipc.ts`));
  const createDecl = ipc.slice(ipc.indexOf('create: (projectId: string'));
  const declParams = splitTopLevelArgs(createDecl.slice(createDecl.indexOf('(') + 1, createDecl.indexOf(') =>')));
  const declArity = declParams.length;
  const reqIdSlot = declParams.findIndex((p) => p.includes('clientRequestId'));
  ok(declArity >= 8 && reqIdSlot === 7,
    `ipc 层 tasks.create 声明元数=${declArity}，clientRequestId 槽位=${reqIdSlot}（元数真源；页面实参由此派生）`);
  // 两页实参个数由声明派生：TasksPage 用满全部槽（含尾部 attachmentPaths）；
  //   TaskDetailPage 建子任务**无附件 UI**，故止于 clientRequestId（少尾部 attachmentPaths 一项）。
  const expectArgs: Record<string, number> = { 'TasksPage.tsx': declArity, 'TaskDetailPage.tsx': declArity - 1 };

  const sites: Array<[string, string, string]> = [
    ['TasksPage.tsx', '创建', '无条件判据（新建任务）'],
    ['TaskDetailPage.tsx', '创建子任务', '带父任务判据（新建子任务）'],
  ];
  for (const [file, label, note] of sites) {
    const src = stripComments(RD(`${A}/renderer/src/pages/${file}`));
    const h = src.slice(src.indexOf('async function handleCreate'));
    const body = h.slice(0, h.indexOf('\n  }'));
    ok(src.includes('newClientRequestId'), `${file}：引入 newClientRequestId（键来自唯一真源，不手搓 uuid）`);
    ok(/const createReqIdRef = useRef\(''\)/.test(src), `${file}：createReqIdRef 存在（键存 ref，跨渲染不丢）`);
    ok(/useEffect\(\(\) => \{ if \(showCreate\) createReqIdRef\.current = newClientRequestId\(\); \}, \[showCreate\]\)/.test(src),
      `${file}：**一次表单会话生成一个键**（随弹窗开启生成；同一会话内重复提交共用它）`);
    ok(/if \((?:!task \|\| )?creating\) return;/.test(body), `${file}：handleCreate 入口在途判据（挡"看得见的连点"）`);
    ok(body.includes('setCreating(true)'), `${file}：进入即置在途（0→1 正面断言）`);
    ok(/finally \{ setCreating\(false\); \}/.test(body), `${file}：成功/失败都复位（不因一次失败把按钮永久锁死）`);
    ok(/const reqId = createReqIdRef\.current \|\| \(createReqIdRef\.current = newClientRequestId\(\)\)/.test(body),
      `${file}：兜底——弹窗未触发 effect 时也先取/生成键，再传下去（键永不为空）`);
    ok(new RegExp(`disabled=\\{!newTask\\.title \\|\\| creating\\}`).test(src),
      `${file}：按钮 disabled 含在途标志（在途期间点不动，UI 与主进程判据同向）`);
    ok(new RegExp(`\\{creating \\? '创建中…' : '${label}'\\}`).test(src), `${file}：在途文案「创建中…」/「${label}」（用户看得见"这一次已经在建"）`);
    // 键真的被传进 API 的**正确槽位**（否则去重键到不了主进程；传错位则是"参数不一致"的另一种形态）
    const callSrc = extractCall(body, /(?:tasksApi|tasks)\.create\(/);
    const args = splitTopLevelArgs(callSrc);
    eq(args.length, expectArgs[file], `${file}：创建调用实参 ${args.length} 个 = ipc 声明元数派生值（不多不少/${note}）`);
    eq(args[reqIdSlot]?.trim(), 'reqId', `${file}：**第 ${reqIdSlot + 1} 位实参 = reqId**（落在 clientRequestId 槽，不是塞错位/${note}）`);
    // 反证：把 reqId 实参抠掉 ⇒ 同槽位不再是 reqId（证明"键确实落在该槽"是被判出来的）
    ok(splitTopLevelArgs(callSrc.replace(/,\s*reqId(?=[,)])/, ''))[reqIdSlot] !== 'reqId',
      `${file}：反证——抠掉 reqId 实参后第 ${reqIdSlot + 1} 位不再是 reqId ⇒ 断言抓得住"键传错位/遗漏"`);

    // 反证：摘掉在途判据 ⇒ 同判据必判为"无在途保护"
    const noGuard = body.replace(/if \((?:!task \|\| )?creating\) return;/, '');
    ok(!/if \((?:!task \|\| )?creating\) return;/.test(noGuard), `反证：摘掉在途判据后同判据为否 ⇒ 判据抓得住"没有在途保护"`);
  }

  // ipc 层：参数声明 + 透传（少了任一处，键在 TS 层就被丢掉、根本到不了主进程）
  ok(/export function newClientRequestId\(\): string/.test(ipc), 'ipc 层导出 newClientRequestId（唯一真源，两处页面共用）');
  ok(/clientRequestId\?: string/.test(ipc), 'tasks.create 声明 clientRequestId?: string（不声明则实参被丢）');
  ok(/client_request_id: clientRequestId/.test(ipc), 'tasks.create 透传 client_request_id（renderer 驼峰 → 主进程蛇形，名对得上）');
  // 反证：把透传改成 undefined ⇒ 同判据为否
  ok(!/client_request_id: clientRequestId/.test(ipc.replace(/client_request_id: clientRequestId/, 'client_request_id: undefined')),
    '反证：透传被改成 undefined 后同判据为否 ⇒ 断言抓得住"参数在途中丢失"');
}

// ─────────────────────────────────────────────────────────────────────────────
// §S4 调用面穷举：renderer 内 task 创建调用点恰 2 处
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n【S4】调用面穷举——renderer 内 task 创建调用点恰 2 处（多一处即有人绕过键）');
{
  const R = path.join(root, A, 'renderer/src');
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : (/\.(ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : []));
  const hits = walk(R).map((f) => ({
    rel: path.relative(R, f).split(path.sep).join('/'),
    n: (stripComments(fs.readFileSync(f, 'utf-8')).match(/tasksApi?\.create\(|tasks\.create\(/g) || []).length,
  })).filter((h) => h.n > 0);
  eq(hits.map((h) => h.rel).sort(), ['pages/TaskDetailPage.tsx', 'pages/TasksPage.tsx'],
    `renderer 内 task 创建调用点恰 2 处（实测扫描面 ${walk(R).length} 个 .ts/.tsx）`);
  eq(hits.every((h) => h.n === 1), true, '每处文件内恰 1 个调用点（不存在"漏传键的第二个入口"）');
  // 反证：凭空多一处调用点必被抓住
  ok(JSON.stringify([...hits, { rel: 'pages/NewCreatePage.tsx', n: 1 }].map((x) => x.rel).sort())
    !== JSON.stringify(['pages/TaskDetailPage.tsx', 'pages/TasksPage.tsx']),
    '反证：多一处创建入口 ⇒ 断言为否 ⇒ 判据抓得住"新增入口未接键"');
}

// ── 轮级 build 闸（zx_20260914 M4 收口补齐；承"每个子脚本自带 build 闸"约定）──
console.log('\n[§S5 build 闸：P1–P6 与全量钉子同尺]');
checkBuildPins(ok, { distDir: path.join(root, `${A}/dist`) });

console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260914_1: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
