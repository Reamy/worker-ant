import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const DATA_DIR = path.resolve(process.cwd(), '../../data');

export function initDatabase(dbPath?: string): Database.Database {
  // zx_20261022_3 批二：显式路径（`ANS_DB_PATH`，测试/多实例）时建**它自己的**目录；
  //   不设时行为不变（仍落 DATA_DIR）。只为多起一个实例而改生产默认。
  const target = dbPath ?? path.join(DATA_DIR, 'ans-server.db');
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS ans_ai_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT,
      status TEXT DEFAULT 'active',
      source TEXT DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ans_ai_models (
      id TEXT PRIMARY KEY,
      provider_id TEXT REFERENCES ans_ai_providers(id),
      name TEXT NOT NULL,
      capabilities TEXT DEFAULT '[]',
      context_window INTEGER DEFAULT 4096,
      max_output_tokens INTEGER DEFAULT 1024,
      input_price_per_1k REAL DEFAULT 0.0,
      output_price_per_1k REAL DEFAULT 0.0,
      status TEXT DEFAULT 'active',
      source TEXT DEFAULT 'user',
      description TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ans_model_endpoints (
      id TEXT PRIMARY KEY,
      model_id TEXT REFERENCES ans_ai_models(id),
      url TEXT NOT NULL,
      api_key_ref TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      weight REAL DEFAULT 1.0,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ans_skills (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      input_schema TEXT DEFAULT '{}',
      mcp_server_id TEXT,
      tags TEXT DEFAULT '[]',
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ans_mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      endpoint TEXT NOT NULL,
      transport TEXT DEFAULT 'streamable-http',
      auth_config TEXT DEFAULT '{"type":"none"}',
      status TEXT DEFAULT 'active',
      health_check_at TEXT,
      cached_tools TEXT DEFAULT '[]',
      cached_server_info TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ans_a2a_servers (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      agent_card_url TEXT NOT NULL,
      capabilities TEXT DEFAULT '[]',
      auth_config TEXT DEFAULT '{"type":"none"}',
      status TEXT DEFAULT 'active',
      health_check_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ans_billing_records (
      id TEXT PRIMARY KEY,
      endpoint_id TEXT,
      model_id TEXT,
      project_id TEXT,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      cost REAL DEFAULT 0.0,
      currency TEXT DEFAULT 'USD',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ans_audit_logs (
      id TEXT PRIMARY KEY,
      actor TEXT,
      action TEXT,
      resource_type TEXT,
      resource_id TEXT,
      detail TEXT DEFAULT '{}',
      ip TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- zx_20261004 M1 副产物：**API Key 表由 schema 拥有**（此前只有 ApiKeyManager 的惰性 DDL）。
    --   病根：initDatabase 里的 ALTER TABLE ans_api_keys ADD COLUMN resource_groups/secret_enc
    --   跑在**建表之前**——ans_api_keys 要到首次 new ApiKeyManager(db) 才存在 ⇒ 那两条 ALTER
    --   在**全新库**上静默失败（catch {}），于是新库的 ans_api_keys 既无 resource_groups 也无
    --   secret_enc：createApiKey 直接 SQLITE_ERROR、HMAC 取不到明文密钥。老库因表已存在而侥幸无碍。
    --   把建表收进 schema（含全部列）即除根；ApiKeyManager 那句 CREATE TABLE IF NOT EXISTS 退化为空操作。
    CREATE TABLE IF NOT EXISTS ans_api_keys (
      id TEXT PRIMARY KEY,
      key_prefix TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      secret_enc TEXT DEFAULT '',
      name TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      resource_groups TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ans_api_keys_prefix ON ans_api_keys(key_prefix);

    CREATE TABLE IF NOT EXISTS ans_plugin_marketplaces (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      source_type TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_ref TEXT DEFAULT 'main',
      status TEXT DEFAULT 'active',
      auto_refresh INTEGER DEFAULT 1,
      last_refresh_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ans_plugins (
      id TEXT PRIMARY KEY,
      marketplace_id TEXT REFERENCES ans_plugin_marketplaces(id),
      name TEXT NOT NULL,
      version TEXT DEFAULT '0.1.0',
      display_name TEXT,
      description TEXT,
      description_zh TEXT,
      author TEXT,
      language TEXT DEFAULT 'en',
      category TEXT,
      tags TEXT DEFAULT '[]',
      source_path TEXT,
      state TEXT DEFAULT 'available',
      installed_version TEXT,
      installed_at TEXT,
      user_config TEXT DEFAULT '{}',
      stars REAL DEFAULT 0,
      install_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ans_plugin_registrations (
      id TEXT PRIMARY KEY,
      plugin_id TEXT REFERENCES ans_plugins(id),
      resource_type TEXT NOT NULL,
      ans_resource_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ans_plugins_marketplace ON ans_plugins(marketplace_id);
    CREATE INDEX IF NOT EXISTS idx_ans_plugins_state ON ans_plugins(state);
    CREATE INDEX IF NOT EXISTS idx_ans_registrations_plugin ON ans_plugin_registrations(plugin_id);

    CREATE INDEX IF NOT EXISTS idx_ans_billing_created ON ans_billing_records(created_at);
    CREATE INDEX IF NOT EXISTS idx_ans_billing_model ON ans_billing_records(model_id);
    CREATE INDEX IF NOT EXISTS idx_ans_billing_project ON ans_billing_records(project_id);
    CREATE INDEX IF NOT EXISTS idx_ans_audit_created ON ans_audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_ans_models_provider ON ans_ai_models(provider_id);
    CREATE INDEX IF NOT EXISTS idx_ans_endpoints_model ON ans_model_endpoints(model_id);

    -- P0.5: 模型质量日志（实践验证模型选择）
    CREATE TABLE IF NOT EXISTS ans_model_quality_logs (
      id TEXT PRIMARY KEY,
      model_id TEXT REFERENCES ans_ai_models(id),
      project_id TEXT,
      task_type TEXT,
      capability TEXT,
      success INTEGER DEFAULT 1,
      output_accepted INTEGER DEFAULT 1,
      token_efficiency REAL,
      latency_ms INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ans_quality_model ON ans_model_quality_logs(model_id);
    CREATE INDEX IF NOT EXISTS idx_ans_quality_project ON ans_model_quality_logs(project_id);

    -- zx_20261004 M1：工蚁**节点注册表**（K-5 一节点一 key；K-11 预设三档角色）。
    --   一行 = 一台已注册的工蚁桌面。api_key_prefix 指向 ans_api_keys（key 由注册时签发），
    --   resource_group 恒为 node:<node_id>。JSON 列（capabilities/card/status）原样存、读面解出。
    CREATE TABLE IF NOT EXISTS ans_nodes (
      id TEXT PRIMARY KEY,
      node_id TEXT UNIQUE NOT NULL,
      name TEXT DEFAULT '',
      api_key_prefix TEXT DEFAULT '',
      resource_group TEXT DEFAULT '',
      platform TEXT DEFAULT '',
      role TEXT DEFAULT 'worker',
      weight REAL DEFAULT 1.0,
      participate INTEGER DEFAULT 1,
      capabilities_json TEXT DEFAULT '[]',
      card_json TEXT DEFAULT '{}',
      status_json TEXT DEFAULT '{}',
      enrolled_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT,
      status TEXT DEFAULT 'active'
    );
    CREATE INDEX IF NOT EXISTS idx_ans_nodes_status ON ans_nodes(status);
    CREATE INDEX IF NOT EXISTS idx_ans_nodes_last_seen ON ans_nodes(last_seen_at);

    -- zx_20261004 M1：**注册令牌**（K-9 令牌自助注册）。一次性/有限次/可过期。
    CREATE TABLE IF NOT EXISTS ans_enrollment_tokens (
      token TEXT PRIMARY KEY,
      created_by TEXT DEFAULT '',
      note TEXT DEFAULT '',
      max_uses INTEGER DEFAULT 1,
      used_count INTEGER DEFAULT 0,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- zx_20261004 M12：**中转队列**（AI 终端 → ANS → 工蚁 → 回传）。
    --   桌面无监听端口（§1.2）⇒ AI 终端不能直连工蚁，唯一形态是"经 ANS 中转"。
    --   状态机 pending（无可派节点，等）→ assigned（已选目标，工蚁待拉）→ done/error（回传终态）。
    --   target_node_id 为空 = 尚未选到目标（pending）；claimed/done 时刻为审计留痕（M13 可见）。
    CREATE TABLE IF NOT EXISTS ans_node_requests (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      payload_json TEXT DEFAULT '{}',
      requester_key_prefix TEXT DEFAULT '',
      requester_node_id TEXT,
      target_node_id TEXT,
      status TEXT DEFAULT 'pending',
      result_json TEXT,
      -- zx_20261011_1 M4（双向澄清）：一问一答两列 + 问题状态（'asked'/'answered'）。
      --   B 端提问落 question_json/status='asked' 并把请求转 'awaiting_answer'；A 端作答落 answer_json/status='answered' 并转回 'assigned'。
      question_json TEXT,
      answer_json TEXT,
      question_status TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      claimed_at TEXT,
      done_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ans_node_requests_target ON ans_node_requests(target_node_id, status);
    CREATE INDEX IF NOT EXISTS idx_ans_node_requests_status ON ans_node_requests(status);

    -- zx_20261017_1 批六：**团队共享库**（跨节点共享模板/记忆/成果元数据）。
    --   source_node_id 只由调用方凭据派生（routes/team.ts 复用 deriveRequesterNodeId），不信 body；
    --   body_json 原样存、读面解出。成果只共享元数据：file_path 不入库、不过网。
    --   上限（title 200 / body 64KB / 单节点 500 条）真源在 @worker-ant/shared-types 的 team.ts。
    CREATE TABLE IF NOT EXISTS ans_team_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      body_json TEXT NOT NULL DEFAULT '{}',
      source_node_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ans_team_items_kind ON ans_team_items(kind);
    CREATE INDEX IF NOT EXISTS idx_ans_team_items_source ON ans_team_items(source_node_id);

    -- zx_20261023_5 批五：**云端权益（骨架）**。管理员按 API Key 前缀签发一档权益；
    --   桌面启动时 5 秒有界拉取，失败 fail-open 按本地许可运行。只读不写——本表没有 HTTP 写入口，
    --   签发由运维直接落库（含 signature），免得把"谁能改权益"做成又一条可攻击的活口。
    CREATE TABLE IF NOT EXISTS ans_entitlements (
      id TEXT PRIMARY KEY,
      key_prefix TEXT NOT NULL,
      tier TEXT NOT NULL,
      limits_json TEXT NOT NULL DEFAULT '{}',
      features_json TEXT NOT NULL DEFAULT '[]',
      seats INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      signature TEXT NOT NULL DEFAULT '',
      note TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      issued_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ans_entitlements_key ON ans_entitlements(key_prefix);
  `);

  // 迁移：已有数据库补加列（忽略已存在错误）
  for (const col of ['cached_tools', 'cached_server_info']) {
    try {
      db.exec(`ALTER TABLE ans_mcp_servers ADD COLUMN ${col} TEXT DEFAULT '${col === 'cached_tools' ? '[]' : '{}'}'`);
    } catch {
      /* column already exists */
    }
  }
  // 8.1: 资源隔离字段
  for (const col of ['resource_group']) {
    try {
      db.exec(`ALTER TABLE ans_ai_models ADD COLUMN ${col} TEXT DEFAULT ''`);
    } catch {
      /* ok */
    }
    try {
      db.exec(`ALTER TABLE ans_skills ADD COLUMN ${col} TEXT DEFAULT ''`);
    } catch {
      /* ok */
    }
    try {
      db.exec(`ALTER TABLE ans_mcp_servers ADD COLUMN ${col} TEXT DEFAULT ''`);
    } catch {
      /* ok */
    }
    try {
      db.exec(`ALTER TABLE ans_a2a_servers ADD COLUMN ${col} TEXT DEFAULT ''`);
    } catch {
      /* ok */
    }
    try {
      db.exec(`ALTER TABLE ans_model_endpoints ADD COLUMN ${col} TEXT DEFAULT ''`);
    } catch {
      /* ok */
    }
  }
  try {
    db.exec(`ALTER TABLE ans_api_keys ADD COLUMN resource_groups TEXT DEFAULT '[]'`);
  } catch {
    /* ok */
  }
  // zx_20260930 M9：HMAC 真验签需要**明文** secret（`secret_hash` 是 sha256，不可逆 ⇒ 参与不了 HMAC）。
  //   新增一列存 AES-GCM 加密后的明文（`encryptApiKey`/`decryptApiKey`）。旧行此列为空 ⇒
  //   `hmacAuth` 如实拒绝而不是拿哈希去凑一个永不成立的比较。
  try {
    db.exec(`ALTER TABLE ans_api_keys ADD COLUMN secret_enc TEXT DEFAULT ''`);
  } catch {
    /* ok */
  }

  // v9.0: 推荐模型系统——来源标记
  try {
    db.exec(`ALTER TABLE ans_ai_providers ADD COLUMN source TEXT DEFAULT 'user'`);
  } catch {
    /* ok */
  }
  try {
    db.exec(`ALTER TABLE ans_ai_models ADD COLUMN source TEXT DEFAULT 'user'`);
  } catch {
    /* ok */
  }
  // C1 (2026-09-01): 供应商/模型「启用」开关——独立 enabled 列（区别于 status='disabled' 软删；enabled=0 仍出现在列表可重新启用）
  try {
    db.exec(`ALTER TABLE ans_ai_providers ADD COLUMN enabled INTEGER DEFAULT 1`);
  } catch {
    /* ok */
  }
  try {
    db.exec(`ALTER TABLE ans_ai_models ADD COLUMN enabled INTEGER DEFAULT 1`);
  } catch {
    /* ok */
  }
  try {
    db.exec(`ALTER TABLE ans_ai_models ADD COLUMN description TEXT DEFAULT ''`);
  } catch {
    /* ok */
  }
  // C4 (2026-09-01): 端点测试连通性——健康检查状态（GET {url}/models 探测）
  try {
    db.exec(`ALTER TABLE ans_model_endpoints ADD COLUMN health_check_at TEXT DEFAULT ''`);
  } catch {
    /* ok */
  }
  try {
    db.exec(`ALTER TABLE ans_model_endpoints ADD COLUMN health_status TEXT DEFAULT ''`);
  } catch {
    /* ok */
  }
  try {
    db.exec(`ALTER TABLE ans_model_endpoints ADD COLUMN last_latency_ms INTEGER DEFAULT 0`);
  } catch {
    /* ok */
  }
  try {
    db.exec(`ALTER TABLE ans_billing_records ADD COLUMN currency TEXT DEFAULT 'USD'`);
  } catch {
    /* ok */
  }
  try {
    db.exec(`ALTER TABLE ans_plugins ADD COLUMN user_config TEXT DEFAULT '{}'`);
  } catch {
    /* ok */
  }
  try {
    db.exec(`ALTER TABLE ans_plugins ADD COLUMN stars REAL DEFAULT 0`);
  } catch {
    /* ok */
  }
  try {
    db.exec(`ALTER TABLE ans_plugins ADD COLUMN install_count INTEGER DEFAULT 0`);
  } catch {
    /* ok */
  }
  try {
    db.exec(`ALTER TABLE ans_plugins ADD COLUMN enabled INTEGER DEFAULT 1`);
  } catch {
    /* ok */
  }

  // zx_20260930 M15-③：市场刷新的**失败账**。此前失败是 `catch { /* skip */ }`——静默到读不出因果。
  try {
    db.exec(`ALTER TABLE ans_plugin_marketplaces ADD COLUMN last_error TEXT DEFAULT ''`);
  } catch {
    /* ok */
  }
  try {
    db.exec(`ALTER TABLE ans_plugin_marketplaces ADD COLUMN last_error_at TEXT DEFAULT ''`);
  } catch {
    /* ok */
  }

  // zx_20261011 M1：请求方身份（`GET /requests/:id` 读回鉴权用）。可空——旧行/非节点终端为 NULL。
  try {
    db.exec(`ALTER TABLE ans_node_requests ADD COLUMN requester_node_id TEXT`);
  } catch {
    /* ok */
  }

  // zx_20261011_1 M4（双向澄清）：一问一答两列 + 问题状态。旧库补列（`try{ALTER}catch{}` 范式）。
  for (const col of ['question_json', 'answer_json', 'question_status']) {
    try {
      db.exec(`ALTER TABLE ans_node_requests ADD COLUMN ${col} TEXT`);
    } catch {
      /* ok */
    }
  }

  return db;
}
