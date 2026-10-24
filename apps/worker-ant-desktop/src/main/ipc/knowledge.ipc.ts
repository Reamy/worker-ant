/**
 * zx_20261017_1 批七: **项目知识包**的 IPC 出口。
 *
 * 两个通道，都是只读/导出（不改引擎状态）：
 *   · `knowledge:preview` —— 项目维度预览；返回**会被注入**的节与**超预算未注入**的节
 *     （同一个 `selectKnowledgeForInject` + 同一个 400-token 常量，见 R-41）。
 *   · `knowledge:export`  —— 读整册写 `data/knowledge_exports/<projectId>-<YYYYMMDD>.jsonl`
 *     （按日覆盖；每行 `training:false`）。**挂 Pro+ 闸**（zx_20261018_1 批八）：社区档回
 *     `FEATURE_REQUIRED` 且**不写文件**；判据与编排都在 `core`（本文件不另写档位判断）。
 *
 * zx_20261022_3 批七新增两个通道（写操作仅 `import`）：
 *   · `knowledge:import`  —— 按文件路径读包、整包校验、整包写入（任一非法 ⇒ 零写入）。**挂 Pro+ 闸**，
 *     拒时连导入账都不写；解析/写入全在 `core/knowledge-import.ts`。
 *   · `knowledge:imports` —— 本项目的导入账（只读，最近在前）。
 *
 * zx_20261022_3 批八新增三个画像通道（**本机生成/启用不挂任何档位闸**——社区档照常自用）：
 *   · `knowledge:profile`         —— 读画像视图（内容/启用/出处/是否过期/注入成效）。
 *   · `knowledge:profileGenerate` —— 手动生成/刷新（确定性派生；过期**不自动覆盖**，由用户点）。
 *   · `knowledge:profileEnabled`  —— 启停注入（只改 `enabled`，不动画像内容）。
 *
 * ⚠ 预览/注入共用 `previewProjectKnowledge` 内的取数与择节；本文件不另算预算、不另拼词表。
 */
import fs from 'node:fs';
import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { knowledgeInjectionStats, previewProjectKnowledge } from '../core/project-knowledge.js';
import { exportKnowledgeForProject } from '../core/knowledge-export.js';
import {
  importKnowledgeForProject,
  isKnowledgeImportMode,
  listKnowledgeImports,
  parseKnowledgePackage,
  KNOWLEDGE_PACK_MAX_CHARS,
} from '../core/knowledge-import.js';
// zx_20261022_3 批八: 项目画像（生成/读/启停/成效）全在 `core/project-profile.ts`——本文件只做壳。
import {
  buildProjectProfile,
  currentProfileSourceHash,
  profileInjectionStats,
  readProjectProfile,
  saveProjectProfile,
  setProjectProfileEnabled,
  PROJECT_PROFILE_VERSION,
  PROFILE_INJECT_MAX_TOKENS,
} from '../core/project-profile.js';
import type {
  ProjectProfile,
  ProjectProfileInjectionStats,
  ProjectProfileOrigin,
} from '../core/project-profile.js';

type IpcFailure = { error: { code: string; message: string } };

/** 画像视图（界面一个渲染分支：有/无画像、启用/停用、本机/导入、是否过期）。 */
export interface KnowledgeProfileView {
  version: number;
  budgetTokens: number;
  profile: ProjectProfile | null;
  enabled: boolean;
  origin: ProjectProfileOrigin | null;
  sourceProjectName: string;
  generatedAt: string;
  sourceHash: string;
  currentHash: string;
  stale: boolean;
  stats: ProjectProfileInjectionStats;
}

function projectIdOf(input: { projectId?: unknown } | undefined): string {
  return typeof input?.projectId === 'string' ? input.projectId : '';
}

export function initKnowledgeIpc(db: Database.Database, dataDir: string): void {
  ipcMain.handle('knowledge:preview', async (_event, input?: { projectId?: unknown; archetype?: unknown }) => {
    try {
      const projectId = projectIdOf(input);
      if (!projectId) return { error: { code: 'INVALID_REQUEST', message: '缺少项目 id' } } satisfies IpcFailure;
      const archetype = typeof input?.archetype === 'string' && input.archetype ? input.archetype : null;
      return { data: previewProjectKnowledge(db as never, projectId, archetype) };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  // zx_20261018_1 批七 R-66: 注入成效上屏（“注入 N 次 / 成功 M / 失败 K”）——读注入账，不改状态。
  ipcMain.handle('knowledge:stats', async (_event, input?: { projectId?: unknown }) => {
    try {
      const projectId = projectIdOf(input);
      if (!projectId) return { error: { code: 'INVALID_REQUEST', message: '缺少项目 id' } } satisfies IpcFailure;
      return { data: knowledgeInjectionStats(db as never, projectId) };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  ipcMain.handle('knowledge:export', async (_event, input?: { projectId?: unknown }) => {
    try {
      const projectId = projectIdOf(input);
      if (!projectId) return { error: { code: 'INVALID_REQUEST', message: '缺少项目 id' } } satisfies IpcFailure;
      const outcome = exportKnowledgeForProject(db as never, projectId, dataDir);
      if (!outcome.ok) return { error: { code: outcome.code, message: outcome.message } } satisfies IpcFailure;
      return { data: outcome.result };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  // zx_20261022_3 批七：导入。**先整包校验、再零写入或全量写入**——畸形包绝不"跳过坏的留下好的"。
  //   读文件的体积闸用字节数粗判（UTF-8 每字符 ≤4 字节），精确字符上限仍由 `parseKnowledgePackage` 判。
  ipcMain.handle('knowledge:import', async (
    _event,
    input?: { projectId?: unknown; filePath?: unknown; mode?: unknown },
  ) => {
    try {
      const projectId = projectIdOf(input);
      if (!projectId) return { error: { code: 'INVALID_REQUEST', message: '缺少项目 id' } } satisfies IpcFailure;
      const filePath = typeof input?.filePath === 'string' ? input.filePath : '';
      if (!filePath) return { error: { code: 'NO_FILE', message: '没有选择知识包文件' } } satisfies IpcFailure;
      if (input?.mode != null && !isKnowledgeImportMode(input.mode)) {
        return { error: { code: 'BAD_MODE', message: `未知导入模式（${String(input.mode)}）` } } satisfies IpcFailure;
      }

      let text: string;
      try {
        const st = fs.statSync(filePath);
        if (st.size > KNOWLEDGE_PACK_MAX_CHARS * 4) {
          return {
            error: {
              code: 'TOO_LARGE',
              message: `知识包超过 ${KNOWLEDGE_PACK_MAX_CHARS} 字上限（文件 ${st.size} 字节）——整包拒绝`,
            },
          } satisfies IpcFailure;
        }
        text = fs.readFileSync(filePath, 'utf-8');
      } catch (e) {
        return { error: { code: 'READ_FAILED', message: `读不到知识包文件：${(e as Error)?.message || String(e)}` } } satisfies IpcFailure;
      }

      const parsed = parseKnowledgePackage(text);
      if (!parsed.ok) return { error: { code: parsed.code, message: parsed.message } } satisfies IpcFailure;

      const outcome = importKnowledgeForProject(db as never, projectId, parsed.pkg, {
        mode: isKnowledgeImportMode(input?.mode) ? input.mode : undefined,
      });
      if (!outcome.ok) return { error: { code: outcome.code, message: outcome.message } } satisfies IpcFailure;
      return { data: outcome.result };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  ipcMain.handle('knowledge:imports', async (_event, input?: { projectId?: unknown; limit?: unknown }) => {
    try {
      const projectId = projectIdOf(input);
      if (!projectId) return { error: { code: 'INVALID_REQUEST', message: '缺少项目 id' } } satisfies IpcFailure;
      const limit = typeof input?.limit === 'number' ? input.limit : 5;
      return { data: listKnowledgeImports(db as never, projectId, limit) };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  // ===== zx_20261022_3 批八: 项目画像 =====
  // 读视图与生成结果**同形**（界面一个渲染分支）。stale 只对本机生成成立：
  //   导入画像的 `source_hash` 记的是**来源项目**的输入，与本机输入天然不同——那不是"过期"。
  const viewOf = (projectId: string): KnowledgeProfileView => {
    const stored = readProjectProfile(db as never, projectId);
    const currentHash = currentProfileSourceHash(db as never, projectId);
    return {
      version: PROJECT_PROFILE_VERSION,
      budgetTokens: PROFILE_INJECT_MAX_TOKENS,
      profile: stored?.profile ?? null,
      enabled: stored?.enabled ?? false,
      origin: stored?.origin ?? null,
      sourceProjectName: stored?.sourceProjectName ?? '',
      generatedAt: stored?.generatedAt ?? '',
      sourceHash: stored?.sourceHash ?? '',
      currentHash,
      stale: stored ? stored.origin === 'local' && stored.sourceHash !== currentHash : false,
      stats: profileInjectionStats(db as never, projectId),
    };
  };

  ipcMain.handle('knowledge:profile', async (_event, input?: { projectId?: unknown }) => {
    try {
      const projectId = projectIdOf(input);
      if (!projectId) return { error: { code: 'INVALID_REQUEST', message: '缺少项目 id' } } satisfies IpcFailure;
      return { data: viewOf(projectId) };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  // 手动生成/刷新：**零档位闸**（社区档照常生成）。过期不自动覆盖——本通道只在用户点击时写。
  // 刷新**不改**既有 `enabled`（读侧表达：想注入就继续注入新版）。
  ipcMain.handle('knowledge:profileGenerate', async (_event, input?: { projectId?: unknown }) => {
    try {
      const projectId = projectIdOf(input);
      if (!projectId) return { error: { code: 'INVALID_REQUEST', message: '缺少项目 id' } } satisfies IpcFailure;
      const built = buildProjectProfile(db as never, projectId);
      if (!built.ok) return { error: { code: 'NO_FACTS', message: built.reason } } satisfies IpcFailure;
      saveProjectProfile(db as never, built.profile);
      return { data: viewOf(projectId) };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  ipcMain.handle('knowledge:profileEnabled', async (_event, input?: { projectId?: unknown; enabled?: unknown }) => {
    try {
      const projectId = projectIdOf(input);
      if (!projectId) return { error: { code: 'INVALID_REQUEST', message: '缺少项目 id' } } satisfies IpcFailure;
      if (typeof input?.enabled !== 'boolean') {
        return { error: { code: 'INVALID_REQUEST', message: '缺少 enabled（布尔）' } } satisfies IpcFailure;
      }
      const changed = setProjectProfileEnabled(db as never, projectId, input.enabled);
      if (!changed) return { error: { code: 'NOT_FOUND', message: '本项目尚无画像——请先生成或导入' } } satisfies IpcFailure;
      return { data: viewOf(projectId) };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } } satisfies IpcFailure;
    }
  });

  console.log('[IPC] Knowledge pack handlers registered');
}
