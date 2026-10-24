/**
 * zx_20260910_3 M3(G3 设置名实相符): **布尔型 setting 的唯一判据**。
 *
 * 病灶有两层，缺一不可修：
 * ① 判据分身——同一条「这个开关开着吗」的规则，主进程与渲染层共写了 33 处
 *    （M0 基线 E11 记「全仓 17 处」，实测漏了渲染层 16 处：只扫了 src/main 而冠以「全仓」之名）。
 *    同一规则写在两处就必然分家（本轮 G2 病根）；33 处里任何一处被单独改动，用户看到的界面
 *    与引擎行为就会不一致。
 * ② 真源只认字面 'false'——而 '0' 是这条判断**自己历史上**产生过的关闭写法：
 *    `deliverable.*` 一族在 zx_20260909_1 M5 实机复核修之前，写端落库的是 '0'/'1'，
 *    至今 `deliverable.show_acceptance` 库值仍是 '0'。于是用户点了「关」，界面照显——
 *    开关名 `show_acceptance` 与其实效脱钩（用户 2026-09-10 裁决：本意是 OFF，修成真 OFF）。
 *
 * 判据语义取「**只有明确说关，才算关**」：'false' 与 '0' 两种历史写法都认；其余一律按开。
 * 与旧判据 `(value ?? 'true') !== 'false'` 在缺省/脏值分支上**逐位等价**，仅把 '0' 由「开」纠正为「关」。
 *
 * 本模块**零依赖**（不引 electron / better-sqlite3 / node:*），故：
 * ① 可被受控回归直接跑真实现（同 pause-settlement / task-accounting 范式）；
 * ② 可被渲染层跨 root 引入——两侧消费**同一份代码**，而不是同一条规则的第二次实现。
 */

/**
 * 布尔 setting 判据。缺省（undefined/null/''/任意非 'false'/'0' 值）视为**开**。
 *
 * 刻意**不设** `defaultTrue` 形参：该形参在「!(v === 'false' || v === '0')」下不参与运算，
 * 是「有参数之名、无参数之实」——本身即本轮要治的病。现存消费的键一律「缺省即开」，
 * 缺省关的键族（ui_dnd / notify_quiet_mute_critical / sound_* / ui_system_notifications）
 * 属**另一条**判据（形如 === '1'），不并入本函数。
 */
export function boolSetting(value: string | undefined | null): boolean {
  return !(value === 'false' || value === '0');
}

/**
 * 受 boolSetting 判定的键白名单——**唯一一份**。迁移只能动这些键，故与判据同文件同源，
 * 防「判据一份、名单另一份」再次分家。
 *
 * 刻意**不含**：数值键（im.outbox_retry_min / im.long_running_progress_min /
 * memory.archive_retention_days —— '0' 对其是合法值）、缺省关键族（判据不同）。误改即制造新的名实不符。
 */
export const BOOL_SETTING_KEYS: readonly string[] = [
  'deliverable.show_acceptance',
  'deliverable.acceptance_on_close',
  'deliverable.probe_disposition',
  'deliverable.primary_prefer_created',
  'engine.completion_gate_no_output',
  'engine.failed_with_reason',
  'engine.children_failed_pause',
  'engine.answer_provenance',
  'deliverable.per_doc_acceptance',
  'deliverable.first_write_v1',
  'deliverable.primary_auto',
  'deliverable.primary_marker',
  'deliverable.show_delivery_digest',
  'deliverable.digest_window_switch',
  'deliverable.task_achievement_summary',
  'deliverable.doc_drawer',
  'memory.outcome_exemplar',
  'memory.receipt_dedup',
  'memory.exemplar_effect_rank',
  'memory.consolidation_idle_skip',
  // zx_20260930 M7-f：图式重构召回（缺省即开）。关 ⇒ 任务相关记忆回"纯逐字/语义"旧口径，
  //   供与巴特莱特那跳 A/B（两口径的差别只在该段的**条序**，成员集不动）。
  'memory.schema_recall',
  'im.completion_summary',
  'im.notify_to_creator',
  'im.notify_pause_needed',
  'im.busy_ack',
  'im.notice_single_source',
  'ui.presence_bar',
  'ui.presence_minimize',
  'ui.tray_presence_menu',
  'ui.stale_running_hint',
  'plan.link_at_create',
  // zx_20261023_5 批一（孙子·先为不可胜）：就绪排序的**关键路径优先**（**缺省即开**）。
  //   开 ⇒ 同优先级下依赖链更长的任务先启动；关 ⇒ 逐字回"priority DESC, created_at ASC"旧序。
  'sched.critical_path',
  // zx_20260915 M4/P0-6：暂停/偏离通知面 + 偏离判据的完整输入（两枚皆「缺省即开」）
  'notification.pause_and_deviation',
  'engine.deviation_full_input',
  // zx_20260915 M5/P0-7：shell 拒绝文案如实化 + 工具能力简报注入（缺省即开；关 ⇒ 回旧文案/不注入简报）
  'engine.shell_advice_honest',
  // zx_20260915 M6/P0-9：里程碑主体校验 + 板内幂等（缺省即开；关 ⇒ 回"一律登记、不查重"）
  'engine.milestone_subject_check',
  // zx_20260921 M6（D3）：planning 出口自动拆解（**缺省即开**——本轮主线就是"插头要插上"，
  //   默认关等于生产仍恒零拆解，D3 的"真库零产出"不被消除）。关 ⇒ 逐字回"只回一句请用 create_task"的旧行为。
  'engine.plan_auto_decompose',
  // zx_20261005 M21（K-11）：ANS 桌面端自动托管（**缺省即开**）。关 ⇒ 不代起本机 ANS（用户仍可显式 `ans:start`）。
  'ans_auto_start',
  // zx_20261012_2 批一（策略可配）：执行前策略闸总开关（**缺省即开**）。关 ⇒ 连失败数都不取，
  //   逐字回"无策略检查"的旧行为（一键回退，非删代码）。
  'engine.policy_check',
  // zx_20261013_1 批一（称器于事）：**能力硬需把关**开关（**缺省即开**）。开 ⇒ 最终在用的模型
  //   若缺本任务**硬需**能力（`vision`/`chat`/`function-calling`，真源 `CAPABILITY_DEMAND`）
  //   则**如实拒**（写 `[选型失败]` + 抛），不再让装配层 omit 图片把缺口掩盖过去；
  //   关 ⇒ 逐字回本批前的"只记不拦"旧行为（一键回退，非删代码）。
  'engine.model_capability_gate',
  // zx_20261022_3 批六（知行合一）：**严格备用**开关（**缺省关** = 保持 2026-10-02「可用性优先」裁定）。
  //   开 ⇒ 主模型探活未通过、换到的备用缺本任务**硬需**能力时**如实拒**（写 `[选型失败]` + 抛），
  //   不静默降级；关 ⇒ 照旧继续，但落一行用户可见的 `[降级选型]` 并经 IM 通道告知。
  //   ⚠ 读端**必须**用 `readBoolSettingDefaultOff`——`readBoolSetting`／`boolSetting` 的语义是
  //     「只有明确说关才算关」（缺省即开），拿它读本键会把"没设过"当成"已开启严格模式"。
  //   ⚠ 与 `engine.model_capability_gate` **不是同一把尺**：那个管「选型定稿后最终模型的硬需闸」，
  //     本键只管「探活失败后的**可用性备用**」这一格（该格此前按裁定豁免硬需闸）。
  'engine.capability_strict_fallback',
  // zx_20261014_4 批一（道德经·善闭无关楗而不可开）：**入站门**（外部 AI 终端接入本机）——**缺省关**。
  //   ⚠ 本键是全表**唯一**"缺省关"的一员：`boolSetting` 判据是"只有明确说关才算关"，缺省即开 ——
  //      故它**必须**在 `database.ts` **显式** `ensureSetting('node.external_inbound','false')` 才算真的默认关。
  //      漏了那一行，一台刚装的机器会把入站端口默认敞在局域网上（新病，非旧病）。
  //   仍列本表（而非另立一条判据）是取**同一把尺**：面板与引擎读的是同一个口，不制造第二套开关语义。
  //   反证断言在 `scripts/rr_zx_20261014_4.ts` G-1b（未 seed ⇒ readBoolSetting **为真** ⇒ 证 seed 不可省）。
  'node.external_inbound',
];

/** 仅需 prepare().run()/.get()/.all() 的最小库接口——使本模块可脱 better-sqlite3，在受控回归里跑真逻辑 */
export interface BoolSettingDb {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

/**
 * 读一条布尔 setting 的当前值（缺省即开）。取数这一半与上面的判据同源同文件，
 * 使调用点不必各自手抄 `SELECT value FROM wa_settings WHERE key = ?` + `!== 'false'`；
 * 读失败按"开"（与缺省同向，不因读不到就静默关掉一条引擎行为）。
 */
export function readBoolSetting(db: BoolSettingDb, key: string): boolean {
  try {
    const row = db.prepare('SELECT value FROM wa_settings WHERE key = ?').get(key) as { value?: string } | undefined;
    return boolSetting(row?.value);
  } catch { return true; }
}

/**
 * 读一条「**缺省关**」布尔 setting：只有明确说开（'true'/'1'/'on'）才算开。
 *
 * 为什么另立一条而不给 `readBoolSetting` 加 `defaultTrue` 形参：形参会把「判据」这一层再次分家
 * （上面 `boolSetting` 的注释已记：有参数之名、无参数之实的形参正是 G3 要治的病）。两条判据
 * 各有明确的语义名，读调用点即知缺省是本还是末。
 *
 * 三写法全收（'1'/on 是本仓其它缺省关键族的既有写法，见 device-mqtt / device-homeassistant），
 * 使本函数对历史写法不挑食；读失败按「关」（与缺省同向，严格模式不会被读失败悄悄点开）。
 */
export function readBoolSettingDefaultOff(db: BoolSettingDb, key: string): boolean {
  try {
    const row = db.prepare('SELECT value FROM wa_settings WHERE key = ?').get(key) as { value?: string } | undefined;
    const v = row?.value;
    return v === 'true' || v === '1' || v === 'on';
  } catch { return false; }
}

/**
 * G3 库值规范化（随启动一次性迁移，标记 `migration.bool_setting_normalize` 守护）：
 * 把白名单键的 `'0'→'false'` / `'1'→'true'` 做**同义改写**（不改语义，只改写法），
 * 使库值与判据的口径一致——此后 DB 里「关」只有一种写法。
 *
 * 为什么只改写法而非直接改语义：'1' 在 boolSetting 下本就判为开，改写为 'true' 仍是开（零行为变化）；
 * '0' 在 boolSetting 下判为关，改写为 'false' 仍是关（零行为变化）。故本迁移**在判据口径下是恒等的**，
 * 它的作用是让「库值」与「判据」不再有两套说法，而不是替用户改设置。
 *
 * 真库实证（M0）：白名单内唯一非规范值即 deliverable.show_acceptance='0'，故首发生效行数预期 = 1。
 */
export function normalizeBooleanSettingValues(db: BoolSettingDb, marker = 'migration.bool_setting_normalize'): number {
  try {
    const done = db.prepare('SELECT 1 FROM wa_settings WHERE key = ?').get(marker);
    if (done) return 0;
    let changed = 0;
    for (const key of BOOL_SETTING_KEYS) {
      const row = db.prepare('SELECT value FROM wa_settings WHERE key = ?').get(key) as { value?: string } | undefined;
      if (!row) continue;
      if (row.value === '0' || row.value === '1') {
        db.prepare('UPDATE wa_settings SET value = ? WHERE key = ?').run(row.value === '0' ? 'false' : 'true', key);
        changed++;
      }
    }
    db.prepare('INSERT OR IGNORE INTO wa_settings (key, value) VALUES (?, ?)').run(marker, 'done');
    return changed;
  } catch { return 0; /* 规范化失败不阻断启动 */ }
}
