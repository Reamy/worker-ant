/**
 * zx_20261116_1 M6.5「窗」：任务详情的“相似任务”计算——从 IPC handler 里抽出的**唯一实现**。
 *
 * 病根（2026-11-16 10:23 真事故）：用户在任务详情点「执行」后看到“相似任务加载失败”。
 * 计算逻辑内联在 `ipc/project.ipc.ts` 的 `task:similar` handler 里，异常被 catch 成
 * `(err as Error).message`——若抛出值不是 Error，message 为 `undefined`，前端只剩一句“加载失败”，
 * 既无真因也无日志。抽成纯函数后：
 *   · rr 可直接喂故障桩证“非 Error 也有非空 reason”；
 *   · IPC handler 只做薄壳，失败必落 `logger.warn`；
 *   · `SQLITE_BUSY`/`SQLITE_LOCKED` 标 `retryable`，由 handler 做一次短退避重试（读路径，不打开无限重试）。
 *
 * 语义与旧内联实现逐字一致：目标任务的 `task_embedding` 与最多 100 个 completed 任务的同长度 embedding
 * 做余弦相似度，降序取前 N。目标本身没有 embedding ⇒ 成功但空列表（“没有可比样本”，不是错误）。
 */

export interface SimilarTask {
  id: string;
  title: string;
  status: string;
  similarity: number;
}

export type SimilarTasksResult =
  | { ok: true; items: SimilarTask[] }
  | { ok: false; reason: string; retryable: boolean };

export interface SimilarityDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

const CANDIDATE_SQL = "SELECT id, title, status, context_json FROM wa_tasks WHERE project_id = ? AND id != ? AND status = 'completed' AND context_json LIKE '%task_embedding%' ORDER BY updated_at DESC LIMIT 100";

function isBusyMessage(msg: string): boolean {
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(msg);
}

/** 从 `context_json` 取 embedding；坏 JSON / 非数组 ⇒ 空数组（该候选不参与，与旧实现一致）。 */
function embeddingOf(contextJson: unknown): number[] {
  try {
    const v = (JSON.parse(String(contextJson ?? '{}')) as { task_embedding?: unknown }).task_embedding;
    return Array.isArray(v) ? (v as number[]) : [];
  } catch {
    return [];
  }
}

/**
 * 计算相似任务。**不抛**：任何异常都转成 `{ ok:false, reason }`，reason 保证非空。
 */
export function computeSimilarTasks(db: SimilarityDb, taskId: string, projectId: string, limit = 5): SimilarTasksResult {
  try {
    const target = db.prepare('SELECT context_json, title FROM wa_tasks WHERE id = ?').get(taskId) as
      | { context_json?: string | null; title?: string | null }
      | undefined;
    if (!target) return { ok: false, reason: '任务不存在', retryable: false };

    const targetEmb = embeddingOf(target.context_json);
    if (targetEmb.length === 0) return { ok: true, items: [] };

    const candidates = db.prepare(CANDIDATE_SQL).all(projectId, taskId) as Array<{
      id: string;
      title: string;
      status: string;
      context_json: string | null;
    }>;

    const scored: SimilarTask[] = [];
    for (const c of candidates) {
      const emb = embeddingOf(c.context_json);
      if (emb.length !== targetEmb.length) continue;
      let dot = 0;
      let a = 0;
      let b = 0;
      for (let i = 0; i < emb.length; i++) {
        const x = emb[i]!;
        const y = targetEmb[i]!;
        dot += x * y;
        a += x * x;
        b += y * y;
      }
      const sim = a > 0 && b > 0 ? dot / (Math.sqrt(a) * Math.sqrt(b)) : 0;
      scored.push({ id: c.id, title: c.title, status: c.status, similarity: Math.round(sim * 100) / 100 });
    }
    scored.sort((x, y) => y.similarity - x.similarity);
    const n = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 5;
    return { ok: true, items: scored.slice(0, n) };
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).trim() || '未知错误（已记录）';
    return { ok: false, reason, retryable: isBusyMessage(reason) };
  }
}
