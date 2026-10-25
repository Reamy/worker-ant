/**
 * 首启竞态的有界等待（2026-10-25 实测）——「模型探针跑到 ANS 前面去了」时，等它一会儿再判。
 *
 * 病根：打包版首启时 ANS 由 supervisor **异步**拉起（`void ensureAnsStarted(...)`），而渲染层一挂载就
 *   调 `setup:state`。此刻模型探针必 ECONNREFUSED ⇒ `assessSetup` 按「判不了≠拦」退回旧判据；本地自举
 *   凭据又让 `ansUserConfigured=true` ⇒ `needsSetup=false`，真新用户于是**直接落到空 Dashboard** 而非安装
 *   向导，且渲染层把这一格缓存整场会话。实测（全新 userData、已装 0.2.1）：首启停在 Dashboard，同一进程
 *   里 `setup:state` 已是 `needsSetup:true`；**刷新一次**即进 `/onboarding`。
 *
 * 治法：**只在「本机正在拉起 ANS」时**有界等它可达；远端 ANS / 未开代起 ⇒ 立即返回（不拖慢既有路径）。
 *   本模块只管"什么时候问才有意义"，不复制任何判据——真判据仍是 `core/first-run.ts` 的 `assessSetup`。
 *
 * 零依赖（不引 electron / node:*），rr 直引真实现，依赖全注入。
 */
export interface AnsStartGraceDeps {
  /** ANS 是否已可连（生产＝`probeAns(baseUrl)`；不含认证，只判"监听起来了没"）。 */
  reachable(): Promise<boolean>;
  /** 是否正有一次代起在跑（生产＝`ansStartInFlight()`）。 */
  startInFlight(): boolean;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  /** 等待上限——覆盖常规首启（实测 2–4s），又不把"代起卡住"拖成无期。 */
  timeoutMs?: number;
  pollMs?: number;
}

export async function waitWhileAnsStarting(deps: AnsStartGraceDeps): Promise<void> {
  // 没人在拉 ⇒ 交给探针如实报（远端/未开代起/已拉完），保持原有"不拖慢"的语义。
  if (!deps.startInFlight()) return;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 250;
  const deadline = now() + (deps.timeoutMs ?? 10_000);
  while (now() < deadline) {
    if (await deps.reachable()) return;
    // 代起已收场（成功/失败/被急停）⇒ 立即交棒；成不成由紧随其后的探针如实例外说。
    if (!deps.startInFlight()) return;
    await sleep(pollMs);
  }
}
