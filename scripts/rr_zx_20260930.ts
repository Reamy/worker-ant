/**
 * zx_20260930 受控复跑 —— 「件要显形、要发得出」。
 *
 * 本轮口径（方案 §0/§1）：**一件东西落进了库，就得到得了用户眼前**。
 *   `message_json` 里早就记着「这件在盘上哪儿」（入站扁平 `saved_path`／出站嵌套 `media.path`），
 *   而界面把它当一行灰字占位符——**看得出"收到过一件"，看不出那件是什么、更打不开**。
 *   同一条谱系上：界面上**根本发不出件**（`sendImMedia` 早在册，只是没有一处界面走得到它）。
 *
 * 分组（方案 §3）：
 *   A · M1 IM 的件要显形、要发得出
 *      a 判定**一处真源**（`im-media-view` 零依赖、渲染层跨 root 引它、不抄第二份"什么算图片"）
 *      b **四处一句**（`MEDIA_UNSUPPORTED_TEXT` 真源唯一；GUI 侧消费能力表而非手抄文案）
 *      c 取件**范围硬限**（`resolveAttachmentRead` 五理由，正反两侧标本各一）
 *      d 发件**唯一下游** `sendManualImMedia`（真夹具 DB：不支持/成功/失败三态）
 *      e **往返**：生产写出的那一行，生产读得出来（禁自造入参）
 *      f 如实：件未到手写原因 · 大小不编数 · 取消不算失败
 *   B · M2 IM 的实时与归属
 *      a 出站**短窗重取**（代际号作废旧链）+ 乐观气泡**凭真行**退场（三要素认行，两种没退场分开说）
 *      b 归属**由猜测改指认**：真跑 `routeImMessage`，正反两侧各一只标本（有交互证据/无据回问/单候选）
 *   C · M3 成果状态如实
 *      a 退出即复位（`proc.on('exit')` 内**无条件**落 `stopped`；反证：旧的「code!==0 才写」代码行零处）
 *      b `failed` 的**真生产者**（启动确认窗内退出 ⇒ failed；正常退出 ⇒ completed，两标本同试）
 *      c 建成果**唯一落库口径** `createDeliverable`（校验/去重/落库/通报一处；两调用点；事件名实相符）
 *      d 审批选项**同源**（GUI 引 `core/im/options.ts` 的 `parseOptions`，不再自带第二套切分）
 *      e 非 doc 文件成果也随任务完成推出 draft（走 `FILE_DELIVERABLE_TYPES` 集合，非硬写 `type='doc'`）
 *      f M4-3 补发明细与统计对齐：折叠档与**未折叠**档同出一次 `GROUP BY status`（两口径总数必相等）；
 *        明细按 `offset` **分页取尽**（同秒行靠 `rowid` 兜次序，翻页不重不漏）；界面写"显示 K / 共 M"
 *   I · M9 第一步 桌面侧到 ANS 的签名收敛到**一处真源**（`core/ans-signed-request.ts`）
 *      a 一处真源与完备性扫面（`createHmacSignature(` 只在真源一处；`/api/v1/` 每个文件都在签名路或点名豁免）
 *      b 往返：生产签出的字节串，**生产验签器**认（真桩 + `verifyHmacSignature` 直引，三只反面标本）
 *      c 失败要显形 · 重试语义（5xx/传输失败重试；4xx 不重试；`status=0` 表示无响应）
 *      d 身份解析 `resolveAnsCreds` 真跑（DB → env → 缺省；空串不算"有值"）
 *      e 记账上报失败不再无声（切 `.catch` 的**处理器括号**做正面断言，与注释无关）
 *   J · M9 第二步 ANS 侧**真验签**（静态接线在 rr；运行时往返在 `apps/ans-server/src/__tests__/hmac-auth.test.ts`）
 *      a 验签真接上（四实参逐位 / 体原文捕获路 / 五种失败各自一句 / `secret_enc` 列与迁移）
 *      b 生产真的挂上了（两个受保护组各一次 `hmacAuth(db)` + 顶层 `app` 真 `.use(…)`）
 *      c ANS 侧回归套件在册、且不自证（引生产 `hmacAuth`；`createHmac` 零命中；三处同取一个签名模块）
 *
 * §判据纪律（逐条对上本仓 auto-memory）：
 *   G-1 **用生产函数、不自造等价实现**：只调生产导出（`imMediaOf` / `sendManualImMedia` /
 *       `resolveAttachmentRead` / `listOutbox` / `enqueueImOutbox` / `channelCapabilities`…）。
 *       自造一份等价实现再拿它自证，证的是"生产没走的那条路"（本仓已复发两次）。
 *   G-2 **每条判据都能被合法数据满足**，且**有区分度**：正反两侧各给一只真标本
 *       （`feedback_predicate_needs_both_sides_specimen`）。
 *   G-3 **计数器用"0→1"正面断言**，不用"不抛"代替（被 `catch {}` 吞掉的写入只有正面断言抓得住）。
 *   G-4 **不依赖真实墙钟**：不 sleep、不比真实时刻。
 *   G-5 静态判据一律读**原文**（不去注释）——去注释在本仓是**静默毁伤**（zx_20260928 教训：
 *       `stripComments` 把 engineSrc 从 47.5 万削到 33.5 万字符且**无任何报错**）。锚点钉**符号/语句形状**。
 *   G-6 **无轮次字面量**：不改 `build`；轮次相关定位一律由 `path.basename(__filename)` 派生（§A-g）。
 *   G-7 夹具 schema 逐列照抄 `database.ts` DDL（既不缺列也不放宽 NOT NULL），且**先 `new` 服务类再插行**
 *       （见 `feedback_rr_fixture_production_order`）。
 *
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// A · M1：显形判定 / 发件下游 / 取件守则 —— 一律调**生产导出**（G-1：不自造等价实现）
import {
  imMediaOf, extOf, baseNameOf, audioPlayNote, formatMediaSize, resolveAudioPreview,
} from '../apps/worker-ant-desktop/src/main/core/im/im-media-view.js';
import { sendManualImMedia, sendManualImMessage, type ManualSendDeps } from '../apps/worker-ant-desktop/src/main/core/im/manual-send.js';
// B-d · M2-d：长文本发落（有上限才截 / 无上限只提示）——真源里的四个导出，一律调生产实现
import {
  fitOutboundText, IM_SEND_TEXT_LIMIT, IM_TEXT_NOTICE_THRESHOLD, KEPT_NOTICE_TAIL,
} from '../apps/worker-ant-desktop/src/main/core/im/im-text.js';
// D-f · M4-3：补发账的两个计数口径（折叠 / 未折叠）与分页取数——一律调生产导出（G-1）
import {
  enqueueImOutbox, listOutbox, outboxStats, outboxStatusCounts, OUTBOX_PAGE_MAX,
} from '../apps/worker-ant-desktop/src/main/core/im/im-outbox.js';
import { MEDIA_UNSUPPORTED_TEXT, mediaUnsupportedReason, channelCapabilities } from '../apps/worker-ant-desktop/src/main/core/im/channel-capabilities.js';
import { resolveAttachmentRead, attachmentsRoot, ATTACHMENTS_DIR } from '../apps/worker-ant-desktop/src/main/services/im-media.js';
// B · M2：归属消歧 —— 驱动**生产入口** `routeImMessage`（G-1：不自造等价实现）
import { routeImMessage } from '../apps/worker-ant-desktop/src/main/services/im-router.js';
// B-c · M2-c：出站行的唯一落点 + 取回后补任务名 —— 同样调生产导出，不自造等价实现
import { recordOutboundConversation } from '../apps/worker-ant-desktop/src/main/core/im/outbound-record.js';
import { attachTaskTitles } from '../apps/worker-ant-desktop/src/main/core/im/im-conversations-query.js';
// C · M3：成果状态如实 —— 落库口径 / 类型判据 / 事件起草**一律调生产导出**（G-1）
// D · M4-1：成果**取数范围**的共享真源（谓词组合 + 两个计数出口）——同上，一律调生产导出。
//   ⚠ 注释**不可写进 `{ }` 里**：`rr_zx_20260913_2` 由全仓 import 面派生"调用方引入了哪些符号"，
//   会把花括号内的注释文本当符号名 ⇒ 才在该脚本名下报"lifecycle 取不到这个符号"（本轮踩过）。
import {
  createDeliverable, setDeliverableStatus, promoteTaskFileDeliverables, docNotProbe,
  countDeliverables, countDeliverablesByType, deliverableScopeSql,
} from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
import {
  FILE_DELIVERABLE_TYPES, SERVICE_TYPES, isServiceType, isDocPath, isModuleFilePath,
} from '../apps/worker-ant-desktop/src/main/core/deliverable-types.js';
import { parseOptions, OPTION_BLOCK_RE, matchApprovalReply } from '../apps/worker-ant-desktop/src/main/core/im/options.js';
import { eventBus, type AppEvent } from '../apps/worker-ant-desktop/src/main/core/event-bus.js';
// D-g · M4-2：分页夹取的**唯一真源**——一律调生产导出（G-1），不在夹具里另写一份夹取逻辑
import { resolvePage, PAGE_DEFAULT, PAGE_MAX } from '../apps/worker-ant-desktop/src/main/core/pagination.js';
// D-g · M4-2：渲染层**列表批次**的共享判据与常量。它是零依赖模块（无 React/node 运行时依赖），
//   故与上两行同法直接 import 真函数；若在夹具里重写一遍 `loaded < 100 || loaded >= total`，
//   判据就只在自我印证（本仓已复发两次）。
import { LIST_PAGE_SIZE, pageExhausted } from '../apps/worker-ant-desktop/renderer/src/lib/list-page.js';
// E · M5：记忆**写侧**的内容装配一律调生产纯函数（G-1）；落库与两张表的名字同引一处真源。
import {
  buildFailureKnowledge, buildSubagentExperience, buildImUserCorrection,
  buildReviewActual, buildTaskReviewPrompt, failureAnchors, isAttributable,
} from '../apps/worker-ant-desktop/src/main/core/memory-write.js';
import {
  MEM_TYPE_FAILURE_KNOWLEDGE, MEM_TYPE_SUBAGENT_EXPERIENCE, MEM_SOURCE_USER_CORRECTION,
} from '../apps/worker-ant-desktop/src/main/core/memory-constants.js';
// E：写侧的两个真写手（`failure_knowledge` / `subagent_experience`）+ 可复盘终态集真源。
import { writeFailureKnowledge, writeSubagentExperience } from '../apps/worker-ant-desktop/src/main/core/jobs/ai-task.js';
import { isReviewableStatus, reviewFocus, REVIEWABLE_STATUSES } from '../apps/worker-ant-desktop/src/main/core/task-terminal.js';
// E：真 `MemoryManager` × 内存库真行（G-2：真装配不是等价自造）。
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
// F · M6：**年龄基准 / 半衰期 / 衰减**与**归因硬锚点**的一处真源 —— 一律调生产纯函数（G-1）。
//   在夹具里重写一份 `0.5 ** (age/hl)`、或重写一份"锚点怎么切"，证的就只是那份抄件（本仓已复发两次）。
import {
  MEM_HALF_LIFE_DAYS, RETRIEVAL_TAU_DAYS, MATURITY_TAU_DAYS, CONFIDENCE_TAU_DAYS,
  CORE_HALF_LIFE_FACTOR, CORE_USE_COUNT,
  baseHalfLifeDays, halfLifeDays, isCoreMemory, memoryAgeDays, decayFactor, ageDaysSince,
} from '../apps/worker-ant-desktop/src/main/core/memory-decay.js';
// F · M6-4：模型档**阶梯 + 回落**（旧实现只会升不会降）—— 同上，调生产导出。
import {
  stepUpTier, stepDownTier, adjustProjectStrategy,
  MODEL_TIER_LADDER, MODEL_TIER_DOWNGRADE_STREAK,
} from '../apps/worker-ant-desktop/src/main/core/feedback-engine.js';
// G · M7：检索层的取用与择要（分层合并 / 工作记忆池与焦点 / 图式重构召回）——**生产纯函数直引**（G-1）。
//   本模块与 `memory-decay.ts` 同属"零依赖的一把尺"，故 rr 能直接引真实现，判据不自造等价物。
import {
  splitTaskLayers, mergeTaskLayers, applySchemaRecall,
  rankWorkingMemory, selectWorkingMemory, extractKeywords,
  WM_WINDOW_CAP, WM_POOL_CAP, WM_REHEARSAL_SATURATION,
} from '../apps/worker-ant-desktop/src/main/core/memory-select.js';
// G · M7 端到端：`buildMemoryContext` **整块外迁后的真装配**（段取舍/注记/记账一次跑完）。
import { buildMemoryContext, MEM_OVERHEAD } from '../apps/worker-ant-desktop/src/main/core/memory-context.js';
// H · M8：**记忆生命周期（分级 / 墓碑 / 同源有界）**——零依赖纯模块，故 rr 直引真实现（G-1）。
//   `parseUtcMs` 与 `memory-decay.ts` 的 `dbTimeMs` 是**刻意两份**（前者须零 import），故本轮对二者
//   有正面等价性断言：同一批字面量两侧同值。**不许**把这条读成"两份实现可以各自漂"。
import { dbTimeMs } from '../apps/worker-ant-desktop/src/main/core/memory-decay.js';
import {
  MEM_TYPE_ARCHIVED, MEM_TYPE_DELETED, MEM_LIVE_SQL, memTypeNotInSql,
  MEM_GRADES, MEM_COOLING_AFTER_DAYS, gradeSpec, gradeOf, _parseUtcMsForEquivalence,
  MEM_DELETE_REASONS, utcNowIso, contentFingerprint,
  tombstoneMemory, tombstoneMemoriesBy, tombstoneExpiredArchived,
  tombstoneBlocksContent, listTombstones,
  MEM_SAME_SOURCE_MAX_CHARS, memFoldNote, boundedSameSource,
} from '../apps/worker-ant-desktop/src/main/core/memory-lifecycle.js';
// I · M9：**到 ANS 的签名请求只有一条出路**——真源三个导出 + 失败留痕格式化，一律调生产导出（G-1）。
//   验签器取 `packages/ans-client/src/crypto.ts`（**深引 src**，与 `rr_zx_20260921_1` 同一手法）：
//   barrel 会连带拉进 MCP/A2A SDK 两条 chunk，而本判据只关心"字节串↔验签"这一件事。
//   这正是 ANS 侧 `hmacAuth` 将要调的那一个函数（同一个源、同一把尺），**不是判据自造的等价物**。
import {
  ansSignedRequest, ansSignedHeaders, resolveAnsCreds, ansFailureNote, ANS_DEFAULTS, type AnsCreds,
} from '../apps/worker-ant-desktop/src/main/core/ans-signed-request.js';
// zx_20261005 M21: ANS 地址**单一真源**（原在 `ans-signed-request.ts` 的整串已迁此）——I-a-4/I-d-4 由它派生。
import { ANS_DEFAULT_BASE_URL, ANS_DEFAULT_PORT } from '../packages/shared-types/src/ans-defaults.js';
import { verifyHmacSignature } from '../packages/ans-client/src/crypto.js';
// K · M10：**工具面与能力匹配**——四件事各取一处真源，判据分「读原文」与「真跑实现」两路。
//   K-a 工具面   ：类目表的**唯一真源** + 由它派生的档内工具集 + ★「注释与构造同真」
//   K-b 能力闸   ：真 `buildAttachmentParts`（六只标本：该命中 / 该不命中 / **无清单不设闸**）
//   K-c 选型侧   ：四个换路点收进 `applySwap` 一处 + ★闸读**换路之后**的清单
//   K-d 接线     ：新参数**真的**被传下去（只建接口不接，全量回归照样全绿）
//   K-e MCP 缓存 ：失效按**条目年龄**判（非"这个服务最近用没用过"）
//   K-f MCP 可见面：真 `resourceTools` × 真 ANS 桩（项目交付物 / 仅 ANS 注册 / 查失败 三态）
import { ARCHETYPE_TOOL_CATEGORIES, availableToolNames, type TaskArchetype } from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';
import { toolRegistry, type ToolCategory } from '../apps/worker-ant-desktop/src/main/core/tool-registry.js';
import { buildAttachmentParts, type InlineIo } from '../apps/worker-ant-desktop/src/main/core/attachment-inline.js';
import { resourceTools } from '../apps/worker-ant-desktop/src/main/core/tools/resource.js';
import type { DocTextResult } from '../apps/worker-ant-desktop/src/main/core/doc-text.js';
//   L 组 M11 · 调度账实：并发闸（守卫片段/CAS 模板）· 看门狗归一（两原语）· 悬空子收敛 · 「不扫」的理由
import {
  projectSlotGuard, machineSlotGuard, resolveProjectConcurrencyLimit, PROJECT_RUNNING_STATUSES,
  PROJECT_CONCURRENCY_DEFAULT, projectScanVerdict, PROJECT_PARKED_STATUSES,
} from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import {
  findStaleExecutingTasks, reclaimStaleExecutingTask, reconcileStalledSubtasks,
  EXEC_STALE_STATUSES, PARENT_INTERRUPTED_PAUSE_REASONS, SELF_HEALING_LOGS_DDL,
  tryHeal, runHealthScan, runStartupRegressionCheck, logHealing, ensureSelfHealingTable,
  readRecentHealingLogs, SELF_HEALING_LOGS_MIGRATIONS, type HealingRecord,
} from '../apps/worker-ant-desktop/src/main/core/self-healing-monitor.js';
//   M14 · 自愈结果态词表（零 import 的生产模块 ⇒ rr 直引真实现，G-1）。
import {
  HEAL_OUTCOMES, HEAL_OUTCOME_LABEL, outcomeIsSuccess, isHealOutcome, healOutcomeOf, type HealOutcome,
} from '../apps/worker-ant-desktop/src/main/core/healing-outcome.js';
import { claimTaskForExecution } from '../apps/worker-ant-desktop/src/main/core/exec-claim.js';
import { TaskScheduler } from '../apps/worker-ant-desktop/src/main/core/task-scheduler.js';
//   M14-3 · 真健康自检（外部世界全部从形参进来 ⇒ rr 直引真实现并注入假世界，G-1/G-4）。
import {
  runHealthCheck, HEALTH_LEVELS, HEALTH_LEVEL_LABEL, HEALTH_LEVEL_RANK, worstHealthLevel,
  NEEDED_TABLES, SCHEDULER_PULSE_STALE_MS, CRON_HEARTBEAT_STALE_MS,
  HEAP_WARN_BYTES, HEAP_DANGER_BYTES,
} from '../apps/worker-ant-desktop/src/main/core/health-check.js';
import {
  TASK_STATUS_LABEL, PROJECT_STATUS_LABEL, statusText,
} from '../apps/worker-ant-desktop/renderer/src/lib/status-view.js';
//   M 组 M12 · 文件读的闸：判限口径的**唯一取数口**（`attachment-kinds`）· 解码闸与源码清单（`doc-text`）·
//   `read_file` 双闸（真跑 `readonlyTools`）· 音轨闸（真 `normalizeToWav`/`makeAudioTranscriber`）。
//   全是零重依赖的生产模块 ⇒ rr 直引真实现，不造等价物（G-1）。
import {
  TEXT_EXTS, IMAGE_MAX_BYTES, FAMILY_MAX_BYTES, READ_FALLBACK_MAX_BYTES,
  readCapBytes, familyOf, maxBytesOf, sniffFileType, SNIFF_HEAD_BYTES,
} from '../apps/worker-ant-desktop/src/main/core/attachment-kinds.js';
import { decodePlainText, extractDocText, isDocTextExt } from '../apps/worker-ant-desktop/src/main/core/doc-text.js';
import { readonlyTools } from '../apps/worker-ant-desktop/src/main/core/tools/readonly.js';
import {
  AUDIO_IO, normalizeToWav, makeAudioTranscriber, AUDIO_CAP_BYTES, MAX_AUDIO_SECONDS, WAV_BYTES_PER_SEC,
  TRANSCRIBE_TMP_DIR,
} from '../apps/worker-ant-desktop/src/main/core/audio-transcribe.js';
//   M13 · 画面那一半：`extractVideoFrames`（真 ffmpeg 桩，判决**读产物**）· `makeFrameExtractor`（接线缝）。
//   零 electron（只用 `node:*` 与 `audio-transcribe`）⇒ rr 直引真实现（G-1）。
import {
  extractVideoFrames, makeFrameExtractor, FRAMES_IO, VIDEO_FRAME_COUNT, VIDEO_FRAME_INTERVAL_SEC,
  VIDEO_FRAMES_WINDOW_SEC, FRAME_EXTRACT_TIMEOUT_MS, type VideoFramesResult,
} from '../apps/worker-ant-desktop/src/main/core/video-frames.js';
//   M14-4 · 架构不变量 error 级**要通知**：真跑 `startupSelfCheck`（零 electron ⇒ rr 直引真实现，G-1），
//   通知类型名从生产导出取——判据不另写一份字面量（`wa_notifications.type` 的取值域）。
import {
  runAllInvariants, startupSelfCheck, ARCH_INVARIANT_ERROR_NOTIFICATION_TYPE,
} from '../apps/worker-ant-desktop/src/main/core/architectural-invariants.js';
import zlib from 'node:zlib';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string): void =>
  ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const RD = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');
type AnyDb = import('better-sqlite3').Database;

// ── 夹具 schema：按 database.ts DDL 摘取本文件用到的列（NOT NULL 照抄） ──
const SCHEMA = `
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, name TEXT DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}', status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_im_conversations (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT,
  project_id TEXT, message_json TEXT DEFAULT '{}', direction TEXT DEFAULT 'inbound',
  created_at TEXT DEFAULT (datetime('now')), status TEXT DEFAULT 'sent', last_error TEXT DEFAULT '',
  outbox_id TEXT DEFAULT '');
CREATE TABLE wa_im_outbox (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, task_id TEXT,
  kind TEXT DEFAULT 'notification', message TEXT DEFAULT '', attempts INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending', next_retry_at INTEGER, created_at TEXT DEFAULT (datetime('now')),
  last_error TEXT, last_attempt_at TEXT, media_path TEXT, media_kind TEXT);
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL);
`;

/** 一套最小在跑的 IM 世界：一个渠道 + 一张可插桩的适配器名册。 */
function world(channelType: string) {
  const db = new DatabaseSync(':memory:') as unknown as AnyDb;
  db.exec(SCHEMA);
  const channelId = `ch-${channelType}`;
  db.prepare('INSERT INTO wa_im_channels (id, channel_type, name) VALUES (?, ?, ?)').run(channelId, channelType, channelType);
  const calls: Array<{ toUser: string; file: { path: string; kind: string; name?: string }; opts?: unknown }> = [];
  const sends: string[] = [];
  const mk = (opts: { withMedia: boolean; fail?: string }) => {
    const adapter: {
      sendReply: (t: string, x: string, c?: string, o?: unknown) => Promise<void>;
      sendMedia?: (t: string, f: { path: string; kind: 'image' | 'file'; name?: string }, o?: unknown) => Promise<void>;
    } = {
      sendReply: async (t: string, x: string) => { sends.push(`reply:${t}:${x}`); },
    };
    if (opts.withMedia) {
      adapter.sendMedia = async (toUser, file, o) => {
        calls.push({ toUser, file: { path: file.path, kind: file.kind, name: file.name }, opts: o });
        if (opts.fail) throw new Error(opts.fail);
        sends.push(`media:${toUser}:${file.path}`);
      };
    }
    return adapter;
  };
  return { db, channelId, calls, sends, mk };
}

/** 盘上真造一件（取件守则的合法侧标本必须**真存在**，否则量到的是 `missing` 不是 `out_of_root`）。 */
function fixtureFile(dir: string, name: string, bytes = 128): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 7));
  return p;
}

const convRows = (db: AnyDb) => db.prepare('SELECT * FROM wa_im_conversations ORDER BY rowid').all() as Array<Record<string, unknown>>;
const outboxRows = (db: AnyDb) => db.prepare('SELECT * FROM wa_im_outbox').all() as Array<Record<string, unknown>>;

/** 一张只有补发账表、可自由插行的空世界（D-f 的分页标本用它，免得被 `world()` 的渠道/适配器带进来）。 */
function outboxOnlyDb(): AnyDb {
  const db = new DatabaseSync(':memory:') as unknown as AnyDb;
  db.exec(SCHEMA);
  return db;
}

/**
 * D-f：**按生产读法**一页页翻到底，返回 id 序列（重复会如实留在序列里——去重与否是要被判的事实，不是前提）。
 * 护栏：`page` 为 0 或恒不前进时立刻停（避免夹具写错把脚本挂死）。
 */
function pageAllIds(db: AnyDb, page: number): string[] {
  const ids: string[] = [];
  for (let off = 0; off < 10_000; off += page) {
    const rows = listOutbox(db, { limit: page, offset: off });
    ids.push(...rows.map((r) => r.id));
    if (rows.length < page || page <= 0) break;
  }
  return ids;
}

// ══════════════════════════════════════════════════════════════════
// 【A-a】判定一处真源：零依赖 · 跨 root 同引一份 · 不抄第二份判型
// ══════════════════════════════════════════════════════════════════
function groupAa(): void {
  console.log('\n【A-a】显形判定一处真源（renderer 与 main 引的是**同一份**代码）');
  const view = RD(`${A}/src/main/core/im/im-media-view.ts`);
  const imports = (view.match(/^import .*$/gm) ?? []).join('\n');
  ok(imports.length > 0, 'A-a-1 扫描面自证：`im-media-view.ts` 的 import 段非空（否则下面"零依赖"是空转假绿）', `${imports.split('\n').length} 行`);
  eq(
    imports.includes("'electron'") || imports.includes('better-sqlite3') || /from 'node:/.test(imports),
    false,
    'A-a-2 ★判定模块**零依赖**（不引 electron / better-sqlite3 / node:*）⇒ 渲染层跨 root 引得起',
  );
  ok(/from '\.\.\/attachment-kinds\.js'/.test(imports) && /from '\.\.\/deliverable-types\.js'/.test(imports),
    'A-a-3 两张零依赖表（`attachment-kinds` 判族 / `deliverable-types` 认图）是它仅有的依赖');

  // 渲染层：引生产判定 + **不**自己判族（`attachment-kinds` 是判族的唯一处，引它等于抄第二份）
  const bubble = RD(`${A}/renderer/src/components/ImMediaBubble.tsx`);
  const page = RD(`${A}/renderer/src/pages/IMPage.tsx`);
  ok(/from '\.\.\/\.\.\/\.\.\/src\/main\/core\/im\/im-media-view\.js'/.test(bubble),
    'A-a-4 件控件**跨 root 引** main 侧判定模块（不是本地再写一份）');
  ok(!/attachment-kinds\.js/.test(bubble), 'A-a-5 件控件**不**引判族表 —— 判型只此一处，抄第二份即分叉');
  const handRolled = /\.endsWith\(\s*['"]\.(png|jpg|jpeg|gif|webp|mp3|wav)['"]\s*\)/i.test(bubble + page);
  eq(handRolled, false, 'A-a-6 ★渲染层**零**处手写图片/音频后缀清单（"什么算图片"只在 `im-media-view.renderOf`）');

  // ⚠ 顺序不能反：先走旧的占位符路，件就**永远看不见**
  const iMedia = page.indexOf('imMediaOf(');
  const iView = page.indexOf('messageViewOf(');
  ok(iMedia >= 0 && iView >= 0, 'A-a-7 两侧扫描面自证：两个判定名都在页面上出现', `imMediaOf@${iMedia} messageViewOf@${iView}`);
  ok(iMedia < iView, 'A-a-8 ★`imMediaOf` 的**首次出现早于** `messageViewOf`（先问"这是不是一件"，再落到文本路）');

  // 判型取**族**（不是"图片就这几个后缀"——那句在 `attachment-kinds` 里）
  eq(extOf('/a/b/PHOTO.PNG'), '.png', 'A-a-9 `extOf` 忽略大小写与目录段');
  eq(extOf('/home/.bashrc'), '', 'A-a-10 点为首字符不算扩展名（`.bashrc` 不是"扩展名为 bashrc"的件）');
  eq(baseNameOf('/x/y/件 名.pdf'), '件 名.pdf', 'A-a-11 `baseNameOf` 取路径末段');
}

// ══════════════════════════════════════════════════════════════════
// 【A-b】四处一句：文案真源唯一 · GUI 侧消费能力表
// ══════════════════════════════════════════════════════════════════
function groupAb(): void {
  console.log('\n【A-b】「本通道发不了件」一句话只有一个出处（GUI 侧本轮补上）');
  const capSrc = RD(`${A}/src/main/core/im/channel-capabilities.ts`);
  const m = /MEDIA_UNSUPPORTED_TEXT = '([^']+)'/.exec(capSrc);
  ok(!!m, 'A-b-1 扫描面自证：能力表里取得到那句话（否则下面的比对全是空转）');
  const TEXT = m?.[1] ?? '__NO_TEXT__';
  eq(TEXT, MEDIA_UNSUPPORTED_TEXT, 'A-b-2 静态取到的文案与运行时导出的**同一串**（钉的是真源本身）');

  // 全仓源码里那句话**作为取值**只出现一次
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/node_modules|dist/.test(e.name)) walk(p); }
      else if (/\.tsx?$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(root, A, 'src'));
  walk(path.join(root, A, 'renderer', 'src'));
  // 阈值只求"面不是空的"——扫了个空的话下面"只有一处"毫无意义（实测 179，取 100 留出删文件余量）。
  ok(files.length > 100, 'A-b-3 扫描面自证：源码文件数合理（扫了个空的话下面"只有一处"毫无意义）', `${files.length} 个 .ts/.tsx`);
  const asValue = new RegExp(`=\\s*'${TEXT}'`);
  const valueHits = files.filter((f) => asValue.test(fs.readFileSync(f, 'utf-8')));
  eq(valueHits.map((f) => path.relative(root, f)), [`${A}/src/main/core/im/channel-capabilities.ts`],
    'A-b-4 ★那句话**作为取值**全仓只有一处（其余都是引它，不是抄它）');

  // 本轮新改的两个文件里**一个字都不许有**（引它不算抄它，手抄即分叉）
  for (const rel of [`${A}/src/main/ipc/im.ipc.ts`, `${A}/renderer/src/pages/IMPage.tsx`]) {
    const src = RD(rel);
    ok(!src.includes(TEXT), `A-b-5 本轮改动的 ${path.basename(rel)} 里**零处**同义文案（标题由能力表 note 出）`);
  }

  const page = RD(`${A}/renderer/src/pages/IMPage.tsx`);
  ok(/channelCapabilities\(/.test(page), 'A-b-6 IM 页**消费能力表**（不是自己判"这个渠道行不行"）');
  ok(/disabled=\{[^}]*convCap\.media[^}]*\}/.test(page), 'A-b-7 附件钮按 `media` 禁用（判据即能力表那一列）');
  ok(/title=\{convCap\.note\}/.test(page), 'A-b-8 为什么点不动由能力表 `note` 作 title 说');
  ok(/!convCap\.media&&<p/.test(page), 'A-b-9 ★禁用钮**置灰但仍在**且另有一句行内说明（藏起来就成了"这页什么也没说"）');
  ok(/OUTBOX_KIND_LABEL[^;]*manual_media/.test(page) && /OUTBOX_KIND_LABEL[^;]*manual_reply/.test(page),
    'A-b-10 补发账的手发两 kind 有中文名（新 kind 漏在这张表里，账就翻不开）');

  // 能力表两标本：一边发不了、一边发得了（只用一侧验不出判据方向）
  eq(channelCapabilities('wechat-personal').media, false, 'A-b-11 微信个人号：结构上发不了件（事实登记）');
  eq(channelCapabilities('qqbot').media, true, 'A-b-12 QQ：发得了件');
  eq(mediaUnsupportedReason('wechat-personal'), MEDIA_UNSUPPORTED_TEXT, 'A-b-13 拒的理由**就是**那句话');
  eq(mediaUnsupportedReason('qqbot'), '', 'A-b-14 发得了时不给理由（空串＝放行）');
  eq(mediaUnsupportedReason('__no_such_channel__'), MEDIA_UNSUPPORTED_TEXT, 'A-b-15 未知类型保守拒（宁可说发不了，也不去撞）');
}

// ══════════════════════════════════════════════════════════════════
// 【A-c】取件范围硬限：五理由，正反两侧标本
// ══════════════════════════════════════════════════════════════════
function groupAc(): void {
  console.log('\n【A-c】取件范围**硬限**在 attachments 根内（复用既有围栏，不新造路径规则）');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr630-att-'));
  try {
    const inside = fixtureFile(path.join(attachmentsRoot(dataDir), '20260930'), 'a.png', 64);
    const outside = fixtureFile(path.join(dataDir, 'elsewhere'), 'b.png', 64);

    const g1 = resolveAttachmentRead(dataDir, inside);
    ok(g1.ok, 'A-c-1 ★合法标本：根内的既有文件 ⇒ 放行（这条不成立的话，其余"拒"全是空转）', inside);

    const cases: Array<[string, string | undefined, string]> = [
      ['', 'no_path'],
      ['   ', 'no_path'],
      ['https://cdn.example.com/a.png', 'url'],
      ['file:///etc/passwd', 'url'],
      ['a/b.png', 'not_absolute'],
      ['../outside.png', 'not_absolute'],
      [path.join(attachmentsRoot(dataDir), '..', '..', 'x.png'), 'out_of_root'],
      [outside, 'out_of_root'],
      ['/etc/hosts', 'out_of_root'],
      [path.join(attachmentsRoot(dataDir), '20260930', 'nope.png'), 'missing'],
      [attachmentsRoot(dataDir), 'missing'],
    ];
    for (const [cand, want] of cases) {
      const g = resolveAttachmentRead(dataDir, cand);
      eq(!g.ok ? g.reason : `ok:${g.path}`, want, `A-c-2 ${JSON.stringify(cand)} ⇒ ${want}`);
    }
    // 越界的**等价写法**也要挡住：`resolve` 之后的比对，不是字符串前缀比对
    const sneaky = path.join(attachmentsRoot(dataDir), '..', 'attachmentsX', 'c.png');
    fixtureFile(path.dirname(sneaky), 'c.png', 8);
    const g9 = resolveAttachmentRead(dataDir, sneaky);
    eq(!g9.ok ? g9.reason : 'ok', 'out_of_root',
      'A-c-3 `attachments/../attachmentsX/` 也必须拒（前缀比对会把它放过——本仓 `isInsideRoot` 比的是 resolve 之后）');

    // 守则**只判能不能读**：不设限额、不读字节（限额归各预览函数）
    eq(resolveAttachmentRead(dataDir, inside).ok, true, 'A-c-4 守则本身对大小无意见（限额是另一把尺，各判一次）');

    const media = RD(`${A}/src/main/services/im-media.ts`);
    ok(/import \{ isInsideRoot \} from '\.\.\/core\/path-fence\.js'/.test(media),
      'A-c-5 根校验口径**引** `path-fence.isInsideRoot`（围栏只此一处）');
    ok(/isInsideRoot\(raw, attachmentsRoot\(dataDir\)\)/.test(media),
      'A-c-6 判的就是 `attachmentsRoot(dataDir)` 这个根（根名不在此另写一份）');
    const ipc = RD(`${A}/src/main/ipc/im.ipc.ts`);
    ok((ipc.match(/resolveAttachmentRead\(/g) ?? []).length === 3,
      'A-c-7 三个只读出口（读/开/另存）**逐条**都过这道守则',
      `${(ipc.match(/resolveAttachmentRead\(/g) ?? []).length} 处`);
    eq(/startsWith\(/.test(ipc), false, 'A-c-8 ipc 层**零**处自判路径前缀（第二套路径规则就是从这里长出来的）');
    void ATTACHMENTS_DIR;
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
}

// ══════════════════════════════════════════════════════════════════
// 【A-d】发件唯一下游：不支持 / 成功 / 失败 三态（真夹具 DB）
// ══════════════════════════════════════════════════════════════════
async function groupAd(): Promise<void> {
  console.log('\n【A-d】手工发件**唯一下游** `sendManualImMedia`（三态各落什么账）');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr630-send-'));
  try {
    const png = fixtureFile(tmp, '清单.PNG', 128);
    const mp3 = fixtureFile(tmp, 'voice.mp3', 128);
    const txt = fixtureFile(tmp, 'notes.txt', 16);

    // ① 不支持：名册上没有 `sendMedia`（＝结构上发不了），能力表也登记 `media:false`
    {
      const w = world('wechat-personal');
      const deps: ManualSendDeps = { db: w.db, adapters: new Map([[w.channelId, w.mk({ withMedia: false })]]) };
      const before = outboxRows(w.db).length;
      const r = await sendManualImMedia(deps, { channelId: w.channelId, externalUserId: 'u1', filePath: png });
      eq('error' in r ? r.error.code : 'ok', 'UNSUPPORTED_MEDIA', 'A-d-1 通道发不了件 ⇒ 如实拒（不是"发送失败"这种含糊话）');
      eq('error' in r ? r.error.message : '', MEDIA_UNSUPPORTED_TEXT, 'A-d-2 拒的理由**就是**那句真源');
      eq(w.calls.length, 0, 'A-d-3 ★**绝不去撞**一个注定抛错的 send（零次调用，不是"撞了再说"）');
      const after = outboxRows(w.db);
      eq(after.length - before, 1, 'A-d-4 ★不支持**仍要落一条账**（0→1：沉默不是一种）');
      eq(after[0]?.kind, 'manual_media', 'A-d-5 账的 kind 认得出手发件');
      eq(after[0]?.media_path, png, 'A-d-6 账上带着盘上路径（补发才走得了 sendMedia 而不是发一串文件名）');
      eq(after[0]?.media_kind, 'image', 'A-d-7 账上的件族一并记下');
      // ★「未送达也要到场」：失败那次**也**落一行对话（`recordFailedConversation`），
      //   但它的 status 必须是 `failed` —— 界面上出现的是"这件没送达"，不是"已发送"、也不是一片空白。
      const rows = convRows(w.db);
      eq(rows.length, 1, 'A-d-8 ★未发出去的那件**照样到场**（恰一行，不是 0 行也不是 2 行）');
      eq(rows[0]?.status, 'failed', 'A-d-9 ★到场的那行**如实说未送达**（不许伪装成 `sent`）');
      eq(rows[0]?.last_error, MEDIA_UNSUPPORTED_TEXT, 'A-d-10 行上的错因就是那句真源（界面上"为什么没到"问得出）');
      ok(!!String(rows[0]?.outbox_id || ''), 'A-d-11 行与补发账**真关联**（补发成功后据此把该行由 failed 翻回 sent）');
      const ref = imMediaOf(rows[0]?.message_json);
      ok(!!ref, 'A-d-12 ★没送达的那行仍**认得出是一件**（用户看得见"哪件没送到"，不是一行灰字）');
      eq(ref?.path, png, 'A-d-13 件在盘上的位置原样带出 ⇒ 界面照样能打开/另存');
      const listed = listOutbox(w.db);
      eq(listed.length, 1, 'A-d-14 这笔账**当场**翻得开（不必等下一轮补发轮询把 status 拨过去）');
      eq(listed[0]?.media_unsupported, true, 'A-d-15 ★`media_unsupported` 由 `media_path`＋能力表**派生**（与 status 无关）');
      eq(listed[0]?.media_unsupported_reason, MEDIA_UNSUPPORTED_TEXT, 'A-d-16 派生出的理由指向同一句话');
    }

    // ② 成功：恰一行出站，且适配器拿到 `recordConversation:false`（落账归本函数）
    let okJson = '';
    {
      const w = world('qqbot');
      const deps: ManualSendDeps = { db: w.db, adapters: new Map([[w.channelId, w.mk({ withMedia: true })]]) };
      const r = await sendManualImMedia(deps, { channelId: w.channelId, externalUserId: 'u2', filePath: png });
      eq('data' in r ? r.data.sent : false, true, 'A-d-17 发得出去时如实回 `sent:true`');
      eq(w.calls.length, 1, 'A-d-18 适配器**恰**被调一次');
      const call = w.calls[0]!;
      eq(call.file.kind, 'image', 'A-d-19 `kind` 由**族**判出（`.PNG` 大写也认得 ⇒ 走的不是小写字面清单）');
      eq(call.file.name, baseNameOf(png), 'A-d-20 件名缺省取路径末段（与入库那条路同一处 `baseNameOf`）');
      eq((call.opts as { recordConversation?: boolean } | undefined)?.recordConversation, false,
        'A-d-21 ★发送那一跳传 `recordConversation:false`（适配器只发不记 ⇒ 否则一次手发两个气泡）');
      const rows = convRows(w.db);
      eq(rows.length, 1, 'A-d-22 ★成功**恰**一行出站（0→1；落账归本函数，与上一条同看才是"不重不漏"）');
      eq(rows[0]?.direction, 'outbound', 'A-d-23 出站方向如实');
      eq(rows[0]?.status, 'sent', 'A-d-24 成功行**不手写 status**，取列 DEFAULT（列默认改了这里跟着改）');
      okJson = String(rows[0]?.message_json ?? '');
      eq(outboxRows(w.db).length, 0, 'A-d-25 成功不落补发账（只有失败才记账）');
      ok(okJson.includes(`📎 ${baseNameOf(png)}`), 'A-d-26 出站行的正文就是"📎 件名"', okJson);

      // 音频族 ⇒ kind 只有 image|file 两档，`.mp3` 落到 file（**刻意**：适配器的 sendMedia 只认这两档）
      const r2 = await sendManualImMedia(deps, { channelId: w.channelId, externalUserId: 'u2', filePath: mp3 });
      eq('data' in r2 ? r2.data.sent : false, true, 'A-d-27 音频也发得出去');
      eq(w.calls[1]?.file.kind, 'file', 'A-d-28 `.mp3` 归 `file` 档（不是 image；族与"界面出哪种控件"是两回事）');
    }

    // ③ 失败：真因如实、只落 failed 行、账上带件的路径
    {
      const w = world('qqbot');
      const deps: ManualSendDeps = { db: w.db, adapters: new Map([[w.channelId, w.mk({ withMedia: true, fail: '平台返回 400：文件过大' })]]) };
      const before = outboxRows(w.db).length;
      const r = await sendManualImMedia(deps, { channelId: w.channelId, externalUserId: 'u2', filePath: txt });
      eq('error' in r ? r.error.code : 'ok', 'SEND_FAILED', 'A-d-29 推送失败 ⇒ 失败码（与"通道不支持"分得开）');
      ok(('error' in r ? r.error.message : '').includes('文件过大'),
        'A-d-30 ★失败原因**如实带上适配器原文**，不吞成"发送失败"四个字');
      const after = outboxRows(w.db);
      eq(after.length - before, 1, 'A-d-31 ★失败**只走** `enqueueImOutbox` 一个记账点（0→1）');
      eq(after[after.length - 1]?.media_path, txt, 'A-d-32 失败账也带盘上路径（补发走件、不是发文件名）');
      eq(after[after.length - 1]?.last_error, '平台返回 400：文件过大', 'A-d-33 补发账上记的就是真因');
      const rows = convRows(w.db);
      eq(rows.length, 1, 'A-d-34 失败那次也恰一行对话（既不多落，也不静默）');
      eq(rows.filter((x) => x.status === 'sent').length, 0,
        'A-d-35 ★**一行 `sent` 都没有**（失败不许留下"已发送"的假行——那正是"看起来发出去了其实没到"）');
      eq(rows[0]?.status, 'failed', 'A-d-36 到场的那行如实标 `failed`');
    }

    // ④ 入口守则：路径/渠道不合法时**什么都不落**（连账都不记——这不是"发送失败"，是"这条请求不成立"）
    {
      const w = world('qqbot');
      const deps: ManualSendDeps = { db: w.db, adapters: new Map([[w.channelId, w.mk({ withMedia: true })]]) };
      const base = { channelId: w.channelId, externalUserId: 'u3' };
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ filePath: 'relative/a.png' }, 'BAD_REQUEST'],
        [{ filePath: path.join(tmp, 'nope.png') }, 'FILE_NOT_FOUND'],
        [{ filePath: tmp }, 'FILE_NOT_FOUND'],
        [{ filePath: '' }, 'NO_CONTENT'],
        [{ filePath: '   ' }, 'NO_CONTENT'],
        [{ filePath: png, channelId: '' }, 'BAD_REQUEST'],
        [{ filePath: png, externalUserId: '' }, 'BAD_REQUEST'],
        [{ filePath: png, channelId: 'ch-unknown' }, 'NOT_FOUND'],
      ];
      for (const [arg, want] of cases) {
        const r = await sendManualImMedia(deps, { ...base, ...arg } as never);
        eq('error' in r ? r.error.code : 'ok', want, `A-d-37 入口守则 ${JSON.stringify(Object.keys(arg)[0])}=${JSON.stringify(Object.values(arg)[0])} ⇒ ${want}`);
      }
      // 渠道在册但适配器没跑（名册为空）
      const r2 = await sendManualImMedia({ db: w.db, adapters: new Map() }, { channelId: w.channelId, externalUserId: 'u3', filePath: png });
      eq('error' in r2 ? r2.error.code : 'ok', 'NO_ADAPTER', 'A-d-38 渠道在册但适配器没跑 ⇒ 如实说"未运行"（不是"发送失败"）');
      eq(w.calls.length, 0, 'A-d-39 ★入口被挡下的请求**一次适配器调用都没有**（不成立的事不去惊动网络）');
      eq(outboxRows(w.db).length, 0, 'A-d-40 ★入口被挡下的请求**一条账都不落**（不成立 ≠ 失败；否则界面上多出一批永远补发不掉的账）');
      eq(convRows(w.db).length, 0, 'A-d-41 也没有到场行（"不成立"不该在对话里留下任何痕迹）');
    }

    // ⑤ 与外发路同尺：`sendManualImMessage` 的失败记账**形状**没被本轮改坏
    {
      const src = RD(`${A}/src/main/core/im/manual-send.ts`);
      ok(/^export \{[^}]*IM_SEND_TEXT_LIMIT[^}]*\} from '\.\/im-text\.js'/m.test(src),
        'A-d-42 文本那条路的长度真源仍从 `./im-text.js` 转出（界面在哪儿拦；适配器就在哪儿截）');
      eq(/function clipWithNotice\(/.test(src), false, 'A-d-43 本文件**不**定义 `clipWithNotice`（截断点只此一处，在 `im-text.ts`）');
      eq(/'failed'/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')),
        false, 'A-d-44 ★本文件零处 `\'failed\'` 字面量（失败**只走**唯一记账点，不另开写者）');
      ok(/enqueueImOutbox\(db, \{ channelId, externalUserId, taskId: '', kind: 'manual_reply'/.test(src),
        'A-d-45 文本路的失败记账语句形状未变（taskId 传空 ＝ 手发不属于任何任务）');
      ok(/recordConversation: false/.test(src), 'A-d-46 两条手发路都传 `recordConversation:false`（落账归本文件）');
    }
    void okJson;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ══════════════════════════════════════════════════════════════════
// 【A-e】往返：生产写出的那一行，生产读得出来
// ══════════════════════════════════════════════════════════════════
async function groupAe(): Promise<void> {
  console.log('\n【A-e】往返（**在生产写出的行上**验，禁自造入参）');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr630-rt-'));
  try {
    const png = fixtureFile(tmp, '截图.png', 256);
    const w = world('qqbot');
    const deps: ManualSendDeps = { db: w.db, adapters: new Map([[w.channelId, w.mk({ withMedia: true })]]) };
    await sendManualImMedia(deps, { channelId: w.channelId, externalUserId: 'u9', filePath: png });
    const written = String(convRows(w.db)[0]?.message_json ?? '');
    const ref = imMediaOf(written);
    ok(!!ref, 'A-e-1 生产写出的出站行，生产**认得出**这是一件');
    eq(ref?.render, 'image', 'A-e-2 认得出该出**缩略图**');
    eq(ref?.family, 'image', 'A-e-3 族也对');
    eq(ref?.path, png, 'A-e-4 盘上路径原样带出（界面据此才打得开）');
    eq(ref?.fileName, '截图.png', 'A-e-5 件名原样带出');
    eq(ref?.sizeBytes, undefined, 'A-e-6 ★出站形状**没有** size 字段 ⇒ 不给 `sizeBytes`（宁可少一行，也不编一个 0B）');
    eq(ref?.error, undefined, 'A-e-7 到手了的件不带"未到手"的错因');

    // 入站扁平形状（`im-router` 写的那一种）四标本
    const inbound: Array<[Record<string, unknown>, string, string]> = [
      [{ kind: 'image', file_name: '照片.jpg', size_bytes: 12345, saved_path: '/x/attachments/20260930/照片.jpg' }, 'image', ''],
      [{ kind: 'voice', file_name: '语音.amr', saved_path: '/x/attachments/20260930/语音.amr' }, 'audio', ''],
      [{ kind: 'file', file_name: '报告.pdf', saved_path: '/x/attachments/20260930/报告.pdf' }, 'file', ''],
      [{ kind: 'image', file_name: '坏图.png', media_error: '落盘失败：磁盘满' }, 'image', '落盘失败：磁盘满'],
    ];
    for (const [obj, wantRender, wantErr] of inbound) {
      const r = imMediaOf(JSON.stringify(obj));
      eq(r?.render, wantRender, `A-e-8 入站 ${String(obj.kind)}/${String(obj.file_name)} ⇒ ${wantRender}`);
      eq(r?.error ?? '', wantErr, `A-e-9 入站错因如实带出（${wantErr || '无'}）`);
    }
    eq(imMediaOf(JSON.stringify({ text: 'hi' })), null, 'A-e-10 普通文本行不是件（不猜）');
    eq(imMediaOf('{坏 JSON'), null, 'A-e-11 坏 JSON 不抛、也不假装是件');
    eq(imMediaOf(JSON.stringify({ kind: 'image' })), null, 'A-e-12 ★只有 kind、既无路径也无错因 ⇒ 不是一件（缺"在哪儿"就不是件）');
    eq(
      imMediaOf(JSON.stringify({ text: '📎 a.png', media: { kind: 'image', name: 'a.png', path: '/x/a.png' } }))?.render,
      'image', 'A-e-13 出站嵌套形状（`im-outbox.mediaJson` 的写法）也认得出',
    );
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ══════════════════════════════════════════════════════════════════
// 【A-f】如实：件未到手要写原因 · 大小不编数 · 取消不算失败
// ══════════════════════════════════════════════════════════════════
function groupAf(): void {
  console.log('\n【A-f】如实（未到手写原因 / 不编数字 / 取消不是失败）');
  const bubble = RD(`${A}/renderer/src/components/ImMediaBubble.tsx`);
  ok(/if \(media\.error\)/.test(bubble), 'A-f-1 件控件**先判** `media.error`');
  const iErr = bubble.indexOf('if (media.error)');
  const iRet = bubble.indexOf('return (\n    <div className="rounded border border-gray-200');
  ok(iErr >= 0 && iRet > iErr, 'A-f-2 ★"没到手"的分支**早于**正常渲染（顺序反了 = 把真因淹掉）');
  ok(bubble.includes('件未到手'), 'A-f-3 用**人话**写出原因，不显示成普通文本');
  ok(/对方发的是/.test(bubble), 'A-f-4 连"对方发的是什么"一起说（件名在，用户才知道要不要让对方重发）');
  ok(/preview|预览不了/.test(bubble), 'A-f-5 读字节失败说"预览不了"而**不是**"件坏了"（两种话分开说）');

  eq(formatMediaSize(-1), '', 'A-f-6 ★未知大小 ⇒ 空串（不编一个 0B）');
  eq(formatMediaSize(834), '834B', 'A-f-7 小件照字节显示');
  ok(formatMediaSize(12345).endsWith('KB'), 'A-f-8 千字节档');
  ok(formatMediaSize(5 * 1024 * 1024).endsWith('MB'), 'A-f-9 兆字节档');

  ok(audioPlayNote('.amr').length > 0, 'A-f-10 微信语音 `.amr` 浏览器解不了 ⇒ **必须说**（按下去没反应的播放条会被读成"件丢了"）');
  eq(audioPlayNote('.mp3'), '', 'A-f-11 能直接放的格式不啰嗦');

  // 取消不算失败：`ipcCall` 见 `error` 即抛 ⇒ 取消必须是 `data`（否则"我点了取消"变成红字失败）
  const ipc = RD(`${A}/src/main/ipc/im.ipc.ts`);
  ok(/picked\.canceled[\s\S]{0,80}return \{ data: \{ saved: false, cancelled: true \} \}/.test(ipc),
    'A-f-12 ★「另存」被用户取消 ⇒ 以 `data` 回报（走 `error` 会被 `ipcCall` 抛成一次假失败）');
  ok(/showItemInFolder|showSaveDialog|shell\.openPath/.test(ipc), 'A-f-13 三条出口各有其职：打开 / 另存 / 在文件夹中显示');
  const ipcLib = RD(`${A}/renderer/src/lib/ipc.ts`);
  for (const ch of ['im:sendMedia', 'im:mediaRead', 'im:mediaOpen', 'im:mediaSave']) {
    ok(ipcLib.includes(`'${ch}'`), `A-f-14 渲染层有 \`${ch}\` 的出口`);
  }
  eq((ipc.match(/ipcMain\.handle\('im:media(Read|Open|Save)'/g) ?? []).length, 3, 'A-f-15 main 侧三个只读/另存 handler 都在册');
  ok(/ipcMain\.handle\('im:sendMedia'/.test(ipc) && /sendManualImMedia\(/.test(ipc),
    'A-f-16 `im:sendMedia` 是**接线**（handler 只做接线，判定与落库在下游一处）');

  // 预览判据复用：图片走成果预览那张白名单／音频走族上限（不另写第二份 MIME 表 + 10MB）
  ok(/resolveImagePreview/.test(ipc) && /resolveAudioPreview/.test(ipc),
    'A-f-17 内联与否**复用既有两把尺**（图片白名单 / 音频上限），不另写一份');
  const io = {
    statSync: (p: string) => fs.statSync(p),
    readFileSync: (p: string) => fs.readFileSync(p),
  };
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rr630-aud-'));
  try {
    const mp3 = fixtureFile(tmp2, 'a.mp3', 32);
    const r1 = resolveAudioPreview(mp3, 'a.mp3', io);
    eq(r1.ok && r1.mime, 'audio/mpeg', 'A-f-18 认得出的音频 ⇒ 可内联，MIME 从表里出');
    const big = fixtureFile(tmp2, 'big.wav', 64);
    const r2 = resolveAudioPreview(big, 'big.wav', { statSync: () => ({ isFile: () => true, size: 999 * 1024 * 1024 }), readFileSync: () => ({ toString: () => '' }) });
    eq(r2.ok, false, 'A-f-19 超上限 ⇒ 拒');
    eq(!r2.ok ? r2.reason : '', 'oversize', 'A-f-20 超限的**理由**与"不支持的格式"分得开（不让用户以为件本身坏了）');
    void mp3;
  } finally { fs.rmSync(tmp2, { recursive: true, force: true }); }
}

// ══════════════════════════════════════════════════════════════════
// 【B】M2 · IM 的实时与归属
// ══════════════════════════════════════════════════════════════════

/**
 * B 组夹具：一张能真跑 `routeImMessage` 的最小世界（列照抄 `database.ts` DDL，NOT NULL 不省）。
 * 每场景**一个不同的 fromUser**——风暴闸按 fromUser 计、去重键按 `渠道:用户:正文` 计，
 * 换人即天然隔开，无需 sleep（G-4：不依赖真实墙钟）。
 */
const B_SCHEMA = `
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, description TEXT,
  status TEXT, context_json TEXT, updated_at TEXT, priority INTEGER);
CREATE TABLE wa_task_conversations (id TEXT, task_id TEXT, role TEXT, content TEXT,
  token_count INTEGER, created_at TEXT);
CREATE TABLE wa_jobs (id TEXT, type TEXT, payload TEXT, status TEXT);
CREATE TABLE wa_im_conversations (id TEXT, channel_id TEXT, external_user_id TEXT,
  message_json TEXT, direction TEXT, created_at TEXT, task_id TEXT DEFAULT '');
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT, name TEXT, config TEXT, status TEXT);
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
`;
const CH_IM = 'wechat-personal';
function bdb(): AnyDb { const d = new DatabaseSync(':memory:') as unknown as AnyDb; d.exec(B_SCHEMA); return d; }
/** 造一张 paused 任务；`ageDays` 用来把 `updated_at` 拨旧（旧口径正是按它挑）。 */
function bTask(db: AnyDb, id: string, user: string, title: string, ageDays = 0): void {
  const age = ageDays === 0 ? "datetime('now')" : `datetime('now','-${ageDays} days')`;
  db.prepare(`INSERT INTO wa_tasks (id, project_id, title, status, context_json, updated_at, priority)
    VALUES (?, 'p1', ?, 'paused', ?, ${age}, 0)`)
    .run(id, title, JSON.stringify({ source: 'im', channel: CH_IM, externalUser: user }));
}
/** 一条「本会话最近交互过的 run」证据——`handleAgentReply` 自己写的就是这个形状（`[IM回复]`）。 */
function bReply(db: AnyDb, taskId: string, text: string): void {
  db.prepare(`INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at)
    VALUES (?, ?, 'user', ?, 0, datetime('now'))`).run(`c-${taskId}-${crypto.randomUUID()}`, taskId, `[IM回复] ${text}`);
}
const bConvs = (db: AnyDb) =>
  db.prepare('SELECT task_id, content FROM wa_task_conversations ORDER BY rowid').all() as Array<{ task_id: string; content: string }>;
/** 入站对话行（IM 页上用户看到的那一句自带标牌的那一行）——M2-c 的正面断言读它。 */
const bInbound = (db: AnyDb) =>
  db.prepare("SELECT task_id, message_json FROM wa_im_conversations WHERE direction='inbound' ORDER BY rowid").all() as Array<{ task_id: string; message_json: string }>;
/** 一个渠道行——`sendManualImMessage` 就是从这里读 `channel_type` 去查上限表的。 */
function bChannel(db: AnyDb, id: string, channelType: string): void {
  db.prepare('INSERT INTO wa_im_channels (id, channel_type, name, config, status) VALUES (?, ?, ?, ?, ?)')
    .run(id, channelType, channelType, '{}', 'active');
}
const bJobs = (db: AnyDb) =>
  (db.prepare("SELECT payload FROM wa_jobs WHERE type='resume-ai-task'").all() as Array<{ payload: string }>)
    .map(j => JSON.parse(j.payload) as { taskId: string });
function bCtx(db: AnyDb, replies: string[]) {
  return { db, channelId: 'ch-b', channelType: CH_IM, sendReply: async (_t: string, t: string) => { replies.push(t); } };
}

/** 出站补偿与乐观气泡凭真行退场：读 IM 页**原文**（G-5：不去注释，锚点钉符号/语句形状）。 */
function groupBa(): void {
  console.log('\n【B-a】出站补偿：`im.message_outbound` → 短窗重取；乐观气泡**凭真行**退场');
  const page = RD(`${A}/renderer/src/pages/IMPage.tsx`);
  ok(page.length > 10_000, 'B-a-1 扫描面自证：IM 页源码非空（否则下面全是空转假绿）', `${page.length} 字节`);

  // 出站事件不再"取一次就算"（事件与 INSERT 是两条路，时机不保证）
  ok(/event\.type === 'im\.message_outbound'\) refetchOutboundSoon\(cid\)/.test(page),
    'B-a-2 ★出站事件触发**短窗重取**（不是 `prependNewConvs` 取一次就了事）');
  ok(/function refetchOutboundSoon\(channelId: string\)/.test(page), 'B-a-3 `refetchOutboundSoon` 在场');
  ok(/i < 2\) setTimeout\(\(\) => step\(i \+ 1\), 800\)/.test(page),
    'B-a-4 ★短窗＝"立即一次 + 两档补取"（有界重试，不是无限轮询）');
  ok(/const gen = \+\+outboundGenRef\.current/.test(page) && /outboundGenRef\.current !== gen/.test(page),
    'B-a-5 ★代际号：新出站事件**作废**旧链（不叠加请求、不交错写回旧屏）');
  ok(/convChannelRef\.current !== channelId/.test(page), 'B-a-6 用户已切走 ⇒ 停（不给已经离开的那一屏打请求）');
  ok(/document\.visibilityState !== 'visible'/.test(page), 'B-a-7 页面不可见 ⇒ 停（与 30s 自愈轮询同一口径）');

  // 乐观气泡的退场条件
  ok(/Promise<\{ ok: boolean; landed: boolean \}>/.test(page),
    'B-a-8 ★`prependNewConvs` **回传** `landed`（取数成没成 ≠ 真行到没到）');
  ok(/const landed = !expect \|\| list\.some\(/.test(page),
    'B-a-9 ★`landed` 判在**服务端返回的那一页**（`list`）上——判合并后的 `prev` 会把上一轮的行读成这一次');
  ok(/const landed = [^;]*c\.direction === 'outbound'/.test(page),
    'B-a-10 ★真行身份第一要素：方向是出站');
  ok(/const landed = [^;]*\(Number\(c\.seq\) \|\| 0\) > expect\.afterSeq/.test(page),
    'B-a-11 ★真行身份第二要素：seq **大于**按下发送前的最大 seq（挡掉"上一轮同正文的行"）');
  ok(/const landed = [^;]*jsonTextOf\(c\.message_json\) === expect\.text/.test(page),
    'B-a-12 ★真行身份第三要素：正文**逐字相同**（三要素缺一即认错行）');
  ok(/p\.filter\(o => o\.key !== key\)\s+\/\/ 真行到场，占位退场/.test(page),
    'B-a-13 ★**只有** landed 才退场（"取数没报错"不再等于"行到了"）');
  ok(/sent: !failure/.test(page), 'B-a-14 气泡记下"发送那一跳本身成没成"');
  ok(/\{o\.sent\?'已发出，真行未见':'未送达'\}/.test(page),
    'B-a-15 ★两种没退场**分开措辞**：「未送达」与「已发出，真行未见」不是一件事');
  ok(/o\.failed\?\(o\.sent\?'bg-amber-50':'bg-red-50'\)/.test(page),
    'B-a-16 ★颜色也分开：真失败红、只是没取到黄（同一形状的假话不允许）');
  eq((page.match(/function jsonTextOf\(/g) ?? []).length, 1,
    'B-a-17 ★正文解析**只定义一处**（`jsonTextOf`）——两处各写一份 `JSON.parse` 即两把尺');
  ok((page.match(/jsonTextOf\(/g) ?? []).length >= 2, 'B-a-18 且**被真的用来判退场**（定义了不用＝没接上）');
  ok(/📎 \$\{name\}/.test(page), 'B-a-19 手发件的期望正文＝`📎 件名`（与 `im-outbox.entryPreview` 同一串）');
}

/** 归属消歧：由"猜"改"指认"——驱动生产入口 `routeImMessage`，正反两侧各一只真标本。 */
async function groupBb(): Promise<void> {
  console.log('\n【B-b】归属消歧：无据不猜（`routeImMessage` 真跑，禁自造入参）');
  const router = RD(`${A}/src/main/services/im-router.ts`);
  ok(router.length > 20_000, 'B-b-1 扫描面自证：`im-router.ts` 源码非空', `${router.length} 字节`);
  eq(/task = selectTask\('', \[\]\)/.test(router), false,
    'B-b-2 ★旧的无据兜底（`selectTask(\'\', [])`）**已删**——按 `updated_at` 挑一张就是"没有归属依据"');
  ok(/function lastInteractedTaskId\(/.test(router), 'B-b-3 第二档「最近一次交互过的 run」反查在场');
  ok(/REPLY_CANDIDATE_LIMIT/.test(router), 'B-b-4 候选数上限是一个有界的具名常量');
  ok(/这句话该归哪一个？请回复编号/.test(router), 'B-b-5 仍歧义 ⇒ **如实回问**（不猜）');
  ok(/const list = listResumableTasks\(db, ctx\.channelType, fromUser\)/.test(router),
    'B-b-6 ★回问列的编号**就是** `listResumableTasks` 那一份（与"按编号恢复"同一清单，否则答非所问）');

  // ── 标本一：两候选 + 有交互证据 ⇒ 指认到"交互过的那个"，**不是**最新的那个 ──
  {
    const u = 'b_u_identify';
    const db = bdb();
    bTask(db, 'older', u, '早先那张', 1);   // updated_at 拨旧 1 天
    bTask(db, 'newest', u, '最新那张', 0);  // updated_at 最新 —— 旧口径一定会挑它
    bReply(db, 'older', '先前那句');
    const replies: string[] = [];
    await routeImMessage(bCtx(db, replies) as never, u, '把报告改成中文', 'private', '');
    const routed = bConvs(db).filter(c => c.content === '[IM回复] 把报告改成中文');
    eq(routed.length, 1, 'B-b-7 自由回复**恰**落一处');
    eq(routed[0]?.task_id, 'older',
      'B-b-8 ★★归属到"本会话最近交互过的 run"，而**不是** `updated_at` 最新的那张（旧口径必错的那一格）');
    eq(bJobs(db).map(j => j.taskId), ['older'], 'B-b-9 恢复作业同样定向到"交互过的那个"');
    eq(replies.filter(r => r.includes('该归哪一个')).length, 0, 'B-b-10 有据可指认时不回问（问了就是白问）');
  }

  // ── 标本二：两候选 + 无任何交互证据 ⇒ **如实回问**，且不落任何账 ──
  {
    const u = 'b_u_ambiguous';
    const db = bdb();
    bTask(db, 'a2', u, '甲任务');
    bTask(db, 'b2', u, '乙任务');
    const replies: string[] = [];
    await routeImMessage(bCtx(db, replies) as never, u, '把报告改成中文', 'private', '');
    ok(replies.some(r => r.includes('该归哪一个') && r.includes('2 个挂起的任务')),
      'B-b-11 ★★无据时**回问**并如实说出候选数（不挑一个了事）', replies.join(' | ').slice(0, 60));
    eq(bConvs(db).filter(c => c.content.startsWith('[IM回复]')).length, 0,
      'B-b-12 ★回问时**零**处落 `[IM回复]`（问了就不许已经替用户定了）');
    eq(bJobs(db).length, 0, 'B-b-13 ★回问时**不建**任何恢复作业（不猜＝真的不动）');
  }

  // ── 标本三：只有一个候选 ⇒ 无歧义，直接定向（不必也不该回问） ──
  {
    const u = 'b_u_single';
    const db = bdb();
    bTask(db, 'solo', u, '独苗任务');
    const replies: string[] = [];
    await routeImMessage(bCtx(db, replies) as never, u, '把报告改成中文', 'private', '');
    eq(bConvs(db).filter(c => c.content === '[IM回复] 把报告改成中文').map(c => c.task_id), ['solo'],
      'B-b-14 单候选 ⇒ 无歧义，直接定向（"只有一个"本身即依据）');
    eq(bJobs(db).map(j => j.taskId), ['solo'], 'B-b-15 作业也定向到它');
    eq(replies.filter(r => r.includes('该归哪一个')).length, 0, 'B-b-16 单候选时不回问（问了是噪音）');
  }
}

/**
 * M2-c 归属标牌：**只在真知道时标**。
 *   一列（`task_id`）+ 两处写点（出站通知行 / 入站回复行）+ 一处显示（IM 页小标牌）——
 *   少了任何一处，"这句话属于哪个任务"要么永远空白，要么被编出来（**不猜**是本条的一半）。
 *   正反两侧各一只标本：标得上**与**标不上，都各自断言。
 */
async function groupBc(): Promise<void> {
  console.log('\n【B-c】归属标牌：真知道的两处才标（不知道＝不标，不猜）');

  // ── 列与迁移 ──
  const dbSrc = RD(`${A}/src/main/database.ts`);
  const ddl = dbSrc.slice(dbSrc.indexOf('CREATE TABLE IF NOT EXISTS wa_im_conversations'), dbSrc.indexOf('CREATE TABLE IF NOT EXISTS wa_deliverables'));
  ok(/task_id TEXT DEFAULT ''/.test(ddl), 'B-c-1 ★建表 DDL 的会话表**含 `task_id`**（空串=本条无归属）');
  ok(dbSrc.includes("ALTER TABLE wa_im_conversations ADD COLUMN task_id TEXT DEFAULT ''"),
    'B-c-2 ★旧库迁移那一句在册（只改建表不改迁移 ⇒ 老库永远没有这一列）');

  // ── 形状收进唯一落点 ──
  const rec = RD(`${A}/src/main/core/im/outbound-record.ts`);
  ok(/INSERT INTO wa_im_conversations[\s\S]{0,200}?task_id/.test(rec),
    'B-c-3 ★落点那一句 INSERT **列清单含 task_id**（出站行形状一处定义，非九份）');
  // `undefined` 收敛到空串这件事必须发生在**落点这一句的绑定值**上（9 家调用方就都自动继承，
  // 不必各自记得传 `''`）。断言钉绑定值本身，不钉某个对象字面量键——键名是可改的语法外壳。
  ok(/\.run\([\s\S]{0,240}?o\.taskId \|\| ''/.test(rec),
    "B-c-4 ★**不传＝空串**（\"不知道\"落成\"无归属\"，不是别的什么；收敛在落点，非各调用方自负）");
  eq(['wechat', 'dingtalk', 'wecom', 'feishu', 'qqbot']
      .map((n) => RD(`${A}/src/main/services/${n}-adapter.ts`).includes('INSERT INTO wa_im_conversations')),
    [false, false, false, false, false],
    'B-c-5 ★五家适配器**零内联**出站 INSERT（原 9 处拷贝已全部迁入落点）');

  // ── 契约与两处写点 ──
  ok(/taskId\?: string;/.test(RD(`${A}/src/main/services/im-adapter.ts`)),
    'B-c-6 `ImSendOpts` 上有 `taskId?`（适配器转交下去的唯一通道）');
  ok(/adapter\.sendReply\(toUser \|\| '', message, undefined, taskId \? \{ taskId \} : undefined\)/.test(RD(`${A}/src/main/ipc/im.ipc.ts`)),
    'B-c-7 ★写点一：`sendImCompletionNotice` 把**手里本就有**的 `taskId` 交下去（此前一路丢弃）');
  ok(/UPDATE wa_im_conversations SET task_id = \? WHERE id = \?/.test(RD(`${A}/src/main/services/im-router.ts`)),
    'B-c-8 ★写点二：`handleAgentReply` 把归属写回**入站那一行**（投递那一刻的事实，非事后猜）');

  // ── 取数与显示 ──
  ok(/export function attachTaskTitles\(/.test(RD(`${A}/src/main/core/im/im-conversations-query.ts`)),
    'B-c-9 任务名由 `attachTaskTitles` 补（**不 JOIN 分页 SQL**——那条形状被前序 rr 逐字钉死）');
  ok(/attachTaskTitles\(db, listConversations\(/.test(RD(`${A}/src/main/ipc/im.ipc.ts`)),
    'B-c-10 ★handler 真的调它（定义了不调 ⇒ 标牌永远空白）');
  const page = RD(`${A}/renderer/src/pages/IMPage.tsx`);
  ok(/interface Conversation \{[^}]*task_id\?: string/.test(page), 'B-c-11 渲染侧类型收到 `task_id`');
  ok(/\{c\.task_id&&<span className="ml-1 px-1 rounded bg-gray-200/.test(page),
    'B-c-12 ★标牌**只在 `task_id` 非空时出现**（空串＝无归属 ⇒ 界面上什么都不说，不替它编一个）');

  // ── 行为一：落点函数本体（真库，两只标本一起试）──
  {
    const db = bdb();
    recordOutboundConversation(db as never, { channelId: 'ch-b', channelType: CH_IM, externalUserId: 'u1', messageJson: { text: '知道了' }, taskId: 'T-1' });
    recordOutboundConversation(db as never, { channelId: 'ch-b', channelType: CH_IM, externalUserId: 'u1', messageJson: { text: '不知道' } });
    const rows = db.prepare("SELECT task_id, message_json FROM wa_im_conversations WHERE direction='outbound' ORDER BY rowid").all() as Array<{ task_id: string; message_json: string }>;
    eq(rows.map((r) => r.task_id), ['T-1', ''],
      'B-c-13 ★**真知道就标、不知道就空**（用"只试不传的那只"验不出过宽实现，两只必须一起试）');
  }

  // ── 行为二：入站标牌——真跑 `routeImMessage`，正反各一只 ──
  const marked = bdb();
  {
    const u = 'b_u_mark_single';
    bTask(marked, 'only', u, '唯一那张');
    const replies: string[] = [];
    await routeImMessage(bCtx(marked, replies) as never, u, '把报告改成中文', 'private', '');
    const inb = bInbound(marked);
    eq(inb.length, 1, 'B-c-14 入站行恰一条（前置：下面的标牌断言有唯一对象）');
    eq(inb[0]?.task_id, 'only',
      'B-c-15 ★★**0 → 1** 的正面断言：这句话归属到哪张任务，就标在它自己那一行上');
  }
  {
    const u = 'b_u_mark_ambiguous';
    const db = bdb();
    bTask(db, 'a3', u, '甲任务');
    bTask(db, 'b3', u, '乙任务');
    const replies: string[] = [];
    await routeImMessage(bCtx(db, replies) as never, u, '把报告改成中文', 'private', '');
    ok(replies.some((r) => r.includes('该归哪一个')), 'B-c-16 前置：这一格确实走到了回问');
    eq(bInbound(db)[0]?.task_id, '',
      'B-c-17 ★★反向标本：**回问时不许已经替用户定了归属**（标了就是"问了却已定"，与不猜相冲）');
  }

  // ── 行为三：任务名那一趟（`attachTaskTitles`，真实现 + 生产入参形状）──
  {
    const rows = bInbound(marked).map((r) => ({ ...r })) as Array<Record<string, unknown>>;
    rows.push({ task_id: 'nonexistent-task', message_json: '{}' });  // 任务已删/查无
    rows.push({ task_id: '', message_json: '{}' });                  // 无归属
    attachTaskTitles(marked as never, rows);
    eq(rows[0]?.task_title, '唯一那张', 'B-c-18 ★标牌取到真任务名（查询按 `task_id` 一对一）');
    eq(rows[1]?.task_title, '', 'B-c-19 ★查无此任务 ⇒ **空串**（不猜一个标题填上去）');
    eq('task_title' in (rows[2] as object), false,
      'B-c-20 ★无归属的行**根本不带** `task_title` 键（不查、不编）');
  }
}

// ══════════════════════════════════════════════════════════════════
// 【B-d】M2-d 长文本发落：有上限才截（并告知）、无上限只提示（不截）
// ══════════════════════════════════════════════════════════════════
async function groupBd(): Promise<void> {
  console.log('\n【B-d】长文本发落：有上限才截并告知 / 无上限不截只提示（静默原样发送是病）');
  const imText = RD(`${A}/src/main/core/im/im-text.ts`);

  // ── 结构：发落判据只许一处；五家出站**全通道**都从这里过 ──
  ok((imText.match(/export function fitOutboundText\(/g) ?? []).length === 1,
    'B-d-1 ★发落函数 `fitOutboundText` 在真源内**恰一份**（"该不该动这条正文"只此一处判）');
  ok(/export const IM_TEXT_NOTICE_THRESHOLD\b/.test(imText) && /export function overlongKeptNotice\(/.test(imText),
    'B-d-2 ★告知阈值与它的那句话**同落一处** `im-text.ts`（与上限表同文件，但**不是同一个键**）');
  // 接线那一跳：五家适配器**各自**真的调了它（等价性证不了"接上了"——只建函数不调，全量照样全绿）
  const WIRING: Array<[string, string]> = [
    ['qqbot', 'qqbot'], ['dingtalk', 'dingtalk'], ['wecom', 'wecom'],
    ['feishu', 'feishu'], ['wechat', 'wechat-personal'],
  ];
  for (const [file, ctype] of WIRING) {
    const src = RD(`${A}/src/main/services/${file}-adapter.ts`);
    ok(new RegExp(`fitOutboundText\\('${ctype}'`).test(src),
      `B-d-3 ★接线：${file}-adapter 的 sendReply 走 \`fitOutboundText('${ctype}', …)\`（"全通道"须逐家在场，不是"我改了那个函数"）`);
  }
  // 反证按**代码行**判定（逐行滤掉整行注释），不按"字面量全文搜"——否则解释用的一句
  // 注释（"与 `IM_SEND_TEXT_LIMIT` 读同一张表"）会自己把判据判红，唯一"解法"是删掉说明。
  // 同仓 zx_20260916_1 的老教训：**负面子串断言会被订正注释自己判红**。
  const codeRows = (src: string): string[] =>
    src.split('\n').filter((l) => { const t = l.trimStart(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); });
  eq(WIRING.filter(([f]) => codeRows(RD(`${A}/src/main/services/${f}-adapter.ts`)).some((l) => /IM_SEND_TEXT_LIMIT|clipWithNotice/.test(l))), [],
    'B-d-4 ★反证：五家适配器**代码行内**都不再直接读上限表 / 直接调截断（读了就等于各自还能决定"要不要截"，发落又散了）');
  // QQ 落账用的是**定形后**那串（此前发 4000 字、账里 4700 字，同一件事两个值）。
  // 锚点取 **sendReply 方法体**：本文件另一处 `recordOutboundConversation`（发件那条）在前，
  // 全文 indexOf 会匹到它 ⇒ 位置比较毫无意义（这是"锚点按符号定"而非"按首次出现定"）。
  {
    const qq = codeRows(RD(`${A}/src/main/services/qqbot-adapter.ts`)).join('\n');
    const bodyStart = qq.indexOf('async sendReply(');
    ok(bodyStart > 0, 'B-d-5 前置：切到 QQ 的 `sendReply` 方法体（否则下面的位置比较是空转）');
    const body = qq.slice(bodyStart);
    const at = body.indexOf("text = fitOutboundText('qqbot', text).text");
    const rec = body.indexOf('recordOutboundConversation(this.db');
    ok(at > 0 && rec > at,
      'B-d-5 ★QQ **先定形、再落账**（顺序即事实：账里那串 = 用户收到那串，不是原文）',
      `体内定形@${at} < 落账@${rec}`);
  }

  // ── 行为：真实现 + 两只标本（"该命中"/"该不命中"必须一起试，否则过宽变体全票通过）──
  {
    const LIMIT = IM_SEND_TEXT_LIMIT.qqbot!;
    const THRESHOLD = IM_TEXT_NOTICE_THRESHOLD;

    // ① 有上限且超限 ⇒ 截断 + 告知（**且不许**说成"未截断"）
    const longForLimited = '甲'.repeat(LIMIT + 300);
    const cut = fitOutboundText('qqbot', longForLimited);
    eq(cut.truncated, true, 'B-d-6 有登记上限且超限 ⇒ **截断**（截的那一态）');
    ok(cut.text.length <= LIMIT, 'B-d-7 截断结果恒 ≤ 上限（标记在额度内）', `${cut.text.length} ≤ ${LIMIT}`);
    ok(cut.text.includes('已截断'), 'B-d-8 ★截断时**如实告知**（不是"看起来完整"的一份）');
    ok(!cut.text.includes(KEPT_NOTICE_TAIL), 'B-d-9 ★**该不命中**：截断那一态不得同时贴"未截断"（两句话互斥）');

    // ② 无上限且超阈值 ⇒ **一字不动**，只附一句"未截断"
    const longForFree = '乙'.repeat(THRESHOLD + 300);
    const kept = fitOutboundText('wechat-personal', longForFree);
    eq(kept.truncated, false, 'B-d-10 ★无已知上限 ⇒ **不截**（不替平台猜一个上限）');
    eq(kept.text.startsWith(longForFree), true,
      'B-d-11 ★★本轮的靶心：用户的话**一个字没动**（全文在场，只是在后面接了句说明）');
    eq(kept.originalLength, longForFree.length, 'B-d-12 原长如实记下（"没说没少"的依据）');
    ok(kept.text.endsWith(KEPT_NOTICE_TAIL) && kept.text.includes(`本条 ${longForFree.length} 字`),
      'B-d-13 ★★附的那句带**真字数**且写明"未截断"');
    ok(!kept.text.includes('已截断'),
      'B-d-14 ★★**该不命中**：没截就不许说"已截断"——那正是反方向的谎（静默的反面不是撒谎）');
    eq(kept.overlongNoted, true, 'B-d-15 账上记得住"这条附过说明"（界面回执据此如实说）');

    // ③ 无上限但不超阈值 ⇒ 原样（加了就是假警报）
    const short = '丙'.repeat(THRESHOLD);
    const passthrough = fitOutboundText('wechat-personal', short);
    eq(passthrough.text, short, 'B-d-16 恰好等于阈值 ⇒ **原样**（阈值是"越过"，不是"达到"）');
    eq(passthrough.overlongNoted, false, 'B-d-17 未超阈值不许贴说明（一律加标记 = 假警报）');

    // ④ 幂等（适配器与手发都过本函数 ⇒ 第二遍不得再贴一句）
    eq(fitOutboundText('wechat-personal', kept.text).text, kept.text,
      'B-d-18 ★★幂等（无上限那态）：再过一次**不得**再贴一句（否则收件人看到两句"本条 N 字"）');
    eq(fitOutboundText('qqbot', cut.text).text, cut.text,
      'B-d-19 ★幂等（截断那态）：截完已 ≤ 上限，第二遍自然不为所动');
  }

  // ── 手发那条路：账与实物同一串（回执照实说"未截断"，不靠操作者猜）──
  {
    const db = bdb();
    bChannel(db, 'wx1', 'wechat-personal');
    const sent: string[] = [];
    const adapters = new Map<string, unknown>([['wx1', {
      sendReply: async (_to: string, text: string) => { sent.push(text); },
    }]]);
    const longBody = '丁'.repeat(IM_TEXT_NOTICE_THRESHOLD + 120);
    const r = await sendManualImMessage(
      { db: db as never, adapters: adapters as never, emit: () => {} },
      { channelId: 'wx1', externalUserId: 'u_d', text: longBody },
    ) as { data?: { sent?: boolean; note?: string } };
    eq(r.data?.sent, true, 'B-d-20 前置：这一格手发成功');
    const rowText = JSON.parse((db.prepare("SELECT message_json FROM wa_im_conversations WHERE direction='outbound' ORDER BY rowid DESC LIMIT 1").get() as { message_json: string }).message_json).text as string;
    eq(rowText, sent[0],
      'B-d-21 ★★账 = 实物（同一串）：此前落库落用户敲的原文、发出去的是加过说明的那串，正是"同一件事两个值"');
    ok(rowText.startsWith(longBody) && rowText.endsWith(KEPT_NOTICE_TAIL),
      'B-d-22 ★原文完整在场、说明接在尾上（手发也没被截）');
    ok(String(r.data?.note || '').includes('未截断'),
      'B-d-23 ★回执照实说"未截断"（不说，操作者下一句就得问"是不是被截了"）');
  }
  {
    // 负标本：**有**上限的通道超限仍走"界面拦下"（TOO_LONG），不因本轮新增"提示"而放行
    const db = bdb();
    bChannel(db, 'qq1', 'qqbot');
    const adapters = new Map<string, unknown>([['qq1', { sendReply: async () => {} }]]);
    const r = await sendManualImMessage(
      { db: db as never, adapters: adapters as never, emit: () => {} },
      { channelId: 'qq1', externalUserId: 'u_q', text: '戊'.repeat(IM_SEND_TEXT_LIMIT.qqbot! + 1) },
    ) as { error?: { code?: string } };
    eq(r.error?.code, 'TOO_LONG',
      'B-d-24 ★**该不命中**：有上限的通道超限仍**拒发**（"有上限才截"不等于"有上限也照发"）');
  }
}

// ══════════════════════════════════════════════════════════════════
// 【C · M3】成果状态如实（退出复位 / failed 真生产者 / 建成果一处真源 /
//            事件口径 / 类型集合 / 审批选项同源）
// ══════════════════════════════════════════════════════════════════
const C_SCHEMA = `
CREATE TABLE wa_deliverables (
  id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT,
  type TEXT NOT NULL, name TEXT DEFAULT '', description TEXT DEFAULT '',
  file_path TEXT, registry_id TEXT, status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, context_json TEXT DEFAULT '{}');
`;
function cdb(): AnyDb { const d = new DatabaseSync(':memory:') as unknown as AnyDb; d.exec(C_SCHEMA); return d; }
function cDeliv(db: AnyDb, o: { id: string; project?: string; task?: string | null; type: string; name: string; filePath?: string | null; status?: string }): void {
  db.prepare('INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(o.id, o.project ?? 'p1', o.task ?? null, o.type, o.name, o.filePath ?? null, o.status ?? 'draft');
}
const cStatus = (db: AnyDb, id: string): string =>
  (db.prepare('SELECT status FROM wa_deliverables WHERE id = ?').get(id) as { status: string } | undefined)?.status ?? '∅';

/** 抓**生产**起草的事件（`emitDeliverableEvent` 经 eventBus 同步落到订阅者）。 */
function captureEvents<T>(fn: () => T): { result: T; events: AppEvent[] } {
  const seen: AppEvent[] = [];
  const h = (e: AppEvent) => { seen.push(e); };
  eventBus.on('deliverable.status_changed', h);
  eventBus.on('deliverable.registered', h);
  try { return { result: fn(), events: seen }; }
  finally { eventBus.off('deliverable.status_changed', h); eventBus.off('deliverable.registered', h); }
}
/** 按**代码行**读（逐行滤整行注释）——本仓 zx_20260928 教训：正则去注释会静默毁伤整份源码。 */
const cRows = (p: string): string[] =>
  RD(p).split('\n').filter((l) => { const t = l.trimStart(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); });

const P_IPC = `${A}/src/main/ipc/project.ipc.ts`;
// zx_20261004 M15: 守护进程监督整段已纯搬移至 `core/daemon-supervisor.ts`（逐字节行为不变）。
const P_DAEMON = `${A}/src/main/core/daemon-supervisor.ts`;
const P_WRITE = `${A}/src/main/core/tools/write.ts`;
const P_LIFE = `${A}/src/main/core/deliverable-lifecycle.ts`;
const P_TYPES = `${A}/src/main/core/deliverable-types.ts`;
const P_TDPAGE = `${A}/renderer/src/pages/TaskDetailPage.tsx`;

function groupCa(): void {
  console.log('\n【C-a】退出即复位：正常退出不是「仍在运行」');
  const src = cRows(P_IPC).join('\n');
  // 锚点须**唯一**：`exited code=${code}` 在 a2a 那支也出现一次（句尾多 ` signal=`），
  //   用 `[${delivType}:${delivName}]` 前缀把落点钉死在 MCP/服务型这一支上。
  const at = src.indexOf('[${delivType}:${delivName}] exited code=${code}');
  ok(at > 0, 'C-a-1 前置：切到 MCP/服务型成果的 `proc.on(\'exit\')` 体（否则下面的"在场"是空转）');
  // 体end 也须是**代码行**锚（cRows 已滤掉整行注释，注释里的边界文本在面上不存在 ⇒ indexOf 返 -1
  //   会把切片一路吞到文件尾，正向断言假绿、反向断言假红）。`runtimeProcesses.set(id,` 是紧随其后的代码行。
  const bodyEnd = src.indexOf('runtimeProcesses.set(id,', at);
  ok(bodyEnd > at, 'C-a-2 前置：该回调体的结束边界也是代码行（切块锚在去注释面成立）');
  const body = bodyEnd > at ? src.slice(at, bodyEnd) : '';
  ok(/setDeliverableStatus\(db, id, 'stopped', 'deliverable:exit'\)/.test(body),
    'C-a-3 ★退出复位：该回调体内**无条件**落 `stopped`（code 为何都落）');
  ok(!/code\s*!==\s*0/.test(body),
    'C-a-4 ★反证（该不命中）：该体内**不再**有「code 非 0 才写」的旧闸——否则正常退出仍留 `running` 影子');
  // 订正注释里**提到**旧写法是正常的（B-d 的同款教训：负面子串断言会被订正注释自己判红）
  // ⇒ 只在**代码行**面判，且反向标本正面在场：旧写法若真还在，会以代码行出现。
  eq(cRows(P_IPC).filter((l) => /code\s*!==\s*0/.test(l)), [],
    'C-a-5 反证（代码行面）：`code !== 0` 在本文件**代码行**内零处（注释里的历史说明不算在场）');
}

function groupCb(): void {
  console.log('\n【C-b】`failed` 有真生产者（不是把词表删掉了事）');
  // zx_20261004 M15: `handleDaemonExit`/`killOrphan` 与 daemon 启动失败的 `failed` 落点已纯搬移至
  //   `core/daemon-supervisor.ts`。判据语句一字未改，只把扫描面换到该符号**唯一**的新载体。
  const src = cRows(P_DAEMON).join('\n');
  const hdeAt = src.indexOf('function handleDaemonExit(');
  const hdeEnd = src.indexOf('async function killOrphan');
  ok(hdeAt > 0 && hdeEnd > hdeAt, 'C-b-1 前置：切到 `handleDaemonExit` 体');
  const hde = src.slice(hdeAt, hdeEnd);
  // 该命中：启动确认窗内退出 ⇒ failed
  //   切块锚一律取**代码行**（`hde` 是去注释面，注释文本在面上不存在 ⇒ 用注释当边界会 indexOf=-1，
  //   `slice(start,-1)` 反吞到函数尾，把下面那一支的 `'failed'` 算进这一支 ⇒ 正向假绿/反向假红）。
  const sfStart = hde.indexOf('if (runtime < 5_000) {');
  const sfEnd = hde.indexOf('const restartCount = entry.restartCount');
  ok(sfStart > 0 && sfEnd > sfStart, 'C-b-2a 前置：启动失败那一支的切块边界都在**代码行**面成立');
  const sf = sfEnd > sfStart ? hde.slice(sfStart, sfEnd) : '';
  ok(/setDeliverableStatus\(db, id, 'failed', 'daemon:start_fail'\)/.test(sf),
    'C-b-2b ★该命中：**根本没起来**的进程落 `failed`（不是用户停的 `stopped`，也不是跑完的 `completed`）');
  ok(!/'completed'/.test(sf), 'C-b-3 反证：这一支**不**写 `completed`（"没起来"与"跑完了"不能同词）');
  // 该不命中：正常退出 ⇒ completed
  const zStart = hde.indexOf('if (code === 0) {');
  const zero = zStart > 0 ? hde.slice(zStart, sfStart) : '';
  ok(/setDeliverableStatus\(db, id, 'completed', 'daemon:exit'\)/.test(zero),
    'C-b-4 ★该不命中：正常退出（code===0）落 `completed`，不落 `failed`');
  ok(!/'failed'/.test(zero), 'C-b-5 反向标本：正常退出那一支里**没有** `failed`');
  // 0→1 正面断言（不只断言"不抛"）：真写一行，值真的从 running 变 failed，且事件如实带 status
  {
    const db = cdb();
    cDeliv(db, { id: 'dv-f', type: 'mcp', name: 'svc', status: 'running' });
    const { result, events } = captureEvents(() => setDeliverableStatus(db, 'dv-f', 'failed', 'daemon:start_fail'));
    eq([cStatus(db, 'dv-f'), result.changed], ['failed', true],
      'C-b-6 ★0→1 正面断言：`running` → `failed` 真落库（此前全仓零调用 ⇒ 成果页筛选「失败」恒空）');
    eq(events.map((e) => [e.type, e.data.status, e.data.via]),
      [['deliverable.status_changed', 'failed', 'daemon:start_fail']],
      'C-b-7 事件如实：起草 `deliverable.status_changed` 且 payload 的 status/via 与落库那笔同源');
  }
  // 选了"给真生产者"而非"从词表移除"——两条一起断言，防下一轮有人只做半件
  // zx_20261004 M15: 真生产者现分居两载体（守护监督 → daemon-supervisor；MCP/服务型 spawn → project.ipc）。
  //   判据不放松：两载体**合计**仍须 ≥3 处（daemon 启动失败 / 端口占用 / 启动抛错），与判据名一一对应。
  const failedWrites = [...cRows(P_DAEMON), ...cRows(P_IPC)].filter((l) => /setDeliverableStatus\([^)]*,\s*'failed'/.test(l));
  ok(failedWrites.length >= 3, 'C-b-8 ★真生产者**恰多处**在场（daemon 启动失败 / 端口占用 / 启动抛错）', `${failedWrites.length} 处`);
  ok(RD(`${A}/renderer/src/lib/deliverable-view.ts`).includes("failed: '失败'"),
    'C-b-9 词表未删：`failed` 仍在展示词表（本轮选的是"给它一个真生产者"，非"从词表移除"）');
}

function groupCc(): void {
  console.log('\n【C-c】「建一条成果」的唯一落库口径（校验 → 去重 → 落库 → 通报）');
  // 该不命中①：文档（.md/.txt）标成服务型 —— 大写 `.MD` 也须命中（大小写不敏感是在场断言）
  {
    const db = cdb();
    const r = createDeliverable(db as never, {
      projectId: 'p1', name: 'notes', type: 'mcp', filePath: '/tmp/notes.MD', pathLabel: 'notes.MD', via: 'rr',
    });
    eq([r.ok, r.ok ? null : r.reason], [false, 'doc_as_service'],
      'C-c-1 ★该不命中：`.MD` 标 `mcp` 被拦（判据**大小写不敏感**——旧 `endsWith(\'.md\')` 会放它过去）');
    eq(cStatus(db, 'x'), '∅', 'C-c-2 反证：被拦时**一行都没落**（不是"拦了但已写进去"）');
  }
  // 该不命中②：tools/modules/lib/plugins 下的工具模块标成服务型
  {
    const db = cdb();
    const r = createDeliverable(db as never, {
      projectId: 'p1', name: 'fetch', type: 'mcp', filePath: '/tmp/src/tools/fetch.py', pathLabel: 'src/tools/fetch.py', via: 'rr',
    });
    eq([r.ok, r.ok ? null : r.reason], [false, 'module_as_service'],
      'C-c-3 ★该不命中：`tools/` 下的工具模块标 `mcp` 被拦（服务类型只收服务入口）');
  }
  // 该命中：合法服务入口 ⇒ 建成功，status=draft
  {
    const db = cdb();
    const { result: r, events } = captureEvents(() => createDeliverable(db as never, {
      projectId: 'p1', name: 'svc', type: 'mcp', filePath: '/tmp/src/svc_server.py', pathLabel: 'src/svc_server.py', via: 'rr',
    }));
    ok(r.ok && r.created, 'C-c-4 ★该命中：合法服务入口建成功（"拦"不是把整条路堵死）');
    eq(r.ok ? r.status : null, 'draft', 'C-c-5 新行一律 `draft`（"建了"不等于"已注册到 ANS"）');
    // ★事件口径：新行通报的是 status_changed/draft，**不是** registered/registered
    eq(events.map((e) => [e.type, e.data.status, e.data.changedFrom]),
      [['deliverable.status_changed', 'draft', 'draft']],
      'C-c-6 ★通报名实相符：新行起草 `deliverable.status_changed`（`registered` 的语义是"已注册到 ANS"，该行从未碰过 ANS）');
  }
  // 去重：同路径再来一次 ⇒ 不新建（如实回报，由调用方向用户说"已存在"）
  {
    const db = cdb();
    const first = createDeliverable(db as never, { projectId: 'p1', name: 'a', type: 'doc', filePath: '/tmp/a.md', pathLabel: 'a.md', via: 'rr' });
    const second = createDeliverable(db as never, { projectId: 'p1', name: 'a2', type: 'doc', filePath: '/tmp/a.md', pathLabel: 'a.md', via: 'rr' });
    ok(first.ok && second.ok && first.created && !second.created && first.id === second.id,
      'C-c-7 去重：同项目同路径建两次只落一行，第二次如实报 `created:false`（不许谎称"已创建"）',
      `rows=${(db.prepare('SELECT COUNT(*) AS c FROM wa_deliverables').get() as { c: number }).c}`);
  }
  // 两调用点 + 一处定义：GUI 与 agent 走**同一个**函数，不是"长得像的两份"
  const callers = [P_WRITE, P_IPC].filter((p) => cRows(p).some((l) => /createDeliverable\(/.test(l) && !/^import/.test(l.trim())));
  eq(callers.length, 2, 'C-c-8 ★两调用点在场：agent 工具 与 GUI IPC 都调 `createDeliverable(`');
  eq(cRows(P_LIFE).filter((l) => /^export function createDeliverable\(/.test(l.trim())).length, 1,
    'C-c-9 ★真源唯一：`createDeliverable` 全仓只有**一处**定义（deliverable-lifecycle）');
  // 类型判据也归一处（此前 write.ts 手抄 4 处字面量、project.ipc.ts 0 处）
  eq(cRows(P_TYPES).filter((l) => /export const SERVICE_TYPES = \[/.test(l)).length, 1,
    'C-c-10 类型集合真源在场：`SERVICE_TYPES` 只此一处');
  eq([isServiceType('mcp'), isServiceType('doc'), isServiceType(null), isDocPath('A.MD'), isDocPath('a.md'), isModuleFilePath('src\\tools\\f.py')],
    [true, false, false, true, true, true],
    'C-c-11 判据本身：`isServiceType` 只认四个服务型；`isDocPath` 大小写不敏感；`isModuleFilePath` 认反斜杠路径');
}

function groupCd(): void {
  console.log('\n【C-d】审批选项同源（GUI 一个选项 / IM 两个选项 的裂缝）');
  const db = cdb();
  // 该命中：带选项块 ⇒ 两个选项（六个分隔符之一 `/`）
  eq(parseOptions('[等待用户输入] 选哪个？ [选项: A / B]'), ['A', 'B'],
    'C-d-1 ★该命中：`[选项: A / B]` 解出**两个**选项（旧 GUI 只按 `,`/`|` 切 ⇒ 读成**一个**）');
  eq(parseOptions('A / B'), ['A', 'B'], 'C-d-2 仅选项原文亦可解（`parseOptions` 的合法入参之一）');
  eq(parseOptions('[选项: A、B；C]'), ['A', 'B', 'C'], 'C-d-3 其余四种历史分隔符同样可解（历史数据不失效）');
  // 该不命中：**没有**选项块 —— 调用方须先问，不能把问题正文切成选项
  eq([OPTION_BLOCK_RE.test('选哪个方案？'), OPTION_BLOCK_RE.test('[选项: A / B]')], [false, true],
    'C-d-4 ★该不命中：无选项块的正文不被误切（`OPTION_BLOCK_RE` 存在的理由）');
  // 与匹配侧同尺：GUI 读出的两个选项，IM 回复 `B` 须命中第 2 个
  eq(matchApprovalReply(parseOptions('[选项: A / B]'), 'B'), { kind: 'option', index: 1, text: 'B' },
    'C-d-5 ★同尺：GUI 解析出的选项集喂给**生产**匹配函数，回复 `B` 命中第 2 项（两端一套）');
  ok(!OPTION_BLOCK_RE.test('') && db !== undefined, 'C-d-6 空串不命中（不把"什么都没有"当选项块）');
  // 静态：GUI 回落解析走真源，本页不再自带第二份切分
  const tdp = cRows(P_TDPAGE).join('\n');
  ok(/from '\.\.\/\.\.\/\.\.\/src\/main\/core\/im\/options\.js'/.test(RD(P_TDPAGE)) && /parseOptions\(/.test(tdp),
    'C-d-7 ★接线：GUI 回落解析引 main 侧**同一份** `parseOptions`（跨 root 零依赖模块）');
  eq(cRows(P_TDPAGE).filter((l) => /split\(\/\\s\*,\\s\*\|/.test(l)), [],
    'C-d-8 反证（代码行面）：GUI 不再自带"只按 , 或 | 切"的那份旁路实现');
}

function groupCe(): void {
  console.log('\n【C-e】非 doc 文件成果也能被任务完成推出 draft（按类型集合，不按 `type===\'doc\'`）');
  eq(FILE_DELIVERABLE_TYPES as unknown as string[], ['doc', 'code'],
    'C-e-1 集合真源：能随任务交付的文件类型 = doc+code（`ui` 是**服务**型，刻意不在内）');
  {
    const db = cdb();
    db.prepare("INSERT INTO wa_tasks (id, context_json) VALUES ('t1', '{}')").run();
    cDeliv(db, { id: 'dv-doc', task: 't1', type: 'doc', name: 'a.md', filePath: 'out/a.md' });
    cDeliv(db, { id: 'dv-code', task: 't1', type: 'code', name: 'b.py', filePath: 'out/b.py' });
    cDeliv(db, { id: 'dv-ui', task: 't1', type: 'ui', name: 'c.html', filePath: 'out/c.html' });
    const r = promoteTaskFileDeliverables(db, 't1');
    eq([cStatus(db, 'dv-doc'), cStatus(db, 'dv-code'), cStatus(db, 'dv-ui'), r.promoted], ['completed', 'completed', 'draft', 2],
      'C-e-2 ★两标本同试：`doc`/`code` 该命中（推出 draft）、`ui` 该不命中（服务型不随任务完成"交付"）');
  }
  // 反证：旧判据 `type='doc'` 若还在，code 恒 draft（本轮修的正是这一格）
  ok(/typeIn\('', FILE_DELIVERABLE_TYPES\)/.test(RD(P_LIFE)),
    'C-e-3 ★接线：提升查询走 `typeIn(…, FILE_DELIVERABLE_TYPES)`（集合改了此处自动同尺，不再手抄 `type = \'doc\'`）');
}

function groupCf(): void {
  console.log('\n【C-f】探针尺的 `_` 是通配符——把尺子改成它自称的样子（名实相符）');
  // 病根：`%/_%probe%` 里 `_` 是 SQLite LIKE 的**单字符通配符**，故实为"路径里含 probe"（`/` + 任意一字符 + 任意串），
  //   而 zx_20260913 的注释自称"路径段级：段内以 `_` 开头"。**注释描述了意图、代码没做到**——
  //   实证：`scripts/verify_push_20260910.py`（正常命名，只因含 verify）被判探针 ⇒ 真产出永不提升。
  // 钉法：两条**同时**用生产谓词真跑一遍库（只用"该命中"一只标本 ⇒ 任何过宽变体全票通过）。
  const ruler = docNotProbe('');
  ok(ruler.includes("ESCAPE '\\'") && ruler.includes("'%/\\_%"),
    'C-f-1 字面真源：谓词已用 `\\_` + `ESCAPE`（`_` 回到字面下划线，NOT 通配符）', ruler);
  ok(!/NOT LIKE '%\/_/.test(ruler), 'C-f-2 反证：未转义的 `%/_…` 在谓词里零处（否则 `_` 又成通配符）');
  {
    const db = cdb();
    db.prepare("INSERT INTO wa_tasks (id, context_json) VALUES ('tp', '{}')").run();
    // 该命中（**不是**探针）：正常命名里含关键词，但没有任何**以 `_` 开头的路径段**
    const NOT_PROBE = [
      'scripts/verify_push_20260910.py',      // ← 真库实证被误判的那一条
      'scripts/attempt_check.py',
      'reports/verify.md',
      'out/dump_logs.py',
    ];
    // 该不命中（是探针）：路径段**以 `_` 开头**（含跨 `/` 的段起点，`%` 可跨分隔符）
    const PROBE = [
      'scripts/_probe_f01_import.py',
      'scripts/_tmp_m3_audit.py',
      'scripts/_verify_20260910_fix.py',
      'data/_sandbox/20260918/sent_payloads/tmp6frrauiy_h24.jsonl',
    ];
    NOT_PROBE.forEach((fp, i) => cDeliv(db, { id: `np${i}`, task: 'tp', type: 'code', name: fp.split('/').pop()!, filePath: fp }));
    PROBE.forEach((fp, i) => cDeliv(db, { id: `pp${i}`, task: 'tp', type: 'code', name: fp.split('/').pop()!, filePath: fp }));
    const r = promoteTaskFileDeliverables(db, 'tp');
    const got = Object.fromEntries([...NOT_PROBE.map((_, i) => `np${i}`), ...PROBE.map((_, i) => `pp${i}`)]
      .map((id) => [id, cStatus(db, id)]));
    eq(NOT_PROBE.map((_, i) => got[`np${i}`]), NOT_PROBE.map(() => 'completed'),
      'C-f-3 ★该命中：**不像探针**的正常命名（含 verify/tmp 字样但无 `_` 起手段）全部被提升——真产出不再卡 draft');
    eq(PROBE.map((_, i) => got[`pp${i}`]), PROBE.map(() => 'draft'),
      'C-f-4 ★该不命中：**以 `_` 开头**的段（含跨 `/` 的 `_sandbox/…/tmp*`）仍判探针、不被提升');
    eq(r.promoted, NOT_PROBE.length,
      `C-f-5 计数与两标本集合同尺（提升数 = 该命中样本数 = ${NOT_PROBE.length}）`, String(r.promoted));
  }
}

// ══════════════════════════════════════════════════════════════════
// 【D · M4】展示一致与性能 —— 成果取数范围一处真源 / 状态词表一处 / 订阅集补齐
// ══════════════════════════════════════════════════════════════════
const P_STATUSVIEW = `${A}/renderer/src/lib/status-view.ts`;
const P_DELIVPAGE = `${A}/renderer/src/pages/DeliverablesPage.tsx`;
const P_ACTIVITY = `${A}/renderer/src/lib/activity.tsx`;

/** 行级收集：读**原文**（G-5），但滤掉整行注释——注释不是代码，不该被当成实现命中。 */
function codeLines(rel: string): string[] {
  return RD(rel).split('\n').filter((l) => {
    const t = l.trimStart();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('--'));
  });
}
/** 递归列出目录下 .ts/.tsx（仓库相对路径）。 */
function walkTs(relDir: string): string[] {
  const out: string[] = [];
  const go = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) go(r);
      else if (/\.tsx?$/.test(e.name)) out.push(r);
    }
  };
  go(relDir);
  return out;
}

/** M4-1 夹具：两项目 × 三任务，正常件／doc 探针／code 探针／退休件四类齐备（G-2 两侧各有标本）。 */
function dDelivs(): AnyDb {
  const db = cdb();
  cDeliv(db, { id: 'ok1', project: 'p1', task: 't1', type: 'doc', name: 'report.md', filePath: 'out/report.md' });
  cDeliv(db, { id: 'pd1', project: 'p1', task: 't1', type: 'doc', name: '_tmp_draft.md', filePath: 'out/_tmp_draft.md' });
  cDeliv(db, { id: 'ok2', project: 'p1', task: 't1', type: 'code', name: 'build.py', filePath: 'scripts/build.py' });
  cDeliv(db, { id: 'pc1', project: 'p1', task: 't1', type: 'code', name: '_probe_x.py', filePath: 'scripts/_probe_x.py' });
  cDeliv(db, { id: 'rt1', project: 'p1', task: 't2', type: 'doc', name: 'old.md', filePath: 'out/old.md', status: 'retired' });
  cDeliv(db, { id: 'ok3', project: 'p2', task: 't3', type: 'code', name: 'a.py', filePath: 'src/a.py' });
  return db;
}

function groupDa(): void {
  console.log('\n【D-a】M4-1 成果取数范围一处真源（谓词组合 + 两个计数出口；手算期望独立于生产码）');
  const db = dDelivs();
  eq(countDeliverables(db), 4,
    'D-a-1 全库在册数=手算 4（ok1/ok2/pc1/ok3；doc 探针 pd1 与退休 rt1 均不计）');
  eq(countDeliverables(db, { projectId: 'p1' }), 3,
    'D-a-2 ★项目条件生效：p1 在册 3（不含 p2 的 ok3 —— 不是"恒等于全量"）');
  eq(countDeliverables(db, { projectId: 'p1', includeRetired: true }), 4,
    'D-a-3 ★该命中：档案视图口径（includeRetired）把退休件放回来 —— 4≠3，差异可达、非静默一致');
  eq(countDeliverables(db, { projectId: 'p2' }), 1,
    'D-a-4 另一个项目独立成立（区分度：两个项目各有各的数）');

  eq(countDeliverablesByType(db, { projectId: 'p1' }).map((g) => `${g.type}:${g.c}`).sort(), ['code:2', 'doc:1'],
    'D-a-5 分项计数=手算 {code:2, doc:1}（doc 探针被滤、code 探针在册——见 D-a-8 的口径登记）');
  eq(countDeliverablesByType(db, { projectId: 'p2' }).map((g) => `${g.type}:${g.c}`), ['code:1'],
    'D-a-6 分项与项目同尺（p2 只有 1 条 code）');

  eq(countDeliverables(db, { taskIds: ['t1'] }), 3, 'D-a-7 任务口径：t1 在册 3 件（子树口径的输入）');
  eq(deliverableScopeSql({ taskIds: [] }), { sql: '0', params: [] },
    'D-a-8 ★空任务集⇒恒假片段 `0`（绝不生成 `IN ()`——那是 SQL 语法错，会把整页打成异常）');
  eq(countDeliverables(db, { taskIds: [] }), 0, 'D-a-9 空任务集的真实后果：0（上面那条片段的验证）');

  // 旧写法对账：同一夹具上，真源与"曾经的四处手抄形态"给出同一个数
  const legacy = (db.prepare(
    `SELECT COUNT(*) AS c FROM wa_deliverables WHERE project_id = ? AND status != 'retired' AND (type != 'doc' OR ${docNotProbe('')})`,
  ).get('p1') as { c: number }).c;
  eq(legacy, countDeliverables(db, { projectId: 'p1' }),
    'D-a-10 ★同一把尺：真源与旧内联写法在同一夹具上同值（改一处即全部读点同尺）');

  const aliased = deliverableScopeSql({ projectId: 'p1', taskIds: ['t1'], alias: 'd' }).sql;
  ok(aliased.includes('d.project_id = ?') && aliased.includes("d.status != 'retired'") && aliased.includes('COALESCE(d.file_path, d.name)'),
    'D-a-11 ★alias 贯穿到每一段（多表 JOIN 读点若不前缀，列名歧义会直接报错）', aliased);
}

function groupDb(): void {
  console.log('\n【D-b】M4-1 反证：病根形态（谓词手拼）在真源之外零处');
  const SELF = `${A}/src/main/core/deliverable-lifecycle.ts`;
  const files = walkTs(`${A}/src/main`);
  ok(files.length > 40, 'D-b-1 扫描面自证：src/main 下扫到 >40 个 .ts（否则下面"零命中"是空转假绿）', `${files.length} 个`);
  const scoped = files.filter((f) => f !== SELF);
  eq(scoped.length, files.length - 1, 'D-b-2 真源文件本身已从扫描面移除（它**应当**命中）');

  // 病根形态：**同一行**既有 `status != 'retired'`，又带 doc 探针判据（`(type != 'doc'` 或 `docNotProbe`）
  const offenders: string[] = [];
  for (const f of scoped) {
    codeLines(f).forEach((line, i) => {
      if (!line.includes("status != 'retired'")) return;
      if (!(line.includes("(type != 'doc'") || line.includes('docNotProbe'))) return;
      offenders.push(`${f}:${i + 1}`);
    });
  }
  eq(offenders, [], 'D-b-3 ★真源之外零处手拼（"算不算一条成果"只剩一处说了算）');

  // 扫描器自证：它认得出真源里那一行（否则 D-b-3 的零命中可能只是正则根本 match 不到）
  const selfHits = codeLines(SELF).filter((l) => l.includes('parts.push') && l.includes("type != 'doc'")).length;
  eq(selfHits, 1, 'D-b-4 ★扫描器认得出真源（同一形态在真源里恰 1 处 ⇒ D-b-3 的零命中不是正则写空）');
}

function groupDc(): void {
  console.log('\n【D-c】M4-4 任务/项目状态词表收敛到 renderer 一处');
  const rendererTs = walkTs(`${A}/renderer/src`);
  ok(rendererTs.length > 30, 'D-c-1 扫描面自证：renderer/src 下扫到 >30 个 ts/tsx', `${rendererTs.length} 个`);

  // 病根形态：**自己定义**一张状态词表（`const *STATUS*_[LABEL|TXT] / statusLabel`）。
  const labelDef = /(const|let)\s+\w*(STATUS|status)\w*(Label|LABEL|Txt|TXT)\s*[:=]/;
  const defs = rendererTs.filter((f) => codeLines(f).some((l) => labelDef.test(l)));
  // zx_20261004 回填：M4/M13 新增了**协同域**的词表（`node-view.ts` 的 `CALL_STATUS_LABEL`）。
  //   病根不变量（词表须落 `lib/` 一处、不散在页面里）**未放松**——该表已从 `PeersPage.tsx` 就地移入
  //   `lib/node-view.ts`（其头注释本就自称与 deliverable-view/status-view 同形），故定义点由两处→三处，
  //   三者皆在 `lib/`，逐一具名（非"任意新文件放行"）。
  eq(defs.map((f) => f.replace(`${A}/renderer/src/`, '')).sort(), ['lib/deliverable-view.ts', 'lib/node-view.ts', 'lib/status-view.ts'].sort(),
    'D-c-2 ★词表定义点恰三处且皆在 `lib/`：任务/项目域 `status-view.ts` + 成果域 `deliverable-view.ts` + 协同域 `node-view.ts`（三域刻意不合并，页面里零处）');

  const sv = RD(P_STATUSVIEW);
  ok(sv.includes('investigating') && sv.includes('调查中'),
    'D-c-3 ★原详情页独有的 `investigating` 已进统一表（任务列表/命令面板这才认得它）');
  ok(sv.includes('PROJECT_STATUS_LABEL') && sv.includes('TASK_STATUS_LABEL'),
    'D-c-4 任务域与项目域各一张表（取值域不同，各表各管各的）');

  // 三个原手抄点：已改为引用，且**本地不再留定义**（反证）
  for (const [rel, who] of [
    [`${A}/renderer/src/pages/TaskDetailPage.tsx`, '详情页'],
    [`${A}/renderer/src/pages/TasksPage.tsx`, '任务列表'],
    [`${A}/renderer/src/components/CommandPalette.tsx`, '命令面板'],
  ] as const) {
    const src = RD(rel);
    const short = rel.replace(`${A}/renderer/src/`, '');
    ok(/from '\S*lib\/status-view'/.test(src), `D-c-5 ★${who}改引共享词表（${short}）`);
    ok(!/(const|let)\s+(STATUS_LABEL|STATUS_TXT|statusLabel)\s*[:=]/.test(src),
      `D-c-6 ★反证：${who}不再自带词表（${short}）`);
  }
  // 词表定义点只此一处实现 ⇒ 消费方**不只**这三个（本轮还接了 ProjectsPage/ProjectDetailPage）
  ok(RD(`${A}/renderer/src/pages/ProjectsPage.tsx`).includes('PROJECT_STATUS_LABEL')
    && RD(`${A}/renderer/src/pages/ProjectDetailPage.tsx`).includes('PROJECT_STATUS_LABEL'),
    'D-c-7 项目页/项目详情页同样改引共享表（本轮连带修的两个原样回显点）');
}

function groupDd(): void {
  console.log('\n【D-d】M4-5 成果页订阅集补任务终态（事件驱动，且轮询兜底保留）');
  const dp = RD(P_DELIVPAGE);
  // 该 `if` 跨多行（成果事件 / 运行态事件 / 任务终态各占一行）——按**语句边界**累积整个条件，
  //   不钉行号、也不假定只跨两行（zx_20261018_2 批六在条件中段补了 `deliverable.runtime_changed`）。
  const dpLines = codeLines(P_DELIVPAGE);
  const fi = dpLines.findIndex((l) => l.includes("t === 'deliverable.registered'"));
  let filterLine = '';
  for (let i = fi; i >= 0 && i < dpLines.length; i++) {
    filterLine += `${dpLines[i]} `;
    if (dpLines[i]!.includes('return;')) break;
  }
  ok(filterLine.length > 0 && filterLine.includes('return'), 'D-d-1 订阅过滤器在场（按语句形状定位，不钉行号）');
  for (const ev of ['task.completed', 'task.failed', 'task.status_changed']) {
    ok(filterLine.includes(`'${ev}'`), `D-d-2 ★订阅集含 \`${ev}\`（任务态一变，成果行当场跟着变）`);
  }
  // zx_20261018_2 批六「见新」：运行态以事件驱动为主，轮询退为兜底——节拍一处真源在 `lib/refresh.ts`。
  //   判据**按符号重定向**（不放宽）：仍要求"轮询保留"，并追加"主路径确有事件"这一条。
  const refreshSrc = RD(`${A}/renderer/src/lib/refresh.ts`);
  ok(filterLine.includes("'deliverable.runtime_changed'"),
    'D-d-3a ★运行态变更走事件（批六：启停/退出由 main 发事件，用户点完当即见状态，不再干等轮询）');
  ok(/export const FALLBACK_POLL_MS = 30_000;/.test(refreshSrc)
    && /setInterval\(loadRuntime,\s*FALLBACK_POLL_MS\)/.test(dp),
    'D-d-3b 兜底轮询**保留**且节拍取自一处真源（`FALLBACK_POLL_MS`；它管的是"进程自己死了/事件丢了"这类无人发事件的情形）');

  // 接线那一跳（按语句形状，不按子串）：转发层不白名单、分发层不掐掉任务终态
  const activity = RD(P_ACTIVITY);
  const streamSet = codeLines(P_ACTIVITY).find((l) => l.includes('STREAMING_TYPES') && l.includes('new Set')) ?? '';
  ok(streamSet.length > 0, 'D-d-4 分发层瞬态集按语句形状定位到', streamSet.trim());
  ok(!streamSet.includes('task.completed') && !streamSet.includes('task.failed'),
    'D-d-5 ★反证：任务终态不在瞬态集里 ⇒ 确实会被派发给订阅者（不是"订阅了但收不到"）');
  // 主进程转发侧（`main/index.ts`）：按语句形状找"订阅事件总线 → 转发到 renderer"那一跳
  for (const ev of ['task.completed', 'task.failed']) {
    const fwd = codeLines(`${A}/src/main/index.ts`).find((l) =>
      l.includes(`eventBus.on('${ev}'`) && l.includes(`forwardToRenderer('${ev}'`)) ?? '';
    ok(fwd.length > 0, `D-d-6 ★主进程确有转发这一路：事件总线 \`${ev}\` ⇒ \`forwardToRenderer\`（renderer 的订阅不是一厢情愿）`);
  }
}

// ══════════════════════════════════════════════════════════════════
// 【D-f】M4-3 补发明细与统计对齐（数得到的就取得到）
// ══════════════════════════════════════════════════════════════════
function groupDe(): void {
  console.log('\n【D-f】M4-3 补发明细与统计对齐（两个口径一处真源 + 明细分页取尽）');

  // ── ① 两个口径同生一源：未折叠的逐状态计数 vs 折叠的五档 ──
  {
    const db = outboxOnlyDb();
    const seed: Array<[string, string]> = [
      ['o1', 'pending'], ['o2', 'dead'], ['o3', 'dead'],
      ['o4', 'unsupported_media'], ['o5', 'weird_state'],
    ];
    for (const [id, st] of seed) {
      db.prepare('INSERT INTO wa_im_outbox (id, status, created_at) VALUES (?, ?, ?)')
        .run(id, st, '2026-09-30 00:00:00');
    }
    const counts = outboxStatusCounts(db);
    eq([counts.pending, counts.dead, counts.unsupported_media, counts.weird_state], [1, 2, 1, 1],
      'D-f-1 ★未折叠口径**逐状态各占一键**（`unsupported_media` 不再被折进 `other` 而失去名字——界面要靠它出组名）');
    const s = outboxStats(db);
    eq([s.pending, s.dead, s.other], [1, 2, 2],
      'D-f-2 折叠档照旧：`other` 兜住 unsupported_media(1) + 未知态(1)，值恰为 2');
    eq(Object.values(counts).reduce((a, b) => a + b, 0),
      s.pending + s.blocked_quota + s.dead + s.sent + s.other,
      'D-f-3 ★两个口径**总数相等**（同一次 `GROUP BY status` 派生 ⇒ 界面各组的"共 M 条"加起来必等于横幅的总数）');
    eq(Object.keys(s).sort(), ['blocked_quota', 'dead', 'other', 'pending', 'sent'],
      'D-f-4 折叠档返回值**形状不变**（`byStatus` 是**另立**的出口，不塞进这里——既有整对象断言因此逐字仍成立）');
  }

  // ── ② 稳定次序：同一秒多行时翻页**不重不漏**（`created_at` 只到秒；不补 `rowid` 则次序不定 = 分页病） ──
  {
    const db = outboxOnlyDb();
    const T = '2026-09-30 12:00:00';
    const want = Array.from({ length: 7 }, (_, i) => `same-${i}`);
    for (const id of want) {
      db.prepare('INSERT INTO wa_im_outbox (id, status, created_at) VALUES (?, ?, ?)').run(id, 'dead', T);
    }
    const ids = pageAllIds(db, 3);
    eq(ids.length, 7, 'D-f-5 ★同 `created_at`（秒级碰撞标本，刻意不依赖墙钟）下翻页取尽 7 行');
    eq(new Set(ids).size, 7, 'D-f-6 ★**无重复**（缺 `rowid` 兜底时同秒行次序不定 ⇒ 跨页会重复列出同一条）');
    eq([...new Set(ids)].sort(), [...want].sort(), 'D-f-7 **无遗漏**（逐页并集 = 全部行，不是"取到一部分"）');
  }

  // ── ③ 往返在**生产入参**上成立（G-1/G-5）：用生产写入口落账，再按生产读法取尽 ──
  {
    const db = outboxOnlyDb();
    db.prepare('INSERT INTO wa_im_channels (id, channel_type) VALUES (?, ?)').run('ch-x', 'qqbot');
    for (let i = 0; i < 5; i++) {
      enqueueImOutbox(db, { channelId: 'ch-x', externalUserId: 'u1', taskId: 't1', kind: 'notification', message: `第 ${i} 条` });
    }
    const ids = pageAllIds(db, 2);
    eq(ids.length, 5, 'D-f-8 ★生产写出的 5 条账，按生产读法分页**取尽**（禁自造入参）');
    eq(new Set(ids).size, 5, 'D-f-9 无重复（同上）');
  }

  // ── ④ 边界：夹取不改变语义（非法入参不许整页错位，也不许报错） ──
  {
    const db = outboxOnlyDb();
    for (let i = 0; i < 3; i++) {
      db.prepare('INSERT INTO wa_im_outbox (id, status, created_at) VALUES (?, ?, ?)')
        .run(`b-${i}`, 'dead', '2026-09-30 00:00:00');
    }
    const base = listOutbox(db, { limit: 3, offset: 0 }).map((r) => r.id);
    eq(listOutbox(db, { limit: 3, offset: -5 }).map((r) => r.id), base, 'D-f-10 负 offset 视同 0（夹取，不是把页翻错位）');
    eq(listOutbox(db, { limit: 3, offset: Number.NaN }).map((r) => r.id), base, 'D-f-11 NaN offset 视同 0');
    eq(listOutbox(db, { limit: OUTBOX_PAGE_MAX + 9999 }).length, 3,
      'D-f-12 单页上限仍夹回实际行数（`OUTBOX_PAGE_MAX`，不报错、也不把整账一次拉满）');
  }

  // ── ⑤ main 侧：`offset` 透传 + 统计口组合未折叠计数（读**原文**，G-5：去注释是静默毁伤） ──
  {
    const ipc = RD(`${A}/src/main/ipc/im.ipc.ts`);
    ok(ipc.length > 2000, 'D-f-13 扫描面自证：`im.ipc.ts` 原文非空（否则下面两条是空转假绿）', `${ipc.length} 字节`);
    ok(ipc.includes('offset: args?.offset'), 'D-f-14 ★`im:outboxList` 透传 `offset`——"翻得到底"的最后一跳在接线处也成立');
    ok(ipc.includes('byStatus: outboxStatusCounts(_dbForIm)'), 'D-f-15 ★统计口回**未折叠**计数（与折叠档同出生产纯函数）');
    ok(!/COUNT\(\*\)/.test(ipc), 'D-f-16 反证：handler 里没有自己的计数 SQL（口径不许在这里长出第二份）');
  }

  // ── ⑥ renderer 侧：翻页钮与"显示 K / 共 M"（renderer 不在 `src/main` 扫描面内，须单独看这一处） ──
  {
    const page = RD(`${A}/renderer/src/pages/IMPage.tsx`);
    ok(page.length > 5000, 'D-f-17 扫描面自证：`IMPage.tsx` 原文非空', `${page.length} 字节`);
    ok(/invoke\('im:outboxList',\{limit:OUTBOX_PAGE,\s*offset:0\}\)/.test(page),
      'D-f-18 首屏取第 0 页（页大小是一处常量 `OUTBOX_PAGE`，不再是散落的字面量 200）');
    ok(/invoke\('im:outboxList',\{limit:OUTBOX_PAGE,\s*offset:outboxRows\.length\}\)/.test(page),
      'D-f-19 ★「加载更多」按**已列出的条数**取下一页（不是重新取前 N 条、也不是原地不动）');
    ok(page.includes('已显示 {outboxRows.length} / 共 {outboxTotal} 条'),
      'D-f-20 ★全账口径**如实交代**（"显示多少 / 共多少"上屏，用户不必自己算剩几条）');
    ok(!/\{limit:200\}/.test(page),
      'D-f-21 ★反证：写死 200 且**没有下一页**的旧病根已不在（账 >200 条时那正是"数得到、翻不着"的成因）');
    ok(/显示 \$\{rows\.length\} \/ 共 \$\{tot\}/.test(page),
      'D-f-22 ★每组写"显示 K / 共 M"（M 取**统计**口径，不拿"这屏列出来的行数"冒充全量）');
    ok(/Object\.keys\(outboxCounts\)/.test(page) && page.includes('OUTBOX_GROUP_ORDER'),
      'D-f-23 ★组**成员由统计派生**、次序表只定先后（新态不会再被一张字面量清单筛掉而整段不渲染）');
    ok(page.includes('outboxHasMore') && page.includes('loadMoreOutboxRows'),
      'D-f-24 「加载更多」钮由"还剩没列"驱动，且真去取下一页（不是一句空承诺）');
  }
}

// ══════════════════════════════════════════════════════════════════
// 【D-g】M4-2 真分页：夹取一处真源 · 明细与总数同尺 · 同秒行翻页不重不漏
// ══════════════════════════════════════════════════════════════════
function groupDg(): void {
  console.log('\n【D-g】M4-2 真分页（批次夹取一处真源 · "共 M 条"≠"这一批多少" · 同秒行靠 rowid 兜次序）');

  // ── ① 夹取规则：直接跑**生产函数** `resolvePage`（G-1：不自造等价实现） ──
  {
    const p0 = resolvePage(undefined, undefined);
    eq([p0.limit, p0.offset], [PAGE_DEFAULT, 0], 'D-g-1 缺省 ⇒ 默认批大小 + 第 0 页');
    // `sql` 与 `params` 必须同生一源：片段里几个 `?` 就几个参数。缺这条，将来改片段（多一个占位符）
    // 会让参数**错位**而不报错（SQLite 只按位置取），症状是"翻页偶发取错行"。
    eq((p0.sql.match(/\?/g) ?? []).length, p0.params.length,
      'D-g-2 ★`sql` 占位符个数 = `params` 长度（片段与参数不许各走各的）');
    eq(p0.params, [p0.limit, p0.offset], 'D-g-3 `params` 与 `limit`/`offset` 逐位同源');
    // 两侧标本同试：合法边界值**不许**被夹（夹取只能夹非法值），非法值一律夹回且不报错。
    eq(resolvePage(PAGE_MAX, 7).limit, PAGE_MAX, 'D-g-4 合法侧标本：正好 `PAGE_MAX` 原样通过（夹取不误伤合法值）');
    eq(resolvePage(PAGE_MAX + 9999, 0).limit, PAGE_MAX, 'D-g-5 超上限夹回 `PAGE_MAX`（不报错，也不把整表一次拉满）');
    eq(resolvePage(-3, 0).limit, 1, 'D-g-6 负批大小夹到下限 1');
    eq(resolvePage(0, 0).limit, PAGE_DEFAULT, 'D-g-7 显式 0 视同缺省（不是"一页 0 条"）');
    eq(resolvePage(NaN, -5).offset, 0, 'D-g-8 负偏移量视同第 0 页（口误不使整页错位）');
  }

  // ── ② 次序的**第二把钥匙**：`created_at` 只到秒，故必须补 `rowid` ──
  {
    const DG_SCHEMA = `
CREATE TABLE wa_task_conversations (
  id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL, content TEXT DEFAULT '',
  tool_calls TEXT, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);`;
    const db = new DatabaseSync(':memory:') as unknown as AnyDb;
    db.exec(DG_SCHEMA);
    const T = '2026-09-30 12:00:00';
    const want = Array.from({ length: 7 }, (_, i) => `c-${i}`);
    for (const cid of want) {
      db.prepare('INSERT INTO wa_task_conversations (id, task_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(cid, 'T', 'assistant', 'x', T);
    }
    const n = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;
    // ★两条**必须一起看**才分得出来：排序键单独**不是全序**（7 行只 1 个取值 ⇒ 单靠它次序不定），
    //   兜底键**是全序**（7 行 7 个取值 ⇒ 补它才有确定次序）。单看任何一条都推不出"该补 rowid"。
    eq(n('SELECT COUNT(*) AS c FROM wa_task_conversations'), 7, 'D-g-9 夹具自证：7 行在场（否则下面是空转假绿）');
    eq(n('SELECT COUNT(DISTINCT created_at) AS c FROM wa_task_conversations'), 1,
      'D-g-10 ★排序键 `created_at` 单独**不是全序**（秒级碰撞标本：7 行只有 1 个取值）');
    eq(n('SELECT COUNT(DISTINCT rowid) AS c FROM wa_task_conversations'), 7,
      'D-g-11 ★兜底键 `rowid` **是全序**（7 行 7 个取值）⇒ 补它才谈得上"翻页次序确定"');

    // 明细 SQL 从**生产源码原文**读出（G-5），分页片段由**生产函数**补（G-1）——不是另写一条等价语句。
    const ipc = RD(`${A}/src/main/ipc/project.ipc.ts`);
    const mConv = ipc.match(/SELECT \* FROM wa_task_conversations WHERE task_id = \? ORDER BY rowid ASC\$\{convPage\.sql\}/);
    ok(!!mConv, 'D-g-12 ★conversation 生产 SQL 取到（次序 `rowid ASC`，分页片段由 `convPage.sql` 补）');
    const mCount = ipc.match(/SELECT COUNT\(\*\) AS c FROM wa_task_conversations WHERE task_id = \?/);
    ok(!!mCount, 'D-g-13 ★总数 SQL 在场（`conversationsTotal` 的来源）');
    ok(!!mCount && !/LIMIT|OFFSET/.test(mCount[0]),
      'D-g-14 ★反证：总数 SQL **不含** `LIMIT`/`OFFSET`（"共 M 条"必须是全量口径，不能跟着页走）');

    if (mConv && mCount) {
      const ids: string[] = [];
      for (let off = 0; off < 1000; off += 3) {
        const pg = resolvePage(3, off);
        // 参数顺序逐位照抄生产调用点：`WHERE task_id = ?` 在前，分页两个 `?` 在后
        const rows = db.prepare(mConv[0]!.replace('${convPage.sql}', pg.sql)).all('T', ...pg.params) as Array<{ id: string }>;
        ids.push(...rows.map((r) => r.id));
        if (rows.length < pg.limit) break;
      }
      eq(ids.length, 7, 'D-g-15 ★按生产 SQL 分页**取尽** 7 行（不是"只取到第一批就算完"）');
      eq(new Set(ids).size, 7, 'D-g-16 ★**无重复**（同秒 7 行靠 `rowid` 兜底，跨页不重列同一条）');
      eq([...new Set(ids)].sort(), [...want].sort(), 'D-g-17 **无遗漏**（逐页并集 = 全部行）');

      const total = (db.prepare(mCount[0]!).get('T') as { c: number }).c;
      eq(total, 7, 'D-g-18 总数 = 明细行数（同 task_id 同集合）');
      // 收口判据两侧同试（缺一侧就"任何过宽变体都通过"）
      // 第一把尺：**短页**（这批没取满）⇒ 服务端已到底，与 `total` 说什么无关。
      eq([pageExhausted(3, 7), pageExhausted(3, 0), pageExhausted(3, 999), pageExhausted(40, LIST_PAGE_SIZE + 50)],
        [true, true, true, true],
        'D-g-19 ★短页即取尽（请求 100 只回来一行半行 ⇒ 服务端到底），且**不因 `total` 怎么写而变**');
      eq([pageExhausted(LIST_PAGE_SIZE, LIST_PAGE_SIZE + 50), pageExhausted(LIST_PAGE_SIZE, LIST_PAGE_SIZE)],
        [false, true], 'D-g-20 ★满一批时只能靠 `total` 分判（"取满 100 条"既不等于"取尽"也不等于"没取尽"）');
      // 第二把尺的边界：`total` **必须已知且为正**才算数。渲染层拿到的是 `Number(d?.total) || 0`，
      //   IPC 出错/字段缺失都会兜成 0；若漏了这个闸，`100 >= 0` 当场成立 ⇒ 第一批就谎报"已取全"，
      //   用户因此点不到「加载更多」，100 行之后的成果再也够不着。（修前的 `loaded >= total` 正是如此）
      eq([pageExhausted(LIST_PAGE_SIZE, 0), pageExhausted(LIST_PAGE_SIZE, NaN), pageExhausted(LIST_PAGE_SIZE, -1)],
        [false, false, false],
        'D-g-21 ★`total` 未知/为 0/非数时**不得**判取尽（宁可多给一次「加载更多」，下一批取空即按短页收口）');
    }
  }

  // ── ③ `deliverable:list`：`total`/`retiredCount` 与明细**同一段 FROM/JOIN/WHERE、同一组 params** ──
  {
    const ipc = RD(`${A}/src/main/ipc/project.ipc.ts`);
    const iList = ipc.indexOf("ipcMain.handle('deliverable:list'");
    const iNext = ipc.indexOf('ipcMain.handle(', iList + 10);
    const seg = iList >= 0 && iNext > iList ? ipc.slice(iList, iNext) : '';
    ok(seg.length > 2000, 'D-g-22 扫描面自证：`deliverable:list` handler 体取到（否则下面几条是空转假绿）', `${seg.length} 字节`);
    ok(/const total = \(db\.prepare\(`SELECT COUNT\(\*\) AS c \$\{from\}`\)\.get\(\.\.\.params\)/.test(seg),
      'D-g-23 ★`total` 复用**同一段 `from` + 同一组 `params`**（两处手抄必然分叉："共 M 条"与这页的行就不是一个集合了）');
    ok(/const retiredCount = \(db\.prepare\([\s\S]{0,400}?d\.status = 'retired'`\)\.get\(\.\.\.params\)/.test(seg),
      'D-g-24 ★"已退休 N 项"改由**服务端按同一组筛选条件**算（原先由渲染层数当页 items ⇒ 分页后那提示的数比它所指的集合小）');
    ok(seg.includes('${from} ORDER BY d.created_at DESC, d.rowid DESC${page.sql}'),
      'D-g-25 ★明细次序补 `d.rowid DESC` 兜同秒行（同 §②：`created_at` 单独不是全序）');
    ok(seg.includes('return { data: { rows: data, total, retiredCount, limit: page.limit, offset: page.offset } }'),
      'D-g-26 ★返回体含 `total`/`limit`/`offset`——"只给前 N 条且不说还剩多少"正是本轮所治的病');
    ok(seg.includes('for (const r of data) r.size_bytes = statSizeBytes(r.file_path);'),
      'D-g-27 计数器与大小列仍打在**局部名 `data`** 上（分页改的是取数，不是这行接线）');
    ok(seg.includes('const page = resolvePage(limit, offset);'),
      'D-g-28 ★夹取走共享真源（不在 handler 里自己夹）');
  }

  // ── ④ `task:get`：两个列表各自分页 + 两个总数走真源 ──
  {
    const ipc = RD(`${A}/src/main/ipc/project.ipc.ts`);
    const iGet = ipc.indexOf("ipcMain.handle('task:get'");
    const iNext = ipc.indexOf('ipcMain.handle(', iGet + 10);
    const seg = iGet >= 0 && iNext > iGet ? ipc.slice(iGet, iNext) : '';
    ok(seg.length > 2000, 'D-g-29 扫描面自证：`task:get` handler 体取到', `${seg.length} 字节`);
    ok(seg.includes('const convPage = resolvePage(convLimit, convOffset);')
      && seg.includes('const delivPage = resolvePage(delivLimit, delivOffset);'),
      'D-g-30 ★conversations 与 deliverables **各夹各的**，且都走共享真源（一个列表一个批次，互不挪用）');
    ok(seg.includes('conversationsTotal') && seg.includes('deliverablesTotal'),
      'D-g-31 ★两个总数都回（缺任一个，界面就只能印"这一批多少"）');
    ok(seg.includes('const deliverablesTotal = countDeliverables(db, { taskIds: ownerIds });'),
      'D-g-32 ★成果总数走**取数范围真源**、且与上方明细**同一组 `ownerIds`**（同集合才谈得上"已加载 K / 共 M"）');
    ok(seg.includes('WHERE ${dScope.sql} ORDER BY d.created_at DESC, d.rowid DESC${delivPage.sql}'),
      'D-g-33 ★成果明细次序同尺补 `d.rowid DESC`');
  }

  // ── ⑤ 名录（项目/任务/无任务计数）：由服务端一次算清，**不是**"整表读回来再筛" ──
  {
    const ipc = RD(`${A}/src/main/ipc/project.ipc.ts`);
    const iF = ipc.indexOf("ipcMain.handle('deliverable:facets'");
    const iNext = ipc.indexOf('ipcMain.handle(', iF + 10);
    const seg = iF >= 0 && iNext > iF ? ipc.slice(iF, iNext) : '';
    ok(seg.length > 400, 'D-g-34 扫描面自证：`deliverable:facets` handler 取到', `${seg.length} 字节`);
    eq((seg.match(/deliverableScopeSql\(/g) ?? []).length, 1,
      'D-g-35 ★三问**共用一处**范围真源（各写一份必然分叉：下拉里出现的项目/任务就不再是列表里那些）');
    eq((seg.match(/db\.prepare\(/g) ?? []).length, 3,
      'D-g-36 恰三个查询（项目名录 / 任务名录 / 「项目级」计数），不多不少');
    ok(!/COUNT\(\*\)[\s\S]{0,200}\$\{dScope\.sql\}[\s\S]{0,200}LIMIT/.test(seg) && !/SELECT d\.\*/.test(seg),
      'D-g-37 ★反证：名录**不取明细行**（取整表明细再在客户端去重，正是分页要治的那笔开销）');
  }

  // ── ⑥ renderer：三处**同一份**批次与判据；计数印"共多少"而非"这一批多少" ──
  {
    const lp = RD(`${A}/renderer/src/lib/list-page.ts`);
    ok(lp.includes('export const LIST_PAGE_SIZE = '), 'D-g-38 批次常量在场（列表页/两处区块共用一个来源）');
    ok(lp.includes('export function pageExhausted('), 'D-g-39 收口判据在场（三处不各写一遍 `rows.length < N`）');
    eq(LIST_PAGE_SIZE, 100, 'D-g-40 ★导入值与真源同值（`import` 真函数而非手抄常量，见 G-1）', String(LIST_PAGE_SIZE));

    const pages = ['DeliverablesPage.tsx', 'ProjectDetailPage.tsx', 'TaskDetailPage.tsx'] as const;
    const src: Record<string, string> = {};
    for (const p of pages) src[p] = RD(`${A}/renderer/src/pages/${p}`);
    for (const p of pages) {
      ok(src[p]!.includes("from '../lib/list-page'"),
        `D-g-41 [${p}] 跨 root 引**同一份**批次与判据（renderer 是词表的第二个落点，不许自带第二把尺）`);
    }
    // ★反证：调用处不得写死"这批取多少"。两个列表页各只有一个列表，一条写死的字面量都不该有；
    //   任务详情页有两个列表，`loadMoreConvs`/`loadMoreDelivs` 各带一个 `=1` 的**哨兵**
    //   （本轮只翻一个列表，另一个列表只要 1 行占位、不重复取一整批），故那一页按**穷举**判：
    //   允许出现的字面量恰好只有这两个哨兵，多一个（比如 `limit: 200`）即判红。
    for (const p of ['DeliverablesPage.tsx', 'ProjectDetailPage.tsx'] as const) {
      ok(!/[Ll]imit:\s*\d+/.test(src[p]!),
        `D-g-42 [${p}] ★反证：调用处**没有写死的批大小字面量**（否则改一处界面批次要满仓找 100）`);
    }
    eq(((src['TaskDetailPage.tsx']!.match(/[A-Za-z]*[Ll]imit:\s*\d+/g) ?? []) as string[]).sort(),
      ['convLimit: 1', 'delivLimit: 1'],
      'D-g-42b [TaskDetailPage.tsx] ★反证：字面量**穷举**恰两个翻页哨兵（`=1` = "另一个列表只要 1 行"），批大小一律走真源');
    ok(src['DeliverablesPage.tsx']!.includes('const PAGE_SIZE = LIST_PAGE_SIZE;'),
      'D-g-43 成果页把批次收敛成一个名字（后续三处调用都读它）');
    ok(src['DeliverablesPage.tsx']!.includes('{ limit: PAGE_SIZE, offset: 0 }')
      && src['DeliverablesPage.tsx']!.includes('{ limit: PAGE_SIZE, offset: items.length }'),
      'D-g-44 ★成果页首屏取第 0 页、「加载更多」按**已列出的条数**取下一页（不是重新取前 N 条）');
    ok(src['ProjectDetailPage.tsx']!.includes('{ limit: LIST_PAGE_SIZE, offset: 0 }')
      && src['ProjectDetailPage.tsx']!.includes('{ limit: LIST_PAGE_SIZE, offset: pjDelivs.length }'),
      'D-g-45 ★项目详情页同尺（首屏 0 / 续取已列出条数）');
    ok(src['TaskDetailPage.tsx']!.includes('convLimit: LIST_PAGE_SIZE, convOffset: 0, delivLimit: LIST_PAGE_SIZE, delivOffset: 0')
      && src['TaskDetailPage.tsx']!.includes('convOffset: convs.length')
      && src['TaskDetailPage.tsx']!.includes('delivOffset: delivs.length'),
      'D-g-46 ★任务详情两个列表各取第 0 页、各按已列出条数续取（参数一个不漏）');
    // 计数如实：印服务端总数，不印当页长度
    ok(src['TaskDetailPage.tsx']!.includes('本任务（含子任务）{delivTotal} 条')
      && src['TaskDetailPage.tsx']!.includes('对话历史 ({convTotal})'),
      'D-g-47 ★折叠头与计数块印**服务端全量**（`delivTotal`/`convTotal`）');
    ok(!src['TaskDetailPage.tsx']!.includes('本任务（含子任务）{delivs.length}')
      && !src['TaskDetailPage.tsx']!.includes('对话历史 ({convs.length})'),
      'D-g-48 ★反证：把"这一批多少"印成"一共多少"的旧写法已零处（那时下方还挂着「加载更多」，自相矛盾）');
    ok(src['TaskDetailPage.tsx']!.includes('{delivTotal === 0 && retiredCount > 0 && ('),
      'D-g-49 「重试后仅存退休件」的提示判**全量**为 0（否则分页后第一页恰空的假象会让它不亮）');
    ok(src['DeliverablesPage.tsx']!.includes('const projects = facetProjects.map(p => [p.id, p.name || \'未知项目\'] as const)')
      && !src['DeliverablesPage.tsx']!.includes('new Map(items.filter('),
      'D-g-50 ★下拉名录既不受页内筛选、也不受分页影响（E15「选定后自坍缩」不会换个入口复发）');
    ok(src['DeliverablesPage.tsx']!.includes('{!itemsExhausted && (')
      && src['DeliverablesPage.tsx']!.includes('另有 {Math.max(itemsTotal - items.length, 0)} 条未加载'),
      'D-g-51 ★页脚只在"没取尽"时出现，且把"还剩多少 + 列排序/筛选只覆盖已加载行"如实写出'
      + '（缺这句，用户会把"筛选无匹配"读成"库里没有"，而其实只是没取）');
  }
}

// ══════════════════════════════════════════════════════════════════
// 【E-a】M5 记忆写侧 · 内容装配一处真源（纯函数 · 两侧标本 · 确定性）
// ══════════════════════════════════════════════════════════════════
function groupEa(): void {
  console.log('\n【E-a】M5 写侧内容装配（`memory-write.ts` 纯函数：证据有则写、无则整行不写）');

  // ── ① 失败知识：三段（类别必有 / 详情按有 / 上下文按有），缺证据时如实不写 ──
  {
    const rec = { reason: '无产出物', stepsUsed: 12, toolCount: 5, tools: ['write_file', 'read_file'] };
    const full = buildFailureKnowledge({ title: '生成周报', errorMessage: 'SDK 502', record: rec, archetype: 'document' });
    eq(full.split('\n')[0], '任务「生成周报」失败——类别：无产出物',
      'E-a-1 首行＝任务名 + 类别（类别取既有真源 `failure_record.reason`，不另立一套分类）');
    ok(full.includes('失败详情：SDK 502'), 'E-a-2 有 `err.message` 即写"失败详情"那一行');
    eq(full.split('\n')[2], '上下文：原型=document，步数=12，工具调用=5，最近工具=write_file、read_file',
      'E-a-3 上下文行四项固定次序（确定串 ⇒ 判据可比等号，不是"包含某子串"那种抓不住回归的弱形态）');

    // 另一侧：**无** record、**无** errorMessage、**无** archetype —— 只剩类别一行。
    const bare = buildFailureKnowledge({ title: '生成周报' });
    eq(bare, '任务「生成周报」失败——类别：执行异常',
      'E-a-4 ★另一侧：一条证据都没有时只写得出类别一行（"执行异常"是如实标注，不是编一个具体类别）');
    ok(!bare.includes('上下文：') && !bare.includes('失败详情：'),
      'E-a-5 ★反证：无证据时那两行**整行不写**（写"失败详情：未记录"是把"没记到"伪造成一条事实）');
    eq(buildFailureKnowledge({ title: '', errorMessage: null }).split('\n')[0], '任务「（未命名任务）」失败——类别：执行异常',
      'E-a-6 标题缺失如实写"（未命名任务）"，不编、不空转成一个空引号');
    eq(buildFailureKnowledge({ title: '', errorMessage: null }), buildFailureKnowledge({ title: '', errorMessage: null }),
      'E-a-7 ★确定性：同入参恒同串（掺墙钟/随机 ⇒ 上面的等号判据只能退化成弱形态）');
  }

  // ── ② 子 agent 经验：首行必写，其余按有无增减 ──
  {
    eq(buildSubagentExperience({ role: '前端', title: '登录页', ok: true, reason: '三个组件已落地', keyFacts: '产出物=login.tsx' }).split('\n'),
      ['前端「登录页」完成', '结果：三个组件已落地', '关键事实：产出物=login.tsx'],
      'E-a-8 完整形状：角色「标题」完成 + 结果 + 关键事实');
    const bad = buildSubagentExperience({ title: '登录页', ok: false, reason: '缺后端接口约定' });
    eq(bad, '子agent「登录页」未完成\n结果：缺后端接口约定',
      'E-a-9 ★另一侧：失败写"未完成"；角色缺失时如实写"子agent"；无关键事实则整行不写');
    ok(!bad.includes('关键事实：'), 'E-a-10 ★反证：`keyFacts` 缺时不落一个空的"关键事实："行');
  }

  // ── ③ IM 纠正：只加出处前缀，用户原话逐字 ──
  {
    const line = buildImUserCorrection({ text: '别用登录页，改成首页', channel: '微信', taskTitle: '改导航' });
    eq(line, '用户纠正（任务「改导航」，渠道=微信）：别用登录页，改成首页',
      'E-a-11 IM 纠正＝出处前缀 + 用户原话');
    ok(line.endsWith('别用登录页，改成首页'),
      'E-a-12 ★用户原话**逐字**保留（改写用户的话即等于伪造纠正）');
    eq(buildImUserCorrection({ text: '  继续  ' }), '用户纠正：继续',
      'E-a-13 ★另一侧：无任务/无渠道时只有短头，且原话两侧空白被裁（不把空白当内容）');
  }

  // ── ④ 复盘"实际"：成功取完成摘要，失败**没有**它 ⇒ 如实取失败证据；一无所有 ⇒ null ──
  {
    eq(buildReviewActual({ status: 'completed', title: 't', completionSummary: '写完了' }), '写完了',
      'E-a-14 成功路的"实际"取 `context_json.completion_summary`');
    const failed = buildReviewActual({
      status: 'failed', title: 't',
      failureRecord: { reason: '无产出物', stepsUsed: 9 }, awaitingQuestion: '要不要换模板？',
    });
    eq(failed, '执行未产出成果（原因=无产出物，步数=9）\n任务停下等人工答复，问的是：要不要换模板？',
      'E-a-15 ★失败路没有 `completion_summary`（那条路根本不写它）⇒ 如实取两条既有真源拼成可复述的一句');
    eq(buildReviewActual({ status: 'failed', title: 't' }), null,
      'E-a-16 ★反证：一条事实都没有 ⇒ null（编一段"实际经过"喂给 LLM，复盘出的教训就是无源之谈）');
  }

  // ── ⑤ 复盘提示词：按终态分叉，两路输出契约**同形** ──
  {
    const recipe = buildTaskReviewPrompt({ status: 'completed', title: 't', completionSummary: 'x' });
    const lessons = buildTaskReviewPrompt({ status: 'failed', title: 't', failureRecord: { reason: '无产出物' } });
    eq([recipe?.focus, lessons?.focus], ['recipe', 'lessons'],
      'E-a-17 ★同一段装配按终态分叉（侧重由 `reviewFocus` 一处回答，两写点不各写一个三元）');
    const keys = (p?: string) => [...(p ?? '').matchAll(/"(\w+)"/g)].map((m) => m[1]);
    eq([keys(recipe?.prompt), keys(lessons?.prompt)], [['delta', 'lesson', 'action'], ['delta', 'lesson', 'action']],
      'E-a-18 ★★两路**同形**：输出 JSON 键一字不差（两路各写一份契约必然分叉，而下游解析只有一份）');
    eq(buildTaskReviewPrompt({ status: 'failed', title: 't' }), null,
      'E-a-19 ★无"实际"可讲 ⇒ 整段提示词为 null，调用方据此跳过（不产生复盘记忆）');
  }
}

// ══════════════════════════════════════════════════════════════════
// 【E-b】「哪些终态可复盘 / 该总结成什么」一个概念一个值
// ══════════════════════════════════════════════════════════════════
function groupEb(): void {
  console.log('\n【E-b】可复盘终态集（收进一处：三处守卫不再各写一份名单）');
  eq([...REVIEWABLE_STATUSES].sort(), ['completed', 'failed'],
    'E-b-1 可复盘终态集恰 {completed, failed}（失败任务此前**从不复盘**，而它的教训恰好更该被记住）');
  eq(['completed', 'failed', 'paused', 'archived', 'pending', 'executing', ''].map(isReviewableStatus),
    [true, true, false, false, false, false, false],
    'E-b-2 ★两侧同试：`paused` 与 `archived` 都**不**可复盘（暂停是"等人"，归档是收尾态、时机早已过去）');
  eq([isReviewableStatus(null), isReviewableStatus(undefined)], [false, false],
    'E-b-3 空状态不可复盘（`null` 不得被 `includes` 兜成真）');
  eq([reviewFocus('completed'), reviewFocus('failed')], ['recipe', 'lessons'],
    'E-b-4 侧重按终态分叉（成功=配方 / 失败=教训与阻塞条件）');

  const jobs = RD(`${A}/src/main/core/task-jobs.ts`);
  const m = jobs.match(/export function isTerminalTask[\s\S]{0,600}?\n\}/);
  ok(!!m && m[0].length > 100, 'E-b-5 扫描面自证：`isTerminalTask` 取到（否则下面那条边界是空转假绿）', m ? `${m[0].length} 字节` : '0');
  // zx_20261021_2 D2/D3：三元组收为 `TERMINAL_STATUSES` 一处真源，`isTerminalTask` 改成经
  //   `isTerminalStatus` 取——旧判据在**函数体里找字面量**，收口后切到空块。
  //   按新载体重定向：既钉「三元组本身含 archived」，又钉「isTerminalTask 真的经它取」——只钉前者
  //   会漏掉"函数自己另抄一份名单"的情形（那正是收口前的老样子）。
  const triple = jobs.match(/export const TERMINAL_STATUSES\s*=\s*\[([^\]]*)\]/);
  const terminalStatuses = triple ? [...triple[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  eq(terminalStatuses, ['completed', 'failed', 'archived'],
    'E-b-6a ★终态三元组一处真源（`isTerminalTask` 与执行体/暂停写口/改状态共用一份）');
  ok(!!m && m[0].includes('isTerminalStatus('),
    'E-b-6b ★`isTerminalTask` 经 `isTerminalStatus` 取三元组（不另抄第二份名单）');
  ok(terminalStatuses.includes('archived') && !(REVIEWABLE_STATUSES as readonly string[]).includes('archived'),
    'E-b-6 ★`isTerminalTask` 含 `archived` 而可复盘集不含 ⇒ 两者**同值不同义、刻意不并入**'
    + '（前者答"还跑不跑得动"，后者答"值不值得总结一次"；并入即把两个可独立调节的概念锁死）');
}

// ══════════════════════════════════════════════════════════════════
// 【E-c】写侧真落库（真 `MemoryManager` × 内存库真行 · 计数器 0→1）
// ══════════════════════════════════════════════════════════════════
/** E-c 夹具：照抄 `database.ts` 运行时形状（与 `rr_zx_20260924_1_b7.ts` 同一把尺，G-7）。 */
const E_SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', working_dir TEXT DEFAULT '', context_json TEXT DEFAULT '{}',
  sandbox_mode TEXT DEFAULT 'workspace', autonomous_mode TEXT DEFAULT 'off',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', priority INTEGER DEFAULT 0,
  depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '', source TEXT DEFAULT 'user',
  acceptance_criteria TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL,
  embedding TEXT, memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5,
  reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '',
  valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0,
  exemplar_type TEXT, exemplar_context TEXT, use_count INTEGER DEFAULT 0, last_used_at TEXT,
  similar_to TEXT DEFAULT '', last_reinforced_at TEXT, success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL,
  name TEXT DEFAULT '', file_path TEXT, status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', tool_calls TEXT, token_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));
`;

function groupEc(): void {
  console.log('\n【E-c】写侧真落库（生产写手 × 真 MemoryManager；`failure_knowledge` / `subagent_experience` 0→1）');
  const db = new DatabaseSync(':memory:') as unknown as AnyDb;
  db.exec(E_SCHEMA);
  // ★先 `new` 服务类（FTS 同步触发器在此建成）**再**插行——顺序颠倒则触发器建于行之后，
  //   首次 UPDATE 命中未索引 rowid 抛错、被 `catch` 吞掉 ⇒ 下面全是假绿（本仓已明写此纪律）。
  const mem = new MemoryManager(db, null as never);
  db.prepare("INSERT INTO wa_projects (id, name) VALUES ('p1', '夹具项目')").run();
  const cnt = (tid: string, t: string): number =>
    (db.prepare('SELECT COUNT(*) AS c FROM wa_memories WHERE task_id = ? AND memory_type = ?').get(tid, t) as { c: number }).c;
  const one = (tid: string, t: string, col: string): string =>
    (db.prepare(`SELECT ${col} AS v FROM wa_memories WHERE task_id = ? AND memory_type = ?`).get(tid, t) as { v: string }).v;

  // ── 失败知识（"无产出物"路的真实入参：`executeTask` 正常返回 ⇒ 调用方手上**没有**异常对象） ──
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?,?,?,?,?)')
    .run('t-fail', 'p1', '生成周报', 'failed', JSON.stringify({ archetype: 'document', failure_record: { reason: '无产出物', stepsUsed: 7 } }));
  eq(cnt('t-fail', MEM_TYPE_FAILURE_KNOWLEDGE), 0,
    'E-c-1 前置自证：起初 0 行（否则下面那句"0→1"是空转假绿）');
  const id1 = writeFailureKnowledge(db, mem, 't-fail', 'p1');
  ok(!!id1, 'E-c-2 ★写侧**真写进去**并返回记忆 id（此前 `failure_knowledge` 全仓无写点 ⇒ 读侧 `<failure-awareness>` 恒空）');
  eq(cnt('t-fail', MEM_TYPE_FAILURE_KNOWLEDGE), 1,
    'E-c-3 ★计数器 0→1（"不抛"代替不了这一条：被 `catch` 吞掉的写入只有正面断言抓得住）');
  eq(one('t-fail', MEM_TYPE_FAILURE_KNOWLEDGE, 'content'),
    buildFailureKnowledge({ title: '生成周报', errorMessage: null, record: { reason: '无产出物', stepsUsed: 7 }, archetype: 'document' }),
    'E-c-4 ★落库内容＝纯函数产出（`err` 缺省正是该路的真实入参，不是"少传了参数"）');
  eq(one('t-fail', MEM_TYPE_FAILURE_KNOWLEDGE, 'source'), 'task_failure',
    'E-c-5 来源如实标 `task_failure`（不是泛泛的 `agent_execution`——来源分表要按它算可信度）');
  eq(writeFailureKnowledge(db, mem, 't-fail', 'p1'), null, 'E-c-6 再调一次返回 null');
  eq(cnt('t-fail', MEM_TYPE_FAILURE_KNOWLEDGE), 1,
    'E-c-7 ★行数仍是 1（按任务幂等：读侧取"项目内最新 3 条"，同任务重复会把别的任务的教训挤出窗口）');
  eq(writeFailureKnowledge(db, undefined, 't-fail', 'p1'), null,
    'E-c-8 无 `MemoryManager`（旧调用/夹具）⇒ 只是不记，不抛、也不阻断失败落账');

  // ── 子 agent 经验：非子任务一字不写；子任务 0→1，关键事实只取"算数的成果" ──
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?,?,?,?,?)')
    .run('t-plain', 'p1', '普通任务', 'completed', JSON.stringify({}));
  eq(writeSubagentExperience(db, mem, 't-plain', 'p1'), null,
    'E-c-9 ★非子任务（`context_json.type !== "subagent"`）一字不写');
  eq(cnt('t-plain', MEM_TYPE_SUBAGENT_EXPERIENCE), 0,
    'E-c-10 ★计数仍为 0（这一条防的是"顺手给所有终态都记一条经验"）');

  db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?,?,?,?,?)')
    .run('t-sub', 'p1', '落地登录页', 'completed',
      JSON.stringify({ type: 'subagent', subagentType: '前端', completion_summary: '三个组件已落地' }));
  const drow = (id: string, type: string, name: string, fp: string, status: string) =>
    db.prepare('INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path, status) VALUES (?,?,?,?,?,?,?)')
      .run(id, 'p1', 't-sub', type, name, fp, status);
  drow('d1', 'code', 'login.tsx', 'src/login.tsx', 'draft');
  drow('d2', 'code', 'old.tsx', 'src/old.tsx', 'retired');          // 已退休：不算
  drow('d3', 'doc', 'x', 'data/_sandbox/probe_run.md', 'draft');    // 探针件：不算
  const id2 = writeSubagentExperience(db, mem, 't-sub', 'p1');
  ok(!!id2, 'E-c-11 ★子任务终态写一条经验（"是不是子任务"取派活处写入的既成事实 `context_json.type`）');
  eq(cnt('t-sub', MEM_TYPE_SUBAGENT_EXPERIENCE), 1, 'E-c-12 ★计数器 0→1');
  const sub = one('t-sub', MEM_TYPE_SUBAGENT_EXPERIENCE, 'content');
  eq(sub.split('\n')[0], '前端「落地登录页」完成', 'E-c-13 首行取 `subagentType` + 标题 + 完成（成功取 `completion_summary`）');
  ok(sub.includes('结果：三个组件已落地'), 'E-c-14 结果取成功路的既有真源');
  ok(sub.includes('关键事实：产出物=login.tsx'), 'E-c-15 ★关键事实取本任务已登记成果的名字');
  eq([sub.includes('old.tsx'), sub.includes('probe_run')], [false, false],
    'E-c-16 ★两只反例同试：退休件与探针件都**不算**成果（范围谓词走 M4-1 共享真源，不是这里另写一份）');
  eq(writeSubagentExperience(db, mem, 't-sub', 'p1'), null, 'E-c-17 再调一次返回 null');
  eq(cnt('t-sub', MEM_TYPE_SUBAGENT_EXPERIENCE), 1, 'E-c-18 ★行数仍是 1（恢复多轮不堆出多份"同一件事"）');
}

// ══════════════════════════════════════════════════════════════════
// 【E-d】IM 纠正真跑路由（真 `routeImMessage` × 真 `MemoryManager` ⇒ `user_correction` 0→1）
// ══════════════════════════════════════════════════════════════════
async function groupEd(): Promise<void> {
  console.log('\n【E-d】IM 纠正落记忆（真跑生产入口，禁自造入参）');
  const router = RD(`${A}/src/main/services/im-router.ts`);
  ok(router.length > 20_000, 'E-d-1 扫描面自证：`im-router.ts` 原文非空', `${router.length} 字节`);

  const db = new DatabaseSync(':memory:') as unknown as AnyDb;
  db.exec(B_SCHEMA);
  db.exec(`CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL,
  embedding TEXT, memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5,
  reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '',
  valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0,
  exemplar_type TEXT, exemplar_context TEXT, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));`);
  const mem = new MemoryManager(db, null as never);
  const PHRASE = '标题要用宋体，别用黑体';
  const TITLE = '把报告改成中文';
  bTask(db, 'im-cor', 'u_corr', TITLE);
  const replies: string[] = [];
  await routeImMessage({ ...bCtx(db, replies), getMemory: () => mem } as never, 'u_corr', PHRASE, 'private', '');

  const rows = db.prepare('SELECT project_id, task_id, content, source, memory_type, context_json FROM wa_memories ORDER BY rowid').all() as
    Array<{ project_id: string; task_id: string; content: string; source: string; memory_type: string; context_json: string }>;
  eq(rows.length, 1, 'E-d-2 ★计数器 0→1：这句话落了一条记忆（此前 `user_correction` 写侧为零 ⇒ 三条保护全不可达）');
  eq(rows[0]?.source, MEM_SOURCE_USER_CORRECTION,
    'E-d-3 ★来源＝`user_correction`（这才点亮：置信顶分 / `sameSourceReplace` 永不覆盖 / 衰减豁免）');
  eq([rows[0]?.task_id, rows[0]?.project_id], ['im-cor', 'p1'], 'E-d-4 归属取**被恢复的那张任务**，不是猜的');
  eq(rows[0]?.content, buildImUserCorrection({ text: PHRASE, channel: CH_IM, taskTitle: TITLE }),
    'E-d-5 ★落库内容＝纯函数产出（出处前缀 + 原话逐字）');
  ok(!!rows[0]?.content.endsWith(PHRASE), 'E-d-6 ★用户原话逐字在库（改写用户的话即等于伪造纠正）');
  eq(JSON.parse(rows[0]?.context_json || '{}').experience, 'direct',
    'E-d-7 ★`experience` 由 `storeText` 按 `user_*` 来源自动推成 `direct`——走 `storeText` 而非裸 INSERT 才带得上');

  // 另一侧：上下文**没有** `getMemory`（旧调用/夹具）⇒ 一条记忆都不写，但路由照走、话照投。
  {
    const db2 = new DatabaseSync(':memory:') as unknown as AnyDb;
    db2.exec(B_SCHEMA);
    db2.exec(`CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL,
  embedding TEXT, memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5,
  reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '',
  valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0,
  exemplar_type TEXT, exemplar_context TEXT, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));`);
    bTask(db2, 'im-cor2', 'u_corr2', TITLE);
    const replies2: string[] = [];
    await routeImMessage(bCtx(db2, replies2) as never, 'u_corr2', PHRASE, 'private', '');
    eq((db2.prepare('SELECT COUNT(*) AS c FROM wa_memories').get() as { c: number }).c, 0,
      'E-d-8 ★另一侧：取不到 `MemoryManager` ⇒ 零写入（记忆是副产品，不得成为路由的前置条件）');
    eq(bConvs(db2).filter(c => c.content === `[IM回复] ${PHRASE}`).length, 1,
      'E-d-9 ★★但这句话**照样投给了那张任务**（两件事分开判：少记一条 ≠ 少投一句）');
  }

  // 三条既有保护**是否真的接上了**（此前不可达）：`sameSourceReplace` 的两侧标本用**同一段内容**，
  //   只换来源——同一把尺下"永不覆盖"才谈得上是被测的事实，而不是"查无此内容"的巧合。
  {
    const db3 = new DatabaseSync(':memory:') as unknown as AnyDb;
    db3.exec(E_SCHEMA);
    const mem3 = new MemoryManager(db3, null as never);
    mem3.storeText({ project_id: 'p1', content: '同一段内容', source: 'agent_execution' });
    const same = mem3.sameSourceReplace('p1', 'agent_execution', '同一段内容');
    ok(!!same, 'E-d-10 ★合法侧标本：同来源 + 同内容 ⇒ 走覆盖（`sameSourceReplace` 真的会动库）');
    eq(mem3.sameSourceReplace('p1', 'user_correction', '同一段内容'), null,
      'E-d-11 ★★另一侧：**同一段内容**换成 `user_correction` 来源 ⇒ 永不覆盖（内容一样，故差异只可能来自来源）');
    eq((db3.prepare("SELECT COUNT(*) AS c FROM wa_memories WHERE source = 'user_correction'").get() as { c: number }).c, 0,
      'E-d-12 ★反证：那次调用**没有**顺手插一条（不然"返回 null"就可能只是"没查到"的同义词）');
  }
}

// ══════════════════════════════════════════════════════════════════
// 【E-e】静态接线：写点落在**真出口**上、名字同引一处真源、renderer 是词表第二落点
// ══════════════════════════════════════════════════════════════════
function groupEe(): void {
  console.log('\n【E-e】静态接线与词表（G-5：读**原文**，锚点钉符号/语句形状）');
  const aiTask = RD(`${A}/src/main/core/jobs/ai-task.ts`);
  ok(aiTask.length > 10_000, 'E-e-1 扫描面自证：`jobs/ai-task.ts` 原文非空', `${aiTask.length} 字节`);

  // ① 失败知识的判据是**终局状态**，不是"这一笔是不是本次落的"
  ok(/if \(status === 'failed'\) \{\s*\n\s*try \{ writeFailureKnowledge\(db, hooks\?\.memory, taskId, projectId, err\); \}/.test(aiTask),
    'E-e-2 ★★`recordExecutionFailure` 的失败知识写点判 **`status === \'failed\'`**（终局状态）而非 `recorded`——'
    + '`executeTask` 自己先标 `failed` 再 `throw` ⇒ 按 `recorded` 判，最常走的异常失败路一条也写不出来');
  ok(!/if \(recorded\) \{[\s\S]{0,160}writeFailureKnowledge/.test(aiTask),
    'E-e-3 ★反证：没有任何一处把失败知识挂在 `recorded` 上');
  ok(/if \(statusRow\?\.status === 'failed'\) \{\s*\n\s*try \{ writeFailureKnowledge\(db, memory, taskId, projectId\); \}/.test(aiTask),
    'E-e-4 ★★"无产出物"路的写点（`executeTask` 正常返回 ⇒ 上面那条 catch 根本不执行，唯一能看见这次失败的就是此处读回的终态）');
  ok(/if \(memory && taskRow && taskRow\.status === 'failed'\) \{\s*\n\s*try \{ writeFailureKnowledge\(db, memory, taskId, taskRow\.project_id\); \}/.test(aiTask),
    'E-e-5 恢复路同形补一处（同一张任务在恢复途中失败也不会漏账）');

  // ② 子 agent 经验：四个终态/异常出口各一处（幂等由写手自持，故重复调用无虞）
  const subSites = (aiTask.match(/writeSubagentExperience\(db, memory,/g) ?? []).length;
  ok(subSites >= 4, 'E-e-6 ★子 agent 经验写在**四个真出口**上（成功路 / 异常路 / 恢复成功路 / 恢复异常路），不多写不重复', `${subSites} 处`);
  const failWrites = (aiTask.match(/writeFailureKnowledge\(/g) ?? []).length;
  ok(failWrites >= 4, 'E-e-7 失败知识写手在册（定义 + 分发路 + 无产出物路 + 恢复路）', `${failWrites} 处`);

  // ③ 三处守卫与提示词同引"可复盘终态集"，不再各写一份 `'completed'`
  ok(/if \(isReviewableStatus\(statusRow\?\.status\)\) scheduler\.enqueue\('background-review'/.test(aiTask)
    && /if \(taskRow && isReviewableStatus\(taskRow\.status\)\) \{ try \{ scheduler\.enqueue\('background-review'/.test(aiTask),
    'E-e-8 ★两条复盘调度守卫都改走 `isReviewableStatus`（写死 `\'completed\'` 正是"失败从不复盘"的成因）');
  ok(/if \(rec\.status === 'failed'\) \{ try \{ scheduler\.enqueue\('background-review'/.test(aiTask),
    'E-e-9 ★异常失败路的复盘同样按**终局状态**判（`rec.recorded` 恒假的那条路不再被漏掉）');

  // ④ 名字同引一处真源：两侧都不许出现该名字的字面量
  //    针身由**真源派生**（不手抄进本文件）：若改成手抄，判据自己就成了第四份词表落点。
  const readSide = RD(`${A}/src/main/core/exec-context.ts`);
  const writeSide = RD(`${A}/src/main/core/memory-write.ts`);
  for (const [name, src] of [['exec-context.ts', readSide], ['memory-write.ts', writeSide], ['jobs/ai-task.ts', aiTask]] as const) {
    eq((src.match(new RegExp(`'${MEM_TYPE_FAILURE_KNOWLEDGE}'`, 'g')) ?? []).length, 0,
      `E-e-10 [${name}] ★零名字字面量（名字只许从 memory-constants.ts 引——写侧拼一个近义串，查询恒空而无人报错）`);
  }
  ok(/memory_type = \? ORDER BY created_at DESC LIMIT 3'\)\.all\(projectId, MEM_TYPE_FAILURE_KNOWLEDGE\)/.test(readSide),
    'E-e-11 ★读侧把**同一个常量**作参数传进去（不是把名字抄进 SQL 串）');
  eq([MEM_TYPE_FAILURE_KNOWLEDGE, MEM_TYPE_SUBAGENT_EXPERIENCE, MEM_SOURCE_USER_CORRECTION],
    ['failure_knowledge', 'subagent_experience', 'user_correction'],
    'E-e-12 三个名字的真值（改这里的值＝改表内既存行的可读性，故它必须与 `memory-manager.ts` 里判 source 的那几处同值）');

  // ⑤ IM 路：内容装配 + 来源名各引一处；管理器**惰性取用**（构造期拿不到实例）
  ok(/import \{ buildImUserCorrection \} from '\.\.\/core\/memory-write\.js'/.test(RD(`${A}/src/main/services/im-router.ts`))
    && /import \{ MEM_SOURCE_USER_CORRECTION \} from '\.\.\/core\/memory-constants\.js'/.test(RD(`${A}/src/main/services/im-router.ts`)),
    'E-e-13 IM 路的内容装配与来源名都从真源引（不在 im-router 里就地拼一句、就手写一个串）');
  const imIpc = RD(`${A}/src/main/ipc/im.ipc.ts`);
  eq((imIpc.match(/getMemory: _getMemoryForIm,/g) ?? []).length, 2,
    'E-e-14 ★两个 `routeImMessage` 调用点**都**把 `getMemory` 传下去（只补一处＝另一半入站永久不记）');
  ok(/export function initImIpc\(db: Database\.Database, dataDir: string, getMemory\?: \(\) => MemoryManager \| undefined\)/.test(imIpc),
    'E-e-15 `initImIpc` 收**惰性取用**而非实例（它在 `MemoryManager` 构造**之前**被调用）');
  ok(/initImIpc\(db, dataDir, \(\) => memory\)/.test(RD(`${A}/src/main/index.ts`)),
    'E-e-16 启动处传惰性取用（与上一行 `initProjectIpc` 同形，不是新发明的花样）');

  // ⑥ GUI 编辑即纠正：改**内容**才动来源（不改语义就不改身份）
  const admin = RD(`${A}/src/main/ipc/admin.ipc.ts`);
  ok(/if \(content\) db\.prepare\('UPDATE wa_memories SET content = \?, source = \?[\s\S]{0,80}?\.run\(content, MEM_SOURCE_USER_CORRECTION, id\)/.test(admin),
    'E-e-17 ★改内容同时把来源改为 user_correction（只改重要度/理由不算纠正 ⇒ 不动来源）');
  ok(/SET importance = \?, updated_at/.test(admin) && /SET reasoning = \?, updated_at/.test(admin),
    'E-e-18 ★两侧在场：重要度、理由各自一条 UPDATE（这两条是"对同一条内容的重新评估"）');
  ok(!/SET (importance|reasoning) = \?, source/.test(admin),
    'E-e-19 ★★反证：那两条支路**不碰** `source`——写了就成"改个重要度＝用户纠正了这条"，'
    + '白得 0.95 置信顶分与衰减豁免（**不改语义就不改身份**）');

  // ⑦ renderer 是词表的**第二个落点**（不在 `src/main` 扫描面内）
  const pdp = RD(`${A}/renderer/src/pages/ProjectDetailPage.tsx`);
  const mp = RD(`${A}/renderer/src/pages/MemoriesPage.tsx`);
  // zx_20261019（c7c8eeb4）把两页各自手抄的词表收成 `MEM_TYPE_LABEL` 一处真源 ⇒ 旧判据（在页面里找
  //   内联中文名）从此恒红。按新载体重定向，两侧合起来才等价于原意：
  //   ① 真源本身给两类中文名；② 两页都直引真源、不再手抄第二份。
  const vocab = RD(`${A}/src/main/core/memory-lifecycle.ts`);
  const labelBlock = vocab.match(/export const MEM_TYPE_LABEL[\s\S]{0,800}?\n\};/)?.[0] ?? '';
  ok(labelBlock.includes("failure_knowledge: '失败知识'") && labelBlock.includes("subagent_experience: '子代理经验'"),
    'E-e-20a 真源 MEM_TYPE_LABEL 为两类新记忆类型给出中文名（缺项则界面显示英文键）');
  ok(pdp.includes('import { MEM_TYPE_LABEL }') && !/failure_knowledge:\s*'/.test(pdp),
    'E-e-20b [ProjectDetailPage] 直引真源且不手抄第二份（判定残留=页面内仍有内联词表）');
  // 注意：本页另有一张**配色**表（`failure_knowledge:'bg-red-100 …'`），那不是中文名词表；
  //   故反证只针对"页内再写一份中文名"（引号内容含汉字），不误伤配色行。
  ok(mp.includes('MEM_TYPE_LABEL') && !/failure_knowledge:\s*'[^']*[一-龥]/.test(mp),
    'E-e-21 [MemoriesPage] 类型筛选钮同尺（同一份真源，不在页面里另写一份中文名）');
  ok(mp.includes("failure_knowledge:'bg-red-100 text-red-700'") && mp.includes("subagent_experience:'bg-teal-100 text-teal-700'"),
    'E-e-22 [MemoriesPage] 两类各有一档配色（无配色则退化成灰底默认色）');
}

// ══════════════════════════════════════════════════════════════════
// 【F-a】M6 纯函数：半衰期表 / 年龄基准 / 归因硬锚点（两侧标本各一）
// ══════════════════════════════════════════════════════════════════
function groupFa(): void {
  console.log('\n【F-a】半衰期表 / 年龄基准 / 归因硬锚点（G-4：显式喂 `nowMs`，不依赖真实墙钟）');

  // ① 半衰期**按记忆类型派生**（原来四处各写一个裸常数：14 / 21 / 30 / ≈7）
  eq([baseHalfLifeDays('episodic'), baseHalfLifeDays('semantic'), baseHalfLifeDays('preference'),
      baseHalfLifeDays('negative'), baseHalfLifeDays('panorama'), baseHalfLifeDays('这个类型不存在'), baseHalfLifeDays(null)],
     [7, 30, 90, 90, 90, 30, 30],
     'F-a-1 ★三档半衰期：情景 7 ／可复用认识 30 ／偏好与负空间 90；未知类型与空值落 `default: 30`');
  eq(['procedural', 'retrospective', 'prospective', 'failure_knowledge', 'subagent_experience', 'limiting_belief']
       .filter((t) => !(t in MEM_HALF_LIFE_DAYS)), [],
     'F-a-2 ★★六个"可复用认识"类**逐条在册**——`default` 恰同为 30，漏写也读作 30，只有"在册"这一条分辨得出来');

  // ② 复合：类型基准 × 效价 × 核心豁免（三项同一条乘积，任一项漏乘都乱）
  const hl = (over: Record<string, unknown>) => halfLifeDays({ memory_type: 'episodic', ...over });
  eq([hl({}), hl({ valence: 'positive' }), hl({ valence: 'negative' }), hl({ source: 'user_correction' })],
     [7, 14, 3.5, 35],
     'F-a-3 ★★复合口诀同试：正效价 ×2 ／负效价 ×0.5 ／核心（`source=user_correction`）×`CORE_HALF_LIFE_FACTOR`');
  eq([CORE_HALF_LIFE_FACTOR, CORE_USE_COUNT], [5, 10],
     'F-a-4 两个核心豁免常数的值（改它＝改"什么算核心"，须跟着理据走）');
  eq([isCoreMemory({ source: 'user_correction' }), isCoreMemory({ use_count: CORE_USE_COUNT }),
      isCoreMemory({ memory_type: 'negative' }), isCoreMemory({ is_exemplar: 1 }),
      isCoreMemory({ source: 'agent_execution' }), isCoreMemory({ use_count: CORE_USE_COUNT - 1 })],
     [true, true, true, true, false, false],
     'F-a-5 ★核心四类各一、非核心一侧、以及**门槛下沿**一侧（9 次不豁免 ⇒ 门槛是"≥10"而非">0"）');

  // ③ 年龄基准：三个**语义**时间戳取最大；`updated_at` 永不参与（M6 靶心）
  const NOW = Date.parse('2030-06-01T00:00:00Z');
  const ago = (n: number) => new Date(NOW - n * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
  const aged = { memory_type: 'episodic', created_at: ago(100) };
  eq([memoryAgeDays(aged, NOW), memoryAgeDays({ ...aged, last_used_at: ago(3) }, NOW),
      memoryAgeDays({ ...aged, last_reinforced_at: ago(1) }, NOW)],
     [100, 3, 1],
     'F-a-6 ★★年龄＝**三个语义时间戳取最大**：被用过／被加固过就变年轻（"老"不得把用过的东西一起判死）');
  ok(memoryAgeDays({ ...aged, updated_at: ago(1) } as never, NOW) === 100,
     'F-a-7 ★★靶心反证（M6 病根）：**多带一个 1 天前的 `updated_at` 不改变年龄**——'
     + '系统改写（降权／合并／工具改写内容）只说明"被写过"，不说明"被用过"；旧写法读 `updated_at` ⇒ 这里会答 1');
  eq([ageDaysSince(null), ageDaysSince(''), ageDaysSince('2030-05-30 00:00:00', NOW)],
     [0, 0, 2],
     'F-a-8 取不到时刻 ⇒ 0 天（不制造负年龄）；合法时刻 ⇒ 真天数（**含时区基准**：无后缀串按 UTC 解析）');

  // ④ 衰减曲线：`0.5 ** (age/hl)`；默认龄期取自 `memoryAgeDays`（不是另写一份算法）
  const dag = (n: number, over: Record<string, unknown> = {}) =>
    decayFactor({ memory_type: 'episodic', created_at: ago(n), ...over }, undefined, NOW);
  eq([dag(0), dag(7), dag(14)], [1, 0.5, 0.25],
     'F-a-9 ★半衰期语义可直读：7 天 ⇒ 0.5、14 天 ⇒ 0.25（写作 `0.5 ** (age/hl)` 而非隐式 λ）');
  eq(decayFactor({ memory_type: 'episodic', created_at: ago(7) }, 7, NOW), 0.5,
     'F-a-10 ★显式龄期与默认龄期**同值** ⇒ 默认那一支确实喂的是 `memoryAgeDays`');
  ok(dag(70, { source: 'user_correction' }) > dag(70),
     'F-a-11 ★核心豁免在**衰减曲线**上真的生效（70 天处：核心 0.25 vs 非核心 ≈0.001，差约 250 倍）',
     `${dag(70, { source: 'user_correction' }).toExponential(2)} vs ${dag(70).toExponential(2)}`);
  eq([RETRIEVAL_TAU_DAYS, MATURITY_TAU_DAYS, CONFIDENCE_TAU_DAYS], [14, 21, 30],
     'F-a-12 三条曲线的尺度常数（**是 τ 不是半衰期**，值刻意不动——本轮收的是"散落归一处"，不是"顺手改曲线"）');

  // ⑤ 归因硬锚点：`failureAnchors` / `isAttributable`（M6-3）
  eq(failureAnchors({ reason: '端口 8080 被占用', tools: ['deploy'] }, '部署任务'),
     ['deploy', '端口', '8080', '被占用', '部署任务'],
     'F-a-13 ★锚点恰从**失败自己留下的字据**取：`tools[]` ∪ `reason` 实词 ∪ 标题实词（顺序＝出现序，不掺 `Set` 迭代序）');
  eq(failureAnchors({ tools: ['a', 'ab', 'ab'] }, ''), ['ab'],
     'F-a-14 ★★两只边界同试：单字锚点在几乎任何正文里都命中（等于没锚）⇒ 丢弃；重复锚点去重但**保留出现序**');
  eq(failureAnchors(null, ''), [], 'F-a-15 无字据也无标题 ⇒ 空锚点（"什么都不知道"）；此函数**不猜**');
  eq([isAttributable('用方案 A 部署到生产环境前，先确认端口 8080 未被占用', ['8080']),
      isAttributable('代码评审时优先看函数是否单一职责', ['8080'])],
     [true, false],
     'F-a-16 ★★归因两侧同试（同一批锚点、两段正文）：命中 ⇒ 可指认；不命中 ⇒ 指认不了');
  eq([isAttributable('Deploy to PROD', ['deploy']), isAttributable('无关正文', [], null)], [true, false],
     'F-a-17 大小写不敏感；且**空锚点恒 false**——"指认不了"刻意不等于"标全部"（这正是与旧写法分道处）');
  eq(isAttributable('与正文无关', ['login.tsx'], 'src/login.tsx'), true,
     'F-a-18 证据锚点（`context_json.evidence.file_path`）与正文**同尺**并入判据');
}

// ══════════════════════════════════════════════════════════════════
// 【F-b】真 `MemoryManager` × 内存库真行：只有"本次真用上**且**可指认"才配受奖罚
// ══════════════════════════════════════════════════════════════════
/** F 夹具：与 E-c 同一把尺（`database.ts` 运行时形状，G-7）——先 `new` 服务类**再**插行。 */
function fWorld(): { db: AnyDb; mem: MemoryManager } {
  const db = new DatabaseSync(':memory:') as unknown as AnyDb;
  db.exec(E_SCHEMA);
  const mem = new MemoryManager(db, null as never);
  db.prepare("INSERT INTO wa_projects (id, name) VALUES ('p1', '夹具项目')").run();
  return { db, mem };
}
interface FSnap { stale: boolean; imp: number; fail: number; succ: number; reinf: string | null }
function fSnap(db: AnyDb, id: string): FSnap {
  const row = db.prepare('SELECT importance, context_json, success_count, failure_count, last_reinforced_at FROM wa_memories WHERE id = ?').get(id) as
    { importance: number; context_json: string; success_count: number; failure_count: number; last_reinforced_at: string | null };
  let stale = false;
  try { stale = !!(JSON.parse(row.context_json || '{}') as { staleness?: unknown }).staleness; } catch { /* 非法 context_json ⇒ 视为未标 */ }
  return { stale, imp: row.importance, fail: row.failure_count, succ: row.success_count, reinf: row.last_reinforced_at };
}
function fTask(db: AnyDb, id: string, title: string, ctx: Record<string, unknown>, status = 'failed'): void {
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?,?,?,?,?)')
    .run(id, 'p1', title, status, JSON.stringify(ctx));
}
function fConf(mem: MemoryManager, db: AnyDb, id: string): number {
  return mem.confidenceOf(db.prepare('SELECT * FROM wa_memories WHERE id = ?').get(id) as never);
}

function groupFb(): void {
  console.log('\n【F-b】真 `MemoryManager` × 内存库真行（M6-2「本次」/ M6-3「可指认」）');

  // ① 同一次 run、两条都真入文，字据只指认得甲 ⇒ 受奖罚的差别**只可能来自归因**
  {
    const { db, mem } = fWorld();
    const hit = mem.storeText({ project_id: 'p1', content: '用方案 A 部署到生产环境前，先确认端口 8080 未被占用', type: 'procedural' });
    const miss = mem.storeText({ project_id: 'p1', content: '代码评审时优先看函数是否单一职责', type: 'procedural' });
    eq([fSnap(db, hit).fail, fSnap(db, miss).fail], [0, 0], 'F-b-1 前置自证：两条起初 `failure_count` 都是 0');
    const confHitBefore = fConf(mem, db, hit);
    fTask(db, 't1', '部署任务', {
      memory_used_ids_run: [hit, miss],
      // 锚点**只从失败自己留下的字据里取**：`tools[]` + `reason` 实词 + 标题实词
      failure_record: { reason: '端口 8080 被占用', stepsUsed: 4, toolCount: 2, tools: ['deploy'] },
    });
    const touched = mem.reinforceMemories('t1', 'p1', false);
    const H = fSnap(db, hit); const M = fSnap(db, miss);
    eq(touched, 2, 'F-b-2 两条都真入文 ⇒ 都被处理（正面断言返回值，不用"不抛"代替）');
    eq([H.stale, H.fail, !!H.reinf], [true, 1, true],
       'F-b-3 ★甲可指认 ⇒ 打 `staleness` + 计数 0→1 + 写 `last_reinforced_at`');
    ok(H.imp < 0.6, 'F-b-4 ★甲被降权（0.6 → 0.55，失败侧 −0.05）', String(H.imp));
    eq([M.stale, M.imp, M.reinf, M.fail], [false, 0.6, null, 1],
       'F-b-5 ★★乙**指认不了** ⇒ 无 `staleness`、importance **分文不动**、`last_reinforced_at` 仍 NULL；'
       + '但计数 0→1 照记（"只记计数"不是"什么都不做"）');
    ok(fConf(mem, db, hit) < confHitBefore, 'F-b-6 ★甲 confidence 随之下降（`staleness ⇒ ×0.7`）',
       `${confHitBefore.toFixed(3)} → ${fConf(mem, db, hit).toFixed(3)}`);
  }

  // ② ★★M6-2 靶心：`memory_used_ids_run` **每 run 覆盖** ⇒ 上一次 run 用过的，这一次不该再被算账
  {
    const { db, mem } = fWorld();
    const A = mem.storeText({ project_id: 'p1', content: '第一批经验：先建索引再灌数据', type: 'procedural' });
    const B = mem.storeText({ project_id: 'p1', content: '第二批经验：灰度发布分三批', type: 'procedural' });
    fTask(db, 'r1', '第一次跑', { memory_used_ids_run: [A], injected_memory_ids: [A] }, 'completed');
    eq(mem.reinforceMemories('r1', 'p1', true), 1, 'F-b-7 第一次 run：处理 1 条');
    const a1 = fSnap(db, A);
    eq([a1.succ, a1.fail], [1, 0], 'F-b-8 ★甲 `success_count` 0→1');
    // 第二次 run：union 里**仍有甲**（累计注入，供排重），但本次真入文只有乙
    fTask(db, 'r2', '第二次跑', { memory_used_ids_run: [B], injected_memory_ids: [A, B] }, 'completed');
    eq(mem.reinforceMemories('r2', 'p1', true), 1, 'F-b-9 第二次 run：只处理 1 条（本次真入文只有乙）');
    const a2 = fSnap(db, A); const b2 = fSnap(db, B);
    eq([a2.succ, a2.fail, a2.imp === a1.imp], [1, 0, true],
       'F-b-10 ★★靶心：甲**在 union 里、不在本次 per-run 里** ⇒ 计数与 importance 分文不动'
       + '（旧写法把 union 当"本次用过" ⇒ 一次失败连坐全部注入记忆，这正是 M6 的病根）');
    eq([b2.succ, b2.fail], [1, 0], 'F-b-11 乙 `success_count` 0→1（新一代真入了文）');
    // 对照侧：老任务（无 per-run 键）只能读 union ⇒ 甲**会**被算到。差别只在"本次"那把尺
    fTask(db, 'r3', '老任务', { injected_memory_ids: [A] }, 'completed');
    eq(mem.reinforceMemories('r3', 'p1', true), 1, 'F-b-12 对照侧：老任务仍被处理（返回 1）');
    eq(fSnap(db, A).succ, 2,
       'F-b-13 ★★同一段 union、同一条甲：**per-run 有键 ⇒ 不动（1）／无键 ⇒ 计入（2）**——'
       + '两只标本共用一条记忆与同一段 union，差别只可能来自"本次"');
  }

  // ③ ★"空集"与"不知道"刻意区别：本次一条没用上 ⇒ 连计数都不动
  {
    const { db, mem } = fWorld();
    const C = mem.storeText({ project_id: 'p1', content: '这次一条都没用上的记忆', type: 'semantic' });
    fTask(db, 'e1', '未用任务', { memory_used_ids_run: [], injected_memory_ids: [C] });
    eq(mem.reinforceMemories('e1', 'p1', false), 0, 'F-b-14 ★本次真入文为空集 ⇒ 返回 0（谁都不碰）');
    eq([fSnap(db, C).fail, fSnap(db, C).stale], [0, false],
       'F-b-15 ★连计数都不动——"空集"（知道没用）与"缺键"（不知道）是两回事：前者不记、后者照记');
  }

  // ④ ★"老任务只记计数"与归因**无关**：正文里正含锚点，无 per-run 键也不许降权
  {
    const { db, mem } = fWorld();
    const L = mem.storeText({ project_id: 'p1', content: '部署前先确认端口 8080 未被占用', type: 'procedural' });
    fTask(db, 'l1', '部署任务', { injected_memory_ids: [L], failure_record: { reason: '端口 8080 被占用', tools: ['deploy'] } });
    eq(mem.reinforceMemories('l1', 'p1', false), 1, 'F-b-16 老任务仍被处理（返回 1）');
    const l = fSnap(db, L);
    eq([l.stale, l.imp, l.reinf, l.fail], [false, 0.6, null, 1],
       'F-b-17 ★★正文里**正含**锚点 `8080`，但因读不到 per-run 键 ⇒ 仍只记计数（不奖不罚）——'
       + '与 F-b-3/F-b-4 是同一条内容、同一批锚点：差别只可能来自"这次到底用没用"有没有凭据');
  }

  // ⑤ ★非"无产出物"的异常失败路（`failure_record` 缺省）⇒ 锚点只剩标题实词；
  //    同一次 run 里两条都真入文，只有正文里**真的含**标题实词的那条被降权
  {
    const { db, mem } = fWorld();
    const M = mem.storeText({ project_id: 'p1', content: '代码评审时优先看函数是否单一职责', type: 'procedural' });
    const N = mem.storeText({ project_id: 'p1', content: '上一轮「生成周报」时数据源缺列，先补列再跑', type: 'retrospective' });
    fTask(db, 'x1', '生成周报', { memory_used_ids_run: [M, N] }); // ← 无 `failure_record`（异常失败路的真实形状）
    eq(mem.reinforceMemories('x1', 'p1', false), 2, 'F-b-18 异常失败路：两条都被处理');
    eq([fSnap(db, M).stale, fSnap(db, M).imp, fSnap(db, M).fail], [false, 0.6, 1],
       'F-b-19 ★甲与标题无词面重叠 ⇒ 指认不了 ⇒ 只记计数');
    eq([fSnap(db, N).stale, fSnap(db, N).imp < 0.6, fSnap(db, N).fail], [true, true, 1],
       'F-b-20 ★★乙正文真的含标题实词「生成周报」⇒ 可指认 ⇒ 打 stale 并降权——'
       + '两条共用同一批锚点（标题）与同一次 run，差别只可能来自正文可否指认');
  }

  // ⑥ 成功 + 可指认 ⇒ 清除 staleness、confidence 回升（既有保鲜闭环不被 M6 破坏）
  {
    const { db, mem } = fWorld();
    const P = mem.storeText({ project_id: 'p1', content: '部署前先确认端口 8080 未被占用', type: 'procedural' });
    fTask(db, 'p_fail', '部署任务', { memory_used_ids_run: [P], failure_record: { reason: '端口 8080 被占用' } });
    mem.reinforceMemories('p_fail', 'p1', false);
    const failed = fSnap(db, P); const confFailed = fConf(mem, db, P);
    eq([failed.stale, failed.succ], [true, 0], 'F-b-21 前置：先被打上 `staleness`、成功计数仍 0');
    fTask(db, 'p_ok', '复验任务', { memory_used_ids_run: [P] }, 'completed');
    eq(mem.reinforceMemories('p_ok', 'p1', true), 1, 'F-b-22 成功被处理（返回 1）');
    const okd = fSnap(db, P);
    eq([okd.stale, okd.succ], [false, 1], 'F-b-23 ★staleness **已清除**、`success_count` 0→1（实践重新验证）');
    ok(fConf(mem, db, P) > confFailed, 'F-b-24 ★confidence 回升（> 失败时）',
       `fail=${confFailed.toFixed(3)} success=${fConf(mem, db, P).toFixed(3)}`);
  }
}

// ══════════════════════════════════════════════════════════════════
// 【F-c】模型档阶梯与回落（M6-4：旧实现只会升不会降 ⇒ 一次基础设施故障把项目永久钉在最高档）
// ══════════════════════════════════════════════════════════════════
function groupFc(): void {
  console.log('\n【F-c】模型档阶梯与回落（真跑 `adjustProjectStrategy` × 真项目行）');

  // ① 阶梯本身：升封顶 / 降有下限 / 不认得的档按 `balanced` 算
  eq([...MODEL_TIER_LADDER], ['cost-optimal', 'balanced', 'capability-best'],
     'F-c-1 三档且**有序**（升/降都按这个序；与 `task-archetype.ts` 的 `modelOrder` 同集同序）');
  eq([stepUpTier('cost-optimal'), stepUpTier('balanced'), stepUpTier('capability-best')],
     ['balanced', 'capability-best', 'capability-best'],
     'F-c-2 ★升一档且**封顶**（已在顶则原值返回——不得越出阶梯）');
  eq([stepDownTier('capability-best'), stepDownTier('balanced'), stepDownTier('cost-optimal')],
     ['balanced', 'cost-optimal', 'cost-optimal'],
     'F-c-3 ★★降一档且**有下限**（旧实现的缺口正在此：它根本没有"降"这个动作）');
  eq([stepUpTier('库里手改过的怪值'), stepDownTier('库里手改过的怪值')], ['capability-best', 'cost-optimal'],
     'F-c-4 ★不认得的值按 `balanced` 算（否则一个手改值会被判成"已在底／已在顶"，阶梯静默失效）');
  eq(MODEL_TIER_DOWNGRADE_STREAK, 3, 'F-c-5 连续成功多少次回落一档（门槛常量一处）');

  // ② 真跑：连续成功流 / 失败升档 / 封顶不 push / **streak 自己落库**
  const { db } = fWorld();
  interface FProjCtx {
    learned_strategy?: { modelStrategy: string; temperature: number; maxSteps: number };
    learned_strategy_success_streak?: number;
    strategy_adjustments?: unknown[];
  }
  const ctx = (): FProjCtx => JSON.parse(
    (db.prepare("SELECT context_json FROM wa_projects WHERE id = 'p1'").get() as { context_json: string }).context_json) as FProjCtx;
  const setCtx = (o: Record<string, unknown>) =>
    db.prepare("UPDATE wa_projects SET context_json = ? WHERE id = 'p1'").run(JSON.stringify(o));
  // 步数 9/15、有真实产出证据、**完成分中带（78）** ⇒ **既不在步数 80% 线（12）上，也不在高效线（7.5）下，
  //   更不缺产出证据、也不是低分（<60）** ⇒ `adjustments` 恒空（temperature 两支都不触发、阶梯不压）。
  //   于是"计数有没有落库"这件事被单独隔出来，不会被别的调整遮住。
  //   zx_20261016_3 M32: 完成分入闸后，`completed` + 非低分 ⇒ `step_down_eligible`（仍计入回落），与本组
  //   原先"连续成功 ⇒ 回落"的口径**逐字一致**（78 是为让旧断言原样成立的取值；低分分支由本轮新套件另测）。
  const M = (status: 'completed' | 'failed', over: Record<string, unknown> = {}) => ({
    taskId: 't', projectId: 'p1', archetype: 'a', stepsUsed: 9, maxSteps: 15, toolCalls: 1,
    totalTokens: 0, estimatedCost: 0, hasDeliverable: true, qualityScore: 78, status, modelName: 'm', ...over,
  });

  eq(adjustProjectStrategy(db, 'p1', M('completed')), null,
     'F-c-6 第 1 次成功：本轮**无任何别的可调项** ⇒ 返回 null（于是下面那条"计数自己落库"才有分辨度）');
  eq(ctx().learned_strategy_success_streak, 1,
     'F-c-7 ★★连续计数**自己落库**了——若只在"恰有别的调整"时被顺带写，`adjustments` 恒空的任务永远数不到 3');
  eq(ctx().learned_strategy, undefined, 'F-c-8 且未凭空造出 `learned_strategy`（还没到回落门槛）');
  adjustProjectStrategy(db, 'p1', M('completed'));
  eq(ctx().learned_strategy_success_streak, 2, 'F-c-9 第 2 次成功 ⇒ 计数 1→2');
  const dn = adjustProjectStrategy(db, 'p1', M('completed'));
  eq(dn?.modelStrategy, 'cost-optimal', 'F-c-10 ★★第 3 次成功 ⇒ **回落一档**（默认 `balanced` → `cost-optimal`）');
  eq([ctx().learned_strategy_success_streak, ctx().learned_strategy?.modelStrategy], [0, 'cost-optimal'],
     'F-c-11 回落同时计数归零、新档已落库');
  eq(ctx().strategy_adjustments?.length, 1, 'F-c-12 调整入账（保留最近 10 条的那本账）');

  const up = adjustProjectStrategy(db, 'p1', M('failed'));
  eq(up?.modelStrategy, 'balanced', 'F-c-13 ★失败升一档（`cost-optimal` → `balanced`）');
  eq(ctx().learned_strategy_success_streak, 0, 'F-c-14 失败把"连续成功"打断（计数归 0）');

  // 封顶：已是最顶档再失败 ⇒ 无可升 ⇒ **不 push**（不制造一条 `capability-best→capability-best` 的假调整）
  setCtx({ learned_strategy: { modelStrategy: 'capability-best', temperature: 0.5, maxSteps: 20 }, learned_strategy_success_streak: 0 });
  eq(adjustProjectStrategy(db, 'p1', M('failed')), null,
     'F-c-15 ★★已封顶再失败 ⇒ 无可升 ⇒ 返回 null（"若无变化仍入账"是另一条假账）');
  eq(ctx().learned_strategy?.modelStrategy, 'capability-best', 'F-c-16 档位原样保留');

  // ★★streak 是**跨任务**状态：恰在"没有别的调整可入账"的那一轮，也必须归零并落库
  setCtx({ learned_strategy: { modelStrategy: 'cost-optimal', temperature: 0.5, maxSteps: 20 }, learned_strategy_success_streak: 2 });
  eq(adjustProjectStrategy(db, 'p1', M('completed')), null,
     'F-c-17 ★★已在**最低档**上连成 3 次：`stepDown` 原值返回 ⇒ 无可入账 ⇒ 返回 null（与 F-c-15 同一形状）');
  eq(ctx().learned_strategy_success_streak, 0,
     'F-c-18 ★★★但仍必须把计数**归零并落库**——否则下一个任务又从 3 起数，每轮都重判一次"该回落了"');
  eq(ctx().learned_strategy?.modelStrategy, 'cost-optimal', 'F-c-19 档位不动（已在底，无可再降）');

  // 与既有调项**并存**：阶梯是新加的一道，不是把原有关卡顶掉
  setCtx({});
  const tp = adjustProjectStrategy(db, 'p1', M('completed', { hasDeliverable: false }));
  ok(!!tp && tp.temperature < 0.7,
     'F-c-20 ★既有"完成但无真实产出证据 ⇒ 降 temperature"仍生效（阶梯是新增，不是替换）',
     tp ? `temperature ${tp.temperature.toFixed(2)}` : 'null');
  eq(ctx().learned_strategy_success_streak, 1, 'F-c-21 ★同一轮里"别的调整入账"与"计数落库"并存，各写各的');
}

// ══════════════════════════════════════════════════════════════════
// 【F-d】静态接线（G-5：读**原文**，锚点钉符号/语句形状）
// ══════════════════════════════════════════════════════════════════
function groupFd(): void {
  console.log('\n【F-d】静态接线：per-run 键真在写 / null 与 [] 分得开 / 归因闸在 / 阶梯两向都在');
  const execSrc = RD(`${A}/src/main/core/agent-executor.ts`);
  const mmSrc = RD(`${A}/src/main/core/memory-manager.ts`);
  const feSrc = RD(`${A}/src/main/core/feedback-engine.ts`);
  const decaySrc = RD(`${A}/src/main/core/memory-decay.ts`);
  ok(execSrc.length > 100_000 && mmSrc.length > 100_000 && feSrc.length > 5_000 && decaySrc.length > 3_000,
     'F-d-1 扫描面自证：四处原文非空',
     `exec=${execSrc.length} mm=${mmSrc.length} fe=${feSrc.length} decay=${decaySrc.length}`);

  // ① 生产**真的在写** per-run 键，且**不被** union 那道的 `length > 0` 守卫圈住
  ok(/rctx\.memory_used_ids_run = \[\.\.\.new Set\(built\.accessedIds\)\];/.test(execSrc),
     'F-d-2 ★生产写入"本 run 的真入文集合"（`agent-executor` 一处）');
  const iRel = execSrc.search(/if \(built\.accessedIds\.length > 0\) \{\s*\n\s*try \{\s*\n\s*const tctx = /);
  const openIdx = iRel < 0 ? -1 : execSrc.indexOf('{', iRel);
  let iClose = -1;
  if (openIdx >= 0) {
    let depth = 0;
    for (let i = openIdx; i < execSrc.length; i++) {
      if (execSrc[i] === '{') depth++;
      else if (execSrc[i] === '}') { depth--; if (depth === 0) { iClose = i; break; } }
    }
  }
  const iUnionWrite = execSrc.indexOf('JSON.stringify(tctx), taskId');
  const iPerRun = execSrc.indexOf('rctx.memory_used_ids_run');
  ok(iRel > 0 && iClose > openIdx,
     'F-d-3 扫描面自证：union 那道守卫的**块界**配对花括号求出来了',
     `if@${iRel} 块闭@${iClose}`);
  ok(iUnionWrite > 0 && iUnionWrite < iClose,
     'F-d-4 ★扫描器有牙：union 那句确在**该块之内**（否则下面"per-run 不在块内"只是块被框错了）');
  ok(iPerRun > iClose,
     'F-d-5 ★★per-run 写入在 union 块的**块界之外**——本次一条没用上时必须写成 `[]`；'
     + '若被那道 `length > 0` 圈住，"空集"永远写不进去 ⇒ 与"缺键"无从分辨，M6-2 的靶心就废了');
  ok(/const rctx = JSON\.parse\(\(db\.prepare\('SELECT context_json FROM wa_tasks WHERE id = \?'\)\.get\(taskId\) as \{ context_json: string \}\)\?\.context_json \|\| '\{\}'\);/.test(execSrc),
     'F-d-6 ★per-run 写入**重新读一次**再改（不复用 `tctx`）——否则会把刚写好的 union 一并覆盖掉');

  // ② `null`（不知道）与 `[]`（知道没用）在类型与实现上都分得开
  ok(/private _readRunMemoryIds\(taskId: string\): string\[\] \| null \{/.test(mmSrc),
     'F-d-7 ★返回类型显式含 `| null`（"不知道"是合法返回值，不是错误）');
  ok(/return Array\.isArray\(ids\) \? ids\.filter\(\(x\): x is string => typeof x === 'string'\) : null;/.test(mmSrc),
     'F-d-8 ★缺键 ⇒ `null`（而非 `[]`——`[]` 会让调用方以为"本次一条没用上"）');
  ok(/const usedIds = perRun \?\? this\._readInjectedMemoryIds\(taskId\);/.test(mmSrc),
     'F-d-9 ★用 `??` 而非 `||`（空数组是**真值**；`||` 会让"空集"退回 union ⇒ 连坐病根原样复活）');

  // ③ 两个读取点共用**同一** precedence（"基础强化算在谁头上"两处必须同尺）
  eq((mmSrc.match(/perRun \?\? this\._readInjectedMemoryIds\(taskId\)/g) ?? []).length, 2,
     'F-d-10 ★★`reinforceMemories` 与 `assessMemoryApplication` **同取一份证据**（各取一套 ⇒ `_recordApplication` 的抵消算错）');
  eq((mmSrc.match(/this\._recordApplication\(mem\.id, (?:true|false), success, reinforceDelta, perRun !== null\)/g) ?? []).length, 2,
     'F-d-11 ★两个调用点都把 `perRun !== null`（＝`baseReinforced`）传下去');

  // ④ 归因闸与"只记计数"支的形状
  ok(/const anchors = success \? \[\] : this\._readFailureAnchors\(taskId\);/.test(mmSrc),
     'F-d-12 成功侧不取锚点（锚点只服务于失败侧的降权判据）');
  ok(/if \(perRun === null\) \{\s*\n\s*this\._bumpCount\(id, success \? 'success_count' : 'failure_count'\);/.test(mmSrc),
     'F-d-13 ★老任务分支**先于**归因判据被处理（无凭据时根本走不到归因那一步）');
  ok(/if \(anchors\.length > 0 && this\._isMemoryAttributable\(id, anchors\)\) \{/.test(mmSrc),
     'F-d-14 ★★失败侧降权被**两道闸**同时把守：有锚点 **且** 可指认（缺任一条只记计数）');

  // ⑤ `_bumpCount` 只许动计数列（不能顺手降权／打 stale）
  const bumpBody = (mmSrc.match(/private _bumpCount\(memId: string, col: 'success_count' \| 'failure_count'\): void \{[\s\S]*?\n  \}/) ?? [''])[0];
  ok(bumpBody.length > 60, 'F-d-15 扫描面自证：`_bumpCount` 函数体取到', `${bumpBody.length} 字节`);
  eq(['importance', 'staleness', 'last_reinforced_at', 'updated_at'].filter((k) => bumpBody.includes(k)), [],
     'F-d-16 ★★"只记计数"名副其实：体内**不出现** importance / staleness / last_reinforced_at / updated_at');
  const applyBody = (mmSrc.match(/private _applyReinforcement\([\s\S]*?\n  \}/) ?? [''])[0];
  ok(['importance', 'staleness', 'last_reinforced_at'].every((k) => applyBody.includes(k)),
     'F-d-17 ★扫描器有牙：同一份词表在 `_applyReinforcement` 体内**全部命中**（否则 F-d-16 可能只是"词表写错了"）');

  // ⑥ 归因真源**只有一处**：锚点切法与可指认判定都由 `memory-write.ts` 提供
  ok(/return failureAnchors\(ctx\.failure_record \?\? null, row\.title \|\| ''\);/.test(mmSrc)
    && /return isAttributable\(row\.content \|\| '', anchors, evidencePath\);/.test(mmSrc),
    'F-d-18 ★管理器只**消费** `failureAnchors` / `isAttributable`（不自带第二套切词/匹配）');
  ok(/import \{ buildTaskReviewPrompt, failureAnchors, isAttributable \} from '\.\/memory-write\.js';/.test(mmSrc),
    'F-d-19 两者从 `memory-write.ts` 引（与判据 import 的是**同一处**——判据若调另一份就是自我印证）');
  eq([/function failureAnchors\(/.test(mmSrc), /function isAttributable\(/.test(mmSrc)], [false, false],
     'F-d-20 ★反证：管理器里**没有**这两者的第二份实现');

  // ⑦ 年龄真源零依赖（同 `memory-constants.ts` 一把尺）
  eq((decaySrc.match(/^\s*import\s/m) ?? []).length, 0,
     'F-d-21 ★★`memory-decay.ts` **零 import**——main / rr 双侧都能直引，判据不必自造等价物；'
     + '一旦它开始引别的模块，这条会先响');

  // ⑧ 模型档：两个开口都在场，且 streak 落在**兄弟键**
  ok(/const up = stepUpTier\(updated\.modelStrategy\);/.test(feSrc)
    && /const down = stepDownTier\(updated\.modelStrategy\);/.test(feSrc),
    'F-d-22 ★`adjustProjectStrategy` 里**升与降两个动作都在场**（旧实现只有升 ⇒ 永久钉在最高档）');
  ok(/if \(streak >= MODEL_TIER_DOWNGRADE_STREAK\) \{[\s\S]{0,400}?\n\s*streak = 0;/.test(feSrc),
     'F-d-23 ★★`streak = 0;` 在**内层 if 之外**——已封顶／已触底（无可入账）时也必须归零，否则下一任务又从 3 起数');
  ok(/ctx\.learned_strategy_success_streak = streak;/.test(feSrc),
     'F-d-24 ★连续计数写进**兄弟键**');
  eq([/updated\.learned_strategy_success_streak/.test(feSrc), /ctx\.learned_strategy = updated;/.test(feSrc)], [false, true],
     'F-d-25 ★★反证：计数**不塞进** `learned_strategy`（那对象有既有读点，塞新键会改它的形状）——'
     + '故写的是与 `ctx.learned_strategy = updated` **并列**的另一个键');
  ok(/if \(streak !== prevStreak\) db\.prepare\('UPDATE wa_projects SET context_json = \? WHERE id = \?'\)\.run\(JSON\.stringify\(ctx\), projectId\);/.test(feSrc),
     'F-d-26 ★★无别的调整可入账时，**仅当计数变化才写库**（既不漏记跨任务状态，也不无谓写库）');
}

// ══════════════════════════════════════════════════════════════════
// 【G-a】M7 行为面：分层取用 / 工作记忆池与焦点 / 图式重构召回
//    生产纯函数**直引**（G-1 不自造等价物），外加两处真装配端到端（真 `buildMemoryContext`、
//    真 `MemoryManager` × 内存库）——纯函数断言证明算式对，端到端断言证明**接上了**。
// ══════════════════════════════════════════════════════════════════
const GA_HOUR = 3600_000;
/** 注入的**固定** now（判据不依赖真实墙钟：真实时刻只进 `Date.now()`，一律以参数传入这里的常量）。 */
const GA_NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const gaIso = (ms: number): string => new Date(ms).toISOString();
/** 一条长期记忆的最小真实形状（`MemoryEntry` 的必填列 + 本组用到的列）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const memRow = (id: string, content: string, over: Record<string, unknown> = {}): any => ({
  id, project_id: 'p1', content, embedding: null, memory_type: 'episodic', importance: 0.5,
  created_at: null, use_count: 0, last_used_at: null, ...over,
});
/** 按生产口径拼图式（`memory-context.ts` 那三样 + 分隔符），供"第四实参"的端到端比照。 */
const gaIsoSchema = (pc: string | undefined, goal: { goal: string; success_criteria: string; investigate: string[] } | null | undefined): string =>
  [pc ?? '', goal?.goal ?? '', goal?.success_criteria ?? '', ...(goal?.investigate ?? [])]
    .filter((s) => s.trim().length > 0).join('。');

function groupGa(): void {
  console.log('\n【G-a】M7 行为面（生产纯函数直引 + 真装配端到端）');

  // ── M7-d 分层检索：两层各用**不同的尺**，再轮转交织取 topK（Tulving 情景/语义二分） ──
  const eOld = memRow('e-old', '三个月前的复盘', { memory_type: 'episodic', created_at: gaIso(GA_NOW - 90 * 24 * GA_HOUR), last_used_at: gaIso(GA_NOW) });
  const eNew = memRow('e-new', '昨天的复盘', { memory_type: 'episodic', created_at: gaIso(GA_NOW - 1 * 24 * GA_HOUR), last_used_at: null });
  const { episodic } = splitTaskLayers([eOld, eNew], () => 0, GA_NOW);
  eq(episodic.map((c) => c.mem.id), ['e-new', 'e-old'],
    'G-a-1 ★情景层按 `created_at` 的**近因**排：`last_used_at` 是"我们何时又用了它"，'
    + '混进来会把"很旧但刚被检索过"的排到"昨天刚发生"的前面（上例那条老记忆的 `last_used_at` 恰是此刻）');
  eq(episodic.map((c) => c.rank), [0, 1], 'G-a-2 层内名次如实给出（供上游交代"按什么排的"）');

  const sHi = memRow('s-hi', '通用做法', { memory_type: 'semantic', importance: 0.9 });
  const sUsed = memRow('s-used', '最近真被用过', { memory_type: 'semantic', importance: 0.4 });
  const { semantic } = splitTaskLayers([sHi, sUsed], (m) => (m.id === 's-used' ? 1 : 0), GA_NOW);
  eq(semantic.map((c) => c.mem.id), ['s-used', 's-hi'],
    'G-a-3 语义层按 `0.4·重要度 + 0.6·提取强度`：`s-used`(0.16+0.6=0.76) 压过 `s-hi`(0.36)'
    + ' ⇒「重要度不一定最高、但近期真被用过」也算数（与 `getProjectKnowledge` 同一把尺）');
  ok(Math.abs(semantic[0]!.sortKey - 0.76) < 1e-9,
    'G-a-4 该层的排序键是**两因子加权**（0.4/0.6），不是抄来的重要度单因子', String(semantic[0]!.sortKey));

  const merged3 = mergeTaskLayers(episodic, semantic, 3);
  eq(merged3.map((m) => m.id), ['e-new', 's-used', 'e-old'],
    'G-a-5 ★轮转交织且**第一顺位给情景层**——它正是此前被语义高分整体挤掉的那一层（修法不得沿原方向再偏一次）');
  eq(mergeTaskLayers(episodic, semantic, 1).map((m) => m.id), ['e-new'], 'G-a-6 topK=1 时留的仍是情景层那条（同上，另一半）');
  const dup = memRow('e-new', '同一 id 两层都出现', { created_at: gaIso(GA_NOW) });
  const deduped = mergeTaskLayers(
    [{ mem: dup, layer: 'episodic', sortKey: 1, rank: 0 }],
    [{ mem: dup, layer: 'semantic', sortKey: 1, rank: 0 }],
    5,
  );
  eq([deduped.length, deduped.map((m) => m.id)], [1, ['e-new']], 'G-a-7 按 id 去重（池子若由外部拼来，同一条可能两处都出现）');
  eq(mergeTaskLayers(episodic, semantic, 0).length, 0, 'G-a-8 topK=0 ⇒ 一条不取（输出长度恒 ≤ topK，不越界）');

  // ── M7-e 工作记忆：存储是**池**、注入是**焦点**（7±2），择要按值（米勒/巴德利） ──
  ok(WM_WINDOW_CAP === 7 && WM_POOL_CAP === 12 && WM_POOL_CAP > WM_WINDOW_CAP,
    'G-a-9 ★池与焦点是**两个量**：旧实现把"焦点 7 格"读成"只准记 7 条"（FIFO 丢最旧）'
    + ' ⇒ 第 8 条一落笔，第 1 条即从沉淀门外消失',
    `焦点 ${WM_WINDOW_CAP} / 池 ${WM_POOL_CAP}`);

  const TASK_TXT = '部署方案失败复盘';
  const vOpts = (nowMs: number) => ({ taskText: TASK_TXT, keywordsOf: extractKeywords, nowMs });
  const V = (items: Array<{ content: string; ts: string; n?: number }>, nowMs = GA_NOW) =>
    rankWorkingMemory(items, vOpts(nowMs));
  const full = V([{ content: '部署方案失败复盘', ts: gaIso(GA_NOW), n: 3 }])[0]!;
  ok(Math.abs(full.value - 1) < 1e-9 && full.strength === 1 && full.relevance === 1 && Math.abs(full.recency - 1) < 1e-9,
    'G-a-10 价值 = 强度 × 相关度 × 新近度，三个因子**各自可指认**（满值标本：复述 3 次 / 通篇是当下需求 / 刚记下）',
    JSON.stringify({ strength: full.strength, relevance: full.relevance, recency: full.recency }));
  const nought = V([{ content: '花园浇水施肥', ts: gaIso(GA_NOW), n: 1 }])[0]!;
  eq([nought.value, nought.relevanceJudged], [0, true],
    'G-a-11 另一侧：与当下需求零共同词 ⇒ 相关度 0 ⇒ 价值 0（不设"保底给个小数"，那会把零伪装成一点）');
  const unjudged = V([{ content: 'a', ts: gaIso(GA_NOW), n: 1 }])[0]!;
  eq([unjudged.relevanceJudged, unjudged.relevance], [false, 1],
    'G-a-12 ★「只在真知道时标」：提不出关键词的笔记 ⇒ `relevanceJudged=false` 且相关度为**中性 1**'
    + '（把"不知道"混进"零分"正是这条要禁的；也刻意不引入凭空的保底系数）');
  eq(V([{ content: '部署方案失败复盘', ts: gaIso(GA_NOW), n: 9 }])[0]!.strength, 1,
    'G-a-13 复述强度在饱和点（3 次）处封顶——记 9 次不多算');
  eq(V([{ content: '部署方案失败复盘', ts: gaIso(GA_NOW), n: 1 }])[0]!.strength, 1 / WM_REHEARSAL_SATURATION,
    'G-a-14 记一次 ⇒ 1/3（**下界不为 0**：只记过一次的笔记若值恒 0，就永远进不了焦点）');
  ok(Math.abs(V([{ content: '部署方案失败复盘', ts: gaIso(GA_NOW - 6 * GA_HOUR), n: 3 }])[0]!.recency - Math.exp(-1)) < 1e-9,
    'G-a-15 新近度 = exp(−小时/6)：恰 6h 前 ⇒ e⁻¹（τ 取小时而非天——池里的条目属**当前任务情境**，'
    + '其可及性按小时变；用天作尺等于把整场任务当一瞬）');

  const stale = V([{ content: '部署方案失败复盘', ts: gaIso(GA_NOW - 72 * GA_HOUR), n: 3 }])[0]!;
  ok(stale.value > 0 && stale.value < 1e-5,
    'G-a-16 前置自证：这条标本**又老又相关**（3 天前），按值仍是正数但很小（exp(−12)≈6.1e-6）', String(stale.value));
  const pick = selectWorkingMemory(
    [{ content: '花园浇水施肥', ts: gaIso(GA_NOW), n: 1 }, { content: '数据库索引优化', ts: gaIso(GA_NOW), n: 1 }, { content: '部署方案失败复盘', ts: gaIso(GA_NOW - 72 * GA_HOUR), n: 3 }],
    1, vOpts(GA_NOW),
  );
  eq([pick.kept.map((v) => v.item.content), pick.dropped.length], [['部署方案失败复盘'], 2],
    'G-a-17 ★★择要与 FIFO **分得开**：被留下的那条 `ts` **最旧**（FIFO 按"丢最旧"会第一个丢它），'
    + '但它通篇是当下需求、复述过 3 次 ⇒ 按值居首。旧实现正是 FIFO ⇒ 这条修法不是换个写法，是换了尺');
  eq(selectWorkingMemory([{ content: '部署方案失败复盘', ts: gaIso(GA_NOW), n: 3 }], 0, vOpts(GA_NOW)).kept.length, 0,
    'G-a-18 cap=0 ⇒ 一条不取、全部算 dropped（段要不要注入由调用方定，本函数自作主张才是越界）');

  // ── M7-e 端到端：真 `buildMemoryContext` 装配一段真「工作记忆」（最小桩，只给本段够得到的三样） ──
  const realTs = new Date().toISOString();
  const wmPool: Array<{ content: string; ts: string; n: number }> = [];
  for (let i = 1; i <= 11; i++) wmPool.push({ content: `花园浇水施肥${i}`, ts: realTs, n: 1 });
  // ★标本：把"该进焦点的那条"埋在**第 10 位**（0 基下标 9）——旧口径按写入序铺开只取前 7 ⇒ 它进不了焦点。
  wmPool.splice(9, 0, { content: '部署方案失败复盘', ts: realTs, n: 3 });
  eq(wmPool.length, 12, 'G-a-19 池里 12 条（含焦点候选）');
  ok(wmPool.slice(0, 7).every((x) => x.content !== '部署方案失败复盘'),
    'G-a-20 ★前置自证：按**写入序**取前 7 条，那条根本不在其中（否则下面的"它在场"只是位置巧合）');
  const relArgs: unknown[][] = [];
  const accessedCalls: string[][] = [];
  const injectedCalls: string[][] = [];
  const stubMem = new Proxy({} as Record<string, unknown>, {
    get: (_t, k) => {
      if (k === 'getTaskArchetype') return () => null;
      if (k === 'getTaskText') return () => TASK_TXT;
      if (k === 'getWorkingMemory') return () => wmPool;
      // zx_20261018_3 批一「注入与使用分账」：注入侧只记 `recordInjection`；`recordAccess` 现仅由
      //   `memory_search`（真·取用）调用 —— 两笔账刻意分开，下面两条断言各钉一头。
      if (k === 'recordAccess') return (ids: string[]) => { accessedCalls.push(ids); };
      if (k === 'recordInjection') return (ids: string[]) => { injectedCalls.push(ids); };
      if (k === 'retrieveTaskRelevant') return (...a: unknown[]) => { relArgs.push(a); return []; };
      // zx_20261018_3 批一：生产装配侧优先走 WithSource（它把「语义/线索」来源一并带回）；旧桩只有
      //   `retrieveTaskRelevant` 会让防御式探方法的 `typeof === 'function'` 撞上兜底抛错桩 ⇒ 检索整段被
      //   `try/catch` 吞掉。桩必须与生产同形，否则测的是"异常路径"而不是"接线"。
      if (k === 'retrieveTaskRelevantWithSource') {
        return (...a: unknown[]) => { relArgs.push(a); return { memories: [], source: 'embedding' as const }; };
      }
      // 其余一律抛：由 `buildMemoryContext` 自己的 try/catch 逐段兜住（缺哪段就少哪段，正是生产异常路径的同一套兜底）
      return () => { throw new Error(`未桩化: ${String(k)}`); };
    },
  }) as unknown as MemoryManager;
  const out = buildMemoryContext(stubMem, 'p1', 't-wm', '把部署脚本改成幂等', null, undefined, 60_000);
  const wmBlock = out.context.slice(out.context.indexOf('## 工作记忆（当前任务情境）'));
  ok(wmBlock.length > 0 && wmBlock.startsWith('## 工作记忆（当前任务情境）'), 'G-a-21 工作记忆段真入了文（不然下面全是在空串上做文章）');
  const wmNums = wmBlock.match(/^\d+\. .+$/gm) ?? [];
  eq(wmNums.length, WM_WINDOW_CAP, 'G-a-22 ★焦点恰 7 条（米勒 7±2）——而**池里有 12 条**，注入与存储不是同一个上限');
  ok(wmNums.some((l) => l === '1. 部署方案失败复盘'),
    'G-a-23 ★★价值最高者进了焦点且排第 1 位（治的正是"按写入序铺开、价值与位置无关"）');
  ok(!wmNums.some((l) => l.includes('花园浇水施肥7')),
    'G-a-24 被略去的那条**不在焦点列表里**（注记里点名 ≠ 注入，两件事分开判）');
  ok(wmBlock.includes('略去 5 条'), 'G-a-25 略去 5 条如实入账（12 池 − 7 焦点，一条不漏账）');
  ok(/略去 5 条：花园浇水施肥7、花园浇水施肥8、花园浇水施肥9…/.test(wmBlock),
    'G-a-26 并**点名**略去了哪几条（前 3 条），多者以 `…` 收尾——不谎报"只有 3 条"（即"为什么选了这几条、丢了哪几条"落到了纸上）');
  eq(Object.keys(out.meta).sort(), ['chars', 'kept', 'omitted', 'sections'],
    'G-a-27 注记写在**段文本里**，`meta` 的四键形状一字未动（它被既有判据按字面核）');
  eq(out.meta.omitted, 0, 'G-a-28 预算宽裕 ⇒ 零段被省略（本组要看的是段**内**的择要，不是段级取舍）');
  // zx_20261018_3 批一：注入与使用分账——注入记 `recordInjection`（工作记忆段不带 ids ⇒ **空集**），
  //   `recordAccess` 不再被装配侧调用（它是 `memory_search` 真取用的账，混进来就把"见过"记成"用过"）。
  eq([injectedCalls.length, accessedCalls.length], [1, 0],
    'G-a-29 ★注入与使用分账：装配侧真调 `recordInjection`（恰一次、**空集**——工作记忆段不带 ids）'
    + '，且**不调** `recordAccess`（后者是 `memory_search` 真取用的账）');
  const outSchema = buildMemoryContext(stubMem, 'p1', 't-wm', '把部署脚本改成幂等', null, undefined, 60_000);
  ok(outSchema.context === out.context, 'G-a-30 同一入参两次装配逐字相同（无隐式随机/时钟依赖渗进来）');
  eq(relArgs[0], ['t-wm', 'p1', 5, '把部署脚本改成幂等'],
    'G-a-31 ★图式由**调用方**拼出并作为第四实参传入：它取「主要矛盾 + 立志三问」，'
    + '**不是**题面——题面正是 `retrieveTaskRelevant` 自己上游的取数源，拿它当图式＝同一把逐字尺再量一遍（自我印证）');
  eq(relArgs[0]?.[3], gaIsoSchema('把部署脚本改成幂等', null),
    'G-a-32 拼接口径＝「主要矛盾」这一支（三样缺哪样少拼哪样，空串一律滤掉、不留空的分隔符）');
  const g1 = { goal: '让部署可重复', success_criteria: '连续两次结果一致', investigate: ['脚本是否幂等', '回滚路径'] };
  const outGoal = buildMemoryContext(stubMem, 'p1', 't-wm', '把部署脚本改成幂等', g1, undefined, 60_000);
  eq(relArgs[2]?.[3], gaIsoSchema('把部署脚本改成幂等', g1),
    'G-a-33 ★立志三问真进图式（目标 / 成功标准 / 要调查的项，顺序与分隔符一并钉住）', String(relArgs[2]?.[3]));
  ok(outGoal.context.includes('## 任务立志'), 'G-a-34 前置：立志非空 ⇒ 该段本身也在场（上条的入参不是被静默丢掉的）');
  const g2 = buildMemoryContext(stubMem, 'p1', 't-wm', undefined, null, undefined, 60_000);
  eq(relArgs[3]?.[3], '',
    'G-a-35 ★两样都缺 ⇒ 传空串（**旧口径**：管理器侧判不出图式即原序返回）——"既有调用点行为一字不变"由这一支成立');
  eq([g2.context.length > 0, relArgs.length], [true, 4],
    'G-a-36 装配照常出文（图式缺失不是错误路径）；且四次装配各调一次检索（无重入、无漏调）');

  // ── M7-f 端到端：真 `retrieveTaskRelevant` × 真库（开关开 / 关 / 空图式 / 判不出，四态同池） ──
  const dbG = new DatabaseSync(':memory:') as unknown as AnyDb;
  dbG.exec(E_SCHEMA);
  const memG = new MemoryManager(dbG, null as never);
  dbG.prepare("INSERT INTO wa_projects (id, name) VALUES ('p1', '夹具项目')").run();
  const insMem = (id: string, content: string, ageDays: number, embedding: string | null = '[1,0]'): void => {
    dbG.prepare('INSERT INTO wa_memories (id, project_id, content, embedding, memory_type, importance, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, 'p1', content, embedding, 'semantic', 0.5, gaIso(GA_NOW - ageDays * 24 * GA_HOUR));
  };
  // 5 条填充：占掉 `getRecent(5)` 的排除位（故不进长期层池），且无 embedding ⇒ 也不进语义检索池。
  for (let i = 0; i < 5; i++) insMem(`f${i}`, `填充${i}`, 0, null);
  insMem('m1', '花园浇水施肥', 1);
  insMem('m2', '数据库索引优化', 2);
  insMem('m3', '部署失败复盘与回滚脚本要先备份', 3);
  dbG.prepare('INSERT INTO wa_tasks (id, project_id, title, description, context_json) VALUES (?,?,?,?,?)')
    .run('t-schema', 'p1', '修部署', '', JSON.stringify({ task_embedding: [1, 0] }));
  const SCHEMA_TXT = '部署失败复盘与回滚';
  const orderOf = (schema: string): string[] => memG.retrieveTaskRelevant('t-schema', 'p1', 5, schema).map((m) => String(m.id));
  eq(orderOf(''), ['m1', 'm2', 'm3'],
    'G-a-37 前置：不传图式 ⇒ 旧口径（三条语义层同键并列，稳定序＝`created_at DESC`）——这正是新老两态的共同基线');
  eq(orderOf(SCHEMA_TXT), ['m3', 'm1', 'm2'],
    'G-a-38 ★★传图式 ⇒ 按**当下需求**重建条序：`m3` 整条都是需求点到的（亲和度 0.5），提到首位；'
    + '另两条零共同词（0）并列，保持上一跳的序 ⇒「重建」不是"两段拼"也不是"全按新分重排"');
  dbG.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)').run('memory.schema_recall', 'false');
  eq(orderOf(SCHEMA_TXT), ['m1', 'm2', 'm3'],
    'G-a-39 ★开关关 ⇒ **逐位回旧口径**（同一池、同一图式，差别只可能来自开关 ⇒ A/B 成立）');
  dbG.prepare("UPDATE wa_settings SET value = 'true' WHERE key = 'memory.schema_recall'").run();
  eq([...orderOf(SCHEMA_TXT)].sort(), [...orderOf('')].sort(),
    'G-a-40 ★★成员集**一字不动**（只重排）——本处不新增任何"东西去哪了"的黑洞：'
    + '本轮刚撤掉装配层那道静默丢段（M7-a），不得在检索层再添一个');
  eq(orderOf('a'), ['m1', 'm2', 'm3'],
    'G-a-41 图式提不出关键词 ⇒ **整趟不动**（原序返回，不是"逐条判、判不出给零分"——那是把不知道混进了零分）');

  // 同一条判据在纯函数层的两侧标本（上条的"不动"必须是**因为**那条判不出，不是这些候选本就同序）
  const cand = [memRow('c1', '花园浇水施肥'), memRow('c2', 'a'), memRow('c3', '部署失败复盘与回滚')];
  ok(applySchemaRecall(cand, SCHEMA_TXT, { keywordsOf: extractKeywords }) === cand,
    'G-a-42 ★池里**任一条**提不出关键词 ⇒ 整趟不动（返回**同一个数组引用**，可证不是"排了但恰好没动"）');
  eq(applySchemaRecall(cand.filter((m) => m.id !== 'c2'), SCHEMA_TXT, { keywordsOf: extractKeywords }).map((m) => m.id), ['c3', 'c1'],
    'G-a-43 ★正控：**同一批**去掉那条判不出的 ⇒ 确实会重排（故上条的"不动"归因成立，不是候选本就同序）');
  eq(applySchemaRecall([memRow('c1', '花园浇水施肥')], SCHEMA_TXT, { keywordsOf: extractKeywords }).map((m) => m.id), ['c1'],
    'G-a-44 单条 ⇒ 直接返回（没有"序"可重建，不做无谓的算式）');
}

// ══════════════════════════════════════════════════════════════════
// 【G-b】M7 静态接线（一律读**原文**，锚点钉符号/语句形状——不 stripComments，见本轮教训）
// ══════════════════════════════════════════════════════════════════
function groupGb(): void {
  console.log('\n【G-b】M7 静态接线（读原文：锚点钉符号 / 语句形状 / 键名三处同源）');
  const ctxSrc = RD(`${A}/src/main/core/memory-context.ts`);
  const ctxExec = RD(`${A}/src/main/core/exec-context.ts`);
  const execSrc = RD(`${A}/src/main/core/agent-executor.ts`);
  const mgrSrc = RD(`${A}/src/main/core/memory-manager.ts`);
  // zx_20261018_2 批七「见简」：检索读路径与范例簇已机械搬出管理器——扫描面按符号重定向到新载体
  //   （只搬不改义：判据内容不放宽，接收者由 `this.` 改为宿主形参 `mgr.`）。
  const retSrc = RD(`${A}/src/main/core/memory-retrieval.ts`);
  const consSrc = RD(`${A}/src/main/core/memory-consolidation.ts`);
  const boolSrc = RD(`${A}/src/main/core/settings-bool.ts`);
  const dbSrc = RD(`${A}/src/main/database.ts`);
  ok([ctxSrc, ctxExec, execSrc, mgrSrc, boolSrc, dbSrc].every((s) => s.length > 5000),
    'G-b-1 扫描面自证：六份原文皆非空（否则下面的"没找到"是空转假绿）',
    [ctxSrc, ctxExec, execSrc, mgrSrc, boolSrc, dbSrc].map((s) => s.length).join('/'));

  // M7-a 预算双闸合一：装配层那道**按位**闸撤了，只留真源侧的**按段**尺 + 一条审计告警
  eq(ctxExec.includes("truncateCtx(memoryContext, CTX_MEMORY_MAX_CHARS, '记忆上下文');"), false,
    'G-b-2 ★★`exec-context.ts` 里**再无**按位掐记忆块的语句（两道闸并存 = 后一道按位覆盖前一道的按值结果）'
    + '——锚点带分号：旧调用在该文件的**注释里**作为被撤掉的第二道闸仍被引用，故判据钉的是**语句形状**而非子串在场'
    + '（`truncateCtx` 本身仍在册，它还在给**项目上下文**掐尾，那是另一条与记忆无关的预算）');
  // zx_20261018_2 批三：装配层改为「按块登记 + 单一物化循环」，推入语句不再逐块手写。
  //   判据按符号重定向到**块登记形状**（且扫描面取 `if (memoryContext)` 那一段），
  //   「原样推入」由"登记的就是 memoryContext 本体、段内无任何掐尾"两件事共同钉住。
  const memBlock = (() => {
    const i = ctxExec.indexOf('if (memoryContext) {');
    return i >= 0 ? ctxExec.slice(i, ctxExec.indexOf('\n  }', i) + 4) : '';
  })();
  const memBlockCodeEarly = stripKeepingLines(memBlock).join('\n');
  ok(memBlockCodeEarly.length > 100
    && memBlockCodeEarly.includes('memoryContext.length > CTX_MEMORY_MAX_CHARS')
    && memBlockCodeEarly.includes('logger.warn')
    && memBlockCodeEarly.includes("add('memory', memoryContext)"),
    'G-b-3 改为**审计**：越界只告警、随后**原样推入**（补刀会把"如实越界"改写成"静默截断"，更坏）'
    + '——批三后推入经 `add(\'memory\', …)` 进单一物化循环，故锚点取段内三件事：越界判定、告警、登记本体',
    `${memBlock.length} 字节`);
  // 负控读**去注释**后的代码：段内注释仍以「被撤掉的第二道闸」引用旧调用，
  // 那是说明本身；"是否真掐一刀"读码（见 feedback_static_sweep_comment_strip）。
  const memBlockCode = memBlockCodeEarly;
  eq(memBlockCode.length > 50, true,
    'G-b-3b-a 扫描面自证：去注释后的段体非空（否则下面的"没有掐尾"是空转假绿）', `${memBlockCode.length} 字节`);
  eq(/truncateCtx\(memoryContext|memoryContext\.slice\(/.test(memBlockCode), false,
    'G-b-3b 负控：该段内**没有**任何对 `memoryContext` 的掐尾/切片（"原样推入"不是口头承诺）');
  eq((execSrc.match(/export const CTX_MEMORY_MAX_CHARS = 6000/g) ?? []).length, 1,
    'G-b-4 预算上限仍是**一处真源**（`export const` 恰一处；装配层 import 它，不自抄数值）');
  const ctxBody = ctxSrc.slice(ctxSrc.indexOf('export function buildMemoryContext('));
  ok(ctxBody.length > 500, 'G-b-5a 扫描面自证：真源函数体切片非空（否则下面的"没有裸 6000"是空转假绿）', `${ctxBody.length} 字节`);
  eq(/\b6000\b/.test(ctxBody), false,
    'G-b-5 ★函数体内**不出现裸 6000**（预算只该由执行体 import 传参进来；写在这儿就是第二处预算真源）'
    + '——扫描面取**函数体**：该文件注释里仍有"6000"二字，那是"不得再写一个 6000"这句说明本身'
    + '（与既有 b7 判据同一把尺：它的扫描面同样从 `export function buildMemoryContext(` 起）');

  // M7-b 账实一致：`meta.chars` 这个"产者自记的账"有了消费者
  ok(execSrc.includes('memoryCtxCharsAccounted: memoryCtxMeta?.chars ?? 0')
    && execSrc.includes('memoryCtxChars: (memoryContext || \'\').length'),
    'G-b-6 ★★`meta.chars` 落成水位键 `memoryCtxCharsAccounted`，**与** `memoryCtxChars`（真入上下文的体积）**并列**'
    + '而不是替换——两者之差即包裹开销，此前"账算完即扔"（修了但没人用）');

  // M7-c 记账补齐：`<lessons-learned>` 真入文者回执
  // zx_20261018_1 批七：返回值增补了四源分账 `sections` 与 `historyRange`，原先的字面串
  //   `return { messages, projectCtx, summaryOnly, lessonsIds };` 已不再逐字存在。判据**按符号重定向**
  //   （不放宽）：仍要求第四位回传量按序在返回对象头四个键里，且由真实入文处逐个 push。
  ok(ctxExec.includes('lessonsIds.push(String(m.id))')
    && /return \{\s*messages,\s*projectCtx,\s*summaryOnly,\s*lessonsIds,/.test(ctxExec),
    'G-b-7 第四个回传量 `lessonsIds` 由**真实入文处**逐个 push（不是另起一趟"再查一遍谁该算"）');
  ok(execSrc.includes('const lessonSet = [...new Set(lessonsIds)];')
    && /if \(lessonsIds\.length > 0\) \{[\s\S]{0,600}?rctx\.injected_memory_ids = \[\.\.\.new Set\(\[\.\.\.prevInjected, \.\.\.lessonSet\]\)\]/.test(execSrc)
    && /rctx\.memory_used_ids_run = \[\.\.\.new Set\(\[\.\.\.prevRun, \.\.\.lessonSet\]\)\]/.test(execSrc),
    'G-b-8 ★回执侧认到执行体：`injected_memory_ids`（跨 run 并集）与 `memory_used_ids_run`（本 run 集）**双双 union**，'
    + '不得整体覆写——照抄"写得对"的样子，两处都在场');

  // M7-d 分层检索接线
  ok(retSrc.includes('const pool = retrieveLayered(mgr, queryText, queryEmb, projectId, topK, { longTermK: Math.max(topK * 4, 20) }).longTerm;')
    && retSrc.includes('const { episodic, semantic } = splitTaskLayers(pool, (m) => mgr.retrievalStrength(m), Date.now());')
    && retSrc.includes('const merged = mergeTaskLayers(episodic, semantic, topK);'),
    'G-b-9 ★三跳齐全且按序：**放宽**长期层池（`longTermK`）→ 按 Tulving 二分各排各的（强度由管理器传值）→ 轮转交织取 topK');

  // M7-e 工作记忆
  ok(mgrSrc.includes('if (hit) { hit.n = (hit.n ?? 1) + 1; hit.ts = ts; }')
    && mgrSrc.includes('const keep = new Set(ranked.slice(0, WM_POOL_CAP).map((r) => r.item));')
    && mgrSrc.includes('ctx.working_memory = wm.filter((w) => keep.has(w));'),
    'G-b-10 ★池满时按**值**淘汰（`ranked.slice(0, WM_POOL_CAP)`）；同内容再记一次是**一次更强的复述**（`n` 加一、`ts` 刷新），不是占两格');
  eq(mgrSrc.includes('while (wm.length > 7) wm.shift();'), false,
    'G-b-11 ★FIFO 语句**已不在源码里**——注意锚点带分号：旧写法在本文件的**注释里**作为被引用的旧实现仍可见'
    + '（那正是"改完实现须回头改注释"留的痕），故判据必须钉**代码形状**而非子串在场');
  ok(mgrSrc.includes('private _extractKeywords(text: string): string[] {\n    return extractKeywords(text);')
    || /private _extractKeywords\(text: string\): string\[\] \{\s*return extractKeywords\(text\);/.test(mgrSrc),
    'G-b-12 ★分词器**只留一份**：管理器私有方法改为**委托**（签名不变 ⇒ 八处内部调用点与既有判据一字不改）');
  eq([mgrSrc.includes('chineseRuns'), mgrSrc.includes('stopChars')], [false, false],
    'G-b-13 ★反证：管理器里**不再有分词器的实现特征**（中文 bigram 回退那两处构造缺席）'
    + '——不拿"停用词表"当锚点：管理器另有**一处**与分词无关的短 `stop` 表（术语扩展用），'
    + '拿它当反证会把"别处的同名字眼"读成本处的第二份实现');

  // M7-f 图式重构召回
  ok(retSrc.includes('const SCHEMA_RECALL_KEY = \'memory.schema_recall\';'),
    'G-b-14 开关名在检索模块侧抽成常量（唯一读点用它，不散写字面量）');
  // zx_20261018_3 批一：末跳改为三元式（`retrieveTaskRelevantWithSource` 要把来源一并带出）——
  //   判据语义不变、钉的语句形状随真源更新：缺图式**或**开关关 ⇒ `merged` 原序；否则 `applySchemaRecall`。
  ok(/const memories = \(!schemaText \|\| !readBoolSetting\(mgr\.db, SCHEMA_RECALL_KEY\)\)\s*\?\s*merged\s*:\s*applySchemaRecall\(merged, schemaText, \{ keywordsOf: extractKeywords \}\);/.test(retSrc),
    'G-b-15 ★末跳：缺图式**或**开关关 ⇒ 原序返回（旧口径）；否则按图式重建条序');
  eq((retSrc.match(/readBoolSetting\(mgr\.db, SCHEMA_RECALL_KEY\)/g) ?? []).length, 1,
    'G-b-16 该开关在检索模块里**恰一个读点**（读点分身＝同一条判断的第二份实现）');
  ok(ctxSrc.includes('memory.retrieveTaskRelevant(taskId, projectId, 5, schemaText)'),
    'G-b-17 ★装配侧真把第四实参传下去了（只改管理器不传图式 ⇒ 全绿而生产恒走旧口径）');
  eq(ctxSrc.includes('const schemaText = [principalContradiction ?? \'\', taskGoal?.goal ?? \'\', taskGoal?.success_criteria ?? \'\', ...(taskGoal?.investigate ?? [])]'), true,
    'G-b-18 图式的来源钉死在「主要矛盾 + 立志三问」——**不是** `taskText`（题面是上游取数源，拿它当图式＝同一把尺再量一遍）');

  // 开关键三处同源（判据白名单 / 落库缺省 / 消费读点）：错任一处即静默失效
  const keyLit = '\'memory.schema_recall\'';
  eq([boolSrc.includes(keyLit), dbSrc.includes(keyLit), retSrc.includes(keyLit)], [true, true, true],
    'G-b-19 ★★同一键名在**三处**同时在场：`settings-bool.ts` 白名单（判据侧）/ `database.ts` 的 `ensureSetting`（落库缺省侧）'
    + '/ 检索模块常量（消费侧；批七搬出管理器，键名未动）——键名写错任一处即"开关装了但拨不动"，而三处各自都能单独看绿');
  ok(/ensureSetting\('memory\.schema_recall', 'true'\);/.test(dbSrc),
    'G-b-20 缺省即开（本轮主线：合上插头；默认关＝生产恒走旧口径，A/B 的意义就没了）');
}

// ══════════════════════════════════════════════════════════════════
// 【H】M8 遗忘与归档（墓碑 / 分级 / 同源有界）
// ══════════════════════════════════════════════════════════════════
/** 按 `database.ts` 的 DDL 摘取（含 M8 三列 —— 缺列则 `TOMBSTONE_UPDATE_SQL` 直接抛错被 catch 吞成假绿）。 */
const H_SCHEMA = `
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active');
CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL,
  embedding TEXT, memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5,
  reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '',
  valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0,
  exemplar_type TEXT, exemplar_context TEXT, use_count INTEGER DEFAULT 0, last_used_at TEXT,
  similar_to TEXT DEFAULT '', last_reinforced_at TEXT, success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')),
  deleted_at TEXT, deleted_reason TEXT DEFAULT '', deleted_fingerprint TEXT DEFAULT '');
CREATE INDEX idx_wa_memories_tombstone ON wa_memories(memory_type, deleted_fingerprint);
`;

function groupHa(): void {
  console.log('\n【H-a】分级词表与"哪些还活着"（同一概念的两处写法必须互相印证）');
  // ★词表的语义侧与 SQL 侧本是一件事的两种写法：`MEM_LIVE_SQL` 必须恰排除**检索不可见**的那几级。
  //   写死 `NOT IN ('archived','deleted')` 来断言，证的是我抄的那份；从 `MEM_GRADES` 派生才能两边互证。
  eq(MEM_GRADES.filter((g) => g.retrievalVisible).map((g) => g.grade), ['active', 'cooling'],
    'H-a-1 ★可检索的两级恰是「活跃/冷却」（前两级可见、后两级不可见——`MEM_LIVE_SQL` 就是这条分界）');
  eq(MEM_LIVE_SQL, memTypeNotInSql(...MEM_GRADES.filter((g) => !g.retrievalVisible).map((g) => g.grade)),
    'H-a-2 ★★SQL 侧片段由词表**派生**而非手抄：改任一侧而另一侧不动，本条即红（本轮要治的正是"两处写法"）');
  eq(gradeSpec('deleted').label, '墓碑',
    'H-a-3 墓碑的**中文名唯一落点**在词表（渲染层直引，不手抄第二次）');
  eq([gradeSpec('deleted').guiVisible, gradeSpec('deleted').auditVisible, gradeSpec('deleted').retrievalVisible], [false, true, false],
    'H-a-4 墓碑三问的答：常规列表**不显示** / 审计面**显示** / **不参与检索**');
  eq([gradeSpec('archived').guiVisible, gradeSpec('archived').auditVisible, gradeSpec('archived').retrievalVisible], [true, false, false],
    'H-a-5 归档三问的答：常规列表显示（可恢复）/ 审计面不列（它没"去向"要交代）/ 不参与检索');
}

function groupHb(): void {
  console.log('\n【H-b】分级判定 `gradeOf`（真值表；`nowMs` 注入，不依赖真实墙钟 G-4）');
  const NOW = Date.parse('2026-09-30T00:00:00Z');
  const at = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
  eq(gradeOf({ memory_type: MEM_TYPE_DELETED }, NOW), 'deleted', 'H-b-1 墓碑哨兵 ⇒ deleted（先判哨兵，与时间无关）');
  eq(gradeOf({ memory_type: MEM_TYPE_ARCHIVED }, NOW), 'archived', 'H-b-2 归档哨兵 ⇒ archived');
  eq(gradeOf({ memory_type: 'episodic', created_at: at(1) }, NOW), 'active', 'H-b-3 昨天建的 ⇒ 活跃');
  eq(gradeOf({ memory_type: 'episodic', created_at: at(40) }, NOW), 'cooling', 'H-b-4 40 天没被取用 ⇒ 冷却');
  eq(gradeOf({ memory_type: 'episodic', created_at: at(400), last_used_at: at(2) }, NOW), 'active',
    'H-b-5 ★基准取 `last_used_at || created_at`——400 天前建但昨天刚用过 ⇒ 活跃（问的是"多久没被取用"）');
  eq(gradeOf({ memory_type: 'episodic', created_at: at(400), last_used_at: at(400) }, NOW), 'cooling',
    'H-b-6 反面标本：同样 400 天前的行，`last_used_at` 也是 400 天前 ⇒ 冷却（H-b-5 与 H-b-6 只差一列，故确系该列在起作用）');
  eq(gradeOf({ memory_type: 'episodic', created_at: at(MEM_COOLING_AFTER_DAYS) }, NOW), 'active',
    `H-b-7 边界：恰 ${MEM_COOLING_AFTER_DAYS} 天 ⇒ 活跃（判据是**严格大于**，边界不许两边都算命中）`);
  eq(gradeOf({ memory_type: 'episodic', created_at: at(MEM_COOLING_AFTER_DAYS + 1) }, NOW), 'cooling',
    'H-b-8 边界另一侧：31 天 ⇒ 冷却（与 H-b-7 成对，边界方向即被钉死）');
  eq(gradeOf({ memory_type: 'episodic', created_at: null }, NOW), 'active',
    'H-b-9 读不到时间 ⇒ 判活跃（宁可少标"冷"，不可把读不到当成冷）');
  eq(gradeOf({ memory_type: 'episodic', created_at: '不是时间' }, NOW), 'active', 'H-b-10 同样的"读不到"（非法串）⇒ 活跃');

  // ★本模块刻意不 import `memory-decay`（保持零依赖），代价是多一份最小解析 ⇒ 两份必须逐位等价。
  const probes = [null, '', '2026-09-30 00:00:00', '2026-09-30T00:00:00Z', '2026-09-30T00:00:00+08:00', '不是时间', ' 2026-01-02 03:04:05 '];
  eq(probes.map(_parseUtcMsForEquivalence), probes.map(dbTimeMs),
    'H-b-11 ★★`parseUtcMs` 与 `dbTimeMs` 在**同一批字面量**上同值（含带 Z / 带偏移 / 非法 / 带空白四种形态）'
    + '——本条不是"允许两份实现各自漂"，而是把等价性钉成可判');
}

function groupHc(): void {
  console.log('\n【H-c】落墓碑（真内存库；0→1 正面断言 + 幂等不覆盖第一次的缘由）');
  const db = new DatabaseSync(':memory:') as unknown as AnyDb;
  db.exec(H_SCHEMA);
  db.prepare("INSERT INTO wa_memories (id, project_id, task_id, content, memory_type, embedding) VALUES ('m1', 'p1', '', '甲项目的 第一条 记忆', 'episodic', 'vec-a')").run();
  const rowOf = (id: string) => db.prepare('SELECT * FROM wa_memories WHERE id = ?').get(id) as Record<string, unknown>;

  eq(rowOf('m1').memory_type, 'episodic', 'H-c-1 前置自证：起初还不是墓碑（否则下面那句"0→1"是空转假绿）');
  const ok1 = tombstoneMemory(db, 'm1', MEM_DELETE_REASONS.userMemory, Date.parse('2026-09-30T01:02:03Z'));
  eq([ok1, rowOf('m1').memory_type, rowOf('m1').content, rowOf('m1').embedding], [true, MEM_TYPE_DELETED, '', null],
    'H-c-2 ★0→1 正面断言：真改到行；哨兵置为 `deleted`；**正文清空、嵌入清空**'
    + '（墓碑不搬运内容——正文既是体积大头，也正是"删了又回来"的唯一载体）');
  eq(rowOf('m1').deleted_at, '2026-09-30 01:02:03', 'H-c-3 `deleted_at` 是**注入时刻**的 UTC 串（格式与库内 `datetime(\'now\')` 逐字一致）');
  eq(rowOf('m1').deleted_reason, MEM_DELETE_REASONS.userMemory, 'H-c-4 缘由落库（审计面直接显示这些串）');
  ok(String(rowOf('m1').deleted_fingerprint).length > 0,
    'H-c-5 指纹在场（它有读者：`tombstoneBlocksContent` 靠它拦"机器又把删掉的东西找回来"）',
    String(rowOf('m1').deleted_fingerprint));

  const ok2 = tombstoneMemory(db, 'm1', MEM_DELETE_REASONS.projectCascade, Date.parse('2026-10-05T00:00:00Z'));
  eq([ok2, rowOf('m1').deleted_reason, rowOf('m1').deleted_at],
    [false, MEM_DELETE_REASONS.userMemory, '2026-09-30 01:02:03'],
    'H-c-6 ★幂等且**不覆盖第一次的缘由与时刻**：已是墓碑 ⇒ 返回 false 且账面一字未动'
    + '（否则"随项目删除"会把"用户在记忆页删的"改写成另一个说法，第一次的因由就丢了）');
  eq(tombstoneMemory(db, '不存在', MEM_DELETE_REASONS.userMemory), false, 'H-c-7 行不存在 ⇒ false（不是抛错）');
}

function groupHd(): void {
  console.log('\n【H-d】墓碑拦截"机器写入"（正反两侧各一只标本；且**人说了算**）');
  const db = new DatabaseSync(':memory:') as unknown as AnyDb;
  db.exec(H_SCHEMA);
  db.prepare("INSERT INTO wa_memories (id, project_id, content) VALUES ('d1', 'p1', '用户明确不要的结论 Alpha')").run();
  const insOther = (id: string, pid: string, c: string) =>
    db.prepare('INSERT INTO wa_memories (id, project_id, content) VALUES (?,?,?)').run(id, pid, c);
  insOther('keep', 'p1', '另一条还活着的记忆');
  tombstoneMemory(db, 'd1', MEM_DELETE_REASONS.userMemory);

  eq(tombstoneBlocksContent(db, 'p1', '用户明确不要的结论 Alpha'), true, 'H-d-1 同项目 + 同内容 ⇒ **拦**（该命中）');
  eq(tombstoneBlocksContent(db, 'p1', '用户明确不要的结论   ALPHA'), true,
    'H-d-2 ★归一化后同内容也拦（折叠空白 + 小写）：换行/大小写差异不构成"另一条内容"，否则机器换个排版就能绕过去');
  eq(tombstoneBlocksContent(db, 'p1', '用户明确不要的结论 Beta'), false, 'H-d-3 ★该**不**命中：不同的内容不许被连带拦下');
  eq(tombstoneBlocksContent(db, 'p2', '用户明确不要的结论 Alpha'), false,
    'H-d-4 ★跨项目**不**拦："在甲项目删掉的东西"不构成"乙项目不许学"的理由');
  eq(tombstoneBlocksContent(db, 'p1', '另一条还活着的记忆'), false,
    'H-d-5 ★该**不**命中：那是**活着的**记忆，`deleted_fingerprint` 为空 ⇒ 与墓碑的空指纹不同源');
  eq(contentFingerprint('A B').slice(-2), contentFingerprint('a  b').slice(-2),
    'H-d-6 指纹尾部带长度：归一化后同长则同尾（"同哈希不同长"的碰撞可被察觉，而非静默同化）');
  eq(contentFingerprint('abc') === contentFingerprint('abd'), false, 'H-d-7 一字之差即异指纹（指纹有区分度）');
}

function groupHe(): void {
  console.log('\n【H-e】级联与保留期（随项目/任务删除、归档保留期届满）');
  const db = new DatabaseSync(':memory:') as unknown as AnyDb;
  db.exec(H_SCHEMA);
  const insLive = (id: string, pid: string, tid: string) =>
    db.prepare("INSERT INTO wa_memories (id, project_id, task_id, content, embedding, memory_type, deleted_reason) VALUES (?,?,?,?,?,'episodic','')")
      .run(id, pid, tid, `内容${id}`, 'v');
  insLive('a1', 'p1', 't1'); insLive('a2', 'p1', 't2'); insLive('a3', 'p2', 't1');
  eq(tombstoneMemoriesBy(db, 'project_id', 'p1', MEM_DELETE_REASONS.projectCascade), 2,
    'H-e-1 ★0→2：随项目删除落墓碑，条数如实（甲项目两条）');
  eq((db.prepare("SELECT COUNT(*) AS c FROM wa_memories WHERE memory_type = ?").get(MEM_TYPE_DELETED) as { c: number }).c, 2,
    'H-e-2 正面核账：库里恰两条墓碑（不是"函数没抛错"就算过）');
  eq((db.prepare("SELECT memory_type AS t FROM wa_memories WHERE id = 'a3'").get() as { t: string }).t, 'episodic',
    'H-e-3 ★该**不**动：乙项目的记忆不在甲项目的级联面内');
  eq((db.prepare("SELECT deleted_reason AS r FROM wa_memories WHERE id = 'a1'").get() as { r: string }).r, MEM_DELETE_REASONS.projectCascade,
    'H-e-4 级联落的缘由是"随项目删除"（与单条删的缘由区分开——审计面据此看得出这一条是谁带走的）');
  eq(tombstoneMemoriesBy(db, 'project_id', 'p1', MEM_DELETE_REASONS.projectCascade), 0,
    'H-e-5 幂等：再跑一次不再重复计数（已是墓碑的行不在源集里）');
  eq(tombstoneMemoriesBy(db, 'task_id', 't1', MEM_DELETE_REASONS.taskCascade), 1,
    'H-e-6 按 `task_id` 级联（白名单另一列）：还剩 a3 那条同任务号的，落 1 条');
  eq(tombstoneMemoriesBy(db, 'content' as never, 'x', MEM_DELETE_REASONS.taskCascade), 0,
    'H-e-7 ★白名单外列名 ⇒ 直接 0（列名会拼进 SQL，故只接受两个枚举值，不接受任意串）');

  // 保留期届满：归档 → 墓碑
  const db2 = new DatabaseSync(':memory:') as unknown as AnyDb;
  db2.exec(H_SCHEMA);
  const insOld = (id: string, days: number) =>
    db2.prepare("INSERT INTO wa_memories (id, project_id, content, memory_type, created_at) VALUES (?, 'p1', ?, 'archived', ?)")
      .run(id, `旧文${id}`, new Date(Date.parse('2026-09-01T00:00:00Z') - days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19));
  insOld('old', 200); insOld('young', 3);
  eq(tombstoneExpiredArchived(db2, 0, MEM_DELETE_REASONS.retention, Date.parse('2026-09-01T00:00:00Z')), 0,
    'H-e-8 ★保留期为 0 ⇒ 关闭（同 `memory.archive_retention_days` 的 0=关 语义）——关着的闸不许自己动手');
  eq(tombstoneExpiredArchived(db2, 90, MEM_DELETE_REASONS.retention, Date.parse('2026-09-01T00:00:00Z')), 1,
    'H-e-9 ★0→1：200 天前归档的超过 90 天保留期 ⇒ 落墓碑；3 天前的那条**不在面内**');
  eq([(db2.prepare("SELECT memory_type AS t FROM wa_memories WHERE id='old'").get() as { t: string }).t,
    (db2.prepare("SELECT memory_type AS t FROM wa_memories WHERE id='young'").get() as { t: string }).t],
  [MEM_TYPE_DELETED, MEM_TYPE_ARCHIVED],
  'H-e-10 两标本同试：老的真成了墓碑，嫩的仍是归档（只命中该命中的）');
  eq((db2.prepare("SELECT deleted_reason AS r FROM wa_memories WHERE id='old'").get() as { r: string }).r, MEM_DELETE_REASONS.retention,
    'H-e-11 缘由是"归档保留期届满"——与"用户删的""随项目删的"在账上分得开');

  // 去向可查
  const list = listTombstones(db2);
  eq([list.length, list[0]?.id, list[0]?.deleted_reason], [1, 'old', MEM_DELETE_REASONS.retention],
    'H-e-12 ★审计面 `listTombstones` 真查得到（"它去哪了"有处可查），且带 id/时刻/缘由三件');
  eq(list.filter((r) => r.project_id === 'p1').length, 1, 'H-e-13 按项目过滤可用（审计面按项目下钻）');
  eq(listTombstones(db2, 'p-不存在').length, 0, 'H-e-14 反侧：别的项目名下没有墓碑');
}

function groupHf(): void {
  console.log('\n【H-f】同源替换有界（未超限逐字等于旧写法；超限留尾部且反复追加不增长）');
  eq(boundedSameSource('甲', '乙'), '甲\n[更新]\n乙', 'H-f-1 未超限 ⇒ **逐字等于旧写法**（零行为变化，不引入新格式）');
  eq(boundedSameSource('甲', '乙', { label: '合并' }), '甲\n[合并]\n乙', 'H-f-2 标签可换（合并路用自己的标签，语义如实）');
  const maxChars = 20;
  const prev = 'x'.repeat(50), next = 'y'.repeat(10);
  const merged = `${prev}\n[更新]\n${next}`;
  const folded = boundedSameSource(prev, next, { maxChars });
  eq(folded, memFoldNote(merged.length - maxChars) + merged.slice(merged.length - maxChars),
    'H-f-3 超限 ⇒ 折叠说明 + **最近 `maxChars` 字**（唯一一份折叠说明由 `memFoldNote` 生成，此处不自造文案）');
  ok(folded.endsWith(next), 'H-f-4 ★留的是**尾部**：新搜索结果覆盖旧同源记忆 ⇒ 弃早留新才与语义同向', folded);
  ok(folded.length <= maxChars + memFoldNote(999_999_999).length,
    `H-f-5 有界：长度 ≤ maxChars + 折叠说明长度（≤ ${maxChars + memFoldNote(999_999_999).length}）`, String(folded.length));
  let acc = prev;
  for (let i = 0; i < 6; i++) acc = boundedSameSource(acc, next, { maxChars });
  ok(acc.length <= maxChars + memFoldNote(999_999_999).length,
    'H-f-6 ★反复追加 6 次仍是**同一个上界**（线性膨胀的真根在此：旧写法每次 `prev + next` 直接长一格，永无上界）',
    String(acc.length));
  ok(acc.length > maxChars, 'H-f-7 反证自证：这个标本确实触到了上限（否则 H-f-5/H-f-6 是空转）', String(acc.length));
  eq(MEM_SAME_SOURCE_MAX_CHARS, 2000, 'H-f-8 缺省上限即模块常量（调用点不各写一个数）');
}

function groupHg(): void {
  console.log('\n【H-g】静态接线（读原文 G-5；锚点钉符号/语句形状）');
  const mgr = RD(`${A}/src/main/core/memory-manager.ts`);
  // zx_20261018_2 批七「见简」：巩固簇搬入 `memory-consolidation.ts`（整合/剪枝/冲突消解）——
  //   "物理删三处豁免"与"整合走墓碑写口"的判据按符号重定向到**两者之和**（不放宽：总数仍恰 3）。
  const cons = RD(`${A}/src/main/core/memory-consolidation.ts`);
  const admin = RD(`${A}/src/main/ipc/admin.ipc.ts`);
  const proj = RD(`${A}/src/main/ipc/project.ipc.ts`);
  const jobs = RD(`${A}/src/main/core/jobs/index.ts`);
  // zx_20261003 M8 就地改钉：`finalize_task` 的执行体（`MEM_LIVE_SQL` 的消费点随其搬迁）已由
  //   `tools/control.ts` 机械搬迁至 `tools/control-finalize.ts`（导出 `runFinalizeTask`）——
  //   读取点名单随之指到新真源（H-g-1 裸谓词零处 / H-g-2 引一处真源 / H-g-6 不手写指纹，判据一字未改）。
  const ctrl = RD(`${A}/src/main/core/tools/control-finalize.ts`);
  const inv = RD(`${A}/src/main/core/architectural-invariants.ts`);
  const dbSrc = RD(`${A}/src/main/database.ts`);
  const lc = RD(`${A}/src/main/core/memory-lifecycle.ts`);
  const page = RD(`${A}/renderer/src/pages/MemoriesPage.tsx`);

  // ① 手抄的 `!= 'archived'` 已清零 —— 手抄者必漏 `'deleted'`，而漏项的后果是**墓碑被当活记忆注入**（静默、方向恰相反）
  const bare = /\bmemory_type\s*!=\s*'archived'/;
  eq([bare.test(mgr), bare.test(admin), bare.test(proj), bare.test(jobs), bare.test(ctrl), bare.test(inv)], [false, false, false, false, false, false],
    'H-g-1 ★★六个文件里**零处**裸 `memory_type != \'archived\'`（这是本轮的病根形状：新增墓碑哨兵的第一处漏点就在这些手抄处）');
  eq([mgr.includes('MEM_LIVE_SQL'), admin.includes('MEM_LIVE_SQL'), proj.includes('MEM_LIVE_SQL'), jobs.includes('MEM_LIVE_SQL'), ctrl.includes('MEM_LIVE_SQL')],
    [true, true, true, true, true],
    'H-g-2 上述读取点全部改引**一处真源**（不是各写各的谓词）');
  {
    // 批七拆分后总量守恒：管理器 3 + 检索 6 + 巩固 9 + 范例 2 = 20（拆分前后逐点对齐，见 rr_zx_20260911_4）。
    const memAll = mgr + '\n' + RD(`${A}/src/main/core/memory-retrieval.ts`) + '\n' + cons
      + '\n' + RD(`${A}/src/main/core/memory-exemplars.ts`);
    const n = (memAll.match(/\$\{MEM_LIVE_SQL\}/g) ?? []).length;
    ok(n >= 15,
      'H-g-3 记忆四模块的内插点数合计 ≳15（方向性下界，非冻结等值）：记忆读取主战场（拆分后总量守恒）',
      String(n));
  }
  // ★反面：内插必须落在**模板字面量**里。双引号里 `${...}` 是字面文本，会原样进 SQL 而 tsc 不报错。
  const liveFiles = [`${A}/src/main/core/memory-manager.ts`, `${A}/src/main/ipc/admin.ipc.ts`, `${A}/src/main/ipc/project.ipc.ts`,
    `${A}/src/main/core/jobs/index.ts`, `${A}/src/main/core/tools/control-finalize.ts`, `${A}/src/main/core/architectural-invariants.ts`];
  eq(liveFiles.map((f) => /"\$\{MEM_LIVE_SQL\}"/.test(RD(f))), [false, false, false, false, false, false],
    'H-g-4 ★★反证：无一处把内插写进**双引号**（`"${MEM_LIVE_SQL}"` 是死文本 ⇒ SQL 里会多出这串字面量，而 tsc/tsup 全都不报错）');

  // ② 墓碑写入语句形状唯一（一处真源）
  eq((lc.match(/UPDATE wa_memories SET memory_type/g) ?? []).length, 1, 'H-g-5 墓碑 UPDATE 语句形状**恰一份**（在 `memory-lifecycle.ts`）');
  eq((mgr + admin + proj + jobs + ctrl).includes('deleted_fingerprint'), false,
    'H-g-6 反证：`deleted_fingerprint` 不在任何消费侧被手写（写入面唯一 ⇒ 指纹算法只有一份）');
  eq([admin.includes('DELETE FROM wa_memories'), proj.includes('DELETE FROM wa_memories')], [false, false],
    'H-g-7 ★两处"删记忆"的 IPC 里**零** `DELETE FROM wa_memories`（已全改落墓碑）');
  eq((mgr.match(/DELETE FROM wa_memories/g) ?? []).length + (cons.match(/DELETE FROM wa_memories/g) ?? []).length, 3,
    'H-g-8 zx_20261012_1 批一：管理器+巩固模块里**恰 3 处**物理删，且三处皆**如实登记的豁免**（合并/冲突消解/全景重算——正文在别处留存，或本就是派生行）；原第 4 处（整合的被并入方）已改落墓碑 ⇒ 4→3');
  ok(/tombstoneMemory\(mgr\.db, b\.id, consolidatedIntoReason\(a\.id\)\)/.test(cons),
    'H-g-8b ★★整合 `consolidateMemories` 的被并入方改走**墓碑写口**（正文清空但留 id/时刻/缘由 ⇒"这条并进了谁"可答；承"账必有痕"）');
  ok(/const consumed = new Set<string>\(\)/.test(cons),
    'H-g-8c ★整合补齐 `consumed` 守卫（与 `reconsolidateMemories` 同形）——拦"被合并走的 b 又当容器去删 c"的静默丢内容');

  // ③ storeText 的拦截（机器写入侧）
  ok(/if \(!src\.startsWith\('user_'\) && tombstoneBlocksContent\(this\.db, params\.project_id, params\.content\)\)/.test(mgr),
    'H-g-9 ★拦截条件**显式排除 `user_*`**：`user_correction` 是"人又开口说了话"，不许被机器写入侧的闸拦下（人说了算）');
  ok(/tombstoneBlocksContent\(this\.db, params\.project_id, params\.content\)\) \{[\s\S]{0,400}?const id = randomUUID\(\);/.test(mgr),
    'H-g-10 ★★拦截**先于** `const id = randomUUID()`（否则 id 已生、行已在写路上，"已拦截"就成了谎）');

  // ④ 自检面与墓碑的关系（跨模块交互：随项目删除的墓碑**刻意保留** project_id 作为出处）
  eq((inv.match(/memory_type != \?/g) ?? []).length, 2,
    'H-g-11 ★自检的**判据与修复**两处同尺：皆 `memory_type != ?` 绑 `MEM_TYPE_DELETED`');
  ok(/\.all\(MEM_TYPE_DELETED\)/.test(inv) && /\.run\(MEM_TYPE_DELETED\)/.test(inv),
    'H-g-12 ★★两处都真绑上了墓碑哨兵——**不排除则自愈会把刚落下的墓碑再物理删一次**（M8 的留痕当场作废，且每轮自检恒红）');

  // ⑤ 库侧：三列 + 一条索引（按写入/读取形状各配一条）
  eq(['deleted_at', 'deleted_reason', 'deleted_fingerprint'].map((c) => dbSrc.includes(`ALTER TABLE wa_memories ADD COLUMN ${c}`)), [true, true, true],
    'H-g-13 迁移三条齐（缺 `deleted_fingerprint` ⇒ 拦截恒不命中；缺 `deleted_reason` ⇒ 审计面说不出缘由）');
  ok(/CREATE INDEX IF NOT EXISTS idx_wa_memories_tombstone ON wa_memories\(memory_type, deleted_fingerprint\)/.test(dbSrc),
    'H-g-14 索引与**查询形状**对齐（拦截查询按 `memory_type + deleted_fingerprint` 走）');

  // ⑥ 消费侧：筛得取值来源保留全量（否则墓碑那一格点不到）；审计面真给 `deleted_*` 两列
  ok(/SELECT memory_type, COUNT\(\*\) as cnt FROM wa_memories GROUP BY memory_type/.test(admin),
    'H-g-15 ★类型卡的计数**保留全部取值**（含 `deleted`）——它同时是筛选条的取值来源，墓碑那一格必须点得到');
  ok(/const total = \(db\.prepare\(`SELECT COUNT\(\*\) as c FROM wa_memories m\$\{whereSql\}`\)\.get\(\.\.\.params\)/.test(admin),
    'H-g-16 ★`total` 与列表**同一套 WHERE**（此前是全库计数、与筛选无关 ⇒ 带筛选的翻页总数恒错）');
  ok(/where\.push\(`m\.\$\{MEM_LIVE_SQL\}`\)/.test(admin) && /if \(type\) \{ where\.push\('m\.memory_type = \?'\)/.test(admin),
    'H-g-17 两句收口：**不点名类型 ⇒ 常规列表（不含墓碑）**；点名 `type` ⇒ 精确匹配（点名 `deleted` 即审计面）');
  ok(/const row = db\.prepare\("SELECT id FROM wa_memories WHERE id = \? AND memory_type = 'semantic'"\)\.get\(id\)/.test(admin),
    'H-g-18 ★偏好页的守卫**保留**：只删得动 `semantic` 行（墓碑是 `deleted` ⇒ 二次删除恒 false，不会把缘由改写）');
  ok(/SELECT \* FROM wa_memories WHERE user_id = \? AND memory_type = 'semantic'/.test(admin),
    'H-g-19 偏好**列表**仍按 `semantic` 取值 ⇒ 墓碑天然不在其中（安全是构造出来的，不是靠新加的过滤）');

  // ⑦ 渲染层是词表的**第二个落点**：直引真源，不手抄
  ok(/import \{ MEM_GRADES[^}]*\} from '\.\.\/\.\.\/\.\.\/src\/main\/core\/memory-lifecycle\.js';/.test(page),
    'H-g-20 ★渲染层**跨 root 直引**生命周期模块（与既有 `memory-constants.js` 同一手法）——省掉第二份词表');
  eq(/['"`]墓碑['"`]/.test(page), false,
    'H-g-21 ★反证：页面里**没有**手抄的 `\'墓碑\'` 字面量（名字从词的唯一落点取；手抄则改一处必漏另一处）');
  ok(/const SENTINEL_LABEL: Record<string, string> = Object\.fromEntries\(MEM_GRADES\.map/.test(page),
    'H-g-22 哨兵名由词表**派生**成一张查表（不是另写一份 `{archived:\'归档\',deleted:\'墓碑\'}`）');
  ok(/`SELECT COUNT\(\*\) as c FROM wa_memories WHERE \$\{MEM_LIVE_SQL\}`/.test(admin) && /AND \$\{MEM_LIVE_SQL\} GROUP BY memory_type/.test(proj),
    'H-g-23 统计面（总记忆数 / 项目记忆分布）同尺：墓碑不计入"总记忆"');

  // ⑧ ★建索引的**时机**（本轮实机 E2E 打出的真缺陷）：`deleted_fingerprint` 不以建表列存在、
  //   只由 migrations 补出 ⇒ 拿它建的索引**必须排在迁移之后**。建在迁移前，老库（缺列）与新库
  //   （建表里本就没有该列）都会在建索引那一刻抛 `no such column`，`initDatabase` 整段失败、桌面起不来。
  //   为何此前全绿照不出：rr 夹具（node:sqlite）自带该列、且不跑 `initDatabase`（它要 better-sqlite3，
  //   与 Electron ABI 冲突）——夹具比生产宽松。故本条是**源码顺序判据**（G-5：读原文钉语句位置）。
  const idxRegion = dbSrc.slice(dbSrc.indexOf('===== 索引 ====='), dbSrc.indexOf('===== 迁移'));
  eq(idxRegion.includes('deleted_fingerprint'), false,
    'H-g-24 ★★反证：迁移**前**的建索引块里不含 `deleted_fingerprint`（一含即老库/新库双双 no such column）');
  ok(dbSrc.indexOf('idx_wa_memories_tombstone') > dbSrc.indexOf('for (const sql of migrations)'),
    'H-g-25 ★★墓碑索引建在**迁移循环之后**（顺序即正确性：列由迁移补出，索引须后建）');
}

// ══════════════════════════════════════════════════════════════════
// 【I】M9 恒 401 三路 · 到 ANS 的签名请求只有一条出路
// ══════════════════════════════════════════════════════════════════

/**
 * 取 `decl` 处起的**函数体配对花括号块**（按符号定位，不按行号）。
 *
 * 两条纪律各对一个已踩过的坑：
 *   ① **按符号不按行号**——行号是位置、会漂（本仓已三次复发）。
 *   ② **必须先配平参数括号再找函数体**：`syncSkillsFromAns(creds: AnsCreds, opts: { retries?: number } = {})`
 *      这种签名里"第一个 `{`"是**参数的类型字面量**而不是函数体。直接取第一个 `{` 会切出一个
 *      **平衡、且以 `}` 收口**的错误块——连下面那些"切片自证"都过得去 ⇒ 一整族断言变成自我印证。
 */
function fnBodyByDecl(src: string, decl: string): string {
  const from = src.indexOf(decl);
  if (from < 0) return '';
  const open = src.indexOf('(', from);
  if (open < 0) return '';
  let d = 0, close = -1;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === '(') d++;
    else if (c === ')') { d--; if (d === 0) { close = j; break; } }
  }
  if (close < 0) return '';
  return blockAfter(src, src.indexOf('{', close));
}

/** 取 `at` 处 `{` 起的**配对花括号块**（`at < 0` ⇒ 空串；调用方须自证非空）。 */
function blockAfter(src: string, at: number): string {
  if (at < 0) return '';
  let depth = 0;
  for (let j = at; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(at, j + 1); }
  }
  return '';
}

/** 取 `anchor` **所在的那层 `try { … }`** 块（用于非 `function` 形状的语句块）。 */
function enclosingTry(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  if (at < 0) return '';
  const t = src.lastIndexOf('try {', at);
  return t < 0 ? '' : blockAfter(src, t + 'try '.length);
}

/** 起一个**真桩 ANS**（`node:http`，端口 0 由系统分配）：把到达的 `{path, method, headers, body}` 原样记下。 */
async function ansStub(handler?: (path: string, body: string) => { status: number; body?: string }): Promise<{
  url: string;
  captured: Array<{ path: string; method: string; headers: http.IncomingHttpHeaders; body: string }>;
  close: () => Promise<void>;
}> {
  const captured: Array<{ path: string; method: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => { raw += c; });
    req.on('end', () => {
      captured.push({ path: req.url ?? '', method: req.method ?? '', headers: req.headers, body: raw });
      const out = handler ? handler(req.url ?? '', raw) : { status: 200, body: '{"data":[]}' };
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(out.body ?? '');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    captured,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function groupIa(): void {
  console.log('\n【I-a】一处真源与完备性扫面（读原文 G-5；锚点按符号）');
  const files = walkTs(`${A}/src/main`);
  const srcs = new Map<string, string>(files.map((f) => [f, RD(f)] as const));
  const TRUTH = `${A}/src/main/core/ans-signed-request.ts`;

  // ① 签名的**唯一实现处**。锚 `(` 而非裸名：`exec-step.ts` / `project.ipc.ts` 的**注释**里就写着这个名字，
  //    裸名会误命中 ⇒ 结论正好反了（"注释里供 X 消费"不算消费，本仓已记教训）。
  const hmacCallers = files.filter((f) => /createHmacSignature\s*\(/.test(srcs.get(f)!)).sort();
  eq(hmacCallers, [TRUTH],
    'I-a-1 ★★`createHmacSignature(` 的调用在 `src/main` **只在真源一处**（自造第二份 HMAC ＝以后判据只会自证）');
  eq((srcs.get(TRUTH)!.match(/createHmacSignature\s*\(/g) ?? []).length, 1,
    'I-a-1b 真源内也只调一次（不是"同一个 HMAC 写两遍"）');

  // ②③④ 三个"只此一处"的字面量：头名 / secret 缺省 / ANS 地址整串。
  eq(files.filter((f) => srcs.get(f)!.includes("'x-signature'")).sort(), [TRUTH],
    'I-a-2 ★`\'x-signature\'` 字面量只在一处（头名手抄第二份 ⇒ 两侧形状各自漂）');
  eq(files.filter((f) => srcs.get(f)!.includes("'dev-secret'")).sort(), [TRUTH],
    'I-a-3 ★`\'dev-secret\'` 只在一处（首启写进 DB 的缺省与签名用的缺省必须是同一个）');
  // ④ ANS 地址**单一真源**（zx_20261005 M21）：整串已**移出** `src/main`——落在
  //    `packages/shared-types/src/ans-defaults.ts` 一处；`ans-signed-request.ts` 与
  //    `core/mcp-client-pool.ts` 均由 `ANS_DEFAULT_BASE_URL` **派生**。
  //    ⇒ 本判据由"整串只此一处"**改钉为"`src/main` 内零处 + 真源派生"**（改旧断言＝改钉更强的新真源，非放宽）。
  eq(files.filter((f) => srcs.get(f)!.includes("'http://localhost:3001'")).sort(), [],
    'I-a-4 ★`src/main` 内**零** ANS 地址整串字面量（残留第二份 ⇒ 用户把 ANS 配到别处时那一路探的是另一台机器）');
  const ANS_DEFAULTS_SRC = 'packages/shared-types/src/ans-defaults.ts';
  const ansDefaultsTxt = RD(ANS_DEFAULTS_SRC);
  eq((ansDefaultsTxt.match(/ANS_DEFAULT_BASE_URL\s*=/g) ?? []).length, 1,
    'I-a-4b ★★地址真源在 shared-types **只定义一次**（多一份 ⇒ "改端口只改一处"当场作废）');
  const MCP_POOL = `${A}/src/main/core/mcp-client-pool.ts`;
  eq([TRUTH, MCP_POOL].filter((f) => /ANS_DEFAULT_BASE_URL/.test(srcs.get(f) ?? '') && /from '@worker-ant\/shared-types'/.test(srcs.get(f) ?? '')).sort(),
    [TRUTH, MCP_POOL].sort(),
    'I-a-4c ★两个消费方（`ans-signed-request.ts` 的缺省 url、`mcp-client-pool.ts` 的兜底模板串）'
    + '**都由 `ANS_DEFAULT_BASE_URL` 派生**（各自手写一份 ⇒ 改端口即失配）', `ANS_DEFAULT_BASE_URL=${ANS_DEFAULT_BASE_URL}`);
  ok(ANS_DEFAULT_PORT !== 3001 && /ANS_DEFAULT_BASE_URL\s*=\s*`http:\/\/\$\{ANS_DEFAULT_HOST\}:\$\{ANS_DEFAULT_PORT\}`/.test(ansDefaultsTxt),
    'I-a-4d ★默认端口已离 `3001`（Node/框架最常撞口）且整串由 host+port **派生**'
    + '（不许再手写 `localhost:27183` 整串——真源文件自身也须派生）', `port=${ANS_DEFAULT_PORT}`);

  // ⑤ **完备性扫面**：凡 `src/main` 里出现 `/api/v1/` 的文件，必须落在**两条签名路之一**上——
  //    ① `ansSignedRequest(`（裸路径）② `getAnsClient()`（SDK `AnsClient`，`requestWithRetry` 自带三头）。
  //    二者都不是的，只允许是**点名的公开豁免**（ANS 侧本就不挂 `hmacAuth` 的路）。
  const PUBLIC_EXEMPT = [
    `${A}/src/main/auth-oauth.ts`, // `/api/v1/auth/*` = 登录本身，此刻尚无身份可签
    // zx_20261005 M21：ANS **托管探测**（`core/ans-supervisor.ts` 的 `probeAns` 打的 `/api/v1/health`）
    //   **刻意不带签名**——它要回答的恰是"服务在不在"，而签名需要服务侧先有身份；带签名的探针会把
    //   "服务没起"与"服务起了但不认我"混作一谈，而本模块要分开的正是这两件事。ANS 侧该路由本就不挂 `hmacAuth`。
    `${A}/src/main/core/ans-supervisor.ts`,
  ];
  // zx_20261014_4 新真源值（承 CLAUDE.md「加真源枚举值须穷举全部读取谓词」）：
  //   `core/inbound-gate.ts` 是**我们自己的门**——其中 `/api/v1/*`（`INBOUND_API_PREFIX`/`INBOUND_PAIR_STATUS_PATH`）
  //   是**服务端**定义的路由（外部 AI 终端**入**门），由「私网地址闸 + Bearer `key.secret` 终端凭据」把关，
  //   与"出站 ANS HMAC 签名路"是**两码事**（本断言的对象是"真的**发出** `/api/v1/` 请求的客户端文件"）。
  //   它不是 ANS 侧的路由（故不并入 `PUBLIC_EXEMPT`），而是本机**服务端**面，单列以示其性质之别。
  const SERVER_SIDE_ROUTES = [`${A}/src/main/core/inbound-gate.ts`];
  const NOT_ON_SIGNING_PATH = [...PUBLIC_EXEMPT, ...SERVER_SIDE_ROUTES];
  // ⚠ zx_20261011 订正（**扫面按病根形态定**，非放宽）：完备性扫面的对象是"**真的发出** `/api/v1/` 请求的文件"。
  //   注释里**提到**这个路径 ≠ 在签名路上（注释发不出请求）——`node-dispatcher.ts` 只在其 `DispatchIo` 接口
  //   文档里点名了路径，实网那一半在 `node-dispatch-io.ts`。故此处按**去注释后**的代码扫，
  //   既不把"仅注释提及"误当漏头，也不放过真实未上路的请求（面更准，非放宽）。
  const srcsCode = new Map<string, string>(files.map((f) => [f, stripKeepingLines(srcs.get(f)!).join('\n')] as const));
  const apiFiles = files.filter((f) => srcsCode.get(f)!.includes('/api/v1/')).sort();
  const unrouted = apiFiles.filter((f) => f !== TRUTH
    && !/ansSignedRequest\s*\(/.test(srcsCode.get(f)!) && !/getAnsClient\s*\(\s*\)/.test(srcsCode.get(f)!));
  eq(unrouted, NOT_ON_SIGNING_PATH,
    'I-a-5 ★★完备性：`/api/v1/` 的每个文件都在签名路上；未上路的**恰是点名的豁免**'
    + '（多一个＝有路仍漏头，少一个＝豁免已不必要、应删；`ans-supervisor.ts` 为 zx_20261005 M21 新豁免：'
    + '健康探测不带签名——它要如实分开"服务没起"与"服务起了但不认我"；'
    + '`inbound-gate.ts` 为 zx_20261014_4 新豁免：本机**服务端**门路由（外部终端**入**门，凭据+私网闸，非出站签名路）；'
    + 'zx_20261011 起扫**去注释后**的代码：注释提及路径 ≠ 在签名路上）');
  ok(apiFiles.length >= 8, 'I-a-5b 扫面自证：`/api/v1/` 面确有 8 个文件（否则"全在册"是空转）', `${apiFiles.length} 个`);

  // ⑥ 逐处反证：四段函数体切片（按符号；自证含各自专属标识符）。
  const td = RD(`${A}/src/main/core/task-decompose.ts`);
  const sr = RD(`${A}/src/main/core/skill-registry.ts`);
  const ir = RD(`${A}/src/main/services/im-router.ts`);
  const pi = RD(`${A}/src/main/ipc/project.ipc.ts`);
  const bodies: Array<{ name: string; body: string; token: string }> = [
    { name: 'makeEnvDecomposeDeps', body: fnBodyByDecl(td, 'export function makeEnvDecomposeDeps'), token: 'resolveModel' },
    { name: 'syncSkillsFromAns', body: fnBodyByDecl(sr, 'export async function syncSkillsFromAns'), token: 'r.response' },
    { name: 'registerToAns', body: fnBodyByDecl(pi, 'async function registerToAns'), token: 'ansFetch' },
    { name: 'classifyIntentWithLLM', body: fnBodyByDecl(ir, 'async function classifyIntentWithLLM'), token: 'resolveChatCompletionsUrl' },
  ];
  eq(bodies.map((b) => b.body.length > 60 && b.body.endsWith('}') && b.body.includes(b.token)), [true, true, true, true],
    'I-a-6 ★切片自证：四个函数体都非空、以 `}` 收口、且含该函数的**专属标识符**'
    + '（否则 I-a-7 以下几条是切空/切错的假绿——`syncSkillsFromAns` 的签名里就有块级类型字面量，正是会切错的那种）');
  const fetchCount = (s: string): number => (s.match(/\bfetch\s*\(/g) ?? []).length;
  eq(bodies.slice(0, 3).map((b) => fetchCount(b.body)), [0, 0, 0],
    'I-a-7 ★★三处此前"漏头"的地方**零**裸 `fetch(`（①零认证头 ②只发 x-api-key ③只发 x-api-key，三条都由裸 fetch 造成）');
  eq(fetchCount(bodies[3].body), 1,
    'I-a-8 ★`classifyIntentWithLLM` 内**恰剩 1 处** `fetch(`——那是**模型**的 chat 调用（`resolveChatCompletionsUrl`），'
    + '不是 ANS 的；到 ANS 的那一跳已改签名出路（"恰一处且是模型那一处"，不是"零处"）');
  eq(bodies.map((b) => /ansSignedRequest\s*\(/.test(b.body)), [true, true, true, true],
    'I-a-9 四处都走 `ansSignedRequest(`（④经本函数内的 `ansFetch` 薄适配）');
  eq(/ansSignedRequest\s*\(\s*resolveAnsCreds\s*\(/.test(bodies[3].body), true,
    'I-a-10 ★im-router 这一处**现取身份**（`resolveAnsCreds(ctx.db)`）——不是模块加载时定死'
    + '（那条路曾只读 env，而桌面 main 不加载 `.env` ⇒ 恒 401）');
  eq(bodies.map((b) => /createHmacSignature|from '@worker-ant\/ans-client'/.test(b.body)), [false, false, false, false],
    'I-a-11 ★★反证：四处函数体内**均无**自造签名、也不直接引 `ans-client`（头只在真源里装；引了就是第五份写法）');

  // ⑦ 失败要显形。
  eq([bodies[0], bodies[1], bodies[3]].map((b) => /ansFailureNote\s*\(/.test(b.body)), [true, true, true],
    'I-a-12 ★三处非 2xx 分支都经 `ansFailureNote(...)` 留痕（status + 尝试次数一处压成一行）');
  ok(/logger\.warn\(/.test(bodies[0].body) && /console\.warn\(/.test(bodies[1].body) && /imLogger\.warn\(/.test(bodies[3].body),
    'I-a-13 三处各用**本模块既有的**日志手（task-decompose=`logger` / skill-registry=`console` / im-router=`imLogger`），未新造第二个 logger');
  eq(bodies.slice(0, 3).map((b) => /if\s*\(!\s*r\.ok\s*\)\s*\{?\s*return\s+(null|-1)\s*;/.test(b.body)), [false, false, false],
    'I-a-14 ★★反证：**零处**"`if (!r.ok) return null/-1;`"——这正是"失败不显形"的原始形状（401 不抛 ⇒ 连一行 warn 都没有）');
  ok(/ansFailureNote/.test(bodies[2].body),
    'I-a-15 ★`registerToAns` 的**查重那一跳**失败也显形——「注册失败」与「本来就没注册」从此可分（此前都化归 `null`）');

  // ⑧ 身份解析的消费面 + 缺省消费面 + 两处**已清零**的手抄形。
  eq(files.filter((f) => /resolveAnsCreds\s*\(/.test(srcs.get(f)!)).sort(), [
    `${A}/src/main/core/agent-executor.ts`,
    TRUTH,
    `${A}/src/main/core/tools/resource.ts`,
    `${A}/src/main/index.ts`,
    `${A}/src/main/ipc/admin.ipc.ts`,
    `${A}/src/main/ipc/project.ipc.ts`,
    `${A}/src/main/ipc-handlers.ts`,
    `${A}/src/main/services/im-router.ts`,
    // zx_20261004 回填（枚举新增须穷举读取谓词）：本轮的**节点身份/心跳/协同通道**三处新消费点
    //   都要现取身份（自助注册后的 key 就落在 `resolveAnsCreds` 读的那两键上），故一对一并列。
    `${A}/src/main/core/node-heartbeat.ts`,
    `${A}/src/main/core/node-request-io.ts`,
    `${A}/src/main/ipc/nodes.ipc.ts`,
    // zx_20261005 M21：`ans.ipc.ts` 新增 `ans:status`/`ans:start` 两条托管 IPC——渲染层要看的
    //   "ANS 在不在/谁在用哪个端口"须现取身份去探测，故与上列同形并入（判据前提被本轮设计合法改变，非放宽）。
    `${A}/src/main/ipc/ans.ipc.ts`,
    // zx_20261005 M14：`setup.ipc.ts` 的 `setup:state` 要现取身份判"用户真配过 ANS 没有"
    //   （`firstRunState` 收 `creds` 形参；现取那一跳在此）——与 `ans.ipc.ts` 同形并入。
    `${A}/src/main/ipc/setup.ipc.ts`,
    // zx_20261011 M3：`node-dispatch-io.ts` 是**派发（发送侧）**的真网出路——签名提交/读回都要**现取身份**
    //   （与 node-request-io.ts 同形，方向相反），故与上列同形并入（判据前提被本轮设计合法改变，非放宽）。
    `${A}/src/main/core/node-dispatch-io.ts`,
    // zx_20261011_4 M3：取数口 `fetchNodes` 由 `ipc/nodes.ipc.ts` **上移** `core/node-list.ts`（electron-free，
    //   面板与编排器读同一份台账）——它调 `resolveAnsCreds` 取身份去签那次 GET，故与上列同形并入
    //   （判据前提被本轮设计合法改变，非放宽；`nodes.ipc.ts` 仍在上列，其 `nodes:update`/`delete` 也现取身份）。
    `${A}/src/main/core/node-list.ts`,
    // zx_20261017_1 批六：团队共享库 `ipc/team.ipc.ts` 的共享/拉取/撤回三条真网出路都**现取身份**签名
    //   （与 node-dispatch-io 同形并入；判据前提被本轮设计合法改变，非放宽）。
    `${A}/src/main/ipc/team.ipc.ts`,
    // zx_20261023_5 批五：云端权益两处新消费点——
    //   ① `core/entitlement-client.ts` 要去 ANS 签 GET `/api/v1/entitlements`，须现取身份；
    //   ② `ipc/license.ipc.ts` 的 `license:cloud` 要回「是否已配 ANS 凭据」（`configured`），同形读两键但不签请求。
    //   （判据前提被本轮设计合法改变，非放宽。）
    `${A}/src/main/core/entitlement-client.ts`,
    `${A}/src/main/ipc/license.ipc.ts`,
  ].sort(),
    'I-a-16 ★★身份解析（DB→env→缺省）的消费面**恰这些生产落点 + 真源**'
    + '（`skill-registry`/`task-decompose` 收 `creds` 形参而不自己解析——所以不在此列表，这是刻意的；'
    + '第七处 `ipc/admin.ipc.ts` 是 zx_20260930 M14-3 新落点：健康自检的 ANS 探针要现取身份；'
    + 'zx_20261004 再补三处（node-heartbeat/node-request-io/nodes.ipc）；'
    + 'zx_20261005 M21 再补一处（ipc/ans.ipc.ts 的 ANS 托管探测）；'
    + 'zx_20261005 M14 再补一处（ipc/setup.ipc.ts 的首启状态现取身份）；'
    + 'zx_20261011 M3 再补一处（core/node-dispatch-io.ts 的派发真网出路现取身份）；'
    + 'zx_20261011_4 M3 再补一处（core/node-list.ts 的取数口上移后现取身份读台账）——**判据前提被本轮设计合法改变，非放宽**）');
  eq(files.filter((f) => srcs.get(f)!.includes('ANS_DEFAULTS')).sort(), [TRUTH],
    'I-a-17 ★缺省值 `ANS_DEFAULTS` 的消费面：**仅真源自身**——M16 起首启写库不再直引它，而经 `ansSeedCreds()`'
    + '（见 I-a-17b），故外部消费面收窄到零处；`resolveAnsCreds`/`ansUserConfigured`/`ansSeedCreds` 都在真源内消费它');
  eq(files.filter((f) => /ansSeedCreds\s*\(/.test(srcs.get(f)!)).sort(), [TRUTH, `${A}/src/main/database.ts`],
    'I-a-17b ★★首启写库的**唯一**出路 = `ansSeedCreds()`：写进去的与读出来签名的**同源**，且**依构建形态**给值'
    + '（开发写 dev-key/dev-secret，生产写空串）——若换成外部再抄一份字面量，生产首启就会把 dev-key 顶掉尾端形态开关');
  eq(files.filter((f) => srcs.get(f)!.includes(".get('ans_secret_key')")), [],
    'I-a-18 ★★反证：`.get(\'ans_secret_key\')` 这种**行内手抄读**全仓零处（此前 `index.ts`/`ipc-handlers.ts` 各一份）');
  eq(files.filter((f) => /wa_settings WHERE key\s*=\s*'(ans_server_url|ans_api_key|ans_secret_key)'/.test(srcs.get(f)!)), [],
    'I-a-19 ★★反证：`wa_settings WHERE key=\'ans_…\'`（**键名内联 SQL** 的另一种手抄形）同样零处'
    + '（此前 `tools/resource.ts` 两处即此形；它读的虽是 URL 不含 secret，但地址的第二份同样会让"配了不生效"）');
}

async function groupIb(): Promise<void> {
  console.log('\n【I-b】往返：生产签出的字节串，**生产验签器**认（真桩 + 生产导出，不自造等价物）');
  const stub = await ansStub();
  const creds: AnsCreds = { baseUrl: stub.url, apiKey: 'k-roundtrip', secretKey: 's-roundtrip' };
  // 入参取**生产同形**的那些（`makeEnvDecomposeDeps` / `classifyIntentWithLLM` 真实发的体），不自造等价物。
  const BODY = { capabilities: ['chat'], strategy: 'cost-optimal' };
  try {
    const r = await ansSignedRequest(creds, '/api/v1/models/optimal', { method: 'POST', body: BODY, retries: 0 });
    ok(r.ok && r.status === 200, 'I-b-1 真桩 200：请求成功（先有"到达"，才谈得上"到达了什么"）', `status=${r.status}`);
    eq(stub.captured.length, 1, 'I-b-2 桩**恰**收到 1 次请求（`retries:0` ⇒ 一次就是一次）');
    const cap = stub.captured[0];
    eq([cap.path, cap.method], ['/api/v1/models/optimal', 'POST'], 'I-b-3 路径与方法按原样送达');
    eq(cap.body, JSON.stringify(BODY),
      'I-b-4 ★★线上字节串 === `JSON.stringify(body)`——**签的与发的必须是同一串**，这正是往返的靶心');
    eq([cap.headers['x-api-key'], cap.headers['x-signature'] !== undefined, typeof cap.headers['x-timestamp']],
      ['k-roundtrip', true, 'string'], 'I-b-5 三个头都到了、头名是**小写**（ANS 侧取的就是小写名）');
    ok(cap.headers['content-type'] === 'application/json',
      'I-b-6 头里带 `Content-Type`（与既有各处形状一致，未因换路而丢）');
    // ★★★ 靶心：**生产验签器**（ANS 侧 `hmacAuth` 将要调的就是这个导出）验**生产签出**的东西。
    ok(verifyHmacSignature('s-roundtrip', String(cap.headers['x-timestamp']), cap.body, String(cap.headers['x-signature'])),
      'I-b-7 ★★★往返成立：`verifyHmacSignature` 认 `ansSignedRequest` 签出的 (timestamp, body, signature)'
      + '——两侧都是生产导出，判据里没有自造的 HMAC 等价物');
    // 反面标本三只（判据要有区分度，否则 I-b-7 可能是恒真）。
    ok(!verifyHmacSignature('s-roundtrip', String(cap.headers['x-timestamp']), cap.body + ' ', String(cap.headers['x-signature'])),
      'I-b-8 ★反面标本①**体被改动一个字节** ⇒ 验签为假（证明 I-b-7 不是恒真）');
    ok(!verifyHmacSignature('other-secret', String(cap.headers['x-timestamp']), cap.body, String(cap.headers['x-signature'])),
      'I-b-9 ★反面标本②**换一把 secret** ⇒ 为假');
    ok(!verifyHmacSignature('s-roundtrip', String(Number(cap.headers['x-timestamp']) + 600_000), cap.body, String(cap.headers['x-signature'])),
      'I-b-10 ★反面标本③**时间戳挪出 5 分钟窗** ⇒ 为假（窗口用的是生产 verifier 自己的口径，判据不另立一套）');
    // 无 body：签的字节串必须是**空串**——与 `AnsClient.requestWithRetry` 无体时的口径逐字相同。
    const r2 = await ansSignedRequest(creds, '/api/v1/skills', { method: 'GET', retries: 0 });
    ok(r2.ok, 'I-b-11 无 body 的 GET 也走通了同一条出路');
    const cap2 = stub.captured[1];
    eq([cap2.method, cap2.body], ['GET', ''],
      'I-b-12 ★无 body 时**线上无体**（不是发个 `"undefined"`，也不是空 JSON——那两种都会签出另一串字节）');
    ok(verifyHmacSignature('s-roundtrip', String(cap2.headers['x-timestamp']), '', String(cap2.headers['x-signature'])),
      'I-b-13 ★★无 body 时签的是**空串**（`${timestamp}\\n${body}` 的 body 位取空）——与 `AnsClient` 无体时的口径逐字相同');
    // 尾斜杠：解析层原样给，拼接处剥——以"真到达了哪条路径"证，而不是断言内部实现。
    const r3 = await ansSignedRequest({ ...creds, baseUrl: `${stub.url}/` }, '/api/v1/skills', { method: 'GET', retries: 0 });
    ok(r3.ok && stub.captured[2].path === '/api/v1/skills',
      'I-b-14 ★`baseUrl` 带尾斜杠也只拼出一条正确路径（不是 `/\/api/v1/…` 这种双斜杠）', stub.captured[2].path);
    // 头构造函数本身：键**恰**三个小写名。
    eq(Object.keys(ansSignedHeaders(creds, 'x', 1_700_000_000_000)).sort(), ['x-api-key', 'x-signature', 'x-timestamp'],
      'I-b-15 `ansSignedHeaders` 的键**恰**三个（多一个头就是第二份契约）');
  } finally { await stub.close(); }
}

async function groupIc(): Promise<void> {
  console.log('\n【I-c】失败要显形 · 重试语义（5xx/传输失败重试；4xx 不重试）');
  // 500：默认 `retries=1` ⇒ 恰两次尝试。
  const s500 = await ansStub(() => ({ status: 500, body: '{}' }));
  try {
    const r = await ansSignedRequest({ baseUrl: s500.url, apiKey: 'k', secretKey: 's' }, '/api/v1/models/optimal', { method: 'POST', body: { a: 1 } });
    eq([r.ok, r.status, r.attempts], [false, 500, 2],
      'I-c-1 ★5xx 重试：默认 `retries=1` ⇒ **恰 2 次尝试**（不是"试到某一次为止"那种说不清次数的写法）');
    eq(s500.captured.length, 2, 'I-c-2 桩侧同样确证收到 2 次（返回值的 `attempts` 与线上事实同源）');
    ok(ansFailureNote(r).includes('HTTP 500') && ansFailureNote(r).includes('尝试 2 次'),
      'I-c-3 `ansFailureNote` 把 status 与**尝试次数**一起压进一行', ansFailureNote(r));
  } finally { await s500.close(); }
  // 401：**不重试**（身份/契约问题，重试只会把"漏头"放大成三次静默）。
  const s401 = await ansStub(() => ({ status: 401, body: '{"error":"Missing authentication headers"}' }));
  try {
    const r = await ansSignedRequest({ baseUrl: s401.url, apiKey: 'k', secretKey: 's' }, '/api/v1/skills', { method: 'GET' });
    eq([r.ok, r.status, r.attempts], [false, 401, 1],
      'I-c-4 ★★4xx **不重试**（恰 1 次）——401 是身份问题，重试无益');
    ok(ansFailureNote(r).includes('HTTP 401') && ansFailureNote(r).includes('尝试 1 次'),
      'I-c-5 401 的留痕含 `HTTP 401` 与 `尝试 1 次`', ansFailureNote(r));
  } finally { await s401.close(); }
  // 传输失败：`status` 记 0（"无响应"）——与"有 HTTP 响应但是 4xx/5xx"**可分辨**。
  const rT = await ansSignedRequest({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', secretKey: 's' }, '/api/v1/skills', { method: 'GET', retries: 0, timeoutMs: 800 });
  eq([rT.ok, rT.status, rT.attempts], [false, 0, 1],
    'I-c-6 连不上 ⇒ `status=0`（"无响应"，不是伪装成一个 HTTP 状态码）');
  ok(!!rT.detail && rT.detail.length > 0,
    'I-c-7 ★传输失败的**如实原因**（`detail`）非空——不是只给调用方一个 `false`', String(rT.detail).slice(0, 70));
  ok(ansFailureNote(rT).startsWith('无响应'),
    'I-c-8 `ansFailureNote` 对"无响应"与"HTTP N"两态**分别措辞**（前者不以 `HTTP ` 开头）', ansFailureNote(rT));
}

function groupId(): void {
  console.log('\n【I-d】身份解析 `resolveAnsCreds` 真跑（DB → env → 缺省；一处真源）');
  type CredsDb = Parameters<typeof resolveAnsCreds>[0];
  type CredsEnv = Parameters<typeof resolveAnsCreds>[1];
  const fakeDb = (rows: Record<string, string>): CredsDb =>
    ({ prepare: () => ({ get: (k: string) => (k in rows ? { value: rows[k] } : undefined) }) }) as unknown as CredsDb;
  const EMPTY_ENV: CredsEnv = {} as CredsEnv;
  const envDecoy = { ANS_SERVER_URL: 'http://env-decoy:9', ANS_API_KEY: 'env-key', ANS_SECRET_KEY: 'env-secret' } as CredsEnv;

  eq(resolveAnsCreds(fakeDb({ ans_server_url: 'http://db:1', ans_api_key: 'db-k', ans_secret_key: 'db-s' }), envDecoy),
    { baseUrl: 'http://db:1', apiKey: 'db-k', secretKey: 'db-s' },
    'I-d-1 ★★DB 有值 ⇒ **DB 胜**（env 是兜底不是覆盖；两处顺序写反即是"配了不生效"）');
  eq(resolveAnsCreds(fakeDb({ ans_server_url: 'http://db:1', ans_api_key: 'db-k' }), envDecoy),
    { baseUrl: 'http://db:1', apiKey: 'db-k', secretKey: 'env-secret' },
    'I-d-2 ★**逐键**兜底：DB 缺的那一个键单独落 env（不是"有一个缺就整组回退"）');
  eq(resolveAnsCreds(fakeDb({}), EMPTY_ENV),
    { baseUrl: ANS_DEFAULTS.url, apiKey: ANS_DEFAULTS.apiKey, secretKey: ANS_DEFAULTS.secretKey },
    'I-d-3 DB 与 env 皆空 ⇒ `ANS_DEFAULTS`（注意键名映射：缺省里叫 `url`、对外叫 `baseUrl`——'
    + '两套名字写在**一处**，不是各处各自映射）');
  eq([ANS_DEFAULTS.url, ANS_DEFAULTS.apiKey, ANS_DEFAULTS.secretKey], [ANS_DEFAULT_BASE_URL, 'dev-key', 'dev-secret'],
    'I-d-4 缺省地址**派生自 shared-types 单一真源**（`ANS_DEFAULTS.url === ANS_DEFAULT_BASE_URL`，'
    + '不再与真源各留一份整串——旧的 `\'http://localhost:3001\'` 正是"改端口必失配"的哑雷）；'
    + 'apiKey/secretKey 与 `.env` 开发态身份一致');
  // 表还没建 / 库未就绪 ⇒ 退 env、**不抛**。否则启动早期一处读库失败会把整条链打断。
  const throwingDb = { prepare: () => { throw new Error('no such table: wa_settings'); } } as unknown as CredsDb;
  let threw = false;
  let got: AnsCreds | null = null;
  try { got = resolveAnsCreds(throwingDb, envDecoy); } catch { threw = true; }
  eq([threw, got], [false, { baseUrl: 'http://env-decoy:9', apiKey: 'env-key', secretKey: 'env-secret' }],
    'I-d-5 ★★`prepare` 抛 ⇒ 退 env、**不抛**（"读不到"≠"没有身份"，但也不许把启动打断）');
  const fallback = { baseUrl: ANS_DEFAULTS.url, apiKey: ANS_DEFAULTS.apiKey, secretKey: ANS_DEFAULTS.secretKey };
  eq([resolveAnsCreds(null, EMPTY_ENV), resolveAnsCreds(undefined, EMPTY_ENV)], [fallback, fallback],
    'I-d-6 无库句柄（`null`/`undefined`）⇒ 缺省——那是**合法输入**，不是异常');
  eq(resolveAnsCreds(fakeDb({ ans_secret_key: '' }), { ANS_SECRET_KEY: 'env-s' } as CredsEnv).secretKey, 'env-s',
    'I-d-7 ★空串**不算**"有值"（空 secret 签出的头必然不符——`registerToAns` 原先的 `secretKey || \'\'` 正是这个坑）');
  eq(resolveAnsCreds(fakeDb({ ans_secret_key: '' }), EMPTY_ENV).secretKey, 'dev-secret',
    'I-d-8 反证：空串最终落到**缺省**，而不是继续是空串');
}

function groupIe(): void {
  console.log('\n【I-e】记账上报：本就签名，失败不再无声（`exec-step`）');
  const es = RD(`${A}/src/main/core/exec-step.ts`);
  const blk = enclosingTry(es, "'/api/v1/billing/records'");
  ok(blk.length > 60 && blk.endsWith('}'),
    'I-e-0 ★切片自证：记账那一层 `try` 块非空且以 `}` 收口（否则下面几条是空转假绿）', `${blk.length} 字符`);
  ok(/ac\.post\?\.\('\/api\/v1\/billing\/records'/.test(blk),
    'I-e-1 记账仍走 `AnsClient.post?.(...)`（**签名路**，路径一字未换——本轮的改动只在失败的分支）');
  eq(/createLogger\('exec-step'\)/.test(es), true,
    'I-e-2 `exec-step` 有本模块 logger（`createLogger(\'exec-step\')`）——否则失败无处留痕');
  ok(/logger\.warn\(\{\s*error:[\s\S]{0,120}?'\[exec-step\] ANS 记账上报失败'/.test(blk),
    'I-e-3 ★失败经 `logger.warn` 留痕，且带**具体原因**（`error` 消息）与定位字段（model/tokens）——不是只说"失败了"');
  // ★ 反证的**正确形状**：切出 `.catch(` 后面那个**处理器括号块**本身，断言它**非空且真留痕**。
  //   为什么不写成"全块搜 `.catch(() => {})` 零命中"：本块**就有一行把旧写法写进注释**的订正说明，
  //   负面子串断言会被那句注释自己命中而**判红**（本仓记过这个坑：改完实现须回头改注释，
  //   而"负面子串断言被订正注释自己判红"是它必然会踩到的一面）。切处理器括号则与注释无关。
  const cIdx = es.indexOf('.catch(', es.indexOf("'/api/v1/billing/records'"));
  const handler = cIdx < 0 ? '' : blockAfter(es, es.indexOf('{', cIdx));
  ok(handler.length > 20 && /logger\.warn\(/.test(handler),
    'I-e-4 ★★记账失败的 `catch` 处理器**非空且真留痕**——旧写法就是同一个 `.catch(() => {})`：'
    + '一旦退回空处理器，本条即转红（判据咬的是**处理器括号**，与注释无关）', handler.replace(/\s+/g, ' ').slice(0, 80));
  eq(/^\{\s*\}$/.test(handler), false,
    'I-e-5 ★反证：处理器不是空块 `{}`（"记账恒失败也无人知"的最小形状）');
}

// ══════════════════════════════════════════════════════════════════
// 【J】M9 第二步：ANS 侧**真验签**（接线与契约；运行时往返在 ANS vitest）
// ══════════════════════════════════════════════════════════════════
//
// **分工如实（先读这段）**：本组**只做静态正证**，不 import `apps/ans-server` 的源码。
//   理由是本仓既有的约定（`rr_zx_20260924.ts` §M6 的"分工如实"）：rr 与 ANS 源码之间只保留
//   "读文本"这一种接触——`security.ts → pino + fs.mkdirSync(data/logs)`，一 import 就把 ANS 的
//   导入副作用带进回归进程。
//   而"桌面签出的字节串 ↔ ANS 认不认"这条链**两半各自成立**，合并即完整：
//     ① 桌面那一半（生产签名器 ↔ 生产验签器）＝ 本文件 I-b 组（真桩 + `verifyHmacSignature` 直引）；
//     ② ANS 那一半（生产验签器 ↔ 真 `hmacAuth` 挂真 Elysia）＝ `apps/ans-server/src/__tests__/hmac-auth.test.ts`；
//     ③ 两半会合处＝同一个模块导出的 `createHmacSignature`/`verifyHmacSignature`（`@worker-ant/ans-client`），
//        本组 J-c-7 钉"三处取的是同一个模块"，两侧都不是自造的等价物。
function groupJa(): void {
  console.log('\n【J-a】接线：验签真的接上了（读原文，锚点按语句形状）');
  const sec = RD('apps/ans-server/src/utils/security.ts');
  const fn = fnBodyByDecl(sec, 'export function hmacAuth');
  ok(fn.length > 200 && fn.endsWith('}') && fn.includes("request.headers.get('x-api-key')"),
    'J-a-0 ★切片自证：`hmacAuth` 函数体非空、以 `}` 收口、含其专属的 `x-api-key` 头读取'
    + '（否则以下几条是切空/切错的假绿）', `${fn.length} 字符`);

  // ★★ 靶心：`verifyHmacSignature` 曾是**只 import 不调用**的那一个（`x-signature` 因此是装饰）。
  //    四个实参**逐位**可比：明文 secret / 时间戳 / **请求体原文** / 收到的签名——顺序写错就是另一条路。
  const callArgs = (/verifyHmacSignature\(([\s\S]*?)\)/.exec(fn)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  eq(callArgs, 'secrets.plaintext, timestamp, rawBody, signature',
    'J-a-1 ★★★`hmacAuth` 真调用验签器，且四个实参**逐位**是 `(明文 secret, 时间戳, 请求体原文, 收到的签名)`'
    + '——这一条同时排除了"拿 `secret_hash` 当密钥"（旧实现正是把 sha256 当密钥返回）');
  ok(/import\s*\{[^}]*\bverifyHmacSignature\b[^}]*\}\s*from\s*'@worker-ant\/ans-client'/.test(sec),
    'J-a-2 验签器取自 `@worker-ant/ans-client`（与 `AnsClient.request`、与桌面真源同一把尺；ANS 侧不自造第二份 HMAC）');

  // 「请求体**原文**」这一路：捕获在 `onRequest`（唯一足够早的钩子），留存用 WeakMap（键即 Request，随对象回收），
  //   `derive` 里读它。**不能**在 `derive` 里 `request.clone().text()`——那时 Elysia 已消费过流，抛
  //   `Response body object should not be disturbed or locked`。
  ok(/const RAW_BODY = new WeakMap</.test(sec) && /onRequest\(async\s*\(\{\s*request\s*\}\)\s*=>/.test(fn)
    && /RAW_BODY\.set\(request[\s\S]{0,80}?request\.clone\(\)\.text\(\)/.test(fn),
    'J-a-3 ★★体原文在 `onRequest` 里用 `request.clone().text()` 捕获（只读副本，不动原流）');
  ok(/RAW_BODY\.get\(request\s+as\s+unknown\s+as\s+object\)/.test(fn),
    'J-a-4 ★`derive` 里取的是**同一个 Request 对象**作键的那份原文（不是"重新序列化一遍 parse 出来的对象"）');
  ok(/rawBody === undefined[\s\S]{0,200}?Unable to read request body/.test(fn),
    'J-a-5 取不到原文 ⇒ **拒绝**（fail-closed，不放过）——"验不了"不许读成"通过了"');

  // 五种失败**各自一句**文案；其中「secret 取不到明文」须在验签**之前**抛出。
  const msgs = [
    'Missing authentication headers', 'Invalid API key', 'Request timestamp expired',
    'API key secret unavailable for signature verification', 'Invalid signature',
  ];
  eq(msgs.filter((m) => fn.includes(m)).length, msgs.length,
    'J-a-6 ★五种失败**各自一句**（缺头 / key 不认 / 过期 / secret 取不到明文 / 签名不符）——'
    + '排查时这是五件事，合成一个 401 就只能靠猜');
  ok(fn.indexOf('API key secret unavailable for signature verification') < fn.indexOf('verifyHmacSignature('),
    'J-a-7 ★「secret 取不到明文」在验签**之前**抛出：这一条是**服务端自己的账**（旧行只有 sha256、不可逆），'
    + '与"调用方签错了"必须分得开——否则把"本仓该补一次密文回填"读成"对面签名错"');
  ok(/Math\.abs\(Date\.now\(\) - ts\)\s*>\s*300_000/.test(fn),
    'J-a-8 时间窗单独判一次（与验签器内部同口径），为的是**分得开**的错误文案');

  // 明文 secret 的来路：新列 + 解密 + 迁移。
  ok(/secret_enc TEXT DEFAULT ''/.test(sec),
    'J-a-9 `ApiKeyManager` 建表含 `secret_enc`（明文 secret 的密文列，AES-GCM）');
  ok(/INSERT INTO ans_api_keys \(id, key_prefix, secret_hash, secret_enc, name, resource_groups\)/.test(sec)
    && /encryptApiKey\(secret\)/.test(sec),
    'J-a-10 新建 Key 时把明文 secret **加密后**落 `secret_enc`（与 `secret_hash` 并存：一个给 HMAC，一个给 `verifySecret`）');
  const schemaSrc = RD('apps/ans-server/src/db/schema.ts');
  ok(/ALTER TABLE ans_api_keys ADD COLUMN secret_enc/.test(schemaSrc),
    'J-a-11 ★存量库迁移在册（`schema.ts`）——否则老库升级后每一条 Key 都"取不到明文"、恒 401 且看不出为什么');
  ok(/SELECT secret_hash, secret_enc FROM ans_api_keys/.test(fn),
    'J-a-12 取身份时**两列一起读**（只读 `secret_hash` 就是旧形状；只读 `secret_enc` 则 `verifySecret` 那把尺失效）');
  ok(/verifySecret\(apiKey: string, secret: string\)[\s\S]{0,400}?secret_hash === this\.hashSecret\(secret\)/.test(sec),
    'J-a-13 `verifySecret` 仍以 `secret_hash` 比对（**另一条路，刻意不动**）——两条尺各管各的，未混用');
}

function groupJb(): void {
  console.log('\n【J-b】生产真的挂上了（在 rr 里挂一遍能过 ≠ 生产挂上了）');
  const idx = RD('apps/ans-server/src/index.ts');
  /** 按符号切片：从 `from` 到下一个 `to`（与行号无关；`to` 是紧随其后的下一个声明）。 */
  const chunk = (from: string, to: string): string => {
    const a = idx.indexOf(from);
    if (a < 0) return '';
    const b = idx.indexOf(to, a);
    return b < 0 ? '' : idx.slice(a, b);
  };
  const apiGrp = chunk('const hmacApi = new Elysia()', 'const hmacManagement = new Elysia()');
  const mgmtGrp = chunk('const hmacManagement = new Elysia()', 'const app = new Elysia({ adapter: node() })');
  // zx_20261005 M21：`to` 由 `.listen(process.env.ANS_SERVER_PORT` 重定向到 `const ansPort = Number(`
  //   ——端口取值方式改了（单源 `ANS_DEFAULT_PORT` + 逃生口），旧标记已不存在；新标记紧随 `.use(hmacApi)`
  //   之后、仍**晚于**两个 `.use(...)`，故本组三条（J-b-0/1/2）判的仍是同一件事（顶层 app 真把两组挂上了）。
  const appChunk = chunk('const app = new Elysia({ adapter: node() })', 'const ansPort = Number(');
  eq([apiGrp.length > 200, mgmtGrp.length > 100, appChunk.length > 200], [true, true, true],
    'J-b-0 ★切片自证：三段都非空（空切片会让下面三条变成"零命中"式假绿）',
    `${apiGrp.length} / ${mgmtGrp.length} / ${appChunk.length} 字符`);
  eq([(apiGrp.match(/hmacAuth\(db\)/g) ?? []).length, (mgmtGrp.match(/hmacAuth\(db\)/g) ?? []).length], [1, 1],
    'J-b-1 两个受保护路由组各自**恰一次** `hmacAuth(db)`（网关/optimal 一组、资源管理 CRUD 一组）');
  eq([appChunk.includes('.use(hmacManagement)'), appChunk.includes('.use(hmacApi)')], [true, true],
    'J-b-2 ★★顶层 `app` 真把这两个组 `.use(…)` 了——「在 rr 里挂一遍能过」证的是插件本身能用，'
    + '**不等于**生产挂上了（判据的自我印证同族：只证明件、不证接线）');
  ok(apiGrp.includes("'/api/v1/models/optimal'"),
    'J-b-3 `/api/v1/models/optimal` 落在 `hmacAuth` 那一组内（本轮起它是**真**验签，不再只看 key）');
}

function groupJc(): void {
  console.log('\n【J-c】ANS 侧回归套件在册、且不自我印证');
  const TEST_F = 'apps/ans-server/src/__tests__/hmac-auth.test.ts';
  ok(fs.existsSync(path.join(root, TEST_F)), 'J-c-0 第二步的运行时往返套件在场', TEST_F);
  const t = fs.readFileSync(path.join(root, TEST_F), 'utf-8');
  ok(t.length > 2000, 'J-c-1 套件源码非空自证（否则以下几条是"空文件全过"）', `${t.length} 字节`);
  ok(/import \{ hmacAuth, encryptApiKey \} from '\.\.\/utils\/security\.js'/.test(t),
    'J-c-2 ★★引的是**生产** `hmacAuth`（不是夹具里手抄一份"等价物"——本仓 G-1，已复发两次）');
  ok(/import \{ Elysia \} from 'elysia'/.test(t) && /app\.handle\(/.test(t),
    'J-c-3 ★真 Elysia 挂真插件、`app.handle` 直投 `Request`：无端口、无网络、不依赖真实墙钟');
  ok(/const hashOf = \(s: string\): string => createHash\('sha256'\)\.update\(s\)\.digest\('hex'\)/.test(t)
    && /signed\(PREFIX, hashOf\(SECRET\)/.test(t),
    'J-c-4 ★★★含「拿 sha256 当密钥」的反证标本（`hashOf` 由 `createHash(\'sha256\')` 派生，'
    + '且**真拿去当密钥签了一次**——不是"提了一句"）——**旧实现（`getSecret` 返回 `secret_hash`）在这一条上恒为真**，'
    + '故它是活的判别器，不是自我印证');
  ok(/JSON\.stringify\(JSON\.parse\(raw\)\)/.test(t) && /expect\(renormalized\)\.not\.toBe\(raw\)/.test(t),
    'J-c-5 ★★含「验签前重新序列化」的反证标本，且**自证两条串确实不同**（否则那一对是空转）');
  eq(/createHmac\b/.test(t), false,
    'J-c-6 ★反证：套件内**零** `createHmac`——HMAC 只在生产实现里算；套件自己算一份就成了自我印证');
  const truthSrc = RD(`${A}/src/main/core/ans-signed-request.ts`);
  const sec = RD('apps/ans-server/src/utils/security.ts');
  eq([truthSrc, sec, t].map((s) => s.includes("from '@worker-ant/ans-client'")), [true, true, true],
    'J-c-7 ★★★两半会合处：桌面真源 / ANS 验签侧 / ANS 回归套件**三处都取同一个模块** '
    + '（`@worker-ant/ans-client` 的 `createHmacSignature`/`verifyHmacSignature`）——两侧共用一个签名口径，'
    + '不是各自实现一遍再互认');
  eq(fs.readdirSync(path.join(root, 'apps/ans-server/src/__tests__')).filter((f) => f.endsWith('.test.ts')).includes('hmac-auth.test.ts'),
    true, 'J-c-8 套件落在**既有的发现面上**（与其余 7 个 `.test.ts` 同目录 ⇒ vitest 会自动收集，无需注册）');
}

// ══════════════════════════════════════════════════════════════════
// 【K】M10 工具面与能力匹配（"在手，不等于上手"）
// ══════════════════════════════════════════════════════════════════

/**
 * 取 `decl` 处起的**实参括注块**（`(` … 配对的 `)`）。
 *
 * 为什么不能拿 `blockAfter` 凑合：`buildAttachmentParts(\n  items,\n  { transcribeAudio: … },\n  { modelCapabilities: … },\n)`
 * 的第一个 `{` 是**第二个实参**的类型字面量 ⇒ 切片会停在它上面，第三个实参根本不在里面，
 * 于是"新参数真的传下去了吗"那族断言会**全票通过而什么都没看**（假绿）。
 */
function argsByDecl(src: string, decl: string): string {
  const from = src.indexOf(decl);
  if (from < 0) return '';
  const open = src.indexOf('(', from);
  if (open < 0) return '';
  let d = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === '(') d++;
    else if (c === ')') { d--; if (d === 0) return src.slice(open, j + 1); }
  }
  return '';
}

/** K-b 夹具：真造一张 1×1 灰度 PNG（**不是**把文本改名成 `.png`——判型由产物本身定）。 */
function kPng(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 0; // 位深 8、颜色类型 0（灰度）
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 逐 chunk 复算 PNG 的 CRC 并走到**恰好收尾**（K-b-0 的夹具自证）。 */
function kPngChunks(png: Buffer): { types: string[]; crcOk: boolean; complete: boolean } {
  const types: string[] = [];
  let crcOk = true; let i = 8;
  while (i + 12 <= png.length) {
    const len = png.readUInt32BE(i);
    const body = png.subarray(i + 4, i + 8 + len);
    types.push(body.subarray(0, 4).toString('ascii'));
    if ((zlib.crc32(body) >>> 0) !== png.readUInt32BE(i + 8 + len)) crcOk = false;
    i += 12 + len;
  }
  return { types, crcOk, complete: i === png.length };
}

/** K-b 用的 io 桩：**盘上什么都不碰**（读到的字节由夹具给、尺寸闸交给"读后判"那道）。 */
function kIo(opts: { bytes?: Buffer; readThrows?: string; doc?: DocTextResult } = {}): Partial<InlineIo> {
  return {
    readFile: () => { if (opts.readThrows) throw new Error(opts.readThrows); return opts.bytes ?? Buffer.from('x'); },
    statSize: () => null,
    ...(opts.doc ? { extractDoc: () => opts.doc! } : {}),
  };
}

function groupKa(): void {
  console.log('\n【K-a】工具面：类目表一处真源 · 档内集由它派生 · ★注释与构造同真');
  const src = RD(`${A}/src/main/core/task-archetype.ts`);
  const cats = Object.keys(ARCHETYPE_TOOL_CATEGORIES) as TaskArchetype[];
  eq(cats.length, 6, 'K-a-0 六档在册（code/configuration/analysis/research/document/conversation）');

  // ① 底线四类：**由构造落地**，不是靠提示词里写一句"你有这些工具"（写进提示词、不过滤＝本轮病根）
  //    ⚠ zx_20261014_2 扩底（实机 E2E 后）：`device` 由"只给 code/configuration"升为**第四类底线**——
  //      短祈使句「打开客厅台灯」落 `conversation`，此前设备三件被收走 ⇒ 模型看不见、任务假完成。
  const base = ['readonly', 'control', 'resource', 'device'] as ToolCategory[];
  eq(cats.filter((c) => base.some((b) => !ARCHETYPE_TOOL_CATEGORIES[c].includes(b))), [],
    'K-a-1 ★★六档**全含** `readonly`/`control`/`resource`/`device`（底线由构造保证）。'
    + '此前 `document`/`conversation` 两档没有 `resource` ⇒ 用户明说"用那个技能 / 查一下模型 / 联网搜一下"时，'
    + '模型**连表达这个意图的工具都拿不到**——那不是"少省一点 token"，是结构性落空');

  // ② 档内集是**派生**的：类目过滤在册工具，逐件落到位（不是"表里字面写了类目"就算数）
  const resTools = toolRegistry.listNames().filter((n) => toolRegistry.getMeta(n)!.category === 'resource');
  eq(resTools.length, 10, 'K-a-2 前置：`resource` 类恰十件（方案 §2-M10 的清单同尺）', resTools.join(','));
  for (const c of ['document', 'conversation'] as TaskArchetype[]) {
    const got = new Set(availableToolNames(c));
    eq(resTools.filter((n) => !got.has(n)), [], `K-a-3 \`${c}\` 档的派生集**逐件**含 resource 十件`);
  }

  // ③ **该不命中**：放开 resource ≠ 放开一切
  const conv = new Set(availableToolNames('conversation'));
  eq(['write_file', 'execute_command', 'view_image', 'read_document'].filter((n) => conv.has(n)), [],
    'K-a-4 ★反证**另一侧**：对话档**仍不含** `write_file`/`execute_command`/`view_image`/`read_document`'
    + '（放开的是"找工具"，不是"写 / 跑 / 看图"——否则这条会被"干脆全放开"骗过）');
  eq([conv.has('write_file'), availableToolNames('code').includes('write_file')], [false, true],
    'K-a-5 同一把尺的对照组：`write_file` 在 `code` 档**确实**派得出来'
    + '（证明 K-a-4 不是"这个工具名根本不存在"所致的恒真）');

  // ④ ★注释与构造同真
  const from = src.indexOf('底线（M-B 反向可达性');
  const to = src.indexOf('export const ARCHETYPE_TOOL_CATEGORIES');
  const block = from >= 0 && to > from ? src.slice(from, to) : '';
  ok(block.length > 200, 'K-a-6 ★切片自证：底线注释块非空（空切片会让下面那条变成"零命中"式假绿）', `${block.length} 字符`);
  const vocab = new Set<string>(Object.values(ARCHETYPE_TOOL_CATEGORIES).flat());
  const named = [...new Set((block.match(/`([a-z_]+)`/g) ?? []).map((s) => s.slice(1, -1)).filter((w) => vocab.has(w)))].sort();
  const common = [...vocab].filter((c) => cats.every((a) => ARCHETYPE_TOOL_CATEGORIES[a].includes(c))).sort();
  // ⚠ zx_20261014_2 重定向（承 feedback_retarget_assertions_to_stronger_source）：期望集**派生自构造**，
  //   随 `device` 升底线自动变四类。若注释块漏点名 `device`，本条当场红——这正是它要守的"注释与构造同真"。
  eq([named, common], [['control', 'device', 'readonly', 'resource'], ['control', 'device', 'readonly', 'resource']],
    'K-a-7 ★★★注释里点名的**类目** == 六档**共有**的类目集（zx_20261014_2 后为四类底线）。两边都是**派生**的：'
    + '表动了而注释不动，注释就是假的（"注释必须与构造同真"——本仓已见多次"注释说一套、代码做另一套"）');
}

async function groupKb(): Promise<void> {
  console.log('\n【K-b】能力闸：非视觉模型不再收到图片（真 `buildAttachmentParts`）');
  const png = kPng();
  // ① 夹具自证：这次拦下的**真是一件图片**，不是一段改名成 .png 的文本
  const ck = kPngChunks(png);
  eq([ck.types, ck.crcOk, ck.complete], [['IHDR', 'IDAT', 'IEND'], true, true],
    'K-b-0 ★夹具自证：真 PNG（chunk 序 + 逐 chunk CRC 复算 + 恰好收尾）。'
    + '⚠ 复算用的原语（`zlib.crc32`）与构造用的是同一个——这里要证的是**夹具形状**，不是这个原语本身。');

  const P = '/tmp/m10/probe.png';
  const item = [{ path: P, fileName: 'probe.png' }];

  // ② **该命中**：清单在场且不含 `vision` ⇒ 图片不进 parts
  const hit = await buildAttachmentParts(item, kIo({ bytes: png }), { modelCapabilities: ['chat', 'reasoning'] });
  eq([hit.parts.some((x) => x.type === 'image'), hit.outcomes[0].status], [false, 'omitted'],
    'K-b-1 ★该命中：清单不含 `vision` ⇒ parts 里**没有** image —— 此前无条件 push，'
    + '非视觉模型收到 `image_url`：要么 400 整轮白跑，要么白烧 token 还什么都没看见');
  eq([hit.outcomes[0].reason, 'bytes' in hit.outcomes[0]], ['model_lacks_vision', false],
    'K-b-2 `reason` 点名真因；`bytes` **压根不给**（`\'bytes\' in outcome === false`）——'
    + '没读过盘就不许说它多大（"能说出为什么"不等于"能编一个数"）。'
    + '⚠ 用 `in` 而不是 `=== undefined`：后者与 `bytes: null` 不可分（`JSON.stringify` 把两者都写成 `null`），'
    + '而"没有这个数"与"这个数是空"是两件事');
  ok(hit.outcomes[0].marker.includes('probe.png') && hit.outcomes[0].marker.includes('vision'),
    'K-b-3 给模型看的那句话点名**件名**与 **vision**（用户拿到的是"哪一张、为什么"，不是一句笼统的"附件未内联"）');
  ok(hit.parts.some((x) => x.type === 'text' && x.text.includes('1 张')),
    'K-b-4 总数一句在场（"已跳过 N 张"）');

  // ③ **该不命中**①：清单含 vision ⇒ 逐位回旧行为
  const okv = await buildAttachmentParts(item, kIo({ bytes: png }), { modelCapabilities: ['chat', 'vision'] });
  eq([okv.parts.some((x) => x.type === 'image'), okv.outcomes[0].status], [true, 'inlined'],
    'K-b-5 ★该不命中：清单含 `vision` ⇒ 图片照旧内联（与 K-b-1 同一份夹具、同一路径，'
    + '差别**只可能**来自清单本身 ⇒ A/B 成立）');

  // ④ **该不命中**②：**不传清单** ⇒ 不设闸
  const nolist = await buildAttachmentParts(item, kIo({ bytes: png }));
  eq([nolist.parts.some((x) => x.type === 'image'), nolist.outcomes[0].status], [true, 'inlined'],
    'K-b-6 ★该不命中：清单**缺席** ⇒ **不设闸**（旧 ANS / 旧账不带清单）。'
    + '"无从比对"不是"不具备"——替它断言一句我们并不知道的话，与"不编『不符』"是同一条尺的反面');

  // ⑤ ★闸在**读盘之前**（不送进去的东西不必读、更不必降质）
  let reads = 0;
  const ioThrow: Partial<InlineIo> = { readFile: () => { reads++; throw new Error('ENOENT'); }, statSize: () => null };
  const early = await buildAttachmentParts([{ path: '/tmp/m10/不存在.png', fileName: '不存在.png' }], ioThrow, { modelCapabilities: [] });
  eq([early.outcomes[0].reason, reads], ['model_lacks_vision', 0],
    'K-b-7 ★★闸在**读盘之前**：一个读不到的路径，出的仍是 `model_lacks_vision` 而**不是** `read_failed`，'
    + '且 `readFile` 一次都没被调（换了位置这条就红）');

  // ⑥ 两件 ⇒ 总数说"2 张"，且在**逐件之前**
  const two = await buildAttachmentParts(
    [{ path: '/tmp/m10/a.png', fileName: 'a.png' }, { path: '/tmp/m10/b.png', fileName: 'b.png' }],
    kIo({ bytes: png }), { modelCapabilities: ['chat'] });
  const txt = (two.parts.find((x) => x.type === 'text') as { text: string } | undefined)?.text ?? '';
  const iAgg = txt.indexOf('2 张'); const iOne = txt.indexOf('a.png');
  ok(iAgg >= 0 && iOne >= 0 && iAgg < iOne,
    'K-b-8 ★★总数一句在**逐件之前**：预算先切的正是首位 ⇒ 件多到被截断时，"因为看不见"这件事仍说得出来；'
    + '否则只剩"[另有 M 件未逐条列出]"，把"模型看不到"与"超限 / 读不了"混成一件');

  // ⑦ 非图族不受闸（反证的**另一侧**：别被"无 vision 就什么都不给"骗过）
  const doc = await buildAttachmentParts(
    [{ path: '/tmp/m10/n.txt', fileName: 'n.txt' }],
    kIo({ bytes: Buffer.from('M10-DOC-BODY'), doc: { ok: true, text: 'M10-DOC-BODY', truncated: false } }),
    { modelCapabilities: ['chat'] });
  eq([doc.outcomes[0].status, doc.parts.some((x) => x.type === 'text' && x.text.includes('M10-DOC-BODY'))], ['inlined', true],
    'K-b-9 ★同一份不含 `vision` 的清单下，`.txt` 文档**仍照旧内联**——闸只拦图片族');
}

function groupKc(): void {
  console.log('\n【K-c】选型侧：换路收进一处 · ★闸读**换路之后**的清单（读原文 G-5，锚点按符号）');
  const src = RD(`${A}/src/main/core/exec-model-select.ts`);
  const swap = fnBodyByDecl(src, 'const applySwap = (hop: EndpointHop, apiKeyPolicy:');
  ok(swap.length > 200, 'K-c-0 ★切片自证：`applySwap` 函数体非空（空切片 ⇒ 下面几条变成"零命中"式假绿）', `${swap.length} 字符`);

  ok(/apiKeyPolicy === 'reuse' \? modelResult\.api_key : ''/.test(swap),
    "K-c-1 ★两态差别提成**必填参数**（`'reuse'|'drop'` 在同一行显式分派）。"
    + '此前 `sdk_fallback` 自己写一份四行、其余三处共用一份，两份**唯一**的差别是"这一跳没带钥匙时怎么办"，'
    + '而那个差别**一句注释都没有**——靠"两份相似代码的偶然不一致"承载一条真结论，读的人看不出哪个是有意的');
  ok(/if \(Array\.isArray\(hop\.capabilities\)\) modelResult\.capabilities = hop\.capabilities;\s*\n\s*else delete modelResult\.capabilities;/.test(swap),
    'K-c-2 `capabilities` **随跳走**（缺席即 `delete`：不留旧模型的能力去替新模型说话）');

  // zx_20261022_3 批六（知行合一）: **换路点数不变、可用性两支合流**——tier2/tier3 现在先比能力挑候选，
  //   再经**同一处** `applySwap(chosen.hop, 'reuse')` 换路（此前各写一次 `'reuse'`）。
  //   故按**符号形状**钉死：四个换路点、`'drop'` 只归账户级故障、可用性路恰两处 `'reuse'`。
  eq((src.match(/applySwap\(/g) ?? []).length, 3,
    "K-c-3a **三个换路调用点**（sdk_fallback / 可用性备用 / 上下文升级）共走一处实现（`const applySwap = (` 定义不计数）");
  eq((src.match(/applySwap\([^)]*'drop'\)/g) ?? []).length, 1,
    "K-c-3b `sdk_fallback` 恰一次 `'drop'`（换的是**另一家** provider，旧钥匙属于那个触发账户级故障的**坏账户**，带过去只会再失败一次）");
  eq((src.match(/applySwap\([^)]*'reuse'\)/g) ?? []).length, 2,
    "K-c-3c 可用性路恰两处 `'reuse'`：候选备用（tier2/tier3 合流处）+ 上下文升级");
  ok(/const chosen = capable \?\? cands\[0\];[\s\S]{0,80}applySwap\(chosen\.hop, 'reuse'\)/.test(src),
    "K-c-3d ★tier2/tier3 **不再各换一次**：候选先比能力、再由同一处换路（偏好只排序，不另立第二道关）");

  const iLastSwap = src.lastIndexOf('applySwap(');
  const iCaps = src.indexOf('const finalCaps = compareModelCapabilities(modelCaps, modelResult);');
  ok(iLastSwap > 0 && iCaps > iLastSwap,
    'K-c-4 ★★能力闸的读点在**所有换路之后**：`finalCaps` 赋值下标 > 最后一次 `applySwap(` 下标。'
    + '`applySwap` 起 `capabilities` 就随跳走 ⇒ 这里读到的才是**实际在用**的模型；'
    + '在换路之前读 = 拿旧模型的答案评新模型（而"要不要把图送出去"问的正是**它**）');
  ok(/modelCapabilities: finalCaps\?\.got \?\? null/.test(src),
    'K-c-5 回传的是**原始清单**（`?? null` = 回包没带能力清单），不是这里合成的一个布尔：'
    + "合成 `[]`/`['vision']` 就是在有名有姓的值里编造内容，而真清单此刻**就在手边**（`finalCaps.got`）");
  ok(/modelCapabilities: string\[\] \| null;/.test(src),
    'K-c-6 `ModelSelectPicked.modelCapabilities` 的声明形状与回传值同形（类型不许漂）');
}

function groupKd(): void {
  console.log('\n【K-d】接线：新参数**真的**被传下去（"只建接口不接，全量回归照样全绿"）');
  const src = RD(`${A}/src/main/core/agent-executor.ts`);
  const args = argsByDecl(src, 'await buildAttachmentParts(');
  ok(args.length > 80, 'K-d-0 ★切片自证：`buildAttachmentParts(` 的**整份实参**非空', `${args.length} 字符`);
  ok(/modelCapabilities: modelCapabilities \?\? undefined/.test(args),
    'K-d-1 ★★第三个实参**在场**且形为 `{ modelCapabilities: … }`——只加参数不传，闸永不触发，'
    + '而全量回归仍全绿（本仓『等价性证不了接上了』的老病）');
  ok(/const modelCapabilities = modelPick\.modelCapabilities;/.test(src),
    'K-d-2 值取自**选型结果**（`modelPick.modelCapabilities`）——不是在这里另算一份、更不是写死一个空清单');
  ok(/modelCapabilities \?\? undefined/.test(args) && /`null`（回包没带清单）转 `undefined`/.test(src),
    'K-d-3 `null` → `undefined`：清单缺席 ⇒ **不设闸**（与装配层同一条尺）。'
    + '若图省事写成 `?? []`，就把"无从比对"静默变成"不具备"——反方向的另一种编造');
}

function groupKe(): void {
  console.log('\n【K-e】MCP 缓存：TTL 管的是**这份清单有多旧**（读原文 G-5）');
  const src = RD(`${A}/src/main/core/mcp-client-pool.ts`);
  const body = fnBodyByDecl(src, 'function cleanExpired()');
  ok(body.length > 50, 'K-e-0 ★切片自证：`cleanExpired` 函数体非空', `${body.length} 字符`);
  ok(/now - entry\.createdAt > CACHE_TTL/.test(body),
    'K-e-1 ★★按**条目年龄**（`createdAt`）失效。此前按 `lastSuccessAt` 判，而它在**每次成功调用**时被刷新 ⇒'
    + '**越活跃的服务越不会过期**：一个天天在调的服务，工具清单可以几十天不刷新，'
    + '服务端新加的工具**结构性看不见**——而这正是本函数唯一的存在理由'
    + '（唯一的补救原是撞 `-32601` 后刷新一次，可那要求调用方先**知道名字**去调一个它看不见的工具：闭环不成立）');
  eq(/lastSuccessAt/.test(body), false,
    'K-e-2 ★反证：`cleanExpired` 体内**零** `lastSuccessAt`（两处都在 ⇒ 取值由"哪句后写"决定，判据自欺）');

  const iface = blockAfter(src, src.indexOf('interface CachedMcpClient'));
  ok(iface.length > 80, 'K-e-3 ★切片自证：`CachedMcpClient` 接口块非空', `${iface.length} 字符`);
  eq(/lastSuccessAt/.test(iface), false,
    'K-e-4 ★反证：接口里**已删掉** `lastSuccessAt` 字段。改以 `createdAt` 判失效后它就成了**只写不读**的死状态，'
    + '留着就是"看起来在记账、其实没人看"（本仓对"虚账"的老毛病）');

  eq(walkTs(`${A}/src/main`).filter((f) => codeLines(f).some((l) => l.includes('lastSuccessAt'))), [],
    'K-e-5 ★★全 `src/main` **代码行**内零命中：不是一个字段两处状态，而是这个词**彻底不在册**'
    + '（注释里说明它的来历与删除理由是可以的——那是判据要求的信息，滤掉整行注释即可区分）');

  ok(/cleanExpired\(\);\s*\n\s*const endpoint = await resolveEndpointFor/.test(src),
    'K-e-6 ★「活跃服务也在一个 TTL 后失效」的机制在**取连接的第一跳**：`getOrConnect` 先 `cleanExpired()` 再解析端点'
    + '（条目被清 ⇒ 缓存未命中 ⇒ 重连并重取 `tools/list`）。故不需要额外的"显式刷新"入口，'
    + '`refreshMcpTools` 仍是撞 `-32601` 时的那条补救路');
}

const KF_SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL,
  name TEXT DEFAULT '', description TEXT DEFAULT '', file_path TEXT, registry_id TEXT,
  status TEXT DEFAULT 'draft', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
`;
function kfDb(ansUrl: string): AnyDb {
  const db = new DatabaseSync(':memory:') as unknown as AnyDb;
  db.exec(KF_SCHEMA);
  const set = db.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)');
  set.run('ans_server_url', ansUrl); set.run('ans_api_key', 'k'); set.run('ans_secret_key', 's');
  return db;
}
const kfAddProj = (db: AnyDb): void => {
  db.prepare("INSERT INTO wa_deliverables (id, project_id, type, name, status) VALUES ('d1','p1','mcp','proj-svc','draft')").run();
};
/** 真 MCP 服务桩：`tools/list` 的 JSON-RPC 应答（`listMcpTools` 走的正是这条路）。 */
const kfToolsList = (names: string[]): string => JSON.stringify({
  result: { tools: names.map((n) => ({ name: n, description: '', inputSchema: { properties: {} } })), serverInfo: {} },
});
/** 一个桩同时扮两个角色：ANS 注册表端点 + 各 MCP 服务端点（由路径分派）。 */
function kfHandler(regs: Array<{ name: string; status?: string }>, tools: Record<string, string[]>, failAt = 0) {
  return (p: string): { status: number; body?: string } => {
    if (failAt) return { status: failAt, body: '{"error":"boom"}' };
    if (p.startsWith('/api/v1/mcp')) return { status: 200, body: JSON.stringify({ data: regs }) };
    const m = /^\/mcp\/([^/?]+)/.exec(p);
    if (m) return { status: 200, body: kfToolsList(tools[decodeURIComponent(m[1])] ?? []) };
    return { status: 404, body: '{}' };
  };
}

async function groupKf(): Promise<void> {
  console.log('\n【K-f】MCP 可见面：项目交付物 + ANS 注册表（真 `resourceTools` × 真 ANS 桩）');
  const run = async (db: AnyDb) => JSON.parse(
    await resourceTools({ db, projectId: 'p1' } as unknown as Parameters<typeof resourceTools>[0])
      .find_mcp_service.execute({}) as string,
  ) as { services?: Array<Record<string, unknown>>; ansRegistered?: Array<Record<string, unknown>>; note?: string; ansNote?: string; hint?: string };

  // ① 三态：项目交付物（ANS 也注册了）/ 仅 ANS 注册 / 同名不两现 / 探得到工具
  {
    const stub = await ansStub(kfHandler(
      [{ name: 'proj-svc', status: 'active' }, { name: 'ans-only', status: 'active' }],
      { 'proj-svc': ['t1'], 'ans-only': ['t1'] }));
    try {
      const db = kfDb(stub.url); kfAddProj(db);
      const out = await run(db);
      eq(stub.captured.some((c) => c.path.startsWith('/api/v1/mcp')) && stub.captured.some((c) => c.path.startsWith('/mcp/')),
        true, 'K-f-0 ★夹具自证：桩**真被访问过**（注册表端点 + 服务端点各至少一次）——否则下面几条是"零请求全过"',
        stub.captured.map((c) => c.path).join(' , '));
      const s0 = out.services?.[0] ?? {};
      eq([s0.name, s0.ansRegistered, s0.ansStatus], ['proj-svc', true, 'active'],
        'K-f-1 项目交付物认出"**这个服务 ANS 里也注册了**"（此前这一格没有：看不见自己项目的服务在 ANS 的状态）');
      const ar = out.ansRegistered ?? [];
      eq([ar.length, ar[0]?.name, ar[0]?.notProjectDeliverable], [1, 'ans-only', true],
        'K-f-2 ★**仅 ANS 注册**（本项目无对应交付物）的服务单列一栏并标 `notProjectDeliverable`——'
        + '它们此前**既列不出、也无从想到**，而 `call_mcp_tool` 一直是经 ANS 网关**按名字**调的，本来调得动');
      eq([ar[0]?.toolCount, ar[0]?.tools], [1, ['t1']],
        'K-f-3 ★★**可见即可用**：那一栏也**真探了工具表**（不是只报个名字）——'
        + '报名字只解决"知道有"，探到工具才让它这一步就能直接用');
      eq(ar.filter((x) => x.name === 'proj-svc'), [],
        'K-f-4 ★★**同名不两现**：已在项目交付物那一栏出现的服务，从"仅 ANS"那栏里摘掉'
        + '（同一件东西在两栏各说一遍，读的人会当成两个服务）');
    } finally { await stub.close(); }
  }

  // ② 查失败**绝不静默当"没有"**
  {
    const stub = await ansStub(kfHandler([], {}, 500));
    try {
      const db = kfDb(stub.url); kfAddProj(db);
      const out = await run(db);
      ok(typeof out.ansNote === 'string' && out.ansNote.includes('查询失败'),
        'K-f-5 ★★ANS 注册表**没查成**（500）⇒ 如实带 `ansNote` 出去，且话里明说"**不代表 ANS 里没有别的 MCP**"'
        + '（"没查成"与"确实没有"是两件事，混成一个空列表就等于替 ANS 说了句我们并不知道的话）');
      eq([out.services?.length, out.services?.[0]?.name], [1, 'proj-svc'],
        'K-f-6 ★反证**另一侧**：注册表查失败**不影响**项目交付物那一栏照列（失败不许吞掉已知的部分）');
    } finally { await stub.close(); }
  }

  // ③ 空态**两态可分**（同一句话不许同时盖住"没查成"与"确无"）
  {
    const stubOk = await ansStub(kfHandler([], {}));
    const stubBad = await ansStub(kfHandler([], {}, 500));
    try {
      const a = await run(kfDb(stubOk.url));
      const b = await run(kfDb(stubBad.url));
      ok(typeof a.hint === 'string' && a.hint.includes('确无') && !a.ansNote,
        'K-f-7 ★空态之一：ANS 注册表**查成了、确实空** ⇒ hint 说 "确无"', a.hint);
      ok(typeof b.hint === 'string' && b.hint.includes('没查成') && typeof b.ansNote === 'string',
        'K-f-8 ★★空态之二：ANS 注册表**没查成** ⇒ hint 说 "没查成"（两态用词不同 ⇒ 用户据此知道该去修 ANS 还是该去建服务）',
        b.hint);
    } finally { await stubOk.close(); await stubBad.close(); }
  }
}

// ══════════════════════════════════════════════════════════════════
// 【L】M11 · 调度账实（并发原子闸 / 悬空子收敛 / 看门狗归一 / 「不扫」的理由上桌）
// ══════════════════════════════════════════════════════════════════

/**
 * L 组夹具：一张能**真跑** `claimTaskForExecution` / `scanReadyTasks` / `reconcileStalledSubtasks`
 * 的最小世界（列照抄 `database.ts` DDL，NOT NULL 不省；自愈日志表直接引生产建表语句，不手抄）。
 */
const L_SCHEMA = `
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active', context_json TEXT DEFAULT '{}', working_dir TEXT);
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, parent_task_id TEXT DEFAULT '', title TEXT NOT NULL,
  description TEXT DEFAULT '', status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '');
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT, payload TEXT, status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')), started_at TEXT, completed_at TEXT, scheduled_at TEXT, error TEXT);
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT, content TEXT,
  token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
` + SELF_HEALING_LOGS_DDL;

function ldb(): AnyDb { const d = new DatabaseSync(':memory:') as unknown as AnyDb; d.exec(L_SCHEMA); return d; }

function lProj(db: AnyDb, id: string, status: string, rhythm?: Record<string, unknown>, workingDir = ''): void {
  // 生产读的是 `context_json.rhythm.*`（`resolveProjectConcurrencyLimit` / `activeHourWindow`），
  // 故这里把节律包进 `rhythm` 一层——直接平铺会静默回退默认值（上限读成 3、窗口读成无限制）。
  db.prepare('INSERT INTO wa_projects (id, name, status, context_json, working_dir) VALUES (?, ?, ?, ?, ?)')
    .run(id, id, status, JSON.stringify(rhythm ? { rhythm } : {}), workingDir);
}
function lTask(db: AnyDb, o: {
  id: string; project?: string; status: string; parent?: string; deps?: string;
  ctx?: Record<string, unknown>; ageMin?: number; priority?: number;
}): void {
  const age = o.ageMin ? `datetime('now','-${o.ageMin} minutes')` : `datetime('now')`;
  db.prepare(`INSERT INTO wa_tasks (id, project_id, parent_task_id, title, status, context_json, updated_at, priority, depends_on)
    VALUES (?, ?, ?, ?, ?, ?, ${age}, ?, ?)`)
    .run(o.id, o.project ?? 'p1', o.parent ?? '', `T-${o.id}`, o.status, JSON.stringify(o.ctx ?? {}), o.priority ?? 0, o.deps ?? '');
}
const lStatus = (db: AnyDb, id: string) => (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;
const lCtxOf = (db: AnyDb, id: string) => JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json || '{}') as Record<string, unknown>;
const lConvs = (db: AnyDb, id: string) =>
  (db.prepare('SELECT content FROM wa_task_conversations WHERE task_id = ? ORDER BY rowid').all(id) as Array<{ content: string }>).map((r) => r.content);
const lJobs = (db: AnyDb) => db.prepare('SELECT type, payload FROM wa_jobs ORDER BY rowid').all() as Array<{ type: string; payload: string }>;
/** 造一张作业行——M11-2「该不命中」的标本之一是"子已有在途作业"。 */
function lJob(db: AnyDb, type: string, taskId: string, status = 'pending'): void {
  db.prepare('INSERT INTO wa_jobs (id, type, payload, status) VALUES (?, ?, ?, ?)')
    .run(`j-${taskId}-${type}-${status}`, type, JSON.stringify({ taskId }), status);
}

// ── L-a · M11-1 并发原子化（check-then-act 两跳 ⇒ 单语句原子闸）────────────────
function groupLa(): void {
  console.log('\n【L-a】M11-1 项目并发闸**并进那条 UPDATE**（判据与写入由 SQLite 单语句原子性兜住）');

  // ① 守卫片段真跑：把生产返回的 SQL 当 WHERE 求值（不是等价自造）
  const db = ldb();
  lProj(db, 'p1', 'active');
  lTask(db, { id: 'e1', status: 'executing' });
  lTask(db, { id: 'e2', status: 'preparing' });
  const evalGuard = (limit: number, exclude?: string): boolean => {
    const g = projectSlotGuard('p1', limit, exclude === undefined ? {} : { excludeTaskId: exclude });
    const row = db.prepare(`SELECT (${g.sql}) AS v`).get(...g.params) as { v: number };
    return row.v === 1;
  };
  eq([evalGuard(2), evalGuard(3)], [false, true],
    'L-a-1 ★守卫片段**真跑**：占位 2/限 2 ⇒ 关闸；占位 2/限 3 ⇒ 开闸（判据读的是真行数，不是快照）');
  eq([evalGuard(2, 'e2'), evalGuard(2, 'e1')], [true, true],
    'L-a-2 ★★`excludeTaskId` 排掉自己：2 占位里含"本任务"时**仍放行**——'
    + '漏了这一排，"本任务已在占位态"这一**合法**输入会被判满员（判据须能被合法数据满足）');
  eq([evalGuard(3, 'nope'), evalGuard(2, 'nope')], [true, false],
    'L-a-3 反证：排一个**不在占位集内**的 id 不改变余量（排除只对"自己那一票"生效，不是无条件放宽）');
  {
    const a = projectSlotGuard('p1', 2);
    const b = projectSlotGuard('p1', 2, { excludeTaskId: 'e1' });
    eq([a.sql.split('?').length - 1, a.params.length], [a.params.length, a.params.length],
      'L-a-4 占位符个数与参数个数**同函数返回**且逐位相等（调用方只需 `run(...前段, ...guard.params)`，不会错位）');
    eq(a.params, ['p1', ...PROJECT_RUNNING_STATUSES, 2],
      'L-a-5 ★状态集取自 `PROJECT_RUNNING_STATUSES` 真源（`planning/preparing` 也算占位——'
      + '只数 `executing` 正是"软闸判位子空着而超发"的病根）');
    eq([b.params.length - a.params.length, b.params[b.params.length - 2]], [1, 'e1'],
      'L-a-6 带排除时**恰多一个**参数，且它是被排除的那个 id（多一个少一个都会静默按错的值开闸）');
  }

  // ② 上限只读那一半：四档取值（脏配置一律回退默认，不把项目卡死）
  //   zx_20261005 M7（管子·度量衡 / 维特根斯坦·同一把尺）: 自配上限之上再压一层**档位天花板**
  //   （`clampConcurrency`）。故四档须在**专业版档位**下验"自配值原样生效"——档位靠 `license.trial_started_at`
  //   注入、墙钟钉死（G-4：试用剩余天数天天变，不钉则判据随墙钟翻红）。
  const L_NOW = new Date('2026-10-05T00:00:00.000Z');
  // `wa_settings` 不在 `L_SCHEMA` 里（其余 L 组断言不碰它）——**按需本地建**，只影响本块两批标本。
  const lSettings = (d: AnyDb): void => {
    d.exec('CREATE TABLE IF NOT EXISTS wa_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)');
  };
  const lTrial = (d: AnyDb): void => {
    lSettings(d);
    d.prepare("INSERT OR REPLACE INTO wa_settings (key, value) VALUES ('license.trial_started_at', ?)")
      .run(new Date(L_NOW.getTime() - 3_600_000).toISOString()); // 1 小时前起算 ⇒ 试用第 1 天（＝专业版）
  };
  eq([
    (() => { const d = ldb(); lProj(d, 'a', 'active', { maxConcurrency: 5 }); lTrial(d); return resolveProjectConcurrencyLimit(d, 'a', { now: L_NOW }); })(),
    (() => { const d = ldb(); lProj(d, 'a', 'active'); lTrial(d); return resolveProjectConcurrencyLimit(d, 'a', { now: L_NOW }); })(),
    (() => { const d = ldb(); lProj(d, 'a', 'active', { maxConcurrency: 0 }); lTrial(d); return resolveProjectConcurrencyLimit(d, 'a', { now: L_NOW }); })(),
    (() => { const d = ldb(); d.prepare("INSERT INTO wa_projects (id, name, status, context_json) VALUES ('a','a','active','{oops')").run(); lTrial(d); return resolveProjectConcurrencyLimit(d, 'a', { now: L_NOW }); })(),
  ], [5, PROJECT_CONCURRENCY_DEFAULT, PROJECT_CONCURRENCY_DEFAULT, PROJECT_CONCURRENCY_DEFAULT],
    'L-a-7 上限四档（**专业版档位**，天花板 8）：设了取它 / 未设·0·坏 JSON 一律回 `PROJECT_CONCURRENCY_DEFAULT`'
    + '（期望值由真源常量派生，不是抄来的数；档位与墙钟均注入）');

  // ②b ★★ 档位天花板（zx_20261005 M7 新尺）：**同一批自配值、换community档位** ⇒ 尺真的在量（G-2 两分标本）。
  //   社区版（无许可无试用）天花板 3：自配 5/10 被钳到 3（只降不升），自配 2 比天花板保守 ⇒ 仍取 2（尊重用户意图）。
  eq([
    (() => { const d = ldb(); lProj(d, 'a', 'active', { maxConcurrency: 5 }); lSettings(d); return resolveProjectConcurrencyLimit(d, 'a'); })(),
    (() => { const d = ldb(); lProj(d, 'a', 'active', { maxConcurrency: 2 }); lSettings(d); return resolveProjectConcurrencyLimit(d, 'a'); })(),
    (() => { const d = ldb(); lProj(d, 'a', 'active', { maxConcurrency: 10 }); lSettings(d); return resolveProjectConcurrencyLimit(d, 'a'); })(),
  ], [3, 2, 3],
    'L-a-7b ★★社区版天花板：自配 5→3、10→3（**只降不升**），自配 2 比天花板还保守 ⇒ 仍取 2'
    + '（档位是**天花板**不是设定值——min 而非"直接取档位值"）');

  // ③ ★★ 认领那条 CAS **从生产源码里切出来真跑**（不是在这里另写一条等价 UPDATE）
  const claimSrc = RD(`${A}/src/main/core/exec-claim.ts`);
  // zx_20261018_3 批四（改钉更强非放宽）：批四把**机器闸**并入同一条 UPDATE，模板不再以 `guard.sql` 收尾。
  //   原锚点 `...AND ${guard.sql})` 会取不到 ⇒ 改取**整条**模板，并钉「项目闸 + 机器闸同在这一条 WHERE 里」
  //   （拆成两条 UPDATE 就退化成 check-then-act，两把尺之间的窗口会让并发超额）。
  const tmplM = /`(UPDATE wa_tasks SET status = 'executing'[\s\S]*?)`/.exec(claimSrc);
  ok(!!tmplM, 'L-a-8 扫描面自证：从 `exec-claim.ts` 里取到了那条 CAS 模板（取不到的话下面就是在证明另一条语句）');
  const tmpl = tmplM?.[1] ?? '';
  ok(/status IN \('pending','paused','preparing','running'\)/.test(tmpl),
    'L-a-8b 模板的可抢占集合逐值在册（`running` 缺了就是 GUI「执行」后永久僵尸那笔旧账复发）');
  ok(/\$\{guard\.sql\}[\s\S]*AND \$\{machineGuard\.sql\}/.test(tmpl),
    'L-a-8c ★项目闸与机器闸**同一条语句**（两把尺在同一原子 UPDATE 里取严，不留 check-then-act 窗口）');
  {
    const d = ldb(); lProj(d, 'p1', 'active');
    lTask(d, { id: 'e1', status: 'executing' });
    lTask(d, { id: 'new', status: 'pending' });
    const mOpen = machineSlotGuard(99, { excludeTaskId: 'new' });
    const gFull = projectSlotGuard('p1', 1, { excludeTaskId: 'new' });
    const full = d.prepare(tmpl.replace('${guard.sql}', gFull.sql).replace('${machineGuard.sql}', mOpen.sql)).run('new', ...gFull.params, ...mOpen.params) as { changes: number };
    const gOpen = projectSlotGuard('p1', 2, { excludeTaskId: 'new' });
    const open = d.prepare(tmpl.replace('${guard.sql}', gOpen.sql).replace('${machineGuard.sql}', mOpen.sql)).run('new', ...gOpen.params, ...mOpen.params) as { changes: number };
    eq([full.changes, open.changes], [0, 1],
      'L-a-9 ★★同一条生产语句：满员（1/限1）⇒ **0 行**；有空位（1/限2）⇒ **1 行**并落到 `executing`'
      + '（0→1 正面断言——WHERE 全合一的语句不许用"不抛"当证据）');
    eq(lStatus(d, 'new'), 'executing', 'L-a-10 放行那一侧真落了状态（0 行/1 行之外还要看它变成了什么）');
  }

  // ④ ★★ 真跑 `claimTaskForExecution`：两种拒因**可分辨**（此前同形，处置却相反）
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr630-claim-'));
  try {
    const dFull = ldb();
    lProj(dFull, 'p1', 'active', { maxConcurrency: 1 }, path.join(dataDir, 'w1'));
    lTask(dFull, { id: 'other', status: 'executing' });
    lTask(dFull, { id: 'T', status: 'pending' });
    const rFull = claimTaskForExecution(dFull as never, 'T', dataDir);
    ok(rFull.claimed === false && rFull.reason === 'concurrency_full',
      'L-a-11 ★★并发满是**一回事**：`reason=' + "'concurrency_full'" + '`（任务本身有效，须退避重排队——不得当失败收掉）',
      JSON.stringify(rFull));
    eq(lStatus(dFull, 'T'), 'pending',
      'L-a-12 被并发闸拒**不改状态**（任务还在队列里等着，这正是"退避重排"的前提）');

    const dGone = ldb();
    lProj(dGone, 'p1', 'active', { maxConcurrency: 5 }, path.join(dataDir, 'w2'));
    lTask(dGone, { id: 'T', status: 'executing' });
    const rGone = claimTaskForExecution(dGone as never, 'T', dataDir);
    ok(rGone.claimed === false && rGone.reason === 'cas_conflict',
      'L-a-13 ★★同一句 `changes === 0`，回读状态分辨出**另一种事实**：已被别的执行体抢走 ⇒ `cas_conflict`'
      + '（认账收尾、不重试——与"位子满了"处置相反，故必须分得开）', JSON.stringify(rGone));

    const dOk = ldb();
    lProj(dOk, 'p1', 'active', { maxConcurrency: 2 }, path.join(dataDir, 'w3'));
    lTask(dOk, { id: 'T', status: 'pending', ctx: { pause_reason: 'exec_timeout' } });
    const rOk = claimTaskForExecution(dOk as never, 'T', dataDir);
    ok(rOk.claimed === true && lStatus(dOk, 'T') === 'executing',
      'L-a-14 反证：有位子时**正常认领**（前三条不是"一律拒"的假判据）');
    eq(lCtxOf(dOk, 'T').pause_reason, undefined,
      'L-a-15 认领即清陈旧暂停因由（不变式未因并发闸并进 WHERE 而丢）');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }

  // ⑤ 接线：拒因一路带到调用方，且**两条路走同一处退避**
  const execSrc = RD(`${A}/src/main/core/agent-executor.ts`);
  // zx_20261018_3 批四（改钉更强非放宽）：`concurrencyFull` 不再是单个布尔表达式——
  //   项目尺与机器尺**各报各的归因**（`concurrencyScope`），两者同属"位子满了须退避重排"。
  //   判据收紧为：两条拒因都映射到 scope、且两者都经 `concurrencyFull` 带出（少接一条即哑）。
  const scopeMap = /claim\.reason === 'machine_concurrency_full'\s*\?\s*'machine'[\s\S]{0,160}?claim\.reason === 'concurrency_full'\s*\?\s*'project'/.test(execSrc);
  const scopeCarried = /return \{ content: claim\.content, steps: 0, concurrencyFull: concurrencyScope !== undefined, concurrencyScope \}/.test(execSrc);
  ok(scopeMap && scopeCarried,
    'L-a-16 ★接线①：`executeTask` 把**两种**拒因各归各的 scope 带出去（`machine_concurrency_full`→machine、'
    + '`concurrency_full`→project），两者都经 `concurrencyFull` 交给调度层'
    + '（只建接口不接，全量回归照样全绿——本仓已复发两次）');
  const aiSrc = codeLines(`${A}/src/main/core/jobs/ai-task.ts`).join('\n');
  eq((aiSrc.match(/scheduleConcurrencyRetry\(/g) ?? []).length, 4,
    'L-a-17 ★★接线②：`scheduleConcurrencyRetry` 在 `ai-task.ts` 里**恰 4 处**=1 定义 + **3 调用**'
    + '（预检 + 认领被拒的项目尺/机器尺两条支路）。少一处即该尺下的"位子满了"无人退避');
  {
    const claimBlock = /if \(result\.concurrencyFull\) \{([\s\S]*?)\n\s*return;/.exec(aiSrc)?.[1] ?? '';
    eq((claimBlock.match(/scheduleConcurrencyRetry\(/g) ?? []).length, 2,
      'L-a-17b ★认领被拒分支里**两条支路各调一次**（不是只接了一条、另一条静默掉）');
    ok(/scope: 'machine'/.test(claimBlock) && /scope: 'project'/.test(claimBlock),
      'L-a-17c ★两条支路各带**自己的** scope（日志/放弃文案才说得清是哪把尺满的）');
  }
  ok(/result\.concurrencyFull\)\s*\{[\s\S]{0,400}?scheduleConcurrencyRetry\(/.test(aiSrc)
    && !/result\.concurrencyFull\)\s*\{[\s\S]{0,400}?markTaskFailed/.test(aiSrc),
    'L-a-18 ★★认领被拒那条分支走**退避重排**、**不**落 `markTaskFailed`'
    + '（把一次合法的调度竞争记成任务失败＝账失实）');
  ok(/UPDATE wa_tasks SET status = 'pending' WHERE id = \?/.test(aiSrc),
    'L-a-19 退避期间状态落回 `pending`（软闸与 `setTimeout` 两条路都能再捞起它）');
  // zx_20261012_2 批五 M5 重定向：该处落 `failed` 时把因由一并交出（`{ reason: '并发重试超限' }`），
  //   与随后 emit 的 `task.failed.error` 同词。判据逐字钉这个新形状（未放宽）。
  ok(/retryCount > MAX_CONCURRENCY_RETRIES/.test(aiSrc) && /markTaskFailed\(db, taskId, \{ reason: '并发重试超限' \}\)/.test(aiSrc),
    'L-a-20 只有**重试超限**才放弃为 failed（上限与终态处置同处，两路共用一份）');
}

// ── L-b · M11-2 悬空子任务收敛（父终态那一支）──────────────────────────────
function groupLb(): void {
  console.log('\n【L-b】M11-2 悬空 pending 子任务：**要么被救起、要么被标失败**，不再永久 pending');

  // ① ★★ 父 `failed` ⇒ 子无出路 ⇒ 标 failed 并**点名父**
  {
    const db = ldb();
    lTask(db, { id: 'P', project: 'p1', status: 'failed' });
    lTask(db, { id: 'C', project: 'p1', status: 'pending', parent: 'P' });
    const rec = reconcileStalledSubtasks(db as never);
    eq([rec.candidates, rec.reconciled, lStatus(db, 'C')], [1, ['C'], 'failed'],
      'L-b-1 ★★父 `failed`（终态、再也不会醒来）⇒ 子由 `pending` 变 **`failed`**（0→1 正面断言：'
      + '既有 `chainStalled` 拦着不放、旧收入条件又把它挡在候选外，两边都不管 ⇒ 子永久 pending）');
    const cs = lConvs(db, 'C');
    ok(cs.length >= 1 && cs.some((c) => c.includes('T-P') && c.includes('failed')),
      'L-b-2 ★无出路那笔账**点名父与其终态**（"不会自动恢复"是事实；不承诺"处置后会恢复"）', cs.join(' | '));
  }
  // ② 父 `archived` ⇒ 同上（第二个终态取值，判据不是只认一个词）
  {
    const db = ldb();
    lTask(db, { id: 'P', project: 'p1', status: 'archived' });
    lTask(db, { id: 'C', project: 'p1', status: 'pending', parent: 'P' });
    const rec = reconcileStalledSubtasks(db as never);
    eq([rec.reconciled, lStatus(db, 'C')], [['C'], 'failed'], 'L-b-3 父 `archived` 同办（归档即放弃，子照样无出路）');
  }
  // ③ ★反证：父 `completed` **不在面内**（它有出路——`scanReadyTasks` 会拉起这些子）
  {
    const db = ldb();
    lTask(db, { id: 'P', project: 'p1', status: 'completed' });
    lTask(db, { id: 'C', project: 'p1', status: 'pending', parent: 'P' });
    const rec = reconcileStalledSubtasks(db as never);
    eq([rec.candidates, rec.reconciled, lStatus(db, 'C')], [0, [], 'pending'],
      'L-b-3b ★反证：父 `completed` ⇒ 候选 **0**、子**不动**（把这一格也收入面内就是错杀有出路的任务）');
  }
  // ④ ★★ 父 `paused` + 因由属"被打断" + 子无阻塞前置 ⇒ **派发救起**（不是标失败）
  {
    const db = ldb();
    lTask(db, { id: 'P', project: 'p1', status: 'paused', ctx: { pause_reason: 'exec_timeout' } });
    lTask(db, { id: 'C', project: 'p1', status: 'pending', parent: 'P' });
    const before = lJobs(db).length;
    const rec = reconcileStalledSubtasks(db as never);
    const jobs = lJobs(db);
    eq([rec.dispatched, rec.reconciled, lStatus(db, 'C')], [['C'], [], 'pending'],
      'L-b-4 ★★父**自身执行被打断**且子无阻塞前置 ⇒ **派发 `ai-task` 救起**（父子互锁的出路）；'
      + '此时标失败是错的——子本可跑');
    eq([before, jobs.length], [0, 1], 'L-b-5 ★0→1 正面断言：`wa_jobs` 真多出**一行**（"已派发"不是只改内存）');
    ok(jobs[0]?.type === 'ai-task' && jobs[0]?.payload.includes('"taskId":"C"')
      && jobs[0]?.payload.includes('self_healing_paused_parent'),
      'L-b-6 那行作业是 `ai-task` 且载荷点名该子与**上游来源**（排错时看得见是谁派的）', jobs[0]?.payload ?? '');
  }
  // ⑤ ★反证：父暂停因由是 `user_interrupt` ⇒ **既不派发也不标失败**（用户中止不得擅自复活）
  {
    const db = ldb();
    lTask(db, { id: 'P', project: 'p1', status: 'paused', ctx: { pause_reason: 'user_interrupt' } });
    lTask(db, { id: 'C', project: 'p1', status: 'pending', parent: 'P' });
    const rec = reconcileStalledSubtasks(db as never);
    eq([rec.dispatched, rec.reconciled, lStatus(db, 'C')], [[], [], 'pending'],
      'L-b-7 ★反证：父因由是 `user_interrupt` ⇒ **不动**（"用户没说要继续"与"执行被打断"是两回事；'
      + '集被改宽这一条即红）');
  }
  // ⑥ ★★ 有死前置时因由取 `depBlockInfo` 唯一真源（不是硬套"父已失败"的话术）
  {
    const db = ldb();
    lTask(db, { id: 'P', project: 'p1', status: 'paused', ctx: { pause_reason: 'exec_timeout' } });
    lTask(db, { id: 'D', project: 'p1', status: 'failed' });
    lTask(db, { id: 'C', project: 'p1', status: 'pending', parent: 'P', deps: 'D' });
    const rec = reconcileStalledSubtasks(db as never);
    const cs = lConvs(db, 'C');
    eq([rec.reconciled, rec.dispatched], [['C'], []],
      'L-b-8 ★★有**死前置** ⇒ 不走派发支（派了也跑不动）⇒ 如实标失败');
    ok(cs.some((c) => c.includes('前置已失败')) && !cs.some((c) => c.includes('父任务')),
      'L-b-9 ★因由取 `depBlockInfo` 的**唯一真源**文案（"前置已失败：X"），不硬套父那一支的话术'
      + '——`depBlockInfo` 的输入是**依赖**不是**父**，混用会说错话', cs.join(' | '));
  }
  // ⑦ ★反证：子**已有在途作业** ⇒ 候选 0（排队中也是出路）
  {
    const db = ldb();
    lTask(db, { id: 'P', project: 'p1', status: 'failed' });
    lTask(db, { id: 'C', project: 'p1', status: 'pending', parent: 'P' });
    lJob(db, 'ai-task', 'C', 'pending');
    const rec = reconcileStalledSubtasks(db as never);
    eq([rec.candidates, rec.reconciled, lStatus(db, 'C')], [0, [], 'pending'],
      'L-b-10 ★反证：子已排入执行作业 ⇒ **候选 0**（排队中也是出路，误标失败就是把在跑的路砍了）');
  }
  // ⑧ ★反证：父 `pending` ⇒ 不动（父自己会被调度拉起）
  {
    const db = ldb();
    lTask(db, { id: 'P', project: 'p1', status: 'pending' });
    lTask(db, { id: 'C', project: 'p1', status: 'pending', parent: 'P' });
    const rec = reconcileStalledSubtasks(db as never);
    eq([rec.candidates, rec.dispatched, rec.reconciled], [1, [], []],
      'L-b-11 ★反证：父 `pending` ⇒ 进候选但**两臂都不动手**（父自己会被调度，此处再派即双发）');
  }
  // ⑨ ★"被打断"那一集两侧同钉
  {
    const inc = (r: string) => PARENT_INTERRUPTED_PAUSE_REASONS.includes(r);
    eq([inc('exec_timeout'), inc('planning_timeout'), inc('stale_timeout'), inc('startup_sweep'), inc('abnormal_end')],
      [true, true, true, true, true],
      'L-b-12 ★"执行被打断"集含五种超时/异常收尾（父不会再自己醒来 ⇒ 子须被救）');
    eq([inc('user_interrupt'), inc('awaiting_input'), inc('children_incomplete')], [false, false, false],
      'L-b-13 ★★同集**不含**用户中止 / 等输入 / 等子（三种都各有自己的处置路径）——集被改宽这一条即红');
  }
}

// ── L-c · M11-3 看门狗归一（同一"无心跳"只留一个终局裁定者）────────────────────
function groupLc(): void {
  console.log('\n【L-c】M11-3 执行态无心跳：判据与处置收成**一处**，`failed` 那一票不再并存');

  // ① 判据两侧标本
  {
    const db = ldb();
    lTask(db, { id: 'old', status: 'executing', ageMin: 20 });
    lTask(db, { id: 'fresh', status: 'executing' });
    const ids = findStaleExecutingTasks(db as never).map((t) => t.id);
    eq(ids, ['old'], 'L-c-1 ★时间基准走 SQLite `datetime(\'now\')`（与 `updated_at` 同源）：20 分钟前 ⇒ 命中，此刻 ⇒ 不命中');
  }
  // ② ★★ `stabilizing` 刻意不在集内（它是等人确认，不是卡死）
  eq([(EXEC_STALE_STATUSES as readonly string[]).includes('executing'),
    (EXEC_STALE_STATUSES as readonly string[]).includes('stabilizing'),
    (EXEC_STALE_STATUSES as readonly string[]).includes('running')],
  [true, false, true],
    'L-c-2 ★★`stabilizing` **不在**执行态超时集内（把"等人工"判成"卡死"就把它唯一的出口也堵了）；'
    + '`stabilizing` 因此不进 `findStaleExecutingTasks` 的 SQL —— 取而不判（旧 scheduler 的 `continue`）也一并消失');

  // ③ ★★ 唯一裁定者真跑：paused + exec_timeout + 一条如实账（0→1）
  {
    const db = ldb();
    lTask(db, { id: 'T', project: 'p1', status: 'executing', ageMin: 20 });
    const t = findStaleExecutingTasks(db as never)[0];
    const before = lConvs(db, 'T').length;
    const done = reclaimStaleExecutingTask(db as never, t!);
    eq([done, lStatus(db, 'T'), lCtxOf(db, 'T').pause_reason], [true, 'paused', 'exec_timeout'],
      'L-c-3 ★★回收落 **`paused` + `exec_timeout`**（可救；`failed` 是终态且会被 `failedChildren` 记成"有失败子"连坐父）');
    eq([before, lConvs(db, 'T').length], [0, 1],
      'L-c-4 ★0→1 正面断言：另落**恰一条**如实说明（"最后心跳 X，可手动恢复重试"——用户据此知道下一步）');
  }
  // ④ ★守卫：已被别路处置 ⇒ 不动（找与动之间有窗口）
  {
    const db = ldb();
    lTask(db, { id: 'T', project: 'p1', status: 'completed' });
    const before = lConvs(db, 'T').length;
    const done = reclaimStaleExecutingTask(db as never,
      { id: 'T', title: 'T', project_id: 'p1', status: 'executing', updated_at: '2000-01-01 00:00:00' });
    eq([done, lStatus(db, 'T'), lConvs(db, 'T').length], [false, 'completed', before],
      'L-c-4b ★守卫：候选是"找的那一刻"的形状，动之前即时回读——已被别路处置 ⇒ **不动手也不落账**');
  }
  // ⑤ ★★ 唯一的 paused 写入口仍被遵守（不直写 status='paused'）
  {
    const shSrc = codeLines(`${A}/src/main/core/self-healing-monitor.ts`).join('\n');
    ok(!/UPDATE wa_tasks SET status = 'paused'/.test(shSrc) && /pauseTask\(db, \{ taskId: task\.id/.test(shSrc),
      'L-c-5 ★回收**走 `pauseTask`**（不再直写 `status=\'paused\'`）——因由/事件/告知一次写全，绕开唯一写入口即算回归');
  }
  // ⑥ ★★ 调度器那条路**不再**落 failed
  {
    const schedLines = codeLines(`${A}/src/main/core/task-scheduler.ts`);
    const sched = schedLines.join('\n');
    eq(schedLines.filter((l) => l.includes('markTaskFailed')).length, 0,
      'L-c-6 ★★调度器**零处** `markTaskFailed`（原心跳超时那条路——30s 一跳必然抢先，'
      + '于是 `failed` 恒赢、"自愈"那条路从不生效——已并入共享裁定者）');
    ok(/findStaleExecutingTasks\(this\.db\)/.test(sched) && /reclaimStaleExecutingTask\(this\.db, task\)/.test(sched),
      'L-c-7 ★接线：调度器改调**同一对原语**（判据 + 处置），不是自己再写一条 SQL');
  }
  // ⑦ ★原语只定义一处（改一处不必满仓找）
  {
    const mainFiles = walkTs(`${A}/src/main`);
    const defCount = (decl: string) =>
      mainFiles.filter((f) => new RegExp(`export function ${decl}\\(`).test(RD(f))).length;
    ok(mainFiles.length > 100, 'L-c-8 扫描面自证：`src/main` 下 ts 文件数合理（"恰一处"不能在空集上成立）', `${mainFiles.length} 个`);
    eq([defCount('findStaleExecutingTasks'), defCount('reclaimStaleExecutingTask'), defCount('projectSlotGuard')], [1, 1, 1],
      'L-c-9 ★★三个原语在 `src/main` 下**各只定义一处**（"一处真源"是可数的，不是句口号）');
  }
  // ⑧ ★自愈扫描第 2 项真接了共享原语
  {
    const body = fnBodyByDecl(RD(`${A}/src/main/core/self-healing-monitor.ts`), 'function runHealthScan(');
    ok(/findStaleExecutingTasks\(db\)/.test(body) && /reclaimStaleExecutingTask\(db, st\)/.test(body),
      'L-c-10 ★自愈扫描也走**同一对原语**（两条看门狗同因同果；判据或处置任一侧分叉即红）');
  }
}

// ── L-d · M11-4 `batchEnqueue` 二选一：删除 ────────────────────────────────
function groupLd(): void {
  console.log('\n【L-d】M11-4 `batchEnqueue` 删除（"注释说有、代码零调用"的名实不符）');
  const mainFiles = walkTs(`${A}/src/main`);
  ok(mainFiles.length > 100, 'L-d-1 扫描面自证：`src/main` 扫描面非空', `${mainFiles.length} 个 ts`);
  const hit = mainFiles.filter((f) => codeLines(f).some((l) => l.includes('batchEnqueue')));
  eq(hit.map((f) => path.relative(root, f)), [],
    'L-d-2 ★★`batchEnqueue` 在 `src/main` 的**代码行**面零命中（旧状态是：注释写"批量并行入队"、'
    + '全仓零调用方——读代码的人以为这条路存在、以为 `pendingKey` 有第二个维护点）');
  const schedSrc = RD(`${A}/src/main/core/task-scheduler.ts`);
  ok(schedSrc.includes('batchEnqueue') && schedSrc.includes('已**删除**'),
    'L-d-3 ★反证扫描面没扫空：删除留痕的注释**在场**（注释说它已被删，而不是又一处"注释说有"）');
}

// ── L-e · M11-5 `stabilizing` 的人工出口（词表 + GUI 按钮 + 产物）─────────────
function groupLe(): void {
  console.log('\n【L-e】M11-5 `stabilizing`（烹小鲜冷却暂态）认得出来、出得去');

  // ① ★★ 词表真引（渲染层真源），且未知取值仍如实回显
  ok(statusText(TASK_STATUS_LABEL, 'stabilizing') !== 'stabilizing' && statusText(TASK_STATUS_LABEL, 'stabilizing') !== '',
    'L-e-1 ★★词表认得 `stabilizing`（改前**两处词表都没它有** ⇒ 任务列表/详情页直接把 key 回显给用户）',
    statusText(TASK_STATUS_LABEL, 'stabilizing'));
  eq([statusText(TASK_STATUS_LABEL, '__no_such__'), statusText(TASK_STATUS_LABEL, 'executing')],
    ['__no_such__', TASK_STATUS_LABEL.executing],
    'L-e-2 ★反证两侧：不认识的取值**照样原样回显**（不许伪造成某个已知态）；认识的走词表');

  // ② ★两个出口（pending / paused）真落在 GUI 上，且都不是"等它自己超时"
  const page = RD(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  eq((page.match(/task\.status==='stabilizing' &&/g) ?? []).length, 3,
    'L-e-3 ★详情页三处认得该态（横幅 + 动作栏两钮）——此前**一处也没有**，任务就此永久停住');
  ok(/task\.status==='stabilizing'[\s\S]{0,120}?handleStatus\(task\.id,'pending'\)/.test(page)
    && /task\.status==='stabilizing' && <button onClick=\{\(\) => handleStatus\(task\.id,'paused'\)\}/.test(page),
    'L-e-4 ★★两个**明确出口**：`→ pending`（确认并放回队列，等下一轮调度自动拉起）与 `→ paused`（转人工暂停态）'
    + '——"它不会自己超时恢复"这句话必须有对应的按钮才不是空话');
  ok(/稳定观察中/.test(page) && /确认并放回队列/.test(page),
    'L-e-5 横幅说人话：成因条数从 `context_json.status_changes` **如实数出来**，不让人自己去猜为什么停');
  const tasksPage = RD(`${A}/renderer/src/pages/TasksPage.tsx`);
  ok(/stabilizing:'bg-amber-50/.test(tasksPage),
    'L-e-6 ★任务列表徽标也给了档（原无档 ⇒ 落灰底，与"不认识的态"混同）');

  // ③ 渲染层是词表的第二个落点：产物证据（minify 后搜**中文串**，标识符不可靠）
  const assetsDir = path.join(root, A, 'renderer', 'dist', 'assets');
  const jsAssets = (fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : []).filter((f) => f.endsWith('.js'));
  ok(jsAssets.length > 0, 'L-e-7 扫描面自证：renderer 产物 js chunk 在场（renderer build 须先于本脚本）', `${jsAssets.length} 个`);
  const blob = jsAssets.map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf-8')).join('\n');
  const cjk = (s: string) => blob.includes(s)
    || blob.includes([...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''));
  ok(cjk('确认并放回队列') && cjk('稳定观察中'),
    'L-e-8 ★两句话真在**产物**里（"引了"≠"打包器没摇树掉"；minify 后按中文串搜，标识符不可靠）');
}

// ── L-f · M11-6 槽位：先过滤、后切片 ───────────────────────────────────────
function groupLf(): void {
  console.log('\n【L-f】M11-6 槽位「先过滤、后切片」（位子不再被挡路者白占）');
  const sched = codeLines(`${A}/src/main/core/task-scheduler.ts`).join('\n');
  ok(/for \(const task of ready\)/.test(sched), 'L-f-1 扫描循环遍历**候选全量**（`for (const task of ready)`）');
  ok(/if \(selectedThisPass\.size >= conc\.available\) break;/.test(sched),
    'L-f-2 ★就地计数到 `available` 为止（入队几个才扣几个位子）');
  ok(!/getReadyTasks\([^)]*\)\.slice\(/.test(sched),
    'L-f-3 ★反证：**零处** `getReadyTasks(…).slice(`（旧形状把候选先切一段；切掉那段里若有本可入队的，'
    + '本轮位子就白空着——切 3 条滤掉 2 条 ⇒ 只入队 1 条，而项目其实还能再起 2 个）');

  // ★★ 行为判别：限 1、候选第 1 名被"直接父在跑"挡住、第 2 名干净 ⇒ 旧形状 0 入队、新形状恰 1
  {
    const db = ldb();
    lProj(db, 'p1', 'active', { maxConcurrency: 1 });
    lProj(db, 'pOther', 'active');
    lTask(db, { id: 'busyParent', project: 'pOther', status: 'executing' });
    lTask(db, { id: 'blocked', status: 'pending', parent: 'busyParent', priority: 2 });
    lTask(db, { id: 'good', status: 'pending', priority: 1 });
    const sch = new TaskScheduler(db as never);
    (sch as unknown as { scanReadyTasks(): void }).scanReadyTasks();
    const picked = [...(sch as unknown as { pending: Map<string, unknown> }).pending.keys()];
    eq(picked, ['good'],
      'L-f-4 ★★真跑 `scanReadyTasks`：第 1 名被链闸挡、第 2 名干净 ⇒ **恰第 2 名入队**'
      + '（旧形状 `slice(0,1)` 只剩被挡的那条 ⇒ 位子白空、结果 0 条）');
  }
}

// ── L-g · M11-7 「这个项目为什么没被扫」上桌 ────────────────────────────────
function groupLg(): void {
  console.log('\n【L-g】M11-7 非 active 项目的 `pending` 待办：不再静默不扫');

  // ① ★★ 纯判据四侧（正反各两：状态一档、窗口一档）
  {
    const h = new Date().getHours();
    const inWin = JSON.stringify({ rhythm: { activeHourStart: h, activeHourEnd: h + 1 } });
    const outWin = JSON.stringify({ rhythm: { activeHourStart: (h + 2) % 24, activeHourEnd: (h + 3) % 24 } });
    const v = (status: string, ctx: string) => projectScanVerdict({ status, context_json: ctx }, new Date());
    eq([v('active', '{}').scan, v('paused', '{}').scan], [true, false],
      'L-g-1 ★★状态这一档：`active` 扫、`paused` 不扫（旧码把非 active 项目**整个摘出候选集**，连"为什么不扫"都无从得知）');
    eq([v('active', inWin).scan, v('active', outWin).scan], [true, false],
      'L-g-2 ★★窗口这一档：当前小时落在 `[start,end)` 内则扫，落在外则不扫'
      + '（窗口由**当前本地小时**派生后±2，故不依赖真实墙钟的那一段——G-4）');
    ok(v('paused', '{}').reason.includes('paused') && v('active', outWin).reason.includes('活跃时段'),
      'L-g-3 ★不扫的那一支**带非空可读理由**（"项目状态为 paused，非 active" / "当前 N 时不在活跃时段 […]"）',
      v('paused', '{}').reason + ' ｜ ' + v('active', outWin).reason);
    eq(v('active', '{}').reason, '', 'L-g-4 扫的那一支理由为空串（"没理由拦"与"有理由但为空"要分得开）');
  }

  // ② ★★ 调度器真跑：三个项目一次扫，只拉起该拉起的
  {
    const h = new Date().getHours();
    const db = ldb();
    lProj(db, 'pActive', 'active');
    lProj(db, 'pWindow', 'active', { activeHourStart: (h + 2) % 24, activeHourEnd: (h + 3) % 24 });
    lProj(db, 'pPaused', 'paused');
    lTask(db, { id: 'tA', project: 'pActive', status: 'pending' });
    lTask(db, { id: 'tW', project: 'pWindow', status: 'pending' });
    lTask(db, { id: 'tP', project: 'pPaused', status: 'pending' });
    const sch = new TaskScheduler(db as never);
    (sch as unknown as { scanReadyTasks(): void }).scanReadyTasks();
    const picked = [...(sch as unknown as { pending: Map<string, unknown> }).pending.keys()].sort();
    eq(picked, ['tA'],
      'L-g-5 ★★真跑：候选集**取全部项目**逐个过判据 ⇒ 只有 active 且不在窗口外的那个被拉起；'
      + '窗口外的与 `paused` 名下的待办**各自被明确拦下**（不是从结果集里凭空消失）');
  }

  // ③ ★接线：理由落日志 + 计数上屏（做了要用上）
  {
    const sched = codeLines(`${A}/src/main/core/task-scheduler.ts`).join('\n');
    ok(/const verdict = projectScanVerdict\(proj, now\)/.test(sched) && /if \(!verdict\.scan\)/.test(sched),
      'L-g-6 ★调度器消费**同一份**判据（不在这里手抄第二版"什么算不扫"）');
    ok(/项目本轮不自动拉起（待办搁置）/.test(sched) && /pendingCount > 0/.test(sched),
      'L-g-7 ★理由落日志，且**只在该项目名下真有 pending 待办时**才出声（否则每个归档项目每 10s 刷一行噪声）');

    const ipc = RD(`${A}/src/main/ipc/project.ipc.ts`);
    ok(/import \{[^}]*projectScanVerdict[^}]*PROJECT_PARKED_STATUSES[^}]*\} from '\.\.\/core\/task-accounting\.js'/.test(ipc),
      'L-g-8 健康视图引**同一个真源**（判据 + 搁置档名单），不在 IPC 里另写一份');
    ok(/PROJECT_PARKED_STATUSES\.map\(\(\) => '\?'\)/.test(ipc) && /parkedTaskCount/.test(ipc) && /parkedReason/.test(ipc),
      'L-g-9 ★★计数与理由**成对**出（单看条数会以为"调度器漏了"、单看原因会以为"一格都没有"），'
      + '且搁置档由常量派生（写死一份就会与调度器分家）');
    ok(/scanVerdict\.scan \? 0 : parkedTaskCount/.test(ipc),
      'L-g-10 ★正扫时计数**归零**（项目在跑却报"待办搁置"是最糟的一种假账）');
  }
  // ④ 界面真读了这两个键（renderer 是第二落点）
  {
    const pdp = RD(`${A}/renderer/src/pages/ProjectDetailPage.tsx`);
    ok(/parkedTaskCount/.test(pdp) && /parkedReason/.test(pdp),
      'L-g-11 GUI 真读了这对键（"做了没用上"的反面）');
    const assetsDir = path.join(root, A, 'renderer', 'dist', 'assets');
    const jsAssets = (fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : []).filter((f) => f.endsWith('.js'));
    const blob = jsAssets.map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf-8')).join('\n');
    const mark = '个待办未自动拉起';
    ok(blob.includes(mark)
      || blob.includes([...mark].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')),
      'L-g-12 ★那句话真在 renderer 产物里（minify 后按中文串搜）');
  }
}

// ══════════════════════════════════════════════════════════════════
// 【M】M12 · 文件读的闸（判限口径统一 / `read_file` 双闸 / 源码内联 / 音轨闸）
//   G-1：判据一律调**生产导出**（`readCapBytes` / `decodePlainText` / `extractDocText` /
//        `readonlyTools().read_file.execute` / `normalizeToWav` / `makeAudioTranscriber`），
//        绝不在夹具里重写一份"上限怎么算"或"什么算文本"（那证的是抄件，本仓已复发两次）。
//   G-2：每条都**正反两侧各给一只真标本**。
//   G-5：静态判据读**原文**（`RD`），锚字面量与符号；**不** strip 注释（去注释是静默毁伤）。
//   G-6：不写轮次字面量——本组判据若与 build 相关，一律走末尾 §A-g 的派生核对。
// ══════════════════════════════════════════════════════════════════

function groupMa(): void {
  console.log('\n【M-a】判限口径统一：所有"读盘上限"只有一处取数口');
  const mb = (n: number) => n * 1024 * 1024;

  // ① 三态：有族上限的取族上限 / 族上限为 0 的取兜底 / 视频音频与族上限同尺
  eq([readCapBytes('.txt'), readCapBytes('.pdf'), readCapBytes('.ts'), readCapBytes('.log')],
    [mb(20), mb(20), mb(20), mb(20)],
    'M-a-1 文档族（含 M12 新纳入的 `.ts`/`.log`）⇒ 取族上限 20MB');
  eq([readCapBytes('.png'), readCapBytes('image/jpeg'), readCapBytes('.mp4'), readCapBytes('.mp3')],
    [IMAGE_MAX_BYTES, IMAGE_MAX_BYTES, mb(100), mb(25)],
    'M-a-2 ★`read_file` 的上限**与族上限同尺**（图片 10MB / 视频 100MB / 音频 25MB 都从 `FAMILY_MAX_BYTES` 取），'
    + 'MIME 与裸扩展名两种入参等价');
  eq([readCapBytes('.bin'), readCapBytes('.exe'), readCapBytes(''), readCapBytes('认不出的东西')],
    [READ_FALLBACK_MAX_BYTES, READ_FALLBACK_MAX_BYTES, READ_FALLBACK_MAX_BYTES, READ_FALLBACK_MAX_BYTES],
    'M-a-3 ★★族上限为 0（`binary`／认不出的扩展名）⇒ 取**兜底整读上限**——'
    + '0 是「此族不内联」的判决，不是「点名整读时随便读多大」。旧 `read_file` 压根没有闸，这条是新增的落点'
    + '（方案 §2-M12「判限口径统一」）');
  ok(READ_FALLBACK_MAX_BYTES > 0 && readCapBytes('.bin') !== 0,
    'M-a-4 ★反侧对照：兜底值**非 0**（若把 `maxBytesOf` 原样返回，"认不出的件"会被"0 字节上限"整死——'
    + '所有 `.bin`/无扩展名的件一律读不出来）');
  ok(MAX_AUDIO_SECONDS * WAV_BYTES_PER_SEC <= AUDIO_CAP_BYTES
    && (MAX_AUDIO_SECONDS + 1) * WAV_BYTES_PER_SEC > AUDIO_CAP_BYTES,
    'M-a-5 音轨时长上限**贴住**族上限（`floor` 取值：再放宽一秒就越过 25MB，再收紧一秒就是白丢一段能转的内容）',
    `${MAX_AUDIO_SECONDS}s × ${WAV_BYTES_PER_SEC} B/s vs ${AUDIO_CAP_BYTES}`);
  eq(AUDIO_CAP_BYTES, FAMILY_MAX_BYTES.audio,
    'M-a-6 `AUDIO_CAP_BYTES` **派生**自族上限（不是手抄的 26214400）');

  // ② "族上限只有一个落点"：读**原文**（G-5），钉的是**算式字面量**——注释里写"25MB"这类词不影响本条
  const files = walkTs(`${A}/src/main`);
  const srcs = new Map<string, string>(files.map((f) => [f, RD(f)] as const));
  const KINDS = `${A}/src/main/core/attachment-kinds.ts`;
  const holders = (needle: string) => files.filter((f) => srcs.get(f)!.includes(needle)).sort();
  eq(holders('25 * 1024 * 1024'), [KINDS],
    'M-a-7 ★★音轨族上限的算式字面量在 `src/main` **只出现在 `attachment-kinds.ts`**（第二份＝改一处忘另一处）');
  eq(holders('100 * 1024 * 1024'), [KINDS],
    'M-a-7b ★同上：视频族上限 100MB 也只此一处');
  eq(holders('READ_FALLBACK_MAX_BYTES'), [KINDS],
    'M-a-8 ★「族上限为 0 时读多大」这个判决**只被 `attachment-kinds.ts` 自己提到**——'
    + '消费方一律经 `readCapBytes`，无人手抄第二份"20MB 兜底"');
  const roSrc = RD(`${A}/src/main/core/tools/readonly.ts`);
  ok(/readCapBytes\(ext\)/.test(roSrc),
    'M-a-9 `read_file` 经**唯一取数口** `readCapBytes(ext)` 取限（不是自己写一遍"取族上限、0 就补 20MB"）');
  const mediaSrc = RD(`${A}/src/main/core/tools/media.ts`);
  ok(/maxBytesOf\(familyOf\(/.test(mediaSrc),
    'M-a-10 同族的 `media.ts`（`view_image`/`read_document`）取的是**同一张表**（`maxBytesOf(familyOf(…)`）——'
    + '两处差别只在"0 怎么读"：它那里 0 是「此路不通，如实拒绝」，`read_file` 那里 0 是「补兜底再读」');
}

async function groupMb(): Promise<void> {
  console.log('\n【M-b】`read_file` 双闸真跑（真 `readonlyTools` 表 · 真盘上文件）');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr30-m12b-'));
  try {
    // 夹具自证：`read_pathGuard` 认这棵 tmp（不在 `/Users` 下的敏感表内），否则下面全部会在**守卫**那一步
    //   就返回错误，而"闸拦住了"看起来仍是绿的（假绿）。
    // zx_20261002 M17-①: `readFiles` 是「先读后改」共享状态（生产由 `buildTools` 建）——夹具同形给一份空集。
    const tools = readonlyTools({ workingDir: tmp, ctx: {}, db: {}, taskId: 'probe', projectId: 'probe', readFiles: new Set<string>() } as never);
    const rd = async (filePath: string) => JSON.parse(await tools.read_file.execute({ filePath })) as Record<string, unknown>;
    fs.writeFileSync(path.join(tmp, 'ok.txt'), 'M12-OK');
    const probe = await tools.read_file.execute({ filePath: 'ok.txt' });
    eq(probe, 'M12-OK', 'M-b-0 ★夹具自证：围栏放行、小文本整读回原文（下面几条拦下的东西才是"闸"拦的）');

    // ① 该不命中：正常大小的**源码**文件照读（M12 纳入 `.ts` 后，它不再被判"非文本"）
    fs.writeFileSync(path.join(tmp, 'mod.ts'), 'export const ANSWER = 42;\n');
    eq(await tools.read_file.execute({ filePath: 'mod.ts' }), 'export const ANSWER = 42;\n',
      'M-b-1 **该不命中**：`.ts` 源码照旧整读（闸不是"把什么都拦下来"）');

    // ② ★★大小闸：超限的件**在 `stat` 那一步就被拒**，根本没被整读进内存
    const HUGE = readCapBytes('.txt') + 1;
    // 件体故意填 NUL：若真被读进来，走的是**编码闸**那条路（回话里会出现"二进制"）。
    //   现在回的是"体积超限" ⇒ 反面证明**没有整读**（旧实现是 `readFile(fp,'utf-8')` 无参整读）。
    fs.writeFileSync(path.join(tmp, 'huge.txt'), Buffer.alloc(HUGE));
    const huge = await rd('huge.txt');
    eq([huge.bytes, huge.limit, huge.path], [HUGE, readCapBytes('.txt'), path.join(tmp, 'huge.txt')],
      'M-b-2 ★★超限拒时**把三个数都报出来**（实际字节 / 上限 / 落点）：只说"太大了"等于把活儿退回去');
    ok(typeof huge.error === 'string' && huge.error.includes('字节超过')
      && huge.error.includes('search_content') && /sed -n/.test(huge.error) && huge.error.includes('read_file'),
      'M-b-3 ★★拒绝**必须给出可行动的下一步**，且三条路在本工具集里**真成立**：'
      + '① `search_content`（只读工具）② `bash` 的 `sed -n`/`head`/`tail`（白名单内、支持管道）'
      + '③ 截取到上限内再 `read_file`', String(huge.error).slice(0, 120) + '…');
    ok(!('text' in huge) && !String(huge.error).includes('二进制'),
      'M-b-4 ★★**反证"没有整读"**：该件是 NUL 填充的——真读进来会落**编码闸**（回话里出现「二进制」）；'
      + '现在回的是体积超限 ⇒ `read_file` 在 `fsp.readFile` **之前**就返回了');

    // ③ ★编码闸（其一）：非 UTF-8（GBK）⇒ 如实说"解不了"，不返回一坨 U+FFFD
    //    标本取自 GBK 的"中文"两字节序列，逐字节按 UTF-8 解码全部非法 ⇒ 替换率 ~100%（远高于 2% 闸线）。
    const gbk = Buffer.alloc(400);
    for (let i = 0; i < gbk.length; i += 2) { gbk[i] = 0xb0; gbk[i + 1] = 0xa1; }
    fs.writeFileSync(path.join(tmp, 'gbk.txt'), gbk);
    const g = await rd('gbk.txt');
    eq([g.ok, g.reason], [false, 'unsupported_encoding'],
      'M-b-5 ★★**该命中**：GBK 文本 ⇒ `unsupported_encoding`（旧实现按 `utf-8` 硬解，**静默**变成一坨 U+FFFD'
      + '喂给模型——模型对乱码的反应是**编**）');
    ok(typeof g.note === 'string' && g.note.includes(path.join(tmp, 'gbk.txt')) && g.note.includes('view_image'),
      'M-b-6 回话带**盘上路径**并指出该走哪个工具（"读不了"与"读到了但内容是 X"不是一回事）',
      String(g.note).slice(0, 80) + '…');

    // ④ ★编码闸（其二）：挂了文本扩展名的二进制（NUL 成片）⇒ `binary`
    fs.writeFileSync(path.join(tmp, 'blob.bin'), Buffer.concat([Buffer.from('PNG'), Buffer.alloc(256)]));
    const b = await rd('blob.bin');
    eq([b.ok, b.reason], [false, 'binary'],
      'M-b-7 ★**该不命中**的对照组（同一把尺、另一档）：NUL 占比 > 1% ⇒ `binary`，'
      + '与 M-b-5 的 `unsupported_encoding` **分得开**（"不是文本"与"是文本但编码不认"是两件事）');
    // 成功路回的是**纯文本**（不是 JSON）⇒ 这两件直接调工具，不走 `rd`（它按 JSON 解，只用于拒绝路）。
    eq([await tools.read_file.execute({ filePath: 'mod.ts' }), await tools.read_file.execute({ filePath: 'ok.txt' })],
      ['export const ANSWER = 42;\n', 'M12-OK'],
      'M-b-8 闸只拦该拦的：跑完上面四条之后，两件合法文本**仍然**照读（不是"一旦进过拒绝分支就永久变严"）');

    // ⑤ ★同尺的正面断言：`decodePlainText` 的真实现（G-1：调生产导出，不重写一份判定）
    eq(decodePlainText(Buffer.from('纯文本 UTF-8 正文', 'utf8')), { ok: true, text: '纯文本 UTF-8 正文' },
      'M-b-9 `decodePlainText` **该命中**：合法 UTF-8 ⇒ `ok:true` 且**原文不动**（不截断——'
      + '`read_file` 要整读后按行分页，先截字符会把行边界弄错）');
    eq(decodePlainText(Buffer.from('')), { ok: true, text: '' },
      'M-b-10 空文件是**合法空文本**，不是 `binary`（"读到了，内容是空"与"根本不是文本"要分得开）');
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('AB', 'utf16le')]);
    eq(decodePlainText(u16), { ok: true, text: 'AB' },
      'M-b-11 BOM 先于 NUL 闸（UTF-16LE 的 ASCII 文本**天然**一半是 NUL：先谈 NUL 会把它们全误杀）');
    // ⚠ Node 不认 `Buffer.from(…, 'utf16be')`（实测 `ERR_UNKNOWN_ENCODING`）⇒ 逐码元 **BE** 自建。
    const be = Buffer.alloc(4);
    be.writeUInt16BE(0x0041, 0);
    be.writeUInt16BE(0x0042, 2);
    const u16be = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
    eq(decodePlainText(u16be), { ok: true, text: 'AB' },
      'M-b-12 同一支的 BE 侧（逐对换字节，本模块自己实现）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function groupMc(): void {
  console.log('\n【M-c】源码内联：附进来的 `.ts/.yaml/.log` 开局即入上下文（真源派生、不手抄第二份）');
  // ① 成员：三类各取一件（源码 / 配置 / 日志）+ 该不命中的两侧
  for (const e of ['.ts', '.py', '.yaml', '.toml', '.log', '.sh', '.sql', '.md', '.markdown']) {
    ok(TEXT_EXTS.includes(e), `M-c-1 \`TEXT_EXTS\` 含 \`${e}\``);
  }
  ok(!TEXT_EXTS.includes('.bin') && !TEXT_EXTS.includes('.exe') && !TEXT_EXTS.includes('.docx'),
    'M-c-1b ★**该不命中**：二进制/可执行不在册；`.docx` 也**不在**（它是压缩容器，走 ZIP 支，不是"按 UTF-8 直读"）');

  // ② 派生：族归属由清单派生（不是第二张表）
  eq([familyOf('.ts'), familyOf('.log'), familyOf('.yaml')], ['document', 'document', 'document'],
    'M-c-2 `EXT_TO_FAMILY` 里这些扩展名归 `document`——**由 `TEXT_EXTS` 派生**');
  eq([familyOf('.exe'), familyOf('.bin'), familyOf('.docx'), familyOf('.pdf')],
    ['binary', 'binary', 'document', 'document'],
    'M-c-2b ★反侧：`.exe/.bin` 落 `binary`（⇒ `maxBytesOf` 为 0 ⇒ 不内联）；'
    + '`.docx/.pdf` 归 `document` 但**不在** `TEXT_EXTS`（它们是容器，走各自的解析支）');

  // ③ 认下：`isDocTextExt` 两档（`read_file`/`read_document`/装配层共用这一个判决）
  eq(['.ts', '.log', '.yaml', '.csv'].map(isDocTextExt), [true, true, true, true],
    'M-c-3 `isDocTextExt` **该命中**：源码/配置/日志都认下');
  eq(['.png', '.pdf', '.bin', '.mp4'].map(isDocTextExt), [false, false, false, false],
    'M-c-3b ★**该不命中**：图片/PDF/二进制/视频都**不**走文本支（PDF 归 `pdf-text.ts`、图片归 `view_image`）');

  // ④ 真取：`extractDocText` 对 `.ts`/`.log` 取出**真文字**
  const rTs = extractDocText(Buffer.from('export const ANSWER = 42;\n', 'utf8'), '.ts');
  ok(rTs.ok === true && rTs.text.includes('export const ANSWER = 42;'),
    'M-c-4 ★★`extractDocText` **真取出** `.ts` 的正文（M12 前它落 `not_yet_supported`，用户附源码模型只看得见文件名）');
  const rLog = extractDocText(Buffer.from('2026-09-30 INFO started\n', 'utf8'), '.log');
  ok(rLog.ok === true && rLog.text.includes('INFO started'),
    'M-c-4b ★同上：`.log` 也真取出（方案 §2-M12 点名的 `.log`）');
  const rDoc = extractDocText(Buffer.from('x', 'utf8'), '.doc');
  eq(rDoc.ok === false && rDoc.reason, 'doc_legacy_unsupported',
    'M-c-5 **该不命中**：老 `.doc` 仍如实拒绝（M12 动的是"哪些扩展名算文本"，没动 `.doc` 的 OLE 不解析裁定）');

  // ⑤ 不手抄第二份：`doc-text.ts` 里**没有**任何只有清单才有的成员字面量
  const docSrc = RD(`${A}/src/main/core/doc-text.ts`);
  ok(docSrc.includes('TEXT_EXTS') && !docSrc.includes("'.markdown'") && !docSrc.includes("'.toml'")
    && !docSrc.includes("'.yml'") && !docSrc.includes("'.jsonl'"),
    'M-c-6 ★★`doc-text.ts` 的清单**由真源派生**（`TEXT_EXTS`），不在本文件重抄一份：'
    + '只属于清单、不可能出现在注释里的那几个成员字面量（`.markdown`/`.toml`/`.yml`/`.jsonl`）**零命中**');
  ok(/\.\.\.Object\.fromEntries\(TEXT_EXTS\.map\(/.test(RD(`${A}/src/main/core/attachment-kinds.ts`)),
    'M-c-7 ★族归属**由清单派生**（`...Object.fromEntries(TEXT_EXTS.map(…))`）——'
    + '手抄第二份必然与清单各自漂移（G8/G9 老病）');
}

/** M-d 用：写一个"冒充 ffmpeg"的 shell 桩，产物字节数由**生产派生值**给出（不写 819/26214400 这类字面量）。 */
function mkWavStub(p: string, argsFile: string, bytes: number): string {
  fs.writeFileSync(p, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${argsFile}"`,
    'out=""',
    'for a in "$@"; do out="$a"; done',
    `dd if=/dev/zero of="$out" bs=${bytes} count=1 2>/dev/null`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  return p;
}

async function groupMd(): Promise<void> {
  console.log('\n【M-d】音轨闸：`-t` 时长上限 + 产物体积上限 + 截断**如实告知**（真 shell 桩，不写死字面量）');
  const mt = fs.mkdtempSync(path.join(os.tmpdir(), 'rr30-m12d-'));
  const srv = await ansStub(() => ({
    status: 200,
    body: JSON.stringify({ choices: [{ message: { content: 'STUB-TRANSCRIPT' } }] }),
  }));
  try {
    const argsFile = path.join(mt, 'args.txt');
    const sDir = path.join(mt, 'src');
    fs.mkdirSync(sDir, { recursive: true });
    const src = path.join(sDir, 'clip.m4a');
    fs.writeFileSync(src, Buffer.from('not-really-m4a'));

    // 三个桩：小件(9B) / 边界件(恰抵 `-t` 那一档) / 超限件(过族上限 600 字节)
    const BOUNDARY = MAX_AUDIO_SECONDS * WAV_BYTES_PER_SEC;
    const stubSmall = mkWavStub(path.join(mt, 's-small.sh'), argsFile, 9);
    const stubBound = mkWavStub(path.join(mt, 's-bound.sh'), argsFile, BOUNDARY);
    const stubOver = mkWavStub(path.join(mt, 's-over.sh'), argsFile, AUDIO_CAP_BYTES + 600);
    ok(fs.existsSync(stubSmall) && (fs.statSync(stubSmall).mode & 0o111) !== 0,
      'M-d-0 扫描面自证：桩文件在盘上且**带可执行位**（否则下面"桩跑了"全是空转，红绿都无意义）');

    const ioOf = (stub: string, over?: { size: number }) => ({
      ...AUDIO_IO,
      probe: () => true, // 桩冒充的正是"PATH 里有 ffmpeg"这一问
      run: (bin: string, args: string[], t: number) => AUDIO_IO.run(stub, args, t),
      ...(over ? { size: async () => over.size } : {}),
    });

    // ① 小件：`-t` 真发给 ffmpeg，且**排在 `-i <源>` 之后**（`-t` 是输出侧选项，排错位置就成了"截输入"）
    const dSmall = await normalizeToWav(src, path.join(mt, 'dst'), ioOf(stubSmall));
    const argv = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf-8').split('\n').filter((l) => l !== '') : [];
    const iIdx = argv.indexOf('-i');
    const tIdx = argv.indexOf('-t');
    ok(tAtOk(argv, iIdx, tIdx),
      'M-d-1 ★★`-t`（时长上限）真发给 ffmpeg，值**由 `MAX_AUDIO_SECONDS` 派生**、且排在 `-i <源>` **之后**'
      + '（`-t` 是输出侧选项——排到 `-i` 前面就变成"只读源的前 819 秒"，语义完全不同）',
      `argv=[${argv.join(' ')}]`);
    ok(dSmall.ok === true && dSmall.truncated === false && dSmall.capSeconds === MAX_AUDIO_SECONDS,
      'M-d-2 **该不命中**：产物只有 9 字节 ⇒ `truncated:false`（闸不是"一律报截断"）');

    // ② ★边界件（恰抵 `-t` 那一档）⇒ 如实标 `truncated`
    const dBound = await normalizeToWav(src, path.join(mt, 'dst'), ioOf(stubBound));
    ok(dBound.ok === true && dBound.truncated === true && dBound.capSeconds === MAX_AUDIO_SECONDS,
      'M-d-3 ★★产物字节 **≥ `MAX_AUDIO_SECONDS × WAV_BYTES_PER_SEC`** ⇒ `truncated:true`'
      + '（"截了就说"——不说则模型会把前 13 分钟当整段总结）', `${BOUNDARY} 字节`);

    // ③ ★超限件 ⇒ 拒（上界由**产物本身**定，不由我们发给 ffmpeg 的那个数定）
    const dOver = await normalizeToWav(src, path.join(mt, 'dst'), ioOf(stubOver));
    ok(dOver.ok === false && dOver.reason === 'normalize_failed'
      && String(dOver.detail).includes(String(AUDIO_CAP_BYTES + 600))
      && String(dOver.detail).includes(String(AUDIO_CAP_BYTES)),
      'M-d-4 ★★`-t` 之外**再回查一次产物体积**：某份 ffmpeg 不认 `-t`（或源容器时长元数据有假）时，'
      + '这一跳是最后一道；detail 把**实际字节与上限**两个数都写出来',
      String(dOver.detail));

    // ④ ★★端到端：`truncated` 的**如实出口**真的到了模型眼前（真 `makeAudioTranscriber` + 真 HTTP 桩）
    //    ⚠ 这里用 `io.size` 注入把"产物多大"定在边界档：真写一份 25MB 的 wav 再 base64 送一圈 HTTP
    //      是**同一件事**的昂贵等价物，而 `size` 正是本模块为判据留的注入缝（同 `probe`）。
    //      "截断的**派生**"已由 ② 的真产物覆盖，本条要证的是**那句话到得了下游**。
    const ioTrunc = ioOf(stubSmall, { size: BOUNDARY });
    const ansOk = { getOptimalModel: async () => ({ url: srv.url, api_key: 'k', model_name: 'm1' }) };
    const rT = await makeAudioTranscriber(ansOk, path.join(mt, 'dstT'), ioTrunc)(src);
    ok(rT.ok === true && rT.text.startsWith('[音频较长，已按本机上限只转写')
      && rT.text.includes(String(MAX_AUDIO_SECONDS)) && rT.text.includes('不完整')
      && rT.text.endsWith('STUB-TRANSCRIPT'),
      'M-d-5 ★★截断的**如实出口**：转写正文**前面**挂一句点名"只转了前 N 秒、后段未转写、内容不完整"，'
      + '正文本身原样在后（先告知、后内容——反过来读者会先看完再发现是残篇）',
      String(rT.text).slice(0, 96) + '…');
    const rN = await makeAudioTranscriber(ansOk, path.join(mt, 'dstN'), ioOf(stubSmall))(src);
    eq(rN, { ok: true, text: 'STUB-TRANSCRIPT' },
      'M-d-6 **该不命中**的反侧（同一份夹具、同一个 ANS 桩，差别**只可能**来自产物体积）：'
      + '未截断时正文**逐字节**就是模型返回的那串——那句告知**不是**无条件挂上去的');
  } finally {
    await srv.close();
    fs.rmSync(mt, { recursive: true, force: true });
  }
}

/** `-t` 的两条形状：排在 `-i <源>` 之后、值取自 `MAX_AUDIO_SECONDS`（切出来便于读断言失败时的 argv）。 */
function tAtOk(argv: string[], iIdx: number, tIdx: number): boolean {
  return iIdx >= 0 && tIdx > iIdx && argv[tIdx + 1] === String(MAX_AUDIO_SECONDS);
}

async function groupMe(): Promise<void> {
  console.log('\n【M-e】装配层端到端：用户附一份源码 ⇒ 开局即入上下文（真 `buildAttachmentParts` + 真 `extractDocText`）');
  const tsBytes = Buffer.from('export const ANSWER = 42;\n', 'utf8');
  const att = await buildAttachmentParts(
    [{ path: '/tmp/m12/mod.ts', fileName: 'mod.ts' }],
    // `extractDoc` 接的是**生产真实现**（不是夹具自造的"返回固定文本"）——
    //   判据要证的是"族分派 → `isDocTextExt` → 取正文"整条链成立，不是这条链被短路后的样子。
    { readFile: () => tsBytes, statSize: () => tsBytes.length, extractDoc: (b, ext) => extractDocText(b, ext) },
    { modelCapabilities: ['chat'] });
  eq([att.outcomes[0].status, att.outcomes[0].reason, att.parts.some((x) => x.type === 'text' && x.text.includes('export const ANSWER = 42;'))],
    ['inlined', undefined, true],
    'M-e-1 ★★一份 `.ts` 附件 ⇒ `inlined` 且正文真进了 parts（M12 前它落 `not_yet_supported`：'
    + '用户发进来一份源码，模型只拿到一个文件名）');

  // 反侧：**同一份夹具**换成 `.bin` ⇒ 仍不留任何正文（闸不是"把附件都当文本塞进去"）
  const binAtt = await buildAttachmentParts(
    [{ path: '/tmp/m12/blob.bin', fileName: 'blob.bin' }],
    { readFile: () => Buffer.concat([Buffer.from('BIN'), Buffer.alloc(64)]), statSize: () => 67, extractDoc: (b, ext) => extractDocText(b, ext) },
    { modelCapabilities: ['chat'] });
  ok(binAtt.outcomes[0].status === 'omitted'
    && !binAtt.parts.some((x) => x.type === 'text' && x.text.includes('BIN')),
    'M-e-2 ★**该不命中**：`.bin` 走 `binary` 族 ⇒ `omitted`、正文一字不进（"源码要进"不等于"什么都要进"）',
    `${binAtt.outcomes[0].status} / ${binAtt.outcomes[0].reason ?? ''}`);

  // 静态接线：`read_file` 的说明里写清了**两道闸**（模型据此知道该改用 offset/limit 或别的工具）
  const roSrc = RD(`${A}/src/main/core/tools/readonly.ts`);
  const desc = (readonlyTools({ workingDir: '/tmp', ctx: {}, db: {}, taskId: 'p', projectId: 'p', readFiles: new Set<string>() } as never).read_file.description) as string;
  ok(desc.includes('整读字节上限') && desc.includes('BOM') && desc.includes('offset'),
    'M-e-3 ★模型**真读到**的说明里写清了两道闸与分页口（说明里不写，模型只能靠"读失败"自行推断）');
  ok(/readPathGuard\(args\.filePath, workingDir\)/.test(roSrc),
    'M-e-4 新闸**没有绕过**入口守卫：`read_file` 仍先过 `readPathGuard`（`..` 遍历 / 敏感路径两条硬红线不动）');
}

// ══════════════════════════════════════════════════════════════════
// 【M-f】M13 文件能力新增：魔数嗅探（判族看内容）+ 视频抽帧（画面那一半）
// ══════════════════════════════════════════════════════════════════
const MF_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function mfCrc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = MF_CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 手写一个**真合法**的 ZIP（本地头 + 中央目录 + EOCD）——本仓不引新依赖，而 `.docx` 判据要餵的
 * 是**真 zip 字节**（`zlib.deflateRawSync` 真 DEFLATE），不是"长得像 zip 的一坨"。
 */
function mfZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const payload = zlib.deflateRawSync(e.data);
    const crc = mfCrc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, payload);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.length, 20); ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + payload.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** 一份最小 `.docx` 的 `word/document.xml`：两段正文 + 一张两格表格 + 一个 XML 实体。 */
const MF_DOCX_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
  + '<w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>Revenue </w:t></w:r><w:r><w:t>&amp; margin</w:t></w:r></w:p>'
  + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>'
  + '<w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
  + '</w:body></w:document>';

/** 该 XML 剥完标签后**应当**长成的样子（段落各自换行、单元格间 `\t`、`&amp;` → `&`）。 */
const MF_DOCX_EXPECT = 'Quarterly report\nRevenue & margin\nA\n\tB';

function mfDocx(): Buffer {
  return mfZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: 'word/document.xml', data: Buffer.from(MF_DOCX_XML, 'utf8') },
  ]);
}

/** 由 hex 造一段"头部字节"喂 `sniffFileType`（真字节，不是"看起来像"）。 */
const mfH = (hex: string): Uint8Array => Buffer.from(hex, 'hex');

/** M-f 用：写一个"冒充 ffmpeg"的 shell 桩，写出 `count` 张帧（产物名由 argv 末位那个 `%03d.jpg` 模板派生）。 */
function mkFramesStub(p: string, argsFile: string, count: number, exitCode = 0): string {
  fs.writeFileSync(p, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${argsFile}"`,
    'out=""',
    'for a in "$@"; do out="$a"; done',
    'i=1',
    `while [ "$i" -le ${count} ]; do`,
    // `$out` 里的 `%03d` 交给 printf 自己换 —— 壳里不掺 sed/awk，跑的就是生产那条 spawn。
    '  f=$(printf "$out" "$i")',
    '  printf \'JPEG\' > "$f"',
    '  i=$((i+1))',
    'done',
    `exit ${exitCode}`,
    '',
  ].join('\n'), { mode: 0o755 });
  return p;
}

async function groupMf(): Promise<void> {
  console.log('\n【M-f】M13：魔数嗅探（判族看**内容**）+ 视频抽帧（**画面**那一半）');

  // ── ① 嗅探正侧：各族都认得出来（真头部字节；一行报出，红在哪一格一眼看得见）────────────
  const yes: Array<[{ family: string; ext?: string }, string, string]> = [
    [{ family: 'image', ext: '.png' }, '89504e470d0a1a0a0000000000000000', 'PNG 8 字节签名'],
    [{ family: 'image', ext: '.jpg' }, 'ffd8ffe000104a46494600010100000100', 'JPEG（FF D8 FF）'],
    [{ family: 'image', ext: '.gif' }, '4749463839610000000000000000', 'GIF89a'],
    [{ family: 'image', ext: '.webp' }, '52494646240000005745425056503820', 'RIFF…WEBP'],
    [{ family: 'audio', ext: '.wav' }, '524946462400000057415645666d7420', 'RIFF…WAVE'],
    [{ family: 'video', ext: '.avi' }, '5249464624000000415649204c495354', 'RIFF…AVI '],
    [{ family: 'video', ext: '.mp4' }, '000000186674797069736f6d00000200', 'ISO-BMFF 品牌 isom'],
    [{ family: 'audio', ext: '.m4a' }, '00000018667479704d34412000000200', 'ISO-BMFF 品牌 M4A '],
    [{ family: 'video', ext: '.mov' }, '00000014667479707174202000000200', 'ISO-BMFF 品牌 qt  '],
    [{ family: 'document', ext: '.pdf' }, '255044462d312e370a0000000000', '%PDF-'],
    [{ family: 'document', ext: '.docx' }, '504b0304140000080000000000000000', 'ZIP 容器（PK\\x03\\x04）'],
    [{ family: 'document', ext: '.doc' }, 'd0cf11e0a1b11ae10000000000000000', 'OLE 复合文档'],
    [{ family: 'audio', ext: '.mp3' }, '4944330300000000000000000000', 'ID3 头 + 版本号 3'],
    [{ family: 'audio', ext: '.ogg' }, '4f67675300020000000000000000', 'OggS'],
    [{ family: 'audio', ext: '.flac' }, '664c61430000002200000000', 'fLaC'],
    [{ family: 'video' }, '1a45dfa3010000000000001f000000', 'EBML（mkv/webm 分不出 ⇒ **不出扩展名**）'],
  ];
  for (const [want, hex, label] of yes) {
    eq(sniffFileType(mfH(hex)), want, `M-f-1 ★嗅出：${label}`, hex);
  }

  // ── ② 嗅探反侧：说不准就 `null`（**不猜**；`null` 的语义是"没有依据"，不是 `binary`）──────
  const no: Array<[Uint8Array | null | undefined, string]> = [
    [mfH('4944337632206973'), '`ID3v2 is…` 是**普通文本**（第 4 字节 `v`=0x76 > 0x0F）——'
      + '若只看 `ID3` 三个字节，这段文本会被判成 mp3'],
    [mfH('787878786674797069736f6d'), '`xxxxftyp…`（盒长非 0）：**内容里带 ftyp 四个字母**的文本不该判成视频'],
    [mfH('4142'), '2 字节头（短于 3 字节）'],
    [null, '`null`（读不到头）'],
    [undefined, '`undefined`'],
    [mfH('524946462400000058464952'), 'RIFF 后跟的不是 WAVE/WEBP/AVI '],
    [mfH('424d00000000000000'), 'BMP（`42 4D`）——**刻意不入表**：`IMAGE_PREVIEW_MIME` 里没有 BMP，'
      + '判成 image 会吐一句"非光栅格式"的**假话**'],
    [mfH('49492a0000000000'), 'TIFF（`49 49 2A 00`）——同上，刻意不入表'],
    [mfH('fffb9000000000'), '裸 MPEG 帧同步（`FF FB`）——刻意不入表'],
    [mfH('fffe41004200'), '★★**UTF-16LE BOM**（`FF FE`）——这一格正是"裸 `FF Fx` 不入表"的**真回归**护卫：'
      + '若按裸帧同步判，`zx_20260924` 刚能解码的 UTF-16 文本会被判成音频'],
  ];
  for (const [head, label] of no) {
    eq(sniffFileType(head), null, `M-f-2 ★**该不命中**（返 null，不猜）：${label}`);
  }
  ok(SNIFF_HEAD_BYTES >= 12,
    'M-f-3 ★预算够长：`SNIFF_HEAD_BYTES` ≥ 12（本表最远要看到**偏移 8 起 4 字节**= 第 12 字节：'
    + 'RIFF 的真类型与 ISO-BMFF 的品牌名都在那儿）', `SNIFF_HEAD_BYTES=${SNIFF_HEAD_BYTES}`);

  const png = kPng();
  const pngHead = (_p: string, n: number): Uint8Array => png.subarray(0, n);
  const docxBytes = mfDocx();

  // ── ③ ★★冲突：`.txt` 里装的是真 PNG ⇒ 按**内容**判族，并把冲突**明说** ────────────────
  const wrong = await buildAttachmentParts(
    [{ path: '/tmp/m13/actually-a-png.txt', fileName: 'actually-a-png.txt' }],
    { readFile: () => png, statSize: () => null, readHead: pngHead },
    { modelCapabilities: ['chat', 'vision'] },
  );
  eq([wrong.outcomes[0].family, wrong.outcomes[0].status, wrong.parts.some((x) => x.type === 'image')],
    ['image', 'inlined', true],
    'M-f-4 ★★`.txt` 里装的是**真 PNG** ⇒ 按内容判族为 `image` 且真送进 parts'
    + '（M13 前：族由扩展名定 ⇒ `not_yet_supported(document .txt)`，模型只看得见文件名）');
  ok(wrong.outcomes[0].marker.includes('按内容判为 image')
    && wrong.outcomes[0].marker.includes('.txt') && wrong.outcomes[0].marker.includes('不符'),
    'M-f-5 ★★冲突**明说**（方案原文「**不静默改用扩展名**」）：marker 里点名"按内容判为 image"'
    + '与"与扩展名「.txt」不符"——悄悄改掉，用户永远不知道自己的件被误认过',
    wrong.outcomes[0].marker);

  // 反侧：同名同字节、只差扩展名 ⇒ **一个字都不加**
  const agree = await buildAttachmentParts(
    [{ path: '/tmp/m13/probe.png', fileName: 'probe.png' }],
    { readFile: () => png, statSize: () => null, readHead: pngHead },
    { modelCapabilities: ['chat', 'vision'] },
  );
  eq([agree.outcomes[0].family, agree.outcomes[0].marker.includes('不符')], ['image', false],
    'M-f-6 ★**该不命中**：族与名一致时**零冲突话**——"什么都没说"在这条设计里是**正面判据**，'
    + '加一句"它们一样"纯属噪音（与 M-f-5 同一份字节、只差扩展名 ⇒ A/B 成立）');

  // ── ④ ★★真 `.docx`：魔数是 ZIP、族同为 `document` ⇒ **族不换、扩展名不被抹** ────────────
  let seenExt = '';
  const dx = await buildAttachmentParts(
    [{ path: '/tmp/m13/report.docx', fileName: 'report.docx' }],
    {
      readFile: () => docxBytes, statSize: () => null, readHead: (_p, n) => docxBytes.subarray(0, n),
      extractDoc: (b, ext) => { seenExt = ext; return extractDocText(b, ext); },
    },
    { modelCapabilities: ['chat'] },
  );
  eq([dx.outcomes[0].family, seenExt, dx.parts.some((x) => x.type === 'text' && x.text.includes('Quarterly report'))],
    ['document', '.docx', true],
    'M-f-7 ★★真 `.docx`（魔数 ZIP、族同为 `document`）⇒ **族不变、扩展名原样交给 `extractDoc`**、正文真进 parts'
    + '（若"嗅到 ZIP 就把它改名成 .docx"，真 `.pdf`/真 `.doc` 的精确扩展名会被抹掉——'
    + '故 `effExt` 只在**换族**时接管）');
  ok(!dx.outcomes[0].marker.includes('不符'), 'M-f-7b 同上反侧：真 `.docx` 不因"魔数是 ZIP"被标冲突');

  // ── ⑤ ★★一份被叫成 `.bin` 的 DOCX ⇒ 族改 document、扩展名由**魔数**接管 ─────────────────
  const binDocx = await buildAttachmentParts(
    [{ path: '/tmp/m13/mystery.bin', fileName: 'mystery.bin' }],
    {
      readFile: () => docxBytes, statSize: () => null, readHead: (_p, n) => docxBytes.subarray(0, n),
      extractDoc: (b, ext) => extractDocText(b, ext),
    },
    { modelCapabilities: ['chat'] },
  );
  eq([binDocx.outcomes[0].family, binDocx.outcomes[0].status,
    binDocx.parts.some((x) => x.type === 'text' && x.text.includes(MF_DOCX_EXPECT))],
    ['document', 'inlined', true],
    'M-f-8 ★★一份被叫成 `.bin` 的 DOCX ⇒ 族改 `document`、扩展名被魔数接管为 `.docx`、**正文真抽出来**'
    + '（M13 前落 `not_yet_supported(binary)`——用户发来的报告模型只看得见一个文件名）');

  // ── ⑥ ★★嗅探在 vision 闸**之前** ──────────────────────────────────────────────────
  const noVis = await buildAttachmentParts(
    [{ path: '/tmp/m13/actually-a-png.txt', fileName: 'actually-a-png.txt' }],
    { readFile: () => png, statSize: () => null, readHead: pngHead },
    { modelCapabilities: ['chat'] },
  );
  eq([noVis.outcomes[0].family, noVis.outcomes[0].reason], ['image', 'model_lacks_vision'],
    'M-f-9 ★★先后次序：一件名叫 `.txt` 的 PNG 出的仍是 `model_lacks_vision`——'
    + '族**先按内容**认成 image，才谈得上"本轮模型有没有 vision"（闸在那之后）');

  const mt = fs.mkdtempSync(path.join(os.tmpdir(), 'rr30-m13f-'));
  try {
    // ── ⑦ ★★默认 `readHead` 真读盘（不注入嗅探口 ⇒ 防"夹具自己把字节喂进去"的自我印证）──────
    const diskPath = path.join(mt, 'on-disk-really.txt');
    fs.writeFileSync(diskPath, png);
    const disk = await buildAttachmentParts(
      [{ path: diskPath, fileName: 'on-disk-really.txt' }],
      { readFile: () => png, statSize: () => null },
      { modelCapabilities: ['chat', 'vision'] },
    );
    eq([disk.outcomes[0].family, disk.parts.some((x) => x.type === 'image')], ['image', true],
      'M-f-10 ★★默认 `readHead` **真读盘**：盘上那份 `.txt` 里的真 PNG 字节仍被认出'
      + '（注入的 `readFile` 与盘上内容可以不是同一个东西——嗅探读的是盘上那 16 字节，不替它们做主）');

    const missing = await buildAttachmentParts([{ path: path.join(mt, 'nope.png'), fileName: 'nope.png' }], {});
    eq([missing.outcomes[0].status, String(missing.outcomes[0].reason).startsWith('read_failed')], ['failed', true],
      'M-f-11 嗅探读不到头 ⇒ 返 `null`、**不抛**（落回扩展名判族），随后照旧 `read_failed`——'
      + '嗅探的失败不许把整条装配搞挂（本函数"永不抛"的总纪律）');

    // ── ⑧ 抽帧：真 shell 桩，判决**读产物** ─────────────────────────────────────────────
    const argsF = path.join(mt, 'frames-args.txt');
    const fdir = path.join(mt, 'frames');
    const stub3 = mkFramesStub(path.join(mt, 'ff-frames.sh'), argsF, 3);
    ok(fs.existsSync(stub3) && (fs.statSync(stub3).mode & 0o111) !== 0,
      'M-f-12 扫描面自证：抽帧桩在盘上且**带可执行位**（否则下面"抽出来了"全是空转）');
    let seenT = -1;
    const fio = {
      ...FRAMES_IO,
      probe: () => true, // 桩冒充的正是"PATH 里有 ffmpeg"这一问
      run: (_bin: string, args: string[], t: number) => { seenT = t; return FRAMES_IO.run(stub3, args, t); },
    };
    const src = path.join(mt, 'clip.mp4');
    fs.writeFileSync(src, Buffer.from('not-a-real-mp4'));

    const r3 = await extractVideoFrames(src, fdir, fio);
    ok(r3.ok === true && r3.frames.length === 3 && r3.dropped === 0
      && r3.windowSeconds === VIDEO_FRAMES_WINDOW_SEC && r3.intervalSeconds === VIDEO_FRAME_INTERVAL_SEC,
      'M-f-13 ★★真抽帧：桩写出 3 张 ⇒ `frames.length === 3`（帧数是**数出来的**，不是按 `-frames:v` 假定的 8；'
      + '短的源自然少出几帧）、覆盖窗口/间隔由真源派生',
      r3.ok ? `${r3.frames.length} 帧 / ${r3.windowSeconds}s / ${r3.intervalSeconds}s` : r3.reason);
    eq(seenT, FRAME_EXTRACT_TIMEOUT_MS,
      'M-f-14 超时值取 `NORMALIZE_TIMEOUT_MS`（不另设一个更小的数：源可能躺在网络盘上）');

    const fargv = fs.readFileSync(argsF, 'utf-8').split('\n').filter((l) => l !== '');
    ok(fargv.includes(`fps=1/${VIDEO_FRAME_INTERVAL_SEC}`) && fargv.includes('-frames:v')
      && fargv.includes(String(VIDEO_FRAME_COUNT)) && fargv.includes('image2') && fargv.includes('-y')
      && fargv.indexOf('-i') < fargv.indexOf('-vf') && fargv[fargv.length - 1].endsWith('%03d.jpg'),
      'M-f-15 ★★给 ffmpeg 的 argv 逐项对：`fps=1/${VIDEO_FRAME_INTERVAL_SEC}`、'
      + `\`-frames:v ${VIDEO_FRAME_COUNT}\`、\`-f image2\`、\`-i\` 在 \`-vf\` **之前**、末位是 \`%03d.jpg\` 产物模板`,
      `argv=[${fargv.join(' ')}]`);

    // 接线缝：`makeFrameExtractor(dstDir, io)` 真把这两样转下去（真件、非等价物）
    const viaFactory = await makeFrameExtractor(path.join(mt, 'fdir2'), fio)(src);
    ok(viaFactory.ok === true && viaFactory.frames.length === 3,
      'M-f-16 ★接线缝成立：`makeFrameExtractor(dstDir, io)` 转下去的正是 `extractVideoFrames(src, dstDir, io)`'
      + '（同 `makeAudioTranscriber` 的形状与理由：纯组合、零重依赖 ⇒ 受控回归跑的就是生产那条路）');

    // ── ⑨ 判决**读产物，不读退出码**（承 `normalizeToWav` 同一把尺）＋四种零产物各说各的真因 ──
    const emptyDirA = path.join(mt, 'empty-a');
    const rCode0 = await extractVideoFrames(src, emptyDirA, { ...FRAMES_IO, probe: () => true, run: async () => ({ code: 0, timedOut: false }) });
    ok(rCode0.ok === true && rCode0.frames.length === 0 && rCode0.dropped === 0,
      'M-f-17 ★★退出码 0、**一帧没写出来** ⇒ `ok:true` **空集**（源里没有可解码的画面是"这批字节里没画面"，'
      + '不是故障——如实报空，由装配层说"未抽到帧"）');
    const rCode1Empty = await extractVideoFrames(src, path.join(mt, 'empty-b'),
      { ...FRAMES_IO, probe: () => true, run: async () => ({ code: 1, timedOut: false, stderr: 'boom-detail' }) });
    ok(rCode1Empty.ok === false && rCode1Empty.reason.includes('退出码 1') && rCode1Empty.reason.includes('boom-detail'),
      'M-f-18 ★零产物 + 退出码非 0 ⇒ **拒**，且真因（退出码与 stderr 头一段）一起带出',
      rCode1Empty.ok ? 'ok' : rCode1Empty.reason);

    const stub1x1 = mkFramesStub(path.join(mt, 'ff-frames-1x1.sh'), argsF, 2, 1);
    const rProd1 = await extractVideoFrames(src, path.join(mt, 'frames-c'),
      { ...FRAMES_IO, probe: () => true, run: (_b, args, t) => FRAMES_IO.run(stub1x1, args, t) });
    ok(rProd1.ok === true && rProd1.frames.length === 2,
      'M-f-19 ★★**有产物就是成了**：退出码非 0 只是"末帧上抱怨了一句"（`image2` 偶发），'
      + '文件已经落了盘 ⇒ `ok:true` 带 2 帧（"判决读产物，不读退出码"）',
      rProd1.ok ? `${rProd1.frames.length} 帧` : rProd1.reason);

    const rTimeout = await extractVideoFrames(src, path.join(mt, 'empty-c'),
      { ...FRAMES_IO, probe: () => true, run: async () => ({ code: null, timedOut: true }) });
    ok(rTimeout.ok === false && rTimeout.reason.includes('超时'),
      'M-f-20 零产物 + 超时 ⇒ 说"超时"（不挤成一句"抽不了"）', rTimeout.ok ? 'ok' : rTimeout.reason);
    const rErr = await extractVideoFrames(src, path.join(mt, 'empty-d'),
      { ...FRAMES_IO, probe: () => true, run: async () => ({ code: null, timedOut: false, error: 'ENOENT' }) });
    ok(rErr.ok === false && rErr.reason.includes('起不来') && rErr.reason.includes('ENOENT'),
      'M-f-21 零产物 + 起不来 ⇒ 说"起不来"并带真因', rErr.ok ? 'ok' : rErr.reason);

    // 单帧撞上限 ⇒ 丢这一帧并计数，**不**把整件判死
    const fdirDrop = path.join(mt, 'frames-drop');
    const stub2 = mkFramesStub(path.join(mt, 'ff-frames-2.sh'), argsF, 2);
    const rDrop = await extractVideoFrames(src, fdirDrop,
      { ...FRAMES_IO, probe: () => true, run: (_b, args, t) => FRAMES_IO.run(stub2, args, t), size: async () => IMAGE_MAX_BYTES + 1 });
    ok(rDrop.ok === true && rDrop.frames.length === 0 && rDrop.dropped === 2,
      'M-f-22 ★★超过图片内联上限的帧**丢这一帧并计数**（`dropped`），不把整件判死：'
      + '丢的是画面里的一张，不是这件附件（装配层据此如实说"另 N 帧未送"）',
      rDrop.ok ? `frames=${rDrop.frames.length} dropped=${rDrop.dropped}` : rDrop.reason);

    // 判据面自证：**别人的帧不算**（前缀带源路径摘要 ⇒ 同目录里别的任务/别的源的帧不进来）
    const fdirForeign = path.join(mt, 'frames-foreign');
    fs.mkdirSync(fdirForeign, { recursive: true });
    const foreign = path.join(fdirForeign, 'other.mp4.deadbeef.frame-001.jpg');
    fs.writeFileSync(foreign, Buffer.from('JPEG'));
    const rForeign = await extractVideoFrames(src, fdirForeign,
      { ...FRAMES_IO, probe: () => true, run: async () => ({ code: 0, timedOut: false }) });
    ok(rForeign.ok === true && rForeign.frames.length === 0,
      'M-f-23 ★判据面**按源摘要过滤**：同目录里 `other.mp4.deadbeef.frame-001.jpg` 这种**别人的帧不算数**'
      + '（`zx_20260929` M3「用完就收」把这些产物按 taskId 分目录 ⇒ 同目录确实会有别人的东西）');

    // 反侧：ffmpeg 不在 ⇒ 拒，且**一次都没跑**（不白起一个进程）
    let runs = 0;
    const rNoFf = await extractVideoFrames(src, path.join(mt, 'frames-noff'),
      { ...FRAMES_IO, probe: () => false, run: async () => { runs++; return { code: 0, timedOut: false }; } });
    ok(rNoFf.ok === false && rNoFf.reason.includes('ffmpeg_missing') && runs === 0,
      'M-f-24 ★**该不命中**：PATH 里没有 ffmpeg ⇒ 如实拒（`ffmpeg_missing`）且 `run` **零次调用**'
      + '（同 `normalizeToWav` 的先探后跑）', rNoFf.ok ? 'ok' : rNoFf.reason);

    // ── ⑩ 装配层端到端：音轨 + 画面两半各自如实 ──────────────────────────────────────────
    const vidIo = (opts: {
      frames?: (p: string) => Promise<VideoFramesResult>;
      caps?: readonly string[];
    }) => buildAttachmentParts(
      [{ path: '/tmp/m13/clip.mp4', fileName: 'clip.mp4' }],
      {
        readFile: (p) => (p.endsWith('.jpg') ? Buffer.from([0xff, 0xd8, 0xff, 0xd9]) : Buffer.from('video-bytes')),
        statSize: () => null,
        readHead: () => null, // 'not-a-…' 那串字节嗅不出 ⇒ 不换族（守住 R2 M2-3 的夹具形态）
        transcribeAudio: async () => ({ ok: true, text: '这是会议录音。' }),
        ...(opts.frames ? { extractFrames: opts.frames } : {}),
      },
      opts.caps ? { modelCapabilities: opts.caps } : undefined,
    );
    const fA = '/tmp/m13/clip.abc12345.frame-001.jpg';
    const fB = '/tmp/m13/clip.abc12345.frame-002.jpg';
    const frOk = async (): Promise<VideoFramesResult> => ({
      ok: true, frames: [{ path: fA, size: 4 }, { path: fB, size: 4 }],
      windowSeconds: VIDEO_FRAMES_WINDOW_SEC, intervalSeconds: VIDEO_FRAME_INTERVAL_SEC, dropped: 0,
    });

    const vis = await vidIo({ frames: frOk, caps: ['chat', 'vision'] });
    eq([vis.parts.filter((x) => x.type === 'image').length,
      vis.outcomes[0].marker.includes(`画面已抽 2 帧`), vis.outcomes[0].marker.includes('画面未处理')],
      [2, true, false],
      'M-f-25 ★★有 vision ⇒ 画面真送进去：**2 个 image part** 进了 parts、marker 说"已抽 2 帧"'
      + '且**不说**"画面未处理"（做成了就说做成了）');

    const nv = await vidIo({ frames: frOk, caps: ['chat'] });
    eq([nv.parts.filter((x) => x.type === 'image').length,
      nv.outcomes[0].marker.includes('不具备 vision 能力，未抽帧')], [0, true],
      'M-f-26 ★★方案 §2-M13-4 的硬约束「**依赖 M10 的按能力配图**，否则等于给非视觉模型塞图」：'
      + '清单不含 `vision` ⇒ 连抽都不抽、一个 image part 都没有，且如实说为什么');

    let nvCalls = 0;
    const nvCount = await vidIo({ frames: async () => { nvCalls++; return frOk(); }, caps: ['chat'] });
    eq(nvCalls, 0,
      'M-f-27 ★★反证：上面那条不是"抽了但不送"——`extractFrames` **零次调用**'
      + '（抽了也送不进去，白烧一次 ffmpeg 与 8 张图的尺寸闸）', `calls=${nvCalls} / ${nvCount.outcomes[0].status}`);

    const noExt = await vidIo({ caps: ['chat', 'vision'] });
    ok(noExt.outcomes[0].status === 'inlined' && noExt.outcomes[0].marker.includes('本机未接抽帧器'),
      'M-f-28 ★没接抽帧器 ⇒ 说"本机**没接**"，不是"抽不到帧"（两件事的处置不同，混成一句就是失实）；'
      + '音轨那半照旧内联（= `rr_zx_20260924` M2-3 的形态）', noExt.outcomes[0].marker);

    const bad = await vidIo({ frames: async () => ({ ok: false, reason: 'frames_failed: 抽帧超时（120s）' }), caps: ['chat', 'vision'] });
    ok(bad.outcomes[0].status === 'inlined' && bad.outcomes[0].marker.includes('抽帧失败：frames_failed')
      && bad.parts.some((x) => x.type === 'text' && x.text.includes('这是会议录音。')),
      'M-f-29 ★抽帧失败 ⇒ **音轨那半照旧内联**（丢的是画面，不是整件），marker 带真因', bad.outcomes[0].marker);

    const thr = await vidIo({ frames: async () => { throw new Error('kaboom'); }, caps: ['chat', 'vision'] });
    ok(thr.outcomes[0].status === 'inlined' && thr.outcomes[0].marker.includes('抽帧失败：frames_threw'),
      'M-f-30 ★抽帧器**抛了** ⇒ 装配层不塌（`buildAttachmentParts` 永不抛），marker 带 `frames_threw`', thr.outcomes[0].marker);

    // 抽帧成功却一帧没有 ⇒ 第四态措辞
    const zero = await vidIo({
      frames: async () => ({ ok: true, frames: [], windowSeconds: VIDEO_FRAMES_WINDOW_SEC, intervalSeconds: VIDEO_FRAME_INTERVAL_SEC, dropped: 0 }),
      caps: ['chat', 'vision'],
    });
    ok(zero.outcomes[0].marker.includes('未抽到帧'),
      'M-f-31 ★抽帧成功但**一帧没有** ⇒ "未抽到帧"（纯音频流/坏容器/空文件——与"没接器""不具备能力""抽帧失败"三态各说各的）',
      zero.outcomes[0].marker);

    // ── ⑪ 静态接线：新缝**真的**接上了（"只建接口不接，全量回归照样全绿"）────────────────
    const execSrc = RD(`${A}/src/main/core/agent-executor.ts`);
    const execArgs = argsByDecl(execSrc, 'await buildAttachmentParts(');
    ok(execArgs.length > 80, 'M-f-32 ★切片自证：`buildAttachmentParts(` 的**整份实参**非空', `${execArgs.length} 字符`);
    ok(/extractFrames: makeFrameExtractor\(/.test(execArgs),
      'M-f-33 ★★`extractFrames` 这个缝**真接在生产调用点上**（只加接口不传 ⇒ 抽帧永不发生，而全量回归仍全绿）');
    const auArgs = (execArgs.match(/makeAudioTranscriber\(([^)]*)\)/)?.[1] ?? '').split(',').map((s) => s.trim());
    const frArg = execArgs.match(/makeFrameExtractor\(([^)]*)\)/)?.[1] ?? '';
    ok(frArg !== '' && auArgs.includes(frArg),
      'M-f-34 ★★两半**同一个落点**：`makeFrameExtractor(X)` 的 X 正是 `makeAudioTranscriber(…)` 的**末位实参**'
      + '（同一个 taskId 子目录 ⇒ 任务收口时 `cleanTranscribeTmp` 一次收掉 wav 与帧，不新养一处收尾）',
      `audio[${auArgs.join(', ')}] / frames[${frArg}]`);

    const inlSrc = RD(`${A}/src/main/core/attachment-inline.ts`);
    // zx_20261018_2 批二：类型引从 `{ VideoFramesResult }` 增到 `{ VideoFramesResult, VideoFrameOptions }`。
    // 判据**不钉名单内容**（名单会随接线合法增长），而钉**边本身的性质**：凡从 video-frames 进口，必为 `import type`。
    const vfImports = inlSrc.match(/^\s*import\s+(?:type\s+)?[^;]*from '\.\/video-frames\.js';/gm) ?? [];
    ok(vfImports.length > 0 && vfImports.every((s) => /^\s*import type\s/.test(s)),
      'M-f-35 ★★装配层对 `video-frames` **只有类型边**（`import type`）：本模块被 ~10 个 rr 直接 import，'
      + '加一条运行边等于让那些脚本每次多加载一整张模块图（编译后类型引**不存在**）',
      `${vfImports.length} 处：${vfImports.map((s) => s.trim().slice(0, 60)).join(' | ')}`);
    ok(inlSrc.includes('fr.windowSeconds') && inlSrc.includes('fr.intervalSeconds') && !/\b720\b/.test(inlSrc),
      'M-f-36 ★覆盖窗口那句**由帧结果带出**（用 `fr.windowSeconds`/`fr.intervalSeconds`），'
      + '装配层**不手抄** 720/90 这类派生数（手抄的那个改了帧数即漂）');
    eq(VIDEO_FRAMES_WINDOW_SEC, VIDEO_FRAME_COUNT * VIDEO_FRAME_INTERVAL_SEC,
      'M-f-37 ★窗口**由两个数派生**（`VIDEO_FRAMES_WINDOW_SEC === VIDEO_FRAME_COUNT × VIDEO_FRAME_INTERVAL_SEC`），'
      + '不手写 720');
    const vfSrc = RD(`${A}/src/main/core/video-frames.ts`);
    ok(/dstDir: string = TRANSCRIBE_TMP_DIR/.test(vfSrc),
      'M-f-38 ★缺省落点与音轨**同一个目录**（`TRANSCRIBE_TMP_DIR`：落在 `os.tmpdir()` 而**不落** `data/attachments/`'
      + '——后者是入站**原件**的目录，往里塞派生物会让"哪些是用户给的件"失真）');
    const kindsSrc = RD(`${A}/src/main/core/attachment-kinds.ts`);
    ok(!/^\s*import\s/m.test(kindsSrc) && !/\bBuffer\s*[.(]/.test(kindsSrc),
      'M-f-39 ★嗅探的真源**仍零依赖**（无 `import` 语句、无 `Buffer` **用法**）：renderer 引得动、rr 直跑真实现。'
      + '⚠ 这里判的是**用法**（`Buffer.`/`Buffer(`）而非"字面出现"——注释里那句"不引 `Buffer`"正是一个反例：'
      + '按"字面出现"判，会把一条**守护声明**判成**违规**（本仓"断言名冒充覆盖面"的镜像错法）');
    ok(/IMAGE_PREVIEW_MIME\[path\.extname\(f\.path\)/.test(inlSrc),
      'M-f-40 ★帧的 MIME 仍取 `IMAGE_PREVIEW_MIME`（**既有那张表**）——本模块不另立一份 MIME 词表');
  } finally {
    fs.rmSync(mt, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════════
// 【M-g】M14 · 自愈不再假成功（结果态五态 · 四个调用点逐点核）+ 漏账补齐（收敛/启动回归同走账）
// ══════════════════════════════════════════════════════════════════

/**
 * M-g 夹具：在 `L_SCHEMA`（已能真跑 `reconcileStalledSubtasks` / `pauseTask`）之上再补两张表——
 *   `wa_deliverables`（第 1 项守护进程）· `wa_memories`（启动回归第 3 项）。
 *   ⚠ zx_20261002 M16-②：原还补了 `ans_audit_logs`（旧第 5 项断路器）——那是 ANS 侧表、本库永远查不到、
 *     全仓也无生产者，该检查已随生产代码**显式删除**；夹具再造这张表＝给一条已不存在的查询撑场面。
 * 自愈账本仍**直接引生产建表语句**（`L_SCHEMA` 尾部已拼 `SELF_HEALING_LOGS_DDL`），不手抄——手抄一份的话，
 * 生产加列后夹具会悄悄变"窄"，读语句抛错被 `catch` 吞成空数组 ⇒ 断言假绿（本仓已吃过一次）。
 */
const MG_SCHEMA = L_SCHEMA + `
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, name TEXT,
  type TEXT, status TEXT, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_memories (id TEXT PRIMARY KEY, content TEXT DEFAULT '');
`;

function mgdb(): AnyDb { const d = new DatabaseSync(':memory:') as unknown as AnyDb; d.exec(MG_SCHEMA); return d; }

/** 造一条 `running` 但心跳陈旧的守护成果（第 1 项的靶子）。 */
function mgDaemon(db: AnyDb, id: string, name: string, ageMin: number): void {
  db.prepare(`INSERT INTO wa_deliverables (id, name, type, status, updated_at)
    VALUES (?, ?, 'daemon', 'running', datetime('now', ?))`).run(id, name, `-${ageMin} minutes`);
}

interface MgLog {
  anomaly: string; action: string; success: number; outcome: string | null; detail: string | null;
}
const mgLogCount = (db: AnyDb) =>
  (db.prepare('SELECT COUNT(*) AS c FROM wa_self_healing_logs').get() as { c: number }).c;
/** 按 `anomaly` 前缀取最新一笔账（同秒行靠 `rowid` 定序）。 */
const mgLogByPrefix = (db: AnyDb, prefix: string): MgLog | undefined =>
  db.prepare('SELECT anomaly, action, success, outcome, detail FROM wa_self_healing_logs WHERE anomaly LIKE ? ORDER BY rowid DESC LIMIT 1')
    .get(`${prefix}%`) as MgLog | undefined;
/** 断言"确实抛"（用于"改前的老表没有这一列"的反证）。 */
function mgThrows(label: string, fn: () => unknown): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  ok(threw, label);
}

function groupMg(): void {
  console.log('\n【M-g】M14 · 自愈结果态（靶心：不再把"仅记录/交人工"记成假成功）+ 漏账补齐');

  // ── ① 词表是**唯一真源**，且 `success` 由它派生（M14-1）────────────────────────────
  // ⚠ zx_20261002 M12-1 有意加宽到**六态**（增 `pending_recheck` 待复验）："当次动作做成了"与
  //   "病真的消了"从此是两个词。改宽是本轮**设计**，故此处同步 5 → 6（不是放宽，是随真源走）。
  eq(HEAL_OUTCOMES.length, 6, 'M-g-1 ★结果态词表**恰六态**（M12-1 增 `pending_recheck`；再改宽/改窄即红）');
  ok(['recorded', 'needs_human', 'skipped_alarm'].every((o) => (HEAL_OUTCOMES as readonly string[]).includes(o)),
    'M-g-2 ★★"仅记录 / 需人工 / 已熔断"三态**在册**——改前它们**无处可去**，只能挤进 `success` 二值列，'
    + '于是界面上"什么也没做、只记了一笔"与"真的修好了"长得一模一样（这就是靶心）');
  ok(HEAL_OUTCOMES.every((o) => (HEAL_OUTCOME_LABEL[o] ?? '').length > 0),
    'M-g-3 五态各有中文标签（界面与日志共用一张表，改词只改一处）',
    HEAL_OUTCOMES.map((o) => `${o}=${HEAL_OUTCOME_LABEL[o]}`).join(' · '));
  eq(
    (HEAL_OUTCOMES as readonly HealOutcome[]).map((o) => outcomeIsSuccess(o)),
    [true, false, false, false, false, false],
    'M-g-4 ★★`success` 列的唯一判据：**只有** `healed` 算办成（`recorded` **不算**——这正是本轮靶心；'
    + '`pending_recheck` 更不算，它**尚未**被复验证实；写库与回退读**同一把尺**）');
  eq(
    [isHealOutcome('healed'), isHealOutcome('成功'), isHealOutcome(null), isHealOutcome(1)],
    [true, false, false, false],
    'M-g-5 `isHealOutcome` 两侧：认识的字符串认，中文/数字/空一律不认（不把别处的词当结果态）');

  // ── ② 存量行如实回退（M14-1）───────────────────────────────────────────────────
  eq([healOutcomeOf({ success: 1, outcome: null }), healOutcomeOf({ success: 0, outcome: null })], ['healed', 'failed'],
    'M-g-6 ★存量行（`outcome` 为 NULL）按 `success` **如实回退**——老账本来就只有二值，'
    + '不凭空补一个 `recorded`（那是无据；"不假装当时分得更细"）');
  eq([healOutcomeOf({ success: 1, outcome: 'recorded' }), healOutcomeOf({ success: 0, outcome: 'needs_human' })],
    ['recorded', 'needs_human'],
    'M-g-7 ★新列**优先于**旧列：即便两者不一致也照新列说（`success` 是**派生列**，不是真源）');

  // ── ③ 五态各记各的词（真跑 `tryHeal`；含熔断支与抛出支）──────────────────────────
  {
    const db = mgdb();
    eq(mgLogCount(db), 0, 'M-g-8 起手自愈账**为空**（下面 0→N 才是正面断言，G-3）');

    const r1 = tryHeal(db as never, 't1', 'A1', 'act1', () => 'healed');
    const l1 = mgLogByPrefix(db, 'A1');
    const r2 = tryHeal(db as never, 't2', 'A2', 'act2', () => 'recorded');
    const l2 = mgLogByPrefix(db, 'A2');
    const r3 = tryHeal(db as never, 't3', 'A3', 'act3', () => 'needs_human');
    const l3 = mgLogByPrefix(db, 'A3');
    const r4 = tryHeal(db as never, 't4', 'A4', 'act4', () => { throw new Error('boom'); });
    const l4 = mgLogByPrefix(db, 'A4');

    eq([r1, l1?.outcome, l1?.success], ['pending_recheck', 'pending_recheck', 0],
      'M-g-9 **修复成功**⇒ 记 `pending_recheck`（zx_20261002 M12-1：`healFn` 做成只是"这次修好了"，'
      + '须下一轮同类未复发才由 `confirmPendingHeals` 转正 `healed`）');
    eq([r2, l2?.outcome, l2?.success], ['recorded', 'recorded', 0],
      'M-g-10 ★★**仅记录**：`outcome=recorded` 且 `success=0`——改前这一支把 `success` 写成 1，'
      + '界面上与"真的修好了"同形（**假成功**，本轮靶心）');
    eq([r3, l3?.outcome, l3?.success], ['needs_human', 'needs_human', 0],
      'M-g-11 ★★**需人工**：`success=0`——"机器看清了、只好交给您"不是"修好了"');
    eq([r4, l4?.outcome, l4?.success, l4?.detail?.startsWith('error: ')], ['failed', 'failed', 0, true],
      'M-g-12 **修复动作抛错**：记 `failed`（这是**真失败**，与上面两支"没动手"分开）');

    // 熔断支：同一异常 24h 内已 3 次 ⇒ 这一路**不再动手**，且如实标"已熔断"
    let called = false;
    for (let i = 0; i < 3; i++) {
      db.prepare("INSERT INTO wa_self_healing_logs (id, anomaly, action, success, outcome) VALUES (?, 'A5', 'seed', 0, 'recorded')").run(`seed-${i}`);
    }
    const r5 = tryHeal(db as never, 't5', 'A5', 'act5', () => { called = true; return 'healed'; });
    const l5 = mgLogByPrefix(db, 'A5');
    eq([r5, l5?.outcome, l5?.success, l5?.action], ['skipped_alarm', 'skipped_alarm', 0, 'ALARM_SKIPPED'],
      'M-g-13 ★**已熔断**：24h 内同异常 ≥3 次 ⇒ 记 `skipped_alarm`（"这一路不再动手，异常**仍在**"），'
      + '而**不是** `failed`（那是"动手了没成"）也不是 `healed`');
    eq(called, false, 'M-g-14 熔断支**真的没调 healFn**——"不再自愈"不是嘴上说的（该不动的一步都没动）');
    eq(mgLogCount(db), 8, 'M-g-15 ★计数正面断言：0 → **8** 笔（5 次 `tryHeal` + 3 行熔断种子）——'
      + '若哪一支被 `catch` 吞掉不写，这里立刻少一笔');
  }

  // ── ④ 四个生产调用点**各给哪个词**（真跑 `runHealthScan`，不造等价物）──────────────
  {
    const db = mgdb();
    mgDaemon(db, 'D1', '守一', 20);                                                            // 项1 ⇒ healed
    lTask(db, { id: 'S1', status: 'executing', ageMin: 20 });                                  // 项2 ⇒ healed
    db.prepare("INSERT INTO wa_jobs (id, type, payload, status, started_at) VALUES ('J1','ai-task','{}','running', datetime('now','-40 minutes'))").run(); // 项3 ⇒ healed
    eq(mgLogCount(db), 0, 'M-g-16 起手账空（0→3 的正面断言）');
    runHealthScan(db as never);
    eq(mgLogCount(db), 3, 'M-g-17 ★三项异常**各留一笔账**（守护 / 任务 / 作业）'
      + '（zx_20261002 M16-②：第 5 项「断路器」已随 `ans_audit_logs` 查询一并显式删除，故 4→3）');

    // 动作**真做了**（否则"结果态"是在给一件没发生的事记账）
    eq((db.prepare("SELECT status FROM wa_deliverables WHERE id = 'D1'").get() as { status: string }).status, 'stale',
      'M-g-18 项1的动作真落地：守护成果已标 `stale`');
    eq(lStatus(db, 'S1'), 'paused', 'M-g-19 项2的动作真落地：超时任务已 `paused`（走 `pauseTask` 唯一写入口）');
    eq((db.prepare("SELECT status FROM wa_jobs WHERE id = 'J1'").get() as { status: string }).status, 'failed',
      'M-g-20 项3的动作真落地：孤儿作业已标 `failed`');

    const d = mgLogByPrefix(db, '守护进程');
    const t = mgLogByPrefix(db, '任务');
    const j = mgLogByPrefix(db, '作业');
    // zx_20261002 M12-1：三项处置由 `healed` 改为 `pending_recheck`——动作**真做了**（下面三条各自
    //   断言状态落地，故这不是"什么都没做"），但"病已消"须待下一轮复验。判据随之如实改词。
    eq([d?.outcome, d?.success], ['pending_recheck', 0], 'M-g-21 守护进程无心跳 ⇒ `pending_recheck`（动作已做、待复验）');
    eq([t?.outcome, t?.success], ['pending_recheck', 0], 'M-g-22 任务超时 ⇒ `pending_recheck`');
    eq([j?.outcome, j?.success], ['pending_recheck', 0], 'M-g-23 孤儿作业 ⇒ `pending_recheck`');
    // zx_20261002 M16-②：原 M-g-24（断路器那一支记 `needs_human` 而非假成功）随该支一并**删除**——
    //   被删的不是"记账方式"，而是整条查询：`ans_audit_logs` 不在桌面库、全仓无生产者。
    //   该支的存在性由 `rr_zx_20261002` 的 M-2-b/M-2-c（`runHealthScan` 体内恰 3 处 `tryHeal`）继续钉住。
  }

  // ── ⑤ 收敛 / 救起**同走这本账**（真跑 `reconcileStalledSubtasks`，M14-2）──────────
  {
    const db = mgdb();
    lTask(db, { id: 'P1', status: 'paused', ctx: { pause_reason: 'exec_timeout' } });  // 父"自身执行被打断"
    lTask(db, { id: 'K1', status: 'pending', parent: 'P1' });                          // 无前置 ⇒ 该被**救起**
    lTask(db, { id: 'P2', status: 'paused', ctx: { pause_reason: 'children_incomplete' } });
    lTask(db, { id: 'DEAD', status: 'failed' });
    lTask(db, { id: 'K2', status: 'pending', parent: 'P2', deps: 'DEAD' });            // 有死前置 ⇒ 该被**标 failed**
    eq(mgLogCount(db), 0, 'M-g-25 起手账空');
    const rec = reconcileStalledSubtasks(db as never);
    eq([rec.dispatched, rec.reconciled], [['K1'], ['K2']],
      'M-g-26 夹具自证：本轮**确有两件事发生**（救起 K1 / 标失败 K2）——账要能与事对上，不是凭空多两行');
    eq(mgLogCount(db), 2, 'M-g-27 ★★两件事**各留一笔账**：改前本路**只 `logger` 不落库**，诊断页'
      + '「最近自愈记录」看不见这类救起/标失败（方案 §1.6「留痕空洞」）');
    const d = mgLogByPrefix(db, '父执行被打断的悬空子任务');
    const r = mgLogByPrefix(db, '悬挂子任务无出路');
    eq([d?.action, d?.outcome, d?.success], ['派发ai-task救起', 'healed', 1],
      'M-g-28 救起那一笔：`ai-task` 确实入了队 ⇒ 办了事 ⇒ `healed`');
    eq([r?.action, r?.outcome, r?.success, (r?.detail ?? '').includes('前置已失败')],
      ['标failed+真因', 'healed', 1, true],
      'M-g-29 标失败那一笔：`detail` 记的是**真因**（取自 `depBlockInfo` 唯一真源的那句"前置已失败：…"），'
      + '诊断页据此能说清"为什么这一笔被判无出路"');
  }

  // ── ⑥ 启动回归**只记失败**（真跑 `runStartupRegressionCheck`：两个标本一起试）────────
  {
    // 标本甲（该**不**记）：三项全过 ⇒ 一笔账都不写。"通过的检查不是自愈事件，写进去只会把账淹掉"。
    const okDb = mgdb();
    eq(mgLogCount(okDb), 0, 'M-g-30 起手账空');
    runStartupRegressionCheck(okDb as never);
    eq(mgLogCount(okDb), 0,
      'M-g-31 ★★三项全过 ⇒ **零记账**（这一侧是必须的：只有"该记"的标本就分不清"只记失败"与"无条件记一笔"）');

    // 标本乙（该记）：空库 ⇒ `wa_jobs` / `wa_memories` 都不在 ⇒ 两项失败各一笔 `needs_human`。
    const badDb = new DatabaseSync(':memory:') as unknown as AnyDb;
    runStartupRegressionCheck(badDb as never);
    const rows = badDb.prepare('SELECT anomaly, action, success, outcome, detail FROM wa_self_healing_logs ORDER BY rowid').all() as MgLog[];
    eq(rows.length, 2, 'M-g-32 ★两项失败 ⇒ **恰两笔**账（DB 可写性那一项是过了的，故不记）', `实际 ${rows.length} 笔`);
    eq(rows.map((x) => x.anomaly), ['启动回归检查未通过: 调度器可用', '启动回归检查未通过: 记忆系统可用'],
      'M-g-33 账上**点名是哪一项没过**（不是一句笼统的"自检失败"）');
    ok(rows.every((x) => x.outcome === 'needs_human' && x.success === 0 && x.action === '启动回归检查' && x.detail === 'startup_regression'),
      'M-g-34 ★启动回归不通过记 `needs_human`：这不是"能自动修好的故障"，是**叫人来看**（不冒充已修复）');
  }

  // ── ⑦ 存量库补列 + 读面带出新列（真跑 `ensureSelfHealingTable` / `readRecentHealingLogs`）──
  {
    const legacy = new DatabaseSync(':memory:') as unknown as AnyDb;
    // 改前的老表：**没有** `outcome` 列（`CREATE TABLE IF NOT EXISTS` 对已存在的表不生效，故必须另有 ALTER）
    legacy.exec("CREATE TABLE wa_self_healing_logs (id TEXT PRIMARY KEY, anomaly TEXT NOT NULL, action TEXT NOT NULL, success INTEGER DEFAULT 0, detail TEXT, created_at TEXT DEFAULT (datetime('now')))");
    mgThrows('M-g-35 反证：这只老表里**确实没有** `outcome` 列（否则下面的补列判据是空转假绿）',
      () => legacy.prepare('SELECT outcome FROM wa_self_healing_logs').all());
    ok(SELF_HEALING_LOGS_MIGRATIONS.length >= 1, 'M-g-36 补列清单非空（与建表语句同处一文件，改表结构时两者一起看见）');

    ensureSelfHealingTable(legacy as never);
    const cols = (legacy.prepare('PRAGMA table_info(wa_self_healing_logs)').all() as Array<{ name: string }>).map((x) => x.name);
    ok(cols.includes('outcome'),
      'M-g-37 ★★存量库补列**真的补上了**（正面断言列名在场）——不能只断言"不抛"：'
      + '被 `catch {}` 吞掉的 `ALTER` 只有正面断言抓得住（本仓「计数器须有 0→1 正面断言」同族）',
      cols.join(','));

    // 老行（`outcome` 为 NULL）经读面出来仍能如实回退；新行带上五态
    legacy.prepare("INSERT INTO wa_self_healing_logs (id, anomaly, action, success) VALUES ('old1','OLD','act',1)").run();
    logHealing(legacy as never, { anomaly: 'NEW', action: 'act2', outcome: 'recorded' });
    const back = readRecentHealingLogs(legacy as never) as HealingRecord[];
    eq(back.length, 2, 'M-g-38 读面把两行都读出来（起手 0 → 2，G-3）');
    eq([back[0].outcome, back[0].success], ['recorded', 0], 'M-g-39 ★新列经**生产读面**带得出来（诊断页据此显示"仅记录"）');
    eq([back[1].outcome, healOutcomeOf(back[1])], [null, 'healed'],
      'M-g-40 ★老行的 `outcome` 是 NULL（不伪造历史），由 `healOutcomeOf` 按 `success` 如实回退成 `healed`');
  }

  // ── ⑧ 静态：**每一处**写口都带结果态（新增枚举值须穷举全部写入点）────────────────────
  {
    const files = walkTs(`${A}/src/main`);
    ok(files.length > 100, 'M-g-41 扫描面自证：`src/main` 下 ts 文件数合理（"每一处"不能在空集上成立）', `${files.length} 个`);
    const writes = files.flatMap((f) => (RD(f).match(/INSERT INTO wa_self_healing_logs[^`'"]*/g) ?? []).map((s) => ({ f, s })));
    ok(writes.length >= 4, 'M-g-42 扫描面自证：自愈账的写口**非空**（写口一处也没有的话，下面的"全都带"是空转）', `${writes.length} 处`);
    eq(writes.filter((w) => !w.s.includes('outcome')).map((w) => path.relative(root, w.f)), [],
      'M-g-43 ★★自愈账的**每一处** INSERT 都带 `outcome` 列（漏一处就是一笔"结果态为空"的账——'
      + '新列既已承载语义，写入点就得穷举，这是"新增持久化枚举值须穷举全部读取谓词"的写入侧镜像）');
    const src = RD(`${A}/src/main/core/self-healing-monitor.ts`);
    ok(!/healFn: \(\) => boolean/.test(src) && /healFn: \(\) => HealOutcome/.test(src),
      'M-g-44 ★★`tryHeal` 的 `healFn` 签名**已改**（`() => boolean` → `() => HealOutcome`）：'
      + '只改返回类型不改签名则病根结构上仍可达（调用方照旧只能回 `true/false` 两种）');
    ok(/import \{ outcomeIsSuccess, type HealOutcome \} from '\.\/healing-outcome\.js';/.test(src),
      'M-g-45 ★词表**真引**（`self-healing-monitor` 引 `healing-outcome`），不是在本文件里另抄一份五态');
  }

  // ── ⑨ renderer 是词表的**第二个落点**（不在 `src/main` 扫描面内，须单独点名）────────────
  {
    const page = RD(`${A}/renderer/src/pages/DashboardPage.tsx`);
    ok(/from '\.\.\/\.\.\/\.\.\/src\/main\/core\/healing-outcome\.js';/.test(page) && /HEAL_OUTCOME_LABEL/.test(page),
      'M-g-46 ★★渲染层**跨 root 引词表真源**（`healing-outcome.ts` 零 import ⇒ 引得动），不手抄一份五态'
      + '（renderer 不在 `src/main` 扫描面内——第八组那条"每一处写口"扫不到这里）');
    ok(!/h\.success \? '成功' : '失败'/.test(page),
      'M-g-47 ★★旧的二值渲染**已撤**：改前那一行把"仅记录 / 需人工 / 已熔断"**全显示成"失败"**'
      + '（与"真的修好了"只差一个颜色，正是本轮靶心）；这一行不撤，新词表就还没到用户眼前');
    const cls = page.match(/const HEAL_OUTCOME_CLASS: Record<HealOutcome, string> = \{([\s\S]*?)\n\};/);
    const keys = (cls?.[1] ?? '').match(/^\s*(\w+):/gm)?.map((s) => s.trim().replace(':', '')) ?? [];
    eq(keys, [...HEAL_OUTCOMES],
      'M-g-48 ★★观感表的键与词表**逐位对齐**（`Record<HealOutcome, string>` 是穷举：词表再加一态即类型报错，'
      + '不会出现"新态悄悄沿用旧底色"的名不副实）');
    ok(cls !== null, 'M-g-49 观感表在册（`HEAL_OUTCOME_CLASS` 可被定位到，否则上面那条是在空串上比空串）');

    // 产物核实：标签真进了 renderer 包。**搜中文串不搜标识符**——产物 minify 后标识符不可寻。
    const rdistAssets = path.join(root, A, 'renderer/dist/assets');
    if (!fs.existsSync(rdistAssets)) {
      ok(false, 'M-g-50 ★renderer 产物在场（本判据前置：`pnpm --filter @worker-ant/desktop-renderer build` 先行）', rdistAssets);
    } else {
      const bundle = fs.readdirSync(rdistAssets).filter((n) => n.endsWith('.js'))
        .map((n) => fs.readFileSync(path.join(rdistAssets, n), 'utf-8')).join('\n');
      ok(bundle.length > 100_000, 'M-g-50 扫描面自证：renderer 产物非空（不搜标识符——产物是 minify 的）', `${bundle.length} 字节`);
      // 四只**只可能来自本词表**的串：'仅记录'/'需人工'/'已熔断'/'待复验' 在本仓别无他处
      //   （'失败'/'成功' 太常见，不作凭据）。'待复验' 是 zx_20261002 M12-1 新态，同样须真上屏。
      eq(['仅记录', '需人工', '已熔断', '待复验'].filter((s) => !bundle.includes(s)), [],
        'M-g-51 ★★四个标签**真的进了 renderer 产物**（后加入的"待复验"此前无处可显示）');
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// 【M-h】M14-3 · 真健康自检（五面 × 三态 × 一句依据；外部世界全部注入）
// ══════════════════════════════════════════════════════════════════

/**
 * M-h 夹具：`MG_SCHEMA` 之上再补 `wa_event_log` / `wa_settings` / `wa_im_channels`——
 * 凑齐 `NEEDED_TABLES` 九张（`health-check.ts` 的 DB 面按这份清单判"齐备"）。
 */
const MH_SCHEMA = MG_SCHEMA + `
CREATE TABLE wa_event_log (id TEXT PRIMARY KEY);
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT, name TEXT, config TEXT, status TEXT);
`;

function mhdb(): AnyDb { const d = new DatabaseSync(':memory:') as unknown as AnyDb; d.exec(MH_SCHEMA); return d; }

function mhChannel(db: AnyDb, id: string, status: string): void {
  db.prepare('INSERT INTO wa_im_channels (id, channel_type, name, status) VALUES (?, ?, ?, ?)').run(id, 'wechat', id, status);
}

/**
 * M-h 的**固定时刻**（G-4：判据不得依赖真实墙钟）。所有"新鲜/陈旧"都由它作差得出，
 * 与运行 rr 的那一天那一刻无关。
 */
const MH_NOW = 1_700_000_000_000;

/** 取某一面。面是**固定五面**，取不到即判据自身写错（故走 `ok` 报红而不是静默 `undefined`）。 */
function mhItem(report: { items: Array<{ key: string; level: string; evidence: string }> }, key: string) {
  const it = report.items.find((i) => i.key === key);
  ok(!!it, `（内务）报告里应恰有「${key}」这一面`);
  return it as { key: string; level: string; evidence: string };
}

/** 造一份"五面全好"的 deps 基线（各条判据只覆写自己关心的那一两项）。 */
function mhDepsGood(db: AnyDb): Record<string, unknown> {
  return {
    db,
    probeAns: async () => ({ ok: true, status: 200 }),
    scheduler: { isRunning: () => true, lastTickAt: () => MH_NOW - 1_000 },
    diskFree: () => ({ free: 500e9, total: 1000e9 }),
    memory: () => ({ heapUsed: 100e6, rss: 200e6 }),
    now: () => MH_NOW,
  };
}

async function groupMh(): Promise<void> {
  console.log('\n【M-h】M14-3 · 真健康自检（五面 × 三态 × 一句依据；外部世界全部注入）');

  // ── ① 三态词表 + 归并（唯一真源）──────────────────────────────────────────────
  eq(HEALTH_LEVELS.length, 3, 'M-h-1 三态词表**恰三态**（正常 / 降级 / 不可用）');
  ok(HEALTH_LEVELS.every((l) => (HEALTH_LEVEL_LABEL[l] ?? '').length > 0),
    'M-h-2 三态各有中文标签', HEALTH_LEVELS.map((l) => `${l}=${HEALTH_LEVEL_LABEL[l]}`).join(' · '));
  eq(
    [worstHealthLevel(['ok']), worstHealthLevel(['ok', 'degraded']), worstHealthLevel(['degraded', 'unavailable']),
     worstHealthLevel(['ok', 'degraded', 'unavailable']), worstHealthLevel([])],
    ['ok', 'degraded', 'unavailable', 'unavailable', 'ok'],
    'M-h-3 ★★整体取**最差**（不是"平均"）：一面不可用 ⇒ 整体不可用；空集 ⇒ ok');
  ok(HEALTH_LEVEL_RANK.ok < HEALTH_LEVEL_RANK.degraded && HEALTH_LEVEL_RANK.degraded < HEALTH_LEVEL_RANK.unavailable,
    'M-h-4 强弱序单调：ok < degraded < unavailable（数值越大越差，`worstHealthLevel` 据此取最大）');

  // ── ② ANS 面：**真发一次受保护请求**的三态 ─────────────────────────────────────
  {
    const mk = async (r: unknown) => mhItem(await runHealthCheck({ ...(mhDepsGood(mhdb()) as never), probeAns: r as never } as never), 'ans');
    const okItem = await mk(async () => ({ ok: true, status: 200 }));
    eq(okItem.level, 'ok', 'M-h-5 2xx ⇒ `ok`');
    ok(okItem.evidence.includes('200'), 'M-h-5b ★依据里**带实测状态码**（不是一句空的"正常"）', okItem.evidence);
    const d401 = await mk(async () => ({ ok: false, status: 401, detail: 'Invalid signature' }));
    eq(d401.level, 'degraded',
      'M-h-6 ★★401 ⇒ `degraded`（**能连通、身份不对**）——与"连不上"分开：'
      + '合成一个"不可用"就分不出"服务死了"和"我们签名签错了"（M9 的病正是后者）');
    ok(d401.evidence.includes('401') && d401.evidence.includes('Invalid signature'),
      'M-h-6b 依据里**带状态码与上游原文**', d401.evidence);
    const down = await mk(async () => ({ ok: false, status: 0, detail: 'fetch failed' }));
    eq(down.level, 'unavailable', 'M-h-7 传输层失败（`status=0`，超时/连不上）⇒ `unavailable`');
    const thrown = await mk(async () => { throw new Error('boom'); });
    eq(thrown.level, 'unavailable', 'M-h-8 ★探针**抛出** ⇒ `unavailable`（不把异常吞成"正常"）');
    ok(thrown.evidence.includes('boom'), 'M-h-8b 抛出原因如实进依据', thrown.evidence);
    const none = await runHealthCheck({ ...(mhDepsGood(mhdb()) as never), probeAns: null } as never);
    eq(mhItem(none, 'ans').level, 'degraded',
      'M-h-9 ★未配置探针 ⇒ `degraded`（**不当作正常**）——"没测"与"测了没问题"是两件事');
  }

  // ── ③ DB 面：integrity_check + 九张必要表 ─────────────────────────────────────
  {
    eq(NEEDED_TABLES.length, 9, 'M-h-10 必要表清单**恰九张**（改宽/改窄即红）');
    ok(!!NEEDED_TABLES.includes('wa_tasks') && !!NEEDED_TABLES.includes('wa_event_log') && !!NEEDED_TABLES.includes('wa_self_healing_logs'),
      'M-h-10b 清单含引擎离不了的那几张（任务 / 事件日志 / 自愈账）');
    const good = await runHealthCheck(mhDepsGood(mhdb()) as never);
    const dbItem = mhItem(good, 'db');
    eq(dbItem.level, 'ok', 'M-h-11 齐备库 ⇒ `ok`');
    ok(dbItem.evidence.includes('integrity_check=ok'), 'M-h-11b 依据里点名 `integrity_check=ok`', dbItem.evidence);
    const partial = mhdb();
    partial.exec('DROP TABLE wa_deliverables');
    const dbItem2 = mhItem(await runHealthCheck(mhDepsGood(partial) as never), 'db');
    eq(dbItem2.level, 'degraded',
      'M-h-12 ★缺一张必要表 ⇒ `degraded`（integrity 仍 ok，但引擎少一张表跑不起来）');
    ok(dbItem2.evidence.includes('wa_deliverables'),
      'M-h-12b ★依据里**点名缺的是哪张**（不是一句笼统的"库有问题"）', dbItem2.evidence);
    // 反证：integrity 不为 ok ⇒ unavailable（用抛出的桩模拟"检查都跑不了"）
    const brokenDb = { prepare: () => { throw new Error('database disk image is malformed'); } };
    const dbItem3 = mhItem(await runHealthCheck({ ...(mhDepsGood(mhdb()) as never), db: brokenDb } as never), 'db');
    eq(dbItem3.level, 'unavailable', 'M-h-13 ★`integrity_check` 跑不动 ⇒ `unavailable`（**永不抛**，异常如实变依据）');
    ok(dbItem3.evidence.includes('malformed'), 'M-h-13b 异常原文进依据', dbItem3.evidence);
  }

  // ── ④ 调度器面：进程内脉冲优先，回落 cron 心跳 ────────────────────────────────
  {
    const fresh = await runHealthCheck({ ...(mhDepsGood(mhdb()) as never), scheduler: { isRunning: () => true, lastTickAt: () => MH_NOW - 1_000 } } as never);
    const s1 = mhItem(fresh, 'scheduler');
    eq(s1.level, 'ok', 'M-h-14 进程内脉冲新鲜 ⇒ `ok`');
    ok(s1.evidence.includes('1 秒前'), 'M-h-14b 依据带龄期', s1.evidence);

    const stale = await runHealthCheck({ ...(mhDepsGood(mhdb()) as never), scheduler: { isRunning: () => true, lastTickAt: () => MH_NOW - 10 * 60_000 } } as never);
    eq(mhItem(stale, 'scheduler').level, 'degraded',
      'M-h-15 ★脉冲陈旧（>阈值）⇒ `degraded`——进程还在，但时间轮不再转');
    const stopped = await runHealthCheck({ ...(mhDepsGood(mhdb()) as never), scheduler: { isRunning: () => false, lastTickAt: () => MH_NOW } } as never);
    eq(mhItem(stopped, 'scheduler').level, 'degraded', 'M-h-16 `stop()` 之后（`isRunning()`=false）⇒ `degraded`');

    // 边界：恰在阈值上 ⇒ ok（`<=` 而非 `<`，两侧各一只标本）
    const edge = await runHealthCheck({ ...(mhDepsGood(mhdb()) as never), scheduler: { isRunning: () => true, lastTickAt: () => MH_NOW - SCHEDULER_PULSE_STALE_MS } } as never);
    eq(mhItem(edge, 'scheduler').level, 'ok', 'M-h-17 恰在阈值上 ⇒ 仍算 `ok`（`<=` 的边界，与下一条一起把 `<`/`<=` 分开）');
    const over = await runHealthCheck({ ...(mhDepsGood(mhdb()) as never), scheduler: { isRunning: () => true, lastTickAt: () => MH_NOW - SCHEDULER_PULSE_STALE_MS - 1 } } as never);
    eq(mhItem(over, 'scheduler').level, 'degraded', 'M-h-17b 超阈值 1ms ⇒ `degraded`');

    // 回落：无调度器 ⇒ 读心跳文件
    const hbOk = await runHealthCheck({
      ...(mhDepsGood(mhdb()) as never), scheduler: null,
      heartbeatFile: '/x/cron_heartbeat.json',
      readTextFile: () => JSON.stringify({ last_fire: new Date(MH_NOW - 5 * 60_000).toISOString() }),
    } as never);
    const h1 = mhItem(hbOk, 'scheduler');
    eq(h1.level, 'ok', 'M-h-18 ★★无进程内调度器时**回落** `cron_heartbeat.json`：5 分钟前的心跳 ⇒ `ok`');
    ok(h1.evidence.includes('5 分钟前'), 'M-h-18b 依据带心跳龄期', h1.evidence);

    const hbStale = await runHealthCheck({
      ...(mhDepsGood(mhdb()) as never), scheduler: null,
      heartbeatFile: '/x/cron_heartbeat.json',
      readTextFile: () => JSON.stringify({ last_fire: new Date(MH_NOW - 40 * 60_000).toISOString() }),
    } as never);
    eq(mhItem(hbStale, 'scheduler').level, 'unavailable', 'M-h-19 无调度器 + 心跳超 30 分钟 ⇒ `unavailable`');

    const hbBad = await runHealthCheck({
      ...(mhDepsGood(mhdb()) as never), scheduler: null,
      heartbeatFile: '/x/cron_heartbeat.json', readTextFile: () => 'not json',
    } as never);
    const h2 = mhItem(hbBad, 'scheduler');
    eq(h2.level, 'unavailable', 'M-h-20 心跳文件读不动 ⇒ `unavailable`（不是"正常"）');
    ok(h2.evidence.includes('读不到'), 'M-h-20b 如实说"读不到"', h2.evidence);

    const noHb = await runHealthCheck({ ...(mhDepsGood(mhdb()) as never), scheduler: null, heartbeatFile: null } as never);
    eq(mhItem(noHb, 'scheduler').level, 'degraded', 'M-h-21 既无调度器也无心跳配置 ⇒ `degraded`（**无法判定**，不当正常）');
  }

  // ── ⑤ IM 面：口径引真源，再分健康/不健康 ──────────────────────────────────────
  {
    const none = mhdb();
    eq(mhItem(await runHealthCheck(mhDepsGood(none) as never), 'im').level, 'unavailable', 'M-h-22 零渠道 ⇒ `unavailable`');
    const onlyInactive = mhdb();
    mhChannel(onlyInactive, 'c1', 'inactive');
    eq(mhItem(await runHealthCheck(mhDepsGood(onlyInactive) as never), 'im').level, 'unavailable',
      'M-h-23 ★反证：**只有 inactive** ⇒ `unavailable`（若把 inactive 也算启用，零渠道的机器会报"健康"）');
    const healthy = mhdb();
    mhChannel(healthy, 'c1', 'running');
    mhChannel(healthy, 'c2', 'active');
    const imOk = mhItem(await runHealthCheck(mhDepsGood(healthy) as never), 'im');
    eq(imOk.level, 'ok', 'M-h-24 启用渠道全健康 ⇒ `ok`');
    ok(imOk.evidence.includes('2 个启用渠道'), 'M-h-24b 依据带启用渠道数', imOk.evidence);
    const bad = mhdb();
    mhChannel(bad, 'c1', 'running');
    mhChannel(bad, 'c2', 'error');
    mhChannel(bad, 'c3', 'pending');
    const imBad = mhItem(await runHealthCheck(mhDepsGood(bad) as never), 'im');
    eq(imBad.level, 'degraded', 'M-h-25 有启用渠道不健康（error/pending）⇒ `degraded`');
    ok(imBad.evidence.includes('error') && imBad.evidence.includes('pending'),
      'M-h-25b ★依据里点名**哪几个状态各几个**', imBad.evidence);
  }

  // ── ⑥ 资源面：内存与磁盘水位 ──────────────────────────────────────────────────
  {
    const okR = mhItem(await runHealthCheck(mhDepsGood(mhdb()) as never), 'resources');
    eq(okR.level, 'ok', 'M-h-26 水位正常 ⇒ `ok`');
    ok(okR.evidence.includes('堆') && okR.evidence.includes('磁盘余'),
      'M-h-26b 依据同时报**内存与磁盘**两个实测值', okR.evidence);
    const warn = await runHealthCheck({ ...(mhDepsGood(mhdb()) as never), memory: () => ({ heapUsed: HEAP_WARN_BYTES + 1, rss: 0 }) } as never);
    eq(mhItem(warn, 'resources').level, 'degraded', 'M-h-27 堆超警戒线 ⇒ `degraded`');
    const danger = await runHealthCheck({ ...(mhDepsGood(mhdb()) as never), memory: () => ({ heapUsed: HEAP_DANGER_BYTES + 1, rss: 0 }) } as never);
    eq(mhItem(danger, 'resources').level, 'unavailable', 'M-h-28 堆超危险线 ⇒ `unavailable`');
    const diskDanger = await runHealthCheck({ ...(mhDepsGood(mhdb()) as never), diskFree: () => ({ free: 1e9, total: 100e9 }) } as never);
    eq(mhItem(diskDanger, 'resources').level, 'unavailable', 'M-h-29 磁盘余量低于危险线（1%）⇒ `unavailable`');
    const diskWarn = await runHealthCheck({ ...(mhDepsGood(mhdb()) as never), diskFree: () => ({ free: 5e9, total: 100e9 }) } as never);
    eq(mhItem(diskWarn, 'resources').level, 'degraded', 'M-h-30 磁盘余量低于警戒线（5%）⇒ `degraded`');
    const noDisk = mhItem(await runHealthCheck({ ...(mhDepsGood(mhdb()) as never), diskFree: null } as never), 'resources');
    ok(noDisk.evidence.includes('磁盘水位未注入'), 'M-h-31 ★未注入磁盘 ⇒ 依据里**如实说没量**（不假装量过）', noDisk.evidence);
    // 内存**恰在**阈值上 ⇒ 也升级（`>=`，与上面 `+1` 一起把 `>`/`>=` 分开）
    const onLine = await runHealthCheck({ ...(mhDepsGood(mhdb()) as never), memory: () => ({ heapUsed: HEAP_WARN_BYTES, rss: 0 }) } as never);
    eq(mhItem(onLine, 'resources').level, 'degraded', 'M-h-31b 恰在警戒线上 ⇒ 也算超（`>=` 的边界）');
  }

  // ── ⑦ 整体报告：五面齐出 + 取最差 + 时刻来自注入 ──────────────────────────────
  {
    // 「五面全好」得**真的五面全好**：`mhdb()` 是空库，IM 面会因"零启用渠道"判 `unavailable`
    // 并借 `worstHealthLevel` 压过其余四面——故这里必须先放一个健康渠道，否则本条是在验"最差"，不是"全好"。
    const goodDb = mhdb();
    mhChannel(goodDb, 'c-good', 'running');
    const allGood = await runHealthCheck(mhDepsGood(goodDb) as never);
    eq(allGood.level, 'ok', 'M-h-32 五面全好 ⇒ 整体 `ok`');
    eq(allGood.items.map((i) => i.key), ['ans', 'db', 'scheduler', 'im', 'resources'],
      'M-h-33 ★五面**齐出且次序固定**（少一面就等于"那一面没查"，而报告仍会显示"健康"）');
    ok(new Set(allGood.items.map((i) => i.key)).size === 5, 'M-h-33b 五面 key 互不重复');
    ok(allGood.items.every((i) => i.evidence.length > 0), 'M-h-34 ★每一面都**必带一句依据**（"不猜"的落点）');
    const oneBad = await runHealthCheck({
      ...(mhDepsGood(goodDb) as never),
      scheduler: { isRunning: () => true, lastTickAt: () => MH_NOW - 10 * 60_000 },
    } as never);
    eq(oneBad.level, 'degraded',
      'M-h-35 ★★只有一面降级 ⇒ **整体降级**（`level` 不是"多数票"，一项坏就坏）');
    const cantEven = await runHealthCheck({
      ...(mhDepsGood(goodDb) as never),
      probeAns: async () => ({ ok: false, status: 0, detail: 'ECONNREFUSED' }),
    } as never);
    eq(cantEven.level, 'unavailable', 'M-h-35b 一面不可用 ⇒ 整体不可用');
    eq(allGood.checkedAt, new Date(MH_NOW).toISOString(),
      'M-h-36 ★`checkedAt` 取自**注入的 now**（G-4：判据不依赖真实墙钟，故这条等值断言恒成立）');
  }

  // ── ⑧ 静态：接线形状 + 探针走唯一出路 + 脉冲在提前返回之前 ─────────────────────
  {
    const src = RD('apps/worker-ant-desktop/src/main/ipc/admin.ipc.ts');
    ok(/await\s+runHealthCheck\(\{/.test(src), 'M-h-37 ★`admin:health` 真的 `await runHealthCheck({`（接线形状，不是"引了就算"）');
    ok(/status:\s*report\.level/.test(src),
      'M-h-37b ★`status` 改由**真报告**派生（此前按 `runningTasks > 0` 猜业务量）');
    ok(!/runningTasks\.c\s*>\s*0\s*\?\s*'healthy'/.test(src),
      'M-h-37c ★反证：旧的"按业务量猜 status"三目式**已撤**');
    ok(/ansSignedRequest\(\s*resolveAnsCreds\(db\)\s*,\s*ANS_HEALTH_PROBE_PATH/.test(src),
      'M-h-38 ★★探针走到 ANS 的**唯一出路** `ansSignedRequest(resolveAnsCreds(db), …)`（M9 的账：不另开一条无签名的路）');
    ok(/timeoutMs:\s*3000/.test(src), 'M-h-38b 探针**带超时**（否则 ANS 挂起时这页也挂起）');
    ok(/readTextFile:\s*\(p:\s*string\)\s*=>\s*fsSync\.readFileSync/.test(src), 'M-h-38c 心跳读取走真实现注入');

    const hc = RD('apps/worker-ant-desktop/src/main/core/health-check.ts');
    // 探针路径的常量落**在发起那一跳的本文件**（`admin.ipc.ts`），故按取值断言而非 import 常量。
    const probePath = /const ANS_HEALTH_PROBE_PATH = '([^']+)'/.exec(src)?.[1];
    eq(probePath, '/api/v1/models',
      'M-h-39 ★★探针打的是**受保护**端点 `/api/v1/models`（挂在 ANS 的 `hmacAuth` 下）');
    ok(probePath !== '/api/v1/health',
      'M-h-39b ★★反证：**刻意不打**那个公开的 `/api/v1/health`——那只能证明"端口有人听"，'
      + '证明不了三个认证头还认得（M9 治的正是后者）');
    ok(!/api\/v1\//.test(hc),
      'M-h-39c ★反证：`health-check.ts` **不含**任何 `/api/v1/` 串——它只认 `probeAns` 形参、从不发请求；'
      + '把 URL 写在这儿会让它在 M9 的 `/api/v1/` 完备性扫面上被当成"漏头"');
    ok(!/from\s+['"]electron['"]/.test(hc),
      'M-h-40 ★`health-check.ts` **零 electron**（故可被本脚本直引跑真实现，G-1）');
    ok(/import\s+type\s+Database\s+from\s+['"]better-sqlite3['"]/.test(hc),
      'M-h-40b `better-sqlite3` 只是**类型边**（`import type`），运行时不拖原生模块');
    ok(/imChannelEnabledSql\(\)/.test(hc),
      'M-h-41 ★IM 面的「启用中」口径引**真源** `imChannelEnabledSql()`，不手抄 `status IS NOT \'inactive\'`');
    ok(/PRAGMA\s+integrity_check/i.test(hc), 'M-h-41b DB 面真跑 `PRAGMA integrity_check`');
    eq(CRON_HEARTBEAT_STALE_MS, 30 * 60_000,
      'M-h-42 ★心跳阈值 = 30 分钟，与 `main/index.ts` 头注释「心跳 30 分钟内=存活」**同数**（改一处必改另一处）');

    // 脉冲必须在 `pending.size === 0` 的提前返回**之前**——否则空转中的调度器会被判"陈旧"
    const sched = RD('apps/worker-ant-desktop/src/main/core/task-scheduler.ts');
    const pIdx = sched.indexOf('this._lastTickAt = Date.now();');
    ok(pIdx > 0, 'M-h-43 调度器**真的在 `processPending` 里记脉冲**（`this._lastTickAt = Date.now()`）');
    ok(/\n\s*this\._lastTickAt = Date\.now\(\);\s*\n\s*if \(this\.pending\.size === 0\) return;/.test(sched),
      'M-h-43b ★★脉冲记在 `pending.size === 0` **提前返回之前**——空转（没活干）同样是"还活着"的证据');
    ok(/isRunning\(\):\s*boolean\s*\{\s*return this\.running;/.test(sched), 'M-h-44 调度器出 `isRunning()`');
    ok(/lastTickAt\(\):\s*number\s*\{\s*return this\._lastTickAt;/.test(sched), 'M-h-44b 调度器出 `lastTickAt()`');

    const idx = RD('apps/worker-ant-desktop/src/main/index.ts');
    ok(/initAdminIpc\(db,\s*\{\s*heartbeatFile:\s*CRON_HEARTBEAT_FILE,\s*getScheduler:\s*\(\)\s*=>\s*_scheduler,\s*dataDir\s*\}\)/.test(idx),
      'M-h-45 ★★`index.ts` 把三个外部世界**注入**：心跳文件路径 / 调度器 thunk（**惰性**：本行执行时它尚未构造）/ 磁盘卷');
    ok(/const CRON_HEARTBEAT_FILE = path\.join\(dataDir, 'cron_heartbeat\.json'\)/.test(idx),
      'M-h-45b 心跳文件路径仍是 `dataDir/cron_heartbeat.json`（跨仓库契约未破）');
  }
}

// ══════════════════════════════════════════════════════════════════
// 【M-i】M14-4 · 真健康上屏 + 架构不变量 error 级**要通知**（不能只 log）
// ══════════════════════════════════════════════════════════════════

/**
 * M-i 夹具：**架构不变量所读的那七张表**（列照抄 `database.ts` DDL；NOT NULL 不省）。
 *
 * 为什么必须比 M-h 的夹具宽：`runAllInvariants` 的 `catch` 会把"查不动"（缺表/**缺列**）变成一条
 * **error 级**的 `unknown` 结果。M-h 的 `wa_event_log` 只有一列 `id`、`wa_memories` 只有 `id,content`
 * ——拿它当本组的阴性标本，"零 error ⇒ 不通知"**结构上不可满足**（会恒被判成 error 侧）。
 * 这正是本组先自证"阴性标本真的干净"（M-i-9）的理由：判据不许架在一个没验过的前提上。
 */
const MI_SCHEMA = `
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT DEFAULT 'active');
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, status TEXT DEFAULT 'pending', updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL, content TEXT DEFAULT '');
CREATE TABLE wa_event_log (id TEXT PRIMARY KEY, event_type TEXT, aggregate_id TEXT);
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, name TEXT, file_path TEXT, status TEXT);
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, name TEXT DEFAULT '', config TEXT NOT NULL DEFAULT '{}', status TEXT DEFAULT 'active');
CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, content TEXT NOT NULL, memory_type TEXT DEFAULT 'episodic');
`;

function midb(): AnyDb { const d = new DatabaseSync(':memory:') as unknown as AnyDb; d.exec(MI_SCHEMA); return d; }

/** error 级违规的**不变量名**（按名点名，不用"有几条"含混过去）。 */
const invErrors = (db: AnyDb): string[] =>
  runAllInvariants(db).filter((r) => !r.passed && r.severity === 'error').map((r) => r.name);

/**
 * 取通知行。**表不存在 ⇒ 空集**（"没写过通知"与"表都没有"是同一件事的两种表现，
 * 不该把前者判成失败）——但表在而写失败时，`recordNotification` 会记 `notificationWriteFailures`
 * 并抛出，不会静默留空（见其注释），故这里不必再兜一层。
 */
const notifRows = (db: AnyDb, type?: string): Array<{ type: string; title: string; body: string }> => {
  const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wa_notifications'").get();
  if (!has) return [];
  return (type
    ? db.prepare('SELECT type, title, body FROM wa_notifications WHERE type = ?').all(type)
    : db.prepare('SELECT type, title, body FROM wa_notifications').all()) as Array<{ type: string; title: string; body: string }>;
};

function groupMi(): void {
  console.log('\n【M-i】M14-4 · 真健康上屏 + 架构不变量 error 级**要通知**（不能只 log）');

  // ── ① 三态词表的第二落点：renderer 跨 root 引真源，不手抄 ─────────────────────
  const dp = RD(`${A}/renderer/src/pages/DashboardPage.tsx`);
  ok(dp.length > 5_000, 'M-i-1 扫描面自证：DashboardPage 源码非空（不然后面的"零命中"是空转假绿）', `${dp.length} 字符`);
  ok(/from '\.\.\/\.\.\/\.\.\/src\/main\/core\/health-check\.js'/.test(dp),
    'M-i-2 ★renderer 跨 root 引 `health-check` **真源**（三态词表不在渲染层手抄第二份）');
  ok(/HEALTH_LEVEL_LABEL/.test(dp) && /HEALTH_LEVEL_CLASS: Record<HealthLevel, string>/.test(dp),
    'M-i-3 标签取真源 `HEALTH_LEVEL_LABEL`；观感表是**穷举** `Record<HealthLevel, string>`（词表加一态即类型报错）');
  //   反证按**语句形状**锚（G-5），不按子串：旧码是拿 `health?.status` 与字面量比（`===`）再分支。
  //   刻意**不**写 `/'healthy'/`——那会被"改前按 `status==='healthy'` 二分"这类**订正注释**自己判红
  //   （本仓教训：负面子串断言会被注释判红，判据应断言**真相在场**，见 `feedback_predicate_needs_both_sides_specimen`）。
  eq(dp.match(/health\??\.status\s*===/g) ?? [], [],
    'M-i-4 ★★反证：按 `health?.status === <字面量>` 分支的旧写法**已零处**——新词表下它会把 `ok` 与 `unavailable` 显示成同一个词（名实不符的入口）');
  ok(/report\.items\.map\(/.test(dp) && /it\.evidence/.test(dp),
    'M-i-5 ★五面**逐个上屏**（`label` + `evidence`）——不是只把整体态显示成一个词、依据全丢');
  ok(/report\?\.level/.test(dp), 'M-i-5b 整体态取自 `report.level`（真报告），不按旧 `status` 字段猜');

  //   IPC 那一跳真把 report 下发（主进程算了 ≠ 界面收得到 ⇒ 必须钉"接线"这一跳）
  const adminSrc = RD(`${A}/src/main/ipc/admin.ipc.ts`);
  ok(/status: report\.level,\s*report,/.test(adminSrc),
    'M-i-6 ★`admin:health` 的返回体**真带 `report`**（只建接口不接，全量回归照样全绿）');

  // ── ② 产物核实：标签真进了 renderer 包（搜**中文串**——产物 minify 后标识符不可寻）──────
  const rdistAssets = path.join(root, A, 'renderer/dist/assets');
  if (!fs.existsSync(rdistAssets)) {
    ok(false, 'M-i-7 ★renderer 产物在场（前置：`pnpm --filter @worker-ant/desktop-renderer build` 先行）', rdistAssets);
  } else {
    const bundle = fs.readdirSync(rdistAssets).filter((n) => n.endsWith('.js'))
      .map((n) => fs.readFileSync(path.join(rdistAssets, n), 'utf-8')).join('\n');
    ok(bundle.length > 100_000, 'M-i-7 扫描面自证：renderer 产物非空', `${bundle.length} 字节`);
    eq(['不可用', '降级'].filter((s) => !bundle.includes(s)), [],
      'M-i-8 ★★三态里两个**只可能来自新词表**的标签真的进了 renderer 产物');
  }

  // ── ③ error 级要通知：真跑 `startupSelfCheck`，正反两侧各一只真标本（G-2）───────────
  const clean = midb();
  eq(invErrors(clean), [],
    'M-i-9 ★阴性标本**真的干净**（零 error 级违规）——否则下一条的"零通知"是空转假绿');
  startupSelfCheck(clean);
  eq(notifRows(clean, ARCH_INVARIANT_ERROR_NOTIFICATION_TYPE).length, 0,
    'M-i-10 ★零 error ⇒ **不通知**（不制造"狼来了"）');

  //   阳性标本：两条 error 级违规（同类型双启用渠道 + 孤儿对话）⇒ **恰一条**通知且**点名每一处**。
  const bad = midb();
  bad.prepare("INSERT INTO wa_im_channels (id, channel_type, name, status) VALUES ('c1','wechat','a','running')").run();
  bad.prepare("INSERT INTO wa_im_channels (id, channel_type, name, status) VALUES ('c2','wechat','b','running')").run();
  bad.prepare("INSERT INTO wa_task_conversations (id, task_id, role) VALUES ('v1','ghost','user')").run();
  const names = invErrors(bad);
  eq(names.length, 2, 'M-i-11 ★阳性标本含**恰两条** error 级违规（两只靶子都真的中了）');
  ok(names.includes('im-channel-consistency') && names.includes('conversation-task-integrity'),
    'M-i-11b 两条靶子分别是"同类型双启用渠道"/"孤儿对话"（按**不变量名**点名）', names.join('、'));
  eq(notifRows(bad, ARCH_INVARIANT_ERROR_NOTIFICATION_TYPE).length, 0,
    'M-i-12 前置自证：跑之前通知数为 0（下一条是 **0→1** 的正面断言，G-3）');
  startupSelfCheck(bad);
  const rows = notifRows(bad, ARCH_INVARIANT_ERROR_NOTIFICATION_TYPE);
  eq(rows.length, 1,
    'M-i-13 ★★error 级违规 ⇒ **恰一条**通知落 `wa_notifications`（此前只有 `logger.error`，用户眼前到不了）');
  ok(rows[0].body.includes('im-channel-consistency') && rows[0].body.includes('conversation-task-integrity'),
    'M-i-13b ★通知**点名每一处**（两条都点到）——不是一句笼统的"自检失败"', rows[0].body);
  ok(rows[0].title.includes('2'), 'M-i-13c 标题带条数', rows[0].title);
  startupSelfCheck(bad);
  eq(notifRows(bad, ARCH_INVARIANT_ERROR_NOTIFICATION_TYPE).length, 1,
    'M-i-14 自检重复触发**不重复通知**（同 key 8 秒内去重，行数不翻倍）');

  //   边界：warning 级**不**通知（只有 error 级才打扰用户）。
  const warn = midb();
  warn.prepare("INSERT INTO wa_memories (id, project_id, content, memory_type) VALUES ('m1','ghost','x','episodic')").run();
  ok(runAllInvariants(warn).some((r) => !r.passed && r.severity === 'warning'),
    'M-i-15 阳性标本：warning 级违规**真的在**（否则"不通知"又是空转假绿）');
  eq(invErrors(warn), [], 'M-i-15b warning **不是** error ⇒ 不进通知集');
  startupSelfCheck(warn);
  eq(notifRows(warn, ARCH_INVARIANT_ERROR_NOTIFICATION_TYPE).length, 0,
    'M-i-16 ★只有 error 级才通知（warning 级只进日志）');

  // ── ④ 类型名一处真源 + 接线按**语句形状**判（不是"文件里出现过这个词"）────────────────
  ok(/^arch_invariant/.test(ARCH_INVARIANT_ERROR_NOTIFICATION_TYPE),
    'M-i-17 通知类型名取自生产导出（`arch_invariant_*` 族）：判据里不另写一份字面量', ARCH_INVARIANT_ERROR_NOTIFICATION_TYPE);
  const invSrc = RD(`${A}/src/main/core/architectural-invariants.ts`);
  ok(/type:\s*ARCH_INVARIANT_ERROR_NOTIFICATION_TYPE/.test(invSrc),
    'M-i-18 ★`startupSelfCheck` 真的把 `type:` 接上那个常量（按**语句形状**判，不是子串匹配）');
  ok(/recordNotification\(\s*db,/.test(invSrc),
    'M-i-18b 通知落在**用户可见的**那一张表（经 `recordNotification`，非另造一张）');
  ok(/startupSelfCheck[\s\S]{0,400}?logger\.error[\s\S]{0,400}?recordNotification\(/.test(invSrc),
    'M-i-18c ★error 分支里**日志与通知同做**（不是把 `logger.error` 换成了通知——两件都要）');
}

// ══════════════════════════════════════════════════════════════════
// 【A-g】哑雷专项 + build 钉
// ══════════════════════════════════════════════════════════════════
function groupAg(): void {
  console.log('\n【A-g】哑雷专项 + build 钉（轮次一律由载体自身派生，不写轮次字面量）');
  const selfSrc = fs.readFileSync(__filename, 'utf-8');
  ok(selfSrc.length > 2000, 'A-g-1 扫描面自证：本文件源码非空（否则下面的"零命中"是空转假绿）', `${selfSrc.length} 字节`);
  const pat = new RegExp("'zx_\\d{8}(?:_\\d+)?'", 'g');
  const hits = (selfSrc.match(pat) ?? []).filter((s) => {
    const y = Number(s.slice(4, 8));
    return y >= 2020 && y <= 2030;
  });
  eq(hits, [], 'A-g-2 ★本文件内**零**处「只为下一轮为真」的轮次字面量（否则是只对下一轮引爆的哑雷）');
  const THIS = path.basename(__filename).replace(/\.ts$/, '');
  const relPlan = path.join('plans/improve', `${THIS.slice(3)}.md`);
  ok(fs.existsSync(path.join(root, relPlan)), 'A-g-3 ★方向性自指（由载体自身派生，非抄来的常量）：本轮方案文件在场', relPlan);
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

async function main(): Promise<void> {
  groupAa();
  groupAb();
  groupAc();
  await groupAd();
  await groupAe();
  groupAf();
  groupBa();
  await groupBb();
  await groupBc();
  await groupBd();
  groupCa();
  groupCb();
  groupCc();
  groupCd();
  groupCe();
  groupCf();
  groupDa();
  groupDb();
  groupDc();
  groupDd();
  groupDe();
  groupDg();
  groupEa();
  groupEb();
  groupEc();
  await groupEd();
  groupEe();
  groupFa();
  groupFb();
  groupFc();
  groupFd();
  groupGa();
  groupGb();
  groupHa();
  groupHb();
  groupHc();
  groupHd();
  groupHe();
  groupHf();
  groupHg();
  groupIa();
  await groupIb();
  await groupIc();
  groupId();
  groupIe();
  groupJa();
  groupJb();
  groupJc();
  groupKa();
  await groupKb();
  groupKc();
  groupKd();
  groupKe();
  await groupKf();
  groupLa();
  groupLb();
  groupLc();
  groupLd();
  groupLe();
  groupLf();
  groupLg();
  groupMa();
  await groupMb();
  groupMc();
  await groupMd();
  await groupMe();
  await groupMf();
  groupMg();
  await groupMh();
  groupMi();
  groupAg();
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260930: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => { console.error(e); process.exit(1); });
