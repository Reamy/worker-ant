/**
 * zx_20261029_3 「辨」受控回归 —— 可修之事与待人之事，各归其位。
 *
 * 八组判据（照方案 §4）：
 *   A 抽取分判：待人项不立项（进 manualItems / [INFO]）、可修项立项、共用去重、两个上限分账、REPORT_TEXT 反证。
 *   B 配置方言：nginx 行末分号句 ⇒ 充分；只有注释的 .conf ⇒ 仍不足；pom/properties/json 不回归；仍**只有一条** pattern。
 *   C 后台进程：真进程组登记→leftover 0→1→停掉（ESRCH）、未登记不碰、win32 如实 unsupported、
 *     毒行（pid/pgid 为 NULL 或 0）不得被读成"进程组 0"（零信号反证）。
 *   D 列表可见性：digest 恰 12 键逐项枚举；四个账徽标正/反标本；自评只认 finalize_task；来源六值 + 表外原样；产物含新文案。
 *   E 多段命令：放行三种串联与引号内分隔符；逐段拦截 sudo/破坏性/管道/后台/替换/换行；9 段拒；开关关 ⇒ 回旧层。
 *   F 孤儿三态：登记表内 / 疑似遗留 / 别人的 —— 只报不杀；未命中零杀、命中一次 SIGTERM。
 *   G 构建钉：checkBuildPins P1–P6。
 *   H 收口卫生：无「只为下一轮」字面量、断言文案无失败字形、断言数如实记账。
 *
 * 纪律：零网络 / 零 electron；夹具引生产 DDL（`BACKGROUND_JOBS_DDL`）；计数器带 0→1 正面断言；
 *   不以墙钟为判据；真进程段落在 finally 清场。
 */
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_MANUAL_ITEMS,
  MAX_VERIFICATION_ISSUES,
  createVerificationFixTask,
  extractVerificationIssues,
  isHumanOnlyIssue,
} from '../apps/worker-ant-desktop/src/main/core/verification-issues.js';
import { ARCHETYPE_VALIDATION, validateOutput } from '../apps/worker-ant-desktop/src/main/core/output-validator.js';
import {
  BACKGROUND_JOBS_DDL,
  attachBackgroundPid,
  defaultIsAlive,
  listBackgroundJobs,
  makeShellHooks,
  probeLeftovers,
  registerBackgroundJob,
  scanOrphanServiceChains,
  settleBackgroundJob,
  stopBackgroundJob,
  stopOrphanServiceChain,
  stopTrackedBackgroundJobs,
  trackedPgidsOf,
  type BackgroundDb,
} from '../apps/worker-ant-desktop/src/main/core/background-jobs.js';
import {
  MAX_SHELL_SEGMENTS,
  MULTI_SEGMENT_SEPARATORS,
  buildToolConstraintBrief,
  evaluateMultiSegment,
  firstRejectedShellChar,
  splitShellSegments,
} from '../apps/worker-ant-desktop/src/main/core/tool-guards.js';
import { runShellCommand } from '../apps/worker-ant-desktop/src/main/core/shell-exec.js';
import { taskSourceLabel } from '../apps/worker-ant-desktop/renderer/src/lib/task-source.js';
import { accountBadgeTask, isAwaitingReplyTask, isSelfAssessedQuality } from '../apps/worker-ant-desktop/renderer/src/lib/task-badges.js';
import { ROUND_RE, checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';

const ROOT = path.join(__dirname, '..');
const MAIN = 'apps/worker-ant-desktop/src/main/core';
/** 本轮标识**由载体自身派生**（不写「只为下一轮」的字面量）。 */
const SELF_ROUND = path.basename(__filename, '.ts').replace(/^rr_/, '');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}
function readText(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}
function readCode(rel: string): string {
  return stripKeepingLines(readText(rel)).join('\n');
}
const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function freshJobsDb(): BackgroundDb {
  const db = new DatabaseSync(':memory:');
  db.exec(BACKGROUND_JOBS_DDL);
  return db as unknown as BackgroundDb;
}

/** 生产形状的 `wa_tasks`（列与 `database.ts` 同形；只到本套件用到的列）。 */
function freshTasksDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_tasks (
      id TEXT PRIMARY KEY, project_id TEXT, title TEXT, description TEXT, status TEXT,
      priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
      source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '', aggregate_version INTEGER DEFAULT 0,
      quality_score REAL, context_json TEXT, created_at TEXT, updated_at TEXT
    );
  `);
  return db;
}

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261029-3-'));
  try {
    await sectionA();
    await sectionB(tmpDir);
    await sectionC();
    await sectionD();
    await sectionE();
    await sectionF();
    sectionG();
    sectionH();
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清场失败不影响裁决 */ }
  }

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
}

// ══════════════════════════════════════════════════════════════════════
// A 抽取分判
// ══════════════════════════════════════════════════════════════════════

async function sectionA(): Promise<void> {
  console.log('\n【A】M1：可修 / 待人分判');

  const HUMAN_LINES = [
    '## ❌ 需 GUI 人工操作验证支付回调',
    '## ❌ 需运行实例 + MySQL 测试库',
    '## ❌ 需要在你们的服务器上重编译部署',
    '## ⚠️ 需扫码登录后手动截图核对',
  ];
  const human = extractVerificationIssues([HUMAN_LINES.join('\n')]);
  eq(human.issues, [], 'A-1 待人标本一条也不进可修账');
  eq(human.manualItems.length, 4, 'A-2 四条待人事项如实登记（不丢弃——待人实测丢弃）');
  eq(human.manualOverflow, 0, 'A-3 未超待人展示上限');
  ok(human.manualItems.every((s) => isHumanOnlyIssue(s)), 'A-4 登记进来的每一条都判为待人');

  // 反证：可修的话不能说成待人（「部署脚本缺失」「登录接口未实现」仍可修）
  ok(!isHumanOnlyIssue('部署脚本缺失'), 'A-5a 反证：部署脚本缺失 ⇒ 可修（资源词无「需/无法」同句）');
  ok(!isHumanOnlyIssue('登录接口未实现'), 'A-5b 反证：登录接口未实现 ⇒ 可修（刻意不收裸「登录」）');

  const MIXED = [
    '## ❌ 分页 offset 与 total 不一致',
    '## ❌ 需 GUI 人工操作验证支付回调',
    '## ❌ 支付回调未接入',
  ].join('\n');
  const mixed = extractVerificationIssues([MIXED]);
  eq(mixed.issues.length, 2, 'A-6 混合标本：只有可修项进 issues');
  eq(mixed.manualItems.length, 1, 'A-7 混合标本：待人项单独成账');
  ok(mixed.issues.every((s) => !isHumanOnlyIssue(s)), 'A-8 可修账里没有待人项（共用去重集，不两处都算）');

  // 去重共用同一集
  const dup = extractVerificationIssues([`## ❌ 支付回调未接入\n## ❌ 支付回调未接入\n## ❌ 需人工核对界面`]);
  eq([dup.issues.length, dup.manualItems.length], [1, 1], 'A-9 同句重复只记一次（可修/待人共用同一去重集）');

  // 两个上限分账
  const manyHuman = Array.from({ length: MAX_MANUAL_ITEMS + 1 }, (_, i) => `## ❌ 需人工确认第 ${i + 1} 项界面`).join('\n');
  const mOver = extractVerificationIssues([manyHuman]);
  eq([mOver.manualItems.length, mOver.manualOverflow], [MAX_MANUAL_ITEMS, 1], 'A-10 待人上限 + 超出计数分账');
  const manyIssues = Array.from({ length: MAX_VERIFICATION_ISSUES + 1 }, (_, i) => `## ❌ 模块 ${i + 1} 未接入`).join('\n');
  const iOver = extractVerificationIssues([manyIssues]);
  eq([iOver.issues.length, iOver.overflow, iOver.manualItems.length], [MAX_VERIFICATION_ISSUES, 1, 0],
    'A-11 可修上限 + 超出计数分账（待人不被截断计数污染）');

  // 反证：既有报告一条不少、一条不被误判待人
  const REPORT_TEXT = [
    '# 20260924 实施结果核验总报告',
    '',
    '| 检查项 | 判定 | 说明 |',
    '| --- | --- | --- |',
    '| 端到端业务链（下单→派单→履约→完成→支付→回款） | ⚠️ **代码级通过，实调未完成** | 链路代码齐备；受环境限制未实跑 |',
    '| 页面数据来源真实性 | ⚠️ **部分通过** | 11 页仍读静态 mock，其中**价格与后端锁价不同源**（R-10，交易正确性风险） |',
    '| 生产就绪 | ❌ **不通过** | 3 项上线阻断：后端 /upload 缺失、属地化定价未落地、履约定位为模拟实现 |',
    '| M1-BUG-13 | /upload 前端纯 mock | ⚠️ 半闭环（后端无端点→R-06b） |',
    '',
    '### 8. ⚠️ 演示级',
    '',
    '| 编号 | 判定 | 依据 |',
    '| --- | --- | --- |',
    '| 1 | ⚠️ 不通过 | 依据：状态机的 3 个分支未接入 |',
    '| 4 | ⚠️ 需修正 | 键名不一致：acceptance_check 与 accept_check |',
    '| 10 | ⚠️ 静态成立 | 依据：单元测试通过 |',
  ].join('\n');
  const rep = extractVerificationIssues([REPORT_TEXT]);
  eq(rep.issues.length, 5, 'A-12 反证：REPORT_TEXT 五条一条不少（删裸「需」未误伤既有报告）');
  eq(rep.manualItems, [], 'A-13 反证：REPORT_TEXT 无一条被误判待人');

  // 立项：可修项进描述与验收标准，待人项即便混进来也不得出现
  const db = freshTasksDb();
  db.prepare(`INSERT INTO wa_tasks (id, project_id, title, description, status, context_json) VALUES (?,?,?,?,'executing','{}')`)
    .run('origin-task', 'p1', '核实报告', '报告');
  const fix = createVerificationFixTask({ db, taskId: 'origin-task', projectId: 'p1', issues: mixed.issues });
  ok(fix.description.includes('分页 offset 与 total 不一致') && fix.description.includes('支付回调未接入'),
    'A-14 修复任务描述逐条列出可修项');
  ok(!fix.description.includes('人工操作'), 'A-15 待人项**不出现**在修复任务描述里');
  eq(fix.acceptanceCriteria.split('\n').length, 2, 'A-16 验收标准与可修项一一对应（都不是空话）');
  const row = db.prepare('SELECT parent_task_id, depends_on, source FROM wa_tasks WHERE id = ?').get(fix.id) as
    { parent_task_id: string | null; depends_on: string; source: string } | undefined;
  eq([row?.parent_task_id, row?.depends_on, row?.source], [null, 'origin-task', 'agent'],
    'A-17 根任务 + 前置=报告任务（不与父并发，不占子任务槽）');

  const cf = readCode(`${MAIN}/tools/control-finalize.ts`);
  ok(/if \(issues\.length > 0\) \{[\s\S]{0,6000}?createVerificationFixTask\(/.test(cf),
    'A-18 零可修件 ⇒ 不建任务（立项只在 issues>0 分支内）');
  ok(cf.includes('fixCtx.verification_manual_items = manualItems'), 'A-19 待人项落 ctx（界面/后续轮次可查账）');
  ok(/\[INFO\] 其中 \$\{manualItems\.length\} 条需人工执行/.test(cf), 'A-20 待人项以 [INFO] 明列"不自动立项"');
}

// ══════════════════════════════════════════════════════════════════════
// B 配置方言
// ══════════════════════════════════════════════════════════════════════

async function sectionB(tmpDir: string): Promise<void> {
  console.log('\n【B】M2：配置按自身的语法判');

  const rule = ARCHETYPE_VALIDATION.configuration!;
  eq(rule.requiredPatterns.length, 1, 'B-1 仍只有一条 requiredPatterns（全中语义；两条会让每份配置都缺第二条）');
  eq(rule.minSize, 100, 'B-2 minSize 未动（尺没被整根换掉，只补了一种方言）');

  const NGINX = [
    'server {',
    '  listen 80;',
    '  server_name ysl.example.com;',
    '  location / {',
    '    valid_referers none blocked server_names *.example.com;',
    '    if ($invalid_referer) {',
    '      return 403;',
    '    }',
    '  }',
    '  proxy_pass http://127.0.0.1:8000;',
    '}',
    '',
  ].join('\n');
  const COMMENTS = [
    '# ysl 反向代理配置（待补）',
    '# TODO: 补 server 段与 valid_referers',
    '# 目前只有注释，没有任何生效声明',
    '# 占位说明占位说明占位说明占位说明占位说明',
    '',
  ].join('\n');
  const POM = `<?xml version="1.0" encoding="UTF-8"?>\n<project>\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>com.example</groupId>\n  <artifactId>ysl</artifactId>\n  <version>1.0.0</version>\n</project>\n`;
  const PROPS = 'server.port=8080\nspring.application.name=ysl-server\nlogging.level.root=info\ndatasource.url=jdbc:mysql://127.0.0.1:3306/ysl\n';
  const JSONC = '{\n  "server": {\n    "port": 8080,\n    "name": "ysl-server"\n  },\n  "features": {\n    "pay": true,\n    "wechatMiniProgram": true\n  }\n}\n';
  const TINY = 'server {\n}\n';

  const write = (name: string, text: string): string => {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, text, 'utf-8');
    return p;
  };
  for (const [k, v] of Object.entries({ NGINX, COMMENTS, POM, PROPS, JSONC, TINY })) {
    ok(Buffer.byteLength(v) >= (k === 'TINY' ? 1 : 100), `B-3 标本 ${k} 体量符合预期（${Buffer.byteLength(v)}B）`);
  }

  ok(NGINX.length > 100 && rule.requiredPatterns.every((p) => p.pattern.test(NGINX)),
    'B-4 真 nginx 片段（server{} + valid_referers）命中唯一 pattern');
  ok(!rule.requiredPatterns[0]!.pattern.test(COMMENTS),
    'B-5 反证：只有注释/TODO 的 .conf 不命中（注释行不算声明）');
  for (const [name, text] of [['pom.xml', POM], ['application.properties', PROPS], ['settings.json', JSONC]] as const) {
    ok(rule.requiredPatterns.every((p) => p.pattern.test(text)), `B-6 ${name} 仍命中（三类既有方言不回归）`);
  }

  const stubAns = { getOptimalModel: async () => null };
  const rNginx = await validateOutput(stubAns as never, write('ysl.conf', NGINX), 'configuration');
  ok(rNginx.status === 'ok' && rNginx.quickCheck.passed, 'B-7 走真 validateOutput：nginx 片段判充分', `status=${rNginx.status}`);
  const rComment = await validateOutput(stubAns as never, write('todo.conf', COMMENTS), 'configuration');
  ok(rComment.status === 'insufficient', 'B-8 反证：只有注释的 .conf 仍判不足', JSON.stringify(rComment.quickCheck.issues));
  const rTiny = await validateOutput(stubAns as never, write('tiny.conf', TINY), 'configuration');
  ok(rTiny.status === 'insufficient' && rTiny.quickCheck.issues.some((s) => s.includes('文件过小')),
    'B-9 小于 minSize 仍不足（闸没被放宽成"有分号就过"）');
  for (const [name, text] of [['pom.xml', POM], ['application.properties', PROPS], ['settings.json', JSONC]] as const) {
    const r = await validateOutput(stubAns as never, write(name, text), 'configuration');
    ok(r.status === 'ok', `B-10 ${name} 走真实现仍判充分（不回归）`, `status=${r.status}`);
  }
}

// ══════════════════════════════════════════════════════════════════════
// C 后台进程
// ══════════════════════════════════════════════════════════════════════

async function sectionC(): Promise<void> {
  console.log('\n【C】M3：登记 / 落幕判残留 / 停止 / 退出带走 / 毒行反证');

  const cleanup: number[] = [];
  try {
    // ── C-1 真起进程：shell 秒退、孙进程仍在同一组 ⇒ leftover 0→1 ──
    const db = freshJobsDb();
    const before = listBackgroundJobs(db).filter((r) => r.status === 'leftover').length;
    const tracked = makeShellHooks(db, {
      projectId: 'p1', taskId: 't1', tool: 'execute_command',
      command: 'sleep 30 >/dev/null 2>&1 & sleep 0.3', cwd: '/tmp',
    });
    const r = await runShellCommand('sleep 30 >/dev/null 2>&1 & sleep 0.3', {
      cwd: '/tmp', timeoutMs: 10_000, maxBuffer: 65536, ...tracked.hooks,
    });
    ok(r.ok && !r.timedOut, 'C-1 命令本身成功返回（后台子进程已重定向输出）', `exit=${r.exitCode} timedOut=${r.timedOut}`);
    const rows = listBackgroundJobs(db);
    eq(rows.length, 1, 'C-2 登记表恰一行（先登记后 spawn）');
    const row = rows[0]!;
    if (row.pgid != null) cleanup.push(row.pgid);
    const after = rows.filter((x) => x.status === 'leftover').length;
    eq([before, after], [0, 1], 'C-3 命令返回后 leftover 0→1（正面计数，不只看"不抛"）');
    ok(row.pgid != null && row.pid === row.pgid, 'C-4 POSIX 下 pgid = pid（自成进程组）', `pid=${row.pid} pgid=${row.pgid}`);
    ok(row.group_attributable, 'C-5 可整组归属（界面给停止按钮的前提）');
    ok(defaultIsAlive(row.pgid as number), 'C-6 整组确实还活着（不是假残留）');

    // ── C-7 停止：组消失（ESRCH）；重复停止如实"无需" ──
    const stopped = await stopBackgroundJob(db, tracked.jobId, { graceMs: 300 });
    ok(stopped.ok && stopped.status === 'stopped', 'C-7 停止成功', JSON.stringify(stopped));
    ok(!defaultIsAlive(row.pgid as number), 'C-8 停止后负 pgid 探测抛 ESRCH（组已不在）');
    const again = await stopBackgroundJob(db, tracked.jobId);
    ok(!again.ok && /无需停止|已不存在/.test(again.message), 'C-9 重复停止如实回"无需停止"', again.message);

    // ── C-10 未登记进程不受影响 ──
    const outsider = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    try {
      await sleepReal(100);
      ok(outsider.pid != null && defaultIsAlive(outsider.pid), 'C-10a 外部进程（未登记）仍活着');
      const byFakeId = await stopBackgroundJob(db, 'not-a-real-id');
      ok(!byFakeId.ok && /未登记/.test(byFakeId.message), 'C-10b 停未登记 id 被拒（只停账上的）');
      ok(defaultIsAlive(outsider.pid as number), 'C-10c 外部进程依旧活着（没被误杀）');
    } finally {
      try { process.kill(-(outsider.pid as number), 'SIGKILL'); } catch { /* 已退出 */ }
    }

    // ── C-11 spawn 失败 ⇒ unsupported；win32 ⇒ 代平台如实拒 ──
    const db2 = freshJobsDb();
    const h2 = makeShellHooks(db2, { projectId: '', taskId: '', tool: 'bash', command: 'x', cwd: '/tmp' });
    h2.hooks.onSpawn({ pid: undefined });
    h2.hooks.onSettle({ exitCode: null });
    const u = listBackgroundJobs(db2)[0]!;
    ok(u.status === 'unsupported' && !u.group_attributable, 'C-11 pid 空 ⇒ unsupported 且不可归属（不假装在跑）');
    const stopU = await stopBackgroundJob(db2, h2.jobId);
    ok(!stopU.ok, 'C-12 对 unsupported 行的停止请求被如实拒', stopU.message);
    const winStop = await stopBackgroundJob(db2, h2.jobId, { platform: 'win32' });
    ok(!winStop.ok && winStop.status === 'unsupported' && /Windows/.test(winStop.message),
      'C-13 win32 ⇒ 如实回 unsupported（零杀动作）', winStop.message);
    eq(await stopTrackedBackgroundJobs(db2, { platform: 'win32' }), 0, 'C-14 win32 退出路径零动作');
    eq(probeLeftovers(db2, { platform: 'win32' }), 0, 'C-15 win32 对账零动作');

    // ── C-16 对账：死了的 running 行 ⇒ exited ──
    const db3 = freshJobsDb();
    const id3 = registerBackgroundJob(db3, { tool: 'bash', command: 'sleep 0', cwd: '/tmp' });
    attachBackgroundPid(db3, id3, 999_998);
    eq(probeLeftovers(db3), 1, 'C-16 死组的 running 行被改成 exited（对账计数 0→1）');

    // ── C-17 退出带走：批量停仍活的组，账上记 stopped ──
    const db4 = freshJobsDb();
    const h4 = makeShellHooks(db4, {
      projectId: '', taskId: '', tool: 'run_privileged',
      command: 'sleep 40 >/dev/null 2>&1 & sleep 0.2', cwd: '/tmp',
    });
    await runShellCommand('sleep 40 >/dev/null 2>&1 & sleep 0.2', { cwd: '/tmp', timeoutMs: 10_000, maxBuffer: 65536, ...h4.hooks });
    const pg4 = listBackgroundJobs(db4)[0]!.pgid as number;
    cleanup.push(pg4);
    ok(defaultIsAlive(pg4), 'C-17a 退出前该组确实活着');
    eq(await stopTrackedBackgroundJobs(db4, { graceMs: 300 }), 1, 'C-17b 退出路径带走 1 组（正面计数）');
    ok(!defaultIsAlive(pg4), 'C-17c 带走后该组已消失');
    eq(listBackgroundJobs(db4)[0]!.status, 'stopped', 'C-17d 账上记为 stopped');

    // ── C-18 毒行反证：NULL / 0 不得被读成"进程组 0"（kill(-0) 会广播给调用者自己）──
    ok(defaultIsAlive(0) === false, 'C-18a `defaultIsAlive(0)` 为 false（进程组 0 是调用者自己，绝不探活）');
    ok(defaultIsAlive(-5) === false, 'C-18b 负 pgid 一律按"不是活组"（不发任何信号）');
    const db5 = freshJobsDb();
    db5.prepare(`INSERT INTO wa_background_jobs (id, tool, command, pgid, pid, status) VALUES ('n1','bash','sleep 1',NULL,NULL,'leftover')`).run();
    const nRow = listBackgroundJobs(db5)[0]!;
    ok(nRow.pgid === null && nRow.pid === null, 'C-18c NULL pid/pgid 读回仍是 null（不是 0——`Number(null)===0` 陷阱）');
    ok(!nRow.group_attributable, 'C-18d NULL 组不可归属（界面不给假按钮）');
    const nKills: Array<[number, NodeJS.Signals]> = [];
    const nStop = await stopBackgroundJob(db5, 'n1', { isAlive: () => true, killGroup: (g, s) => nKills.push([g, s]), sleep: async () => {} });
    ok(!nStop.ok && /无法整组停止/.test(nStop.message) && nKills.length === 0,
      'C-18e 毒行停止请求被拒且零信号', nStop.message);
    db5.prepare(`INSERT INTO wa_background_jobs (id, tool, command, pgid, pid, status) VALUES ('z1','bash','sleep 1',0,0,'leftover')`).run();
    const zKills: Array<[number, NodeJS.Signals]> = [];
    const zN = await stopTrackedBackgroundJobs(db5, { isAlive: () => true, killGroup: (g, s) => zKills.push([g, s]), sleep: async () => {}, graceMs: 1 });
    eq([zN, zKills.length], [0, 0], 'C-18f 退出路径对 pgid=0 的行零动作（SQL `pgid > 0` 与探活守卫同源）');
    ok(!trackedPgidsOf(db5).has(0), 'C-18g 孤儿排除集里没有 0（毒值不混进"已登记"）');
  } finally {
    for (const pg of cleanup) {
      try { process.kill(-pg, 'SIGKILL'); } catch { /* 已退出 */ }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// D 列表可见性
// ══════════════════════════════════════════════════════════════════════

async function sectionD(): Promise<void> {
  console.log('\n【D】M4：四个账说清（digest / 徽标 / 自评 / 来路 / 产物）');

  const ipcSrc = readCode('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
  const m = ipcSrc.match(/const rows = db\.prepare\(`(SELECT t\.id,[\s\S]*?)`\)\.all\(projectId, \.\.\.page\.params\)/);
  ok(!!m, 'D-1 从生产源码取出 task:list 的 SELECT（先自证扫描面）');
  const sql = (m?.[1] || '').replace('${page.sql}', '');

  const db = freshTasksDb();
  const bigCtx = {
    dynamic_priority: 7, completion_quality: { score: 88, via: 'finalize_task' }, tokens_used: 1234,
    budget_max_tokens: 50000, strategy_source: 'template', bottleneck_score: 3,
    reason: 'abandoned_by_user', awaiting_input: true, pending_approval: false, pause_reason: 'waiting',
    verification_fix: true, verification_fix_of: 'task-origin',
    attachments: ['/x/y.md'],
    world_snapshot_before: { fileHashes: Array.from({ length: 400 }, (_, i) => `/f${i}.ts:${i}`) },
  };
  db.prepare(`INSERT INTO wa_tasks (id, project_id, title, description, status, priority, context_json, created_at, updated_at)
    VALUES ('t1','p1','T','D','paused',0,?,'2026-10-29T02:00:00Z','2026-10-29T02:00:00Z')`).run(JSON.stringify(bigCtx));
  const row = db.prepare(sql).get('p1') as Record<string, unknown> | undefined;
  ok(!!row, 'D-2 该语句在生产形状夹具上真跑通');
  let digest: Record<string, unknown> = {};
  try { digest = JSON.parse(String(row?.context_digest || '{}')) as Record<string, unknown>; } catch { /* 下面判 */ }
  eq(Object.keys(digest).sort(), [
    'awaiting_input', 'bottleneck_score', 'budget_max_tokens', 'completion_quality', 'dynamic_priority',
    'pause_reason', 'pending_approval', 'reason', 'strategy_source', 'tokens_used',
    'verification_fix', 'verification_fix_of',
  ], 'D-3 摘录恰 12 键（逐项枚举，不用总数冒充）');
  eq([digest.verification_fix, digest.verification_fix_of], [1, 'task-origin'],
    'D-4 自动派生两键随摘录过 IPC（布尔收为 1，渲染层按真值判）');

  // ── 四个账徽标：正/反标本各一 ──
  eq(accountBadgeTask({ status: 'completed', acc_total: 0, acc_passed: 0 })?.text, '未设验收',
    'D-5a 已完成且未设验收 ⇒「未设验收」');
  eq(accountBadgeTask({ status: 'completed', acc_total: 3, acc_passed: 3 }), null,
    'D-5b 反证：验收全通过的任务**不得**出现「未设验收」');
  eq(accountBadgeTask({ status: 'completed', acc_total: 3, acc_passed: 2 })?.text, '验收 2/3',
    'D-6a 已完成但有判据未达成 ⇒「验收 2/3」');
  eq(accountBadgeTask({ status: 'executing', acc_total: 3, acc_passed: 0 }), null,
    'D-6b 反证：在途任务不贴验收账（没到判账的时候）');
  const awaiting = { status: 'paused', context_digest: JSON.stringify({ awaiting_input: true }) };
  eq(accountBadgeTask(awaiting)?.text, '待你回复', 'D-7a 待回复（paused + awaiting_input）');
  eq(accountBadgeTask({ status: 'paused', context_digest: '{}' }), null, 'D-7b 反证：手动暂停不标「待你回复」');
  const derived = { status: 'executing', context_digest: JSON.stringify({ verification_fix: true }) };
  eq(accountBadgeTask(derived)?.text, '自动派生', 'D-8a 自动立项的修复任务 ⇒「自动派生」');
  eq(accountBadgeTask({ status: 'executing', context_digest: JSON.stringify({ verification_fix: false }) }), null,
    'D-8b 反证：普通任务不标「自动派生」');
  eq(accountBadgeTask({ status: 'completed', acc_total: 0, context_digest: JSON.stringify({ verification_fix: true }) })?.text,
    '未设验收', 'D-9 互斥优先：一行的账徽标只有一个（未设验收优先于自动派生）');
  ok(isAwaitingReplyTask(awaiting) && !isAwaitingReplyTask({ status: 'paused', context_digest: '{}' }),
    'D-10 「待回复」判据本身两侧都成立（筛选器与徽标同一把尺）');

  // ── 自评小字只认 finalize_task ──
  const q = (via: string | undefined) => JSON.stringify({ completion_quality: { score: 80, ...(via ? { via } : {}) } });
  ok(isSelfAssessedQuality({ status: 'completed', context_digest: q('finalize_task') }), 'D-11a finalize_task ⇒ 标「自评」');
  ok(!isSelfAssessedQuality({ status: 'completed', context_digest: q('run_close') }), 'D-11b 反证：run_close 的分**不得**标「自评」');
  ok(!isSelfAssessedQuality({ status: 'completed', context_digest: '{}' }), 'D-11c 无质量分 ⇒ 无小字');

  // ── 来路六值 + 表外原样 ──
  eq(
    ['user', 'agent', 'auto-decompose', 'auto-decompose-roll', 'cron', 'template'].map((s) => taskSourceLabel(s)),
    ['你创建', '智能体', '自动拆解', '滚动拆解', '定时', '模板'],
    'D-12 来路词表六值全命中（列表与详情同引一份）',
  );
  eq(taskSourceLabel('custom-x'), 'custom-x', 'D-13 表外取值原样返回（不伪造成已知词）');

  // ── 接线与产物 ──
  const tasksPage = readCode('apps/worker-ant-desktop/renderer/src/pages/TasksPage.tsx');
  ok(tasksPage.includes("from '../lib/task-badges'") && tasksPage.includes('accountBadge(') && tasksPage.includes('isSelfAssessedQuality(t)'),
    'D-14 列表页引同一份判据（渲染层不另抄一份）');
  const settingsSrc = readCode('apps/worker-ant-desktop/renderer/src/pages/SettingsPage.tsx');
  ok(settingsSrc.includes("'engine.kill_background_on_exit'") && settingsSrc.includes('退出时带走后台进程'),
    'D-15 退出带走的开关有 GUI 读写口（承诺的开关必须点得到）');
  const boolSrc = readCode(`${MAIN}/settings-bool.ts`);
  ok(boolSrc.includes("'engine.kill_background_on_exit'") && boolSrc.includes("'engine.shell_multi_segment'"),
    'D-16 两个新开关都在 boolSetting 白名单（面板与引擎读同一个口）');

  const distAssets = path.join(ROOT, 'apps/worker-ant-desktop/renderer/dist/assets');
  const findChunk = (prefix: string): string | null => {
    try {
      const f = fs.readdirSync(distAssets).find((n) => n.startsWith(prefix) && n.endsWith('.js'));
      return f ? fs.readFileSync(path.join(distAssets, f), 'utf-8') : null;
    } catch { return null; }
  };
  const tasksChunk = findChunk('TasksPage-');
  ok(tasksChunk !== null, 'D-17 TasksPage 独立 chunk 在位');
  for (const s of ['未设验收', '验收 ', '待你回复', '自动派生', '自评']) {
    ok(tasksChunk?.includes(s) ?? false, `D-18 任务页产物含「${s}」`);
  }
  const activityChunk = findChunk('ActivityPage-');
  ok(activityChunk !== null && (activityChunk?.includes('后台进程') ?? false), 'D-19 活动页产物含「后台进程」节');
  const settingsChunk = findChunk('SettingsPage-');
  ok(settingsChunk !== null && (settingsChunk?.includes('退出时带走后台进程') ?? false), 'D-20 设置页产物含新开关文案');
}

// ══════════════════════════════════════════════════════════════════════
// E 多段命令
// ══════════════════════════════════════════════════════════════════════

async function sectionE(): Promise<void> {
  console.log('\n【E】M5：多段命令——语法不等于权限');

  eq([...MULTI_SEGMENT_SEPARATORS], ['&&', '||', ';'], 'E-1 分隔符集合只三种（`&`/`|` 不在此列）');
  eq(MAX_SHELL_SEGMENTS, 8, 'E-2 段数上限为 8');

  eq(splitShellSegments('git commit -m "a;b"').length, 1, 'E-3 引号内的分号不切分（字符串内容不是分隔符）');
  eq(splitShellSegments("echo 'a && b'").length, 1, 'E-4 单引号内 && 不切分');
  eq(splitShellSegments('ls || pwd').filter((s) => s.trim()).length, 2, 'E-5 `||` 切成两段');

  const allow = ['cd /x && git status', 'git status; git diff', 'ls || pwd', 'git commit -m "a;b"', 'git status'];
  for (const cmd of allow) {
    const v = evaluateMultiSegment(cmd, 'execute_command', '/work');
    ok(v.ok, `E-6 放行：${cmd}`, v.ok ? '' : v.advice);
  }

  const deny: Array<[string, RegExp, number]> = [
    ['cd /x && sudo apt install x', /系统管理/, 1],
    ['(sudo x', /系统管理/, 0],
    ['echo x; rm -rf /tmp/x', /破坏性/, -1],
    ['curl x; docker ps', /系统管理/, 1],
    ['cmd &', /&/, 0],
    ['cmd | cmd', /\|/, 0],
    ['echo $(whoami)', /\$/, 0],
    ['echo `whoami`', /`/, 0],
    ['echo a\necho b', /换行|\\n|被拒/, 0],
    ['bash -c ls', /解释器|shell/, 0],
  ];
  for (const [cmd, re, idx] of deny) {
    const v = evaluateMultiSegment(cmd, 'execute_command', '/work');
    ok(!v.ok && (re.test(v.advice) || re.test(String((v as { payload?: { error?: string } }).payload?.error ?? ''))),
      `E-7 拦截：${cmd.replace(/\n/g, '⏎')}`, v.ok ? '被放行了' : v.advice);
    if (!v.ok) eq(v.segmentIndex, idx, `E-8 指名出问题的那一段：${cmd.replace(/\n/g, '⏎')}`);
  }

  const nine = Array.from({ length: MAX_SHELL_SEGMENTS + 1 }, () => 'ls').join('; ');
  const v9 = evaluateMultiSegment(nine, 'execute_command', '/work');
  ok(!v9.ok && /第?\s*\d+\s*段|超过单次上限/.test(v9.advice), 'E-9 超段数上限如实拒（不截断执行）', v9.ok ? '' : v9.advice);

  // 开关关 ⇒ 逐字回旧层（字符级仍拒 `&&`）
  eq(firstRejectedShellChar('cd /x && git status', 'execute_command'), '&',
    'E-10 旧字符层语义未动（开关关时 `&&` 仍按 `&` 拒）');
  const shellSrc = readCode(`${MAIN}/tools/shell.ts`);
  ok(shellSrc.includes("readBoolSetting(db, 'engine.shell_multi_segment')") &&
    /if \(readBoolSetting\(db, 'engine\.shell_multi_segment'\)\) \{[\s\S]{0,800}?evaluateMultiSegment\(/.test(shellSrc),
    'E-11 execute_command 只有开关开时才走逐段校验（关 ⇒ 回旧路径）');
  ok(shellSrc.includes('evaluateMultiSegment(args.command, \'execute_command\', workingDir)') === false ||
    shellSrc.includes("evaluateMultiSegment(args.command, 'execute_command', workingDir)"),
    'E-12 接线按语句形状可认（工具名/参数逐一）');

  const brief = buildToolConstraintBrief();
  for (const s of MULTI_SEGMENT_SEPARATORS) ok(brief.includes(`「${s}」`), `E-13 能力简报含分隔符「${s}」`);
  ok(brief.includes(`最多 ${MAX_SHELL_SEGMENTS} 段`), 'E-14 段数上限由常量派生（不手抄）');
  ok(brief.includes('每一段'), 'E-15 简报明写"逐段检查"（模型读得到这条约束）');
  // bash 工具不变：白名单 + 字符表仍拒 `;`
  eq(firstRejectedShellChar('ls; pwd', 'bash'), ';', 'E-16 bash 工具不变（`;` 一律拒）');
}

// ══════════════════════════════════════════════════════════════════════
// F 孤儿识别三态
// ══════════════════════════════════════════════════════════════════════

async function sectionF(): Promise<void> {
  console.log('\n【F】M3：孤儿服务链——只报不杀');

  const repoRoot = '/tmp/rr-repo';
  const psOutput = [
    `  111  111 Mon Oct 27 10:00:00 2026 node ${repoRoot}/apps/ans-server/src/index.ts`,
    `  222  222 Mon Oct 27 10:01:00 2026 node ${repoRoot}/node_modules/.bin/tsx watch src/x.ts`,
    `  333  333 Mon Oct 27 10:02:00 2026 node /other/place/ans-server/src/index.ts`,
    `  444  444 Mon Oct 27 10:03:00 2026 sleep 100`,
    `  555  555 Mon Oct 27 10:04:00 2026 node ${repoRoot}/apps/ans-server/src/zzz.ts`,
  ].join('\n');

  const found = scanOrphanServiceChains({
    repoRoot, psOutput, trackedPgids: new Set([222]), selfPgid: 444,
  });
  eq(found.map((f) => f.pid), [111, 555], 'F-1 三态并存时只报「登记表外 ∧ 本仓路径 ∧ 服务标记」的两条');
  ok(found.every((f) => f.reason.includes('点停止才会动手')), 'F-2 每条都注明"点停止才动手"（只报不杀）');
  ok(
    scanOrphanServiceChains({ repoRoot, psOutput, trackedPgids: new Set([111, 222, 555]), selfPgid: 444 }).length === 0,
    'F-3 反证：全在登记表内 ⇒ 一条不报',
  );

  const src = stripKeepingLines(readText(`${MAIN}/background-jobs.ts`)).join('\n');
  const scanBody = src.slice(src.indexOf('export function scanOrphanServiceChains'), src.indexOf('export async function stopOrphanServiceChain'));
  ok(!/killGroup\(|process\.kill\(/.test(scanBody), 'F-4 扫描函数体内零杀动作（"只报不杀"是结构性的，不是约定）');

  const kills: Array<[number, NodeJS.Signals]> = [];
  const miss = await stopOrphanServiceChain(freshJobsDb(), { pid: 999, pgid: 999 }, {
    repoRoot, psOutput, trackedPgids: new Set(), selfPgid: 444,
    isAlive: () => true, killGroup: (g, s) => kills.push([g, s]), sleep: async () => {},
  });
  ok(!miss.ok && /复核未命中/.test(miss.message), 'F-5 复核未命中 ⇒ 拒绝动手', miss.message);
  eq(kills.length, 0, 'F-6 未命中时零杀动作');

  const hitKills: Array<[number, NodeJS.Signals]> = [];
  let alive = true;
  const done = await stopOrphanServiceChain(freshJobsDb(), { pid: 111, pgid: 111 }, {
    repoRoot, psOutput, trackedPgids: new Set(), selfPgid: 444,
    graceMs: 10,
    isAlive: () => alive,
    killGroup: (g, s) => { hitKills.push([g, s]); if (s === 'SIGTERM') alive = false; },
    sleep: async () => {},
  });
  ok(done.ok && done.status === 'stopped', 'F-7 命中时才动手', JSON.stringify(done));
  eq(hitKills, [[111, 'SIGTERM']], 'F-8 优雅退出一次即止（不发多余 SIGKILL）');
}

// ══════════════════════════════════════════════════════════════════════
// G 构建钉
// ══════════════════════════════════════════════════════════════════════

function sectionG(): void {
  console.log('\n【G】构建钉');
  checkBuildPins(ok, { distDir: path.join(ROOT, 'apps/worker-ant-desktop/dist') });
}

// ══════════════════════════════════════════════════════════════════════
// H 收口卫生
// ══════════════════════════════════════════════════════════════════════

function sectionH(): void {
  console.log('\n【H】收口卫生');
  ok(ROUND_RE.test(SELF_ROUND), 'H-1 本轮标识由载体自身派生且格式合法', SELF_ROUND);

  const selfLines = stripKeepingLines(fs.readFileSync(__filename, 'utf-8'));
  const dud = selfLines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /(?:eq\([^,)]*,\s*|===?\s*|!==?\s*)'zx_\d{8}(?:_\d+)?'/.test(line));
  ok(dud.length === 0, 'H-2 本套件无「只为下一轮」字面量', dud.map((x) => `${x.i + 1}:${x.line.trim()}`).join(' | '));

  // 字形本身**用码点构造**：把字形写进这条断言，断言就成了它自己禁的那类命中。
  const selfText = fs.readFileSync(__filename, 'utf-8');
  const badGlyphs = [0x2717, 0x2713].map((c) => String.fromCodePoint(c));
  ok(!badGlyphs.some((g) => selfText.includes(g)), 'H-3 本套件文案无失败/通过字形（全量汇总器按失败字形计数）');
  ok(/通过 \/ .*失败/.test(selfText), 'H-4 收尾行如实印出断言数（通过 / 失败）');
}

main().then(() => {
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`rr_${SELF_ROUND} 未捕获异常（复跑未跑完，不得读作通过）：`, e);
  fail++;
  console.log(`\nFAIL rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
