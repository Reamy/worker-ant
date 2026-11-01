/**
 * zx_20261030_3 受控复跑 —— 「常」设备指纹：所绑之机，当是此机；所记之心，不当随波。
 *
 * 病根（见 plans/improve/zx_20261030_3.md §1）：指纹原算法把 `机器标识|主机名|平台|架构|MAC`
 * 五路全掺进哈希（`formatFingerprint`），于是**任何一项日常变动都掉授权**——实测同一台开发机
 * 6 天内四个指纹（`data/licenses/` 留档），最后两次相隔不到一小时。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §M1 判据 —— 金标值（算法**不得静默变更**）。
 *   两个算法各喂固定输入、钉**具体串**。存量许可的 `devices` 里躺着的就是旧算法的输出，
 *   任何"顺手重构"改掉一个字节，就等于让全部已售许可失效——这是本文件最硬的一道钉。
 *
 * §M2 判据 —— 稳定性矩阵（两侧）。
 *   主机名/网卡/平台/架构变 ⇒ 主指纹**不变**、兼容指纹**变**；机器标识变 ⇒ 两者都变；
 *   读不到机器标识 ⇒ 主指纹如实降级为合成（仍随主机名变，不退成常量）。
 *
 * §M3 判据 —— 端到端（`resolveLicenseState` / `resolveLicenseTier` / `activateLicense`）。
 *   绑旧算法指纹的许可在候选集下判 `licensed`；只给主指纹即 `device_mismatch`（救它的是候选集）；
 *   **陌生指纹给全候选集仍拒**（候选集只放宽"哪些串算本机"，不放宽绑定判定）；掉档说明带当前指纹。
 *
 * §M4 判据 —— 接线与单一真源。
 *   算法产出口只有一处（`createHash` 恰 1 处）；候选来源形状唯一；IPC 壳不自算指纹；
 *   签发工具的 `--print-fingerprint` 报主指纹；设置页如实说明在场且仍显示该指纹。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 用生产函数（指纹/状态解析/激活一律调 `core/license.ts` 导出，不复刻等价物）。
 *   G-2 两侧标本（存量仍命中 / 陌生仍拒；稳定性 / 机器标识变）。
 *   G-4 不依赖真实墙钟与真机：全部注入 `now` 与 `fingerprint(s)`。
 *   G-5 静态判据读**原文**（去注释在本仓是静默毁伤）。
 *   G-6 无轮次字面量：方案路径与脚本名由 `path.basename(__filename)` 派生。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import {
  LICENSE_SETTING_KEYS,
  formatFingerprint, stableFingerprint, deviceFingerprint, deviceFingerprints, fingerprintDiagnostics,
  encodeLicense, verifyLicense, resolveLicenseState, resolveLicenseTier, activateLicense,
  type FingerprintInputs, type LicensePayload, type LicenseSettingDb,
} from '../apps/worker-ant-desktop/src/main/core/license.js';

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
const A = 'apps/worker-ant-desktop';
/** 静态判据读**原文**（G-5）。 */
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
/** 本轮标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');

/* ── 夹具 ────────────────────────────────────────────────────────────────── */
const TEST_KEYS = crypto.generateKeyPairSync('ed25519');
const TEST_PRIVATE_PEM = TEST_KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const TEST_PUBLIC_PEM = TEST_KEYS.publicKey.export({ type: 'spki', format: 'pem' }) as string;

const NOW = new Date('2026-10-30T00:00:00.000Z');
/** 固定输入：夹具一律用它，断言不碰真机（G-4）。 */
const FP_IN: FingerprintInputs = {
  platform: 'darwin', arch: 'arm64', hostname: 'h1', machineId: 'MID-1', mac: 'aa:bb:cc:dd:ee:ff',
};
const LEGACY = formatFingerprint(FP_IN);
const STABLE = stableFingerprint(FP_IN);

const payload = (over: Partial<LicensePayload> = {}): LicensePayload => ({
  v: 1, tier: 'team', subject: '沙箱客', issuedAt: '2026-10-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z', devices: [], ...over,
});
const sign = (p: LicensePayload): string => encodeLicense(p, TEST_PRIVATE_PEM);

function licDb(settings: Record<string, string> = {}): LicenseSettingDb {
  const d = new DatabaseSync(':memory:');
  d.exec("CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))");
  for (const [k, v] of Object.entries(settings)) d.prepare('INSERT INTO wa_settings (key,value) VALUES (?,?)').run(k, v);
  return d as unknown as LicenseSettingDb;
}
type WriteDb = LicenseSettingDb & { prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown } };

function main(): void {
  // ═══ M1 金标值（算法不得静默变更）═════════════════════════════════════════
  console.log('\n【M1】金标值（存量许可的判定尺，改一位即让已售许可全部失效）');
  {
    eq(formatFingerprint(FP_IN), '09EA-6A70-734A-91F0',
      'M1-1 ★★兼容指纹（旧算法）金标：`darwin/arm64|h1|MID-1|aa:bb:cc:dd:ee:ff` ⇒ 固定串（字节语义不得动）');
    eq(stableFingerprint(FP_IN), '1CC0-7558-E061-1A75',
      'M1-2 ★★主指纹金标：同一输入 ⇒ 固定串（只取机器标识）');
    const noMid: FingerprintInputs = { ...FP_IN, machineId: null };
    eq(formatFingerprint(noMid), 'E575-2768-C8EB-A5AF',
      'M1-3 ★读不到机器标识的兼容指纹金标（旧件同样钉死）');
    eq(stableFingerprint(noMid), 'BFFD-3B20-B111-8549',
      'M1-4 ★读不到机器标识的主指纹金标（降级合成同样钉死）');
    ok(LEGACY !== STABLE,
      'M1-5 两个算法对同一输入产出**不同串**（同机必须同时产出两个候选，存量件才有处可认）',
      `${LEGACY} vs ${STABLE}`);
  }

  // ═══ M2 稳定性矩阵（两侧）══════════════════════════════════════════════════
  console.log('\n【M2】稳定性矩阵（易变项不进主指纹；机器标识进）');
  {
    const vary = (patch: Partial<FingerprintInputs>) => ({
      stableSame: stableFingerprint({ ...FP_IN, ...patch }) === STABLE,
      legacySame: formatFingerprint({ ...FP_IN, ...patch }) === LEGACY,
    });
    eq(vary({ hostname: 'Reamy-MacBook-Pro-1637.local' }), { stableSame: true, legacySame: false },
      'M2-1 ★主机名变（Bonjour 撞名追加后缀）⇒ 主指纹不变、兼容指纹变（病根标本①）');
    eq(vary({ mac: '02:00:00:00:00:00' }), { stableSame: true, legacySame: false },
      'M2-2 ★网卡变（换坞站/热点/私有 Wi-Fi 地址）⇒ 主指纹不变、兼容指纹变（病根标本②）');
    eq(vary({ platform: 'linux' }), { stableSame: true, legacySame: false },
      'M2-3 平台变 ⇒ 主指纹不变、兼容指纹变');
    eq(vary({ arch: 'x64' }), { stableSame: true, legacySame: false },
      'M2-4 ★架构变（Rosetta 下 arm64↔x64）⇒ 主指纹不变、兼容指纹变（病根标本③）');
    eq(vary({ machineId: 'MID-2' }), { stableSame: false, legacySame: false },
      'M2-5 ★另一端标本：**机器标识变 ⇒ 两个算法都变**（换机器仍然掉绑定）');
    const noMid: FingerprintInputs = { ...FP_IN, machineId: null };
    ok(
      stableFingerprint(noMid) !== stableFingerprint({ ...noMid, hostname: 'h2' })
      && stableFingerprint(noMid) !== stableFingerprint({ ...noMid, mac: null }),
      'M2-6 读不到机器标识 ⇒ 主指纹**如实降级为合成**（仍随主机名/MAC 变，不退成所有机器共用的常量）',
    );
  }

  // ═══ M3 端到端（状态解析 / 激活 / 候选集）══════════════════════════════════
  console.log('\n【M3】端到端（存量件仍命中 / 陌生件仍拒 / 掉档有说明）');
  {
    const legacyLic = sign(payload({ devices: [LEGACY] }));
    const withCands = { now: NOW, fingerprints: [STABLE, LEGACY], publicKeyPem: TEST_PUBLIC_PEM };

    const stOld = resolveLicenseState(licDb({ [LICENSE_SETTING_KEYS.key]: legacyLic }), withCands);
    eq([stOld.kind, stOld.tier], ['licensed', 'team'],
      'M3-1 ★★存量许可（绑旧算法指纹）在候选集下判 `licensed`（改算法不让人掉档）');
    eq(stOld.fingerprint, STABLE,
      'M3-2 ★界面显示的 `LicenseState.fingerprint` 是**主指纹**（签发/展示同一个串）');

    const stSingle = resolveLicenseState(licDb({ [LICENSE_SETTING_KEYS.key]: legacyLic }), { now: NOW, fingerprint: STABLE, publicKeyPem: TEST_PUBLIC_PEM });
    ok(stSingle.kind === 'invalid' && stSingle.detail.includes('不在该许可的设备列表'),
      'M3-3 ★反证：只给主指纹 ⇒ 同一份存量件判 `invalid`（救它的是候选集，不是把比对放松了）', stSingle.detail);

    const strangerLic = sign(payload({ devices: ['9999-9999-9999-9999'] }));
    const stStranger = resolveLicenseState(licDb({ [LICENSE_SETTING_KEYS.key]: strangerLic }), withCands);
    ok(stStranger.kind === 'invalid' && stStranger.detail.includes(STABLE),
      'M3-4 ★★另一端：给**完整候选集**，陌生人绑定的许可仍 `invalid`，说明里带当前指纹', stStranger.detail);
    ok(stStranger.detail.includes('机器标识=') && stStranger.detail.includes('主机名='),
      'M3-5 掉档说明含**脱敏诊断**（机器标识有/无 · 主机名 · 平台/架构 · 网卡），用户可自查哪一项', stStranger.detail);

    eq(resolveLicenseTier(licDb({ [LICENSE_SETTING_KEYS.key]: legacyLic }), withCands), 'team',
      'M3-6 软闸取档入口 `resolveLicenseTier` 同样认候选集（软闸与显示同一把尺）');

    const dbW = licDb() as WriteDb;
    const act = activateLicense(dbW, legacyLic, withCands);
    const row = (dbW as unknown as LicenseSettingDb).prepare('SELECT value FROM wa_settings WHERE key=?').get(LICENSE_SETTING_KEYS.key) as { value?: string } | undefined;
    ok(act.ok && act.state.kind === 'licensed' && row?.value === legacyLic.trim(),
      'M3-7 ★0→1 正面断言：存量件**可激活**（`license.key` 由无到有）——否则老用户换机重激活必失败');

    // 生产路径（不注入）：界面指纹必须就是主指纹——防止"显示一个、签发用另一个"。
    eq(resolveLicenseState(null).fingerprint, deviceFingerprint(),
      'M3-8 ★不注入时 `LicenseState.fingerprint` === `deviceFingerprint()`（显示与签发的同一串）');
    const pairs = deviceFingerprints();
    ok(pairs.includes(deviceFingerprint()) && new Set(pairs).size === pairs.length && pairs.length <= 2,
      'M3-9 本机候选 = 去重后的 [主指纹(, 兼容指纹)]，必含主指纹', pairs.join(' / '));
    ok(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(deviceFingerprint()),
      'M3-10 主指纹形状 `XXXX-XXXX-XXXX-XXXX`（用户要把它发给签发方）');
    const diag = fingerprintDiagnostics({ ...FP_IN, mac: 'aa:bb:cc:dd:ee:ff' });
    const diagNoMid = fingerprintDiagnostics({ ...FP_IN, machineId: null, mac: null });
    ok(/机器标识=已读到/.test(diag) && /主机名=h1/.test(diag) && /网卡=aa:bb:cc:\*\*:\*\*/.test(diag) && !/dd:ee:ff/.test(diag),
      'M3-11 诊断串如实且**脱敏**（MAC 只报前三段；不掉出整串网卡地址）', diag);
    ok(/机器标识=读不到（已退合成指纹）/.test(diagNoMid) && /网卡=读不到/.test(diagNoMid),
      'M3-12 读不到机器标识/网卡时诊断**如实写读不到**（不伪造成"已读到"）', diagNoMid);
  }

  // ═══ M4 接线与单一真源 ═════════════════════════════════════════════════════
  console.log('\n【M4】接线与单一真源（算法一处产出口 / 壳不自算 / 工具报主指纹 / 界面文案）');
  {
    const LIC = RD(`${A}/src/main/core/license.ts`);
    const LIC_IPC = RD(`${A}/src/main/ipc/license.ipc.ts`);
    const TOOL = RD('scripts/issue-license.ts');
    const SET = RD(`${A}/renderer/src/pages/SettingsPage.tsx`);

    eq((LIC.match(/createHash\('sha256'\)/g) ?? []).length, 1,
      'M4-1 ★★算法产出口唯一：`license.ts` 内 `createHash(\'sha256\')` **恰 1 处**（两个指纹共用一个形函数，禁第二份实现）');
    eq((LIC.match(/fingerprintPair\(\)\./g) ?? []).length, 2,
      'M4-2 ★`deviceFingerprint()` 与 `deviceFingerprints()` **同引** `fingerprintPair()` 的缓存（一次采集，不重复 execFileSync）');
    ok(/opts\.fingerprints\s*\?\?\s*\(opts\.fingerprint !== undefined \? \[opts\.fingerprint\] : deviceFingerprints\(\)\)/.test(LIC),
      'M4-3 ★★候选来源形状唯一：`opts.fingerprints ?? (单值 ? [单值] : deviceFingerprints())`（不设第二处判据）');
    ok(/payload\.devices\.some\(\(d\) => cands\.includes\(d\)\)/.test(LIC),
      'M4-4 ★绑定判定是"候选命其一"（不是改写成 `devices` 与候选求并后再比长度之类的等价物）');

    ok(!/stableFingerprint|formatFingerprint|deviceFingerprint|fingerprintDiagnostics/.test(LIC_IPC),
      'M4-5 ★反证：IPC 壳**不自算指纹**（指纹只在 core 一处产出，壳只透传 `resolveLicenseState` 的结果）');
    ok(/resolveLicenseState\(db\)/.test(LIC_IPC),
      'M4-6 `license:status` 取的是 core 的状态解析（薄壳）');

    ok(/flags\.has\('print-fingerprint'\)/.test(TOOL) && /function printFingerprint\(\)/.test(TOOL),
      'M4-7 签发工具 `--print-fingerprint` 在册（不开 GUI 也能取本机指纹——本轮重签用的就是它）');
    ok(/const primary = deviceFingerprint\(\);/.test(TOOL) && !/console\.log\([^)]*formatFingerprint\(/.test(TOOL),
      'M4-8 ★工具报的是**主指纹**（`deviceFingerprint()`），不是旧算法串（签发写错串＝用户激活不上）');
    ok(/deviceFingerprints\(\)/.test(TOOL),
      'M4-9 工具同屏给出兼容指纹（承诺"旧件按它判定"，兑现处须在册）');

    ok(/换网络、改机器名不会变/.test(SET),
      'M4-10 ★设置页如实说明在场（renderer 是词表第二落点：用户读到的正是这条承诺）');
    ok(/lic\?\.fingerprint/.test(SET),
      'M4-11 设置页仍显示 `LicenseState.fingerprint`（不新开第二个字段，避免两处各显示一个）');
  }

  // ═══ S 哑雷自检 + build 钉 ═════════════════════════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 ★方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，进程会在 unhandled rejection 之前被带走 ⇒ 假绿。
try {
  main();
} catch (e: unknown) {
  console.error(`\n💥 rr_zx_20261030_3 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
} finally {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261030_3: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}
