/**
 * zx_20261014_4 批二（罗尔斯·无知之幕 / 康德·自由以他人自由为界）: 外部终端配对的**人侧** IPC。
 *
 * 出口，各自**只做一件事**：
 *   - `external:listPending` —— 待审批申请（显名 + 短码 + 申请的来源地址）。
 *   - `external:list`        —— 全部终端（各态），面板"已授权终端"区块用。
 *   - `external:approve`     —— **点同意**（用户唯一动作）：铸发凭据（库只存 hash）+ 记被允许的能力。
 *   - `external:reject`      —— 拒绝一条申请。
 *   - `external:revoke`      —— 吊销一台已批准终端（其凭据**立即**失效）。
 *   - `external:reissue`     —— zx_20261022_3 批五：**重新签发**「已批准、未送达」终端的凭据
 *                              （旧钥匙作废、新钥匙只回终端一次；仍只存 hash、仍不经用户手）。
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
  buildPairNotice,
  MAX_PENDING_PAIRS_PER_ADDR,
  createPairRequestGuarded,
  getTerminalBrief,
  listPendingTerminals,
  listTerminals,
  rejectTerminal,
  reissueTerminalCredential,
  revokeTerminal,
  terminalReasonToError as reasonToError,
  type PendingTerminalPublic,
  type TerminalDb,
  type TerminalPublic,
} from '../core/external-terminals.js';
import {
  LAN_SILENCE_MS,
  createTerminalBrowseLifecycle,
  listLanPending,
  silenceLanTerminal,
  takeLanPending,
  type LanPendingTerminal,
  type SilenceDb,
  type TerminalBrowseIo,
  type TerminalBrowseLifecycle,
  type TerminalBrowseStatusPayload,
} from '../core/lan-terminals.js';
import { pushImOwnerNotice } from '../core/im/im-notify.js';
import {
  DEFAULT_TERMINAL_CAPABILITIES,
  EXTERNAL_CAPABILITIES,
  EXTERNAL_CAPABILITY_LABEL,
  EXTERNAL_CAPABILITY_NOTE,
  isInvocableCapability,
  listExternalCalls,
  type ExternalCallDb,
  type ExternalCallRow,
  type ExternalCapability,
} from '../core/external-calls.js';
import { teamFeatureRefusal } from '../core/team-gate.js';
import { refusalWithContext } from '../core/tier-usage.js';
import type { LicenseSettingDb } from '../core/license.js';
// zx_20261018_2 批六「见新」：「门」的人侧动作发生即上屏（面板不再等 5s 轮询）。
import { emitExternalStatusChanged, emitLanTerminalSeen } from '../core/refresh-events.js';

/**
 * 可授予能力的一项（`id` + 人话名）。**词表只此一份**（由 main 侧 `EXTERNAL_CAPABILITIES` 派生，
 * renderer 不手抄第二份——承「新增枚举值须穷举全部读取谓词」含**第二进程词表落点**的教训）。
 */
export interface ExternalCapabilityOption {
  id: ExternalCapability;
  label: string;
  /** 审批面板初值勾不勾——`intent_control` 勾、`device_control` 不勾（zx_20261018_1 D-2）。 */
  defaultChecked: boolean;
  /** 风险说明（与 label 同源：`EXTERNAL_CAPABILITY_NOTE`）。 */
  note: string;
  /** 能否经 `/invoke` 原始调用——`intent_control` 为 false（只能走意图协议）。 */
  invocable: boolean;
}

export interface ExternalListPayload {
  /** `pending` 行**多带短码**（给人核对"来的真是这个东西"，见 `PendingTerminalPublic`）。 */
  pending: PendingTerminalPublic[];
  terminals: TerminalPublic[];
  /** 审批面板的勾选词表——"能授予什么"由 main 一处真源给，renderer 只渲染。 */
  capabilities: ExternalCapabilityOption[];
  /** 审批面板勾选框的**初值集合**（与 IM 审批同一份 `DEFAULT_TERMINAL_CAPABILITIES`）。 */
  defaultCapabilities: ExternalCapability[];
}

/**
 * zx_20261029_2 M4：常驻发现的**实况**（只读）——形状的真源在 `core/lan-terminals.ts`；
 * 此处 re-export 只为渲染层沿既有 `external.ipc.js` 取类型的惯例（不手抄第二份形状）。
 */
export type { TerminalBrowseLifecycle, TerminalBrowseStatusPayload } from '../core/lan-terminals.js';

/**
 * zx_20261023_5 批四：**局域网待接入**列表（只读）。
 * `running`（浏览真在跑）与 `error`（起不来的因）分开如实说——列表空时用户要能分清
 * 「没人广播」与「本机看不见」。
 */
export interface LanPendingPayload {
  items: LanPendingTerminal[];
  running: boolean;
  error: string | null;
  /** 锁定档：不浏览、不列（与设备渠道"锁定档不列"同一纪律）。 */
  locked: boolean;
  detail: string;
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

/** 审批/吊销的统一回包：成功回 `data.ok=true`（重签再带一句人话）；失败按码回 `error`（供面板如实提示）。 */
type MutateResult = { data: { ok: true; message?: string } } | { error: { code: string; message: string } };

// 拒因 → 错误形状的唯一实现在 `core/external-terminals.ts`（纯函数，受控回归可直跑）。

export function initExternalIpc(
  db: Database.Database,
  control: InboundControl,
  browse?: { io?: TerminalBrowseIo; isDoorRunning?: () => boolean },
): TerminalBrowseLifecycle {
  const tdb = db as unknown as TerminalDb;
  const cdb = db as unknown as ExternalCallDb;
  const licDb = db as unknown as LicenseSettingDb;
  const sdb = db as unknown as SilenceDb;

  // zx_20261029_2 M4：**常驻发现**由装配层随入站门起停（`main/index.ts` 的 `applyInboundDoor`）；
  //   IPC 只读状态 + 局域网接入/忽略两动作，**不再**由 `lanList` 惰性拉起。
  const browseLifecycle = createTerminalBrowseLifecycle(db, {
    ...(browse?.io ? { io: browse.io } : {}),
    ...(browse?.isDoorRunning ? { isDoorRunning: browse.isDoorRunning } : {}),
    onDiscovered: (item) => emitLanTerminalSeen({ id: item.id, name: item.name, address: item.address }),
  });

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
        capabilities: EXTERNAL_CAPABILITIES.map((id) => ({
          id,
          label: EXTERNAL_CAPABILITY_LABEL[id],
          defaultChecked: DEFAULT_TERMINAL_CAPABILITIES.includes(id),
          note: EXTERNAL_CAPABILITY_NOTE[id],
          invocable: isInvocableCapability(id),
        })),
        defaultCapabilities: [...DEFAULT_TERMINAL_CAPABILITIES],
      };
      return { data: payload };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // 点同意：铸发凭据（只存 hash，明文留门端点发终端）+ 记被允许的能力。**不回**明文。
  ipcMain.handle('external:approve', async (_event, { pairingId, capabilities }: { pairingId: string; capabilities?: string[] }) => {
    try {
      // 未传 `capabilities`（老渲染层/IM 语义）⇒ 取默认（意图控制）；**显式传 `[]`** 仍表示"只配对、不授予"。
      const caps = Array.isArray(capabilities) ? capabilities : [...DEFAULT_TERMINAL_CAPABILITIES];
      const r = approveTerminal(tdb, String(pairingId ?? ''), caps);
      if (!r.ok) return { error: reasonToError(r.reason) } satisfies MutateResult;
      emitExternalStatusChanged('external:approve', { pairingId: String(pairingId ?? '') });
      return { data: { ok: true } } satisfies MutateResult;
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  ipcMain.handle('external:reject', async (_event, { pairingId }: { pairingId: string }) => {
    try {
      const id = String(pairingId ?? '');
      const r = rejectTerminal(tdb, id);
      if (!r.ok) return { error: reasonToError(r.reason) } satisfies MutateResult;
      // zx_20261023_5 批四：拒掉的是**局域网发现**来的终端 ⇒ 24 小时内不再出现在待接入列表（防骚扰）。
      const brief = getTerminalBrief(tdb, id);
      if (brief?.source === 'lan' && brief.address) {
        try { silenceLanTerminal(sdb, { name: brief.name, address: brief.address }); } catch { /* 静默写失败不改变"已拒"事实 */ }
      }
      emitExternalStatusChanged('external:reject', { pairingId: id });
      return { data: { ok: true } } satisfies MutateResult;
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  ipcMain.handle('external:revoke', async (_event, { terminalId }: { terminalId: string }) => {
    try {
      const r = revokeTerminal(tdb, String(terminalId ?? ''));
      if (!r.ok) return { error: reasonToError(r.reason) } satisfies MutateResult;
      emitExternalStatusChanged('external:revoke', { terminalId: String(terminalId ?? '') });
      return { data: { ok: true } } satisfies MutateResult;
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // 重新签发**未送达**终端的凭据（zx_20261022_3 批五）：旧钥匙立即作废、新钥匙只回终端一次。
  // ⚠ 只对「已批准且未送达」生效——已送达的终端好好能用，换钥匙等于把它踢出门；要换须吊销重配。
  ipcMain.handle('external:reissue', async (_event, { terminalId }: { terminalId: string }) => {
    try {
      const r = reissueTerminalCredential(tdb, String(terminalId ?? ''));
      if (!r.ok) return { error: reasonToError(r.reason) } satisfies MutateResult;
      emitExternalStatusChanged('external:reissue', { terminalId: String(terminalId ?? '') });
      return { data: { ok: true, message: r.message } } satisfies MutateResult;
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
        if (refusal) return { error: { code: 'TEAM_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'team' }) } };
      }
      const next = await control.setEnabled(on);
      emitExternalStatusChanged('external:setInbound', { enabled: on, running: next.running, port: next.port });
      return { data: next } satisfies { data: InboundStatusPayload };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // ── zx_20261023_5 批四：**局域网发现**（Team）────────────────────────────────
  // 发现 ≠ 授权：列表只来自内存且 30 秒即散；点「接入」才走配对（核对码 → 批准 → 钥匙只回一次）。

  // zx_20261029_2 M4：常驻发现的**只读实况**——运行中 / 未运行的原因（门未开、Team 未解锁、起不来）。
  //   ⚠ 它**不**起停浏览（起停随入站门，见 `applyInboundDoor`）；面板打开与否都不影响发现。
  ipcMain.handle('external:lanStatus', async () => {
    try {
      return { data: browseLifecycle.status() } satisfies { data: TerminalBrowseStatusPayload };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  ipcMain.handle('external:lanList', async () => {
    try {
      const s = browseLifecycle.status();
      const items = s.locked ? [] : listLanPending();
      const payload: LanPendingPayload = {
        items,
        running: s.running,
        error: s.error,
        locked: s.locked,
        detail: s.locked
          ? s.detail
          : s.error
            ? `本机 mDNS 浏览不可用：${s.error}`
            : items.length
              ? `局域网内看到 ${items.length} 台终端（30 秒无广播即消失）`
              : s.running
                ? '正在监听局域网…（广播中的 AI 终端会出现在这里，30 秒无广播即消失）'
                : s.detail,
      };
      return { data: payload } satisfies { data: LanPendingPayload };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // 点「接入」：把发现到的一台终端转成**待批申请**（与终端自己敲门走同一条配对账）。
  ipcMain.handle('external:lanRequest', async (_event, { lanId }: { lanId: string }) => {
    try {
      const refusal = teamFeatureRefusal(licDb, 'external_terminal');
      if (refusal) return { error: { code: 'TEAM_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'team' }) } };
      const id = String(lanId ?? '');
      const item = listLanPending().find((x) => x.id === id) ?? null;
      if (!item) {
        return { error: { code: 'INVALID_STATE', message: '该终端已不在待接入列表（超过 30 秒未广播或已被处理）——等它再广播一次即可。' } };
      }
      const r = createPairRequestGuarded(tdb, item.name, item.address, { source: 'lan' });
      if (!r.ok) {
        return { error: { code: 'TOO_MANY_PENDING', message: `同一地址的待批申请已达上限（${MAX_PENDING_PAIRS_PER_ADDR} 件）——先处理已有申请。` } };
      }
      takeLanPending(item.id);
      emitExternalStatusChanged('external:lan_request', { pairingId: r.pairingId, name: item.name });
      // 与终端自己敲门**同一路通知**：主人不在电脑前也能在 IM 里批（消息里带"来自局域网发现"）。
      void pushImOwnerNotice(db, buildPairNotice({ name: item.name, pairCode: r.pairCode, source: 'lan' }), 'external_pairing')
        .catch((e: unknown) => console.error('[工蚁] 局域网配对通知推送失败：', (e as Error)?.message || String(e)));
      return { data: { pairingId: r.pairingId, pairCode: r.pairCode } } satisfies { data: { pairingId: string; pairCode: string } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // 「忽略」一台发现到的终端：24 小时内不再列出（**不落终端台账**——拒绝的是"出现"，不是"进门申请"）。
  // zx_20261023_5 批五：与 list/request **同一把闸**——此前靠"锁定档列表恒空 ⇒ 找不项 ⇒ INVALID_STATE"
  //   间接拦住，属"结果对、理由错"；穷举读取谓词后在此直说 Team 要求（承 `feedback_enum_value_sweep_readers`）。
  ipcMain.handle('external:lanIgnore', async (_event, { lanId }: { lanId: string }) => {
    try {
      const refusal = teamFeatureRefusal(licDb, 'external_terminal');
      if (refusal) return { error: { code: 'TEAM_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'team' }) } };
      const id = String(lanId ?? '');
      const item = listLanPending().find((x) => x.id === id) ?? null;
      if (!item) return { error: { code: 'INVALID_STATE', message: '该终端已不在待接入列表。' } };
      silenceLanTerminal(sdb, { name: item.name, address: item.address });
      emitExternalStatusChanged('external:lan_ignore', { lanId: id });
      return { data: { ok: true, silencedForMs: LAN_SILENCE_MS } } satisfies { data: { ok: true; silencedForMs: number } };
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

  // 交给装配层：入站门开/关的**同一条路**上 `start()/stop()`（见 `main/index.ts`）。
  return browseLifecycle;
}
