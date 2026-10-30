#!/usr/bin/env node
/**
 * 许可签发工具 —— **创始人本地用**（zx_20261005 M9；承 K-2 离线签名许可）。
 *
 * 三条硬约束（都是裁定/纪律，不是喜好）：
 *   ① **私钥绝不入库**：默认落 `data/license-signing-key.pem`（`.gitignore` 已挡 `**\/license-signing-key*.pem`），
 *      文件权限 0600。仓库里只有**公钥**（`core/license.ts` 的 `@license-public-key` 块）。
 *   ② **一份真源**：签发用 `license.ts` 的 `encodeLicense`（与验签同源）——不在这里复刻一份签名逻辑，
 *      否则"签得出、App 验不过"就是必然。
 *   ③ **签前先自证**：签完立刻用内嵌公钥 `verifyLicense` 复核一遍；不过就**不出文件**（免得把废件发出去）。
 *
 * 用法（`npx tsx scripts/issue-license.ts <子命令>`）：
 *
 *   # 1) 首启或轮换密钥：生成 Ed25519 密钥对 → 写私钥 + **重写** core/license.ts 的公钥块
 *   npx tsx scripts/issue-license.ts --gen-keys
 *
 *   # 2) 签发一份许可（用户先用 App「设置 → 许可」抄来本机指纹，一并发来）
 *   npx tsx scripts/issue-license.ts \
 *       --tier pro --subject "张三 <zhangsan@example.com>" \
 *       --expires 2027-10-05 --devices AAAA-BBBB-CCCC-DDDD,EEEE-FFFF-0000-1111 \
 *       --out data/licenses/zhangsan.txt
 *   #    --expires 省略 或 --perpetual ⇒ 永久（expiresAt=null；**团队档不签永久**，见下）
 *   #    --expires YYYY-MM-DD ⇒ 该日在**目标时区**的 23:59:59.999（缺省=签发机本地时区）
 *   #    --tz Asia/Shanghai ⇒ 按买受人所在时区取当日末（IANA 时区名）；证书内写显式偏移
 *   #    --devices 省略 ⇒ community/pro 不绑设备（任何机器可激活）；**team 省略则拒签**——
 *   #      一包一证、绑定节点；确需不绑定请显式加 `--any-device`（会打警告）。
 *   #    --devices 可绑台数按档位：community/pro ≤3；**team（团队授权包）≤20**，与协同节点上限同源。
 *   #    ⚠ `--tier team` **必须带 --expires**（按包月/年销售，到期续签；不签永久）。
 *   #    --early-bird ⇒ 早鸟终身（一次性买断 Pro 终身，永久件，不接受 --expires/--perpetual）；
 *   #      每次签发在 `data/early-bird-redemptions.jsonl` 记一行，满 `EARLY_BIRD.seats` 席即拒签。
 *   #    --key <path> 换私钥路径；--pubkey <path> 覆盖自证用公钥（默认本仓内嵌，供轮换预检/自测）
 *
 *   # 3) 复核一份许可（用当前内嵌公钥验；**不碰私钥**，可对收到的文件反向查）
 *   npx tsx scripts/issue-license.ts --verify data/licenses/zhangsan.txt
 *
 * ⚠ `--gen-keys` 会改动 `core/license.ts` ⇒ 之后须重新 `tsup` 构建桌面端；且**用旧私钥签发的许可全部失效**
 *   （公钥已换）。生产首启时执行一次即可。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LICENSE_PREFIX, LICENSE_PUBLIC_KEY_PEM, licenseDeviceCap,
  encodeLicense, verifyLicense, type LicensePayload,
} from '../apps/worker-ant-desktop/src/main/core/license.js';

import { LICENSE_TIERS, isLicenseTier, TIER_LABEL, type LicenseTier } from '../apps/worker-ant-desktop/src/main/core/feature-limits.js';
import { EARLY_BIRD } from '../apps/worker-ant-desktop/src/main/core/pricing.js';
import {
  countRedemptions, earlyBirdRefusal, earlyBirdRemaining, redemptionLine,
} from '../apps/worker-ant-desktop/src/main/core/early-bird.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 私钥**默认**落点（gitignored）。`--key <path>` 可改；不入库是纪律，换路径同样不入库。 */
const DEFAULT_KEY_PATH = path.join(ROOT, 'data', 'license-signing-key.pem');
/** 公钥块（`--gen-keys` 重写它）。 */
const LICENSE_TS = path.join(ROOT, 'apps', 'worker-ant-desktop', 'src', 'main', 'core', 'license.ts');
/** 早鸟名额台账（gitignored 的 `data/`；一行一签，`earlyBirdRefusal` 按它判满席）。 */
const EARLY_BIRD_LEDGER = path.join(ROOT, 'data', 'early-bird-redemptions.jsonl');

const DEVICE_FP_RE = /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/;

/* ── 极简参数解析（`--k v` / `--flag`）───────────────────────────────────── */
function parseArgs(argv: string[]): { flags: Set<string>; opts: Map<string, string> } {
  const flags = new Set<string>();
  const opts = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { opts.set(key, next); i++; }
    else flags.add(key);
  }
  return { flags, opts };
}

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/* ── 子命令：--gen-keys ──────────────────────────────────────────────────── */
function genKeys(): void {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

  fs.mkdirSync(path.dirname(DEFAULT_KEY_PATH), { recursive: true });
  fs.writeFileSync(DEFAULT_KEY_PATH, privPem, { mode: 0o600 });
  try { fs.chmodSync(DEFAULT_KEY_PATH, 0o600); } catch { /* 平台不支持就跳过 */ }
  console.log(`✓ 私钥已写入 ${path.relative(ROOT, DEFAULT_KEY_PATH)}（权限 0600，gitignored——**绝不入库**）`);

  // 重写 core/license.ts 的公钥块（**只动标记块之间**，其余代码不碰）。
  const src = fs.readFileSync(LICENSE_TS, 'utf-8');
  const BEGIN = '/* @license-public-key:begin';
  const END = '/* @license-public-key:end */';
  const bi = src.indexOf(BEGIN);
  const ei = src.indexOf(END);
  if (bi < 0 || ei < 0 || ei < bi) die(`找不到公钥标记块（${BEGIN} … ${END}）于 ${path.relative(ROOT, LICENSE_TS)}`);
  const block =
    `${BEGIN} —— \`scripts/issue-license.ts --gen-keys\` 会重写本块 */\n` +
    `/** 验签公钥（SPKI PEM）。**换密钥 = 换这一块**，其余代码不动。 */\n` +
    'export const LICENSE_PUBLIC_KEY_PEM = `' + pubPem + '`;\n' +
    END;
  const updated = src.slice(0, bi) + block + src.slice(ei + END.length);
  fs.writeFileSync(LICENSE_TS, updated);
  console.log(`✓ 公钥块已重写于 ${path.relative(ROOT, LICENSE_TS)}`);
  console.log('⚠ 请重新构建桌面端（tsup）；**用旧私钥签发的许可已全部失效**。');
}

/* ── 子命令：签发 ────────────────────────────────────────────────────────── */
// zx_20261018_3 D14b（组6 反馈）: 旧的 `YYYY-MM-DDT23:59:59.999Z` 是"UTC 的当日末"——
//   对 UTC+8 的持证人实际落在**次日 07:59**（买"到 10-18"却 10-19 才失效）。
//   改为在**目标时区**算当日最后一刻，并把偏移写进载荷（如 `+08:00`），证书自解释。
//   `--tz` 指定 IANA 时区（缺省=签发机本地时区）；完整 ISO 仍原样透传。
function pad2(n: number): string { return String(n).padStart(2, '0'); }
function offsetSuffix(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}
function partsInTz(at: Date, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const p: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  for (const x of fmt.formatToParts(at)) if (x.type !== 'literal') p[x.type] = x.value;
  return {
    y: Number(p.year), mo: Number(p.month), d: Number(p.day),
    // 某些 ICU 版本零点给 "24"；归一到 0（日期不变）
    h: Number(p.hour === '24' ? '0' : p.hour), mi: Number(p.minute), s: Number(p.second),
  };
}
/** `YYYY-MM-DD` → 该目标时区当日 23:59:59.999 的 ISO（带显式偏移）。 */
function endOfDayISO(date: string, tz?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) die(`--expires 不是合法日期：${date}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d)
    die(`--expires 不是合法日期：${date}`);

  if (!tz) {
    // 本地时区：直接按本地墙钟构造（DST 切换日由引擎判定），偏移取该时刻的实际值。
    const dt = new Date(y, mo - 1, d, 23, 59, 59, 999);
    return `${date}T23:59:59.999${offsetSuffix(-dt.getTimezoneOffset())}`;
  }

  const want = Date.UTC(y, mo - 1, d, 23, 59, 59, 999);
  let ts = want;
  try {
    for (let i = 0; i < 3; i++) {
      const p = partsInTz(new Date(ts), tz);
      const delta = want - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s, 999);
      if (delta === 0) break;
      ts += delta;
    }
  } catch {
    die(`--tz 不是合法时区：${tz}`);
  }
  const p = partsInTz(new Date(ts), tz);
  if (p.y !== y || p.mo !== mo || p.d !== d || p.h !== 23 || p.mi !== 59 || p.s !== 59)
    die(`--tz ${tz} 在 ${date} 的 23:59:59 不可达（时区跳变？）`);
  const offMin = Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s, 999) - ts) / 60000);
  return `${date}T23:59:59.999${offsetSuffix(offMin)}`;
}
function normalizeExpires(raw: string | undefined, perpetual: boolean, tz?: string): string | null {
  if (perpetual || !raw) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? endOfDayISO(raw, tz) : raw;
  if (!Number.isFinite(new Date(iso).getTime())) die(`--expires 不是合法时刻：${raw}`);
  return iso;
}

function issue(opts: Map<string, string>, keyPath: string, pubPem: string): void {
  if (!fs.existsSync(keyPath)) die(`私钥不存在：${path.relative(ROOT, keyPath)}（先跑 --gen-keys）`);

  const tierRaw = opts.get('tier') ?? 'pro';
  if (!isLicenseTier(tierRaw)) die(`--tier 须为 ${LICENSE_TIERS.join(' / ')}，实得：${tierRaw}`);
  const tier = tierRaw as LicenseTier;

  const devices = (opts.get('devices') ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const cap = licenseDeviceCap(tier);
  if (devices.length > cap) die(`设备数 ${devices.length} 超出 ${TIER_LABEL[tier]}上限 ${cap} 台`);
  for (const d of devices) if (!DEVICE_FP_RE.test(d)) die(`设备指纹形状不符（应 XXXX-XXXX-XXXX-XXXX）：${d}`);
  // zx_20261029_2 M6 空档④：团队包「一包一证、绑定节点」是销售形态，**默认拒签空白绑定**——
  //   `devices` 空 + 未显式 `--any-device` ⇒ 拒；opt-in 了也留一句警告（分发对象仍须自己控制）。
  if (devices.length === 0) {
    if (tier === 'team' && !opts.has('any-device')) {
      die('团队授权包须带 --devices（一包一证、绑定节点）；确需「不绑定=任意机器可激活」请显式加 --any-device');
    }
    console.warn('⚠ 未绑定设备：该许可可在任意机器激活（请自行控制分发对象）');
  }

  // zx_20261029_2 M6 空档⑤：早鸟终身=一次性买断 Pro 终身（永久件），名额按 `EARLY_BIRD.seats` 真源卡住。
  const earlyBird = opts.has('early-bird');
  if (earlyBird) {
    if (tier !== EARLY_BIRD.appliesTier) {
      die(`--early-bird 是「${EARLY_BIRD.label}」，能力档固定为 ${TIER_LABEL[EARLY_BIRD.appliesTier]}；实得 --tier ${tier}`);
    }
    if (opts.has('expires') || opts.has('perpetual') || opts.has('no-expire')) {
      die('--early-bird 是「一次性买断 Pro 终身」⇒ 签发即永久，不接受 --expires/--perpetual');
    }
  }
  const redeemed = earlyBird && fs.existsSync(EARLY_BIRD_LEDGER)
    ? countRedemptions(fs.readFileSync(EARLY_BIRD_LEDGER, 'utf-8'))
    : 0;
  if (earlyBird) {
    const refusal = earlyBirdRefusal(redeemed);
    if (refusal) die(refusal);
  }

  const expiresAt = earlyBird
    ? null
    : normalizeExpires(opts.get('expires'), opts.has('perpetual') || opts.has('no-expire'), opts.get('tz'));
  if (tier === 'team' && expiresAt === null) {
    die('团队授权包必须带 --expires（按月/年销售，到期续签）——不签永久团队许可');
  }

  const payload: LicensePayload = {
    v: 1,
    tier,
    subject: opts.get('subject') ?? '未署名',
    issuedAt: new Date().toISOString(),
    expiresAt,
    devices,
  };

  const lic = encodeLicense(payload, fs.readFileSync(keyPath, 'utf-8'));

  // ③ 签前自证：用**当前内嵌公钥**验一遍（`--pubkey` 可覆盖，供轮换前的预检/自测）。
  const v = verifyLicense(lic, { fingerprint: devices[0] ?? '0000-0000-0000-0000', publicKeyPem: pubPem });
  if (!v.ok) die(`自证失败（${v.status}）：${v.detail} —— 多半是公钥与私钥不配对（core/license.ts 的公钥块是否由本次私钥 --gen-keys 产出？）`);
  console.log(`✓ 自证通过：${v.detail}`);

  const out = opts.get('out');
  if (out) {
    const outPath = path.isAbsolute(out) ? out : path.join(ROOT, out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, lic + '\n');
    console.log(`✓ 许可已写入 ${path.relative(ROOT, outPath)}`);
  }
  // 早鸟名额**签成才记账**（自证不过/拒签都不会走到这里，名额不会被白占）。
  if (earlyBird) {
    fs.mkdirSync(path.dirname(EARLY_BIRD_LEDGER), { recursive: true });
    fs.appendFileSync(EARLY_BIRD_LEDGER, redemptionLine({
      at: payload.issuedAt, subject: payload.subject, tier, expiresAt, devices: devices.length,
    }));
    console.log(`✓ 早鸟名额已登记：${path.relative(ROOT, EARLY_BIRD_LEDGER)}`);
  }
  console.log(`\n档位：${TIER_LABEL[tier]}（${tier}）｜被许可人：${payload.subject}｜到期：${payload.expiresAt ?? '永久'}`);
  console.log(`绑定设备：${devices.length ? devices.join(', ') : '（不绑设备）'}｜本档上限 ${cap} 台`);
  if (earlyBird) {
    console.log(`早鸟名额：已登记 ${redeemed + 1}/${EARLY_BIRD.seats}，余 ${earlyBirdRemaining(redeemed + 1)} 席`);
  }
  console.log('\n──── 许可文本（把这段发给用户）────');
  console.log(lic);
}

/* ── 子命令：--verify ────────────────────────────────────────────────────── */
/** 从许可文本里解出载荷（**只为复核工具拿设备列表**；不参与验签——验签仍走 `verifyLicense`）。 */
function decodePayloadDevicesFirst(text: string): string {
  const parts = text.trim().split('.');
  if (parts.length !== 3) return '0000-0000-0000-0000';
  try {
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const p = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf-8')) as { devices?: string[] };
    return p.devices?.[0] ?? '0000-0000-0000-0000';
  } catch { return '0000-0000-0000-0000'; }
}

function verifyFile(p: string): void {
  const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
  if (!fs.existsSync(abs)) die(`文件不存在：${p}`);
  const text = fs.readFileSync(abs, 'utf-8');
  // 本机指纹不参与（签发方与用户往往不是同一台）；这里看签名/格式/到期，设备绑定交由用户机。
  // 喂进**文件自身第一个设备指纹**只为绕开 device_mismatch 这一关（空列表则任何指纹都过）。
  const v = verifyLicense(text, { fingerprint: decodePayloadDevicesFirst(text) });
  if (!v.ok) die(`复核未过（${v.status}）：${v.detail}`);
  console.log(`✓ 复核通过：${v.detail}`);
  console.log(`  载荷：${JSON.stringify(v.payload)}`);
}

/* ── main ────────────────────────────────────────────────────────────────── */
function main(): void {
  const { flags, opts } = parseArgs(process.argv.slice(2));
  const keyPath = opts.get('key') ? path.resolve(ROOT, opts.get('key')!) : DEFAULT_KEY_PATH;

  if (flags.has('gen-keys')) { genKeys(); return; }
  // `--verify <path>` 带值 ⇒ 落在 opts（不是 flags）；两种写法都认。
  const verifyTarget = opts.get('verify') ?? opts.get('file');
  if (verifyTarget !== undefined || flags.has('verify')) {
    if (!verifyTarget) die('--verify 需要文件路径，如 `--verify data/licenses/x.txt`');
    verifyFile(verifyTarget); return;
  }
  if (flags.has('help') || process.argv.length <= 2) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('*/')[0]);
    console.log(`内嵌公钥指纹：${crypto.createHash('sha256').update(LICENSE_PUBLIC_KEY_PEM).digest('hex').slice(0, 16).toUpperCase()}`);
    console.log(`前缀：${LICENSE_PREFIX}｜设备上限：community/pro ${licenseDeviceCap('community')} 台 · team ${licenseDeviceCap('team')} 台`);
    return;
  }
  const pubPem = opts.get('pubkey')
    ? fs.readFileSync(path.resolve(ROOT, opts.get('pubkey')!), 'utf-8')
    : LICENSE_PUBLIC_KEY_PEM;
  issue(opts, keyPath, pubPem);
}

main();
