/**
 * zx_20261110_1 B1「准」受控回归 —— IM 意图规则层（维特根斯坦·意义即用法 / 亚里士多德·四因）。
 *
 * 病根：软研究词（分析/搜索/查一下/调查/写/生成）被当成"建单动词"，否定句「先别创建任务，看看进展」
 *   也被当成建单。本轮把词表与判定收进纯函数 `classifyImText`，`im-intent.ts` 与 `im-commands.ts`
 *   共用同一份；只有**强建单词**才授权建单。
 *
 * 钉住四件事：
 *   A 词法分类：强建单 / 软研究待澄清 / 查询 / 无线索；否定子句的动词不算数；
 *   B 意图判定：软研究与否定句不再落建单，纯查询照答，显式建单照建；
 *   C 单一真源：CREATE_REGEX 已消失，im-commands 的建单词表即 `classifyImText`；
 *   D 旧结构钉不回退：im-intent 仍从 im-commands 引 HELP/QUERY/START，计数不变；rules 模块零 import（无环）。
 *
 * 纪律：轮次值由文件名派生；断言文案不含失败字形。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { classifyImText, parseIntentToken } from '../apps/worker-ant-desktop/src/main/core/im-intent-rules.js';
import { decideImIntent } from '../apps/worker-ant-desktop/src/main/core/im-intent.js';
import {
  INTENT_CONFIRMATION_SUMMARY_CHARS, INTENT_CONFIRMATION_TTL_MS,
  buildPendingIntent, confirmationKey, intentConfirmationPrompt, parseConfirmationReply, summarizeIntentText,
} from '../apps/worker-ant-desktop/src/main/core/im-intent-confirmation.js';
import { routeImMessage } from '../apps/worker-ant-desktop/src/main/services/im-router.js';
import { buildNotOlderThan, checkBuildPins, deriveBuildTag, stripKeepingLines } from './lib/rr-pins.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'apps/worker-ant-desktop');
const RULES = path.join(DESKTOP, 'src/main/core/im-intent-rules.ts');
const INTENT = path.join(DESKTOP, 'src/main/core/im-intent.ts');
const COMMANDS = path.join(DESKTOP, 'src/main/services/im-commands.ts');
const ROUTER = path.join(DESKTOP, 'src/main/services/im-router.ts');
const DATABASE = path.join(DESKTOP, 'src/main/database.ts');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

console.log(`\n【A】词法分类 ${SELF_ROUND}`);
{
  const cases: Array<{ text: string; kind: string; negated?: boolean }> = [
    { text: '创建任务：分析日志', kind: 'create' },
    { text: '新建一个任务', kind: 'create' },
    { text: '帮我做一份报表', kind: 'create' },
    { text: 'build a report', kind: 'create' },
    { text: '分析一下昨天的日志', kind: 'ambiguous' },
    { text: '写一份周报', kind: 'ambiguous' },
    { text: '搜索相关资料', kind: 'ambiguous' },
    { text: '查一下今天的进展', kind: 'ambiguous' },
    { text: '查询系统状态', kind: 'query' },
    { text: '看看项目进展', kind: 'query' },
    { text: '先别创建任务，看看进展', kind: 'query', negated: true },
    { text: '不用建了', kind: 'none', negated: true },
    { text: '别分析了', kind: 'none', negated: true },
    { text: '特别关注一下进展', kind: 'query', negated: false },
    { text: '分别查看两个项目状态', kind: 'query', negated: false },
    { text: '客厅有点热', kind: 'none' },
    { text: '', kind: 'none' },
  ];
  cases.forEach((c, i) => {
    const cls = classifyImText(c.text);
    eq(cls.kind, c.kind, `A${i + 1} 「${c.text || '(空)'}」⇒ ${c.kind}`, cls.evidence.join('/'));
    if (c.negated !== undefined) eq(cls.negated, c.negated, `A${i + 1}n 否定修饰=${c.negated}`);
    ok(cls.evidence.every((e) => e.length > 0 && !e.includes('✗') && !e.includes('✓')), `A${i + 1}e 证据文案无失败字形`);
  });

  const strongWins = classifyImText('创建任务：分析日志');
  ok(strongWins.evidence.includes('强建单词') && strongWins.evidence.includes('软研究词'),
    'A18 强建单优先：软研究词同行也落建单', strongWins.evidence.join('/'));

  const negatedOnly = classifyImText('先别创建任务');
  ok(negatedOnly.negated && negatedOnly.kind !== 'create', 'A19 否定子句里的建单动词不算数', negatedOnly.kind);

  // zx_20261112_2 B2：数值置信那把尺已收掉（全仓零消费）——断言改钉**真正驱动路由的 kind**。
  ok(classifyImText('创建任务').kind === 'create' && classifyImText('查看状态').kind === 'query',
    'A20 词法分类：显式建单 / 显式查询各归其位');
  ok(classifyImText('写一份周报').kind === 'ambiguous' && classifyImText('客厅有点热').kind === 'none',
    'A21 词法分类：软研究待澄清 / 无信号 none');
}

console.log('\n【B】意图判定：软研究与否定句不再建单');
{
  const cases: Array<{ text: string; want: [string, string]; chatType?: string }> = [
    { text: '先别创建任务，看看进展', want: ['query_status', 'query'] },
    { text: '分析一下昨天的日志', want: ['ambiguous', 'ambiguous'] },
    { text: '写一份周报', want: ['ambiguous', 'ambiguous'] },
    { text: '刷新一下周报的进展', want: ['query_status', 'query'] },
    { text: '不用建了', want: ['ambiguous', 'ambiguous'] },
    { text: '查看系统状态', want: ['query_status', 'query'] },
    { text: '创建任务 写脚本', want: ['create_task', 'create'] },
    { text: '帮我看看项目进展', want: ['query_status', 'query'] },
    { text: '开始 整理周报', want: ['start_task', 'start'] },
    { text: '先别创建任务，看看进展', chatType: 'group', want: ['query_status', 'query'] },
  ];
  const decisions = cases.map((c, i) => {
    const d = decideImIntent(c.chatType ? { text: c.text, chatType: c.chatType } : { text: c.text });
    eq([d.intent, d.route], c.want, `B${i + 1} 「${c.text}」${c.chatType ? `/${c.chatType}` : ''} ⇒ ${c.want[0]}/${c.want[1]}`);
    ok(d.reason.trim().length > 0 && !d.reason.includes('✗') && !d.reason.includes('✓'), `B${i + 1}r 理由非空且无失败字形`);
    return d;
  });
  ok(decisions.every((d) => d.route !== 'create' || d.reason.includes('强建单词') || d.reason.includes('@项目名')),
    'B11 落建单的判定都有可核证据（强建单/@项目）');
}

console.log('\n【C】单一真源：词表只有一份');
{
  const cmdCode = stripKeepingLines(fs.readFileSync(COMMANDS, 'utf-8')).join('\n');
  const intentCode = stripKeepingLines(fs.readFileSync(INTENT, 'utf-8')).join('\n');
  const rulesCode = stripKeepingLines(fs.readFileSync(RULES, 'utf-8')).join('\n');

  ok(!cmdCode.includes('CREATE_REGEX') && !intentCode.includes('CREATE_REGEX'),
    'C1 源码里不再有 CREATE_REGEX（建单不再由第二套词表决定）');
  ok(/classifyImText\(s\)\.kind === 'create'/.test(cmdCode),
    'C2 帮助表「创建任务」的谓词 = classifyImText（与路由器同源）');
  ok(/import \{ classifyImText \} from '\.\.\/core\/im-intent-rules\.js'/.test(cmdCode),
    'C3 im-commands 从纯规则模块引入词表（非二次手抄）');
  ok(/import \{ classifyImText, type ImIntentToken \} from '\.\/im-intent-rules\.js'/.test(intentCode),
    'C4 im-intent 从纯规则模块引入词表与 token 类型（同一处真源）');
  ok(/import \{ HELP_REGEX, QUERY_REGEX, START_REGEX \} from '\.\.\/services\/im-commands\.js'/.test(intentCode),
    'C5 im-intent 仍从唯一真源引帮助/查询/启动谓词（旧结构钉不回退）');
  eq((intentCode.match(/QUERY_REGEX/g) || []).length, 2, 'C6 QUERY_REGEX 仍是一引入一使用（2 处）');
  eq((intentCode.match(/HELP_REGEX/g) || []).length, 2, 'C7 HELP_REGEX 仍是一引入一使用（2 处）');
  ok(!/from\s+['"]/.test(rulesCode),
    'C8 规则模块零 import（不与 im-commands/im-intent 形成环）');
  ok(rulesCode.includes('SOFT_RESEARCH_RE') && !/SOFT_RESEARCH_RE\s*=\s*\/\([^)]*帮我/.test(rulesCode),
    'C9 「帮我」不被当作软研究词（礼貌前缀不是产出请求）', 'SOFT_RESEARCH_RE 定义处');
}

console.log('\n【E】模型输出单 token 严格解析（B2）');
{
  eq(parseIntentToken('create_task'), 'create_task', 'E1 原样单 token');
  eq(parseIntentToken('  Create_Task.\n'), 'create_task', 'E2 大小写/首尾空白/句末标点可容忍');
  eq(parseIntentToken('`query_status`'), 'query_status', 'E3 引号/反引号包装可容忍');
  eq(parseIntentToken('I think create_task'), null, 'E4 带解释的正文不认');
  eq(parseIntentToken('create_task, but maybe query_status'), null, 'E5 多词回包不认（旧 includes 会判成建单）');
  eq(parseIntentToken('create_task_or_query'), null, 'E6 词内拼接不认');
  eq(parseIntentToken('create task'), null, 'E7 空格分词不认（只认单 token）');
  eq(parseIntentToken('ambiguous'), null, 'E8 ambiguous 不是模型可输出的词');
  eq(parseIntentToken(''), null, 'E9 空回包不认');
}

console.log('\n【F】确认分支纯判定（B2）');
{
  const p = buildPendingIntent('create', '  帮我安排一个周报  ', 1000);
  eq(p.expiresAt, 1000 + INTENT_CONFIRMATION_TTL_MS, 'F1 TTL 30 分钟');
  eq(p.summary, '帮我安排一个周报', 'F2 摘要压成一行（去多余空白）');
  ok(p.text.includes('帮我安排一个周报'), 'F3 执行按原话，不按摘要/确认词');
  const long = '周'.repeat(INTENT_CONFIRMATION_SUMMARY_CHARS + 20);
  const cut = summarizeIntentText(long);
  ok(cut.endsWith('…') && cut.length === INTENT_CONFIRMATION_SUMMARY_CHARS + 1,
    'F4 超长摘要截断并加省略号', `${cut.length} 字`);
  ok(intentConfirmationPrompt('create', '周报').includes('建单'), 'F5 建单提示词动作名');
  ok(intentConfirmationPrompt('start', '周报').includes('启动'), 'F6 启动提示词动作名');
  ok(intentConfirmationPrompt('create', '周报').includes('确认') && intentConfirmationPrompt('create', '周报').includes('取消'),
    'F7 两个出口都在提示里');
  eq(parseConfirmationReply('确认'), 'confirm', 'F8 确认');
  eq(parseConfirmationReply('确认。'), 'confirm', 'F9 确认 + 句号');
  eq(parseConfirmationReply('确认一下'), 'confirm', 'F10 确认 + 语气尾巴');
  eq(parseConfirmationReply('是'), 'confirm', 'F11 是');
  eq(parseConfirmationReply('yes'), 'confirm', 'F12 yes');
  eq(parseConfirmationReply('取消'), 'cancel', 'F13 取消');
  eq(parseConfirmationReply('否'), 'cancel', 'F14 否');
  eq(parseConfirmationReply('不用了'), 'cancel', 'F15 不用了');
  eq(parseConfirmationReply('确认执行'), null, 'F16 带宾语长句不认（整句匹配，不是子串）');
  eq(parseConfirmationReply('先确认一下这个任务'), null, 'F17 句中含确认词不认');
  eq(parseConfirmationReply('1'), null, 'F18 编号不是确认词');
  eq(parseConfirmationReply(''), null, 'F19 空回复');
  eq(confirmationKey('feishu', 'u1'), 'feishu:u1', 'F20 待确认项的键 = 渠道:用户');
}

console.log('\n【G】模型层与确认分支接线（静态）');
{
  const routerCode = stripKeepingLines(fs.readFileSync(ROUTER, 'utf-8')).join('\n');
  const dbCode = fs.readFileSync(DATABASE, 'utf-8');
  ok(!routerCode.includes('gpt-3.5-turbo'), 'G1 不再回落默认模型名');
  ok(routerCode.includes('!modelData.model_name'), 'G2 缺 model_name 即放弃（并 warn 留痕）');
  ok(routerCode.includes('parseIntentToken(raw)'), 'G3 模型回包走严格单 token 解析');
  ok(!/intent\.includes\(/.test(routerCode), 'G4 不再对模型回包做 includes 子串扫描');
  ok(routerCode.includes('pendingIntentConfirmations') && routerCode.includes('handleIntentConfirmation('),
    'G5 确认分支真的接线（不是只建了纯模块）');
  ok(routerCode.includes('intentConfirmationPrompt(') && routerCode.includes('buildPendingIntent('),
    'G6 提示与待确认状态都取自纯模块');
  ok(routerCode.includes("decision.confidence === 'medium'"), 'G7 只有中置信才走确认');
  ok(routerCode.includes('intent_confidence'), 'G8 置信度写进入站行');
  ok(dbCode.includes('ALTER TABLE wa_im_conversations ADD COLUMN intent_confidence TEXT'),
    'G9 迁移：intent_confidence 列');
  ok(routerCode.includes('withDecisionSource('), 'G10 route_reason 带规则/模型来源标注');
}

console.log('\n【D】构建钉');
{
  const { tag } = deriveBuildTag(fs.readFileSync(path.join(DESKTOP, 'src/main/core/agent-executor.ts'), 'utf-8'));
  ok(buildNotOlderThan(tag, SELF_ROUND), 'D1 build 标识不早于脚本轮次（方向性派生）', `${tag} vs ${SELF_ROUND}`);
  checkBuildPins(ok, { rootDir: ROOT });
}

// ─────────────────────────────────────────────────────────────
// H｜端到端：模型中置信建单 → 先问 → 确认后才动手（B2）
// ─────────────────────────────────────────────────────────────

/** 与 `database.ts` 同形的**最小**夹具（够路由走到建单/确认；列不齐会在这里先炸）。 */
const IM_SCHEMA = `
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, name TEXT DEFAULT '', config TEXT NOT NULL DEFAULT '{}', status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_im_conversations (
  id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, project_id TEXT,
  message_json TEXT DEFAULT '{}', direction TEXT DEFAULT 'inbound',
  created_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'sent', last_error TEXT DEFAULT '', outbox_id TEXT DEFAULT '',
  task_id TEXT DEFAULT '', intent TEXT DEFAULT '', route TEXT DEFAULT '', route_reason TEXT DEFAULT '',
  intent_confidence TEXT DEFAULT '');
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
  d.prepare("INSERT INTO wa_settings (key, value) VALUES ('im.busy_ack', 'false')").run();
  return d as unknown as AnyDb;
}

/** 回访种子行（zx_20261112_1 B3 抑制首聊欢迎用）在 message_json 打标记，不计入标本行。 */
const SEED_JSON = '{"seed":true}';
const convRows = (db: AnyDb) =>
  db.prepare('SELECT * FROM wa_im_conversations WHERE direction = ? AND COALESCE(message_json, \'\') <> ? ORDER BY rowid')
    .all('inbound', SEED_JSON) as Array<Record<string, any>>;
const taskRows = (db: AnyDb) => db.prepare('SELECT * FROM wa_tasks ORDER BY rowid').all() as Array<Record<string, any>>;

function wire(db: AnyDb, channelId: string, channelType: string) {
  const replies: string[] = [];
  const ictx = { db, channelId, channelType, sendReply: async (_to: string, t: string) => { replies.push(t); } };
  return {
    replies,
    handler: (from: string, text: string, chatType: string, meta?: Record<string, unknown>) => {
      // zx_20261112_1 B3: 回访用户入参——先落一条该用户历史 inbound，使首聊欢迎不占 replies[0]
      //（欢迎由 rr_zx_20261112_1 专测；本套测意图判定与确认）。
      db.prepare("INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction) VALUES (?,?,?,?,'inbound')")
        .run(`seed-${Math.random().toString(36).slice(2)}`, channelId, from, SEED_JSON);
      return routeImMessage(ictx as never, from, text, chatType, '', meta as never);
    },
  };
}

type ModelMode = 'create_task' | 'malformed' | 'missing_model';
let modelMode: ModelMode = 'create_task';

/** 假模型：ANS 取模型给一条完整条目，chat 回**可切换**的正文；其余请求一律拒绝（零真网）。 */
function stubModelFetch(): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/api/v1/models/optimal')) {
      return json(modelMode === 'missing_model'
        ? { url: 'http://model.test/v1', api_key: 'k' }
        : { url: 'http://model.test/v1', api_key: 'k', model_name: 'm' });
    }
    const content = modelMode === 'malformed' ? 'I think create_task, maybe query_status' : 'create_task';
    return json({ choices: [{ message: { content } }] });
  }) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

async function sectionH(): Promise<void> {
  console.log('\n【H】端到端：中置信建单先问、确认后才动手');
  const restore = stubModelFetch();
  try {
    {
      const db = mkDb();
      const w = wire(db, 'ch-h1', 'feishu');
      await w.handler('h-user-1', '帮我安排一个周报', 'direct', {});
      eq(taskRows(db).length, 0, 'H1 中置信建单：未确认前不建任务');
      ok(String(w.replies[0] ?? '').includes('回复「确认」执行'), 'H2 回话请用户确认', w.replies[0] ?? '');
      const row = convRows(db)[0]!;
      eq([row.route, row.intent, row.intent_confidence], ['confirmation', 'create_task', 'medium'],
        'H3 入站行记下「模型判了但没动手」');
      await w.handler('h-user-1', '确认', 'direct', {});
      eq(taskRows(db).length, 1, 'H4 确认后才真正建任务');
      ok(String(w.replies[1] ?? '').includes('已创建任务'), 'H5 执行回执到场', w.replies[1] ?? '');
      eq(convRows(db)[1]!.route, 'confirmation', 'H6 确认那一行也记确认路由');
    }
    {
      const db = mkDb();
      const w = wire(db, 'ch-h2', 'feishu');
      await w.handler('h-user-2', '帮我安排一个周报', 'direct', {});
      // 风暴闸按"同一用户 3 条/2s"计——三条真实消息须隔开，否则第 3 条被冷却吞掉，
      //   H9 会因"根本没处理"而假绿（测不到"确认已作废"）。
      await new Promise((r) => setTimeout(r, 2100));
      await w.handler('h-user-2', '取消', 'direct', {});
      eq(taskRows(db).length, 0, 'H7 取消后不建任务');
      ok(String(w.replies[1] ?? '').includes('已取消'), 'H8 取消回执如实', w.replies[1] ?? '');
      await new Promise((r) => setTimeout(r, 2100));
      await w.handler('h-user-2', '确认', 'direct', {});
      eq(taskRows(db).length, 0, 'H9 已取消的确认不再复活动作');
      ok(String(w.replies[2] ?? '').length > 0, 'H9b 第三条消息真的被处理（不是被风暴闸吞掉）', w.replies[2] ?? '');
    }
    {
      modelMode = 'malformed';
      const db = mkDb();
      const w = wire(db, 'ch-h3', 'feishu');
      await w.handler('h-user-3', '帮我安排一个周报', 'direct', {});
      eq(taskRows(db).length, 0, 'H10 畸形模型回包不建任务');
      ok(!String(w.replies[0] ?? '').includes('回复「确认」执行'), 'H11 畸形回包不进入确认分支', w.replies[0] ?? '');
      eq(convRows(db)[0]!.route, 'ambiguous', 'H12 畸形回包落到待澄清');
    }
    {
      modelMode = 'missing_model';
      const db = mkDb();
      const w = wire(db, 'ch-h4', 'feishu');
      await w.handler('h-user-4', '帮我安排一个周报', 'direct', {});
      eq(taskRows(db).length, 0, 'H13 缺 model_name 不建任务');
      eq(convRows(db)[0]!.route, 'ambiguous', 'H14 缺字段如实落到待澄清（不回落模型名）');
    }
  } finally {
    restore();
  }
}

void (async () => {
  await sectionH();
  console.log(`\n汇总: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
