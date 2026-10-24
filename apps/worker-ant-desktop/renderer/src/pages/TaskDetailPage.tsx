import { useState, useEffect, useRef, Fragment, type ReactNode } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { tasks, projects, admin, nodes, invoke, IpcError, newClientRequestId, type DispatchReasonView } from '../lib/ipc';
import { useSettings } from '../lib/settingsStore';
import { useDeliverableDrawer } from '../lib/deliverableDrawer';
import { ArrowLeft, Play, Pause, RotateCcw, Plus, RefreshCw, GitBranch, Package as PackageIcon, MessageSquare, TrendingUp, Clock, AlertTriangle, History, Activity, Brain, Edit, Check, Trash2, FileText, Target, Eye, X, Star, ChevronDown, ChevronRight, Paperclip, Folder, Archive } from 'lucide-react';
// zx_20260910_3 M3(G3): 布尔 setting 判据**两侧共用同一文件**——渲染层不再自带第二份写法
import { boolSetting } from '../../../src/main/core/settings-bool.js';
// zx_20260913 M2-6(G8 教训): 类型集合判据跨 root 引**同一份代码**——此前本页 `d.type==='doc'` 手抄 2 处
import { isPreviewType } from '../../../src/main/core/deliverable-types.js';
// zx_20260915 P0-2(d): 验收未核验成因**词表**跨 root 引同一份（同 G8 的治法，见下方 ACCEPTANCE_REASON_LABEL）
// zx_20260923_1 M2: 「有题未判成」分型的**同一个真源**——本页不得自己判 `reason==='error'||…` 三码清单
//   （承本仓纪律：renderer 是词表的第二个落点，须跨 root 引真函数）。
import { UNVERIFIED_REASON_LABEL, isUnjudgedReason, type AcceptanceCheckLike } from '../../../src/main/core/acceptance-check.js';
// zx_20260915 P0-1: 暂停成因码同理——横幅分型读 main 侧同一常量，不在渲染层手抄 'no_output'
// zx_20260917 M2: 另二十个码的人话也同源——`pauseReasonLabel` 是词表唯一一处，`recordedPauseReason`
// 是"读出账上因由原文"的唯一读点；此前横幅只认得 `no_output`，其余一律显示"已暂停"，用户在 GUI 同样读不到因。
import { PAUSE_REASON_NO_OUTPUT, pauseReasonLabel, recordedPauseReason } from '../../../src/main/core/pause-reason.js';
// zx_20260914 M2-1(王阳明·知行合一): 正文「读得动」——本页预览块与列表页/抽屉共用同一渲染器
import MarkdownSubset from '../lib/markdown-subset';
// zx_20260913 M3-5/M3-4: 前置阻塞态判据与"序号→id"映射的**唯一真源**（renderer 是词表的第二个落点，故跨 root 引同一份代码）
import { depBlockInfo } from '../../../src/main/core/dep-graph.js';
// zx_20260916_3 M5（O-F）：引擎代拟消息的识别**同一个真源**（同上一行范式）。这些行 role 仍是 'user'
//（改了会被恢复回放逐字跳过、反馈送不到执行体），故只能按**内容首标**认——此处直接引真函数，不另抄一份词表。
import { isEngineDraftedTurn } from '../../../src/main/core/turn-authorship.js';
// zx_20260924 M7(G8/G9 老病): 「本次附件」的去向词表**跨 root 引同一份**——去向的中文（内联/未内联/失败）
//   与取值集合都是 `attachment-outcome.ts` 一处，本页不得再写一份 `inlined→「…」` 的映射。
//   件与原因**原样展示**（`reason` 是各支路当场给出的真因，如 `cid_unsupported：可读字符占比 1.7% < 60%`），
//   任何"归一成几个大类"的加工都会磨掉用户据以判断"这份 PDF 还能不能救"的那句话，且必然是第二份词表。
import { parseAttachmentOutcomeViews, ATTACHMENT_STATUS_LABEL, type AttachmentOutcomeStatus } from '../../../src/main/core/attachment-outcome.js';
// zx_20260924 §2c UI-3: 产出物按盘上路径分目录层级展示——**树构建是 main 侧零依赖模块**（同上一行范式），
//   本页只负责"摆"。（它承载两条规则：公共前缀要剥、没有路径的件不许塞进假目录；规则须可被 rr 两侧标本钉住。）
import { buildDeliverableTree, type DeliverableTreeChild } from '../../../src/main/core/deliverable-tree.js';
// zx_20260930 M3-e: 「[等待用户输入] … [选项: A / B]」的**解析**跨 root 引真源——本页此前自带第二份
//   split（只认 `,`/`|`），与 IM/门禁侧的六种分隔不是同一套 ⇒ 同一条消息两处读出不同的选项个数。
import { OPTION_BLOCK_RE, parseOptions } from '../../../src/main/core/im/options.js';
import { formatDbTime, DELIVERABLE_STATUS_LABEL } from '../lib/deliverable-view';
// zx_20260930 M4-4: 任务状态词表**唯一真源**（本页此前手抄一份——investigating 只有本页有）
import { TASK_STATUS_LABEL, statusText } from '../lib/status-view';
// zx_20260930 M4-2: 列表**批次大小**与"这一批之后还有没有下一页"的判据，与成果页/项目详情页**同一份**
//   （renderer 是词表的第二个落点，故不得在本页再写一遍 `rows.length < 100`）。
import { LIST_PAGE_SIZE, pageExhausted } from '../lib/list-page';
// zx_20261011_4 M4: 外派徽标的人话（`orchestrationLabel`）与 N5 如实边界文案（`REMOTE_RESULT_CAVEAT`）
//   取协同展示域**一处真源**（renderer 是词表的第二个落点，须跨 root 引真函数，不在页面里手抄）。
import { orchestrationLabel, REMOTE_RESULT_CAVEAT, type RemoteTaskBadge } from '../lib/node-view';
// zx_20261016_3 M33-b（四因·目的因）: 「哪几因叫什么名字、算不算缺」取**一处真源**（`core/four-causes.ts`，
//   零 import 故跨 root 引得动，与 `healing-outcome.ts` 同形）——本页不得手抄四因词表。
import { fourCauseOf } from '../../../src/main/core/four-causes.js';

interface TaskItem { id: string; project_id: string; title: string; description: string; status: string; priority: number; source: string; parent_task_id?: string; depends_on?: string; acceptance_criteria?: string; context_json?: string; aggregate_version?: number; created_at: string; updated_at: string; }
interface ConvItem { id: string; role: string; content: string; tool_calls?: string; token_count?: number; created_at: string; }
// zx_20260911_2 M4b(Q1 名实相符·展示补齐): task:get 以 SELECT * 取产出物行 ⇒ is_primary/acceptance_verified 本就在载荷中(字段可读而无人读)
interface DelivItem { id: string; name: string; type: string; status: string; file_path?: string; created_at: string; is_primary?: number; acceptance_verified?: number;
  // zx_20260913 M2-1/M2-2: task:get 改子树聚合后逐条回传"归属任务"与"还有谁写过"（前者=名实，后者=引用）
  owner_task_id?: string | null; owner_task_title?: string | null; other_writers?: Array<{ id: string; title: string }>; }

const STATUS_COLOR: Record<string, string> = { pending:'bg-gray-100 text-gray-600', preparing:'bg-blue-100 text-blue-600', executing:'bg-yellow-100 text-yellow-700', running:'bg-yellow-100 text-yellow-700', completed:'bg-green-100 text-green-700', failed:'bg-red-100 text-red-600', paused:'bg-orange-100 text-orange-600', /* zx_20260930 M11-5: `stabilizing` 原无档 ⇒ 徽标落灰底(与"不认识的态"混同)；帛色与"暂停/待确认"同族但更浅 */ stabilizing:'bg-amber-50 text-amber-700', /* zx_20261012_2 批二: `archived`（归档/放弃）同落灰底——与 failed 的红底刻意区分：弃 ≠ 败 */ archived:'bg-gray-200 text-gray-600' };
const PRIORITY_LABEL: Record<number, string> = { 0:'普通', 1:'优先', 2:'紧急', 3:'最高' };
// zx_20260910_1 M1: 等待输入的决策类型标签（原 DecisionCard 的 TYPE_LABEL 上移，随卡片一并成为横幅的能力）
const AWAIT_TYPE_LABEL: Record<string, string> = { ask_user:'询问', path_approval:'路径审批', privilege_approval:'特权审批', pending_confirmation:'待确认事项' };
// zx_20260924 M7: 附件去向的**色档**。它**不是词表**——一个用户可见的字都不含，文案一律取 main 的
//   `ATTACHMENT_STATUS_LABEL`。之所以用 `Record<AttachmentOutcomeStatus, string>` 而非手抄三态：
//   main 侧将来加第四态时这里**编译期**就报错，不会静默渲染成一片留白。
const ATT_TONE: Record<AttachmentOutcomeStatus, string> = { inlined:'bg-green-100 text-green-700', omitted:'bg-gray-100 text-gray-600', failed:'bg-red-100 text-red-600' };

function formatToken(n: number | undefined | null): string { if (!n) return '0'; if (n>=1_000_000) return (n/1_000_000).toFixed(2)+'M'; if (n>=1_000) return (n/1_000).toFixed(1)+'K'; return String(n); }
function formatTime(s: string | undefined | null): string {
  // 库内时间列是 UTC 且不带 Z——补 Z 的写法只此一份（在 lib/deliverable-view 里），本页不再另抄
  if (!s) return '-';
  return formatDbTime(s) || s;
}
function formatDuration(ms: number): string { if (!ms || ms <= 0) return '-'; if (ms < 1000) return `${ms}ms`; const s = ms / 1000; if (s < 60) return `${s.toFixed(1)}s`; return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`; }
function toolNamesFromStr(s: string): string[] { const names: string[] = []; const re = /([a-z][a-z0-9_]*)\s*\(/g; let m: RegExpExecArray | null; while ((m = re.exec(s)) !== null && names.length < 4) { const n = m[1]!; if (!names.includes(n)) names.push(n); } return names; }

// zx_20260910_3 M1: 验收未核验成因码 → 人可读短语
// zx_20260915 P0-2(d)(维特根斯坦·意义即用法): 该词表**一处真源**——此前这里是 main 侧
// `UNVERIFIED_REASON_LABEL` 的手抄副本（注释自称"同义"，而那正是"名单与判据分家"本身）。
// 改为直接引 main 侧同一份（该模块只 `import type Database`，无运行时依赖，可跨端引入）；
// `Record<string,string>` 放宽索引类型仅因存量载荷的 reason 可能是已废弃的字符串。
const ACCEPTANCE_REASON_LABEL: Record<string, string> = UNVERIFIED_REASON_LABEL;

// E2 (2026-09-04_2): 任务"扬弃小结"——tasks:digest 返回的只读事实聚合
interface DigestInfo {
  taskId: string; status: string; steps: number; deviations: number; signals: number; memoryInjections: number;
  goalIdentified: boolean; quality: number | null; feedback?: string | null; tokens: number;
}
interface FamilyDigestSum { steps: number; deviations: number; signals: number; memoryInjections: number; failed: number; lowQuality: number }

function digestLineText(d: { status: string; steps: number; deviations: number; signals: number; memoryInjections: number; quality?: number | null; failed?: number }): string {
  const resolved = d.status === 'completed' ? '偏离已回正' : d.status === 'failed' ? '未达终态·偏离待处理' : '偏离处理中';
  const parts = [
    `${d.steps} 步`,
    `偏离 ${d.deviations}（${resolved}）`,
    `记忆注入 ${d.memoryInjections}`,
    `执行信号 ${d.signals}`,
  ];
  if (d.failed) parts.push(`${d.failed} 子失败`);
  if (d.quality != null) parts.push(`质量 ${d.quality} 分`);
  return parts.join(' · ');
}

// zx_20261018_3 D7（组2 实机照出）: 操作栏「同一坐标换成反向动作」的两条治法。
//   1) 固定槽位：空槽也用等宽占位撑住——状态一翻，按钮不会左移右移，手停在原坐标上。
//   2) 定高流式块：思考/生成内容一直增长会把下方操作栏顶走——当时用定高 + 内容贴底滚动。
function ActionSlot({ children }: { children?: ReactNode }) {
  return <span className="inline-flex shrink-0 items-center justify-center w-[92px]">{children}</span>;
}
function StreamPane({ className, title, children }: { className: string; title?: string; children: ReactNode }) {
  return <div className={className} title={title}>{children}</div>;
}
// zx_20261018_3 D9（组5 实机照出）: 思考/实时状态/心跳三个块是**整块挂载/卸载**的，块内定高管不住
//   外层位移——操作栏仍被反复顶走。D11（组6 实机反馈）: 该块已移到操作栏**下方**，高度变化不再影响
//   任何按钮坐标。D13（组6 二次实机反馈）: 既然按钮在它上面，就**不再限高、不再块内滚动**——
//   思考/生成内容随页面自然撑开，滚动只有页面这一条（原先 max-h 260px 仍会在思考时冒出内滚动条）。
function LivePane({ children }: { children: ReactNode }) {
  return <div className="mt-2 space-y-2">{children}</div>;
}

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // zx_20260909 X1(就地成果抽屉): 产出 doc 行加"版本流详情"入口(deliverable.doc_drawer 门控), 与既有 preview(eye) 并存
  const settings = useSettings();
  const drawerOn = boolSetting(settings['deliverable.doc_drawer']);
  // zx_20260911_2 M4b(Q1): 验收徽标与列表/IM同受 show_acceptance 门控（同一开关两入口同效，不另立判据）
  const showAccD = boolSetting(settings['deliverable.show_acceptance']);
  // zx_20260909_1 M4(Z1 为之于未有): plan.link_at_create=false 隐藏新建表单"关联方案"下拉(仅留详情页事后关联)
  const linkOnZ = boolSetting(settings['plan.link_at_create']);
  const { open: openDeliv } = useDeliverableDrawer();
  const [projectName, setProjectName] = useState('');
  const [taskList, setTaskList] = useState<TaskItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [task, setTask] = useState<TaskItem | null>(null);
  const [convs, setConvs] = useState<ConvItem[]>([]);
  const [delivs, setDelivs] = useState<DelivItem[]>([]);
  // zx_20260930 M4-2: 对话与成果两列表各自**真分页**（`task:get` 的 `convLimit/convOffset` 与
  //   `delivLimit/delivOffset`，另回 `conversationsTotal`/`deliverablesTotal`）。
  //   `*Total` 是**服务端全量口径**：真库对话链已 2.6 万行，只印"已加载的条数"会把"还没取"
  //   说成"就这么多"（同一页的"统计"格子与折叠头都写的是"有多少条"）。
  const [convTotal, setConvTotal] = useState(0);
  const [delivTotal, setDelivTotal] = useState(0);
  const [convExhausted, setConvExhausted] = useState(true);
  const [delivExhausted, setDelivExhausted] = useState(true);
  const [convMoreBusy, setConvMoreBusy] = useState(false);
  const [delivMoreBusy, setDelivMoreBusy] = useState(false);
  // zx_20260906_1 3e: 本任务已退休(重试旧版)成果计数——task:get 回传，消除"当前成果空=无成果"的信息差
  const [retiredCount, setRetiredCount] = useState(0);
  // zx_20261023_5 批一: 派单理由三行（读不到就整块不显示，不猜"能不能派"）。
  const [dispatchView, setDispatchView] = useState<DispatchReasonView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newTask, setNewTask] = useState({ title: '', description: '', acceptance_criteria: '', planTaskId: '' });
  // zx_20260914 M0.6: 子任务创建同样两层——在途标志（体验）+ 本次表单会话的幂等键（判据层输入）。
  const [creating, setCreating] = useState(false);
  const createReqIdRef = useRef('');
  // 一次表单会话 = 一次用户意图 ⇒ 打开面板时生成一个键，会话内所有提交共用它（与任务页同尺）。
  useEffect(() => { if (showCreate) createReqIdRef.current = newClientRequestId(); }, [showCreate]);
  const [stepInfo, setStepInfo] = useState('');
  const [events, setEvents] = useState<Array<Record<string, unknown>>>([]);
  const [showContext, setShowContext] = useState(false);
  const [ctxForm, setCtxForm] = useState({ max_tokens_per_task: '', max_cost_usd_per_task: '' });
  const [similarTasks, setSimilarTasks] = useState<Array<Record<string, unknown>>>([]);
  const [showReply, setShowReply] = useState(false);
  const [replyText, setReplyText] = useState('');
  // zx_20260923 M7-c（G15）: 暂停横幅内在联附言（与模态框的 replyText **各管各的**，互不串）
  const [bannerReply, setBannerReply] = useState('');
  // zx_20260910_1 M4: 应答提交中——按钮禁用防连点重复提交（main 侧另有幂等判据兜底，此为界面侧第一道）
  const [submitting, setSubmitting] = useState(false);
  // zx_20261018_3 D7（组2 实机照出）：操作栏的「暂停」与「恢复」在同一槽位——状态一翻，同一坐标的
  //   按钮就换成了反向动作；一次双击/延迟点击会「第一下暂停、第二下恢复」，用户的暂停就这样失效了。
  //   提交期 + 700ms 冷却内，所有状态动作统一锁死（`actionBusyRef` 同步挡第二击，`actionCooldown` 管按钮禁用）。
  const [actionCooldown, setActionCooldown] = useState(false);
  const actionBusyRef = useRef(false);
  const cooldownTimerRef = useRef<number | undefined>(undefined);
  const actionLocked = submitting || actionCooldown;
  function lockActionsFor(ms = 700): void {
    setActionCooldown(true);
    if (cooldownTimerRef.current !== undefined) window.clearTimeout(cooldownTimerRef.current);
    cooldownTimerRef.current = window.setTimeout(() => {
      actionBusyRef.current = false;
      setActionCooldown(false);
      cooldownTimerRef.current = undefined;
    }, ms);
  }
  // 同步挡第二击：`submitting` 是 React state，同一事件循环里的第二下仍会读到旧值，故先用 ref 挡住。
  function beginAction(): boolean {
    if (actionBusyRef.current) return false;
    actionBusyRef.current = true;
    setSubmitting(true);
    return true;
  }
  function endAction(): void {
    setSubmitting(false);
    lockActionsFor();
  }
  useEffect(() => () => { if (cooldownTimerRef.current !== undefined) window.clearTimeout(cooldownTimerRef.current); }, []);
  const [showInject, setShowInject] = useState(false);
  const [injectText, setInjectText] = useState('');
  const [fileStream, setFileStream] = useState<Array<Record<string, unknown>>>([]);
  const [stepStream, setStepStream] = useState<Array<Record<string, unknown>>>([]);
  const [liveStatus, setLiveStatus] = useState<Record<string, unknown> | null>(null);
  // zx_20260906 批4 (4b): 长任务心跳——长单步(≥30s)执行时 step_finished 未达，靠 task.heartbeat 更新活跃脉冲，界面不再"伪冻结"
  const [heartbeat, setHeartbeat] = useState<{ ts: number; elapsedSec: number; tokens: number } | null>(null);
  const [memoryInjection, setMemoryInjection] = useState<Array<Record<string, unknown>>>([]);
  // B1 (2026-09-03_1): 方案里程碑（若本任务为方案/规划任务）
  const [planMilestones, setPlanMilestones] = useState<Array<{ milestone: string; status: string; implemented_by_task_id: string | null; implemented_title?: string | null; updated_at: string }>>([]);
  // zx_20260909 续跑(规划→独立实施): 实施任务"关联方案"(projPlans 候选) + 方案面板"选落地任务"(projTasks 同项目) + 本地重载 tick
  const [projPlans, setProjPlans] = useState<Array<{ id: string; title: string; status: string }>>([]);
  const [projTasks, setProjTasks] = useState<Array<{ id: string; title: string; status: string }>>([]);
  const [planTick, setPlanTick] = useState(0);
  // C2 (2026-09-04): 子任务族验收（父任务视角：全子状态/质量/token）
  // zx_20261011_4 M4: 每子可带 `remote`（已外派 = 派给谁 · 相位 · 回传摘要）；键名/判据真源在 main。
  const [familyChildren, setFamilyChildren] = useState<Array<{ id: string; title: string; status: string; score?: number | null; tokens?: number | null; remote?: RemoteTaskBadge | null }>>([]);
  // zx_20261011_4 M4: 外派徽标下钻（展开哪一子的远端摘要）+ 节点名解析表（台账一次取，取不到回落 nodeId 前 8 位）。
  const [openRemote, setOpenRemote] = useState<string | null>(null);
  const [nodeNames, setNodeNames] = useState<Record<string, string>>({});
  // B2 (2026-09-04_2): 父任务订阅子任务事件 —— 子推进带 + 族卡实时（不污染父执行流）
  const childIdsRef = useRef<Array<{ id: string; title: string }>>([]);
  const [childProg, setChildProg] = useState<{ id: string; title: string; status: string; step?: number; text?: string } | null>(null);
  useEffect(() => { childIdsRef.current = familyChildren.map((c) => ({ id: c.id, title: c.title })); }, [familyChildren]);
  // B2 (2026-09-04_1): 本实施任务所属方案里程碑（标题 M\d 前缀）
  const [ownMs, setOwnMs] = useState<Array<{ plan_task_id: string; milestone: string; status: string }>>([]);
  const [goalInfo, setGoalInfo] = useState<{ goal: string; success_criteria: string; investigate: string[]; principalContradiction: string } | null>(null);
  const [signalStream, setSignalStream] = useState<Array<Record<string, unknown>>>([]);
  const stepStreamRef = useRef<HTMLDivElement>(null);
  // zx_20260911_2 M4b(Q2): 预览载荷补 file_exists/version——磁盘文件缺失时不得用快照冒充"当前内容"（与抽屉同口径）
  const [delivPreview, setDelivPreview] = useState<{ name: string; type: string; content: string; filePath?: string; fileExists?: boolean; version?: number } | null>(null);
  const [retrospective, setRetrospective] = useState<Array<{ content: string; created_at: string; structured?: { plan?: string; delta?: string; lesson?: string; action?: string; reusable?: boolean } }>>([]);
  const [taskEstimate, setTaskEstimate] = useState<{ tokens: number; steps: number; basedOn: number } | null>(null);
  const [showGoalEdit, setShowGoalEdit] = useState(false);
  const [goalEditText, setGoalEditText] = useState('');
  // D1/D5: 执行中「AI 思考中」阶段指示（基于最近步骤事件时间）+ 实时时钟刷新
  const [thinkingSince, setThinkingSince] = useState(0);
  const [nowTick, setNowTick] = useState(Date.now());
  // D3 (2026-09-02): token 级流式——当前步实时生成文本缓冲（task.step_streaming 逐 token 累积，step_finished 清空）
  const [streamingText, setStreamingText] = useState('');
  // CoT (2026-09-03): 推理模型思考过程缓冲（reasoningDelta 累积，step_finished 清空）
  const [streamingReasoning, setStreamingReasoning] = useState('');
  const [showThinking, setShowThinking] = useState(true); // CoT: 思考块默认展开
  // zx_20260923_1 M3: 「产出物」「对话历史」默认折叠（道德经·四十八章「为道日损」——详情页 15 个区块全铺开，
  //   用户每次都要长距滚动）。**只改默认可见性，不删功能**；两块各自独立，不互相牵连。
  const [showDelivs, setShowDelivs] = useState(false);
  const [showConvs, setShowConvs] = useState(false);
  // zx_20260924 M7: 「本次附件」同属"默认折叠"一族（同上 M3 的由头）。
  const [showAtts, setShowAtts] = useState(false);
  // zx_20260924 §2c（用户点名）: 「记忆注入」「事件时间线」并入同一族——理由与 M3 一字不差：
  //   详情页区块全铺开时用户每次都要长距滚动。**只改默认可见性，块内逐字不动**。
  const [showMem, setShowMem] = useState(false);
  const [showEvents, setShowEvents] = useState(false);

  useEffect(() => { if (id) loadProject(); }, [id]);

  // 实时执行流自动滚动到底部（让用户看到最新步骤）
  useEffect(() => {
    if (stepStreamRef.current) stepStreamRef.current.scrollTop = stepStreamRef.current.scrollHeight;
  }, [stepStream]);

  // D1: 执行中每秒刷新时钟，驱动「AI 思考中…」耗时指示
  useEffect(() => {
    if (task?.status !== 'executing' && task?.status !== 'running') return;
    setNowTick(Date.now());
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [task?.status]);

  // Phase 2.1: 订阅任务事件实时更新（无需手动刷新）+ Phase 1 文件变更实时累积
  const activeTaskId = task?.id || id;
  useEffect(() => {
    setFileStream([]);
    setStepStream([]);
    setLiveStatus(null);
    setMemoryInjection([]);
    setGoalInfo(null);
    setSignalStream([]);
    setHeartbeat(null);
    if (!window.electronAPI?.onTaskEvent || !activeTaskId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = window.electronAPI.onTaskEvent((event) => {
      // B2 (2026-09-04_2): 子任务事件 → 父页实时（子推进带 + 族验收卡刷新），不污染父执行流
      const rawEventId = event.taskId ?? event.task_id;
      if (rawEventId && rawEventId !== activeTaskId) {
        const child = childIdsRef.current.find((c) => c.id === rawEventId);
        if (child) {
          if (event.type === 'task.status_changed') {
            const ns = String(event.newStatus || event.new_status || '');
            if (ns === 'executing' || ns === 'running') setChildProg({ id: child.id, title: child.title, status: ns });
            else setChildProg((p) => (p && p.id === child.id ? null : p));
          } else if (event.type === 'task.step_finished') {
            setChildProg({ id: child.id, title: child.title, status: 'running', step: event.step, text: String(event.text || '').slice(0, 60) });
          }
          if (event.type !== 'task.step_streaming') {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { refreshChildrenRef.current(); }, 300);
          }
          return;
        }
      }
      // 仅响应当前任务的更新
      if (event.taskId === activeTaskId || event.task_id === activeTaskId) {
        // 新鲜执行开始（executing）→ 清空实时流，避免重跑/恢复时残留旧步骤（不 return，仍走下方 loadProject 刷新状态）
        if (event.type === 'task.status_changed' && (event.newStatus === 'executing' || event.new_status === 'executing')) {
          setStepStream([]);
          setLiveStatus(null);
          setMemoryInjection([]);
          setGoalInfo(null);
          setSignalStream([]);
          setHeartbeat(null);
          setThinkingSince(Date.now());
          setStreamingText('');
          setStreamingReasoning('');
        }
        // zx_20260906 批4 (4b): 消费 task.heartbeat（main 对 running ai-task/resume 每 ~20s 发一次）——
        // 仅刷新活跃脉冲与任务时长指示，不触发整表刷新；长单步执行中界面持续"呼吸"不伪冻结
        if (event.type === 'task.heartbeat') {
          setHeartbeat({ ts: Date.now(), elapsedSec: Number(event.heartbeatElapsedSec) || 0, tokens: Number(event.tokens) || 0 });
          return;
        }
        // D3: 状态切换实时反馈——乐观更新当前任务状态（不等防抖全量刷新）
        if (event.type === 'task.status_changed' && event.taskId === activeTaskId) {
          const ns = String(event.newStatus || event.new_status || '');
          if (ns) {
            setTask(prev => prev && prev.id === activeTaskId ? { ...prev, status: ns } : prev);
            // 离开执行态（完成/失败/暂停）→ 清空实时流式缓冲
            if (ns !== 'executing' && ns !== 'running') { setStreamingText(''); setStreamingReasoning(''); }
          }
        }
        // D3 (2026-09-02): token 级流式——逐 token 累积到当前步实时缓冲（不触发整表刷新）
        if (event.type === 'task.step_streaming') {
          const delta = String(event.textDelta || '');
          if (delta) setStreamingText(prev => (prev + delta).slice(-4000));
          // CoT: 推理思考过程增量（与输出文本分缓冲累积）
          const rdelta = String(event.reasoningDelta || '');
          if (rdelta) setStreamingReasoning(prev => (prev + rdelta).slice(-8000));
          return;
        }
        // 文件变更事件：实时累积到活动流；zx_20260906 批1——携带 deliverableId 的文件事件（产出物落库）
        // 不再早退，防抖刷新一次任务产出物卡，使运行中产生的成果实时可见（不改流式缓冲）
        if (event.type === 'file.created' || event.type === 'file.updated' || event.type === 'file.edited') {
          setFileStream(prev => [...prev.slice(-199), { ...event, ts: Date.now() }]);
          if (event.deliverableId) { if (timer) clearTimeout(timer); timer = setTimeout(() => loadProject(), 700); }
          return;
        }
        // Phase A: 逐步执行事件实时累积（过程可见，不触发全量刷新）
        if (event.type === 'task.step_finished') {
          setStepStream(prev => [...prev.slice(-199), { ...event, ts: Date.now() }]);
          // E1 (2026-09-04_2): 附累计预算 band/ratio——驱动预算带"质变点"脉冲
          setLiveStatus({ step: event.step, totalTokens: event.totalTokens, toolCalls: event.toolCalls, text: event.text, duration_ms: event.duration_ms, token_delta: event.token_delta, toolOk: event.toolOk, budgetRatio: event.budgetRatio, budgetBand: event.budgetBand, budgetMaxTokens: event.budgetMaxTokens, contextWaterPct: event.contextWaterPct, estBiasPct: event.estBiasPct });
          setThinkingSince(Date.now());
          setStreamingText('');  // 本步已完成，其实时文本已落库，清空流式缓冲（下一步生成前界面回落思考中态）
          setStreamingReasoning('');  // CoT: 本步思考已结束，清空思考缓冲
          return;
        }
        // Phase B: 记忆注入可视化（任务识别依据透出）
        if (event.type === 'task.memory_injected') {
          setMemoryInjection(Array.isArray(event.memories) ? event.memories as Record<string, unknown>[] : []);
          return;
        }
        // Phase A (2026-08-28 zx_1): 任务目标显性化（核心目标/成功标准/待调查项/主要矛盾透出）
        if (event.type === 'task.goal_identified') {
          setGoalInfo({
            goal: String(event.goal || ''),
            success_criteria: String(event.success_criteria || ''),
            investigate: Array.isArray(event.investigate) ? event.investigate as string[] : [],
            principalContradiction: String(event.principalContradiction || ''),
          });
          return;
        }
        // Phase B (2026-08-28 zx_5 时序修复): 任务执行预估实时透出（避免 status_changed 竞态导致预估不可见）
        if (event.type === 'task.estimated') {
          setTaskEstimate({ tokens: Number(event.tokens) || 0, steps: Number(event.steps) || 0, basedOn: Number(event.basedOn) || 0 });
          return;
        }
        // Phase B (2026-08-28 zx_1): 目标达成监控信号实时累积（偏离/风险/复杂度/早停）
        if (event.type === 'task.goal_deviation' || event.type === 'task.execution_signal') {
          setSignalStream(prev => [...prev.slice(-99), { ...event, ts: Date.now() }]);
          return;
        }
        // zx_20260910_1 M1: 「等待输入」只保留一处呈现——事件到达即触发重载，由 ctxJson.awaiting_input（真源）驱动横幅，
        //   不再本地累积第二块卡片（两块源于同一暂停，是重复呈现的根因）
        if (event.type === 'task.awaiting_input') {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => loadProject(), 300);
          return;
        }
        // 其他事件：防抖300ms，避免短时间内多次刷新
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => loadProject(), 300);
      }
    });
    return () => { if (timer) clearTimeout(timer); unsubscribe(); };
  }, [activeTaskId]);

  // B2 (2026-09-03): 执行事件回放——非运行态任务刷新后从 wa_event_log 恢复步骤/健康信号（防"刷新即丢"）
  useEffect(() => {
    const st = task?.status;
    if (!task?.id) return;
    if (st === 'running' || st === 'executing' || st === 'pending' || st === 'planning' || st === 'preparing') return;
    if (stepStream.length > 0) return; // 本会话已实时捕获，避免重复
    let cancelled = false;
    invoke<{ steps?: Array<Record<string, unknown>>; signals?: Array<{ type: string; signalType?: string; level?: string; message: string; occurred_at: string }> }>('events:taskReplay', task.id)
      .then((r) => {
        if (cancelled || !r) return;
        if (Array.isArray(r.steps) && r.steps.length > 0) {
          setStepStream(r.steps.map((s) => ({ ...s, ts: Date.now() })));
        }
        if (Array.isArray(r.signals) && r.signals.length > 0) {
          setSignalStream(r.signals.map((s) => ({ type: s.type, signalType: s.signalType || '', level: s.level || 'info', message: s.message, ts: Date.now() })));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, task?.status, stepStream.length]);

  // zx_20261023_5 批一: 派单理由（只在 pending 有意义——已开跑/终态的任务不谈"要不要外派"）。
  useEffect(() => {
    if (!task?.id || task.status !== 'pending') { setDispatchView(null); return; }
    let cancelled = false;
    tasks.dispatchReason(task.id)
      .then((r) => { if (!cancelled) setDispatchView(r); })
      .catch(() => { if (!cancelled) setDispatchView(null); });
    return () => { cancelled = true; };
  }, [task?.id, task?.status]);

  // B1 (2026-09-03_1): 方案里程碑加载 + 手动置状态(planTick 供绑定落地后本地重载)
  useEffect(() => {
    if (!task?.id) return;
    let cancelled = false;
    invoke<{ milestones: Array<{ milestone: string; status: string; implemented_by_task_id: string | null; implemented_title?: string | null; updated_at: string }> }>('plan:milestones', { planTaskId: task.id })
      .then((r) => { if (!cancelled && r) setPlanMilestones(Array.isArray(r.milestones) ? r.milestones : []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [task?.id, planTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // zx_20260909 续跑: 加载同项目"方案(规划)任务"清单(关联方案候选 / 解析关联标题) + 同项目任务(方案面板"选落地任务"候选)
  useEffect(() => {
    if (!task?.project_id) return;
    let cancelled = false;
    invoke<{ plans: Array<{ id: string; title: string; status: string }> }>('plan:projectPlans', { projectId: task.project_id })
      .then((r) => { if (!cancelled && r) setProjPlans(Array.isArray(r.plans) ? r.plans : []); }).catch(() => {});
    return () => { cancelled = true; };
  }, [task?.project_id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!task?.id || planMilestones.length === 0) return;
    let cancelled = false;
    invoke<{ tasks: Array<{ id: string; title: string; status: string }> }>('plan:projectTasks', { planTaskId: task.id })
      .then((r) => { if (!cancelled && r) setProjTasks(Array.isArray(r.tasks) ? r.tasks : []); }).catch(() => {});
    return () => { cancelled = true; };
  }, [task?.id, planMilestones.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const setMilestone = async (m: string, status: 'pending' | 'doing' | 'done') => {
    if (!task?.id) return;
    setPlanMilestones((prev) => prev.map((x) => (x.milestone === m ? { ...x, status } : x)));
    try { await invoke('plan:milestoneSet', { planTaskId: task.id, milestone: m, status }); } catch (e) { reportAction(e); }
  };
  // zx_20260909 续跑: 关联/解除方案(scheme_ref.plan_task_id 写于本任务; 子任务创建继承; finalize/动工自动落地)
  const linkPlan = async (planTaskId: string | null) => {
    if (!task?.id) return;
    try { await invoke('plan:linkPlan', { taskId: task.id, planTaskId }); } catch (e) { reportAction(e); }
    loadProject();
  };
  // 方案面板: 手动"选落地任务"(同项目任意任务, 不限于子任务) → 置 done + 绑定 implemented
  const bindLanding = async (m: string, landingId: string) => {
    if (!task?.id || !landingId) return;
    try { await invoke('plan:milestoneSet', { planTaskId: task.id, milestone: m, status: 'done', implementedByTaskId: landingId }); setPlanTick((x) => x + 1); }
    catch (e) { reportAction(e); }
  };

  // C1 (2026-09-03_3): 加载/处置"子任务待决"(paused/failed)
  const refreshChildren = async () => {
    if (!task?.id) return;
    try {
      const r = await invoke<{ children: Array<{ id: string; title: string; status: string; score?: number | null; tokens?: number | null; remote?: RemoteTaskBadge | null }> }>('tasks:children', { id: task.id });
      setFamilyChildren(Array.isArray(r?.children) ? r.children : []);
    } catch { /* ignore */ }
  };
  useEffect(() => { refreshChildren(); }, [task?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // zx_20261011_4 M4: 外派徽标的**节点名解析**——一次取现有台账（失败静默 ⇒ `nameOf` 回落 nodeId 前 8 位，
  //   不伪造节点名）；键名由 main 的 `nodes:list` 一处给，本页不自算一份环境。
  useEffect(() => {
    nodes.list().then((r) => {
      const m: Record<string, string> = {};
      for (const n of r.nodes) m[n.node_id] = n.name || '';
      setNodeNames(m);
    }).catch(() => { /* 取不到就回落 nodeId 前缀，不影响主流程 */ });
  }, []);
  const remoteNameOf = (id: string): string => nodeNames[id] ?? '';
  const refreshChildrenRef = useRef<() => void>(() => {});
  refreshChildrenRef.current = () => { void refreshChildren(); };
  const childResume = async (cid: string) => { try { await invoke('task:resume', { id: cid }); } catch (e) { reportAction(e); } refreshChildren(); };
  const childStatus = async (cid: string, status: string) => {
    // zx_20261012_2 批二: 原先此处 `status==='failed' ⇒ reason='abandoned_by_user'` 是「放弃」的实现——
    //   弃已改走 `childArchive`（归档态），故不再有"以 failed 表弃"的隐式语义；本函数现只用于"标记完成"。
    try { await invoke('task:updateStatus', { id: cid, status }); } catch (e) { reportAction(e); }
    refreshChildren();
  };
  // zx_20261012_2 批二: 子任务「放弃」走归档专用通道（弃 ≠ 败）。
  const childArchive = async (cid: string) => {
    try { await tasks.archive(cid); } catch (e) { reportAction(e); }
    refreshChildren();
  };

  // B2 (2026-09-04_1): 本任务所属方案里程碑加载
  useEffect(() => {
    if (!task?.id) return;
    let cancelled = false;
    invoke<{ milestones: Array<{ plan_task_id: string; milestone: string; status: string }> }>('plan:taskMilestones', { taskId: task.id })
      .then((r) => { if (!cancelled && r) setOwnMs(Array.isArray(r.milestones) ? r.milestones : []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [task?.id]);
  // E2 (2026-09-04_2): 扬弃小结——本任务终态时聚合（偏离/记忆注入/信号/步数），复盘顶部与族卡呈现
  const [digest, setDigest] = useState<DigestInfo | null>(null);
  useEffect(() => {
    if (!task?.id) return;
    if (!['completed', 'failed', 'archived'].includes(task.status)) return;
    let cancelled = false;
    invoke<DigestInfo>('tasks:digest', { id: task.id }).then((r) => { if (!cancelled && r) setDigest(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [task?.id, task?.status]);
  // E2 (2026-09-04_2): 族级扬弃——父全部子项终态时，聚合各子（+父自身）的事件事实
  const [familyDigest, setFamilyDigest] = useState<FamilyDigestSum | null>(null);
  useEffect(() => {
    if (familyChildren.length === 0) return;
    if (!familyChildren.every((c) => c.status === 'completed' || c.status === 'failed')) return;
    let cancelled = false;
    const ids = familyChildren.map((c) => c.id);
    Promise.all(ids.map((cid) => invoke<DigestInfo>('tasks:digest', { id: cid }).catch(() => null))).then((list) => {
      if (cancelled) return;
      const valid = list.filter((d): d is DigestInfo => !!d);
      const sum = valid.reduce<FamilyDigestSum>((a, b) => ({
        steps: a.steps + b.steps,
        deviations: a.deviations + b.deviations,
        signals: a.signals + b.signals,
        memoryInjections: a.memoryInjections + b.memoryInjections,
        failed: a.failed + (b.status === 'failed' ? 1 : 0),
        lowQuality: a.lowQuality + (b.quality != null && b.quality < 60 ? 1 : 0),
      }), { steps: 0, deviations: 0, signals: 0, memoryInjections: 0, failed: 0, lowQuality: 0 });
      setFamilyDigest(sum);
    });
    return () => { cancelled = true; };
  }, [familyChildren, task?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // 族验收通过 → 把各已完成子任务对应的方案里程碑标 done（联动回写）
  const syncFamilyMilestones = async () => {
    if (!task?.id) return;
    for (const ch of familyChildren) {
      if (ch.status !== 'completed') continue;
      try {
        const r = await invoke<{ milestones: Array<{ plan_task_id: string; milestone: string; status: string }> }>('plan:taskMilestones', { taskId: ch.id });
        for (const m of (r?.milestones || [])) {
          await invoke('plan:milestoneSet', { planTaskId: m.plan_task_id, milestone: m.milestone, status: 'done', implementedByTaskId: ch.id });
        }
      } catch (e) { reportAction(e); }
    }
    refreshChildren();
  };

  async function loadProject() {
    try {
      // zx_20260916_2 M4: **只在没有数据时**才置 loading。
      // 执行中的非流式事件会周期性触发本函数（:231/:273/:278 防抖 300–700ms），而 :665 的 `if (loading)`
      // 是**整页 spinner**——于是一次后台刷新会把已渲染的页面整个换成转圈。有数据时改走静默刷新，页面不卸载。
      if (!task) setLoading(true);
      // 先尝试以 taskId 加载
      // zx_20260930 M4-2: 显式取第 0 页（两个列表各一批）——刷新/切换=回到首页，
      //   不按"当前已加载多少"续取（那会让"刷新"变成一个语义不明的动作）。
      const taskData = await tasks.get(id!, { convLimit: LIST_PAGE_SIZE, convOffset: 0, delivLimit: LIST_PAGE_SIZE, delivOffset: 0 }) as unknown as { task: TaskItem; conversations: ConvItem[]; conversationsTotal?: number; deliverables: DelivItem[]; deliverablesTotal?: number; retiredCount?: number; retrospective?: Array<{ content: string; created_at: string; structured?: { plan?: string; delta?: string; lesson?: string; action?: string; reusable?: boolean } }> };
      if (taskData.task) {
        setTask(taskData.task);
        setConvs(taskData.conversations || []);
        setDelivs(taskData.deliverables || []);
        // 计数取**服务端全量**（分页后印当页长度会把"还没取"说成"就这么多"）
        setConvTotal(Number(taskData.conversationsTotal) || 0);
        setDelivTotal(Number(taskData.deliverablesTotal) || 0);
        setConvExhausted(pageExhausted((taskData.conversations || []).length, Number(taskData.conversationsTotal) || 0));
        setDelivExhausted(pageExhausted((taskData.deliverables || []).length, Number(taskData.deliverablesTotal) || 0));
        setRetiredCount(Number(taskData.retiredCount) || 0);
        setRetrospective(taskData.retrospective || []);
        setSelectedId(taskData.task.id);
        // Phase A: 从 context_json 恢复任务目标（刷新后仍可见，不依赖实时事件）
        try {
          const tctx = JSON.parse(taskData.task.context_json || '{}');
          const tg = tctx.task_goal as { goal?: string; success_criteria?: string; investigate?: string[] } | undefined;
          setGoalInfo(tg ? { goal: tg.goal || '', success_criteria: tg.success_criteria || '', investigate: Array.isArray(tg.investigate) ? tg.investigate : [], principalContradiction: (tctx.principal_contradiction as string) || '' } : null);
          // Phase B: 从 context_json 恢复任务执行预估（刷新后仍可见）
          const te = tctx.task_estimate as { tokens?: number; steps?: number; basedOn?: number } | undefined;
          setTaskEstimate(te && te.basedOn ? { tokens: te.tokens || 0, steps: te.steps || 0, basedOn: te.basedOn } : null);
          // zx_20260906 批3 (3a): 完成/刷新后复水记忆注入面板——从持久化 injected_memories 快照恢复"本次理解依据"
          // （live 事件已置位则不覆盖；重试清空 context 后自然为空，等新 run 注入）
          const injected = Array.isArray(tctx.injected_memories) ? tctx.injected_memories as Array<Record<string, unknown>> : [];
          if (injected.length > 0) setMemoryInjection(prev => (prev.length > 0 ? prev : injected));
        } catch { setGoalInfo(null); setTaskEstimate(null); }
        // 加载所属项目的所有任务列表
        const proj = await projects.get(taskData.task.project_id) as Record<string, unknown>;
        setProjectName((proj.name as string) || taskData.task.project_id);
        // zx_20261018_3 批五「显」: 详情页要用**全项目**任务做父/前置标题与前置候选——按页取完（每次受硬上限约束）。
        const allTasks = await tasks.listAll(taskData.task.project_id) as unknown as TaskItem[];
        setTaskList(allTasks);
        try { const ev = await tasks.events(taskData.task.id); setEvents((ev as Array<Record<string, unknown>>) || []); } catch { setEvents([]); }
        try { const ctx = await tasks.context(taskData.task.id) as Record<string, unknown>; setCtxForm({ max_tokens_per_task: String(ctx.max_tokens_per_task || ''), max_cost_usd_per_task: String(ctx.max_cost_usd_per_task || '') }); } catch {}
        try { const sim = await tasks.similar(taskData.task.id, taskData.task.project_id); setSimilarTasks((sim as Array<Record<string, unknown>>) || []); } catch { setSimilarTasks([]); }
      }
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }

  // G2 (2026-09-04_2 整改): 关键动作"两态"反馈——被拒原因显式透出（不再静默 catch{}，点了看得见成没成）
  const [actionMsg, setActionMsg] = useState('');
  const actionTimerRef = useRef<number | undefined>(undefined);
  const reportAction = (e: unknown): void => {
    const m = e instanceof Error ? e.message : String(e);
    setActionMsg(m ? `操作未生效 · ${m}` : '操作未生效');
    if (actionTimerRef.current !== undefined) window.clearTimeout(actionTimerRef.current);
    actionTimerRef.current = window.setTimeout(() => setActionMsg(''), 6000);
  };
  useEffect(() => () => { if (actionTimerRef.current !== undefined) window.clearTimeout(actionTimerRef.current); }, []);

  async function selectTask(taskId: string) {
    setSelectedId(taskId);
    try {
      // zx_20260930 M4-2: 与 `loadProject` 同尺——切任务也是取第 0 页 + 服务端总数
      const data = await tasks.get(taskId, { convLimit: LIST_PAGE_SIZE, convOffset: 0, delivLimit: LIST_PAGE_SIZE, delivOffset: 0 }) as unknown as { task: TaskItem; conversations: ConvItem[]; conversationsTotal?: number; deliverables: DelivItem[]; deliverablesTotal?: number; retiredCount?: number };
      setTask(data.task); setConvs(data.conversations||[]); setDelivs(data.deliverables||[]); setRetiredCount(Number(data.retiredCount)||0);
      setConvTotal(Number(data.conversationsTotal) || 0);
      setDelivTotal(Number(data.deliverablesTotal) || 0);
      setConvExhausted(pageExhausted((data.conversations||[]).length, Number(data.conversationsTotal) || 0));
      setDelivExhausted(pageExhausted((data.deliverables||[]).length, Number(data.deliverablesTotal) || 0));
      try { const ev = await tasks.events(taskId); setEvents((ev as Array<Record<string, unknown>>)||[]); } catch { setEvents([]); }
      try { const ctx = await tasks.context(taskId) as Record<string, unknown>; setCtxForm({ max_tokens_per_task: String(ctx.max_tokens_per_task || ''), max_cost_usd_per_task: String(ctx.max_cost_usd_per_task || '') }); } catch {}
    } catch {}
  }

  // zx_20260930 M4-2: 两个列表的「加载更多」——偏移量取**已列出的条数**，按 id 去重合并。
  //   去重不是洁癖：对话按 `rowid ASC`、成果按 `created_at DESC` 排，翻页期间若有新行落库，
  //   按 offset 续取会**重复**列出一条已显示的记录。
  //   只补列表与计数，**不碰** `task`/`ctx`/`events`（那几项不是分页对象，重取会把正在看的上下文重置）。
  async function loadMoreConvs() {
    if (!task?.id || convMoreBusy) return;
    setConvMoreBusy(true);
    try {
      const d = await tasks.get(task.id, { convLimit: LIST_PAGE_SIZE, convOffset: convs.length, delivLimit: 1, delivOffset: 0 }) as unknown as { conversations?: ConvItem[]; conversationsTotal?: number };
      const more = d.conversations || [];
      setConvs(prev => { const seen = new Set(prev.map(c => c.id)); return [...prev, ...more.filter(c => !seen.has(c.id))]; });
      const total = Number(d.conversationsTotal) || 0;
      setConvTotal(total);
      setConvExhausted(pageExhausted(convs.length + more.length, total));
    } catch {}
    setConvMoreBusy(false);
  }
  async function loadMoreDelivs() {
    if (!task?.id || delivMoreBusy) return;
    setDelivMoreBusy(true);
    try {
      const d = await tasks.get(task.id, { convLimit: 1, convOffset: 0, delivLimit: LIST_PAGE_SIZE, delivOffset: delivs.length }) as unknown as { deliverables?: DelivItem[]; deliverablesTotal?: number };
      const more = d.deliverables || [];
      setDelivs(prev => { const seen = new Set(prev.map(x => x.id)); return [...prev, ...more.filter(x => !seen.has(x.id))]; });
      const total = Number(d.deliverablesTotal) || 0;
      setDelivTotal(total);
      setDelivExhausted(pageExhausted(delivs.length + more.length, total));
    } catch {}
    setDelivMoreBusy(false);
  }
  // zx_20261018_3 D7: 状态动作共一把锁——同步 ref 挡第二击 + 提交期/700ms 冷却内全栏禁用。
  //   刷新完成后再解锁：暂停后界面尚未翻到 paused 时就把「暂停」放开，等于又给了一次反向点击的机会。
  async function handleStatus(taskId: string, status: string) {
    if (!beginAction()) return;
    try {
      await tasks.updateStatus(taskId, status);
      await loadProject();
      if (taskId===selectedId) await selectTask(taskId);
    } catch (e) { reportAction(e); } finally { endAction(); }
  }
  // zx_20261012_2 批二: 「归档（放弃）」——独立动作（`task:archive`），与"标失败"分开：
  //   弃 ≠ 败。此前只有"标失败"，用户弃单后子任务被当成失败子挡住父任务收口。
  async function handleArchive(taskId: string) {
    if (!confirm('确定归档（放弃）此任务？归档即弃——它不再参与完成/失败统计，也不阻塞父任务收口。')) return;
    if (!beginAction()) return;
    try {
      await tasks.archive(taskId);
      await loadProject();
      if (taskId===selectedId) await selectTask(taskId);
    } catch (e) { reportAction(e); } finally { endAction(); }
  }
  async function handleRetry(taskId: string) {
    if (!beginAction()) return;
    try { await tasks.retry(taskId); await loadProject(); } catch (e) { reportAction(e); } finally { endAction(); }
  }
  // zx_20260910_1 M4: 应答/恢复类操作统一护栏——置「提交中」(按钮禁用防连点)、成功后统一重载；
  // main 侧幂等重复码 ALREADY_RESPONDED 视同成功静默收口（不弹"操作未生效"，仅重载对齐界面）。
  async function submitPauseOp(op: () => Promise<unknown>): Promise<void> {
    if (!beginAction()) return;
    try {
      await op();
      await loadProject();
    } catch (e) {
      if (e instanceof IpcError && e.code === 'ALREADY_RESPONDED') { await loadProject(); }
      else reportAction(e);
    } finally { endAction(); }
  }
  async function handleResume(taskId: string) { await submitPauseOp(() => tasks.resume(taskId)); }
  async function handleReply(taskId: string) { const text = replyText.trim(); if (!text) return; await submitPauseOp(async () => { await tasks.resume(taskId, text); setShowReply(false); setReplyText(''); }); }
  // zx_20260923 M7-c（G15）: 横幅内联附言恢复——与上面 `handleReply` 调的是**同一个**恢复方法（同通道、同语义），
  //   不是第二份 resume 实现；后端 `project.ipc.ts` 的 `task:resume` 早已收 `reply`，故 main/IPC 零改动。
  async function handleResumeWithNote(taskId: string) { const text = bannerReply.trim(); if (!text) return; await submitPauseOp(async () => { await tasks.resume(taskId, text); setBannerReply(''); }); }
  // zx_20260910_1 M1: 审批类（路径/特权）唯一入口——必须走 task:respond（只有它写 wa_approvals 指纹，task:resume 不写）
  async function handleDecision(taskId: string, decision: 'allow' | 'deny' | 'option', value?: string) { await submitPauseOp(() => tasks.respond(taskId, decision, value)); }
  async function handleDownweightMemory(memId: string) { try { await admin.downweightMemory(memId); setMemoryInjection(prev => prev.filter(m => m.id !== memId)); } catch {} }
  async function handleDeleteMemory(memId: string) { if (!confirm('确定删除此记忆？')) return; try { await admin.deleteMemory(memId); setMemoryInjection(prev => prev.filter(m => m.id !== memId)); } catch {} }
  async function handleInterrupt(taskId: string) {
    if (!confirm('确定中止此任务的当前执行？')) return;
    if (!beginAction()) return;
    try { await tasks.interrupt(taskId); setShowInject(false); setInjectText(''); await loadProject(); } catch (e) { reportAction(e); } finally { endAction(); }
  }
  async function handleInject(taskId: string) { const text = injectText.trim(); if (!text) return; try { await tasks.inject(taskId, text); setInjectText(''); setShowInject(false); loadProject(); } catch (e) { reportAction(e); } }
  async function handleInjectDirect(taskId: string, text: string) { const t = text.trim(); if (!t) return; try { await tasks.inject(taskId, t); loadProject(); } catch (e) { reportAction(e); } }
  async function handleSaveGoal(taskId: string) { const text = goalEditText.trim(); if (!text) return; try { const existing = goalInfo; await tasks.context(taskId, { task_goal: { goal: text, success_criteria: existing?.success_criteria || '', investigate: existing?.investigate || [] } }); setShowGoalEdit(false); setGoalInfo(prev => prev ? { ...prev, goal: text } : { goal: text, success_criteria: '', investigate: [], principalContradiction: '' }); } catch (e) { reportAction(e); } }
  async function handleDelete(taskId: string) { if (!confirm('确定删除此任务？对话记录和产出物将被清除。')) return; try { await tasks.delete(taskId); navigate('/tasks'); } catch (e) { reportAction(e); } }
  // zx_20261013_1 批二(K7): 「挂附件」——选本地文件挂到**本任务**（main 侧一条链：`im-media` 落盘 + `appendTaskAttachments` 写 `context_json.attachments`）。
  //   挂上后**下一次执行/回复**即被装配进上下文（无需立刻重跑）；逐件独立成败如实回报（成功件数 + 失败逐条带真因）。
  async function handleAttachFiles(taskId: string) {
    let picked: string[] = [];
    try { picked = (await window.electronAPI?.openFilesDialog()) ?? []; } catch { return; }
    if (!Array.isArray(picked) || picked.length === 0) return;
    try {
      const r = await tasks.attachFiles(taskId, picked);
      const failedNote = r.failures.length > 0 ? `，${r.failures.length} 件未挂上（${r.failures.map(f => `${f.filePath.split(/[\\/]/).pop()}：${f.error}`).join('；')}）` : '';
      setActionMsg(r.imported > 0 ? `已挂 ${r.imported} 件${failedNote}` : `未挂上任何件${failedNote}`);
      if (actionTimerRef.current !== undefined) window.clearTimeout(actionTimerRef.current);
      actionTimerRef.current = window.setTimeout(() => setActionMsg(''), 8000);
      await loadProject();
    } catch (e) { reportAction(e); }
  }
  // zx_20260907 M3复核补: 「新建任务」改为创建当前任务的子任务——projectId=当前任务所属项目,parent_task_id=当前任务(修复原把任务 id 当 projectId 致 FK 失败的死按钮)
  // zx_20260914 M0.6: 同任务页两层——在途标志 + 本次表单会话的幂等键（main 侧查—插幂等才是兜底）。
  async function handleCreate() {
    if (!task || creating) return;
    setCreating(true);
    try {
      const reqId = createReqIdRef.current || (createReqIdRef.current = newClientRequestId());
      await tasks.create(task.project_id, newTask.title, newTask.description, undefined, newTask.acceptance_criteria || undefined, task.id, newTask.planTaskId || undefined, reqId);
      setShowCreate(false); setNewTask({title:'',description:'',acceptance_criteria:'',planTaskId:''}); loadProject();
    } catch (e) { reportAction(e); } finally { setCreating(false); }
  }
  async function handleSaveContext() { if (!selectedId) return; try { await tasks.context(selectedId, { max_tokens_per_task: Number(ctxForm.max_tokens_per_task) || undefined, max_cost_usd_per_task: Number(ctxForm.max_cost_usd_per_task) || undefined }); setShowContext(false); selectTask(selectedId); } catch (e) { reportAction(e); } }
  async function handlePreviewDeliv(d: DelivItem) { try { const r = await invoke<Record<string, unknown>>('deliverable:preview', d.id); const rd = r as unknown as Record<string, unknown>; const content = String(rd.content_snapshot || rd.content || ''); const filePath = rd.file_path as string | undefined; setDelivPreview({ name: d.name, type: d.type, content, filePath, fileExists: rd.file_exists === true, version: Number(rd.version) || undefined }); } catch {} }

  const ctx = (() => { try { return JSON.parse(task?.context_json||'{}'); } catch { return {}; } })();
  // zx_20260904_4 T5 (2026-09-04): 上下文水位（T2 context_watermark）——running 实时带展示；优先 step 实时值、回退首部估算
  const ctxWm = (ctx as unknown as { context_watermark?: { waterPct?: number; approxTokens?: number } }).context_watermark;
  const liveWaterPct = liveStatus && typeof liveStatus.contextWaterPct === 'number' ? Number(liveStatus.contextWaterPct) : (ctxWm?.waterPct ?? null);
  // zx_20261018_1 批七「账」: 七源 token 分账 + 裁剪账。优先读收口写下的 `execution_metrics.token_breakdown`
  //   （执行结束后才有 output 源），运行中回退水位的同名账（那时 output 尚为 0）。
  const tokenBreakdown = (() => {
    const em = (ctx as { execution_metrics?: { token_breakdown?: unknown } }).execution_metrics?.token_breakdown;
    const wm = (ctx as { context_watermark?: { tokenBreakdown?: unknown } }).context_watermark?.tokenBreakdown;
    const raw = (em ?? wm) as {
      tokens?: Record<string, number>; totalTokens?: number;
      trimmedChars?: Record<string, number>; budgetTokens?: number; overBudget?: boolean;
    } | undefined;
    if (!raw || typeof raw !== 'object' || !raw.tokens) return null;
    const tokens = raw.tokens;
    const trimmed = raw.trimmedChars ?? {};
    const trimmedTotal = ['knowledge', 'memory', 'history'].reduce((n, k) => n + (Number(trimmed[k]) || 0), 0);
    return {
      system: Number(tokens.system) || 0,
      memory: Number(tokens.memory) || 0,
      knowledge: Number(tokens.knowledge) || 0,
      history: Number(tokens.history) || 0,
      tools: Number(tokens.tools) || 0,
      user: Number(tokens.user) || 0,
      output: Number(tokens.output) || 0,
      total: Number(raw.totalTokens) || 0,
      trimmedTotal,
      budget: Number(raw.budgetTokens) || 0,
      overBudget: raw.overBudget === true,
    };
  })();
  // zx_20260904_7 I1: 实际 vs 预估 token 偏差%（优先 step 实时值）
  const liveBias = liveStatus && liveStatus.estBiasPct != null ? Number(liveStatus.estBiasPct) : null;
  // zx_20260924_1 M9-c（循名责实）: `via` 此前**没有任何消费面**——同一个 `completion_quality` 有两条互不相干
  //   的产生路径（收口方自评 / 引擎六维），界面上却只看得见一个分 ⇒ 父任务的 95（自评）与子任务的 45（六维）
  //   看起来像同一把尺量出来的。本处把它读出来显示（见下方「完成来源」那行）。
  //   ⚠ **只显示，不改判定**（§4.2 V-8 已裁定取 (a)）。
  const completionQuality = ctx?.completion_quality as { score?: number; feedback?: string; via?: string } | undefined;
  // 来源机器名 → 人话注解。**取值一律原样带出**（`via` 由 main 侧写，如 `finalize_task`/`run_close`/
  //   `update_task_status`，后者另有 `update_task_status:no_output` 这种带后缀的形态）：
  //   本表只加注解、**不当白名单**——将来 main 侧新增取值时，界面照显机器名而不是留白或错标。
  const COMPLETION_VIA_NOTE: Record<string, string> = {
    finalize_task: '由 finalize_task 工具收口判定 —— 本分是「收口方自评」基线，叠加与 run_close 同尺的四道封顶（低于 60 即置暂停、不标完成）；未经引擎六维评估，与 run_close 的分不可直接比较',
    run_close: '由引擎收口（run_close）判定 —— 本分经引擎六维评估',
    update_task_status: '由 update_task_status 工具判定（编排用出口，未经 finalize 收口门禁）',
  };
  const completionVia = completionQuality?.via;
  const completionViaNote = completionVia
    ? (COMPLETION_VIA_NOTE[completionVia] ?? COMPLETION_VIA_NOTE[completionVia.split(':')[0]!] ?? '')
    : '';
  // zx_20260924_1 M9-b: 「没估时」的如实痕迹（`task_estimate.basedOn === 0` + `note`）——引擎留下的"为什么没估"。
  //   与真估互斥：真估的 `taskEstimate`（:474，要求 `basedOn` 真值）才显示预估徽标，两者不会同屏互否认。
  const estimateMissingNote = (() => {
    const te = (ctx as { task_estimate?: { basedOn?: unknown; note?: unknown } }).task_estimate;
    return te && Number(te.basedOn) === 0 && typeof te.note === 'string' && te.note ? te.note : null;
  })();
  // zx_20260924_1 M9-c: 里程碑缺口的**升格显示**（引擎早就在 `finalize_checks` 里写了那句 [WARN]，
  //   但它是列表里的第 N 行、且只在详情页——此处按"需要处置的项"单列一条并给出**条数**）。
  //   ⚠ **只显示，不拦截**：V-8 已裁定"不改完成决定"。取值面是 main 侧 `finalize_task` 写的数组
  //   （control.ts 的 `bctx.milestones_without_child_tasks`），非本页自算。
  const milestonesWithoutChildTasks: string[] = (() => {
    const raw = (ctx as { milestones_without_child_tasks?: unknown }).milestones_without_child_tasks;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  })();
  // zx_20260906 批2(终核补强): 完成真实性诚实标记透出——update_task_status 直接置 completed 但无真实产出证据 → 显式警示人工复核（不硬拦）
  const autoCompletedNoOutput = !!(ctx as { auto_completed_without_output?: unknown }).auto_completed_without_output;
  // zx_20261016_3 M33-b（四因·目的因）: 子任务的「目的」——拆解时由模型写（`purpose`）、
  //   `planSubtasksFromTemplate` 落进子任务 `context_json.purpose`。四因里只有目的因是**新添**的，
  //   界面上须真的看得见（维特根斯坦·意义即用法：不被消费的标注＝无意义）。
  //   ⚠ **只显示，不改判定**（同 `completionQuality` 一行）；缺键/空串一律不渲染（不拿空行冒充"已标注"）。
  const childPurpose = typeof (ctx as { purpose?: unknown }).purpose === 'string'
    ? (ctx as { purpose: string }).purpose.trim() : '';
  // 四因视图：词表/判据一律取 `four-causes.ts`（零 import 故引得到，与 `healing-outcome.ts` 同形），
  //   界面不手抄"哪几因叫什么、算不算缺"。`depends_on` 是逗号串 ⇒ 先切成数组再喂（否则"有前置"会被读成"无前置"）。
  const childFourCauses = childPurpose
    ? fourCauseOf({
      acceptance_criteria: task?.acceptance_criteria,
      purpose: childPurpose,
      dependsOn: String(task?.depends_on ?? '').split(',').filter(Boolean),
    })
    : [];
  // B2 (2026-09-02): 模板匹配依据（task:create 拆解时落库 matched_method/matched_keywords/matched_similarity）
  // zx_20260924 缺陷B: 这些键**此前从未落过库**（写它们的 UPDATE 少套一层 json_set，被 catch 吞了）⇒ 本行一直不显示。
  // zx_20260924 缺陷C: 另加 matched_field——描述现在也能独立命中，用户须知道命中的是标题还是描述。
  const matchedInfo = (() => {
    try {
      const c = JSON.parse(task?.context_json || '{}');
      if (!c.template || !c.auto_decomposed) return null;
      return {
        tpl: String(c.template).slice(0, 8),
        kw: Array.isArray(c.matched_keywords) ? c.matched_keywords as string[] : [],
        method: c.matched_method as string | undefined,
        sim: c.matched_similarity as number | undefined,
        field: c.matched_field as 'title' | 'description' | undefined,
      };
    } catch { return null; }
  })();
  // zx_20261002 M7（《周易·观》「观国之光」/《庄子·天运》「名者，实之宾也」）: 上面那块**要求有模板**
  //   （`c.template && c.auto_decomposed`），而无模板的三条引擎路——启动即拆（`jobs/ai-task`）、
  //   计划模式（`tools/control` 的 `enter_plan_mode`）、IM 自动拆（`im-router`）——只落 `$.auto_decomposed`，
  //   ⇒ 溯源面板对它们**恒隐藏**，"为何这样拆"无处核对。此处按 `auto_decomposed` **派生来源**：无模板即引擎路。
  //   ⚠ 只改**展示判据**，不动 `context_json` 任何写侧语义（`control.ts` 明写"本路没有模板，不写 `$.template`"是对的）。
  //   ⚠ 闸门 `familyChildren.length > 0`：该标记**同时落在每个子任务**的 ctx 上（M6 字段一致性）——
  //     "我拆出了子"才是"我拆过"的凭据，否则子任务会自称拆解者（名实不符）。
  const engineDecomposed = (!matchedInfo && ctx?.auto_decomposed === true && familyChildren.length > 0)
    ? { count: familyChildren.length }
    : null;
  const budgetUsage = ctx?.budget_usage_ratio as number | undefined;
  const tokensUsed = ctx?.tokens_used as number | undefined;
  // zx_20260910_5 M1: 费用闸水位——与 token 侧对称读数（cost_used/budget_max_cost/cost_gate_active 由引擎落 ctx）
  const costUsed = ctx?.cost_used as number | undefined;
  const costMax = ctx?.budget_max_cost as number | undefined;
  const costUsageRatio = ctx?.cost_usage_ratio as number | undefined;
  const costGateActive = ctx?.cost_gate_active as boolean | undefined;
  // zx_20260910_6 M2: 金额上限的**来源**（'task'/'project'/'none'，由引擎 resolveCostBudget 落 ctx）。
  // 无此读数时，GUI 只能看到 budget_max_cost=0 却分不清「用户没设」与「设了但引擎没读到」——
  // 两者都表现为"没有水位条"，正是本轮要消灭的那类假信息。
  const costSrc = ctx?.cost_budget_src as 'task' | 'project' | 'none' | undefined;
  const costSrcLabel = costSrc === 'task' ? '（任务级）' : costSrc === 'project' ? '（项目级）' : '';
  // 引擎明确记录过"无上限"（新任务写 0 + src='none'；兼容旧任务里 src 缺失但值为 0 的情形）
  const costNoCapKnown = costSrc === 'none' || (costMax != null && costMax <= 0);
  const costEstimate = ctx?.cost_estimate as { cost?: number; tokens?: number; inputTokens?: number; outputTokens?: number; model?: string; sideTokens?: number } | undefined;
  // zx_20260905 批1: 需求理解预读 token（三调合一预读成本可见；不并入步进/token 记账，仅提示）
  const preludeUsage = (ctx as { prelude_usage?: { tokens?: number } }).prelude_usage;
  const preludeTokens = preludeUsage && typeof preludeUsage.tokens === 'number' ? preludeUsage.tokens : null;
  // zx_20260906_1 1a/1c: 成本如实透出——执行内旁路子 LLM(1a)与任务完成后后台复盘(1c)的估算 token（独立展示，不并入步进预算）
  const sideTokensCe = costEstimate?.sideTokens;
  const bgReviewUsage = (ctx as { bg_review_usage?: { estTokens?: number } }).bg_review_usage;
  const bgReviewTokens = bgReviewUsage && typeof bgReviewUsage.estTokens === 'number' ? bgReviewUsage.estTokens : null;
  const effectiveBudget = ctx?.budget_max_tokens as number | undefined;
  const archetypeLabel = ctx?.archetype_label as string | undefined;
  const finalizeChecks = ctx?.finalize_checks as string[] | undefined;
  const outputValidations = ctx?.output_validations as Array<{ file: string; sufficient: boolean; confidence: number; missingAspects?: string[]; suggestion?: string }> | undefined;
  // zx_20260906_2 批2 (2026-09-06): 验收标准逐条核对证据——finalize 验收 LLM 逐条 {criterion,passed,reason} 落 ctxJson.acceptance_check，此面板逐条可复盘
  // zx_20260916 M1(G9 教训·穷举面): 该形状**跨 root 引 main 侧同一份**——此前是本页手抄的一份匿名类型，
  // 新增 `proposed`/`proposed_checked` 时它必然漏掉（"第二落点"不是只有**词表**，**类型**同样会分家）。
  const acceptanceCheck = ctx?.acceptance_check as AcceptanceCheckLike | undefined;
  // zx_20260916 M1（维特根斯坦「意义即用法」/ renderer 是词表的第二落点）: **验收未通过**须在**状态徽标旁**如实透出。
  //   否则同屏仍是「已完成」(绿徽) + `excellent 90分` + 下方验收块「0 通过 · 8 未达」三种互相否认的口径——
  //   下方那个块早在册（:891/:897/:939），缺的是**徽标旁这一句**：用户扫一眼头部就知道"这个完成不算数"。
  //   判据与 main 侧同尺：只有"已核验且确有未达项"才算（`verified !== false` 且 `failed` 非空）——
  //   `no_criteria`/引擎代拟（`verified:false`）**不**在此打标记（未核验 ≠ 未通过）。
  const acceptanceFailed = !!acceptanceCheck && acceptanceCheck.verified !== false && (acceptanceCheck.failed ?? []).length > 0;
  // zx_20260910_1 M1: 「等待输入」唯一呈现——真源为 ctxJson.awaiting_input（ask_user 与门禁两条暂停路径均持久化），
  //   DB 会话标记仅作旧任务兼容回落，且改取"最后一条"（此前 convs.find 取最旧，会把已回答过的旧问题顶在横幅上）
  const awaitStruct = (ctx as { awaiting_input?: { question?: string; options?: string[]; decision_type?: string } }).awaiting_input;
  const awaitMarker = (() => {
    const hits = convs.filter(c => c.role === 'system' && (c.content || '').startsWith('[等待用户输入]'));
    return hits.length > 0 ? (hits[hits.length - 1]!.content || '') : '';
  })();
  const awaitingInput = task?.status === 'paused' && (!!awaitStruct?.question || !!awaitMarker);
  // zx_20260915 P0-1: 暂停成因（reason 码取 main 侧同一常量，不在此手抄字面量）
  const pausedNoOutput = task?.status === 'paused' && (ctx as { pause_reason?: string } | undefined)?.pause_reason === PAUSE_REASON_NO_OUTPUT;
  // zx_20260917 M2 ②: 因由**原文**与**人话**都走 main 的真源（读点 `recordedPauseReason` / 词表 `pauseReasonLabel`）。
  // 空串 = 账上未记因由（M1 收口前的存量直写点）——此时**如实说"因未记录"**，不静默留白、不编一个原因。
  const pauseReasonCode = task?.status === 'paused' ? recordedPauseReason(task.context_json) : '';
  const pauseReasonText = pauseReasonLabel(pauseReasonCode);
  // zx_20260930 M11-5: `stabilizing`（烹小鲜冷却暂态）的成因就在 `context_json.status_changes` 里——
  //   条数如实数出来给用户看，而不是只丢一句"稳定观察中"让人自己去猜为什么。窗口/阈值与
  //   `project-engine.updateStatus` 的 `COOLING_WINDOW_MS`/`MAX_CHANGES` 同值（那边不可从 renderer import，
  //   故此处**只统计不判定**：判定归引擎，本页只把引擎写下的那笔账读出来说人话）。
  const stabilizingChanges = (() => {
    if (task?.status !== 'stabilizing') return 0;
    const changes = (ctx as { status_changes?: Array<{ at?: string }> } | undefined)?.status_changes;
    return Array.isArray(changes) ? changes.length : 0;
  })();
  const awaitQ = awaitStruct?.question
    ? awaitStruct.question
    : (awaitMarker ? awaitMarker.replace(/^\[等待用户输入\]\s*/, '').replace(/\s*\[选项:.*$/, '').trim() : '');
  // zx_20260930 M3-e（维特根斯坦·同一把尺）: 回落解析改走 `core/im/options.ts` 的 `parseOptions`——
  //   此前本页自带一份 `split(/\s*,\s*|\s*\|\s*/)`，只认**逗号与竖线**两种分隔；而渲染侧（`formatOptions`）
  //   与 IM 匹配侧（`matchApprovalReply`）用的是 ` / | , 、 ; ；` 六种 ⇒ 同一条 `[选项: A / B]`，
  //   IM 里是两个选项、GUI 横幅里**是一个**（"A / B" 整串），点"通过"回传的文字两路对不上。
  //   先问"有没有选项块"再解析：`parseOptions` 把"整段即选项原文"当合法入参，直接喂整条 marker
  //   会把问题正文也切成选项——这里要的是"没有选项就是没有"。（块标记的真源亦只 options.ts 一处。）
  const awaitOpt = awaitStruct?.options?.length
    ? awaitStruct.options
    : (OPTION_BLOCK_RE.test(awaitMarker) ? parseOptions(awaitMarker) : []);
  const awaitType = awaitStruct?.decision_type || 'ask_user';
  // 审批类（路径/特权）必须走 task:respond——只有它写 wa_approvals 指纹（二次免询问），task:resume 不写
  const awaitIsApproval = awaitType === 'path_approval' || awaitType === 'privilege_approval';
  // zx_20260904_7 I3 (2026-09-04): 终态建议(确定性规则，读 ctxJson completion_quality/deliverable_unfulfilled)
  const tctxScore = (ctx as { completion_quality?: { score?: number } | { score?: number } }).completion_quality;
  const lowQuality = task?.status === 'completed' && tctxScore && typeof tctxScore.score === 'number' ? tctxScore.score < 60 : false;
  const hasUnfulfilled = !!(ctx as { deliverable_unfulfilled?: unknown }).deliverable_unfulfilled || lowQuality;
  const showSuggest = (task?.status === 'failed' || task?.status === 'completed') && !awaitingInput;
  const suggestText = task?.status === 'failed'
    ? '执行失败：建议先"恢复(保留对话)"继续；若需从零再来可用"重试(清空重跑)"。'
    : hasUnfulfilled
      ? '存在未达交付（低质/产出未落盘）：建议"重新执行"复核产出，或核对扬弃小结/产出物。'
      : '任务已完成：可"重新执行"复核，或查看本次扬弃小结与产出物。';
  // D1: 「AI 思考中」指示——基于最近步骤事件时间 + 每秒时钟
  const thinkingSec = thinkingSince ? Math.max(0, Math.round((nowTick - thinkingSince) / 1000)) : 0;
  const liveToolNames = liveStatus?.toolCalls ? toolNamesFromStr(String(liveStatus.toolCalls)) : [];
  // D5: 预算/token 实时显示——执行中优先用实时 totalTokens，非执行用 context_json
  const executingNow = task?.status === 'executing' || task?.status === 'running';
  const displayTokens = executingNow && liveStatus?.totalTokens != null ? Number(liveStatus.totalTokens) : (tokensUsed || 0);
  // zx_20260906 批4 (4b): 长任务心跳可见——无 step_finished / 无流式文本（长工具步）时仍显示"推进中"活跃脉冲
  const hbFresh = !!heartbeat && executingNow && !liveStatus && !streamingText && (nowTick - heartbeat.ts) < 30_000;
  // E1 (2026-09-04_2): 预算带质变点——累计口径 ratio/band（step_finished 实时 / context 兜底），band 越界脉冲
  const liveBudgetRatio = executingNow && liveStatus && typeof liveStatus.budgetRatio === 'number' ? Number(liveStatus.budgetRatio) : null;
  const liveBudgetMax = liveStatus && typeof liveStatus.budgetMaxTokens === 'number' ? Number(liveStatus.budgetMaxTokens) : 0;
  const effBudgetTok = effectiveBudget || liveBudgetMax || (ctxForm.max_tokens_per_task ? Number(ctxForm.max_tokens_per_task) : 0);
  const curRatio = liveBudgetRatio != null ? liveBudgetRatio : (budgetUsage != null ? Number(budgetUsage) : (effBudgetTok > 0 && displayTokens > 0 ? Math.min(1, displayTokens / effBudgetTok) : null));
  const BAND_OF = (r: number): number => (r >= 0.98 ? 5 : r >= 0.95 ? 4 : r >= 0.75 ? 3 : r >= 0.60 ? 2 : 1);
  const curBand = curRatio == null ? 0 : BAND_OF(curRatio);
  // zx_20260910_5 M1: 费用闸带位（与 token 侧同一档位定义，供费用水位条着色）
  const costBand = costUsageRatio == null ? 0 : BAND_OF(costUsageRatio);
  const [budgetFlash, setBudgetFlash] = useState<string | null>(null);
  const budgetBandPeakRef = useRef(0);
  const budgetFlashTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (curBand > 0 && budgetBandPeakRef.current > 0 && curBand > budgetBandPeakRef.current) {
      const m = curBand >= 5 ? '已接近强制收尾(98%)' : curBand === 4 ? '预算已达95%·将收窄工具并防死锁' : curBand === 3 ? '预算已达75%·收敛档' : '预算已达60%·收敛档';
      setBudgetFlash(`预算已用 ${Math.round((curRatio ?? 0) * 100)}% → ${m}`);
      if (budgetFlashTimerRef.current !== undefined) window.clearTimeout(budgetFlashTimerRef.current);
      budgetFlashTimerRef.current = window.setTimeout(() => setBudgetFlash(null), 4000);
    }
    if (curBand > budgetBandPeakRef.current) budgetBandPeakRef.current = curBand;
  }, [curBand, curRatio]);
  useEffect(() => () => { if (budgetFlashTimerRef.current !== undefined) window.clearTimeout(budgetFlashTimerRef.current); }, []);
  useEffect(() => { budgetBandPeakRef.current = 0; setBudgetFlash(null); }, [task?.id]);

  // zx_20260907 M3(复核补): 父/依赖任务显示名——同项目任务表查标题，查不到回退短 id(原直显原始 id 不可读)
  const taskNameOf = (id?: string | null): string => {
    if (!id) return '';
    return taskList.find((t) => t.id === id)?.title || `${id.slice(0, 8)}...`;
  };
  // zx_20260908 优化4/5: 关联任务(父/前置/子)可直接跳转——保留原始 id 供 navigate；名称经 taskNameOf 查表显示
  const depIds = String(task?.depends_on || '').split(',').map((s) => s.trim()).filter(Boolean);
  // zx_20260913 M3-5(名实相符): 前置阻塞态**按状态算**——旧文案只要 depends_on 非空就喊"被前置依赖阻塞"，
  // 于是"前置早已完成"和"前置已失败永不满足"看起来一模一样。判据取 dep-graph 唯一真源。
  // zx_20260917 M3: 第四个取值函数给前置的 `context_json`——`paused` 前置按**因由**细分（因等子而暂停者
  // 会零人工自解），不传则暂停一律按保守的"须人工"说 ⇒ 会把等子而暂停的前置误报成"永不可满足"。
  const depInfo = depBlockInfo(
    depIds,
    (id) => taskList.find((t) => t.id === id)?.status,
    (id) => taskNameOf(id),
    (id) => taskList.find((t) => t.id === id)?.context_json,
  );
  // M3-4: 前置可编辑——候选=同项目、非自身、非归档、且未在前置内
  const depCandidates = taskList.filter((t) => t.project_id === task?.project_id && t.id !== task?.id && t.status !== 'archived' && !depIds.includes(t.id));
  const [depPickerOpen, setDepPickerOpen] = useState(false);
  const [depPickId, setDepPickId] = useState('');
  const [depSaving, setDepSaving] = useState(false);
  const saveDeps = async (next: string[]): Promise<void> => {
    if (!task) return;
    setDepSaving(true);
    try {
      await tasks.update(task.id, { depends_on: next.join(',') });
      setDepPickerOpen(false);
      setDepPickId('');
      loadProject();
    } catch (e) { reportAction(e); } finally { setDepSaving(false); }
  };

  // 所有 hook 均已在上方执行完毕，此后可安全提前返回（防"加载后 hook 数量变化"白页）
  if (loading) return <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full"/></div>;
  if (!task) {
    return (
      <div className="bg-white rounded-lg border p-10 text-center">
        <p className="text-gray-500 mb-3">任务不存在或已删除（可能来自过期通知）</p>
        <button onClick={() => navigate('/tasks')} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">返回任务列表</button>
      </div>
    );
  }

  // zx_20260923_1 M3（道德经·四十八章「为道日损」）: 「产出物」块——**默认折叠**，
  //   且整块渲染在「事件时间线」**之上**（用户 2026-09-23 点名：把产出物移到事件时间线上面）。
  //   抽成变量只为让"位置"与"清单内容"两件事分开改；**每一行**内部逐字未动
  //   （类型 / 主要成果 / 归属 / 已验收 / 另有写过，五处标注全在）。折叠头额外报**条数**——
  //   折叠态下若连有几条都看不见，那就不叫"默认折叠"，叫"默认消失"。
  //   ⚠ 订正（zx_20260924 §2c UI-3，2026-09-24）：本句原写"清单内部**逐字未动**"——UI-3 把**摆法**
  //   由一维平铺换成目录树后，这句对"行的**集合**"仍真、对"**排列**"已假。逐字未动的范围自此限定为**行内**，
  //   排列由 `buildDeliverableTree` 决定（摆法不筛件：展平后逐条相等，rr 【UI】束④钉住）。
  // zx_20260924 §2c UI-1（用户 2026-09-24 点名）: 「记忆注入」**上移**至「本次附件」之上、「产出物」之前，
  //   并改为**默认折叠**。上移由头：它与「本次附件」同族——都是"本次任务往上下文里放了什么"
  //   （前者放既往记忆、后者放本次素材），「产出物」是输出那一头 ⇒ 一族对着产出物成"一进一出"，
  //   比把 M7 刚建立的"一进一出"拆开更合读法。折叠由头与 M3/M7 一字不差（全铺开时长距滚动）。
  //   **块内逐字未动**（类型 / 可信度 / tag / 召回理由 / 内容 / 「降权」「删除」两钮全在）——
  //   本次只改"位置"与"默认可见性"，**不删功能**（承 zx_20260923_1 M3 的同一取舍）。
  const memBlock = memoryInjection.length > 0 && (
    <div className="bg-white rounded-lg border p-4">
      <button type="button" onClick={() => setShowMem((v) => !v)} className="w-full text-left font-medium text-sm flex items-center gap-1">
        {showMem ? <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />}
        <Brain className="w-4 h-4 text-violet-500 shrink-0" />记忆注入
        <span className="text-[10px] font-normal text-gray-400">（{memoryInjection.length} 条）</span>
      </button>
      {showMem && <div className="space-y-1.5 max-h-72 overflow-y-auto mt-2">{memoryInjection.map((m,i)=>(<div key={i} className="flex items-start justify-between gap-2 text-sm py-1.5 px-2 hover:bg-gray-50 rounded border-b last:border-0"><div className="flex-1 min-w-0"><div className="flex items-center gap-1.5 flex-wrap"><span className="text-xs px-1.5 py-0.5 rounded bg-violet-50 text-violet-600">{String(m.type)}</span><span className="text-xs text-gray-400">可信度 {Number(m.confidence)}%</span>{m.tag ? <span className="text-[10px] text-gray-400">{String(m.tag).slice(0, 40)}</span> : null}{m.reason ? <span className="text-[10px] text-blue-500 max-w-[40%] truncate" title={String(m.reason)}>召回:{String(m.reason).slice(0, 30)}</span> : null}</div><p className="text-xs text-gray-600 truncate mt-0.5" title={String(m.content)}>{String(m.content)}</p></div><div className="flex gap-1 shrink-0"><button onClick={()=>handleDownweightMemory(String(m.id))} className="text-[10px] px-1.5 py-0.5 bg-gray-100 rounded hover:bg-gray-200 text-gray-600">降权</button><button onClick={()=>handleDeleteMemory(String(m.id))} className="text-[10px] px-1.5 py-0.5 bg-red-50 rounded hover:bg-red-100 text-red-500">删除</button></div></div>))}</div>}
    </div>
  );

  // zx_20260924 M7: 「本次附件」——**本次任务带了什么件、每件去了哪里**，此前渲染层零处引用（用户看不见）。
  //   `attachments_outcomes` 由引擎在装配那一刻落库（`agent-executor.ts`），与入站登记的 `attachments`
  //   是两回事：前者是**去向**（内联/未内联/失败 + 原因 + 盘上路径），后者是**来件登记**。
  //   **老任务没有此键 ⇒ 空数组 ⇒ 整块不渲染**（不显示"0 个附件"那种编造出来的事实）。
  const atts = parseAttachmentOutcomeViews((ctx as { attachments_outcomes?: unknown }).attachments_outcomes);
  //   与「产出物」相邻（一进一出），折叠形与 M3 的产出物/对话历史一致；折叠头报**件数**——
  //   折叠态下连有几件都看不见就不叫"默认折叠"，叫"默认消失"（同 M3 的由头）。
  const attsBlock = atts.length > 0 && (
    <div className="bg-white rounded-lg border p-4">
      <button type="button" onClick={() => setShowAtts((v) => !v)} className="w-full text-left font-medium text-sm flex items-center gap-1">
        {showAtts ? <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />}
        <Paperclip className="w-4 h-4 text-sky-500 shrink-0" />本次附件
        <span className="text-[10px] font-normal text-gray-400">（{atts.length} 件）</span>
      </button>
      {showAtts && <div className="space-y-1 mt-2">{atts.map((a, i) => (
        <div key={i} className="text-sm py-1 px-2 hover:bg-gray-50 rounded">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-mono text-gray-400 shrink-0">{a.family}</span>
            <span className="truncate" title={a.fileName}>{a.fileName}</span>
            {typeof a.bytes === 'number' && <span className="text-[10px] text-gray-400 shrink-0">{a.bytes} B</span>}
            <span className={`ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded-full ${ATT_TONE[a.status]}`}>{ATTACHMENT_STATUS_LABEL[a.status]}</span>
          </div>
          {a.reason && <p className="text-xs text-gray-500 mt-0.5 break-words">原因：{a.reason}</p>}
          <p className="text-[11px] text-gray-400 font-mono truncate" title={a.path}>盘上：{a.path}</p>
        </div>
      ))}</div>}
    </div>
  );

  // zx_20260924 §2c UI-3（用户 2026-09-24 点名）: 产出物**按盘上路径的目录层级**展示——一维平铺看不出
  //   "是哪些目录下的哪些件"（真库里 `参考项目/example-suite/payment/…` 一族十几条挤在一起）。
  //   树由 main 侧**零依赖纯函数** `buildDeliverableTree` 建（两条规则见该模块头注释），本页只负责"摆"。
  // ⚠ **这是摆法不是筛选**：展平后逐条与改前相等（件数不变、不重不漏，由 rr 【UI】束④钉住）。
  const delivTree = buildDeliverableTree(delivs);
  // 叶子行——**逐字保留**改前那一行的全部标注（类型 / ★主要成果 / 子任务归属 / ✓已验收 / 另有写过 /
  //   status / 预览 / 版本流抽屉）。抽成函数只为让**目录树与「无盘上路径」桶共用同一行**：
  //   两处各写一份迟早分叉（本仓 G8 老病）。`depth` 只决定缩进（`px-2` 的左内边距由行内样式接管）。
  //   标题**仍是 `d.name`，不是 basename**：真库 399 条里 72 条的 `name` 是**人写标题**
  //   （`TrendRadar UI Dashboard` 的文件是 `index.html`、`两新关键位买入时机监控` 的是
  //   `intraday_alert_daemon.py`）⇒ 换 basename 会把这 72 条唯一可读的名字换成文件名。
  //   目录层级由**树的位置**给（= `file_path` 的目录段），与 `name` **互补不重叠**。
  const delivRow = (d: DelivItem, depth: number) => (
    <div key={d.id} className="flex items-center justify-between text-sm py-1 px-2 hover:bg-gray-50 rounded" style={{ paddingLeft: `${8 + depth * 14}px` }}><span className="flex items-center gap-2 min-w-0"><span className="text-xs font-mono text-gray-400 shrink-0">{d.type}</span>{d.is_primary===1&&<span title="主要成果" className="shrink-0"><Star className="w-3.5 h-3.5 text-amber-500 fill-amber-400"/></span>}<span className="truncate" title={d.file_path||undefined}>{d.name}</span>{/* zx_20260913 M2-1: 清单含子任务产出——逐条标明归属，防把子任务的成果误读成本任务的 */}{d.owner_task_id&&d.owner_task_id!==task.id&&<button type="button" onClick={()=>navigate(`/tasks/${d.owner_task_id}`)} title={`来自子任务：${d.owner_task_title||'未知任务'}（点击跳转）`} className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-teal-50 text-teal-700 hover:bg-teal-100">子任务 {d.owner_task_title||'未知任务'}</button>}{showAccD&&d.acceptance_verified===1&&<span title="该成果已通过验收核验（doc/code 级如实）" className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">✓已验收</span>}{/* zx_20260913 M2-2: 归属只认首次写出者；后写者如实透出（由版本行 changed_by 派生，非夺走归属） */}{!!d.other_writers?.length&&<span className="shrink-0 text-[10px] text-gray-400" title={d.other_writers.map(w=>`${w.title}（${w.id}）`).join('\n')}>另有 {d.other_writers.map(w=>w.title).join('、')} 写过</span>}</span><span className="flex items-center gap-1 shrink-0"><span className={`text-xs px-1.5 py-0.5 rounded-full ${d.status==='running'?'bg-green-100 text-green-700':'bg-gray-100'}`}>{statusText(DELIVERABLE_STATUS_LABEL, d.status)}</span>{/* zx_20260913 M2-6: 判据由手抄 `type==='doc'` 换成共享 isPreviewType（doc/code）——与列表页同一份代码 */}{isPreviewType(d.type)&&<button onClick={()=>handlePreviewDeliv(d)} title="预览" className="p-0.5 hover:bg-blue-50 rounded"><Eye className="w-3.5 h-3.5 text-blue-500"/></button>}{isPreviewType(d.type)&&drawerOn&&<button onClick={()=>openDeliv(d.id)} title="版本流详情(抽屉)" className="p-0.5 hover:bg-amber-50 rounded"><History className="w-3.5 h-3.5 text-amber-500"/></button>}</span></div>
  );
  // 树 → 行：目录行给**段名 + 其后代件数**（缩进时靠它看出分量），叶子交给上面的共用行。
  const renderDelivTree = (children: DeliverableTreeChild<DelivItem>[], depth: number): ReactNode =>
    children.map((c) => c.kind === 'dir' ? (
      <div key={`dir:${c.name}`}>
        <div className="flex items-center gap-1.5 text-sm py-1 px-2 text-gray-600" style={{ paddingLeft: `${8 + depth * 14}px` }}>
          <Folder className="w-3.5 h-3.5 text-amber-500 shrink-0" />
          <span className="font-medium truncate" title={c.name}>{c.name}</span>
          <span className="text-[10px] text-gray-400 shrink-0">{c.count} 件</span>
        </div>
        {renderDelivTree(c.children, depth + 1)}
      </div>
    ) : delivRow(c.item, depth));

  const delivsBlock = delivs.length > 0 && (
    <div className="bg-white rounded-lg border p-4">
      <button type="button" onClick={() => setShowDelivs((v) => !v)} className="w-full text-left font-medium text-sm flex items-center gap-1">
        {showDelivs ? <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />}
        <PackageIcon className="w-4 h-4 text-purple-500 shrink-0" />产出物
        {/* zx_20260930 M4-2: 计数取**服务端全量口径**（`deliverablesTotal`）——印 `delivs.length` 会把
            "这一批 100 条"说成"一共就 100 条"，与下方「加载更多」自相矛盾。 */}
        <span className="text-[10px] font-normal text-gray-400">本任务（含子任务）{delivTotal} 条</span>
      </button>
      {showDelivs && <div className="mt-2">
        {/* 如实说明"相对哪个根"——不写这句，用户会以为这些件就住在只有一两层的目录里 */}
        {delivTree.commonPrefix.length > 0 && <p className="text-[10px] text-gray-400 px-2 mb-1">相对根：{delivTree.commonPrefix.join('/')}/</p>}
        {renderDelivTree(delivTree.root, 0)}
        {/* 没有盘上路径的件**如实单列**，不塞进任何假目录（塞了就是编造"它在哪"） */}
        {delivTree.noPath.length > 0 && (
          <div className="mt-2 pt-2 border-t border-gray-100">
            <p className="text-[10px] text-gray-400 px-2">（无盘上路径 · {delivTree.noPath.length} 条）</p>
            {delivTree.noPath.map((d) => delivRow(d, 0))}
          </div>
        )}
      </div>}
      {showDelivs && !delivExhausted && (
        <div className="flex items-center justify-between gap-3 border-t mt-2 pt-2 text-[11px] text-gray-500">
          <span>已加载 {delivs.length} / 共 {delivTotal} 条</span>
          <button onClick={loadMoreDelivs} disabled={delivMoreBusy}
            className="px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-50">{delivMoreBusy ? '加载中…' : '加载更多'}</button>
        </div>
      )}
    </div>
  );

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate('/tasks')} className="p-1 hover:bg-gray-100 rounded"><ArrowLeft className="w-5 h-5"/></button>
        <h2 className="text-xl font-bold">{projectName}</h2>
        <span className="text-sm text-gray-400">· {taskList.length} 个任务</span>
        <div className="flex-1"/>
        <button onClick={loadProject} className="p-1.5 hover:bg-gray-100 rounded"><RefreshCw className="w-4 h-4"/></button>
        <button onClick={() => setShowCreate(true)} title="为当前任务新建子任务" className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"><Plus className="w-3.5 h-3.5"/>新建子任务</button>
      </div>
      {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
      {/* G2 (2026-09-04_2 整改): 动作"两态"回执——被拒原因显式透出（乐观先行 + 真实回执/失败原因） */}
      {actionMsg && (
        <div className="flex items-center gap-2 mb-4 px-3 py-2 bg-amber-50 border border-amber-300 rounded-lg text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 shrink-0 text-amber-500" />
          <span className="flex-1">{actionMsg}</span>
          <button type="button" onClick={() => setActionMsg('')} className="text-amber-400 hover:text-amber-600"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* 任务详情 */}
      <div className="space-y-4">
          {task ? (
            <>
              {/* zx_20260904_4 T1 (2026-09-04): 需求理解卡 chip（zx_20260906 批3/3a 起常驻——完成/历史任务亦可复盘"本次理解"；执行中仍可折叠即时纠偏） */}
              {(ctx as unknown as { requirement_card?: string }).requirement_card && (
                <details className="mb-3 bg-indigo-50 border border-indigo-100 rounded-lg px-3 py-2 text-xs text-indigo-800">
                  <summary className="cursor-pointer font-medium">📋 需求理解卡</summary>
                  <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{(ctx as unknown as { requirement_card?: string }).requirement_card}</pre>
                </details>
              )}
              {/* zx_20260904_7 I3 (2026-09-04): 终态"建议下一步"卡（确定性规则） */}
              {showSuggest && (
                <div className="mb-3 p-2 bg-gray-50 border border-gray-200 rounded-lg flex flex-wrap items-center gap-2">
                  <span className="text-xs text-gray-600 flex-1 min-w-0">{suggestText}</span>
                  {task?.status === 'failed' && <button type="button" onClick={() => handleResume(task!.id)} disabled={actionLocked} className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">恢复（保留对话）</button>}
                  <button type="button" onClick={() => handleRetry(task!.id)} disabled={actionLocked} className="text-xs px-2 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed">重试（清空重跑）</button>
                </div>
              )}
              {/* 任务头部 + 统计卡片 */}
              <div className="bg-white rounded-lg border p-4">
                {awaitingInput && <div className="p-2 mb-3 bg-amber-50 border border-amber-300 rounded-lg">
                  <div className="flex items-center gap-2 flex-wrap"><span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse shrink-0"/><span className="text-sm font-medium text-amber-800">等待你的回复</span>{awaitType !== 'ask_user' && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-200/70 text-amber-800">{AWAIT_TYPE_LABEL[awaitType] || awaitType}</span>}</div>
                  {awaitQ && <p className="mt-1 text-xs text-amber-900 whitespace-pre-wrap break-words">{awaitQ}</p>}
                  {!awaitIsApproval && awaitOpt.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1.5">{awaitOpt.map((o, i) => (<button key={i} type="button" onClick={() => { setReplyText(o); setShowReply(true); }} className="text-[11px] px-2 py-1 rounded-full bg-amber-200/70 text-amber-900 hover:bg-amber-300 transition-colors break-words max-w-full text-left">{o}</button>))}</div>}
                  {awaitIsApproval && <div className="mt-2 flex gap-1.5">
                    <button type="button" onClick={() => handleDecision(task.id, 'allow')} disabled={actionLocked} className="text-xs px-2 py-1 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed">允许</button>
                    <button type="button" onClick={() => handleDecision(task.id, 'deny')} disabled={actionLocked} className="text-xs px-2 py-1 bg-white border border-red-300 text-red-600 rounded hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed">拒绝</button>
                  </div>}
                  <button type="button" onClick={() => { setReplyText(''); setShowReply(true); }} disabled={actionLocked} className="mt-2 text-xs px-2 py-1 bg-teal-600 text-white rounded hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed">回复并恢复</button>
                </div>}
                {/* zx_20260930 M11-5: `stabilizing` 兜底横幅。此态由 `project-engine.updateStatus` 的「烹小鲜」
                    冷却检测写入（窗口内状态变更超阈值 ⇒ 自动操作停止、等人工确认）。**引擎侧不给它出口**：
                    自愈超时扫描与调度器的超时回收都刻意不含它（见 `EXEC_STALE_STATUSES`），因为它是"等人"的
                    暂态而非"卡死"。唯一的出口在这条横幅上——此前 GUI 两处词表都没有这个取值，用户看到的是
                    原始 key `stabilizing` 且**没有任何按钮**，任务就此永久停住。 */}
                {task.status==='stabilizing' && <div className="p-2 mb-3 bg-amber-50 border border-amber-300 rounded-lg"><div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse"/><span className="text-sm text-amber-800 font-medium">稳定观察中（自动操作已停止）</span><span className="text-xs text-amber-600">{stabilizingChanges > 0 ? `近期状态变更 ${stabilizingChanges} 次，超过冷却阈值——` : ''}任务在短时间内反复改状态，引擎已按「烹小鲜」原则停下手，等人工确认后再继续。它不会自己超时恢复，需要一个明确出口。</span><button onClick={()=>handleStatus(task.id,'pending')} disabled={actionLocked} title="确认无异常，放回队列等下一轮调度自动拉起" className="ml-auto flex items-center gap-1 px-2 py-1 bg-amber-600 text-white rounded text-xs hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"><Play className="w-3 h-3"/>确认并放回队列</button></div></div>}
                {/* D3: 暂停中状态提示（非等待输入的手动暂停），带恢复入口 */}
                {/* zx_20260915 P0-1(§10.3-5 renderer 是词表第二落点): 暂停横幅按 `pause_reason` **分型**——
                    先前只有一句话「执行已挂起，可恢复继续」，而「收口无产出证据」是**事实**判定（不是可
                    随手续跑的挂起），用户据此无从知道该补产出还是该点完成。 */}
                {task.status==='paused' && !awaitingInput && <div className="p-2 mb-3 bg-orange-50 border border-orange-300 rounded-lg"><div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-orange-500 animate-pulse"/><span className="text-sm text-orange-800 font-medium">{pausedNoOutput ? '未达交付（无产出证据）' : (pauseReasonText ? `已暂停：${pauseReasonText}` : '已暂停（因未记录）')}</span><span className="text-xs text-orange-600">{pausedNoOutput ? '收口时未发现任何真实产出证据（无落盘成果、无交付物登记、无写入类工具调用）——已暂停而非标完成。若确有产出，请核验后「恢复」；若确认无需产出，可点「完成」。' : '执行已挂起，可恢复继续'}</span><button onClick={()=>handleResume(task.id)} disabled={actionLocked} className="ml-auto flex items-center gap-1 px-2 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"><RotateCcw className="w-3 h-3"/>恢复</button></div>
                  {/* zx_20260923 M7-c（G15）: 横幅内联附言——承 G15 口径订正，「附言」此前只在动作栏那处模态框可达，
                      本批补的是**横幅里这一处缺口**。走的是既有的那个恢复方法，后端零改动。 */}
                  <div className="flex items-center gap-2 mt-2"><input value={bannerReply} onChange={e=>setBannerReply(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')handleResumeWithNote(task.id);}} className="flex-1 px-2 py-1 border border-orange-200 rounded text-xs bg-white" placeholder="附言（可选）：告诉它恢复后要注意什么，随本次恢复注入执行"/><button onClick={()=>handleResumeWithNote(task.id)} disabled={!bannerReply.trim()||actionLocked} className="shrink-0 px-2 py-1 bg-teal-600 text-white rounded text-xs hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed">附言并恢复</button></div></div>}
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1 flex-wrap"><h3 className="font-semibold text-lg">{task.title}</h3><button type="button" onClick={(e) => { e.stopPropagation(); navigate(`/activity?obj=${task.id}`); }} title="该任务活动时间线" className="shrink-0 p-0.5 text-gray-400 hover:text-blue-500"><History className="w-4 h-4" /></button>{ownMs[0]?<button type="button" onClick={(e)=>{e.stopPropagation();navigate(`/tasks/${String(ownMs[0].plan_task_id)}`);}} className="text-[10px] px-1.5 py-0.5 rounded bg-teal-50 text-teal-700 hover:bg-teal-100 shrink-0" title={`所属方案里程碑 ${ownMs[0].milestone}：${ownMs[0].status}`}>方案 {ownMs[0].milestone}: {ownMs[0].status==='done'?'已落地':ownMs[0].status==='doing'?'进行中':'待实施'}</button>:null}<span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLOR[task.status]||'bg-gray-100'}`}>{statusText(TASK_STATUS_LABEL, task.status)}</span>{acceptanceFailed && <span title={`账上验收有 ${(acceptanceCheck!.failed ?? []).length} 条判据未达成（共 ${acceptanceCheck!.criteria_total ?? 0} 条）——「已完成」不等于「已验收」，详见下方验收块`} className="cursor-help text-[10px] px-1.5 py-0.5 rounded-full border border-red-200 bg-red-50 text-red-600 font-medium">✗ 验收 {(acceptanceCheck!.failed ?? []).length} 条未达</span>}{archetypeLabel&&<span className="text-xs px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600">{archetypeLabel}</span>}{taskEstimate?.basedOn ? <span title={`基于 ${taskEstimate.basedOn} 个相似历史任务预估`} className="text-xs px-1.5 py-0.5 rounded-full bg-cyan-50 text-cyan-600">预估 {formatToken(taskEstimate.tokens)} / {taskEstimate.steps}步</span> : null}{PRIORITY_LABEL[task.priority] && <span className="text-xs text-orange-500 font-medium">{PRIORITY_LABEL[task.priority]}</span>}{completionQuality&&<span title={completionQuality.feedback||''} className={`cursor-help text-xs px-1.5 py-0.5 rounded-full font-medium ${(completionQuality.score||0)>=80?'bg-green-100 text-green-700':(completionQuality.score||0)>=60?'bg-yellow-100 text-yellow-700':(completionQuality.score||0)>=40?'bg-orange-100 text-orange-700':'bg-red-100 text-red-600'}`}>★{completionQuality.score}分</span>}{autoCompletedNoOutput && <span title="该任务被直接标记完成但未产出真实成果（update_task_status 工具），未经 finalize 成果门禁——请人工复核" className="cursor-help text-[10px] px-1.5 py-0.5 rounded-full border border-red-200 bg-red-50 text-red-600 font-medium">⚠ 未达成果门禁</span>}{budgetUsage!=null&&<span className={`text-xs px-1.5 py-0.5 rounded-full ${budgetUsage>=0.95?'bg-red-100 text-red-700':budgetUsage>=0.7?'bg-yellow-100 text-yellow-700':'bg-blue-100 text-blue-700'}`}>{Math.round(budgetUsage*100)}%预算</span>}{displayTokens!=null&&<span className="text-xs text-gray-400">{displayTokens>=1000?(displayTokens/1000).toFixed(1)+'K':String(displayTokens)} tokens</span>}{costEstimate?.cost!=null&&<span title={`本次执行成本估算（¥）${costEstimate.cost>0?'':'· 所选模型单价为 0/未计费'}${costEstimate.model?` · 模型 ${costEstimate.model}`:''}`} className="text-xs text-gray-500">💰{costEstimate.cost>0?`¥${costEstimate.cost.toFixed(4)}`:`¥0${costEstimate.model?`(${costEstimate.model})`:''}`}</span>}{preludeTokens!=null&&<span className="text-xs text-purple-400" title="任务开始前的需求理解预读消耗（主要矛盾+立志+需求卡「三调合一」单次预读），不计入步进 token"> · 预读~{formatToken(preludeTokens)}</span>}{sideTokensCe!=null&&sideTokensCe>0&&<span className="text-xs text-amber-500" title="本次执行内旁路子 LLM（验收/内容校验/目标偏离核对）的估算 token，已并入上方总 token（账实相符）"> · 旁路~{formatToken(sideTokensCe)}</span>}{bgReviewTokens!=null&&bgReviewTokens>0&&<span className="text-xs text-purple-300" title="任务完成后后台复盘（background-review：三元组+记忆提取+复盘+行动转化）的估算 token，独立于执行预算"> · 复盘~{formatToken(bgReviewTokens)}</span>}</div>
                    {/* B2: 模板匹配依据——为什么套用了这个模板拆解 */}
                    {matchedInfo && <p className="text-[11px] text-indigo-600 mb-1 flex items-center gap-1.5 flex-wrap"><span className="font-medium">🧩 模板拆解</span><span className="text-gray-400">模板 {matchedInfo.tpl}</span>{matchedInfo.method === 'semantic' ? <span className="px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600">语义匹配{matchedInfo.sim != null ? ` 相似度 ${matchedInfo.sim}` : ''}</span> : <span className="px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600">关键词匹配</span>}{matchedInfo.field ? <span className="px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600">命中{matchedInfo.field === 'title' ? '标题' : '描述'}</span> : null}{matchedInfo.kw.length > 0 && <span className="text-gray-500">命中: {matchedInfo.kw.join('、')}</span>}</p>}
                    {/* zx_20261002 M7: 引擎路拆解溯源——无模板者由"引擎自动拆解"补上，不再恒隐藏（依据见会话流 [智能拆解]） */}
                    {engineDecomposed && <p className="text-[11px] text-indigo-600 mb-1 flex items-center gap-1.5 flex-wrap"><span className="font-medium">🧩 引擎自动拆解</span><span className="px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600">无匹配模板 · 按任务复杂度自动拆分</span><span className="text-gray-500">共 {engineDecomposed.count} 个子任务，拆解依据见会话流 [智能拆解] 记录</span></p>}
                    {task.description && <p className="text-sm text-gray-500">{task.description}</p>}
{completionQuality?.feedback && <p className="text-xs text-gray-400 mt-1">{completionQuality.feedback}</p>}
                    {/* zx_20261018_1 批七「账」: 七源分账与裁剪数上屏（中文标签，renderer 是词表第二落点） */}
                    {tokenBreakdown && <p className="text-[11px] text-gray-500 mt-1 flex items-center gap-1.5 flex-wrap" title="本次执行上下文按来源拆分（字符÷4 估算 token）；超预算时按 知识→记忆→历史 顺序裁剪，用户请求/验收标准/系统骨架不裁">
                      <span className="font-medium text-gray-600">Token 分账</span>
                      <span className="px-1.5 py-0.5 rounded-full bg-gray-100">系统 {formatToken(tokenBreakdown.system)}</span>
                      <span className="px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700">记忆 {formatToken(tokenBreakdown.memory)}</span>
                      <span className="px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700">知识 {formatToken(tokenBreakdown.knowledge)}</span>
                      <span className="px-1.5 py-0.5 rounded-full bg-sky-50 text-sky-700">历史 {formatToken(tokenBreakdown.history)}</span>
                      <span className="px-1.5 py-0.5 rounded-full bg-gray-100">工具 {formatToken(tokenBreakdown.tools)}</span>
                      <span className="px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700">用户 {formatToken(tokenBreakdown.user)}</span>
                      <span className="px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-700">产出 {formatToken(tokenBreakdown.output)}</span>
                      <span className="font-medium text-gray-600">合计 {formatToken(tokenBreakdown.total)}</span>
                      {tokenBreakdown.budget > 0 && <span>预算 {formatToken(tokenBreakdown.budget)}</span>}
                      <span>{tokenBreakdown.trimmedTotal > 0 ? `已裁剪 ${tokenBreakdown.trimmedTotal} 字符` : '未裁剪'}</span>
                      {tokenBreakdown.overBudget && <span className="text-red-600 font-medium">裁剪后仍超预算</span>}
                    </p>}
                    {/* zx_20260924_1 M9-c: 完成来源——「这个分是谁给的」。**只显示，不改判定**（V-8 已裁定）。 */}
                    {completionVia && <p className="text-[11px] text-gray-400 mt-1">完成来源：<span className="font-medium text-gray-500">{completionVia}</span>{completionViaNote ? ` —— ${completionViaNote}` : ''}</p>}
                    {/* zx_20260924_1 M9-b: 无相似样本时的估时留痕——「没估时」不是"还没跑"，是"没有样本可依" */}
                    {estimateMissingNote && <p className="text-[11px] text-gray-400 mt-1">未估时：{estimateMissingNote}（本任务的步数预算按基础值计）</p>}
                    {/* B2 收口 checks 逐条着色——**renderer 是这份前缀词表的第二个落点**：main 侧新增一个前缀值
                        （zx_20260922_1 M5 加 `[INFO]`：世界模型审计的"未做判定"如实说明），此处必须**显式**列一档，
                        否则它会落进末尾的兜底灰、与"不认识的前缀"混同（`zx_20260912` G9 的老病）。 */}
                    {finalizeChecks && finalizeChecks.length > 0 && <div className="mt-2 space-y-0.5">{finalizeChecks.map((c, i) => <p key={i} className={`text-xs ${c.startsWith('[PASS]')?'text-green-600':c.startsWith('[WARN]')?'text-yellow-600':c.startsWith('[FAIL]')?'text-red-600':c.startsWith('[INFO]')?'text-blue-600':'text-gray-500'}`}>{c}</p>)}</div>}
                    {/* zx_20260924_1 M9-c: 里程碑缺口**升格**（原来是 finalize_checks 里的一句 [WARN]，条数不明、易被当过场）
                        ——「登记在板」≠「已执行」。⚠ **只显示，不拦截完成**（V-8 已裁定：本轮不动完成决定）。 */}
                    {milestonesWithoutChildTasks.length > 0 && <p className="mt-2 px-2 py-1 rounded bg-amber-50 border border-amber-200 text-xs text-amber-700">⚠️ {milestonesWithoutChildTasks.length} 个里程碑尚无对应子任务：{milestonesWithoutChildTasks.join('、')}（"登记在板上" ≠ "已执行"；本提示只报不拦，不影响完成判定）</p>}
                  </div>
                </div>
                {/* 统计 */}
                <div className="grid grid-cols-4 gap-3 mb-3">
                  <div className="bg-blue-50 rounded-lg p-2 text-center"><p className="text-lg font-bold text-blue-700">{formatToken(displayTokens)}</p><p className="text-[10px] text-blue-500">{executingNow ? 'Token消耗(实时)' : 'Token消耗'}</p></div>
                  <div className="bg-purple-50 rounded-lg p-2 text-center"><p className="text-lg font-bold text-purple-700">{convTotal}</p><p className="text-[10px] text-purple-500">对话轮次</p></div>
                  <div className="bg-green-50 rounded-lg p-2 text-center"><p className="text-lg font-bold text-green-700">{delivTotal}</p><p className="text-[10px] text-green-500" title="含子任务产出（task:get 子树聚合）">本任务（含子任务）</p></div>
                  <div className="bg-orange-50 rounded-lg p-2 text-center"><p className="text-lg font-bold text-orange-700">{task.aggregate_version||0}</p><p className="text-[10px] text-orange-500">版本</p></div>
                </div>
                {/* zx_20260906_1 3e: 重试后信息差——当前成果空但存在已退休(旧版)成果时透出，避免误读为"无成果" */}
                {delivTotal === 0 && retiredCount > 0 && (
                  <div className="mb-3 px-3 py-2 rounded bg-gray-50 border border-gray-200 text-xs text-gray-500 flex items-center justify-between gap-2">
                    <span>当前无有效产出物——该任务曾重试，有 <b>{retiredCount}</b> 项旧成果已退休(soft-retired，版本历史保留)。</span>
                    <button type="button" onClick={() => navigate('/deliverables')} className="shrink-0 text-blue-500 hover:text-blue-700 hover:underline">前往产出物管理查看 →</button>
                  </div>
                )}
                {/* 元信息 */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-400">
                  <div className="flex items-center gap-1"><Clock className="w-3 h-3"/>创建: {formatTime(task.created_at)}</div>
                  <div className="flex items-center gap-1"><TrendingUp className="w-3 h-3"/>更新: {formatTime(task.updated_at)}</div>
                  {task.depends_on && <div className="flex items-center gap-1 flex-wrap col-span-2"><GitBranch className="w-3 h-3"/>前置依赖: {depIds.map((did) => (
                    <button key={did} type="button" onClick={() => navigate(`/tasks/${did}`)} title={`跳转前置任务：${taskNameOf(did)}`} className="text-blue-500 hover:text-blue-700 hover:underline">{taskNameOf(did)}</button>
                  ))}</div>}
                  {task.parent_task_id && <div className="flex items-center gap-1"><GitBranch className="w-3 h-3"/>父任务: <button type="button" onClick={() => navigate(`/tasks/${task.parent_task_id}`)} title="跳转父任务" className="text-blue-500 hover:text-blue-700 hover:underline">{taskNameOf(task.parent_task_id)}</button></div>}
                  {stepInfo && <div className="flex items-center gap-1 col-span-2 text-blue-500"><AlertTriangle className="w-3 h-3"/>{stepInfo}</div>}
                </div>
                {/* zx_20261023_5 批一（意义即使用）: 派单理由三行——与真派共用同一把尺
                    （`decideCreateDispatch`），界面说什么就是派发器判什么，不另立一套"看着能派"。 */}
                {dispatchView && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]" title="判据与真派同一把尺（collab-dispatch.decideCreateDispatch）">
                    <span className="font-medium text-gray-600">协同派单</span>
                    <span className={`px-1.5 py-0.5 rounded-full font-medium ${dispatchView.eligible ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-600'}`}>
                      {dispatchView.eligible ? '可外派' : dispatchView.label}
                    </span>
                    {dispatchView.lines.map((l) => (
                      <span key={l.key} className="px-1.5 py-0.5 rounded bg-gray-50 text-gray-500">{l.label}：{l.value}</span>
                    ))}
                  </div>
                )}
                {/* 操作按钮 */}
                {/* zx_20261018_3 D7（组2 实机照出）: 固定槽位——「暂停」与「恢复」不再共用同一个坐标。
                    槽2=运行/暂停位：执行中是「暂停」，暂停后**原位**显示禁用的「已暂停」（不是「恢复」）；
                    槽3=中止/恢复位，空槽用等宽占位撑住，后续按钮不左移右移。
                    所有动作在提交期 + 700ms 冷却内统一禁用（`actionLocked`），`beginAction` 另用同步 ref 挡第二击。 */}
                <div className="flex items-center gap-2 mt-3 pt-3 border-t">
                  <ActionSlot>
                    {/* zx_20261013_1 批二(K7): 挂本地文件——件就在手边，路在此接通（与建任务挂件同一条链） */}
                    <button onClick={() => handleAttachFiles(task.id)} disabled={actionLocked} title="挂本地文件：落盘并写进任务上下文，下一次执行/回复即带上" className="w-full flex items-center justify-center gap-1 px-3 py-1 bg-sky-600 text-white rounded text-xs hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"><Paperclip className="w-3 h-3"/>挂附件</button>
                  </ActionSlot>
                  {['pending','executing','running','paused','failed','stabilizing'].includes(task.status) && <>
                  <ActionSlot>
                    {task.status==='pending' && <button onClick={() => handleStatus(task.id,'running')} disabled={actionLocked} title="执行" className="w-full flex items-center justify-center gap-1 px-3 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"><Play className="w-3 h-3"/>执行</button>}
                    {task.status==='paused' && <button disabled title="任务已暂停——「恢复」在右侧独立按钮；同一坐标不再换成反向动作，避免暂停被连点成恢复" className="w-full flex items-center justify-center gap-1 px-3 py-1 bg-orange-500 text-white rounded text-xs opacity-50 cursor-not-allowed whitespace-nowrap"><Pause className="w-3 h-3"/>已暂停</button>}
                    {/* zx_20260930 M11-5: `stabilizing` 的人工出口（与横幅同两个动作，动作栏这处便于滚到底时操作） */}
                    {task.status==='stabilizing' && <button onClick={() => handleStatus(task.id,'pending')} disabled={actionLocked} title="确认并放回队列（等下一轮调度自动拉起）" className="w-full flex items-center justify-center gap-1 px-3 py-1 bg-amber-600 text-white rounded text-xs hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"><Play className="w-3 h-3"/>放回队列</button>}
                    {(task.status==='executing'||task.status==='running') && <button onClick={() => handleStatus(task.id,'paused')} disabled={actionLocked} title="暂停" className="w-full flex items-center justify-center gap-1 px-3 py-1 bg-orange-500 text-white rounded text-xs hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"><Pause className="w-3 h-3"/>暂停</button>}
                  </ActionSlot>
                  <ActionSlot>
                    {(task.status==='executing'||task.status==='running') && <button onClick={() => handleInterrupt(task.id)} disabled={actionLocked} title="中止（立即中断当前执行）" className="w-full flex items-center justify-center gap-1 px-3 py-1 bg-red-500 text-white rounded text-xs hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"><AlertTriangle className="w-3 h-3"/>中止</button>}
                    {(task.status==='paused'||task.status==='failed') && <button onClick={() => handleResume(task.id)} disabled={actionLocked} title="恢复（保留对话继续）" className="w-full flex items-center justify-center gap-1 px-3 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"><RotateCcw className="w-3 h-3"/>恢复</button>}
                    {task.status==='stabilizing' && <button onClick={() => handleStatus(task.id,'paused')} disabled={actionLocked} title="暂停（转人工暂停态，可随时恢复）" className="w-full flex items-center justify-center gap-1 px-3 py-1 bg-orange-500 text-white rounded text-xs hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"><Pause className="w-3 h-3"/>暂停</button>}
                  </ActionSlot>
                  </>}
                  {(task.status==='executing'||task.status==='running'||task.status==='paused'||task.status==='failed') && <ActionSlot>
                    {(task.status==='executing'||task.status==='running') && <button onClick={() => { setInjectText(''); setShowInject(v=>!v); }} disabled={actionLocked} title="追加输入（执行中注入提示，任务带新输入继续）" className="w-full flex items-center justify-center gap-1 px-3 py-1 bg-cyan-600 text-white rounded text-xs hover:bg-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"><MessageSquare className="w-3 h-3"/>追加输入</button>}
                    {(task.status==='paused'||task.status==='failed') && <button onClick={() => { setReplyText(''); setShowReply(true); }} disabled={actionLocked} title="回复（输入内容后恢复任务）" className="w-full flex items-center justify-center gap-1 px-3 py-1 bg-teal-600 text-white rounded text-xs hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"><MessageSquare className="w-3 h-3"/>回复</button>}
                  </ActionSlot>}
                  {task.status==='failed' && <button onClick={() => handleRetry(task.id)} disabled={actionLocked} title="重试（清空对话从零开始）" className="flex items-center gap-1 px-3 py-1 bg-indigo-600 text-white rounded text-xs hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"><RefreshCw className="w-3 h-3"/>重试</button>}
                  {(task.status==='paused'||task.status==='failed') && <button onClick={() => handleStatus(task.id,'completed')} disabled={actionLocked} title="标记完成" className="flex items-center gap-1 px-3 py-1 bg-emerald-600 text-white rounded text-xs hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"><Check className="w-3 h-3"/>完成</button>}
                  {/* zx_20261012_2 批二: 「归档（放弃）」。可弃的态=pending/planning/paused/failed/stabilizing；
                      执行中(executing/running)刻意不给——须先「中止」，弃在途任务等于弃掉一个还在跑的东西，先停再弃。 */}
                  {['pending','planning','paused','failed','stabilizing'].includes(task.status) && <button onClick={() => handleArchive(task.id)} disabled={actionLocked} title="归档（放弃）——弃 ≠ 败：它不再计入失败，也不阻塞父任务收口" className="flex items-center gap-1 px-3 py-1 bg-gray-500 text-white rounded text-xs hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"><Archive className="w-3 h-3"/>归档</button>}
                  {task.status==='completed' && <button onClick={() => handleRetry(task.id)} disabled={actionLocked} title="重新执行" className="flex items-center gap-1 px-3 py-1 bg-purple-600 text-white rounded text-xs hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"><RotateCcw className="w-3 h-3"/>重新执行</button>}
                  {(task.status==='completed'||task.status==='failed') && <button onClick={() => handleDelete(task.id)} disabled={actionLocked} title="删除" className="flex items-center gap-1 px-3 py-1 bg-red-500 text-white rounded text-xs hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed"><Trash2 className="w-3 h-3"/>删除</button>}
                </div>
                {/* Phase C: 执行中追加输入内联框 */}
                {showInject && (task.status==='executing'||task.status==='running') && <div className="flex items-center gap-2 mt-2"><input value={injectText} onChange={e=>setInjectText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){handleInject(task.id);}}} className="flex-1 px-2 py-1 border rounded text-xs" placeholder="输入要注入的提示，回车提交（任务将软中断并带此输入继续）"/><button onClick={()=>handleInject(task.id)} disabled={!injectText.trim()} className="px-2 py-1 bg-cyan-600 text-white rounded text-xs hover:bg-cyan-700 disabled:opacity-50">注入</button></div>}
                {/* zx_20261018_3 D11（组6 实机反馈）: 执行期实时块移到**操作栏下方**——按钮坐标不再受其高度影响。
                    D13（组6 二次实机反馈）: 取消块内限高/滚动，思考与生成内容随页撑开，滚动只有页面这一条。 */}
                {(task.status === 'executing' || task.status === 'running') && (
                <LivePane>
                {/* CoT (2026-09-03): 推理模型思考过程逐字上屏（紫色独立块，思考阶段可见） */}
                {streamingReasoning && (task.status === 'executing' || task.status === 'running') && <div className="p-2 mb-3 bg-indigo-50 border border-indigo-200 rounded-lg space-y-1"><div className="flex items-center gap-2 flex-wrap"><span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"/><span className="text-sm text-indigo-700 font-medium">🧠 AI 思考中…</span>{thinkingSince > 0 && <span className="text-xs text-indigo-400">{thinkingSec}s</span>}<button onClick={() => setShowThinking(!showThinking)} className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-500 hover:bg-indigo-200" title="折叠/展开思考过程">{showThinking ? '收起' : '展开'}</button></div>{showThinking && <StreamPane title={streamingReasoning} className="text-xs text-indigo-700 whitespace-pre-wrap break-words font-mono">{streamingReasoning}</StreamPane>}</div>}
                {/* D3 (2026-09-03 核实修复): 首个 step_finished 到达前 liveStatus 为空，此时独立渲染流式横幅，避免第 1 步 token 流式不可见 */}
                {streamingText && !liveStatus && (task.status === 'executing' || task.status === 'running') && <div className="p-2 mb-3 bg-blue-50 border border-blue-200 rounded-lg space-y-1"><div className="flex items-center gap-2 flex-wrap"><span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"/><span className="text-sm text-blue-800 font-medium">AI 正在生成…</span></div><StreamPane title={streamingText} className="text-xs text-blue-700 whitespace-pre-wrap break-words font-mono"><span className="text-blue-400">⏵ </span>{streamingText}</StreamPane></div>}
                {/* Phase A: 执行中实时状态条（过程可见，非模态不打断） */}
                {liveStatus && (task.status === 'executing' || task.status === 'running') && <div className="p-2 mb-3 bg-blue-50 border border-blue-200 rounded-lg space-y-1"><div className="flex items-center gap-2 flex-wrap"><span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"/><span className="text-sm text-blue-800 font-medium">执行中 · 第 {String(liveStatus.step)} 步</span>{thinkingSince > 0 && <span className="text-xs text-blue-500 animate-pulse font-medium" title="最近步骤已完成，AI 正在生成下一步">🤖 AI 思考中… {thinkingSec}s</span>}{taskEstimate?.steps ? <span className="text-xs text-cyan-600">/ 预估 {taskEstimate.steps} 步{taskEstimate.steps > 0 ? `（${Math.min(100, Math.round((Number(liveStatus.step) / taskEstimate.steps) * 100))}%）` : ''}</span> : null}{taskEstimate?.steps && Number(liveStatus.step) < taskEstimate.steps ? <span className="text-xs text-cyan-500">预计剩余约 {taskEstimate.steps - Number(liveStatus.step)} 步</span> : null}{liveStatus.totalTokens != null && <span className="text-xs text-blue-600">{formatToken(liveStatus.totalTokens as number)} tokens</span>}{liveStatus.token_delta != null && <span className="text-xs text-blue-500" title="本步 token 增量"> · 本步 +{formatToken(Number(liveStatus.token_delta))}</span>}{liveStatus.totalTokens != null && liveWaterPct != null && <span className={`text-xs ${liveWaterPct >= 85 ? 'text-red-500 font-medium' : 'text-amber-600'}`} title="上下文占用近似估算(T2预算水位，随步骤实时刷新)"> · 上下文~{liveWaterPct}%</span>}{liveBias != null && taskEstimate?.tokens ? <span className={`text-xs ${liveBias >= 50 ? 'text-red-500 font-medium' : 'text-purple-600'}`} title="实际 vs 预估 token 偏差">{liveBias > 0 ? `超预估 +${liveBias}%` : `低于预估 ${liveBias}%`}</span> : null}</div>{taskEstimate?.steps ? <div className="h-1.5 bg-blue-100 rounded-full overflow-hidden"><div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${Math.min(100, (Number(liveStatus.step) / taskEstimate.steps) * 100)}%` }} /></div> : null}{liveStatus.toolCalls ? <p className="text-xs text-blue-500" title={String(liveStatus.toolCalls)}>正在调用工具: {liveToolNames.length > 0 ? liveToolNames.join('、') : String(liveStatus.toolCalls)}</p> : null}{streamingText ? <StreamPane title={streamingText} className="text-xs text-blue-700 whitespace-pre-wrap break-words font-mono"><span className="text-blue-400">⏵ </span>{streamingText}</StreamPane> : liveStatus.text ? <p className="text-xs text-blue-700" title={String(liveStatus.text)}>{String(liveStatus.text).slice(0, 200)}</p> : null}</div>}
                {/* zx_20260906 批4 (4b): 长单步执行中心跳脉冲（task.heartbeat 消费）——界面持续"呼吸"，不显伪冻结 */}
                {hbFresh && heartbeat && (
                  <div className="p-2 mb-3 bg-cyan-50 border border-cyan-200 rounded-lg flex items-center gap-2">
                    <span className="relative flex h-2 w-2 shrink-0"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" /><span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500" /></span>
                    <span className="text-xs text-cyan-800">AI 正在执行长步骤（任务仍在推进）{heartbeat.elapsedSec >= 60 ? `· 已运行 ${Math.floor(heartbeat.elapsedSec / 60)}m${heartbeat.elapsedSec % 60}s` : `· 已运行 ${heartbeat.elapsedSec}s`}{heartbeat.tokens > 0 ? ` · ${formatToken(heartbeat.tokens)} tokens` : ''}</span>
                  </div>
                )}
                {!streamingReasoning && !streamingText && !liveStatus && !hbFresh && <p className="text-xs text-gray-400">等待执行输出…</p>}
                </LivePane>
                )}
              </div>

              {/* Phase C (2026-08-28 zx_2): 交付报告（慎终如始——完成态总览：目标达成/产出物/复盘/待关注） */}
              {task.status === 'completed' && (
                <div className="bg-white rounded-lg border border-emerald-200 p-4">
                  <h4 className="font-medium mb-3 text-sm flex items-center gap-1"><Check className="w-4 h-4 text-emerald-600"/>交付报告</h4>
                  {goalInfo?.goal && <p className="text-sm text-gray-700 mb-2"><span className="text-xs text-gray-400">目标达成：</span>{goalInfo.goal}</p>}
                  <div className="grid grid-cols-4 gap-3 text-center">
                    <div className="bg-emerald-50 rounded-lg p-2">
                      <p className={`text-lg font-bold ${(completionQuality?.score ?? 0)>=60?'text-emerald-700':'text-orange-600'}`}>{completionQuality?.score ?? '-'}</p>
                      <p className="text-[10px] text-emerald-600">完成质量分</p>
                    </div>
                    <div className="bg-purple-50 rounded-lg p-2">
                      <p className="text-lg font-bold text-purple-700">{delivTotal}</p>
                      <p className="text-[10px] text-purple-600" title="本任务及子任务产出（task:get 子树聚合）">本任务（含子任务）{outputValidations ? ` · ${outputValidations.filter(v=>v.sufficient).length}/${outputValidations.length}通过` : ''}</p>
                    </div>
                    <div className="bg-indigo-50 rounded-lg p-2">
                      <p className="text-lg font-bold text-indigo-700">{retrospective.length}</p>
                      <p className="text-[10px] text-indigo-600">复盘教训</p>
                    </div>
                    <div className="bg-amber-50 rounded-lg p-2">
                      <p className="text-lg font-bold text-amber-700">{finalizeChecks ? finalizeChecks.filter(c=>c.startsWith('[WARN]')||c.startsWith('[FAIL]')).length : 0}</p>
                      <p className="text-[10px] text-amber-600">待关注项</p>
                    </div>
                  </div>
                </div>
              )}

              {/* zx_20261016_3 M33-b: 子任务「目的」（四因·目的因）——拆解时写给"它服务于父目标的哪一点" */}
              {childPurpose && (
                <div className="bg-white rounded-lg border p-4">
                  <h4 className="font-medium mb-2 text-sm flex items-center gap-1"><Target className="w-4 h-4 text-emerald-500"/>子任务目的<span className="text-xs text-gray-400 font-normal">（四因·目的因）</span></h4>
                  <p className="text-sm text-gray-700">{childPurpose}</p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    {childFourCauses.map((c) => (
                      <span key={c.cause} title={c.basis}
                        className={`text-xs ${c.state === 'missing' ? 'text-amber-600' : 'text-gray-500'}`}>
                        {c.label.split('（')[0]}：{c.state === 'carried' ? '已在条目' : c.state === 'runtime' ? '运行期承担' : '缺'}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Phase A (2026-08-28 zx_1): 任务目标显性化（核心目标/成功标准/待调查项/主要矛盾） */}
              {goalInfo && (goalInfo.goal || goalInfo.principalContradiction) && (
                <div className="bg-white rounded-lg border p-4">
                  <h4 className="font-medium mb-2 text-sm flex items-center gap-1"><Target className="w-4 h-4 text-emerald-500"/>任务目标<button onClick={() => { setGoalEditText(goalInfo?.goal || ''); setShowGoalEdit(v => !v); }} className="ml-auto text-xs text-blue-500 hover:text-blue-700" title="纠正目标（回写 context_json.task_goal，重启/恢复后生效）"><Edit className="w-3.5 h-3.5 inline"/> 纠正</button></h4>
                  {goalInfo.goal && <p className="text-sm text-gray-700 mb-1"><span className="text-xs text-gray-400">核心目标：</span>{goalInfo.goal}</p>}
                  {goalInfo.success_criteria && <p className="text-sm text-gray-700 mb-1"><span className="text-xs text-gray-400">成功标准：</span>{goalInfo.success_criteria}</p>}
                  {goalInfo.principalContradiction && <p className="text-sm text-gray-700 mb-1"><span className="text-xs text-gray-400">主要矛盾：</span>{goalInfo.principalContradiction}</p>}
                  {goalInfo.investigate.length > 0 && (
                    <div className="text-sm text-gray-700">
                      <span className="text-xs text-gray-400">执行前先调查：</span>
                      <ul className="list-disc list-inside mt-0.5 space-y-0.5">
                        {goalInfo.investigate.map((item, i) => <li key={i} className="text-xs text-gray-600">{item}</li>)}
                      </ul>
                    </div>
                  )}
                  {showGoalEdit && (
                    <div className="flex items-center gap-2 mt-2">
                      <input value={goalEditText} onChange={e => setGoalEditText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleSaveGoal(task.id); }} className="flex-1 px-2 py-1 border rounded text-xs" placeholder="输入纠正后的核心目标，回车保存"/>
                      <button onClick={() => handleSaveGoal(task.id)} disabled={!goalEditText.trim()} className="px-2 py-1 bg-emerald-600 text-white rounded text-xs hover:bg-emerald-700 disabled:opacity-50">保存</button>
                    </div>
                  )}
                </div>
              )}

              {/* Phase B (2026-08-28 zx_1): 执行健康度（目标偏离/失败风险/复杂度升级/早停实时信号） */}
              {signalStream.length>0 && (
                <div className="bg-white rounded-lg border p-4">
                  <h4 className="font-medium mb-2 text-sm flex items-center gap-1"><AlertTriangle className="w-4 h-4 text-orange-500"/>执行健康度 ({signalStream.length})</h4>
                  <div className="space-y-1.5 max-h-60 overflow-y-auto">
                    {signalStream.map((s,i) => {
                      const isDeviation = s.type === 'task.goal_deviation';
                      const sigType = String(s.signalType || '');
                      const level = String(s.level || '');
                      const label = isDeviation ? '目标偏离' : sigType === 'risk' ? (level === 'high' ? '失败风险' : '风险提示') : sigType === 'complexity' ? '复杂度升级' : sigType === 'sufficiency' ? '早停提示' : sigType;
                      const colorCls = isDeviation || level === 'high' ? 'border-red-300 bg-red-50 text-red-700' : level === 'medium' ? 'border-orange-300 bg-orange-50 text-orange-700' : 'border-gray-200 bg-gray-50 text-gray-700';
                      const msg = String(s.message || s.reason || '');
                      return (
                        <div key={i} className={`border-l-2 pl-3 py-1 ${colorCls}`}>
                          <div className="flex items-center gap-2 text-xs">
                            <span className="font-medium shrink-0">{label}</span>
                            {msg && <span className="truncate flex-1" title={msg}>{msg.slice(0, 160)}</span>}
                            {isDeviation && (task.status === 'executing' || task.status === 'running') && <button onClick={() => handleInjectDirect(task.id, `请回正聚焦核心目标：${goalInfo?.goal || ''}。偏离原因：${msg}，请立即纠正方向。`)} className="shrink-0 px-2 py-0.5 bg-red-600 text-white rounded text-[10px] hover:bg-red-700" title="软中断当前执行并注入回正指令">一键回正</button>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Phase A (2026-08-28 zx_2): 产出物验证结果透出（交付质量可见） */}
              {outputValidations && outputValidations.length>0 && (
                <div className="bg-white rounded-lg border p-4">
                  <h4 className="font-medium mb-2 text-sm flex items-center gap-1"><Check className="w-4 h-4 text-emerald-500"/>产出物验证 ({outputValidations.length})</h4>
                  <div className="space-y-1.5">
                    {outputValidations.map((v,i) => (
                      <div key={i} className={`border-l-2 pl-3 py-1 ${v.sufficient ? 'border-emerald-200 bg-emerald-50/50' : 'border-red-200 bg-red-50/50'}`}>
                        <div className="flex items-center gap-2 text-xs flex-wrap">
                          <span className={`shrink-0 ${v.sufficient ? 'text-emerald-600' : 'text-red-600'}`}>{v.sufficient ? '✓ 充分' : '✗ 不充分'}</span>
                          <span className="font-mono text-gray-500 truncate flex-1" title={v.file}>{v.file}</span>
                          {v.confidence != null && <span className="text-gray-400 shrink-0">置信 {Math.round(v.confidence*100)}%</span>}
                        </div>
                        {v.missingAspects && v.missingAspects.length>0 && <p className="text-xs text-orange-600 mt-0.5">缺失: {v.missingAspects.join('、')}</p>}
                        {v.suggestion && <p className="text-xs text-gray-500 mt-0.5">建议: {v.suggestion}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* zx_20260906_2 批2 (2026-09-06): 验收标准逐条核对——finalize 验收证据可复盘(通过项/拒收项逐条+理由，非只一句 PASS) */}
              {/* zx_20260910_3 M1(名实相符): 未核验的载荷同样有 checked_at，必须显式展示"未核验+原因"而非空白
                  (此前恒空=无法区分"没跑到"与"没标准"，正是本轮 G1 的病象) */}
              {acceptanceCheck && ((acceptanceCheck.criteria_total ?? 0) > 0 || acceptanceCheck.verified === false) && (
                <div className="bg-white rounded-lg border p-4">
                  <h4 className="font-medium mb-2 text-sm flex items-center gap-1"><Target className="w-4 h-4 text-blue-500"/>验收标准核对 {acceptanceCheck.verified === false
                    ? <span className="text-xs text-amber-600 font-normal">{acceptanceCheck.reason === 'no_criteria' ? '(未设验收标准 · 未验收)'
                      : acceptanceCheck.reason === 'no_user_criteria' ? `(引擎代拟 ${(acceptanceCheck.proposed ?? []).length} 条 · 未验收)`
                      // zx_20260920_1 M3（面二）: 此前这里是一句**不查词表的硬话术**（"未核验 · 尝试于 X"）——
                      //   新增成因码（`output_insufficient`：产出内容不充分、本 run **从未进入验收判定**）在任务
                      //   详情页就看不见，只见到一句含糊的"未核验"。本仓既有纪律：**renderer 是词表的第二个落点**。
                      //   成因**点名**（查同一份 `ACCEPTANCE_REASON_LABEL`），落款仍带"尝试于"（它是尝试时刻，不是结论时刻）。
                      : `(${ACCEPTANCE_REASON_LABEL[acceptanceCheck.reason ?? ''] ?? '未核验'}${acceptanceCheck.checked_at ? ` · 尝试于 ${formatTime(acceptanceCheck.checked_at)}` : ''})`}</span>
                    : <span className="text-xs text-gray-400 font-normal">({(acceptanceCheck.passed ?? []).length} 通过 · {(acceptanceCheck.failed ?? []).length} 未达{acceptanceCheck.checked_at ? ` · ${formatTime(acceptanceCheck.checked_at)}` : ''})</span>}</h4>
                  {acceptanceCheck.verified === false ? (
                    // zx_20260915 P0-2(d): 三态之一「无标准」单列——它不是"核对失败"（重跑也不会变），
                    // 给出的话术也必须不同：该补的是标准，不是重跑。另三种成因仍走下面那句。
                    acceptanceCheck.reason === 'no_criteria' ? (
                      <div className="border-l-2 border-amber-200 bg-amber-50/50 pl-3 py-2 text-xs text-amber-800">
                        <p className="font-medium">未设验收标准（未验收）</p>
                        <p className="mt-0.5 text-amber-700">该任务创建时未填验收标准，无从核对——「已完成」不等于「已验收」。如需可核对的结论，请补填验收标准后重跑该任务。</p>
                      </div>
                    ) : acceptanceCheck.reason === 'no_user_criteria' ? (
                      // zx_20260916 M1（维特根斯坦·家族相似 / 道德经·七十一章「知不知，上」）:
                      // 「无人许诺」分两种——上面那支是"也没人代拟"，本支是"引擎代拟并逐条自核"。
                      // **代拟 ≠ 许诺**：故不打 ✓、不计入"已验收"，只把代拟项与自核结论**摊开给人看**。
                      <div className="border-l-2 border-sky-200 bg-sky-50/50 pl-3 py-2 text-xs text-sky-900">
                        <p className="font-medium">引擎代拟 {(acceptanceCheck.proposed ?? []).length} 条判据（未验收）</p>
                        <p className="mt-0.5 text-sky-700">该任务无人许诺验收判据，引擎按任务自身内容代拟了以下可核对项并逐条自核。<b>代拟不等同于验收</b>——「已完成」仍不等于「已验收」。</p>
                        <ul className="mt-1.5 space-y-1">
                          {(acceptanceCheck.proposed_checked ?? []).map((c, i) => (
                            <li key={i} className="flex items-start gap-1.5">
                              <span className={c.passed ? 'text-green-600' : 'text-amber-600'}>{c.passed ? '✓' : '✗'}</span>
                              <span>
                                <span>{c.criterion}</span>
                                <span className="text-sky-600">（依据：{c.basis}）</span>
                                {c.note && <span className="text-amber-700"> {c.note}</span>}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : isUnjudgedReason(acceptanceCheck.reason) ? (
                      // zx_20260923_1 M2（渲染层是词表的第二个落点）：**「有题未判成」**——
                      //   题目在（任务上写了验收标准），本轮却没取得核对结论。判据在 `UNJUDGED_REASONS`
                      //   一处真源（不在此手抄三码清单）。此前这句写死"不阻断收口"——M2 之后它**会**阻断，
                      //   原话即名实不符（真库标本 `a290ae2b` 走的正是这一支）。
                      <div className="border-l-2 border-amber-300 bg-amber-50/50 pl-3 py-2 text-xs text-amber-900">
                        <p className="font-medium">本次未取得核对结论（{ACCEPTANCE_REASON_LABEL[acceptanceCheck.reason ?? ''] ?? acceptanceCheck.reason ?? '原因未知'}）</p>
                        <p className="mt-0.5 text-amber-800"><b>未核验不等于通过</b>——本任务有验收判据却没判成，故<b>未标完成</b>，已暂停待人工。请核验产出后"恢复继续"（模型恢复即会重新判卷）或"标记完成"。</p>
                      </div>
                    ) : (
                    <div className="border-l-2 border-amber-200 bg-amber-50/50 pl-3 py-2 text-xs text-amber-800">
                      <p className="font-medium">本次未取得核对结论（{ACCEPTANCE_REASON_LABEL[acceptanceCheck.reason ?? ''] ?? acceptanceCheck.reason ?? '原因未知'}）</p>
                      <p className="mt-0.5 text-amber-700">已如实记账，不阻断收口——如需逐条核对结论请重跑该任务（或检查模型可用性）。</p>
                    </div>
                    )
                  ) : (
                    <div className="space-y-1.5">
                      {(acceptanceCheck.passed ?? []).map((c, i) => (
                        <div key={`ap${i}`} className="border-l-2 border-emerald-200 bg-emerald-50/50 pl-3 py-1 text-xs text-gray-700">
                          <span className="text-emerald-600 mr-1.5">✓ 已达成</span>{c}
                        </div>
                      ))}
                      {(acceptanceCheck.failed ?? []).map((f, i) => (
                        <div key={`af${i}`} className="border-l-2 border-red-200 bg-red-50/50 pl-3 py-1">
                          <p className="text-xs text-red-700"><span className="font-medium">✗ {f.criterion}</span></p>
                          {f.reason && <p className="text-xs text-gray-500 mt-0.5">原因：{f.reason}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* E2 (2026-09-04_2): 扬弃小结——完成/失败任务的执行总判断（复盘顶部） */}
              {digest && (
                <div className="bg-white rounded-lg border p-4">
                  <h4 className="font-medium mb-1.5 text-sm text-gray-700">本次扬弃小结</h4>
                  <p className="text-xs text-gray-700">{digestLineText({ status: digest.status, steps: digest.steps, deviations: digest.deviations, signals: digest.signals, memoryInjections: digest.memoryInjections, quality: digest.quality })}</p>
                  <p className="text-[10px] text-gray-400 mt-1">事实来源：wa_event_log 事件聚合（偏离/信号/记忆注入/步数），非展示臆造</p>
                </div>
              )}

              {/* Phase B (2026-08-28 zx_2): 任务复盘透出（实践论再认识——教训可行动） */}
              {/* B1 (2026-09-03): 结构化复盘分节渲染（delta/lesson/action），旧数据回退 content */}
              {retrospective.length>0 && (
                <div className="bg-white rounded-lg border p-4">
                  <h4 className="font-medium mb-2 text-sm flex items-center gap-1"><History className="w-4 h-4 text-indigo-500"/>任务复盘</h4>
                  <div className="space-y-1.5">
                    {retrospective.map((r,i) => {
                      const st = r.structured;
                      const items: Array<{ label: string; value: string }> = st
                        ? [
                            { label: '计划/目标', value: st.plan || '' },
                            { label: '偏差', value: st.delta || '' },
                            { label: '教训', value: st.lesson || '' },
                            { label: '后续行动', value: st.action || '' },
                          ].filter(x => x.value)
                        : String(r.content || '').split(' | ').map((s) => {
                            const idx = s.indexOf('：');
                            return idx > 0 ? { label: s.slice(0, idx).replace(/^\[复盘\]\s*/, ''), value: s.slice(idx + 1) } : null;
                          }).filter((x): x is { label: string; value: string } => !!x);
                      return (
                        <div key={i} className="border-l-2 border-indigo-200 pl-3 py-1 space-y-1">
                          {items.map((it, j) => (
                            <p key={j} className="text-xs text-gray-700">
                              <span className="text-indigo-600 font-medium mr-1.5">{it.label}</span>{it.value}
                            </p>
                          ))}
                          <p className="text-[10px] text-gray-400">{formatTime(r.created_at)}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* B1 (2026-09-03_1): 方案里程碑（规划↔实施追踪） */}
              {planMilestones.length>0 && (
                <div className="bg-white rounded-lg border p-4">
                  <h4 className="font-medium mb-2 text-sm flex items-center gap-1">📋 方案里程碑</h4>
                  <div className="space-y-1">
                    {planMilestones.map((x,i)=>(
                      <div key={i} className="flex items-center gap-2 text-xs py-1 px-2 rounded bg-gray-50">
                        <span className="font-mono font-semibold text-gray-700 w-10">{x.milestone}</span>
                        <span className={`px-1.5 py-0.5 rounded-full shrink-0 ${x.status==='done'?'bg-green-100 text-green-700':x.status==='doing'?'bg-blue-100 text-blue-700':'bg-gray-200 text-gray-500'}`}>{x.status==='done'?'已落地':x.status==='doing'?'进行中':'待实施'}</span>
                        {x.implemented_by_task_id ? (
                          <button type="button" onClick={()=>navigate(`/tasks/${String(x.implemented_by_task_id)}`)} className="shrink-0 text-blue-600 hover:underline truncate max-w-[40%]" title={x.implemented_title||''}>落地: {x.implemented_title || String(x.implemented_by_task_id).slice(0,8)}</button>
                        ) : x.status!=='done' ? (
                          <span className="flex gap-1 ml-auto shrink-0">
                            {x.status!=='doing' && <button type="button" onClick={()=>setMilestone(x.milestone,'doing')} className="text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded hover:bg-blue-200">开始</button>}
                            <button type="button" onClick={()=>setMilestone(x.milestone,'done')} className="text-[10px] px-1.5 py-0.5 bg-green-100 text-green-700 rounded hover:bg-green-200">完成</button>
                          </span>
                        ) : <button type="button" onClick={()=>setMilestone(x.milestone,'pending')} className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded hover:bg-gray-200 ml-auto shrink-0">重开</button>}
                        {/* zx_20260909 续跑: 手动"选落地任务"(同项目任意任务, 不限于子任务) → 置 done+绑定 → 交付单如实出现"已落地里程碑" */}
                        <select value={x.implemented_by_task_id || ''} onChange={(e) => { if (e.target.value) bindLanding(x.milestone, e.target.value); }}
                          className="text-[10px] border rounded px-1 py-0.5 bg-white text-gray-500 max-w-[150px] shrink-0"
                          title="落地任务(同项目任意任务; 选择即把该里程碑置为已完成并绑定到此任务)">
                          <option value="">落地任务…</option>
                          {projTasks.map((lt) => <option key={lt.id} value={lt.id}>{lt.title}（{lt.status === 'completed' ? '✓' : statusText(TASK_STATUS_LABEL, lt.status)}）</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* zx_20260909 续跑(规划→独立实施): 实施任务「关联方案」——收口/动工按 scheme_ref.plan_task_id+标题 M 自动落地对应方案里程碑 */}
              {task && planMilestones.length === 0 && (
                <div className="bg-white rounded-lg border p-4">
                  <h4 className="font-medium mb-1 text-sm flex items-center gap-1">🔗 关联方案(规划)</h4>
                  <p className="text-[11px] text-gray-400 mb-2">用于「先规划成案、再独立实施落地」：关联后，本任务或其 M 子任务收口会自动把对应方案里程碑置 done 并落地到该子任务；也可到该方案(规划任务)的方案里程碑面板手动选落地任务。</p>
                  <div className="flex items-center gap-2 text-xs flex-wrap">
                    <span className="text-gray-600 shrink-0">当前：{(() => { try { const c = JSON.parse(task.context_json || '{}'); const sid = c.scheme_ref?.plan_task_id; return sid ? (projPlans.find((p) => p.id === sid)?.title || String(sid).slice(0, 8)) : '未关联'; } catch { return '未关联'; } })()}</span>
                    <select value="" onChange={(e) => { if (e.target.value) linkPlan(e.target.value); }} className="text-xs border rounded px-1 py-0.5">
                      <option value="">选择方案任务…</option>
                      {projPlans.map((pl) => <option key={pl.id} value={pl.id}>{pl.title}（{statusText(TASK_STATUS_LABEL, pl.status)}）</option>)}
                    </select>
                    {(() => { try { const c = JSON.parse(task.context_json || '{}'); return !!c.scheme_ref?.plan_task_id; } catch { return false; } })() && (
                      <button type="button" onClick={() => linkPlan(null)} className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded hover:bg-gray-200">解除关联</button>
                    )}
                  </div>
                </div>
              )}

              {/* C2 (2026-09-04): 子任务族验收（全子状态/质量/token/结论） */}
              {familyChildren.length>0 && (
                <div className="bg-white rounded-lg border p-4">
                  {/* B2 (2026-09-04_2): 子任务推进中实时带（父页不静默） */}
                  {childProg && (
                    <div className="mb-2 flex items-center gap-2 text-xs bg-indigo-50 border border-indigo-100 rounded px-2 py-1.5 text-indigo-700">
                      <span className="relative flex h-2 w-2 shrink-0"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" /><span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500" /></span>
                      <span className="truncate min-w-0">子任务推进中：{childProg.title}{childProg.step ? ` · 第 ${childProg.step} 步` : ''}{childProg.text ? ` · ${childProg.text}` : ''}</span>
                    </div>
                  )}
                  <h4 className="font-medium mb-2 text-sm">📋 子任务族验收（{familyChildren.length}）</h4>
                  <div className="space-y-1">
                    {familyChildren.map((c,i)=>{
                      const pend = c.status==='paused'||c.status==='failed';
                      const score = typeof c.score==='number'?c.score:null;
                      const low = c.status==='completed' && score!=null && score<60;
                      return (
                        <Fragment key={c.id}>
                        <div className={`flex items-center gap-2 text-xs py-1 px-2 rounded ${pend?'bg-amber-50':low?'bg-red-50':'bg-gray-50'}`}>
                          <span className="flex-1 min-w-0 truncate text-gray-700" title={c.title}>{c.title}</span>
                          {/* zx_20261011_4 M4: 已外派子任务的外派徽标（人话取 node-view 一处真源；点开下钻远端摘要） */}
                          {c.remote && (
                            <button type="button" onClick={()=>setOpenRemote(openRemote===c.id?null:c.id)}
                              title={c.remote.summary || '查看远端回传'}
                              className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 hover:bg-indigo-200">
                              {orchestrationLabel(c.remote, c.status, remoteNameOf)}
                            </button>
                          )}
                          {/* Q1 修(zx_20260909): 子任务族验收卡状态须如实映射(TASK_STATUS_LABEL)，不得把 pending/executing 兜底成"已完成" */}
                          {/* zx_20261012_2 批二: 状态**如实映射**——`failed` 与 `archived` 不再混成"已失败/放弃"
                              （弃 ≠ 败；`TASK_STATUS_LABEL` 已各自有词：失败 / 已归档） */}
                          <span className="text-gray-400 shrink-0">{statusText(TASK_STATUS_LABEL, c.status)}</span>
                          {score!=null && <span className={`shrink-0 font-medium ${score>=60?'text-green-600':'text-red-600'}`}>{score}分</span>}
                          {typeof c.tokens==='number' && c.tokens>0 && <span className="shrink-0 text-gray-400">{c.tokens>=1000?(c.tokens/1000).toFixed(0)+'K':String(c.tokens)}t</span>}
                          {pend && <>
                            <button type="button" onClick={()=>childResume(c.id)} className="text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded hover:bg-blue-200 shrink-0">恢复</button>
                            <button type="button" onClick={()=>childStatus(c.id,'completed')} className="text-[10px] px-1.5 py-0.5 bg-green-100 text-green-700 rounded hover:bg-green-200 shrink-0">标记完成</button>
                            {/* zx_20261012_2 批二: 子任务族卡的「放弃」改走**归档**态（此前标成 `failed` ⇒
                                被 `failedChildren` 当成失败子挡住父收口——用户明明已处置过它） */}
                            <button type="button" onClick={()=>void childArchive(c.id)} className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded hover:bg-gray-200 shrink-0">放弃</button>
                          </>}
                          <button type="button" title="打开子任务" onClick={()=>navigate(`/tasks/${c.id}`)} className="shrink-0 text-gray-400 hover:text-blue-600">↗</button>
                        </div>
                        {/* zx_20261011_4 M4: 远端回传摘要下钻——如实标注 N5 边界（远端自报 ≠ 本机复核） */}
                        {c.remote && openRemote===c.id && (
                          <div className="text-[11px] text-gray-500 bg-indigo-50/60 border border-indigo-100 rounded px-2 py-1 ml-2 mb-1">
                            <span className="text-indigo-700">{REMOTE_RESULT_CAVEAT}</span>
                            {c.remote.summary
                              ? <span> · 远端摘要：{c.remote.summary}</span>
                              : <span> · 远端尚未回传摘要</span>}
                            {c.remote.resultAt && <span className="ml-1 text-gray-400">（回传于 {c.remote.resultAt}）</span>}
                          </div>
                        )}
                        </Fragment>
                      );
                    })}
                  </div>
                  {familyDigest && (
                    <p className="text-[11px] text-indigo-600 mt-2">族扬弃小结：{digestLineText({ status: familyDigest.failed > 0 ? 'failed' : 'completed', steps: familyDigest.steps, deviations: familyDigest.deviations, signals: familyDigest.signals, memoryInjections: familyDigest.memoryInjections, failed: familyDigest.failed })}{familyDigest.lowQuality > 0 ? `（含低质 <60 子项 ${familyDigest.lowQuality}）` : ''}</p>
                  )}
                  {familyChildren.every(c=>['completed','failed'].includes(c.status)) ? (
                    <p className={`text-xs mt-2 ${familyChildren.some(c=>c.status==='failed'||(c.status==='completed'&&typeof c.score==='number'&&c.score<60))?'text-orange-600':'text-green-600'}`}>
                      {familyChildren.some(c=>c.status==='failed')||familyChildren.some(c=>c.status==='completed'&&typeof c.score==='number'&&c.score<60)?'族验收：存在失败或低质(<60)子项，建议处理后再收口':'族验收：全部子项已终态（待人工/回归确认达标）'}
                    </p>
                  ) : (
                    <p className="text-xs text-amber-600 mt-2">仍有子任务未完成，父任务不应 finalize（B2 门已拦截）。</p>
                  )}
                  {familyChildren.every(c=>c.status==='completed') && !familyChildren.some(c=> typeof c.score==='number' && c.score<60) && (
                    <button type="button" onClick={syncFamilyMilestones} className="mt-2 text-[11px] px-2 py-1 bg-teal-600 text-white rounded hover:bg-teal-700">族验收通过 → 同步方案里程碑(done)</button>
                  )}
                </div>
              )}

              {/* Phase A: 实时执行流（D2: 逐步展示耗时/token增量/工具成败） */}
              {stepStream.length>0 && <div className="bg-white rounded-lg border p-4"><h4 className="font-medium mb-2 text-sm flex items-center gap-1"><Activity className="w-4 h-4 text-blue-500"/>实时执行流 ({stepStream.length})</h4><div ref={stepStreamRef} className="space-y-2 max-h-80 overflow-y-auto">{stepStream.map((s,i)=>(<div key={i} className="border-l-2 border-blue-200 pl-3 py-1"><div className="flex items-center gap-2 text-xs text-gray-400 mb-1 flex-wrap"><span className="font-medium text-blue-600">第 {String(s.step)} 步</span>{s.duration_ms != null && <span className="shrink-0" title="本步骤耗时">⏱ {formatDuration(Number(s.duration_ms))}</span>}{s.toolCalls ? <span className="truncate flex-1 min-w-0" title={String(s.toolCalls)}>{String(s.toolCalls).slice(0, 80)}</span> : null}{s.toolCalls ? <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${s.toolOk ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`} title={s.toolOk ? '工具调用成功' : '工具调用出现错误'}>{s.toolOk ? '✓ 工具成功' : '✗ 工具出错'}</span> : null}{s.token_delta != null ? <span className="shrink-0" title="本步骤 token 增量">+{formatToken(s.token_delta as number)} tokens</span> : (s.tokens != null && <span className="shrink-0">{formatToken(s.tokens as number)} tokens</span>)}</div>{s.text ? <p className="text-xs text-gray-700 whitespace-pre-wrap" style={{display:'-webkit-box',WebkitLineClamp:4,WebkitBoxOrient:'vertical',overflow:'hidden'}}>{String(s.text).slice(0, 500)}</p> : null}</div>))}</div></div>}

              {/* C1 (2026-08-31): 工具调用时间线（人类记忆情节记忆——执行过程的时间序列，独立展示工具调用） */}
              {stepStream.length>0 && <div className="bg-white rounded-lg border p-4"><h4 className="font-medium mb-2 text-sm flex items-center gap-1"><Clock className="w-4 h-4 text-cyan-500"/>工具时间线</h4><div className="space-y-1 max-h-60 overflow-y-auto">{stepStream.filter(s => s.toolCalls).map((s,i)=>(<div key={i} className="flex items-start gap-2 text-xs py-1 border-b border-gray-50 last:border-0"><span className="shrink-0 text-cyan-600 font-mono">第{String(s.step)}步</span><span className="text-gray-600 truncate" title={String(s.toolCalls)}>{String(s.toolCalls)}</span></div>))}</div></div>}

              {/* Phase B: 记忆注入可视化（任务识别依据透出，可纠偏）
                  zx_20260924 §2c UI-1: **本块已上移**至「本次附件」之上、「产出物」之前，并改为默认折叠
                  （见 `memBlock`）。此处不再就地渲染——同一块只保留**一个**落点。 */}

              {/* 实时文件变更（Phase 1） */}
              {fileStream.length>0 && <div className="bg-white rounded-lg border p-4"><h4 className="font-medium mb-2 text-sm flex items-center gap-1"><FileText className="w-4 h-4 text-blue-500"/>实时文件变更 ({fileStream.length})</h4><div className="space-y-2 max-h-80 overflow-y-auto">{fileStream.map((f,i)=>(<FileChangeItem key={i} f={f}/>))}</div></div>}

              {/* 任务预算 + 上下文 */}
              <div className="bg-white rounded-lg border p-4">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-medium text-sm flex items-center gap-1"><TrendingUp className="w-4 h-4 text-orange-500"/>任务预算</h4>
                  <button onClick={() => { if (showContext) { setShowContext(false); } else { setShowContext(true); } }} className="text-xs text-blue-500 hover:text-blue-700"><Edit className="w-3.5 h-3.5 inline"/> 编辑</button>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="bg-gray-50 rounded p-2">
                    <p className="text-xs text-gray-400">消耗 / 预算 (tokens){executingNow ? ' · 实时' : ''}</p>
                    <div className="flex items-baseline gap-1 mt-1">
                      <span className="text-lg font-bold text-blue-600">{formatToken(displayTokens)}</span>
                      <span className="text-xs text-gray-400">/ {effectiveBudget ? formatToken(effectiveBudget) : (ctxForm.max_tokens_per_task ? formatToken(Number(ctxForm.max_tokens_per_task)) : '未设置')}</span>
                    </div>
                    {effBudgetTok > 0 && (
                      <div>
                        {/* E1 (2026-09-04_2): band 越界即质变点脉冲气泡 */}
                        {budgetFlash && <p className="mt-1 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">{budgetFlash}</p>}
                        <div className="mt-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all ${curBand >= 5 ? 'bg-red-500 animate-pulse' : curBand === 4 ? 'bg-orange-500' : curBand === 3 ? 'bg-yellow-500' : curBand >= 2 ? 'bg-amber-400' : 'bg-blue-500'}`}
                            style={{ width: `${Math.min(100, (curRatio ?? 0) * 100)}%` }} />
                        </div>
                        <div className="relative mt-0.5 h-3 text-[9px] text-gray-400 select-none">
                          <span className="absolute left-[60%] -translate-x-1/2">|60%</span>
                          <span className="absolute left-[75%] -translate-x-1/2">|75%</span>
                          <span className="absolute left-[95%] -translate-x-1/2">|95%</span>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="bg-gray-50 rounded p-2">
                    <p className="text-xs text-gray-400">费用（¥ 人民币）{costMax != null && costMax > 0 ? '· 已用/上限' : '· 已花费'}</p>
                    <div className="flex items-baseline gap-1 mt-1 flex-wrap">
                      <span className="text-lg font-bold text-green-600">{costUsed != null ? `¥${costUsed.toFixed(4)}` : (costEstimate?.cost != null ? `¥${costEstimate.cost.toFixed(6)}` : '未收口计账')}</span>
                      {costMax != null && costMax > 0 ? (
                        <span className="text-xs text-gray-400">/ ¥{costMax.toFixed(2)}{costSrcLabel}</span>
                      ) : ctxForm.max_cost_usd_per_task ? (
                        <span className="text-xs text-gray-400">/ ¥${ctxForm.max_cost_usd_per_task}</span>
                      ) : costNoCapKnown ? (
                        <span className="text-xs text-gray-400">（未设置金额上限，仅 Token 闸）</span>
                      ) : null}
                    </div>
                    {costMax != null && costMax > 0 && costUsageRatio != null && (
                      <div className="mt-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${costBand >= 5 ? 'bg-red-500 animate-pulse' : costBand === 4 ? 'bg-orange-500' : costBand === 3 ? 'bg-yellow-500' : costBand >= 2 ? 'bg-amber-400' : 'bg-green-500'}`}
                          style={{ width: `${Math.min(100, costUsageRatio * 100)}%` }} />
                      </div>
                    )}
                    {costMax != null && costMax > 0 && costGateActive === false && (
                      <p className="text-[10px] text-amber-600 mt-0.5">费用闸未生效：模型未配置单价，费用无法计量（仅 Token 闸生效）</p>
                    )}
                    {costNoCapKnown && costUsed != null && (
                      <p className="text-[10px] text-gray-500 mt-0.5">本任务未设金额上限：费用照常累计，仅按 Token 预算收敛。如需金额硬闸，可在下方「费用预算」填写。</p>
                    )}
                    {costEstimate?.model && <p className="text-[10px] text-gray-400 mt-0.5">模型: {costEstimate.model} · 输入{formatToken(costEstimate.inputTokens||0)}/输出{formatToken(costEstimate.outputTokens||0)}</p>}
                  </div>
                </div>
                {showContext && (
                  <div className="mt-3 pt-3 border-t space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div><label className="text-xs font-medium">Token 预算</label><input type="number" value={ctxForm.max_tokens_per_task} onChange={e => setCtxForm({...ctxForm, max_tokens_per_task: e.target.value})} className="w-full px-2 py-1 border rounded text-xs mt-0.5" placeholder="如 100000" /></div>
                      <div><label className="text-xs font-medium">费用预算（¥ 人民币/任务）</label><input type="number" step="0.01" value={ctxForm.max_cost_usd_per_task} onChange={e => setCtxForm({...ctxForm, max_cost_usd_per_task: e.target.value})} className="w-full px-2 py-1 border rounded text-xs mt-0.5" placeholder="留空 = 不设金额闸" /></div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setShowContext(false)} className="px-2 py-1 border rounded text-xs hover:bg-gray-50">取消</button>
                      <button onClick={handleSaveContext} className="px-2 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700"><Check className="w-3 h-3 inline"/> 保存</button>
                    </div>
                  </div>
                )}
              </div>

              {/* 任务依赖关系 DAG（M3-4：常驻——新增前置的入口须"无前置时也在"，否则改不了空任务） */}
              {(
                <div className="bg-white rounded-lg border p-4">
                  <h4 className="font-medium mb-2 text-sm flex items-center gap-1"><GitBranch className="w-4 h-4 text-purple-500"/>任务依赖关系</h4>
                  <div className="space-y-1 text-sm">
                    {task.depends_on && (
                      <div className={`flex items-center gap-2 flex-wrap p-2 rounded ${depInfo.state === 'met' ? 'bg-emerald-50' : depInfo.state === 'dead' ? 'bg-red-50' : depInfo.state === 'unresolved' ? 'bg-gray-50' : 'bg-yellow-50'}`}>
                        <span className={`text-xs font-medium ${depInfo.state === 'met' ? 'text-emerald-700' : depInfo.state === 'dead' ? 'text-red-600' : depInfo.state === 'unresolved' ? 'text-gray-500' : 'text-yellow-700'}`}>
                          {depInfo.state === 'met' ? '前置已满足' : depInfo.state === 'dead' ? '前置永不可满足' : depInfo.state === 'unresolved' ? '前置不存在' : `等待前置（还差 ${depInfo.remaining} 个）`}
                        </span>
                        {depIds.map((did) => (
                          <button key={did} type="button" onClick={() => navigate(`/tasks/${did}`)} title={`跳转前置任务：${taskNameOf(did)}`} className="text-xs text-blue-600 hover:text-blue-800 hover:underline">{taskNameOf(did)}</button>
                        ))}
                        <button type="button" disabled={depSaving} onClick={() => saveDeps(depIds.filter((x) => x !== depIds[0]))} title="移除第一个前置（逐条移除）" className="text-[10px] text-gray-400 hover:text-red-600 disabled:opacity-50">移除首个</button>
                        <span className="text-xs text-gray-600 basis-full">{depInfo.text}</span>
                      </div>
                    )}
                    {task.parent_task_id && (
                      <div className="flex items-center gap-2 p-2 bg-blue-50 rounded">
                        <span className="text-xs text-blue-600 font-medium">父任务</span>
                        <button type="button" onClick={() => navigate(`/tasks/${task.parent_task_id}`)} title="跳转父任务" className="text-xs text-blue-600 hover:text-blue-800 hover:underline">{taskNameOf(task.parent_task_id)}</button>
                      </div>
                    )}
                    {/* M3-4: 前置可编辑（此前只能创建时带一次） */}
                    <div className="flex items-center gap-2 pt-1 flex-wrap">
                      {task.status !== 'completed' && task.status !== 'archived' && (
                        <button type="button" onClick={() => { setDepPickerOpen((v) => !v); setDepPickId(''); }} className="text-xs text-purple-600 hover:text-purple-800">＋ 添加前置</button>
                      )}
                      {depPickerOpen && (
                        <>
                          <select value={depPickId} onChange={(e) => setDepPickId(e.target.value)} className="text-xs border rounded px-1 py-0.5 max-w-[220px]">
                            <option value="">选择同项目任务…</option>
                            {depCandidates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                          </select>
                          <button type="button" disabled={!depPickId || depSaving} onClick={() => saveDeps([...depIds, depPickId])} className="text-xs px-2 py-0.5 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50">确定</button>
                          <button type="button" onClick={() => { setDepPickerOpen(false); setDepPickId(''); }} className="text-xs text-gray-500 hover:text-gray-700">取消</button>
                          {depCandidates.length === 0 && <span className="text-xs text-gray-400">（暂无可加的同项目任务）</span>}
                        </>
                      )}
                      {!task.depends_on && !depPickerOpen && <span className="text-xs text-gray-400">当前无前置依赖</span>}
                    </div>
                  </div>
                </div>
              )}

              {/* 相似任务面板 */}
              {similarTasks.length > 0 && (
                <div className="bg-white rounded-lg border p-4">
                  <h4 className="font-medium mb-2 text-sm flex items-center gap-1"><TrendingUp className="w-4 h-4 text-indigo-500"/>相似任务 ({similarTasks.length})</h4>
                  <div className="space-y-1">
                    {similarTasks.map((s: Record<string, unknown>, i: number) => (
                      <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b last:border-0">
                        <span className="text-xs truncate flex-1">{s.title as string}</span>
                        <span className="text-xs text-gray-400 mx-2">{s.status as string}</span>
                        <span className="text-xs text-indigo-600 font-medium">{(Number(s.similarity) * 100).toFixed(0)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* zx_20260924 §2c UI-1: 记忆注入——**本次任务往上下文里放了什么**（记忆这一半）。
                  上移至「本次附件」之上、「产出物」之前（用户 2026-09-24 点名"记忆注入移到产出物上面"）。 */}
              {memBlock}

              {/* zx_20260924 M7: 本次附件（去向）——与「记忆注入」同族（上下文里放了什么），族尾对着「产出物」成"一进一出" */}
              {attsBlock}

              {/* 产出物（zx_20260923_1 M3: 由「产出物验证」之上**移来此处**——「事件时间线」之上） */}
              {delivsBlock}

              {/* 事件时间线（zx_20260924 §2c UI-2: **默认折叠**——用户 2026-09-24 点名；由头同 M3/UI-1，
                  折叠头报**条数**（折叠态下连有几条都看不见就不叫"默认折叠"，叫"默认消失"）。列表体逐字未动。） */}
              {events.length > 0 && (
                <div className="bg-white rounded-lg border p-4">
                  <button type="button" onClick={() => setShowEvents((v) => !v)} className="w-full text-left font-medium text-sm text-gray-500 flex items-center gap-1">
                    {showEvents ? <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />}
                    <History className="w-4 h-4 shrink-0" />事件时间线 ({events.length})
                  </button>
                  {showEvents && <div className="space-y-1.5 max-h-60 overflow-y-auto mt-3">
                    {events.map((e, i) => {
                      const payload = typeof e.payload === 'string' ? (() => { try { return JSON.parse(e.payload as string); } catch { return {}; } })() : (e.payload as Record<string, unknown> || {});
                      return (
                        <div key={i} className="flex items-start gap-2 text-xs py-1">
                          <span className="text-gray-400 flex-shrink-0 w-32">{formatTime(e.occurred_at as string)}</span>
                          <span className={`px-1.5 py-0.5 rounded-full text-[10px] flex-shrink-0 ${(e.event_type as string)?.includes('completed') ? 'bg-green-100 text-green-700' : (e.event_type as string)?.includes('failed') ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-700'}`}>{e.event_type as string}</span>
                          <span className="text-gray-500 truncate">{JSON.stringify(payload).slice(0, 80)}</span>
                        </div>
                      );
                    })}
                  </div>}
                </div>
              )}

              {/* 对话历史（zx_20260923_1 M3: **默认折叠**——用户 2026-09-23 点名） */}
              <div className="bg-white rounded-lg border p-4">
                <button type="button" onClick={() => setShowConvs((v) => !v)} className="w-full text-left font-medium text-sm text-gray-500 flex items-center gap-1">
                  {showConvs ? <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />}
                  <MessageSquare className="w-4 h-4 shrink-0" />对话历史 ({convTotal})
                </button>
                {showConvs && <div className="space-y-2 max-h-[60vh] overflow-y-auto mt-3">
                  {convs.map(c => (
                    // zx_20260916_3 M5（O-F）：引擎代拟的 `user` 行**不再冒充用户**——标签印「引擎」。
                    // 判据取真函数（不是"内容里有没有某个词"的就地正则），故 M5 之后新增的代拟首标自动跟上。
                    <div key={c.id} className={`p-3 rounded-lg text-sm ${isEngineDraftedTurn(c.content)?'bg-slate-50 ml-4 border border-dashed border-slate-200':c.role==='user'?'bg-blue-50 ml-4':c.role==='assistant'?'bg-gray-50 mr-4':c.role==='system'?'bg-yellow-50 mx-4 text-xs':''}`}>
                      <div className="flex items-center gap-2 mb-1"><span className="text-xs font-medium text-gray-400">{isEngineDraftedTurn(c.content) ? '引擎' : c.role}</span>{c.token_count?<span className="text-xs text-gray-300">{formatToken(c.token_count)} tokens</span>:null}<span className="text-xs text-gray-300">{formatTime(c.created_at)}</span></div>
                      <p className="whitespace-pre-wrap text-gray-700">{c.content?.slice(0,3000)}{(c.content?.length||0)>3000?'...':''}</p>
                      {c.tool_calls && <details className="mt-1"><summary className="text-xs text-blue-500 cursor-pointer font-mono">🔧 工具调用</summary><pre className="text-xs text-blue-600 mt-1 bg-blue-50 p-2 rounded overflow-x-auto">{c.tool_calls.slice(0,500)}</pre></details>}
                    </div>
                  ))}
                  {convs.length===0 && <p className="text-sm text-gray-400 text-center py-4">暂无对话记录</p>}
                  {/* zx_20260930 M4-2: 一批之后还有 ⇒ 给「加载更多」。判据与计数都取服务端全量口径，
                      不印 `convs.length`（那是"这一批"，不是"一共"）。 */}
                  {!convExhausted && (
                    <div className="flex items-center justify-between gap-3 border-t pt-2 text-[11px] text-gray-500">
                      <span>已加载 {convs.length} / 共 {convTotal} 轮</span>
                      <button onClick={loadMoreConvs} disabled={convMoreBusy}
                        className="px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-50">{convMoreBusy ? '加载中…' : '加载更多'}</button>
                    </div>
                  )}
                </div>}
              </div>
            </>
          ) : (
            <div className="bg-white rounded-lg border p-12 text-center text-gray-400"><p className="text-lg mb-2">选择任务查看详情</p></div>
          )}
        </div>

      {showCreate && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowCreate(false)}>
          <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-3xl max-h-[88vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-4">新建子任务</h3>
            <div className="space-y-3"><div className="flex items-center gap-2 px-3 py-2 bg-blue-50 rounded"><GitBranch className="w-3.5 h-3.5 text-blue-500"/><span className="text-xs text-blue-700">父任务（当前）：{task?.title || ''}</span></div><div><label className="block text-sm font-medium mb-1">标题*</label><input value={newTask.title} onChange={e=>setNewTask({...newTask,title:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="子任务标题"/></div><div><label className="block text-sm font-medium mb-1">描述</label><textarea value={newTask.description} onChange={e=>setNewTask({...newTask,description:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 leading-relaxed resize-y" rows={7}/></div><div><label className="block text-sm font-medium mb-1">验收标准</label><textarea value={newTask.acceptance_criteria} onChange={e=>setNewTask({...newTask,acceptance_criteria:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 leading-relaxed resize-y" rows={5} placeholder="完成标准（可选，finalize 前会逐条核对）"/></div>{/* zx_20260909_1 M4(Z1): 新建子任务即选"关联方案"——选中一步落 scheme_ref 先于自动动工; 空=继承父方案(默认) */}{linkOnZ && projPlans.length>0 && <div><label className="block text-sm font-medium mb-1">🔗 关联方案（规划）</label><select value={newTask.planTaskId} onChange={e=>setNewTask({...newTask,planTaskId:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"><option value="">继承父方案（默认）</option>{projPlans.map(pl=><option key={pl.id} value={pl.id}>{pl.title}（{statusText(TASK_STATUS_LABEL, pl.status)}）</option>)}</select></div>}</div>
            <div className="flex justify-end gap-2 mt-6"><button onClick={()=>setShowCreate(false)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">取消</button><button onClick={handleCreate} disabled={!newTask.title || creating} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">{creating ? '创建中…' : '创建子任务'}</button></div>
          </div>
        </div>
      )}

      {showReply && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowReply(false)}>
          <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-4">回复任务</h3>
            <div className="space-y-3"><div><label className="block text-sm font-medium mb-1">回复内容</label><textarea value={replyText} onChange={e=>setReplyText(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" rows={3} placeholder="输入回复内容后点击恢复即可继续任务" /></div></div>
            <div className="flex justify-end gap-2 mt-6"><button onClick={()=>setShowReply(false)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">取消</button><button onClick={()=>handleReply(task!.id)} disabled={!replyText.trim() || actionLocked} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">回复并恢复</button></div>
          </div>
        </div>
      )}

      {delivPreview && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setDelivPreview(null)}>
          <div className="bg-white rounded-xl shadow-lg w-full max-w-5xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="font-bold">{delivPreview.name} <span className="text-xs text-gray-400 ml-2">{delivPreview.type}</span></h3>
              <div className="flex items-center gap-2">
                {delivPreview.filePath && <span className="text-xs text-gray-400 font-mono truncate max-w-md">{delivPreview.filePath}</span>}
                <button onClick={() => setDelivPreview(null)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {/* zx_20260913 M2-6(G8 复发点): 此为预览判据的**第二落点**——只认 'doc' 会让 code 成果
                  经新增的 code 预览入口打开后永不显示"磁盘已缺失"，名实不符。收敛到共享 isPreviewType。 */}
              {delivPreview.fileExists === false && isPreviewType(delivPreview.type) && (
                <div className="mb-2 px-3 py-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-700">
                  磁盘文件已缺失/被移动——当前展示的是{delivPreview.version && delivPreview.version > 1 ? `版本历史快照 v${delivPreview.version}` : '既有快照'}，非实时文件内容。
                </div>
              )}
              {delivPreview.content ? <div className="text-sm text-gray-700"><MarkdownSubset source={delivPreview.content} /></div> : <div className="text-center text-gray-400 py-8"><p className="text-sm">(无内容)</p>{delivPreview.filePath && <p className="text-xs mt-2">文件路径: {delivPreview.filePath}</p>}</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface DiffLineItem { type: string; content: string }
interface DiffHunkItem { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLineItem[] }

function FileChangeItem({ f }: { f: Record<string, unknown> }) {
  const action = f.action as string;
  const filePath = (f.filePath as string) || '';
  const size = f.size as number | undefined;
  const content = f.content as string | undefined;
  const hunks = f.hunks as DiffHunkItem[] | undefined;
  const additions = f.additions as number | undefined;
  const deletions = f.deletions as number | undefined;
  const truncated = f.truncated as boolean | undefined;
  const fileName = filePath.split('/').pop() || filePath;

  const ACTION_LABEL: Record<string, string> = { created: '创建', updated: '修改', edited: '编辑' };
  const ACTION_COLOR: Record<string, string> = { created: 'bg-green-100 text-green-700', updated: 'bg-blue-100 text-blue-700', edited: 'bg-purple-100 text-purple-700' };

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1.5 bg-gray-50 border-b">
        <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${ACTION_COLOR[action] || 'bg-gray-100'}`}>{ACTION_LABEL[action] || action}</span>
        <span className="text-xs font-mono text-gray-700 truncate flex-1" title={filePath}>{fileName}</span>
        {size != null && <span className="text-[10px] text-gray-400 shrink-0">{size}B</span>}
        {additions != null && <span className="text-[10px] text-green-600 shrink-0">+{additions}</span>}
        {deletions != null && <span className="text-[10px] text-red-500 shrink-0">-{deletions}</span>}
      </div>
      {action === 'created' ? (
        <pre className="text-xs font-mono p-2 bg-green-50 text-green-700 whitespace-pre-wrap max-h-40 overflow-y-auto">{content || ''}</pre>
      ) : (
        <div className="font-mono text-xs">
          {hunks && hunks.map((h, hi) => (
            <div key={hi}>
              <div className="text-[10px] text-gray-400 px-2 py-0.5 bg-gray-50 border-b">@@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@</div>
              {h.lines.map((l, li) => (
                <div key={li} className={`px-2 whitespace-pre-wrap ${l.type === 'add' ? 'bg-green-50 text-green-700' : l.type === 'del' ? 'bg-red-50 text-red-600' : 'text-gray-600'}`}>
                  <span className="w-4 inline-block text-gray-400 select-none">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>{l.content || ' '}
                </div>
              ))}
            </div>
          ))}
          {truncated && <div className="text-[10px] text-gray-400 px-2 py-1">（文件过大，仅显示前 400 行 diff）</div>}
        </div>
      )}
    </div>
  );
}
