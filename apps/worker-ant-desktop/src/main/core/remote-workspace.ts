/**
 * zx_20261120_1 M4「远·仓」：跨机只读分析的**仓库绑定**与**有界工作区**。
 *
 * 只做三件事：
 *   ① `sanitizeRepoBinding`：不信任发送端，只收白名单 URL 形状与安全 ref/subdir；
 *   ② `prepareRemoteWorkspace`：把仓库 clone 到 `<baseDir>/<sha1(url+ref)>/`，有界（60s/200MB/复用）；
 *   ③ `cleanupRemoteWorkspace`：保留最近 N 份，其余 best-effort 删除——**永不删用户项目目录**。
 *
 * 纪律：
 *   · 只 clone，不 push / 不 fetch 用户仓；凭据由对端本机自备，不写进任务上下文或回执。
 *   · 日志与回执只用 `redactUrl` 的脱敏串。
 *   · 零 electron；`exec` 可注入，rr 用本地 bare 仓 + `file://`（显式开关）直跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import type { NodeRepoBinding } from '@worker-ant/shared-types';

export interface SanitizeRepoOpts {
  /** 仅回归用：允许 `file://` 本地裸仓（生产不设）。 */
  allowFile?: boolean;
}

const MAX_REF_CHARS = 200;
const MAX_URL_CHARS = 500;
const MAX_SUBDIR_CHARS = 200;
const URL_SHAPES = [
  /^https?:\/\/[^\s]+$/i,
  /^ssh:\/\/[^\s]+$/i,
  /^git@[^\s:]+:.+$/,
  /^git:\/\/[^\s]+$/i,
];

/** 只收安全形状；坏形一律 `null`（调用方按「没有仓库绑定」处理，不猜）。 */
export function sanitizeRepoBinding(raw: unknown, opts: SanitizeRepoOpts = {}): NodeRepoBinding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const url = typeof o.url === 'string' ? o.url.trim() : '';
  const ref = typeof o.ref === 'string' ? o.ref.trim() : '';
  if (!url || url.length > MAX_URL_CHARS) return null;
  if (!ref || ref.length > MAX_REF_CHARS || /[\s\x00-\x1f]/.test(ref)) return null;
  const fileOk = opts.allowFile === true && (/^file:\/\/[^\s]+$/i.test(url) || url.startsWith('/'));
  if (!fileOk && !URL_SHAPES.some((re) => re.test(url))) return null;
  // 凭据不随单走：http(s) 里的 username/password（常见写法是 token 当 username）一律剥掉，
  //   私有仓由**对端本机**自备凭据；ssh 的 user（`ssh://git@host`）不是密钥，保留。
  let usableUrl = url;
  if (/^https?:/i.test(url)) {
    try { const u = new URL(url); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; usableUrl = u.toString(); } catch { /* 坏 URL 由下游 clone 如实失败 */ }
  }
  let subdir: string | undefined;
  if (o.subdir !== undefined) {
    const s = typeof o.subdir === 'string' ? o.subdir.trim() : '';
    if (s.length > MAX_SUBDIR_CHARS) return null;
    if (s) {
      if (path.isAbsolute(s) || s.split(/[\\/]+/).includes('..')) return null;
      subdir = s.replace(/\\/g, '/').replace(/^\.\//, '');
    }
  }
  return subdir ? { url: usableUrl, ref, subdir } : { url: usableUrl, ref };
}

/** 去掉 userinfo 与查询串（日志/回执只用它）。 */
export function redactUrl(url: string): string {
  try {
    if (/^git@/i.test(url)) return url.replace(/^git@([^:]+):/, 'git@$1:');
    const u = new URL(url);
    u.username = '';
    u.password = '';
    u.search = '';
    return u.toString();
  } catch {
    return String(url).replace(/\/\/[^/@]+@/, '//');
  }
}

export type RemoteWorkspaceFailure = 'no_remote' | 'clone_failed' | 'too_large' | 'timeout' | 'bad_path';

export interface RemoteWorkspaceResult {
  ok: boolean;
  dir: string;
  commit: string;
  cached: boolean;
  reason: RemoteWorkspaceFailure | '';
}

export interface PrepareOpts {
  repo: NodeRepoBinding | null;
  baseDir: string;
  taskId?: string;
  /** 注入 exec（rr 用）；缺省真 `execFile`。 */
  exec?: (file: string, args: string[], opts: { timeout: number; cwd?: string }) => Promise<{ stdout: string }>;
  /** clone 超时（缺省 60s）。 */
  timeoutMs?: number;
  /** 目录体量上限（缺省 200MB）。 */
  maxBytes?: number;
  /** 回归用：允许 `file://`。 */
  allowFile?: boolean;
}

const inflight = new Map<string, Promise<RemoteWorkspaceResult>>();

function runGit(file: string, args: string[], opts: { timeout: number; cwd?: string }): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: opts.timeout, cwd: opts.cwd, maxBuffer: 8 * 1024 * 1024, encoding: 'utf-8' }, (err, stdout) => {
      if (err) reject(err); else resolve({ stdout: String(stdout ?? '') });
    });
  });
}

/**
 * 准备（或复用）一个只读工作区。
 * 目录键 = `sha1(url + '\n' + ref)`；同键并发共用同一个 Promise（不重复 clone）。
 */
export function prepareRemoteWorkspace(opts: PrepareOpts): Promise<RemoteWorkspaceResult> {
  const repo = opts.repo;
  if (!repo) return Promise.resolve({ ok: false, dir: '', commit: '', cached: false, reason: 'no_remote' });
  const safe = sanitizeRepoBinding(repo, { allowFile: opts.allowFile });
  if (!safe) return Promise.resolve({ ok: false, dir: '', commit: '', cached: false, reason: 'no_remote' });
  const base = path.resolve(opts.baseDir);
  const key = crypto.createHash('sha1').update(`${safe.url}\n${safe.ref}`).digest('hex').slice(0, 16);
  const dir = path.join(base, key);
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = prepareInner({ ...opts, repo: safe, dir, exec: opts.exec ?? runGit });
  inflight.set(key, p);
  void p.finally(() => inflight.delete(key));
  return p;
}

async function prepareInner(opts: PrepareOpts & { repo: NodeRepoBinding; dir: string; exec: NonNullable<PrepareOpts['exec']> }): Promise<RemoteWorkspaceResult> {
  const timeout = Math.max(1_000, Number(opts.timeoutMs) || 60_000);
  const maxBytes = Math.max(1_000_000, Number(opts.maxBytes) || 200 * 1024 * 1024);
  const { repo, dir, exec } = opts;
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    // 复用：目录里已有 .git ⇒ 直接取 HEAD（不重新 clone）。
    if (fs.existsSync(path.join(dir, '.git'))) {
      try {
        const r = await exec('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeout: 5_000 });
        const commit = r.stdout.trim();
        if (commit) return { ok: true, dir, commit, cached: true, reason: '' };
      } catch { /* 坏目录 ⇒ 下面重建 */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      await exec('git', ['clone', '--depth', '1', '--branch', repo.ref, repo.url, dir], { timeout });
    } catch {
      // 不是分支名（可能是 sha）⇒ 先浅克隆默认分支，再 checkout 该提交。
      fs.rmSync(dir, { recursive: true, force: true });
      await exec('git', ['clone', '--depth', '1', repo.url, dir], { timeout });
      await exec('git', ['-C', dir, 'checkout', repo.ref], { timeout });
    }
    const size = dirSizeBytes(dir, maxBytes);
    if (size > maxBytes) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: false, dir: '', commit: '', cached: false, reason: 'too_large' };
    }
    const r = await exec('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeout: 5_000 });
    const commit = r.stdout.trim();
    if (!commit) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: false, dir: '', commit: '', cached: false, reason: 'clone_failed' };
    }
    return { ok: true, dir, commit, cached: false, reason: '' };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
    const reason: RemoteWorkspaceFailure = /timed? ?out|etimedout/.test(msg) ? 'timeout' : 'clone_failed';
    return { ok: false, dir: '', commit: '', cached: false, reason };
  }
}

/** 有界目录体量：最多数 20000 个条目；超过上限立即返回 `max + 1`（不必数完）。 */
function dirSizeBytes(root: string, maxBytes: number): number {
  let total = 0;
  let entries = 0;
  const walk = (dir: string): void => {
    let list: fs.Dirent[];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      if (++entries > 20_000) return;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else {
        try { total += fs.statSync(p).size; } catch { /* 读不到不计 */ }
        if (total > maxBytes) return;
      }
    }
  };
  walk(root);
  return total;
}

/** 保留最近 `keep` 份（按 mtime），其余删除；只在 `remote-workspaces` 根下动。 */
export function cleanupRemoteWorkspace(baseDir: string, keep = 3): number {
  const base = path.resolve(baseDir);
  if (!fs.existsSync(base)) return 0;
  let deleted = 0;
  try {
    const dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
      const p = path.join(base, d.name);
      let mtime = 0;
      try { mtime = fs.statSync(p).mtimeMs; } catch { /* 读不到按最旧 */ }
      return { p, mtime };
    }).sort((a, b) => b.mtime - a.mtime);
    for (const d of dirs.slice(Math.max(0, keep))) {
      try { fs.rmSync(d.p, { recursive: true, force: true }); deleted++; } catch { /* best-effort */ }
    }
  } catch { /* 读不到目录 ⇒ 不删 */ }
  return deleted;
}
