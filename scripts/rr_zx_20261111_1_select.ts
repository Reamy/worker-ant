/**
 * zx_20261111_1 B2 —— 辅助选型：优先远端，不把整台机器拖住。
 *
 * 病根：辅助路（须知/拆解/判卷/记忆巩固…）走 `auxModelRequest` 的 `balanced` 加权随机，
 *   本地 Ollama（`qwen3.5:9b`）被选中后跑了 2 分 50 秒（或超时），整机被这一个辅助作业拖住。
 *
 * 本套钉的是**跨仓接线**与**作用域**（行为本身由 ANS 的 vitest 直调 matcher 钉）：
 *   S-1 辅助档逐字形状含 `preferRemote:true`（键序固定，新键追加在末尾）。
 *   S-2 主执行路**不带** preferRemote（反证：作用域只到辅助路）。
 *   S-3 ANS matcher：重排发生在 sortByStrategy **之后**，且 `req.preferRemote` 只用于排序/回报，
 *      不参与过滤（否则"只本地可用"会被筛成"无模型"）。
 *   S-4 路由把 body 透传进去、回包带 usedLocalFallback；Elysia body schema 收下该字段。
 *   S-5 跨仓类型与客户端回包形状同步（旧调用方不传 ⇒ 形状逐字不变）。
 *   S-6 作业侧读回 `usedLocalFallback` 并落日志；全 `src/main` 仅此一档手写 preferRemote。
 *
 * 纪律：读 ANS 源码只读文本（rr 不 import ans-server，避免把 ANS 的导入副作用带进回归进程）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { auxModelRequest, buildModelRequest } from '../apps/worker-ant-desktop/src/main/core/model-request.js';
import { stripKeepingLines } from './lib/rr-pins.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const readSrc = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');
const codeOf = (rel: string): string => stripKeepingLines(readSrc(rel)).join('\n');
const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;

function main(): void {
  // ═══ S-1｜辅助档逐字形状 ═══════════════════════════════════════════════
  console.log('\n【S-1】辅助档：远端优先，键序固定');
  {
    const aux = auxModelRequest();
    ok(JSON.stringify(aux) === '{"capabilities":["chat"],"strategy":"cost-optimal","excludeCapabilities":["reasoning"],"preferRemote":true}',
      'S-1 辅助档恰四键：capabilities,strategy,excludeCapabilities,preferRemote（新键追加在末尾）',
      JSON.stringify(aux));
    const bal = auxModelRequest({ strategy: 'balanced' });
    ok(bal.preferRemote === true && bal.strategy === 'balanced' && aux.capabilities !== bal.capabilities,
      'S-1b balanced 档同样远端优先，且每次发新数组（档不是共享可变物）', JSON.stringify(bal));

    // ═══ S-2｜反证：主执行路不受影响 ═════════════════════════════════════
    const mains = [
      buildModelRequest({ archetype: 'research', strategy: 'cost-optimal' }),
      buildModelRequest({ archetype: 'document', strategy: 'balanced' }),
      buildModelRequest({ archetype: 'code', strategy: 'cost-optimal' }),
    ];
    ok(mains.every((m) => !('preferRemote' in m)),
      'S-2 反证：主执行路三种形态都**不带** preferRemote（该由用户选定/形态决定，不因"本地慢"被悄悄换掉）',
      mains.map((m) => `[${Object.keys(m).join(',')}]`).join(' '));
  }

  // ═══ S-3｜ANS matcher：排序重排而非过滤 ════════════════════════════════
  console.log('\n【S-3】ANS matcher：远端优先只改顺序，不改候选集');
  {
    const matcher = codeOf('apps/ans-server/src/services/resource-matcher.ts');
    const iSort = matcher.indexOf('const ranked = sortByStrategy(');
    const iOrder = matcher.indexOf('orderRemoteFirst(ranked)');
    ok(iSort > 0 && iOrder > iSort,
      'S-3 重排在策略排序**之后**（远端优先是第二序，不覆盖 cost/latency/balanced 的主序）',
      `sortByStrategy@${iSort} → orderRemoteFirst@${iOrder}`);
    const queryBlock = matcher.slice(matcher.indexOf('let query ='), matcher.indexOf('db.prepare(query)'));
    ok(occurrences(matcher, 'req.preferRemote') === 2 && !queryBlock.includes('preferRemote'),
      'S-3b `req.preferRemote` 恰两处（分区 + 回包标记），**不进入 SQL 过滤**——池里只有本地时仍能选出来',
      `出现 ${occurrences(matcher, 'req.preferRemote')} 次；查询段含 preferRemote=${queryBlock.includes('preferRemote')}`);
    ok(/export function orderRemoteFirst/.test(matcher) && /\\\[::1\\\]/.test(matcher) && /export function isLocalEndpoint/.test(matcher),
      'S-3c 稳定分区函数与本地判定在位；IPv6 回环 `[::1]` 也按本地认');
    ok(/usedLocalFallback\?: boolean/.test(matcher),
      'S-3d 回包类型带 usedLocalFallback（只在请求 preferRemote 时出现）');
  }

  // ═══ S-4｜路由透传与 body schema ═══════════════════════════════════════
  console.log('\n【S-4】/api/v1/models/optimal 透传与回包');
  {
    const route = codeOf('apps/ans-server/src/routes/optimal-model.ts');
    ok(/preferRemote\?:\s*boolean/.test(route) && /preferRemote:\s*body\.preferRemote/.test(route),
      'S-4 路由 body 类型与 matcher 入参都带 preferRemote');
    ok(/usedLocalFallback:\s*result\.usedLocalFallback === true/.test(route),
      'S-4b 回包如实回报 usedLocalFallback（且只在请求了 preferRemote 时追加）');

    const idx = codeOf('apps/ans-server/src/index.ts');
    ok(/preferRemote:\s*t\.Optional\(t\.Boolean\(\)\)/.test(idx),
      'S-4c Elysia body schema 收下 preferRemote（缺了会被 422 挡在门外）');
  }

  // ═══ S-5｜跨仓类型与客户端 ═════════════════════════════════════════════
  console.log('\n【S-5】跨仓契约：shared-types 与 ans-client');
  {
    const types = codeOf('packages/shared-types/src/models.ts');
    ok(/preferRemote\?:\s*boolean/.test(types),
      'S-5 ModelRequirements 带 preferRemote?（旧 ANS 忽略未知字段，前向兼容）');

    const client = codeOf('packages/ans-client/src/client.ts');
    ok(/getOptimalModel\(req: ModelRequirements\): Promise<ModelEndpoint & \{[^}]*usedLocalFallback\?: boolean/.test(client),
      'S-5b ans-client 回包类型带 usedLocalFallback（调用方无需自造断言）');
  }

  // ═══ S-6｜作业记账与作用域 ═════════════════════════════════════════════
  console.log('\n【S-6】作业侧读回降级事实；preferRemote 只在辅助档一处');
  {
    const job = codeOf(`${A}/src/main/core/project-brief-job.ts`);
    ok(/usedLocalFallback/.test(job) && /无远端候选，本轮回退本地模型/.test(job),
      'S-6 须知作业读回 usedLocalFallback 并如实落日志（回退本地不是静默降级）');

    const mainDir = path.join(root, A, 'src/main');
    const files = (fs.readdirSync(mainDir, { recursive: true }) as string[])
      .filter((rel) => rel.endsWith('.ts'))
      .map((rel) => ({ rel: rel.split(path.sep).join('/'), src: stripKeepingLines(fs.readFileSync(path.join(mainDir, rel), 'utf-8')).join('\n') }));
    const preferSites = files.filter((f) => /preferRemote\s*:\s*true/.test(f.src)).map((f) => f.rel);
    ok(preferSites.length === 1 && preferSites[0] === 'core/model-request.ts',
      'S-6b 全 `src/main` 恰一处手写 `preferRemote: true`（辅助档真源；调用点不各自加）',
      preferSites.join(', ') || '(零命中)');
  }

  console.log(`\n[rr_zx_20261111_1_select] ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
