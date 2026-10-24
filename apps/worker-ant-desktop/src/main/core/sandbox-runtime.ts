/**
 * 真进程隔离沙箱适配层（Phase 4）。
 *
 * macOS 用 sandbox-exec + Seatbelt profile（进程级文件写/网络限制）；
 * 不可用时降级回退普通执行（现有静态防护 sandbox.ts 仍生效）。
 *
 * 借鉴 Claude Code sandbox-runtime 的「文件系统/网络限制 + 违规上报」，
 * 但聚焦「文件写隔离」这一核心价值——run_privileged 的特权命令(如 pip/git)
 * 本身需要网络，故网络策略为放行(deny default 仅拒绝文件写越界)。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLogger } from './logger.js';

const logger = createLogger('sandbox-runtime');

export interface SandboxedResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  /** 是否真正走了进程隔离沙箱（false = 降级普通执行） */
  sandboxed: boolean;
}

/** 解析真实路径（macOS /tmp → /private/tmp 等符号链接），Seatbelt profile 需真实路径。 */
function realpathOrSelf(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

/** 生成最小 Seatbelt profile：默认拒绝写/网络，仅放行工作目录与显式允许目录的写。 */
function generateSeatbeltProfile(workingDir: string, allowPaths: string[]): string {
  const writePaths = [workingDir, ...allowPaths]
    .map(p => realpathOrSelf(p))
    .filter(Boolean);
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    // 读放开：shell/解释器/命令需读系统库、配置、动态库
    '(allow file-read*)',
    // 网络放行：run_privileged 的特权命令(pip/git/npm)需要网络；普通命令的网络安全由 sandbox.ts 意图分类兜底
    '(allow network*)',
  ];
  for (const wp of writePaths) {
    lines.push(`(allow file-write* (subpath "${wp.replace(/"/g, '\\"')}"))`);
  }
  return lines.join('\n');
}

function isSandboxExecAvailable(): boolean {
  try {
    const r = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)'], { stdio: 'ignore', timeout: 3000 });
    return !r.error;
  } catch { return false; }
}

/**
 * 在进程隔离沙箱中执行命令（macOS sandbox-exec）。
 * 失败/不可用时降级回退普通执行，返回 sandboxed=false。
 *
 * ⚠ 当前无调用方，见 `plans/improve/zx_20260924_1.md` §4：`src/main` 内没有任何文件 import
 * 本模块（`sandbox-runtime.js`）⇒ 进程级 Seatbelt 隔离从未生效。本轮只登记，不删不接线（J-3 / §4.1 B-2）。
 */
export function spawnSandboxed(
  command: string,
  opts: { cwd: string; allowPaths?: string[]; timeoutMs?: number },
): SandboxedResult {
  const { cwd, allowPaths = [], timeoutMs = 60_000 } = opts;

  if (process.platform === 'darwin' && isSandboxExecAvailable()) {
    try {
      const profile = generateSeatbeltProfile(cwd, allowPaths);
      const profilePath = path.join(os.tmpdir(), `wa-sb-${crypto.randomUUID()}.sb`);
      fs.writeFileSync(profilePath, profile);
      try {
        const r = spawnSync('/usr/bin/sandbox-exec', ['-f', profilePath, '--', '/bin/sh', '-c', command], {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          stdio: 'pipe',
          encoding: 'utf8',
        });
        if (r.error) {
          logger.warn({ err: r.error.message }, 'sandbox-exec 执行失败，降级普通执行');
          return fallbackExec(command, cwd, timeoutMs);
        }
        const ok = r.status === 0;
        return { ok, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: ok ? undefined : `退出码 ${r.status}`, sandboxed: true };
      } finally {
        try { fs.unlinkSync(profilePath); } catch { /* 清理失败忽略 */ }
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message }, '沙箱 profile 生成失败，降级普通执行');
      return fallbackExec(command, cwd, timeoutMs);
    }
  }

  return fallbackExec(command, cwd, timeoutMs);
}

function fallbackExec(command: string, cwd: string, timeoutMs: number): SandboxedResult {
  try {
    const r = spawnSync('/bin/sh', ['-c', command], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (r.error) return { ok: false, error: r.error.message, sandboxed: false };
    const ok = r.status === 0;
    return { ok, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: ok ? undefined : `退出码 ${r.status}`, sandboxed: false };
  } catch (e) {
    return { ok: false, error: (e as Error).message, sandboxed: false };
  }
}
