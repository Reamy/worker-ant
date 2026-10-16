/**
 * zx_20260909_1 M3 受控复跑：域C per-doc 验收位(C1 打标/读位/开关) + 探针尾巴统一(C2 digest/primary/primary_auto)。
 *
 * 补①(§十三): 打标/回填/探针谓词**真调生产函数**(core/deliverable-lifecycle.ts 的 markDocAcceptanceVerified /
 *  backfillDocAcceptanceVerified / docNotProbe 直接 import 对 node:sqlite 内存库执行)，不再内存库复刻。
 *  digest 装配为 project.ipc 内联逻辑(巨型 handler 不可 import)→ 保留复刻 + 源码静态断言
 *  (建列/迁移回填/三读点 per-doc/promote 内打标/primary_auto 探针滤除/Settings 开关)。绝不触碰开发库。
 *
 * zx_20260914 M2-3③ 订正: 三读点验收装饰**已收敛为 `annotateAcceptance` 单一实现**(不再散在 project.ipc)
 *  ⇒ 本节由"复刻公式"改为**真调生产函数**；静态断言随之改指新居所(判据不变:per-doc 读位/门控/回落)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { docNotProbe, markDocAcceptanceVerified, backfillDocAcceptanceVerified, isAcceptanceType, annotateAcceptance } from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (p?: string) => any };

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
const dbt = rd('apps/worker-ant-desktop/src/main/database.ts');
const dlc = rd('apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.ts');
const pip = rd('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
const idx = rd('apps/worker-ant-desktop/src/main/index.ts');
const setp = rd('apps/worker-ant-desktop/renderer/src/pages/SettingsPage.tsx');

function mkdb(): any {
  const db = new DatabaseSync(':memory:') as any;
  db.exec(`CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, context_json TEXT, status TEXT);
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, task_id TEXT, type TEXT, name TEXT, file_path TEXT, status TEXT,
  acceptance_verified INTEGER DEFAULT 0, is_primary INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);`);
  return db;
}
// 探针判定的"规格期望"(仅用于构造反例): 生产真值以 docNotProbe 为准, 此处断言两者一致
// zx_20260916_3 M2（D3 裁定）: 期望里的 `test_<6 位十六进制>.py` 一条**随生产一起删除**——
//   生产删它是为了不再误伤真测试脚本（a-stock 7 例，§1.2-②），期望若留着就变成"一把过期的尺"。
//   此处的**反证**（旧形状 GLOB 确会误判）由新脚本 `scripts/rr_zx_20260916_3.ts` §B-3 正面钉住。
function isProbe(pathName: string): boolean {
  const p = pathName || '';
  return /\/_verify|\/_probe|\/_tmp/.test(p) || /(_verify|_probe|_tmp)$/.test(p.split('/').pop() || '');
}

console.log('C1·打标(补①: 真调生产 markDocAcceptanceVerified / backfillDocAcceptanceVerified)');
{
  const db = mkdb();
  db.prepare("INSERT INTO wa_tasks (id,context_json,status) VALUES ('t1','{\"acceptance_check\":{\"criteria_total\":3,\"passed_total\":3,\"checked_at\":\"2026-09-09\"}}','completed')").run();
  db.prepare("INSERT INTO wa_deliverables (id,task_id,type,name,file_path,status) VALUES ('d1','t1','doc','方案报告.md','/x/方案报告.md','completed')").run();
  db.prepare("INSERT INTO wa_deliverables (id,task_id,type,name,file_path,status) VALUES ('d2','t1','doc','_probe_x','/x/_probe_x.py','completed')").run();
  db.prepare("INSERT INTO wa_deliverables (id,task_id,type,name,file_path,status) VALUES ('d3','t1','script','check','/x/test_abc123.py','completed')").run();
  db.prepare("INSERT INTO wa_deliverables (id,task_id,type,name,file_path,status) VALUES ('d9','t1','doc','已撤回.md','/x/已撤回.md','retired')").run();
  const g = (id: string) => db.prepare('SELECT acceptance_verified FROM wa_deliverables WHERE id=?').get(id).acceptance_verified;
  ok(g('d1') === 0 && g('d2') === 0, '前置: 打标前全 0');
  markDocAcceptanceVerified(db, 't1');   // ← 生产函数, 非复刻
  ok(g('d1') === 1 && g('d2') === 0 && g('d3') === 0 && g('d9') === 0,
    'markDocAcceptanceVerified 只标真实 doc(探针 _probe/临时脚本/retired 均 0)');
  // "验收后才补 doc 不显 ✓" 由**流程**保证(finalize 每任务一次 + backfill 迁移标记守护), 非 SQL 单点守卫
  db.prepare("INSERT INTO wa_deliverables (id,task_id,type,name,file_path,status) VALUES ('d4','t1','doc','补录说明.md','/x/补录说明.md','draft')").run();
  ok(g('d4') === 0, '验收后才补 doc 位 0(真实流: 置 completed 后不再 finalize → 保持 0, 不显 ✓)');
  // 复核生产 SQL 语义: 再跑打标会补标"尚未打标"的 doc —— 故 backfill 必须迁移标记守护一次性、不可反复跑
  markDocAcceptanceVerified(db, 't1');
  ok(g('d4') === 1, '复核: 再跑打标会补标未标 doc(→ backfill 一次性迁移标记 / finalize 每任务一次 为必要前提)');
  // 无 acceptance_check.checked_at 的任务 → 一律不打标(守"真验收过才标")
  db.prepare("INSERT INTO wa_tasks (id,context_json,status) VALUES ('t2','{}','completed')").run();
  db.prepare("INSERT INTO wa_deliverables (id,task_id,type,name,file_path,status) VALUES ('e1','t2','doc','未验收.md','/x/未验收.md','completed')").run();
  markDocAcceptanceVerified(db, 't2');
  ok(g('e1') === 0, 'ctx 无 acceptance_check.checked_at → 不打标(打标仅"验收通过+完成"态)');
  // 一次性回填: 迁移标记守护 + 只对 checked_at 的已完成任务
  backfillDocAcceptanceVerified(db);
  ok(g('e1') === 0 && db.prepare("SELECT 1 FROM wa_settings WHERE key='migration.doc_acceptance_backfill'").get() !== undefined,
    'backfillDocAcceptanceVerified 跳无 checked_at 任务 + 落迁移标记');
}

console.log('C2·探针谓词与 digest 尾巴(补①: docNotProbe 真值; digest 装配为 project.ipc 内联→复刻+静态断言)');
{
  // docNotProbe 真值 vs 规格期望: 两侧必须同判(否则复刻/生产漂移)
  const cases: Array<[string, boolean]> = [
    ['/x/方案报告.md', false], ['/x/_probe_x.py', true], ['/x/_tmp_y.py', true],
    ['/x/_verify_z.py', true],
    // zx_20260916_3 M2: 此条由 true 翻为 false——`test_abc123.py` 无任何探针宣告，只"长得像随机命名"，
    //   旧 GLOB 判探针（= a-stock 7 例误伤的同一条规则），现判真实产出。`test_short.py`（6 字符非十六进制）
    //   从来就判非探针，两条**并排**在此，正是"旧判据按长相、与内容无关"的自证。
    ['/x/test_abc123.py', false], ['/x/test_short.py', false],
    ['/_probe_x', true], ['_probe_x', false], ['报告.md', false],
  ];
  const drift = cases.filter(([p, want]) => isProbe(p) !== want);
  ok(drift.length === 0, 'docNotProbe 真值 = 规格期望(路径/纯名两口径一致)', drift.map(([p]) => p).join(','));
  // 生产谓词对真实表可判: 用 docNotProbe('d') 装配 dRows(与 digest 同 SQL 片段)
  const db = mkdb();
  db.prepare("INSERT INTO wa_tasks (id,context_json,status) VALUES ('t1','{\"acceptance_check\":{\"checked_at\":\"2026-09-09\"}}','completed')").run();
  const docs: Array<[string, string, string, number, number]> = [
    ['a','方案报告.md','/x/方案报告.md',1,1],
    ['b','探针脚本','/x/_probe_x.py',1,0],
    ['c','临时','/x/_tmp_y.py',1,0],
    ['d','补录.md','/x/补录.md',0,0],
  ];
  for (const [id, name, fp, av, pri] of docs) db.prepare('INSERT INTO wa_deliverables (id,task_id,type,name,file_path,status,acceptance_verified,is_primary) VALUES (?,?,?,?,?,?,?,?)').run(id,'t1','doc',name,fp,'completed',av,pri);
  const dRows = db.prepare(`SELECT d.* FROM wa_deliverables d WHERE d.task_id='t1' AND d.status != 'retired' AND (d.type != 'doc' OR ${docNotProbe('d')})`).all() as any[];
  // zx_20260913 M2-6: 类型判据不再本处复刻 'doc'——直调共享 isAcceptanceType，防止「第二份词表」漂移。
  const verified = dRows.filter(r => isAcceptanceType(r.type) && r.acceptance_verified === 1).map(r => r.id);
  const primary = dRows.filter(r => r.is_primary === 1).map(r => r.id);
  ok(dRows.length === 2, 'docNotProbe(\'d\') 装配 dRows 滤除探针行(4→2)', String(dRows.length));
  ok(verified.length === 1 && verified[0] === 'a', 'verified 仅含真实已验证 doc(探针 _probe/_tmp 排除)', verified.join(','));
  ok(primary.length === 1 && primary[0] === 'a', 'primary 主要成果不含探针(dRows 层滤除)', primary.join(','));
  ok(!primary.includes('b') && !primary.includes('c'), 'is_primary=1 的探针 doc 不进主要成果段');
}

console.log('C1/C2·读位与开关回归(真调 annotateAcceptance; 三读点共用此一处)');
{
  // zx_20260914 M2-3③: 三读点装饰**已收敛为 `annotateAcceptance` 唯一实现** ⇒ 本处不再复刻公式，
  //   改真调生产函数(node:sqlite 内存库)。复刻一份公式只会与生产各说各话(夹具抄一份 = 自我印证)。
  // 夹具三行覆盖三种分叉: a=doc 位1(已标) / b=doc 位0(验收后补录) / c=ui 位1(类型不在册)
  const mk = (perDoc: string, showAcc: string): { got: string; rows: Array<Record<string, unknown>> } => {
    const db = mkdb();
    db.prepare("INSERT INTO wa_settings (key,value) VALUES ('deliverable.per_doc_acceptance',?)").run(perDoc);
    db.prepare("INSERT INTO wa_settings (key,value) VALUES ('deliverable.show_acceptance',?)").run(showAcc);
    db.prepare("INSERT INTO wa_tasks (id,context_json,status) VALUES ('t1','{\"acceptance_check\":{\"criteria_total\":3,\"passed_total\":3,\"checked_at\":\"2026-09-09\"}}','completed')").run();
    db.prepare("INSERT INTO wa_deliverables (id,task_id,type,name,file_path,status,acceptance_verified) VALUES ('a','t1','doc','报告.md','/x/报告.md','completed',1)").run();
    db.prepare("INSERT INTO wa_deliverables (id,task_id,type,name,file_path,status,acceptance_verified) VALUES ('b','t1','doc','补录.md','/x/补录.md','completed',0)").run();
    db.prepare("INSERT INTO wa_deliverables (id,task_id,type,name,file_path,status,acceptance_verified) VALUES ('c','t1','ui','界面','/x/ui.html','completed',1)").run();
    const rows = db.prepare('SELECT * FROM wa_deliverables ORDER BY id').all() as Array<Record<string, unknown>>;
    annotateAcceptance(db, rows);
    return { got: rows.map(r => `${r.id}=${r.acceptance ? '✓' : '-'}`).join(','), rows };
  };
  const t = mk('true', 'true');
  ok(t.got === 'a=✓,b=-,c=-',
    'per_doc=true: 仅「类型在册 且 本行已打标」带 ✓(位0 与 非验收类型 皆不带——任务级扇出消失)', t.got);
  ok(JSON.stringify(t.rows[0]!.acceptance) === JSON.stringify({ criteria_total: 3, passed_total: 3, checked_at: '2026-09-09' }),
    '带 ✓ 的行附完整验收载荷(criteria/passed/checked_at)——不是只一个布尔', JSON.stringify(t.rows[0]!.acceptance));
  const off = mk('true', 'false');
  ok(off.got === 'a=-,b=-,c=-', 'show_acceptance=false: 一律不带验收(总门控沿用)', off.got);
  const fan = mk('false', 'true');
  ok(fan.got === 'a=✓,b=✓,c=✓', 'per_doc=false: 回落任务 ctx 扇出(位0 也带、类型不限——旧行为)', fan.got);
  // 反证: 任务 ctx 未核验(无 checked_at) ⇒ 即便 per_doc=false 也不下发(扇出亦须"真验收过")
  const dbNoCtx = mkdb();
  dbNoCtx.prepare("INSERT INTO wa_settings (key,value) VALUES ('deliverable.per_doc_acceptance','false')").run();
  dbNoCtx.prepare("INSERT INTO wa_settings (key,value) VALUES ('deliverable.show_acceptance','true')").run();
  dbNoCtx.prepare("INSERT INTO wa_tasks (id,context_json,status) VALUES ('t1','{}','completed')").run();
  dbNoCtx.prepare("INSERT INTO wa_deliverables (id,task_id,type,name,file_path,status,acceptance_verified) VALUES ('a','t1','doc','报告.md','/x/报告.md','completed',1)").run();
  const noCtxRows = dbNoCtx.prepare('SELECT * FROM wa_deliverables').all() as Array<Record<string, unknown>>;
  annotateAcceptance(dbNoCtx, noCtxRows);
  ok(noCtxRows[0]!.acceptance === undefined, '反证: 任务 ctx 无已核验 acceptance_check ⇒ 位1 也不带 ✓(扇出亦须真验收过)');
}

console.log('C1/C2·静态接线(建列/回填/打标/读位/开关/primary_auto/Settings)');
{
  ok(dbt.includes('ALTER TABLE wa_deliverables ADD COLUMN acceptance_verified INTEGER DEFAULT 0'), 'database.ts 幂等迁移加 acceptance_verified 列');
  ok(dbt.includes("ensureSetting('deliverable.per_doc_acceptance', 'true')"), 'config ensureSetting 注册 deliverable.per_doc_acceptance');
  ok(dlc.includes('docNotProbe') && dlc.includes('markDocAcceptanceVerified') && dlc.includes('backfillDocAcceptanceVerified'), 'deliverable-lifecycle 提供 共享探针谓词 + 打标 + 一次性回填');
  ok(dlc.includes('markDocAcceptanceVerified(db, taskId)') && dlc.includes('promoteTaskFileDeliverables'), 'promote(收口置 completed) 内打标 markDocAcceptanceVerified');
  ok(idx.includes('backfillDocAcceptanceVerified(db)') && idx.includes("import('./core/deliverable-lifecycle.js')"), 'index 启动一次性回填(存量已验收任务真实 doc 回填 1, 迁移标记守护)');
  // zx_20260930 M4-1 改钉更强的真源：dRows 的探针滤除已并入共享取数范围 ⇒ 钉"它声明了本项目范围"
  //   （`projectId: id, alias: 'd'` 这一跳），比原先钉一句 `docNotProbe('d')` 更贴近"同尺"的本意。
  ok(pip.includes("COALESCE(d.acceptance_verified, 0) AS acceptance_verified") && pip.includes("deliverableScopeSql({ projectId: id, alias: 'd' })"), 'digest dRows 读 per-doc 位 + 经共享取数范围(与列表口径一致)');
  ok(pip.includes("perDocD ? Number(r.acceptance_verified) === 1") && pip.includes("const verifiedDocs = accOnD"), 'digest verified 段 per-doc 读位 + show_acceptance 门控');
  // zx_20260913 M2-6: 验收类型判据由手抄 `String(r.type) === 'doc'` 收敛为共享 isAcceptanceType(doc/code)。
  // zx_20260914 M2-3③: 装饰逻辑整体收敛到 `annotateAcceptance`(唯一实现)——断言改指其真身;
  //   判据(per_doc=true 仅「类型在册 且 本行已打标」才带验收)不变，落地处由 project.ipc 内联改为 core 一处。
  ok(dlc.includes('isAcceptanceType(r.type) && Number(r.acceptance_verified) === 1') && dlc.includes('const perDoc = boolSetting(pdCfg?.value)'),
    'per-doc 验收判据(类型在册 + 本行已打标)真身在 core.annotateAcceptance');
  // 扫描面**如实命名**: 本断言只扫 `apps/worker-ant-desktop/src/main/ipc/project.ipc.ts`
  ok(pip.split('annotateAcceptance(db, ').length - 1 === 3,
    'project.ipc 三读点(list/preview/task:get)俱经共享 annotateAcceptance(source 内该调用恰 3 处)');
  ok(pip.includes('annotateAcceptance(db, data)') && pip.includes('annotateAcceptance(db, accRows)') && pip.includes('annotateAcceptance(db, deliverables as Array<Record<string, unknown>>)'),
    'deliverable:list / deliverable:preview / task:get 三处俱真调(非注释)');
  ok(pip.includes("const perDocD = boolSetting(pdCfgD?.value)"), 'per_doc_acceptance 开关另一消费点=digest(取数口径, 走 verifiedAcceptanceMap)');
  // zx_20260911_2 M4-G2: 候选查询随 autoAssignPrimary 抽取移至 deliverable-lifecycle——断言改指新居所，判据(探针不选为★)不变
  // zx_20260915 P0-8(b): 候选查询改带别名 `d`（排序要 JOIN 派生列），故锚点由"函数名后 N 字符内含 "" 别名"改为
  //   **按候选查询那一行就地取**——原 `[\s\S]{0,900}` 窗口是"我们恰好没写长注释"的隐性依赖，P0-8 一加注释即假红。
  const candSqlLine = dlc.split('\n').find((l) => l.includes('FROM wa_deliverables d WHERE d.task_id = ?')) || '';
  ok(candSqlLine.includes("${t.sql}") && candSqlLine.includes("${docNotProbe('d')}"), 'primary_auto 候选探针滤除(不选 _probe/_tmp 当主要成果)');
  ok(setp.includes("key: 'per_doc_acceptance'") && setp.includes('验收按产出物逐条显示'), 'Settings 成果组加 per_doc_acceptance 行开关');
  // 补④(§十三): project.ipc 内联探针 SQL 收敛到共享 docNotProbe(无残留)
  // zx_20260911_2 M4-G4: 新增 healthViews delivCount 收敛 ⇒ 4 处同源(digest + 健康视图 + 全景 byType + 全景 recent)
  // zx_20260911_4 M4-3: task:get 补同一把尺(E12) ⇒ 4 处 → 5 处
  ok(!/COALESCE\(file_path, name\) NOT LIKE '%\/_probe%'/.test(pip), '补④ project.ipc 无内联探针 SQL 残留(全景 byType/recent 已收敛共享谓词)');
  // zx_20260913 M2(判据更新): M2-3 补 deliverable:list 漏网读点、M2-1 加 task:list 子树聚合 ⇒ 5 处 → 7 处。
  // 计数变更是**读点真增加**(不是收敛失效)：7 处仍全部经共享 docNotProbe，无内联重复 SQL（上一断言已证）。
  // zx_20260930 M4-1 **改钉更强的真源**（非放宽）：本轮的收敛比原先更深一层——读点不再自己拼
  //   `${docNotProbe(…)}` 这一串，而是**整个取数范围**都调共享函数。故判据从"各自拼了同一份谓词"
  //   升格为"**经共享取数范围真源**"：`deliverableScopeSql`(5) + `countDeliverables`(1) +
  //   `countDeliverablesByType`(1) = 仍是同样的**七处读点**，计数不变、语义更强。
  // zx_20260930 M4-2: 7 → 9。新增的两处读点都是分页逼出来的，且**必须是真源调用**：
  //   ①`task:get` 的 `countDeliverables(db, { taskIds: ownerIds })`——明细取 `dScope`、总数取同一组
  //   `taskIds`，两者同集合才谈得上"已加载 K / 共 M"；②`deliverable:facets` 的一次
  //   `deliverableScopeSql`（一份复用给项目名录/任务名录/无任务计数三个查询）。
  //   反证仍在上一条：九处**全部**经真源，无内联重复 SQL。
  ok((pip.match(/\b(deliverableScopeSql|countDeliverables|countDeliverablesByType)\(/g) || []).length === 9, '补④ project.ipc 九处读点**经共享取数范围真源**(digest + 健康视图 + 全景 byType + 全景 recent + task:get + task:list 子树 + deliverable:list + task:get 总数 + facets 名录)', String((pip.match(/\b(deliverableScopeSql|countDeliverables|countDeliverablesByType)\(/g) || []).length));
}

console.log('\n结果: pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
