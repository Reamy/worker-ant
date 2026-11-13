/**
 * zx_20261107_1 B8「实·通·信」受控回归 —— 系统设置（维特根斯坦·语言游戏 / 老子·无为 / 王阳明·知行合一）。
 *
 * 三问（零网络 / 零 electron / 零时钟）：
 *   A 名实：布尔键白名单（main `BOOL_SETTING_KEYS`）与设置页**同一把尺**——
 *     每个键要么本页有专属开关、要么他页有专属入口、要么进「高级设置」，三者并集恰等白名单；
 *   B 归一：同一枚开关只留一份实现（`Switch`），不再有第二套手写 `w-11 h-6`；
 *   C 可达：高级键全部有中文名与写口（'true'/'false'），缺省关键不进高级区；
 *     搜索的分区名单与 `cardCls(...)` 调用双向一致。
 *
 * 纪律：名单/计数一律由**载体自身**派生（`BOOL_SETTING_KEYS`、`path.basename(__filename)`），
 * 不写"只为下一轮"的字面量；断言文案不含失败字形。
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildNotOlderThan, checkBuildPins, deriveBuildTag } from './lib/rr-pins.js';
import { BOOL_SETTING_KEYS } from '../apps/worker-ant-desktop/src/main/core/settings-bool.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const ROOT = path.join(__dirname, '..');
const SETTINGS = path.join(ROOT, 'apps/worker-ant-desktop/renderer/src/pages/SettingsPage.tsx');
const DIST = path.join(ROOT, 'apps/worker-ant-desktop/renderer/dist');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

const src = fs.readFileSync(SETTINGS, 'utf-8');

/** 取 `const NAME ... = [...]` / `{...}` / `filter(...)` 的块文本（到最近的 `];` / `};` / `);`）。 */
function block(name: string): string {
  const i = src.indexOf(`const ${name}`);
  if (i < 0) return '';
  const eqIdx = src.indexOf('=', i);
  const ends = [src.indexOf('];', eqIdx), src.indexOf('};', eqIdx), src.indexOf(');', eqIdx)]
    .filter((x) => x >= 0);
  if (!ends.length) return '';
  return src.slice(i, Math.min(...ends) + 2);
}
/** 单引号字符串字面量（跳过含 `${}` 的模板位）。 */
function literals(text: string): string[] {
  return [...text.matchAll(/'([^'`$]*)'/g)].map((m) => m[1]!).filter((s) => s.length > 0);
}
/** 对象字面量里的 `key: '...'`（DELIV_OPTS / IM_OPTS 的 key 字段）。 */
function optKeys(name: string): string[] {
  return [...block(name).matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]!);
}
function recordKeys(startMarker: string): string[] {
  const i = src.indexOf(startMarker);
  if (i < 0) return [];
  const j = src.indexOf('};', i);
  const body = j < 0 ? src.slice(i) : src.slice(i, j);
  return [...body.matchAll(/'([^']+)':/g)].map((m) => m[1]!)
    .filter((k) => k.includes('.') || BOOL_SETTING_KEYS.includes(k));
}

// ── 运行时派生三张名单（与页面同一算法）──────────────────────────────
const deliv = optKeys('DELIV_OPTS').map((k) => `deliverable.${k}`);
const im = optKeys('IM_OPTS').map((k) => `im.${k}`);
const exposedLiterals = literals(block('EXPOSED_BOOL_KEYS'));
const EXPOSED = [...deliv, ...im, ...exposedLiterals];
const ELSEWHERE = literals(block('ELSEWHERE_BOOL_KEYS'));
const ADVANCED = BOOL_SETTING_KEYS.filter((k) => !EXPOSED.includes(k) && !ELSEWHERE.includes(k));
const LABELS = recordKeys('const ADVANCED_BOOL_LABELS');
const SECTION_IDS = [...(block('SECTION_KEYWORDS').matchAll(/(?:'([^']+)'|([A-Za-z_$][\w$]*)):\s*'/g))]
  .map((m) => (m[1] ?? m[2])!);
const CARD_IDS = [...src.matchAll(/cardCls\('([^']+)'\)/g)].map((m) => m[1]!);
const WRAP_IDS = [...src.matchAll(/wrapCls\('([^']+)'\)/g)].map((m) => m[1]!);

function sectionA(): void {
  console.log('\n【A】名实：三张名单与白名单同一把尺');
  ok(src.includes("from '../../../src/main/core/settings-bool.js';"),
    'A1 判据与白名单同引 main 唯一真源（settings-bool）');
  // 旧套 `rr_zx_20260910_3_b3` 以精确形状钉住 `import { boolSetting }`——本页不得改成组合导入
  ok(/import\s*\{\s*boolSetting\s*\}\s*from\s*'[^']*settings-bool\.js';/.test(src),
    'A2 `import { boolSetting }` 保持单名精确形状（旧钉同源证明不破）');
  ok(/import\s*\{\s*BOOL_SETTING_KEYS\s*\}\s*from\s*'[^']*settings-bool\.js';/.test(src),
    'A3 白名单单独一行导入（高级区由它自动枚举，不手抄第二份）');
  ok(block('ADVANCED_BOOL_KEYS').includes('BOOL_SETTING_KEYS.filter('),
    'A4 `ADVANCED_BOOL_KEYS` 由白名单**过滤派生**（新增键自动进高级区）');

  const all = [...EXPOSED, ...ELSEWHERE];
  eq(all.filter((k) => !BOOL_SETTING_KEYS.includes(k)), [],
    'A5 专属/他页名单里的键**全部在白名单内**（无踢出名单的野键）');
  eq([...EXPOSED, ...ELSEWHERE, ...ADVANCED].sort(), [...BOOL_SETTING_KEYS].sort(),
    'A6 三者并集 == 白名单（每个布尔键都有去处）');
  const dup = all.filter((k, i) => all.indexOf(k) !== i);
  eq(dup, [], 'A7 专属/他页名单无重复键（同一键不摆两个入口）');
  ok(EXPOSED.every((k) => !ELSEWHERE.includes(k)),
    'A8 专属与他页互不相交（同一把尺只留一个落点）');
  ok(ADVANCED.every((k) => !all.includes(k)),
    'A9 高级区不含已有专属开关的键');
  console.log(`  名单：专属 ${EXPOSED.length} / 他页 ${ELSEWHERE.length} / 高级 ${ADVANCED.length}（白名单 ${BOOL_SETTING_KEYS.length}）`);
}

function sectionB(): void {
  console.log('\n【B】归一：同一枚开关只留一份实现');
  eq((src.match(/role="switch"/g) ?? []).length, 1,
    'B1 `role="switch"` 全页仅一处（`Switch` 组件内部）');
  ok(src.includes('const Switch = ({ on, onToggle }'),
    'B2 归一载体 `Switch` 在场');
  eq((src.match(/w-11 h-6/g) ?? []).length, 0,
    'B3 反证：不再有第二套手写开关（`w-11 h-6` 清零）');
  ok(src.includes('<Switch on={quietMuteCritical} onToggle={toggleQuietMuteCritical} />'),
    'B4 安静时段关键态静音改用同一枚 `Switch`');
  ok(src.includes('<Switch on={dnd} onToggle={toggleDnd} />')
    && src.includes('<Switch on={sysNotif} onToggle={toggleSysNotif} />'),
    'B5 免打扰/系统通知两枚同归一');
}

function sectionC(): void {
  console.log('\n【C】可达：高级区有名字、有写口、缺省关键不误用');
  eq(LABELS.filter((k) => !ADVANCED.includes(k)), [],
    'C1 高级区中文名表不含名单外的键（名表与名单同尺）');
  eq(ADVANCED.filter((k) => !LABELS.includes(k)), [],
    'C2 每个高级键都有中文名（缺名即弄红）');
  ok(LABELS.every((k) => (src.match(new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*'[^']+'`)) ?? []).length === 1),
    'C3 每个高级键的中文名非空');

  // 缺省关的键不进通用高级开关（只写库 != 真起真停；且 `boolSetting` 会把它当"开"）
  ok(!ADVANCED.includes('node.external_inbound') && ELSEWHERE.includes('node.external_inbound'),
    'C4 `node.external_inbound` 归他页（须走 external:setInbound 真起真停）');
  ok(!ADVANCED.includes('engine.capability_strict_fallback'),
    'C5 缺省关键 `engine.capability_strict_fallback` 不在高级区（专用三写法开关）');
  ok(!src.includes("invoke('settings:set', 'node.external_inbound'"),
    'C6 反证：本页不拿通用写口写 `node.external_inbound`');

  // zx_20261108_1 B5：写口统一收进 `saveSetting`（失败回滚 + 红条）。按**符号**重定向：
  //   ① `toggleAdvancedBool` 仍落 'true'/'false' 字面；② `saveSetting` 是本页唯一 `settings:set` 写口。
  const toggleAdvSrc = src.slice(src.indexOf('const toggleAdvancedBool'),
    src.indexOf('const commitPolicyNum'));
  ok(toggleAdvSrc.includes("on ? 'true' : 'false'")
    && src.includes("await invoke('settings:set', key, value)"),
    'C7 高级写口落 true/false 字面（与消费端 `boolSetting` 同口径；经统一写口 `saveSetting`）');
  ok(src.includes('for (const k of ADVANCED_BOOL_KEYS) adv[k] = boolSetting(all[k]);'),
    'C8 高级读口逐键过同一把 `boolSetting` 尺');
  ok(src.includes('高级设置') && src.includes('ADVANCED_BOOL_KEYS.length'),
    'C9 高级区上屏且条数由名单派生（不写死"26 项"）');
  ok(src.includes('<details className="mt-1">') && src.includes('展开高级开关'),
    'C10 默认折叠（谚语：不服务决策的开关先收起，但不藏没）');

  ok(src.includes('[settingsQuery, setSettingsQuery]')
    && /placeholder="搜索设置/.test(src),
    'C11 设置页有搜索框');
  eq([...SECTION_IDS].sort(), [...CARD_IDS, ...WRAP_IDS].sort(),
    'C12 分区关键词 id 与 `cardCls(...)`/`wrapCls(...)` 调用双向一致（无漏挂/无死键）');
  ok(SECTION_IDS.every((id) => new RegExp(`(?:'${id}'|\\b${id}):\\s*'[^']+'`).test(block('SECTION_KEYWORDS'))),
    'C13 每个分区都有非空关键词（否则永远搜不到）');
  ok(block('SECTION_KEYWORDS').includes('档位') && !block('SECTION_KEYWORDS').includes('档期'),
    'C14 档位词条无笔误（「档期」不冒充「档位」）');
  ok(src.includes('没有匹配的设置项'),
    'C15 搜不到时如实说「没有匹配」，不摆假结果');
}

function sectionD(): void {
  console.log('\n【D】档位差异兑现：升级理由复用既有真源，不新增价格/上限数字');
  ok(src.includes('usage.upgrade') || src.includes('usage?.upgrade'),
    'D1 档位用量差异（upgrade）上屏');
  ok(src.includes('upgradeLabel'),
    'D2 升级理由取自 main `tier-catalog` 的 `upgradeLabel`（非本页自造）');
  eq((src.match(/¥\s*\d/g) ?? []).length, 0,
    'D3 反证：本页不写死人民币价格字面量（币种/价格由 main 供）');
}

function sectionE(): void {
  console.log('\n【E】构建钉');
  const { tag } = deriveBuildTag(fs.readFileSync(
    path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/agent-executor.ts'), 'utf-8'));
  ok(buildNotOlderThan(tag, SELF_ROUND), 'E1 build 标识不早于脚本轮次（方向性派生）', `${tag} vs ${SELF_ROUND}`);
  checkBuildPins(ok, { rootDir: ROOT });

  // renderer chunk 内确有本批新增的落点（用户可见文案的第二落点）
  if (fs.existsSync(DIST)) {
    const blob = fs.readdirSync(DIST, { recursive: true })
      .map((f) => String(f)).filter((f) => f.endsWith('.js'))
      .map((f) => fs.readFileSync(path.join(DIST, f), 'utf-8')).join('\n');
    ok(blob.includes('高级设置'), 'E2 renderer 产物含「高级设置」');
    ok(blob.includes('展开高级开关'), 'E3 renderer 产物含高级区折叠入口');
  } else {
    ok(false, 'E2 renderer 产物缺失（须先跑 renderer build）', DIST);
  }
}

sectionA();
sectionB();
sectionC();
sectionD();
sectionE();

console.log(`\n[rr_${SELF_ROUND}_settings] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
