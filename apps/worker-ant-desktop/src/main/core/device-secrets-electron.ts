/**
 * zx_20261023_5 批三: **Electron safeStorage 后端的装配件**——`device-secrets.ts` 的真实现。
 *
 * 为什么单独一份：`device-secrets.ts` 必须零 electron 依赖（rr 直跑真实现、注入假后端），
 *   `safeStorage` 只在主进程可用，故把"哪一把锁"隔离在这个薄壳里。
 *
 * ⚠ Electron `safeStorage` 的密文平台相关（macOS 钥匙串/DPAPI/libsecret）；
 *   换机器/换系统账户后解不开是**正常结果**（如实告警，不伪造明文）。
 * ⚠ Linux 无 keyring 时 `isEncryptionAvailable()` 可能为 false ⇒ 写口拒（宁可存不下，不退回明文）。
 */
import { safeStorage } from 'electron';
import type { SecretCipher } from './device-secrets.js';

/** 主进程的加密后端（macOS/Windows 恒可用；Linux 视 keyring 而定）。 */
export function electronSecretCipher(): SecretCipher {
  return {
    backend: 'electron-safeStorage',
    get available(): boolean {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    encrypt(plain: string): string {
      return safeStorage.encryptString(plain).toString('base64');
    },
    decrypt(data: string): string {
      return safeStorage.decryptString(Buffer.from(data, 'base64'));
    },
  };
}
