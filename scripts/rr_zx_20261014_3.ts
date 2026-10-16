/**
 * zx_20261014_3 受控复跑 —— 「认得」：留痕要认得出来是**谁**在做的。
 *
 * 由来（创始人本机实机复验，承 `zx_20261014_2`）：设备控制**真通了**（`wa_device_actions` 落了一行
 *   `turn_on`/`ok`），但面板「控制留痕」那行只显示 `任务 b369cf73`——一串 uuid 前 8 位，
 *   人认不出这是哪件事、更不知属哪个项目。裁定：**显示为对应的任务名称及所属项目**。
 *
 * 本轮口径一句话（维特根斯坦·意义即用法 ／ 道德经·名可名非常名 ／ 毛选·反对本本主义 ／
 *   罗尔斯·同一把尺 ／ 王阳明·知行合一）：
 *   `task_id` 在机器的语言游戏里**确是**个名字；在人这一侧它不指任何东西。
 *   留痕要显**人叫得出的名**（任务名 + 所属项目），机器认的 id 退为悬停/回退——
 *   且与**设备列同一把尺**（`zx_20261014_1` 批一已如此）：**读时现查、不留快照、查无如实回退**。
 *
 * 治法：
 *   ① `core/device-registry.ts` 新增 `taskRefsOf(db, taskIds)`——按 id 现查 `wa_tasks.title`
 *      + `wa_projects.name`（**逐条**查，不拼动态占位符）；**查无此任务 ⇒ 不进 map**；
 *      **不动 `listDeviceActions` 本体**（往它里塞 JOIN 会让已收口轮的夹具报 `no such table`）。
 *   ② `ipc/devices.ipc.ts` `devices:list` 装配 `taskRefs`（map，同任务多条留痕只查一次）。
 *   ③ `renderer` `AuditRow`：有 ref ⇒ 「任务『X』· 项目『Y』」；无 ⇒ 回退 id 前 8 位；无 task_id ⇒ 整段不渲染。
 *
 * ⚠ zx_20261016_2 批三**重定向**（本文件 W-3/W-4/W-5）：显名块前移为**行首来源标签**、改由身份列
 *   `actor_kind` 分流（任务支挂 `a.actor_ref`）。旧形状（`{a.task_id && (taskRef …}`）**已不成立**，
 *   故按符号重定向到新载体并**钉更强形状**（三来源逐成员枚举 + 回退规则恰三处）——**不删、不放宽**。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：R 组直引生产 `taskRefsOf`（被删/改名即编译期失败）。
 *   G-2 **两侧标本**：判"查无即不造名"，反面标本（**在册**的任务同一批喂）一并喂。
 *   G-6 **无轮次字面量**：本轮方案路径/脚本名由 `path.basename(__filename)` 派生（末尾 S 组自检）。
 *   ⚠ 夹具 DDL 只照搬**本投影读到的那五列**（`wa_device_actions` / `wa_tasks` / `wa_projects`）——
 *     不假装照搬整张 `wa_tasks`（另 40 余列与本投影无关，如实注记而非虚张）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：读投影真源**静态导入**（被删/改名即编译期失败，而非"扫个空、静默假绿"）。
import { taskRefsOf } from '../apps/worker-ant-desktop/src/main/core/device-registry.js';

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
/** 判"用户可见文案/调用形状"读去注释后的代码；判"接线在册"读原文。 */
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');
const countOcc = (hay: string, needle: string): number => hay.split(needle).length - 1;

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''); // zx_20261014_3

/* ── 夹具：只建本投影读到的三张表/五列（列序照搬生产 `database.ts` 的相关列）──────── */
const SCHEMA = `
CREATE TABLE wa_device_actions (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, action TEXT NOT NULL,
  args_json TEXT DEFAULT '{}', result TEXT DEFAULT '', task_id TEXT DEFAULT '',
  actor_kind TEXT DEFAULT '', actor_ref TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT DEFAULT '');
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
`;
function mkdb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  return d;
}
type AnyDb = Parameters<typeof taskRefsOf>[0];
const asDb = (d: DatabaseSync) => d as unknown as AnyDb;

/** 落一个项目 + 一个任务（走裸 INSERT —— 本投影只读，无生产写口可借）。 */
function seedProject(db: DatabaseSync, id: string, name: string): void {
  db.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run(id, name);
}
function seedTask(db: DatabaseSync, id: string, title: string, projectId = ''): void {
  db.prepare('INSERT INTO wa_tasks (id, title, project_id) VALUES (?, ?, ?)').run(id, title, projectId);
}

function main(): void {
  // ═══ R｜认得（批一：main 读投影——`task_id` 现查成"人叫得出的名"）══════════════════
  console.log('\n【R】认得 —— 留痕引用读投影（维特根斯坦·意义即用法 / 罗尔斯·同一把尺）');
  {
    const db = mkdb();
    seedProject(db, 'proj-home', '智能家居');
    seedTask(db, 'task-lamp', '打开客厅台灯', 'proj-home');   // 在册、有项目
    seedTask(db, 'task-orphan', '没有项目的活');               // 在册、无项目

    // ── R-1 ★已知 id ⇒ 标题与项目**都**取到（真跑生产 `taskRefsOf`）───────────────────
    const m = taskRefsOf(asDb(db), ['task-lamp']);
    eq(m.size, 1, 'R-1a 一个在册 id ⇒ map 恰 1 键');
    eq(m.get('task-lamp'), { title: '打开客厅台灯', projectName: '智能家居' },
      'R-1b ★标题与**所属项目名**都取到（实机那行要显的就是这两件）');

    // ── R-2 ★★现查非快照：改库内标题后再查 ⇒ **新值**（与 `zx_20261014_1` A3 同一把尺）──
    db.prepare('UPDATE wa_tasks SET title = ? WHERE id = ?').run('打开客厅台灯（改过名）', 'task-lamp');
    eq(taskRefsOf(asDb(db), ['task-lamp']).get('task-lamp')?.title, '打开客厅台灯（改过名）',
      'R-2 ★★**读时现查、不留快照**：改名后再查即得新名（若在落痕时缓存，这里会是旧名）');
    db.prepare('UPDATE wa_tasks SET title = ? WHERE id = ?').run('打开客厅台灯', 'task-lamp'); // 复位

    // ── R-3 ★查无此任务（已删）⇒ **不进 map**（不造名、不落空壳）──────────────────────
    eq(taskRefsOf(asDb(db), ['task-gone']).size, 0,
      'R-3 ★查无此任务 ⇒ map **无该键**（调用方据此如实回退 id 前缀，不假装它还在）');

    // ── R-4 ★两侧标本同批：任务在册但**无项目** / 项目**已删** ⇒ 标题有、项目名空串（如实）──
    eq(taskRefsOf(asDb(db), ['task-orphan']).get('task-orphan'), { title: '没有项目的活', projectName: '' },
      'R-4a ★任务在册、`project_id` 为空 ⇒ 标题有、项目名**空串**（如实，不造名）');
    seedTask(db, 'task-dangling', '项目被删了的活', 'proj-deleted');
    eq(taskRefsOf(asDb(db), ['task-dangling']).get('task-dangling'), { title: '项目被删了的活', projectName: '' },
      'R-4b ★项目**已删**（`LEFT JOIN` 未命中）⇒ 仍是标题有、项目名空串（不因缺项目而整条丢掉）');

    // ── R-5 入口卫生：空输入 / 空串 id ⇒ 空 map（不发无谓查询）；重复 id ⇒ 只 1 键 ──────
    eq(taskRefsOf(asDb(db), []).size, 0, 'R-5a 空数组 ⇒ 空 map');
    eq(taskRefsOf(asDb(db), ['', '']).size, 0, 'R-5b 空串 id（面板手发行）⇒ 进不了 map（不查库）');
    eq(taskRefsOf(asDb(db), ['task-lamp', 'task-lamp', 'task-orphan']).size, 2,
      'R-5c 重复 id 去重 ⇒ 恰 2 键（同一任务的多条留痕只查一次）');

    // ── R-6 ★混合批：有与无**同批喂**，只回有的那几件（G-2 两侧标本）────────────────
    const mixed = taskRefsOf(asDb(db), ['task-gone', 'task-orphan', 'task-lamp']);
    eq([...mixed.keys()].sort(), ['task-lamp', 'task-orphan'],
      'R-6 ★混合批只回**在册**的那几件（"查无"不污染"查到"）');
    eq(mixed.get('task-orphan')?.title, '没有项目的活', 'R-6b 同一批里在册两件各自取到自己的标题');
  }

  // ═══ W｜接线那一跳（批一：main 装配 + 面板显名；形状须真接上）════════════════════════
  console.log('\n【W】接线那一跳 —— 数据真到面板、面板真按名字显（承 feedback_equivalence_needs_wiring_criterion）');
  {
    // ── W-1 main 侧装配：`devices:list` 真调 `taskRefsOf` 并落进 payload ──────────────
    const ipcCode = CODE(`${A}/src/main/ipc/devices.ipc.ts`);
    ok(ipcCode.includes('taskRefsOf(') && /taskRefs:\s*Object\.fromEntries\(taskRefsOf\(/.test(ipcCode),
      'W-1 ★`devices:list` 真把 `taskRefsOf` 的返回值装配进 `payload.taskRefs`（非只 import 不用）');
    ok(/import\s*\{[\s\S]*?\btaskRefsOf\b[\s\S]*?\}\s*from\s*'\.\.\/core\/device-registry\.js'/.test(ipcCode),
      'W-1b 装配取自**生产真源** `core/device-registry.js`（不在此另写一份 JOIN）');

    // ── W-2 载荷类型两侧同形（main 声明 ⇄ renderer 声明）────────────────────────────
    ok(/taskRefs:\s*Record<string,\s*TaskRef>/.test(RD(`${A}/src/main/ipc/devices.ipc.ts`)),
      'W-2a main 侧 `DevicesListPayload.taskRefs` 在册');
    ok(/taskRefs:\s*Record<string,\s*TaskRef>/.test(RD(`${A}/renderer/src/lib/ipc.ts`)),
      'W-2b renderer 侧载荷**同形**声明在册（两处同名同型，不会一侧漏字段）');

    // ── W-3 ★★面板形状：名字优先、id 前 8 位回退（+ 反证）──────────────────────────
    //   ⚠ zx_20261016_2 批三**重定向**（承 feedback_retarget_assertions_to_stronger_source）：
    //     显名块**前移为行首来源标签**并改由**身份列** `actor_kind`（写入时定）分流——
    //     任务支挂 `a.actor_ref`（★更强：从"读一列快照"改为"读**身份列**"，与本轮真源同轴），
    //     旧的 `a.task_id && (taskRef …)` 形状随之作废（不再有那一处），故**不保留旧判据、只钉新形状**。
    const page = RD(`${A}/renderer/src/pages/DevicesPage.tsx`);
    const body = page.slice(page.indexOf('function SourceChip('), page.indexOf('function MqttConfigBlock('));
    const chip = page.slice(page.indexOf('function SourceChip('), page.indexOf('function AuditRow('));
    // 显名支（任务名）＋ 项目支（有项目再缀）＋ 回退支（id 前 8 位）。
    const taskShape = (s: string) =>
      /任务「\{taskRef\.title\}」/.test(s)
      && /项目「\$\{taskRef\.projectName\}」/.test(s)
      && /任务 \{a\.actor_ref\.slice\(0, 8\)\}/.test(s);
    ok(chip.length > 0 && taskShape(chip),
      'W-3a ★★任务来源＝**名字优先**（含所属项目）、id 前 8 位**回退**（与设备列同形）');
    ok(!taskShape(chip.replace(/taskRef\.title/g, 'a.actor_ref')),
      'W-3b ★反证：把显名调用换成 id ⇒ 形状判据即红（确系钉住那一处，非顺带为真）');
    // ── W-3c ★★三类来源**逐成员枚举**（承 feedback_enum_value_sweep_readers：断言名＝扫描面）──
    ok(['panel', 'external', 'task'].every((k) => chip.includes(`a.actor_kind === '${k}'`)),
      'W-3c ★★三类来源逐成员枚举（`panel`/`external`/`task` 各有分支，不靠"含 actor_kind"笼统为真）');
    ok(/return null;\s*\n\}/.test(chip),
      'W-3d ★认不出的来源（身份列为空的历史行）⇒ **整段不渲染**（不假装认得出）');

    // ── W-4 ★★"同一把尺"落在构造上：**三处**"这是谁"的回退都是 id 前 8 位 ────────────
    //   设备列 + 任务支 + 外部终端支（zx_20261016_2 批三加了第三处：终端查无亦如实回退前缀）。
    eq(countOcc(body, '.slice(0, 8)'), 3,
      'W-4 ★★同一块面板三处"这是谁"共用**一条**回退规则（`slice(0, 8)` 恰 3 处：设备列 + 任务支 + 外部终端支）');

    // ── W-5 页面向 `AuditRow` 传参那一跳（现查 `taskRefs`/`terminalRefs`，非逐行快照）────
    ok(/const taskRefs = data\?\.taskRefs \?\? \{\}/.test(page),
      'W-5a 页面从**当前**载荷取 `taskRefs`（数据源＝本屏那一次读，非另拉一份）');
    ok(/const terminalRefs = data\?\.terminalRefs \?\? \{\}/.test(page),
      'W-5c ★同源现查 `terminalRefs`（外部终端支的名字同样读时查，不落快照）');
    ok(/<AuditRow key=\{a\.id\} a=\{a\} dev=\{deviceById\.get\(a\.device_id\)\} taskRef=\{taskRefs\[a\.task_id\]\} terminalName=\{a\.actor_kind === 'external' \? terminalRefs\[a\.actor_ref\] : undefined\} \/>/.test(page),
      'W-5b ★调用点把 `taskRefs[a.task_id]` / `terminalRefs[a.actor_ref]` 都交给 `AuditRow`（两跳都真接上）');
  }

  // ═══ S｜哑雷自检 + build 钉（派生核对，不写轮次字面量）════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 ★方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言抛异常时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
try {
  main();
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261014_3: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
} catch (e: unknown) {
  console.error(`\n💥 rr_zx_20261014_3 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ rr_zx_20261014_3: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
}
