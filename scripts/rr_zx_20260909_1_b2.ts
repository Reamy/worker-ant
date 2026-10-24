/**
 * zx_20260909_1 M2 受控复跑：域A 出站失败落账 + 短窗补发(A3 wa_im_outbox)。
 *
 * 语义复刻 im-outbox 核心(retryImOutbox：落账 pending → 退避 1/2/4min×上限3 → 成功 sent / 超次 dead /
 * 超窗 created_at>window 直接 dead 不补发 / window<=0 不扫) + 源码静态断言(建表/config/消费/接线/F3 契约未动)。
 * 注入假发送计数，不经真实适配器(无 Electron)；绝不触碰开发库。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (p?: string) => any };

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
const dbt = rd('apps/worker-ant-desktop/src/main/database.ts');
const idxt = rd('apps/worker-ant-desktop/src/main/index.ts');
const mnf = rd('apps/worker-ant-desktop/src/main/core/im/im-notify.ts');
const obx = rd('apps/worker-ant-desktop/src/main/core/im/im-outbox.ts');
const iip = rd('apps/worker-ant-desktop/src/main/ipc/im.ipc.ts');

function mkdb(): any {
  const db = new DatabaseSync(':memory:') as any;
  db.exec(`CREATE TABLE wa_im_outbox (
    id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, task_id TEXT, kind TEXT,
    message TEXT, attempts INTEGER DEFAULT 0, status TEXT DEFAULT 'pending',
    next_retry_at INTEGER, created_at TEXT DEFAULT (datetime('now'))
  );
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);`);
  return db;
}
function enq(db: any, e: any, createdAtSql = "datetime('now')"): void {
  db.prepare(`INSERT INTO wa_im_outbox (id,channel_id,external_user_id,task_id,kind,message,attempts,status,next_retry_at,created_at) VALUES (?,?,?,?,?,?,0,'pending',?,${createdAtSql})`)
    .run(crypto.randomUUID(), e.channelId, e.externalUserId, e.taskId, e.kind || 'notification', e.message || '', Date.now());
}
const parseMs = (s: string) => { const t = /(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : s.replace(' ', 'T') + 'Z'; const m = new Date(t).getTime(); return Number.isNaN(m) ? 0 : m; };

/** 复刻 retryImOutbox 单轮(窗口判超窗 → send? sent : 超次 dead / 退避 next) */
function repRetry(db: any, nowMs: number, windowMin: number, sendResult: boolean): number {
  if (!windowMin || windowMin <= 0) return 0;
  const rows = db.prepare("SELECT * FROM wa_im_outbox WHERE status='pending' AND next_retry_at IS NOT NULL AND next_retry_at <= ? ORDER BY next_retry_at ASC LIMIT 20").all(nowMs) as any[];
  let sent = 0;
  for (const r of rows) {
    const cm = parseMs(r.created_at);
    if (cm > 0 && (nowMs - cm) / 60_000 >= windowMin) { db.prepare("UPDATE wa_im_outbox SET status='dead', attempts=attempts+1 WHERE id=? AND status='pending'").run(r.id); continue; }
    if (sendResult) { db.prepare("UPDATE wa_im_outbox SET status='sent', attempts=attempts+1, next_retry_at=NULL WHERE id=? AND status='pending'").run(r.id); sent++; continue; }
    const na = r.attempts + 1;
    if (na >= 3) db.prepare("UPDATE wa_im_outbox SET status='dead', attempts=? WHERE id=? AND status='pending'").run(na, r.id);
    else db.prepare("UPDATE wa_im_outbox SET attempts=?, next_retry_at=? WHERE id=? AND status='pending'").run(na, nowMs + [1, 2, 4][na - 1] * 60_000, r.id);
  }
  return sent;
}

console.log('A3·发送失败落账(wa_im_outbox pending)');
{
  const db = mkdb();
  enq(db, { channelId: 'c1', externalUserId: 'u1', taskId: 't1', kind: 'completion', message: 'hello' });
  const r = db.prepare("SELECT status, attempts, next_retry_at FROM wa_im_outbox LIMIT 1").get();
  ok(r.status === 'pending' && r.attempts === 0 && typeof r.next_retry_at === 'number', '落账为 pending/0 次尝试/next_retry_at 已设', JSON.stringify(r));
}

console.log('A3·退避重试闭环(注入假发送失败)');
{
  const db = mkdb();
  const base = Date.now() + 10_000;
  enq(db, { channelId: 'c1', externalUserId: 'u1', taskId: 't1', kind: 'completion', message: 'hi' });
  db.prepare('UPDATE wa_im_outbox SET next_retry_at = ?').run(base);
  let now = base;
  const states: string[] = [];
  for (let i = 0; i < 3; i++) {
    repRetry(db, now, 10, false);
    const s = db.prepare("SELECT status, attempts FROM wa_im_outbox LIMIT 1").get();
    states.push(`${s.status}:${s.attempts}`);
    if (s.status === 'pending') now = (db.prepare('SELECT next_retry_at FROM wa_im_outbox LIMIT 1').get().next_retry_at as number) + 1;
  }
  ok(states[0] === 'pending:1' && states[1] === 'pending:2' && states[2] === 'dead:3',
    '3 次失败退避(1/2/4min)后 dead(次数有界)', states.join(' → '));
}

console.log('A3·成功即 sent / 超窗 dead 不补发 / 窗口 0=关');
{
  const db = mkdb();
  enq(db, { channelId: 'c1', externalUserId: 'u1', taskId: 't1', kind: 'completion', message: 'hi' });
  db.prepare('UPDATE wa_im_outbox SET next_retry_at = ?').run(Date.now());
  repRetry(db, Date.now() + 1, 10, true);
  ok(db.prepare("SELECT status FROM wa_im_outbox LIMIT 1").get().status === 'sent', '补发成功 → sent');
}
{
  const db = mkdb();
  enq(db, { channelId: 'c1', externalUserId: 'u1', taskId: 't1', kind: 'completion', message: 'hi' }, "datetime('now','-30 minutes')");
  db.prepare('UPDATE wa_im_outbox SET next_retry_at = ?').run(Date.now());
  const sentN = repRetry(db, Date.now() + 1, 10, true);
  ok(sentN === 0 && db.prepare("SELECT status FROM wa_im_outbox LIMIT 1").get().status === 'dead', '超窗(created_at>窗口)→ dead 且不补发(send 未被调用)', `sent=${sentN}`);
}
{
  const db = mkdb();
  enq(db, { channelId: 'c1', externalUserId: 'u1', taskId: 't1', kind: 'completion', message: 'hi' });
  db.prepare('UPDATE wa_im_outbox SET next_retry_at = ?').run(Date.now());
  repRetry(db, Date.now() + 1, 0, true);
  ok(db.prepare("SELECT status FROM wa_im_outbox LIMIT 1").get().status === 'pending', 'im.outbox_retry_min=0 → 不扫不补发(行保持 pending)');
}

console.log('A3·静态接线(建表/消费/接线/F3 契约未动)');
{
  ok(dbt.includes('CREATE TABLE IF NOT EXISTS wa_im_outbox') && dbt.includes('idx_wa_im_outbox_due'), 'database.ts 幂等建 wa_im_outbox + due 索引');
  ok(dbt.includes("ensureSetting('im.outbox_retry_min', '10')"), 'config ensureSetting 注册 im.outbox_retry_min=10');
  ok(idxt.includes("import('./core/im/im-outbox.js')") && idxt.includes('retryImOutbox(db!, min)') && idxt.includes("key = 'im.outbox_retry_min'") && idxt.includes('20_000'),
    'index 每 20s 扫 outbox + im.outbox_retry_min 门控(0=关)');
  ok(mnf.includes('enqueueImOutbox(db, { channelId: tg.channelId') && mnf.includes("await import('./im-outbox.js')"), 'pushImNotify 发送失败落账 outbox(不静默吞)');
  ok(obx.includes('OUTBOX_MAX_ATTEMPTS = 3') && obx.includes('OUTBOX_BACKOFF_MIN = [1, 2, 4]'), 'outbox 次数有界 3 / 退避 1/2/4(知止不穷追)');
  // 订正（M3 落地时）：契约升级为带回**真原因**的结果对象（供补发判定 + 入账记因）。
  ok(iip.includes('Promise<{ ok: boolean; error?: string }>'), 'sendImCompletionNotice 返回送达结果(带原因)供补发判定');
  // 订正（zx_20260913 M1-4 落地时，**非回归**）：im-outbox 此后**有意**补一条 failed 对话行（"未送达也到场"），
  //   故旧断言"源码里不提 wa_im_conversations"不再成立。契约随之升级为更强、更真的版本：
  //   ① 仍不碰 F3 目录契约；② 对话行写入**唯一一处**且只记 failed（成功不另写 ⇒ 不重复写会话账）；
  //   ③ 以 outbox_id 真关联，补发成功翻**同一行**（两账同源，不是第二份真源）。
  ok(!obx.includes('NOTIFICATION_PAYLOAD_DIR'), 'outbox 不碰 F3 目录契约（跨仓库推送契约未动）');
  ok((obx.match(/INSERT INTO wa_im_conversations/g) || []).length === 1, '对话行写入恰一处（不重复写会话账）');
  ok(/'outbound', 'failed'/.test(obx) && !/INSERT INTO wa_im_conversations[^"]*'sent'/.test(obx), '该写入只记 failed（未送达），不伪装成功');
  ok(/outbox_id/.test(obx) && /flipConversationSent\(db, id\)/.test(obx), '以 outbox_id 真关联 + 补发成功翻同一行（两账同源）');
}

console.log('\n结果: pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
