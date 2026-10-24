/**
 * zx_20261018_3 批一「用」受控复跑 —— **注入不等于使用；写下的账要有人读**。
 *
 * 四条病根（方案 §D-1～§D-4）：
 *   D-1 旧实现把"注入上下文"直接记成 `use_count + 1` —— 模型只是**见过**（被动读到），
 *       账上却记成**用过**。注入越勤的记忆越像"被用过"，排序与再巩固都据此误判。
 *       治法：两本账分家（`injected_count` / `use_count`），装配只写前者，`memory_search` 才写后者；
 *       `wa_context_injections` 的注入账补一个**读者**（`memoryInjectionStats`）+ 记忆页可见。
 *   D-2 知识图谱的项目类三元组主语写成 `projectId.slice(0,8)`（一串十六进制），而检索按任务标题里的
 *       中文词做 `LIKE` ⇒ 这些三元组**永远检索不到**。治法：写侧主语＝项目名（一处真源
 *       `projectSubjectFor`），读侧在任务词命中不足时把项目名当补充线索，旧行幂等回填。
 *   D-3 取不到 `task_embedding` 就 `return []` ⇒ embedding 未配置时"记忆检索"整条路**静默熄火**，
 *       调用方分不清"没有相关记忆"与"根本没查"。治法：无向量走既有 `retrieveByCue`，并如实回报来源。
 *   D-4 「项目域知识」是本项目的事实（实体/约定/坑），旧优先级 `low` 让它第一个被预算丢掉；
 *       升为 `mid`，取舍仍由 `selectMemorySections` 整段负责（不越界）。
 *
 * §不变式门：
 *   G-1 真源直 import：`hasReconsolidationEvidence` / `memoryInjectionStats` / `projectSubjectFor` /
 *       `backfillTripleSubjects` / `MEM_SECTION_PRIORITY` 直接从模块导入——删/改名 ⇒ 编译期失败，
 *       而不是"扫了个空、静默假绿"。
 *   G-2 真装配不是等价自造：夹具是**真 `MemoryManager` × 内存库真行**（按本仓纪律**先 `new` 服务类
 *       再插行**——FTS 触发器建于行后会被 `try/catch` 吞成假绿）。
 *   G-3 两只标本：每条判据两侧都有真标本（注入路 0→1 / 使用路恒 0；cue 命中 / 真无记忆 ⇒ none；
 *       项目名主语 / 旧 8 位主语已绝迹；mid 先于 low 保留 / 预算宽裕一段不丢）。
 *   G-4 计数器正面断言：`injected_count` 必须 0→1（不只断言"不抛"）；反证面必须有真行证明"没动的没动"。
 *
 * ⚠ 本脚本**不写**轮次字面量（S1，判据由 `path.basename(__filename)` 派生）。
 * ⚠ 末尾 build 钉读 `dist` ⇒ 常规须 tsup 先于本脚本。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import {
  MEM_SECTION_PRIORITY,
  buildMemoryContext,
  selectMemorySections,
} from '../apps/worker-ant-desktop/src/main/core/memory-context.js';
import { CTX_MEMORY_MAX_CHARS } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { MemoryManager, hasReconsolidationEvidence, type MemoryEntry } from '../apps/worker-ant-desktop/src/main/core/memory-manager.js';
import { memoryInjectionStats } from '../apps/worker-ant-desktop/src/main/core/memory-injection-stats.js';
import { projectSubjectFor, backfillTripleSubjects } from '../apps/worker-ant-desktop/src/main/core/memory-kg-subjects.js';
import { extractTriples, searchKnowledgeGraph } from '../apps/worker-ant-desktop/src/main/core/memory-kg.js';
import { dependencyRefusal, taskDependencyBlock } from '../apps/worker-ant-desktop/src/main/core/task-dep-gate.js';
// zx_20261018_3 C-8（D6）: 父恢复判据**直引真实现**跑两只标本（暂停不恢复 / 完成恢复），不切源码字符串充数。
import { checkParentTaskAfterChildDone } from '../apps/worker-ant-desktop/src/main/core/jobs/ai-task.js';
import {
  planSubtasksFromTemplate,
  autoDecomposeForTask,
  droppedDepsNotice,
  type DecomposeDeps,
} from '../apps/worker-ant-desktop/src/main/core/task-decompose.js';
import {
  MAX_CHILD_BREADTH,
  childBreadthRefusal,
  deriveMachineConcurrency,
  parseMachineConcurrencySetting,
  resolveMachineConcurrencyLimit,
  countMachineRunning,
  MACHINE_CONCURRENCY_MIN,
  MACHINE_CONCURRENCY_MAX,
  MACHINE_CONCURRENCY_SETTING_KEY,
} from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import {
  planSystemContextCompaction,
  estimateContentTokens,
} from '../apps/worker-ant-desktop/src/main/core/context-compaction.js';
import {
  buildModelRequest,
  deriveMinContextWindow,
  taskBodyChars,
  MIN_CONTEXT_WINDOW_BASE_TOKENS,
  MIN_CONTEXT_WINDOW_MAX_TOKENS,
} from '../apps/worker-ant-desktop/src/main/core/model-request.js';
import {
  capabilityContextFloor,
  effectiveContextFloor,
} from '../apps/ans-server/src/services/model-context-floor.js';
// zx_20261018_3 批五「显」: 统计真源与分页夹取处**直 import**（删/改名 ⇒ 编译期失败，不是扫了个空）。
import { taskStatsByProject } from '../apps/worker-ant-desktop/src/main/core/project-engine.js';
import { resolvePage } from '../apps/worker-ant-desktop/src/main/core/pagination.js';
// zx_20261018_3 批六「文」: Office 文本与 PDF 页窗口**直 import 真实现**（不是照抄等价物）。
import zlib from 'node:zlib';
import { extractDocText, isDocTextExt } from '../apps/worker-ant-desktop/src/main/core/doc-text.js';
import {
  extractPdfText,
  PDF_MAX_PAGES,
  PDF_WINDOW_MAX_PAGES,
} from '../apps/worker-ant-desktop/src/main/core/pdf-text.js';
import { familyOf } from '../apps/worker-ant-desktop/src/main/core/attachment-kinds.js';
import { mediaTools } from '../apps/worker-ant-desktop/src/main/core/tools/media.js';
import {
  LICENSE_SETTING_KEYS,
  encodeLicense,
  type LicensePayload,
  type LicenseSettingDb,
} from '../apps/worker-ant-desktop/src/main/core/license.js';
// zx_20261018_3 批七「阶」: 两道闸与"卖点兑现"**直 import 真实现**（删/改名 ⇒ 编译期失败）。
import {
  PRO_FEATURES,
  PRO_FEATURE_LABEL,
  proFeatureRefusal,
} from '../apps/worker-ant-desktop/src/main/core/pro-gate.js';
import {
  TEAM_FEATURES,
  TEAM_FEATURE_LABEL,
  teamFeatureRefusal,
} from '../apps/worker-ant-desktop/src/main/core/team-gate.js';
import {
  csvEscape,
  exportAuditCsvGated,
  listAuditEvents,
  type AuditDb,
} from '../apps/worker-ant-desktop/src/main/core/audit-log.js';
import { PRICING } from '../apps/worker-ant-desktop/src/main/core/pricing.js';
import {
  BENEFIT_COVERAGE,
  benefitCoverageProblems,
} from '../apps/worker-ant-desktop/src/main/core/tier-catalog.js';
import {
  REMOTE_OFFER_TTL_MS,
  clearRemoteOffered,
  hasRemoteOfferMark,
  isRemoteBlocked,
  isRemoteOffered,
  markRemoteAssigned,
  markRemoteOffered,
  remoteBlockOf,
} from '../apps/worker-ant-desktop/src/main/core/node-orchestrate.js';
import {
  dispatchCreatedTask,
  type CreateDispatchFacts,
} from '../apps/worker-ant-desktop/src/main/core/collab-dispatch.js';
import { claimTaskForExecution } from '../apps/worker-ant-desktop/src/main/core/exec-claim.js';
import {
  MAX_PENDING_PAIRS_PER_ADDR,
  createPairingPort,
  generatePairCode,
} from '../apps/worker-ant-desktop/src/main/core/external-terminals.js';
import type { AnsNode, AnsNodeRequest } from '@worker-ant/shared-types';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, label: string, detail?: string) =>
  ok(JSON.stringify(a) === JSON.stringify(b), label, detail ?? `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const RD = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');
const noComment = (f: string) => stripKeepingLines(RD(f)).join('\n');
const countOf = (hay: string, needle: string) => hay.split(needle).length - 1;
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');
type AnyDb = import('better-sqlite3').Database;

// ═════════════════════════════════════════════════════════════════════════
// 批六夹具：手写真 ZIP / OOXML / PDF（本仓不许引新依赖；判据要餵**真字节**，
// 不是"长得像 zip 的一坨"）。ZIP 三件与 `rr_zx_20260924`、PDF 两件与
// `rr_zx_20260921` 同一口径——同一份生成器，"写进去的字"才只有一个来源。
// ═════════════════════════════════════════════════════════════════════════
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 本地头 + 中央目录 + EOCD；默认真 DEFLATE（`store:true` 才不压缩）。 */
function makeZip(entries: Array<{ name: string; data: Buffer; store?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const method = e.store ? 0 : 8;
    const payload = e.store ? e.data : zlib.deflateRawSync(e.data);
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, payload);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + payload.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const xmlPart = (name: string, xml: string) => ({ name, data: Buffer.from(xml, 'utf8') });

/**
 * 一份最小 `.xlsx`：`sharedStrings` 三串（含一个 XML 实体）+ 两行（第二行含数值单元格）。
 * 工作表名走 `workbook.xml` 的 `name`，**不靠文件名**——这样"抬头是不是真读声明"才判得出来。
 */
function makeXlsx(): Buffer {
  return makeZip([
    xmlPart('xl/sharedStrings.xml',
      '<?xml version="1.0" encoding="UTF-8"?><sst count="3" uniqueCount="3">'
      + '<si><t>姓名</t></si><si><t>数学</t></si><si><t>张三 &amp; 李四</t></si></sst>'),
    xmlPart('xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="成绩" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    xmlPart('xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8"?><Relationships>'
      + '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    xmlPart('xl/worksheets/sheet1.xml',
      '<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>95</v></c></row>'
      + '</sheetData></worksheet>'),
  ]);
}

const pptSlide = (body: string): string =>
  '<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
  + `<p:cSld><p:spTree><p:sp><p:txBody>${body ? `<a:p><a:r><a:t>${body}</a:t></a:r></a:p>` : '<a:p></a:p>'}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

/**
 * 一份最小 `.pptx`：文件名序是 A / B / 空白，`sldIdLst` 刻意排成 B / 空白 / A
 * ⇒ 只有真读了声明序，断言 `PPTX_EXPECT` 才可能过。
 */
function makePptx(): Buffer {
  return makeZip([
    xmlPart('ppt/presentation.xml',
      '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>'
      + '<p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId1"/>'
      + '</p:sldIdLst></p:presentation>'),
    xmlPart('ppt/_rels/presentation.xml.rels',
      '<?xml version="1.0" encoding="UTF-8"?><Relationships>'
      + '<Relationship Id="rId1" Type="slide" Target="slides/slide1.xml"/>'
      + '<Relationship Id="rId2" Type="slide" Target="slides/slide2.xml"/>'
      + '<Relationship Id="rId3" Type="slide" Target="slides/slide3.xml"/></Relationships>'),
    xmlPart('ppt/slides/slide1.xml', pptSlide('A 页内容')),
    xmlPart('ppt/slides/slide2.xml', pptSlide('B 页内容')),
    xmlPart('ppt/slides/slide3.xml', pptSlide('')),
  ]);
}

/** 最小 PDF：线性扫 `N G obj`，不补 xref；每页一个 FlateDecode 内容流。 */
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

/** 一页正文：首行贴当前位置，其后每行非零垂直 `Td` 下移（`pdf-text.ts` 据此断行）。 */
const pageStream = (lines: string[]): string =>
  `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => (i === 0 ? `(${l}) Tj` : `0 -14 Td (${l}) Tj`)).join(' ')} ET\n`;

/** 设置库夹具（生产同形：`license.ts` 只读 `wa_settings` 的 key/value 两列）。null = 社区档。 */
function settingsDb(trialStartIso: string | null): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime(\'now\')))');
  if (trialStartIso) {
    d.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)')
      .run(LICENSE_SETTING_KEYS.trialStartedAt, trialStartIso);
  }
  return d;
}

/**
 * 批七许可夹具：真签一枚 Ed25519 许可（密钥**只在内存里现生成**，不落盘、不入库）。
 * 三档标本：社区＝无 key；Pro / Team＝许可载荷；试用＝`settingsDb(近期时刻)`。
 */
const TEST_KEYS = crypto.generateKeyPairSync('ed25519');
const TEST_PRIVATE_PEM = TEST_KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const TEST_PUBLIC_PEM = TEST_KEYS.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const LIC_NOW = new Date('2026-10-19T00:00:00.000Z');
const LIC_OPTS = { now: LIC_NOW, fingerprint: 'AAAA-BBBB-CCCC-DDDD', publicKeyPem: TEST_PUBLIC_PEM };

function licensedSettingsDb(tier: 'pro' | 'team'): LicenseSettingDb {
  const d = settingsDb(null);
  const payload: LicensePayload = {
    v: 1, tier, subject: '受控回归', issuedAt: '2026-10-01T00:00:00.000Z', expiresAt: null, devices: [],
  };
  d.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)')
    .run(LICENSE_SETTING_KEYS.key, encodeLicense(payload, TEST_PRIVATE_PEM));
  return d as unknown as LicenseSettingDb;
}

/** 审计库夹具：生产同形 `wa_audit_events`；`prepare` 计数供"锁定零读"正面断言。 */
function makeAuditDb(rows: Array<Record<string, string>> = []): { db: AuditDb; prepares: () => number } {
  const inner = new DatabaseSync(':memory:');
  inner.exec(`CREATE TABLE wa_audit_events (
    id TEXT PRIMARY KEY, actor_kind TEXT NOT NULL DEFAULT '', actor_ref TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL, target_type TEXT NOT NULL DEFAULT '', target_id TEXT NOT NULL DEFAULT '',
    detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
  )`);
  const ins = inner.prepare(
    `INSERT INTO wa_audit_events (id, actor_kind, actor_ref, action, target_type, target_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    ins.run(
      r.id ?? '', r.actor_kind ?? '', r.actor_ref ?? '', r.action ?? '', r.target_type ?? '',
      r.target_id ?? '', r.detail_json ?? '{}', r.created_at ?? '',
    );
  }
  let count = 0;
  const proxy = {
    prepare(sql: string) {
      count += 1;
      return inner.prepare(sql);
    },
  };
  return { db: proxy as unknown as AuditDb, prepares: () => count };
}

/** 只取 `read_document` 的工具出口（其余工具不参与批六判据）。 */
function makeMediaTool(dir: string, db: DatabaseSync) {
  return mediaTools({ workingDir: dir, db } as unknown as Parameters<typeof mediaTools>[0]) as unknown as {
    read_document: { execute: (a: { filePath: string; startPage?: number; maxPages?: number }) => Promise<string> };
  };
}

/**
 * 夹具 schema——照抄生产运行时形状（`database.ts`）：`wa_memories` 含本轮两列，另含
 * `wa_context_injections`（注入明细账）与 `wa_knowledge_triples`（图谱）。
 * ⚠ 比生产宽或窄都是假的：宽则断言只是自我印证；窄则读语句抛错被 `try/catch` 吞成空数组 ⇒ 假绿。
 */
const SCHEMA = `
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
  injected_count INTEGER DEFAULT 0, last_injected_at TEXT,
  similar_to TEXT DEFAULT '', last_reinforced_at TEXT, success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL,
  name TEXT DEFAULT '', file_path TEXT, status TEXT DEFAULT 'draft',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', tool_calls TEXT, token_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_project_knowledge (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, section TEXT NOT NULL,
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
CREATE TABLE wa_context_injections (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source TEXT NOT NULL, ref_id TEXT NOT NULL,
  chars INTEGER NOT NULL DEFAULT 0, est_tokens INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_wa_context_injections_key ON wa_context_injections(task_id, source, ref_id);
CREATE TABLE wa_knowledge_triples (
  id TEXT PRIMARY KEY, project_id TEXT, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL,
  confidence REAL DEFAULT 0.5, source TEXT DEFAULT 'agent_extraction',
  created_at TEXT DEFAULT (datetime('now')));
`;

// ═════════════════════════════════════════════════════════════════════════
// 公共夹具：**先 `new` 服务类（建 FTS 触发器）再插行**——顺序颠倒则首次 UPDATE 命中未索引 rowid、
// 抛错被 `try/catch` 吞掉 ⇒ 计数器断言假绿（本仓明写的纪律）。
// ═════════════════════════════════════════════════════════════════════════
const db = new DatabaseSync(':memory:');
db.exec(SCHEMA);
const memory = new MemoryManager(db as unknown as AnyDb, null as never);
const insProject = (id: string, name: string) =>
  db.prepare('INSERT INTO wa_projects (id, name, context_json) VALUES (?,?,?)').run(id, name, '{}');
const insTask = (id: string, pid: string, title: string, ctx: Record<string, unknown> = {}) =>
  db.prepare('INSERT INTO wa_tasks (id, project_id, title, description, context_json) VALUES (?,?,?,?,?)')
    .run(id, pid, title, '', JSON.stringify(ctx));
const insMem = (id: string, pid: string, type: string, content: string, importance = 0.8) =>
  db.prepare(`INSERT INTO wa_memories (id, project_id, task_id, content, memory_type, importance, valence, context_json, use_count, injected_count)
              VALUES (?,?,?,?,?,?,?,?,0,0)`)
    .run(id, pid, null, content, type, importance, 'neutral', JSON.stringify({ experience: 'direct' }));
const memRow = (id: string) => db.prepare('SELECT id, use_count, injected_count, last_injected_at, last_used_at FROM wa_memories WHERE id = ?')
  .get(id) as { id: string; use_count: number; injected_count: number; last_injected_at: string | null; last_used_at: string | null };

async function main(): Promise<void> {
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n【A】注入与使用分账（真 MemoryManager × 真行；两本账各记各的）');
  // ═══════════════════════════════════════════════════════════════════
  {
    insProject('p-ctx', '上下文项目');
    insTask('t-ctx', 'p-ctx', '整理项目文档', { archetype: 'document' });
    insMem('ctx-a', 'p-ctx', 'semantic', '项目约定：所有文档先写大纲再扩写。', 0.9);
    insMem('ctx-b', 'p-ctx', 'procedural', '程序经验：导出前先跑一次格式检查。', 0.85);
    insMem('ctx-c', 'p-ctx', 'episodic', '上次整理文档时漏了附录页码。', 0.7);
    // 反证标本：归档记忆**不在检索可见面**（`MEM_LIVE_SQL`）⇒ 永远不该被记账。
    insMem('ctx-archived', 'p-ctx', 'archived', '归档的旧经验，不应再被注入。', 0.5);

    // A-1 注入路：`recordInjection` 只动 `injected_count`（0→1），`use_count` 恒 0。
    const b1 = memRow('ctx-a');
    memory.recordInjection(['ctx-a']);
    const a1 = memRow('ctx-a');
    ok(b1.injected_count === 0 && a1.injected_count === 1,
      'A-1 注入一次 ⇒ `injected_count` 0→1（计数器正面断言，不只断言"不抛"）', `${b1.injected_count} → ${a1.injected_count}`);
    ok(a1.use_count === 0, 'A-1b **分账反证**：注入**不冒充**使用——`use_count` 仍为 0', `use_count=${a1.use_count}`);
    ok(!!a1.last_injected_at, 'A-1c 注入时刻如实落库（`last_injected_at` 非空）', a1.last_injected_at ?? '(空)');

    // A-2 再注入累加（不是"置 1"）。
    memory.recordInjection(['ctx-a']);
    eq(memRow('ctx-a').injected_count, 2, 'A-2 再注入一次 ⇒ 2（记账是"加"不是"设"）');

    // A-3 使用路：`recordAccess` 只动 `use_count`（0→1），`injected_count` 不动。
    const b3 = memRow('ctx-a');
    memory.recordAccess(['ctx-a']);
    const a3 = memRow('ctx-a');
    ok(b3.use_count === 0 && a3.use_count === 1, 'A-3 **主动引用**（`memory_search` 路）⇒ `use_count` 0→1', `${b3.use_count} → ${a3.use_count}`);
    eq(a3.injected_count, 2, 'A-3b 反证：使用**不改写**注入账（`injected_count` 仍为 2）');
    ok(!!a3.last_used_at, 'A-3c 引用时刻如实落库（`last_used_at` 非空）');

    // A-4 真装配 `buildMemoryContext`：accessedIds 全员 injected +1，use 逐行不变（本批主断言）。
    const injectedBefore = (db.prepare('SELECT COUNT(*) c FROM wa_memories WHERE project_id = ? AND injected_count > 0').get('p-ctx') as { c: number }).c;
    const usedBefore = (db.prepare('SELECT COUNT(*) c FROM wa_memories WHERE project_id = ? AND use_count > 0').get('p-ctx') as { c: number }).c;
    const snapCtx = (col: 'injected_count' | 'use_count') => new Map(
      (db.prepare(`SELECT id, ${col} AS v FROM wa_memories WHERE project_id = ?`).all('p-ctx') as Array<{ id: string; v: number }>)
        .map((r) => [r.id, r.v] as const),
    );
    const injBeforeCtx = snapCtx('injected_count');
    const useBeforeCtx = snapCtx('use_count');
    const r1 = buildMemoryContext(memory, 'p-ctx', 't-ctx', '把文档整理成可交付形态',
      { goal: '产出整理后的文档', success_criteria: '结构完整', investigate: ['现有文档结构'] }, undefined, CTX_MEMORY_MAX_CHARS);
    const ids1 = r1.accessedIds;
    const injectedAfter = (db.prepare('SELECT COUNT(*) c FROM wa_memories WHERE project_id = ? AND injected_count > 0').get('p-ctx') as { c: number }).c;
    const usedAfter = (db.prepare('SELECT COUNT(*) c FROM wa_memories WHERE project_id = ? AND use_count > 0').get('p-ctx') as { c: number }).c;
    ok(ids1.length >= 2, 'A-4 前提：真装配确实把 ≥2 条记忆写进上下文（否则"记账"判据无所指）', `${ids1.length} 条：${ids1.join(',')}`);
    ok(usedBefore === 1 && usedAfter === 1, 'A-4b 装配**不碰** `use_count`（本组唯一一次 +1 来自 A-3 的主动引用）', `${usedBefore} → ${usedAfter} 行`);
    ok(injectedBefore === 1 && injectedAfter >= injectedBefore + 1,
      'A-4c 装配把**真正入文**者记成注入（计数器 0→≥1；本组前置 1 来自 A-1/A-2）', `${injectedBefore} → ${injectedAfter} 行`);
    const rows1 = ids1.map(memRow);
    ok(rows1.every((m) => m.injected_count === (injBeforeCtx.get(m.id) ?? 0) + 1),
      'A-4d 逐条核账：每个 `accessedIds` 成员的注入账**恰 +1**（不是"全员都动了"这种粗断言）',
      ids1.map((id, i) => `${id}:${injBeforeCtx.get(id)}→${rows1[i]!.injected_count}`).join(' '));
    ok(rows1.every((m) => m.use_count === useBeforeCtx.get(m.id)),
      'A-4d2 **分账主断言**：装配对每条记忆的 `use_count` **逐行前后同值**（注入 ≠ 使用）',
      ids1.map((id, i) => `${id}(use ${useBeforeCtx.get(id)}→${rows1[i]!.use_count})`).join(' '));
    eq(memRow('ctx-archived').injected_count, 0, 'A-4e **账＝实反证**：归档行没进文 ⇒ 注入账也绝不记它');
    const injAfterRun1 = new Map(ids1.map((id) => [id, memRow(id).injected_count]));

    // A-5 跨 run 排除：第二次装配被排除的 id 不重复入文、也不重复记账。
    const excl = new Set(ids1);
    const r2 = buildMemoryContext(memory, 'p-ctx', 't-ctx', '同一任务 resume 一次',
      { goal: '继续整理', success_criteria: '结构完整', investigate: [] }, excl, CTX_MEMORY_MAX_CHARS);
    eq(r2.accessedIds.filter((id) => excl.has(id)), [], 'A-5 跨 run 排除：上一 run 已注入的记忆不再重申（id 零重叠）');
    const rows2 = ids1.map(memRow);
    ok(rows2.every((m) => m.injected_count === injAfterRun1.get(m.id)),
      'A-5b 没入文就不记账：被排除者 `injected_count` 不再累加（与第一 run 后逐行同值）',
      ids1.map((id, i) => `${id}=${rows2[i]!.injected_count}(run1后 ${injAfterRun1.get(id)})`).join(' '));

    // A-6 静态接线（读去注释码）：装配只走 `recordInjection`；主动检索才走 `recordAccess`。
    const mc = noComment(`${A}/src/main/core/memory-context.ts`);
    const ex = noComment(`${A}/src/main/core/agent-executor.ts`);
    const tool = noComment(`${A}/src/main/core/tools/memory.ts`);
    eq(countOf(mc, 'memory.recordInjection('), 1, 'A-6 `memory-context.ts` 中装配回执恰 1 处 `recordInjection(`（旧 `recordAccess` 写法已除）');
    eq(countOf(mc, 'memory.recordAccess('), 0, 'A-6b 反证：`memory-context.ts` 已无 `recordAccess(`（注入不再冒充使用）');
    eq(countOf(ex, 'recordInjection('), 1, 'A-6c `agent-executor.ts` 的 lessons 回执恰 1 处 `recordInjection(`（同一把尺）');
    eq(countOf(tool, 'recordInjection('), 0, 'A-6d 反证：`memory_search` 工具**不**记注入（它记的是主动引用）');
    ok(countOf(tool, 'recordAccess(') >= 1, 'A-6e `memory_search` 真调 `recordAccess(`（主动引用那本账有人写）', `${countOf(tool, 'recordAccess(')} 处`);
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n【B】再巩固证据判据（纯函数四标本 + 接线）');
  // ═══════════════════════════════════════════════════════════════════
  {
    const mk = (over: Partial<Pick<MemoryEntry, 'use_count' | 'injected_count' | 'context_json'>>) => ({
      use_count: 0, injected_count: 0, context_json: '{}', ...over,
    });
    eq(hasReconsolidationEvidence(mk({})), false, 'B-1 从没被注入、也没被引用、无验证证据 ⇒ false（旧净语义）');
    eq(hasReconsolidationEvidence(mk({ injected_count: 1 })), true,
      'B-2 **只被注入过** ⇒ true（分账后补上的一支：净证据量未变，避免"注入过却不算证据"的退化）');
    eq(hasReconsolidationEvidence(mk({ use_count: 1 })), true, 'B-3 被主动引用过 ⇒ true（旧判据原样保留）');
    eq(hasReconsolidationEvidence(mk({ context_json: JSON.stringify({ evidence: { verified: true } }) })), true,
      'B-4 `context.evidence.verified=true` ⇒ true（验证证据支）');
    eq(hasReconsolidationEvidence(mk({ context_json: 'not-json' })), false, 'B-5 坏 JSON 不抛、如实判无证据（稳健性）');
    const mm = noComment(`${A}/src/main/core/memory-manager.ts`);
    eq(countOf(mm, 'hasReconsolidationEvidence(newer)'), 1, 'B-6 接线：`reconsolidateMemories` 恰 1 处调具名纯函数（一处真源）');
    eq(countOf(mm, '_hasEvidence('), 0, 'B-7 反证：旧私有判据 `_hasEvidence(` 已除（不留两份尺子）');
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n【C】注入账的读者 memoryInjectionStats（真 SQL × 按项目归集）');
  // ═══════════════════════════════════════════════════════════════════
  {
    insProject('p-a', '项目甲');
    insProject('p-b', '项目乙');
    insTask('t-a1', 'p-a', '甲任务一');
    insTask('t-a2', 'p-a', '甲任务二');
    insTask('t-b1', 'p-b', '乙任务一');
    insMem('m-a1', 'p-a', 'semantic', '甲项目记忆一');
    insMem('m-a2', 'p-a', 'semantic', '甲项目记忆二');
    insMem('m-b1', 'p-b', 'semantic', '乙项目记忆一');
    db.prepare('UPDATE wa_memories SET use_count = 3 WHERE id = ?').run('m-a1');
    db.prepare('UPDATE wa_memories SET use_count = 2 WHERE id = ?').run('m-b1');
    const insCi = (id: string, task: string, source: string, ref: string, outcome: string) =>
      db.prepare('INSERT INTO wa_context_injections (id, task_id, source, ref_id, chars, est_tokens, outcome) VALUES (?,?,?,?,?,?,?)')
        .run(id, task, source, ref, 100, 20, outcome);
    insCi('ci-1', 't-a1', 'memory', 'm-a1', 'completed');
    insCi('ci-2', 't-a1', 'memory', 'm-a2', 'pending');
    insCi('ci-3', 't-a2', 'memory', 'm-a1', 'failed');
    insCi('ci-4', 't-b1', 'memory', 'm-b1', 'completed');
    // 异源行：`source='knowledge'` 不属于记忆注入账（口径与 `knowledgeInjectionStats` 分家）。
    insCi('ci-5', 't-a1', 'knowledge', 'k-1', 'completed');

    const before = memoryInjectionStats(db as unknown as AnyDb);
    eq(before, { injected: 4, distinctMemories: 3, usedTimes: 5, completed: 2, failed: 1, pending: 1 },
      'C-1 全库口径：4 次注入 / 覆盖 3 条 / 主动引用合计 5 / 结局 2·1·1（知识源行不计入）');
    const pa = memoryInjectionStats(db as unknown as AnyDb, 'p-a');
    eq(pa, { injected: 3, distinctMemories: 2, usedTimes: 3, completed: 1, failed: 1, pending: 1 },
      'C-2 按项目归集（项目甲）：3 次 / 2 条 / 引用 3 / 1·1·1（任务→项目那一跳真生效）');
    const pb = memoryInjectionStats(db as unknown as AnyDb, 'p-b');
    eq(pb, { injected: 1, distinctMemories: 1, usedTimes: 2, completed: 1, failed: 0, pending: 0 },
      'C-3 按项目归集（项目乙）：1 次 / 1 条 / 引用 2');
    ok(before.injected === 4 && before.injected !== 5,
      "C-4 **反证**：若把 `source='knowledge'` 也算进来会是 5——实测 4 ⇒ source 过滤是活的");
    ok(pa.injected + pb.injected === before.injected && pa.usedTimes + pb.usedTimes === before.usedTimes,
      'C-5 分项与总账对得上（两项目之和 === 全库），不是两套口径');

    // C-6 实机 E2E（2026-10-19）照出的缺口：「无产出物」失败是 `executeTask` **正常返回**，
    //   根本进不了 catch 里的 `reinforceMemories(false)` ⇒ 注入账结局永远停在 `pending`
    //   （实测记忆页"失败"恒 0）。两条终态出口都要单独结清。
    const aiTask = noComment(`${A}/src/main/core/jobs/ai-task.ts`);
    eq(countOf(aiTask, "backfillInjectionOutcomes(taskId, 'failed')"), 2,
      'C-6 ★失败终态回填注入账结局：ai-task 与 resume 两条「正常返回」失败路各 1 处（不进 catch 也要结账）');
    ok(/statusRow\?\.status === 'failed'[\s\S]{0,400}?backfillInjectionOutcomes\(taskId, 'failed'\)/.test(aiTask),
      'C-6b ai-task 路：`failed` 终态块内真回填（不是只在 catch 里）');
    ok(/taskRow\.status === 'failed'[\s\S]{0,400}?backfillInjectionOutcomes\(taskId, 'failed'\)/.test(aiTask),
      'C-6c resume 路：同形回填（两条出口一把尺）');

    // C-7 同一场实机 E2E 照出的第二处：记忆类型词表在两个渲染页各手抄一份，**两份都漏**
    //   `acceptance_failure`/`panorama` ⇒ 系统记忆页直接显示英文原始键。词表收为唯一一份。
    const life = noComment(`${A}/src/main/core/memory-lifecycle.ts`);
    ok(/acceptance_failure:\s*'验收失败预警'/.test(life) && /panorama:\s*'项目知识全景'/.test(life),
      'C-7 词表补齐实测照出的两类：acceptance_failure / panorama');
    const memPage = noComment(`${A}/renderer/src/pages/MemoriesPage.tsx`);
    const projPage = noComment(`${A}/renderer/src/pages/ProjectDetailPage.tsx`);
    ok(memPage.includes('MEM_TYPE_LABEL') && projPage.includes('MEM_TYPE_LABEL'),
      'C-7b 两个渲染页**直引**唯一词表（core/memory-lifecycle.ts）');
    eq(countOf(memPage, "'情景记忆'") + countOf(projPage, "'情景记忆'"), 0,
      'C-7c ★反证：两页内已无类型中文字面量表（手抄的第二份已除）');

    // C-8 组2 实机 E2E 照出（2026-10-19，D6）：暂停的子任务仍会走 ai-task/resume 的**成功出口**去问 D1；
    //   而兄弟计数写着 `id != 自己`，把暂停者排除在外 ⇒ 独子读到「未完成兄弟 = 0」⇒ 父被假恢复；
    //   父醒来发现自己还被这个未完成子挡着，转而调 `update_task_status` 把子**归档**。
    // zx_20261022_3 批十二**就地改钉**（改钉更强的新真源，非放宽）：成对的病是「子已停、父永不知情」
    //   （真标本 094a8b47/e54532f9：子验收未过被暂停，父永远停在 children_incomplete）。
    //   新判据：**暂停 ≠ 完成，但暂停 = 已停**——子定局后必须唤醒父**复核**；唤醒文案须如实分列
    //   「其中暂停 N 个」，绝不把暂停写成「所有子任务已完成」；每笔暂停子只唤醒父一次（parent_wake_at）。
    const d1Src = noComment(`${A}/src/main/core/jobs/ai-task.ts`);
    ok(/if \(!isTerminalTask\(db, taskId\) && me\.status !== 'paused'\) return;/.test(d1Src),
      'C-8 ★D1 恢复入口：终态**或定局暂停**才往下走（暂停不是完成，但已停必须让父知情）');
    // zx_20261023_3 批五：归档子与暂停子一样是"已停、但没完成"——旧判据把 archived 排除在 kids 之外，
    //   「归档两个无效子任务」被读成"子任务已全部结束"甚至"已完成"。allDone 现同时排除 paused 与 archived，
    //   文案三分支（全完成 / 分列 stopDetail / 兜底）同源一处。断言随载体钉更强形状。
    ok(/const allDone = pausedKids === 0 && archivedKids === 0 && kids\.every\(\(k\) => k\.status === 'completed'\)/.test(d1Src)
      && /const stopDetail = \[pausedKids > 0 \? `暂停 \$\{pausedKids\} 个` : '', archivedKids > 0 \? `归档 \$\{archivedKids\} 个` : ''\]/.test(d1Src)
      && /allDone\s*\?\s*'所有子任务已完成，恢复父任务'\s*:\s*stopDetail/.test(d1Src),
      'C-8a ★暂停≠完成、归档≠完成：只有「无暂停/归档子且全 completed」才说"已完成"，否则如实分列');
    {
      const d = new DatabaseSync(':memory:');
      d.exec(SCHEMA);
      const add = (id: string, status: string, parent: string) =>
        d.prepare('INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id) VALUES (?, ?, ?, ?, ?)')
          .run(id, 'p-d1', id, status, parent);
      add('d1-p', 'paused', '');
      add('d1-c', 'paused', 'd1-p');
      const jobs: Array<{ type: string; message: string }> = [];
      const enqueue = (type: string, payload: Record<string, unknown>) => {
        jobs.push({ type, message: String(payload.message ?? '') }); return Promise.resolve();
      };
      const statusOf = (id: string) => (d.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;
      checkParentTaskAfterChildDone(d as unknown as AnyDb, 'd1-c', { enqueue });
      eq(statusOf('d1-p'), 'pending', 'C-8b 暂停子（独子）**触发父复核**——父被置回 pending（已停 ⇒ 父须处置，不永挂）');
      eq(jobs.length, 1, 'C-8c 且 `resume-ai-task` 0→1（正面断言）');
      ok(jobs[0]?.type === 'resume-ai-task' && jobs[0].message.includes('其中暂停 1 个')
        && !jobs[0].message.includes('所有子任务已完成'),
        'C-8c′ 唤醒文案如实写「其中暂停 1 个」，**不**冒充「已完成」（D6 假恢复的反证）');
      checkParentTaskAfterChildDone(d as unknown as AnyDb, 'd1-c', { enqueue });
      eq(jobs.length, 1, 'C-8c″ 同一笔暂停只唤醒父一次（parent_wake_at 去重，不陷入暂停↔唤醒热环）');
      d.prepare("UPDATE wa_tasks SET status = 'completed' WHERE id = 'd1-c'").run();
      checkParentTaskAfterChildDone(d as unknown as AnyDb, 'd1-c', { enqueue });
      eq(statusOf('d1-p'), 'pending', 'C-8d 终态子 ⇒ 父恢复 status=pending（既有防死锁路原样保留）');
      eq(jobs.length, 2, 'C-8e 且终态再唤醒 1 次（0→1→2 正面断言）：两把尺各记一笔');
      ok(jobs[1]?.message.includes('所有子任务已完成，恢复父任务'),
        'C-8e′ 终态全完成时才用"所有子任务已完成"旧文案（与暂停路分家）');
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n【D】知识图谱主语＝项目名（写侧 / 读侧 / 旧行回填）');
  // ═══════════════════════════════════════════════════════════════════
  {
    const PID = 'p-kg-1f2e3d4c';
    insProject(PID, '知识图谱项目');
    insTask('t-kg', PID, '整理数据');  // 标题**不含**项目名 ⇒ 读侧补充线索才有戏
    const legacySubject = PID.slice(0, 8);

    eq(projectSubjectFor(db as unknown as AnyDb, PID), '知识图谱项目', 'D-0 主语真源：项目名（不是 UUID 前缀）');

    const n = extractTriples(memory, '使用 React 构建前端界面，创建 报告文档', PID);
    ok(n >= 2, 'D-1 正则提取真落行（≥2 条：项目类 + 任务类）', `${n} 条`);
    const proj = db.prepare('SELECT subject, predicate, object FROM wa_knowledge_triples WHERE project_id = ? AND predicate = ?').get(PID, 'uses') as { subject: string; predicate: string; object: string } | undefined;
    ok(!!proj && proj.subject === '知识图谱项目',
      'D-1b **项目类三元组主语＝项目名**（改前是 8 位十六进制）', proj ? `${proj.subject}|${proj.predicate}|${proj.object}` : '(未落行)');
    eq(proj?.object, 'react', 'D-1c 宾语照旧小写归一（本批只改主语，不动别的尺）');
    const taskTriple = db.prepare('SELECT subject FROM wa_knowledge_triples WHERE project_id = ? AND predicate = ?').get(PID, 'produced') as { subject: string } | undefined;
    eq(taskTriple?.subject, 'task', 'D-1d 任务类主语仍是 `task`（两类别各归其位）');
    eq((db.prepare('SELECT COUNT(*) c FROM wa_knowledge_triples WHERE project_id = ? AND subject = ?').get(PID, legacySubject) as { c: number }).c, 0,
      'D-1e **反证**：旧 8 位主语在本项目行里**零条**（写侧旧形态已绝迹）');

    const byName = searchKnowledgeGraph(memory, '知识图谱项目', PID, 10);
    ok(byName.some((t) => t.predicate === 'uses' && t.object === 'react'),
      'D-2 按**中文项目名**可检索到项目类三元组（改前这条路对 8 位主语恒空）', `${byName.length} 条`);
    const byWord = searchKnowledgeGraph(memory, '知识图谱', PID, 10);
    ok(byWord.some((t) => t.subject === '知识图谱项目'), 'D-2b 项目名的子串（中文词）也能命中（LIKE 语义照旧）');

    const ctxTriples = memory.retrieveKnowledgeGraphContext('t-kg', PID, 5);
    ok(ctxTriples.length > 0 && ctxTriples.some((t) => t.subject === '知识图谱项目'),
      'D-3 读侧补充线索：任务标题不含项目名时，项目自身的知识仍被带出', `${ctxTriples.length} 条：${ctxTriples.map((t) => t.subject).join(',')}`);

    // D-4 旧行回填：幂等（第一次改 1 行，第二次 0 行；读不到项目名的孤儿行原样保留）。
    db.prepare('INSERT INTO wa_knowledge_triples (id, project_id, subject, predicate, object, confidence, source) VALUES (?,?,?,?,?,?,?)')
      .run('kg-legacy', PID, legacySubject, 'uses', 'legacy-lib', 0.5, 'legacy');
    db.prepare('INSERT INTO wa_knowledge_triples (id, project_id, subject, predicate, object, confidence, source) VALUES (?,?,?,?,?,?,?)')
      .run('kg-orphan', 'p-missing', 'p-missin', 'uses', 'gone', 0.5, 'legacy');
    const subjOf = (id: string) => (db.prepare('SELECT subject FROM wa_knowledge_triples WHERE id = ?').get(id) as { subject: string }).subject;
    const c1 = backfillTripleSubjects(db as unknown as AnyDb);
    eq(c1, 1, 'D-4 回填第一遍：恰改 1 行（孤儿行不猜、不抹）');
    eq(subjOf('kg-legacy'), '知识图谱项目', 'D-4b 旧主语已改写成项目名');
    eq(subjOf('kg-orphan'), 'p-missin', 'D-4c **反证**：项目已不存在 ⇒ 主语原样保留（不编造）');
    const c2 = backfillTripleSubjects(db as unknown as AnyDb);
    eq(c2, 0, 'D-4d 回填幂等：第二遍 0 行（跑两次不改动任何行）');
    ok(searchKnowledgeGraph(memory, '知识图谱项目', PID, 10).some((t) => t.object === 'legacy-lib'),
      'D-4e 回填后的旧行也走同一条中文检索路（回填不是账面装饰）');

    const dbSrc = noComment(`${A}/src/main/database.ts`);
    eq(countOf(dbSrc, 'backfillTripleSubjects(db)'), 1, 'D-5 接线：`database.ts` 启动期真调回填（恰 1 处）');
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n【E】无 embedding 时线索检索不再静默为空（真 MemoryManager × 两只标本）');
  // ═══════════════════════════════════════════════════════════════════
  {
    insProject('p-cue', '线索项目');
    insTask('t-cue', 'p-cue', '知识图谱 检索');  // context_json 无 task_embedding
    // 用 `retrospective`（不在第 1/2 段取数面内）——若用 semantic，第 1 段先 `appendFresh` 吃掉，
    // 第 5 段就永远是空的，E-4 的标题判据就成了"夹具自己导致的假红"。
    insMem('e-hit', 'p-cue', 'retrospective', '知识图谱的主语必须改为项目名，否则检索不到。', 0.5);
    insMem('e-miss', 'p-cue', 'retrospective', '部署流水线的缓存配置说明。', 0.9);

    insProject('p-empty', '空项目');
    insTask('t-empty', 'p-empty', '知识图谱 检索');

    const hit = memory.retrieveTaskRelevantWithSource('t-cue', 'p-cue', 5);
    ok(hit.source === 'cue', 'E-1 无向量 ⇒ 来源如实报 `cue`（不再假装语义检索）', `source=${hit.source}`);
    ok(hit.memories.length > 0, 'E-2 **该命中**标本：无 embedding 时线索检索非空（旧实现此处恒空）', `${hit.memories.length} 条`);
    eq(hit.memories[0]?.id, 'e-hit', 'E-2b 命中的是关键词真命中的那条（不是随便凑数）');
    const oldEntry = memory.retrieveTaskRelevant('t-cue', 'p-cue', 5);
    eq(oldEntry.map((m) => m.id), hit.memories.map((m) => m.id),
      'E-3 旧入口 `retrieveTaskRelevant` 委托同一实现（行为不分叉）');

    const rCue = buildMemoryContext(memory, 'p-cue', 't-cue', undefined, null, undefined, CTX_MEMORY_MAX_CHARS);
    ok(rCue.context.includes('## 任务相关记忆（按关键词线索检索）'),
      'E-4 装配把**来源**写进段标题（模型/排障都看得见这是线索检索，不是语义检索）');

    const none = memory.retrieveTaskRelevantWithSource('t-empty', 'p-empty', 5);
    ok(none.memories.length === 0 && none.source === 'none',
      'E-5 **反证（真无记忆）**：空项目如实回 `none` + 空集（不编造）', `source=${none.source} / ${none.memories.length} 条`);

    const ret = noComment(`${A}/src/main/core/memory-retrieval.ts`);
    const body = ret.slice(ret.indexOf('export function retrieveTaskRelevantWithSource'), ret.indexOf('export function retrieveTaskRelevant('));
    ok(body.includes('retrieveByCue(mgr, queryText, projectId, topK)'),
      'E-6 接线：无向量分支真调**既有** `retrieveByCue`（不新增第二套打分）');
    ok(body.includes("source: cue.length > 0 ? 'cue' : 'none'"),
      'E-6b 来源派生自结果本身（有线索才叫 cue，真的空才叫 none）');
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n【F】项目域知识 low→mid（静态 + 取舍行为两标本）');
  // ═══════════════════════════════════════════════════════════════════
  {
    eq(MEM_SECTION_PRIORITY['项目域知识'], 'mid', 'F-1 静态：项目域知识 = mid（本项目的事实，不是跨项目泛化背景）');
    eq(MEM_SECTION_PRIORITY['记忆有效性'], 'low', 'F-1b 低优先段仍有真载体（low 段没被整体取消）');
    eq(MEM_SECTION_PRIORITY['跨项目知识迁移'], 'low', 'F-1c 跨项目泛化背景仍是 low');
    eq(MEM_SECTION_PRIORITY['任务关键约束'], 'high', 'F-1d 高优先段优先级未动（本批只调一段）');

    const big = 'X'.repeat(400);
    const sections = [
      { name: '项目域知识', priority: MEM_SECTION_PRIORITY['项目域知识']!, text: big },
      { name: '记忆有效性', priority: MEM_SECTION_PRIORITY['记忆有效性']!, text: big },
    ];
    const tight = selectMemorySections(sections, 410);
    eq(tight.kept.map((s) => s.name), ['项目域知识'], 'F-2 预算只够一段 ⇒ 留下的必须是 mid 的「项目域知识」（low 先丢）');
    eq(tight.omitted.map((s) => s.name), ['记忆有效性'], 'F-2b 被丢的是 low 的「记忆有效性」');
    ok(tight.chars <= 410, 'F-2c 整段取舍仍在预算内（不越界）', `${tight.chars} ≤ 410`);
    const loose = selectMemorySections(sections, 1000);
    eq(loose.omitted.length, 0, 'F-3 **反证（预算宽裕）**：一段不丢（mid 升级不是靠"总丢 low"取胜）');
    eq(loose.chars, 802, 'F-3b 两段全留（400 + 400 + 段间 2）');
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n【G】端到端对齐：main IPC ↔ renderer 页面 ↔ 构建产物');
  // ═══════════════════════════════════════════════════════════════════
  {
    const ipc = noComment(`${A}/src/main/ipc/admin.ipc.ts`);
    eq(countOf(ipc, "ipcMain.handle('memory:injectionStats'"), 1, 'G-1 main 侧恰 1 个 `memory:injectionStats` 处理器');
    ok(ipc.includes("from '../core/memory-injection-stats.js'") && ipc.includes('memoryInjectionStats(db, projectId)'),
      'G-2 处理器真调共享纯函数（不是页面里再写一份 SQL）');
    const index = noComment(`${A}/src/main/index.ts`);
    ok(index.includes('initMemoryIpc(db, memory)'), 'G-3 处理器所在的 `initMemoryIpc` 真被启动流程调用（不是死代码）');

    const api = RD(`${A}/renderer/src/lib/ipc.ts`);
    ok(api.includes('memoryInjectionStats') && api.includes("'memory:injectionStats'"),
      'G-4 renderer API 的通道名与 main 侧逐字一致');
    const page = RD(`${A}/renderer/src/pages/MemoriesPage.tsx`);
    ok(page.includes('admin.memoryInjectionStats('), 'G-5 记忆页真调该 API');
    ok(page.includes('记忆注入账') && page.includes('主动引用'),
      'G-6 页面把两本账**分开命名**（注入 ≠ 主动引用，用户看得见差别）');
    ok(page.includes('injected_count') && page.includes('use_count'),
      'G-7 行级也分列两账（列表里各自可见）');

    const assetsDir = path.join(root, A, 'renderer/dist/assets');
    const js = fs.existsSync(assetsDir)
      ? fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf-8'))
      : [];
    ok(js.some((s) => s.includes('记忆注入账')),
      'G-8 **产物级**：renderer 构建产物含「记忆注入账」中文串（renderer 是词表的第二个落点）', `${js.length} 个 chunk`);
    ok(js.some((s) => s.includes('主动引用')), 'G-8b 产物级：两本账的分名在产物里也在');
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n【B′】批二「序」：依赖是一把尺，不许从侧门进');
  // ① 闸的行为（真实现 × 真库）：前置未满足拦、满足放、笔误不拦；
  // ② 三条人工入口的接线与**次序**（闸必须在第一处写入/入队之前）；
  // ③ 拆解落行：向后引用 / 兄弟环 / 广度截断 / 单事务零残留；
  // ④ 拆解失败留痕 0→1，且"正常空答"不产噪音（两只标本）。
  // ═══════════════════════════════════════════════════════════════════
  {
    const freshDb = (): DatabaseSync => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d; };
    const mkParent = (d: DatabaseSync, pid: string, tid: string) => {
      d.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run(pid, pid);
      d.prepare("INSERT INTO wa_tasks (id, project_id, title, status) VALUES (?, ?, ?, 'pending')").run(tid, pid, tid);
    };
    const tpl = (title: string, dependsOn?: number[]) =>
      ({ title, description: 'd', acceptance_criteria: 'a', ...(dependsOn ? { dependsOn } : {}) });
    const kidsOf = (d: DatabaseSync, pid: string) =>
      d.prepare('SELECT id, title, status, depends_on FROM wa_tasks WHERE parent_task_id = ? ORDER BY priority DESC, rowid').all(pid) as
        Array<{ id: string; title: string; status: string; depends_on: string }>;
    const convCount = (d: DatabaseSync, tid: string) =>
      (d.prepare('SELECT COUNT(*) AS c FROM wa_task_conversations WHERE task_id = ?').get(tid) as { c: number }).c;
    const lastConv = (d: DatabaseSync, tid: string) =>
      ((d.prepare("SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'system' ORDER BY rowid DESC LIMIT 1").get(tid) as
        | { content?: string }
        | undefined)?.content) ?? '';
    /** 第 `failAt` 次 `INSERT INTO wa_tasks` 抛错——用于验证 savepoint 回滚（其余语句原样透传）。 */
    const flakyDb = (base: DatabaseSync, failAt: number) => {
      let n = 0;
      return {
        prepare(sql: string) {
          const stmt = base.prepare(sql);
          if (!/^\s*INSERT\s+INTO\s+wa_tasks\b/i.test(sql)) return stmt;
          return {
            run: (...args: unknown[]) => {
              n += 1;
              if (n === failAt) throw new Error('injected write failure');
              return (stmt.run as unknown as (...a: unknown[]) => unknown).apply(stmt, args);
            },
            get: (...args: unknown[]) => (stmt.get as unknown as (...a: unknown[]) => unknown).apply(stmt, args),
            all: (...args: unknown[]) => (stmt.all as unknown as (...a: unknown[]) => unknown[]).apply(stmt, args),
          };
        },
      };
    };

    // ── ① 闸本身：两只标本（拦 / 放）+ 笔误不拦 + 只读 ──
    {
      const d = freshDb();
      d.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run('p-dep', '依赖项目');
      const ins = (id: string, title: string, status: string, deps = '') =>
        d.prepare('INSERT INTO wa_tasks (id, project_id, title, status, depends_on) VALUES (?, ?, ?, ?, ?)')
          .run(id, 'p-dep', title, status, deps);
      ins('dep-ok', '已完成前置', 'completed');
      ins('dep-run', '在跑前置', 'executing');
      ins('dep-bad', '已失败前置', 'failed');
      ins('t-wait', '等前置的任务', 'paused', 'dep-run');
      ins('t-dead', '前置已死的任务', 'paused', 'dep-bad');
      ins('t-met', '前置已满足的任务', 'paused', 'dep-ok');
      ins('t-unres', '笔误前置的任务', 'paused', 'no-such-id');

      const w = dependencyRefusal(d as never, 't-wait');
      eq(w?.error.code, 'DEPENDENCY_BLOCKED', 'B-1 ★前置在途 ⇒ 拒绝体码 `DEPENDENCY_BLOCKED`（三条入口共用这一句）');
      ok(!!w?.error.message && w.error.message.includes('在跑前置'),
        'B-1b 拒绝文案**点名**是哪个前置在等（不是一句"依赖未满足"）', w?.error.message ?? '(空)');
      const dead = taskDependencyBlock(d as never, 't-dead');
      eq(dead?.state, 'dead', 'B-2 前置已失败 ⇒ 分类 `dead`（不会自动解锁）');
      ok((dead?.message ?? '').includes('已失败前置'), 'B-2b 死前置也点名（`depBlockInfo` 同一文案真源）', dead?.message ?? '(空)');
      eq(dependencyRefusal(d as never, 't-met'), null, 'B-3 **反证**：前置 completed ⇒ 放行（返回 null，不是空文案）');
      eq(dependencyRefusal(d as never, 't-unres'), null,
        'B-3b **字节等价**：前置 id 查不到（`unresolved`）**不拦**——笔误不新造拦截面（M3-2 裁定）');
      eq((d.prepare("SELECT status FROM wa_tasks WHERE id = 't-wait'").get() as { status: string }).status, 'paused',
        'B-4 闸是**只读**的：判完任务状态零变');
      const gateSrc = noComment(`${A}/src/main/core/task-dep-gate.ts`);
      eq(countOf(gateSrc, 'classifyDep('), 1, 'B-4b 分类仍归 `dep-graph`（闸内恰 1 处调用，不另写判定）');
      eq(countOf(gateSrc, 'depBlockInfo('), 1, 'B-4c 文案取 `depBlockInfo` 唯一真源（不在此另拼一句）');
    }

    // ── ② 三条人工入口：同一把尺 + 闸在第一处写入之前 ──
    {
      const ipc = noComment(`${A}/src/main/ipc/project.ipc.ts`);
      const handlerBody = (name: string): string => {
        const at = ipc.indexOf(`ipcMain.handle('${name}'`);
        if (at < 0) return '';
        const next = ipc.indexOf('ipcMain.handle(', at + 10);
        return ipc.slice(at, next > at ? next : undefined);
      };
      const orderOk = (body: string, mutations: string[]): boolean => {
        const g = body.indexOf('dependencyRefusal(db, id)');
        return g >= 0 && mutations.every((m) => {
          const at = body.indexOf(m);
          return at < 0 || at > g;
        });
      };
      const entries: Array<[string, string[]]> = [
        ['task:updateStatus', ['supersedeExecutionJobs(db, id', 'UPDATE wa_tasks SET status = ?', 'INSERT INTO wa_jobs']],
        ['task:retry', ['DELETE FROM wa_task_conversations', 'retireTaskDeliverables(']],
        ['task:resume', ['isDuplicatePauseResponse(', 'INSERT INTO wa_task_conversations', 'UPDATE wa_tasks SET status', 'enqueueResumeJob(']],
      ];
      for (const [name, mutations] of entries) {
        const body = handlerBody(name);
        ok(body.includes('const blocked = dependencyRefusal(db, id);') && body.includes('if (blocked) return blocked;'),
          `B-5 \`${name}\` 调**同一把尺**并原样返回拒绝体（不再从侧门放行）`);
        ok(orderOk(body, mutations),
          `B-5b \`${name}\` 的闸**位于任何状态写入/作业入队之前**——拒时状态零变、作业零新增`,
          `gate@${body.indexOf('dependencyRefusal(db, id)')} / 写入点 ${mutations.map((m) => `${m}@${body.indexOf(m)}`).join(' ')}`);
      }
      ok(/if \(status === 'running'\) \{\s*const blocked = dependencyRefusal\(db, id\);\s*if \(blocked\) return blocked;\s*\}/.test(handlerBody('task:updateStatus')),
        "B-5c 「执行」只拦 `running` 一路——暂停/完成/归档等**处置**动作不被依赖闸误伤（闸拦开跑，不拦收尾）");

      const sch = noComment(`${A}/src/main/core/task-scheduler.ts`);
      eq(countOf(sch, 'taskDepState(this.db, taskId)'), 1,
        'B-6 调度器 `depStateOf` 委托 `taskDepState`（自动调度与人工入口同一读法）');
      eq(countOf(sch, 'classifyDep('), 0, 'B-6b 反证：调度器不再自带 `classifyDep(` 组合（一把尺只留一处）');
      ok(sch.includes("import { taskDepState } from './task-dep-gate.js'"), 'B-6c 接线在册（import 同一真源）');
    }

    // ── ③ 拆解落行：向后引用 / 兄弟环 / 广度截断 / 单事务零残留 ──
    {
      const d = freshDb(); mkParent(d, 'p-fw', 'FW');
      const r = planSubtasksFromTemplate(d as never, {
        parentTaskId: 'FW', projectId: 'p-fw', depth: 0, source: 'auto-decompose',
        template: [tpl('甲', [3]), tpl('乙'), tpl('丙')],
      });
      eq([r.created, r.planned, r.droppedDeps], [3, 3, 0], 'B-7 三行全建、零丢边（向后引用不触发任何闸）');
      const rows = kidsOf(d, 'FW');
      eq(rows.map((x) => x.title), ['甲', '乙', '丙'], 'B-7b 行序＝模板序（priority 派生，读回可对照）');
      eq(rows[0]?.depends_on, rows[2]?.id,
        'B-7c ★★**向后引用真实落库**：第 1 个子任务的 `depends_on` 指向第 3 个的真实 id（旧实现此处静默为空串）');
      eq(rows[1]?.depends_on, '', 'B-7d 反证：没声明前置的那行仍为空（不连带乱写）');
      eq(r.noDepCount, 2, 'B-7e 无前置数如实＝2');
    }
    {
      const d = freshDb(); mkParent(d, 'p-cyc', 'CY');
      const r = planSubtasksFromTemplate(d as never, {
        parentTaskId: 'CY', projectId: 'p-cyc', depth: 0, source: 'auto-decompose',
        template: [tpl('甲', [2]), tpl('乙', [1])],
      });
      eq([r.created, r.droppedDeps], [2, 1], 'B-8 ★兄弟环（甲→乙、乙→甲）：两行照建、恰丢闭环的那 1 条边');
      const rows = kidsOf(d, 'CY');
      ok(rows[0]?.depends_on === rows[1]?.id && rows[1]?.depends_on === '',
        'B-8b ★**不产生互锁行**：留下的是先接纳的那条（甲依赖乙），乙不再依赖甲 ⇒ 有效 DAG，乙先起跑',
        rows.map((x) => `${x.title}:${x.depends_on || '(无)'}`).join(' / '));
      const notice = droppedDepsNotice(r.droppedDepNotes);
      ok(notice.includes('「乙」的前置「甲」') && notice.includes('未落库'),
        'B-8c 文案**点名**被丢的那一条（不是只报个数）', notice);
      eq(r.noDepCount, 1, 'B-8d 丢边后乙确实无前置（可立即执行）');
      eq(droppedDepsNotice([]), '', 'B-8e **反证**：没有丢边 ⇒ 空串（该报的报、不该报的不报）');
    }
    {
      const d = freshDb(); mkParent(d, 'p-bw', 'BW');
      for (let i = 0; i < MAX_CHILD_BREADTH - 2; i++) {
        d.prepare("INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id) VALUES (?, 'p-bw', ?, 'pending', 'BW')")
          .run(`pre-${i}`, `已有${i}`);
      }
      const beforeRows = kidsOf(d, 'BW').length;
      const r = planSubtasksFromTemplate(d as never, {
        parentTaskId: 'BW', projectId: 'p-bw', depth: 0, source: 'auto-decompose',
        template: [tpl('子1'), tpl('子2'), tpl('子3'), tpl('子4')],
      });
      eq([r.planned, r.created], [4, 2], 'B-9 广度只余 2 槽（已有 3 个在途）⇒ 规划 4、实建 2');
      eq(kidsOf(d, 'BW').length - beforeRows, r.created, 'B-9b ★**落库数与 `created` 一致**（报数不是"模型说几个"）');
      eq(r.refusal, childBreadthRefusal(d as never, 'BW'),
        'B-9c 截断拒因与 `childBreadthRefusal` **逐字同一句**（同一把尺，不另写文案）');
      ok((r.refusal ?? '').includes(String(MAX_CHILD_BREADTH)), 'B-9d 拒因里写着真上限', r.refusal ?? '(空)');
    }
    {
      const d = freshDb(); mkParent(d, 'p-rb', 'RB');
      const r = planSubtasksFromTemplate(flakyDb(d, 2) as never, {
        parentTaskId: 'RB', projectId: 'p-rb', depth: 0, source: 'auto-decompose',
        template: [tpl('子1'), tpl('子2'), tpl('子3')],
      });
      eq(r.created, 0, 'B-10 ★事务失败 ⇒ `created=0`（不把"插了一半"报成实建）');
      ok((r.refusal ?? '').includes('已回滚'), 'B-10b 拒因如实写"已回滚"并带真因', r.refusal ?? '(空)');
      eq(kidsOf(d, 'RB').length, 0, 'B-10c ★★**零残留**：第 1 条已插入的行随 savepoint 回滚，库里 0 行');
    }

    // ── ④ 拆解失败留痕（0→1）与"正常空答不产噪音"（两只标本） ──
    {
      const d = freshDb(); mkParent(d, 'p-llm', 'LLM');
      const n0 = convCount(d, 'LLM');
      const throwingDeps = (): DecomposeDeps => ({
        resolveModel: async () => ({ url: 'http://stub.invalid', api_key: 'k' }),
        chat: async () => { throw new Error('endpoint boom'); },
      });
      const r = await autoDecomposeForTask({
        db: d as never, taskId: 'LLM', projectId: 'p-llm', goal: '把服务从零跑起来', depth: 0,
        getDeps: async () => throwingDeps(), label: '任务启动', noDepWhen: '立即启动',
      });
      eq(r, null, 'B-11 LLM 抛错 ⇒ 拆解结果为 null（父按单任务执行，不阻断）');
      eq(convCount(d, 'LLM') - n0, 1, 'B-11b ★**系统会话行 0→1**（拆解失败不再无声）');
      const row = lastConv(d, 'LLM');
      ok(row.includes('未能拆解') && row.includes('endpoint boom') && row.includes('按单任务执行'),
        'B-11c 留痕写明真因与人话去向', row);
      eq((d.prepare("SELECT status FROM wa_tasks WHERE id = 'LLM'").get() as { status: string }).status, 'pending',
        'B-11d 父任务状态不动（拆不成 ≠ 做不成）');
      eq(kidsOf(d, 'LLM').length, 0, 'B-11e 且零子任务（不假装拆过）');

      const d2 = freshDb(); mkParent(d2, 'p-simple', 'SIM');
      const r2 = await autoDecomposeForTask({
        db: d2 as never, taskId: 'SIM', projectId: 'p-simple', goal: '倒杯水', depth: 0,
        getDeps: async () => ({
          resolveModel: async () => ({ url: 'http://stub.invalid', api_key: 'k' }),
          chat: async () => ({ ok: true as const, text: '[]' }),
        }),
        label: '任务启动', noDepWhen: '立即启动',
      });
      eq(r2, null, 'B-12 模型答"任务很简单"（[]）⇒ null（与失败同样不建子任务）');
      eq(convCount(d2, 'SIM'), 0, 'B-12b ★**反证**：正常空答**不产**失败留痕（否则每件小任务都多一行噪音）');

      const dec = noComment(`${A}/src/main/core/task-decompose.ts`);
      const fn = dec.slice(dec.indexOf('export async function decomposeTask('), dec.indexOf('export async function postDecomposeChat('));
      eq(countOf(fn, 'return failed('), 3, 'B-13 `decomposeTask` 三条**真失败**路（取端点 / 调用失败 / 抛错）都走留痕');
      ok(fn.includes('opts.onFailure?.('), 'B-13b 留痕经 `onFailure` 回调（旁路，不改变"永不抛"的形状）');
      ok(dec.includes('droppedDepsNotice(r.droppedDepNotes)'), 'B-13c 引擎/启动路的会话行点名被丢的成环边（同一句真源）');
      const im = noComment(`${A}/src/main/services/im-router.ts`);
      ok(im.includes('onFailure: (reason)') && im.includes('未能拆解'), 'B-14 IM 路同样留痕（拆解失败有据可查）');
      ok(im.includes('droppedDepsNotice(droppedDepNotes)'), 'B-14b IM 路也点名被丢的成环边（两路同一句）');
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n【C′】批三「派」：两阶段占位（回包前即挡） + 认领让位 + 配对码加固');
  // ═══════════════════════════════════════════════════════════════════
  {
    // C′ 夹具：主 SCHEMA + 生产同形的 `wa_external_terminals` / `wa_audit_events`。
    const C_SCHEMA = `${SCHEMA}
CREATE TABLE wa_external_terminals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  pair_code TEXT NOT NULL,
  key_prefix TEXT,
  secret_hash TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  last_remote_addr TEXT,
  last_seen_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  approved_at TEXT,
  revoked_at TEXT,
  delivered_at TEXT,
  grant_expires_at TEXT
);
CREATE TABLE wa_audit_events (
  id TEXT PRIMARY KEY, actor_kind TEXT NOT NULL DEFAULT '', actor_ref TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL, target_type TEXT NOT NULL DEFAULT '', target_id TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
);
`;
    const cDb = (): DatabaseSync => {
      const d = new DatabaseSync(':memory:');
      d.exec(C_SCHEMA);
      d.prepare("INSERT INTO wa_projects (id, name, context_json) VALUES ('p-1', '派单项目', '{}')").run();
      return d;
    };
    const ctxOf = (d: DatabaseSync, id: string): Record<string, unknown> => {
      const row = d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json?: string } | undefined;
      try { return JSON.parse(row?.context_json || '{}') as Record<string, unknown>; } catch { return {}; }
    };
    const statusOf = (d: DatabaseSync, id: string): string =>
      (d.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;
    const cTask = (d: DatabaseSync, id = 't-1', ctx: Record<string, unknown> = {}) =>
      d.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, 'p-1', '实现登录模块', 'pending', ?)")
        .run(id, JSON.stringify({ archetype: 'code', ...ctx }));
    const cEnrolled = (d: DatabaseSync) => {
      const put = d.prepare('INSERT OR REPLACE INTO wa_settings (key, value) VALUES (?, ?)');
      put.run('node.id', 'self-node');
      put.run('node.resource_group', 'node:self-node');
      put.run('ans_api_key', 'real-key-0123456789abcdef');
      put.run('node.role', 'primary');
    };
    const peerNode = (over: Partial<AnsNode> = {}): AnsNode => ({
      node_id: 'peer-1', name: '对端一', api_key_prefix: 'abcd1234',
      resource_group: 'node:peer-1', platform: 'darwin/arm64', role: 'primary', weight: 1,
      participate: true, capabilities: [], card: { categories: ['code'] }, status: null,
      enrolled_at: '2026-10-18 00:00:00', last_seen_at: '2026-10-18 00:00:00',
      ...over,
    });
    const cFacts = (over: Partial<CreateDispatchFacts> = {}): CreateDispatchFacts => ({
      settingOn: true, teamUnlocked: true, enrolled: true,
      hasParent: false, hasDependencies: false, hasAttachments: false,
      hasWorkingDir: false, decomposed: false, category: 'code',
      ...over,
    });
    const ansReply = (over: Partial<AnsNodeRequest> = {}): AnsNodeRequest => ({
      id: 'req-1', category: 'code', payload: {},
      requester_key_prefix: '', requester_node_id: null, target_node_id: 'peer-1',
      status: 'pending', result: null, question: null, question_status: null,
      answer: null, created_at: '', updated_at: '', ...over,
    } as unknown as AnsNodeRequest);

    const T0 = Date.parse('2026-10-18T00:00:00.000Z');
    const at = (offMs: number): string => new Date(T0 + offMs).toISOString();

    // ── ① 占位判据的纯函数（注入 nowMs，不碰真实墙钟）────────────────────
    {
      const live = JSON.stringify({ dispatch_offered_at: at(0), sibling: 'keep' });
      const atTtl = JSON.stringify({ dispatch_offered_at: at(-REMOTE_OFFER_TTL_MS) });
      const stale = JSON.stringify({ dispatch_offered_at: at(-REMOTE_OFFER_TTL_MS - 1) });
      const future = JSON.stringify({ dispatch_offered_at: at(1) });
      const garbage = JSON.stringify({ dispatch_offered_at: 'not-a-date' });

      eq([isRemoteOffered(live, T0), isRemoteOffered(atTtl, T0)], [true, true],
        'C′-1 在途两侧内沿：刚写下（age=0）与恰满 TTL 都算在途');
      eq([isRemoteOffered(stale, T0), isRemoteOffered(future, T0), isRemoteOffered(garbage, T0), isRemoteOffered('{}', T0), isRemoteOffered(null, T0)],
        [false, false, false, false, false],
        'C′-2 ★反证五标本：过 TTL / 未来时刻（时钟回拨）/ 坏时刻 / 无键 / null 都**不**当在途');
      eq([hasRemoteOfferMark(stale), hasRemoteOfferMark(future), hasRemoteOfferMark(garbage), hasRemoteOfferMark('{}')],
        [true, true, true, false],
        'C′-3 键在场判定（不论寿数）——认领路据此分辨"该顺手清一记过期占位"');

      const assignedCtx = JSON.stringify({
        assigned_node_id: 'peer-1', assigned_request_id: 'req-1', assigned_at: at(0),
        dispatch_offered_at: at(0),
      });
      eq(remoteBlockOf(assignedCtx, T0), { kind: 'assigned' },
        'C′-4 ★三键优先于占位：两者同时在场 ⇒ 判"已派定"（占位清除失败也不放本地抢跑）');
      eq(remoteBlockOf(live, T0), { kind: 'offered' }, 'C′-4b 只有活占位 ⇒ 判"派单在途"');
      eq(remoteBlockOf(stale, T0), null, 'C′-4c 过期占位 ⇒ 不拦（否则一件任务被永久钉死）');
      eq([isRemoteBlocked(live, T0), isRemoteBlocked(stale, T0)], [true, false],
        'C′-4d 调度/认领共用的薄壳与判据本体同一结论');
    }

    // ── ② 占位的读-改-写（兄弟键不丢）与两向（0→1 / 1→0）──────────────────
    {
      const d = cDb(); cTask(d, 't-1', { user_note: 'keep-me' });
      eq(hasRemoteOfferMark(JSON.stringify(ctxOf(d, 't-1'))), false, 'C′-5 写前：占位键在场判定为假（正面断言的起点）');
      ok(markRemoteOffered(d as never, 't-1', at(0)), 'C′-5b 落占位返回真（写成功）');
      const afterMark = ctxOf(d, 't-1');
      eq(afterMark.dispatch_offered_at, at(0), 'C′-5c ★0→1：占位时刻如实落库（可注入，非墙钟）');
      eq([afterMark.archetype, afterMark.user_note], ['code', 'keep-me'],
        'C′-5d ★RMW 整份写回：兄弟键原样保留（不抹 archetype / 用户备注）');
      ok(!markRemoteOffered(d as never, 'missing-task', at(0)), 'C′-5e 任务不存在 ⇒ 如实回假（不假装写上）');

      ok(clearRemoteOffered(d as never, 't-1'), 'C′-6 撤占位返回真');
      const afterClear = ctxOf(d, 't-1');
      ok(!('dispatch_offered_at' in afterClear), 'C′-6b 1→0：键已删');
      eq([afterClear.archetype, afterClear.user_note], ['code', 'keep-me'], 'C′-6c 只删这一键、兄弟键不动');
      ok(clearRemoteOffered(d as never, 't-1'), 'C′-6d 幂等：本就没有 ⇒ 仍回真');

      ok(markRemoteAssigned(d as never, 't-1', { nodeId: 'peer-1', requestId: 'req-1' }, at(0)), 'C′-6e 记三键返回真');
      const assigned = ctxOf(d, 't-1');
      eq([assigned.assigned_node_id, assigned.assigned_request_id, assigned.assigned_at], ['peer-1', 'req-1', at(0)],
        'C′-6f ★三键齐备（node / request / at）');
      eq(remoteBlockOf(JSON.stringify(assigned), T0), { kind: 'assigned' }, 'C′-6g 判据认这单为"已派定"');
    }

    // ── ③ 两阶段：**提交那一刻**占位已可见；回包后三键齐备、占位清除 ─────────
    {
      const d = cDb(); cTask(d); cEnrolled(d);
      const seen: { ctx: Record<string, unknown> | null } = { ctx: null };
      let submitCount = 0;
      const io = {
        async submit() {
          submitCount += 1;
          seen.ctx = ctxOf(d, 't-1'); // 在"真提交"这一刻读库
          return ansReply();
        },
        async get() { throw new Error('fake-io: 自动外派不该读回'); },
        async answer() { throw new Error('fake-io: 自动外派不该作答'); },
      };
      const out = await dispatchCreatedTask(
        d as never,
        { id: 't-1', title: '实现登录模块' },
        cFacts(),
        { listLedger: async () => ({ nodes: [peerNode()], localNodeId: 'self-node' }), io, emit: () => {}, nowMs: T0 },
      );
      eq([out.attempted, out.ok, out.reason, out.nodeId], [true, true, '', 'peer-1'], 'C′-7 派单成功结局如实');
      eq(submitCount, 1, 'C′-7b 恰提交一单');
      eq(seen.ctx?.dispatch_offered_at, at(0),
        'C′-7c ★★**提交那一刻**占位已在库（0→1 发生在回包之前——补的正是"派过与没派过毫无区别"那段）');
      ok(!('assigned_request_id' in (seen.ctx ?? {})), 'C′-7d 提交时三键尚未写（回包前本就不知目标）');
      ok(!('dispatch_offered_at' in ctxOf(d, 't-1')), 'C′-7e 成功后占位清除（让位给三键）');
      const after = ctxOf(d, 't-1');
      eq([after.assigned_node_id, after.assigned_request_id], ['peer-1', 'req-1'], 'C′-7f 三键齐备');
      ok(typeof after.assigned_at === 'string' && String(after.assigned_at).length > 0, 'C′-7g 第三键非空');
      eq(after.archetype, 'code', 'C′-7h 兄弟键原样保留');
      eq(remoteBlockOf(JSON.stringify(after), T0), { kind: 'assigned' }, 'C′-7i 派定后判据一致');
    }

    // ── ④ 在途占位 ⇒ 不重复提交（建单重放/双击）─────────────────────────────
    {
      const d = cDb(); cTask(d); cEnrolled(d);
      markRemoteOffered(d as never, 't-1', at(0));
      let submits = 0;
      const out = await dispatchCreatedTask(d as never, { id: 't-1', title: '实现登录模块' }, cFacts(), {
        listLedger: async () => ({ nodes: [peerNode()], localNodeId: 'self-node' }),
        io: {
          async submit() { submits += 1; return ansReply(); },
          async get() { throw new Error('unused'); }, async answer() { throw new Error('unused'); },
        },
        emit: () => {}, nowMs: T0,
      });
      eq([out.attempted, out.ok, out.reason, submits], [false, false, 'dispatch-in-flight', 0],
        'C′-8 ★活占位在场 ⇒ 如实报"派单在途"且**零提交**（不给 ANS 落第二单）');
      eq(hasRemoteOfferMark(JSON.stringify(ctxOf(d, 't-1'))), true, 'C′-8b 原有占位不被这次重放清掉');
    }

    // ── ⑤ 失败反证：占位清除、本地可认领 ────────────────────────────────────
    {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-c-'));
      try {
        const d = cDb(); cTask(d); cEnrolled(d);
        const out = await dispatchCreatedTask(d as never, { id: 't-1', title: '实现登录模块' }, cFacts(), {
          listLedger: async () => ({ nodes: [peerNode()], localNodeId: 'self-node' }),
          io: {
            async submit() { throw new Error('ANS 502 bad gateway'); },
            async get() { throw new Error('unused'); }, async answer() { throw new Error('unused'); },
          },
          emit: () => {}, nowMs: T0,
        });
        eq([out.attempted, out.ok], [true, false], 'C′-9 提交抛错：attempted=true / ok=false（真提交过 ≠ 成功）');
        ok(out.reason.includes('502'), 'C′-9b 失败原因原样带出', out.reason);
        ok(!hasRemoteOfferMark(JSON.stringify(ctxOf(d, 't-1'))), 'C′-9c ★失败 ⇒ 占位清除（任务不被一记死占位钉住）');
        const claim = claimTaskForExecution(d as never, 't-1', dataDir, { nowMs: T0 });
        eq([claim.claimed, statusOf(d, 't-1')], [true, 'executing'],
          'C′-9d ★★反证：失败后本地可认领（占位真让开了，不只是"看起来清了"）');
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    }

    // ── ⑥ 认领让位：已派定 / 在途 / 过期与坏时刻（顺手清）────────────────────
    {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-c-'));
      try {
        // 已派定 ⇒ 拒绝
        {
          const d = cDb(); cTask(d);
          markRemoteAssigned(d as never, 't-1', { nodeId: 'peer-1', requestId: 'req-1' }, at(0));
          const r = claimTaskForExecution(d as never, 't-1', dataDir, { nowMs: T0 });
          eq([r.claimed, (r as { reason?: string }).reason, statusOf(d, 't-1')], [false, 'remote_assigned', 'pending'],
            'C′-10 ★已派定 ⇒ 认领拒绝且状态不动（本机不抢对端的活）');
        }
        // 活占位 ⇒ 拒绝，且占位不被这次拒绝清掉
        {
          const d = cDb(); cTask(d);
          markRemoteOffered(d as never, 't-1', at(0));
          const r = claimTaskForExecution(d as never, 't-1', dataDir, { nowMs: T0 });
          eq([r.claimed, (r as { reason?: string }).reason, statusOf(d, 't-1')], [false, 'remote_offered', 'pending'],
            'C′-11 ★在途占位 ⇒ 认领拒绝（回包前那一小段不双跑）');
          eq(hasRemoteOfferMark(JSON.stringify(ctxOf(d, 't-1'))), true, 'C′-11b 活占位原样留着（等 ANS 回包，不是"见到就清"）');
        }
        // 过期占位 ⇒ 放行并顺手清
        {
          const d = cDb(); cTask(d);
          markRemoteOffered(d as never, 't-1', at(-REMOTE_OFFER_TTL_MS - 1));
          const r = claimTaskForExecution(d as never, 't-1', dataDir, { nowMs: T0 });
          eq([r.claimed, statusOf(d, 't-1')], [true, 'executing'], 'C′-12 ★过期占位 ⇒ 认领放行（崩溃留下的死占位不永久钉住）');
          ok(!hasRemoteOfferMark(JSON.stringify(ctxOf(d, 't-1'))), 'C′-12b 过期占位被**顺手清掉**（库不积死键）');
        }
        // 未来时刻（时钟回拨）/ 坏时刻 ⇒ 同样按过期处置
        {
          for (const [label, raw] of [['未来时刻', at(120_000)], ['坏时刻', 'not-a-date']] as const) {
            const d = cDb(); cTask(d);
            markRemoteOffered(d as never, 't-1', raw);
            const r = claimTaskForExecution(d as never, 't-1', dataDir, { nowMs: T0 });
            eq([r.claimed, hasRemoteOfferMark(JSON.stringify(ctxOf(d, 't-1')))], [true, false],
              `C′-12c 占位为「${label}」⇒ 当作没派成：放行且清键`);
          }
        }
        // 手动清掉 ⇒ 放行（清点与判据同一把尺）
        {
          const d = cDb(); cTask(d);
          markRemoteOffered(d as never, 't-1', at(0));
          clearRemoteOffered(d as never, 't-1');
          const r = claimTaskForExecution(d as never, 't-1', dataDir, { nowMs: T0 });
          eq(r.claimed, true, 'C′-13 占位已清 ⇒ 认领放行');
        }
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    }

    // ── ⑦ 静态接线：调度器与认领路读**同一处**判据 ─────────────────────────
    {
      const sch = noComment(`${A}/src/main/core/task-scheduler.ts`);
      eq(countOf(sch, 'isRemoteBlocked('), 1, 'C′-14 调度器就绪面恰读一处 `isRemoteBlocked`（不另写"只看三键"的旧判据）');
      eq(countOf(sch, 'isRemoteAssigned('), 0, 'C′-14b ★反证：调度器内 `isRemoteAssigned(` 零命中（让位面已扩到占位）');
      ok(/import\s*\{[^}]*isRemoteBlocked[^}]*\}\s*from\s*'\.\/node-orchestrate\.js'/.test(sch),
        'C′-14c 判据从 `node-orchestrate` **直 import**（真源一处）');
      ok(sch.includes('getReadyTasks(projectId: string)'),
        'C′-14d 就绪面签名未变（既有调用方/回归锚点不受影响）');

      const ec = noComment(`${A}/src/main/core/exec-claim.ts`);
      ok(ec.includes('isRemoteOffered(') && ec.includes('isRemoteAssigned(') && ec.includes('hasRemoteOfferMark(') && ec.includes('clearRemoteOffered('),
        'C′-15 认领路读同一组判据（在途 / 已派定 / 键在场 / 撤占位）');
      ok(ec.indexOf('isRemoteOffered(') < ec.indexOf('hasRemoteOfferMark('),
        'C′-15b ★次序：先判"活占位就拒绝"，**再**清过期占位（活着的不许被顺手清掉）');
    }

    // ── ⑧ 配对码：CSPRNG + 6 位补零；同地址待批上限如实拒绝 ──────────────────
    {
      const et = noComment(`${A}/src/main/core/external-terminals.ts`);
      eq(countOf(et, 'Math.random'), 0, 'C′-16 ★静态：`external-terminals.ts` 内 `Math.random` 零命中（短码是审批核对因子，不可预测）');
      ok(et.includes('randomInt(0, 1_000_000)') && et.includes("padStart(6, '0')"),
        'C′-16b 短码走 `crypto.randomInt` 且补零到 6 位（`000123` 也是合法短码）');
      ok(/import\s*\{[^}]*randomInt[^}]*\}\s*from\s*'node:crypto'/.test(et), 'C′-16c `randomInt` 从 `node:crypto` 直 import');

      const codes = Array.from({ length: 200 }, () => generatePairCode());
      ok(codes.every((c) => /^\d{6}$/.test(c)), 'C′-17 200 次抽取恒为 6 位十进制（前导零不丢位）', codes.slice(0, 3).join(','));
      ok(new Set(codes).size >= 2, 'C′-17b 200 次抽取不止一个值（不是常量占位）', `${new Set(codes).size} 个不同值`);

      const d = cDb();
      const port = createPairingPort(d as never);
      const ADDR = '10.0.0.9';
      const accepted = Array.from({ length: MAX_PENDING_PAIRS_PER_ADDR }, (_, i) => port.requestPair(`终端${i}`, ADDR));
      ok(accepted.every((r) => r.ok), `C′-18 同一地址前 ${MAX_PENDING_PAIRS_PER_ADDR} 张如实建出（上限如实）`);
      ok(accepted.every((r) => r.ok && /^\d{6}$/.test(r.pairCode)), 'C′-18b 建出的短码都是 6 位');
      const rejected = port.requestPair('再来一张', ADDR);
      eq(rejected, { ok: false, reason: 'too_many_pending' }, 'C′-19 ★再来一张如实拒：`too_many_pending`（不假装建了一张）');
      eq((d.prepare("SELECT COUNT(*) AS c FROM wa_external_terminals WHERE status = 'pending' AND last_remote_addr = ?").get(ADDR) as { c: number }).c,
        MAX_PENDING_PAIRS_PER_ADDR, 'C′-19b 被拒的申请**没有副作用**：待批行数仍等于上限');

      const first = accepted[0]!;
      d.prepare("UPDATE wa_external_terminals SET status = 'approved' WHERE id = ?").run(first.ok ? first.pairingId : '');
      const afterApprove = port.requestPair('批后重来', ADDR);
      eq(afterApprove.ok, true, 'C′-19c 已批准的不再占额度（只数 `pending`——拒绝/批准过的人可以再来）');

      const other = port.requestPair('另一台', '10.0.0.10');
      eq(other.ok, true, 'C′-19d 另一地址不受影响（上限按地址计，不是全局）');

      const noAddr = [1, 2, 3, 4].map((i) => port.requestPair(`离线构造${i}`));
      ok(noAddr.every((r) => r.ok), 'C′-19e 不带地址（离线/回归构造）不设限——只拦带地址的真实门外申请');
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n【D′】批四「度」：系统提示预算 / 请求侧上下文门槛 / 机器并发上限');
  // ═══════════════════════════════════════════════════════════════════
  {
    // D′ 自用的最小夹具（比 C′ 少外部门禁/审计两张表——认领闸只读任务/项目/设置）。
    const cDb = (): DatabaseSync => {
      const d = new DatabaseSync(':memory:');
      d.exec(SCHEMA);
      d.prepare("INSERT INTO wa_projects (id, name, context_json) VALUES ('p-1', '派单项目', '{}')").run();
      return d;
    };
    const cTask = (d: DatabaseSync, id = 't-1', ctx: Record<string, unknown> = {}) =>
      d.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, 'p-1', '实现登录模块', 'pending', ?)")
        .run(id, JSON.stringify({ archetype: 'code', ...ctx }));
    const statusOf = (d: DatabaseSync, id: string): string =>
      (d.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;
    const T0 = Date.parse('2026-10-18T00:00:00.000Z');

    // ── ① 巨型历史夹具下的系统提示截断：关键注入全在场、低优先级先走 ────────
    const sysMsg = (name: string, chars: number) => ({
      role: 'system',
      content: `[${name}]` + 'x'.repeat(chars - name.length - 2),
    });
    const TAIL_TAGS = ['验收标准', '需求卡', '需求确认', '上游要求'];
    const makeCtxFixture = (memoryChars: number) => {
      const stableKeys = ['system_prompt', 'tool_brief', 'user_prefs', 'project_stable', 'sandbox'];
      const optional: Array<[string, number]> = [
        ['autonomy', 8_000], ['tension', 8_000], ['memory', memoryChars], ['success', 8_000],
        ['lessons', 40_000], ['budget', 8_000], ['guidance', 20_000], ['planning', 20_000],
        ['task_line', 8_000], ['current_date', 8_000],
      ];
      const messages: Array<{ role: string; content: string }> = [
        ...stableKeys.map((k) => sysMsg(k, 8_000)),
        ...optional.map(([k, c]) => sysMsg(k, c)),
      ];
      const historyStart = messages.length;
      messages.push({ role: 'user', content: '[history-user] 继续之前的工作' });
      messages.push({ role: 'assistant', content: '[history-assistant] 好的，我接着做' });
      messages.push({ role: 'user', content: '[history-user-2] 继续' });
      messages.push(sysMsg('验收标准', 8_000), sysMsg('需求卡', 8_000), sysMsg('需求确认', 4_000), sysMsg('上游要求', 8_000));
      const tokens = messages
        .filter((m) => m.role === 'system')
        .reduce((a, m) => a + estimateContentTokens(m.content), 0);
      return { messages, historyStart, tokens };
    };
    const tagOf = (c: unknown) => String(c).slice(1, String(c).indexOf(']'));

    // 标本 A：超预算 2K ⇒ **只**删最末尾一块（current_date）。
    {
      const fx = makeCtxFixture(68_000);
      const plan = planSystemContextCompaction(fx.messages, {
        budgetTokens: 64_000, optionalStart: 5, optionalEnd: fx.historyStart,
      });
      eq([fx.tokens, plan.beforeTokens], [66_000, 66_000],
        'D′-1a 测量面 = **所有** system 消息（含历史后追加的关键注入，不再只数连续前缀）');
      eq([plan.removed, plan.afterTokens, plan.overBudgetAfterTrim], [1, 64_000, false],
        'D′-1b ★小超支 ⇒ 只删最低优先级的最后一块，恰好压回 64K 内');
      eq(fx.messages.slice(plan.dropStart, plan.dropEnd).map((m) => tagOf(m.content)), ['current_date'],
        'D′-1c 先走的是 current_date（尾部最不痛）');
      const spliced = [...fx.messages];
      spliced.splice(plan.dropStart, plan.removed);
      const texts = spliced.map((m) => String(m.content));
      ok(TAIL_TAGS.every((t) => texts.some((c) => c.startsWith(`[${t}]`))),
        'D′-1d ★验收标准 / 需求卡 / 需求确认 / 上游要求**全部在场**');
      ok(texts.some((c) => c.startsWith('[memory]')), 'D′-1e 记忆层未被误删（只动尾部低优先级层）');
      eq(spliced.length, fx.messages.length - 1, 'D′-1f 只删 1 条（历史与关键注入一条不少）');
    }

    // 标本 B：超预算 5K ⇒ 依次删 current_date / task_line / planning；memory 与 guidance 仍在。
    {
      const fx = makeCtxFixture(80_000);
      const plan = planSystemContextCompaction(fx.messages, {
        budgetTokens: 64_000, optionalStart: 5, optionalEnd: fx.historyStart,
      });
      eq([fx.tokens, plan.removed, plan.afterTokens], [69_000, 3, 60_000],
        'D′-1g ★标本 B：删 3 块后落到 60K（删够即停，不追求"删到刚好"）');
      eq(fx.messages.slice(plan.dropStart, plan.dropEnd).map((m) => tagOf(m.content)),
        ['planning', 'task_line', 'current_date'],
        'D′-1h ★删除次序 = 低优先级在前（guidance 比 planning 更该留）');
      const spliced = [...fx.messages];
      spliced.splice(plan.dropStart, plan.removed);
      const texts = spliced.map((m) => String(m.content));
      ok(TAIL_TAGS.every((t) => texts.some((c) => c.startsWith(`[${t}]`))), 'D′-1i 关键注入仍全部在场');
      ok(['memory', 'lessons', 'success', 'guidance', 'budget', 'tension', 'autonomy']
        .every((t) => texts.some((c) => c.startsWith(`[${t}]`))),
        'D′-1j ★高优先级可删层一块未动（memory/lessons/success/guidance 都在）');
      ok(['planning', 'task_line', 'current_date'].every((t) => !texts.some((c) => c.startsWith(`[${t}]`))),
        'D′-1k 被删的三块确已不在');
    }

    // 截断在**关键注入之后**才发生（否则预算按残缺集合算），且删后索引回填。
    {
      const exec = noComment(`${A}/src/main/core/agent-executor.ts`);
      const iUp = exec.indexOf('buildUpstreamRequirementBlock(db, task)');
      const iCard = exec.indexOf('buildRequirementCard(db, taskId');
      const iPlan = exec.indexOf('planSystemContextCompaction(messages,');
      ok(iUp > 0 && iCard > 0 && iPlan > 0 && iPlan > iUp && iPlan > iCard,
        'D′-1l ★截断调用在验收/需求卡/上游注入之后（测量面才看得见它们）',
        `upstream=${iUp} card=${iCard} plan=${iPlan}`);
      ok(exec.includes('optionalEnd: historyRange.start') && exec.includes('optionalStart: Math.max(3, stablePrefixEnd)'),
        'D′-1m 可删区间止于历史段起点（历史与关键注入天然不在可删面内）');
      eq([
        countOf(exec, 'messages.splice(compactPlan.dropStart, compactPlan.removed)'),
        countOf(exec, 'historyRange.start -= compactPlan.removed'),
        countOf(exec, 'historyRange.end -= compactPlan.removed'),
      ], [1, 1, 1], 'D′-1n 删后区间索引回填（否则历史预算裁剪会错位）');
    }

    // ── ② 选型请求：任务体量 ⇒ 请求侧最小上下文窗口 ───────────────────────
    {
      const base = { archetype: 'code' as const, strategy: 'balanced' };
      const absent = buildModelRequest(base);
      ok(!Object.prototype.hasOwnProperty.call(absent, 'minContextWindow'),
        'D′-2a ★未给体量 ⇒ 键**不出现**（旧调用面逐字不变）');
      eq(buildModelRequest({ ...base, taskChars: 0 }).minContextWindow, MIN_CONTEXT_WINDOW_BASE_TOKENS,
        'D′-2b 体量 0 ⇒ 能力基线 32K');
      eq(buildModelRequest({ ...base, taskChars: 112_000 }).minContextWindow, 60_000,
        'D′-2c 112K 字 ≈ 28K token ⇒ 32K+28K=60K');
      eq([deriveMinContextWindow(0), deriveMinContextWindow(895_996), deriveMinContextWindow(896_000)],
        [
          { minContextWindow: 32_000, capped: false },
          { minContextWindow: 255_999, capped: false },
          { minContextWindow: MIN_CONTEXT_WINDOW_MAX_TOKENS, capped: true },
        ],
        'D′-2d 封顶边界：255,999 不封顶 / 恰 256K 封顶');
      ok(!Object.prototype.hasOwnProperty.call(buildModelRequest({ ...base, taskChars: Number.NaN }), 'minContextWindow'),
        'D′-2e 非有限数按"未给"办（不写编出来的值）');
      eq(taskBodyChars({ title: 'abc', description: 'de', acceptance: 'f' }), 6,
        'D′-2f 标题/描述/验收按字面累加');
      eq(taskBodyChars({ attachments: [{ fileName: 'report.pdf', sizeBytes: 50_000 }] }), 50_000,
        'D′-2g 文档族有真 sizeBytes ⇒ 用真值');
      eq(taskBodyChars({ attachments: [{ fileName: 'report.pdf', sizeBytes: -1 }] }), 12_000,
        'D′-2h 非法 sizeBytes ⇒ 退回文档族经验值');
      eq(taskBodyChars({ attachments: [{ fileName: 'photo.png' }, { fileName: 'clip.mp4' }, { fileName: 'a.mp3' }] }),
        4_400 + 35_200 + 20_000,
        'D′-2i 图/视频/音频按族折算（穷举表，不是"猜一个数"）');
    }

    // ── ③ 上下文门槛取严：能力下限 vs 请求侧体量 ─────────────────────────
    {
      eq([capabilityContextFloor(['function-calling']), capabilityContextFloor(['chat']), capabilityContextFloor(['__none__'])],
        [32_000, 4_000, 0],
        'D′-3a 能力门槛真读 `MODEL_CAPABILITY_META`（function-calling ⇒ 32K / chat ⇒ 4K / 未在册不贡献）');
      eq([
        effectiveContextFloor(['function-calling']),
        effectiveContextFloor(['function-calling'], 60_000),
        effectiveContextFloor(['function-calling'], 40_000),
        effectiveContextFloor(['chat'], 60_000),
      ], [32_000, 60_000, 40_000, 60_000],
        'D′-3b ★取严：能力下限与请求门槛取 max（两侧各有主导标本）');
      eq([0, -5, Number.NaN, Number.POSITIVE_INFINITY].map((v) => effectiveContextFloor(['chat'], v)),
        [4_000, 4_000, 4_000, 4_000],
        'D′-3c 非法/非正请求门槛 ⇒ 不额外设闸，仍取能力下限（不把"没配"读成"要 0 窗口"）');
      eq(effectiveContextFloor(['__none__'], 0), 0, 'D′-3c2 能力也没门槛时，门槛确为 0（整体不设闸）');

      const matcher = noComment('apps/ans-server/src/services/resource-matcher.ts');
      eq(countOf(matcher, 'effectiveContextFloor(capabilities, req.minContextWindow)'), 2,
        'D′-3d 主查询与诊断漏斗**同一把尺**（恰两处调用，末步才与主查询同值）');
      eq(countOf(matcher, 'COALESCE(m.context_window, 0) >= ?'), 2, 'D′-3e 两条 SQL 门槛同形');

      // 完整 SQL 路径（32K 被筛 / 64K 入选）在 ANS vitest——那些用例穿过 `matchOptimalModel` 的真 SQL。
      const t = RD('apps/ans-server/src/__tests__/resource-matcher.test.ts');
      ok(t.includes('minContextWindow: 60000') && t.includes("toBe('mForBigTask')") && t.includes("not.toBe('mAtCapability')"),
        'D′-3f ANS 侧有两只标本的整路用例（32K 被筛掉 / 64K 入选）');
      ok(t.includes("step === 'context ≥ 60000'"), 'D′-3g 零命中漏斗点名请求门槛那一步');
    }

    // ── ④ 机器闸：整机占位（上限 2、已有 2 在跑）──────────────────────────
    {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-d-'));
      try {
        const putSetting = (d: DatabaseSync, key: string, value: string) =>
          d.prepare('INSERT OR REPLACE INTO wa_settings (key, value) VALUES (?, ?)').run(key, value);

        // 主标本：2 在跑 + 1 待跑 ⇒ 第三个认领被机器闸拒。
        {
          const d = cDb();
          putSetting(d, MACHINE_CONCURRENCY_SETTING_KEY, '2');
          cTask(d, 't-run1'); cTask(d, 't-run2'); cTask(d, 't-3');
          d.prepare("UPDATE wa_tasks SET status = 'executing' WHERE id IN ('t-run1','t-run2')").run();
          const r = claimTaskForExecution(d as never, 't-3', dataDir, { nowMs: T0, cpus: 8 });
          eq([r.claimed, (r as { reason?: string }).reason, statusOf(d, 't-3')],
            [false, 'machine_concurrency_full', 'pending'],
            'D′-4a ★上限 2、已有 2 在跑 ⇒ 第三个认领回 `machine_concurrency_full`，任务退回待跑');
          eq([statusOf(d, 't-run1'), statusOf(d, 't-run2')], ['executing', 'executing'],
            'D′-4b ★在跑的两件不被打断（闸只挡新认领，不踢已占位的）');
          eq(countMachineRunning(d as never), 2, 'D′-4c 机器在跑数 = 2（计数口径真读状态）');

          // 正面断言（计数器 0→1）：腾出一格 ⇒ 同一件任务认领成功。
          d.prepare("UPDATE wa_tasks SET status = 'completed' WHERE id = 't-run1'").run();
          const r2 = claimTaskForExecution(d as never, 't-3', dataDir, { nowMs: T0, cpus: 8 });
          eq([r2.claimed, statusOf(d, 't-3')], [true, 'executing'],
            'D′-4d ★腾出一格 ⇒ 认领成功（不是"怎么认都认不上"的假闸）');
          eq(countMachineRunning(d as never), 2, 'D′-4e 认领后机器在跑数 = 2（满额，未越界）');
        }

        // 归因次序：项目闸与机器闸同时满 ⇒ **机器优先**（否则"整机满"会被说成"本项目满"）。
        {
          const d = cDb();
          putSetting(d, MACHINE_CONCURRENCY_SETTING_KEY, '2');
          cTask(d, 'r1'); cTask(d, 'r2'); cTask(d, 'r3'); cTask(d, 't-4');
          d.prepare("UPDATE wa_tasks SET status = 'executing' WHERE id IN ('r1','r2','r3')").run();
          const r = claimTaskForExecution(d as never, 't-4', dataDir, { nowMs: T0, cpus: 8 });
          eq([r.claimed, (r as { reason?: string }).reason], [false, 'machine_concurrency_full'],
            'D′-4f 两闸同满 ⇒ 归因机器（社区档项目上限 3 > 机器上限 2）');
        }
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    }

    // ── ⑤ 缺省值：按核数派生 + 非法设置退回派生值 ─────────────────────────
    {
      eq([deriveMachineConcurrency(4), deriveMachineConcurrency(1), deriveMachineConcurrency(2), deriveMachineConcurrency(16)],
        [3, 2, 2, 8],
        'D′-5a ★cpus=4 ⇒ 3 / cpus=1 ⇒ 2 / 下限 2 / 上限 8（注入核数，不读真机）');
      eq([MACHINE_CONCURRENCY_MIN, MACHINE_CONCURRENCY_MAX], [2, 8], 'D′-5b 上下界常量在册');

      const d = cDb();
      eq([resolveMachineConcurrencyLimit(d as never, { cpus: 4 }).limit, resolveMachineConcurrencyLimit(d as never, { cpus: 1 }).limit],
        [3, 2], 'D′-5c 无设置 ⇒ 按注入核数派生');
      ok(resolveMachineConcurrencyLimit(d as never, { cpus: 4 }).source === 'derived', 'D′-5d 来源如实标 `derived`');

      for (const bad of ['abc', '0', '-3', '1.5x']) {
        d.prepare('INSERT OR REPLACE INTO wa_settings (key, value) VALUES (?, ?)').run(MACHINE_CONCURRENCY_SETTING_KEY, bad);
        const r = resolveMachineConcurrencyLimit(d as never, { cpus: 4 });
        eq([r.limit, r.derived, r.invalid, r.source], [3, 3, true, 'derived'],
          `D′-5e ★非法设置「${bad}」⇒ 退回派生值并标记 invalid`);
      }
      eq(parseMachineConcurrencySetting('  ', 4), { limit: 3, derived: 3, raw: null, source: 'derived', invalid: false },
        'D′-5f 空白设置 ⇒ 未配置（不是非法值）');

      d.prepare('INSERT OR REPLACE INTO wa_settings (key, value) VALUES (?, ?)').run(MACHINE_CONCURRENCY_SETTING_KEY, '6');
      eq(resolveMachineConcurrencyLimit(d as never, { cpus: 4 }).limit, 6, 'D′-5g 合法设置覆盖派生值');

      const ta = noComment(`${A}/src/main/core/task-accounting.ts`);
      ok(ta.includes('if (res.invalid)') && ta.includes('机器并发上限配置非法→退回CPU派生值'),
        'D′-5h 非法分支**记日志**（不是悄悄吞掉）');
      eq(countOf(RD(`${A}/src/main/core/settings-keys.ts`), "'machine_max_concurrency'"), 1,
        'D′-5i 设置键字面量**一处真源**（引擎读口与设置页写口同引）');
    }

    // ── ⑥ GUI：设置页数字输入真写入 `machine_max_concurrency` ─────────────
    {
      const sp = RD(`${A}/renderer/src/pages/SettingsPage.tsx`);
      ok(sp.includes("from '../../../src/main/core/settings-keys.js'"),
        'D′-6a 设置页引**同一处**设置键（不手抄字面量）');
      ok(/type="number"/.test(sp) && sp.includes('machineMaxConcurrency'),
        'D′-6b 有数字输入（type="number"）与受控状态');
      ok(sp.includes('commitMachineMaxConcurrency') &&
        sp.includes("invoke('settings:set', MACHINE_CONCURRENCY_SETTING_KEY"),
        'D′-6c 失焦提交写 `machine_max_concurrency`（不是只显示不保存）');

      // 产物（minify 后标识符可能被压缩，用户可见中文串与设置键字面量仍在）。
      const assetsDir = path.join(root, A, 'renderer/dist/assets');
      const chunk = fs.existsSync(assetsDir)
        ? fs.readdirSync(assetsDir).filter((f) => /^SettingsPage-.*\.js$/.test(f)) : [];
      ok(chunk.length === 1, 'D′-6d renderer 产物含 SettingsPage 独立 chunk', chunk.join(',') || '缺失（须先跑 renderer build）');
      if (chunk.length === 1) {
        const c = fs.readFileSync(path.join(assetsDir, chunk[0]!), 'utf-8');
        ok(c.includes(MACHINE_CONCURRENCY_SETTING_KEY) && c.includes('机器并发'),
          'D′-6e ★产物里**确有**设置键与「机器并发」卡片（不是只改了源码）');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n【E】事件在场 · 列表真分页 · 统计一次聚合（显）');
  // ═══════════════════════════════════════════════════════════════════
  {
    // ── ① 统计：一条 GROUP BY（真源函数 × 真行；缺键=真零，不是失败被写成 0）──
    const insStat = (id: string, pid: string, status: string) =>
      db.prepare('INSERT INTO wa_tasks (id, project_id, title, status) VALUES (?,?,?,?)').run(id, pid, id, status);
    insProject('p-stats-a', '统计甲');
    insProject('p-stats-b', '统计乙');
    insProject('p-stats-empty', '零任务项目');
    insStat('s-a1', 'p-stats-a', 'completed');
    insStat('s-a2', 'p-stats-a', 'pending');
    insStat('s-a3', 'p-stats-a', 'failed');
    insStat('s-b1', 'p-stats-b', 'completed');

    const stats = taskStatsByProject(db as never);
    eq(stats['p-stats-a'], { total: 3, completed: 1 }, 'E-1a 一次聚合出项目统计（3 任务 / 1 完成）');
    eq(stats['p-stats-b'], { total: 1, completed: 1 }, 'E-1b 另一项目同样出数');
    ok(!('p-stats-empty' in stats), 'E-1c 零任务项目**不在分组里**（缺键=真零，不是"取数失败被写成 0"）');

    const pe = noComment(`${A}/src/main/core/project-engine.ts`);
    const fnStart = pe.indexOf('export function taskStatsByProject');
    const fnEnd = pe.indexOf('export class ProjectEngine', fnStart);
    const statsFn = fnStart >= 0 && fnEnd > fnStart ? pe.slice(fnStart, fnEnd) : '';
    ok(statsFn.length > 0, 'E-1d 统计真源函数在场（直 import 的同一个）');
    eq(countOf(statsFn, 'GROUP BY'), 1, 'E-1e ★全部项目统计**一条** `GROUP BY`（不是每项目一条 COUNT）');

    const ipc = noComment(`${A}/src/main/ipc/project.ipc.ts`);
    ok(/ipcMain\.handle\('projects:stats'/.test(ipc) && countOf(ipc, 'taskStatsByProject(db)') === 1,
      'E-1f IPC `projects:stats` 注册，且只调同一真源（没有第二份实现）');

    // ── ② task:list 真分页：生产 SQL × 生产夹取函数 × 真行 ──
    // zx_20261019 缺陷 D1 判据：**优先级序与创建时间序刻意相反**——若次序第一键仍是 priority，
    //   第一页会是 pg-1/pg-2；改成 created_at 第一键后必须返回 pg-5/pg-4（最新在前）。
    for (let i = 0; i < 5; i++) {
      db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, priority, created_at) VALUES (?, 'p-page', ?, 'pending', ?, ?)")
        .run(`pg-${i + 1}`, `pg-${i + 1}`, 5 - i, `2026-10-19 00:00:0${i + 1}`);
    }
    const mList = ipc.match(/SELECT t\.\*,[\s\S]*?FROM wa_tasks t WHERE t\.project_id = \?[\s\S]*?\$\{page\.sql\}/);
    ok(!!mList, 'E-2a task:list 的生产 SQL 就地取出（含 `${page.sql}` 分页片段）');
    const pageRows = (lim: unknown, off: unknown) => {
      const p = resolvePage(lim, off); // 生产函数 × 生产入参
      const sql = mList![0].replace('${page.sql}', p.sql);
      return (db.prepare(sql).all('p-page', ...p.params) as Array<{ id: string }>).map((r) => r.id);
    };
    eq(pageRows(2, 0), ['pg-5', 'pg-4'], 'E-2b 第一页 2 条（按创建时间降序——最新在前，优先级不决定分页成员资格）');
    eq(pageRows(2, 2), ['pg-3', 'pg-2'], 'E-2c 第二页续上且不重叠');
    eq(pageRows(2, 4), ['pg-1'], 'E-2d 末页只剩 1 条');
    eq([...pageRows(2, 0), ...pageRows(2, 2), ...pageRows(2, 4)], ['pg-5', 'pg-4', 'pg-3', 'pg-2', 'pg-1'],
      'E-2e ★三页合起来不重不漏');
    eq(resolvePage(undefined, undefined).limit, 100, 'E-2f ★缺省上限生效（未传 limit ⇒ 100，不是全表）');
    eq(resolvePage(5000, 0).limit, 500, 'E-2g 超上限请求被夹回 500');
    ok(/const total = \(db\.prepare\('SELECT COUNT\(\*\) AS c FROM wa_tasks WHERE project_id = \?'\)\.get\(projectId\)/.test(ipc) &&
      /return \{ data: \{ rows, total:/.test(ipc),
      'E-2h 返回体带 `total`，且 total 与明细同一 `project_id` 条件（全量口径，不随页变）');
    ok(/ORDER BY t\.created_at DESC, t\.priority DESC, t\.rowid DESC\$\{page\.sql\}/.test(ipc),
      'E-2i 稳定次序（创建时间第一键、rowid 兜同秒行），分页片段在 ORDER BY 之后');
    ok(ipc.includes("const treeRows = db.prepare('SELECT id, parent_task_id FROM wa_tasks WHERE project_id = ?')") &&
      ipc.includes('const taskIds = treeRows.map((r) => String(r.id));') &&
      /for \(const r of treeRows\)/.test(ipc),
      'E-2j ★上卷依据=全项目轻量树（分页只裁明细，不裁子树计数——翻页不会把计数翻少）');

    // ── ③ Projects 页：零 N+1、失败如实 ──
    const pp = noComment(`${A}/renderer/src/pages/ProjectsPage.tsx`);
    eq(countOf(pp, 'tasks.list('), 0, 'E-3a ★Projects 页零 `tasks.list(`（N+1 已除）');
    ok(pp.includes("'projects:stats'") && pp.includes('taskStatsUnavailable'),
      'E-3b 统计走 `projects:stats` 一次调用，失败标记独立于项目列表');
    ok(pp.includes('统计不可用'), 'E-3c 取数失败 ⇒ 界面写"统计不可用"');
    eq(/taskStats\s*=\s*\{\s*total:\s*0/.test(pp), false, 'E-3d ★不再把失败写成 `taskStats = { total: 0 }`（假零）');

    const assetsDir = path.join(root, A, 'renderer/dist/assets');
    const pchunks = fs.existsSync(assetsDir)
      ? fs.readdirSync(assetsDir).filter((f) => /^ProjectsPage-.*\.js$/.test(f)) : [];
    ok(pchunks.length === 1, 'E-3e renderer 产物含 ProjectsPage 独立 chunk', pchunks.join(',') || '缺失（须先跑 renderer build）');
    if (pchunks.length === 1) {
      const c = fs.readFileSync(path.join(assetsDir, pchunks[0]!), 'utf-8');
      ok(c.includes('projects:stats') && c.includes('统计不可用'),
        'E-3f ★产物里确有统计通道与"统计不可用"字样（不是只改了源码）');
    }

    // ── ④ 列表页分页：按页取 + 如实说已加载多少 ──
    const tp = noComment(`${A}/renderer/src/pages/TasksPage.tsx`);
    ok(tp.includes('tasksApi.list(selectedPid, { limit: PAGE_LIMIT, offset })') && tp.includes('tasksTotal'),
      'E-4a Tasks 页按页取（limit/offset）并持服务端 `total`');
    ok(tp.includes('已加载 ${allTasks.length}/${tasksTotal}') && tp.includes('loadTasks(true)'),
      'E-4b ★"已加载 K / 共 M"如实上屏，且未载部分有可达动作（加载更多）');
    ok(noComment(`${A}/renderer/src/pages/TaskDetailPage.tsx`).includes('tasks.listAll(taskData.task.project_id)'),
      'E-4c 详情页要全项目任务 ⇒ 走 `listAll`（按页取完，不在一次调用拉满）');
    const ipcLib = noComment(`${A}/renderer/src/lib/ipc.ts`);
    ok(ipcLib.includes("ipcCall<{ rows: Array<Record<string, unknown>>; total: number; limit: number; offset: number }>('task:list'") &&
      ipcLib.includes('listAll: async'),
      'E-4d 客户端 SDK 形状与 main 返回体一致（rows/total/limit/offset）');
    const dlvPage = noComment(`${A}/renderer/src/pages/DeliverablesPage.tsx`);
    ok(dlvPage.includes('tasksApi.listAll(cForm.projectId)') && !/tasksApi\.list\(cForm\.projectId\)/.test(dlvPage),
      'E-4e 成果页候选任务要全项目 ⇒ 走 `listAll`（`{rows,total}` 当数组 map 会恒空且被 catch 吞掉）');
    ok(/for \(let i = 0; i < 5; i\+\+\)[\s\S]{0,900}?missingParent/.test(tp) &&
      tp.includes('if (!missingParent || rows.length === 0 || offset >= total) break;'),
      'E-4f ★分页边界不切开父子树：页面内有子无父时，有界续取下一页直到父行补齐');

    // ── ⑤ 事件驱动：两页订阅（经全局 ActivityProvider 的那一跳），轮询保留作兜底 ──
    const an = noComment(`${A}/renderer/src/components/ActionNeeded.tsx`);
    const dash = noComment(`${A}/renderer/src/pages/DashboardPage.tsx`);
    const activity = noComment(`${A}/renderer/src/lib/activity.tsx`);
    const useTE = noComment(`${A}/renderer/src/hooks/useTaskEvents.ts`);
    ok(activity.includes('useTaskEvents(dispatch, true)') &&
      /const api = window\.electronAPI;[\s\S]*?api\.onTaskEvent\(/.test(useTE),
      'E-5a 全局 ActivityProvider 经 `useTaskEvents` 直连 `onTaskEvent`（两页共用的那一跳）');
    ok(an.includes('useActivity()') && /const unsubscribe = subscribe\(/.test(an) && an.includes('LIVE_TYPES.has(e.type)'),
      'E-5b ActionNeeded 订阅事件，且只在相关类型上刷新');
    ok(an.includes('15_000'), 'E-5c ★15s 轮询保留作兜底（事件是快路径，不是唯一路径）');
    ok(/const \{ subscribe \} = useActivity\(\)/.test(dash) && /return subscribe\(\(e\)/.test(dash),
      'E-5d Dashboard 订阅事件触发 loadAll');
    ok(dash.includes('30_000'), 'E-5e ★30s 轮询保留作兜底');
    ok(dash.includes('window.electronAPI.onTaskEvent'), 'E-5f Dashboard 心跳直连 onTaskEvent（瞬态事件不入 Activity 缓冲）');
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n【F′】批六「文」：Office 文本取真、长 PDF 页窗口有闸');
  // ═══════════════════════════════════════════════════════════════════
  {
    const XLSX_EXPECT = '【工作表 成绩】\n姓名\t数学\n张三 & 李四\t95';
    const PPTX_EXPECT = '【第 1 页】\nB 页内容\n\n【第 2 页】\n\n【第 3 页】\nA 页内容';

    // ── ① xlsx：sharedStrings + 两行，行序逐字对；坏 ZIP 如实 parse_error ──────────
    {
      const r = extractDocText(makeXlsx(), '.xlsx');
      ok(r.ok === true && r.text === XLSX_EXPECT,
        'F′-1a 合成 `.xlsx`（sharedStrings + 两行 + 实体）⇒ 单元格文本逐字正确、行序不乱（工作名来自 workbook.xml）',
        r.ok ? JSON.stringify(r.text) : `reason=${r.reason} detail=${r.detail ?? ''}`);

      const notZip = extractDocText(Buffer.from('definitely not a zip file at all'), '.xlsx');
      const noSheets = extractDocText(makeZip([{ name: 'word/document.xml', data: Buffer.from('<x/>') }]), '.xlsx');
      ok(notZip.ok === false && notZip.reason === 'parse_error'
        && noSheets.ok === false && noSheets.reason === 'parse_error',
        'F′-1b **该不命中**：坏 ZIP / 真 ZIP 但没有工作表 ⇒ 均如实 `parse_error`（不返回空正文充数）',
        `notZip=${notZip.ok ? 'ok' : notZip.reason} noSheets=${noSheets.ok ? 'ok' : noSheets.reason}`);
    }

    // ── ② pptx：按 sldIdLst 的页序分段（文件名序**刻意相反**），空白页保留页号 ──────────
    {
      const r = extractDocText(makePptx(), '.pptx');
      ok(r.ok === true && r.text === PPTX_EXPECT,
        'F′-2a 合成 `.pptx`（三页：B / 空白 / A）⇒ 按 `sldIdLst` 页序分段，页号连续、空白页仍留 `第 2 页`',
        r.ok ? JSON.stringify(r.text) : `reason=${r.reason} detail=${r.detail ?? ''}`);

      const notZip = extractDocText(Buffer.from('still not a zip, just words'), '.pptx');
      const noSlides = extractDocText(makeZip([{ name: 'ppt/notesMasters/notesMaster1.xml', data: Buffer.from('<n/>') }]), '.pptx');
      ok(notZip.ok === false && notZip.reason === 'parse_error'
        && noSlides.ok === false && noSlides.reason === 'parse_error',
        'F′-2b **该不命中**：坏 ZIP / 真 ZIP 但没有幻灯片 ⇒ 均如实 `parse_error`',
        `notZip=${notZip.ok ? 'ok' : notZip.reason} noSlides=${noSlides.ok ? 'ok' : noSlides.reason}`);
    }

    // ── ③ 判型与老 .doc：两侧标本（新格式进文档支，老 .doc 仍如实拒绝）──────────────
    {
      const yes = ['.xlsx', '.XLSX', '.pptx', '.PPTX'].every((e) => isDocTextExt(e));
      const no = ['.pdf', '.png', '.bin', '.exe'].every((e) => !isDocTextExt(e));
      ok(yes && no && familyOf('.xlsx') === 'document' && familyOf('.pptx') === 'document',
        'F′-3a **两侧标本**：`.xlsx/.pptx`（含大写）进文档支；`.pdf/.png/.bin/.exe` 不进——`.pdf` 必须判假，否则与 PDF 支争夺同一件',
        `yes=${yes} no=${no} fam(xlsx)=${familyOf('.xlsx')} fam(pptx)=${familyOf('.pptx')}`);
      const doc = extractDocText(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), '.doc');
      ok(doc.ok === false && doc.reason === 'doc_legacy_unsupported',
        'F′-3b 老 `.doc` 仍 `doc_legacy_unsupported`（不回归；新格式没有把老格式的如实拒绝吃掉）',
        doc.ok ? 'ok（不该）' : `reason=${doc.reason}`);
    }

    // ── ④ PDF 页窗口：抽取器的三态（社区缺省 / 窗口 / 越界）──────────────────────
    const pageTag = (i: number): string => `PAGE-${String(i).padStart(2, '0')}`;
    const N_PAGES = 30;
    const pdf30 = makePdf(Array.from({ length: N_PAGES }, (_, i) => pageStream([pageTag(i + 1)])));
    {
      const r = extractPdfText(pdf30);
      const body = r.ok ? r.text : '';
      ok(r.ok === true && r.pages === N_PAGES && r.firstPage === 1 && r.lastPage === PDF_MAX_PAGES
        && r.truncated === true
        && body.includes(pageTag(1)) && body.includes(pageTag(PDF_MAX_PAGES))
        && !body.includes(pageTag(PDF_MAX_PAGES + 1)),
        `F′-4a 社区缺省：${N_PAGES} 页 ⇒ 只读第 1-${PDF_MAX_PAGES} 页（第 ${PDF_MAX_PAGES + 1} 页的字**确实不在**），窗口如实 ${'firstPage=1/lastPage=' + PDF_MAX_PAGES}`,
        r.ok ? `pages=${r.pages} first=${r.firstPage} last=${r.lastPage} truncated=${r.truncated}` : `reason=${r.reason} ${r.detail ?? ''}`);

      const w = extractPdfText(pdf30, { startPage: 6, maxPages: 5 });
      const wBody = w.ok ? w.text : '';
      ok(w.ok === true && w.firstPage === 6 && w.lastPage === 10 && w.pages === N_PAGES
        && wBody.includes(pageTag(6)) && wBody.includes(pageTag(10))
        && !wBody.includes(pageTag(5)) && !wBody.includes(pageTag(11)),
        'F′-4b 窗口 `startPage=6,maxPages=5` ⇒ 恰第 6–10 页（前后各一页的字都不在），`pages` 仍报总页数',
        w.ok ? `first=${w.firstPage} last=${w.lastPage} pages=${w.pages}` : `reason=${w.reason}`);

      const oob = extractPdfText(pdf30, { startPage: N_PAGES + 1, maxPages: 2 });
      ok(oob.ok === false && oob.reason === 'page_out_of_range' && String(oob.detail).includes(String(N_PAGES)),
        'F′-4c 起页越界 ⇒ `page_out_of_range` + 真因（不静默退回第 1 页）',
        oob.ok ? 'ok（不该）' : `reason=${oob.reason} detail=${oob.detail ?? ''}`);
    }

    // ── ⑤ 工具编排：Pro 闸 / 诚实抬头 / 非 PDF 不接受页窗口（走生产 `read_document`）──
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr18-3-f-'));
    try {
      fs.writeFileSync(path.join(dir, 'long.pdf'), pdf30);
      fs.writeFileSync(path.join(dir, 'sheet.xlsx'), makeXlsx());
      fs.writeFileSync(path.join(dir, 'deck.pptx'), makePptx());
      fs.writeFileSync(path.join(dir, 'notes.txt'), Buffer.from('纯文本', 'utf8'));
      fs.writeFileSync(path.join(dir, 'legacy.doc'), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
      const comMedia = makeMediaTool(dir, settingsDb(null));
      const proMedia = makeMediaTool(dir, settingsDb(new Date().toISOString()));

      const xOut = await comMedia.read_document.execute({ filePath: 'sheet.xlsx' });
      ok(xOut === `[sheet.xlsx 正文]\n${XLSX_EXPECT}`,
        'F′-5a 工具出口：`.xlsx` 经 `isDocTextExt` 真进文档支（抬头 + 正文逐字相等，不是只在抽取器里成立）',
        JSON.stringify(xOut).slice(0, 90));

      const pOut = await comMedia.read_document.execute({ filePath: 'deck.pptx' });
      ok(pOut === `[deck.pptx 正文]\n${PPTX_EXPECT}`,
        'F′-5b 工具出口：`.pptx` 按页分段进上下文（同一份标本走通整条链）',
        JSON.stringify(pOut).slice(0, 90));

      const proOut = await proMedia.read_document.execute({ filePath: 'long.pdf', startPage: 6, maxPages: 5 });
      const proHead = `[long.pdf 第 6-10 页（共 ${N_PAGES} 页）]`;
      ok(typeof proOut === 'string' && proOut.startsWith(`${proHead}\n`)
        && proOut.includes(pageTag(6)) && proOut.includes(pageTag(10))
        && !proOut.includes(pageTag(5)) && !proOut.includes(pageTag(11)),
        'F′-5c ★Pro（试用态同尺）`startPage=6,maxPages=5` ⇒ 第 6–10 页，抬头逐字 `第 6-10 页（共 30 页）`',
        typeof proOut === 'string' ? JSON.stringify(proOut.slice(0, proHead.length + 2)) : typeof proOut);

      const comOut = JSON.parse(
        await comMedia.read_document.execute({ filePath: 'long.pdf', startPage: 21, maxPages: 5 }),
      ) as Record<string, unknown>;
      ok(comOut.ok === false && String(comOut.reason).includes('长文档分段阅读')
        && String(comOut.reason).includes('专业版')
        && !String(comOut.reason).includes(pageTag(1)),
        'F′-5d ★社区档请求第 21 页起 ⇒ 拒因 `long_document`（人话名上屏），**没有静默退回第 1 页**充数',
        `reason=${String(comOut.reason).slice(0, 90)}`);

      const comInline = await comMedia.read_document.execute({ filePath: 'long.pdf', startPage: 5, maxPages: 5 });
      ok(typeof comInline === 'string' && comInline.startsWith(`[long.pdf 第 5-9 页（共 ${N_PAGES} 页）]\n`)
        && comInline.includes(pageTag(5)) && comInline.includes(pageTag(9)),
        'F′-5e **反向标本**：社区档在前 20 页内开窗（5–9）照常放行——闸只挡越界请求，不把阅读本身圈走',
        typeof comInline === 'string' ? JSON.stringify(comInline.slice(0, 40)) : typeof comInline);

      const oobOut = JSON.parse(
        await proMedia.read_document.execute({ filePath: 'long.pdf', startPage: N_PAGES + 1, maxPages: 2 }),
      ) as Record<string, unknown>;
      ok(oobOut.ok === false && String(oobOut.reason).includes('page_out_of_range'),
        'F′-5f Pro 起页越过文档末页 ⇒ 如实 `page_out_of_range`（不是"读到空就算成功"）',
        `reason=${String(oobOut.reason).slice(0, 70)}`);

      const overOut = JSON.parse(
        await proMedia.read_document.execute({ filePath: 'long.pdf', maxPages: PDF_WINDOW_MAX_PAGES + 1 }),
      ) as Record<string, unknown>;
      ok(overOut.ok === false && String(overOut.reason).includes(String(PDF_WINDOW_MAX_PAGES)),
        'F′-5g 单次页数超物理上限 ⇒ 如实拒绝（不静默截短成 200 页）',
        `reason=${String(overOut.reason).slice(0, 70)}`);

      const winOnTxt = JSON.parse(
        await comMedia.read_document.execute({ filePath: 'notes.txt', startPage: 1 }),
      ) as Record<string, unknown>;
      ok(winOnTxt.ok === false && String(winOnTxt.reason).includes('startPage/maxPages'),
        'F′-5h 非 PDF 带页窗口 ⇒ 明确回因（不静默忽略参数、假装按页读了）',
        `reason=${String(winOnTxt.reason).slice(0, 70)}`);

      const docOut = JSON.parse(await comMedia.read_document.execute({ filePath: 'legacy.doc' })) as Record<string, unknown>;
      ok(docOut.ok === false && String(docOut.reason).includes('doc_legacy_unsupported')
        && String(docOut.note).includes('legacy.doc'),
        'F′-5i 工具出口对老 `.doc` 仍如实拒 + 原件路径在场（不回归）',
        `reason=${String(docOut.reason).slice(0, 60)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n【G】批七「阶」：两项新卖点各有一道真闸（先闸后读后写）');
  // ═══════════════════════════════════════════════════════════════════
  {
    const comLic = settingsDb(null) as unknown as LicenseSettingDb;
    const trialLic = settingsDb(LIC_NOW.toISOString()) as unknown as LicenseSettingDb;
    const proLic = licensedSettingsDb('pro');
    const teamLic = licensedSettingsDb('team');

    // ── G-1 Pro 词表 + 三档对照（long_document）──
    eq([...PRO_FEATURES], ['knowledge_export', 'knowledge_import', 'image_vision', 'long_video', 'long_document', 'domain_pack', 'knowledge_cards'],
      'G-1a `PRO_FEATURES` 逐成员枚举（zx_20261023_5 批二 `knowledge_cards` 入册）');
    eq([...new Set(PRO_FEATURES)].sort(), Object.keys(PRO_FEATURE_LABEL).sort(),
      'G-1a2 ★人话名词表与能力词表**同集**（由 `PRO_FEATURE_LABEL` 派生，加一项须两处同时加）');
    eq(PRO_FEATURE_LABEL.long_document, '长文档分段阅读（PDF 页窗口）',
      'G-1b 人话名如实（界面/拒因直接上屏）');
    const comProRef = proFeatureRefusal(comLic, 'long_document', LIC_OPTS);
    ok(!!comProRef && comProRef.includes('长文档分段阅读') && comProRef.includes('社区版'),
      'G-1c ★社区档被拒：拒因含人话名与**当前**档位', comProRef ?? 'null');
    eq(proFeatureRefusal(proLic, 'long_document', LIC_OPTS), null,
      'G-1d Pro 许可 ⇒ 放行（`long_document` 的解锁档位）');
    eq(proFeatureRefusal(teamLic, 'long_document', LIC_OPTS), null,
      'G-1e Team 许可 ⇒ 放行（Pro 能力是 Pro **及以上**）');
    eq(proFeatureRefusal(trialLic, 'long_document', LIC_OPTS), null,
      'G-1f 试用期 ⇒ 放行（与 `proUnlocked` 的 `kind===\'trial\'` 同尺）');

    // ── G-2 Team 词表 + 三档对照（audit_export）──
    // zx_20261022_3 批八：`project_profile_share` 入册（7→8；逐成员枚举仍不放宽）。
    eq([...TEAM_FEATURES],
      ['multi_node', 'device_discovery', 'device_control', 'external_terminal', 'audit_view', 'audit_export', 'team_library', 'project_profile_share'],
      'G-2a `TEAM_FEATURES` 逐成员枚举（批七 `audit_export` / zx_20261022_3 批八 `project_profile_share` 入册）');
    eq(TEAM_FEATURE_LABEL.audit_export, '审计导出（CSV）', 'G-2b 人话名如实');
    const comTeamRef = teamFeatureRefusal(comLic, 'audit_export', LIC_OPTS);
    ok(!!comTeamRef && comTeamRef.includes('审计导出') && comTeamRef.includes('社区版'),
      'G-2c ★社区档被拒：拒因含人话名与当前档位', comTeamRef ?? 'null');
    const proTeamRef = teamFeatureRefusal(proLic, 'audit_export', LIC_OPTS);
    ok(!!proTeamRef && proTeamRef.includes('审计导出') && proTeamRef.includes('专业版'),
      'G-2d ★★Pro 档**仍被拒**（Team 闸不是"非社区即放行"）', proTeamRef ?? 'null');
    eq(teamFeatureRefusal(teamLic, 'audit_export', LIC_OPTS), null,
      'G-2e Team 许可 ⇒ 放行');
    eq(teamFeatureRefusal(trialLic, 'audit_export', LIC_OPTS), null,
      'G-2f 试用期 ⇒ 放行（与既有 Team 能力同尺）');

    // ── G-3 CSV 转义（RFC 4180）──
    eq(csvEscape('plain'), 'plain', 'G-3a 普通字段不加引号');
    eq(csvEscape('a,b'), '"a,b"', 'G-3b 含逗号 ⇒ 整体加引号（否则一列被拆成两列）');
    eq(csvEscape('a"b'), '"a""b"', 'G-3c 含引号 ⇒ 内部引号翻倍');
    eq(csvEscape('a\nb'), '"a\nb"', 'G-3d 含换行 ⇒ 整体加引号（行数不被字段内换行骗走）');
    eq(csvEscape('a\r\nb'), '"a\r\nb"', 'G-3e 含回车换行 ⇒ 整体加引号');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-audit-export-'));
    try {
      // ── G-4 锁定：拒因 + **零读库 + 零落文件** ──
      const targetLocked = path.join(tmp, 'locked', 'exports', 'audit.csv');
      const counting = makeAuditDb([
        { id: 'x1', action: 'node.update', created_at: '2026-10-19T00:00:00Z' },
      ]);
      const locked = exportAuditCsvGated(counting.db, comLic, targetLocked, {}, LIC_OPTS);
      ok(!locked.unlocked && !!locked.refusal && locked.refusal.includes('审计导出'),
        'G-4a 社区档导出 ⇒ 如实拒因（`TEAM_REQUIRED` 的人话面）', locked.refusal);
      eq([locked.saved, locked.rows, locked.path], [false, 0, ''],
        'G-4b 锁定 ⇒ 未落盘、零行、无路径');
      eq(counting.prepares(), 0,
        'G-4c ★零读库：`prepare` 计数仍为 0（先闸后读，不是"读了再藏"）', `prepare ${counting.prepares()} 次`);
      ok(!fs.existsSync(path.join(tmp, 'locked')),
        'G-4d ★零落文件：连目录都没建（不是"建了空目录再删"）');

      // ── G-5 解锁：落盘 0→1 + 行数一致 + 逐字 CSV（含逗号/引号/换行）──
      const target = path.join(tmp, 'exports', 'audit.csv');
      const tricky = makeAuditDb([
        {
          id: 'r1', actor_kind: 'local', actor_ref: 'agent,"007"', action: 'node.update',
          target_type: 'node', target_id: 'n,1', detail_json: '{"k":"v,2"}',
          created_at: '2026-10-19T00:00:00Z',
        },
        {
          id: 'r2', actor_kind: 'local', actor_ref: 'line1\nline2', action: 'team.share',
          target_type: 'team', target_id: 'x"y', detail_json: '{}',
          created_at: '2026-10-19T00:00:01Z',
        },
      ]);
      const before = fs.existsSync(target);
      const exported = exportAuditCsvGated(tricky.db, teamLic, target, {}, LIC_OPTS);
      ok(!before && fs.existsSync(target), 'G-5a ★文件 0→1（导出前不存在、导出后存在）');
      eq([exported.unlocked, exported.saved, exported.rows], [true, true, 2],
        'G-5b 解锁 ⇒ 已落盘且行数与查询一致（2 行）', JSON.stringify(exported));
      eq(exported.path, target, 'G-5c 返回真实落盘路径（界面据此如实显示）');
      eq(listAuditEvents(tricky.db, {}).length, 2, 'G-5d 同一筛选下的查询行数 = 导出行数（2）');
      const expectedCsv = [
        'id,created_at,source,action,actor_kind,actor_ref,target_type,target_id,result,note,detail',
        'r2,2026-10-19T00:00:01Z,local,team.share,local,"line1\nline2",team,"x""y",,,{}',
        'r1,2026-10-19T00:00:00Z,local,node.update,local,"agent,""007""",node,"n,1",,,"{""k"":""v,2""}"',
        '',
      ].join('\r\n');
      eq(fs.readFileSync(target, 'utf8'), expectedCsv,
        'G-5e ★★落盘内容**逐字**（表头 + 时间倒序 + 逗号/引号/换行三处转义；不是"包含即过"）');

      // ── G-6 分页读完（>500 行不被 `MAX_LIMIT` 截断）──
      const bulkRows = Array.from({ length: 501 }, (_, i) => ({
        id: `bulk-${i}`, actor_kind: 'system', action: i % 2 === 0 ? 'bulk.even' : 'bulk.odd',
        created_at: new Date(Date.UTC(2026, 9, 19, 0, 0, 0, i)).toISOString(),
      }));
      const bulk = makeAuditDb(bulkRows);
      const targetBulk = path.join(tmp, 'exports', 'bulk.csv');
      const allBulk = exportAuditCsvGated(bulk.db, teamLic, targetBulk, {}, LIC_OPTS);
      eq(allBulk.rows, 501, 'G-6a ★分页读完：501 行跨过一次 `MAX_LIMIT=500` 仍全导出');
      ok(fs.readFileSync(targetBulk, 'utf8').includes('bulk-500'),
        'G-6b 末页的行真在文件里（不是只写了第一页的 500 行）');
      const targetEven = path.join(tmp, 'exports', 'even.csv');
      const evenBulk = exportAuditCsvGated(bulk.db, teamLic, targetEven, { action: 'bulk.even' }, LIC_OPTS);
      eq(evenBulk.rows, 251, 'G-6c 导出吃**筛选**：动作过滤后行数与查询一致（251 行）');

      // ── G-7 卖点兑现登记（双向）──
      const tiers = Object.keys(PRICING) as Array<keyof typeof PRICING>;
      for (const t of tiers) {
        eq(benefitCoverageProblems(t, PRICING[t].benefits), [],
          `G-7a ${t}：每条卖点都指向本档成立的能力/上限/服务项（无问题）`);
        eq(BENEFIT_COVERAGE[t].map((e) => e.benefit), PRICING[t].benefits,
          `G-7b ${t}：登记与价目表**同集同序**（逐字）`);
      }
      const missingSpecimen = benefitCoverageProblems(
        'pro', PRICING.pro.benefits.filter((b) => !b.includes('长文档分段阅读')),
      );
      ok(missingSpecimen.some((p) => p.includes('已登记但价目表没有这句')),
        'G-7c ★反向标本一：删掉新增卖点 ⇒ 登记腐化被点名', missingSpecimen.join(' | ') || '空');
      const ungatedSpecimen = benefitCoverageProblems('team', [...PRICING.team.benefits, '无限魔法']);
      ok(ungatedSpecimen.some((p) => p.includes('未登记兑现方式')),
        'G-7d ★反向标本二：新增**无闸卖点** ⇒ 立即被判红', ungatedSpecimen.join(' | ') || '空');
      ok(PRICING.pro.benefits.some((b) => b.includes('长文档分段阅读'))
        && PRICING.team.benefits.some((b) => b.includes('审计导出（CSV）')),
        'G-7e 两份新卖点真在价目表里（不是只写进登记表）');

      // ── G-8 营销口径：每档一句话"为谁解决什么" ──
      const tags = [PRICING.community.tagline, PRICING.pro.tagline, PRICING.team.tagline];
      ok(new Set(tags).size === 3, 'G-8a 三档定位各不相同', tags.join(' / '));
      ok(tags.every((t) => t.includes('：')),
        'G-8b 每档一句「为谁：解决什么」（不堆功能清单）', tags.join(' / '));
      ok(PRICING.community.tagline.includes('个人')
        && PRICING.pro.tagline.includes('个人与小团队')
        && PRICING.team.tagline.includes('团队'),
        'G-8c 三档的"为谁"逐档可辨');

      // ── G-9 口径文档与代码逐句对齐（静态）──
      const lt = RD('business-plan/license-tiers.md');
      const bz = RD('business-plan/plans/biz_20261011.md');
      for (const phrase of ['长文档分段阅读（PDF 页窗口）', '审计导出（CSV）']) {
        ok(lt.includes(phrase) && bz.includes(phrase),
          `G-9 两份口径文档都含同一句卖点：「${phrase}」`);
      }
      ok(lt.includes('audit_export') && lt.includes('long_document'),
        'G-9b `license-tiers.md` 写明两道闸的能力键');
      ok(bz.includes("'audit_export'") && bz.includes("'long_document'"),
        'G-9c `biz_20261011.md` 的词表字面量与代码同集（含新增两项）');

      // ── G-10 接线（去注释读码；次序＝判据）──
      const al = noComment(`${A}/src/main/core/audit-log.ts`);
      const gateAt = al.indexOf("teamFeatureRefusal(licDb, 'audit_export'");
      const readAt = al.indexOf('const rows = listAllAuditEvents(db');
      ok(gateAt >= 0 && readAt > gateAt,
        'G-10a ★`exportAuditCsvGated` 先过闸再读（闸调用在取数之前，按语句次序）');
      const ipc = noComment(`${A}/src/main/ipc/audit.ipc.ts`);
      ok(ipc.includes("'audit:export'") && ipc.includes('exportAuditCsvGated('),
        'G-10b `audit:export` 通道壳调 core 编排（不在壳里复刻闸判据）');
      const page = RD(`${A}/renderer/src/pages/AuditPage.tsx`);
      ok(page.includes('导出 CSV') && page.includes('auditApi.exportCsv'),
        'G-10c 面板有可达的导出入口（用户点得到，不是只留后端口）');
      const ripc = RD(`${A}/renderer/src/lib/ipc.ts`);
      ok(ripc.includes("'audit:export'") && ripc.includes('exportCsv'),
        'G-10d 渲染层 API 指向真通道（不手写一份会漂的镜像）');
      const pricing = noComment(`${A}/src/main/core/pricing.ts`);
      ok(pricing.includes('长文档分段阅读（PDF 页窗口）') && pricing.includes('审计导出（CSV）'),
        'G-10e 价目表两句卖点真在 `pricing.ts`（去注释后仍在）');
      const catalog = noComment(`${A}/src/main/core/tier-catalog.ts`);
      ok(catalog.includes("keys: ['long_document']") && catalog.includes("keys: ['audit_export']"),
        'G-10f 卖点兑现登记分别指回两道闸的能力键');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n【H】批七「稳」：暂停不被连点成恢复 · 流式块不再顶走操作栏');
  // ═══════════════════════════════════════════════════════════════════
  {
    const page = noComment(`${A}/renderer/src/pages/TaskDetailPage.tsx`);

    // ── ① 状态动作同一把锁：同步 ref 挡第二击 + 提交期/700ms 冷却共用 actionLocked ──
    ok(page.includes('if (actionBusyRef.current) return false;'),
      'H-1 同步 ref 先挡第二击（state 尚未刷新时也不放行）');
    ok(/const actionLocked = submitting \|\| actionCooldown;/.test(page),
      'H-2 ★提交期与冷却期共用同一个 `actionLocked`（不是两套互不相认的禁用判据）');
    ok(/function lockActionsFor\(ms = 700\): void/.test(page) && page.includes('window.setTimeout('),
      'H-3 冷却窗 700ms（提交成功后仍锁住，避免状态未翻页前再点一次反向动作）');
    for (const fn of ['handleStatus', 'handleArchive', 'handleRetry', 'submitPauseOp', 'handleInterrupt']) {
      const start = page.indexOf(`async function ${fn}(`);
      const end = page.indexOf('\n  async function ', start + 1);
      const body = start >= 0 ? page.slice(start, end > start ? end : start + 2000) : '';
      ok(body.includes('if (!beginAction()) return;') && body.includes('endAction()'),
        `H-4 ${fn} 走同一把锁（beginAction + endAction，含失败路径的 finally）`);
    }

    // ── ② 固定槽位：暂停态在原坐标显示**禁用**「已暂停」，恢复在另一个槽位 ──
    const barStart = page.indexOf('<ActionSlot>');
    const barEnd = page.indexOf('{showInject && (task.status', barStart);
    ok(barStart >= 0 && barEnd > barStart, 'H-5 动作栏区域取自生产源码（不是手写片段）');
    const bar = barStart >= 0 && barEnd > barStart ? page.slice(barStart, barEnd) : '';
    const pausedAt = bar.indexOf("task.status==='paused' && <button disabled");
    const pausedBranchEnd = pausedAt >= 0 ? bar.indexOf('</button>}', pausedAt) : -1;
    const pausedBranch = pausedAt >= 0 && pausedBranchEnd > pausedAt ? bar.slice(pausedAt, pausedBranchEnd) : '';
    ok(pausedBranch.includes('已暂停') && !pausedBranch.includes('onClick'),
      'H-6 ★暂停态在原槽位显示**禁用**的「已暂停」（同一坐标不可能点到「恢复」）');
    const resumeAt = bar.indexOf("(task.status==='paused'||task.status==='failed') && <button onClick={() => handleResume");
    ok(resumeAt > pausedAt && pausedAt >= 0,
      'H-7 「恢复」在**另一个**槽位（且位于暂停槽之后），不与「暂停」共用坐标');
    ok(bar.includes('title="任务已暂停——「恢复」在右侧独立按钮'), 'H-8 禁用按钮自带说明（用户知道恢复去了哪）');
    ok((bar.match(/<ActionSlot>/g) || []).length >= 4,
      'H-9 动作栏按固定槽位排布（空槽用等宽占位撑住，后续按钮不左移右移）');

    // ── ③ 流式块按内容撑开：D11 把实时块移到操作栏下方（I-7b），D13 取消块内限高/滚动 ──
    ok(!page.includes('h-40 text-xs text-indigo-700'),
      'H-10 思考块不再定高（随页撑开，不冒内滚动条）');
    eq((page.match(/h-28 text-xs text-blue-700/g) || []).length, 0,
      'H-11 两处生成块不再定高（首步横幅 + 执行中状态条）');
    ok(!page.includes('el.scrollTop = el.scrollHeight') && /function StreamPane\(\{ className, title, children \}/.test(page),
      'H-12 ★贴底滚动随定高窗一并退场（滚动只由页面承担）');
    eq(page.includes('max-h-48 overflow-y-auto'), false, 'H-13 旧形态 `max-h-48` 流式块清零');
    eq(page.includes('max-h-36 overflow-y-auto'), false, 'H-14 旧形态 `max-h-36` 流式块清零');

    // ── ④ 产物核对：renderer 是第二落点，构建后须真的带上这些字样 ──
    const assetsDir = path.join(root, A, 'renderer/dist/assets');
    const tchunks = fs.existsSync(assetsDir)
      ? fs.readdirSync(assetsDir).filter((f) => /^TaskDetailPage-.*\.js$/.test(f)) : [];
    ok(tchunks.length === 1, 'H-15 renderer 产物含 TaskDetailPage 独立 chunk（须先跑 renderer build）', tchunks.join(',') || '缺失');
    if (tchunks.length === 1) {
      const c = fs.readFileSync(path.join(assetsDir, tchunks[0]!), 'utf-8');
      ok(c.includes('已暂停') && !c.includes('overscroll-contain'),
        'H-16 ★产物里「已暂停」仍在，且不再带块内滚动样式（不是只改了源码）');
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n【I】组5 实机连带缺陷：折叠状态按项目 · 实时块整窗定高');
  // ═══════════════════════════════════════════════════════════════════
  {
    const tasksPage = noComment(`${A}/renderer/src/pages/TasksPage.tsx`);
    const detailPage = noComment(`${A}/renderer/src/pages/TaskDetailPage.tsx`);

    // ── ① 折叠状态按项目各自保存（D8） ──
    ok(/const \[collapsedByPid, setCollapsedByPid\] = useState<Record<string, Set<string>>>\(\{\}\);/.test(tasksPage),
      'I-1 ★折叠集合按项目分开存（不再是全局一个 Set）');
    ok(tasksPage.includes('userCollapsedRef.current.add(selectedPid)')
      && /const userCollapsedRef = useRef<Set<string>>\(new Set\(\)\);/.test(tasksPage),
      'I-2 手动折叠只标记**当前项目**（不再是全局布尔）');
    ok(tasksPage.includes('userCollapsedRef.current.has(selectedPid)')
      && tasksPage.includes('setCollapsedByPid(prev => ({ ...prev, [selectedPid]: dflt }))')
      && /\[allTasks, selectedPid\]/.test(tasksPage),
      'I-3 默认折叠按项目重算、按项目写回（切项目不再沿用别的项目的"已手动操作"）');
    ok(/const collapsed = \(selectedPid && collapsedByPid\[selectedPid\]\) \|\| EMPTY_COLLAPSED;/.test(tasksPage)
      && tasksPage.includes('collapsed.has(t.id)'),
      'I-4 渲染仍读当前项目的折叠集合（行为判据不变）');

    // ── ② 执行期实时块移到操作栏下方、随页自然撑开（D9→D11→D13） ──
    ok(/function LivePane\(\{ children \}: \{ children: ReactNode \}\)/.test(detailPage)
      && /<div className="mt-2 space-y-2">/.test(detailPage)
      && !detailPage.includes('max-h-[260px]')
      && !detailPage.includes('h-[300px]'),
      'I-5 ★实时块不限高、不块内滚动（D13：随页撑开，滚动只有页面一条）');
    const liveOpen = detailPage.indexOf('<LivePane>');
    const liveClose = detailPage.indexOf('</LivePane>', liveOpen);
    ok(liveOpen >= 0 && liveClose > liveOpen, 'I-7 实时块取自生产源码的实时窗（不是手写片段）');
    // D11 核心：实时块在**操作栏之后**，且标题块之前不再有 LivePane ⇒ 高度变化不影响任何按钮坐标。
    const actionBar = detailPage.indexOf('className="flex items-center gap-2 mt-3 pt-3 border-t"');
    const titleBlock = detailPage.indexOf('<div className="flex items-start justify-between mb-3">');
    ok(liveOpen > actionBar && titleBlock > 0 && titleBlock < actionBar,
      'I-7b ★实时块排在操作栏**之后**（标题→元信息→按钮→实时块；按钮不再被顶走）');
    const live = liveOpen >= 0 && liveClose > liveOpen ? detailPage.slice(liveOpen, liveClose) : '';
    ok(live.length > 0 && !live.includes('overflow-y-auto') && !live.includes('h-40 ') && !live.includes('h-28 '),
      'I-6 实时窗内的思考/生成块无定高、无内滚动（不冒第二条滚动条）');
    for (const [label, needle] of [
      ['思考块', 'streamingReasoning &&'],
      ['首步流式横幅', 'streamingText && !liveStatus'],
      ['执行中状态条', 'liveStatus && (task.status'],
      ['心跳块', 'hbFresh && heartbeat'],
    ] as const) {
      ok(live.includes(needle), `I-8 ${label}确在实时窗内（位于操作栏下方）`);
    }
    ok(detailPage.includes('等待执行输出'), 'I-9 空窗期有如实占位（不空白、不假装无输出）');

    // ── ③ 产物核对：构建后真带上无限高窗与占位 ──
    const assetsDir2 = path.join(root, A, 'renderer/dist/assets');
    const dchunks = fs.existsSync(assetsDir2)
      ? fs.readdirSync(assetsDir2).filter((f) => /^TaskDetailPage-.*\.js$/.test(f)) : [];
    ok(dchunks.length === 1, 'I-10 renderer 产物含 TaskDetailPage 独立 chunk（须先跑 renderer build）', dchunks.join(',') || '缺失');
    if (dchunks.length === 1) {
      const c = fs.readFileSync(path.join(assetsDir2, dchunks[0]!), 'utf-8');
      ok(!c.includes('max-h-[260px]') && c.includes('等待执行输出') && !c.includes('h-[300px]'),
        'I-11 ★产物里实时窗确无高度上限，且空窗占位仍在（不是只改了源码）');
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n【J】组6 实机连带缺陷：完成分须消费**本轮**验收结论（D10）');
  // ═══════════════════════════════════════════════════════════════════
  {
    // 病根：`completionCapFloors` 曾排在验收核对之前 ⇒ 第二次 finalize 读到账上上一轮 `failed`
    //   仍压 45，而 checks 已写「验收已核对达成」——同屏两种互相否认的口径。判据是**顺序**本身，
    //   故按符号取两处调用的相对位置（不按行号，重构后仍成立）。
    const cf = noComment(`${A}/src/main/core/tools/control-finalize.ts`);
    const iAcc = cf.indexOf('await checkAcceptanceCriteria(ctx, db, taskId, acceptanceCriteria)');
    const iBlock = cf.indexOf('if (acceptanceBlock) return acceptanceBlock;');
    const iCaps = cf.indexOf('const caps = completionCapFloors(');
    const iAcct = cf.indexOf('ctxJson.completion_quality = buildCompletionAccount({');
    const iFin = cf.indexOf('const finScore =');
    ok(iAcc >= 0 && iBlock > iAcc && iCaps > iBlock,
      'J-1 ★完成分封顶 **晚于**验收核对（验收失败直接 return，不会先按旧账压分）');
    ok(iAcct > iAcc, 'J-2 完成分记账读到的验收账是**本轮刚落库**的那一笔');
    ok(iFin > iAcct, 'J-3 暂停判据 `finScore` 取的仍是同一笔封顶后的账');
    // 留痕在注释里，须读**原文**（`noComment` 已把注释剥掉）。
    ok(RD(`${A}/src/main/core/tools/control-finalize.ts`).includes('zx_20261018_3 D10'),
      'J-4 订正处有可检索的 D10 留痕（下一轮勿把整段挪回去）');
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n【K】组6 实机反馈：许可到期如实显形（D12）');
  // ═══════════════════════════════════════════════════════════════════
  {
    // 病根：`{lic?.expiresAt && …}` 让**永久许可**（载荷 `expiresAt: null`）整行消失，
    //   用户无从分辨"永久"与"漏显"。判据钉的是**三种许可形态各自有话说**，不是某个像素。
    const sp = noComment(`${A}/renderer/src/pages/SettingsPage.tsx`);
    ok(!sp.includes('{lic?.expiresAt &&'),
      'K-1 ★「到期」一行不再以 expiresAt 非空为渲染条件（永久许可也要有话说）');
    ok(sp.includes("'永久（许可未设到期时间）'"),
      'K-2 已激活且载荷无到期时刻 ⇒ 明写「永久」（不是留白）');
    ok(sp.includes('`试用期内（剩 ${lic.trialDaysLeft} 天）`') && sp.includes("'试用期内'"),
      'K-3 试用态 ⇒ 报剩余天数（天数未知也不留白）');
    ok(sp.includes("'不适用（未激活）'"),
      'K-4 未激活/社区 ⇒ 明写「不适用」，不冒充永久');
    // 语义说明在注释里，须读**原文**（`noComment` 已把注释剥掉）。
    const licSrc = RD(`${A}/src/main/core/license.ts`);
    ok(/expiresAt:\s*string \| null/.test(licSrc) && licSrc.includes('`null` = 永久'),
      'K-5 主进程契约仍是 `expiresAt: null = 永久`（显示层据实展开，不改语义）');
    const assetsDir3 = path.join(root, A, 'renderer/dist/assets');
    const schunks = fs.existsSync(assetsDir3)
      ? fs.readdirSync(assetsDir3).filter((f) => /^SettingsPage-.*\.js$/.test(f)) : [];
    if (schunks.length === 1) {
      const c = fs.readFileSync(path.join(assetsDir3, schunks[0]!), 'utf-8');
      ok(c.includes('永久（许可未设到期时间）') && c.includes('不适用（未激活）'),
        'K-6 ★产物里确有永久/未激活两档文案（不是只改了源码）');
    } else {
      ok(false, 'K-6 renderer 产物含 SettingsPage 独立 chunk（须先跑 renderer build）', schunks.join(',') || '缺失');
    }
    // D14: 载荷是带 `Z` 的 ISO，直接印出来不是给人读的 ⇒ 与全站同一把尺转本地时区。
    ok(sp.includes('formatDbTime(lic.expiresAt) || lic.expiresAt'),
      'K-7 ★到期时刻转本地可读格式（解析不出才原样回退，不伪造成空白）');
    ok(sp.includes("import { formatDbTime } from '../lib/deliverable-view';"),
      'K-8 时间格式化取全站同一把尺（formatDbTime，不另写一套）');
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n【L】组6 反馈：证书到期按目标时区取当日末（D14b）');
  // ═══════════════════════════════════════════════════════════════════
  {
    const issuerRaw = RD('scripts/issue-license.ts');
    const issuer = noComment('scripts/issue-license.ts');
    ok(!issuer.includes('T23:59:59.999Z') && issuer.includes('function endOfDayISO('),
      'L-1 ★不再把「当日末」写死成 UTC（改按目标时区算 23:59:59.999）');
    ok(issuer.includes('offsetSuffix(') && issuer.includes('Intl.DateTimeFormat') && issuer.includes('timeZone: tz'),
      'L-2 证书内写显式偏移（+08:00 这类），跨时区可自解释');
    ok(issuerRaw.includes('--tz Asia/Shanghai') && issuer.includes("opts.get('tz')"),
      'L-3 `--tz` 可按买受人时区签发（缺省=签发机本地）');
    ok(issuer.includes('--expires 不是合法日期') && issuer.includes('--tz 不是合法时区'),
      'L-4 非法日期/时区如实拒绝（不静默按 UTC 或错误日签发）');
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  // ═══════════════════════════════════════════════════════════════════
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量', selfPins.map((m) => m[1]).join(',') || '0 处');
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
    eq(pinFail, 0, 'S4 ★`checkBuildPins` P1–P6 全绿（0 红）', `绿 ${pinPass} / 红 ${pinFail}`);
    ok(pinPass >= 6, 'S4b 至少六条判据真跑过（"没考"不算"考过"）', `实测 ${pinPass} 条`);
    // 断言数自检（防止本文件被误删断言后静默瘦身）。
    ok(pass + fail >= 120, 'S5 本套件断言数 ≥120（覆盖 A–G / B′ / C′ 三组批次，不是空壳）', `${pass + fail} 条`);
  }
}

// 让 `sum` 之类的小工具不因未用而红（tsc noUnusedLocals 在部分配置下开着）。
void sum;

main().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\n💥 rr_${SELF_ROUND} 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
