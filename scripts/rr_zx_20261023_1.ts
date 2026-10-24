/**
 * zx_20261023_1 受控复跑 —— 「称」：所称者，须是所能者。
 *
 * 分组（与方案 §2 对应）：
 *   Z-1 节点上限三档穷举 + 边界两只标本（含本机 / 只拦新增）
 *   Z-2 台账读数与 fail-open（读不到不拦，但如实注明未校验）
 *   Z-3 派生面：能力行 / 升级差异 / 用量回话 —— 全部由同一份 `TIER_LIMITS`
 *   Z-4 对照表与价目表同源（`tier-catalog` 的 `maxNodes` 不另抄）
 *   Z-5 接线静态钉：`nodes:enroll` 先过 Team 闸、再查节点数、最后注册
 *   Z-6 设置页上屏「本机账号」与「已注册 x/y 台」
 *   P   build 钉（P1–P6 共用真源）
 *
 * 纪律（承 CLAUDE.md 与 auto-memory）：
 *   · 直引**生产函数**（被删/改名即编译期失败，不扫字符串冒充）。
 *   · 两侧标本同试（未满 / 满员；台账可读 / 不可读）。
 *   · 断言文案不含失败字形（`pnpm rr:all` 汇总器按字形计数）。
 *   · 不写"只为下一轮"的字面量：上限一律由 `TIER_LIMITS` 派生后比较。
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { LICENSE_TIERS, TIER_LABEL, TIER_LIMITS } from '../apps/worker-ant-desktop/src/main/core/feature-limits.js';
import { capabilityLine } from '../apps/worker-ant-desktop/src/main/core/pricing.js';
import { tierCatalog } from '../apps/worker-ant-desktop/src/main/core/tier-catalog.js';
import { tierUsageCounts, upgradeDifferences, usageContextLine } from '../apps/worker-ant-desktop/src/main/core/tier-usage.js';
import { countOtherNodes, nodeQuotaCheck, nodeQuotaReached } from '../apps/worker-ant-desktop/src/main/core/node-quota.js';
import type { NodeLedger } from '../apps/worker-ant-desktop/src/main/core/node-list.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ok ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf-8');
const stripped = (p: string): string => stripKeepingLines(read(p)).join('\n');

/** 最小台账标本（`NodeLedger.nodes` 的其余字段本判据不读）。 */
function ledger(ids: string[], localNodeId: string, error?: string): NodeLedger {
  return {
    nodes: ids.map((id) => ({ node_id: id })) as unknown as NodeLedger['nodes'],
    localNodeId,
    ...(error ? { error } : {}),
  };
}

function groupZ1(): void {
  console.log('\n【Z-1】协同节点上限：三档穷举 + 边界两只标本');
  // 上限由 `TIER_LIMITS` 一处定义；此处只核形状与边界，不另抄一份档位表。
  const values = LICENSE_TIERS.map((t) => TIER_LIMITS[t].maxNodes);
  ok(values.every((v) => Number.isInteger(v) && v > 0),
    'Z-1a 三档 `maxNodes` 都是正整数（0 会被读成"不限"，本产品不提供无上限档）', values.join('/'));
  ok(TIER_LIMITS.team.maxNodes > TIER_LIMITS.pro.maxNodes,
    'Z-1b 团队档节点上限**严格大于**专业档（区分度——若相同说明没真读档位）');

  // 边界两只标本：第 max 台可进，第 max+1 台被拦。`usedOthers` 不含本机。
  for (const tier of LICENSE_TIERS) {
    const max = TIER_LIMITS[tier].maxNodes;
    ok(nodeQuotaReached(tier, max - 2) === false && nodeQuotaReached(tier, max - 1) === false,
      `Z-1c ${TIER_LABEL[tier]}：还有空位时不拦（others=${max - 1} ⇒ 含本机恰 ${max} 台）`);
    ok(nodeQuotaReached(tier, max) === true,
      `Z-1d ${TIER_LABEL[tier]}：再进一台就超（others=${max} ⇒ 含本机 ${max + 1} 台）`);
  }

  const l = ledger(['self', 'peer-1', 'peer-2'], 'self');
  eq(countOtherNodes(l), 2, 'Z-1e 计数**排除本机**（派活/入网都以他机为准，不把自己数成两个）');
  eq(countOtherNodes(ledger([], 'self')), 0, 'Z-1f 空台账 ⇒ 0 台（正面值，不以"不抛"代替）');
}

function groupZ2(): void {
  console.log('\n【Z-2】台账读数与 fail-open');
  const team = 'team' as const;
  const max = TIER_LIMITS[team].maxNodes;

  const roomy = nodeQuotaCheck(team, ledger(['self', 'peer-1'], 'self'));
  ok(roomy.refusal === null && roomy.note === undefined,
    'Z-2a 未满 ⇒ 放行且无附注（不制造噪音）');

  const full = nodeQuotaCheck(team, ledger(Array.from({ length: max }, (_, i) => `peer-${i}`), 'self'));
  ok(full.refusal !== null, 'Z-2b 满员 ⇒ 拦下');
  ok(full.refusal !== null && full.refusal.includes(`已注册 ${max} 台`) && full.refusal.includes(`上限 ${max} 台`),
    'Z-2c 拒因带真实数与上限（人话可核对，不是"已满"两字）', full.refusal ?? '');
  ok(full.refusal !== null && full.refusal.includes(TIER_LABEL[team]),
    'Z-2d 拒因点名当前档位（用户知道该升哪一档）');

  const broken = nodeQuotaCheck(team, ledger([], 'self', 'ANS 不可达'));
  ok(broken.refusal === null, 'Z-2e 台账读不到 ⇒ **不拦**（fail-open：不通网不把人锁在门外）');
  ok(typeof broken.note === 'string' && broken.note.includes('未校验'),
    'Z-2f 但如实注明「本次未校验」（不把没读到悄悄当成没满）', broken.note ?? '');
}

function groupZ3(): void {
  console.log('\n【Z-3】派生面：能力行 / 升级差异 / 用量回话同出一把尺');
  for (const tier of LICENSE_TIERS) {
    const line = capabilityLine(tier);
    ok(line.includes('协同节点') && !line.includes('席位'),
      `Z-3a ${TIER_LABEL[tier]} 能力行卖**协同节点**、不再卖席位`, line);
    const max = TIER_LIMITS[tier].maxNodes;
    ok(line.includes(max === 0 ? '不限节点' : `协同节点 ${max} 台`),
      `Z-3b ${TIER_LABEL[tier]} 能力行的节点数由 \`TIER_LIMITS\` 派生（与执行上限同值）`, line);
  }

  const proToTeam = upgradeDifferences('pro', 'team');
  const nodesText = TIER_LIMITS.team.maxNodes === 0 ? '不限协同节点' : `${TIER_LIMITS.team.maxNodes} 台协同节点`;
  ok(proToTeam.quotas.includes(nodesText),
    'Z-3c 升级差异列出的节点上限与 `TIER_LIMITS` 同值（不另写卖点）', proToTeam.quotas.join('、'));
  ok(proToTeam.quotas.every((q) => !q.includes('席位')),
    'Z-3d 升级收益不再列席位（席位只数本机账号，不是跨机收益）');

  // 无库 ⇒ seats 0、上限取 community；只验「回话名称与数字同把尺」。
  const counts = tierUsageCounts(null, { now: new Date('2026-10-23T02:00:00.000Z') });
  const ctx = usageContextLine(counts);
  ok(ctx.includes(`本机账号 ${counts.seats.used}/${counts.seats.limit}`),
    'Z-3e 用量回话称「本机账号」并带真实用量（与界面同一措辞）', ctx);
  ok(!ctx.includes('席位'), 'Z-3f 用量回话不再出现「席位」（避免被读成跨机容量）');
}

function groupZ4(): void {
  console.log('\n【Z-4】对照表与价目表同源');
  const rows = tierCatalog().tiers;
  eq(rows.map((r) => r.tier), [...LICENSE_TIERS], 'Z-4a 对照表逐档齐（键集取 `LICENSE_TIERS`）');
  for (const r of rows) {
    eq(r.maxNodes, TIER_LIMITS[r.tier].maxNodes,
      `Z-4b ${TIER_LABEL[r.tier]} 对照表 maxNodes === TIER_LIMITS（不另抄）`);
    eq(r.capability, capabilityLine(r.tier),
      `Z-4c ${TIER_LABEL[r.tier]} 对照表能力行 === capabilityLine（价格表的话＝执行面的尺）`);
  }
}

function groupZ5(): void {
  console.log('\n【Z-5】接线：`nodes:enroll` 先过 Team 闸 → 查节点数 → 再注册');
  const ipc = stripped(`${A}/src/main/ipc/nodes.ipc.ts`);
  const start = ipc.indexOf("ipcMain.handle('nodes:enroll'");
  const end = ipc.indexOf('ipcMain.handle(', start + 10);
  ok(start >= 0 && end > start, 'Z-5a 找到 `nodes:enroll` 处理器');
  const body = start >= 0 && end > start ? ipc.slice(start, end) : '';
  const teamAt = body.indexOf('teamFeatureRefusal(');
  const quotaAt = body.indexOf('nodeQuotaCheck(');
  const enrollAt = body.indexOf('enrollWithToken(');
  ok(teamAt >= 0 && quotaAt > teamAt, 'Z-5b 节点数检查在 Team 软闸**之后**（未解锁不触 ANS）');
  ok(quotaAt >= 0 && enrollAt > quotaAt, 'Z-5c ★节点数检查在**注册之前**（先问能不能进，再入网）');
  ok(/if \(!isNodeEnrolled\(settingDb\)\)/.test(body),
    'Z-5d ★只拦**新入网**（已在网的本机重入不受影响——满员不等于把本机锁在外面）');
  ok(/fetchNodes\(db, localNodeId\)/.test(body),
    'Z-5e 用**本次**台账读数（同一次判断不跨时刻复用旧数）');
  ok(body.includes("'NODE_LIMIT'"), 'Z-5f 满员回结构化码 `NODE_LIMIT`（不冒充 INTERNAL）');
  ok(/check\.refusal/.test(body) && /check\.note/.test(body),
    'Z-5g fail-open 与如实附注都接上了（refusal 走错误支，note 随成功回执）');

  const quotaSrc = stripped(`${A}/src/main/core/node-quota.ts`);
  ok(!/from ['"]electron['"]/.test(quotaSrc), 'Z-5h `node-quota` 零 electron 依赖（rr 可直跑、IPC 只作壳）');
  ok(/TIER_LIMITS\s*\[/.test(quotaSrc), 'Z-5i 上限就地取 `TIER_LIMITS`（不另立第二份数字）');
}

function groupZ6(): void {
  console.log('\n【Z-6】设置页上屏');
  const settings = read(`${A}/renderer/src/pages/SettingsPage.tsx`);
  ok(/<UsageBar label="本机账号"/.test(settings),
    'Z-6a 用量条称「本机账号」（不把本机账号写成"成员席位"）');
  ok(/usage\.nodes\.registered\}/.test(settings) && /usage\.nodes\.limit/.test(settings),
    'Z-6b 节点行显示**已注册/上限**（价目表所称的节点上限与界面同尺）');
  ok(/usage\.nodes\.unavailable/.test(settings) && /不可用（/.test(settings),
    'Z-6c 台账读不到仍如实「不可用 + 原因」（不写 0 台）');
}

function groupP(): void {
  console.log('\n【P】build 钉（P1–P6 共用真源）');
  checkBuildPins(ok, { rootDir: root });
}

try {
  groupZ1();
  groupZ2();
  groupZ3();
  groupZ4();
  groupZ5();
  groupZ6();
  groupP();
} catch (e) {
  fail++;
  console.error(`  FAIL 套件异常：${(e as Error)?.stack || String(e)}`);
} finally {
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}
