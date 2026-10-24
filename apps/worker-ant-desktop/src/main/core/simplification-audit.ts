/**
 * P1.6 无用之用——架构简化审查（从原工蚁 simplification-audit.ts 移植）。
 * 识别未引用的表/配置，检测重复逻辑，生成简化建议。
 *
 * zx_20260924_1 M6（F7「写下的报表，要有人读」）：本模块此前**只写不读**——跑完把报告 INSERT 进
 * `wa_simplification_reports` 就完事，桌面端零 SELECT（全仓唯一读者在已归档的旧 worker-ant-server）。
 * 现补上**读取面** `readLatestSimplificationReport()`：由 `admin:diagnostics`（唯一真源出口）取用，
 * 送 Dashboard「架构诊断」页。**读函数写在这里而不是 admin.ipc.ts**：那个文件顶层 `import { ipcMain } from 'electron'`，
 * 受控回归 import 不起来 ⇒ 写在那里等于"没有判据可写"（本仓对"接上了但要靠目视证明"的一贯处置）。
 * 审查规则（tables/staleJobs/orphanFiles/emptyCron 四条）**一行未动**，动的只是"产出 → 可见"这条断线，外加保留策略。
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';
import fs from 'node:fs';
import path from 'node:path';

const logger = createLogger('simplify');

interface SimplificationFinding {
  type: 'unused_route' | 'deprecated_api' | 'duplicate_logic' | 'dead_config';
  location: string;
  severity: 'low' | 'medium' | 'high';
  description: string;
  suggestion: string;
}

/**
 * 保留上限：周期性审查（每小时）会让报表无限长 ⇒ 只留最近 KEEP 条，更早的删除。
 * 「记账的纪律」：报表是**快照**不是**流水**，越旧的架构快照越没有参考价值，留着只会把库撑长；
 * 上限只此一处（写入侧 prune 与读取侧注释同源），改这里即全局生效。
 */
export const SIMPLIFICATION_REPORT_KEEP = 50;

/** 一行报告解析后的形状（键名与 DB 列**同名**，避免两处各起名后对不上）。 */
export interface SimplificationReport {
  id: string;
  findings: SimplificationFinding[];
  /** 与 findings 逐项对得上的严重度计数；列本身是坏 JSON 时为 `null`（**不编数、也不当空**）。 */
  severity_counts: { high: number; medium: number; low: number } | null;
  created_at: string;
  /** 非空 ⇒ 该行的某个 JSON 列未能解析（如实告知；"解析不了"与"没有发现项"不是一回事） */
  parse_error: string | null;
}

/**
 * 读取**最近一次**架构简化审查报告。
 *
 * 三种状态**各说各话**（不许以空白冒充"一切正常"）：
 *  - 从未跑过审查（表都不存在）或表空 ⇒ `null`（空集是合法状态，不抛）
 *  - 正常一行 ⇒ 解析出 findings / severity_counts
 *  - JSON 列坏了 ⇒ 仍返回这一行（`created_at` 如实），但 `findings: []` + `parse_error` 非空
 */
export function readLatestSimplificationReport(db: Database.Database): SimplificationReport | null {
  let row: { id: string; findings: string | null; severity_counts: string | null; created_at: string } | undefined;
  try {
    row = db.prepare(
      'SELECT id, findings, severity_counts, created_at FROM wa_simplification_reports ORDER BY created_at DESC, rowid DESC LIMIT 1',
    ).get() as typeof row;
  } catch {
    return null; // 表尚未建（此前从未跑过审查）＝合法空集，不是错误
  }
  if (!row) return null;

  let findings: SimplificationFinding[] = [];
  let parseError: string | null = null;
  try {
    const raw = JSON.parse(String(row.findings ?? ''));
    if (Array.isArray(raw)) findings = raw as SimplificationFinding[];
    else parseError = 'findings 不是数组';
  } catch (e) {
    parseError = `findings 解析失败：${(e as Error).message}`;
  }

  let severityCounts: SimplificationReport['severity_counts'] = null;
  try {
    const c = JSON.parse(String(row.severity_counts ?? '')) as Record<string, unknown> | null;
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      severityCounts = { high: Number(c.high) || 0, medium: Number(c.medium) || 0, low: Number(c.low) || 0 };
    } else {
      parseError = `${parseError ? `${parseError}；` : ''}severity_counts 不是对象`;
    }
  } catch (e) {
    parseError = `${parseError ? `${parseError}；` : ''}severity_counts 解析失败：${(e as Error).message}`;
  }

  return { id: String(row.id), findings, severity_counts: severityCounts, created_at: String(row.created_at ?? ''), parse_error: parseError };
}

/**
 * 保留策略：只留最近 `keep` 条，更早的删除（同秒写入时以 rowid 兜底定序，保证删的一定是更早写入的）。
 * best-effort：清账失败不影响本次审查结论。
 */
function pruneSimplificationReports(db: Database.Database, keep = SIMPLIFICATION_REPORT_KEEP): void {
  try {
    db.prepare(
      `DELETE FROM wa_simplification_reports WHERE id NOT IN (
         SELECT id FROM wa_simplification_reports ORDER BY created_at DESC, rowid DESC LIMIT ?
       )`,
    ).run(keep);
  } catch { /* best-effort */ }
}

export function runSimplificationAudit(db: Database.Database): SimplificationFinding[] {
  const findings: SimplificationFinding[] = [];

  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'ans_%' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'wa_%' AND name NOT LIKE '%_fts%'").all() as Array<{ name: string }>;
    for (const t of tables) {
      findings.push({ type: 'dead_config', location: `DB表: ${t.name}`, severity: 'low', description: `非标准前缀的表: ${t.name}`, suggestion: `检查是否仍在使用，如未使用建议DROP TABLE ${t.name}` });
    }
  } catch { /* best-effort */ }

  try {
    const staleJobs = db.prepare("SELECT COUNT(*) as c FROM wa_jobs WHERE status IN ('failed','done') AND completed_at < datetime('now', '-7 days')").get() as { c: number };
    if (staleJobs.c > 10) {
      findings.push({ type: 'dead_config', location: 'wa_jobs', severity: 'medium', description: `${staleJobs.c}条已完成/失败作业记录超过7天`, suggestion: '建议定期清理30天前的已完成作业记录，减少DB膨胀' });
    }
  } catch { /* best-effort */ }

  try {
    const projects = db.prepare("SELECT id, name, working_dir FROM wa_projects WHERE working_dir IS NOT NULL AND working_dir != ''").all() as Array<{ id: string; name: string; working_dir: string }>;
    for (const proj of projects) {
      if (!fs.existsSync(proj.working_dir)) continue;
      try {
        const files = fs.readdirSync(proj.working_dir);
        const delivFiles = (db.prepare('SELECT file_path FROM wa_deliverables WHERE project_id = ?').all(proj.id) as Array<{ file_path: string }>).map(d => path.basename(d.file_path || ''));
        const orphanFiles = files.filter(f => !delivFiles.includes(f) && !f.startsWith('.'));
        if (orphanFiles.length > 3) {
          findings.push({ type: 'dead_config', location: `项目${proj.name}工作目录`, severity: 'low', description: `${orphanFiles.length}个文件未关联到任何产出物记录`, suggestion: '检查是否需要清理或注册为产出物' });
        }
      } catch { /* skip */ }
    }
  } catch { /* best-effort */ }

  try {
    const emptyCron = db.prepare("SELECT COUNT(*) as c FROM wa_projects WHERE (cron_schedule IS NULL OR cron_schedule = '') AND status IN ('active','paused')").get() as { c: number };
    if (emptyCron.c > 0) {
      findings.push({ type: 'dead_config', location: 'wa_projects', severity: 'low', description: `${emptyCron.c}个活跃/暂停项目未配置cron调度`, suggestion: '考虑为活跃项目设置cron或将其归档' });
    }
  } catch { /* best-effort */ }

  if (findings.length > 0) {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS wa_simplification_reports (id TEXT PRIMARY KEY, findings TEXT, severity_counts TEXT, created_at TEXT DEFAULT (datetime('now')))`);
      const severityCounts = { high: findings.filter(f => f.severity === 'high').length, medium: findings.filter(f => f.severity === 'medium').length, low: findings.filter(f => f.severity === 'low').length };
      db.prepare('INSERT INTO wa_simplification_reports (id, findings, severity_counts) VALUES (?, ?, ?)').run(randomUUID(), JSON.stringify(findings), JSON.stringify(severityCounts));
      // 写完即裁：报表是快照不是流水，留最近 KEEP 条（否则每小时一条会无限增长）
      pruneSimplificationReports(db);
      logger.info({ totalFindings: findings.length, ...severityCounts }, '[架构简化] 审查完成');
    } catch { /* best-effort */ }
  } else {
    // 无发现项时**不写行**（既有行为，未动）⇒ 读取面拿到的 `null` 有两种成因：
    // 「从未跑过审查」与「跑过但本次无发现」。界面空态须把这层如实说出来，不许把 null 一句读成"架构没问题"。
    logger.info('[架构简化] 审查完成，未发现问题');
  }
  return findings;
}
