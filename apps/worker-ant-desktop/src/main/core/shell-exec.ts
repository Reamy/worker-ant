/**
 * zx_20260916_2 M1：工具层命令执行的**异步外壳**（唯一真源）。
 *
 * 病根（见 plans/improve/zx_20260916_2.md §1）：引擎整个跑在 Electron 主进程里，而工具用 `execSync`
 * 执行命令——命令跑多久，事件循环就被占住多久，窗口既不收输入也不重绘。实测（真工作目录
 * `projects/a-stock-advisor`）：`grep -rn "decision_snapshot" .` 墙钟 22.83s，期间事件循环
 * **maxLag=22818ms**（一拍未走）；换成异步 spawn 后墙钟 22.86s、**maxLag=2ms**。
 * ⇒ 异步化买到的不是"更快"，是"这段时间里界面能动"。
 *
 * 为什么不各处直接 `spawn`：四处调用点的错误形状（`{error, stdout, stderr}`）与回传长度各不同，
 * 必须逐字保真，否则模型看到的工具回话会变——那是另一场回归。故收成**一个**入口。
 */
import { spawn } from 'node:child_process';

export interface ShellResult {
  /** 退出码为 0 且未超时 */
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 输出超 `maxBuffer` 被截（旧实现此处是**抛** ERR_CHILD_PROCESS_STDIO_MAXBUFFER，见下） */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** 非零退出/超时时与 `execSync` 的 `err.message` 同形（`Command failed: <cmd>\n<stderr>`），供调用方原样回给模型 */
  error?: string;
}

export interface ShellOpts {
  cwd: string;
  timeoutMs: number;
  /** 单条流（stdout / stderr 各自）的收集上限，字节 */
  maxBuffer: number;
}

/** 超时后先礼后兵：SIGTERM 之后给 2s 宽限，再 SIGKILL */
const KILL_GRACE_MS = 2000;

/** 杀**整棵进程树**而非只杀 shell：`bash -c "grep … | head"` 里 grep 是孙进程，只杀 shell 会把它漏在后面继续吃 CPU */
function killTree(pid: number | undefined, sig: NodeJS.Signals): void {
  if (pid == null) return;
  try {
    if (process.platform === 'win32') process.kill(pid, sig);
    else process.kill(-pid, sig); // 负号 = 进程组（spawn 时 detached: true 使其自成一组）
  } catch { /* 已经退出了 */ }
}

export function runShellCommand(command: string, opts: ShellOpts): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      stdio: 'pipe',
      // POSIX 下自成进程组，超时才杀得掉孙进程。代价：命令未结束时退出应用不带走它——
      // 旧 `execSync` 是阻塞的，本就无从"中途退出"，故不构成回退。
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;

    const take = (cur: string, chunk: Buffer, mark: () => void): string => {
      const room = opts.maxBuffer - Buffer.byteLength(cur);
      if (room <= 0) { mark(); return cur; }
      if (chunk.length > room) { mark(); return cur + chunk.subarray(0, room).toString(); }
      return cur + chunk.toString();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => killTree(child.pid, 'SIGKILL'), KILL_GRACE_MS);
    }, opts.timeoutMs);

    child.stdout?.on('data', (d: Buffer) => { stdout = take(stdout, d, () => { stdoutTruncated = true; }); });
    child.stderr?.on('data', (d: Buffer) => { stderr = take(stderr, d, () => { stderrTruncated = true; }); });

    const finish = (exitCode: number | null, spawnError?: Error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const ok = !timedOut && exitCode === 0 && !spawnError;
      // 文案与 `execSync` 同形；超时额外缀如实说明（不把"超时被杀"冒充成"命令失败"）
      const errText = spawnError
        ? spawnError.message
        : `Command failed: ${command}\n${stderr}${timedOut ? `\n[超时 ${opts.timeoutMs / 1000}s 被杀]` : ''}`;
      resolve({ ok, exitCode, stdout, stderr, timedOut, stdoutTruncated, stderrTruncated, error: ok ? undefined : errText });
    };

    child.on('error', (e: Error) => finish(null, e));
    child.on('close', (code: number | null) => finish(code));
  });
}

/** 输出被截时的如实尾巴（调用方拼进回传文本，缺省为空串=不添字） */
export function truncationNote(r: Pick<ShellResult, 'stdoutTruncated' | 'stderrTruncated'>): string {
  return r.stdoutTruncated || r.stderrTruncated ? '（输出超上限已截断）' : '';
}
