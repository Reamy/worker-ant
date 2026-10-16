/**
 * zx_20260930 M15-③：插件市场「外源」的**校验 + argv 构造 + 失败账**唯一处。
 *
 * 病根（实测）：`routes/plugin-marketplace.ts` 把 `source_ref` / `source_url` **模板串拼进 shell**——
 *   `git fetch origin && git reset --hard origin/${sourceRef}`（`:250` / `:311`）、
 *   `git clone --depth 1 --branch ${sourceRef} ${sourceUrl} ${cachePath}`（`:252` / `:313`）。
 *   这两个值来自 `POST /api/v1/plugins/marketplaces` 的**请求体**，此前**零校验** ⇒
 *   `source_ref = "main; rm -rf ~"` 这类字符串会被 `/bin/sh` 当命令执行。
 * 本模块把两件事同时收口：
 *   ① **白名单 + argv 数组**：值的合法域在这里判死（`validateMarketplaceSource`），
 *      命令在调用侧用 `execFile('git', argv)` 起（**不经 shell**）⇒ 注入面在结构上消失。
 *   ② **失败要有账**：原来那种「静默空 catch」一律换成 `recordMarketplaceRefreshError`
 *      （`last_error` / `last_error_at` 两列，见 `db/schema.ts` 的迁移）——静默的失败读不出因果。
 *
 * 零**运行期**依赖（不 import fs / child_process / db 驱动；`better-sqlite3` 只在 `import type` 里
 * 出现，编译后即抹掉），故可被 vitest 直引跑真实现。
 */
import type Database from 'better-sqlite3';

/**
 * 市场来源类型白名单。四值齐是**实测**的（不是照抄某一处的字面量）：
 *   `refreshAllMarketplaces` 的谓词只筛 `github|gitee`（走 git），刷新路由另有两支
 *   `url|github-topics`（走 HTTP 适配器）——四个都得在内，否则合法市场被自己拦下。
 */
export const MARKETPLACE_SOURCE_TYPES = ['github', 'gitee', 'url', 'github-topics'] as const;
export type MarketplaceSourceType = (typeof MARKETPLACE_SOURCE_TYPES)[number];

export function isMarketplaceSourceType(v: unknown): v is MarketplaceSourceType {
  return typeof v === 'string' && (MARKETPLACE_SOURCE_TYPES as readonly string[]).includes(v);
}

/**
 * git ref 白名单：**首字符须字母数字**（挡 `-` 开头的参数注入，如 `--upload-pack=…`），
 * 其余只许 `A-Za-z0-9._/-`，长度 ≤ 128。`..` 另判（git 自身也禁，但先在入口挡住更清楚）。
 */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export interface MarketplaceSourceInput {
  source_type: string;
  source_url: string;
  source_ref?: string | null;
}

export type MarketplaceSourceCheck =
  | { ok: true; value: { source_type: MarketplaceSourceType; source_url: string; source_ref: string } }
  | { ok: false; reason: string };

/**
 * 校验一条市场的来源三元组。**只判值**，不碰网络/磁盘。
 * `source_ref` 缺省取 `main`（与建表默认同值）；给了就必须是合法 git ref——
 * 即便该类型当前不走 git（`url` / `github-topics`）也照判：它是**落库**的值，
 * 今天不进 shell 不等于明天不进，入口处一次判死比逐调用点记得判更可靠。
 */
export function validateMarketplaceSource(input: MarketplaceSourceInput): MarketplaceSourceCheck {
  const type = String(input?.source_type ?? '');
  if (!isMarketplaceSourceType(type)) {
    return { ok: false, reason: `source_type 不在白名单（${MARKETPLACE_SOURCE_TYPES.join(' / ')}）` };
  }
  const url = String(input?.source_url ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) {
    return { ok: false, reason: 'source_url 须是 http(s):// 开头的 URL 且不含空白' };
  }
  const rawRef = input?.source_ref;
  const ref = rawRef === undefined || rawRef === null || String(rawRef).trim() === '' ? 'main' : String(rawRef).trim();
  if (!REF_RE.test(ref) || ref.includes('..')) {
    return { ok: false, reason: 'source_ref 不是合法的 git ref（字母数字开头，只含 A-Za-z0-9._/-，不含 ..）' };
  }
  return { ok: true, value: { source_type: type, source_url: url, source_ref: ref } };
}

/**
 * 把「刷新一个 git 市场」拆成**若干条 argv**（每条是 `git` 的一个完整命令行）。
 * 调用侧逐条 `execFile('git', argv)` —— 值是**参数**，不是 shell 片段。
 * 已缓存 ⇒ `fetch origin` + `reset --hard origin/<ref>`；未缓存 ⇒ `clone --depth 1 --branch <ref> <url> <path>`。
 * 用 `-C <path>` 而非 `cwd` 选项：argv 里自带路径，测试无需 spawn 即可断言逐字形状。
 */
export function gitRefreshSteps(input: {
  exists: boolean;
  sourceRef: string;
  sourceUrl: string;
  cachePath: string;
}): string[][] {
  if (input.exists) {
    return [
      ['-C', input.cachePath, 'fetch', 'origin'],
      ['-C', input.cachePath, 'reset', '--hard', `origin/${input.sourceRef}`],
    ];
  }
  return [['clone', '--depth', '1', '--branch', input.sourceRef, input.sourceUrl, input.cachePath]];
}

/** 失败账：写入**因**与**时刻**（列由 `db/schema.ts` 的迁移补上）。 */
export function recordMarketplaceRefreshError(db: Database.Database, id: string, message: string): void {
  try {
    db.prepare("UPDATE ans_plugin_marketplaces SET last_error = ?, last_error_at = datetime('now') WHERE id = ?").run(
      String(message ?? '').slice(0, 500),
      id,
    );
  } catch {
    // 旧库尚未迁移该列：不因"记账失败"中断刷新本身（刷新结果仍由返回值体现）。
  }
}

/** 成功账：刷到就用时刻，并**清掉**上一轮的失败因（否则界面会一直显示已修好的旧错）。 */
export function recordMarketplaceRefreshOk(db: Database.Database, id: string): void {
  try {
    db.prepare(
      "UPDATE ans_plugin_marketplaces SET last_refresh_at = datetime('now'), last_error = '' WHERE id = ?",
    ).run(id);
  } catch {
    /* 同上：旧库未迁移 */
  }
}
