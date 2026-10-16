/**
 * 推理模型 CoT 流式上屏（PLAN_zx_20260903_cot Phase 1）
 * **＋ thinking 模式的请求侧兼容**（zx_20260923 M2 / G1）。
 *
 * 背景：DeepSeek R1 等推理模型在 chat-completions SSE 里通过 `choices[0].delta.reasoning_content`
 * 返回思考过程（CoT），但 @ai-sdk/openai 的 chat-completions 解析只读 `delta.content`（产出 text-delta），
 * `reasoning_content` 在 provider 适配层被丢弃——故思考过程需在原始 SSE 层旁路提取。
 *
 * ## 从"只读一半"到"读写都在这一处"（M2-b）
 *
 * 上面那件事只治了**响应侧**。服务端另有一条**请求侧**的硬要求，本仓此前**一个字都没做**：
 * 标本 `a290ae2b` 上服务端逐字判过 ——
 * `The \`reasoning_content\` in the thinking mode must be passed back to the API.`
 * 于是"同一件兼容"被拆成两半、各落一处：主聊天路只做展示提取（不回传），旁路 `createSafeProvider`
 * 只删 `tool_choice`（不提取、不回传）。本模块把两半合回一处：`backfillReasoningContent` 负责回传。
 *
 * ## 探针（M2-a）：只坐实"形状"，正文一个字不落盘
 *
 * "哪一次请求触发它"**离线坐实不了**：失败前一次与失败那一次的形状逐项相同（都是
 * `assistant(文本) → [工具调用] → tool 结果`），且 `wa_task_conversations.tool_calls` 列全表为空、
 * 连"带没带 tool_calls"都只能从 `[工具调用]` 系统行反推。故落一份**脱敏形状指纹**（长度 + 前 8 位哈希），
 * 供真机回填时把"成功那几次"与"失败那一次"摊开对比。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 一回合 = 一次流式响应里模型产出的东西：正文（对齐用）+ 思考（回填用）。 */
export interface ReasoningTurn {
  text: string;
  reasoning: string;
}

/**
 * 把**本回合累计的** `reasoning_content` 回填进**出网请求体**的 assistant 消息（返回是否改动）。
 *
 * 对齐规则：请求体里的 assistant 消息由 SDK **按步追加** ⇒ 第 k 条 assistant 消息就是第 k 回合的产物。
 * 只回填**确实产出过 reasoning 的回合**——非 thinking 模型永不产出 `reasoning_content`，
 * 于是这条路对它们**零改动**（"该不命中"那一半；"该命中"那一半由 rr 用真 SDK 往返钉）。
 *
 * 每次请求都重新回填，不"改一次就记住"：SDK 自己持有 messages，我们的改写只作用于**出网那一份** ⇒
 * 重来一遍既必要、又天然幂等。
 */
export function backfillReasoningContent(body: unknown, turns: readonly ReasoningTurn[]): boolean {
  if (!turns.length) return false;
  if (!body || typeof body !== 'object') return false;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return false;
  let k = 0;
  let changed = false;
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const msg = raw as Record<string, unknown>;
    if (msg.role !== 'assistant') continue;
    const turn = turns[k++];
    if (!turn?.reasoning) continue;
    if (msg.reasoning_content !== undefined) continue; // 服务端/SDK 自己带了 ⇒ 不覆盖
    msg.reasoning_content = turn.reasoning;
    changed = true;
  }
  return changed;
}

/**
 * M2-a 探针的落点。`dir` **由调用方注入**（本模块不自行解析 dataDir——与 `deliverable-lifecycle` 同款纪律，
 * 保持可被 rr 直跑真实现）。不传 `probe` = 探针关，无隐藏默认开关。
 */
export interface ReasoningProbe {
  dir: string;
  /** 一份 = 一次 run（真源：调用方给 `taskId`） */
  tag: string;
}

/** 进程内已为哪些 tag 截断过（一个 Electron 主进程 ≈ 一次 run 周期 ⇒ 这就是"随 run 清理"） */
const probeTruncated = new Set<string>();

function probeWrite(probe: ReasoningProbe, entry: Record<string, unknown>): void {
  try {
    const first = !probeTruncated.has(probe.tag);
    if (first) { probeTruncated.add(probe.tag); fs.mkdirSync(probe.dir, { recursive: true }); }
    fs.writeFileSync(path.join(probe.dir, `${probe.tag}.jsonl`), JSON.stringify(entry) + '\n', { flag: first ? 'w' : 'a' });
  } catch { /* 探针只做见证，绝不阻断执行 */ }
}

const sha8 = (s: string): string => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);

/**
 * 请求体形状指纹（**脱敏**：只记长度与前 8 位哈希，正文一字不落盘）。
 *
 * 要坐实的那件事——"失败那一次的 assistant 消息与成功那几次差在哪"——恰好全在这个指纹里：
 * `hasReasoningContent` / `toolCalls` / `contentLen` 三项并列，就足以把形状差摊开。
 */
export function requestShape(body: unknown, turns: readonly ReasoningTurn[]): Record<string, unknown> {
  const src = (body ?? {}) as Record<string, unknown>;
  const list = Array.isArray(src.messages) ? src.messages : [];
  return {
    model: src.model,
    toolChoice: 'tool_choice' in src,
    backfilledTurns: turns.length,
    messages: list.map((raw) => {
      const m = (raw ?? {}) as Record<string, unknown>;
      const content = typeof m.content === 'string' ? m.content : '';
      const rc = typeof m.reasoning_content === 'string' ? m.reasoning_content : '';
      return {
        role: m.role,
        contentLen: content.length,
        contentSha8: content ? sha8(content) : '',
        hasReasoningContent: m.reasoning_content !== undefined,
        reasoningLen: rc.length,
        toolCalls: Array.isArray(m.tool_calls) ? m.tool_calls.length : 0,
      };
    }),
  };
}

export function createReasoningAwareFetch(options: {
  /**
   * 思考过程**上屏**回调。**它只管上屏**——不给也照样累计回合、照样回填。
   *
   * ⚠ 初版把"响应侧包装"整个挂在这个回调上（"不要上屏就不解析"），是**错的**：
   * 回填要的是"这一回合产出了什么"，与"要不要给人看"是两件事。主聊天路恰好两者都要，
   * 才让这个耦合一直没露头——而它一旦露头就是"上屏关掉 ⇒ 回传静默失效"（正是本轮的病形）。
   */
  onReasoningDelta?: (text: string) => void;
  baseFetch?: typeof fetch;
  probe?: ReasoningProbe;
}): typeof fetch {
  const base = options.baseFetch ?? globalThis.fetch;
  const decoder = new TextDecoder();
  /**
   * 本实例生命周期内产出的回合（按序）。**实例的生命周期 = 一次 `streamText` 调用**（provider 由
   * `executeTask` 每次执行现造），故这个数组正好覆盖"一次多步工具循环"里的全部回合。
   */
  const turns: ReasoningTurn[] = [];

  return async function reasoningAwareFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
    // ── 请求侧（M2-b/M2-c）：`tool_choice` 删除 + `reasoning_content` 回填 —— 两半兼容的唯一落笔口 ──
    if (init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        let dirty = false;
        if (body.tool_choice !== undefined) { delete body.tool_choice; dirty = true; }
        if (backfillReasoningContent(body, turns)) dirty = true;
        if (options.probe) probeWrite(options.probe, { at: new Date().toISOString(), phase: 'request', ...requestShape(body, turns) });
        if (dirty) init = { ...init, body: JSON.stringify(body) };
      } catch { /* body 非 JSON ⇒ 原样透传 */ }
    }

    const res = await base(input, init);
    // 探针响应侧：**只在出错时**读（`clone()` 取副本，不动 SDK 要读的那条支路）
    if (options.probe && res.status >= 400) {
      const probe = options.probe;
      void res.clone().text()
        .then((t) => probeWrite(probe, { at: new Date().toISOString(), phase: 'response', status: res.status, error: t.slice(0, 500) }))
        .catch(() => {});
    }
    if (!res.body) return res; // 无 body（非流式/错误）直接透传

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    // 旁路解析的跨 chunk 行缓冲（仅保留不完整尾行，避免长回复内存累积）
    let buf = '';
    // 本回合的产出（正文用于与下一条 assistant 消息对齐，思考用于回填）
    let turnText = '';
    let turnReasoning = '';
    /** 见过 `choices` 才算"真产出了一回合"——错误体/非流式 JSON 不占位，否则后续对齐会整体错位一位 */
    let sawChoices = false;

    // 手动 ReadableStream：pull 在下游( SDK )请求数据时拉取原始 body 并原样转发；
    // 每次转发前旁路解析已完成的 SSE data 行，提取 reasoning_content。
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = await reader.read().catch((err: unknown) => { controller.error(err); return null; });
        if (chunk === null) return;
        if (chunk.done) {
          // ⚠ 在 `close()` **之前**入账：下游拿到 done 就会去发下一轮请求，那一轮要读这份 turns
          if (sawChoices) turns.push({ text: turnText, reasoning: turnReasoning });
          controller.close();
          return;
        }
        // 透传：原始字节原样给下游（不重编码、不重排）
        controller.enqueue(chunk.value);
        // 旁路：解码 + 按行累积 + 提取 reasoning_content
        buf += decoder.decode(chunk.value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const obj = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }> };
            if (!obj?.choices) continue;
            sawChoices = true;
            const delta = obj.choices[0]?.delta;
            const r = delta?.reasoning_content;
            if (typeof r === 'string' && r) { turnReasoning += r; options.onReasoningDelta?.(r); }
            const c = delta?.content;
            if (typeof c === 'string' && c) turnText += c;
          } catch { /* 非 JSON 或解析失败静默（不影响透传） */ }
        }
      },
      // SDK abort（如 agent 中断）→ 取消原始 body 读取，避免泄漏/挂起
      cancel(reason?: unknown) {
        void reader.cancel(typeof reason === 'string' ? reason : undefined);
      },
    });

    return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}
