/**
 * 离线许可：Ed25519 签名文件 + 本机公钥校验（zx_20261005 M6；K-2 裁定＝**离线签名许可**）。
 *
 * 设计约束（三条都是裁定/纪律，不是喜好）：
 *   K-2 **离线**——不设激活服务器、不联网校验。许可是一段**自证**的文本：内嵌公钥验签即可。
 *   K-5 **个人档设备绑定 ≤ 3 台、团队授权包 ≤ 20 台**（`licenseDeviceCap`，team 与 `maxNodes` 同源）——
 *       超出的机器**由创始人重签**（首版不做自动换绑）。
 *   K-3 **软闸**——校验失败**fail-open 到 `community` 档**（产品照常可用），**绝不** fail-closed 到"打不开"。
 *       见 `resolveLicenseState`：任何异常都退 `community`，不 throw。
 *
 * 私钥**绝不入库**（`data/license-signing-key.pem`，gitignored）；公钥随本文件入库。
 * 签发工具见 `scripts/issue-license.ts`（`--gen-keys` 会重写本文件的公钥块）。
 *
 * ⚠ 本文件里的 `signLicense` 是**给签发工具用的**（与验签同源，防两处格式漂移）。App 打包时它一起进包，
 *   但 App 侧**没有任何调用方**——且它需要私钥才能用，包里没有私钥。
 */
import { createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { isLicenseTier, TIER_LABEL, TIER_LIMITS, type LicenseTier } from './feature-limits.js';
// zx_20261023_5 批五：云端权益**只升不降**地并入生效档位（纯逻辑在 cloud-entitlement.ts；
//   网络在 entitlement-client.ts——许可热路径只多一次设置读取，不拖 ANS SDK 进来）。
import { cloudActiveTier, mergeLicenseTier } from './cloud-entitlement.js';

/** 许可文本前缀（格式版本）。改格式即改它 + `v` 字段，双标防"旧工具签新文本"。 */
export const LICENSE_PREFIX = 'WA-LICENSE-v1';

/** K-5：个人档（community / pro）一台许可最多绑几台机器。 */
export const MAX_LICENSE_DEVICES = 3;

/**
 * 档位化的设备绑定上限：团队授权包是「一包 ≤20 节点」，一张许可须覆盖整包。
 * team 的上限**取 `TIER_LIMITS.team.maxNodes`（与协同节点闸同源）**，不另抄一个 20；
 * 其余档位仍走 K-5 的 3 台。
 */
export function licenseDeviceCap(tier: LicenseTier): number {
  const nodes = TIER_LIMITS[tier].maxNodes;
  return tier === 'team' && nodes > 0 ? nodes : MAX_LICENSE_DEVICES;
}

/** M7：试用天数。 */
export const TRIAL_DAYS = 14;

/* @license-public-key:begin —— `scripts/issue-license.ts --gen-keys` 会重写本块 */
/** 验签公钥（SPKI PEM）。**换密钥 = 换这一块**，其余代码不动。 */
export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA+18eeD1E6+PB48S0RvkBFtLshjeFn76ZsrrJzEtxd6g=
-----END PUBLIC KEY-----
`;
/* @license-public-key:end */

/** `wa_settings` 键名——**只此一处**（读写两端都引它，防"写 a 读 b"）。 */
export const LICENSE_SETTING_KEYS = {
  key: 'license.key',
  activatedAt: 'license.activated_at',
  trialStartedAt: 'license.trial_started_at',
} as const;

export interface LicensePayload {
  /** 格式版本 */
  v: number;
  tier: LicenseTier;
  /** 被许可人（人话，显示用；不参与校验） */
  subject: string;
  /** 签发时刻 ISO */
  issuedAt: string;
  /** 到期时刻 ISO；`null` = 永久 */
  expiresAt: string | null;
  /** 绑定的设备指纹（≤ `licenseDeviceCap(tier)`；空数组 = 不绑设备） */
  devices: string[];
}

/* ── 设备指纹 ───────────────────────────────────────────────────────────────
 * ⚠ 承 zx_20261005 方案 M6 细节："**非 MAC 单点**"——网卡是会换的（换坞站、开虚拟机桥接都会变），
 *   单靠 MAC 会让同一台机器"今天激活、明天失效"。故取 `机器稳定标识 + 主机名 + 平台 + 架构 + MAC`
 *   的**合成**，任一读不到都不致命（退空串参与哈希）。
 */

export interface FingerprintInputs {
  platform: string;
  arch: string;
  hostname: string;
  /** 平台稳定机器标识（macOS=IOPlatformUUID / Linux=/etc/machine-id / Win=MachineGuid）；读不到为 null */
  machineId: string | null;
  /** 首个非内部网卡的 MAC；读不到为 null */
  mac: string | null;
}

/** 纯函数：由给定输入算指纹（rr 直接喂固定输入 ⇒ 不碰真实机器，G-1/G-4）。 */
export function formatFingerprint(inputs: FingerprintInputs): string {
  const material = [inputs.machineId ?? '', inputs.hostname, inputs.platform, inputs.arch, inputs.mac ?? ''].join('|');
  const hex = createHash('sha256').update(material).digest('hex').slice(0, 16).toUpperCase();
  return (hex.match(/.{4}/g) ?? []).join('-');
}

/** 采集本机输入。**任何一步失败都退 null**，绝不 throw（许可校验宁缺勿炸）。 */
export function collectFingerprintInputs(): FingerprintInputs {
  const inputs: FingerprintInputs = {
    platform: process.platform,
    arch: process.arch,
    hostname: '',
    machineId: null,
    mac: null,
  };
  try { inputs.hostname = os.hostname(); } catch { /* 留空串 */ }
  try {
    const nics = os.networkInterfaces();
    for (const list of Object.values(nics)) {
      const hit = (list ?? []).find((n) => !n.internal && n.mac && n.mac !== '00:00:00:00:00:00');
      if (hit) { inputs.mac = hit.mac; break; }
    }
  } catch { /* 留 null */ }
  inputs.machineId = readMachineId();
  return inputs;
}

function readMachineId(): string | null {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf-8', timeout: 4000 });
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? null;
    }
    if (process.platform === 'linux') {
      const p = '/etc/machine-id';
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8').trim() || null : null;
    }
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf-8', timeout: 4000 });
      return /MachineGuid\s+REG_SZ\s+([^\r\n]+)/.exec(out)?.[1]?.trim() ?? null;
    }
  } catch { /* 读不到就是 null——多平台差异不该让许可校验炸掉 */ }
  return null;
}

/** 本机指纹（生产用）。**进程内记忆一次**——软闸（M7）在调度热路径上每次都要读档位，
 *  而采指纹要 `execFileSync ioreg`（~20ms/次）；不记忆＝每个调度 tick 都去开一次子进程。
 *  指纹是"这台机器"的标识，进程生命周期内不变；按一次算一次即可。 */
let cachedFingerprint: string | null = null;
export function deviceFingerprint(): string {
  if (cachedFingerprint === null) cachedFingerprint = formatFingerprint(collectFingerprintInputs());
  return cachedFingerprint;
}

/* ── 编解码 + 验签 ──────────────────────────────────────────────────────── */

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** 被签的字节串——**只此一处**（签与验同源，否则一个空格就能让全部许可失效）。 */
export function licenseSigningBytes(payloadB64: string): Buffer {
  return Buffer.from(`${LICENSE_PREFIX}.${payloadB64}`, 'utf-8');
}

/** 编码（签发用）：`WA-LICENSE-v1.<payload>.<sig>`。 */
export function encodeLicense(payload: LicensePayload, privateKeyPem: string): string {
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf-8'));
  const sig = cryptoSign(null, licenseSigningBytes(payloadB64), privateKeyPem);
  return `${LICENSE_PREFIX}.${payloadB64}.${b64url(sig)}`;
}

/** 签发（**仅签发工具用**；App 侧无调用方，也没有私钥）。 */
export function signLicense(payload: LicensePayload, privateKeyPem: string): string {
  return encodeLicense(payload, privateKeyPem);
}

export type LicenseStatus =
  | 'valid'
  | 'bad_format'
  | 'bad_signature'
  | 'expired'
  | 'device_mismatch'
  | 'too_many_devices'
  | 'bad_payload';

export interface VerifyResult {
  ok: boolean;
  status: LicenseStatus;
  /** 如实说明（界面直接上屏，不写"校验失败"四个字了事） */
  detail: string;
  payload?: LicensePayload;
}

export interface VerifyOpts {
  publicKeyPem?: string;
  now?: Date;
  /** 本机指纹；不传则现采（rr 一律传，免得判据依赖真实机器） */
  fingerprint?: string;
}

/** 验签 + 到期 + 设备绑定 + K-5 结构上限。**不 throw**——任何异常都落到某个 status。 */
export function verifyLicense(licenseText: string, opts: VerifyOpts = {}): VerifyResult {
  const now = opts.now ?? new Date();
  const pem = opts.publicKeyPem ?? LICENSE_PUBLIC_KEY_PEM;
  const text = (licenseText ?? '').trim();
  if (!text) return { ok: false, status: 'bad_format', detail: '许可为空' };

  const parts = text.split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) {
    return { ok: false, status: 'bad_format', detail: `许可格式不符（应为 ${LICENSE_PREFIX}.<载荷>.<签名>）` };
  }
  const [, payloadB64, sigB64] = parts as [string, string, string];

  let payload: LicensePayload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString('utf-8')) as LicensePayload;
  } catch {
    return { ok: false, status: 'bad_payload', detail: '许可载荷不是合法 JSON' };
  }

  let sigOk = false;
  try {
    const key = createPublicKey(pem);
    sigOk = cryptoVerify(null, licenseSigningBytes(payloadB64), key, fromB64url(sigB64));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, status: 'bad_signature', detail: '许可签名校验未通过（非本产品签发，或文本被改动）' };

  if (payload.v !== 1 || !isLicenseTier(payload.tier) || !Array.isArray(payload.devices)) {
    return { ok: false, status: 'bad_payload', detail: '许可载荷字段不合规（版本/档位/设备列表）' };
  }
  const deviceCap = licenseDeviceCap(payload.tier);
  if (payload.devices.length > deviceCap) {
    return { ok: false, status: 'too_many_devices', detail: `许可绑定了 ${payload.devices.length} 台设备，超出 ${TIER_LABEL[payload.tier]}上限 ${deviceCap} 台` };
  }
  if (payload.expiresAt) {
    const exp = new Date(payload.expiresAt);
    if (!Number.isFinite(exp.getTime())) return { ok: false, status: 'bad_payload', detail: '到期时间不是合法时刻' };
    if (exp.getTime() <= now.getTime()) {
      return { ok: false, status: 'expired', detail: `许可已于 ${payload.expiresAt} 到期` };
    }
  }
  if (payload.devices.length > 0) {
    const fp = opts.fingerprint ?? deviceFingerprint();
    if (!payload.devices.includes(fp)) {
      return { ok: false, status: 'device_mismatch', detail: '本机不在该许可的设备列表中（激活时须把本机指纹一并发给签发方）' };
    }
  }
  return { ok: true, status: 'valid', detail: `已激活：${TIER_LABEL[payload.tier]}`, payload };
}

/* ── 状态解析（软闸的输出——`task-accounting` 与 IPC/界面同引它）───────────────── */

export type LicenseKind = 'licensed' | 'trial' | 'trial_expired' | 'none' | 'invalid';

export interface LicenseState {
  /** 生效档位（**软闸读的就是它**） */
  tier: LicenseTier;
  kind: LicenseKind;
  tierLabel: string;
  /** 如实说明（界面直接上屏） */
  detail: string;
  expiresAt: string | null;
  /** 试用剩余天数；非试用态为 null */
  trialDaysLeft: number | null;
  devices: string[];
  subject: string | null;
  /** 本机指纹（M8 界面须显示它——用户要把它发给签发方） */
  fingerprint: string;
}

/** 读设置的最小库接口（同 `AnsSettingDb` 形：可脱 better-sqlite3 被 rr 直跑）。 */
export interface LicenseSettingDb {
  prepare(sql: string): { get(...args: unknown[]): unknown };
}

/** 读写设置的最小库接口（激活要落库）。 */
export interface LicenseSettingWriteDb {
  prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): unknown };
}

export interface ResolveLicenseOpts {
  now?: Date;
  fingerprint?: string;
  publicKeyPem?: string;
}

function readSetting(db: LicenseSettingDb | null | undefined, key: string): string | null {
  if (!db) return null;
  try {
    const row = db.prepare('SELECT value FROM wa_settings WHERE key=?').get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null; // 表还没建 / 库未就绪 ⇒ 当未配置（fail-open 的方向，不是"打不开"）
  }
}

/**
 * 解析当前许可状态。**任何异常都退 `community`（K-3 软闸）**——本函数不 throw。
 *
 * 优先序：有效许可 > 试用期内（视同 Pro）> 试用已过 / 未激活（community）。
 * ⚠「有 key 但校验不过」**不再回落试用**：一把坏 key 是"明确表过态却无效"，如实报 `invalid` 并退 community，
 *   免得用户以为"我还在试用"（名实相符）。
 *
 * zx_20261023_5 批五：**生效档位再并入云端权益（只升不降）**。本地算出的 `kind/expiresAt` 语义不变，
 *   只有 `tier/tierLabel` 可能被云端抬高，`detail` 追加一句为什么不一致——否则界面会出现
 *   「未激活」却用上 Pro 能力的自相矛盾。云端不可达/无权益/已过期 ⇒ 本地照旧（fail-open）。
 */
export function resolveLicenseState(db: LicenseSettingDb | null | undefined, opts: ResolveLicenseOpts = {}): LicenseState {
  const now = opts.now ?? new Date();
  const local = resolveLocalLicenseState(db, opts, now);
  const cloudTier = cloudActiveTier(db, now);
  const tier = mergeLicenseTier(local.tier, cloudTier);
  if (tier === local.tier) return local;
  return { ...local, tier, tierLabel: TIER_LABEL[tier], detail: `${local.detail}；云端权益已提升至${TIER_LABEL[tier]}` };
}

/** 纯本地判定（不看云端）——`resolveLicenseState` 的本体，单独成函数只为让云端合并留在**一处**。 */
function resolveLocalLicenseState(
  db: LicenseSettingDb | null | undefined,
  opts: ResolveLicenseOpts,
  now: Date,
): LicenseState {
  const fingerprint = opts.fingerprint ?? deviceFingerprint();
  const base = { fingerprint, expiresAt: null as string | null, devices: [] as string[], subject: null as string | null, trialDaysLeft: null as number | null };

  const licenseText = readSetting(db, LICENSE_SETTING_KEYS.key);
  if (licenseText) {
    const v = verifyLicense(licenseText, { now, fingerprint, publicKeyPem: opts.publicKeyPem });
    if (v.ok && v.payload) {
      return {
        tier: v.payload.tier, kind: 'licensed', tierLabel: TIER_LABEL[v.payload.tier], detail: v.detail,
        expiresAt: v.payload.expiresAt, devices: v.payload.devices, subject: v.payload.subject, trialDaysLeft: null, fingerprint,
      };
    }
    return { tier: 'community', kind: 'invalid', tierLabel: TIER_LABEL.community, detail: `许可无效：${v.detail}`, ...base };
  }

  const trialStart = readSetting(db, LICENSE_SETTING_KEYS.trialStartedAt);
  if (trialStart) {
    const started = new Date(trialStart);
    if (Number.isFinite(started.getTime())) {
      // zx_20261016_4: **下界钳到 0**——进程运行期（不重启）有人把库里的起算点改成**未来**时刻时，
      //   负 elapsed 会被算成"还剩更多天"。钳 0 让它在读侧**立刻**失效；写侧的防御见
      //   `core/license-anchor.ts`（`isUsableAnchor` 认未来值为不可用，重启后由另一处锚点或此刻顶掉）。
      const elapsedMs = Math.max(0, now.getTime() - started.getTime());
      const daysLeft = TRIAL_DAYS - Math.floor(elapsedMs / 86_400_000);
      if (daysLeft > 0) {
        return {
          tier: 'pro', kind: 'trial', tierLabel: TIER_LABEL.pro,
          detail: `试用中：还剩 ${daysLeft} 天（专业版能力）`,
          expiresAt: null, devices: [], subject: null, trialDaysLeft: daysLeft, fingerprint,
        };
      }
      return {
        tier: 'community', kind: 'trial_expired', tierLabel: TIER_LABEL.community,
        detail: `试用已结束（${TRIAL_DAYS} 天），已回落社区版`, ...base,
      };
    }
    return { tier: 'community', kind: 'invalid', tierLabel: TIER_LABEL.community, detail: '试用起始时间不是合法时刻', ...base };
  }

  return { tier: 'community', kind: 'none', tierLabel: TIER_LABEL.community, detail: '未激活：当前为社区版', ...base };
}

/**
 * **软闸读的就是它**——只要档位，不要那串说明/指纹。
 *
 * 薄封装（不是第二份判据）：`resolveLicenseState` 的唯一输出里取 `tier`。M7 的并发钳位与项目数配额
 * 都经此取档位，免得两处各调一次 `resolveLicenseState` 而各算各的。**本函数不 throw**。
 */
export function resolveLicenseTier(db: LicenseSettingDb | null | undefined, opts: ResolveLicenseOpts = {}): LicenseTier {
  return resolveLicenseState(db, opts).tier;
}

/** 激活：验签通过才落库（写 `license.key` + `license.activated_at`）；返回激活后的状态。 */
export function activateLicense(
  db: LicenseSettingWriteDb,
  licenseText: string,
  opts: ResolveLicenseOpts = {},
): { ok: boolean; detail: string; state: LicenseState } {
  const now = opts.now ?? new Date();
  const v = verifyLicense(licenseText, { now, fingerprint: opts.fingerprint, publicKeyPem: opts.publicKeyPem });
  if (!v.ok) return { ok: false, detail: v.detail, state: resolveLicenseState(db, opts) };
  try {
    db.prepare("INSERT OR REPLACE INTO wa_settings (key,value,updated_at) VALUES (?,?,datetime('now'))").run(LICENSE_SETTING_KEYS.key, licenseText.trim());
    db.prepare("INSERT OR REPLACE INTO wa_settings (key,value,updated_at) VALUES (?,?,datetime('now'))").run(LICENSE_SETTING_KEYS.activatedAt, now.toISOString());
  } catch (err) {
    return { ok: false, detail: `许可校验通过，但写入失败：${(err as Error).message}`, state: resolveLicenseState(db, opts) };
  }
  return { ok: true, detail: v.detail, state: resolveLicenseState(db, opts) };
}
