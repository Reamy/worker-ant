/**
 * zx_20261004 M7/M9（庄子·齐物论「道在屎溺／不预设」/ 罗尔斯·同一把尺 / 康德·自由以他人自由为界）:
 * **局域网设备台账 + 控制授权闸 + 审计**的**语义单一真源**。
 *
 * 三件事各自只在这里有一份：
 *   ① **台账**（`wa_devices`）：发现来的设备按 `protocol + address` **幂等**入账（同设备二次发现是**刷新**
 *      不是新增）；能力字段（`kind`/`capabilities`/`controllable`）**一律取设备自述**，本模块不自造
 *      （庄子·不预设——不拿自己的想法替万物立规矩）。
 *   ② **控制闸**（K-6 `deviceControlVerdict`）：`device_control` 能不能执行，**只问这一个函数**——
 *      "他处若另写一份判据，就与这份漂开"（罗尔斯·同一把尺）。未授权只可读、门锁/安防类即便授权也拒（§4 #4）。
 *   ③ **审计**（`wa_device_actions`）：每次控制**含被拒**都留痕（"控制全量留痕"）。
 *
 * ⚠ 本文件**零网络依赖**（不引 electron / 不引 bonjour-service / node-ssdp）——纯 DB 语义，
 *   故受控回归可**直引跑真实现**（同 `node-identity.ts` / `memory-lifecycle.ts` 范式）。
 *   真网络发现是 `device-discovery.ts` 的事，与台账读写**分开**。
 * ⚠ DDL 不在此处：建表在 `database.ts`（同 `wa_service_calls` 范式——那里只建表，语义在这里）。
 */
import { randomUUID } from 'node:crypto';

/**
 * 读/写设备台账的最小库接口（`NodeSettingDb`/`AnsSettingDb` 同形）——
 * 使本模块可脱 better-sqlite3 被 rr（`node:sqlite`）直跑。
 */
export interface DeviceDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): unknown;
  };
}

/** 发现协议（`protocol-agnostic` 的落点：同一设备换协议即另一行，故去重键含协议）。 */
export type DeviceProtocol = 'mdns' | 'ssdp' | 'http' | 'mqtt';

/** 设备台账行（`wa_devices` 的投影；见 `database.ts` 建表注释）。 */
export interface AnsDevice {
  id: string;
  /** 设备**自述**的名（每次发现**会被覆写**——它是设备的自称，不是我们给它的名）。 */
  name: string;
  /**
   * **用户叫它的名**（zx_20261014_1 批二；道德经·名可名非常名）。空串=未起别名。
   * 与 `name` 并存：`name` 是设备的自称，`alias` 是我们的叫法——发现**永不写它**（同 `authorized` 待遇）。
   * "按名使唤"用的是 **`alias || name`**，解析真源见 `resolveDeviceByName`。
   */
  alias: string;
  /** 设备**自述**的类别（自由串，非枚举——mDNS/SSDP 的自述五花八门，硬套枚举即"预设"）。 */
  kind: string;
  protocol: DeviceProtocol;
  address: string;
  port: number | null;
  /** 设备**自述**的能力清单（service type / TXT 键派生），不自造。 */
  capabilities: string[];
  /** 是否**具备**可控能力（自述）——与 `authorized` 是两件事：能控 ≠ 许控。 */
  controllable: boolean;
  /** 用户是否**显式授权**控制（K-6）——缺省 false，只读。 */
  authorized: boolean;
  /** 最近一次状态快照（自述/查询所得）；未知为 `null`（"不知道"不等于"空对象"）。 */
  status: Record<string, unknown> | null;
  /**
   * **在线态**（zx_20261015_3 批三；道德经·知止不殆）——**三态**：`null`=未知 / `true`=在 / `false`=不在。
   * ⚠ **只由可用性事件**（HA 的 LWT / `avty` 主题）驱动（唯一写点 `setDeviceOnline`）；
   *   **绝不**从 discovery 载荷推断（retain 会重放旧值 ⇒ "台账里有它" ≠ "它在线"）。
   * ⚠ 与 `last_seen`（"我们何时见过它"）是**两件事**：见过 ≠ 此刻在；设备没说 ⇒ 如实留 `null`，不猜"在"。
   */
  online: boolean | null;
  first_seen: string;
  last_seen: string;
}

/** 发现器交上来的候选——**只带自述字段**，无授权、无状态（那是台账与授权面的事）。 */
export interface DiscoveredDevice {
  name: string;
  kind: string;
  protocol: DeviceProtocol;
  address: string;
  port?: number | null;
  capabilities?: string[];
  controllable?: boolean;
}

/**
 * 一次控制的**发起者**（zx_20261016_2）。
 * `task` = AI 任务里的 `device_control` 工具（`ref` ⇒ task_id）；
 * `panel` = 设备面板手动（无 ref）；`external` = 外部 AI 终端经门（`ref` ⇒ terminal_id）。
 * 空串 `''` = **认不出**（历史行 / 未知来源）——如实不猜，面板据此不渲染来源标签。
 */
export type DeviceActionActorKind = 'task' | 'panel' | 'external' | '';

/** 一条控制审计（`wa_device_actions` 的投影）。 */
export interface DeviceActionRow {
  id: string;
  device_id: string;
  action: string;
  args: Record<string, unknown>;
  /** `ok` / `denied` / `error` —— 被拒也留一行（"全量留痕"含拒绝件）。 */
  result: string;
  task_id: string;
  /** 发起者类别（见 `DeviceActionActorKind`）；`''` ⇒ 认不出。 */
  actor_kind: string;
  /** 发起者的稳定 id（`task` ⇒ task_id，`external` ⇒ terminal_id，其余 ⇒ 空串）。 */
  actor_ref: string;
  created_at: string;
}

/**
 * 写库时刻（DB 格式 UTC 串）——与库内 `datetime('now')` **同基准同格式**
 * （SQLite `datetime('now')` 亦为 UTC `YYYY-MM-DD HH:MM:SS`）。注入 `now` 以便受控回归定时刻。
 */
function dbNowUtc(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** DB 行 → `AnsDevice`（一处投影，读写两侧同形）。 */
function rowToDevice(row: Record<string, unknown>): AnsDevice {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    alias: String(row.alias ?? ''),
    kind: String(row.kind ?? 'unknown'),
    protocol: row.protocol as DeviceProtocol,
    address: String(row.address ?? ''),
    port: typeof row.port === 'number' ? row.port : null,
    capabilities: parseJson<string[]>(row.capabilities_json, []),
    controllable: Number(row.controllable) === 1,
    authorized: Number(row.authorized) === 1,
    status: row.status_json == null ? null : parseJson<Record<string, unknown>>(row.status_json, {}),
    // 三态：`NULL`/缺列 ⇒ `null`（未知）；`1` ⇒ true；`0` ⇒ false。**不**把"没这列"读成"不在"。
    online: row.online == null ? null : Number(row.online) === 1,
    first_seen: String(row.first_seen ?? ''),
    last_seen: String(row.last_seen ?? ''),
  };
}

const DEVICE_COLUMNS = 'id, name, alias, kind, protocol, address, port, capabilities_json, controllable, authorized, status_json, online, first_seen, last_seen';

/** 按**去重键**（`protocol + address`）取行——幂等 upsert 的查找面，也是"同一设备"的唯一判据。 */
export function findDeviceByIdentity(db: DeviceDb, protocol: string, address: string): AnsDevice | null {
  const row = db.prepare(`SELECT ${DEVICE_COLUMNS} FROM wa_devices WHERE protocol = ? AND address = ?`).get(protocol, address) as Record<string, unknown> | undefined;
  return row ? rowToDevice(row) : null;
}

/**
 * 幂等入账：按 `protocol + address` 去重。
 *  - **首次**见到 ⇒ 新增一行（`id` 新生成，`authorized` **恒从 false 起**——发现不等于授权）；
 *  - **再次**见到 ⇒ **刷新**自述字段与 `last_seen`，**绝不**覆盖 `authorized`（用户意志不被发现冲掉）
 *    与 `first_seen`（首见时刻是史实）。
 */
export function upsertDiscovered(db: DeviceDb, dev: DiscoveredDevice, now?: string): AnsDevice {
  const t = now ?? dbNowUtc();
  const caps = JSON.stringify(dev.capabilities ?? []);
  const controllable = dev.controllable ? 1 : 0;
  const existing = findDeviceByIdentity(db, dev.protocol, dev.address);
  if (existing) {
    // ⚠ 这条 UPDATE 只盖**自述**字段——`alias` 与 `authorized`/`first_seen` 一样**不在其中**：
    //   发现只刷新"设备是什么"，不覆盖"我们叫它什么"与"我们准不准它"（zx_20261014_1 批二）。
    db.prepare('UPDATE wa_devices SET name = ?, kind = ?, port = ?, capabilities_json = ?, controllable = ?, last_seen = ? WHERE id = ?')
      .run(dev.name, dev.kind, dev.port ?? null, caps, controllable, t, existing.id);
  } else {
    // 首见：`alias` 落**空串**（新设备还没有我们的叫法——不从自述名顺手抄一个，那是两件事混作一件）；
    //   `online` 落 **NULL**（刚发现不等于在线——如实"未知"，等可用性事件来改）。
    db.prepare(`INSERT INTO wa_devices (${DEVICE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`)
      .run(randomUUID(), dev.name, '', dev.kind, dev.protocol, dev.address, dev.port ?? null, caps, controllable, t, t);
  }
  return findDeviceByIdentity(db, dev.protocol, dev.address)!;
}

/** 全部设备台账（最近见到在前）。 */
export function listDevices(db: DeviceDb): AnsDevice[] {
  const rows = db.prepare(`SELECT ${DEVICE_COLUMNS} FROM wa_devices ORDER BY last_seen DESC`).all() as Array<Record<string, unknown>>;
  return rows.map(rowToDevice);
}

/** 按 id 取一行；不存在 ⇒ `null`（不把"没找到"当成"空设备"）。 */
export function getDevice(db: DeviceDb, id: string): AnsDevice | null {
  const row = db.prepare(`SELECT ${DEVICE_COLUMNS} FROM wa_devices WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToDevice(row) : null;
}

/**
 * 按名解析的结果（zx_20261014_1 批三）。`ok:false` 时**不猜**：
 *   `ambiguous` 并列候选交调用方去挑（私人语言不成立——名字若不能唯一指向，就得让命名者自己选）；
 *   `not_found` 候选为空（不把"查无此名"当成"随便一台"）。
 */
export type DeviceResolveResult =
  | { ok: true; device: AnsDevice }
  | { ok: false; reason: 'not_found' | 'ambiguous'; candidates: AnsDevice[] };

/**
 * zx_20261014_1 批三（维特根斯坦·意义即用法）: **按名使唤**的唯一解析口——工具与面板"用名字控制"都问它。
 *
 * 次序：**id**（uuid，精确、不经归一）→ **别名**（trim 归一 + 大小写不敏感精确）→ **自述名**（同归一）。
 * 别名优先于自述名：别名是用户**刻意的指派**，比设备自称更权威（名可名非常名）。
 * 同一档命中多台 ⇒ `ambiguous` **并列候选**，绝不替用户猜一个；两档皆空 ⇒ `not_found`。
 */
export function resolveDeviceByName(db: DeviceDb, key: string): DeviceResolveResult {
  const k = key.trim();
  if (!k) return { ok: false, reason: 'not_found', candidates: [] };
  const byId = getDevice(db, k);
  if (byId) return { ok: true, device: byId };
  const norm = (s: string) => s.trim().toLowerCase();
  const kk = norm(k);
  const all = listDevices(db);
  const aliasHits = all.filter((d) => d.alias !== '' && norm(d.alias) === kk);
  if (aliasHits.length === 1) return { ok: true, device: aliasHits[0] };
  if (aliasHits.length > 1) return { ok: false, reason: 'ambiguous', candidates: aliasHits };
  const nameHits = all.filter((d) => d.name !== '' && norm(d.name) === kk);
  if (nameHits.length === 1) return { ok: true, device: nameHits[0] };
  if (nameHits.length > 1) return { ok: false, reason: 'ambiguous', candidates: nameHits };
  return { ok: false, reason: 'not_found', candidates: [] };
}

/** 改**授权开关**（M9 UI 的唯一写点）。返回改后的行；设备不存在 ⇒ `null`。 */
export function setDeviceAuthorized(db: DeviceDb, id: string, authorized: boolean, now?: string): AnsDevice | null {
  const row = db.prepare('SELECT id FROM wa_devices WHERE id = ?').get(id) as { id?: string } | undefined;
  if (!row?.id) return null;
  db.prepare('UPDATE wa_devices SET authorized = ?, last_seen = ? WHERE id = ?').run(authorized ? 1 : 0, now ?? dbNowUtc(), id);
  return getDevice(db, id);
}

/**
 * 改**别名**（"我叫它什么"，zx_20261014_1 批二的唯一写点）。返回改后的行；设备不存在 ⇒ `null`。
 * `''`（或纯空白）⇒ **清除别名**，此后回到设备的自述名——清除是**合法操作**，不是错误。
 *
 * ⚠ 长度上限 64：别名要进提示语与候选列表，不限长则一句话会被撑爆（只管截断，不改写内容）。
 * ⚠ **发现永不调用它**（`upsertDiscovered` 的 UPDATE 里没有 `alias`）——这条纪律是本列存在的理由。
 * ⚠ 刻意**不**动 `last_seen`：那是"最近见到该设备"（在场事实），改名不是见到它——写了即伪造在场。
 *   （`setDeviceAuthorized` 会顺手刷 `last_seen`，那是既有行为，不在本轮改动面内。）
 */
export function setDeviceAlias(db: DeviceDb, id: string, alias: string): AnsDevice | null {
  const row = db.prepare('SELECT id FROM wa_devices WHERE id = ?').get(id) as { id?: string } | undefined;
  if (!row?.id) return null;
  db.prepare('UPDATE wa_devices SET alias = ? WHERE id = ?').run(alias.trim().slice(0, 64), id);
  return getDevice(db, id);
}

/**
 * 写**在线态**（zx_20261015_3 批三的唯一写点；道德经·知止不殆）。返回改后的行；设备不存在 ⇒ `null`。
 *
 * ⚠ **只由可用性事件驱动**（HA 的 LWT / `avty` 主题）——调用方**绝不**从 discovery 载荷推在线
 *   （retain 会重放旧值；"台账里有它" ≠ "它在线"，承 `zx_20261014_1` §四.4 教训）。
 * ⚠ **三态如实**：`online=true`（在）/ `false`（不在）/ `null`（未知）都可写——认不出载荷即**不写**，留旧值。
 * ⚠ **不动 `last_seen`**：那是"我们何时见过它"（历史），在线态是"它此刻在不在"（当下）——两件事，各写各的列。
 */
export function setDeviceOnline(db: DeviceDb, id: string, online: boolean | null, _now?: string): AnsDevice | null {
  const row = db.prepare('SELECT id FROM wa_devices WHERE id = ?').get(id) as { id?: string } | undefined;
  if (!row?.id) return null;
  db.prepare('UPDATE wa_devices SET online = ? WHERE id = ?').run(online == null ? null : online ? 1 : 0, id);
  return getDevice(db, id);
}

/** 写**状态快照**（发现/查询所得）。设备不存在 ⇒ `null`。 */
export function setDeviceStatus(db: DeviceDb, id: string, status: Record<string, unknown>, now?: string): AnsDevice | null {
  const row = db.prepare('SELECT id FROM wa_devices WHERE id = ?').get(id) as { id?: string } | undefined;
  if (!row?.id) return null;
  db.prepare('UPDATE wa_devices SET status_json = ?, last_seen = ? WHERE id = ?').run(JSON.stringify(status), now ?? dbNowUtc(), id);
  return getDevice(db, id);
}

/**
 * 落一条**控制审计**，返回其 id。`result` 记 `ok`/`denied`/`error`——**被拒同样留痕**。
 * `actor` 记**发起者**（zx_20261016_2）：`task` 时顺带把 `ref` 也写进 `task_id`（既有列语义不变，
 * `taskRefsOf` 照旧可用）；`panel`/`external` 只写 `actor_kind`/`actor_ref`，`task_id` 留空。
 */
export function recordDeviceAction(
  db: DeviceDb,
  entry: {
    deviceId: string;
    action: string;
    args?: Record<string, unknown>;
    result: string;
    taskId?: string;
    actor?: { kind: DeviceActionActorKind; ref?: string };
  },
  now?: string,
): string {
  const id = randomUUID();
  const kind = entry.actor?.kind ?? '';
  const ref = entry.actor?.ref ?? '';
  db.prepare('INSERT INTO wa_device_actions (id, device_id, action, args_json, result, task_id, actor_kind, actor_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, entry.deviceId, entry.action, JSON.stringify(entry.args ?? {}), entry.result, entry.taskId ?? '', kind, ref, now ?? dbNowUtc());
  return id;
}

/** 控制审计（可选按设备过滤），最近在前。 */
export function listDeviceActions(db: DeviceDb, deviceId?: string, limit = 50): DeviceActionRow[] {
  const cols = 'id, device_id, action, args_json, result, task_id, actor_kind, actor_ref, created_at';
  const rows = (deviceId
    ? db.prepare(`SELECT ${cols} FROM wa_device_actions WHERE device_id = ? ORDER BY created_at DESC LIMIT ?`).all(deviceId, limit)
    : db.prepare(`SELECT ${cols} FROM wa_device_actions ORDER BY created_at DESC LIMIT ?`).all(limit)
  ) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    device_id: String(r.device_id),
    action: String(r.action),
    args: parseJson<Record<string, unknown>>(r.args_json, {}),
    result: String(r.result ?? ''),
    task_id: String(r.task_id ?? ''),
    actor_kind: String(r.actor_kind ?? ''),
    actor_ref: String(r.actor_ref ?? ''),
    created_at: String(r.created_at ?? ''),
  }));
}

/** 留痕行的「任务引用」——人与面板认得出的那两件（机器认的是 `task_id`）。 */
export interface TaskRef {
  /** 任务标题（**此刻**库里的值，非落痕时的快照）。 */
  title: string;
  /** 所属项目名；任务无项目 / 项目已删 ⇒ 空串（如实，不造名）。 */
  projectName: string;
}

/**
 * zx_20261014_3 批一（维特根斯坦·意义即用法 / 罗尔斯·同一把尺）: 留痕要认得出来**是谁在做的**。
 *
 * 面板此前只印 `task_id.slice(0,8)`——一串 uuid 前缀，在人这一侧**不指任何东西**（机器认的名 ≠ 人认的名）。
 * 本函数把 `task_id` 现查成「任务标题 + 所属项目名」，与**设备名**同一把尺（`zx_20261014_1` 批一已如此）。
 *
 * ⚠ **读时现查、不留快照**：标题/项目名**绝不**写进 `wa_device_actions`（名字会变；同 `recordDeviceAction`
 *   拒冗余存设备名的理由）。若在此缓存，改名后留痕就显旧名。
 * ⚠ **查无此任务 ⇒ 不进 map**（不造名、不落空壳）——调用方据此**如实回退** id 前 8 位，不假装它还在。
 * ⚠ **逐条查**（非动态 `IN (?)` 拼占位符）：承 `zx_20261003` §7「占位符错绑 ⇒ 静默为空」的教训；
 *   条数 = 审计条数（默认 ≤ 50），代价可忽略。空/重复 id 在入口滤掉，不发无谓查询。
 */
export function taskRefsOf(db: DeviceDb, taskIds: string[]): Map<string, TaskRef> {
  const refs = new Map<string, TaskRef>();
  const stmt = db.prepare(
    'SELECT t.title AS title, p.name AS project_name FROM wa_tasks t'
    + ' LEFT JOIN wa_projects p ON t.project_id = p.id WHERE t.id = ?',
  );
  for (const id of new Set(taskIds)) {
    if (!id) continue;
    const row = stmt.get(id) as { title?: unknown; project_name?: unknown } | undefined;
    if (!row) continue; // 查无此任务 ⇒ 不造名
    refs.set(id, { title: String(row.title ?? ''), projectName: String(row.project_name ?? '') });
  }
  return refs;
}

// ==================== 控制闸（K-6 · 一处真源） ====================

/**
 * 高危设备类别（§4 边界 #4）：门锁/安防类**即便用户授权也不放行写操作**——本轮仅可读。
 * 只做"允许控制"白名单还不够：把开锁这件事交给一次点击批准，代价与收益不对称（康德·自由以他人自由为界）。
 * 列表是**排除**名单，比对时取设备**自述 kind** 的小写归一，命中即拒。
 */
export const HIGH_RISK_DEVICE_KINDS: ReadonlySet<string> = new Set([
  'lock', 'doorlock', 'door', 'garage', 'gate', 'safe', 'alarm', 'security', 'camera', 'sensor.lock',
]);

export function isHighRiskKind(kind: string): boolean {
  return HIGH_RISK_DEVICE_KINDS.has(kind.trim().toLowerCase());
}

/** 控制闸的裁定——`ok:false` 时 `how` 是**可行动的下一步**（照 `run_privileged` 的引导形状，不自造文案壳）。 */
export type DeviceControlVerdict =
  | { ok: true }
  | { ok: false; reason: 'unknown_device' | 'high_risk' | 'not_controllable' | 'not_authorized'; how: string };

/**
 * 一次控制的**结果形状**（工具返回体 / 面板返回体**同形**；编排在 `tools/device.ts` 的 `runDeviceControl`）。
 * 被拒时不是"光秃秃的 false"：`reason` 是机器可读的判据档位，`how_to_authorize` 是可行动的下一步。
 * 定义在此（零依赖的语义模块）——renderer 侧 `import type` 取它不牵入 main 运行时依赖。
 */
export type DeviceControlOutcome =
  | { ok: boolean; deviceId: string; action: string; result: string }
  | { ok: false; denied: true; reason: string; deviceId: string; action: string; error: string; how_to_authorize: string };

/**
 * `device_control` 能不能执行——**只问这一个函数**（判据面亦直跑它，两侧标本）。
 * 次序：不存在 → 高危 → 自述不可控 → 未授权。**每一项都给出下一步**，不返回光秃秃的 false。
 */
export function deviceControlVerdict(dev: AnsDevice | null): DeviceControlVerdict {
  if (!dev) return { ok: false, reason: 'unknown_device', how: '该设备不在台账中——请先到「设备」面板发现/登记它，再重试。' };
  if (isHighRiskKind(dev.kind)) {
    return { ok: false, reason: 'high_risk', how: `「${dev.name}」属门锁/安防类高危设备，本轮**不开放**写操作（只读状态）。如确需控制，请在本机直接操作。` };
  }
  if (!dev.controllable) {
    return { ok: false, reason: 'not_controllable', how: `「${dev.name}」自述不具备可控能力（只读设备），无法下发控制命令。` };
  }
  if (!dev.authorized) {
    return { ok: false, reason: 'not_authorized', how: `「${dev.name}」尚未授权控制——请在「设备」面板打开它的「允许控制」开关，再重试。` };
  }
  return { ok: true };
}
