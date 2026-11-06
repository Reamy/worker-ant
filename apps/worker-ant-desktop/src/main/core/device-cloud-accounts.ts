/**
 * zx_20261101_2 M1「接」（庄子·道在屎溺 / 管子·度量衡）: **设备云账号的单一真源**。
 *
 * 病：0.3.0 的"三方云"只有一个涂鸦账号——凭据是三枚固定设置键，Provider id 写死 `tuya`。
 *   "再挂一个涂鸦账号""再接一套 Home Assistant"在数据模型里**无处安放**；而每账号各有一套凭据，
 *   账号之间不能互相冒充（一个账号的 token 不能拿去控制另一个账号的设备）。
 *
 * 本模块只做四件薄事（仿 `seat-quota.ts` / `tier-capacity.ts` 的形态）：
 *   ① **账号模型**——一行一个云账号，`provider` 是基名，`provider_id` 是注册表 id（`tuya` / `tuya@<id>` / `homeassistant@<id>`）；
 *   ② **凭据键**——`device.cloud.<accountId>.secret|token`，一律经 `device-secrets` 加密；
 *   ③ **复合 id**——`providerIdFor` / `baseProviderOf` 一处派生（`@` 允许、`:` 禁止，后者是地址分隔符）；
 *   ④ **旧配置迁移**——首次调用把旧的涂鸦三键迁成一行 `provider_id='tuya'`，**幂等**，旧键不删。
 *
 * ⚠ **存量地址不迁移**：旧设备地址 `tuya:<deviceId>` 仍由 `provider_id='tuya'` 的迁移账号接管；
 *   新账号一律 `tuya@<accountId>`，两者在注册表里是两个 Provider，token 缓存互不串。
 * ⚠ 本模块**零 electron 依赖**（只引 node:crypto 与被注入的 Db 口）：rr 可直引跑真实现。
 * ⚠ `config_json` **只放非密配置**；Secret/Token 由调用方经 `writeSecret` 落 `wa_settings`——
 *   本模块不写凭据，只给出键名（一处命名，避免两处拼错）。
 */
import { randomUUID } from 'node:crypto';
import type { DeviceDb } from './device-registry.js';
import { capacityRefusal, countCloudAccounts, type CapacityVerdict } from './tier-capacity.js';
import type { LicenseTier } from './feature-limits.js';

/** 已落地的云厂商基名。新增厂商：这里加一项 + 对应 Provider 注册 + 渲染层词表。 */
export const CLOUD_ACCOUNT_PROVIDERS = ['tuya', 'homeassistant'] as const;
export type CloudAccountProvider = (typeof CLOUD_ACCOUNT_PROVIDERS)[number];

/** 旧涂鸦账号的固定 id——**只有它**的注册表 id 是裸 `tuya`（存量地址兼容）。 */
export const LEGACY_TUYA_ACCOUNT_ID = 'legacy-tuya';

/** 动态凭据键前缀（`secret-settings.ts` 的同名前缀兜底；两处须同值）。 */
export const CLOUD_ACCOUNT_SECRET_PREFIX = 'device.cloud.';

export function isCloudAccountProvider(v: unknown): v is CloudAccountProvider {
  return typeof v === 'string' && (CLOUD_ACCOUNT_PROVIDERS as readonly string[]).includes(v);
}

/** 该厂商的凭据种类：涂鸦是 `access_secret`（secret），HA 是长期令牌（token）。 */
export function secretKindOf(provider: CloudAccountProvider): 'secret' | 'token' {
  return provider === 'homeassistant' ? 'token' : 'secret';
}

/** 账号凭据在 `wa_settings` 里的键名（唯一拼法）。 */
export function secretKeyFor(accountId: string, kind: 'secret' | 'token'): string {
  return `${CLOUD_ACCOUNT_SECRET_PREFIX}${accountId}.${kind}`;
}

/** 注册表 id：旧涂鸦账号保持裸 `tuya`；其余一律 `<provider>@<accountId>`。 */
export function providerIdFor(provider: CloudAccountProvider, accountId: string): string {
  return provider === 'tuya' && accountId === LEGACY_TUYA_ACCOUNT_ID ? 'tuya' : `${provider}@${accountId}`;
}

/** 从注册表 id 取基名（`tuya@x` / `tuya` ⇒ `tuya`）——界面标签与诊断文案的唯一派生处。 */
export function baseProviderOf(providerId: string): string {
  const i = providerId.indexOf('@');
  return i > 0 ? providerId.slice(0, i) : providerId;
}

/** 账号的非密配置（`config_json` 的投影；密钥绝不在这里）。 */
export type CloudAccountConfig = Record<string, unknown>;

export interface CloudAccount {
  id: string;
  provider: CloudAccountProvider;
  providerId: string;
  label: string;
  config: CloudAccountConfig;
  enabled: boolean;
  lastSyncAt: string | null;
  lastSyncError: string;
  createdAt: string;
  updatedAt: string;
}

interface CloudAccountRow {
  id: string;
  provider: string;
  provider_id: string;
  label: string;
  config_json: string;
  enabled: number;
  last_sync_at: string | null;
  last_sync_error: string | null;
  created_at: string;
  updated_at: string;
}

function parseConfig(raw: unknown): CloudAccountConfig {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as CloudAccountConfig) : {};
  } catch {
    return {};
  }
}

function rowToAccount(row: CloudAccountRow): CloudAccount {
  return {
    id: row.id,
    provider: isCloudAccountProvider(row.provider) ? row.provider : 'tuya',
    providerId: row.provider_id,
    label: row.label,
    config: parseConfig(row.config_json),
    enabled: row.enabled === 1,
    lastSyncAt: row.last_sync_at ?? null,
    lastSyncError: row.last_sync_error ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ACCOUNT_COLUMNS =
  'id, provider, provider_id, label, config_json, enabled, last_sync_at, last_sync_error, created_at, updated_at';

export function listCloudAccounts(db: DeviceDb): CloudAccount[] {
  try {
    const rows = db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM wa_device_cloud_accounts ORDER BY created_at ASC, id ASC`).all() as CloudAccountRow[];
    return rows.map(rowToAccount);
  } catch {
    return [];
  }
}

export function getCloudAccount(db: DeviceDb, id: string): CloudAccount | null {
  try {
    const row = db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM wa_device_cloud_accounts WHERE id = ?`).get(id) as CloudAccountRow | undefined;
    return row ? rowToAccount(row) : null;
  } catch {
    return null;
  }
}

export function getCloudAccountByProviderId(db: DeviceDb, providerId: string): CloudAccount | null {
  try {
    const row = db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM wa_device_cloud_accounts WHERE provider_id = ?`).get(providerId) as CloudAccountRow | undefined;
    return row ? rowToAccount(row) : null;
  } catch {
    return null;
  }
}

/**
 * `config_json` 的**写口白名单**：只收各厂商已知的非密字段。
 * 这不是"顺手校验"——若把渲染层传来的 `secret`/`token` 原样塞进 `config_json`，凭据就明文落库了。
 */
export function sanitizeAccountConfig(provider: CloudAccountProvider, raw: unknown): CloudAccountConfig {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  if (provider === 'homeassistant') {
    return { base_url: normalizeCloudBaseUrl(str(src.base_url)) };
  }
  return { region: str(src.region) || 'cn', access_id: str(src.access_id) };
}

/**
 * HA REST 地址归一：只收 `http/https`，必须有 host，**拒绝 URL 内嵌账号密码**（凭据走独立令牌）。
 * 局域网地址是正常用法（HA 常在家里的 NAS/树莓派上），故不做公网/私网限制。
 */
export function normalizeCloudBaseUrl(raw: string): string {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (!url.hostname) return '';
  if (url.username || url.password) return '';
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

/** 账号配置是否齐到"可以试连接"（不含密钥；密钥单独判）。 */
export function accountConfigProblem(account: Pick<CloudAccount, 'provider' | 'config'>): string | null {
  if (account.provider === 'tuya') {
    const accessId = String(account.config.access_id ?? '').trim();
    if (!accessId) return '缺少 Access ID';
    const region = String(account.config.region ?? '').trim();
    if (!region) return '缺少区域';
    return null;
  }
  const baseUrl = normalizeCloudBaseUrl(String(account.config.base_url ?? ''));
  if (!baseUrl) return 'Base URL 缺失或不是合法的 http/https 地址';
  return null;
}

export interface CloudAccountInput {
  provider: CloudAccountProvider;
  label?: string;
  config?: unknown;
  enabled?: boolean;
}

export type CloudAccountWriteResult =
  | { ok: true; account: CloudAccount }
  | { ok: false; code: 'CAPACITY' | 'INVALID'; note: string };

/**
 * 新增账号前的容量判据（与其它容量维度同一把尺）。
 * ⚠ 社区版"0 个"由 **Pro `device_discovery` 闸在 IPC 层先拦**；本函数只兑现 Pro/Team 的数字。
 */
export function cloudAccountCapacityVerdict(tier: LicenseTier, db: DeviceDb): CapacityVerdict {
  return capacityRefusal(tier, 'maxCloudAccounts', countCloudAccounts(db));
}

function labelFor(provider: CloudAccountProvider, label: string): string {
  const trimmed = String(label ?? '').trim();
  return trimmed || (provider === 'homeassistant' ? 'Home Assistant' : '涂鸦云');
}

/** 建一行账号（容量闸由调用方先判——本函数不解析档位，避免两处各判一次）。 */
export function createCloudAccount(db: DeviceDb, input: CloudAccountInput): CloudAccountWriteResult {
  if (!isCloudAccountProvider(input.provider)) {
    return { ok: false, code: 'INVALID', note: `未知的设备云厂商：${String(input.provider)}（可选 ${CLOUD_ACCOUNT_PROVIDERS.join(' / ')}）` };
  }
  const id = randomUUID();
  const config = sanitizeAccountConfig(input.provider, input.config);
  if (input.provider === 'homeassistant' && !config.base_url) {
    return { ok: false, code: 'INVALID', note: 'Home Assistant 需要一个合法的 http/https 地址（如 http://192.168.1.10:8123）' };
  }
  const providerId = providerIdFor(input.provider, id);
  try {
    db.prepare(
      `INSERT INTO wa_device_cloud_accounts (id, provider, provider_id, label, config_json, enabled)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.provider, providerId, labelFor(input.provider, input.label ?? ''), JSON.stringify(config), input.enabled === false ? 0 : 1);
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    if (/UNIQUE/i.test(msg)) return { ok: false, code: 'INVALID', note: `设备云 Provider id「${providerId}」已被占用` };
    return { ok: false, code: 'INVALID', note: `设备云账号写入失败：${msg}` };
  }
  const account = getCloudAccount(db, id);
  return account ? { ok: true, account } : { ok: false, code: 'INVALID', note: '设备云账号写入后读不回（数据库异常）' };
}

export interface CloudAccountPatch {
  label?: string;
  config?: unknown;
  enabled?: boolean;
}

export function updateCloudAccount(db: DeviceDb, id: string, patch: CloudAccountPatch): CloudAccountWriteResult {
  const account = getCloudAccount(db, id);
  if (!account) return { ok: false, code: 'INVALID', note: `设备云账号不存在：${id}` };
  const config = patch.config === undefined ? account.config : sanitizeAccountConfig(account.provider, patch.config);
  if (account.provider === 'homeassistant' && !config.base_url) {
    return { ok: false, code: 'INVALID', note: 'Home Assistant 需要一个合法的 http/https 地址（如 http://192.168.1.10:8123）' };
  }
  const label = patch.label === undefined ? account.label : labelFor(account.provider, patch.label);
  const enabled = patch.enabled === undefined ? account.enabled : patch.enabled;
  db.prepare(
    `UPDATE wa_device_cloud_accounts
        SET label = ?, config_json = ?, enabled = ?, updated_at = datetime('now')
      WHERE id = ?`,
  ).run(label, JSON.stringify(config), enabled ? 1 : 0, id);
  const next = getCloudAccount(db, id);
  return next ? { ok: true, account: next } : { ok: false, code: 'INVALID', note: '设备云账号更新后读不回（数据库异常）' };
}

/** 删一行账号（凭据键与设备行由调用方处理——本模块只管账号行）。 */
export function deleteCloudAccount(db: DeviceDb, id: string): CloudAccount | null {
  const account = getCloudAccount(db, id);
  if (!account) return null;
  db.prepare('DELETE FROM wa_device_cloud_accounts WHERE id = ?').run(id);
  return account;
}

/** 记一次同步观测（成功清空原因；失败如实留着）。 */
export function markCloudAccountSync(db: DeviceDb, id: string, error: string | null): void {
  db.prepare(
    `UPDATE wa_device_cloud_accounts
        SET last_sync_at = datetime('now'), last_sync_error = ?, updated_at = datetime('now')
      WHERE id = ?`,
  ).run(error ?? '', id);
}

export interface LegacyMigrationResult {
  /** 迁出的账号（已存在 ⇒ 原样返回）。 */
  account: CloudAccount | null;
  /** 本次是否真写入了一行。 */
  created: boolean;
  /** 迁不动时的如实原因（旧键仍可用，不阻断）。 */
  warning?: string;
}

/**
 * 把**旧涂鸦三键**迁成一行 `provider_id='tuya'` 的账号（**幂等**；旧键不删，作为回退与兼容）。
 *
 * 判据：旧键里有 Access ID ∧ Secret 才迁。Secret 经 `writeSecret` 写到
 * `device.cloud.legacy-tuya.secret`；写不进去（加密后端不可用）⇒ 不建行、如实告警——
 * 宁可继续走旧 Provider，也不把明文塞进新键。
 */
export function ensureLegacyTuyaAccount(
  db: DeviceDb,
  settingsGet: (key: string) => string | null,
  writeSecretFn: (db: DeviceDb, key: string, value: string) => { ok: boolean; error?: string },
): LegacyMigrationResult {
  const existing = getCloudAccountByProviderId(db, 'tuya');
  if (existing) return { account: existing, created: false };
  const accessId = (settingsGet('device.tuya.access_id') ?? '').trim();
  const accessSecret = (settingsGet('device.tuya.access_secret') ?? '').trim();
  if (!accessId || !accessSecret) return { account: null, created: false };
  const secretKey = secretKeyFor(LEGACY_TUYA_ACCOUNT_ID, 'secret');
  const written = writeSecretFn(db, secretKey, accessSecret);
  if (!written.ok) {
    return {
      account: null,
      created: false,
      warning: `旧涂鸦凭据未能迁入加密账号存储（${written.error ?? '加密后端不可用'}）；旧配置仍可用。`,
    };
  }
  const config = sanitizeAccountConfig('tuya', {
    region: settingsGet('device.tuya.region') ?? 'cn',
    access_id: accessId,
  });
  try {
    db.prepare(
      `INSERT INTO wa_device_cloud_accounts (id, provider, provider_id, label, config_json, enabled)
       VALUES (?, 'tuya', 'tuya', '涂鸦云（旧配置迁移）', ?, 1)`,
    ).run(LEGACY_TUYA_ACCOUNT_ID, JSON.stringify(config));
  } catch (e) {
    return { account: null, created: false, warning: `旧涂鸦账号落库失败：${(e as Error)?.message || String(e)}` };
  }
  return { account: getCloudAccount(db, LEGACY_TUYA_ACCOUNT_ID), created: true };
}
