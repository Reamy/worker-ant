import { invoke } from './ipc';
import type { ModelProbe } from '../../../src/main/core/model-availability.js';

/**
 * zx_20261005 M14: 首启判据的渲染层读出——**真源在 main `core/first-run.ts`**，此处只缓存一次调用。
 * zx_20261011_5：缓存对象由"布尔"扩为**整份 `setup:state` 载荷**（多带一份 `model` 快照供首屏 banner），
 *   `needsSetup()` 语义**不变**（读 `payload.needsSetup`）。
 *
 * 为什么缓存：`ProtectedRoute` 包裹**每一条**路由，逐次路由挂载各发一条 IPC 会白费；而首启状态
 *   在一次会话内只在"用户跑出第一个项目 / 配好 ANS / 配好模型"时才变——那些事都由本模块的作废函数收口。
 *
 * 与旧的 localStorage 布尔标志的分野：那个标志记"点没点过按钮"，本判据记"**这台机器跑起来没有**"。
 */
export interface SetupPayload {
  needsSetup: boolean;
  hasProject: boolean;
  ansUserConfigured: boolean;
  /** 模型可用性快照；main 侧在"结论已定"的格（有项目 / 未配 ANS）不探 ⇒ 可能为 null。 */
  model: ModelProbe | null;
}

const FALLBACK: SetupPayload = { needsSetup: false, hasProject: false, ansUserConfigured: false, model: null };

let cached: Promise<SetupPayload> | null = null;

function load(): Promise<SetupPayload> {
  if (!cached) {
    cached = invoke<SetupPayload>('setup:state')
      .then((r) => ({
        needsSetup: !!r?.needsSetup,
        hasProject: !!r?.hasProject,
        ansUserConfigured: !!r?.ansUserConfigured,
        model: r?.model ?? null,
      }))
      // 失败时保守返回 `needsSetup:false`（不拦，宁可少弹不可错拦）。
      .catch(() => { cached = null; return FALLBACK; });
  }
  return cached;
}

/** 是否应弹安装向导（**按状态**：无项目，且「未真配 ANS ∨ 无可用 chat 模型」）。 */
export async function needsSetup(): Promise<boolean> {
  return (await load()).needsSetup;
}

/** 作废缓存——安装向导收尾（建了项目 / 配好 ANS / 配好模型）后调一次，避免本轮仍按旧态拦人。 */
export function invalidateNeedsSetup(): void { cached = null; }

/**
 * 模型可用性快照——首屏 banner 用。`force=true` 经 `setup:model-availability` **单独现探一次**
 *   （不依赖 `setup:state` 是否探过，覆盖"有项目的老用户也缺模型"这一格）；失败/未认证 ⇒ 返回带 `read` 的如实快照。
 */
export async function modelAvailability(force = false): Promise<ModelProbe | null> {
  if (force) {
    try { return await invoke<ModelProbe>('setup:model-availability'); }
    catch { return null; }
  }
  return (await load()).model;
}
