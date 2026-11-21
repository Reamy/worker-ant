/**
 * zx_20261120_1 M5「远·派」：读本机项目的 **origin + HEAD**，供跨机只读分析随单带走。
 *
 * 只读、有界（单条 3s）、永不抛；非仓/无 origin 一律 `null`（调用方按「不外派」处理，不猜）。
 * 凭据不在此读取、不外带——只取 URL 与提交 sha。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { NodeRepoBinding } from '@worker-ant/shared-types';

const GIT_TIMEOUT_MS = 3_000;

export function readGit(workingDir: string, args: string[]): string | null {
  const dir = String(workingDir || '').trim();
  if (!dir || !fs.existsSync(path.join(dir, '.git'))) return null;
  try {
    const out = execFileSync('git', ['-C', dir, ...args], {
      timeout: GIT_TIMEOUT_MS, maxBuffer: 256 * 1024, encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out ?? '').trim() || null;
  } catch {
    return null;
  }
}

export function readOrigin(workingDir: string): string | null {
  return readGit(workingDir, ['remote', 'get-url', 'origin']);
}

export function readHead(workingDir: string): string | null {
  return readGit(workingDir, ['rev-parse', 'HEAD']);
}

/** 有 origin ∧ 有 HEAD ⇒ 返回绑定；任一缺失 ⇒ `null`。 */
export function repoBindingFromDir(workingDir: string): NodeRepoBinding | null {
  const url = readOrigin(workingDir);
  const ref = readHead(workingDir);
  if (!url || !ref) return null;
  return { url, ref };
}
