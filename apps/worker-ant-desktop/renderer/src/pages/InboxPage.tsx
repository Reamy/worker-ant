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
  knowledge as knowledgeApi,
  packs,
  positions as positionsApi,
  admin,
  type ApprovalActionGate,
} from '../lib/ipc';
// zx_20261121_3 M3「用·门」：知识待办的形状取 main 真源（仅类型，打包期擦除）。
import type { InboxGroup, KnowledgeInbox } from '../../../src/main/core/knowledge-inbox.js';
import { useLiveQuery } from '../lib/useLiveQuery';
import { Button } from '../components/ui';
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
    <p className="mt-1 flex items-start gap-1 text-[11px] text-accent">
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

  // zx_20261121_3 M3「用·门」：知识待办（经验 / 技能 / 领域包 / 提案）——只读读模型，决定走既有写口。
  const kq = useLiveQuery(() => knowledgeApi.inbox(50), [], {
    liveTypes: ['knowledge.changed'],
    debounceMs: 700,
  });
  const [kbusy, setKbusy] = useState<string | null>(null);
  const [kerr, setKerr] = useState<string | null>(null);
  const [selectedLessons, setSelectedLessons] = useState<Set<string>>(new Set());
  const [packTargets, setPackTargets] = useState<Record<string, string>>({});

  // 兜底轮询：漏事件 / 崩溃恢复后最迟 15s 对齐（与页面同源，不另算计数）。
  useEffect(() => {
    const t = window.setInterval(() => { void q.reload(); void kq.reload(); }, APPROVAL_POLL_MS);
    return () => window.clearInterval(t);
  }, [q.reload, kq.reload]);

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

  /** 知识动作：成功刷新两份账（授权台 + 知识待办）；失败如实上屏，不乐观移除。 */
  async function kact(key: string, fn: () => Promise<unknown>) {
    setKbusy(key);
    setKerr(null);
    try {
      await fn();
      await Promise.all([q.reload(), kq.reload()]);
    } catch (e) {
      setKerr((e as Error)?.message || String(e));
    } finally {
      setKbusy(null);
    }
  }

  /** 勾选批量采纳：只对勾选项生效；逐条走既有写口，失败的逐条列出（不静默）。 */
  async function acceptSelectedLessons() {
    const ids = [...selectedLessons];
    if (ids.length === 0) return;
    if (!window.confirm(`采纳选中的 ${ids.length} 条岗位经验？采纳后才会用于后续任务。`)) return;
    setKbusy('lessons-batch');
    setKerr(null);
    const failed: string[] = [];
    for (const id of ids) {
      try { await positionsApi.decideLesson(id, 'accepted'); }
      catch (e) { failed.push(`${id.slice(0, 8)}：${(e as Error)?.message || String(e)}`); }
    }
    setSelectedLessons(new Set());
    await Promise.all([q.reload(), kq.reload()]);
    if (failed.length > 0) setKerr(`部分未采纳：${failed.join('；')}`);
    setKbusy(null);
  }

  const data = q.data;
  const ki: KnowledgeInbox | null = kq.data;
  const groupCount = (g: InboxGroup<unknown> | undefined): number => (g?.status === 'ok' ? g.count : 0);
  const knowledgeTotal = ki ? groupCount(ki.lessons) + groupCount(ki.skills) + groupCount(ki.packs) + groupCount(ki.proposals) : 0;
  const knowledgeError = ki ? [ki.lessons, ki.skills, ki.packs, ki.proposals].some((g) => g.status === 'error') : false;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Inbox className="w-5 h-5 text-accent" />
          <h2 className="text-xl font-bold">待办</h2>
          {data && <span className="text-xs text-gray-500">授权 {data.counts.total} 件{ki ? ` · 知识 ${knowledgeTotal} 条` : ''}</span>}
          <span className="text-xs text-gray-400 hidden sm:inline">授权与知识，都在这一屏办完</span>
        </div>
        <Button variant="ghost" size="sm" aria-label="刷新" onClick={() => { void q.reload(); void kq.reload(); }}
          icon={<RefreshCw className={`w-4 h-4 ${q.loading ? 'animate-spin' : ''}`} />}>
          刷新
        </Button>
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
          <div className="animate-spin h-8 w-8 border-2 border-accent border-t-transparent rounded-full" />
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
                          className="shrink-0 text-[10px] px-2 py-1 bg-accent-soft text-accent rounded hover:bg-accent-soft disabled:opacity-40"
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

          {/* ── 知识待办（zx_20261121_3 M3）─────────────────────── */}
          <section id="knowledge" className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="flex items-center justify-between gap-2">
              <SectionTitle label="知识待办" count={knowledgeTotal} />
              {kq.loading && <span className="text-[11px] text-gray-400">刷新中…</span>}
            </div>
            <p className="-mt-1 mb-2 text-[11px] text-gray-500">
              已学到的东西不会自动生效：采纳 / 启用 / 批准之后才会用于后续任务。
            </p>
            {kerr && <div className="mb-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">{kerr}</div>}
            {knowledgeError && <div className="mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">知识待办有一组读取失败——下方如实标出，不当作「没有」。</div>}
            {!ki ? (
              <p className="text-xs text-gray-500">{kq.error ? `读不到知识待办：${kq.error}` : '知识待办载入中…'}</p>
            ) : (
              <div className="space-y-4">
                {/* ① 待审岗位经验 */}
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="text-xs font-semibold text-gray-700">待审岗位经验（{groupCount(ki.lessons)}）</h4>
                    {ki.lessons.status === 'ok' && selectedLessons.size > 0 && (
                      <button type="button" disabled={kbusy !== null} onClick={() => void acceptSelectedLessons()}
                        className="ml-auto text-[10px] px-2 py-0.5 rounded bg-accent text-paper hover:bg-accent/90 disabled:opacity-50">
                        {kbusy === 'lessons-batch' ? '处理中…' : `批量采纳 ${selectedLessons.size} 条`}
                      </button>
                    )}
                  </div>
                  {ki.lessons.status === 'error' ? (
                    <p className="mt-1 text-xs text-red-700">读取失败：{ki.lessons.error}（不当作「没有」）</p>
                  ) : ki.lessons.count === 0 ? (
                    <p className="mt-1 text-xs text-gray-500">没有待审的岗位经验。</p>
                  ) : (
                    <div className="mt-1.5 space-y-1.5">
                      {ki.lessons.items.map((l) => (
                        <div key={l.id} className="flex gap-2 rounded bg-gray-50 px-2 py-1.5 text-xs">
                          <input type="checkbox" className="mt-0.5 shrink-0" checked={selectedLessons.has(l.id)}
                            onChange={(e) => setSelectedLessons((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(l.id); else next.delete(l.id);
                              return next;
                            })} />
                          <div className="flex-1 min-w-0">
                            <p className="text-gray-800 whitespace-pre-wrap break-words">{l.content}</p>
                            <p className="mt-0.5 text-[11px] text-gray-500">
                              {l.positionName} · {l.projectName || '未知项目'} · {l.taskTitle || l.taskId.slice(0, 8)}
                              {l.reusable ? '' : ' · 仅本单'}
                            </p>
                          </div>
                          <div className="shrink-0 flex gap-1 self-start">
                            <button type="button" disabled={kbusy !== null}
                              onClick={() => void kact(`la:${l.id}`, () => positionsApi.decideLesson(l.id, 'accepted'))}
                              className="px-2 py-0.5 rounded bg-accent text-paper hover:bg-accent/90 disabled:opacity-50">采纳</button>
                            <button type="button" disabled={kbusy !== null}
                              onClick={() => void kact(`lr:${l.id}`, () => positionsApi.decideLesson(l.id, 'rejected'))}
                              className="px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-50">忽略</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* ② 待批岗位技能草案 */}
                <div>
                  <h4 className="text-xs font-semibold text-gray-700">待批岗位技能（{groupCount(ki.skills)}）</h4>
                  {ki.skills.status === 'error' ? (
                    <p className="mt-1 text-xs text-red-700">读取失败：{ki.skills.error}（不当作「没有」）</p>
                  ) : ki.skills.count === 0 ? (
                    <p className="mt-1 text-xs text-gray-500">没有待批的技能草案。</p>
                  ) : (
                    <div className="mt-1.5 space-y-1.5">
                      {ki.skills.items.map((s) => (
                        <div key={s.id} className="rounded bg-gray-50 px-2 py-1.5 text-xs">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-gray-800">{s.name}</span>
                            <span className="text-[11px] text-gray-500">{s.positionName}</span>
                            <span className="ml-auto shrink-0 flex gap-1">
                              <button type="button" disabled={kbusy !== null}
                                onClick={() => void kact(`sa:${s.id}`, () => positionsApi.skillDecide(s.id, 'approved'))}
                                className="px-2 py-0.5 rounded bg-accent text-paper hover:bg-accent/90 disabled:opacity-50">批准</button>
                              <button type="button" disabled={kbusy !== null}
                                onClick={() => void kact(`sr:${s.id}`, () => positionsApi.skillDecide(s.id, 'rejected'))}
                                className="px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-50">驳回</button>
                            </span>
                          </div>
                          {s.description && <p className="mt-0.5 text-gray-600 whitespace-pre-wrap break-words">{s.description}</p>}
                          {s.stepsPreview && <p className="mt-0.5 text-[11px] text-gray-500">步骤：{s.stepsPreview}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* ③ 可启用候选领域包 */}
                <div>
                  <h4 className="text-xs font-semibold text-gray-700">可启用的领域包（{groupCount(ki.packs)}）</h4>
                  {ki.packs.status === 'error' ? (
                    <p className="mt-1 text-xs text-red-700">读取失败：{ki.packs.error}（不当作「没有」）</p>
                  ) : ki.packs.count === 0 ? (
                    <p className="mt-1 text-xs text-gray-500">没有待启用的候选包。</p>
                  ) : (
                    <div className="mt-1.5 space-y-1.5">
                      {ki.packs.items.map((p) => {
                        const pid = packTargets[p.packId] ?? p.projects[0]?.id ?? '';
                        return (
                          <div key={p.packId} className="rounded bg-gray-50 px-2 py-1.5 text-xs">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-gray-800">{p.name}</span>
                              <span className="text-[11px] text-gray-500">来自 {p.sourceProjectName || '未知项目'}</span>
                            </div>
                            {p.sectionPreview && <p className="mt-0.5 text-gray-600">{p.sectionPreview}</p>}
                            <div className="mt-1 flex flex-wrap items-center gap-1">
                              <span className="text-[11px] text-gray-500">启用到</span>
                              <select value={pid} onChange={(e) => setPackTargets((prev) => ({ ...prev, [p.packId]: e.target.value }))}
                                className="text-[11px] border border-gray-300 rounded px-1 py-0.5 bg-white max-w-[12rem]">
                                {p.projects.map((x) => <option key={x.id} value={x.id}>{x.name || x.id.slice(0, 8)}</option>)}
                              </select>
                              <button type="button" disabled={kbusy !== null || !pid}
                                onClick={() => void kact(`pa:${p.packId}`, () => packs.apply(pid, p.packId))}
                                className="px-2 py-0.5 rounded bg-accent text-paper hover:bg-accent/90 disabled:opacity-50">启用</button>
                              <button type="button" disabled={kbusy !== null}
                                onClick={() => void kact(`pd:${p.packId}`, () => packs.dismiss(p.packId))}
                                className="px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-50">忽略</button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* ④ 待审自进化提案 */}
                <div>
                  <h4 className="text-xs font-semibold text-gray-700">待审自产提案（{groupCount(ki.proposals)}）</h4>
                  {ki.proposals.status === 'error' ? (
                    <p className="mt-1 text-xs text-red-700">读取失败：{ki.proposals.error}（不当作「没有」）</p>
                  ) : ki.proposals.count === 0 ? (
                    <p className="mt-1 text-xs text-gray-500">没有待审提案。</p>
                  ) : (
                    <div className="mt-1.5 space-y-1.5">
                      {ki.proposals.items.map((p) => (
                        <div key={p.id} className="flex items-center gap-2 rounded bg-gray-50 px-2 py-1.5 text-xs">
                          <div className="flex-1 min-w-0">
                            <p className="text-gray-800 break-words">{p.note || p.target}</p>
                            <p className="text-[11px] text-gray-500 font-mono">{p.kind} · {p.target}</p>
                          </div>
                          <div className="shrink-0 flex gap-1">
                            <button type="button" disabled={kbusy !== null}
                              onClick={() => void kact(`pra:${p.id}`, () => admin.selfEvolveDecide(p.id, 'approve'))}
                              className="px-2 py-0.5 rounded border border-green-300 text-green-700 hover:bg-green-50 disabled:opacity-50">批准</button>
                            <button type="button" disabled={kbusy !== null}
                              onClick={() => void kact(`prr:${p.id}`, () => admin.selfEvolveDecide(p.id, 'reject'))}
                              className="px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-50">拒绝</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* ⑤ 已生效的自省规则：不是待办，只做「批准前后同类拒绝」复盘 */}
                <div>
                  <h4 className="text-xs font-semibold text-gray-700">已生效的自省规则（{groupCount(ki.rulesInEffect) ?? 0}）</h4>
                  {ki.rulesInEffect.status === 'error' ? (
                    <p className="mt-1 text-xs text-red-700">读取失败：{ki.rulesInEffect.error}（不当作「没有」）</p>
                  ) : ki.rulesInEffect.count === 0 ? (
                    <p className="mt-1 text-xs text-gray-500">还没有生效的自省规则。</p>
                  ) : (
                    <div className="mt-1.5 space-y-1.5">
                      {ki.rulesInEffect.items.map((p) => {
                        const i = p.impact;
                        const verdict = i?.verdict === 'better' ? '好转' : i?.verdict === 'worse' ? '变差' : i?.verdict === 'flat' ? '持平' : '证据不足';
                        return (
                          <div key={p.id} className="rounded bg-gray-50 px-2 py-1.5 text-xs">
                            <div className="flex items-center gap-2">
                              <span className="flex-1 min-w-0 text-gray-800 break-words">{p.note || p.target}</span>
                              <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${p.status === 'rolled_back' ? 'bg-gray-200 text-gray-600' : 'bg-accent-soft text-accent'}`}>
                                {p.status === 'rolled_back' ? '已回滚' : '已生效'}
                              </span>
                              {p.status === 'applied' && i?.verdict === 'worse' && (
                                <button type="button" disabled={kbusy !== null}
                                  onClick={() => void kact(`prb:${p.id}`, () => admin.selfEvolveDecide(p.id, 'rollback'))}
                                  className="shrink-0 px-2 py-0.5 rounded border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-50">回滚</button>
                              )}
                            </div>
                            {i ? (
                              <p className={`mt-0.5 text-[11px] ${i.verdict === 'worse' ? 'text-red-700' : i.verdict === 'better' ? 'text-green-700' : 'text-gray-500'}`}>
                                同类拒绝：批准前 {i.windowDays} 天 {i.before} 次（{i.beforePerDay.toFixed(1)}/天）→ 批准后 {i.daysSince.toFixed(1)} 天 {i.after} 次（{i.afterPerDay.toFixed(1)}/天）· {verdict}
                              </p>
                            ) : (
                              <p className="mt-0.5 text-[11px] text-gray-500">影响尚不可算（未满观察期或缺少证据）。</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
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
