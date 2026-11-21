/**
 * zx_20261121_1 「属·数·用」受控复跑。
 *
 * 分组：
 *   A 项目技能表与存量迁移
 *   B 注册表作用域（岗位 > 项目 > 全局）
 *   C 项目经验派生（规模/工具/浪费/失败/服务/ROI）
 *   D 经验注入（≤120 token、400 总预算、开关、注入账）
 *   E 项目页与 IPC 接线
 *   F 采纳预算（json_set 单键、兄弟键保留、审计）
 *   G 反证与静态扫描
 *   H build 钉
 *
 * 纪律（承 CLAUDE.md 与 auto-memory）：
 *   · 直引生产函数 / 真实现；缺失即失败，不静默跳过。
 *   · 断言文案不含失败字形；计数器给 0→N 的正面值。
 *   · 夹具按生产初始化顺序：先 initDatabase，再插数据行。
 *   · 不写“只为下一轮”的字面量；build 由 checkBuildPins 派生核对。
 *   · 未实施组用 skip() 如实标注，不记 pass。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { checkBuildPins, buildNotOlderThan } from './lib/rr-pins.js';
import { initDatabase } from '../apps/worker-ant-desktop/src/main/database.js';

let pass = 0;
let fail = 0;
let skipped = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ok ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}
function skip(label: string): void { skipped++; console.log(`  · SKIP ${label}`); }

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const SELF = path.basename(__filename).replace(/\.ts$/, '');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261121-1-'));
let dbSeq = 0;
function mkdb(): Database.Database {
  const db = initDatabase(path.join(tmpRoot, `db-${++dbSeq}`));
  db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p1','项目一',?)").run(tmpRoot);
  db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p2','项目二',?)").run(tmpRoot);
  return db;
}

// ==================== A：项目技能表与存量迁移 ====================
async function runA(): Promise<void> {
  console.log('\n[A] 项目技能表与存量迁移');
  let mod: typeof import('../apps/worker-ant-desktop/src/main/core/project-skills.js');
  try { mod = await import('../apps/worker-ant-desktop/src/main/core/project-skills.js'); }
  catch (e) { fail++; console.error(`  FAIL 模块在场 — ${(e as Error).message}`); return; }

  ok(mod.PROJECT_SKILLS_DDL.includes('wa_project_skills'), 'DDL 指向 wa_project_skills');
  ok(/UNIQUE\s*\(\s*project_id\s*,\s*name\s*\)/i.test(mod.PROJECT_SKILLS_DDL), 'DDL 有 (project_id,name) 唯一约束');

  const db = mkdb();
  try {
    const r = mod.createProjectSkillDraft(db, { projectId: 'p1', name: 'alpha', description: 'A', steps: ['一', '二'] });
    ok(r.ok, 'p1 建草案成功', JSON.stringify(r));
    if (!r.ok) return;
    eq(r.skill.status, 'draft', '草案状态 draft');
    eq(r.skill.projectId, 'p1', '草案归属 p1');

    const list1 = mod.listProjectSkills(db, 'p1');
    const list2 = mod.listProjectSkills(db, 'p2');
    eq(list1.length, 1, 'p1 列出 1 条');
    eq(list2.length, 0, 'p2 看不到 p1 的技能');

    const dup = mod.createProjectSkillDraft(db, { projectId: 'p1', name: 'alpha', steps: ['三'] });
    eq(dup.ok, false, '同项目同名拒绝');
    if (!dup.ok) eq(dup.code, 'DUPLICATE', '同项目同名码 DUPLICATE');

    const cross = mod.createProjectSkillDraft(db, { projectId: 'p2', name: 'alpha', steps: ['四'] });
    ok(cross.ok, '跨项目同名允许（各归各项目）', JSON.stringify(cross));
    eq(mod.listProjectSkills(db, 'p2').length, 1, 'p2 有了自己的 alpha');

    const approved = mod.decideProjectSkill(db, r.skill.id, 'approved');
    ok(approved.ok, '批准 p1 草案', JSON.stringify(approved));
    eq(mod.listProjectSkills(db, 'p1', 'approved').length, 1, 'p1 已批准 1 条');

    const promoted = mod.promoteProjectSkillToGlobal(db, r.skill.id);
    ok(promoted.ok, '项目技能可提升为全局', JSON.stringify(promoted));
    eq(mod.listProjectSkills(db, 'p1').length, 0, '提升后项目表移除');
    const globalRow = db.prepare("SELECT name, project_id, status FROM wa_skills WHERE name = 'alpha'").get() as { name?: string; project_id?: string | null; status?: string } | undefined;
    eq(globalRow?.name, 'alpha', '全局表有 alpha');
    eq(globalRow?.project_id ?? null, null, '全局行 project_id 为 NULL');
    eq(globalRow?.status, 'approved', '全局行 approved');

    const cross2 = mod.createProjectSkillDraft(db, { projectId: 'p1', name: 'alpha', steps: ['五'] });
    ok(cross2.ok, '全局同名不阻塞项目内同名', JSON.stringify(cross2));
    if (cross2.ok) mod.decideProjectSkill(db, cross2.skill.id, 'approved');
    const promoted2 = cross2.ok ? mod.promoteProjectSkillToGlobal(db, cross2.skill.id) : { ok: true };
    eq(promoted2.ok, false, '提升为全局遇全局同名拒绝');
    if (cross2.ok && !promoted2.ok) eq(promoted2.code, 'DUPLICATE', '提升冲突码 DUPLICATE');

    // 存量迁移：旧 wa_skills 里带 project_id 的行
    db.prepare(
      "INSERT INTO wa_skills (id, name, description, category, config, status, project_id) VALUES ('legacy-1','legacy_skill','旧技能','custom',?, 'approved','p2')",
    ).run(JSON.stringify({ instructions: ['旧步骤一', '旧步骤二'] }));
    const mig = mod.migrateLegacyProjectSkills(db);
    ok(mig.migrated >= 1, '迁移至少 1 行', JSON.stringify(mig));
    const legacyNew = mod.listProjectSkills(db, 'p2').find((s) => s.name === 'legacy_skill');
    ok(!!legacyNew, '旧行进入项目表');
    eq(legacyNew?.steps, ['旧步骤一', '旧步骤二'], '旧 steps 映射正确');
    eq(legacyNew?.status, 'approved', '旧 status 保留');
    const legacyOld = db.prepare("SELECT COUNT(*) AS n FROM wa_skills WHERE project_id = 'p2' AND name = 'legacy_skill'").get() as { n: number };
    eq(Number(legacyOld.n), 0, '迁移成功后旧行删除');
    const mig2 = mod.migrateLegacyProjectSkills(db);
    eq(mig2.migrated, 0, '迁移幂等（第二次 0 行）');
  } finally { try { db.close(); } catch { /* ignore */ } }
}

// ==================== B：注册表作用域 ====================
async function runB(): Promise<void> {
  console.log('\n[B] 注册表作用域');
  let reg: typeof import('../apps/worker-ant-desktop/src/main/core/skill-registry.js');
  try { reg = await import('../apps/worker-ant-desktop/src/main/core/skill-registry.js'); }
  catch (e) { fail++; console.error(`  FAIL 模块在场 — ${(e as Error).message}`); return; }

  reg.registerSkill({ name: 'global_one', description: 'G', category: 'custom', content: 'G' });
  reg.registerProjectSkill('p1', { name: 'proj_one', description: 'P1', category: 'custom', content: 'P1' });
  reg.registerProjectSkill('p2', { name: 'proj_one', description: 'P2', category: 'custom', content: 'P2' });
  reg.registerPositionSkill('pos1', { name: 'proj_one', description: 'POS', category: 'position', content: 'POS' });

  const p1 = reg.listSkillsForTask('p1', undefined);
  const p2 = reg.listSkillsForTask('p2', undefined);
  ok(p1.some((s) => s.name === 'global_one'), '全局技能 p1 可见');
  ok(p2.some((s) => s.name === 'global_one'), '全局技能 p2 可见');
  ok(p1.some((s) => s.name === 'proj_one'), 'p1 项目技能 p1 可见');
  eq(p1.some((s) => s.name === 'proj_one' && s.description === 'P2'), false, 'p1 不串 p2 的项目技能');
  ok(p2.some((s) => s.name === 'proj_one' && s.description === 'P2'), 'p2 看到自己的项目技能');

  const withPos = reg.listSkillsForTask('p1', 'pos1');
  const posRow = withPos.find((s) => s.name === 'proj_one');
  eq(posRow?.category, 'position', '岗位技能同名优先');
  eq(posRow?.description, 'POS', '岗位技能描述胜出');

  const outP1 = await reg.executeSkillForTask('p1', undefined, 'proj_one', '');
  ok(outP1.result.includes('P1'), 'p1 执行到自己的项目技能', outP1.result);
  const outP2 = await reg.executeSkillForTask('p2', undefined, 'proj_one', '');
  ok(outP2.result.includes('P2'), 'p2 执行到自己的项目技能', outP2.result);
  const outPos = await reg.executeSkillForTask('p1', 'pos1', 'proj_one', '');
  ok(outPos.result.includes('POS'), '岗位技能执行优先', outPos.result);
  const outMissing = await reg.executeSkillForTask('p2', undefined, 'not_exists', '');
  ok(outMissing.result.includes('未知技能'), '未知名如实报未知', outMissing.result);

  reg.clearProjectSkills();
  eq(reg.listSkillsForTask('p1', undefined).some((s) => s.name === 'proj_one'), false, 'clearProjectSkills 清空项目作用域');
  ok(reg.listSkills().some((s) => s.name === 'global_one'), '全局技能不受影响');
}

// ==================== C：项目经验派生 ====================
async function runC(): Promise<void> {
  console.log('\n[C] 项目经验派生');
  let mod: typeof import('../apps/worker-ant-desktop/src/main/core/project-experience.js');
  try { mod = await import('../apps/worker-ant-desktop/src/main/core/project-experience.js'); }
  catch (e) { fail++; console.error(`  FAIL 模块在场 — ${(e as Error).message}`); return; }

  eq(mod.percentile([], 50), null, 'percentile 空集为 null');
  eq(mod.percentile([10], 50), 10, 'percentile 单值为自身');
  eq(mod.percentile([10, 20, 30, 40], 50), 25, 'percentile p50 线性插值');
  eq(mod.percentile([10, 20, 30, 40], 90), 37, 'percentile p90 线性插值');

  const db = mkdb();
  try {
    const taskIds: string[] = [];
    const tokens = [100_000, 200_000, 300_000, 400_000, 500_000];
    const steps = [10, 20, 30, 40, 50];
    for (let i = 0; i < tokens.length; i++) {
      const id = `t${i + 1}`;
      taskIds.push(id);
      db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json, created_at) VALUES (?, 'p1', ?, 'completed', ?, datetime('now'))")
        .run(id, `任务${i + 1}`, JSON.stringify({ execution_metrics: { archetype: 'code', totalTokens: tokens[i], stepsUsed: steps[i] } }));
    }
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json, created_at) VALUES ('p2t','p2','别的项目','completed',?, datetime('now'))")
      .run(JSON.stringify({ execution_metrics: { archetype: 'code', totalTokens: 9_000_000, stepsUsed: 99 } }));
    db.prepare('UPDATE wa_projects SET context_json = ? WHERE id = ?').run(JSON.stringify({
      tool_usage: {
        'write_file:code': { toolName: 'write_file', projectId: 'p1', archetype: 'code', successCount: 8, failCount: 1 },
        'ask_user:code': { toolName: 'ask_user', projectId: 'p1', archetype: 'code', successCount: 2, failCount: 0 },
      },
    }), 'p1');

    const ev = db.prepare(
      "INSERT INTO wa_task_runtime_evidence (id, task_id, tool, command, ok, deny_reason, created_at) VALUES (?, ?, 'bash', ?, ?, ?, datetime('now'))",
    );
    for (let i = 0; i < 3; i++) ev.run(randomUUID(), 't1', 'echo a', 0, 'deny_kind=illegal_char; 命令包含换行/分隔符');
    for (let i = 0; i < 4; i++) ev.run(randomUUID(), 't2', 'find .', 0, 'deny_kind=exploration_limit; 本次调用属探索类');
    for (let i = 0; i < 2; i++) ev.run(randomUUID(), 't3', 'echo x > f', 0, '重定向被禁止，写文件请用 write_file');
    for (let i = 0; i < 2; i++) ev.run(randomUUID(), 't4', 'pnpm test', 0, null);

    const failure = db.prepare(
      "INSERT INTO wa_event_log (event_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, occurred_at) VALUES (?, 'task.failed', 'task', ?, 0, ?, datetime('now'))",
    );
    const failPayload = (error: string) => JSON.stringify({ error, phase: 'execute_error', projectId: 'p1' });
    failure.run(randomUUID(), 't1', failPayload("Model tried to call unavailable tool 'read_file'"));
    failure.run(randomUUID(), 't2', failPayload("Model tried to call unavailable tool 'read_file'"));
    failure.run(randomUUID(), 't3', failPayload('auth failed token=supersecretvalue123'));

    const call = db.prepare(
      "INSERT INTO wa_service_calls (id, project_id, task_id, kind, target, operation, ok, duration_ms, error, created_at) VALUES (?, 'p1', ?, ?, ?, ?, ?, 12, ?, datetime('now'))",
    );
    call.run(randomUUID(), 't1', 'mcp', 'svc/tool', 'call', 1, null);
    call.run(randomUUID(), 't1', 'mcp', 'svc/tool', 'call', 0, 'boom');
    call.run(randomUUID(), 't2', 'a2a', 'agent', 'start', 1, null);

    const inj = db.prepare(
      "INSERT INTO wa_context_injections (id, task_id, source, ref_id, chars, est_tokens, outcome) VALUES (?, ?, 'memory', ?, 100, 25, ?)",
    );
    inj.run(randomUUID(), 't1', 'm1', 'completed');
    inj.run(randomUUID(), 't2', 'm2', 'completed');

    const exp = mod.deriveProjectExperience(db, 'p1', { minSamples: 1 });
    eq(exp.evidence.completed, 5, '证据：p1 完成 5 单');
    eq(exp.scale.length, 1, '规模账只列 code 一档');
    const code = exp.scale[0];
    eq(code?.tasks, 5, 'code 档 5 单');
    eq(code?.tokensP50, 300_000, 'token p50');
    eq(code?.tokensP90, 460_000, 'token p90');
    eq(code?.stepsP50, 30, 'steps p50');

    const wf = exp.tools.find((t) => t.tool === 'write_file');
    ok(!!wf, '工具可靠度含 write_file');
    eq(wf?.total, 9, 'write_file 调用 9 次');
    eq(wf?.success, 8, 'write_file 成功 8 次');
    ok(!exp.tools.some((t) => t.tool === 'ask_user'), '样本 <3 的工具不显示');

    const illegal = exp.pitfalls.find((p) => p.kind === 'illegal_char');
    eq(illegal?.count, 3, 'illegal_char 计 3 次');
    ok((illegal?.advice || '').includes('write_file'), 'illegal_char 有确定性建议');
    eq(exp.realFailures.reduce((n, r) => n + r.count, 0), 2, '真命令失败 2 次');

    const unavailable = exp.failures.find((f) => f.cause.includes('unavailable tool'));
    eq(unavailable?.count, 2, '同类失败因归并 2 次');
    eq(unavailable?.taskIds.length, 2, '失败因带 2 个 taskId');
    ok(!exp.failures.some((f) => f.cause.includes('supersecretvalue123')), '失败因不含明文 token');

    ok(exp.services !== null, '服务调用账在场');
    eq(exp.services?.byKind.find((k) => k.kind === 'mcp')?.calls, 2, 'mcp 调用 2 次');
    ok(exp.injections.rows.some((r) => r.source === 'memory'), '注入 ROI 含 memory 来源');
    eq(exp.enough, true, 'p1 证据充足');

    const brief = mod.deriveExperienceBrief(db, 'p1');
    ok(!('services' in brief), 'brief 不带服务账');
    const rendered = mod.renderExperienceBrief(brief, 120);
    ok(rendered.tokens <= 120, '经验段 ≤120 token', `${rendered.tokens}`);
    ok(rendered.text.includes('被拒') || rendered.text.includes('坑'), '经验段含坑位提示');
    const tight = mod.renderExperienceBrief(brief, 20);
    ok(tight.tokens <= 20, '收紧预算后 ≤20 token', `${tight.tokens}`);

    const p2 = mod.deriveProjectExperience(db, 'p2');
    eq(p2.evidence.completed, 1, 'p2 只看到自己 1 单');
    eq(p2.scale.length, 0, 'p2 单形态样本不足不列规模');
    eq(p2.enough, false, 'p2 证据不足');

    db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p3','空项目','/tmp')").run();
    const p3 = mod.deriveProjectExperience(db, 'p3');
    eq(p3.enough, false, '空项目证据不足');
    eq(p3.scale, [], '空项目规模为空');
    eq(p3.pitfalls, [], '空项目坑为空');
    eq(mod.renderExperienceBrief(mod.deriveExperienceBrief(db, 'p3'), 120).text, '', '空项目不渲染经验段');

    const h1 = mod.experienceSourceHash(mod.deriveExperienceBrief(db, 'p1'));
    const h2 = mod.experienceSourceHash(mod.deriveExperienceBrief(db, 'p1'));
    eq(h1, h2, '同输入 sourceHash 稳定');
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json, created_at) VALUES ('t6','p1','新任务','completed',?, datetime('now'))")
      .run(JSON.stringify({ execution_metrics: { archetype: 'code', totalTokens: 600_000, stepsUsed: 60 } }));
    const h3 = mod.experienceSourceHash(mod.deriveExperienceBrief(db, 'p1'));
    ok(h1 !== h3, '输入变化 sourceHash 变化');
  } finally { try { db.close(); } catch { /* ignore */ } }
}

// ==================== D：经验注入 ====================
async function runD(): Promise<void> {
  console.log('\n[D] 经验注入');
  let labels: typeof import('../apps/worker-ant-desktop/src/main/core/project-experience-labels.js');
  let inj: typeof import('../apps/worker-ant-desktop/src/main/core/injection-sources.js');
  let memoryMod: typeof import('../apps/worker-ant-desktop/src/main/core/memory-manager.js');
  try {
    labels = await import('../apps/worker-ant-desktop/src/main/core/project-experience-labels.js');
    inj = await import('../apps/worker-ant-desktop/src/main/core/injection-sources.js');
    memoryMod = await import('../apps/worker-ant-desktop/src/main/core/memory-manager.js');
  } catch (e) { fail++; console.error(`  FAIL 模块在场 — ${(e as Error).message}`); return; }

  eq(labels.EXPERIENCE_INJECT_MAX_TOKENS, 120, '经验段上限 120 token');
  ok((inj.INJECTION_SOURCES as readonly string[]).includes('project_experience'), '注入来源词表含 project_experience');
  eq(inj.injectionSourceLabel('project_experience'), '项目经验', '来源人话名');

  // 写口：用生产 MemoryManager 的原型方法 + 窄假库（不构造完整依赖）
  const rows: unknown[][] = [];
  const fakeDb = {
    prepare: (_sql: string) => ({
      run: (...args: unknown[]) => { rows.push(args); return { changes: 1 }; },
      get: () => undefined,
      all: () => [],
    }),
  };
  const written = (memoryMod.MemoryManager.prototype as unknown as {
    recordContextInjections: (this: unknown, taskId: string, input: unknown) => number;
  }).recordContextInjections.call({ db: fakeDb }, 't1', { experiences: [{ ref_id: 'experience:abc', chars: 40 }] });
  eq(written, 1, '经验注入行 0→1');
  eq(rows[0]?.[2], 'project_experience', '落库 source=project_experience');
  eq(rows[0]?.[3], 'experience:abc', '落库 ref_id 带哈希');

  // 开关：缺省开；'0' 关
  const proto = memoryMod.MemoryManager.prototype as unknown as {
    isProjectExperienceInjectEnabled: (this: unknown) => boolean;
    getProjectExperienceBrief: (this: unknown, projectId: string) => { projectId: string } | null;
  };
  const onDb = { prepare: () => ({ get: () => undefined, all: () => [], run: () => ({ changes: 1 }) }) };
  eq(proto.isProjectExperienceInjectEnabled.call({ db: onDb }), true, '开关缺省开');
  const offDb = { prepare: () => ({ get: () => ({ value: '0' }), all: () => [], run: () => ({ changes: 1 }) }) };
  eq(proto.isProjectExperienceInjectEnabled.call({ db: offDb }), false, '开关写 0 即关');

  // 轻量派生：经生产方法取回项目账
  const db = mkdb();
  try {
    db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json, created_at) VALUES ('x1','p1','任务','completed',?, datetime('now'))")
      .run(JSON.stringify({ execution_metrics: { archetype: 'code', totalTokens: 1000, stepsUsed: 3 } }));
    const brief = proto.getProjectExperienceBrief.call({ db }, 'p1');
    eq(brief?.projectId, 'p1', '生产方法取回 p1 经验 brief');
  } finally { try { db.close(); } catch { /* ignore */ } }

  // 静态：经验段从 400 预算内先扣（不新增总量）
  const ctxSrc = fs.readFileSync(path.join(root, A, 'src/main/core/memory-context.ts'), 'utf-8');
  ok(ctxSrc.includes('KNOWLEDGE_INJECT_MAX_TOKENS - profileTokens - cardTokens - experienceTokens'), '知识册预算扣除经验段');
  ok(ctxSrc.includes("add('项目经验'"), '经验段进入上下文');
  const mgrSrc = fs.readFileSync(path.join(root, A, 'src/main/core/memory-manager.ts'), 'utf-8');
  ok(mgrSrc.includes('INJECTION_SOURCE.projectExperience'), '注入账写口含经验来源');
  const boolSrc = fs.readFileSync(path.join(root, A, 'src/main/core/settings-bool.ts'), 'utf-8');
  ok(boolSrc.includes("'project.experience_inject'"), '开关进 BOOL_SETTING_KEYS');

  // 真装配：buildMemoryContext 把经验段写进上下文，无证据/开关关时不写
  const mc = await import('../apps/worker-ant-desktop/src/main/core/memory-context.js');
  const expMod = await import('../apps/worker-ant-desktop/src/main/core/project-experience.js');
  const labels2 = await import('../apps/worker-ant-desktop/src/main/core/project-experience-labels.js');
  const est = await import('../apps/worker-ant-desktop/src/main/core/token-estimate.js');
  const db2 = mkdb();
  try {
    for (let i = 0; i < 5; i++) {
      db2.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json, created_at) VALUES (?, 'p1', ?, 'completed', ?, datetime('now'))")
        .run(`e${i}`, `任务${i}`, JSON.stringify({ execution_metrics: { archetype: 'code', totalTokens: 100_000 * (i + 1), stepsUsed: 10 } }));
    }
    for (let i = 0; i < 4; i++) {
      db2.prepare("INSERT INTO wa_task_runtime_evidence (id, task_id, tool, command, ok, deny_reason, created_at) VALUES (?, 'e0', 'bash', 'echo a', 0, 'deny_kind=illegal_char; 换行', datetime('now'))").run(randomUUID());
    }
    const brief = expMod.deriveExperienceBrief(db2 as never, 'p1');
    type Mem = Parameters<typeof mc.buildMemoryContext>[0];
    const stub = (enabled: boolean) => ({
      listProjectProfile: () => null,
      listKnowledgeCards: () => [],
      knowledgeCardStats: () => undefined,
      listDomainKnowledge: () => [],
      listAppliedDomainPacks: () => [],
      buildMemoryEffectivenessStats: () => [],
      buildExecutionPlaybook: () => ({}),
      retrieveByType: () => [],
      getProjectKnowledge: () => [],
      retrieveKnowledgeGraphContext: () => [],
      getTriggeredProspective: () => [],
      getWorkingMemory: () => [],
      retrieveUnknownHits: () => [],
      retrieveNegativeHits: () => [],
      findSimilarTasks: () => [],
      getTaskArchetype: () => null,
      getTaskText: () => '',
      recordInjection: () => { /* 本用例只量装配 */ },
      isProjectExperienceInjectEnabled: () => enabled,
      getProjectExperienceBrief: () => brief,
    });
    const built = mc.buildMemoryContext(stub(true) as unknown as Mem, 'p1', undefined, undefined, null, undefined, 20_000);
    ok(built.experienceText.startsWith('## 项目经验'), '装配：经验段入文');
    ok(built.context.includes(built.experienceText), '装配：上下文含经验段');
    eq(built.experienceInjections.length, 1, '装配：经验注入行 0→1');
    ok(est.estimateTokensFromChars(built.experienceText.length) <= labels2.EXPERIENCE_INJECT_MAX_TOKENS,
      '装配：经验段 ≤120 token', `${est.estimateTokensFromChars(built.experienceText.length)}`);
    const off = mc.buildMemoryContext(stub(false) as unknown as Mem, 'p1', undefined, undefined, null, undefined, 20_000);
    eq(off.experienceText, '', '装配：开关关 ⇒ 无经验段');
    eq(off.experienceInjections.length, 0, '装配：开关关 ⇒ 零注入行');
  } finally { try { db2.close(); } catch { /* ignore */ } }
}

// ==================== E：项目页与 IPC 接线 ====================
async function runE(): Promise<void> {
  console.log('\n[E] 项目页与 IPC 接线');
  const ipcSrc = fs.readFileSync(path.join(root, A, 'src/main/ipc/project.ipc.ts'), 'utf-8');
  ok(ipcSrc.includes("ipcMain.handle('project:experience'"), '读口 project:experience 在册');
  ok(ipcSrc.includes("ipcMain.handle('project:experienceAdoptBudget'"), '采纳口 project:experienceAdoptBudget 在册');
  ok(ipcSrc.includes('deriveProjectExperience'), '读口调生产派生');
  ok(ipcSrc.includes('adoptProjectBudget'), '采纳口调生产写口');

  const pageSrc = fs.readFileSync(path.join(root, A, 'renderer/src/pages/ProjectDetailPage.tsx'), 'utf-8');
  ok(pageSrc.includes('projects.experience(id)'), '项目页调 experience 读口');
  ok(pageSrc.includes('projects.experienceAdoptBudget(id'), '项目页调采纳口');
  ok(pageSrc.includes('项目经验（近'), '项目页含经验卡首行');
  ok(pageSrc.includes('证据不足'), '证据不足如实上屏');
  ok(pageSrc.includes('相关，非因果'), '页面标明相关非因果');

  // 项目详情仍是 7 个页签（不新增第 8 个）
  const m = /useState<([^>]+)>\('overview'\)/.exec(pageSrc);
  const union = m?.[1] ?? '';
  const tabCount = (union.match(/'/g) ?? []).length / 2;
  eq(tabCount, 7, '项目详情页签仍为 7 个');
  ok(!union.includes('experience'), '经验未新增第 8 页签');

  const ipcRendererSrc = fs.readFileSync(path.join(root, A, 'renderer/src/lib/ipc.ts'), 'utf-8');
  ok(ipcRendererSrc.includes("'project:experience'"), '渲染层 IPC 信封在册');
  ok(ipcRendererSrc.includes("'project:experienceAdoptBudget'"), '渲染层采纳信封在册');

  const auditSrc = fs.readFileSync(path.join(root, A, 'src/main/core/audit-labels.ts'), 'utf-8');
  ok(auditSrc.includes("'project.budget_adopt'"), '采纳预算审计词在册');
}

// ==================== F：采纳预算 ====================
async function runF(): Promise<void> {
  console.log('\n[F] 采纳预算');
  let budget: typeof import('../apps/worker-ant-desktop/src/main/core/project-budget.js');
  try { budget = await import('../apps/worker-ant-desktop/src/main/core/project-budget.js'); }
  catch (e) { fail++; console.error(`  FAIL 模块在场 — ${(e as Error).message}`); return; }

  const db = mkdb();
  try {
    db.prepare('UPDATE wa_projects SET context_json = ? WHERE id = ?').run(JSON.stringify({
      cron_run_command: 'bash run.sh',
      attachments: [{ name: 'a.txt' }],
      budget: { max_tokens_per_task: 1000, max_cost_usd_per_task: 2 },
    }), 'p1');

    const r = budget.adoptProjectBudget(db, { projectId: 'p1', maxTokens: 200_000 });
    ok(r.ok, '采纳成功', JSON.stringify(r));
    if (r.ok) { eq(r.previous, 1000, 'previous 如实'); eq(r.next, 200_000, 'next 如实'); }
    const ctx = JSON.parse((db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get('p1') as { context_json: string }).context_json) as Record<string, any>;
    eq(ctx.budget.max_tokens_per_task, 200_000, '预算键已改');
    eq(ctx.budget.max_cost_usd_per_task, 2, '兄弟预算键保留');
    eq(ctx.cron_run_command, 'bash run.sh', 'cron 兄弟键保留');
    eq(ctx.attachments?.[0]?.name, 'a.txt', '附件兄弟键保留');

    const bad0 = budget.adoptProjectBudget(db, { projectId: 'p1', maxTokens: 0 });
    eq(bad0.ok, false, '0 拒绝');
    if (!bad0.ok) eq(bad0.code, 'BAD_INPUT', '0 码 BAD_INPUT');
    const badF = budget.adoptProjectBudget(db, { projectId: 'p1', maxTokens: 1.5 });
    eq(badF.ok, false, '小数拒绝');
    const badBig = budget.adoptProjectBudget(db, { projectId: 'p1', maxTokens: 20_000_001 });
    eq(badBig.ok, false, '越界拒绝');
    const ctx2 = JSON.parse((db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get('p1') as { context_json: string }).context_json) as Record<string, any>;
    eq(ctx2.budget.max_tokens_per_task, 200_000, '拒绝后预算未变');

    const missing = budget.adoptProjectBudget(db, { projectId: 'nope', maxTokens: 1000 });
    eq(missing.ok, false, '不存在项目拒绝');
    if (!missing.ok) eq(missing.code, 'NOT_FOUND', '不存在码 NOT_FOUND');

    const p2 = budget.adoptProjectBudget(db, { projectId: 'p2', maxTokens: 300_000 });
    ok(p2.ok, 'p2 无预算也可采纳', JSON.stringify(p2));
    if (p2.ok) eq(p2.previous, null, 'previous 无则 null');
  } finally { try { db.close(); } catch { /* ignore */ } }
}

// ==================== G：反证与静态 ====================
async function runG(): Promise<void> {
  console.log('\n[G] 反证与静态');
  const mgrSrc = fs.readFileSync(path.join(root, A, 'src/main/core/memory-manager.ts'), 'utf-8');
  const psSrc = fs.readFileSync(path.join(root, A, 'src/main/core/project-skills.ts'), 'utf-8');
  ok(mgrSrc.includes('loadSkillsFromDbCompat(this.db)'), '管理器只留一跳（实现住 project-skills）');
  ok(psSrc.includes("project_id IS NULL OR TRIM(project_id) = ''"), '全局加载只取 project_id 为空的技能');
  ok(psSrc.includes('loadApprovedProjectSkills(db)'), '项目技能走项目作用域加载');
  ok(psSrc.includes('registerProjectSkill(r.project_id'), '迁移兜底只进项目作用域');

  const resSrc = fs.readFileSync(path.join(root, A, 'src/main/core/tools/resource.ts'), 'utf-8');
  ok(resSrc.includes('listSkillsForTask(projectId'), 'list_skills 走项目解析');
  ok(resSrc.includes('executeSkillForTask(projectId'), 'skill 走项目解析');

  const expSrc = fs.readFileSync(path.join(root, A, 'src/main/core/project-experience.ts'), 'utf-8');
  ok(!/from\s+'electron'|from\s+'node:http'|from\s+'node:https'|from\s+'node:net'/.test(expSrc), '经验派生零 electron/网络');
  ok(!/from\s+'ai'|generateText\s*\(|auxModelRequest|createSafeProvider/.test(expSrc), '经验派生零 LLM 调用');

  const pageSrc = fs.readFileSync(path.join(root, A, 'renderer/src/pages/ProjectDetailPage.tsx'), 'utf-8');
  ok(!/import\s+(?!type)[^;]*from\s+'[^']*project-experience\.js'/.test(pageSrc), '渲染层不运行期引经验派生模块');
  const ipcTSrc = fs.readFileSync(path.join(root, A, 'renderer/src/lib/ipc.ts'), 'utf-8');
  ok(/import\s+type\s+\{[^}]*ProjectExperience[^}]*\}\s+from\s+'[^']*project-experience\.js'/.test(ipcTSrc), '渲染层只类型引用经验派生');

  const dbSrc = fs.readFileSync(path.join(root, A, 'src/main/database.ts'), 'utf-8');
  ok(dbSrc.includes('PROJECT_SKILLS_DDL'), '生产建表引项目技能 DDL');
  const ddlSrc = fs.readFileSync(path.join(root, A, 'src/main/core/project-skills.ts'), 'utf-8');
  ok(ddlSrc.includes('UNIQUE (project_id, name)'), '项目技能表唯一约束在册');

  // 反证：生产 loadSkillsFromDb 不会把项目技能塞进全局
  const memoryMod = await import('../apps/worker-ant-desktop/src/main/core/memory-manager.js');
  const reg = await import('../apps/worker-ant-desktop/src/main/core/skill-registry.js');
  const db = mkdb();
  try {
    db.prepare("INSERT INTO wa_skills (id, name, description, category, config, status) VALUES ('g1','global_skill','G','custom','{}','approved')").run();
    db.prepare("INSERT INTO wa_project_skills (id, project_id, name, description, steps_json, status, source) VALUES ('pr1','p1','proj_skill','P','[\"一步\"]','approved','memory')").run();
    reg.clearProjectSkills();
    await (memoryMod.MemoryManager.prototype as unknown as { loadSkillsFromDb: (this: unknown) => Promise<number> }).loadSkillsFromDb.call({ db });
    const globalNames = reg.listSkills().map((s) => s.name);
    ok(globalNames.includes('global_skill'), '全局技能仍进全局');
    ok(!globalNames.includes('proj_skill'), '项目技能不进全局（反证）');
    ok(reg.listProjectSkills('p1').some((s) => s.name === 'proj_skill'), '项目技能进 p1 作用域');
    ok(!reg.listProjectSkills('p2').some((s) => s.name === 'proj_skill'), 'p2 看不到 p1 技能');
  } finally { try { db.close(); } catch { /* ignore */ } }
}

function skipRest(): void {
  // 本轮所有组均已实施；保留占位函数以便后续增组。
}

(async () => {
  await runA();
  await runB();
  await runC();
  await runD();
  await runE();
  await runF();
  await runG();
  skipRest();

  {
    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
    const src = fs.readFileSync(path.join(root, A, 'src/main/core/agent-executor.ts'), 'utf-8');
    const m = /build:\s*'(zx_\d{8}(?:_\d+)?)'/.exec(src);
    const tag = m?.[1] ?? '';
    ok(buildNotOlderThan(tag, SELF.replace(/^rr_/, '')), 'build 不早于本套件轮次', `${tag} vs ${SELF}`);
    ok(fs.existsSync(path.join(root, 'plans/improve', `${SELF.replace(/^rr_/, '')}.md`)), '本轮方案文件在场');
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  if (fail > 0) process.exitCode = 1;
})();
