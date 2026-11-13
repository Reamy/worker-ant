/**
 * zx_20261113_2 M3「通」——网络失败的**分类与提示**，一处真源（零依赖纯模块）。
 *
 * 病根（2026-11-13 真标本）：任务把 `ping 100% 丢包` 读成"主机离线"，而同一时刻
 *   `/usr/bin/nc` 能连上目标 3306 并读到 MySQL 握手，Python/Java 却 `EHOSTUNREACH`。
 *   真正的分因是「本进程被 macOS 本地网络权限/责任应用拦住」，不是主机不在网。
 *
 * 本模块只做两件事：
 *   1. 从命令输出里认出网络失败的种类（host unreachable / refused / timeout）；
 *   2. 给模型一段**可执行**的提示：先 TCP 复测，若 `nc` 能通而本进程不能，检查
 *      「系统设置 → 隐私与安全性 → 本地网络」里的**责任应用**（从 IDE 终端启动时通常是 IDE）。
 *
 * 纪律：只**追加提示**，不改工具原有的 `error/stdout/stderr` 原文；未命中时返回空串。
 *   `econnrefused`/`timeout` 只分类、不追加（正常构建输出里也常见 timeout 字样，避免噪音）。
 */

export type ShellNetworkFailure = 'ehostunreach' | 'econnrefused' | 'timeout' | null;

/** 从任意输出文本里认出网络失败种类；未命中返回 `null`。 */
export function classifyShellNetworkError(text: string): ShellNetworkFailure {
  const t = text || '';
  if (/EHOSTUNREACH|No route to host|errno[=\s]*65\b/i.test(t)) return 'ehostunreach';
  if (/ECONNREFUSED|Connection refused|errno[=\s]*61\b/i.test(t)) return 'econnrefused';
  if (/ETIMEDOUT|Connection timed out|timed out|timeout/i.test(t)) return 'timeout';
  return null;
}

/** 人话提示。未命中/未知返回空串（调用方据此决定是否追加键）。 */
export function networkHintFor(kind: ShellNetworkFailure): string {
  switch (kind) {
    case 'ehostunreach':
      return '该错误是 EHOSTUNREACH / No route to host：不要用 ping 判主机离线（很多主机关闭 ICMP）；'
        + '先用 TCP connect（如 /usr/bin/nc -z host port）复测。若 nc 能通而本进程不能，'
        + '检查 macOS「系统设置 → 隐私与安全性 → 本地网络」里**责任应用**是否已授权'
        + '（从 IntelliJ/VS Code 集成终端启动时，责任应用是 IDE 本身，不是工蚁）。';
    case 'econnrefused':
      return '端口拒绝连接：主机可达但服务未监听或端口不对；确认服务已启动与端口号。';
    case 'timeout':
      return '连接超时：可能是防火墙/网络策略；先用 TCP connect 复测目标端口。';
    default:
      return '';
  }
}

/**
 * 工具层用的**追加式**提示：只对 `ehostunreach` 返回非空（本轮的根因）；
 * 其余种类不追加，避免把普通构建里的 "timeout" 字样误当网络故障。
 */
export function networkNoteFor(result: { stdout?: string; stderr?: string; error?: string }): string {
  const kind = classifyShellNetworkError(
    [result.stderr, result.stdout, result.error].filter(Boolean).join('\n'),
  );
  return kind === 'ehostunreach' ? networkHintFor(kind) : '';
}
