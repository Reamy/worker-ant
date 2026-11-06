/**
 * zx_20261029_1 「知」——项目须知的后台生成作业（唯一调 LLM 的那一段）。
 *
 * 分工：`project-brief.ts` 负责零 LLM 的采样/提示词/解析/渲染/落库；
 *   本模块只做"取模型 → 一次有界 generateText → 解析 → 落账"。
 *   生成器可注入（rr 用假生成器直跑真实现；生产缺省 `createSafeProvider + generateText`）。
 *
 * ⚠ 一次生成一次调用：输入 ≤ `BRIEF_INPUT_MAX_CHARS`，输出 ≤ ANS 报的 `max_output_tokens`
 *   （未报则 `BRIEF_MAX_OUTPUT_TOKENS` 兜底）；超时 `BRIEF_GENERATE_TIMEOUT_MS`；
 *   失败写人话原因，且**不清空上一份成功须知**（`saveBriefFailed` 的语义）。
 * ⚠ 单飞：同一项目并发入队只跑一次（进程内锁；跨进程锁不在本轮范围）。
 */
import type Database from 'better-sqlite3';
import type { AnsClient } from '@worker-ant/ans-client';
import { createLogger } from './logger.js';
import { auxModelRequest } from './model-request.js';
import { estimateTokensFromChars } from './token-estimate.js';
import {
  BRIEF_INPUT_MAX_CHARS, PROJECT_BRIEF_MAX_TOKENS,
  buildProjectBriefPrompt, collectProjectBriefInputs, decideAutoInit,
  markBriefRunning, parseProjectBrief, saveBriefFailed, saveBriefReady,
} from './project-brief.js';

const logger = createLogger('project-brief');

/**
 * 模型输出 token 的**兜底**上界（ANS 未报 `max_output_tokens` 时才用它）。
 * ⚠ 这份预算**思维链也吃**：实测 `qwen3.5:9b`（ANS 选出的 balanced 档）1500 全花在思考上、
 *   `finish=length` 且正文为空 ⇒ 须知恒失败。故**优先照 ANS 报的上限**（与仓内其它辅助路
 *   `m.max_output_tokens || 4096` 同一口径），不在本处再往下压——压下去就是把思考模型饿死。
 *   另：ANS 可能把 thinking 模型也发下来（能力标签不拦人），不能假定拿到的一定是非思考模型。
 */
export const BRIEF_MAX_OUTPUT_TOKENS = 4096;
/**
 * 单次生成超时。**须 ≤ 详情页的跟进窗口**（renderer：1.5s 首跳 + 59×3s = 178.5s）：
 *   否则作业还在跑、界面已经放弃跟进，用户看到"生成中…"消失却既无结果也无原因。
 *   给足是因为本地思考模型冷启时一次要 100s+（实测 113s / 3537 tokens）。
 */
export const BRIEF_GENERATE_TIMEOUT_MS = 170_000;

export interface BriefGenerateInput {
  baseURL: string;
  apiKey: string;
  model: string;
  prompt: string;
  signal: AbortSignal;
  maxTokens: number;
}

export interface BriefGenerateResult {
  text: string;
  usage?: { promptTokens?: number; completionTokens?: number; outputTokens?: number; inputTokens?: number };
  /** 厂商给的结束原因（`stop`/`length`…）；空正文时据此说清"是截断还是模型没说话"。 */
  finishReason?: string;
}

export type BriefGenerateFn = (input: BriefGenerateInput) => Promise<BriefGenerateResult>;

/** 生产缺省：AI SDK v4 `generateText` + 唯一 provider 工厂（动态 import，避免 rr 拉进 provider）。 */
const defaultGenerate: BriefGenerateFn = async (input) => {
  const [{ generateText }, { createSafeProvider }] = await Promise.all([
    import('ai'),
    import('./ai-provider.js'),
  ]);
  const provider = createSafeProvider({ baseURL: input.baseURL, apiKey: input.apiKey });
  const r = await generateText({
    model: provider(input.model),
    prompt: input.prompt,
    temperature: 0.1,
    maxTokens: input.maxTokens,
    abortSignal: input.signal,
  });
  return { text: r.text ?? '', usage: r.usage as BriefGenerateResult['usage'], finishReason: r.finishReason };
};

const running = new Set<string>();

export interface RunProjectBriefInitDeps {
  db: Database.Database;
  ansClient: AnsClient;
  projectId: string;
  trigger: string;
  generate?: BriefGenerateFn;
}

export interface RunProjectBriefInitResult {
  ok: boolean;
  /** 已有同项目生成在跑 ⇒ 本次未执行（不是失败）。 */
  skipped?: boolean;
  reason?: string;
  tokensIn?: number;
  tokensOut?: number;
}

/** 从 usage 读真值；缺席则按字符估并如实返回。 */
function readUsage(
  usage: BriefGenerateResult['usage'] | undefined,
  promptChars: number,
  outChars: number,
): { tokensIn: number; tokensOut: number } {
  const inTok = usage?.promptTokens ?? usage?.inputTokens ?? 0;
  const outTok = usage?.completionTokens ?? usage?.outputTokens ?? 0;
  return {
    tokensIn: inTok > 0 ? inTok : estimateTokensFromChars(promptChars),
    tokensOut: outTok > 0 ? outTok : estimateTokensFromChars(outChars),
  };
}

/**
 * 跑一次项目须知生成。**永不抛出**：所有失败都落 `saveBriefFailed` 并返回 `{ok:false, reason}`。
 */
export async function runProjectBriefInit(deps: RunProjectBriefInitDeps): Promise<RunProjectBriefInitResult> {
  const { db, ansClient, projectId, trigger } = deps;
  if (!projectId) return { ok: false, reason: '缺少项目 id' };
  if (running.has(projectId)) return { ok: true, skipped: true, reason: '同一项目的须知正在生成' };
  running.add(projectId);

  try {
    const proj = db.prepare('SELECT name, working_dir FROM wa_projects WHERE id = ?')
      .get(projectId) as { name?: string; working_dir?: string } | undefined;
    if (!proj) return { ok: false, reason: '项目不存在' };

    const workingDir = String(proj.working_dir ?? '');
    const auto = decideAutoInit(workingDir);
    if (!auto.run && auto.reason !== '工作目录为空') {
      // 不存在/不可读/未设置 ⇒ 没什么可读的，直接如实记失败
      saveBriefFailed(db, projectId, `无法读取工作目录：${auto.reason}`, trigger);
      return { ok: false, reason: auto.reason };
    }

    markBriefRunning(db, projectId, trigger);

    const inputs = await collectProjectBriefInputs(workingDir);
    if (inputs.files.length === 0 && inputs.tree.length === 0) {
      const reason = auto.reason === '工作目录为空' ? '工作目录为空，没有可读的资料' : '未读到可用的仓库资料';
      saveBriefFailed(db, projectId, reason, trigger);
      return { ok: false, reason };
    }

    const m = await ansClient.getOptimalModel(auxModelRequest({ strategy: 'balanced' }));
    if (!m?.url || !m?.api_key || !m?.model_name) {
      const reason = '无可用 chat 模型（ANS 未连接或无可用模型）';
      saveBriefFailed(db, projectId, reason, trigger);
      return { ok: false, reason };
    }

    const prompt = buildProjectBriefPrompt(inputs, String(proj.name ?? ''));
    if (prompt.length > BRIEF_INPUT_MAX_CHARS * 2) {
      // 防御：提示词主体受采样预算约束，超出的只可能是包装文本；仍以采样上限为准
      logger.warn({ projectId: projectId.slice(0, 8), chars: prompt.length }, 'project-brief: 提示词异常偏长');
    }

    const generate = deps.generate ?? defaultGenerate;
    const result = await generate({
      baseURL: m.url,
      apiKey: m.api_key,
      model: m.model_name,
      prompt,
      signal: AbortSignal.timeout(BRIEF_GENERATE_TIMEOUT_MS),
      maxTokens: m.max_output_tokens || BRIEF_MAX_OUTPUT_TOKENS,
    });

    const brief = parseProjectBrief(result.text || '');
    if (!brief) {
      const preview = String(result.text || '').replace(/\s+/g, ' ').slice(0, 200);
      // 空正文 + `finish=length` ⇒ 预算被思考吃光（见 BRIEF_MAX_OUTPUT_TOKENS 注）。说清病根，
      //   别让人对着"响应开头：空"猜是模型坏了还是没配额。
      const exhausted = !preview && result.finishReason === 'length';
      const reason = exhausted
        ? `模型未产出正文：输出预算（${BRIEF_MAX_OUTPUT_TOKENS} tokens）在思考阶段用尽（finish=length），可换非思考模型或调高预算`
        : `模型未返回可解析的须知 JSON（响应开头：${preview || '空'}）`;
      saveBriefFailed(db, projectId, reason, trigger);
      return { ok: false, reason };
    }

    const { tokensIn, tokensOut } = readUsage(result.usage, prompt.length, String(result.text || '').length);
    saveBriefReady(db, projectId, {
      brief,
      sourceHash: inputs.fingerprint,
      model: m.model_name,
      tokensIn,
      tokensOut,
      trigger,
    });
    logger.info(
      { projectId: projectId.slice(0, 8), files: inputs.files.length, tree: inputs.tree.length, tokensIn, tokensOut },
      'project-brief: 生成完成',
    );
    return { ok: true, tokensIn, tokensOut };
  } catch (err) {
    const msg = (err as Error)?.message || String(err);
    try { saveBriefFailed(db, projectId, `生成失败：${msg}`, trigger); } catch { /* 落账失败不吞掉原始错误 */ }
    logger.warn({ projectId: projectId.slice(0, 8), errMsg: msg }, 'project-brief: 生成失败');
    return { ok: false, reason: msg };
  } finally {
    running.delete(projectId);
  }
}

/** rr / 自检用：是否仍有同项目生成在跑（只读观测）。 */
export function isProjectBriefRunning(projectId: string): boolean {
  return running.has(projectId);
}

/** 渲染须知时也受同一 token 上界（此处重导出，免消费侧再引一个常量来源）。 */
export { PROJECT_BRIEF_MAX_TOKENS };
