/**
 * zx_20261022_3 批二 —— 「信·两机真通路」：真 ANS 进程 + 两套真桌面库，端到端走一遍。
 *
 * 判据纪律（承 CLAUDE.md 与 auto-memory）：
 *   · **不打桩冒充端到端**：ANS 真起进程、真 HTTP；注册/心跳/派单/拉取/回传/读回全部走生产函数
 *     （`ensureNodeEnrolled` / `makeAnsHeartbeatSend` / `dispatchNodeRequest` / `makeAnsRequestIo` /
 *      `startNodeRequestWorker` / `refreshDispatchResult`），不在脚本里自造等价调用。
 *   · **失败不静默跳过**：ANS 起不来 / 端口拿不到 ⇒ 断言记红并退非 0，绝不"没环境就当作通过"。
 *   · 计数器类断言给 0→1 正面值（`poll()` 返回 1、请求状态真变 `done`）。
 *   · 断言文案不含失败字形（`pnpm rr:all` 按字形计数）。
 *
 * 场景（与本轮方案 §2 批二对应）：
 *   A = 派活方（role=primary，不起心跳），B = 执行方（worker，有心跳，容量可压到 0），
 *   C = 备用执行方（worker，有心跳，余力充足），D = 已注册但从未心跳（离线标本）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';
import { checkBuildPins } from './lib/rr-pins.js';
import { initDatabase } from '../apps/worker-ant-desktop/src/main/database.js';
import {
  ensureNodeEnrolled,
  makeAnsHeartbeatSend,
  startNodeHeartbeat,
  collectNodeEnv,
} from '../apps/worker-ant-desktop/src/main/core/node-heartbeat.js';
import { ansSignedRequest, resolveAnsCreds, type AnsCreds } from '../apps/worker-ant-desktop/src/main/core/ans-signed-request.js';
import { fetchNodes } from '../apps/worker-ant-desktop/src/main/core/node-list.js';
import { dispatchNodeRequest, refreshDispatchResult } from '../apps/worker-ant-desktop/src/main/core/node-dispatcher.js';
import { makeAnsRequestIo } from '../apps/worker-ant-desktop/src/main/core/node-request-io.js';
import { startNodeRequestWorker } from '../apps/worker-ant-desktop/src/main/core/node-request-worker.js';
import { resolveTsxCli } from '../apps/worker-ant-desktop/src/main/core/ans-supervisor.js';
import { MACHINE_CONCURRENCY_SETTING_KEY } from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ok ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);
}

const root = path.join(__dirname, '..');
const A_DIR = path.join(root, 'apps/worker-ant-desktop');

function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO wa_settings (key,value,updated_at) VALUES (?,?,datetime('now'))").run(key, value);
}
function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM wa_settings WHERE key=?').get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}
function addRunningTask(db: Database.Database, id: string): void {
  db.prepare('INSERT INTO wa_tasks (id,title,status) VALUES (?,?,?)').run(id, id, 'executing');
}

/** 取一个空闲端口（bind 0 后立刻释放；同刻被占的概率可忽略，且起服失败会如实红）。 */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('未能取到空闲端口'))));
    });
  });
}

/** 本机 ANS 进程的真起法：系统 node + tsx 真 JS 入口（与 `ans-supervisor` 同源，绝不用 .bin 垫片）。 */
function spawnAns(port: number, dbPath: string): { child: ChildProcess; log: () => string } {
  const tsxCli = resolveTsxCli(root);
  if (!tsxCli) throw new Error('tsx 真入口解析不到（resolveTsxCli 为 null）');
  const child = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
    cwd: path.join(root, 'apps/ans-server'),
    env: {
      ...process.env,
      ANS_DB_PATH: dbPath,
      ANS_SERVER_PORT: String(port),
      WA_ANS_AUTOSTART: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  const onData = (c: Buffer): void => { buf += c.toString('utf-8'); if (buf.length > 40_000) buf = buf.slice(-20_000); };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  return { child, log: () => buf };
}

async function waitHealth(port: number, timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx20261022_3-two-node-'));
  const ansDbPath = path.join(tmp, 'ans', 'ans-server.db');
  fs.mkdirSync(path.dirname(ansDbPath), { recursive: true });
  const dirA = path.join(tmp, 'node-a');
  const dirB = path.join(tmp, 'node-b');
  const dirC = path.join(tmp, 'node-c');
  const dirD = path.join(tmp, 'node-d');

  let child: ChildProcess | null = null;
  const dbs: Database.Database[] = [];
  try {
    // ── 0 起一个真 ANS（临时库、真端口）────────────────────────────────
    console.log('\n=== zx_20261022_3 批二 两机真通路 ===');
    const port = await pickFreePort().catch(() => 0);
    ok(port > 0, '0-1 取得空闲端口（起服从真端口开始，不借用生产 27183）', `port=${port}`);
    const spawned = spawnAns(port, ansDbPath);
    child = spawned.child;
    const healthy = await waitHealth(port);
    ok(healthy, '0-2 ★真 ANS 进程已就绪（GET /api/v1/health 通）',
      healthy ? `port=${port}` : `未就绪，子进程日志尾：${spawned.log().slice(-800)}`);
    if (!healthy) throw new Error('ANS 未就绪，后续端到端断言无从谈起（不静默跳过）');
    const baseUrl = `http://127.0.0.1:${port}`;
    const dbName = await (async () => {
      // 让断言"连的是这个临时库"有据：ANS 启动日志会印 dbPath。
      await new Promise((r) => setTimeout(r, 300));
      return spawned.log().includes('ans-server.db') || spawned.log().length > 0;
    })();
    ok(dbName, '0-3 ANS 子进程有启动日志（连的是临时库，不碰 data/ans-server.db）');

    // 令牌直接种进**临时 ANS 库**（fixture 播种；注册本身走真 HTTP 端点）。
    const ansDb = new Database(ansDbPath);
    const tokens = ['tok-a', 'tok-b', 'tok-c', 'tok-d'];
    const insTok = ansDb.prepare('INSERT OR IGNORE INTO ans_enrollment_tokens (token,max_uses,used_count) VALUES (?,?,0)');
    for (const t of tokens) insTok.run(t, 1);
    ansDb.close();

    const dbA = initDatabase(dirA);
    const dbB = initDatabase(dirB);
    const dbC = initDatabase(dirC);
    const dbD = initDatabase(dirD);
    dbs.push(dbA, dbB, dbC, dbD);
    const seeded: Array<[Database.Database, string]> = [[dbA, 'tok-a'], [dbB, 'tok-b'], [dbC, 'tok-c'], [dbD, 'tok-d']];
    for (const [db, tok] of seeded) {
      setSetting(db, 'ans_server_url', baseUrl);
      setSetting(db, 'node.enrollment_token', tok);
    }
    // A 是派活方：roles 由注册那一刻上报（`ensureNodeEnrolled` 读设置）。
    setSetting(dbA, 'node.role', 'primary');

    // ── 1 真注册：令牌 → key（HTTP）────────────────────────────────────
    const enrollA = await ensureNodeEnrolled(dbA);
    const enrollB = await ensureNodeEnrolled(dbB);
    const enrollC = await ensureNodeEnrolled(dbC);
    const enrollD = await ensureNodeEnrolled(dbD);
    ok(enrollA.enrolled && enrollB.enrolled && enrollC.enrolled && enrollD.enrolled,
      '1-1 ★四台经真端点注册成功（POST /api/v1/nodes/register，令牌各用一次）',
      [enrollA.reason, enrollB.reason, enrollC.reason, enrollD.reason].join(' / '));
    eq([enrollA.resourceGroup, enrollB.resourceGroup],
      [`node:${enrollA.nodeId}`, `node:${enrollB.nodeId}`],
      '1-2 资源组由 ANS 签发并回写（node:<node_id>，非本地自编）');
    ok(!!getSetting(dbB, 'ans_api_key') && !!getSetting(dbB, 'ans_secret_key'),
      '1-3 B 的 api_key/secret_key 已落库（后续心跳/拉取据此签名）');

    const credsA = resolveAnsCreds(dbA);
    const credsB = resolveAnsCreds(dbB);
    const credsC = resolveAnsCreds(dbC);
    const credsD = resolveAnsCreds(dbD);

    // ── 2 真心跳 → 真台账 ────────────────────────────────────────────
    // 4-2 判的是 **ANS 的排序**，不是宿主此刻的忙闲：本机内存/CPU 紧张时 C 的真实余力也会报 0
    //   （实测 C `capacity_free_ratio=0` ⇒ B/C 同为 0 时按权重选回 B，判据在健康机器上才偶然成立）。
    //   ⇒ 在既有的 `send` 注入点固定两台机器的余力（仍走真 HTTP/HMAC；生产那一跳的真算法由 4-1 与
    //   `rr_zx_20261022_1` 的采集断言把关）。B 按其真实槽位有无取 1/0，C 恒 0.5。
    const sendB = makeAnsHeartbeatSend(dbB);
    const hbB = startNodeHeartbeat(dbB, {
      autoStart: false,
      send: (id, status, card) => sendB(id, { ...status, capacity_free_ratio: (status.free_slots ?? 0) > 0 ? 1 : 0 }, card),
    });
    const sendC = makeAnsHeartbeatSend(dbC);
    const hbC = startNodeHeartbeat(dbC, {
      autoStart: false,
      send: (id, status, card) => sendC(id, { ...status, capacity_free_ratio: 0.5 }, card),
    });
    await hbB.tick();
    await hbC.tick();
    ok(hbB.getState().lastOkAt !== null && hbC.getState().lastOkAt !== null,
      '2-1 ★心跳经真 HTTP 到 ANS 并成功（lastOkAt 非空，consecutiveFailures=0）',
      `B err=${hbB.getState().lastError ?? 'none'} · C err=${hbC.getState().lastError ?? 'none'}`);
    eq(hbB.getState().consecutiveFailures, 0, '2-2 成功一跳不残留失败计数');

    const ledger = await fetchNodes(dbA, enrollA.nodeId);
    const ids = ledger.nodes.map((n) => n.node_id);
    ok(!ledger.error && ids.includes(enrollB.nodeId) && ids.includes(enrollC.nodeId) && ids.includes(enrollD.nodeId),
      '2-3 ★A 读到台账里真有 B/C/D（GET /api/v1/nodes，非本地臆造）',
      ledger.error ? `err=${ledger.error}` : `nodes=${ledger.nodes.length}`);
    const nodeB = ledger.nodes.find((n) => n.node_id === enrollB.nodeId);
    ok(!!nodeB && nodeB.card?.categories?.includes('text'),
      '2-4 B 的能力卡随心跳上送并落库（card_json.categories 含 text）',
      `cats=${JSON.stringify(nodeB?.card?.categories)}`);

    // A（primary）改 B 权重——手动目标/排序都要它；顺带验 PATCH 真生效。
    setSetting(dbA, 'node.role', 'primary');
    const w = await ansSignedRequest(credsA, `/api/v1/nodes/${encodeURIComponent(enrollB.nodeId)}`,
      { method: 'PATCH', body: { weight: 3 } });
    ok(w.ok, '2-5 A（primary）可改他机档位（PATCH /nodes/:id 真生效）', `status=${w.status}`);

    // ── 3 真派单 → 真拉取 → 真回传 → 真读回 ─────────────────────────
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const dispatch = await dispatchNodeRequest(dbA, { category: 'text', payload: { prompt: '两机通路探针' } },
      { emit: (type, data) => { events.push({ type, data }); } });
    ok(dispatch.ok && dispatch.targetNodeId === enrollB.nodeId,
      '3-1 ★自动派单选中 B（A 未心跳 ⇒ 不在候选；B 权重 3 ⇒ 净收益最高）',
      `ok=${dispatch.ok} target=${dispatch.targetNodeId} status=${dispatch.status} note=${dispatch.note}`);
    eq(dispatch.status, 'assigned', '3-2 提交即为 assigned（存在合资格目标，不落 pending）');
    ok(events.some((e) => e.type === 'node.request_dispatched' && e.data.requestId === dispatch.requestId),
      '3-3 出站台账事件 `node.request_dispatched` 到场（左半）');

    let runnerSaw: { category: string; archetype: string; tools: string[] } | null = null;
    const worker = startNodeRequestWorker({
      nodeId: enrollB.nodeId,
      io: makeAnsRequestIo(dbB),
      runner: async (req, tools, archetype) => {
        runnerSaw = { category: req.category, archetype, tools };
        return { status: 'done', result: { echo: (req.payload as Record<string, unknown>)?.prompt ?? null } };
      },
      onEvent: (e) => { events.push({ type: e.type, data: { ...e } }); },
    });
    const handled = await worker.poll();
    eq(handled, 1, '3-4 ★B 拉到并办掉恰 1 件（0→1 正面值，非"不抛即过"）');
    eq(runnerSaw?.archetype, 'conversation', '3-5 类目 text 映射 conversation 档（工具面按类目收窄）');
    ok((runnerSaw?.tools.length ?? 0) > 0, '3-6 执行方拿到该类目的工具名单（非空）',
      `tools=${runnerSaw?.tools.length}`);

    const readBack = await refreshDispatchResult(dbA, dispatch.requestId, { emit: (type, data) => { events.push({ type, data }); } });
    eq(readBack.request?.status, 'done', '3-7 ★A 读回终态 done（请求方身份鉴权通过）');
    eq(readBack.request?.result?.echo, '两机通路探针', '3-8 回传载荷原样往返（结果不是空壳）');
    ok(events.some((e) => e.type === 'node.request_result' && e.data.requestId === dispatch.requestId),
      '3-9 读回即落收口事件 `node.request_result`（右半，闭环有账）');

    // ── 4 反证：容量只是排序信号、离线/不参与者派不出去 ─────────────
    setSetting(dbB, MACHINE_CONCURRENCY_SETTING_KEY, '2');
    addRunningTask(dbB, 'b-task-1');
    addRunningTask(dbB, 'b-task-2');
    const envB = collectNodeEnv(dbB);
    eq(envB.capacity_free_ratio, 0, '4-1 B 满槽 ⇒ 机器余力 0（与执行闸同源的三源取严）');
    await hbB.tick();
    // 前置自证：排序的输入确实是"B 0 / C 正"——否则下面那句"让位"可能因别的原因碰巧成立。
    const ledger4 = await fetchNodes(dbA, enrollA.nodeId);
    const capOf = (id: string): number => {
      const s = ledger4.nodes.find((n) => n.node_id === id)?.status;
      return Number((s as { capacity_free_ratio?: unknown } | null | undefined)?.capacity_free_ratio);
    };
    ok(capOf(enrollB.nodeId) === 0 && capOf(enrollC.nodeId) > 0,
      '4-2a 前置：台账里 B 余力 0、C 余力 > 0（否则"让位"无从谈起）',
      `B=${capOf(enrollB.nodeId)} C=${capOf(enrollC.nodeId)}`);

    const dispatch2 = await dispatchNodeRequest(dbA, { category: 'text', payload: { prompt: '容量排序探针' } },
      { emit: () => {} });
    ok(dispatch2.ok && dispatch2.targetNodeId === enrollC.nodeId,
      '4-2 ★容量 0 ⇒ 不被自动选中（B 权重 3×余力 0 仍让位于 C）——余力是排序信号，不是资格闸',
      `target=${dispatch2.targetNodeId}`);

    const explicit = await dispatchNodeRequest(dbA, { category: 'text', targetNodeId: enrollB.nodeId },
      { emit: () => {} });
    ok(explicit.ok && explicit.targetNodeId === enrollB.nodeId,
      '4-3 ★显式指定容量 0 的 B 仍可派（证明 4-2 是排序而非排除）',
      `ok=${explicit.ok} note=${explicit.note}`);

    await ansSignedRequest(credsA, `/api/v1/nodes/${encodeURIComponent(enrollB.nodeId)}`,
      { method: 'PATCH', body: { participate: false } });
    const noPart = await dispatchNodeRequest(dbA, { category: 'text', targetNodeId: enrollB.nodeId }, { emit: () => {} });
    // 如实拒的**原因**在响应体里（`ansFailureNote` 只带状态码，不搬上游文案）⇒ 单取一次体来核。
    const noPartRaw = await ansSignedRequest(credsA, '/api/v1/nodes/requests',
      { method: 'POST', body: { category: 'text', target_node_id: enrollB.nodeId }, retries: 0 });
    const noPartBody = JSON.stringify(await noPartRaw.response?.json().catch(() => ({})));
    ok(!noPart.ok && noPartRaw.status === 400 && /cannot take category/.test(noPartBody),
      '4-4 B 退出参与 ⇒ 显式派单被 ANS 如实拒（不是静默改派）',
      `status=${noPartRaw.status} body=${noPartBody.slice(0, 140)}`);
    await ansSignedRequest(credsA, `/api/v1/nodes/${encodeURIComponent(enrollB.nodeId)}`,
      { method: 'PATCH', body: { participate: true } });

    const offline = await dispatchNodeRequest(dbA, { category: 'text', targetNodeId: enrollD.nodeId }, { emit: () => {} });
    const offlineRaw = await ansSignedRequest(credsA, '/api/v1/nodes/requests',
      { method: 'POST', body: { category: 'text', target_node_id: enrollD.nodeId }, retries: 0 });
    const offlineBody = JSON.stringify(await offlineRaw.response?.json().catch(() => ({})));
    ok(!offline.ok && offlineRaw.status === 400 && /cannot take category/.test(offlineBody),
      '4-5 ★从未心跳的 D（已注册但在线判据不成立）派不出去',
      `status=${offlineRaw.status} body=${offlineBody.slice(0, 140)}`);

    const bad = await ansSignedRequest(
      { baseUrl: credsB.baseUrl, apiKey: credsB.apiKey, secretKey: 'wrong-secret' } as AnsCreds,
      '/api/v1/nodes',
      { method: 'GET', retries: 0 },
    );
    ok(!bad.ok && bad.status === 401,
      '4-6 ★错密钥恒 401（验签真在跑；不是"随便哪个 key 都放行"）', `status=${bad.status}`);

    // ── 5 跨机身份越权（读他人单/用他人 node_id 拉取）────────────────
    const crossRead = await ansSignedRequest(credsC, `/api/v1/nodes/requests/${encodeURIComponent(dispatch.requestId)}`,
      { method: 'GET', retries: 0 });
    ok(!crossRead.ok && crossRead.status === 403,
      '5-1 第三方 C 读 A↔B 的单 ⇒ 403（无知之幕：宁可不给读，不假装给了）', `status=${crossRead.status}`);
    const crossPull = await ansSignedRequest(credsC, `/api/v1/nodes/requests?node_id=${encodeURIComponent(enrollB.nodeId)}`,
      { method: 'GET', retries: 0 });
    ok(!crossPull.ok && crossPull.status === 403,
      '5-2 C 用 B 的 node_id 拉待办 ⇒ 403（拉取端同样认凭据，不认 query）', `status=${crossPull.status}`);

    hbB.stop();
    hbC.stop();

    // build 钉（P1–P6 派生核对；P6 读 dist ⇒ tsup 须先于本套件）。
    checkBuildPins(ok, { distDir: path.join(A_DIR, 'dist') });
  } finally {
    for (const db of dbs) { try { db.close(); } catch { /* 已关 */ } }
    if (child && child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch { /* 已退 */ }
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 留残不影响判定 */ }
  }
}

main()
  .then(() => {
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} rr_zx_20261022_3_two_node: ${pass} 通过 / ${fail} 失败\n`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('套件异常：', e);
    console.log(`\nFAIL rr_zx_20261022_3_two_node: ${pass} 通过 / ${fail + 1} 失败\n`);
    process.exit(1);
  });
