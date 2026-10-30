/**
 * 任务原型分类 —— 从原工蚁后端 task-complexity.ts 移植。
 * 6种任务原型，每类有独立的步数/预算/温度/优先工具策略。
 */
import { createLogger } from './logger.js';
import { toolRegistry, type ToolCategory } from './tool-registry.js';

const logger = createLogger('archetype');

/** 6种任务原型 */
export type TaskArchetype =
  | 'code'           // 编码实现：写代码、改bug、重构
  | 'research'       // 调查研究：分析代码库、技术调研
  | 'document'       // 文档生成：报告、方案文档
  | 'analysis'       // 数据分析：数据统计、趋势分析
  | 'configuration'  // 配置管理：环境搭建、依赖配置
  | 'conversation';  // 对话交互：问答、讨论、建议

/**
 * 每类原型的默认 Token 预算（项目 context_json.budget 可覆盖）—— Phase E (2026-08-28 zx_3) 依据实测 token 分布校准。
 *
 * zx_20260910_6 M1（为道日损）：原同块并列的 `cost` 字段（¥0.15–1.80）已**删除**。
 * 它没有任何校准依据（同块注释只覆盖 tokens），却自 zx_20260910_5 起被当作「费用上限」真的生效，
 * 在实盘第一天就把真实任务按 token 预算的约 7% 处硬掐死（真库事故见 PLAN_zx_20260910_6 §0.1）。
 * 金额上限必须**有人显式许下**才存在（项目/任务设置），系统不替用户凭空定一个数充当上限。
 * 无许诺者 ⇒ 无金额闸，仅 Token 闸生效（如实告知，见 agent-executor `resolveCostBudget`）。
 */
export const ARCHETYPE_BUDGETS: Record<TaskArchetype, { tokens: number }> = {
  code:           { tokens: 4_000_000 },
  research:       { tokens: 1_200_000 },
  document:       { tokens: 1_000_000 },
  analysis:       { tokens: 2_000_000 },
  configuration:  { tokens: 3_000_000 },
  conversation:   { tokens: 100_000 },
};

/** 自适应策略配置 */
export interface AdaptiveStrategy {
  modelStrategy: 'capability-best' | 'cost-optimal' | 'balanced';
  maxSteps: number;
  temperature: number;
  priorityTools: string[];
  label: string;
}

/** 6种原型的自适应策略（步数/温度/优先工具） */
export const ADAPTIVE_STRATEGIES: Record<TaskArchetype, AdaptiveStrategy> = {
  code: {
    modelStrategy: 'capability-best',
    maxSteps: 40,
    temperature: 0.3,
    priorityTools: ['write_file', 'read_file', 'execute_command', 'register_deliverable'],
    label: '编码实现',
  },
  research: {
    modelStrategy: 'cost-optimal',
    maxSteps: 20,
    temperature: 0.5,
    priorityTools: ['search_web', 'read_file', 'search_content', 'list_files'],
    label: '调查研究',
  },
  document: {
    modelStrategy: 'balanced',
    maxSteps: 20,
    temperature: 0.7,
    priorityTools: ['write_file', 'register_deliverable', 'read_file'],
    label: '文档生成',
  },
  analysis: {
    modelStrategy: 'capability-best',
    maxSteps: 18,
    temperature: 0.3,
    priorityTools: ['read_file', 'search_web', 'execute_command', 'register_deliverable'],
    label: '数据分析',
  },
  configuration: {
    modelStrategy: 'balanced',
    maxSteps: 20,
    temperature: 0.2,
    priorityTools: ['execute_command', 'read_file', 'write_file', 'register_deliverable'],
    label: '配置管理',
  },
  conversation: {
    modelStrategy: 'cost-optimal',
    maxSteps: 10,
    temperature: 0.7,
    priorityTools: ['finalize_task'],
    label: '对话交互',
  },
};

// ==================== 按需收窄：工具面按形态分档（zx_20260920_1 M2） ====================
//
// 病根（§1.1 D1）：57 件工具的 schema（实测 16683 chars ≈ 4.2K token）**每一步都全量重发**，
// 而形态只写进一句提示词——**只写进提示词、不过滤**。
//
// 本表是**唯一真源**：只写"哪几类"，**不逐工具手抄**（成员由 `toolRegistry` 的类目算出）。
// ⚠ 为何手写类目、而非"从 `priorityTools` 的类目推导"：`priorityTools` 是**倾斜提示**，不是
//   **能力需求清单**，两者不能互推。反例是实测的——`research` 的种子无一个写类目，而
//   `classifyArchetypeKeyword` 把「优化方案/排期方案 + 写入 .md」判为 `research`（见下 `:176-180`）：
//   按种子推导，**规划类任务将拿不到 `write_file`，一份方案都写不出来**。
//
// 底线（M-B 反向可达性，**由构造保证**）：`readonly`（读是任何形态的底线）、`control`
//   （出口不可收窄）、`resource`（找模型 / 找 MCP / 调技能 / 联网 / 派生协作——**「会不会用工具」
//   这件事本身**）与 `device`（发现 / 读态 / 控制局域网设备——**用户嘴里那句"把灯打开"**）
//   六档全含 ⇒ 每档必含 `read_file`、`finalize_task`、resource 类十件与设备三件。
//
// ⚠ zx_20260930 M10 变更：`resource` 原本**不在**六档全含之列（`document`/`conversation` 两档没有）。
//   当时的后果不是"少省一点 token"，而是**结构性落空**：用户明确要求"用那个技能 / 查一下模型 /
//   联网搜一下"时，这两档的模型**连表达这个意图的工具都拿不到**——它看不见自己有什么可用的。
//   放开后 `resource` 与 `readonly`/`control` 并列成为**第三类底线**；上一句据此改写
//   （注释必须与构造同真：表动了而注释不动，注释就是假的）。
//
// ⚠ zx_20261014_2 变更（`device` 升**第四类底线**）：`device` 原只给 `code`/`configuration` 两档
//   （zx_20261004 M8 的假设："配得上/AI 终端"场景正落这两档，其余档不给，免把控制面铺开）。
//   **实机 E2E 证伪**：任务「打开客厅台灯」是一句**短祈使句** ⇒ 长度兜底判为 `conversation` ⇒
//   设备三件被 `narrowToolFace`/`delete toolMap[k]` 从模型眼前删掉，模型自述"我本轮可用的 31 个工具…
//   这两个工具在当前执行环境中不存在"，只能诚实拒做（同一把尺：`resource` 的教训在此**复发**）。
//   "哪个形态会用到设备"不是读码想出来的——**由构造给足四类底线**，收窄仍管"要不要 shell/write/memory/media"。
export const ARCHETYPE_TOOL_CATEGORIES: Record<TaskArchetype, ToolCategory[]> = {
  // 保守宽松（方案 §4-M2 边界）：编码/配置天然跨面，宁可少省 token，不让最常用形态缺工具。
  //   ⚠ zx_20261014_2：`device` 已升**底线**（六档全含），此行不再表示"此档特有"。
  code: ['readonly', 'write', 'shell', 'control', 'memory', 'resource', 'media', 'device'],
  configuration: ['readonly', 'write', 'shell', 'control', 'memory', 'resource', 'media', 'device'],
  // 分析：留 shell（要跑统计命令）与 resource（种子点名 `search_web`），减 memory（分析中间态不入项目记忆）。
  //   ⚠ 首版此表**漏了 `resource`**，被 rr 的「种子 ⊆ 档内」判据当场抓住——`analysis` 的种子含 `search_web`，
  //     漏掉它就等于**提示词推荐了一个调不到的工具**。判据抓的是我自己的表错，如实记在方案 §4-M2。
  analysis: ['readonly', 'write', 'shell', 'control', 'resource', 'media', 'device'],
  // 调研：留 resource（搜索是本职），减 shell 与 memory。
  research: ['readonly', 'write', 'control', 'resource', 'media', 'device'],
  // 文档：留 memory（写文档要翻项目记忆）与 resource（zx_20260930 M10 放开：写文档也要查资料、
  //   调技能、联网核对），减 shell（不跑命令）。
  document: ['readonly', 'write', 'control', 'memory', 'resource', 'media', 'device'],
  // 对话：**全档最窄**——只有读、资源、设备与收口。**唯一不含 `media` 的档**：
  //   对话任务的图/PDF 素材都由 M2 的开局自动内联（`buildAttachmentParts`）带走，无需模型中途自己读盘。
  //   zx_20260930 M10：`resource` 是后加的（原为"只有读与收口"）——IM 里那句"查一下 / 用那个技能 /
  //   帮我搜搜"在本档此前**够不着任何一件工具**。
  //   zx_20261014_2：`device` 同为后加（原"设备三件只给 code/configuration"）——实机那句"把客厅台灯
  //   打开"落的本档，此前连 `list_devices` 都看不见（详见上方底线条 zx_20261014_2 注）。
  conversation: ['readonly', 'control', 'resource', 'device'],
};

/** 本档可用工具名（**派生**：由类目过滤在册工具，序 = `TOOL_METAS` 序，稳定可比） */
export function availableToolNames(archetype: TaskArchetype): string[] {
  const cats = new Set(ARCHETYPE_TOOL_CATEGORIES[archetype]);
  return toolRegistry.listNames().filter((n) => cats.has(toolRegistry.getMeta(n)!.category));
}

/**
 * 收窄工具面：返回该保留/该移除的工具名（**纯函数**，不 mutate 入参——供受控回归直跑真实现）。
 * 仅对入参里**实际存在**的键作出判断；档内但不在入参里的名字不算"保留"。
 */
export function narrowToolFace(
  archetype: TaskArchetype,
  tools: Record<string, unknown>,
  opts?: { allowTools?: readonly string[] },
): { kept: string[]; removed: string[]; outside: string[]; restored: string[] } {
  const available = new Set(availableToolNames(archetype));
  const names = Object.keys(tools);
  // zx_20261023_2 批一：**显式 allow-list 压过形态猜**。子代理的白名单此前在形态删完之后才生效，
  //   而 `document`/`research`/`conversation` 的类别表里没有 `shell` ⇒ verifier 的 `execute_command`
  //   还没轮到自己那一步就被删了。这里把 allow 里**实际存在**的工具并入可用面，并如实回传 `restored`
  //   （"哪些是被显式允许救回来的"——否则日志里看不出这条修有没有接上）。
  //   ⚠ deny 仍在其后照常覆盖（装配点顺序不变），显式禁止永远赢过显式允许。
  const restored = (opts?.allowTools ?? []).filter((n) => n in tools && !available.has(n));
  for (const n of restored) available.add(n);
  return {
    kept: names.filter((n) => available.has(n)),
    removed: names.filter((n) => !available.has(n)),
    outside: [...available].filter((n) => !(n in tools)),
    restored: [...restored],
  };
}

/**
 * 子代理作用域收窄（zx_20261030_2 M2）：在形态收窄结果之上再落 allow/deny **两刀**。
 *
 * 病根（真标本 792d6adb）：旧装配点是「先删形态档外 → 推工具面说明书 → 再删 allow/deny」，
 *   说明书说 63 件、模型实际拿到 8 件。本函数把两刀收成**纯计算**，让调用方按同一结果
 *   删 key、写说明书——「说什么」与「给什么」从此同源。
 *
 * 优先级（与旧装配点逐字一致）：**deny 永远赢过 allow**；allow 存在时，不在名单内的一律移出。
 * `removedByAllow`/`removedByDeny` 供日志与断言分辨「被谁删的」。
 */
export function applySubagentToolScope(
  face: { kept: readonly string[]; removed: readonly string[] },
  opts: { allowTools?: readonly string[]; denyTools?: readonly string[] },
): { kept: string[]; removed: string[]; removedByAllow: string[]; removedByDeny: string[] } {
  const allow = opts.allowTools ? new Set(opts.allowTools) : null;
  const deny = new Set(opts.denyTools ?? []);
  const kept: string[] = [];
  const removed = [...face.removed];
  const removedByAllow: string[] = [];
  const removedByDeny: string[] = [];
  for (const k of face.kept) {
    if (deny.has(k)) { removedByDeny.push(k); removed.push(k); continue; }
    if (allow && !allow.has(k)) { removedByAllow.push(k); removed.push(k); continue; }
    kept.push(k);
  }
  return { kept, removed, removedByAllow, removedByDeny };
}

/**
 * 如实告知（正向·开工即知）：本档可用哪些工具。
 * 本档**零收窄**时不列名——此时没有"档外"可告知，列名纯属噪音（且白花 token）。
 */
export function buildToolFaceBrief(
  archetype: TaskArchetype,
  label: string,
  available: string[],
  removedCount: number,
): string {
  if (removedCount <= 0) {
    return `[工具面·${label}] 本形态未收窄工具面，共 ${available.length} 个可用工具。`;
  }
  return `[工具面·${label}] 本形态**只注入**本档 ${available.length} 个工具：${available.join(', ')}。`
    + `其余 ${removedCount} 个工具在本形态下**不可用**（详见其 schema 不在本轮工具表内）；`
    + `若你认为确需其中某个能力，请说明用途并改用手头工具达成，不要虚构工具名。`;
}

/**
 * 如实告知（反向·档外调用）：模型叫了一个**本档不可用**的工具时说什么。
 *
 * 说**真名**、点名**形态**、给出**本档可用工具**——不说"未知工具"（那会让模型以为是自己拼错了，
 * 于是换个拼法再试一次，白耗一步）。`asked` 若**本档内**则返回空串（调用方据此不告知）。
 */
export function buildUnavailableNotice(
  archetype: TaskArchetype,
  asked: string,
  available: string[],
): string {
  if (available.includes(asked)) return '';
  const label = ADAPTIVE_STRATEGIES[archetype].label;
  const known = toolRegistry.getMeta(asked) ? '' : '（该名字不在工具注册表内）';
  return `工具 ${asked}${known} 在当前任务形态「${label}」下不可用——本形态只注入本档工具：${available.join(', ')}。`
    + `请改用其中之一完成这一步；若确实需要该能力，请说明理由并报告给用户。`;
}

/** 任务类型关键词规则：匹配即返回。更具体的模式放在前面。 */
const ARCHETYPE_KEYWORD_RULES: Array<{ pattern: RegExp; archetype: TaskArchetype; reason: string }> = [
  // P0: MCP/服务部署类——必须最优先，避免被code规则的"PR"/"build"等误匹配
  // P0.6: 扩展类——"扩展...工具/模块/MCP"需写代码，最高优先级（避免被MCP部署规则误匹配为配置）
  { pattern: /扩展.*(工具|模块|组件|功能|服务|Server|MCP|接口|API|引擎)/i, archetype: 'code', reason: '扩展工具/模块=编码实现' },
  { pattern: /(启动|配置|部署|注册|安装).{0,20}(MCP|mcp|Server|服务)|(MCP|mcp|Server|服务).{0,20}(启动|配置|部署|注册|安装)/i, archetype: 'configuration', reason: 'MCP服务部署' },
  // P0.5: 编码实现类——优先于文档类，"实现...模块"需写代码而非写文档
  { pattern: /实现.*(模块|组件|功能|引擎|系统|脚本)/, archetype: 'code', reason: '实现+模块/组件/引擎=编码实现' },
  // zx_20261022_3 批十二（信·名实）：**动作 + 代码产物先于文档意图**。
  //   病根（真标本 094a8b47 / e54532f9）：题面"新增/增强 ERP 端点…并在报告中如实标注"里，
  //   「写…报告」是**举证手段**，交付物本身是端点/页面；旧序让下方「撰写|写.*(文档|报告…)」先命中
  //   ⇒ 判 document ⇒ `narrowToolFace` 删掉 shell ⇒ 既不能编译/自检，也提交不了（全仓脏即被拦）。
  //   本规则只认"动作 + 代码产物"同句共现，不吞「撰写技术报告」这类真文档任务。
  { pattern: /(新建|新增|增强|添加|扩展|实现|开发|改造|重构|修复|补全|接入|编写).{0,24}(端点|接口|API|控制器|controller|页面|路由|组件|模块|服务|函数|脚本|引擎)/i, archetype: 'code', reason: '动作+代码产物=编码实现（附证据文档亦然）' },
  // zx_20261030_2 M1（「名」）：**「增加/启用/禁用…」也是写代码的动词**。
  //   真标本：任务「增加用户禁用功能」（48 字）——旧动词表无「增加」，题面短 ⇒ 长度兜底判 `conversation`
  //   ⇒ 100k 预算/10 步/工具面无 write ⇒ 只能派子，而子又拿不到 `edit_file`（D2）。
  //   本规则只认「动作 + 功能/开关类产物」**同句共现**；`增加一份报告`/`支持一下这个问题` 不命中。
  { pattern: /(增加|新增|添加|启用|禁用|移除|删除|支持|开放|提供|实现|开发|改造|接入).{0,12}(功能|开关|入口|按钮|菜单|权限|字段|选项|设置项|接口|API|端点|页面|模块|组件)/, archetype: 'code', reason: '动作+功能/开关类产物=编码实现' },
  // 文档类：**文档/报告本身是交付物**——动词与文档名词紧邻（仅容"一份/技术/API/接口"这类定语）。
  //   zx_20261022_3：去掉 `写.*(文档|报告)` 的跨句松匹配——它把"把核对表写进证据文档"读成了写文档任务。
  { pattern: /生成.{0,20}(文档|报告|方案|计划|README|总结)/, archetype: 'document', reason: '明确文档生成意图' },
  { pattern: /(撰写|编写|写)\s*(一份|一个|一篇|技术|项目|API|接口)?\s*(文档|报告|方案|计划|总结|README)/i, archetype: 'document', reason: '撰写/写+文档关键词（文档本身即交付物）' },
  // 研究/审查类
  { pattern: /(分析|审计|审查|扫描|检查).*(代码|安全|漏洞|依赖|代码库|仓库|项目.*架构|系统.*架构|技术栈)/, archetype: 'research', reason: '分析/审计代码' },
  { pattern: /(查一下|找一下|搜索一下|帮我查|帮我找|帮我搜|获取.*新闻|获取.*热点|获取.*信息|获取.*数据)/, archetype: 'research', reason: '信息获取/搜索意图' },
  { pattern: /(研究|调查|调研|review|评估|对比|查看|了解|探索|audit|盘点)/, archetype: 'research', reason: '包含调查研究关键词' },
  // 配置类
  { pattern: /(安装|部署|搭建|配置|初始化|启动).*(环境|Docker|Nginx|Redis|数据库|服务|CI|CD|k8s|kubernetes|proxy|MCP|Server|注册)/i, archetype: 'configuration', reason: '基础设施配置部署' },
  { pattern: /(setup|install|config|start).*(server|service|docker|nginx|mcp|环境)/i, archetype: 'configuration', reason: '英文配置关键词' },
  { pattern: /(启动|注册).*(MCP|服务|Server|ANS)/i, archetype: 'configuration', reason: '服务启动注册' },
  // 简单交付物注册
  { pattern: /(注册|创建).*(UI|doc|文档)\s*产出物/i, archetype: 'document', reason: '简单交付物注册' },
  // 编码类
  { pattern: /(重构|实现|开发|build|fix|bug|feature|commit|push|merge|PR|pull request|补丁)/i, archetype: 'code', reason: '包含编码相关关键词' },
  { pattern: /(实现|编写|新增|添加|修改|写).*(功能|模块|组件|页面|API|接口|端点|函数|代码|脚本|引擎)/, archetype: 'code', reason: '明确的编码动作' },
  { pattern: /(改|修).*(bug|缺陷|错误|问题|代码)/i, archetype: 'code', reason: '修复问题' },
  // 数据分析类
  { pattern: /(统计|数据|趋势|chart|图表|可视化|metrics|指标|日志.*分析|log.*analys)/i, archetype: 'analysis', reason: '包含数据分析关键词' },
  // 兜底宽泛模式
  { pattern: /(文档|报告|方案|计划|README|总结)/, archetype: 'document', reason: '文档/报告/方案关键词' },
  { pattern: /(安装|配置|部署|搭建|初始化|setup|install|config)/i, archetype: 'configuration', reason: '配置关键词' },
  // 对话类（最后兜底）
  { pattern: /^(你好|hi|hello|谢谢|帮助|help|什么是|怎么|如何|what|how)/i, archetype: 'conversation', reason: '对话交互' },
];

/** 家族相似性：每种原型的"家族代表"描述 */
export const FAMILY_REPRESENTATIVES: Record<TaskArchetype, string> = {
  code: '编写代码实现功能，修复bug，重构代码，开发新模块或组件，修改现有代码逻辑，写脚本',
  research: '调查研究技术问题，分析代码库架构，搜索最新资料，了解技术实现方案，评估技术选型',
  document: '生成技术文档、项目报告、方案计划、API文档、README文件，撰写总结报告',
  analysis: '统计分析数据，计算指标趋势，制作图表可视化，分析日志数据，生成数据报告',
  configuration: '安装配置环境，部署服务，搭建开发环境，配置依赖，启动MCP服务，配置系统参数',
  conversation: '回答技术问题，提供建议，交流讨论，解释概念，帮助理解技术知识',
};

/** 词袋模型相似度（Jaccard变体：TF权重） */
function familyResemblanceScore(text: string, representative: string): number {
  const extractFeatures = (s: string): Map<string, number> => {
    const features = new Map<string, number>();
    const cleaned = s.replace(/[^一-龥a-zA-Z0-9]/g, ' ').toLowerCase();
    const words = cleaned.split(/\s+/).filter(w => w.length >= 1);
    for (const w of words) { features.set(w, (features.get(w) || 0) + 1); }
    const chinese = s.replace(/[^一-龥]/g, '');
    for (let i = 0; i < chinese.length - 1; i++) {
      const gram = chinese.slice(i, i + 2);
      features.set(gram, (features.get(gram) || 0) + 1);
    }
    return features;
  };
  const textFeat = extractFeatures(text);
  const repFeat = extractFeatures(representative);
  if (textFeat.size === 0 || repFeat.size === 0) return 0;
  let intersection = 0, union = 0;
  const allKeys = new Set([...textFeat.keys(), ...repFeat.keys()]);
  for (const key of allKeys) {
    intersection += Math.min(textFeat.get(key) || 0, repFeat.get(key) || 0);
    union += Math.max(textFeat.get(key) || 0, repFeat.get(key) || 0);
  }
  return union === 0 ? 0 : intersection / union;
}

/** 形态判定的来源（zx_20261030_2 M1）：写进任务账，GUI 据此说「为什么判成这个」。
 *  `node`/`manual` 由执行器侧的 `resolvePinnedArchetype` 给出；`semantic`/`calibrated` 是自动判定之后的两次修正。 */
export type ArchetypeSource = 'keyword' | 'family' | 'fallback' | 'semantic' | 'calibrated' | 'node' | 'manual';

export interface ArchetypeDecision {
  archetype: TaskArchetype;
  source: ArchetypeSource;
  reason: string;
}

/** 兜底：基于消息长度和特征推断。返回判定与**具体分支**（供溯源，不靠猜）。 */
function fallbackArchetypeDetailed(text: string): ArchetypeDecision {
  const len = text.length;
  if (len < 30) return { archetype: 'conversation', source: 'fallback', reason: `短题面（${len} 字）` };
  if (/\b(function|const |let |import |export |class |interface |type |async |await |return |\.tsx?|\.jsx?)\b/.test(text)) {
    return { archetype: 'code', source: 'fallback', reason: '题面含代码特征' };
  }
  if (/\.md|\.json|\.yml|\.yaml|\.csv/.test(text)) return { archetype: 'document', source: 'fallback', reason: '题面含文档/数据文件扩展名' };
  if (/(产出|交付|输出|生成|创建|写.*文件)/.test(text)) return { archetype: 'document', source: 'fallback', reason: '题面含产出/交付意图' };
  if (len > 200) return { archetype: 'research', source: 'fallback', reason: '长题面且无更具体特征' };
  return { archetype: 'conversation', source: 'fallback', reason: '无匹配特征，按通用问答处理' };
}

function fallbackArchetype(text: string): TaskArchetype {
  return fallbackArchetypeDetailed(text).archetype;
}

/** 关键词快速分类（零延迟） */
export function classifyArchetypeKeywordDetailed(text: string): { archetype: TaskArchetype; reason: string } | null {
  // zx_20260904_3 D3 (2026-09-04): 规划/调研 + 产出文档意图 → research（在 code 规则前判定，
  // 避免"优化规划"等含"实现…功能"的描述被 code 误吞——先走查再落方案文档而非写代码）
  if (/(功能优化规划|优化方案|排期方案|升级方案|优化规划|实施规划|改进方案|方案设计|调研方案|调研报告|完成情况核实|复核报告)/.test(text)
    && /(写入|写到|产出|生成|落盘|写出|保存到|交付|提交)/.test(text)
    && /(\.md|\.MD|文档|报告|方案文件)/.test(text)) {
    return { archetype: 'research', reason: '规划/调研+产出文档' };
  }
  for (const rule of ARCHETYPE_KEYWORD_RULES) {
    if (rule.pattern.test(text)) return { archetype: rule.archetype, reason: rule.reason };
  }
  return null;
}

/** 关键词快速分类（兼容出口：只要形态） */
export function classifyArchetypeKeyword(text: string): TaskArchetype | null {
  return classifyArchetypeKeywordDetailed(text)?.archetype ?? null;
}

/** 家族相似性分类 */
export function classifyByFamilyResemblance(text: string): Array<{ archetype: TaskArchetype; score: number }> {
  const scores = Object.entries(FAMILY_REPRESENTATIVES).map(([archetype, representative]) => ({
    archetype: archetype as TaskArchetype,
    score: familyResemblanceScore(text, representative),
  }));
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

/** 任务类型分类（关键词 → 家族相似性 → 长度兜底），带来源与理由。 */
export function classifyArchetypeDetailed(text: string): ArchetypeDecision {
  const kw = classifyArchetypeKeywordDetailed(text);
  if (kw) {
    logger.info({ archetype: kw.archetype, text: text.slice(0, 60) }, '任务类型(关键词)');
    return { archetype: kw.archetype, source: 'keyword', reason: kw.reason };
  }
  const family = classifyByFamilyResemblance(text);
  const best = family[0]!;
  if (best.score >= 0.05) {
    logger.info({ archetype: best.archetype, score: best.score.toFixed(3), text: text.slice(0, 60) }, '任务类型(家族相似性)');
    return { archetype: best.archetype, source: 'family', reason: `与「${best.archetype}」家族相似度 ${best.score.toFixed(3)}` };
  }
  const fb = fallbackArchetypeDetailed(text);
  logger.info({ archetype: fb.archetype, text: text.slice(0, 60) }, '任务类型(长度兜底)');
  return fb;
}

/** 任务类型分类（关键词 → 家族相似性 → 长度兜底） */
export function classifyArchetype(text: string): TaskArchetype {
  return classifyArchetypeDetailed(text).archetype;
}

/** 获取任务原型的自适应策略 */
export function getAdaptiveStrategy(archetype: TaskArchetype): AdaptiveStrategy {
  return ADAPTIVE_STRATEGIES[archetype];
}

// ==================== 战术重视：重活形态的选型下限 ====================

/**
 * zx_20261012_3 批四（「重活不被随机挑中」）: **重活形态**——写码 / 调研 / 分析。
 * 这三类是最怕"选到弱模型"的：结果不是"差一点"，而是根本做不成（改错代码、调研跑偏、算错数）。
 */
export const HEAVY_ARCHETYPES: readonly TaskArchetype[] = ['code', 'research', 'analysis'];

/**
 * zx_20261012_3 批四: **非确定性**选型策略。
 *
 * 当前**唯一**一个是 `balanced`——ANS 侧 `resource-matcher.ts` 的 `sortByStrategy` 里，
 * `cost-optimal`/`latency-optimal`/`capability-best` 三者都是**确定性排序**（按价/延迟/命中数升序），
 * 唯独 `balanced` 落 `weightedShuffle`（**加权随机**）。即：同一个任务、同一份资源池，跑两次可能换模型。
 *
 * ⚠ 这是**跨仓库**结论（ANS 的 `sortByStrategy` 是判据所依）——ANS 侧若哪天把 `balanced` 改成确定性
 *   排序，本名单即失效（表现为"下限再也不触发"，不会假红）。故此处只登记一个策略名，不复制 ANS 实现。
 */
export const NON_DETERMINISTIC_STRATEGIES: readonly string[] = ['balanced'];

/**
 * zx_20261012_3 批四: 形态下限——**重活形态**的选型不得落到非确定性（随机）策略上，落则回落形态自带策略。
 *
 * 起因（plans/improve/zx_20261012_3.md §1.2④ 实测）：某项目那轮 `code` 形态任务，
 * `learned_strategy.modelStrategy='balanced'` 覆盖了形态自带的 `capability-best`；`balanced` 是加权随机
 * ⇒ 池子里的弱本地模型（`qwen3.5:9b`，priority 低但非零权重）约有 1/5 概率被抽中——**同一份任务跑两次可能换模型**。
 *
 * 判据**刻意不是**"不许降级"：那样会把 `cost-optimal` 一并禁掉，而它按价升序、是确定性的，
 * 对"调研"类（自带 `cost-optimal`）本就是合理选择。要禁的是**抽签**，不是**省钱**。
 *
 * ⚠ **只治系统自己学来的主意**：调用点作用于 `learned`/`natural` 派生出的 `baseStrategy`，
 *   **不**作用于其后的 `applyPriorityTilt`（那是 `task.priority`，**用户显式**信号）——
 *   用户明说"低优先、省着点"，系统不越权替他改口；但系统学来的主意不许把重活变成抽签。
 *
 * ⚠ 重活形态自带的策略必须**自身就是确定性的**（`code`→`capability-best`、`research`→`cost-optimal`、
 *   `analysis`→`capability-best`）——否则"回落到自带策略"就是把随机换个名字。该不变式由 rr 静态钉死。
 */
export function applyArchetypeFloor(
  archetype: TaskArchetype,
  modelStrategy: string,
): { modelStrategy: string; floored: boolean } {
  const own = ADAPTIVE_STRATEGIES[archetype].modelStrategy;
  if (HEAVY_ARCHETYPES.includes(archetype) && NON_DETERMINISTIC_STRATEGIES.includes(modelStrategy)) {
    return { modelStrategy: own, floored: true };
  }
  return { modelStrategy, floored: false };
}

// ==================== 集中优势兵力：优先级资源倾斜 ====================

interface ResourceTilt { modelUpgrade: number; maxStepsMultiplier: number; temperatureModifier: number; }

const PRIORITY_TILT: Record<string, ResourceTilt> = {
  'critical': { modelUpgrade: 2, maxStepsMultiplier: 1.5, temperatureModifier: -0.15 },
  'high': { modelUpgrade: 1, maxStepsMultiplier: 1.25, temperatureModifier: -0.05 },
  'medium': { modelUpgrade: 0, maxStepsMultiplier: 1.0, temperatureModifier: 0 },
  'low': { modelUpgrade: -1, maxStepsMultiplier: 0.7, temperatureModifier: 0.1 },
};

/** 数字优先级(0-3) → 字符串等级。0=普通(不倾斜)，1=优先，2/3=紧急/最高 */
function priorityToLevel(priority: number): string {
  if (priority >= 2) return 'critical';
  if (priority >= 1) return 'high';
  return 'medium';
}

/**
 * 集中兵力：按任务优先级倾斜资源。
 * critical: 升级2档模型 + 1.5x步数 + 降温0.15
 * high: 升级1档 + 1.25x
 * low: 降级1档 + 0.7x
 */
export function applyPriorityTilt(strategy: AdaptiveStrategy, priority: number): AdaptiveStrategy {
  const level = priorityToLevel(priority);
  const tilt = PRIORITY_TILT[level]!;
  const result = { ...strategy, priorityTools: [...strategy.priorityTools] };
  const modelOrder = ['cost-optimal', 'balanced', 'capability-best'] as const;
  const currentIdx = modelOrder.indexOf(strategy.modelStrategy as typeof modelOrder[number]);
  if (currentIdx >= 0) {
    result.modelStrategy = modelOrder[Math.max(0, Math.min(modelOrder.length - 1, currentIdx + tilt.modelUpgrade))]!;
  }
  result.maxSteps = Math.round(strategy.maxSteps * tilt.maxStepsMultiplier);
  result.temperature = Math.max(0.05, Math.min(0.95, strategy.temperature + tilt.temperatureModifier));

  if (level === 'critical') result.label = `${strategy.label}[集中兵力]`;
  else if (level === 'high') result.label = `${strategy.label}[重点保障]`;
  else if (level === 'low') result.label = `${strategy.label}[经济模式]`;

  return result;
}

// ==================== 战略藐视战术重视：双层执行模式 ====================

type ExecutionMode = 'strategic' | 'tactical';

/**
 * 小任务(描述<30字) + 低优先级(0) → 战略藐视(快速模式, ≤8步)。
 * 其余走战术重视(完整步数)。
 */
export function determineExecutionMode(description: string, priority: number): ExecutionMode {
  const isSimple = description.trim().length < 30 && !/(分析|实现|部署|搭建|生成.*报告|扩展.*模块|重构)/.test(description);
  if (isSimple && priority <= 0) return 'strategic';
  return 'tactical';
}

/**
 * 快速模式：步数减半(≤8步) + Token 预算减半。
 * zx_20260910_6 M1：原对金额的同步折半已随 `ARCHETYPE_BUDGETS.cost` 一并删除——
 * 对"别人许下的数"再打个折是越权（用户设 ¥2 就是 ¥2，不该被快速模式悄悄变成 ¥1）。
 */
export function applyExecutionMode(
  mode: ExecutionMode,
  strategy: AdaptiveStrategy,
  budget: { tokens: number },
): { strategy: AdaptiveStrategy; budget: { tokens: number }; label: string } {
  if (mode === 'strategic') {
    return {
      strategy: { ...strategy, maxSteps: Math.min(8, strategy.maxSteps) },
      budget: { tokens: Math.round(budget.tokens * 0.5) },
      label: '[快速模式]',
    };
  }
  return { strategy, budget, label: '' };
}

// ==================== 合抱之木：动态复杂度重评估 ====================

export type ComplexityLevel = 'simple' | 'standard' | 'complex';

/** 关键词规则：匹配即返回复杂度级别 */
const COMPLEXITY_KEYWORD_RULES: Array<{ pattern: RegExp; level: ComplexityLevel; reason: string }> = [
  { pattern: /创建项目|初始化项目|搭建.*项目|扩展.*(模块|组件|服务|系统|工具).*(实现|注册)/, level: 'complex', reason: '多步骤协调任务' },
  { pattern: /(?:分析|生成).*(?:报告|文档).*(?:和|及|、).*(?:报告|文档)/, level: 'complex', reason: '需生成2+份报告' },
  { pattern: /(?:分析|生成).*(?:报告|文档|方案|计划)/, level: 'standard', reason: '单一报告生成' },
  { pattern: /(?:克隆).*(?:仓库)|git\s+clone/, level: 'standard', reason: '仓库克隆' },
  { pattern: /(?:实现|编写|新增|修改|扩展|重构|修复).*(?:功能|模块|组件|工具|接口|API|代码|脚本)/, level: 'standard', reason: '编码实现' },
  { pattern: /^(?=.*(查看|查询|搜索|查找|列出|显示|了解))(?!.*(\.md|文件|产出|写入|生成|报告|创建|实现|扩展))/, level: 'simple', reason: '只读查询' },
];

/** 兜底：消息长度判断复杂度 */
function fallbackComplexityByLength(text: string): ComplexityLevel {
  const len = text.length;
  if (len > 300) return 'complex';
  if (len > 30) return 'standard';
  return 'simple';
}

/** 评估任务复杂度（关键词 → 长度兜底） */
export function assessComplexity(description: string): ComplexityLevel {
  for (const rule of COMPLEXITY_KEYWORD_RULES) {
    if (rule.pattern.test(description)) return rule.level;
  }
  return fallbackComplexityByLength(description);
}

/**
 * zx_20261002 M5（维特根斯坦·意义即用法 / 管子·度量衡）：**「本任务算不算复杂到该拆」的唯一判据**。
 *
 * 这条规则此前只以**软建议**的形态活着（`exec-context.ts` 里内联的一段：推一句"建议先调用
 * enter_plan_mode"，是否照办全凭模型自觉），而"真拆"只长在 `enter_plan_mode` 这个**工具**里
 * ⇒ 模型不调，`auto_decomposed` 在真库恒为零行（§1.2）。
 * 现把"复杂档"这**一把尺**收成一处：软建议（执行前引导）与**主动拆解**（启动路"到点即拆"）
 * 同问本函数——同一件事只有一种说法，改口径时两处一起改。
 *
 * 判据逐字取自原内联写法（**零语义变更**）：复杂度为 complex **或** 标题/描述命中规划方案类关键词。
 *
 * 形参收 `complexity`（而非自己在函数里再算一遍）为的是**不设"有参数之名、无参数之实"的空壳**：
 * 调用方本就持有 `assessComplexity(description)` 的结果（`agent-executor` 早已算过），
 * 传进来即可；本函数只负责那一层"是否够格拆"的判定。
 */
export function isComplexOrPlanish(complexity: ComplexityLevel, title: string, description: string): boolean {
  return complexity === 'complex' || /(规划|排期|方案|优化升级|功能优化)/.test(`${title} ${description}`);
}

/** 合抱之木：执行中动态重评估复杂度，任务变难时升级 */
export function reassessComplexityDuringExecution(context: {
  originalLevel: ComplexityLevel;
  currentSteps: number;
  cumulativeTokens: number;
  envErrors: number;
}): { newLevel: ComplexityLevel; suggestedMaxSteps: number; reason: string } | null {
  if (context.originalLevel === 'complex') return null;

  if (context.originalLevel === 'simple') {
    if (context.currentSteps > 5) {
      return { newLevel: 'standard', suggestedMaxSteps: 15, reason: `步数超简单任务预期(${context.currentSteps}>5)` };
    }
    if (context.cumulativeTokens > 100_000) {
      return { newLevel: 'standard', suggestedMaxSteps: 15, reason: `Token超简单任务预期(${context.cumulativeTokens}>100K)` };
    }
  }

  if (context.originalLevel === 'standard') {
    if (context.cumulativeTokens > 200_000) {
      return { newLevel: 'complex', suggestedMaxSteps: 25, reason: `Token超标准任务预期(${context.cumulativeTokens}>200K)` };
    }
    if (context.envErrors >= 2) {
      return { newLevel: 'complex', suggestedMaxSteps: 25, reason: `环境错误${context.envErrors}次` };
    }
  }

  return null;
}

// ==================== V3: 天下大事必作于细·LLM智能拆解 ====================
// zx_20260921 M6（D3）: 拆解器**已迁出本文件** → `core/task-decompose.ts` 的
//   `decomposeTask` / `DecompositionTemplate` / `planSubtasksFromTemplate`。
//   迁出的理由是原实现**把 ANS 取模型与发对话硬写在函数体里**，受控回归只能照抄一份等价物来试
//   ——那证的是夹具自己（本轮 §7 头号风险）。迁走后依赖面由 `DecomposeDeps` 声明式给出，
//   判据跑的是**生产真走的那份**实现。本文件不再保留任何拆解实现（不留兼容垫片）。
