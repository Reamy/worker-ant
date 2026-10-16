/**
 * zx_20260906 批1 (2026-09-06): 成果经络贯通——wa_deliverables 状态机真流转 + 事件真源。
 *
 * 背景：此前 deliverable 状态散落多处直写 DB、无统一发射；`status='registered'` 全库零写入、
 * `deliverable.registered` 事件无 producer（死事件）；doc 产出物写完永远 draft。本模块收敛：
 * 状态变更一律经 `setDeliverableStatus`（幂等：同值不重写不重发），真变更即发射
 * `deliverable.status_changed`（registered 走既有 `deliverable.registered`）。
 * 事件 payload 同时带 camelCase 与 snake_case，与 task.* 事件风格一致，renderer 按需读取。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { eventBus } from './event-bus.js';
import { isAcceptanceVerified, type AcceptanceCheckLike } from './acceptance-check.js';
import { boolSetting, readBoolSetting } from './settings-bool.js';
import { ACCEPTANCE_TYPES, PRIMARY_TYPES, FILE_DELIVERABLE_TYPES, isAcceptanceType, isDocPath, isModuleFilePath, isServiceType, typeIn } from './deliverable-types.js';

export interface DeliverableRow {
  id: string;
  project_id: string | null;
  task_id: string | null;
  name: string | null;
  type: string | null;
  old_status: string;
}

export interface SetStatusResult {
  id: string;
  status: string;
  changed: boolean;
  exists: boolean;
}

const SELECT_ROW = 'SELECT id, project_id, task_id, name, type, status AS old_status FROM wa_deliverables WHERE id = ?';

function lookupDeliverable(db: Database.Database, id: string): DeliverableRow | undefined {
  return db.prepare(SELECT_ROW).get(id) as DeliverableRow | undefined;
}

/** zx_20260911_2 M4-G6(赫布·成对联结): 产出物事件的**唯一起草处**——注册/状态变更 payload 同形(双写别名)。
 *  供状态机(setDeliverableStatus)与**手工入口**(create/update/delete/setPrimary)共用，
 *  使手工改成果与引擎改成果走同一条事件通道(此前手工入口零事件 ⇒ 交付单/项目卡/活动流不刷新)。 */
export function emitDeliverableEvent(row: { id: string; project_id: string | null; task_id: string | null; name: string | null; type: string | null }, status: string, via: string, changedFrom: string): void {
  const payload: Record<string, unknown> = {
    deliverableId: row.id,
    deliverable_id: row.id,
    projectId: row.project_id ?? '',
    project_id: row.project_id ?? null,
    taskId: row.task_id ?? '',
    task_id: row.task_id ?? null,
    name: row.name ?? '',
    type: row.type ?? '',
    status,
    changedFrom,
    via,
    ts: new Date().toISOString(),
  };
  void eventBus.emit(status === 'registered' ? 'deliverable.registered' : 'deliverable.status_changed', payload).catch(() => {});
}

/** 按 id 读取事件所需的最小行(手工入口在写库后重取用)。 */
export function loadDeliverableRow(db: Database.Database, id: string): DeliverableRow | undefined {
  return lookupDeliverable(db, id);
}

/** `findDeliverableByPath` 的返回行——查重命中时调用方要用的字段。 */
export interface DeliverablePathRow {
  id: string;
  task_id: string | null;
  type: string;
  name: string;
  status: string;
}

/**
 * **「这个文件在本次工程下已经是谁的成果」的唯一查重语句**（zx_20260928 M3：墨家「同」——重同／体同／合同／类同）。
 *
 * 口径取 **project 级**：同一工程下同一 `file_path` 至多应有一行产出物，**无论它由哪个任务登记**。
 * 此前四条路各按各的口径查重——`write_file`/`edit_file` 路 project 级（正确）、
 * `register_deliverable`/`create_deliverable` 路 **task 级**、`deliverable:create` IPC **完全不去重**
 * ——于是一次登记走哪个入口会得到不同结果，真库落出 11+ 对 `(project_id, file_path)` 的重复行
 * （活标本：`plans/mp/api.md` 父任务名下 34 版、子任务名下 0 版）。
 *
 * 全仓只此一条查重语句：四处调用点（`ensureDocDeliverable` / `register_deliverable` /
 * `create_deliverable` / `deliverable:create` IPC）一律调它。
 *
 * ⚠ **跨任务命中 ⇒ 只返回既有行，调用方绝不改它的 `task_id`**（不夺归属，承 zx_20260913 M2-2）。
 * 由此**如实**产生一个后果：子任务写了登记在父任务名下的文件 ⇒ 子任务自己名下没有行 ⇒
 * 该子的 `delivs.c` 为 0，可能合法地触发 CAP1/CAP2。这不是新引入的行为（`write_file` 路今天已如此）。
 */
export function findDeliverableByPath(
  db: Database.Database,
  o: { projectId: string; filePath: string },
): DeliverablePathRow | undefined {
  return db.prepare('SELECT id, task_id, type, name, status FROM wa_deliverables WHERE project_id = ? AND file_path = ? LIMIT 1')
    .get(o.projectId, o.filePath) as DeliverablePathRow | undefined;
}

/**
 * 幂等推进产出物状态。状态真变更时写库并发射事件；同值变更默认不重发（forceEmit 可强制，
 * 用于"新行落库即通报"场景）。事件类型：registered → deliverable.registered，其余 → deliverable.status_changed。
 */
export function setDeliverableStatus(
  db: Database.Database,
  id: string,
  status: string,
  via = 'system',
  opts?: { forceEmit?: boolean },
): SetStatusResult {
  const row = lookupDeliverable(db, id);
  if (!row) return { id, status, changed: false, exists: false };

  const same = row.old_status === status;
  if (!same) {
    db.prepare("UPDATE wa_deliverables SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  }
  if (same && !opts?.forceEmit) return { id, status, changed: false, exists: true };

  emitDeliverableEvent(row, status, via, row.old_status);
  return { id, status, changed: !same, exists: true };
}

/**
 * zx_20260930 M3-c（庄子「名者，实之宾也」/ 维特根斯坦·同一把尺）：**「建一条成果」的唯一落库口径**。
 *
 * 病根：本仓有**四条**创建成果的路——`write_file` 的 `ensureDocDeliverable`、
 *   `create_deliverable` 工具、`register_deliverable` 工具、IPC `deliverable:create`（GUI 手工建）。
 *   它们各有各的校验、各有各的通报，同一条规则两处是两个答案：
 *   ① **校验**：`create_deliverable` 会拦「`.md` 标成 mcp」与「`tools/` 下的模块标成服务型」，
 *      而 GUI 那条**一条校验都没有** ⇒ 一次点击就能登记出 `type='mcp'` 的 `.md`（名不副实的行）。
 *   ② **通报**：同一个"新建了一条草稿"的事实，agent 路发
 *      `deliverable.status_changed(status='draft')`、GUI 路发
 *      `deliverable.registered(status='registered')`——后者**名不副实**：库里那一行是 `draft`，
 *      而 `registered` 在本仓的词义是"已注册到 ANS"（`docs/api.md`、`event-bus` 聚合映射、
 *      `deliverable:register` 这一真实生产者皆如此），可这条行**从未**碰过 ANS。
 *
 * 本函数收敛**校验 → 去重 → 落库 → 通报**四步，供 `create_deliverable` 工具与
 *   `deliverable:create` IPC **两条路共用**。
 *   `ensureDocDeliverable`（有属主守卫 + 强制 `type='doc'`）与 `register_deliverable`
 *   （要落 v1 版本快照、且 `filePath` 必填）**未并入**——语义确有差异，强并会把差异藏起来。
 *   但它们与本函数**共用同一条查重语句**（`findDeliverableByPath`）与**同一份类型判据**
 *   （`deliverable-types.ts`）⇒「口径同源、落库流程各异」，边界如实登记。
 *
 * 本函数**不**回 ANS 注册：那是 `deliverable:register` / 启动流程的事，此处只落**本地草稿**。
 */
export interface CreateDeliverableInput {
  projectId: string;
  /** 归属任务；缺省/空串 = 项目级手工件（`task_id IS NULL`） */
  taskId?: string | null;
  name: string;
  type: string;
  description?: string;
  /** **调用方已归一**、将被存进 `file_path` 的路径（引擎侧存绝对路径；GUI 侧按传入串逐字存）；空 = 未挂文件 */
  filePath?: string | null;
  /**
   * 报错文案里引用的路径。缺省取 `filePath`。
   * 之所以可与 `filePath` 不同：引擎侧先把相对路径归一成绝对路径、且**文件不存在则视同未挂**
   * （`fp = ''`），而校验须按**用户/模型给的原串**判并引用——否则"不存在的 `.md` 标成 mcp"
   * 会从校验下漏过去（这是既有行为，本函数不改变它的松紧）。
   */
  pathLabel?: string;
  /** 事件 `via`（如 `create_deliverable` / `manual:create`）——事件要能倒查是哪条路写的 */
  via: string;
}

export type CreateDeliverableResult =
  | { ok: true; id: string; created: boolean; name: string; type: string; status: string; filePath: string | null }
  | { ok: false; reason: 'doc_as_service' | 'module_as_service'; message: string };

export function createDeliverable(db: Database.Database, input: CreateDeliverableInput): CreateDeliverableResult {
  const filePath = String(input.filePath ?? '').trim();
  const label = String(input.pathLabel ?? filePath).trim();
  const type = String(input.type ?? '').trim();
  const name = String(input.name ?? '').trim();

  // ① 结构校验：文档不得标服务型；模块目录下的文件不是服务入口。
  //    三条判据（`isServiceType`/`isDocPath`/`isModuleFilePath`）取自 `deliverable-types.ts` 同一份真源，
  //    与 agent 侧字面析取时代**一字不差**地同尺——GUI 侧由此第一次拥有该校验。
  if (isServiceType(type)) {
    if (isDocPath(label)) {
      return { ok: false, reason: 'doc_as_service', message: `文件"${label}"是文档类型(.md/.txt)，不能标记为type="${type}"。请使用type="doc"。` };
    }
    if (isModuleFilePath(label)) {
      return { ok: false, reason: 'module_as_service', message: `文件"${label}"位于模块目录(tools/modules/lib/plugins)，是工具模块而非独立服务入口，不能标记为type="${type}"。服务类型仅用于服务入口(如 xxx_server.py)；工具模块请用type="doc"。` };
    }
  }

  // ② 去重（**只返回既有行，绝不改它**——不夺归属，承 zx_20260913 M2-2）：
  //    有路径 ⇒ **工程级**，走全仓唯一查重语句 `findDeliverableByPath`；
  //    无路径但挂了任务 ⇒ 本任务内**同名**（那是**名称**口径，路径口径管不到）；
  //    无路径也无任务（项目级手工件）⇒ **不去重**（无任何能指认"同一个东西"的键，
  //    硬按名字去重会新造一个拒绝面），允许同名多条——如实登记，不猜。
  const existing = filePath
    ? findDeliverableByPath(db, { projectId: input.projectId, filePath })
    : input.taskId
      ? db.prepare('SELECT id, name, type, status FROM wa_deliverables WHERE task_id = ? AND name = ?').get(input.taskId, name)
      : undefined;
  if (existing) {
    // `type` 回**行里真实的值**，不回请求值（zx_20260928 M4「名者，实之宾也」：行是 doc 而请求是 daemon 时，
    // 报请求值就是把"另一个值"当成了结果）。
    const ex = existing as { id: string; name: string; type: string; status: string };
    return { ok: true, id: ex.id, created: false, name: ex.name, type: ex.type, status: ex.status, filePath: filePath || null };
  }

  // ③ 落库：status 固定 `'draft'`——刚建出来就是草稿，**不预先冒充** running/registered。
  //    列清单与另三条创建路同形（`id, project_id, task_id, type, name, description, file_path, status`）。
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO wa_deliverables (id, project_id, task_id, type, name, description, file_path, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')",
  ).run(id, input.projectId, input.taskId || null, type, name, input.description || '', filePath || null);

  // ④ 通报：新行落库即广播（`forceEmit`——它本就没有"前一个状态"，同值不发的幂等判据在这里不适用），
  //    使成果页/项目卡/交付单/活动流立刻看得到。**经 `setDeliverableStatus` 而非直发事件**：
  //    本模块头注释的"状态变更一律经它"不破，且事件类型由**行的状态**决定 ⇒ `draft` 发
  //    `deliverable.status_changed`；`deliverable.registered` 留给它真正的生产者
  //    （`deliverable:register`，那一行确实已推进到 `registered`）。一个事件名一个词义。
  setDeliverableStatus(db, id, 'draft', input.via, { forceEmit: true });
  return { ok: true, id, created: true, name, type, status: 'draft', filePath: filePath || null };
}

/**
 * zx_20260906 批3 (3e): 任务重试时把该任务旧成果软退休——status='retired'（保留版本历史与文件），
 * 经 setDeliverableStatus 发射 deliverable.status_changed；已退休/无产出物为幂等空操作。新 run 成果从零统计。
 */
export function retireTaskDeliverables(
  db: Database.Database,
  taskId: string,
  via = 'task:retry',
): { retired: number } {
  try {
    // zx_20260930 M4-1 **登记一处刻意差异**(不改)：本处**不滤探针**——这是**写侧**（重试前把旧成果
    //   全部退休），不是读侧计数。退休的语义是"这轮的产出已经不作数了"，探针件同样不作数；
    //   漏掉它反而会让"重试后旧探针仍显示为当前成果"。写侧一律行动，读侧才挑挑拣拣。
    const rows = db.prepare("SELECT id FROM wa_deliverables WHERE task_id = ? AND status != 'retired'").all(taskId) as Array<{ id: string }>;
    let retired = 0;
    for (const r of rows) {
      const res = setDeliverableStatus(db, r.id, 'retired', via);
      if (res.changed) retired += 1;
    }
    return { retired };
  } catch (err) {
    return { retired: 0 };
  }
}

/**
 * 任务达标收尾（finalize 通过，进入 completed）时，把本任务**文件型成果**
 * （`FILE_DELIVERABLE_TYPES` = doc ∪ code）且 `status='draft'` 的产出物幂等推进为 completed
 * ——"成果随任务交付"。任务上下文存在 `deliverable_unfulfilled.forced`（预算强制收尾/产出未达标）时不推进，
 * 避免把未达标产出冒充已完成成果。
 *
 * zx_20260930 M3-f: 类型判据由**硬写** `type = 'doc'` 改走**集合真源** `typeIn('', FILE_DELIVERABLE_TYPES)`。
 * 病根（§1 基线第 3 行「非 doc 成果恒 draft」）：旧判据只认 doc ⇒ `code` 成果挂到已完成任务下永停「草稿」，
 * 真库实测 5 条（一次性存量回填见 `scripts/repair_zx_20260930.ts`）。服务型（mcp/a2a/daemon/ui）**仍不提升**——
 * 它们不是"随任务交付的文件"，理由见 `FILE_DELIVERABLE_TYPES` 注。
 */
export function promoteTaskFileDeliverables(
  db: Database.Database,
  taskId: string,
  via = 'task_completed',
): { promoted: number; skipped?: string; error?: string } {
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined;
    const ctx = JSON.parse(row?.context_json ?? '{}') as Record<string, unknown>;
    // zx_20260911_4 M4-1(空性·缘起 / 康德·范畴统一): 红线只画在**forced**(预算强制收尾/产出未达标)上。
    // 此前 `if (ctx.deliverable_unfulfilled)` 把 `{paths,note,retries}` 这类**重试簿记**也当红线，
    // 且标记清点只在 agent-executor 的一条收口路径——任一环节没清，doc 就永停 draft(E10 实测 20 条)。
    // 判定单点收敛于本函数：只有 forced 才跳过。
    const unf = ctx.deliverable_unfulfilled as { forced?: boolean } | undefined;
    if (unf?.forced === true) return { promoted: 0, skipped: 'deliverable_unfulfilled' };

    // zx_20260911_4 M4-2(管子·度量衡): 提升前先滤探针——与列表/digest/统计同一把尺(docNotProbe),
    // 防临时探针 doc 被当成"随任务交付的成果"提升为 completed(E11)。
    // zx_20260930 M3-f: 类型判据由硬写 `type = 'doc'` 改走**类型集合真源**（`typeIn`），
    //   与 ACCEPTANCE_TYPES/PRIMARY_TYPES 同一范式——一处集合改动，此处自动同尺。
    const fileTypes = typeIn('', FILE_DELIVERABLE_TYPES);
    const drafts = db.prepare(`SELECT id FROM wa_deliverables WHERE task_id = ? AND ${fileTypes.sql} AND status = 'draft' AND ${docNotProbe('')}`).all(taskId, ...fileTypes.params) as Array<{ id: string }>;
    let promoted = 0;
    for (const d of drafts) {
      const r = setDeliverableStatus(db, d.id, 'completed', via);
      if (r.changed) promoted += 1;
    }
    // zx_20260909_1 M3(C1 黑格尔·整体由已验证部分组成): 收尾置 completed 时对"当时在册、type='doc'、非探针、非 retired"的真实产出 doc
    // 打 acceptance_verified=1(任务须已验收 checked_at; 幂等)。验收后才补 doc 位 0 → 各显各的 ✓。
    try { markDocAcceptanceVerified(db, taskId); } catch {}
    return { promoted };
  } catch (err) {
    return { promoted: 0, error: String(err) };
  }
}

/**
 * zx_20260909_1 M3(C2 维特根斯坦·可判定/王阳明·不拿探针充成果): doc 探针滤除共享谓词(COALESCE(file_path,name) 口径,
 * 与列表/最近产出物/全景统计 project.ipc 一致)。alias 传入表别名(如 'd')用于带 JOIN 查询消除 name/file_path 歧义。
 *
 * zx_20260913 M2-3(康德·范畴穷尽 / 管子·度量衡): 补上第一个漏网形态——`scripts/_f20_probe.py` 逃逸。
 * 根因是谓词写成了"单字符前缀"(`%/_probe%` 要求 `/` **紧跟** `_probe`)，而探针实际命名是 `_f20_probe`
 * (下划线后还有标识)。改为**路径段级**：段内以 `_` 开头、其后任意位置出现 probe/verify/tmp 即判探针。
 * 真库实测(2026-09-13)：收紧后 doc 放行 38 → 37，**差额恰 1**(即 `_f20_probe.py`)，**零误伤**。
 * 注（zx_20260915 P0-8(c) 订正）：**谓词自身不认类型**——是否只判 doc 类，由**调用方**用
 * `(type != 'doc' OR …)` 门控决定（`promoteTaskFileDeliverables` 如此）。原注释把"某一调用方的门控"
 * 说成了"谓词的语义"，与 `autoAssignPrimary`（裸用，对 `doc/code/daemon/ui` 一体生效）对不上。
 * 行为不变：两处各自的取舍都保留（收尾提升只该动 doc；择主则该排除 code 探针）。
 *
 * zx_20260916_3 M2（D3 裁定 / 维特根斯坦「意义即用法」/ 王阳明「不拿探针充成果」的**反面**）:
 * **删掉末条形状 GLOB**（原 `NOT GLOB '*test_<6 位十六进制>*.py'`）——探针身份应当被**宣告**，不该被**推断**。
 * 该 GLOB 想匹配"随机命名探针脚本"，但 `a20260`（`a`/`2`/`0`/`2`/`6`/`0`）**整个都是十六进制字符**，
 * 于是 a-stock `scripts/` 下**全部 7 个** `test_a2026*_m<N>_*.py` 真测试脚本被**系统性全中**（实测 6/7 已误退休，
 * 其中 `m1b`/`m2` 两个**未提交**的真测试脚本恰恰是"git-first 备选案"也救不回的两例）——不是偶尔误伤，是"凡按
 * `test_a<轮次>_*.py` 命名的仓库，每个测试文件都会被判为探针"。**误伤的方向是错的**（真产出被移走），
 * 故宁可**漏退休**（文件留在原地，可逆），不可**误退休**（承 §4.1-①）。
 * 上面三条 `_verify`/`_probe`/`_tmp` **保留不动**——以 `/_` 起手锚定，是**显式宣告**的标记（§1.4 已认定其成立）。
 * ⚠ **已接受的代价**：同目录下未按这三个前缀命名的临时文件**不再被自动退休**，会作为产出物留在原地。
 */
export function docNotProbe(alias = ''): string {
  const p = alias ? `${alias}.` : '';
  const c = `COALESCE(${p}file_path, ${p}name)`;
  // zx_20260930 M3-g: `_` 在 SQLite LIKE 里是**单字符通配符**，不是字面下划线 ⇒ 原式 `%/_%probe%` 实为
  //   "路径里含 probe"（`/` + 任意一字符 + 任意串 + `probe`），而非上一条注释所**自称**的
  //   "路径段级：段内以 `_` 开头"。这正是本轮「名实相符」主题下的一处：**注释描述了意图，代码没做到**，
  //   而 zx_20260913 那句「真库实测差额恰 1、零误伤」是在这柄**偏宽的尺**上量出来的，给了假的安心。
  //   一宽之害：`scripts/verify_push_20260910.py`、`scripts/attempt_*.py` 这类**正常命名**（只因含
  //   verify/probe/tmp 字样）被判探针排除，连带 `promoteTaskFileDeliverables` 永不提升它们（真产出卡 draft）。
  //   修法：`\_` + `ESCAPE '\'` 让 `_` 回到**字面下划线**语义，谓词这才真的等于上面注释所写的那句。
  //   注意**不是单向放宽**：`data/_sandbox/20260918/…/tmp6*.jsonl` 因含 `/_` 段仍被排除
  //   （`%` 可跨 `/`，故"段起点是 `_`"是充分不必要条件）。两类标本在 rr_zx_20260930 §C-f 同试。
  const esc = (kw: string) => `${c} NOT LIKE '%/\\_%${kw}%' ESCAPE '\\'`;
  return `(${esc('verify')} AND ${esc('probe')} AND ${esc('tmp')})`;
}

/**
 * zx_20260930 M4-1(管子·度量衡 / 维特根斯坦·同一把尺): 成果**取数范围**的唯一起草处。
 *
 * 病根：`status != 'retired' AND (type != 'doc' OR docNotProbe(…))` 这一串谓词此前在
 * **12 个文件位置**各抄一遍（admin/project-engine/project.ipc×7/ai-task×2 等），只是 alias 与
 * 附加条件不同。`docNotProbe` 已于 zx_20260914 收敛，但**它的组合方式**没收——于是每新增一个
 * 读点就多一份"顺手写漏一行"的机会（M4-4 之前那三处内联拷贝就是这么来的）。此处把"一条成果
 * 算不算数"的**取数范围**（退休 + 探针 + 项目/任务归属）也收敛成一处，读点只写 WHERE 片段。
 *
 * **刻意保留的差异**（不是漏网，登记在此以免日后被"顺手统一"）：
 * 1. `includeRetired: true` —— `deliverable:list` 是**档案视图**，按设计看得见已退休件（其内联注释
 *    原文即「刻意保留「已退休可见」(档案视图有意为之，不动)」）。
 * 2. `taskIds` 是**子树口径**（`collectSubtreeIds` 的结果）——任务详情/列表要连子代理产出一起算。
 * 3. 附加过滤（关键词/type/status、`is_primary`、`acceptance_verified`）由调用方**接在自己那句
 *    SQL 里**，本函数不管——它们不是"算不算一条成果"的判据，而是"这次要哪几条"的筛选。
 */
export interface DeliverableScope {
  /** 限定项目。缺省=全库（如 Dashboard 总量）。 */
  projectId?: string | null;
  /** 限定任务集合；**传空数组**表示"没有任何任务"（返回恒假谓词，绝不生成 `IN ()`）。 */
  taskIds?: string[] | null;
  /** 是否计入 `status='retired'`（软退休件）。缺省 false=不计。 */
  includeRetired?: boolean;
  /** 表别名，如 `'d'`；用于多表 JOIN 的读点。 */
  alias?: string;
}

/**
 * 生成成果取数范围的 WHERE 片段（**不含** `WHERE` 关键字）与其参数。
 * 恒含探针判据；`taskIds === []` 时返回恒假片段 `'0'`（SQLite 合法布尔）。
 */
export function deliverableScopeSql(scope: DeliverableScope = {}): { sql: string; params: unknown[] } {
  const a = scope.alias ? `${scope.alias}.` : '';
  const parts: string[] = [];
  const params: unknown[] = [];
  if (!scope.includeRetired) parts.push(`${a}status != 'retired'`);
  parts.push(`(${a}type != 'doc' OR ${docNotProbe(scope.alias || '')})`);
  if (scope.projectId) { parts.push(`${a}project_id = ?`); params.push(scope.projectId); }
  if (scope.taskIds) {
    if (scope.taskIds.length === 0) return { sql: '0', params: [] };
    parts.push(`${a}task_id IN (${scope.taskIds.map(() => '?').join(',')})`);
    params.push(...scope.taskIds);
  }
  return { sql: parts.join(' AND '), params };
}

/** 成果**总数**的唯一真源（`alias` 对本函数无意义——计数在裸表上做，故忽略）。 */
export function countDeliverables(db: Database.Database, scope: DeliverableScope = {}): number {
  const w = deliverableScopeSql({ ...scope, alias: '' });
  const row = db.prepare(`SELECT COUNT(*) AS c FROM wa_deliverables WHERE ${w.sql}`).get(...w.params) as { c: number } | undefined;
  return Number(row?.c) || 0;
}

/** 成果**按类型分组**的唯一真源。空类型归 `'other'`（与 project-engine 原口径一致）。 */
export function countDeliverablesByType(db: Database.Database, scope: DeliverableScope = {}): Array<{ type: string; c: number }> {
  const w = deliverableScopeSql({ ...scope, alias: '' });
  const rows = db.prepare(`SELECT type, COUNT(*) AS c FROM wa_deliverables WHERE ${w.sql} GROUP BY type`).all(...w.params) as Array<{ type: string | null; c: number }>;
  return rows.map((r) => ({ type: String(r.type || 'other'), c: Number(r.c) || 0 }));
}

/**
 * 类型集合判据的**真源在 `deliverable-types.ts`**（零依赖，可被渲染层跨 root 引入——见其头注释）。
 * 此处转出，使既有 `from './deliverable-lifecycle.js'` 的调用方与 rr 钉子不必改道；
 * 两侧最终解析到**同一个模块**，故仍是"一把尺"而非第二份实现。
 */
export { ACCEPTANCE_TYPES, PRIMARY_TYPES, PREVIEW_TYPES, FILE_DELIVERABLE_TYPES, SERVICE_TYPES, isAcceptanceType, isPreviewType, isServiceType, isDocPath, isModuleFilePath, typeIn } from './deliverable-types.js';

/**
 * zx_20260913 M2-2(巴特莱特·重构 / D1 裁定不改表结构): 「这条成果还有谁写过」——从**既有真源派生**。
 *
 * 归属不再被后写者夺(见 agent-executor `write_file`)后，`wa_deliverable_versions.changed_by`
 * (每次内容变更落一行，见 write_file 快照点)即"历次写入者"的唯一真源。此处按成果聚合出
 * **除归属者之外**的写入任务(→ 任务标题)。不新增列、不新增数据。
 * 边界(如实): 版本行仅在「内容确有变化 + .md/.txt/.py + <50KB」时落 ⇒ 其它形态的跨任务改写无痕、不显示。
 */
export function otherWriters(
  db: Database.Database,
  rows: Array<{ id: string; task_id?: string | null }>,
): Map<string, Array<{ id: string; title: string }>> {
  const out = new Map<string, Array<{ id: string; title: string }>>();
  const ids = rows.map((r) => r.id).filter(Boolean);
  if (ids.length === 0) return out;
  try {
    const vs = db.prepare(
      `SELECT DISTINCT deliverable_id, changed_by FROM wa_deliverable_versions
       WHERE deliverable_id IN (${ids.map(() => '?').join(',')}) AND changed_by IS NOT NULL AND changed_by != ''`,
    ).all(...ids) as Array<{ deliverable_id: string; changed_by: string }>;
    const ownerOf = new Map(rows.map((r) => [r.id, r.task_id || '']));
    const wanted = vs.filter((v) => v.changed_by !== (ownerOf.get(v.deliverable_id) || ''));
    if (wanted.length === 0) return out;
    const tids = [...new Set(wanted.map((v) => v.changed_by))];
    const titles = db.prepare(`SELECT id, title FROM wa_tasks WHERE id IN (${tids.map(() => '?').join(',')})`).all(...tids) as Array<{ id: string; title: string }>;
    const nameOf = new Map(titles.map((t) => [t.id, t.title]));
    for (const v of wanted) {
      const arr = out.get(v.deliverable_id) || [];
      if (!arr.some((x) => x.id === v.changed_by)) arr.push({ id: v.changed_by, title: nameOf.get(v.changed_by) || '未知任务' });
      out.set(v.deliverable_id, arr);
    }
  } catch { /* 派生失败不影响读取主流程 */ }
  return out;
}

/** 验收证据载荷(任务 ctx 的 `acceptance_check` 派生)。 */
export interface AcceptanceMeta {
  criteria_total: number;
  passed_total: number;
  checked_at: string;
}

/**
 * zx_20260914 M2-3③(罗尔斯·同一把尺 / 康德·范畴穷尽): 「这条成果算不算已验收」的**唯一派生处**。
 *
 * 病根: 同一规则此前在本仓**手抄两处** —— `project.ipc` 的 `deliverable:list`(批量逐行) 与
 *   `deliverable:preview`(单行)。两处并非逐字相同(`list` 在 per_doc 下额外要求 `isAcceptanceType`，
 *   `preview` 只要求 `acceptance_verified===1`) ⇒ 一条 `ui` 类而 `acceptance_verified=1` 的行，
 *   列表不显 ✓、抽屉显 ✓。M2-3③ 还要给 `task:get` 加第三处消费 ⇒ 若不收敛就是**第三份手抄**。
 *
 * 口径(单一真源): 总门控 `deliverable.show_acceptance` 为假 ⇒ 一律不下发；
 *   `deliverable.per_doc_acceptance` 为真 ⇒ **仅**「类型在 `ACCEPTANCE_TYPES` 内 且 本行已打标」才下发(逐条如实)；
 *   为假 ⇒ 回落旧口径「本行所属任务的 ctx 已核验即下发」(任务级扇出)。
 * 就地写入 `row.acceptance`(不新增列、不改判)。
 */
export function annotateAcceptance(db: Database.Database, rows: Array<Record<string, unknown>>): void {
  try {
    const accCfg = db.prepare("SELECT value FROM wa_settings WHERE key = 'deliverable.show_acceptance'").get() as { value?: string } | undefined;
    if (!boolSetting(accCfg?.value)) return;
    const pdCfg = db.prepare("SELECT value FROM wa_settings WHERE key = 'deliverable.per_doc_acceptance'").get() as { value?: string } | undefined;
    const perDoc = boolSetting(pdCfg?.value);
    const parsed = parseAcceptance(db, [...new Set(rows.map((r) => r.task_id).filter((x): x is string => !!x))]);
    for (const r of rows) {
      const tid = r.task_id as string | undefined;
      const a = tid ? parsed.verified.get(tid) : undefined;
      if (!a) {
        // zx_20260915 P0-2(e)(维特根斯坦·意义即用法): **未核验**的任务也下发它的验收结论，
        // 让成果页/完成卡能把「完成 + 95 分」与「其实没验过（或压根没设标准）」分开显示。
        // 与 `r.acceptance` 的区别是判据不同、故不并入：`acceptance` 回答"这条该不该显 ✓"
        // （须过 per_doc 逐条门），`task_acceptance` 只回答"该任务验没验"（只过 show_acceptance 总门）。
        const u = tid ? parsed.unverified.get(tid) : undefined;
        if (u) r.task_acceptance = u;
        continue;
      }
      if (perDoc && !(isAcceptanceType(r.type) && Number(r.acceptance_verified) === 1)) continue;
      r.acceptance = a;
    }
  } catch { /* 验收派生失败不阻断读取主流程 */ }
}

/**
 * 「这些任务里，哪些的 ctx 确有**已核验**的验收结论」——`acceptance_check` 的**唯一解析处**。
 *
 * 与 `annotateAcceptance` 分开是有意的：`annotateAcceptance` 回答"这条成果该不该显示 ✓"（须过
 * `show_acceptance`/`per_doc_acceptance` 两重门），本函数只回答"任务的验收结论**本身**是什么"
 * （不过门）。`deliverable:digest` 需要用 checked_at 做时间窗过滤——那是**取数**不是**展示**，
 * 不能受展示开关影响，故它调本函数而非 `annotateAcceptance`。分开的代价是多一个函数名，
 * 收益是"展示口径"与"数据口径"不再混为一谈。
 *
 * （P0-2 起本函数是 `parseAcceptance` 的**已核验视图**：解析只做一遍，未核验那一半由
 *   `annotateAcceptance` 取 `unverified` 视图——同一处解析，两处消费，不各 parse 一遍。）
 */
export function verifiedAcceptanceMap(db: Database.Database, taskIds: string[]): Map<string, AcceptanceMeta> {
  return parseAcceptance(db, taskIds).verified;
}

/** `parseAcceptance` 的三态视图：已核验 / 未核验（含 `no_criteria`）/ 原载荷，同一任务至多居其一。 */
interface ParsedAcceptance {
  verified: Map<string, AcceptanceMeta>;
  unverified: Map<string, AcceptanceCheckLike>;
  /** 原载荷（两态共用一份）——供"按任务取整条账"的读点复用，免它们各自再 parse 一遍。 */
  raw: Map<string, AcceptanceCheckLike>;
}

/**
 * 单任务的**整条**验收账（原载荷）——"验没验 + 为什么没验 + 几过几"一次取全。
 *
 * 存在的理由：`task.completed` 事件载荷（三态合一）与 `annotateAcceptance`（两态分用）口径不同
 * ——前者要 `verified` 与 `reason` 同框，后者只各取一半。**不为它另开解析点**：仍走 `parseAcceptance`，
 * 只是把原样那一份也留出来（zx_20260915 P0-2(d)）。
 */
export function readAcceptanceCheck(db: Database.Database, taskId: string): AcceptanceCheckLike | undefined {
  return parseAcceptance(db, [taskId]).raw.get(taskId);
}

/**
 * `acceptance_check` 的**唯一解析处**（一次 SELECT、一次 JSON.parse，两态各取所需）。
 *
 * 拆两态而非合成一个 Map 是刻意的：读点的**判据不同**——「该不该显 ✓」只认已核验（`annotateAcceptance`），
 * 「完成到底验没验」须连未核验一起看（成果页/完成卡三态，P0-2）。合成一个 Map 会诱使每个读点
 * 各自再判一次 `verified`，那正是本仓反复治的"同一规则手抄多处"。没有过任何核对的任务**两侧皆无**
 * ——如实"无从说起"，不编一个默认态。
 *
 * 第三份 `raw` 是原样载荷（P0-2(d) 补），给"verified 与 reason 须同框"的事件载荷用；
 * 它不参与任何判定，故不构成第三个**判据**，只是同一份解析结果的第三个出口。
 */
function parseAcceptance(db: Database.Database, taskIds: string[]): ParsedAcceptance {
  const out: ParsedAcceptance = { verified: new Map(), unverified: new Map(), raw: new Map() };
  if (taskIds.length === 0) return out;
  try {
    const ctxRows = db.prepare(`SELECT id, context_json FROM wa_tasks WHERE id IN (${taskIds.map(() => '?').join(',')})`).all(...taskIds) as Array<{ id: string; context_json?: string }>;
    for (const row of ctxRows) {
      try {
        const ac = (JSON.parse(row.context_json || '{}') as { acceptance_check?: AcceptanceCheckLike }).acceptance_check;
        if (!ac || typeof ac.checked_at !== 'string' || !ac.checked_at) continue;
        out.raw.set(row.id, ac);
        if (!isAcceptanceVerified(ac)) { out.unverified.set(row.id, ac); continue; }
        out.verified.set(row.id, {
          criteria_total: Number(ac.criteria_total) || 0,
          passed_total: Number(ac.passed_total) || 0,
          checked_at: ac.checked_at,
        });
      } catch { /* 单个任务验收解析失败跳过(旧数据无结构) */ }
    }
  } catch { /* 解析失败 ⇒ 空表(宁可少显，不误显) */ }
  return out;
}

/**
 * zx_20260909_1 M3(C1 轻量打标·per-doc 验收位): 任务 ctx 的 acceptance_check **确已核验**时,
 * 把"当前在册、类型在 `ACCEPTANCE_TYPES` 内(doc/code,M2-6 扩类)、非探针(COALESCE 谓词)、非 retired、尚未打标"的产出置 acceptance_verified=1。
 *
 * zx_20260910_3 M1c(头重脚轻护栏): 判据由"有 checked_at"收敛为共用的 `isAcceptanceVerified`——
 * 未核验的载荷同样带 checked_at(它是"尝试时刻")，若只认 checked_at，把冒名 PASS 换成一批冒名 ✓。
 * 函数名保留 `Doc`(14 处引用 + 5 个 rr 钉子)，但**判定口径已由 `ACCEPTANCE_TYPES` 单一真源说了算**。
 */
export function markDocAcceptanceVerified(db: Database.Database, taskId: string): void {
  try {
    // 判定走**同一个解析处**（`verifiedAcceptanceMap`）——此前此处与 markDeliverableAcceptanceVerified
    // 各写一遍 `JSON.parse(context_json).acceptance_check` + `isAcceptanceVerified`，是同一规则的第三份手抄。
    if (!verifiedAcceptanceMap(db, [taskId]).has(taskId)) return;
    markVerifiedWhere(db, 'task_id = ?', [taskId]);
  } catch { /* 打标失败不阻断收尾 */ }
}

/**
 * zx_20260914 M2-4(王阳明·知行合一 / 罗尔斯·同一把尺): `acceptance_verified=1` 的**唯一一条 UPDATE**。
 *
 * 打标的"成立条件"是三条**合取**(缺一不可)，此前内联在任务级入口里；M2-4 要按 id 打标，
 * 若照抄一遍就是同一规则的**第二份实现**——两条 UPDATE 日后必然分叉(改一条忘另一条)。
 * 故抽此处: 调用方只决定"改哪些行"(`whereSql`/`params`)，"什么算数"由此一处说了算。
 *
 * 三条: ①未 retired(重试旧版不算在册) ②类型在 `ACCEPTANCE_TYPES` 内(doc/code) ③非探针(`COALESCE(file_path,name)` 口径)
 * ④尚未打标(幂等: 已 1 的不重写, 也就不会顶掉 updated_at)。
 *
 * zx_20260930 M4-1 **登记一处刻意差异**(不改)：本条是**写侧**（UPDATE 打标），且第②条为
 * `type IN ('doc','code')`（**只认这两类**），与 `deliverableScopeSql` 的 `(type != 'doc' OR 非探针)`
 * （**doc 之外全放行**）是**两条不同判据**，不是同一条的宽窄版本 ⇒ 不复用 range 真源。
 * @returns 实际改动的行数(0 = 无一行满足条件，调用方据此如实回报)。
 */
function markVerifiedWhere(db: Database.Database, whereSql: string, params: unknown[]): number {
  const t = typeIn('', ACCEPTANCE_TYPES);
  const r = db.prepare(
    `UPDATE wa_deliverables SET acceptance_verified = 1, updated_at = datetime('now')
     WHERE ${whereSql} AND status != 'retired' AND ${t.sql} AND ${docNotProbe('')} AND COALESCE(acceptance_verified, 0) = 0`,
  ).run(...params, ...t.params);
  return Number(r.changes) || 0;
}

/** `deliverable:accept` 的如实回执：`changed=1` 才是真改了库；`0` 附 `reason` 说明为何一行未动。 */
export interface AcceptResult {
  ok: boolean;
  changed: number;
  reason?: string;
}

/**
 * zx_20260914 M2-4(王阳明·知行合一): 按**成果 id** 打验收标——「验收有入口」。
 *
 * 口径与任务级入口**同源**: 仍须该成果所属任务的 ctx `acceptance_check` 确已核验
 * (=「验收结论真有来源」，不是点一下就凭空生出一个 ✓)。故**不是**"人工盖章"，
 * 而是"把已有的验收结论落到这一条上"——这正是「知(验收结论)行(打标)合一」。
 *
 * 拒绝时**说清为什么**(夏克特·七宗罪·信息失落): `not_found` / `not_acceptance_type` /
 * `ctx_not_verified` / `not_in_register`(retired 或已被视为探针)。全部**不改库**。
 */
export function markDeliverableAcceptanceVerified(db: Database.Database, id: string): AcceptResult {
  try {
    const d = db.prepare('SELECT id, task_id, type, status, acceptance_verified FROM wa_deliverables WHERE id = ?')
      .get(id) as { id: string; task_id?: string | null; type?: string | null; status?: string | null; acceptance_verified?: number | null } | undefined;
    if (!d) return { ok: false, changed: 0, reason: 'not_found' };
    if (!isAcceptanceType(d.type)) return { ok: false, changed: 0, reason: 'not_acceptance_type' };
    if (!d.task_id) return { ok: false, changed: 0, reason: 'no_owning_task' };
    if (!verifiedAcceptanceMap(db, [d.task_id]).has(d.task_id)) return { ok: false, changed: 0, reason: 'ctx_not_verified' };
    const changed = markVerifiedWhere(db, 'id = ?', [id]);
    // 0 行改动有三种成因，**分别如实回报**而不是笼统一句"失败"(否则用户无从判断该做什么)
    if (changed === 0) {
      const now = db.prepare('SELECT status, acceptance_verified FROM wa_deliverables WHERE id = ?')
        .get(id) as { status?: string | null; acceptance_verified?: number | null } | undefined;
      if (Number(now?.acceptance_verified) === 1) return { ok: true, changed: 0 };
      return { ok: false, changed: 0, reason: 'not_in_register' };
    }
    return { ok: true, changed };
  } catch {
    return { ok: false, changed: 0, reason: 'error' };
  }
}

/**
 * zx_20260909_1 M3(C1 一次性回填·保住存量观感): 对 ctx 有 acceptance_check.checked_at 的已完成任务之真实 doc 回填 1。
 * 以 wa_settings 迁移标记(migration.doc_acceptance_backfill)守护——仅首启跑一次, 防对"验收后才补 doc"反复误标。
 * zx_20260910_3 M1c: 追加 `NOT LIKE '%"verified":false%'` 排除未核验载荷(迁移标记多已 done，此处仅防御)。
 */
export function backfillDocAcceptanceVerified(db: Database.Database): void {
  try {
    const done = db.prepare("SELECT 1 FROM wa_settings WHERE key = 'migration.doc_acceptance_backfill'").get();
    if (done) return;
    const rows = db.prepare("SELECT id FROM wa_tasks WHERE status = 'completed' AND context_json LIKE '%checked_at%' AND context_json NOT LIKE '%\"verified\":false%'").all() as Array<{ id: string }>;
    for (const r of rows) markDocAcceptanceVerified(db, r.id);
    db.prepare("INSERT OR IGNORE INTO wa_settings (key, value) VALUES ('migration.doc_acceptance_backfill', 'done')").run();
  } catch { /* 回填失败不阻断启动 */ }
}

/**
 * zx_20260911_4 D5④(实践论·如实归位): 存量一次性归位——M4-1 判据收窄前已 `completed`、
 * 却因陈旧标记(`{paths,note,retries}` 重试簿记)被旧判据一票拦下而永停 `draft` 的真实 doc。
 *
 * 只修判据不能救历史：`promoteTaskFileDeliverables` 仅在任务执行期被调，已终态的存量不会再跑。
 * 故以 wa_settings 迁移标记(`migration.doc_promote_stale_marker`)守护——仅首启跑一次，
 * 逐任务**复用同一判据**(不写第二套 SQL)：`forced === true` 者仍跳过、探针仍被滤。
 * 判定单点收敛于 `promoteTaskFileDeliverables`，此处只负责"把范围给它"。
 */
export function backfillStaleMarkerDocPromotion(db: Database.Database): void {
  try {
    const done = db.prepare("SELECT 1 FROM wa_settings WHERE key = 'migration.doc_promote_stale_marker'").get();
    if (done) return;
    const rows = db.prepare("SELECT id FROM wa_tasks WHERE status = 'completed' AND context_json LIKE '%deliverable_unfulfilled%'").all() as Array<{ id: string }>;
    for (const r of rows) promoteTaskFileDeliverables(db, r.id, 'backfill_stale_marker');
    db.prepare("INSERT OR IGNORE INTO wa_settings (key, value) VALUES ('migration.doc_promote_stale_marker', 'done')").run();
  } catch { /* 回填失败不阻断启动 */ }
}

/**
 * zx_20260920_1 M3（面三 · 判据 C8）：存量一次性归位——**人工收口**那一类。
 *
 * 病根（真库实测）：`promoteTaskFileDeliverables` 只被**引擎**三处调用（`finalize_task` / `update_task_status` /
 * `run_close`）。GUI 点「标记完成」是**第四处出口**，而它此前**不引用**该符号 ⇒ 人在桌面上收的口，doc 状态
 * **不跟着落定**。修了 GUI 路（`finalizeTaskByHuman`）仍救不了历史：**已终态的存量不会再跑引擎**。
 *
 * 范围 SQL 与 rr 那条只读核验**同一把尺**（`docNotProbe('d')` **传别名**，JOIN 下不消歧会撞 `name`）：
 * 只负责"把范围交给 `promoteTaskFileDeliverables`"——`forced` 红线与探针尺由它自己再判一遍，本函数**不写第二套**。
 * 幂等由**两处**共同保证：①`wa_settings` 标记（仅首启一次）②范围里只含 `status='draft'` 的行。
 */
export function backfillHumanCompletedDocPromotion(db: Database.Database): void {
  try {
    const done = db.prepare("SELECT 1 FROM wa_settings WHERE key = 'migration.doc_promote_human_completed'").get();
    if (done) return;
    const rows = db.prepare(
      `SELECT DISTINCT t.id FROM wa_tasks t JOIN wa_deliverables d ON d.task_id = t.id
        WHERE t.status = 'completed' AND d.type = 'doc' AND d.status = 'draft' AND ${docNotProbe('d')}`,
    ).all() as Array<{ id: string }>;
    for (const r of rows) promoteTaskFileDeliverables(db, r.id, 'backfill_human_completed');
    db.prepare("INSERT OR IGNORE INTO wa_settings (key, value) VALUES ('migration.doc_promote_human_completed', 'done')").run();
  } catch { /* 回填失败不阻断启动 */ }
}

/**
 * zx_20260911_2 M4-G1(黑格尔·规定即否定 / 罗尔斯·同一规则): ★主要成果的**作用域**——单一真源。
 *
 * 「主要」是对**同组**成果互为排斥的谓词：一个任务内至多一条 ★；手工成果(无 task_id)在项目内手工组内至多一条。
 * 此前 `deliverable:setPrimary` 只置目标行、不清兄弟 ⇒ 同一任务可并出多个 ★(名相自相矛盾)。
 * 谓词口径与消费方(digest ★段 / 列表星标)一致：任务内按 task_id，手工按 project_id + task_id IS NULL。
 */
export function primaryScope(row: { task_id?: string | null; project_id: string }): { sql: string; params: unknown[] } {
  return row.task_id
    ? { sql: 'task_id = ?', params: [row.task_id] }
    : { sql: 'project_id = ? AND task_id IS NULL', params: [row.project_id] };
}

/**
 * zx_20260911_2 M4-G1: 互斥地置/撤 ★——置位时在同一作用域先清兄弟，再置目标行(同一事务)。
 * 供 `deliverable:setPrimary` 与受控回归共用；撤位(flag=0)只影响本行。
 */
export function applyPrimary(db: Database.Database, row: { id: string; project_id: string | null; task_id: string | null }, flag: number): void {
  const tx = db.transaction(() => {
    if (flag === 1) {
      const s = primaryScope({ task_id: row.task_id, project_id: row.project_id ?? '' });
      db.prepare(`UPDATE wa_deliverables SET is_primary = 0, updated_at = datetime('now') WHERE ${s.sql} AND id != ?`).run(...s.params, row.id);
    }
    db.prepare("UPDATE wa_deliverables SET is_primary = ?, updated_at = datetime('now') WHERE id = ?").run(flag, row.id);
  });
  tx();
}

/**
 * zx_20260911_2 M4-G2(罗尔斯·同一规则 / 康德·范畴统一): 任务收尾时自动把最新真实 doc 置 ★——
 * **唯一实现**，供 finalize_task 与 update_task_status 两个"完成"出口共用。
 *
 * 判据(自我复核)：`deliverable.primary_auto` 开关 + 本任务尚无 ★(`priCnt===0` 前置)
 * + 候选类型在 `PRIMARY_TYPES` 内(M2-5 由仅 doc 扩到 doc/code/daemon/ui，D2 裁定)、非 retired、探针滤除(`docNotProbe`)、取最新。
 * 抽取前该逻辑只存在于 finalize 一处 ⇒ 经 update_task_status "完成"的任务永无 ★(第二出口无 primary)。
 *
 * zx_20260924_1 M5-a(维特根斯坦·一处真源): 置位动作**改走 `applyPrimary`**——此前这里是第二条内联写法
 * （`UPDATE ... SET is_primary = 1` 只置自己、不清兄弟），而前置计数 `priCnt` 又**不数已 retired 的行**：
 * 一个已 retired 的 ★ + 一次自动置位 ⇒ **同作用域两行 is_primary=1**，与 `primaryScope` 自述的"至多一条"直接矛盾。
 * `applyPrimary` 本就做"同作用域清兄弟 + 置目标行(同一事务)"，故此处只留**选谁**，不留**怎么置**。
 * ⚠ `priCnt` 的 `status != 'retired'` 口径**刻意保留**（它与 `applyPrimary` 的清理口径不同是**有意的**：
 * 前者问"还有没有一个活着的 ★"(决定要不要补)，后者问"谁在这个作用域里"(决定清哪些)）；
 * 本条修的是**写法分叉**，不是这两问本身。
 * zx_20260930 M4-1 **追加登记**：`priCnt` 亦**不滤探针**（它问的是"有没有活着的 ★"，与探针无关），
 * 故整条也不走 `deliverableScopeSql`——共享真源管的是"算不算一条成果"，此处问的是"★ 还在不在"。
 */
export function autoAssignPrimary(db: Database.Database, taskId: string): { assigned?: string } {
  try {
    const cfgPri = db.prepare("SELECT value FROM wa_settings WHERE key = 'deliverable.primary_auto'").get() as { value?: string } | undefined;
    if (!boolSetting(cfgPri?.value)) return {};
    const priCnt = (db.prepare("SELECT COUNT(*) c FROM wa_deliverables WHERE task_id = ? AND status != 'retired' AND is_primary = 1").get(taskId) as { c: number }).c;
    if (priCnt !== 0) return {};
    const t = typeIn('d', PRIMARY_TYPES);
    // zx_20260915 P0-8(b)（管子·度量衡 / 以事实定主次）: 排序原先**只看登记时序**（created_at DESC）——
    //   "最后登记的那一条"与"最主要的成果"没有关系，它取决于 agent 碰巧最后调 register_deliverable 的顺序。
    //   实测 `8a6f226a`：★ 落在**最后登记**的既有脚本 `check_command_consistency.py`（177KB，只有 file.edited），
    //   而 11KB 的核实报告（真成果，有 file.created）is_primary=0。
    //   判据取自**既有事实**：事件流里本任务有无该路径的 `file.created`（新建）——新建的产物优先于被改动的既有文件。
    //   不新增列、不新增字段；`file.created` 仅在 `!existedBefore` 时发射（agent-executor write_file），语义正好。
    //   归一比较失败（路径写法不一致）只导致该行不加分，**回退到既有 created_at DESC**——安全降级，不误判。
    const preferCreated = readBoolSetting(db, 'deliverable.primary_prefer_created');
    const orderBy = preferCreated
      ? `ORDER BY (EXISTS(SELECT 1 FROM wa_event_log e WHERE e.event_type = 'file.created' AND e.aggregate_id = d.task_id AND json_extract(e.payload, '$.filePath') = COALESCE(d.file_path, d.name))) DESC, d.created_at DESC, d.rowid DESC`
      : 'ORDER BY d.created_at DESC, d.rowid DESC';
    // project_id / task_id 一并选出——`applyPrimary` 需要三件才认得出作用域（zx_20260924_1 M5-a）。
    const cand = db.prepare(`SELECT d.id, d.project_id, d.task_id FROM wa_deliverables d WHERE d.task_id = ? AND ${t.sql} AND d.status IN ('draft','registered','completed') AND ${docNotProbe('d')} ${orderBy} LIMIT 1`).get(taskId, ...t.params) as { id: string; project_id: string | null; task_id: string | null } | undefined;
    if (!cand) return {};
    applyPrimary(db, cand, 1);
    return { assigned: cand.id };
  } catch { return { /* 自动 primary best-effort */ }; }
}

/**
 * zx_20260915 P0-8(a)（念了必须有人应）: 本任务的**临时产出物**清单——判据即 `docNotProbe`，
 * **不另写一份正则**。此前 finalize 的 B3 自检自带一段陈旧副本（旧单字符前缀式，漏 `_f20_probe.py`
 * ——正是 zx_20260913 M2-3 修过的逃逸形态），于是"列表说它是探针、自检认不出它"，同一判据两个答案。
 *
 * zx_20260916_3 M2: "探针"的定义收敛为**显式标记**（`_tmp`/`_probe`/`_verify` 三条，见 `docNotProbe`），
 * 按文件名的**长相**推断的那条 GLOB 已删。故本清单 = "明确自陈是临时件的产出物"，不再含"看起来像随机命名"的文件。
 *
 * zx_20260930 M4-1 **登记一处刻意差异**(不改)：本处是 `deliverableScopeSql` 的**取反面**——
 * 它要的正是"那些**被排除**的行"，故不能复用那个只表达正向范围的片段（真源只写一次，反转在调用处）。
 */
export function selectProbeDeliverables(db: Database.Database, taskId: string): Array<{ id: string; file_path: string | null }> {
  return db.prepare(
    `SELECT id, file_path FROM wa_deliverables WHERE task_id = ? AND status != 'retired' AND NOT ${docNotProbe('')}`
  ).all(taskId) as Array<{ id: string; file_path: string | null }>;
}

/** 探针处置的结果。`moved`/`alreadyGone`/`failed` 是 zx_20260916 M2 新增的**如实计数**。 */
export interface ProbeDispositionResult {
  retired: number;
  kept: number;
  /** 真移到隔离目录的个数 */
  moved: number;
  /** 源文件本就不在（幂等重跑、或用户已自行清走）——**不计入 moved**，不报成功 */
  alreadyGone: number;
  /** 移动失败（跨设备/权限/占用）——**登记照常置 retired、路径不回写**，此处理由入 checks，不静默 */
  failed: Array<{ name: string; reason: string }>;
}

/**
 * zx_20260915 P0-8(a): 收尾处置临时产出物——`retire`（默认）置 `status='retired'`，
 * `keep` 原样保留（理由由调用方入 checks 留痕）。
 * 走 `setDeliverableStatus` 而非直写：状态变更一律经它，事件真源不破（本文件头注释）。
 *
 * zx_20260916 M2（用户 2026-09-16 裁定改口径：**移入隔离目录**）: 此前**只改登记状态、不碰文件**
 * （原注释自陈是为守"不擅自删用户文件"），实测结果是"登记说已退休、文件仍在被分析仓库根目录"
 * ——真库 `c731c640` 的 `_tmp_probe_dsa_20260916.py` 至今还在 a-stock 仓库根，脏的是用户的工作树。
 * 现改为：**移入** `quarantineDir` 并**回写 `file_path`**；`status` 仍 `retired`（既有取值，零迁移）。
 * **仍是"不删"**——隔离目录里找得回，边界未被逆，只是"退休"这件事第一次真的发生在了文件上。
 *
 * `quarantineDir` **由调用方注入**（本模块零 electron、不解析 dataDir，故保持可被 rr 直跑真实现）；
 * 不传 ⇒ 退回旧行为（只改登记状态），供尚未接线的调用方与存量回归平滑过渡。
 */
export function disposeProbeDeliverables(
  db: Database.Database,
  rows: Array<{ id: string; file_path?: string | null }>,
  disposition: string,
  quarantineDir?: string,
): ProbeDispositionResult {
  if (disposition === 'keep') return { retired: 0, kept: rows.length, moved: 0, alreadyGone: 0, failed: [] };
  let retired = 0;
  let moved = 0;
  let alreadyGone = 0;
  const failed: Array<{ name: string; reason: string }> = [];
  for (const r of rows) {
    const res = setDeliverableStatus(db, r.id, 'retired', 'probe_disposition');
    db.prepare("UPDATE wa_deliverables SET description = COALESCE(description, '') || '（收尾自动退休：临时探针，非交付成果）', updated_at = datetime('now') WHERE id = ?").run(r.id);
    if (res.changed) retired += 1;

    const src = String(r.file_path ?? '').trim();
    if (!quarantineDir || !src) continue;
    const name = path.basename(src);
    if (!fs.existsSync(src)) { alreadyGone += 1; continue; } // 幂等：不在就不动，也**不谎报已隔离**
    try {
      fs.mkdirSync(quarantineDir, { recursive: true });
      const dest = path.join(quarantineDir, name);
      fs.renameSync(src, dest);
      db.prepare("UPDATE wa_deliverables SET file_path = ?, updated_at = datetime('now') WHERE id = ?").run(dest, r.id);
      moved += 1;
    } catch (e) {
      // 失败**不留白**：登记已是 retired（下面照报），但路径不回写、文件原地不动，理由如实上抛
      failed.push({ name, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { retired, kept: 0, moved, alreadyGone, failed };
}
