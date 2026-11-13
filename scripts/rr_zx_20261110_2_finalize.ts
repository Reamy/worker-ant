/**
 * zx_20261110_2 B5 复跑 —— 「损」：**事已办成，账后置；问不动的就别问**。
 *
 * 病根（本方案 §2 基线 16:24:06→16:24:27）：任务标完完成、`task.completed` 已经发出之后，ai-task **仍**在
 * 关键路径上串着做 IM 通知、推件、记忆强化、工作记忆提升；同一段收尾里内容校验还可能白等满 12s、
 * 压缩与旁路校验都没有总预算/不可中止，世界扫描同一棵树被反复扫。
 *
 * 判据：
 *   F-1 大文档 ⇒ `skipped_large_doc`（**不判失败**、不冒充"问过"）；反证：小文档照样真去问；
 *   F-2 预算将尽 ⇒ **立即降级**（不发起模型调用、不多等）并记 `budget_short`；反证：预算充裕时**会**调用；
 *   F-3 收口事件先于后置账：ai-task 关键路径上不再有通知/推件/强化，后置账走幂等作业，且**按 run 身份**去重
 *       （同一终态的第二、三次完成仍各办一次——不是按"终态"去重）；
 *   F-4 压缩超总预算/被中止 ⇒ 回退**临时**规则摘要且**不推进边界**（没进摘要的行不得被永久遮蔽）；
 *   F-5 同一 workingDir 二次扫描命中缓存（计数 0→1），失败不缓存；反证：前后比对仍用 `scanWorkingDirOnce`。
 *
 * 纪律：真源直 import（`validateOutput` / `compactTaskConversations` / `postlude.ts` / 扫描缓存本尊），
 *       判据文案不含失败字形；无"只本轮为真"的字面量（轮次由 `path.basename(__filename)` 派生方向性比较）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines, buildNotOlderThan } from './lib/rr-pins.js';
import {
  validateOutput, summarizeUnverified, LLM_VALIDATION_TIMEOUT_MS, LLM_VALIDATION_MIN_ASK_MS,
  LARGE_DOC_SKIP_CHARS, SUFFICIENCY_WINDOW_DEFAULTS,
} from '../apps/worker-ant-desktop/src/main/core/output-validator.js';
import { compactTaskConversations } from '../apps/worker-ant-desktop/src/main/core/context-compaction-run.js';
import {
  POSTLUDE_JOB_TYPE, LAST_COMPLETED_RUN_KEY, POSTLUDE_DONE_RUN_KEY,
  markCompletedRun, lastCompletedRunKey, postludeDoneRun, markPostludeDone, postludeDue,
} from '../apps/worker-ant-desktop/src/main/core/postlude.js';
import {
  scanWorkingDirCached, factListingCached, scanCacheStats, clearScanCache,
} from '../apps/worker-ant-desktop/src/main/core/working-dir-scan-cache.js';

type AnyDb = import('better-sqlite3').Database;

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const SELF_ROUND = /^(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''))?.[1] ?? '';
const A = 'apps/worker-ant-desktop';
const CODE = (rel: string) => stripKeepingLines(fs.readFileSync(path.join(root, rel), 'utf-8')).join('\n');

const SCHEMA = `
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT DEFAULT 'active',
  working_dir TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', priority INTEGER DEFAULT 0,
  depends_on TEXT DEFAULT '', parent_task_id TEXT '', source TEXT DEFAULT 'user',
  acceptance_criteria TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending', retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
  scheduled_at TEXT, started_at TEXT, completed_at TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_event_log (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, aggregate_type TEXT DEFAULT '',
  aggregate_id TEXT DEFAULT '', payload TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
`;

function mkdb(): AnyDb {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare("INSERT INTO wa_projects (id, name) VALUES ('p1', '项目')").run();
  return db as unknown as AnyDb;
}
function addTask(db: AnyDb, id: string, status: string, contextJson = '{}'): void {
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'p1', '任务', status, contextJson);
}
function ctxOf(db: AnyDb, id: string): Record<string, unknown> {
  const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json?: string } | undefined;
  return JSON.parse(row?.context_json || '{}');
}

/** 取 `anchor` 之后**配平**的那个花括号块（静态判据按块取，不按行号）。 */
function blockAfter(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return '';
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-rr-finalize-'));
}

/** 一份能过 document 快检、又足够长的文档正文。 */
function docBody(chars: number): string {
  const para = '这是用于受控复跑的正文段落，逐句铺陈以撑到达标长度。';
  return `# 大文档\n\n${para.repeat(Math.ceil(chars / para.length))}\n\n## 结论\n正文合规，结论如上。\n`;
}

function fakeAns(counter: { calls: number }) {
  return {
    getOptimalModel: async () => {
      counter.calls++;
      // 端口 9（discard）几乎立刻拒绝连接：**不会真联网**，只为证明"走到了调用这一步"。
      return { url: 'http://127.0.0.1:9', api_key: 'rr-not-a-real-key', model_name: 'rr-probe' };
    },
  } as never;
}

async function main(): Promise<void> {
  // ═══ K｜构建钉 ═══════════════════════════════════════════════════════════
  console.log('\n【K】构建钉');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  {
    const src = fs.readFileSync(path.join(root, `${A}/src/main/core/agent-executor.ts`), 'utf-8');
    const tag = /build:\s*'(zx_[0-9_]+)'/.exec(stripKeepingLines(src).join('\n'))?.[1] ?? '';
    ok(!!tag && buildNotOlderThan(tag, SELF_ROUND), 'K-7 当前 build 快照不早于本脚本轮次（方向性比较）', `${tag} vs ${SELF_ROUND}`);
    ok(fs.existsSync(path.join(root, `${A}/src/main/core/postlude.ts`)), 'K-8 后置账模块在册（身份/去重口一处真源）');
  }

  // ═══ F-1｜大文档不再逐条问（不是失败） ═══════════════════════════════════
  console.log('\n【F-1】大文档 ⇒ `skipped_large_doc`：保留规则/快检结论，不判失败、不冒充问过');
  {
    const dir = tmpDir();
    const big = path.join(dir, 'big.md');
    const body = docBody(LARGE_DOC_SKIP_CHARS + 6_000);
    fs.writeFileSync(big, body, 'utf-8');
    const counter = { calls: 0 };
    const r = await validateOutput(fakeAns(counter), big, 'document');
    ok(r.status !== 'insufficient', 'F-1a 不判"内容不足"（"没问"≠"不足"）', String(r.status));
    eq(r.status, 'unknown', 'F-1b 如实记"未核"');
    eq(r.sufficient, true, 'F-1c 不因此拦下收口');
    eq(r.llmCheck?.reasonCode, 'skipped_large_doc', 'F-1d 原因码单列 `skipped_large_doc`');
    ok(String(r.llmCheck?.reason ?? '').includes('未逐条问'), 'F-1e 文案说清"没问"，不是"问过且不足"');
    ok(body.length > LARGE_DOC_SKIP_CHARS, 'F-1f 标本确实超过跳过阈值（判据在作用域内）');
    eq(counter.calls, 1, 'F-1g 选型仍走了一次（跳过发生在快检之后，不是"整条腿关掉"）');
    ok(LARGE_DOC_SKIP_CHARS > SUFFICIENCY_WINDOW_DEFAULTS.headChars + SUFFICIENCY_WINDOW_DEFAULTS.tailChars,
      'F-1h 跳过阈值高于覆盖窗口本身（否则"送不全"被当成"太长"）',
      `${LARGE_DOC_SKIP_CHARS} vs ${SUFFICIENCY_WINDOW_DEFAULTS.headChars + SUFFICIENCY_WINDOW_DEFAULTS.tailChars}`);

    // 反证：小文档不该被跳过（否则 F-1 只是"永远不走这条腿"的自我印证）。
    const small = path.join(dir, 'small.md');
    fs.writeFileSync(small, docBody(1_200), 'utf-8');
    const counter2 = { calls: 0 };
    const r2 = await validateOutput(fakeAns(counter2), small, 'document', { deadlineAt: Date.now() + LLM_VALIDATION_TIMEOUT_MS });
    ok(r2.llmCheck?.reasonCode !== 'skipped_large_doc', 'F-1i 反证：小文档不走跳过支', String(r2.llmCheck?.reasonCode));
    eq(counter2.calls, 1, 'F-1j 反证：小文档确实发起了问（真联网会被端口 9 立刻拒，故必为 `http_error` 一路）');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ═══ F-2｜预算将尽 ⇒ 立即降级 ════════════════════════════════════════════
  console.log('\n【F-2】预算将尽 ⇒ 立即降级（不发起调用、不等满 12s），原因码 `budget_short`');
  {
    const dir = tmpDir();
    const f = path.join(dir, 'ok.md');
    fs.writeFileSync(f, docBody(1_200), 'utf-8');

    const counter = { calls: 0 };
    const t0 = Date.now();
    const r = await validateOutput(fakeAns(counter), f, 'document', { deadlineAt: Date.now() + Math.floor(LLM_VALIDATION_MIN_ASK_MS / 4) });
    const elapsed = Date.now() - t0;
    eq(counter.calls, 0, 'F-2a 未发起模型调用（"问了也来不及"就不问）');
    ok(elapsed < 1_000, 'F-2b 立即返回，不等满超时', `${elapsed}ms`);
    eq(r.llmCheck?.reasonCode, 'budget_short', 'F-2c 原因码与"等满超时"分得开');
    eq(r.status, 'unknown', 'F-2d 仍是"未核"（未核不因预算降级变成"充分"）');
    ok(String(r.llmCheck?.reason ?? '').includes('剩余'), 'F-2e 文案给出真实剩余，不写"超时了"');

    // 反证：同一份文件、同一把尺，预算充裕时**会**调用——证明上面是预算所致，不是文档本身被跳过。
    const counter2 = { calls: 0 };
    await validateOutput(fakeAns(counter2), f, 'document', { deadlineAt: Date.now() + LLM_VALIDATION_TIMEOUT_MS * 4 });
    eq(counter2.calls, 1, 'F-2f 反证：预算充裕 ⇒ 真去问');

    ok(LLM_VALIDATION_MIN_ASK_MS < LLM_VALIDATION_TIMEOUT_MS, 'F-2g 最小发问阈值小于单次等待上限（否则两者互相顶死）',
      `${LLM_VALIDATION_MIN_ASK_MS} vs ${LLM_VALIDATION_TIMEOUT_MS}`);

    // 未核汇总：两种"主动不问"各有其名（人话可见）。
    const sum = summarizeUnverified([
      { status: 'unknown', file: '/x/a.md', llmCheck: { reasonCode: 'skipped_large_doc' } },
      { status: 'unknown', file: '/x/b.md', llmCheck: { reasonCode: 'budget_short' } },
    ] as never);
    ok(!!sum && sum.includes('文档过大未逐条问'), 'F-2h 汇总里点出"文档过大未逐条问"', String(sum).slice(0, 80));
    ok(!!sum && sum.includes('预算将尽未再问'), 'F-2i 汇总里点出"预算将尽未再问"');
    ok(!!sum && !sum.includes('超时/预算用尽'), 'F-2j 两种主动不问不再被塞进"超时"一类（归因敢分）');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ═══ F-3｜收口事件先于后置账 ════════════════════════════════════════════
  console.log('\n【F-3】收口关键路径只剩"发后置作业"；后置账幂等，且按 **run 身份** 去重');
  {
    const ai = CODE(`${A}/src/main/core/jobs/ai-task.ts`);
    const aiBody = blockAfter(ai, "scheduler.register('ai-task'");
    const resumeBody = blockAfter(ai, "scheduler.register('resume-ai-task'");
    const postludeBody = blockAfter(ai, `scheduler.register(POSTLUDE_JOB_TYPE`);

    ok(aiBody.length > 0 && resumeBody.length > 0 && postludeBody.length > 0,
      'F-3a 三段处理器块都取到了（静态判据按块取，不按行号）');
    // 关键路径窗口 = "执行体返回" → "发后置作业"。窗口外的失败/账户级故障通知**刻意保留**（它们只在
    //   非完成终态出现，且用户当场要知道），故判据只钉这段路，不假装"整个处理器一个都不许有"。
    for (const [name, body] of [['ai-task', aiBody], ['resume-ai-task', resumeBody]] as const) {
      const ret = body.indexOf('await executeTask(');
      const enq = body.indexOf('enqueuePostlude(');
      const win = ret >= 0 && enq > ret ? body.slice(ret, enq) : '';
      ok(win.length > 0, `F-3a2 ${name} 取到"执行体返回 → 发后置作业"这段路（判据在作用域内）`);
      ok(!win.includes('sendImPrimaryDeliverables('), `F-3c ${name} 完成收尾不再当场推件`);
      ok(!win.includes('reinforceMemories('), `F-3d ${name} 完成收尾不再当场强化记忆`);
      ok(!win.includes('promoteWorkingMemory('), `F-3e ${name} 完成收尾不再当场提升工作记忆`);
      ok(body.includes('enqueuePostlude('), `F-3f ${name} 改为发后置作业（不是悄悄删掉这几笔账）`);
    }
    // 「完成通知」在全文件只许一处，且必须落在后置作业块里。
    //   失败/账户级故障的 paused 通知**刻意保留**（它们不是完成收尾，用户当场就要知道），
    //   故判据钉"完成态"这一种，而非"整个文件不许出现这个调用"。
    eq((ai.match(/sendImNotification\([^\n]*'completed'/g) || []).length, 1, 'F-3b 完成通知在文件里只剩一处（0 处=丢账，多处=还压在关键路径上）');
    ok(postludeBody.includes("buildTaskNotice(db, taskId, 'completed'"), 'F-3b2 那一处就在后置作业里');
    eq((ai.match(/buildCompletionNotice\(/g) || []).length, 1, 'F-3b3 完成通知的内容构造也只剩后置作业一处');
    eq((ai.match(/sendImPrimaryDeliverables\(/g) || []).length, 1, 'F-3c2 推件在文件里只剩一处（不重复推，也不丢）');
    ok(postludeBody.includes('sendImPrimaryDeliverables('), 'F-3c3 那一处就在后置作业里');
    // 正向强化（true）只剩后置作业一处；保留在前的只有失败路（false）——"奖"与"罚"不共用一条路。
    const trueReinforce = (ai.match(/reinforceMemories\([^)]*?,\s*true\b/g) || []).length;
    eq(trueReinforce, 1, 'F-3b2 成功强化在文件里只剩一处');
    ok(postludeBody.includes(', true'), 'F-3b3 那一处就在后置作业里（`ai-task` 文件内真源可核）');
    ok(aiBody.indexOf('enqueuePostlude(') > aiBody.indexOf('await executeTask('),
      'F-3g 后置作业在 `executeTask` **返回之后**才发（事件先、账后由语句次序保证）');
    ok(postludeBody.includes('sendImNotification(') && postludeBody.includes('sendImPrimaryDeliverables(')
      && postludeBody.includes('reinforceMemories(') && postludeBody.includes('promoteWorkingMemory('),
      'F-3h 四笔账确实搬到了后置作业里（"搬走"而非"丢失"）');
    ok(/statusRow\?\.status !== 'completed'/.test(postludeBody), 'F-3i 后置作业只在完成态办（失败/暂停不奖）');
    ok(postludeBody.includes('postludeDue('), 'F-3j 去重口取自 `postlude.ts`（一处真源，不在处理器里手写键名）');
    ok(postludeBody.includes('markPostludeDone('), 'F-3k 办完才写去重键');

    const enq = blockAfter(ai, 'const enqueuePostlude = (');
    ok(enq.includes('finalContent'), 'F-3l 载荷带上本轮正文（作业不再持有执行体内存）');
    ok(enq.includes("source: 'run_completed'"), 'F-3m 载荷带来源（事后可查谁发的）');

    const fin = CODE(`${A}/src/main/core/exec-finalize.ts`);
    const idxUpd = fin.indexOf("status = 'completed'");
    const idxMark = fin.indexOf('markCompletedRun(');
    ok(idxMark > 0 && idxUpd > 0 && idxMark > idxUpd, 'F-3n 收口出口①：状态落完成之后才记 run 身份');
    const ae = CODE(`${A}/src/main/core/agent-executor.ts`);
    ok(ae.includes('markCompletedRun(db, taskId'), 'F-3o 收口出口②（finalize_task 工具路）同写 run 身份（两出口一处实现）');

    // 行为：身份/去重口（真实现，两只标本）。
    const db = mkdb();
    addTask(db, 't-1', 'completed', JSON.stringify({ attachments: ['a.pdf'], goal: { text: '目标' } }));
    eq(postludeDue(db as never, 't-1'), null, 'F-3p 没记收口身份 ⇒ 不办（不乱发通知）');
    markCompletedRun(db as never, 't-1', 'run-1');
    eq(lastCompletedRunKey(db as never, 't-1'), 'run-1', 'F-3q 收口时记下本 run 身份');
    eq(postludeDue(db as never, 't-1'), { runKey: 'run-1' }, 'F-3r 有身份且未办 ⇒ 该办');
    eq(markPostludeDone(db as never, 't-1', 'run-1'), true, 'F-3s 办完写去重键');
    eq(postludeDoneRun(db as never, 't-1'), 'run-1', 'F-3t 去重键就是这一 run');
    eq(postludeDue(db as never, 't-1'), null, 'F-3u 同一 run 重放/重复入队 ⇒ 不再办（幂等）');
    markCompletedRun(db as never, 't-1', 'run-2');
    eq(postludeDue(db as never, 't-1'), { runKey: 'run-2' }, 'F-3v 续跑后再次完成是新身份 ⇒ 各办一次（反证：不是按终态去重）');
    const ctx = ctxOf(db as never, 't-1');
    eq(ctx.attachments, ['a.pdf'], 'F-3w 写身份不抹兄弟键（附件仍在）');
    ok(!!ctx.goal, 'F-3x 写身份不抹兄弟键（目标仍在）');
    eq(ctx[LAST_COMPLETED_RUN_KEY], 'run-2', 'F-3y 身份键名取自 `postlude.ts` 常量，未另写字符串');
    eq(ctx[POSTLUDE_DONE_RUN_KEY], 'run-1', 'F-3z 去重键与身份键是两个键（一个有值不影响另一个）');

    const db2 = mkdb();
    addTask(db2, 't-2', 'completed', '{坏JSON');
    markCompletedRun(db2 as never, 't-2', 'run-9');
    const raw2 = (db2.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('t-2') as { context_json: string }).context_json;
    eq(raw2, '{坏JSON', 'F-3aa 读不懂就不写：坏 JSON 不覆盖（宁可这笔账不落）');
    eq(postludeDue(db2 as never, 't-2'), null, 'F-3ab 坏 JSON ⇒ 如实"没身份"，不谎报该办');
  }

  // ═══ F-4｜压缩超总预算 ⇒ 回退规则摘要且不推进边界 ════════════════════════
  console.log('\n【F-4】压缩预算用尽/被中止 ⇒ 临时规则摘要，**边界不推进**（没进摘要的行不得被永久遮蔽）');
  {
    const db = mkdb();
    addTask(db, 't-c', 'executing', JSON.stringify({ history_summary: 'PRE-既有摘要' }));
    const ins = db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?, ?, ?, ?)");
    for (let i = 0; i < 50; i++) {
      ins.run(`c${i}`, 't-c', i % 2 ? 'assistant' : 'user',
        `第 ${i} 轮：这是足够长的历史正文，用来撑出可压缩的规模，避免逐行配额被抬到"不可摘"的短行。`.repeat(2));
    }
    const before = ctxOf(db as never, 't-c');

    const r = await compactTaskConversations(db as never, 't-c', 'rr-not-a-real-key', 'http://127.0.0.1:9', 'rr-probe', 128_000, { budgetMs: 0 });
    eq(r.degraded, 'budget', 'F-4a 预算用尽如实回 `budget`');
    ok(r.summary.includes('[规则摘要]'), 'F-4b 本轮回退**规则摘要**（不是空摘要）', r.summary.slice(0, 40));
    ok(r.summary.startsWith('PRE-既有摘要'), 'F-4c 既有摘要仍在前（临时回退不丢旧意图）');
    ok(r.recentConversations.length > 0 && r.recentConversations.length < 50, 'F-4d 只带尾部，未把全部历史塞回上下文',
      String(r.recentConversations.length));

    const after = ctxOf(db as never, 't-c');
    eq(after.compacted_up_to_rowid, before.compacted_up_to_rowid, 'F-4e **边界不推进**（本轮没压成就不算压过）');
    eq(after.history_summary, before.history_summary, 'F-4f 持久化摘要不被临时摘要覆盖');
    const compressionRows = (db.prepare("SELECT COUNT(*) AS n FROM wa_task_conversations WHERE task_id = 't-c' AND content LIKE '[压缩]%'").get() as { n: number }).n;
    eq(compressionRows, 0, 'F-4g 不落 `[压缩]` 会话行（没压成就不留痕）');

    // 中止标本：用户按暂停 ⇒ 同样不推进边界。
    const ctrl = new AbortController();
    ctrl.abort();
    const r2 = await compactTaskConversations(db as never, 't-c', 'rr-not-a-real-key', 'http://127.0.0.1:9', 'rr-probe', 128_000, { signal: ctrl.signal, budgetMs: 25_000 });
    eq(r2.degraded, 'aborted', 'F-4h 用户中止 ⇒ 如实回 `aborted`');
    eq(ctxOf(db as never, 't-c').compacted_up_to_rowid, before.compacted_up_to_rowid, 'F-4i 中止同样不推进边界');

    // 静态：降级早退必须在"写边界"之前（次序即判据，不能靠时长撞）。
    //   整文件定位 + 唯一性核对：两处字样在 `agent-executor.ts` 里各只出现一次，位置可归属，不必按行号。
    // B5 落地时压缩的运行段已抽到 `context-compaction-run.ts`（执行体行数额度 R-75a），
    //   故静态判据跟着符号走——钉的是"那段代码所在的那一份"，不是"曾经在哪个文件里"。
    const ae = CODE(`${A}/src/main/core/context-compaction-run.ts`);
    const idxDegrade = ae.indexOf("comp.degraded === 'budget'");
    const idxBoundary = ae.indexOf('compacted_up_to_rowid = lastShadowedRid');
    ok(idxDegrade > 0 && idxBoundary > 0 && idxDegrade < idxBoundary,
      'F-4j 降级分支早于边界写入（语句次序一处可核）');
    eq((ae.match(/compacted_up_to_rowid = lastShadowedRid/g) || []).length, 1, 'F-4j2 写边界全文只有一处（不另开后门）');
    eq((ae.match(/AbortSignal\.any\(\[opts\.signal/g) || []).length, 1, 'F-4k 中止信号与本段超时用 `AbortSignal.any` 合并（唯一一处）');
  }

  // ═══ F-5｜世界扫描缓存 ══════════════════════════════════════════════════
  console.log('\n【F-5】同一 workingDir 二次扫描命中缓存（计数 0→1）；失败不缓存；前后比对仍用本尊');
  {
    clearScanCache();
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'a.md'), '# a\n', 'utf-8');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'b\n', 'utf-8');

    const s0 = scanCacheStats();
    const first = await scanWorkingDirCached(dir, { now: 1_000 });
    const s1 = scanCacheStats();
    ok(!!first && first.files.length >= 2, 'F-5a 首扫真扫到了文件（不是空结果被当命中）', String(first?.files.length ?? 0));
    eq([s0.misses, s1.misses], [0, 1], 'F-5b 首扫记一次未命中（0→1）');
    eq(s1.hits, 0, 'F-5c 首扫没有命中');

    const second = await scanWorkingDirCached(dir, { now: 2_000 });
    const s2 = scanCacheStats();
    eq(s2.hits, 1, 'F-5d 二次扫描命中缓存（0→1 正面断言）');
    eq(second?.files.length, first?.files.length, 'F-5e 命中返回的仍是同一份清单');

    await scanWorkingDirCached(dir, { now: 1_000 + 70_000 });
    const s3 = scanCacheStats();
    eq(s3.misses, s2.misses + 1, 'F-5f 过期（超 TTL）⇒ 重扫（缓存不是永久快照）');

    clearScanCache();
    eq(scanCacheStats(), { hits: 0, misses: 0, listingHits: 0, listingMisses: 0, size: 0 }, 'F-5g 清空后计数归零');

    const missing = await scanWorkingDirCached(path.join(dir, 'does-not-exist'), { now: 1_000 });
    eq(missing, null, 'F-5h 扫不到 ⇒ 如实 `null`（不编一份空清单）');
    eq(scanCacheStats().size, 0, 'F-5i 失败结果不入缓存（不会让这个目录"消失"一分钟）');

    // 清单缓存：同一目录两次只构建一遍。
    let builds = 0;
    const b1 = await factListingCached(dir, async () => { builds++; return ['x']; }, { now: 1_000 });
    const b2 = await factListingCached(dir, async () => { builds++; return ['y']; }, { now: 2_000 });
    eq(builds, 1, 'F-5j 清单只构建一次（第二问走缓存）');
    eq(b2, b1, 'F-5k 命中返回缓存值而非重算值');

    // 反证：前后比对不得用缓存——世界快照仍直调 `scanWorkingDirOnce`。
    const ws = CODE(`${A}/src/main/core/world-snapshot.ts`);
    ok(!ws.includes('scanWorkingDirCached'), 'F-5l 反证：`world-snapshot.ts` 不引缓存扫描（前后比对须本尊）');
    ok(/captureWorldSnapshot[\s\S]{0,1200}scanWorkingDirOnce\(/.test(ws), 'F-5m 世界快照（before/after 证据面）直调 `scanWorkingDirOnce`');
    ok(/generateFactSnapshot[\s\S]{0,2500}factListingCached\(/.test(ws), 'F-5n 事实快照的目录清单走只读缓存（B5 的真实消费者）');

    // walker 分块让出主线程（不是"扫完才让"）。
    const walk = fs.readFileSync(path.join(root, `${A}/src/main/core/working-dir-walk.ts`), 'utf-8');
    ok(/yieldEvery/.test(walk) && /setImmediate/.test(walk), 'F-5o 扫描分块用 `setImmediate` 让出主线程（`yieldEvery` 可调）');
    fs.rmSync(dir, { recursive: true, force: true });
    clearScanCache();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
