/**
 * zx_20261107_1 B6「信」：**用户指定模型**的三处落点与优先级——恢复路 > 项目级 > 全局默认。
 *
 * 病根：选型链此前只有"恢复路沿用"（`preferredModel` 参数）一条被动入口，用户想把某个模型
 *   定为默认或按项目固定，**没有任何持久化入口**；界面上也就无从说起"为什么这次是它"。
 *
 * 三条纪律：
 *   ① 三处读法都**不抛**（rr 内存库可能没有这两张表）——取不到即 `null`，回落自动选型；
 *   ② 项目级只写 `context_json.model_override` **一个键**（`json_set`），不整份覆写；
 *   ③ 优先级本身是**纯函数**（`resolvePinnedModel`），谁传什么一目了然。
 */
import type Database from 'better-sqlite3';

/** 全局默认模型（`wa_settings` 键）。 */
export const DEFAULT_MODEL_SETTING_KEY = 'model.default_model';
/** 项目级覆盖（`wa_projects.context_json` 键）。 */
export const PROJECT_MODEL_OVERRIDE_KEY = 'model_override';

export type PinnedModelSource = 'resume' | 'project' | 'default';

export interface PinnedModel {
  source: PinnedModelSource;
  /** 被指定的模型名（原样，不 trim 成空串以外的形态）。 */
  requested: string;
}

export function readDefaultModel(db: Database.Database): string | null {
  try {
    const row = db.prepare('SELECT value FROM wa_settings WHERE key = ?').get(DEFAULT_MODEL_SETTING_KEY) as
      | { value?: unknown }
      | undefined;
    const v = typeof row?.value === 'string' ? row.value.trim() : '';
    return v || null;
  } catch {
    return null;
  }
}

export function readProjectModelOverride(db: Database.Database, projectId: string | null | undefined): string | null {
  if (!projectId) return null;
  try {
    const row = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as
      | { context_json?: unknown }
      | undefined;
    const raw = row?.context_json;
    const s = Buffer.isBuffer(raw) ? raw.toString('utf-8') : typeof raw === 'string' ? raw : '';
    if (!s) return null;
    const parsed: unknown = JSON.parse(s);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const v = (parsed as Record<string, unknown>)[PROJECT_MODEL_OVERRIDE_KEY];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 写项目级覆盖：`model` 为空 ⇒ **删键**（回到"未覆盖"）。返回是否真的改到了行。
 * 只 `json_set`/`json_remove` 一个键，兄弟键（budget/rhythm/…）原样保留。
 */
export function writeProjectModelOverride(
  db: Database.Database,
  projectId: string,
  model: string | null,
): boolean {
  try {
    const r = model && model.trim()
      ? db
          .prepare(
            "UPDATE wa_projects SET context_json = json_set(COALESCE(context_json, '{}'), '$.model_override', ?), updated_at = datetime('now') WHERE id = ?",
          )
          .run(model.trim(), projectId)
      : db
          .prepare(
            "UPDATE wa_projects SET context_json = json_remove(COALESCE(context_json, '{}'), '$.model_override'), updated_at = datetime('now') WHERE id = ?",
          )
          .run(projectId);
    return ((r as { changes?: number } | undefined)?.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * 三处落点的**唯一裁定处**：恢复路（调用方传入）> 项目级 > 全局默认；都为空 ⇒ `null`（自动选型）。
 * 只决定"用户想要谁"，**不判它在不在本次池子**——那是选型段的事（池外不硬塞，如实回落）。
 */
export function resolvePinnedModel(
  db: Database.Database,
  projectId: string | null | undefined,
  resumeModel?: string | null,
): PinnedModel | null {
  const resume = String(resumeModel ?? '').trim();
  if (resume) return { source: 'resume', requested: resume };
  const project = readProjectModelOverride(db, projectId);
  if (project) return { source: 'project', requested: project };
  const global = readDefaultModel(db);
  if (global) return { source: 'default', requested: global };
  return null;
}
