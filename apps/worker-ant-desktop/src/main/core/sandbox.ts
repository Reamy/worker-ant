/**
 * 安全沙箱模块（从原工蚁 utils/sandbox.ts 移植）。
 * 三层防护：路径围栏 + 命令意图分类 + 模式判决。
 */
import path from 'node:path';
import { createLogger } from './logger.js';
// 敏感路径表 / 家目录口径 / 命中判定归 `path-fence.ts`（**零依赖**）——本文件与只读三工具
// 读的是**同一张表**（表不再在本文件里再写一份）；`homeDir` 在这里**转出**（既有 import 面不动）。
// 理由见那个模块的头注释。
import { STRICT_ONLY_BLOCK, homeDir, sensitivePathHit } from './path-fence.js';

export { homeDir };

const logger = createLogger('sandbox');

export type SandboxMode = 'strict' | 'workspace' | 'off';
export type CommandIntent = 'ReadOnly' | 'Write' | 'Destructive' | 'Network' | 'ProcessManagement' | 'SystemAdmin' | 'Unknown';

export interface PathScopeResult {
  allowed: boolean;
  resolvedPath: string;
  reason?: string;
  /** 软边界：工作目录外普通路径，可经用户审批放行；缺省(false)=硬边界(敏感路径/TOCTOU/deny)不可审批 */
  approvable?: boolean;
}
export interface CommandValidation { allowed: boolean; intent: CommandIntent; reason?: string; }

/**
 * 额外路径规则（deny 优先于 allow）。
 * ⚠ 当前无调用方，见 `plans/improve/zx_20260924_1.md` §4：`core/tools/write.ts` 的两处
 * `enforcePathScope` 调用都只传 `'workspace'`、不带 rules ⇒ `denyPaths`/`allowPaths` 从未被喂过值。
 * 本轮只登记，不删、不接线（J-3）。
 */
export interface PathRules {
  /** 额外允许写入/访问的绝对路径（在工作目录之外） */
  allowPaths?: string[];
  /** 额外拒绝的路径（即使在工作目录内也拒绝） */
  denyPaths?: string[];
}

/**
 * TOCTOU 防护：拦截会在「校验时」与「执行时」产生歧义的路径写法。
 * 借鉴 Claude Code pathValidation.ts 的安全检查。
 *  - UNC 路径（\\ 开头）可能泄露凭据
 *  - tilde 变体（~user / ~+ / ~- / ~N）只处理 ~ 和 ~/，其余 shell 会展开成别的路径
 *  - shell 展开（$VAR / $(cmd) / %VAR% / =cmd）校验时是字面量、执行时被 shell 展开
 */
export function validatePathSafety(p: string): { safe: boolean; reason?: string } {
  if (p.startsWith('\\\\') || p.startsWith('//')) {
    return { safe: false, reason: 'UNC 网络路径需手动审批' };
  }
  if (p.startsWith('~') && p !== '~' && !p.startsWith('~/')) {
    return { safe: false, reason: 'tilde 变体路径(~user/~+/~-)需手动审批' };
  }
  if (p.includes('$') || p.includes('%') || p.startsWith('=')) {
    return { safe: false, reason: '路径含 shell 展开语法($/%)需手动审批' };
  }
  return { safe: true };
}

/**
 * 危险删除路径检测（rm/rmdir 场景）。
 * 借鉴 Claude Code isDangerousRemovalPath：通配符、根目录、家目录、根目录直接子目录。
 */
export function isDangerousRemovalPath(p: string): boolean {
  let s = p.replace(/[\\/]+/g, '/');
  // ~ 会被 shell 展开为家目录，先展开再判断（家目录口径与 enforcePathScope 共用 homeDir()）
  if (s === '~' || s.startsWith('~/')) {
    s = homeDir().replace(/[\\/]+/g, '/') + s.slice(1);
  }
  if (s === '*' || s.endsWith('/*')) return true;
  const normalized = s === '/' ? s : s.replace(/\/$/, '');
  if (normalized === '/') return true;
  if (normalized === homeDir().replace(/[\\/]+/g, '/')) return true;
  if (path.posix.dirname(normalized) === '/') return true; // /usr /tmp /etc 等根目录直接子目录
  return false;
}

export function enforcePathScope(filePath: string, workspaceDir: string, mode: SandboxMode, rules?: PathRules): PathScopeResult {
  if (mode === 'off') {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceDir, filePath);
    return { allowed: true, resolvedPath: resolved };
  }
  if (!filePath || filePath.trim() === '') return { allowed: false, resolvedPath: '', reason: '空路径被拒绝' };
  if (filePath.startsWith('-')) return { allowed: false, resolvedPath: '', reason: `路径以"-"开头(参数混淆): ${filePath}` };
  // TOCTOU 防护（在 resolve 之前，拦截会产生校验/执行歧义的写法）
  const safety = validatePathSafety(filePath);
  if (!safety.safe) return { allowed: false, resolvedPath: filePath, reason: safety.reason };
  // 家目录只此一种口径：`~/` 展开与下面的「是否在家目录内」判定共用 homeDir()
  const userHome = homeDir();
  let normalized = filePath;
  if (normalized.startsWith('~/')) {
    normalized = path.join(userHome, normalized.slice(2));
  }
  const resolved = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(workspaceDir, normalized);
  const wsResolved = path.resolve(workspaceDir);
  const isInsideWorkspace = resolved === wsResolved || resolved.startsWith(wsResolved + path.sep);
  const isInsideUserHome = resolved === userHome || resolved.startsWith(userHome + path.sep);
  // deny 优先：额外拒绝路径（即使在工作目录内也拒绝），先于一切允许规则
  if (rules?.denyPaths?.length) {
    for (const deny of rules.denyPaths) {
      const denyResolved = path.resolve(deny);
      if (resolved.startsWith(denyResolved + path.sep) || resolved === denyResolved) {
        return { allowed: false, resolvedPath: resolved, reason: `沙箱拦截: 路径被额外拒绝规则拦截 "${deny}"。` };
      }
    }
  }
  // ── 敏感路径：硬边界，不可审批 ───────────────────────────────────────────────
  // 病根（zx_20260924_1 §M4-a / F5）：旧实现把整块敏感检查关在
  // `if (!isInsideWorkspace && !isInsideUserHome)` 里，且表里 `~/.ssh/` 一类从不做 `~` 归一 ——
  // `.ssh`/`.gnupg`/`.aws`/`.config` 恰恰全在家目录内，于是这四项「死两遍」：
  //   ① `resolved.startsWith('~/.ssh/')` 对恒为绝对路径的 resolved 永远为假；
  //   ② 循环整块又因「路径在家目录内」被跳过。
  // 结果 `~/.ssh/id_rsa` 直落下面那条**软边界**分支（approvable:true）⇒ 审批一次即可写 authorized_keys。
  // 现：`~` 归一后照常比对，且**家目录不再享受整块豁免**（豁免只剩「工作目录内」这一条 —— 工作目录是任务自己的地盘）。
  // ⚠ 已登记的**残余边界**（本轮只登记、不改，J-3 不动拦截面）：此门只对「绝对路径 / `~` 写法」开，
  //   用相对路径一路 `../` 爬出工作目录时（实测 `../../../../../etc/passwd` 落在 `/etc/passwd`）整段不查敏感表、
  //   仍直落下面的软边界（`approvable:true`）。本轮治的是「家目录内整块跳过」与「`~` 从不归一」两处，此处不在范围内。
  // 表走查本身归 `sensitivePathHit`（只读三工具也要这一步，见其头注释）；本函数只留「工作目录内豁免」这一条策略。
  if (path.isAbsolute(normalized) || normalized.startsWith('~')) {
    if (!isInsideWorkspace) {
      const hit = sensitivePathHit(resolved, userHome);
      if (hit) {
        logger.warn({ filePath, sensitive: hit }, '沙箱拦截: 系统敏感路径');
        return { allowed: false, resolvedPath: resolved, reason: `沙箱拦截: 禁止访问系统敏感路径 "${hit}"。` };
      }
    }
  }
  if (!isInsideWorkspace) {
    // allow 规则：额外允许的路径（在工作目录之外，如显式配置的输出目录）
    const inAllow = rules?.allowPaths?.some(ap => {
      const apResolved = path.resolve(ap);
      return resolved.startsWith(apResolved + path.sep) || resolved === apResolved;
    });
    if (!inAllow) {
      // 软边界：工作目录外普通路径，可经用户审批放行（敏感路径/TOCTOU 已在前序步骤硬拒绝）
      return { allowed: false, resolvedPath: resolved, reason: `沙箱拦截: 路径 "${filePath}" 逃逸工作目录。`, approvable: true };
    }
  }
  if (mode === 'strict') {
    // ⚠ 当前无调用方，见 `plans/improve/zx_20260924_1.md` §4：现有两处调用统一传 `'workspace'`，
    //   本分支从未被执行过。本轮只登记，不删不接线（J-3）。
    const relative = path.relative(wsResolved, resolved);
    for (const sensitive of STRICT_ONLY_BLOCK) {
      if (relative.startsWith(sensitive) || relative === sensitive) {
        return { allowed: false, resolvedPath: resolved, reason: `沙箱拦截(strict模式): 禁止访问 "${sensitive}" 类型文件。` };
      }
    }
  }
  return { allowed: true, resolvedPath: resolved };
}

const READ_ONLY_COMMANDS = new Set(['cat', 'head', 'tail', 'wc', 'ls', 'find', 'tree', 'pwd', 'grep', 'egrep', 'fgrep', 'file', 'du', 'df', 'diff', 'which', 'whoami', 'date', 'env', 'uname', 'echo', 'sort', 'uniq', 'stat', 'readlink', 'realpath', 'basename', 'dirname', 'printf']);
const WRITE_COMMANDS = new Set(['cp', 'mv', 'mkdir', 'touch', 'tee', 'ln', 'git', 'pip', 'pip3', 'npm', 'yarn', 'pnpm', 'npx', 'cargo', 'gem', 'brew', 'python', 'python3', 'node', 'ruby', 'rustc']);
const DESTRUCTIVE_COMMANDS = new Set(['rm', 'rmdir', 'shred', 'chmod', 'chown', 'chgrp', 'dd', 'mkfs', 'mkswap', 'fdisk', 'parted']);
const NETWORK_COMMANDS = new Set(['curl', 'wget', 'ssh', 'scp', 'nc', 'netcat', 'ncat', 'ping', 'traceroute', 'nslookup', 'dig', 'host']);
const PROCESS_COMMANDS = new Set(['kill', 'pkill', 'killall', 'ps', 'top', 'htop', 'nice', 'renice']);
const SYSTEM_COMMANDS = new Set(['sudo', 'su', 'mount', 'umount', 'systemctl', 'service', 'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'docker', 'podman', 'kubectl']);
const INTERPRETER_COMMANDS = new Set(['sh', 'bash', 'zsh']);

export function isPrivilegeRequestable(intent: CommandIntent, command?: string): boolean {
  if (intent === 'Destructive') return false;
  if (intent === 'SystemAdmin' || intent === 'ProcessManagement') return true;
  if (command) {
    const cmdName = command.trim().split(/\s+/)[0]?.split('/').pop()?.toLowerCase() || '';
    if (INTERPRETER_COMMANDS.has(cmdName)) return true;
  }
  return false;
}

export function classifyBashCommand(command: string): CommandIntent {
  const trimmed = command.trim();
  if (!trimmed) return 'Unknown';
  const heredocMatch = trimmed.match(/^cat\s+>\s*(.+?)\s+<<\s*'([^']+)'/);
  if (heredocMatch) return 'Write';
  const cmdName = trimmed.split(/\s+/)[0]?.split('/').pop()?.toLowerCase() || '';
  if (trimmed.includes('|')) {
    const pipes = trimmed.split('|');
    const lastCmd = pipes[pipes.length - 1]?.trim().split(/\s+/)[0]?.split('/').pop()?.toLowerCase() || '';
    if (READ_ONLY_COMMANDS.has(lastCmd)) return 'ReadOnly';
  }
  if (/>\s*\/|\d*>\s*\//.test(trimmed) || trimmed.includes('>>')) {
    if (!DESTRUCTIVE_COMMANDS.has(cmdName)) return 'Write';
  }
  if (cmdName === 'git' && /push.*--force|--delete/.test(trimmed)) return 'Destructive';
  if (cmdName === 'git' && /clone|pull|fetch/.test(trimmed)) return 'Network';
  if (DESTRUCTIVE_COMMANDS.has(cmdName)) return 'Destructive';
  if (SYSTEM_COMMANDS.has(cmdName)) return 'SystemAdmin';
  if (PROCESS_COMMANDS.has(cmdName)) return 'ProcessManagement';
  if (NETWORK_COMMANDS.has(cmdName)) return 'Network';
  if (WRITE_COMMANDS.has(cmdName)) return 'Write';
  if (READ_ONLY_COMMANDS.has(cmdName)) return 'ReadOnly';
  return 'Unknown';
}

/**
 * 命令判决（strict 只读 / workspace 拦破坏性·系统管理·网络·进程 / off 全放行）。
 *
 * ⚠ 当前无调用方，见 `plans/improve/zx_20260924_1.md` §4：`execute_command`
 * （`core/tools/shell.ts`）走的是 `tool-guards.ts` 的字符表 + `classifyBashCommand` /
 * `isPrivilegeRequestable`，**不经过本函数** ⇒ 这里的网络/进程拦截从未接线
 * （提示词里那句「禁 curl/wget」因此与实现不符，见该方案 §4.2 V-4）。本轮只登记，不删不接线（J-3）。
 */
export function validateBashCommand(command: string, mode: SandboxMode, _workspaceDir: string): CommandValidation {
  const intent = classifyBashCommand(command);
  if (mode === 'off') return { allowed: true, intent };
  if (mode === 'strict') {
    if (intent !== 'ReadOnly') return { allowed: false, intent, reason: `沙箱拦截(strict模式): 只允许只读命令。当前命令意图为 ${intent}。` };
    return { allowed: true, intent };
  }
  if (mode === 'workspace') {
    if (intent === 'Destructive') return { allowed: false, intent, reason: '沙箱拦截(workspace模式): 破坏性命令被拦截。' };
    if (intent === 'SystemAdmin') return { allowed: false, intent, reason: `沙箱拦截(workspace模式): 系统管理命令被拦截（${command.trim().split(/\s+/)[0]}）。` };
    if (intent === 'Network') {
      const cmdName = command.trim().split(/\s+/)[0]?.split('/').pop()?.toLowerCase() || '';
      if (cmdName === 'git') return { allowed: true, intent };
      return { allowed: false, intent, reason: '沙箱拦截(workspace模式): 网络命令被拦截。如需下载资源请使用 read_web 工具。' };
    }
    if (intent === 'ProcessManagement') return { allowed: false, intent, reason: '沙箱拦截(workspace模式): 进程管理命令被拦截。' };
    return { allowed: true, intent };
  }
  return { allowed: true, intent };
}

export function getSandboxPrompt(mode: SandboxMode): string {
  switch (mode) {
    case 'strict': return '[安全沙箱·strict] 当前项目处于严格只读模式。你只能执行查看/搜索类操作——禁止创建、修改、删除任何文件。';
    case 'workspace': return '[安全沙箱·workspace] 当前项目处于工作区模式。你可以在项目工作目录内自由读写文件，pip/npm/brew等包管理器和python/node等解释器可直接使用。禁止执行 rm -rf/mkfs 等破坏性命令，禁止 curl/wget 等网络操作（git clone除外）。';
    case 'off': return '';
    default: return '';
  }
}
