/**
 * zx_20261109_1 B2：命令窗口写入的 **run 级合并队列**。
 *
 * 病根：`registerFilesWrittenByCommand` 每跑完一条 `execute_command`/`run_privileged` 就把整棵工作树
 * 盘点一遍（怡寿里实测 **188–217ms/条**，文件 8,857 个）。一个 run 里跑 5–10 条命令，就是 1–2 秒的
 * 净开销，全压在"命令刚返回、模型还在等结果"的那一拍上；而它算出来的东西（窗口内被改过的文件）
 * 到 run 结束才被真正使用（补登记为 doc 产出物）。
 *
 * 治法：命令处只**记窗口**（O(1)，同步），run 结束前**合并成一次**盘点——
 *   ① 取 run 内**最早**的 `sinceMs`（晚开的窗口包含早开的窗口，合并只会变大不会变小）；
 *   ② 同一 run 的工作树扫描（after 快照/审计第二通道）**已经拿到全量 mtime**，优先复用，不再扫第二遍；
 *   ③ 没有可复用的扫描（早退路/异常路）才退回 `listFilesWrittenSince`。
 *
 * 边界如实（承 §6.1-3 红线）：合并把归因窗口从"该条命令"放宽到"本 run 最早那条命令"，
 * 期间**其他来源**的改动会被算进本任务——这是合并的已知代价，只在"单条 >150ms"时启用（实测 188–217ms）。
 */
import { createLogger } from './logger.js';
import { listFilesWrittenSince, type WorkingDirScan } from './world-snapshot.js';
import { isRuntimeArtifactPath } from './deliverable-types.js';

const logger = createLogger('command-write-queue');

/** 合并后的一个写入窗口（每个任务至多一个：run 内所有命令窗口的并集）。 */
export interface CommandWriteWindow {
  projectId: string;
  taskId: string;
  workingDir: string;
  /** run 内最早一条命令的**启动时刻**——窗口的起点。 */
  sinceMs: number;
  /** 窗口内出现过的工具（去重、按首次出现顺序）。 */
  vias: string[];
}

export interface CommandWriteQueuedItem {
  projectId: string;
  taskId: string;
  workingDir: string;
  sinceMs: number;
  via: string;
}

export interface CommandWriteFlushOptions {
  /** 最多补登记几个文件（**显示/落库**上限，非取数上限；超出时如实记日志）。 */
  limit: number;
  /** 逐文件登记（调用方注入，队列模块不碰 `ensureDocDeliverable`/DB 写口）。 */
  register: (absPath: string, via: string, win: CommandWriteWindow) => void;
  /** 本 run 已拿到的全量扫描（含 `mtimeMs`）；有且未被大仓上限截断时优先复用。 */
  scan?: WorkingDirScan | null;
}

/**
 * 每个 run 一份实例（由 `buildTools` 注入工具层）——**不用模块级可变全局**：
 * 并发 run 各记各的窗口，互不串味；rr 也可直接构造一份驱动真实现。
 */
export class CommandWriteQueue {
  private pending: CommandWriteWindow | null = null;

  /** 记一条命令窗口（同步、O(1)）。窗口按任务合并：`sinceMs` 取最早，`vias` 去重合并。 */
  enqueue(o: CommandWriteQueuedItem): void {
    if (!o.workingDir || !o.taskId) return;
    const prev = this.pending;
    if (!prev) {
      this.pending = { projectId: o.projectId, taskId: o.taskId, workingDir: o.workingDir, sinceMs: o.sinceMs, vias: [o.via] };
      return;
    }
    prev.sinceMs = Math.min(prev.sinceMs, o.sinceMs);
    if (!prev.vias.includes(o.via)) prev.vias.push(o.via);
  }

  /** 待盘点窗口是否存在（主路 flush 后为 false ⇒ finally 兜底立即返回，不触发第二遍扫描）。 */
  get hasPending(): boolean { return this.pending !== null; }

  /** 取出并清空（幂等：flush 只会真正跑一次）。 */
  take(): CommandWriteWindow | null {
    const w = this.pending;
    this.pending = null;
    return w;
  }

  /**
   * 盘点并补登记。队列为空 ⇒ 返回 `null`（立即返回，**不扫描**）。
   * 返回 `{ found, registered }` 供调用方/受控回归核对（`found` 是真实命中数，截断也如实）。
   */
  async flush(o: CommandWriteFlushOptions): Promise<{ found: number; registered: number } | null> {
    const win = this.take();
    if (!win) return null;
    let files: string[];
    if (o.scan && !o.scan.truncatedScan) {
      files = o.scan.files
        .filter((f) => typeof f.mtimeMs === 'number' && f.mtimeMs >= win.sinceMs)
        .map((f) => f.abs);
    } else {
      // 无可复用扫描（早退/异常路），或该扫描被大仓上限截断 ⇒ 退回不截断的生产盘点，宁可多扫一遍也不漏。
      files = await listFilesWrittenSince(win.workingDir, win.sinceMs);
    }
    // zx_20261113_2 M13：运行期产物不登记为交付物；同路径只登记一次。
    const uniqueFiles = [...new Set(files)].filter((f) => !isRuntimeArtifactPath(f));
    if (uniqueFiles.length === 0) return { found: 0, registered: 0 };
    const shown = uniqueFiles.slice(0, Math.max(1, o.limit));
    // 来源如实：一条命令 ⇒ 旧形（`execute_command`）；合并了多条 ⇒ 全部列出（`execute_command+run_privileged`）。
    const via = win.vias.join('+');
    let registered = 0;
    for (const absPath of shown) {
      // 单条失败只跳该条：一条坏登记不该让整轮盘点作废（与旧实现同一纪律）
      try { o.register(absPath, via, win); registered++; } catch { /* 单条登记失败跳过 */ }
    }
    if (uniqueFiles.length > shown.length) {
      // 如实记：截断了就说截断了（不冒充"就这些"）
      logger.warn(
        { taskId: win.taskId.slice(0, 8), vias: win.vias, found: uniqueFiles.length, registered: shown.length },
        '子进程落盘补登记触发上限，只登记了前若干项',
      );
    }
    return { found: uniqueFiles.length, registered };
  }
}
