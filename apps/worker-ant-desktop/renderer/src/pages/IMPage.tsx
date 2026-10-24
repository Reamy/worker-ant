import { useState, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { im, invoke } from '../lib/ipc';
import { consumeImOutboxRequest } from '../lib/uiIntent';
import { messageViewOf } from '../lib/messageView';
import { formatDbTime, parseDbTime } from '../lib/deliverable-view';
import { convBusyOf, convDeliveryOf } from '../lib/convDelivery';
// zx_20261002 M3(维特根斯坦·意义即使用): 回话对象**显式选择优先**——收件人判定的唯一一处实现。
import { resolveReplyPeer, replyPeerNotice } from '../lib/reply-peer';
// zx_20260930 M1(维特根斯坦·意义即使用): 一「件」的分派判定与控件。
//   判定 `imMediaOf` 在 main 侧零依赖模块里（**一处**产出"该出哪种控件"），本页只把它翻成 DOM——
//   在渲染层再抄一份"什么算图片"就是同一条规则的第二处载体，改一处忘另一处。
import { imMediaOf, baseNameOf, type ImMediaRef } from '../../../src/main/core/im/im-media-view.js';
// zx_20260930 M1: 附件钮的**禁用判据**——能力表（`media`/`note`）是"本通道发不了件"的唯一真源；
//   界面不另写一句同义文案（`MEDIA_UNSUPPORTED_TEXT` 那句在源码里出现即被 rr 判红）。
import { channelCapabilities } from '../../../src/main/core/im/channel-capabilities.js';
import { ImMediaBubble } from '../components/ImMediaBubble';
// zx_20261003 M11: 长文正文可收可展（折叠限高 + 展开全文）——会话流每行一个实例，各收各展。
import { ClampText } from '../components/ClampText';
import { Plus, Play, Square, Trash2, MessageSquare, RefreshCw, QrCode, X, Stethoscope, Send, Loader2, Edit, Paperclip, Copy, CornerUpLeft } from 'lucide-react';

interface Channel { id: string; channel_type: string; name: string; config: string; status: string; created_at: string; }
// zx_20260912 M2-4: seq = 会话行 rowid（main 侧 `SELECT rowid AS seq`）——分页游标与稳定次序同一把尺。
// zx_20260913 M1-4: status/last_error/outbox_id —— 出站送达态写在事本身的行上（未送达也到场）。
interface Conversation { id: string; seq: number; external_user_id: string; message_json: string; direction: string; created_at: string; status?: string; last_error?: string; outbox_id?: string; task_id?: string; task_title?: string; }
/** zx_20260930 M2: `message_json` 里的正文（认不出就是空串）——用来判"刚按下发送的那一行，
 *  是不是**真的**已经在服务端返回的这一屏里"。手发的两条路写进库的都是这一串：手发文字＝用户原文，
 *  手发件＝`📎 件名`（失败行由 `im-outbox.entryPreview` 写同一串，故成/败两支同一把尺）。 */
function jsonTextOf(raw?: string): string {
  try { const o = JSON.parse(raw || '') as { text?: unknown }; return typeof o?.text === 'string' ? o.text : ''; } catch { return ''; }
}
// zx_20260913 M1-3(庄子·得鱼忘筌): 用户标识不裸奔完整 openid——稳定短 handle(尾 6 位) + 完整值移入 title。
//   无 id 如实说「未知用户」；**不伪造昵称**（M0 已证入站载荷无昵称字段，编一个就是假话）。
function userLabel(id?: string | null): string {
  const v = (id || '').trim();
  if (!v) return '未知用户';
  return v.length <= 10 ? v : `…${v.slice(-6)}`;
}
// zx_20260913 M1-3: 渠道行摘要只取**类型白名单里的非密钥字段**（黑名单会漏，白名单不会）。
const SAFE_CONFIG_KEYS: Record<string, string[]> = {
  'wecom': ['corpId'], 'feishu': ['appId'], 'qqbot': ['app_id'], 'dingtalk': ['clientId', 'robotCode'], 'wechat-personal': [],
};
function configSummary(type: string, cfgRaw: string): string {
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(cfgRaw || '{}') as Record<string, unknown>; } catch { return ''; }
  const keys = SAFE_CONFIG_KEYS[type] || [];
  const parts: string[] = [];
  for (const k of keys) {
    const v = String(cfg[k] ?? '').trim();
    if (v) parts.push(`${k} …${v.slice(-4)}`);
  }
  return parts.join(' · ');
}
// zx_20260913 M1-5: 对话按**自然日**分组（今日/昨日/更早＋日期小标题）——7004 条平铺翻不动。
// 库内时间列是 UTC 且不带 Z——解析只此一份（lib/deliverable-view 的 parseDbTime），本页只做分组
function dayLabel(createdAt?: string | null): string {
  const d = parseDbTime((createdAt || '').trim());
  if (!d) return '更早';
  const now = new Date();
  const ymd = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (ymd(d) === ymd(now)) return '今日';
  if (ymd(d) === ymd(y)) return '昨日';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
/** 出站送达态（仅 outbound 有语义）——`sent` 说已送达，`failed` 如实说未送达 + 原因；inbound 不据此说话。
 *  zx_20260920 M3: 判定已移入 `lib/convDelivery.ts`（纯函数，受控复跑直调真实现），
 *  此处只把 tone 翻成配色档——**决定与配色各一处**，不再在 JSX 里各判一份。 */
const DELIVERY_TONE_CLS: Record<'ok' | 'bad' | 'busy', string> = {
  ok: 'text-green-600', bad: 'text-red-600', busy: 'text-amber-600',
};
/** zx_20260920 M3-b(乐观气泡): 一条**只存在于当前页面**的出站消息。
 *  它不参与 `seq`/滚动/按日分组——那些账算的是库里真有的行，掺进取会虚增"↑ N 条新消息"。 */
interface OptimisticSend {
  key: string;
  /** 归属渠道——换渠道即看不见别人的占位（不靠"记得清空"来保证，靠归属本身）。 */
  channelId: string;
  externalUserId: string;
  text: string;
  at: string;
  /** zx_20261003 M13: 手发**件**时带上那件（`imMediaOf` 从文件选择器路径判出的形状）——
   *  与真行到场后那条路**同一个控件**（`ImMediaBubble`），故占位与落定长得一样、不跳一下。
   *  纯文本手发不带它 ⇒ 仍走文本气泡。 */
  media?: ImMediaRef;
  /** 非空 = 真行**没到场**（取数失败，或取回了但这一行不在其中）——这条**只存在于此页**，重新加载即消失，须如实说。
   *  zx_20260930 M2: 与 `sent` 合读才不撒两种谎——"没送达"和"发出了但这屏还没取到"是两件事。 */
  failed?: string;
  /** 发送那一跳**本身**成没成（不取决于真行取没取回来）。缺省＝还没回来。 */
  sent?: boolean;
}
// zx_20260911_5 M1: 出站补发账——四态穷尽统计(含等条件恢复的 blocked_quota) + 逐条明细
// zx_20260930 M4-3(一处真源): `byStatus` = main 侧**未折叠**的逐状态计数，与上面五档同出一次 `GROUP BY status`。
//   折叠档答"共有多少条没送达"，它答"哪几态、各几条"——分组表按**它**出组与"共 M 条"，
//   否则"显示得下的"会被当成"总共有的"（账 >200 条时用户数得到、翻不着）。
interface OutboxStats { pending:number; blocked_quota:number; dead:number; sent:number; other:number; byStatus?:Record<string,number> }
// zx_20260912 M3(管子·度量衡): 逐条记因——last_error=最近一次失败的真原因(null ⇒ 如实说"原因未记录"，不回填猜测)。
// zx_20260924_1 M8(一处真源): channel_type/media_* 是补发路与界面判"这是不是一条件"的键；
//   `media_unsupported`/`media_unsupported_reason` 由 main 侧 `listOutbox` **派生好一起返回**
//   （渲染层拿不到能力表，自己拼一句同义文案就是第二份真源）⇒ 这里只照抄，不自判、不手抄文案。
interface OutboxRow { id:string; channel_id:string|null; channel_name:string|null; channel_type:string|null; external_user_id:string|null; task_id:string|null; task_title:string|null; kind:string; message:string; media_path:string|null; media_kind:string|null; media_unsupported:boolean; media_unsupported_reason:string; attempts:number; status:string; created_at:string|null; next_retry_at:number|null; last_error:string|null; last_attempt_at:string|null }
// zx_20260924_1 M8(终态说终态): `unsupported_media` 是**第三类结果**——"通道结构上发不了件"，
//   与 pending("还没成，会再试")、dead("试过了，已放弃") 各不相同，界面上必须各说各的。
const OUTBOX_GROUP_LABEL: Record<string,string> = { pending:'待补发', blocked_quota:'等待条件恢复（配额/登录态恢复后自动重试）', unsupported_media:'不会送达（重试无效；原因见该行"失败原因"）', dead:'最终未送达（已放弃：超窗/超次）', sent:'已送达' };
/** zx_20260930 M4-3: 分组**次序**表——只定先后，**不定成员**（成员由 `byStatus` 定，未知态照样出场，
 *  否则"新态"会被这张表筛掉，行在账里、在页上整段不显示）。 */
const OUTBOX_GROUP_ORDER = ['pending','blocked_quota','unsupported_media','dead','sent'];
/** zx_20260930 M4-3(一处真源): 明细页大小——与 main 侧单页上限（`OUTBOX_PAGE_MAX`=500）同向且更小，
 *  故渲染层这一侧**永远不会**撞到 main 的夹取上限，"翻得到底"这句承诺才成立。 */
const OUTBOX_PAGE = 200;
/** zx_20260912 M3: 失败原因如实显示——没尝试过就说没尝试过，尝试过但没记到原因就说没记到，绝不拿空话冒充原因。 */
function outboxReason(r: OutboxRow): string {
  const e = (r.last_error || '').trim();
  if (e) return e;
  return r.attempts > 0 ? '原因未记录（本次未送达）' : '尚未尝试补发';
}
// zx_20260930 M1: 手发两条路(`manual_reply`/`manual_media`)此前漏在这张表外 ⇒ 补发账里只显示英文 kind，
//   用户读到"manual_media"不知道那是什么。与上面那张分组表同一把尺：新 kind 漏在这张表里，账就翻不开。
const OUTBOX_KIND_LABEL: Record<string,string> = { notification:'通知', ask_user:'提问', pause_needed:'介入暂停', manual_reply:'手工回话', manual_media:'手工发件' };

const CHANNEL_TYPES = ['wechat-personal','qqbot','dingtalk','feishu','wecom'] as const;

/** zx_20260911_5 M2-3: 对话分页页大小——与 main 侧 `im:conversations` 的 LIMIT 50 同尺。 */
const CONV_PAGE = 50;

// zx_20260911_5 M2-1(维特根斯坦·意义即用法): 徽标须如实映射 adapter 真实落库态。
// E11 实测 wechat-adapter 会落 status='error'(取码失败/无 token/扫码后无 token)，旧三元把它
// 落入 else 分支显示「已停止」——名不符实。现 error 独立为红色「异常」；pending 仍为「等待扫码」。
// zx_20260912 M1(海德格尔·在场): 断连重连中/长轮询连续失败——还没放弃但不健康，不可冒充「运行中」。
//
// zx_20260912 M6/G8(维特根斯坦·同一把尺): **renderer 侧状态词表＝唯一真源**。
// main 侧的唯一真源是 `core/im/im-channel-status.ts` 的 SQL 谓词；renderer 拿不到它（跨进程、且这里只有裸 status 字符串），
// 故本表是同一词表的**第二处载体**——用 `Record<ChannelStatus, …>` 让 TS **强制穷举**：
// main 新增一个运行态而此处未作决定 ⇒ typecheck 红（编译期兜住，不再靠人记得改）。
// 病根：此前"状态"被三处**各自手抄清单**——徽标映射 / 启停按钮显隐 / 扫码收口，
// `starting` 因三处都漏而**两个按钮皆无**（DB 确会落 starting：feishu 握手未成、onReady 才转 running），
// 用户对卡在 starting 的渠道**无任何界面手段可干预**。现四处决定全从本表出，一处改、处处同尺。
type ChannelStatus = 'inactive' | 'stopped' | 'active' | 'running' | 'starting' | 'pending' | 'degraded' | 'error';
interface ChannelStatusMeta {
  /** 徽标文案 */
  label: string;
  /** 徽标底色 */
  cls: string;
  /** 有值＝显示「启动」按钮，值即按钮 title（启动/重新启动/强制重启）——一个字段兼作显隐与措辞，无从漏抄 */
  start?: string;
  /** true＝显示「停止」按钮 */
  stop?: boolean;
  /** 状态说明行（running 期跃迁 detail）用告警色而非灰 */
  alarm: boolean;
  /** 扫码弹窗：'ok'＝收口（登录成功）/ 'fail'＝收口并如实报错 / 'none'＝继续等（本渠道状态而非 QR 端点自己的词表） */
  qrClose: 'ok' | 'fail' | 'none';
}
const CH_STATUS_META: Record<ChannelStatus, ChannelStatusMeta> = {
  inactive: { label:'已停止',      cls:'bg-gray-100 text-gray-500',     start:'启动',                    alarm:false, qrClose:'none' },
  // 'stopped' 现行 main 侧无写入点（该列只写 inactive/active 与适配器运行态），保留为历史库值别名以免旧行显示错位。
  stopped:  { label:'已停止',      cls:'bg-gray-100 text-gray-500',     start:'启动',                    alarm:false, qrClose:'none' },
  active:   { label:'运行中',      cls:'bg-green-100 text-green-700',   stop:true,                       alarm:false, qrClose:'ok'   },
  running:  { label:'运行中',      cls:'bg-green-100 text-green-700',   stop:true,                       alarm:false, qrClose:'ok'   },
  // 握手中：可中止、可强制重启（与 degraded 同待遇）——不可像此前那样"两钮皆无"。
  starting: { label:'启动中',      cls:'bg-yellow-100 text-yellow-700', start:'强制重启', stop:true,     alarm:false, qrClose:'none' },
  pending:  { label:'等待扫码',    cls:'bg-yellow-100 text-yellow-700', stop:true,                       alarm:false, qrClose:'none' },
  degraded: { label:'降级·重连中',  cls:'bg-orange-100 text-orange-700', start:'强制重启', stop:true,     alarm:true,  qrClose:'none' },
  error:    { label:'异常',        cls:'bg-red-100 text-red-700',       start:'重新启动',                 alarm:true,  qrClose:'fail' },
};
/** 词表未收录的值（该列 DDL 是 TEXT，可能是历史/未来取值）——**不冒充「已停止」**（那是假话），
 *  如实说「未知状态」并**两个按钮都给**：与 main 侧「非 inactive 即试一次」同一失败方向——
 *  宁可让用户试，不静默搁置。 */
const UNKNOWN_STATUS_META: ChannelStatusMeta = { label:'未知状态', cls:'bg-gray-100 text-gray-500', start:'启动', stop:true, alarm:false, qrClose:'none' };
const statusMeta = (s: string): ChannelStatusMeta => CH_STATUS_META[s as ChannelStatus] ?? UNKNOWN_STATUS_META;

export default function IMPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<Record<string,string>>({channel_type:'wechat-personal',name:''});
  const [editing, setEditing] = useState<Channel|null>(null);
  const [qrChannel, setQrChannel] = useState<{id:string;name:string;img:string}|null>(null);
  const [convChannel, setConvChannel] = useState<string|null>(null);
  const [convs, setConvs] = useState<Conversation[]>([]);
  /** zx_20261002 M3: **显式选定**的回话对象（null = 未选，取列表最新一条作默认）。
   *  一旦选定就不被筛选/入站前插顶替——"发送给谁"不再随列表漂（方案 §1.1-6）。 */
  const [replyPeer, setReplyPeer] = useState<string|null>(null);
  // zx_20260911_5 M2-3(海德格尔·上手状态): 对话历史须可达——补"加载更多"(offset 追加), 不再一次 50 条到顶。
  const [convHasMore, setConvHasMore] = useState(false);
  const [convLoadingMore, setConvLoadingMore] = useState(false);
  // zx_20260920 M3-c(上手状态): 打开会话的**在途态**——与 `convLoadingMore`(加载更早)语义不串台：
  //   前者是"换过一页、内容还没到"，后者是"往下翻、上一页还在"。此前打开会话那段空档界面只能说
  //   「暂无对话」——一句在没有数据时也为真的话，用户读成"这个渠道没消息"，实际是"还没取到"。
  const [convLoading, setConvLoading] = useState(false);
  // zx_20260920 M3-b(乐观气泡): 已按下发送、真行尚未取回的每一条。
  const [optimistic, setOptimistic] = useState<OptimisticSend[]>([]);
  // zx_20260911_5 M2-4(上手状态): 二维码过期/失败须在弹窗内如实显示, 不再拿"加载中..."冒充。
  const [qrMsg, setQrMsg] = useState<{ok:boolean;text:string}|null>(null);
  const [diagnosing, setDiagnosing] = useState<Set<string>>(new Set());
  const [diagResults, setDiagResults] = useState<Record<string,Array<{check:string;pass:boolean;detail:string}>>>({});
  const [resending, setResending] = useState<Set<string>>(new Set());
  // zx_20260911_2 M3(如实): 出站补发账只读统计——pending=待补发, dead=超窗/超次已放弃
  // zx_20260911_5 M1(得鱼忘筌/知行合一): 补四态(含 blocked_quota) + 逐条明细 + 单条手动补发
  const [outbox, setOutbox] = useState<OutboxStats>({pending:0,blocked_quota:0,dead:0,sent:0,other:0,byStatus:{}});
  const [outboxOpen, setOutboxOpen] = useState(false);
  const [outboxRows, setOutboxRows] = useState<OutboxRow[]>([]);
  const [outboxBusy, setOutboxBusy] = useState<Set<string>>(new Set());
  const [outboxMsg, setOutboxMsg] = useState<{ok:boolean;text:string}|null>(null);
  // zx_20260930 M4-3: 明细**翻页**的两个状态——`outboxExhausted`=末页已取空（别再放下一个「加载更多」钮），
  //   `outboxMoreBusy`=取下一页中（按钮有在途态，点了有反馈）。
  const [outboxExhausted, setOutboxExhausted] = useState(false);
  const [outboxMoreBusy, setOutboxMoreBusy] = useState(false);
  const [resendMsg, setResendMsg] = useState<{ok:boolean;text:string}|null>(null);
  // zx_20260912 M1(海德格尔·在场): 运行期跃迁的如实说明（"重连中（第 3 次）"/失败原因），随 channel.status_changed 到达。
  const [statusDetail, setStatusDetail] = useState<Record<string,string>>({});
  // 启停进行中——按钮有在途态（此前点了无反馈，用户会重复点）。
  const [busyChannels, setBusyChannels] = useState<Set<string>>(new Set());
  // zx_20260913 M1-2(在场): 刷新/添加/保存的**在途态**——不复用 busyChannels(那是"渠道启停"的语义,
  //   混用会让渠道行的启停按钮跟着转, 语义串台)。键为动作名, 与渠道 id 无关。
  const [uiBusy, setUiBusy] = useState<Set<string>>(new Set());
  // zx_20260913 M1-5(上手状态): 对话搜索词 + 方向筛选(服务端过滤, 非前端全量过滤)。
  const [convQ, setConvQ] = useState('');
  const [convDirection, setConvDirection] = useState<'' | 'inbound' | 'outbound'>('');
  // zx_20260914 M1-3(海德格尔·在场): 未读以**新消息提示条**示人，不抢走正在读的位置——
  //   列表是 `ORDER BY rowid DESC`（新在上），故"最新处"= **列表顶端**；`newBelow` 记的是
  //   "顶端之上新到了几条"（按 seq 记账，不按条数——条数会随筛选/分页变）。
  const convScrollRef = useRef<HTMLDivElement | null>(null);
  const atTopRef = useRef(true);
  const seenMaxSeqRef = useRef(0);
  const prevScrollHRef = useRef(0);
  const [newOnTop, setNewOnTop] = useState(0);
  const [copyTip, setCopyTip] = useState('');
  // zx_20261003 M12(维特根斯坦·意义即使用): **逐渠道**未读——渠道行红点用它。取值**只来自 main**
  //   （`im.unreadByChannel`），界面不自算（承 zx_20260914 M1-3 口径：未读账 main 一处算）。
  const [unreadByChannel, setUnreadByChannel] = useState<Record<string, number>>({});
  // zx_20260914 M1-4(庄子·得鱼忘筌): 手工回话——收件人取**当前列表最新一条的用户**（方案 §批 M1-B.C：
  //   不猜、也不提供裸 id 输入口，守用户裁定"仅已有会话上回话"）。
  const [sendText, setSendText] = useState('');
  const [sendMsg, setSendMsg] = useState<{ok:boolean;text:string}|null>(null);

  useEffect(() => {
    loadChannels(); void loadOutbox(); void refreshUnreadByChannel();
    // zx_20260912 M3: 托盘「出站未送达 N 条 →」——意图在跳转前先落(页面 lazy 分包, 事件可能先于挂载),
    //  挂载时消费一次: 展开明细 + 取行。取走即清, 之后正常进 IM 页不会莫名展开。
    if (consumeImOutboxRequest()) { setOutboxOpen(true); void loadOutboxRows(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // zx_20261002 M2: **挂载不再清零**（原 `useEffect(() => void im.markRead(), [])` 已删）。
  //   病根（方案 §1.1-5）：进 `/im` 默认停在**渠道列表**（对话面板需 `convChannel &&` 才渲染），
  //   挂载即全局清零 ⇒ 红点在"尚未读任何对话"时消失，回来已分不清哪些是新消息。
  //   现改为**该会话被点开 / 进入可视**时才清（见 `showConvs` 与下方 visibilitychange 监听）。
  async function loadChannels() { setLoading(true); try { const d=await im.channels() as unknown as Channel[]; setChannels(d); setError(''); } catch(e){setError((e as Error).message)} finally{setLoading(false)} }
  /** 静默刷新：只换数据、不进整页 spinner。整页 spinner 会把用户正在看的对话/补发账面板整个卸载。 */
  async function refreshChannels() { try { const d=await im.channels() as unknown as Channel[]; setChannels(d); setError(''); } catch(e){setError((e as Error).message)} }
  /**
   * zx_20261003 M12: 取**逐渠道**未读（红点）。数来自 main 一处算，界面只换数据、**不自算**。
   * 取不到不打断页面（红点缺省即"无未读"，不假装有、也不把整页弄红）。
   */
  async function refreshUnreadByChannel() { try { const d=await im.unreadByChannel() as unknown as {byChannel?:Record<string,number>}|null; setUnreadByChannel(d?.byChannel||{}); } catch(e){ void e; } }
  async function loadOutbox() { try { const d=await invoke('im:outboxStats') as unknown as OutboxStats|null; if(d) setOutbox({pending:d.pending||0,blocked_quota:d.blocked_quota||0,dead:d.dead||0,sent:d.sent||0,other:d.other||0,byStatus:d.byStatus||{}}); } catch(e){ setError(`读取补发账统计失败：${(e as Error).message}`); } }
  // zx_20260930 M4-3(得鱼忘筌): 首屏取第 0 页——此前写死 `limit:200` 且**没有下一页**，
  //   于是账超过 200 条时，多出来的行在界面上**根本不可达**（统计数得到、明细取不着）。
  async function loadOutboxRows() { try { const d=await invoke('im:outboxList',{limit:OUTBOX_PAGE, offset:0}) as unknown as OutboxRow[]|null; const rows=Array.isArray(d)?d:[]; setOutboxRows(rows); setOutboxExhausted(rows.length<OUTBOX_PAGE); } catch(e){ setError(`读取补发账明细失败：${(e as Error).message}`); } }
  /** zx_20260930 M4-3: 追加下一页（`offset` = 已列出的条数，**不整体替换**，与对话「加载更多」同一手法）。 */
  async function loadMoreOutboxRows() {
    setOutboxMoreBusy(true);
    try {
      const d=await invoke('im:outboxList',{limit:OUTBOX_PAGE, offset:outboxRows.length}) as unknown as OutboxRow[]|null;
      const more=Array.isArray(d)?d:[];
      // 按 id 去重：翻页期间若有新行落账，`offset` 会整体错位而**重复**列出同一条；
      //   重复显示是"账翻错了"，比少显示一行严重得多，故在此收一道（少显示由"加载更多"补回）。
      setOutboxRows(prev=>{ const seen=new Set(prev.map(r=>r.id)); return [...prev, ...more.filter(r=>!seen.has(r.id))]; });
      setOutboxExhausted(more.length<OUTBOX_PAGE);
    } catch(e){ setError(`读取补发账明细失败：${(e as Error).message}`); }
    finally { setOutboxMoreBusy(false); }
  }
  function toggleOutbox() { const next=!outboxOpen; setOutboxOpen(next); setOutboxMsg(null); if(next) void loadOutboxRows(); }
  async function handleOutboxRetry(id: string) {
    // zx_20260911_5 M1-4: 二次确认 + 明示配额口径（与 im:resend 同尺）——不静默消耗配额
    if (!confirm('确认补发这条消息？\n\n手动补发走主动推送，会计入当日推送配额；配额耗尽时将无法送达。')) return;
    setOutboxBusy(s=>new Set(s).add(id)); setOutboxMsg(null);
    try {
      const r = await invoke('im:outboxRetry', id) as unknown as {ok:boolean;status:string;attempts:number;error?:string;note?:string};
      // zx_20260924_1 M8(终态说终态): 此前不论青红皂白都说「未送达」——把"本通道发不了件"这种
      //   **结构性、永远到不了**的结果，说成了"这一次没送到"(读起来是"再点点就好了")。
      //   现按返回的 status 分两说：还能试的 / 已经不会成了的。理由串一律取 main 给的 error，
      //   界面不另写一句同义文案（同源在 `channel-capabilities.ts`）。
      //   （`not_found` **不在此列**：main 把它包成 IpcError 抛出，走下方 catch——同一件事不多写一路。）
      const st = String(r?.status || '');
      let text: string;
      if (r?.ok) text = '已补发送达。';
      else if (st === 'unsupported_media') text = `${r?.error || '本通道发不了件'}（此项不会再送达）`;
      else if (st === 'dead') text = `最终未送达：${r?.error || '已放弃（超窗/超次）'}`;
      else if (st === 'sent') text = `该条此前已送达`;
      else text = `本次未送达：${r?.error || '未知原因'}（仍会继续补发）`;
      setOutboxMsg({ ok: !!r?.ok, text: `${text}${r?.note?`（${r.note}）`:''}` });
    } catch(e) { setOutboxMsg({ok:false,text:(e as Error).message||'补发失败'}); }
    finally { setOutboxBusy(s=>{const n=new Set(s);n.delete(id);return n;}); await loadOutbox(); if(outboxOpen) await loadOutboxRows(); }
  }
  // zx_20260905 批6: IM 渠道页实时——channel.started/stopped 事件驱动刷新（main 已转发，此前页面零订阅仅操作时手动 reload）
  // zx_20260906 批4 (4a): 入站消息实时——main 在 im-router 落库后发 im.message_inbound；正在查看该渠道则即时刷新新对话
  const convChannelRef = useRef<string | null>(null);
  useEffect(() => { convChannelRef.current = convChannel; }, [convChannel]);
  // zx_20261002 M2: 「该会话**进入可视**」——窗口从后台转回可见时，若正开着某渠道的对话，才算看过它，
  //   只清该渠道。与 `showConvs`（被点开）合起来构成"看过"的两个入口；窗口隐藏时不动作
  //   （否则最小化也吞掉未读——那条纪律由 §1.1-5 与 M1 的降噪口径共同钉住）。
  useEffect(() => {
    const onVisible = () => {
      const cid = convChannelRef.current;
      if (document.visibilityState === 'visible' && cid) void im.markRead(cid).then(() => refreshUnreadByChannel()).catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  // zx_20260913 M1-5: 筛选值也入 ref——事件驱动的取数(在 `[]` 依赖的 effect 里)读 ref 才不会拿到陈旧闭包值。
  const convQRef = useRef('');
  const convDirRef = useRef<'' | 'inbound' | 'outbound'>('');
  useEffect(() => { convQRef.current = convQ; convDirRef.current = convDirection; }, [convQ, convDirection]);
  /** 当前筛选（服务端参数）——取数路径唯一出口，避免各处各拼一份条件（同一把尺）。 */
  const convFilter = () => ({ q: convQ.trim() || undefined, direction: convDirection || undefined });
  // zx_20260912 M2-1: 扫码弹窗所看渠道——扫码结果走 channel.status_changed 事件驱动收口（2s 轮询降为兜底）。
  const qrChannelRef = useRef<{ id: string } | null>(null);
  useEffect(() => { qrChannelRef.current = qrChannel; }, [qrChannel]);
  // zx_20260911_5 M2-4: 二维码轮询/硬上限句柄——统一由 closeQr 清理(手动关闭也不漏)。
  const qrTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrHardStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // zx_20260911_5 M1-5: 明细面板展开时, 出站/落账事件也刷新明细（此前失败落账完全不上报, 横幅只在手动点击后更新）
  const outboxOpenRef = useRef(false);
  // zx_20260930 M2(海德格尔·上手状态): 出站**短窗重取**的代际号——新出站事件到来即作废旧链（见 `refetchOutboundSoon`）。
  const outboundGenRef = useRef(0);
  useEffect(() => { outboxOpenRef.current = outboxOpen; }, [outboxOpen]);
  useEffect(() => {
    if (!window.electronAPI?.onTaskEvent) return;
    return window.electronAPI.onTaskEvent((event) => {
      // 事件驱动刷新一律走静默刷新（不进整页 spinner）——否则状态一变就把正在看的面板卸载掉。
      if (event.type === 'channel.started' || event.type === 'channel.stopped') void refreshChannels();
      // zx_20260912 M1: 运行期跃迁（降级/恢复/放弃）——落库已由 main 完成，这里如实跟上并记下原因。
      if (event.type === 'channel.status_changed') {
        const cid = String(event.channelId ?? '');
        if (cid) {
          setStatusDetail(prev => ({ ...prev, [cid]: String(event.detail ?? '') }));
          void refreshChannels();
          // zx_20260912 M2-1: 扫码结果也走这条通道（M1 已把 pollQrStatus 的跃迁收编进 reporter）——
          // 弹窗据此即时收口；下方 2s 轮询只作兜底（事件为主）。
          const q = qrChannelRef.current;
          if (q && cid === q.id) {
            // G8: 收口条件走词表（qrClose）——与下方兜底轮询同一份决定，不再各判一份清单。
            const qr = statusMeta(String(event.status ?? '')).qrClose;
            if (qr === 'ok') { closeQr(); }
            else if (qr === 'fail') { closeQr(); setError(String(event.detail ?? '') || '扫码登录失败，请重试。'); }
          }
        }
      }
      if (event.type === 'im.message_inbound' || event.type === 'im.message_outbound') {
        const cid = String(event.channelId ?? event.channel_id ?? '');
        // zx_20261003 M12: 入站会改变某渠道的未读 ⇒ 红点即时跟上（含**非**当前打开的渠道）。
        if (event.type === 'im.message_inbound') void refreshUnreadByChannel();
        // zx_20260912 M2-4: 实时入站只**前插**、不重置已加载集合（此前 showConvs 会退回 50 条，翻过的页丢失）。
        // zx_20260930 M2: 出站走**短窗重取**——事件与行落盘是两条路，取一次就成了赌"事件一定晚于 INSERT"。
        if (cid && cid === convChannelRef.current) {
          if (event.type === 'im.message_outbound') refetchOutboundSoon(cid);
          else void prependNewConvs(cid);
        }
        if (event.type === 'im.message_inbound' && document.visibilityState === 'visible' && cid === convChannelRef.current) {
          // zx_20261002 M2: 收窄为「**正看着的那个渠道**」——此前"页面可见 + 任意渠道入站即全局清零"，
          //   于是看着 A 渠道时 B 来消息，B 的未读也被一并抹掉（用户根本没看见那条）。
          //   现在只有入站渠道恰是当前打开的对话、且窗口可见，才算"这条消息确实被看见了"。
          void im.markRead(cid).then(() => refreshUnreadByChannel()).catch(() => {});
        }
        if (event.type === 'im.message_outbound') { void loadOutbox(); if (outboxOpenRef.current) void loadOutboxRows(); }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // zx_20260913 M1-5: 搜索词/方向变化 → 重新取第一页(带 300ms 防抖, 免每敲一键都打 IPC)。
  //   筛选一变即从最新一页重取, 游标同步归零——否则会拿旧游标在新条件下翻页(重/漏)。
  useEffect(() => {
    if (!convChannel) return;
    const t = setTimeout(() => { void showConvs(convChannel); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convQ, convDirection]);
  // zx_20260914 M1-3(海德格尔·在场 / 不打断): 新消息到达时两条规矩，**一处决定**（提示条与滚动不各判一份）：
  //   ① 用户已在顶端（正看着最新）⇒ 跟进到顶端，不打扰；
  //   ② 否则**保住他正在读的那一段**——前插行会把内容整体下推，故按 scrollHeight 增量补回滚动位，
  //      只出一条「↑ N 条新消息」，点击才回去。
  //   计数按 **seq**（不是条数）：条数会随筛选/分页变化，seq 才真的只受"新到"影响。
  useEffect(() => {
    const maxSeq = () => convs.reduce((m, c) => Math.max(m, Number(c.seq) || 0), 0);
    const el = convScrollRef.current;
    const fresh = convs.filter(c => (Number(c.seq) || 0) > seenMaxSeqRef.current).length;
    seenMaxSeqRef.current = maxSeq();
    if (!el) return;
    const grew = el.scrollHeight - prevScrollHRef.current;
    prevScrollHRef.current = el.scrollHeight;
    if (atTopRef.current) { el.scrollTop = 0; setNewOnTop(0); }
    else { if (grew > 0) el.scrollTop += grew; if (fresh > 0) setNewOnTop(n => n + fresh); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convs]);
  // zx_20260913 M1-6(苏轼「不识庐山」/佛学·无常): 事件会丢, 界面不能把"没收到事件"当成"没有变化"。
  //   低频自愈(30s)——**仅页面可见时**轮询(后台空转无意义)；转回可见时立刻补一次。
  // zx_20260920 M3-a(庄子·得鱼忘筌): 自愈须覆盖**正在看的那一屏**——此前只自愈渠道列表，
  //   而用户眼睛盯着的恰恰是对话；"打开着对话页等一条回复"时那条默认路（事件）一丢就永远等不到。
  //   走 `prependNewConvs`（只前插 + 同 id 就地翻正），不重置已翻出的旧页与滚动位。
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      void refreshChannels();
      const cid = convChannelRef.current;
      if (cid) void prependNewConvs(cid);
    };
    const timer = setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // zx_20260911_5 M2-2(如实): 关键操作失败不再静默——保存/启停/删除/二维码/对话/诊断统一写页面级 error,
  // 成功则清空。复用既有 error state 与样式(奥卡姆: 不新增 toast 框架)。
  async function handleSave() {
    setError(''); setUiBusy(s=>new Set(s).add('save'));
    try {
      const { name, channel_type, ...cfgFields } = form;
      const config = Object.fromEntries(Object.entries(cfgFields).filter(([,v]) => v));
      if (editing) {
        await im.updateChannel(editing.id, { name: name || channel_type, config: JSON.stringify(config) });
      } else {
        await im.createChannel(channel_type, name || channel_type, config);
      }
      setShowCreate(false); setEditing(null);
      setForm({channel_type:'wechat-personal',name:''});
      // M1-1: 保存后静默刷新——带着整页 spinner 重载会把正在看的对话/补发账面板整个卸载。
      await refreshChannels();
    } catch(e) { setError(`${editing?'保存':'添加'}渠道失败：${(e as Error).message || e}`); }
    finally { setUiBusy(s=>{const n=new Set(s);n.delete('save');return n;}); }
  }
  function openEdit(ch: Channel) {
    const cfg = (() => { try { return JSON.parse(ch.config || '{}'); } catch { return {}; } })();
    setEditing(ch);
    setForm({ channel_type: ch.channel_type, name: ch.name || '', ...Object.fromEntries(Object.entries(cfg).map(([k,v]) => [k, String(v)])) });
    setShowCreate(true);
  }
  async function handleStart(id: string) {
    setError(''); setBusyChannels(s=>new Set(s).add(id));
    try { await im.startChannel(id); await refreshChannels(); setStatusDetail(p=>({...p,[id]:''})); }
    catch(e){ setError(`启动渠道失败：${(e as Error).message || e}`); }
    finally { setBusyChannels(s=>{const n=new Set(s);n.delete(id);return n;}); }
  }
  async function handleStop(id: string) {
    setError(''); setBusyChannels(s=>new Set(s).add(id));
    try { await im.stopChannel(id); await refreshChannels(); setStatusDetail(p=>({...p,[id]:''})); }
    catch(e){ setError(`停止渠道失败：${(e as Error).message || e}`); }
    finally { setBusyChannels(s=>{const n=new Set(s);n.delete(id);return n;}); }
  }
  async function handleDelete(id: string) { if (!confirm('确定删除？')) return; setError(''); try { await im.deleteChannel(id); await refreshChannels(); } catch(e){ setError(`删除渠道失败：${(e as Error).message || e}`); } }
  /** M1-1/M1-2: 「刷新」钮——走**静默刷新**(已存在), 并带自己的在途态(不混用 busyChannels)。 */
  async function handleRefreshClick() {
    if (uiBusy.has('refresh')) return;
    setError(''); setUiBusy(s=>new Set(s).add('refresh'));
    try { await refreshChannels(); } finally { setUiBusy(s=>{const n=new Set(s);n.delete('refresh');return n;}); }
  }
  // zx_20260911_5 M2-4(海德格尔·上手状态): 二维码弹窗不卡死——
  //  · 无码/过期/失败/不支持时在弹窗内如实说明(不再以"加载中..."冒充);
  //  · 过期或失败终态 → 如实收口(清轮询 + 关弹窗), 不留悬窗;
  //  · 8 分钟硬上限同样收口; 关闭按钮/遮罩点击也会清轮询(旧实现只在登录成功时清, 手动关闭会漏)。
  function closeQr() {
    if (qrTimerRef.current) { clearInterval(qrTimerRef.current); qrTimerRef.current = null; }
    if (qrHardStopRef.current) { clearTimeout(qrHardStopRef.current); qrHardStopRef.current = null; }
    setQrChannel(null);
  }
  async function showQr(ch: Channel) {
    closeQr(); setQrMsg(null); setError('');
    try {
      const r = await invoke<{qrcode_img?:string;status?:string}>('im:getQr',ch.id) as unknown as {qrcode_img?:string;status?:string};
      if (!r?.qrcode_img) {
        const st = r?.status;
        setQrMsg({ ok:false, text: st==='expired' ? '二维码已过期，请关闭后重新获取。'
          : st==='error' ? '获取二维码失败，请检查渠道配置后重试。'
          : st==='unsupported' ? '该渠道不支持扫码登录。'
          : '未取到二维码，请稍后重试。' });
        setQrChannel({id:ch.id,name:ch.name||ch.channel_type,img:''});
        return;
      }
      setQrChannel({id:ch.id,name:ch.name||ch.channel_type,img:r.qrcode_img});
      // zx_20260912 M2-1(海德格尔·在场): 扫码结果以 channel.status_changed 事件为主（见上方事件处理）。
      // 本轮询降为**兜底**（5s）：事件丢失/适配器无上报时仍能收口，不再靠它当主通道。
      const timer=setInterval(async()=>{
        try {
          const list=await im.channels() as unknown as Channel[];
          const cur=list.find(c=>c.id===ch.id);
          // G8: 兜底轮询与事件处理同尺（同一 qrClose）——此前这里多认一个 'active'，两处清单不一致。
          if(cur&&statusMeta(cur.status).qrClose==='ok'){ closeQr(); setChannels(list); return; }
          const q = await invoke<{status?:string}>('im:getQr',ch.id) as unknown as {status?:string};
          if (q?.status==='expired' || q?.status==='error') {
            closeQr();
            setError(q.status==='expired' ? '二维码已过期，请重新获取。' : '二维码获取失败，请检查渠道配置后重试。');
          }
        } catch(e){ closeQr(); setError(`二维码状态刷新失败：${(e as Error).message || e}`); }
      },5000);
      qrTimerRef.current = timer;
      qrHardStopRef.current = setTimeout(()=>{ closeQr(); setError('二维码长时间未扫描，已自动关闭，请重新获取。'); }, 8*60*1000);
    } catch(e) { setError(`获取二维码失败：${(e as Error).message || e}`); }
  }
  // M2-3: 首次/刷新取最新一页(替换); 「加载更多」按 rowid 游标追加(不整体替换, 滚动位置不跳)。
  async function showConvs(channelId: string) {
    setConvChannel(channelId); setResendMsg(null); setError('');
    // zx_20260914 M1-4: 换渠道即清**草稿与反馈**——草稿留着会发错人。
    // zx_20261002 M3: 选定与列表也一并归零——否则切渠道后旧列表还在屏上，回话对象会**短暂显示成上一个渠道的人**。
    setSendMsg(null); setSendText(''); setCopyTip('');
    setConvs([]); setReplyPeer(null);
    // zx_20260914 M1-3: 整页换过（筛选/换渠道）⇒ 滚动与记账全部归零，从顶端重新做人。
    setNewOnTop(0); atTopRef.current = true; prevScrollHRef.current = 0; seenMaxSeqRef.current = 0;
    setConvLoading(true);
    // zx_20261002 M3: 载入后把**当时的最新一条**快照为回话默认对象——它是**显式绑定**（此后入站前插不再改它），
    //   不再是每渲染现取的 `convs[0]`（那是"随列表漂"的病根）。用户可用每行的「回话」改为指定对象。
    try { const d=await im.conversations(channelId, { offset: 0, ...convFilter() }) as unknown as Conversation[]; const list=Array.isArray(d)?d:[]; setConvs(list); setConvHasMore(list.length>=CONV_PAGE); setReplyPeer(list[0]?.external_user_id || null); } catch(e){ setError(`读取对话失败：${(e as Error).message || e}`); }
    finally { setConvLoading(false); }
    // zx_20261002 M2: 打开**该渠道**的对话 ⇒ 只清该渠道未读（此前无参 = 全局清零，连别的渠道一并抹平）。
    void im.markRead(channelId).then(() => refreshUnreadByChannel()).catch(() => {});
  }
  async function loadMoreConvs() {
    if (!convChannel || convLoadingMore) return;
    // zx_20260912 M2-4: 以「已加载最旧行的 seq」为界——新插入不动它，故不重不漏（offset 会随插入整体位移）。
    const oldestSeq = convs.length > 0 ? convs[convs.length - 1]!.seq : undefined;
    if (oldestSeq === undefined) return;
    setConvLoadingMore(true); setError('');
    try {
      const d=await im.conversations(convChannel, { beforeSeq: oldestSeq, ...convFilter() }) as unknown as Conversation[]; const list=Array.isArray(d)?d:[];
      setConvs(prev=>[...prev, ...list]); setConvHasMore(list.length>=CONV_PAGE);
    } catch(e){ setError(`加载更多对话失败：${(e as Error).message || e}`); }
    finally { setConvLoadingMore(false); }
  }
  /** zx_20260912 M2-4: 实时入站只前插新行（seq 大于当前最大者），保留用户已翻出的旧页——
   *  此前每次入站都 showConvs 重置回最新 50 条，翻页进度与滚动位置一并丢失。
   *  zx_20260913 M1-4/M1-5: ① 取数与筛选同尺(ref 读当前筛选, 避免事件闭包读陈旧值)；
   *  ② **同 id 就地更新**——补发成功后该行由 failed 翻回 sent，行内容须跟着刷新(否则界面永停"未送达")。
   *  zx_20260930 M2(维特根斯坦·意义即使用): 返回值由"取数成没成"改成"**刚发的那一行在不在这一屏里**"。
   *    取数成功 ≠ 行到场：旧写法（`return true`）让乐观气泡在真行还没露面时就退场，用户在
   *    "库里有、屏上没有"的空档里看到自己的话**凭空消失**——那是"看不见就是丢了"的同一形状的假话。
   *    故 `expect`（手发的两条路都传）在场时按 `outbound + seq 更新 + 正文同串` 认那一行；
   *    `expect` 缺省（入站事件 / 30s 自愈轮询）不校验，只看取数成没成。 */
  async function prependNewConvs(channelId: string, expect?: { text: string; afterSeq: number }): Promise<{ ok: boolean; landed: boolean }> {
    try {
      const d = await im.conversations(channelId, { offset: 0, q: convQRef.current.trim() || undefined, direction: convDirRef.current || undefined }) as unknown as Conversation[];
      const list = Array.isArray(d) ? d : [];
      setConvs(prev => {
        if (prev.length === 0) return list;
        const incoming = new Map(list.map(c => [c.id, c]));
        const updated = prev.map(c => incoming.has(c.id) ? { ...c, ...incoming.get(c.id)! } : c);
        const maxSeq = Math.max(...prev.map(c => Number(c.seq) || 0));
        const fresh = list.filter(c => (Number(c.seq) || 0) > maxSeq);
        return [...fresh, ...updated];
      });
      // 判**服务端返回的这一页**（不是合并后的 prev——那里可能还留着上一轮的行，会把"没到"读成"到了"）。
      const landed = !expect || list.some(c =>
        c.direction === 'outbound'
        && (Number(c.seq) || 0) > expect.afterSeq
        && jsonTextOf(c.message_json) === expect.text);
      return { ok: true, landed };
    } catch (e) { setError(`实时刷新对话失败：${(e as Error).message || e}`); return { ok: false, landed: false }; }
  }
  /** zx_20260930 M2(海德格尔·上手状态): 出站事件的**短窗重取**。
   *  事件与"行落盘"是两条路（发出方 emit 的时机不保证晚于 INSERT），故"取一次就够"是**假设**而不是事实。
   *  立即取一次，再隔 ~0.8s 各补一次（两档即停）；之后仍交回 30s 自愈轮询兜底（事件仍可能整个丢掉）。
   *  只对**正看着的**渠道重取；新出站事件到来即重启窗口（`outboundGenRef` 代际作废旧链，不叠加请求）。 */
  function refetchOutboundSoon(channelId: string) {
    const gen = ++outboundGenRef.current;
    const step = (i: number) => {
      if (outboundGenRef.current !== gen) return;           // 更新的出站事件已重启窗口
      if (convChannelRef.current !== channelId) return;     // 用户已切走 — 别把请求打给已经离开的那一屏
      if (document.visibilityState !== 'visible') return;   // 后台空转无意义（与 30s 自愈轮询同一口径）
      void prependNewConvs(channelId);
      if (i < 2) setTimeout(() => step(i + 1), 800);
    };
    step(0);
  }
  async function handleDiagnose(id: string) { setError(''); setDiagnosing(d=>new Set(d).add(id)); try { const r=await invoke('im:diagnose',id) as unknown as Array<{check:string;pass:boolean;detail:string}>; setDiagResults(d=>({...d,[id]:r||[]})); } catch(e){ setError(`诊断失败：${(e as Error).message || e}`); } finally { setDiagnosing(d=>{const n=new Set(d);n.delete(id);return n;}); } }
  async function handleResend(convId: string) {
    setResending(s=>new Set(s).add(convId));
    // zx_20260911_2 M2(如实): 重发成功/失败如实回报——失败不再静默假装已送达; 微信无上下文 token 时附配额提示。
    try {
      const r = await invoke<{resent?:boolean;note?:string}>('im:resend',convId);
      setResendMsg({ ok:true, text: r?.note ? `已重发。${r.note}` : '已重发。' });
    } catch(e) {
      setResendMsg({ ok:false, text: (e as Error).message || '重发失败' });
    } finally { setResending(s=>{const n=new Set(s);n.delete(convId);return n;}); }
  }
  /** zx_20260914 M1-4(庄子·得鱼忘筌): **手工回话**——界面第一次能自己说一句。
   *  收件人 = 当前列表最新一条的用户（不猜、也不给裸 id 输入口）；发送**只清输入框**，搜索与筛选原样；
   *  失败按真因上屏（main 侧 `SEND_FAILED` 的 message 本就是适配器的原文），不吞成"发送失败"三个字。 */
  async function handleSend() {
    // zx_20261002 M3: 收件人**显式选定优先**（`resolveReplyPeer` 一处判）——不再是"每渲染现取的列表最新一条"。
    const peer = resolveReplyPeer(replyPeer, convs).peer;
    const body = sendText.trim();
    if (!convChannel || !peer || !body || uiBusy.has('im-send')) return;
    // zx_20260920 M3-b(乐观气泡 / 海德格尔·在场): "我按下去了"这件事不能等一个来回才上屏。
    //   此前失败时**屏上什么都不出现**——真行其实已由 main 落在库里（`manual-send` 走 enqueueImOutbox），
    //   只是界面没去取，用户读到的是"我发的这句话没了"。占位气泡先顶上，再由真行把它换下去。
    const key = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const afterSeq = convs.reduce((m, c) => Math.max(m, Number(c.seq) || 0), 0);
    setOptimistic(p => [...p, { key, channelId: convChannel, externalUserId: peer, text: body, at: new Date().toISOString() }]);
    setSendText(''); setSendMsg(null); setUiBusy(s=>new Set(s).add('im-send'));
    let failure = '';
    try {
      const r = await im.send(convChannel, peer, body);
      setSendMsg({ ok:true, text: r?.note ? `已发送。${r.note}` : '已发送。' });
    } catch(e) { failure = (e as Error).message || '发送失败'; setSendMsg({ ok:false, text: failure }); }
    finally { setUiBusy(s=>{const n=new Set(s);n.delete('im-send');return n;}); }
    // 无论成败都取一次真行：成功由适配器落、失败由补发账落——**都是"事本身的行"**，界面只负责取回它。
    // zx_20260930 M2: 退场条件是**那一行真的在返回集里**（不是"取数没报错"）。
    const { ok, landed } = await prependNewConvs(convChannel, { text: body, afterSeq });
    setOptimistic(p => landed
      ? p.filter(o => o.key !== key)                                     // 真行到场，占位退场
      // 真行没到场 ⇒ 把话留在屏上，并**分清**"没送达"与"发出了但这一屏没取到"（两种话分开说）。
      : p.map(o => o.key === key
          ? { ...o, sent: !failure, failed: failure || (ok ? '已发出，但这一屏还没取到它（可能被当前筛选挡住）' : '界面未能同步') }
          : o));
  }
  /** zx_20260930 M1(维特根斯坦·意义即使用 / 海德格尔·上手状态): 手工**发件**——与 `handleSend` 同形同尺。
   *  件从系统选择器取（`openFileDialog` 是 preload 既有出口，渲染层不自己拼 Electron API）；
   *  「用户取消」是**一次取舍**、不是失败——屏上不留红字（与 `im:mediaSave` 的取消同一口径）。
   *  通道发不了件时**按钮已禁用**，这里再挡一次是防守：`convCap.media` 是"本通道发不了件"的唯一判据。 */
  async function handlePickMedia() {
    // zx_20261002 M3: 同 `handleSend`——发件也发给**选定对象**，不随列表漂。
    const peer = resolveReplyPeer(replyPeer, convs).peer;
    if (!convChannel || !peer || uiBusy.has('im-media') || !convCap.media) return;
    setSendMsg(null);
    const api = window.electronAPI;
    if (!api?.openFileDialog) { setSendMsg({ ok: false, text: '当前环境不支持文件选择（未运行在桌面端）' }); return; }
    let filePath: string | null = null;
    try { filePath = await api.openFileDialog(); }
    catch (e) { setSendMsg({ ok: false, text: `选择文件失败：${(e as Error).message || e}` }); return; }
    if (!filePath) return;                                  // 取消：既不报错，也不留一行"没成功"的灰字
    const name = baseNameOf(filePath);
    const key = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const afterSeq = convs.reduce((m, c) => Math.max(m, Number(c.seq) || 0), 0);
    // zx_20261003 M13: 占位也出**件控件**（与真行到场后同一个 `ImMediaBubble`）——此前只显 `📎 名`，
    //   落定后又突然变成件气泡，屏上"跳一下"。判定仍由 `imMediaOf` 一处出；`text` 仍是 `📎 名`
    //   （与落定退场判据 `prependNewConvs` 的 `expect.text` 同一串），两处口径不得分叉。
    const media = imMediaOf(JSON.stringify({ media: { path: filePath, name } })) || undefined;
    setOptimistic(p => [...p, { key, channelId: convChannel, externalUserId: peer, text: `📎 ${name}`, media, at: new Date().toISOString() }]);
    setUiBusy(s => new Set(s).add('im-media'));
    let failure = '';
    try {
      await im.sendMedia(convChannel, peer, filePath);
      setSendMsg({ ok: true, text: `已发出「${name}」。` });
    } catch (e) { failure = (e as Error).message || '发件失败'; setSendMsg({ ok: false, text: failure }); }
    finally { setUiBusy(s => { const n = new Set(s); n.delete('im-media'); return n; }); }
    // 与 `handleSend` 同尺：真行（成/败都有一行）到场才退场；那一行的正文＝`📎 件名`（`entryPreview` 同一串）。
    const { ok, landed } = await prependNewConvs(convChannel, { text: `📎 ${name}`, afterSeq });
    setOptimistic(p => landed
      ? p.filter(o => o.key !== key)
      : p.map(o => o.key === key
          ? { ...o, sent: !failure, failed: failure || (ok ? '已发出，但这一屏还没取到它（可能被当前筛选挡住）' : '界面未能同步') }
          : o));
  }
  /** Enter 发送 / Shift+Enter 换行。**中文输入法组字中不误发**（`isComposing`）——否则选词回车即发出去半句话。 */
  function handleSendKey(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault(); void handleSend();
  }
  /** zx_20260914 M1-4: 复制**文本正文**——失败如实说清，不假装已复制。 */
  async function handleCopy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopyTip('已复制'); }
    catch { setCopyTip('复制失败：当前环境不允许写剪贴板'); }
    window.setTimeout(() => setCopyTip(''), 2000);
  }
  function backToTop() { setNewOnTop(0); if (convScrollRef.current) convScrollRef.current.scrollTop = 0; }

  // zx_20260930 M4-3(一处真源): 分组与"共几条"**一律以统计口径为准**（main 的 `byStatus` = 一次 `GROUP BY status`）。
  //   统计取不到时（IPC 出错）退用"已列出的行"自算——那是**降级但如实**的口径（宁可说"我手上只有这些"，
  //   也不拿明细行数冒充全量）。
  const outboxCounts = outbox.byStatus && Object.keys(outbox.byStatus).length
    ? outbox.byStatus
    : outboxRows.reduce<Record<string,number>>((a,r)=>{a[r.status]=(a[r.status]||0)+1;return a;},{});
  // 组**成员**由统计定（未知态照样出场——新态若只排在已知次序表之外，行在账里、在页上整段不显示）；
  // 次序由 `OUTBOX_GROUP_ORDER` 定，其余按统计里的出现次序补在其后。
  const outboxGroupKeys = Array.from(new Set([...OUTBOX_GROUP_ORDER, ...Object.keys(outboxCounts)])).filter(g=>(outboxCounts[g]||0)>0);
  const outboxTotal = Object.values(outboxCounts).reduce((a,b)=>a+b,0);
  // 还有没有下一页：统计说还剩（已列 < 共几条），或末页恰好取满（暗示后面可能还有）。
  const outboxHasMore = !outboxExhausted && (outboxRows.length < outboxTotal || outboxRows.length >= OUTBOX_PAGE);


  /** 收件人：**显式选定优先**，未选时取列表最新一条（`listConversations` 是 rowid DESC ⇒ `convs[0]` 即最新）。
   *  zx_20261002 M3: 判定收在 `resolveReplyPeer` 一处——筛选取数变、入站前插都不再顶替已选定的人。 */
  const peerView = resolveReplyPeer(replyPeer, convs);
  const convPeer = peerView.peer;
  const peerNotice = replyPeerNotice(peerView);
  // zx_20260930 M1(一处真源): 附件钮点不点得动，只问能力表这一处——`media` 定禁用、`note` 作 title，
  //   界面**不另写**一句同义文案（同义句在源码里出现即被 rr 判红）。
  const convCap = channelCapabilities(channels.find(c => c.id === convChannel)?.channel_type || '');

  const typeLabel = (t: string) => ({'wechat-personal':'微信个人号',qqbot:'QQ',feishu:'飞书',dingtalk:'钉钉',wecom:'企业微信'} as Record<string,string>)[t]||t;

  if (loading) return <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full"/></div>;
  return (
    <div>
      <div className="flex items-center justify-between mb-6"><h2 className="text-xl font-bold">IM 渠道管理</h2><div className="flex items-center gap-2"><button onClick={handleRefreshClick} disabled={uiBusy.has('refresh')} title="刷新（静默：不打断正在看的对话与补发账）" className="p-2 hover:bg-gray-100 rounded-lg disabled:opacity-50">{uiBusy.has('refresh')?<Loader2 className="w-4 h-4 animate-spin"/>:<RefreshCw className="w-4 h-4"/>}</button><button onClick={()=>setShowCreate(true)} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"><Plus className="w-4 h-4"/>添加渠道</button></div></div>
      {error&&<p className="text-red-500 text-sm mb-4">{error}</p>}

      {/* zx_20260911_5 M1(得鱼忘筌/王阳明·知行合一): 出站补发账——关键通知(完成/失败/介入/长进度)发送失败落此账短窗补发。
          四态穷尽(含等条件恢复的 blocked_quota / other 兜底); 「查看明细」把汇总翻回逐条, 并对未送达行提供「补发」。 */}
      {(outbox.pending>0||outbox.blocked_quota>0||outbox.dead>0||outbox.other>0)&&<div className={`mb-4 rounded-lg text-sm border ${outbox.dead>0||outbox.other>0?'bg-red-50 text-red-700 border-red-200':'bg-amber-50 text-amber-700 border-amber-200'}`}>
        <div className="p-3 flex items-center flex-wrap gap-x-2 gap-y-1">
          <span>{outbox.dead>0||outbox.other>0?'⚠️ ':'⏳ '}出站补发账：待补发 {outbox.pending} 条{outbox.blocked_quota>0?`，等待条件恢复 ${outbox.blocked_quota} 条`:''}，已送达 {outbox.sent} 条{outbox.dead>0?`，最终未送达 ${outbox.dead} 条`:''}{outbox.other>0?`，其它状态 ${outbox.other} 条（展开明细可见分组）`:''}</span>
          <button onClick={toggleOutbox} className="underline hover:no-underline">{outboxOpen?'收起明细':'查看明细'}</button>
          <button onClick={()=>{void loadOutbox(); if(outboxOpen) void loadOutboxRows();}} className="underline hover:no-underline">刷新</button>
        </div>
        {outboxOpen&&<div className="border-t border-current/20 px-3 py-2 max-h-96 overflow-y-auto">
          {outboxMsg&&<p className={`mb-2 text-xs ${outboxMsg.ok?'text-green-700':'text-red-700'}`}>{outboxMsg.ok?'✅':'❌'} {outboxMsg.text}</p>}
          {/* M8: 分组表与 `OUTBOX_GROUP_LABEL` 同尺——新态漏在这张表里，行就整段不显示(账翻不开)。
              M4-3: 组**成员**改由统计（`outboxGroupKeys`）定，不再由这张次序表筛；每组标题写
              「显示 K / 共 M」——M 是全量口径，故"还有几条没取到"不必让用户自己按剩余行数去猜。 */}
          {outboxGroupKeys.length===0?<p className="text-xs opacity-70 py-2">暂无补发账记录。</p>:outboxGroupKeys.map(g=>{
            const rows=outboxRows.filter(r=>r.status===g);
            const tot=outboxCounts[g]||rows.length;
            return <div key={g} className="mb-3 last:mb-0">
              <p className="text-xs font-semibold mb-1">{OUTBOX_GROUP_LABEL[g]||g}（{rows.length<tot?`显示 ${rows.length} / 共 ${tot}`:tot}）</p>
              {rows.length===0&&<p className="text-xs opacity-60">该状态的记录尚未取到，点下方「加载更多」。</p>}
              <div className="space-y-1.5">
                {rows.map(r=><div key={r.id} className="bg-white/70 rounded p-2 text-xs">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    {/* M1-3: 用户标识不裸奔 openid——短 handle + title 带全值；渠道名缺失也不显示裸 uuid。 */}
                    <span className="opacity-80">{formatDbTime(r.created_at)} ·<span title={r.channel_id?`渠道 ID：${r.channel_id}`:''}>{r.channel_name||'渠道未知'}</span> · <span title={r.external_user_id?`用户：${r.external_user_id}`:''}>{userLabel(r.external_user_id)}</span> · {OUTBOX_KIND_LABEL[r.kind]||r.kind} · 尝试 {r.attempts} 次</span>
                    {/* zx_20260924_1 M8(V-10 用户裁定「禁用并给 title 说明」): 本通道发不了件的媒体行，
                        补发钮**置灰但仍在**——用户有权知道它为什么点不动，藏起来就成了"这页什么也没说"。
                        理由串取自 main 侧派生的 `media_unsupported_reason`（真源在能力表），此处不另写一句。 */}
                    {r.status!=='sent'&&<button onClick={()=>handleOutboxRetry(r.id)} disabled={outboxBusy.has(r.id)||r.media_unsupported} title={r.media_unsupported?`补发钮已置灰：${r.media_unsupported_reason}（本渠道没有发件能力，重试多少次都不会送达；请改用支持发件的渠道）`:'手动补发：计入当日推送配额；失败按 1/2/4 分钟退避、满 3 次转「最终未送达」'} className="shrink-0 px-2 py-0.5 rounded border border-current/30 hover:bg-white disabled:opacity-50">{outboxBusy.has(r.id)?'补发中…':'补发'}</button>}
                  </div>
                  {/* zx_20260912 M3(管子·度量衡): 「未送达」必须答得出「为什么」——逐条显示真原因，无则如实说无。 */}
                  {r.status!=='sent'&&<p className="mt-1 break-words"><span className="opacity-70">失败原因：</span>{outboxReason(r)}</p>}
                  {/* zx_20260913 M1-5(上手状态): 已声明却从未渲染的 `next_retry_at` 现在如实显示——"什么时候会再试"是用户等得下去的关键。 */}
                  {r.status==='pending'&&r.next_retry_at&&<p className="opacity-60 mt-0.5">下次重试：{new Date(r.next_retry_at).toLocaleTimeString('zh-CN',{hour12:false}).slice(0,5)}</p>}
                  {r.last_attempt_at&&<p className="opacity-60 mt-0.5">最近尝试：{formatDbTime(r.last_attempt_at)}</p>}
                  {r.task_title&&<p className="opacity-70 mt-0.5 truncate">任务：{r.task_title}</p>}
                  <p className="text-gray-700 whitespace-pre-wrap break-words mt-1 max-h-40 overflow-y-auto">{r.message}</p>
                </div>)}
              </div>
            </div>;
          })}
          {/* M4-3: 全账口径的**如实**交代 + 翻页入口——"横幅说 300 条、明细只列 200 行"这件事，
              此前在界面上**没有任何一句话**；现在数得到的就取得到（点到底为止）。 */}
          {outboxGroupKeys.length>0&&<div className="pt-1 mt-1 border-t border-current/10 flex items-center justify-between gap-2">
            <span className="text-xs opacity-70">已显示 {outboxRows.length} / 共 {outboxTotal} 条</span>
            {outboxHasMore&&<button onClick={()=>void loadMoreOutboxRows()} disabled={outboxMoreBusy} className="text-xs px-2 py-0.5 rounded border border-current/30 hover:bg-white disabled:opacity-50">{outboxMoreBusy?'加载中…':'加载更多'}</button>}
          </div>}
        </div>}
      </div>}

      {channels.length===0?<div className="bg-white rounded-lg border p-12 text-center text-gray-400"><MessageSquare className="w-12 h-12 mx-auto mb-3 opacity-30"/><p className="text-lg mb-2">暂无 IM 渠道</p></div>:<div className="space-y-3">{channels.map(ch=>{const sm=statusMeta(ch.status);const cfgSum=configSummary(ch.channel_type,ch.config);const un=unreadByChannel[ch.id]||0;return(<div key={ch.id} className="bg-white rounded-lg border p-4"><div className="flex items-center justify-between"><div><div className="flex items-center gap-2 mb-1"><h3 className="font-semibold">{ch.name||typeLabel(ch.channel_type)}</h3>{/* zx_20261003 M12: 逐渠道未读红点——数来自 main（`im.unreadByChannel`），界面不自算。 */}{un>0&&<span className="px-1.5 py-0.5 rounded-full bg-red-500 text-white text-xs leading-none" title={`${un} 条未读`}>{un>99?'99+':un}</span>}<span className="text-xs text-gray-400">{typeLabel(ch.channel_type)}</span>{ch.channel_type==='wecom'&&<span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700" title="企业微信无入站通道：能发出通知，收不到用户回复">仅出站</span>}<span className={`text-xs px-1.5 py-0.5 rounded-full ${sm.cls}`}>{sm.label}</span></div>{/* M1-3(庄子·得鱼忘筌): 不再裸奔 uuid——显示渠道名/类型之外只给**非密钥**配置摘要；原 id 移入 title(悬停可看)。 */}<p className="text-xs text-gray-400 font-mono select-all" title={`渠道 ID：${ch.id}`}>{cfgSum||(ch.channel_type==='wechat-personal'?'扫码登录（无附加配置）':'—')}</p>{statusDetail[ch.id]&&<p className={`text-xs mt-0.5 ${sm.alarm?'text-orange-600':'text-gray-500'}`}>{statusDetail[ch.id]}</p>}</div><div className="flex items-center gap-1">
        {ch.channel_type==='wechat-personal'&&<button onClick={()=>showQr(ch)} className="p-1.5 hover:bg-blue-50 rounded" title="二维码"><QrCode className="w-4 h-4 text-blue-500"/></button>}
        <button onClick={()=>showConvs(ch.id)} className="p-1.5 hover:bg-gray-100 rounded" title="对话"><MessageSquare className="w-4 h-4 text-gray-400"/></button>
        <button onClick={()=>handleDiagnose(ch.id)} className="p-1.5 hover:bg-purple-50 rounded" title="诊断">{diagnosing.has(ch.id)?<Loader2 className="w-4 h-4 text-purple-500 animate-spin"/>:<Stethoscope className="w-4 h-4 text-purple-500"/>}</button>
        <button onClick={() => openEdit(ch)} className="p-1.5 hover:bg-gray-100 rounded" title="编辑"><Edit className="w-4 h-4 text-gray-400"/></button>
        {sm.start&&<button onClick={()=>handleStart(ch.id)} disabled={busyChannels.has(ch.id)} className="p-1.5 hover:bg-green-50 rounded disabled:opacity-50" title={sm.start}>{busyChannels.has(ch.id)?<Loader2 className="w-4 h-4 text-green-600 animate-spin"/>:<Play className="w-4 h-4 text-green-600"/>}</button>}
        {sm.stop&&<button onClick={()=>handleStop(ch.id)} disabled={busyChannels.has(ch.id)} className="p-1.5 hover:bg-orange-50 rounded disabled:opacity-50">{busyChannels.has(ch.id)?<Loader2 className="w-4 h-4 text-orange-600 animate-spin"/>:<Square className="w-4 h-4 text-orange-600"/>}</button>}
        <button onClick={()=>handleDelete(ch.id)} className="p-1.5 hover:bg-red-50 rounded"><Trash2 className="w-4 h-4 text-red-500"/></button>
      </div></div>
      {/* 诊断结果 */}
      {diagResults[ch.id]&&<div className="mt-3 p-3 bg-gray-50 rounded-lg space-y-1">{diagResults[ch.id]!.map((r,i)=>(<div key={i} className={`text-xs ${r.pass?'text-green-700':'text-red-600'}`}>{r.pass?'✅':'❌'} {r.check}: {r.detail}</div>))}</div>}
      </div>);})}</div>}

      {/* 对话面板 */}
      {convChannel && <div className="mt-6 bg-white rounded-lg border p-4"><div className="flex items-center justify-between mb-3"><h3 className="font-semibold text-sm">最近对话{/* zx_20261002 M4: 会话流恒为**倒序**（`rowid DESC` ⇒ 最新在上）——用户从「新消息提示条」的箭头方向看不出这条约定，故**显式标注**，不再让方向靠猜。 */}
<span className="ml-2 font-normal text-gray-400 text-xs" title="会话按时间倒序：最新一条在最上，往下是更早的">最新在上 · 往下更早</span></h3><button onClick={()=>{setConvChannel(null);setConvs([]);setReplyPeer(null);setResendMsg(null);setConvQ('');setConvDirection('');}} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4"/></button></div>{/* zx_20260913 M1-5(上手状态): 搜索 + 方向筛选——服务端过滤(与游标同 WHERE), 7004 条里找一条。 */}<div className="flex items-center gap-2 mb-3"><input value={convQ} onChange={e=>setConvQ(e.target.value)} placeholder="搜索消息内容…" className="flex-1 px-3 py-1.5 border rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"/><select value={convDirection} onChange={e=>setConvDirection(e.target.value as ''|'inbound'|'outbound')} className="px-2 py-1.5 border rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"><option value="">全部方向</option><option value="inbound">仅收到</option><option value="outbound">仅发送</option></select></div>{resendMsg&&<p className={`text-xs mb-2 ${resendMsg.ok?'text-green-700':'text-red-600'}`}>{resendMsg.ok?'✅':'❌'} {resendMsg.text}</p>}{copyTip&&<p className="text-xs mb-2 text-gray-500">{copyTip}</p>}{/* zx_20260914 M1-3(海德格尔·在场·不打断): 新消息提示条——只提示、不抢位置，点击才回到最新。 */}{newOnTop>0&&<button onClick={backToTop} className="w-full mb-2 py-1 rounded-lg bg-blue-50 text-blue-700 text-xs hover:bg-blue-100">↑ {newOnTop} 条新消息 · 点击回到最新</button>}{/* M1-3: 固定高度（加入输入框后不再随消息数伸缩）；滚动位置由上方 effect 统一决定 */}<div ref={convScrollRef} onScroll={e=>{atTopRef.current = e.currentTarget.scrollTop<=24;}} className="space-y-2 h-[55vh] min-h-[20rem] overflow-y-auto">{/* zx_20260920 M3-b: 已按下发送、真行未回的那几条——**不属于任何一天**，故排在按日分组之外（也不进 seq 账）。 */}{optimistic.filter(o=>o.channelId===convChannel).map(o=>(<div key={o.key} className={`p-2 rounded text-sm ${o.failed?(o.sent?'bg-amber-50':'bg-red-50'):'bg-gray-50'}`}><div className="flex items-center justify-between mb-0.5"><p className="text-xs text-gray-400">→ 发送 · <span title={`用户：${o.externalUserId}`}>{userLabel(o.externalUserId)}</span> · {formatDbTime(o.at)}{/* zx_20260930 M2: 两种话分开说——"没送达"与"发出了但这屏还没取到"不是一件事，混说就是假话。 */}{o.failed?<span className={o.sent?'text-amber-600':'text-red-600'}> · {o.sent?'已发出，真行未见':'未送达'} · {o.failed}（此条仅存于当前页面）</span>:<span className="text-amber-600"> · 发送中…</span>}</p></div>{o.media?<ImMediaBubble media={o.media} onNotice={(t,ok)=>setSendMsg({ok,text:t})}/>:<ClampText text={o.text} textClassName="text-gray-700" />}</div>))}{/* zx_20260920 M3-c: 打开会话的在途态——此前那段空档只能说「暂无对话」，一句在没数据时也为真的话，被读成"这渠道没消息"。 */}{convLoading&&convs.length===0?<p className="text-sm text-gray-400 text-center py-4">加载中…</p>:convs.length===0&&optimistic.filter(o=>o.channelId===convChannel).length===0?<p className="text-sm text-gray-400 text-center py-4">{convQ||convDirection?'没有符合条件的对话':'暂无对话'}</p>:(()=>{/* M1-5: 按自然日分组——分组不改条目总数, 只加小标题。 */const groups:Array<[string,Conversation[]]>=[];for(const c of convs){const l=dayLabel(c.created_at);const last=groups[groups.length-1];if(last&&last[0]===l)last[1].push(c);else groups.push([l,[c]]);}return groups.map(([label,items])=>(<div key={label}><p className="text-xs font-semibold text-gray-400 mb-1 mt-2 first:mt-0">{label}（{items.length}）</p>{items.map(c=>{/* zx_20260920 M3-d(海德格尔·上手状态): 在途态与送达态**一处判**（`convDeliveryOf`）——
   此前"正在补发"与"没人补发"长得一模一样，用户点完补发只能等；现在它有个看得见的形状（琥珀色「补发中…」），
   上次失败的原因移进 title，屏上不啰嗦。 */const busy=convBusyOf(c,{resending,retryingOutbox:outboxBusy});const dv=convDeliveryOf(c,busy);return (<div key={c.id} className={`p-2 rounded text-sm ${c.direction==='inbound'?'bg-blue-50':'bg-gray-50'}`}><div className="flex items-center justify-between mb-0.5"><p className="text-xs text-gray-400">{c.direction==='inbound'?'← 收到':'→ 发送'} · <span title={c.external_user_id?`用户：${c.external_user_id}`:''}>{userLabel(c.external_user_id)}</span> · {formatDbTime(c.created_at)}{dv&&<span className={DELIVERY_TONE_CLS[dv.tone]} title={dv.reason?`上次失败：${dv.reason}`:undefined}> · {dv.label}</span>}{/* zx_20260930 M2-c(维特根斯坦·意义即使用 / 一实一名): 「这句属于哪个任务」的小标牌。
   只在 main **真标了** `task_id` 的行上出现——空串=无归属，界面上就什么都不说（**不替它编一个**）；
   任务名取不到（已删/查无）时正文只说"属于任务"，完整 id 退进 title，不拿 id 冒充标题。 */}{c.task_id&&<span className="ml-1 px-1 rounded bg-gray-200 text-gray-600" title={`本条归属于任务：${c.task_title||c.task_id}`}>属于任务{c.task_title?`「${c.task_title}」`:''}</span>}</p><div className="flex items-center gap-1 shrink-0">{/* zx_20261002 M3: 每条会话都能**指定回话对象**——此前整页只有一个"发给最新一条"的口，想回某个稍旧对象无从下手。 */}
    {!!c.external_user_id&&<button onClick={()=>setReplyPeer(c.external_user_id)} disabled={(replyPeer||'')===c.external_user_id} className="text-gray-400 hover:text-blue-600 disabled:opacity-40 disabled:cursor-default" title={(replyPeer||'')===c.external_user_id?'当前回话对象就是此人':`回话给 ${userLabel(c.external_user_id)}`}><CornerUpLeft className="w-3 h-3"/></button>}
    {c.direction==='outbound'&&<button onClick={()=>{ if(c.status==='failed'&&c.outbox_id) void handleOutboxRetry(c.outbox_id); else void handleResend(c.id); }} disabled={busy!=='idle'} className="text-gray-400 hover:text-blue-600 disabled:opacity-50" title={busy!=='idle'?'正在处理这条消息…':c.status==='failed'?'补发这条未送达的消息（走补发账同一套语义）':c.status==='blocked_quota'?'重发（此前发送条件缺失未送达；条件恢复前仍会失败）':'重发'}>{busy!=='idle'?<Loader2 className="w-3 h-3 animate-spin"/>:<Send className="w-3 h-3"/>}</button>}</div></div>{(()=>{/* zx_20260914 M1-4(维特根斯坦·意义即使用): 渲染判定收进 `messageViewOf`（纯函数，rr 可跑真实现）——
   非文本挂类型图标 + label 作 title（正文仍是 main 一处产出的占位符，屏上不重复显示标签）；文本保留纯文本 + 复制。 */
/* zx_20260930 M1(维特根斯坦·意义即使用): 先问「这是不是一件」——是件就出**件该有的控件**
   （缩略图 / 播放条 / 件名+大小+打开），不是件才落到旧的占位符渲染。
   ⚠ 顺序不能反：旧路的 `messageViewOf` 对非文本一律给一行灰字，先走它就永远看不见件。 */
const md = imMediaOf(c.message_json);if (md)return (<ImMediaBubble key={c.id} media={md} onNotice={(t,ok)=>setSendMsg({ok,text:t})}/>);
const mv = messageViewOf(c.message_json);
/* M11: 非文本是简短占位符（[图片] 等），无需折叠，原样渲染以保住类型图标与斜体样式。 */
if (mv.kind !== 'text') return (<div className="flex items-start gap-1"><p className="flex-1 whitespace-pre-wrap break-words text-gray-500 italic" title={mv.label?`类型：${mv.label}`:undefined}><Paperclip className="inline w-3 h-3 mr-1 -mt-0.5 text-gray-400"/>{mv.text}</p></div>);
/* M11: 文本正文走可收可展（长播报折叠限高 + 展开全文）；复制钮仍在（复制的始终是**全文**，非折叠后的可见部分）。 */
return (<div className="flex items-start gap-1"><ClampText text={mv.text} className="flex-1" textClassName="text-gray-700"/>{mv.text&&<button onClick={()=>void handleCopy(mv.text)} className="shrink-0 text-gray-300 hover:text-blue-600" title="复制这条消息"><Copy className="w-3 h-3"/></button>}</div>);})()}</div>);})}</div>));})()}</div>{/* zx_20260911_5 M2-3: 更早记录可达——追加加载(不整体替换) */}{convHasMore&&<div className="mt-2 text-center"><button onClick={()=>void loadMoreConvs()} disabled={convLoadingMore} className="px-3 py-1.5 border rounded-lg text-xs hover:bg-gray-50 disabled:opacity-50">{convLoadingMore?'加载中…':'加载更多'}</button></div>}{/* zx_20260914 M1-4(庄子·得鱼忘筌): 手工回话——收件人**明写**（不猜、不给裸 id 输入口），发送只清输入框。 */}<div className="mt-3 pt-3 border-t border-gray-100">{sendMsg&&<p className={`text-xs mb-2 ${sendMsg.ok?'text-green-700':'text-red-600'}`}>{sendMsg.ok?'✅':'❌'} {sendMsg.text}</p>}<div className="flex items-center justify-between mb-1"><p className="text-xs text-gray-400">发送给 <span title={convPeer?`用户：${convPeer}`:''}>{convPeer?userLabel(convPeer):'（暂无可回话的对象）'}</span>{peerView.selected&&<span className="ml-1 px-1 rounded bg-blue-100 text-blue-700" title="已选定的回话对象——筛选或新入站都不会改它">已选定</span>}{peerNotice&&<span className="ml-1 text-amber-600">（{peerNotice}）</span>}</p><p className="text-[10px] text-gray-300">Enter 发送 · Shift+Enter 换行</p></div><div className="flex items-end gap-2"><textarea value={sendText} onChange={e=>setSendText(e.target.value)} onKeyDown={handleSendKey} disabled={!convPeer||uiBusy.has('im-send')} rows={2} placeholder={convPeer?'输入要回复的内容…':'本页还没有任何会话记录，收到消息后才能回话'} className="flex-1 px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 resize-none"/><button onClick={()=>void handleSend()} disabled={!convPeer||uiBusy.has('im-send')||!sendText.trim()} className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">{uiBusy.has('im-send')?<Loader2 className="w-4 h-4 animate-spin"/>:<Send className="w-4 h-4"/>}发送</button>{/* zx_20260930 M1(维特根斯坦·意义即使用): 发件钮——**置灰但仍在**（藏起来就成了"这页什么也没说"）；
   为什么点不动由能力表的 `note` 作 title 说，源码里不出现第二份同义文案。 */}
<button onClick={()=>void handlePickMedia()} disabled={!convPeer||uiBusy.has('im-media')||!convCap.media} title={convCap.note} className="flex items-center gap-1.5 px-3 py-2 border rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50">{uiBusy.has('im-media')?<Loader2 className="w-4 h-4 animate-spin"/>:<Paperclip className="w-4 h-4"/>}</button></div>{!convCap.media&&<p className="mt-1 text-[10px] text-amber-600">{convCap.note}</p>}</div></div>}

      {qrChannel && <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={closeQr}><div className="bg-white rounded-xl shadow-lg p-6 text-center" onClick={e=>e.stopPropagation()}><h3 className="font-bold mb-2">{qrChannel.name} — 扫码登录</h3>{qrChannel.img?<img src={qrChannel.img} alt="QR" className="w-64 h-64 mx-auto"/>:qrMsg?<p className={`py-8 px-4 text-sm ${qrMsg.ok?'text-gray-500':'text-red-600'}`}>{qrMsg.text}</p>:<p className="text-gray-400 py-8">加载中...</p>}<button onClick={closeQr} className="mt-4 px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">关闭</button></div></div>}
      {showCreate && <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={()=>{setShowCreate(false);setEditing(null);}}><div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-md max-h-[80vh] overflow-y-auto" onClick={e=>e.stopPropagation()}><h3 className="text-lg font-bold mb-4">{editing?'编辑渠道':'添加 IM 渠道'}</h3><div className="space-y-3"><div><label className="block text-sm font-medium mb-1">渠道类型</label><select value={form.channel_type} disabled={!!editing} onChange={e=>setForm({channel_type:e.target.value,name:form.name})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50">{CHANNEL_TYPES.map(t=><option key={t} value={t}>{typeLabel(t)}</option>)}</select></div><div><label className="block text-sm font-medium mb-1">名称</label><input value={form.name} onChange={e=>setForm({...form,name:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder={typeLabel(form.channel_type)}/></div>
{/* 渠道类型特定配置 */}
	    {form.channel_type==='wechat-personal' && <p className="text-xs text-gray-400 bg-gray-50 p-2 rounded">微信个人号：通过扫码登录，无需额外配置参数</p>}
{form.channel_type==='qqbot' && <><p className="text-xs text-gray-400 bg-gray-50 p-2 rounded">QQ 开放平台 Bot，通过 Gateway WebSocket 长连接接收消息（免公网 IP）</p><div><label className="block text-sm font-medium mb-1">App ID</label><input value={form.app_id||''} onChange={e=>setForm({...form,app_id:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/></div><div><label className="block text-sm font-medium mb-1">Client Secret</label><input type="password" value={form.client_secret||''} onChange={e=>setForm({...form,client_secret:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/></div></>}
{form.channel_type==='dingtalk' && <><p className="text-xs text-gray-400 bg-gray-50 p-2 rounded">钉钉 Stream 长连接模式（免公网 IP）</p><div><label className="block text-sm font-medium mb-1">AppKey（Client ID）</label><input value={form.clientId||''} onChange={e=>setForm({...form,clientId:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/></div><div><label className="block text-sm font-medium mb-1">AppSecret（Client Secret）</label><input type="password" value={form.clientSecret||''} onChange={e=>setForm({...form,clientSecret:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/></div><div><label className="block text-sm font-medium mb-1">Robot Code（可选）</label><input value={form.robotCode||''} onChange={e=>setForm({...form,robotCode:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/></div></>}
{form.channel_type==='feishu' && <><p className="text-xs text-gray-400 bg-gray-50 p-2 rounded">飞书 WebSocket 长连接模式（免公网 IP，需在开放平台开启长连接）</p><div><label className="block text-sm font-medium mb-1">App ID</label><input value={form.appId||''} onChange={e=>setForm({...form,appId:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/></div><div><label className="block text-sm font-medium mb-1">App Secret</label><input type="password" value={form.appSecret||''} onChange={e=>setForm({...form,appSecret:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/></div></>}
{form.channel_type==='wecom' && <><p className="text-xs text-amber-600 bg-amber-50 p-2 rounded">企业微信：<b>仅可发送</b>；接收用户消息未实现（企业微信无原生 WebSocket/长轮询，桌面端无公网回调服务）。此渠道的对话为单向——工蚁发出的通知能到达，用户的回复不会进入引擎。</p><div><label className="block text-sm font-medium mb-1">Corp ID</label><input value={form.corpId||''} onChange={e=>setForm({...form,corpId:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/></div><div><label className="block text-sm font-medium mb-1">Corp Secret</label><input type="password" value={form.corpSecret||''} onChange={e=>setForm({...form,corpSecret:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/></div><div><label className="block text-sm font-medium mb-1">Agent ID</label><input value={form.agentId||''} onChange={e=>setForm({...form,agentId:e.target.value})} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/></div></>}
</div><div className="flex justify-end gap-2 mt-6"><button onClick={()=>{setShowCreate(false);setEditing(null);}} disabled={uiBusy.has('save')} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50">取消</button><button onClick={handleSave} disabled={uiBusy.has('save')} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">{uiBusy.has('save')&&<Loader2 className="w-4 h-4 animate-spin"/>}{editing?'保存':'添加'}</button></div></div></div>}
    </div>
  );
}
