/**
 * 路径围栏的**零依赖真源**（zx_20260929 M3 · J-1「只读围栏对齐写的硬红线」）。
 *
 * 四件东西住在这里，因为它们是同一件事的四面：**根校验** / **敏感路径表** / **命中判定** / **只读侧入口守卫**。
 *
 * ⚠ **为什么不在 `sandbox.ts` 里**（这张表和 `homeDir()` 原先就长在那儿）：
 *   只读三工具（`read_file` / `read_document` / `view_image`）要共用这一步，而 `sandbox.ts` 引
 *   `logger.ts`，logger 引 pino 并**在模块加载时就起 transport + 日志目录**。把表留在 sandbox 里，
 *   等于让**每一个引工具模块的受控回归**都平白拖进 pino——同 `audio-transcribe.ts` 头注释里那条
 *   既有约定（"刻意不引 `logger.ts`：pino 会拖进 transport 与日志目录，是 rr 直跑真实现的无谓负担"）。
 *   故本模块**零依赖**（只用 `node:path` / `node:os`），`sandbox.ts` **反向引它**——
 *   名单**仍然只有一份**，这才是 J-1 要的"复用 hard 边界口径，不另造第二份名单"。
 *
 * ⚠ **不许再造第二份名单**：新增敏感项**只改本文件的 `SENSITIVE_PATHS`**；
 *   `core/sandbox.ts` 的 `enforcePathScope` 与只读三工具读的是**同一张表**（前者经本模块 import）。
 *   renderer / 提示词里若还要提这些路径，那是**文案**，不是第二张表。
 */
import os from 'node:os';
import path from 'node:path';

/**
 * 家目录的**唯一**取值口径（zx_20260924_1 §M4-a）。
 *
 * 病根：`core/sandbox.ts` 原有三处各写一份家目录解析——`~/` 展开用 `process.env.HOME || '/root'`、
 * `isInsideUserHome` 判定用 `os.homedir()`、`isDangerousRemovalPath` 又写了一遍
 * `process.env.HOME || os.homedir()`。三处口径不一 ⇒ "展开出来的路径"与"是否算在家目录内"
 * 可能指的不是同一个目录（`~/.ssh` 的归一正是靠这里的同一个值才立得住）。
 * 优先级：`HOME`（与 shell 里 `~` 的语义一致）→ `os.homedir()`（系统口径）→ 字面量 `/root`（保留旧展开式的兜底值）。
 */
export function homeDir(): string {
  return process.env.HOME || os.homedir() || '/root';
}

/**
 * 是否**落在某个根之下**（含根自身）。**根校验的唯一口径**（zx_20260930 M1）。
 *
 * 调用方自己写 `resolved.startsWith(root)` 会漏掉「`/a/bc` 被 `/a/b` 认作子路径」这类**同名前缀**误判；
 * 少拼那个 `path.sep` 的一次通常不报错，只是**静默放宽**（越界的东西被当根内的放行）。故收成一处。
 * 两侧都过 `path.resolve`：调用方不必记得先归一，也不该各自再写一遍归一（第二份归一 = 第二套路径规则）。
 * 任一侧为空 ⇒ `false`（空路径不构成"在某个根内"，这条比"`path.resolve('')` 落到 cwd"更保守）。
 */
export function isInsideRoot(candidate: string, root: string): boolean {
  const cand = String(candidate ?? '').trim();
  const base = String(root ?? '').trim();
  if (!cand || !base) return false;
  const candAbs = path.resolve(cand);
  const rootAbs = path.resolve(base);
  return candAbs === rootAbs || candAbs.startsWith(rootAbs + path.sep);
}

/** 敏感路径表（硬边界，不可审批）。**改这里即改行为**，须有方案依据。 */
export const SENSITIVE_PATHS = [
  '/etc/passwd', '/etc/shadow', '/etc/sudoers', '/etc/ssh/',
  '/proc/', '/sys/', '/dev/',
  '/root/', '/home/', '/Users/',
  '~/.ssh/', '~/.gnupg/', '~/.aws/', '~/.config/',
  '.env', '.env.local', '.env.production',
  'node_modules/', '.git/',
];

/** 只在 strict 模式拦的那几项（子集口径见 `sensitivePathHit` 的 filter）。 */
export const STRICT_ONLY_BLOCK = ['.env', '.env.local', '.env.production', 'node_modules/', '.git/'];

/**
 * 敏感路径硬边界的**唯一一份表走查**（zx_20260929 M3 · J-1）。
 *
 * 只读三工具要的只是"命中敏感表 ⇒ 硬拒"这**一**步；`enforcePathScope` 还带着软边界
 * （工作目录外普通路径 ⇒ 可审批），那是**写**的语义，只读侧不引审批流。
 * 故把这一步单独导出、并由 `enforcePathScope` **调它**——一条规则一处实现；两侧各留一份名单
 * 就是"改一处忘另一处、判据先假绿"的老形状。
 *
 * 返回**命中的那一项**（调用方据此产出与 `enforcePathScope` 同串的 reason），未命中返 `null`。
 * ⚠ 传进来的 `resolved` 必须是**已归一为绝对路径**的写法（`~` 与相对路径的展开归属调用方，
 *   否则这里就成了第二份展开逻辑）。
 * ⚠ `STRICT_ONLY_BLOCK`（`.env`/`node_modules/`/`.git/`）**不在**本表走查内：它们只在 strict 模式拦，
 *   一并走查会把"读 `.env`/`.git/config` 当参考"这类合法读误伤（与 `enforcePathScope` 现行为一致）。
 */
export function sensitivePathHit(resolved: string, userHome: string = homeDir()): string | null {
  const isInsideUserHome = resolved === userHome || resolved.startsWith(userHome + path.sep);
  for (const sensitive of SENSITIVE_PATHS.filter(s => !s.startsWith('.env') && !s.startsWith('node_modules') && !s.startsWith('.git'))) {
    const clean = sensitive.replace(/\/$/, '');
    // `~` 归一：与 `~/` 展开同用 homeDir()（不写第二份展开逻辑）
    const abs = clean.startsWith('~/') ? path.join(userHome, clean.slice(2)) : clean;
    // `/Users`、`/home` 的语义是「允许一般家目录写入」：**当前用户**家目录内的普通路径不按敏感处理。
    // （归一前这条 continue 处在一段 isInsideUserHome 恒为 false 的分支里 = 死代码；现在它才真的有可能生效。）
    // 四个家目录敏感子目录在上一条命中、不受本特例放行。
    if ((abs === '/Users' || abs === '/home') && isInsideUserHome) continue;
    // 比较须带分隔符：`<home>/projects/foo/.ssh-backup/x` 这类同名前缀不得被判成 `~/.ssh`
    if (resolved === abs || resolved.startsWith(abs + path.sep)) return sensitive;
  }
  return null;
}

/** 路径遍历的统一回话。**写侧（`tools/write.ts`）与读侧（本守卫）逐字同串**——两把尺一个刻度。 */
export const TRAVERSAL_ERROR = '禁止路径遍历(..)';

export interface ReadPathResult {
  ok: boolean;
  /** `ok=true` 时是归一后的绝对路径；`ok=false` 时是尽力给出的落点（仅供回话里带出）。 */
  resolved: string;
  error?: string;
}

/**
 * 只读三工具（`read_file` / `read_document` / `view_image`）共用的**入口守卫**（zx_20260929 M3 · J-1）。
 *
 * 与写侧同尺的两条**硬红线**：
 *   ① `..` 遍历——回话与 `write_file` 逐字同串（`TRAVERSAL_ERROR`）；
 *   ② 敏感路径——复用 `sensitivePathHit`（同一张表、同一份 `/Users`,`/home` 特例、同一份分隔符比对），
 *      未命中则放行。**刻意不引 `enforcePathScope`**：那会连带把"工作目录外的普通路径"变成待审批，
 *      而本轮的裁定是**普通工作目录外绝对路径仍可读**（只读不是写，不引入审批流）。
 *
 * 归一：`~/` 展开归属本函数（用同一份 `homeDir()`），故 `resolved` 一出口就是绝对路径。
 * 裁决理由（为什么读侧**不**照抄写侧的非法字符黑名单）：那条黑名单护的是"路径会被拼进 shell"的写法，
 *   而这三把只读工具只把路径交给 `fs`，从不进 shell；照抄会误伤 `a(1).txt` / `${build}.json`
 *   这类**合法文件名**（"加严判据须按表限定"，见 auto-memory）。
 */
export function readPathGuard(filePath: string, workingDir: string): ReadPathResult {
  const raw = String(filePath ?? '');
  if (!raw.trim()) return { ok: false, resolved: '', error: '空路径被拒绝' };
  if (raw.includes('..')) return { ok: false, resolved: raw, error: TRAVERSAL_ERROR };
  const userHome = homeDir();
  const normalized = raw.startsWith('~/') ? path.join(userHome, raw.slice(2)) : raw;
  const resolved = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(workingDir, normalized);
  const hit = sensitivePathHit(resolved, userHome);
  if (hit) return { ok: false, resolved, error: `沙箱拦截: 禁止访问系统敏感路径 "${hit}"。` };
  return { ok: true, resolved };
}
