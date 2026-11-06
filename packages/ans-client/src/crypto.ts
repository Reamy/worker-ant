import { createHmac, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const ALGORITHM = 'sha256';
const AES_ALGORITHM = 'aes-256-gcm';

/**
 * 生成HMAC-SHA256签名，用于ANS API请求认证。
 */
export function createHmacSignature(secretKey: string, timestamp: string, body: string): string {
  const hmac = createHmac(ALGORITHM, secretKey);
  hmac.update(`${timestamp}\n${body}`);
  return hmac.digest('hex');
}

/**
 * 验证HMAC签名，时间戳需在5分钟窗口内。
 */
export function verifyHmacSignature(
  secretKey: string,
  timestamp: string,
  body: string,
  signature: string,
  windowMs = 300_000,
): boolean {
  const ts = Number(timestamp);
  if (isNaN(ts) || Math.abs(Date.now() - ts) > windowMs) return false;

  const expected = createHmacSignature(secretKey, timestamp, body);

  // 常量时间比较防时序攻击
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 生成随机API Key。
 */
export function generateApiKey(prefix = 'wa'): string {
  const bytes = randomBytes(24);
  const random = bytes.toString('base64url');
  return `${prefix}_${random}`;
}

/**
 * 生成随机 secret key（64 hex）。与 `generateApiKey` 同处——**凭据形态只有一个真源**，
 * 散落自造即两侧长度/编码不一（ANS 侧 `verifyHmacSignature` 认的是同一把尺）。
 */
export function generateSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * 生成一对自洽的 ANS 凭据。桌面首启**代起本机 ANS**时用它铸"自己人"，随子进程
 * `ANS_API_KEYS=<key>:<secret>` 下发（ANS 侧 env 回退即认），**无需**先有 `ans_api_keys` 行。
 */
export function generateCredentialPair(prefix = 'wa'): { apiKey: string; secretKey: string } {
  return { apiKey: generateApiKey(prefix), secretKey: generateSecret() };
}

/**
 * AES-256-GCM加密，用于存储API Key引用。
 */
export function encryptApiKey(
  plaintext: string,
  encryptionKey: Buffer,
): { encrypted: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv(AES_ALGORITHM, encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/**
 * AES-256-GCM解密，还原API Key。
 */
export function decryptApiKey(encrypted: string, iv: string, tag: string, encryptionKey: Buffer): string {
  const decipher = createDecipheriv(AES_ALGORITHM, encryptionKey, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
  return decrypted.toString('utf8');
}
