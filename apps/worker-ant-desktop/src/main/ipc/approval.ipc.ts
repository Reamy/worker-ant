/**
 * zx_20261104_3 M3「联」（维特根斯坦·意义即使用）:
 * **授权台一屏**——待接入终端 / 待授权设备 / 待答跨机问题，三本账一次读齐。
 *
 * 为什么单独成出口：
 *   · 三本账此前各住一页（协同面板 / 设备页 / 派单台账），"还有几件等我点头"要翻三处；
 *   · `/inbox` 页与侧栏角标读**同一份** `buildApprovalInbox`（与 IM「授权待办」同源），不各算一遍；
 *   · 本口**只读不挂闸**（承 `devices:list` / `external:listPending` 先例）：锁档时仍如实列出待办，
 *     用户在页面上看得见"有事等我"，只是动作会被各自的写口按档位拒并说明原因。
 *
 * ⚠ 每段的**动作闸**如实随载荷下发（终端＝`external_terminal`+`approval_inbox`；设备＝`device_control`；
 *   问题＝`multi_node`）——页面据它摆升级卡，不自行推导档位（第二落点教训）。
 * ⚠ 零写库；计数由同一份 inbox 派生。
 */
import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { buildApprovalInbox } from '../core/im/approval-inbox.js';
import { teamFeatureRefusal, type TeamFeature } from '../core/team-gate.js';
import type { LicenseSettingDb } from '../core/license.js';

/** 一段待办的动作可否执行（锁定态只影响动作，不影响"看得见"）。 */
export interface ApprovalActionGate {
  unlocked: boolean;
  /** 锁定＝如实拒因；解锁＝一句已启用。直接上屏。 */
  detail: string;
}

export interface ApprovalInboxPayload {
  terminals: ReturnType<typeof buildApprovalInbox>['terminals'];
  devices: ReturnType<typeof buildApprovalInbox>['devices'];
  questions: ReturnType<typeof buildApprovalInbox>['questions'];
  counts: { terminals: number; devices: number; questions: number; total: number };
  /** 三段各自的写口闸（与写口引同一判据 `teamFeatureRefusal`）。 */
  gates: { terminals: ApprovalActionGate; devices: ApprovalActionGate; questions: ApprovalActionGate };
}

function gateOf(db: LicenseSettingDb, features: readonly TeamFeature[]): ApprovalActionGate {
  for (const f of features) {
    const refusal = teamFeatureRefusal(db, f);
    if (refusal) return { unlocked: false, detail: refusal };
  }
  return { unlocked: true, detail: '已启用。' };
}

export function initApprovalIpc(db: Database.Database): void {
  const licDb = db as unknown as LicenseSettingDb;
  ipcMain.handle('approval:inbox', async () => {
    try {
      const inbox = buildApprovalInbox(db);
      const counts = {
        terminals: inbox.terminals.length,
        devices: inbox.devices.length,
        questions: inbox.questions.length,
        total: inbox.terminals.length + inbox.devices.length + inbox.questions.length,
      };
      const payload: ApprovalInboxPayload = {
        ...inbox,
        counts,
        gates: {
          terminals: gateOf(licDb, ['external_terminal', 'approval_inbox']),
          devices: gateOf(licDb, ['device_control']),
          questions: gateOf(licDb, ['multi_node']),
        },
      };
      return { data: payload };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });
}
