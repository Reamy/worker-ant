/**
 * zx_20261111_1 B1 —— 项目须知：失败就是失败（可见、可追溯、不伪造成功）。
 *
 * 三组判据：
 *   R「落库语义」：status = 最近一次尝试的结局；失败保留旧 brief 与 generated_at；
 *     attempt_model 记本次尝试；老库缺列不阻断（按旧形状回落）。
 *   J「作业端到端」：成功/坏输出/超时/选型前失败四条链路；超时转人话并点名模型与本地端点。
 *   W「消费侧与界面」：拆解/判卷按 **内容** 注入；注入日期用 generatedAt；
 *     renderer 类型与文案同源（attemptModel / 上次成功生成于）。
 *
 * 纪律：
 *   - 夹具按生产 DDL 建表（不跑 initDatabase；列漏一列就是响亮失败）；
 *   - 两侧标本：从未成功过的失败 / 有旧成功的失败，两路都断言；
 *   - 不依赖真实墙钟（datetime('now') 只用于落库，断言只比较方向与不变性）；
 *   - 断言文案不含失败字形（rr:all 汇总器按字形计数）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  loadProjectBrief, markBriefRunning, saveBriefFailed, saveBriefReady,
  type ProjectBrief,
} from '../apps/worker-ant-desktop/src/main/core/project-brief.js';
import {
  BRIEF_GENERATE_TIMEOUT_MS, runProjectBriefInit,
} from '../apps/worker-ant-desktop/src/main/core/project-brief-job.js';
import { stripKeepingLines } from './lib/rr-pins.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const readSrc = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');
const codeOf = (rel: string): string => stripKeepingLines(readSrc(rel)).join('\n');

const GOOD_BRIEF: ProjectBrief = {
  summary: '演示项目：一个 TypeScript 命令行小工具。',
  stack: ['TypeScript'],
  commands: [{ name: '构建', cmd: 'pnpm build' }],
  entry_points: ['src/main.ts'],
  layout: [{ path: 'src', purpose: '实现代码' }],
  conventions: [],
  gotchas: [],
};

/** 生产 DDL 逐字（database.ts 的 wa_project_briefs，含本轮新增两列）。 */
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, description TEXT DEFAULT '', working_dir TEXT DEFAULT '');
    CREATE TABLE wa_project_briefs (
      project_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      brief_json TEXT NOT NULL DEFAULT '',
      source_hash TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      trigger TEXT NOT NULL DEFAULT '',
      generated_at TEXT NOT NULL DEFAULT '',
      attempt_model TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function makeRepo(withFile = true): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rrbrief-2511-')));
  if (withFile) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo' }), 'utf-8');
  return dir;
}

const dbOf = (d: DatabaseSync): never => d as never;

async function main(): Promise<void> {
  // ═══ R｜落库语义 ═══════════════════════════════════════════════════════
  console.log('\n【R】落库语义：状态 = 最近一次尝试的结局');
  {
    const db = makeDb();
    // R-1 从未成功过 + 失败
    markBriefRunning(dbOf(db), 'p1', 'manual');
    saveBriefFailed(dbOf(db), 'p1', '生成失败：断网', 'manual', 'm-a');
    const r1 = loadProjectBrief(dbOf(db), 'p1')!;
    ok(r1.status === 'failed' && r1.brief === null && r1.error.includes('断网'),
      'R-1 从未成功过的失败 ⇒ failed、无旧须知、原因在');
    ok(r1.attemptModel === 'm-a' && r1.generatedAt === '',
      'R-1b 记本次尝试模型；没有成功时刻就留空（不编一个）', `attempt=${r1.attemptModel} gen=${r1.generatedAt}`);

    // R-2 有旧成功 + 重跑失败
    saveBriefReady(dbOf(db), 'p1', {
      brief: GOOD_BRIEF, sourceHash: 'h', model: 'm-ok', tokensIn: 5, tokensOut: 6, trigger: 'manual',
    });
    const gen1 = loadProjectBrief(dbOf(db), 'p1')!.generatedAt;
    markBriefRunning(dbOf(db), 'p1', 'manual');
    const running = loadProjectBrief(dbOf(db), 'p1')!;
    ok(running.status === 'running' && running.brief?.summary === GOOD_BRIEF.summary && running.generatedAt === gen1,
      'R-2 重跑开工：running，旧须知与上次成功时刻都保留');
    ok(running.error === '' && running.attemptModel === '',
      'R-2b 开工清掉上次错误与尝试模型（不拿上次的值冒充本次）');
    saveBriefFailed(dbOf(db), 'p1', '生成超时（170 秒）：本轮模型「m-b」未在时限内返回', 'manual', 'm-b');
    const after = loadProjectBrief(dbOf(db), 'p1')!;
    ok(after.status === 'failed' && after.brief?.summary === GOOD_BRIEF.summary,
      'R-3 有旧成功时重跑失败 ⇒ **failed**，且旧须知仍在');
    ok(after.generatedAt === gen1 && after.generatedAt.length > 0,
      'R-3b 失败不改写 generatedAt（"上次成功生成于"仍是真的）', `${gen1} → ${after.generatedAt}`);
    ok(after.attemptModel === 'm-b' && after.model === 'm-ok',
      'R-3c 尝试模型是本次的 m-b；成功模型 m-ok 不被失败覆盖', `attempt=${after.attemptModel} model=${after.model}`);

    // R-4 成功后恢复
    saveBriefReady(dbOf(db), 'p1', {
      brief: GOOD_BRIEF, sourceHash: 'h2', model: 'm-ok2', tokensIn: 7, tokensOut: 8, trigger: 'manual',
    });
    const back = loadProjectBrief(dbOf(db), 'p1')!;
    ok(back.status === 'ready' && back.error === '' && back.attemptModel === 'm-ok2',
      'R-4 再成功后 ⇒ ready、错误清空、尝试模型=成功模型');
    ok(back.generatedAt.length > 0 && back.generatedAt >= gen1,
      'R-4b 成功时刻前进（同秒不倒退）', `${gen1} → ${back.generatedAt}`);
  }

  {
    // R-5 老库缺列：按旧形状回落，不抛错、不编值
    const old = new DatabaseSync(':memory:');
    old.exec(`
      CREATE TABLE wa_project_briefs (
        project_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
        brief_json TEXT NOT NULL DEFAULT '', source_hash TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
        tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
        trigger TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO wa_project_briefs (project_id, status, brief_json) VALUES ('p1', 'ready', '{"summary":"旧须知"}');
    `);
    let rec: ReturnType<typeof loadProjectBrief> = null;
    let threw = '';
    try { rec = loadProjectBrief(dbOf(old), 'p1'); } catch (e) { threw = String((e as Error)?.message ?? e); }
    ok(!threw && rec?.brief?.summary === '旧须知', 'R-5 老库缺 generated_at/attempt_model ⇒ 仍能读出旧须知（不阻断启动）', threw || '(未抛错)');
    ok(rec?.generatedAt === '' && rec?.attemptModel === '',
      'R-5b 缺列时两值留空（消费侧 generatedAt || updatedAt 兜底，不伪造）');
  }

  // ═══ J｜作业端到端 ═════════════════════════════════════════════════════
  console.log('\n【J】作业端到端：成功 / 超时 / 选型前失败');
  {
    const db = makeDb();
    const repo = makeRepo();
    db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p1','演示',?)").run(repo);
    const ans = { getOptimalModel: async () => ({ url: 'http://remote.example/v1', api_key: 'k', model_name: 'm-job', max_output_tokens: 4096 }) };
    const genGood = async () => ({ text: JSON.stringify(GOOD_BRIEF), usage: { promptTokens: 30, completionTokens: 40 } });

    const good = await runProjectBriefInit({ db: dbOf(db), ansClient: ans as never, projectId: 'p1', trigger: 'create', generate: genGood });
    const row = loadProjectBrief(dbOf(db), 'p1')!;
    ok(good.ok && row.status === 'ready' && row.attemptModel === 'm-job' && row.generatedAt.length > 0,
      'J-1 成功链路：ready、尝试模型=成功模型、成功时刻落账', `gen=${row.generatedAt}`);
    const genOk = row.generatedAt;

    // 超时：AbortSignal.timeout 的典型错误（name=TimeoutError / message 含 timeout）
    const timeoutGen = async () => {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    };
    const timed = await runProjectBriefInit({ db: dbOf(db), ansClient: ans as never, projectId: 'p1', trigger: 'manual', generate: timeoutGen });
    const tRow = loadProjectBrief(dbOf(db), 'p1')!;
    const secs = Math.round(BRIEF_GENERATE_TIMEOUT_MS / 1000);
    ok(!timed.ok && String(timed.reason).includes('生成超时') && String(timed.reason).includes(String(secs)),
      'J-2 超时 ⇒ 转人话并写明时限', String(timed.reason));
    ok(String(timed.reason).includes('m-job'),
      'J-2b 点名本轮模型（用户能判断是谁没在时限内返回）', String(timed.reason));
    ok(tRow.status === 'failed' && tRow.brief !== null && tRow.generatedAt === genOk,
      'J-2c 状态 failed、旧须知与成功时刻都在（不抹认知、不改时间）');
    ok(String(timed.reason).includes('已保留上一份成功须知'),
      'J-2d 有旧成功时明说"已保留上一份成功须知"', String(timed.reason));

    // 本地端点：超时原因额外点明（本轮事故的直接教训）
    db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p2','本地',?)").run(makeRepo());
    const localAns = { getOptimalModel: async () => ({ url: 'http://localhost:11434/v1', api_key: 'k', model_name: 'm-local' }) };
    const localTimed = await runProjectBriefInit({ db: dbOf(db), ansClient: localAns as never, projectId: 'p2', trigger: 'manual', generate: timeoutGen });
    ok(String(localTimed.reason).includes('本地模型'),
      'J-3 本次落在本机端点 ⇒ 原因点名"本地模型"（可在 ANS 调整优先级）', String(localTimed.reason));
    ok(!String(localTimed.reason).includes('已保留上一份成功须知'),
      'J-3b 反证：从未成功过时不说"已保留"（不编一个不存在的旧版）');
  }

  {
    // 选型前失败：不继承上一次成功的尝试模型
    const db = makeDb();
    const empty = makeRepo(false);
    db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p3','空',?)").run(empty);
    const ans = { getOptimalModel: async () => { throw new Error('不应调用模型'); } };
    const r = await runProjectBriefInit({ db: dbOf(db), ansClient: ans as never, projectId: 'p3', trigger: 'manual', generate: async () => ({ text: '' }) });
    const row = loadProjectBrief(dbOf(db), 'p3')!;
    ok(!r.ok && row.status === 'failed' && row.attemptModel === '',
      'J-4 选型前失败（空目录）⇒ failed 且尝试模型留空（不拿别的尝试冒充）', row.error);
  }

  // ═══ W｜消费侧与界面 ═══════════════════════════════════════════════════
  console.log('\n【W】消费侧与界面：按内容注入 + 时间/模型分账');
  {
    const dec = codeOf(`${A}/src/main/core/task-decompose.ts`);
    ok(/stored\?\.brief/.test(dec) && /stored\.generatedAt \|\| stored\.updatedAt/.test(dec),
      'W-1 拆解按须知**内容**注入，日期取生成时刻（失败不丢旧认知、不冒充新时间）');

    const acc = codeOf(`${A}/src/main/core/exec-acceptance.ts`);
    ok(/if \(stored\?\.brief\)/.test(acc) && acc.includes('renderProjectBriefForJudge(stored.brief)'),
      'W-2 判卷按须知**内容**注入（与拆解/执行上下文同口径）');

    const ctx = codeOf(`${A}/src/main/core/exec-context.ts`);
    ok(/stored\?\.brief/.test(ctx) && /stored\.generatedAt \|\| stored\.updatedAt/.test(ctx),
      'W-3 执行上下文注入日期取生成时刻（不拿失败尝试的 updatedAt 冒充）');

    const ipc = codeOf(`${A}/renderer/src/lib/ipc.ts`);
    ok(/generatedAt:\s*string/.test(ipc) && /attemptModel:\s*string/.test(ipc),
      'W-4 renderer 类型带上 generatedAt / attemptModel（IPC 边界同形）');

    const page = readSrc(`${A}/renderer/src/pages/ProjectDetailPage.tsx`);
    ok(page.includes('briefRec.attemptModel') && page.includes('上次成功生成于')
      && /briefRec\.generatedAt \|\| briefRec\.updatedAt/.test(page),
      'W-5 详情页显示尝试模型与"上次成功生成于"（失败与成功分开展示）');

    const assets = path.join(root, A, 'renderer/dist/assets');
    const files = fs.existsSync(assets) ? fs.readdirSync(assets) : [];
    const detail = files.find((f) => f.startsWith('ProjectDetailPage-') && f.endsWith('.js'));
    const dist = detail ? fs.readFileSync(path.join(assets, detail), 'utf-8') : '';
    ok(!!detail && dist.includes('上次成功生成于') && dist.includes('尝试模型'),
      'W-6 文案进了详情页独立 chunk（不是只写在源码里）', detail || '(请先构建 renderer)');
  }

  console.log(`\n[rr_zx_20261111_1_brief] ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error('\nrr_zx_20261111_1_brief 未捕获异常（复跑未跑完，不得读作通过）：', e);
  console.log(`\n[rr_zx_20261111_1_brief] ${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
