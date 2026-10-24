/**
 * zx_20260930 M9（维特根斯坦·一个规则一处 / 毛选·集中优势兵力）: **到 ANS 的签名请求，只有一条出路**。
 *
 * 病根：ANS 的 `/api/v1/*` 全挂在 `hmacAuth` 下（`apps/ans-server/src/index.ts`），要求
 * `x-api-key` + `x-timestamp` + `x-signature` **三头齐备**——缺任一个就 401
 * `Missing authentication headers`。而桌面侧对这条契约有**四份各记各的写法**：
 *   ① `services/im-router.ts` 的 `classifyIntentWithLLM` —— **零认证头**；
 *   ② `core/task-decompose.ts` 的 `makeEnvDecomposeDeps` —— 只发 `x-api-key`；
 *   ③ `core/skill-registry.ts` 的 `syncSkillsFromAns` —— 只发 `x-api-key`；
 *   ④ `ipc/project.ipc.ts` 的 `registerToAns` —— 三头都发（zx_20260929 M10 修过），
 *      但那是**函数内闭包**，出不了那个函数 ⇒ 前面三条够不着它。
 * 契约只有一个、写法却有四份 ⇒ 其中三份必然"漏头而不自知"。漏头的后果**不是报错而是沉默**：
 * `fetch` 对 401 不抛，调用方的 `catch` 又把它吞成 `null` / `-1` ⇒ 连一句 warn 都不响，
 * 于是"取不到模型"看起来和"模型池里恰好没有"一模一样。
 *
 * 本模块把"到 ANS 的请求"收成**一条出路**：签名的字节串口径、头名、身份解析、超时与重试，
 * 只有这里一处写。签名的**真源仍是 `@worker-ant/ans-client` 的 `createHmacSignature`**
 * （与 `AnsClient.request` 同一把尺）——本模块**不自造第二份 HMAC**：
 * 自造一份再拿它自证，证的是"生产没走的那条路"（本仓 G-1，已复发两次）。
 *
 * 本文件只依赖 `@worker-ant/ans-client`（不引 electron / better-sqlite3 / node:*），
 * 故可被受控回归**直引跑真实现**（同 `memory-lifecycle.ts` 范式）。
 */
import { createHmacSignature } from '@worker-ant/ans-client';
// zx_20261005 M21: ANS 默认地址**单一真源**（改端口只改 shared-types 一处，不再各写各的 localhost:3001）。
import { ANS_DEFAULT_BASE_URL } from '@worker-ant/shared-types';

/** 到 ANS 的身份三元组。`baseUrl` 末尾有无 `/` 均可（本模块拼接时统一剥）。 */
export interface AnsCreds {
  baseUrl: string;
  apiKey: string;
  secretKey: string;
}

/** 读设置的最小库接口（`MemoryLifecycleDb` 同形：使本模块可脱 better-sqlite3 被 rr 直跑）。 */
export interface AnsSettingDb {
  prepare(sql: string): { get(...args: unknown[]): unknown };
}

/**
 * 缺省值——**只此一处**。
 *
 * ⚠ `secretKey` 的缺省是 `'dev-secret'`：与 `.env` 的 `ANS_SECRET_KEY` / `ANS_API_KEYS`
 *   同值（开发态的唯一可用身份）。**空串不在此列**——空 secret 签出来的头与会话另一侧的期望
 *   必然不符，那是"恒 401 且看不出为什么"的另一种写法（`registerToAns` 原先的 `|| ''` 即此）。
 * ⚠ zx_20261005 M16：这三个值是**开发缺省**，**只在开发构建里兜底**。生产构建（打包）不得把
 *   `dev-key`/`dev-secret` 当缺省发给用户——见下方 `ansRuntimeDev` 与 `ANS_DEFAULTS_PROD_NOTE`。
 */
export const ANS_DEFAULTS = {
  url: ANS_DEFAULT_BASE_URL,
  apiKey: 'dev-key',
  secretKey: 'dev-secret',
} as const;

/**
 * 生产构建的缺省 = **未配置**（空凭据）。保留缺省 URL（本机 ANS 地址无害、且"连本机还是连远端"
 *   是用户可后改的），但**绝不**内置 dev-key/dev-secret——那等于把开发凭据发到每一台用户机器上。
 */
export const ANS_UNCONFIGURED = {
  url: ANS_DEFAULT_BASE_URL,
  apiKey: '',
  secretKey: '',
} as const;

/**
 * 运行期「构建形态」——zx_20261005 M16。
 *
 * 为什么用模块级开关而非给 `resolveAnsCreds` 加形参：该函数有 **12 处消费点**，逐处传 `isDev`
 *   既散又会漏；而"内置 dev-key/dev-secret 只该在开发构建里兜底"是**全局事实**，不是每处调用
 *   各自的参数。main 启动时 `setAnsRuntimeMode(isDev)` **设一次**，全仓读取者同受其管。
 *
 * ⚠ 缺省 `true`（＝开发）：rr / 单测 / 任何未初始化的调用面**零行为变化**（它们本就在开发态跑，
 *   且 rr 从不会去调 setter）；只有打包出来的生产进程会显式设 `false`。这是 G-4「判据不依赖
 *   真实环境」的同一手法：把环境事实收成一个**可注入的开关**，而不是在判据里读 `process.env`。
 */
let ansRuntimeDev = true;
/** main 启动时调用一次（生产传 `false`）。 */
export function setAnsRuntimeMode(isDev: boolean): void { ansRuntimeDev = isDev; }
/** 当前运行期是否开发形态（供 UI/判据读取）。 */
export function ansRuntimeIsDev(): boolean { return ansRuntimeDev; }

/**
 * 身份三元组的**唯一解析口径**：DB `wa_settings` → 进程 env → 缺省。
 *
 * ⚠ 顺序与 `main/index.ts` 里构造 `AnsClient` 那处**逐位一致**（本轮把那一处也改引本函数，
 *   免得两处各记各的——`ans_secret_key` 漏读一次，那一路就恒 401 且静默）。
 * ⚠ `env` 是形参（不是直接读 `process.env`）：判据据此不碰真实进程环境，也不必改全局态（G-4）。
 * ⚠ 桌面 main **不加载 `.env`**（无 dotenv）⇒ 只读 env 的写法在 Electron 里拿不到 secret。
 *   这正是①②③三条路当年恒 401 的机制之一；DB 是这条路真正的落点。
 * ⚠ zx_20261005 M16：尾端缺省**依运行形态**——开发吃 `ANS_DEFAULTS`，生产吃 `ANS_UNCONFIGURED`
 *   （空凭据 ⇒ 调用方据 `ansCredentialsConfigured` 如实报"未配置"，而不是拿 dev-key 去撞 401）。
 */
export function resolveAnsCreds(db: AnsSettingDb | null | undefined, env: NodeJS.ProcessEnv = process.env): AnsCreds {
  const read = (key: string): string | undefined => {
    if (!db) return undefined;
    try {
      const row = db.prepare('SELECT value FROM wa_settings WHERE key=?').get(key) as { value?: string } | undefined;
      return row?.value || undefined;
    } catch {
      return undefined; // 表还没建 / 库未就绪 ⇒ 退 env 与缺省，不把"读不到"当成"没有身份"
    }
  };
  const fallbackApiKey = ansRuntimeDev ? ANS_DEFAULTS.apiKey : ANS_UNCONFIGURED.apiKey;
  const fallbackSecret = ansRuntimeDev ? ANS_DEFAULTS.secretKey : ANS_UNCONFIGURED.secretKey;
  return {
    baseUrl: read('ans_server_url') || env.ANS_SERVER_URL || ANS_DEFAULTS.url,
    apiKey: read('ans_api_key') || env.ANS_API_KEY || fallbackApiKey,
    secretKey: read('ans_secret_key') || env.ANS_SECRET_KEY || fallbackSecret,
  };
}

/**
 * 凭据是否**齐备**（三态判据：apiKey 与 secretKey 均非空）。未配置 ⇒ 到 ANS 的签名请求必然 401，
 *   调用方应据此**如实报"未配置"**并引导，而不是把缺身份当成"服务没起"。
 */
export function ansCredentialsConfigured(creds: AnsCreds): boolean {
  return !!creds.apiKey && !!creds.secretKey;
}

/**
 * 是否**用户真配过**（区别于"正在吃内置开发缺省"）：三项中任一偏离缺省即视为已配置。
 *   首启引导（M14）据此判"ANS 已配好 ⇒ 不再弹安装向导"，故它必须能把"dev 缺省"与"用户真配"分开。
 */
export function ansUserConfigured(creds: AnsCreds): boolean {
  return creds.baseUrl !== ANS_DEFAULTS.url
    || creds.apiKey !== ANS_DEFAULTS.apiKey
    || creds.secretKey !== ANS_DEFAULTS.secretKey;
}

/**
 * 该 `apiKey` 是否为**内置开发占位**（空串 / `ANS_DEFAULTS.apiKey`）——zx_20261012 新增。
 *
 * 与 `ansUserConfigured` **分家**：后者答"用户**真配过 ANS** 没"（三项任一偏离缺省即真配过，
 *   故 `baseUrl` 变了就为真，哪怕 key 仍是占位）；本判据只答"**这把 key 是内置占位**没"。
 *   节点"已注册"要的正是后者——注册所得 key 必有值、且**必不等于**内置占位；
 *   拿 `dev-key`（或空串）当"注册过"正是 zx_20261012 治的那处**假绿**（key 被退回占位，判据却仍真）。
 * 占位真源仍只此一处（`ANS_DEFAULTS`），别处**不得**再写 `'dev-key'` 字面量。
 */
export function isPlaceholderApiKey(apiKey: string | null | undefined): boolean {
  return !apiKey || apiKey === ANS_DEFAULTS.apiKey;
}

/**
 * 首启写库用的缺省凭据（zx_20261005 M16）。与 `resolveAnsCreds` 的尾端缺省**同源**：
 *   开发写 dev-key/dev-secret，生产写空串——否则老库的 `wa_settings` 里会永久躺着 dev-key，
 *   把 `resolveAnsCreds` 的 `read()` 顶掉，尾端形态开关形同虚设（这正是「判据的自我印证」同族）。
 */
export function ansSeedCreds(): { url: string; apiKey: string; secretKey: string } {
  return ansRuntimeDev
    ? { url: ANS_DEFAULTS.url, apiKey: ANS_DEFAULTS.apiKey, secretKey: ANS_DEFAULTS.secretKey }
    : { url: ANS_UNCONFIGURED.url, apiKey: ANS_UNCONFIGURED.apiKey, secretKey: ANS_UNCONFIGURED.secretKey };
}

/** 一对 ANS 凭据（`ANS_API_KEYS` 的 `key:secret` 两半）。 */
export interface AnsCredPair {
  apiKey: string;
  secretKey: string;
}

/**
 * 子进程 `ANS_API_KEYS` 的取值形态（zx_20261009 M2）——代起本机 ANS 时随子进程 env 下发。
 *
 * ANS 侧 `utils/security.ts` 的 `getSecrets` 在 DB 无此 key 行时按 **env 回退**认：
 *   `ANS_API_KEYS` 逗号分隔、每段 `key:secret`（`pair.split(':')` 后 `k === apiKey && s`）。
 * 缺任一半 ⇒ `null`——**宁可如实不注入，也不发半对凭据**（半对必 401 且看不出为什么）。
 */
export function ansApiKeysEnvValue(creds: AnsCredPair): string | null {
  return creds.apiKey && creds.secretKey ? `${creds.apiKey}:${creds.secretKey}` : null;
}

/**
 * 三个认证头——**全仓唯一构造处**。头名用**小写**：ANS 侧取的就是
 * `request.headers.get('x-api-key')`（HTTP 头名本不区分大小写，但两侧形状一致才可读、可比对）。
 *
 * 签的字节串是 `` `${timestamp}\n${body}` ``——**无 body 时 body 传 `''`**，
 * 与 `AnsClient.requestWithRetry` 在无 body 时的口径逐字相同（同尺，非等价自造）。
 */
export function ansSignedHeaders(creds: AnsCreds, bodyText: string, timestampMs: number = Date.now()): Record<string, string> {
  const timestamp = String(timestampMs);
  return {
    'x-api-key': creds.apiKey,
    'x-timestamp': timestamp,
    'x-signature': createHmacSignature(creds.secretKey, timestamp, bodyText),
  };
}

export interface AnsRequestOpts {
  /** 默认 `GET`。 */
  method?: string;
  /** 请求体对象；`undefined` ⇒ 不发 body（**签的字节串为空串**）。 */
  body?: unknown;
  /** 默认 5000ms。 */
  timeoutMs?: number;
  /** 失败后**再试**的次数（默认 `1` ⇒ 最多两次尝试）。仅对**传输失败/5xx**重试；4xx 是契约/身份问题，重试无益。 */
  retries?: number;
  /**
   * 传输实现注入（默认全局 `fetch`）。**只给受控回归用**：rr 据此在同一份生产代码上
   *   喂 200/401/超时回包，而不必起真 ANS、也不得另写一份"等价"请求逻辑（G-1）。
   */
  fetchImpl?: typeof fetch;
}

export interface AnsRequestResult {
  ok: boolean;
  /** 有 HTTP 响应时为真实状态码；传输层失败（超时/连不上）时为 `0`。 */
  status: number;
  response?: Response;
  /** 传输层失败的**如实原因**（有 HTTP 响应时为 undefined）。 */
  detail?: string;
  /** 实际尝试了几次——调用方据此把"重试过"也留在痕上。 */
  attempts: number;
}

/**
 * 到 ANS 的签名请求——**全仓唯一出路**（凡 `ANS/api/v1/*` 都走它）。
 *
 * **永不抛**：把"没成功"如实装进返回值（`ok=false` + `status`/`detail`/`attempts`），
 * 由调用方决定怎么留痕、怎么降级。这样"失败"与"没有值"在调用点可分辨——
 * 此前两者都化归 `null`，正是"失败不显形"的机制。
 */
export async function ansSignedRequest(
  creds: AnsCreds,
  path: string,
  opts: AnsRequestOpts = {},
): Promise<AnsRequestResult> {
  const method = opts.method ?? 'GET';
  const bodyText = opts.body === undefined ? '' : JSON.stringify(opts.body);
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs as number)) : 5000;
  const retries = Number.isFinite(opts.retries) ? Math.max(0, Math.floor(opts.retries as number)) : 1;
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${String(creds.baseUrl ?? '').replace(/\/+$/, '')}${path}`;

  let attempts = 0;
  let lastStatus = 0;
  let lastDetail = '';
  for (let i = 0; i <= retries; i++) {
    attempts++;
    try {
      const resp = await doFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...ansSignedHeaders(creds, bodyText) },
        ...(opts.body === undefined ? {} : { body: bodyText }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastStatus = resp.status;
      lastDetail = '';
      if (resp.status >= 500 && i < retries) continue;
      return { ok: resp.ok, status: resp.status, response: resp, attempts };
    } catch (e) {
      lastStatus = 0;
      lastDetail = (e as Error)?.message || String(e);
    }
  }
  return { ok: false, status: lastStatus, detail: lastDetail, attempts };
}

/** 把结果里的失败原因压成一行，供调用方直接拼进日志（口径一处，免得各处自撰）。 */
export function ansFailureNote(r: AnsRequestResult): string {
  const status = r.status > 0 ? `HTTP ${r.status}` : '无响应';
  return `${status}${r.detail ? ` — ${r.detail}` : ''}（尝试 ${r.attempts} 次）`;
}
