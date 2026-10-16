/**
 * zx_20261007 M1（毛泽东·反对本本主义·没有调查没有发言权 / 道德经·信言不美 / 维特根斯坦·意义即用法）:
 * **真 CPU 利用率采样**——跨平台、可注入、无基线即如实说"不知道"。
 *
 * 为什么不能拿 `os.loadavg()[0]` 当 CPU 利用率（本模块要解决的问题）：
 *   - Windows 上 `os.loadavg()` **恒返回 `[0,0,0]`** ⇒ 界面永远"负载 0.00"（一句恒假的美言）；
 *   - 即便在 macOS/Linux，load average 是**可运行队列长度**（含 I/O 等待、不按核数归一），
 *     它回答的是"有多少活排队"，**不是**"CPU 有多少时间在干活"。
 *
 * 真利用率的唯一算法是**两次采样做差**：`os.cpus()` 的 `times` 是**自开机累计**的，
 *   单看一次只能知道"开机至今干了多少"，两次相减才知道"这段时间里干了多少"。
 *   ⇒ 单次采样（无上次基线）**必须返回 `null`**（"不知道"不许伪装成 0——0 是"空闲"的谎）。
 *
 * ⚠ 采样器**有状态**（记住上次累计值）。故导出的是**工厂** `createCpuSampler()`：真机持一个
 *   模块级单例（见 `node-heartbeat.ts`），受控回归各造各的实例——共用单例会让断言互相串味。
 */
import os from 'node:os';

/** `os.cpus()` 元素的**最小可注入形状**（只取 `times`；真实 `os.cpus()` 结构相容）。 */
export interface CpuInfoLike {
  times: { user: number; nice: number; sys: number; idle: number; irq: number };
}

export interface CpuSample {
  /** 该区间 CPU 利用率（0–100，一位小数）；**无基线／取不到／区间为零 ⇒ `null`**。 */
  percent: number | null;
  /** 采样时刻（ISO，按注入时钟）；供调用方判断两个样品的时间跨度。 */
  at: string;
}

export interface CpuSamplerDeps {
  /** 读取 CPU 累计计数；缺省 `os.cpus()`。 */
  cpus?: () => CpuInfoLike[];
  /** 注入时钟（受控回归用）；缺省 `Date.now`。 */
  now?: () => number;
}

export interface CpuSampler {
  /** 采一个样。与上一次采样的累计值做差算利用率。**永不抛**（取不到即 `null`）。 */
  sample(): CpuSample;
}

/** 全核累加：`idle` 与 `total`（=busy+idle）。全零／越界 ⇒ `null`（拿不到可信基线）。 */
function accumulate(cpus: CpuInfoLike[]): { idle: number; total: number } | null {
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    if (!t) continue;
    const busy = t.user + t.nice + t.sys + t.irq;
    idle += t.idle;
    total += busy + t.idle;
  }
  if (!Number.isFinite(idle) || !Number.isFinite(total) || total <= 0) return null;
  return { idle, total };
}

/** 造一个有状态的采样器。 */
export function createCpuSampler(deps: CpuSamplerDeps = {}): CpuSampler {
  const readCpus = deps.cpus ?? (() => os.cpus() as unknown as CpuInfoLike[]);
  const now = deps.now ?? (() => Date.now());
  let last: { idle: number; total: number } | null = null;

  return {
    sample(): CpuSample {
      const at = new Date(now()).toISOString();
      let cur: { idle: number; total: number } | null;
      try {
        cur = accumulate(readCpus());
      } catch {
        cur = null;
      }
      if (!cur) return { percent: null, at };
      const prev = last;
      last = cur;
      if (!prev) return { percent: null, at }; // 单次采样没有基线 ⇒ 如实说"不知道"
      const dTotal = cur.total - prev.total;
      const dIdle = cur.idle - prev.idle;
      if (dTotal <= 0 || dIdle < 0) return { percent: null, at }; // 计数回绕／未推进 ⇒ 不编数
      const usage = (1 - dIdle / dTotal) * 100;
      const percent = Math.round(Math.min(100, Math.max(0, usage)) * 10) / 10;
      return { percent, at };
    },
  };
}
