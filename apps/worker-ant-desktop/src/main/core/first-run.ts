/**
 * zx_20261005 M14（柏拉图·洞穴喻：看不见影子，要看得见火）: **首启判据，按状态不按标志**。
 *
 * 病根：此前"要不要弹引导"读的是 `localStorage['wa_onboarded']`——一个**与用户真实处境无关**的标志。
 *   它能被任何一次误点写成"已引导"，于是"重装/换机/清了缓存"的用户再也见不到引导；反过来，
 *   一个**已经有项目**的老用户换了浏览器存储，又会被拦回引导页。标志记的是"点过按钮"，而我们要问的是
 *   "**这台机器上跑起来了吗**"。
 *
 * 本模块把那个问题收成一条**可判定的状态**：`needsSetup = 无项目 ∧ 未真配 ANS`。
 *   - "有项目" ⇒ 用户已在这台机器上跑过东西，引导无意义（哪怕他没点过任何标志）；
 *   - "真配了 ANS" ⇒ 用户已把外部依赖接通（区别于吃内置 `dev-key`/`dev-secret` 的开发缺省，
 *     故此处用 `ansUserConfigured` 而非 `ansCredentialsConfigured`——后者在 dev 下恒真）。
 *
 * 只依赖 `ans-signed-request.js`（不引 electron / better-sqlite3 / node:*），故可被受控回归**直引跑真实现**
 *   （同 `ans-signed-request.ts` 范式）；`db` 是接口形参，rr 用内存库即可。
 */
import { ansUserConfigured as ansUserConfiguredCheck, type AnsCreds } from './ans-signed-request.js';
import type { ModelProbe } from './model-availability.js';

/** 读状态的最小库接口（与 `AnsSettingDb` 同形：使本模块可脱 better-sqlite3 被 rr 直跑）。 */
export interface FirstRunDb {
  prepare(sql: string): { get(...args: unknown[]): unknown };
}

export interface FirstRunState {
  /** 是否应弹安装向导（**按状态**：既无项目、又未真配 ANS）。 */
  needsSetup: boolean;
  /** 库里已有项目（任一）——"这台机器上跑起来过"的最硬证据。 */
  hasProject: boolean;
  /** 用户**真配过** ANS（区别于吃内置开发缺省 `dev-key`/`dev-secret`）。 */
  ansUserConfigured: boolean;
}

/**
 * 首启状态——**唯一判据**。用户"新"当且仅当 **无项目 ∧ 未真配 ANS**。
 *
 * ⚠ `creds` 由调用方（`setup.ipc.ts`）现取后传入：本模块**不自取**
 *   （与 `skill-registry`/`task-decompose` 收 `creds` 形参而不自己解析同形，也是 I-a-16 的既有约定）。
 * ⚠ 表未建 ⇒ 视为"无项目"（首启真空库正是此态），**不**把"查不动"当成"有项目"而吞掉引导。
 */
export function firstRunState(db: FirstRunDb | null | undefined, creds: AnsCreds): FirstRunState {
  let hasProject = false;
  try {
    const row = db?.prepare('SELECT COUNT(*) AS n FROM wa_projects').get() as { n?: number } | undefined;
    hasProject = Number(row?.n ?? 0) > 0;
  } catch {
    hasProject = false;
  }
  const userConfigured = ansUserConfiguredCheck(creds);
  return { needsSetup: !hasProject && !userConfigured, hasProject, ansUserConfigured: userConfigured };
}

/**
 * zx_20261011_5「名正而后事成」：**首启评估**——在 `firstRunState` 之上补一层「模型可用」。
 *
 * 病根（N1）：旧判据 `needsSetup = 无项目 ∧ 未真配 ANS` **看不见模型**。用户配好凭据、未配模型端点时
 *   被判"已就绪"，落到空白 Dashboard，建任务静默记 `no_model` ⇒ 名实不符（`needsSetup` 承诺的"跑得起来"
 *   却没看跑起来的必要条件）。
 *
 * 治法：`needsSetup = 无项目 ∧ (未真配 ANS ∨ 无可用 chat 模型)`。**委托** `firstRunState` 取基底
 *   （一处真源，不重写 hasProject/ansUserConfigured 判定）——本函数只在基底之上**加一条**模型前提。
 *
 * 两条纪律：
 *  ① **省一次网络往返**：只在"判据可能被模型改写"的那一格（`!hasProject ∧ ansUserConfigured`）才探模型；
 *     无项目∧未配 ⇒ 已在拦；有项目 ⇒ 结论已定（老用户**不因**模型缺失被拦回向导，故 `model` 为 null 也无碍）。
 *  ② **fail-open**：探针抛错 / `read !== 'ok'` ⇒ **退回旧判据**（宁可少拦不可错拦）。此刻 `model` 仍带
 *     诚实 `read`/`note`（供首屏空态如实上屏"未认证/读失败"），但**不**据此新拦人——"判不了"≠"拦"。
 */
export interface SetupAssessment extends FirstRunState {
  /** 模型可用性快照（含 read 三态）；**未探**（结论已定）或探针抛错时为 null。 */
  model: ModelProbe | null;
}

/**
 * 首启评估——渲染层判"要不要弹安装向导 + 首屏要不要提示缺模型"的**唯一读出**。
 * `probe` 是惰性 thunk：调用方（`setup.ipc.ts`）喂入走 `ansSignedRequest` 的那一跳；本模块据基底**决定是否调用它**。
 *
 * `opts.beforeProbe`（zx_20261024_4 追补）：**只决定"什么时候问"**，不参与任何判定。打包版首启时 ANS 由
 *   supervisor 异步代起，探针会在它监听之前 ECONNREFUSED ⇒ fail-open 让真新用户绕过向导。此钩子让调用方
 *   在探针前有界等一会儿（真等法在 `core/ans-start-grace.ts`，本模块零依赖故不内联）。
 *   ⚠ 只在真正要探的那一格才调用（其余格省一次无谓等待）；钩子自身抛错也吞掉——**判不了≠拦**。
 */
export interface AssessSetupOpts {
  beforeProbe?: () => Promise<void>;
}

export async function assessSetup(
  db: FirstRunDb | null | undefined,
  creds: AnsCreds,
  probe: () => Promise<ModelProbe>,
  opts: AssessSetupOpts = {},
): Promise<SetupAssessment> {
  const base = firstRunState(db, creds);
  // ① 只在「无项目 ∧ 已真配 ANS」这一格探模型——其余格结论已定，省一次网络往返。
  const shouldProbe = !base.hasProject && base.ansUserConfigured;
  let model: ModelProbe | null = null;
  if (shouldProbe) {
    if (opts.beforeProbe) {
      try { await opts.beforeProbe(); } catch { /* 等不到就照常探——探针自己会如实报 read */ }
    }
    try { model = await probe(); } catch { model = null; }
  }
  // ② 只有在"读得动模型"时才据模型改写判据；否则退回旧判据（fail-open）。
  const needsSetup = model && model.read === 'ok'
    ? !base.hasProject && (!base.ansUserConfigured || !model.hasChat)
    : base.needsSetup;
  return { needsSetup, hasProject: base.hasProject, ansUserConfigured: base.ansUserConfigured, model };
}
