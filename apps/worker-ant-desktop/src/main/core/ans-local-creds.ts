/**
 * zx_20261009 M1（道德经·善闭无关楗而不可开 / 维特根斯坦·意义即使用）: 本机 ANS 的**"自己人"凭据**。
 *
 * 病根：发布版首启时本机 ANS 与桌面**没有共同身份**——桌面 `wa_settings` 里 `ans_api_key` 是空串
 *   （生产缺省 `ANS_UNCONFIGURED`），ANS 也没有任何 `ans_api_keys` 行 ⇒ 桌面到 ANS 的签名请求**必 401**
 *   `Invalid API key`。dev 之所以好，只因 `.env` 里恰好有 `dev-key` 与 ANS 的 env 回退**碰巧对齐**——
 *   那是"恰好"，不是机制。真正的"关"不是加锁，是**自己人认得自己人**：桌面拉起本机 ANS 时，把同一对
 *   凭据既写进 `wa_settings`（客户端用）、又随子进程 env 下发（ANS 用）。
 *
 * ⚠ **铸币只在"桌面真的拥有这台 ANS"的那一刻**——不是首启无条件铸：用户把 ANS 指向**远端**时，随机
 *   key 远端不认；且写进去会把"未配置 ⇒ 安装向导"的语义顶掉（`ansUserConfigured` 恒真）。故调用方须
 *   先过 `isLocalUrl` 与 `ansCredentialsConfigured` 两道闸。
 *
 * 本文件只依赖 `@worker-ant/ans-client` / `node-identity`（不引 electron / better-sqlite3），
 *   故可被受控回归**直引跑真实现**（同 `ans-signed-request.ts` 范式）。
 */
import { generateCredentialPair } from '@worker-ant/ans-client';
import { NODE_SETTING_KEYS, writeNodeSetting, type NodeSettingDb } from './node-identity.js';
import type { AnsCredPair } from './ans-signed-request.js';

export interface MintedCreds extends AnsCredPair {
  /** 本次是否**真的新铸**了一对（`false`＝原值齐备，原样返还，**未覆盖**）。 */
  minted: boolean;
  /**
   * 落库是否成功。`minted:true` 而 `persisted:false` ＝"**子进程拿得到**（env 注入不依赖 DB）、
   *   **客户端下轮读不到**"——调用方须上屏，不许静默（`writeNodeSetting` 的既有纪律）。
   */
  persisted: boolean;
}

/**
 * 确保本机 ANS 有一对可用凭据：**已齐备 ⇒ 原样返还**（`minted:false`，绝不覆盖用户已配的身份）；
 * 缺任一半 ⇒ 铸一对并落库（`wa_settings`，`resolveAnsCreds` 的落点）。
 *
 * `gen` 可注入（受控回归用确定性生成器）；缺省取 `@worker-ant/ans-client` 的 `generateCredentialPair`。
 */
export function mintLocalAnsCreds(
  db: NodeSettingDb,
  current: AnsCredPair,
  gen: () => AnsCredPair = generateCredentialPair,
): MintedCreds {
  if (current.apiKey && current.secretKey) return { ...current, minted: false, persisted: true };
  const made = gen();
  const okKey = writeNodeSetting(db, NODE_SETTING_KEYS.ansApiKey, made.apiKey);
  const okSecret = writeNodeSetting(db, NODE_SETTING_KEYS.ansSecretKey, made.secretKey);
  return { ...made, minted: true, persisted: okKey && okSecret };
}
