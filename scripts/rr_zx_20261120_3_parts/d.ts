/**
 * zx_20261120_3 D 组「积·技」——可调用岗位技能。
 *
 * 归属：M4。断言口径：
 *   · 草案→审批→注册；未批准不可见/不可调用；
 *   · 按岗位收窄（另一岗位看不到）；同名岗位优先于全局；
 *   · 包 v2 导出已批准、导入落草案；v1 旧包可导入；
 *   · 团队预览带“可调用技能”；岗位块只列名字。
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { RrHarness } from '../rr_zx_20261120_3.js';
import { stripKeepingLines } from '../lib/rr-pins.js';
import { positionBlockDetail } from '../../apps/worker-ant-desktop/src/main/core/positions.js';
import {
  approvedPositionSkillNames,
  createPositionSkillDraft,
  decidePositionSkill,
  listPositionSkills,
  recordPositionSkillUse,
} from '../../apps/worker-ant-desktop/src/main/core/position-skills.js';
import { getPositionSkillDefinition, listSkillsForPosition, registerSkill, unregisterSkill } from '../../apps/worker-ant-desktop/src/main/core/skill-registry.js';
import { buildPositionPackage, importPositionPackage, parsePositionPackage } from '../../apps/worker-ant-desktop/src/main/core/position-package.js';
import { previewTeamBody } from '../../apps/worker-ant-desktop/src/main/core/team-library.js';

function mkPos(db: Database.Database, id: string, name: string): void {
  db.prepare(
    `INSERT INTO wa_positions (id, name, category, description, skills_json, rules_json, knowledge_json, enabled, builtin, version)
     VALUES (?, ?, 'tech', '说明', '[]', '[]', '[]', 1, 0, 1)`,
  ).run(id, name);
  db.prepare('INSERT INTO wa_project_positions (project_id, position_id, enabled) VALUES (?, ?, 1)').run('p', id);
}

export function runD(h: RrHarness): void {
  const root = h.root;

  // ── D1 草案：创建/去重/校验 ───────────────────────────────────────────
  {
    const db = h.mkdb();
    mkPos(db, 'pos_skill', '技能岗');
    const c = createPositionSkillDraft(db, { positionId: 'pos_skill', name: 'oss_upload', description: '上传到 OSS', steps: ['读配置', '上传', '回读校验'] });
    h.eq(c.ok, true, 'D1 草案创建成功');
    if (c.ok) h.eq([c.skill.status, c.skill.steps.length], ['draft', 3], 'D1 状态=draft、步骤三条');
    const dup = createPositionSkillDraft(db, { positionId: 'pos_skill', name: 'oss_upload', steps: ['x'] });
    h.ok(!dup.ok && dup.code === 'DUPLICATE', 'D1 同岗位同名去重', JSON.stringify(dup));
    const empty = createPositionSkillDraft(db, { positionId: 'pos_skill', name: 'empty', steps: [] });
    h.ok(!empty.ok && empty.code === 'BAD_INPUT', 'D1 空步骤被拒');
    const tooLong = createPositionSkillDraft(db, { positionId: 'pos_skill', name: 'x'.repeat(41), steps: ['a'] });
    h.ok(!tooLong.ok && tooLong.code === 'BAD_INPUT', 'D1 名称超长被拒');
  }

  // ── D2 审批→按岗位可见/可调用；未批准不可见 ───────────────────────────
  {
    const db = h.mkdb();
    mkPos(db, 'pos_a', '甲技能岗');
    mkPos(db, 'pos_b', '乙技能岗');
    const c = createPositionSkillDraft(db, { positionId: 'pos_a', name: 'deploy_step', description: '部署', steps: ['构建', '发布'] });
    if (!c.ok) throw new Error('D2 setup failed');
    h.eq(listPositionSkills('pos_a').length, 0, 'D2 草案未注册（岗位注册表 0）');
    h.ok(!listSkillsForPosition('pos_a').some((s) => s.name === 'deploy_step'), 'D2 草案不出现在技能清单');
    const ap = decidePositionSkill(db, c.skill.id, 'approved');
    h.eq(ap.ok, true, 'D2 批准成功');
    const def = getPositionSkillDefinition('pos_a', 'deploy_step');
    h.ok(!!def && def.content === '构建\n发布', 'D2 已注册且内容是步骤文本', def?.content);
    const listA = listSkillsForPosition('pos_a');
    h.ok(listA.some((s) => s.name === 'deploy_step' && s.category === 'position'), 'D2 本岗位可见');
    const listB = listSkillsForPosition('pos_b');
    h.ok(!listB.some((s) => s.name === 'deploy_step'), 'D2 他岗位不可见');
  }

  // ── D3 使用计数 0→1 ───────────────────────────────────────────────────
  {
    const db = h.mkdb();
    mkPos(db, 'pos_u', '计数岗');
    const c = createPositionSkillDraft(db, { positionId: 'pos_u', name: 'count_me', steps: ['一步'] });
    if (!c.ok) throw new Error('D3 setup failed');
    const before = listPositionSkills(db, 'pos_u')[0]!;
    h.eq(before.useCount, 0, 'D3 起步 0 次');
    recordPositionSkillUse(db, { id: c.skill.id }, '2026-11-20T12:00:00.000Z');
    const after = listPositionSkills(db, 'pos_u')[0]!;
    h.eq(after.useCount, 1, 'D3 0→1');
    h.eq(after.lastUsedAt, '2026-11-20T12:00:00.000Z', 'D3 记录最近使用时刻');
  }

  // ── D4 同名：岗位优先于全局 ───────────────────────────────────────────
  {
    const db = h.mkdb();
    mkPos(db, 'pos_shadow', '同名岗');
    registerSkill({ name: 'same_name', description: '全局', category: 'custom', content: '全局内容' });
    const c = createPositionSkillDraft(db, { positionId: 'pos_shadow', name: 'same_name', description: '岗位', steps: ['岗位内容'] });
    if (!c.ok) throw new Error('D4 setup failed');
    decidePositionSkill(db, c.skill.id, 'approved');
    const list = listSkillsForPosition('pos_shadow').filter((s) => s.name === 'same_name');
    h.eq(list.length, 1, 'D4 同名只显示一条');
    h.eq(list[0]?.category, 'position', 'D4 岗位优先');
    h.eq(getPositionSkillDefinition('pos_shadow', 'same_name')?.content, '岗位内容', 'D4 执行取岗位内容');
    unregisterSkill('same_name');
  }

  // ── D5 包 v2：导出已批准、导入落草案；v1 兼容 ─────────────────────────
  {
    const db = h.mkdb();
    mkPos(db, 'pos_pkg', '打包岗');
    const c = createPositionSkillDraft(db, { positionId: 'pos_pkg', name: 'pack_skill', description: '包内技能', steps: ['a', 'b'] });
    if (!c.ok) throw new Error('D5 setup failed');
    decidePositionSkill(db, c.skill.id, 'approved');
    createPositionSkillDraft(db, { positionId: 'pos_pkg', name: 'draft_only', steps: ['x'] });
    const built = buildPositionPackage(db, 'pos_pkg');
    h.eq(built.ok, true, 'D5 包可导出');
    if (!built.ok) return;
    h.eq(built.value.package.version, 2, 'D5 版本=2');
    h.eq(built.value.package.positionSkills?.map((s) => s.name), ['pack_skill'], 'D5 只导出已批准技能');
    const parsed = parsePositionPackage(JSON.stringify(built.value.package));
    h.eq(parsed.ok, true, 'D5 v2 可解析');
    if (parsed.ok) {
      const db2 = h.mkdb();
      const imported = importPositionPackage(db2, parsed.value, 'merge', 'pkg.json');
      h.eq(imported.ok, true, 'D5 v2 可导入');
      if (imported.ok) {
        h.eq([imported.value.addedSkills, imported.value.skippedSkills], [1, 0], 'D5 导入 1 条技能');
        const sk = listPositionSkills(db2, imported.value.position.id);
        h.eq(sk.map((s) => [s.name, s.status]), [['pack_skill', 'draft']], 'D5 导入落 draft（不自动批准）');
      }
    }
    const v1 = { ...built.value.package, version: 1 } as Record<string, unknown>;
    delete v1.positionSkills;
    const p1 = parsePositionPackage(JSON.stringify(v1));
    h.eq(p1.ok, true, 'D5 v1 旧包仍可解析');
    if (p1.ok) h.eq(p1.value.positionSkills ?? [], [], 'D5 v1 无技能为空');
  }

  // ── D6 团队预览 + 岗位块技能行 ────────────────────────────────────────
  {
    const db = h.mkdb();
    mkPos(db, 'pos_prev', '预览岗');
    const c = createPositionSkillDraft(db, { positionId: 'pos_prev', name: 'prev_skill', description: '看得见', steps: ['一步'] });
    if (!c.ok) throw new Error('D6 setup failed');
    decidePositionSkill(db, c.skill.id, 'approved');
    const names = approvedPositionSkillNames(db, 'pos_prev');
    h.eq(names, ['prev_skill'], 'D6 已批准技能名可读');
    const block = positionBlockDetail({ name: '预览岗', description: '', rules: [], skills: [], knowledge: [] }, [], undefined, names);
    h.ok(block.text.includes('可调用技能（用 skill 工具）：prev_skill'), 'D6 岗位块列出可调用技能', block.text);
    const noSkills = positionBlockDetail({ name: '预览岗', description: '', rules: [], skills: [], knowledge: [] }, []);
    h.ok(!noSkills.text.includes('可调用技能'), 'D6 无技能时旧文案不变');

    const built = buildPositionPackage(db, 'pos_prev');
    if (built.ok) {
      const pv = previewTeamBody('position', '预览岗', {
        position: built.value.package.position,
        lessons: built.value.package.lessons,
        positionSkills: built.value.package.positionSkills,
      });
      h.ok(pv.sections.some((s) => s.label.startsWith('可调用技能')), 'D6 团队预览含可调用技能节');
    }
  }

  // ── D7 静态接线 ───────────────────────────────────────────────────────
  {
    const read = (rel: string): string => stripKeepingLines(fs.readFileSync(path.join(root, rel), 'utf-8')).join('\n');
    const res = read('apps/worker-ant-desktop/src/main/core/tools/resource.ts');
    // zx_20261121_1 M2：工具改走「岗位 > 项目 > 全局」统一解析；按**更强符号**重定向
    //   （仍钉岗位优先与岗位使用账，且额外钉到注册表里的唯一解析入口）。
    const reg = read('apps/worker-ant-desktop/src/main/core/skill-registry.ts');
    h.ok(res.includes('listSkillsForTask(projectId') && res.includes('executeSkillForTask(projectId')
      && res.includes('recordPositionSkillUse') && reg.includes('listSkillsForTask(') && reg.includes('executeSkillForTask('),
      'D7 工具按岗位列/执行/记使用（岗位优先的解析入口在册）');
    const main = read('apps/worker-ant-desktop/src/main/index.ts');
    h.ok(main.includes('loadApprovedPositionSkills'), 'D7 启动加载已批准岗位技能');
    const dbSrc = read('apps/worker-ant-desktop/src/main/database.ts');
    h.ok(dbSrc.includes('POSITION_SKILLS_DDL'), 'D7 建表接在 initDatabase');
    const ipc = read('apps/worker-ant-desktop/src/main/ipc/positions.ipc.ts');
    h.ok(ipc.includes("positions:skillCreate") && ipc.includes("positions:skillDecide") && ipc.includes("positions:skills"),
      'D7 IPC 三跳在册');
  }
}
