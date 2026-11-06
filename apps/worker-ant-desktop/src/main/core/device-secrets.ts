/**
 * zx_20261023_5 批三（维特根斯坦·意义即用法 / 管子·度量衡）: **设备凭据的加密落库与旧明文迁移**。
 *
 * 病（B9）：MQTT 密码、涂鸦 Secret、米家 token 一直以**明文**躺在 `wa_settings` 里——
 *   库文件被拷走、备份被误传、任何能读库的进程都直接拿到。只做"读口脱敏"不够：
 *   脱敏管的是**渲染层看不看得见**，管不了**盘上是不是明文**。
 *
 * 本模块只做一件事：**盘上加密、读时透明**。
 *   · 密文形态 `enc:v1:<base64>`；后端可注入（Electron `safeStorage` 由 `device-secrets-electron.ts` 装配，
 *     rr 注入假后端）——本文件**零 electron 依赖**，rr 可直跑真实现。
 *   · **旧明文兼容**：读到无前缀的值 ⇒ 原地加密（同键、只改值形态），读一次即完成迁移；
 *     迁移失败 ⇒ **保持原值**并如实告警，不丢数据、不阻断读。
 *   · **写口拒绝明文降级**：加密后端不可用时**拒绝写入**（宁可存不下，也不悄悄退回明文）。
 *   · 加密后端不可用时读到密文 ⇒ 如实回"解不开"（不把它当明文返回）。
 *
 * ⚠ 语义单一真源：`SECRET_ENC_PREFIX` / `isEncryptedSecret` / `readSecret` / `writeSecret` 只此一处；
 *   `ipc/devices.ipc.ts`（设备读口）与 `ipc/admin.ipc.ts`（通用 `settings:set` 写口）都调这里。
 * ⚠ 本模块**不判断哪些键算密钥**——那是 `secret-settings.ts` 的词表；此处只负责加解密与迁移。
 */
import type { DeviceDb } from './device-registry.js';

/** 密文前缀（写死进数据格式；改它 = 换格式，须带迁移）。 */
export const SECRET_ENC_PREFIX = 'enc:v1:';

/** 可注入的加密后端（Electron safeStorage / rr 假实现同形）。 */
export interface SecretCipher {
  /** 供诊断/告警显示的后端名（如 `electron-safeStorage`）。 */
  readonly backend: string;
  /** 此刻是否可用（safeStorage 在 Linux 无 keyring 时可能不可用）。 */
  readonly available: boolean;
  /** 明文 ⇒ base64 密文（不含前缀）。 */
  encrypt(plain: string): string;
  /** base64 密文（不含前缀）⇒ 明文；失败应 throw。 */
  decrypt(data: string): string;
}

let cipher: SecretCipher | null = null;

/** 装配加密后端（主进程启动时一次；rr 注入假后端）。传 `null` = 卸载。 */
export function initDeviceSecrets(next: SecretCipher | null): void {
  cipher = next;
}

/** 当前后端态（诊断/告警用；不泄露任何凭据内容）。 */
export function secretCipherState(): { available: boolean; backend: string } {
  return { available: cipher?.available === true, backend: cipher?.backend ?? 'none' };
}

export function isEncryptedSecret(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(SECRET_ENC_PREFIX);
}

/** 读结果：`ok:false` 只发生在"有密文但解不开"——调用方须如实上屏/告警，**不得**当空值处理。 */
export type SecretRead =
  | {
      ok: true;
      /** 明文（空串 = 未配置）。 */
      value: string;
      /** 盘上当前是否为密文（迁移后为 true）。 */
      encrypted: boolean;
      /** 本次读是否完成了"旧明文 → 密文"的迁移。 */
      migrated: boolean;
      /** 迁移未完成时的如实原因（旧值仍可用）。 */
      warning?: string;
    }
  | { ok: false; reason: string };

function readRaw(db: DeviceDb, key: string): string | null {
  const row = db.prepare('SELECT value FROM wa_settings WHERE key = ?').get(key) as { value?: unknown } | undefined;
  if (!row || row.value == null) return null;
  return String(row.value);
}

function writeRaw(db: DeviceDb, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO wa_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, value);
}

/**
 * 读一个凭据键：密文 ⇒ 解密；旧明文 ⇒ **尝试原地迁移**后返回。
 *
 * 迁移失败**不丢数据**：值是旧的明文，读到的也还是旧的明文，只是多一句 `warning`。
 */
export function readSecret(db: DeviceDb, key: string): SecretRead {
  const raw = readRaw(db, key);
  if (raw == null || raw === '') return { ok: true, value: '', encrypted: false, migrated: false };

  if (!isEncryptedSecret(raw)) {
    // 旧明文：先尝试加密再落库（同键改值形态），失败的旧值原样保留。
    if (!cipher?.available) {
      return {
        ok: true, value: raw, encrypted: false, migrated: false,
        warning: `加密后端不可用（${cipher?.backend ?? 'none'}），旧明文凭据照常可用但未迁移。`,
      };
    }
    try {
      writeRaw(db, key, SECRET_ENC_PREFIX + cipher.encrypt(raw));
      return { ok: true, value: raw, encrypted: true, migrated: true };
    } catch (e) {
      return {
        ok: true, value: raw, encrypted: false, migrated: false,
        warning: `旧明文凭据迁移失败（${(e as Error)?.message || String(e)}），已保持原值未改动。`,
      };
    }
  }

  if (!cipher?.available) {
    return { ok: false, reason: `凭据已加密（${cipher?.backend ?? 'none'}），但当前环境的加密后端不可用，无法解密。` };
  }
  try {
    return { ok: true, value: cipher.decrypt(raw.slice(SECRET_ENC_PREFIX.length)), encrypted: true, migrated: false };
  } catch (e) {
    return { ok: false, reason: `凭据解密失败：${(e as Error)?.message || String(e)}` };
  }
}

/** 写一个凭据键（**只写密文**；后端不可用即拒，不悄悄退回明文）。 */
export type SecretWrite = { ok: true; encrypted: true } | { ok: false; error: string };

export function writeSecret(db: DeviceDb, key: string, plain: string): SecretWrite {
  if (!cipher?.available) {
    return { ok: false, error: `加密后端不可用（${cipher?.backend ?? 'none'}），拒绝写入明文凭据。` };
  }
  try {
    writeRaw(db, key, SECRET_ENC_PREFIX + cipher.encrypt(String(plain ?? '')));
    return { ok: true, encrypted: true };
  } catch (e) {
    return { ok: false, error: `凭据加密失败：${(e as Error)?.message || String(e)}` };
  }
}

/** 清除凭据（删行；`settings:secretStatus` 据此回"未配置"）。 */
export function clearSecret(db: DeviceDb, key: string): void {
  db.prepare('DELETE FROM wa_settings WHERE key = ?').run(key);
}

/** 凭据状态（只答"有没有/是不是密文"，**不回明文**）。 */
export function secretState(db: DeviceDb, key: string): { hasValue: boolean; encrypted: boolean; cipherAvailable: boolean } {
  const raw = readRaw(db, key);
  return {
    hasValue: raw != null && raw !== '',
    encrypted: isEncryptedSecret(raw),
    cipherAvailable: cipher?.available === true,
  };
}
