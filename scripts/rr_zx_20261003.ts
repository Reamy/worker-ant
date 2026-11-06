/**
 * zx_20261003 受控复跑 —— 「验得了、汇得拢、轻得下」。
 *
 * 本文件按**实施排期**逐批转绿（`RR_STAGE=Mn` 只要求 ≤Mn 的批次为绿，更晚的批次打 ⏳ 不计入失败；
 * `RR_STAGE` 为空 = 全部须绿，收口用）。批序见下方 `ORDER`。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §M1 判据（批一 · 收得住）——「产出校验按族分派」。
 *
 * 病根（`plans/improve/zx_20261003.md` §2 批一 M1，承 zx_20260922_1 F6a / zx_20260923 T3 的余绪）：
 *   内容门禁的**成员资格**旧尺是"扩展名 ∈ {.md,.markdown}"（`DOC_TARGET_EXT_RE`）——
 *   一份真 PDF / 一段音视频 / 一个 `.java` 产出**统统进不了门**，等于"看不见就当作不存在"。
 *   K-6 裁定改为**结构性判据**：成员资格 = 声明产出 ∪（**族可判型** ∧ 非探针噪声）。
 *   "族可判型" = 该扩展名有一条**可实行的校验路**：代码→code 快检 / 配置→configuration 快检 /
 *   `.md`/`.pdf`→文档腿 / 音视频→形态核验。进门之后**用什么规则量**另由 `archetypeForFile` 定——
 *   这两件事**分家**（进不进集 vs 怎么量），正是 T3 病根（`pom.xml` 被当文档量）的解药。
 *
 * 判据分四组，**两侧标本一起上**（承 auto-memory `feedback_predicate_needs_both_sides_specimen`：
 * 只用"该命中"⇒ 任何过宽变体全票通过；只用"该不命中"⇒ 任何过窄变体全票通过）：
 *   §A `archetypeForFile` 判族（怎么量）：该 PDF/音视频落 pdf/media、`.txt` 仍落 document。
 *   §B `isGateArtifact` 成员资格（进不进集）：真族该进、`.txt`/图片该出——一条断言里**两侧同时在**。
 *   §C `validateOutput` 按族分派（真文件落盘 + 真实现）：
 *        C-1 抽得出正文的 PDF ⇒ 放行且**不**标 unverifiable（读的是抽出的文本，不是原始字节）；
 *        C-2 抽不出的 PDF ⇒ `status:'unknown'` + `unverifiable` 非空 + `sufficient:true`（**不拦**）；
 *        C-3 音视频非空 ⇒ 同上（形态核验、如实标"未做语义校验"、永不 block）；
 *        C-4 音视频**空文件** ⇒ `status:'insufficient'` 且 `unverifiable` **为空**（形态闸真在起作用）；
 *        C-5 普通 `.md` ⇒ `unverifiable` **为空**（区分：这标只给"无文本层"的族）。
 *   §D 接线与唯一尺（结构面）：新尺 `isGateArtifact` 一处定义 · `.pdf` 路由真接上 `extractPdfText` ·
 *        旧尺 `DOC_TARGET_EXT_RE` 零残留 · 本文件哑雷自检 · 扫描面自证。
 *
 * §M2 判据（批一 · 收得住）——「能力探测的优雅降级」（承 zx_20260930 M10/M13-4）：
 *   病根（`zx_20261003` §1.1 缺口 #1/#3）：无 vision 时视频的"画面没送进去"被**遮蔽成完全成功**
 *   （`done(...)` 恒记 `inlined` 且无 `reason`）；且超限/不支持只记 marker、不给"怎么办"。
 *   判据两侧同在：M2-A/B 无 vision ⇒ `inlined` + `reason=model_lacks_vision_frames` + marker 带出口；
 *   M2-C/D 同一件含 vision ⇒ 画面真送、`reason` **不给**；M2-E/F/G 三族 marker 各带"怎么办"；
 *   M2-H/I 留痕经落库视图原样带出、原因码一处定义。
 *
 * §M3 判据（批一 · 收得住）——「判族一把尺（名实相符）」：
 *   病根（`zx_20261003` §2 批一 M3）：`model-request.ts` 的 `familyOfAttachment` 判族**只看扩展名**，
 *   而装配层 `attachment-inline.ts` 是**魔数优先** ⇒ 两把尺。一件改名 `.mp4`→`.bin` 的视频在**选型期**
 *   判成 `binary` ⇒ 不要 `vision` ⇒ 选到无 vision 模型 ⇒ 装配期认出是视频却没有 vision ⇒ **抽帧永不发生**。
 *   判据两侧同在：M3-A `.bin`+mp4 魔数 ⇒ 要 `vision` / 同一件嗅不出 ⇒ 不要（退路）/ 不注入的旧形态 `.mp4` ⇒ 要；
 *   M3-B/C/D 结构面（判族同源、选型层真注入、读盘头部一处实现）；M3-E/F 真读盘（0→1）与读不到不抛。
 *
 * §M4…§M13 由后续批次补。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：本轮判据引用的生产符号，**全部静态导入** ⇒ 被删/改名即**编译期失败**（而非"扫了个空、静默假绿"）。
import {
  isGateArtifact,
  archetypeForFile,
  docValidationTargets,
} from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { validateOutput } from '../apps/worker-ant-desktop/src/main/core/output-validator.js';
import { extractPdfText } from '../apps/worker-ant-desktop/src/main/core/pdf-text.js';
// M2：装配层真实现 + 落库视图（判据跑生产真走的那个函数，不是照抄的等价物）。
import { buildAttachmentParts, type InlineIo } from '../apps/worker-ant-desktop/src/main/core/attachment-inline.js';
import { toAttachmentOutcomeViews } from '../apps/worker-ant-desktop/src/main/core/attachment-outcome.js';
import type { VideoFramesResult } from '../apps/worker-ant-desktop/src/main/core/video-frames.js';
// M3：选型期判族的真实现（`attachmentsNeedVision`）+ 读头真源（`readHeadFromFile`）。
import { attachmentsNeedVision } from '../apps/worker-ant-desktop/src/main/core/model-request.js';
import { readHeadFromFile } from '../apps/worker-ant-desktop/src/main/core/file-head.js';
// M4：项目运行面聚合（守护/作业）真实现——IPC 层引 electron（rr 够不着），故聚合落在可测的 core 模块。
import { describeProjectRuntime } from '../apps/worker-ant-desktop/src/main/core/project-runtime-summary.js';
import { describeServiceCalls } from '../apps/worker-ant-desktop/src/main/core/service-call-ledger.js';
import { collectProjectKnowledgeMaterials, formatKnowledgeMaterials } from '../apps/worker-ant-desktop/src/main/core/project-knowledge-materials.js';
// M6：注入链路真实现——真 `MemoryManager`（内存库真行）× 真 `buildMemoryContext`，量 §0/§6/§7 三段**真进上下文**。
import { MemoryManager } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
import { buildMemoryContext } from '../apps/worker-ant-desktop/src/main/core/memory-context.js';
// M11：会话流长文折叠的**唯一一把尺**（纯函数 ⇒ rr 跑真实现，不造 DOM）。
import { needsClamp } from '../apps/worker-ant-desktop/renderer/src/lib/clamp-text.js';
// M12：逐渠道未读的**真实现**（跑真 SQL × 真内存库；不照抄一份"等价物"）。
import { computeImUnreadByChannel } from '../apps/worker-ant-desktop/src/main/core/im/im-unread.js';
// M13：入站视频显形的**真实现**（判形状 + 可内联判定；跑真实现、不照抄"等价物"）。
import {
  imMediaOf, resolveVideoPreview, videoPlayNote, VIDEO_PREVIEW_MIME, VIDEO_PREVIEW_MAX_BYTES,
} from '../apps/worker-ant-desktop/src/main/core/im/im-media-view.js';
import { FAMILY_MAX_BYTES } from '../apps/worker-ant-desktop/src/main/core/attachment-kinds.js';

// ── 批次门（排期序）────────────────────────────────────────────────────────
const ORDER = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12', 'M13'] as const;
type Batch = (typeof ORDER)[number];
const STAGE = (process.env.RR_STAGE || '').trim() as Batch | '';
/** STAGE 为空 ⇒ 全部须绿；否则**只要求 ≤STAGE 的批次**为绿（更晚的如实标"待实施"，不计入失败）。 */
const required = (b: Batch): boolean => STAGE === '' || ORDER.indexOf(b) <= ORDER.indexOf(STAGE);

let pass = 0; let fail = 0; let pending = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * 登记一条**受批次门管辖**的判据。
 * ⚠ 未实施批次的判据**必须仍然求值**（不能短路成 `false` 了事）：要的是"红**为什么**红"，
 *   故照常算出真值，只是**不计入**失败——收口时把门一开，看到的都是**真值**而非占位。
 */
function crit(b: Batch, cond: boolean, label: string, detail?: string): void {
  if (!required(b)) {
    pending++;
    console.log(`  ⏳ [${b}] ${label}${cond ? ' —— **已提前为真**' : ''}`);
    return;
  }
  if (cond) { pass++; console.log(`  ✓ [${b}] ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ [${b}] ${label}${detail ? ` — ${detail}` : ''}`); }
}

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const EXEC_SRC = path.join(root, A, 'src/main/core/agent-executor.ts');
const OV_SRC = path.join(root, A, 'src/main/core/output-validator.ts');
const INLINE_SRC = path.join(root, A, 'src/main/core/attachment-inline.ts');
const MR_SRC = path.join(root, A, 'src/main/core/model-request.ts');
const EXE_MODEL_SELECT_SRC = path.join(root, A, 'src/main/core/exec-model-select.ts');
const FILE_HEAD_SRC = path.join(root, A, 'src/main/core/file-head.ts');
const PROJECT_IPC_SRC = path.join(root, A, 'src/main/ipc/project.ipc.ts');
const RT_SUMMARY_SRC = path.join(root, A, 'src/main/core/project-runtime-summary.ts');
const PROJ_KNOW_MAT_SRC = path.join(root, A, 'src/main/core/project-knowledge-materials.ts');
const MEM_MANAGER_SRC = path.join(root, A, 'src/main/core/memory-manager.ts');
// M6：上屏落点（renderer 源码 + 产物）——"词表的第二个落点"纪律（见 CLAUDE.md「开发约定」）。
const PD_PAGE_SRC = path.join(root, A, 'renderer/src/pages/ProjectDetailPage.tsx');
const KF_CARD_SRC = path.join(root, A, 'renderer/src/components/KnowledgeFaceCard.tsx');
const SV_LIB_SRC = path.join(root, A, 'renderer/src/lib/status-view.ts');
// M11：会话流长文折叠（唯一一把尺 + 组件 + 接线 + 产物）。
const CLAMP_LIB_SRC = path.join(root, A, 'renderer/src/lib/clamp-text.ts');
const CLAMP_CMP_SRC = path.join(root, A, 'renderer/src/components/ClampText.tsx');
const IM_PAGE_SRC = path.join(root, A, 'renderer/src/pages/IMPage.tsx');
// M8/M9：纯搬移的三层钉（旧位置 / 新位置 / 接线那一跳）。
const CONTROL_SRC = path.join(root, A, 'src/main/core/tools/control.ts');
const CONTROL_FINALIZE_SRC = path.join(root, A, 'src/main/core/tools/control-finalize.ts');
const IM_ROUTER_SRC = path.join(root, A, 'src/main/services/im-router.ts');
const F3_PUSH_SRC = path.join(root, A, 'src/main/services/f3-notification-push.ts');
const IM_STORM_GUARD_SRC = path.join(root, A, 'src/main/core/im-storm-guard.ts');
const NOTIFY_DIR_SRC = path.join(root, A, 'src/main/core/notify-dir.ts');
// M12：逐渠道未读红点（main 一处算 → IPC 只读口 → 渲染层消费；五处落点各钉）。
const IM_UNREAD_SRC = path.join(root, A, 'src/main/core/im/im-unread.ts');
const IM_IPC_SRC = path.join(root, A, 'src/main/ipc/im.ipc.ts');
const R_IPC_SRC = path.join(root, A, 'renderer/src/lib/ipc.ts');
// M13：入站视频播放器 + 手发件走媒体气泡（真源模块 / 控件 / 接线那一跳；五处落点各钉）。
const IM_MEDIA_VIEW_SRC = path.join(root, A, 'src/main/core/im/im-media-view.ts');
const IM_BUBBLE_SRC = path.join(root, A, 'renderer/src/components/ImMediaBubble.tsx');
/** 扫源码一律**去注释**：承 `zx_20260921_1`——"注释里写着有、代码里没被用上"正是要防的形态。 */
const strip = (p: string) => stripKeepingLines(fs.readFileSync(p, 'utf-8')).join('\n');

/** 子串**出现次数**（"零处/恰好一处"类判据用；须配扫描面规模自证，防空扫恒绿）。 */
function countOcc(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0; let i = hay.indexOf(needle);
  while (i >= 0) { n++; i = hay.indexOf(needle, i + needle.length); }
  return n;
}

/**
 * 造一份最小 PDF（**程序化生成、内容已知**；承 `rr_zx_20260921` 的夹具纪律）。
 * 刻意不写交叉引用表——`pdf-text.ts` 本就线性扫 `N G obj`（见其文件头不支持清单）。
 * 每页一个 FlateDecode 内容流、`/Length` 按实算。
 */
function makePdf(pageStreams: string[]): Buffer {
  const n = pageStreams.length;
  const contentNums: number[] = []; const pageNums: number[] = [];
  let next = 1;
  for (let i = 0; i < n; i++) contentNums.push(next++);
  for (let i = 0; i < n; i++) pageNums.push(next++);
  const pagesNum = next;
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const emit = (num: number, head: string, stream?: Buffer): void => {
    chunks.push(Buffer.from(`${num} 0 obj\n${head}\n`, 'latin1'));
    if (stream) chunks.push(Buffer.from('stream\n', 'latin1'), stream, Buffer.from('\nendstream\n', 'latin1'));
    chunks.push(Buffer.from('endobj\n', 'latin1'));
  };
  pageStreams.forEach((src, i) => {
    const s = zlib.deflateSync(Buffer.from(src, 'latin1'));
    emit(contentNums[i]!, `<< /Length ${s.length} /Filter /FlateDecode >>`, s);
  });
  pageNums.forEach((num, i) => {
    emit(num, `<< /Type /Page /Parent ${pagesNum} 0 R /Contents ${contentNums[i]!} 0 R >>`);
  });
  emit(pagesNum, `<< /Type /Pages /Kids [${pageNums.map((x) => `${x} 0 R`).join(' ')}] /Count ${n} >>`);
  chunks.push(Buffer.from(`trailer\n<< /Root ${pagesNum} 0 R /Size ${next} >>\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

/** 一页的正文：首行贴当前文本位置，其后每行用非零垂直 `Td` 下移（`pdf-text.ts` 据此断行）。 */
const pageStream = (lines: string[]): string =>
  `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => (i === 0 ? `(${l}) Tj` : `0 -14 Td (${l}) Tj`)).join(' ')} ET\n`;

/** `validateOutput` 的建模 ansClient：无可用模型 ⇒ LLM 腿走"不可用"一路（确定性、不触网）。 */
const noModelClient = { getOptimalModel: async () => ({}) } as never;

async function main(): Promise<void> {
  const execCode = strip(EXEC_SRC);
  const ovCode = strip(OV_SRC);
  // 扫描面规模（**行数**）——「零处 / 恰好一处」类断言的**自证**（承 `zx_20260920_1 §G-1`）。
  const execLines = stripKeepingLines(fs.readFileSync(EXEC_SRC, 'utf-8')).length;
  const ovLines = stripKeepingLines(fs.readFileSync(OV_SRC, 'utf-8')).length;

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rr20261003-m1-ws-'));
  const write = (rel: string, body: Buffer | string): string => {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    return abs;
  };

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【G】不变式门（与批次无关）');
  {
    ok(typeof isGateArtifact === 'function' && typeof archetypeForFile === 'function'
      && typeof docValidationTargets === 'function' && typeof validateOutput === 'function'
      && typeof extractPdfText === 'function',
      'G-1 真源在位：本轮判据引用的生产符号全部可调用（静态 import ⇒ 改名即编译期失败）', '');
    ok(execLines > 1000 && ovLines > 100,
      'G-2 扫描面自证：两个被扫文件均读到足量行（防"文件没读到 ⇒ 零处违规恒真"）',
      `agent-executor ${execLines} 行 / output-validator ${ovLines} 行`);
    // G-3 哑雷自检：本文件**零处**轮次等值字面量（承 auto-memory `feedback_assertion_no_forward_literals`）。
    //   扫**去注释**版：承本条精神——注释里引一个旧轮次名（如"承 xxx 的余绪"）不是判据、不构成哑雷；
    //   真哑雷是**代码里**拿某轮值做等值比较，故与其它扫面一致地先剥注释。
    const selfSrc = stripKeepingLines(fs.readFileSync(__filename, 'utf-8')).join('\n');
    const stray = [...selfSrc.matchAll(/['"`]zx_\d{8}(?:_\d+)?['"`]/g)].map((m) => m[0]);
    ok(stray.length === 0,
      'G-3 哑雷自检：本文件零处轮次等值字面量（轮次标识一律由 `checkBuildPins` 从真源派生）',
      stray.length ? `实测 ${stray.join(',')}` : '');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M1·批一】产出校验按族分派（成员资格结构性判据 + 判型按族 + 未校验如实）');
  {
    // ── §A 判族（怎么量）─────────────────────────────────────────────────
    const archCases: Array<[string, string]> = [
      ['交付报告.pdf', 'pdf'],
      ['演示.mp4', 'media'],
      ['录音.mp3', 'media'],
      ['设计说明.md', 'document'],
      ['Order.java', 'code'],
      ['pom.xml', 'configuration'],
      ['迁移.sql', 'code'],
      ['构建报告.txt', 'document'],
    ];
    const archBad = archCases.filter(([f, want]) => archetypeForFile(f) !== want);
    crit('M1', archBad.length === 0,
      'M1-A `archetypeForFile` **按族分派怎么量**：`.pdf`→pdf、音视频→media、`.md`/`.txt`→document、'
      + '代码→code、`.xml`→configuration（八只标本逐一对照）',
      archBad.length ? `错配：${archBad.map(([f, w]) => `${f}→${archetypeForFile(f)}(期望${w})`).join(' · ')}`
        : `${archCases.length} 只全对`);

    // ── §B 成员资格（进不进集）——**两侧同一条断言** ──────────────────────
    const shouldEnter = ['设计说明.md', 'notion.markdown', '交付报告.pdf', '演示.mp4', '录音.mp3',
      'Order.java', 'pom.xml', 'application.properties', 'yop_sdk_config_default.json.example'];
    const shouldBeOut = ['构建报告.txt', '架构图.png', 'archive.bin', 'word.docx', ''];
    const enterBad = shouldEnter.filter((f) => !isGateArtifact(f));
    const outBad = shouldBeOut.filter((f) => isGateArtifact(f));
    crit('M1', enterBad.length === 0 && outBad.length === 0,
      'M1-B `isGateArtifact` **成员资格 = 族可判型**（两侧同在）：文档/PDF/音视频/代码/配置**该进**；'
      + '`.txt`（承裁定 T3）/图片/`binary`/空串**该出**——恒真变体挂在后半、恒假变体挂在前半',
      `该进未进 ${enterBad.length} 项${enterBad.length ? `：${enterBad.join(',')}` : ''} · `
      + `该出却进 ${outBad.length} 项${outBad.length ? `：${outBad.join(',')}` : ''}`);

    // ── §C `validateOutput` 按族分派（真文件落盘 + 真实现）────────────────
    // C-1 抽得出正文的 PDF ⇒ 放行、且**不**标 unverifiable
    //   正文须写得**像真 PDF**：既够 100 字（pdf 族 requiredPatterns）又令盘上字节过 500（pdf 族 minSize 量的是
    //   含结构开销的盘上字节）——只有两条短句的最小件会**卡在 minSize**，那是规则如实生效、不是判据该放宽。
    const PDF_LINES = [
      'Quarterly engineering review summary for the payment platform migration project, prepared for the',
      'architecture steering committee and circulated to every platform team ahead of the next planning cycle.',
      'Findings: end-to-end throughput improved by roughly thirty percent after the connection pool was retuned,',
      'p99 latency fell from eight hundred milliseconds to two hundred and forty, and the monthly error budget',
      'was respected in every week but the second, where a stale cache key caused a brief spike that was later',
      'traced to a configuration drift and corrected the same day without any customer-visible impact.',
    ];
    const goodPdf = write('交付报告.pdf', makePdf([pageStream(PDF_LINES)]));
    const goodRaw = fs.readFileSync(goodPdf);
    const extracted = extractPdfText(goodRaw);
    const rGood = await validateOutput(noModelClient, goodPdf, 'pdf');
    crit('M1', extracted.ok === true && rGood.quickCheck.passed === true
      && rGood.quickCheck.unverifiable === undefined && rGood.status !== 'insufficient',
      'M1-C1 **抽得出正文的 PDF**：`extractPdfText` 成功 ⇒ 快检放行、`unverifiable` **为空**、'
      + '`status ≠ insufficient`（读的是**抽出的文本**，不是原始字节——否则会被文档规则误判"缺标题"）',
      `抽出 ok=${extracted.ok} · quickCheck.passed=${rGood.quickCheck.passed} · `
      + `unverifiable=${String(rGood.quickCheck.unverifiable)} · status=${rGood.status}`);

    // C-2 抽不出的 PDF（无 %PDF- 魔数）⇒ unknown + unverifiable 非空 + sufficient（不拦）
    const badPdf = write('扫描件.pdf', Buffer.from('这不是 PDF 的内容，只是一段普通字节流。\n'.repeat(20), 'utf-8'));
    const rBad = await validateOutput(noModelClient, badPdf, 'pdf');
    crit('M1', rBad.status === 'unknown' && rBad.sufficient === true
      && typeof rBad.quickCheck.unverifiable === 'string' && rBad.quickCheck.unverifiable.length > 0,
      'M1-C2 **抽不出的 PDF ⇒ 未校验（不拦）**：`status:\'unknown\'` + `sufficient:true` + `unverifiable` 非空'
      + ' ——"读不出" ≠ "内容不足"（scan件/加密件不得被扣内容分的帽子、不得卡住收口）',
      `status=${rBad.status} · sufficient=${rBad.sufficient} · unverifiable=${JSON.stringify(rBad.quickCheck.unverifiable)}`);

    // C-3 音视频非空 ⇒ unknown + unverifiable 非空
    const mp4 = write('演示.mp4', Buffer.concat([Buffer.from('\x00\x00\x00\x18ftypmp42', 'latin1'), Buffer.alloc(2048, 7)]));
    const rMp4 = await validateOutput(noModelClient, mp4, 'media');
    crit('M1', rMp4.status === 'unknown' && rMp4.sufficient === true
      && typeof rMp4.quickCheck.unverifiable === 'string' && rMp4.quickCheck.unverifiable.length > 0,
      'M1-C3 **音视频非空 ⇒ 形态核验、如实标"未做语义校验"**：`status:\'unknown\'` + `unverifiable` 非空 + 不拦',
      `status=${rMp4.status} · unverifiable=${JSON.stringify(rMp4.quickCheck.unverifiable)}`);

    // C-4 音视频**空文件** ⇒ insufficient 且 unverifiable 为空（形态闸真在起作用，不是恒放行）
    const emptyMp4 = write('空文件.mp4', Buffer.alloc(0));
    const rEmpty = await validateOutput(noModelClient, emptyMp4, 'media');
    crit('M1', rEmpty.status === 'insufficient' && rEmpty.quickCheck.unverifiable === undefined,
      'M1-C4 **音视频空文件 ⇒ 判不足**（反证：形态闸**真在起作用**）：0B ⇒ `status:\'insufficient\'` 且 '
      + '`unverifiable` **为空**——`unverifiable` 不是"音视频一律放行"的后门',
      `status=${rEmpty.status} · unverifiable=${String(rEmpty.quickCheck.unverifiable)} · issues=${JSON.stringify(rEmpty.quickCheck.issues)}`);

    // C-5 普通 .md ⇒ unverifiable 为空（区分：这标只给"无文本层"的族）
    const md = write('说明.md', '# 说明\n\n' + '正文内容。'.repeat(80) + '\n\n结论：通过。\n');
    const rMd = await validateOutput(noModelClient, md, 'document');
    crit('M1', rMd.quickCheck.unverifiable === undefined,
      'M1-C5 **普通 `.md` 不标 unverifiable**（区分两侧）：有文本层的族照常走内容判型，`unverifiable` 只给'
      + '"无文本层"（PDF 抽不出 / 音视频）',
      `unverifiable=${String(rMd.quickCheck.unverifiable)} · status=${rMd.status}`);

    // ── §C′ 新族确实**进得了集**（`docValidationTargets` 真实现；只钉 M1 新开的 pdf/media 两族）──
    const dbWs = fs.mkdtempSync(path.join(os.tmpdir(), 'rr20261003-m1-db-'));
    const dw = (rel: string, body: string): string => {
      const abs = path.join(dbWs, rel); fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body); return abs;
    };
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT, acceptance_criteria TEXT)');
    db.exec("CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, task_id TEXT, file_path TEXT, name TEXT DEFAULT '', type TEXT)");
    db.prepare('INSERT INTO wa_tasks (id, title, description, acceptance_criteria) VALUES (?,?,?,?)').run('T1', 'x', '', '');
    dw('报告.pdf', '%PDF-1.4\n'); dw('演示.mp4', '\x00ftypmp42'); dw('说明.txt', 'x\n');
    const insD = db.prepare('INSERT INTO wa_deliverables (id, task_id, file_path, type) VALUES (?,?,?,?)');
    insD.run('p1', 'T1', '报告.pdf', 'doc');
    insD.run('p2', 'T1', '演示.mp4', 'doc');
    insD.run('p3', 'T1', '说明.txt', 'doc');
    const tset = docValidationTargets(db as never, 'T1', dbWs).map((p) => path.relative(dbWs, p).split(path.sep).join('/'));
    crit('M1', tset.includes('报告.pdf') && tset.includes('演示.mp4') && !tset.includes('说明.txt'),
      'M1-C′ **新族真进得了集**：`docValidationTargets` 真实现下，注册的 `.pdf`/`.mp4` 进集、`.txt` 出局'
      + '（只钉 M1 新开的 pdf/media 两族；完整成员矩阵见 `rr_zx_20260922_1` M2 组）',
      `进集 ${JSON.stringify(tset)}`);

    // ── §D 接线与唯一尺（结构面）─────────────────────────────────────────
    crit('M1', countOcc(execCode, 'export function isGateArtifact') === 1,
      'M1-D1 新尺 `isGateArtifact` **只有一处定义**（不是"定义一套、另抄一套"）',
      `定义 ${countOcc(execCode, 'export function isGateArtifact')} 处`);
    crit('M1', countOcc(execCode, 'DOC_TARGET_EXT_RE') === 0,
      'M1-D2 旧尺 `DOC_TARGET_EXT_RE` **零残留**（成员资格已整体移交结构性判据）',
      `残留 ${countOcc(execCode, 'DOC_TARGET_EXT_RE')} 处`);
    crit('M1', countOcc(execCode, 'const DOC_GATE_EXTS') === 1 && countOcc(ovCode, 'extractPdfText') === 2,
      'M1-D3 **两处接线俱在**：`DOC_GATE_EXTS` 一处定义；`output-validator.ts` 中 `extractPdfText` 恰 2 处'
      + '（1 处 import + 1 处调用）——`.pdf` 路由**真接上了**（不是"定义了没接线"）',
      `DOC_GATE_EXTS ${countOcc(execCode, 'const DOC_GATE_EXTS')} 处 · `
      + `extractPdfText ${countOcc(ovCode, 'extractPdfText')} 处`);
    crit('M1', countOcc(ovCode, 'unverifiable') >= 4,
      'M1-D4 `unverifiable` 通路在位：`output-validator.ts` 中出现 ≥4 处（类型定义 + 两处置位 + 消费分支）',
      `出现 ${countOcc(ovCode, 'unverifiable')} 处`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M2·批一】能力探测的优雅降级（显式留痕 + 补"怎么办"）');
  {
    // 夹具：一件视频、音轨转写成功。`readHead:()=>null`（嗅不出 ⇒ 守扩展名判 video）、
    //   `statSize:()=>null`（不触盘上尺寸闸）——与 `rr_zx_20260924` M2 组同一形态。
    const vidIo = (opts: { frames?: (p: string) => Promise<VideoFramesResult> }): Partial<InlineIo> => ({
      readFile: (p) => (p.endsWith('.jpg') ? Buffer.from([0xff, 0xd8, 0xff, 0xd9]) : Buffer.from('video-bytes')),
      statSize: () => null,
      readHead: () => null,
      transcribeAudio: async () => ({ ok: true, text: '这是会议录音。' }),
      ...(opts.frames ? { extractFrames: opts.frames } : {}),
    });
    const clip = [{ path: '/tmp/m2/clip.mp4', fileName: 'clip.mp4' }];
    // zx_20261018_2 批二：帧结果显式带出「源时长探没探到」。本标本代表**探不到**的一侧
    //   （显式 `durationKnown:false`，不靠字段缺席来意外落进该分支）。
    const framesOk = async (): Promise<VideoFramesResult> => ({
      ok: true,
      frames: [{ path: '/tmp/m2/clip.abc12345.frame-001.jpg', size: 4 }, { path: '/tmp/m2/clip.abc12345.frame-002.jpg', size: 4 }],
      windowSeconds: 720, intervalSeconds: 90, dropped: 0,
      durationKnown: false, sourceSeconds: null,
    });

    // ── ① 无 vision 的**显式降级留痕**（两侧同一条：只差清单本身）────────────────────
    const nv = await buildAttachmentParts(clip, vidIo({}), { modelCapabilities: ['chat'] });
    const nvO = nv.outcomes[0]!;
    crit('M2', nvO.status === 'inlined' && nvO.reason === 'model_lacks_vision_frames',
      'M2-A **无 vision 视频显式降级留痕**：`status` 仍 `inlined`（音轨那半**真进了上下文**——改 '
      + '`omitted`/`failed` 都是新的失实，且方案明令不得硬失败），但 `reason=\'model_lacks_vision_frames\'` '
      + '把"画面没进去"写进账——此前 `done(...)` 恒记 `inlined` 且无 `reason`，降级被**遮蔽成完全成功**',
      `status=${nvO.status} · reason=${String(nvO.reason)}`);
    crit('M2', nvO.marker.includes('不具备 vision 能力，未抽帧') && nvO.marker.includes('可改用具备 vision 的模型后重发'),
      'M2-B 无 vision 的 marker **补"怎么办"**：既说清真因（未抽帧），又给出下一条路（换视觉模型重发）'
      + '——只说"画面没来"是半句话',
      nvO.marker);

    const vis = await buildAttachmentParts(clip, vidIo({ frames: framesOk }), { modelCapabilities: ['chat', 'vision'] });
    const visO = vis.outcomes[0]!;
    crit('M2', visO.status === 'inlined' && !('reason' in visO)
      && vis.parts.filter((x) => x.type === 'image').length === 2,
      'M2-C **该不命中（反侧）**：同一件视频、同一份 io，**清单含 `vision`** ⇒ 画面真抽真送（2 个 image part）、'
      + '`reason` **压根不给**——与 M2-A 只差清单本身 ⇒ A/B 成立',
      `status=${visO.status} · reason在=${'reason' in visO} · imageParts=${vis.parts.filter((x) => x.type === 'image').length}`);
    // zx_20261018_2 批二：替代路文案由「若视频长于该窗口」改为按探到/未探到分档的
    //   「可切段后重发」；且未探到时**不得**声称覆盖全片（后半段是否还有画面如实说不知道）。
    crit('M2', visO.marker.includes('画面已抽 2 帧') && visO.marker.includes('仅覆盖前')
      && visO.marker.includes('源时长未探到') && visO.marker.includes('可切段后重发')
      && !visO.marker.includes('画面未处理') && !visO.marker.includes('全片'),
      'M2-D 覆盖窗口补"怎么办"：抽到帧时既说清覆盖窗口（未探到时长 ⇒ 只说"仅覆盖前 N 秒"不说全片），'
      + '又给"切段重发"的替代路；且**不说**"画面未处理"（做成了就得说做成了——「用了才算数」同族）',
      visO.marker);

    // ── ② 超限 / 不支持的 marker **补"怎么办"**（三族同尺，一条断言一族）────────────
    const bigDocIo: Partial<InlineIo> = { readFile: () => Buffer.from('x'), statSize: () => 20 * 1024 * 1024 + 1, readHead: () => null };
    const bigDoc = (await buildAttachmentParts([{ path: '/tmp/m2/长报告.txt', fileName: '长报告.txt' }], bigDocIo)).outcomes[0]!;
    crit('M2', bigDoc.status === 'omitted' && bigDoc.reason === 'over_limit' && bigDoc.marker.includes('可压缩或切成多段后重发'),
      'M2-E **超限（非图片）补"怎么办"**：`.txt` 超文档上限 ⇒ `omitted(over_limit)`，marker 给出可执行的替代动作',
      bigDoc.marker);

    const bigImgIo: Partial<InlineIo> = {
      readFile: () => Buffer.from('x'), statSize: () => 10 * 1024 * 1024 + 1, readHead: () => null,
      downscaleImage: async () => null,
    };
    const bigImg = (await buildAttachmentParts([{ path: '/tmp/m2/大图.png', fileName: '大图.png' }], bigImgIo)).outcomes[0]!;
    crit('M2', bigImg.status === 'omitted' && bigImg.reason === 'over_limit_no_downscale' && bigImg.marker.includes('可先缩小尺寸后重发'),
      'M2-F **图片超限降不动补"怎么办"**：marker 给出"先缩小尺寸后重发"的替代路（与 M2-E 同尺、不同族）',
      bigImg.marker);

    const binIo: Partial<InlineIo> = { readFile: () => Buffer.from('PK'), statSize: () => null, readHead: () => null };
    const bin = (await buildAttachmentParts([{ path: '/tmp/m2/archive.bin', fileName: 'archive.bin' }], binIo)).outcomes[0]!;
    crit('M2', bin.status === 'omitted' && bin.marker.includes('本轮不支持') && bin.marker.includes('可转成文本或图片后重发'),
      'M2-G **不支持族补"怎么办"**：`.bin` 落 `not_yet_supported` 时给出"转成文本/图片后重发"的出口',
      bin.marker);

    // ── ③ 留痕**真能到账**（结构面）：reason 经落库视图原样带出 ────────────────────────
    const m2views = toAttachmentOutcomeViews(nv.outcomes);
    crit('M2', m2views[0]?.reason === 'model_lacks_vision_frames' && m2views[0]?.status === 'inlined',
      'M2-H **留痕真能到账**：装配结果的 `reason` 经 `toAttachmentOutcomeViews` 原样带出 ⇒ 随 '
      + '`context_json.attachments_outcomes` 落库、在「本次附件」显示为「原因：…」'
      + '（不是只写在 marker 里给模型看——那用户看不见）',
      `view.reason=${String(m2views[0]?.reason)} · status=${String(m2views[0]?.status)}`);
    crit('M2', countOcc(strip(INLINE_SRC), 'model_lacks_vision_frames') === 1,
      'M2-I 降级原因码 **只有一处定义**（不是"写进 marker 一处、另抄一处判据"——G8/G9 老病）',
      `出现 ${countOcc(strip(INLINE_SRC), 'model_lacks_vision_frames')} 处`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M3·批一】判族一把尺（名实相符）：选型期与装配层同尺——魔数优先、退扩展名');
  {
    // mp4 魔数（ISO-BMFF）：`00 00 00 18 'ftyp' 'isom' …`。`sniffFileType` 认这个盒子、品牌表外 ⇒ 判 `video`。
    const mp4Head = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    ]);
    const readMp4 = (_p: string, n: number): Uint8Array => mp4Head.subarray(0, n);
    const readNull = (): null => null;

    // ── ① 核心标本：一件改名 `.mp4`→`.bin` 的视频（内容仍 mp4）⇒ 选型期必须仍要 `vision` ─────
    const needBinMp4 = attachmentsNeedVision([{ path: '/tmp/m3/movie.bin', fileName: 'movie.bin' }], readMp4);
    const needBinNoHead = attachmentsNeedVision([{ path: '/tmp/m3/movie.bin', fileName: 'movie.bin' }], readNull);
    const needMp4ByName = attachmentsNeedVision([{ fileName: 'clip.mp4' }]);
    crit('M3', needBinMp4 === true && needBinNoHead === false && needMp4ByName === true,
      'M3-A ★**一把尺（两侧同在）**：`.bin` 名 + mp4 魔数 ⇒ 要 `vision`（此前只看扩展名 ⇒ 判 `binary` ⇒ '
      + '不要 vision ⇒ 抽帧永不发生、账上无声）；**同一件 `.bin` 嗅不出** ⇒ 退扩展名判 `binary` ⇒ **不要** '
      + 'vision（A 成立确因**看了内容**，不是"见了 .bin 就放行"）；**不注入 readHead 的旧形态**下 `.mp4` 名照旧要 '
      + '`vision`（新尺是"魔数**优先**"，不是"没魔数就失灵"）',
      `bin+mp4魔数=${needBinMp4} / bin+嗅不出=${needBinNoHead} / .mp4扩展名=${needMp4ByName}`);

    // ── ② 结构面：判族真接 `sniffFileType`（一把尺）＋选型层真注入真读头（接线那一跳）─────────
    const mrSrc = strip(MR_SRC);
    crit('M3', /function familyOfAttachment/.test(mrSrc) && countOcc(mrSrc, 'sniffFileType(') >= 1
      && countOcc(mrSrc, 'familyOf(') >= 2,
      'M3-B `model-request.ts` 判族**同源**：调 `sniffFileType`（魔数真源）**且**仍调 `familyOf(`'
      + '（扩展名真源，两处：ext / kind）——不是又写第二张扩展名表',
      `sniffFileType ${countOcc(mrSrc, 'sniffFileType(')} 处 · familyOf( ${countOcc(mrSrc, 'familyOf(')} 处`);
    const exeSrc = strip(EXE_MODEL_SELECT_SRC);
    crit('M3', /import\s*\{[^}]*\breadHeadFromFile\b[^}]*\}\s*from\s*'\.\/file-head\.js'/.test(exeSrc)
      && /attachmentsNeedVision\(\s*sdkRetryCtx\.attachments\s*,\s*readHeadFromFile\s*\)/.test(exeSrc),
      'M3-C ★**接线那一跳（语句形状）**：`exec-model-select.ts` 真 `import` `readHeadFromFile` **并**把它作为'
      + '第二实参喂给 `attachmentsNeedVision`——只建 `file-head.ts` 而不接，M3-A 的"生产也同尺"就只是空话',
      '');

    // ── ③ 一处实现：读盘头部只有一份（装配层与选型层共用，不是各写一份 openSync）────────────
    const fhSrc = strip(FILE_HEAD_SRC);
    const inlineSrc = strip(INLINE_SRC);
    crit('M3', countOcc(fhSrc, 'fs.openSync(') === 1
      && countOcc(inlineSrc, 'fs.openSync(') === 0
      && /import\s*\{\s*readHeadFromFile\s*\}\s*from\s*'\.\/file-head\.js'/.test(inlineSrc)
      && countOcc(strip(MR_SRC), 'node:fs') === 0,
      'M3-D 读盘头部**恰一份实现**：`file-head.ts` 一处 `fs.openSync(`；装配层**自己不再读盘**（零 '
      + '`fs.openSync(`）改引 `readHeadFromFile`；且 `model-request.ts` 仍**零 `node:fs`**'
      + '（"同一条规则的第二、第三次实现"已消除，且零依赖性质未破）',
      `file-head ${countOcc(fhSrc, 'fs.openSync(')} 处 · inline ${countOcc(inlineSrc, 'fs.openSync(')} 处 · `
      + `model-request node:fs ${countOcc(strip(MR_SRC), 'node:fs')} 处`);

    // ── ④ 真读盘（正面断言，0→1）：`readHeadFromFile` 从盘上真件读出的头喂嗅探 ⇒ 认出 video ─────
    const headWs = fs.mkdtempSync(path.join(os.tmpdir(), 'rr20261003-m3-'));
    try {
      const diskMovie = path.join(headWs, 'renamed.bin');
      fs.writeFileSync(diskMovie, Buffer.concat([Buffer.from(mp4Head), Buffer.alloc(64, 7)]));
      const head = readHeadFromFile(diskMovie, 16);
      const fromDisk = attachmentsNeedVision([{ path: diskMovie, fileName: 'renamed.bin' }], readHeadFromFile);
      crit('M3', head !== null && head.length === 16 && fromDisk === true,
        'M3-E ★**真读盘（0→1）**：`readHeadFromFile` 从盘上那份改名 `.bin` 的真 mp4 读出 16 字节头 ⇒ '
        + '经 `attachmentsNeedVision` 认出 `video` ⇒ 要 `vision`（不是"夹具自己喂字节"——本条不注入嗅探口）',
        `head=${head ? head.length : 0} 字节 · needsVision=${fromDisk}`);
      const missing = readHeadFromFile(path.join(headWs, 'nope.bin'), 16);
      crit('M3', missing === null,
        'M3-F **读不到不抛**：不存在的路径 ⇒ `readHeadFromFile` 返 `null`（嗅探失败是**降级**，'
        + '不是把选型/装配搞挂）',
        `missing=${String(missing)}`);
    } finally {
      fs.rmSync(headWs, { recursive: true, force: true });
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M4·批二】项目知识聚合面补全（调用账 + 运行面：守护/作业）');
  {
    // 真内存库（`node:sqlite`）——夹具按**生产列形状**建表（不照抄、不简化：缺列会让真 SQL 静默抛错）。
    const { DatabaseSync } = await import('node:sqlite');
    const db2 = new DatabaseSync(':memory:');
    db2.exec(`CREATE TABLE wa_deliverables (
      id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL, name TEXT DEFAULT '',
      description TEXT DEFAULT '', file_path TEXT, registry_id TEXT, status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
    db2.exec(`CREATE TABLE wa_jobs (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}', status TEXT DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3, scheduled_at TEXT, started_at TEXT,
      completed_at TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    // 调用账真源表按**生产 DDL**（`database.ts:328`）搭——`describeServiceCalls` 读它；
    //   漏建表会让真 SQL 抛 `no such table`（不是静默 0——此读面无 try/catch，故必红，如实）。
    db2.exec(`CREATE TABLE wa_service_calls (
      id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', task_id TEXT DEFAULT '', kind TEXT NOT NULL,
      target TEXT DEFAULT '', operation TEXT DEFAULT '', ok INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0,
      error TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))`);
    const insD = db2.prepare('INSERT INTO wa_deliverables (id, project_id, type, name, status) VALUES (?,?,?,?,?)');
    const insJ = db2.prepare('INSERT INTO wa_jobs (id, type, payload, status) VALUES (?,?,?,?)');
    // P1：3 个守护（2 running / 1 stopped）；3 个作业（2 pending / 1 completed）；另各插 1 条 P2 的（**不该**计入）。
    insD.run('d1', 'P1', 'daemon', '守护甲', 'running');
    insD.run('d2', 'P1', 'daemon', '守护乙', 'running');
    insD.run('d3', 'P1', 'daemon', '守护丙', 'stopped');
    insD.run('d4', 'P1', 'mcp', '非守护', 'running');   // type≠daemon ⇒ 不入守护档（反侧：别把 MCP 算成守护）
    insD.run('d5', 'P2', 'daemon', '他家守护', 'running');
    insJ.run('j1', 'ai-task', JSON.stringify({ taskId: 't1', projectId: 'P1' }), 'pending');
    insJ.run('j2', 'ai-task', JSON.stringify({ taskId: 't2', projectId: 'P1' }), 'pending');
    insJ.run('j3', 'resume-ai-task', JSON.stringify({ taskId: 't3', projectId: 'P1', message: 'x' }), 'completed');
    insJ.run('j4', 'ai-task', JSON.stringify({ taskId: 't9', projectId: 'P2' }), 'pending');
    insJ.run('j5', 'ai-task', '{ 这不是合法 JSON', 'pending'); // 畸形 payload ⇒ 跳过（不得掀翻整张读面）
    // 调用账：给 **P2** 插 1 笔（非本项目）——M4-E 用它做**对侧标本**：P1 见 0 是**按项目隔离**所致，
    //   不是"整张表空"。只用"该不命中"样本 ⇒ 任何"全表返 0"的过宽变体都会全票通过（两标本纪律）。
    db2.prepare('INSERT INTO wa_service_calls (id, project_id, kind, target, operation, ok, duration_ms, error) VALUES (?,?,?,?,?,?,?,?)')
      .run('sc1', 'P2', 'mcp', 'svc/tool', 'call', 1, 12, '');

    const rt1 = describeProjectRuntime(db2 as never, 'P1');
    const dRun = rt1.daemons.byStatus.find((s) => s.status === 'running')?.count ?? 0;
    const jPend = rt1.jobs.byStatus.find((s) => s.status === 'pending')?.count ?? 0;
    crit('M4', rt1.daemons.total === 3 && dRun === 2 && rt1.jobs.total === 3 && jPend === 2,
      'M4-A **运行面按项目如实聚合**：守护 3（2 running/1 stopped，`type≠daemon` 的 MCP **不计**、'
      + '别家项目的守护**不计**）；作业 3（2 pending/1 completed，别家项目的作业**不计**）——'
      + '两个维度各自读**本项目**的行，不把引擎全局的账算到本项目头上',
      `daemons=${rt1.daemons.total}(running ${dRun}) · jobs=${rt1.jobs.total}(pending ${jPend})`);

    const rtEmpty = describeProjectRuntime(db2 as never, 'PNONE');
    crit('M4', rtEmpty.daemons.total === 0 && rtEmpty.jobs.total === 0
      && rtEmpty.daemons.byStatus.length === 0 && rtEmpty.jobs.byStatus.length === 0,
      'M4-B **"零"是如实值（0→1 反证）**：无任何归属行的项目 ⇒ 两侧 total 均为 0——'
      + '证 M4-A 的数**确由那些行产生**（不是恒绿的空壳），且"未发生"如实呈现为 0（不伪造）',
      `daemons=${rtEmpty.daemons.total} · jobs=${rtEmpty.jobs.total}`);

    // ── 接线那一跳（语句形状）：知识全景 handler 真把两源并进返回体 ───────────────────────
    const ipcSrc = strip(PROJECT_IPC_SRC);
    const panoAt = ipcSrc.indexOf("ipcMain.handle('project:knowledgePanorama'");
    const panoBlk = panoAt >= 0 ? ipcSrc.slice(panoAt, panoAt + 6000) : '';
    crit('M4', panoBlk.length > 0
      && /serviceCallSummary:\s*describeServiceCalls\(\s*db\s*,\s*id\s*\)/.test(panoBlk)
      && /runtimeSummary:\s*describeProjectRuntime\(\s*db\s+as\s+never\s*,\s*id\s*\)/.test(panoBlk),
      'M4-C ★**接线那一跳**：`project:knowledgePanorama` 的返回体真并进 `serviceCallSummary`（调用账）与 '
      + '`runtimeSummary`（运行面）——只建 `project-runtime-summary.ts` 而不接，A/B 的"生产也用得上"就只是空话',
      panoBlk.length ? `handler 块 ${panoBlk.length} 字节` : '未定位到 handler');

    // ── 只读 + 零 electron：聚合模块可被 rr 直跑真实现（IPC 层自己引 electron）─────────────
    const rtSrc = strip(RT_SUMMARY_SRC);
    crit('M4', countOcc(rtSrc, 'INSERT') === 0 && countOcc(rtSrc, 'UPDATE') === 0
      && countOcc(rtSrc, 'DELETE') === 0 && !/from\s*'electron'/.test(rtSrc),
      'M4-D **只读聚合 + 可测**：`project-runtime-summary.ts` 零 `INSERT`/`UPDATE`/`DELETE`（刷新不改库），'
      + '且不引 `electron`（故 rr 能拿内存库直跑生产真实现，非照抄等价物）',
      `写语句 ${countOcc(rtSrc, 'INSERT') + countOcc(rtSrc, 'UPDATE') + countOcc(rtSrc, 'DELETE')} 处`);

    // ── 调用账读面（既有真源）**能被 JSON 序列化**（与运行面同走 IPC 边界，不递活对象）────────
    const scReport = describeServiceCalls(db2 as never, 'P1');
    const scP2 = describeServiceCalls(db2 as never, 'P2'); // 对侧：P2 那 1 笔**真读得到**（0→1 反证）
    crit('M4', scReport.total === 0 && scReport.byKind.length === 3
      && scReport.byKind.every((k) => k.calls === 0 && k.lastError === null)
      && scP2.total === 1,
      'M4-E 调用账**三类都出栏**且**按项目隔离**：本项目 0 通话时 `describeServiceCalls` 仍列出 '
      + 'mcp/a2a/daemon 三档、各 `calls:0`、`lastError:null`（"没发生过"≠"没这一栏"）；'
      + '**同时** P2 那 1 笔**读得到** ⇒ P1 的 0 是**隔离**所致，不是"整表空"或"恒 0 空壳"（两标本）',
      `P1 total=${scReport.total} · kinds=${scReport.byKind.map((k) => k.kind).join(',')} · P2 total=${scP2.total}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M5·批二】panorama 综合纳入非记忆原料（三元组 + 交付物 byType + 调用账成败）');
  {
    const { DatabaseSync } = await import('node:sqlite');
    const db3 = new DatabaseSync(':memory:');
    // 三张表按**生产 DDL** 搭（缺列会让真 SQL 抛错/静默空集 ⇒ 断言假绿，承 `feedback_rr_fixture_production_order`）。
    db3.exec(`CREATE TABLE wa_knowledge_triples (
      id TEXT PRIMARY KEY, project_id TEXT, subject TEXT NOT NULL, predicate TEXT NOT NULL,
      object TEXT NOT NULL, confidence REAL DEFAULT 0.5, source TEXT DEFAULT 'agent_extraction',
      created_at TEXT DEFAULT (datetime('now')))`);
    db3.exec(`CREATE TABLE wa_deliverables (
      id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL, name TEXT DEFAULT '',
      description TEXT DEFAULT '', file_path TEXT, registry_id TEXT, status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
    db3.exec(`CREATE TABLE wa_service_calls (
      id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', task_id TEXT DEFAULT '', kind TEXT NOT NULL,
      target TEXT DEFAULT '', operation TEXT DEFAULT '', ok INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0,
      error TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))`);
    const insT = db3.prepare('INSERT INTO wa_knowledge_triples (id, project_id, subject, predicate, object, confidence) VALUES (?,?,?,?,?,?)');
    const insD = db3.prepare('INSERT INTO wa_deliverables (id, project_id, type, file_path, name, status) VALUES (?,?,?,?,?,?)');
    const insS = db3.prepare('INSERT INTO wa_service_calls (id, project_id, kind, target, operation, ok, duration_ms, error) VALUES (?,?,?,?,?,?,?,?)');
    // P1：2 条关系（高/低可信各一）+ 2 件交付物（doc/code）+ 2 笔调用（1 成 1 败）。
    insT.run('t1', 'P1', '项目', 'uses', 'SQLite', 0.9);
    insT.run('t2', 'P1', '项目', 'depends_on', 'ANS', 0.4);
    insD.run('p1d1', 'P1', 'doc', 'docs/a.md', 'a.md', 'ready');
    insD.run('p1d2', 'P1', 'code', 'src/b.ts', 'b.ts', 'ready');
    insS.run('p1s1', 'P1', 'mcp', 'svc/tool', 'call', 1, 20, '');
    insS.run('p1s2', 'P1', 'daemon', '守护甲', 'start', 0, 5, '端口被占');
    // P2（别家）——**不该**混入 P1。
    insT.run('t9', 'P2', '他家', 'uses', '别的', 1.0);
    insD.run('p2d1', 'P2', 'doc', 'docs/x.md', 'x.md', 'ready');
    insS.run('p2s1', 'P2', 'mcp', 'other/tool', 'call', 1, 1, '');

    const mat = collectProjectKnowledgeMaterials(db3 as never, 'P1');
    const sc = mat.serviceCalls;
    crit('M5', mat.triples.length === 2 && mat.triples[0]!.subject === '项目'
      && mat.deliverablesByType.reduce((a, d) => a + d.count, 0) === 2
      && sc.total === 2 && sc.ok === 1 && sc.failed === 1 && sc.byKind.length === 3,
      'M5-A **非记忆原料按项目如实聚合**：三元组 2（**只本项目**、按可信度排序）、交付物 byType 合计 2、'
      + '调用账 2 笔（成 1 / 败 1，三类都出栏）——P2 的关系/交付物/调用**皆不计**',
      `triples=${mat.triples.length}(${mat.triples.map(t => t.object).join('/')}) · deliv=${mat.deliverablesByType.reduce((a, d) => a + d.count, 0)} · calls=${sc.total}(ok ${sc.ok}/bad ${sc.failed})`);

    const matEmpty = collectProjectKnowledgeMaterials(db3 as never, 'PNONE');
    crit('M5', matEmpty.triples.length === 0 && matEmpty.deliverablesByType.length === 0
      && matEmpty.serviceCalls.total === 0,
      'M5-B **"零"是如实值（0→1 反证）**：无任何非记忆原料的项目 ⇒ 三样皆空——证 M5-A 的数**确由那些行产生**，'
      + '非恒绿空壳；"未发生"如实呈现（不伪造）。',
      `triples=${matEmpty.triples.length} · deliv=${matEmpty.deliverablesByType.length} · calls=${matEmpty.serviceCalls.total}`);

    const text = formatKnowledgeMaterials(mat);
    const emptyText = formatKnowledgeMaterials(matEmpty);
    crit('M5', text.includes('【项目关系') && text.includes('项目 ─[uses]→ SQLite')
      && text.includes('【已产出') && text.includes('doc:1') && text.includes('code:1')
      && text.includes('【服务调用账') && text.includes('合计 2（成功 1 / 失败 1）')
      && text.includes('mcp: 1 次（成 1 / 败 0）') && text.includes('daemon: 1 次（成 0 / 败 1）')
      && emptyText === '',
      'M5-C **格式化真含三样、空则不出段**：非记忆原料渲染出关系行 / 交付物计数 / 调用成败三段'
      + '（调用账三档都出栏，含 0 次的 a2a）；空原料 ⇒ **空串**（不给 LLM 灌空壳）。',
      `len=${text.length} · empty=“${emptyText}”`);

    // ── 接线那一跳（语句形状）：综合函数真把非记忆原料并进 **prompt** ──────────────────────
    const mmSrc = strip(MEM_MANAGER_SRC);
    const fnAt = mmSrc.indexOf('async synthesizeProjectKnowledge(');
    const fnBlk = fnAt >= 0 ? mmSrc.slice(fnAt, fnAt + 4000) : '';
    crit('M5', fnBlk.length > 0
      && /collectProjectKnowledgeMaterials\(\s*this\.db\s*,\s*projectId\s*\)/.test(fnBlk)
      && /formatKnowledgeMaterials\(/.test(fnBlk)
      && /\$\{memoriesText\}\$\{materialsBlock\}/.test(fnBlk),
      'M5-D ★**接线那一跳**：`synthesizeProjectKnowledge` 真调 `collectProjectKnowledgeMaterials(this.db, projectId)` '
      + '并 `formatKnowledgeMaterials` 化文本、**拼进 prompt**（`${memoriesText}${materialsBlock}`）——'
      + '只建模块不接，A/B/C 的"生产也用得上"就只是空话。',
      fnBlk.length ? `函数块 ${fnBlk.length} 字节` : '未定位到函数');

    const matSrc = strip(PROJ_KNOW_MAT_SRC);
    crit('M5', countOcc(matSrc, 'INSERT') === 0 && countOcc(matSrc, 'UPDATE') === 0
      && countOcc(matSrc, 'DELETE') === 0 && !/from\s*'electron'/.test(matSrc),
      'M5-E **只读聚合 + 可测**：`project-knowledge-materials.ts` 零 `INSERT`/`UPDATE`/`DELETE`（综合前读面不改库），'
      + '且不引 `electron`（故 rr 能拿内存库**直跑生产真实现**，非照抄等价物）。',
      `写语句 ${countOcc(matSrc, 'INSERT') + countOcc(matSrc, 'UPDATE') + countOcc(matSrc, 'DELETE')} 处`);

    crit('M5', !/训练|微调|fine[- ]?tune|\btrain\b/i.test(matSrc)
      && !/训练|微调|fine[- ]?tune|\btrain\b/i.test(fnBlk),
      'M5-F **守 K-4（知识产物，非权重）**：非记忆原料只**读 + 拼文本**喂 LLM 综合，源码内**零**'
      + '"训练/微调/fine-tune/train"字样——不得宣称训练小模型。',
      '训练类字样 0 处');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M6·批二】知识面上屏 + 注入确认（运行面上屏 · §0/§6/§7 真注入）');
  {
    // ── 上屏（源码 + 产物）──────────────────────────────────────────────────
    const cardSrc = strip(KF_CARD_SRC);
    crit('M6', cardSrc.includes('project-runtime-summary.js')
      && cardSrc.includes('projects.knowledgePanorama(')
      && /\.runtimeSummary/.test(cardSrc) && cardSrc.includes('项目运行面'),
      'M6-A **上屏有真数据源（不空造块）**：`KnowledgeFaceCard` 取形状于 main 侧真源 '
      + '`project-runtime-summary.ts`、经既有 handler `projects.knowledgePanorama` 读 `runtimeSummary`——'
      + '非硬编码空壳；卡题即其所量（项目运行面）。',
      `引真源 ${cardSrc.includes('project-runtime-summary.js')} · 读运行面 ${/\.runtimeSummary/.test(cardSrc)}`);

    // M6-A′ 词表单源（"renderer 是词表的第二个落点"纪律）：作业状态词表**不自带**，引 `lib/status-view.ts` 的唯一真源。
    //   （全局面另有 `rr_zx_20260930` D-c-2 兜底"定义点只剩两文件"；此处在 M6 本落点就近钉一次，便于日后定位。）
    const svSrc = strip(SV_LIB_SRC);
    crit('M6', /import\s*\{[^}]*\bJOB_STATUS_LABEL\b[^}]*\}\s*from\s*'..\/lib\/status-view'/.test(cardSrc)
      && !/(const|let)\s+JOB_STATUS_LABEL\b/.test(cardSrc)
      && /export\s+const\s+JOB_STATUS_LABEL\b/.test(svSrc),
      'M6-A′ **词表单源**：卡的作业状态词表**不自带**、引 `lib/status-view.ts` 的 `JOB_STATUS_LABEL`'
      + '（`wa_jobs.status` 域真源）——卡内零处 `const JOB_STATUS_LABEL`（防"新落点又抄一张表"）。',
      `引共享表 ${/import\s*\{[^}]*\bJOB_STATUS_LABEL\b/.test(cardSrc)} · 卡内自称 ${/(const|let)\s+JOB_STATUS_LABEL\b/.test(cardSrc)}`);

    const pdSrc = strip(PD_PAGE_SRC);
    const svcAt = pdSrc.indexOf('<ServiceCallCard projectId={id!} />');
    const kfAt = pdSrc.indexOf('<KnowledgeFaceCard projectId={id!} />');
    crit('M6', pdSrc.includes("import KnowledgeFaceCard from '../components/KnowledgeFaceCard'")
      && svcAt >= 0 && kfAt > svcAt,
      'M6-B **落点如约（`ServiceCallCard` 之后）**：`ProjectDetailPage` 引 `KnowledgeFaceCard` 且渲染于 '
      + '`<ServiceCallCard>` **之后**——顺序由源码**索引**判（非行号，承"锚点按符号不按行号"）。',
      `ServiceCallCard@${svcAt} · KnowledgeFaceCard@${kfAt}`);

    // 产物（词表第二落点）：搜**中文串**——标识符被 minify，搜符号会假绿（CLAUDE.md 明写的纪律）。
    const assetsDir = path.join(root, A, 'renderer/dist/assets');
    const chunks = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter((f) => /^ProjectDetailPage-.*\.js$/.test(f)) : [];
    crit('M6', chunks.length === 1,
      'M6-C ★扫描面自证：renderer 产物恰 1 份 `ProjectDetailPage-*.js`（本判据须 renderer 先 build）',
      chunks.join(',') || 'renderer/dist/assets 不存在（未经 build ⇒ 本判据无法成立）');
    const js = chunks.length === 1 ? fs.readFileSync(path.join(assetsDir, chunks[0]!), 'utf-8') : '';
    crit('M6', js.includes('项目运行面') && js.includes('守护进程 / 作业队列的'),
      'M6-D **上屏到产物**：构建产物内**真含**卡标题与量尺声明（搜中文串；"只写在源码、没打进 GUI"在此必红）',
      `标题在场 ${js.includes('项目运行面')} · 声明在场 ${js.includes('守护进程 / 作业队列的')}`);

    // ── 注入确认（真 `MemoryManager` × 真 `buildMemoryContext`）─────────────
    // 夹具按**生产初始化顺序**：先 `new MemoryManager`（建 FTS 触发器）再插行——顺序颠倒则首次
    // UPDATE 命中未索引 rowid、抛错被 try/catch 吞 ⇒ 段判据假绿（承 feedback_rr_fixture_production_order）。
    const { DatabaseSync } = await import('node:sqlite');
    type AnyDb = import('better-sqlite3').Database;
    const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  status TEXT DEFAULT 'active', working_dir TEXT DEFAULT '', context_json TEXT DEFAULT '{}',
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
CREATE TABLE wa_knowledge_triples (id TEXT PRIMARY KEY, project_id TEXT, subject TEXT NOT NULL,
  predicate TEXT NOT NULL, object TEXT NOT NULL, confidence REAL DEFAULT 0.5,
  source TEXT DEFAULT 'agent_extraction', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_project_knowledge (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, section TEXT NOT NULL,
  content TEXT NOT NULL, source_ref TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_wa_project_knowledge_sec ON wa_project_knowledge(project_id, section);
-- zx_20261022_3 批七/批八：读册已合并「导入册」，画像段同由真 MemoryManager 读取（生产 database.ts 同 DDL）。
--   缺表 ⇒ 读取抛 no such table 被装配点 catch ⇒ §K 整段消失（夹具失真，不是生产缺陷）。
CREATE TABLE wa_project_knowledge_imports (
  project_id TEXT NOT NULL, section TEXT NOT NULL, content TEXT NOT NULL,
  precedence INTEGER NOT NULL DEFAULT 0, source_hash TEXT NOT NULL DEFAULT '',
  imported_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, section)
);
CREATE TABLE wa_project_profiles (
  project_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, source_hash TEXT NOT NULL DEFAULT '',
  profile_json TEXT NOT NULL, generated_at TEXT DEFAULT (datetime('now')),
  enabled INTEGER NOT NULL DEFAULT 1, origin TEXT NOT NULL DEFAULT 'local', source_project_name TEXT DEFAULT ''
);`;
    const dbI = new DatabaseSync(':memory:');
    dbI.exec(SCHEMA);
    const memory = new MemoryManager(dbI as unknown as AnyDb, null as never); // ← FTS 触发器在此建成
    const PROJECT = 'p-inject'; const TASK = 't-inject';
    const TITLE = '确认 SQLite 知识面注入链路';
    const DESC = '在真任务里确认项目域知识 / 高频复用 / 知识关联三段真进上下文';
    dbI.prepare('INSERT INTO wa_projects (id, name, context_json) VALUES (?,?,?)').run(PROJECT, '注入确认项目', '{}');
    dbI.prepare('INSERT INTO wa_tasks (id, project_id, title, description, context_json) VALUES (?,?,?,?,?)')
      .run(TASK, PROJECT, TITLE, DESC, '{}');
    const addMem = (id: string, type: string, content: string, importance = 0.8) =>
      dbI.prepare(`INSERT INTO wa_memories (id, project_id, task_id, content, memory_type, importance, valence, context_json, use_count)
                  VALUES (?,?,?,?,?,?,?,?,0)`)
        .run(id, PROJECT, TASK, content, type, importance, 'neutral', JSON.stringify({ experience: 'direct' }));
    // §K：一条**派生事实**（零 LLM 册；zx_20261014_4 批五起取代原 §0 的 `memory_type='panorama'` 散文段）。
    dbI.prepare('INSERT INTO wa_project_knowledge (id, project_id, section, content, source_ref) VALUES (?,?,?,?,?)')
      .run('i-k1', PROJECT, 'entities', '实体甲 ─[uses]→ 实体乙', 'wa_knowledge_triples');
    // §6 需"第 1 段（项目知识 top5）没吃掉"的新鲜语义知识：8 语义 + 3 程序。布局：
    //   · 段1「项目知识」按**原始重要度**取前 5 = 3 程序 + s1/s2 ⇒ s3 未被段1 吃掉；
    //   · s5..s8 正文含 `SQLite`（题面词）⇒ 段5b「线索匹配记忆」按 cue 命中去吃 s5..s8（topK=4），**不碰 s3**；
    //   · 段6「高频复用知识」按自己的尺（0.4·重要度+0.6·提取强度）取前 3 语义 = s1,s2,s3 ⇒ s3 **新鲜**入段6。
    //   （若 s3 被前序段吃掉，则段6 静默不出——这正是本判据要照出的"注入链路没生效"。）
    for (let i = 1; i <= 8; i++) addMem(`i-sem${i}`, 'semantic', `语义知识${i}：` + (i >= 5 ? '本项目用 SQLite 存储。' : '') + '内容正文'.repeat(20), 0.90 - (i - 1) * 0.05);
    for (let i = 1; i <= 3; i++) addMem(`i-pro${i}`, 'procedural', `程序经验${i}：` + '内容正文'.repeat(20), 0.95 - (i - 1) * 0.01);
    // §7：题面含 `SQLite` ⇒ `retrieveKnowledgeGraphContext` 以该词 LIKE 命中本条三元组（object 小写，SQLite LIKE 对 ASCII 不区分大小写）。
    dbI.prepare('INSERT INTO wa_knowledge_triples (id, project_id, subject, predicate, object, confidence) VALUES (?,?,?,?,?,?)')
      .run('it1', PROJECT, '项目', 'uses', 'sqlite', 0.9);

    const ctx = buildMemoryContext(memory, PROJECT, TASK, null, null, undefined, 100_000).context;
    const hasKnow = ctx.includes('## 项目域知识');
    const hasFreq = ctx.includes('## 高频复用知识');
    const hasGraph = ctx.includes('## 相关知识关联') && ctx.includes('项目 ─[uses]→ sqlite');
    crit('M6', hasKnow && hasFreq && hasGraph && (ctx.match(/^## /gm)?.length ?? 0) >= 3,
      'M6-E **§K/§6/§7 在真任务里真进上下文**：真 `MemoryManager`（内存库真行）× 真 `buildMemoryContext` ⇒ '
      + '上下文含 `## 项目域知识`（§K，零 LLM 派生册）、`## 高频复用知识`（§6）、`## 相关知识关联`（§7，三元组按 `─[pred]→` 形态落文）。',
      `段数 ${(ctx.match(/^## /gm)?.length ?? 0)} · 域知识 ${hasKnow} · 高频 ${hasFreq} · 图谱 ${hasGraph}`);

    // 反证（另一只标本）：同题面、项目内**零**记忆/零三元组 ⇒ 三段皆不出现（证 M6-E 非"分段恒在"的空壳）。
    const PROJECT2 = 'p-inject-empty'; const TASK2 = 't-inject-empty';
    dbI.prepare('INSERT INTO wa_projects (id, name, context_json) VALUES (?,?,?)').run(PROJECT2, '空项目', '{}');
    dbI.prepare('INSERT INTO wa_tasks (id, project_id, title, description, context_json) VALUES (?,?,?,?,?)')
      .run(TASK2, PROJECT2, TITLE, '同题面但本项目无任何记忆/关系', '{}');
    const ctx2 = buildMemoryContext(memory, PROJECT2, TASK2, null, null, undefined, 100_000).context;
    const e2 = { know: ctx2.includes('## 项目域知识'), freq: ctx2.includes('## 高频复用知识'), graph: ctx2.includes('## 相关知识关联') };
    crit('M6', !e2.know && !e2.freq && !e2.graph,
      'M6-F **0→1 反证（两标本）**：同一把尺、同题面，而项目内**零记忆/零三元组** ⇒ 三段**皆不出现**——'
      + '证 M6-E 的三段确由那些真行产生，不是分段恒在。',
      `空项目：域知识 ${e2.know} · 高频 ${e2.freq} · 图谱 ${e2.graph}`);

    // 注入链路在**装配点到执行点**之间真被用上：执行体取 `buildMemoryContext` 的产物 → 交 `buildTaskContext`
    //   包成 `<memory-context>` system 消息。三跳各按**语句形状**钉（等价性证不了"接上了"）。
    const exSrcM6 = strip(EXEC_SRC);
    const mcSrcM6 = strip(path.join(root, A, 'src/main/core/memory-context.ts'));
    const oneCall = countOcc(exSrcM6, 'buildMemoryContext(') === 1;
    crit('M6', oneCall && exSrcM6.includes('memoryContext = built.context')
      && exSrcM6.includes('userPrefs, memoryContext') && mcSrcM6.includes('<memory-context>'),
      'M6-G **接线那一跳（三跳按形状）**：执行体 `buildMemoryContext(...)` **恰一处** → `memoryContext = built.context` → '
      + '把 `memoryContext` 作实参交 `buildTaskContext`；包裹成 `<memory-context>` system 消息的模板在 `memory-context.ts`。'
      + '§K/§6/§7 不是"只在模块里生成"，而是真进任务上下文。',
      `调用点恰一处 ${oneCall} · 取 context ${exSrcM6.includes('memoryContext = built.context')} · 作实参 ${exSrcM6.includes('userPrefs, memoryContext')} · 包裹在场 ${mcSrcM6.includes('<memory-context>')}`);

    // M6-H 真缺陷钉（本卡"注入确认"照出）：`searchKnowledgeGraph` 的 1 跳扩展 SQL 有**两处** `IN (...)`
    //   占位，此前只绑一遍实体 ⇒ 参数少于占位、抛错被上层 catch 吞成 `[]` ⇒ **§7 常见情形静默恒空**。
    //   两标本：① 单条直接命中 + 一跳可达 ⇒ 返回 ≥2 条（修复前此处必抛）；② 同尺下不可达查询 ⇒ 空。
    const kgHit = memory.searchKnowledgeGraph('SQLite', PROJECT, 5);
    const kgMiss = memory.searchKnowledgeGraph('绝无此词XYZ', PROJECT, 5);
    crit('M6', kgHit.length >= 1 && kgHit.every((t) => t.subject === '项目' && t.object === 'sqlite')
      && kgMiss.length === 0,
      'M6-H **1 跳扩展参数绑定真缺陷已修（两标本）**：`searchKnowledgeGraph` 对单条直接命中做 1 跳扩展时'
      + '不再抛 `datatype mismatch`/`RangeError`（实体绑两遍，凑齐两处 `IN` 占位）；不可达查询仍如实返回空。',
      `命中 ${kgHit.length} 条 · 空 ${kgMiss.length} 条`);
  }

  // ── §M11 会话流长文可收可展（渲染层形态；判据跑**真实现** `needsClamp`）────
  {
    const lib = strip(CLAMP_LIB_SRC);
    const cmp = strip(CLAMP_CMP_SRC);
    const im = strip(IM_PAGE_SRC);

    // M11-A 判据同源：折叠与否的**唯一一把尺**是纯函数 `needsClamp`——渲染层不自带第二份，
    //   且该尺不引 react（纯算术 ⇒ rr 可跑真实现，不必造 DOM）。
    crit('M11', /export\s+function\s+needsClamp\b/.test(lib)
      && !/from\s*'react'/.test(lib) && !/\buseState\b/.test(lib),
      'M11-A **一把尺且纯净**：`clamp-text.ts` 导出纯函数 `needsClamp`、**零** react 依赖（判定收进可测的纯算术，'
      + '组件不自带第二把尺——G8/G9 老病的同一防法）。',
      `导出 needsClamp ${/export\s+function\s+needsClamp\b/.test(lib)} · 引 react ${/from\s*'react'/.test(lib)}`);

    // M11-A′ 两阈值**两面同在**（跑真 `needsClamp`）：长文（>280 字）折 / 短文不折；9 行折 / 恰 8 行不折；空串如实不折。
    const longTxt = '汉'.repeat(281);
    const s8 = Array.from({ length: 8 }, (_, i) => 'line' + i).join('\n');
    const s9 = Array.from({ length: 9 }, (_, i) => 'line' + i).join('\n');
    const bLong = needsClamp(longTxt) === true;
    const bShort = needsClamp('短句') === false;
    const b8 = needsClamp(s8) === false;
    const b9 = needsClamp(s9) === true;
    const bEmpty = needsClamp('') === false;
    crit('M11', bLong && bShort && b8 && b9 && bEmpty,
      'M11-A′ **两阈值两面同在（跑真 `needsClamp`）**：>280 字折 / 短文不折；>8 行折 / 恰 8 行不折；空串如实不折——'
      + '字符数与行数**两条都真在起作用**（不是"只要够长就折"的空壳；只测该命中侧则任何过宽变体全票通过）。',
      `长 ${bLong} · 短 ${bShort} · 8行 ${b8} · 9行 ${b9} · 空 ${bEmpty}`);

    // M11-B 组件：引真尺、折叠态限高、「展开/收起」两口俱在（展开与收起是**两条路**，缺一即残）。
    crit('M11', /import\s*\{[^}]*\bneedsClamp\b[^}]*\}\s*from\s*'\.\.\/lib\/clamp-text'/.test(cmp)
      && cmp.includes('max-h-40') && cmp.includes('overflow-hidden')
      && cmp.includes('展开全文') && cmp.includes('收起'),
      'M11-B 组件**引真尺 + 两口俱在**：`ClampText.tsx` 自 `../lib/clamp-text` 引 `needsClamp`（判据同源），'
      + '折叠态 `max-h-40 overflow-hidden` 限高，「展开全文」与「收起」**两个出口都在**（只展不收 = 单向死路）。',
      `引尺 ${/needsClamp/.test(cmp)} · 限高 ${cmp.includes('max-h-40')} · 展开 ${cmp.includes('展开全文')} · 收起 ${cmp.includes('收起')}`);

    // M11-C 接线那一跳：IMPage 真引 `ClampText` **并**在正文分支真渲染它（建组件不接 = 白建，承
    //   feedback_equivalence_needs_wiring_criterion）。乐观气泡与文本正文分支各一处。
    crit('M11', /import\s*\{[^}]*\bClampText\b[^}]*\}\s*from\s*'\.\.\/components\/ClampText'/.test(im)
      && countOcc(im, '<ClampText') >= 2,
      'M11-C **接线那一跳（语句形状）**：`IMPage.tsx` 真 `import` `ClampText` 且在**乐观气泡**与**文本正文分支**'
      + '两处真渲染（`<ClampText` ≥2）——只建组件不接，长文照样铺满整个 55vh 滚动区。',
      `import 在场 ${/ClampText/.test(im)} · <ClampText 处数 ${countOcc(im, '<ClampText')}`);

    // M11-D 产物（词表第二落点）：搜**中文串**——标识符被 minify，搜符号会假绿（CLAUDE.md 明写的纪律）。
    const assetsDir11 = path.join(root, A, 'renderer/dist/assets');
    const js11 = fs.existsSync(assetsDir11)
      ? fs.readdirSync(assetsDir11).filter((f) => f.endsWith('.js'))
        .map((f) => fs.readFileSync(path.join(assetsDir11, f), 'utf-8')).join('\n')
      : '';
    crit('M11', js11.includes('展开全文') && js11.includes('收起'),
      'M11-D **上屏到产物**：renderer 构建产物内**真含**「展开全文」「收起」（搜中文串；"只写在源码、没打进 GUI"必红）',
      `展开全文 ${js11.includes('展开全文')} · 收起 ${js11.includes('收起')}`);
  }

  // ── §M8 `finalize_task` 纯搬移（三层钉：恰一份实现 / 实现体真搬 / 接线那一跳）──
  {
    const ctrl = strip(CONTROL_SRC);
    const fin = strip(CONTROL_FINALIZE_SRC);
    crit('M8', countOcc(fin, 'export async function runFinalizeTask') === 1
      && countOcc(ctrl, 'async function runFinalizeTask') === 0,
      'M8-A **恰一份实现（两侧同在）**：`control-finalize.ts` 恰一处 `export async function runFinalizeTask`；'
      + '`control.ts` **零处**定义（旧位置不再有实现体）——不是"两处各留一份"。',
      `新 ${countOcc(fin, 'export async function runFinalizeTask')} 处 · 旧 ${countOcc(ctrl, 'async function runFinalizeTask')} 处`);
    crit('M8', countOcc(fin, 'MEM_LIVE_SQL') >= 1 && countOcc(ctrl, 'MEM_LIVE_SQL') === 0
      && countOcc(fin, 'unclaimedMilestones(') >= 1 && countOcc(ctrl, 'unclaimedMilestones(') === 0,
      'M8-B **实现体真搬过去了（反证旧体）**：`MEM_LIVE_SQL`、`unclaimedMilestones(` 只在新文件出现、旧文件零处——'
      + '证搬的是**那一整段**，不是建了个空壳文件再留旧的。',
      `MEM_LIVE_SQL 新${countOcc(fin, 'MEM_LIVE_SQL')}/旧${countOcc(ctrl, 'MEM_LIVE_SQL')} · unclaimedMilestones 新${countOcc(fin, 'unclaimedMilestones(')}/旧${countOcc(ctrl, 'unclaimedMilestones(')}`);
    crit('M8', /import\s*\{[^}]*\brunFinalizeTask\b[^}]*\}\s*from\s*'\.\/control-finalize\.js'/.test(ctrl)
      && /runFinalizeTask\(deps,\s*args\)/.test(ctrl),
      'M8-C **接线那一跳（语句形状）**：`control.ts` 真 `import` `runFinalizeTask` 且 `finalize_task` 的 execute **真调用** '
      + '`runFinalizeTask(deps, args)`——只建文件不接，finalize 路当场断（等价性证不了"接上了"）。',
      `import 在场 ${/control-finalize\.js/.test(ctrl)} · 调用在场 ${/runFinalizeTask\(deps,\s*args\)/.test(ctrl)}`);
  }

  // ── §M9 F3 推送纯搬移（三层钉；顺带 storm-guard / notify-dir 两簇）──
  {
    const ir = strip(IM_ROUTER_SRC);
    const f3 = strip(F3_PUSH_SRC);
    const sg = strip(IM_STORM_GUARD_SRC);
    const nd = strip(NOTIFY_DIR_SRC);
    crit('M9', countOcc(f3, 'async function processF3NotificationFiles') === 1
      && countOcc(f3, 'export function isProbeNotifyFile') === 1
      && countOcc(ir, 'async function processF3NotificationFiles') === 0
      && countOcc(ir, 'export function isProbeNotifyFile') === 0,
      'M9-A **恰一份实现（两侧同在）**：F3 三件（`processF3NotificationFiles`/`isProbeNotifyFile`/前缀表）只在 '
      + '`f3-notification-push.ts` 定义；`im-router.ts` **零处**定义（旧位置不再有实现体）。',
      `F3 新(${countOcc(f3, 'async function processF3NotificationFiles')},${countOcc(f3, 'export function isProbeNotifyFile')}) · 旧(${countOcc(ir, 'async function processF3NotificationFiles')},${countOcc(ir, 'export function isProbeNotifyFile')})`);
    crit('M9', /import\s*\{[^}]*\bisProbeNotifyFile\b[^}]*\}\s*from\s*'\.\/f3-notification-push\.js'/.test(ir)
      && /from\s*'\.\.\/core\/im-storm-guard\.js'/.test(ir) && /from\s*'\.\.\/core\/notify-dir\.js'/.test(ir)
      && /export\s*\{[^}]*\btriggerF3Notification\b[^}]*\}/.test(ir),
      'M9-B **接线那一跳（语句形状）**：`im-router.ts` 真 `import` 三个新真源（F3 推送 / storm-guard / notify-dir）并 '
      + '`export { … }` **再导出**——老消费方（`im.ipc`/`ai-task`/rr）不改一行仍解析得到（同名再导出是搬移的接口脊梁）。',
      `f3 引 ${/f3-notification-push\.js/.test(ir)} · storm 引 ${/im-storm-guard\.js/.test(ir)} · notify 引 ${/notify-dir\.js/.test(ir)} · 再导出 ${/export\s*\{[^}]*\btriggerF3Notification\b/.test(ir)}`);
    crit('M9', countOcc(sg, 'export function stormVerdict') === 1 && countOcc(sg, 'export const STORM_WINDOW_MS') === 1
      && countOcc(ir, 'function stormVerdict') === 0 && countOcc(ir, 'const STORM_WINDOW_MS') === 0
      && countOcc(nd, 'let _notificationDir') === 1 && countOcc(ir, 'let _notificationDir') === 0,
      'M9-C **顺带两簇同钉**：storm-guard（`stormVerdict` + 三阈值）归 `im-storm-guard.ts`、通知目录持有者 '
      + '`_notificationDir` 归 `notify-dir.ts`；`im-router.ts` 两处定义皆零（目录**单一持有者**，防两份）。',
      `storm 新${countOcc(sg, 'export function stormVerdict')}/旧${countOcc(ir, 'function stormVerdict')} · dir 新${countOcc(nd, 'let _notificationDir')}/旧${countOcc(ir, 'let _notificationDir')}`);
  }

  // ── §M12 逐渠道未读红点（main 一处算 → 只读 IPC → 渲染层消费）───────────────
  {
    const un = strip(IM_UNREAD_SRC);
    const ipc = strip(IM_IPC_SRC);
    const ripc = strip(R_IPC_SRC);
    const im = strip(IM_PAGE_SRC);

    // M12-A 新增的是**同一本账的第二粒度**，不是第二本账：真源仍是每渠道水位 `im_read_at:<id>`、
    //   缺省回落全局 `getImLastReadAt`，WHERE 与总数面同一句（`direction = 'inbound'`），只按渠道分组。
    crit('M12', countOcc(un, 'export function computeImUnreadByChannel') === 1
      && /im_read_at:/.test(un) && /GROUP BY\s+c\.channel_id/.test(un)
      && /direction = 'inbound'/.test(un) && /getImLastReadAt\(db\)/.test(un),
      `M12-A **同一本账的第二粒度（非第二本账）**：\`im-unread.ts\` 新增 \`computeImUnreadByChannel\`（恰一处）——`
      + `真源仍是**每渠道水位** \`im_read_at:<id>\`、缺省回落全局 \`getImLastReadAt\`、WHERE 与总数面**同一句**`
      + ` \`direction = 'inbound'\`，只按 \`channel_id\` 分组。未读账**仍 main 一处算**。`,
      `导出 ${countOcc(un, 'export function computeImUnreadByChannel')} 处 · 每渠道水位 ${/im_read_at:/.test(un)} · 分组 ${/GROUP BY\s+c\.channel_id/.test(un)} · 同 WHERE ${/direction = 'inbound'/.test(un)}`);

    // M12-A′ 两标本**跑真实现**（真 SQL × 真内存库）：逐渠道分解真成立，且"清一个渠道不动另一个"。
    type UnreadDb = Parameters<typeof computeImUnreadByChannel>[0];
    const { DatabaseSync } = await import('node:sqlite');
    const dbU = new DatabaseSync(':memory:');
    dbU.exec(`CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_im_conversations (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, direction TEXT, created_at TEXT, message_json TEXT DEFAULT '{}');`);
    dbU.prepare("INSERT OR REPLACE INTO wa_settings (key, value) VALUES ('im_last_read_at', '2020-01-01 00:00:00')").run();
    const addRow = (id: string, ch: string, dir: string, at: string) =>
      dbU.prepare('INSERT INTO wa_im_conversations (id, channel_id, external_user_id, direction, created_at) VALUES (?,?,?,?,?)').run(id, ch, 'u1', dir, at);
    const emptyByc = computeImUnreadByChannel(dbU as unknown as UnreadDb);
    const emptyOk = Object.keys(emptyByc).length === 0;                 // 0→1 的下界：还没有入站 ⇒ 空
    addRow('r1', 'ch1', 'inbound', '2021-01-01 00:00:00');
    addRow('r2', 'ch1', 'inbound', '2021-01-02 00:00:00');
    addRow('r3', 'ch2', 'inbound', '2021-01-03 00:00:00');
    addRow('r4', 'ch1', 'outbound', '2021-01-04 00:00:00');            // 出站**不算**未读（反证方向真在过滤）
    addRow('r5', 'ch3', 'outbound', '2021-01-05 00:00:00');            // 只有出站的渠道 ⇒ 无键
    const byc = computeImUnreadByChannel(dbU as unknown as UnreadDb);
    const breakdownOk = byc['ch1'] === 2 && byc['ch2'] === 1 && byc['ch3'] === undefined;
    // 逐渠道归零：把 ch1 的水位推到 2022 ⇒ ch1 归零，**ch2 仍 1**（正是 M12 要的"点进去只清它自己"）。
    dbU.prepare("INSERT OR REPLACE INTO wa_settings (key, value) VALUES ('im_read_at:ch1', '2022-01-01 00:00:00')").run();
    const afterByc = computeImUnreadByChannel(dbU as unknown as UnreadDb);
    const perChannelOk = afterByc['ch1'] === undefined && afterByc['ch2'] === 1;
    crit('M12', emptyOk && breakdownOk && perChannelOk,
      `M12-A′ **逐渠道分解真成立（跑真 SQL × 真内存库，两标本）**：全局水位 2020、三渠道各造行 ⇒`
      + ` \`{ch1:2, ch2:1}\`；**出站不计、纯出站渠道无键**；把 ch1 水位推到 2022 ⇒ ch1 归零而 **ch2 仍 1**`
      + `（"清一个渠道不动另一个"——正是红点要的逐渠道语义；此前只有总数，做不到）。`,
      `空 ${emptyOk} · 分解 ${JSON.stringify(byc)} · 清ch1后 ${JSON.stringify(afterByc)}`);

    // M12-B IPC 只读口：与 `im:unread` 同形（取初值），取数走真实现，且**绝不写库**（含不调 markImRead）。
    const bycBody = (ipc.split("ipcMain.handle('im:unreadByChannel'")[1] || '').split('ipcMain.handle(')[0];
    crit('M12', bycBody.includes('computeImUnreadByChannel(_dbForIm)')
      && !/markImRead|refreshImUnread|INSERT|REPLACE|UPDATE/.test(bycBody),
      `M12-B **只读口（不写账、不推显示端）**：\`im:unreadByChannel\` 取数走真实现 \`computeImUnreadByChannel(_dbForIm)\`；`
      + `handler 体内**无** \`markImRead\`/\`refreshImUnread\`、**无任何写语句**（承 \`im:unread\` 只读口径）。`,
      `调真实现 ${bycBody.includes('computeImUnreadByChannel(_dbForIm)')} · 体内无写 ${!/markImRead|refreshImUnread|INSERT|REPLACE|UPDATE/.test(bycBody)}`);

    // M12-C 渲染层 API 面：新增通道 `im:unreadByChannel`（取数口唯一）。
    crit('M12', /unreadByChannel:\s*\(\)\s*=>\s*ipcCall<\{ byChannel: Record<string, number> \}>\('im:unreadByChannel'\)/.test(ripc),
      `M12-C **API 面接上**：\`renderer/src/lib/ipc.ts\` 新增 \`unreadByChannel()\` → \`im:unreadByChannel\`（类型 \`{byChannel}\`）。`,
      `在场 ${ripc.includes("'im:unreadByChannel'")}`);

    // M12-D 接线那一跳 + **显示端不自算**：渠道行红点消费 main 给的数，页面里**不出现**自算的 COUNT/水位读。
    crit('M12', im.includes('im.unreadByChannel()') && im.includes('setUnreadByChannel')
      && /un>0&&/.test(im) && im.includes('bg-red-500') && im.includes('条未读')
      && !/COUNT\(\*\)/.test(im) && !/im_read_at/.test(im),
      `M12-D **接线那一跳（语句形状）+ 显示端不自算**：\`IMPage.tsx\` 真调 \`im.unreadByChannel()\` 写 state，`
      + `渠道行以 \`un>0\` 出红点（\`bg-red-500\`，title 带「条未读」）；页面内**零** \`COUNT(*)\`/\`im_read_at\``
      + `——未读账只 main 算，界面只显示（承 \`feedback_equivalence_needs_wiring_criterion\`）。`,
      `调取数 ${im.includes('im.unreadByChannel()')} · 出红点 ${/un>0&&/.test(im) && im.includes('bg-red-500')} · 页面无自算 ${!/COUNT\(\*\)/.test(im) && !/im_read_at/.test(im)}`);

    // M12-E 产物（词表第二落点）：搜**中文串**（标识符被 minify）。
    const assetsDir12 = path.join(root, A, 'renderer/dist/assets');
    const js12 = fs.existsSync(assetsDir12)
      ? fs.readdirSync(assetsDir12).filter((f) => f.endsWith('.js'))
        .map((f) => fs.readFileSync(path.join(assetsDir12, f), 'utf-8')).join('\n')
      : '';
    crit('M12', js12.includes('条未读'),
      `M12-E **上屏到产物**：renderer 构建产物内真含「条未读」（红点 title；搜中文串，"只写源码没打进 GUI"必红）`,
      `条未读 ${js12.includes('条未读')}`);
  }

  // ── §M13 入站视频播放器 + 手发件走媒体气泡（真源增 video 形态 → IPC 分派 → 控件 → 接线）─
  {
    const mv = strip(IM_MEDIA_VIEW_SRC);
    const ipc = strip(IM_IPC_SRC);
    const ripc = strip(R_IPC_SRC);
    const bubble = strip(IM_BUBBLE_SRC);
    const im = strip(IM_PAGE_SRC);

    // M13-A 新增 `video` 形态**一处真源**：渲染档扩一档、`renderOf` 增视频支、可内联判定同形三条边界。
    crit('M13', /ImMediaRender\s*=\s*'image'\s*\|\s*'audio'\s*\|\s*'video'\s*\|\s*'file'/.test(mv)
      && /family === 'video' && VIDEO_PREVIEW_MIME\[ext\]/.test(mv)
      && countOcc(mv, 'export function resolveVideoPreview') === 1
      && /VIDEO_PREVIEW_MAX_BYTES: number = FAMILY_MAX_BYTES\.video/.test(mv),
      `M13-A **视频形态一处真源**：\`im-media-view.ts\` 的 \`ImMediaRender\` 扩 \`'video'\`；`
      + `\`renderOf\` 增视频支（族是视频**且** MIME 认得才给播放器，否则退 \`file\`）；`
      + `新增 \`resolveVideoPreview\`（恰一处，与音频同形三条边界）；内联上限**取族上限** \`FAMILY_MAX_BYTES.video\`（不另写数字）。`,
      `渲染档 ${/ImMediaRender\s*=\s*'image'\s*\|\s*'audio'\s*\|\s*'video'\s*\|\s*'file'/.test(mv)} · 视频支 ${/family === 'video' && VIDEO_PREVIEW_MIME\[ext\]/.test(mv)} · 上限=族上限 ${/VIDEO_PREVIEW_MAX_BYTES: number = FAMILY_MAX_BYTES\.video/.test(mv)}`);

    // M13-A′ 两标本（+反证）跑**真实现**：入站 `.mp4` 判 `video`；可内联判定三条边界各一只。
    type VidIo = Parameters<typeof resolveVideoPreview>[2];
    const tmp13 = fs.mkdtempSync(path.join(os.tmpdir(), 'rr1003-vid-'));
    try {
      const mp4 = path.join(tmp13, 'a.mp4');
      fs.writeFileSync(mp4, Buffer.alloc(64, 7));
      const realIo: VidIo = { statSync: (p: string) => fs.statSync(p), readFileSync: (p: string) => fs.readFileSync(p) };
      const okRes = resolveVideoPreview(mp4, 'a.mp4', realIo);
      const okSpecimen = okRes.ok && okRes.mime === 'video/mp4';
      // 反证一：超限 —— 只 stat 不 read（readFileSync 记调用 ⇒ "没读盘"可证伪）。
      let reads = 0;
      const bigIo: VidIo = { statSync: () => ({ isFile: () => true, size: VIDEO_PREVIEW_MAX_BYTES + 1 }), readFileSync: () => { reads++; return { toString: () => '' }; } };
      const bigRes = resolveVideoPreview(mp4, 'a.mp4', bigIo);
      const overSpecimen = !bigRes.ok && bigRes.reason === 'oversize' && bigRes.limit === FAMILY_MAX_BYTES.video && reads === 0;
      // 反证二：不在表内 ⇒ unsupported（不猜）；反证三：盘上没有 ⇒ missing。
      const unkRes = resolveVideoPreview(path.join(tmp13, 'a.txt'), 'a.txt', realIo);
      const missRes = resolveVideoPreview(path.join(tmp13, 'none.mp4'), 'none.mp4', realIo);
      const boundOk = (unkRes.ok ? '' : unkRes.reason) === 'unsupported' && (missRes.ok ? '' : missRes.reason) === 'missing';
      // 形状判定：入站扁平视频 ⇒ render 'video'；出站嵌套视频同理（两形状都读）。
      const inboundVid = imMediaOf(JSON.stringify({ kind: 'video', file_name: '片.mkv', saved_path: '/x/attachments/20261003/片.mkv' }))?.render;
      const outboundVid = imMediaOf(JSON.stringify({ text: '📎 片.mp4', media: { kind: 'video', name: '片.mp4', path: '/x/片.mp4' } }))?.render;
      crit('M13', !!okSpecimen && overSpecimen && boundOk && inboundVid === 'video' && outboundVid === 'video'
        && VIDEO_PREVIEW_MAX_BYTES === FAMILY_MAX_BYTES.video,
        `M13-A′ **判形状 + 可内联判定跑真实现（两标本 + 三反证）**：入站扁平 \`.mp4\` ⇒ \`video\`、出站嵌套 \`.mp4\` ⇒ \`video\`；`
        + `已存在 \`.mp4\` ⇒ 可内联且 MIME \`video/mp4\`；超上限 ⇒ \`oversize\`（**只 stat 不 read**，read 计数 0）；`
        + `不在表内 ⇒ \`unsupported\`、盘上没有 ⇒ \`missing\`——三种失败各说各话，不笼统"放不了"。`,
        `ok ${okSpecimen} · over ${overSpecimen}(reads=${reads}) · bound ${boundOk} · in ${inboundVid} out ${outboundVid}`);

      // M13-A″ 播放提示：浏览器稳认的容器不啰嗦、多不能直接播的（mkv/avi）**必须说**。
      crit('M13', videoPlayNote('.mp4') === '' && videoPlayNote('.webm') === ''
        && videoPlayNote('.mkv').length > 0 && videoPlayNote('.avi').length > 0
        && Object.keys(VIDEO_PREVIEW_MIME).length >= 5,
        `M13-A″ **解不了必须说**：\`.mp4\`/\`.webm\` 能直接播 ⇒ 不啰嗦；\`.mkv\`/\`.avi\` 多不能播 ⇒ 出提示（指向「另存」）`
        + `——一个按下去没反应的播放器会被读成"视频坏了"。`,
        `mp4=${videoPlayNote('.mp4').length} mkv=${videoPlayNote('.mkv').length} 表项=${Object.keys(VIDEO_PREVIEW_MIME).length}`);
    } finally { fs.rmSync(tmp13, { recursive: true, force: true }); }

    // M13-B IPC 分派：`im:mediaRead` 在音频之后试视频，同走围栏 + 复用真尺；`oversize` 当场回报。
    const readBody = (ipc.split("ipcMain.handle('im:mediaRead'")[1] || '').split('ipcMain.handle(')[0];
    crit('M13', readBody.includes('resolveVideoPreview(gate.path, name, fs)')
      && readBody.includes("kind: 'video'")
      && /if \(vid\.reason === 'oversize'\) return reject\('oversize'/.test(readBody),
      `M13-B **IPC 分派（接线那一跳）**：\`im:mediaRead\` 依次试图/音/视频，视频那跳调真实现 `
      + `\`resolveVideoPreview(gate.path, name, fs)\` 并以 \`kind: 'video'\` 回报；\`oversize\` 与图/音同尺当场回报`
      + `（越界仍在同一道 \`resolveAttachmentRead\` 围栏之后 ⇒ 不新开路径规则）。`,
      `调真实现 ${readBody.includes('resolveVideoPreview(gate.path, name, fs)')} · kind video ${readBody.includes("kind: 'video'")}`);

    // M13-C 渲染层 API 面：`mediaRead` 的 kind 联合扩 `'video'`（否则取自处类型不符、控件拿不到 video 支）。
    crit('M13', /kind: 'image' \| 'audio' \| 'video'/.test(ripc),
      `M13-C **API 面接上**：\`renderer/src/lib/ipc.ts\` 的 \`mediaRead\` 返回 kind 联合扩 \`'video'\`。`,
      `联合在场 ${/kind: 'image' \| 'audio' \| 'video'/.test(ripc)}`);

    // M13-D 控件那一跳 + 手发件接线：控件真渲染 `<video>`（含解不了提示）；乐观气泡件走**同一个** ImMediaBubble。
    crit('M13', /media\.render === 'video'/.test(bubble) && /<video/.test(bubble) && /videoPlayNote\(media\.ext\)/.test(bubble)
      && /media\.render === 'image' \|\| media\.render === 'audio' \|\| media\.render === 'video'/.test(bubble)
      && im.includes('o.media') && im.includes('imMediaOf(JSON.stringify({ media:')
      && im.includes('text: `📎 ${name}`'),
      `M13-D **接线那一跳（语句形状）**：\`ImMediaBubble\` 真出 \`<video controls>\` 且解不了时出 \`videoPlayNote\` 提示；`
      + `\`IMPage.tsx\` 手发件**乐观气泡**经 \`imMediaOf\` 判出件后渲染 \`ImMediaBubble\`（与真行到场同控件）；`
      + `\`📎 件名\` 正文串**仍在**（退场判据同一串，不得分叉）。`,
      `控件 video 支 ${/media\.render === 'video'/.test(bubble)} · 乐观走件 ${im.includes('o.media')} · 📎名在 ${im.includes('text: `📎 ${name}`')}`);

    // M13-E 产物（词表第二落点）：搜**在渲染产物里唯一**的视频 MIME（`x-matroska` 仅本表有）。
    const assetsDir13 = path.join(root, A, 'renderer/dist/assets');
    const js13 = fs.existsSync(assetsDir13)
      ? fs.readdirSync(assetsDir13).filter((f) => f.endsWith('.js'))
        .map((f) => fs.readFileSync(path.join(assetsDir13, f), 'utf-8')).join('\n')
      : '';
    crit('M13', js13.includes('video/mp4') && js13.includes('x-matroska'),
      `M13-E **上屏到产物**：renderer 构建产物内含视频 MIME 表（\`video/mp4\`/\`x-matroska\`）——`
      + `证明视频形态真打进 GUI（"只写源码没打进"必红）。`,
      `video/mp4 ${js13.includes('video/mp4')} · x-matroska ${js13.includes('x-matroska')}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S】build 钉（派生核对，不写轮次字面量；**不受批次门管辖**）');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().catch((e: unknown) => {
  console.error('\n💥 rr_zx_20261003 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261003: ${pass} 通过 / ${fail} 失败${pending ? ` / ${pending} 待实施(不计入)` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
});
