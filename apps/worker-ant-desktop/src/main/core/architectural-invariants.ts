/**
 * B4: 架构不变量自动校验。
 * "逻辑必须照顾自己"（逻辑哲学论·5.473）——系统应能验证自身完整性。
 */

/**
 * @layer domain — 领域层（内因）— 决定系统"是什么"的核心：Agent引擎、任务管理、记忆系统、事件溯源
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createLogger } from './logger.js';
import { imChannelEnabledSql } from './im/im-channel-status.js';
import { PAUSE_REASON_STALE_TIMEOUT } from './pause-reason.js';
import { pauseTask } from './pause-task.js';
// zx_20260930 M14-4: error 级违规**要通知，不能只 log**（`notification-core` 是零 electron 的通知核，
//   故本模块直引它仍可被受控回归跑真实现——同 `self-healing-monitor` 的处置）。
import { recordNotification } from './notification-core.js';
// zx_20260930 M8: 墓碑哨兵取自**一处真源**——记忆引用完整性自检须把墓碑排除在"孤儿"之外
//   （理由见该判据内的注记：随项目删除落下的墓碑刻意保留 project_id 作为出处）。
import { MEM_TYPE_DELETED } from './memory-lifecycle.js';
// zx_20261022_2 批二: 两种时刻写法先归一，再与 `datetime('now', …)` 比。
import { utcSql } from './sql-time.js';

const logger = createLogger('invariants');

/** 运维看板展示用：该不变量项的可修复性说明（autoFixable=true 才给「修复」按钮） */
export interface InvariantRemediation {
  autoFixable: boolean;
  guidance: string;
  fixLabel?: string;
}

export interface InvariantResult {
  name: string;
  description: string;
  passed: boolean;
  severity: 'error' | 'warning';
  violations: Array<{ entity: string; detail: string }>;
  checkedAt: string;
  /** 附加到诊断结果下发的修复指引（供运维看板渲染按钮/文案） */
  remediation?: InvariantRemediation;
}

type InvariantCheck = (db: Database.Database) => Omit<InvariantResult, 'checkedAt'>;

/** B4: 所有架构不变量定义 */
const INVARIANTS: InvariantCheck[] = [
  // 1. 任务已完成→必须有finalize_task调用记录或task.completed事件
  (db) => {
    const name = 'task-completion-audit';
    const tasks = db.prepare(
      "SELECT id, title FROM wa_tasks WHERE status = 'completed' AND id NOT IN (SELECT DISTINCT aggregate_id FROM wa_event_log WHERE event_type IN ('task.completed','task.status_changed'))"
    ).all() as Array<{ id: string; title: string }>;
    return {
      name, description: '已完成任务必须有对应事件记录',
      passed: tasks.length === 0, severity: 'warning' as const,
      violations: tasks.map(t => ({ entity: t.id.slice(0,8), detail: t.title })),
    };
  },

  // 2. 产出物文件存在性
  (db) => {
    const name = 'deliverable-file-exists';
    const deliverables = db.prepare(
      "SELECT id, name, file_path FROM wa_deliverables WHERE status IN ('registered','generated') AND file_path IS NOT NULL AND file_path != ''"
    ).all() as Array<{ id: string; name: string; file_path: string }>;
    const violations = deliverables.filter(d => {
      if (d.file_path.startsWith('http://') || d.file_path.startsWith('https://')) return false;
      try { return !fs.existsSync(d.file_path); } catch { return true; }
    });
    return {
      name, description: '已注册/生成的产出物文件必须存在',
      passed: violations.length === 0, severity: 'warning' as const,
      violations: violations.map(d => ({ entity: d.name, detail: d.file_path })),
    };
  },

  // 3. 无孤儿任务（执行中超过24小时）
  (db) => {
    const name = 'stale-executing-tasks';
    const tasks = db.prepare(
      `SELECT id, title, updated_at FROM wa_tasks WHERE status IN ('executing','preparing') AND ${utcSql('updated_at')} < datetime('now', '-24 hours')`
    ).all() as Array<{ id: string; title: string; updated_at: string }>;
    return {
      name, description: '执行/准备中的任务不应超过24小时',
      passed: tasks.length === 0, severity: 'warning' as const,
      violations: tasks.map(t => ({ entity: t.id.slice(0,8), detail: `${t.title} (since ${t.updated_at})` })),
    };
  },

  // 4. IM渠道状态一致性
  (db) => {
    const name = 'im-channel-consistency';
    // M6：口径＝「启用中」（真源见 core/im/im-channel-status.ts）。旧谓词 `status = 'active'` 现义已是
    // 「启用但**无适配器**」，支持的类型跑起来是 'running'/'degraded' ⇒ 旧谓词对本不变量要防的
    // 「同类型两个在跑实例」恒不触发（长期空转）。
    const duplicates = db.prepare(
      `SELECT channel_type, COUNT(*) as cnt FROM wa_im_channels WHERE ${imChannelEnabledSql()} GROUP BY channel_type HAVING cnt > 1`
    ).all() as Array<{ channel_type: string; cnt: number }>;
    return {
      name, description: '同类型IM渠道不应有多个已启用实例',
      passed: duplicates.length === 0, severity: 'error' as const,
      violations: duplicates.map(d => ({ entity: d.channel_type, detail: `${d.cnt}个已启用实例` })),
    };
  },

  // 5. 对话记录引用完整性
  (db) => {
    const name = 'conversation-task-integrity';
    const orphans = db.prepare(
      "SELECT c.id, c.task_id FROM wa_task_conversations c LEFT JOIN wa_tasks t ON c.task_id = t.id WHERE t.id IS NULL LIMIT 20"
    ).all() as Array<{ id: string; task_id: string }>;
    return {
      name, description: '对话记录必须引用存在的任务',
      passed: orphans.length === 0, severity: 'error' as const,
      violations: orphans.map(c => ({ entity: c.id.slice(0,8), detail: `引用不存在的任务${c.task_id.slice(0,8)}` })),
    };
  },

  // 6. 记忆引用完整性
  (db) => {
    const name = 'memory-project-integrity';
    // zx_20260930 M8: **墓碑不算孤儿**。随项目删除落下的墓碑**刻意保留** project_id 作为出处
    //   （否则"这份记忆随哪个项目走的"就查不到了），而项目行此时已不存在 ⇒ 它天然"指向不存在的项目"。
    //   不排除则自愈的修复动作会把刚落下的墓碑**再物理删一次**，M8 的留痕当场作废（且每轮自检恒红）。
    const orphans = db.prepare(
      "SELECT m.id, m.project_id FROM wa_memories m LEFT JOIN wa_projects p ON m.project_id = p.id WHERE p.id IS NULL AND m.project_id IS NOT NULL AND m.project_id != '' AND m.memory_type != ? LIMIT 20"
    ).all(MEM_TYPE_DELETED) as Array<{ id: string; project_id: string }>;
    return {
      name, description: '记忆必须引用存在的项目',
      passed: orphans.length === 0, severity: 'warning' as const,
      violations: orphans.map(m => ({ entity: m.id.slice(0,8), detail: `引用不存在的项目${m.project_id.slice(0,8)}` })),
    };
  },

  // 7. 事件日志连续性（无id跳变，粗略检查）
  (db) => {
    const name = 'event-log-continuity';
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM wa_event_log').get() as { cnt: number }).cnt;
    const maxId = (db.prepare('SELECT MAX(id) as maxId FROM wa_event_log').get() as { maxId: number | null }).maxId ?? 0;
    const gapPct = count > 0 ? ((maxId - count) / maxId) * 100 : 0;
    return {
      name, description: '事件日志ID应连续（跳变<5%）',
      passed: gapPct < 5, severity: 'warning' as const,
      violations: gapPct >= 5 ? [{ entity: 'wa_event_log', detail: `ID跳变${gapPct.toFixed(1)}%，count=${count}, maxId=${maxId}` }] : [],
    };
  },

  // 8. 项目下任务状态分布合理性（active项目不应全部失败）
  (db) => {
    const name = 'project-task-health';
    const projects = db.prepare(
      "SELECT id, name FROM wa_projects WHERE status = 'active'"
    ).all() as Array<{ id: string; name: string }>;
    const violations: Array<{ entity: string; detail: string }> = [];
    for (const p of projects) {
      const stats = db.prepare(
        "SELECT COUNT(*) as total, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed FROM wa_tasks WHERE project_id = ?"
      ).get(p.id) as { total: number; failed: number };
      if (stats.total > 5 && stats.failed / stats.total > 0.8) {
        violations.push({ entity: p.name, detail: `${stats.failed}/${stats.total}失败(失败率${((stats.failed/stats.total)*100).toFixed(0)}%)` });
      }
    }
    return {
      name, description: '活跃项目的任务失败率不应超过80%',
      passed: violations.length === 0, severity: 'warning' as const,
      violations,
    };
  },
];

/** B4: 每项不变量对应的运维指引与可修复性（供运维看板渲染「修复」按钮/文案） */
export const INVARIANT_REMEDIATION: Record<string, InvariantRemediation> = {
  'task-completion-audit': {
    autoFixable: true, fixLabel: '补全完成事件',
    guidance: '为状态已 completed 但 event_log 缺 task.completed 记录的任务回填审计事件（occurred_at 取任务完成时间），审计链补全。',
  },
  'deliverable-file-exists': {
    autoFixable: false,
    guidance: '产出物文件在磁盘上不存在：请在原路径重新生成/恢复文件，或编辑该产出物修正 file_path。系统不自动删除产出物记录。',
  },
  'stale-executing-tasks': {
    autoFixable: true, fixLabel: '暂停滞留任务',
    guidance: '将执行/准备中超 24 小时仍未结束的任务复位为 paused（与系统启动清理逻辑一致），解除卡死占用。',
  },
  'im-channel-consistency': {
    autoFixable: false,
    guidance: '同类型 IM 渠道有多个已启用实例，可能致消息分发重复：请在「IM 集成」保留一个已启用渠道并下线多余实例。涉及运行渠道不自动改动。',
  },
  'conversation-task-integrity': {
    autoFixable: true, fixLabel: '清理孤儿对话',
    guidance: '删除引用已不存在任务的对话记录（任务已删、其会话成孤儿）。',
  },
  'memory-project-integrity': {
    autoFixable: true, fixLabel: '清理孤儿记忆',
    guidance: '删除引用已不存在项目的记忆（删除项目后残留/临时验证数据）。',
  },
  'event-log-continuity': {
    autoFixable: false,
    guidance: '事件日志 ID 跳变多由事务回滚/导入产生，不影响使用，可忽略，无需修复。',
  },
  'project-task-health': {
    autoFixable: false,
    guidance: '该项目任务失败率过高，属业务信号：请到「项目/任务」排查失败任务原因。系统不自动删改任务。',
  },
};

const DEFAULT_REMEDIATION: InvariantRemediation = { autoFixable: false, guidance: '该项无自动修复，请结合违规明细人工排查。' };

/** B4: 运行所有不变量检查 */
export function runAllInvariants(db: Database.Database): InvariantResult[] {
  const results: InvariantResult[] = [];
  for (const check of INVARIANTS) {
    try {
      const result = check(db);
      results.push({ ...result, remediation: INVARIANT_REMEDIATION[result.name] ?? DEFAULT_REMEDIATION, checkedAt: new Date().toISOString() });
      if (!result.passed) {
        logger.warn({ invariant: result.name, violations: result.violations.length }, `不变量违规: ${result.description}`);
      }
    } catch (err) {
      results.push({
        name: 'unknown', description: 'invariant check failed', passed: false, severity: 'error',
        violations: [{ entity: 'system', detail: (err as Error).message }],
        checkedAt: new Date().toISOString(),
      });
    }
  }
  const failed = results.filter(r => !r.passed);
  logger.info({ total: results.length, passed: results.length - failed.length, failed: failed.length }, '架构不变量检查完成');
  return results;
}

/**
 * B4: 自动修复某个可修复的不变量违规（幂等、单事务）。
 * 仅支持 INVARIANT_REMEDIATION[].autoFixable=true 的项；不可自动修复项抛错，由界面只读指引。
 */
export function repairInvariant(db: Database.Database, name: string): { name: string; repaired: number; detail: string } {
  const run = db.transaction((): { repaired: number; detail: string } => {
    switch (name) {
      case 'task-completion-audit': {
        const rows = db.prepare(
          "SELECT id, project_id, aggregate_version, updated_at FROM wa_tasks WHERE status = 'completed' AND id NOT IN (SELECT DISTINCT aggregate_id FROM wa_event_log WHERE event_type IN ('task.completed','task.status_changed'))"
        ).all() as Array<{ id: string; project_id: string; aggregate_version: number | null; updated_at: string }>;
        if (rows.length === 0) return { repaired: 0, detail: '无待回填任务' };
        const ins = db.prepare(
          "INSERT INTO wa_event_log (event_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, metadata, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        );
        for (const t of rows) {
          ins.run(
            crypto.randomUUID(), 'task.completed', 'task', t.id, t.aggregate_version ?? 0,
            JSON.stringify({ taskId: t.id, task_id: t.id, projectId: t.project_id }),
            JSON.stringify({ source: 'audit-backfill' }),
            `${t.updated_at.replace(' ', 'T')}Z`, new Date().toISOString().slice(0, 19).replace('T', ' '),
          );
        }
        return { repaired: rows.length, detail: `已回填 ${rows.length} 条 task.completed 审计事件` };
      }
      case 'stale-executing-tasks': {
        // zx_20260917 M1: 先取 id 列表，再逐条走 `pauseTask`（唯一写入口）——
        // 批量 UPDATE 既落不下「因」，也补不齐事件；逐条写则状态/因/事件一次写全。
        const stale = db.prepare(`SELECT id FROM wa_tasks WHERE status IN ('executing','preparing') AND ${utcSql('updated_at')} < datetime('now', '-24 hours')`).all() as Array<{ id: string }>;
        for (const t of stale) {
          pauseTask(db, { taskId: t.id, reason: PAUSE_REASON_STALE_TIMEOUT });
        }
        return { repaired: stale.length, detail: `已暂停 ${stale.length} 个滞留执行/准备任务` };
      }
      case 'conversation-task-integrity': {
        const r = db.prepare('DELETE FROM wa_task_conversations WHERE task_id NOT IN (SELECT id FROM wa_tasks)').run();
        return { repaired: r.changes, detail: `已清理 ${r.changes} 条孤儿对话` };
      }
      case 'memory-project-integrity': {
        // zx_20260930 M8: 与上面的判据**同一把尺**——墓碑不在此列（它们是**去处**，不是孤儿）。
        //   此处仍是物理删：真孤儿（非墓碑）的 project_id 指向一个**从未/已不**存在的项目，
        //   "去向"无所依附，留一行空正文的墓碑也不会让任何读取点收敛。
        const r = db.prepare("DELETE FROM wa_memories WHERE project_id IS NOT NULL AND project_id != '' AND project_id NOT IN (SELECT id FROM wa_projects) AND memory_type != ?").run(MEM_TYPE_DELETED);
        return { repaired: r.changes, detail: `已清理 ${r.changes} 条孤儿记忆（墓碑不计）` };
      }
      default:
        throw new Error(`「${name}」不支持自动修复，请按指引人工处理`);
    }
  });
  return { name, ...run() };
}

/**
 * 「架构不变量 error 级」通知的**类型名**（zx_20260930 M14-4）。
 * 一处真源：写在这里，回归与界面都从这引，不各抄一份字面量（`wa_notifications.type` 的取值域）。
 */
export const ARCH_INVARIANT_ERROR_NOTIFICATION_TYPE = 'arch_invariant_error';

/** B4: 运行启动时自检，仅报告error级别违规 */
export function startupSelfCheck(db: Database.Database): void {
  const results = runAllInvariants(db);
  const errors = results.filter(r => !r.passed && r.severity === 'error');
  if (errors.length > 0) {
    logger.error({ errors: errors.map(e => e.name), count: errors.length }, '启动自检发现严重架构违规！');
    // zx_20260930 M14-4（观卦「观国之光」）：**只写日志 ⇒ 这件事到不了用户眼前**（日志要人主动去翻）。
    //   通知里**点名是哪几项、第一处明细**——不写一句笼统的"自检失败"（那样用户只知道"有事"，
    //   不知道"什么事"，等于把判断成本又推回给人）。
    recordNotification(db, {
      type: ARCH_INVARIANT_ERROR_NOTIFICATION_TYPE,
      title: `架构不变量违规 ${errors.length} 项`,
      body: errors
        .map(e => `${e.name}：${e.description}${e.violations[0] ? `（${e.violations[0].detail}）` : ''}`)
        .join('；'),
    });
  }
  const warnings = results.filter(r => !r.passed && r.severity === 'warning');
  if (warnings.length > 0) {
    logger.warn({ warnings: warnings.map(w => w.name), count: warnings.length }, '启动自检发现架构警告');
  }
}
