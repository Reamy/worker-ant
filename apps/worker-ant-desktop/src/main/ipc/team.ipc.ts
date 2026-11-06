/**
 * zx_20261017_1 批六（管子·度量衡 / 维特根斯坦·意义即使用）: **团队共享库**的 IPC 出口。
 *
 * 四个通道，闸门次序是判据本身：
 *   `teamFeatureRefusal(db, 'team_library')` **先于任何网络调用**——锁定 ⇒ `TEAM_REQUIRED`
 *   且**不触 ANS**（R-35）。不在壳里另写档位判断（承"判据的自我印证"纪律）。
 *
 *   · `team:items`  —— 本机可分享候选（core 纯本地读）+ ANS 远端列表（一次取回，界面三栏）。
 *                      ANS 不可达时**如实带回原因**（`error`），候选照常给（分享按钮会因此失败并说明）。
 *   · `team:share`  —— 组装载荷（成果剥掉 file_path）→ POST ANS；成功后写审计 `team.library.share`。
 *   · `team:import` —— 远端条目落到本地三表；成功后写审计 `team.library.import`。
 *   · `team:delete` —— 删本机分享的条目（ANS 只认来源节点）；成功后写审计 `team.library.delete`。
 *
 * ⚠ 上限（标题 / 载荷 / 单节点条数）**只在 ANS 判**：本文件只把 ANS 的拒因原样上屏。
 * ⚠ 审计只记 kind/title/远端 id，**不记 body**（共享内容本身不复制进审计账）。
 */
import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { ansFailureNote, ansSignedRequest, resolveAnsCreds, type AnsSettingDb, type AnsRequestResult } from '../core/ans-signed-request.js';
import { teamFeatureRefusal } from '../core/team-gate.js';
import { refusalWithContext } from '../core/tier-usage.js';
import type { LicenseSettingDb } from '../core/license.js';
import { importItem, listLocalItems, shareItem, TeamLibraryError, type LocalCandidates, type TeamLibraryDb } from '../core/team-library.js';
import { recordAudit, type AuditDb } from '../core/audit-log.js';
import { ensureNodeIdentity } from '../core/node-identity.js';
import { isTeamItemKind, type TeamItem, type TeamItemKind } from '@worker-ant/shared-types';

const ITEMS_PATH = '/api/v1/team/items';

export interface TeamItemsPayload {
  /** 本机可分享候选（纯本地读；ANS 不可达也照常给）。 */
  local: LocalCandidates;
  /** 远端已分享条目。 */
  remote: TeamItem[];
  total: number;
  hasMore: boolean;
  /** 本机节点 id——界面据此只在"自己分享的"行上显示删除。 */
  localNodeId: string;
  /** 读远端失败时的如实原因（传输层/HTTP 状态），不编空列表冒充"库里没有"。 */
  error?: string;
}

type IpcFailure = { error: { code: string; message: string } };

/** 锁定档位的唯一出口（不触网）。 */
function gateError(db: Database.Database): IpcFailure | null {
  const refusal = teamFeatureRefusal(db as unknown as LicenseSettingDb, 'team_library');
  return refusal
    ? { error: { code: 'TEAM_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'team' }) } }
    : null;
}

/**
 * zx_20261022_3 批八: 画像**搬运**（分享 / 从共享库导入）另过 `project_profile_share`。
 *   ⚠ 只闸搬运：本机生成/刷新/执行期注入**不过此闸**（社区档照常自用）。
 *   在 `team_library` 之后判：两款同属 Team，但各自留一笔可核的能力账（rr 断言点名）。
 */
function profileShareGate(db: Database.Database): IpcFailure | null {
  const refusal = teamFeatureRefusal(db as unknown as LicenseSettingDb, 'project_profile_share');
  return refusal
    ? { error: { code: 'TEAM_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'team' }) } }
    : null;
}

/** ANS 的拒因原样上屏（400/409 的 message 是 ANS 写给用户看的）；非 JSON 才退状态码。 */
async function errorFromResponse(r: AnsRequestResult): Promise<IpcFailure> {
  try {
    const j = (await r.response?.json()) as { error?: { code?: string; message?: string } } | undefined;
    if (j?.error?.message) {
      return { error: { code: j.error.code || 'ANS_ERROR', message: j.error.message } };
    }
  } catch {
    /* 非 JSON 响应 ⇒ 走下一行 */
  }
  return { error: { code: 'ANS_UNAVAILABLE', message: ansFailureNote(r) } };
}

export function initTeamIpc(db: Database.Database): void {
  const lib = db as unknown as TeamLibraryDb;
  const settingDb = db as unknown as AnsSettingDb;

  ipcMain.handle('team:items', async (_event, filter?: { kind?: unknown; offset?: unknown }) => {
    try {
      const gate = gateError(db);
      if (gate) return gate;
      const kind = typeof filter?.kind === 'string' && filter.kind ? filter.kind : '';
      if (kind && !isTeamItemKind(kind)) {
        return { error: { code: 'INVALID_REQUEST', message: `未知的共享类型：${kind}` } };
      }
      const local = listLocalItems(lib);
      // 本机节点 id 由 `ensureNodeIdentity` 一处发/读（本项目既有真源；缺则补发并落库）。
      const localNodeId = ensureNodeIdentity(db as unknown as Parameters<typeof ensureNodeIdentity>[0]).id;
      const q = new URLSearchParams({ limit: '100' });
      if (kind) q.set('kind', kind);
      if (typeof filter?.offset === 'number' && filter.offset > 0) q.set('offset', String(Math.floor(filter.offset)));

      const r = await ansSignedRequest(resolveAnsCreds(settingDb), `${ITEMS_PATH}?${q.toString()}`);
      if (!r.ok) {
        return { data: { local, remote: [], total: 0, hasMore: false, localNodeId, error: ansFailureNote(r) } };
      }
      const body = (await r.response?.json()) as { data?: TeamItem[]; total?: number; has_more?: boolean } | undefined;
      return {
        data: {
          local,
          remote: Array.isArray(body?.data) ? body.data : [],
          total: Number(body?.total ?? 0),
          hasMore: body?.has_more === true,
          localNodeId,
        },
      };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  ipcMain.handle('team:share', async (_event, input?: { kind?: unknown; localId?: unknown }) => {
    try {
      const gate = gateError(db);
      if (gate) return gate;
      const kind = input?.kind;
      const localId = input?.localId;
      if (!isTeamItemKind(kind)) return { error: { code: 'INVALID_REQUEST', message: `未知的共享类型：${String(kind)}` } };
      if (kind === 'project_profile') {
        const profileGate = profileShareGate(db);
        if (profileGate) return profileGate;
      }
      if (typeof localId !== 'string' || !localId) {
        return { error: { code: 'INVALID_REQUEST', message: '缺少要分享的本地条目 id' } };
      }
      const payload = shareItem(lib, kind as TeamItemKind, localId);
      const r = await ansSignedRequest(resolveAnsCreds(settingDb), ITEMS_PATH, { method: 'POST', body: payload });
      if (!r.ok) return await errorFromResponse(r);
      const body = (await r.response?.json()) as { data?: TeamItem } | undefined;
      const item = body?.data;
      recordAudit(db as unknown as AuditDb, {
        actorKind: 'local',
        action: 'team.library.share',
        targetType: 'team_item',
        targetId: item?.id ?? '',
        detail: { kind: payload.kind, title: payload.title },
      });
      return { data: item };
    } catch (e) {
      if (e instanceof TeamLibraryError) return { error: { code: 'NOT_FOUND', message: e.message } };
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  ipcMain.handle('team:import', async (_event, input?: { item?: unknown; projectId?: unknown }) => {
    try {
      const gate = gateError(db);
      if (gate) return gate;
      const item = input?.item as TeamItem | undefined;
      if (!item || typeof item !== 'object') {
        return { error: { code: 'INVALID_REQUEST', message: '缺少要导入的共享条目' } };
      }
      if (item.kind === 'project_profile') {
        const profileGate = profileShareGate(db);
        if (profileGate) return profileGate;
      }
      const projectId = typeof input?.projectId === 'string' && input.projectId ? input.projectId : null;
      const result = importItem(lib, item, { projectId });
      recordAudit(db as unknown as AuditDb, {
        actorKind: 'local',
        action: 'team.library.import',
        targetType: 'team_item',
        targetId: item.id ?? '',
        detail: { kind: result.kind, title: item.title ?? '', localId: result.id, target: result.target },
      });
      return { data: result };
    } catch (e) {
      if (e instanceof TeamLibraryError) return { error: { code: 'INVALID_REQUEST', message: e.message } };
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  ipcMain.handle('team:delete', async (_event, input?: { id?: unknown }) => {
    try {
      const gate = gateError(db);
      if (gate) return gate;
      const id = input?.id;
      if (typeof id !== 'string' || !id) return { error: { code: 'INVALID_REQUEST', message: '缺少要删除的条目 id' } };
      const r = await ansSignedRequest(resolveAnsCreds(settingDb), `${ITEMS_PATH}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!r.ok) return await errorFromResponse(r);
      recordAudit(db as unknown as AuditDb, {
        actorKind: 'local',
        action: 'team.library.delete',
        targetType: 'team_item',
        targetId: id,
        detail: {},
      });
      return { data: { id, deleted: true } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  console.log('[IPC] Team library handlers registered');
}
