/**
 * 8.3: 健康检查后台调度器。
 * 每5分钟对活跃MCP服务执行initialize+listTools，
 * 对A2A服务拉取Agent Card。
 * 连续2次失败→自动标记disabled，恢复后自动标记active。
 */
import type Database from 'better-sqlite3';
import { createLogger } from '../utils/logger.js';
import { discoverMcpServer } from './mcp-discovery.js';
import { discoverAgentCard } from './a2a-discovery.js';

const logger = createLogger('health-scheduler');

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5分钟
const MAX_FAILURES = 2;
const failureCounts = new Map<string, number>();

let timer: ReturnType<typeof setInterval> | null = null;

export function startHealthCheckScheduler(db: Database.Database): void {
  if (timer) return;

  logger.info({ intervalMs: CHECK_INTERVAL_MS, maxFailures: MAX_FAILURES }, '健康检查调度器启动');

  // 启动后立即执行一次
  runHealthChecks(db).catch((err) => logger.error({ err }, '健康检查执行失败'));

  timer = setInterval(() => {
    runHealthChecks(db).catch((err) => logger.error({ err }, '健康检查执行失败'));
  }, CHECK_INTERVAL_MS);
}

export function stopHealthCheckScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  logger.info('健康检查调度器已停止');
}

async function runHealthChecks(db: Database.Database): Promise<void> {
  // MCP服务器检查
  const mcpServers = db
    .prepare('SELECT id, name, endpoint, status, health_check_at FROM ans_mcp_servers')
    .all() as Array<{ id: string; name: string; endpoint: string; status: string; health_check_at: string | null }>;
  for (const server of mcpServers) {
    try {
      const result = await discoverMcpServer(server.endpoint);
      if (result.success) {
        const prev = failureCounts.get(server.id) || 0;
        failureCounts.set(server.id, 0);
        if (server.status === 'disabled' || server.status === 'error') {
          db.prepare(
            "UPDATE ans_mcp_servers SET status = 'active', health_check_at = datetime('now'), cached_tools = ?, cached_server_info = ? WHERE id = ?",
          ).run(JSON.stringify(result.tools), JSON.stringify(result.serverInfo ?? {}), server.id);
          logger.info({ id: server.id, name: server.name, toolCount: result.tools.length }, 'MCP服务已恢复，重新激活');
        } else {
          db.prepare(
            "UPDATE ans_mcp_servers SET health_check_at = datetime('now'), cached_tools = ?, cached_server_info = ? WHERE id = ?",
          ).run(JSON.stringify(result.tools), JSON.stringify(result.serverInfo ?? {}), server.id);
        }
      } else {
        const count = (failureCounts.get(server.id) || 0) + 1;
        failureCounts.set(server.id, count);
        // 首次检查即失败(从未成功过) → 立即标记error（而非等2次连续失败）
        if (!server.health_check_at && server.status === 'active') {
          db.prepare("UPDATE ans_mcp_servers SET status = 'error', health_check_at = datetime('now') WHERE id = ?").run(
            server.id,
          );
          logger.warn(
            { id: server.id, name: server.name, endpoint: server.endpoint },
            'MCP服务从未可用，标记为error。请检查服务是否已启动。',
          );
        } else if (count >= MAX_FAILURES && server.status === 'active') {
          db.prepare("UPDATE ans_mcp_servers SET status = 'disabled' WHERE id = ?").run(server.id);
          logger.warn({ id: server.id, name: server.name, failures: count }, 'MCP服务连续失败，已禁用');
        } else {
          db.prepare("UPDATE ans_mcp_servers SET health_check_at = datetime('now') WHERE id = ?").run(server.id);
          logger.info({ id: server.id, name: server.name, failures: count, error: result.error }, 'MCP健康检查失败');
        }
      }
    } catch (err) {
      const count = (failureCounts.get(server.id) || 0) + 1;
      failureCounts.set(server.id, count);
      // 首次检查即异常 → 立即标记error
      if (!server.health_check_at && server.status === 'active') {
        db.prepare("UPDATE ans_mcp_servers SET status = 'error', health_check_at = datetime('now') WHERE id = ?").run(
          server.id,
        );
        logger.warn(
          { id: server.id, name: server.name, endpoint: server.endpoint },
          'MCP服务从未可用(异常)，标记为error。',
        );
      } else if (count >= MAX_FAILURES && server.status === 'active') {
        db.prepare("UPDATE ans_mcp_servers SET status = 'disabled' WHERE id = ?").run(server.id);
        logger.warn({ id: server.id, name: server.name, failures: count }, 'MCP服务连续异常，已禁用');
      }
    }
  }

  // A2A服务器检查
  const a2aServers = db.prepare('SELECT id, name, agent_card_url, status FROM ans_a2a_servers').all() as Array<{
    id: string;
    name: string;
    agent_card_url: string;
    status: string;
  }>;
  for (const server of a2aServers) {
    try {
      const result = await discoverAgentCard(server.agent_card_url);
      const a2aKey = `a2a:${server.id}`;
      if (result.success) {
        const prev = failureCounts.get(a2aKey) || 0;
        failureCounts.set(a2aKey, 0);
        if (server.status === 'disabled' && prev >= MAX_FAILURES) {
          db.prepare(
            "UPDATE ans_a2a_servers SET status = 'active', health_check_at = datetime('now') WHERE id = ?",
          ).run(server.id);
          logger.info({ id: server.id, name: server.name }, 'A2A服务已恢复，重新激活');
        } else {
          db.prepare("UPDATE ans_a2a_servers SET health_check_at = datetime('now'), capabilities = ? WHERE id = ?").run(
            JSON.stringify(result.capabilities),
            server.id,
          );
        }
      } else {
        const count = (failureCounts.get(a2aKey) || 0) + 1;
        failureCounts.set(a2aKey, count);
        if (count >= MAX_FAILURES && server.status === 'active') {
          db.prepare("UPDATE ans_a2a_servers SET status = 'disabled' WHERE id = ?").run(server.id);
          logger.warn({ id: server.id, name: server.name, failures: count }, 'A2A服务连续失败，已禁用');
        }
      }
    } catch (err) {
      const a2aKey = `a2a:${server.id}`;
      const count = (failureCounts.get(a2aKey) || 0) + 1;
      failureCounts.set(a2aKey, count);
      if (count >= MAX_FAILURES && server.status === 'active') {
        db.prepare("UPDATE ans_a2a_servers SET status = 'disabled' WHERE id = ?").run(server.id);
        logger.warn({ id: server.id, name: server.name, failures: count }, 'A2A服务连续异常，已禁用');
      }
    }
  }

  logger.info({ mcpCount: mcpServers.length, a2aCount: a2aServers.length }, '健康检查完成');
}
