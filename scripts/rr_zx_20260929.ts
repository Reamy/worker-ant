/**
 * zx_20260929 受控复跑 —— 「在手，不等于上手」：装载了的，要真的走到。
 *
 * 本轮口径（方案 §0/§1）：**一个机制「在册」（源码里有这个名字）≠ 它「在路」（执行路径上真走到这一跳）**。
 * 不新增能力、不新增目录、不新造写点——只把已经在册却到不了的东西接上路。
 *
 * 分组（方案 §3）：
 *   A · M1 技能：记账按**作用域**（换 workingDir 必重扫）· ANS 同步**失败不置位且可重试** · `executable` 如实
 *   B · M2 MCP/A2A 接线
 *   C · M3 围栏上路 + 有界读盘
 *   D · M4 记忆惩罚因子逐路对齐 / 账记实际 / 时区同尺
 *   E · M5 调度门认当下的子 / 悬空子得救 / 并发归一处
 *   F · M6 模型换完再回验 / 词表收敛
 *   G · M7 GUI 第二落点（`versionSizeText` 两渲染点 / 词表一处定义 / 三个计数标签互不重复）
 *   H · M8 IM 说的与做的一致（截断**要说** / 「条件缺失」唯一判尺与构造点 / `blocked_quota` 与 `failed` 同表）
 *   J · M9 重构抽段：**接回执行体**（在册→在路）· `StepScope` 是活访问器非值快照 · 剥离前提全落一处
 *   I · 哑雷专项 + build 钉
 *
 * §判据纪律（逐条对上本仓 auto-memory）：
 *   G-1 **用生产函数、不自造等价实现**：本文件只调生产导出（`buildTools` / `loadAgentSkills` /
 *       `syncSkillsFromAnsOnce` / `listSkills` / `executeSkill` / `skillLoadState` …）。
 *       自造一份等价实现再拿它自证，证的是"生产没走的那条路"（本仓已复发两次）。
 *   G-2 **每条判据都能被合法数据满足**，且**有区分度**：正反两侧各给一只真标本。
 *   G-3 **计数器用"0→1"正面断言**，不用"不抛"代替（被 `catch {}` 吞掉的写入只有正面断言抓得住）。
 *   G-4 **不依赖真实墙钟**：需要"时间过去了"时走生产**时钟接缝**（`syncSkillsFromAnsOnce(…, { now })`），
 *       不 sleep、不比真实时刻。
 *   G-5 静态判据一律读**原文**（不去注释）——去注释在本仓是**静默毁伤**（zx_20260928 教训：
 *       `stripComments` 把 engineSrc 从 47.5 万削到 33.5 万字符且**无任何报错**）。锚点钉**符号/语句形状**。
 *   G-6 **无轮次字面量**：不改 `build`；轮次相关定位一律由 `path.basename(__filename)` 派生（§I）。
 *   G-7 夹具 schema 逐列照抄 `database.ts` DDL（既不缺列也不放宽 NOT NULL），且**先 `new` 服务类再插行**
 *       （见 `feedback_rr_fixture_production_order`）。
 *
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins } from './lib/rr-pins.js';
import { engineSrc, engineSrcFiles, engineExecSideFiles, stripStepScopePrefix } from './lib/rr-engine-src.js';
import { buildTools } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { reconcileStalledSubtasks } from '../apps/worker-ant-desktop/src/main/core/self-healing-monitor.js';
import { selectModelForTask } from '../apps/worker-ant-desktop/src/main/core/exec-model-select.js';
import { MODEL_NAME_CAPABILITY_HINTS, MODEL_CAPABILITY_META, PROVIDER_CAPABILITY_HINTS } from '../packages/shared-types/src/models.js';
// H · M8：长度尺 / 失败分因 / 状态词表 —— 一律调**生产导出**（G-1：不自造等价实现）
import { clipWithNotice, IM_SEND_TEXT_LIMIT, IM_ROUTER_OUTPUT_LIMIT, TRUNCATION_MARKER } from '../apps/worker-ant-desktop/src/main/core/im/im-text.js';
import {
  conditionMissing, credentialFailure, looksLikeQuotaHint,
  isImQuotaError, ImQuotaError, ImSendError,
} from '../apps/worker-ant-desktop/src/main/core/im/im-errors.js';
import { accountOutboundFailure } from '../apps/worker-ant-desktop/src/main/core/im/reply-accounting.js';
// H · M8-c：渲染侧送达态**真实现**（纯函数 ⇒ rr 直跑，不照抄 if-else）
import { convDeliveryOf } from '../apps/worker-ant-desktop/renderer/src/lib/convDelivery.js';
import { MEM_LIVE_SQL } from '../apps/worker-ant-desktop/src/main/core/memory-lifecycle.js';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string): void =>
  ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const RD = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');
type AnyDb = import('better-sqlite3').Database;

// ── 夹具 schema：按 database.ts DDL 摘取本文件用到的列（NOT NULL 照抄） ──
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', working_dir TEXT DEFAULT '', context_json TEXT DEFAULT '{}',
  sandbox_mode TEXT DEFAULT 'workspace', cron_timezone TEXT DEFAULT 'Asia/Shanghai',
  autonomous_mode TEXT DEFAULT 'off', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, parent_task_id TEXT DEFAULT '',
  title TEXT NOT NULL, description TEXT DEFAULT '', status TEXT DEFAULT 'pending',
  priority INTEGER DEFAULT 0, context_json TEXT DEFAULT '{}', depends_on TEXT DEFAULT '',
  source TEXT DEFAULT 'test', acceptance_criteria TEXT DEFAULT '', quality_score REAL,
  aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL,
  embedding TEXT, memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5,
  reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '',
  valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0,
  exemplar_type TEXT, exemplar_context TEXT, use_count INTEGER DEFAULT 0, last_used_at TEXT,
  similar_to TEXT DEFAULT '', last_reinforced_at TEXT, success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', tool_calls TEXT, token_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_approvals (project_id TEXT, kind TEXT, command_fingerprint TEXT);
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT,
  type TEXT NOT NULL, name TEXT DEFAULT '', description TEXT DEFAULT '',
  file_path TEXT, registry_id TEXT, status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending', retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
  scheduled_at TEXT, started_at TEXT, completed_at TEXT, error TEXT,
  created_at TEXT DEFAULT (datetime('now')));
`;
/** `wa_settings.ans_server_url` 默认指向必然连不上的端口：技能同步"外呼必失败且结果确定"（不依赖真 ANS）。
 *  `ansUrl` 参数供 B 组把 ANS 地址指向**本地桩** —— "端点取自配置"这条只有在配置真的换了值时才验得出来。 */
const mkdb = (ansUrl = 'http://127.0.0.1:1'): AnyDb => {
  const d = new DatabaseSync(':memory:') as unknown as AnyDb;
  d.exec(SCHEMA);
  d.prepare("INSERT INTO wa_projects (id, name) VALUES ('p1', 'rr29')").run();
  d.prepare("INSERT INTO wa_settings (key, value) VALUES ('ans_server_url', ?)").run(ansUrl);
  d.prepare("INSERT INTO wa_settings (key, value) VALUES ('ans_api_key', 'rr29-key')").run();
  return d;
};

/** 临时项目目录，内含项目级 `.agents/skills/<name>/SKILL.md`（走生产 `loadAgentSkills` 真扫描）。 */
const mkWorkdir = (skillName: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr29-wd-'));
  const sd = path.join(dir, '.agents', 'skills', skillName);
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: 夹具技能 ${skillName}\n---\n\n夹具指令体\n`, 'utf-8');
  return dir;
};

/** 本地 ANS 桩：只有真起一个 HTTP 服务，才能验"成功才置位"的**成功侧**（`fetch` 是生产路径）。 */
function startAnsStub(skills: Array<{ name: string; description?: string; status?: string }>): Promise<{ url: string; close: () => Promise<void>; requests: () => number; headers: () => Record<string, string> }> {
  let n = 0;
  let last: Record<string, string> = {};
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      n++;
      // zx_20260930 M9: 记下**真发到线上的头**——"收敛到签名出路"只有线上那三个头说得清
      //   （读源码只能证"引了助手"，读线上才证"真的签了"）。
      last = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v ?? '')]));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: skills }));
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
        requests: () => n,
        headers: () => last,
      });
    });
  });
}

/** MCP 桩的 `tools/list` 成功响应体。 */
const mcpListOk = (tools: string[]): unknown => ({
  result: {
    tools: tools.map((t) => ({ name: t, description: `${t} 说明`, inputSchema: { properties: { q: { type: 'string' } } } })),
    serverInfo: { name: 'rr29-stub', version: '0.0.1' },
  },
});

/** 可编程 MCP 桩：记录 **JSON-RPC 请求序列**（`list` / `call:<工具名>`），响应由 `respond` 按序给出。
 *  「刷新了没有、重试了几次」只有序列说得清 ⇒ 序列是本组的核心取证（也是唯一的反循环证据）。
 *  非 JSON-RPC 的请求（如技能同步外呼可能打同一地址）回空体且**不计入序列**，以免污染取证。 */
function startMcpStub(respond: (req: { method: string; name?: string }, seq: number) => unknown): Promise<{ url: string; seq: string[]; close: () => Promise<void> }> {
  const seq: string[] = [];
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        let rpc: { method?: string; params?: { name?: string } } = {};
        try { rpc = JSON.parse(body) as typeof rpc; } catch { /* 非 JSON 请求：回空体 */ }
        const method = rpc.method || '';
        const isRpc = method === 'tools/list' || method === 'tools/call';
        if (isRpc) seq.push(method === 'tools/call' ? `call:${rpc.params?.name}` : 'list');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(isRpc ? respond({ method, name: rpc.params?.name }, seq.length) : {}));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, seq, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

/** 把某个桩的地址包成池要的**按调用**端点解析器。 */
const resolverOf = (url: string) =>
  async (serverName: string): Promise<{ name: string; endpoint: string }> => ({ name: serverName, endpoint: url });

/** MCP 连接池的导出面（只列本组用到的）。 */
type PoolMod = {
  listMcpTools: (serverName: string, opts?: { endpointResolver?: (s: string) => Promise<{ name: string; endpoint: string }> }) =>
    Promise<{ name: string; endpoint: string; tools: Array<{ name: string; description: string; params: string[] }>; serverInfo: Record<string, unknown>; failures: number }>;
  callMcpTool: (serverName: string, toolName: string, args: Record<string, unknown>, opts?: { endpointResolver?: (s: string) => Promise<{ name: string; endpoint: string }> }) => Promise<unknown>;
  refreshMcpTools: (serverName: string, opts?: { endpointResolver?: (s: string) => Promise<{ name: string; endpoint: string }> }) => Promise<void>;
};

// ══════════════════════════════════════════════════════════════════
// 【A】M1 技能：记账按作用域 · 失败不置位且可重试 · executable 如实
// ══════════════════════════════════════════════════════════════════
async function groupA(): Promise<void> {
  console.log('\n【A】M1 技能加载：记账按「作用域」而非「进程」');
  const sk = await import(
    path.join(root, A, 'src/main/core/skill-registry.js')
  ) as unknown as {
    loadAgentSkills: (dir?: string) => number;
    listSkills: () => Array<{ name: string; description: string; category: string; executable: boolean }>;
    executeSkill: (name: string, input: string, ctx?: Record<string, unknown>) => Promise<string>;
    syncSkillsFromAns: (creds: { baseUrl: string; apiKey: string; secretKey: string }, opts?: { retries?: number }) => Promise<number>;
    syncSkillsFromAnsOnce: (creds: { baseUrl: string; apiKey: string; secretKey: string }, opts?: { now?: number }) => Promise<boolean>;
    skillLoadState: () => { agentSkillDirs: string[]; ansSynced: boolean; ansAttempts: number; ansLastError: string | null };
  };

  // ── A-1 同目录**不重扫**（幂等）：真调 `loadAgentSkills` ──
  const dirX = mkWorkdir('A夹具甲');
  const first = sk.loadAgentSkills(dirX);
  ok(first >= 1, 'A-1 `loadAgentSkills(dirX)` 首次**确实加载了**项目级技能（0→N 正面断言）', `loaded=${first}`);
  eq(sk.loadAgentSkills(dirX), 0, 'A-2 同一 `workingDir` 第二次调用返回 0（幂等：同目录不重扫）');

  // ── A-3 ★换目录**必扫**（真跑 buildTools；病根正是"进程级布尔 ⇒ 第二个项目永远轮不上"） ──
  //   夹具照生产路径：`buildTools(ctx, taskId, projectId, workingDir)` → 工具内 `ensureSkillsLoaded()`。
  const dirY = mkWorkdir('A夹具乙');
  const namesOf = async (wd: string): Promise<string[]> => {
    const tools = buildTools({ db: mkdb() } as never, 't1', 'p1', wd) as unknown as {
      list_skills: { execute: (a: unknown) => Promise<string> };
    };
    return (JSON.parse(await tools.list_skills.execute({})) as Array<{ name: string }>).map((s) => s.name);
  };
  const beforeY = await namesOf(dirX);
  ok(beforeY.includes('A夹具甲'), 'A-3 前提：首个 `workingDir`(X) 的技能进了清单', `${beforeY.length} 条`);
  ok(!beforeY.includes('A夹具乙'), 'A-4 前提：Y 的技能此刻**还不在**清单里（否则下面的"换目录才进来"无从判起）');
  const afterY = await namesOf(dirY);
  ok(afterY.includes('A夹具乙'),
    'A-5 ★换 `workingDir` 后第二个项目的 `.agents/skills` **确实进了清单**（进程级布尔下此处为假：永不重扫）');

  // ── A-6 反证：不是"整表都被扫进来了" —— X 与 Y 互不为对方的证据 ──
  const st = sk.skillLoadState();
  ok(st.agentSkillDirs.includes(dirX) && st.agentSkillDirs.includes(dirY),
    'A-6 记账里**同时**记着两个目录（按作用域记账，非一枚进程级布尔）', JSON.stringify(st.agentSkillDirs.map((d) => path.basename(d))));

  // ── A-7/A-8 ANS 同步**失败不置位**且**可重试**（计数器 0→1 正面断言；退避走时钟接缝，不 sleep） ──
  //   上面 `namesOf` 已触发过真实同步尝试（必失败，因 `ans_server_url` 指向 127.0.0.1:1）⇒ 计数基线
  //   必须在**此处**取、且三次调用的 `now` 一律由接缝注入（否则会被上一次留下的退避窗口挡住，"重试"证不出来）。
  const n0 = sk.skillLoadState().ansAttempts;
  const base = Date.now() + 10_000_000; // 远晚于此前任何一次失败留下的退避截止
  const bad = await sk.syncSkillsFromAnsOnce({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', secretKey: 's' }, { now: base });
  const s1 = sk.skillLoadState();
  eq(bad, false, 'A-7 ★ANS 不可达时 `syncSkillsFromAnsOnce` 返回 **false**（此前失败也置位 ⇒ 本进程永不重试）');
  eq([s1.ansSynced, s1.ansAttempts - n0], [false, 1], 'A-8 ★失败后 `ansSynced===false` 且尝试计数 **0→1**（记账没被当成"已完成"）');
  ok(!!s1.ansLastError && /失败/.test(s1.ansLastError), 'A-9 失败**留痕**（`ansLastError` 非空）——"没同步上"与"本来没技能"据此刻得开');

  // 退避窗口内不重试（防 ANS 挂着时每一步都打满 5s 超时）
  const within = await sk.syncSkillsFromAnsOnce({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', secretKey: 's' }, { now: base + 1 });
  eq([within, sk.skillLoadState().ansAttempts - n0], [false, 1], 'A-10 退避窗口内**不再发外呼**（attempts 不变：不拿 5s 超时砸每一步）');
  // 窗口过后**确实重试**——用生产时钟接缝注入"已过退避"的时刻，不依赖真实墙钟
  const after = await sk.syncSkillsFromAnsOnce({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', secretKey: 's' }, { now: base + 31_000 });
  eq([after, sk.skillLoadState().ansAttempts - n0], [false, 2], 'A-11 ★退避窗口过后**确实重试**（attempts 1→2：失败不再是"永久性"的）');

  // ── A-12 成功侧：真起本地 ANS 桩，走生产 `fetch` 路径 —— 成功了才置位 ──
  const stub = await startAnsStub([{ name: 'A夹具ANS技能', description: '来自 ANS 的插件技能' }]);
  const okSync = await sk.syncSkillsFromAnsOnce({ baseUrl: stub.url, apiKey: 'k', secretKey: 's' }, { now: base + 62_000 });
  eq([okSync, sk.skillLoadState().ansSynced], [true, true], 'A-12 ★同步**成功**才置位真（`ansSynced===true`）；失败侧与成功侧结论相反 ⇒ 判据有区分度');
  ok(stub.requests() >= 1, 'A-13 生产 `fetch` 真打到了桩（不是"没外呼也算成功"）', `${stub.requests()} 次请求`);
  // zx_20260930 M9（**就地订正为更强真源**：原来只数"打过桩"，不问"带没带身份"）：
  //   同步路此前只发 `x-api-key`，而 ANS 的 `/api/v1/*` 要**三头齐备** ⇒ 真机恒 401。
  //   判据读**线上真收到的头**（不是读源码里有没有 `ansSignedRequest` 这个词）。
  {
    const h = stub.headers();
    ok(!!h['x-api-key'] && !!h['x-timestamp'] && !!h['x-signature'],
      'A-13b ★同步请求三头齐备（x-api-key + x-timestamp + x-signature）——ANS 的 hmacAuth 就按这三个头取身份',
      JSON.stringify({ key: h['x-api-key'], ts: h['x-timestamp'], sig: (h['x-signature'] || '').slice(0, 8) }));
  }

  // ── A-14 `executable` 如实：有执行体 / 无执行体 两侧各一只 ──
  const list = sk.listSkills();
  const builtin = list.find((s) => s.name === 'code_review');
  const ansSkill = list.find((s) => s.name === 'A夹具ANS技能');
  const promptSkill = list.find((s) => s.name === 'A夹具甲');
  ok(!!builtin && builtin.executable === true, 'A-14 内置 `code_review` 标 `executable:true`（真能跑）');
  ok(!!promptSkill && promptSkill.category === 'agent' && promptSkill.executable === true,
    'A-15 `.agents` 提示词型标 `category:"agent"` / `executable:true`（返回指令供参考，确有内容）');
  ok(!!ansSkill && ansSkill.category === 'ans' && ansSkill.executable === false,
    'A-16 ★ANS 插件技能标 `executable:false`（只有名字+说明，本进程无执行体——名实相符）');

  // ── A-17/A-18 不可执行者的回话**如实**（说清来源与"仅供检索"） ──
  const reply = JSON.parse(await sk.executeSkill('A夹具ANS技能', '')) as { error?: string; category?: string; executable?: boolean };
  ok(/ANS/.test(reply.error || '') && /无本地执行体/.test(reply.error || ''),
    'A-17 ★`skill("A夹具ANS技能")` 的回话说明它**来自 ANS**、本进程无执行体（旧话一律"无执行体"，看不出是个 ANS 技能）', reply.error);
  eq([reply.category, reply.executable], ['ans', false], 'A-18 回话带结构化 `category`/`executable`，不是只给一句自然语言');
  const pReply = JSON.parse(await sk.executeSkill('A夹具甲', '')) as { type?: string };
  eq(pReply.type, 'prompt', 'A-19 反证：`.agents` 提示词型走的是**另一个**分支（`type:"prompt"`）——上一条不是"所有技能都这么回"');

  // ── A-20 生产源码：两枚进程级布尔的**赋值**已消失，代之以 Once 出口 ──
  const ae = engineSrc();
  eq((ae.match(/_agentSkillsLoaded\s*=[^=]/g) || []).length, 0,
    'A-20 ★`agent-executor` 里 `_agentSkillsLoaded` 的**赋值**为 0 处（进程级记账已整体移出执行体）');
  eq((ae.match(/_ansSkillsSynced\s*=[^=]/g) || []).length, 0, 'A-21 同理 `_ansSkillsSynced` 赋值为 0 处');
  ok(/loadAgentSkills\(workingDir\)/.test(ae) && /syncSkillsFromAnsOnce\(/.test(ae),
    'A-22 代之以生产出口：`ensureSkillsLoaded` 仍调 `loadAgentSkills(workingDir)` + 改调 `syncSkillsFromAnsOnce`');

  await stub.close();
  try { fs.rmSync(dirX, { recursive: true, force: true }); fs.rmSync(dirY, { recursive: true, force: true }); }
  catch { /* 临时目录清理失败不影响断言 */ }
}

// ══════════════════════════════════════════════════════════════════
// 【B】M2 MCP/A2A：「在册」要变成「在路」
//   病根形状（与 A 组同族）：**写头有、读头无**——`refreshMcpTools` 无人调用；
//   端点解析器是进程级全局（并发任务互相覆盖）；A2A 分支 early-return 跳过注册；
//   `listA2AServers` 没有 renderer 读点；`serverInfo`/`failures` 只写不读。
// ══════════════════════════════════════════════════════════════════
async function groupB(): Promise<void> {
  console.log('\n【B】M2 MCP/A2A 接线：装载的，要真的走到');
  const pool = await import(path.join(root, A, 'src/main/core/mcp-client-pool.js')) as unknown as PoolMod;
  const stubs: Array<{ close: () => Promise<void> }> = [];
  const tmpDirs: string[] = [];

  // ── B-1/B-2 ★「工具不在册」⇒ 刷新一次 + 重试一次（`refreshMcpTools` 存在的理由即此） ──
  let firstCall = true;
  const s1 = await startMcpStub((req) => {
    if (req.method === 'tools/list') return mcpListOk(['B']);
    if (firstCall) { firstCall = false; return { error: { code: -32601, message: 'Method not found' } }; }
    return { result: { content: [{ type: 'text', text: 'RR29-OK' }] } };
  });
  stubs.push(s1);
  const r1 = await pool.callMcpTool('rr29-svc-1', 'B', {}, { endpointResolver: resolverOf(s1.url) }) as { content?: Array<{ text?: string }> };
  eq(r1.content?.[0]?.text, 'RR29-OK',
    'B-1 ★「工具不在册」之后**重试拿到了真结果**（此前该错误一次即抛：TTL 缓存的失效点没人踩）');
  eq(s1.seq, ['list', 'call:B', 'list', 'call:B'],
    'B-2 ★请求序列恰为「列 → 调 → **刷新列** → 再调」：刷新恰好一次、重试恰好一次（既不空转也不循环）');

  // ── B-3/B-4 区分度：**非**「工具不在册」类错误必须原样抛出、不刷新 ──
  const s2 = await startMcpStub((req) => req.method === 'tools/list'
    ? mcpListOk(['C'])
    : { error: { code: -32603, message: 'Internal error' } });
  stubs.push(s2);
  let thrown2 = '';
  try { await pool.callMcpTool('rr29-svc-2', 'C', {}, { endpointResolver: resolverOf(s2.url) }); }
  catch (e) { thrown2 = (e as Error).message; }
  eq(thrown2, 'Internal error', 'B-3 ★服务端内部错误**原样抛出**（-32603 不该被当成"工具没了"再试一遍）');
  eq(s2.seq, ['list', 'call:C'], 'B-4 ★区分度：这类错误**不触发刷新**（序列仅两条）——上一条不是"凡错必刷新"');

  // ── B-5/B-6 重试**只有一次**：刷新后仍是「工具不在册」⇒ 如实抛出 ──
  const s3 = await startMcpStub((req) => req.method === 'tools/list'
    ? mcpListOk(['D'])
    : { error: { code: -32601, message: 'Method not found' } });
  stubs.push(s3);
  let thrown3 = '';
  try { await pool.callMcpTool('rr29-svc-3', 'D', {}, { endpointResolver: resolverOf(s3.url) }); }
  catch (e) { thrown3 = (e as Error).message; }
  ok(/not found/i.test(thrown3), 'B-5 刷新后仍「工具不在册」⇒ **如实抛出**（不吞成空结果）', thrown3);
  eq(s3.seq, ['list', 'call:D', 'list', 'call:D'], 'B-6 ★且重试**仍只有一次**（序列恰四条）：不是无限重试');

  // ── B-7..B-9 ★★端点按调用传参（真正的修复在「复合键」上） ──
  const sA = await startMcpStub(() => mcpListOk(['A']));
  const sB = await startMcpStub((req) => req.method === 'tools/list'
    ? mcpListOk(['A'])
    : { result: { content: [{ type: 'text', text: 'from-B' }] } });
  stubs.push(sA, sB);
  await pool.listMcpTools('rr29-svc-shared', { endpointResolver: resolverOf(sA.url) });
  const cross = await pool.callMcpTool('rr29-svc-shared', 'A', {}, { endpointResolver: resolverOf(sB.url) }) as { content?: Array<{ text?: string }> };
  eq(sA.seq, ['list'], 'B-7 第一次调用只打到桩 A（未外溢到别处）');
  eq(sB.seq, ['list', 'call:A'],
    'B-8 ★★**同名服务**的第二次调用打到桩 B：池按 (服务名, 端点)**复合键**缓存——只按服务名缓存时，此处会复用 A 的连接、B 一个请求都收不到');
  eq(cross.content?.[0]?.text, 'from-B', 'B-9 ★返回值确实来自 B（不是"两边都发了、取到谁算谁"）');

  await pool.refreshMcpTools('rr29-svc-shared', { endpointResolver: resolverOf(sA.url) });
  eq(sA.seq, ['list', 'list'],
    'B-10 `refreshMcpTools` 当场可调且行为如契约（断开后**重新拉取**一次工具列表）；它在**生产路径上**被调用由 B-2 的序列作证');

  // ── B-11..B-13 池的 `serverInfo`/`failures` 要有真读点（含「0→1」正面断言） ──
  const infoShared = await pool.listMcpTools('rr29-svc-shared', { endpointResolver: resolverOf(sA.url) });
  eq(infoShared.serverInfo, { name: 'rr29-stub', version: '0.0.1' },
    'B-11 ★池里的 `serverInfo` 有真读点：`listMcpTools` 把它交回调用方（此前只写不读）');
  eq([infoShared.tools.length, infoShared.tools[0]?.params], [1, ['q']],
    'B-12 `listMcpTools` 交回的工具清单带 `params`（`find_mcp_service` 的 `tools` 字段即由此来）');
  const infoC = await pool.listMcpTools('rr29-svc-2', { endpointResolver: resolverOf(s2.url) });
  eq([infoC.failures, infoShared.failures], [1, 0],
    'B-13 ★`failures` 有「0→1」的正面证据：C 上真失败过一次 ⇒ 1；从未失败的共享服务 ⇒ 0');

  // ── B-14..B-16 ★端到端（正）：走生产 `find_mcp_service` / `call_mcp_tool` ──
  //   这两个工具就是"在路"本身；端点取 `wa_settings.ans_server_url`，故夹具把它指向本地桩。
  const sE2E = await startMcpStub((req) => req.method === 'tools/list'
    ? mcpListOk(['E'])
    : { result: { content: [{ type: 'text', text: 'RR29-E2E' }] } });
  stubs.push(sE2E);
  const dbE2E = mkdb(sE2E.url);
  dbE2E.prepare("INSERT INTO wa_deliverables (id, project_id, type, name, status, file_path) VALUES ('d1','p1','mcp','rr29-mcp-e2e','running','/tmp/x/server.js')").run();
  const wdE2E = mkWorkdir('B夹具可达'); tmpDirs.push(wdE2E);
  const toolsE2E = buildTools({ db: dbE2E } as never, 't1', 'p1', wdE2E) as unknown as {
    find_mcp_service: { execute: (a: unknown) => Promise<string> };
    call_mcp_tool: { execute: (a: unknown) => Promise<string> };
  };
  const found = JSON.parse(await toolsE2E.find_mcp_service.execute({})) as {
    services: Array<{ name: string; toolCount?: number; tools?: string[]; toolsUnknown?: boolean; failures?: number; serverInfo?: Record<string, unknown> }>;
  };
  const it0 = found.services.find((s) => s.name === 'rr29-mcp-e2e');
  eq([it0?.toolCount, it0?.tools?.[0], it0?.toolsUnknown], [1, 'E', undefined],
    'B-14 ★端到端（正）：服务可达 ⇒ 如实给出 `toolCount`/`tools`，且**不打** `toolsUnknown`');
  eq([it0?.failures, it0?.serverInfo], [0, { name: 'rr29-stub', version: '0.0.1' }],
    'B-15 ★同一行把池的 `failures`/`serverInfo` 带出来了：池字段的读点在生产工具上真被走到');
  eq(JSON.parse(await toolsE2E.call_mcp_tool.execute({ serverName: 'rr29-mcp-e2e', toolName: 'E', args: '{"q":"1"}' })), 'RR29-E2E',
    'B-16 ★端到端（正）：`call_mcp_tool` 经**配置的** `ans_server_url` 打到桩并取回文本（端点按调用传参，不再是进程级全局）');

  // ── B-17/B-18 ★端到端（负）：不可达必须如实说「未知」，不得与「零工具」同形 ──
  const dbDead = mkdb('http://127.0.0.1:1');
  dbDead.prepare("INSERT INTO wa_deliverables (id, project_id, type, name, status) VALUES ('d1','p1','mcp','rr29-mcp-dead','running')").run();
  const wdDead = mkWorkdir('B夹具不可达'); tmpDirs.push(wdDead);
  const foundDead = JSON.parse(await (buildTools({ db: dbDead } as never, 't1', 'p1', wdDead) as unknown as {
    find_mcp_service: { execute: (a: unknown) => Promise<string> };
  }).find_mcp_service.execute({})) as { services: Array<Record<string, unknown>>; note?: string };
  const dead = foundDead.services[0];
  eq([dead?.toolCount, dead?.toolsUnknown, typeof dead?.toolsError === 'string' && (dead.toolsError as string).length > 0],
    [undefined, true, true],
    'B-17 ★端到端（负）：不可达 ⇒ `toolsUnknown:true` + `toolsError` 有具体原因，且**没有** `toolCount`（此前 `catch {}` 让它与"零工具"长得一样）');
  ok(!!foundDead.note && /未知/.test(foundDead.note),
    'B-18 ★顶层 `note` 明说"未知不代表没有工具"（调用方无从误读）', foundDead.note);

  // ── B-19..B-23 静态（读**原文**，锚点钉符号/定义形状） ──
  const poolSrc = RD(`${A}/src/main/core/mcp-client-pool.ts`);
  eq((poolSrc.match(/export function setEndpointResolver/g) ?? []).length, 0,
    'B-19 ★`setEndpointResolver` 的**定义**已消失（进程级全局解析器：并发任务各调一次即互相覆盖）');
  ok(/export interface McpCallOptions/.test(poolSrc) && /endpointResolver\?: EndpointResolver/.test(poolSrc),
    'B-20 代之以**按调用传参**：`McpCallOptions.endpointResolver?`');
  ok(poolSrc.includes('JSON.stringify([serverName, endpoint])'),
    'B-21 ★缓存键是 (服务名, 端点)**复合键**——没有它，"按调用传参"只是装样子（第二个调用仍取到第一条连接）');
  ok(poolSrc.includes('entry.serverName === serverName'),
    'B-22 `disconnect` 按池内条目自带的 `serverName` 字段精确匹配（不做键字符串解析）');
  ok(poolSrc.includes('await refreshMcpTools(serverName, opts)'),
    'B-23 ★`refreshMcpTools` 在生产代码里被调用（B-1/B-2 的序列是它的行为取证，本条是它的调用点取证）');

  const resSrc = RD(`${A}/src/main/core/tools/resource.ts`);
  // ⚠ zx_20260930 M10 换**锚点形状**（判据前提被本轮设计合法改变，非放宽）：
  //   探工具表这一步被提进共用的 `probeTools(name)`（ANS 注册表那一栏也要探），
  //   于是实参由 `m.name` 变成形参 `name`。**结论更宽**：`listMcpTools(` 在本文件仍**恰一处**，
  //   两条支路都只能走它 ⇒ 没有哪一支能绕过解析器去走兜底常量。断言的**强度只增不减**。
  eq((resSrc.match(/listMcpTools\(/g) ?? []).length, 1,
    'B-24 ★★`find_mcp_service` 里 `listMcpTools(` 全文件**恰一处**（唯一探点）⇒ 没有任何一条支路'
    + '能绕过它自己走池内兜底常量（用户把 ANS 配到别处就列错机器）');
  ok(resSrc.includes('listMcpTools(name, { endpointResolver: resolveEndpoint })'),
    'B-24b ★该唯一探点**确实**按**配置的** `ans_server_url` 解析端点（按调用传参，非进程级全局）');
  ok(/callMcpTool\(args\.serverName, args\.toolName, parsedArgs, \{\s*\n\s*endpointResolver: async \(serverName: string\)/.test(resSrc),
    'B-25 `call_mcp_tool` 同样按调用传参（两工具同尺）');
  eq((resSrc.match(/服务未运行，跳过工具列表/g) ?? []).length, 0,
    'B-26 ★旧的静默 `catch {}` 注释已撤（"服务没起"与"零工具"不再同形）');
  // ⚠ 同上换名（`item.` → `got.`，因为标记现由共用探点产出）；并**补一条接线判据**：
  //   标记算出来若不挂到条目上，等于没算——这正是本仓「只建接口不接」的老病。
  ok(resSrc.includes('got.toolsUnknown = true') && resSrc.includes('logger.warn(`[find_mcp_service]'),
    'B-27 ★失败侧留痕：`toolsUnknown` 标记 + 带具体原因的 `logger.warn`');
  ok(/Object\.assign\(item, await probeTools\(m\.name\)\)/.test(resSrc),
    'B-27b ★★接线：探点结果**真的并进了条目**（`Object.assign(item, …)`）——'
    + '算了不挂与没算同形，调用方看见的都是"这个服务零工具"');

  // ── B-28..B-30 静态：A2A「睡 1 秒就当起来了」换成真探活 ──
  const a2aSrc = RD(`${A}/src/main/core/a2a-runtime.ts`);
  eq((a2aSrc.match(/setTimeout\(resolve, 1000\)/g) ?? []).length, 0,
    'B-28 ★`startA2AServer` 里"睡一秒就当起来了"的字面量已消失（子进程没起来也照样返回成功 ⇒ IPC 随即置 running，名实不符）');
  ok(a2aSrc.includes('const notReady = await waitForListen(port, child)') && a2aSrc.includes('child.exitCode !== null || child.signalCode !== null'),
    'B-29 ★代之以真探活：子进程**未退出** 且 端口**真在 listen** 才算起得来');
  ok(a2aSrc.includes("for (const host of ['127.0.0.1', '::1'])") && a2aSrc.includes('`A2A 服务启动失败：'),
    'B-30 两端点各试一次（只试 IPv4 会把"只绑 ::1"的服务误判为没起来）；失败**如实抛出**并带回 entry/cwd');

  // ── B-31..B-36 ★运行时两只标本：起不来的**必须判失败**，起得来的**必须判成功**（互为反证） ──
  const a2a = await import(path.join(root, A, 'src/main/core/a2a-runtime.js')) as unknown as {
    startA2AServer: (id: string, name: string, dir: string, entry?: string) => Promise<{ endpoint: string; agentCardUrl: string; port: number }>;
    stopA2AServer: (id: string) => Promise<void>;
    listA2AServers: () => Array<{ deliverableId: string; port: number; startedAt: string }>;
    getA2AServerStatus: (id: string) => { running: boolean; port?: number; startedAt?: string };
  };
  const mkSrvDir = (js: string): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rr29-a2a-'));
    fs.writeFileSync(path.join(d, 'server.js'), js, 'utf-8');
    tmpDirs.push(d);
    return d;
  };
  const dirDead = mkSrvDir('process.exit(0);');
  let deadMsg = '';
  try { await a2a.startA2AServer('rr29-a2a-dead', 'B夹具起不来', dirDead); }
  catch (e) { deadMsg = (e as Error).message; }
  ok(/A2A 服务启动失败/.test(deadMsg),
    'B-31 ★起不来的子进程 ⇒ **如实抛错**（固定 1 秒睡眠下这一步会"成功"，随即被登记成 running）', deadMsg.slice(0, 140));
  ok(!a2a.listA2AServers().some((e) => e.deliverableId === 'rr29-a2a-dead'),
    'B-32 ★且**不留残条**：失败者不在运行实况里（否则 A2A 页会显示一个并不在跑的服务）');

  const dirLive = mkSrvDir("require('http').createServer((_q,s)=>s.end('ok')).listen(Number(process.env.A2A_PORT),'127.0.0.1');");
  const started = await a2a.startA2AServer('rr29-a2a-live', 'B夹具起得来', dirLive);
  eq([started.endpoint, started.agentCardUrl],
    [`http://localhost:${started.port}`, `http://localhost:${started.port}/.well-known/agent.json`],
    'B-33 ★起得来的子进程被**判成功**（与 B-31 互为反证：上一条不是"凡调必抛"）', started.endpoint);
  ok(started.port >= 19950 && started.port <= 19999, 'B-34 端口落在 A2A 专属段 19950–19999', String(started.port));
  const live = a2a.listA2AServers().find((e) => e.deliverableId === 'rr29-a2a-live');
  eq([!!live, live?.port, a2a.getA2AServerStatus('rr29-a2a-live').running], [true, started.port, true],
    'B-35 ★`listA2AServers`/`getA2AServerStatus` 与启动结果同源同端口，且子进程**确实活着**（A2A 页"本进程运行中"的实况来源）');
  // B-35b ★实机 E2E 第二病（React error #31，`args[]=[object Date]`）：本套件其实**真起过**一个 A2A 服务
  //   （B-33/B-35），却对 `startedAt` 的**类型**一言不发 ⇒ 这个缺陷本可照出来。现补：出模块边界的必须
  //   是**字符串**且 ISO 形状。判据只看运行时**真返回**的值（不看源码形状），故两处读点各钉一次。
  const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const stLive = a2a.getA2AServerStatus('rr29-a2a-live').startedAt;
  eq([typeof live?.startedAt, isoRe.test(String(live?.startedAt))], ['string', true],
    'B-35b ★★`listA2AServers` 送出的 `startedAt` **是字符串且 ISO 形状**——Electron IPC 的结构化克隆会把 '
    + '`Date` 原样送到渲染层（`A2A 管理界面` 那条 React error #31 即由此出），声明成 `string` 拦不住运行期',
    `${typeof live?.startedAt} / ${String(live?.startedAt)}`);
  eq([typeof stLive, isoRe.test(String(stLive))], ['string', true],
    'B-35b 另一条读路 `getA2AServerStatus` **同尺**（两处读点不得一处序列化一处原样：`deliverable:runtime` 走的正是它）');
  await a2a.stopA2AServer('rr29-a2a-live');
  ok(!a2a.listA2AServers().some((e) => e.deliverableId === 'rr29-a2a-live'), 'B-36 停掉后实况里不再有它（无幽灵条目）');
  // ── B-37..B-40 静态：A2A 自注册（J-2） ──
  const ipcSrc = RD(`${A}/src/main/ipc/project.ipc.ts`);
  ok(ipcSrc.includes('registerToAns(db, id, delivName, delivType, workingDir, entryFile, a2a.endpoint)'),
    'B-37 ★`delivType === "a2a"` 分支补上了 `registerToAns`（该分支此前 early-return ⇒ 桌面里跑着、ANS 侧从未在册），且端点传**实际分配到的端口**');
  ok(/endpointOverride\?: string/.test(ipcSrc) && ipcSrc.includes('const endpoint = endpointOverride ||'),
    'B-38 ★`registerToAns` 支持 `endpointOverride`（兜底常量 19950 只是端口段起点，不可能是实际端口）');
  ok(ipcSrc.includes("ipcMain.handle('deliverable:a2a-list'") && ipcSrc.includes('listA2AServers()'),
    'B-39 ★main 侧真开了 `deliverable:a2a-list` 通道：`listA2AServers` 的读点落在 IPC 上');
  ok(ipcSrc.includes('getA2AServerStatus(deliv.id).endpoint'),
    'B-40 手动注册 A2A 时端点取运行态实况（未在跑则回落常量）');

  // ── B-43..B-46 M10：自注册要**真的发得出去**（实机 E2E 打出来的两条；rr 够不着本文件
  //    ——顶层 `import electron` ⇒ 只能做**源码形状**判据，锚点一律取**代码形状**而非词，
  //    否则本函数上方的注释（含 `x-api-key`/`agent_card_url` 字样）会把判据自我满足） ──
  //  zx_20260930 M9 就地订正（**改钉更强真源，非放宽**）：
  //    B-43a/B-43b/B-44 原锚在**本文件**里手写的 `'x-api-key': apiKey` 与 `createHmacSignature(secretKey,
  //    timestamp, body)`——那正是"每个调用点各自抄一份签名式样"的病根。M9 把式样收进**一处真源**
  //    `core/ans-signed-request.ts`，本文件只留 `ansSignedRequest(creds, path, …)` 一句。
  //    故判据随之**搬到真源上**，并**额外**钉"本文件不再自造头"（旧码若把这套抄回来 ⇒ 立刻判红）。
  //    该不命中的那一侧不再依赖旧码在场，改为**合成标本**（自证切断判据的判别力仍在）。
  {
    const truthSrc = RD(`${A}/src/main/core/ans-signed-request.ts`);
    // 判据本体抽成纯函数：便于对同一函数喂"真源正文"与"抽掉签名行的正文"两只标本。
    const everyKeySiteSigned = (src: string): boolean => {
      const sites = [...src.matchAll(/'x-api-key':/g)].map((m) => m.index ?? 0);
      return sites.length > 0 && sites.every((i) => src.slice(i, i + 400).includes("'x-signature'"));
    };
    const keySites = [...truthSrc.matchAll(/'x-api-key':/g)].length;
    ok(everyKeySiteSigned(truthSrc),
      `B-43a 真源内 ${keySites} 处 ANS 请求头**全部**带签名（自证非空扫 + 同址必带 signature）`);
    // 该不命中（合成标本）：把真源里的 `'x-signature'` 键掐掉 ⇒ 同一函数必须转假。
    //   这正是旧码的形状（只发 x-api-key）⇒ 证明本判据不是恒真。
    ok(!everyKeySiteSigned(truthSrc.replace(/'x-signature':/g, "'x-nonsense':")),
      'B-43b ★反证：把签名键换成任意键后，同一判据**转假**（判别力仍在，不是恒真的自我印证）');
    // 正交证明：`project.ipc.ts` 已**不再自造头**（0 处 `'x-api-key'` 字面量），只经真源发。
    eq([...ipcSrc.matchAll(/'x-api-key':/g)].length, 0,
      'B-43c ★本文件（自注册路）不再自造 ANS 头——签名式样只有真源一处，抄回来即判红');
    // 该命中：签名式样归**一处真源**，非各文件自造 HMAC。
    ok(truthSrc.includes('createHmacSignature(creds.secretKey, timestamp, bodyText)')
      && /import \{ createHmacSignature \} from '@worker-ant\/ans-client'/.test(truthSrc),
      'B-44 ★签的是 `createHmacSignature(secretKey, timestamp, body)`，且从 `@worker-ant/ans-client` 取（与 `AnsClient.request` 同尺）');
    // 该命中：**两种载荷形状并存**（按类型定），这正是第二病的修法；退回单一形状必有一条消失。
    ok(ipcSrc.includes('agent_card_url: endpoint') && ipcSrc.includes("endpoint, transport: 'streamable-http'"),
      'B-45 ★载荷按**类型的路由 schema** 分叉：A2A 发 `agent_card_url`、MCP 发 `endpoint`/`transport`（实机 E2E 第二病：A2A 一律发 endpoint ⇒ 422）');
    // 该不命中：注册路径不再静默——**每个失败出口都留话**（切块按符号+配对花括号，不按行号）。
    const bodyStart = ipcSrc.indexOf('async function registerToAns');
    const body = ipcSrc.slice(bodyStart, ipcSrc.indexOf('\n}\n', bodyStart));
    const warns = [...body.matchAll(/console\.warn\(/g)].length;
    ok(warns >= 4,
      `B-46 ★注册失败不再静默：函数体内 ${warns} 处 console.warn 覆盖各失败出口（旧码仅外层 catch 1 处 ⇒ 401/422 静默；实机 E2E 时"注册失败"与"本来就没注册"在返回值上不可分）`);
  }

  // ── B-41/B-42 renderer 是词表的**第二个落点**（不在 src/main 扫描面内） ──
  const pageSrc = RD(`${A}/renderer/src/pages/A2aPage.tsx`);
  ok(pageSrc.includes("invoke<LocalA2aRuntime[]>('deliverable:a2a-list')"),
    'B-41 ★renderer 侧真调了 `deliverable:a2a-list`（否则上面那条 IPC 通道就是"写了没人读"，本页看不见本进程在跑的 A2A）');
  ok(pageSrc.includes('本进程运行中') && pageSrc.includes('runningHere('),
    'B-42 ★页面上把「本进程运行中」与「ANS 在册状态」**分开说**：名实两本账在 UI 上各自可见');

  // ── B-47..B-50 M12（实机 E2E 打出的两个真缺陷，非原方案条目）：A2A「起得来要看得见」 ──
  //   锚点一律取**代码形状**而非词：a2a-runtime.ts 里本函数紧邻处的长注释含 `startedAt`/`Date` 字样，
  //   按词判会被注释自己满足（"判据的自我印证"）。故钉的是**赋值表达式本身**（注释里没有它）。
  {
    // B-47 出模块边界：两处读点都序列化；且裸 `Date` 形状**零残留**（该不命中的一侧由旧码充当）。
    const isoSites = (a2aSrc.match(/startedAt: (?:e|entry)\.startedAt\.toISOString\(\)/g) ?? []).length;
    eq(isoSites, 2,
      'B-47 ★★a2a 运行时的**两条读路**（`listA2AServers` / `getA2AServerStatus`）都把 `startedAt` 序列化成字符串'
      + '——「模块边界不递活对象」，此处即那条边界');
    eq((a2aSrc.match(/startedAt: (?:e|entry)\.startedAt\b(?!\.toISOString)/g) ?? []).length, 0,
      'B-47 反证：不再有把 `Date` 原样送出的赋值（旧码 `startedAt: e.startedAt }` 即此形状）');
    ok(/startedAt\?: string/.test(a2aSrc) && /startedAt: string/.test(a2aSrc),
      'B-47 返回类型也如实改成 `string`（类型与运行期同尺，不靠"声明成 string 就没事"自欺）');

    // B-48 「起得来之后才死」要有账：ready 须在**探活通过之后**置真，且 exit 回调带**双闸**。
    const readySet = a2aSrc.indexOf('entry.ready = true;');
    const probeLine = a2aSrc.indexOf('const notReady = await waitForListen(port, child)');
    ok(probeLine > 0 && readySet > probeLine,
      'B-48 ★`entry.ready = true` 落在**探活之后**（起不来的子进程绝不会被当成"曾起来过"）');
    ok(a2aSrc.includes('const wasCurrent = processes.get(deliverableId) === entry;')
      && a2aSrc.includes('if (wasCurrent && entry.ready) onExit?.(code, signal);'),
      'B-48 ★★exit 回调带**双闸**：`wasCurrent`（这条 entry 仍是当前那条——`stopA2AServer` 已 '
      + '`removeAllListeners(\'exit\')`，主动停止不会误报）**且** `entry.ready`（探活曾通过）。'
      + '缺任一闸都会把"起不来"或"被我叫停"写成"运行中死了"');
    ok(a2aSrc.includes('onExit?: (code: number | null, signal: NodeJS.Signals | null) => void'),
      'B-48 回调是**可选注入**（`onExit?`）——运行时本身不认识 DB，落库那一步留给调用方');

    // B-49 IPC 启动分支接上 onExit，如实落 `stopped`（与下面 MCP/daemon 路径的 `proc.on(\'exit\')` 同尺）。
    ok(/startA2AServer\(id, delivName, workingDir, entryFile, \(code, signal\) => \{/.test(ipcSrc)
      && ipcSrc.includes("setDeliverableStatus(db, id, 'stopped', 'a2a:exit')"),
      'B-49 ★★IPC 的 a2a 启动分支接上 `onExit` 并落 `stopped`——此前该分支**无人记账**（与同文件 '
      + 'MCP/daemon 路径不对称）⇒ 子进程死了库里仍写 `running`、GUI 绿点长亮');

    // B-50 `deliverable:runtime` 对 a2a **问运行时本尊**，不再拿 DB 的 `status` 当"在跑"。
    const rtHandler = ipcSrc.slice(ipcSrc.indexOf("ipcMain.handle('deliverable:runtime'"),
      ipcSrc.indexOf("ipcMain.handle('deliverable:runtime'") + 1200);
    ok(rtHandler.includes("if (d.type === 'a2a')") && rtHandler.includes('getA2AServerStatus(id)'),
      'B-50 ★★`deliverable:runtime` 遇 a2a **转问运行时本尊**：活进程记在 `a2a-runtime` 自己表里、'
      + '**不在** `runtimeProcesses`，此前只查后者再拿 `d.status === \'running\'` 兜底 ⇒ 对 a2a 恒有 '
      + '`port/endpoint = null`，且死了也一直报"运行中"');
    ok(rtHandler.includes('running: st.running,') && rtHandler.includes('d.status === \'running\''),
      'B-50 反证与在场并存：a2a 分支用 `st.running`（真进程），**非 a2a 分支的 DB 兜底仍在**（不得顺手删掉别路的行为）');
  }

  // ── B-51 M12-续：**退出路径**也要记账（用户目视确认 M12 后，实机复核又打出的一格遗留）。
  //   切块按**符号 + 顶格花括号**（`\n}\n` 落在列 0，函数体内所有 `}` 均缩进 ⇒ 恰切到函数末），不按行号。
  //   该不命中的一侧由**旧码**充当（旧码此体内零处 `setDeliverableStatus`）。
  {
    // zx_20261004 M15: `stopAllRuntimeProcesses` 已纯搬移至 `core/daemon-supervisor.ts`
    //   （`project.ipc.ts` 仅留一处 re-export）。判据语句一字未改，只把扫描面换到该符号**唯一**的新载体。
    const daemonSrc = RD(`${A}/src/main/core/daemon-supervisor.ts`);
    const stopStart = daemonSrc.indexOf('export function stopAllRuntimeProcesses');
    const stopBody = stopStart >= 0 ? daemonSrc.slice(stopStart, daemonSrc.indexOf('\n}\n', stopStart)) : '';
    ok(stopBody.length > 0 && stopBody.includes('stopAllA2AServers'),
      'B-51 自证：定位到退出清理体 `stopAllRuntimeProcesses`（切出的块非空、且确含 a2a 停止那一跳）');
    ok(/type = 'a2a' AND status = 'running'/.test(stopBody),
      'B-51 ★★退出时对账：把库里仍是 `running` 的 a2a 成果找出来——`stopAllA2AServers()` → `stopA2AServer()` '
      + '先 `removeAllListeners(\'exit\')`（M12 刻意让主动停止不误报），而 `\'stopped\'` 只写在 `deliverable:stop` '
      + '那条 IPC 上 ⇒ 经退出关机的 a2a 成果**库里永远停在 `running`**（实测 `zx29-a2a-good` 跨重启一字未动）');
    ok(stopBody.includes("'stopped', 'app:quit'") && /setDeliverableStatus\(/.test(stopBody),
      'B-51 走的仍是 `setDeliverableStatus` 同一真源（状态变更一律经它，不直写 UPDATE）');
    eq((stopBody.match(/setDeliverableStatus\(/g) ?? []).length, 1,
      'B-51 恰一处：这笔账只在退出处补，不散落多写点（同值幂等，绝不会把"本来就没跑"写成"停止过"）');
  }

  for (const s of stubs) { try { await s.close(); } catch { /* 桩关闭失败不影响断言 */ } }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响断言 */ } }
}

// ══════════════════════════════════════════════════════════════════
// 【C】M3 围栏上路 + 有界读盘
//   病根形状（与 A/B 同族，但落在安全面上）：**围栏在册、路不同**——
//     ① 只读三工具把路径直接交给 `fs`，`..` 与 `/etc/passwd` 一路通行（写侧早有的两条硬红线读侧没有）；
//     ② `write.ts` 把 `await import('../sandbox.js')` 包在空 `catch {}` 里 ⇒ 沙箱模块没加载上时
//        围栏**整个不上路**，而调用方看不出与"路径没问题"的分别；
//     ③ 附件一律"整读进内存再看长度"——100MB+1 的视频要先吃满 100MB 才被判超限；
//     ④ 归一化 WAV 落在一个**全局目录**且只进不出。
//   ⚠ 补齐只读围栏的落点刻意是**零依赖**的 `core/path-fence.ts`（而非 `sandbox.ts`）：后者引
//     `logger.ts` ⇒ pino 在模块加载时即起 transport 与日志目录，而 `core/tools/*` 被十余个 rr 直跑。
// ══════════════════════════════════════════════════════════════════
async function groupC(): Promise<void> {
  console.log('\n【C】M3 围栏上路 + 有界读盘');
  const pf = await import(path.join(root, A, 'src/main/core/path-fence.js')) as unknown as {
    homeDir: () => string;
    SENSITIVE_PATHS: string[];
    sensitivePathHit: (resolved: string, userHome?: string) => string | null;
    TRAVERSAL_ERROR: string;
    readPathGuard: (p: string, wd: string) => { ok: boolean; resolved: string; error?: string };
  };
  const ak = await import(path.join(root, A, 'src/main/core/attachment-kinds.js')) as unknown as {
    FAMILY_MAX_BYTES: Record<string, number>;
  };
  const at = await import(path.join(root, A, 'src/main/core/audio-transcribe.js')) as unknown as {
    TRANSCRIBE_TMP_DIR: string;
    transcribeTmpDirFor: (taskId: string) => string;
    cleanTranscribeTmp: (dir: string | undefined) => Promise<void>;
  };
  const inl = await import(path.join(root, A, 'src/main/core/attachment-inline.js')) as unknown as {
    buildAttachmentParts: (items: ReadonlyArray<unknown>, io?: Record<string, unknown>) => Promise<{
      parts: Array<{ type: string; text?: string }>;
      outcomes: Array<{ status: string; reason?: string; bytes?: number; marker: string }>;
    }>;
  };

  // ── C-1..C-3 静态：**敏感名单只有一份**，且落点零依赖（读**原文**，锚点钉 import 行） ──
  const pfSrc = RD(`${A}/src/main/core/path-fence.ts`);
  eq(pfSrc.match(/^import .*$/gm) ?? [], ["import os from 'node:os';", "import path from 'node:path';"],
    'C-1 ★★`path-fence.ts` 的**依赖面恰为两条 node: 内建**——引 `logger.ts` 会把 pino 的 transport 与日志目录拖进每一个引 `core/tools/*` 的 rr 直跑');
  ok(/export const SENSITIVE_PATHS/.test(pfSrc) && /export function sensitivePathHit/.test(pfSrc)
    && /export function readPathGuard/.test(pfSrc),
    'C-2 扫描面自证：表 / 命中判定 / 只读入口守则**三件都在** `path-fence.ts`（否则下面的"只有一份"是扫了个空）');
  const sbSrc = RD(`${A}/src/main/core/sandbox.ts`);
  ok(sbSrc.includes("from './path-fence.js'") && !/export const SENSITIVE_PATHS/.test(sbSrc),
    'C-3 ★敏感名单**只有一份**：`sandbox.ts` 反向引 `path-fence.js`，自己不再声明 `SENSITIVE_PATHS`（改一处忘另一处的老形状就此断掉）');

  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'rr29-m3-'));
  const tools = buildTools({ db: mkdb() } as never, 't1', 'p1', wd) as unknown as {
    read_file: { execute: (a: { filePath: string }) => Promise<string> };
    view_image: { execute: (a: { filePath: string }) => Promise<string> };
    read_document: { execute: (a: { filePath: string }) => Promise<string> };
  };
  const parse = (s: string): Record<string, unknown> | null => {
    try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; }
  };

  // ── C-4..C-8 `read_file` 的两条硬红线 + 一条**该不命中**（合法读不许被误伤） ──
  fs.writeFileSync(path.join(wd, 'ok.txt'), 'M3-OK');
  eq(await tools.read_file.execute({ filePath: 'ok.txt' }), 'M3-OK',
    'C-4 回归：工作目录内普通文件照读（围栏没有把合法读一起拒掉）');
  const trav = parse(await tools.read_file.execute({ filePath: '../x.txt' }));
  eq(trav?.error, pf.TRAVERSAL_ERROR,
    'C-5 ★`..` 遍历硬拒，回话与写侧**逐字同串**（同一个刻度，不是"读侧另说一套")');
  ok(RD(`${A}/src/main/core/tools/write.ts`).includes(`'${pf.TRAVERSAL_ERROR}'`),
    'C-6 ★上一条的"逐字同串"**从写侧原文取证**（不是本脚本自抄一份来跟自己比）');
  const sens = parse(await tools.read_file.execute({ filePath: '~/.ssh/id_rsa' }));
  ok(typeof sens?.error === 'string' && sens.error.includes('沙箱拦截') && sens.error.includes('~/.ssh/'),
    'C-7 ★敏感路径硬拒（`~/.ssh/id_rsa` ⇒ 命中 `~/.ssh/`）——写侧早有的红线，读侧此前一步都不查',
    String(sens?.error));
  const HOME = pf.homeDir();
  eq([pf.sensitivePathHit(path.join(HOME, 'notes.txt')),
    pf.readPathGuard(path.join(HOME, 'notes.txt'), wd).ok],
  [null, true],
  'C-8 ★该不命中：当前用户家目录里的**普通**文件不按敏感处理（否则"读参考项目"这类合法读会被本围栏误伤）');
  eq([pf.sensitivePathHit(path.join(HOME, '.ssh', 'id_rsa')),
    pf.sensitivePathHit(path.join(HOME, 'projects', 'foo', '.ssh-backup', 'x')),
    pf.sensitivePathHit('/etc/passwd'),
    pf.sensitivePathHit('/Users/otheruser/x')],
  ['~/.ssh/', null, '/etc/passwd', '/Users/'],
  'C-9 ★区分度四连：家目录内的 `.ssh/` 仍硬拒 · **同名前缀**（`.ssh-backup`）不算命中 · 系统表项硬拒 · 别人的家目录按敏感处理（上一条不是"凡家目录内都放行"）');

  // ── C-10 ★本轮的裁定：工作目录外的**普通**绝对路径仍可读（只读侧**不引审批流**） ──
  const outside = path.join(os.tmpdir(), `rr29-m3-outside-${process.pid}.txt`);
  fs.writeFileSync(outside, 'OUTSIDE-OK');
  eq(await tools.read_file.execute({ filePath: outside }), 'OUTSIDE-OK',
    'C-10 ★工作目录外的普通绝对路径**仍可读**——刻意不照抄写侧的软边界（那会把读变成待审批）；与 C-7 合看：宽窄两侧各钉一只标本');
  fs.rmSync(outside, { force: true });

  // ── C-11/C-12 三把只读工具**同一把尺**（`view_image` / `read_document` 也是） ──
  eq(parse(await tools.view_image.execute({ filePath: '../pic.png' }))?.error, pf.TRAVERSAL_ERROR,
    'C-11 ★`view_image` 走的是同一个守则（`..` 硬拒）');
  const rdSens = parse(await tools.read_document.execute({ filePath: '/etc/passwd' }));
  ok(typeof rdSens?.error === 'string' && rdSens.error.includes('沙箱拦截') && rdSens.error.includes('/etc/passwd'),
    'C-12 ★`read_document` 同样硬拒敏感路径——三把工具一致（围栏不许只上在一把上）', String(rdSens?.error));

  // ── C-13/C-14 有界读盘：**超限者根本没被读进内存**（0→1 正反两面同钉） ──
  const bigMp4 = path.join(wd, 'big.mp4');
  {
    const fd = fs.openSync(bigMp4, 'w');
    fs.ftruncateSync(fd, ak.FAMILY_MAX_BYTES.video! + 1);   // sparse：秒建，盘上真那么大
    fs.closeSync(fd);
  }
  let readCalls = 0;
  const bigRes = await inl.buildAttachmentParts([{ path: bigMp4, fileName: 'big.mp4' }], {
    readFile: () => { readCalls++; return Buffer.alloc(8); },
    transcribeAudio: async () => ({ ok: true, text: '不该被调用' }),
  });
  const bigOc = bigRes.outcomes[0]!;
  eq([bigOc.status, bigOc.reason, bigOc.bytes, readCalls],
    ['omitted', 'over_limit', ak.FAMILY_MAX_BYTES.video! + 1, 0],
    'C-13 ★★超限件**没被读进内存**：盘上尺寸先判 ⇒ `omitted(over_limit)` 真发生**而 `readFile` 调用 0 次**'
    + '——`bytes` 钉的是**盘上真尺寸**（上限+1）不是上限本身：只钉"没读"会被"根本没走到这一步"假绿，'
    + '两半合看才不是空转');
  ok(bigOc.marker.includes(String(ak.FAMILY_MAX_BYTES.video! + 1)) && !bigRes.parts.some((p) => (p.text ?? '').includes('不该被调用')),
    'C-14 marker 报出**真**字节数（上限+1，不是把上限当成文件大小），且转写器**根本没被调用**'
    + '（超限是"不内联"，不是"截断一半当完整"）');

  // ── C-15 ★反证：`statSize` 取不到盘上尺寸时，**读后那道闸仍在**（否则 C-13 就是"凡调用都省了读"） ──
  const smallPng = path.join(wd, 'small.png');
  fs.writeFileSync(smallPng, Buffer.alloc(16));   // 盘上 16 字节
  let readsInjected = 0;
  const injectRes = await inl.buildAttachmentParts([{ path: smallPng, fileName: 'small.png' }], {
    // 刻意**不传** `statSize`（走生产缺省）：盘上 16 字节 ⇒ 前置闸不触发 ⇒ 只能靠读后那道闸
    readFile: () => { readsInjected++; return Buffer.alloc(ak.FAMILY_MAX_BYTES.image! + 1); },
    downscaleImage: async () => null,
  });
  eq([injectRes.outcomes[0]!.status, injectRes.outcomes[0]!.reason, readsInjected],
    ['omitted', 'over_limit_no_downscale', 1],
    'C-15 ★★反证（与 `rr_zx_20260921` C8/C9 同形）：盘上小、注入的却超限 ⇒ **读后那道闸抓住了**并走了降质口'
    + '——"先 stat"是省读，**不是**替掉读后判定');

  // ── C-16/C-17 `media.ts` 两个工具的超限口径取自**真源常量**（不另写一个数） ──
  const hugePdf = path.join(wd, 'huge.pdf');
  const hugePng = path.join(wd, 'huge.png');
  for (const [f, fam] of [[hugePdf, 'document'], [hugePng, 'image']] as const) {
    const fd = fs.openSync(f, 'w');
    fs.ftruncateSync(fd, ak.FAMILY_MAX_BYTES[fam]! + 1);
    fs.closeSync(fd);
  }
  const outDocBig = parse(await tools.read_document.execute({ filePath: 'huge.pdf' }));
  ok(typeof outDocBig?.error === 'string' && outDocBig.error.includes('超过')
    && outDocBig.error.includes(String(ak.FAMILY_MAX_BYTES.document)),
    'C-16 ★`read_document` 超限 ⇒ 报清"实际字节 vs 上限"，上限读的是**真源** `FAMILY_MAX_BYTES.document`（不另写一个数）',
    String(outDocBig?.error));
  const outImgBig = parse(await tools.view_image.execute({ filePath: 'huge.png' }));
  ok(typeof outImgBig?.error === 'string' && outImgBig.error.includes('超过')
    && outImgBig.error.includes(String(ak.FAMILY_MAX_BYTES.image)),
    'C-17 ★`view_image` 同尺（`stat` 先判：11MB 的图不再先吃满 11MB 才被判超限）', String(outImgBig?.error));

  // ── C-18..C-21 `write.ts` fail-closed（`import` 失败 ⇒ 拒写 + 留痕，不再"静默不上路"） ──
  const wSrc = RD(`${A}/src/main/core/tools/write.ts`);
  const refuseWrite = (wSrc.match(/路径围栏不可用（沙箱模块加载失败），已拒绝/g) ?? []).length;
  const importSites = (wSrc.match(/await import\('\.\.\/sandbox\.js'\)/g) ?? []).length;
  eq([refuseWrite, importSites], [2, 2],
    'C-18 ★★`write_file` / `edit_file` **两个执行体都 fail-closed**（拒写回话恰 2 处，对应 2 处 `await import`）——'
    + '此前那两处是空 `catch {}`："沙箱没加载上"与"路径没问题"在调用方看来长得一模一样');
  eq((wSrc.match(/enforcePathScope\(/g) ?? []).length, 2,
    'C-19 沙箱判定仍**恰 2 处**且都在 `write.ts`（读侧走 `readPathGuard`，没有把 `enforcePathScope` 扩散过去——那会把普通外读变成待审批）');
  // 注意：**不能**用 `[^)]*`——载荷里 `err: (e as Error).message` 自带一个 `)`，正则会在那里截住，
  //   于是"留了痕"的源码反被判红（判据自己被自己的字符集卡住）。
  ok(/logger\.error\([\s\S]{0,300}?沙箱模块加载失败/.test(wSrc),
    'C-20 ★fail-closed 同时**留痕**（`logger.error`）——"拒了"与"拒了但没人知道为什么"是两回事');
  ok(/catch \(e\) \{\s*\n\s*logger\.error/.test(wSrc),
    'C-21 ★拒写发生在 `catch` 里（import 真失败才走），不是无条件的早退');

  // ── C-22..C-24 归一化产物：按本次运行分目录 + 收口整目录收掉 ──
  const tmpDir = at.transcribeTmpDirFor('rr29-task-c');
  ok(tmpDir.startsWith(at.TRANSCRIBE_TMP_DIR + path.sep) && tmpDir !== at.TRANSCRIBE_TMP_DIR,
    'C-22 ★按 `taskId` 分一层子目录（不是全局共用一个目录——那正是"只进不出"的来源）', path.basename(tmpDir));
  // ★★锚点钉的是**派生结果的结构性质**（`path.resolve` 必须落回本色之内），不是"夹具照抄一遍生产
  //   正则"——那是判据的自我印证：生产正则留着点号的口子，夹具会跟着一起放行，两边同时假绿
  //   （本仓已复发两次）。这里喂进去的 `'.'` / `'..'` 恰恰是**洗字符集洗不掉**的那种输入：
  //   旧实现下它们会折到本色之上或本色本身，本断言当场判红。
  const tmpBaseResolved = path.resolve(at.TRANSCRIBE_TMP_DIR) + path.sep;
  const escaped = ['.', '..', '...', '..x', '../x', 'a/b', ''].filter(
    (t) => !path.resolve(at.transcribeTmpDirFor(t)).startsWith(tmpBaseResolved));
  eq(escaped, [],
    'C-23 ★★敌意 `taskId`（`.` / `..` / `../x` / 空）派生出的目录**一律仍落回本色之内**——'
    + '旧实现洗掉分隔符却留着点号 ⇒ `transcribeTmpDirFor("..")` 折到父目录，'
    + '`cleanTranscribeTmp` 会（正确地）拒绝删它，于是那些运行的 WAV 从"用完就收"悄悄退回"只进不出"');
  eq(path.relative(at.TRANSCRIBE_TMP_DIR, at.transcribeTmpDirFor('a/b')), 'a_b',
    'C-23b 该命中：分隔符被洗掉（`a/b` 不造出两层）——守卫**不是**把洗字符集整个废掉');
  eq(path.basename(at.transcribeTmpDirFor('rr29-task-c-1')), 'rr29-task-c-1',
    'C-23c 该不命中：寻常 `taskId` 原样成目录名（结构守卫不误伤好输入）');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'x.wav'), 'WAV');
  await at.cleanTranscribeTmp(tmpDir);
  ok(!fs.existsSync(tmpDir), 'C-24 ★收口把本次运行的产物**整目录**收掉（真删：断言的是 `existsSync === false`，不是"没抛"）');

  // 该不命中：本色（`TRANSCRIBE_TMP_DIR` 自身）不收——收了会把并发跑着的**别的**任务的产物一起端掉
  fs.mkdirSync(at.TRANSCRIBE_TMP_DIR, { recursive: true });
  const sentinel = path.join(at.TRANSCRIBE_TMP_DIR, 'rr29-sentinel.wav');
  fs.writeFileSync(sentinel, 'X');
  await at.cleanTranscribeTmp(at.TRANSCRIBE_TMP_DIR);
  ok(fs.existsSync(sentinel), 'C-25 ★该不命中：本色（全局目录自身）**不删**（删了会误伤并发中的其他任务）');
  fs.rmSync(sentinel, { force: true });

  // ── C-26..C-28 接线上路（静态：读原文，锚点钉符号/语句形状） ──
  const aeC = engineSrc();
  ok(/makeAudioTranscriber\(ansClient,\s*transcribeTmp\)/.test(aeC),
    'C-26 ★生产把**本次运行**的目录传进转写器（此前 `makeAudioTranscriber(ansClient)` 落全局目录 ⇒ 谁也不知道该收哪个）');
  ok(/const transcribeTmp = transcribeTmpDirFor\(taskId\)/.test(aeC)
    && (aeC.match(/transcribeTmpDirFor\(/g) ?? []).length === 1,
    'C-27 ★目录**一处派生**（`finally` 里用的是同一个值，不重算——重算就成了两处派生）');
  ok(/finally\s*\{[\s\S]{0,400}cleanTranscribeTmp\(transcribeTmp\)/.test(aeC)
    && (aeC.match(/cleanTranscribeTmp\(/g) ?? []).length === 1,
    'C-28 ★★收口挂在 `finally` 上：达标收尾 / 三个早退口 / 抛错**三条出口都收**——挂在 return 前就只有一条出口收到');

  try { fs.rmSync(wd, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响断言 */ }
}

// ══════════════════════════════════════════════════════════════════
// 【D】M4 记忆：四条排序路径同一把尺 · 账＝实 · 时区同基准 · 同源替换一行
//
//   四条病根（方案 §1.4 / §M4）：
//     ① 同一个「降权」在四条排序路径上是**四个意思**——`search` / `retrieveByCue` 漏 `_applicabilityPenalty`、
//        `getProjectKnowledge` **两个都漏** ⇒ 同一条"已被取代 / 易变"的记忆算不算数，取决于**它碰巧从哪条路被取回**；
//     ② `meta.chars` 只记保留段、漏掉省略注记 ⇒ **账比实小**（越是如实交代，报得越"省"）；
//     ③ 三条排序路径 + 间隔重复把 SQLite 的**无时区 UTC 串**交给 `new Date()` 按**本地**解析
//        （UTC+8 下凭空多算 8 小时 = 半衰期白丢），而同文件的整合管道早已补 `Z` ⇒ 同一条曲线上**两把尺**；
//     ④ `acceptance_failure` / `archetype_correction` **直写** ⇒ 同一项目每失败一次追加一行，
//        自家副本挤占自家 top3 名额（读者是 `retrieveByType(type, projectId, 3)`）。
//
//   ★★ **就地订正（本组实测推翻方案原文）**：方案 §M4 要求把 `omittedNote` **计入预算**，并预言
//      "省略多时可越预算 / 修后不可越"。24 段富夹具 A/B 实测（D-2）**否掉了这条**——见 D-2 两条注释里的实测数。
//      故本轮只保留"计入 `meta.chars`"，并把越界上界与保底支的越界**如实钉住**：
//      后人若把这支当"缺陷"重修，D-2 会当场判红（本仓已有"判据自身不成立"的先例，宁可钉住不重犯）。
// ══════════════════════════════════════════════════════════════════
async function groupD(): Promise<void> {
  console.log('\n【D】M4 记忆：四条排序路径同一把尺 · 账＝实 · 时区同基准 · 同源替换一行');
  const mmCtx = await import(path.join(root, A, 'src/main/core/memory-context.js')) as unknown as {
    MEM_OVERHEAD: number;
    selectMemorySections: (s: Array<{ name: string; priority: 'low' | 'mid' | 'high'; text: string }>, maxChars: number) =>
      { kept: unknown[]; omitted: unknown[]; chars: number };
    buildMemoryContext: (memory: unknown, projectId: string, taskId: string | undefined,
      principalContradiction: string | undefined, taskGoal: unknown, excludeIds: unknown, budgetChars: number) =>
      { context: string; accessedIds: string[]; meta: { sections: number; kept: number; omitted: number; chars: number } };
  };
  const mmMod = await import(path.join(root, A, 'src/main/core/memory-manager.js')) as unknown as {
    MemoryManager: new (db: unknown, ans: unknown) => unknown;
    dbTimeMs: (raw: string | null | undefined) => number;
  };
  const MC_OVER = mmCtx.MEM_OVERHEAD;

  // ── 富夹具：24 段全触发（**不是**"能塞几段算几段"——只有段全在场，按值取舍才谈得上「按值」） ──
  const B = (n: number) => 'B'.repeat(n);
  const mem = (id: string, content: string) => ({ id, content, importance: 0.5, valence: 'neutral', context_json: '{}' });
  const richStub = () => {
    const byType: Record<string, Array<{ id: string; content: string; importance: number; valence: string; context_json: string }>> = {
      semantic: [mem('sem', B(200))],
      procedural: [mem('proc', B(200))],
      episodic: [mem('epi', B(200))],
      retrospective: [mem('retro', B(200))],
      limiting_belief: [mem('lb', B(200))],
      archetype_correction: [mem('ac', B(200))],
      acceptance_failure: [mem('af', B(200))],
    };
    return {
      // zx_20261014_4 批五：原 `panorama`（LLM 每轮重综合的散文）注入段**已退役**，其消费位置由
      //   §K「项目域知识」（零 LLM 派生册）接管——故本富夹具改喂**派生册**（`listDomainKnowledge`），
      //   仍凑满 24 段（承 `feedback_retarget_assertions_to_stronger_source`：换载体不换判据强度）。
      listDomainKnowledge: () => [{ section: 'entities', content: B(300), sourceRef: 'wa_knowledge_triples' }],
      findSimilarTasks: () => [{ id: 's1', title: '历史任务甲', status: 'completed', similarity: 80 }],
      getTaskArchetype: () => 'dev',
      getTaskText: () => '实现某功能。' + B(30),
      retrieveByType: (t: string) => byType[t] ?? [],
      buildMemoryEffectivenessStats: () => [{ memoryType: 'episodic', successRate: 0.5, sampleCount: 4 }],
      buildExecutionPlaybook: () => ({ dev: '先看 A，再看 B，再动手' + B(20) }),
      generateExemplarContext: () => '## 范例记忆\n' + B(200),
      findCrossProjectSimilarTasks: () => [{ id: 'x1', title: '跨项目任务乙', projectName: 'other', similarity: 70, status: 'completed' }],
      getCrossProjectKnowledge: () => [{ id: 'ck1', projectName: 'other', memoryType: 'semantic', content: B(200) }],
      retrieveTaskRelevant: () => [mem('rel', B(200))],
      retrieveByCue: () => [mem('cue', B(200))],
      getProjectKnowledge: () => [mem('pk', B(200))],
      retrieveKnowledgeGraphContext: () => [{ subject: '甲' + B(20), predicate: '依赖', object: '乙' + B(20) }],
      getTriggeredProspective: () => [mem('pro', B(200))],
      markProspectiveTriggered: () => { /* 夹具无需记账 */ },
      getWorkingMemory: () => [{ content: B(200), ts: '2026-09-29 00:00:00' }],
      retrieveUnknownHits: () => [mem('uk', B(200))],
      retrieveNegativeHits: () => [mem('neg', B(200))],
      getSimilarTaskExperience: () => '## 历史同类经验\n' + B(200),
      getPeerAcceptanceCriteria: () => [{ id: 'pt1', title: '同类任务丙', status: 'completed', acceptance_criteria: B(200) }],
      deepRetrieve: () => [],
      recordAccess: () => { /* 只读断言不需要记账 */ },
      confidenceOf: () => 0.9,
      maturityOf: () => 0.9,
      applicabilityMismatch: () => false,
    } as unknown as Parameters<typeof mmCtx.buildMemoryContext>[0];
  };
  const goal = { goal: '完成本轮实施', success_criteria: 'rr 全绿', investigate: [] as string[] };
  const run = (budget: number) => mmCtx.buildMemoryContext(richStub(), 'p1', 't1', B(30), goal, undefined, budget);
  const NOTE_RE = /\n\n（记忆预算：已省略 \d+ 段：[^）]*）/;
  const noteOf = (s: string): string => NOTE_RE.exec(s)?.[0] ?? '';

  ok(typeof mmCtx.buildMemoryContext === 'function' && mmCtx.selectMemorySections(
    [{ name: '项目域知识', priority: 'low', text: B(100) }], 0).chars === 100,
    'D-1 自证：取舍函数**可被直接 import 度量**（`maxChars=0` 仍留 1 段、量得 100 字 ⇒ 不是空转）'
    + '——"段长 100 / 量得 100"同时说明量的是**字符数**而非段数');

  // ── D-1 账＝实：`meta.chars` 记的是**真入文**（保留段 + 分隔 + 注记），不是"保留段之和" ──
  const full = run(6000);
  ok(full.meta.sections === 24 && full.meta.omitted === 0 && noteOf(full.context) === '',
    'D-1 自证：6000 预算下 24 段**全留**、**无注记**——只有这一趟才量得准"不含注记的**包裹真长** W"',
    `sections=${full.meta.sections} kept=${full.meta.kept} omitted=${full.meta.omitted}`);
  const W = full.context.length - full.meta.chars;
  ok(W > 0 && W < MC_OVER,
    `D-1 自证：包裹真长 W 由**真输出**量出（\`len − meta.chars\`）且小于预留 ${MC_OVER}——"预留"确有非零余量`,
    `W=${W}`);
  const om = run(3000);
  const omNote = noteOf(om.context);
  ok(omNote.length > 0 && om.meta.omitted > 0 && om.meta.kept < om.meta.sections,
    'D-1 自证：3000 预算下**真发生省略**且注记在场（下两条的区分度由此成立）',
    `kept=${om.meta.kept}/${om.meta.sections} noteLen=${omNote.length}`);
  ok(full.meta.kept + full.meta.omitted === full.meta.sections
    && om.meta.kept + om.meta.omitted === om.meta.sections,
    'D-1 ★★划分是**分区**：`kept + omitted === sections`（既无段被重复计、也无段被漏计）——'
    + '这就是"注记点名的段"与"记账集"互补的**结构性**依据（两者同出一次 `selectMemorySections`）：'
    + '若某段既进记账集又被注记点名，此式必不成立',
    `全留 ${full.meta.kept}+${full.meta.omitted} vs ${full.meta.sections} · 省略 ${om.meta.kept}+${om.meta.omitted} vs ${om.meta.sections}`);
  eq(om.meta.chars, om.context.length - W,
    'D-1 ★★账＝实：`meta.chars` === **真入文**字符数（保留段 + 段间分隔 + **注记**）——`context.length − meta.chars` 恒为 W，与有无注记无关');
  ok(om.meta.chars !== om.context.length - W - omNote.length,
    'D-1 ★★反证（与上条**合看**才叫"把注记算进去了"）：按**旧口径**（只记保留段、漏掉注记）算出的值与真账**不等**，'
    + '差额恰为注记长度 ⇒ 旧账在"省略越多"时报得越**省**（实测 3000 预算：真账 2682 / 旧口径 2590，差 = 注记 92 字）',
    `${om.meta.chars} vs ${om.context.length - W - omNote.length}`);
  ok(om.context.endsWith(omNote + '\n</memory-context>'),
    'D-1 自证：注记是上下文的**真尾巴**（量到的确是它，不是从别处长相似处截来的）', omNote.slice(2, 24) + '…');

  // ── D-2 越界边界：**实测**推翻"把注记计入预算"，并把真形状钉住 ──
  const sweep = [200, 260, 285, 286, 300, 400, 600, 900, 1500, 3000, 6000].map((b) => ({ b, r: run(b) }));
  const over = sweep.filter((s) => s.r.context.length > s.b);
  const lone1 = sweep.filter((s) => s.r.meta.kept === 1);
  const allKept = sweep.filter((s) => s.r.meta.omitted === 0);
  ok(over.length > 0 && lone1.length > 0 && allKept.length > 0,
    'D-2 自证（标本有效性）：同一夹具扫预算，**同时**造出「越界支 / 保底支 / 全留支」三态——否则下面两条是空转',
    `越界 ${over.map((s) => `${s.b}(+${s.r.context.length - s.b})`).join(' ')} · 保底 ${lone1.map((s) => s.b).join('/')} · 全留 ${allKept.map((s) => s.b).join('/')}`);
  ok(over.every((s) => s.r.meta.kept === 1),
    'D-2 ★★越界**只**可能来自「最后一段丢不得」（`len > budget` ⟹ `kept === 1`）——这正是方案原文「把注记计入预算」'
    + '实测无效的**结构原因**：缩小预算只能多丢段，而 `selectMemorySections` 在 `alive.size <= 1` 处停手；'
    + '最后一段丢了是更坏的违约 ⇒ 缩预算缩不出任何变化，只白丢内容（实测 400/600/900 三档改前**本就不越界**，'
    + '而预留实打实白丢一段：kept 2→1 / 3→2 / 4→3）');
  ok(!sweep.some((s) => s.r.meta.kept >= 2 && s.r.context.length > s.b),
    'D-2 ★等价反面：凡**真的在按值取舍**（`kept ≥ 2`）的预算一律**不越界**——"越预算"不是普遍现象，而是保底支的如实后果');
  const lone = run(260);
  ok(lone.meta.kept === 1 && lone.context.includes('本任务成败关键') && lone.context.includes('主要矛盾'),
    'D-2 ★保底支留下的是**任务关键约束**那一段（high 级、最贴当下）——若留的是任意一段，'
    + '"至少保留 1 段"就没兑现它**该保的那一段**');
  const mcSrc = RD(`${A}/src/main/core/memory-context.ts`);
  ok(mcSrc.includes('selectMemorySections(parts, Math.max(0, budgetChars - MEM_OVERHEAD))'),
    'D-2 ★★就地订正（方案 §M4「把注记计入预算」**经实测未采用**）：预算仍是"上限 − MEM_OVERHEAD"，注记**不为它让路**；'
    + '它的兑现处是账（下一条），不是预算');
  ok(/const chars = sel\.chars \+ omittedNote\.length;/.test(mcSrc),
    'D-2 ★与上条一体两面：**账里要算它，预算里不必为它让路**（"注记是上下文的一部分"没错，只是不靠缩预算来兑现）');

  // ── D-3 时区同基准 + 年龄基准一处真源（M6）：五处读数**一把尺**，且 `updated_at` 永不参与 ──
  // zx_20261018_2 批七「见简」：检索读数与巩固簇已机械搬出管理器——判据按符号重定向到**三模块之和**
  //   （只搬不改义：五处时间读数的语句形状、处罚因子语句形状一字未动，接收者按新载体改形）。
  const mmSrc = RD(`${A}/src/main/core/memory-manager.ts`);
  const retSrc = RD(`${A}/src/main/core/memory-retrieval.ts`);
  const consSrc = RD(`${A}/src/main/core/memory-consolidation.ts`);
  const memAllSrc = `${mmSrc}\n${retSrc}\n${consSrc}`;
  const decaySrc = RD(`${A}/src/main/core/memory-decay.ts`);
  const want: Array<[string, RegExp]> = [
    ['retrievalStrength', /const recency = mem\.last_used_at \? Math\.exp\(-ageDaysSince\(mem\.last_used_at\) \/ RETRIEVAL_TAU_DAYS\) : 0;/],
    ['maturityOf', /const age = 1 - Math\.exp\(-ageDaysSince\(mem\.created_at\) \/ MATURITY_TAU_DAYS\);/],
    ['confidenceOf', /conf \*= Math\.exp\(-memoryAgeDays\(mem\) \/ \(CONFIDENCE_TAU_DAYS \* useFactor\)\);/],
    ['runConsolidationPipeline·衰减', /const decayed = mem\.importance \* decayFactor\(mem\);/],
    ['spacedRepeat', /mem\.last_reinforced_at \? dbTimeMs\(mem\.last_reinforced_at\) : dbTimeMs\(mem\.created_at\)/],
  ];
  // ⚠ **逐点按语句形状**钉，不数总数：本文件注释里也出现过 `dbTimeMs('')`（引文），按总数钉会被注释骗过，
  //   也会被"将来再加一处"漏过（G-5：静态判据读**原文**，锚点钉符号/语句形状）。
  eq(want.filter(([, re]) => !re.test(memAllSrc)).map(([n]) => n), [],
    'D-3 ★★**五处时间读数同一把尺**（`retrievalStrength` / `maturityOf` / `confidenceOf` / 整合管道衰减 / 间隔重复）'
    + '——M6 把年龄基准与半衰期收进 `memory-decay.ts` 一处，五处不再各自 `new Date(串)`。'
    + '这些串都是 SQLite `datetime(\'now\')` 的**无时区 UTC**，裸 `new Date(串)` 会按**本地**解析（UTC+8 下凭空多算 8 小时）');

  // 尺从**哪来**：五处读数所用的四把尺 + 三个尺度常数**全部**引自 `memory-decay.js` 一处（再无第二份实现）。
  // 批七后各模块只引自己用的那几把尺——判据取三模块 import 块的**并集**（"来处同一"仍成立：
  //   每一个名字都必须能在 `./memory-decay.js` 的 import 块里找到，不许另起第二份实现）。
  const decayImport = [mmSrc, retSrc, consSrc]
    .map((s) => (s.match(/import\s*\{([\s\S]*?)\}\s*from '\.\/memory-decay\.js';/) ?? [])[1] ?? '')
    .join('\n');
  eq(['dbTimeMs', 'ageDaysSince', 'memoryAgeDays', 'decayFactor',
    'RETRIEVAL_TAU_DAYS', 'MATURITY_TAU_DAYS', 'CONFIDENCE_TAU_DAYS']
    .filter((n) => !new RegExp(`\\b${n}\\b`).test(decayImport)), [],
    'D-3 ★★尺的**来处**同一（`./memory-decay.js` 的 import 块含全部四函数 + 三常数）——'
    + '否则"同一把尺"只是两把长得一样的尺：改一处，另一处静默不动',
    decayImport.replace(/\s+/g, ' ').trim().slice(0, 110) + '…');
  ok(/export \{ dbTimeMs \};/.test(mmSrc) && !/function dbTimeMs\(/.test(mmSrc) && !/const dbTimeMs\s*=/.test(mmSrc),
    'D-3 ★★`dbTimeMs` 在 `memory-manager.ts` 里是**再导出**而非第二份实现（`export { dbTimeMs };` 在册，'
    + '且本文件无 `function dbTimeMs(` / `const dbTimeMs =`）——实现只有 `memory-decay.ts` 一处，'
    + '既有引点（`project-engine.ts` 等）与 rr 判据一字不改地共用它');

  // ★★靶心反证（M6 病根）：**系统改写不得刷新年龄**——`updated_at` 不得喂进任何年龄读数。
  //   `updated_at` 是「最后一次被**写**」，会被十几处系统写刷新（同源替换 / 强化 / 冲突合并 / 工具改写）
  //   ⇒ 拿它当年龄＝每次系统改写白送一轮新的半衰期（zx_20260920 M5 记的"半衰期 ~18 小时"病根之一）。
  const UPDATED_AT_AS_AGE: Array<[string, RegExp]> = [
    ['dbTimeMs(x.updated_at)', /dbTimeMs\(\s*\w+\.updated_at\s*\)/],
    ['ageDaysSince(x.updated_at)', /ageDaysSince\(\s*\w+\.updated_at\s*\)/],
    ['decayFactor(…updated_at…)', /decayFactor\([^)]*\bupdated_at\b/],
  ];
  // ⚠ 「扫了个空」须配自证（本仓纪律）：先证扫描器**有牙**，再说本文件**零命中**。
  const updatedAtSample = 'const a = dbTimeMs(pk.updated_at);';
  ok(UPDATED_AT_AS_AGE.some(([, re]) => re.test(updatedAtSample))
    && !UPDATED_AT_AS_AGE.some(([, re]) => re.test(memAllSrc)),
    'D-3 ★★靶心反证（扫描器有牙 + 该不命中）：`updated_at` **不得**喂进任何年龄读数'
    + '（`dbTimeMs` / `ageDaysSince` / `decayFactor`）——该命中标本 `dbTimeMs(pk.updated_at)` 命中、'
    + '本文件零命中 ⇒ "年龄只认语义时间戳"是真做到，而不是没扫');

  // 就地钉**衰减那句 SELECT**：三语义列在场、`updated_at` 不在场（"取哪几列"是年龄基准的**另一半**——
  //   函数不读 `updated_at` 还不足够：若它被捞进候选行，任何一处换列都可能让年龄悄悄漂）。
  // zx_20260930 M8 就地订正（**改钉真源，非放宽**）：衰减那句 SELECT 的归档排除片段 M8 起改为
  //   插值 `MEM_LIVE_SQL`（一处真源，含 `deleted` 档），源码里不再有 `memory_type != 'archived'`。
  //   此处不再手抄新字面量，而是①断言该句插值了那个常量、②**把常量的语义就地自证**（含 `deleted`，
  //   且等价于"排除一切不可检索档"）——两件合起来才叫"同尺"，单靠字符串在场是够不着的。
  ok(MEM_LIVE_SQL.includes('deleted') && /NOT IN \('archived', 'deleted'\)/.test(MEM_LIVE_SQL),
    'D-3 前提：`MEM_LIVE_SQL` 语义在场（排除归档**与**墓碑两档，非只归档）', MEM_LIVE_SQL);
  const decaySel = (consSrc.match(/SELECT id, importance, memory_type,[\s\S]*?FROM wa_memories WHERE project_id = \? AND \$\{MEM_LIVE_SQL\}/) ?? [])[0] ?? '';
  ok(decaySel.includes('last_used_at') && decaySel.includes('last_reinforced_at') && decaySel.includes('created_at')
    && !decaySel.includes('updated_at'),
    'D-3 ★★衰减的**取数列**同尺：含三语义时间戳（`last_used_at`/`last_reinforced_at`/`created_at`）、'
    + '**不含** `updated_at`（若此式为空串即正则未命中 ⇒ 本条会**响亮判红**，不会假绿）',
    decaySel.slice(0, 96) + '…');

  // 年龄真源（`memory-decay.ts`）：`DecaySubject` **给不进** `updated_at`（类型层就拒绝），
  //   `memoryAgeDays` 的 `stamps` 数组恰是那三列 —— "不是碰巧没读"，而是**没有这个输入**。
  eq(/updated_at/.test((decaySrc.match(/export interface DecaySubject \{[\s\S]*?\n\}/) ?? [''])[0]), false,
    'D-3 ★★`DecaySubject` 里**无** `updated_at` 字段——未来谁想拿它当年龄，**编译期即红**（不是靠"记得别用"）');
  ok(/const stamps = \[mem\.last_used_at, mem\.last_reinforced_at, mem\.created_at\]/.test(decaySrc),
    'D-3 ★★`memoryAgeDays` 的 `stamps` 恰是**那三个**语义时间戳（顺序亦不改）——与上面 `DecaySubject` 一体两面');
  // 扫描面**按形状定**，不按变量名枚举（G-5）。旧判据把名字写成 `mem|r|row|m` 的白名单 ⇒
  //   `new Date(p.due_at)`（`getTriggeredProspective`/`scanDueProspective` 两处）**名不在册**就整条漏过。
  //   按形状即可穷尽：裸 `new Date(<某对象>.<属性>)` 一律命中；只放过两类**合法**写法——
  //   `new Date()`（取当下）与 `new Date(Date.now() ± …)`（把 `Date` 这个构造器本身排除，非排除 `*.now`）。
  const NAIVE_DATE_SHAPE = /new Date\(\s*(?!Date\s*\.\s*now\b)[A-Za-z_$][\w$]*\s*\.\s*[A-Za-z_$]/;
  ok(NAIVE_DATE_SHAPE.test('const t = new Date(p.due_at).getTime();')
    && !NAIVE_DATE_SHAPE.test('const w = new Date(Date.now() - 7 * 86400000);'),
    'D-3 自证（扫描器有牙）：该判据对「该命中」标本（`new Date(p.due_at)`——正是它放过的那两处的**形状**）'
    + '命中、对「该不命中」标本（`new Date(Date.now() - …)` 的合法窗口算术）不命中 ⇒ 下面那条不是"扫了个空"');
  ok(!NAIVE_DATE_SHAPE.test(memAllSrc),
    'D-3 ★★该不命中：本文件里**再无**裸 `new Date(<对象>.<列>)`（一把尺；扫描面按**形状**定、'
    + '不再按名枚举——旧判据 `mem|r|row|m` 就是这样把 `p.due_at` 两处整条放过）');
  ok(Number.isNaN(mmMod.dbTimeMs('')) && Number.isNaN(mmMod.dbTimeMs(null)),
    'D-3 自证：空串 / `null` 在 `dbTimeMs` 下是 `NaN` ⇒ 那三处三元/`||` 守卫**必须保留**'
    + '（`Math.max(NaN, x)` 与 `Math.max(0, x)` 结论不同，故只在"确实有值"那一支换尺，语义不变）');
  eq(mmMod.dbTimeMs('2026-09-27 12:00:00'), mmMod.dbTimeMs('2026-09-27T12:00:00Z'),
    'D-3 ★底尺自证：**生产落库形状**（无时区）与显式 `Z` 串标的是**同一时刻**——下面"两串读数相等"才立得住');

  const dbM = new DatabaseSync(':memory:') as unknown as AnyDb;
  dbM.exec(SCHEMA);                                                    // ① DDL
  const mem2 = new mmMod.MemoryManager(dbM, null) as unknown as {       // ② 先 `new`（构造里建 FTS 同步触发器）
    retrievalStrength: (m: unknown) => number;
    maturityOf: (m: unknown) => number;
    confidenceOf: (m: unknown) => number;
    search: (emb: number[], pid: string, topK?: number) => Array<{ id: string; score: number }>;
    getProjectKnowledge: (pid: string, limit?: number) => Array<{ id: string }>;
    retrieveByCue: (t: string, pid: string, topK?: number) => Array<{ id: string }>;
    sameSourceReplace: (p: string, s: string, c: string, r?: string) => string | null;
    storeText: (p: Record<string, unknown>) => string;
    promoteWorkingMemory: (t: string, p: string, ok: boolean) => number;
  };
  type Mem = Record<string, unknown>;
  const ins = (id: string, project: string, type: string, created: string, lastUsed: string | null, use: number,
    succ: number, ctx: string, content = `内容 ${id}`, emb: string | null = '[1,0]',
    updated: string | null = null): void => {
    dbM.prepare(`INSERT INTO wa_memories (id, project_id, task_id, content, embedding, memory_type, importance,
                 source, valence, context_json, use_count, success_count, created_at, last_used_at, updated_at)
                 VALUES (?,?,?,?,?,?,0.5,'agent_execution','neutral',?,?,?,?,?,?)`)
      .run(id, project, null, content, emb, type, ctx, use, succ, created, lastUsed, updated);
  };
  const get1 = (id: string) => dbM.prepare('SELECT * FROM wa_memories WHERE id = ?').get(id) as Mem;

  // ⚠ 标本时刻**由当前钟派生**、不写死日程：三条曲线都是"距今天数"的函数，写死某日的标本会随墙上时钟推移
  //   **双双饱和**（数月后无时区支与 Z 支都趋近同一极限 ⇒ `|a−c|` 塌到 0，判据按**日**引爆、又是一枚哑雷）。
  //   派生后"距今 2 天 / 2.5 天"恒定；形态仍是生产形状（`datetime('now')` 正是 UTC 无时区串）。
  const baseMs = Math.floor((Date.now() - 2 * 86_400_000) / 1000) * 1000; // 取整到秒，使 A/B 两支**严格同一时刻**
  const sqlUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const T_A = sqlUtc(baseMs);                        // 生产落库形状（UTC、无时区）
  const T_B = new Date(baseMs).toISOString();        // 同一时刻，显式 Z
  const T_C = sqlUtc(baseMs - 12 * 3_600_000);       // 差 12 小时的对照标本
  ins('tzA', 'p2', 'episodic', T_A, T_A, 3, 5, '{}');
  ins('tzB', 'p2', 'episodic', T_B, T_B, 3, 5, '{}');
  ins('tzC', 'p2', 'episodic', T_C, T_C, 3, 5, '{}');
  const tri = (f: (m: unknown) => number) => ['tzA', 'tzB', 'tzC'].map((id) => f(get1(id)));
  // ⚠ 三个读数**都要包一层箭头函数**再进循环：直接取方法引用会丢 `this`
  //   （`maturityOf` 内要 `this._processingDepthOf`），当场 `TypeError` ——夹具的错法必须自己先撞一遍。
  for (const [label, f, why] of [
    ['retrievalStrength', (m: unknown) => mem2.retrievalStrength(m), '读 `last_used_at`（τ=14 天，有效半衰期 τ·ln2≈9.7 天）'],
    ['maturityOf', (m: unknown) => mem2.maturityOf(m), '读 `created_at`（τ=21 天）'],
    ['confidenceOf', (m: unknown) => mem2.confidenceOf(m), '读 `memoryAgeDays`（三语义时间戳取最大，τ=30 天遗忘曲线）'],
  ] as Array<[string, (m: unknown) => number, string]>) {
    const [a, b, c] = tri(f);
    const db = Math.abs(a - b); // 同刻两写法之差（只该有两次 `Date.now()` 的微秒级抖动）
    const dc = Math.abs(a - c); // 跨 12 小时之差（旧实现错 8 小时 ⇒ 与原值同量级）
    // ⚠ 判据用**量级分离**而不是 `a === b`：三条读数内部都调 `Date.now()`，两次调用必隔微秒 ⇒ 逐位相等**不可能**。
    //   `===` 版是本判据的**首版**、已当场自撞：首跑恰落同一毫秒而绿、复跑差 3.8e-10 即红 —— 一枚"按钟引爆"的哑雷。
    ok(db * 100 < dc && dc > 1e-3,
      `D-3 ★★\`${label}\` 行为判据：**同一时刻的两种写法**（无时区 / 显式 Z）读数**相等**`
      + `（差比"跨 12 小时"的标本小两个数量级以上——残余只是两次 \`Date.now()\` 的微秒级抖动），而不同刻**不等**：`
      + `前者才是"按 UTC 解析"的指纹（旧实现下无时区串被当本地 ⇒ 凭空多 8 小时，读数与原串同量级地偏开）`,
      `${why} ⇒ ${a} / ${b} / ${c}（|a−b|=${db.toExponential(2)} · |a−c|=${dc.toExponential(2)}）`);
  }

  // ── D-4 四条排序路径**同一套**惩罚因子 ──
  // 批七后 `retrieveByCue` / `getProjectKnowledge` 在检索模块里改调自由函数（无 `this.` 前缀）——
  //   计数取两模块**之和**，仍要求各自恰 4 处（不放宽）。
  const apN = (mmSrc.match(/\* this\._applicabilityPenalty\(/g) ?? []).length
    + (retSrc.match(/\* applicabilityPenalty\(/g) ?? []).length;
  const cpN = (mmSrc.match(/\* this\._conflictPenalty\(/g) ?? []).length
    + (retSrc.match(/\* conflictPenalty\(/g) ?? []).length;
  eq([apN, cpN], [4, 4],
    'D-4 ★★四条排序路径**各乘两个惩罚因子**（`retrieveByType` / `search` / `retrieveByCue` / `getProjectKnowledge`）'
    + '——此前是 4 / 2 与 4 / 3 的错配："这条易变知识算不算数"由**它碰巧从哪条路被取回**决定');
  // ⚠ 四个**逐点**锚：`(r)` 出现两处（`retrieveByType` 的行内式 / `getProjectKnowledge` 的折行式），
  //   故四者一律以**行首缩进 + 参数名**合起来定形——计数相同但少一处就是"有一路在册不乘"。
  eq([/let s = raw \* this\._applicabilityPenalty\(r\) \* this\._conflictPenalty\(r\);/.test(mmSrc),
    /\n\s*\* this\._applicabilityPenalty\(row\) \* this\._conflictPenalty\(row\);/.test(mmSrc),
    /\n\s*\* applicabilityPenalty\(m\) \* conflictPenalty\(m\);/.test(retSrc),
    /\n\s*\* applicabilityPenalty\(r\) \* conflictPenalty\(r\);/.test(retSrc)],
  [true, true, true, true],
    'D-4 ★四处**逐点**在场（`retrieveByType` 行内 `r` / `search` 折行 `row` / `retrieveByCue` 折行 `m` / '
    + '`getProjectKnowledge` 折行 `r`）');

  const VOL = JSON.stringify({ applicability: { stability: 'volatile', conditions: ['部署到生产环境'] } });
  const CONF = JSON.stringify({ conflict_flag: true });
  // `search`：三行同 embedding / importance / use_count，**唯一**差别是 context_json；且易变与冲突那两行
  //   `created_at` **更晚**（旧实现下它们靠 `ORDER BY created_at DESC` 排在前面 ⇒ 次序会翻）
  //   ⚠ 单独占一个项目：`search` 的候选面是"本项目全部带 embedding 的记忆"，
  //     与 D-3 的 tz 行同项目就会被它们的高 `use_count` 挤掉 top3（**夹具的错法自己先撞过一遍**）。
  ins('mr-n', 'p4', 'episodic', '2026-09-28 00:00:00', null, 0, 0, '{}');
  ins('mr-v', 'p4', 'episodic', '2026-09-28 01:00:00', null, 0, 0, VOL);
  ins('mr-c', 'p4', 'episodic', '2026-09-28 02:00:00', null, 0, 0, CONF);
  const sr = mem2.search([1, 0], 'p4', 3);
  const scOf = (id: string) => sr.find((r) => r.id === id)?.score ?? NaN;
  eq(sr.map((r) => r.id), ['mr-n', 'mr-v', 'mr-c'],
    'D-4 ★★`search` 次序：**中性 → 易变 → 冲突**，尽管冲突行的 `created_at` 最新——'
    + '降权真上了这一路（旧实现下这一路一点不降，次序恰为倒过来的 `mr-c / mr-v / mr-n`）');
  ok(scOf('mr-v') === scOf('mr-n') * 0.95 && scOf('mr-c') === scOf('mr-n') * 0.6,
    'D-4 ★★且**乘子就是那两个数**（易变 ×0.95 / 冲突 ×0.6，与 `retrieveByType` 逐位同值）——'
    + '不是"看起来排后面了"：两个真值之比对得上才叫同一把尺',
    `${scOf('mr-n')} × 0.95 = ${scOf('mr-v')} / × 0.6 = ${scOf('mr-c')}`);
  // `getProjectKnowledge`：被取代（superseded）的那条 `updated_at` **最新**，仍须排最后
  ins('pk-n1', 'p2', 'semantic', '2026-09-27 00:00:00', null, 0, 0, '{}', '项目知识甲', '[1,0]', '2026-09-27 00:00:00');
  ins('pk-n2', 'p2', 'semantic', '2026-09-27 01:00:00', null, 0, 0, '{}', '项目知识乙', '[1,0]', '2026-09-27 01:00:00');
  ins('pk-sup', 'p2', 'semantic', '2026-09-28 00:00:00', null, 0, 0, JSON.stringify({ superseded: true }), '项目知识丙（已被取代）', '[1,0]', '2026-09-28 00:00:00');
  eq(mem2.getProjectKnowledge('p2', 3).map((r) => r.id), ['pk-n2', 'pk-n1', 'pk-sup'],
    'D-4 ★★`getProjectKnowledge` 次序：两条中性者按 `updated_at DESC` 在前、**被取代的那条（最新）排最后**'
    + '——旧实现下它按全值进段（"已被取代的语义"当权威注入），次序恰为 `pk-sup / pk-n2 / pk-n1`');
  // `retrieveByCue`：两条正文**逐字同形**（只差甲乙）、`created_at` 相同、`use_count`/`importance` 相同
  //   ⇒ 基分**逐位相等**，唯一能分开它们的恰是惩罚因子；易变者的 `updated_at` **更新**（旧实现下并列时按此排序，
  //   故旧次序恰为倒过来的 `cu-v / cu-n`）
  //   ⚠ 单独占一个项目 `p5`：`retrieveByCue` 的候选面是"本项目全部非归档记忆"，与 D-3 的 tz 行同项目会被挤掉 top2。
  const CUETXT = '部署到生产环境';
  ins('cu-n', 'p5', 'episodic', '2026-09-27 00:00:00', null, 0, 0, '{}', '部署到生产环境时的注意事项甲', '[1,0]', '2026-09-27 00:00:00');
  ins('cu-v', 'p5', 'episodic', '2026-09-27 00:00:00', null, 0, 0, VOL, '部署到生产环境时的注意事项乙', '[1,0]', '2026-09-28 00:00:00');
  const cue = mem2.retrieveByCue(CUETXT, 'p5', 2);
  eq(cue.map((r) => r.id), ['cu-n', 'cu-v'],
    'D-4 ★★`retrieveByCue` 同尺（两条正文都命中线索词、基分逐位相等）——唯一能分开它们的恰是惩罚因子：'
    + '旧实现下这一路不乘 `_applicabilityPenalty`，并列时 `updated_at` 更新的易变者排前面');

  // ── D-5 同源替换：一个源一行（新增两处写点复用的正是这条已被验证的尺） ──
  eq(mem2.sameSourceReplace('p3', 'acceptance_check', '首次'), null,
    'D-5 自证：源不存在时返回 `null`（=「这一源还没有过」而**不是失败**）——调用方据此才敢落新行');
  const id1 = mem2.storeText({ project_id: 'p3', type: 'acceptance_failure', content: '首条验收失败：要件 A 缺席', source: 'acceptance_check' });
  ok(typeof id1 === 'string' && id1.length > 0, 'D-5 自证：`storeText` 落库返 id（0→1 正面断言，不用"不抛"代替）', id1);
  const rid = mem2.sameSourceReplace('p3', 'acceptance_check', '第二条验收失败：要件 B 缺席');
  ok(typeof rid === 'string' && rid === id1,
    'D-5 ★★`acceptance_check` **确可被同源替换**且**命中同一行**——两条 `storeText` 的 source 都不是'
    + '`user_correction`/`user_instruction`（那两个是 `sameSourceReplace` 的免疫源）：'
    + '若误用免疫源，函数恒返 `null`，去重**静默失效**、行数照旧只增不减');
  eq(JSON.stringify(dbM.prepare("SELECT content FROM wa_memories WHERE project_id='p3' AND source='acceptance_check'").all()),
    JSON.stringify([{ content: '首条验收失败：要件 A 缺席' + '\n[更新]\n' + '第二条验收失败：要件 B 缺席' }]),
    'D-5 ★★落库**恰一行**，内容是"旧 + `\\n[更新]\\n` + 新"的追加（旧写法每失败一次**追加一行**，自家副本挤占自家 top3）');
  const n2 = mem2.sameSourceReplace('p3', 'acceptance_check', '第三条');
  eq([dbM.prepare("SELECT COUNT(*) AS n FROM wa_memories WHERE project_id='p3' AND source='acceptance_check'").get() as { n: number }].map((r) => r.n),
    [1], 'D-5 ★再替换一次仍**只有一行**（幂等：连失败三次不涨行数）', `第三次替换返回 ${n2 === 'string' || n2 ? 'id' : 'null'}`);
  dbM.prepare('INSERT INTO wa_tasks (id, project_id, title, context_json) VALUES (?,?,?,?)')
    .run('tD', 'p3', '沉淀任务', JSON.stringify({ working_memory: [{ content: '这是一条够长的关键工作笔记内容', ts: '2026-09-29T00:00:00Z' }] }));
  eq([mem2.promoteWorkingMemory('tD', 'p3', true), mem2.promoteWorkingMemory('tD', 'p3', true),
    (dbM.prepare("SELECT COUNT(*) AS n FROM wa_memories WHERE project_id='p3' AND source LIKE 'working_memory:%'").get() as { n: number }).n],
  [1, 1, 1],
    'D-5 ★既有生产调用方 `promoteWorkingMemory` 连跑两次仍**只一行**——新增的两处写点复用的正是这条**已被验证**的尺（不另立阈值）');

  const aSrc = RD(`${A}/src/main/core/jobs/ai-task.ts`);
  const eSrc = engineSrc();
  ok(/const replaced = ctx\.memory\.sameSourceReplace\(taskRow\.project_id, 'acceptance_check', content\);\s*\n\s*if \(!replaced\) \{/.test(eSrc)
    && /ctx\.memory\.storeText\(\{[\s\S]{0,160}?source: 'acceptance_check' \}\)/.test(eSrc),
    'D-5 ★交接：`agent-executor.ts` 的验收失败写点**先同源替换、未命中才落新行**（`if (!replaced)` 内才是 `storeText`）');
  eq([(aSrc.match(/if \(!memory\.sameSourceReplace\(/g) ?? []).length,
    (aSrc.match(/source: 'archetype_deviation' \}\)/g) ?? []).length,
    (aSrc.match(/type: 'archetype_correction'/g) ?? []).length],
  [2, 2, 2],
    'D-5 ★交接：`core/jobs/ai-task.ts` 的**两条完成出口**（ai-task 路 + resume 路）同形同数'
    + '——两条出口一把尺，漏一路就是"换个入口走就又涨一行"');
  ok(/if \(!memory\.sameSourceReplace\([^)]*\)\) \{[\s\S]{0,120}?memory\.storeText\(\{[\s\S]{0,200}?source: 'archetype_deviation' \}\)/.test(aSrc),
    'D-5 ★替换命中时**不落新行**（`storeText` 在 `if` 块内，不是无条件跟随）——否则"去重"只是多写一次的幌子');
  // ⚠ 如实登记的边界：`checkAcceptanceCriteria` 的写点**无法在受控回归里连跑两次**
  //   （其上半段的 LLM 判据要真模型；本套件无模型 ⇒ 该写点以**源码形状**取证，行为面由
  //   `acceptance_check` 源在真库上的**同一把尺**（上方 `sameSourceReplace` 行为断言）承担）。
}

// ══════════════════════════════════════════════════════════════════
// 【E】M5 调度：门认当下的子 · 悬空子得救 · 并发归一处
// ══════════════════════════════════════════════════════════════════
async function groupE(): Promise<void> {
  console.log('\n【E】M5 调度：门认当下的子 · 悬空子得救（收窄口径）· 并发归一处');
  const parse = (s: string): Record<string, unknown> | null => {
    try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; }
  };
  /** 建行助手：列名逐列对上 `database.ts` 的 `wa_tasks` DDL（不缺列、不放宽 NOT NULL）。 */
  const mkTask = (db: AnyDb) => (
    id: string, status: string, parent = '', ctx: Record<string, unknown> = {}, dependsOn = '',
  ): void => {
    db.prepare(
      "INSERT INTO wa_tasks (id, project_id, parent_task_id, title, description, status, depends_on, context_json) VALUES (?, 'p1', ?, ?, '', ?, ?, ?)",
    ).run(id, parent, `E-${id}`, status, dependsOn, JSON.stringify(ctx));
  };

  // ── E-1..E-5 `exit_plan_mode` 的门：钉的是「**有子**」而不是「有那两个状态里的子」 ──
  //   病根（§1.6）：`status IN ('pending','paused')` 计不出已 `executing`/`completed` 的子
  //   ⇒ 子确实存在却回「请先用 create_task 创建至少一个子任务」。此处正反两侧各钉一只真标本。
  {
    const db = mkdb();
    const ins = mkTask(db);
    const planTool = (taskId: string) => buildTools({ db } as never, taskId, 'p1', '/tmp') as unknown as {
      exit_plan_mode: { execute: (a: { plan_summary: string }) => Promise<string> };
    };

    // 该命中：**一个子都没有** ⇒ 仍须拒（门不是被整个拆掉）
    ins('ePlan0', 'planning');
    const r0 = parse(await planTool('ePlan0').exit_plan_mode.execute({ plan_summary: 'P' }));
    ok(typeof r0?.error === 'string' && r0.error.includes('请先用create_task创建至少一个子任务'),
      'E-1 ★该命中：无任何子任务时**确实仍拒**（治的是判据口径，不是把门拆掉）', String(r0?.error));

    // 该不命中：3 个子**全部 completed** —— 旧判据在此 count=0 ⇒ 误判
    ins('ePlan1', 'planning');
    for (const c of ['ePlan1a', 'ePlan1b', 'ePlan1c']) ins(c, 'completed', 'ePlan1');
    const r1 = parse(await planTool('ePlan1').exit_plan_mode.execute({ plan_summary: 'P1' }));
    ok(typeof r1?.error === 'undefined',
      'E-2 ★该不命中：子全为 `completed` 时**不再报**「请先创建子任务」（子确实存在，只是不在这两个状态里）', String(r1?.error ?? ''));
    eq([r1?.subtaskCount, r1?.startedCount], [3, 0],
      'E-3 同一件事两个数：`subtaskCount` 数**存在**的子（3）、`startedCount` 数**此刻待派发**的子（0）——两个问题两个数，不混');
    ok(db.prepare("SELECT status FROM wa_tasks WHERE id = 'ePlan1'").get()!.status === 'pending',
      'E-4 出口仍把父任务从 `planning` 推入 `pending`（门放宽没有顺带废掉出口本身）');

    // 该不命中 + 待派发另判仍在：1 个 completed + 1 个 pending 无前置 ⇒ startedCount=1 **且真有作业落库**
    ins('ePlan2', 'planning');
    ins('ePlan2a', 'completed', 'ePlan2');
    ins('ePlan2b', 'pending', 'ePlan2');
    const r2 = parse(await planTool('ePlan2').exit_plan_mode.execute({ plan_summary: 'P2' }));
    eq([r2?.subtaskCount, r2?.startedCount], [2, 1],
      'E-5 「是否有待派发的子」**另判**仍在（`subtaskCount` 2 / `startedCount` 1）——两个数不是同一个数的两次抄写');
    const jobRow = db.prepare(
      "SELECT type, payload FROM wa_jobs WHERE json_extract(payload, '$.taskId') = 'ePlan2b'",
    ).get() as { type: string; payload: string } | undefined;
    ok(jobRow?.type === 'ai-task',
      'E-6 ★0→1 正面断言：待派发的那个子**真落了作业行**（不是"没抛就算派了"）', String(jobRow?.type));
  }

  // ── E-7..E-14 `reconcileStalledSubtasks` 补「悬空 pending 子」支（**收窄口径**，见 §2.9-M5） ──
  //   派发四处同时成立：① 子 pending ② 子无在途作业 ③ 父 paused ④ 父的因由属**被打断**集。
  //   ④ 是**有意收窄**：A2（`chainStalled`）明写「防用户暂停后依赖链又自动执行」⇒ 用户在停的父，
  //   其后代**不得**被后台自愈悄悄拉起；等用户回话/等子完成的父同理（父自己会回来派子）。
  {
    const db = mkdb();
    const ins = mkTask(db);
    const J = (pauseReason: string) => ({ pause_reason: pauseReason });

    // 该命中：父**因自身执行被打断而停**（planning_timeout）⇒ 其无前置子该被救
    ins('eP_ok', 'paused', '', J('planning_timeout'));
    ins('eC_ok', 'pending', 'eP_ok');
    // 该命中第二只：exec_timeout 同属被打断集（证明判据是**集合**，不是只认一个值）
    ins('eP_exec', 'paused', '', J('exec_timeout'));
    ins('eC_dead', 'pending', 'eP_exec', {}, 'eDep_failed');

    // 该不命中①：用户在停 —— A2 本意
    ins('eP_user', 'paused', '', J('user_interrupt'));
    ins('eC_user', 'pending', 'eP_user');
    // 该不命中②：等用户回话 —— 用户一回话父就自会恢复并派子
    ins('eP_await', 'paused', '', J('awaiting_input'));
    ins('eC_await', 'pending', 'eP_await');
    // 该不命中③：等子完成 —— `scanReadyTasks` 已在拉，再派一次就是**重复派发**
    ins('eP_ci', 'paused', '', J('children_incomplete'));
    ins('eC_ci', 'pending', 'eP_ci');
    // 该不命中④：子有在途作业 —— 排队中也是出路
    ins('eC_job', 'pending', 'eP_exec');
    db.prepare("INSERT INTO wa_jobs (id, type, payload, status) VALUES ('eJ1', 'ai-task', ?, 'pending')")
      .run(JSON.stringify({ taskId: 'eC_job' }));
    // 该不命中⑤：子有前置未完成（waiting）—— 等待是对的，不是悬挂
    ins('eDep_run', 'executing');
    ins('eC_wait', 'pending', 'eP_exec', {}, 'eDep_run');
    // 该不命中⑥：父根本没停（executing）
    ins('eP_run', 'executing');
    ins('eC_run', 'pending', 'eP_run');

    // 前置标本：一个真 failed（供 eC_dead 判 dead）
    ins('eDep_failed', 'failed');

    const st = (id: string): string | undefined =>
      (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status?: string } | undefined)?.status;

    const res = reconcileStalledSubtasks(db as never);

    eq(res.dispatched, ['eC_ok'],
      'E-7 ★悬空子**确实被派发**且**只派该派的那个**（被打断集命中 1 条；六只该不命中的一只都没被派）');
    const dJob = db.prepare(
      "SELECT type, payload FROM wa_jobs WHERE json_extract(payload, '$.taskId') = 'eC_ok'",
    ).get() as { type: string; payload: string } | undefined;
    ok(dJob?.type === 'ai-task',
      'E-8 ★0→1 正面断言：派发**真落了作业行**（自愈监视器走的是 `enqueueJob` 同一入口，不是"标了个内存标志")',
      String(dJob?.type));
    eq([st('eC_user'), st('eC_await'), st('eC_ci'), st('eC_job'), st('eC_wait'), st('eC_run')],
      ['pending', 'pending', 'pending', 'pending', 'pending', 'pending'],
      'E-9 ★六只该不命中的**一只都没被冒派**（A2「用户在停」/ 等回话 / 等子 / 有在途作业 / 前置未完成 / 父未停）');
    eq(res.reconciled, ['eC_dead'], 'E-10 既有那条「前置 dead ⇒ 标 failed」**原样仍在**（本轮只加一支，不动老支）');
    eq(st('eC_dead'), 'failed', 'E-11 且**真落了终态**（`markTaskFailed` 的 CAS 放行）');

    // 判据形状：被打断集是**一个具名常量**，且用户在中止**不在**集内（两侧同钉 ⇒ 常量被改宽即红）
    const shSrc = RD(`${A}/src/main/core/self-healing-monitor.ts`);
    ok(/export const PARENT_INTERRUPTED_PAUSE_REASONS/.test(shSrc)
      && shSrc.includes('PAUSE_REASON_PLANNING_TIMEOUT')
      && !/PARENT_INTERRUPTED_PAUSE_REASONS[\s\S]{0,400}?PAUSE_REASON_USER_INTERRUPT/.test(shSrc),
      'E-12 ★「被打断集」是一个具名常量，且 `user_interrupt` **不在**其中——宽窄两侧同钉，改宽即红');
    ok(shSrc.includes('const depState = classifyDep(') && shSrc.includes('depBlocksRun(depState)'),
      'E-13 ★派发判据**复用**既有 `classifyDep`/`depBlocksRun`（本仓 G-1：不新造第二份「前置能不能跑」）'
      + '——且两处**同读一个 `depState`**（不是各算一遍，两把尺在文件内就已分家）；'
      + '同时老支的 `depState !== \'dead\'` 也读同一份，故"打不打得开"只有一个答案');
  }

  // ── E-14..E-18 并发归一处：一个函数、一份状态集、一处默认值 ──
  {
    const db = mkdb();
    const ins = mkTask(db);
    const acc = await import('../apps/worker-ant-desktop/src/main/core/task-accounting.js') as unknown as {
      resolveProjectConcurrency: (db: unknown, projectId: string, opts?: { now?: Date }) => { limit: number; running: number; available: number };
      PROJECT_CONCURRENCY_DEFAULT: number;
      PROJECT_RUNNING_STATUSES: readonly string[];
      JOB_BATCH_SIZE: number;
    };

    // 无 rhythm ⇒ 取默认；且**三个占位状态都算**（旧软闸只数 executing ⇒ 少算 ⇒ 超发）
    ins('eQ1', 'executing');
    ins('eQ2', 'preparing');
    ins('eQ3', 'planning');
    ins('eQ4', 'pending');
    const c0 = acc.resolveProjectConcurrency(db as never, 'p1');
    eq([c0.limit, c0.running, c0.available], [acc.PROJECT_CONCURRENCY_DEFAULT, 3, acc.PROJECT_CONCURRENCY_DEFAULT - 3],
      'E-14 ★无 rhythm 时取默认，且 `preparing`/`planning` **也占位**（旧软闸只数 executing ⇒ 3 个占位只看见 1 个 ⇒ 超发）');

    // 有 rhythm ⇒ 取配置——但**先经档位天花板**（zx_20261005 M7 新尺）。两分标本（G-2，一侧放行一侧钳住）：
    //   · 无许可/无试用 ⇒ 社区版天花板 3 ⇒ 自配 5 被**钳到 3**（尺压过配置）
    //   · 试用中（＝专业版）⇒ 天花板 8 > 5 ⇒ 自配 5 **原样生效**
    //   墙钟钉死并注入（G-4：判据不得依赖真实墙钟；试用剩余天数天天变）。
    db.prepare("UPDATE wa_projects SET context_json = ? WHERE id = 'p1'").run(JSON.stringify({ rhythm: { maxConcurrency: 5 } }));
    eq(acc.resolveProjectConcurrency(db as never, 'p1').limit, 3,
      'E-15a ★无许可（社区版）⇒ 项目自配的 `rhythm.maxConcurrency`=5 被**档位天花板 3** 钳住'
      + '（改前此处是 5——那时没有"档位"这把尺，项目想开多大开多大）');
    const RR_NOW = new Date('2026-10-05T00:00:00.000Z');
    db.prepare("INSERT OR REPLACE INTO wa_settings (key,value) VALUES ('license.trial_started_at', ?)")
      .run(new Date(RR_NOW.getTime() - 3_600_000).toISOString()); // 1 小时前起算 ⇒ 试用第 1 天
    eq(acc.resolveProjectConcurrency(db as never, 'p1', { now: RR_NOW }).limit, 5,
      'E-15b ★专业版（试用中）⇒ **同一**自配 5 原样生效（天花板 8 > 5，只降不升里取小者=5）'
      + '——「项目声明的上限在真正拦人的那道闸上生效」这条旧义**未被削弱**，只是多了一层档位前提');

    // 硬闸与软闸**同一份状态集**（同一个概念不许两把尺）
    ok(JSON.stringify([...acc.PROJECT_RUNNING_STATUSES]) === JSON.stringify(['executing', 'preparing', 'planning']),
      'E-16 状态集是**具名导出的一处真源**（不是两处各写一串字面量）', JSON.stringify(acc.PROJECT_RUNNING_STATUSES));
    const schedSrc = RD(`${A}/src/main/core/task-scheduler.ts`);
    const aiSrc = RD(`${A}/src/main/core/jobs/ai-task.ts`);
    ok(schedSrc.includes('resolveProjectConcurrency(this.db') && aiSrc.includes('resolveProjectConcurrency(db'),
      'E-17 ★**两处调用点**都改调同一个函数（软闸 `task-scheduler.ts` + 硬闸 `jobs/ai-task.ts`）');
    ok(/const batch = jobs\.slice\(0, JOB_BATCH_SIZE\)/.test(schedSrc) && acc.JOB_BATCH_SIZE === 5,
      'E-18 `processPending` 的批大小也是同模块的具名常量（它**不是**项目并发，数值不动、只归一处）');

    // `this.pending` 两套键归一一：键恒为 taskId（无 taskId 才退回作业 id），jobId 进值里供写库
    ok(schedSrc.includes('private pendingKey(') && schedSrc.includes('this.pending.set(key, job)'),
      'E-19 ★`pending` 的键**只有一种**（`scanReadyTasks` 以 taskId 入、`enqueue`/`start` 也归一）'
      + '——此前两套键 ⇒ 同任务两键同批，靠 CAS 兜底');
    ok(/jobId\?: string/.test(schedSrc) && schedSrc.includes('const jobId = (job as'),
      'E-20 `jobId` 落在**值**里：`wa_jobs` 的两处 UPDATE 因此不再对不存在的行空转');
  }

  // ── E-21/E-22 时间基准：`project-engine.ts` 的裸 `new Date(updated_at)` 归到 `dbTimeMs` ──
  {
    const peRaw = RD(`${A}/src/main/core/project-engine.ts`);
    ok(/let activityMs = p\.updated_at \? dbTimeMs\(p\.updated_at as string\) : 0;/.test(peRaw),
      'E-21 ★`project-engine.ts` 的 `updated_at` 走**带时区基准**的解析（DB 时刻串是无时区 UTC，裸 `new Date()` 按本地读 ⇒ 凭空多 8 小时）');
    ok(!/new Date\(p\.updated_at/.test(peRaw),
      'E-21b 反证：该处裸 `new Date(<对象>.<列>)` 已除（同一形状扫面内零命中）');
    const mm = await import('../apps/worker-ant-desktop/src/main/core/memory-manager.js') as unknown as {
      dbTimeMs: (s: string | null) => number;
    };
    // 该判据**有区分度**：同一串「库时刻」按 UTC 读与按本地读的差 = 本机时区偏移。
    //   ⚠ 不写死 8 小时——那会让判据在 TZ=UTC 的机器上假红（判据不得依赖环境，本仓既有教训）。
    const dbStr = '2026-09-29 02:00:00';
    const shift = Math.abs(new Date().getTimezoneOffset() * 60_000);
    ok(Math.abs(mm.dbTimeMs(dbStr) - new Date(dbStr).getTime()) === shift,
      'E-22 两种读法**确实可分**（差值 = 本机时区偏移；本机若为 UTC 则两种情况同值，判据双向都成立）',
      `${mm.dbTimeMs(dbStr)} vs ${new Date(dbStr).getTime()} · 偏移 ${shift / 3_600_000}h`);
  }
}

// ══════════════════════════════════════════════════════════════════
// 【F】M6 模型：换完再回验 · 降级如实 · 词表收敛
// ══════════════════════════════════════════════════════════════════
/** 必然连不上的端点：探活 `fetch` **确定性地**快速失败（不依赖真实网络，也不 sleep）。 */
const DEAD_URL = 'http://127.0.0.1:1';

/** 一份合法的 ANS `getOptimalModel` 回包（与 `optimal-model.ts` 的 `OptimalModelSuccess` 同形）。 */
const okPayload = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'm-primary', model_name: 'primary-model', url: DEAD_URL, api_key: 'k1',
  max_output_tokens: 4096, context_window: 128_000,
  input_price_per_1k: 0.001, output_price_per_1k: 0.002,
  capabilities: ['chat', 'function-calling', 'streaming'],
  sameProviderFallback: null, crossProviderFallback: null, fallback: null,
  ...o,
});

/** 跑一次**生产** `selectModelForTask`，连同它落下的会话行一起取回（"账"是本组的主要取证）。 */
async function pick(o: {
  db: AnyDb; payload: Record<string, unknown>; taskCtxJson?: string; taskId?: string;
}): Promise<{ thrown: string | null; modelResult: Record<string, unknown> | null; conv: string[] }> {
  const taskId = o.taskId || 't-f';
  const rows = (): string[] =>
    (o.db.prepare('SELECT content FROM wa_task_conversations WHERE task_id = ? ORDER BY created_at, rowid').all(taskId) as Array<{ content: string }>)
      .map((r) => r.content);
  try {
    const r = await selectModelForTask({
      db: o.db as never,
      taskId,
      projectId: 'p1',
      taskCtxJson: o.taskCtxJson || '{}',
      ansClient: { getOptimalModel: async () => o.payload } as never,
      archetype: 'conversation' as never,
      modelStrategy: 'cost-optimal',
    });
    return { thrown: null, modelResult: 'modelResult' in r ? r.modelResult : null, conv: rows() };
  } catch (e) {
    return { thrown: (e as Error).message, modelResult: null, conv: rows() };
  }
}

async function groupF(): Promise<void> {
  console.log('\n【F】M6 模型：换完再回验（分路处理）· 降级如实 · 词表收敛到单源');

  // 能力需求：`deriveModelCapabilities('conversation', {hasMedia:false})` = ['chat','function-calling']。
  //   本组**不**写死这个值——下面每条都先自证"需求是从生产函数派生的"，免得日后底线能力一变判据静默失效。
  const mr0 = await import('../apps/worker-ant-desktop/src/main/core/model-request.js');
  const demand = mr0.deriveModelCapabilities('conversation' as never, { hasMedia: false });
  ok(demand.length > 0 && JSON.stringify(demand) === JSON.stringify([...mr0.BASE_MODEL_CAPABILITIES]),
    'F-0 扫描面自证：本组所用的"需求能力"**取自生产** `deriveModelCapabilities`（非写死），且 `conversation` 形态只含底线能力',
    `demand=[${demand.join(',')}]`);

  // ── F-1 **降级路**换完再回验：不符 ⇒ 如实抛出（用户裁定「分路处理」） ──
  {
    const db = mkdb();
    const r = await pick({
      db, payload: okPayload(),
      taskCtxJson: JSON.stringify({ sdk_fallback: { url: DEAD_URL, api_key: 'k2', model_name: 'tiny-model', capabilities: ['chat'] } }),
    });
    ok(r.thrown !== null && r.thrown.includes('缺本任务所需能力'),
      'F-1 ★「换完再回验」在**降级路上真跑到了**：`sdk_fallback` 缺能力 ⇒ **如实抛出**'
      + '（该支本就在"账户级故障"的降级路上，备用也不合格 = 没有可用模型，与"零命中即抛"同一把尺）',
      `thrown=${JSON.stringify(r.thrown)}`);
    ok(r.conv.some((c) => c.startsWith('[选型失败]')) && !r.conv.some((c) => c.includes('[降级通知]')),
      'F-1b 抛出**同时**账上留痕（`[选型失败]` 行），且**没有** `[降级通知]`——没换过去就不许说"已切换"'
      + '（若这条判据只断言"抛了"，就抓不住"账上却说已切换"的假话）',
      `conv=${JSON.stringify(r.conv)}`);
  }

  // ── F-2 键缺席 = 无从比对（存量旧账不因本批突然失败）+ 账随人走 ──
  {
    const db = mkdb();
    const r = await pick({
      db, payload: okPayload(),
      taskCtxJson: JSON.stringify({ sdk_fallback: { url: DEAD_URL, api_key: 'k2', model_name: 'legacy-model' } }),
    });
    ok(r.thrown === null && r.modelResult?.model_name === 'legacy-model',
      'F-2 **键缺席**（旧 ANS / 旧账写的 `sdk_fallback`）= 无从比对 ⇒ **不编"不符"**、照换不抛'
      + '（新判据不得把存量任务一次性判死）',
      `thrown=${JSON.stringify(r.thrown)} / model=${JSON.stringify(r.modelResult?.model_name)}`);
    ok(r.modelResult !== null && !('capabilities' in r.modelResult),
      'F-2b ★**账随人走**：换过去的那一跳没有清单 ⇒ `capabilities` **键被删**（"说不出具备什么"），'
      + '而不是留着**旧模型**的答案冒名顶替',
      `hasCapabilities=${r.modelResult ? 'capabilities' in r.modelResult : 'n/a'}`);
  }

  // ── F-3 三态语义（缺 / 空 / 无从比对）——同一判定式上两只标本**结果不同** ──
  {
    const empty = mr0.compareModelCapabilities(demand, { capabilities: [] });
    const absent = mr0.compareModelCapabilities(demand, {});
    ok(empty !== null && JSON.stringify(empty.missing) === JSON.stringify(demand),
      'F-3 ★`capabilities: []` = **如实报空**（空清单答不出需求 ⇒ `missing` = 全部需求），**不是**"无从比对"',
      `missing=${JSON.stringify(empty?.missing)}`);
    ok(absent === null,
      'F-3b **键缺席** = `null`（无从比对）。两只标本在同一判定式上**结论不同** ⇒ 本组不是在自我印证',
      `absent=${JSON.stringify(absent)}`);
  }

  // ── F-4 相符 ⇒ 换过去，且账跟着换 ──
  {
    const db = mkdb();
    const r = await pick({
      db, payload: okPayload(),
      taskCtxJson: JSON.stringify({ sdk_fallback: { url: DEAD_URL, api_key: 'k2', model_name: 'good-model', capabilities: ['chat', 'function-calling'] } }),
    });
    ok(r.thrown === null && r.modelResult?.model_name === 'good-model'
      && JSON.stringify(r.modelResult?.capabilities) === JSON.stringify(['chat', 'function-calling']),
      'F-4 备用**具备**所要能力 ⇒ 换过去、不抛，且回包里的 `capabilities` 已是**实际在用**那一跳的清单',
      `model=${JSON.stringify(r.modelResult?.model_name)} / caps=${JSON.stringify(r.modelResult?.capabilities)}`);
  }

  // ── F-5/F-6 context<64K 的**纯优化支**（裁定：不符 ⇒ 放弃升级、保留原模型、不抛） ──
  const live = await startAnsStub([]);   // 任何路径都回 200 ⇒ `checkHealth` 通过
  try {
    {
      const db = mkdb();
      const r = await pick({
        db,
        payload: okPayload({
          url: live.url, context_window: 32_000,
          crossProviderFallback: { url: live.url, api_key: 'k3', model_name: 'big-window-nochat', context_window: 200_000, capabilities: ['embedding'] },
        }),
      });
      ok(r.thrown === null && r.modelResult?.model_name === 'primary-model',
        'F-5 ★**纯优化支**：窗口更大的备选**缺能力** ⇒ **放弃升级、保留原模型、不抛**'
        + '（与 F-1 的降级路"如实抛出"**不同尺**——这条升级只是"更好"，没理由把可选优化升级成整轮失败）',
        `model=${JSON.stringify(r.modelResult?.model_name)}`);
      ok(r.conv.some((c) => c.startsWith('[升级放弃]')) && !r.conv.some((c) => c.includes('[降级通知]')),
        'F-5b 放弃升级有**单独一句话**（`[升级放弃]`）且**不冒充**降级通知——两件事两句话',
        `conv=${JSON.stringify(r.conv)}`);
    }
    {
      const db = mkdb();
      const r = await pick({
        db,
        payload: okPayload({
          url: live.url, context_window: 32_000,
          crossProviderFallback: { url: live.url, api_key: 'k3', model_name: 'big-ok', context_window: 200_000, capabilities: ['chat', 'function-calling'] },
        }),
      });
      ok(r.thrown === null && r.modelResult?.model_name === 'big-ok'
        && JSON.stringify(r.modelResult?.capabilities) === JSON.stringify(['chat', 'function-calling']),
        'F-6 备选**合格**且在世（真起了一个本地 HTTP 服务，走的是生产 `fetch` 探活）⇒ 升级成立，账同样随人走',
        `model=${JSON.stringify(r.modelResult?.model_name)}`);
    }
  } finally {
    await live.close();
  }

  // ── F-7 M6-2：探活没过、且**一处备用都没有** ⇒ 不得静默 ──
  {
    const db = mkdb();
    const r = await pick({ db, payload: okPayload() });   // 主端点 DEAD，三跳全 null
    const notif = r.conv.find((c) => c.includes('[降级通知]')) || '';
    ok(r.thrown === null && r.modelResult?.model_name === 'primary-model',
      'F-7 探活未过又无处可换 ⇒ **仍按原端点继续**（不抛：这是可用性问题，不是"没有模型"）',
      `model=${JSON.stringify(r.modelResult?.model_name)}`);
    ok(notif.includes('无可用备用') && notif.includes('仍按') && notif.includes('未通过不等同于端点已死'),
      'F-7b ★**静默被消除**：有回执、说明真因（无备用），且**不把话说过头**'
      + '（探活打的是 `<url>/models`，"未通过"≠"端点已死"——不少网关不实现该路径）',
      `notif=${JSON.stringify(notif)}`);
    ok(!notif.includes('已切换至'),
      'F-7c 没换端点就**不许**说"已切换"（此前文案只有一种，两种情况共用 ⇒ 说必有一句是假话）',
      `含"已切换至"=${notif.includes('已切换至')}`);
  }

  // ── F-8 M6-3：词表**单源**（renderer 不在 `src/main` 扫描面内，故这一条是它唯一的机检） ──
  {
    const modelsSrc = RD('packages/shared-types/src/models.ts');
    const rendererSrc = RD(`${A}/renderer/src/pages/ModelsPage.tsx`);
    const TABLE_ENTRY = /\{\s*value:\s*'[a-z-]+',\s*label:\s*'/;
    ok(!TABLE_ENTRY.test(rendererSrc) && rendererSrc.includes('packages/shared-types/src/models.js'),
      'F-8 模型页**没有第二份词表**（旧手抄表的条目形状零命中），且它**引真源**'
      + '——于是 `audio` 的 label/desc **由构造**即等于真源，比"两处各存一份再逐字比"更强',
      `表条目形状=${TABLE_ENTRY.test(rendererSrc)} / 引真源=${rendererSrc.includes('packages/shared-types/src/models.js')}`);
    const shown = "const CAPABILITIES = [\n  { value: 'chat', label: '对话', desc: 'x' },\n];";
    ok(TABLE_ENTRY.test(shown),
      'F-8b 反证标本：同一判定式喂一段**手抄表**片断 ⇒ 判得出（故"零命中"不是"判定式从不报"）');
    ok(!rendererSrc.includes("'translation'") && !/pattern:\s*\/[^/]*whisper[^/]*\//i.test(rendererSrc),
      'F-8c 模型页**没有第二份表**：手抄表条目里的 `translation` 字面量与 renderer 自带的 `whisper|tts` 规则**都不在**'
      + '（★zx_20260930 M15-⑦ 订正措辞：`translation` 已进真源、**不再是"幽灵能力"**；本句仍成立且仍必要——'
      + '它钉的是"第二份表不在"，与"这个值合不合法"是两件事）',
      `translation字面量=${rendererSrc.includes("'translation'")} / whisper规则=${/pattern:\s*\/[^/]*whisper[^/]*\//i.test(rendererSrc)}`);
    // zx_20261008_1：原判据写死 `'mistral':`（**带引号的键**）——那是"当时源码怎么写的"这一偶然形态，
    //   非本判据本意（本意＝真源里有 `mistral` 这条供应商）。prettier 的 `quoteProps: as-needed` 去掉
    //   可省的对象键引号 ⇒ 判据报成"真源没有 mistral"（假红）。改为**格式无关**：行首锚点 + 引号可省
    //   + `\s*`（与本脚本 F-8/F-9 旁既有判据同风格）。加 `^` 锚点比原 `includes` **更严**（要求键在行首）。
    const MISTRAL_KEY = /^\s*['"]?mistral['"]?\s*:/m;
    ok(MISTRAL_KEY.test(modelsSrc),
      'F-8d 合并取**并集**：`mistral` 已并入真源（旧手抄表有、真源没有的那一个）——收敛不是"删掉一边"',
      `真源含 mistral=${MISTRAL_KEY.test(modelsSrc)}`);
  }

  // ── F-9 M6-3：「首个命中者胜」的**次序契约**——用真名试，而不是数行号 ──
  {
    const hints = MODEL_NAME_CAPABILITY_HINTS;
    const noTip = hints.filter((h) => typeof h.tip !== 'string' || !h.tip.trim());
    ok(hints.length >= 20 && noTip.length === 0,
      'F-9 扫描面自证：真源规则条数 ≥20 且**每条都有非空 `tip`**（`tip` 是必填——缺了 renderer 会印出"undefined（*建议能力）"）',
      `${hints.length} 条 · 缺 tip ${noTip.length} 条`);
    const r1 = hints.find((h) => h.pattern.test('deepseek-r1'));
    ok(r1 !== undefined && !r1.add.includes('function-calling') && !r1.add.includes('structured_output'),
      'F-9b ★次序契约**真的成立**（行为判定，非数行号）：`deepseek-r1` 命中**具体规则**而非后面那条泛化 `/deepseek/i`'
      + '——`add` 里没有 `function-calling`（本机真库两行标本同向：`deepseek-r1`=["reasoning","streaming"]、'
      + '`deepseek-r1:14b`=["chat","code"]，**都没有** `function-calling`）',
      `命中 tip=${JSON.stringify(r1?.tip)} / add=[${r1?.add.join(',')}]`);
    const misses = ['qwen3.5:9b', 'qwen3-omni-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-coder-v2:16b']
      .filter((n) => !hints.some((h) => h.pattern.test(n)));
    ok(misses.length === 0,
      'F-9c ★**本机真库在册名全都有规则兜得住**——此前真源一份都兜不住这几条（只有 renderer 那份手抄泛化规则兜得住）'
      + '，即真源当时**零生产读者**：改它就是改一份没人走的表',
      misses.length ? `零命中：${misses.join(', ')}` : '5/5 命中');
    ok(PROVIDER_CAPABILITY_HINTS.openrouter !== undefined && PROVIDER_CAPABILITY_HINTS.mistral !== undefined,
      'F-9d 供应商表并集：`openrouter`（真源有、手抄没有）与 `mistral`（手抄有、真源没有）**两边都在册**');
  }

  // ── F-10 产物核对：源码里有 ≠ 发到用户机器上（"引了" ≠ "打包器没摇树掉"） ──
  {
    const assets = path.join(root, A, 'renderer/dist/assets');
    const chunks = fs.existsSync(assets)
      ? fs.readdirSync(assets).filter((f) => f.startsWith('ModelsPage') && f.endsWith('.js'))
      : [];
    if (chunks.length > 0) {
      const bundled = chunks.map((f) => fs.readFileSync(path.join(assets, f), 'utf-8')).join('\n');
      // ⚠ 搜**中文串**：minify 会改标识符，搜标识符只会得到假"陈旧"。
      //
      // ★zx_20260930 M15-⑦ **就地订正（改钉更强的新真源，非放宽）**：原句用「**不含**『翻译』」当
      //   "产物里没有第二份表的残留"的**替身**。该替身的前提是「`translation` 不在真源」；而 M15-⑦
      //   把 `translation` 立为真源**第 11 值**（依据=**活库实有**：`ans_ai_models` 里 `qwen3.5:9b`
      //   的 `capabilities` 含 `translation`，不给它则 GUI 一编辑该模型就被 `validateCapabilities`
      //   误拒 ⇒ 违「判据须能被合法数据满足」）。前提一倒，替身即成**合法值** ⇒ 原句必假。
      //   订正为**由真源派生**：真源里**每一个 label** 都必须在产物里（少一个即"发到用户机器上的那份陈旧"）
      //   ——严格强于原句（真源每增一值自动收紧）。"无第二份表"那条轴仍由 F-8/F-8b/F-8c 在
      //   **源码层**（第二份表真正会住的地方）钉住，不留空档。
      const allLabels = Object.values(MODEL_CAPABILITY_META).map((m) => m.label);
      const missingLabels = allLabels.filter((l) => !bundled.includes(l));
      // 自证非空：`allLabels` 若因真源改名/被清空而为 `[]`，`missingLabels` 也是 `[]` ⇒ 空转通过。
      ok(allLabels.length > 0
        && bundled.includes(mr0KindSemantics()) && missingLabels.length === 0 && bundled.includes('openrouter'),
        'F-10 构建产物（minify 后）**含**真源语义句 + `openrouter` + **真源全部 ' + allLabels.length + ' 个 label**'
        + '——只有产物里真在，才算"发到用户机器上的那份是单源的"（★订正：由真源派生，缺 label 即陈旧）',
        `chunk=${chunks.join(',')} · 缺 label=${missingLabels.join('/') || '无'}`);
    } else {
      console.log('  · F-10 注：renderer 产物不在位，**如实跳过**（不记为通过）——先跑 `pnpm --filter @worker-ant/desktop-renderer build`');
    }
  }
}

/**
 * 只保留**代码行**（整行以 `//` / `*` / `/*` 开头的丢弃）。
 *
 * 为什么需要：本轮把"静默截断"从实现里摘了，但**台账（注释）里还记着旧写法**——「此前
 * `text.slice(0, 4000)` 静默截断」。反证若拿字面量全文搜，**订正注释会自己把判据判红**，
 * 而唯一"解法"是把注释删掉（于是读不出"为什么改"）——本仓 zx_20260916_1 的老教训正是
 * 「负面子串断言会被订正注释自己判红，须断言真相在场」。反证要证的是「**实现里**没有」，
 * 故按"整行是不是注释"分辨，而非按"字面量出没出现"分辨。
 *
 * 这**不是** G-5 禁的那种"全文件去注释"：那种正则会因源码里一个裸 `/*` 吞掉大段代码且
 * **不报错**（本仓已发生过一次，47.4 万 → 33.5 万字符）。这里逐行判定，**任何带代码的行原样保留**；
 * 每条用到它的断言都另配"扫描面非空"自证（「扫了个空」须自证扫到东西）。
 */
function codeLines(src: string): string[] {
  return src.split('\n').filter((l) => {
    const t = l.trimStart();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  });
}

// ══════════════════════════════════════════════════════════════════
// 【G】M7 GUI：一个数一个值（第二落点）
// ══════════════════════════════════════════════════════════════════
function groupG(): void {
  console.log('\n【G】M7 GUI：一个数一个值（第二落点）');
  const R = (rel: string) => RD(`${A}/renderer/src/${rel}`);
  const view = R('lib/deliverable-view.ts');
  const dpage = R('pages/DeliverablesPage.tsx');
  const drawer = R('components/DeliverableDrawer.tsx');
  const apage = R('pages/A2aPage.tsx');

  // G-1 「换算只有一处实现」：真源内恰一份，两个渲染点都只是**调用**（G-3：计数类正面断言）
  eq((view.match(/function versionSizeText\(/g) ?? []).length, 1,
    'G-1 大小换算 `versionSizeText` 在共享真源内**恰一份实现**');
  const dpageCalls = (dpage.match(/versionSizeText\(/g) ?? []).length;
  const drawerCalls = (drawer.match(/versionSizeText\(/g) ?? []).length;
  ok(dpageCalls >= 2, 'G-1 列表页**两个**渲染点（版本行 + 选中版本）都调它，不各自再写一份', `列表 ${dpageCalls} 处`);
  ok(drawerCalls >= 1, 'G-1 抽屉版本行亦调它（此前自行 `/1024` 把库内字符数当字节）', `抽屉 ${drawerCalls} 处`);
  // 反证：两个渲染点不得再出现**版本大小**的本地换算（`/1024` 只许出现在真源里做版本大小那一处）。
  //   ⚠ 判据已按裁定**收窄**：抽屉里 `((img.limit||0)/1024/1024)` 是**内联图片上限**（主进程读盘给的
  //   字节闸），与"版本大小"是两个概念——方案 §2.9-M7 §4-14 已裁定把它并进来属**判据过宽**。
  //   故按**这一行在算谁**分辨（行内出现 `img.limit`/`img.size` 即非版本大小），而不按"出现过 /1024 没有"分辨；
  //   紧接一条自证保证被豁免的是**实在之物**，不是凭空开的口子。
  const localSizeConv = (src: string) =>
    src.split('\n').filter((l) => /\/\s*1024/.test(l)).filter((l) => !/img\.(limit|size)/.test(l));
  eq([...localSizeConv(dpage), ...localSizeConv(drawer)], [],
    'G-1 反证：列表/抽屉内无**版本大小**的本地 `…/1024…` 换算（有则"唯一真源"不成立）');
  ok(/img\.limit/.test(drawer),
    'G-1 自证：抽屉内确有**内联图片上限**换算（上条豁免的那处是实在之物，不是空想的豁免）');

  // G-2 词表只有一处定义，且含 M7 补的两项
  ok(/DELIVERABLE_TYPE_LABEL[\s\S]{0,240}?code\s*:/.test(view),
    'G-2 `DELIVERABLE_TYPE_LABEL` 定义在真源且含 `code`（此前成果页类型下拉手抄裸字面量）');
  ok(/DELIVERABLE_STATUS_LABEL[\s\S]{0,400}?failed\s*:/.test(view),
    'G-2 `DELIVERABLE_STATUS_LABEL` 含 `failed`（状态词表一处）');
  for (const [name, src] of [['列表页', dpage], ['抽屉', drawer]] as const) {
    ok(!/const\s+\w*(TYPE|STATUS)_LABEL\b/.test(src),
      `G-2 反证：${name}内无本地标签表（有则词表仍散在两处，"一个数一个值"不成立）`);
  }

  // G-3「产出物」三个标签**互不重复**：同屏并排的三个计数，必须说得出各数的是什么
  const labels = ['产出物（项目合计）', '本任务（含子任务）', '主成果'];
  const countSurface = R('pages/ProjectDetailPage.tsx') + R('pages/TaskDetailPage.tsx') + R('components/DeliveryDigestCard.tsx');
  eq(labels.filter((l) => !countSurface.includes(l)), [],
    'G-3 三个「产出物」计数标签各自在场且**互不重复**（项目合计 / 本任务含子任务 / 主成果）');

  // ── G-4/G-5 M11（实机 E2E 打出来的第三条，非原方案条目）：服务型成果「启不动」的死结 ──
  //   锚点取**用户可见的 `title="启动"`**，不取词——本文件紧邻处的长注释里 `draft`/`NO_ENTRY` 字样俱全，
  //   按词判会被注释自己满足（"判据的自我印证"）。判的是**那个块的渲染条件**本身。
  ok((dpage.match(/title="启动"/g) ?? []).length === 1, 'G-4 自证：启动钮恰一处（定位不歧义）');
  const startBtn = dpage.indexOf('title="启动"');
  const gateStart = dpage.lastIndexOf('{isServiceType', startBtn);
  ok(gateStart > 0 && gateStart < startBtn, 'G-4 自证：定位到启停块的渲染条件（`{isServiceType`）');
  const gate = dpage.slice(gateStart, dpage.indexOf('(', gateStart + 1) + 1);
  ok(!gate.includes("'draft'"),
    'G-4 ★★启停条件**不排除 draft**——服务型成果恒为 draft（agent/GUI 建都是）且**无生产者**能推出 draft '
    + '（lifecycle 只转 doc / update 只收 name,description / accept 只置 acceptance_verified）⇒ 排除即死结，'
    + 'agent 建的服务成果在 GUI 里永远无法上路（「在册，不在路」）', `条件=${gate.replace(/\s+/g, ' ').trim()}`);
  eq(gate, '{isServiceType && (',
    'G-4 启停条件恰为 `{isServiceType && (`（带任何附加条件——如重新加回 `&& d.status !== \'draft\'`——即判红）');
  // G-5 启动失败须**如实带因**（与 handleRegister 同尺）：主进程回的 NO_ENTRY/START_FAILED 及子进程
  //   stderr 是"为什么起不来"的唯一来源，丢弃它 ⇒ 反证标本（立刻退出）在 GUI 上只剩一句无从追问的「启动失败」。
  ok(/handleStart[\s\S]{0,400}?\(e as Error\)\.message/.test(dpage),
    'G-5 ★启动失败**如实带因**（原 `catch { showToast(\'启动失败\') }` 把原因丢了）；'
    + '反证：handleStop/其他 catch 未一并改，故本条只钉 handleStart 一处');

  // ── G-6/G-7 M12（实机 E2E 打出的两个真缺陷）：渲染层的第二落点 ──
  // G-6 时间兜底**永不把非字符串交给 JSX**：IPC 的结构化克隆能送来活 `Date`（声明 string 拦不住运行期），
  //   对象进 JSX 即 React error #31。锚点取**赋值表达式本身**（本页注释里含 `|| s` 字样，按词判会自我满足）。
  ok(apage.includes('function formatTime(s: string | undefined | null): string')
    && apage.includes('return formatDbTime(s) || String(s);'),
    'G-6 ★★`A2aPage.formatTime` 兜底是 `|| String(s)`（返回值**必须是字符串**）——旧码 `|| s` 在 '
    + '`formatDbTime` 判不出时把那个 `Date` 原样吐给 JSX');
  eq((apage.match(/formatDbTime\(s\) \|\| s(?![A-Za-z])/g) ?? []).length, 0,
    'G-6 反证：`formatDbTime(s) || s` 的旧形状零残留（`(?![A-Za-z])` 使 `String(s)` 不被误判为旧码）');

  // G-7 运行态刷新须**跟着列表内容走**，不能只跟长度走：启停前后列表长度常常相同（同一行换字段），
  //   长度没变则不重跑 ⇒ ▶/绿点滞后到下一次 10s 轮询，用户读成"启动了但状态没变"而反复点。
  //   判法：把那条效应的**依赖数组**取出来看（注释里写 `[items.length]` 也骗不过它）。
  const rtDep = dpage.match(/useEffect\(\(\) => \{ if \(items\.length > 0\) loadRuntime\(\); \}, \[([^\]]*)\]\)/);
  ok(!!rtDep, 'G-7 自证：定位到运行态刷新那条效应（依赖数组已取出）');
  ok(!!rtDep && rtDep[1].includes('items') && !rtDep[1].includes('items.length'),
    'G-7 ★★运行态刷新的依赖是 `items` **本身**而非 `items.length`（否则同长度的启停变化不触发刷新，'
    + '实测两次点击相隔 7.1s——正落在 10s 轮询窗口内，即用户看到的"状态没变、还能继续启动"）',
    `依赖=[${rtDep?.[1] ?? '?'}]`);
  ok((apage.match(/formatTime\(/g) ?? []).length >= 1,
    `G-6 自证：A2aPage 内确有 ${(apage.match(/formatTime\(/g) ?? []).length} 处 \`formatTime(\` 读点`
    + '（上面的"零残留"不是扫了个空的自证）');
}

// ══════════════════════════════════════════════════════════════════
// 【H】M8 IM：说的与做的一致
// ══════════════════════════════════════════════════════════════════
async function groupH(): Promise<void> {
  console.log('\n【H】M8 IM：说的与做的一致（截断要说 / 失败分因同尺 / 状态值同表）');

  // ── H-a 长度尺单源：上限与"超了怎么截"只有一处 ──────────────────────────
  const imText = RD(`${A}/src/main/core/im/im-text.ts`);
  const manualSend = RD(`${A}/src/main/core/im/manual-send.ts`);
  const router = RD(`${A}/src/main/services/im-router.ts`);
  const qqbot = RD(`${A}/src/main/services/qqbot-adapter.ts`);
  ok((imText.match(/export function clipWithNotice\(/g) ?? []).length === 1,
    'H-a 截断实现 `clipWithNotice` 在真源内**恰一份**');
  ok(/export const IM_SEND_TEXT_LIMIT\b/.test(imText) && /export const IM_ROUTER_OUTPUT_LIMIT\b/.test(imText),
    'H-a 两把上限（渠道表 / 机器正文兜底）**同落一处** `im-text.ts`');
  ok(/from '\.\/im-text\.js'/.test(manualSend) && !/function clipWithNotice\(/.test(manualSend),
    'H-a 手工回话侧**只是转出**真源（不另写一份实现）——「在哪儿截就在哪儿拦」同一张表');

  // 三处截断都走同一函数；反证：**代码行**里不再有让人看不出截过的裸切（注释里的旧写法是台账，见 `codeLines`）
  // zx_20261003 M9 就地改钉：F3 通知正文那处随 F3 段搬入 `services/f3-notification-push.ts` ⇒
  //   "两处都走 clipWithNotice"改为跨两文件合计（命令输出在 im-router，F3 正文在 F3 文件），仍如实为 2。
  const f3push = RD(`${A}/src/main/services/f3-notification-push.ts`);
  const routerClips = (router.match(/clipWithNotice\(/g) ?? []).length
    + (f3push.match(/clipWithNotice\(/g) ?? []).length;
  eq(routerClips, 2, 'H-a 两处截断（命令输出在 `im-router.ts` / F3 通知正文在 `f3-notification-push.ts`）都走 `clipWithNotice`（**M9 就地改钉**：扫描面跨两文件合计）');
  const routerCode = codeLines(router);
  ok(routerCode.length > router.split('\n').length * 0.4,
    'H-a 自证：去注释后扫描面仍非空（否则下面的"零命中"是空转假绿）',
    `${routerCode.length} / ${router.split('\n').length} 行`);
  eq(routerCode.filter((l) => /\b4000\b/.test(l)), [],
    'H-a 反证：路由器**代码行**内无 `4000` 字面量（上限只在 `im-text.ts` 一处可查，不散第二处）');
  eq(routerCode.filter((l) => /readFileSync\([^;]*\)\s*\.slice\(/.test(l)), [],
    'H-a 反证：读文件正文后不再顺手硬切（"截了不说"的语句形状——与有没有 4000 这个数无关）');
  ok(/fitOutboundText\('qqbot',\s*text\)/.test(qqbot),
    "H-a 第三处（QQ 出站正文）交**唯一发落点** `fitOutboundText('qqbot', text)`（zx_20260930 M2-d 改钉：`im-text.ts` 里比 `clipWithNotice` 更强的那个函数）");
  const qqbotCode = codeLines(qqbot);
  ok(qqbotCode.length > 0 && !qqbotCode.some((l) => /text\.slice\(/.test(l)),
    'H-a 反证：QQ 适配器**代码行**内不再自写 `text.slice(…)` 硬切（扫描面非空自证同此条）',
    `${qqbotCode.length} 行`);

  // ── H-a 行为（生产函数 + 两只标本）：超限带标记且不越上限 / 未超限原样 ──
  {
    const limit = IM_SEND_TEXT_LIMIT.qqbot!;
    const long = '甲'.repeat(limit + 500);
    const clipped = clipWithNotice(long, limit);
    ok(clipped.length <= limit, 'H-a 超限截断结果**恒 ≤ 上限**（标记自己在额度内，不把上限顶破）',
      `${clipped.length} ≤ ${limit}`);
    ok(clipped.endsWith(TRUNCATION_MARKER) && clipped.length > TRUNCATION_MARKER.length,
      'H-a 超限截断**带标记**（用户知道"末尾少了"，而不是拿到一份"看起来完整"的内容）');
    ok(clipped.startsWith('甲'), 'H-a 超限截断保留正文头部（截的是尾，不是把整段丢掉）');
    const short = '短正文';
    eq(clipWithNotice(short, limit), short, 'H-a 未超限**原样返回**（不无端加标记——加了就是假警报）');
    eq(clipWithNotice(long, undefined), long, 'H-a 未列出的渠道不设人为上限（原样返回，不是"截成 0 字"）');
    // 代理对边界：末位恰劈开 emoji 高位时丢该位（宁可少一个字符，也不给出半个乱码）
    //   构造：10 个 BMP 字 + 1 个 emoji（占 2 码元）+ 14 个尾字；上限取"正文头恰 11 码元"
    //   ⇒ 头的末位正是 emoji 的高位代理。⚠ **正文必须真长于上限**，否则走的是"原样返回"那条路
    //   （本判据首版就栽在这里：12 码元的标本对上 25 的上限，压根没进截断分支 —— 判了个空）。
    const pair = '乙'.repeat(10) + '😀' + '丙'.repeat(TRUNCATION_MARKER.length);
    const pairLimit = 11 + TRUNCATION_MARKER.length;
    ok(pair.length > pairLimit,
      'H-a 标本自证：正文长于上限（否则下面测的是"未超限原样返回"，是空转假绿）',
      `${pair.length} > ${pairLimit}`);
    const cutP = clipWithNotice(pair, pairLimit);
    eq(cutP.slice(0, cutP.length - TRUNCATION_MARKER.length), '乙'.repeat(10),
      'H-a 末位劈开代理对时丢该位（头恰 10 字 ⇒ 不留孤立高位代理，界面不会出现半个乱码）');
  }

  // ── H-e 「发送条件缺失」的唯一判尺与唯一构造点 ──────────────────────────
  const imErr = RD(`${A}/src/main/core/im/im-errors.ts`);
  const ADAPTERS = ['wechat', 'feishu', 'wecom', 'dingtalk', 'qqbot'] as const;
  const adapterSrc: Record<string, string> = {};
  for (const a of ADAPTERS) adapterSrc[a] = RD(`${A}/src/main/services/${a}-adapter.ts`);
  // 判尺只在真源里出现一次：五家适配器内**不得**再各持一份配额正则
  const inlineRe = ADAPTERS.filter((a) => /\/quota\|limit\|frequen/.test(adapterSrc[a]!));
  eq(inlineRe, [], 'H-e 五家适配器内**无内联配额正则**（此前微信独持一份）——判尺归 `QUOTA_HINT_RE` 一处');
  ok(/export function looksLikeQuotaHint\(/.test(imErr) && /looksLikeQuotaHint\(errMsg\)/.test(adapterSrc.wechat!),
    'H-e 微信改认**共享判尺** `looksLikeQuotaHint`（内联那份已摘）');
  ok((imErr.match(/export function conditionMissing\(/g) ?? []).length === 1
    && (adapterSrc.wechat!.match(/conditionMissing\(/g) ?? []).length >= 3
    && !/new ImQuotaError\(/.test(adapterSrc.wechat!),
    'H-e 微信三处条件缺失（无 token / 配额耗尽 / 远端限流）**均经唯一构造点** `conditionMissing`，本家不自造');
  for (const a of ['feishu', 'wecom', 'dingtalk', 'qqbot'] as const) {
    const s = adapterSrc[a]!;
    ok(/credentialFailure\(/.test(s) && /private tokenFailure\(/.test(s),
      `H-e ${a}：取 token 失败经**共享分因** \`credentialFailure\`（本家只决定"配没配"）`);
  }

  // ── H-e 行为：分因**两只可分辨标本**（G-2：正反各一只真标本） ─────────────
  {
    const miss = credentialFailure('feishu', { missingConfig: true, detail: '无法获取 tenant_access_token，发送失败' });
    const present = credentialFailure('feishu', { missingConfig: false, detail: '无法获取 tenant_access_token，发送失败' });
    ok(isImQuotaError(miss) && miss instanceof ImQuotaError,
      'H-e 凭证**未配置** ⇒ 条件缺失（`ImQuotaError`：等有人去配置，重试一万次同结果）');
    ok(!isImQuotaError(present) && present instanceof ImSendError,
      'H-e 凭证**已配置**（网络/远端拒签）⇒ 普通失败（`ImSendError`：照旧 1/2/4 退避）——同输入同函数，**只有"配没配"这一个事实**在分岔');
    ok(!isImQuotaError(conditionMissing('wechat', 'x')) === false,
      'H-e `conditionMissing` 恒为 `ImQuotaError`');
    ok(miss.message.includes('feishu') && present.message.includes('feishu'),
      'H-e 两类都带**渠道名**（账上认得出是哪家说的）');
    // 判尺两只标本：能认出配额信号 / 不把普通错误误判成配额
    ok(looksLikeQuotaHint('push quota exceeded, freq limit reached') && looksLikeQuotaHint('主动推送配额已耗尽'),
      'H-e 判尺正面标本：中英文配额/频率文案均命中');
    ok(!looksLikeQuotaHint('invalid signature') && !looksLikeQuotaHint(''),
      'H-e 判尺反证标本：普通错误与空串**不命中**（宽到见谁都算配额，就等于取消退避）');
  }

  // ── H-c 状态词表同表：人机回话失败也分「等待条件恢复 / 真失败」 ───────────
  {
    const hdb = new DatabaseSync(':memory:') as unknown as AnyDb;
    hdb.exec(`
      CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT, name TEXT, config TEXT DEFAULT '{}', status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE wa_im_conversations (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, project_id TEXT, message_json TEXT DEFAULT '{}', direction TEXT DEFAULT 'inbound', created_at TEXT DEFAULT (datetime('now')), status TEXT DEFAULT 'sent', last_error TEXT DEFAULT '', outbox_id TEXT DEFAULT '');
    `);
    hdb.prepare("INSERT INTO wa_im_channels (id, channel_type) VALUES ('c1', 'qqbot')").run();
    const rows = () => hdb.prepare('SELECT status, last_error, message_json FROM wa_im_conversations').all() as Array<{ status: string; last_error: string; message_json: string }>;
    accountOutboundFailure(hdb, { channelId: 'c1', externalUserId: 'u1', text: '回话甲', error: '登录态缺失（无 token）', quota: true });
    accountOutboundFailure(hdb, { channelId: 'c1', externalUserId: 'u1', text: '回话乙', error: '接口 500' });
    eq(rows().length, 2, 'H-c 两次失败记账恰 2 行（每类各 1 行 —— 计数器正面断言，非"不抛即通过"）');
    eq(rows().map((r) => r.status), ['blocked_quota', 'failed'],
      'H-c 两种境遇在账上**长得不一样**：条件缺失 ⇒ `blocked_quota`（等恢复）；其余 ⇒ `failed`（真没发出去）');
    eq(rows().map((r) => r.last_error), ['登录态缺失（无 token）', '接口 500'], 'H-c 真原因原样落账（不编、不摘要）');
    ok(JSON.parse(rows()[0]!.message_json).quota_blocked === true
      && JSON.parse(rows()[1]!.message_json).quota_blocked === undefined,
      'H-c 正文侧同带 `quota_blocked` 标记（账上两个字段同说一句话）');
    // 版本对不上时如实：新状态值落库了，**渲染侧**必须认得它（否则印成"已送达"比不修更糟）
    const cv = convDeliveryOf({ id: 'x', direction: 'outbound', status: 'blocked_quota', last_error: '登录态缺失（无 token）' }, 'idle');
    ok(cv?.tone === 'bad' && cv.label.includes('等待条件恢复'),
      'H-c 渲染侧认得 `blocked_quota` ⇒ 红字「未送达 · 等待条件恢复…」（**不是**绿字「已送达」）', JSON.stringify(cv));
    const unknown = convDeliveryOf({ id: 'y', direction: 'outbound', status: 'weird_new_value' }, 'idle');
    ok(unknown?.tone === 'bad' && unknown.label.includes('状态未识别'),
      'H-c 反证标本：**认不出的**状态如实说"认不出"，绝不替它说送到了（旧兜底"其余一切 ⇒ 已送达"正是本病的反面）',
      JSON.stringify(unknown));
    const sent = convDeliveryOf({ id: 'z', direction: 'outbound', status: 'sent' }, 'idle');
    ok(sent?.tone === 'ok', 'H-c 正面标本：`sent` 仍是绿字（兜底改严没有把正常送达一起打成红）');
  }

  // ── H-d 防重投闸命中时**回执 + 留痕**（沉默不是一种） ────────────────────
  {
    // 两处闸（任务分支 / 单条可续跑分支）：各自**都要**既有留痕又有回话，且不得只剩 `return`
    const gates = router.split("datetime(updated_at) > datetime('now', '-30 seconds')");
    eq(gates.length - 1, 2, 'H-d 防重投闸恰 2 处（任务分支 / 单条可续跑分支）——计数正面断言');
    const dedupReplies = (router.match(/30 秒内已受理，本次未重复启动/g) ?? []).length;
    eq(dedupReplies, 2, 'H-d 两处闸**都**回了一句回执（此前只 `console.log` 就 `return` —— 用户侧看到的是"发了没反应"）');
    const dedupLogs = (router.match(/启动指令→任务30s内已启动，按重投跳过/g) ?? []).length;
    eq(dedupLogs, 2, 'H-d 两处闸**都**走 `imLogger` 留痕（`console.log` 进不了 pino 日志，别据此判"没发生"）');
    ok(!/^\s*return;\s*$/m.test(router.slice(router.indexOf("datetime(updated_at) > datetime('now', '-30 seconds')"), router.indexOf("datetime(updated_at) > datetime('now', '-30 seconds')") + 400)),
      'H-d 反证：闸内不再以裸 `return;` 收场（那正是"沉默"的形状）');
    // 三处错误出口：留痕 + 说人话（此前只 `console.warn` 一句就完）
    for (const [lbl, errTxt] of [['获取系统状态失败', '获取系统状态失败，请稍后重试。'], ['启动任务失败', '启动任务失败，请稍后重试。'], ['创建任务失败', '创建任务失败，请稍后重试。']] as const) {
      ok(router.includes(`imLogger.error({ error: (err as Error).message, channel: ctx.channelType }, '[IMRouter] ${lbl}')`)
        && router.includes(errTxt),
        `H-d 出口「${lbl}」既**留痕**又**说人话**（失败不该只在日志里发生）`);
    }
  }

  // ── H-c 静态：两个写者都用**同一个判据**定状态值 ─────────────────────────
  const ipcSrc = RD(`${A}/src/main/ipc/im.ipc.ts`);
  const acctSrc = RD(`${A}/src/main/core/im/reply-accounting.ts`);
  ok(/isImQuotaError\(err\)/.test(ipcSrc) && /quota:\s*isImQuotaError\(err\)/.test(ipcSrc),
    'H-c 路由侧由**同一个判据**（抛出类型）定状态值，不从 error 文案里猜（猜文案＝第二把尺）');
  ok(/'blocked_quota'\s*:\s*'failed'/.test(ipcSrc) && /'blocked_quota'\s*:\s*'failed'/.test(acctSrc),
    'H-c 两处写者**同表同值** `blocked_quota` / `failed`（一个概念一个值）');
  const cvSrc = RD(`${A}/renderer/src/lib/convDelivery.ts`);
  ok(cvSrc.includes("status === 'blocked_quota'") && cvSrc.includes('状态未识别'),
    'H-c 渲染侧第二落点已补齐：新取值有专支 + 兜底**显式**（不再"其余一切 ⇒ 已送达"）');
}

// ══════════════════════════════════════════════════════════════════
// 【J】M9 重构：抽出去的模块，得真的被叫到
//   本轮主题落在重构面上的那一句：模块建出来只算**在册**，
//   执行体真的 import 进去、且在原调用点换成它，才算**在路**。
//   另有本重构的**设计要害**：`StepScope` 交出去的是**活访问器**（读写落在原绑定本身），
//   不是值快照——快照会把每步的步数/水位/降级档**静默冻住**（无报错、只是数字不再动）。
// ══════════════════════════════════════════════════════════════════
function groupJ(): void {
  console.log('\n【J】M9 重构：抽出的段接回执行体 · 活访问器非快照');

  const exec = RD(`${A}/src/main/core/agent-executor.ts`);
  const step = RD(`${A}/src/main/core/exec-step.ts`);
  const close = RD(`${A}/src/main/core/exec-close.ts`);

  // ── J-1 两个抽出模块**恰一份实现**，且执行体**真 import 且真调用**（在册→在路）──
  eq((step.match(/export function createStepHandler\(/g) ?? []).length, 1,
    'J-1 步回调处理器 `createStepHandler` 在 `exec-step.ts` 内**恰一份**实现');
  eq((close.match(/export async function runCloseSection\(/g) ?? []).length, 1,
    'J-1 收尾段 `runCloseSection` 在 `exec-close.ts` 内**恰一份**实现');
  ok(/from '\.\/exec-step\.js'/.test(exec) && /createStepHandler\(/.test(exec),
    'J-1 ★执行体**既有 import 又有调用点**（只建文件不接=本轮主题的反面："在册"没变成"在路"）');
  ok(/from '\.\/exec-close\.js'/.test(exec) && /runCloseSection\(/.test(exec),
    'J-1 ★收尾段同此：import 与调用点都在执行体内');
  // 反证：抽走的是**回调体**，不是**接线点** —— 接线仍只在执行体一处。
  //   ⚠ 钉**语句形状** `onStepFinish: createStepHandler(`，不钉 `onStepFinish:` 这个子串：
  //   后者在两份文件的**注释台账**里都出现（"搬迁来源：… `onStepFinish: async (event) => {…}`"），
  //   按子串判会把如实写下的台账读成违规（本仓"判据须能被合法数据满足"的又一例）。
  ok(/onStepFinish: createStepHandler\(/.test(exec),
    'J-1 ★接线点 `onStepFinish: createStepHandler(…)` 在执行体内（"在册"变成"在路"的具体语句形状）');
  eq((step.match(/onStepFinish: createStepHandler\(/g) ?? []).length, 0,
    'J-1 反证：接线**不在** `exec-step.ts` 内重复一份（抽走的是回调体，不是接线点）');

  // ── J-2 反证：12 个已迁走的名字不得留在执行体的 **import 面** ────────────────
  //   ⚠ 按**语句形状**取（import/export-from 语句内），不按全文出现 ——
  //   注释里点名是**台账**（写明"这名字搬到哪了"），不是引用；按全文判会把它误当残留。
  const importLines = exec.split('\n')
    .filter((l) => /^\s*(import|export)\b[^;]*\bfrom\s+'/.test(l)).join('\n');
  ok(importLines.length > 0,
    'J-2 自证：执行体 import 面非空（否则下面的"零命中"是空转假绿）',
    `${importLines.split('\n').length} 行`);
  const MOVED = ['MAX_CHILD_BREADTH', 'countActiveChildren', 'PAUSE_REASON_TOOL_LOOP',
    'PAUSE_REASON_NO_PROGRESS', 'logStepExecution', 'reassessComplexityDuringExecution', 'recordToolUsage',
    'finalizeRunClose', 'readTaskAcceptanceCriteria', 'syncGoalAchievedFromAccount',
    'PAUSE_REASON_OUTPUT_INSUFFICIENT', 'PAUSE_REASON_QUALITY_BELOW_BAR'];
  eq(MOVED.filter((n) => new RegExp(`\\b${n}\\b`).test(importLines)), [],
    'J-2 反证：12 个迁走的名字**无一**留在执行体 import 面（"搬了一半 / 两份名字"都不许）');

  // ── J-3 ★设计要害：`StepScope` 是**活访问器**（有 `set`），不是值快照 ────────
  const iface = /export interface StepScope \{([\s\S]*?)\n\}/.exec(step)?.[1] ?? '';
  ok(iface.length > 0, 'J-3 自证：`StepScope` 接口定义在场', `${iface.length} 字符`);
  const gNames = new Set([...iface.matchAll(/\bget (\w+)\(\)/g)].map((m) => m[1]!));
  const sNames = [...iface.matchAll(/\bset (\w+)\(/g)].map((m) => m[1]!);
  ok(gNames.size >= 40, 'J-3 取用器面够宽（执行体每步要读的绑定都经它）', `${gNames.size} 个 get`);
  ok(sNames.length > 0,
    'J-3 ★存在**写回**访问器（`set`）—— 这是"活访问器"与"值快照"的分界', `${sNames.length} 个 set`);
  eq(sNames.filter((n) => !gNames.has(n)), [], 'J-3 每个 `set` 都有对应 `get`（读写同一批名，不成两套）');
  ok(/\bd\.stepCount\+\+;/.test(step) && /\bd\.loopRun = /.test(step),
    'J-3 ★步回调内**真在写回**原绑定（`d.stepCount++;` / `d.loopRun = …`）——'
    + '值快照会把每步的步数/水位/降级档静默冻住，本重构刻意不取快照');

  // ── J-4 `stripStepScopePrefix` 的两只标本（那 5 套读引擎源码的判据靠的**同一个函数**）──
  eq(stripStepScopePrefix('if (d.stepCount > 0) d.loopRun = 1;'), 'if (stepCount > 0) loopRun = 1;',
    'J-4 正标本：接口成员上的 `d.` 注入前缀被剥掉（否则读源码的判据全要人肉改写、一搬就散）');
  eq(stripStepScopePrefix('const x = d.notAMember;'), 'const x = d.notAMember;',
    'J-4 反标本：**非**接口成员不乱剥（只剥 `StepScope` 真有的名字——乱剥会改坏真代码而不自知）');
  // 前提自证：`d.<成员>` 在**并集**内全部落在 `exec-step.ts`，文件外 0 处 ⇒ 剥离只动这一份
  const hitsByFile = engineSrcFiles().map((p) => {
    const t = fs.readFileSync(path.join(root, p), 'utf-8');
    return [p, [...t.matchAll(new RegExp(`\\bd\\.(${[...gNames].join('|')})\\b`, 'g'))].length] as const;
  });
  const totalHits = hitsByFile.reduce((a, [, n]) => a + n, 0);
  ok(totalHits > 0, 'J-4 自证：并集内 `d.<成员>` 命中数非 0（否则下面"全落一处"是空转真）', `${totalHits} 处`);
  eq(hitsByFile.filter(([p, n]) => n > 0 && !p.endsWith('/exec-step.ts')).map(([p]) => p), [],
    'J-4 前提：`d.<成员>` **全部**落在 `exec-step.ts`（文件外 0 处）⇒ 剥离面 = 这一份文件');

  // ── J-5 `engineExecSideFiles()` 真的排除了 tools 段（"文件名即判据"那类不得并进来）──
  const sideFiles = engineExecSideFiles();
  ok(sideFiles.includes('apps/worker-ant-desktop/src/main/core/agent-executor.ts'),
    'J-5 自证：执行体侧扫描面含执行体本体', `${sideFiles.length} 文件`);
  eq(sideFiles.filter((p) => p.includes('/core/tools/')), [],
    'J-5 反证：执行体侧**不含** `core/tools/*`（把那两套"文件名本身就是判据"的并进来会变**松**）');
  ok(engineSrcFiles().length > sideFiles.length,
    'J-5 对照：全并集严格**大于**执行体侧（差集恰为 tools 段）',
    `${engineSrcFiles().length} > ${sideFiles.length}`);
}

/** 真源里 `audio` 的语义句（从真源**读出来**，不在这里抄一遍——抄一遍就是又造了一份词表）。 */
function mr0KindSemantics(): string {
  const m = /AUDIO_CAPABILITY_SEMANTICS = '([^']+)'/.exec(RD('packages/shared-types/src/models.ts'));
  return m?.[1] ?? '(没取到)';
}

// ══════════════════════════════════════════════════════════════════
// 【I】哑雷专项 + build 钉
// ══════════════════════════════════════════════════════════════════
function groupI(): void {
  console.log('\n【I】哑雷专项 + build 钉（轮次一律由载体自身派生，不写轮次字面量）');
  const selfSrc = fs.readFileSync(__filename, 'utf-8');
  ok(selfSrc.length > 2000, 'I-1 扫描面自证：本文件源码非空（否则下面的"零命中"是空转假绿）', `${selfSrc.length} 字节`);
  const pat = new RegExp("'zx_\\d{8}(?:_\\d+)?'", 'g');
  const hits = (selfSrc.match(pat) ?? []).filter((s) => {
    const y = Number(s.slice(4, 8));
    return y >= 2020 && y <= 2030;
  });
  eq(hits, [], 'I-2 ★本文件内**零**处「只为下一轮为真」的轮次字面量（否则是只对下一轮引爆的哑雷）');
  const THIS = path.basename(__filename).replace(/\.ts$/, '');
  const relPlan = path.join('plans/improve', `${THIS.slice(3)}.md`);
  ok(fs.existsSync(path.join(root, relPlan)), 'I-3 ★方向性自指（由载体自身派生，非抄来的常量）：本轮方案文件在场', relPlan);
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

async function main(): Promise<void> {
  await groupA();
  await groupB();
  await groupC();
  await groupD();
  await groupE();
  await groupF();
  groupG();
  await groupH();
  groupJ();
  groupI();
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260929: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => { console.error(e); process.exit(1); });
