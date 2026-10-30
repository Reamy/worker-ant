/**
 * zx_20261021_3 批五: **领域包**的 IPC 出口。
 *
 * 五通道，判据与编排全在 `core/domain-pack.ts`（本文件不另判档位、不另算预算）：
 *   · `packs:list`    —— 包资产清单 + 本项目是否已启用（只读）。
 *   · `packs:derive`  —— 从本项目既有知识派生并落一份资产。**挂 Pro 闸**（拒因原样回 `FEATURE_REQUIRED`）。
 *   · `packs:apply`   —— 在本项目启用某包。**挂 Pro 闸**；已启用是幂等值不是错误。
 *   · `packs:unapply` —— 取消启用。**永不挂闸**（用户必须随时能撤）。
 *   · `packs:stats`   —— 注入成效（`source='domain_pack'` 的真实注入行，不改状态）。
 *
 * ⚠ **导入 ≠ 启用**：本文件的 apply/unapply 只动 `wa_project_domain_packs`，不碰资产本身；
 *   共享库拉进来的包从不自动启用（见 `core/team-library.ts`）。
 */
import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import {
  applyDomainPack,
  createDomainPack,
  domainPackInjectionStats,
  listDomainPacks,
  unapplyDomainPack,
} from '../core/domain-pack.js';

type IpcFailure = { error: { code: string; message: string } };

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function fail(code: string, message: string): IpcFailure {
  return { error: { code, message } };
}

export function initPacksIpc(db: Database.Database): void {
  ipcMain.handle('packs:list', async (_event, input?: { projectId?: unknown }) => {
    try {
      const projectId = str(input?.projectId);
      // projectId 可缺：缺省即"全部资产、无应用标记"（全局浏览）
      return { data: { packs: listDomainPacks(db as never, projectId || undefined) } };
    } catch (e) {
      return fail('INTERNAL', (e as Error)?.message || String(e));
    }
  });

  ipcMain.handle('packs:derive', async (_event, input?: { projectId?: unknown; name?: unknown; description?: unknown }) => {
    try {
      const projectId = str(input?.projectId);
      if (!projectId) return fail('INVALID_REQUEST', '缺少项目 id');
      const outcome = createDomainPack(db as never, projectId, {
        name: str(input?.name) || undefined,
        description: str(input?.description) || undefined,
      });
      if (!outcome.ok) return fail(outcome.code, outcome.reason);
      return { data: { id: outcome.id, pack: outcome.pack } };
    } catch (e) {
      return fail('INTERNAL', (e as Error)?.message || String(e));
    }
  });

  ipcMain.handle('packs:apply', async (_event, input?: { projectId?: unknown; packId?: unknown }) => {
    try {
      const projectId = str(input?.projectId);
      const packId = str(input?.packId);
      if (!projectId) return fail('INVALID_REQUEST', '缺少项目 id');
      if (!packId) return fail('INVALID_REQUEST', '缺少领域包 id');
      const r = applyDomainPack(db as never, projectId, packId);
      if (r.refusal) return fail('FEATURE_REQUIRED', r.refusal);
      if (r.reason === 'no_such_project') return fail('INVALID_REQUEST', '缺少项目 id');
      if (r.reason === 'no_such_pack') return fail('NO_SUCH_PACK', `领域包不存在：${packId}`);
      return { data: { applied: r.applied, already: r.reason === 'already_applied' } };
    } catch (e) {
      return fail('INTERNAL', (e as Error)?.message || String(e));
    }
  });

  ipcMain.handle('packs:unapply', async (_event, input?: { projectId?: unknown; packId?: unknown }) => {
    try {
      const projectId = str(input?.projectId);
      const packId = str(input?.packId);
      if (!projectId || !packId) return fail('INVALID_REQUEST', '缺少项目 id 或领域包 id');
      return { data: { removed: unapplyDomainPack(db as never, projectId, packId) } };
    } catch (e) {
      return fail('INTERNAL', (e as Error)?.message || String(e));
    }
  });

  ipcMain.handle('packs:stats', async (_event, input?: { projectId?: unknown }) => {
    try {
      const projectId = str(input?.projectId);
      if (!projectId) return fail('INVALID_REQUEST', '缺少项目 id');
      return { data: domainPackInjectionStats(db as never, projectId) };
    } catch (e) {
      return fail('INTERNAL', (e as Error)?.message || String(e));
    }
  });

  // zx_20261030_1 M6「荐」: 候选包的两个通道住在 `knowledge.ipc.ts`（与知识收件箱其余三通道同处），
  //   通道名沿用 `packs:*`（renderer 取值不变）；本文件仍只做五个基础通道。

  console.log('[IPC] Domain pack handlers registered');
}
