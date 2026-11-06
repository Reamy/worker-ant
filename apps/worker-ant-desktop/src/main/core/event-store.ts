/**
 * A1 事件溯源：不可变事件存储。
 * 所有状态变更通过此Store持久化，wa_event_log为唯一真相源。
 */

/**
 * @layer domain — 领域层（内因）— 决定系统"是什么"的核心：Agent引擎、任务管理、记忆系统、事件溯源
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createLogger } from './logger.js';

const logger = createLogger('event-store');

export interface DomainEvent {
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  occurred_at?: string;
}

export interface StoredEvent {
  id: number;
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  payload: string;
  metadata: string;
  occurred_at: string;
  created_at: string;
}

const AGGREGATE_TABLES: Record<string, string> = {
  task: 'wa_tasks',
  project: 'wa_projects',
};

export class EventStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * 追加事件到日志（不可变，仅追加）。
   * 自动递增聚合根版本号。
   * @returns 写入后的事件（含自增id和版本号）
   */
  append(event: DomainEvent): StoredEvent {
    const eventId = randomUUID();
    const occurredAt = event.occurred_at ?? new Date().toISOString();
    const metadata = { ...event.metadata };

    const appendStmt = this.db.prepare(`
      INSERT INTO wa_event_log (event_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, metadata, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const getVersionStmt = this.db.prepare(
      `SELECT aggregate_version FROM ${AGGREGATE_TABLES[event.aggregate_type] ?? 'wa_tasks'} WHERE id = ?`
    );

    const updateVersionStmt = this.db.prepare(
      `UPDATE ${AGGREGATE_TABLES[event.aggregate_type] ?? 'wa_tasks'} SET aggregate_version = ? WHERE id = ?`
    );

    const transaction = this.db.transaction(() => {
      // 读取当前版本号
      const row = getVersionStmt.get(event.aggregate_id) as { aggregate_version: number } | undefined;
      const newVersion = (row?.aggregate_version ?? 0) + 1;

      // 写入事件
      appendStmt.run(
        eventId,
        event.event_type,
        event.aggregate_type,
        event.aggregate_id,
        newVersion,
        JSON.stringify(event.payload),
        JSON.stringify(metadata),
        occurredAt,
      );

      // 更新聚合根版本号
      const tableName = AGGREGATE_TABLES[event.aggregate_type];
      if (tableName) {
        updateVersionStmt.run(newVersion, event.aggregate_id);
      }
    });

    transaction();

    logger.debug({ event_type: event.event_type, aggregate_id: event.aggregate_id, version: 'v' + ((this.db.prepare(`SELECT aggregate_version FROM ${AGGREGATE_TABLES[event.aggregate_type] ?? 'wa_tasks'} WHERE id = ?`).get(event.aggregate_id) as { aggregate_version: number })?.aggregate_version ?? 1) }, '事件已持久化');

    const stored = this.db.prepare('SELECT * FROM wa_event_log WHERE event_id = ?').get(eventId) as StoredEvent;
    return stored;
  }

  /**
   * 获取指定聚合根的完整事件流（按发生时间排序）。
   */
  getStream(aggregateType: string, aggregateId: string): StoredEvent[] {
    return this.db.prepare(
      'SELECT * FROM wa_event_log WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY id ASC'
    ).all(aggregateType, aggregateId) as StoredEvent[];
  }

  /**
   * 获取指定ID之后的所有事件（用于SSE断线补发）。
   * @param sinceId 上次收到的事件序号（wa_event_log.id），不含此ID
   * @param limit 最多返回条数
   */
  getEventsSince(sinceId: number, limit = 200): StoredEvent[] {
    return this.db.prepare(
      'SELECT * FROM wa_event_log WHERE id > ? ORDER BY id ASC LIMIT ?'
    ).all(sinceId, limit) as StoredEvent[];
  }

  /**
   * 按关联ID获取相关事件。
   */
  getByCorrelation(correlationId: string): StoredEvent[] {
    return this.db.prepare(
      "SELECT * FROM wa_event_log WHERE json_extract(metadata, '$.correlation_id') = ? ORDER BY id ASC"
    ).all(correlationId) as StoredEvent[];
  }

  /**
   * 按事件类型和时间范围查询事件。
   */
  query(params: {
    eventType?: string;
    aggregateType?: string;
    aggregateId?: string;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  }): StoredEvent[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (params.eventType) { conditions.push('event_type = ?'); values.push(params.eventType); }
    if (params.aggregateType) { conditions.push('aggregate_type = ?'); values.push(params.aggregateType); }
    if (params.aggregateId) { conditions.push('aggregate_id = ?'); values.push(params.aggregateId); }
    if (params.since) { conditions.push('occurred_at >= ?'); values.push(params.since); }
    if (params.until) { conditions.push('occurred_at <= ?'); values.push(params.until); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;

    return this.db.prepare(
      `SELECT * FROM wa_event_log ${where} ORDER BY id ASC LIMIT ? OFFSET ?`
    ).all(...values, limit, offset) as StoredEvent[];
  }

  /**
   * 获取事件日志的最新序号（用于SSE客户端记录last_event_id）。
   */
  getLatestId(): number {
    const row = this.db.prepare('SELECT MAX(id) as maxId FROM wa_event_log').get() as { maxId: number | null };
    return row?.maxId ?? 0;
  }

  /**
   * 统计事件数量。
   */
  count(params?: { aggregateType?: string; aggregateId?: string; eventType?: string }): number {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (params?.aggregateType) { conditions.push('aggregate_type = ?'); values.push(params.aggregateType); }
    if (params?.aggregateId) { conditions.push('aggregate_id = ?'); values.push(params.aggregateId); }
    if (params?.eventType) { conditions.push('event_type = ?'); values.push(params.eventType); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM wa_event_log ${where}`).get(...values) as { cnt: number };
    return row.cnt;
  }
}
