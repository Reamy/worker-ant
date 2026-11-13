/**
 * zx_20261107_1 B6「实·通·信」受控回归 —— 模型管理（维特根斯坦·意义即用法 / 坛经·自性 / 毛选·实事求是）。
 *
 * 钉住五件事：
 *   A 结构化与文本**同源**：`[选型]` 行由 `formatModelSelectionReason(selection)` 一处派生，全仓恰一处；
 *   B 洗形**不臆造**：五要素缺一格 ⇒ 整块作废；价格/币种未知 ⇒ `null`（不补 0、不默认 CNY）；
 *   C 三处指定的**优先级唯一裁定**：恢复路 > 项目级 > 全局默认；写项目级只动 `model_override` 一个键；
 *   D 币种**单源**：ANS 目录 `provider_currency` → 三出口 → `/providers.currency` → 界面，界面无第二份映射；
 *   E GUI 接线：默认模型写 `wa_settings['model.default_model']`、项目覆盖走专用 IPC、任务详情读 `modelSelection`
 *     （不解析 `context_json`）。
 *
 * 纪律：零网络 / 零 electron / 零时钟；无「只为下一轮」字面量（轮次由 `path.basename(__filename)` 派生）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  formatModelSelectionReason,
  sanitizeModelSelection,
  PIN_SOURCE_LABEL,
  type ModelSelection,
} from '../apps/worker-ant-desktop/src/main/core/model-selection.js';
import {
  DEFAULT_MODEL_SETTING_KEY,
  PROJECT_MODEL_OVERRIDE_KEY,
  readDefaultModel,
  readProjectModelOverride,
  writeProjectModelOverride,
  resolvePinnedModel,
} from '../apps/worker-ant-desktop/src/main/core/model-preference.js';
import { providerCurrencyOf, type RecommendedConfig } from '../apps/ans-server/src/services/recommended-config.js';
import { buildNotOlderThan, checkBuildPins, deriveBuildTag, stripKeepingLines } from './lib/rr-pins.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'apps/worker-ant-desktop/src/main');
const RENDERER = path.join(ROOT, 'apps/worker-ant-desktop/renderer/src');
const ANS = path.join(ROOT, 'apps/ans-server/src');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

const RD = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

const baseSel = (over: Partial<ModelSelection> = {}): ModelSelection => ({
  strategySource: 'project',
  strategy: 'capability-best',
  model: 'm-1',
  endpoint: 'remote',
  capabilityMatch: '全部满足',
  reason: '',
  inputPricePer1k: 0.001,
  outputPricePer1k: 0.002,
  currency: 'USD',
  pinned: null,
  ...over,
});

// ═══ A｜结构化与文本同源 ═════════════════════════════════════════════════════
function sectionA(): void {
  console.log('\n【A】结构化与文本同源');

  const line = formatModelSelectionReason(baseSel());
  eq(
    line,
    '策略来源=project · 策略=capability-best · 模型=m-1 · 端点=remote · 能力匹配=全部满足',
    'A1 理由行五要素格式唯一（`[选型]` 后原样拼它）',
  );

  const exec = CODE('apps/worker-ant-desktop/src/main/core/exec-model-select.ts');
  eq((exec.match(/\[选型\]/g) ?? []).length, 1, 'A2 ★`[选型]` 前缀在选型段恰一处（不多记第二本账）');
  ok(exec.includes('const selectLine = `[选型] ${selection.reason}`'),
    'A3 文本行**由结构化 reason 派生**（不是另拼一份中文）');
  ok(exec.includes('selection.reason = formatModelSelectionReason(selection);'),
    'A4 reason 唯一生成处被调用（与 A1 同一函数）');
  ok(exec.includes("json_set(COALESCE(context_json, '{}'), '$.model_selection', json(?))"),
    'A5 结构化副本单键 json_set（不整份覆写 context_json）');
  eq((exec.match(/formatModelSelectionReason\(/g) ?? []).length, 1,
    'A6 该函数在文件内恰一处调用（无第二处手拼）');

  // `[选型·沿用]` / `[选型·指定]` 不得含 `[选型]` 子串（否则 A2 的「恰一处」名存实亡）。
  for (const glyph of ['沿用', '指定']) {
    ok(!`[选型·${glyph}]`.includes('[选型]'), `A7 ${glyph} 标签与四要素标签互不含（前缀唯一）`);
  }
}

// ═══ B｜洗形不臆造 ═══════════════════════════════════════════════════════════
function sectionB(): void {
  console.log('\n【B】洗形不臆造');

  const good = sanitizeModelSelection(baseSel());
  eq(good?.model, 'm-1', 'B1 合法结构 ⇒ 原样保留');

  const withReason = { ...baseSel(), reason: '存档原文一句' };
  eq(sanitizeModelSelection(withReason)?.reason, '存档原文一句', 'B2 存档 reason 优先（那是当时说的话）');

  const noReason = sanitizeModelSelection(baseSel());
  eq(noReason?.reason, formatModelSelectionReason(baseSel()), 'B3 缺 reason ⇒ 由五要素现算（同一格式）');

  for (const missing of ['strategySource', 'strategy', 'model', 'endpoint', 'capabilityMatch']) {
    const bad = { ...baseSel(), [missing]: '' };
    eq(sanitizeModelSelection(bad), null, `B4 五要素缺「${missing}」⇒ 整块作废（说不出=不说）`);
  }
  eq(sanitizeModelSelection([baseSel()]), null, 'B5 数组形 ⇒ null');
  eq(sanitizeModelSelection(null), null, 'B6 空值 ⇒ null');

  const unknownPrice = sanitizeModelSelection({ ...baseSel(), inputPricePer1k: undefined, outputPricePer1k: 'x', currency: '' });
  eq([unknownPrice?.inputPricePer1k, unknownPrice?.outputPricePer1k, unknownPrice?.currency], [null, null, null],
    'B7 ★价格/币种未知 ⇒ null（不补 0、不默认 CNY、不认非数字串）');

  const zeroPrice = sanitizeModelSelection({ ...baseSel(), inputPricePer1k: 0, outputPricePer1k: 0 });
  eq([zeroPrice?.inputPricePer1k, zeroPrice?.outputPricePer1k], [0, 0], 'B8 0 是合法的已知值（与未知分家）');

  const badPinned = sanitizeModelSelection({ ...baseSel(), pinned: { source: 'nowhere', requested: 'x', applied: true } });
  eq(badPinned?.pinned, null, 'B9 坏 pinned ⇒ 只丢该项（不连坐整块）');
  eq(badPinned?.model, 'm-1', 'B10 其余字段照留');

  const goodPinned = sanitizeModelSelection({ ...baseSel(), pinned: { source: 'project', requested: 'm-9', applied: false } });
  eq(goodPinned?.pinned, { source: 'project', requested: 'm-9', applied: false }, 'B11 合法 pinned 保留（含 applied=false）');

  eq(PIN_SOURCE_LABEL.project, '项目指定', 'B12 来源词表一处（渲染层跨 root 引它）');
}

// ═══ C｜三处指定的唯一裁定 ══════════════════════════════════════════════════
function sectionC(): void {
  console.log('\n【C】三处指定：恢复路 > 项目级 > 全局默认');

  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_projects (id TEXT PRIMARY KEY, context_json TEXT, updated_at TEXT);
    CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  const prodDb = db as unknown as Parameters<typeof readDefaultModel>[0];
  const siblings = { budget: { max_tokens_per_task: 1234 }, rhythm: { maxConcurrency: 3 } };

  // 0 起点：三处皆空（正面断言起点是 null，不是"不抛"）
  eq(resolvePinnedModel(prodDb, 'p1'), null, 'C1 三处皆空 ⇒ null（自动选型）');
  eq(readDefaultModel(prodDb), null, 'C2 默认模型未设 ⇒ null');

  db.prepare('INSERT INTO wa_projects (id, context_json) VALUES (?, ?)').run('p1', JSON.stringify(siblings));
  db.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)').run(DEFAULT_MODEL_SETTING_KEY, '  global-m  ');

  eq(readDefaultModel(prodDb), 'global-m', 'C3 ★全局默认 0→1：写入后读到（且已 trim）');
  eq(resolvePinnedModel(prodDb, 'p1'), { source: 'default', requested: 'global-m' }, 'C4 只有全局 ⇒ source=default');

  db.prepare('UPDATE wa_projects SET context_json = json_set(context_json, \'$.model_override\', ?) WHERE id = ?')
    .run('project-m', 'p1');
  eq(resolvePinnedModel(prodDb, 'p1'), { source: 'project', requested: 'project-m' }, 'C5 项目级压过全局默认');

  eq(resolvePinnedModel(prodDb, 'p1', 'resume-m'), { source: 'resume', requested: 'resume-m' },
    'C6 ★恢复路压过项目级（既有行为逐字不变）');
  eq(resolvePinnedModel(prodDb, null, 'resume-m'), { source: 'resume', requested: 'resume-m' },
    'C7 无项目 id 时恢复路照样优先');

  // 空白不算指定
  db.prepare('UPDATE wa_projects SET context_json = json_set(context_json, \'$.model_override\', ?) WHERE id = ?')
    .run('   ', 'p1');
  eq(readProjectModelOverride(prodDb, 'p1'), null, 'C8 空白项目覆盖按未设处理');
  eq(resolvePinnedModel(prodDb, 'p1'), { source: 'default', requested: 'global-m' }, 'C9 未设项目 ⇒ 回落全局');

  // 写项目级：只动一个键，兄弟键原样
  ok(writeProjectModelOverride(prodDb, 'p1', 'write-m'), 'C10 写项目覆盖 ⇒ changes>0');
  const row = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get('p1') as { context_json: string };
  const parsed = JSON.parse(row.context_json) as Record<string, unknown>;
  eq(parsed[PROJECT_MODEL_OVERRIDE_KEY], 'write-m', 'C11 单键已写');
  eq(parsed.budget, siblings.budget, 'C12 ★兄弟键 budget 原样保留（json_set 非覆写）');
  eq(parsed.rhythm, siblings.rhythm, 'C13 ★兄弟键 rhythm 原样保留');

  ok(writeProjectModelOverride(prodDb, 'p1', null), 'C14 清除项目覆盖 ⇒ changes>0');
  const cleared = JSON.parse((db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get('p1') as { context_json: string }).context_json) as Record<string, unknown>;
  eq(cleared[PROJECT_MODEL_OVERRIDE_KEY], undefined, 'C15 键已删');
  eq(cleared.budget, siblings.budget, 'C16 清除同样不连坐兄弟键');

  eq(writeProjectModelOverride(prodDb, 'nope', 'x'), false, 'C17 写不存在的项目 ⇒ false（不假装成功）');

  db.prepare('UPDATE wa_projects SET context_json = ? WHERE id = ?').run('{坏 JSON', 'p1');
  eq(readProjectModelOverride(prodDb, 'p1'), null, 'C18 脏 JSON ⇒ null（不抛）');
  db.prepare('UPDATE wa_projects SET context_json = ? WHERE id = ?').run('[1,2]', 'p1');
  eq(readProjectModelOverride(prodDb, 'p1'), null, 'C19 非对象 JSON ⇒ null');

  // 表不存在也不抛（rr/首启窗口）
  const empty = new DatabaseSync(':memory:') as unknown as Parameters<typeof readDefaultModel>[0];
  eq(readDefaultModel(empty), null, 'C20 无表 ⇒ null（不抛）');
  eq(resolvePinnedModel(empty, 'p1'), null, 'C21 无表 ⇒ 三处皆空');
}

// ═══ D｜币种单源 ═════════════════════════════════════════════════════════════
function sectionD(): void {
  console.log('\n【D】币种单源：目录 → 三出口 → 界面');

  const catalog = JSON.parse(fs.readFileSync(path.join(ANS, 'data/recommended-models.json'), 'utf-8')) as RecommendedConfig;
  const currencies = catalog.provider_currency ?? {};
  const unmapped = catalog.providers.filter((p) => !currencies[p.id]).map((p) => p.id);
  eq(unmapped, [], 'D1 目录内每个系统供应商都有币种（缺项=界面印不出符号）');
  ok(Object.keys(currencies).length >= catalog.providers.length,
    'D2 币种表覆盖数不少于供应商数', `${Object.keys(currencies).length} vs ${catalog.providers.length}`);

  const first = catalog.providers[0]!;
  eq(providerCurrencyOf(catalog, first.id), currencies[first.id], 'D3 已知 provider ⇒ 目录里的币种');
  eq(providerCurrencyOf(catalog, 'user-uuid-1234'), null, 'D4 ★自建 provider（UUID）⇒ null，不臆造');
  eq(providerCurrencyOf(catalog, null), null, 'D5 无 id ⇒ null');

  const models = CODE('apps/ans-server/src/routes/models.ts');
  ok(models.includes("import { getRecommendedConfig, providerCurrencyOf } from '../services/recommended-config.js'"),
    'D6 /providers 与 /recommended 同引一处读取器');
  eq((models.match(/providerCurrencyOf\(/g) ?? []).length, 2, 'D7 两个出口各带一次币种（providers 行 / recommended 行）');
  ok(models.includes('provider_currency: config.provider_currency ?? {}'),
    'D8 /recommended 信封带 `provider_currency`（界面据它显示，不自抄）');

  const optimal = CODE('apps/ans-server/src/routes/optimal-model.ts');
  eq((optimal.match(/providerCurrencyOf\(/g) ?? []).length, 2, 'D9 /optimal 主模型与降级链都带币种');

  const mp = CODE('apps/worker-ant-desktop/renderer/src/pages/ModelsPage.tsx');
  ok(!/PROVIDER_CURRENCY|getCurrency/.test(mp), 'D10 ★界面已无第二份币种映射（renderer 是词表第二落点的老病）');
  ok(mp.includes("ansProxy.getRaw<RecEnvelope>('/api/v1/models/recommended')"),
    'D11 用完整信封读 `/recommended`（`get` 会剥掉 use_cases）');
  ok(mp.includes('provider_currency') && mp.includes('use_cases'), 'D12 信封两兄弟键都进类型/消费面');
  ok(mp.includes('currencyOf(m.provider_id)'), 'D13 模型价格按所在 provider 的币种打印');
  ok(!mp.includes('¥'), 'D14 ★模型页不再写死 ¥（统计/价格行全部走真实币种）');

  const ipcMain = CODE('apps/worker-ant-desktop/src/main/ipc-handlers.ts');
  ok(ipcMain.includes("ipcMain.handle('ans-proxy:getRaw'"), 'D15 main 有完整信封通道');
  const ipc = CODE('apps/worker-ant-desktop/renderer/src/lib/ipc.ts');
  ok(ipc.includes("ipcCall<T>('ans-proxy:getRaw', path)"), 'D16 renderer 有 getRaw 通道');
}

// ═══ E｜GUI 接线 ═════════════════════════════════════════════════════════════
function sectionE(): void {
  console.log('\n【E】GUI 接线');

  const proj = CODE('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
  ok(proj.includes("'project:model_override_get'") && proj.includes("'project:model_override_set'"),
    'E1 项目覆盖两个专用 IPC 在册（不走 project:update 整体覆写）');
  ok(proj.includes('writeProjectModelOverride(db'), 'E2 写入复用单键写入器');
  ok(proj.includes('sanitizeModelSelection(rawModelSelection)'), 'E3 task:get 回传洗形后的 modelSelection');
  ok(proj.includes("parsedCtx.model_selection"), 'E4 读点取 `context_json.model_selection`（与写点同键）');

  const ipc = CODE('apps/worker-ant-desktop/renderer/src/lib/ipc.ts');
  ok(ipc.includes("'project:model_override_get'") && ipc.includes("'project:model_override_set'"),
    'E5 renderer 项目覆盖通道与 main 同名');
  ok(ipc.includes('modelSelection?: ModelSelection | null'), 'E6 tasks.get 返回类型含 modelSelection');

  const modelsPage = CODE('apps/worker-ant-desktop/renderer/src/pages/ModelsPage.tsx');
  ok(modelsPage.includes("invoke('settings:set', 'model.default_model'"), 'E7 默认模型走 settings 单键写入');
  ok(modelsPage.includes('设为默认'), 'E8 模型行有设为默认入口');
  ok(modelsPage.includes('取消默认'), 'E9 有取消默认（回到自动选型）');

  const projectPage = CODE('apps/worker-ant-desktop/renderer/src/pages/ProjectDetailPage.tsx');
  ok(projectPage.includes('projects.modelOverride.get(') && projectPage.includes('projects.modelOverride.set('),
    'E10 项目详情读写项目覆盖');
  ok(projectPage.includes("from '../../../src/main/core/model-selection.js'") && projectPage.includes('PIN_SOURCE_LABEL'),
    'E11 来源词表跨 root 引同一份');
  ok(!/const PIN_SOURCE_LABEL: Record/.test(projectPage), 'E12 ★页面内无第二份来源词表');

  const taskPage = CODE('apps/worker-ant-desktop/renderer/src/pages/TaskDetailPage.tsx');
  ok(taskPage.includes('为什么选它'), 'E13 任务详情有「为什么选它」入口');
  ok(taskPage.includes('modelSelection.reason'), 'E14 抽屉显示同一句理由（不另拼）');
  ok(!taskPage.includes('model_selection'), 'E15 ★页面不解析 context_json 的 model_selection（只读 IPC）');
  ok(taskPage.includes('formatMoney(modelSelection.inputPricePer1k'),
    'E16 单价按记录币种显示（未知币种不印符号）');
  ok(taskPage.includes('已回落自动选型'), 'E17 pinned.applied=false 如实说「回落」');
}

// ═══ F｜构建钉 ═══════════════════════════════════════════════════════════════
function sectionF(): void {
  console.log('\n【F】构建钉');
  const { tag } = deriveBuildTag(fs.readFileSync(path.join(DESKTOP, 'core/agent-executor.ts'), 'utf-8'));
  ok(buildNotOlderThan(tag, SELF_ROUND), 'F1 build 标识不早于脚本轮次（方向性派生）', `${tag} vs ${SELF_ROUND}`);
  checkBuildPins(ok, { rootDir: ROOT });
}

sectionA();
sectionB();
sectionC();
sectionD();
sectionE();
sectionF();

console.log(`\n[rr_${SELF_ROUND}_model] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
