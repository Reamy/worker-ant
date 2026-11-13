/**
 * zx_20261112_2 B4「数」：用量账的**模型引用归一**——写端一处。
 *
 * 病根：桌面每步上报 `POST /billing/records` 时 `model_id` 传的是**模型名**（`d.modelName`），
 *   而模型页按 `ans_ai_models.id` 聚合。全库 90 个模型里 85 个 `id` 恰好等于 `name`（看起来正常），
 *   对不上的 5 个（Ollama 等 UUID 主键）**永远零用量**——真库 `qwen3.5:9b` 按名字有 23 条、按 id 0 条。
 *
 * 归一规矩（不猜）：
 *   ① 已经是现有 id ⇒ 原样；
 *   ② 否则按 `name` 查：**恰一条** ⇒ 换成该 id；
 *   ③ 0 条 / 多条 ⇒ **保留原值**（孤儿账如实留着，不硬塞给谁）。
 *
 * 纯读、零缓存：调用频率=每次记账一次，一次主键 + 一次唯一名查，代价可接受。
 * 读端**只按 id 聚合**（单一真源）；归一只在写端与一次性回填做，不做"id 或 name"的双条件 JOIN。
 */
import type Database from 'better-sqlite3';

type Db = Pick<Database.Database, 'prepare'>;

/**
 * 调用数 = **两本账取较大者**（同一批调用可能同时记在计费与质量两处：归档前的服务就是每条都写两份）。
 *
 * 为什么不是相加：相加会把"同一次调用"算两次（归档服务的历史账正是如此）；为什么不是只认计费：
 * 纯质量上报（只写 `/quality` 的客户端）会显示 0。取 max 在三种真实形态下都对：
 *   · 桌面（只写计费）⇒ 计费数；· 归档前服务（两处都写、数目相等）⇒ 不双计；· 只写质量 ⇒ 质量数。
 * 负数按 0（坏数据不算成负调用）。
 */
export function callCountOf(qualityCount: number, billingCount: number): number {
  return Math.max(0, Math.max(Number(qualityCount) || 0, Number(billingCount) || 0));
}

/**
 * 历史回填（幂等）：只把「不是现有 id ∧ 名字唯一命中」的行改写成 id；孤儿行（无同名模型）不动。
 * 由 `db/schema.ts` 在建表后调用一次；单独导出供回归直跑。
 */
export function backfillModelRefs(db: Db): void {
  for (const table of ['ans_billing_records', 'ans_model_quality_logs']) {
    try {
      db.prepare(
        `
        UPDATE ${table}
           SET model_id = (SELECT m.id FROM ans_ai_models m WHERE m.name = ${table}.model_id)
         WHERE model_id NOT IN (SELECT id FROM ans_ai_models)
           AND (SELECT COUNT(*) FROM ans_ai_models m WHERE m.name = ${table}.model_id) = 1
      `,
      ).run();
    } catch {
      /* 该表未建（迁移早期）⇒ 跳过这一张；下次启动再试 */
    }
  }
}

export function resolveModelId(db: Db, raw: unknown): string {
  const ref = String(raw ?? '').trim();
  if (!ref) return ref;
  try {
    const byId = db.prepare('SELECT 1 AS hit FROM ans_ai_models WHERE id = ? LIMIT 1').get(ref) as
      | { hit?: number }
      | undefined;
    if (byId) return ref;
    const rows = db.prepare('SELECT id FROM ans_ai_models WHERE name = ? LIMIT 2').all(ref) as Array<{ id?: string }>;
    if (rows.length === 1 && typeof rows[0]?.id === 'string' && rows[0].id) return rows[0].id;
  } catch {
    // 模型表不存在（迁移早期/裸夹具）⇒ 保留原值，不因读失败改账。
  }
  return ref;
}
