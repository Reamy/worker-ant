/**
 * zx_20260921_1 受控复跑 —— 「说成它听得懂的样子」。
 *
 * 病根（`plans/improve/zx_20260921_1.md` §1，真库 + 真调用实测）：
 * **我们把请求按"我们以为的形状"发出去，而不是按"对方读的形状"发出去——而形状本来就是契约的一部分。**
 * 上一轮（`zx_20260921`）治的是"东西做出来了、插头没插上"；本轮治的是**插头插上了、但插脚的形状不对**：
 *   E1 `input_audio.data` 发**裸 base64**，而 DashScope 把它当 **URL** 解析 ⇒ 要 `data:;base64,<b64>`。
 *      实测：裸 base64 ⇒ HTTP 400 `The provided URL does not appear to be valid`；
 *            加前缀 ⇒ HTTP 200 + 逐字正确的转写。**形状是接收方的属性，不是我们的偏好。**
 *   E2 URL 拼接只认 `/v1` ⇒ `/v1beta`(google)、`/api/v3`(bytedance)、`/api/paas/v4`(zhipu) 全拼错。5 处落点。
 *   E3 零命中时 ANS 回 `{error:{code:'NOT_FOUND'}}`（HTTP 200），桌面**当模型对象收下** ⇒ 四种成因读成同一句话。
 *   E4 `audio` 标签语义未定；12/52 带标，只有 1 个真能被选中。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 本文件的**批次门**（`RR_STAGE`）—— 承前若干轮的骨架纪律，同样的道理：
 *   方案 §2 是五个批次（M1…M5），判据**随批次转绿**。若不做区分，M1 落下时本脚本一片红，
 *   而"红"既可能是"还没实施"也可能是"实施错了"，两者混在一起**信息量为零**。
 *   故：每条判据登记其**所属批次**；`RR_STAGE=Mn` 时**只要求 ≤Mn 的批次**为绿，
 *   更晚的批次打 `⏳` 并**不计入失败**。`RR_STAGE` 为空 = **全部必须绿**（M5 收口用）。
 *
 * §G 判据 G（**不变式门**，与批次无关，任何时刻都须成立）：
 *   G-1 **真源在位**：本轮四条病根所引用的生产符号**全部存在**——由**静态 import** 保证
 *       （符号被删/被改名 ⇒ **编译期失败**，而不是"扫字符串扫了个空、静默假绿"）。
 *   G-2 **扫描面自证**：凡"唯一一处 / 零处"类断言必须同时报出**扫描面命中数**
 *       （承 `zx_20260920_1 §G-1` 的教训："扫描面无匹配 ⇒ 零处违规恒真"，扫了个空也是绿）。
 * §C 判据 C（**随批次转绿**，`RR_STAGE` 管辖）：
 *   C1–C5（M1 音频 `data` 形状按接收方分叉）·
 *   C6–C8（M2 零命中时说得出为什么）·
 *   C9–C12（M3 URL 拼接归一处真源）·
 *   C13–C14（M4 `audio` 的名定死）。
 * §S 判据 S：`checkBuildPins(ok, { distDir })`（P1–P6 全套）—— **不受批次门管辖**：
 *   build 钉是**常驻不变式**（它派生标签，故换轮不会让它变红；它变红只说明真源被破坏）。
 *
 * ⚠ **判据一律跑生产真实现**：形状取 `buildInputAudioPart` 本体、期望值取 `audioDataShapeOf` 现算，
 *   **夹具里零处手抄 host 字面量、零处写死"本轮为真"的值**（承 `feedback_assertion_no_forward_literals`）。
 * ⚠ 末尾 build 钉读 `dist` ⇒ **tsup 必须先于本脚本**（P6 取产物内 build 值本身，而非会被注释骗过的子串匹配）。
 * ⚠ 与 `zx_20260921.ts` 的**分工**：那一份治"插头要插上"（已收口）；本份治"插脚的形状"，**互不覆盖**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：本轮四条病根引用的生产符号，**全部静态导入** ⇒ 被删/改名即编译期失败。
import {
  AUDIO_CAPABILITY,
  AUDIO_DATA_URL_HOSTS,
  AUDIO_DATA_URL_PREFIX,
  AUDIO_IO,
  audioDataShapeOf,
  buildInputAudioPart,
  describeModelSelectionFailure,
  makeAudioTranscriber,
  transcribeAudio,
  type AudioEndpoint,
} from '../apps/worker-ant-desktop/src/main/core/audio-transcribe.js';
// M2 C8：主聊天路的**生产真实现**（判据要证的是它行为不变，故必须跑它本体）。
import { selectModelForTask } from '../apps/worker-ant-desktop/src/main/core/exec-model-select.js';
// M3 C9–C12：URL 拼接的**唯一真源**。承 G-1——静态导入 ⇒ 被删/改名即编译期失败。
import { resolveChatCompletionsUrl } from '../packages/ans-client/src/chat-url.js';
// M4 C13/C14：`audio` 语义的**真源**。承 G-1——静态导入 ⇒ 被删/改名即编译期失败，
//   而不是"扫字符串扫了个空、静默假绿"。⚠ renderer **不能** import 它（未依赖该包，见方案 M4 细化规划），
//   故 renderer 侧只能按**文本**核对；这也正是本批要防的"第二个落点漂移"。
import {
  AUDIO_CAPABILITY_SEMANTICS,
  AUDIO_CAPABILITY_NOT_REGISTERED,
  AUDIO_CAPABILITY_CONTESTED,
  MODEL_CAPABILITY_META,
  MODEL_NAME_CAPABILITY_HINTS,
} from '../packages/shared-types/src/models.js';

let pass = 0; let fail = 0; let pending = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ── 批次门 ──────────────────────────────────────────────────────────────────
const ORDER = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5'] as const;
type Batch = (typeof ORDER)[number];
const STAGE = (process.env.RR_STAGE || '').trim() as Batch | '';
/** STAGE 为空 ⇒ 全部须绿；否则**只要求 ≤STAGE 的批次**为绿（更晚的如实标"待实施"，不计入失败）。 */
const required = (b: Batch): boolean => STAGE === '' || ORDER.indexOf(b) <= ORDER.indexOf(STAGE);
/**
 * 登记一条**受批次门管辖**的判据。
 * ⚠ 未实施批次的判据**必须仍然求值**（不能短路成 `false` 了事）：本文件要的是"红**为什么**红"，
 *   故照常算出真值，只是**不计入**失败——这样收口时把门一开，看到的都是**真值**而非占位。
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
/** 扫源码一律**去注释**：病根正是"注释里写着有、代码里没被用上"，不去注释则判据会被喂饱。 */
const strip = (p: string) => stripKeepingLines(fs.readFileSync(p, 'utf-8')).join('\n');

async function main(): Promise<void> {
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【G】不变式门（与批次无关，任何时刻都须成立）');
  {
    // G-1 由**静态 import** 保证（编译期失败）；此处报出取到的真值，防"导进来了但是空值"。
    ok(AUDIO_DATA_URL_HOSTS.length >= 1 && AUDIO_DATA_URL_PREFIX.length > 0 && AUDIO_CAPABILITY === 'audio',
      'G-1 真源在位且**非空**：`AUDIO_DATA_URL_HOSTS` / `AUDIO_DATA_URL_PREFIX` / `AUDIO_CAPABILITY` 都取到了真值',
      `hosts=[${AUDIO_DATA_URL_HOSTS.join(',')}] / prefix=${JSON.stringify(AUDIO_DATA_URL_PREFIX)} / cap=${AUDIO_CAPABILITY}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【C】M1 —— 音频 `data` 形状**按接收方分叉**（E1）');
  {
    /** 喂进去的字节：**故意不是真 wav**——判据要证的是"原样往返"，不是"wav 解析得对"。 */
    const bytes = Buffer.from('RIFF-fake-wav-payload-for-shape-probe');
    const bytesOf = (data: string): Buffer => Buffer.from(data, 'base64');

    // ── C1 **该命中**：名单内每个 host ⇒ 必须带前缀，且**剥前缀后**往返无损 ──────────────
    crit('M1', AUDIO_DATA_URL_HOSTS.length >= 1,
      'C1 **扫描面自证**：`AUDIO_DATA_URL_HOSTS` 非空（否则下面的遍历**空转即绿**，验的是空气）',
      `hosts=[${AUDIO_DATA_URL_HOSTS.join(',')}]`);
    for (const h of AUDIO_DATA_URL_HOSTS) {
      const ep: AudioEndpoint = { url: `https://${h}/compatible-mode/v1`, api_key: 'k', model_name: 'm1' };
      const part = buildInputAudioPart(ep, bytes, 'wav');
      const data = part.input_audio.data;
      const prefixed = data.startsWith(AUDIO_DATA_URL_PREFIX);
      const payload = prefixed ? data.slice(AUDIO_DATA_URL_PREFIX.length) : data;
      const roundtrip = bytesOf(payload).equals(bytes);
      // **旧判据形**（不剥前缀直接解）——见 C3，它是"判据自身也受判据管"的那一面。
      const legacy = bytesOf(data).equals(bytes);
      crit('M1',
        audioDataShapeOf(ep) === 'data-url' && part.type === 'input_audio' && prefixed && roundtrip && part.input_audio.format === 'wav',
        `C1 **该命中**（${h}）：形状由接收方定 ⇒ \`data\` 带 \`${AUDIO_DATA_URL_PREFIX}\`、**剥前缀后**解回来与喂进去逐字节相同、\`format\` 原样带出`,
        `shape=${audioDataShapeOf(ep)} / 前缀=${prefixed} / 往返=${roundtrip} / format=${part.input_audio.format}`);
      crit('M1', !legacy,
        `C1 反面标本（${h}）：**旧判据形**（不剥前缀直接 base64 解）在此支上**必假** —— 若它仍为真，说明前缀根本没加上、本批等于没做`,
        `旧形往返=${legacy}`);
    }

    // ── C2 **该不命中**：名单外 host ⇒ 仍须**裸 base64**（OpenAI 家族形状，一刀切会把它们打坏）──
    const epOther: AudioEndpoint = { url: 'https://api.example.test/v1', api_key: 'k', model_name: 'm1' };
    const otherHost = new URL(epOther.url).hostname;
    crit('M1', !AUDIO_DATA_URL_HOSTS.includes(otherHost),
      'C2 **标本合格性**：下面这只"该不命中"标本的 host **确实不在** `AUDIO_DATA_URL_HOSTS` 里（否则它证不了另一面）',
      `host=${otherHost}`);
    {
      const part = buildInputAudioPart(epOther, bytes, 'mp3');
      const data = part.input_audio.data;
      crit('M1',
        audioDataShapeOf(epOther) === 'raw' && !data.startsWith(AUDIO_DATA_URL_PREFIX) && bytesOf(data).equals(bytes) && part.input_audio.format === 'mp3',
        'C2 **该不命中**（非名单 host）：`data` **不含**前缀、**裸 base64** 往返无损、`format` 由源扩展名定（`mp3` 照带）',
        `shape=${audioDataShapeOf(epOther)} / 前缀=${data.startsWith(AUDIO_DATA_URL_PREFIX)} / 往返=${bytesOf(data).equals(bytes)} / format=${part.input_audio.format}`);
    }
    // 缺省即 raw：**未解析得出的 url**（host 空）不许被当成"已知要前缀"——保守默认 = OpenAI 官方形状。
    {
      const epBad: AudioEndpoint = { url: 'not-a-url', api_key: 'k', model_name: 'm1' };
      crit('M1', audioDataShapeOf(epBad) === 'raw' && !buildInputAudioPart(epBad, bytes, 'wav').input_audio.data.startsWith(AUDIO_DATA_URL_PREFIX),
        'C2 缺省 `raw`：url 解析不出 host 时**保守取 OpenAI 形状**（`audioDataShapeOf` 不抛、不猜成"要前缀"）',
        `shape=${audioDataShapeOf(epBad)}`);
    }

    // ── C3 **提交体真走真源**：`transcribeAudio` 发出去的那个 part，与 `buildInputAudioPart` 逐字节同形 ──
    //   不许只扫源码里的字符串（"引了"≠"走的是它"）——真跑一次，比对生产实际发出的 body。
    {
      const seen: Array<Record<string, unknown>> = [];
      const ep: AudioEndpoint = { url: `https://${AUDIO_DATA_URL_HOSTS[0]}/compatible-mode/v1`, api_key: 'k', model_name: 'm1' };
      const r = await transcribeAudio('/x/audio.wav', {
        selectModel: async () => ep,
        readFile: async () => bytes,
        chat: async (_ep, body) => { seen.push(body); return { ok: true, text: '转写结果' }; },
      });
      const content = ((seen[0] as { messages?: Array<{ content?: Array<Record<string, unknown>> }> }).messages?.[0]?.content) ?? [];
      const emitted = content.find((p) => p.type === 'input_audio');
      const expected = buildInputAudioPart(ep, bytes, 'wav');
      crit('M1', r.ok === true && emitted !== undefined && JSON.stringify(emitted) === JSON.stringify(expected),
        'C3 `transcribeAudio` 发出的 `input_audio` part 与 `buildInputAudioPart(ep, bytes, \'wav\')` **逐字节同形**'
        + '（形状真源只有一处；不是"源码里引了它"这种会被绕过的说法）',
        `ok=${r.ok} / 同形=${JSON.stringify(emitted) === JSON.stringify(expected)}`);
    }

    // ── C4 **唯一一处**：把"字节 → part"这件事收敛到一处（扫源码，必须附命中数自证）──────
    {
      const src = strip(path.join(root, `${A}/src/main/core/audio-transcribe.ts`));
      const b64Hits = [...src.matchAll(/toString\(\s*'base64'\s*\)/g)];
      crit('M1', b64Hits.length === 1,
        'C4 **扫描面自证**：`audio-transcribe.ts`（去注释）里 `toString(\'base64\')` **恰 1 处** —— 即"字节 → part"只在一处发生'
        + '（多于 1 处就意味着有人绕开真源自己编 part，正是本轮病根的形状）',
        `命中 ${b64Hits.length} 处`);
    }

    // ── C5 **该不说谎**：未知 host 且 400 且错误体像"URL 不合法" ⇒ 原样带出 + **追加提示句** ──
    //   跑的是**生产真走的那条路**：`transcribeAudio` 不传 `chat` ⇒ 走缺省 `postChatCompletion`（真 fetch），
    //   只把**系统的边**（网络出口）换成桩 —— prompt/body/URL 拼接/错误分流全是生产代码。
    {
      const realFetch = globalThis.fetch;
      const seenUrls: string[] = [];
      const URL_ERR = JSON.stringify({
        error: {
          message: '<400> InternalError.Algo.InvalidParameter: The provided URL does not appear to be valid. Ensure it is correctly formatted.',
          type: 'invalid_request_error',
          code: 'invalid_parameter_error',
        },
      });
      const VARIANT_ERR = JSON.stringify({ error: { message: 'unknown variant `input_audio`, expected `text`' } });
      /** 装一次假网络出口：记下请求 URL，按 `body` 回 400。 */
      const withFetch = async (body: string, ep: AudioEndpoint, label: string) => {
        globalThis.fetch = (async (url: string) => {
          seenUrls.push(String(url));
          return new Response(body, { status: 400, headers: { 'Content-Type': 'application/json' } });
        }) as unknown as typeof globalThis.fetch;
        try {
          return await transcribeAudio('/x/audio.wav', { selectModel: async () => ep, readFile: async () => bytes });
        } finally { globalThis.fetch = realFetch; }
      };
      const epUnknown: AudioEndpoint = { url: 'https://api.example.test/v1', api_key: 'k', model_name: 'm1' };
      const epKnown: AudioEndpoint = { url: `https://${AUDIO_DATA_URL_HOSTS[0]}/compatible-mode/v1`, api_key: 'k', model_name: 'm1' };

      const rUnknown = await withFetch(URL_ERR, epUnknown, 'unknown+urlshaped');
      const dUnknown = rUnknown.ok === false ? String(rUnknown.detail) : '';
      crit('M1',
        rUnknown.ok === false && dUnknown.includes('does not appear to be valid') && dUnknown.includes(AUDIO_DATA_URL_PREFIX) && dUnknown.includes('这是提示，不是结论'),
        'C5 **该说出来**：未知 host + 400 + 错误体命中"URL 不合法" ⇒ 原错误体**原样在前**，并**追加**一句前缀提示（**提示不是结论**——文案自己说破）',
        `detail=${dUnknown.slice(0, 120)}`);
      crit('M1', seenUrls.length === 1 && seenUrls[0]!.endsWith('/chat/completions'),
        'C5 正面对证：那次 400 **确实**由生产真路径发出（假网络出口收到 1 次请求，且 URL 以 `/chat/completions` 结尾）',
        `url=${seenUrls[0] ?? '(无)'}`);

      // 反证两则：**不该加提示的时候不许加**——否则"提示"退化成噪声，用户下次就不信它了。
      const rVariant = await withFetch(VARIANT_ERR, epUnknown, 'unknown+variant');
      const dVariant = rVariant.ok === false ? String(rVariant.detail) : '';
      crit('M1', rVariant.ok === false && dVariant.includes('unknown variant') && !dVariant.includes('这是提示，不是结论'),
        'C5 **该不命中**：错误体是 `unknown variant`（端点根本不收 `input_audio`）⇒ 原样带出但**不追加**前缀提示'
        + '（那条提示只对"错误体像 URL 不合法"这一种形状负责）',
        `detail=${dVariant.slice(0, 100)}`);

      const rKnown = await withFetch(URL_ERR, epKnown, 'known+urlshaped');
      const dKnown = rKnown.ok === false ? String(rKnown.detail) : '';
      crit('M1', rKnown.ok === false && dKnown.includes('does not appear to be valid') && !dKnown.includes('这是提示，不是结论'),
        'C5 **该不命中**：**已知要求前缀**的 host 仍报 URL 不合法 ⇒ 不追加该提示（我们**已经**按它要的形状发了，'
        + '再提示"可能要加前缀"就是误导）',
        `detail=${dKnown.slice(0, 100)}`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【C】M2 —— 零命中时**说得出为什么**（E3）');
  {
    /**
     * **真件**：2026-09-21 由真 `AnsClient` 打真 ANS :3001，请求一个不可能满足的能力串
     * （`capabilities:['__no_such_capability__']`）后**逐字取回**的回包。完整读数见方案 §M2 完成情况。
     *
     * ⚠ **本脚本内不发起任何网络调用**：下面这份是**冻结字面量**（离线可复现是有意为之——rr 不依赖
     * :3001 在跑）。它是现场取回后逐字粘贴的，但**读到它 ≠ 此刻 ANS 仍这么回**：现网实时读数见方案
     * §6.2（2026-09-21 独立核验时复跑，与这份同形）。
     *
     * 判据断言的是**结构**（`error` 键在场与否 / 话里有没有带出成因），**不是**在比对这份字面量；
     * 期望值一律从这份回包自身里取（`payload.error.message` / `…diagnostics.summary`），不另抄一份。
     */
    const LIVE_ZERO_HIT = '{"error":{"code":"NOT_FOUND","message":"没有找到匹配的模型","diagnostics":'
      + '{"endpointFunnel":[{"step":"总端点","remaining":11},{"step":"端点 active","remaining":8},'
      + '{"step":"模型 active 且启用","remaining":4},{"step":"供应商启用","remaining":4},'
      + '{"step":"具有能力 __no_such_capability__","remaining":0}],'
      + '"modelFunnel":[{"step":"在册模型","remaining":52},{"step":"供应商启用","remaining":31},'
      + '{"step":"模型 active 且启用","remaining":23},{"step":"有 active 端点","remaining":4}],'
      + '"summary":"端点漏斗在「具有能力 __no_such_capability__」这一步归零——前一步还剩 4 个，这一步筛没了"}}}';
    const live = JSON.parse(LIVE_ZERO_HIT) as { error: { message: string; diagnostics: { summary: string } } };

    // ── C6 **认得出**：把"失败形状"与"成功形状"分开，且认不出的形状不硬认 ──────────────
    const said = describeModelSelectionFailure(live);
    crit('M2', said !== null && said.includes(live.error.message) && said.includes(live.error.diagnostics.summary),
      'C6 **该命中**：真 ANS 零命中回包 ⇒ 适配层认得出，且 **message 与逐层结论都在话里**（此前 `url` 取不到 ⇒ 一路静默）',
      `said=${said}`);

    // 该不命中①：ANS **成功路回包从不含 `error` 键** —— 标本合格性先自证，再断言不给它安失败说法。
    const okShaped = { id: 'm', model_name: 'omni', url: 'https://x.example/v1', api_key: 'k', max_output_tokens: 4096 };
    crit('M2', !('error' in okShaped) && describeModelSelectionFailure(okShaped) === null,
      'C6 **该不命中**：成功回包形状（**自证确无 `error` 键**）⇒ 返回 null，不给成功回包安一个失败说法',
      `无 error 键=${!('error' in okShaped)} / 返回=${describeModelSelectionFailure(okShaped)}`);

    // 该不命中②：认不出的形状一律 null（**不猜、不抛**——认错形状比认不出更坏）
    const weird: unknown[] = [null, undefined, {}, { error: 123 }, 42, 'boom', []];
    const allNull = weird.every((w) => describeModelSelectionFailure(w) === null);
    crit('M2', allNull,
      'C6 **该不命中②**：`null`/`{}`/`{error:123}`/数字/字符串/数组等**认不出的形状一律 null**（不猜、不抛）',
      `全部 null=${allNull}（标本 ${weird.length} 只）`);

    // 说不清就**承认说不清**：有 `error` 键但既无 message 也无 code ⇒ 明说，不编造。
    const vague = describeModelSelectionFailure({ error: {} });
    crit('M2', vague !== null && vague.includes('未说明原因'),
      'C6 三态折中：回包**是**失败形状但 ANS 没给原因 ⇒ 明说 `ANS 未说明原因`（**如实少说**，而不是编一个）',
      `said=${vague}`);

    // ── C7 **不静默**：跑**生产组合函数本体**（不是扫源码、也不是另搭一套等价物）──────────
    //   `makeAudioTranscriber` = 真 `normalizeToWav` + 真 `transcribeAudio` + 真适配层 + 真 `fs.readFile`。
    //   换掉的**只有"ffmpeg 这个可执行"**——正是 `AUDIO_IO` 头注释指明的那种组合法：
    //   `{ ...AUDIO_IO, probe, run }`，`mkdirp`/`size` 仍是生产实现。
    //   ⚠ 桩 `run` 必须**真写出目标文件**：`normalizeToWav` 会回查产物、`transcribeAudio` 会真读它——
    //     只"假装成功"会让下游读到 ENOENT，判据就变成在验空气（本探针首跑正是这么红的）。
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-m2-'));
    const srcFile = path.join(tmp, 'voice.mp3');
    fs.writeFileSync(srcFile, Buffer.from('fake-mp3-bytes-for-m2-probe'));
    const stubIo = {
      ...AUDIO_IO,
      probe: () => true,
      run: async (_bin: string, args: string[]) => {
        fs.writeFileSync(args[args.length - 1]!, Buffer.from('fake-wav-bytes-for-m2-probe'));
        return { code: 0, timedOut: false, error: null, stderr: '' };
      },
    };
    const tr = makeAudioTranscriber({ getOptimalModel: async () => live as unknown as Record<string, unknown> }, tmp, stubIo);
    const r = await tr(srcFile);
    crit('M2', r.ok === false && r.reason.includes(live.error.message) && r.reason.includes(live.error.diagnostics.summary),
      'C7 **生产组合函数端到端**：真 `makeAudioTranscriber` 在本机零命中回包下 ⇒ **说得出为什么**'
      + '（ANS 的 message 与逐层结论都到了 `reason` 上，而不再是一句"无 audio 能力模型可给"）',
      `reason=${r.reason}`);

    // 反证①：回包**既非 error 形状、字段也不齐** ⇒ 说"形状不认识"，**不冒充**"没有 audio 模型"（两种成因不许混）。
    const rShape = await makeAudioTranscriber({ getOptimalModel: async () => ({}) }, tmp, stubIo)(srcFile);
    crit('M2', rShape.ok === false && rShape.reason.includes('形状不认识'),
      'C7 反证①（**该不命中**）：ANS 回了 200 但既无 `error` 键、也缺 `url/api_key/model_name` ⇒ 如实说"回包形状不认识"，'
      + '**不冒充**"没有 audio 能力模型"（"接口变了"与"没有这种模型"是两回事）',
      `reason=${rShape.reason}`);
    fs.rmSync(tmp, { recursive: true, force: true });

    // 反证②：`transcribeAudio` 的**旧字段门槛仍在**——别的 `selectModel` 实现返回 null 时，旧语义不许被本批顶掉。
    const rBare = await transcribeAudio('/x/a.wav', { selectModel: async () => null, readFile: async () => Buffer.from('x') });
    crit('M2', rBare.ok === false && rBare.detail === '无 audio 能力模型可给（ANS 选型未返回可用端点）',
      'C7 反证②：`selectModel` 如实返回 `null`（字段门槛那条老路）⇒ 仍是原句，**本批没有把旧语义顶掉**',
      `detail=${!rBare.ok ? rBare.detail : '(不该 ok)'}`);

    // ── C8 **主路不改**：行为探针（不是读源码声明"它不读这个字段"）────────────────────────
    //   真跑 `selectModelForTask`，喂「零命中」与「零命中 + diagnostics」两份回包，断言**抛出的 error 逐字相同**。
    //   为什么是 throw：主路判失败读的是 `!modelResult.id`（`exec-model-select.ts`），零命中时它抛错收场。
    const db = new DatabaseSync(':memory:');
    const throwOf = async (payload: Record<string, unknown>): Promise<string | null> => {
      try {
        await selectModelForTask({
          db: db as never,
          taskId: 't-m2', projectId: 'p-m2', taskCtxJson: '{}',
          ansClient: { getOptimalModel: async () => payload },
          archetype: 'conversation' as never, modelStrategy: 'cost-optimal',
        });
        return null;
      } catch (e) { return (e as Error).message; }
    };
    const mStripped = await throwOf({ error: { code: 'NOT_FOUND', message: '没有找到匹配的模型' } });
    const mWithDiag = await throwOf(live as unknown as Record<string, unknown>);
    // ⚠ zx_20260924 M6-e② **就地订正**：原口径是"两面 error **逐字相同**"（即诊断被主路丢弃），
    //   本轮**刻意推翻**它——ANS 早就算好了"卡在第几道闸"，此前在此被直接丢弃，用户只看到"没有模型"。
    //   现在要接进**同一条如实出口**（会话行 + 日志 + 抛出）。钉的仍是「纯追加」这条不变式，只是把
    //   "追加"说准：**基础句一字不动 + 增量逐字等于 ANS 自己的 summary**。
    //   （若只断言 `mWithDiag.includes(mStripped)` 就太弱——ANS 改文案照样过；故后缀必须**逐字**对上。）
    const wantSuffix = `；ANS 诊断：${live.error.diagnostics.summary}`;
    crit('M2',
      mStripped !== null && mWithDiag !== null
      && mWithDiag === mStripped + wantSuffix && !mStripped.includes('ANS 诊断'),
      'C8 **纯追加（主路不改）**：真 `selectModelForTask` 在「零命中」与「零命中+`diagnostics`」下抛出的 error ——'
      + '**基础句一字不动**，增量**逐字等于** `；ANS 诊断：<ANS 自己的 summary>`（zx_20260924 M6-e② 新语义）；'
      + '**两面都非 null** 才说明它确实走了失败路（否则"都不抛"也能骗过这条）',
      `无 diagnostics=${mStripped} / 有 diagnostics=${mWithDiag}`);
    db.close();
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【C9–C12】M3 —— URL 拼接**归一处真源**（E2）');
  {
    // ── C9 **该命中**：§1.4 表逐行恰对 ─────────────────────────────────────────
    //   ⚠ 期望值取自**方案 §1.4 那张表**（一份**独立于实现**写下的规格），`[输入, 应得]` 成对手写。
    //     若反过来"从实现取期望"，那就是自我印证（承本轮 §7 头号风险）。
    //     手写规格的**反面风险**是"这张表根本不判别"——故下面另配**负对照标本**专门证伪它。
    const TABLE: Array<[string, string]> = [
      // 纯主机（库里真有：deepseek）
      ['https://api.deepseek.com', 'https://api.deepseek.com/v1/chat/completions'],
      // 已含版本段（库里真有：moonshot / 本地 Ollama ×3 / dashscope 兼容口）
      ['https://api.moonshot.cn/v1', 'https://api.moonshot.cn/v1/chat/completions'],
      ['http://localhost:11434/v1', 'http://localhost:11434/v1/chat/completions'],
      ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'],
      // 版本段**不是** /v1 的（库里真有：zhipu `/api/paas/v4`）——旧两种实现都在这儿拼错
      ['https://open.bigmodel.cn/api/paas/v4', 'https://open.bigmodel.cn/api/paas/v4/chat/completions'],
      // provider 在册、未登记端点（§1.4 表点名要求"含这两行"）
      ['https://generativelanguage.googleapis.com/v1beta', 'https://generativelanguage.googleapis.com/v1beta/chat/completions'],
      ['https://ark.cn-beijing.volces.com/api/v3', 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'],
      // 已是全路径 ⇒ **原样**（幂等的头一条）
      ['https://api.openai.com/v1/chat/completions', 'https://api.openai.com/v1/chat/completions'],
    ];
    const mismatches = TABLE.filter(([base, want]) => resolveChatCompletionsUrl(base) !== want);
    crit('M3', mismatches.length === 0,
      `C9 **该命中**：§1.4 表全 ${TABLE.length} 行（含 \`/v1beta\`、\`/api/v3\` 两行）× 真源**逐一恰对**`
      + '（期望取自方案 §1.4 的规格表，不取自实现）',
      mismatches.length
        ? `不符 ${mismatches.length} 行：` + mismatches.map(([b, w]) => `${b} ⇒ ${resolveChatCompletionsUrl(b)}（应 ${w}）`).join(' / ')
        : `${TABLE.map(([b]) => b.replace(/^https?:\/\//, '')).join(' · ')}`);

    // ── C9 负对照：**旧两种实现**必须在这张表上**判红** ──────────────────────────
    //   这两份是**改前生产源码的逐字复刻**，放在这里**只作标本**（生产已改调真源，不再走它们）。
    //   它们唯一的用处是回答："上面那条全绿，是因为表在判别，还是因为表不判别？"
    //   ⚠ 它们**不是**生产实现——判据本身跑的是真源；标本只喂给**同一个判定式**做对照。
    const OLD_A = (base: string): string => {      // 改前 `audio-transcribe.ts:chatCompletionsUrl`
      const u = base.replace(/\/+$/, '');
      if (u.endsWith('/v1/chat/completions')) return u;
      if (u.endsWith('/v1')) return `${u}/chat/completions`;
      return `${u}/v1/chat/completions`;
    };
    const OLD_B = (url: string): string =>         // 改前 ANS 四处那份（只认全路径）
      url.endsWith('/v1/chat/completions') ? url : url.replace(/\/$/, '') + '/v1/chat/completions';

    const badA = TABLE.filter(([base, want]) => OLD_A(base) !== want);
    const badB = TABLE.filter(([base, want]) => OLD_B(base) !== want);
    crit('M3', badA.length > 0 && badB.length > 0,
      'C9 **负对照（两只旧标本都试）**：改前的两种算法（A 只认 `/v1`+全路径 / B 只认全路径）'
      + '喂同一张表**必判红** —— 若它们也全绿，那"全绿"只说明这张表不判别，与本轮真源对错无关',
      `A 错 ${badA.length} 行 / B 错 ${badB.length} 行（各 ≥1 才算表在判别）`);

    // ── C10：幂等 + 无 `/v1/v1` + 全路径不被二次追加 ───────────────────────────
    const seeds = [...TABLE.map(([b]) => b), 'http://localhost:11434', 'https://api.openai.com/v1/'];
    const nonIdem = seeds.filter((s) => resolveChatCompletionsUrl(resolveChatCompletionsUrl(s)) !== resolveChatCompletionsUrl(s));
    crit('M3', nonIdem.length === 0,
      'C10 **幂等**：`f(f(x)) === f(x)` 对全部标本成立 —— 二次追加是这段逻辑最典型的坏法，'
      + '而幂等恰好一句话钉死它（含"已是全路径"与"带尾斜杠"两种输入）',
      nonIdem.length ? `非幂等：${nonIdem.join(' / ')}` : `${seeds.length} 只标本全部幂等`);

    const doubled = seeds.filter((s) => /\/v1\/v1\b/.test(resolveChatCompletionsUrl(s)));
    const passthru = TABLE.filter(([b, want]) => b === want && resolveChatCompletionsUrl(b) !== b);
    crit('M3', doubled.length === 0 && passthru.length === 0,
      'C10 **全路径不被二次追加**且结果内**无 `/v1/v1`** —— 前者是"输入已含全路径 ⇒ 原样"，'
      + '后者是旧实现（只认 `/v1`）在 `/v1beta`（google）上的那个 404',
      `重复版本段 ${doubled.length} 处 / 全路径被改写 ${passthru.length} 处`);

    // ── C11：**7 处落点**全部改调真源（归一处） ────────────────────────────────
    //   方案原文写 5 处，实测为 7 处（多出 `task-decompose.ts` 与 `im-router.ts`，见方案 M3 细化规划）。
    const SITES: Array<[string, string]> = [
      [`${A}/src/main/core/audio-transcribe.ts`, '#1 音频转写'],
      [`${A}/src/main/core/task-decompose.ts`, '#6 拆解器'],
      [`${A}/src/main/services/im-router.ts`, '#7 IM 意图分类'],
      ['apps/ans-server/src/services/priorai-gateway.ts', '#2 网关'],
      ['apps/ans-server/src/routes/mcp-proxy.ts', '#3 MCP 代理'],
      ['apps/ans-server/src/mcp-server.ts', '#4 MCP 独立入口（潜伏）'],
      ['apps/ans-server/src/services/plugin-translator.ts', '#5 插件翻译'],
    ];
    const read = SITES.map(([p, tag]) => [p, tag, strip(p)] as const);
    const scannedChars = read.reduce((n, [, , t]) => n + t.length, 0);
    ok(read.length === 7 && scannedChars > 0,
      'C11 扫描面自证：**7 处落点**都读到了内容（去注释后共 ' + scannedChars + ' 字 > 0）'
      + ' —— 否则下面"零处手写拼接"是扫了个空（承 G-2）',
      `${SITES.length} 个文件`);

    const notWired = read.filter(([, , t]) => !t.includes('resolveChatCompletionsUrl(')).map(([p, tag]) => `${tag} ${p}`);
    crit('M3', notWired.length === 0,
      'C11 **归一处**：7 处落点**每一处都在调真源** `resolveChatCompletionsUrl(`（去注释后按调用形式核）'
      + ' —— 只"import 了"不算，必须真的调它',
      notWired.length ? `仍自拼：${notWired.join(' / ')}` : read.map(([p, tag]) => tag).join(' · '));

    // 路径知识只剩一处：这些文件**去注释后**不得再出现 `chat/completions` 字面量。
    const pathLit = read.filter(([, , t]) => t.includes('chat/completions')).map(([p, tag]) => `${tag} ${p}`);
    crit('M3', pathLit.length === 0,
      'C11 **路径知识只有一处**：7 个文件去注释后 `chat/completions` 字面量**零命中**'
      + '（谁再手写一份拼接，这条立刻红——"归一处"不是"这次改齐了"，是"以后只有一处"）',
      pathLit.length ? `仍含字面量：${pathLit.join(' / ')}` : `7 文件 / ${scannedChars} 字，零命中`);

    // 7 处落点**经 `dist/` 解析**这个包（两个 app 的 `package.json` 里 `main` 都指向 `dist/index.js`）
    //   ⇒ **改了 `src` 而没 build，生产走的是旧产物**。上面两条 C11 证的是"源码已归一处"，
    //   那**不足以**证明"生产走到的那份也归了一处"。故此处把两份**同值**钉住（承 build 钉 P6 的同一手法：
    //   取产物内的值本身，而不是"源码里出现过这个串"）。
    const distUrl = `../packages/ans-client/dist/index.js`;
    let distMismatch: string[] = ['dist 不可导入'];
    try {
      const distMod = (await import(distUrl)) as { resolveChatCompletionsUrl?: (s: string) => string };
      const fn = distMod.resolveChatCompletionsUrl;
      distMismatch = typeof fn !== 'function'
        ? ['dist 未导出 resolveChatCompletionsUrl']
        : TABLE.filter(([b, w]) => fn(b) !== w || fn(b) !== resolveChatCompletionsUrl(b)).map(([b]) => b);
    } catch (e) { distMismatch = [`导入失败：${(e as Error).message}`]; }
    crit('M3', distMismatch.length === 0,
      'C11 **产物与真源同值**：7 处落点经 `dist/` 解析这个包，故**改了 src 忘了 build ⇒ 生产仍是旧的**'
      + '。此处把 `dist/index.js` 里的 `resolveChatCompletionsUrl` 与源码那份**逐行同值**钉住'
      + '（只断言"源码里写着"是骗得过自己的——那证不了生产走到的那份）',
      distMismatch.length ? `不符：${distMismatch.join(' / ')}` : 'dist 与 src 在 §1.4 全表上逐行同值');

    // ── C12：潜伏面的**可达性**（双向；不得把"改了源码"记成"修了现网"） ──────────
    //   从 ANS 入口沿**相对 import** 走闭包。同一判定式喂两种输入各得一种结果 ⇒ 它**能**说"不可达"。
    const ANS_SRC = path.join(root, 'apps/ans-server/src');
    const importRe = /from\s+['"](\.[^'"]+)['"]/g;
    const closure = new Set<string>();
    const walk = (abs: string): void => {
      if (closure.has(abs) || !fs.existsSync(abs)) return;
      closure.add(abs);
      const src = fs.readFileSync(abs, 'utf-8');
      for (const m of src.matchAll(importRe)) {
        const base = path.resolve(path.dirname(abs), m[1]!.replace(/\.js$/, ''));
        const cand = fs.existsSync(`${base}.ts`) ? `${base}.ts` : fs.existsSync(path.join(base, 'index.ts')) ? path.join(base, 'index.ts') : null;
        if (cand) walk(cand);
      }
    };
    walk(path.join(ANS_SRC, 'index.ts'));
    const reachable = (p: string): boolean => closure.has(path.join(root, p));

    const REACH: Array<[string, boolean]> = [
      ['apps/ans-server/src/services/priorai-gateway.ts', true],
      ['apps/ans-server/src/routes/mcp-proxy.ts', true],
      ['apps/ans-server/src/services/plugin-translator.ts', true],
      ['apps/ans-server/src/mcp-server.ts', false],
    ];
    const wrong = REACH.filter(([p, want]) => reachable(p) !== want);
    crit('M3', closure.size > 0 && wrong.length === 0,
      'C12 **可达性双向成立**：从 `src/index.ts` 沿相对 import 走闭包 ⇒ '
      + '`priorai-gateway` / `mcp-proxy` / `plugin-translator` **∈ 闭包**（可达），'
      + '而 `mcp-server.ts` **∉ 闭包**（独立 tsup entry，须 `node dist/mcp-server.js` 手工启动 ⇒ **真潜伏**）。'
      + '同一判定式**两种结果都出得来** ⇒ 它不是在自我确认；它哪天被接进入口，这条会**自动改口**为"可达"',
      wrong.length
        ? `判错：${wrong.map(([p, w]) => `${p}（应${w ? '可达' : '潜伏'}）`).join(' / ')}`
        : `闭包 ${closure.size} 文件 · 3 可达 / 1 潜伏`);

    // 如实记账：**改了源码 ≠ 修了现网**。
    const latent = REACH.filter(([, w]) => !w).map(([p]) => p);
    ok(latent.length === 1 && !reachable(latent[0]!),
      'C12 **不夸大**：`mcp-server.ts` 已改调真源，但它**当前不可达**——本批**不**把它记成"修了现网缺陷"，'
      + '只记成"源码已归一，生效需手工启动该入口"（承方案 §5 A-5）',
      `${latent.map((p) => path.basename(p)).join(',')} = 潜伏`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【C13/C14】M4 —— `audio` 的「名」定死');
  {
    const VOCAB_FILE = 'packages/shared-types/src/models.ts';
    const RENDERER_FILE = `${A}/renderer/src/pages/ModelsPage.tsx`;
    const AUDIO_FILE = `${A}/src/main/core/audio-transcribe.ts`;
    // ⚠ 本段**读原文、不去注释**：过度解读恰恰住在注释与文案里，`strip` 一用就把病灶洗掉了。
    const readRaw = (p: string) => fs.readFileSync(path.join(root, p), 'utf-8');

    const rendererText = readRaw(RENDERER_FILE);
    const audioText = readRaw(AUDIO_FILE);
    const vocabText = readRaw(VOCAB_FILE);

    // ── C13 **该命中**：语义句从真源一路走到三个落点 ─────────────────────────────
    ok(AUDIO_CAPABILITY_SEMANTICS.length > 0 && AUDIO_CAPABILITY_NOT_REGISTERED.length > 0
      && AUDIO_CAPABILITY_CONTESTED.length > 0,
      'C13 扫描面自证：真源三件（语义句 / 不登记清单 / 争议留白）**都非空**'
      + '（否则下面"文案含它"是拿空串去比，恒真）',
      `语义句=${JSON.stringify(AUDIO_CAPABILITY_SEMANTICS)} / 不登记 ${AUDIO_CAPABILITY_NOT_REGISTERED.length} 字 / 争议 ${AUDIO_CAPABILITY_CONTESTED.length} 字`);

    crit('M4', MODEL_CAPABILITY_META.audio.description === AUDIO_CAPABILITY_SEMANTICS,
      'C13 `MODEL_CAPABILITY_META[\'audio\'].description` **恒等**于真源语义句（取 `===` 不取 `includes`：'
      + '包含会让"真源改了、这处没改"也过）',
      `meta=${JSON.stringify(MODEL_CAPABILITY_META.audio.description)}`);

    // renderer 侧：**zx_20260929 M6-3 起改钉更强的真源**。
    //   旧判据是"两处文案按文本取回后**逐字相等**"——那只在"两处各存一份"时为真；M6-3 把那份手抄表
    //   **删了**（改为直引真源）之后，等值判据取回的全是 `undefined`，会退化成"undefined === undefined"。
    //   故改判两件事：① renderer **没有第二份词表**（该不命中）；② 三条派生**确实取自真源**（该命中）。
    //   ①成立 ⇒ `audio` 的 label/desc 由构造即等于真源，无需再逐字比。
    const TABLE_ENTRY_RE = /\{\s*value:\s*'[a-z-]+',\s*label:\s*'/;   // 旧手抄表的条目形状
    const VOCAB_IMPORT = 'packages/shared-types/src/models.js';
    const derived = /Object\.entries\(MODEL_CAPABILITY_META\)/.test(rendererText)
      && /= PROVIDER_CAPABILITY_HINTS\b/.test(rendererText)
      && /MODEL_NAME_CAPABILITY_HINTS\.map\(/.test(rendererText);
    crit('M4', !TABLE_ENTRY_RE.test(rendererText) && rendererText.includes(VOCAB_IMPORT) && derived,
      'C13 **第二个落点（renderer）**：模型页**没有第二份词表**（旧手抄表条目形状零命中），'
      + '且 `CAPABILITIES` / `PROVIDER_CAP_HINTS` / `MODEL_NAME_HINTS` 三条**都派生自真源**'
      + '（' + VOCAB_IMPORT + '）——于是 `audio` 的 label/desc **由构造**即等于真源，'
      + '比"两处各存一份再逐字比"更强：后者在"两处一起错"时全绿',
      `表条目形状=${TABLE_ENTRY_RE.test(rendererText) ? '命中(仍有手抄表)' : '零命中'} / 引真源=${rendererText.includes(VOCAB_IMPORT)} / 三条派生=${derived}`);

    // 反证标本（承"豁免/门槛类判据须用两只标本一起试"）：同一判定式喂一段**明知是手抄表**的串 ⇒ 必须判出。
    const probeTable = "const CAPABILITIES = [\n  { value: 'chat', label: '对话', desc: 'x' },\n];";
    ok(TABLE_ENTRY_RE.test(probeTable),
      'C13 反证标本：同一判定式喂一段**手抄表**片断 ⇒ **判得出**（故上面的"零命中"不是"判定式从不报"）',
      `标本命中=${TABLE_ENTRY_RE.test(probeTable)}`);

    // 打包产物核对：源码里有 ≠ 发到用户机器上（`引了` ≠ `打包器没摇树掉`）。
    const rdistAssets = path.join(root, A, 'renderer/dist/assets');
    const chunks = fs.existsSync(rdistAssets)
      ? fs.readdirSync(rdistAssets).filter((f) => f.startsWith('ModelsPage') && f.endsWith('.js'))
      : [];
    if (chunks.length > 0) {
      const bundled = chunks.map((f) => fs.readFileSync(path.join(rdistAssets, f), 'utf-8')).join('\n');
      ok(bundled.includes(AUDIO_CAPABILITY_SEMANTICS) && !bundled.includes('音频处理'),
        'C13 产物核对：renderer 构建产物（minify 后）**含**新语义句、**不含**旧标签「音频处理」'
        + '（中文串在 minify 下不被改写，搜标识符会得假"陈旧"）',
        `chunk=${chunks.join(',')}`);
    } else {
      console.log('  · C13 注：renderer 产物不在位，**跳过**产物核对（如实跳过，不记为通过）——先跑 `pnpm --filter @worker-ant/desktop-renderer build`');
    }

    crit('M4', audioText.includes(AUDIO_CAPABILITY_SEMANTICS) && audioText.includes('不登记'),
      'C13 `audio-transcribe.ts` 的 `AUDIO_CAPABILITY` 注释**含**语义句原文且**写出了"不登记哪些"**'
      + '（只写"是什么"不写"不是什么"，下一个读它的人还会把 TTS 打上标）',
      `含语义句=${audioText.includes(AUDIO_CAPABILITY_SEMANTICS)} / 含"不登记"=${audioText.includes('不登记')}`);

    // ── C14 **该不命中**：过度解读不许复活 ───────────────────────────────────────
    //   承 zx_20260916_1 的教训：**负面子串断言会被订正注释自己判红**。故本批所有新增注释
    //   **一律不逐字复述**这两串（renderer 那处注释已按此改写）。
    const OVERREAD = ['语音识别/合成', '音频输入/输出'];
    const surfaces: Array<[string, string]> = [
      [VOCAB_FILE, vocabText], [RENDERER_FILE, rendererText], [AUDIO_FILE, audioText],
    ];
    const scannedLines = surfaces.reduce((n, [, t]) => n + t.split('\n').length, 0);
    const hitAt = surfaces.flatMap(([p, t]) => OVERREAD.filter((s) => t.includes(s)).map((s) => `${p}×"${s}"`));
    crit('M4', scannedLines > 0 && hitAt.length === 0,
      'C14 **该不命中**：过度解读串（把 `audio` 读成"识别+合成"那两串）在**三个落点**零命中'
      + '（扫描面自证：共扫 ' + scannedLines + ' 行 > 0，不是扫了个空）',
      `命中 ${hitAt.length} 处${hitAt.length ? '：' + hitAt.join(' / ') : ''} · 扫描面 ${surfaces.length} 文件 / ${scannedLines} 行`);

    // 反证标本：同一判定式喂一只**明知含**过度解读串的串 ⇒ 必须判出（否则"零命中"可能只是它从不报）。
    const probeHit = OVERREAD.filter((s) => `样例：${s}；` .includes(s)).length;
    ok(probeHit === OVERREAD.length,
      'C14 反证标本：同一判定式喂一只**含**过度解读串的串 ⇒ **逐串都判出**（两只标本都试过，'
      + '故上面的"零命中"不是"扫描器从不报"）',
      `判定式命中 ${probeHit}/${OVERREAD.length}`);

    // whisper / tts 自动打标：**不**得再打 `audio`（哪边都不能）。
    const whisperHint = MODEL_NAME_CAPABILITY_HINTS.find((h) => h.pattern.test('whisper-1') && h.pattern.test('tts-1'));
    crit('M4', !!whisperHint && !whisperHint.add.includes('audio') && (whisperHint.remove ?? []).includes('chat'),
      'C14 `whisper|tts` 打标规则**不再**建议 `audio`（两串都是假阳性：专用转写口 / 合成方向）'
      + '，而 `remove` 保留（它们确实不是对话模型——是**去掉错的标**，不是换个标）',
      `真源 add=${JSON.stringify(whisperHint?.add)} / remove=${JSON.stringify(whisperHint?.remove)}`);

    // zx_20260929 M6-3：renderer 那份手抄规则已删（改引真源）⇒ 此处不再取 renderer 的 `caps:`，
    //   改判"renderer 里**没有**第二条 `whisper|tts` 规则"——它若复活，就是又一次分叉的开端。
    const rWhisperRule = /pattern:\s*\/[^/]*whisper[^/]*\//i.test(rendererText);
    ok(!rWhisperRule,
      'C14 **第二个落点**：renderer 里**零处**自带 `whisper|tts` 规则（真源那句是唯一一份）——'
      + '规则少了这一处，也就不会再漂',
      `renderer 自带 whisper 规则=${rWhisperRule}`);

    // 「本批**未动库**」的离线可判据面：词表改动**不得**夹带一条写库路径。
    //   ⚠ 刻意**不去读** `data/ans-server.db`——那会让本脚本变成环境依赖（承 `rr_zx_20260905` 的教训），
    //   且把"12 行快照"写死进来会是一颗**随用户登记模型而响**的雷。故改判"改的是词表，没改写口"。
    const writeRe = /(UPDATE|INSERT\s+INTO)\s+ans_ai_models/i;
    const writeHit = surfaces.filter(([, t]) => writeRe.test(t)).map(([p]) => p);
    ok(writeHit.length === 0,
      'C14 「词表批不写库」：三个落点里**零处** `UPDATE/INSERT ans_ai_models` —— 本批改的是**名词**，'
      + '存量 12 个 `audio` 标的模型**一行未动**（去重标是另一件事：须逐模型实测 + 用户裁决）',
      `命中 ${writeHit.length} 处${writeHit.length ? '：' + writeHit.join(',') : ''}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S】build 钉（派生核对，不写轮次字面量；**不受批次门管辖**）');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告
//    unhandled rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().catch((e: unknown) => {
  console.error('\n💥 rr_zx_20260921_1 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260921_1: ${pass} 通过 / ${fail} 失败${pending ? ` / ${pending} 待实施(不计入)` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
});
