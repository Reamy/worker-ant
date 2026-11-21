/**
 * zx_20261118_2 M4「拆」——**版本控制边界（实测）**：拆解前先问清"哪目录真受 git 管理"。
 *
 * 病根（真标本 `a7fbd7e0`，S3）：项目根**不是 git 仓**、`plans/` 不在任何仓内，而拆解器
 *   （`buildDecomposePrompt` 只带了项目须知）对此一无所知 ⇒ 拆出一条验收条件
 *   「提交包含 backend/ 修复代码与方案文件变更」。这条判据在执行环境上**永远无法满足**：
 *   不是执行得不好，是拆的时候就许了一个不存在的愿。结果 4 次 `awaiting_input`、验收 3/4、
 *   质量 45、`goal_achieved=false`。
 *
 * 本模块只做**一件事**：把"工作目录与它周围受控仓库的实情"探成事实（`RepoBoundaryFacts`），
 *   再渲染成一段可直接注入拆解提示词的中文（`formatRepoBoundary`）。
 *   ⚠ 零 electron / 零 better-sqlite3 / 零 logger ⇒ 受控回归可拿临时目录直跑真实现。
 *
 * 有界且如实：
 *   - 自身/上级仓根只问 `git rev-parse --show-toplevel`（**不**用 `existsSync('.git')` 猜——
 *     worktree/submodule 的 `.git` 是文件而非目录，且"我在某个上级仓里"与"我自己是仓"是两件事）；
 *   - 一层子目录最多探测 `REPO_BOUNDARY_MAX_SUBDIRS` 个（排序稳定），探不全就**明说**；
 *   - "不是 git 仓库"是**正常结论**（git 自己给的），不写进 `probeError`；
 *     git 不存在 / 超时 / 其他失败才是探测故障，如实写 `probeError`，且措辞降级为"未能判定"。
 *   - **永不抛**：拆解路不因探测失败而中断（探测只是提示词的补充事实，不是闸）。
 *
 * 与既有仓探测的分工（不并存同一判断）：
 *   - `task-file-ledger.ts:gitRootOf`：**某个文件**属于哪个仓（提交闸/验收证据按文件归属用）；
 *   - `tools/control.ts:gitRootsOfDirs`：**某目录**上溯到哪个仓（脏树闸用）；
 *   - 本模块：拆解提示词要的是"工作目录本身是不是仓根 + 一层子目录里各有哪些仓"，
 *     且必须**零依赖可直跑**（后两者所在模块会拖进引擎/库依赖链）。三处语义不同，互不替代。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 探测结果——全是"实测到什么"，没有推断。 */
export interface RepoBoundaryFacts {
  /** 被探测的工作目录（绝对路径）；空串表示调用方没给工作目录（此时 `formatRepoBoundary` 返回空串）。 */
  workdir: string;
  /** 工作目录**本身**是否就是一个 git 仓的根。 */
  selfIsRepo: boolean;
  /** 工作目录**一层子目录**中含 `.git` 的仓库名（相对路径、按名升序）。 */
  repos: string[];
  /**
   * `git rev-parse --show-toplevel` 给出的仓根（可能是工作目录**之上**的祖先目录）。
   * 有值且 `selfIsRepo=false` ⇒ 工作目录位于某个上级仓库内——文件照样受版本控制，
   * 不能因为"自己不是仓根"就当成不受控。
   */
  toplevel?: string;
  /** 一层子目录超过探测上限 ⇒ 清单可能不全（如实标注，不假装扫全了）。 */
  subdirsTruncated?: boolean;
  /** 探测故障（git 不可用 / 超时 / 目录读不了等）。**不含**"不是 git 仓库"这一正常结论。 */
  probeError?: string;
}

/** 一层子目录的探测上限（有界：拆解是热路径上的旁路事实，不该为它做无界 IO）。 */
export const REPO_BOUNDARY_MAX_SUBDIRS = 20;
/** 单次 git 探测的超时上限；拆解本身要等模型 5–15s，这里只允许占其中很小一格。 */
export const REPO_BOUNDARY_PROBE_TIMEOUT_MS = 2_000;

/** 一层扫描时跳过的目录：要么与"是不是仓"无关，要么进去只会拖慢探测。 */
const SKIP_SUBDIRS = new Set(['node_modules', '__pycache__', 'dist', 'build', 'target']);

/** 同一路径的两种写法（`/tmp/x` vs `/private/tmp/x`）算同一处——macOS 临时目录上这是常态。 */
function samePath(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/**
 * 探测工作目录的版本控制边界。**同步、有界、永不抛**。
 *
 * 为什么同步：调用点是拆解（`autoDecomposeForTask`），前后都已有 await；这里一次 `git rev-parse`
 *   通常 <30ms、上限 2s，属于可接受的一格。改成异步会把"事实采集"与"渲染进提示词"拆成两跳，
 *   却买不到并发（后面本来就要等模型），不值得。
 */
export function collectRepoBoundary(workdir: string): RepoBoundaryFacts {
  const raw = String(workdir ?? '').trim();
  if (!raw) return { workdir: '', selfIsRepo: false, repos: [] };
  const abs = path.resolve(raw);
  const facts: RepoBoundaryFacts = { workdir: abs, selfIsRepo: false, repos: [] };
  const errors: string[] = [];

  // ① 自身 / 上级仓根：由 git 回答。"not a git repository" 是结论（它自己上溯过了），不是故障。
  try {
    const out = execFileSync('git', ['-C', abs, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
      timeout: REPO_BOUNDARY_PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024,
    }).trim();
    if (out) {
      facts.toplevel = path.resolve(out);
      facts.selfIsRepo = samePath(facts.toplevel, abs);
    }
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const stderr = String(err.stderr ?? '').trim();
    if (!/not a git repository/i.test(stderr)) {
      errors.push(`git 探测失败：${(stderr || err.message || '未知错误').slice(0, 200)}`);
    }
  }

  // ② 一层子目录：`.git` 存在（目录或 worktree 的指针文件）即认。排序固定 ⇒ 输出稳定、断言可钉。
  try {
    const names = fs.readdirSync(abs, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP_SUBDIRS.has(d.name))
      .map((d) => d.name)
      .sort();
    for (const name of names.slice(0, REPO_BOUNDARY_MAX_SUBDIRS)) {
      try {
        if (fs.existsSync(path.join(abs, name, '.git'))) facts.repos.push(name);
      } catch { /* 单个子目录读不了 ⇒ 跳过（不因一个坏目录丢整份事实） */ }
    }
    if (names.length > REPO_BOUNDARY_MAX_SUBDIRS) facts.subdirsTruncated = true;
  } catch (e) {
    errors.push(`工作目录不可读：${((e as Error)?.message || String(e)).slice(0, 200)}`);
  }

  if (errors.length > 0) facts.probeError = errors.join('；');
  return facts;
}

/**
 * 渲染成一段可注入拆解提示词的中文事实（`workdir` 为空 ⇒ 空串，调用方据此**逐字不加**）。
 *
 * 为什么把 `plans/`、`reports/` 单列：真标本里正是"方案文件"被许进提交判据；
 *   而这两个目录在多数项目里要么不在仓内、要么被 `.gitignore` 掉——把它们是否受控写在明面上，
 *   模型就不必猜。
 * 为什么受控判定只看"位置"：`.gitignore` 需要逐文件判定、代价与收益都不成比例；
 *   位置在仓内是**必要条件**，已足以否掉"项目根/plans 一起提交"这类不可满足的判据。
 */
export function formatRepoBoundary(f: RepoBoundaryFacts): string {
  if (!f.workdir) return '';
  const lines: string[] = ['版本控制边界（实测）：', `- 工作目录：${f.workdir}`];

  if (f.selfIsRepo) {
    lines.push('- 工作目录本身是 git 仓库（仓根即该目录）');
  } else if (f.toplevel) {
    const rel = path.relative(f.toplevel, f.workdir) || '.';
    lines.push(`- 工作目录本身不是 git 仓库，但位于上级仓库 ${f.toplevel} 内（相对路径 ${rel}）——该目录下的文件仍受版本控制`);
  } else if (f.probeError) {
    // 探测失败时**不冒充结论**："没探到"不等于"不在任何仓内"。
    lines.push('- 工作目录本身是否 git 仓库：未能判定（探测失败）');
  } else {
    lines.push('- 工作目录本身不是 git 仓库，也不在任何上级仓库内');
  }

  if (f.repos.length > 0) {
    lines.push(`- 其一层子目录中的受控仓库：${f.repos.join('、')}`);
  } else if (f.probeError) {
    lines.push('- 其一层子目录中的受控仓库：未能判定（探测失败）');
  } else {
    lines.push('- 其一层子目录中未探测到受控仓库（无 .git）');
  }
  if (f.subdirsTruncated) {
    lines.push(`- 一层子目录超过 ${REPO_BOUNDARY_MAX_SUBDIRS} 个，只探测了前 ${REPO_BOUNDARY_MAX_SUBDIRS} 个——清单可能不全`);
  }

  // 仓根（自己或祖先）覆盖工作目录全部内容；否则只有"该名字本身就是仓"才算受控。
  const covered = (rel: string): boolean => f.selfIsRepo || Boolean(f.toplevel) || f.repos.includes(rel);
  const controlled = (rel: string): string => (covered(rel)
    ? '受控（在该仓库内）'
    // 探测失败时**不替用户下"不受控"的结论**——那会把"没探到"说成"没有"。
    : (f.probeError ? '未能判定（探测失败）' : '不受控（不在任何受控仓库内，无法 git add/commit）'));
  lines.push(`- plans/：${controlled('plans')}；reports/：${controlled('reports')}`);

  lines.push('- 结论：提交/commit 类子任务涉及的文件必须落在上述受控仓库内。');
  if (f.probeError) lines.push(`- 探测异常：${f.probeError}（以上为已探到的部分事实）`);
  return lines.join('\n');
}
