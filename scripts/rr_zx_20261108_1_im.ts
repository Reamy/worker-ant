/**
 * zx_20261108_1 B3「识」受控回归 —— IM 理解可核对（维特根斯坦·意义即使用 / 管子·度量衡）。
 *
 * 钉住六件事：
 *   A 规则表：10+ 条真实用户话术各归其位（查询/启动/建单/问候/待澄清），显式规则不被模型推翻；
 *   B 群聊 @ 闸：未 @ 的建单/启动被拒、查询照答；@ 后正常；项目 @ 不被剥；
 *   C mention 剥离：平台占位符恒剥、开头 @称呼只在平台证实 @ 了我时剥；
 *   D 理解落库：入站行 `intent/route/route_reason` 非空，建单/启动回写 `task_id`；
 *   E 去重：同平台 id 第二次被挡；无 id 同正文 30s 内被挡、30s 后可再收（时刻注入，不看墙钟）；
 *   F 反证：5/6 字闲聊不再建单（`length > 4` 判据已删）；审计模块先闸后读、锁定不读不写。
 *
 * 纪律：零真网（fetch 边界替身）、零 electron、时刻由 `Date.now` 注入；文案不含失败字形。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  GROUP_REFUSAL_TEXT,
  decideImIntent,
  stripBotMention,
  type ImIntent,
  type ImIntentDecision,
  type ImRoute,
} from '../apps/worker-ant-desktop/src/main/core/im-intent.js';
import { LLM_UNAVAILABLE_TEXT, routeImMessage } from '../apps/worker-ant-desktop/src/main/services/im-router.js';
import {
  exportIntentAuditCsvGated,
  intentAuditCsv,
  listIntentAudit,
  listIntentAuditGated,
  type IntentAuditDb,
  type IntentAuditRow,
} from '../apps/worker-ant-desktop/src/main/core/im/im-intent-audit.js';
import { LICENSE_SETTING_KEYS, type LicenseSettingDb } from '../apps/worker-ant-desktop/src/main/core/license.js';
import { buildNotOlderThan, checkBuildPins, deriveBuildTag, stripKeepingLines } from './lib/rr-pins.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'apps/worker-ant-desktop');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

/** 理由一律非空、且不含 rr 汇总器会误算的失败字形。 */
function reasonsSound(decisions: ImIntentDecision[]): boolean {
  return decisions.every((d) => d.reason.trim().length > 0 && !d.reason.includes('✗') && !d.reason.includes('✓'));
}

// ─────────────────────────────────────────────────────────────
// 夹具：照抄 database.ts 的 DDL（列不齐即在生产能过的地方抛错）
// ─────────────────────────────────────────────────────────────
const IM_SCHEMA = `
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, name TEXT DEFAULT '', config TEXT NOT NULL DEFAULT '{}', status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_im_conversations (
  id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, project_id TEXT,
  message_json TEXT DEFAULT '{}', direction TEXT DEFAULT 'inbound',
  created_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'sent', last_error TEXT DEFAULT '', outbox_id TEXT DEFAULT '',
  task_id TEXT DEFAULT '', intent TEXT DEFAULT '', route TEXT DEFAULT '', route_reason TEXT DEFAULT '');
CREATE TABLE wa_im_seen (
  channel_id TEXT NOT NULL, external_user_id TEXT NOT NULL, platform_message_id TEXT NOT NULL,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel_id, external_user_id, platform_message_id));
CREATE INDEX idx_wa_im_seen_at ON wa_im_seen(seen_at);
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_users (id TEXT PRIMARY KEY, name TEXT DEFAULT '', role TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', cron_schedule TEXT, working_dir TEXT DEFAULT '',
  context_json TEXT DEFAULT '{}', sandbox_mode TEXT DEFAULT 'workspace',
  owner_id TEXT, cron_timezone TEXT DEFAULT 'Asia/Shanghai',
  autonomous_mode TEXT DEFAULT 'off', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
  source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '', aggregate_version INTEGER DEFAULT 0,
  position_id TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (
  id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL, content TEXT DEFAULT '',
  tool_calls TEXT, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending', retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
  scheduled_at TEXT, started_at TEXT, completed_at TEXT, error TEXT,
  created_at TEXT DEFAULT (datetime('now')));
`;

type AnyDb = import('better-sqlite3').Database;
function mkDb(): AnyDb {
  const d = new DatabaseSync(':memory:');
  d.exec(IM_SCHEMA);
  // `boolSetting(undefined)` 判真 ⇒ 未设键时 ambiguous 路会先回一条 busy ack；本套件把它显式关掉，
  // 让"回话"只反映被测路由（不是把 ack 也算成路由结果）。
  d.prepare("INSERT INTO wa_settings (key, value) VALUES ('im.busy_ack', 'false')").run();
  return d as unknown as AnyDb;
}

/** 回访种子行（zx_20261112_1 B3 抑制首聊欢迎用）在 message_json 打标记，不计入标本行。 */
const SEED_JSON = '{"seed":true}';
const convRows = (db: AnyDb, direction = 'inbound') =>
  db.prepare('SELECT * FROM wa_im_conversations WHERE direction = ? AND COALESCE(message_json, \'\') <> ? ORDER BY rowid')
    .all(direction, SEED_JSON) as Array<Record<string, unknown>>;
const taskRows = (db: AnyDb) => db.prepare('SELECT * FROM wa_tasks ORDER BY rowid').all() as Array<Record<string, unknown>>;
const projectRows = (db: AnyDb) => db.prepare('SELECT * FROM wa_projects').all() as Array<Record<string, unknown>>;
const jobRows = (db: AnyDb) => db.prepare('SELECT * FROM wa_jobs ORDER BY rowid').all() as Array<Record<string, unknown>>;

/** 把回调接到**真 routeImMessage** 上（生产入站链路），收集回话。 */
function wire(db: AnyDb, channelId: string, channelType: string) {
  const replies: string[] = [];
  const ictx = { db, channelId, channelType, sendReply: async (_to: string, t: string) => { replies.push(t); } };
  return {
    replies,
    handler: (from: string, text: string, chatType: string, meta?: Record<string, unknown>) => {
      // zx_20261112_1 B3: 回访用户入参——先落一条该用户历史 inbound，使首聊欢迎不占 replies[0]
      //（欢迎由 rr_zx_20261112_1 专测；本套测理解三列与闸）。
      db.prepare("INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction) VALUES (?,?,?,?,'inbound')")
        .run(`seed-${Math.random().toString(36).slice(2)}`, channelId, from, SEED_JSON);
      return routeImMessage(ictx as never, from, text, chatType, '', meta as never);
    },
  };
}

/** 网络边界替身：rr 不打真网。模型意图分类因此恒 null ⇒ 规则未命中时停在 ambiguous。 */
function stubFetch(): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('rr: network disabled'); }) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

// ═══ A｜规则表 ═══════════════════════════════════════════════════════════════
function sectionA(): void {
  console.log('\n【A】规则表：真实话术各归其位');

  const cases: Array<{ text: string; chatType?: string; mentionsBot?: boolean; project?: boolean; llm?: ImIntent; want: [ImIntent, ImRoute] }> = [
    { text: '帮助', want: ['general_chat', 'help'] },
    { text: '查看系统状态', want: ['query_status', 'query'] },
    { text: '帮我看看项目进展', want: ['query_status', 'query'] },
    { text: '这个任务现在什么情况', want: ['query_status', 'query'] },
    { text: '开始 整理周报', want: ['start_task', 'start'] },
    { text: '启动 次高项目', want: ['start_task', 'start'] },
    { text: '创建任务 写脚本', want: ['create_task', 'create'] },
    // zx_20261110_1 B1 按「改旧断言＝改钉更强的新真源」重定向（非放宽）：
    //   软研究词（写/分析…）单独出现**不再授权建单**，改为待澄清——正是本轮要治的病。
    { text: '写一份周报', want: ['ambiguous', 'ambiguous'] },
    { text: '分析一下这个报错', want: ['ambiguous', 'ambiguous'] },
    { text: '@项目甲 创建任务 写脚本', project: true, want: ['create_task', 'create'] },
    { text: '你好', want: ['general_chat', 'greeting'] },
    { text: '谢谢', want: ['general_chat', 'greeting'] },
    { text: '客厅有点热', want: ['ambiguous', 'ambiguous'] },
    { text: '今天天气不错', want: ['ambiguous', 'ambiguous'] },
    { text: '创建任务 写脚本', chatType: 'group', want: ['create_task', 'group_gate'] },
    { text: '开始 整理周报', chatType: 'group', want: ['start_task', 'group_gate'] },
    { text: '查看系统状态', chatType: 'group', want: ['query_status', 'query'] },
    { text: '创建任务 写脚本', chatType: 'group', mentionsBot: true, want: ['create_task', 'create'] },
  ];

  const decisions: ImIntentDecision[] = [];
  cases.forEach((c, i) => {
    const d = decideImIntent({
      text: c.text,
      ...(c.chatType ? { chatType: c.chatType } : {}),
      ...(c.mentionsBot !== undefined ? { mentionsBot: c.mentionsBot } : {}),
      ...(c.project ? { hasProjectMention: true } : {}),
    });
    decisions.push(d);
    eq([d.intent, d.route], c.want, `A${i + 1} 「${c.text}」${c.chatType ? `/${c.chatType}` : ''} ⇒ ${c.want[0]}/${c.want[1]}`);
  });
  ok(reasonsSound(decisions), 'A19 每条判定的理由都非空且无失败字形');
  ok(decisions.filter((d) => d.route === 'help' || d.route === 'query' || d.route === 'start' || d.route === 'create' || d.route === 'greeting').every((d) => d.confidence === 'high'),
    'A20 显式规则命中 ⇒ 高置信（模型无从推翻）');

  const llmCreate = decideImIntent({ text: '这件事我想想', llmIntent: 'create_task' });
  eq([llmCreate.intent, llmCreate.route], ['create_task', 'llm'], 'A21 规则全不命中时，模型结论才被采纳（route=llm）');
  const llmChat = decideImIntent({ text: '这件事我想想', llmIntent: 'general_chat' });
  eq([llmChat.intent, llmChat.route], ['general_chat', 'llm'], 'A22 模型判闲聊 ⇒ 回一句，不建单');
  const ruleWins = decideImIntent({ text: '查看系统状态', llmIntent: 'create_task' });
  eq(ruleWins.route, 'query', 'A23 显式规则命中时模型结论被忽略（不被推翻）');

  const emptyMention = decideImIntent({ text: '@_user_1', chatType: 'group', mentionsBot: true });
  eq(emptyMention.route, 'group_silent', 'A24 只有平台 @ 占位符、没有正文 ⇒ 静默（不当作指令）');
}

// ═══ B｜群聊 @ 闸（端到端） ═══════════════════════════════════════════════════
async function sectionB(): Promise<void> {
  console.log('\n【B】群聊 @ 闸：未 @ 不办指令，查询照答');

  {
    const db = mkDb();
    const w = wire(db, 'ch-g1', 'feishu');
    await w.handler('g-user-1', '创建任务 写脚本', 'group', {});
    eq(taskRows(db).length, 0, 'B1 未 @ 我 ⇒ 群聊建单不受理（0 张任务）');
    eq(w.replies, [GROUP_REFUSAL_TEXT], 'B2 未 @ 我 ⇒ 回「群里请 @我 再下指令」');
    const row = convRows(db)[0]!;
    eq(row.intent, 'create_task', 'B3 理解结果照记：intent=create_task');
    eq(row.route, 'group_gate', 'B4 路由如实记 group_gate（不是假装没收到）');
    ok(String(row.route_reason).length > 0, 'B5 理由非空', String(row.route_reason));
    ok(!String(row.route_reason).includes('✗') && !GROUP_REFUSAL_TEXT.includes('✗'), 'B6 回执与理由不含失败字形');
  }
  {
    const db = mkDb();
    const w = wire(db, 'ch-g2', 'feishu');
    await w.handler('g-user-2', '创建任务 写脚本', 'group', { mentionsBot: true });
    eq(taskRows(db).length, 1, 'B7 平台证实 @ 了我 ⇒ 群聊建单放行（0→1）');
    ok(String(w.replies[0] ?? '').includes('已创建任务'), 'B8 回执如实说已建任务', w.replies[0]);
    eq(convRows(db)[0]!.task_id, taskRows(db)[0]!.id, 'B9 入站行回写 task_id（与任务行同一 id）');
  }
  {
    const db = mkDb();
    db.prepare("INSERT INTO wa_tasks (id, title, status, context_json, updated_at) VALUES ('t-paused', '整理周报', 'paused', '{}', datetime('now','-1 hour'))").run();
    const w = wire(db, 'ch-g3', 'feishu');
    await w.handler('g-user-3', '开始 整理周报', 'group', {});
    eq(db.prepare("SELECT status FROM wa_tasks WHERE id='t-paused'").get(), { status: 'paused' }, 'B10 未 @ 我 ⇒ 群里启动指令不动任务（仍 paused）');
    eq(w.replies, [GROUP_REFUSAL_TEXT], 'B11 未 @ 我 ⇒ 启动同样被拒');
    eq(convRows(db)[0]!.route, 'group_gate', 'B12 启动被拒也如实记 group_gate');
  }
  {
    const db = mkDb();
    const w = wire(db, 'ch-g4', 'feishu');
    await w.handler('g-user-4', '查看系统状态', 'group', {});
    ok(String(w.replies[0] ?? '').includes('工蚁系统状态'), 'B13 群聊未 @ 但这是查询 ⇒ 照答');
    eq(convRows(db)[0]!.route, 'query', 'B14 查询路由不是 group_gate');
  }
  {
    const db = mkDb();
    const w = wire(db, 'ch-g5', 'feishu');
    await w.handler('g-user-5', '客厅有点热', 'group', {});
    eq(w.replies.length, 0, 'B15 群聊未 @ 的随口一句 ⇒ 静默（不建单、不回话）');
    eq(taskRows(db).length, 0, 'B16 静默路零建单');
    eq(convRows(db)[0]!.route, 'group_silent', 'B17 静默如实记 group_silent');
  }
}

// ═══ C｜mention 剥离 ═════════════════════════════════════════════════════════
async function sectionC(): Promise<void> {
  console.log('\n【C】mention 剥离：占位符恒剥，@称呼只在证实后面剥');

  eq(stripBotMention('@工蚁 创建任务 写脚本', true), '创建任务 写脚本', 'C1 平台证实 @ 了我 ⇒ 剥开头 @称呼');
  ok(stripBotMention('@工蚁 创建任务 写脚本', false).startsWith('@工蚁'), 'C2 未证实 ⇒ 不动开头 @（可能是 @项目名）');
  eq(stripBotMention('@工蚁 @项目甲 创建任务', true), '@项目甲 创建任务', 'C3 剥掉机器人后，项目 @ 原样保留');
  eq(stripBotMention('hi @_user_1 看看进展'), 'hi 看看进展', 'C4 飞书平台占位符 @_user_N 恒剥');
  eq(stripBotMention('<@!12345> 查看状态'), '查看状态', 'C5 QQ/通用 <@!id> 占位符恒剥');
  eq(stripBotMention('  @工蚁  你好  ', true), '你好', 'C6 剥离后收敛空白并 trim');

  {
    const db = mkDb();
    const w = wire(db, 'ch-c1', 'feishu');
    await w.handler('c-user-1', '@工蚁 创建任务 写脚本', 'direct', { mentionsBot: true });
    eq(taskRows(db).length, 1, 'C7 端到端：开头 @机器人 被剥后照常建单');
    const titles = projectRows(db).map((p) => String(p.name));
    ok(!titles.includes('工蚁'), 'C8 机器人名没有被当成项目名（落 IM对话项目）', titles.join(','));
  }
  {
    const db = mkDb();
    const w = wire(db, 'ch-c2', 'feishu');
    await w.handler('c-user-2', '@项目甲 创建任务 写脚本', 'direct', {});
    eq(projectRows(db).map((p) => String(p.name)), ['项目甲'], 'C9 端到端：项目 @ 不被剥，按 @ 建/落项目');
    eq(convRows(db)[0]!.task_id, taskRows(db)[0]!.id, 'C10 项目 @ 路同样回写 task_id');
  }
}

// ═══ D｜理解落库与 task_id 回写 ══════════════════════════════════════════════
async function sectionD(): Promise<void> {
  console.log('\n【D】理解落库：intent/route/route_reason 非空，建单/启动回写 task_id');

  {
    const db = mkDb();
    const w = wire(db, 'ch-d1', 'wecom');
    await w.handler('d-user-1', '创建任务 写脚本', 'direct', {});
    const row = convRows(db)[0]!;
    const task = taskRows(db)[0]!;
    eq([row.intent, row.route], ['create_task', 'create'], 'D1 建单：intent/route 如实落库');
    ok(String(row.route_reason).length > 0, 'D2 建单：route_reason 非空', String(row.route_reason));
    eq(row.task_id, task.id, 'D3 建单：入站行 task_id = 新建任务 id');
    ok(String(task.title).length > 0, 'D4 建单：任务标题非空', String(task.title));
    ok(String(w.replies[0] ?? '').includes('已创建任务'), 'D5 建单回执到场');
  }
  {
    const db = mkDb();
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json, updated_at) VALUES ('t-s1', NULL, '整理周报', 'paused', '{}', datetime('now','-1 hour'))").run();
    const w = wire(db, 'ch-d2', 'wecom');
    await w.handler('d-user-2', '开始 整理周报', 'direct', {});
    const row = convRows(db)[0]!;
    eq([row.intent, row.route], ['start_task', 'start'], 'D6 启动：intent/route 如实落库');
    ok(String(row.route_reason).length > 0, 'D7 启动：route_reason 非空', String(row.route_reason));
    eq(row.task_id, 't-s1', 'D8 启动：入站行 task_id = 被启动任务 id');
    eq(db.prepare("SELECT status FROM wa_tasks WHERE id='t-s1'").get(), { status: 'pending' }, 'D9 启动：任务真的被置回 pending');
    const jobs = jobRows(db);
    eq(jobs.length, 1, 'D10 启动：入队一个作业（真发生，不只看回话）');
    eq(jobs[0]!.type, 'ai-task', 'D11 作业类型 ai-task');
    ok(String(jobs[0]!.payload).includes('t-s1'), 'D12 作业载荷指向同一任务');
  }
  {
    const db = mkDb();
    const w = wire(db, 'ch-d3', 'wecom');
    await w.handler('d-user-3', '查看系统状态', 'direct', {});
    const row = convRows(db)[0]!;
    eq([row.intent, row.route], ['query_status', 'query'], 'D13 查询：intent/route 如实落库');
    ok(String(row.route_reason).length > 0, 'D14 查询：route_reason 非空', String(row.route_reason));
    eq(row.task_id, '', 'D15 查询：不虚构任务归属（task_id 留空）');
    ok(String(w.replies[0] ?? '').includes('工蚁系统状态'), 'D16 查询回执到场');
  }
}

// ═══ E｜去重（平台 id / 30s 正文窗） ═════════════════════════════════════════
async function sectionE(): Promise<void> {
  console.log('\n【E】去重：平台 id 跨重启，正文 30s 窗');

  {
    const db = mkDb();
    const w = wire(db, 'ch-e1', 'feishu');
    await w.handler('e-user-1', '查看系统状态', 'direct', { messageId: 'MID-1' });
    await w.handler('e-user-1', '查看系统状态', 'direct', { messageId: 'MID-1' });
    eq(convRows(db).length, 1, 'E1 同平台 id 第二次 ⇒ 被挡（只落 1 行）');
    const seen = db.prepare('SELECT COUNT(*) AS n FROM wa_im_seen').get() as { n: number };
    eq(Number(seen.n), 1, 'E2 持久去重账恰 1 行（跨重启仍挡）');
  }
  {
    const db = mkDb();
    const w = wire(db, 'ch-e2', 'wechat-personal');
    await w.handler('e-user-2', '客厅有点热', 'direct', {});
    await w.handler('e-user-2', '客厅有点热', 'direct', {});
    eq(convRows(db).length, 1, 'E3 无平台 id、同正文 30s 内 ⇒ 被挡');

    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 31_000;
      await w.handler('e-user-2', '客厅有点热', 'direct', {});
    } finally {
      Date.now = realNow;
    }
    eq(convRows(db).length, 2, 'E4 30s 后同正文可再收（窗口到期即放行）');
  }
}

// ═══ F｜反证：长度不再是建单依据 ═════════════════════════════════════════════
async function sectionF(): Promise<void> {
  console.log('\n【F】反证：5/6 字闲聊不再建单');

  {
    const db = mkDb();
    const w = wire(db, 'ch-f1', 'wechat-personal');
    await w.handler('f-user-1', '客厅有点热', 'direct', {});
    eq(taskRows(db).length, 0, 'F1 5 字随口一说 ⇒ 零建单');
    // zx_20261112_2 B2：模型补漏**试过但失败**（本例取不到可用模型）⇒ 如实说服务不可用；仍零建单。
    eq(w.replies, [LLM_UNAVAILABLE_TEXT], 'F2 模型不可用时如实说，不假装"已创建任务"');
    eq(convRows(db)[0]!.route, 'ambiguous', 'F3 路由如实记 ambiguous');
  }
  {
    const db = mkDb();
    const w = wire(db, 'ch-f2', 'wechat-personal');
    await w.handler('f-user-2', '今天天气不错', 'direct', {});
    eq(taskRows(db).length, 0, 'F4 6 字闲聊 ⇒ 零建单');
    eq(w.replies, [LLM_UNAVAILABLE_TEXT], 'F5 同样如实说服务不可用，不建单');
  }
  {
    const src = fs.readFileSync(path.join(DESKTOP, 'src/main/services/im-router.ts'), 'utf-8');
    const code = stripKeepingLines(src).join('\n');
    ok(!/length\s*>\s*4/.test(code), 'F6 路由代码里不再有 `length > 4` 判据（注释说明除外）');
    ok(code.includes('LLM_INTENT_MIN_CHARS = 5'), 'F7 长度只剩"值不值得问模型"的成本闸（5 字）');
    ok(src.includes('长度是成本闸'), 'F8 源码写明：长度是成本闸、不是建单依据');
  }
}

// ═══ G｜审计模块：只读、先闸后读、CSV ════════════════════════════════════════
const LIC_NOW = new Date('2026-11-08T00:00:00.000Z');
const LIC_OPTS = { now: LIC_NOW, fingerprint: 'AAAA-BBBB-CCCC-DDDD' };

function auditDbFixture(): AnyDb {
  const db = mkDb();
  db.prepare("INSERT INTO wa_im_channels (id, channel_type, name) VALUES ('ch-a', 'feishu', '飞书链路')").run();
  db.prepare("INSERT INTO wa_im_channels (id, channel_type, name) VALUES ('ch-b', 'wecom', '企微链路')").run();
  const ins = db.prepare(
    `INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, task_id, intent, route, route_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run('r1', 'ch-a', 'u1', JSON.stringify({ text: '创建任务 写脚本' }), 'inbound', 't1', 'create_task', 'create', '含建单动词——按建单处理');
  ins.run('r2', 'ch-a', 'u2', JSON.stringify({ body: '查看系统状态' }), 'inbound', '', 'query_status', 'query', '含查询信号且无强建单动词——按查询处理');
  ins.run('r3', 'ch-b', 'u3', 'not-json', 'inbound', '', 'ambiguous', 'ambiguous', '规则未命中、也没有可靠的模型结论');
  ins.run('r4', 'ch-a', 'bot', JSON.stringify({ text: '✅ 已创建任务' }), 'outbound', 't1', '', '', '');
  return db;
}

/** 只数 `prepare` 的 SQL：用来证"锁定档位不读审计表"。 */
function countingDb(db: AnyDb): { proxy: IntentAuditDb; sqls: string[] } {
  const sqls: string[] = [];
  const proxy = new Proxy(db as object, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => { sqls.push(sql); return (target as AnyDb).prepare(sql); };
      }
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as unknown as IntentAuditDb;
  return { proxy, sqls };
}

function settingsDb(trialStartIso: string | null): LicenseSettingDb {
  const d = new DatabaseSync(':memory:');
  d.exec("CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))");
  if (trialStartIso) {
    d.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)').run(LICENSE_SETTING_KEYS.trialStartedAt, trialStartIso);
  }
  return d as unknown as LicenseSettingDb;
}

function sectionG(): void {
  console.log('\n【G】审计模块：只读、先闸后读、CSV');

  {
    const db = auditDbFixture();
    const r = listIntentAudit(db, {});
    eq(r.total, 3, 'G1 total 只数入站（出站行不计）');
    eq(r.rows.map((x) => x.id), ['r3', 'r2', 'r1'], 'G2 最新在上（按插入序倒序）');
    eq(r.rows[2]!.text, '创建任务 写脚本', 'G3 正文摘要取 message_json.text');
    eq(r.rows[1]!.text, '查看系统状态', 'G4 正文摘要回落 message_json.body');
    eq(r.rows[0]!.text, '', 'G5 坏 JSON 不抛、摘要如实留空');
    eq(r.rows[2]!.channelName, '飞书链路', 'G6 渠道名经 LEFT JOIN 取到');
    eq(r.rows[2]!.taskId, 't1', 'G7 关联任务 id 如实带出');
    eq(r.rows[1]!.taskId, null, 'G8 无任务 ⇒ null（不塞空串假 id）');

    const filtered = listIntentAudit(db, { channelId: 'ch-a' });
    eq([filtered.total, filtered.rows.length], [2, 2], 'G9 按渠道筛选：total 与 rows 同一 WHERE');
    const paged = listIntentAudit(db, { limit: 1, offset: 1 });
    eq([paged.total, paged.rows.map((x) => x.id)], [3, ['r2']], 'G10 分页只缩 rows，total 仍是全量');
    const clamped = listIntentAudit(db, { limit: 9999 });
    eq(clamped.rows.length, 3, 'G11 超上限被夹到 MAX_LIMIT（仍有数据可读）');
  }
  {
    const db = auditDbFixture();
    const rows: IntentAuditRow[] = listIntentAudit(db, {}).rows;
    const csv = intentAuditCsv(rows);
    const lines = csv.split('\n');
    eq(lines[0], '创建时间,渠道,用户,意图,路由,理由,任务ID,正文', 'G12 CSV 表头中文一处真源');
    eq(lines.length, rows.length + 1, 'G13 行数 = 数据行 + 表头');
    const tricky: IntentAuditRow = {
      id: 'x', channelId: 'c', channelName: '含,逗号', externalUserId: 'u"q', intent: 'create_task',
      route: 'create', routeReason: 'line1\nline2', taskId: null, createdAt: '2026-11-08 01:02:03', text: '正文,带逗号',
    };
    const csv2 = intentAuditCsv([tricky]);
    ok(csv2.includes('"含,逗号"'), 'G14 逗号字段被引号包裹');
    ok(csv2.includes('"u""q"'), 'G15 引号按 RFC4180 双写');
    ok(csv2.includes('"line1\nline2"'), 'G16 换行字段被引号包裹');
  }
  {
    const db = auditDbFixture();
    const locked = settingsDb(null);
    const { proxy, sqls } = countingDb(db);
    const before = sqls.length;
    const r = listIntentAuditGated(proxy, locked, {}, LIC_OPTS);
    eq(r.unlocked, false, 'G17 社区档 ⇒ 审计视图锁定');
    ok(r.unlocked === false && r.refusal.length > 0, 'G18 拒因如实给出（不是空表冒充成功）', r.unlocked === false ? r.refusal : '');
    eq(r.rows, [], 'G19 锁定 ⇒ 零行');
    eq(r.total, 0, 'G20 锁定 ⇒ total 0');
    const touched = sqls.slice(before).filter((s) => /wa_im_conversations/.test(s));
    eq(touched.length, 0, 'G21 锁定 ⇒ 不读审计表（先闸后读）');
  }
  {
    const db = auditDbFixture();
    const locked = settingsDb(null);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-b3-locked-'));
    const target = path.join(dir, 'nested', 'im-intent.csv');
    const { proxy, sqls } = countingDb(db);
    const before = sqls.length;
    const r = exportIntentAuditCsvGated(proxy, locked, target, {}, LIC_OPTS);
    eq(r.unlocked, false, 'G22 社区档 ⇒ 审计导出锁定');
    ok(!fs.existsSync(path.join(dir, 'nested')), 'G23 锁定 ⇒ 不建目录（先闸后写）');
    ok(!fs.existsSync(target), 'G24 锁定 ⇒ 不落文件');
    const touched = sqls.slice(before).filter((s) => /wa_im_conversations/.test(s));
    eq(touched.length, 0, 'G25 锁定 ⇒ 不读审计表');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const db = auditDbFixture();
    const trial = settingsDb('2026-11-07T00:00:00.000Z');
    const r = listIntentAuditGated(db, trial, {}, LIC_OPTS);
    eq(r.unlocked, true, 'G26 试用期 ⇒ 放行（与 Team 同尺）');
    eq(r.rows.length, 3, 'G27 放行后读到全部入站行');
    const only = listIntentAuditGated(db, trial, { channelId: 'ch-b' }, LIC_OPTS);
    eq(only.unlocked === true ? only.rows.map((x) => x.id) : [], ['r3'], 'G28 渠道筛选在闸后照常生效');
  }
  {
    const db = auditDbFixture();
    const trial = settingsDb('2026-11-07T00:00:00.000Z');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-b3-export-'));
    try {
      const target = path.join(dir, 'exports', 'im-intent.csv');
      const r = exportIntentAuditCsvGated(db, trial, target, {}, LIC_OPTS);
      eq([r.unlocked, r.saved, r.rows], [true, true, 3], 'G29 放行后导出成功且行数如实');
      ok(fs.existsSync(target), 'G30 文件真的落在指定路径');
      const content = fs.readFileSync(target, 'utf8');
      ok(content.startsWith('创建时间,渠道'), 'G31 文件内容是可读 CSV（表头在首行）');
      ok(content.includes('飞书链路') && content.includes('企微链路'), 'G32 渠道名如实入表');

      const only = exportIntentAuditCsvGated(db, trial, path.join(dir, 'exports', 'only-b.csv'), { channelId: 'ch-b' }, LIC_OPTS);
      eq(only.unlocked === true ? only.rows : -1, 1, 'G33 导出吃筛选（不是分页）');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  {
    const db = auditDbFixture();
    const trial = settingsDb('2026-11-07T00:00:00.000Z');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-b3-fail-'));
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    try {
      const r = exportIntentAuditCsvGated(db, trial, path.join(blocker, 'x.csv'), {}, LIC_OPTS);
      eq([r.unlocked, r.saved], [true, false], 'G34 落盘失败 ⇒ saved=false（不谎报成功）');
      ok(r.unlocked === true && r.error.length > 0, 'G35 失败真因如实返回', r.unlocked === true ? r.error : '');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
}

// ═══ H｜接线与构建钉 ═════════════════════════════════════════════════════════
function sectionH(): void {
  console.log('\n【H】接线：库列/表、IPC、面板、适配器、构建钉');

  const read = (rel: string) => fs.readFileSync(path.join(DESKTOP, rel), 'utf-8');
  const dbSrc = read('src/main/database.ts');
  ok(dbSrc.includes("ALTER TABLE wa_im_conversations ADD COLUMN intent TEXT"), 'H1 迁移：intent 列');
  ok(dbSrc.includes("ALTER TABLE wa_im_conversations ADD COLUMN route TEXT"), 'H2 迁移：route 列');
  ok(dbSrc.includes("ALTER TABLE wa_im_conversations ADD COLUMN route_reason TEXT"), 'H3 迁移：route_reason 列');
  ok(/CREATE TABLE IF NOT EXISTS wa_im_seen/.test(dbSrc), 'H4 迁移：`wa_im_seen` 持久去重账');
  ok(dbSrc.includes('PRIMARY KEY (channel_id, external_user_id, platform_message_id)'), 'H5 去重账主键 = 三元组');

  const ipcSrc = read('src/main/ipc/im.ipc.ts');
  ok(ipcSrc.includes("ipcMain.handle('im:intentAudit'"), 'H6 IPC：im:intentAudit 已注册');
  ok(ipcSrc.includes("ipcMain.handle('im:intentAuditExport'"), 'H7 IPC：im:intentAuditExport 已注册');
  ok(ipcSrc.includes('listIntentAuditGated(') && ipcSrc.includes('exportIntentAuditCsvGated('), 'H8 IPC 直调审计真源（不在 handler 里另写一份判据）');

  const rendererIpc = fs.readFileSync(path.join(DESKTOP, 'renderer/src/lib/ipc.ts'), 'utf-8');
  ok(rendererIpc.includes("intentAudit:") && rendererIpc.includes("'im:intentAudit'"), 'H9 renderer IPC 暴露理解账读取');
  ok(rendererIpc.includes("intentAuditExport:") && rendererIpc.includes("'im:intentAuditExport'"), 'H10 renderer IPC 暴露理解账导出');

  const pageSrc = fs.readFileSync(path.join(DESKTOP, 'renderer/src/pages/IMPage.tsx'), 'utf-8');
  ok(pageSrc.includes('INTENT_LABEL') && pageSrc.includes('ROUTE_LABEL'), 'H11 面板：意图/路由徽标词表');
  ok(pageSrc.includes('im.intentAudit(') && pageSrc.includes('im.intentAuditExport('), 'H12 面板真的调了读取/导出接口');
  ok(pageSrc.includes('理解账'), 'H13 面板有理解账区块');
  ok(pageSrc.includes('/tasks/${c.task_id}') || pageSrc.includes('navigate(`/tasks/'), 'H14 关联任务可跳转');

  const adapterSrc = read('src/main/services/im-adapter.ts');
  ok(adapterSrc.includes('mentionsBot?: boolean') && adapterSrc.includes('mentions?: string[]'), 'H15 契约：ImMessageMeta 增 mentionsBot/mentions');
  const dingSrc = read('src/main/services/dingtalk-adapter.ts');
  ok(dingSrc.includes('isInAtList') && dingSrc.includes('mentionsBot'), 'H16 钉钉：平台给了就填 mentionsBot');
  const feiSrc = read('src/main/services/feishu-adapter.ts');
  ok(feiSrc.includes('mentionsBot') && feiSrc.includes("chatType === 'group'"), 'H17 飞书：群聊有 mention 才置 true');
  const qqSrc = read('src/main/services/qqbot-adapter.ts');
  ok(qqSrc.includes('mentionsBot') && qqSrc.includes('GROUP_AT_MESSAGE_CREATE'), 'H18 QQ：@ 事件判定');
  const wecomSrc = read('src/main/services/wecom-adapter.ts');
  ok(!stripKeepingLines(wecomSrc).join('\n').includes('mentionsBot'),
    'H19 企微：平台不提供 @ 信息 ⇒ 代码里不填（群聊按未 @ 处理；注释说明不算接线）');

  const routerSrc = read('src/main/services/im-router.ts');
  ok(routerSrc.includes('decideImIntent('), 'H20 路由只执行判定（引纯函数）');
  ok(routerSrc.includes('markInboundDecision(') && routerSrc.includes('markInboundRoute('), 'H21 判定与上下文路由都落库');
  const createCall = routerSrc.indexOf('linkInboundTask(ctx.db, inboundId, taskId)');
  ok(createCall > 0, 'H22 建单成功回写 task_id');
  ok(routerSrc.includes('markInboundRoute(ctx.db, inboundId, \'preference\'') || routerSrc.includes("markInboundRoute(ctx.db, inboundId, 'preference'"), 'H23 偏好分支也记路由');
  ok(routerSrc.includes("inGroupNoMention"), 'H24 群聊未 @ 时上下文分支整段不认领');

  const { tag } = deriveBuildTag(read('src/main/core/agent-executor.ts'));
  ok(buildNotOlderThan(tag, SELF_ROUND), 'H25 build 标识不早于脚本轮次（方向性派生）', `${tag} vs ${SELF_ROUND}`);
  checkBuildPins(ok, { rootDir: ROOT });
}

async function main(): Promise<void> {
  const restore = stubFetch();
  try {
    sectionA();
    await sectionB();
    await sectionC();
    await sectionD();
    await sectionE();
    await sectionF();
    sectionG();
    sectionH();
  } finally {
    restore();
  }
  console.log(`\n[rr_${SELF_ROUND}_im] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
