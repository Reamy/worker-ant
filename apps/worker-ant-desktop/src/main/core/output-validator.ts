/**
 * 文件输出质量验证器 (Phase B)。
 * 借鉴 ANS/worker-ant verifier.ts + sufficiency-checker.ts 的两阶段验证架构：
 * 快速文件检查 → LLM 充分性验证。
 * 在 finalize_task 中调用，确保产出物质量。
 */

/**
 * @layer application — 应用层 — 编排领域对象完成用例：意图分类、技能注册、策略引擎、输出验证
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { generateText } from 'ai';
import type { AnsClient } from '@worker-ant/ans-client';
import { createSafeProvider } from './ai-provider.js';
import { createLogger } from './logger.js';
import { auxModelRequest } from './model-request.js';
// zx_20261012_3 批二（「算得真」）：字÷4 的分度走**一处真源**（core/token-estimate.ts），不各写一份。
import { estimateTokensFromChars } from './token-estimate.js';
// zx_20261002 M17-②: 编码闸**一处真源**——结果校验读盘与 `read_file`/附件装配层走**同一个函数**。
import { decodePlainText } from './doc-text.js';
// zx_20261003 M1: `.pdf` 是**二进制**不是文本——抽正文复用附件层**同一份** `extractPdfText`，不另写一套。
import { extractPdfText } from './pdf-text.js';

const logger = createLogger('output-validator');

/**
 * zx_20261002 M17-②（管子·度量衡 / 维特根斯坦「一把尺」）: 结果校验读盘**过同一道编码闸**。
 *
 * 病根：本文件原有三处 `readFileSync` **直按 `utf-8` 硬解**（`quickFileCheckAdaptive` / `quickFileCheck` /
 *   `llmSufficiencyCheck`）与 `read_file`（已过 `doc-text.decodePlainText`）是**两把尺**——一份 GBK 成果
 *   会被静默解成一坨 U+FFFD，随后 `requiredPatterns` 逐条不中，判成"缺少函数/类/模块定义"：
 *   **读错了**被当成**内容不足**（同一个"判卷结论"下两种截然不同的病据）。
 *
 * 改法：调**同一份** `decodePlainText`（`read_file` / 附件装配层用的就是它）；解不出时**如实说"编码不支持"**，
 *   不再冒充内容问题。`bytes` 取盘上字节数——与旧 `Buffer.byteLength(utf8 text)` 在合法 UTF-8 上等值。
 *
 * zx_20261003 M1（管子·度量衡 / 维特根斯坦「一把尺」）：`.pdf` **不是文本**，先过 `extractPdfText` 抽正文
 *   再按文本判；抽不出（加密 / 扫描件 / 无文本层）⇒ 打 `unverifiable` 标——**"读不出" ≠ "内容不足"**，
 *   绝不给它扣内容分的帽子（承 zx_20261002 M17-② 对 GBK 的同款取舍；两条路的区别见下）。
 */
function readTextThroughGate(
  filePath: string,
): { ok: true; content: string; bytes: number } | { ok: false; issue: string; bytes: number; unverifiable?: boolean } {
  const buf = fs.readFileSync(filePath);
  if (path.extname(filePath).toLowerCase() === '.pdf') {
    const r = extractPdfText(buf);
    if (r.ok) return { ok: true, content: r.text, bytes: buf.length };
    return {
      ok: false,
      bytes: buf.length,
      unverifiable: true,
      issue: `PDF 正文抽不出（${r.reason}${r.detail ? `：${r.detail}` : ''}）——这不是"内容不足"；扫描件/加密件请另附文本版`,
    };
  }
  const d = decodePlainText(buf);
  if (!d.ok) {
    // ⚠ 这里**不**打 `unverifiable`：解不出（GBK 等）如实判"内容不足"是既有裁定（zx_20261002 M17-② /
    //   反向断言 P-8），本批不动它——`unverifiable` 只给"本该能读、但格式本身无文本层"的 PDF/媒体。
    return {
      ok: false,
      bytes: buf.length,
      issue: `无法按 UTF-8/BOM 解码（${d.detail || d.reason}）——已跳过内容判型，这不是"内容不足"；请将成果转存为 UTF-8`,
    };
  }
  return { ok: true, content: d.text, bytes: buf.length };
}

/** 文件快速检查结果 */
interface QuickCheck {
  passed: boolean;
  issues: string[];
  fileSize: number;
  hasHeader: boolean;
  hasBody: boolean;
  hasConclusion: boolean;
  /**
   * zx_20261003 M1：**这份产出压根没有可判的文本层**（PDF 抽不出正文 / 音视频），
   * 附一句人话说明。`validateOutput` 见到它即判 `status:'unknown'`（放行 + 如实记账），
   * **不**当"内容不足"——"判不出"和"判不足"是两件事，混为一谈就是本仓反复复发的病根。
   */
  unverifiable?: string;
}

// ==================== 1.3 上善若水：自适应输出验证 ====================

export interface ArchetypeValidationRule {
  minSize: number;
  requiredPatterns: Array<{ label: string; pattern: RegExp }>;
  forbiddenPatterns: Array<{ label: string; pattern: RegExp }>;
}

/** 导出供受控回归**直引真规则**（zx_20261022_1 批一）——扫源码字符串冒充覆盖会放过转义错误。 */
export const ARCHETYPE_VALIDATION: Record<string, ArchetypeValidationRule> = {
  code: {
    minSize: 100,
    // zx_20260911_1 M1: 判据改为语言中立——不再只认 JS/TS 口径，Python def/from、Go func/package、
    // Rust fn/use、Java public/private、C #include 等一律算"代码构造"。
    // zx_20260922_1 M3（F6b）：词表补 DDL 与大小写无关的匹配。
    // 病根：`.sql` 归在 `CODE_ARTIFACT_EXTS`（判型没错），但这张词表只认"编程语言的顶层构造"，
    // `ALTER TABLE` / `CREATE INDEX` 一个都不在列 ⇒ **真迁移脚本 100% 也判"缺少函数/类/模块定义"**。
    // 活标本：`V1.0.1__order-payment.sql`（2118B，通篇 ALTER）实测命中 0 处。
    // ⚠ 只能把这几个动词**并进这一条既有 pattern**，不能另起一条：`requiredPatterns` 是
    // **全部命中才算通过**的列表（见 `quickFileCheckAdaptive` 的逐条 push），加第二条会让每个
    // `.java`/`.py` 都缺第二条而全线判红。
    requiredPatterns: [
      { label: '函数/类/模块定义', pattern: /(?:^|\n)[ \t]*(?:import|from|def|class|function|const|let|var|export|interface|type|package|public|private|fn|func|#include|module|use|struct|enum|async|await|create|alter|insert|update|delete|grant|drop)\b/i },
    ],
    forbiddenPatterns: [
      // zx_20260911_1 M1: 原 /TODO(?!.*[\\u2705\\u2713])/ 中 \\u2705 在正则字面量里是"反斜杠+u2705"，
      // 字符类实际为 {\,u,2,7,0,5,1,3}，于是"TODO: 下轮修"因含 2 被误放行（判据静默失效）。改为真 Unicode 转义。
      { label: 'TODO未完成', pattern: /(?:TODO|FIXME)(?![^\n]*(?:✅|✓|已完成))/ },
    ],
  },
  document: {
    minSize: 500,
    requiredPatterns: [
      { label: 'Markdown标题', pattern: /^#\s+.+/m },
      { label: '结论/总结', pattern: /(?:结论|总结|建议|综上所述)/ },
    ],
    forbiddenPatterns: [
      // zx_20261022_1 批一（维特根斯坦·意义即用法）：原式 `/\\[待补充\\]|…/` 在正则字面量里
      //   实际是"反斜杠 + 字符类"，于是 ①`[待补充]` 一个也不命中（判据静默失效）；
      //   ②`\\[WIP\\]` 在 `/i` 下把正文里的 `\w`（如 `class \w+Controller`）判成占位符（误伤）。
      //   与本文件 110–113 行那次（`\\u2705`）同族：**写了转义符，就没写判据**。
      { label: '占位符内容', pattern: /\[(?:待补充|TODO|WIP)\]|lorem ipsum/i },
    ],
  },
  pdf: {
    // zx_20261003 M1: PDF 的判据是**抽出正文后按散文**——**不要求** Markdown 标题（PDF 正文天生没有 `#` 结构，
    //   照搬 document 规则会把每一份 PDF 都判缺"Markdown标题"）。抽不出正文的 PDF 根本走不到这里
    //   （`readTextThroughGate` ⇒ `unverifiable`）。`minSize` 量的是盘上 PDF 字节数（含结构开销）。
    minSize: 500,
    requiredPatterns: [
      { label: '成篇正文', pattern: /[\s\S]{100,}/ },
    ],
    forbiddenPatterns: [],
  },
  analysis: {
    minSize: 300,
    requiredPatterns: [
      { label: '数据引用', pattern: /(?:\d+%|\d+\.\d+|[0-9]+(?:\.[0-9]+)?[KMB]?)/ },
      { label: '分析结论', pattern: /(?:分析|趋势|结论|发现)/ },
    ],
    forbiddenPatterns: [
      { label: '无数据支撑', pattern: /大概|可能|也许|似乎|好像/ },
    ],
  },
  configuration: {
    minSize: 100,
    // zx_20260922_1 M3（F6b）：原判据 /(yaml|json|toml|env|config|port|host)/i 是**关键词表**——
    // 不认结构，只认这七个词。实测四个真 `pom.xml` 全部"通过"，但**每一处命中都是** `<description>`
    // 里 `support` 里的 `port`：换一个词（或换个项目）这条判据就翻脸，而它从未真正读过配置本身。
    // 改为认**声明式结构**：XML 开标签 / `key = value` 或 `key: value` / `"key":` 三选一（`m` 行模式）。
    requiredPatterns: [
      { label: '配置信息', pattern: /(?:^\s*<[\w:.-]+)|(?:^\s*[\w.-]+\s*[=:]\s*\S)|(?:"\w+"\s*:)/m },
    ],
    forbiddenPatterns: [],
  },
  research: {
    minSize: 400,
    requiredPatterns: [
      { label: '信息来源', pattern: /(?:来源|参考|引用|https?:\/\/|根据.*报道)/ },
    ],
    forbiddenPatterns: [
      { label: '来源不足', pattern: /^[^#]*(?:(?:来源|参考|引用).*){0,1}$/m },
    ],
  },
  conversation: {
    minSize: 20,
    requiredPatterns: [],
    forbiddenPatterns: [
      { label: '未完成JSON', pattern: /\{[^}]*$/m },
    ],
  },
};

const DEFAULT_RULES: ArchetypeValidationRule = {
  minSize: 200,
  requiredPatterns: [{ label: '实质内容', pattern: /.{50,}/s }],
  forbiddenPatterns: [],
};

/** 充分性验证结果 */
export interface ValidationResult {
  /** 是否放行（快检通过 且 非明确不充分）；LLM 不可用时足够但不代表内容达标 */
  sufficient: boolean;
  /** ok=快检+LLM均通过; insufficient=明确不充分(快检或LLM判不足); unknown=LLM校验不可用(仅快检) */
  status: 'ok' | 'insufficient' | 'unknown';
  confidence: number;
  quickCheck: QuickCheck;
  llmCheck?: { sufficient: boolean; reason: string; suggestion: string; missingAspects: string[]; unavailable?: boolean };
  /** 省耗账实(2026-09-06 zx_1 1a): 本次 LLM 校验实际消耗的估算 token（取不到 usage 时按字÷4 估算；0/缺省=未发生 LLM） */
  usage?: number;
}

/**
 * 上善若水：根据任务原型执行自适应输出检查。
 * 水无常形——验证标准随产出类型变化。
 */
function quickFileCheckAdaptive(filePath: string, archetype: string): QuickCheck {
  const issues: string[] = [];
  let fileSize = 0;
  let hasHeader = false;
  let hasBody = false;
  let hasConclusion = false;

  const rules = ARCHETYPE_VALIDATION[archetype] || DEFAULT_RULES;

  try {
    if (!fs.existsSync(filePath)) {
      return { passed: false, issues: ['文件不存在'], fileSize: 0, hasHeader: false, hasBody: false, hasConclusion: false };
    }
    // zx_20261003 M1: 音视频**无文本层可判** ⇒ 只核形态（存在 + 非空），并**如实**标 `unverifiable`
    //   （"未做语义校验"）——既不冒充内容判型，也不因此扣分拦下（拦不拦由 `validateOutput` 统一裁）。
    if (archetype === 'media') {
      const bytes = fs.statSync(filePath).size;
      if (bytes === 0) issues.push('媒体文件为空(0B)');
      return {
        passed: issues.length === 0,
        unverifiable: issues.length === 0 ? '音视频无文本层——仅核形态(存在/非空)，未做语义校验' : undefined,
        issues,
        fileSize: bytes,
        hasHeader: false,
        hasBody: false,
        hasConclusion: false,
      };
    }
    const r = readTextThroughGate(filePath);
    if (!r.ok) {
      // 编码闸 / PDF 抽取挡下 ⇒ **如实**（"读不出文本" ≠ "内容不足"）；不再把读错当判卷结论。
      // `unverifiable` 一路（PDF 抽不出正文）交给 `validateOutput` 判"未校验"；其余（GBK 等解不出文本）
      // 仍作"内容不足"——两条路刻意不混（承 zx_20261002 M17-②）。
      return {
        passed: false,
        issues: [r.issue],
        unverifiable: r.unverifiable ? r.issue : undefined,
        fileSize: r.bytes,
        hasHeader: false,
        hasBody: false,
        hasConclusion: false,
      };
    }
    const content = r.content;
    fileSize = r.bytes;
    if (fileSize < rules.minSize) {
      issues.push(`文件过小(${fileSize}B)，${archetype}类型需至少${rules.minSize}字节`);
    }
    for (const req of rules.requiredPatterns) {
      if (!req.pattern.test(content)) issues.push(`缺少${req.label}`);
    }
    for (const forbid of rules.forbiddenPatterns) {
      if (forbid.pattern.test(content)) issues.push(`包含禁止内容：${forbid.label}`);
    }
    hasHeader = /^#\s+.+/m.test(content);
    hasBody = content.length > 200;
    hasConclusion = /(?:结论|总结|建议|综上所述)/.test(content);
    return { passed: issues.length === 0, issues, fileSize, hasHeader, hasBody, hasConclusion };
  } catch (err) {
    return { passed: false, issues: [`读取文件失败: ${(err as Error).message}`], fileSize: 0, hasHeader: false, hasBody: false, hasConclusion: false };
  }
}

/** 快速检查：文件存在、大小、结构（默认规则，向后兼容） */
function quickFileCheck(filePath: string): QuickCheck {
  const issues: string[] = [];
  let fileSize = 0;
  let hasHeader = false;
  let hasBody = false;
  let hasConclusion = false;

  try {
    if (!fs.existsSync(filePath)) {
      return { passed: false, issues: ['文件不存在'], fileSize: 0, hasHeader: false, hasBody: false, hasConclusion: false };
    }
    const r = readTextThroughGate(filePath);
    if (!r.ok) {
      return { passed: false, issues: [r.issue], fileSize: r.bytes, hasHeader: false, hasBody: false, hasConclusion: false };
    }
    const content = r.content;
    fileSize = r.bytes;
    if (fileSize < 500) issues.push(`文件过小(${fileSize}B)，需至少500字节`);
    hasHeader = /^#\s+.+/m.test(content);
    if (!hasHeader) issues.push('缺少 Markdown 标题(# 开头)');
    hasBody = content.length > 200;
    if (!hasBody) issues.push('正文内容不足');
    hasConclusion = /(?:结论|总结|建议|综上所述)/.test(content);
    if (!hasConclusion) issues.push('缺少结论/总结章节');

    return { passed: issues.length === 0, issues, fileSize, hasHeader, hasBody, hasConclusion };
  } catch (err) {
    return { passed: false, issues: [`读取文件失败: ${(err as Error).message}`], fileSize: 0, hasHeader: false, hasBody: false, hasConclusion: false };
  }
}

/** zx_20260909 桌面修复①: 长结构化文档"头部窗口"漏判——只送文件前6000字符时，O1-O4 等中后段详设/验收全在窗口外，
 *  LLM 会把"没看见"误判为"文档缺失"（实证：A_20260908 方案被反复判 O3/O4 缺失，须把速览挪到头部才能过）。
 *  覆盖式窗口：头部 + 全篇标题大纲 + 结尾三块拼入，让校验员看到结构覆盖与收尾结论，而非只看开头。
 *  纯函数供受控复跑断言：超窗长文 → 返回窗口含大纲+结尾且总字符有界（省耗受控）。 */
/**
 * 覆盖式窗口的**默认尺度**——判据的一部分（改了它，送进 LLM 看的内容就变了），故**一处真源**：
 * 既是 `buildSufficiencyWindow` 的取值，也是下面 `VALIDATION_CRITERIA_VERSION` 取指纹的材料
 * （若在此另抄一份数字，改一处漏一处 ⇒ 版本号与判据脱钩，正是本批要治的病）。
 */
export const SUFFICIENCY_WINDOW_DEFAULTS = { headChars: 6000, tailChars: 4000, outlineChars: 4000 } as const;

export function buildSufficiencyWindow(
  content: string,
  opts?: { headChars?: number; tailChars?: number; outlineChars?: number },
): { text: string; truncated: boolean; totalChars: number } {
  const headChars = opts?.headChars ?? SUFFICIENCY_WINDOW_DEFAULTS.headChars;
  const tailChars = opts?.tailChars ?? SUFFICIENCY_WINDOW_DEFAULTS.tailChars;
  const outlineChars = opts?.outlineChars ?? SUFFICIENCY_WINDOW_DEFAULTS.outlineChars;
  const totalChars = content.length;
  if (totalChars <= headChars + tailChars) {
    return { text: content, truncated: false, totalChars };
  }
  const head = content.slice(0, headChars);
  const outline = (content.match(/^#{1,4}\s.+$/gm) || []).slice(0, 400).join('\n').slice(0, outlineChars);
  const tail = content.slice(-tailChars);
  return {
    text: `${head}\n\n【— 中段略（全文 ${totalChars} 字符，以下为结构概览与结尾，供覆盖性核验）—】\n\n## 文档标题大纲\n${outline || '(无标题大纲)'}\n\n## 文档结尾\n${tail}`,
    truncated: true,
    totalChars,
  };
}

/** zx_20260922_1 M7（F9）：判型的**中文名**——LLM 腿须知道"这份文件是什么"，否则问句没有主语。
 *  zx_20261003 M1: 补 `pdf`（走文档 LLM 腿）/ `media`（不到 LLM 腿，仅备中文名以防他处引用）。 */
const ARCHETYPE_LABELS: Record<string, string> = {
  document: '文档',
  code: '代码',
  configuration: '配置文件',
  pdf: 'PDF 文档',
  media: '音视频',
};

/**
 * zx_20260922_1 M7（F9）：「**量文件，就问文件**」——内容充分性问句的**唯一**构造处：
 * 下面两个模板函数出正文（`sufficiencySystemTemplate` / `sufficiencyAskSkeleton`），
 * `buildSufficiencyPrompt` 把变量填进去装配成对。纯函数，rr 直跑真实现。
 *
 * 病根（活标本：任务 `a290ae2b` 段 5 三次 `finalize_task` 被拒，逐字见方案 §1.3-F9）：
 * 原问句是 `任务: "${title} ${description}"` + `文件内容: …` —— **主语是任务、被量的是文件**，
 * 于是答案记在**文件头上**：一份 `pom.xml` 被判「缺少 git 提交（指定署名、无 Co-Authored-By）」。
 * 六条拒收理由**全是用户的七条要求**，**没有一条**关于那份 POM ⇒ **判据不可能被合法数据满足**
 * （承 auto-memory `feedback_criteria_must_be_satisfiable`）。
 *
 * 治法（用户裁定「问句限定在文件上」，方案 §M7 治法 (a)）：**取消任务题面这条入口**，而不是给它加限定词——
 * 加限定词治不住：原 `system` 里那句「仅当…**且该维度属任务硬性要求时**，才判缺失」本意是防误报，
 * 实际正是**把"任务要求"合法引进"文件判据"的那个入口**，病就是从那儿进来的。
 * 现在 LLM 腿**收不到任何任务文本**（`validateOutput` 的第 3 参已整体删除——不是改名，是**拆掉这条路**：
 * 要再喂任务进来必须改签名，而不是顺手多传一个字符串），它只知道"这是一份什么类型的文件、
 * 这个类型应有哪几样东西"；**结构要求由 `ARCHETYPE_VALIDATION` 一处真源派生**（不另抄一份词表），
 * 问的是「就这份文件自身而言，它是不是言之有物、结构完整」。
 *
 * ⚠ 判据的**严格程度一字未降**：JSON 契约、`sufficient:false` 的义务、窗口外未核验的豁免条款全部照旧，
 * 变的只是**问题的定语**。任务级的完成度**不归这道闸**——它由子任务 / 成果交付 / 验收三道闸管
 * （"文件门"本该只对文件负责）。
 */
/** 充分性问句的**系统提示**——判据本体的一部分（`VALIDATION_CRITERIA_VERSION` 直接对它取指纹）。 */
function sufficiencySystemTemplate(label: string): string {
  return `你是**文件**内容质量验证员。判断**这一份文件自身**是否言之有物、结构完整，输出JSON。

判据只在这份文件**自身**之内：是否含有该类型文件应有之物、论据具体不空泛、结构完整、中文表达流畅、无未填充占位。
⚠ 不得以"任务的其他要求是否完成"为由判缺失——任务的完成度不由这一份文件承担（子任务、成果交付、验收各自有闸）。
你只回答一个问题：**就这份文件自身而言，它作为一份${label}是不是成形、实在的。**

注意：长文件你可能只看到覆盖式窗口（头部 + 标题大纲 + 结尾）。仅当你所见的实际正文确实空泛、或确实缺少**该类型文件自身应有**的构成时，才判缺失；不得仅因"片段窗口外未见"即判缺失——若属窗口外无法核验，请在 missingAspects 注明"（窗口外未核验）"。

严格只输出以下JSON格式，不要其他内容：
{"sufficient":true,"reason":"(一句话原因)","suggestion":"(改进建议，无则空)","missingAspects":["缺失1","缺失2"]}`;
}

/** 充分性问句的**用户侧骨架**——同为判据本体（改这里 = 换了问句，故一并进指纹）。 */
function sufficiencyAskSkeleton(base: string, label: string, structure: string, coverage: string, body: string): string {
  return `被校验的文件: ${base}（类型: ${label}，本类型应有: ${structure}）\n\n文件内容${coverage}:\n${body}\n\n请就**这份文件自身**输出验证JSON：`;
}

export function buildSufficiencyPrompt(
  filePath: string,
  archetype: string,
  content: string,
): { system: string; prompt: string; window: { text: string; truncated: boolean; totalChars: number } } {
  // zx_20260909 桌面修复①: 覆盖式窗口替代"只送前6000字"（防中后段详设被误判缺失）；窗口有界控耗
  const win = buildSufficiencyWindow(content);
  const base = path.basename(filePath) || '(无文件名)';
  const label = ARCHETYPE_LABELS[archetype] ?? '文件';
  const rule = ARCHETYPE_VALIDATION[archetype] || DEFAULT_RULES;
  const structure = rule.requiredPatterns.map((r) => r.label).join('、') || '实质内容';
  const system = sufficiencySystemTemplate(label);
  const coverage = win.truncated ? `(覆盖式窗口: 头部+标题大纲+结尾；全文 ${win.totalChars} 字符)` : '(全文)';
  const prompt = sufficiencyAskSkeleton(base, label, structure, coverage, win.text);
  return { system, prompt, window: win };
}

/**
 * 充分性**判据版本**——由判据自身派生（zx_20260923 M3 / G8）。
 *
 * 病根：`output_validations` 的复用守卫只比对**签名 + 判型**，**判据改了不算变**。
 * zx_20260922_1 M7 把问句从"任务 + 文件"改成"只问文件"（`validateOutput` 第 3 参整体删除），
 * 但同 run 缓存里那条旧结论的 `archetype` 与文件签名都没变 ⇒ **新问句根本不跑**，
 * "问句已改对"这件事在生产上**一次都没生效**——改了说明书，机器还在念旧账。
 *
 * 治法：版本号**不手抄常量**，而是对判据本体取指纹——两个问句模板的源码文本、窗口默认尺度、
 * 判型规则表（含正则源码与 flags）、判型中文名，全部折进摘要。于是：
 *   - **改判据 ⇒ 指纹自动变**，不需要任何人记得去同步一个版本号（手抄常量必然逐轮滚长、漏改）；
 *   - 反过来，若谁把版本号改成与判据脱钩，本函数本身就又成了一处"账与事实不符"。
 * （承本仓 `build` 钉子的同款手法：真源只此一处，别处派生核对。）
 *
 * ⚠ 取的是**模板函数的源码文本**（`Function.prototype.toString`），故连提示词的措辞改动都算换版；
 *   这是刻意的——提示词就是判据。
 */
export const VALIDATION_CRITERIA_VERSION: string = (() => {
  const pats = (r: ArchetypeValidationRule) => ({
    req: r.requiredPatterns.map((p) => [p.label, p.pattern.source, p.pattern.flags]),
    for: r.forbiddenPatterns.map((p) => [p.label, p.pattern.source, p.pattern.flags]),
  });
  const material = JSON.stringify({
    sys: sufficiencySystemTemplate.toString(),
    ask: sufficiencyAskSkeleton.toString(),
    window: SUFFICIENCY_WINDOW_DEFAULTS,
    labels: ARCHETYPE_LABELS,
    def: { minSize: DEFAULT_RULES.minSize, ...pats(DEFAULT_RULES) },
    rules: Object.entries(ARCHETYPE_VALIDATION).map(([k, r]) => ({ k, minSize: r.minSize, ...pats(r) })),
  });
  return createHash('sha1').update(material, 'utf8').digest('hex').slice(0, 12);
})();

/**
 * **这条旧结论还作不作数**——复用守卫的**唯一**判据（纯函数，rr 直跑真实现）。
 *
 * 四条**同时**成立才复用：① 文件签名未变（内容没动过）② 有真结论（`status` 非空且非 `unknown`）
 * ③ 判型一致（zx_20260911_1 M1：`.py` 不再拿文档规则）④ **判据版本一致**（zx_20260923 M3 新增）。
 * ④ 的缺失正是 G8：判据换了版，旧结论的签名与判型却原样"符合" ⇒ 新问句永不执行。
 *
 * 存量条目（M3 之前落的）**没有** `criteriaVersion` 字段 ⇒ `undefined !== 版本` ⇒
 * **视为版本不符**（M3-c：宁可重判一次，不可复用旧误判——这正是"宁可少收"的同款取舍）。
 *
 * ⚠ 返回**类型谓词**（`hit is …`）：调用方写完 `if (canReuseOutputValidation(hit, arch))` 即可直接用
 *   `hit.entry`，**不必**再手写一遍 `hit && …` 的空值检查——判据收在一处，非空也收在一处。
 */
export function canReuseOutputValidation(
  hit: { entry: Record<string, unknown>; sigOk: boolean } | null,
  archetype: string,
): hit is { entry: Record<string, unknown>; sigOk: boolean } {
  return !!(
    hit
    && hit.sigOk
    && hit.entry.status
    && hit.entry.status !== 'unknown'
    && hit.entry.archetype === archetype
    && hit.entry.criteriaVersion === VALIDATION_CRITERIA_VERSION
  );
}

/** LLM 充分性验证——用 generateText + JSON 解析替代 generateObject，适应更多模型 */
async function llmSufficiencyCheck(
  ansClient: AnsClient,
  filePath: string,
  archetype: string,
): Promise<{ sufficient: boolean; reason: string; suggestion: string; missingAspects: string[]; unavailable?: boolean; usage?: number }> {
  try {
    const modelResult = await ansClient.getOptimalModel(auxModelRequest({ strategy: 'balanced' }));
    if (!modelResult?.url || !modelResult?.api_key || !modelResult?.model_name) return { sufficient: true, reason: '无可用模型', suggestion: '', missingAspects: [], unavailable: true };

    // zx_20261002 M17-②: 与 `read_file` 同一道编码闸；解不出 ⇒ 走"校验不可用"一路（**不冒充**内容充分，
    //   也不把读错说成内容缺陷）。
    const r = readTextThroughGate(filePath);
    if (!r.ok) {
      logger.info({ filePath: filePath.replace(/.*\//, '') }, 'LLM验证跳过：成果非 UTF-8/BOM 可解码文本');
      return { sufficient: true, reason: `无法按 UTF-8/BOM 解码，内容校验跳过`, suggestion: '请将成果转存为 UTF-8', missingAspects: [], unavailable: true };
    }
    const content = r.content;
    const { system, prompt, window: win } = buildSufficiencyPrompt(filePath, archetype, content);
    const provider = createSafeProvider({ baseURL: modelResult.url, apiKey: modelResult.api_key });
    const result = await generateText({
      model: provider(modelResult.model_name),
      system,
      prompt,
      temperature: 0,
      maxTokens: 2000,
      abortSignal: AbortSignal.timeout(30_000),
    });

    const text = result.text.trim().replace(/^```json\s*/, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(text) as { sufficient: boolean; reason: string; suggestion: string; missingAspects: string[] };
    // 省耗账实(1a): 把本次 LLM 校验真实/估算 token 一并返回（供 executor 记入执行期账本）
    const u = (result as { usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }).usage;
    const llmTokens = u?.totalTokens ?? ((u?.promptTokens ?? 0) + (u?.completionTokens ?? 0));
    return {
      sufficient: parsed.sufficient ?? true,
      reason: parsed.reason || '',
      suggestion: parsed.suggestion || '',
      missingAspects: Array.isArray(parsed.missingAspects) ? parsed.missingAspects : [],
      // zx_20260922_1 M7（F9）：估算基准跟着问句走——任务题面已不在输入里，改按**真正送出的**
      // system+prompt 长度估算（原式 `win.text.length + taskDescription.length` 既含不再送出的题面、
      // 又漏掉窗口以外的提示词骨架）。
      usage: llmTokens || estimateTokensFromChars(system.length + prompt.length + text.length),
    };
  } catch (err) {
    // zx_20260904_3 批4 (2026-09-04): LLM 校验不可用 → 标记 unavailable，不再冒充"内容充分"
    //（fail-open 修复：unknown 态计入 status，避免把"未校验"当"校验通过"）
    logger.info({ filePath: filePath.replace(/.*\//, ''), reason: (err as Error).message?.slice(0, 60) }, 'LLM验证不可用，降级为仅快速检查');
    return { sufficient: true, reason: 'LLM校验不可用(仅快速检查通过)', suggestion: '', missingAspects: [], unavailable: true };
  }
}

/**
 * 验证产出物是否充分满足任务要求。
 * 快速检查（文件存在/大小/结构）→ LLM 充分性验证。
 *
 * zx_20260922_1 M7（F9）：第 3 参原为 `taskDescription`（调用方传的是 `title + description`），
 * **已整体删除**——它正是"主语是任务、被量的是文件"这条病根的入口（详见 `buildSufficiencyPrompt`）。
 * 删除而非改名，是刻意的：要再把任务文本喂进文件判据，必须**改签名**，不能顺手多传一个字符串。
 */
export async function validateOutput(
  ansClient: AnsClient,
  filePath: string,
  archetype: string = 'document',
): Promise<ValidationResult> {
  const quick = quickFileCheckAdaptive(filePath, archetype);
  // zx_20261003 M1: **判不出内容 ≠ 判成不足**——PDF 抽不出正文 / 音视频无文本层，一律判"未校验"
  //   （`status:'unknown'`：放行 + 如实记账），绝不冒充内容缺陷、也不因此拦下收口。
  //   ⚠ 先于 `passed` 判：这类产出的 `passed` 可能为 false（因为压根没跑文本规则），但那是"没量"不是"不合格"。
  if (quick.unverifiable) {
    return { sufficient: true, status: 'unknown', confidence: 0.5, quickCheck: quick };
  }
  if (!quick.passed) {
    return { sufficient: false, status: 'insufficient', confidence: 0, quickCheck: quick };
  }

  // zx_20260911_1 M1（实践论）: 代码产出的判据是"能不能跑通"，不是"读起来像不像结论"。
  // 用 LLM 充分性校验（提示词为文件"内容"是否充分，是文档判据）去量代码，既无意义又白耗一次旁路 LLM。
  // 故 code 原型止于结构性快检；document/analysis/research 等仍走 LLM 腿（⚠ zx_20260922_1 M7 只改
  // 了**这条腿的问句主语**，未动"谁走这条腿"——"照旧"二字自此仅指后者，见下方 M7 注记）。
  //
  // zx_20260922_1 M3（F6b）: `configuration` 并入此支——**同一句理由逐字适用**。一份 `pom.xml`/`*.json`
  // 的"够不够"，看的是它是不是一份成形的声明式配置，不是"读起来像不像任务结论"。若只把它接到
  // 快检之后交给文档判据的 LLM，等于刚把词表尺换成结构尺、又原样盖上一枚文档章——病只治了一半。
  // 结构快检是这一档的**全部**判据（与 code 同制）。此变更**放宽**了 configuration 的放行面，
  // 反向断言见 `rr_zx_20260922_1` M3-B（只有 TODO 的 .sql / 空 .properties 仍判不足）。
  if (archetype === 'code' || archetype === 'configuration') {
    return { sufficient: true, status: 'ok', confidence: 0.7, quickCheck: quick };
  }

  // zx_20260922_1 M7（F9）：LLM 腿**只知道判型**（这份文件该有什么），不知道任务题面。
  // 问句与"该类型应有的结构"由 `buildSufficiencyPrompt` 一处构造（纯函数，rr 直跑真实现）；
  // 旧断言 `rr_zx_20260911_1` S3 那条"LLM 校验照旧（刻意不改）"已就地改钉——它钉的是**旧问句的形状**，
  // 而那个形状正是本批要拆的（改钉后更强：钉"任务题面已不在输入里"，不是改成"存在即通过"）。
  const llm = await llmSufficiencyCheck(ansClient, filePath, archetype);
  const status: ValidationResult['status'] = llm.unavailable ? 'unknown' : llm.sufficient ? 'ok' : 'insufficient';
  return {
    sufficient: llm.sufficient,
    status,
    confidence: llm.sufficient ? 0.85 : 0.4,
    quickCheck: quick,
    llmCheck: llm,
    usage: llm.usage,
  };
}

