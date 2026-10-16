/**
 * zx_20261015_2 受控复跑 —— 「实」：判卷读事物本身，账目名实相符。
 *
 * 由来（2026-10-15 对项目任务「20260924 规划方案实施」`7c39678e` 的交付分析）：该任务 104 件产出物、
 *   7 个真实里程碑子任务**活是真干完了**（本地复跑 `mvn clean compile` BUILD SUCCESS 7/7 模块、三笔提交在场、
 *   两仓工作树干净），却被判 `paused` / 45 分 / `goal_achieved=false`。顺藤摸出**六处同族缺陷**（D1–D6），
 *   皆一个病根的不同侧面：**拿"工蚁自己的记账词"当"事物本身"来判、来记、来报**。
 *
 * 本轮口径一句话（道德经·三十八章「前识者，道之华，而愚之始」／ 维特根斯坦·意义即用法 ／ 毛选·实事求是）：
 *   判卷**不得**拿内部登记标签（`draft`）当**前识**；判据须照事实分类（归档 ≠ 已完成）；"完成"在三条完成路
 *   上**同一把尺**；同一 run 的 before/after 才算一对（知止：不成对即止）。
 *
 * 治法（四处落点，逐条见方案 §2/§5.4）：
 *   批一 D1 `agent-executor.ts:renderEvidence` / `world-snapshot.ts:generateFactSnapshot` 去内部登记状态；
 *   批二 D2 `tools/control.ts` `update_task_status(completed)` 清陈旧暂停键 + 重开失败账；
 *        D5 `task-accounting.ts:childCompletionCheckLabel` 如实披露 `incomplete`（含 `archived`）；
 *        D6 `control-finalize.ts` WARN 与账上保留的旧结论**互相交代**；
 *   批三 D3 `task-accounting.ts:milestoneTitledRefsIn` + `task-decompose.ts:milestoneHintOf` 带**真名**；
 *        D4 `exec-claim.ts:captureSnapshotBeforeRun` 写新 before 时清陈旧 after。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：E/M 组直引生产 `renderEvidence`/`generateFactSnapshot`/`milestoneHintOf`/
 *       `captureSnapshotBeforeRun`，C-1~C-3 走 `buildTools` 真跑 `update_task_status`（被删/改名即编译期失败）。
 *   G-2 **两侧标本**：每处"该命中"必配**反证**（E-1 有状态词/无状态词；C-4 有归档/C-5 全完成；
 *       M-1 带标题/M-2 仅编号）；计数器类断言须有"值从 0 变 1"（M-3、C-1）。
 *   G-6 **无轮次字面量**：本轮方案路径/脚本名由 `path.basename(__filename)` 派生（末尾 S 组自检）。
 *   ⚠ 静态判据**按符号切片**（不按行号）；判"用户可见文案/接线那一跳"读去注释后的代码。
 *   ⚠ 夹具 DDL 逐列照抄 `database.ts`（不做"比生产宽松"的简化）——被查的列一列不缺。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：读真源**静态导入**（被删/改名即编译期失败，而非"扫个空、静默假绿"）。
import { renderEvidence, buildTools } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { generateFactSnapshot } from '../apps/worker-ant-desktop/src/main/core/world-snapshot.js';
import { captureSnapshotBeforeRun } from '../apps/worker-ant-desktop/src/main/core/exec-claim.js';
import { classifyChildCompletion, childCompletionCheckLabel, milestoneTitledRefsIn, milestoneRefsIn } from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import { milestoneHintOf } from '../apps/worker-ant-desktop/src/main/core/task-decompose.js';
import { isAcceptanceVerified, acceptanceVerdictOf, UNVERIFIED_REASON_LABEL, maySupersedeLedger } from '../apps/worker-ant-desktop/src/main/core/acceptance-check.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** 等值断言（把实际值一并打出——红时立刻看得出差在哪）。 */
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
/** 判"文案/调用形状"读**去注释后**的代码；判"注释在册"读原文。 */
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''); // zx_20261015_2

/* ── 夹具 schema：逐列照抄 database.ts DDL（被查的列一列不缺，也不放宽 NOT NULL） ── */
const SCHEMA = `
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', cron_schedule TEXT, working_dir TEXT DEFAULT '',
  context_json TEXT DEFAULT '{}', sandbox_mode TEXT DEFAULT 'workspace', owner_id TEXT,
  cron_timezone TEXT DEFAULT 'Asia/Shanghai', autonomous_mode TEXT DEFAULT 'off',
  aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'p', parent_task_id TEXT DEFAULT '',
  title TEXT DEFAULT '', description TEXT DEFAULT '', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0,
  context_json TEXT DEFAULT '{}', depends_on TEXT DEFAULT '', source TEXT DEFAULT 'test',
  acceptance_criteria TEXT DEFAULT '', quality_score REAL, aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL,
  name TEXT DEFAULT '', description TEXT DEFAULT '', file_path TEXT, registry_id TEXT,
  status TEXT DEFAULT 'draft', is_primary INTEGER DEFAULT 0, acceptance_verified INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', tool_calls TEXT, token_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_plan_milestones (id TEXT PRIMARY KEY, project_id TEXT, plan_task_id TEXT NOT NULL,
  milestone TEXT NOT NULL, status TEXT DEFAULT 'pending', implemented_by_task_id TEXT,
  updated_at TEXT DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_wa_plan_milestones_uniq ON wa_plan_milestones(plan_task_id, milestone);
CREATE TABLE wa_event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL DEFAULT '{}',
  metadata TEXT DEFAULT '{}', occurred_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
`;
type AnyDb = import('better-sqlite3').Database;
const mkdb = (): AnyDb => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d as unknown as AnyDb; };

const addTask = (db: AnyDb, id: string, status: string, opts: { parent?: string; ctx?: Record<string, unknown> } = {}): void => {
  db.prepare(`INSERT INTO wa_tasks (id, project_id, parent_task_id, title, status, source, context_json)
              VALUES (?, 'p', ?, ?, ?, 'test', ?)`)
    .run(id, opts.parent ?? '', id, status, JSON.stringify(opts.ctx ?? {}));
};
const addDeliv = (db: AnyDb, id: string, taskId: string, name: string, status = 'draft', type = 'doc'): void => {
  db.prepare(`INSERT INTO wa_deliverables (id, project_id, task_id, type, name, status) VALUES (?, 'p', ?, ?, ?, ?)`)
    .run(id, taskId, type, name, status);
};
const ctxObj = (db: AnyDb, id: string): Record<string, unknown> =>
  JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json || '{}');

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx15-2-'));

async function main(): Promise<void> {
  // ═══ E｜判卷证据（批一 D1：不看内部登记状态，看事物本身）════════════════════════════════════════
  console.log('\n【E】判卷证据 —— 「前识者，道之华」（道德经·三十八章 / 维特根斯坦·意义即用法）');
  {
    // ── E-1 ★★本轮靶心：一批 `status='draft'` 的产出物 ⇒ 判卷证据里**零状态词**、**名字仍在** ──
    const out = renderEvidence(
      { convs: [], deliverables: [{ name: 'src/a.ts', status: 'draft' }, { name: 'src/b.ts', status: 'draft' }], docFiles: [], validations: '' },
      () => null,
    );
    eq(out, '[产出物] src/a.ts\n[产出物] src/b.ts',
      'E-1a ★★`renderEvidence` 产出物行**只给名字**（旧形 `[产出物] src/a.ts(draft)` ⇒ 逐字对比即红）');
    ok(!/draft/.test(out), 'E-1b ★判卷证据里**零**内部登记状态词（旁路 LLM 再也读不到 `draft` ⇒ 破掉自锁环）');
    ok(!/[(（]draft[)）]/.test(out), 'E-1c ★且不带 `(draft)` 括号形（状态词一条不剩）');

    // ── E-2 ★反证：去掉状态 ≠ 去掉证据——文件正文摘录**仍在**（不许"顺手把证据也砍了"）──
    const withDoc = renderEvidence(
      { convs: ['已完成改造'], deliverables: [{ name: 'x', status: 'completed' }], docFiles: ['/proj/src/impl.ts'], validations: '[内容校验]\n- a.ts: 充分' },
      (p) => (p.endsWith('impl.ts') ? 'export const X = 1;' : null),
    );
    ok(withDoc.includes('[文件 impl.ts]') && withDoc.includes('export const X = 1;'),
      'E-2a ★验证据仍在：`docFiles` 的**正文摘录**照旧渲染（去状态只砍标签、不砍证据）');
    ok(withDoc.includes('[产出] 已完成改造') && withDoc.includes('[内容校验]'),
      'E-2b 会话摘录与内容校验两路未被殃及（改动只落在产出物那一行）');
    const noBody = renderEvidence({ convs: [], deliverables: [], docFiles: ['/proj/src/gone.ts'], validations: '' }, () => null);
    ok(!noBody.includes('[文件'), 'E-2c ★反证的另一半：正文读不到时**不声明**"有这份文件"（如实：不比原来多说一个字）');

    // ── E-3 ★★同一病根第二处（agent 面）：事实快照不得含 `·draft` ────────────────────────
    const db = mkdb();
    db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p', '演示项目', '')").run();
    addTask(db, 't1', 'executing');
    addDeliv(db, 'd1', 't1', 'report.md', 'draft');
    const snap = await generateFactSnapshot(db, 'p');
    ok(snap.includes('产出物:') && snap.includes('[doc] report.md'),
      'E-3a 事实快照仍列出产出物（`[type] name` —— 去掉的是状态、不是这一节）');
    ok(!/·draft/.test(snap) && !/\bdraft\b/.test(snap),
      'E-3b ★★事实快照**零** `draft`（模型看见自己的产出标着 draft ⇒ 会误读成"还没做"）',
      snap.split('\n').filter((l) => /产出物|report/.test(l)).join(' | ') || '(无产出物行)');
    ok(!snap.includes('产出物状态'), 'E-3c 该节标题由「产出物状态:」正名为「产出物:」（节里已无状态，名实相符）');
  }

  // ═══ C｜完成账名实（批二 D2/D5/D6）══════════════════════════════════════════════════════════════
  console.log('\n【C】完成账名实 —— 「同一把尺」（罗尔斯 / 毛选·实事求是）');
  {
    const call = async (db: AnyDb, target: string): Promise<string> => {
      const tools = buildTools({ db } as never, 'caller-task', 'p', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
      return tools.update_task_status!.execute({ targetTaskId: target, status: 'completed' });
    };

    // ── C-1 ★★D2 前半：置 completed ⇒ 陈旧暂停键**必清**（0→1 正面：先塞进去，跑后断言没了）──
    {
      const db = mkdb();
      addTask(db, 'p1', 'executing');
      addTask(db, 'c1', 'paused', { parent: 'p1', ctx: { pause_reason: 'quality_below_bar', pause_note: '验收未过', keep_me: 7 } });
      const before = ctxObj(db, 'c1');
      eq([before.pause_reason, before.pause_note], ['quality_below_bar', '验收未过'], 'C-1a 前置标本：跑之前暂停键**确实在**（否则下面的"没了"是假绿）');
      await call(db, 'c1');
      const after = ctxObj(db, 'c1');
      eq([after.pause_reason, after.pause_note], [undefined, undefined],
        'C-1b ★★置 completed 后 `pause_reason`/`pause_note` **双双零命中**（终态与暂停因由不可共存）');
      eq(after.keep_me, 7, 'C-1c ★反证的另一半：清的是**陈旧暂停键**，不是把整个 ctx 覆写掉（兄弟键 `keep_me` 原样保留）');
    }

    // ── C-2 ★★D2 后半：对"已 paused 的账"改 completed ⇒ 那笔账**被重算覆盖** ──────────────
    {
      const db = mkdb();
      addTask(db, 'p2', 'executing');
      addTask(db, 'c2', 'paused', {
        parent: 'p2',
        ctx: { pause_reason: 'quality_below_bar', completion_quality: { score: 45, goal_achieved: false, via: 'finalize_task' }, goal_achieved: false },
      });
      await call(db, 'c2');
      const q = ctxObj(db, 'c2').completion_quality as { score?: number; via?: string };
      ok(q.via !== 'finalize_task' && q.via.startsWith('update_task_status'),
        'C-2 ★★旧账（45 分 / `via=finalize_task`）被**本工具重算覆盖**——`completed` 不再与"未完成记录"并存',
        `via=${q.via} score=${q.score}`);
    }

    // ── C-3 ★反证：**一笔成功收口账**（无 pause_reason）不被本工具覆盖（防"把真收口伪标成无产出"）──
    {
      const db = mkdb();
      addTask(db, 'p3', 'executing');
      addTask(db, 'c3', 'completed', {
        parent: 'p3',
        ctx: { completion_quality: { score: 88, goal_achieved: true, via: 'finalize_task' }, goal_achieved: true },
      });
      addDeliv(db, 'd3', 'c3', 'out.md', 'completed');
      await call(db, 'c3');
      const q3 = ctxObj(db, 'c3').completion_quality as { score?: number; via?: string };
      eq([q3.score, q3.via], [88, 'finalize_task'],
        'C-3 ★反证：无 `pause_reason` 的成功账**逐字未动**（守卫防的是真账被伪标，与 D2 的改动不冲突）');
    }

    // ── C-4 ★★D5：有 **archived** 子任务 ⇒ 绝不出现「所有 N 个已完成」，且如实披露归档数 ──
    {
      const c = classifyChildCompletion([
        { status: 'completed', context_json: '{}' }, { status: 'completed', context_json: '{}' },
        { status: 'completed', context_json: '{}' }, { status: 'completed', context_json: '{}' },
        { status: 'completed', context_json: '{}' },
        { status: 'archived', context_json: '{}' }, { status: 'archived', context_json: '{}' }, { status: 'archived', context_json: '{}' },
      ]);
      eq([c.done, c.incomplete], [5, 3], 'C-4a 分类：5 completed + 3 archived ⇒ done=5 / incomplete=3（archived 不落 done）');
      const label = childCompletionCheckLabel(c);
      ok(!/所有8个子任务已完成/.test(label) && !/全部完成/.test(label),
        'C-4b ★★旧文案「所有8个子任务已完成」**不再出现**（真库标本 `7c39678e` 即此谎报：7 完成 + 8 归档）', label);
      ok(label.includes('归档/未了结 3 个') && label.includes('共 8 个子任务'),
        'C-4c ★★如实分列：头句写「共 8 个子任务（完成 5 个、归档/未了结 3 个）」（归档者不得被算作"已完成/已终结"）', label);
    }

    // ── C-5 ★反证：全 completed ⇒ 原措辞**逐字保留**（该报绿就得报绿，不许因新分支而失声）──
    {
      const all = classifyChildCompletion([1, 2, 3, 4, 5].map(() => ({ status: 'completed', context_json: '{}' })));
      eq(childCompletionCheckLabel(all), '[PASS] 所有5个子任务已完成',
        'C-5 ★反证：全真完成仍逐字 `[PASS] 所有5个子任务已完成`（不因新增 `incomplete` 一路而放宽/改口）');
      eq(childCompletionCheckLabel(classifyChildCompletion([])), '[PASS] 无子任务', 'C-5b 边界：无子任务不变');
    }

    // ── C-6 ★D6：checks 面（本轮）与账账面（保留的旧结论）**一句话内互相交代** ──────────────
    {
      // ① 行为面：三个载体函数的契约（句子由它们组装）。
      const ledger = { checked_at: '2026-10-15T05:01:54Z', verified: true, criteria_total: 10, passed_total: 5, failed: [{}], verdict: 'failed' };
      eq(isAcceptanceVerified(ledger), true, 'C-6a 账上那笔（`verified:true`）被判为"已核验结论"（保留的理由）');
      eq(acceptanceVerdictOf(ledger), 'failed', 'C-6b 且它带着**自己的** verdict（`failed`——5/10，如实说）');
      eq(typeof UNVERIFIED_REASON_LABEL.no_json, 'string', 'C-6c 本轮原因有中文标签可用（不把 `no_json` 这种内部码直接给用户）');
      eq(maySupersedeLedger(ledger, { checked_at: '2026-10-15T06:00:00Z', verified: false } as never), false,
        'C-6d 「非结论不得抹掉结论」仍在册（D6 只改**怎么说**，不动这条守卫）');

      // ② 接线那一跳（按符号切片读**去注释后**的代码）：`!ran` 分支里同时交代两件事。
      const src = CODE(`${A}/src/main/core/tools/control-finalize.ts`);
      const iBranch = src.indexOf('} else if (!accOutcome.ran) {');
      const branch = iBranch >= 0 ? src.slice(iBranch, src.indexOf("checks.push('[WARN] 验收未核验（未通过）", iBranch)) : '';
      ok(branch.length > 0, 'C-6e 找到 `!accOutcome.ran` 分支（按符号切片，不按行号）');
      ok(branch.includes('isAcceptanceVerified(accPayload)'),
        'C-6f ★接线：该分支按「账上是否留着已核验结论」**分叉**（真读账，而非一律同一句）');
      const iPhrase = branch.indexOf('本轮未取得核对结论');
      const tail = iPhrase >= 0 ? branch.slice(iPhrase, iPhrase + 240) : '';
      ok(tail.includes('账上保留此前一次已核验结论') && tail.includes('acceptanceVerdictOf(accPayload)'),
        'C-6g ★★**同一句话内**同时出现「本轮未取得…」与「账上保留…（verdict）」——两句话并列而不相认的病就此了结');
      ok(tail.includes('${passedTotal}/${criteriaTotal}') || tail.includes('passedTotal') && tail.includes('criteriaTotal'),
        'C-6h 且带上账上那笔的**具体比分**（`p/c 已达成`），不是一个笼统的"有结论"');
      ok(branch.includes("checks.push(`[WARN] 验收未核验（${reasonLabel}）——已如实记账，不阻断收口`)"),
        'C-6i ★反证：账上**无**结论时维持原措辞（不凭空添字——"不凭空多说一个字"）');
    }
  }

  // ═══ M｜拆解与快照（批三 D3/D4）════════════════════════════════════════════════════════════════
  console.log('\n【M】拆解带真名 + 快照不成对即止（维特根斯坦·意义即用法 / 道德经·四十四章）');
  {
    // ── M-1 ★★D3：方案带里程碑表 ⇒ hint 含**真名**（`M0 口径与前置确认`），不是光一个编号 ────
    const titledDir = path.join(tmpdir, 'proj-titled');
    fs.mkdirSync(path.join(titledDir, 'plans'), { recursive: true });
    fs.writeFileSync(path.join(titledDir, 'plans', 'milestones.md'), [
      '# 方案',
      '| 里程碑 | 状态 | 说明 |',
      '| --- | --- | --- |',
      '| M0 口径与前置确认 | ✅ 已完成 | 只读基线 |',
      '| M1 渠道接入 | ✅ | 适配器 |',
      '| M2 性能与安全加固 | ⚠ 未做 | 顺延 |',
      '',
    ].join('\n'));
    const dbT = mkdb();
    dbT.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('pt', '带标题', ?)").run(titledDir);
    const hintTitled = milestoneHintOf(dbT, '按 plans/milestones.md 的里程碑逐条实施', 'pt');
    eq(hintTitled, 'M0 口径与前置确认、M1 渠道接入、M2 性能与安全加固',
      'M-1 ★★带里程碑表的方案 ⇒ hint 交出「M 号 + 方案里的标题」（旧形只有 `M0、M1、M2` ⇒ 逐字对比即红）');

    // ── M-2 ★反证：只有编号（或表行无标题）⇒ **逐字回退**为"仅 M 号"（如实降级）─────────────
    const bareDir = path.join(tmpdir, 'proj-bare');
    fs.mkdirSync(path.join(bareDir, 'plans'), { recursive: true });
    fs.writeFileSync(path.join(bareDir, 'plans', 'bare.md'), '方案要点：见 M1 与 M2，另 M3。\n');
    const dbB = mkdb();
    dbB.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('pb', '仅编号', ?)").run(bareDir);
    const hintBare = milestoneHintOf(dbB, '按 plans/bare.md 的里程碑逐条实施', 'pb');
    eq(hintBare, 'M1、M2、M3',
      'M-2 ★反证：读不到标题时**逐字回退**「M1、M2、M3」（不因取不到标题而阻断拆解、也不编一个名字出来）');

    // ── M-2b 抽取器本体的两向标本（真跑真实现，不经文件系统）────────────────────────────
    eq([...milestoneTitledRefsIn('| M0 口径与前置确认 | ✅ |').entries()], [['M0', '口径与前置确认']],
      'M-2b 表行形态可取标题（`| M<n> <标题> | …`）');
    eq([...milestoneTitledRefsIn('### M1 D1：relay 卡内类目\n正文又提到 M9 但不在标题开头。').keys()], ['M1'],
      'M-2c 标题形态可取（M 号须在标题文字**开头**）；正文里的 `M9` **不得**被误认成定义');
    eq([...milestoneTitledRefsIn('| M1 | ✅ |').keys()], [],
      'M-2d 空标题表行（`| M1 | …`）不进表 ⇒ 由调用方回退 M 号（真实语料 `zx_20261009_1.md` 即此形）');
    eq([...milestoneRefsIn('| M0 口径与前置确认 | ✅ |')], ['M0'],
      'M-2e ★同族一致性：`milestoneRefsIn`（编号真源）与标题抽取对**同一文本**认同一组 M 号');

    // ── M-3 ★★D4：写新 before 时**清掉陈旧的 after**（0→1 正面：先塞一个假 after，跑后为空）──
    {
      const db4 = mkdb();
      db4.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p4', '快照', ?)").run(titledDir);
      addTask(db4, 't4', 'executing', {
        ctx: { world_snapshot_before: { timestamp: '2026-10-15T04:54:35Z' }, world_snapshot_after: { timestamp: '2026-10-15T04:45:40Z' }, keep_me: 1 },
      });
      const ctx4 = (): Record<string, unknown> => ctxObj(db4, 't4');
      ok(!!ctx4().world_snapshot_after, 'M-3a 前置标本：跑之前那个**倒挂的** after **确实在**（真库标本形态：before 04:54:35 晚于 after 04:45:40）');
      await captureSnapshotBeforeRun(db4, 'p4', 't4');
      const a4 = ctx4();
      eq(a4.world_snapshot_after, undefined,
        'M-3b ★★写新 `before` 后 `world_snapshot_after` **已清**（成对才留，不成对即止——不再拿上一个 run 的 after 冒充"本轮执行后"）');
      eq((a4.world_snapshot_before as { timestamp?: string })?.timestamp === '2026-10-15T04:54:35Z', false,
        'M-3c ★且 `before` **确已换新**（0→1 的另一半：不是"什么都没发生"导致的假绿）',
        String((a4.world_snapshot_before as { fileCount?: number })?.fileCount));
      eq(a4.keep_me, 1, 'M-3d ★反证的另一半：清的是 after **一个键**，兄弟键 `keep_me` 原样保留');

      // ── M-3e 反证：**取不到新 before**（captureWorldSnapshot 抛错）⇒ 既有账**不动**（best-effort 不误伤）──
      const db5 = mkdb();
      db5.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p5', 'x', '')").run();
      addTask(db5, 't5', 'executing', {
        ctx: { world_snapshot_before: { timestamp: 'OLD-B' }, world_snapshot_after: { timestamp: 'OLD-A' } },
      });
      db5.exec('DROP TABLE wa_deliverables'); // 制造 captureWorldSnapshot 的失败面
      await captureSnapshotBeforeRun(db5, 'p5', 't5');
      const a5 = ctxObj(db5, 't5');
      eq([(a5.world_snapshot_before as { timestamp?: string })?.timestamp, (a5.world_snapshot_after as { timestamp?: string })?.timestamp],
        ['OLD-B', 'OLD-A'],
        'M-3e ★反证：**取不到新 before** 时（没开新一轮）既有账逐字不动——清 by "真取到" 的条件，不是无条件的');
    }
  }

  // ═══ S｜静态接线 + 自指 + build 钉（G-6 派生核对）═════════════════════════════════════════════
  console.log('\n【S】静态接线 + 哑雷自检 + build 钉（派生核对）');
  {
    // ── S-1 三条完成路同守「终态与暂停因由不可共存」（键表**一处真源**，不各抄一份）──────────
    const humanSrc = CODE(`${A}/src/main/core/finalize-by-human.ts`);
    ok(/export const STALE_PAUSE_KEYS/.test(humanSrc),
      'S-1a ★键表**已导出**（第三条完成路才借得到；此前是模块私有 ⇒ 只能各抄一份键名）');
    const ctrlSrc = CODE(`${A}/src/main/core/tools/control.ts`);
    ok(ctrlSrc.includes("import { STALE_PAUSE_KEYS } from '../finalize-by-human.js'") && ctrlSrc.includes('for (const k of STALE_PAUSE_KEYS) delete tctx[k]'),
      'S-1b ★★`update_task_status` **真调**那处真源清键（不是另写一份 `delete tctx.pause_reason`——两份键名即分家）');

    // ── S-2 D5 文案的单一真源：`finalize` 路走的是**同一个** `childCompletionCheckLabel` ────────
    const finSrc = CODE(`${A}/src/main/core/tools/control-finalize.ts`);
    ok(/childCompletionCheckLabel\(classifyChildCompletion\(/.test(finSrc),
      'S-2 ★收口自检走分类文案**唯一真源**（改名/搬位即红，防"同一判据两处各说各话"）');

    // ── S-3 自检：本文件零 build 轮次字面量（G-6）＋ 方向性自指（由载体自身派生）───────────────
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S-3a 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）', selfPins.map((m) => m[1]).join(',') || '0 处');
    const landmine = /['"`](zx_\d{8}(?:_\d+)?)['"`]/.test(selfLines.split('\n').filter((l) => /\btag\b/.test(l)).join('\n'));
    ok(!landmine, 'S-3b 哑雷自检：本文件无"派生标签 × 轮次字面量"比对（承 `rr_zx_20260914` S9 专项）');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S-3c ★方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S-3d 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言抛异常时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
(async () => {
  try {
    await main();
    console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261015_2: ${pass} 通过 / ${fail} 失败\n`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (e: unknown) {
    console.error('\n💥 rr_zx_20261015_2 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
    fail++;
    console.log(`\n❌ rr_zx_20261015_2: ${pass} 通过 / ${fail} 失败\n`);
    process.exit(1);
  }
})();
