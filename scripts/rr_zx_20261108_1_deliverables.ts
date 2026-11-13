/**
 * zx_20261108_1 B6 受控复跑 —— 「产出物管理增强」。
 *
 * 病根（方案 §B6）：`deliverable:list` 只在 main 侧筛 projectId/type/status/keyword，任务/时间/主件/排序
 *   全在渲染层**对已加载的那一页**做 ⇒ 分页后"筛选结论"与"全表结论"是两件事，界面只能加免责声明。
 *   「在文件夹中显示」又把渲染层手里的 `file_path` 原样交给 shell；`deliverable:open`（会真启动文件）
 *   此前根本不存在；整批导出无闸（Pro 卖点无人兑现）。
 *
 * ── 判据分组 ────────────────────────────────────────────────────────────────
 *   F 筛选口径同尺：`total` 与 `rows` 同一 WHERE；任务哨兵/时间窗/主件/已退休各一只正反标本。
 *   G 排序与分页：8 个排序字段 + 同值 rowid 兜底（逐页取尽不重不漏，且排序真的改变次序）。
 *   H CSV 导出：表头/取值/BOM/CRLF/引号转义/null 留空（"不知道"不冒充 0）。
 *   I 路径围栏：no_path/url/not_absolute/traversal/out_of_root/missing 六种拒因 + 合法件 + 符号链接越界。
 *   J Pro 软闸：`proUnlocked` 四态 + `proFeatureRefusal` 拒因逐字取 `PRO_FEATURE_LABEL`。
 *   K 静态接线：IPC 三跳真的调生产模块；渲染层确实把筛选/排序交给服务端、并调 `open/exportCsv`。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────────
 *   G-1 调生产导出（`queryDeliverables` / `resolveDeliverableFsPath` / `buildDeliverableCsv` /
 *       `proFeatureRefusal`），不在夹具里重写一份等价实现。
 *   G-2 两侧标本：每条筛选/拒因都给出"该命中"与"不该命中"两类数据。
 *   G-4 不依赖真实墙钟：时间筛选喂**固定** `since/until`，不取 `Date.now()`。
 *   G-6 零轮次字面量：轮次与方案路径由 `path.basename(__filename)` 派生。
 *   ⚠ 断言文案不含 ✗/✓（全量汇总器按失败字形计数）。
 *   ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import {
  queryDeliverables,
  normalizeSort,
  normalizeOrder,
  toSqlUtc,
  DELIVERABLE_SORTS,
  DELIVERABLE_TASK_NONE,
} from '../apps/worker-ant-desktop/src/main/core/deliverable-query.js';
import {
  resolveDeliverableFsPath,
} from '../apps/worker-ant-desktop/src/main/core/deliverable-path.js';
import {
  buildDeliverableCsv,
  csvCell,
  csvFileName,
  CSV_HEADERS,
  writeDeliverableCsv,
} from '../apps/worker-ant-desktop/src/main/core/deliverable-export.js';
import {
  PRO_FEATURES,
  PRO_FEATURE_LABEL,
  proFeatureRefusal,
  proUnlocked,
  resolveProGate,
} from '../apps/worker-ant-desktop/src/main/core/pro-gate.js';
import { DELIVERABLE_TASK_NONE as TASK_NONE_SHARED } from '../apps/worker-ant-desktop/src/main/core/deliverable-types.js';

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
/** 静态判据读原文；仅在判「代码里是否真调」时先去注释（承 feedback_static_sweep_comment_strip）。 */
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');

type AnyDb = Parameters<typeof queryDeliverables>[0];
type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, working_dir TEXT);
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT, quality_score REAL, context_json TEXT);
CREATE TABLE wa_deliverables (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  task_id TEXT,
  name TEXT,
  description TEXT DEFAULT '',
  type TEXT DEFAULT '',
  status TEXT DEFAULT 'draft',
  file_path TEXT,
  registry_id TEXT,
  is_primary INTEGER DEFAULT 0,
  acceptance_verified INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE wa_deliverable_versions (
  id TEXT PRIMARY KEY,
  deliverable_id TEXT,
  version INTEGER,
  size INTEGER,
  created_at TEXT,
  content_snapshot TEXT,
  changed_by TEXT
);
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);
`;

interface Fixture {
  db: AnyDb;
  dir: string;
}

/** 生产初始化顺序：先建表/设置行，再插数据行（本套件不建 FTS 触发器，故顺序只需保证表在场）。 */
function mkFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-b6-'));
  const big = path.join(dir, 'big.txt');
  const mid = path.join(dir, 'mid.txt');
  const small = path.join(dir, 'small.txt');
  fs.writeFileSync(big, 'x'.repeat(200));
  fs.writeFileSync(mid, 'y'.repeat(30));
  fs.writeFileSync(small, 'z'.repeat(10));

  const db = new DatabaseSync(':memory:') as unknown as AnyDb;
  db.exec(SCHEMA);
  const insP = db.prepare('INSERT INTO wa_projects (id,name,working_dir) VALUES (?,?,?)');
  insP.run('p1', 'Alpha', dir);
  insP.run('p2', 'Beta', null);
  const insT = db.prepare('INSERT INTO wa_tasks (id,title,status,quality_score,context_json) VALUES (?,?,?,?,?)');
  insT.run('t1', 'Task One', 'completed', 88, '{}');
  insT.run('t2', 'Task Two', 'running', 60, '{}');
  const insD = db.prepare(`INSERT INTO wa_deliverables
    (id,project_id,task_id,name,description,type,status,file_path,is_primary,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  // 同秒两行（d1/d2）——用于证明"稳定排序靠 rowid 兜底"，翻页不重不漏。
  insD.run('d1', 'p1', 't1', 'a.md', 'alpha note', 'doc', 'draft', null, 0, '2026-11-01 10:00:00', null);
  insD.run('d2', 'p1', 't1', 'b.py', 'beta code', 'code', 'running', null, 1, '2026-11-01 10:00:00', '2026-11-04 00:00:00');
  insD.run('d3', 'p1', null, 'project-note.md', 'project level', 'doc', 'registered', null, 0, '2026-11-02 09:00:00', null);
  insD.run('d4', 'p2', 't2', 'retired.md', 'soft retired', 'doc', 'retired', null, 0, '2026-10-01 00:00:00', null);
  insD.run('d5', 'p2', 't2', 'service.py', 'mcp entry', 'mcp', 'running', mid, 0, '2026-10-15 12:30:00', null);
  insD.run('d6', 'p1', 't1', 'big.log', 'big file', 'code', 'failed', big, 0, '2026-11-05 23:59:59', null);
  insD.run('d7', 'p1', null, 'small.md', 'small file', 'doc', 'draft', small, 0, '2026-11-08 00:00:00', null);
  // 探针：doc 型且路径含 `/_probe/` ⇒ 被取数范围**始终**排除；用于反证 scope 仍在。
  insD.run('d8', 'p2', 't2', 'tmp doc', 'probe artefact', 'doc', 'draft', '/data/_probe/report.md', 0, '2026-11-06 00:00:00', null);
  return { db, dir };
}

function ids(rows: Row[]): string[] { return rows.map((r) => String(r.id)); }

function main(): void {
  const { db, dir } = mkFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-b6-out-'));
  try {
    // ═══ F 筛选口径同尺 ═══════════════════════════════════════════════════════
    console.log('\n【F】筛选：total 与 rows 同一 WHERE');
    {
      const all = queryDeliverables(db, {});
      eq(all.total, all.rows.length, 'F1 无筛选：total == rows.length（同一 WHERE，档案视图含已退休）');
      eq(all.total, 7, 'F2 探针件被取数范围排除（8 行插库只算 7 条）');
      ok(ids(all.rows).includes('d4'), 'F3 未显式选状态时不收已退休? — 缺省档案视图**含**已退休', ids(all.rows).join(','));

      const noRetired = queryDeliverables(db, { showRetired: false });
      eq([noRetired.total, noRetired.retiredCount, ids(noRetired.rows).includes('d4')], [6, 1, false],
        'F4 showRetired=false：明细挡掉 retired，retiredCount 如实报全表 1 项');

      const explicitRetired = queryDeliverables(db, { showRetired: false, status: 'retired' });
      eq([explicitRetired.total, ids(explicitRetired.rows)], [1, ['d4']],
        'F5 显式选 status=retired：已退休件照常列出（状态筛选优先于"默认隐藏"）');

      const docAll = queryDeliverables(db, { type: 'doc' });
      eq(docAll.total, docAll.rows.length, 'F6 type=doc：total 与 rows 同尺');
      eq(ids(docAll.rows).sort(), ['d1', 'd3', 'd4', 'd7'], 'F7 type=doc：命中 4 条（含 retired，不含探针/代码/服务）');

      const kw = queryDeliverables(db, { keyword: 'service' });
      eq([kw.total, ids(kw.rows)], [1, ['d5']], 'F8 keyword 命中文件路径（service.py）');

      const kwMiss = queryDeliverables(db, { keyword: 'probe' });
      eq(kwMiss.total, 0, 'F9 keyword=probe 命中探针件——但它在取数范围外 ⇒ 如实 0 条');

      const noneTask = queryDeliverables(db, { taskId: DELIVERABLE_TASK_NONE });
      eq([noneTask.total, ids(noneTask.rows).sort()], [2, ['d3', 'd7']],
        'F10 项目级哨兵：task_id IS NULL 的 2 条（不是空串占位）');

      const t1 = queryDeliverables(db, { taskId: 't1' });
      eq(ids(t1.rows).sort(), ['d1', 'd2', 'd6'], 'F11 按产出任务 t1：恰 3 条');

      const since = queryDeliverables(db, { since: '2026-11-02' });
      eq(ids(since.rows).sort(), ['d3', 'd6', 'd7'], 'F12 since=2026-11-02（含当日 00:00:00 起）：3 条');

      const until = queryDeliverables(db, { until: '2026-11-02' });
      eq(ids(until.rows).sort(), ['d1', 'd2', 'd3', 'd4', 'd5'], 'F13 until=2026-11-02（含当日 23:59:59 止）：5 条');

      const primary = queryDeliverables(db, { primary: true });
      eq([primary.total, ids(primary.rows)], [1, ['d2']], 'F14 primary=true：只认 is_primary 列本身');

      const combined = queryDeliverables(db, { projectId: 'p1', type: 'doc', showRetired: false });
      eq([combined.total, ids(combined.rows).sort()], [3, ['d1', 'd3', 'd7']],
        'F15 组合筛选：项目+类型+不含已退休 仍同尺');

      // 时间格式非法必须抛（静默忽略会让用户以为筛选生效了）
      let threw = '';
      try { queryDeliverables(db, { since: 'not-a-date' }); } catch (e) { threw = (e as Error).message; }
      ok(/时间格式无效/.test(threw), 'F16 非法时间格式抛 INVALID_PARAM 级错误（不静默忽略）', threw);
    }

    // ═══ G 排序与分页 ═════════════════════════════════════════════════════════
    console.log('\n【G】排序与分页：同值 rowid 兜底，逐页取尽不重不漏');
    {
      eq(DELIVERABLE_SORTS.length, 9, 'G1 排序词表 9 项（含 version_count；界面 8 列是它的子集）');
      eq(normalizeSort('created'), 'created_at', 'G2 旧界面短名 created 归一为 created_at（别名在册）');
      eq(normalizeSort('updated'), 'updated_at', 'G3 旧界面短名 updated 归一为 updated_at');
      let msg = '';
      try { normalizeSort('bogus'); } catch (e) { msg = (e as Error).message; }
      ok(/不支持的排序/.test(msg), 'G4 未知排序抛错（不静默回退默认排序）', msg);
      eq([normalizeOrder(undefined), normalizeOrder('ASC'), normalizeOrder('desc')], ['desc', 'asc', 'desc'],
        'G5 方向缺省 desc；大小写归一');
      let ordMsg = '';
      try { normalizeOrder('sideways'); } catch (e) { ordMsg = (e as Error).message; }
      ok(/不支持的排序方向/.test(ordMsg), 'G6 未知方向抛错', ordMsg);

      const asc = queryDeliverables(db, { sort: 'name', order: 'asc' });
      eq(ids(asc.rows), ['d1', 'd2', 'd6', 'd3', 'd4', 'd5', 'd7'],
        'G7 name 升序：a.md/b.py/big.log/project-note.md/retired.md/service.py/small.md');

      const createdAsc = queryDeliverables(db, { sort: 'created', order: 'asc', limit: 1, offset: 0 });
      const createdAsc2 = queryDeliverables(db, { sort: 'created', order: 'asc', limit: 1, offset: 1 });
      eq([ids(createdAsc.rows).length, ids(createdAsc2.rows).length], [1, 1],
        'G8 同秒两行按 limit=1 翻页仍各取一条');
      ok(createdAsc.rows[0].id !== createdAsc2.rows[0].id,
        'G9 同值 tie 由 rowid 兜底 ⇒ 两页不重复', `${createdAsc.rows[0].id} vs ${createdAsc2.rows[0].id}`);

      const seen = new Set<string>();
      let offset = 0;
      for (;;) {
        const page = queryDeliverables(db, { sort: 'created_at', order: 'desc', limit: 1, offset });
        if (page.rows.length === 0) break;
        seen.add(String(page.rows[0].id));
        offset += 1;
      }
      eq([seen.size, offset], [7, 7], 'G10 逐页取尽：7 条各出现一次（无重复、无遗漏）');

      for (const f of ['updated_at', 'type', 'status', 'quality', 'project', 'version_count'] as const) {
        const r = queryDeliverables(db, { sort: f, order: 'asc' });
        eq(r.total, 7, `G11 排序字段 ${f} 可执行（total 不随排序变化）`);
      }

      const sizeDesc = queryDeliverables(db, { sort: 'size', order: 'desc' });
      eq(ids(sizeDesc.rows).slice(0, 3), ['d6', 'd5', 'd7'], 'G12 size 降序：big(200) > mid(30) > small(10) 在前');
      eq(sizeDesc.rows.slice(3).map((r) => r.size_bytes), [null, null, null, null],
        'G13 无路径的四条记 null（"不知道"不是 0），降序垫底');
      const sizeAsc = queryDeliverables(db, { sort: 'size', order: 'asc' });
      eq(sizeAsc.rows[0].size_bytes, null, 'G14 size 升序：未知大小排最前（-1 语义，不冒充 0 字节）');
      eq(ids(sizeAsc.rows).slice(-3), ['d7', 'd5', 'd6'], 'G15 size 升序：三条真文件按 10<30<200 排列');

      const page2 = queryDeliverables(db, { limit: 2, offset: 2 });
      eq([page2.total, page2.rows.length, page2.limit, page2.offset], [7, 2, 2, 2],
        'G16 分页返回体：total 全量、rows 当页、limit/offset 回显');
      const beyond = queryDeliverables(db, { limit: 5, offset: 100 });
      eq([beyond.total, beyond.rows.length], [7, 0], 'G17 offset 越界：rows 空、total 仍如实');
    }

    // ═══ H CSV ════════════════════════════════════════════════════════════════
    console.log('\n【H】CSV：表头/取值/BOM/CRLF/转义/null');
    {
      eq(CSV_HEADERS, ['项目', '任务', '名称', '类型', '状态', '大小（字节）', '版本数', '创建时间'],
        'H1 表头逐字在册（列名只此一处）');

      const rows = queryDeliverables(db, { sort: 'name', order: 'asc' }).rows;
      const csv = buildDeliverableCsv(rows);
      eq(csv.charCodeAt(0), 0xfeff, 'H2 首字符是 UTF-8 BOM（Excel 打开中文表头不花码）');
      const body = csv.slice(1);
      ok(body.startsWith(CSV_HEADERS.join(',') + '\r\n'), 'H3 首行是表头且以 CRLF 结尾');
      ok(body.endsWith('\r\n'), 'H4 结尾 CRLF（不依赖 EOF 换行）');
      eq(body.split('\r\n').length - 2, rows.length, 'H5 数据行数 == rows.length');
      ok(body.includes('Alpha,Task One,a.md,doc,draft,,'), 'H6 无路径 → 大小留空（不写 0），版本数 0→空');
      ok(body.includes(',200,'), 'H7 盘上真实字节进入"大小（字节）"列');

      eq(csvCell('plain'), 'plain', 'H8 普通值不加引号');
      eq(csvCell('a,b'), '"a,b"', 'H9 逗号触发引号');
      eq(csvCell('say "hi"'), '"say ""hi"""', 'H10 引号双写转义');
      eq(csvCell('line1\nline2'), '"line1\nline2"', 'H11 换行触发引号');
      eq(csvCell(null), '', 'H12 null → 空串（不印字符串 null）');

      const target = path.join(dir, 'out', 'deliverables.csv');
      const written = writeDeliverableCsv(rows, target);
      ok(written.ok === true, 'H13 写入用户选定路径成功', written.ok ? `${written.count} 条` : written.error);
      ok(fs.existsSync(target) && fs.readFileSync(target, 'utf-8').charCodeAt(0) === 0xfeff,
        'H14 落盘内容同样带 BOM');
      const bad = writeDeliverableCsv(rows, path.join(dir, 'out', 'deliverables.csv', 'no-way', 'x.csv'));
      ok(bad.ok === false && typeof bad.error === 'string', 'H15 写盘失败如实回字符串（不抛、不假成功）');

      ok(/^deliverables-\d{8}-\d{6}\.csv$/.test(csvFileName(new Date(2026, 10, 8, 9, 5, 7))),
        'H16 缺省文件名：deliverables-YYYYMMDD-HHMMSS.csv', csvFileName(new Date(2026, 10, 8, 9, 5, 7)));
    }

    // ═══ I 路径围栏 ═══════════════════════════════════════════════════════════
    console.log('\n【I】打开围栏：六种拒因 + 合法件 + 符号链接越界');
    {
      const inFile = path.join(dir, 'inside.txt');
      fs.writeFileSync(inFile, 'ok');
      const outFile = path.join(outside, 'outside.txt');
      fs.writeFileSync(outFile, 'outside');
      const linkPath = path.join(dir, 'link.txt');
      fs.symlinkSync(outFile, linkPath);

      const cases: Array<[unknown, Array<string | null | undefined>, string, string]> = [
        ['', [dir], 'I1 空路径 → no_path', 'no_path'],
        [null, [dir], 'I2 null → no_path', 'no_path'],
        ['https://example.com/a.txt', [dir], 'I3 URL 方案 → url（是链接地址不是盘上文件）', 'url'],
        ['relative/a.txt', [dir], 'I4 相对路径 → not_absolute（拒绝按 cwd 解析）', 'not_absolute'],
        ['/tmp/../etc/passwd', [dir], 'I5 含 .. → traversal', 'traversal'],
        [inFile, [], 'I6 无授权根 → out_of_root（无法判定归属）', 'out_of_root'],
        [outFile, [dir], 'I7 根外文件 → out_of_root', 'out_of_root'],
        [path.join(dir, 'nope.txt'), [dir], 'I8 根内但不存在 → missing', 'missing'],
        [dir, [dir], 'I9 路径是目录而非文件 → missing（"不是文件"）', 'missing'],
        [linkPath, [dir], 'I10 根内符号链接指向根外 → out_of_root（先 realpath 再判根）', 'out_of_root'],
      ];
      for (const [input, roots, label, reason] of cases) {
        const r = resolveDeliverableFsPath(input, roots);
        eq(r.ok ? 'ok' : r.reason, reason, label);
      }

      const good = resolveDeliverableFsPath(inFile, [dir, null, undefined]);
      ok(good.ok === true && good.path === fs.realpathSync(inFile),
        'I11 根内真文件放行，回传 realpath（不是字面路径）', good.ok ? good.path : good.error);
      const workdirRoot = resolveDeliverableFsPath(inFile, [dir]);
      ok(workdirRoot.ok === true, 'I12 项目工作目录作为根同样放行（调用方传入两者）');
      const wrongRoot = resolveDeliverableFsPath(inFile, [outside]);
      eq(wrongRoot.ok ? 'ok' : wrongRoot.reason, 'out_of_root', 'I13 换根后同一文件被拒（根校验真的在起作用）');
    }

    // ═══ J Pro 软闸 ═══════════════════════════════════════════════════════════
    console.log('\n【J】Pro 软闸：交付物批量导出');
    {
      ok(PRO_FEATURES.includes('deliverable_export' as never), 'J1 deliverable_export 在能力词表（一处登记）');
      ok(PRO_FEATURE_LABEL.deliverable_export.includes('CSV'), 'J2 人话能力名含 CSV（拒因直接上屏）',
        PRO_FEATURE_LABEL.deliverable_export);

      eq([
        proUnlocked({ tier: 'pro', kind: 'licensed' }),
        proUnlocked({ tier: 'team', kind: 'licensed' }),
        proUnlocked({ tier: 'community', kind: 'trial' }),
        proUnlocked({ tier: 'community', kind: 'none' }),
      ], [true, true, true, false], 'J3 解锁四态：pro/team/试用 放行；社区锁定');

      const gate = resolveProGate(db);
      eq([gate.unlocked, gate.tier], [false, 'community'], 'J4 空设置库 ⇒ 社区档 ⇒ 锁（fail-open 方向是"锁"，不是崩）');
      const refusal = proFeatureRefusal(db, 'deliverable_export');
      ok(refusal !== null && refusal.includes(PRO_FEATURE_LABEL.deliverable_export),
        'J5 拒因逐字取 PRO_FEATURE_LABEL（不写"操作失败"四字了事）', refusal ?? 'null');
      const other = proFeatureRefusal(db, 'knowledge_export');
      ok(other !== null && !other.includes(PRO_FEATURE_LABEL.deliverable_export),
        'J6 拒因按能力区分（不是一句通稿）', other ?? 'null');
    }

    // ═══ K 静态接线 ═══════════════════════════════════════════════════════════
    console.log('\n【K】接线：main 三跳 / 渲染层零客户端筛选');
    {
      const ipcRaw = RD('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
      const ipc = stripKeepingLines(ipcRaw).join('\n');
      ok(ipc.includes("ipcMain.handle('deliverable:list'") && ipc.includes('queryDeliverables(db, input'),
        'K1 deliverable:list 委托 core/deliverable-query（不再在 handler 里手拼 WHERE）');
      ok(ipc.includes("ipcMain.handle('deliverable:open'") && ipc.includes('resolveDeliverableFsPath(row.file_path'),
        'K2 deliverable:open 按 id 取库内路径后过围栏（不信任渲染层路径）');
      ok(ipc.includes('shell.showItemInFolder(') && ipc.includes('shell.openPath('),
        'K3 reveal 走 showItemInFolder、open 走 openPath（两种打开方式都在）');
      ok(ipc.includes("ipcMain.handle('deliverable:exportCsv'") && ipc.includes("proFeatureRefusal(db, 'deliverable_export')"),
        'K4 exportCsv 先过 Pro 闸再取数/落盘');
      ok(ipc.includes('queryDeliverables(db, input ?? {}, { all: true })'),
        'K5 导出取数 = 列表同一次装配（all:true 忽略分页，筛选/排序仍生效）');
      ok(ipc.includes('writeDeliverableCsv(result.rows, picked.filePath)') && ipc.includes('dialog.showSaveDialog'),
        'K6 落点由系统保存对话框选（渲染层不递任意写路径）');
      ok(!/function\s+statSizeBytes\s*\(/.test(ipc), 'K7 statSizeBytes 已上提 core（IPC 内无第二份实现）');

      const gateRaw = RD('apps/worker-ant-desktop/src/main/core/pro-gate.ts');
      ok(gateRaw.includes("'plugin_install', 'deliverable_export'") &&
        gateRaw.includes('deliverable_export:'), 'K8 pro-gate 词表 + 人话名两处均已登记');

      const rendererIpcRaw = RD('apps/worker-ant-desktop/renderer/src/lib/ipc.ts');
      // 反证必须只看 `deliverables` 块——`packs.list` 也长成 `list: (projectId?: string)`
      //   这份文件里合法存在；整文件扫会把它误判成本轮残留。
      const delivBlock = rendererIpcRaw.slice(
        rendererIpcRaw.indexOf('export const deliverables = {'),
        rendererIpcRaw.indexOf('\n};', rendererIpcRaw.indexOf('export const deliverables = {')),
      );
      ok(rendererIpcRaw.includes('list: (params: DeliverableListParams = {})'),
        'K9 渲染层 list 改为参数对象，形状取 main 真源（不再手抄位置参数）');
      ok(!delivBlock.includes('list: (projectId'),
        'K10 反证：deliverables 块内旧位置参数签名已不存在');
      ok(rendererIpcRaw.includes("open: (id: string, mode: 'open' | 'reveal' = 'open')") &&
        rendererIpcRaw.includes('exportCsv: (params: DeliverableListParams = {})'),
        'K11 open/exportCsv 两个端口在渲染层在册');

      const page = stripKeepingLines(RD('apps/worker-ant-desktop/renderer/src/pages/DeliverablesPage.tsx')).join('\n');
      ok(page.includes('const buildParams = useCallback') && page.includes('sort: sortBy') && page.includes('showRetired,'),
        'K12 当前筛选/排序由 buildParams 一处装配，三处（首屏/更多/导出）共引');
      ok(!page.includes('const sortVal =') && !page.includes('const sorted = [...items]'),
        'K13 反证：渲染层的第二份 filter/sort 已删除（筛选唯一在服务端）');
      ok(page.includes('deliverables.list(buildParams('), 'K14 首屏/加载更多都走同一 buildParams');
      ok(page.includes('deliverables.open(') && page.includes('deliverables.exportCsv('),
        'K15 行内打开/在文件夹中显示与导出都调新端口');
      ok(page.includes("license.proFeature('deliverable_export')") && page.includes('exportGate?.unlocked === false'),
        'K16 导出钮先按档位裁定禁用（拒因取 main 的 detail）');
      ok(page.includes('anyFilterActive ?') && page.includes('当前筛选条件下没有结果'),
        'K17 空态区分「库里没有」与「筛不出来」（服务端 total 同尺）');
      ok(!page.includes('筛选仅覆盖已加载的行'),
        'K18 反证：旧免责声明已删除（筛选下沉后它不再真实）');
    }

    // ═══ S 哑雷自检 + build 钉 ═════════════════════════════════════════════════
    console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
    {
      const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
      const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
      ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（不写"只为下一轮"的哑雷）',
        selfPins.map((m) => m[1]).join(',') || '0 处');
      // 脚本名带分组后缀（…_deliverables）⇒ 方案文件名取轮次前缀，仍由载体派生后做在场判定。
      const planRound = /^zx_\d{8}(?:_\d+)?/.exec(SELF_ROUND)?.[0] ?? SELF_ROUND;
      ok(fs.existsSync(path.join(root, `plans/improve/${planRound}.md`)),
        'S2 方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${planRound}.md`);
      ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
        'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);
      eq(TASK_NONE_SHARED, DELIVERABLE_TASK_NONE,
        'S4 哨兵字面量只在零依赖模块一处（query 转出与 types 定义同一个值）');

      checkBuildPins(ok, { distDir: path.join(root, 'apps/worker-ant-desktop/dist') });
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ }
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
}

// ⚠ `catch` 不可省：夹具/断言抛异常时若只挂 `finally`，进程会在 unhandled rejection 之前被带走 ⇒ 假绿。
try {
  main();
} catch (e: unknown) {
  console.error(`\n💥 rr_zx_20261108_1_deliverables 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
} finally {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261108_1_deliverables: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}
