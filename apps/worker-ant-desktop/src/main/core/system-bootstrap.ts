/**
 * A3: 系统启动编排器。
 * 集中管理启动初始化序列，明确各步骤的职责和依赖关系。
 */

/**
 * @layer application — 应用层 — 编排领域对象完成用例：意图分类、技能注册、策略引擎、输出验证
 */
import type Database from 'better-sqlite3';
import type { AnsClient } from '@worker-ant/ans-client';
import type { TaskScheduler } from './task-scheduler.js';
import type { MemoryManager } from './memory-manager.js';
import type { EventBus } from './event-bus.js';
import type { EventStore } from './event-store.js';
import { registerAllJobs } from './jobs/index.js';
import { registerProjectors } from './event-projectors.js';
import { startupSelfCheck, runAllInvariants } from './architectural-invariants.js';
// zx_20260924_1 M6（F7）: 简化审查接进既有小时节拍（见 startPeriodicInvariantCheck 注释）
import { runSimplificationAudit } from './simplification-audit.js';
// zx_20261002 M12-3: 不变量结论留档（值变才写）——每小时这一拍是它**最稳定的**观测点。
import { logInvariantTransitions } from './self-healing-monitor.js';
import { createLogger } from './logger.js';

const logger = createLogger('bootstrap');

interface BootstrapDeps {
  db: Database.Database;
  ansClient: AnsClient;
  scheduler: TaskScheduler;
  memory: MemoryManager;
  eventBus: EventBus;
  eventStore: EventStore;
}

/** A3: 初始化A1事件溯源 + 作业处理器 */
export function initCoreServices(deps: BootstrapDeps): void {
  const { db, ansClient, scheduler, memory, eventBus, eventStore } = deps;

  // 1. 事件溯源
  eventBus.setEventStore(eventStore);
  registerProjectors(db, eventBus);
  logger.info('[A3 bootstrap] A1事件溯源就绪');

  // 2. 作业处理器
  registerAllJobs({ db, ansClient, scheduler, memory });
  logger.info('[A3 bootstrap] 作业处理器已注册');

  // 3. B4: 启动时架构不变量自检（延迟5s，等各组件完全就绪）
  setTimeout(() => {
    try {
      startupSelfCheck(db);
    } catch (err) {
      logger.warn({ err }, 'B4启动自检异常');
    }
  }, 5000);
  logger.info('[B4 bootstrap] 架构自检已排程(5s后)');
}

/**
 * B4: 启动定期架构不变量抽查（每小时一次）。
 *
 * zx_20260924_1 M6（F7）: 同一个小时节拍**顺带**跑架构简化审查——此前它只在启动时跑一次
 * （`main/index.ts` 那处 `import(...).then(...)`），报表停下来就不再更新。**复用这一个定时器，
 * 不新造第二套调度器**（两套节拍各自漂移是"同一件事两处做"的老病）。
 * 启动一次那处**保留不动**（首次报告不必等一小时）。
 * ⚠ `wa_simplification_reports` 由此变为周期增长 ⇒ 写入侧自带保留策略（见 `SIMPLIFICATION_REPORT_KEEP=50`）。
 */
export function startPeriodicInvariantCheck(db: Database.Database): NodeJS.Timeout {
  const timer = setInterval(() => {
    try {
      const results = runAllInvariants(db);
      // zx_20261002 M12-3: 结论留档（每项"变才写"）。与 `admin:diagnostics` 那处**同一实现**——
      //   判据同一把尺，只是观测节拍不同（一小时 vs 用户开页）。
      logInvariantTransitions(db, results);
    } catch (err) {
      logger.warn({ err }, 'B4定期抽查异常');
    }
    try {
      runSimplificationAudit(db);
    } catch (err) {
      logger.warn({ err }, '周期性架构简化审查异常');
    }
  }, 3600_000); // 每小时
  logger.info('[B4 bootstrap] 定期架构抽查已启动(每小时，含架构简化审查)');
  // zx_20261011 M7: 返回句柄供调用方在退出时清除（否则到点触发写日志，撞上已收摊的 logger worker）。
  return timer;
}
