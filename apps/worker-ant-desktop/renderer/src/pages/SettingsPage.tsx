import { useState, useEffect } from 'react';
import { invoke } from '../lib/ipc';
// zx_20261005 M8: 许可读写走专用通道（激活须验签落库，不经通用 settings:set）；`LicenseState` 取 main 侧真源。
import { license as licenseApi, IpcError, nodes as nodesApi, sample as sampleApi } from '../lib/ipc';
// zx_20261005 M21: ANS 缺省地址**单一真源**在 shared-types；renderer 经 `ans:defaults` 过桥取（不直引包）。
import { ans as ansApi, admin as adminApi } from '../lib/ipc';
// zx_20261112_1 B4「诊」：ANS「测试连接」复用 `admin:health` 的真探针（受保护请求 + 三态 + 一句依据），
//   词表与仪表盘同源（`HEALTH_LEVEL_LABEL`），本页不另造"连不上/连得上"的二值说法。
import { HEALTH_LEVEL_LABEL, isHealthLevel, type HealthReport } from '../../../src/main/core/health-check.js';
import type { LicenseStatus } from '../lib/ipc';
// zx_20261023_5 批五: 云端权益上屏形状同引 main IPC 真源（仅类型，打包期擦除）。
import type { CloudEntitlementPayload } from '../../../src/main/ipc/license.ipc.js';
import { seatText } from '../lib/seat-view';
import { formatDbTime } from '../lib/deliverable-view';
// zx_20261005 M11: 定价与权益同引 main 侧**唯一真源**（`core/pricing.ts`）——渲染层不自带价格字面量。
import type { PricingPayload } from '../../../src/main/core/pricing.js';
// zx_20261018_2 批五: 档位对照形状取 main 侧真源（`core/tier-catalog.ts`），不手抄镜像。
import type { TierCatalogPayload } from '../../../src/main/core/tier-catalog.js';
// zx_20261022_3 批九: 用量形状同引 main 侧真源（`core/tier-usage.ts`）；本页只上屏，不自行数库/猜上限。
import type { TierUsagePayload } from '../../../src/main/core/tier-usage.js';
import { Monitor, Cpu, HardDrive, RefreshCw, Lock, Check, Globe, Save, Bell, Package, GitBranch, Shield, ShieldCheck, ListTree, Terminal, BookOpen } from 'lucide-react';
// zx_20261111_3「显」：第一行的唯一真源在 main 纯模块（设置页只说"还差什么"，不自己排优先级）。
import NextActionBar from '../components/NextActionBar';
import { nextActionForSettings, type NextActionId } from '../../../src/main/core/next-action.js';
// zx_20260910_3 M3(G3): 布尔 setting 判据**两侧共用同一文件**——读写同一口径，防"写 '0' 而读只认 'false'"
import { boolSetting } from '../../../src/main/core/settings-bool.js';
// zx_20261107_1 B8「名实」: 布尔键**白名单**同引 main 那一份——「高级设置」区由它自动枚举，
//   本页不再手抄第二张名单（新增键自动进区，不会再出现"注册了却点不到"）。
//   刻意与上一行分开写：旧套 `rr_zx_20260910_3_b3` 以 `import { boolSetting }` 的**精确形状**钉住两侧共用一份判据。
import { BOOL_SETTING_KEYS } from '../../../src/main/core/settings-bool.js';
// zx_20260924 M6-c: 成本上限的**键名**同样不手抄——读端（`readMaxCostPer1k`）在哪，键就在哪
import { MAX_COST_PER_1K_KEY } from '../../../src/main/core/model-request.js';
// zx_20261018_3 批四「度」: 机器并发上限设置键（零依赖真源；引擎读口 `task-accounting` 引同一份）。
import { MACHINE_CONCURRENCY_SETTING_KEY } from '../../../src/main/core/settings-keys.js';
// zx_20261012_2 批一（策略可配）: 五个 policy.* 数值键的**名单**与主进程共用同一份零依赖模块
//   （`policy-config` 经 `policy-engine → logger(pino)` 带 node 依赖，渲染层不可引；故键名独立成 `policy-keys`）。
import { POLICY_OVERRIDES } from '../../../src/main/core/policy-keys.js';
// zx_20261023_4: 首启设密码卡片也在设置页挂一次——用户软跳过向导后仍可设自己的密码。
import LocalOwnerPasswordCard from '../components/LocalOwnerPasswordCard';
// zx_20261108_1 B5：动作路径的**可见结果**——写失败不再静默吞掉（本地显示回滚 + 红条说明原因）。
import { ActionFeedback, useActionFeedback } from '../lib/action-feedback';
// zx_20261108_1 B5：缺省关键的三写法解析（'true'/'1'/'on'）与 main 侧同一份，面板不再手抄。
import { parseTriState } from '../../../src/main/core/settings-bool.js';

// 购买入口与各档定价由 main 侧 `core/pricing.ts` 一处供（经 `license:pricing` 过桥）——
// 渲染层**不再**自带价格字面量或 URL（改价只改真源一处；承 M21「第二落点」纪律）。

/**
 * zx_20261022_3 批九: 一条用量条。`limit === 0` = 不限（不画进度，避免"0 上限"的误读）。
 * 颜色只在**达到上限**时转红——不到上限就只是"用了多少"，不是告警。
 */
function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const unlimited = limit === 0;
  const reached = !unlimited && used >= limit;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="text-gray-500">{label}</span>
        <span className={reached ? 'font-medium text-red-600' : 'text-gray-700'}>
          {unlimited ? `${used}（不限）` : `${used}/${limit}`}
        </span>
      </div>
      {!unlimited && (
        <div className="h-1.5 bg-gray-100 rounded mt-1 overflow-hidden">
          <div className={`h-full rounded ${reached ? 'bg-red-400' : 'bg-blue-400'}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

// ═══ zx_20261107_1 B8「实·通·信」：布尔开关三张名单，与 main `BOOL_SETTING_KEYS` 同一把尺 ═══
//   ① EXPOSED：本页有专属开关行（每行有自己的标题与说明，用户点得到）；
//   ② ELSEWHERE：在他页有专属入口（设备页 / 协同页）——此处**不再摆第二个开关**，
//      否则同一键两个入口，规则当场分家；`node.external_inbound` 还须走 `external:setInbound`
//      真起真停（通用 `settings:set` 只写库，写了不真起 = 本轮要治的名实不符）；
//   ③ ADVANCED：其余全部，收进「高级设置」区（键名 + 中文名 + 开关，一个不少）。
//   三者并集必须**恰等于**白名单——不满足即意味着新增了一个无处可点的开关。
//   断言在 `scripts/rr_zx_20261107_1_settings.ts`：名单由白名单派生，新增键自动进高级区，不会掉队。
const DELIV_OPTS: Array<{ key: string; label: string; desc: string; mainConsumed?: boolean }> = [
  { key: 'show_delivery_digest', label: '本阶段成果交付单', desc: '项目详情顶部成果交付单卡（里程碑/主要成果/已验收/高质）。' },
  { key: 'digest_window_switch', label: '交付单时间窗切换', desc: '交付单 全部/近30/近7 切换条（false=回 all-time）。' },
  { key: 'primary_marker', label: '★主要成果标记', desc: '产出物页/抽屉/交付单的 ★ 置主与展示。' },
  { key: 'primary_auto', label: 'finalize 自动置 primary', desc: '验收全过后自动把最新 doc 置主要成果（人工仍可撤）。主进程消费，下一任务收口生效。', mainConsumed: true },
  { key: 'show_acceptance', label: '验收徽标(✓已验收)', desc: '产出物列表/交付单/抽屉的验收证据透出；false 时两入口(list/digest/preview)一致隐藏。' },
  { key: 'per_doc_acceptance', label: '验收按产出物逐条显示', desc: '同一任务多 doc 各显各的 ✓（验收后才补的 doc 不显）；关=回落整任务扇出。主进程消费，下一收口生效。', mainConsumed: true },
  { key: 'task_achievement_summary', label: '任务列表成果摘要', desc: '任务列表行「成果N·✓验收p/t·★主」chip。' },
  { key: 'doc_drawer', label: '就地成果详情抽屉', desc: '交付单/最近产出物/任务详情/命令面板点 doc 就地展开版本流·验收·溯源。' },
];

const IM_OPTS: Array<{ key: string; label: string; desc: string }> = [
  { key: 'notify_to_creator', label: '关键通知只发给任务创建人', desc: '完成/失败通知投给任务创建人（无 IM 来源的任务回落最近 1:1 私聊）。关=回落旧「全渠道广播」（多渠道部署会把通知发给非创建人）。' },
  { key: 'notify_pause_needed', label: '需人工介入暂停时通知', desc: 'agent 判定需人介入的暂停（硬暂停/无进展/内容不充分/partial 悬置）推 ⚠️ 给创建人；用户主动暂停（GUI/托盘）不推。' },
];

const EXPOSED_BOOL_KEYS: readonly string[] = [
  ...DELIV_OPTS.map((o) => `deliverable.${o.key}`),
  ...IM_OPTS.map((o) => `im.${o.key}`),
  'engine.policy_check',
  'sched.critical_path',
  'engine.model_capability_gate',
  'engine.capability_strict_fallback',
  'engine.plan_auto_decompose',
  'engine.shell_multi_segment',
  'engine.kill_background_on_exit',
  // zx_20261113_4 B1「成」：项目画像首次自动成型（缺省即开；关 ⇒ 回「首次由用户点」旧行为）
  'profile_auto_bootstrap',
];

const ELSEWHERE_BOOL_KEYS: readonly string[] = [
  'device.intent_model_fallback', // 设备页「意图模型兜底」
  'node.external_inbound',        // 协同页「外部终端入站」——真起真停走 external:setInbound，不能只写库
];

const ADVANCED_BOOL_KEYS: readonly string[] = BOOL_SETTING_KEYS.filter(
  (k) => !EXPOSED_BOOL_KEYS.includes(k) && !ELSEWHERE_BOOL_KEYS.includes(k),
);

const ADVANCED_GROUPS: Array<{ label: string; prefix: string }> = [
  { label: '交付与展示', prefix: 'deliverable.' },
  { label: '引擎行为', prefix: 'engine.' },
  { label: '记忆', prefix: 'memory.' },
  { label: 'IM 通知', prefix: 'im.' },
  { label: '界面与常驻', prefix: 'ui.' },
  { label: '其它', prefix: '' },
];
const advancedGroupOf = (key: string): string =>
  ADVANCED_GROUPS.find((g) => !!g.prefix && key.startsWith(g.prefix))?.label ?? '其它';

// 高级区 26 个键的中文名——用户可见文案落在 renderer（词表第二落点）；缺名即由断言弄红。
const ADVANCED_BOOL_LABELS: Record<string, string> = {
  'deliverable.acceptance_on_close': '收口时自动验收',
  'deliverable.probe_disposition': '探针文件处置',
  'deliverable.primary_prefer_created': '优先「已创建」置主',
  'deliverable.first_write_v1': '首次写入 v1 口径',
  'engine.completion_gate_no_output': '无产出不得算完成',
  'engine.failed_with_reason': '失败必须带原因',
  'engine.children_failed_pause': '子任务失败即暂停',
  'engine.answer_provenance': '回答标注出处',
  'engine.deviation_full_input': '偏离判据完整输入',
  'engine.shell_advice_honest': 'Shell 拒绝文案如实化',
  'engine.milestone_subject_check': '里程碑主体校验',
  'memory.outcome_exemplar': '按结局取范式',
  'memory.receipt_dedup': '回执去重',
  'memory.exemplar_effect_rank': '范式按实效排序',
  'memory.consolidation_idle_skip': '空闲跳过巩固',
  'memory.schema_recall': '图式重构召回',
  'im.completion_summary': '完成摘要',
  'im.busy_ack': '忙时回执',
  'im.notice_single_source': '通知单一来源',
  'ui.presence_bar': '常驻状态条',
  'ui.presence_minimize': '状态条最小化',
  'ui.tray_presence_menu': '托盘状态菜单',
  'ui.stale_running_hint': '卡死任务提示',
  'plan.link_at_create': '新建任务时可关联方案',
  'notification.pause_and_deviation': '暂停/偏离通知',
  'ans_auto_start': '自动托管本机 ANS',
};

// 搜索：分区关键词（卡片级过滤）——中文分词做不到，就按"用户会打的词"列在这里。
const SECTION_KEYWORDS: Record<string, string> = {
  'local-owner': '本机密码 所有者 账号',
  password: '修改密码 账号 登录',
  ans: 'ANS 服务 地址 API Key 密钥 资源',
  notify: '桌面通知 免打扰 安静时段 系统通知 横幅 toast',
  sound: '提示音 声音',
  deliverable: '成果展示 交付单 产出物 验收 主要成果 抽屉',
  model: '模型选型 成本 单价 上限 美元 价格',
  concurrency: '机器并发 并发上限 CPU 核数',
  sched: '调度顺序 关键路径 优先级 启动',
  decompose: '任务拆解 计划 自动拆解 子任务 模板',
  knowledge: '项目业务知识 画像 领域包 自动成型 知识',
  shell: '命令执行 多段 后台进程 退出 sudo',
  policy: '策略引擎 熔断 失败数 预算 Token 阈值',
  capability: '模型能力 把关 严格备用 降级 选型失败 硬需',
  orchestrate: '多机协同 编排 外派 建单即派 节点 团队',
  im: 'IM 通知 创建人 暂停 补发 回执 摘要 渠道',
  license: '许可 激活 档位 用量 定价 权益 云端 指纹 升级 容量 试用 席位',
  sample: '示例项目 演示',
  sysinfo: '系统信息 版本 平台 数据库 开源许可',
  update: '自动更新 检查更新',
  stack: '技术栈 框架 组件',
};
const ADVANCED_KEYWORDS = '高级设置 开关 布尔 白名单';

export default function SettingsPage() {
  // zx_20261108_1 B5：动作路径**可见结果**的总闸——写失败回滚本地值并红条说明原因。
  const fb = useActionFeedback();
  /** 设置写口。此前每个开关都是 `try { … } catch {}`：没写进去，界面却仍显示"已打开/已保存"。 */
  const saveSetting = async (what: string, key: string, value: string, revert: () => void) => {
    try {
      await invoke('settings:set', key, value);
    } catch (e) {
      revert();
      fb.fail(`「${what}」未保存`, e);
    }
  };
  const [checking, setChecking] = useState(false);
  const [updateMsg, setUpdateMsg] = useState('');
  const [pwForm, setPwForm] = useState({ oldPassword: '', newPassword: '' });
  const [pwMsg, setPwMsg] = useState('');
  const [pwOk, setPwOk] = useState(false);
  const [ansConfig, setAnsConfig] = useState({ ans_server_url: '', ans_api_key: '', ans_secret_key: '' });
  // zx_20261022_3 批四: 密钥**不再回填**（`settings:getAll` 已脱敏）；只知「是否已配置」，
  //   输入框留空＝不修改。旧界面把读回的值原样写回，脱敏后会覆盖成 `***`——写口另有挡回守卫。
  const [ansSecretSet, setAnsSecretSet] = useState({ apiKey: false, secretKey: false });
  const [ansLoaded, setAnsLoaded] = useState(false);
  const [ansSaved, setAnsSaved] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  // A2 (2026-09-03): 桌面原生通知开关
  const [sysNotif, setSysNotif] = useState(true);
  // zx_20260906 批4 (4c): 全局免打扰总开关（六路降为一路中心记录——通知中心/铃点/需处理仍记录，不弹不响）
  const [dnd, setDnd] = useState(false);
  // B1 (2026-09-03_2): 免打扰时段
  const [quietStart, setQuietStart] = useState('');
  const [quietEnd, setQuietEnd] = useState('');
  // C1 (2026-09-04_2): 安静时段是否连"失败/需输入"应用内 toast 也静音（原生仍守中弹）
  const [quietMuteCritical, setQuietMuteCritical] = useState(false);
  // D2 (2026-09-04_2): 提示音（全局 + 分事件类）
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [snd, setSnd] = useState({ completed: true, failed: true, await: true });
  // zx_20260909 X2④(道德经·有无相生 / 王阳明·知行合一): 成果展示开关组——deliverable.* 键此前无 GUI 只能 DB 直改(回退"标而不准"), 本组让其真实可点
  // zx_20261107_1 B8: `DELIV_OPTS` / `IM_OPTS` 上提到模块作用域——高级区的三张名单要由它们派生。
  const [delivOpts, setDelivOpts] = useState<Record<string, boolean>>(Object.fromEntries(DELIV_OPTS.map((o) => [o.key, true])));
  // zx_20260909_1 补⑤(§十三): IM 通知开关组——im.* 键此前无 GUI 只能 DB 直改
  const [imOpts, setImOpts] = useState<Record<string, boolean>>(Object.fromEntries(IM_OPTS.map((o) => [o.key, true])));
  const [outboxRetryMin, setOutboxRetryMin] = useState('10');
  // zx_20261012_2 批一(策略可配): 策略引擎——阈值/窗口此前写死在源码、GUI 无处可调（只能 DB 直改）。
  //   键名名单与主进程**共用**（`POLICY_OVERRIDES`）；中文标签在此（用户可见文案，第二落点）。
  const POLICY_NUM_LABELS: Record<string, { label: string; desc: string; min: number; max: number }> = {
    'policy.cascade_fail_threshold': { label: '熔断：近期失败数阈值', desc: '项目「最近 N 个任务」中失败数达到此值 ⇒ 暂停新任务（N 见下一条）。', min: 1, max: 9999 },
    'policy.cascade_fail_window': { label: '熔断：统计窗口（最近 N 个任务）', desc: '只数最近 N 个任务的失败数。此前该窗口写了却从不生效（数的是全时段），历史失败会误触熔断致新任务开跑即停。', min: 1, max: 9999 },
    'policy.notify_fail_threshold': { label: '通知：近期失败数阈值', desc: '项目近期失败数达到此值 ⇒ 记一条策略通知（不暂停任务）。', min: 1, max: 9999 },
    'policy.notify_fail_window': { label: '通知：统计窗口（最近 N 个任务）', desc: '只数最近 N 个任务的失败数。', min: 1, max: 9999 },
    'policy.budget_tokens': { label: 'Token 预算上限', desc: '任务 Token 消耗上限：执行中逐拍累计评估，达到上限即暂停任务并告知。留空 = 用内置缺省（3,000,000）。', min: 0, max: 999999999 },
  };
  const [policyCheck, setPolicyCheck] = useState(true);
  // zx_20261023_5 批一：就绪排序「关键路径优先」（缺省即开；关 ⇒ 回 priority DESC, created_at ASC 旧序）
  const [criticalPath, setCriticalPath] = useState(true);
  const [policyNums, setPolicyNums] = useState<Record<string, string>>({});
  // zx_20261013_1 批一（称器于事）: 能力硬需把关开关（缺省即开）。开 ⇒ 最终在用模型缺本任务**硬需**能力
  //   （vision/chat/function-calling）则如实拒；关 ⇒ 逐字回"只记不拦"旧行为（一键回退）。真源 `core/settings-bool.ts`。
  const [capGate, setCapGate] = useState(true);
  // zx_20261022_3 批六：严格备用（缺省关——保持「可用性优先」裁定；见 settings-bool.ts 该键注释）。
  const [strictFallback, setStrictFallback] = useState(false);
  // zx_20261028_2 M4：计划自动拆解（`engine.plan_auto_decompose`，**缺省即开**）。
  //   关 ⇒ `autoDecomposeForTask` 直接 null，逐字回"模型不主动进计划模式就不拆"的旧行为。
  const [planAutoDecompose, setPlanAutoDecompose] = useState(true);
  // zx_20261029_3 M5：多段命令逐段校验（缺省即开）。关 ⇒ `execute_command` 回"分隔符一律拒"旧行为。
  const [shellMultiSegment, setShellMultiSegment] = useState(true);
  const [killBackgroundOnExit, setKillBackgroundOnExit] = useState(true);
  // zx_20261113_4 B1「成」：项目画像首次自动成型（缺省即开；关 ⇒ 回「首次由用户点」旧行为）。
  const [profileAutoBootstrap, setProfileAutoBootstrap] = useState(true);
  // zx_20261107_1 B8: 高级区（白名单里没有专属开关的布尔键）+ 设置页搜索。
  //   高级键一律「缺省即开」⇒ 首帧先按开渲染，载入后按库值校正（不闪成"全关"再翻回来）。
  const [advBool, setAdvBool] = useState<Record<string, boolean>>(
    () => Object.fromEntries(ADVANCED_BOOL_KEYS.map((k) => [k, true])),
  );
  const [settingsQuery, setSettingsQuery] = useState('');
  // zx_20260924 M6-c: 模型选型成本上限（美元/1k tokens）的**写端**。
  //   此前该键只有读端（`readMaxCostPer1k`，由 `exec-model-select` 喂进 ANS 的 `maxCostPer1k`），
  //   GUI 无处可点 ⇒ 成本闸实际上是一条"装好了却没人能上电"的线。此处补上入口。
  const [maxCostPer1k, setMaxCostPer1k] = useState('');
  // zx_20261018_3 批四「度」: 机器级并发上限的**写端**。此前只有项目闸，整机总量无上限——
  //   多个项目各跑几个，同一台机器可以同时压远超其承载的 Agent 循环。留空 = 按 CPU 核数派生（核数-1，夹在 [2,8]）。
  const [machineMaxConcurrency, setMachineMaxConcurrency] = useState('');
  // zx_20261005 M8: 许可状态 / 输入 / 结果提示 + 应用版本（版本取 `app.getVersion()`，不再手写字面量）。
  const [lic, setLic] = useState<LicenseStatus | null>(null);
  const [licInput, setLicInput] = useState('');
  const [licMsg, setLicMsg] = useState('');
  const [licBusy, setLicBusy] = useState(false);
  // zx_20261023_5 批五: 云端权益（main 缓存真源）。本页只上屏**同步结果/不可达原因**，
  //   不解析 JSON、不自行加档——档位合并只发生在 main `resolveLicenseState` 一处。
  const [cloud, setCloud] = useState<CloudEntitlementPayload | null>(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudMsg, setCloudMsg] = useState('');
  // zx_20261012_1 批四: 示例项目一键载入/删除（与真实数据隔离；真逻辑在 main 侧 core/sample-project.ts）。
  const [sampleMsg, setSampleMsg] = useState('');
  const [sampleBusy, setSampleBusy] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  // zx_20261005 M11: 定价与权益（真源 main `core/pricing.ts`）；读不到就整块不显示，不摆空壳价。
  const [pricing, setPricing] = useState<PricingPayload | null>(null);
  // zx_20261018_2 批五: 档位能力对照（真源 main `core/tier-catalog.ts`，`included` 与真实软闸同一判据）。
  const [catalog, setCatalog] = useState<TierCatalogPayload | null>(null);
  // zx_20261022_3 批九: 档位用量（真源 main `core/tier-usage.ts`）；读不到就整块不显示，不摆假 0。
  const [usage, setUsage] = useState<TierUsagePayload | null>(null);
  // zx_20261005 M21: ANS 缺省地址（来自 `ans:defaults` 的单一真源，作未配置时的 fallback / placeholder）。
  const [ansDefaultUrl, setAnsDefaultUrl] = useState('');
  // zx_20261005 M16: 三态判据（未配置 / 已配置 / 开发态）——由 main 侧 `ans:status` 过桥。
  //   渲染层**不自行推断**"配没配"（否则是同一判据的第二个落点，两侧漂开即名实不符）。
  const [ansStatus, setAnsStatus] = useState<{ configured: boolean; isDev: boolean } | null>(null);
  // zx_20261112_1 B4「诊」：ANS 连接测试——结果**就地**显示（不弹 alert），失败保留原因。
  const [ansTestBusy, setAnsTestBusy] = useState(false);
  const [ansTest, setAnsTest] = useState<{ ok: boolean; text: string } | null>(null);
  // zx_20261111_3「显」：第一行要的两件事之一——全局默认模型（`settings:get` 既有读口）。
  //   `modelReadOk=false` ⇒ 没取到，第一行说"未取得"，不冒充"按自动选型"。
  const [defaultModel, setDefaultModel] = useState<string>('');
  const [modelReadOk, setModelReadOk] = useState(false);
  // zx_20261011_4 M4: 多机协同**编排模式**（本机设置 `node.orchestrate_mode`）。词表由 main 一处真源给
  //   （`nodes:orchestrate-mode` 随读回传 `modes`）——本页只按它摆选项，不手抄 `off`/`auto`。
  const [orchMode, setOrchMode] = useState('off');
  const [orchModes, setOrchModes] = useState<string[]>([]);
  // zx_20261017_1 批三: 建单即派；zx_20261029_2 M7 起为三态（显式/缺省），策略与理由随读口一并回。
  const [autoDispatch, setAutoDispatch] = useState(false);
  const [autoPolicy, setAutoPolicy] = useState<{ source: 'explicit' | 'default'; reason: string } | null>(null);
  const ORCH_LABEL: Record<string, string> = {
    off: '关闭（默认）—— 全部在本机跑',
    auto: '自动外派 —— 本机并发占满时把溢出的就绪子任务派给他机',
  };

  const reloadLicense = async () => {
    try { setLic(await licenseApi.status()); } catch { /* 读不到就留空态，不打断设置页 */ }
  };
  useEffect(() => {
    void reloadLicense();
    licenseApi.appVersion().then(setAppVersion).catch(() => { /* 浏览器态无此通道 */ });
    licenseApi.pricing().then(setPricing).catch(() => { /* 浏览器态无此通道 */ });
    licenseApi.catalog().then(setCatalog).catch(() => { /* 浏览器态无此通道 */ });
    // 用量含 ANS 节点台账（异步、可能较慢）——不阻塞设置页其它内容。
    licenseApi.usage().then(setUsage).catch(() => { /* 浏览器态/ANS 不可达时整块不显示 */ });
    // 云端权益只读缓存（不发请求）；启动时 main 已 5 秒有界拉过一次。
    licenseApi.cloud().then(setCloud).catch(() => { /* 浏览器态无此通道 */ });
    // zx_20261111_3「显」：第一行要的默认模型（同一读口，不在渲染层猜）。
    invoke<string | null>('settings:get', 'model.default_model')
      .then((v) => { setDefaultModel(v || ''); setModelReadOk(true); })
      .catch(() => { setModelReadOk(false); });
  }, []);

  /** 用户点「重新同步」：main 侧拉一次（5s 有界、失败 fail-open）；档位可能因此变化 ⇒ 重取状态与用量。 */
  async function refreshCloudEntitlement() {
    setCloudBusy(true); setCloudMsg('');
    try {
      const next = await licenseApi.cloudRefresh();
      const { reason, ...payload } = next;
      setCloud(payload);
      setCloudMsg(reason ?? (next.active ? `已同步：${next.tierLabel ?? next.tier}` : '已同步：云端当前无生效权益'));
      await reloadLicense();
      licenseApi.usage().then(setUsage).catch(() => {});
    } catch (e) {
      setCloudMsg(`同步失败：${(e as Error).message}`);
    } finally { setCloudBusy(false); }
  }

  async function handleActivateLicense() {
    const text = licInput.trim();
    if (!text) { setLicMsg('请先粘贴许可文本'); return; }
    setLicBusy(true); setLicMsg('');
    try {
      const next = await licenseApi.activate(text);
      setLic(next); setLicInput(''); setLicMsg(`✓ 已激活：${next.tierLabel}`);
      // 档位变了 ⇒ 上限与升级差异跟着变；重取一次用量（失败不打断激活流程）。
      licenseApi.usage().then(setUsage).catch(() => {});
    } catch (e) {
      // 坏件如实回原因（`IpcError.code === 'LICENSE_INVALID'` 时 message 即校验结论）
      setLicMsg(`${e instanceof IpcError ? '' : '激活失败：'}${(e as Error).message}`);
    } finally { setLicBusy(false); }
  }

  // 加载 ANS 配置 + 桌面通知开关
  useEffect(() => {
    (async () => {
      try {
        // zx_20261005 M21: 未配置时的 fallback 取 `ans:defaults`（单一真源），不再手抄 localhost:3001——
        //   否则改端口后此处会显示一个**已不存在**的地址（名实不符）。
        const defUrl = await ansApi.defaults().then((d) => d.baseUrl).catch(() => '');
        setAnsDefaultUrl(defUrl);
        // zx_20261005 M16: 三态由 main 侧 `ans:status` 给（真源在 `resolveAnsCreds`+形态开关，不在此自判）。
        ansApi.status().then((s) => setAnsStatus({ configured: !!s.configured, isDev: !!s.isDev })).catch(() => {});
        const all = await invoke<Record<string,string>>('settings:getAll') as unknown as Record<string,string>;
        // zx_20261005 M16: **不再**用开发凭据兜底（`||` 到 dev 缺省）——那是 dev 缺省在渲染层的
        //   第二个落点：生产构建里它会把开发凭据 **预填给用户**（本 M16 要拦的正是这件事）。
        //   表单缺省改为空串；开发态的 dev 缺省由 main 侧首启种子(`ansSeedCreds`)写库、此处 `all.*` 自然读到。
        // zx_20261022_3 批四：凭据字段**恒留空**（读口已脱敏，取回的是 `***` 或 null）——
        //   「留空＝不修改」，见 `handleSaveAns`；是否能显示占位由 `settings:secretStatus` 说。
        if (all) setAnsConfig({ ans_server_url: all.ans_server_url || defUrl, ans_api_key: '', ans_secret_key: '' });
        {
          const st = await invoke<Record<string, boolean>>('settings:secretStatus').catch(() => ({} as Record<string, boolean>));
          setAnsSecretSet({ apiKey: st?.ans_api_key === true, secretKey: st?.ans_secret_key === true });
        }
        setSysNotif((all.ui_system_notifications ?? '1') !== '0');
        setDnd(all.ui_dnd === '1');
        setQuietStart(all.notify_quiet_start || '');
        setQuietEnd(all.notify_quiet_end || '');
        setQuietMuteCritical(all.notify_quiet_mute_critical === '1');
        setSoundEnabled((all.notify_sound_enabled ?? '1') !== '0');
        setSnd({ completed: (all.sound_completed ?? '1') !== '0', failed: (all.sound_failed ?? '1') !== '0', await: (all.sound_await ?? '1') !== '0' });
        // zx_20260909 X2④: 成果展示开关组装载(deliverable.* 点号键; 缺省视为 true)
        // zx_20260910_3 M3(G3): 判据改用与 main/渲染各页共用的唯一实现 boolSetting——
        // 它同时认 'false' 与历史写法的 '0'(旧写端曾落 '0'/'1', show_acceptance 残留 '0' 即此故)，开关才不再"关而不灭"
        const dl: Record<string, boolean> = {};
        for (const o of DELIV_OPTS) dl[o.key] = boolSetting(all[`deliverable.${o.key}`]);
        setDelivOpts(dl);
        // zx_20260909_1 补⑤: IM 通知组(im.* 点号键; 布尔键缺省 true, 写 'true'/'false'; 补发窗口为分钟数, 0=关)
        const im: Record<string, boolean> = {};
        for (const o of IM_OPTS) im[o.key] = boolSetting(all[`im.${o.key}`]);
        setImOpts(im);
        setOutboxRetryMin(all['im.outbox_retry_min'] ?? '10');
        // zx_20261012_2 批一: 策略闸开关 + 五个 policy.* 数值(键名取自共用名单; 读不到留空=内置缺省)
        setPolicyCheck(boolSetting(all['engine.policy_check']));
        // zx_20261023_5 批一：关键路径优先（同一把 boolSetting 尺；缺省即开）
        setCriticalPath(boolSetting(all['sched.critical_path']));
        // zx_20261013_1 批一: 能力把关开关（同 `boolSetting` 一处真源；缺省即开）
        setCapGate(boolSetting(all['engine.model_capability_gate']));
        // ⚠ 本键**缺省关**，不能用 `boolSetting`（它「只有明确说关才算关」⇒ 缺省为真）；
        //   引擎侧消费 `readBoolSettingDefaultOff`（同一把尺：「只有明确说开才算开」），面板侧用同一份三写法解析。
        setStrictFallback(parseTriState(all['engine.capability_strict_fallback']) === 'true');
        // zx_20261028_2 M4：计划自动拆解（同一把 `boolSetting` 尺；缺省即开）
        setPlanAutoDecompose(boolSetting(all['engine.plan_auto_decompose']));
        // zx_20261029_3 M5：多段命令逐段校验（同一把 `boolSetting` 尺；缺省即开）
        setShellMultiSegment(boolSetting(all['engine.shell_multi_segment']));
        // zx_20261029_3 M3：退出带走后台进程组（同一把 `boolSetting` 尺；缺省即开）
        setKillBackgroundOnExit(boolSetting(all['engine.kill_background_on_exit']));
        // zx_20261113_4 B1「成」：项目画像首次自动成型（同一把 `boolSetting` 尺；缺省即开）
        setProfileAutoBootstrap(boolSetting(all['profile_auto_bootstrap']));
        // zx_20261107_1 B8：高级区自动枚举——键全部由白名单派生，本页不手抄；读口仍是同一把 `boolSetting` 尺
        const adv: Record<string, boolean> = {};
        for (const k of ADVANCED_BOOL_KEYS) adv[k] = boolSetting(all[k]);
        setAdvBool(adv);
        const pn: Record<string, string> = {};
        for (const o of POLICY_OVERRIDES) pn[o.key] = all[o.key] ?? '';
        setPolicyNums(pn);
        setMaxCostPer1k(all[MAX_COST_PER_1K_KEY] ?? '');
        setMachineMaxConcurrency(all[MACHINE_CONCURRENCY_SETTING_KEY] ?? '');
        // zx_20261011_4 M4: 编排模式（词表随读回传；取不到就留空态，不下发假模式）
        nodesApi.orchestrateMode().then((r) => { setOrchMode(r.mode); setOrchModes(Array.isArray(r.modes) ? r.modes : []); }).catch(() => { /* 浏览器态无此通道 */ });
        // zx_20261017_1 批三: 建单即派开关（zx_20261029_2 M7：连同策略/理由读回；取不到即保持关，不假装已开）
        nodesApi.autoDispatch().then((r) => { setAutoDispatch(!!r.enabled); setAutoPolicy(r.policy ?? null); }).catch(() => { /* 浏览器态无此通道 */ });
      } catch {} finally { setAnsLoaded(true); }
    })();
  }, []);

  const toggleSysNotif = async (on: boolean) => {
    setSysNotif(on);
    await saveSetting('桌面通知', 'ui_system_notifications', on ? '1' : '0', () => setSysNotif(!on));
  };
  const toggleDnd = async (on: boolean) => {
    setDnd(on);
    await saveSetting('免打扰总开关', 'ui_dnd', on ? '1' : '0', () => setDnd(!on));
  };

  const setQuietHour = async (which: 'start' | 'end', v: string) => {
    const prev = which === 'start' ? quietStart : quietEnd;
    if (which === 'start') setQuietStart(v); else setQuietEnd(v);
    const label = which === 'start' ? '免打扰开始时间' : '免打扰结束时间';
    const key = which === 'start' ? 'notify_quiet_start' : 'notify_quiet_end';
    await saveSetting(label, key, v, () => {
      if (which === 'start') setQuietStart(prev); else setQuietEnd(prev);
    });
  };
  const toggleQuietMuteCritical = async (on: boolean) => {
    setQuietMuteCritical(on);
    await saveSetting('安静时段连失败也静音', 'notify_quiet_mute_critical', on ? '1' : '0', () => setQuietMuteCritical(!on));
  };
  const toggleSoundGlobal = async (on: boolean) => {
    setSoundEnabled(on);
    await saveSetting('提示音', 'notify_sound_enabled', on ? '1' : '0', () => setSoundEnabled(!on));
  };
  const toggleSoundClass = async (cls: 'completed' | 'failed' | 'await', on: boolean) => {
    setSnd((p) => ({ ...p, [cls]: on }));
    const key = { completed: 'sound_completed', failed: 'sound_failed', await: 'sound_await' }[cls];
    const label = { completed: '完成提示音', failed: '失败提示音', await: '需输入提示音' }[cls];
    await saveSetting(label, key, on ? '1' : '0', () => setSnd((p) => ({ ...p, [cls]: !on })));
  };
  const toggleDeliv = async (key: string, on: boolean) => {
    setDelivOpts((p) => ({ ...p, [key]: on }));
    // M5 实机复核修: 写 'true'/'false'(deliverable.* 消费方按 !=='false' 判定); 写 '0'/'1' 会致关闭不生效
    await saveSetting('成果展示开关', `deliverable.${key}`, on ? 'true' : 'false', () => setDelivOpts((p) => ({ ...p, [key]: !on })));
  };
  const toggleIm = async (key: string, on: boolean) => {
    setImOpts((p) => ({ ...p, [key]: on }));
    // 与 deliverable.* 同口径: 消费方按 !=='false' 判定, 故写 'true'/'false'(写 '0'/'1' 会致关闭不生效)
    await saveSetting('IM 通知开关', `im.${key}`, on ? 'true' : 'false', () => setImOpts((p) => ({ ...p, [key]: !on })));
  };
  const commitOutboxMinutes = async (raw: string) => {
    const prev = outboxRetryMin;
    const v = Math.max(0, Math.min(1440, Math.floor(Number(raw) || 0)));
    setOutboxRetryMin(String(v));
    await saveSetting('IM 补发窗口（分钟）', 'im.outbox_retry_min', String(v), () => setOutboxRetryMin(prev));
  };
  // zx_20261012_2 批一: 策略闸开关 + 数值提交口（照 `commitOutboxMinutes` 手法：受控输入 + 失焦提交 + 回写钳位值）。
  //   空串**不**当 0——按"用内置缺省"办（主进程 `readNumberSetting` 读空即回落 `DEFAULT_POLICIES` 同名字段）。
  const togglePolicyCheck = async (on: boolean) => {
    setPolicyCheck(on);
    await saveSetting('策略闸', 'engine.policy_check', on ? 'true' : 'false', () => setPolicyCheck(!on));
  };
  // zx_20261023_5 批一：关键路径优先（缺省即开；写 'true'/'false' 与 `boolSetting` 同口径）
  const toggleCriticalPath = async (on: boolean) => {
    setCriticalPath(on);
    await saveSetting('关键路径优先', 'sched.critical_path', on ? 'true' : 'false', () => setCriticalPath(!on));
  };
  // zx_20261013_1 批一: 能力把关开关（`engine.model_capability_gate`，缺省即开；写 'true'/'false' 与消费端一致）。
  const toggleCapGate = async (on: boolean) => {
    setCapGate(on);
    await saveSetting('能力硬需把关', 'engine.model_capability_gate', on ? 'true' : 'false', () => setCapGate(!on));
  };
  // zx_20261022_3 批六: 严格备用开关（`engine.capability_strict_fallback`，**缺省关**；写 'true'/'false'，
  //   读端 `readBoolSettingDefaultOff` 亦认 '1'/'on'，故历史写法不会把用户的开读成关）。
  const toggleStrictFallback = async (on: boolean) => {
    setStrictFallback(on);
    await saveSetting('严格备用', 'engine.capability_strict_fallback', on ? 'true' : 'false', () => setStrictFallback(!on));
  };
  // zx_20261028_2 M4：计划自动拆解（缺省即开；写 'true'/'false' 与 `readBoolSetting` 同口径）
  const togglePlanAutoDecompose = async (on: boolean) => {
    setPlanAutoDecompose(on);
    await saveSetting('计划自动拆解', 'engine.plan_auto_decompose', on ? 'true' : 'false', () => setPlanAutoDecompose(!on));
  };
  // zx_20261029_3 M5：多段命令逐段校验（缺省即开；写 'true'/'false' 与 `readBoolSetting` 同口径）
  const toggleShellMultiSegment = async (on: boolean) => {
    setShellMultiSegment(on);
    await saveSetting('多段命令逐段校验', 'engine.shell_multi_segment', on ? 'true' : 'false', () => setShellMultiSegment(!on));
  };
  // zx_20261029_3 M3：退出带走后台进程组（缺省即开；写 'true'/'false' 与 `readBoolSetting` 同口径）
  // zx_20261113_4 B1「成」：项目画像自动成型开关（缺省即开；写 'true'/'false' 与主进程 `readBoolSetting` 同口径）。
  const toggleProfileAutoBootstrap = async (on: boolean) => {
    setProfileAutoBootstrap(on);
    await saveSetting('项目画像自动成型', 'profile_auto_bootstrap', on ? 'true' : 'false', () => setProfileAutoBootstrap(!on));
  };
  const toggleKillBackgroundOnExit = async (on: boolean) => {
    setKillBackgroundOnExit(on);
    await saveSetting('退出带走后台进程组', 'engine.kill_background_on_exit', on ? 'true' : 'false', () => setKillBackgroundOnExit(!on));
  };
  // zx_20261107_1 B8：高级区开关——全部由白名单枚举而来，写 'true'/'false' 与消费端 `boolSetting` 同口径。
  //   刻意**不含** `node.external_inbound`（缺省关 + 须真起真停，走协同页 `external:setInbound`）。
  const toggleAdvancedBool = async (key: string, on: boolean) => {
    setAdvBool((p) => ({ ...p, [key]: on }));
    await saveSetting(ADVANCED_BOOL_LABELS[key] ?? key, key, on ? 'true' : 'false', () => setAdvBool((p) => ({ ...p, [key]: !on })));
  };
  const commitPolicyNum = async (key: string, raw: string, min: number, max: number) => {
    const prev = policyNums[key] ?? '';
    const t = raw.trim();
    const n = Number(t);
    const v = t === '' || !Number.isFinite(n) ? '' : String(Math.max(min, Math.min(max, Math.floor(n))));
    setPolicyNums((p) => ({ ...p, [key]: v }));
    await saveSetting(POLICY_NUM_LABELS[key]?.label ?? key, key, v, () => setPolicyNums((p) => ({ ...p, [key]: prev })));
  };
  /**
   * zx_20260924 M6-c: 成本上限的提交口。与 `commitOutboxMinutes` 同形（受控输入 + 失焦提交 + 回写规范化后的值）。
   *
   * 判据与**读端 `readMaxCostPer1k` 同口径**：空 / 非数 / ≤0 一律按"未配置"办（**键写空串**）。
   *   特别地 `0` **不**是"不限"、也不能当上限用——ANS 侧 `(input+output) <= 0` 是"只要免费模型"，
   *   手滑写个 0 会把整池付费模型一次筛没（这正是读端宁 `undefined` 也不返回 0 的原因）。
   */
  /**
   * zx_20261011_4 M4: 编排模式的提交口。写口过 main（`nodes:set-orchestrate-mode`）校验并落库；
   *   失败（含非法值）则**回滚本地显示**（不把"没写进去"显示成"已切过去"）。
   */
  const commitOrchMode = async (mode: string) => {
    const prev = orchMode;
    setOrchMode(mode);
    try {
      await nodesApi.setOrchestrateMode(mode);
    } catch (e) {
      setOrchMode(prev);
      fb.fail('「编排模式」未保存', e);
    }
  };
  /** zx_20261017_1 批三: 建单即派开关提交口（失败回滚显示，不把"没写进去"显示成"已开"）。
   *  zx_20261029_2 M7：写口落的是**显式**值——成功后策略来源随之变为 `explicit`（理由跟 main 同一句话）。 */
  const toggleAutoDispatch = async (on: boolean) => {
    const prev = autoDispatch;
    const prevPolicy = autoPolicy;
    setAutoDispatch(on);
    try {
      await nodesApi.setAutoDispatch(on);
      setAutoPolicy({ source: 'explicit', reason: on ? '已手动开启' : '已手动关闭' });
    } catch (e) {
      setAutoDispatch(prev);
      setAutoPolicy(prevPolicy);
      fb.fail('「建单即派」未保存', e);
    }
  };
  const commitMaxCostPer1k = async (raw: string) => {
    const prev = maxCostPer1k;
    const n = Number(raw);
    const v = Number.isFinite(n) && n > 0 ? String(n) : '';
    setMaxCostPer1k(v);
    await saveSetting('模型选型成本上限', MAX_COST_PER_1K_KEY, v, () => setMaxCostPer1k(prev));
  };
  /** zx_20261018_3 批四「度」: 机器并发上限提交口——留空/非数/≤0 ⇒ 写空串 = 回到 CPU 派生缺省。 */
  const commitMachineMaxConcurrency = async (raw: string) => {
    const prev = machineMaxConcurrency;
    const n = Number(raw);
    const v = Number.isFinite(n) && n > 0 ? String(Math.floor(n)) : '';
    setMachineMaxConcurrency(v);
    await saveSetting('机器并发上限', MACHINE_CONCURRENCY_SETTING_KEY, v, () => setMachineMaxConcurrency(prev));
  };
  const Switch = ({ on, onToggle }: { on: boolean; onToggle: (v: boolean) => void }) => (
    <button type="button" role="switch" aria-checked={on} onClick={() => onToggle(!on)} className={`relative w-9 h-5 shrink-0 rounded-full transition-colors ${on ? 'bg-blue-600' : 'bg-gray-300'}`}>
      <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : ''}`} />
    </button>
  );

  const handleSaveAns = async () => {
    try {
      await invoke('settings:set', 'ans_server_url', ansConfig.ans_server_url);
      // zx_20261022_3 批四：**留空＝不修改**（占位符语义）——空串写回会把已配凭据清掉。
      if (ansConfig.ans_api_key !== '') await invoke('settings:set', 'ans_api_key', ansConfig.ans_api_key);
      if (ansConfig.ans_secret_key !== '') await invoke('settings:set', 'ans_secret_key', ansConfig.ans_secret_key);
      const st = await invoke<Record<string, boolean>>('settings:secretStatus').catch(() => ({} as Record<string, boolean>));
      setAnsSecretSet({ apiKey: st?.ans_api_key === true, secretKey: st?.ans_secret_key === true });
      setAnsConfig((p) => ({ ...p, ans_api_key: '', ans_secret_key: '' }));
      setAnsSaved(true); setTimeout(() => setAnsSaved(false), 2000);
    } catch (e) {
      // 服务地址/凭据是**服务器连接的唯一入口**——写失败必须说，不能让界面装作"已保存"。
      fb.fail('ANS 配置未保存', e);
    }
  };

  /**
   * zx_20261112_1 B4「诊」：ANS「测试连接」——真发一次**受保护**请求（`admin:health` 的 ANS 探针，
   *   三态 + 依据），不另造二值判据。结果就地显示；探针本身失败也如实说"未完成 + 原因"。
   */
  const handleTestAns = async () => {
    if (ansTestBusy) return;
    setAnsTestBusy(true);
    setAnsTest(null);
    try {
      const d = (await adminApi.health()) as { report?: HealthReport };
      const item = d?.report?.items?.find((i) => i.key === 'ans');
      if (!item) {
        setAnsTest({ ok: false, text: '健康自检未返回 ANS 一项（本机自检未完成），无法判定' });
        return;
      }
      const level = isHealthLevel(item.level) ? HEALTH_LEVEL_LABEL[item.level] : String(item.level);
      setAnsTest({ ok: item.level === 'ok', text: `ANS ${level}${item.evidence ? `：${item.evidence}` : ''}` });
    } catch (e) {
      setAnsTest({ ok: false, text: `测试未完成：${(e as Error).message}` });
    } finally {
      setAnsTestBusy(false);
    }
  };

  const handleInstallSample = async () => {
    if (sampleBusy) return;
    setSampleBusy(true); setSampleMsg('载入中…');
    try {
      const r = await sampleApi.install();
      setSampleMsg(r.created ? '示例项目已载入——到「项目」页即可看到。' : '示例项目已存在，未重复载入。');
    } catch (e) { setSampleMsg(`载入失败：${(e as Error).message}`); }
    setSampleBusy(false);
  };

  const handleRemoveSample = async () => {
    if (sampleBusy) return;
    setSampleBusy(true); setSampleMsg('删除中…');
    try {
      const r = await sampleApi.remove();
      setSampleMsg(r.removed ? '示例项目已删除（含落盘产出物）。' : '未找到示例项目，无需删除。');
    } catch (e) { setSampleMsg(`删除失败：${(e as Error).message}`); }
    setSampleBusy(false);
  };

  const handleCheckUpdate = async () => {
    if (!window.electronAPI?.isElectron) { setUpdateMsg('仅桌面端支持'); return; }
    setChecking(true); setUpdateMsg('检查中...');
    try {
      const r = await window.electronAPI.checkForUpdates();
      // 无更新通道时 main 如实返回原因——照实上屏，不写"检查中"了事
      if (r && r.started === false) setUpdateMsg(r.reason || '未配置更新通道');
      else setUpdateMsg('已触发检查，如有新版本会提示');
    } catch (e) { setUpdateMsg((e as Error).message); }
    setChecking(false);
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault(); setPwMsg(''); setPwOk(false);
    try {
      const token = await window.electronAPI?.getToken();
      if (!token) { setPwMsg('未登录'); return; }
      const parts = token.split('.'); const payload = JSON.parse(atob(parts[1]!));
      const result = await invoke<{ success?: boolean; error?: string }>('auth:changePassword', { userId: payload.sub, oldPassword: pwForm.oldPassword, newPassword: pwForm.newPassword }) as { success?: boolean; error?: string };
      if ((result as { success?: boolean }).success) { setPwOk(true); setPwMsg('密码修改成功'); setPwForm({ oldPassword: '', newPassword: '' }); }
      else setPwMsg((result as { error?: string }).error || '修改失败');
    } catch (e) { setPwMsg((e as Error).message); }
  };

  // 云端权益一行的人话（如实分档；词表/档位名由 main 给，此处不自行加档、不自译来源）。
  const cloudText = !cloud
    ? '—'
    : !cloud.configured
      ? '未配置 ANS 凭据（按本地许可运行）'
      : cloud.active
        ? `${cloud.tierLabel ?? cloud.tier}（云端下发）`
        : cloud.fetchedAt
          ? `无生效权益（${cloud.sourceLabel ?? '未签发'}）`
          : '尚未同步';

  // zx_20261107_1 B8: 搜索与「高级设置」派生——分区关键词做卡片级过滤；高级区键全部来自白名单。
  // zx_20261110_1 B5（G17）：只搜分区名会把"用户明明看得见的行"说成不存在——补**行级**索引
  //   （label + description + 键名）：映射表驱动的行由表自身派生，手写行在此列其标题/键名。
  //   命中一行即展开所在节（节本就全展开，这里只决定显隐）。
  const q = settingsQuery.trim().toLowerCase();
  const ROW_KEYWORDS: Record<string, string[]> = {
    deliverable: DELIV_OPTS.map((o) => `${o.label} ${o.desc} deliverable.${o.key}`),
    im: IM_OPTS.map((o) => `${o.label} ${o.desc} im.${o.key}`),
    policy: POLICY_OVERRIDES.map((o) => `${o.key} ${POLICY_NUM_LABELS[o.key]?.label ?? ''} ${POLICY_NUM_LABELS[o.key]?.desc ?? ''}`),
    advanced: ADVANCED_BOOL_KEYS.map((k) => `${k} ${ADVANCED_BOOL_LABELS[k] ?? ''}`),
    'local-owner': ['本机所有者密码 首次登录自动进入'],
    password: ['当前密码 新密码 修改密码'],
    ans: ['ANS 地址 服务地址 API Key 密钥 连接测试'],
    notify: ['免打扰总开关', '关键事态原生系统通知', '免打扰时段', '安静时段内也静音失败/需输入'],
    sound: ['提示音总开关', '按事件类静音 任务完成 任务失败 等待你输入'],
    model: ['模型单价上限 max_cost_per_1k'],
    concurrency: ['机器并发上限'],
    sched: ['关键路径优先'],
    decompose: ['计划自动拆解'],
    shell: ['多段命令逐段校验', '退出时带走后台进程'],
    capability: ['启用能力把关', '严格备用 缺硬需即拒'],
    orchestrate: ['外派策略', '建单即派'],
    license: ['激活码 档位 用量 配额 云端权益 设备指纹 升级'],
  };
  const rowHit = (id: string): boolean => !!q && (ROW_KEYWORDS[id] ?? []).some((t) => t.toLowerCase().includes(q));
  const sectionVisible = (id: string): boolean =>
    !q || (SECTION_KEYWORDS[id] ?? id).toLowerCase().includes(q) || rowHit(id);
  const cardCls = (id: string): string =>
    `bg-white rounded-lg border p-6${sectionVisible(id) ? '' : ' hidden'}`;
  const wrapCls = (id: string): string => (sectionVisible(id) ? '' : 'hidden');
  const advancedHits = ADVANCED_BOOL_KEYS.filter(
    (k) => !q || k.toLowerCase().includes(q) || (ADVANCED_BOOL_LABELS[k] ?? '').toLowerCase().includes(q),
  );
  const advancedVisible = !q || advancedHits.length > 0 || ADVANCED_KEYWORDS.includes(q);
  const advancedList = q && advancedHits.length > 0 ? advancedHits : ADVANCED_BOOL_KEYS;
  const noMatch = !!q && advancedHits.length === 0 && !ADVANCED_KEYWORDS.includes(q)
    && !Object.values(SECTION_KEYWORDS).some((kw) => kw.toLowerCase().includes(q))
    && !Object.values(ROW_KEYWORDS).some((rows) => rows.some((t) => t.toLowerCase().includes(q)));
  const advRow = (key: string) => (
    <div key={key} className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm text-gray-700">{ADVANCED_BOOL_LABELS[key] ?? key}</p>
        <p className="text-[11px] text-gray-400 font-mono">{key}</p>
      </div>
      <Switch on={!!advBool[key]} onToggle={(v) => toggleAdvancedBool(key, v)} />
    </div>
  );

  // zx_20261111_3「显」：第一行——只回答"还差什么才能跑起来"；一切就绪时不摆按钮。
  const settingsNextAction = nextActionForSettings({
    ans: ansStatus == null ? 'unknown' : (ansStatus.configured ? 'configured' : 'unconfigured'),
    ansNote: ansStatus == null ? 'ANS 状态未取得' : null,
    defaultModel: modelReadOk ? defaultModel : null,
  });
  function handleSettingsNextAction(aid: NextActionId): void {
    if (aid === 'open_settings') document.getElementById('settings-ans')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div><h2 className="text-xl font-bold mb-6">设置</h2>
      {/* zx_20261108_1 B5：任一写口失败在此如实上屏（含原因），不再静默吞掉 */}
      <ActionFeedback note={fb.note} onClose={() => fb.setNote(null)} />
      {/* zx_20261111_3「显」：第一行——此刻是什么 / 凭什么 / 下一步点哪个 */}
      <div className="mb-4"><NextActionBar action={settingsNextAction} onAction={handleSettingsNextAction} /></div>
      <div className="space-y-6 max-w-2xl">
        <input
          value={settingsQuery}
          onChange={(e) => setSettingsQuery(e.target.value)}
          placeholder="搜索设置（如：通知 / 模型 / 并发 / 记忆）"
          className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {noMatch && <p className="text-sm text-gray-400">没有匹配的设置项。</p>}
        <div className={wrapCls('local-owner')}>
          <LocalOwnerPasswordCard />
        </div>
        <div className={cardCls('password')}>
          <h3 className="font-semibold mb-4 flex items-center gap-2"><Lock className="w-4 h-4"/>修改密码</h3>
          <form onSubmit={handleChangePassword} className="space-y-3">
            <div><label className="block text-sm font-medium mb-1">当前密码</label><input type="password" value={pwForm.oldPassword} onChange={e => setPwForm({...pwForm,oldPassword:e.target.value})} required className="w-full max-w-xs px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/></div>
            <div><label className="block text-sm font-medium mb-1">新密码</label><input type="password" value={pwForm.newPassword} onChange={e => setPwForm({...pwForm,newPassword:e.target.value})} required className="w-full max-w-xs px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"/></div>
            {pwMsg && <p className={`text-sm ${pwOk?'text-green-600':'text-red-500'}`}>{pwMsg}</p>}
            <button type="submit" className={`flex items-center gap-1 px-4 py-2 rounded-lg text-sm text-white transition-colors ${pwOk?'bg-green-600':'bg-blue-600 hover:bg-blue-700'}`}>{pwOk?<><Check className="w-3.5 h-3.5"/>已修改</>:'修改密码'}</button>
          </form>
        </div>
        {/* ANS 服务配置 */}
        <div className={cardCls('ans')} id="settings-ans">
          <h3 className="font-semibold mb-4 flex items-center gap-2"><Globe className="w-4 h-4"/>ANS 服务配置</h3>
          {!ansLoaded ? <p className="text-sm text-gray-400">加载中...</p> : <div className="space-y-3">
            {/* zx_20261005 M16: 凭据三态如实上屏——未配置是**生产首启的正常态**，须引导而非沉默 */}
            {ansStatus && (ansStatus.configured
              ? null
              : (ansStatus.isDev
                ? <p className="text-xs text-gray-400">开发构建：未配置时使用内置开发凭据（dev-key / dev-secret，仅本机 ANS）。</p>
                : <p className="text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">尚未配置 ANS 凭据，无法连接 ANS 资源服务。请填写下方 API Key 与 Secret Key（发布构建不使用内置开发凭据）。</p>))}
            <div><label className="block text-sm font-medium mb-1">服务地址</label><input value={ansConfig.ans_server_url} onChange={e=>setAnsConfig({...ansConfig,ans_server_url:e.target.value})} className="w-full max-w-md px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder={ansDefaultUrl || 'http://localhost:27183'}/></div>
            <div><label className="block text-sm font-medium mb-1">API Key</label><input value={ansConfig.ans_api_key} onChange={e=>setAnsConfig({...ansConfig,ans_api_key:e.target.value})} placeholder={ansSecretSet.apiKey ? '已配置（留空不修改）' : '未配置'} className="w-full max-w-md px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"/></div>
            <div><label className="block text-sm font-medium mb-1">Secret Key</label><div className="flex items-center gap-2"><input type={showSecret?'text':'password'} value={ansConfig.ans_secret_key} onChange={e=>setAnsConfig({...ansConfig,ans_secret_key:e.target.value})} placeholder={ansSecretSet.secretKey ? '已配置（留空不修改）' : '未配置'} className="w-full max-w-md px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"/><button onClick={()=>setShowSecret(!showSecret)} className="text-xs text-gray-400 hover:text-gray-600">{showSecret?'隐藏':'显示'}</button></div></div>
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={handleSaveAns} className={`flex items-center gap-1 px-4 py-2 rounded-lg text-sm text-white transition-colors ${ansSaved?'bg-green-600':'bg-blue-600 hover:bg-blue-700'}`}>{ansSaved?<><Check className="w-3.5 h-3.5"/>已保存（即时生效）</>:'保存配置'}</button>
              {/* zx_20261112_1 B4「诊」：连得上没有，点一下就有真答案（受保护请求 + 三态 + 依据） */}
              <button onClick={handleTestAns} disabled={ansTestBusy} data-ans-test className="px-4 py-2 rounded-lg text-sm border border-blue-200 text-blue-600 hover:bg-blue-50 disabled:opacity-50">{ansTestBusy?'测试中...':'测试连接'}</button>
              {ansTest && <span data-ans-test-result className={`text-xs ${ansTest.ok?'text-green-600':'text-red-500'}`}>{ansTest.text}</span>}
            </div>
            <p className="text-xs text-gray-400">修改后立即生效，所有 ANS 资源页面将使用新配置重连。</p>
          </div>}
        </div>

        {/* A2 (2026-09-03): 桌面原生通知开关 */}
        <div className={cardCls('notify')}>
          <h3 className="font-semibold mb-4 flex items-center gap-2"><Bell className="w-4 h-4"/>桌面通知</h3>
          {/* zx_20260906 批4 (4c): 全局免打扰总开关——六路(OS横幅/toast/声音/铃点/dock/需处理)降为一路中心记录 */}
          <div className="mb-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">免打扰总开关</p>
              <p className="text-xs text-gray-400 mt-1">开启后不再弹原生横幅 / 应用内 toast / 提示音；事件仍记录到通知中心·铃点·需处理列表（中心记录不丢）。改动即时生效。</p>
            </div>
            <Switch on={dnd} onToggle={toggleDnd} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">关键事态原生系统通知</p>
              <p className="text-xs text-gray-400 mt-1">聚焦窗口时以应用内提示为主（不弹系统横幅）；失焦/最小化时弹系统横幅（归一主通道）。任务失败 / 等待输入即时；完成仅在离开窗口时弹；正在观看该任务不打扰。</p>
            </div>
            <Switch on={sysNotif} onToggle={toggleSysNotif} />
          </div>
          <p className="text-xs text-gray-400 mt-3">仅桌面端生效；开关即时生效，无需重启。</p>
          {/* B1 (2026-09-03_2): 免打扰时段（完成类不弹，仅记录；失败/需输入仍弹） */}
          <div className="mt-4 pt-3 border-t border-gray-100">
            <p className="text-sm font-medium mb-1">免打扰时段</p>
            {/* C1 (2026-09-04_2): 免打扰2.0——运行中即时生效（settings.changed 推送），描述更新 */}
            <p className="text-xs text-gray-400 mb-2">该时段内任务完成不弹原生通知/应用内 toast（仍记录到通知中心）；失败与"需你输入"仍弹（守中）。设置改动即时生效，无需重启。</p>
            <div className="flex items-center gap-2 text-sm">
              <input type="time" value={quietStart} onChange={(e) => setQuietHour('start', e.target.value)} className="px-2 py-1 border rounded text-xs" />
              <span className="text-gray-400">—</span>
              <input type="time" value={quietEnd} onChange={(e) => setQuietHour('end', e.target.value)} className="px-2 py-1 border rounded text-xs" />
              <button type="button" onClick={() => { setQuietHour('start', ''); setQuietHour('end', ''); }} className="text-xs text-gray-400 hover:text-gray-600 px-2">清除（停用）</button>
            </div>
            {/* C1 (2026-09-04_2): 安静时段关键态应用内静音选项（打扰矩阵可选项） */}
            <div className="mt-3 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">安静时段内也静音"失败/需输入"应用内提示</p>
                <p className="text-xs text-gray-400 mt-0.5">原生系统通知仍会弹出（关键事态守中）；仅收敛应用内 toast。勾选后即刻生效。</p>
              </div>
              <Switch on={quietMuteCritical} onToggle={toggleQuietMuteCritical} />
            </div>
          </div>
        </div>

        {/* D2 (2026-09-04_2): 提示音（全局 + 分事件类，运行中即时生效；系统通知/应用内 toast 均受控） */}
        <div className={cardCls('sound')}>
          <h3 className="font-semibold mb-4 flex items-center gap-2"><Bell className="w-4 h-4"/>提示音</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div><p className="text-sm font-medium">提示音总开关</p><p className="text-xs text-gray-400 mt-0.5">关闭后原生系统通知与应用内 toast 均无声（仍会弹出）；改动即时生效。</p></div>
              <Switch on={soundEnabled} onToggle={toggleSoundGlobal} />
            </div>
            <div className="pt-3 border-t border-gray-100 space-y-2">
              <p className="text-xs text-gray-400">按事件类静音（默认全开）：</p>
              {[{ k: 'completed' as const, l: '任务完成' }, { k: 'failed' as const, l: '任务失败' }, { k: 'await' as const, l: '等待你输入' }].map(({ k, l }) => (
                <div key={k} className="flex items-center justify-between gap-4">
                  <p className="text-sm text-gray-600">{l}</p>
                  <Switch on={snd[k]} onToggle={(v) => toggleSoundClass(k, v)} />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* zx_20260909 X2④(道德经·有无相生 / 王阳明·知行合一): 成果展示开关组——deliverable.* 可回退真实可点 */}
        <div className={cardCls('deliverable')}>
          <h3 className="font-semibold mb-1 flex items-center gap-2"><Package className="w-4 h-4"/>成果展示</h3>
          <p className="text-xs text-gray-400 mb-3">控制「主要成果」在交付单 / 产出物列表 / 任务列表 / 就地抽屉中的呈现。renderer 即时生效；primary_auto 等主进程消费键在下一任务收口生效。</p>
          <div className="space-y-3">
            {DELIV_OPTS.map((o) => (
              <div key={o.key} className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">{o.label}{o.mainConsumed && <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span>}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{o.desc}</p>
                </div>
                <Switch on={!!delivOpts[o.key]} onToggle={(v) => toggleDeliv(o.key, v)} />
              </div>
            ))}
          </div>
        </div>

        {/* zx_20260924 M6-c: 模型选型成本上限——此前只有读端无写端（GUI 无处可点，只能 DB 直改） */}
        <div className={cardCls('model')}>
          <h3 className="font-semibold mb-1 flex items-center gap-2"><Cpu className="w-4 h-4"/>模型选型</h3>
          <p className="text-xs text-gray-400 mb-3">向 ANS 申请模型时附带的成本上限；ANS 按「输入+输出单价之和 ≤ 该值」筛模型。主进程消费，下一个任务生效。
            {/* zx_20261013_2 批四（维特根斯坦·语言游戏）:「美元」在「模型单价」与「任务预算」**两场游戏**里指的不是一回事，
                此前同页两处金额各用一词却都叫"成本/费用上限"，用户无从分辨。此处说清是哪一场——**不改币种**：
                ANS 定价基准本就是美元，把显示改人民币而底层仍按美元筛＝名实不符（正是本仓反复点名的病）。 */}
            <br/>币种说明：这里的「美元」是**模型的单位价格**（ANS 定价基准即美元），<span className="text-gray-500">与任务/项目预算的「¥ 人民币」是两回事</span>——这一栏筛的是模型贵不贵，不是本任务能花多少钱。</p>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">模型单价上限（美元 / 1k tokens，按 ANS 定价）<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
              <p className="text-xs text-gray-400 mt-0.5">留空 = 不设上限（所有在册模型都参与匹配）。填 <span className="font-mono">0</span> 不是「不限」而是「只要免费模型」，会把付费模型一次筛没，故按未配置处理；非数字同样按未配置处理。</p>
            </div>
            <input
              type="number" min={0} step="0.001" value={maxCostPer1k} placeholder="未配置"
              onChange={(e) => setMaxCostPer1k(e.target.value)}
              onBlur={(e) => commitMaxCostPer1k(e.target.value)}
              className="w-28 px-2 py-1 border rounded text-sm text-right"
            />
          </div>
        </div>

        {/* zx_20261018_3 批四「度」: 机器级并发上限——此前项目闸只管"一个项目几个"，整机总量无上限 */}
        <div className={cardCls('concurrency')}>
          <h3 className="font-semibold mb-1 flex items-center gap-2"><Cpu className="w-4 h-4"/>机器并发</h3>
          <p className="text-xs text-gray-400 mb-3">整台机器同时能跑几个任务（跨所有项目合计）。到上限时新任务退回队列、指数退避后重试，<span className="text-gray-500">不会被打断正在跑的任务</span>。主进程消费，下一次认领生效。</p>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">机器并发上限<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
              <p className="text-xs text-gray-400 mt-0.5">留空 = 按 CPU 核数派生（核数-1，最低 2、最高 8）。非数字或 ≤0 同样退回派生值。</p>
            </div>
            <input
              type="number" min={1} step="1" value={machineMaxConcurrency} placeholder="按 CPU 派生"
              onChange={(e) => setMachineMaxConcurrency(e.target.value)}
              onBlur={(e) => commitMachineMaxConcurrency(e.target.value)}
              className="w-28 px-2 py-1 border rounded text-sm text-right"
            />
          </div>
        </div>

        {/* zx_20261023_5 批一(孙子·先为不可胜): 调度顺序——同优先级时长依赖链先启动 */}
        <div className={cardCls('sched')}>
          <h3 className="font-semibold mb-1 flex items-center gap-2"><GitBranch className="w-4 h-4"/>调度顺序</h3>
          <p className="text-xs text-gray-400 mb-3">决定"先跑谁"。主进程消费，下一次调度生效。</p>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">关键路径优先<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
              <p className="text-xs text-gray-400 mt-0.5">同优先级时，依赖链更长的任务先启动（长链早动工，整条链更早收尾）。关 ⇒ 回到「优先级 + 创建时间」旧序。</p>
            </div>
            <Switch on={criticalPath} onToggle={toggleCriticalPath} />
          </div>
        </div>

        {/* zx_20261028_2 M4(能拆则拆，不硬拆): 计划自动拆解——引擎"到点即拆"的开关。
            键早已在 `settings-bool.ts` 的白名单里、主进程也在读，缺的只是这一处读写口。 */}
        <div className={cardCls('decompose')}>
          <h3 className="font-semibold mb-1 flex items-center gap-2"><ListTree className="w-4 h-4"/>任务拆解</h3>
          <p className="text-xs text-gray-400 mb-3">计划类任务到点即拆为可执行子任务（模板或 LLM 规划）。主进程消费，下一个任务生效。</p>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">计划自动拆解<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
              <p className="text-xs text-gray-400 mt-0.5">
                关 ⇒ 引擎不再代拆，只有模型主动进入「计划模式」时才拆（逐字回旧行为）。
                修复/排查类任务另有模板守卫跳过套模板拆解，与本开关无关。
              </p>
            </div>
            <Switch on={planAutoDecompose} onToggle={togglePlanAutoDecompose} />
          </div>
        </div>

        {/* zx_20261113_4 B1「成」(道德经·自知者明): 项目业务知识——画像首次自动成型。
            只建「本项目自身事实压缩成的画像」；外来领域包仍永不自动启用。 */}
        <div className={cardCls('knowledge')}>
          <h3 className="font-semibold mb-1 flex items-center gap-2"><BookOpen className="w-4 h-4"/>项目业务知识</h3>
          <p className="text-xs text-gray-400 mb-3">夜间巩固时，从项目已发生的任务、产出物与服务调用里派生出 200 token 的「项目画像」（确定性、零 LLM），新任务执行时自动带上。</p>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">项目画像自动成型<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
              <p className="text-xs text-gray-400 mt-0.5">关 ⇒ 不自动新建，首次仍由你在项目详情里手点生成（一键回退）。已有画像、导入画像与外来领域包都不受影响。</p>
            </div>
            <Switch on={profileAutoBootstrap} onToggle={toggleProfileAutoBootstrap} />
          </div>
        </div>

        {/* zx_20261029_3 M5(维特根斯坦·语言游戏): 多段命令——语法（有分隔符）不等于权限（要 sudo）。
            开关必须有 GUI 读写口，否则"承诺的一键回退"只是白名单里的一行字。 */}
        <div className={cardCls('shell')}>
          <h3 className="font-semibold mb-1 flex items-center gap-2"><Terminal className="w-4 h-4"/>命令执行</h3>
          <p className="text-xs text-gray-400 mb-3">决定智能体执行通用命令时如何读分隔符。主进程消费，下一次工具调用生效。</p>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">多段命令逐段校验<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
              <p className="text-xs text-gray-400 mt-0.5">
                开 ⇒ 允许用「;」「&amp;&amp;」「||」连接多条命令，但每一段都逐段检查（破坏性/系统管理/解释器/非法字符）。
                关 ⇒ 分隔符一律拒绝（逐字回旧行为）。
              </p>
            </div>
            <Switch on={shellMultiSegment} onToggle={toggleShellMultiSegment} />
          </div>
          <div className="flex items-center justify-between gap-4 mt-4 pt-4 border-t border-gray-100">
            <div>
              <p className="text-sm font-medium">退出时带走后台进程<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
              <p className="text-xs text-gray-400 mt-0.5">
                开 ⇒ 退出应用时结束工蚁启动、仍活着的后台进程组（仅限活动页「后台进程」账上的；外部进程不碰）。
                关 ⇒ 退出后让它们继续跑。
              </p>
            </div>
            <Switch on={killBackgroundOnExit} onToggle={toggleKillBackgroundOnExit} />
          </div>
        </div>

        {/* zx_20261012_2 批一(策略可配): 策略引擎——阈值/窗口此前写死在源码，GUI 无处可调（只能 DB 直改） */}
        <div className={cardCls('policy')}>
          <h3 className="font-semibold mb-1 flex items-center gap-2"><Shield className="w-4 h-4"/>策略引擎</h3>
          <p className="text-xs text-gray-400 mb-3">任务「执行前」的策略闸：项目近期失败过多则暂停/通知。主进程消费，下一个任务生效。留空 = 用内置缺省。</p>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">启用策略闸<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
                <p className="text-xs text-gray-400 mt-0.5">关 ⇒ 不读失败数、不评估任何策略（一键回退旧行为）。</p>
              </div>
              <Switch on={policyCheck} onToggle={togglePolicyCheck} />
            </div>
            {POLICY_OVERRIDES.map((o) => {
              const m = POLICY_NUM_LABELS[o.key];
              const min = m?.min ?? 0;
              const max = m?.max ?? 99999;
              return (
                <div key={o.key} className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{m?.label ?? o.key}<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
                    {m?.desc && <p className="text-xs text-gray-400 mt-0.5">{m.desc}</p>}
                  </div>
                  <input
                    type="number" min={min} max={max} value={policyNums[o.key] ?? ''} placeholder="内置缺省"
                    onChange={(e) => setPolicyNums((p) => ({ ...p, [o.key]: e.target.value }))}
                    onBlur={(e) => commitPolicyNum(o.key, e.target.value, min, max)}
                    className="w-28 px-2 py-1 border rounded text-sm text-right"
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* zx_20261013_1 批一(称器于事): 模型能力把关——选型后若最终在用模型缺本任务**硬需**能力，如实拒而非静默降级 */}
        <div className={cardCls('capability')}>
          <h3 className="font-semibold mb-1 flex items-center gap-2"><ShieldCheck className="w-4 h-4"/>模型能力把关</h3>
          <p className="text-xs text-gray-400 mb-3">
            任务「选型定稿」之后、执行之前：若最终在用的模型缺本任务**硬需**能力（vision/chat/function-calling），则**如实拒并写「[选型失败]」**，而不是让装配层省略图片把缺口掩盖过去。软需能力（code/reasoning）缺则允许续跑（如实记账）。主进程消费，下一个任务生效。
          </p>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">启用能力把关<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
              <p className="text-xs text-gray-400 mt-0.5">关 ⇒ 硬需缺也不拦，逐字回「只记不拦」旧行为（一键回退）。</p>
            </div>
            <Switch on={capGate} onToggle={toggleCapGate} />
          </div>
          {/* zx_20261022_3 批六(知行合一): 备用缺硬需的处置——缺省「降级继续但如实告知」，可 opt-in 改为如实拒 */}
          <div className="flex items-center justify-between gap-4 mt-4 pt-4 border-t">
            <div>
              <p className="text-sm font-medium">严格备用（缺硬需即拒）<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
              <p className="text-xs text-gray-400 mt-0.5">
                主模型探活未通过、换到的备用缺本任务硬需能力时：
                关（缺省）⇒ 仍降级继续，但会话里如实写「[降级选型]」并说明这单会怎样降级（并经 IM 通道告知）；
                开 ⇒ 如实拒并写「[选型失败]」，不静默降级。主进程消费，下一个任务生效。
              </p>
            </div>
            <Switch on={strictFallback} onToggle={toggleStrictFallback} />
          </div>
        </div>

        {/* zx_20261011_4 M4: 多机协同**编排模式**——把本机跑不过来的就绪子任务外派给网络里的他机 */}
        <div className={cardCls('orchestrate')}>
          <h3 className="font-semibold mb-1 flex items-center gap-2"><GitBranch className="w-4 h-4"/>多机协同编排</h3>
          <p className="text-xs text-gray-400 mb-3">缺省关闭（不变更既有行为）。开启后，当本机该项目并发位已占满且仍有就绪子任务时，把溢出的（每拍至多 3 件）外派给协同网络里的他机执行；结果回传后本机如实收口并继续推进依赖链。仅在本机已入网且 Team 档已解锁时生效。</p>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">外派策略<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
              <p className="text-xs text-gray-400 mt-0.5">「跑得过来就不外派」——本机空闲时一律在本机跑。</p>
            </div>
            <select value={orchMode} onChange={(e) => commitOrchMode(e.target.value)} className="px-2 py-1 border rounded text-sm">
              {(orchModes.length ? orchModes : ['off', 'auto']).map((m) => (<option key={m} value={m}>{ORCH_LABEL[m] ?? m}</option>))}
            </select>
          </div>
          {/* zx_20261017_1 批三: 建单即派——新建任务那一刻就交给擅长这类活的对端。
              zx_20261029_2 M7：三态（显式开 / 显式关 / Team+入网时缺省开），缺省开**只在满负荷时溢出**。 */}
          <div className="flex items-center justify-between gap-4 mt-4 pt-4 border-t">
            <div>
              <p className="text-sm font-medium">建单即派<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
              <p className="text-xs text-gray-400 mt-0.5">
                团队版已解锁且本机已入网时<strong>默认开启</strong>，但只在<strong>本机满负荷</strong>时溢出——本机跑得动就先在本机跑；
                手动开启则不受余力限制，符合条件就派。可外派指：无父任务 / 无依赖 / 无附件 / 项目无本机工作目录 /
                未触发模板拆解 / 形态可路由；派发失败<strong>不阻断建单</strong>，任务留在本机。仅对开启之后新建的任务生效。
              </p>
              {autoPolicy && (
                <p className="text-xs text-gray-500 mt-1">当前策略：{autoDispatch ? '已开启' : '未开启'}——{autoPolicy.reason}。</p>
              )}
            </div>
            <Switch on={autoDispatch} onToggle={toggleAutoDispatch} />
          </div>
        </div>

        {/* zx_20260909_1 补⑤(§十三): IM 通知开关组——im.notify_to_creator/notify_pause_needed/outbox_retry_min 可回退真实可点 */}
        <div className={cardCls('im')}>
          <h3 className="font-semibold mb-1 flex items-center gap-2"><Bell className="w-4 h-4"/>IM 通知</h3>
          <p className="text-xs text-gray-400 mb-3">控制任务关键通知（完成 / 失败 / 需人工介入暂停）经 IM 渠道投递给创建人的行为。主进程消费，下一次通知（或下一轮补发扫描）生效。</p>
          <div className="space-y-3">
            {IM_OPTS.map((o) => (
              <div key={o.key} className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">{o.label}<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
                  <p className="text-xs text-gray-400 mt-0.5">{o.desc}</p>
                </div>
                <Switch on={!!imOpts[o.key]} onToggle={(v) => toggleIm(o.key, v)} />
              </div>
            ))}
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">出站失败补发窗口（分钟）<span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 align-middle">主进程</span></p>
                <p className="text-xs text-gray-400 mt-0.5">关键通知发送失败时落账，按 1/2/4 分钟退避重发（至多 3 次）；自落账起超过该窗口仍未达则放弃。0=关闭补发。留空/非法按 0 处理。</p>
              </div>
              <input
                type="number" min={0} max={1440} value={outboxRetryMin}
                onChange={(e) => setOutboxRetryMin(e.target.value)}
                onBlur={(e) => commitOutboxMinutes(e.target.value)}
                className="w-20 px-2 py-1 border rounded text-sm text-right"
              />
            </div>
          </div>
        </div>

        <div className={cardCls('license')}><h3 className="font-semibold mb-4 flex items-center gap-2"><Package className="w-4 h-4"/>许可与激活</h3>
          <div className="space-y-2 text-sm">
            {/* zx_20261027_3 M3「试得真」：试用给的就是团队版能力——档位行直说"团队版能力（剩 N 天）"，
                与 `license.ts` 的 `tier:'team'` 及价目表 `trial.grantsTier` 同一事实。 */}
            <div className="flex justify-between"><span className="text-gray-500">当前档位</span><span className="font-medium">{lic?.kind === 'trial' && lic.trialDaysLeft != null ? `${lic.tierLabel ?? '团队版'}能力（剩 ${lic.trialDaysLeft} 天）` : (lic?.tierLabel ?? '—')}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">状态</span><span className="text-gray-600 text-right">{lic?.detail ?? '—'}</span></div>
            {/* zx_20261017_1 批五: 席位用量与用户页同源（`license:status.seats`）。
                zx_20261023_1「称」: 席位只数**本机**登录账号、跨机不可聚合 ⇒ 界面如实称「本机账号」，
                不再以「成员席位」暗示跨机团队容量（跨机容量见下方协同节点行）。 */}
            <div className="flex justify-between"><span className="text-gray-500">本机账号</span><span className="font-medium">{seatText(lic?.seats)}</span></div>
            {/* zx_20261018_3 D12（组6 实机反馈）: 到期一行**恒在场**。此前仅在 `expiresAt` 非空时渲染，
                而永久许可的载荷就是 `expiresAt: null` ⇒ 已激活用户看不到这一行，无从判断"是永久还是漏显"。
                现按许可形态如实分档：永久许可写明"永久"，试用写明剩余天数，未激活写"不适用"。
                D14（组6 二次实机反馈）: 载荷里的 `expiresAt` 是 ISO（带 `Z` 或 `+08:00` 偏移），
                直接印出来不是给人读的——按全站同一把尺（`formatDbTime`）转本地时区、分钟精度；
                解析不出时原样回退（不把"看不懂"伪造成空白）。 */}
            <div className="flex justify-between"><span className="text-gray-500">到期</span><span className="text-right">{
              !lic ? '—'
                : lic.kind === 'licensed'
                  ? (lic.expiresAt ? (formatDbTime(lic.expiresAt) || lic.expiresAt) : '永久（许可未设到期时间）')
                  : lic.kind === 'trial'
                    ? (lic.trialDaysLeft != null ? `试用期内（剩 ${lic.trialDaysLeft} 天）` : '试用期内')
                    : '不适用（未激活）'
            }</span></div>
            {/* zx_20261023_5 批五: 云端权益——**只升不降**并入当前档位（合并只在 main 一处）。
                此处如实显示：已同步档位 / 无生效权益（未签发·已过期）/ 不可达原因；可手动重拉（5s 有界）。 */}
            <div className="flex justify-between items-start gap-2">
              <span className="text-gray-500 shrink-0">云端权益</span>
              <span className="text-right">
                <span className={cloud?.lastError ? 'text-orange-500' : 'text-gray-600'}>{cloudText}</span>
                <button
                  onClick={() => void refreshCloudEntitlement()}
                  disabled={cloudBusy}
                  className="ml-2 text-blue-600 hover:underline disabled:text-gray-400 disabled:no-underline"
                >{cloudBusy ? '同步中…' : '重新同步'}</button>
              </span>
            </div>
            {cloud?.lastError && (
              <p className="text-xs text-orange-500 text-right">{cloud.lastError}</p>
            )}
            {cloud?.fetchedAt && (
              <p className="text-xs text-gray-400 text-right">
                最近同步 {formatDbTime(cloud.fetchedAt) || cloud.fetchedAt}
                {cloud.expiresAt ? ` · 云端到期 ${formatDbTime(cloud.expiresAt) || cloud.expiresAt}` : ''}
              </p>
            )}
            {cloudMsg && <p className="text-xs text-gray-500 text-right">{cloudMsg}</p>}
            <div className="flex justify-between items-center gap-2">
              <span className="text-gray-500">本机指纹</span>
              <span className="font-mono text-xs flex items-center gap-2">
                {lic?.fingerprint ?? '—'}
                {lic?.fingerprint && (
                  <button
                    onClick={() => { navigator.clipboard?.writeText(lic.fingerprint).then(() => setLicMsg('已复制本机指纹')).catch(() => {}); }}
                    className="text-blue-600 hover:underline"
                  >复制</button>
                )}
              </span>
            </div>
            {/* zx_20261024_1：绑定上限按档位显示（个人档 3、团队授权包 20，由 main `licenseDeviceCap` 派生）。 */}
            <p className="text-xs text-gray-400">购买/续期时把「本机指纹」发给签发方（每台机器一个{lic?.deviceCap != null ? `，当前档位一份许可最多绑 ${lic.deviceCap} 台` : ''}）。</p>
            {/* zx_20261030_3「常」：指纹只取本机硬件标识——换网络/改机器名不再改变它（此前把主机名与网卡 MAC 也掺进了哈希）。 */}
            <p className="text-xs text-gray-400/80">指纹取自本机硬件标识，换网络、改机器名不会变；仅在本机读不到硬件标识时才退回合成指纹。</p>
            <div className="flex justify-between"><span className="text-gray-500">购买 / 升级</span>
              {pricing?.purchaseUrl
                ? <a href={pricing.purchaseUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">前往购买</a>
                : <span className="text-gray-400">购买渠道筹备中（入口即将开放）</span>}
            </div>

            {/* zx_20261022_3 批九: 当前用量——项目/本机账号条 + 并发与节点。数字全来自 main
                `core/tier-usage.ts`（复用既有计数），本页不重算；节点读不到如实标「不可用」。
                zx_20261023_1「称」: 本机账号取代「成员席位」的措辞；节点行补**已注册/上限**——
                价目表所称的节点上限与这里看到的是同一把尺。 */}
            {usage && (
              <div className="pt-3 border-t mt-3 space-y-2">
                <p className="text-xs text-gray-400">当前用量</p>
                <UsageBar label="项目" used={usage.projects.used} limit={usage.projects.limit} />
                <UsageBar label="本机账号" used={usage.seats.used} limit={usage.seats.limit} />
                {/* zx_20261101_1 M4「授」: 容量维度与动作面同一把尺——`limit===0` 显示「不限」，
                    数字全来自 main `core/tier-usage.ts`（本页不重算）。知识卡按**项目**判容量，故取单项目最大张数。 */}
                <UsageBar label="设备登记" used={usage.devices.used} limit={usage.devices.limit} />
                <UsageBar label="外部终端" used={usage.externalTerminals.used} limit={usage.externalTerminals.limit} />
                <UsageBar label="A2A 服务" used={usage.a2aServers.used} limit={usage.a2aServers.limit} />
                <UsageBar label="IM 渠道" used={usage.imChannels.used} limit={usage.imChannels.limit} />
                <UsageBar label="任务模板" used={usage.taskTemplates.used} limit={usage.taskTemplates.limit} />
                {/* zx_20261101_2 M6「衡」：设备云账号是第八维；社区档那格的 0 是「不可接入」不是「不限」，
                    故 `minTierLabel` 非空时如实写「需专业版」（口径同 main 的 `capacityDisplay`）。 */}
                {usage.cloudAccounts.minTierLabel
                  ? <div className="flex justify-between text-xs"><span className="text-gray-500">设备云账号</span><span className="text-gray-500">需{usage.cloudAccounts.minTierLabel}</span></div>
                  : <UsageBar label="设备云账号" used={usage.cloudAccounts.used} limit={usage.cloudAccounts.limit} />}
                <UsageBar label="每项目知识卡（单项目最多）" used={usage.knowledgeCards.maxInProject} limit={usage.knowledgeCards.limit} />
                <UsageBar label="团队共享记忆" used={usage.teamLibraryMemories.used} limit={usage.teamLibraryMemories.limit} />
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">并发上限</span>
                  <span className="text-gray-700">单项目 {usage.concurrency.perProjectMax} · 整机 {usage.concurrency.machineLimit}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">协同节点</span>
                  <span className={usage.nodes.unavailable ? 'text-orange-500' : 'text-gray-700'}>
                    {usage.nodes.unavailable
                      ? `不可用（${usage.nodes.error || '台账读取失败'}）`
                      : `已注册 ${usage.nodes.registered}/${usage.nodes.limit === 0 ? '不限' : usage.nodes.limit} 台 · ${usage.nodes.online} 在线 · ${usage.nodes.participating} 参与`}
                  </span>
                </div>
                {(usage.upgrade.toLabel && (usage.upgrade.quotas.length + usage.upgrade.capabilities.length) > 0) && (
                  <p className="text-xs text-gray-500">
                    升级{usage.upgrade.toLabel}可获得：
                    {[...usage.upgrade.quotas, ...usage.upgrade.capabilities].join(' · ')}
                  </p>
                )}
              </div>
            )}

            {/* zx_20261005 M11: 定价与权益——**真源 main `core/pricing.ts`**（价与能力上限同一把尺）。 */}
            {pricing && (
              <div className="pt-3 border-t mt-3">
                <p className="text-xs text-gray-400 mb-2">定价与权益</p>
                <div className="space-y-2">
                  {pricing.tiers.map((t) => {
                    const isCurrent = (lic?.tier ?? 'community') === t.tier;
                    const basePrice = t.priceMonthlyCny === 0 ? '免费' : t.priceYearlyCny > 0 ? `¥${t.priceMonthlyCny}/月 · ¥${t.priceYearlyCny}/年` : `¥${t.priceMonthlyCny}/月`;
                    const price = t.priceNote ? `${basePrice}（${t.priceNote}）` : basePrice;
                    return (
                      <div key={t.tier} className={`rounded-lg border px-3 py-2 ${isCurrent ? 'border-blue-300 bg-blue-50' : ''}`}>
                        <div className="flex justify-between items-center">
                          <span className="text-sm font-medium">{t.label}{isCurrent && <span className="ml-1 text-[10px] text-blue-600">当前</span>}</span>
                          <span className="text-sm text-gray-700">{price}</span>
                        </div>
                        <p className="text-[11px] text-gray-500 mt-0.5">能力上限：{t.capability}</p>
                        {/* zx_20261101_2 M6「衡」：容量八维与 IM 授权台不再只藏在能力表——付费卡上一眼看得到。 */}
                        <p className="text-[11px] text-gray-500">容量上限：{t.capacity}</p>
                        <p className="text-[11px] text-gray-400">{t.benefits.join(' · ')}</p>
                      </div>
                    );
                  })}
                  <div className="rounded-lg border px-3 py-2">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-medium">{pricing.earlyBird.label}<span className="ml-1 text-[10px] text-amber-600">限 {pricing.earlyBird.seats} 名</span></span>
                      <span className="text-sm text-gray-700">¥{pricing.earlyBird.priceCny} 一次性</span>
                    </div>
                    <p className="text-[11px] text-gray-400">{pricing.earlyBird.note}</p>
                  </div>
                </div>
              </div>
            )}

            {/* zx_20261018_2 批五: 档位 × 能力对照——一行一能力。`included` 由 main 侧
                与真实软闸同一判据派生；本页只上屏，不自行判断档位（否则第二把尺必漂）。 */}
            {catalog && catalog.tiers.length > 0 && (
              <div className="pt-3 border-t mt-3">
                <p className="text-xs text-gray-400 mb-2">档位与能力对照</p>
                <div className="overflow-x-auto">
                  <table className="text-[11px] w-full">
                    <thead>
                      <tr className="text-gray-400">
                        <th className="text-left font-normal pb-1">能力</th>
                        {catalog.tiers.map((t) => (
                          <th key={t.tier} className="text-center font-normal pb-1 whitespace-nowrap px-2">{t.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {catalog.tiers[0].capabilities.map((cap) => (
                        <tr key={cap.key} className="border-t border-gray-100">
                          <td className="py-1 text-gray-600">{cap.label}</td>
                          {catalog.tiers.map((t) => {
                            const cell = t.capabilities.find((c) => c.key === cap.key);
                            return (
                              <td key={t.tier} className="py-1 text-center whitespace-nowrap px-2">
                                {cell?.included
                                  ? <span className="text-green-600">已含</span>
                                  : <span className="text-gray-400">升级到{cell?.upgradeLabel ?? '付费档'}启用</span>}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                      {/* zx_20261030_1 M5「限」：容量维度对照（`capacity` 由 main 的 `TIER_LIMITS` 派生，本页只上屏）。 */}
                      <tr className="border-t border-gray-100">
                        <td className="py-1 text-gray-600">容量上限</td>
                        {catalog.tiers.map((t) => (
                          <td key={t.tier} className="py-1 text-center text-gray-500 px-2">{t.capacity}</td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-gray-400 mt-1">试用期 {catalog.trial.days} 天：{catalog.trial.grantsLabel}能力（并发 {catalog.tiers.find((t) => t.tier === catalog.trial.grantsTier)?.maxProjectConcurrency ?? '—'} / 协同节点 {catalog.tiers.find((t) => t.tier === catalog.trial.grantsTier)?.maxNodes ?? '—'} / 本机账号 {catalog.tiers.find((t) => t.tier === catalog.trial.grantsTier)?.maxMembers ?? '—'}）。</p>
              </div>
            )}
            <div className="pt-3 border-t mt-3">
              <textarea
                value={licInput}
                onChange={(e) => setLicInput(e.target.value)}
                rows={3}
                placeholder="粘贴许可文本（WA-LICENSE-v1.…）"
                className="w-full px-2 py-1 border rounded text-xs font-mono"
              />
              <div className="flex items-center gap-2 mt-2">
                <button onClick={handleActivateLicense} disabled={licBusy} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">{licBusy ? '激活中…' : '激活'}</button>
                {licMsg && <span className="text-xs text-gray-500">{licMsg}</span>}
              </div>
            </div>
          </div>
        </div>
        <div className={cardCls('sample')}><h3 className="font-semibold mb-4 flex items-center gap-2"><Package className="w-4 h-4"/>示例项目</h3>
          <p className="text-sm text-gray-500 mb-3">一键载入一份示例（项目 / 任务 / 产出物 / 记忆），用于快速了解工蚁。示例带「示例」徽标，与你的真实数据隔离，可随时一键删除。</p>
          <div className="flex items-center gap-2">
            <button onClick={handleInstallSample} disabled={sampleBusy} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">载入示例项目</button>
            <button onClick={handleRemoveSample} disabled={sampleBusy} className="px-3 py-1.5 border border-red-200 text-red-600 rounded text-sm hover:bg-red-50 disabled:opacity-50">删除示例项目</button>
          </div>
          {sampleMsg && <p className="text-xs text-gray-500 mt-2">{sampleMsg}</p>}
        </div>
        <div className={cardCls('sysinfo')}><h3 className="font-semibold mb-4 flex items-center gap-2"><Monitor className="w-4 h-4"/>系统信息</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-gray-500">应用版本</span><span className="font-mono">{appVersion || '—'}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">架构模式</span><span className="text-blue-600 font-medium">单进程 Electron + IPC</span></div>
            <div className="flex justify-between"><span className="text-gray-500">前端框架</span><span>Vite 6 + React 19 + Tailwind CSS v4</span></div>
            <div className="flex justify-between"><span className="text-gray-500">数据库</span><span>better-sqlite3 (WAL)</span></div>
            <div className="flex justify-between"><span className="text-gray-500">平台</span><span className="font-mono">{window.electronAPI?.platform||'browser'}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">开源许可</span><a href="https://github.com/Reamy/worker-ant" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">AGPL-3.0-only</a></div>
          </div>
        </div>
        <div className={cardCls('update')}><h3 className="font-semibold mb-4 flex items-center gap-2"><RefreshCw className="w-4 h-4"/>自动更新</h3>
          <button onClick={handleCheckUpdate} disabled={checking} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"><RefreshCw className={`w-4 h-4 ${checking?'animate-spin':''}`}/>{checking?'检查中...':'检查更新'}</button>
          {updateMsg && <p className="text-sm text-gray-500 mt-2">{updateMsg}</p>}
        </div>
        <div className={cardCls('stack')}><h3 className="font-semibold mb-4 flex items-center gap-2"><Cpu className="w-4 h-4"/>技术栈</h3>
          <div className="flex flex-wrap gap-2">{['TypeScript','Electron 33','React 19','Vite 6','Tailwind CSS v4','better-sqlite3','Vercel AI SDK v4','JWT (jose)','bcrypt','node-cron'].map(t=>(<span key={t} className="px-2 py-1 bg-gray-100 rounded text-xs font-mono text-gray-600">{t}</span>))}</div>
        </div>

        {/* zx_20261107_1 B8「实·通·信」：高级设置——白名单里没有专属开关的布尔键全在这里。
            键由 main `BOOL_SETTING_KEYS` 派生（不手抄第二张名单），每项有键名与中文名；写口与上面各开关同一口径。 */}
        {advancedVisible && (
          <div className="bg-white rounded-lg border p-6">
            <h3 className="font-semibold mb-1 flex items-center gap-2"><ListTree className="w-4 h-4"/>高级设置</h3>
            <p className="text-xs text-gray-400 mb-3">其余布尔开关——都有实际引擎行为，只是平时不常改。键名与主进程白名单 <span className="font-mono">BOOL_SETTING_KEYS</span> 同一来源：新增键会自动出现在这里，不会再「注册了却点不到」。</p>
            {q ? (
              <div className="space-y-3">{advancedList.map(advRow)}</div>
            ) : (
              <details className="mt-1">
                <summary className="text-sm text-blue-600 cursor-pointer select-none">展开高级开关（{ADVANCED_BOOL_KEYS.length} 项）</summary>
                <div className="mt-3 space-y-4">
                  {ADVANCED_GROUPS.filter((g) => ADVANCED_BOOL_KEYS.some((k) => advancedGroupOf(k) === g.label)).map((g) => (
                    <div key={g.label}>
                      <p className="text-xs font-medium text-gray-500 mb-2">{g.label}</p>
                      <div className="space-y-3">
                        {ADVANCED_BOOL_KEYS.filter((k) => advancedGroupOf(k) === g.label).map(advRow)}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </div>
    </div>);
}
