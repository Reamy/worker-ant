/**
 * zx_20261023_5 批五（毛选·不打无准备之仗 / 维特根斯坦·一个规则一处）：**云端权益的网络一跳**。
 *
 * 与 `cloud-entitlement.ts` **刻意分家**：
 *   · `cloud-entitlement.ts` 只做缓存的读/写/收窄/合并（零网络、零 electron），许可热路径直接引它；
 *   · 本文件做"去 ANS 取一次"——签名请求仍走 `ans-signed-request.ts` 的**唯一出路**
 *     （不自造第二份 HMAC/请求逻辑），失败只留痕、不抛。
 *
 * 口径（与方案一致）：
 *   · **5 秒有界**、不重试（`retries: 0`）——启动路径上不许把一个不可达的云端拖成 10 秒；
 *   · **失败 fail-open**：保留上一次成功取得的权益（不清空），只追加 `lastError/lastErrorAt`；
 *   · 从未成功过也照样落一行"只有失败账"的缓存——界面才能如实说"不可达（原因）"，
 *     而不是把"没同步过"显示成"已同步但无权益"。
 */
import {
  ansCredentialsConfigured,
  ansFailureNote,
  ansSignedRequest,
  resolveAnsCreds,
  type AnsCreds,
} from './ans-signed-request.js';
import {
  CLOUD_ENTITLEMENT_TIMEOUT_MS,
  parseCloudEntitlement,
  readCloudEntitlementCache,
  writeCloudEntitlementCache,
  type CloudEntitlementCache,
  type CloudEntitlementWriteDb,
} from './cloud-entitlement.js';

/** 端点路径（ANS 侧 `routes/entitlements.ts` 的唯一入口）。放在**真发请求的文件**里：
 *  纯逻辑模块不该出现 `/api/v1/`——否则"凡含此串的文件都须在签名路上"的完备性扫面会把它误判为漏头。 */
export const CLOUD_ENTITLEMENT_PATH = '/api/v1/entitlements';

/** 一次拉取的结果。**永不抛**——没成功就如实装进 `reason`。 */
export interface CloudEntitlementPullResult {
  ok: boolean;
  /** 当前缓存（成功＝本次结果；失败＝旧值，可能为 null）。 */
  cache: CloudEntitlementCache | null;
  /** 如实原因（成功为 null；界面直接上屏）。 */
  reason: string | null;
  /** 是否真的发出了请求（未配凭据 ⇒ false——"没去"与"去了没回"是两件事）。 */
  attempted: boolean;
}

export interface PullCloudEntitlementOpts {
  /** 判定"此刻"用的时刻（rr 注入；生产缺省 = 现在）。 */
  now?: Date;
  /** 覆盖超时（缺省 `CLOUD_ENTITLEMENT_TIMEOUT_MS`）。 */
  timeoutMs?: number;
  /** 身份三元组的 env 回退源（rr 注入固定值，不读真实进程环境）。 */
  env?: NodeJS.ProcessEnv;
  /** 直接给凭据（优先于 DB/env 解析）。 */
  creds?: AnsCreds;
  /** 传输实现注入（rr 用；生产走全局 fetch）。 */
  fetchImpl?: typeof fetch;
}

/** 失败落账：保留旧权益，只更新失败因/时刻。写失败不抛（本次记忆不生效，下次再拉）。 */
function recordFailure(
  db: CloudEntitlementWriteDb | null | undefined,
  old: CloudEntitlementCache | null,
  reason: string,
  now: Date,
): CloudEntitlementCache {
  const next: CloudEntitlementCache = {
    fetchedAt: old?.fetchedAt ?? null,
    entitlement: old?.entitlement ?? null,
    lastError: reason,
    lastErrorAt: now.toISOString(),
  };
  writeCloudEntitlementCache(db, next);
  return next;
}

/**
 * 从 ANS 拉一次云端权益并落缓存。
 *
 * 三种结局都**有账**：
 *   ① 成功 ⇒ 覆盖缓存（`lastError` 清空）；
 *   ② 有 HTTP 回包但形状不符 ⇒ 当失败（旧权益保留，不拿脏值合并档位）；
 *   ③ 不可达/未配凭据 ⇒ 当失败（旧权益保留，原因上屏）。
 */
export async function pullCloudEntitlement(
  db: CloudEntitlementWriteDb | null | undefined,
  opts: PullCloudEntitlementOpts = {},
): Promise<CloudEntitlementPullResult> {
  const now = opts.now ?? new Date();
  const old = readCloudEntitlementCache(db);
  const creds = opts.creds ?? resolveAnsCreds(db, opts.env);

  if (!ansCredentialsConfigured(creds)) {
    const reason = '未配置 ANS 凭据（apiKey/secretKey），云端权益不可用；按本地许可运行';
    return { ok: false, cache: recordFailure(db, old, reason, now), reason, attempted: false };
  }

  const r = await ansSignedRequest(creds, CLOUD_ENTITLEMENT_PATH, {
    timeoutMs: opts.timeoutMs ?? CLOUD_ENTITLEMENT_TIMEOUT_MS,
    retries: 0,
    fetchImpl: opts.fetchImpl,
  });

  if (!r.ok || !r.response) {
    const reason = `云端权益不可达：${ansFailureNote(r)}`;
    return { ok: false, cache: recordFailure(db, old, reason, now), reason, attempted: true };
  }

  let body: unknown;
  try {
    body = await r.response.json();
  } catch (err) {
    const reason = `云端权益回包不是合法 JSON：${(err as Error)?.message ?? String(err)}`;
    return { ok: false, cache: recordFailure(db, old, reason, now), reason, attempted: true };
  }

  const entitlement = parseCloudEntitlement(body);
  if (!entitlement) {
    const reason = '云端权益回包形状不符契约（已忽略；按本地许可运行）';
    return { ok: false, cache: recordFailure(db, old, reason, now), reason, attempted: true };
  }

  const cache: CloudEntitlementCache = {
    fetchedAt: now.toISOString(),
    entitlement,
    lastError: null,
    lastErrorAt: null,
  };
  // 写失败 ⇒ 本次记忆不生效（下次再拉）；但"这次确实取到了"仍在返回值里如实体现。
  const written = writeCloudEntitlementCache(db, cache);
  return {
    ok: written,
    cache,
    reason: written ? null : '云端权益已取到，但写入本机缓存失败（下次启动会重试）',
    attempted: true,
  };
}
