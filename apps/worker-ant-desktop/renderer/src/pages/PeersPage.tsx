/**
 * zx_20261004 M4/M5/M6（海德格尔·在世存在·共在 / 亚里士多德·潜能成现实 / 老子·知人者智，自知者明）:
 * **协同面板**——让"能协同"上屏成"正协同"。
 *
 * 三件事各自落地：
 *   - **共在一屏**（M4）：他机与本机**同一面镜子**（都读 ANS 台账里那一行），按角色分组（米勒 7±2），
 *     本机置顶。行内给 名/平台/CPU/内存/磁盘/忙闲/角色/权重/在线态。
 *   - **档位可配**（M5）：本机的 角色×权重×参与 改即 `nodes:update` 落到 ANS（派单真源）并镜像本地。
 *   - **自知者明**（M6）：本机行读的是**ANS 回传的本机台账行**（`status` 即心跳送上去的那份快照），
 *     不在此另算一份环境——"报出去的忙"与"面板上看见的忙"因此必是同一个数。
 *
 * zx_20261011 M4（知行合一）: 补齐**发送侧**——此前那句"暂不支持跨机派发"的诚实声明**兑现成能力**：
 *   顶部横幅**删除**，换成「派活」卡（类目 × 目标（自动/手动）× 描述 ⇒ `nodes:dispatch`）与
 *   「我派出去的活」出站台账（`nodes:dispatches` + 有界轮询 `nodes:dispatch-result` 读回终态）。
 *   派发本身是**对等**的：本机也须已入网（有身份才有读回凭据），失败一律如实上屏。
 */
import { useEffect, useState } from 'react';
import { nodes as nodesApi, external as externalApi, type NodesClusterPayload, type ClusterNode } from '../lib/ipc';
import { useLiveQuery } from '../lib/useLiveQuery';
// zx_20261018_2 批六「见新」：门态/留痕以事件驱动为主，轮询只作兜底——节拍一处真源。
import { ACTIVE_POLL_MS, FALLBACK_POLL_MS } from '../lib/refresh';
import { FreshnessPill } from '../components/FreshnessPill';
import { readNodeEnv, isNodeOnline, seenAgo, snapshotAgo, isSnapshotStale, dispatchFillView, slotFillView, fillColor, capacityView, capacityColor, CALL_STATUS_LABEL, DISPATCH_STATUS_LABEL, nodeCategories, canRemovePeer, canEditNode, type NodeEnvView } from '../lib/node-view';
import { formatBytes, formatDbTime, parseDbTime } from '../lib/deliverable-view';
import { resultBrief } from '../lib/result-brief';
import { Network, RefreshCw, Cpu, HardDrive, MemoryStick, Check, Send, Trash2, DoorOpen, Gauge, RotateCcw, GitBranch } from 'lucide-react';
// 角色枚举/人话名/可派单判据**一律取自共享真源**（M5「一处真源」）——此处不写第二份字符串表。
import { NODE_ROLES, NODE_ROLE_LABEL, isDispatchable, NODE_CARD_CATEGORIES, NODE_CARD_CATEGORY_LABEL, type AnsNode, type NodeRole, type NodeCardCategory } from '../../../../../packages/shared-types/src/nodes.js';
// M13 调用记录的形状取自 main 侧真源（`node-call-log.ts`）——不手抄镜像。仅类型引用，打包期擦除。
import type { NodeCallRecord } from '../../../src/main/core/node-call-log.js';
// zx_20261011 M4 出站记录的形状取自 main 侧真源（`node-dispatch-log.ts`）——不手抄镜像。仅类型引用，打包期擦除。
import type { NodeDispatchRecord } from '../../../src/main/core/node-dispatch-log.js';
// zx_20261012：「为何未入网」枚举取自 main 侧真源（`node-heartbeat.ts`）——不手抄字符串表。仅类型引用，打包期擦除。
import type { NodeEnrollmentReason } from '../../../src/main/core/node-heartbeat.js';
// zx_20261014_4 批三：「门」留痕行的形状取自 main 侧真源（`external-calls.ts`）——不手抄镜像。仅类型引用，打包期擦除。
import type { ExternalCallRow } from '../../../src/main/core/external-calls.js';
// zx_20261023_5 批一：待派任务三分组的形状取 main 侧真源（`collab-dispatch.ts`），仅类型引用、打包期擦除。
import type { DispatchBoardPayload } from '../../../src/main/core/collab-dispatch.js';

/** 在线判据与"多久前"共用的节拍（10s 一推进）——阈值本身取自共享真源，见 node-view.ts。 */
function useTick(ms = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

function OnlineDot({ online }: { online: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] ${online ? 'text-emerald-600' : 'text-gray-400'}`}>
      <span className={`w-2 h-2 rounded-full ${online ? 'bg-emerald-500' : 'bg-gray-300'}`} />
      {online ? '在线' : '离线'}
    </span>
  );
}

function EnvLine({ env }: { env: NodeEnvView | null }) {
  if (!env) return <span className="text-xs text-gray-400">尚无环境快照（从未心跳）</span>;
  const memUsed = env.total_mem != null && env.free_mem != null ? env.total_mem - env.free_mem : null;
  const fill = dispatchFillView(env);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
      {/* M1：先示**真 CPU 利用率**；load 只作旁证（Windows 无此数 ⇒ '—'，不显假的 0.00）。 */}
      <span className="inline-flex items-center gap-1" title="真 CPU 利用率（两次采样做差）">
        <Cpu className="w-3.5 h-3.5" />{env.cpu_count ?? '?'} 核 · CPU {env.cpu_usage_percent != null ? `${env.cpu_usage_percent}%` : '—'} · 负载 {env.load_avg1 != null ? env.load_avg1.toFixed(2) : '—'}
      </span>
      <span className="inline-flex items-center gap-1"><MemoryStick className="w-3.5 h-3.5" />{memUsed != null ? `${formatBytes(memUsed)} / ${formatBytes(env.total_mem)}` : '—'}</span>
      <span className="inline-flex items-center gap-1"><HardDrive className="w-3.5 h-3.5" />{env.disk_free != null ? `${formatBytes(env.disk_free)} 可用` : '—'}</span>
      {/* zx_20261022_3 批一：槽位与作业**分开写**——槽位是机器执行位（与执行闸同源），作业是我方队列里的活。 */}
      <span className="inline-flex items-center gap-1" title="机器执行槽位（在跑任务 ÷ 机器并发上限，与执行闸同源）">
        <Gauge className="w-3.5 h-3.5" />槽位 {env.running_tasks != null && env.machine_limit != null ? `${env.running_tasks} / ${env.machine_limit}` : '—'}
        {env.free_slots != null ? `（空 ${env.free_slots}）` : ''}
      </span>
      <span className="text-gray-400" title="派单作业数 ÷ 项目缺省并发——不是机器槽位">作业 {fill.label}</span>
      {env.platform && <span className="text-gray-400">{env.platform}/{env.arch}{env.hostname ? ` · ${env.hostname}` : ''}</span>}
    </div>
  );
}

/** M11 能力卡：该节点**对外的那份自述**（读台账 `card`，与心跳上送同源——不在此另算一份）。 */
function CardLine({ node }: { node: AnsNode }) {
  const cats = nodeCategories(node);
  if (cats.length === 0) return null;
  return (
    <div className="mt-1.5 flex items-center gap-1.5 flex-wrap text-[10px] text-gray-400">
      <span>能做</span>
      {cats.map(c => (
        <span key={c} className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600">{NODE_CARD_CATEGORY_LABEL[c]}</span>
      ))}
    </div>
  );
}

function Bar({ label, text, ratio, color }: { label: string; text: string; ratio: number | null; color: (r: number | null) => string }) {
  const pct = ratio == null ? 0 : Math.min(100, Math.round(ratio * 100));
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-gray-400 w-16 shrink-0">{label} {text}</span>
      <div className="h-1.5 w-28 rounded-full bg-gray-100 overflow-hidden">
        <div className={`h-full ${color(ratio)}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * zx_20261007 M2：**两个数，两件事**——「派单填充」答"我给自己派了几成活"，
 * 「机器余力」答"这台机器还剩多少力"。二者会背离（我方闲但机器被别处占满时，填充低而余力也低），
 * 合并成一个数就是把两件事说成一件（旧版把它叫"忙闲"，是名实不符）。
 */
function LoadBars({ env }: { env: NodeEnvView | null }) {
  const slots = slotFillView(env);
  const cap = capacityView(env);
  return (
    <div className="flex items-center gap-4 flex-wrap">
      <Bar label="机器槽位" text={slots.label} ratio={slots.ratio} color={fillColor} />
      <Bar label="机器余力" text={cap.label} ratio={cap.ratio} color={capacityColor} />
    </div>
  );
}

/** 耗时 → 人话。`null` 一律 `—`——两时刻缺一即**不知道**，不补 0 冒充"瞬时完成"（承 `node-call-log.ts` 注释）。 */
function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

/** 结果的"一句话"取自**一处真源** `lib/result-brief.ts`（markdown 产出物去壳取正文首段，见其注记）。 */

/**
 * zx_20261011 M9（追加批）: **请求载荷**的"一句话"——优先 `prompt`（接收侧建本地任务读的就是它，
 * 单源），退到整份 JSON（有界截断）。台账行靠它答"这一单派/派来的是什么"。
 */
function requestBrief(payload: Record<string, unknown> | null): string {
  if (!payload) return '';
  if (typeof payload.prompt === 'string' && payload.prompt.trim()) return payload.prompt.trim();
  try { const s = JSON.stringify(payload); return s === '{}' ? '' : s; } catch { return ''; }
}

/** 回传结果里的本地任务终态（`completed`/`paused`…）——与摘要并排，让"执行方那句话"有所属（M9）。 */
function resultTaskStatus(result: Record<string, unknown> | null): string {
  return result && typeof result.taskStatus === 'string' ? result.taskStatus : '';
}

function CallRecordRow({ rec }: { rec: NodeCallRecord }) {
  const tone = rec.status === 'done' ? 'bg-emerald-50 text-emerald-600'
    : rec.status === 'error' ? 'bg-red-50 text-red-600'
      : rec.status === 'cancelled' ? 'bg-slate-100 text-slate-600' : 'bg-amber-50 text-amber-600';
  const brief = resultBrief(rec.result);
  const asked = requestBrief(rec.requestPayload);
  const taskStatus = resultTaskStatus(rec.result);
  return (
    <div className="rounded-lg border bg-white p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{rec.category || '未分类'}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${tone}`}>{CALL_STATUS_LABEL[rec.status]}</span>
        <span className="text-[11px] text-gray-500 font-mono" title="请求方（AI 终端）key 前缀">{rec.requesterKeyPrefix || '—'}</span>
        <span className="text-[11px] text-gray-400 ml-auto">耗时 {formatDuration(rec.durationMs)}</span>
      </div>
      <div className="mt-1 flex items-center gap-3 flex-wrap text-[10px] text-gray-400">
        <span>到场 {formatDbTime(rec.receivedAt) || '—'}</span>
        {rec.completedAt && <span>收口 {formatDbTime(rec.completedAt)}</span>}
        <span className="font-mono text-gray-300">{rec.requestId.slice(0, 8)}</span>
      </div>
      {asked && (
        <div className="mt-1.5 text-xs text-gray-700 whitespace-pre-wrap break-words line-clamp-2">
          <span className="text-[10px] text-gray-400 mr-1">请求内容</span>{asked}
        </div>
      )}
      {brief && (
        <div className="mt-1 text-xs text-gray-600 whitespace-pre-wrap break-words line-clamp-3">
          <span className="text-[10px] text-gray-400 mr-1">执行结果{taskStatus ? `（任务 ${taskStatus}）` : ''}</span>{brief}
        </div>
      )}
    </div>
  );
}

/**
 * zx_20261011_1 M4（双向澄清）: **待答问题块**——B 端（执行方）提问后，派活方在此作答。
 *   可选按钮（B 端给的 `options`）一按即填；自由作答亦可。作答 ⇒ `nodes:answer-question` ⇒ `onDone` 复取台账。
 *   只在该单**当前在问**（`questionStatus==='asked'`）时出现——答完即隐（答案转而显示在行尾「我已作答」）。
 */
function QuestionBlock({ rec, onDone }: { rec: NodeDispatchRecord; onDone: () => void }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const q = rec.question;
  if (!q) return null;
  async function answer() {
    const a = draft.trim();
    if (!a) return;
    setBusy(true); setErr('');
    try {
      const r = await nodesApi.answerQuestion(rec.requestId, a);
      if (r.ok) { onDone(); } else { setErr(r.note || '作答失败'); }
    } catch (e) { setErr((e as Error)?.message || String(e)); }
    finally { setBusy(false); }
  }
  return (
    <div className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5">
      <div className="text-[10px] text-amber-700 mb-0.5">执行方提问（待你作答）</div>
      <div className="text-xs text-gray-800 whitespace-pre-wrap break-words">{q.question}</div>
      {q.options && q.options.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {q.options.map(o => (
            <button key={o} onClick={() => setDraft(o)} className="text-[10px] px-1.5 py-0.5 border border-amber-400 text-amber-700 rounded hover:bg-amber-100">{o}</button>
          ))}
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-2">
        <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="作答…"
          className="flex-1 min-w-[10rem] px-2 py-1 border rounded text-xs" />
        <button onClick={() => void answer()} disabled={busy || !draft.trim()}
          className="text-xs px-2 py-1 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50">
          {busy ? '提交中…' : '作答'}
        </button>
      </div>
      {err && <p className="mt-1 text-[11px] text-red-600">{err}</p>}
    </div>
  );
}

/** zx_20261011 M4: 一条**出站**记录行（与入站 `CallRecordRow` 对照：这里多一个「目标节点」）。 */
/**
 * zx_20261030_1 M2「见」：**这一单走到哪了**——只印三项真数，不编百分比。
 *
 *   · 有 `total`（历史估时）⇒「第 3/8 步」；
 *   · 无 `total` ⇒「已进行 4 分钟」（由**派出时刻**算，不拿 `step` 当分母）；
 *   · 无 `progress`（对端旧版本 / 尚未开始）⇒「对方未上报进度」——**不退化成 0%**。
 * `note` 是"最近一步做了什么"（事件在步末发），文案写「最近一步」，不写「正在」。
 */
function DispatchProgressLine({ rec }: { rec: NodeDispatchRecord }) {
  const p = rec.progress;
  if (!p) {
    return <p className="mt-1.5 text-[10px] text-gray-400">对方未上报进度（对端为旧版本，或尚未走到第一步）。</p>;
  }
  const started = Date.parse(rec.dispatchedAt);
  const elapsedMs = Number.isFinite(started) ? Math.max(0, Date.now() - started) : null;
  const head = p.total != null
    ? `第 ${Math.min(p.step, p.total)}/${p.total} 步${p.step > p.total ? '（已超出估时）' : ''}`
    : `已进行 ${formatDuration(elapsedMs)}`;
  return (
    <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-amber-700">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 mt-1.5 animate-pulse shrink-0" />
      <span className="break-all">
        {head}
        {p.note ? <span className="text-gray-500"> · 最近一步：{p.note}</span> : null}
        <span className="text-gray-400"> · 更新于 {formatDbTime(p.at) || p.at}</span>
      </span>
    </div>
  );
}

function DispatchRow({ rec, nameOf, onDone }: { rec: NodeDispatchRecord; nameOf: (id: string) => string; onDone: () => void }) {
  const [stopBusy, setStopBusy] = useState(false);
  const [stopNote, setStopNote] = useState('');
  const tone = rec.status === 'done' ? 'bg-emerald-50 text-emerald-600'
    : rec.status === 'error' ? 'bg-red-50 text-red-600'
      : rec.status === 'cancelled' ? 'bg-slate-100 text-slate-600' : 'bg-amber-50 text-amber-600';
  const brief = resultBrief(rec.result);
  const asked = requestBrief(rec.requestPayload);
  const taskStatus = resultTaskStatus(rec.result);
  const target = rec.targetNodeId ? (nameOf(rec.targetNodeId) || rec.targetNodeId.slice(0, 8)) : '待分配';

  // zx_20261030_1 M3「止」: 叫停。回来的 `status` 即真实处置——已停 ⇒ 台账刷新成「已停止」；
  //   仍在跑 ⇒ 只说"已请求"，**不谎称已停**（旧版对端不读叫停位，会照常跑完并按真实结局回传）。
  async function onStop() {
    setStopBusy(true); setStopNote('');
    try {
      const r = await nodesApi.cancelDispatch(rec.requestId);
      if (!r.ok) { setStopNote(r.note === 'not-enrolled' ? '本机尚未入网，无法叫停。' : `叫停失败：${r.note || '未知原因'}`); return; }
      if (r.request?.status === 'cancelled') {
        setStopNote('已停止。');
        onDone();
      } else {
        setStopNote('已请求停止——对端将在下一步检查点真停并回传「已停止」。若对端版本较旧（不认叫停位），这单会照常跑完并按真实结局回传。');
      }
    } catch (e) { setStopNote((e as Error)?.message || String(e)); }
    finally { setStopBusy(false); }
  }
  return (
    <div className="rounded-lg border bg-white p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{rec.category || '未分类'}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${tone}`}>{DISPATCH_STATUS_LABEL[rec.status]}</span>
        {rec.questionStatus === 'asked' && rec.status === 'pending' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">待作答</span>}
        <span className="text-[11px] text-gray-500">→ {target}</span>
        <span className="text-[11px] text-gray-400 ml-auto">耗时 {formatDuration(rec.durationMs)}</span>
      </div>
      <div className="mt-1 flex items-center gap-3 flex-wrap text-[10px] text-gray-400">
        <span>派出 {formatDbTime(rec.dispatchedAt) || '—'}</span>
        {rec.resultAt && <span>收口 {formatDbTime(rec.resultAt)}</span>}
        <span className="font-mono text-gray-300">{rec.requestId.slice(0, 8)}</span>
      </div>
      {/* M2：未收口才谈得上"进行中"——收口后由结果行说话。 */}
      {rec.status === 'pending' && <DispatchProgressLine rec={rec} />}
      {/* M3：未收口才有"停"可言——终态件不再提供死动作。 */}
      {rec.status === 'pending' && (
        <div className="mt-1.5 flex items-start gap-2 flex-wrap">
          <button onClick={() => void onStop()} disabled={stopBusy}
            className="text-[10px] px-2 py-0.5 border border-red-300 text-red-600 rounded hover:bg-red-50 disabled:opacity-50 shrink-0">
            {stopBusy ? '叫停中…' : '停止'}
          </button>
          {stopNote && <span className="text-[10px] text-gray-500 break-all">{stopNote}</span>}
        </div>
      )}
      {asked && (
        <div className="mt-1.5 text-xs text-gray-700 whitespace-pre-wrap break-words line-clamp-2">
          <span className="text-[10px] text-gray-400 mr-1">派单内容</span>{asked}
        </div>
      )}
      {/* M4: 执行方的一问（在问时给作答框；答过则只留答案痕迹）。 */}
      {/* zx_20261011_2 D10（名实·终态不可复活）: 只有**仍在等答**（行还 `pending`）才给作答框与「待作答」徽标。
          已终态（done/error）却仍带提问者，是"执行方未获作答即自行决断收口"——ANS `/answer` 现已挡住对终态件的
          作答（D10 闸），故此处**不再提供死动作**，只如实说明这一问已过期。旧版（M1）承诺"作答后会重跑"
          是一条**已被堵死**的路（作答只会被 400 拒绝），名实不符。 */}
      {rec.questionStatus === 'asked' && rec.status !== 'pending' && (
        <p className="mt-1.5 text-[10px] text-amber-700">
          本单已收口（{DISPATCH_STATUS_LABEL[rec.status]}）——未获作答即收口
          {rec.status === 'cancelled'
            ? '：已叫停，这一问不再作答（该提问已过期）。'
            : '：执行方已就这一问自行决断（该提问已过期，不能再作答）。'}
        </p>
      )}
      {rec.questionStatus === 'asked' && rec.status === 'pending' && <QuestionBlock rec={rec} onDone={onDone} />}
      {rec.answer && (
        <div className="mt-1 text-xs text-gray-600 whitespace-pre-wrap break-words">
          <span className="text-[10px] text-gray-400 mr-1">我已作答</span>{rec.answer.answer}
        </div>
      )}
      {brief && (
        <div className="mt-1 text-xs text-gray-600 whitespace-pre-wrap break-words line-clamp-3">
          <span className="text-[10px] text-gray-400 mr-1">{rec.status === 'cancelled' ? '叫停记录' : '执行方回传'}{taskStatus ? `（任务 ${taskStatus}）` : ''}</span>{brief}
        </div>
      )}
    </div>
  );
}

/**
 * zx_20261011 M4（知行合一）: **派活卡**——把旧声明"暂不支持跨机派发"兑现成一个动作。
 *   类目（共享词表 `NODE_CARD_CATEGORIES`，缺省 `project_task`——内建恒在，必有靶）×
 *   目标（**自动** / 从"可派单 ∧ 卡含该类目"的他机里选——与 ANS 侧同源判据先收窄候选）×
 *   描述（落 `payload.prompt`；接收侧 `node-request-runner.ts` 据此建本地任务）。
 *   结果**如实上屏**：未入网 ⇒ 明确说"先入网"；其余失败原样给原因（不粉饰）。
 */
function DispatchCard({ candidates, onDone }: { candidates: AnsNode[]; onDone: () => void }) {
  const [category, setCategory] = useState<NodeCardCategory>('project_task');
  const [target, setTarget] = useState<string>('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [ok, setOk] = useState(false);

  // 目标候选随类目收窄；换类目后原目标可能不再合格 ⇒ 清空它（不留"看着选中、ANS 却不认"的假目标）。
  const targets = candidates.filter(n => nodeCategories(n).includes(category));
  useEffect(() => {
    setTarget(prev => (prev && !targets.some(n => n.node_id === prev) ? '' : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  async function onDispatch() {
    setBusy(true); setNote('');
    try {
      const r = await nodesApi.dispatch({
        category,
        ...(prompt.trim() ? { payload: { prompt: prompt.trim() } } : {}),
        ...(target ? { targetNodeId: target } : {}),
      });
      if (r.ok) {
        setOk(true);
        setNote(`已派出（目标 ${target || r.targetNodeId || '待 ANS 分配'}；状态 ${r.status}）。结果会在下方台账中回填。`);
        onDone();
      } else {
        setOk(false);
        setNote(r.note === 'not-enrolled' ? '本机尚未入网——请先加入协同网络，才能派活。' : `派发失败：${r.note}`);
      }
    } catch (e) { setOk(false); setNote((e as Error)?.message || String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="mb-5 rounded-lg border border-indigo-200 bg-indigo-50/50 px-4 py-3">
      <div className="text-sm font-medium text-indigo-900 mb-2 inline-flex items-center gap-1.5"><Send className="w-4 h-4" />派活</div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[11px] text-gray-600 inline-flex items-center gap-1">类目
          <select value={category} onChange={e => setCategory(e.target.value as NodeCardCategory)} className="px-1.5 py-0.5 border rounded text-xs bg-white">
            {NODE_CARD_CATEGORIES.map(c => <option key={c} value={c}>{NODE_CARD_CATEGORY_LABEL[c]}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-gray-600 inline-flex items-center gap-1">目标
          <select value={target} onChange={e => setTarget(e.target.value)} className="px-1.5 py-0.5 border rounded text-xs bg-white">
            <option value="">自动（按负载/权重选）</option>
            {targets.map(n => <option key={n.node_id} value={n.node_id}>{n.name || n.node_id.slice(0, 8)}</option>)}
          </select>
        </label>
        <button onClick={() => void onDispatch()} disabled={busy}
          className="inline-flex items-center gap-1 text-xs px-3 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50">
          <Send className="w-3 h-3" />{busy ? '派发中…' : '派发'}
        </button>
      </div>
      <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={2}
        placeholder="任务描述（可留空）——接收方据此建一件本地任务"
        className="mt-2 w-full px-2 py-1 border rounded text-xs resize-y" />
      {targets.length === 0 && (
        <p className="mt-1 text-[10px] text-amber-600">
          当前无他机可派「{NODE_CARD_CATEGORY_LABEL[category]}」类的活（可派他机须：参与协同 ∧ 非观察者 ∧ 在线，且卡含该类目）；选「自动」时若此刻无人可派，ANS 会先挂起待有节点上线。
        </p>
      )}
      {note && <p className={`mt-2 text-xs ${ok ? 'text-emerald-700' : 'text-red-600'}`}>{note}</p>}
      <p className="mt-1 text-[10px] text-gray-400">派发方须为本网节点（对等派发）——未入网时此卡会如实拒绝。</p>
    </div>
  );
}

/**
 * zx_20261011 M4: **我派出去的活**（出站台账）。与入站"AI 终端调用记录"对照（两个方向各一本账）。
 *   非终态者由本组件**有界轮询** `nodes.dispatch-result` 读回（终态落地 emit `node.request_result` ⇒
 *   `liveTypes` 触发本查询重取；有界：~200s 后自停，不无限轮询拖住面板）。
 */
function DispatchLedger({ nameOf }: { nameOf: (id: string) => string }) {
  const q = useLiveQuery(async () => nodesApi.dispatches(), [], {
    // M4：四类事件皆触发重取——派出/收口之外，B 端提问 / 本机作答也要让台账(与待答块)即时上屏。
    liveTypes: ['node.request_dispatched', 'node.request_result', 'node.request_question', 'node.request_answered'],
    debounceMs: 700,
  });
  const records = q.data?.records ?? [];
  const pendingKey = records.filter(r => r.status === 'pending').map(r => r.requestId).join(',');

  useEffect(() => {
    if (!pendingKey) return;
    const ids = pendingKey.split(',');
    // zx_20261011_2 D7（收口复看·实机照出）：**不设次数上限**——只要台账行还是 `pending`（未收口）就一直读回。
    //   旧实现 40×5s＝200s 到点即停，而真任务常跑数分钟（实测 349s）⇒ 收口那一下被漏掉，
    //   行**永远停在"待回"**（唯一出路是切页再回来重挂效应）。行离开 `pending` 本身即止
    //   （`pendingKey` 变 ⇒ 效应重跑；空 ⇒ 提前 return 并清旧 interval），不再靠一个猜出来的窗长。
    const t = window.setInterval(() => {
      // zx_20261030_1 M2：读回落地后**重取台账**——进度是本机内存投影（不落事件日志），
      //   没有事件驱动刷新，只能由这条既有轮询把最新一份带上来（同一条节拍，不另开时钟）。
      void Promise.allSettled(ids.map((id) => nodesApi.dispatchResult(id))).then(() => q.reload());
    }, 5000);
    return () => window.clearInterval(t);
  }, [pendingKey]);

  return (
    <div className="mt-6 pt-5 border-t border-gray-200">
      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
        我派出去的活（{records.length}）
      </p>
      {records.length === 0
        ? <p className="text-xs text-gray-400 py-3">尚无派出记录——用上方「派活」发出第一单后在此留痕（派出/读回收口各一条）。</p>
        : <div className="space-y-2">{records.map(r => <DispatchRow key={r.requestId} rec={r} nameOf={nameOf} onDone={() => void q.reload()} />)}</div>}
    </div>
  );
}

function NodeRow({ node, local, localRole, localNodeId, nowMs, onSaved, onRemove }: { node: AnsNode; local: boolean; localRole: NodeRole | null; localNodeId: string | null; nowMs: number; onSaved: () => void; onRemove?: () => void }) {
  const env = readNodeEnv(node);
  const online = isNodeOnline(node.last_seen_at, nowMs);
  const dispatchable = isDispatchable(node);
  // zx_20261017_1 批四: 可否改档的唯一判据（本机行恒可编；他机须本机 primary/observer）——不在此内联。
  const editable = canEditNode(localRole, node, localNodeId);
  const [role, setRole] = useState<NodeRole>(node.role);
  const [weight, setWeight] = useState(String(node.weight));
  const [participate, setParticipate] = useState(node.participate);
  // zx_20261011 M8（追加批）: 节点名——此前无写口（派活目标下拉只显 name，两台同名即无法分辨）。
  const [name, setName] = useState(node.name);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // 台账刷新后回填（保存成功 → 复取 → 值一致；他处改动 → 这里跟手）。
  useEffect(() => { setRole(node.role); setWeight(String(node.weight)); setParticipate(node.participate); setName(node.name); }, [node.role, node.weight, node.participate, node.name]);

  async function save() {
    setSaving(true); setSaveErr(null);
    try {
      // 名字留空即**不改名**（不把空串 PATCH 上去把台账名清掉）——其余三键恒发。
      const patch = { role, weight: Number(weight), participate, ...(name.trim() ? { name: name.trim() } : {}) };
      await nodesApi.update(node.node_id, patch);
      onSaved();
    } catch (e) {
      setSaveErr((e as Error)?.message || '保存失败');
    } finally { setSaving(false); }
  }

  return (
    <div className={`rounded-lg border p-3 ${local ? 'bg-blue-50/40 border-blue-200' : 'bg-white'}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <Network className={`w-4 h-4 ${local ? 'text-blue-500' : 'text-gray-400'}`} />
        <span className="font-medium text-sm text-gray-800">{node.name || node.node_id}</span>
        {local && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-600 text-white">本机</span>}
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{NODE_ROLE_LABEL[node.role]}</span>
        <span className="text-[10px] text-gray-400">权重 {node.weight}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${dispatchable ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-500'}`}>{dispatchable ? '可派单' : '不派单'}</span>
        <OnlineDot online={online} />
        <span className="text-[11px] text-gray-400 ml-auto">心跳 {seenAgo(node.last_seen_at, nowMs)}</span>
      </div>
      <div className="mt-1.5"><EnvLine env={env} /></div>
      <CardLine node={node} />
      <div className="mt-1.5 flex items-center gap-3 flex-wrap">
        <LoadBars env={env} />
        {/* M3：快照时刻**带"距今多久"**——只显绝对时刻时，"20 分钟前的旧数据"与"刚报的"看着一样。
            超 `NODE_OFFLINE_SEC` 转红，让"陈"自己说话（阈值由共享真源 `isSnapshotStale` 定，不在此抄数）。 */}
        {env?.collected_at && (
          <span className={`text-[10px] ${isSnapshotStale(env.collected_at, nowMs) ? 'text-red-500 font-medium' : 'text-gray-300'}`}>
            {isSnapshotStale(env.collected_at, nowMs) ? '数据陈旧' : '快照'} {formatDbTime(env.collected_at)} · {snapshotAgo(env.collected_at, nowMs)}
          </span>
        )}
      </div>
      {/* M3：断网期间的快照——"这段数据是陈的"必须上屏（此前落库即沉默）。 */}
      {env?.stale_since && (
        <div className="mt-1 text-[10px] text-amber-600">
          数据陈旧：自 {formatDbTime(env.stale_since)} 起未再更新（上报恢复后自动清除）
        </div>
      )}
      {editable ? (
        <div className={`mt-2 pt-2 border-t flex items-center gap-3 flex-wrap ${local ? 'border-blue-100' : 'border-gray-100'}`}>
          <label className="text-[11px] text-gray-500 inline-flex items-center gap-1">名称
            <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="节点名（留空即不改）"
              className="w-40 px-1.5 py-0.5 border rounded text-xs" />
          </label>
          <label className="text-[11px] text-gray-500 inline-flex items-center gap-1">角色
            <select value={role} onChange={e => setRole(e.target.value as NodeRole)} className="px-1.5 py-0.5 border rounded text-xs bg-white">
              {NODE_ROLES.map(r => <option key={r} value={r}>{NODE_ROLE_LABEL[r]}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-gray-500 inline-flex items-center gap-1">权重
            <input type="number" step="0.1" min="0" value={weight} onChange={e => setWeight(e.target.value)} className="w-16 px-1.5 py-0.5 border rounded text-xs" />
          </label>
          <label className="text-[11px] text-gray-500 inline-flex items-center gap-1">
            <input type="checkbox" checked={participate} onChange={e => setParticipate(e.target.checked)} />参与派单
          </label>
          <button onClick={save} disabled={saving} className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
            <Check className="w-3 h-3" />{saving ? '保存中…' : '保存'}
          </button>
          {saveErr && <span className="text-[11px] text-red-500">{saveErr}</span>}
          <span className="text-[10px] text-gray-400">
            {local ? '改的是本机名称与档位（存 ANS，供派单选目标）' : '改的是对端节点的名称与档位（存 ANS，立即影响派单选目标）'}
          </span>
        </div>
      ) : !local ? (
        // zx_20261017_1 批四: 只读不是"坏了"——如实说明是哪一道闸，并给出唯一可行动作。
        <div className="mt-2 pt-2 border-t border-gray-100 text-[10px] text-gray-400">
          只读：本机是工作节点（只接不分），不能改他机档位。把本机角色改为主节点或观察者后即可编辑他机。
        </div>
      ) : null}
      {/* zx_20261011_3（老子·知止）: **只删他机 ∧ 离线**——本机行不删（删自己=退出协同网络）、在线行不删
          （对方仍在网，删了下一拍即回）。判据**一处**（`canRemovePeer`），此处不内联第二份。 */}
      {!local && canRemovePeer(local, online) && onRemove ? (
        <div className="mt-2 pt-2 border-t border-gray-100 flex items-center gap-2 flex-wrap">
          <button onClick={onRemove}
            className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 border border-red-300 text-red-600 rounded hover:bg-red-50">
            <Trash2 className="w-3 h-3" />移出网络
          </button>
          <span className="text-[10px] text-gray-400">离线节点——移出即从台账删除并吊销其 key</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * zx_20261010_1 M4（维特根斯坦·意义即使用）: **入职卡**——把此前那句"若已配 `node.enrollment_token`…"的
 *   **空话**（那个键没有任何操作能写）补成**可操作的门**。两条路任选其一：
 *     - **粘贴令牌**：文本框 + 「注册」（`nodes.enroll(token)`）；
 *     - **一键申请**：用本机既有 ANS 凭据向 ANS 签一枚令牌（`nodes.requestToken()`）并**紧接注册**。
 *   结果**如实上屏**（成功 ⇒ 本机行即将出现；失败 ⇒ 原样显示原因，并保留另一条路）。
 *   仅在本机**未入网**（`enrollState.enrolled === false`）时出现——已入网即换被动提示（见下）。
 */
function EnrollCard({ hasToken, initialName, reason, onDone }: { hasToken: boolean; initialName: string; reason?: NodeEnrollmentReason | null; onDone: () => void }) {
  const [token, setToken] = useState('');
  // zx_20261011 M8（追加批）: 入网时可**就地取名**（否则两实例同机默认同名 hostname，台账无从分辨）。
  //   预填本机当前名（`enroll-state.name`，异步到达后回填——用户未动过输入框时才会被覆盖）。
  const [name, setName] = useState(initialName);
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState<null | 'input' | 'apply'>(null);
  const [note, setNote] = useState('');
  const [ok, setOk] = useState(false);

  useEffect(() => { if (!nameTouched) setName(initialName); }, [initialName, nameTouched]);

  /** 走 `nodes:enroll`（可带令牌/名字，也可不带——令牌不带则用本地已存的那枚）。返回是否入网成功。 */
  async function enrollWith(t?: string): Promise<boolean> {
    const r = await nodesApi.enroll(t, name.trim() || undefined);
    if (r.enrolled) {
      setOk(true);
      setNote(r.started
        ? '已入网，心跳/中转已启动——本机行即将出现在台账中。'
        : '已入网，但心跳/中转未能在本次起得来（重开桌面即会补起）。');
      onDone();
      return true;
    }
    setOk(false);
    setNote(r.note || '注册未成功。');
    return false;
  }

  async function onInput() {
    const t = token.trim();
    if (!t && !hasToken) { setOk(false); setNote('请先粘贴一枚注册令牌，或用「一键申请」。'); return; }
    setBusy('input'); setNote('');
    try { await enrollWith(t || undefined); }
    catch (e) { setOk(false); setNote((e as Error)?.message || String(e)); }
    finally { setBusy(null); }
  }

  async function onApply() {
    setBusy('apply'); setNote('');
    try {
      const r = await nodesApi.requestToken();
      if (!r.ok) { setOk(false); setNote(r.note || '申请令牌失败——可改用「粘贴令牌」这条路。'); return; }
      await enrollWith(); // 令牌已写回 settings，紧接注册（不带参 ⇒ 用刚存的那枚）
    } catch (e) { setOk(false); setNote((e as Error)?.message || String(e)); }
    finally { setBusy(null); }
  }

  const canRegister = busy === null && (token.trim().length > 0 || hasToken);
  return (
    <div className="mb-5 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
      <div className="text-sm font-medium text-blue-900 mb-1">加入本 ANS 的协同网络</div>
      <p className="text-xs text-blue-800 mb-3">
        本机尚未登记到 ANS 节点台账。两种方式任选其一：<b>粘贴</b>一枚注册令牌，或用本机 ANS 凭据<b>一键申请</b>一枚。
      </p>
      {/* zx_20261012：如实说清**为何**判未入网——凭据仍占位时，本机手里的 key 并非注册所得（判据增②）。 */}
      {reason === 'placeholder-credential' && (
        <p className="text-xs text-blue-800 mb-3">
          本机 ANS 凭据仍是内置占位（<b>非注册所得</b>），故不计为协同网络一员。
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text" value={token} onChange={e => setToken(e.target.value)}
          placeholder="粘贴注册令牌（enr-…）" disabled={busy !== null}
          className="flex-1 min-w-[16rem] px-2 py-1 border rounded text-xs"
        />
        <input
          type="text" value={name} onChange={e => { setName(e.target.value); setNameTouched(true); }}
          placeholder="节点名（同机多实例时用来分辨）" disabled={busy !== null}
          className="w-48 px-2 py-1 border rounded text-xs"
        />
        <button onClick={() => void onInput()} disabled={!canRegister}
          className="text-xs px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
          {busy === 'input' ? '注册中…' : hasToken && !token.trim() ? '用已存令牌注册' : '注册'}
        </button>
        <button onClick={() => void onApply()} disabled={busy !== null}
          className="text-xs px-3 py-1 border border-blue-600 text-blue-700 rounded hover:bg-blue-100 disabled:opacity-50">
          {busy === 'apply' ? '申请中…' : '一键申请'}
        </button>
      </div>
      {note && <p className={`mt-2 text-xs ${ok ? 'text-emerald-700' : 'text-red-600'}`}>{note}</p>}
    </div>
  );
}

/** 留痕结果的徽标色/人话（三态一处——`ok`/`denied`/`error`；未知值如实回原样）。 */
function callResultTone(result: string): string {
  return result === 'ok' ? 'bg-emerald-50 text-emerald-600'
    : result === 'denied' ? 'bg-amber-50 text-amber-600'
      : result === 'error' ? 'bg-red-50 text-red-600' : 'bg-slate-100 text-slate-600';
}
function callResultLabel(result: string): string {
  return result === 'ok' ? '成功' : result === 'denied' ? '被拒' : result === 'error' ? '执行失败' : (result || '—');
}

/** 留痕行里的"朝哪儿使的劲"——`{name|deviceId} · {action}`（有哪样给哪样，不补空）。 */
function callTargetBrief(args: Record<string, unknown>): string {
  const name = typeof args.name === 'string' ? args.name : (typeof args.deviceId === 'string' ? args.deviceId : '');
  const action = typeof args.action === 'string' ? args.action : '';
  return [name, action].filter(Boolean).join(' · ');
}

/**
 * zx_20261014_4 批三（道德经·善闭无关楗而不可开 / 罗尔斯·无知之幕 / 管子·度量衡）: **「门」区块**——
 *   外部 AI 终端接入的**人侧**：开关 → 待审批（显名 + 短码 + 勾能力）→ 已授权（可**吊销**）→ 调用留痕。
 *   ⚠ **凭据不经用户手**：这里只让用户"点同意/不同意"，明文只从门端点**直发**终端（罗尔斯·无知之幕）。
 *   ⚠ 授权闸**缺省给意图、不给原始动作**（zx_20261018_1 D-2）：`intent_control` 默认勾选，
 *     `device_control` 默认不勾——要让终端直发原始动作，用户须**显式**勾；"不勾任何一项"仍是合法选择。
 *   ⚠ **被拒也上屏**：留痕表里 `denied` 行照样列出（`reason` 记判据档位，不写"失败"两个字了事）。
 */
/** 授权到期如实上屏：`null` = 长期（显式设定），过期则标红并说明须重新批准。 */
function GrantExpiry({ at }: { at: string | null }) {
  if (!at) return <span>授权有效期 长期</span>;
  const d = parseDbTime(at);
  const expired = !!d && d.getTime() < Date.now();
  return (
    <span className={expired ? 'text-red-500' : undefined}>
      授权至 {formatDbTime(at)}{expired ? '（已过期，需重新批准）' : ''}
    </span>
  );
}

function DoorCard() {
  // zx_20261018_2 批六：main 侧在开关/新待批/批准/拒绝/吊销后发 `external.status_changed`，
  //   每次门内调用落账后发 `external.call_recorded`——三块数据各自订阅即刷，不再等 5s 轮询。
  const st = useLiveQuery(async () => externalApi.status(), [], { debounceMs: 500, liveTypes: ['external.status_changed'] });
  const list = useLiveQuery(async () => externalApi.list(), [], { debounceMs: 500, liveTypes: ['external.status_changed'] });
  const calls = useLiveQuery(async () => externalApi.listCalls(50), [], { debounceMs: 500, liveTypes: ['external.call_recorded'] });
  // zx_20261023_5 批四：局域网里**看见的**终端（30 秒无广播即散）。
  // zx_20261029_2 M4：浏览**常驻**（随入站门起停），本页只读——不再由 `lanList` 首调兼任开关。
  const lan = useLiveQuery(async () => externalApi.lanList(), [], {
    debounceMs: 500,
    liveTypes: ['external.lan_changed', 'external.status_changed'],
  });
  // 常驻发现的实况（运行中 / 未运行的原因）——门一开就随门而起，不依赖本页是否打开。
  const browse = useLiveQuery(async () => externalApi.lanStatus(), [], {
    debounceMs: 500,
    liveTypes: ['external.lan_changed', 'external.status_changed'],
  });
  const [toggling, setToggling] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  // 勾选态按 `pairingId` 记——一批待批里逐条各勾各的（新来一条不会串味；已处理的条目的勾选自然失效）。
  const [picked, setPicked] = useState<Record<string, string[]>>({});

  const status = st.data;
  const pending = list.data?.pending ?? [];
  const terminals = list.data?.terminals ?? [];
  const caps = list.data?.capabilities ?? [];
  // 勾选框初值由 main 一处真源下发（与 IM 审批同一份 `DEFAULT_TERMINAL_CAPABILITIES`）。
  const defaults = list.data?.defaultCapabilities ?? [];
  const records = calls.data?.calls ?? [];
  const approved = terminals.filter(t => t.status === 'approved');
  const lanItems = lan.data?.items ?? [];

  const reloadAll = () => { void st.reload(); void list.reload(); void calls.reload(); void lan.reload(); void browse.reload(); };
  const capLabel = (id: string) => caps.find(c => c.id === id)?.label ?? id;
  const termName = (id: string) => terminals.find(t => t.id === id)?.name || id.slice(0, 8);

  // **有界兜底轮询**（zx_20261018_2 批六）：事件已覆盖开关/新待批/调用落账（见上方 `liveTypes`），
  //   故常态只需 `FALLBACK_POLL_MS` 兜"崩溃/丢事件"；**门外有待批**时快一拍（`ACTIVE_POLL_MS`）——
  //   外部来人是真实世界事件，短窗兜底仍值得。门关且无待批 ⇒ 不轮询（没有东西会变，不空转）。
  // 待接入列表 30 秒过期是**时间**触发的（没有事件可等）——列表非空时靠这一拍兜底收起过期项。
  const shouldPoll = status?.running === true || pending.length > 0 || lanItems.length > 0;
  const pollMs = pending.length > 0 ? ACTIVE_POLL_MS : FALLBACK_POLL_MS;
  useEffect(() => {
    if (!shouldPoll) return;
    const t = window.setInterval(reloadAll, pollMs);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldPoll, pollMs]);

  async function toggle(on: boolean) {
    setToggling(true); setNote(null);
    try {
      const r = await externalApi.setInbound(on);
      setNote({ ok: r.running === on, text: r.detail });
    } catch (e) { setNote({ ok: false, text: (e as Error)?.message || String(e) }); }
    finally { setToggling(false); reloadAll(); }
  }

  // `fn` 可回一句**下一步人话**（如局域网接入后的核对码）；不回则用通用「已处理。」。
  async function act(key: string, fn: () => Promise<unknown>) {
    setBusyId(key); setNote(null);
    try { const msg = await fn(); setNote({ ok: true, text: typeof msg === 'string' ? msg : '已处理。' }); }
    catch (e) { setNote({ ok: false, text: (e as Error)?.message || String(e) }); }
    finally { setBusyId(null); reloadAll(); }
  }

  // 重签的下一步对用户有用（「等终端下次轮询」），故不用 `act` 的通用「已处理。」盖掉 main 回的那句话。
  async function reissue(t: { id: string; name: string }) {
    setBusyId(t.id); setNote(null);
    try {
      const r = await externalApi.reissue(t.id);
      setNote({ ok: true, text: `${t.name || '该终端'}：${r.message || '旧凭据已作废；新凭据将在终端下次轮询时送达。'}` });
    } catch (e) { setNote({ ok: false, text: (e as Error)?.message || String(e) }); }
    finally { setBusyId(null); reloadAll(); }
  }

  return (
    <div className="mb-5 rounded-lg border border-slate-300 bg-slate-50/60 px-4 py-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="text-sm font-medium text-gray-800 inline-flex items-center gap-1.5"><DoorOpen className="w-4 h-4" />门 · 外部 AI 终端接入</div>
        <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-gray-700">
          <input type="checkbox" checked={status?.enabled ?? false} disabled={toggling || !status}
            onChange={e => void toggle(e.target.checked)} />
          {toggling ? '切换中…' : (status?.enabled ? '已开' : '关闭')}
        </label>
      </div>
      {/* `enabled`（用户意图）与 `running`（真在监听）**分开如实说**——锁定时不被误说成"已开"。 */}
      <p className="mt-1 text-[11px] text-gray-600">{status ? status.detail : '读不到门的实况（IPC 未就绪）…'}</p>
      {/* zx_20261029_2 M4：常驻发现的实况——未运行时把原因如实说出（门未开 / Team 未解锁 / 起不来）。 */}
      <p className="mt-0.5 text-[10px] text-gray-400">
        {browse.data ? `常驻发现：${browse.data.running ? '运行中' : '未运行'} — ${browse.data.detail}` : '常驻发现：读取中…'}
      </p>
      <p className="mt-1 text-[10px] text-gray-400">
        开门后，局域网内的 AI 终端可发现本机并申请配对。批准后它们<b>只能</b>读设备清单（<b>脱敏</b>：只给名字/类型/可做的动作，
        不给网络地址与授权态）并按名字控设备——每一次调用（<b>含被拒</b>）都在下方留痕。
      </p>
      {note && <p className={`mt-1.5 text-[11px] ${note.ok ? 'text-emerald-700' : 'text-red-600'}`}>{note.text}</p>}

      {/* zx_20261023_5 批四：局域网里**看见的** AI 终端——发现 ≠ 接入；点「接入」才走配对。 */}
      <div className="mt-3 pt-3 border-t border-gray-200">
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">局域网发现的终端（{lanItems.length}）</p>
        <p className="text-[10px] text-gray-400">
          {lan.data?.detail ?? '读取中…'}
          {lan.data?.running && <span className="ml-1 text-emerald-600">· 浏览中</span>}
        </p>
        {!lan.data?.locked && lanItems.length > 0 && (
          <div className="mt-1.5 space-y-1.5">{lanItems.map(d => (
            <div key={d.id} className="rounded-lg border border-sky-200 bg-sky-50/60 px-3 py-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm text-gray-800">{d.name}</span>
                <span className="text-[10px] text-gray-500 font-mono">{d.address}{d.port ? `:${d.port}` : ''}</span>
                {d.version && <span className="text-[10px] text-gray-400">v{d.version}</span>}
                <span className="text-[10px] text-gray-400 ml-auto">
                  {Math.max(0, Math.round((Date.now() - d.lastSeenMs) / 1000))} 秒前听到
                </span>
              </div>
              <div className="mt-0.5 text-[10px] text-gray-500">
                能力：{d.capabilities.length ? d.capabilities.join(' / ') : '（未自述——配对后可查）'}
              </div>
              <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                <button disabled={busyId === d.id}
                  onClick={() => void act(d.id, async () => {
                    const r = await externalApi.lanRequest(d.id);
                    return `已转为待批申请——核对码 ${r.pairCode}（请与终端屏幕上显示的 6 位码比对后，在下方点「同意」）。`;
                  })}
                  className="text-[11px] px-2.5 py-0.5 bg-sky-600 text-white rounded hover:bg-sky-700 disabled:opacity-50">
                  {busyId === d.id ? '处理中…' : '接入'}
                </button>
                <button disabled={busyId === d.id}
                  onClick={() => void act(d.id, () => externalApi.lanIgnore(d.id))}
                  className="text-[11px] px-2.5 py-0.5 border border-gray-300 text-gray-600 rounded hover:bg-white disabled:opacity-50">
                  忽略 24 小时
                </button>
                <span className="text-[10px] text-gray-400">看见不等于授权——未批准的终端调不动任何能力。</span>
              </div>
            </div>
          ))}</div>
        )}
        {!lan.data?.locked && lanItems.length === 0 && (
          <p className="text-xs text-gray-400 py-1">暂无——局域网内广播的 AI 终端会出现在这里；30 秒无广播即消失。</p>
        )}
      </div>

      {/* 待审批：显名 + 短码 + 勾能力。 */}
      <div className="mt-3 pt-3 border-t border-gray-200">
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">待审批申请（{pending.length}）</p>
        {pending.length === 0
          ? <p className="text-xs text-gray-400 py-1">暂无待批申请——外部终端发起配对后会出现在这里。</p>
          : <div className="space-y-2">{pending.map(p => {
            const chosen = picked[p.id] ?? defaults;
            return (
              <div key={p.id} className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm text-gray-800">{p.name || '（未具名）'}</span>
                  {p.source === 'lan' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-700">局域网发现</span>}
                  <span className="text-[11px] text-gray-500">核对码
                    <span className="ml-1 font-mono text-base tracking-widest text-amber-800">{p.pair_code}</span>
                  </span>
                  <span className="text-[11px] text-gray-400 ml-auto">申请于 {formatDbTime(p.created_at) || '—'}</span>
                </div>
                <div className="mt-0.5 text-[10px] text-gray-500">
                  来源 {p.last_remote_addr || '未知'} · 请与终端屏幕上显示的 6 位核对码比对，一致再点「同意」
                </div>
                <div className="mt-1.5 flex items-center gap-3 flex-wrap text-[11px] text-gray-700">
                  <span className="text-gray-400">允许能力</span>
                  {caps.map(c => (
                    <label key={c.id} className="inline-flex items-center gap-1" title={`${c.note}${c.invocable ? '' : '（该能力不可经 /invoke 直调，只走意图协议）'}`}>
                      <input type="checkbox" checked={chosen.includes(c.id)}
                        onChange={e => setPicked(prev => {
                          const cur = prev[p.id] ?? defaults;
                          return { ...prev, [p.id]: e.target.checked ? [...cur, c.id] : cur.filter(x => x !== c.id) };
                        })} />
                      {c.label}
                    </label>
                  ))}
                  {chosen.length === 0 && <span className="text-[10px] text-gray-400">（不勾＝只配对，不授予任何能力）</span>}
                </div>
                <ul className="mt-1 space-y-0.5 text-[10px] text-gray-400 list-disc list-inside">
                  {caps.map(c => <li key={c.id}><span className="text-gray-500">{c.label}</span>：{c.note}</li>)}
                </ul>
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <button onClick={() => void act(p.id, () => externalApi.approve(p.id, chosen))} disabled={busyId === p.id}
                    className="text-xs px-3 py-1 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50">
                    {busyId === p.id ? '处理中…' : '同意'}
                  </button>
                  <button onClick={() => void act(p.id, () => externalApi.reject(p.id))} disabled={busyId === p.id}
                    className="text-xs px-3 py-1 border border-gray-300 text-gray-700 rounded hover:bg-white disabled:opacity-50">
                    拒绝
                  </button>
                  <span className="text-[10px] text-gray-400">同意后凭据由本机<b>直发</b>该终端（不经你手），它随即出现在下方「已授权终端」。</span>
                </div>
                {/* 批四：**只管说**——不新增数据流、不新增按钮。人不在电脑前时，同一条申请也能在 IM 里批。 */}
                <p className="mt-1 text-[10px] text-gray-400">不在电脑前？也可在 IM 里回复「同意接入 {p.pair_code}」或「拒绝接入 {p.pair_code}」。</p>
              </div>
            );
          })}</div>}
      </div>

      {/* 已授权终端（可吊销）。 */}
      <div className="mt-3 pt-3 border-t border-gray-200">
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">已授权终端（{approved.length}）</p>
        {approved.length === 0
          ? <p className="text-xs text-gray-400 py-1">尚无已授权终端——同意一条待批申请后会出现在这里。</p>
          : <div className="space-y-2">{approved.map(t => (
            <div key={t.id} className="rounded-lg border bg-white p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm text-gray-800">{t.name || '（未具名）'}</span>
                <span className="text-[11px] text-gray-500 font-mono" title="凭据 key 前缀">{t.key_prefix || '—'}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${t.delivered ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                  {t.delivered ? '凭据已送达' : '凭据未送达（终端尚未取走）'}
                </span>
                {/* 未送达才给「重新签发」：进程重启后内存凭据已失，终端轮询只会回 credentials_lost；
                    这一键让终端**重新拿到一把**（旧钥匙作废），不必吊销重走核对码。 */}
                {!t.delivered && (
                  <button onClick={() => void reissue(t)} disabled={busyId === t.id}
                    title="旧凭据立即作废，铸一把新钥匙；终端下次轮询取走（只回一次）"
                    className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 border border-amber-300 text-amber-700 rounded hover:bg-amber-50 disabled:opacity-50">
                    <RotateCcw className="w-3 h-3" />{busyId === t.id ? '重签中…' : '重新签发凭据'}
                  </button>
                )}
                <button onClick={() => void act(t.id, () => externalApi.revoke(t.id))} disabled={busyId === t.id}
                  className="ml-auto inline-flex items-center gap-1 text-[11px] px-2 py-0.5 border border-red-300 text-red-600 rounded hover:bg-red-50 disabled:opacity-50">
                  <Trash2 className="w-3 h-3" />{busyId === t.id ? '吊销中…' : '吊销'}
                </button>
              </div>
              <div className="mt-1 flex items-center gap-3 flex-wrap text-[10px] text-gray-400">
                <span>能力：{t.capabilities.length ? t.capabilities.map(capLabel).join(' / ') : '（无）'}</span>
                <span>最近活动 {t.last_seen_at ? formatDbTime(t.last_seen_at) : '从未'}</span>
                <span>来源 {t.last_remote_addr || '未知'}</span>
                <span>批准 {formatDbTime(t.approved_at) || '—'}</span>
                <GrantExpiry at={t.grant_expires_at} />
              </div>
            </div>
          ))}</div>}
      </div>

      {/* 外部调用留痕（**含被拒**）——仿 `AuditRow`：显名 + 结果 + 时间。 */}
      <div className="mt-3 pt-3 border-t border-gray-200">
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">外部调用留痕（{records.length}）</p>
        {records.length === 0
          ? <p className="text-xs text-gray-400 py-1">尚无调用——外部终端经门控设备后在此留痕（<b>含被拒</b>：白名单外/未获许可/执行失败各记一行）。</p>
          : <div className="space-y-1.5">{records.map((r: ExternalCallRow) => (
            <div key={r.id} className="flex items-center gap-2 flex-wrap rounded border bg-white px-2 py-1.5 text-xs">
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${callResultTone(r.result)}`}>{callResultLabel(r.result)}</span>
              <span className="text-gray-700">{termName(r.terminal_id)}</span>
              <span className="text-[11px] text-gray-500">{capLabel(r.capability)}</span>
              {callTargetBrief(r.args) && <span className="text-[11px] text-gray-400 font-mono">{callTargetBrief(r.args)}</span>}
              {r.reason && <span className="text-[10px] text-gray-400 font-mono" title="判据档位">{r.reason}</span>}
              <span className="text-[10px] text-gray-300 ml-auto">{formatDbTime(r.created_at)}</span>
            </div>
          ))}</div>}
      </div>
    </div>
  );
}

/**
 * zx_20261023_5 批一（毛选·集中优势兵力 / 维特根斯坦·意义即使用）: **待派任务三分组**。
 *   「可派 / 等待依赖 / 上游已死」不是三个装饰性标签——判据与真派**同一把尺**（`decideCreateDispatch`），
 *   且依赖两组按依赖态本身分类（开关没开时也看得见"在等谁/谁死了"）。
 */
function DispatchBoardCard({ board }: { board: DispatchBoardPayload }) {
  const total = board.eligible.length + board.waiting.length + board.dead.length;
  const groups = [
    { key: 'eligible', title: '可派', hint: '依赖已满足、符合外派条件', tone: 'bg-emerald-50 text-emerald-700 border-emerald-200', items: board.eligible },
    { key: 'waiting', title: '等待依赖', hint: '前置未完成——完成后自动走派发决策', tone: 'bg-amber-50 text-amber-700 border-amber-200', items: board.waiting },
    { key: 'dead', title: '上游已死', hint: '前置已失败/归档——不会自动解锁，须人工处置', tone: 'bg-red-50 text-red-600 border-red-200', items: board.dead },
  ].filter(g => g.items.length > 0);

  return (
    <div className="mb-5 rounded-lg border border-slate-200 bg-white px-4 py-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="text-sm font-medium text-gray-800 inline-flex items-center gap-1.5"><GitBranch className="w-4 h-4" />待派任务 · 按依赖分组</div>
        <span className="text-[10px] text-gray-400">在册 {total} 件（本拍扫描 pending {board.scanned} 件）</span>
      </div>
      {!board.enabled && (
        <p className="mt-1 text-[11px] text-gray-500">「建单即派」未开启——「可派」组恒空；在「设置 · 多机协同编排」开启后，依赖满足的任务会自动外派。</p>
      )}
      {total === 0
        ? <p className="mt-1 text-xs text-gray-400">暂无待派任务——新建任务且依赖（若有）已满足时，会出现在这里。</p>
        : (
          <div className="mt-2 space-y-2">
            {groups.map(g => (
              <div key={g.key}>
                <p className="text-[11px] text-gray-500 mb-1">{g.title}（{g.items.length}）<span className="text-gray-400"> · {g.hint}</span></p>
                <div className="space-y-1">
                  {g.items.map(it => (
                    <div key={it.taskId} className="flex items-center gap-2 text-xs">
                      <span className={`shrink-0 px-1.5 py-0.5 rounded border ${g.tone}`}>{g.title}</span>
                      <span className="truncate text-gray-700" title={it.taskId}>{it.title || it.taskId.slice(0, 8)}</span>
                      <span className="text-gray-400 shrink-0">{it.projectName || it.projectId.slice(0, 8)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

/** 0–1 → 百分比；`null` 如实 `—`（不知道不伪造成 0%）。 */
function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

/** 耗时毫秒 → 人话；`null` 如实 `—`。 */
function latencyText(ms: number | null): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function ClusterStat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-md bg-gray-50 px-3 py-2">
      <div className={`text-lg font-semibold leading-tight ${tone ?? 'text-gray-900'}`}>{value}</div>
      <div className="text-[11px] text-gray-500">{label}</div>
    </div>
  );
}

/** 逐节点一行（集群卡展开后）——只放上屏用得到的数，不知道的一律 `—`。 */
function ClusterNodeRow({ n }: { n: ClusterNode }) {
  const caps = n.capabilities.map(c => NODE_CARD_CATEGORY_LABEL[c]).join(' / ') || '未上报能力';
  return (
    <div className={`text-xs px-2 py-1.5 rounded ${n.local ? 'bg-indigo-50/60' : 'bg-gray-50'}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`w-2 h-2 rounded-full shrink-0 ${n.online ? 'bg-emerald-500' : 'bg-gray-300'}`} />
        <span className="font-medium text-gray-800 truncate max-w-[14rem]" title={n.name}>{n.name}</span>
        {n.local && <span className="text-[10px] px-1 rounded bg-indigo-100 text-indigo-700">本机</span>}
        <span className="text-gray-400">{NODE_ROLE_LABEL[n.role]}{n.tier ? ` · ${n.tier}` : ''}</span>
        {!n.online && <span className="text-gray-400">离线</span>}
        {n.atCapacity && <span className="text-amber-700 font-medium">满载</span>}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-500">
        <span>{n.online ? '在线' : '离线'} · 槽位 {n.freeSlots ?? '—'} · 运行 {n.running ?? '—'} · 排队 {n.queued}</span>
        <span>CPU {n.cpu != null ? `${n.cpu}%` : '—'} · 内存 {pct(n.mem)} · 磁盘 {pct(n.disk)}</span>
        <span>成功率 {pct(n.successRate)} · 延迟 {latencyText(n.latency)}</span>
        <span className="text-gray-400">能力：{caps}</span>
      </div>
    </div>
  );
}

/**
 * zx_20261030_1 M4「认」: **集群概览卡**——一屏四数（在线 / 运行中 / 排队 / 满载）+ 瓶颈一句话，
 *   逐节点详情默认收起（米勒 7±2：先给"需要你知道的"）。数取 main 纯函数 `buildClusterView`，
 *   本组件只摆盘不另算（聚合与逐行同源，防两处各记各的）。
 */
function ClusterCard({ view }: { view: NodesClusterPayload }) {
  const [open, setOpen] = useState(false);
  const t = view.totals;
  return (
    <div className="mb-4 rounded-lg border border-gray-200 bg-white px-4 py-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">集群一屏</p>
        <button type="button" onClick={() => setOpen(v => !v)} className="text-[11px] text-blue-600 hover:underline">
          {open ? '收起逐节点' : `逐节点详情（${view.nodes.length}）`}
        </button>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-2">
        <ClusterStat label="在线" value={t.online} tone={t.online > 0 ? 'text-emerald-600' : 'text-gray-500'} />
        <ClusterStat label="运行中" value={t.running} />
        <ClusterStat label="排队" value={t.queued} tone={t.queued > 0 ? 'text-amber-600' : undefined} />
        <ClusterStat label="满载" value={t.atCapacity} tone={t.atCapacity > 0 ? 'text-red-600' : 'text-gray-500'} />
      </div>
      {view.bottlenecks.length > 0 && (
        <p className="mt-2 text-xs text-amber-700">瓶颈：{view.bottlenecks.join('；')}</p>
      )}
      {view.error && (
        <p className="mt-1 text-xs text-red-600">台账读取失败：{view.error}（下方本机计数为本地实时读）</p>
      )}
      {open && (
        <div className="mt-3 space-y-1.5 border-t border-gray-100 pt-2">
          {view.nodes.length === 0
            ? <p className="text-xs text-gray-400 py-2">还没有任何节点。</p>
            : view.nodes.map(n => <ClusterNodeRow key={n.id} n={n} />)}
        </div>
      )}
    </div>
  );
}

export default function PeersPage() {
  const nowMs = useTick();
  // zx_20261011_3: 「移出网络」失败时的如实上屏（不清空即一直显示，成功/重试时清）。
  const [removeErr, setRemoveErr] = useState<string | null>(null);
  // zx_20261018_1 批一: 首次入网的一次性引导（Team 才问；问过即不再出现）。
  const [onboardBusy, setOnboardBusy] = useState(false);
  const [onboardErr, setOnboardErr] = useState<string | null>(null);
  // liveTypes 是**刷新触发**，不是数据源：两类事件都只让本页**重新向 ANS 取台账**——
  //   数据仍只有 ANS 一个来源（M6）。`node.heartbeat` 是必须的：心跳每 ~30s 更新 `last_seen_at`，
  //   不据此刷，本机在线点在 90s（NODE_OFFLINE_SEC）后会假性转灰。
  const q = useLiveQuery(async () => nodesApi.list(), [], {
    liveTypes: ['node.presence_changed', 'node.heartbeat'],
    debounceMs: 700,
  });
  const data = q.data;
  // M13：AI 终端**调用记录**（纯本地读 `wa_event_log` 聚合，不触网）。`liveTypes` 是刷新触发——
  //   到场/收口各一条持久化事件（M12 的 worker 发出），命中即重取本机事件投影。
  const reqs = useLiveQuery(async () => nodesApi.requests(), [], {
    liveTypes: ['node.request_received', 'node.request_completed'],
    debounceMs: 700,
  });
  const records = reqs.data?.records ?? [];
  // zx_20261010_1 M4（维特根斯坦·意义即使用）: 本机**入网态**（纯本地读，不触 ANS）——入职卡据 `enrolled`
  //   决定显不显示。与 `q` 同触发刷新：注册成功广播 `node.presence_changed`，两个查询一起复取。
  const es = useLiveQuery(async () => nodesApi.enrollState(), [], {
    liveTypes: ['node.presence_changed'],
    debounceMs: 700,
  });
  // zx_20261017_1 批三: 建单即派开关 + 最近一次自动外派（纯本地读；开关本体在「设置 · 多机协同编排」）。
  const auto = useLiveQuery(async () => nodesApi.autoDispatch(), [], {
    liveTypes: ['node.request_dispatched'],
    debounceMs: 700,
  });
  // zx_20261023_5 批一: 待派任务三分组——纯本地读；上游收口（task.completed/task.failed）与派发发生时会变，故订阅这几类。
  const board = useLiveQuery(async () => nodesApi.dispatchBoard(), [], {
    liveTypes: ['node.request_dispatched', 'node.presence_changed', 'task.completed', 'task.failed'],
    debounceMs: 700,
  });
  // zx_20261030_1 M4「认」: 集群一屏（本机 + 对端汇总）。在线/槽位随心跳变，运行/排队随任务与派发变。
  const cluster = useLiveQuery(async () => nodesApi.cluster(), [], {
    liveTypes: ['node.presence_changed', 'node.heartbeat', 'node.request_dispatched', 'node.request_result', 'task.status_changed', 'task.completed', 'task.failed'],
    debounceMs: 700,
  });
  // zx_20261005 M22（Team 档软闸）：锁定则整页只显示升级提示（导航项仍保留，见方案批六 M22）。
  const gate = data?.gate ?? null;
  const localId = data?.localNodeId ?? null;
  const localNode = data?.nodes.find(n => n.node_id === localId) ?? null;
  const others = (data?.nodes ?? []).filter(n => n.node_id !== localId);
  // zx_20261011_2 M4（名实·知行合一）: 派活候选**按能被派的判据**先收窄——`isDispatchable`（参与 ∧ 非观察者）
  //   ∧ 在线。此前把 `others` 原样喂进下拉：观察者/未参与/离线的他机**照样列得出来**，选中提交才被 ANS 拒
  //   （E2E ③ 实测：B 已转观察者，A 的窗口里它仍在）。**分组仍用 `others`**（面板要如实展示所有邻居，包括
  //   在线的观察者）——只收窄"可派给谁"。离线的以"自动"兜底留路：ANS 侧可挂起待其上线。
  const dispatchCandidates = others.filter(n => isDispatchable(n) && isNodeOnline(n.last_seen_at, nowMs));
  // 分组顺序**由枚举派生**（不手写角色列表）——加一档（本轮明令不加）时这里自动多一组。
  const groups = NODE_ROLES.map(role => ({ role, peers: others.filter(n => n.role === role) })).filter(g => g.peers.length > 0);
  // zx_20261011 M4: 出站台账里目标节点 id → 名字（用同一份台账解，不另取）。
  const nameOf = (id: string) => data?.nodes.find(n => n.node_id === id)?.name || '';

  // zx_20261011_3: 把一台**离线他机**移出协同网络（`nodes:delete` ⇒ ANS 硬删除 + 吊销其 key）。
  //   确认文案**说清后果**（不是"删一行"那么轻）——对方对 ANS 的全部调用将失效，需重新入网。
  /**
   * 一次性**告知**（zx_20261029_2 M7：询问 → 告知）：Team 已解锁 ∧ 已入网 ∧ **此刻确由缺省开着** ∧ 尚未告知。
   * 判据在 main 一处（`shouldPromptAutoDispatch`），此处只按如实状态摆卡片——不自行推导"该不该说"。
   * 显式设置过的（用户自己的选择）不再打扰；社区/Pro 永不出现。
   */
  const showOnboard = !!gate?.unlocked && es.data?.enrolled === true
    && !!auto.data && auto.data.enabled && auto.data.policy.source === 'default' && !auto.data.prompted;
  async function answerOnboard(accept: boolean) {
    setOnboardBusy(true); setOnboardErr(null);
    try {
      await nodesApi.confirmAutoDispatch(accept);
      void auto.reload();
    } catch (e) {
      setOnboardErr((e as Error)?.message || String(e));
    } finally { setOnboardBusy(false); }
  }

  async function removePeer(n: AnsNode) {
    const label = n.name || n.node_id.slice(0, 8);
    const okToRemove = window.confirm(
      `把「${label}」移出协同网络？\n\n· 从 ANS 台账删除该节点行；\n· 吊销该节点的 key——对方对 ANS 的全部调用将失效（401），需用新令牌重新入网。\n\n离线节点通常无法自行响应此操作。`,
    );
    if (!okToRemove) return;
    setRemoveErr(null);
    try {
      await nodesApi.remove(n.node_id);
    } catch (e) {
      setRemoveErr(`移出「${label}」失败：${(e as Error)?.message || String(e)}`);
    } finally {
      void q.reload();
    }
  }

  if (q.loading && q.data == null) return <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" /></div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">协同面板</h2>
        <div className="flex items-center gap-2">
          <FreshnessPill q={q} />
          <button onClick={() => void q.reload()} className="p-2 hover:bg-gray-100 rounded-lg"><RefreshCw className="w-4 h-4" /></button>
        </div>
      </div>

      {gate && !gate.unlocked ? (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3">
          <div className="text-sm font-medium text-indigo-800 mb-1">「多机协同」属于团队版能力</div>
          <div className="text-xs text-indigo-700">{gate.detail}</div>
        </div>
      ) : (<>
      {data?.error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          读不到 ANS 节点台账：{data.error}
        </div>
      )}
      {removeErr && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {removeErr}
        </div>
      )}

      {/* zx_20261030_1 M4「认」: 集群一屏——先给"现在卡在哪"（在线/运行中/排队/满载 + 瓶颈），逐节点可展开。 */}
      {cluster.data && <ClusterCard view={cluster.data} />}

      {/* zx_20261017_1 批三: 建单即派状态——开关在「设置 · 多机协同编排」；此处**如实**显示开/关、
          来由（缺省替用户开 / 用户自己设的）与最近一次自动外派。
          未读到（`auto.data == null`）不渲染，不把"还没读到"显示成"未开启"。 */}
      {auto.data && (
        <div className={`mb-4 rounded-lg border px-3 py-2 text-xs ${auto.data.enabled ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-gray-200 bg-gray-50 text-gray-600'}`}>
          <span className="font-medium">建单即派：{auto.data.enabled ? '已开启' : '未开启'}</span>
          <span>　{auto.data.policy.reason}。</span>
          {auto.data.enabled
            ? (auto.data.last
              ? <span>　最近一次：{formatDbTime(auto.data.last.at)} 派给 {nameOf(auto.data.last.nodeId) || auto.data.last.nodeId.slice(0, 8)}（类目 {auto.data.last.category}）</span>
              : <span>　还没有自动外派记录——本机满负荷时，符合条件的新任务会先预查在线对端，预查无果则留在本机。</span>)
            : <span>　开启后，本机满负荷时符合条件的新建任务会交给擅长这类活的对端；可在「设置」页切换。</span>}
        </div>
      )}

      {/* zx_20261018_1 批一: 首次满足条件的**一次性告知**（zx_20261029_2 M7：询问→告知）——说过即不再出现。 */}
      {showOnboard && (
        <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2.5 text-xs text-blue-900">
          <div className="font-medium">已为本机开启「建单即派」：仅在本机满负荷时溢出到其他节点</div>
          <div className="mt-0.5 text-blue-800">
            团队版已解锁且本机已入网，因此默认替你打开了它——本机跑得动就先在本机跑，跑满了才把新任务交给擅长这类活的对端。
            只外派无父、无依赖、无附件、项目未指定本机工作目录的任务；其余一律留在本机。
          </div>
          {onboardErr && <div className="mt-1 text-red-600">{onboardErr}</div>}
          <div className="mt-1.5 flex items-center gap-2">
            <button onClick={() => void answerOnboard(true)} disabled={onboardBusy}
              className="px-2.5 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
              {onboardBusy ? '处理中…' : '知道了'}
            </button>
            <button onClick={() => void answerOnboard(false)} disabled={onboardBusy}
              className="px-2.5 py-1 border border-blue-300 text-blue-800 rounded hover:bg-white disabled:opacity-50">
              一键关闭
            </button>
            <span className="text-[10px] text-blue-600">以后可在「设置 · 多机协同编排」随时改。</span>
          </div>
        </div>
      )}

      {/* zx_20261014_4 批三: 「门」区块（外部 AI 终端接入的人侧）——先开门，才谈得上接入。
          与 ANS 入网无关（门是**本机**的入站服务），故**不**要求 `localNode` 在场。 */}
      <DoorCard />

      {/* zx_20261011 M4: 「派活」卡——只在**本机已入网**（台账有本机行）时给；派发方须有身份。 */}
      {localNode && <DispatchCard candidates={dispatchCandidates} onDone={() => void q.reload()} />}

      {/* zx_20261023_5 批一: 待派任务三分组（可派 / 等待依赖 / 上游已死）——不再只有一个在线列表。 */}
      {localNode && board.data && <DispatchBoardCard board={board.data} />}

      {localNode
        ? <div className="mb-5">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">自知者明 · 本机</p>
            <NodeRow node={localNode} local localRole={localNode.role} localNodeId={localId} nowMs={nowMs} onSaved={() => void q.reload()} />
          </div>
        // zx_20261011_3（名实）: 本机**以为**已入网（`enrolled`），而 ANS 回 401/403 ⇒ 凭据被拒。
        //   很可能是本机已被移出协同网络（`node.resource_group` 是**本地**设置，ANS 删除动不了它 ⇒ `enrolled`
        //   仍为 true）。此时**绝不**再说"等待台账收录"（那行永远不会来），改一条如实且**可行动**的说明。
        : (es.data?.enrolled === true && (data?.errorStatus === 401 || data?.errorStatus === 403))
          ? <div className="mb-5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              本机凭据被 ANS 拒绝（HTTP {data?.errorStatus}）——若本机已被移出协同网络，需由网络内其他节点签发新令牌、粘贴新令牌后重新入网。
            </div>
          // 其余：**必须**真读到台账（`data` 存在且无 `error`）才谈得上"等收录"——否则 `data===undefined`
          //   时 `!data.error` 为真会落进分支、显示"心跳上报后即出现"这条**假承诺**（那行永远不会来）。
          : data && !data.error && (
            es.data?.enrolled === false
              // zx_20261010_1 M4: 未入网 ⇒ 入职卡（粘贴令牌 / 一键申请两条路；此前只有一句无路可走的空提示）。
              ? <EnrollCard hasToken={es.data.hasToken} initialName={es.data?.name ?? ''} reason={es.data?.reason} onDone={() => { void q.reload(); void es.reload(); }} />
              : es.data?.enrolled === true
                // 已入网但台账暂无本机行 ⇒ 首次心跳尚未落库（正常瞬时态）——如实说"已入网、等收录"。
                ? <div className="mb-5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
                    本机已入网，等待 ANS 台账收录本机行（心跳上报后即出现）。
                  </div>
                // 入网态尚未读到 ⇒ 不显示，避免闪一下本不该出现的卡片。
                : null
          )}

      {groups.length === 0
        ? <p className="text-gray-400 text-center py-8">暂无其他工蚁节点</p>
        : groups.map(g => (
          <div key={g.role} className="mb-5">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">{NODE_ROLE_LABEL[g.role]}（{g.peers.length}）</p>
            <div className="space-y-2">
              {g.peers.map(n => <NodeRow key={n.node_id} node={n} local={false} localRole={localNode?.role ?? null} localNodeId={localId} nowMs={nowMs} onSaved={() => void q.reload()} onRemove={() => void removePeer(n)} />)}
            </div>
          </div>
        ))}

      {/* zx_20261011 M4: 本机**派出去**的活（出站台账，与下方入站记录对照）。 */}
      <DispatchLedger nameOf={nameOf} />

      {/* M13：外客（AI 终端）经 ANS 派来的请求在此留痕——被谁派、办成没办成、耗时多久，一面可看。 */}
      <div className="mt-6 pt-5 border-t border-gray-200">
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
          AI 终端调用记录（{records.length}）
        </p>
        {records.length === 0
          ? <p className="text-xs text-gray-400 py-3">尚无调用记录——外部终端经 ANS 派来的请求会在此留痕（到场/收口各一条）。</p>
          : <div className="space-y-2">{records.map(r => <CallRecordRow key={r.requestId} rec={r} />)}</div>}
      </div>
      </>)}
    </div>
  );
}
