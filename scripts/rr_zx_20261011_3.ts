/**
 * zx_20261011_3 受控复跑 —— 协同面板**删除离线节点**（把退场/换机/长期离线的他机行清出协同网络）。
 *
 * 本轮口径一句话（老子·知止 / 维特根斯坦·意义即使用）：**只删他机 ∧ 离线**，且删的是**真账**
 *   （ANS 硬删除 + 吊销其 key），不是把一行字从屏幕上抹掉。
 *
 * 病根（本轮方案 §Context）：
 *   - 多机协同一台工蚁退场后，其行**永久**留在 `ans_nodes` 与面板里，无从清理 ⇒ 面板只增不减。
 *   - 为何**硬删**而非软删（`status='revoked'`）：注册路由的重复判据 `SELECT node_id FROM ans_nodes
 *     WHERE node_id=?` **不看 status** ⇒ 软删会让同一 `node_id` **永久**不能再注册，且其心跳
 *     `UPDATE … WHERE node_id=?` 会命中该行而回 200（**假的成功**）却永不进列表——静默的病。
 *   - 为何**只删离线**：在线者删了下一拍即回，且删完对方立刻大面积 401，语义混乱。
 *   - 为何**不删本机**：删自己 = 退出协同网络（且吊销自己的凭据）——与"清理他机"是两件事。
 *   - 代价（已确认接受）：吊销该节点 key ⇒ 那台机对 ANS 的**全部**调用 401（响的、响得响）——
 *     这正是"被移出协同网络"的诚实语义（对比静默）。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：判据一律静态导入生产导出（被删/改名即编译期失败）。
 *   G-2 **两侧标本**：`canRemovePeer` 走**四格穷举**（他机/本机 × 在线/离线），不只喂"该命中"那只。
 *   G-5 判"用户可见文案还在不在"读 `stripKeepingLines` 后的代码（注释里提到旧文案不构成本文之病）。
 *   G-6 **无轮次字面量**：本轮方案路径/脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：判据引用的生产符号**静态导入** ⇒ 被删/改名即编译期失败（而非"扫了个空、静默假绿"）。
//   「可否把这一行移出协同网络」的**唯一判据**（承 feedback_predicate_needs_both_sides_specimen）。
import { canRemovePeer } from '../apps/worker-ant-desktop/renderer/src/lib/node-view.js';

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** 等值断言（把实际值一并打出——红的时候要能立刻看出"差在哪"）。 */
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
/** 静态判据读**原文**；判"用户可见文案还在不在"用 `CODE()`（G-5）。 */
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');

async function main(): Promise<void> {
  // ═══ A｜判据「只删他机 ∧ 离线」的四格穷举（维特根斯坦·意义即使用）══════════════════
  console.log('\n【A】`canRemovePeer` 四格穷举（判据一处、可两标本直跑）');
  {
    // —— 四格穷举（承 feedback_predicate_needs_both_sides_specimen：豁免/门槛类判据须用两只标本）——
    //   只喂"他机离线"（该命中）那只 ⇒ 任何过宽的变体（如 `!local` 或 `!online` 单边）都会全票通过。
    eq([
      canRemovePeer(false, false), // 他机 ∧ 离线 ⇒ **可删**（该命中）
      canRemovePeer(false, true),  // 他机 ∧ **在线** ⇒ 不可删（删了即回、且对方大面积 401）
      canRemovePeer(true, false),  // **本机** ∧ 离线 ⇒ 不可删（删自己=退出网络，另吊销自有凭据）
      canRemovePeer(true, true),   // 本机 ∧ 在线 ⇒ 不可删
    ], [true, false, false, false],
      'A-1 ★★四格穷举：**仅**「他机 ∧ 离线」为真；本机（任一时间）/在线他机**皆落选**（单边变体挡得住才算数）');

    // —— 判据**一处**：具名纯函数在词表模块导出（不在页面里内联第二份 `!local && !online`）——
    const NV = CODE(`${A}/renderer/src/lib/node-view.ts`);
    ok(/export function canRemovePeer\(local: boolean, online: boolean\): boolean/.test(NV),
      'A-2 判据具名导出在词表模块（`node-view.ts`——与 `isNodeOnline` 同处，非页面内联）');
    const PEERS_A = CODE(`${A}/renderer/src/pages/PeersPage.tsx`);
    ok(/canRemovePeer\(local, online\)/.test(PEERS_A) && !/!local && !online/.test(PEERS_A),
      'A-3 ★判据**一处**：页面经 `canRemovePeer(local, online)` 调用（无内联 `!local && !online` 第二份——两份必有一份漂）');
  }

  // ═══ B｜renderer 接线（删除按钮只在判据内渲染 + 后果说清 + 写口在册）════════════════
  console.log('\n【B】renderer：删除按钮（只他机离线）+ 后果文案 + 写口调用');
  {
    const PEERS = CODE(`${A}/renderer/src/pages/PeersPage.tsx`);
    // —— 按钮**只在** `canRemovePeer` 条件内渲染（条件与调用同一判据）——
    ok(/!local && canRemovePeer\(local, online\) && onRemove \? \(/.test(PEERS),
      'B-1 ★按钮渲染以 `!local && canRemovePeer(local, online) && onRemove` 为前置（按钮与判据同源，无第二份门槛）');
    ok(/onRemove\?: \(\) => void/.test(PEERS),
      'B-2 `NodeRow` 增可选 `onRemove`（本机行不传 ⇒ 即便判据漏了也无按钮，双保险）');
    ok(/onRemove=\{\(\) => void removePeer\(n\)\}/.test(PEERS) && /\{!local && canRemovePeer/.test(PEERS),
      'B-3 他机行真传 `onRemove`（算了却不用＝摆设——判据与接线两跳都在）');

    // —— 确认文案**说清后果**（硬删台账 + 吊销 key + 需重新入网）——
    ok(PEERS.includes('从 ANS 台账删除该节点行') && PEERS.includes('吊销该节点的 key')
      && PEERS.includes('需用新令牌重新入网'),
      'B-4 ★确认文案说清后果：硬删台账行 + 吊销其 key + 对方需重新入网（不是"删一行"那么轻）');

    // —— 写口调用走 `nodesApi.remove`；失败**如实上屏**（不静默吞）——
    ok(/await nodesApi\.remove\(n\.node_id\)/.test(PEERS),
      'B-5 ★handler 真调 `nodesApi.remove(n.node_id)`（唯一的删除出路，非摆设）');
    ok(/setRemoveErr\(/.test(PEERS) && /\{removeErr && \(/.test(PEERS),
      'B-6 失败**如实上屏**（`setRemoveErr` 写入 + `{removeErr && (` 渲染——不把错误吞成"看着成功了"）');
    ok(/void q\.reload\(\)/.test(PEERS.slice(PEERS.indexOf('async function removePeer'))),
      'B-7 无论成败 **finally 复取**台账（写后即读回——本地状态不臆造）');

    // —— 渲染层 ipc 声明面 ——
    const RIPC = CODE(`${A}/renderer/src/lib/ipc.ts`);
    ok(/remove: \(nodeId: string\) => ipcCall<\{ node_id: string; removed: boolean \}>\('nodes:delete', \{ nodeId \}\)/.test(RIPC),
      'B-8 ★渲染层 `nodes.remove` 声明指向 `nodes:delete`（通道名与 main 侧 handler 对得上）');
  }

  // ═══ C｜ANS 路由静态：三守卫（次序即判据）+ 事务三步 + 同一把尺 ═══════════════════════
  console.log('\n【C】ANS `DELETE /api/v1/nodes/:nodeId`：三守卫 + 事务三步 + 复用同一把尺');
  {
    const NODES = CODE('apps/ans-server/src/routes/nodes.ts');
    // 扫面**限于本路由处理体内**：`/result` 里也有同形的终态守卫，不设起点会认错闸（假绿/假红，承 zx_20261011_2 D10 教训）。
    const delStart = NODES.indexOf('({ params: { nodeId }, request })');
    const delEnd = NODES.indexOf("\n      .post(", delStart);
    ok(delStart >= 0 && delEnd > delStart,
      'C-0 删除路由处理体在场（后续判据的扫描面，缺则下面全无意义）',
      `delStart@${delStart} < delEnd@${delEnd}`);
    const delBody = NODES.slice(delStart, delEnd > delStart ? delEnd : delStart + 4000);

    // —— 三守卫各一句文案（次序即判据：不存在 → 自删 → 在线）——
    const nfIdx = delBody.indexOf("notFound('Node', nodeId)");
    const selfIdx = delBody.indexOf('deriveRequesterNodeId(db, request) === nodeId');
    const conflictIdx = delBody.indexOf('throw conflict(');
    ok(nfIdx >= 0 && selfIdx > nfIdx && conflictIdx > selfIdx,
      'C-1 ★★次序即判据：不存在 404 < 自删 400 < 在线 409（先认行、再认身份、最后认时间）',
      `notFound@${nfIdx} < self@${selfIdx} < conflict@${conflictIdx}`);
    ok(/throw new AppError\(ErrorCode\.INVALID_REQUEST, `Node \$\{nodeId\} cannot remove itself`, 400\)/.test(delBody),
      'C-2 ★自删报 `INVALID_REQUEST` 400（身份**由凭据派生** `deriveRequesterNodeId`，不信路径 ⇒ 冒名无从下手）');

    // —— 在线判据**只认共享真源** `NODE_OFFLINE_SEC`（此处再抄一个 90 就是第二份尺）——
    ok(/const onlineMod = `-\$\{NODE_OFFLINE_SEC\} seconds`;/.test(delBody)
      && /last_seen_at IS NOT NULL AND last_seen_at > datetime\('now', \?\)/.test(delBody),
      'C-3 ★★在线判据复用 `NODE_OFFLINE_SEC` 同一把尺（与派单侧同窄；离线含从未心跳 `NULL` ⇒ 可删）');

    // —— 事务三步：① 解套停滞件 → ② 吊销 key → ③ 硬删行 ——
    const txnIdx = delBody.indexOf('db.transaction(');
    const requeueIdx = delBody.indexOf('UPDATE ans_node_requests');
    const revokeIdx = delBody.indexOf('keyManager.revokeApiKey(row.api_key_prefix)');
    const delRowIdx = delBody.indexOf("DELETE FROM ans_nodes WHERE node_id = ?");
    ok(txnIdx >= 0 && requeueIdx > txnIdx && revokeIdx > requeueIdx && delRowIdx > revokeIdx,
      'C-4 ★★同一事务三步、次序即判据：① 解套停滞件 → ② 吊销 key → ③ 硬删行',
      `txn@${txnIdx} < requeue@${requeueIdx} < revoke@${revokeIdx} < delRow@${delRowIdx}`);
    ok(/status = 'pending', target_node_id = NULL, question_json = NULL,\s*\n\s*answer_json = NULL, question_status = NULL, claimed_at = NULL/.test(delBody)
      && /AND status IN \('assigned', 'awaiting_answer'\)/.test(delBody),
      'C-5 ★解套**只退非终态**件（`assigned`/`awaiting_answer` 退回 `pending ∧ target NULL`；终态 done/error 是历史账，不动）');
    ok(/key_revoked: true, requeued/.test(delBody),
      'C-6 回执**如实报退回件数**（`requeued`——把"解套了几件"一并交出，不是只说"删掉了"）');
  }

  // ═══ D｜main IPC 写口：Team 软闸 + 唯一出路（DELETE）═══════════════════════════════
  console.log('\n【D】main `nodes:delete`：过 Team 软闸 + 经唯一出路打 DELETE');
  {
    const NIPC = CODE(`${A}/src/main/ipc/nodes.ipc.ts`);
    const i = NIPC.indexOf("ipcMain.handle('nodes:delete'");
    const j = NIPC.indexOf('ipcMain.handle(', i + 10);
    const body = i >= 0 ? NIPC.slice(i, j < 0 ? NIPC.length : j) : '';
    ok(i >= 0, 'D-0 `nodes:delete` handler 在场', `@${i}`);
    ok(body.includes("teamFeatureRefusal(licDb, 'multi_node')") && body.includes("code: 'TEAM_REQUIRED'"),
      'D-1 ★写口**过 Team 软闸**（与 `nodes:update` 同源；未解锁即不触 ANS、如实回 `TEAM_REQUIRED`）');
    ok(body.includes('ansSignedRequest(creds,') && /method: 'DELETE'/.test(body),
      'D-2 ★经**全仓唯一出路** `ansSignedRequest(…, { method: \'DELETE\' })` 打 ANS（不另起一条 HTTP 路）');
    ok(body.includes("eventBus.emit('node.presence_changed'"),
      'D-3 成功 ⇒ 广播 `node.presence_changed`（面板据此复取，不靠本地臆造）');
    ok(/`\/api\/v1\/nodes\/\$\{encodeURIComponent\(nodeId\)\}`/.test(body),
      'D-4 路径**编码** nodeId（`encodeURIComponent`——身份不经拼接变形）');
  }

  // ═══ E｜返回者如实（名实相符：不承诺一条永远不会来的行）════════════════════════════
  console.log('\n【E】返回者如实：401/403 如实提示 + 堵住 `data===undefined` 的假承诺');
  {
    const PEERS = CODE(`${A}/renderer/src/pages/PeersPage.tsx`);
    // —— 本机以为已入网 而 ANS 回 401/403 ⇒ 一条**如实且可行动**的话 ——
    ok(/es\.data\?\.enrolled === true && \(data\?\.errorStatus === 401 \|\| data\?\.errorStatus === 403\)/.test(PEERS),
      'E-1 ★★本机 `enrolled===true` ∧ ANS 回 401/403 ⇒ 走**如实分支**（凭据被拒 ≠ 等收录）');
    ok(PEERS.includes('本机凭据被 ANS 拒绝') && PEERS.includes('重新入网'),
      'E-2 ★该分支**说清后果且可行动**（凭据被拒 + 若已被移出则重新入网——不是沉默、不是"等待收录"）');
    ok(!/等待 ANS 台账收录[^\n]*401/.test(PEERS) && !/401[^\n]*等待 ANS 台账收录/.test(PEERS),
      'E-3 ★反证：401/403 与"等待收录"**不同框**（被移出者永不会收到那行——承诺它就是撒谎）');

    // —— 假承诺的根：`data===undefined` 时 `!data.error` 为真会落进分支 ⇒ 守护须先要求 `data` 在场 ——
    ok(/data && !data\.error && \(/.test(PEERS),
      'E-4 ★★守护硬化为 `data && !data.error && (`（IPC 层错误致 `data===undefined` 时不再落进"心跳上报后即出现"的假承诺）');

    // —— 两端 `errorStatus` **同形**（main 侧回、renderer 侧声明）——
    // zx_20261011_4 M3（维特根斯坦·一个概念一个值）：取数口 `fetchNodes` 由 `ipc/nodes.ipc.ts` **上移**
    //   `core/node-list.ts`（electron-free）——面板与编排器读**同一份**台账。钉子随之**重定向到新载体**
    //   （非放宽：并反证旧处不再自留一份，防"同一件事两个名字"）。
    ok(/errorStatus: r\.status/.test(CODE(`${A}/src/main/core/node-list.ts`)),
      'E-5 ★main 侧失败支如实带 `errorStatus: r.status`（结构化 HTTP 状态，传输失败为 0——与 renderer 声明同形；真源＝core/node-list.ts）');
    ok(!/function fetchNodes/.test(CODE(`${A}/src/main/ipc/nodes.ipc.ts`)),
      'E-5b ★反证：`ipc/nodes.ipc.ts` 不再自留一份 `fetchNodes`（取数只此一处真源，转调 core/node-list.ts）');
    ok(/errorStatus\?: number/.test(CODE(`${A}/renderer/src/lib/ipc.ts`)),
      'E-6 renderer `NodesListPayload` 声明 `errorStatus?: number`（与 main 侧同形——两处不漂）');
  }

  // ═══ S｜哑雷自检 + build 钉（派生核对，不写轮次字面量）══════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 ★方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261011_3: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261011_3 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ rr_zx_20261011_3: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
