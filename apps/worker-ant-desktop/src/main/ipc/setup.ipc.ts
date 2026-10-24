/**
 * 首启引导 IPC（zx_20261005 M14；zx_20261011_5 补模型前提）——渲染层判
 * "要不要弹安装向导 + 首屏要不要提示缺模型"的唯一读出。
 *
 * 薄壳：真判据在 `core/first-run.ts` 的 `assessSetup`（零依赖，rr 直跑同一份）。**不在此复刻任何判定**
 *   （承「判据的自我印证」纪律：两处各判一次，迟早各说各话——此地只做"现取身份 + 调真源"）。
 *
 * 与 `ans.ipc.ts` 的分别：那条答的是"ANS 在不在、谁托管"；这条答的是"**这台机器的引导走完了没有**"
 *   （须同时看项目、ANS 身份、模型可用三件事，故不在 ans.* 名下）。
 */
import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { ansSignedRequest, resolveAnsCreds } from '../core/ans-signed-request.js';
import { assessSetup } from '../core/first-run.js';
import { probeModelAvailability, type ModelProbe } from '../core/model-availability.js';
import { installSampleProject, removeSampleProject } from '../core/sample-project.js';

/**
 * 探模型可用性要打的路径——**受保护**（ANS 侧挂在 `hmacAuth` 下的 `/api/v1/models`），
 * 与 `admin.ipc.ts` 的 `ANS_HEALTH_PROBE_PATH` 同一跳（只证明"三个认证头还认得"，不只"端口有人听"）。
 */
const MODELS_PROBE_PATH = '/api/v1/models';

/** 一次模型可用性探测（走**全仓唯一出路** `ansSignedRequest`）。**永不抛**——失败如实进 `read`。 */
async function probeModel(db: Database.Database): Promise<ModelProbe> {
  return probeModelAvailability({
    request: async () => {
      const r = await ansSignedRequest(resolveAnsCreds(db), MODELS_PROBE_PATH, { timeoutMs: 3000, retries: 0 });
      let body: unknown;
      if (r.ok && r.response) {
        try { body = await r.response.json(); } catch { body = undefined; }
      }
      return { ok: r.ok, status: r.status, body, detail: r.detail };
    },
  });
}

export function initSetupIpc(db: Database.Database, dataDir: string): void {
  /**
   * 首启状态：`{ needsSetup, hasProject, ansUserConfigured, model }`。
   * 渲染层据 `needsSetup` 决定是否把用户拦到 `/onboarding`（**按状态**，不看 `localStorage`）；
   * 据 `model` 在首屏如实提示"缺可用 chat 模型"。
   */
  ipcMain.handle('setup:state', async () => {
    try {
      return { data: await assessSetup(db, resolveAnsCreds(db), () => probeModel(db)) };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  /** 只回模型可用性快照——供首屏单独刷新（`setup:state` 在部分格不探模型，首屏要无条件探一次）。 */
  ipcMain.handle('setup:model-availability', async () => {
    try {
      return { data: await probeModel(db) };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // zx_20261012_1 批四：示例项目一键载入 / 一键删除。薄壳——真逻辑在 `core/sample-project.ts`
  //   （固定 id + `is_sample=1` 双闸 + 与 `project:delete` **同一份**级联 SQL）。`dataDir` 由 `main/index.ts` 传。
  ipcMain.handle('sample:install', async () => {
    try {
      return { data: installSampleProject(db, dataDir) };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  ipcMain.handle('sample:remove', async () => {
    try {
      return { data: removeSampleProject(db, dataDir) };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  console.log('[IPC] Setup handlers registered');
}
