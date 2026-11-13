/**
 * zx_20261111_2「述」——项目描述优先入须知，目录树按广度铺开。
 *
 * 四组判据：
 *   T「描述优先」：描述段在仓库资料之前；有描述时多一条"冲突以描述为准"；无描述时提示词不变。
 *   H「来源指纹」：无描述原样返回仓指纹；有描述则组合；描述变/仓变都判过期；无工作目录也可比。
 *   J「作业端到端」：仅凭描述即可生成（工作目录不存在也算有来源）；三类来源全空才失败。
 *   F「选型兜底」：缺省口径（排除 reasoning）选不到时放宽一次；两次都空才失败。
 *   W「接线与界面」：作业读 description、IPC 入队/过期、详情页按钮、成果交付单默认折叠。
 *
 * 纪律：
 *   - 夹具按生产 DDL 建表（含 description 列），不跑 initDatabase；
 *   - 断言文案不含失败字形（rr:all 汇总器按字形计数）；
 *   - 不写"只为下一轮"的字面量；轮次钉由 checkBuildPins 从真源派生。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BRIEF_DESCRIPTION_MAX_CHARS, BRIEF_TREE_MAX_ENTRIES,
  buildProjectBriefPrompt, collectProjectBriefInputs, composeBriefSourceHash, isBriefStale,
  loadProjectBrief, type BriefInputs, type ProjectBrief,
} from '../apps/worker-ant-desktop/src/main/core/project-brief.js';
import { runProjectBriefInit } from '../apps/worker-ant-desktop/src/main/core/project-brief-job.js';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(a: unknown, b: unknown, label: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `${JSON.stringify(a)} = ${JSON.stringify(b)}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const readSrc = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');
const codeOf = (rel: string): string => stripKeepingLines(readSrc(rel)).join('\n');

const GOOD_BRIEF: ProjectBrief = {
  summary: '演示项目：有描述即可生成。',
  stack: ['TypeScript'],
  commands: [],
  entry_points: [],
  layout: [{ path: 'mp/', purpose: '老的微信小程序' }],
  conventions: [],
  gotchas: [],
};

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_projects (
      id TEXT PRIMARY KEY, name TEXT, description TEXT DEFAULT '', working_dir TEXT DEFAULT ''
    );
    CREATE TABLE wa_project_briefs (
      project_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      brief_json TEXT NOT NULL DEFAULT '',
      source_hash TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      trigger TEXT NOT NULL DEFAULT '',
      generated_at TEXT NOT NULL DEFAULT '',
      attempt_model TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

const dbOf = (d: DatabaseSync): never => d as never;

function makeRepo(withFile = true): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rrbrief-2511b-')));
  if (withFile) fs.writeFileSync(path.join(dir, 'README.md'), '# 演示\n', 'utf-8');
  return dir;
}

async function main(): Promise<void> {
  // ═══ T｜描述优先 ═══════════════════════════════════════════════════════
  console.log('\n【T】描述优先：描述段在仓库资料之前，无描述时提示词不变');
  {
    const inputs: BriefInputs = {
      files: [{ rel: 'README.md', content: 'README-体', truncated: false }],
      tree: ['src/'], dropped: [], totalChars: 8, fingerprint: 'fp',
    };
    const desc = '## 目录结构\nmp/ # 怡寿里老的微信小程序';
    const withDesc = buildProjectBriefPrompt(inputs, '怡寿里', desc);
    const iDesc = withDesc.indexOf('=== 项目描述（用户提供，优先采信）===');
    const iFile = withDesc.indexOf('<<<FILE README.md>>>');
    ok(iDesc >= 0 && iFile > iDesc, 'T-1 描述段出现在仓库资料之前', `desc@${iDesc} file@${iFile}`);
    ok(withDesc.includes(desc) && withDesc.includes('项目描述优先') && withDesc.includes('冲突时以描述为准'),
      'T-2 描述原文入提示词，并写明"冲突以描述为准"');
    ok(withDesc.includes('=== 项目描述结束 ===') && withDesc.includes('=== 仓库资料开始 ==='),
      'T-3 描述段有明确起止界（不是混在资料里）');

    const noDesc = buildProjectBriefPrompt(inputs, '怡寿里');
    ok(!noDesc.includes('项目描述') && noDesc.includes('<<<FILE README.md>>>')
      && noDesc.includes('1. 只写资料中能直接看到的事实'),
      'T-4 无描述时提示词不变（不出现描述段）');
    eq(noDesc, buildProjectBriefPrompt(inputs, '怡寿里', '   '), 'T-5 空白描述与无描述逐字节同形');

    const long = 'D'.repeat(BRIEF_DESCRIPTION_MAX_CHARS + 500);
    const cut = buildProjectBriefPrompt(inputs, '长描述', long);
    ok(cut.includes('描述超长，已截断') && !cut.includes('D'.repeat(BRIEF_DESCRIPTION_MAX_CHARS + 1)),
      'T-6 超长描述按上限截断并如实标注', `${BRIEF_DESCRIPTION_MAX_CHARS} 字上限`);
  }

  // ═══ H｜来源指纹 ═══════════════════════════════════════════════════════
  console.log('\n【H】来源指纹：仓指纹 + 描述，无描述时与旧口径一致');
  {
    ok(composeBriefSourceHash('') === '' && composeBriefSourceHash('fp') === 'fp',
      'H-1 无描述原样返回仓指纹（老库可直接比较）');
    const h1 = composeBriefSourceHash('fp', 'D1');
    ok(h1.length === 64 && h1 !== 'fp', 'H-2 有描述则组合成 sha256（不再是纯仓指纹）');
    ok(h1 === composeBriefSourceHash('fp', ' D1 '), 'H-3 描述 trim 后参与（首尾空白不算变化）');
    ok(composeBriefSourceHash('fp', 'D2') !== h1, 'H-4 描述变则指纹变');
    ok(composeBriefSourceHash('fp2', 'D1') !== h1, 'H-5 仓变则指纹也变');

    const repo = makeRepo();
    const inputs = await collectProjectBriefInputs(repo);
    const composed = composeBriefSourceHash(inputs.fingerprint, 'D1');
    ok(await isBriefStale(repo, inputs.fingerprint, '') === false, 'H-6 无描述时按旧口径：仓未变不过期');
    ok(await isBriefStale(repo, composed, 'D1') === false, 'H-7 描述未变且仓未变 ⇒ 不过期');
    ok(await isBriefStale(repo, composed, 'D2') === true, 'H-8 描述改了 ⇒ 如实判过期');
    ok(await isBriefStale('', composeBriefSourceHash('', 'D1'), 'D1') === false,
      'H-9 无工作目录但描述未变 ⇒ 不过期（描述本身就是来源）');
    ok(await isBriefStale('', '', 'D1') === null, 'H-10 从未成功过 ⇒ 不判过期（不编结论）');
  }

  // ═══ J｜采样与作业端到端 ═════════════════════════════════════════════════
  console.log('\n【J】目录树广度优先 + 仅凭描述生成');
  {
    // 顶层 16 个目录 + 150 个根级文件：旧 DFS 会让后面的顶层目录进不了 120 条预算。
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rrbrief-bfs-')));
    for (let i = 0; i < 16; i++) fs.mkdirSync(path.join(dir, `d${String(i).padStart(2, '0')}`), { recursive: true });
    fs.mkdirSync(path.join(dir, 'a', 'b', 'c'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'b', 'c', 'x.ts'), 'deep\n', 'utf-8');
    for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(3, '0')}.txt`), `${i}\n`, 'utf-8');
    const inputs = await collectProjectBriefInputs(dir);
    const tree = inputs.tree;
    const allTop = Array.from({ length: 16 }, (_, i) => `d${String(i).padStart(2, '0')}/`);
    ok(allTop.every((d) => tree.includes(d)), 'J-1 顶层目录全量在树里（不被深层条目挤掉）',
      `${allTop.filter((d) => tree.includes(d)).length}/${allTop.length}`);
    ok(tree.includes('a/') && tree.includes('a/b/') && !tree.includes('a/b/c/x.ts'),
      'J-2 深度仍限两层（a/b 可见，再深不看）');
    ok(tree.indexOf('d15/') < tree.indexOf('f000.txt'), 'J-3 目录先于根级文件（目录职责比文件名重要）',
      `d15@${tree.indexOf('d15/')} f000@${tree.indexOf('f000.txt')}`);
    ok(tree.length === BRIEF_TREE_MAX_ENTRIES, 'J-4 条数上限仍生效', `${tree.length} = ${BRIEF_TREE_MAX_ENTRIES}`);
  }

  {
    const db = makeDb();
    const missing = path.join(os.tmpdir(), `rrbrief-no-such-${Date.now()}`);
    const desc = '## 目录结构\nmp/ # 怡寿里老的微信小程序\nplatform-web/ # 平台运营管理前端';
    db.prepare("INSERT INTO wa_projects (id, name, description, working_dir) VALUES ('p1','怡寿里',?,?)")
      .run(desc, missing);
    let seenPrompt = '';
    const ans = { getOptimalModel: async () => ({ url: 'http://remote.example/v1', api_key: 'k', model_name: 'm-desc' }) };
    const gen = async (input: { prompt: string }) => {
      seenPrompt = input.prompt;
      return { text: JSON.stringify(GOOD_BRIEF), usage: { promptTokens: 11, completionTokens: 22 } };
    };
    const r = await runProjectBriefInit({ db: dbOf(db), ansClient: ans as never, projectId: 'p1', trigger: 'manual', generate: gen });
    const row = loadProjectBrief(dbOf(db), 'p1')!;
    ok(r.ok && row.status === 'ready', 'J-5 工作目录不存在但项目描述非空 ⇒ 成功生成（描述就是来源）', row.error);
    ok(seenPrompt.includes(desc) && seenPrompt.includes('项目描述优先'),
      'J-6 描述真的进了给模型的提示词（不只是读出来落库）');
    ok(row.sourceHash === composeBriefSourceHash('', desc),
      'J-7 落库指纹 = 组合指纹（仓为空 + 描述），过期判定同源');
    ok(row.brief?.layout[0]?.path === 'mp/', 'J-8 描述给出的目录职责原样进入须知');
  }

  {
    // 三类来源全空 ⇒ 失败，且原因同时点名工作目录与项目描述。
    const db = makeDb();
    const missing = path.join(os.tmpdir(), `rrbrief-none-${Date.now()}`);
    db.prepare("INSERT INTO wa_projects (id, name, description, working_dir) VALUES ('p2','空','',?)").run(missing);
    const ans = { getOptimalModel: async () => { throw new Error('不应调用模型'); } };
    const r = await runProjectBriefInit({ db: dbOf(db), ansClient: ans as never, projectId: 'p2', trigger: 'manual', generate: async () => ({ text: '' }) });
    const row = loadProjectBrief(dbOf(db), 'p2')!;
    ok(!r.ok && row.status === 'failed' && row.error.includes('项目描述也为空') && row.error.includes('工作目录不存在'),
      'J-9 工作目录不可用且描述为空 ⇒ 失败原因两样都点名（不让人猜缺哪样）', row.error);
  }

  {
    // 空目录 + 无描述：旧口径仍成立（不调用模型）。
    const db = makeDb();
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rrbrief-empty2511b-')));
    db.prepare("INSERT INTO wa_projects (id, name, description, working_dir) VALUES ('p3','空','',?)").run(empty);
    const ans = { getOptimalModel: async () => { throw new Error('不应调用模型'); } };
    const r = await runProjectBriefInit({ db: dbOf(db), ansClient: ans as never, projectId: 'p3', trigger: 'manual', generate: async () => ({ text: '' }) });
    const row = loadProjectBrief(dbOf(db), 'p3')!;
    ok(!r.ok && row.status === 'failed' && row.error.includes('工作目录为空'),
      'J-10 空目录且无描述 ⇒ 失败原因含"工作目录为空"（旧口径不回退）', row.error);
  }

  // ═══ F｜选型兜底（池中只剩思考模型） ══════════════════════════════════
  console.log('\n【F】辅助路选型兜底：先缺省口径，选不到才放宽为思考模型');
  {
    const db = makeDb();
    const missing = path.join(os.tmpdir(), `rrbrief-reason-${Date.now()}`);
    db.prepare("INSERT INTO wa_projects (id, name, description, working_dir) VALUES ('p4','思考池','描述即来源',?)").run(missing);
    const calls: string[][] = [];
    // 模拟 live ANS：排除 reasoning 时无模型（NOT_FOUND），放宽后才返回唯一可用的思考模型。
    const ans = {
      getOptimalModel: async (req: { excludeCapabilities?: string[] }) => {
        const ex = req.excludeCapabilities ?? [];
        calls.push(ex);
        if (ex.length > 0) throw new Error('NOT_FOUND: no model matches');
        return { url: 'http://remote.example/v1', api_key: 'k', model_name: 'm-reason' };
      },
    };
    const gen = async () => ({ text: JSON.stringify(GOOD_BRIEF), usage: { promptTokens: 5, completionTokens: 6 } });
    const r = await runProjectBriefInit({ db: dbOf(db), ansClient: ans as never, projectId: 'p4', trigger: 'manual', generate: gen });
    const row = loadProjectBrief(dbOf(db), 'p4')!;
    ok(r.ok && row.status === 'ready' && row.model === 'm-reason',
      'F-1 缺省口径选不到时放宽一次并成功（不再直接失败）', row.error);
    ok(calls.length === 2 && calls[0].includes('reasoning') && calls[1].length === 0,
      'F-2 顺序正确：第一次仍排除 reasoning，第二次才放宽', JSON.stringify(calls));

    const db2 = makeDb();
    db2.prepare("INSERT INTO wa_projects (id, name, description, working_dir) VALUES ('p5','全空','描述即来源',?)").run(missing);
    const calls2: string[][] = [];
    const ansNone = {
      getOptimalModel: async (req: { excludeCapabilities?: string[] }) => {
        calls2.push(req.excludeCapabilities ?? []);
        throw new Error('NOT_FOUND: no model matches');
      },
    };
    const r2 = await runProjectBriefInit({ db: dbOf(db2), ansClient: ansNone as never, projectId: 'p5', trigger: 'manual', generate: gen });
    const row2 = loadProjectBrief(dbOf(db2), 'p5')!;
    ok(!r2.ok && row2.status === 'failed' && row2.error.includes('已尝试非思考与思考模型'),
      'F-3 两次都选不到 ⇒ 失败且原因如实写明已尝试两类模型', row2.error);
    ok(calls2.length === 2 && row2.attemptModel === '',
      'F-4 两次口径都试过；选型前失败不拿旧模型冒充本次', `calls=${calls2.length} attempt=${row2.attemptModel || '空'}`);

    const job2 = codeOf(`${A}/src/main/core/project-brief-job.ts`);
    ok(/auxModelRequest\(\{ strategy: 'balanced', allowReasoning \}\)/.test(job2)
      && /excludeCapabilities: input\.allowReasoning \? \[\] : \[\.\.\.AUX_LLM_EXCLUDE_CAPABILITIES\]/.test(codeOf(`${A}/src/main/core/model-request.ts`)),
      'F-5 接线：作业把开关传进 auxModelRequest，缺省口径仍是排除 reasoning');
  }

  // ═══ W｜接线与界面 ═════════════════════════════════════════════════════
  console.log('\n【W】接线与界面：读描述、入队条件、按钮可达、成果单折叠');
  {
    const job = codeOf(`${A}/src/main/core/project-brief-job.ts`);
    ok(/SELECT name, description, working_dir FROM wa_projects/.test(job),
      'W-1 作业真的从库里读项目描述（不是只读名字与目录）');
    ok(/buildProjectBriefPrompt\(inputs, String\(proj\.name \?\? ''\), description\)/.test(job),
      'W-2 描述作为第三个参数进提示词（接线那一跳按语句形状钉）');
    ok(/composeBriefSourceHash\(inputs\.fingerprint, description\)/.test(job),
      'W-3 成功落库用组合指纹（与过期判定同一真源）');
    ok(/inputs\.files\.length === 0 && inputs\.tree\.length === 0 && !hasDescription/.test(job),
      'W-4 三类来源全空才失败（描述非空不再被"files:0"误杀）');

    const ipc = codeOf(`${A}/src/main/ipc/project.ipc.ts`);
    ok(/const shouldInit = auto\.run \|\| hasDescription/.test(ipc)
      && /if \(shouldInit\) enqueueJob\(db, 'project-init-brief'/.test(ipc),
      'W-5 创建时"目录可跑或描述非空"即入队');
    ok(/isBriefStale\(workingDir, stored\.sourceHash, description\)/.test(ipc),
      'W-6 过期判定带上项目描述（描述改过也能提示）');

    const page = codeOf(`${A}/renderer/src/pages/ProjectDetailPage.tsx`);
    ok(/const hasBriefSource = Boolean\(project\?\.working_dir \|\| project\?\.description\?\.trim\(\)\)/.test(page),
      'W-7 详情页"有来源"= 工作目录或项目描述');
    ok(/disabled=\{briefWait \|\| briefRec\?\.status === 'running' \|\| !hasBriefSource\}/.test(page),
      'W-8 重新初始化按钮：仅当两样都没有时禁用');
    ok(page.includes('仓库文件或项目描述已变化'), 'W-9 过期横幅写明描述也是来源');

    const ddc = readSrc(`${A}/renderer/src/components/DeliveryDigestCard.tsx`);
    ok(/return \(\s*<details className="mt-3[^"]*">/.test(ddc) && !/<details[^>]*\bopen\b/.test(ddc),
      'W-10 本阶段成果交付单用 details 且无 open ⇒ 默认折叠');
    ok(ddc.includes('<summary') && ddc.includes('本阶段成果交付单')
      && ddc.includes('已落地里程碑') && ddc.includes('高质量已完成任务'),
      'W-11 折叠后标题与各节内容都还在（不是删掉功能）');
  }

  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

  console.log(`\n[rr_zx_20261111_2_brief] ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error('\nrr_zx_20261111_2_brief 未捕获异常（复跑未跑完，不得读作通过）：', e);
  console.log(`\n[rr_zx_20261111_2_brief] ${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
