/**
 * zx_20261110_2 B5「损」：工作目录扫描的**短时缓存**（按目录 + TTL，缺省 60s）——一处真源。
 *
 * 病根（本方案 §2 基线）：`scanWorkingDirOnce` 注释口径 ~450ms/次（readdir 339 + filter 99 + stat 13），
 * 而同一棵树在一次收口里会被**多个只读消费者**各扫一遍（判卷路径解析、事实快照的目录清单）。
 * 60s 内同一目录再扫一次，换来的只是同一份清单——纯等待。
 *
 * ⚠ **只给只读消费者**。凡"前后比对"（`captureWorldSnapshot` 的 before、收口后审计的 after、
 *   命令窗口的写入盘点）**必须**用 `scanWorkingDirOnce` 本尊——缓存会把"这 60s 里没变"伪装成
 *   "确实没变"，那正是审计最不能接受的一句假话。此约束写在这里，也由 rr 反证钉住。
 *
 * 语义细节（都是刻意的）：
 *   ① **同目录并发共享同一个 promise**——两次同时开扫不会真的扫两遍；
 *   ② **失败/空结果不缓存**（`null` 立即出表）：一次读盘失败不该让这个目录"消失 60s"；
 *   ③ 时钟可注入（`now`）——rr 用假时钟验 TTL，不依赖真实墙钟。
 */
import { createLogger } from './logger.js';
import { scanWorkingDirOnce, type WorkingDirScan } from './world-snapshot.js';

const logger = createLogger('scan-cache');

/** 缺省 TTL：一次收口（压缩 25s + 校验 12s + 审计）落在同一分钟内的重复扫描被吸收。 */
export const SCAN_CACHE_TTL_MS = 60_000;

interface ScanEntry {
  at: number;
  promise: Promise<WorkingDirScan | null>;
}

const scanCache = new Map<string, ScanEntry>();
const listingCache = new Map<string, { at: number; value: string[] }>();
let hits = 0;
let misses = 0;
let listingHits = 0;
let listingMisses = 0;

/** 缓存只读消费者：`scanWorkingDirCached`（判卷/B6 路径解析用）。 */
export function scanWorkingDirCached(
  root: string,
  opts: { ttlMs?: number; now?: number } = {},
): Promise<WorkingDirScan | null> {
  const key = String(root ?? '').trim();
  if (!key) return scanWorkingDirOnce(key);
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? SCAN_CACHE_TTL_MS;
  const hit = scanCache.get(key);
  if (hit && now - hit.at < ttl) {
    hits++;
    return hit.promise;
  }
  misses++;
  const promise = scanWorkingDirOnce(key)
    .then((v) => {
      if (!v) {
        scanCache.delete(key);
        logger.warn({ root: key }, '工作目录扫描未取得结果（目录不可读或不存在）——按"没有可扫描的世界"处理，已出缓存');
      }
      return v;
    })
    .catch((err: unknown) => {
      scanCache.delete(key);
      logger.warn({ root: key, errMsg: (err as Error)?.message }, '工作目录扫描抛错——按"没有可扫描的世界"处理，已出缓存');
      return null;
    });
  scanCache.set(key, { at: now, promise });
  return promise;
}

/** 事实快照的目录清单（**只读**）：同目录 60s 内复用同一份文件名清单。 */
export function factListingCached(
  root: string,
  build: () => Promise<string[]>,
  opts: { ttlMs?: number; now?: number } = {},
): Promise<string[]> {
  const key = String(root ?? '').trim();
  if (!key) return build();
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? SCAN_CACHE_TTL_MS;
  const hit = listingCache.get(key);
  if (hit && now - hit.at < ttl) {
    listingHits++;
    return Promise.resolve(hit.value);
  }
  listingMisses++;
  return build().then((value) => {
    listingCache.set(key, { at: now, value });
    return value;
  });
}

/**
 * 命中账（rr 用它做 **0→1** 的正面断言——"不抛"不算数）。
 * 计数只增不清，`clearScanCache()` 一并归零。
 */
export function scanCacheStats(): {
  hits: number; misses: number; listingHits: number; listingMisses: number; size: number;
} {
  return { hits, misses, listingHits, listingMisses, size: scanCache.size };
}

/** 清空缓存与计数（rr/诊断用；生产无需调用——TTL 自然过期）。 */
export function clearScanCache(): void {
  scanCache.clear();
  listingCache.clear();
  hits = 0;
  misses = 0;
  listingHits = 0;
  listingMisses = 0;
}
