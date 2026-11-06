/**
 * zx_20261005 受控复跑 —— 批四「上手快」（安装向导 M14 / 示例任务库 M15 / 缺省凭据治理 M16）。
 *
 * 按实施排期逐批转绿（`RR_STAGE=Mn` 只要求 ≤Mn 的批次为绿，更晚的批次打 ⏳ 不计入失败；
 * `RR_STAGE` 为空 = 全部须绿，收口用）。批序见下方 `ORDER`。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §M14 判据（批四 / K-7）——「首启判据按状态，不按标志；两个向导各归其位」。
 *  ① `firstRunState` 真值表：`needsSetup = 无项目 ∧ 未真配 ANS`——**四格穷举**（G-2 两侧标本：
 *     只喂"该弹"的样本 ⇒ "无条件弹"也全票通过）；表未建 ⇒ 视为无项目（不把"查不动"当"有项目"吞掉引导）。
 *  ② 接线：`/onboarding`→`SetupPage`（阻塞）、`/preferences-wizard`→`PreferencesWizardPage`（可跳过）；
 *     `localStorage['wa_onboarded']` 读写两端**全仓清零**；`ProtectedRoute` 走 `setup:state`（不再读标志）。
 *  ③ 词表第二落点：renderer 产物**中文串**（标识符被 minify ⇒ 搜符号会假绿）。
 *
 * §M15 判据（批四）——「示例任务库开箱可见」：5 个模板在册（周报/TODO/批量改名/定时巡检/release notes）；
 *   种子由「表空才种」改为**逐 id `INSERT OR IGNORE`**——否则新增模板只对新库可见（增不改）。
 *
 * §M16 判据（批四）——「dev 缺省 vs 生产缺省是两套读取者」：`ANS_UNCONFIGURED` 凭据为空；
 *   `ansSeedCreds()` 与 `resolveAnsCreds` 尾端**依运行形态**给值；main 启动设一次形态开关；
 *   renderer `SettingsPage` **不再硬写** `dev-key`/`dev-secret`（那是 dev 缺省的第二落点）。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：firstRunState/ansSeedCreds/setAnsRuntimeMode/resolveAnsCreds 一律调生产导出。
 *   G-2 **两侧标本**：真值表四格 + 反证（旧"只看标志"的写法喂同表必分不清）。
 *   G-4 **不依赖真实墙钟/真实进程**：DB 与 env 皆为可注入替身。
 *   G-5 静态判据读**原文**（去注释在本仓是静默毁伤）——故本文件一律 `RD(...)`，不 `strip`。
 *   G-6 **无轮次字面量**：本轮方案路径与脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：判据引用的生产符号**全部静态导入** ⇒ 被删/改名即**编译期失败**（而非"扫了个空、静默假绿"）。
import { firstRunState } from '../apps/worker-ant-desktop/src/main/core/first-run.js';
import {
  ANS_DEFAULTS, ANS_UNCONFIGURED, ansSeedCreds, setAnsRuntimeMode, ansRuntimeIsDev,
  ansUserConfigured, ansCredentialsConfigured, resolveAnsCreds, type AnsCreds,
} from '../apps/worker-ant-desktop/src/main/core/ans-signed-request.js';
import { TASK_TEMPLATES } from '../apps/worker-ant-desktop/src/main/core/task-templates.js';

// ── 批次门（排期序）────────────────────────────────────────────────────────
const ORDER = ['M14', 'M15', 'M16'] as const;
type Batch = (typeof ORDER)[number];
const STAGE = (process.env.RR_STAGE || '').trim() as Batch | '';
const required = (b: Batch): boolean => STAGE === '' || ORDER.indexOf(b) <= ORDER.indexOf(STAGE);

let pass = 0; let fail = 0; let pending = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** 登记一条**受批次门管辖**的判据；未实施批次的判据**仍求值**（要的是"红为什么红"），只是不计入失败。 */
function crit(b: Batch, cond: boolean, label: string, detail?: string): void {
  if (!required(b)) { pending++; console.log(`  ⏳ [${b}] ${label}${cond ? ' —— **已提前为真**' : ''}`); return; }
  if (cond) { pass++; console.log(`  ✓ [${b}] ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ [${b}] ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** 等值断言（把实际值一并打出——红的时候要能立刻看出"差在哪"）。 */
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
/** 静态判据读**原文**（G-5：去注释在本仓是静默毁伤——"注释里写着有、代码里没有"正是要防的形态）。 */
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
/** 递归收集某目录下全部 `.ts`/`.tsx`（用于"零处残留"扫描面）。 */
function walkSrc(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkSrc(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/_onboard\.ts$/, ''); // zx_20261005

/* ── 可注入替身（G-4：不碰真库 / 真环境）────────────────────────────────────── */

/** 最小库替身：只答 `SELECT COUNT(*) … FROM wa_projects`；`'throw'` 模拟表未建。 */
function mkProjectDb(n: number | 'throw'): { prepare(sql: string): { get(): unknown } } {
  return {
    prepare(sql: string) {
      return {
        get() {
          if (sql.includes('wa_projects')) {
            if (n === 'throw') throw new Error('no such table: wa_projects');
            return { n };
          }
          return undefined;
        },
      };
    },
  };
}
/** 读 `wa_settings` 恒返回 undefined 的替身（⇒ `resolveAnsCreds` 走 env→缺省尾端）。 */
const emptySettingDb = { prepare: (_sql: string) => ({ get: (..._a: unknown[]) => undefined }) } as never;
/** 空 env——判据不碰真实进程环境（G-4）。 */
const NO_ENV = {} as NodeJS.ProcessEnv;

const DEV_CREDS: AnsCreds = { baseUrl: ANS_DEFAULTS.url, apiKey: ANS_DEFAULTS.apiKey, secretKey: ANS_DEFAULTS.secretKey };
const USER_CREDS: AnsCreds = { baseUrl: 'https://ans.example.com', apiKey: 'real-key', secretKey: 'real-secret' };

async function main(): Promise<void> {
  // ═══ M14 安装向导 + 偏好向导释名 ═══════════════════════════════════════════
  console.log('\n【M14-①】首启判据按**状态**（无项目 ∧ 未真配 ANS）——四格穷举 + 表未建');
  {
    eq(firstRunState(mkProjectDb(0), DEV_CREDS), { needsSetup: true, hasProject: false, ansUserConfigured: false },
      'M14-1a 空库 + 开发缺省身份 ⇒ **该弹**（干净机器上尚无项目、也还没真配 ANS）');
    eq(firstRunState(mkProjectDb(0), USER_CREDS), { needsSetup: false, hasProject: false, ansUserConfigured: true },
      'M14-1b 空库 + 用户真配 ANS ⇒ **不弹**（外部依赖已接通——"已配好 ⇒ 不再自动弹"）');
    eq(firstRunState(mkProjectDb(3), DEV_CREDS), { needsSetup: false, hasProject: true, ansUserConfigured: false },
      'M14-1c 已有 3 项目 + 开发缺省 ⇒ **不弹**（这台机器上跑起来过，引导无意义）');
    eq(firstRunState(mkProjectDb(3), USER_CREDS), { needsSetup: false, hasProject: true, ansUserConfigured: true },
      'M14-1d 有项目 ∧ 已配 ANS ⇒ 不弹（两侧皆真——防"只看一侧"的判据）');
    ok(firstRunState(mkProjectDb('throw'), DEV_CREDS).needsSetup === true,
      'M14-1e 表未建 ⇒ 视为"无项目"（首启真空库正是此态，**不把"查不动"当"有项目"吞掉引导**）');
    ok(firstRunState(null, USER_CREDS).needsSetup === false && firstRunState(null, DEV_CREDS).needsSetup === true,
      'M14-1f `db=null` 两侧：有真配身份 ⇒ 不弹；无 ⇒ 弹（与表未建同口径）');
    // 反证：旧写法（只看 localStorage 标志）对同一堆状态**分辨不出**——
    //   真值表里 1a 与 1c 的"标志"都可为假，但结论必须相反。用真值表自身的对照证明区分度。
    const a = firstRunState(mkProjectDb(0), DEV_CREDS).needsSetup;
    const c = firstRunState(mkProjectDb(3), DEV_CREDS).needsSetup;
    ok(a !== c, 'M14-1g ★反证：仅差"有无项目"两态给出**相反**结论（证明本条判据有区分度，非恒真）', `${a} vs ${c}`);
  }

  console.log('\n【M14-②】接线：两向导各归其位 + 首启标志清零');
  {
    const APP = RD(`${A}/renderer/src/App.tsx`);
    crit('M14', /lazy\(\(\) => import\('\.\/pages\/SetupPage'\)\)/.test(APP),
      'M14-2a App.tsx 懒加载 `SetupPage`（真·安装向导）');
    crit('M14', /lazy\(\(\) => import\('\.\/pages\/PreferencesWizardPage'\)\)/.test(APP),
      'M14-2b App.tsx 懒加载 `PreferencesWizardPage`（原 `OnboardingPage` 更名）');
    crit('M14', /path="\/onboarding"\s+element=\{<SetupPage\s*\/>\}/.test(APP),
      'M14-2c `/onboarding` 路由 → `SetupPage`（**阻塞式**安装向导）');
    crit('M14', /path="\/preferences-wizard"\s+element=\{<PreferencesWizardPage\s*\/>\}/.test(APP),
      'M14-2d `/preferences-wizard` 路由 → `PreferencesWizardPage`（**可跳过**偏好问卷）');
    crit('M14', /needsSetup/.test(APP) && !/wa_onboarded/.test(APP),
      'M14-2e `ProtectedRoute` 走 `needsSetup`（状态）且**不再**读 `wa_onboarded`（标志）');

    // 读写两端全仓清零：扫描整个 renderer/src。
    const rFiles = walkSrc(path.join(root, A, 'renderer/src'));
    const strayFlag = rFiles.filter((f) => RD(path.relative(root, f)).includes('wa_onboarded'));
    eq(strayFlag.map((f) => path.relative(root, f)), [],
      'M14-2f ★`localStorage[\'wa_onboarded\']` 全仓**零处**（读端 App.tsx / 写端问卷 两端皆清）');

    crit('M14', !fs.existsSync(path.join(root, A, 'renderer/src/pages/OnboardingPage.tsx')),
      'M14-2g 旧 `OnboardingPage.tsx` 文件已消失（更名而非新增副本）');
    crit('M14', fs.existsSync(path.join(root, A, 'renderer/src/pages/PreferencesWizardPage.tsx')),
      'M14-2h `PreferencesWizardPage.tsx` 在位');
    const pp = RD(`${A}/renderer/src/pages/PreferencesWizardPage.tsx`);
    crit('M14', /export default function PreferencesWizardPage/.test(pp),
      'M14-2i 组件名同步更名（导出即 `PreferencesWizardPage`）');
    crit('M14', !/localStorage\.setItem\('wa_onboarded'/.test(pp),
      'M14-2j 偏好问卷**不再写** `wa_onboarded`（跳过与提交都不写）');

    // 链接改向：指向偏好问卷，不是安装向导。
    const PREFP = RD(`${A}/renderer/src/pages/PreferencesPage.tsx`);
    crit('M14', (PREFP.match(/to="\/preferences-wizard"/g) || []).length === 2 && !/to="\/onboarding"/.test(PREFP),
      'M14-2k `PreferencesPage` 两处入口皆指 `/preferences-wizard`，**零**处指向 `/onboarding`');

    // IPC 接线（main 注册 + 通道名 + renderer 读出）。
    const MI = RD(`${A}/src/main/index.ts`);
    // zx_20261012_1 批四：`initSetupIpc` 签名由 `(db)` 扩为 `(db, dataDir)`（示例项目需数据根）
    //   ⇒ 判据同步**钉强**到新形状（钉两个实参），非放宽。
    crit('M14', /initSetupIpc\(\s*db\s*,\s*dataDir\s*\)/.test(MI), 'M14-2l main 启动接线 `initSetupIpc(db, dataDir)`');
    crit('M14', /ipcMain\.handle\('setup:state'/.test(RD(`${A}/src/main/ipc/setup.ipc.ts`)),
      'M14-2m `setup.ipc.ts` 提供 `setup:state` 通道');
    crit('M14', /'setup:state'/.test(RD(`${A}/renderer/src/lib/firstRun.ts`)),
      'M14-2n renderer `lib/firstRun.ts` 经 `setup:state` 读（真源在 main，渲染层不自判）');
    crit('M14', !/from 'electron'/.test(RD(`${A}/src/main/core/first-run.ts`)),
      'M14-2o 反证：`core/first-run.ts` **零 electron 依赖**（故本套件能直跑真实现）');
  }

  console.log('\n【M14-③】词表第二落点：中文可见串真打进 renderer 产物（搜符号会假绿）');
  {
    const assetsDir = path.join(root, A, 'renderer/dist/assets');
    const pick = (re: RegExp): string => {
      const chunks = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter((f) => re.test(f)) : [];
      return chunks.length === 1 ? fs.readFileSync(path.join(assetsDir, chunks[0]!), 'utf-8') : '';
    };
    const setupJs = pick(/^SetupPage-.*\.js$/);
    crit('M14', setupJs !== '', 'M14-3a renderer 产物恰 1 份 `SetupPage-*.js`（本判据须 renderer 先 build）',
      setupJs ? 'ok' : 'renderer/dist/assets 无 SetupPage chunk（未经 build ⇒ 本判据无法成立）');
    crit('M14', setupJs.includes('欢迎使用工蚁') && setupJs.includes('跑出第一个成果'),
      'M14-3b **上屏到产物**：安装向导中文串在产物内（标题 / 漏斗靶心）——"只写在源码、没打进 GUI"在此必红',
      `欢迎使用工蚁=${setupJs.includes('欢迎使用工蚁')} · 跑出第一个成果=${setupJs.includes('跑出第一个成果')}`);
    const pwJs = pick(/^PreferencesWizardPage-.*\.js$/);
    crit('M14', pwJs !== '' && pwJs.includes('偏好设置向导'),
      'M14-3c 偏好问卷**没被更名弄丢**：产物内仍有"偏好设置向导"（两个向导并存，非替换）',
      pwJs ? `偏好设置向导=${pwJs.includes('偏好设置向导')}` : 'PreferencesWizardPage chunk 缺席');
  }

  // ═══ M15 开发者示例任务库 ══════════════════════════════════════════════════
  console.log('\n【M15】开发者示例任务库（5 个开箱模板 + 逐 id 幂等种子）');
  {
    const NEW_IDS = ['weekly_report', 'todo_scan', 'batch_rename', 'scheduled_inspection', 'release_notes'];
    const missing = NEW_IDS.filter((id) => !TASK_TEMPLATES[id]);
    eq(missing, [], 'M15-1 五个开发者示例模板全部在册（周报/TODO扫描/批量改名/定时巡检/release notes）');
    const thin = NEW_IDS.filter((id) => {
      const t = TASK_TEMPLATES[id];
      return !t || !Array.isArray(t.subtasks) || t.subtasks.length < 2 || !Array.isArray(t.keywords) || t.keywords.length === 0;
    });
    eq(thin, [], 'M15-2 每个模板都有 ≥2 子任务且关键词非空（否则"模板"只是个空壳名字）');
    // 每个模板至少有一个**中文**关键词（开箱用户用中文描述任务也能命中）。
    const noCn = NEW_IDS.filter((id) => !(TASK_TEMPLATES[id]?.keywords || []).some((k) => /[一-龥]/.test(k)));
    eq(noCn, [], 'M15-3 每个模板含中文关键词（中文用户描述任务可命中——与 TemplatesPage 可见一致）');

    // 种子：由「表空才种」改为**逐 id INSERT OR IGNORE**（增不改）。
    const DB = RD(`${A}/src/main/database.ts`);
    crit('M15', /INSERT OR IGNORE INTO wa_task_templates/.test(DB),
      'M15-4 ★种子改为 `INSERT OR IGNORE`（增量补种）——否则新增模板只对新库可见，老库永远补不上');
    crit('M15', /for \(const tpl of Object\.values\(TASK_TEMPLATES\)\)/.test(DB) && !/tplCount === 0/.test(DB),
      'M15-5 ★种子遍历 `Object.values(TASK_TEMPLATES)` 且**已撤**"表空才种"的闸（`tplCount === 0` 不在）');
    crit('M15', /source,\s*$/.test(DB) || /'system'/.test(DB),
      'M15-6 种子行标 `source=\'system\'`（系统模板：可编辑/禁用但不可删——与 TemplatesPage 口径一致）');
  }

  // ═══ M16 缺省凭据治理 ══════════════════════════════════════════════════════
  console.log('\n【M16】dev 缺省 vs 生产缺省（两套读取者，最容易漏的一处）');
  {
    eq({ apiKey: ANS_UNCONFIGURED.apiKey, secretKey: ANS_UNCONFIGURED.secretKey }, { apiKey: '', secretKey: '' },
      'M16-1 `ANS_UNCONFIGURED` 凭据为**空串**（生产不内置 dev-key/dev-secret）');
    eq(ANS_UNCONFIGURED.url, ANS_DEFAULTS.url,
      'M16-2 生产保留缺省 URL（连本机还是远端是用户可后改的），但**绝不**内置开发凭据');
    eq(ansUserConfigured(DEV_CREDS), false,
      'M16-3 `ansUserConfigured(dev 缺省)` === false —— 首启判据据此把"吃内置缺省"与"用户真配"分开');
    eq(ansUserConfigured({ baseUrl: ANS_UNCONFIGURED.url, apiKey: '', secretKey: '' }), true,
      'M16-4 空凭据 ≠ dev 缺省 ⇒ `ansUserConfigured` 为真（口径是"偏离缺省"，不是"非空"）');
    eq([ansCredentialsConfigured({ baseUrl: 'x', apiKey: '', secretKey: '' }), ansCredentialsConfigured(DEV_CREDS)],
      [false, true], 'M16-5 `ansCredentialsConfigured` 三态：空凭据=未配置；dev 缺省=已配置（非空即可签）');

    // 运行形态开关：默认 dev（rr/单测零行为变化），生产由 main 显式设 false。
    ok(ansRuntimeIsDev() === true, 'M16-6 缺省为**开发形态**（rr/单测未初始化时零行为变化）');
    try {
      setAnsRuntimeMode(false);
      eq([ansSeedCreds().apiKey, ansSeedCreds().secretKey], ['', ''],
        'M16-7★ 生产形态下 `ansSeedCreds()` 种子**空凭据**——否则老库 `wa_settings` 里永久躺着 dev-key，顶掉尾端开关');
      const prod = resolveAnsCreds(emptySettingDb, NO_ENV);
      eq([prod.apiKey, prod.secretKey], ['', ''],
        'M16-8★ 生产形态下 `resolveAnsCreds` 尾端为**未配置**（缺身份 ⇒ 调用方如实报"未配置"，不拿 dev-key 撞 401）');
      eq(prod.baseUrl, ANS_DEFAULTS.url, 'M16-9 生产形态仍保留缺省 URL（仅凭据为空）');
    } finally { setAnsRuntimeMode(true); }
    const dev = resolveAnsCreds(emptySettingDb, NO_ENV);
    eq([dev.apiKey, dev.secretKey], [ANS_DEFAULTS.apiKey, ANS_DEFAULTS.secretKey],
      'M16-10 开发形态下 `resolveAnsCreds` 尾端回到 dev 缺省（dev 保持不变——K-7/M16 要求）');
    ok(ansRuntimeIsDev() === true, 'M16-11 形态开关已还原为 dev（不把本套件的副作用漏给后续判据）');

    // 接线：main 启动设一次形态。
    crit('M16', /setAnsRuntimeMode\(isDev\)/.test(RD(`${A}/src/main/index.ts`)),
      'M16-12 main 启动 `setAnsRuntimeMode(isDev)` 设一次（全仓 12 处 `resolveAnsCreds` 同受其管）');
    crit('M16', /ansSeedCreds\(\)/.test(RD(`${A}/src/main/database.ts`)),
      'M16-13 首启写库经 `ansSeedCreds()`（与尾端**同源**，写进去的与读出来签名的不会漂）');

    // renderer 第二落点：SettingsPage 不再硬写 dev-key/dev-secret。
    const SET = RD(`${A}/renderer/src/pages/SettingsPage.tsx`);
    crit('M16', !/'dev-key'/.test(SET) && !/'dev-secret'/.test(SET),
      'M16-14 ★renderer `SettingsPage` **零处**硬写 `dev-key`/`dev-secret`（此前 `|| \'dev-key\'` 兜底会把开发凭据预填给生产用户）');
    crit('M16', /ansApi\.status\(\)/.test(SET) && /尚未配置 ANS 凭据/.test(SET),
      'M16-15 renderer 读 `ans:status` 并**三态如实上屏**（未配置 ⇒ 引导，不把缺身份当"服务没起"）');
    const assetsDir = path.join(root, A, 'renderer/dist/assets');
    const setChunks = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter((f) => /^SettingsPage-.*\.js$/.test(f)) : [];
    const setJs = setChunks.length === 1 ? fs.readFileSync(path.join(assetsDir, setChunks[0]!), 'utf-8') : '';
    crit('M16', setJs.includes('尚未配置 ANS 凭据'),
      'M16-16 **上屏到产物**：三态引导中文串真进了 SettingsPage 产物（"只写在源码、没打进 GUI"在此必红）',
      setJs ? `尚未配置 ANS 凭据=${setJs.includes('尚未配置 ANS 凭据')}` : 'SettingsPage chunk 缺席');
  }

  // ═══ S 哑雷自检 + build 钉 ═════════════════════════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量；**不受批次门管辖**）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 ★方向性自指（由载体自身派生，非抄来的常量）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}_onboard.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}_onboard.ts`);

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261005_onboard 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261005_onboard: ${pass} 通过 / ${fail} 失败${pending ? ` / ${pending} 待实施(不计入)` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
});
