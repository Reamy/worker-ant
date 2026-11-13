/**
 * zx_20261109_1 B4（G11）——判据引用的路径**可核性**（确定性，不靠 LLM）。
 *
 * 病根（真库标本 `b8310097` 的子任务）：判据写 `pages/worker/institution/institution.wxml`、
 *   `institution.js`，而工作目录里只有 `mini-mp/src/pages/worker/institution/institution.vue`——
 *   判卷模型按"框架通常如此"补上了不存在的文件名，任务照样被记通过。题在，但题指着**不存在的东西**。
 *
 * 边界（**宁可漏拦，不可把合法判据判成不可核**——本模块的判定会直接导致任务置 paused 待人工）：
 *   · 只认**带目录分隔 + 带已知扩展名**的相对引用。单段文件名（`institution.wxml`、`package.json`）
 *     不核：没有相对基准就无法断言"不存在"，fail-open。
 *   · 绝对路径（`/logs/x.log`）、家目录（`~/…`）、npm 包名（`@scope/pkg`）、
 *     翻出工作目录的 `../` 引用一律不核。
 *   · 解析基底 = 工作目录 + 其一级子目录 + 子工程的 `src`（单仓/多包仓的常见源码根）。
 *     真库 108 条判据只读回放：API 路由（`orders/create`）、代码表达式（`worst.get`）、
 *     并列词（`GET/PUT`）因无已知扩展名被排除；11 条被标缺的引用逐一核实确为臆造/过期。
 *   · 基底枚举被上限截断时**不判缺**（枚举不全 ⇒ 不能断言"哪里都没有"）。
 *
 * 纯逻辑 + 只读 fs：不碰库、不碰 electron，供 rr 以临时目录直跑真实现。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 视为"文件名"的扩展名（小写）。没有扩展名的目录引用一律不核（见文件头边界）。 */
const COMMON_PATH_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'json5', 'md', 'mdx', 'txt',
  'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'lock',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'vue', 'svelte',
  'wxml', 'wxss', 'wxs', 'py', 'go', 'rs', 'java', 'kt', 'kts',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sh', 'bash', 'zsh', 'ps1',
  'sql', 'db', 'sqlite', 'xml', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp',
  'pdf', 'csv', 'log', 'proto', 'graphql', 'gql',
]);

/** 不进入基底枚举的重目录（只影响"找相对基准"，不影响工作目录本身作为基底）。 */
const HEAVY_DIR_NAMES = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '.next', '.nuxt', '.cache',
  'coverage', '__pycache__', 'venv', '.venv', '.gradle', '.pnpm-store',
]);

/** 一级子目录枚举上限（超出即视为枚举不完整）。 */
export const PATH_BASES_MAX_TOP = 64;
/** 一级子目录下的二级枚举上限（仅取 `src`）。 */
export const PATH_BASES_MAX_SUB = 32;

const TOKEN_RE = /[A-Za-z0-9_./~@-]+/g;
const URLISH_RE = /\b(?:https?|ftp):\/\/\S+/gi;

/**
 * 判据文本 → **可能指向工作目录内文件**的相对引用（去重、保首次出现顺序）。
 *
 * 样本（rr 逐条钉住）：`src/pages/a.vue` ⇒ 命中；`src/a.ts:12` ⇒ 归一为 `src/a.ts`（行号剥掉）；
 *   `https://x/a/b.ts`、`dayjs`、`npm run build`、`GET/PUT`、`console.log`、`orders/create`、
 *   `@scope/pkg`、`institution.wxml`（单段）⇒ 一律不命中。
 */
export function criteriaPathRefs(criteria: string): string[] {
  if (!criteria) return [];
  const text = String(criteria).replace(URLISH_RE, ' ');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.match(TOKEN_RE) ?? []) {
    const token = normalizePathToken(raw);
    if (!token || seen.has(token)) continue;
    if (!looksLikeRelativePath(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function normalizePathToken(raw: string): string {
  let t = raw.replace(/[.,;:!?]+$/, '').replace(/\/+$/, '');
  if (t.startsWith('./')) t = t.slice(2);
  return t;
}

function looksLikeRelativePath(token: string): boolean {
  if (!token.includes('/')) return false;
  if (token.startsWith('/') || token.startsWith('~') || token.startsWith('@')) return false;
  if (token.includes('//')) return false;
  const segments = token.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;
  const base = segments[segments.length - 1]!;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return false;
  return COMMON_PATH_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/**
 * 相对引用的候选解析基底：工作目录 + 一级子目录 + 子工程的 `src`。
 * `truncated=true` 表示枚举被上限截断——调用方据此**不判缺**（fail-open）。
 */
export function collectPathBases(workingDir: string): { bases: string[]; truncated: boolean } {
  const bases: string[] = [];
  const wd = String(workingDir ?? '').trim();
  if (!wd) return { bases, truncated: true };
  bases.push(wd);
  const top = listChildDirs(wd);
  if (!top) return { bases, truncated: true };
  let truncated = false;
  let tops = top;
  if (tops.length > PATH_BASES_MAX_TOP) {
    tops = tops.slice(0, PATH_BASES_MAX_TOP);
    truncated = true;
  }
  for (const name of tops) {
    const dir = path.join(wd, name);
    bases.push(dir);
    const subs = listChildDirs(dir);
    if (!subs) continue;
    let picked = subs;
    if (picked.length > PATH_BASES_MAX_SUB) {
      picked = picked.slice(0, PATH_BASES_MAX_SUB);
      truncated = true;
    }
    // 只补 `src`：再往下扩会让 API 路由段（`orders/create`）等词误命中真实目录。
    for (const sub of picked) if (sub === 'src') bases.push(path.join(dir, sub));
  }
  return { bases, truncated };
}

function listChildDirs(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !HEAVY_DIR_NAMES.has(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return null;
  }
}

/**
 * 在全部基底上解析引用；**任一基底存在即算存在**。基底枚举不完整 ⇒ 一律返回空（不判缺）。
 * `exists` 由调用方注入（生产为 `fs.existsSync`），便于 rr 用纯函数直测。
 */
export function missingPathRefs(
  refs: readonly string[],
  bases: readonly string[],
  exists: (abs: string) => boolean,
  opts?: { basesTruncated?: boolean },
): string[] {
  if (opts?.basesTruncated) return [];
  if (bases.length === 0) return [];
  const missing: string[] = [];
  for (const ref of refs) {
    let found = false;
    for (const base of bases) {
      if (exists(path.join(base, ref))) { found = true; break; }
    }
    if (!found) missing.push(ref);
  }
  return missing;
}

// ─────────────── zx_20261110_2 B6：判据路径的**来源阶梯** ───────────────

/** 一条已登记产出物的路径（`taskId` 用于 `resolved_from` 的回指）。 */
export interface RegisteredDeliverablePath {
  taskId: string;
  /** `wa_deliverables.file_path` 原文（可能是绝对路径，也可能是相对工作目录的路径） */
  path: string;
}

/** 单条判据引用的解析结果。`resolved_from` 的取值域由本模块**唯一**定义（调用方不得手抄）。 */
export interface CriteriaPathResolution {
  ref: string;
  resolved: boolean;
  /** 实际落到盘上的文件（绝对路径） */
  resolved_as?: string;
  /** `'own' | 'working_dir' | 'project_deliverable:<taskId>'` */
  resolved_from?: string;
  /** 多命中时的候选（>1 条；此时**不解析**，不猜） */
  ambiguous?: string[];
}

export interface ResolveCriteriaPathsInput {
  refs: readonly string[];
  /** 本任务**已登记**的产出物路径（调用方已按非 retired / 非探针滤过） */
  ownDeliverables: readonly RegisteredDeliverablePath[];
  /** 同项目**其他任务**已登记产出物路径（同上滤过） */
  projectDeliverables: readonly RegisteredDeliverablePath[];
  /** 工作目录解析基底（`collectPathBases` 的产物，第一个是工作目录本身） */
  bases: readonly string[];
  basesTruncated?: boolean;
  /** 世界快照的文件清单（`fileHashes` 还原出的相对路径，可缺省） */
  snapshotPaths?: readonly string[];
  /** 存在性探针（生产为 `fs.existsSync`；本模块零 FS 依赖） */
  exists: (abs: string) => boolean;
}

export interface ResolveCriteriaPathsResult {
  results: CriteriaPathResolution[];
  /** 全部**未解析**的引用（含多命中的那些——它们同样"没解析成功"） */
  missing: string[];
  /** 多命中、不解析的引用（`missing` 的子集） */
  ambiguous: string[];
  /** 经**其他任务**登记解析成功的条目（供子任务回写自身产出物） */
  crossTask: Array<{ ref: string; resolved_as: string; resolved_from: string; taskId: string }>;
}

const CROSS_TASK_PREFIX = 'project_deliverable:';

/**
 * 判据引用 → 来源阶梯解析（zx_20261110_2 B6「核得清」）。
 *
 * 病根（事故 `68c0a607`）：判据引用的文件**确实存在**，只是登记在**父任务**名下
 * （工程级查重把行留在了别的任务上）⇒ 旧实现只认"本任务产出物 + 工作目录"，
 * 判据被记成 `criteria_path_missing`，整个任务按"判据缺陷"暂停待人工。
 *
 * 阶梯（**先近后远**，一旦命中即停）：
 *   ① 本任务已登记产出物（精确 → 唯一后缀）；
 *   ② 工作目录解析基底（复用 `missingPathRefs` 的"任一基底存在即算存在"口径，取第一个命中的基底）；
 *   ③ 同项目其他任务已登记产出物（精确 → 唯一后缀），记 `project_deliverable:<taskId>`；
 *   ④ 世界快照文件清单唯一后缀命中，记 `working_dir`。
 * 都不中 ⇒ 未解析（调用方仍记 `criteria_path_missing`，并带上试过的来源语义）。
 *
 * 多命中（同一阶梯内 ≥2 个**不同**文件）⇒ 不解析、记 `ambiguous`——**不猜**：
 * 猜错一个文件名，就等于让判卷模型读一份不相干的文件。
 *
 * ⚠ 只解析**存在**的文件：登记了但盘上已没有的路径不算解析成功（否则"题指着一个不存在的东西"
 *   会被一条陈旧登记洗成"可核"，正是 G11 要治的那类失实）。登记行可比盘面多，反向不成立。
 */
export function resolveCriteriaPaths(input: ResolveCriteriaPathsInput): ResolveCriteriaPathsResult {
  const norm = (p: string): string => String(p ?? '').replace(/\\/g, '/');
  const wd = String(input.bases[0] ?? '').trim();
  const absOf = (p: string): string => (path.isAbsolute(p) ? p : (wd ? path.join(wd, p) : p));
  const uniqByAbs = (rows: Array<{ abs: string; taskId: string }>): Array<{ abs: string; taskId: string }> => {
    const seen = new Map<string, { abs: string; taskId: string }>();
    for (const r of rows) if (!seen.has(r.abs)) seen.set(r.abs, r);
    return [...seen.values()];
  };

  /** 精确优先、否则唯一后缀；命中集按**实际文件**去重、按**盘面存在**剔除。 */
  const matchRegistered = (ref: string, rows: readonly RegisteredDeliverablePath[]): Array<{ abs: string; taskId: string }> => {
    const r = norm(ref);
    const exact: Array<{ abs: string; taskId: string }> = [];
    const suffix: Array<{ abs: string; taskId: string }> = [];
    for (const row of rows) {
      const p = norm(row.path);
      if (!p) continue;
      const abs = absOf(row.path);
      let existsNow = false;
      try { existsNow = !!input.exists(abs); } catch { existsNow = false; }
      if (!existsNow) continue; // 登记了但盘上没有 ⇒ 不算解析成功
      if (p === r) exact.push({ abs, taskId: row.taskId });
      else if (p.endsWith(`/${r}`)) suffix.push({ abs, taskId: row.taskId });
    }
    const ex = uniqByAbs(exact);
    if (ex.length > 0) return ex;
    return uniqByAbs(suffix);
  };

  const results: CriteriaPathResolution[] = [];
  const crossTask: ResolveCriteriaPathsResult['crossTask'] = [];

  for (const ref of input.refs) {
    // ① 本任务已登记产出物
    const own = matchRegistered(ref, input.ownDeliverables);
    if (own.length === 1) {
      results.push({ ref, resolved: true, resolved_as: own[0]!.abs, resolved_from: 'own' });
      continue;
    }
    if (own.length > 1) {
      results.push({ ref, resolved: false, ambiguous: own.map((x) => x.abs) });
      continue;
    }
    // ② 工作目录基底（复用 `missingPathRefs` 的口径：任一基底存在即算存在）
    if (!input.basesTruncated && input.bases.length > 0) {
      const present = missingPathRefs([ref], input.bases, input.exists).length === 0;
      if (present) {
        const hits = uniqByAbs(input.bases
          .map((b) => path.join(b, ref))
          .filter((abs) => { try { return !!input.exists(abs); } catch { return false; } })
          .map((abs) => ({ abs, taskId: '' })));
        if (hits.length >= 1) {
          // 多个基底同时存在同一个相对路径（多仓/多包工作区）不是"歧义"，取第一个基底（工作目录本身优先）。
          results.push({ ref, resolved: true, resolved_as: hits[0]!.abs, resolved_from: 'working_dir' });
          continue;
        }
      }
    }
    // ③ 同项目其他任务已登记产出物
    const cross = matchRegistered(ref, input.projectDeliverables);
    if (cross.length === 1) {
      const from = `${CROSS_TASK_PREFIX}${cross[0]!.taskId}`;
      results.push({ ref, resolved: true, resolved_as: cross[0]!.abs, resolved_from: from });
      crossTask.push({ ref, resolved_as: cross[0]!.abs, resolved_from: from, taskId: cross[0]!.taskId });
      continue;
    }
    if (cross.length > 1) {
      results.push({ ref, resolved: false, ambiguous: cross.map((x) => x.abs) });
      continue;
    }
    // ④ 世界快照文件清单唯一后缀命中
    const r = norm(ref);
    const snapHits = uniqByAbs((input.snapshotPaths ?? [])
      .map((p) => norm(p))
      .filter((p) => p === r || p.endsWith(`/${r}`))
      .map((p) => ({ abs: absOf(p), taskId: '' })));
    if (snapHits.length === 1) {
      results.push({ ref, resolved: true, resolved_as: snapHits[0]!.abs, resolved_from: 'working_dir' });
      continue;
    }
    if (snapHits.length > 1) {
      results.push({ ref, resolved: false, ambiguous: snapHits.map((x) => x.abs) });
      continue;
    }
    // ⑤ 都失败
    results.push({ ref, resolved: false });
  }

  const missing = results.filter((x) => !x.resolved).map((x) => x.ref);
  const ambiguous = results.filter((x) => !x.resolved && (x.ambiguous?.length ?? 0) > 1).map((x) => x.ref);
  return { results, missing, ambiguous, crossTask };
}
