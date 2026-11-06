/**
 * zx_20261106_3 B8「协」（维特根斯坦·意义即使用 / 毛选·没有调查没有发言权）:
 * **项目协同看板**——回答「谁在跑哪件、为何选它、进度到哪、改派过几次」。
 *
 * 数据全部来自既有 IPC，不另算第二套：
 *   · `project:node_policy_get`  参与者/项目角色/项目权重/在线（与 NodeDivisionCard 同源）
 *   · `project:dispatch_mode_get` 生效模式与人话理由
 *   · `nodes:cluster`            节点名（取不到名回落 nodeId 前 8 位，不编）
 *   · `nodes:dispatches`         出站台账（状态/进度/ANS 择机快照）
 *   · `task:list`                本项目任务的 `context_digest`（外派三键 + 改派账）
 *
 * 三条纪律：
 *  ① 进度只认新鲜 `at`（共享阈值 `REMOTE_PROGRESS_STALE_SEC`）——超时标「可能失联」，停更不装活；
 *  ② 派单理由/改派理由缺记 ⇒ 如实说「未记录」，不拿旧理由说新派发；
 *  ③ 锁档时如实列出协同能力归属，不把「看不了」说成「没有」。
 */
import { useCallback, useEffect, useState } from 'react';
import { Activity, ArrowRightLeft, Network, RefreshCw } from 'lucide-react';
import {
  nodes,
  projects,
  tasks,
  type NodesClusterPayload,
  type ProjectDispatchModePayload,
  type ProjectNodePolicyPayload,
} from '../lib/ipc';
import type { NodeDispatchRecord } from '../../../src/main/core/node-dispatch-log.js';
import { remoteProgressView } from '../lib/node-view';
import { TASK_STATUS_LABEL, statusText } from '../lib/status-view';

interface AttemptRow {
  nodeId: string;
  requestId: string;
  at: string;
  result: string;
  reason?: string;
}

function parseDigest(row: Record<string, unknown>): Record<string, unknown> {
  try {
    const v = JSON.parse(String(row.context_digest ?? '{}'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 尝试账的人话结局（值域见 `node-orchestrate.ts` 的 `RemoteAttempt.result`）。 */
function attemptResultWord(result: string): string {
  const map: Record<string, string> = {
    dispatched: '已派出',
    done: '已完成',
    failed: '失败',
    cancelled: '已停止',
    timeout: '超时',
    reclaimed: '已收回（无人认领）',
  };
  return map[result] ?? result;
}

function attemptsOf(digest: Record<string, unknown>): AttemptRow[] {
  const raw = digest.remote_attempts;
  if (!Array.isArray(raw)) return [];
  const out: AttemptRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const nodeId = str(o.nodeId);
    const requestId = str(o.requestId);
    if (!nodeId && !requestId) continue;
    out.push({
      nodeId,
      requestId,
      at: str(o.at),
      result: str(o.result) || 'dispatched',
      ...(str(o.reason) ? { reason: str(o.reason) } : {}),
    });
  }
  return out;
}

function fmtAt(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : iso;
}

export default function CollabBoardCard({ projectId }: { projectId: string }) {
  const [mode, setMode] = useState<ProjectDispatchModePayload | null>(null);
  const [policy, setPolicy] = useState<ProjectNodePolicyPayload | null>(null);
  const [cluster, setCluster] = useState<NodesClusterPayload | null>(null);
  const [dispatches, setDispatches] = useState<NodeDispatchRecord[]>([]);
  const [taskRows, setTaskRows] = useState<Array<Record<string, unknown>>>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [first, setFirst] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    const errs: string[] = [];
    const msg = (e: unknown) => (e as Error)?.message || String(e);
    const [modeR, policyR, clusterR, dispR, taskR] = await Promise.all([
      projects.dispatchMode.get(projectId).catch((e) => { errs.push(`派发模式：${msg(e)}`); return null; }),
      projects.nodePolicy.get(projectId).catch((e) => { errs.push(`节点分工：${msg(e)}`); return null; }),
      nodes.cluster().catch((e) => { errs.push(`集群读数：${msg(e)}`); return null; }),
      nodes.dispatches().catch((e) => { errs.push(`出站台账：${msg(e)}`); return null; }),
      tasks.listAll(projectId).catch((e) => { errs.push(`任务列表：${msg(e)}`); return [] as Array<Record<string, unknown>>; }),
    ]);
    setMode(modeR);
    setPolicy(policyR);
    setCluster(clusterR);
    setDispatches(dispR?.records ?? []);
    setTaskRows(Array.isArray(taskR) ? taskR : []);
    setErrors(errs);
    setBusy(false);
    setFirst(false);
  }, [projectId]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => { void load(); }, 15_000);
    return () => window.clearInterval(t);
  }, [load]);

  if (!projectId) return null;

  const gate = policy?.gate ?? cluster?.gate ?? null;
  const locked = gate != null && !gate.unlocked;
  const localId = policy?.local_node_id ?? '';
  const rows = policy?.rows ?? [];
  const roleLabel = (role: string) => policy?.role_options.find((o) => o.value === role)?.label ?? role;

  const nameOf = (nodeId: string): string =>
    (cluster?.nodes.find((n) => n.id === nodeId)?.name ?? '').trim() || nodeId.slice(0, 8);

  // 参与者（排除本机——本机永不入派发候选）：项目退出/观察者都不承接。
  const participating = rows.filter((r) => r.node_id !== localId && r.participate && r.role !== 'observer');
  const standingDown = rows.filter((r) => r.node_id !== localId && (!r.participate || r.role === 'observer'));
  const onlineOfParticipating = participating.filter((r) => r.online).length;

  const recordOf = new Map(dispatches.map((r) => [r.requestId, r]));
  const now = Date.now();

  // 当前在跑：有外派请求号且台账未收口（台账读不到时退回「没有回传时刻」这一判据）。
  const running = taskRows.filter((row) => {
    const d = parseDigest(row);
    const reqId = str(d.assigned_request_id);
    if (!reqId) return false;
    const rec = recordOf.get(reqId);
    if (rec) return rec.status === 'pending';
    return !str(d.remote_result_at);
  });

  // 改派账：有尝试记录的任务（含首派失败后未再派的情形——它同样回答了「为何没在跑」）。
  const attemptRows = taskRows
    .map((row) => ({ row, attempts: attemptsOf(parseDigest(row)) }))
    .filter((x) => x.attempts.length > 0)
    .slice(0, 5);

  const modeLine = mode
    ? `生效：${mode.options.find((o) => o.value === mode.resolved.mode)?.label ?? mode.resolved.mode} · ${mode.resolved.reason}`
    : null;

  return (
    <div className="mt-3 bg-white rounded-lg border p-4">
      <div className="flex items-center justify-between mb-2 gap-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5 text-gray-700">
          <Network className="w-4 h-4 text-indigo-500" />协同看板
          <span className="text-[10px] font-normal px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
            团队版旗舰
          </span>
        </h3>
        <button type="button" onClick={() => void load()} title="刷新" className="p-1 rounded hover:bg-gray-100">
          <RefreshCw className={`w-3.5 h-3.5 text-gray-400 ${busy ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {locked ? (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2">
          <div className="text-xs font-medium text-indigo-800 mb-0.5">「多机协同」是团队版旗舰能力</div>
          <div className="text-[11px] text-indigo-700">{gate?.detail}</div>
          <div className="text-[11px] text-indigo-700 mt-1">
            专业版仍为单机（并发与项目照常，不跨机派活）；团队授权包覆盖最多 20 台协同节点。
          </div>
        </div>
      ) : first ? (
        <p className="text-xs text-gray-400 py-2">读取协同状态…</p>
      ) : (
        <>
          {errors.length > 0 && (
            <div className="mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
              部分数据读不到：{errors.join('；')}
            </div>
          )}
          {modeLine && <p className="text-[11px] text-gray-500 mb-2">{modeLine}</p>}

          <div className="rounded bg-gray-50 px-2.5 py-2 mb-2">
            <div className="flex items-center gap-1.5 text-xs text-gray-700">
              <Activity className="w-3.5 h-3.5 text-gray-400" />
              <span className="font-medium">参与者</span>
              <span className="text-gray-400">
                {participating.length === 0 ? '—' : `${onlineOfParticipating}/${participating.length} 在线`}
              </span>
            </div>
            {participating.length === 0 ? (
              <p className="mt-1 text-[11px] text-gray-500">
                {rows.length === 0
                  ? '台账里还没有其他节点——当前为本机单机运行。'
                  : '尚未登记参与分工——交给 ANS 按余力自动选；本项目如有在线对端，仍可能被溢出派活。'}
              </p>
            ) : (
              <div className="mt-1 flex items-center gap-1 flex-wrap">
                {participating.map((r) => (
                  <span
                    key={r.node_id}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-white border border-gray-200 text-gray-700"
                    title={`${r.name || r.node_id}（${r.node_id}）`}
                  >
                    <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${r.online ? 'bg-green-500' : 'bg-gray-300'}`} />
                    {r.name || r.node_id.slice(0, 8)}
                    {r.role ? ` · ${roleLabel(r.role)}` : ''}
                    {` · 权重 ${r.weight}`}
                  </span>
                ))}
              </div>
            )}
            {standingDown.length > 0 && (
              <p className="mt-1 text-[10px] text-gray-400">
                不承接：{standingDown.map((r) => r.name || r.node_id.slice(0, 8)).join(' / ')}
                （本项目退出或项目角色为观察者）
              </p>
            )}
          </div>

          <div className="mb-2">
            <div className="text-xs font-medium text-gray-700 mb-1">当前跨机任务（{running.length}）</div>
            {running.length === 0 ? (
              <p className="text-[11px] text-gray-500">本项目此刻没有跨机在跑的任务。</p>
            ) : (
              <div className="space-y-1.5">
                {running.map((row) => {
                  const d = parseDigest(row);
                  const reqId = str(d.assigned_request_id);
                  const nodeId = str(d.assigned_node_id);
                  const rec = recordOf.get(reqId);
                  const progress = remoteProgressView(rec?.progress ?? null, now);
                  const attempts = attemptsOf(d);
                  const last = attempts[attempts.length - 1];
                  const ansReason = rec?.selection && typeof rec.selection.reason === 'string'
                    ? rec.selection.reason.trim()
                    : '';
                  const reason = last?.reason || ansReason;
                  const status = rec?.status ?? 'pending';
                  return (
                    <div key={String(row.id)} className="rounded border border-gray-200 px-2 py-1.5 text-[11px]">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-gray-800 font-medium truncate max-w-[22rem]" title={String(row.title ?? '')}>
                          {String(row.title ?? '')}
                        </span>
                        <span className="text-gray-500">→ {nameOf(nodeId)}</span>
                        <span className="text-gray-400">{statusText(TASK_STATUS_LABEL, String(row.status ?? ''))}</span>
                        <span className="ml-auto font-mono text-gray-400">码 {reqId.slice(0, 8)}</span>
                      </div>
                      <div className="mt-0.5 text-gray-500">
                        {progress
                          ? (
                            <>
                              {progress.stepText}
                              {progress.note ? ` · ${progress.note}` : ''}
                              <span className={progress.stale ? ' text-amber-700' : ' text-gray-400'}>
                                {' · '}{progress.ago}前{progress.stale ? '（可能失联）' : ''}
                              </span>
                            </>
                          )
                          : '对方尚未上报进度'}
                      </div>
                      <div className="mt-0.5 text-gray-500">
                        {reason ? `派单理由：${reason}` : '派单理由未记录'}
                        {rec?.dispatchedAt ? ` · 派出于 ${fmtAt(rec.dispatchedAt)}` : ''}
                        {status !== 'pending' ? ` · 台账状态 ${status}` : ''}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center gap-1.5 text-xs font-medium text-gray-700 mb-1">
              <ArrowRightLeft className="w-3.5 h-3.5 text-gray-400" />改派与结局
            </div>
            {attemptRows.length === 0 ? (
              <p className="text-[11px] text-gray-500">本项目还没有跨机派发记录。</p>
            ) : (
              <div className="space-y-1.5">
                {attemptRows.map(({ row, attempts }) => (
                  <div key={String(row.id)} className="rounded bg-gray-50 px-2 py-1.5 text-[11px]">
                    <div className="text-gray-700 truncate" title={String(row.title ?? '')}>
                      {String(row.title ?? '')}
                      <span className="ml-1 text-gray-400">（{statusText(TASK_STATUS_LABEL, String(row.status ?? ''))}）</span>
                    </div>
                    <ol className="mt-0.5 space-y-0.5">
                      {attempts.map((a, i) => (
                        <li key={`${a.requestId}-${i}`} className="text-gray-500">
                          {i + 1}. → {nameOf(a.nodeId)} · {attemptResultWord(a.result)}
                          {a.reason ? ` · ${a.reason}` : ''}
                          <span className="text-gray-400"> · {fmtAt(a.at)}</span>
                          <span className="font-mono text-gray-400"> · 码 {a.requestId.slice(0, 8)}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
