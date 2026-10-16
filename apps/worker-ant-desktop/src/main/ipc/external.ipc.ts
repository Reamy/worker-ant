/**
 * zx_20261014_4 批二（罗尔斯·无知之幕 / 康德·自由以他人自由为界）: 外部终端配对的**人侧** IPC。
 *
 * 五个出口，各自**只做一件事**：
 *   - `external:listPending` —— 待审批申请（显名 + 短码 + 申请的来源地址）。
 *   - `external:list`        —— 全部终端（各态），面板"已授权终端"区块用。
 *   - `external:approve`     —— **点同意**（用户唯一动作）：铸发凭据（库只存 hash）+ 记被允许的能力。
 *   - `external:reject`      —— 拒绝一条申请。
 *   - `external:revoke`      —— 吊销一台已批准终端（其凭据**立即**失效）。
 *
 * ⚠ **凭据不经用户手**：`approve` **不回**明文 key/secret——它们只从门端点（`GET /api/v1/pair/status`）
 *   直发终端那一次。本 IPC 只让用户"点同意/不同意"，不让用户抄凭据（罗尔斯·无知之幕的落地）。
 * ⚠ 写口一律经 `core/external-terminals.ts` 的**同一个**编排（没有第二份状态机）。
 *
 * zx_20261014_4 批三（管子·度量衡 / 道德经·善闭无关楗而不可开）: 再补**三个**出口——
 *   - `external:status`     —— 门的实况（用户开关 / 真在监听 / 端口 / 上次起不来的因）。
 *   - `external:setInbound` —— 用户显式开/关（**真起、真停**监听 + 写 `node.external_inbound`）。
 *   - `external:listCalls`  —— 外部终端**经门做过的事**留痕（仿 `devices:control` 的审计面）。
 *
 * ⚠ **开关不写库＝名实不符**：`setInbound` 只做"翻译 + Team 软闸"，真起停由注入的 `InboundControl`
 *   落地（本层不引 `core/inbound-gate.js`——与 `devices.ipc.ts` 的注入面同范式，IPC 层只管协议形状）。
 * ⚠ Team 软闸：**只拦"开"**。锁定态下"关"恒放行——把门关上是永远安全的动作，
 *   若连关都拦，许可一旦过期用户就被锁在一扇**打不开也关不掉**的门前（比病更糟）。
 */
import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import {
  approveTerminal,
  listPendingTerminals,
  listTerminals,
  rejectTerminal,
  revokeTerminal,
  type PendingTerminalPublic,
  type TerminalDb,
  type TerminalPublic,
} from '../core/external-terminals.js';
import {
  EXTERNAL_CAPABILITIES,
  EXTERNAL_CAPABILITY_LABEL,
  listExternalCalls,
  type ExternalCallDb,
  type ExternalCallRow,
  type ExternalCapability,
} from '../core/external-calls.js';
import { teamFeatureRefusal } from '../core/team-gate.js';
import type { LicenseSettingDb } from '../core/license.js';

/**
 * 可授予能力的一项（`id` + 人话名）。**词表只此一份**（由 main 侧 `EXTERNAL_CAPABILITIES` 派生，
 * renderer 不手抄第二份——承「新增枚举值须穷举全部读取谓词」含**第二进程词表落点**的教训）。
 */
export interface ExternalCapabilityOption {
  id: ExternalCapability;
  label: string;
}

export interface ExternalListPayload {
  /** `pending` 行**多带短码**（给人核对"来的真是这个东西"，见 `PendingTerminalPublic`）。 */
  pending: PendingTerminalPublic[];
  terminals: TerminalPublic[];
  /** 审批面板的勾选词表——"能授予什么"由 main 一处真源给，renderer 只渲染。 */
  capabilities: ExternalCapabilityOption[];
}

/** 「门」实况（只读）——`enabled` 是**用户意图**（库里的开关），`running` 是**真在监听**。二者皆如实，不互相推断。 */
export interface InboundStatusPayload {
  enabled: boolean;
  running: boolean;
  port: number | null;
  /** 如实说明：起不来时记**因**（"如实记因"的落点），正常时一句人话。 */
  detail: string;
}

/**
 * 门的**起停控制面**——由 `main/index.ts` 注入真实现（本层不引 `inbound-gate.js`）。
 * `setEnabled(on)` 须**既写库又真起停**：只写库 ⇒ 重启才生效（名实不符）；只起停 ⇒ 重启回旧态。
 */
export interface InboundControl {
  status(): InboundStatusPayload;
  setEnabled(on: boolean): Promise<InboundStatusPayload>;
}

/** 审批/吊销的统一回包：成功回 `data.ok=true`；失败按码回 `error`（供面板如实提示）。 */
type MutateResult = { data: { ok: true } } | { error: { code: string; message: string } };

function reasonToError(reason: string): { code: string; message: string } {
  if (reason === 'not_found') return { code: 'NOT_FOUND', message: '该申请/终端不存在' };
  if (reason.startsWith('not_pending')) return { code: 'INVALID_STATE', message: `该申请已不是待批状态（${reason.split(':')[1] ?? ''}）` };
  if (reason.startsWith('not_approved')) return { code: 'INVALID_STATE', message: `该终端不是已授权状态（${reason.split(':')[1] ?? ''}）` };
  return { code: 'INTERNAL', message: reason };
}

export function initExternalIpc(db: Database.Database, control: InboundControl): void {
  const tdb = db as unknown as TerminalDb;
  const cdb = db as unknown as ExternalCallDb;
  const licDb = db as unknown as LicenseSettingDb;

  ipcMain.handle('external:listPending', async () => {
    try {
      return { data: { pending: listPendingTerminals(tdb) } satisfies { pending: PendingTerminalPublic[] } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  ipcMain.handle('external:list', async () => {
    try {
      const payload: ExternalListPayload = {
        pending: listPendingTerminals(tdb),
        terminals: listTerminals(tdb),
        capabilities: EXTERNAL_CAPABILITIES.map((id) => ({ id, label: EXTERNAL_CAPABILITY_LABEL[id] })),
      };
      return { data: payload };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // 点同意：铸发凭据（只存 hash，明文留门端点发终端）+ 记被允许的能力。**不回**明文。
  ipcMain.handle('external:approve', async (_event, { pairingId, capabilities }: { pairingId: string; capabilities?: string[] }) => {
    try {
      const r = approveTerminal(tdb, String(pairingId ?? ''), Array.isArray(capabilities) ? capabilities : []);
      if (!r.ok) return { error: reasonToError(r.reason) } satisfies MutateResult;
      return { data: { ok: true } } satisfies MutateResult;
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  ipcMain.handle('external:reject', async (_event, { pairingId }: { pairingId: string }) => {
    try {
      const r = rejectTerminal(tdb, String(pairingId ?? ''));
      if (!r.ok) return { error: reasonToError(r.reason) } satisfies MutateResult;
      return { data: { ok: true } } satisfies MutateResult;
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  ipcMain.handle('external:revoke', async (_event, { terminalId }: { terminalId: string }) => {
    try {
      const r = revokeTerminal(tdb, String(terminalId ?? ''));
      if (!r.ok) return { error: reasonToError(r.reason) } satisfies MutateResult;
      return { data: { ok: true } } satisfies MutateResult;
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // 门的实况（只读，照常回——即便档位锁定也如实回"关着"，面板据此显示升级提示）。
  ipcMain.handle('external:status', async () => {
    try {
      return { data: control.status() } satisfies { data: InboundStatusPayload };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // 用户显式开/关（真起、真停 + 写库）。⚠ Team 软闸**只拦"开"**（见文件头注释：连关都拦＝锁死用户）。
  ipcMain.handle('external:setInbound', async (_event, { enabled }: { enabled: boolean }) => {
    try {
      const on = !!enabled;
      if (on) {
        const refusal = teamFeatureRefusal(licDb, 'external_terminal');
        if (refusal) return { error: { code: 'TEAM_REQUIRED', message: refusal } };
      }
      return { data: await control.setEnabled(on) } satisfies { data: InboundStatusPayload };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // 外部调用留痕（最近在前）。**被拒也留痕**（`result='denied'`）——"量过就得记数"（管子·度量衡）。
  ipcMain.handle('external:listCalls', async (_event, { limit }: { limit?: number } = {}) => {
    try {
      const calls: ExternalCallRow[] = listExternalCalls(cdb, limit ?? 50);
      return { data: { calls } } satisfies { data: { calls: ExternalCallRow[] } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });
}
