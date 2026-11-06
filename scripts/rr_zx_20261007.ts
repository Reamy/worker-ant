/**
 * zx_20261007 受控复跑 —— 「知彼」（投放一 · 线一 C1 环境感知全闸）。
 *
 * 本文件按**实施排期**逐批转绿（`RR_STAGE=Mn` 只要求 ≤Mn 的批次为绿，更晚的批次打 ⏳ 不计入失败；
 * `RR_STAGE` 为空 = 全部须绿，收口用）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §M1 判据（批一）——「真 CPU 采样」（毛泽东·反对本本主义：没有调查没有发言权）。
 *   病根（`plans/improve/zx_20261007.md` §1.2(1)）：`load_avg1 = os.loadavg()[0] ?? 0` 在 Windows
 *   **恒 0**（界面永远"空闲"），且 load average 本就 ≠ CPU 利用率。
 *   判据：两次采样**做差**能算出确定利用率；**单次采样（无基线）⇒ `null`**（反证：不许把"不知道"说成 0）；
 *   `win32` 下 `load_avg1` 为 `null`（源形状）。
 *
 * §M2 判据（批二）——「忙闲正名 + 机器余力」（维特根斯坦·意义即用法）。
 *   病根（§1.2(2)）：`busy_ratio` 名像"机器忙闲"，实为"我方派单填充率"。判据：字段更名
 *   `dispatch_fill_ratio`；新增 `capacity_free_ratio` 且 **三源取严**（满槽 ⇒ 即便 CPU/内存有余力，
 *   余力仍为 0——用**取严**而非**取平均**才能过）；三落点（main/renderer/electron.d.ts）**无旧名残留**。
 *
 * §M3 判据（批三）——「陈旧可辨」（老子·知止不殆）。
 *   病根（§1.2(3)）：`collected_at` 只显绝对时刻（"20 分钟前的旧数据"与"刚报的"看着一样）；断网缺口起点
 *   `stale_since` 落库即沉默（ANS 只存不显）。判据：陈旧阈值**由 `NODE_OFFLINE_SEC` 派生**（方向性两侧标本）；
 *   `stale_since` 经 status 往返后展示投影取得到；渲染处**真调** `snapshotAgo`/`isSnapshotStale`；ANS **只** status_json 一处存储。
 *
 * §M4 判据（批四）——「三方对齐」（维特根斯坦·意义即用法）。
 *   病根（§1.2(4)）：新字段沿五落点易"头大脚轻/接口不一致"。判据：假 DB → `collectNodeEnv` → JSON 往返
 *   （= ANS 的 status_json）→ `readNodeEnv` 新字段**值不漂**；且采集产出的**每一个**字段展示投影皆取得到（漏一个即红）；
 *   五落点搬运方式逐个钉住（main 有生产者 / 上报整份送 / renderer 有消费者 / ANS 字段无关透传）。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数、不自造等价实现**：采样/采集一律调生产导出，不照抄一份"等价物"。
 *   G-2 **两侧标本**：单次采样（无基线）与两次采样（有基线）各一测——只测一侧则过宽/过窄变体全票通过。
 *   G-3 **计数器用 0→1 正面断言**，不用"不抛"代替。
 *   G-4 **不依赖真实墙钟**：`now`/`cpus` 注入；不 sleep、不比真实时刻。
 *   G-5 静态判据读**原文**（不去注释——去注释在本仓是静默毁伤）；查旧名残留时**去注释**（注释里解释更名不算残留）。
 *   G-6 **无轮次字面量**（不改 `build`；本文件不得出现前向 build 钉——末尾另有自检）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：判据引用的生产符号**全部静态导入** ⇒ 被删/改名即**编译期失败**（而非"扫了个空、静默假绿"）。
import { createCpuSampler, type CpuInfoLike } from '../apps/worker-ant-desktop/src/main/core/cpu-sampler.js';
import { collectNodeEnv } from '../apps/worker-ant-desktop/src/main/core/node-heartbeat.js';
import { PROJECT_CONCURRENCY_DEFAULT } from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
// M3/M4：陈旧判定与人话换算、以及展示投影——**直跑生产函数**（node-view.ts 无 React 依赖，可直引）。
import { readNodeEnv, isSnapshotStale, snapshotAgo } from '../apps/worker-ant-desktop/renderer/src/lib/node-view.js';
import { NODE_OFFLINE_SEC } from '../packages/shared-types/src/nodes.js';

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
/** 扫源码一律**去注释**（承 zx_20260921_1）：防"注释里写着有、代码里没被用上"。 */
const strip = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

const CPU_SAMPLER_SRC = `${A}/src/main/core/cpu-sampler.ts`;
const NODE_HEARTBEAT_SRC = `${A}/src/main/core/node-heartbeat.ts`;
const NODE_VIEW_TS = `${A}/renderer/src/lib/node-view.ts`;
const PEERS_PAGE = `${A}/renderer/src/pages/PeersPage.tsx`;
const ELECTRON_D_TS = `${A}/renderer/src/types/electron.d.ts`;
const ANS_NODES_TS = 'apps/ans-server/src/routes/nodes.ts';
const ANS_SCHEMA_TS = 'apps/ans-server/src/db/schema.ts';

const ORDER = ['M1', 'M2', 'M3', 'M4'] as const;
type Batch = (typeof ORDER)[number];
const STAGE = (process.env.RR_STAGE || '').trim() as Batch | '';
const required = (b: Batch): boolean => STAGE === '' || ORDER.indexOf(b) <= ORDER.indexOf(STAGE);

let pass = 0; let fail = 0; let pending = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function crit(b: Batch, cond: boolean, label: string, detail?: string): void {
  if (!required(b)) {
    pending++;
    console.log(`  ⏳ [${b}] ${label}${cond ? ' —— **已提前为真**' : ''}`);
    return;
  }
  if (cond) { pass++; console.log(`  ✓ [${b}] ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ [${b}] ${label}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * 夹具：造 `collectNodeEnv` 需要的两张表（逐列照抄 database.ts 的相关列）。
 *   zx_20261022_3 M1：机器**槽位**口径改由 `wa_tasks`（`executing/preparing/planning`）计数——
 *   与执行闸 `machineSlotGuard`/`countMachineRunning` **同一张表**；`wa_jobs` 仍供派单填充率。
 */
function fdb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, type TEXT NOT NULL);
    CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL);
  `);
  return db;
}

/** 造一个 `os.cpus()` 元素形状（单核）。 */
const mkCpu = (user: number, sys: number, idle: number): CpuInfoLike => ({ times: { user, nice: 0, sys, idle, irq: 0 } });

async function main(): Promise<void> {
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M1】批一 · 真 CPU 采样（毛泽东·没有调查，没有发言权）');
  {
    // M1-A 两次采样做差 ⇒ 确定利用率（生产 `createCpuSampler` 直跑真差分，不照抄一份）。
    const readings: CpuInfoLike[][] = [
      [mkCpu(100, 0, 900)],   // busy 100 / total 1000
      [mkCpu(300, 0, 1700)],  // busy 300 / total 2000 ⇒ Δtotal 1000, Δidle 800 ⇒ 20%
    ];
    let i = 0;
    const s = createCpuSampler({ cpus: () => readings[Math.min(i++, readings.length - 1)]!, now: () => Date.UTC(2026, 9, 7, 0, 0, 0) });
    const first = s.sample();
    const second = s.sample();
    crit('M1', first.percent === null,
      `M1-A **单次采样（无基线）⇒ null**（反证：单看一次只能知"开机至今"，不能知"这段时间在不在干活"）。`,
      `first.percent=${first.percent === null ? 'null' : first.percent}`);
    crit('M1', second.percent === 20,
      `M1-A' **两次采样做差 ⇒ 真利用率**：Δbusy 200 / Δtotal 1000 ⇒ 20.0%。`,
      `second.percent=${second.percent}`);

    // M1-B 全零/取不到 ⇒ null（不编一个像真的值）。
    const zero = createCpuSampler({ cpus: () => [], now: () => 0 });
    const z1 = zero.sample(); const z2 = zero.sample();
    crit('M1', z1.percent === null && z2.percent === null,
      `M1-B **无核（total≤0）⇒ null**，两跳皆 null（不拿 0 冒充"空闲"）。`,
      `两次=${z1.percent}/${z2.percent}`);

    // M1-C 采集落点：首采 null、二采真值（注入 sampler 控基线）。
    const db = fdb();
    const injReadings: CpuInfoLike[][] = [[mkCpu(100, 0, 900)], [mkCpu(300, 0, 1700)]];
    let j = 0;
    const sampler = createCpuSampler({ cpus: () => injReadings[Math.min(j++, injReadings.length - 1)]!, now: () => 0 });
    const envA = collectNodeEnv(db, { dataDir: root, cpuSampler: sampler });
    const envB = collectNodeEnv(db, { cpuSampler: sampler });
    crit('M1', envA.cpu_usage_percent === null && envB.cpu_usage_percent === 20,
      `M1-C **采集接上采样器**：\`cpu_usage_percent\` 首采 null、二采 20（同一实例连采两跳）。`,
      `首=${envA.cpu_usage_percent} · 二=${envB.cpu_usage_percent}`);
    db.close();

    // M1-D win32 语义（源形状）：Windows 上 load_avg1 取 null（os.loadavg() 恒 0 是假数）。
    crit('M1', /process\.platform\s*===\s*'win32'\s*\?\s*null\s*:/.test(strip(NODE_HEARTBEAT_SRC)),
      `M1-D **win32 ⇒ load_avg1 为 null**（源形状钉住三元式；"没有这个数"≠"空闲 0.00"）。`);

    // M1-E 采样器有状态 ⇒ 真机须模块级单例（否则每次新建实例都无基线，永远 null）。
    crit('M1', /createCpuSampler\(\)/.test(strip(NODE_HEARTBEAT_SRC)),
      `M1-E \`node-heartbeat.ts\` 持**模块级** \`createCpuSampler()\` 单例（有状态才有基线）。`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M2】批二 · 忙闲正名 + 机器余力（维特根斯坦·意义即用法）');
  {
    const db = fdb();
    const envEmpty = collectNodeEnv(db, { dataDir: root });
    // M2-A 字段更名：新名在场、旧名不在。
    crit('M2', 'dispatch_fill_ratio' in envEmpty && !('busy_ratio' in envEmpty),
      `M2-A **正名**：快照含 \`dispatch_fill_ratio\`、**不含**旧名 \`busy_ratio\`（"我方派单填充率"非"机器忙闲"）。`,
      `新=${'dispatch_fill_ratio' in envEmpty} · 旧=${'busy_ratio' in envEmpty}`);

    // M2-B 派单填充率 0→1 正面断言（两侧标本）。
    crit('M2', envEmpty.jobs_running === 0 && envEmpty.dispatch_fill_ratio === 0,
      `M2-B 空库：jobs_running=0、dispatch_fill_ratio=0。`,
      `running ${envEmpty.jobs_running} · ratio ${envEmpty.dispatch_fill_ratio}`);
    const ins = db.prepare('INSERT INTO wa_jobs (id, status, type) VALUES (?, ?, ?)');
    for (let k = 0; k < PROJECT_CONCURRENCY_DEFAULT; k++) ins.run(`j${k}`, 'running', 'ai-task');
    ins.run('j-done', 'done', 'ai-task');
    const envFull = collectNodeEnv(db, { dataDir: root });
    crit('M2', envFull.jobs_running === PROJECT_CONCURRENCY_DEFAULT && envFull.dispatch_fill_ratio === 1,
      `M2-B' 满并发：jobs_running=${PROJECT_CONCURRENCY_DEFAULT}、dispatch_fill_ratio=1；done 行不计入。`,
      `running ${envFull.jobs_running} · ratio ${envFull.dispatch_fill_ratio}`);

    // M2-C 机器余力 **三源取严**：满槽 ⇒ 即便 CPU/内存有余力，余力仍 0（取严而非取平均）。
    //   zx_20261022_3 M1：槽位占用改由 `wa_tasks` 的真跑状态计数（与执行闸同一把尺），
    //   `cpus` 注入 4 ⇒ machine_limit 由 `deriveMachineConcurrency` 派生为 3（不依赖真机核数）。
    const cpuRead: CpuInfoLike[][] = [[mkCpu(100, 0, 900)], [mkCpu(300, 0, 1700)]]; // CPU 余量 0.8
    let m = 0;
    const sp = createCpuSampler({ cpus: () => cpuRead[Math.min(m++, cpuRead.length - 1)]!, now: () => 0 });
    const db2 = fdb();
    sp.sample(); // 建基线
    const envSpare = collectNodeEnv(db2, { dataDir: root, cpuSampler: sp, cpus: 4 }); // CPU 余量 0.8、槽余量 1
    crit('M2', envSpare.capacity_free_ratio != null && envSpare.capacity_free_ratio > 0 && envSpare.capacity_free_ratio <= 1,
      `M2-C 空闲机：余力已知且 ∈(0,1]（CPU/内存/槽三源皆可知）。`,
      `capacity=${envSpare.capacity_free_ratio} · limit=${envSpare.machine_limit}`);

    // M2-C'' **两把尺不混**：派单作业塞满（`wa_jobs` 满并发）但机器槽位空着 ⇒ 余力仍 > 0。
    //   反证 M1 的病根（原实现拿 `wa_jobs/concurrency_default` 冒充机器槽位）——作业满 ≠ 机器满。
    for (let k = 0; k < PROJECT_CONCURRENCY_DEFAULT; k++) db2.prepare('INSERT INTO wa_jobs (id, status, type) VALUES (?, ?, ?)').run(`k${k}`, 'running', 'ai-task');
    const envJobsFull = collectNodeEnv(db2, { dataDir: root, cpuSampler: sp, cpus: 4 });
    crit('M2', envJobsFull.dispatch_fill_ratio === 1 && envJobsFull.running_tasks === 0 && (envJobsFull.capacity_free_ratio ?? 0) > 0,
      `M2-C'' **派单满 ≠ 机器满**：jobs 满（dispatch=1）而 tasks=0 ⇒ 槽位仍有余力（两把尺各量各的）。`,
      `dispatch=${envJobsFull.dispatch_fill_ratio} · tasks=${envJobsFull.running_tasks} · capacity=${envJobsFull.capacity_free_ratio}`);

    // M2-C' 真占满机器槽位（`executing/preparing/planning` 三态之一）⇒ 余力 0。
    for (let k = 0; k < envJobsFull.machine_limit; k++) db2.prepare('INSERT INTO wa_tasks (id, status) VALUES (?, ?)').run(`t${k}`, 'executing');
    const envNoSlot = collectNodeEnv(db2, { dataDir: root, cpuSampler: sp, cpus: 4 });
    crit('M2', envNoSlot.capacity_free_ratio === 0 && envNoSlot.running_tasks === envNoSlot.machine_limit && envNoSlot.free_slots === 0,
      `M2-C' **取严的判别**：槽余量 0 ⇒ 余力 0（即便 CPU 余量 0.8、内存仍有空）——**取平均**会漏这条。`,
      `capacity=${envNoSlot.capacity_free_ratio} · tasks=${envNoSlot.running_tasks}/${envNoSlot.machine_limit}`);
    db.close(); db2.close();

    // M2-D 三落点无旧名残留（去注释：注释里解释更名不算残留）。
    const hbStripped = strip(NODE_HEARTBEAT_SRC);
    crit('M2', !/\bbusy_ratio\b/.test(hbStripped) && /dispatch_fill_ratio/.test(hbStripped) && /capacity_free_ratio/.test(hbStripped),
      `M2-D \`node-heartbeat.ts\` 去注释后**无旧名**、含两个新字段名。`);
    const viewStripped = strip(NODE_VIEW_TS);
    crit('M2', !/\bbusy_ratio\b/.test(viewStripped) && /dispatch_fill_ratio/.test(viewStripped) && /capacity_free_ratio/.test(viewStripped),
      `M2-D' \`node-view.ts\` 投影：无旧名、含新名（readNodeEnv 五处其一）。`);
    const dts = strip(ELECTRON_D_TS);
    crit('M2', !/\bbusyRatio\b/.test(dts) && /dispatchFillRatio\?/.test(dts),
      `M2-D'' \`electron.d.ts\` 的瞬态事件字段更名：无 \`busyRatio\`、含 \`dispatchFillRatio\`。`);

    // M2-E 展示层函数更名 + 新余力函数（PeersPage 用同一套换算，不自造）。
    //   zx_20261022_3 M1：面板另起「机器槽位」一行（`slotFillView`），与「派单填充」并列而非合并。
    const pageSrc = strip(PEERS_PAGE);
    crit('M2', /dispatchFillView\(env\)/.test(pageSrc) && /slotFillView\(env\)/.test(pageSrc) && /capacityView\(env\)/.test(pageSrc) && !/Bu[sy]+Bar/.test(pageSrc),
      `M2-E \`PeersPage\` 用 \`dispatchFillView\`/\`slotFillView\`/\`capacityView\`（同一套展示换算），旧 \`BusyBar\` 已并入 \`LoadBars\`。`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M3】批三 · 快照陈旧可辨（老子·知止不殆 / 维特根斯坦·别把不知道说成知道）');
  {
    // M3-A 陈旧阈值**由共享真源 NODE_OFFLINE_SEC 派生**（方向性两侧标本，不抄一个 90 做 ===）。
    const nowMs = Date.UTC(2026, 9, 7, 12, 0, 0);
    const ago = (msAgo: number): string => new Date(nowMs - msAgo).toISOString();
    crit('M3', isSnapshotStale(ago((NODE_OFFLINE_SEC + 1) * 1000), nowMs) === true
      && isSnapshotStale(ago((NODE_OFFLINE_SEC - 1) * 1000), nowMs) === false,
      `M3-A **陈旧＝超 \`NODE_OFFLINE_SEC\`(${NODE_OFFLINE_SEC}s) 派生**（与"在线判据"同一把尺）：超 1s 即陈、差 1s 不陈（两侧标本）。`);
    crit('M3', isSnapshotStale(null, nowMs) === false,
      `M3-A' **无时刻不算陈旧**（"不知道"≠"陈"，不许拿 0 冒充"刚报的"）。`);

    // M3-B "距今多久"人话——有值/无值两侧。
    crit('M3', snapshotAgo(ago(3 * 60 * 1000), nowMs) === '3 分钟前' && snapshotAgo(null, nowMs) === '—',
      `M3-B **人话换算两侧**：3 分钟前 → "3 分钟前"；无快照 → "—"（不显示"0 秒前"冒充新鲜）。`);

    // M3-C 载荷里的 `stale_since` 可达：经 status 往返后展示投影取得到（ANS 只存不显的病根在此除）。
    const staleEnv = { ...collectNodeEnv(fdb(), { dataDir: root }), stale_since: '2026-10-07T00:00:00.000Z' };
    const viewStale = readNodeEnv({ status: JSON.parse(JSON.stringify(staleEnv)) as Record<string, unknown> });
    crit('M3', viewStale?.stale_since === '2026-10-07T00:00:00.000Z',
      `M3-C **"这段数据是陈的"取得出**：\`stale_since\` 随 status 走一遭后，展示投影仍取到（此前落库即沉默）。`,
      `view.stale_since=${viewStale?.stale_since ?? 'null'}`);

    // M3-D 渲染旗标**真被用上**（防"算了没用上"）：PeersPage 的渲染处确调 snapshotAgo/isSnapshotStale 并渲染 stale_since。
    const pageSrc = strip(PEERS_PAGE);
    crit('M3', /isSnapshotStale\(env\.collected_at,\s*nowMs\)/.test(pageSrc)
      && /snapshotAgo\(env\.collected_at,\s*nowMs\)/.test(pageSrc)
      && /env\?\.stale_since/.test(pageSrc),
      `M3-D \`PeersPage\` 渲染处**真调** \`snapshotAgo\`/\`isSnapshotStale\` 并渲染 \`stale_since\`（非"建了函数没人用"）。`);

    // M3-E ANS 侧**一处存储**：`stale_since` 只随 status_json 走（toNode 原样透传），schema 无第二个 stale 列。
    crit('M3', /stale_since:\s*state\.staleSince/.test(strip(NODE_HEARTBEAT_SRC))
      && /status:\s*jsonObject\(row\.status_json\)/.test(strip(ANS_NODES_TS))
      && !/stale/.test(strip(ANS_SCHEMA_TS)),
      `M3-E ANS **只存不另存**：源头 \`node-heartbeat\` 把缺口起点捎进 status；\`toNode\` 原样透传；schema **无**第二个 stale 列。`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【M4】批四 · 环境快照三方对齐（维特根斯坦·意义即用法 / 反对头大脚轻）');
  {
    // M4-A **端到端在生产入参形状上跑**：假 DB → collectNodeEnv → JSON 往返（= ANS 的 status_json）→ readNodeEnv。
    const db = fdb();
    const env = collectNodeEnv(db, { dataDir: root });
    const wire = JSON.parse(JSON.stringify(env)) as Record<string, unknown>; // 经 ANS status_json 那一跳
    const view = readNodeEnv({ status: wire });
    crit('M4', view != null && 'cpu_usage_percent' in view && 'dispatch_fill_ratio' in view && 'capacity_free_ratio' in view,
      `M4-A **新字段走完五落点仍在**：\`cpu_usage_percent\`/\`dispatch_fill_ratio\`/\`capacity_free_ratio\` 往返后可取。`);
    crit('M4', view?.cpu_usage_percent === env.cpu_usage_percent && view?.capacity_free_ratio === env.capacity_free_ratio,
      `M4-A' **值不漂**：往返后与采集值逐字一致（序列化不许改名/丢字段）。`,
      `cpu ${env.cpu_usage_percent}→${view?.cpu_usage_percent} · cap ${env.capacity_free_ratio}→${view?.capacity_free_ratio}`);

    // M4-A'' 无"头大脚轻"：采集产出的**每一个**字段，展示投影都取得到（漏一个即红）。
    const missing = Object.keys(env).filter((k) => !(view != null && k in view));
    crit('M4', missing.length === 0,
      `M4-A'' **无头大脚轻**：\`NodeEnvSnapshot\` 的**全部** ${Object.keys(env).length} 个字段皆可在展示投影取到。`,
      missing.length ? `缺：${missing.join(',')}` : '0 处缺失');
    db.close();

    // M4-B 五落点**逐个核对**（源形状钉住各跳的搬运方式，断言按符号不按行号）。
    const NEW_FIELDS = ['cpu_usage_percent', 'dispatch_fill_ratio', 'capacity_free_ratio'];
    const mainSrc = strip(NODE_HEARTBEAT_SRC);
    crit('M4', NEW_FIELDS.every((f) => mainSrc.includes(f)),
      `M4-B① \`node-heartbeat.ts\`（类型+采集+上报一处）三名俱全——新字段**有生产者**。`);
    crit('M4', /body:\s*\{\s*node_id:\s*nodeId,\s*status,\s*card\s*\}/.test(mainSrc),
      `M4-B② 上报**整份 status 原样送**（不是挑几个字段抄）——ANS 侧因此天然收全。`);
    crit('M4', NEW_FIELDS.every((f) => strip(NODE_VIEW_TS).includes(f)),
      `M4-B③ \`node-view.ts\` 展示投影三名俱全——新字段**有消费者**（renderer 是词表第二落点）。`);
    const ansSrc = strip(ANS_NODES_TS);
    crit('M4', /status_json = \?/.test(ansSrc) && /JSON\.stringify\(body\.status\)/.test(ansSrc) && /jsonObject\(row\.status_json\)/.test(ansSrc),
      `M4-B④ ANS **字段无关地透传**（存 \`body.status\`、取 \`status_json\`）——不逐字段抄，故不会漏字段。`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD('scripts/rr_zx_20261007.ts')).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, '本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((p) => p[1]).join(',') || '0 处');
    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

main().catch((e: unknown) => {
  console.error('\n💥 rr_zx_20261007 未捕获异常（复跑**未跑完**，不得读作通过）：', e);
  fail++;
}).finally(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261007: ${pass} 通过 / ${fail} 失败${pending ? ` / ${pending} 待实施(不计入)` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
});
