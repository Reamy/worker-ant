/**
 * zx_20260910_3 批5 受控复跑（M3：布尔 setting 判据归一 + 库值规范化；真实现 + node:sqlite 真 SQL；绝不触碰开发库）。
 *
 * 本轮问题 G3「开关名 `show_acceptance` 与其实效脱钩」——两层病灶：
 *   ① **判据分身**：同一条「这个开关开着吗」的规则，主进程与渲染层共写了 33 处（`(v ?? 'true') !== 'false'`）。
 *      M0 基线 E11 记「全仓 17 处」——只扫了 `src/main` 而冠以「全仓」之名，漏了渲染层 16 处。
 *      故本文件的 S4「全仓残留 = 0」同时是对**基线自身**的订正断言。
 *   ② **真源只认字面 'false'**：而 '0' 是这条判断自己历史上产生过的关闭写法——
 *      `deliverable.*` 一族在 zx_20260909_1 M5 实机复核修之前，写端落库的是 '0'/'1'；
 *      至今 `deliverable.show_acceptance` 库值仍是 '0' ⇒ 用户点了「关」，界面照显（名实脱钩）。
 *
 * S1 判据真值表：八态（'false'/'0'/'true'/'1'/undefined/null/''/'yes'）。
 * S2 与旧判据**逐例等价对照**：除 '0' 外一律同解（结构性防外溢——本轮只该多认这一个值）。
 * S3 真 SQL 库值规范化：白名单 '0'→'false' / '1'→'true'；**数值键与缺省关键族一律不动**；
 *    迁移标记写入；**二次调用不改**（幂等）。
 * S4 静态·全仓归一：`src/main` + `renderer` 去注释后裸 `!== 'false'` **零残留**；每处消费点都 import 同一模块。
 * S5 静态·唯一实现 + 两侧共用：`boolSetting` 定义恰 1 处；渲染层 import 路径指向 **`src/main/core/settings-bool`**
 *    （同一份代码，而非同一条规则的第二次实现）；渲染层无第二份定义。
 * S6 静态·迁移接线：`index.ts` 启动处调用 `normalizeBooleanSettingValues`；标记名；白名单不含数值键/缺省关键族。
 * S7 静态·读点归一：`project.ipc` 三处 show_acceptance 读点（list/digest/preview）+ 渲染层各读点均走 boolSetting。
 *    zx_20260914 M2-3③ 订正：per_doc_acceptance 的三读点已收敛为 core `annotateAcceptance` 一处消费，
 *    故该条断言由"project.ipc 内 ≥3 处"改为**跨 project.ipc + core 的真值计数（恰 2 处）**，判据（俱走 boolSetting）不变。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  boolSetting, normalizeBooleanSettingValues, BOOL_SETTING_KEYS,
} from '../apps/worker-ant-desktop/src/main/core/settings-bool.js';
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (p?: string) => any };

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
/** 去注释后再断言——注释里常引用旧谓词（如"与旧判据 `!== 'false'` 逐位等价"），那是叙述不是代码 */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SB = 'apps/worker-ant-desktop/src/main/core/settings-bool.ts';
const MAIN = 'apps/worker-ant-desktop/src/main';
const REND = 'apps/worker-ant-desktop/renderer/src';

/** 递归列出目录下的 .ts/.tsx（跳过 node_modules） */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
console.log('\nS1 判据真值表（八态）');
ok(boolSetting('false') === false, "'false' → 关");
ok(boolSetting('0') === false, "★'0' → 关（本轮唯一新增语义：历史写法的关闭）");
ok(boolSetting('true') === true, "'true' → 开");
ok(boolSetting('1') === true, "'1' → 开（'1' 本就判开，未借机改判）");
ok(boolSetting(undefined) === true, 'undefined → 开（缺省即开，与 ensureSetting 默认 true 一致）');
ok(boolSetting(null) === true, 'null → 开');
ok(boolSetting('') === true, "'' → 开（空串非「明确说关」）");
ok(boolSetting('yes') === true, "'yes' → 开（任意脏值一律按开，不猜）");

// ─────────────────────────────────────────────────────────────
console.log('\nS2 与旧判据 `(v ?? \'true\') !== \'false\'` 逐例等价对照（除 \'0\' 外必须同解）');
const oldJudge = (v: string | undefined | null): boolean => (v ?? 'true') !== 'false';
const EQ_CASES: Array<string | undefined | null> = ['false', 'true', '1', undefined, null, '', 'yes', 'TRUE', 'False', '  '];
let eqMismatch = 0; let zeroDiffSeen = false;
for (const v of EQ_CASES) {
  const same = boolSetting(v) === oldJudge(v);
  if (!same) { eqMismatch++; console.error(`     差异 v=${JSON.stringify(v)}: 新=${boolSetting(v)} 旧=${oldJudge(v)}`); }
}
ok(eqMismatch === 0, `★除 '0' 外 ${EQ_CASES.length} 例逐例同解（结构性防外溢：本轮只该多认 '0'）`, `不一致 ${eqMismatch} 例`);
zeroDiffSeen = oldJudge('0') === true && boolSetting('0') === false;
ok(zeroDiffSeen, "★'0' 是全表唯一的语义差异点（旧：开 / 新：关）——正是用户裁决要的那一下");

// ─────────────────────────────────────────────────────────────
console.log('\nS3 真 SQL 库值规范化（白名单同义改写 + 数值键不动 + 幂等）');
function mkSettings(): any {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT)');
  const seed: Array<[string, string]> = [
    ['deliverable.show_acceptance', '0'],        // ★目标：用户裁决的 OFF
    ['deliverable.per_doc_acceptance', 'true'],  // 不动
    ['deliverable.first_write_v1', '1'],          // '1'→'true' 同义改写
    ['deliverable.doc_drawer', 'false'],          // 不动
    ['im.notify_pause_needed', 'false'],          // 不动
    ['plan.link_at_create', '0'],                 // 白名单内 → 'false'
    ['im.outbox_retry_min', '0'],                 // ★数值键：'0' 是合法值，必须不动
    ['memory.archive_retention_days', '0'],       // ★数值键：不动
    ['ui_dnd', '0'],                              // ★缺省关键族（判据 === '1'）：不动
    ['notify_sound_enabled', '0'],                // ★缺省关键族（判据 !== '0'）：不动
    ['ui_system_notifications', '0'],             // ★缺省关键族：不动
  ];
  for (const [k, v] of seed) db.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)').run(k, v);
  return db;
}
const sdb = mkSettings();
const changed = normalizeBooleanSettingValues(sdb);
const val = (k: string): string | undefined => (sdb.prepare('SELECT value FROM wa_settings WHERE key = ?').get(k) as { value?: string } | undefined)?.value;
ok(val('deliverable.show_acceptance') === 'false', "★show_acceptance '0' → 'false'（用户裁决：修成真 OFF）");
ok(val('plan.link_at_create') === 'false', "plan.link_at_create '0' → 'false'");
ok(val('deliverable.first_write_v1') === 'true', "first_write_v1 '1' → 'true'（同义改写，判据下零行为变化）");
ok(val('deliverable.per_doc_acceptance') === 'true', 'per_doc_acceptance 未动（无需求不改）');
ok(val('deliverable.doc_drawer') === 'false', 'doc_drawer 已规范值未动');
ok(val('im.notify_pause_needed') === 'false', 'im.notify_pause_needed 已规范值未动');
ok(val('im.outbox_retry_min') === '0', "★数值键 im.outbox_retry_min 的 '0' **未被误改**（'0' 对其是合法分钟数）");
ok(val('memory.archive_retention_days') === '0', '★数值键 memory.archive_retention_days 的 0 **未被误改**');
ok(val('ui_dnd') === '0', "★缺省关键族 ui_dnd 的 '0' 未被误改（其判据是 === '1'，改写法即改语义）");
ok(val('notify_sound_enabled') === '0', "★缺省关键族 notify_sound_enabled 的 '0' 未被误改");
ok(val('ui_system_notifications') === '0', "★缺省关键族 ui_system_notifications 的 '0' 未被误改");
ok(changed === 3, '生效行数 = 3（白名单内两行 \'0\' + 一行 \'1\'）', `实测 ${changed}`);
ok(val('migration.bool_setting_normalize') === 'done', '迁移标记已写入（下次启动不再跑）');
const second = normalizeBooleanSettingValues(sdb);
ok(second === 0, '★幂等：二次调用 return 0 且不写库', `实测 ${second}`);

// 白名单本身的结构约束
ok(!BOOL_SETTING_KEYS.includes('im.outbox_retry_min') && !BOOL_SETTING_KEYS.includes('memory.archive_retention_days'),
  "★白名单不含数值键（防规范化误伤分钟数/天数）");
ok(!BOOL_SETTING_KEYS.includes('ui_dnd') && !BOOL_SETTING_KEYS.includes('notify_sound_enabled')
  && !BOOL_SETTING_KEYS.includes('ui_system_notifications') && !BOOL_SETTING_KEYS.includes('sound_completed')
  && !BOOL_SETTING_KEYS.includes('notify_quiet_mute_critical'),
  '★白名单不含缺省关键族（其判据不同，并入即无据的行为变更）');
ok(BOOL_SETTING_KEYS.includes('deliverable.show_acceptance') && BOOL_SETTING_KEYS.includes('im.notify_pause_needed'),
  '白名单含本轮全部 22 个 boolSetting 判定键（含 show_acceptance / im.notify_pause_needed）');

// ─────────────────────────────────────────────────────────────
console.log('\nS4 静态·全仓归一（去注释后裸 `!== \'false\'` 零残留）');
const allFiles = [...walk(MAIN), ...walk(REND)];
const rawSites: string[] = [];
for (const f of allFiles) {
  const code = stripComments(rd(f));
  code.split('\n').forEach((line, i) => { if (line.includes("!== 'false'")) rawSites.push(`${f}:${i + 1}`); });
}
ok(rawSites.length === 0, '★全仓（src/main + renderer）裸 `!== \'false\'` 零残留（含双引号变体）', rawSites.join(', ') || '0 处');
const dblSites: string[] = [];
for (const f of allFiles) {
  const code = stripComments(rd(f));
  code.split('\n').forEach((line, i) => { if (line.includes('!== "false"')) dblSites.push(`${f}:${i + 1}`); });
}
ok(dblSites.length === 0, '双引号变体 `!== "false"` 亦零残留', dblSites.join(', ') || '0 处');

// 主进程 17 处消费点所在文件，逐一确认引了同一模块
// zx_20260920_1 M1 就地订正：`boolSetting` 的消费点随工具实现机械搬迁进了 `core/tools/*.ts`
// （`agent-executor.ts` 如今只剩 `readBoolSetting`，裸 `boolSetting` 零调用 ⇒ 已从 import 中删去）。
// 台账须随之回填——否则断言会拿一份**已经不消费它**的文件去判"确有调用"
// （即 feedback_enum_value_sweep_readers 那类"落点搬了、名单没搬"的假红）。
// zx_20261003 M8 就地改钉：`finalize_task` 的执行体（含其 `boolSetting` 消费点）已由
// `core/tools/control.ts` 机械搬迁至 `core/tools/control-finalize.ts`（导出 `runFinalizeTask`）；
// `control.ts` 如今只剩委托、不再消费 `boolSetting` ⇒ 消费点名单须跟着实现走（判据不变，仍判"恰在此文件"）。
const MAIN_USERS = [
  'core/tools/control-finalize.ts', 'core/tools/write.ts',
  'core/im/im-notify.ts', 'core/jobs/ai-task.ts', 'core/jobs/index.ts',
  'core/memory-manager.ts', 'ipc/project.ipc.ts', 'index.ts', 'services/im-router.ts',
];
for (const f of MAIN_USERS) {
  const code = stripComments(rd(`${MAIN}/${f}`));
  const hasImport = /import\s*\{[^}]*boolSetting[^}]*\}\s*from\s*'[^']*settings-bool\.js'/.test(code);
  ok(hasImport && code.includes('boolSetting('), `main ${f}：import boolSetting 且确有调用`);
}
// 渲染层 9 个消费文件，逐一确认 import 路径指向**同一文件**
const REND_USERS = [
  'components/PresenceBar.tsx', 'components/CommandPalette.tsx', 'components/DeliverableDrawer.tsx',
  'components/DeliveryDigestCard.tsx', 'pages/DeliverablesPage.tsx', 'pages/SettingsPage.tsx',
  'pages/TaskDetailPage.tsx', 'pages/ProjectDetailPage.tsx', 'pages/TasksPage.tsx',
];
for (const f of REND_USERS) {
  const code = stripComments(rd(`${REND}/${f}`));
  const m = code.match(/import\s*\{\s*boolSetting\s*\}\s*from\s*'([^']+)'/);
  ok(!!m && /src\/main\/core\/settings-bool(\.js)?$/.test(m![1]),
    `renderer ${f}：引**同一文件** src/main/core/settings-bool`, m ? m[1] : '未找到 import');
}

// ─────────────────────────────────────────────────────────────
console.log('\nS5 静态·唯一实现（两侧共用一份代码，非二次实现）');
const sbCode = stripComments(rd(SB));
const defCount = [...allFiles].reduce((n, f) => n + (stripComments(rd(f)).match(/function\s+boolSetting\s*\(/g) || []).length, 0);
ok(defCount === 1, `★全仓 boolSetting 定义恰 1 处（渲染层不得自带第二份写法）`, `实测 ${defCount}`);
ok(/export function boolSetting\(value: string \| undefined \| null\): boolean/.test(sbCode),
  '签名如约：单参（未保留不生效的 defaultTrue 形参——"有参数之名、无参数之实"亦属本轮所治之名实不符）');
ok(/return !\(value === 'false' \|\| value === '0'\);/.test(sbCode), '判据正文：只认 \'false\'/\'0\' 为关');
ok(stripComments(rd(SB)).includes('BOOL_SETTING_KEYS'), '白名单与判据**同文件同源**（防"判据一份、名单另一份"再分家）');

// ─────────────────────────────────────────────────────────────
console.log('\nS6 静态·迁移接线');
const idxCode = stripComments(rd(`${MAIN}/index.ts`));
ok(idxCode.includes('normalizeBooleanSettingValues(db'), 'index.ts 启动处调用 normalizeBooleanSettingValues（真接线，非只定义不调用）');
ok(sbCode.includes("'migration.bool_setting_normalize'") || sbCode.includes('migration.bool_setting_normalize'),
  '迁移标记名 migration.bool_setting_normalize（同 migration.doc_acceptance_backfill 之法）');
ok(/SELECT 1 FROM wa_settings WHERE key = \?/.test(sbCode), '标记守护读在写前（仅首启跑一次）');

// ─────────────────────────────────────────────────────────────
console.log('\nS7 静态·读点归一（三入口一致，不再各写各的）');
const pipc = stripComments(rd(`${MAIN}/ipc/project.ipc.ts`));
// zx_20260914 M2-3③: 验收派生收敛为 core `annotateAcceptance` 一处 ⇒ per_doc 读点由 3 降到 1(digest 取数口径)。
//   故断言改为**跨两文件的真值计数**并写明扫描面（`src/main/ipc/project.ipc.ts` + `src/main/core/deliverable-lifecycle.ts`）——
//   "≥3 处"是收敛前的形状，钉住它等于禁止收敛。
const dlcc = stripComments(rd(`${MAIN}/core/deliverable-lifecycle.ts`));
const accReads = (pipc.match(/boolSetting\(acc[A-Za-z]*\?\.value\)/g) || []).length;
const pdReads = (pipc.match(/boolSetting\(pd[A-Za-z]*\?\.value\)/g) || []).length;
const pdInCore = (dlcc.match(/boolSetting\(pd[A-Za-z]*\?\.value\)/g) || []).length;
ok(accReads >= 3, `project.ipc show_acceptance 读点 ≥3 处（list/digest/preview 三入口）全走 boolSetting`, `实测 ${accReads}`);
ok(pdReads === 1 && pdInCore === 1,
  `per_doc_acceptance 读点恰 2 处（annotateAcceptance 服务 list/preview/task:get 三读点 + digest 取数口径），俱走 boolSetting`,
  `实测 project.ipc ${pdReads} + core ${pdInCore}`);
// 键名直读须与上条同数——否则存在"读了键却没走 boolSetting"的旁路判据
const pdRaw = (pipc.match(/'deliverable\.per_doc_acceptance'/g) || []).length + (dlcc.match(/'deliverable\.per_doc_acceptance'/g) || []).length;
ok(pdRaw === 2, 'per_doc_acceptance 键名直读亦恰 2 处（无旁路判据）', `实测 ${pdRaw}`);
ok(!/acc[A-Za-z]*\?\.value \?\? 'true'/.test(pipc) && !/pd[A-Za-z]*\?\.value \?\? 'true'/.test(pipc),
  "★三入口不再出现 `?? 'true'` 的旧写法（那正是分身判据的形态）");
// im-notify 反向形（=== 'false'）已并入——同一判据的第二形态不许留
const imn = stripComments(rd(`${MAIN}/core/im/im-notify.ts`));
ok(imn.includes('!boolSetting(settingOf(db, \'im.notify_pause_needed\''), "★im-notify 反向形 `=== 'false'` 已并入为 !boolSetting(...)（同键同义，留着即分家）");
ok(!imn.includes("=== 'false'"), '★im-notify 无残留 `=== \'false\'`');

// ─────────────────────────────────────────────────────────────
console.log('\nS8 边界：判据对真实库值的判定（读到"关"是真的关）');
// 用户裁决的原始场景复现：库值 '0' 经 boolSetting 判为关（修复前判为开）
ok(boolSetting('0') === false && oldJudge('0') === true,
  '★用户场景复现：show_acceptance=\'0\' 旧法判开（点了关界面照显）→ 新法判关（名实相符）');
// 迁移后库值变 'false'，判定不变（迁移与判据口径一致，不存在"迁移后又被判开"的缝）
ok(boolSetting('false') === boolSetting('0'), "迁移前后判定一致（'0' 与 'false' 同为关）——库值规范化不改变最终判定");

console.log('\n结果: pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
