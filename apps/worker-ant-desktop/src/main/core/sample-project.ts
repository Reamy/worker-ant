/**
 * zx_20261012_1 批四：**示例项目**——新用户「全面接触了解」的一键载入 / 一键删除 / 与真实数据隔离。
 *
 * 裁定（创始人 2026-10-12）：要。与 `biz_20261011 §3` 定案**不冲突**——§3 只说"**不做**独立功能导览页"，
 *   未否定示例内容。故本模块不建导览页，只种一份**真数据形态**的样例，让新用户跳过向导后
 *   在 Projects / Tasks / Deliverables / Memories 四个真页面上直接看到"工蚁干过活的样子"。
 *
 * ── 三件事，各一处真源 ────────────────────────────────────────────────────────
 *   ① **隔离**：示例项目在 `wa_projects.is_sample = 1`（迁移见 `database.ts`），真实项目恒 `0`。
 *      `project:list` 走 `SELECT *` ⇒ `is_sample` 自然流出，渲染层据它打「示例」徽标。
 *   ② **载入**（`installSampleProject`）：固定 id（`sample-…`）+ 直插范式（**非事件溯源**——
 *      `event-projectors.ts` 只订阅 `*.status_changed`，建项目本身无需写事件；同 `project:clone` 范式）。
 *      幂等：`sample` 项目已在 ⇒ 不重复种（返回 `created:false`）。
 *   ③ **删除**（`removeSampleProject`）：**只**删 `is_sample=1` **且** id 命中固定值的那一行
 *      （双闸，防误删用户数据）；级联走 `deleteProjectCascade`（与 `project:delete` **同一份 SQL**），
 *      另清磁盘 `<dataDir>/projects/<id>/` 与 `task_outputs/<task>`（均走 `removeProjectDataDir` 一处真源）。
 *
 * ⚠ 示例记忆一律 `source='user_correction'`（`user_*` 前缀）——绕开墓碑拦截（`storeText` 的机器写入闸
 *   只拦非 `user_*` 来源）。此处用直插（不经 `storeText`），同样带 `user_*` 来源，语义一致：
 *   "这些是**人工写好的**示例，不是机器重提取"。
 *
 * ⚠ zx_20261029_2 M6「堵空档」：示例项目**计入项目配额**——它就是一行真 `wa_projects`，
 *   "一个项目就是一个项目"，不因带 `is_sample=1` 而豁免。故载入前过 `projectQuotaRefusal`；
 *   社区档（上限 1）载入示例后用满名额，想建自己的项目须先一键删除示例（`removeSampleProject`）。
 *   这比"示例不计数"更诚实：否则社区档可长期持有一示例 + 一真项目，而价目表写的是 1 个。
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createDeliverable } from './deliverable-lifecycle.js';
import { deleteProjectCascade, removeProjectDataDir, resolveProjectOwnerId } from './project-engine.js';
import { projectQuotaRefusal } from './project-quota.js';

/** 配额不足时抛出（IPC 壳据此回 `PROJECT_QUOTA`，界面拿到的是**判据原文**，不是"操作失败"）。 */
export class SampleQuotaError extends Error {
  readonly code = 'PROJECT_QUOTA';
  constructor(message: string) { super(message); this.name = 'SampleQuotaError'; }
}

/** 示例项目的**固定 id**（删除只认它 + `is_sample=1`，双闸）。 */
export const SAMPLE_PROJECT_ID = 'sample-competitor-research';
/** 示例任务固定 id（产出物落盘目录按它命名）。 */
export const SAMPLE_TASK_IDS = ['sample-task-collect', 'sample-task-report'] as const;

/** 示例项目名（渲染层徽标与它无关，徽标认 `is_sample`；此处只是标题）。 */
const SAMPLE_PROJECT_NAME = '示例：竞品调研';

/** 示例记忆的固定 id。 */
const SAMPLE_MEMORY_IDS = ['sample-mem-1', 'sample-mem-2', 'sample-mem-3'] as const;

export interface SampleInstallResult { projectId: string; created: boolean }
export interface SampleRemoveResult { removed: boolean }

/** 示例调研报告的正文（落 `data/task_outputs/<task>/调研报告.md`）。 */
const REPORT_BODY = `# 竞品调研报告（示例）

> 这是一份**示例产出物**，用于演示工蚁的「任务 → 产出物 → 成果交付」链路。可直接删除，不影响真实数据。

## 一、调研范围

对三家同类产品（A / B / C）的功能矩阵做横向对比，重点看：

1. **核心能力**——各自解决的核心问题是否一致；
2. **协作形态**——单人工具还是多人协同；
3. **定价与门槛**——免费额度、按量还是包月。

## 二、主要结论

| 维度 | A | B | C |
| --- | --- | --- | --- |
| 核心能力 | 任务编排 | 资源调度 | 二者兼有 |
| 协作形态 | 单人 | 团队 | 团队 |
| 定价门槛 | 低 | 中 | 高 |

## 三、给我们的启示

- 差异化应落在**「算得清成本、看得见成果」**，而非再堆功能；
- 先做**单机可用**，协同（多机派活）作为第二阶段的**可选项**，而非前提。
`;

/**
 * 一键载入示例项目（幂等）。`dataDir` 为 dev/prod 数据根（`main/index.ts` 的真源）。
 * 返回创建结果；已存在则 `created:false` 且**不**触碰既有行（不"修复"、不覆盖）。
 */
export function installSampleProject(db: Database.Database, dataDir: string): SampleInstallResult {
  const existing = db.prepare('SELECT id FROM wa_projects WHERE id = ?').get(SAMPLE_PROJECT_ID) as { id: string } | undefined;
  if (existing) return { projectId: SAMPLE_PROJECT_ID, created: false };

  // 先闸后写：与 `project:create`/`project:clone`/IM 建项目**同一判据**（不因"示例"另开一条路）。
  const refusal = projectQuotaRefusal(db);
  if (refusal) throw new SampleQuotaError(refusal);

  const workingDir = path.join(dataDir, 'projects', SAMPLE_PROJECT_ID);
  try { fs.mkdirSync(workingDir, { recursive: true }); } catch { /* ignore */ }

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO wa_projects (id, name, description, status, cron_timezone, working_dir, owner_id, is_sample)
       VALUES (?, ?, ?, 'active', 'Asia/Shanghai', ?, ?, 1)`,
    ).run(
      SAMPLE_PROJECT_ID,
      SAMPLE_PROJECT_NAME,
      '一键载入的示例项目：演示「项目 → 任务 → 产出物 → 记忆」完整链路，可随时一键删除，与真实数据隔离。',
      workingDir,
      resolveProjectOwnerId(db),
    );

    // 两条**已完成**任务——让任务页/项目卡有"干过活"的样子。
    const insertTask = db.prepare(
      `INSERT INTO wa_tasks (id, project_id, title, description, status, source, context_json)
       VALUES (?, ?, ?, ?, 'completed', 'sample', '{}')`,
    );
    insertTask.run(SAMPLE_TASK_IDS[0], SAMPLE_PROJECT_ID, '收集三家竞品的功能清单', '按核心能力 / 协作形态 / 定价门槛三个维度整理功能矩阵。');
    insertTask.run(SAMPLE_TASK_IDS[1], SAMPLE_PROJECT_ID, '对比分析并输出调研报告', '汇总三方对比，给出差异化建议，产出《调研报告》。');

    // 示例记忆（`user_*` 来源，绕开机器写入墓碑闸）——记忆页可见"沉淀下来的经验"。
    const insertMem = db.prepare(
      `INSERT INTO wa_memories (id, project_id, content, memory_type, importance, source, reasoning, updated_at)
       VALUES (?, ?, ?, 'semantic', ?, 'user_correction', '', datetime('now'))`,
    );
    insertMem.run(SAMPLE_MEMORY_IDS[0], SAMPLE_PROJECT_ID, '竞品对比不要只列功能，要落到"我们的差异化落在哪"——功能清单本身不产生决策。', 0.7);
    insertMem.run(SAMPLE_MEMORY_IDS[1], SAMPLE_PROJECT_ID, '定价门槛是获客的第一道闸：免费额度太小，用户走不到体验核心能力那一步。', 0.6);
    insertMem.run(SAMPLE_MEMORY_IDS[2], SAMPLE_PROJECT_ID, '先做单机可用、协同后置——把协同当前提会让 MVP 永远发不出来。', 0.6);

    // 产出物：报告落盘 + 登记 `wa_deliverables`（经 `createDeliverable`，与手工登记同一把尺，status='draft'）。
    const reportDir = path.join(dataDir, 'task_outputs', SAMPLE_TASK_IDS[1]);
    try { fs.mkdirSync(reportDir, { recursive: true }); } catch { /* ignore */ }
    const reportPath = path.join(reportDir, '调研报告.md');
    try { fs.writeFileSync(reportPath, REPORT_BODY, 'utf-8'); } catch { /* ignore */ }
    createDeliverable(db, {
      projectId: SAMPLE_PROJECT_ID,
      taskId: SAMPLE_TASK_IDS[1],
      name: '调研报告.md',
      type: 'doc',
      description: '示例产出物：三家竞品的对比分析与差异化建议。',
      filePath: reportPath,
      via: 'sample:install',
    });
  });
  tx();
  return { projectId: SAMPLE_PROJECT_ID, created: true };
}

/**
 * 一键删除示例项目。**双闸**：id 必须命中固定值 **且** 行上 `is_sample=1`——任一不满足即拒（`removed:false`）。
 * 级联走 `deleteProjectCascade`（同一份 SQL）；另清磁盘 `<dataDir>/projects/<id>/` 与 `task_outputs/<task>`。
 * 项目不在 ⇒ `removed:false`（幂等，不报错）。
 */
export function removeSampleProject(db: Database.Database, dataDir: string): SampleRemoveResult {
  const row = db.prepare('SELECT id, is_sample FROM wa_projects WHERE id = ?').get(SAMPLE_PROJECT_ID) as
    | { id: string; is_sample?: number }
    | undefined;
  if (!row) return { removed: false };
  // 双闸：即便 id 恰好撞上，只要不是示例行，**一律不删**（用户数据的最后一道保险）。
  if (row.is_sample !== 1) return { removed: false };

  deleteProjectCascade(db, SAMPLE_PROJECT_ID);

  // 清盘：**只清工蚁自有的** `<dataDir>/projects/<id>/`（承 zx_20261012_3 批一「一处真源」）——
  //   ⚠ 不再按行上的 `working_dir` 删（那是"清错盘"的入口：`working_dir` 可指向用户代码仓）。
  //   示例项目的 `working_dir` 本就等于此目录（`installSampleProject` 如此置），故行为不变。
  removeProjectDataDir(dataDir, SAMPLE_PROJECT_ID);
  for (const tid of SAMPLE_TASK_IDS) {
    try { fs.rmSync(path.join(dataDir, 'task_outputs', tid), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return { removed: true };
}
