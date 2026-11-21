/**
 * zx_20261119_2 M6「序」——**同仓构建锁**（零 electron，rr 可直跑）。
 *
 * 病根（真标本 S3）：5 个并行子任务共享同一工作树；`mvn clean` / `rm -rf target` 会删掉
 * 兄弟任务正在用的共享构建目录。真实现场里两个子任务各自 `git worktree add` 隔离，多花约 20 万 tokens；
 * 没有隔离时，一条 `clean` 就可能当场打断对方的测试。
 *
 * 只锁**全仓构建/清理**（mvn clean|test|package|install|verify、gradle clean|build|test、
 * npm/pnpm/yarn build、tsc -b、rm -rf target|dist|node_modules）——日常只读命令与单文件编译不触发。
 *
 * 锁文件落在**仓内** `.git/wa-build.lock`（gitignore 天然覆盖、按仓隔离）；`.git` 不可写时回落
 * 系统临时目录（按仓路径 sha1 分文件）。有主拒绝、无主认领、**过期自愈**（默认 30 分钟），
 * 不产生死锁；释放只认自己那把（同 taskId）。
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BUILD_LOCK_TTL_MS = 30 * 60 * 1000;

export interface BuildLockInfo {
  repoRoot: string;
  taskId: string;
  pid: number;
  command: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface AcquireBuildLockOptions {
  repoRoot: string;
  taskId: string;
  command: string;
  ttlMs?: number;
  now?: number;
  /** rr / 测试用：强制锁目录（不写仓内 `.git`） */
  lockDirOverride?: string;
}

export type AcquireBuildLockResult =
  | { ok: true; lockPath: string; info: BuildLockInfo }
  | { ok: false; lockPath: string; holder: BuildLockInfo };

export interface ReleaseBuildLockOptions {
  repoRoot: string;
  taskId: string;
  lockPath?: string;
  lockDirOverride?: string;
}

function sha1(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

/** 锁文件路径：优先仓内 `.git/`（目录或 worktree 指针文件均可）；否则系统临时目录。 */
export function buildLockPath(repoRoot: string, lockDirOverride?: string): string {
  const abs = path.resolve(repoRoot);
  if (lockDirOverride) return path.join(path.resolve(lockDirOverride), `build_${sha1(abs)}.json`);
  try {
    if (fs.statSync(path.join(abs, '.git')).isDirectory()) return path.join(abs, '.git', 'wa-build.lock');
  } catch { /* 无 .git 或不可读 ⇒ 回落临时目录 */ }
  return path.join(os.tmpdir(), 'wa-build-locks', `build_${sha1(abs)}.json`);
}

/** 解析锁文件；坏 JSON ⇒ null（按"无锁"处理，不因坏文件永久卡死）。 */
export function readBuildLock(lockPath: string): BuildLockInfo | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const o = JSON.parse(raw) as Partial<BuildLockInfo>;
    if (!o || typeof o !== 'object' || typeof o.taskId !== 'string' || !o.taskId) return null;
    return {
      repoRoot: String(o.repoRoot ?? ''),
      taskId: o.taskId,
      pid: Number(o.pid) || 0,
      command: String(o.command ?? ''),
      acquiredAt: String(o.acquiredAt ?? ''),
      expiresAt: String(o.expiresAt ?? ''),
    };
  } catch {
    return null;
  }
}

function isExpired(info: BuildLockInfo, now: number): boolean {
  const t = Date.parse(info.expiresAt);
  return !Number.isFinite(t) || t <= now;
}

/**
 * 认领构建锁。无锁/过期/同任务 ⇒ 成功；有主且未过期 ⇒ 返回持有者（调用方据此拒绝并给出路）。
 * 单进程内 race 窗口极窄；文件不存在时用 `wx` 原子创建，EEXIST 再读判。
 */
export function acquireBuildLock(opts: AcquireBuildLockOptions): AcquireBuildLockResult {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const lockPath = buildLockPath(opts.repoRoot, opts.lockDirOverride);
  const info: BuildLockInfo = {
    repoRoot: path.resolve(opts.repoRoot),
    taskId: opts.taskId,
    pid: process.pid,
    command: String(opts.command ?? ''),
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (opts.ttlMs ?? BUILD_LOCK_TTL_MS)).toISOString(),
  };
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* 目录已存在/不可建 ⇒ 下面写失败如实抛出 */ }
  try {
    fs.writeFileSync(lockPath, JSON.stringify(info), { flag: 'wx' });
    return { ok: true, lockPath, info };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') {
      // 写不进去（权限等）：不假装拿到锁——调用方将按"未加锁"继续，但这里如实失败。
      return { ok: false, lockPath, holder: { ...info, taskId: '(unknown)' } };
    }
  }
  const existing = readBuildLock(lockPath);
  if (!existing || existing.taskId === opts.taskId || isExpired(existing, now)) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(info));
      return { ok: true, lockPath, info };
    } catch {
      return { ok: false, lockPath, holder: existing ?? { ...info, taskId: '(unknown)' } };
    }
  }
  return { ok: false, lockPath, holder: existing };
}

/** 释放：只删自己那把（同 taskId）；文件不存在 ⇒ 幂等成功。 */
export function releaseBuildLock(opts: ReleaseBuildLockOptions): boolean {
  const lockPath = opts.lockPath ?? buildLockPath(opts.repoRoot, opts.lockDirOverride);
  const info = readBuildLock(lockPath);
  if (!info) {
    try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ }
    return true;
  }
  if (info.taskId !== opts.taskId) return false;
  try { fs.rmSync(lockPath, { force: true }); return true; } catch { return false; }
}

/**
 * 该命令是否需要构建锁：**只认全仓构建/清理**。
 * 反例（必须不触发）：`mvn -v`、`grep x`、`tsc file.ts`、`npm run dev`、`rm -rf build`（清单外目录）。
 */
export function isRepoWideBuildCommand(command: string): boolean {
  const s = String(command ?? '');
  if (/\bmvn\b/.test(s) && /\b(clean|test|package|install|verify)\b/.test(s)) return true;
  if (/\b(?:\.\/)?gradlew?\b/.test(s) && /\b(clean|build|test)\b/.test(s)) return true;
  if (/\b(?:npm|pnpm|yarn)\b/.test(s) && /\b(?:run\s+)?build\b/.test(s)) return true;
  if (/\btsc\b/.test(s) && /(?:^|\s)(?:-b|--build)\b/.test(s)) return true;
  if (/\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+/.test(s) && /\b(?:target|dist|node_modules)\b/.test(s)) return true;
  return false;
}

/**
 * 命令相对哪个仓加锁：先看 `cd <dir> && …`（execute_command 的常用写法），
 * 再看 cwd 是否在某个仓内，最后回落 cwd（项目级锁）。
 */
export function buildLockRoot(cwd: string, command: string): string {
  const base = path.resolve(String(cwd ?? '.'));
  const m = /^\s*cd\s+([^\s;&|]+)\s*(?:&&|;|\|\|)/.exec(String(command ?? ''));
  if (m) {
    const p = path.resolve(base, m[1]!);
    try { if (fs.existsSync(path.join(p, '.git'))) return p; } catch { /* ignore */ }
  }
  try {
    const out = execFileSync('git', ['-C', base, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: 1_500, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return path.resolve(out);
  } catch { /* 非 git ⇒ 回落 cwd */ }
  return base;
}
