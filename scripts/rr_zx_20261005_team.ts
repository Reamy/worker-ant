/**
 * zx_20261005 受控复跑 —— 批六「Team 档软闸」（多机协同 / 设备发现 / 设备控制）。
 *
 * 背景：`business-plan/materials/open-source-scope.md` 早已声明「团队协作/企业特性＝闭源商业许可」，
 *   但 zx_20261004 把三块能力**实打实落进本仓且毫无闸门**。三块横切 core+IPC+renderer+启动接线，
 *   路径排除会留悬空 import ⇒ 不能靠 `publish-oss.ts` 出仓。故裁定 A 方案：**留仓 + Team 档软闸**。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §M22 判据（批六）——「Team 档软闸」（管子·度量衡 / 维特根斯坦·同一把尺）。
 *   **一处真源** `core/team-gate.ts`（零 electron，rr 直跑）：`resolveTeamGate` / `teamFeatureRefusal`。
 *   解锁 ⇔ 生效档位为 Team **或** 试用期内（`kind === 'trial'`）——试用授予档由价目表
 *   `trial.grantsTier` 宣称（zx_20261027_3 M3 起为 team），故判据仍**特判 kind**，
 *   不只看 `tier === 'team'`（否则将来换授予档即被误锁，与裁定相反）。
 *   三态**两侧标本**：无许可/Pro（非试用）⇒ 锁；试用/Team ⇒ 放行。
 *   三处接线（index.ts 启动 / nodes.ipc / devices.ipc / tools/device.ts）各**只调它**，不另写档位判断。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：判据一律调生产导出，不在测试里复刻一份"等价物"。
 *   G-2 **两侧标本**：Pro 许可（非试用）必锁、试用必放——单侧标本任何过宽变体都全票通过。
 *   G-3 计数器类断言不适用（本模块无计数器）；接线断言一律读**原文形状**。
 *   G-4 **不依赖真实墙钟**：`now`/`fingerprint` 一律注入。
 *   G-5 静态判据读**原文**（去注释在本仓是静默毁伤）——故本文件一律 `RD(...)`，不 `strip`。
 *   G-6 **无轮次字面量**：本轮方案路径与脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：判据引用的生产符号**全部静态导入** ⇒ 被删/改名即**编译期失败**（而非"扫了个空、静默假绿"）。
import { TIER_LABEL } from '../apps/worker-ant-desktop/src/main/core/feature-limits.js';
import {
  LICENSE_SETTING_KEYS, encodeLicense, type LicensePayload, type LicenseSettingDb,
} from '../apps/worker-ant-desktop/src/main/core/license.js';
import {
  TEAM_FEATURES, TEAM_FEATURE_LABEL, resolveTeamGate, teamFeatureRefusal,
} from '../apps/worker-ant-desktop/src/main/core/team-gate.js';
// zx_20261010 M7：起心跳/中转的**第二道闸**（本机已注册）——生产判据静态导入（G-1，被删/改名即编译期失败）。
import { isNodeEnrolled } from '../apps/worker-ant-desktop/src/main/core/node-heartbeat.js';
import {
  NODE_SETTING_KEYS, ensureNodeIdentity, writeNodeSetting, type NodeSettingDb,
} from '../apps/worker-ant-desktop/src/main/core/node-identity.js';
// zx_20261027_3 M3「试得真」：试用授予档以价目表为真源（`trial.grantsTier`），本脚本按它派生期望。
import { tierCatalog } from '../apps/worker-ant-desktop/src/main/core/tier-catalog.js';

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
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

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/_[a-z]+\.ts$/, ''); // zx_20261005

/* ── 夹具 ────────────────────────────────────────────────────────────────── */

/** 许可夹具：`wa_settings` 单表（`resolveLicenseState` 的真读面）。DDL 与生产 `database.ts` 同形。 */
function licDb(settings: Record<string, string> = {}): LicenseSettingDb {
  const d = new DatabaseSync(':memory:');
  d.exec("CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))");
  for (const [k, v] of Object.entries(settings)) d.prepare('INSERT INTO wa_settings (key,value) VALUES (?,?)').run(k, v);
  return d as unknown as LicenseSettingDb;
}

/** 测试密钥对（**在内存里现生成**，不落盘、不入库）——用来签一段真许可。 */
const TEST_KEYS = crypto.generateKeyPairSync('ed25519');
const TEST_PRIVATE_PEM = TEST_KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const TEST_PUBLIC_PEM = TEST_KEYS.publicKey.export({ type: 'spki', format: 'pem' }) as string;

const NOW = new Date('2026-10-05T00:00:00.000Z');
const FP = 'AAAA-BBBB-CCCC-DDDD';
// zx_20261029_2 M6：Team 件**带到期**（生产签发形状）——`verifyLicense` 现已拒永久 Team；
//   固定写远期（不随墙钟漂）以免断言只在某时间窗为真。
const payload = (over: Partial<LicensePayload> = {}): LicensePayload => ({
  v: 1, tier: 'team', subject: '测试被许可人', issuedAt: '2026-10-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', devices: [], ...over,
});
const sign = (p: LicensePayload): string => encodeLicense(p, TEST_PRIVATE_PEM);

function main(): void {
  // ═══ M22 判据三态两侧 ═══════════════════════════════════════════════════════
  console.log('\n【M22】Team 档软闸（管子·度量衡：一把可比的尺 / 维特根斯坦·同一把尺）');
  {
    // ── 锁的一侧：无许可 ──
    const gNone = resolveTeamGate(licDb(), { now: NOW, fingerprint: FP });
    eq([gNone.unlocked, gNone.tier], [false, 'community'],
      'M22-1 无许可 ⇒ 锁定 + community（缺许可即社区版，三能力不可用）');
    const refNone = teamFeatureRefusal(licDb(), 'multi_node', { now: NOW, fingerprint: FP });
    ok(!!refNone && refNone.includes(TIER_LABEL.community),
      'M22-2 ★拒因**如实**：含档位名（由 `TIER_LABEL` 真源派生，不抄字面量）', refNone ?? '');

    // ── 开的一侧之一：试用期（zx_20261027_3 M3 起授予档落 `trial.grantsTier`；判据仍特判 kind） ──
    const trialDb = licDb({ [LICENSE_SETTING_KEYS.trialStartedAt]: new Date(NOW.getTime() - 86_400_000).toISOString() });
    const gTrial = resolveTeamGate(trialDb, { now: NOW, fingerprint: FP });
    eq([gTrial.unlocked, gTrial.tier], [true, tierCatalog().trial.grantsTier],
      'M22-3 ★★试用中（kind=trial、tier＝价目表宣称的授予档）⇒ **放行**（判据仍特判 kind，不随档位字样漂移）');
    eq(teamFeatureRefusal(trialDb, 'device_control', { now: NOW, fingerprint: FP }), null,
      'M22-4 ★试用放行证：`teamFeatureRefusal` 返回 null（试用＝团队版能力，本轮明令放行）');

    // ── 开的一侧之二：Team 许可 ──
    const teamDb = licDb({ [LICENSE_SETTING_KEYS.key]: sign(payload({ tier: 'team' })) });
    const gTeam = resolveTeamGate(teamDb, { now: NOW, fingerprint: FP, publicKeyPem: TEST_PUBLIC_PEM });
    eq([gTeam.unlocked, gTeam.tier], [true, 'team'],
      'M22-5 Team 许可 ⇒ 放行（解锁档位＝Team，取自许可载荷）');

    // ── ★★锁的**另一侧**：Pro 许可（非试用）——证明"只有 Team 解"，不是"非社区即可" ──
    const proDb = licDb({ [LICENSE_SETTING_KEYS.key]: sign(payload({ tier: 'pro' })) });
    const gPro = resolveTeamGate(proDb, { now: NOW, fingerprint: FP, publicKeyPem: TEST_PUBLIC_PEM });
    eq([gPro.unlocked, gPro.tier], [false, 'pro'],
      'M22-6 ★★两侧标本：Pro 许可（非试用）⇒ **锁定**（若判据写成"非 community 即放行"，这条即红）');
    // zx_20261029_2 M6：`device_discovery` 已移往 Pro 闸；此处改钉 Team 的 `device_control`（同一意图：Pro 被拒且文案含当前档位）。
    const refPro = teamFeatureRefusal(proDb, 'device_control', { now: NOW, fingerprint: FP, publicKeyPem: TEST_PUBLIC_PEM });
    ok(!!refPro && refPro.includes(TIER_LABEL.pro),
      'M22-7 拒因指向**当前**档位（Pro 的被拒文案含"专业版"，不拿团队版文案糊弄）', refPro ?? '');

    // 软闸 fail-open：无库不 throw（承 `resolveLicenseState` 的 fail-open＝退 community＝锁定，非"打不开"）。
    const gNull = resolveTeamGate(null, { now: NOW, fingerprint: FP });
    eq([gNull.unlocked, gNull.tier], [false, 'community'], 'M22-8 无库 ⇒ 不 throw，退 community 锁定（fail-open 方向与 K-3 一致）');
  }

  // ═══ M22 词表 ═══════════════════════════════════════════════════════════════
  {
    // zx_20261014_4 批三：「门」（**外部终端接入**）属 Team 档 ⇒ 词表 3→4；
    // zx_20261017_1 批二：**审计视图**属 Team 档 ⇒ 词表 4→5；批六：**团队共享库** ⇒ 5→6；
    // zx_20261018_3 批七：**审计导出** ⇒ 6→7。
    // zx_20261022_3 批八：**项目画像共享** ⇒ 7→8（只闸"搬运"，本机生成/注入不挂闸）。
    //   **按新载体重定向**（逐成员枚举 + 逐成员人话名，**不放宽**）：新增一员即须同时在
    //   `TEAM_FEATURE_LABEL` 补人话名、穷举其接线与面板落点（承 feedback_retarget_assertions_to_stronger_source；
    //   G-5 读**原文**）。原来是"恰三项"的幻数计数——换成逐成员枚举后，加/删任一员都红。
    // zx_20261029_2 M6：`device_discovery` **移出** Team 词表（归 Pro）；此处逐成员核对 8→7。
    const TEAM_MEMBERS = ['multi_node', 'device_control', 'external_terminal', 'audit_view', 'audit_export', 'team_library', 'project_profile_share'] as const;
    eq([...TEAM_FEATURES], [...TEAM_MEMBERS],
      'M22-9 ★能力词表**逐成员枚举**（唯一定义处；新增一员须补人话名 + 穷举接线/面板落点）');
    for (const f of TEAM_MEMBERS) {
      ok(TEAM_FEATURES.includes(f), `M22-9b 词表含 ${f}`);
      ok(typeof TEAM_FEATURE_LABEL[f] === 'string' && TEAM_FEATURE_LABEL[f].length > 0,
        `M22-10 人话名非空：${f} ⇒ 「${TEAM_FEATURE_LABEL[f]}」`);
    }
  }

  // ═══ M22 接线形状（读原文，G-5）══════════════════════════════════════════════
  {
    const IDX = RD(`${A}/src/main/index.ts`);
    const NIPC = RD(`${A}/src/main/ipc/nodes.ipc.ts`);
    const DIPC = RD(`${A}/src/main/ipc/devices.ipc.ts`);
    const DTOOL = RD(`${A}/src/main/core/tools/device.ts`);

    // ── 启动接线：算一次档位，注册块与心跳块复用同一结果 ──
    eq((IDX.match(/resolveTeamGate\(db\)/g) ?? []).length, 1,
      'M22-11 `index.ts` 档位**算一次**（`resolveTeamGate(db)` 恰一次——心跳块复用同结果，不重算）');
    ok(/teamGate\?\.unlocked/.test(IDX),
      'M22-12 心跳/中转块复用同一档位结果（`teamGate?.unlocked`——一处真源不裂成两份）');
    ok(IDX.indexOf('resolveTeamGate(db)') >= 0 && IDX.indexOf('resolveTeamGate(db)') < IDX.indexOf('ensureNodeEnrolled(db'),
      'M22-13 ★**先判档位后注册**：`resolveTeamGate` 出现在 `ensureNodeEnrolled(db` 之前（锁定即不注册为节点）');
    ok(IDX.indexOf('teamGate?.unlocked') >= 0 && IDX.indexOf('teamGate?.unlocked') < IDX.indexOf('startNodeHeartbeat(db'),
      'M22-14 ★**先判档位后心跳**：`teamGate?.unlocked` 出现在 `startNodeHeartbeat(db` 之前（锁定即不心跳/不消费中转）');

    // ── nodes IPC：动作出口各一道闸 + 两个只读出口带 gate ──
    // zx_20261010_1 M2 起动作出口 1→3（update / enroll / request-token）；zx_20261011 M4 再 +1（dispatch）；
    //   zx_20261011_1 M4 再 +1（answer-question，作答写口与派发同闸）；zx_20261011_3 再 +1（delete，删离线节点写口同闸）；
    //   zx_20261018_1 批一再 +1（confirm-auto-dispatch，首次入网引导的**写口**——写"建单即派"设置，同属 multi_node）
    //   ——**重定向到新真源**（与设备出口同一范式），
    //   非放宽：逐 handler 取体核闸、逐成员枚举回码，新增写口漏闸即红（承 feedback_retarget_assertions_to_stronger_source）。
    //   zx_20261030_1 M3 再 +1（request-cancel，叫停是协同动作，同属 multi_node——此前漏登，本套件首跑即红）。
    const NODE_GATED = ['nodes:update', 'nodes:enroll', 'nodes:request-token', 'nodes:dispatch', 'nodes:answer-question', 'nodes:delete', 'nodes:confirm-auto-dispatch', 'nodes:request-cancel'];
    const nodeBodyOf = (h: string): string => {
      const i = NIPC.indexOf(`ipcMain.handle('${h}'`);
      if (i < 0) return '';
      const j = NIPC.indexOf('ipcMain.handle(', i + 10);
      return NIPC.slice(i, j < 0 ? NIPC.length : j);
    };
    const nodeGateOf = (h: string): boolean => nodeBodyOf(h).includes("teamFeatureRefusal(licDb, 'multi_node')");
    ok(NODE_GATED.every(nodeGateOf),
      'M22-15 ★nodes **动作出口各一道闸**（update / enroll / request-token / dispatch / answer-question / delete——漏一处＝可绕过的尺）',
      NODE_GATED.map((h) => `${h}=${nodeGateOf(h)}`).join(' · '));
    // 逐成员枚举（非幻数计数）：每道动作闸的 handler 体内**各自**回 `TEAM_REQUIRED`；
    //   另以 `NODE_GATED.length` **派生**总数核对（不留"本轮为真、下一轮必假"的字面量）。
    ok(NODE_GATED.every((h) => nodeBodyOf(h).includes("code: 'TEAM_REQUIRED'")),
      'M22-16 ★每道动作闸**逐 handler 如实回** `TEAM_REQUIRED`（钉 `code:` 调用形状，避开注释里的裸词）',
      NODE_GATED.map((h) => `${h}=${nodeBodyOf(h).includes("code: 'TEAM_REQUIRED'")}`).join(' · '));
    eq((NIPC.match(/code: 'TEAM_REQUIRED'/g) ?? []).length, NODE_GATED.length,
      'M22-16b 回码总数＝动作出口数（由 `NODE_GATED.length` 派生——多一处（漏闸仍有回码）或少一处（闸内不回码）皆红）');
    // zx_20261030_1 M4：`nodes:cluster` 也是只读出口（同一把尺：锁定即不触 ANS）⇒ 逐出口枚举，非幻数。
    const NODE_READ_GATED = ['nodes:list', 'nodes:card', 'nodes:cluster'];
    ok(NODE_READ_GATED.every((h) => nodeBodyOf(h).includes('resolveTeamGate(licDb)')),
      'M22-17 `nodes:list` / `nodes:card` / `nodes:cluster` **各算一次** gate（只读出口带 gate；锁定即不触 ANS）',
      NODE_READ_GATED.map((h) => `${h}=${nodeBodyOf(h).includes('resolveTeamGate(licDb)')}`).join(' · '));
    eq((NIPC.match(/resolveTeamGate\(licDb\)/g) ?? []).length, NODE_READ_GATED.length,
      'M22-17b gate 计算总数＝只读出口数（由枚举派生——多一处（白算）或少一处（漏带 gate）皆红）');

    // ── devices IPC：动作出口各一道闸 + 只读出口带 gate ──
    // zx_20261017_1 批八重定向（承 feedback_retarget_assertions_to_stronger_source：改钉更强的新真源，不放宽）：
    //   三方云同步口 `devices:cloud_sync` 同属 Team「设备发现」⇒ 动作出口 3→4。
    //   zx_20261018_1 批五再 +1：意图计划的**执行跳** `devices:intent_execute`（认领即写 `wa_intent_plans`、
    //   逐步下发控制）同属 Team「设备控制」⇒ 4→5。
    //   由幻数计数改为**逐 handler 枚举 + 逐 handler 核对档位映射**（多一处漏闸 / 映射错档皆红）。
    //   zx_20261023_5 批三再 +1：`devices:miio_token` 的**写**支（落凭据、开控制通道）同属 Team「设备控制」；
    //   只读支（查"有没有/是否密文"）不设闸——故该 handler 体里恰出现一次闸。⇒ 5→6。
    // zx_20261029_2 M6「阶梯」：拆成两组——**发现/云同步归 Pro**（`device_discovery`，回 `PRO_REQUIRED`），
    //   **授权/控制/意图执行/token 写口归 Team**（`device_control`，回 `TEAM_REQUIRED`）。
    //   两组各自逐 handler 枚举 + 逐条核对闸函数与回码，不合并成一句"设备能力"。
    const DEVICE_TEAM_GATED: Array<[string, string]> = [
      ['devices:authorize', 'device_control'],
      ['devices:control', 'device_control'],
      ['devices:intent_execute', 'device_control'],
      ['devices:miio_token', 'device_control'],
    ];
    const DEVICE_PRO_GATED: Array<[string, string]> = [
      ['devices:discover', 'device_discovery'],
      ['devices:cloud_sync', 'device_discovery'],
    ];
    const deviceBodyOf = (h: string): string => {
      const i = DIPC.indexOf(`ipcMain.handle('${h}'`);
      if (i < 0) return '';
      const j = DIPC.indexOf('ipcMain.handle(', i + 10);
      return DIPC.slice(i, j < 0 ? DIPC.length : j);
    };
    const deviceTeamGateOf = (h: string, f: string): boolean => deviceBodyOf(h).includes(`teamFeatureRefusal(licDb, '${f}')`);
    const deviceProGateOf = (h: string, f: string): boolean => deviceBodyOf(h).includes(`proFeatureRefusal(licDb, '${f}')`);
    ok(DEVICE_TEAM_GATED.every(([h, f]) => deviceTeamGateOf(h, f)),
      'M22-18 ★设备**控制**出口逐 handler 枚举且映射 Team 闸（authorize/control/intent_execute/miio_token→device_control）',
      DEVICE_TEAM_GATED.map(([h, f]) => `${h}=${deviceTeamGateOf(h, f)}`).join(' · '));
    ok(DEVICE_PRO_GATED.every(([h, f]) => deviceProGateOf(h, f)),
      'M22-18c ★设备**发现**出口逐 handler 枚举且映射 Pro 闸（discover/cloud_sync→device_discovery）',
      DEVICE_PRO_GATED.map(([h, f]) => `${h}=${deviceProGateOf(h, f)}`).join(' · '));
    eq((DIPC.match(/teamFeatureRefusal\(/g) ?? []).length, DEVICE_TEAM_GATED.length,
      'M22-18b Team 闸总数＝枚举出的控制出口数（多一处漏闸仍回码 / 少一处闸内不回码皆红）');
    eq((DIPC.match(/proFeatureRefusal\(/g) ?? []).length, DEVICE_PRO_GATED.length,
      'M22-18d Pro 闸总数＝枚举出的发现出口数（同上，由枚举派生）');
    ok(DEVICE_TEAM_GATED.every(([h]) => deviceBodyOf(h).includes("code: 'TEAM_REQUIRED'")),
      'M22-19 ★每道设备控制闸**逐 handler 如实回** `TEAM_REQUIRED`（钉 `code:` 调用形状）',
      DEVICE_TEAM_GATED.map(([h]) => `${h}=${deviceBodyOf(h).includes("code: 'TEAM_REQUIRED'")}`).join(' · '));
    eq((DIPC.match(/code: 'TEAM_REQUIRED'/g) ?? []).length, DEVICE_TEAM_GATED.length,
      'M22-19b 回码总数＝设备控制出口数（由枚举派生）');
    ok(DEVICE_PRO_GATED.every(([h]) => deviceBodyOf(h).includes("code: 'PRO_REQUIRED'")),
      'M22-19c ★每道设备发现闸**逐 handler 如实回** `PRO_REQUIRED`',
      DEVICE_PRO_GATED.map(([h]) => `${h}=${deviceBodyOf(h).includes("code: 'PRO_REQUIRED'")}`).join(' · '));
    eq((DIPC.match(/code: 'PRO_REQUIRED'/g) ?? []).length, DEVICE_PRO_GATED.length,
      'M22-19d Pro 回码总数＝设备发现出口数（由枚举派生）');
    // zx_20261023_5 批三：只读出口 +2（渠道目录 / 渠道预检向导要用 gate 决定"列不列"）⇒
    //   由幻数 1 改为**逐只读出口枚举**：每个都算一次 gate，且总数与枚举数相等（多一处漏算/少一处多算皆红）。
    const DEVICE_GATE_READERS = ['devices:list', 'devices:channels', 'devices:channel_auth'];
    ok(DEVICE_GATE_READERS.every((h) => deviceBodyOf(h).includes('resolveTeamGate(licDb)')),
      'M22-20 只读出口逐 handler 枚举：台账/渠道目录/渠道预检各回 `gate`（照常可见，另带升级提示）',
      DEVICE_GATE_READERS.map((h) => `${h}=${deviceBodyOf(h).includes('resolveTeamGate(licDb)')}`).join(' · '));
    eq((DIPC.match(/resolveTeamGate\(licDb\)/g) ?? []).length, DEVICE_GATE_READERS.length,
      'M22-20b gate 计算总数＝只读出口枚举数（由枚举派生）');
    // zx_20261029_2 M6：同样三个只读出口**另带 Pro 闸**（面板分别显示"看不了/动不了"）。
    ok(DEVICE_GATE_READERS.every((h) => deviceBodyOf(h).includes('resolveProGate(licDb)')),
      'M22-20c 只读出口逐 handler 枚举：台账/渠道目录/渠道预检各回 `discoveryGate`（Pro 闸）',
      DEVICE_GATE_READERS.map((h) => `${h}=${deviceBodyOf(h).includes('resolveProGate(licDb)')}`).join(' · '));
    eq((DIPC.match(/resolveProGate\(licDb\)/g) ?? []).length, DEVICE_GATE_READERS.length,
      'M22-20d Pro gate 计算总数＝只读出口枚举数（由枚举派生）');

    // ── 工具体：闸在入口，K-6 编排不动 ──
    // zx_20261018_1 批五：新增 `device_intent` 工具（意图落计划并立即执行）——同为 Team「设备控制」写口
    //   ⇒ 逐工具枚举 1→2（不改幻数：新增写口工具漏闸即红）。
    const TOOL_GATED = ['device_control', 'device_intent'] as const;
    // 取**单个工具**的体（从 `xxx: {` 到下一个同级工具键）——不是全文件切片：
    //   `executeDeviceIntentPlan` 本体也调 `runDeviceControl(ddb,`，全文件序号比较会被它提前命中（假红）。
    const toolBodyOf = (name: string): string => {
      const m = DTOOL.match(new RegExp(`\\n {4}${name}: \\{`));
      if (!m || m.index === undefined) return '';
      const start = m.index;
      const rest = DTOOL.slice(start + m[0].length);
      const next = rest.search(/\n {4}[a-z_]+: \{/);
      return DTOOL.slice(start, next < 0 ? DTOOL.length : start + m[0].length + next);
    };
    const GATE_CALL = "teamFeatureRefusal(licDb, 'device_control')";
    ok(TOOL_GATED.every((t) => toolBodyOf(t).includes(GATE_CALL)),
      'M22-21 ★每个设备写口工具入口各一道闸（逐工具枚举：device_control / device_intent——与面板同经唯一判据）',
      TOOL_GATED.map((t) => `${t}=${toolBodyOf(t).includes(GATE_CALL)}`).join(' · '));
    eq((DTOOL.match(/teamFeatureRefusal\(/g) ?? []).length, TOOL_GATED.length,
      'M22-21b 闸总数＝枚举出的写口工具数（多一处未枚举的写口 / 少一处闸内不判皆红）');
    // zx_20261014_1 批三重定向：工具改为先把 `deviceId`/`name` 解析为在册设备，再以**解析所得 id** 调编排
    //   （`deviceId: r.dev.id`）——故此处钉**调用语句形状** `await runDeviceControl(ddb,`（不随对象字面量内容漂移），
    //   仍验"闸在编排之前"这一结构关系（锁定即不下发）。
    const RUN_CALL = 'await runDeviceControl(ddb,';
    const controlBody = toolBodyOf('device_control');
    ok(controlBody.indexOf(GATE_CALL) >= 0 && controlBody.indexOf(RUN_CALL) > controlBody.indexOf(GATE_CALL),
      'M22-22 ★**闸在编排之前**：`device_control` 工具体内 `teamFeatureRefusal(...)` 出现在 `runDeviceControl(ddb, …)` 调用之前（锁定即不下发）');
    // ★★ 反证：K-6 编排本体 `runDeviceControl` 内**无**档位闸——rr_zx_20261004 M9 以**无许可夹具**直跑它验
    //    K-6 判据（未授权/高危/不可控）；若把档位闸塞进编排，那四条 K-6 断言必红。档位闸与安全闸各就各位。
    const rcStart = DTOOL.indexOf('export async function runDeviceControl(');
    const dtStart = DTOOL.indexOf('export function deviceTools(');
    const rcBody = rcStart >= 0 && dtStart > rcStart ? DTOOL.slice(rcStart, dtStart) : '';
    ok(rcStart >= 0 && dtStart > rcStart && !/teamFeatureRefusal\(/.test(rcBody),
      'M22-23 ★★反证：K-6 编排 `runDeviceControl` 内**无**档位闸（档位闸在入口、安全闸在本体——两件事各就各位）');
  }

  // ═══ M22 renderer 第二落点（词表须穷举到界面）═══════════════════════════════
  {
    const RIPC = RD(`${A}/renderer/src/lib/ipc.ts`);
    const PEERS = RD(`${A}/renderer/src/pages/PeersPage.tsx`);
    const DEVPG = RD(`${A}/renderer/src/pages/DevicesPage.tsx`);

    ok(RIPC.includes("from '../../../src/main/core/team-gate.js'"),
      'M22-24 渲染层引 main 真源 `team-gate`（**仅类型**，打包期擦除——不手抄镜像一份）');
    // zx_20261023_5 批三：渠道目录/预检两个回包也带 gate（向导据此决定"列不列"）⇒ 3→5；
    //   由幻数改为**逐 payload 枚举 + 总数相等**（新增回包漏带 gate 即红）。
    // zx_20261030_1 M4：集群聚合回包同样带 gate（锁定档也要能"看得见"集群概览的锁定态）⇒ 5→6。
    const GATED_PAYLOADS = ['NodesListPayload', 'NodeCardPayload', 'DevicesListPayload', 'DeviceChannelsPayload', 'DeviceChannelAuthPayload', 'NodesClusterPayload'];
    ok(GATED_PAYLOADS.every((name) => {
      const i = RIPC.indexOf(`export interface ${name} `);
      if (i < 0) return false;
      const body = RIPC.slice(i, RIPC.indexOf('\n}', i) + 2);
      return body.includes('gate: TeamGate');
    }), 'M22-25 回包逐 payload 枚举：节点列表/节点卡/设备列表/渠道目录/渠道预检各带 `gate: TeamGate`',
      GATED_PAYLOADS.map((n) => `${n}=${RIPC.slice(RIPC.indexOf(`export interface ${n} `)).split('\n}')[0].includes('gate: TeamGate')}`).join(' · '));
    eq((RIPC.match(/gate: TeamGate/g) ?? []).length, GATED_PAYLOADS.length,
      'M22-25b gate 字段总数＝枚举出的回包数（由枚举派生）');
    ok(PEERS.includes('属于团队版能力') && DEVPG.includes('属于团队版能力'),
      'M22-26 ★第二落点：两面板含**用户可见**「团队版」升级文案（renderer 是词表第二个落点，不在 main 扫描面内）');

    // 产物（minify 后标识符搜不到，中文串可搜）——须先跑 renderer build。
    const assetsDir = path.join(root, `${A}/renderer/dist/assets`);
    const chunks = (prefix: string): string[] => (fs.existsSync(assetsDir)
      ? fs.readdirSync(assetsDir).filter((f) => new RegExp(`^${prefix}-.*\\.js$`).test(f)) : []);
    const devChunks = chunks('DevicesPage');
    eq(devChunks.length, 1, 'M22-27 DevicesPage 产物 chunk 恰一个（renderer 已构建）');
    if (devChunks.length === 1) {
      const c = fs.readFileSync(path.join(assetsDir, devChunks[0]!), 'utf-8');
      ok(['团队版', '开始发现', '允许控制', '控制留痕'].every((s) => c.includes(s)),
        'M22-28 ★设备面板产物含升级文案**且 M10 三串仍在册**（「开始发现/允许控制/控制留痕」未被本轮改动挤掉）');
    }
    const peersChunks = chunks('PeersPage');
    eq(peersChunks.length, 1, 'M22-29 PeersPage 产物 chunk 恰一个');
    if (peersChunks.length === 1) {
      ok(fs.readFileSync(path.join(assetsDir, peersChunks[0]!), 'utf-8').includes('团队版'),
        'M22-30 ★协同面板产物含「团队版」升级文案（页面保留、导航项不动——见方案批六 M22）');
    }
  }

  // ═══ M22 文档 ═══════════════════════════════════════════════════════════════
  {
    const SCOPE = RD('business-plan/materials/open-source-scope.md');
    ok(SCOPE.includes('Team 档软闸') || SCOPE.includes('team-gate.ts'),
      'M22-31 范围清单**标注 Team 档软闸**（`open-source-scope.md` 与实现名实一致——不再是"团队特性闭源"的旧话）');
  }

  // ═══ M7 zx_20261010「未注册即不起心跳/中转」══════════════════════════════════
  // 病根：Team 能力**解锁**（试用/Team）被当成了**已是这个协作网络的一员**——干净 clone 首启即由
  //   `database.ts` 写 `license.trial_started_at` ⇒ 试用放行 ⇒ `index.ts` **无条件**起心跳+中转；
  //   而本机 `node.resource_group` **从未写入**（注册令牌全仓无任何写入入口）⇒ 每拍心跳必
  //   404 `Node not found`、中转必 403 `Key is not bound to node`。治法：起这两条循环加一道
  //   **已注册**闸（判据 `isNodeEnrolled` 一处真源，与 `ensureNodeEnrolled` 同源）。
  console.log('\n【M7】未注册即不起心跳/中转（维特根斯坦·意义即使用：解锁≠加入）');
  {
    // ── 行为：判据两侧标本（G-1 调生产导出；G-2 两侧——"未注册"侧含**近似标本**）──
    const sdb = licDb() as unknown as NodeSettingDb;
    eq(isNodeEnrolled(sdb), false, 'M7-1 无 `node.id`（本机连"自称是谁"都不曾写下）⇒ **未注册**');
    const me = ensureNodeIdentity(sdb, { hostname: 'm7-host' });
    eq(isNodeEnrolled(sdb), false, 'M7-2 ★仅有 `node.id`、无 `node.resource_group` ⇒ 未注册（旧实现正把这一步当成"可参与"，故每拍 404）');
    writeNodeSetting(sdb, NODE_SETTING_KEYS.resourceGroup, `node:${'0'.repeat(8)}-someone-else`);
    eq(isNodeEnrolled(sdb), false, 'M7-3 ★★近似标本：`resource_group` 指向**别的**节点 ⇒ 仍判未注册（若判据写成"有值即已注册"则此红）');
    // zx_20261012：判据增②（非占位凭据）——"已注册"真形状须**补非占位 `ans_api_key`**（断言逐条原样）。
    writeNodeSetting(sdb, NODE_SETTING_KEYS.ansApiKey, 'wa_rr_enrolled_key');
    writeNodeSetting(sdb, NODE_SETTING_KEYS.resourceGroup, `node:${me.id}`);
    eq(isNodeEnrolled(sdb), true, 'M7-4 绑定**本机** id ⇒ 已注册（正面标本：过窄变体"恒 false"在此红）');

    // ── 接线形状：起心跳前须过「已注册」这道闸（读原文，G-5）──
    const IDX = RD(`${A}/src/main/index.ts`);
    eq((IDX.match(/isNodeEnrolled\(db\)/g) ?? []).length, 1,
      'M7-5 `index.ts` 判"已注册"**算一次**（`isNodeEnrolled(db)` 恰一处——与档位"算一次"同一范式）');
    ok(IDX.indexOf('isNodeEnrolled(db)') < IDX.indexOf('startNodeHeartbeat(db'),
      'M7-6 ★**先判已注册后心跳**：`isNodeEnrolled(db)` 在 `startNodeHeartbeat(db` 之前（未注册即不起）');
    ok(
      IDX.indexOf('!teamGate?.unlocked') >= 0
      && IDX.indexOf('!teamGate?.unlocked') < IDX.indexOf('!nodeEnrolled')
      && IDX.indexOf('!nodeEnrolled') < IDX.indexOf('startNodeHeartbeat(db'),
      'M7-7 ★★★闸链有序：档位（`!teamGate?.unlocked`）→ 已注册（`!nodeEnrolled`）→ 起心跳（两道闸各管一件事）');

    // ── 一处真源：判据只定义一处，且 `ensureNodeEnrolled` 复用它（不再重写同一比较）──
    const HB = RD(`${A}/src/main/core/node-heartbeat.ts`);
    eq((HB.match(/export function isNodeEnrolled\(/g) ?? []).length, 1,
      'M7-8 `isNodeEnrolled` 在 `node-heartbeat.ts` **恰一处定义**（"是否已注册"一个概念一个值）');
    ok(/if \(isNodeEnrolled\(db\)\)/.test(HB) && !/bound === `node:\$\{/.test(HB),
      'M7-9 ★`ensureNodeEnrolled` 复用同一判据（反证：旧的 `bound === \\`node:${identity.id}\\`` 内联比较已消除）');
  }

  // ═══ M8 zx_20261010_1「加入之门」接线三钉 ═══════════════════════════════════
  // 病根（M7 只除噪声、未开加入之门）：`node.enrollment_token` 全仓只读不写 ⇒ 干净 clone 恒无令牌
  //   ⇒ 实质不可加入。本轮补上"令牌进得来（输入/申请）+ 注册后即时生效（M3 starter）"。
  //   此处只钉**接线那一跳**（行为两侧标本与本轮自家判据见 `scripts/rr_zx_20261010_1.ts`）。
  console.log('\n【M8】加入之门的接线三钉（维特根斯坦·意义即使用：那句空话终于有了用法）');
  {
    const IDX = RD(`${A}/src/main/index.ts`);
    const NIPC = RD(`${A}/src/main/ipc/nodes.ipc.ts`);

    // 钉1：`nodes:enroll` 过软闸 + 成功支调 `startNodeRuntime()`（且闸在起之前）
    const enrIdx = NIPC.indexOf("ipcMain.handle('nodes:enroll'");
    const rtIdx = NIPC.indexOf("ipcMain.handle('nodes:request-token'");
    const enrBody = enrIdx >= 0 && rtIdx > enrIdx ? NIPC.slice(enrIdx, rtIdx) : '';
    ok(enrBody.includes("teamFeatureRefusal(licDb, 'multi_node')") && enrBody.includes('startNodeRuntime()')
      && enrBody.indexOf('teamFeatureRefusal(') < enrBody.indexOf('startNodeRuntime()'),
      'M8-1 ★`nodes:enroll`：过软闸 **且** 成功支调 `startNodeRuntime()`（免重启起心跳/中转；闸在起之前）');

    // 钉2：`nodes:enroll-state` 读**同源判据**
    const esIdx = NIPC.indexOf("ipcMain.handle('nodes:enroll-state'");
    ok(esIdx >= 0 && NIPC.slice(esIdx).includes('isNodeEnrolled(settingDb)'),
      'M8-2 ★`nodes:enroll-state` 读 `isNodeEnrolled`（与"是否已注册"同一判据——一个概念一个值）');

    // 钉3：M3 抽出 `startNodeRuntime()` 后起心跳**仍恰一处**（抽函数不得把一处真源裂成两份）
    eq((IDX.match(/startNodeHeartbeat\(db/g) ?? []).length, 1,
      'M8-3 ★★`index.ts` 起心跳**仍恰一处**（M3 抽具名函数后未裂成两份；幂等由 starter 自负）');
  }

  // ═══ S 哑雷自检 + build 钉（派生核对，不写轮次字面量）════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 ★方向性自指（由载体自身派生，非抄来的常量）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}_team.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}_team.ts`);

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
try {
  main();
} catch (e: unknown) {
  console.error(`\n💥 rr_zx_20261005_team 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
}
console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261005_team: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
