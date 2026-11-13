import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
// zx_20260914 M2-4: ACCEPT_REASON_TEXT 与抽屉同源——失败说明一处映射，两处出口不许各写一份中文
import { deliverables, invoke, license, projects as projectsApi, tasks as tasksApi, ACCEPT_REASON_TEXT } from '../lib/ipc';
import { useActivity } from '../lib/activity';
import { Search, RefreshCw, RotateCcw, Eye, Copy, Play, Square, Pencil, Check, X, Trash2, History, Package, ExternalLink, Upload, Star, FolderOpen, Plus, Download } from 'lucide-react';
import { useSettings } from '../lib/settingsStore';
// zx_20260911_5 M3-1(得鱼忘筌): 列表行点开**既有**就地抽屉——此前该页是全仓 5 个成果入口里唯一不接抽屉的（E5）
import { useDeliverableDrawer } from '../lib/deliverableDrawer';
// zx_20260909 X1(可判定): diff 抽为共享工具(与成果抽屉同源)
import { simpleLineDiff } from '../lib/diff';
// 产出物展示的单一真源（类型/状态词表 / 大小换算 / 库内时间）——本页不再自带第二份
import { DELIVERABLE_TYPE_LABEL, DELIVERABLE_STATUS_LABEL, formatDbTime, formatBytes, versionSizeText, isLocalAbsolutePath as isLocalPath } from '../lib/deliverable-view';
// zx_20260930 M4-2: 列表批次大小（本页/项目页/任务详情共用一份，见该模块头注）
import { LIST_PAGE_SIZE, pageExhausted } from '../lib/list-page';
// zx_20261018_2 批六「见新」：运行态以事件驱动为主，轮询只作兜底——节拍一处真源。
import { FALLBACK_POLL_MS } from '../lib/refresh';
// zx_20260910_3 M3(G3): 布尔 setting 判据**两侧共用同一文件**——渲染层不再自带第二份写法
import { boolSetting } from '../../../src/main/core/settings-bool.js';
// zx_20260915 P0-2(e): 未核验成因词表跨 root 引 main 侧**同一份**（与 TaskDetailPage 同源，不各抄一版）
import { UNVERIFIED_REASON_LABEL } from '../../../src/main/core/acceptance-check.js';

/** 索引类型放宽（存量载荷的 reason 可能是已废弃字符串）；词表仍只有 main 侧一份 */
const ACCEPTANCE_REASON_LABEL: Record<string, string> = UNVERIFIED_REASON_LABEL;
// zx_20260913 M2-6(G8 教训·renderer 是词表的第二个落点): 类型集合判据也走**跨 root 同一份代码**——
// 此前本页 `d.type === 'doc'` 手抄 3 处(验收徽标/版本钮/预览钮)，主进程改口径渲染层不会跟着动。
import { DELIVERABLE_TASK_NONE, isAcceptanceType, isPreviewType } from '../../../src/main/core/deliverable-types.js';
// zx_20261108_1 B6: 导出按钮先按 main 侧裁定**禁用**（`license:pro_feature`）——不让用户点了才看报错；
//   拒因文案直接取 main 的 `detail`，渲染层不拼"需要专业版"。
import type { ProFeatureGatePayload } from '../../../src/main/ipc/license.ipc.js';
// zx_20261110_1 B5：读取失败如实带因由（与其它页同一实现）。
import { messageOf } from '../lib/action-feedback';
import LoadFailure from '../components/LoadFailure';
// zx_20261111_3「显」：第一行的唯一真源在 main 纯模块。
import NextActionBar from '../components/NextActionBar';
import { nextActionForDeliverables, type NextActionId } from '../../../src/main/core/next-action.js';
// zx_20260914 M2-1(王阳明·知行合一): 正文「读得动」——本页**两处**预览(版本快照 :535 / 当前内容 :597)
// 与抽屉、任务详情共用同一渲染器（上轮"能翻开"但只有 `<pre>`，打开≠读得动）。
import MarkdownSubset from '../lib/markdown-subset';
// zx_20260924_1 M5-b(维特根斯坦·语言游戏 / 一处真源): 目录树**与任务详情同一份实现**——
//   跨 root 引 main 侧零依赖纯模块（先例：settings-bool / deliverable-types / acceptance-check），
//   路径逐字照抄 TaskDetailPage.tsx 的那一行，两页不许各摆一棵树。
//   为什么是"同一份"而不是"长得像"：剥公共前缀/无路径单列/单子目录链并段三条规则都在那个模块里，
//   此处只负责把它的结果画成行。规则改了，两页同时改——这正是本轮的靶心。
import { buildDeliverableTree, type DeliverableTreeChild } from '../../../src/main/core/deliverable-tree.js';

// zx_20260906 批3 (3b): 产出物携带任务溯源（task_id/task_title/task_status 由 deliverable:list JOIN 回传）
// zx_20260906_1 3a: 列表补 updated_at(最近变更) 与 task_quality_score(产出任务质量分) 数据位
// zx_20260907 M2(B2): 验收透出数据位——acceptance 由 deliverable:list 同源派生自产出任务 ctxJson.acceptance_check(doc 已核才显徽标)
interface Deliverable { id: string; project_id: string; project_name?: string; task_id?: string | null; task_title?: string | null; task_status?: string | null; task_quality_score?: number | null; acceptance?: { criteria_total?: number; passed_total?: number; checked_at?: string } | null; task_acceptance?: { verified?: boolean; criteria_total?: number; passed_total?: number; reason?: string; checked_at?: string; proposed?: string[] } | null; name: string; type: string; status: string; description?: string; file_path?: string; registry_id?: string; created_at: string; updated_at?: string | null; is_primary?: number;
  // zx_20260924_1 M5-b: 盘上真实字节数——由 main 侧 `deliverable:list` 按 file_path 现场 stat 逐行补上
  //   （本表无 size 列，renderer 无 fs）。文件不在/无路径 ⇒ null ⇒ 界面印 `—`，"不知道"不冒充"零"。
  size_bytes?: number | null;
  // zx_20260913 M2-6/M2-2: 版本历史门禁真源(版本行数) + 除归属者外的历次写入任务(由 wa_deliverable_versions.changed_by 派生)
  version_count?: number; other_writers?: Array<{ id: string; title: string }>; }
interface RuntimeInfo { running: boolean; port?: number; endpoint?: string; }

const TYPE_COLORS: Record<string, string> = { mcp: 'bg-blue-100 text-blue-700', a2a: 'bg-green-100 text-green-700', ui: 'bg-purple-100 text-purple-700', doc: 'bg-amber-100 text-amber-700', daemon: 'bg-orange-100 text-orange-700', code: 'bg-slate-100 text-slate-700' };
// zx_20260906 批3 (3e): 软退休状态 chip 灰色兜底（重试旧成果）
const STATUS_CLS: Record<string, string> = { retired: 'bg-gray-200 text-gray-500 line-through', stale: 'bg-yellow-100 text-yellow-600', failed: 'bg-red-100 text-red-600', running: 'bg-green-100 text-green-700', registered: 'bg-blue-100 text-blue-700', stopped: 'bg-orange-100 text-orange-600' };

/** 任务筛选的"项目级"哨兵值：`task_id IS NULL`（手工成果/项目级成果）也须可选，故不用空串占位。
 *  zx_20261108_1 B6: 字面量真源在 main 侧零依赖模块 `deliverable-types`（服务端 `deliverable-query` 同引），
 *  渲染层只起别名——不再各写一份 `'__none__'`。 */
const TASK_NONE = DELIVERABLE_TASK_NONE;

// zx_20260930 M4-2: 批次大小取渲染层的**唯一真源**（成果页/项目页/任务详情三处同一份，
//   免得各写一个字面量；它与 main 侧 `PAGE_DEFAULT` 同值而**不同义**，理由写在该模块头注里）。
const PAGE_SIZE = LIST_PAGE_SIZE;

export default function DeliverablesPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Deliverable[]>([]);
  // zx_20260930 M4-2: 分页——`itemsTotal` 是**服务端筛选后**的全量条数（不是当页长度），
  //   据此写"已加载 K / 共 M"并决定是否出「加载更多」。`itemsExhausted` 记录"下一页取空了"。
  const [itemsTotal, setItemsTotal] = useState(0);
  // zx_20260930 M4-2: 已退休件计数**由服务端按同一组筛选条件算**（`deliverable:list` 的 `retiredCount`）。
  //   原先由渲染层数 `items`——分页后那只是"这一页里有几项"，而按钮/提示给的是**归档提示**，
  //   提示里的数必须与它所指的全量集合同尺，否则会出现"已退休 3 项"却一页一页翻出 20 项。
  const [itemsRetiredCount, setItemsRetiredCount] = useState(0);
  const [itemsExhausted, setItemsExhausted] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  // zx_20260930 M4-2: 下拉名录改由**服务端** `deliverables.facets()` 派生（原先靠 `allItems` = 无参全表）。
  //   分页后"全表"这条路要么被截断（下拉静默缺项 = E15 复发）、要么把整表为两个下拉再读一遍（首屏更慢）。
  //   名录与页大小、与页内筛选**都无关**，故与 items 分开存。
  const [facetProjects, setFacetProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [facetTasks, setFacetTasks] = useState<Array<{ id: string; title: string | null }>>([]);
  const [facetNoTaskCount, setFacetNoTaskCount] = useState(0);
  const [runtime, setRuntime] = useState<Map<string, RuntimeInfo>>(new Map());
  // zx_20261111_3「显」：第一行要的三个数由 main 现算（与列表同一 scope、同一验收判据）。
  //   `null` = 没取到 ⇒ 第一行说"读不到"，不数已加载行。
  const [attention, setAttention] = useState<{ total: number; unverified: number; acceptanceEnabled: boolean } | null>(null);
  const [attentionErr, setAttentionErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [filterProj, setFilterProj] = useState('');
  const [filterType, setFilterType] = useState('');
  // zx_20260906_1 3b: 状态/时间窗筛选 + 可排序列头（3a 质量/最近变更排序）
  const [filterStatus, setFilterStatus] = useState('');
  const [recentDays, setRecentDays] = useState(0);
  const [sortBy, setSortBy] = useState<'created' | 'updated' | 'name' | 'type' | 'status' | 'quality' | 'project' | 'size'>('created');
  const [sortAsc, setSortAsc] = useState(false);
  // zx_20260906_2 批3 (2026-09-06): 成果关键词检索——keyword 即时输入、appliedKeyword 250ms 防抖后作服务端过滤(跨项目全局)
  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  useEffect(() => { const t = window.setTimeout(() => setAppliedKeyword(keyword.trim()), 250); return () => window.clearTimeout(t); }, [keyword]);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  // zx_20260906 批3 (3e): 已退休产出物默认过滤（重试旧成果 soft-retired 不占主列表），可切回查看并示计数
  const [showRetired, setShowRetired] = useState(false);
  // zx_20260913 M2-7(管子·度量衡): 按项目分组查看——默认开，**可关**。
  //   刻意做成开关而非无条件分组：7 列表头排序是既有能力，无条件分组会让"按质量排序"跨项目失效
  //   （同项目内仍保序），故给用户一条退路(关掉即回到全表排序)。
  const [groupByProject, setGroupByProject] = useState(true);
  // zx_20260924_1 M5-b(E-5): 目录树视图——**与任务详情同一份 `buildDeliverableTree`**。
  //   默认开：本轮的靶心就是"两页归一"，默认平铺则两页的层级/命名在默认状态下仍各说各话。
  //   平铺退路保留（既有 7 列排序 + 按项目分组都活在那条路上），一键可切。
  const [viewMode, setViewMode] = useState<'tree' | 'flat'>('tree');
  // zx_20260924_1 M5-b: 「仅显示主成果」——★ 是**互斥谓词**（M5-a 已把作用域收敛到一处），
  //   本筛只看 `is_primary` 这一列，不自带一套"算什么才叫主要"的判据。
  const [onlyPrimary, setOnlyPrimary] = useState(false);
  // zx_20260924_1 M5-b: 按产出任务筛选（`TASK_NONE` = task_id IS NULL 的"项目级"一组）。
  const [filterTask, setFilterTask] = useState('');
  // 版本历史（zx_20260906 批3/3b: 携带 content_snapshot/changed_by 供真实快照预览）
  const [showVersions, setShowVersions] = useState(false);
  const [versions, setVersions] = useState<Array<{ id: string; version: number; size: number; created_at: string; content_snapshot?: string; changed_by?: string }>>([]);
  const [versionDelivId, setVersionDelivId] = useState('');
  const [versionName, setVersionName] = useState('');
  // zx_20261110_1 B5：版本历史读取失败与「确实没有版本」分家（失败带因由 + 重试）。
  const [versionsErr, setVersionsErr] = useState('');
  const [versionsBusy, setVersionsBusy] = useState(false);
  // zx_20261110_1 B5：预览读取失败如实上屏（不再 `catch {}` 后毫无反应）。
  const [previewErr, setPreviewErr] = useState('');
  const [previewErrDeliv, setPreviewErrDeliv] = useState<Deliverable | null>(null);
  // zx_20261110_1 B5：列表/「加载更多」/筛选名录读取失败——不再以空列表冒充"没有产出物"。
  const [listErr, setListErr] = useState('');
  const [facetsErr, setFacetsErr] = useState('');
  const [selectedVersion, setSelectedVersion] = useState<{ content: string; version: number; created_at?: string; size?: number; changed_by?: string } | null>(null);
  const [diffView, setDiffView] = useState<Array<{ type: 'same' | 'add' | 'del'; line: string }> | null>(null);
  // 预览
  const [preview, setPreview] = useState<{ id: string; name: string; type: string; content: string; version: number; filePath?: string; fileExists?: boolean; contentTruncated?: boolean; contentSource?: string } | null>(null);
  // zx_20260930 M3-c(手工建成果上 GUI): 此前 `deliverables.create` 端口在 renderer **零调用点**——
  //   成果只能由 agent 的工具写入，人在 GUI 上无法立项（E2E 实测暴露）。本表单是该端口的唯一入口，
  //   与 agent 的 `create_deliverable` **共用 main 侧同一个 `createDeliverable`**（校验/去重/落库/通报一处），
  //   故不存在"GUI 一套口径、agent 另一套"。
  const [showCreate, setShowCreate] = useState(false);
  const [cForm, setCForm] = useState({ projectId: '', taskId: '', type: 'doc', name: '', description: '', filePath: '' });
  const [cProjects, setCProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [cTasks, setCTasks] = useState<Array<{ id: string; title: string }>>([]);
  const [cBusy, setCBusy] = useState(false);
  const [cErr, setCErr] = useState('');
  // zx_20261108_1 B6: CSV 导出的 Pro 闸裁定（`license:pro_feature`）。`null` = 尚在取/取不到 ⇒ 不禁用，
  //   真正的拦截仍在 main（`deliverable:exportCsv` 先过 `proFeatureRefusal`）——界面只是**提前**告知。
  const [exportGate, setExportGate] = useState<ProFeatureGatePayload | null>(null);
  const [exporting, setExporting] = useState(false);

  const showToast = (msg: string, type: 'success' | 'error') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };
  // zx_20260908 M2(B2b): primary 主要成果星标（deliverable.primary_marker 开关；展示+人工可标，供项目成果交付单聚合）
  const settings = useSettings();
  const primaryEnabled = boolSetting(settings['deliverable.primary_marker']);
  // zx_20260911_5 M3-1: 就地抽屉门控——与 ProjectDetail/TaskDetail/DeliveryDigest/CommandPalette 同一把尺
  const drawerOn = boolSetting(settings['deliverable.doc_drawer']);
  const { open: openDeliv } = useDeliverableDrawer();
  const handleTogglePrimary = async (d: Deliverable) => {
    try { await deliverables.setPrimary(d.id, d.is_primary !== 1); load(); } catch { showToast('设置主要成果失败', 'error'); }
  };
  // zx_20260914 M2-4(王阳明·知行合一 / D2 裁定: 入口放列表行 + 抽屉两处): 「标为已验收」。
  //   总门控与列表徽标同源(boolSetting 同一份 settings 值)，拒绝原因**说清是哪一条**。
  const acceptEnabled = boolSetting(settings['deliverable.show_acceptance']);
  const handleAccept = async (d: Deliverable) => {
    try {
      const r = await deliverables.accept(d.id);
      if (r?.ok) { showToast(r.changed > 0 ? '已标记为验收' : '该成果此前已标记', 'success'); load(); }
      else showToast(ACCEPT_REASON_TEXT[r?.reason || 'error'] || ACCEPT_REASON_TEXT.error!, 'error');
    } catch { showToast(ACCEPT_REASON_TEXT.error!, 'error'); }
  };

  // 唯一项目列表
  // zx_20260930 M4-2: 名录由服务端 `facets` 派生（此前由 `allItems` = 无参全表派生）。
  //   E15（选定项目后下拉自坍缩）依旧被排除：名录**既不受本页筛选影响、也不受分页影响**——
  //   这正是把名录从"列表的副产品"改成"服务端名录"的意义。
  const projects = facetProjects.map(p => [p.id, p.name || '未知项目'] as const);

  // zx_20261108_1 B6: **当前筛选 + 排序**的唯一装配处（首屏/加载更多/导出三处共引）。
  //   `since` 由"近 N 天"换算成 ISO 时刻（服务端 `toSqlUtc` 取 UTC 部分，与库内 `datetime('now')` 同尺）；
  //   `showRetired` 显式下发——缺省 `false` 时服务端会在**未显式选状态**的前提下把 retired 挡在列表外。
  const buildParams = useCallback((limit: number, offset: number) => ({
    projectId: filterProj || undefined,
    type: filterType || undefined,
    status: filterStatus || undefined,
    keyword: appliedKeyword || undefined,
    taskId: filterTask || undefined,
    since: recentDays > 0 ? new Date(Date.now() - recentDays * 86400_000).toISOString() : undefined,
    primary: onlyPrimary || undefined,
    showRetired,
    // `created`/`updated` 是既有界面短名，服务端 `normalizeSort` 按别名接受——不在此另写映射。
    sort: sortBy,
    order: sortAsc ? 'asc' : 'desc',
    limit,
    offset,
  }), [filterProj, filterType, filterStatus, appliedKeyword, filterTask, recentDays, onlyPrimary, showRetired, sortBy, sortAsc]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // zx_20260930 M4-2: 筛选一变即**回到第 0 页**（不追加）——否则换了筛选还在翻上一轮的页。
      // zx_20261108_1 B6: 筛选/排序**全部下沉服务端**——`total` 与 `rows` 同一 WHERE，故页脚
      //   "共 M 条"就是"当前筛选条件下的全量条数"，不再是"已加载页里的数"。
      const d = await deliverables.list(buildParams(PAGE_SIZE, 0));
      const rows = (d?.rows ?? []) as unknown as Deliverable[];
      const total = Number(d?.total) || 0;
      setItems(rows);
      setItemsTotal(total);
      setItemsRetiredCount(Number(d?.retiredCount) || 0);
      // 取空 / 已取到总数 ⇒ 没有下一页（判据与另两处共用同一函数，不各写一遍）
      setItemsExhausted(pageExhausted(rows.length, total));
      setListErr('');
    } catch (e) { setListErr(messageOf(e)); }
    setLoading(false);
  }, [buildParams]);

  // zx_20260930 M4-2: 名录与主列表**分开取**（各打各的 IPC，互不牵连）。它不随筛选/分页变化，
  //   故只在挂载后取一次 + 成果增删时随 `load()` 一并刷新（名录会变，但不需要每次翻页都取）。
  const loadFacets = useCallback(async () => {
    try {
      const f = await deliverables.facets();
      setFacetProjects(f?.projects ?? []);
      setFacetTasks(f?.tasks ?? []);
      setFacetNoTaskCount(Number(f?.noTaskCount) || 0);
      setFacetsErr('');
    } catch (e) { setFacetsErr(messageOf(e)); }
  }, []);

  // zx_20260930 M4-2: 「加载更多」——按**已列出的条数**取下一页，并按 id 去重合并。
  //   去重不是洁癖：`deliverable:list` 按 `created_at DESC` 排，翻页期间若有新成果落库，
  //   它会插到第 0 页顶部、把原第 0 页末行挤到第 1 页 ⇒ 按 offset 取会**重复**列出一条。
  const loadMoreItems = useCallback(async () => {
    setMoreBusy(true);
    try {
      const d = await deliverables.list(buildParams(PAGE_SIZE, items.length));
      const more = (d?.rows ?? []) as unknown as Deliverable[];
      setItems(prev => {
        const seen = new Set(prev.map(r => r.id));
        return [...prev, ...more.filter(r => !seen.has(r.id))];
      });
      const total = Number(d?.total) || 0;
      setItemsTotal(total);
      setItemsRetiredCount(Number(d?.retiredCount) || 0);
      setItemsExhausted(pageExhausted(items.length + more.length, total));
      setListErr('');
    } catch (e) { setListErr(messageOf(e)); }
    setMoreBusy(false);
  }, [buildParams, items.length]);

  const loadRuntime = useCallback(async () => {
    const map = new Map<string, RuntimeInfo>();
    for (const item of items) {
      if (['mcp', 'a2a', 'daemon'].includes(item.type)) {
        try {
          const info = await deliverables.runtime(item.id) as unknown as { running?: boolean; port?: number; endpoint?: string | null; status?: string };
          if (info?.running) {
            map.set(item.id, { running: true, port: info.port ?? undefined, endpoint: info.endpoint ?? undefined });
          }
        } catch (e) { console.error('[runtime]', item.name, (e as Error).message); }
      }
    }
    setRuntime(map);
  }, [items]);

  useEffect(() => { load(); }, [load]);
  // zx_20260930 M4-2: 名录**不随筛选/翻页变化**，故单独取一次（挂载后）。它只在成果增删后需要重取，
  //   由下面的事件订阅（成果注册/状态变更）与新建/删除两处显式再取，不跟 `load()` 走"每次换筛选都重取"。
  useEffect(() => { void loadFacets(); }, [loadFacets]);
  // zx_20261108_1 B6: 取一次导出能力裁定（失败就不禁用——真闸仍在 main，界面不因读不到档位把功能藏掉）。
  useEffect(() => {
    void license.proFeature('deliverable_export').then(g => setExportGate(g)).catch(() => setExportGate(null));
  }, []);
  // zx_20260929 M12: 依赖由 `items.length` 改成 `items` 本身。启动/停止前后列表**长度常常相同**
  // （draft→running 只是同一行换字段），长度没变 ⇒ 本效应不重跑 ⇒ ▶/绿点最多滞后到下一次 10s 轮询，
  // 用户读成"启动了但状态没变"，于是反复点（实测两次点击相隔 7.1s，正落在 10s 窗口内）。
  // 改成跟着列表内容走：`load()` 一刷新，运行态立刻跟上。
  // zx_20261018_2 批六：进程启停/退出由 main 侧发 `deliverable.runtime_changed`（见下方订阅）——
  //   轮询降为 `FALLBACK_POLL_MS`（30s）兜底，管的是"崩溃/丢事件"而不是日常刷新。
  useEffect(() => { if (items.length > 0) loadRuntime(); }, [items, loadRuntime]);
  useEffect(() => { const t = setInterval(loadRuntime, FALLBACK_POLL_MS); return () => clearInterval(t); }, [loadRuntime]);

  // A1 事件驱动刷新：交付物注册/文件事件/运行态变更触发列表重载（轮询保留为兜底）
  // zx_20260930 M4-5：订阅集补**任务终态**（`task.completed`/`task.failed`）——成果行上写着
  // 「所属任务 + 任务状态 + 验收标注」，任务态一变这一行就该跟着变；此前只订阅成果自身事件，
  // 于是"任务干完了、成果页仍写着执行中"要干等 10s 轮询。`task.status_changed` 一并纳入，理由与
  // `components/NotificationBell.tsx:121` 同：部分流程只发 `status_changed(new_status=completed)` 而无 `task.completed`。
  // 10s 轮询**保留**——它管的是"进程自己死了"这类**无人发事件**的情形（见上条 M12 注）。
  const { subscribe } = useActivity();
  const loadTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = subscribe((e) => {
      const t = e.type;
      if (!(t === 'deliverable.registered' || t === 'deliverable.status_changed' || t === 'deliverable.runtime_changed'
        || t.startsWith('file.')
        || t === 'task.completed' || t === 'task.failed' || t === 'task.status_changed')) return;
      if (loadTimer.current !== undefined) return;
      // 成果增删/改名都会动名录（新项目/新产出任务进下拉），故与列表一并重取——它是一次 `DISTINCT` 小查询。
      loadTimer.current = window.setTimeout(() => { loadTimer.current = undefined; load(); void loadFacets(); void loadAttention(); }, 600);
    });
    return () => {
      if (loadTimer.current !== undefined) { window.clearTimeout(loadTimer.current); loadTimer.current = undefined; }
      unsubscribe();
    };
  }, [subscribe, load]);

  // zx_20261111_3「显」：第一行的取数（读失败带因由，页面据此说"读不到"而不是报 0 件）。
  const loadAttention = useCallback(async () => {
    try {
      const d = await invoke<{ total?: number; unverified?: number; acceptanceEnabled?: boolean }>('deliverable:attention');
      setAttention({
        total: Number(d?.total) || 0,
        unverified: Number(d?.unverified) || 0,
        acceptanceEnabled: d?.acceptanceEnabled === true,
      });
      setAttentionErr('');
    } catch (e) {
      setAttention(null);
      setAttentionErr(messageOf(e));
    }
  }, []);
  useEffect(() => { void loadAttention(); }, [loadAttention]);

  // zx_20260929 M11：失败**如实带因**——原 `catch { showToast('启动失败') }` 把主进程回的具体原因（NO_ENTRY/
  //   START_FAILED 及子进程 stderr）丢弃，与 handleRegister 不同尺。启动不了时用户看不到"为什么"。
  const handleStart = async (id: string, name: string) => { try { await invoke('deliverable:start', id); showToast(`${name} 启动成功`, 'success'); load(); } catch (e) { showToast(`启动失败: ${(e as Error).message}`, 'error'); } };
  const handleStop = async (id: string, name: string) => { try { await invoke('deliverable:stop', id); showToast(`${name} 已停止`, 'success'); load(); } catch { showToast('停止失败', 'error'); } };
  const handleDelete = async (id: string, name: string) => { if (!confirm(`确定删除「${name}」？`)) return; try { await invoke('deliverable:delete', id); showToast(`${name} 已删除`, 'success'); load(); void loadFacets(); } catch { showToast('删除失败', 'error'); } };
  const handleRegister = async (id: string, name: string) => { try { await deliverables.register(id); showToast(`${name} 已注册到ANS`, 'success'); load(); } catch (e) { showToast(`注册失败: ${(e as Error).message}`, 'error'); } };

  // zx_20260930 M3-c: 新建成果表单——项目候选取**全量项目表**（不是本页 items 派生出的那个，
  //   后者只含"已有成果的项目"，而本表单的用途恰恰是给尚无成果的项目建第一条成果）。
  const openCreate = () => {
    setCErr('');
    setShowCreate(true);
    setCForm({ projectId: filterProj || '', taskId: '', type: 'doc', name: '', description: '', filePath: '' });
    void (async () => {
      try {
        const ps = await projectsApi.list() as unknown as Array<{ id: string; name: string }>;
        setCProjects(ps);
        // 用户已选定项目筛选/或只有唯一项目时预填，省一次选择
        setCForm(f => ({ ...f, projectId: f.projectId || ps[0]?.id || '' }));
      } catch { /* 项目表取不到则下拉为空，由提交时的「请选择所属项目」兜底 */ }
    })();
  };
  // 候选任务随所选项目变——挂 taskId 使手工成果与 agent 成果同一条溯源链（可回溯产出任务）
  useEffect(() => {
    if (!showCreate || !cForm.projectId) { setCTasks([]); return; }
    let alive = true;
    void (async () => {
      try {
        // zx_20261019 实机 E2E 缺陷 D2（批五分页的连带）：`task:list` 已返回 `{ rows, total }`，
        //   不能再当数组 `map`（原写法抛 TypeError 被 catch 吞掉 ⇒ 候选任务恒为空，且不报错）。
        //   这里要的是**全项目**候选，走按页取尽的 `listAll`。
        const ts = await tasksApi.listAll(cForm.projectId) as unknown as Array<{ id: string; title?: string }>;
        if (alive) setCTasks(ts.map(t => ({ id: String(t.id), title: String(t.title || '未命名任务') })));
      } catch { if (alive) setCTasks([]); }
    })();
    return () => { alive = false; };
  }, [showCreate, cForm.projectId]);

  const submitCreate = async () => {
    const name = cForm.name.trim();
    if (!cForm.projectId) { setCErr('请选择所属项目'); return; }
    if (!name) { setCErr('请填写成果名称'); return; }
    setCBusy(true); setCErr('');
    try {
      const r = await deliverables.create(cForm.projectId, name, cForm.type,
        cForm.description.trim() || undefined, cForm.filePath.trim() || undefined, cForm.taskId || undefined);
      // main 侧按 file_path（或 task+name）去重：命中孪生件时**不新建**，如实说"已存在"，
      // 绝不把"什么都没发生"报成"已创建"（这是本页此前 deliverable:create 静默复用旧行的老毛病）。
      if (r?.deduplicated) showToast('已存在同名/同路径成果，未重复新建', 'success');
      else showToast(`成果已创建：${name}`, 'success');
      setShowCreate(false);
      load();
      // 新件可能带来新项目/新产出任务 ⇒ 名录一并重取（它不是列表的副产品，不会自己跟上）
      void loadFacets();
    } catch (e) { setCErr((e as Error).message); }
    setCBusy(false);
  };

  // 行内编辑
  const startEdit = (d: Deliverable) => { setEditingId(d.id); setEditingName(d.name); };
  const cancelEdit = () => { setEditingId(null); setEditingName(''); };
  const saveName = async (d: Deliverable) => {
    const newName = editingName.trim();
    if (!newName || newName === d.name) { cancelEdit(); return; }
    try { await deliverables.update(d.id, newName); showToast('名称已更新', 'success'); cancelEdit(); load(); } catch { showToast('更新失败', 'error'); }
  };

  // 预览
  const handlePreview = async (d: Deliverable) => {
    setPreviewErr('');
    // UI类型：用系统默认浏览器打开
    if (d.type === 'ui') {
      try {
        const r = await invoke<PreviewData>('deliverable:preview', d.id);
        const previewUrl = (r as unknown as Record<string, unknown>).preview_url as string;
        if (previewUrl) {
          // 通过 Electron shell 打开（支持 file:// 和 http(s)://）
          try { await invoke('shell:openExternal', previewUrl); } catch { window.open(previewUrl, '_blank'); }
          return;
        }
      } catch (e) { showToast(`预览失败：${messageOf(e)}`, 'error'); }
    }
    // Doc/其他类型：弹窗预览
    try {
      const r = await invoke<PreviewData>('deliverable:preview', d.id);
      const pd = r as unknown as Record<string, unknown>;
      const content = (pd.content_snapshot || pd.content || d.description || '') as string;
      const version = (pd.version as number) || 1;
      const filePath = pd.file_path as string | undefined;
      const fileExists = pd.file_exists === true;
      // zx_20260911_5 M3-4(夏克特·错误归属): 截断/回落来源随载荷抵达，界面据此如实标注
      setPreview({ id: d.id, name: d.name, type: d.type, content, version, filePath, fileExists, contentTruncated: pd.content_truncated === true, contentSource: pd.content_source as string | undefined });
    } catch (e) { setPreviewErr(messageOf(e)); setPreviewErrDeliv(d); showToast(`预览失败：${messageOf(e)}`, 'error'); }
  };

  // zx_20261110_1 B5：本地绝对路径判据覆盖盘符/UNC/POSIX（此前只认 `/`，Windows 盘符恒假）。
  //   与抽屉同源——真身在 `lib/deliverable-view.ts` 的 `isLocalAbsolutePath`。

  // 复制预览链接
  const handleCopyLink = (d: Deliverable) => {
    if (!d.file_path) { showToast('该成果未记录文件路径', 'error'); return; }
    if (d.type !== 'ui' && !isLocalPath(d.file_path)) {
      // 相对路径是「工作目录相对路径」，拼 file:// 只会得到一个打不开的假链接——如实说明。
      showToast('工作目录相对路径，无法直接打开（请用「在文件夹中显示」或复制原文路径）', 'error');
      return;
    }
    const url = d.type === 'ui' ? d.file_path : `file://${d.file_path}`;
    navigator.clipboard.writeText(url).then(() => showToast('链接已复制', 'success')).catch(() => {});
  };

  // zx_20261108_1 B6: 「打开 / 在文件夹中显示」改走 `deliverable:open`——**只递 id**，
  //   路径由 main 从库内取并过 `dataDir` + 项目工作目录围栏（渲染层手里的 file_path 只是展示值，不作授权依据）。
  //   失败时 main 已按成因分好词（越界/缺文件/是链接…），此处原样上屏，不再笼统说"打不开"。
  const handleOpen = async (id: string, mode: 'open' | 'reveal') => {
    try {
      await deliverables.open(id, mode);
    } catch (e) {
      showToast(`${mode === 'reveal' ? '无法定位' : '无法打开'}：${(e as Error).message}`, 'error');
    }
  };

  // zx_20261108_1 B6: 按**当前筛选条件**导出 CSV（服务端同一次 `queryDeliverables(all:true)` 取数）。
  //   取消不是错误；成功如实报条数与落点，失败直显 main 的拒因/写盘错误。
  const handleExportCsv = async () => {
    if (exportGate && !exportGate.unlocked) { showToast(exportGate.detail, 'error'); return; }
    setExporting(true);
    try {
      const r = await deliverables.exportCsv(buildParams(0, 0));
      if (r?.cancelled) showToast('已取消导出', 'success');
      else showToast(`已导出 ${r?.count ?? 0} 条：${r?.path ?? ''}`, 'success');
    } catch (e) {
      showToast(`导出失败：${(e as Error).message}`, 'error');
    }
    setExporting(false);
  };

  // 版本历史（zx_20260906 批3/3b: 保留 content_snapshot/changed_by——版本弹窗真实快照预览，不再剥快照占位"查看中"）
  const loadVersions = async (delivId: string) => {
    setVersionsBusy(true);
    try {
      const r = await invoke<{ versions?: Array<{ id: string; version: number; size: number; created_at: string; content_snapshot?: string; changed_by?: string }> }>('deliverable:preview', delivId);
      const vs = (r as unknown as { versions?: Array<{ id: string; version: number; size: number; created_at: string; content_snapshot?: string; changed_by?: string }> }).versions || [];
      setVersions(vs.map((v) => ({ id: v.id, version: v.version, size: v.size, created_at: v.created_at, content_snapshot: v.content_snapshot, changed_by: v.changed_by })));
      setVersionsErr('');
    } catch (e) { setVersions([]); setVersionsErr(messageOf(e)); }
    setVersionsBusy(false);
    setSelectedVersion(null);
    setDiffView(null);
  };

  // zx_20260906_1 3b: 状态/时间窗筛选 + 可排序列头（3a 质量/最近变更排序）——取代固定 项目→名称→类型 重排
  const toggleSort = (field: typeof sortBy) => { if (sortBy === field) setSortAsc(v => !v); else { setSortBy(field); setSortAsc(false); } };
  // zx_20261108_1 B6: 筛选/排序已整体下沉服务端（`core/deliverable-query.ts`），此处**不再**有第二份
  //   客户端的 filter/sort。`items` 就是"当前筛选 + 当前排序 + 当前页"的结果；页脚 `itemsTotal` 是同一
  //   WHERE 下的全量条数——两者同尺，"共 M 条"不再受"已加载多少"影响。
  // zx_20260930 M4-2: 已退休计数取**服务端** `retiredCount`（当前筛选条件下全表的已退休条数），
  //   不数 `items`（那只是当页）。
  const retiredCount = itemsRetiredCount;
  const visibleRows = items;
  // zx_20260913 M2-7: 行内项目名一律走此判据——缺失即「未知项目」，不再抛 uuid 片段给用户
  const projLabel = (d: Deliverable) => d.project_name || '未知项目';
  // zx_20260924_1 M5-b(一处真源): **两种视图、一份行渲染**——平铺表与目录树吐出的都是本序列，
  //   `<tbody>` 里只 map 一次。若各写一份行 JSX，"两页长得像但判据不同"就会从跨页复发到同页。
  //   `depth` 只影响首列左缩进（目录树表示层级；平铺恒 0，其 12px 与原来 `p-3` 的左内边距等值）。
  type RenderRow =
    | { kind: 'head'; projectId: string; label: string; n: number }
    | { kind: 'note'; key: string; text: string }
    | { kind: 'dir'; key: string; name: string; count: number; depth: number }
    | { kind: 'row'; d: Deliverable; depth: number };
  // 分组渲染序列：关=纯行数组；开=按项目首次出现顺序分块、块首插一行项目头（块内保持当前 7 列排序）
  const groupRows: RenderRow[] = (() => {
    if (!groupByProject) return visibleRows.map((d) => ({ kind: 'row' as const, d, depth: 0 }));
    const order: string[] = [];
    const byProj = new Map<string, { label: string; rows: Deliverable[] }>();
    for (const d of visibleRows) {
      const k = d.project_id || '';
      if (!byProj.has(k)) { byProj.set(k, { label: projLabel(d), rows: [] }); order.push(k); }
      byProj.get(k)!.rows.push(d);
    }
    const out: RenderRow[] = [];
    for (const k of order) {
      const g = byProj.get(k)!;
      out.push({ kind: 'head', projectId: k, label: g.label, n: g.rows.length });
      for (const d of g.rows) out.push({ kind: 'row', d, depth: 0 });
    }
    return out;
  })();
  // zx_20260924_1 M5-b: 任务下拉候选取**未过滤全集**——与项目下拉同一条教训（zx_20260911_4 M4-4）：
  //   用受筛的 items 派生，选定任务后下拉自坍缩只剩该项，用户再也切不回去。
  //   `项目级` 一组（无 task_id）单独占一项：它不是"没有任务的任务"，而是**归属本就不在任务上**。
  // zx_20260930 M4-2: 全集改由**服务端** `facets` 给（原先取 `allItems` = 无参全表）。这一改把上一条
  //   保证**加强**了：名录从"不受筛选影响"升为"不受筛选**也不受分页**影响"——分页后若还靠一份本地全集，
  //   那份全集要么被页大小截断（下拉静默缺项，E15 换个入口复发），要么首屏为两个下拉再读整表。
  const taskOptions = facetTasks.map(t => [t.id, t.title || '未知任务'] as const);
  const noTaskCount = facetNoTaskCount;
  // zx_20261108_1 B6: 是否有**任一筛选**生效（空态据此区分"库里没有"与"筛不出来"——服务端已筛，
  //   故这两句话现在是同一个集合上的两种解释，不再受"加载了几页"影响）。
  const anyFilterActive = !!(filterProj || filterType || filterStatus || appliedKeyword || filterTask || recentDays > 0 || onlyPrimary);
  // zx_20260924_1 M5-b: 目录树视图的渲染序列——**树本身由 `buildDeliverableTree` 算**（与任务详情同一份），
  //   本页只把它的结果摊成行。三条规则（剥公共前缀/无路径单列/单子目录链并段）一行都不在这里重写。
  const treeNodes: RenderRow[] = (() => {
    if (viewMode !== 'tree') return [];
    const tree = buildDeliverableTree<Deliverable>(visibleRows);
    const out: RenderRow[] = [];
    if (tree.commonPrefix.length > 0) {
      out.push({ kind: 'note', key: 'note-prefix', text: `相对根：${tree.commonPrefix.join('/')}/` });
    }
    const walk = (children: DeliverableTreeChild<Deliverable>[], depth: number, pathKey: string) => {
      for (const c of children) {
        if (c.kind === 'dir') {
          const pk = `${pathKey}/${c.name}`; // 全路径做 key，防同名目录在不同父下撞 key
          out.push({ kind: 'dir', key: `dir-${pk}`, name: c.name, count: c.count, depth });
          walk(c.children, depth + 1, pk);
        } else {
          out.push({ kind: 'row', d: c.item, depth });
        }
      }
    };
    walk(tree.root, 0, '');
    // zx_20260924_1: 无盘上路径的件**如实单列**，绝不塞进假目录（那是编造"它在哪"）
    if (tree.noPath.length > 0) {
      out.push({ kind: 'note', key: 'note-nopath', text: `（无盘上路径 · ${tree.noPath.length} 条）` });
      for (const d of tree.noPath) out.push({ kind: 'row', d, depth: 0 });
    }
    return out;
  })();
  // 当前视图要画的行序列：两者**同型**，故 `<tbody>` 只有一份 map
  const renderRows: RenderRow[] = viewMode === 'tree' ? treeNodes : groupRows;
  // zx_20260924_1 M9-d: 版本大小的展示文案（展示层换算的唯一落点，两处调用共用）
  const selVerSize = selectedVersion ? versionSizeText(selectedVersion.size, selectedVersion.content) : null;
  const openVersionDiff = (ver: number) => {
    const idx = versions.findIndex(v => v.version === ver);
    const prev = idx >= 0 ? versions[idx + 1] : undefined;
    if (!prev || !selectedVersion) return;
    setDiffView(simpleLineDiff(String(prev.content_snapshot || ''), String(selectedVersion.content)));
  };

  // zx_20261111_3「显」：第一行——事实来自 `deliverable:attention`（与列表同一 scope），优先级在 core。
  const deliverableNextAction = nextActionForDeliverables({
    loadError: attentionErr || null,
    total: attention?.total ?? null,
    unverified: attention?.unverified ?? null,
    acceptanceEnabled: attention?.acceptanceEnabled ?? null,
  });
  function handleNextAction(aid: NextActionId): void {
    if (aid === 'view_tasks') navigate('/tasks');
  }

  if (loading) return <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" /></div>;
  return (
    <div>
      {/* Toast */}
      {toast && <div className={`fixed top-4 right-4 z-50 px-4 py-2 rounded shadow-lg text-sm ${toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>{toast.msg}</div>}

      {previewErr && (
        <div className="mb-3 flex items-start gap-2">
          <div className="flex-1">
            <LoadFailure what="「成果预览」" reason={previewErr} onRetry={() => { if (previewErrDeliv) void handlePreview(previewErrDeliv); }} />
          </div>
          <button onClick={() => { setPreviewErr(''); setPreviewErrDeliv(null); }} className="p-1 hover:bg-gray-100 rounded shrink-0" title="关闭"><X className="w-4 h-4 text-gray-400" /></button>
        </div>
      )}

      {/* zx_20261111_3「显」：第一行——此刻是什么 / 凭什么 / 下一步点哪个 */}
      <div className="mb-3"><NextActionBar action={deliverableNextAction} onAction={handleNextAction} /></div>

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">产出物管理</h2>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="搜名称/描述/类型/路径（跨项目）"
              className="pl-8 pr-2 py-1.5 border rounded-lg text-sm bg-white w-52 placeholder:text-gray-300" />
          </div>
          <select value={filterProj} onChange={e => setFilterProj(e.target.value)} className="px-2 py-1.5 border rounded-lg text-sm bg-white">
            <option value="">全部项目</option>
            {projects.map(([id, name]) => <option key={id} value={id} title={id}>{name}</option>)}
          </select>
          {/* 下拉文案同取共享词表（用户可见文案也是词表，不另抄一份）——此处只定呈现次序 */}
          <select value={filterType} onChange={e => setFilterType(e.target.value)} className="px-2 py-1.5 border rounded-lg text-sm bg-white">
            <option value="">全部类型</option>
            {(['daemon','mcp','a2a','ui','doc','code'] as const).map((t) => <option key={t} value={t}>{DELIVERABLE_TYPE_LABEL[t]}</option>)}
          </select>
          {/* zx_20260906_1 3b: 状态筛选（含 retired 细分，直接选即可切回查看） */}
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="px-2 py-1.5 border rounded-lg text-sm bg-white">
            <option value="">全部状态</option>
            {(['draft','running','registered','stopped','completed','failed','stale','retired'] as const).map((s) => <option key={s} value={s}>{DELIVERABLE_STATUS_LABEL[s]}</option>)}
          </select>
          {/* zx_20260906_1 3b: 时间窗筛选（按创建时间） */}
          <select value={String(recentDays)} onChange={e => setRecentDays(Number(e.target.value))} className="px-2 py-1.5 border rounded-lg text-sm bg-white">
            <option value="0">全部时间</option>
            <option value="7">近7天</option>
            <option value="30">近30天</option>
          </select>
          {/* zx_20260906 批3 (3e): 已退休产出物切换（默认过滤，计数透出提示不丢） */}
          {retiredCount > 0 && (
            <button onClick={() => setShowRetired(v => !v)} title="已退休产出物（重试后旧成果 soft-retired，默认隐藏）"
              className={`text-xs px-2 py-1.5 rounded-lg border ${showRetired ? 'bg-gray-200 text-gray-700 border-gray-300' : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100'}`}>
              {showRetired ? '隐藏已退休' : `已退休 ${retiredCount} 项`}
            </button>
          )}
          {/* zx_20260924_1 M5-b(E-5): 产出任务筛选——「项目级」（task_id IS NULL）也是一个可选项，不是"没有任务" */}
          <select value={filterTask} onChange={e => setFilterTask(e.target.value)} className="px-2 py-1.5 border rounded-lg text-sm bg-white max-w-[190px]"
            title="按产出任务筛选（项目级 = 未挂到任何任务上的成果，如手工新建）">
            <option value="">全部任务</option>
            <option value={TASK_NONE}>项目级（无产出任务{noTaskCount > 0 ? ` · ${noTaskCount}` : ''}）</option>
            {taskOptions.map(([id, title]) => <option key={id} value={id} title={id}>{title}</option>)}
          </select>
          {/* zx_20260924_1 M5-b: 「仅显示主成果」——★ 互斥谓词（M5-a 已收敛到一处），本筛只读 is_primary 列 */}
          <button onClick={() => setOnlyPrimary(v => !v)} title="只显示标记为 ★ 主要成果的产出物"
            className={`text-xs px-2 py-1.5 rounded-lg border ${onlyPrimary ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100'}`}>
            {onlyPrimary ? '★ 仅主成果' : '仅显示主成果'}
          </button>
          {/* zx_20260924_1 M5-b(E-5): 目录树/平铺切换——树与任务详情同源（buildDeliverableTree） */}
          <button onClick={() => setViewMode(v => (v === 'tree' ? 'flat' : 'tree'))}
            title={viewMode === 'tree' ? '当前是目录树（与任务详情同一份实现）——点击切回平铺表' : '点击切到目录树（与任务详情同一份实现）'}
            className={`text-xs px-2 py-1.5 rounded-lg border ${viewMode === 'tree' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100'}`}>
            {viewMode === 'tree' ? '目录树' : '平铺表'}
          </button>
          {/* zx_20260913 M2-7: 按项目分组的开关（默认开）——关掉即回到跨项目的 7 列排序。
              zx_20260924_1 M5-b: 仅平铺表可见——目录树自带层级，再叠一层项目分组只会两套层级打架。 */}
          {viewMode === 'flat' && (
            <button onClick={() => setGroupByProject(v => !v)} title={groupByProject ? '当前按项目分组（点击关闭，回到全表排序）' : '点击按项目分组查看'}
              className={`text-xs px-2 py-1.5 rounded-lg border ${groupByProject ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100'}`}>
              {groupByProject ? '已按项目分组' : '按项目分组'}
            </button>
          )}
          {/* zx_20260930 M3-c: 新建成果——此前成果只能由 agent 工具产出，人在 GUI 上"在册不能立项" */}
          <button onClick={openCreate} title="手工新建成果（与 agent 的 create_deliverable 同一落库口径）"
            className="flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700">
            <Plus className="w-3.5 h-3.5" />新建成果
          </button>
          {/* zx_20261108_1 B6: 按当前筛选导出 CSV（Pro 能力 `deliverable_export`）。
              `exportGate` 只用于**先禁用**并提前给出拒因；真正的闸在 main（`deliverable:exportCsv`）。
              读不到裁定（`null`）时不禁用——不因读档失败把功能藏掉。 */}
          <button onClick={handleExportCsv} disabled={exporting || exportGate?.unlocked === false}
            title={exportGate ? exportGate.detail : '按当前筛选条件导出 CSV（需专业版）'}
            className={`flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg border ${exportGate?.unlocked === false ? 'bg-gray-50 text-gray-400 border-gray-200 cursor-not-allowed' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'} disabled:opacity-60`}>
            <Download className="w-3.5 h-3.5" />{exporting ? '导出中…' : '导出 CSV'}
          </button>
          <button onClick={load} className="p-2 hover:bg-gray-100 rounded-lg"><RefreshCw className="w-4 h-4" /></button>
        </div>
      </div>

      {/* zx_20261110_1 B5：读失败 ≠ 没有——列表/「加载更多」/筛选名录各自带因由与重试 */}
      {facetsErr && <div className="mb-3"><LoadFailure what="「筛选名录」" reason={facetsErr} onRetry={() => void loadFacets()} /></div>}
      {listErr && <div className="mb-3"><LoadFailure what="「产出物列表」" reason={listErr} onRetry={() => void (items.length > 0 ? loadMoreItems() : load())} busy={moreBusy} /></div>}

      {items.length === 0 ? (
        listErr ? null : (
        <div className="bg-white rounded-lg border p-12 text-center text-gray-400">
          <Package className="w-12 h-12 mx-auto mb-3 opacity-30" />
          {/* zx_20261108_1 B6: 服务端已按当前筛选算过全量（`total === 0`），故这里两句话是**同一个集合**
              的两种解释：「库里没有」vs「筛不出来」。已退休提示同尺（`retiredCount` 来自同一 WHERE）。 */}
          <p className="text-lg mb-2">
            {anyFilterActive ? '无匹配产出物' : retiredCount > 0 ? '当前产出物均已退休' : '暂无产出物'}
          </p>
          {anyFilterActive
            ? <p className="text-xs text-gray-300">当前筛选条件下没有结果——试试清空搜索 / 项目 / 类型 / 状态 / 时间 / 任务 / 主成果筛选</p>
            : retiredCount > 0
              ? <p className="text-xs text-gray-300">全部 {retiredCount} 项产出物均已退休（重试后旧成果）。点击右上角「已退休 {retiredCount} 项」查看。</p>
              : null}
        </div>
        )
      ) : (
        <div className="bg-white rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                {([['name','名称'],['project','所属项目'],['type','类型'],['status','状态'],['quality','质量'],['size','大小'],['updated','最近变更'],['created','创建时间']] as Array<[typeof sortBy,string]>).map(([f,label], idx) => (
                  <th key={f} className={`text-left p-3 font-medium ${f==='created'?'hidden md:table-cell':''} ${idx===7?'text-xs text-gray-400':''}`}>
                    <button type="button" onClick={() => toggleSort(f)} title={`按${label}排序`}
                      className={`uppercase tracking-wide ${f==='created'?'hidden md:table-cell':''} inline-flex items-center gap-1 hover:text-gray-700 ${sortBy===f?'text-blue-600':''}`}>
                      {label}<span className="text-[9px]">{sortBy===f?(sortAsc?'▲':'▼'):'⇅'}</span>
                    </button>
                  </th>
                ))}
                <th className="text-right p-3 font-medium text-gray-500">操作</th>
              </tr>
            </thead>
            <tbody>
              {/* zx_20261108_1 B6: 原先的"本页无匹配 / 全表无匹配"两句话已无意义——筛选在服务端完成，
                  `items.length === 0` 时走的是上面的整块空态；此处不再有"已加载行里筛空"的分支。 */}
              {renderRows.map((g, gi) => {
                // zx_20260924_1 M5-b: 目录树的两种非成果行——说明行 / 目录行（目录自带后代件数，点开前先看得见分量）
                if (g.kind === 'note') return (
                  <tr key={g.key} className="border-t bg-gray-50/60">
                    <td colSpan={9} className="px-3 py-1.5 text-xs text-gray-400">{g.text}</td>
                  </tr>
                );
                if (g.kind === 'dir') return (
                  <tr key={g.key} className="border-t bg-gray-50/80">
                    <td colSpan={9} className="px-3 py-1.5 text-xs font-medium text-gray-500" style={{ paddingLeft: `${16 + g.depth * 14}px` }}>
                      <FolderOpen className="w-3 h-3 inline mr-1 text-gray-400" />{g.name} <span className="text-gray-400">· {g.count} 件</span>
                    </td>
                  </tr>
                );
                // zx_20260913 M2-7: 分组头行——项目名 + 该项目当前可见成果数（计数与本表所见同源，非另查一遍）
                if (g.kind === 'head') return (
                  <tr key={`head-${g.projectId}-${gi}`} className="border-t bg-gray-50/80">
                    <td colSpan={9} className="px-3 py-1.5 text-xs font-medium text-gray-500" title={g.projectId || undefined}>
                      {g.label} <span className="text-gray-400">· {g.n} 项</span>
                    </td>
                  </tr>
                );
                const d = g.d;
                const depth = g.depth;
                const rt = runtime.get(d.id);
                const isRunning = rt?.running;
                const isServiceType = ['mcp', 'a2a', 'daemon'].includes(d.type);
                const isRetired = d.status === 'retired';
                // zx_20260907 M2(B2): 产出任务已验收(acceptance_check 存在)→行内徽标「✓ 已验收 p/t」；未核(无 acceptance)不显
                // zx_20260913 M2-6: 判据由手抄 `type === 'doc'` 换成共享 isAcceptanceType（doc/code）
                const acc = isAcceptanceType(d.type) && d.acceptance?.checked_at ? d.acceptance : null;
                const accP = Number(acc?.passed_total) || 0;
                const accT = Number(acc?.criteria_total) || 0;
                const accAllPass = accT > 0 && accP >= accT;
                // zx_20260915 P0-2(e)(维特根斯坦·意义即用法): 「任务完成 + 95 分」与「其实没验过」此前在本页
                // 长得一样——`acc` 只在**已核验**时才有值，未核验者整行不显任何验收信息。未核验的任务级
                // 结论由 main 侧 `annotateAcceptance` 随行下发 `task_acceptance`，此处按**成因**如实显示
                // (不新造第四态：「未通过 p/t」那一态仍由上面的 acc 徽标负责)。
                const ta = !acc ? d.task_acceptance : null;
                const taHint = ta
                  ? (ta.reason === 'no_criteria' ? '未设验收标准（未验收）'
                    // zx_20260916 M1: 引擎代拟与"没人许诺"**不同名**，且都**不打 ✓**（代拟 ≠ 许诺）
                    : ta.reason === 'no_user_criteria' ? `引擎代拟 ${ta.proposed?.length ?? 0} 条（未验收）`
                    : `未核验（${ACCEPTANCE_REASON_LABEL[ta.reason ?? ''] ?? ta.reason ?? '原因未知'}）`)
                  : null;
                // 抽屉关时不落死区：回落跳该成果的产出任务（与交付单行内点跳同尺）
                return (
                  <tr key={d.id} onClick={() => { if (drawerOn) openDeliv(d.id); else if (d.task_id) navigate(`/tasks/${d.task_id}`); }}
                    className={`border-t hover:bg-gray-50 ${drawerOn || d.task_id ? 'cursor-pointer' : ''} ${isRetired ? 'opacity-60 bg-gray-50' : ''}`}>
                    {/* 目录树里层级只在首列左缩进上体现（12px = 平铺时 p-3 的左内边距，故平铺视图零变化） */}
                    <td className="p-3" style={{ paddingLeft: `${12 + depth * 14}px` }}>
                      {editingId === d.id ? (
                        <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                          <input className="border rounded px-2 py-0.5 text-sm w-48" value={editingName} onChange={e => setEditingName(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') saveName(d); if (e.key === 'Escape') cancelEdit(); }} autoFocus />
                          <button onClick={() => saveName(d)} className="p-0.5 hover:bg-green-50 rounded"><Check className="w-3.5 h-3.5 text-green-600" /></button>
                          <button onClick={cancelEdit} className="p-0.5 hover:bg-red-50 rounded"><X className="w-3.5 h-3.5 text-red-500" /></button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 group flex-wrap">
                          <span className="font-medium">{d.name}</span>
                          {primaryEnabled && (
                            <button onClick={(e) => { e.stopPropagation(); handleTogglePrimary(d); }} title={d.is_primary === 1 ? '主要成果（点击取消）' : '标记为主要成果'}
                              className={`p-0.5 rounded hover:bg-amber-50 ${d.is_primary === 1 ? '' : 'opacity-0 group-hover:opacity-100'}`}>
                              <Star className={`w-3.5 h-3.5 ${d.is_primary === 1 ? 'text-amber-500 fill-amber-400' : 'text-gray-300'}`} />
                            </button>
                          )}
                          <button onClick={(e) => { e.stopPropagation(); startEdit(d); }} className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-gray-100 rounded" title="修改名称"><Pencil className="w-3 h-3 text-gray-400" /></button>
                          {/* zx_20260914 M2-4(D2: 列表行 + 抽屉两处): 验收入口——仅开关开、类型可验收、尚未带验收、非退休时出。
                              与抽屉同判据、同失败说明(ACCEPT_REASON_TEXT 一处映射)。 */}
                          {acceptEnabled && !acc && !isRetired && isAcceptanceType(d.type) && (
                            <button onClick={(e) => { e.stopPropagation(); handleAccept(d); }} title="标为已验收（落该成果所属任务已有的验收结论）"
                              className="opacity-0 group-hover:opacity-100 text-[10px] px-1.5 py-0.5 rounded border border-green-200 text-green-700 hover:bg-green-50">
                              标为已验收
                            </button>
                          )}
                          {acc && (
                            <span title={`产出任务验收 ${accP}/${accT} 项通过${acc.checked_at ? ' · 核验于 ' + formatDbTime(acc.checked_at) : ''}`}
                              className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${accAllPass ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                              {accAllPass ? '✓ 已验收' : '验收未全过'}{' '}{accP}/{accT}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    {/* zx_20260906 批3 (3b): 产出物↔任务溯源跳转——JOIN 回传 task_title/task_id，可直达产出任务 */}
                    <td className="p-3 text-xs text-gray-500">
                      <div className="flex flex-col gap-0.5">
                        <span title={d.project_id || undefined}>{projLabel(d)}</span>
                        {d.task_id && (
                          <button type="button" onClick={(e) => { e.stopPropagation(); navigate(`/tasks/${d.task_id}`); }} title={`打开产出任务：${d.task_title || d.task_id}`}
                            className="text-left text-[10px] text-blue-500 hover:text-blue-700 hover:underline truncate max-w-[200px]">
                            ↳ 产出任务：{d.task_title || '未知任务'}
                          </button>
                        )}
                        {/* zx_20260913 M2-2(巴特莱特·重构 / D1 裁定): 归属只认首次写出者；后写者之痕如实透出——
                            由 wa_deliverable_versions.changed_by 派生(「这条成果还有谁写过」)，而非夺走归属。 */}
                        {!!d.other_writers?.length && (
                          <span className="text-[10px] text-gray-400 truncate max-w-[200px]"
                            title={d.other_writers.map(w => `${w.title}（${w.id}）`).join('\n')}>
                            另有 {d.other_writers.map(w => w.title).join('、')} 写过
                          </span>
                        )}
                        {/* zx_20260906_1 3a: 产出任务状态 chip——区分 任务已完成但成果 retired/进行中/失败 等溯源语义 */}
                        {d.task_id && d.task_status && (
                          <span title="产出任务当前状态" className={`text-[9px] px-1 rounded shrink-0 ${d.task_status === 'completed' ? 'bg-green-50 text-green-600' : d.task_status === 'running' || d.task_status === 'executing' ? 'bg-blue-50 text-blue-500' : d.task_status === 'paused' ? 'bg-amber-50 text-amber-600' : d.task_status === 'failed' ? 'bg-red-50 text-red-500' : 'bg-gray-100 text-gray-500'}`}>
                            {d.task_status === 'completed' ? '任务完成' : d.task_status === 'running' || d.task_status === 'executing' ? '任务进行中' : d.task_status === 'paused' ? '任务已暂停' : d.task_status === 'failed' ? '任务失败' : d.task_status === 'pending' || d.task_status === 'planning' || d.task_status === 'preparing' ? '任务待执行' : d.task_status}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-3"><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TYPE_COLORS[d.type] || 'bg-gray-100'}`}>{DELIVERABLE_TYPE_LABEL[d.type] || d.type}</span></td>
                    <td className="p-3">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_CLS[d.status] || (d.status === 'registered' ? 'bg-blue-100 text-blue-700' : d.status === 'running' ? 'bg-green-100 text-green-700' : d.status === 'failed' ? 'bg-red-100 text-red-600' : d.status === 'stopped' ? 'bg-orange-100 text-orange-600' : d.status === 'stale' ? 'bg-yellow-100 text-yellow-600' : 'bg-gray-100')}`}>
                          {DELIVERABLE_STATUS_LABEL[d.status] || d.status}
                        </span>
                        {isServiceType && (d.status === 'registered' || d.status === 'running') && (
                          <span className={`w-2 h-2 rounded-full ${isRunning ? 'bg-green-500 animate-pulse' : 'bg-red-400'}`} title={isRunning ? `运行中${rt?.port ? ' :' + rt.port : ''}` : '已停止'} />
                        )}
                      </div>
                    </td>
                    {/* zx_20260906_1 3a: 质量列(产出任务质量分，JOIN 回传)+ 最近变更列(updated_at，内容/状态变更即 bump) */}
                    <td className="p-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {d.task_quality_score != null ? (
                          <span title="产出任务质量分" className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${d.task_quality_score >= 80 ? 'bg-green-100 text-green-700' : d.task_quality_score >= 60 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-600'}`}>{d.task_quality_score}分</span>
                        ) : <span className="text-xs text-gray-300">-</span>}
                        {/* zx_20260915 P0-2(e): 质量分旁如实标出"验收到底有没有"——分数高 ≠ 验过 */}
                        {taHint && (
                          <span title={`产出任务的验收结论：${taHint}——「任务完成/高分」不等于「已验收」，点开该成果或产出任务可见成因`}
                            className="text-[9px] px-1.5 py-0.5 rounded-full font-medium shrink-0 bg-amber-100 text-amber-700">{taHint}</span>
                        )}
                      </div>
                    </td>
                    {/* zx_20260924_1 M5-b(管子·度量衡): 大小列——盘上**真实字节**（main 侧按 file_path 现场 stat），
                        不是库里的数（本表根本没有 size 列，见 database.ts 该表注记）；取不到即 `—`——
                        "不知道大小"不印成 0，也不印成 `-` 那种与"就是 0 字节"混同的空占位。 */}
                    <td className="p-3 text-xs text-gray-500 whitespace-nowrap"
                      title={d.file_path ? `盘上真实字节（现场 stat）：${d.file_path}` : '无盘上路径——无从取得大小'}>
                      {formatBytes(d.size_bytes)}
                    </td>
                    <td className="p-3 text-xs text-gray-400" title="最近内容/状态变更时间">{formatDbTime(d.updated_at || d.created_at) || '-'}</td>
                    <td className="p-3 text-xs text-gray-400 hidden md:table-cell">{formatDbTime(d.created_at) || '-'}</td>
                    <td className="p-3">
                      {/* zx_20260911_5 M3-1: 操作列整体吞掉冒泡——按钮不误触行级"开抽屉" */}
                      <div className="flex items-center gap-1 justify-end" onClick={e => e.stopPropagation()}>
                        {/* 启停：仅服务类型。zx_20260929 M11：**draft 亦可启动**——此前条件带 `d.status !== 'draft'`，
                            而服务型成果（a2a/mcp/daemon）**无论谁建都是 draft**（agent 建：write.ts 的
                            create_deliverable/register_deliverable 都 INSERT 'draft'；GUI 建：deliverable:create 同），
                            且**没有任何生产者**把非 doc 类型推出 draft（deliverable-lifecycle 只转 type='doc'、
                            deliverable:update 只收 name/description、deliverable:accept 只置 acceptance_verified）
                            ⇒ 启动钮根本渲染不出来，agent 建的服务成果在 GUI 里**永远无法上路**（「在册，不在路」）。
                            「启动」本身就是从 draft 上路的那个动作；起不来时 deliverable:start 自带 NO_ENTRY
                            守卫会如实报错 ⇒ 放开不会产生假成功。 */}
                        {isServiceType && (
                          isRunning
                            ? <button onClick={() => handleStop(d.id, d.name)} className="p-1 hover:bg-red-50 rounded" title="停止"><Square className="w-3.5 h-3.5 text-red-500" /></button>
                            : <button onClick={() => handleStart(d.id, d.name)} className="p-1 hover:bg-green-50 rounded" title="启动"><Play className="w-3.5 h-3.5 text-green-600" /></button>
                        )}
                        {/* 版本历史：门禁＝**真有版本行**（version_count>0），不按 type 猜——
                            zx_20260913 M2-6(维特根斯坦·名实相符): 旧判据 `type==='doc'` 对无版本的 doc 也亮钮 ⇒
                            点开只见"暂无版本记录"；而对有版本行的 code 却不亮。名实相符者是**版本行数**本身。 */}
                        {Number(d.version_count) > 0 && (
                          <button onClick={() => { setVersionDelivId(d.id); setVersionName(d.name); setShowVersions(true); loadVersions(d.id); }} className="p-1 hover:bg-blue-50 rounded" title={`版本历史（${d.version_count} 版）`}><History className="w-3.5 h-3.5 text-blue-500" /></button>
                        )}
                        {/* 预览：UI/doc类型 */}
                        {d.type === 'ui' && (
                          <button onClick={() => handlePreview(d)} className="p-1 hover:bg-blue-50 rounded" title="在浏览器打开"><ExternalLink className="w-3.5 h-3.5 text-blue-500" /></button>
                        )}
                        {/* zx_20260911_5 M3-2(同一规则): code 与 doc 同门——此前 TYPE_LABELS 有 code 却无预览入口
                            zx_20260913 M2-6: 判据收敛到共享 isPreviewType（与 TaskDetailPage 同一份代码） */}
                        {isPreviewType(d.type) && (
                          <button onClick={() => handlePreview(d)} className="p-1 hover:bg-blue-50 rounded" title="预览"><Eye className="w-3.5 h-3.5 text-blue-500" /></button>
                        )}
                        {d.type === 'ui' && d.file_path && (
                          <button onClick={() => handleCopyLink(d)} className="p-1 hover:bg-gray-50 rounded" title="复制链接"><Copy className="w-3.5 h-3.5 text-gray-400" /></button>
                        )}
                        {/* zx_20261108_1 B6: 打开 / 在文件夹中显示——**只递 id**，路径围栏在 main
                            （`core/deliverable-path.ts`：dataDir + 项目工作目录，`..` 与链接越界拒）。
                            「打开」用系统默认程序，服务型成果（mcp/a2a/daemon）不适用——那是脚本不是文档。 */}
                        {d.file_path && !isServiceType && d.type !== 'ui' && (
                          <button onClick={() => handleOpen(d.id, 'open')} className="p-1 hover:bg-gray-50 rounded" title="用系统默认程序打开"><ExternalLink className="w-3.5 h-3.5 text-gray-400" /></button>
                        )}
                        {d.file_path && (
                          <button onClick={() => handleOpen(d.id, 'reveal')} className="p-1 hover:bg-gray-50 rounded" title="在文件夹中显示"><FolderOpen className="w-3.5 h-3.5 text-gray-400" /></button>
                        )}
                        {/* 运行时端口/端点信息 */}
                        {rt?.endpoint && <span className="text-[10px] text-gray-400 truncate max-w-[100px]">{rt.endpoint}</span>}
                        {/* 手动注册到ANS：mcp/a2a 且未注册 */}
                        {['mcp', 'a2a'].includes(d.type) && d.status !== 'registered' && d.status !== 'running' && (
                          <button onClick={() => handleRegister(d.id, d.name)} className="p-1 hover:bg-blue-50 rounded" title="注册到ANS"><Upload className="w-3.5 h-3.5 text-blue-500" /></button>
                        )}
                        {/* 删除 */}
                        <button onClick={() => handleDelete(d.id, d.name)} className="p-1 hover:bg-red-50 rounded" title="删除"><Trash2 className="w-3.5 h-3.5 text-red-400" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {/* zx_20260930 M4-2: 分页页脚——「已加载 K / 共 M」+「加载更多」。
              `M` 取**服务端**总数（与当页明细同集合、同范围真源），**不是**当页长度：本轮的靶心就是
              "计数与明细两个口径"（同上一条 M4-3）。
              zx_20261108_1 B6: 筛选/排序已下沉服务端 ⇒ 不再需要"筛选仅覆盖已加载行"的免责声明——
              `total` 就是"当前筛选条件下的全量"，翻页只影响**已取到多少条**。 */}
          <div className="flex items-center justify-between gap-3 border-t px-3 py-2 bg-gray-50/60 text-xs text-gray-500">
            <span>已加载 {items.length} / 共 {itemsTotal} 条（当前筛选）</span>
            <div className="flex items-center gap-2">
              {!itemsExhausted && (
                <>
                  <span className="text-gray-400">另有 {Math.max(itemsTotal - items.length, 0)} 条未加载</span>
                  <button onClick={loadMoreItems} disabled={moreBusy}
                    title="取下一页（按已列出的条数作偏移，同一条不会重复列出）"
                    className="px-2 py-1 rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                    {moreBusy ? '加载中…' : '加载更多'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* zx_20260930 M3-c: 新建成果弹窗——类型下拉取共享词表（用户可见文案也是词表）；
          服务类型选择时给出"须是服务入口"的提示，真正的拦截在 main 侧 createDeliverable（一处真源），
          此处只把同一个理由**提前**说给用户听，不另写一套判据。 */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => !cBusy && setShowCreate(false)}>
          <div className="bg-white rounded-xl shadow-lg max-w-lg w-full p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-lg">新建成果</h3>
              <button onClick={() => setShowCreate(false)} disabled={cBusy} className="p-1 hover:bg-gray-100 rounded disabled:opacity-40"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3 text-sm">
              <div>
                <label className="block text-xs text-gray-500 mb-1">所属项目 *</label>
                <select value={cForm.projectId} onChange={e => setCForm(f => ({ ...f, projectId: e.target.value, taskId: '' }))}
                  className="w-full px-2 py-1.5 border rounded-lg bg-white">
                  <option value="">请选择项目</option>
                  {cProjects.map(p => <option key={p.id} value={p.id} title={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">产出任务（可选 · 挂上可回溯）</label>
                <select value={cForm.taskId} onChange={e => setCForm(f => ({ ...f, taskId: e.target.value }))}
                  disabled={!cForm.projectId} className="w-full px-2 py-1.5 border rounded-lg bg-white disabled:bg-gray-50">
                  <option value="">项目级（不挂任务）</option>
                  {cTasks.map(t => <option key={t.id} value={t.id} title={t.id}>{t.title}</option>)}
                </select>
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs text-gray-500 mb-1">名称 *</label>
                  <input value={cForm.name} onChange={e => setCForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="如：数据抓取脚本" className="w-full px-2 py-1.5 border rounded-lg" />
                </div>
                <div className="w-40">
                  <label className="block text-xs text-gray-500 mb-1">类型</label>
                  <select value={cForm.type} onChange={e => setCForm(f => ({ ...f, type: e.target.value }))}
                    className="w-full px-2 py-1.5 border rounded-lg bg-white">
                    {(['doc','code','mcp','a2a','daemon','ui'] as const).map(t => <option key={t} value={t}>{DELIVERABLE_TYPE_LABEL[t] || t}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">盘上路径（可选 · 相对项目工作目录或绝对路径）</label>
                <input value={cForm.filePath} onChange={e => setCForm(f => ({ ...f, filePath: e.target.value }))}
                  placeholder="如：src/fetch.py" className="w-full px-2 py-1.5 border rounded-lg font-mono text-xs" />
                <p className="text-[11px] text-gray-400 mt-1">
                  路径不存在则**不挂文件**（成果照建，只是暂无可预览的内容）；同路径已有成果时不会重复新建。
                  {['mcp','a2a','daemon','ui'].includes(cForm.type) && ' 服务类型只用于服务入口（如 xxx_server.py）；文档(.md/.txt)与 tools/modules/lib/plugins 下的工具模块请用「文档」或「代码」类型。'}
                </p>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">描述（可选）</label>
                <textarea value={cForm.description} onChange={e => setCForm(f => ({ ...f, description: e.target.value }))}
                  rows={2} className="w-full px-2 py-1.5 border rounded-lg resize-none" />
              </div>
              {cErr && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded px-2 py-1.5">{cErr}</p>}
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowCreate(false)} disabled={cBusy} className="px-3 py-1.5 border rounded-lg text-sm hover:bg-gray-50 disabled:opacity-40">取消</button>
              <button onClick={submitCreate} disabled={cBusy} className="px-4 py-1.5 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
                {cBusy ? '创建中…' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 版本历史弹窗（zx_20260906 批3/3b: 真实 content_snapshot 快照预览 + created_at/size/changed_by + 与上一版简化 diff，去"查看中"占位） */}
      {showVersions && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => { setShowVersions(false); setSelectedVersion(null); setDiffView(null); }}>
          <div className="bg-white rounded-xl shadow-lg max-w-2xl w-full max-h-[80vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-lg">版本历史 · {versionName}</h3>
              <button onClick={() => { setShowVersions(false); setSelectedVersion(null); setDiffView(null); }} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
            </div>
            {diffView ? (
              <div>
                <p className="text-sm text-gray-500 mb-2">版本 {selectedVersion?.version} vs 上一版 · 简化前后对比（绿色新增 / 红色删除）</p>
                <div className="text-xs font-mono bg-gray-50 p-3 rounded border max-h-[500px] overflow-auto">
                  {diffView.length === 0 ? <span className="text-gray-400">两版内容一致</span> : diffView.map((l, i) => (
                    <div key={i} className={`whitespace-pre-wrap ${l.type === 'add' ? 'bg-green-50 text-green-700' : l.type === 'del' ? 'bg-red-50 text-red-600' : 'text-gray-600'}`}>
                      <span className="w-4 inline-block text-gray-400 select-none">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>{l.line || ' '}
                    </div>
                  ))}
                </div>
                <div className="flex gap-2 mt-3">
                  <button onClick={() => setDiffView(null)} className="px-3 py-1 border rounded text-sm hover:bg-gray-50">返回快照</button>
                  <button onClick={() => setSelectedVersion(null)} className="px-3 py-1 border rounded text-sm hover:bg-gray-50">返回版本列表</button>
                </div>
              </div>
            ) : selectedVersion ? (
              <div>
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <p className="text-sm text-gray-500">版本 {selectedVersion.version} 快照</p>
                  {selectedVersion.created_at && <span className="text-xs text-gray-400">{formatDbTime(selectedVersion.created_at)}</span>}
                  {/* zx_20260924_1 M9-d(V-9(b)): 此前把库里的**字符数**当字节除 1024 印成 KB。现由共享的 versionSizeText 换算（本页与抽屉同源）。 */}
                  {selVerSize && <span className="text-xs text-gray-400" title={selVerSize.title}>{selVerSize.text}</span>}
                  {selectedVersion.changed_by && <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">由 {selectedVersion.changed_by}</span>}
                  {versions.length > 1 && <button onClick={() => openVersionDiff(selectedVersion.version)} className="ml-auto text-xs px-2 py-1 rounded border hover:bg-gray-50" title="对比上一版快照">与上一版对比</button>}
                </div>
                {selectedVersion.content ? (
                  <div className="text-xs bg-gray-50 p-3 rounded border max-h-[480px] overflow-auto">
                    <MarkdownSubset source={selectedVersion.content} />
                  </div>
                ) : (
                  <div className="text-center text-gray-400 py-8 text-sm bg-gray-50 rounded border">(该版本无内容快照)</div>
                )}
                <div className="flex gap-2 mt-3">
                  <button onClick={() => setSelectedVersion(null)} className="px-3 py-1 border rounded text-sm hover:bg-gray-50">返回列表</button>
                </div>
              </div>
            ) : versionsErr ? (
              <LoadFailure what="「版本历史」" reason={versionsErr} onRetry={() => void loadVersions(versionDelivId)} busy={versionsBusy} />
            ) : versions.length > 0 ? (
              <div className="space-y-2">
                {versions.map(v => {
                  // zx_20260924_1 M9-d: 每行有快照正文即实算 UTF-8 字节；无正文则如实标"字符数"（换算只在 lib/deliverable-view 的 versionSizeText 一处）
                  const vs = versionSizeText(v.size, v.content_snapshot);
                  return (
                    <div key={v.id} className="flex justify-between items-center p-2 hover:bg-gray-50 rounded border cursor-pointer"
                      onClick={() => { setDiffView(null); setSelectedVersion({ content: String(v.content_snapshot || ''), version: v.version, created_at: v.created_at, size: v.size, changed_by: v.changed_by }); }}>
                      <span className="font-mono text-sm">v{v.version}</span>
                      <span className="text-xs text-gray-500 shrink-0 ml-3" title={vs.title}>{v.changed_by ? `由 ${v.changed_by} · ` : ''}{vs.text}</span>
                      <span className="text-xs text-gray-400 shrink-0">{formatDbTime(v.created_at)}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-gray-500 py-4 text-center">暂无版本记录</p>
            )}
          </div>
        </div>
      )}

      {/* 预览弹窗 */}
      {preview && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setPreview(null)}>
          <div className="bg-white rounded-xl shadow-lg w-full max-w-5xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b">
              <div>
                <h3 className="font-bold">{preview.name} <span className="text-xs text-gray-400 ml-2">v{preview.version} · {DELIVERABLE_TYPE_LABEL[preview.type] || preview.type}</span></h3>
                {preview.filePath && <p className="text-xs text-gray-400 font-mono mt-0.5 truncate max-w-lg">{preview.filePath}</p>}
              </div>
              <div className="flex items-center gap-2">
                {preview.filePath && <button onClick={() => { navigator.clipboard.writeText(preview.filePath || ''); showToast('路径已复制', 'success'); }} className="p-1 hover:bg-gray-100 rounded" title="复制路径"><Copy className="w-4 h-4 text-gray-400" /></button>}
                {isLocalPath(preview.filePath) && <button onClick={() => handleOpen(preview.id, 'reveal')} className="p-1 hover:bg-gray-100 rounded" title="在文件夹中显示"><FolderOpen className="w-4 h-4 text-gray-400" /></button>}
                {preview.type === 'ui' && preview.filePath && <button onClick={async () => { try { await invoke('shell:openExternal', preview.filePath || ''); } catch {} }} className="p-1 hover:bg-blue-100 rounded" title="在浏览器中打开"><ExternalLink className="w-4 h-4 text-blue-500" /></button>}
                <button onClick={() => setPreview(null)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {/* zx_20260906_1 3d: 溯源诚实——磁盘文件缺失时快照为"历史版本"，显式标注不再静默冒充当前版 */}
              {preview.fileExists === false && isPreviewType(preview.type) && preview.contentSource === 'snapshot' && (
                <div className="mb-3 px-3 py-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-700">
                  磁盘文件已缺失/被移动——当前展示的是{preview.version>1?`版本历史快照 v${preview.version}`:'既有快照'}，非实时文件内容。
                  {preview.filePath && <span className="font-mono block mt-1 truncate">{preview.filePath}</span>}
                </div>
              )}
              {/* zx_20260911_5 M3-4(夏克特·错误归属): 截断/以描述代之——如实标注，不再静默冒充全文 */}
              {preview.contentTruncated && (
                <div className="mb-3 px-3 py-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-700">
                  文件较大——以下仅为开头 100KB 的内容，非全文。
                </div>
              )}
              {preview.contentSource === 'description' && (
                <div className="mb-3 px-3 py-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-700">
                  未取到文件内容（文件缺失或非文本）——以下为成果描述，非文件正文。
                </div>
              )}
              {preview.content ? (
                <div className="text-sm text-gray-700">
                  <MarkdownSubset source={preview.content} />
                </div>
              ) : (
                <div className="text-center text-gray-400 py-8">
                  <p className="text-sm">(无内容)</p>
                  {preview.filePath && <p className="text-xs mt-2">文件路径: {preview.filePath}</p>}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type PreviewData = { content_snapshot?: string; version?: number; description?: string; preview_url?: string; file_path?: string; content?: string; file_exists?: boolean; file_mode?: string; content_truncated?: boolean; content_source?: string };
