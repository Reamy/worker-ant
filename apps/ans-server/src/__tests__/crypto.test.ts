import { describe, it, expect } from 'vitest';
import { encryptApiKey, decryptApiKey } from '../utils/security.js';

describe('API Key Encryption', () => {
  it('encrypts and decrypts correctly', () => {
    const original = 'sk-test-api-key-123456';
    const encrypted = encryptApiKey(original);
    expect(encrypted).not.toBe(original);
    const decrypted = decryptApiKey(encrypted);
    expect(decrypted).toBe(original);
  });

  it('produces different ciphertext for same plaintext', () => {
    const key1 = encryptApiKey('same-key');
    const key2 = encryptApiKey('same-key');
    expect(key1).not.toBe(key2);
  });
});
