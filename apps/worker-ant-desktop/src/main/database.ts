import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { TASK_TEMPLATES } from './core/task-templates.js';
import { PAUSE_REASON_STARTUP_SWEEP } from './core/pause-reason.js';
import { pauseTask } from './core/pause-task.js';
import { ansSeedCreds } from './core/ans-signed-request.js';
// zx_20261012_2 批一（策略可配）: 五个 policy.* 数值键的缺省由 `DEFAULT_POLICIES` 派生（不手抄数字）。
import { policySettingDefaults } from './core/policy-config.js';
// zx_20261005 M7: 试用起算点的键名与读取侧（`license.ts`）**同一处真源**——防"写 a 读 b"（承
//   `feedback_enum_value_sweep_readers` 的「第二落点」教训：本行是该键的**写入落点**，须引常量而非抄字面量）。
import { LICENSE_SETTING_KEYS } from './core/license.js';
// zx_20261016_4（道德经·善闭无关楗而不可开）: 试用起算点改为**两处锚点取早者**——库内那行 + 库外封印文件。
//   裁决是纯函数（`resolveTrialAnchor`），此处只做"取两处 → 写两处"；理由与诚实边界见该模块头注释。
import { TRIAL_ANCHOR_FILENAME, readSeal, resolveTrialAnchor, writeSeal } from './core/license-anchor.js';

export function initDatabase(dataDir: string, dbName = 'worker-ant-server.db'): Database.Database {
  // 确保数据目录存在
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, dbName);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // ===== 核心表 =====
  db.exec(`
    CREATE TABLE IF NOT EXISTS wa_users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT DEFAULT '',
      avatar_url TEXT, role TEXT DEFAULT 'viewer', auth_provider TEXT DEFAULT 'authjs',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS wa_projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
      status TEXT DEFAULT 'active', cron_schedule TEXT, working_dir TEXT DEFAULT '',
      context_json TEXT DEFAULT '{}', sandbox_mode TEXT DEFAULT 'workspace',
      owner_id TEXT REFERENCES wa_users(id),
      cron_timezone TEXT DEFAULT 'Asia/Shanghai',
      autonomous_mode TEXT DEFAULT 'off',
      aggregate_version INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS wa_project_members (
      project_id TEXT REFERENCES wa_projects(id), user_id TEXT REFERENCES wa_users(id),
      role TEXT DEFAULT 'developer', PRIMARY KEY (project_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS wa_tasks (
      id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id),
      title TEXT NOT NULL, description TEXT DEFAULT '', status TEXT DEFAULT 'pending',
      context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
      priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
      source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '',
      aggregate_version INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS wa_task_conversations (
      id TEXT PRIMARY KEY, task_id TEXT REFERENCES wa_tasks(id),
      role TEXT NOT NULL, content TEXT DEFAULT '', tool_calls TEXT,
      token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS wa_memories (
      id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id), task_id TEXT,
      content TEXT NOT NULL, embedding TEXT, memory_type TEXT DEFAULT 'episodic',
      importance REAL DEFAULT 0.5, reasoning TEXT DEFAULT '', source TEXT DEFAULT 'agent_execution',
      user_id TEXT DEFAULT '', valence TEXT DEFAULT 'neutral', context_json TEXT DEFAULT '{}',
      is_exemplar INTEGER DEFAULT 0, exemplar_type TEXT, exemplar_context TEXT, updated_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS wa_im_channels (
      id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, name TEXT DEFAULT '',
      config TEXT NOT NULL DEFAULT '{}', status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS wa_im_conversations (
      id TEXT PRIMARY KEY, channel_id TEXT REFERENCES wa_im_channels(id),
      external_user_id TEXT, project_id TEXT, message_json TEXT DEFAULT '{}',
      direction TEXT DEFAULT 'inbound', created_at TEXT DEFAULT (datetime('now')),
      -- zx_20260913 M1-4(海德格尔·在场 / 罗尔斯·同一把尺): 送达态写在「事」本身所在的行上。
      --   历史事实：出站行**只在发送成功后**落库 ⇒ 'sent' 是历史默认值，不伪造历史失败。
      --   status 仅对 direction='outbound' 有语义（界面据此渲染已送达/未送达）；inbound 行不据它说话。
      status TEXT DEFAULT 'sent', last_error TEXT DEFAULT '',
      -- 与 wa_im_outbox 的真关联：补发成功后据此把本行由 failed 翻回 sent（同一把尺）。
      outbox_id TEXT DEFAULT '',
      -- zx_20260930 M2-c(维特根斯坦·意义即使用 / 一实一名): 这一行**属于哪个任务**。
      --   空串的语义是"**本条无归属**"（手工回话/重发/入站寒暄），**不是**"归属为某个空的东西"。
      --   只在**真知道**时才写：出站通知行（sendImCompletionNotice 手里就有 taskId）与
      --   入站回复行（handleAgentReply 落 [IM回复] 那刻已知 task.id）。**不猜**——
      --   宁可少标一行，不可标错一行（故不叫 run_id、不做按时间/关键词的模糊匹配）。
      task_id TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS wa_deliverables (
      id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id), task_id TEXT,
      type TEXT NOT NULL, name TEXT DEFAULT '', description TEXT DEFAULT '',
      file_path TEXT, registry_id TEXT, status TEXT DEFAULT 'draft',
      -- zx_20260924_1 M9-d(维特根斯坦·语言游戏 / 如实命名): 本表**没有 size 列**，且**刻意不加**——
      --   产出物的大小是**盘上文件的事实**（file_path → fs.statSync），不是登记那刻的笔录；
      --   台账里存一份会在文件被改后立刻变成**陈旧值**。故列表"大小"由 main 侧现场 stat
      --   （ipc/project.ipc.ts 的 statSizeBytes），历史版本的大小才在 wa_deliverable_versions.size（见其注记）。
      -- ⚠ 本段是**模板字符串内的 SQL** ⇒ 注记里**不得出现反引号**（会提前闭合模板串）。
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS wa_jobs (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
      status TEXT DEFAULT 'pending', retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
      scheduled_at TEXT, started_at TEXT, completed_at TEXT, error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS wa_user_credentials (
      user_id TEXT PRIMARY KEY REFERENCES wa_users(id), password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS wa_oauth_accounts (
      user_id TEXT REFERENCES wa_users(id), provider TEXT NOT NULL,
      provider_account_id TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (provider, provider_account_id)
    );
    CREATE TABLE IF NOT EXISTS wa_knowledge_triples (
      id TEXT PRIMARY KEY, project_id TEXT REFERENCES wa_projects(id),
      subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL,
      confidence REAL DEFAULT 0.5, source TEXT DEFAULT 'agent_extraction',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS wa_deliverable_versions (
      id TEXT PRIMARY KEY, deliverable_id TEXT REFERENCES wa_deliverables(id),
      file_path TEXT NOT NULL, content_snapshot TEXT NOT NULL,
      -- zx_20260924_1 M9-d / §1.17：**本列是字符数，不是字节数**（写入方是 content.length，见 tools/write.ts）。
      --   列名 size 是历史遗留，按 V-9(b) 裁定**保留不改**，换算只在**展示层**做（DeliverablesPage 版本弹窗）。
      --   实测偏差：中文文档约 1.56 B/字符（v61: 21886 字符 vs 盘上 34167 字节），故不可当字节直读。
      size INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, changed_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS wa_invite_tokens (
      id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, created_by TEXT REFERENCES wa_users(id),
      created_at TEXT DEFAULT (datetime('now')), expires_at TEXT NOT NULL,
      used_by TEXT, used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS wa_audit_trail (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT,
      event_type TEXT NOT NULL, event_data TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS wa_event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
      event_type TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
      aggregate_version INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL DEFAULT '{}',
      metadata TEXT DEFAULT '{}', occurred_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS wa_skills (
      id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT DEFAULT '',
      category TEXT DEFAULT 'custom', enabled INTEGER DEFAULT 1, version INTEGER DEFAULT 1,
      config TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS wa_approvals (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      command_fingerprint TEXT NOT NULL,
      kind TEXT DEFAULT 'command',
      approved_at TEXT DEFAULT (datetime('now')),
      UNIQUE(project_id, kind, command_fingerprint)
    );
    CREATE TABLE IF NOT EXISTS wa_task_templates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT DEFAULT 'custom',
      description TEXT DEFAULT '', subtasks TEXT DEFAULT '[]', keywords TEXT DEFAULT '[]',
      status TEXT DEFAULT 'active', priority INTEGER DEFAULT 0,
      source TEXT DEFAULT 'user', match_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ===== 索引 =====
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_wa_tasks_project ON wa_tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_wa_tasks_status ON wa_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_wa_conv_task ON wa_task_conversations(task_id);
    CREATE INDEX IF NOT EXISTS idx_wa_memories_project ON wa_memories(project_id);
    CREATE INDEX IF NOT EXISTS idx_wa_memories_importance ON wa_memories(importance);
    CREATE INDEX IF NOT EXISTS idx_wa_jobs_status ON wa_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_wa_jobs_scheduled ON wa_jobs(scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_wa_kg_project ON wa_knowledge_triples(project_id);
    CREATE INDEX IF NOT EXISTS idx_wa_kg_subject ON wa_knowledge_triples(subject);
    CREATE INDEX IF NOT EXISTS idx_wa_kg_object ON wa_knowledge_triples(object);
    CREATE INDEX IF NOT EXISTS idx_wa_deliverables_project ON wa_deliverables(project_id);
    CREATE INDEX IF NOT EXISTS idx_wa_im_conv_channel ON wa_im_conversations(channel_id);
    CREATE INDEX IF NOT EXISTS idx_audit_task ON wa_audit_trail(task_id);
    CREATE INDEX IF NOT EXISTS idx_audit_type ON wa_audit_trail(event_type);
    CREATE INDEX IF NOT EXISTS idx_event_aggregate ON wa_event_log(aggregate_type, aggregate_id);
    CREATE INDEX IF NOT EXISTS idx_event_type_time ON wa_event_log(event_type, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_event_correlation ON wa_event_log(json_extract(metadata, '$.correlation_id'));
    CREATE INDEX IF NOT EXISTS idx_deliv_versions ON wa_deliverable_versions(deliverable_id, created_at DESC);
  `);

  // ===== 迁移（兼容旧表无列的情况） =====
  const migrations = [
    "ALTER TABLE wa_tasks ADD COLUMN depends_on TEXT DEFAULT ''",
    "ALTER TABLE wa_projects ADD COLUMN working_dir TEXT DEFAULT ''",
    "ALTER TABLE wa_tasks ADD COLUMN parent_task_id TEXT DEFAULT ''",
    "ALTER TABLE wa_tasks ADD COLUMN source TEXT DEFAULT 'user'",
    "ALTER TABLE wa_tasks ADD COLUMN acceptance_criteria TEXT DEFAULT ''",
    "ALTER TABLE wa_memories ADD COLUMN reasoning TEXT DEFAULT ''",
    "ALTER TABLE wa_memories ADD COLUMN source TEXT DEFAULT 'agent_execution'",
    "ALTER TABLE wa_memories ADD COLUMN updated_at TEXT",
    "ALTER TABLE wa_memories ADD COLUMN user_id TEXT DEFAULT ''",
    "ALTER TABLE wa_memories ADD COLUMN valence TEXT DEFAULT 'neutral'",
    "ALTER TABLE wa_memories ADD COLUMN context_json TEXT DEFAULT '{}'",
    "ALTER TABLE wa_memories ADD COLUMN is_exemplar INTEGER DEFAULT 0",
    "ALTER TABLE wa_memories ADD COLUMN exemplar_type TEXT",
    "ALTER TABLE wa_memories ADD COLUMN exemplar_context TEXT",
    "ALTER TABLE wa_projects ADD COLUMN cron_timezone TEXT DEFAULT 'Asia/Shanghai'",
    "ALTER TABLE wa_projects ADD COLUMN autonomous_mode TEXT DEFAULT 'off'",
    "ALTER TABLE wa_projects ADD COLUMN context_json TEXT DEFAULT '{}'",
    "ALTER TABLE wa_projects ADD COLUMN sandbox_mode TEXT DEFAULT 'workspace'",
    "ALTER TABLE wa_tasks ADD COLUMN aggregate_version INTEGER DEFAULT 0",
    "ALTER TABLE wa_projects ADD COLUMN aggregate_version INTEGER DEFAULT 0",
    // Phase 1.3: 记忆访问追踪
    "ALTER TABLE wa_memories ADD COLUMN use_count INTEGER DEFAULT 0",
    "ALTER TABLE wa_memories ADD COLUMN last_used_at TEXT",
    // Phase 2.2: 相似记忆关联
    "ALTER TABLE wa_memories ADD COLUMN similar_to TEXT DEFAULT ''",
    // Phase 1.2: 实践反馈
    "ALTER TABLE wa_memories ADD COLUMN last_reinforced_at TEXT",
    // Phase 2.1: 元记忆——实践成败计数（经验可靠性）
    "ALTER TABLE wa_memories ADD COLUMN success_count INTEGER DEFAULT 0",
    "ALTER TABLE wa_memories ADD COLUMN failure_count INTEGER DEFAULT 0",
    // Phase 4 文件审批: wa_approvals 加 kind 区分命令/路径审批
    "ALTER TABLE wa_approvals ADD COLUMN kind TEXT DEFAULT 'command'",
    // Phase A (2026-08-26): 技能草稿——project_id 作用域 + status 审批状态
    "ALTER TABLE wa_skills ADD COLUMN project_id TEXT",
    "ALTER TABLE wa_skills ADD COLUMN status TEXT DEFAULT 'draft'",
    // zx_20260905 批5 (2026-09-05): 质量可聚合口径——completion_quality.score 提升为列(可 SQL 聚合均质/趋势)，并回填存量
    "ALTER TABLE wa_tasks ADD COLUMN quality_score REAL",
    "UPDATE wa_tasks SET quality_score = CAST(JSON_EXTRACT(context_json, '$.completion_quality.score') AS REAL) WHERE context_json LIKE '%completion_quality%' AND quality_score IS NULL",
    // zx_20260906 批1 (2026-09-06): 成果经络——wa_deliverables 补 updated_at（建表曾缺列而多处 SET/SELECT，fresh DB/重置即断；实时库因历史建表含列而正常，此处幂等对齐）
    "ALTER TABLE wa_deliverables ADD COLUMN updated_at TEXT",
    // zx_20260908 M2(B2b): 主要成果标记——wa_deliverables 补 is_primary(0/1，人工可标；项目成果交付单/产出物页星标)
    "ALTER TABLE wa_deliverables ADD COLUMN is_primary INTEGER DEFAULT 0",
    // zx_20260909_1 M3(C1 空性·假名): per-doc 验收位——wa_deliverables 补 acceptance_verified(0/1, 打标时机见 markDocAcceptanceVerified;
    //   展示从"任务 ctx 扇出"改"doc 级如实", 同任务多 doc 各显各的 ✓)
    "ALTER TABLE wa_deliverables ADD COLUMN acceptance_verified INTEGER DEFAULT 0",
    // zx_20260912 M3(管子·度量衡 / 王阳明·知行合一): 出站补发账**记因**——此前表只有"未送达 N 条", 答不出"为什么没送到"。
    //   last_error=最近一次失败的真原因(具体原因优先, 无则 NULL 如实显示"原因未记录"); last_attempt_at=最近一次尝试时刻(UTC 秒级)。
    "ALTER TABLE wa_im_outbox ADD COLUMN last_error TEXT",
    "ALTER TABLE wa_im_outbox ADD COLUMN last_attempt_at TEXT",
    // zx_20260913 M1-4(海德格尔·在场 / 罗尔斯·同一把尺): 出站送达回执——此前 wa_im_conversations 无 status 列,
    //   且出站行只在成功时落库 ⇒ 发送失败在对话视图里**静默缺席**(同一件事在补发账有行、在对话里没有两种说法)。
    //   默认值 'sent' 与历史事实一致(历史上只落成功行), 不伪造历史失败; outbox_id 让补发成功能翻转本行。
    "ALTER TABLE wa_im_conversations ADD COLUMN status TEXT DEFAULT 'sent'",
    "ALTER TABLE wa_im_conversations ADD COLUMN last_error TEXT DEFAULT ''",
    "ALTER TABLE wa_im_conversations ADD COLUMN outbox_id TEXT DEFAULT ''",
    // zx_20260924 M4: 出站媒体件的两列（既有库补列；语义见上方建表注释）。
    "ALTER TABLE wa_im_outbox ADD COLUMN media_path TEXT",
    "ALTER TABLE wa_im_outbox ADD COLUMN media_kind TEXT",
    // zx_20260930 M2-c(维特根斯坦·意义即使用 / 一实一名): 这一行**属于哪个任务**。
    //   语义见上方建表注释：空串=**本条无归属**（不猜）；只在真知道的两处写。
    "ALTER TABLE wa_im_conversations ADD COLUMN task_id TEXT DEFAULT ''",
    // zx_20260930 M8(空性·无常 / 维特根斯坦·一个规则一处): 墓碑三列——删除从「物理删」改「留痕」。
    //   病根：`DELETE FROM wa_memories` 删掉行，"这条被删过"这一事实随之消失 ⇒ 机器下次照样原样重提取。
    //   三列语义单一真源在 `core/memory-lifecycle.ts`（哨兵/缘由词表/指纹算法全在那里），此处只补列。
    //   deleted_fingerprint 存在 ⇒ 内容指纹；写入语句形状唯一，见 memory-lifecycle.ts 的 TOMBSTONE_UPDATE_SQL。
    "ALTER TABLE wa_memories ADD COLUMN deleted_at TEXT",
    "ALTER TABLE wa_memories ADD COLUMN deleted_reason TEXT DEFAULT ''",
    "ALTER TABLE wa_memories ADD COLUMN deleted_fingerprint TEXT DEFAULT ''",
    // zx_20261012_1 批四: 示例项目隔离列——`1` = 一键载入的示例项目（可一键删除、GUI 打「示例」徽标），
    //   真实项目恒 `0`。删除只认 `is_sample=1` 且固定 id，绝不误删用户数据。值域与语义单一真源在
    //   `core/sample-project.ts`（本处只补列，不在此复述判定）。
    "ALTER TABLE wa_projects ADD COLUMN is_sample INTEGER DEFAULT 0",
    // zx_20261014_1 批二（道德经·名可名非常名）: 设备别名列——**用户叫它的名**，与 `name`（设备自述名）
    //   并存。语义单一真源在 `core/device-registry.ts`（`setDeviceAlias` 是唯一写点；`upsertDiscovered`
    //   **绝不写它**——发现只刷新自述，不覆盖人的叫法，同 `authorized` 待遇）。
    "ALTER TABLE wa_devices ADD COLUMN alias TEXT DEFAULT ''",
    // zx_20261015_3 批三（道德经·知止不殆）: 设备**在线态**列——`NULL`=未知 / `1`=在 / `0`=不在（**三态**）。
    //   语义单一真源在 `core/device-registry.ts`（`setDeviceOnline` 是唯一写点）；**只由可用性事件（LWT/avty 主题）驱动**，
    //   **绝不**从 discovery 载荷推断在线（retain 会重放旧值）。`last_seen`（"我们何时见过"）**不**冒充"它此刻在"。
    "ALTER TABLE wa_devices ADD COLUMN online INTEGER",
    // zx_20261016_2（维特根斯坦·意义即用法 / 管子·度量衡）: 控制留痕的**发起者**两列——三个控制入口
    //   （任务工具 / 面板手动 / 外部终端经门）此前只有任务那一路留得下"是谁"，另两路长相全同、认不出人。
    //   `actor_kind` ∈ {'task','panel','external'}（空串=历史行/认不出，**如实不猜**）；`actor_ref` = 稳定 id
    //   （`task` ⇒ task_id，`external` ⇒ terminal_id，`panel` ⇒ 空）。语义单一真源在 `core/device-registry.ts`
    //   （`runDeviceControl` 收 `actor` 后一处落账）；面板**读时现查**名字，**不留渲染快照**（承 zx_20261014_3）。
    "ALTER TABLE wa_device_actions ADD COLUMN actor_kind TEXT DEFAULT ''",
    "ALTER TABLE wa_device_actions ADD COLUMN actor_ref TEXT DEFAULT ''",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* 列已存在，跳过 */ }
  }

  // ===== 迁移后才能建的索引 =====
  // 凡索引列由上面的 migrations 补出（不在建表语句里），建索引必须排在迁移**之后**——
  //   否则老库/新库都会在建索引那一刻因「no such column」整段抛错（initDatabase 直接失败）。
  //   rr 夹具自带该列，照不出这一类；生产 initDatabase 才会。
  db.exec(`
    -- zx_20260930 M8: 墓碑拦截查询（机器写入侧每写入一次查一次）走这条；
    --   另一处消费是审计面 listTombstones 的 memory_type = 'deleted' 过滤。
    CREATE INDEX IF NOT EXISTS idx_wa_memories_tombstone ON wa_memories(memory_type, deleted_fingerprint);
  `);

  // ===== 系统设置表 =====
  db.exec(`CREATE TABLE IF NOT EXISTS wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))`);

  // ===== 通知中心表（A3 2026-09-03：wa_event_log 的用户侧物化视图 + 已读状态）=====
  db.exec(`CREATE TABLE IF NOT EXISTS wa_notifications (
    id TEXT PRIMARY KEY,
    event_id TEXT,
    type TEXT NOT NULL,
    task_id TEXT,
    project_id TEXT,
    title TEXT NOT NULL,
    body TEXT,
    read_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wa_notifications_created ON wa_notifications(created_at DESC)`);

  // ===== 方案里程碑表（B1 2026-09-03_1：规划↔实施追踪——方案 M0-M6 状态 + 落地任务关联）=====
  db.exec(`CREATE TABLE IF NOT EXISTS wa_plan_milestones (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    plan_task_id TEXT NOT NULL,
    milestone TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    implemented_by_task_id TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_plan_milestones_uniq ON wa_plan_milestones(plan_task_id, milestone)`);

  // ===== IM 出站失败补发账(A3 zx_20260909_1 M2: 关键通知发送失败落账, 短窗退避重试, 不丢消息)=====
  db.exec(`CREATE TABLE IF NOT EXISTS wa_im_outbox (
    id TEXT PRIMARY KEY,
    channel_id TEXT,
    external_user_id TEXT,
    task_id TEXT,
    kind TEXT DEFAULT 'notification',
    message TEXT DEFAULT '',
    attempts INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    next_retry_at INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    last_error TEXT,
    last_attempt_at TEXT,
    -- zx_20260924 M4: 出站媒体件。media_path 非空 ⇒ 这条账发的是"件"不是文本,
    --   补发必须走 sendMedia——否则重试把一件文件退化成一条只有文件名的文字(账上却记"已送达")。
    media_path TEXT,
    media_kind TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wa_im_outbox_due ON wa_im_outbox(status, next_retry_at)`);

  // ===== IM 通知意图账（zx_20261012_2 批五 M5: 通知面归位 + 短窗聚并）=====
  //   语义单一真源在 `core/im/im-notify-log.ts`（窗口/类目/判定全在那里），此处只建表。
  //   为什么另立一本账：`pushImNotify` 的发送经动态 import `ipc/im.ipc.js`（静态引 electron），
  //   rr/受控回归**起不了 electron** ⇒ 收不到 `wa_im_conversations`/`wa_im_outbox` 行。
  //   "这次到底有没有尝试通知、被聚并了几条"必须有一本**不依赖 electron** 可写的账，
  //   否则"该发没发"这类缺陷在回归里永远照不出（本仓"三本账"：意图账／outbox 队列／conversations 送达）。
  //   `at` 取毫秒墙钟（与聚并窗口同基准），非库内 UTC 文本时刻。
  db.exec(`CREATE TABLE IF NOT EXISTS wa_im_notify_log (
    id TEXT PRIMARY KEY,
    project_id TEXT DEFAULT '',
    task_id TEXT DEFAULT '',
    kind TEXT NOT NULL,
    suppressed INTEGER DEFAULT 0,
    at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wa_im_notify_log_win ON wa_im_notify_log(project_id, kind, at DESC)`);

  // ===== 项目调用记账(zx_20261002 M11: MCP 调用/A2A 启动/守护进程启动 按 项目+对象+动作+成败+耗时 落一处真源)=====
  //   语义单一真源在 `core/service-call-ledger.ts`（写入/读取/类目词表全在那里），此处只建表。
  //   硬约束两条：**只收账、不据此做决策**（任何调度/选型/熔断路径不得读它）；**禁散落 context_json**。
  //   `created_at` 用与库内其它表同基准的 UTC；同秒并列时读侧按 `rowid`（真插入序）定序，不靠 id。
  db.exec(`CREATE TABLE IF NOT EXISTS wa_service_calls (
    id TEXT PRIMARY KEY,
    project_id TEXT DEFAULT '',
    task_id TEXT DEFAULT '',
    kind TEXT NOT NULL,
    target TEXT DEFAULT '',
    operation TEXT DEFAULT '',
    ok INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    error TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wa_service_calls_project ON wa_service_calls(project_id, created_at DESC)`);

  // ===== 局域网设备台账 + 控制审计（zx_20261004 M7/M9: K-3 协议无关发现 / K-6 显式授权白名单）=====
  //   语义单一真源在 `core/device-registry.ts`（upsert 去重/控制闸/审计全在那里），此处只建表。
  //   两条硬约束：**去重键 = protocol + address**（唯一索引即是它，"同一设备"只此一判据）；
  //     **authorized 缺省 0**（发现不等于授权——王阳明·知行合一：知道有这台设备 ≠ 能开它）。
  //   zx_20261014_1 批二（道德经·名可名非常名）：`name` 是**设备自述**的名（每次发现**会被覆写**），
  //     `alias` 是**用户叫它的名**（发现**永不写**）——两个名各归其位，不互相冒充。"能不能按名使唤"
  //     看的是 `alias || name`，解析真源在 `core/device-registry.ts` 的 `resolveDeviceByName`。
  db.exec(`CREATE TABLE IF NOT EXISTS wa_devices (
    id TEXT PRIMARY KEY,
    name TEXT DEFAULT '',
    alias TEXT DEFAULT '',
    kind TEXT DEFAULT 'unknown',
    protocol TEXT NOT NULL,
    address TEXT NOT NULL,
    port INTEGER,
    capabilities_json TEXT DEFAULT '[]',
    controllable INTEGER DEFAULT 0,
    authorized INTEGER DEFAULT 0,
    status_json TEXT,
    first_seen TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now')),
    online INTEGER
  )`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_devices_ident ON wa_devices(protocol, address)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wa_devices_last_seen ON wa_devices(last_seen DESC)`);
  //   控制审计：**每次控制含被拒都落一行**（"控制全量留痕"）；result 记 ok/denied/error。
  //   zx_20261016_2（维特根斯坦·意义即用法 / 管子·度量衡）: `actor_kind`/`actor_ref` 记**是谁发起的**
  //     （`task`/`panel`/`external`；空串=认不出，如实不猜）。语义单一真源在 `core/device-registry.ts`。
  db.exec(`CREATE TABLE IF NOT EXISTS wa_device_actions (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    action TEXT NOT NULL,
    args_json TEXT DEFAULT '{}',
    result TEXT DEFAULT '',
    task_id TEXT DEFAULT '',
    actor_kind TEXT DEFAULT '',
    actor_ref TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wa_device_actions_device ON wa_device_actions(device_id, created_at DESC)`);
  //   zx_20261016_2 批一: **事实回填**（**不是猜测**）——本轮之前**只有**任务工具路把 `task_id` 传进
  //     `runDeviceControl`（面板手动 / 外部终端两路一律不传）⇒ `task_id != ''` ⟺ 该行由任务发起，是**可核事实**。
  //     带 `actor_kind=''` 条件 ⇒ 幂等，且**绝不**覆盖本轮已写下的新行。其余旧行（面板/外部两路）
  //     长相全同、**认不出就留空**（面板据此整段不渲染——不假装认得出）。
  //     ⚠ 排在**建表之后**（不能放进上面 migrations 数组：那里跑在建表之前，新库会因 no such table 被 try/catch 吞掉）。
  db.exec(`UPDATE wa_device_actions SET actor_kind = 'task', actor_ref = task_id WHERE actor_kind = '' AND task_id != ''`);

  // zx_20261014_4 批二（罗尔斯·无知之幕）: **外部 AI 终端**的配对与凭据台账。
  //   `status` 三态之后：pending（已申请待批）→ approved / rejected；approved 之后可 → revoked（吊销）。
  //   ⚠ `secret_hash` **只存 hash 不存明文**（照 `ans_api_keys` 范式；明文只在"送达终端那一次"在手，
  //     见 core/external-terminals.ts 的内存态）。`key_prefix` = 凭据 key 的前 8 位（校验时先按它取行）。
  //   `pair_code` 6 位短码——**pending 期**让用户在桌面端核对"来的真是这个东西"（不是凭据）。
  db.exec(`CREATE TABLE IF NOT EXISTS wa_external_terminals (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    pair_code TEXT NOT NULL,
    key_prefix TEXT,
    secret_hash TEXT,
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    last_remote_addr TEXT,
    last_seen_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    approved_at TEXT,
    revoked_at TEXT,
    delivered_at TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wa_ext_term_prefix ON wa_external_terminals(key_prefix)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wa_ext_term_status ON wa_external_terminals(status, created_at DESC)`);

  // zx_20261014_4 批三（管子·度量衡）: **外部终端经门做的事**留痕——仿 `wa_device_actions`，
  //   `result` 记 ok/denied/error，**被拒也落一行**（白名单外/未获许可/执行失败皆有痕）。
  //   `reason` 记机器可读的判据档位（`capability_not_allowed` / `not_authorized` / …），成功为空串。
  //   `remote_addr` 记来源地址（"这台终端从哪儿来的"）；`terminal_id` 指向 `wa_external_terminals.id`。
  db.exec(`CREATE TABLE IF NOT EXISTS wa_external_calls (
    id TEXT PRIMARY KEY,
    terminal_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    args_json TEXT DEFAULT '{}',
    result TEXT DEFAULT '',
    reason TEXT DEFAULT '',
    remote_addr TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wa_external_calls_terminal ON wa_external_calls(terminal_id, created_at DESC)`);

  // ===== 项目域知识册（zx_20261014_4 批四: 维特根斯坦·不要想，要看／为学日益为道日损）=====
  //   项目知识**结构化的一册**：由四类真源（三元组/交付物/调用账/运行面）**派生**（**零 LLM**、可复现）
  //   ——每项目一册、按 `section` 分行；**唯一键 `(project_id, section)` ⇒ 幂等 upsert**（重复跑不膨胀）。
  //   语义单一真源在 `core/project-knowledge.ts`（派生/写入/读取全在那里），此处只建表。
  //   ⚠ 与 `wa_memories` 里 `memory_type='panorama'` 的**散文**不是一回事：后者靠 LLM 每轮重综合、越写越长；
  //     本表只**派生**既有事实——不花钱、可复现、不臆造（"知"从已发生的事里来，不从想里来）。
  //   `source_ref` 记该节的真源出处（"这行从哪来"，供人与机器复核）；`updated_at` 记"这册何时刷的"。
  db.exec(`CREATE TABLE IF NOT EXISTS wa_project_knowledge (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    section TEXT NOT NULL,
    content TEXT NOT NULL,
    source_ref TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_project_knowledge_sec ON wa_project_knowledge(project_id, section)`);

  // 默认 ANS 配置（首次启动写入）
  const ensureSetting = (k: string, v: string) => {
    const exists = db.prepare('SELECT 1 FROM wa_settings WHERE key=?').get(k);
    if (!exists) db.prepare('INSERT INTO wa_settings (key,value) VALUES (?,?)').run(k, v);
  };
  // zx_20260930 M9: 缺省值取 **一处真源**——此前这三行的字面量与读取侧各存一份，
  //   两边漂开即是"首启写进去的身份"与"读出来签名的身份"不一致（恒 401 且看不出为什么）。
  // zx_20261005 M16: 真源换成 `ansSeedCreds()`——它**依构建形态**给值（开发写 dev-key/dev-secret，
  //   生产写空串）。这里必须与 `resolveAnsCreds` 的尾端同源：若生产首启仍写入 dev-key，则
  //   `resolveAnsCreds` 的 `read()` 会读到它、永远落不到尾端形态开关上（形同虚设）。
  const seedCreds = ansSeedCreds();
  ensureSetting('ans_server_url', process.env.ANS_SERVER_URL ?? seedCreds.url);
  ensureSetting('ans_api_key', process.env.ANS_API_KEY ?? seedCreds.apiKey);
  ensureSetting('ans_secret_key', process.env.ANS_SECRET_KEY ?? seedCreds.secretKey);
  // zx_20260907 M1(A1/A2): 记忆归档保留期(0=关闭) / 验收通过→成功配方(exemplar)沉淀
  ensureSetting('memory.archive_retention_days', '90');
  ensureSetting('memory.outcome_exemplar', 'true');
  // zx_20260908 A2(为道日损): 后台巩固对闲置项目(近7天无任务/记忆活动)跳过 LLM 密集 Phase——memory.consolidation_idle_skip(0=关闭)
  ensureSetting('memory.consolidation_idle_skip', 'true');
  // zx_20260908_1 A1/A2(少则得·用法即意义): 同任务 verified receipt 去重归并(非重复新增) / §3 有效样板按被应用证据优先注入
  ensureSetting('memory.receipt_dedup', 'true');
  ensureSetting('memory.exemplar_effect_rank', 'true');
  // zx_20260930 M7-f(巴特莱特·图式重构): 任务相关记忆按"当下任务的需求"重建条序（缺省即开；关 ⇒ 旧口径 A/B）
  ensureSetting('memory.schema_recall', 'true');
  // zx_20260907 M2(B1/B2): 产出物版本起点基线(新建doc落v1,仅新写不补录) / 验收透出(doc已核显徽标)
  ensureSetting('deliverable.first_write_v1', 'true');
  ensureSetting('deliverable.show_acceptance', 'true');
  // zx_20260908 M2(B1/B2): 项目成果交付单凝练视图 / 任务列表成果摘要 / primary 主要成果星标(展示+人工可标)
  ensureSetting('deliverable.show_delivery_digest', 'true');
  ensureSetting('deliverable.task_achievement_summary', 'true');
  ensureSetting('deliverable.primary_marker', 'true');
  // zx_20260908_1 B1/B2(空性·缘起归窗 / 知行合一): 交付单时间窗切换(全部/近30/近7) / finalize 自动落首个 primary(可人工撤)
  ensureSetting('deliverable.digest_window_switch', 'true');
  ensureSetting('deliverable.primary_auto', 'true');
  // zx_20260909_1 M3(C1 维特根斯坦·可判定到具体 doc): per-doc 验收位读位——doc 级各自显 ✓; false 回落旧"任务 ctx 扇出"
  ensureSetting('deliverable.per_doc_acceptance', 'true');
  // zx_20260909_1 M4(Z1 王阳明·为之于未有): 新建任务弹窗显示"关联方案(规划)"下拉(创建即落 scheme_ref); false 隐藏仅留详情页事后关联
  ensureSetting('plan.link_at_create', 'true');
  // zx_20260909 Y1/Y2(空性·如实 / 少则得·克制): IM 完成/失败回话"主要成果摘要化"(false=回旧丢原文) / 入站耗时处理前 busy ack(0=关) /
  // 超长运行一次在场回话(分钟, 0=关)——微信日常在用, 报主要成果不丢半截 markdown, 不刷屏
  ensureSetting('im.completion_summary', 'true');
  ensureSetting('im.busy_ack', 'true');
  ensureSetting('im.long_running_progress_min', '15');
  // zx_20260909_1 M1/M2(域A · 空性·假名/王阳明·致良知): IM 通知目标=任务创建人(false 回落旧"全渠道最近发言路人"广播) /
  // agent 判定需人工介入暂停→推创建人 IM(false 静默) / 出站失败短窗补发(分钟, 0=关)
  ensureSetting('im.notify_to_creator', 'true');
  ensureSetting('im.notify_pause_needed', 'true');
  ensureSetting('im.outbox_retry_min', '10');
  // zx_20260909 X1(黑格尔·整体中成其自身): 就地成果详情抽屉(交付单/最近产出物/任务详情/CommandPalette 点 doc 就地展开版本流·验收·溯源)
  ensureSetting('deliverable.doc_drawer', 'true');
  // zx_20260908 D1/D4: 全局「执行在场条」(任意页可见运行数/最长时长) + 僵尸"运行中"无推进反色提示
  ensureSetting('ui.presence_bar', 'true');
  ensureSetting('ui.stale_running_hint', 'true');
  // zx_20260908_1 D1/D2(如实呈现实时/不展开窗口亦处置): 最小化在场(窗口标题+托盘 tooltip 带运行数) / 托盘运行任务菜单(直达/暂停)
  ensureSetting('ui.presence_minimize', 'true');
  ensureSetting('ui.tray_presence_menu', 'true');
  // zx_20261005 M7(K-4 试用) + zx_20261016_4(补·试用**不可重置**):
  //   14 天全功能试用；此值＝`resolveLicenseState` 判"试用中/已过期"的唯一时间锚（读到非法值/无此行 ⇒
  //   community，兜底判在 `license.ts`，不在此处）。
  //   ⚠ 原实现只用 `ensureSetting` 写**库内一行**（`ensureSetting` 只在缺时插）⇒ **删掉那行**即让下次启动
  //     把"此刻"重算进去 ⇒ 试用永远重置，且经 `team-gate.ts` 顺带白拿全部 Team 能力。
  //   今改为**两处锚点取早者**：库内这行 + 库外封印 `license-anchor.json`；每次启动裁决后**回写两处**，
  //     任一侧被删/被改成未来时刻，都由另一侧顶回（详见 `core/license-anchor.ts` 头注释的诚实边界）。
  const trialSealPath = path.join(dataDir, TRIAL_ANCHOR_FILENAME);
  const trialRow = db.prepare('SELECT value FROM wa_settings WHERE key=?').get(LICENSE_SETTING_KEYS.trialStartedAt) as
    | { value?: string }
    | undefined;
  const trialAnchor = resolveTrialAnchor({
    dbValue: trialRow?.value,
    sealValue: readSeal(trialSealPath),
    now: new Date(),
  });
  // 回写用 `INSERT OR REPLACE`（不是 `ensureSetting` 的"只在缺时插"）——自愈那一跳靠的就是它能把被删的行写回来。
  db.prepare("INSERT OR REPLACE INTO wa_settings (key,value,updated_at) VALUES (?,?,datetime('now'))")
    .run(LICENSE_SETTING_KEYS.trialStartedAt, trialAnchor.startIso);
  if (!writeSeal(trialSealPath, trialAnchor.startIso)) {
    console.warn(`[DB] 试用封印文件写入失败——起算点仅存于库内，可被重置：${trialSealPath}`);
  }
  // zx_20261012_2 批一（策略可配）: 熔断/通知策略的阈值与窗口 + 策略闸开关。
  //   此前这些值全写在 `policy-engine.ts` 源码里、`wa_settings` 无键 ⇒ 用户无处可调。
  //   阈值缺省**由 `DEFAULT_POLICIES` 派生**（`policySettingDefaults()`），此处只登记键、不手抄数字。
  for (const [k, v] of policySettingDefaults()) ensureSetting(k, v);
  ensureSetting('engine.policy_check', 'true');
  // zx_20261014_4 批一（道德经·善闭无关楗而不可开）: **入站门**——**显式缺省关**。
  //   ⚠ 这一行不是"顺手登记"：`boolSetting` 的判据是"只有明确说关才算关"（缺省即开），
  //     漏此行的机器会把入站端口默认敞开在局域网上。反证断言见 `scripts/rr_zx_20261014_4.ts` G-1b。
  ensureSetting('node.external_inbound', 'false');

  // ===== 种子数据：默认管理员 =====
  const seedAdmin = db.prepare('SELECT id FROM wa_users WHERE email = ?').get('admin@worker-ant.local');
  if (!seedAdmin) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHash('sha256').update(salt + 'admin123').digest('hex');
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO wa_users (id, email, name, role) VALUES (?, ?, ?, 'super_admin')").run(id, 'admin@worker-ant.local', '管理员');
    db.prepare('INSERT INTO wa_user_credentials (user_id, password_hash) VALUES (?, ?)').run(id, `${salt}:${hash}`);
    console.log('[DB] 已创建默认管理员: admin@worker-ant.local / admin123');
  }

  // ===== B1: 任务模板种子化（内置模板 source='system'；后续匹配从表读取）=====
  // zx_20261005 M15：由「表空才种子」改为**逐 id `INSERT OR IGNORE`**——否则新增的内置示例模板
  //   只对新库可见，已装用户的库里永远补不上（上手第一跳的"跑出第一个成果"就少了现成素材）。
  //   `OR IGNORE` 使已存在行（含用户编辑过/禁用过的系统模板）**不被回写覆盖**，即增不改。
  const insTpl = db.prepare('INSERT OR IGNORE INTO wa_task_templates (id, name, category, description, subtasks, keywords, status, priority, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let seeded = 0;
  for (const tpl of Object.values(TASK_TEMPLATES)) {
    const r = insTpl.run(tpl.id, tpl.name, tpl.category, tpl.description, JSON.stringify(tpl.subtasks), JSON.stringify(tpl.keywords), 'active', 0, 'system');
    seeded += r.changes;
  }
  if (seeded > 0) console.log('[DB] 已种子化任务模板:', seeded, '/', Object.keys(TASK_TEMPLATES).length);

  // 启动时重置残留状态（IM渠道不再重置，由initImIpc的启动恢复逻辑接管）
  // zx_20260917 M1: 逐条走 `pauseTask`（唯一写入口）——批量 UPDATE 落不下「因」，事后无人知道
  // 这批任务是"上一进程残留"还是"用户按了暂停"。注：此处尚无 eventStore，`emit` 内已 try/catch。
  const residual = db.prepare("SELECT id FROM wa_tasks WHERE status IN ('executing','preparing')").all() as Array<{ id: string }>;
  for (const t of residual) {
    pauseTask(db, { taskId: t.id, reason: PAUSE_REASON_STARTUP_SWEEP });
  }

  console.log('[DB] 数据库已初始化:', dbPath);
  return db;
}
