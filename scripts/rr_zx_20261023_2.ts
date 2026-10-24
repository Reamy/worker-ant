/**
 * zx_20261023_2 受控复跑 —— 「诚」：**能干的活真能下手，算下的账真能对上**。
 *
 * 四组判据对应本轮四个引擎缺陷（全部**直引生产导出**跑真实现，不照抄等价物）：
 *   A「验证者能编译」：`narrowToolFace` 的显式 allow-list 压过形态猜（`restored` 恰为救回的工具名），
 *      verifier 定义里 `execute_command` 在册、步数/超时够一次构建。反证：两参调用逐字保持旧行为。
 *   B「判卷看得见中段」：25k 字符长文经 `renderEvidence` 后头/尾/标题大纲/省略标记俱全，
 *      中段正文（非标题）如实标为已略；失效件**先剔再计数**；份数上限由常量自身派生。
 *   C「暂停即未达成」：账里 `goal_achieved=true` 的任务一进 `pauseTask`，顶层与
 *      `completion_quality.goal_achieved` 同置 false；没暂停的任务一字不动（两只标本）。
 *   D「槽位不饿死规划」：8 项模板、广度闸只放 5 ⇒ 余 3 项落 `decomposition_deferred`；
 *      前 5 项置完成后 `createDeferredSubtasks` 续建 3、跨批前置落成**真实 id**、余量清空。
 *      缺省 `shortfallNotice` 仍不说"自动续拆"（没登记就不许承诺）。
 *
 * 纪律（承 auto-memory）：
 *   G-1 真源直 import（删/改名 ⇒ 编译期失败）。
 *   G-2 两只标本（该救回的救回 / 不该动的没动）。
 *   G-4 计数器正面断言（deferred 0→旧、续拆 0→3、会话行 0→1）。
 *   G-6 无轮次字面量：方案名/脚本名由 `path.basename(__filename)` 派生。
 *   ⚠ 判据文案不得含失败字形（全量汇总按字形计失败数）。
 *   ⚠ 末尾 build 钉读 `dist` ⇒ 常规须 `tsup` 先于本脚本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import {
  narrowToolFace,
  availableToolNames,
} from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';
import { SUBAGENT_TYPES } from '../apps/worker-ant-desktop/src/main/core/subagent-registry.js';
import {
  renderEvidence,
  EVIDENCE_FILE_BITS_LIMIT,
  type EvidenceBundle,
} from '../apps/worker-ant-desktop/src/main/core/exec-evidence.js';
import { pauseTask } from '../apps/worker-ant-desktop/src/main/core/pause-task.js';
import { PAUSE_REASON_USER_INTERRUPT } from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';
import {
  autoDecomposeForTask,
  createDeferredSubtasks,
  deferredStateOf,
  shortfallNotice,
  type DecomposeDeps,
} from '../apps/worker-ant-desktop/src/main/core/task-decompose.js';
import { MAX_CHILD_BREADTH } from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';

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
/** G-6：轮次标识由**载体自身**派生，本文件不写任何轮次字面量。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

/** 夹具库：与生产同形的 `wa_tasks` 列（`planSubtasksFromTemplate` 的 INSERT 逐列对齐）。 */
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  working_dir TEXT DEFAULT '', context_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', priority INTEGER DEFAULT 0,
  depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '', source TEXT DEFAULT 'user',
  acceptance_criteria TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
`;
const mkdb = (): AnyDb => {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  d.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('proj', '试作项目', '')").run();
  return d as unknown as AnyDb;
};

async function main(): Promise<void> {
  // ═══ A｜验证者能编译 ═════════════════════════════════════════════════════════
  console.log('\n【A】验证者能编译：显式 allow-list 压过形态猜');
  {
    // document 形态的类目表不含 shell ⇒ execute_command 若只靠形态判会被删。
    const tools: Record<string, unknown> = {
      read_file: 1, write_file: 1, bash: 1, execute_command: 1, run_privileged: 1, git_clone: 1,
    };
    const r = narrowToolFace('document', tools, { allowTools: ['execute_command'] });
    ok(r.kept.includes('execute_command'), 'A-1 显式允许的 execute_command 留在工具面内', r.kept.join(','));
    eq(r.restored, ['execute_command'], 'A-2 restored 恰是被救回的那一个（不是全表照单全收）');
    ok(!r.removed.includes('execute_command'), 'A-3 removed 里不再有 execute_command', r.removed.join(','));

    // G-2 反证：两参调用逐字保持旧行为（形态表说了算，无"救回"）。
    const old = narrowToolFace('document', tools);
    ok(!old.kept.includes('execute_command'), 'A-4 反证：不传 opts 时 execute_command 仍被形态表删掉');
    eq(old.restored, [], 'A-5 反证：不传 opts 时 restored 为空');

    // 允许表里点了不存在的工具 ⇒ 不编一个名字出来。
    const ghost = narrowToolFace('document', tools, { allowTools: ['__no_such_tool__'] });
    eq(ghost.restored, [], 'A-6 allow-list 里不存在的工具不进入 restored（不虚构）');

    // verifier 档案：能跑一次构建/测试。
    const v = SUBAGENT_TYPES['verifier'];
    ok(!!v, 'A-7 verifier 档案在册');
    ok(!!v && (v.allowTools ?? []).includes('execute_command'), 'A-8 verifier 白名单含 execute_command');
    ok(!!v && (v.denyTools ?? []).includes('run_privileged'), 'A-9 run_privileged 仍被禁（验证不需提权）');
    ok(!!v && v.maxSteps >= 10, 'A-10 步数够「编译 + 读产物 + 复核」', String(v?.maxSteps));
    ok(!!v && v.timeout > 120_000, 'A-11 超时够冷缓存下的一次构建', String(v?.timeout));

    // 接线：装配点必须把子代理白名单交给收窄函数（否则修的是个没人调的纯函数）。
    const ex = CODE(`${A}/src/main/core/agent-executor.ts`);
    ok(/narrowToolFace\(archetype, tools[\s\S]{0,200}allowTools: subagentAllowTools/.test(ex),
      'A-12 装配点把 subagentAllowTools 传给 narrowToolFace（接线不是等价自造）');
    ok(/restored: toolFace\.restored/.test(ex), 'A-13 收窄日志回传 restored（能看出这条修有没有接上）');
  }

  // ═══ B｜判卷看得见中段 ═══════════════════════════════════════════════════════
  console.log('\n【B】判卷看得见中段：头 + 标题大纲 + 尾，份数按常量派生');
  {
    const HEAD = 'HEAD-TOKEN';
    const TAIL = 'TAIL-TOKEN';
    const MID = 'MIDDLE-ONLY-TOKEN';
    const long = '# 长文标题\n\n' + HEAD + '\n'
      + '甲'.repeat(12_000) + MID + '甲'.repeat(12_900)
      + '\n## 中段标题甲\n' + '乙'.repeat(600) + '\n' + TAIL + '\n';
    ok(long.length > 25_000, 'B-1 标本是长文（> 25k 字符，与真标本同量级）', String(long.length));

    const bundle: EvidenceBundle = { convs: [], deliverables: [], docFiles: ['/tmp/ev/long.md'], validations: '' };
    const rendered = renderEvidence(bundle, (p) => (p.endsWith('long.md') ? long : null));
    ok(rendered.includes(HEAD), 'B-2 头部可见');
    ok(rendered.includes(TAIL), 'B-3 结尾可见');
    ok(rendered.includes('## 中段标题甲'), 'B-4 中段**标题大纲**可见（旧实现只给前 600 字符）');
    ok(rendered.includes('中段略'), 'B-5 省略处有显式标记（不静默丢弃）');
    ok(!rendered.includes(MID), 'B-6 反证：中段**正文**确实被窗口略去（不是整份塞进去充数）');
    ok(rendered.length < long.length, 'B-7 送进判卷的总量有界', `${rendered.length} < ${long.length}`);

    // 短文档整份返回。
    const short = '# 短文\n\n' + '丙'.repeat(1200) + 'SHORT-MID' + '丙'.repeat(1200);
    const rs = renderEvidence({ convs: [], deliverables: [], docFiles: ['/tmp/ev/short.md'], validations: '' },
      () => short);
    ok(rs.includes('SHORT-MID') && !rs.includes('中段略'), 'B-8 短文档整份返回，不加省略标记');

    // 份数：失效件**先剔再计数**（把失效件放最前，旧顺序会挤掉一份有效件）。
    const LIMIT = EVIDENCE_FILE_BITS_LIMIT;
    ok(LIMIT >= 5, 'B-9 判卷一轮能看到第 5 份及以后的交付', String(LIMIT));
    const valid = Array.from({ length: LIMIT + 1 }, (_, i) => `/tmp/ev/ok${i + 1}.md`);
    const docFiles = ['/tmp/ev/zz-old.md', ...valid];
    const bodyOf = (p: string): string | null => {
      if (p.endsWith('zz-old.md')) return '> 状态：已废止\n' + '丁'.repeat(800);
      const i = valid.indexOf(p);
      return i >= 0 ? `# 有效件 ${i + 1}\n` + '戊'.repeat(800) : null;
    };
    const rb = renderEvidence({ convs: [], deliverables: [], docFiles, validations: '' }, bodyOf);
    const sections = rb.match(/\[文件 /g) ?? [];
    eq(sections.length, LIMIT, 'B-10 有效件段落数恰为上限（失效件不占名额）');
    ok(rb.includes(`[文件 ${path.basename(valid[LIMIT - 1]!)}]`), 'B-11 第 LIMIT 份有效件可见');
    ok(!rb.includes(`[文件 ${path.basename(valid[LIMIT]!)}]`), 'B-12 反证：第 LIMIT+1 份有界不送');
    ok(!rb.includes('zz-old.md'), 'B-13 失效件不进证据面');
  }

  // ═══ C｜暂停即目标未达成 ═════════════════════════════════════════════════════
  console.log('\n【C】暂停即未达成：账与状态不再自相矛盾');
  {
    const db = mkdb();
    const ins = (id: string, ctx: Record<string, unknown>) => db.prepare(
      'INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, ?, ?, ?, ?)',
    ).run(id, 'proj', id, 'executing', JSON.stringify(ctx));

    // 正标本：账已写"达成"，随后因故暂停。
    ins('c1', {
      goal_summary: '保留我', goal_achieved: true,
      completion_quality: { goal_achieved: true, score: 88 },
    });
    const pr = pauseTask(db, { taskId: 'c1', reason: PAUSE_REASON_USER_INTERRUPT, extraContext: { pause_note: '手停' } });
    ok(pr.changed, 'C-1 暂停确实落库');
    const row = db.prepare('SELECT status, context_json FROM wa_tasks WHERE id = ?').get('c1') as { status: string; context_json: string };
    const ctx = JSON.parse(row.context_json) as {
      goal_achieved?: boolean; pause_reason?: string; pause_note?: string; goal_summary?: string;
      completion_quality?: { goal_achieved?: boolean; score?: number };
    };
    eq(row.status, 'paused', 'C-2 状态 paused');
    eq(ctx.goal_achieved, false, 'C-3 顶层 goal_achieved 置 false');
    eq(ctx.completion_quality?.goal_achieved, false, 'C-4 completion_quality.goal_achieved 同置 false');
    eq(ctx.completion_quality?.score, 88, 'C-5 分数不计较（只改结论，不改度量）');
    eq(ctx.pause_reason, PAUSE_REASON_USER_INTERRUPT, 'C-6 因由码照写');
    eq(ctx.pause_note, '手停', 'C-7 extraContext 照并');
    eq(ctx.goal_summary, '保留我', 'C-8 兄弟键不被抹（只动目标达成两处）');

    // G-2 反证：没暂停的同形任务一字不动。
    ins('c2', { goal_achieved: true, completion_quality: { goal_achieved: true } });
    const c2 = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('c2') as { context_json: string }).context_json);
    eq(c2.goal_achieved, true, 'C-9 反证：未暂停任务不被改写');
    eq(c2.completion_quality.goal_achieved, true, 'C-10 反证：未暂停任务的账原样');

    // 无账可改也不许抛（缺键 ≠ 假值，读取侧按未达成处理）。
    ins('c3', { goal_summary: '无账' });
    let threw = false;
    try { pauseTask(db, { taskId: 'c3', reason: PAUSE_REASON_USER_INTERRUPT }); } catch { threw = true; }
    ok(!threw, 'C-11 无 completion_quality 时暂停不抛');
    const c3 = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('c3') as { context_json: string }).context_json);
    eq(c3.goal_achieved, false, 'C-12 无账时顶层仍置 false（不留下"可能已达成"的歧义）');
  }

  // ═══ D｜槽位不饿死规划：滚动续拆 ═════════════════════════════════════════════
  console.log('\n【D】滚动续拆：没建完的余量有账、槽位释放能续建');
  {
    const db = mkdb();
    db.prepare(
      "INSERT INTO wa_tasks (id, project_id, title, description, status, context_json) VALUES ('p1', 'proj', '阶段实施', '按八阶段推进', 'paused', ?)",
    ).run(JSON.stringify({ goal_summary: '兄弟键', depth: 0 }));

    const items = Array.from({ length: 8 }, (_, i) => ({
      title: `阶段${i + 1}`,
      description: `第 ${i + 1} 阶段的实施步骤`,
      acceptance_criteria: `第 ${i + 1} 阶段可核对`,
      purpose: '服务于父目标',
      // 第 8 项依赖第 1 项 ⇒ 跨批前置（第 1 项在第一批里已建出）。
      ...(i === 7 ? { dependsOn: [1] } : {}),
    }));
    const deps: DecomposeDeps = {
      async resolveModel() { return { url: 'http://stub', api_key: 'k', model_name: 'stub' }; },
      async chat() { return { ok: true as const, text: JSON.stringify(items) }; },
    };
    const r = await autoDecomposeForTask({
      db, taskId: 'p1', projectId: 'proj', goal: '按方案推进八阶段实施', depth: 0,
      getDeps: async () => deps, label: '任务启动', noDepWhen: '立即启动',
    });
    ok(!!r, 'D-1 拆解返回结果（不是 null）');
    eq(r?.created, MAX_CHILD_BREADTH, 'D-2 实建数等于广度上限（裁定不放宽）');
    eq(r?.planned, 8, 'D-3 规划数如实为 8');

    const st1 = deferredStateOf(db, 'p1');
    ok(!!st1, 'D-4 余量已登记（decomposition_deferred 在册）');
    eq(st1?.remaining.length, 3, 'D-5 未建 3 项如实登记');
    eq(st1?.remaining.map((x) => x.index), [6, 7, 8], 'D-6 余量保留**原模板序号**（不重编号）');
    eq(st1?.createdRefs.length, MAX_CHILD_BREADTH, 'D-7 已建项的原序号 → 真实 id 映射在册');
    const pctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('p1') as { context_json: string }).context_json);
    eq(pctx.goal_summary, '兄弟键', 'D-8 写余量不抹兄弟键（json_set 单键）');
    eq(pctx.depth, 0, 'D-9 depth 未被冲掉');

    // 会话行如实：确实登记了才说"已登记 / 自动续建"。
    const conv = (db.prepare("SELECT content FROM wa_task_conversations WHERE task_id = 'p1' AND role = 'system'").all() as Array<{ content: string }>)
      .map((c) => c.content).join('\n');
    ok(conv.includes('已登记') && conv.includes('自动续建'), 'D-10 余量真落库时才说"已登记/自动续建"（名实相符）');

    // 刻意反证：缺省 shortfallNotice 仍不说"自动续拆"（没登记的场合不许承诺）。
    const plain = shortfallNotice(8, 5);
    ok(!plain.includes('自动续拆') && !plain.includes('自动续建'), 'D-11 缺省文案不承诺自动续拆');
    ok(plain.includes('未建、亦未自动排期'), 'D-12 缺省文案仍是旧的事实描述');
    eq(shortfallNotice(8, 8), '', 'D-13 建满不报缺（两只标本）');
    ok(shortfallNotice(8, 5, undefined, { deferred: true }).includes('自动续建'), 'D-14 显式 deferred 才换那句承诺');

    // 前 5 项定局 ⇒ 槽位释放 ⇒ 续建 3 项。
    db.prepare("UPDATE wa_tasks SET status = 'completed' WHERE parent_task_id = 'p1'").run();
    const roll = createDeferredSubtasks(db, { parentTaskId: 'p1', projectId: 'proj' });
    eq(roll.created, 3, 'D-15 续建 3 项');
    eq(roll.remaining, 0, 'D-16 余量清空');
    eq(deferredStateOf(db, 'p1'), null, 'D-17 余量键被删（不留空壳冒充待办）');

    const kids = db.prepare("SELECT id, title, depends_on FROM wa_tasks WHERE parent_task_id = 'p1' AND source = 'auto-decompose-roll'").all() as
      Array<{ id: string; title: string; depends_on: string }>;
    eq(kids.length, 3, 'D-18 续建行数如实（source 可溯源）');
    const firstId = (db.prepare("SELECT id FROM wa_tasks WHERE parent_task_id = 'p1' AND title = '阶段1'").get() as { id: string }).id;
    const m8 = kids.find((k) => k.title === '阶段8');
    ok(!!m8, 'D-19 第 8 阶段这次真被建出来了（旧实现永远等不到）');
    ok(!!m8 && m8.depends_on.split(',').includes(firstId), 'D-20 跨批前置落成**真实 id**（不是序号、不是悬空）', m8?.depends_on);
    const allIds = new Set((db.prepare("SELECT id FROM wa_tasks WHERE parent_task_id = 'p1'").all() as Array<{ id: string }>).map((x) => x.id));
    ok(kids.every((k) => !k.depends_on || k.depends_on.split(',').filter(Boolean).every((d) => allIds.has(d))),
      'D-21 续建行的前置全部在册（无悬空前置）');

    const rollConv = (db.prepare("SELECT content FROM wa_task_conversations WHERE task_id = 'p1' AND role = 'system'").all() as Array<{ content: string }>)
      .filter((c) => c.content.startsWith('[续拆]'));
    eq(rollConv.length, 1, 'D-22 续拆会话行 0→1（正面断言）');

    // 父已终态 ⇒ 不再派生（"了结了"的事不许复活）。
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, description, status, context_json) VALUES ('p2', 'proj', '已归档父', 'x', 'completed', ?)")
      .run(JSON.stringify({ decomposition_deferred: { planned: 2, created: 1, createdRefs: [], remaining: [{ index: 2, title: '尾巴', description: 'y', acceptance_criteria: 'z' }] } }));
    eq(createDeferredSubtasks(db, { parentTaskId: 'p2', projectId: 'proj' }), { created: 0, remaining: 1 },
      'D-23 父已终态 ⇒ 不造子（余量原样留在账上）');
  }

  // ═══ S｜哑雷自检 + build 钉 ═══════════════════════════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfPath = `scripts/${path.basename(__filename)}`;
    const selfLines = stripKeepingLines(RD(selfPath)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6）', selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 方向性自指：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)), 'S3 本套件在册（脚本名由载体派生）');

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言抛异常时若只挂 `finally`，`process.exit` 会在 Node 报告
//   unhandled rejection 之前把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行假绿。
main().then(() => {
  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\nrr_${SELF_ROUND} 未捕获异常（复跑未跑完，不得读作通过）：`, e);
  fail++;
  console.log(`\nFAIL rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
