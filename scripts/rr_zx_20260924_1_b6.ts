/**
 * zx_20260924_1 M6（F7）受控复跑 —— 「写下的报表，要有人读」。
 *
 * 病根：`runSimplificationAudit` 把报告 INSERT 进 `wa_simplification_reports` 就完事，
 * 桌面端**零 SELECT**（唯一读者在已归档的旧 worker-ant-server）；`wa_self_healing_logs` 更彻底——
 * 全仓唯一"读"是 `tryHeal` 里那段 24h 熔断 COUNT（消费的是**计数**不是**记录**）。
 * 两件都是「做了，但没接到用户能看见的地方」。
 *
 * 本批只补「产出 → 可见」这条断线（审查规则四条一行未动）：
 *   1) 读取逻辑落各自的 core 模块（不放 admin.ipc.ts —— 那里顶层 import electron，受控回归跑不起来）；
 *   2) 由 `admin:diagnostics`（唯一诊断出口，不新造第二端点）带出 `simplification` / `selfHealing`；
 *   3) 简化审查接进既有的**小时**节拍（复用 system-bootstrap 那一个 setInterval，不新造第二套调度器）；
 *   4) 周期写入 ⇒ 报表加保留策略（只留最近 `SIMPLIFICATION_REPORT_KEEP` 条）。
 *
 * §不变式门：
 *   G-1 **真源在位**：直接 import 生产符号（`runSimplificationAudit` / `readLatestSimplificationReport` /
 *       `readRecentHealingLogs` / `SELF_HEALING_LOGS_DDL` / `SIMPLIFICATION_REPORT_KEEP`）——被删/改名 ⇒
 *       编译期失败，而不是"扫了个空、静默假绿"。夹具建表语句同引生产常量。
 *   G-2 **两只标本**：每条判据两侧都有真标本（有报告 / 无报告；有记录 / 无记录；正常 JSON / 坏 JSON）。
 *   G-3 **计数器正面断言**：写库与读取都断言"0 → 1"，不只断言"不抛"。
 *
 * ⚠ 本脚本不写任何轮次字面量（`scripts/lib/rr-pins.ts` 的 P5 逐处点名 file:line）。
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import {
  runSimplificationAudit, readLatestSimplificationReport, SIMPLIFICATION_REPORT_KEEP,
} from '../apps/worker-ant-desktop/src/main/core/simplification-audit.js';
import {
  readRecentHealingLogs, SELF_HEALING_LOGS_DDL,
} from '../apps/worker-ant-desktop/src/main/core/self-healing-monitor.js';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const MAIN = path.join(root, `${A}/src/main`);
const RENDERER = path.join(root, `${A}/renderer/src`);

/** 跑一段可能抛的调用，把"抛没抛"与"抛了什么"一并带出来——判据要的是"不抛"，故不能让它冒泡。 */
function attempt<T>(fn: () => T): { threw: boolean; value?: T; err?: string } {
  try { return { threw: false, value: fn() }; } catch (e) { return { threw: true, err: (e as Error).message }; }
}
const countRows = (d: InstanceType<typeof DatabaseSync>, sql: string): number =>
  (d.prepare(sql).get() as { c: number }).c;

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【A】空集是合法状态（反：无报告 ⇒ null 且不抛）');
const db = new DatabaseSync(':memory:');

// A-1 表都还没建（从未跑过审查）
const a1 = attempt(() => readLatestSimplificationReport(db));
ok(!a1.threw && a1.value === null, 'A-1 表不存在 ⇒ 返回 null 且不抛（"从没跑过"不是错误）',
  a1.threw ? `抛出：${a1.err}` : `实测 ${JSON.stringify(a1.value)}`);

// A-2 表已建但一行都没有（无发现项时**不写行**，故"表空"是常态之一，不是异常）
db.exec("CREATE TABLE wa_simplification_reports (id TEXT PRIMARY KEY, findings TEXT, severity_counts TEXT, created_at TEXT DEFAULT (datetime('now')))");
const a2 = attempt(() => readLatestSimplificationReport(db));
ok(!a2.threw && a2.value === null, 'A-2 表在但空 ⇒ 仍返回 null 且不抛（空集合法，非"抛出来让人发现"）',
  a2.threw ? `抛出：${a2.err}` : `实测 ${JSON.stringify(a2.value)}`);

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【B】正：真跑一次审查 ⇒ 读取函数看得见同一份结论（0 → 1）');
// 造一张**非 wa_ 前缀**的表：审查的第一条规则（tables）必然点它名为发现项
db.exec('CREATE TABLE zz_m6_probe (id TEXT)');
const findings = runSimplificationAudit(db);
ok(findings.length >= 1, 'B-1 真跑审查产出 ≥1 条 finding',
  `实测 ${findings.length} 条：${findings.map(f => f.location).join(' | ')}`);
ok(findings.some(f => f.location.includes('zz_m6_probe')),
  'B-2 命中的确是造出来的那张非 wa_ 前缀表（不是碰巧命中了别的什么）',
  findings.filter(f => f.location.includes('zz_m6_probe')).map(f => f.description).join('; '));

const before = countRows(db, 'SELECT COUNT(*) as c FROM wa_simplification_reports');
ok(before === 1, 'B-3 **计数器正面断言**：报告表 0 → 1 行（写入真的发生了，"不抛"不算数）', `实测 ${before} 行`);

const rep = attempt(() => readLatestSimplificationReport(db));
ok(!rep.threw && rep.value !== null && rep.value !== undefined, 'B-4 有报告时读取函数返回非空（A-1/A-2 的null是同一函数给出的反面标本）',
  rep.threw ? `抛出：${rep.err}` : `id=${rep.value?.id}`);
const r = rep.value!;
ok(r.findings.length === findings.length,
  'B-5 读取到的 findings 条数与 `runSimplificationAudit` 的返回值**相等**（产出与可见是同一份结论）',
  `读取 ${r.findings.length} / 产出 ${findings.length}`);
ok(r.findings.map(f => f.location).join('|') === findings.map(f => f.location).join('|'),
  'B-6 逐条 location 顺序一致（不是"条数对上、内容张冠李戴"）',
  r.findings.map(f => `${f.severity}:${f.location}`).join(' | '));

// B-7 严重度计数与 findings **对得上**（不是各写各的）
const sev = r.severity_counts;
const want = {
  high: r.findings.filter(f => f.severity === 'high').length,
  medium: r.findings.filter(f => f.severity === 'medium').length,
  low: r.findings.filter(f => f.severity === 'low').length,
};
ok(!!sev && sev.high === want.high && sev.medium === want.medium && sev.low === want.low,
  'B-7 severity_counts 与 findings 逐档对得上（三档分别核，不是只看总数）',
  `库内 ${JSON.stringify(sev)} / 实算 ${JSON.stringify(want)}`);
ok(!!sev && sev.low >= 1, 'B-8 **计数器正面断言**：low 档 ≥1（0 → 1 式；恒 0 的计数器会让 B-7 变成"零==零"的空判）',
  `low=${sev?.low}`);
ok(r.parse_error === null, 'B-9 正常行 parse_error 为空（与下面 C 的坏行构成两只标本）', String(r.parse_error));
ok(/^\d{4}-\d{2}-\d{2}/.test(r.created_at), 'B-10 报告时间如实带出（界面要显示的就是它）', r.created_at || '(空)');

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【C】反（坏数据）：JSON 列坏了 ⇒ 不抛且如实标注，不把坏 JSON 当空');
db.prepare("INSERT INTO wa_simplification_reports (id, findings, severity_counts, created_at) VALUES (?, ?, ?, datetime('now','+1 day'))")
  .run('bad-m6', '{oops', '{"high":');
const bad = attempt(() => readLatestSimplificationReport(db));
ok(!bad.threw, 'C-1 坏 JSON 行不抛（读取面是诊断页的数据源，抛一下整页就白了）', bad.threw ? `抛出：${bad.err}` : '');
ok(!bad.threw && bad.value !== null && bad.value !== undefined,
  'C-2 坏行**仍返回该行**（不许悄悄退回上一份旧报告冒充"最近一次"）', bad.threw ? '' : `id=${bad.value?.id}`);
ok(!bad.threw && bad.value!.parse_error !== null && bad.value!.parse_error !== '',
  'C-3 坏 JSON 被**标明**（parse_error 非空），而不是静默当成"无发现项"',
  bad.threw ? '' : String(bad.value!.parse_error).slice(0, 80));
ok(!bad.threw && bad.value!.findings.length === 0,
  'C-4 解析不出 findings ⇒ 空数组（与"真无发现项"共用空数组，但由 C-3 的 parse_error 区分开——两者不是一回事）',
  bad.threw ? '' : `findings=${bad.value!.findings.length}`);
ok(!bad.threw && bad.value!.created_at.length > 0, 'C-5 坏行的报告时间照常带出（哪一次的报表坏了，用户要看得见）',
  bad.threw ? '' : bad.value!.created_at);

// C-6 把坏行撤掉 ⇒ 又回到 B 那份好报告（同一函数，好坏两只标本各判各的，证明 C-2 不是"永远返回最后一行"）
db.prepare("DELETE FROM wa_simplification_reports WHERE id = 'bad-m6'").run();
const back = readLatestSimplificationReport(db);
ok(!!back && back.parse_error === null && back.findings.length === findings.length,
  'C-6 **两只标本一起试**：删掉坏行后同一函数又读出好报告（正常路径没被坏数据处理路径吃掉）',
  `findings=${back?.findings.length} parse_error=${String(back?.parse_error)}`);

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【D】自愈日志：空集合法 + 倒序 + 上限（表由生产 DDL 常量建，不手抄）');
const d1 = attempt(() => readRecentHealingLogs(db));
ok(!d1.threw && Array.isArray(d1.value) && d1.value!.length === 0,
  'D-1 表未建（自愈监控从未启动）⇒ 空数组且不抛',
  d1.threw ? `抛出：${d1.err}` : `实测 ${JSON.stringify(d1.value)}`);

db.exec(SELF_HEALING_LOGS_DDL); // 与生产建表同一份语句（唯一真源）
const d2 = attempt(() => readRecentHealingLogs(db));
ok(!d2.threw && d2.value!.length === 0, 'D-2 表在但空 ⇒ 空数组且不抛（0 条是合法状态，"暂无自愈记录"由界面如实说）',
  d2.threw ? `抛出：${d2.err}` : `实测 ${d2.value!.length} 条`);

// 三条真记录：不同时刻（-3/-2/-1 分钟）+ 一条失败态（success=0 要原样透出，不许"只报成功的"）
const insHeal = db.prepare('INSERT INTO wa_self_healing_logs (id, anomaly, action, success, detail, created_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\', ?))');
insHeal.run('h-old', '守护进程无心跳: 甲', '标记stale', 1, 'target: d-1', '-3 minutes');
insHeal.run('h-mid', '任务超时: 乙', '自动暂停', 0, 'error: boom', '-2 minutes');
insHeal.run('h-new', '悬挂子任务无出路: t-9', '标failed+真因', 1, 'target: t-9', '-1 minute');
const d3 = attempt(() => readRecentHealingLogs(db));
ok(!d3.threw && d3.value!.length === 3, 'D-3 插 3 条 ⇒ 读取 3 条（计数器 0 → 3，正面断言）',
  d3.threw ? `抛出：${d3.err}` : `实测 ${d3.value!.length} 条`);
const list = d3.value!;
ok(list.map(h => h.id).join(',') === 'h-new,h-mid,h-old',
  'D-4 **按时间倒序**（最新在前；插序恰好是反的，故"照插序返回"这条错路会被这条判红）',
  list.map(h => `${h.id}@${h.created_at}`).join(' | '));
ok(list[1]!.success === 0 && list[1]!.detail === 'error: boom',
  'D-5 失败态（success=0）与 detail 原样透出，不粉饰成成功', `success=${list[1]!.success} detail=${list[1]!.detail}`);
ok(list.every(h => typeof h.id === 'string' && typeof h.anomaly === 'string' && typeof h.action === 'string'
  && typeof h.success === 'number' && (h.detail === null || typeof h.detail === 'string') && typeof h.created_at === 'string'),
  'D-6 六列齐（id/anomaly/action/success/detail/created_at）——界面逐列都要用，缺一列就是空白冒充');
const d4 = readRecentHealingLogs(db, 2);
ok(d4.length === 2 && d4.map(h => h.id).join(',') === 'h-new,h-mid',
  'D-7 limit 生效：取 2 条即最新的两条（诊断页只展示最近 N 条，N 由调用方给）', d4.map(h => h.id).join(','));

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【E】保留策略：周期性写入 ⇒ 表被截到上限（断言具体行数，不是"能跑"）');
// 上限的**具体数字**单列一条：这是本批的设计裁定（报表是快照不是流水，留最近 50 条），
// 改大改小都得显式改这一行——不留"常量自己等于自己"的空判。
const KEEP_LITERAL = 50;
ok(SIMPLIFICATION_REPORT_KEEP === KEEP_LITERAL, `E-1 保留上限＝${KEEP_LITERAL} 条（写成字面量，与生产常量对账）`,
  `生产常量实测 ${SIMPLIFICATION_REPORT_KEEP}`);
const db2 = new DatabaseSync(':memory:');
db2.exec('CREATE TABLE zz_m6_probe (id TEXT)');
// 比上限多写 2 次（多出来的必须被裁掉）；封顶 200 次，防上限被改大后本脚本跑成"长时间横盘"
const WRITES = Math.min(SIMPLIFICATION_REPORT_KEEP + 2, 200);
for (let i = 0; i < WRITES; i++) runSimplificationAudit(db2);
const kept = countRows(db2, 'SELECT COUNT(*) as c FROM wa_simplification_reports');
ok(kept === SIMPLIFICATION_REPORT_KEEP,
  `E-2 写 ${WRITES} 次后表内**恰** ${SIMPLIFICATION_REPORT_KEEP} 行（行数上限取自生产常量，不在本脚本另抄一个数）`,
  `实测 ${kept} 行`);
ok(WRITES > kept, 'E-3 **反证（防恒真）**：写入次数 > 上限 ⇒ 确实发生了截断（否则 E-2 是"上限==上限"的自我印证）',
  `${WRITES} > ${kept}`);
const minRow = (db2.prepare('SELECT MIN(rowid) as m FROM wa_simplification_reports').get() as { m: number | null }).m;
ok(minRow === 3, 'E-4 裁掉的是**最早写入的 2 行**（最小 rowid 由 1 变 3；同秒写入时按 rowid 兜底定序）', `min(rowid)=${String(minRow)}`);
const latestId = readLatestSimplificationReport(db2)?.id;
const stillThere = (db2.prepare('SELECT COUNT(*) as c FROM wa_simplification_reports WHERE id = ?').get(latestId) as { c: number }).c;
ok(!!latestId && stillThere === 1,
  'E-5 裁完之后**最近一次**仍在（保留策略删的是旧的，不是把新写入的顺手也删了）',
  `最新 id 仍在：${String(latestId).slice(0, 8)}…（${stillThere} 行）`);

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【F】接线（源码级：一个诊断出口 + 一个小时节拍 + 启动一次保留）');
const adminSrc = stripKeepingLines(fs.readFileSync(path.join(MAIN, 'ipc/admin.ipc.ts'), 'utf-8')).join('\n');
const bootSrc = stripKeepingLines(fs.readFileSync(path.join(MAIN, 'core/system-bootstrap.ts'), 'utf-8')).join('\n');
const indexSrc = stripKeepingLines(fs.readFileSync(path.join(MAIN, 'index.ts'), 'utf-8')).join('\n');
const dashSrc = fs.readFileSync(path.join(RENDERER, 'pages/DashboardPage.tsx'), 'utf-8');

const diagHandles = [...adminSrc.matchAll(/ipcMain\.handle\(\s*'admin:diagnostics'/g)];
ok(diagHandles.length === 1, 'F-1 `admin:diagnostics` 恰 1 个处理体（**不新造第二个诊断端点**：两份诊断迟早各说各话）',
  `实测 ${diagHandles.length} 处`);
const diagAt = diagHandles[0]?.index ?? -1;
const nextHandle = adminSrc.indexOf('ipcMain.handle(', diagAt + 1);
const diagBody = diagAt >= 0 ? adminSrc.slice(diagAt, nextHandle > diagAt ? nextHandle : undefined) : '';
ok(diagBody.length > 0, 'F-2 诊断处理体切片非空（切块锚点在去注释面成立，否则下面两条是"扫了个空"的假绿）',
  `${diagBody.length} 字节`);
ok(/return\s*\{\s*data:\s*\{[^}]*simplification\b/s.test(diagBody) && /return\s*\{\s*data:\s*\{[^}]*selfHealing\b/s.test(diagBody),
  'F-3 返回体里**同一处**带出 `simplification` 与 `selfHealing` 两字段',
  `simplification=${/simplification\b/.test(diagBody)} selfHealing=${/selfHealing\b/.test(diagBody)}`);
ok(/from '\.\.\/core\/simplification-audit\.js'/.test(adminSrc) && /from '\.\.\/core\/self-healing-monitor\.js'/.test(adminSrc),
  'F-4 两个读取面都从各自 core 模块 import（真源在位；被删/改名本脚本开头就编译失败）');
ok(!/wa_simplification_reports/.test(adminSrc) && !/wa_self_healing_logs/.test(adminSrc),
  'F-5 **反证**：读取的 SQL 不在 admin.ipc.ts 里（那里顶层 import electron、受控回归跑不起来 ⇒ 写在那儿等于没有判据）',
  `admin.ipc.ts 提及这两张表 ${(/wa_simplification_reports/.test(adminSrc) ? 1 : 0) + (/wa_self_healing_logs/.test(adminSrc) ? 1 : 0)} 处`);

const bootAt = bootSrc.indexOf('export function startPeriodicInvariantCheck');
const bootEnd = bootSrc.indexOf('\nexport ', bootAt + 1);
const bootBody = bootAt >= 0 ? bootSrc.slice(bootAt, bootEnd > bootAt ? bootEnd : undefined) : '';
ok(bootBody.length > 0, 'F-6 小时节拍函数切片非空（同上，锚点在去注释面成立）', `${bootBody.length} 字节`);
ok(/runAllInvariants\(/.test(bootBody) && /runSimplificationAudit\(/.test(bootBody),
  'F-7 每小时那一拍**顺带**跑简化审查（复用同一节拍 ⇒ 报表滚动更新，不再只跑启动那一次）');
const intervals = [...bootSrc.matchAll(/setInterval\(/g)].length;
ok(intervals === 1, 'F-8 **不新造第二套调度器**：system-bootstrap.ts 里 setInterval 恰 1 处',
  `实测 ${intervals} 处`);
ok((indexSrc.match(/import\('\.\/core\/simplification-audit\.js'\)/g) || []).length === 1,
  'F-9 启动一次那处**保留**（首次报告不必等一小时；本批未动 index.ts 的调用点）',
  `实测 ${(indexSrc.match(/import\('\.\/core\/simplification-audit\.js'\)/g) || []).length} 处`);

// F-10 渲染层：用户可见中文串在场（renderer 是词表的第二个落点）
for (const s of ['架构简化审查', '暂无审查报告', '最近自愈记录', '暂无自愈记录', '报告解析失败', '报告时间(UTC)', '时间为 UTC']) {
  ok(dashSrc.includes(s), `F-10 渲染层含中文串「${s}」`);
}
ok(/SEVERITY_LABEL/.test(dashSrc) && /high:\s*'高'/.test(dashSrc) && /medium:\s*'中'/.test(dashSrc) && /low:\s*'低'/.test(dashSrc),
  'F-11 内部取值 low/medium/high 有中文口径映射（三档逐档核，不把内部取值直接摆给用户）');
// 说明：本轮**不跑** renderer 构建（并发纪律），产物级核验由集中验证统一做。

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【S】build 钉（派生核对，不写轮次字面量）');
checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260924_1_b6: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
