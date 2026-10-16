/**
 * zx_20260924_1 受控复跑 —— M1「帮写下的句式，机器要认」（批 M1，main 侧）。
 *
 * ── 病根（方案 §1.1 F1）──
 *   帮助文案（`im-router.ts` 的 `handleHelp`）是**手写**的一串示例；
 *   真正决定消息走哪条路的是另一处的四个正则 + 偏好正则 + `core/im/options.ts` 的审批词。
 *   **两份手抄必然漂移**，实测到的漂移：帮助写「记住：…」，而偏好谓词六条**一条都不认**它
 *   ⇒ 用户照帮助输入「记住：每周五出周报」，得到的是「已创建任务」（落进建任务路）。
 *
 * ── 本文件怎么证的（承 feedback「往返须在生产入参上证」「判据须用两只标本一起试」）──
 *   §B1.1 唯一真源：四条谓词**只在** `services/im-commands.ts` 定义，`im-router.ts` 里那份
 *         **已消失**（源码级，去注释后扫）；指令表里没有 `COMMAND_LIKE_REGEX` / 纯编号 / `im_commands`
 *         三样（它们不是内置指令，混进来会改变语义——见该模块头部注释）。
 *   §B1.2 帮助**派生**：真跑 `routeImMessage('帮助')`，逐条断言输出里含表里的**每一个 name 与 example**
 *         （手写数组做不到"改了表里一个字输出就跟着变"）。
 *   §B1.3 **反漂移核心**：拿帮助里的**示例原文**（`…` 占位那条用表里给的具体输入）喂**真路由器**，
 *         逐条断言**真的走到那条路**——最要紧的一条是「记住偏好」：`wa_memories` **0→1**，
 *         且 `wa_tasks` **一条都不许多**（此前正是"多了一条任务"）。
 *   §B1.4 **反向**（两只标本一起试）：帮助**没列**的串不得被误判成内置指令；`记住我偏好：用中文`
 *         仍归「记住偏好」而**不得**被「创建任务」认领。
 *
 * ⚠ 本文件不打开任何真库；`routeImMessage` 顶层无 electron 依赖，故**真 import 真跑**（非复刻）。
 * ⚠ 每个标本用一个**独立 fromUser**：风暴闸按用户计（窗 2s / 阈值 2，第 3 条判暴），
 *   单用户窗内恰 1 条 ⇒ 结构性不判暴，不必 sleep（夹具不许靠墙钟）。§B1.4 另加反证：回执不是风暴提示。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { routeImMessage, registerPendingApproval, STORM_NOTICE } from '../apps/worker-ant-desktop/src/main/services/im-router.js';
import { BUILTIN_IM_COMMANDS } from '../apps/worker-ant-desktop/src/main/services/im-commands.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) => ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RD = (p: string) => fs.readFileSync(path.join(root, p), 'utf-8');
type AnyDb = import('better-sqlite3').Database;

/** node:sqlite 无 better-sqlite3 的 `.transaction()`——补最小等价 shim（与其它 rr 同法）。 */
const withTx = (d: DatabaseSync) => { (d as unknown as { transaction: unknown }).transaction = (fn: () => void) => () => fn(); return d; };

/** 夹具 schema：**照抄 `database.ts` 的 DDL**（夹具比生产宽松即假绿）。 */
const SCHEMA = `
CREATE TABLE wa_projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', cron_schedule TEXT, working_dir TEXT DEFAULT '',
  context_json TEXT DEFAULT '{}', sandbox_mode TEXT DEFAULT 'workspace',
  owner_id TEXT, cron_timezone TEXT DEFAULT 'Asia/Shanghai',
  autonomous_mode TEXT DEFAULT 'off', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
  source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_task_conversations (
  id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL, content TEXT DEFAULT '',
  tool_calls TEXT, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_memories (
  id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL, embedding TEXT,
  memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5, reasoning TEXT DEFAULT '',
  source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '', valence TEXT DEFAULT 'neutral',
  context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0, exemplar_type TEXT, exemplar_context TEXT,
  updated_at TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_im_conversations (
  id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, project_id TEXT,
  message_json TEXT DEFAULT '{}', direction TEXT DEFAULT 'inbound',
  created_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'sent', last_error TEXT DEFAULT '', outbox_id TEXT DEFAULT ''
);
CREATE TABLE wa_jobs (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}', status TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3, scheduled_at TEXT, started_at TEXT,
  completed_at TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
`;
const mkDb = (): AnyDb => { const d = withTx(new DatabaseSync(':memory:')); d.exec(SCHEMA); return d as unknown as AnyDb; };

const CH = 'wechat-personal';
/** 建一个活跃项目（`ctxJson` 缺省 `{}`——与生产里 GUI 建的项目同形）。 */
function seedProject(db: AnyDb, id: string, name: string): void {
  db.prepare("INSERT INTO wa_projects (id, name, status) VALUES (?, ?, 'active')").run(id, name);
}
/** 建一条任务（默认 `completed`：不落 paused/failed 面，免得被 `handleAgentReply` 先吃掉）。 */
function seedTask(db: AnyDb, id: string, projectId: string, title: string, status = 'completed', ctx?: Record<string, unknown>): void {
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, ?, ?, ?, ?)')
    .run(id, projectId, title, status, JSON.stringify(ctx ?? {}));
}
const countOf = (db: AnyDb, sql: string, ...p: unknown[]): number => (db.prepare(sql).get(...p) as { c: number }).c;
const taskCount = (db: AnyDb): number => countOf(db, 'SELECT COUNT(*) c FROM wa_tasks');
const memCount = (db: AnyDb): number => countOf(db, 'SELECT COUNT(*) c FROM wa_memories');
const jobCount = (db: AnyDb): number => countOf(db, 'SELECT COUNT(*) c FROM wa_jobs');

/** 把一条消息接到**真 routeImMessage**上（生产入站链路），收集回话。 */
function send(db: AnyDb, from: string, text: string): { replies: string[]; run: () => Promise<void> } {
  const replies: string[] = [];
  const ctx = { db, channelId: 'ch-1', channelType: CH, sendReply: async (_to: string, t: string) => { replies.push(t); } };
  return { replies, run: () => routeImMessage(ctx as never, from, text, 'p2p', 'ctx-0', undefined) };
}

// ====== §B1.1 唯一真源 ======
function s1(): void {
  console.log('\n[B1.1 指令表是唯一真源（谓词只在 im-commands.ts，路由器不再自留一份）]');
  const routerSrc = stripKeepingLines(RD(`${A}/src/main/services/im-router.ts`)).join('\n');
  const cmdSrc = stripKeepingLines(RD(`${A}/src/main/services/im-commands.ts`)).join('\n');

  ok(!/\bconst\s+(START_REGEX|QUERY_REGEX|HELP_REGEX|CREATE_REGEX)\s*=/.test(routerSrc),
    'im-router.ts 里**不再定义**那四条路由谓词（去注释后扫；只剩 import 与用法）');
  ok(/from\s+'\.\/im-commands\.js'/.test(routerSrc), 'im-router.ts 从 im-commands.js **导入**它们');
  ok(/export const START_REGEX/.test(cmdSrc) && /export const HELP_REGEX/.test(cmdSrc),
    'im-commands.ts 是四条谓词的**唯一定义处**');
  ok(!/\['记住偏好', '「记住：…」'\]/.test(routerSrc),
    'handleHelp 里**不再有手写的内置指令数组**（文案改由表派生）');
  ok(/BUILTIN_IM_COMMANDS/.test(routerSrc), 'handleHelp 经 BUILTIN_IM_COMMANDS 派生');

  // 三样**刻意不在表内**（混进来会改语义）
  ok(!/COMMAND_LIKE_REGEX/.test(cmdSrc), '指令表模块里没有 COMMAND_LIKE_REGEX（"像命令"的过滤器不是一条指令）');
  ok(!/im_commands/.test(cmdSrc), '指令表模块里没有 im_commands（项目自配关键词是真源在项目里的动态资产）');
  ok(!/CONFIRM_RE|REJECT_RE/.test(cmdSrc), '审批词**不另抄一份**（从 core/im/options.ts 取）');
  ok(/matchApprovalReply/.test(cmdSrc), '审批回复那行的判据调的是 options.ts 的 matchApprovalReply');

  // zx_20261016_1 批三：新增「接入审批」一条（外部终端配对审批走 IM）——逐成员枚举**回填**，非放宽。
  eq(BUILTIN_IM_COMMANDS.map((c) => c.name), ['创建任务', '启动任务', '系统状态', '审批回复', '记住偏好', '接入审批'],
    '表内恰这六条、顺序即帮助里的展示顺序（纯编号选择/项目关键词不在内）');
}

// ====== §B1.2 帮助 = 表派生（真跑路由器） ======
async function s2(): Promise<void> {
  console.log('\n[B1.2 帮助输出逐条来自指令表（真 routeImMessage）]');
  const db = mkDb();
  seedProject(db, 'p1', '项目一');
  const { replies, run } = send(db, 'u_help', '帮助');
  await run();
  eq(replies.length, 1, '「帮助」被认领（恰好回一句）');
  const out = replies[0] ?? '';
  for (const cmd of BUILTIN_IM_COMMANDS) {
    ok(out.includes(`· ${cmd.name} — ${cmd.example}`), `帮助含「${cmd.name}」这一行（逐字取自表）`);
  }
  const bullets = out.split('\n').filter((l) => l.startsWith('· '));
  eq(bullets.length, BUILTIN_IM_COMMANDS.length, `内置动词行数 = 表长（${BUILTIN_IM_COMMANDS.length}）`);
  ok(out.includes('（暂无项目配置命令关键词）'), '第二段（项目自配关键词）行为未变：无配置时如实说"暂无"');
  ok(!out.includes(STORM_NOTICE), '反证：这句回执不是风暴提示（风暴闸未拦）');
  eq(taskCount(db), 0, '反证：「帮助」不建任务');
}

// ====== §B1.3 反漂移核心：照帮助输入真能成 ======
const firstQuote = (s: string): string => /「([^」]*)」/.exec(s)?.[1] ?? '';

async function s3(): Promise<void> {
  console.log('\n[B1.3 帮助里的每一条示例，喂真路由器必须真的走到那条路]');
  const db = mkDb();
  seedProject(db, 'p1', '项目一');

  // ① 示例原文 ↔ 受测输入同源（`…` 占位的那条只能是表里给的具体输入）
  const inputs = new Map<string, string>();
  for (const cmd of BUILTIN_IM_COMMANDS) {
    const q = firstQuote(cmd.example);
    if (q.includes('…')) {
      const prefix = q.split('…')[0]!;
      ok(cmd.probe.startsWith(prefix), `${cmd.name}: 具体输入以示例的前缀开头（「${prefix}」）`, cmd.probe);
    } else {
      eq(q, cmd.probe, `${cmd.name}: 受测输入**恰是**帮助示例里的原文`);
    }
    inputs.set(cmd.name, cmd.probe);
    ok(cmd.match(cmd.probe), `${cmd.name}: 表里的谓词认下自己的示例（谓词与文案同源）`);
  }
  ok(!inputs.get('记住偏好')!.includes('…'), '「记住偏好」的受测输入是**真话**（不是省略号占位）');

  // ② 「记住偏好」——F1 的靶心：照帮助输入，落的是记忆，**不是任务**
  {
    // zx_20260924_1 J-5：`记住：…` 此前一条谓词都不认 ⇒ 现在必须认
    const memBefore = memCount(db); const taskBefore = taskCount(db);
    const { replies, run } = send(db, 'u_remember', inputs.get('记住偏好')!);
    await run();
    eq(memCount(db) - memBefore, 1, 'wa_memories 0→1（正面断言：真落了一条记忆，不只是"不抛"）');
    eq(taskCount(db) - taskBefore, 0, 'wa_tasks **一条都不许多**（此前正是"照帮助输入被建成任务"）');
    const row = db.prepare("SELECT memory_type, source, content FROM wa_memories ORDER BY rowid DESC LIMIT 1").get() as { memory_type: string; source: string; content: string };
    eq([row.memory_type, row.source], ['semantic', 'user_instruction'], '落库形状：memory_type=semantic / source=user_instruction');
    eq(row.content, '每周五出周报', '记住的内容 = 冒号后的正文');
    ok(replies[0]!.includes('已记住你的偏好：每周五出周报'), '回执如实报"记住了什么"', replies[0]!.slice(0, 40));
  }

  // ③ 「创建任务」——照示例输入，真的落任务
  {
    const before = taskCount(db);
    const { replies, run } = send(db, 'u_create', inputs.get('创建任务')!);
    await run();
    eq(taskCount(db) - before, 1, 'wa_tasks 0→1（建任务路被认领）');
    ok(/已创建任务「/.test(replies[0] ?? ''), '回执是建任务回执', (replies[0] ?? '').slice(0, 30));
    eq(memCount(db), 1, '反证：这条**没有**落成偏好（两条路互斥）');
  }

  // ④ 「启动任务」——照示例输入，走的是启动路（不建任务）
  {
    const before = taskCount(db);
    const { replies, run } = send(db, 'u_start', inputs.get('启动任务')!);
    await run();
    eq(taskCount(db) - before, 0, '启动路不建任务');
    ok(/可启动的任务|已启动任务|已自动启动/.test(replies[0] ?? ''), '回执是启动回执', (replies[0] ?? '').slice(0, 30));
  }

  // ⑤ 「系统状态」——照示例输入，回的是系统状态（不建任务）
  {
    const before = taskCount(db);
    const { replies, run } = send(db, 'u_status', inputs.get('系统状态')!);
    await run();
    eq(taskCount(db) - before, 0, '状态查询不建任务');
    ok((replies[0] ?? '').startsWith('📊 工蚁系统状态'), '回执是系统状态卡', (replies[0] ?? '').split('\n')[0]);
  }

  // ⑥ 「审批回复」——**前提**：本渠道本用户确有悬置的待审批项（否则一句「是」会落到问候/兜底）
  {
    const u = 'u_approve';
    const t = 't-approve-1';
    seedTask(db, t, 'p1', '待审批的活儿', 'paused', { source: 'im', channel: CH, externalUser: u });
    registerPendingApproval(CH, u, { taskId: t, projectId: 'p1', question: '是否继续？', createdAt: Date.now() });
    const convBefore = countOf(db, 'SELECT COUNT(*) c FROM wa_task_conversations WHERE task_id = ?', t);
    const jobBefore = jobCount(db);
    const { replies, run } = send(db, u, inputs.get('审批回复')!);
    await run();
    eq(replies, [`✅ 已确认，任务「待审批的活儿」继续执行。`], '回执是审批确认（走的是审批路，不是自由回复）');
    eq((db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(t) as { status: string }).status, 'pending',
      '任务状态 paused → pending（0→1 式的正面断言：真去恢复了）');
    eq(countOf(db, 'SELECT COUNT(*) c FROM wa_task_conversations WHERE task_id = ?', t) - convBefore, 1,
      '对话行 0→1（[用户确认执行] 落了账）');
    eq(jobCount(db) - jobBefore, 1, '作业 0→1（恢复真的入了队）');
  }
}

// ====== §B1.4 反向：不该命中的 / 不得被误认的 ======
async function s4(): Promise<void> {
  console.log('\n[B1.4 反向标本（两只一起试）]');

  // ① 帮助**没列**的串不得被误判成内置指令
  //   '天气不错'（4 字）：不触发步骤1.5 的 LLM 分类（`length > 4` 才走），故本次回归**零网络**。
  for (const s of ['天气不错', '3', '请']) {
    eq(BUILTIN_IM_COMMANDS.filter((c) => c.match(s)).map((c) => c.name), [], `「${s}」不被表里任何一条认领`);
  }
  const db1 = mkDb();
  seedProject(db1, 'p1', '项目一');
  {
    const before = taskCount(db1); const memBefore = memCount(db1);
    const { replies, run } = send(db1, 'u_plain', '天气不错');
    await run();
    eq([taskCount(db1) - before, memCount(db1) - memBefore], [0, 0], '普通句：既不建任务也不落记忆（落到兜底回话）');
    ok((replies[0] ?? '').includes('如需帮助'), '普通句落到兜底回话（未被任何内置指令认领）', (replies[0] ?? '').slice(0, 30));
    ok(!replies.includes(STORM_NOTICE), '反证：兜底回话不是风暴提示');
  }

  // ② `记住我偏好：X` 仍归「记住偏好」，**不得**被「创建任务」认领
  {
    const db = mkDb();
    seedProject(db, 'p1', '项目一');
    const create = BUILTIN_IM_COMMANDS.find((c) => c.name === '创建任务')!;
    ok(!create.match('记住我偏好：用中文'), '反证：「记住我偏好：用中文」不被「创建任务」认领（谓词不重叠）');
    const before = taskCount(db); const memBefore = memCount(db);
    const { replies, run } = send(db, 'u_pref6', '记住我偏好：用中文');
    await run();
    eq(memCount(db) - memBefore, 1, '既有六条谓词仍生效：记忆 0→1');
    eq(taskCount(db) - before, 0, '且**没有**落成任务');
    ok(replies[0]!.includes('用中文'), '回执内容 = 偏好正文', replies[0]!.slice(0, 30));
  }
}

async function main(): Promise<void> {
  s1();
  await s2();
  await s3();
  await s4();
  console.log('\n[B1.5 轮级 build 钉子（P1–P6 派生一致性）]');
  checkBuildPins(ok, { distDir: path.join(root, `${A}/dist`) });
  console.log(`\n结果: pass=${pass} fail=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
