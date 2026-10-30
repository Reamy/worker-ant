/**
 * zx_20261018_2 受控复跑 —— 「见」（批一「见物」：`view_image` 的视觉子调用）。
 *
 * 病根：AI SDK v4 的图片型 tool result 在 OpenAI 兼容 chat/completions 上会退化成一段 base64 文本
 *   （`rr_zx_20260921` M5-4 已实测），于是 `view_image` 此前只能回元数据 + 一句"请用户重发"。
 * 治法：**换一条真到得了像素的路**——向 ANS 要一个 `vision` 模型，把降质后的图作为
 *   **user message 的 image part** 发过去，再把**文字观察**交回主模型；观察必须自称"二手"。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────
 *   G-1 用生产函数：静态导入生产导出（被删/改名即编译期失败）；能跑真实现的一律跑真实现。
 *   G-2 两侧标本：凡"该拒"的判据必有"该放"的正标本。
 *   G-5 判"接线在册"读 `CODE()`（去注释）后的代码；注释不能替实现签字。
 *   G-6 无轮次字面量：S2/S3 由 `path.basename(__filename)` 派生。
 *   ⚠ 计数器断言有 **0→1** 正面标本（generate / describe 调用次数）。
 */
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import {
  VISION_DEFAULT_MAX_TOKENS,
  VISION_DEMAND,
  VISION_IMAGE_MAX_BYTES,
  VISION_PROMPT,
  buildVisionModelRequest,
  makeImageDescriber,
  type ImageDescribeDeps,
} from '../apps/worker-ant-desktop/src/main/core/image-describe.js';
import { FAMILY_MAX_BYTES } from '../apps/worker-ant-desktop/src/main/core/attachment-kinds.js';
import { PRO_FEATURES, PRO_FEATURE_LABEL, proFeatureRefusal, proUnlocked } from '../apps/worker-ant-desktop/src/main/core/pro-gate.js';
// zx_20261018_2 批五「见清」：档位能力对照一处真源 + 卖点兑现登记。
import { TEAM_FEATURES, teamFeatureRefusal, teamUnlocked } from '../apps/worker-ant-desktop/src/main/core/team-gate.js';
import { LICENSE_TIERS, TIER_LABEL, TIER_LIMITS } from '../apps/worker-ant-desktop/src/main/core/feature-limits.js';
import { PRICING, EARLY_BIRD, PURCHASE_URL, capabilityLine } from '../apps/worker-ant-desktop/src/main/core/pricing.js';
import { BENEFIT_COVERAGE, benefitCoverageProblems, tierCatalog } from '../apps/worker-ant-desktop/src/main/core/tier-catalog.js';
import { describeModelSelectionFailure } from '../apps/worker-ant-desktop/src/main/core/model-request.js';
import { mediaTools } from '../apps/worker-ant-desktop/src/main/core/tools/media.js';
import type { ToolDeps } from '../apps/worker-ant-desktop/src/main/core/tools/deps.js';
import { LICENSE_SETTING_KEYS, TRIAL_DAYS } from '../apps/worker-ant-desktop/src/main/core/license.js';
// zx_20261018_2 批二「见全」：时长探针一处实现 + 8 帧摊到全片。
import { parseFfmpegDuration, probeMediaDurationSec } from '../apps/worker-ant-desktop/src/main/core/media-probe.js';
import {
  VIDEO_FRAME_COUNT,
  VIDEO_FRAME_INTERVAL_SEC,
  VIDEO_FRAMES_WINDOW_SEC,
  extractVideoFrames,
  makeFrameExtractor,
  type FramesIo,
  type VideoFramesResult,
} from '../apps/worker-ant-desktop/src/main/core/video-frames.js';
import { buildAttachmentParts } from '../apps/worker-ant-desktop/src/main/core/attachment-inline.js';
// zx_20261018_2 批三「见省」：块序一处真源 + 稳定前缀指纹。
import {
  CONTEXT_BLOCK_ORDER, STABLE_PREFIX_BLOCKS, buildTaskContext,
} from '../apps/worker-ant-desktop/src/main/core/exec-context.js';
import { fingerprintMessages } from '../apps/worker-ant-desktop/src/main/core/context-prefix.js';
// zx_20261018_2 批四「见域」：项目知识册九节（domain/usage 为新增）+ 导出编排。
import {
  KNOWLEDGE_INJECT_MAX_TOKENS,
  PROJECT_KNOWLEDGE_SECTIONS,
  PROJECT_KNOWLEDGE_SECTION_LABEL,
  deriveProjectKnowledge,
  listProjectKnowledge,
  orderKnowledgeSections,
  previewProjectKnowledge,
  selectKnowledgeForInject,
  upsertProjectKnowledge,
} from '../apps/worker-ant-desktop/src/main/core/project-knowledge.js';
import { writeKnowledgeExport } from '../apps/worker-ant-desktop/src/main/core/knowledge-export.js';
// zx_20261018_2 批六「见新」：GUI 事件驱动刷新（瞬态事件 + 门内调用观察面）。
import { eventBus } from '../apps/worker-ant-desktop/src/main/core/event-bus.js';
import {
  emitDeliverableRuntimeChanged,
  emitExternalCallRecorded,
  emitExternalStatusChanged,
} from '../apps/worker-ant-desktop/src/main/core/refresh-events.js';
import { createExternalCapabilityPort } from '../apps/worker-ant-desktop/src/main/core/external-calls.js';
import type { AgentContext } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import type { AdaptiveStrategy, ComplexityLevel, TaskArchetype } from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

/** 本轮标识由**载体自身**派生（G-6）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');

/** 设置库夹具（生产同形：`license.ts` 只读 `wa_settings` 的 key/value 两列）。 */
function makeSettingsDb(trial: boolean): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))`);
  if (trial) {
    d.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)')
      .run(LICENSE_SETTING_KEYS.trialStartedAt, new Date().toISOString());
  }
  return d;
}

/** 视觉子调用的**记录型桩**：选型/读盘/降质/生成四跳都可数、可读。 */
function makeDescriberHarness(over: Partial<ImageDescribeDeps> = {}) {
  const seen = {
    select: 0,
    read: 0,
    downscale: 0,
    generate: 0,
    lastReq: null as Record<string, unknown> | null,
    lastMaxBytes: -1,
    lastImage: null as { data: Buffer; mimeType: string } | null,
    lastPrompt: '',
  };
  const describer = makeImageDescriber({
    selectModel: async (req) => {
      seen.select += 1; seen.lastReq = req;
      return { url: 'https://vision.test/v1', api_key: 'k', model_name: 'vis-1', capabilities: ['chat', 'vision'] };
    },
    readFile: async () => { seen.read += 1; return Buffer.from('fake-png-bytes'); },
    downscaleImage: async (_p, max) => {
      seen.downscale += 1; seen.lastMaxBytes = max;
      return { data: Buffer.from('jpeg-data'), mimeType: 'image/jpeg' };
    },
    generate: async (_ep, image, prompt) => {
      seen.generate += 1; seen.lastImage = image; seen.lastPrompt = prompt;
      return { ok: true, text: '一只猫趴在窗台上。' };
    },
    ...over,
  });
  return { seen, describe: describer };
}

/**
 * 上下文装配夹具（批三）：只建 `buildTaskContext` **会真读**的表，形状照生产（少一列就可能让读语句
 * 抛错被 `catch` 吞成空块——但本组判据只落在稳定前缀与块序上，不受空块的定向影响）。
 */
function makeContextDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT DEFAULT '', working_dir TEXT DEFAULT '',
      context_json TEXT DEFAULT '{}', sandbox_mode TEXT DEFAULT 'workspace', autonomous_mode TEXT DEFAULT 'off');
    CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT DEFAULT '', status TEXT DEFAULT 'pending',
      source TEXT DEFAULT 'user', context_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, type TEXT DEFAULT '', name TEXT DEFAULT '',
      status TEXT DEFAULT 'draft', file_path TEXT);
    CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, content TEXT DEFAULT '',
      memory_type TEXT DEFAULT 'episodic', created_at TEXT DEFAULT (datetime('now')));
  `);
  d.prepare("INSERT INTO wa_projects (id, name, context_json) VALUES ('p1', '项目甲', '{}')").run();
  return d;
}

/**
 * 知识册夹具（批四）：九节各自真读的表按**生产同形**建齐（列名/默认值照 `database.ts`）。
 * ⚠ 缺表会让派生 SQL 直接抛 "no such table"——夹具比生产宽松就是假绿。
 * ⚠ `node:sqlite` 无 `transaction()`，而 `upsertProjectKnowledge` 是真实现 ⇒ 补垫片。
 */
function makeKnowledgeDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT DEFAULT '', context_json TEXT DEFAULT '{}');
    CREATE TABLE wa_knowledge_triples (
      id TEXT PRIMARY KEY, project_id TEXT, subject TEXT NOT NULL, predicate TEXT NOT NULL,
      object TEXT NOT NULL, confidence REAL DEFAULT 0.5, source TEXT DEFAULT 'x',
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_deliverables (
      id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT, status TEXT, name TEXT, file_path TEXT);
    CREATE TABLE wa_service_calls (
      id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, kind TEXT, target TEXT, operation TEXT,
      ok INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0, error TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_tasks (
      id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, status TEXT DEFAULT 'pending',
      context_json TEXT DEFAULT '{}', acceptance_criteria TEXT DEFAULT '');
    CREATE TABLE wa_task_templates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT DEFAULT 'custom',
      description TEXT DEFAULT '', status TEXT DEFAULT 'active', priority INTEGER DEFAULT 0);
    CREATE TABLE wa_memories (
      id TEXT PRIMARY KEY, project_id TEXT, content TEXT NOT NULL,
      memory_type TEXT DEFAULT 'episodic', is_exemplar INTEGER DEFAULT 0);
    CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, status TEXT, payload TEXT);
    CREATE TABLE wa_device_actions (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL, action TEXT NOT NULL,
      args_json TEXT DEFAULT '{}', result TEXT DEFAULT '', task_id TEXT DEFAULT '',
      actor_kind TEXT DEFAULT '', actor_ref TEXT DEFAULT '', plan_id TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_project_knowledge (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, section TEXT NOT NULL,
      content TEXT NOT NULL, source_ref TEXT DEFAULT '', updated_at TEXT DEFAULT (datetime('now')));
    CREATE UNIQUE INDEX idx_wa_project_knowledge_sec ON wa_project_knowledge(project_id, section);
    -- zx_20261022_3 批七: 读册 = 派生 ∪ 导入（生产同一句），夹具须同建。
    CREATE TABLE wa_project_knowledge_imports (
      project_id TEXT NOT NULL, section TEXT NOT NULL, content TEXT NOT NULL,
      precedence INTEGER NOT NULL DEFAULT 0, source_hash TEXT NOT NULL DEFAULT '',
      imported_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (project_id, section));
    CREATE TABLE wa_knowledge_imports (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_project_id TEXT DEFAULT '',
      source_hash TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'merge',
      sections INTEGER NOT NULL DEFAULT 0, imported INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0, conflicts INTEGER NOT NULL DEFAULT 0,
      imported_at TEXT DEFAULT (datetime('now')));
  `);
  (d as unknown as { transaction: (fn: () => void) => () => void }).transaction = (fn) => () => fn();
  return d;
}

/**
 * 批四「已发生的事实」标本：术语/约定 + 三条三元组 + 四次服务调用 + 外派任务 + 两次设备动作 + 两件交付物。
 * ⚠ 服务调用的 `kind` 必须落在生产词表（mcp/a2a/daemon）内——`describeServiceCalls` 按该词表聚合，
 *   词表外的行会被静默排除（夹具写个自造 kind 会让"合计 4"变成 0 的假绿/假红）。
 * ⚠ 另有一件**他项目**的设备动作（p2/b1）：`usage` 的设备计数按项目归属，它不得混进来。
 */
function seedKnowledgeDb(d: DatabaseSync): void {
  d.prepare("INSERT INTO wa_projects (id, name, context_json) VALUES ('p1', '项目甲', ?)").run(JSON.stringify({
    language_game: {
      terminology: { 工蚁: 'worker ant', 知识册: 'knowledge book', 空术语: '   ' },
      conventions: ['先跑 rr 再提交', '注释里不许写轮次字面量'],
    },
  }));
  d.prepare("INSERT INTO wa_projects (id, name, context_json) VALUES ('p2', '项目乙', '{}')").run();

  const triple = d.prepare(
    "INSERT INTO wa_knowledge_triples (id, project_id, subject, predicate, object, confidence) VALUES (?, 'p1', ?, ?, ?, ?)",
  );
  triple.run('tr1', 'worker-ant', '使用', 'mqtt 台灯', 0.9);
  triple.run('tr2', 'worker-ant', '依赖', 'better-sqlite3', 0.8);
  triple.run('tr3', 'mqtt 台灯', '位于', '客厅', 0.7);

  const call = d.prepare(
    "INSERT INTO wa_service_calls (id, project_id, kind, target, operation, ok, duration_ms, error) VALUES (?, 'p1', ?, ?, ?, ?, 10, ?)",
  );
  call.run('sc1', 'mcp', 'fs', 'read', 1, '');
  call.run('sc2', 'mcp', 'fs', 'read', 0, 'boom');
  call.run('sc3', 'a2a', 'svc', 'send', 1, '');
  call.run('sc4', 'a2a', 'svc', 'send', 1, '');

  d.prepare("INSERT INTO wa_tasks (id, project_id, title, context_json) VALUES ('a1', 'p1', '任务一', ?)")
    .run(JSON.stringify({ assigned_request_id: 'r1', assigned_node_id: 'n1', assigned_at: '2026-10-18T00:00:00Z' }));
  d.prepare("INSERT INTO wa_tasks (id, project_id, title, context_json) VALUES ('a2', 'p1', '任务二', '{}')").run();
  d.prepare("INSERT INTO wa_tasks (id, project_id, title, context_json) VALUES ('b1', 'p2', '他项目任务', '{}')").run();

  const dev = d.prepare(
    'INSERT INTO wa_device_actions (id, device_id, action, result, task_id) VALUES (?, ?, ?, ?, ?)',
  );
  dev.run('da1', 'light-1', 'turn_on', 'ok', 'a1');
  dev.run('da2', 'light-1', 'turn_on', 'denied', 'a1');
  dev.run('da3', 'light-9', 'turn_on', 'ok', 'b1');
  // 无任务的外部件（面板/外部终端发起）不归任何项目——如实不计。
  dev.run('da4', 'light-2', 'turn_off', 'ok', '');

  d.prepare("INSERT INTO wa_deliverables (id, project_id, type, status, name) VALUES ('d1', 'p1', 'report', 'accepted', '报告.md')").run();
  d.prepare("INSERT INTO wa_deliverables (id, project_id, type, status, name) VALUES ('d2', 'p1', 'code', 'draft', 'main.ts')").run();
}

/** 真 `buildTaskContext` 的一组默认入参；每次调用只换需要对照的那一两项。 */
async function assembleContext(
  db: DatabaseSync, workingDir: string, over: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<typeof buildTaskContext>>> {
  return buildTaskContext({
    ctx: { dataDir: workingDir } as unknown as AgentContext,
    db: db as never,
    taskId: 't1', projectId: 'p1',
    project: { sandbox_mode: 'off' },
    workingDir,
    title: '任务甲', description: '描述甲',
    archetype: 'document' as TaskArchetype,
    adaptiveStrategy: { label: '文档', priorityTools: [] } as unknown as AdaptiveStrategy,
    complexityLevel: 'simple' as ComplexityLevel,
    userPrefs: '偏好：中文回答',
    memoryContext: '', successContext: '', subagentSystemPrompt: undefined,
    projCtxJson: {},
    maxTokens: 100_000, maxCost: 0, costSrc: 'none', costGateActive: false,
    historySummary: '', recentConversations: [],
    ...over,
  });
}

async function main(): Promise<void> {
  // ═══ V-1｜选型请求：真的把 `vision` 要到（要不到就选不出能看图的模型）══════════════
  console.log('\n【V-1】视觉子调用的选型请求');
  {
    const req = buildVisionModelRequest();
    const caps = Array.isArray(req.capabilities) ? (req.capabilities as string[]) : [];
    ok(caps.includes('vision'), 'V-1a ★请求能力含 `vision`（由 `buildModelRequest` 的 `hasMedia` 派生）', caps.join(','));
    ok(caps.includes('chat') && caps.includes('function-calling'), 'V-1b 底线能力仍在（chat / function-calling）', caps.join(','));
    eq(req.strategy, 'cost-optimal', 'V-1c 策略＝cost-optimal（辅助路同档）');
    ok(!('maxCostPer1k' in req), 'V-1d 未配成本上限时该键**不出现**（"没这笔账"≠"账上是 0"）');
    eq([...VISION_DEMAND], ['vision'], 'V-1e 回验需求恰 `vision` 一项');
  }

  // ═══ V-2｜快乐路：像素真交给视觉模型，观察文本原样带回（0→1）════════════════════
  console.log('\n【V-2】快乐路：四跳各一次，字节与提示词一致');
  {
    const { seen, describe } = makeDescriberHarness();
    const r = await describe('/tmp/shot.png');
    ok(r.ok, 'V-2a ★快乐路成功', r.ok ? '' : `${r.reason}: ${r.detail}`);
    eq(seen.select, 1, 'V-2b 选型 0→1');
    eq(seen.read, 1, 'V-2c 读盘 0→1');
    eq(seen.downscale, 1, 'V-2d 降质 0→1');
    eq(seen.generate, 1, 'V-2e ★视觉调用 0→1');
    eq(seen.lastMaxBytes, VISION_IMAGE_MAX_BYTES, 'V-2f 降质上限＝`VISION_IMAGE_MAX_BYTES`（不另写一个数）');
    ok(seen.lastImage !== null && seen.lastImage.data.toString() === 'jpeg-data',
      'V-2g ★交给生成的是**降质后**的字节（不是盘上原件）');
    eq(seen.lastPrompt, VISION_PROMPT, 'V-2h 提示词用的是本模块的 `VISION_PROMPT`');
    ok(VISION_PROMPT.includes('看不清就说看不清') && VISION_PROMPT.includes('不要'),
      'V-2i 提示词要求标注不确定、禁止发挥（视觉模型最常见的失实是"把看不清说成确定"）');
    if (r.ok) {
      eq(r.text, '一只猫趴在窗台上。', 'V-2j 观察文本原样带回（trim 后）');
      eq(r.model, 'vis-1', 'V-2k 带出实际模型名（用户可追）');
      eq(r.mimeType, 'image/jpeg', 'V-2l 带出发给视觉模型的 MIME');
    }
    ok(VISION_DEFAULT_MAX_TOKENS > 0, 'V-2m 缺省输出上限为正数', String(VISION_DEFAULT_MAX_TOKENS));
  }

  // ═══ V-3｜选型失败：先认失败形状，再说字段齐不齐（六种成因分开说）════════════════
  console.log('\n【V-3】选型 / 读盘 / 降质 / 生成的失败各有各的话');
  {
    // ① ANS 零命中（`{error:{…}}`，HTTP 200）⇒ selection_failed，且成因原样带出；生成零调用。
    const h1 = makeDescriberHarness({
      selectModel: async () => ({
        error: { code: 'NOT_FOUND', message: '没有找到匹配的模型', diagnostics: { summary: '能力闸归零：4 → 0' } },
      }),
    });
    const r1 = await h1.describe('/tmp/a.png');
    ok(!r1.ok && r1.reason === 'selection_failed' && r1.detail.includes('能力闸归零'),
      'V-3a ★ANS 零命中 ⇒ `selection_failed` 且带 ANS 自己说的成因', !r1.ok ? r1.detail : 'ok');
    eq(h1.seen.generate, 0, 'V-3b ★反证：选型失败时视觉调用 0 次（不瞎发）');

    // ② 选型口自己抛 ⇒ 同样 selection_failed（不把异常升级成任务崩溃）。
    const h2 = makeDescriberHarness({ selectModel: async () => { throw new Error('ans down'); } });
    const r2 = await h2.describe('/tmp/a.png');
    ok(!r2.ok && r2.reason === 'selection_failed' && r2.detail.includes('ans down'),
      'V-3c 选型口抛异常 ⇒ `selection_failed` 且带原文（不抛给调用方）', !r2.ok ? r2.detail : 'ok');

    // ③ 回包无 error 键但缺字段 ⇒ 形状不认识，仍归 no_vision_model（与音频路同一把尺）。
    const h3 = makeDescriberHarness({ selectModel: async () => ({ url: 'https://x.test' }) });
    const r3 = await h3.describe('/tmp/a.png');
    ok(!r3.ok && r3.reason === 'no_vision_model' && r3.detail.includes('形状不认识'),
      'V-3d 回包字段不齐 ⇒ 如实说"形状不认识"', !r3.ok ? r3.detail : 'ok');

    // ④ 读盘失败。
    const h4 = makeDescriberHarness({ readFile: async () => { throw new Error('EACCES'); } });
    const r4 = await h4.describe('/tmp/a.png');
    ok(!r4.ok && r4.reason === 'read_failed' && r4.detail.includes('EACCES'),
      'V-3e 读盘失败 ⇒ `read_failed`（不是"看不了"一句了事）', !r4.ok ? r4.detail : 'ok');

    // ⑤ 降不动质（nativeImage 不可用/格式不支持）⇒ downscale_failed；生成零调用。
    const h5 = makeDescriberHarness({ downscaleImage: async () => null });
    const r5 = await h5.describe('/tmp/a.png');
    ok(!r5.ok && r5.reason === 'downscale_failed' && r5.detail.includes(String(VISION_IMAGE_MAX_BYTES)),
      'V-3f 降不动质 ⇒ `downscale_failed` 且带上限', !r5.ok ? r5.detail : 'ok');
    eq(h5.seen.generate, 0, 'V-3g 反证：降质失败时视觉调用 0 次');

    // ⑥ 生成失败 / 空文本。
    const h6 = makeDescriberHarness({ generate: async () => ({ ok: false, detail: 'HTTP 400' }) });
    const r6 = await h6.describe('/tmp/a.png');
    ok(!r6.ok && r6.reason === 'generation_failed' && r6.detail.includes('HTTP 400'),
      'V-3h 生成失败 ⇒ `generation_failed`', !r6.ok ? r6.detail : 'ok');
    const h7 = makeDescriberHarness({ generate: async () => ({ ok: true, text: '   ' }) });
    const r7 = await h7.describe('/tmp/a.png');
    ok(!r7.ok && r7.reason === 'empty', 'V-3i 空回答 ⇒ `empty`（不把空串当观察）', !r7.ok ? r7.detail : 'ok');
  }

  // ═══ V-4｜能力回验：清单在场且缺 vision ⇒ 不硬发；清单缺席 ⇒ 不替它下结论 ══════════
  console.log('\n【V-4】vision 能力回验的两面');
  {
    const h1 = makeDescriberHarness({
      selectModel: async () => ({ url: 'https://v.test', api_key: 'k', model_name: 'no-vis', capabilities: ['chat'] }),
    });
    const r1 = await h1.describe('/tmp/a.png');
    ok(!r1.ok && r1.reason === 'no_vision_model' && r1.detail.includes('chat'),
      'V-4a ★清单在场且缺 vision ⇒ `no_vision_model`（逐项点名实得/缺）', !r1.ok ? r1.detail : 'ok');
    eq(h1.seen.generate, 0, 'V-4b ★反证：无 vision 时视觉调用 0 次（不拿 400 撞运气）');

    const h2 = makeDescriberHarness({
      selectModel: async () => ({ url: 'https://v.test', api_key: 'k', model_name: 'legacy' }),
    });
    const r2 = await h2.describe('/tmp/a.png');
    ok(r2.ok && h2.seen.generate === 1,
      'V-4c 清单缺席 ⇒ **不设闸**（那是"无从比对"，不是"不具备"）', r2.ok ? '' : `${r2.reason}: ${r2.detail}`);
  }

  // ═══ V-5｜盘上超限：连读都不读（有界预判）══════════════════════════════════════
  console.log('\n【V-5】盘上已知超过图片族上限 ⇒ 不进入读盘/降质');
  {
    const { seen, describe } = makeDescriberHarness({
      statSize: () => FAMILY_MAX_BYTES.image + 1,
    });
    const r = await describe('/tmp/huge.png');
    ok(!r.ok && r.reason === 'too_large' && r.detail.includes(String(FAMILY_MAX_BYTES.image)),
      'V-5a ★超限如实拒且带两个数（实际 vs 上限）', !r.ok ? r.detail : 'ok');
    eq(seen.read, 0, 'V-5b ★★反证：读盘 0 次（不再先吃满再判）');
    eq(seen.downscale, 0, 'V-5c 降质 0 次');
  }

  // ═══ V-6｜`view_image` 端到端：档位闸 + 二手标记 + 不把 base64 灌回主模型 ═════════
  console.log('\n【V-6】`view_image` 的档位闸与二手观察');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-vision-'));
    const png = path.join(tmp, 'shot.png');
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
    const parse = (s: string): Record<string, unknown> => JSON.parse(s) as Record<string, unknown>;

    // ① 社区档：只给元数据 + 如实拒因；describer **零调用**。
    let calls = 0;
    const community = makeSettingsDb(false);
    const toolsC = mediaTools({
      workingDir: tmp,
      db: community,
      describeImage: async () => { calls += 1; return { ok: true, text: '不该被调到', model: 'x', bytes: 1, mimeType: 'image/jpeg' }; },
    } as unknown as ToolDeps);
    const outC = parse(await toolsC.view_image.execute({ filePath: 'shot.png' }));
    eq(calls, 0, 'V-6a ★★社区档：视觉子调用 0 次（0→0 反证）');
    eq(outC.described, false, 'V-6b 社区档 `described:false`');
    ok(typeof outC.visionNote === 'string' && outC.visionNote.includes('专业版') && outC.visionNote.includes('图片内容理解'),
      'V-6c 拒因含人话名与升级指引', String(outC.visionNote));
    eq(outC.delivered, false, 'V-6d 元数据照给（软闸只锁这一跳，不锁"看到图的存在"）');
    ok(typeof outC.bytes === 'number' && outC.bytes > 0, 'V-6e 元数据里的字节数仍是真的', String(outC.bytes));
    community.close();

    // ② 试用档（视同 Pro）：观察带 `<image-observation>` 标记；像素仍不声称送达；不回灌 base64。
    //    另备 `wa_memories` 表：观察是**当轮上下文**，不是记忆——看完不许落库。
    const trial = makeSettingsDb(true);
    trial.exec(`CREATE TABLE wa_memories (id INTEGER PRIMARY KEY, content TEXT)`);
    const toolsT = mediaTools({
      workingDir: tmp,
      db: trial,
      describeImage: async (p: string) => {
        calls += 1;
        ok(p === png, 'V-6f 视觉子调用拿到的是**解析后**的绝对路径', p);
        return { ok: true, text: '图中是一只猫。', model: 'vis-1', bytes: 7, mimeType: 'image/jpeg' };
      },
    } as unknown as ToolDeps);
    const outT = parse(await toolsT.view_image.execute({ filePath: 'shot.png' }));
    eq(calls, 1, 'V-6g ★★试用档：视觉子调用 0→1');
    eq(outT.described, true, 'V-6h 试用档 `described:true`');
    eq(outT.model, 'vis-1', 'V-6i 带出视觉模型名');
    ok(typeof outT.observation === 'string'
      && outT.observation.startsWith('<image-observation>')
      && outT.observation.includes('图中是一只猫。')
      && outT.observation.includes('</image-observation>'),
      'V-6j ★观察有边界标记（主模型能分辨"这是转述"）', String(outT.observation));
    ok(typeof outT.note === 'string' && outT.note.includes('二手观察'),
      'V-6k ★★免责句在场：这是视觉模型的二手观察，不是原件像素', String(outT.note));
    eq(outT.delivered, false, 'V-6l 主模型仍未收到像素（`delivered:false` 不因走了子调用而改口）');
    const dumped = JSON.stringify(outT);
    ok(!dumped.includes('iVBORw0KGgo') && !dumped.includes('data:image'),
      'V-6m ★工具结果零 base64 / 零 data URL（否则白烧 token 且模型仍看不见）');
    const memRows = trial.prepare('SELECT COUNT(*) AS n FROM wa_memories').get() as { n: number };
    eq(memRows.n, 0, 'V-6s ★观察不落库：`wa_memories` 零行（只回给当轮模型）');

    // ③ 子调用失败：如实带 reason，不把失败说成"看见了"。
    const toolsF = mediaTools({
      workingDir: tmp,
      db: trial,
      describeImage: async () => ({ ok: false, reason: 'no_vision_model', detail: '缺 vision' }),
    } as unknown as ToolDeps);
    const outF = parse(await toolsF.view_image.execute({ filePath: 'shot.png' }));
    eq(outF.described, false, 'V-6n 子调用失败 `described:false`');
    ok(typeof outF.visionNote === 'string' && outF.visionNote.includes('no_vision_model') && outF.visionNote.includes('缺 vision'),
      'V-6o 失败带机器成因与细节', String(outF.visionNote));
    ok(!('observation' in outF), 'V-6p 失败时**没有** observation（不把空/错当观察）');
    ok(outF.delivered === false && typeof outF.note === 'string' && outF.note.includes('未送达'),
      'V-6q 失败时仍如实说"像素未送达"');
    trial.close();

    // ④ 未注入 describer：如实说不可用（老夹具/受控环境下不假装能看）。
    const none = makeSettingsDb(true);
    const toolsN = mediaTools({ workingDir: tmp, db: none } as unknown as ToolDeps);
    const outN = parse(await toolsN.view_image.execute({ filePath: 'shot.png' }));
    ok(outN.described === false && typeof outN.visionNote === 'string' && outN.visionNote.includes('未注入'),
      'V-6r 未注入 describer ⇒ 如实说不可用', String(outN.visionNote));
    none.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ═══ V-7｜接线在册（去注释面）：三处唯一跳 ═════════════════════════════════════
  console.log('\n【V-7】接线：只建文件不接线，全量照样全绿');
  {
    const descSrc = CODE(`${A}/src/main/core/image-describe.ts`);
    ok(/type:\s*'image'/.test(descSrc) && /image:\s*image\.data/.test(descSrc),
      'V-7a ★生成请求里真的把字节作为 image part 发（不是只写文字）');
    ok(/provider\.chat\(endpoint\.model_name\)/.test(descSrc),
      'V-7b ★用 `provider.chat(model_name)`（本仓唯一的 OpenAI 兼容出口）');
    ok(/hasMedia:\s*true/.test(descSrc), 'V-7c 选型请求的 `vision` 由 `hasMedia:true` 派生（不手写能力表）');

    const mediaSrc = CODE(`${A}/src/main/core/tools/media.ts`);
    ok(/proFeatureRefusal\(deps\.db,\s*'image_vision'\)/.test(mediaSrc),
      'V-7d ★`view_image` 真调档位闸（不是装饰性 import）');
    ok(/deps\.describeImage\(fp\)/.test(mediaSrc),
      'V-7e ★工具真的调用注入的 describer');
    ok(!/type:\s*'image'/.test(mediaSrc),
      'V-7f 反证：工具结果**不含** image part（那条路实测送不到像素）');

    const execSrc = CODE(`${A}/src/main/core/agent-executor.ts`);
    ok(/describeImage:\s*makeImageDescriber\(\{/.test(execSrc),
      'V-7g ★执行体注入 describer（生产真有这条跳）');
    ok(/ctx\.getAnsClient\(\)\)\.getOptimalModel\(req\)/.test(execSrc),
      'V-7h 走同一条 ANS 选型路（不另开选型口）');
    const memWriters = [descSrc, mediaSrc].filter((s) => /wa_memories|memory-manager/.test(s));
    eq(memWriters.length, 0,
      'V-7i ★★视觉路径两模块**没有任何**记忆写入面（观察只回给当轮模型）');
  }

  // ═══ V-8｜降质阶梯：一份实现、两处同引 ════════════════════════════════════════
  console.log('\n【V-8】降质阶梯的唯一实现');
  {
    const mainSrc = path.join(root, A, 'src/main');
    const tsFiles = (fs.readdirSync(mainSrc, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.split(path.sep).join('/'));
    const toJpeg = tsFiles.filter((f) => CODE(`${A}/src/main/${f}`).includes('toJPEG('));
    eq(toJpeg, ['core/image-downscale.ts'],
      'V-8a ★★`toJPEG(` 全仓恰一处（阶梯的唯一实现）');
    const inlineSrc = CODE(`${A}/src/main/core/attachment-inline.ts`);
    ok(/from\s+'\.\/image-downscale\.js'/.test(inlineSrc) && !inlineSrc.includes('toJPEG('),
      'V-8b ★附件内联改成**引用**同一份阶梯（不私藏第二份）');
    const descSrc = CODE(`${A}/src/main/core/image-describe.ts`);
    ok(/from\s+'\.\/image-downscale\.js'/.test(descSrc),
      'V-8c 视觉子调用同样引这一份（同一张图两条路压出同一组候选）');
    ok(!/from\s+'electron'/.test(descSrc) && !/from\s+'electron'/.test(CODE(`${A}/src/main/core/image-downscale.ts`)),
      'V-8d 两模块静态零 electron 依赖（`nativeImage` 走动态 import ⇒ rr 可直跑）');
  }

  // ═══ V-9｜Pro 闸：词表登记 + 两只标本 ═════════════════════════════════════════
  console.log('\n【V-9】`image_vision` 的档位闸');
  {
    ok((PRO_FEATURES as readonly string[]).includes('image_vision'),
      'V-9a ★`image_vision` 在 Pro 词表里（唯一定处 `pro-gate.ts`）');
    ok((PRO_FEATURE_LABEL.image_vision ?? '').includes('图片') && (PRO_FEATURE_LABEL.image_vision ?? '').includes('视觉'),
      'V-9b 人话名说清买到的是"视觉子调用"', PRO_FEATURE_LABEL.image_vision);
    const community = makeSettingsDb(false);
    ok(proFeatureRefusal(community as never, 'image_vision') !== null,
      'V-9c ★社区档拒绝（卖点有闸兑现）');
    community.close();
    const trial = makeSettingsDb(true);
    eq(proFeatureRefusal(trial as never, 'image_vision'), null,
      'V-9d ★试用档放行（试用＝专业版能力）');
    trial.close();
    ok(TRIAL_DAYS > 0, 'V-9e 试用天数真源在场', String(TRIAL_DAYS));
  }

  // ═══ V-10｜选型失败措辞迁址：一份实现、两个调用方 ══════════════════════════════
  console.log('\n【V-10】`describeModelSelectionFailure` 迁入零依赖模块');
  {
    const said = describeModelSelectionFailure({ error: { code: 'NOT_FOUND', message: '没有找到匹配的模型' } });
    ok(typeof said === 'string' && said.includes('没有找到匹配的模型'),
      'V-10a ★从 `model-request.ts` 取到的是真实现（不是转出空壳）', String(said));
    ok(!CODE(`${A}/src/main/core/audio-transcribe.ts`).includes('function describeModelSelectionFailure'),
      'V-10b 音频模块已无第二份实现（只 import）');
    ok(/export function describeModelSelectionFailure/.test(CODE(`${A}/src/main/core/model-request.ts`)),
      'V-10c 真源在零依赖模块（视觉路不必拖 `ans-client`）');
  }

  // ═══ W｜批二「见全」：时长探针一处实现 + 8 帧摊到全片 ══════════════════════════════
  console.log('\n【W-1】时长读数（纯解析，不跑进程）');
  {
    eq(parseFfmpegDuration('Duration: 00:10:00.00, start: 0.0'), 600, 'W-1a `00:10:00` ⇒ 600 秒');
    eq(parseFfmpegDuration('Duration: 01:02:03.5'), 3723.5, 'W-1b 小数秒保留（`01:02:03.5` ⇒ 3723.5）');
    eq(parseFfmpegDuration('no duration here'), null, 'W-1c 没有那一行 ⇒ `null`（不猜）');
    eq(parseFfmpegDuration(undefined), null, 'W-1d 空 stderr ⇒ `null`');
  }

  console.log('\n【W-2】探针：真实现 + 桩 io（不依赖本机 ffmpeg）');
  {
    const seen: string[][] = [];
    const io = {
      probe: () => true,
      run: async (_b: string, args: string[]) => {
        seen.push(args);
        return { code: 1, timedOut: false, stderr: 'Duration: 00:10:00.00' };
      },
    } as unknown as Parameters<typeof probeMediaDurationSec>[1];
    eq(await probeMediaDurationSec('/tmp/a.mp4', io), 600, 'W-2a ★从 stderr 读到时长的真实现');
    ok(seen.length === 1 && seen[0].includes('-i') && seen[0].includes('/tmp/a.mp4'),
      'W-2b 发的是 `ffmpeg -i <src>`（与长音频同一手法）', JSON.stringify(seen[0] ?? []));
  }

  console.log('\n【W-3】抽帧间隔与覆盖窗口（探到 / 探不到 / 探崩三种）');
  {
    const harness = (duration: number | null | 'throw' | 'none') => {
      const argv: string[][] = [];
      const io = {
        probe: () => true,
        run: async (_b: string, args: string[]) => { argv.push(args); return { code: 0, timedOut: false }; },
        mkdirp: async () => {},
        size: async () => null,
        remove: async () => {},
        list: async () => [],
        ...(duration === 'none' ? {} : {
          probeDuration: async () => {
            if (duration === 'throw') throw new Error('probe boom');
            return duration;
          },
        }),
      } as unknown as FramesIo;
      return { argv, io };
    };
    const run = async (duration: number | null | 'throw' | 'none', fullCoverage?: boolean) => {
      const h = harness(duration);
      const r = await extractVideoFrames('/tmp/clip.mp4', '/tmp/frames', h.io, { fullCoverage });
      return { r, argv: h.argv[0] ?? [] };
    };

    const a = await run(3600, true);
    ok(a.r.ok === true && a.r.intervalSeconds === 450 && a.r.windowSeconds === 3600
      && a.r.durationKnown === true && a.r.sourceSeconds === 3600,
      'W-3a ★★3600s + 全片覆盖 ⇒ 每 450 秒 1 帧、窗口 3600（不再只盖前 720）',
      a.r.ok ? `${a.r.intervalSeconds}s / ${a.r.windowSeconds}s` : a.r.reason);
    ok(a.argv.includes('fps=1/450'), 'W-3b ★真把 450 喂给 ffmpeg（不是只改返回值）', a.argv.join(' '));
    ok(a.argv.includes('-frames:v') && a.argv.includes(String(VIDEO_FRAME_COUNT)),
      'W-3c 帧数预算不变（仍是 `-frames:v 8`）', a.argv.join(' '));

    const b = await run(400, true);
    ok(b.r.ok === true && b.r.intervalSeconds === 90 && b.r.windowSeconds === 400,
      'W-3d ★短片 400s ⇒ 间隔保底 90、窗口＝源长 400（不虚报 720）',
      b.r.ok ? `${b.r.intervalSeconds}s / ${b.r.windowSeconds}s` : b.r.reason);

    const c = await run(3600, false);
    ok(c.r.ok === true && c.r.intervalSeconds === 90 && c.r.windowSeconds === VIDEO_FRAMES_WINDOW_SEC,
      'W-3e ★社区档 3600s ⇒ 仍 90/720（既有行为不回收）',
      c.r.ok ? `${c.r.intervalSeconds}s / ${c.r.windowSeconds}s` : c.r.reason);

    const d = await run('none', true);
    ok(d.r.ok === true && d.r.intervalSeconds === VIDEO_FRAME_INTERVAL_SEC
      && d.r.windowSeconds === VIDEO_FRAMES_WINDOW_SEC && d.r.durationKnown === false && d.r.sourceSeconds === null,
      'W-3f ★★时长探不到 ⇒ 保持 90/720 且 `durationKnown:false`（不拿"全片"冒充）',
      d.r.ok ? `${d.r.intervalSeconds}s / ${d.r.windowSeconds}s` : d.r.reason);

    const e = await run('throw', true);
    ok(e.r.ok === true && e.r.durationKnown === false,
      'W-3g 探针抛错 ⇒ 当"不知道"处理（探针永不拖垮抽帧）', e.r.ok ? 'ok' : e.r.reason);

    const f = await run(0, true);
    ok(f.r.ok === true && f.r.durationKnown === false,
      'W-3h 探到 0/负数 ⇒ 当未知（拿它做除数会算出 Infinity/0）');
  }

  console.log('\n【W-4】装配层：档位布尔转抽帧选项，文案按"探到的时长"分叉');
  {
    type FrameOpts = { fullCoverage?: boolean };
    const mkIo = (result: VideoFramesResult, seen: FrameOpts[]) => ({
      readFile: (p: string) => (p.endsWith('.jpg') ? Buffer.from([0xff, 0xd8, 0xff, 0xd9]) : Buffer.from('video-bytes')),
      statSize: () => null,
      readHead: () => null,
      transcribeAudio: async () => ({ ok: true as const, text: '会议录音。' }),
      extractFrames: async (_p: string, opts?: FrameOpts) => { seen.push(opts ?? {}); return result; },
    });
    const items = [{ path: '/tmp/m13/clip.mp4', fileName: 'clip.mp4' }];
    const caps = { modelCapabilities: ['chat', 'vision'] };
    const one = [{ path: '/tmp/f1.jpg', size: 4 }];
    const fullRes: VideoFramesResult = { ok: true, frames: one, windowSeconds: 3600, intervalSeconds: 450, dropped: 0, durationKnown: true, sourceSeconds: 3600 };
    const partialRes: VideoFramesResult = { ok: true, frames: one, windowSeconds: VIDEO_FRAMES_WINDOW_SEC, intervalSeconds: 90, dropped: 0, durationKnown: true, sourceSeconds: 3600 };
    const unknownRes: VideoFramesResult = { ok: true, frames: one, windowSeconds: VIDEO_FRAMES_WINDOW_SEC, intervalSeconds: 90, dropped: 0, durationKnown: false, sourceSeconds: null };

    const s1: FrameOpts[] = [];
    const r1 = await buildAttachmentParts(items, mkIo(fullRes, s1), { ...caps, longVideo: true });
    eq(s1[0]?.fullCoverage, true, 'W-4a ★Pro ⇒ 抽帧收到 `fullCoverage:true`');
    const m1 = r1.outcomes[0]?.marker ?? '';
    ok(m1.includes('全片 3600 秒') && m1.includes('每 450 秒 1 帧'),
      'W-4b ★全片覆盖的文案说"全片 / 每 450 秒"', m1);
    ok(!m1.includes('未覆盖'), 'W-4c 反证：全片覆盖不再报"未覆盖"', m1);

    const s2: FrameOpts[] = [];
    const r2 = await buildAttachmentParts(items, mkIo(partialRes, s2), { ...caps });
    eq(s2[0]?.fullCoverage, false, 'W-4d ★社区（缺省）⇒ `fullCoverage:false`');
    const m2 = r2.outcomes[0]?.marker ?? '';
    ok(m2.includes(`前 ${VIDEO_FRAMES_WINDOW_SEC} 秒`) && m2.includes('未覆盖') && m2.includes('专业版'),
      'W-4e ★社区档文案：前 N 秒 + "其后段未覆盖" + 升级指引', m2);

    const s3: FrameOpts[] = [];
    const r3 = await buildAttachmentParts(items, mkIo(unknownRes, s3), { ...caps, longVideo: true });
    const m3 = r3.outcomes[0]?.marker ?? '';
    ok(m3.includes('源时长未探到') && m3.includes('不知道'),
      'W-4f ★★时长未知时明说"其后是否还有画面本轮不知道"（不许读成看过全片）', m3);
  }

  console.log('\n【W-5】接线与唯一实现');
  {
    const vf = CODE(`${A}/src/main/core/video-frames.ts`);
    ok(/probeDuration:\s*\(p: string\) => probeMediaDurationSec\(p, FRAMES_IO\)/.test(vf),
      'W-5a ★工厂注入真探针（生产由 `makeFrameExtractor` 走 `ffmpeg -i`）');
    ok(/extractFrames\(p, \{ fullCoverage: longVideo \}\)/.test(CODE(`${A}/src/main/core/attachment-inline.ts`)),
      'W-5b ★装配层把档位布尔转成抽帧选项');
    ok(/longVideo:\s*proFeatureRefusal\(db, 'long_video'\) === null/.test(CODE(`${A}/src/main/core/agent-executor.ts`)),
      'W-5c ★执行体一处判档位再交下去（装配层不另写 `tier === ...`）');

    const mainSrc = path.join(root, A, 'src/main');
    const tsFiles = (fs.readdirSync(mainSrc, { recursive: true }) as string[])
      .filter((s) => s.endsWith('.ts'))
      .map((s) => s.split(path.sep).join('/'));
    const probeOwners = tsFiles.filter((s) => CODE(`${A}/src/main/${s}`).includes('FFMPEG_DURATION_RE'));
    eq(probeOwners, ['core/media-probe.ts'], 'W-5d ★★时长正则全仓恰一处（`media-probe.ts`）');
    const audioSrc = CODE(`${A}/src/main/core/audio-transcribe.ts`);
    ok(/from\s+'\.\/media-probe\.js'/.test(audioSrc) && !audioSrc.includes('probeAudioDurationSec'),
      'W-5e 音频侧改为引用同一实现（不再私藏第二份）');
    const factory = makeFrameExtractor(path.join(os.tmpdir(), 'rr-fx'), {
      probe: () => true,
      run: async () => ({ code: 0, timedOut: false }),
      mkdirp: async () => {},
      size: async () => null,
      remove: async () => {},
      list: async () => [],
    } as FramesIo);
    const fr = await factory('/tmp/clip.mp4', { fullCoverage: true });
    ok(fr.ok === true && fr.durationKnown === false,
      'W-5f 显式 io 的工厂不擅自探时长（老夹具按 `run` 次数取证）', fr.ok ? 'ok' : fr.reason);
  }

  console.log('\n【W-6】`long_video` 的档位闸');
  {
    ok((PRO_FEATURES as readonly string[]).includes('long_video'),
      'W-6a ★`long_video` 在 Pro 词表里（唯一定处 `pro-gate.ts`）');
    ok((PRO_FEATURE_LABEL.long_video ?? '').includes('全片'),
      'W-6b 人话名说清买到的是"全片覆盖"', PRO_FEATURE_LABEL.long_video);
    const community = makeSettingsDb(false);
    ok(proFeatureRefusal(community as never, 'long_video') !== null,
      'W-6c ★社区档拒绝（卖点有闸兑现）');
    community.close();
    const trial = makeSettingsDb(true);
    eq(proFeatureRefusal(trial as never, 'long_video'), null,
      'W-6d ★试用档放行（试用＝专业版能力）');
    trial.close();
  }

  // ═══ U｜批三「见省」：稳定前缀重排 + 前缀指纹 ═══════════════════════════════════
  console.log('\n【U-1】指纹口径（纯函数，两只标本）');
  {
    const msg = (role: string, content: string) => ({ role, content }) as never;
    const m = [msg('system', '甲'), msg('system', '乙'), msg('user', '任务行')];
    const f1 = fingerprintMessages(m as never, 2);
    const f2 = fingerprintMessages(m as never, 2);
    eq(f1.hash, f2.hash, 'U-1a 同输入同 hash（可重复）');
    eq(f1.chars, 2, 'U-1b chars ＝ 前缀内内容字符之和');
    eq(f1.end, 2, 'U-1c end 如实回指实际计入条数');
    const f3 = fingerprintMessages([msg('system', '甲'), msg('system', '丙'), msg('user', '任务行')] as never, 2);
    ok(f3.hash !== f1.hash, 'U-1d ★前缀内内容变 ⇒ hash 变（标尺有分辨力）');
    const f4 = fingerprintMessages(m as never, 3);
    ok(f4.hash !== f1.hash && f4.end === 3, 'U-1e 前缀外的消息计入后 hash 变（只算 [0,end)）');
    const f5 = fingerprintMessages(m as never, 99);
    eq(f5.end, 3, 'U-1f end 越界按消息数钳位');
    const f6 = fingerprintMessages([msg('user', '甲'), msg('system', '乙'), msg('user', '任务行')] as never, 2);
    ok(f6.hash !== f1.hash, 'U-1g ★角色也是前缀的一部分（换个角色不是同一段字节）');
  }

  console.log('\n【U-2】块序一处真源');
  {
    eq(CONTEXT_BLOCK_ORDER[CONTEXT_BLOCK_ORDER.length - 1], 'history',
      'U-2a history 恒在末尾（本段末尾特殊物化：要记区间、要裁剪）');
    eq(CONTEXT_BLOCK_ORDER.slice(0, STABLE_PREFIX_BLOCKS.length), [...STABLE_PREFIX_BLOCKS],
      'U-2b ★★稳定前缀是块序的严格前缀（稳定块与任务块不得交错）');
    ok(new Set(CONTEXT_BLOCK_ORDER).size === CONTEXT_BLOCK_ORDER.length,
      'U-2c 块名不重复（`add` 的 key 类型由它派生 ⇒ 新增块忘登记＝编译期错）',
      `${CONTEXT_BLOCK_ORDER.length} 项`);
    for (const k of ['task_line', 'current_date', 'history', 'memory', 'guidance'] as const) {
      ok(!(STABLE_PREFIX_BLOCKS as readonly string[]).includes(k),
        `U-2d 易变块 \`${k}\` 不在稳定前缀里（逐项枚举）`);
    }
  }

  console.log('\n【U-3】真装配：同一项目、不同任务 ⇒ 前缀 hash 相同');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr_u3_'));
    fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
    const db = makeContextDb();
    const a = await assembleContext(db, dir);
    const b = await assembleContext(db, dir, { title: '任务乙', description: '另一段描述' });
    const fa = fingerprintMessages(a.messages, a.stablePrefixEnd);
    const fb = fingerprintMessages(b.messages, b.stablePrefixEnd);
    eq(fa.hash, fb.hash, 'U-3a ★★同一项目、仅任务标题/描述不同 ⇒ 稳定前缀 hash 相同');
    eq(a.stablePrefixEnd, b.stablePrefixEnd, 'U-3b 两次装配的前缀边界一致（边界不随任务漂）');
    eq(fa.end, a.stablePrefixEnd, 'U-3c 指纹 end 恰等于回传的 stablePrefixEnd');
    const chars = a.messages.slice(0, a.stablePrefixEnd)
      .map((m) => (typeof m.content === 'string' ? m.content : '')).reduce((x, s) => x + s.length, 0);
    eq(fa.chars, chars, 'U-3d 指纹 chars ＝ 前缀消息内容字符合计');

    ok(a.projectCtx.startsWith('当前任务: 任务甲') && a.projectCtx.includes('工作目录:')
      && a.projectCtx.includes('通知目录(F3):'),
      'U-3e ★回传 `projectCtx` 信息不丢（任务行 / 工作目录 / 通知目录三件都在）');
    const projMsg = a.messages.find((m) => typeof m.content === 'string'
      && m.content.startsWith('<project-context>'));
    ok(!!projMsg && !String(projMsg.content).includes('当前任务'),
      'U-3f ★项目稳定块里不再含任务行（拆出后同一前缀逐字节可复用）');
    const taskIdx = a.messages.findIndex((m) => String(m.content).startsWith('当前任务: 任务甲'));
    ok(taskIdx >= a.stablePrefixEnd, 'U-3g ★★任务行落在稳定前缀之外（前言-任务不交错）',
      `taskIdx=${taskIdx} · stablePrefixEnd=${a.stablePrefixEnd}`);
    const dateIdx = a.messages.findIndex((m) => String(m.content).startsWith('<current-date>'));
    ok(dateIdx > taskIdx, 'U-3h 当前日期在任务行之后（每日必变的块靠后）', `date=${dateIdx} · task=${taskIdx}`);
    const prefIdx = a.messages.findIndex((m) => String(m.content) === '偏好：中文回答');
    ok(prefIdx >= 0 && prefIdx < a.stablePrefixEnd,
      'U-3i 用户偏好在稳定前缀内（同项目不同任务共享）', `pref=${prefIdx}`);

    const c = await assembleContext(db, dir, { userPrefs: '偏好：English' });
    ok(fingerprintMessages(c.messages, c.stablePrefixEnd).hash !== fa.hash,
      'U-3j ★改用户偏好 ⇒ hash 不同（"相同"不是靠空转得来的）');
    const d = await assembleContext(db, dir, { projCtxJson: { language_game: { terminology: { 工蚁: 'worker ant' } } } });
    ok(fingerprintMessages(d.messages, d.stablePrefixEnd).hash !== fa.hash,
      'U-3k ★改项目术语 ⇒ hash 不同（项目稳定块真进了前缀）');
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n【U-4】接线与唯一实现');
  {
    const ex = CODE(`${A}/src/main/core/exec-context.ts`);
    ok(/add\('system_prompt', SYSTEM_PROMPT_BASE\)/.test(ex) && /add\('task_line', taskLine\)/.test(ex),
      'U-4a ★块经 `add` 收集，任务行独立登记');
    ok(/for \(const key of CONTEXT_BLOCK_ORDER\)/.test(ex)
      && /if \(key === LAST_STABLE_BLOCK\) stablePrefixEnd = messages\.length/.test(ex),
      'U-4b ★★物化次序由常量唯一决定，前缀边界由块名派生（不手写下标）');
    ok(/const projectStable = projectCtx\.slice\(taskLine\.length \+ 1\)/.test(ex),
      'U-4c 稳定项目块由同一 `projectCtx` 切出（不重拼第二份，信息不丢）');
    const ae = CODE(`${A}/src/main/core/agent-executor.ts`);
    ok(/fingerprintMessages\(messages, stablePrefixEnd\)/.test(ae)
      && /ctx_prefix_hash: prefixFp\.hash/.test(ae)
      && /ctx_prefix_chars: prefixFp\.chars/.test(ae)
      && /ctx_prefix_end: prefixFp\.end/.test(ae),
      'U-4d ★★指纹三键真落 `run_features`（不是算完即扔）');
    const mainSrc = path.join(root, A, 'src/main');
    const mainTs = (fs.readdirSync(mainSrc, { recursive: true }) as string[])
      .filter((s) => s.endsWith('.ts')).map((s) => s.split(path.sep).join('/'));
    // 判"指纹实现恰一处"须钉**函数定义**，不能拿 `createHash('sha256')` 当替身——auth/license/设备凭据
    // 也在正当使用同一原语，按原语判会把它们算成"重复实现"（断言名与覆盖面不符的镜像错法）。
    const fnOwners = mainTs.filter((s) => /export function fingerprintMessages\(/.test(CODE(`${A}/src/main/${s}`)));
    eq(fnOwners, ['core/context-prefix.ts'], 'U-4e ★指纹实现全仓恰一处（按函数定义判，不按通用原语判）');
    ok(!/cache_hit/.test(ae) && !/cache_hit/.test(CODE(`${A}/src/main/core/context-prefix.ts`)),
      'U-4f 不把"前缀可复用"写成"缓存命中"（命中在供应商侧，本机看不到）');
  }

  // ═══ K｜批四「见域」：知识册九节（domain/usage）+ 空节如实 + 择节/导出同源 ═══════════
  console.log('\n【K-1】`domain` 节：术语/约定 + 高频实体（0→1，空白项滤掉）');
  {
    const db = makeKnowledgeDb();
    seedKnowledgeDb(db);
    const derived = deriveProjectKnowledge(db, 'p1');
    const domain = derived.find((e) => e.section === 'domain');
    ok(!!domain, 'K-1a ★`domain` 节从无到有（0→1）');
    const c = domain?.content ?? '';
    ok(c.includes('术语：工蚁=worker ant · 知识册=knowledge book'),
      'K-1b 术语按 `language_game.terminology` 原文成行（顺序＝录入序）', c.split('\n')[0]);
    ok(!c.includes('空术语'), 'K-1c ★空白术语不进册（"没说"不等于"一个空词条"）');
    ok(c.includes('约定：先跑 rr 再提交') && c.includes('约定：注释里不许写轮次字面量'),
      'K-1d 约定逐条成行');
    ok(/^高频实体：/.test(c.split('\n').find((l) => l.startsWith('高频实体：')) ?? ''),
      'K-1e 高频实体行在场');
    ok(c.includes('worker-ant×2') && c.includes('mqtt 台灯×2'),
      'K-1f ★按**出现次数**计（worker-ant / mqtt 台灯 各出现在主客体两侧 ⇒ ×2）');
    ok(c.includes('better-sqlite3×1') && c.includes('客厅×1'), 'K-1g 低频实体也在列（未截断）');
    ok(c.includes('使用×1') && c.includes('依赖×1') && c.includes('位于×1'),
      'K-1h 高频关系行在场（谓词各一次）');
    eq(domain?.sourceRef, 'wa_projects.context_json.language_game+wa_knowledge_triples',
      'K-1i 出处可复核（项目上下文 + 三元组两源）');

    const db2 = makeKnowledgeDb();
    db2.prepare("INSERT INTO wa_projects (id, name, context_json) VALUES ('p1', '项目甲', '{}')").run();
    const empty = deriveProjectKnowledge(db2, 'p1');
    eq(empty.some((e) => e.section === 'domain'), false,
      'K-1j 负控：无术语/无约定/无三元组 ⇒ **不出空壳**');
    db.close(); db2.close();
  }

  console.log('\n【K-2】`usage` 节：成败/主要操作/设备/外派/交付（项目归属不串台）');
  {
    const db = makeKnowledgeDb();
    seedKnowledgeDb(db);
    const usage = deriveProjectKnowledge(db, 'p1').find((e) => e.section === 'usage');
    ok(!!usage, 'K-2a ★`usage` 节从无到有（0→1）');
    const c = usage?.content ?? '';
    eq(c.split('\n')[0], '服务调用 4 次（成功 3 / 失败 1，成功率 75%）',
      'K-2b 服务调用总数/成败/成功率（同一行说得清）');
    ok(c.includes('主要操作：read×2 · send×2'),
      'K-2c 主要操作按次数降序（同数按名定序，不随机）');
    ok(/设备控制 2 次（任务发起，含被拒：denied×1 · ok×1）/.test(c),
      'K-2d ★设备只数本项目的任务发起行（他项目 a1 行与无任务的外部件都不进）', c.split('\n').find((l) => l.startsWith('设备控制')) ?? '');
    ok(c.includes('外派他机 1 件'), 'K-2e 外派按任务行上的既有归属键计（`assigned_request_id`）');
    ok(c.includes('交付物 2 件（类型分布见「已产出」）'),
      'K-2f 交付量只报总数（类型分布归 `artifacts`，册内不抄两遍）');
    eq(usage?.sourceRef, 'wa_service_calls+wa_device_actions+wa_tasks.context_json.assigned_request_id+wa_deliverables',
      'K-2g 出处逐源列出（外派用任务行而非事件日志——`node_dispatch` 无 project_id）');

    // 负控：把服务调用全删 ⇒ 不再有"0 次"的假行；其余事实仍在时整节不为空。
    db.prepare("DELETE FROM wa_service_calls WHERE project_id = 'p1'").run();
    const u2 = deriveProjectKnowledge(db, 'p1').find((e) => e.section === 'usage');
    ok(!!u2 && !u2.content.includes('服务调用'),
      'K-2h 负控：无服务调用 ⇒ 不写"0 次"的假行（没发生不等于发生过零次）');
    db.close();
  }

  console.log('\n【K-3】空册：九节皆空，预览如实列出"未产出"（不伪造空壳）');
  {
    const db = makeKnowledgeDb();
    eq(deriveProjectKnowledge(db, 'p1'), [], 'K-3a 空库 ⇒ 派生结果为空数组（不是九个空节）');
    upsertProjectKnowledge(db as never, 'p1', []);
    const pv = previewProjectKnowledge(db, 'p1');
    eq(pv.selected, [], 'K-3b 空册 ⇒ 注入选择为空（没得注入是如实值）');
    eq(pv.emptySections.map((s) => s.section), [...PROJECT_KNOWLEDGE_SECTIONS],
      'K-3c ★未产出的节按词表逐项列出（九项全在，顺序即词表序）');
    ok(pv.emptySections.some((s) => s.section === 'domain' && s.label === '领域与术语'),
      'K-3d 空节带人话名（渲染层不必再引 main 词表）');
    ok(pv.emptySections.some((s) => s.section === 'usage' && s.label === '使用实况'),
      'K-3e `usage` 空节同样如实列出');
    db.close();
  }

  console.log('\n【K-4】择节与预览：同一把尺（形态序 + 400-token 预算）');
  {
    const db = makeKnowledgeDb();
    seedKnowledgeDb(db);
    const derived = deriveProjectKnowledge(db, 'p1');
    eq(derived.map((e) => e.section), ['entities', 'artifacts', 'services', 'domain', 'usage', 'index'],
      'K-4a 派生顺序＝词表序（domain 在 services 之后、usage 次之；index 来自交付物索引）');
    eq(orderKnowledgeSections(derived, 'code').map((e) => e.section),
      ['usage', 'domain', 'artifacts', 'services', 'entities', 'index'],
      'K-4b ★code 形态：usage/domain 领跑（"这项目怎么跑起来的"先看）');
    eq(orderKnowledgeSections(derived, 'conversation').map((e) => e.section),
      ['domain', 'artifacts', 'entities', 'services', 'usage', 'index'],
      'K-4c conversation 形态：domain 领跑，未列节按词表序垫后（不静默丢）');
    eq(selectKnowledgeForInject(derived, 'code', KNOWLEDGE_INJECT_MAX_TOKENS).length, derived.length,
      'K-4d 预算足够时整册入选（此处不作截字）');
    eq(selectKnowledgeForInject(derived, 'code', 0), [], 'K-4e 预算 0 ⇒ 一节也不进（两侧标本）');
    eq(KNOWLEDGE_INJECT_MAX_TOKENS, 400, 'K-4f 注入上限仍是 400（批四未偷偷放宽）');

    upsertProjectKnowledge(db as never, 'p1', derived);
    const pv = previewProjectKnowledge(db, 'p1', 'code');
    eq(pv.budgetTokens, KNOWLEDGE_INJECT_MAX_TOKENS, 'K-4g 预览预算＝注入常量（不是第二份数）');
    eq(pv.selected.map((s) => s.section), selectKnowledgeForInject(derived, 'code', KNOWLEDGE_INJECT_MAX_TOKENS).map((e) => e.section),
      'K-4h ★预览选中的节＝真会被注入的节（同一函数、同一预算）');
    eq(pv.emptySections.map((s) => s.section), ['criteria', 'recipes', 'runtime'],
      'K-4i 仅剩三个真无源节被标"未产出"（现有六节不得误标）');
    db.close();
  }

  console.log('\n【K-5】落册 + 导出：九节真进 JSONL，每行 `training:false`');
  {
    const db = makeKnowledgeDb();
    seedKnowledgeDb(db);
    const derived = deriveProjectKnowledge(db, 'p1');
    eq(upsertProjectKnowledge(db as never, 'p1', derived), 6, 'K-5a 落册返回写入节数（0→6）');
    eq(listProjectKnowledge(db, 'p1').map((e) => e.section), derived.map((e) => e.section),
      'K-5b 读回与派生同序同节（按词表归位）');
    eq(listProjectKnowledge(db, 'p1').find((e) => e.section === 'domain')?.content,
      derived.find((e) => e.section === 'domain')?.content, 'K-5c 原文往返不丢字节');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-kn-export-'));
    const res = writeKnowledgeExport('p1', derived, dir, new Date('2026-10-18T03:04:05Z'));
    ok(res.filePath.includes('knowledge_exports') && res.filePath.endsWith('.jsonl'),
      'K-5d 导出落 `knowledge_exports/*.jsonl`', res.filePath);
    eq(res.rows, 6, 'K-5e 行数＝节数');
    eq(res.sections, derived.map((e) => e.section), 'K-5f 返回的节清单一字不差');
    eq(res.generated_at, '2026-10-18T03:04:05.000Z', 'K-5g 生成时刻＝传入的那一个"现在"');
    const lines = fs.readFileSync(res.filePath, 'utf-8').trim().split('\n');
    // zx_20261022_3 批七（钉更强形状）: 包头 1 行 + 6 节行；节行数仍与返回值一致。
    eq(lines.length, 7, 'K-5h 文件行数 = 包头 + 返回值（6 节）');
    const header = JSON.parse(lines[0]!) as { kind?: unknown; sections?: unknown };
    ok(header.kind === 'wa-knowledge' && header.sections === 6, 'K-5h2 包头自报 kind 与节数');
    const rows = lines.slice(1).map((l) => JSON.parse(l) as { training: unknown; meta: { section: string } });
    eq(rows.length, 6, 'K-5h3 包头之外恰 6 节行');
    ok(rows.every((r) => r.training === false), 'K-5i ★每节行 `training:false`（仅导出，不训练）');
    const exported = rows.map((r) => r.meta.section);
    ok(exported.includes('domain') && exported.includes('usage'),
      'K-5j 新节真进了导出文件（不是只进了内存）', exported.join(','));
    fs.rmSync(dir, { recursive: true, force: true });

    // 清册：派生结果为空 ⇒ 落册把旧节**剪掉**（不留陈旧知识）。
    eq(upsertProjectKnowledge(db as never, 'p1', []), 0, 'K-5k 空派生写入 0 节');
    eq(listProjectKnowledge(db, 'p1'), [], 'K-5l ★剪枝：不再派生的节不留在册里（陈旧知识不得冒充现行）');
    db.close();
  }

  console.log('\n【K-6】词表一处真源：九节 + 九个人话名');
  {
    eq([...PROJECT_KNOWLEDGE_SECTIONS],
      ['entities', 'artifacts', 'services', 'domain', 'usage', 'criteria', 'recipes', 'index', 'runtime'],
      'K-6a ★词表恰九项（新增两节按业务顺序落位）');
    eq(Object.keys(PROJECT_KNOWLEDGE_SECTION_LABEL), [...PROJECT_KNOWLEDGE_SECTIONS],
      'K-6b 人话名词典与词表同集同序（漏一个就编译期失败）');
    const labels = PROJECT_KNOWLEDGE_SECTIONS.map((s) => PROJECT_KNOWLEDGE_SECTION_LABEL[s]);
    ok(labels.every((l) => typeof l === 'string' && l.trim() !== ''), 'K-6c 每个人话名非空');
    eq(new Set(labels).size, labels.length, 'K-6d 人话名互不相同（两节不共用一个名字）');
  }

  console.log('\n【K-7】接线在册（去注释面）：两个派生函数唯一实现且真被调用');
  {
    const pk = CODE(`${A}/src/main/core/project-knowledge.ts`);
    ok(/const domain = deriveDomainSection\(db, pid, m\)/.test(pk) && /if \(domain\) out\.push\(domain\)/.test(pk),
      'K-7a ★`domain` 派生结果真被推入册（算完即扔不算接上）');
    ok(/const usage = deriveUsageSection\(db, pid, m\)/.test(pk) && /if \(usage\) out\.push\(usage\)/.test(pk),
      'K-7b ★`usage` 同样真被推入册');
    ok(/emptySections: PROJECT_KNOWLEDGE_SECTIONS\s*\n?\s*\.filter\(\(s\) => !present\.has\(s\)\)/.test(pk),
      'K-7c 未产出节由词表派生（不手写第二份名单）');
    ok(/KNOWLEDGE_SHAPE_ORDER[^]*?code: \['usage', 'domain'/.test(pk),
      'K-7d code 形态偏好真落在常量里（非口头）');

    const mainSrc = path.join(root, A, 'src/main');
    const mainTs = (fs.readdirSync(mainSrc, { recursive: true }) as string[])
      .filter((s) => s.endsWith('.ts')).map((s) => s.split(path.sep).join('/'));
    const domainOwners = mainTs.filter((s) => /function deriveDomainSection\(/.test(CODE(`${A}/src/main/${s}`)));
    const usageOwners = mainTs.filter((s) => /function deriveUsageSection\(/.test(CODE(`${A}/src/main/${s}`)));
    eq(domainOwners, ['core/project-knowledge.ts'], 'K-7e `deriveDomainSection` 全仓恰一处（按函数定义判）');
    eq(usageOwners, ['core/project-knowledge.ts'], 'K-7f `deriveUsageSection` 全仓恰一处');
  }

  console.log('\n【K-8】renderer 第二落点：空节文案真被消费（词表不只在 main 落一处）');
  {
    const card = RD(`${A}/renderer/src/components/KnowledgePackCard.tsx`);
    ok(/emptySections/.test(card) && /preview!\.emptySections\.map\(\(s\) => ` \$\{s\.label\}`\)/.test(card),
      'K-8a ★卡片读 `emptySections` 并按载荷里的 `label` 上屏（不再自造一份节名表）');
    ok(card.includes('尚无事实、暂未产出的节'), 'K-8b 空节文案如实（"空源不造假壳"）');
  }

  // ═══ T｜档位能力对照（批五「见清」）════════════════════════════════════════════
  console.log('\n【T-1】能力词表穷举：Pro + Team 全列，每档各恰一次');
  {
    // zx_20261018_3 批六起 `long_document` 入册 ⇒ 旧的"恰三项"是**会随轮次移动的基线**。
    //   改钉结构不变式（不放松）：无重复、既有三项仍在本轮词表内、每键都有非空人话名
    //   （`PRO_FEATURE_LABEL` 的键类型是 `ProFeature`，漏一项本就是编译期错）。
    const legacyPro = ['knowledge_export', 'image_vision', 'long_video'];
    ok(new Set(PRO_FEATURES).size === PRO_FEATURES.length
      && legacyPro.every((k) => (PRO_FEATURES as readonly string[]).includes(k))
      && PRO_FEATURES.every((k) => (PRO_FEATURE_LABEL[k] ?? '').length > 0),
      'T-1a ★Pro 词表无重复、既有三项仍在、每键都有上屏人话名（不钉"恰 N 项"这个会随轮次移动的基线）',
      PRO_FEATURES.join(','));
    // zx_20261018_3 批七：新增 `audit_export` ⇒ 6→7；zx_20261022_3 批八新增 `project_profile_share` ⇒ 7→8；
    //   zx_20261029_2 M6：`device_discovery` 移出本表（归 Pro）⇒ 8→7；逐成员枚举仍不放宽。
    eq([...TEAM_FEATURES], ['multi_node', 'device_control', 'external_terminal', 'audit_view', 'audit_export', 'team_library', 'project_profile_share'],
      'T-1b Team 能力恰七项（与 team-gate 词表同集同序；发现归 Pro）');
    const cat = tierCatalog();
    eq(cat.tiers.map((t) => t.tier), [...LICENSE_TIERS], 'T-1c 对照行与 `LICENSE_TIERS` 同集同序');
    const expected = [...PRO_FEATURES, ...TEAM_FEATURES];
    for (const row of cat.tiers) {
      eq(row.capabilities.map((c) => c.key), expected, `T-1d ${row.tier} 能力键恰为词表并集（无漏无重）`);
    }
  }

  console.log('\n【T-2】对照等价：`included` 与真实软闸同一判据（逐档逐项）');
  {
    const cat = tierCatalog();
    const expected = [...PRO_FEATURES, ...TEAM_FEATURES];
    let checked = 0;
    const mismatches: string[] = [];
    for (const row of cat.tiers) {
      for (const cap of row.capabilities) {
        const st = { tier: row.tier, kind: 'licensed' as const };
        const gate = cap.gate === 'pro' ? proUnlocked(st) : teamUnlocked(st);
        checked += 1;
        if (cap.included !== gate) mismatches.push(`${row.tier}/${cap.key}`);
      }
    }
    eq(mismatches, [], 'T-2a ★每档每项 included ≡ 软闸纯函数（对照表不另写档位判断）', `核 ${checked} 项`);
    eq(checked, LICENSE_TIERS.length * expected.length, `T-2b 判据覆盖全矩阵（${expected.length} 项 × ${LICENSE_TIERS.length} 档）`);

    const community = cat.tiers.find((t) => t.tier === 'community')!;
    const pro = cat.tiers.find((t) => t.tier === 'pro')!;
    const team = cat.tiers.find((t) => t.tier === 'team')!;
    ok(community.capabilities.every((c) => !c.included), 'T-2c 社区档各项全锁');
    eq(pro.capabilities.filter((c) => c.included).map((c) => c.key), [...PRO_FEATURES], 'T-2d 专业档所含项恰为 Pro 词表');
    ok(team.capabilities.every((c) => c.included), 'T-2e 团队档各项全开');
    eq(community.capabilities.find((c) => c.key === 'image_vision')?.upgradeLabel, TIER_LABEL.pro,
      'T-2f 锁定项写明升级到哪档（专业版）');
    eq(community.capabilities.find((c) => c.key === 'multi_node')?.upgradeLabel, TIER_LABEL.team,
      'T-2g Team 能力锁定项指向团队版');
    ok(pro.capabilities.find((c) => c.key === 'image_vision')?.upgradeLabel === null,
      'T-2h 已含项不摆升级提示');

    eq(cat.trial.days, TRIAL_DAYS, 'T-2i 试用天数由 `TRIAL_DAYS` 派生');
    eq(cat.trial.grantsTier, 'team', 'T-2j ★试用授予档位由两道闸的纯函数派生（现行语义＝团队版）');
    eq(cat.trial.grantsLabel, TIER_LABEL.team, 'T-2k 授予档位人话名同步');

    // 与真实软闸对读：社区拒 / 试用放（两只标本，不是只看 catalog 自证）。
    const communityDb = makeSettingsDb(false);
    const trialDb = makeSettingsDb(true);
    for (const f of PRO_FEATURES) {
      ok(proFeatureRefusal(communityDb as never, f) !== null, `T-2l 社区档 Pro 能力「${f}」真被拦`);
      ok(proFeatureRefusal(trialDb as never, f) === null, `T-2m 试用期 Pro 能力「${f}」真放行`);
    }
    for (const f of TEAM_FEATURES) {
      ok(teamFeatureRefusal(communityDb as never, f) !== null, `T-2n 社区档 Team 能力「${f}」真被拦`);
      ok(teamFeatureRefusal(trialDb as never, f) === null, `T-2o 试用期 Team 能力「${f}」真放行`);
    }
    communityDb.close();
    trialDb.close();
  }

  console.log('\n【T-3】卖点兑现：价目表每一句都指回有闸能力/派生上限/明示服务项');
  {
    const cat = tierCatalog();
    for (const row of cat.tiers) {
      eq(benefitCoverageProblems(row.tier, row.benefits), [], `T-3a ${row.tier} 卖点全部兑现`);
      eq(BENEFIT_COVERAGE[row.tier].map((e) => e.benefit), [...row.benefits], `T-3b ${row.tier} 登记与价目表同集同序`);
    }
    // 反证一：塞一句无闸卖点 ⇒ 必须被点名。
    const proRow = cat.tiers.find((t) => t.tier === 'pro')!;
    const polluted = [...proRow.benefits, '高级模板'];
    const found = benefitCoverageProblems('pro', polluted);
    ok(found.some((p) => p.includes('高级模板')), 'T-3c ★反证：无闸卖点被点名（判据不是空跑）', found.join('；'));
    // 反证二：改掉一句原文 ⇒ 新句未登记、旧登记成孤儿，两侧都报。
    const renamed = proRow.benefits.map((b) => (b.includes('图片内容理解') ? '图片理解' : b));
    const found2 = benefitCoverageProblems('pro', renamed);
    ok(found2.some((p) => p.includes('图片理解')) && found2.some((p) => p.includes('已登记但价目表没有这句')),
      'T-3d ★反证：改文案两侧都报（登记腐化同样弄红）', found2.join('；'));
    ok(BENEFIT_COVERAGE.community.every((e) => e.target.kind !== 'service' || e.target.reason.trim() !== ''),
      'T-3e 服务项理由非空（无闸卖点须说清为何无闸）');
    const quota = BENEFIT_COVERAGE.pro.find((e) => e.target.kind === 'quota');
    const quotaOk = quota !== undefined && quota.target.kind === 'quota' && TIER_LIMITS.pro[quota.target.field] === 0;
    ok(quotaOk, 'T-3f 「不限项目」指回 `TIER_LIMITS.pro.maxProjects=0`（非口头）');
  }

  console.log('\n【T-4】对照行派生：价/上限/卖点全取自既有真源（不另抄）');
  {
    const cat = tierCatalog();
    for (const row of cat.tiers) {
      eq(row.label, TIER_LABEL[row.tier], `T-4a ${row.tier} 档位名取 TIER_LABEL`);
      eq(row.capability, capabilityLine(row.tier), `T-4b ${row.tier} 能力行由 TIER_LIMITS 派生`);
      eq([row.maxProjectConcurrency, row.maxProjects, row.maxMembers],
        [TIER_LIMITS[row.tier].maxProjectConcurrency, TIER_LIMITS[row.tier].maxProjects, TIER_LIMITS[row.tier].maxMembers],
        `T-4c ${row.tier} 三项上限原样透传`);
      eq([...row.benefits], [...PRICING[row.tier].benefits], `T-4d ${row.tier} 卖点取价目表原文`);
    }
    eq(cat.earlyBird, EARLY_BIRD, 'T-4e 早鸟 SKU 原样透传');
    eq(cat.purchaseUrl, PURCHASE_URL, 'T-4f 购买入口一处真源（空则界面如实）');
  }

  console.log('\n【T-5】接线在册（去注释面）：IPC / renderer 类型 / 设置页消费');
  {
    const ipc = CODE(`${A}/src/main/ipc/license.ipc.ts`);
    ok(/ipcMain\.handle\('license:catalog'/.test(ipc) && /tierCatalog\(\)/.test(ipc),
      'T-5a ★`license:catalog` 通道真注册且调真源');
    const ripc = CODE(`${A}/renderer/src/lib/ipc.ts`);
    ok(/import type \{ TierCatalogPayload \} from '\.\.\/\.\.\/\.\.\/src\/main\/core\/tier-catalog\.js'/.test(ripc),
      'T-5b renderer 形状引 main 真源（不手抄镜像）');
    ok(/catalog: \(\) => ipcCall<TierCatalogPayload>\('license:catalog'\)/.test(ripc),
      'T-5c 调用行在册');
    const page = RD(`${A}/renderer/src/pages/SettingsPage.tsx`);
    ok(/licenseApi\.catalog\(\)/.test(page) && page.includes('档位与能力对照'),
      'T-5d 设置页真拉数据并出面板');
    ok(page.includes('upgradeLabel') && page.includes('已含'),
      'T-5e 锁定项按升级档位上屏（不摆空壳）');
    ok(!/'(knowledge_export|image_vision|long_video|multi_node|device_discovery|device_control)'/.test(page),
      'T-5f 设置页不手抄能力键（词表只在 main 落一处）');
  }

  console.log('\n【T-6】判据一处真源：两道闸的纯函数唯一实现，对照表只调它们');
  {
    const mainSrc = path.join(root, A, 'src/main');
    const mainTs = (fs.readdirSync(mainSrc, { recursive: true }) as string[])
      .filter((s) => s.endsWith('.ts')).map((s) => s.split(path.sep).join('/'));
    const proOwners = mainTs.filter((s) => /export function proUnlocked\(/.test(CODE(`${A}/src/main/${s}`)));
    const teamOwners = mainTs.filter((s) => /export function teamUnlocked\(/.test(CODE(`${A}/src/main/${s}`)));
    eq(proOwners, ['core/pro-gate.ts'], 'T-6a `proUnlocked` 全仓恰一处');
    eq(teamOwners, ['core/team-gate.ts'], 'T-6b `teamUnlocked` 全仓恰一处');
    const pg = CODE(`${A}/src/main/core/pro-gate.ts`);
    const tg = CODE(`${A}/src/main/core/team-gate.ts`);
    ok(/const unlocked = proUnlocked\(st\)/.test(pg), 'T-6c 真闸调用纯函数（不是另写一份 ||）');
    ok(/const unlocked = teamUnlocked\(st\)/.test(tg), 'T-6d 同上');
    const cat = CODE(`${A}/src/main/core/tier-catalog.ts`);
    ok(/proUnlocked\(state\)/.test(cat) && /teamUnlocked\(state\)/.test(cat), 'T-6e 对照表复用同一对纯函数');
    ok(!/tier === 'pro'|tier === 'team'/.test(cat), 'T-6f 对照表零档位比较字面量（判据不在这里）');
  }

  // ═══ R｜批六「见新」：事件驱动刷新（瞬态类型 / 发点 0→1 / 渲染层订阅）════════════
  console.log('\n【R-1】三个瞬态类型：在 union 中且**不在**持久化映射（发点不洪泛事件日志）');
  {
    const TRANSIENT = ['deliverable.runtime_changed', 'external.status_changed', 'external.call_recorded'];
    const eb = CODE(`${A}/src/main/core/event-bus.ts`);
    const union = /export type EventType =([\s\S]*?);\n/.exec(eb)?.[1] ?? '';
    const mapBody = /const EVENT_AGGREGATE_MAP[^{]*\{([\s\S]*?)\n\};/.exec(eb)?.[1] ?? '';
    ok(union.length > 0, 'R-1a ★`EventType` 联合可取（判据不是空跑）');
    ok(mapBody.length > 0, 'R-1a2 ★聚合映射面可取');
    for (const t of TRANSIENT) {
      ok(union.includes(`'${t}'`), `R-1b ${t} 在 EventType 联合内`);
      ok(!mapBody.includes(`'${t}'`), `R-1c ★${t} **不**在 EVENT_AGGREGATE_MAP（瞬态，不进 wa_event_log）`);
    }
    const mainIdx = CODE(`${A}/src/main/index.ts`);
    for (const t of TRANSIENT) {
      ok(new RegExp(`eventBus\\.on\\('${t}'[^\\n]*forwardToRenderer\\('${t}'`).test(mainIdx),
        `R-1d ${t} 的转发器在册（main → renderer task:event）`);
    }
  }

  console.log('\n【R-2】发点在册：交付物启停 / 门态 / 门内调用（读去注释码）');
  {
    const proj = CODE(`${A}/src/main/ipc/project.ipc.ts`);
    const emits = proj.match(/emitDeliverableRuntimeChanged\(/g)?.length ?? 0;
    ok(emits >= 8, 'R-2a ★交付物运行态发点 ≥8 处（启动多分支 + 停止 + 两处进程退出回调）', `实测 ${emits}`);
    for (const via of ['deliverable:start:sync', 'deliverable:start', 'deliverable:start:eaddrinuse',
      'deliverable:start:fail', 'a2a:exit', 'deliverable:exit', 'deliverable:stop']) {
      ok(proj.includes(`'${via}'`), `R-2b 发点动作在册：${via}`);
    }
    for (const st of ['running', 'stopped', 'failed']) {
      ok(new RegExp(`emitDeliverableRuntimeChanged\\(id, '${st}'`).test(proj), `R-2c 运行态「${st}」真被发出`);
    }

    const ext = CODE(`${A}/src/main/ipc/external.ipc.ts`);
    for (const via of ['external:approve', 'external:reject', 'external:revoke', 'external:setInbound']) {
      ok(new RegExp(`emitExternalStatusChanged\\('${via}'`).test(ext), `R-2d 门态发点在册：${via}`);
    }
    const mainIdx = CODE(`${A}/src/main/index.ts`);
    ok(/emitExternalStatusChanged\('inbound:pair_request'/.test(mainIdx),
      'R-2e ★门外来申请即通知（配对那一刻，不等 5s 轮询）');
    ok(/onCallRecorded:\s*\(entry\)\s*=>\s*emitExternalCallRecorded\(entry\)/.test(mainIdx),
      'R-2f ★装配层把门内「落账观察面」接到瞬态事件');

    const calls = CODE(`${A}/src/main/core/external-calls.ts`);
    const directWrites = calls.match(/recordExternalCall\(db,/g)?.length ?? 0;
    eq(directWrites, 1, 'R-2g ★留痕真写口恰一处（其余全经 wrapper，观察面不漏发）');
    ok(/deps\.onCallRecorded\?\.\(/.test(calls), 'R-2h wrapper 内真调用观察面');
    ok(/const record = \(entry: Parameters<typeof recordExternalCall>\[1\]\): string => \{[\s\S]{0,160}?recordExternalCall\(db, entry\);[\s\S]{0,160}?deps\.onCallRecorded\?\.\(/.test(calls),
      'R-2i ★wrapper 次序：先落库、再通知（广播失败不回头毁账）');
    eq(calls.match(/INSERT INTO wa_external_calls/g)?.length ?? 0, 1, 'R-2j ★`wa_external_calls` 的 INSERT 恰一处');
  }

  console.log('\n【R-3】行为标本：观察面 0→1（被拒也通知；烂请求不通知）');
  {
    const makeGateDb = (trial: boolean): DatabaseSync => {
      const d = makeSettingsDb(trial);
      // 生产同形（`database.ts`）：列名/默认值照搬——少一列写入即抛，比生产宽松就是假绿。
      d.exec(`CREATE TABLE wa_external_calls (
        id TEXT PRIMARY KEY,
        terminal_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        args_json TEXT DEFAULT '{}',
        result TEXT DEFAULT '',
        reason TEXT DEFAULT '',
        remote_addr TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      )`);
      return d;
    };
    type Observed = { terminalId: string; capability: string; result: string; reason?: string };
    const flush = () => new Promise<void>((r) => setTimeout(r, 0));

    const lockedDb = makeGateDb(false);
    const observed: Observed[] = [];
    const lockedPort = createExternalCapabilityPort(lockedDb as never, {
      listDevices: () => [],
      controlDevice: async () => ({ ok: true, deviceId: 'dev-1', action: 'turn_on', result: 'turned on' }),
      onCallRecorded: (e) => { observed.push(e); },
    });
    eq(observed.length, 0, 'R-3a0 起点：观察计数 0（0→1 的前提）');
    const rDenied = await lockedPort.invoke('term-1', ['device_control'],
      { capability: 'device_control', args: { action: 'turn_on' } }, '10.0.0.2');
    eq((rDenied as { status: number }).status, 403, 'R-3a 社区档：门内调用被 Team 闸真拦下');
    eq(observed.length, 1, 'R-3b ★观察面 0→1（被拒也通知，GUI 不必再猜）');
    eq(observed[0], { terminalId: 'term-1', capability: 'device_control', result: 'denied', reason: 'team_required' },
      'R-3c 观察到的四样与判据档位一致');
    eq(Number((lockedDb.prepare('SELECT COUNT(*) AS n FROM wa_external_calls').get() as { n: number }).n), 1,
      'R-3d 先落库后通知：留痕真实在账（观察面不替代写库）');

    const rBad = await lockedPort.invoke('term-1', ['device_control'], {}, '10.0.0.2');
    eq((rBad as { status: number }).status, 400, 'R-3e 缺 `capability` ⇒ 400');
    eq(observed.length, 1, 'R-3f ★反证：烂请求不通知（与"不留痕"同一把尺）');
    await flush();

    const trialDb = makeGateDb(true);
    const observed2: Observed[] = [];
    const trialPort = createExternalCapabilityPort(trialDb as never, {
      listDevices: () => [],
      controlDevice: async () => ({ ok: true, deviceId: 'dev-1', action: 'turn_on', result: 'turned on' }),
      onCallRecorded: (e) => { observed2.push(e); },
    });
    const rOk = await trialPort.invoke('term-2', ['device_control'],
      { capability: 'device_control', args: { deviceId: 'dev-1', action: 'turn_on' } }, '10.0.0.3');
    eq((rOk as { status: number }).status, 200, 'R-3g 试用档 + 已授予 ⇒ 放行（正标本）');
    eq(observed2.length, 1, 'R-3h ★一次成功调用同样通知（0→1）');
    eq([observed2[0].result, observed2[0].reason ?? ''], ['ok', ''], 'R-3i 成功行如实：result=ok、reason 为空');

    const throwDb = makeGateDb(false);
    const throwPort = createExternalCapabilityPort(throwDb as never, {
      listDevices: () => [],
      controlDevice: async () => ({ ok: true, deviceId: 'dev-1', action: 'turn_on', result: 'turned on' }),
      onCallRecorded: () => { throw new Error('observer boom'); },
    });
    const rThrow = await throwPort.invoke('term-3', ['device_control'],
      { capability: 'device_control', args: { action: 'turn_on' } }, '10.0.0.4');
    eq((rThrow as { status: number }).status, 403, 'R-3j ★反证：观察者抛错不打断调用（返回值照常）');
    eq(Number((throwDb.prepare('SELECT COUNT(*) AS n FROM wa_external_calls').get() as { n: number }).n), 1,
      'R-3k ★留痕先落库（广播失败不回头毁账）');

    lockedDb.close();
    trialDb.close();
    throwDb.close();
  }

  console.log('\n【R-4】事件总线发点行为：三个 helper 各发一条且载荷字段齐');
  {
    type Got = { type: string; data: Record<string, unknown> };
    const got: Got[] = [];
    const handler = (e: { type: string; data: Record<string, unknown> }) => { got.push({ type: e.type, data: e.data }); };
    const types = ['deliverable.runtime_changed', 'external.status_changed', 'external.call_recorded'] as const;
    for (const t of types) eventBus.on(t, handler);
    try {
      emitDeliverableRuntimeChanged('dlv-1', 'running', 'deliverable:start');
      emitExternalStatusChanged('external:approve', { pairingId: 'pair-9' });
      emitExternalCallRecorded({ terminalId: 'term-9', capability: 'device_control', result: 'ok', reason: '' });
      await new Promise<void>((r) => setTimeout(r, 0));
      eq(got.length, 3, 'R-4a ★三个发点各发一条（计数 0→3）');
      eq(got.map((g) => g.type), [...types], 'R-4b 三条的类型与调用次序一致');
      eq([got[0].data.deliverableId, got[0].data.state, got[0].data.via], ['dlv-1', 'running', 'deliverable:start'],
        'R-4c 运行态载荷：id/state/via');
      eq([got[1].data.via, got[1].data.pairingId], ['external:approve', 'pair-9'], 'R-4d 门态载荷：via + 附加键透传');
      eq([got[2].data.terminalId, got[2].data.capability, got[2].data.result, got[2].data.reason],
        ['term-9', 'device_control', 'ok', ''], 'R-4e 调用留痕载荷：四样如实（reason 缺省补空串）');
    } finally {
      for (const t of types) eventBus.off(t, handler);
    }
  }

  console.log('\n【R-5】renderer 第二落点：订阅新类型 + 轮询降为兜底（节拍一处真源）');
  {
    const ref = CODE(`${A}/renderer/src/lib/refresh.ts`);
    ok(/export const FALLBACK_POLL_MS = 30_000;/.test(ref), 'R-5a 兜底节拍常量在册（30s）');
    ok(/export const ACTIVE_POLL_MS = 5_000;/.test(ref), 'R-5b 快一拍常量在册（5s，仅门外有待批时）');

    const rsRoot = path.join(root, A, 'renderer/src');
    const rsFiles = (fs.readdirSync(rsRoot, { recursive: true }) as string[])
      .filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => f.replace(/\\/g, '/'));
    const owners = (re: RegExp) => rsFiles.filter((f) => re.test(CODE(`${A}/renderer/src/${f}`)));
    eq(owners(/export const FALLBACK_POLL_MS\s*=/), ['lib/refresh.ts'], 'R-5c ★兜底节拍全仓恰一处');
    eq(owners(/export const ACTIVE_POLL_MS\s*=/), ['lib/refresh.ts'], 'R-5d ★快一拍全仓恰一处');

    const dpage = CODE(`${A}/renderer/src/pages/DeliverablesPage.tsx`);
    ok(/import \{ FALLBACK_POLL_MS \} from '\.\.\/lib\/refresh'/.test(dpage), 'R-5e 交付物页从单源取节拍');
    ok(dpage.includes("'deliverable.runtime_changed'"), 'R-5f ★交付物页订阅运行态事件');
    ok(/setInterval\(loadRuntime, FALLBACK_POLL_MS\)/.test(dpage), 'R-5g 轮询只剩兜底（不再 10s 猜）');
    ok(!/setInterval\(loadRuntime, 10_000\)/.test(dpage), 'R-5h ★反证：旧的 10s 硬编码已不在');

    const peers = CODE(`${A}/renderer/src/pages/PeersPage.tsx`);
    ok(/liveTypes: \['external\.status_changed'\]/.test(peers), 'R-5i ★门态查询订阅事件');
    ok(/liveTypes: \['external\.call_recorded'\]/.test(peers), 'R-5j ★调用留痕查询订阅事件');
    ok(/pending\.length > 0 \? ACTIVE_POLL_MS : FALLBACK_POLL_MS/.test(peers), 'R-5k 节拍按待批状态在单源常量间切换');
    ok(/window\.setInterval\(reloadAll, pollMs\)/.test(peers), 'R-5l 轮询参数取自 `pollMs`（不再写死）');
    ok(!/setInterval\(reloadAll, 5_?000\)/.test(peers), 'R-5m ★反证：旧的无条件 5s 轮询已不在');

    const act = CODE(`${A}/renderer/src/lib/activity.tsx`);
    for (const [t, label] of [['deliverable.runtime_changed', '产出物运行态变更'],
      ['external.status_changed', '外部终端门态变更'], ['external.call_recorded', '外部终端调用留痕']] as const) {
      ok(new RegExp(`'${t.replace(/\./g, '\\.')}':\\s*'${label}'`).test(act), `R-5n 活动页人话标题在册：${label}`);
    }

    // 产物核实（renderer 是词表第二个落点）：字符串字面量在 minify 后仍在各自页面 chunk 内。
    const assets = path.join(root, A, 'renderer/dist/assets');
    const chunk = (prefix: string) => fs.readdirSync(assets).find((f) => new RegExp(`^${prefix}-.*\\.js$`).test(f));
    const dChunk = chunk('DeliverablesPage');
    const pChunk = chunk('PeersPage');
    ok(!!dChunk, 'R-5o renderer 产物内交付物页 chunk 在场', dChunk ?? '缺失');
    ok(!!dChunk && RD(`${A}/renderer/dist/assets/${dChunk}`).includes('deliverable.runtime_changed'),
      'R-5p ★产物内也能搜到运行态类型串（不只是源码）');
    ok(!!pChunk, 'R-5q renderer 产物内协同页 chunk 在场', pChunk ?? '缺失');
    ok(!!pChunk && RD(`${A}/renderer/dist/assets/${pChunk}`).includes('external.status_changed'),
      'R-5r ★产物内含门态类型串');
    ok(!!pChunk && RD(`${A}/renderer/dist/assets/${pChunk}`).includes('external.call_recorded'),
      'R-5s ★产物内含调用留痕类型串');
  }

  // ═══ P｜批七「见简」：记忆管理器拆分（搬移不变量）════════════════════════════════
  console.log('\n【P-1】公开方法逐一在类上（按符号枚举，不按行号）+ 薄委托形状');
  {
    // 方案判据：拆分出去的公开方法**逐一仍存在于类上**——按符号枚举（prototype 面），不按行号/位置。
    const MOVED: Array<[string, 'ret' | 'cons' | 'ex']> = [
      ['searchConversations', 'ret'], ['searchBM25', 'ret'], ['searchByKeywords', 'ret'],
      ['retrievalStrength', 'ret'], ['empiricalReliability', 'ret'], ['maturityOf', 'ret'], ['confidenceOf', 'ret'],
      ['retrievalPractice', 'ret'], ['searchHybrid', 'ret'], ['retrieveLayered', 'ret'],
      ['retrieveTaskRelevant', 'ret'], ['retrieveByCue', 'ret'], ['deepRetrieve', 'ret'],
      ['getRecent', 'ret'], ['getProjectKnowledge', 'ret'], ['getUnembedded', 'ret'],
      ['retrieveUnknownHits', 'ret'], ['retrieveNegativeHits', 'ret'], ['getProjectTerminology', 'ret'],
      ['applicabilityMismatch', 'ret'],
      ['consolidateMemories', 'cons'], ['runConsolidationPipeline', 'cons'], ['challengeOverconfident', 'cons'],
      ['pruneMemories', 'cons'], ['spacedRepetition', 'cons'], ['detectAndResolveConflicts', 'cons'],
      ['dialecticalSublateMemories', 'cons'],
      ['markExemplar', 'ex'], ['unmarkExemplar', 'ex'], ['getExemplars', 'ex'], ['generateExemplarContext', 'ex'],
      ['findSimilarTasks', 'ex'], ['getSimilarTaskExperience', 'ex'], ['findCrossProjectSimilarTasks', 'ex'],
      ['getCrossProjectKnowledge', 'ex'], ['clusterSimilarMemories', 'ex'],
    ];
    const { MemoryManager } = await import('../apps/worker-ant-desktop/src/main/core/memory-manager.js');
    const retMod = await import('../apps/worker-ant-desktop/src/main/core/memory-retrieval.js');
    const consMod = await import('../apps/worker-ant-desktop/src/main/core/memory-consolidation.js');
    const exMod = await import('../apps/worker-ant-desktop/src/main/core/memory-exemplars.js');
    const proto = MemoryManager.prototype as unknown as Record<string, unknown>;
    const modOf = { ret: retMod, cons: consMod, ex: exMod } as const;
    eq(MOVED.filter(([n]) => typeof proto[n] !== 'function').map(([n]) => n), [],
      'P-1a 拆分出去的公开方法**逐一仍在类上**（符号枚举，35 个）');
    eq(MOVED.filter(([n, m]) => typeof (modOf[m] as unknown as Record<string, unknown>)[n] !== 'function').map(([n]) => n), [],
      'P-1b 每个方法在新载体里都有**导出实现**（"搬走了但没接上/没导出"即红）');

    // 薄委托形状：方法体恰是一次 `<alias>*(…)` 调用（void 方法允许无 return；纯函数
    //   首参是 `mem` 而非 `this`——托管版首参才是宿主）。不是"另写一份"。
    const mmCode = CODE(`${A}/src/main/core/memory-manager.ts`);
    for (const [name, alias] of MOVED) {
      const i = mmCode.search(new RegExp(`\\n  (?:async\\s+)?${name}\\(`));
      const end = i < 0 ? -1 : mmCode.indexOf('\n  }\n', i);
      const body = i < 0 ? '' : mmCode.slice(i, end + 4);
      const thin = new RegExp(`\\{\\s*(?:return\\s+)?${alias}\\w*\\([^;]*\\);\\s*\\}\\s*$`).test(body);
      ok(i >= 0 && thin, `P-1c ${name}：方法体是薄委托（${alias}*(…)）`);
    }
  }

  console.log('\n【P-2】反证：同一夹具上「类方法出口」与「底层实现出口」JSON 深比较相等');
  {
    // 夹具按生产 DDL（含墓碑三列——`MEM_LIVE_SQL` 与 prune 路径都真实可跑），
    //   先 `new MemoryManager` 再插行（生产初始化顺序：触发器建于行之前）。
    const P7_SCHEMA = `
      CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
      CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
        status TEXT DEFAULT 'active', working_dir TEXT DEFAULT '', context_json TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, parent_task_id TEXT DEFAULT '',
        title TEXT NOT NULL, description TEXT DEFAULT '', status TEXT DEFAULT 'pending',
        priority INTEGER DEFAULT 0, context_json TEXT DEFAULT '{}', depends_on TEXT DEFAULT '',
        source TEXT DEFAULT 'test', acceptance_criteria TEXT DEFAULT '', quality_score REAL,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE wa_memories (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, content TEXT NOT NULL,
        embedding TEXT, memory_type TEXT DEFAULT 'episodic', importance REAL DEFAULT 0.5,
        reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution', user_id TEXT DEFAULT '',
        valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}', is_exemplar INTEGER DEFAULT 0,
        exemplar_type TEXT, exemplar_context TEXT, use_count INTEGER DEFAULT 0, last_used_at TEXT,
        similar_to TEXT DEFAULT '', last_reinforced_at TEXT, success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')),
        deleted_at TEXT, deleted_reason TEXT DEFAULT '', deleted_fingerprint TEXT DEFAULT '');
    `;
    const p7db = new DatabaseSync(':memory:');
    p7db.exec(P7_SCHEMA);
    const { MemoryManager } = await import('../apps/worker-ant-desktop/src/main/core/memory-manager.js');
    const ret = await import('../apps/worker-ant-desktop/src/main/core/memory-retrieval.js');
    const ex = await import('../apps/worker-ant-desktop/src/main/core/memory-exemplars.js');
    const mm = new MemoryManager(p7db as never, null as never) as unknown as Record<string, (...a: unknown[]) => unknown>;
    p7db.prepare("INSERT INTO wa_projects (id, name) VALUES ('p1','本项目')").run();
    p7db.prepare("INSERT INTO wa_settings (key, value) VALUES ('memory.exemplar_effect_rank','true')").run();
    p7db.prepare(`INSERT INTO wa_tasks (id, project_id, title, description, status, context_json, updated_at)
      VALUES ('t1','p1','目标','目标描述','pending',?,datetime('now')), ('t2','p1','相似任务','做成本核算','completed',?,datetime('now'))`)
      .run(JSON.stringify({ task_embedding: [1, 0, 0] }), JSON.stringify({ task_embedding: [0.9, 0.1, 0] }));
    const insM = p7db.prepare(`INSERT INTO wa_memories (id, project_id, task_id, content, embedding, memory_type,
      importance, valence, source, use_count, success_count, context_json, is_exemplar, exemplar_type, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`);
    insM.run('m1', 'p1', 't2', '成本核算先列口径', '[1,0,0]', 'semantic', 0.8, 'positive', 'outcome_exemplar', 3, 2,
      '{"reusable_experience":1,"applied":{"count":2,"last_success":true},"receipt":{"taskId":"t2"}}', 1, 'good', '2026-09-01 00:00:00');
    insM.run('m2', 'p1', 't2', '旧做法直接取数', '[0.9,0.1,0]', 'procedural', 0.5, 'negative', 'agent_execution', 0, 0,
      '{}', 0, null, '2026-09-02 00:00:00');
    insM.run('m3', 'p1', null, '术语：基准价 = 前收', null, 'semantic', 0.7, 'neutral', 'agent_execution', 1, 1,
      '{}', 0, null, '2026-09-03 00:00:00');

    // 只读面：逐方法在**同一夹具**上取两次出口（类方法 / 新载体自由函数），JSON 深比较。
    const snap = (): string => JSON.stringify(p7db.prepare('SELECT id, memory_type, importance, content, updated_at FROM wa_memories ORDER BY id').all());
    const before = snap();
    const pairs: Array<[string, unknown, unknown]> = [
      ['getExemplars', mm.getExemplars!('p1', 'good', 3, true), ex.getExemplars(mm as never, 'p1', 'good', 3, true)],
      ['generateExemplarContext', mm.generateExemplarContext!('p1'), ex.generateExemplarContext(mm as never, 'p1')],
      ['findSimilarTasks', mm.findSimilarTasks!('p1', 't1', 5), ex.findSimilarTasks(mm as never, 'p1', 't1', 5)],
      ['getSimilarTaskExperience', mm.getSimilarTaskExperience!('p1', 't1', 3), ex.getSimilarTaskExperience(mm as never, 'p1', 't1', 3)],
      ['getRecent', mm.getRecent!('p1', 5), ret.getRecent(mm as never, 'p1', 5)],
      ['getProjectKnowledge', mm.getProjectKnowledge!('p1', 5), ret.getProjectKnowledge(mm as never, 'p1', 5)],
      ['getUnembedded', mm.getUnembedded!(5), ret.getUnembedded(mm as never, 5)],
      ['retrieveByCue', mm.retrieveByCue!('成本核算', 'p1', 5), ret.retrieveByCue(mm as never, '成本核算', 'p1', 5)],
      ['retrieveUnknownHits', mm.retrieveUnknownHits!('成本核算', 'p1', 5), ret.retrieveUnknownHits(mm as never, '成本核算', 'p1', 5)],
      ['retrieveNegativeHits', mm.retrieveNegativeHits!('成本核算', 'p1', 5), ret.retrieveNegativeHits(mm as never, '成本核算', 'p1', 5)],
      ['getProjectTerminology', mm.getProjectTerminology!('p1'), ret.getProjectTerminology(mm as never, 'p1')],
      ['applicabilityMismatch', mm.applicabilityMismatch!({ content: 'x' } as never, '成本核算'), ret.applicabilityMismatch({ content: 'x' } as never, '成本核算')],
    ];
    for (const [name, a, b] of pairs) {
      eq(JSON.stringify(a), JSON.stringify(b), `P-2 ${name}：类出口 === 新载体出口（深比较）`);
    }
    eq(snap(), before, 'P-2 反证：全部只读方法跑完，记忆行**逐字段未变**（搬移没有夹带写副作用）');
    // zx_20261018_3 批四收口（改钉更强非放宽）：原判据写死 `≤2400`，只容得下拆分当轮——
    //   之后任何合法功能增长都会引爆（本轮「注入与使用分账」+46 行即弄红），是"只对下一轮成立"的哑雷。
    //   改钉**拆分效果本身**：管理器相对拆分前下降 ≥25%，且搬走的实现确实在新载体、
    //   管理器不再持有第二份实现（反证）。判据由"某轮的具体行数"改为"拆分这件事成立"。
    // zx_20261023_5 再订正（同方向，非放宽）：批二给管理器 +22 行（其中 16 行注释）把**总行数**顶到
    //   2481 > 2476——注释膨胀引爆判据，与前者同属哑雷族。改量**净代码行**（剥离注释与空行）：
    //   拆分的实质是"逻辑搬走了"，注释不承载管理器逻辑。基准由**拆分前提交**的同一文件当场派生
    //   （固定 `5ff06ded^`，不随 HEAD 移动），两侧同一把尺，比例仍为 3/4。
    const PRE_SPLIT_REV = '5ff06ded^';
    const preSplitSrc = execSync(
      `git show ${PRE_SPLIT_REV}:${A}/src/main/core/memory-manager.ts`,
      { cwd: root, encoding: 'utf-8' },
    );
    const netLines = (src: string): number => stripKeepingLines(src).filter((l) => l.trim().length > 0).length;
    const managerLines = netLines(RD(`${A}/src/main/core/memory-manager.ts`));
    const managerCeiling = Math.floor(netLines(preSplitSrc) * 0.75);
    eq(managerLines <= managerCeiling, true,
      `P-2 拆分效果：管理器净代码行 ≤ 拆分前的 3/4（实测 ${managerLines} / 上限 ${managerCeiling}）`);
    const retSrc = CODE(`${A}/src/main/core/memory-retrieval.ts`);
    eq(retSrc.includes('export function retrieveByCue(') && retSrc.includes('export function getProjectTerminology(') && retSrc.includes('export function getRecent('), true,
      'P-2 搬走的实现**恰在新载体**：三个代表函数均由 `memory-retrieval.ts` 导出');
    eq(CODE(`${A}/src/main/core/memory-manager.ts`).includes('function retrieveByCue('), false,
      'P-2 反证：管理器**不再**持有搬走函数的实现（不是两处各留一份）');
  }

  // ═══ S｜哑雷自检 + build 钉（派生核对，不写轮次字面量）════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6）', selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 ★方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    let pinPass = 0;
    let pinFail = 0;
    checkBuildPins((cond, label, detail) => {
      ok(cond, label, detail);
      if (cond) pinPass += 1; else pinFail += 1;
    }, { distDir: path.join(root, A, 'dist') });
    eq(pinFail, 0, 'V-11 ★`checkBuildPins` P1–P6 全绿（0 红）', `绿 ${pinPass} / 红 ${pinFail}`);
    ok(pinPass >= 6, 'V-11b 至少六条判据真跑过（"没考"不算"考过"）', `实测 ${pinPass} 条`);
  }
}

main().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\n💥 rr_${SELF_ROUND} 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
