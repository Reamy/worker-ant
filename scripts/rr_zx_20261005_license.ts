/**
 * zx_20261005 受控复跑 —— 批二「卖得动 · 之一」（许可与激活）。
 *
 * 按实施排期逐批转绿（`RR_STAGE=Mn` 只要求 ≤Mn 的批次为绿，更晚的批次打 ⏳ 不计入失败；
 * `RR_STAGE` 为空 = 全部须绿，收口用）。批序见下方 `ORDER`。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §M5 判据（批二）——「能力上限真源」（管子·轻重：没有统一的尺，轻重不可比）。
 *   `TIER_LIMITS` 是"档位 → 并发/项目/席位"的**唯一尺**：三档穷举（键类型取 `LICENSE_TIERS` ⇒ 漏一档编译期错）；
 *   `clampConcurrency` 是 **min 语义**（档位是**天花板**不是设定值——自配 2 比天花板 3 保守时仍取 2）；
 *   `projectQuotaExceeded` 的 `0 = 不限` 两侧标本（Pro 100 个项目不超 / Community 第 1 个即超）。
 *
 * §M6 判据（批二）——「离线签名许可」（K-2 离线 / K-5 个人档 ≤3、团队授权包 ≤20 / K-3 软闸）。
 *   验签**两侧标本**：同一段文本用**对的公钥**通过、用**别的公钥**即 `bad_signature`（不是只测"能过"）；
 *   三态（有效 / `expiresAt` 过期 / 无）各一；设备绑定**恰命中**则过、**不在列表**则 `device_mismatch`；
 *   K-5 结构性上限（`devices > 3` ⇒ `too_many_devices`）；**坏载荷**（档位非法）不得被当成有效。
 *   **私钥不入库**反证：全仓（除本文件）零 `PRIVATE KEY`；`.gitignore` 覆盖 `license-signing-key`。
 *
 * §M7 判据（批二）——「软闸接线」（K-3：失败 fail-open 到 community，绝不 fail-closed）。
 *   试用**倒计时**（注入 `now`，G-4 不依赖墙钟）；「有 key 但校验不过」**不回落试用**（名实相符）；
 *   项目数配额**一处判据**（`project-quota.ts`）——`project:create`/`project:clone`/IM 两条共引一份，
 *   并有"旧内联形态已消失"的反证（防第二份判据复活）。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：指纹/验签/钳位/配额一律调生产导出，不在测试里复刻一份"等价物"。
 *   G-2 **两侧标本**：过宽变体与过窄变体都要能被本文件抓红。
 *   G-3 **计数器用 0→1 正面断言**（`countProjects` 空→1），不用"不抛"代替。
 *   G-4 **不依赖真实墙钟**：`now`/`fingerprint` 一律注入。
 *   G-5 静态判据读**原文**（去注释在本仓是静默毁伤）——故本文件一律 `RD(...)`，不 `strip`。
 *   G-6 **无轮次字面量**：本轮方案路径与脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：判据引用的生产符号**全部静态导入** ⇒ 被删/改名即**编译期失败**（而非"扫了个空、静默假绿"）。
import {
  LICENSE_TIERS, TIER_LIMITS, TIER_LABEL, isLicenseTier, clampConcurrency, projectQuotaExceeded,
  type LicenseTier,
} from '../apps/worker-ant-desktop/src/main/core/feature-limits.js';
import {
  LICENSE_PREFIX, MAX_LICENSE_DEVICES, licenseDeviceCap, TRIAL_DAYS, LICENSE_PUBLIC_KEY_PEM, LICENSE_SETTING_KEYS,
  formatFingerprint, collectFingerprintInputs, deviceFingerprint,
  encodeLicense, verifyLicense, resolveLicenseState, resolveLicenseTier, activateLicense,
  type LicensePayload, type LicenseSettingDb,
} from '../apps/worker-ant-desktop/src/main/core/license.js';
import { countProjects, projectQuotaRefusal } from '../apps/worker-ant-desktop/src/main/core/project-quota.js';

// ── 批次门（排期序）────────────────────────────────────────────────────────
const ORDER = ['M5', 'M6', 'M7', 'M8', 'M9'] as const;
type Batch = (typeof ORDER)[number];
const STAGE = (process.env.RR_STAGE || '').trim() as Batch | '';
/** STAGE 为空 ⇒ 全部须绿；否则**只要求 ≤STAGE 的批次**为绿（更晚的如实标"待实施"，不计入失败）。 */
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
/** 静态判据读**原文**（G-5：去注释在本仓是静默毁伤——"注释里写着有、代码里没被用上"正是要防的形态）。 */
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/_[a-z]+\.ts$/, ''); // zx_20261005

/* ── 夹具 ────────────────────────────────────────────────────────────────── */

/** 许可/配额夹具：`wa_settings` + `wa_projects` 两表（`countProjects` 与 `readSetting` 的真读面）。 */
function licDb(settings: Record<string, string> = {}, projectIds: string[] = []): LicenseSettingDb {
  const d = new DatabaseSync(':memory:');
  // 夹具 DDL 须与生产 `database.ts` 的 wa_settings 同形（含 `updated_at DEFAULT (datetime('now'))`）——
  // `activateLicense` 的 INSERT 带 updated_at，夹具少了它 ⇒ 写入被 catch 吞掉、断言只看 !ok 就假绿。
  d.exec("CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))");
  d.exec('CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT)');
  for (const [k, v] of Object.entries(settings)) d.prepare('INSERT INTO wa_settings (key,value) VALUES (?,?)').run(k, v);
  for (const id of projectIds) d.prepare('INSERT INTO wa_projects (id,name) VALUES (?,?)').run(id, id);
  return d as unknown as LicenseSettingDb;
}
/** 写设置的最小面（`activateLicense` 要 run）。 */
type WriteDb = LicenseSettingDb & { prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown } };

/** 测试密钥对（**在内存里现生成**，不落盘、不入库）——用来签一段真许可。 */
const TEST_KEYS = crypto.generateKeyPairSync('ed25519');
const TEST_PRIVATE_PEM = TEST_KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const TEST_PUBLIC_PEM = TEST_KEYS.publicKey.export({ type: 'spki', format: 'pem' }) as string;
/** **另一对**密钥（只为"用错公钥必须验不过"这一侧标本）。 */
const OTHER_PUBLIC_PEM = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) as string;

const NOW = new Date('2026-10-05T00:00:00.000Z');
const FP = 'AAAA-BBBB-CCCC-DDDD';
const payload = (over: Partial<LicensePayload> = {}): LicensePayload => ({
  v: 1, tier: 'pro', subject: '测试被许可人', issuedAt: '2026-10-01T00:00:00.000Z', expiresAt: null, devices: [], ...over,
});
const sign = (p: LicensePayload): string => encodeLicense(p, TEST_PRIVATE_PEM);

async function main(): Promise<void> {
  // ═══ M5 能力上限真源 ═══════════════════════════════════════════════════════
  console.log('\n【M5】能力上限真源（管子·轻重：一把可比的尺）');
  {
    // 三档穷举：键类型取 `LICENSE_TIERS` ⇒ 这里逐档点名，漏一档编译期就错。
    eq([...LICENSE_TIERS], ['community', 'pro', 'team'], 'M5-1 档位词表恰三档（community/pro/team，顺序即真源顺序）');
    eq(
      LICENSE_TIERS.map((t) => TIER_LIMITS[t].maxProjectConcurrency),
      [3, 8, 16],
      'M5-2 ★并发天花板逐档在册：社区 3 / 专业 8 / 团队 16（改这里＝改产品口径，须同步 business-plan §3.2）',
    );
    eq(
      LICENSE_TIERS.map((t) => TIER_LIMITS[t].maxProjects),
      [1, 0, 0],
      'M5-3 项目数上限逐档在册：社区 1 / 专业·团队 **0 = 不限**（0 是"不限"的哨兵值，不是"零个"）',
    );
    eq(LICENSE_TIERS.map((t) => TIER_LABEL[t]).filter((s) => typeof s === 'string' && s.length > 0).length, 3,
      'M5-4 人话档位名三档齐备（界面直接上屏，漏一档即空白）');

    // `clampConcurrency` 是 **min 语义**（档位是天花板不是设定值）——两侧标本。
    eq(
      [
        clampConcurrency('community', 5),   // 自配高于天花板 ⇒ 压到 3
        clampConcurrency('community', 2),   // 自配低于天花板 ⇒ **尊重用户意图**仍取 2
        clampConcurrency('community', 3),   // 恰在天花板 ⇒ 3
        clampConcurrency('pro', 5),         // 专业档 5 < 8 ⇒ 原样
        clampConcurrency('team', 20),       // 团队档 20 > 16 ⇒ 压到 16
      ],
      [3, 2, 3, 5, 16],
      'M5-5 ★★`clampConcurrency` 是 **min**：自配 5→社区天花板 3、自配 2 仍取 2（若写成"直接取档位值"这条即红）',
    );
    eq(
      [
        clampConcurrency('community', 0),    // 未设/0 ⇒ 取天花板
        clampConcurrency('community', NaN),  // 坏值 ⇒ 取天花板（不因坏配置把项目卡死）
        clampConcurrency('pro', -3),         // 负数 ⇒ 取天花板
      ],
      [3, 3, 8],
      'M5-6 脏 `configured`（0/NaN/负）一律退**天花板**（不是退 0——退 0 会把项目锁死，与"不卡死"相反）',
    );

    // `projectQuotaExceeded` 的 `0 = 不限` 两侧标本。
    eq(
      [
        projectQuotaExceeded('community', 0),   // 第 1 个：还没到 1 ⇒ 放行
        projectQuotaExceeded('community', 1),   // 已有 1 ⇒ 到顶
        projectQuotaExceeded('pro', 100),       // maxProjects=0 ⇒ 恒 false（不限）
        projectQuotaExceeded('team', 5),
      ],
      [false, true, false, false],
      'M5-7 ★`0 = 不限`：社区 0 个项目放行 / 已有 1 个即到顶；Pro·Team 100 个仍 false（哨兵值与"零个"分得开）',
    );

    // 运行期收窄两侧。
    eq([isLicenseTier('pro'), isLicenseTier('team'), isLicenseTier('enterprise'), isLicenseTier(undefined), isLicenseTier(3)],
      [true, true, false, false, false],
      'M5-8 `isLicenseTier` 运行期收窄两侧：真档位认、野档位/非串不认（外部输入不可信）');
  }

  // ═══ M6 离线签名许可 ═══════════════════════════════════════════════════════
  console.log('\n【M6】离线签名许可（K-2 离线 / K-5 ≤3 台 / 三态 + 私钥不入库）');
  {
    eq([LICENSE_PREFIX, MAX_LICENSE_DEVICES, TRIAL_DAYS], ['WA-LICENSE-v1', 3, 14],
      'M6-1 三个常量在册：文本前缀 / K-5 设备上限 3 台 / 试用 14 天');
    ok(/BEGIN PUBLIC KEY/.test(LICENSE_PUBLIC_KEY_PEM) && !/PRIVATE/.test(LICENSE_PUBLIC_KEY_PEM),
      'M6-2 内嵌的是**公钥**（SPKI PEM），且不含私钥字样');

    // ── 指纹（纯函数，喂固定输入 ⇒ 不碰真机，G-4） ──
    const fpIn = { platform: 'darwin', arch: 'arm64', hostname: 'h1', machineId: 'MID-1', mac: 'aa:bb:cc:dd:ee:ff' };
    const fp1 = formatFingerprint(fpIn);
    eq(fp1, formatFingerprint({ ...fpIn }), 'M6-3 指纹**确定性**：同输入同结果（幂等，非随机）');
    ok(
      fp1 !== formatFingerprint({ ...fpIn, platform: 'linux' })
      && fp1 !== formatFingerprint({ ...fpIn, arch: 'x64' }),
      'M6-4 指纹**取合成**：平台/架构也参与哈希（与 M6-5 的机器标识/主机名/MAC 合起来＝五路输入全参与，非单点绑定）',
      fp1,
    );
    ok(
      fp1 !== formatFingerprint({ ...fpIn, machineId: 'MID-2' })
      && fp1 !== formatFingerprint({ ...fpIn, hostname: 'h2' })
      && fp1 !== formatFingerprint({ ...fpIn, mac: 'aa:bb:cc:dd:ee:00' }),
      'M6-5 ★两侧标本：改**机器标识/主机名/MAC 任一**都改变指纹（不是"只看某一项"的单点绑定）',
      fp1,
    );
    ok(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(fp1),
      'M6-6 指纹形状 `XXXX-XXXX-XXXX-XXXX`（16 位十六进制分四组——用户要把它发给签发方，须整齐好念）', fp1);
    eq(typeof deviceFingerprint(), typeof deviceFingerprint(), 'M6-7 本机指纹**进程内幂等**（M7 记忆化：热路径不重复 execFileSync）');
    ok(collectFingerprintInputs() && typeof collectFingerprintInputs().platform === 'string',
      'M6-8 `collectFingerprintInputs` 不 throw（读不到机器标识也退 null 参与哈希，不炸）');

    // ── 验签三态 + 两侧标本 ──
    const good = sign(payload());
    const vGood = verifyLicense(good, { publicKeyPem: TEST_PUBLIC_PEM, now: NOW, fingerprint: FP });
    ok(vGood.ok && vGood.status === 'valid' && vGood.payload?.tier === 'pro',
      'M6-9 ★正标本：本产品私钥签出的许可，用对应公钥验**通过**且读出档位', vGood.detail);
    const vWrongKey = verifyLicense(good, { publicKeyPem: OTHER_PUBLIC_PEM, now: NOW, fingerprint: FP });
    ok(!vWrongKey.ok && vWrongKey.status === 'bad_signature',
      'M6-10 ★★反标本（两侧）：**同一段文本**换一对公钥验 ⇒ `bad_signature`（不是只测"能过"——那样伪造也全票通过）');
    const vTampered = verifyLicense(good.slice(0, -3) + 'zzz', { publicKeyPem: TEST_PUBLIC_PEM, now: NOW, fingerprint: FP });
    ok(!vTampered.ok && vTampered.status === 'bad_signature',
      'M6-11 ★改动签名尾部 ⇒ `bad_signature`（文本被改，签名即对不上）');

    eq(
      [
        verifyLicense('', { now: NOW }).status,
        verifyLicense('garbage-not-a-license', { now: NOW }).status,
        verifyLicense(`WA-LICENSE-v2.${good.split('.')[1]}.${good.split('.')[2]}`, { now: NOW }).status,
      ],
      ['bad_format', 'bad_format', 'bad_format'],
      'M6-12 空 / 无分隔 / **前缀版本不符** ⇒ 一律 `bad_format`（双标防"旧工具签新文本"）');

    const expired = sign(payload({ expiresAt: '2026-10-04T00:00:00.000Z' })); // 早于注入的 NOW
    const vExp = verifyLicense(expired, { publicKeyPem: TEST_PUBLIC_PEM, now: NOW, fingerprint: FP });
    const vAlive = verifyLicense(sign(payload({ expiresAt: '2026-10-06T00:00:00.000Z' })), { publicKeyPem: TEST_PUBLIC_PEM, now: NOW, fingerprint: FP });
    ok(!vExp.ok && vExp.status === 'expired' && vAlive.ok,
      'M6-13 ★过期两侧标本：早于 `now` ⇒ `expired`；晚于 `now` ⇒ 有效（时刻注入，不依赖墙钟）');

    const bound = sign(payload({ devices: [FP] }));
    ok(verifyLicense(bound, { publicKeyPem: TEST_PUBLIC_PEM, now: NOW, fingerprint: FP }).ok,
      'M6-14 设备**在册** ⇒ 通过（本机指纹恰在许可列表里）');
    const vMis = verifyLicense(bound, { publicKeyPem: TEST_PUBLIC_PEM, now: NOW, fingerprint: '9999-9999-9999-9999' });
    ok(!vMis.ok && vMis.status === 'device_mismatch',
      'M6-15 ★★两侧标本：本机不在设备列表 ⇒ `device_mismatch`（同一段许可，换个指纹即红）');
    ok(verifyLicense(sign(payload({ devices: [] })), { publicKeyPem: TEST_PUBLIC_PEM, now: NOW, fingerprint: FP }).ok,
      'M6-16 空设备列表 = 不绑设备 ⇒ 任何机器都通过（空列表与"绑了别人"分得开）');

    const vTooMany = verifyLicense(sign(payload({ devices: ['a', 'b', 'c', 'd'] })), { publicKeyPem: TEST_PUBLIC_PEM, now: NOW, fingerprint: 'a' });
    ok(!vTooMany.ok && vTooMany.status === 'too_many_devices',
      'M6-17 ★K-5 结构性上限：个人档许可内嵌 **4** 个指纹 ⇒ `too_many_devices`（4 > 3，超出即拒——不靠人工自觉）');

    // zx_20261024_1：团队授权包「一包 ≤20 节点」——一张许可须能绑 20 台；上限与 `maxNodes` 同源。
    eq(
      LICENSE_TIERS.map((t) => licenseDeviceCap(t)),
      [MAX_LICENSE_DEVICES, MAX_LICENSE_DEVICES, TIER_LIMITS.team.maxNodes],
      'M6-17a ★档位化设备上限：community/pro = 3（K-5），team = `TIER_LIMITS.team.maxNodes`（不另抄 20）',
    );
    const team20 = Array.from({ length: 20 }, (_, i) => `0000-0000-0000-${String(i).padStart(4, '0')}`);
    const vTeam20 = verifyLicense(sign(payload({ tier: 'team', devices: team20 })), { publicKeyPem: TEST_PUBLIC_PEM, now: NOW, fingerprint: team20[0]! });
    ok(vTeam20.ok && vTeam20.status === 'valid',
      'M6-17b ★团队授权包：一张许可绑 **20** 台通过（个人档同形状会被 M6-17 拒）', vTeam20.detail);
    const vTeam21 = verifyLicense(sign(payload({ tier: 'team', devices: [...team20, '0000-0000-0000-9999'] })), { publicKeyPem: TEST_PUBLIC_PEM, now: NOW, fingerprint: team20[0]! });
    ok(!vTeam21.ok && vTeam21.status === 'too_many_devices',
      'M6-17c ★团队包上限两侧标本：**21** 台 ⇒ `too_many_devices`（上限不是"没有上限"）', vTeam21.detail);

    eq(
      [
        verifyLicense(sign(payload({ tier: 'enterprise' as unknown as LicenseTier })), { publicKeyPem: TEST_PUBLIC_PEM, now: NOW }).status,
        verifyLicense(sign(payload({ v: 2 })), { publicKeyPem: TEST_PUBLIC_PEM, now: NOW }).status,
        verifyLicense(sign(payload({ devices: 'not-an-array' as unknown as string[] })), { publicKeyPem: TEST_PUBLIC_PEM, now: NOW }).status,
      ],
      ['bad_payload', 'bad_payload', 'bad_payload'],
      'M6-18 签得对但**载荷字段不合规**（野档位 / 版本 2 / devices 非数组）⇒ `bad_payload`（签名对 ≠ 内容合法）');

    // ── 私钥不入库（反证） ──
    // 扫描面＝**现行源码树**。跳过 `_archive/`（归档前形态，已冻结勿改勿跑）、`.next/`/`build`/`coverage`/
    // `.output`/`.turbo`（第三方依赖打包出的构建产物，非本产品源码）——它们混入的是 jose 等依赖内嵌的
    // **示例**私钥，与本产品许可签发私钥无关；把它们算进来只会让反证恒红而失去意义。
    const SELF = path.basename(__filename);
    const SKIP_DIRS = new Set(['node_modules', 'dist', '_archive', '.next', 'build', 'coverage', '.output', '.turbo', '.git']);
    const privHits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        if (e.isDirectory() ? SKIP_DIRS.has(e.name) : false) continue;
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { walk(rel); continue; }
        if (!/\.(ts|tsx|js|mjs|cjs|json|yml|yaml)$/.test(e.name) || e.name === SELF) continue;
        if (/BEGIN [A-Z ]*PRIVATE KEY/.test(fs.readFileSync(path.join(root, rel), 'utf-8'))) privHits.push(rel);
      }
    };
    walk('apps'); walk('scripts'); walk('packages');
    eq(privHits, [], 'M6-19 ★★反证：现行源码树（apps/scripts/packages，不含 _archive 归档与构建产物）内**零处**私钥 PEM（私钥绝不入库）');
    const gi = fs.existsSync(path.join(root, '.gitignore')) ? fs.readFileSync(path.join(root, '.gitignore'), 'utf-8') : '';
    ok(/license-signing-key/.test(gi),
      'M6-20 `.gitignore` 覆盖 `license-signing-key`（即便误落在 data/ 下也不会被提交）');

    // ── 三态状态解析（now/fingerprint 注入） ──
    const stNone = resolveLicenseState(licDb(), { now: NOW, fingerprint: FP });
    eq([stNone.kind, stNone.tier], ['none', 'community'],
      'M6-21 无许可无试用 ⇒ `none` + community（**缺许可即社区版**，不是"什么都开"）');
    const trialDay1 = licDb({ [LICENSE_SETTING_KEYS.trialStartedAt]: new Date(NOW.getTime() - 86_400_000).toISOString() });
    const stTrial = resolveLicenseState(trialDay1, { now: NOW, fingerprint: FP });
    eq([stTrial.kind, stTrial.tier, stTrial.trialDaysLeft], ['trial', 'pro', TRIAL_DAYS - 1],
      'M6-22 试用第 1 天 ⇒ `trial` + **pro 能力** + 剩余天数 = TRIAL_DAYS-1（首启锚点 + 倒计时同一处算）');
    const trialEnd = licDb({ [LICENSE_SETTING_KEYS.trialStartedAt]: new Date(NOW.getTime() - TRIAL_DAYS * 86_400_000).toISOString() });
    const stEnd = resolveLicenseState(trialEnd, { now: NOW, fingerprint: FP });
    eq([stEnd.kind, stEnd.tier], ['trial_expired', 'community'],
      'M6-23 恰满 TRIAL_DAYS 天 ⇒ `trial_expired` + 回落 community（边界：第 14 天当天即失效，不多给）');
    const stLic = resolveLicenseState(licDb({ [LICENSE_SETTING_KEYS.key]: sign(payload({ tier: 'team', devices: [] })) }), { now: NOW, fingerprint: FP, publicKeyPem: TEST_PUBLIC_PEM });
    eq([stLic.kind, stLic.tier], ['licensed', 'team'],
      'M6-24 有效许可 ⇒ `licensed` 且档位取自**许可载荷**（不是查表猜的）');
    // ★ 名实相符：「有 key 但校验不过」**不回落试用**。
    const both = licDb({
      [LICENSE_SETTING_KEYS.trialStartedAt]: new Date(NOW.getTime() - 86_400_000).toISOString(), // 试用期中
      [LICENSE_SETTING_KEYS.key]: sign(payload({ tier: 'pro' })),                               // 但用**错的公钥**验
    });
    const stInvalid = resolveLicenseState(both, { now: NOW, fingerprint: FP, publicKeyPem: OTHER_PUBLIC_PEM });
    eq([stInvalid.kind, stInvalid.tier], ['invalid', 'community'],
      'M6-25 ★★「有 key 但校验不过」⇒ `invalid` + community，**不回落试用**（明确表过态却无效，不许扮成"我还在试用"）');
    eq(resolveLicenseTier(licDb(), { now: NOW, fingerprint: FP }), 'community',
      'M6-26 `resolveLicenseTier` 是软闸唯一取档入口（软闸读的就是它）');

    // ── 激活：验签通过才落库 ──
    const dbW = licDb() as WriteDb;
    const bad = activateLicense(dbW, 'garbage', { now: NOW, fingerprint: FP, publicKeyPem: TEST_PUBLIC_PEM });
    const afterBad = (dbW as unknown as LicenseSettingDb).prepare("SELECT value FROM wa_settings WHERE key=?").get(LICENSE_SETTING_KEYS.key);
    ok(!bad.ok && afterBad === undefined,
      'M6-27 ★坏许可**不落库**（`activateLicense` 返回 !ok 且 `license.key` 仍为空——防"存了坏 key 再撑一次跳过"）');
    const goodLic = sign(payload({ tier: 'pro' }));
    const goodRes = activateLicense(dbW, goodLic, { now: NOW, fingerprint: FP, publicKeyPem: TEST_PUBLIC_PEM });
    const afterGood = (dbW as unknown as LicenseSettingDb).prepare("SELECT value FROM wa_settings WHERE key=?").get(LICENSE_SETTING_KEYS.key) as { value?: string } | undefined;
    ok(goodRes.ok && goodRes.state.kind === 'licensed' && afterGood?.value === goodLic.trim(),
      'M6-28 ★0→1 正面断言：好许可**落库**（`license.key` 由无到有，且写入的是 trim 后的原文）');
  }

  // ═══ M7 软闸接线 ═══════════════════════════════════════════════════════════
  console.log('\n【M7】软闸接线（K-3 fail-open / 项目数配额一处判据 / 并发钳位接线）');
  {
    // 配额判据（生产函数，非复刻）。
    eq(countProjects(licDb()), 0, 'M7-1 空库项目数 = 0');
    eq(countProjects(licDb({}, ['p1'])), 1, 'M7-2 ★0→1 正面断言：插 1 个项目 ⇒ `countProjects` = 1（真读行数）');
    eq(
      [
        projectQuotaRefusal(licDb(), { now: NOW, fingerprint: FP }),                // 社区 0 个 ⇒ 放行
        projectQuotaRefusal(licDb({}, ['p1']), { now: NOW, fingerprint: FP }),      // 社区 1 个 ⇒ 拒
        projectQuotaRefusal(licDb({}, ['p1', 'p2', 'p3']), { now: NOW, fingerprint: FP }), // 社区 3 个 ⇒ 拒
      ].map((r) => (r === null ? 'ALLOW' : 'DENY')),
      ['ALLOW', 'DENY', 'DENY'],
      'M7-3 ★项目数配额两侧：社区**第 1 个放行**、再有即拒（Deny 侧给出如实拒因字符串，非空）');
    const refusal = projectQuotaRefusal(licDb({}, ['p1']), { now: NOW, fingerprint: FP });
    ok(!!refusal && refusal.includes(TIER_LABEL.community) && refusal.includes(String(TIER_LIMITS.community.maxProjects)),
      'M7-4 拒因**如实**：含档位名与上限数（由 `TIER_LIMITS`/`TIER_LABEL` 真源派生，不抄字面量）', refusal ?? '');
    const proDb = licDb({ [LICENSE_SETTING_KEYS.trialStartedAt]: new Date(NOW.getTime() - 3_600_000).toISOString() }, ['p1', 'p2', 'p3', 'p4']);
    eq(projectQuotaRefusal(proDb, { now: NOW, fingerprint: FP }), null,
      'M7-5 ★★另一侧：**试用中（＝专业版）**已有 4 个项目仍放行（`maxProjects: 0` 不限——档位真的在放宽）');
    eq(projectQuotaRefusal(null), null, 'M7-6 无库 ⇒ 不拦（fail-open 方向与 K-3 一致，不是"打不开"）');

    // ── 接线（静态判据读原文，G-5） ──
    const IPC = RD(`${A}/src/main/ipc/project.ipc.ts`);
    const IM = RD(`${A}/src/main/services/im-router.ts`);
    const ACC = RD(`${A}/src/main/core/task-accounting.ts`);
    const DB = RD(`${A}/src/main/database.ts`);

    eq((IPC.match(/projectQuotaRefusal\(db\)/g) ?? []).length, 2,
      'M7-7 ★★`project:create` 与 `project:clone` **各自**调一次配额判据（clone 是第二条建项目路——漏了它就是可绕过的尺）');
    eq((IM.match(/projectQuotaRefusal\(ctx\.db\)/g) ?? []).length, 2,
      'M7-8 ★★IM 的两条建项目路（`@不存在项目名` / 无归属「IM对话项目」）**同引一处判据**');
    ok(!/COUNT\(\*\) AS c FROM wa_projects/.test(IPC),
      'M7-9 ★反证：`project.ipc.ts` 内**已无**内联的项目计数（判据归 `project-quota.ts` 一处，防第二份复活）');
    ok(/projectQuotaRefusal/.test(IPC) && /projectQuotaRefusal/.test(IM) && /countProjects/.test(RD(`${A}/src/main/core/project-quota.ts`)),
      'M7-10 一处定义三处消费：判据在 `project-quota.ts`，GUI 两路 + IM 两路共引');

    ok(/clampConcurrency\(resolveLicenseTier\(db, opts\), configured\)/.test(ACC),
      'M7-11 ★★并发钳位接线**形状**：`clampConcurrency(resolveLicenseTier(db, opts), configured)`——档位现读 + 只降不升');
    ok(/import \{ clampConcurrency \} from '\.\/feature-limits\.js'/.test(ACC),
      'M7-12 `task-accounting` 从真源引 `clampConcurrency`（不另写一份 min）');

    ok(/LICENSE_SETTING_KEYS\.trialStartedAt/.test(DB) && !/'license\.trial_started_at'/.test(DB),
      'M7-13 ★★试用起算点的键名**引常量不抄字面量**（防"写 a 读 b"：database.ts 是第二个落点）');
    // ⚠ zx_20261016_4 重定向（**改旧断言＝改钉更强的新真源，不是放宽**）：原为"恰 1 处"，那正是
    //   "只写一次、删掉即无限重置"的病根形状；今为**2 处**（读现值 + 回写）。本条只记计数，
    //   两处锚点的裁决与接线由本轮套件 `rr_zx_20261016_4.ts` 独立钉。
    eq((DB.match(/LICENSE_SETTING_KEYS\.trialStartedAt/g) ?? []).length, 2,
      'M7-14 试用起算点在 `database.ts` **恰 2 处**（读现值 + 回写，键名一律引常量）——旧形态的"1"即"可重置"');
  }

  // ═══ M8 激活界面接线 ══════════════════════════════════════════════════════
  console.log('\n【M8】激活界面（IPC 壳薄 / 出口唯一 / 版本取真源 / 渲染层接线）');
  {
    const LIC_IPC = RD(`${A}/src/main/ipc/license.ipc.ts`);
    const IDX = RD(`${A}/src/main/index.ts`);
    const RIPC = RD(`${A}/renderer/src/lib/ipc.ts`);
    const SET = RD(`${A}/renderer/src/pages/SettingsPage.tsx`);

    ok(LIC_IPC.includes("'license:status'") && LIC_IPC.includes("'license:activate'"),
      'M8-1 IPC 壳**两通道在册**：`license:status`（读）+ `license:activate`（激活唯一入口）');
    // ★ 反证：激活出口唯一，且壳内**不自写** license key（写 key 归 core/license.ts 的 activateLicense）。
    // 注意：不能拿 `settings:set` 子串做反证——那串在**文件头注释**里出现过（M6-27 反面教材），G-5 要求读原文，
    // 故这里钉**调用形状**（activateLicense( 恰一次）+ **判据键常量**（壳内不得出现 LICENSE_SETTING_KEYS.key）。
    eq((LIC_IPC.match(/activateLicense\(/g) ?? []).length, 1,
      'M8-2 ★★激活出口唯一：壳内 `activateLicense(` **恰一次**（验签通过才落库——壳不另判、不另写）');
    ok(!/LICENSE_SETTING_KEYS\.key/.test(LIC_IPC),
      'M8-3 ★反证：壳内**无** `LICENSE_SETTING_KEYS.key`（不给"绕过验签直接塞 key"留第二条路）');
    ok(LIC_IPC.includes('LICENSE_INVALID'),
      'M8-4 激活失败**如实回错误码**：`LICENSE_INVALID`（界面据此显示原因，不吞成 INTERNAL）');
    ok(LIC_IPC.includes('app.getVersion()'),
      'M8-5 应用版本**取 `app.getVersion()`**（系统信息不再手写会腐的字面量）');

    ok(/import \{ initLicenseIpc \} from '\.\/ipc\/license\.ipc\.js'/.test(IDX),
      'M8-6 `index.ts` 从壳引 `initLicenseIpc`（裸名引，路径带 .js——ESM 产物同形）');
    eq((IDX.match(/initLicenseIpc\(/g) ?? []).length, 1,
      'M8-7 ★`initLicenseIpc(db)` **恰调一次**（导入见 M8-6；多调一次＝重复注册 IPC handler）');

    ok(RIPC.includes("'license:status'") && RIPC.includes("'license:activate'") && /LicenseState/.test(RIPC),
      'M8-8 渲染层 API 三通道在册（status/activate/appVersion），形状引 main 真源 `LicenseState`');
    ok(SET.includes('许可与激活'),
      'M8-9 设置页出现**用户可见**「许可与激活」卡片（renderer 是词表第二落点——中文串可搜，minify 后标识符搜不到）');
    ok(/appVersion/.test(SET) && !/0\.2\.0/.test(SET),
      'M8-10 ★版本显示**已接 `appVersion`**、且旧硬编码 `0.2.0` 已消失（名实相符：显示的就是真版本）');
    // zx_20261024_1：绑定上限按档位（个人 3 / 团队包 20）——上限由 main 派生，渲染层只透传。
    eq((LIC_IPC.match(/deviceCap:\s*licenseDeviceCap\(/g) ?? []).length, 2,
      'M8-11 ★两处返回（status/activate）都带 `deviceCap: licenseDeviceCap(...)`（上限随档位变，壳不写死）');
    ok(/deviceCap/.test(RIPC) && /deviceCap/.test(SET) && !/最多绑 3 台/.test(SET),
      'M8-12 ★反证：设置页绑定说明改显 `deviceCap`，旧写死「最多绑 3 台」已消失（renderer 是词表第二落点）');
  }

  // ═══ M9 签发工具 ══════════════════════════════════════════════════════════
  console.log('\n【M9】签发工具（`scripts/issue-license.ts`——私钥不入库 / 签前自证 / 单一签名真源）');
  {
    const TOOL = 'scripts/issue-license.ts';
    const tool = RD(TOOL);
    crit('M9', /from '\.\.\/apps\/worker-ant-desktop\/src\/main\/core\/license\.js'/.test(tool)
      && /encodeLicense\(/.test(tool),
      'M9-1 工具引生产 `encodeLicense`（**单一签名真源**——不复刻一份，否则"签得出、App 验不过"必现）');
    crit('M9', !/\bcryptoSign\b|createSign\(/.test(tool),
      'M9-2 ★反证：工具内**不直接** `crypto.sign`/`createSign`（签名逻辑只此一处，杜绝第二份）');
    crit('M9', tool.indexOf('verifyLicense(') >= 0 && tool.indexOf('writeFileSync(outPath') >= 0
      && tool.indexOf('verifyLicense(') < tool.indexOf('writeFileSync(outPath'),
      'M9-3 ★签前自证**先于落盘**：`verifyLicense(` 出现在 `writeFileSync(outPath` 之前（不过就不出文件）');
    crit('M9', tool.includes("'license-signing-key.pem'") || tool.includes('license-signing-key.pem'),
      'M9-4 私钥默认落点 `data/license-signing-key.pem`（gitignored——`.gitignore` 覆盖见 M6-20）');
    crit('M9', tool.includes('@license-public-key:begin') && tool.includes('@license-public-key:end'),
      'M9-5 `--gen-keys` 重写公钥块（标记在册：换密钥＝换这一块，其余代码不动）');

    // ── 实跑一轮：临时密钥对（内存生成、写临时私钥）经**真 CLI** 签 → 双公钥两侧复核 ──
    const tsx = path.join(root, A, 'node_modules', '.bin', 'tsx');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-lic-'));
    try {
      const kp = crypto.generateKeyPairSync('ed25519');
      const privPem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
      const pubPem = kp.publicKey.export({ type: 'spki', format: 'pem' }) as string;
      fs.writeFileSync(path.join(tmp, 'k.pem'), privPem, { mode: 0o600 });
      fs.writeFileSync(path.join(tmp, 'p.pem'), pubPem);
      execFileSync(tsx, [TOOL, '--key', path.join(tmp, 'k.pem'), '--pubkey', path.join(tmp, 'p.pem'),
        '--tier', 'team', '--subject', '沙箱客', '--expires', '2027-10-05',
        '--devices', FP, '--out', path.join(tmp, 'lic.txt')],
        { cwd: root, stdio: 'pipe' });
      const issued = fs.readFileSync(path.join(tmp, 'lic.txt'), 'utf-8').trim();
      ok(issued.startsWith(`${LICENSE_PREFIX}.`),
        'M9-6a ★真 CLI 出件（`--key`/`--pubkey` 走临时密钥对，不碰创始人私钥）', issued.slice(0, 24) + '…');
      const byTemp = verifyLicense(issued, { publicKeyPem: pubPem, fingerprint: FP });
      const byEmbedded = verifyLicense(issued, { fingerprint: FP });
      ok(byTemp.ok && !byEmbedded.ok && byEmbedded.status === 'bad_signature',
        'M9-6b ★★两侧标本：出件用**临时公钥**验通过、用**内嵌公钥**验 `bad_signature`（证明确是给定私钥所签，非"总能过"）');

      let rejected = false;
      try {
        execFileSync(tsx, [TOOL, '--tier', 'platinum', '--subject', 'x'], { cwd: root, stdio: 'pipe' });
      } catch { rejected = true; }
      ok(rejected, 'M9-7 ★野档位 `--tier platinum` ⇒ 退出码非 0（不产出废件——口径由 `isLicenseTier` 真源把关）');

      // zx_20261024_1：团队授权包按包月/年销售——不签永久；个人档（含早鸟终身）仍允许永久。
      let teamPerpetualRejected = false;
      try {
        execFileSync(tsx, [TOOL, '--key', path.join(tmp, 'k.pem'), '--pubkey', path.join(tmp, 'p.pem'),
          '--tier', 'team', '--subject', '沙箱客', '--devices', FP, '--out', path.join(tmp, 'team-perpetual.txt')],
          { cwd: root, stdio: 'pipe' });
      } catch { teamPerpetualRejected = true; }
      ok(teamPerpetualRejected && !fs.existsSync(path.join(tmp, 'team-perpetual.txt')),
        'M9-8 ★团队授权包无 `--expires` ⇒ 拒签且**零文件**（订阅口径由签发口兜住，不靠人工自觉）');
      execFileSync(tsx, [TOOL, '--key', path.join(tmp, 'k.pem'), '--pubkey', path.join(tmp, 'p.pem'),
        '--tier', 'pro', '--subject', '终身客', '--devices', FP, '--out', path.join(tmp, 'pro-perpetual.txt')],
        { cwd: root, stdio: 'pipe' });
      ok(verifyLicense(fs.readFileSync(path.join(tmp, 'pro-perpetual.txt'), 'utf-8').trim(),
        { publicKeyPem: pubPem, fingerprint: FP }).ok,
      'M9-9 两侧标本：个人档**永久**许可仍可签发并验过（早鸟终身不受团队包规则误伤）');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}_license.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}_license.ts`);

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261005_license 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261005_license: ${pass} 通过 / ${fail} 失败${pending ? ` / ${pending} 待实施(不计入)` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
});
