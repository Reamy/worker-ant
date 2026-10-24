/**
 * zx_20261004 M4/M5/M6（海德格尔·共在 / 老子·三十三章「知人者智，自知者明」）: 协同面板的 IPC。
 *
 * 三个出口，各自**只做一件事**：
 *   - `nodes:list`   —— 群蚁一屏（**含本机行**）。读的是 **ANS 回传的台账**（`GET /api/v1/nodes`），
 *                       不是本地另算一份环境——这正是 M6「两把尺」的治法：本机行与他机行**同源同形**，
 *                       故"报出去的忙"与"面板上看见的忙"必是同一个数（心跳送上去的那一份）。
 *   - `nodes:update` —— 改档（角色/权重/参与开关）。**真源在 ANS**（派单选目标读它），故先 PATCH 到 ANS；
 *                       若改的是本机，再就地**镜像**进本地 settings（下次注册/心跳读它）并广播。
 *   - `nodes:card`   —— 本机能力卡（M11 起由工具面派生填充）；此刻如实取 ANS 回传的本机行，不本地臆造。
 *
 * ⚠ 「谁是本机」由 `ensureNodeIdentity(db).id` 定（一处真源），**不按 `name` 猜**——两台同名主机的 name
 *   相同，按名字认会把别人的行当成自己的。
 * ⚠ ANS 不可达时**如实报空 + 原因**（`ansFailureNote` 形状），不编一行假节点充数。
 * ⚠ 到 ANS 的请求一律走 `ansSignedRequest`（全仓唯一出路，见 core/ans-signed-request.ts 头注释）。
 */
import { ipcMain, BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { ansFailureNote, ansSignedRequest, resolveAnsCreds, type AnsSettingDb } from '../core/ans-signed-request.js';
import { NODE_SETTING_KEYS, ensureNodeIdentity, readNodeSetting, writeNodeSetting, type NodeSettingDb } from '../core/node-identity.js';
import { eventBus } from '../core/event-bus.js';
import { listNodeCallRecords, type NodeCallRecord } from '../core/node-call-log.js';
// zx_20261011 M3/M4: 出站（本机派出去）——派发 core（`node-dispatcher.ts`）+ 出站台账（`node-dispatch-log.ts`）。
import { dispatchNodeRequest, refreshDispatchResult, answerQuestion } from '../core/node-dispatcher.js';
import { listNodeDispatchRecords, type NodeDispatchRecord } from '../core/node-dispatch-log.js';
import { isNodeRole, type AnsNode, type NodePatch } from '@worker-ant/shared-types';
// zx_20261005 M22（Team 档软闸）: 协同面板的读/写口各经**同一判据**（`core/team-gate.ts`）——
//   锁定即**不触 ANS**（面板据 payload.gate 显示升级提示），改档口如实回 `TEAM_REQUIRED`。
import { resolveTeamGate, teamFeatureRefusal, type TeamGate } from '../core/team-gate.js';
import { refusalWithContext } from '../core/tier-usage.js';
import type { LicenseSettingDb } from '../core/license.js';
// zx_20261023_1「称」: 协同节点数上限——价目表所称的「20 台节点」须在入网注册前真能拦。
import { resolveLicenseTier } from '../core/license.js';
import { nodeQuotaCheck } from '../core/node-quota.js';
// zx_20261010_1 M2（维特根斯坦·意义即使用）: 「加入协同网络」的三出口——令牌写口 / 申请 / 注册，
//   复用 core 单源（`node-heartbeat.ts`），并调 M3 的 `startNodeRuntime` 完成**免重启即时生效**。
import { enrollWithToken, isNodeEnrolled, nodeEnrollmentReason, readEnrollmentToken, requestEnrollmentToken, writeEnrollmentToken } from '../core/node-heartbeat.js';
import { startNodeRuntime } from '../core/node-runtime.js';
// zx_20261011_4 M3: 台账取数移 core（编排器读同一份）——此处转调，形状 `NodeLedger` 一处。
import { fetchNodes, type NodeLedger } from '../core/node-list.js';
// zx_20261011_4 M4: 编排模式读/写口——键名（`NODE_SETTING_KEYS.orchestrateMode`）与词表（`ORCHESTRATE_MODES`）
//   **同在 main 一处真源**（`core/node-orchestrate.ts`）；渲染层只按返回的 `modes` 摆选项，不手抄枚举。
import { ORCHESTRATE_MODES, isOrchestrateMode, readOrchestrateMode } from '../core/node-orchestrate.js';
// zx_20261017_1 批三: 建单即派的读/写口——开关真源与审计投影同出 `core/collab-dispatch.ts`（一处真源）。
import { applyAutoDispatchOnboarding, dispatchBoard, isAutoDispatchOn, isAutoDispatchPrompted, lastAutoDispatch } from '../core/collab-dispatch.js';
// zx_20261017_1 批四: 改档留痕——写点收 `core/audit-log.ts`（一处），此处只转调。
import { recordNodeUpdate, type AuditDb } from '../core/audit-log.js';

/**
 * 本机台账行的投影——`nodes:list` / `nodes:card` 共用。
 * zx_20261011_4 M3: 读口（`nodes`/`localNodeId`/`error`/`errorStatus`）归 `NodeLedger` **一处真源**
 *   （与编排器共用），此处只加**IPC 层独有**的 `gate`（Team 档软闸由调用方定档位，取数口不定）。
 */
export interface NodesListPayload extends NodeLedger {
  /** zx_20261005 M22: Team 档软闸——面板据此显示升级提示（锁定即 `nodes` 为空、未触 ANS）。 */
  gate: TeamGate;
}

/** 与 `admin.ipc.ts` 的 `settings:changed` 同形——本机档位变更即时热更（免重启）。 */
function broadcastSetting(key: string, value: string): void {
  try {
    for (const w of BrowserWindow.getAllWindows()) { if (!w.isDestroyed()) w.webContents.send('settings:changed', { key, value }); }
  } catch { /* 广播失败不影响主流程 */ }
}

/** `EnrollResult.reason` → 面板可读说明（如实，不粉饰——注册没成时用户得知道卡在哪一环）。 */
function enrollReasonNote(reason: string): string {
  if (reason === 'ok') return '';
  if (reason === 'already-enrolled') return '本机已在 ANS 注册';
  if (reason === 'no-enrollment-token') return '没有可用的注册令牌——请先输入或申请一枚';
  if (reason.startsWith('enroll-failed:')) return `注册失败 —${reason.slice('enroll-failed:'.length)}`;
  return reason;
}

// zx_20261011_4 M3: 台账取数已移 core（`core/node-list.ts`）——编排器要读**同一份**（N3 预查），
//   两处各写一份 fetch 即"同一件事两处各记各的"。此处只转调，不再自持一份。
//   （`fetchNodes` 的失败支仍带 `errorStatus: r.status`，见其实现——与本文件 `NodesListPayload` 声明同形。）
export function initNodesIpc(db: Database.Database): void {
  const settingDb = db as unknown as NodeSettingDb;
  const licDb = db as unknown as LicenseSettingDb;

  // 群蚁一屏：ANS 台账（含本机行）。`localNodeId` 让界面把本机置顶（M4）。
  ipcMain.handle('nodes:list', async () => {
    try {
      const gate = resolveTeamGate(licDb);
      const localNodeId = ensureNodeIdentity(settingDb).id;
      // 锁定 ⇒ 不触 ANS（无本机注册，台账徒劳），回空 + gate 交面板显示升级提示。
      if (!gate.unlocked) return { data: { nodes: [], localNodeId, gate } };
      return { data: { ...(await fetchNodes(db, localNodeId)), gate } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // 改档：先落 ANS（真源），本机再镜像进 settings + 广播。
  ipcMain.handle('nodes:update', async (_event, { nodeId, patch }: { nodeId: string; patch: NodePatch }) => {
    try {
      const refusal = teamFeatureRefusal(licDb, 'multi_node');
      if (refusal) return { error: { code: 'TEAM_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'team' }) } };
      const localNodeId = ensureNodeIdentity(settingDb).id;
      const creds = resolveAnsCreds(db as unknown as AnsSettingDb);
      const r = await ansSignedRequest(creds, `/api/v1/nodes/${encodeURIComponent(nodeId)}`, { method: 'PATCH', body: patch });
      if (!r.ok) return { error: { code: 'ANS_UNAVAILABLE', message: ansFailureNote(r) } };
      let node: AnsNode;
      try {
        node = ((await r.response!.json()) as { data: AnsNode }).data;
      } catch (e) {
        return { error: { code: 'ANS_BAD_RESPONSE', message: (e as Error)?.message || String(e) } };
      }
      if (nodeId === localNodeId) {
        // 镜像：值与 ANS 回传的**收窄后**结果一致（`patch.role` 非法时 ANS 侧不动，这里也就不动）。
        if (patch.role !== undefined && isNodeRole(node.role)) {
          writeNodeSetting(settingDb, NODE_SETTING_KEYS.role, node.role);
          broadcastSetting(NODE_SETTING_KEYS.role, node.role);
        }
        if (patch.weight !== undefined) {
          writeNodeSetting(settingDb, NODE_SETTING_KEYS.weight, String(node.weight));
          broadcastSetting(NODE_SETTING_KEYS.weight, String(node.weight));
        }
        if (patch.participate !== undefined) {
          const v = node.participate ? '1' : '0';
          writeNodeSetting(settingDb, NODE_SETTING_KEYS.participate, v);
          broadcastSetting(NODE_SETTING_KEYS.participate, v);
        }
        // zx_20261011 M8（追加批）: 也镜像 `name`——镜像值取 ANS 回传的**收窄后**结果（与上三键同范式）。
        //   本地 `node.name` 是**下次注册**的取名来源（`ensureNodeIdentity` 读它），不镜像则下次注册又漂回旧名。
        if (patch.name !== undefined && node.name) {
          writeNodeSetting(settingDb, NODE_SETTING_KEYS.name, node.name);
          broadcastSetting(NODE_SETTING_KEYS.name, node.name);
        }
      }
      // zx_20261017_1 批四: 改档留痕——**真改成了**才写（`!r.ok` / 回执坏已在上面早退）。
      //   actor 取本机节点 id；detail 只记"改了哪几项 + 是否改自己"，不复制档位值。
      recordNodeUpdate(db as unknown as AuditDb, { nodeId, localNodeId, patch });
      // 面板复取 + 广播（`node.presence_changed` 已入事件溯源映射）。
      void eventBus.emit('node.presence_changed', { nodeId, node });
      return { data: node };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261011_3（老子·知止）: **删除离线节点**（把退场/换机/长期离线的他机行清出协同网络）。
  //   过 Team 软闸（与 `nodes:update` 同源）——真源在 ANS（`DELETE /api/v1/nodes/:nodeId`，硬删 + 吊销该节点 key）。
  //   守卫（不存在 404 / 自删 400 / 在线 409）**全在 ANS 侧**兜底，此处不复制一份判据（免得两处各判各的而漂）。
  //   成功 ⇒ 广播 `node.presence_changed` 供面板复取。
  ipcMain.handle('nodes:delete', async (_event, { nodeId }: { nodeId: string }) => {
    try {
      const refusal = teamFeatureRefusal(licDb, 'multi_node');
      if (refusal) return { error: { code: 'TEAM_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'team' }) } };
      const creds = resolveAnsCreds(db as unknown as AnsSettingDb);
      const r = await ansSignedRequest(creds, `/api/v1/nodes/${encodeURIComponent(nodeId)}`, { method: 'DELETE' });
      if (!r.ok) return { error: { code: 'ANS_UNAVAILABLE', message: ansFailureNote(r) } };
      let data: { node_id: string; removed: boolean };
      try {
        data = ((await r.response!.json()) as { data: { node_id: string; removed: boolean } }).data;
      } catch (e) {
        return { error: { code: 'ANS_BAD_RESPONSE', message: (e as Error)?.message || String(e) } };
      }
      void eventBus.emit('node.presence_changed', { nodeId, removed: true });
      return { data };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // 本机能力卡：ANS 台账里**本机那一行**（M6「自知者明」——本机也照他机同一面镜子看自己）。
  ipcMain.handle('nodes:card', async () => {
    try {
      const gate = resolveTeamGate(licDb);
      const localNodeId = ensureNodeIdentity(settingDb).id;
      if (!gate.unlocked) return { data: { localNodeId, node: null, gate } };
      const payload = await fetchNodes(db, localNodeId);
      const node = payload.nodes.find(n => n.node_id === localNodeId) ?? null;
      return { data: { localNodeId, node, gate, ...(payload.error ? { error: payload.error } : {}) } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // M13：AI 终端**调用记录**（本机事件日志里的 node_request 两类事件聚合而来）。纯本地读，不触网。
  ipcMain.handle('nodes:requests', () => {
    try {
      const records: NodeCallRecord[] = listNodeCallRecords(db as unknown as Parameters<typeof listNodeCallRecords>[0]);
      return { data: { records } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261010_1 M2（维特根斯坦·意义即使用）: 「加入协同网络」的**动作**。此前只有启动期一次注册，
  //   且 `node.enrollment_token` 无任何写口 ⇒ 干净 clone 实质不可加入（上一轮 §5 挂账）。
  //   此口就地：可选先写令牌 ⇒ **复用** `enrollWithToken`（= `ensureNodeEnrolled`，全仓唯一注册实现）
  //   ⇒ 注册成功则 `startNodeRuntime()`（M3 起心跳/中转，**免重启**）+ 广播 `node.presence_changed`。
  //   Team 软闸与 `nodes:update` 同源（未解锁即不触 ANS、不注册）。
  // zx_20261011 M8（追加批）: 可选 `name`——注册**前**先写本地 `node.name`（`ensureNodeIdentity` 之后读它、
  //   `node-heartbeat` 注册上送它）⇒ 首注册即带用户取的名，而非默认 hostname（两实例同机时的同名病根）。
  ipcMain.handle('nodes:enroll', async (_event, { token, name }: { token?: string; name?: string } = {}) => {
    try {
      const refusal = teamFeatureRefusal(licDb, 'multi_node');
      if (refusal) return { error: { code: 'TEAM_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'team' }) } };
      // zx_20261023_1「称」: 节点数上限——只拦**新入网**（已在网的本机重入不受影响，免得满员后重装都进不来）。
      //   台账读不到 ⇒ fail-open + 如实注（不把「没读到」当「没满」悄悄放过）。
      let quotaNote = '';
      if (!isNodeEnrolled(settingDb)) {
        const localNodeId = ensureNodeIdentity(settingDb).id;
        const check = nodeQuotaCheck(resolveLicenseTier(licDb), await fetchNodes(db, localNodeId));
        if (check.refusal) {
          return { error: { code: 'NODE_LIMIT', message: refusalWithContext(db, check.refusal, { requiredTier: 'team' }) } };
        }
        quotaNote = check.note ?? '';
      }
      const trimmedName = typeof name === 'string' ? name.trim() : '';
      if (trimmedName) writeNodeSetting(settingDb, NODE_SETTING_KEYS.name, trimmedName);
      const trimmed = typeof token === 'string' ? token.trim() : '';
      if (trimmed && !writeEnrollmentToken(settingDb, trimmed)) {
        return { data: { enrolled: false, nodeId: ensureNodeIdentity(settingDb).id, resourceGroup: null, started: false, note: '令牌写入本地设置失败（查 wa_settings 写权限）' } };
      }
      const res = await enrollWithToken(settingDb, { timeoutMs: 10_000 });
      const enrolled = res.enrolled || isNodeEnrolled(settingDb);
      // 已在本机注册 ⇒ 起心跳/中转（幂等；已在跑即直接 true）。未注册则如实记 false，不起空循环。
      const started = enrolled ? await startNodeRuntime() : false;
      if (enrolled) void eventBus.emit('node.presence_changed', { nodeId: res.nodeId, node: { node_id: res.nodeId, resource_group: res.resourceGroup ?? null } });
      return { data: { enrolled, nodeId: res.nodeId, resourceGroup: res.resourceGroup ?? null, started, note: [enrollReasonNote(res.reason), quotaNote].filter(Boolean).join('；') } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261010_1 M2: 用本机既有 ANS 凭据向 ANS **申请**一枚注册令牌并**写回** settings
  //   （`requestEnrollmentToken` 内部已完成落库）。**不回传全令牌**——面板无需展示，注册随即用它。
  //   签令牌 ≠ 注册：拿到令牌后仍须走 `nodes:enroll` 才算入网（两件事各留各的痕）。
  ipcMain.handle('nodes:request-token', async () => {
    try {
      const refusal = teamFeatureRefusal(licDb, 'multi_node');
      if (refusal) return { error: { code: 'TEAM_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'team' }) } };
      const r = await requestEnrollmentToken(settingDb, { timeoutMs: 10_000 });
      return { data: { ok: r.ok, note: r.note } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261010_1 M2: 本机**入网态**读口——入职卡据 `enrolled`（判据与 `isNodeEnrolled` 同源）决定显不显示。
  //   纯本地读（不触 ANS、不设 Team 闸）：判断"我入网没"不该要许可；且面板只在解锁分支里调它。
  ipcMain.handle('nodes:enroll-state', () => {
    try {
      const nodeId = ensureNodeIdentity(settingDb).id;
      // zx_20261011 M8（追加批）: 一并回传本机当前 `name`——入职卡据此**预填**「节点名称」输入框。
      // zx_20261012: 并回传未入网**首因**（`nodeEnrollmentReason`，与 `isNodeEnrolled` 同源）——入职卡说人话。
      return { data: { enrolled: isNodeEnrolled(settingDb), hasToken: readEnrollmentToken(settingDb) !== null, nodeId, name: readNodeSetting(settingDb, NODE_SETTING_KEYS.name) ?? '', reason: nodeEnrollmentReason(settingDb) } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261011_4 M4: 编排模式**读口**——本机设置 `node.orchestrate_mode`（`off`/`auto`）。
  //   词表随读一并回传（渲染层据它摆选项，不手抄 `off`/`auto`）；纯本地读，不触 ANS、不设 Team 闸
  //   （与 `nodes:enroll-state` 同形：读本机设置不该要许可；实际外派另在编排器内经 Team 闸）。
  ipcMain.handle('nodes:orchestrate-mode', () => {
    try {
      return { data: { mode: readOrchestrateMode(settingDb), modes: ORCHESTRATE_MODES } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261011_4 M4: 编排模式**写口**——非法值如实拒（`INVALID`），写失败如实报（不静默吞）。
  //   成功 ⇒ `broadcastSetting` 热更（承 `settings:changed` 同形，免重启）。
  ipcMain.handle('nodes:set-orchestrate-mode', (_event, { mode }: { mode: string }) => {
    try {
      if (!isOrchestrateMode(mode)) return { error: { code: 'INVALID', message: `未知编排模式：${String(mode)}` } };
      if (!writeNodeSetting(settingDb, NODE_SETTING_KEYS.orchestrateMode, mode)) {
        return { error: { code: 'INTERNAL', message: '写入编排模式设置失败（查 wa_settings 写权限）' } };
      }
      broadcastSetting(NODE_SETTING_KEYS.orchestrateMode, mode);
      return { data: { mode } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261017_1 批三: 建单即派**读口**——开关状态（缺省关）+ 最近一次自动外派（审计账 `requireTarget=1` 投影）。
  //   纯本地读，不触 ANS、不设 Team 闸（同 `nodes:orchestrate-mode`：读本机设置不该要许可）。
  ipcMain.handle('nodes:auto-dispatch', () => {
    try {
      // `prompted`：一次性引导是否已问过（GUI 据此决定首次入网后弹不弹；与写口同一读源）。
      return { data: { enabled: isAutoDispatchOn(settingDb), prompted: isAutoDispatchPrompted(settingDb), last: lastAutoDispatch(db) } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261023_5 批一: 协同面板三分组（可派 / 等待依赖 / 上游已死）——纯本地读，不触 ANS。
  //   判据与真派同一把尺（`decideCreateDispatch`），面板看见的"能派"就是真的能派。
  ipcMain.handle('nodes:dispatch-board', () => {
    try {
      return { data: dispatchBoard(db) };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // 写口：只认**显式布尔**（`'1'`/`'0'`）；写失败如实报，成功广播热更。
  ipcMain.handle('nodes:set-auto-dispatch', (_event, { enabled }: { enabled?: unknown }) => {
    try {
      if (typeof enabled !== 'boolean') return { error: { code: 'INVALID', message: '参数 enabled 须为布尔值' } };
      const value = enabled ? '1' : '0';
      if (!writeNodeSetting(settingDb, NODE_SETTING_KEYS.autoDispatchOnCreate, value)) {
        return { error: { code: 'INTERNAL', message: '写入建单即派设置失败（查 wa_settings 写权限）' } };
      }
      broadcastSetting(NODE_SETTING_KEYS.autoDispatchOnCreate, value);
      return { data: { enabled } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261018_1 批一: 首次入网的**一次性引导**落点（应/不应）——Team 闸在 core 一处判（`applyAutoDispatchOnboarding`）。
  //   ⚠ 与 `nodes:set-auto-dispatch` **不是**同一件事：后者是用户在设置里随时改开关；本口是"首次引导的那一次回答"，
  //     附带"已问过"标记（拒绝也算回答，不再打扰）。
  ipcMain.handle('nodes:confirm-auto-dispatch', (_event, { accept }: { accept?: unknown }) => {
    try {
      if (typeof accept !== 'boolean') return { error: { code: 'INVALID', message: '参数 accept 须为布尔值' } };
      const r = applyAutoDispatchOnboarding(db as unknown as NodeSettingDb & LicenseSettingDb, accept);
      if (!r.ok) {
        const refusal = teamFeatureRefusal(licDb, 'multi_node');
        return refusal
          ? { error: { code: 'TEAM_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'team' }) } }
          : { error: { code: 'INTERNAL', message: '写入建单即派设置失败（查 wa_settings 写权限）' } };
      }
      broadcastSetting(NODE_SETTING_KEYS.autoDispatchOnCreate, r.enabled ? '1' : '0');
      return { data: { enabled: r.enabled, prompted: r.prompted } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261011 M4（「派活」的**写口**）: 把一单活派给网络里的某台工蚁（自动选 / 手动指定目标）。
  //   过 Team 软闸（与 `nodes:update`/`nodes:enroll` 同源）——真源在 ANS（`POST /requests`）。
  //   成功 ⇒ 广播 `node.presence_changed` 供面板复取（出站台账另由 `node.request_dispatched` 事件驱动重取）。
  //   未入网 ⇒ core 如实回 `not-enrolled`（没有身份就没有读回凭据），此处不编假成功。
  ipcMain.handle('nodes:dispatch', async (_event, { category, payload, targetNodeId }:
    { category: string; payload?: Record<string, unknown>; targetNodeId?: string }) => {
    try {
      const refusal = teamFeatureRefusal(licDb, 'multi_node');
      if (refusal) return { error: { code: 'TEAM_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'team' }) } };
      const result = await dispatchNodeRequest(db, {
        category,
        ...(payload !== undefined ? { payload } : {}),
        ...(targetNodeId !== undefined && targetNodeId !== '' ? { targetNodeId } : {}),
      });
      if (result.ok) void eventBus.emit('node.presence_changed', { nodeId: result.targetNodeId ?? '', dispatched: true });
      return { data: result };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261011 M4: 本机**派出去**的活（出站台账）。纯本地读（`wa_event_log` 聚合），**不过闸**——
  //   与既有 `nodes:requests` 同形：读本地台账不该因档位抛。
  ipcMain.handle('nodes:dispatches', () => {
    try {
      const records: NodeDispatchRecord[] = listNodeDispatchRecords(db as unknown as Parameters<typeof listNodeDispatchRecords>[0]);
      return { data: { records } };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261011 M4: 读回某单的**最新态**（ANS 侧按请求方身份鉴权）。终态时 core 如实落收口事件（台账右半，幂等）。
  //   **读口不过闸**（承 `zx_20261010_1` §5.4-1 的偏离理由：读自己派出去的东西不该因档位抛；且此 id
  //   只能由"已过闸成功的派发"取得）。
  ipcMain.handle('nodes:dispatch-result', async (_event, { id }: { id: string }) => {
    try {
      const r = await refreshDispatchResult(db, id);
      return { data: r };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });

  // zx_20261011_1 M4（双向澄清）: 派活方**作答**被派方的一问（**写口**，过 Team 软闸——同 `nodes:dispatch`）。
  //   作答应答对"我派的那一单"，故与派发同闸；core 未入网 ⇒ 如实回 `not-enrolled`（此处不编假成功）。
  ipcMain.handle('nodes:answer-question', async (_event, { id, answer }: { id: string; answer: string }) => {
    try {
      const refusal = teamFeatureRefusal(licDb, 'multi_node');
      if (refusal) return { error: { code: 'TEAM_REQUIRED', message: refusalWithContext(db, refusal, { requiredTier: 'team' }) } };
      const r = await answerQuestion(db, { id, answer });
      return { data: r };
    } catch (e) {
      return { error: { code: 'INTERNAL', message: (e as Error)?.message || String(e) } };
    }
  });
}
