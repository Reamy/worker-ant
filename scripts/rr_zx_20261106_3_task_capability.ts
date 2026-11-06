/**
 * zx_20261106_3「协」B1 受控回归 —— 任务能力需求派生 / 整块校验 / 合并写口 / 拆解接入。
 *
 * A 规则派生：编码/调研/文档/对话四形态各一只；判不出 ⇒ 空类目（不得外派的诚实表达）。
 * B 洗值：合法需求往返；类目/意图/设备品类/置信度/来源任一非法 ⇒ 整块 null（不挑着用）。
 * C 模型能力词：三面混合合法；任一词非法 ⇒ 整块 null；空数组不算声明。
 * D 拆解解析：合法 capabilities 保留；含非法词整块丢弃；缺字段不造声明。
 * E 拆解落库：子任务 context_json 带 dispatch_requirements（声明路/规则路各一），兄弟键不丢。
 * F 写口：只 json_set 一个键——附件/目标/方案等兄弟键原地保留（反证裸覆写）。
 * G 静态钉：checkBuildPins（P1–P5）+ 本轮方案在册。
 *
 * 纪律：零网络 / 零 electron；夹具按生产列形自建 DDL；断言文案不含失败/通过字形。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  DISPATCH_REQUIREMENTS_KEY,
  deriveTaskRequirements,
  requirementsForTask,
  requirementsFromCapabilityWords,
  sanitizeDispatchRequirements,
  writeDispatchRequirements,
} from '../apps/worker-ant-desktop/src/main/core/task-capability.js';
import { publicIntents } from '../apps/worker-ant-desktop/src/main/core/intent-protocol.js';
import { parseDecomposition, planSubtasksFromTemplate } from '../apps/worker-ant-desktop/src/main/core/task-decompose.js';
import { checkBuildPins } from './lib/rr-pins.js';

const ROOT = path.join(__dirname, '..');
/** 由文件名取轮次前缀（本套件带 `_task_capability` 后缀，仍须落到 `zx_YYYYMMDD_N`）。 */
const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

const SCHEMA = `
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', title TEXT DEFAULT '', description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
  source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
`;
const mkdb = (): DatabaseSync => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d; };
const ctxOf = (d: DatabaseSync, id: string): Record<string, unknown> => {
  const row = d.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string };
  return JSON.parse(row.context_json) as Record<string, unknown>;
};

const INTENT_ID = publicIntents()[0]!.id;

function sectionA(): void {
  console.log('\n【A】规则派生：形态 → 类目，判不出不猜');
  const code = deriveTaskRequirements({ title: '修复登录 bug', description: '改 auth 模块' });
  eq([code.categories, code.source, code.confidence], [['code'], 'rule', 0.6], 'A-1 编码形态 ⇒ code');
  const research = deriveTaskRequirements({ title: '调研竞品定价策略' });
  eq(research.categories, ['research'], 'A-2 调研形态 ⇒ research');
  const doc = deriveTaskRequirements({ title: '撰写一份技术文档' });
  eq(doc.categories, ['text'], 'A-3 文档形态 ⇒ text');
  const conv = deriveTaskRequirements({ title: '你好' });
  eq([conv.categories, conv.confidence], [[], 0.2], 'A-4 对话/判不出 ⇒ 空类目 + 低置信（不猜）');
  const empty = deriveTaskRequirements({ title: '', description: '' });
  eq([empty.categories, empty.confidence], [[], 0], 'A-5 全空 ⇒ 零置信');
  const pinned = deriveTaskRequirements({ title: '随便什么标题', archetype: 'code' });
  eq([pinned.categories, pinned.source], [['code'], 'rule'], 'A-6 已判形态优先，不重判文字');
}

function sectionB(): void {
  console.log('\n【B】洗值：任一非法即整块作废');
  const good = { categories: ['code', 'text', 'code'], intents: [INTENT_ID], deviceClasses: ['light', 'light'], confidence: 0.8, source: 'decompose' };
  const r = sanitizeDispatchRequirements(good);
  eq([r?.categories, r?.intents, r?.deviceClasses, r?.confidence, r?.source],
    [['code', 'text'], [INTENT_ID], ['light'], 0.8, 'decompose'], 'B-1 合法往返并去重');
  ok(sanitizeDispatchRequirements({ ...good, categories: ['nope'] }) === null, 'B-2 非法类目 ⇒ null');
  ok(sanitizeDispatchRequirements({ ...good, intents: ['no_such_intent'] }) === null, 'B-3 非法意图 ⇒ null');
  ok(sanitizeDispatchRequirements({ ...good, deviceClasses: ['unknown'] }) === null, 'B-4 unknown 品类 ⇒ null');
  ok(sanitizeDispatchRequirements({ ...good, deviceClasses: ['teapot'] }) === null, 'B-5 非法品类 ⇒ null');
  ok(sanitizeDispatchRequirements({ ...good, confidence: 1.5 }) === null, 'B-6 置信度越界 ⇒ null');
  ok(sanitizeDispatchRequirements({ ...good, source: 'user' }) === null, 'B-7 非法来源 ⇒ null');
  ok(sanitizeDispatchRequirements([good]) === null && sanitizeDispatchRequirements(null) === null, 'B-8 非对象 ⇒ null');
}

function sectionC(): void {
  console.log('\n【C】模型能力词：三面混合与整块回退');
  const mixed = requirementsFromCapabilityWords(['code', INTENT_ID, 'light']);
  eq([mixed?.categories, mixed?.intents, mixed?.deviceClasses, mixed?.source],
    [['code'], [INTENT_ID], ['light'], 'decompose'], 'C-1 类目+意图+品类混合合法');
  ok(requirementsFromCapabilityWords(['code', 'teapot']) === null, 'C-2 混入非法词 ⇒ 整块 null');
  ok(requirementsFromCapabilityWords('code') === null && requirementsFromCapabilityWords([1]) === null, 'C-3 非字符串数组 ⇒ null');
  const empty = requirementsFromCapabilityWords([]);
  eq([empty?.categories, empty?.intents, empty?.deviceClasses], [[], [], []], 'C-4 空数组是合法空需求（由调用方决定是否当声明）');
}

function sectionD(): void {
  console.log('\n【D】拆解解析：能力词整块校验');
  const make = (caps: unknown) => JSON.stringify([
    { title: '准备契约', description: '写接口定义', acceptance_criteria: '接口文件存在', purpose: '定契约', capabilities: caps },
    { title: '实现功能', description: '写实现', acceptance_criteria: '测试通过', purpose: '交付功能' },
  ]);
  const kept = parseDecomposition(make(['code']), '原始任务');
  eq(kept[0]?.capabilities, ['code'], 'D-1 合法能力词保留');
  const dropped = parseDecomposition(make(['code', 'teapot']), '原始任务');
  ok(dropped[0] && dropped[0].capabilities === undefined, 'D-2 含非法词整块丢弃（不挑着用）');
  const absent = parseDecomposition(make(undefined), '原始任务');
  ok(absent[0] && absent[0].capabilities === undefined, 'D-3 缺字段不造声明');
  const emptyArr = parseDecomposition(make([]), '原始任务');
  ok(emptyArr[0] && emptyArr[0].capabilities === undefined, 'D-4 空数组不算声明');
}

function sectionE(): void {
  console.log('\n【E】拆解落库：需求随子任务走，兄弟键不丢');
  const d = mkdb();
  d.prepare("INSERT INTO wa_tasks (id, project_id, title, description, status, context_json) VALUES ('p','p1','父任务','父描述','running','{}')").run();
  const r = planSubtasksFromTemplate(d as never, {
    parentTaskId: 'p', projectId: 'p1', depth: 0, source: 'auto-decompose',
    contextExtra: { channel: 'wechat', externalUser: 'u1' },
    template: [
      { title: '准备契约', description: '写接口定义', acceptance_criteria: '接口文件存在', purpose: '定契约', capabilities: ['code'] },
      { title: '撰写说明', description: '写说明文档', acceptance_criteria: '文档存在', purpose: '交付文档' },
    ],
  });
  ok(r.created === 2, 'E-1 两条子任务落库', String(r.created));
  const a = ctxOf(d, r.childIds[0]!);
  const b = ctxOf(d, r.childIds[1]!);
  eq([(a[DISPATCH_REQUIREMENTS_KEY] as { source?: string })?.source, (a[DISPATCH_REQUIREMENTS_KEY] as { categories?: string[] })?.categories],
    ['decompose', ['code']], 'E-2 声明路：source=decompose + 声明类目');
  eq([(b[DISPATCH_REQUIREMENTS_KEY] as { source?: string })?.source, (b[DISPATCH_REQUIREMENTS_KEY] as { categories?: string[] })?.categories],
    ['rule', ['text']], 'E-3 未声明路：回退规则派生');
  eq([a.channel, a.externalUser], ['wechat', 'u1'], 'E-4 contextExtra 兄弟键同在');
}

function sectionF(): void {
  console.log('\n【F】写口：只加一个键，兄弟键原地保留');
  const d = mkdb();
  d.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run('t1', JSON.stringify({
    attachments: [{ name: 'a.png' }], goal: { text: '目标' }, plan: { path: 'plans/x.md' },
  }));
  const wrote = writeDispatchRequirements(d as never, 't1', { categories: ['code'], intents: [], deviceClasses: [], confidence: 0.6, source: 'rule' });
  ok(wrote, 'F-1 写入成功');
  const c = ctxOf(d, 't1');
  ok(Array.isArray(c.attachments) && (c.goal as { text?: string })?.text === '目标' && (c.plan as { path?: string })?.path === 'plans/x.md',
    'F-2 附件/目标/方案三个兄弟键原样保留（反证裸覆写）');
  eq((c[DISPATCH_REQUIREMENTS_KEY] as { categories?: string[] })?.categories, ['code'], 'F-3 新键确实写入');
  ok(writeDispatchRequirements(d as never, 'missing', { categories: [], intents: [], deviceClasses: [], confidence: 0, source: 'rule' }) === false,
    'F-4 任务不存在 ⇒ false（如实）');
  const read = requirementsForTask({ title: '修复登录 bug', contextJson: JSON.stringify(c) });
  eq([read.categories, read.source], [['code'], 'rule'], 'F-5 读回存档需求而非重判文字');
  const bad = requirementsForTask({ title: '修复登录 bug', contextJson: '{"dispatch_requirements":{"categories":["nope"]}}' });
  eq([bad.categories, bad.source], [['code'], 'rule'], 'F-6 坏存档 ⇒ 规则派生（向后兼容）');
}

function sectionG(): void {
  console.log('\n【G】静态钉：build 真源 / 方案与脚本在册');
  checkBuildPins(ok);
  ok(fs.existsSync(path.join(ROOT, `plans/improve/${SELF_ROUND}.md`)), `G-1 本轮方案在册：plans/improve/${SELF_ROUND}.md`);
}

sectionA();
sectionB();
sectionC();
sectionD();
sectionE();
sectionF();
sectionG();

console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
