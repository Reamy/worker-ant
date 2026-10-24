import pino from 'pino';
import path from 'node:path';
import fs from 'node:fs';

const LOG_DIR = path.resolve(process.cwd(), '../../data/logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const isDev = process.env.NODE_ENV !== 'production';

export function createLogger(module: string) {
  const streams: pino.StreamEntry[] = [];

  if (isDev) {
    streams.push({
      level: 'debug',
      stream: pino.transport({
        target: 'pino-pretty',
        // `SYS:` 前缀＝本地时区；pino-pretty 对**无前缀**格式串按 UTC 输出 ⇒ 裸 `HH:MM:ss` 会把
        //   本地 15:41 打成 [07:41] 且不标注时区（与桌面端 `main/core/logger.ts` 同用 `SYS:`）。
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
      }),
    });
  } else {
    streams.push({ level: 'info', stream: process.stdout });
  }

  // pino-roll 文件传输：开发/生产都尝试加载，缺失时回退到 stdout
  try {
    streams.push({
      level: 'info',
      stream: pino.transport({
        target: 'pino-roll',
        options: {
          file: path.join(LOG_DIR, 'ans-server'),
          frequency: 'daily',
          mkdir: true,
          dateFormat: 'yyyy-MM-dd',
          extension: '.log',
        },
      }),
    });
  } catch {
    // pino-roll 未安装时的回退
    if (!isDev) streams.push({ level: 'info', stream: process.stdout });
  }

  return pino(
    {
      name: module,
      level: isDev ? 'debug' : 'info',
    },
    pino.multistream(streams),
  );
}
