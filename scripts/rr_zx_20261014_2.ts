/**
 * zx_20261014_2 受控复跑 —— 「在手」：设备控制要落在每个形态的手边（缺陷批）。
 *
 * 承接 `zx_20261014_1`「名」的**实机 E2E 格③**（改名 → 留痕显名 → 让 AI 按名下发）。前两格实测正常；
 * 第三格**功能没通**：任务「打开客厅台灯」被标 `completed`（质量 80 / `goal_achieved:true`），
 * 而 `wa_device_actions` **零行**——灯一动没动。创始人当日裁定：**现在就修（缺陷批，按 B）**；
 * "无产出却标完成"这处**同批治**（含 `conversation` 豁免复核）。
 *
 * 本轮口径一句话（道德经·有之以为利无之以为用 ／ 维特根斯坦·意义即用法 ／
 *   王阳明·知行合一 ／ 毛选·反对本本主义 ／ 罗尔斯·同一把尺）：
 *   ① 设备三件（发现/读态/控制）是**用户嘴里那句"把灯打开"**——它得在每个形态的**手边**，
 *      不能因为"分类器把短祈使句判成了 conversation"就从模型眼前消失；
 *   ② "请求人类介入"是一件事，只准一个咽喉——模型说"暂停等答复"，台账就得**真**置停。
 *
 * 两处病根（方案 §0.2，读码 + 库内实测）：
 *   D1（拦路虎）`ARCHETYPE_TOOL_CATEGORIES.conversation` 不含 `device` ⇒ `availableToolNames` 里
 *      没有设备三件 ⇒ `agent-executor.ts:2140` 的 `delete toolMap[k]` 在 `streamText` **之前**
 *      把它们删掉（模型连 schema 都没收到）。
 *   D2（诚实）`escalate_to_human` 只回 `{status:'escalated'}` **不置停** ⇒ 模型对用户说"暂停等答复"，
 *      台账却因 `no_criteria` 不压分而标 `completed`/80（三本账互相矛盾）。
 *
 * 治法：D1 把 `device` 升**第四类底线**（六档全含）；D2 `escalate_to_human` 接上**唯一咽喉**
 *   `pauseForDecision('escalation', …)`（`no_interaction` 中继任务由咽喉内短路，语义不变）。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：判据一律静态导入生产导出（被删/改名即编译期失败）。
 *   G-2 **两侧标本**：判"收窄仍发生"须同时喂"该留下的（device 三件）"与"该被收窄的（write_file）"。
 *   G-6 **无轮次字面量**：本轮方案路径/脚本名由 `path.basename(__filename)` 派生（末尾 S1/S2/S3 自检）。
 *   G-7 **真调用那一跳**（承 feedback_equivalence_needs_wiring_criterion）：E-1 不读源码，而是把探针
 *       `pauseForDecision` **注入**生产那份 `controlTools`，验"调用真的落到探针上、入参是真的 decisionType"。
 *   ⚠ 判据导 `task-archetype.js`（非抄一份类目表）——抄一份＝自我印证；导入真源＝它一改我就红。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：四处真源**静态导入**（被删/改名即编译期失败，而非"扫个空、静默假绿"）。
import {
  ARCHETYPE_TOOL_CATEGORIES, availableToolNames, narrowToolFace, classifyArchetype,
  type TaskArchetype,
} from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';
import { toolRegistry, type ToolCategory } from '../apps/worker-ant-desktop/src/main/core/tool-registry.js';
import { controlTools } from '../apps/worker-ant-desktop/src/main/core/tools/control.js';
import { noInteractionPauseRefusal } from '../apps/worker-ant-desktop/src/main/core/no-interaction.js';

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** 等值断言（把实际值一并打出——红时立刻看得出差在哪）。 */
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
/** 判"用户可见文案/调用形状"读去注释后的代码；判"接线在册"读原文。 */
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''); // zx_20261014_2

/** 六档（由真源取——加档/改名即自动覆盖；不手抄名单）。 */
const SIX = Object.keys(ARCHETYPE_TOOL_CATEGORIES) as TaskArchetype[];
const cats = (a: TaskArchetype): ToolCategory[] => ARCHETYPE_TOOL_CATEGORIES[a];

/** 设备三件（按名使唤那一族——"把灯打开"落地要靠它）。 */
const DEVICE_TOOLS = ['list_devices', 'device_status', 'device_control'] as const;

/** 极简内存库：只备 `wa_tasks`（E 组 `ask_user` 要读 `context_json`；`escalate` 不读库）。 */
function mkdb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, context_json TEXT);');
  return d;
}

async function main(): Promise<void> {
  // ═══ T｜在手（批一：设备三件升底线——短祈使句也够得着）══════════════════════════════
  console.log('\n【T】在手 —— 设备三件落在每个形态的手边（毛选·反对本本主义 / 罗尔斯·同一把尺）');
  {
    // ── T-1 ★★六档**逐档**含 `device`（由构造派生枚举，非点名几档）────────────────────
    const missing = SIX.filter((a) => !cats(a).includes('device'));
    ok(SIX.length === 6 && missing.length === 0,
      'T-1 ★★六档逐档全含 `\'device\'`（`device` 升第四类底线：短祈使句落任一档都够得着设备三件）',
      missing.length ? `缺档：${missing.join(' · ')}` : `六档齐备（${SIX.join(' · ')}）`);
    ok(cats('conversation').includes('device') && ARCHETYPE_TOOL_CATEGORIES.conversation.length === 4,
      'T-1b ★病根档 `conversation` 恰四类底线 `readonly`/`control`/`resource`/`device`（全档最窄但够得着设备）',
      cats('conversation').join(' · '));

    // ── T-2 ★派生落地：六档 `availableToolNames` 逐档含设备三件（类目 ⇒ 工具名的派生那一跳）──
    const lack: string[] = [];
    for (const a of SIX) {
      const names = availableToolNames(a);
      for (const t of DEVICE_TOOLS) if (!names.includes(t)) lack.push(`${a}:${t}`);
    }
    ok(lack.length === 0,
      'T-2 ★派生落地：六档 `availableToolNames(a)` 逐档含 `device_control`/`device_status`/`list_devices`',
      lack.length ? `缺：${lack.join(' · ')}` : '六档 × 三件 皆在');

    // ── T-3 ★★反证另一侧：收窄**仍发生**（底线放宽 ≠ 收窄失效）────────────────────────
    //   喂"在册全部工具"（含 write/shell/media 各面），`conversation` 仍须把 write 面收在档外。
    const allTools: Record<string, unknown> = {};
    for (const n of toolRegistry.listNames()) allTools[n] = {};
    const face = narrowToolFace('conversation', allTools);
    ok(face.kept.length < Object.keys(allTools).length && face.removed.includes('write_file'),
      'T-3 ★★反证：`narrowToolFace(\'conversation\', 在册全部)` 的 `removed` **非空且含 `write_file`**'
        + '（放宽 `device` 不等于不再收窄——write/shell/media 仍在该档之外）',
      `收窄 ${face.removed.length}/${Object.keys(allTools).length} 件`);
    ok(face.kept.includes('device_control') && face.kept.includes('read_file'),
      'T-3b 同一份入参里，该**留**的确实留下：设备三件与 `read_file` 皆在 `kept`（两侧标本齐）',
      `${face.kept.length} 件保留`);

    // ── T-4 ★病根钉进判据：实机照出的那条路，今天走得通 ──────────────────────────────
    const arch = classifyArchetype('打开客厅台灯');
    ok(arch === 'conversation',
      'T-4a ★病根仍在：`classifyArchetype(\'打开客厅台灯\')` === `\'conversation\'`（短祈使句走长度兜底——这是实机真实落到的那条路）',
      arch);
    ok(availableToolNames(arch).includes('device_control') && availableToolNames(arch).includes('list_devices'),
      'T-4b ★★同一条路上，该档可用集**含** `device_control` 与 `list_devices`（实机那句"把灯打开"今天够得着工具）',
      `本档 ${availableToolNames(arch).length} 件`);
  }

  // ═══ E｜知行合一（批二：`escalate_to_human` 接上唯一咽喉）═══════════════════════════
  console.log('\n【E】知行合一 —— 请求人类介入是一件事，只准一个咽喉（王阳明·知行合一）');
  {
    const db = mkdb();
    const calls: Array<{ decisionType: string; question: string; options: string[] | null; context: Record<string, unknown> }> = [];
    // G-7：探针 = 生产闭包的那份 `pauseForDecision` 的替身。工具真调它 ⇒ `calls` 记下**真入参**。
    const probe = (decisionType: string, question: string, options: string[] | null, context: Record<string, unknown>) => {
      calls.push({ decisionType, question, options, context });
      return JSON.stringify({ status: 'paused', decision_type: decisionType, question });
    };
    const tools = controlTools({
      db, taskId: 'task-escalate', projectId: 'proj-1', workingDir: root,
      pauseForDecision: probe as never,
      logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never,
    } as never) as unknown as {
      escalate_to_human: { execute: (a: { issue: string; options?: string }) => Promise<string> };
      ask_user: { execute: (a: { question: string; options?: string }) => Promise<string> };
    };

    // ── E-1 ★★真调用那一跳：`escalate_to_human` ⇒ 咽喉被调 且入参 `decisionType==='escalation'` ──
    const raw = await tools.escalate_to_human.execute({ issue: '灯控工具不可用', options: '重试, 放弃' });
    eq(calls.length, 1, 'E-1a ★`escalate_to_human` 真调了**唯一咽喉**（探针恰被调 1 次——不再只回 JSON 就完事）');
    eq(calls[0]?.decisionType, 'escalation', 'E-1b ★★入参 `decisionType` === `\'escalation\'`（与 `ask_user`/`path_approval` 同族 snake_case）');
    eq(calls[0]?.question, '灯控工具不可用', 'E-1c 问题原样透传给咽喉（用户看到的是真问题，非空占位）');
    eq(calls[0]?.options, ['重试', '放弃'], 'E-1d options 逗号串**解析为数组**下传（trim 后逐项）');
    eq(JSON.parse(raw).status, 'paused', 'E-1e 工具把咽喉的返回**原样**交给模型（模型据此如实说"已置停等答复"）');
    // 反证：咽喉换一份 ⇒ 结果随之变（确系钉住那一跳，非顺带为真）。
    calls.length = 0;
    eq(await tools.escalate_to_human.execute({ issue: 'x' }), JSON.stringify({ status: 'paused', decision_type: 'escalation', question: 'x' }),
      'E-1f ★反证：返回确由咽喉产出（换探针即换结果）；无 options ⇒ `null`');
    eq(calls[0]?.options, null, 'E-1g 未给 options ⇒ 传 `null`（不臆造空数组）');

    // ── E-2 反证：`ask_user` 仍走同一咽喉（同族未改坏）───────────────────────────────
    calls.length = 0;
    await tools.ask_user.execute({ question: '要不要开灯？' });
    eq(calls.length, 1, 'E-2a 反证：`ask_user` 仍经同一咽喉（恰被调 1 次）');
    eq(calls[0]?.decisionType, 'ask_user', 'E-2b 无 header ⇒ decisionType 缺省 `\'ask_user\'`（原语义未动）');

    // ── E-3 ★反证：`no_interaction` 中继任务**短路**（中继任务仍不许等——M11 语义不变）────────
    const noIntCtx = JSON.stringify({ no_interaction: true });
    const refusal = noInteractionPauseRefusal(noIntCtx, 'escalation');
    ok(refusal !== null && JSON.parse(refusal).status === 'cannot_pause' && JSON.parse(refusal).decision_type === 'escalation',
      'E-3a ★`no_interaction` 任务：咽喉对 `\'escalation\'` 亦**短路**（回 `cannot_pause`，不置停）',
      refusal ?? 'null');
    eq(noInteractionPauseRefusal(JSON.stringify({}), 'escalation'), null,
      'E-3b ★反证另一侧：普通任务（无 `no_interaction`）⇒ 不短路（照常可置停——抑制只在确知时生效）');
    eq(noInteractionPauseRefusal('not-json', 'escalation'), null,
      'E-3c 坏 JSON ⇒ 视同可交互（读不到 ≠ 不可交互，不误伤普通任务）');
  }

  // ═══ S｜哑雷自检 + build 钉（派生核对，不写轮次字面量）════════════════════════════
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

// ⚠ `catch` 不可省：夹具/断言抛异常时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261014_2: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261014_2 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ rr_zx_20261014_2: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
