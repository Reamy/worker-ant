import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('audit');

export interface AuditEntry {
  actor: string;
  action: string;
  resource_type: string;
  resource_id: string;
  detail?: Record<string, unknown>;
  ip?: string;
}

/**
 * 审计日志服务。
 */
export class AuditService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  log(entry: AuditEntry): void {
    const id = randomUUID();
    const detail = entry.detail ? JSON.stringify(entry.detail) : '{}';
    try {
      this.db
        .prepare(
          'INSERT INTO ans_audit_logs (id, actor, action, resource_type, resource_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, entry.actor, entry.action, entry.resource_type, entry.resource_id, detail, entry.ip ?? null);
    } catch (err) {
      logger.error({ err, entry: { ...entry, detail } }, '审计日志写入失败');
    }
  }

  query(options: {
    resource_type?: string;
    resource_id?: string;
    actor?: string;
    action?: string;
    limit?: number;
    offset?: number;
  }): AuditEntry[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.resource_type) {
      conditions.push('resource_type = ?');
      params.push(options.resource_type);
    }
    if (options.resource_id) {
      conditions.push('resource_id = ?');
      params.push(options.resource_id);
    }
    if (options.actor) {
      conditions.push('actor = ?');
      params.push(options.actor);
    }
    if (options.action) {
      conditions.push('action = ?');
      params.push(options.action);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    return this.db
      .prepare(`SELECT * FROM ans_audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as AuditEntry[];
  }
}
