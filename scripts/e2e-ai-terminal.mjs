#!/usr/bin/env node
/**
 * 外部 AI 终端参考客户端（zx_20261018_1 批二「意」）。
 *
 * 一串最小可跑的往返：**配对 → 轮询 → 取能力 → resolve → execute**。
 * 作为"门外那台机器人"的样例，也给实机 E2E 当探针用；协议形状以
 * `core/inbound-gate.ts` / `core/external-calls.ts` 为准（本文件不另设真源）。
 *
 * 用法（先起桌面端并开启「外部终端接入」）：
 *   node scripts/e2e-ai-terminal.mjs --room 客厅 --feeling hot --utterance "客厅有点热"
 *   node scripts/e2e-ai-terminal.mjs --base http://192.168.1.10:27184 --name 样例机器人
 *
 * 选项：
 *   --base <url>        门地址（默认取 WA_INBOUND_URL 或 http://127.0.0.1:27184）
 *   --name <name>       终端自报名称（默认「参考客户端」）
 *   --room <room>       房间名（默认「客厅」）
 *   --feeling <value>   感受：hot / cold / dark / bright（默认 hot）
 *   --utterance <text>  原话（只落账，不参与解析；默认按参数生成一句）
 *   --intent <id>       意图名（默认 home.comfort）
 *   --timeout <sec>     等待桌面端批准的秒数（默认 120）
 *   --no-execute        只 resolve，不 execute（看计划、不落地）
 *   --json              只输出机器可读 JSON（成功时末尾一行汇总；`--no-execute` 分支同样有）
 */
import process from 'node:process';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const base = String(opt('base', process.env.WA_INBOUND_URL || 'http://127.0.0.1:27184')).replace(/\/+$/, '');
const name = opt('name', '参考客户端');
const room = opt('room', '客厅');
const feeling = opt('feeling', 'hot');
const intent = opt('intent', 'home.comfort');
const utterance = opt('utterance', `${room}有点${feeling === 'hot' ? '热' : feeling === 'cold' ? '冷' : feeling === 'dark' ? '暗' : '亮'}`);
const timeoutSec = Number(opt('timeout', '120'));
const asJson = flag('json');

function say(...parts) {
  if (asJson) return;
  console.log(...parts);
}

async function call(method, path, { body, token, query } = {}) {
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 回包按 null 处理，状态码仍是事实 */ }
  return { status: res.status, body: json };
}

function die(step, res) {
  console.error(`\n✗ ${step} 失败：HTTP ${res.status} ${JSON.stringify(res.body)}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  say(`门：${base}`);
  // ① 配对申请（免凭据）。
  const pair = await call('POST', '/api/v1/pair/request', { body: { name } });
  if (pair.status !== 200) die('配对申请', pair);
  const { pairing_id: pairingId, pair_code: pairCode } = pair.body;
  say(`\n① 已申请配对：pairing_id=${pairingId}  pair_code=${pairCode}`);
  say('   请在桌面端「协作 → AI 终端」批准它（默认授予「意图控制」）。');

  // ② 轮询到 approved；凭据**只此一次**下发。
  const deadline = Date.now() + timeoutSec * 1000;
  let creds = null;
  while (!creds) {
    if (Date.now() > deadline) {
      console.error(`\n✗ 等待批准超时（${timeoutSec}s）——请在桌面端批准后重跑。`);
      process.exit(1);
    }
    await sleep(2000);
    const st = await call('GET', '/api/v1/pair/status', { query: { pairing_id: pairingId, pair_code: pairCode } });
    if (st.status !== 200) die('配对轮询', st);
    if (st.body?.status === 'rejected') {
      console.error('\n✗ 桌面端拒绝了这次配对。');
      process.exit(1);
    }
    if (st.body?.status === 'approved') creds = st.body.credentials;
  }
  const token = `${creds.key}.${creds.secret}`;
  say(`② 已获批准，凭据到手（key=${creds.key}，secret 不打印）`);

  // ③ 自省：能力 / 意图 / 房间 / 脱敏设备（不含地址与授权态）。
  const caps = await call('GET', '/api/v1/capabilities', { token });
  if (caps.status !== 200) die('取能力面', caps);
  say(`\n③ 能力面：capabilities=${JSON.stringify(caps.body.capabilities)}`);
  say(`   intents=${JSON.stringify((caps.body.intents ?? []).map((i) => i.id))}  rooms=${JSON.stringify(caps.body.rooms ?? [])}`);
  say(`   devices=${JSON.stringify((caps.body.devices ?? []).map((d) => `${d.call_name}(${d.kind})`))}`);

  // ④ resolve：只说意图，由本机解析成计划（零副作用）。
  const resolved = await call('POST', '/api/v1/intent/resolve', {
    token,
    body: { intent, params: { room, feeling }, utterance },
  });
  if (resolved.status === 503 && resolved.body?.error === 'intent_resolver_unavailable') {
    console.error('\n✗ 本机尚未接上意图解析器（`intent_resolver_unavailable`）——如实报，不编空计划。');
    process.exit(2);
  }
  if (resolved.status === 409 && resolved.body?.error === 'needs_clarification') {
    console.error(`\n✗ 房间有歧义，候选：${JSON.stringify(resolved.body.candidates)}——请换个更准确的说法。`);
    process.exit(2);
  }
  if (resolved.status !== 200) die('resolve 意图', resolved);
  const planId = resolved.body.planId;
  say(`\n④ 计划已落：planId=${planId}  expiresIn=${resolved.body.expiresIn}s`);
  for (const s of resolved.body.steps ?? []) say(`   - ${s.call_name} · ${s.action} ${JSON.stringify(s.args ?? {})}`);
  if ((resolved.body.skipped ?? []).length > 0) say(`   跳过：${JSON.stringify(resolved.body.skipped)}`);

  if (flag('no-execute')) {
    say('\n（--no-execute：只 resolve，不 execute；计划到期自动失效。）');
    // 预览模式也要给机器可读汇总——否则 `--json` 在这条分支上等于什么都没说。
    if (asJson) console.log(JSON.stringify({ capabilities: caps.body, resolve: resolved.body }));
    return;
  }

  // ⑤ execute：认领一次、按步执行、如实收口。
  const executed = await call('POST', '/api/v1/intent/execute', { token, body: { planId } });
  if (executed.status !== 200) die('execute 计划', executed);
  say(`\n⑤ 执行收口：status=${executed.body.status}`);
  for (const r of executed.body.steps ?? []) {
    say(`   ${r.ok ? 'ok' : 'fail'}  ${r.call_name} · ${r.action}${r.ok ? '' : ` — ${r.error}`}`);
  }

  if (asJson) {
    console.log(JSON.stringify({ capabilities: caps.body, resolve: resolved.body, execute: executed.body }));
  }
}

main().catch((e) => {
  console.error('\n✗ 未捕获异常：', e);
  process.exit(1);
});
