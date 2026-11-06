/**
 * zx_20261104_3 M3「联」（维特根斯坦·意义即使用 / 道德经·不出户知天下）:
 * **授权台一屏**——待接入终端 / 待授权设备 / 待答跨机问题，就地办完，不必翻三页。
 *
 * 三条纪律：
 *  ① **看得见 ≠ 办得到**：锁档时仍如实列出待办（"有事等我"是事实），只在动作旁给升级说明——
 *     与主进程写口各自的 Team 闸同一判据（页面不自行推导档位）。
 *  ② **短码原样上屏**：终端核对码 / 设备码 / 单号短码都可直接复制，与 IM「授权待办」互认。
 *  ③ **数据同源**：`approval:inbox` 与 IM 授权台同一份 `buildApprovalInbox`；事件驱动刷新 + 15s 兜底。
 */
import { useEffect, useState } from 'react';
import { Inbox, RefreshCw, ShieldAlert } from 'lucide-react';
import {
  approvalApi,
  external,
  devices,
  nodes,
  type ApprovalActionGate,
} from '../lib/ipc';
import { useLiveQuery } from '../lib/useLiveQuery';
import { APPROVAL_LIVE_TYPES, APPROVAL_POLL_MS } from '../lib/approval-live';
import type { PendingTerminalPublic } from '../../../src/main/core/external-terminals.js';
import type { AnsDevice } from '../../../src/main/core/device-registry.js';
import type { NodeDispatchRecord } from '../../../src/main/core/node-dispatch-log.js';

function terminalName(t: PendingTerminalPublic): string {
  return t.name?.trim() || t.id.slice(0, 8);
}

function deviceName(d: AnsDevice): string {
  return d.alias || d.name || d.id.slice(0, 8);
}

function GateNote({ gate }: { gate: ApprovalActionGate }) {
  if (gate.unlocked) return null;
  return (
    <p className="mt-1 flex items-start gap-1 text-[11px] text-indigo-700">
      <ShieldAlert className="w-3 h-3 mt-0.5 shrink-0" />
      <span>{gate.detail}</span>
    </p>
  );
}

function SectionTitle({ label, count }: { label: string; count: number }) {
  return <h3 className="text-sm font-semibold text-gray-700 mb-2">{label}（{count}）</h3>;
}

export default function InboxPage() {
  const q = useLiveQuery(() => approvalApi.inbox(), [], {
    liveTypes: APPROVAL_LIVE_TYPES,
    debounceMs: 700,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  // 兜底轮询：漏事件 / 崩溃恢复后最迟 15s 对齐（与页面同源，不另算计数）。
  useEffect(() => {
    const t = window.setInterval(() => { void q.reload(); }, APPROVAL_POLL_MS);
    return () => window.clearInterval(t);
  }, [q.reload]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      await q.reload();
    } catch (e) {
      setErr((e as Error)?.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  const data = q.data;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Inbox className="w-5 h-5 text-indigo-600" />
          <h2 className="text-xl font-bold">授权台</h2>
          {data && <span className="text-xs text-gray-500">待办 {data.counts.total} 件</span>}
        </div>
        <button onClick={() => void q.reload()} className="p-2 hover:bg-gray-100 rounded-lg" title="刷新">
          <RefreshCw className={`w-4 h-4 ${q.loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {err && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>
      )}
      {q.error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          读不到授权台：{q.error}
        </div>
      )}
      {q.loading && data == null && (
        <div className="flex justify-center py-12">
          <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" />
        </div>
      )}

      {data && (
        <div className="space-y-6">
          {/* ── 待接入终端 ─────────────────────────────────────── */}
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <SectionTitle label="待接入终端" count={data.counts.terminals} />
            <GateNote gate={data.gates.terminals} />
            {data.counts.terminals === 0 ? (
              <p className="text-xs text-gray-500 mt-1">没有待接入的终端。</p>
            ) : (
              <div className="mt-2 space-y-2">
                {data.terminals.map((t) => {
                  const sourceLabel = t.source === 'lan' ? '局域网发现' : t.source === 'discovery' ? 'A2A 地址发现' : '';
                  const where = [t.last_remote_addr, sourceLabel].filter((x) => x && x.trim() !== '').join(' / ');
                  return (
                    <div key={t.id} className="flex items-center gap-2 text-xs py-1.5 px-2 rounded bg-gray-50">
                      <span className="flex-1 min-w-0 truncate text-gray-800" title={t.name}>
                        「{terminalName(t)}」{where ? <span className="text-gray-500">（{where}）</span> : null}
                        <span className="ml-2 text-gray-500 font-mono">核对码 {t.pair_code}</span>
                      </span>
                      <button
                        type="button"
                        disabled={busy !== null || !data.gates.terminals.unlocked}
                        title={data.gates.terminals.unlocked ? '批准接入（凭据只回终端一次）' : data.gates.terminals.detail}
                        onClick={() => void act(`approve:${t.id}`, () => external.approve(t.id))}
                        className="shrink-0 text-[10px] px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded hover:bg-emerald-200 disabled:opacity-40"
                      >
                        同意接入
                      </button>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void act(`reject:${t.id}`, () => external.reject(t.id))}
                        className="shrink-0 text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded hover:bg-gray-200 disabled:opacity-40"
                      >
                        拒绝接入
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ── 待授权设备 ─────────────────────────────────────── */}
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <SectionTitle label="待授权设备" count={data.counts.devices} />
            <GateNote gate={data.gates.devices} />
            {data.counts.devices === 0 ? (
              <p className="text-xs text-gray-500 mt-1">没有待授权的设备。</p>
            ) : (
              <div className="mt-2 space-y-2">
                {data.devices.map((d) => {
                  const extra = [d.room, d.kind_class || d.kind].filter((x) => x && x.trim() !== '').join(' / ');
                  return (
                    <div key={d.id} className="flex items-center gap-2 text-xs py-1.5 px-2 rounded bg-gray-50">
                      <span className="flex-1 min-w-0 truncate text-gray-800" title={d.name}>
                        「{deviceName(d)}」{extra ? <span className="text-gray-500">（{extra}）</span> : null}
                        <span className="ml-2 text-gray-400 font-mono">码 {d.id.slice(0, 8)}</span>
                      </span>
                      <button
                        type="button"
                        disabled={busy !== null || !data.gates.devices.unlocked}
                        title={data.gates.devices.unlocked ? '允许控制' : data.gates.devices.detail}
                        onClick={() => void act(`allow:${d.id}`, () => devices.authorize(d.id, true))}
                        className="shrink-0 text-[10px] px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded hover:bg-emerald-200 disabled:opacity-40"
                      >
                        允许控制
                      </button>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void act(`deny:${d.id}`, () => devices.authorize(d.id, false))}
                        className="shrink-0 text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded hover:bg-gray-200 disabled:opacity-40"
                      >
                        保持只读
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ── 待答跨机问题 ───────────────────────────────────── */}
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <SectionTitle label="待答跨机问题" count={data.counts.questions} />
            <GateNote gate={data.gates.questions} />
            {data.counts.questions === 0 ? (
              <p className="text-xs text-gray-500 mt-1">没有待答的跨机问题。</p>
            ) : (
              <div className="mt-2 space-y-3">
                {data.questions.map((r: NodeDispatchRecord) => {
                  const options = r.question?.options ?? [];
                  return (
                    <div key={r.requestId} className="rounded bg-gray-50 px-2 py-1.5">
                      <div className="text-xs text-gray-800 break-words">
                        <span className="text-gray-500 mr-1">码 {r.requestId.slice(0, 8)} · {r.category || '跨机任务'}{r.targetNodeId ? ` · ${r.targetNodeId.slice(0, 8)}` : ''}</span>
                        <div className="mt-0.5">{r.question?.question}</div>
                        {options.length > 0 && (
                          <div className="mt-0.5 text-gray-500">可选：{options.join(' / ')}</div>
                        )}
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <input
                          value={answers[r.requestId] ?? ''}
                          onChange={(e) => setAnswers((p) => ({ ...p, [r.requestId]: e.target.value }))}
                          placeholder="输入答案…"
                          className="flex-1 min-w-0 text-xs border border-gray-300 rounded px-2 py-1"
                        />
                        <button
                          type="button"
                          disabled={busy !== null || !data.gates.questions.unlocked || !(answers[r.requestId] ?? '').trim()}
                          title={data.gates.questions.unlocked ? '发回答应' : data.gates.questions.detail}
                          onClick={() => void act(`answer:${r.requestId}`, async () => {
                            await nodes.answerQuestion(r.requestId, (answers[r.requestId] ?? '').trim());
                            setAnswers((p) => { const next = { ...p }; delete next[r.requestId]; return next; });
                          })}
                          className="shrink-0 text-[10px] px-2 py-1 bg-blue-100 text-blue-700 rounded hover:bg-blue-200 disabled:opacity-40"
                        >
                          回答
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <p className="text-[11px] text-gray-400">
            {'同一份待办也支持在 IM 私聊里办：回复「授权待办」查看，「同意接入 <核对码>」/「允许设备 <码>」/「回答 <码> <答案>」。'}
          </p>
        </div>
      )}
    </div>
  );
}
