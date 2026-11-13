import pino from 'pino';
import path from 'node:path';
import fs from 'node:fs';
import { packagedUserDataDir } from './app-paths.js';

let _logDir: string | null = null;

// zx_20261011 M7: 登记每个 logger 的 multistream，供关机收尾 flush（见 flushLoggersSync）。
// 每个 `pino.transport` 起一个 worker 线程；退出时不冲，最后几行日志可能随进程硬退而丢。
type FlushableDest = { flushSync?: () => void };
const _flushables: FlushableDest[] = [];

/**
 * 关机收尾：把各 transport worker 的缓冲**同步**冲出。
 * `ThreadStream.flushSync` 判 `destroyed` 即返（同 `write` 判它即抛）⇒ 对已退 worker 不挂（10s 上限只对**活**worker）。
 */
export function flushLoggersSync(): void {
  for (const d of _flushables) {
    try { d.flushSync?.(); } catch { /* worker 已退或已 flush，忽略 */ }
  }
}

export function setLogDir(dir: string): void {
  _logDir = dir;
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 日志目录：显式设过则用之；打包版落 `<userData>/logs`（cwd 是 `/`，按 cwd 上溯会落到
 * `/data/logs`——pino-roll worker 起不来，此后每条日志重复抛 `ENOENT mkdir '/data'`）；
 * 其余（dev/rr）维持仓库 `data/logs`。
 *
 * 在**模块求值期**就要定案：40 处 `const logger = createLogger(...)` 都在 import 阶段执行，
 * 早于 `main/index.ts` 函数体，故不能靠那里的 `setLogDir(...)` 事后注入。
 */
function getLogDir(): string {
  if (_logDir) return _logDir;
  const packagedRoot = packagedUserDataDir();
  return packagedRoot
    ? path.join(packagedRoot, 'logs')
    : path.resolve(process.cwd(), '../../data/logs');
}

const isDev = process.env.NODE_ENV !== 'production';

/**
 * zx_20261110_2 B8: 日志文件名前缀（模块求值期定案，与 `getLogDir` 同一条"import 阶段就要定"的理由）。
 *
 * 病根：rr 全量与桌面生产共用 `data/logs/worker-ant.<date>.log`——一场回归会把几百套件的噪声灌进
 * 用户当天的生产日志，"排查线上问题"与"看回归日志"抢同一个文件，谁也不好读。
 * 缺省不变（`worker-ant`）；`scripts/run-rr-all.mjs` 给子进程注入 `WA_LOG_FILE_PREFIX=rr`，
 * 于是回归写 `rr.<date>.log`、桌面仍写 `worker-ant.<date>.log`——`getLogDir` 不动，目录还是同一个。
 *
 * 取值只留文件名安全字符：这是文件名片段，放 `/` 或空串会把日志写到意料之外的地方；
 * 清洗后为空 ⇒ 回落缺省（不造出 `.2026-11-11.log` 这种隐身文件）。
 *
 * ⚠ 抽成**纯函数**（可传参、可被 rr 直接 import 断言）：清洗规则只能有这一份。此前是就地 IIFE，
 *   判据只能靠"源码里有没有那段字符串"，改一个字符就报成"清洗没了"、而真错（如漏了 `\\` 清洗）反而照绿。
 */
export function logFilePrefix(raw: string | undefined): string {
  const cleaned = String(raw ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '');
  return cleaned || 'worker-ant';
}

// ⚠ 环境变量由**调用方**取，不由本函数在缺参时自己读：`logFilePrefix(undefined)` 必须恒等于"未设"，
//   否则在注入了 `WA_LOG_FILE_PREFIX=rr` 的回归进程里，"未设 ⇒ 缺省"这条判据会**读到自己**而成假绿/假红。
const LOG_FILE_PREFIX = logFilePrefix(process.env.WA_LOG_FILE_PREFIX);

/**
 * 解析子进程 stderr 输出的日志级别。
 * Python 生态中 stderr 是默认日志通道，大量 INFO 级别日志不应被误报为 WARN。
 *
 * 规则：
 * 1. 先匹配显式级别前缀: [ERROR]/[WARN]/[INFO]/[DEBUG] 及其中文等价
 * 2. 无前缀时：info 级关键词优先（未配置/未启用/降级），再匹配 error 级关键词
 * 3. 都不匹配时默认 'info'
 */
export function parseStderrLevel(output: string): pino.Level {
  const s = output.trimStart();
  // 显式级别前缀
  if (/^\[(ERROR|错误|API错误)\]/.test(s)) return 'error';
  if (/^\[(WARN|WARNING|警告)\]/.test(s)) return 'warn';
  if (/^\[(INFO|信息)\]/.test(s)) return 'info';
  if (/^\[(DEBUG|调试)\]/.test(s)) return 'debug';
  // 无前缀：info 级关键词优先（"未配置，所以不可用" ≠ 错误）
  if (/(未配置|未启用|已降级|已过期|回退)/.test(s)) return 'info';
  // 无前缀：错误/异常关键词
  if (/(^失败|全部.*失败|所有.*失败|错误$|异常$|超时$|拒绝连接|Connection refused|Connection aborted|RemoteDisconnected|timeout)/i.test(s)) return 'error';
  return 'info';
}

export function createLogger(module: string) {
  const streams: pino.StreamEntry[] = [];

  // 控制台输出（开发环境用pino-pretty，生产用JSON）
  if (isDev) {
    streams.push({
      level: 'debug',
      stream: pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } }),
    });
  } else {
    streams.push({ level: 'info', stream: process.stdout });
  }

  // 文件输出——按天分割
  streams.push({
    level: 'info',
    stream: pino.transport({
      target: 'pino-roll',
      options: {
        file: path.join(getLogDir(), LOG_FILE_PREFIX),
        frequency: 'daily',
        mkdir: true,
        dateFormat: 'yyyy-MM-dd',
        extension: '.log',
      },
    }),
  });

  const dest = pino.multistream(streams);
  _flushables.push(dest as unknown as FlushableDest);
  return pino({
    name: module,
    level: isDev ? 'debug' : 'info',
  }, dest);
}
