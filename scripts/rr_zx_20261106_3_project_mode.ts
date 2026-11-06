/**
 * zx_20261106_3「协」B3 受控回归 —— 项目级派发模式：谁能进能力模式、谁永远进不去、写口不抹兄弟键。
 *
 * A 词表与归一：四态 + `auto` 旧别名归一为 `overflow`；脏值一律 `off`。
 * B 生效条件（每格两只标本）：单机/专业版/社区版/未入网/无在线对端 ⇒ **永不** capability；
 *   Team + 已入网 + 在线他机 ≥1 + 分工登记 ⇒ 默认 capability；显式 off/overflow 优先于默认。
 * C 写口：真 SQLite 上验证只动 `$.dispatch_mode`，附件/目标等兄弟键原地保留；清空只删该键。
 * D 接线：main 读写口与 renderer 同引同一组 IPC 名（只建文件不接不算完成）。
 *
 * 纪律：零网络 / 零 electron / 零时钟；断言只做方向性与符号比较。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  PROJECT_DISPATCH_MODE_LABEL,
  PROJECT_DISPATCH_MODES,
  PROJECT_DISPATCH_MODE_KEY,
  isProjectDispatchMode,
  readProjectDispatchModeRaw,
  resolveProjectDispatchMode,
  writeProjectDispatchMode,
  type ProjectDispatchWriteDb,
} from '../apps/worker-ant-desktop/src/main/core/project-dispatch-mode.js';
import { ORCHESTRATE_MODES, normalizeOrchestrateMode } from '../apps/worker-ant-desktop/src/main/core/node-orchestrate.js';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const root = path.join(__dirname, '..');
const CODE = (rel: string) => stripKeepingLines(fs.readFileSync(path.join(root, rel), 'utf-8')).join('\n');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

/** 全条件具备的基线（各用例只改一格——单变量标本才判得出是哪一格起作用）。 */
const base = {
  projectMode: undefined as unknown,
  globalMode: 'overflow' as const,
  tier: 'team' as const,
  enrolled: true,
  onlinePeers: 1,
  hasDivision: true,
};

function sectionA(): void {
  console.log('\n【A】词表与归一');
  eq([...PROJECT_DISPATCH_MODES], ['off', 'auto', 'overflow', 'capability'], 'A-1 项目派发模式词表四态（auto 为旧库别名）');
  eq(
    [
      isProjectDispatchMode('off'), isProjectDispatchMode('auto'), isProjectDispatchMode('overflow'),
      isProjectDispatchMode('capability'), isProjectDispatchMode('on'), isProjectDispatchMode(1),
    ],
    [true, true, true, true, false, false],
    'A-2 仅四态为真（脏值一律不认）',
  );
  eq(
    [
      normalizeOrchestrateMode('auto'), normalizeOrchestrateMode('overflow'),
      normalizeOrchestrateMode('capability'), normalizeOrchestrateMode('off'), normalizeOrchestrateMode('bogus'),
    ],
    ['overflow', 'overflow', 'capability', 'off', 'off'],
    'A-3 归一：auto≡overflow；脏值回落 off（不惊扰既有行为）',
  );
  ok(
    ORCHESTRATE_MODES.filter((m) => m !== 'auto')
      .every((m) => typeof (PROJECT_DISPATCH_MODE_LABEL as Record<string, string>)[m] === 'string'),
    'A-4 每个可选项都有上屏词（加一格即此处提醒）',
  );
  ok(PROJECT_DISPATCH_MODES.every((m) => (PROJECT_DISPATCH_MODE_LABEL[m] ?? '').length > 0), 'A-5 每格都有人话名');
  eq(PROJECT_DISPATCH_MODE_KEY, 'dispatch_mode', 'A-6 键名一处真源（读写同引）');
}

function sectionB(): void {
  console.log('\n【B】生效条件：谁能进能力模式');
  // 正向标本：Team + 已入网 + 有在线他机 + 有分工登记 ⇒ 默认能力优先。
  const teamDefault = resolveProjectDispatchMode(base);
  eq(teamDefault.mode, 'capability', 'B-1 Team+已入网+两机+分工 ⇒ 默认 capability');
  ok(teamDefault.reason.includes('分工'), 'B-2 理由说明"因分工而默认"', teamDefault.reason);

  // 反面标本逐格：任一前置缺 ⇒ 永不 capability。
  const pro = resolveProjectDispatchMode({ ...base, tier: 'pro', projectMode: 'capability' });
  ok(pro.mode !== 'capability', 'B-3 专业版即使显式 capability 也不进', pro.mode);
  ok(pro.reason.includes('团队版'), 'B-4 理由说明缺档位', pro.reason);

  const community = resolveProjectDispatchMode({ ...base, tier: 'community' });
  ok(community.mode !== 'capability', 'B-5 社区版永不 capability', community.mode);

  const notEnrolled = resolveProjectDispatchMode({ ...base, enrolled: false, projectMode: 'capability' });
  ok(notEnrolled.mode !== 'capability', 'B-6 未入网永不 capability', notEnrolled.mode);
  ok(notEnrolled.reason.includes('入网') || notEnrolled.reason.includes('ANS'), 'B-7 理由说明未入网', notEnrolled.reason);

  const noPeer = resolveProjectDispatchMode({ ...base, onlinePeers: 0 });
  ok(noPeer.mode !== 'capability', 'B-8 无在线他机永不 capability', noPeer.mode);
  ok(noPeer.reason.includes('在线'), 'B-9 理由说明没有在线对端', noPeer.reason);

  const noDivision = resolveProjectDispatchMode({ ...base, hasDivision: false });
  ok(noDivision.mode !== 'capability', 'B-10 未登记分工不自动升级为 capability', noDivision.mode);
  ok(noDivision.reason.includes('尚未登记分工'), 'B-11 理由如实说未登记', noDivision.reason);

  // 显式优先：用户说停就停；显式溢出不默认升级。
  const explicitOff = resolveProjectDispatchMode({ ...base, projectMode: 'off' });
  eq(explicitOff.mode, 'off', 'B-12 显式 off 压过一切默认（含分工）');
  const explicitOverflow = resolveProjectDispatchMode({ ...base, projectMode: 'overflow' });
  eq(explicitOverflow.mode, 'overflow', 'B-13 显式 overflow 不被默认升级成 capability');
  const explicitAuto = resolveProjectDispatchMode({ ...base, projectMode: 'auto' });
  eq(explicitAuto.mode, 'overflow', 'B-14 旧值 auto 归一为 overflow');
  const explicitCapability = resolveProjectDispatchMode({ ...base, projectMode: 'capability', hasDivision: false });
  eq(explicitCapability.mode, 'capability', 'B-15 显式 capability 且前置具备 ⇒ 生效');

  // 全局总闸：未显式时全局 off 仍然算数。
  const globalOff = resolveProjectDispatchMode({ ...base, globalMode: 'off', projectMode: undefined });
  eq(globalOff.mode, 'off', 'B-16 全局 off 是无显式时的总闸');

  // 显式 capability 但前置不满足：退回全局偏好，不硬派也不静默关。
  const fallback = resolveProjectDispatchMode({ ...base, tier: 'pro', projectMode: 'capability', globalMode: 'overflow' });
  eq(fallback.mode, 'overflow', 'B-17 显式 capability 前置不满足 ⇒ 退回全局偏好');
  ok(fallback.reason.includes('暂不生效'), 'B-18 退回理由如实上屏', fallback.reason);
}

function sectionC(): void {
  console.log('\n【C】写口：只动一个键，兄弟键原地保留（真 SQLite）');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE wa_projects (id TEXT PRIMARY KEY, context_json TEXT DEFAULT '{}', updated_at TEXT DEFAULT (datetime('now')))`);
  const siblings = { attachments: [{ name: 'a.txt' }], goal: { text: '目标' }, plan: { steps: 3 } };
  db.prepare('INSERT INTO wa_projects (id, context_json) VALUES (?, ?)').run('p1', JSON.stringify(siblings));
  const readCtx = (): Record<string, unknown> =>
    JSON.parse((db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get('p1') as { context_json: string }).context_json) as Record<string, unknown>;

  const wrote = writeProjectDispatchMode(db as unknown as ProjectDispatchWriteDb, 'p1', 'capability');
  ok(wrote, 'C-1 命中项目行返回 true');
  const afterSet = readCtx();
  eq(afterSet['dispatch_mode'], 'capability', 'C-2 dispatch_mode 已写入');
  eq(afterSet['attachments'], siblings.attachments, 'C-3 附件兄弟键原地保留（反证裸覆写）');
  eq(afterSet['goal'], siblings.goal, 'C-4 目标兄弟键原地保留');
  eq(afterSet['plan'], siblings.plan, 'C-5 方案兄弟键原地保留');

  writeProjectDispatchMode(db as unknown as ProjectDispatchWriteDb, 'p1', 'overflow');
  eq(readCtx()['dispatch_mode'], 'overflow', 'C-6 再写覆盖旧值');

  const cleared = writeProjectDispatchMode(db as unknown as ProjectDispatchWriteDb, 'p1', null);
  ok(cleared, 'C-7 清空命中项目行返回 true');
  const afterClear = readCtx();
  ok(!('dispatch_mode' in afterClear), 'C-8 清空只删该键');
  eq(afterClear['attachments'], siblings.attachments, 'C-9 清空后兄弟键仍在');

  const missing = writeProjectDispatchMode(db as unknown as ProjectDispatchWriteDb, 'nope', 'capability');
  ok(!missing, 'C-10 项目不存在返回 false（不谎称已保存）');
  eq((db.prepare('SELECT COUNT(*) AS n FROM wa_projects').get() as { n: number }).n, 1, 'C-11 不凭空造行');

  eq(readProjectDispatchModeRaw(null), undefined, 'C-12 读：空上下文 ⇒ undefined');
  eq(readProjectDispatchModeRaw('not json'), undefined, 'C-13 读：坏 JSON ⇒ undefined（不抛）');
  eq(readProjectDispatchModeRaw(JSON.stringify({ dispatch_mode: 'capability' })), 'capability', 'C-14 读：合法值原样返回');
}

function sectionD(): void {
  console.log('\n【D】接线：main 读写口与 renderer 同引');
  const main = CODE('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
  ok(main.includes("'project:dispatch_mode_get'"), 'D-1 main 注册读口');
  ok(main.includes("'project:dispatch_mode_set'"), 'D-2 main 注册写口');
  ok(main.includes('writeProjectDispatchMode('), 'D-3 写口走合并写口真源（不内联 SQL）');
  ok(main.includes('readProjectDispatchModeRaw('), 'D-4 读口走同一真源');
  // 只钉本批新增的那一段（文件他处有历史裸写口，不在本轮改动面；把它们算进来判据就不成立）。
  const seg = main.slice(main.indexOf("'project:dispatch_mode_get'"), main.indexOf("'task:list'"));
  ok(seg.length > 0, 'D-5 能切出派发模式处理段');
  ok(!/SET\s+context_json\s*=\s*\?/i.test(seg), 'D-6 派发模式段无裸对象覆写（只走合并写口）');
  const orch = CODE('apps/worker-ant-desktop/src/main/core/orchestrator.ts');
  ok(orch.includes('readProjectDispatchModeRaw('), 'D-7 编排器与界面读同一真源');
  ok(orch.includes('resolveProjectDispatchMode('), 'D-8 编排器真用解析器（不是另写一份判据）');
  const renderer = CODE('apps/worker-ant-desktop/renderer/src/lib/ipc.ts');
  ok(renderer.includes("'project:dispatch_mode_get'"), 'D-9 renderer 调同一读口');
  ok(renderer.includes("'project:dispatch_mode_set'"), 'D-10 renderer 调同一写口');
  const card = CODE('apps/worker-ant-desktop/renderer/src/components/NodeDivisionCard.tsx');
  ok(card.includes('projects.dispatchMode.get(') && card.includes('projects.dispatchMode.set('),
    'D-11 分工卡真接上派发模式读写');
  ok(card.includes('resolved.reason'), 'D-12 界面把生效理由说给用户');
}

function sectionE(): void {
  console.log('\n【E】静态钉：build 真源 / 方案与脚本在册');
  checkBuildPins(ok);
}

sectionA();
sectionB();
sectionC();
sectionD();
sectionE();

console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
