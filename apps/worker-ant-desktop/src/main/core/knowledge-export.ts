/**
 * zx_20261017_1 批七（维特根斯坦·意义即使用 / 管子·度量衡）: **项目知识包的 JSONL 导出**。
 *
 * ⚠ **仅导出，不训练**：每行带 `"training":false`，文件本身不是训练语料（K-4 形态守则）。
 *   导出的是**整册**（`listProjectKnowledge` 读到的各节），不是 400-token 注入子集——
 *   注入预算是"这一次送多少给模型"，导出是"项目此刻知道什么"，两件事不混。
 *
 * 文件约定（R-40）：
 *   · 落 `<dataDir>/knowledge_exports/<projectId>-<UTC YYYYMMDD>.jsonl`；
 *   · **按日覆盖**（同日重复导出只留最新一份，`writeFileSync` 截断）；
 *   · 每行 `meta.generated_at` 记这一份是何时生成的（不是"何时教给模型"）。
 *
 * 零 LLM / 零网络：只把册内容改写成 JSONL；`now` 可注入 ⇒ rr 不碰真实墙钟。
 *
 * zx_20261018_1 批八（管子·度量衡）: **导出挂 Pro+ 闸**——「项目知识包」是专业版卖点，
 *   卖点若无人兑现就是虚名。闸落在本模块的编排口 `exportKnowledgeForProject`（**先判后写**：
 *   拒时**零文件**），而不是散进 IPC 壳；`writeKnowledgeExport` 仍是纯写口（rr 既有断言直调它验形状）。
 *   ⚠ **预览与执行期注入不挂闸**（社区档照常用）——闸只落导出，不误伤核心任务。
 *
 * zx_20261022_3 批七（维特根斯坦·意义即使用）: 文件首行加**自描述包头**，让导出的包能被
 *   `knowledge-import.ts` 认出来（往返闭合）。包头声明 `kind/version/sections`——其中 `sections`
 *   同时是**自校验**：行数对不上即"包被截断/拼接"，导入侧整包拒绝。
 *   ⚠ `rows` 仍只数**节行**（不含包头）；新增一行包头不得让"导出了几节"变味。
 *
 * zx_20261022_3 批八: 包头可带 `profile`（项目画像）。有画像才带——没画像时包头形状与批七**逐字相同**
 *   （旧包/旧断言不漂移）；带画像时导入侧按同一份 `parseProjectProfileJson` 校验，坏画像整包拒绝。
 *   ⚠ 画像**不占节行**（`rows`/`sections` 仍只数知识节），它是另一件东西：书是"知道什么"，画像是"先读哪一屏"。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  listProjectKnowledge,
  PROJECT_KNOWLEDGE_SECTION_LABEL,
  type ProjectKnowledgeEntry,
} from './project-knowledge.js';
import { proFeatureRefusal } from './pro-gate.js';
import { KNOWLEDGE_PACK_KIND, KNOWLEDGE_PACK_VERSION } from './knowledge-import.js';
import { readProjectProfile, type ProjectProfile } from './project-profile.js';
import type { ResolveLicenseOpts } from './license.js';

/** 导出目录名（IPC/界面/回归共引，不在三处各写一个字符串）。 */
export const KNOWLEDGE_EXPORT_DIR = 'knowledge_exports';

/** `meta.source` 的固定值（下游据此认"这是知识包导出，不是训练集"）。 */
export const KNOWLEDGE_PACK_SOURCE = 'knowledge_pack';

export interface KnowledgePackRow {
  instruction: string;
  input: string;
  output: string;
  meta: {
    source: typeof KNOWLEDGE_PACK_SOURCE;
    project_id: string;
    section: string;
    generated_at: string;
  };
  /** 恒 false——本文件**不用于训练**（形状本身即声明）。 */
  training: false;
}

/**
 * 一册 → 每节一行。**不截内容**（导出是完整知识，注入侧才按预算取舍）。
 * 空册 ⇒ 空数组（文件为空是如实值，不伪造占位行）。
 */
export function knowledgePackRows(
  projectId: string,
  entries: ReadonlyArray<ProjectKnowledgeEntry>,
  generatedAt: string,
): KnowledgePackRow[] {
  return entries.map((e) => ({
    instruction: `整理项目「${projectId}」的「${PROJECT_KNOWLEDGE_SECTION_LABEL[e.section]}」知识。`,
    input: `项目 ${projectId}`,
    output: e.content,
    meta: {
      source: KNOWLEDGE_PACK_SOURCE,
      project_id: projectId,
      section: e.section,
      generated_at: generatedAt,
    },
    training: false,
  }));
}

export interface KnowledgePackHeader {
  kind: typeof KNOWLEDGE_PACK_KIND;
  version: typeof KNOWLEDGE_PACK_VERSION;
  project_id: string;
  generated_at: string;
  /** 其后还有几行节数据——导入侧据此判"包是否完整"。 */
  sections: number;
  /** 项目画像（可选；无画像时**不出现此键**，包头形状与批七逐字相同）。 */
  profile?: ProjectProfile;
  training: false;
}

/** 包首行（**自描述**）：导入侧只认它，缺它即"不是知识包"（旧版导出无包头，须重新导出）。 */
export function knowledgePackHeader(
  projectId: string,
  generatedAt: string,
  sections: number,
  profile?: ProjectProfile | null,
): KnowledgePackHeader {
  return {
    kind: KNOWLEDGE_PACK_KIND,
    version: KNOWLEDGE_PACK_VERSION,
    project_id: projectId,
    generated_at: generatedAt,
    sections,
    ...(profile ? { profile } : {}),
    training: false,
  };
}

/** 文件名里的日期取 **UTC**（与库内 `datetime('now')` 同基准），格式 `YYYYMMDD`。 */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

/** `<projectId>-<YYYYMMDD>.jsonl`；项目 id 里的路径分隔符等洗成 `_`（不许越出导出目录）。 */
export function knowledgeExportFileName(projectId: string, now: Date): string {
  const safe = String(projectId || '').replace(/[^A-Za-z0-9._-]/g, '_') || 'project';
  return `${safe}-${utcDay(now)}.jsonl`;
}

export interface KnowledgeExportResult {
  filePath: string;
  /** 写出的行数 = 册里的节数。 */
  rows: number;
  sections: string[];
  generated_at: string;
}

/**
 * 写导出文件（**按日覆盖**）。返回真实路径与行数，供界面如实显示。
 * 目录不存在则建；写失败直接抛（IPC 层如实回错，不假装导出成功）。
 *
 * 文件 = **包头一行 + 每节一行**；空册 ⇒ 只有包头（`sections:0`）——仍是一份**可被导入侧
 * 识别并如实拒绝**（"包里没有可导入的知识"）的合法文件，而不是一个无法归类的空文件。
 */
export function writeKnowledgeExport(
  projectId: string,
  entries: ReadonlyArray<ProjectKnowledgeEntry>,
  dataDir: string,
  now: Date = new Date(),
  profile?: ProjectProfile | null,
): KnowledgeExportResult {
  const generatedAt = now.toISOString();
  const rows = knowledgePackRows(projectId, entries, generatedAt);
  const header = knowledgePackHeader(projectId, generatedAt, rows.length, profile);
  const dir = path.join(dataDir, KNOWLEDGE_EXPORT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, knowledgeExportFileName(projectId, now));
  const text = [JSON.stringify(header), ...rows.map((r) => JSON.stringify(r))].join('\n') + '\n';
  fs.writeFileSync(filePath, text, 'utf-8');
  return { filePath, rows: rows.length, sections: entries.map((e) => e.section), generated_at: generatedAt };
}

/** 导出编排要的最小库面：既能读许可设置（`get`），又能读册（`all`）。 */
export interface KnowledgeExportDb {
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown };
}

/** 编排结果：`ok:false` 时**一个字节都没写**（先判后写，拒因照实回）。 */
export type ProjectKnowledgeExportOutcome =
  | { ok: true; result: KnowledgeExportResult }
  | { ok: false; code: 'FEATURE_REQUIRED'; message: string };

/**
 * **导出的唯一入口**（IPC 只调它）：先过 Pro 闸，再读整册、再落盘。
 *   · 社区档 / 试用过期 ⇒ `FEATURE_REQUIRED`，**不建目录、不写文件**（0→0）；
 *   · Pro / Team / 试用期 ⇒ 正常导出（0→1）。
 * `opts.now` 同时用于**判档与生成时刻**——同一瞬间的同一把尺（不取两个"现在"）。
 */
export function exportKnowledgeForProject(
  db: KnowledgeExportDb,
  projectId: string,
  dataDir: string,
  opts: ResolveLicenseOpts = {},
): ProjectKnowledgeExportOutcome {
  const refusal = proFeatureRefusal(db, 'knowledge_export', opts);
  if (refusal) return { ok: false, code: 'FEATURE_REQUIRED', message: refusal };
  const entries = listProjectKnowledge(db, projectId);
  // 有画像就随包带走（含导入所得）；坏 JSON ⇒ `null`（导出照常，不带坏画像——不伪造）。
  const stored = readProjectProfile(db as never, projectId);
  return {
    ok: true,
    result: writeKnowledgeExport(projectId, entries, dataDir, opts.now ?? new Date(), stored?.profile ?? null),
  };
}
