/**
 * zx_20261022_3 批七（维特根斯坦·意义即使用 / 孟子·尽心上「所过者化，所存者神」）:
 *   **知识包导入**——把导出过的整册 JSONL 带进另一个项目（Pro 能力）。
 *
 * 与导出的分工：
 *   · `knowledge-export.ts` 写包（整册、每行 `training:false`、**按日覆盖**）；
 *   · 本模块读包：**先整包校验、再零写入或全量写入**——任一行非法即整包拒绝，
 *     绝不"跳过坏的、留下好的"（那会让用户以为带过来了，实际少了几节）。
 *
 * ⚠ **导入 ≠ 派生**：导入的节**不进** `wa_project_knowledge`（那是 consolidate 从既有事实
 *   `deriveProjectKnowledge` 派生并**剪枝**的表——写进去会在下一次 consolidate 被静默清掉）。
 *   导入落在 `wa_project_knowledge_imports`，由 `listProjectKnowledge` 与派生册**合并读取**；
 *   派生册是本项目**新发生过的事实**，优先于合并模式导入的旧内容。
 *
 * 两种模式（`mode`）：
 *   · `merge`（缺省）——只补目标项目**没有的节**；同名节内容不同记一条 `conflicts`，**不覆盖**。
 *   · `replace`——同名节内容不同即覆盖（偏好由该行的 `precedence=1` 表达；界面须二次确认）。
 *   两种模式下「内容完全相同」都记 `skipped` 且**不写行**（二次导入零变化）。
 *
 * ⚠ 闸落在**导入动作**：`importKnowledgeForProject` 先过 `proFeatureRefusal(db,'knowledge_import')`，
 *   拒时两表皆零写入（连导入账也不写）。**已导入知识的执行期注入不挂闸**——与导出/领域包同一把尺
 *   （闸只挡"搬运"，不挡"使用"）。
 *
 * zx_20261022_3 批八: 包头可带 `profile`（项目画像）。解析走 `parseProjectProfileJson` 同一把尺
 *   （坏画像 ⇒ 新拒码 `BAD_PROFILE`，整包拒绝）；导入落 `wa_project_profiles`，**缺省不启用**
 *   （导入≠启用），且**不覆盖**目标已有画像（同内容记 `skipped`、异内容记 `conflict`）。
 *
 * ⚠ 零 electron / 零 LLM / 零网络；`parseKnowledgePackage` 是纯函数（rr 直跑真实现）。
 */
import { createHash } from 'node:crypto';
import {
  PROJECT_KNOWLEDGE_SECTIONS,
  listProjectKnowledge,
  type ProjectKnowledgeSection,
} from './project-knowledge.js';
import { proFeatureRefusal } from './pro-gate.js';
import { insertImportedProfile, parseProjectProfileJson, type ProjectProfile } from './project-profile.js';
import type { ResolveLicenseOpts } from './license.js';

/** 包头 `kind` 固定值——导出写入、导入校验，同一处真源。 */
export const KNOWLEDGE_PACK_KIND = 'wa-knowledge';
/** 包格式版本（结构变更时递增；导入只认本版）。 */
export const KNOWLEDGE_PACK_VERSION = 1;
/**
 * 整包字符上限。真实册子由各节行数上限约束（远小于此值）；此界只防"把任意大文件当知识包塞进来"。
 * 上限必须**大于导出可能产出**，否则自己的包会导得出来、导不回去。
 */
export const KNOWLEDGE_PACK_MAX_CHARS = 1_000_000;

/** 导入模式词表（界面/回归/校验共引）。 */
export const KNOWLEDGE_IMPORT_MODES = ['merge', 'replace'] as const;
export type KnowledgeImportMode = (typeof KNOWLEDGE_IMPORT_MODES)[number];

export function isKnowledgeImportMode(v: unknown): v is KnowledgeImportMode {
  return typeof v === 'string' && (KNOWLEDGE_IMPORT_MODES as readonly string[]).includes(v);
}

export interface KnowledgePackageSection {
  section: ProjectKnowledgeSection;
  content: string;
}

/** 解析后的包（**已整包校验**；`sourceHash` = 原文 sha256，供导入账回查）。 */
export interface KnowledgePackage {
  kind: typeof KNOWLEDGE_PACK_KIND;
  version: number;
  /** 源项目 id（包是从哪个项目导出的；导入目标另由调用方指定）。 */
  projectId: string;
  generatedAt: string;
  sections: KnowledgePackageSection[];
  /** 包内画像（可选；旧包无此键 ⇒ `null`）。 */
  profile: ProjectProfile | null;
  sourceHash: string;
}

export type KnowledgePackParseCode =
  | 'EMPTY'
  | 'TOO_LARGE'
  | 'BAD_HEADER'
  | 'BAD_VERSION'
  | 'BAD_PROFILE'
  | 'BAD_ROW'
  | 'UNKNOWN_SECTION'
  | 'DUPLICATE_SECTION'
  | 'SECTION_COUNT_MISMATCH';

export type KnowledgePackParseResult =
  | { ok: true; pkg: KnowledgePackage }
  | { ok: false; code: KnowledgePackParseCode; message: string };

function parseFail(code: KnowledgePackParseCode, message: string): KnowledgePackParseResult {
  return { ok: false, code, message };
}

/**
 * 校验并解析一个知识包。**任一非法 ⇒ 整包拒绝**（调用方据此零写入）。
 *
 * 形状：首行包头 `{"kind":"wa-knowledge","version":1,...}`；其后每行一节（导出行的
 * `output` 是内容、`meta.section` 是节名）。空行忽略（文件尾换行不算坏行）。
 */
export function parseKnowledgePackage(text: unknown): KnowledgePackParseResult {
  if (typeof text !== 'string' || text.trim() === '') {
    return parseFail('EMPTY', '知识包为空（没有包头，也没有任何一节）');
  }
  if (text.length > KNOWLEDGE_PACK_MAX_CHARS) {
    return parseFail('TOO_LARGE', `知识包超过 ${KNOWLEDGE_PACK_MAX_CHARS} 字上限（${text.length} 字）——整包拒绝`);
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');

  let header: Record<string, unknown>;
  try {
    const raw = JSON.parse(lines[0]!) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
    header = raw as Record<string, unknown>;
  } catch {
    return parseFail('BAD_HEADER', '首行不是合法的包 JSON——这不是工蚁知识包（请选导出的 .jsonl 文件）');
  }
  if (header.kind !== KNOWLEDGE_PACK_KIND) {
    return parseFail('BAD_HEADER', `首行缺少 \`kind:"${KNOWLEDGE_PACK_KIND}"\`——这不是工蚁知识包（旧版导出无包头，请用当前版本重新导出）`);
  }
  if (Number(header.version) !== KNOWLEDGE_PACK_VERSION) {
    return parseFail('BAD_VERSION', `知识包版本 ${String(header.version ?? '?')} 不受支持（本版只认 ${KNOWLEDGE_PACK_VERSION}）`);
  }
  // 画像（可选）：与读库/共享同一把校验尺；坏画像整包拒绝（不"丢掉画像、留下节"）。
  let profile: ProjectProfile | null = null;
  if (header.profile != null) {
    profile = parseProjectProfileJson(header.profile);
    if (!profile) {
      return parseFail('BAD_PROFILE', '包头中的项目画像不合法（版本不符或结构缺失）——整包拒绝（零写入）');
    }
  }
  // 包头里的 `sections` 是自校验：与数据行数不符 ⇒ 文件被截断/拼接，整包拒绝。
  if (header.sections != null && Number(header.sections) !== lines.length - 1) {
    return parseFail('SECTION_COUNT_MISMATCH',
      `包头声明 ${String(header.sections)} 节，实际 ${lines.length - 1} 行——包不完整，整包拒绝`);
  }

  const sections: KnowledgePackageSection[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    let row: unknown;
    try {
      row = JSON.parse(lines[i]!);
    } catch {
      return parseFail('BAD_ROW', `第 ${i + 1} 行不是合法 JSON——整包拒绝（零写入）`);
    }
    const o = (row ?? {}) as { output?: unknown; meta?: { section?: unknown } };
    const section = o.meta?.section;
    if (typeof section !== 'string' || section.trim() === '') {
      return parseFail('BAD_ROW', `第 ${i + 1} 行缺少 \`meta.section\`——整包拒绝（零写入）`);
    }
    if (!(PROJECT_KNOWLEDGE_SECTIONS as readonly string[]).includes(section)) {
      return parseFail('UNKNOWN_SECTION', `第 ${i + 1} 行的节名「${section}」不在知识册词表内——整包拒绝（零写入）`);
    }
    if (typeof o.output !== 'string' || o.output.trim() === '') {
      return parseFail('BAD_ROW', `第 ${i + 1} 行（节「${section}」）没有内容——整包拒绝（零写入）`);
    }
    if (seen.has(section)) {
      return parseFail('DUPLICATE_SECTION', `节「${section}」在同一包里出现多次——整包拒绝（零写入）`);
    }
    seen.add(section);
    sections.push({ section: section as ProjectKnowledgeSection, content: o.output });
  }
  if (sections.length === 0) {
    return parseFail('EMPTY', '包里没有可导入的知识（只有包头）');
  }

  const sourceHash = createHash('sha256').update(text, 'utf-8').digest('hex');
  return {
    ok: true,
    pkg: {
      kind: KNOWLEDGE_PACK_KIND,
      version: KNOWLEDGE_PACK_VERSION,
      projectId: typeof header.project_id === 'string' ? header.project_id : '',
      generatedAt: typeof header.generated_at === 'string' ? header.generated_at : '',
      sections,
      profile,
      sourceHash,
    },
  };
}

/** 读写窄面（与 `domain-pack.ts` 同形；rr 传 node:sqlite 内存库时要补 `transaction` 垫片）。 */
type ImportDb = {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown;
    run(...args: unknown[]): { changes: number };
  };
  transaction<T>(fn: () => T): () => T;
};

function newLedgerId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `ki-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface KnowledgeImportResult {
  /** 真正写入（或按 replace 覆盖）的节数。 */
  imported: number;
  /** 目标已有**完全相同**内容而跳过的节数（二次导入应全部落在这里）。 */
  skipped: number;
  /** merge 模式下目标已有**不同**内容而未覆盖的节数。 */
  conflicts: number;
  /** 包内节数（恒 = imported + skipped + conflicts）。 */
  sections: number;
  mode: KnowledgeImportMode;
  sourceHash: string;
  /** 本次导入账的行 id（可回查 "这一批是哪一次导的"）。 */
  ledgerId: string;
  /**
   * 画像的落点结果：`imported` 新写入（**不启用**）/ `skipped` 目标同版已存在 /
   * `conflict` 目标已有不同版本而**未覆盖** / `none` 包里无画像。
   */
  profile: 'imported' | 'skipped' | 'conflict' | 'none';
}

export type KnowledgeImportOutcome =
  | { ok: true; result: KnowledgeImportResult }
  | { ok: false; code: 'FEATURE_REQUIRED' | 'NO_SUCH_PROJECT' | 'SECTIONS_NOT_READY'; message: string };

export interface KnowledgeImportOpts {
  mode?: KnowledgeImportMode;
  /** 许可判据注入（rr 用固定 now/fingerprint，不碰墙钟与本机指纹）。 */
  license?: ResolveLicenseOpts;
}

/**
 * **导入的唯一入口**（IPC 只调它）：先过 Pro 闸，再整包比对、再在一个事务里写。
 *
 * 幂等判据：同一份包、同一模式连导两次 ⇒ 第二次 `imported=0`、`skipped=sections`，
 * 目标册内容**一字节不变**（导入账会多一行——那是"谁在何时导了一次"的审计，不是知识变化）。
 */
export function importKnowledgeForProject(
  db: ImportDb,
  projectId: string,
  pkg: KnowledgePackage,
  opts: KnowledgeImportOpts = {},
): KnowledgeImportOutcome {
  const refusal = proFeatureRefusal(db, 'knowledge_import', opts.license ?? {});
  if (refusal) return { ok: false, code: 'FEATURE_REQUIRED', message: refusal };

  const pid = String(projectId ?? '');
  if (!pid) return { ok: false, code: 'NO_SUCH_PROJECT', message: '缺少项目 id——没有可导入的目标' };
  const exists = db.prepare('SELECT 1 AS ok FROM wa_projects WHERE id = ?').get(pid) as { ok?: number } | undefined;
  if (!exists) return { ok: false, code: 'NO_SUCH_PROJECT', message: `项目不存在（${pid}）——未写入任何节` };

  const mode: KnowledgeImportMode = opts.mode ?? 'merge';
  // 与读侧**同一本册**（派生 + 已导入合并后的视图）："目标有没有这一节"只认这个答案。
  const book = new Map(listProjectKnowledge(db, pid).map((e) => [e.section, e.content]));

  const upsert = db.prepare(
    `INSERT INTO wa_project_knowledge_imports (project_id, section, content, precedence, source_hash, imported_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(project_id, section) DO UPDATE SET
       content = excluded.content,
       precedence = excluded.precedence,
       source_hash = excluded.source_hash,
       imported_at = datetime('now')`,
  );
  const ledgerId = newLedgerId();
  const insertLedger = db.prepare(
    `INSERT INTO wa_knowledge_imports
       (id, project_id, source_project_id, source_hash, mode, sections, imported, skipped, conflicts, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  );

  let imported = 0;
  let skipped = 0;
  let conflicts = 0;
  let profileOutcome: KnowledgeImportResult['profile'] = 'none';
  const tx = db.transaction(() => {
    for (const s of pkg.sections) {
      const existing = book.get(s.section);
      if (existing === undefined) {
        upsert.run(pid, s.section, s.content, mode === 'replace' ? 1 : 0, pkg.sourceHash);
        imported++;
      } else if (existing === s.content) {
        skipped++;
      } else if (mode === 'replace') {
        upsert.run(pid, s.section, s.content, 1, pkg.sourceHash);
        imported++;
      } else {
        conflicts++;
      }
    }
    // 画像：**不覆盖**目标已有画像（与节不同，画像没有 replace 模式——覆盖一份画像的代价
    //   比覆盖一节知识更高，且用户可显式重新生成）。导入后不启用，等用户在本机开关。
    if (pkg.profile) profileOutcome = insertImportedProfile(db, pid, pkg.profile);
    insertLedger.run(
      ledgerId, pid, pkg.projectId || '', pkg.sourceHash, mode,
      pkg.sections.length, imported, skipped, conflicts,
    );
  });
  tx();

  return {
    ok: true,
    result: {
      imported, skipped, conflicts,
      sections: pkg.sections.length,
      mode,
      sourceHash: pkg.sourceHash,
      ledgerId,
      profile: profileOutcome,
    },
  };
}

export interface KnowledgeImportRecord {
  id: string;
  source_project_id: string;
  source_hash: string;
  mode: string;
  sections: number;
  imported: number;
  skipped: number;
  conflicts: number;
  imported_at: string;
}

/**
 * 导入账（只读，最近在前）——有写口就必须有读口，否则"记了没人看"。
 * 坏 `mode` 原样透传（不猜成 merge）：账要如实，不替历史改口。
 */
export function listKnowledgeImports(
  db: { prepare(sql: string): { all(...args: unknown[]): unknown } },
  projectId: string,
  limit = 5,
): KnowledgeImportRecord[] {
  const rows = db.prepare(
    `SELECT id, source_project_id, source_hash, mode, sections, imported, skipped, conflicts, imported_at
       FROM wa_knowledge_imports WHERE project_id = ?
      ORDER BY imported_at DESC, rowid DESC LIMIT ?`,
  ).all(projectId || '', Math.max(1, Math.min(50, limit))) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id ?? ''),
    source_project_id: String(r.source_project_id ?? ''),
    source_hash: String(r.source_hash ?? ''),
    mode: String(r.mode ?? ''),
    sections: Number(r.sections) || 0,
    imported: Number(r.imported) || 0,
    skipped: Number(r.skipped) || 0,
    conflicts: Number(r.conflicts) || 0,
    imported_at: String(r.imported_at ?? ''),
  }));
}
