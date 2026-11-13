/**
 * zx_20261110_2 B6（G9）「无产出 ≠ 无工作」——`score < 20` 分支的**改动证据**。
 *
 * 病根（真标本 `2c1d…` 87 步任务）：执行体跑了几十步、真改了一批文件，但**没有登记任何产出物**，
 * 于是旧的「无产出物且无对话 ⇒ failed」把它判成失败。可是「账上没有产出物」与「什么都没做」
 * 不是同一件事：一个是被漏登记，一个是真没干。把这两件事叫同一个名字，就是名实不符——
 * 用户看到 `failed`，会以为模型白跑；实际它做了一半的活，只差人点一下"补登记"。
 *
 * 本模块只回答**一个问题**：本轮到底有没有动过盘。三种答案，三句话，各自都不撒谎：
 *   · `changed`     —— 找到 mtime ≥ 本轮起点的文件（列出前 N 个，如实体现在证据里）；
 *   · `none`        —— 盘上确实没有改动（若引擎记到了写调用，也就照实说"记到了但没落盘"）；
 *   · `unavailable` —— 取不到（工作目录不可读/扫描失败）⇒ **不冒充**"没改动"。
 *
 * 纯判定与取数分离：`classifyChangeEvidence` / `decideNoOutputDisposition` 零 IO，rr 直跑真实现；
 * `collectChangeEvidence` 只在**罕见的** `score < 20` 分支被调用，故可以付一次扫描的钱。
 */
import path from 'node:path';
import type { WorkingDirScan } from './world-snapshot.js';
import { listFilesWrittenSince } from './world-snapshot.js';

/** 证据里最多列出几个文件（账要可读；总数另记 `total`）。 */
export const CHANGE_EVIDENCE_LIST_LIMIT = 10;
/** 低于这个步数不判"做了一半"——几步就跑完的空任务，凭改动也谈不上"有工作"。 */
export const NO_OUTPUT_CHANGE_MIN_STEPS = 10;

export type ChangeEvidenceKind = 'changed' | 'none' | 'unavailable';

export interface ChangeEvidence {
  kind: ChangeEvidenceKind;
  /** 相对工作目录的路径（≤ `CHANGE_EVIDENCE_LIST_LIMIT`，按 mtime 新→旧） */
  files: string[];
  /** 命中的文件总数（不受列表上限影响） */
  total: number;
  /** 引擎本轮记到的写调用次数（仅用于 `none` 时把话说明白） */
  writeCalls: number;
  /** 归因起点（本轮开始时刻，ms） */
  sinceMs: number;
}

/**
 * 从一次**已有**的工作目录扫描里取改动证据（复用 `auditScan`，不额外扫盘）。
 *
 * `scan=null` ⇒ `unavailable`：扫描失败不等于没改动，**不得**退化成 `none`。
 * 文件按 mtime 降序（最新动的排前面），相对 `root` 输出；排序稳定便于账上比对。
 */
export function classifyChangeEvidence(
  scan: Pick<WorkingDirScan, 'root' | 'files'> | null,
  sinceMs: number,
  writeCalls: number,
): ChangeEvidence {
  if (!scan || !Array.isArray(scan.files)) {
    return { kind: 'unavailable', files: [], total: 0, writeCalls, sinceMs };
  }
  const root = String(scan.root ?? '');
  const hit = scan.files
    .filter((f) => typeof f.mtimeMs === 'number' && f.mtimeMs >= sinceMs)
    .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  const rel = hit.map((f) => (root ? (path.relative(root, f.abs) || f.abs) : f.abs));
  return {
    kind: rel.length > 0 ? 'changed' : 'none',
    files: rel.slice(0, CHANGE_EVIDENCE_LIST_LIMIT),
    total: rel.length,
    writeCalls,
    sinceMs,
  };
}

export interface NoOutputDisposition {
  /** `pause_changed`：有改动但没登记产出物 ⇒ 置 paused 等人补登记；`fail_no_output`：维持 failed */
  action: 'pause_changed' | 'fail_no_output';
  /** 写进会话行与暂停附注的人话（一句话说清依据；不夸大、不遮掩） */
  note: string;
}

/**
 * `score < 20` 分支该置 paused 还是 failed——**唯一判据点**（rr 直跑）。
 *
 * 规则（与方案 §B6 逐字对齐）：
 *   ① `steps >= minSteps` **且** 证据为 `changed` ⇒ `pause_changed`（不是失败：活干了，账没记）；
 *   ② 无改动证据 ⇒ `fail_no_output`；
 *   ③ 取不到证据 ⇒ `fail_no_output`，但附注**明说**未能取得证据——不把"不知道"说成"没动"。
 */
export function decideNoOutputDisposition(
  evidence: ChangeEvidence,
  opts: { steps: number; minSteps?: number },
): NoOutputDisposition {
  const minSteps = Math.max(1, Math.floor(opts.minSteps ?? NO_OUTPUT_CHANGE_MIN_STEPS));
  if (evidence.kind === 'changed') {
    const list = evidence.files.slice(0, 5).join('、') + (evidence.total > 5 ? ' 等' : '');
    if (opts.steps >= minSteps) {
      return {
        action: 'pause_changed',
        note: `执行 ${opts.steps} 步、改动了 ${evidence.total} 个文件（${list}），但没有登记任何产出物——请补登记，或确认这些改动与目标无关`,
      };
    }
    return {
      action: 'fail_no_output',
      note: `未登记产出物（仅执行 ${opts.steps} 步；改动 ${evidence.total} 个文件：${list}）`,
    };
  }
  if (evidence.kind === 'none') {
    const wrote = evidence.writeCalls > 0 ? `；引擎记到 ${evidence.writeCalls} 次写调用，盘上无对应落盘` : '';
    return { action: 'fail_no_output', note: `未产生产出物或有效对话，且盘上无任何文件改动${wrote}` };
  }
  return {
    action: 'fail_no_output',
    note: '未产生产出物或有效对话，且**未能取得改动证据**（工作目录不可读/扫描失败）——按无产出处置，但不代表确无改动',
  };
}

/**
 * 取改动证据：优先复用本次收口已有的扫描（`auditScan`），没有才退回 `listFilesWrittenSince`。
 * 任何异常 ⇒ `unavailable`（不猜、不吞成 `none`）。
 */
export async function collectChangeEvidence(input: {
  workingDir: string;
  sinceMs: number;
  writeCalls: number;
  scan?: Pick<WorkingDirScan, 'root' | 'files'> | null;
}): Promise<ChangeEvidence> {
  try {
    if (input.scan) return classifyChangeEvidence(input.scan, input.sinceMs, input.writeCalls);
    const wd = String(input.workingDir ?? '').trim();
    if (!wd) return { kind: 'unavailable', files: [], total: 0, writeCalls: input.writeCalls, sinceMs: input.sinceMs };
    const files = await listFilesWrittenSince(wd, input.sinceMs);
    const rel = files.map((abs) => path.relative(wd, abs) || abs);
    return {
      kind: rel.length > 0 ? 'changed' : 'none',
      files: rel.slice(0, CHANGE_EVIDENCE_LIST_LIMIT),
      total: rel.length,
      writeCalls: input.writeCalls,
      sinceMs: input.sinceMs,
    };
  } catch {
    return { kind: 'unavailable', files: [], total: 0, writeCalls: input.writeCalls, sinceMs: input.sinceMs };
  }
}
