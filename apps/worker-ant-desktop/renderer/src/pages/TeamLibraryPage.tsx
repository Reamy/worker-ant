/**
 * zx_20261017_1 批六（维特根斯坦·意义即使用）: **团队共享库**——一屏可分享。
 * zx_20261021_3 批三: 第四栏「领域包」（列由 `TEAM_ITEM_KINDS` 派生，不在此手抄类目）。
 *   导入领域包**只是落一份资产**，须到项目详情「领域包」页签显式启用才会注入。
 * zx_20261022_3 批八: 第五栏「项目画像」（同上派生）。导入画像须**先选目标项目**；
 *   导入后**默认不启用**，到该项目「项目知识包」卡启用后才注入。同名画像不覆盖（跳过/冲突如实上屏）。
 *
 * 每栏两段：
 *   · 「团队已共享」——远端条目（ANS 一次取回，界面按 kind 分栏）；**导入**按钮落到本地对应表。
 *   · 「本机可分享」——本机候选；**分享**按钮才上传（R-36：列表加载不写，不静默上传）。
 *
 * ⚠ 锁定档位：main 回 `TEAM_REQUIRED` ⇒ 整页只显示升级提示（与审计视图/协同面板同形），
 *   不显示空栏冒充"共享库里什么都没有"。
 * ⚠ ANS 读不到 ⇒ 远端栏如实带原因（`payload.error`）；候选照常可用（分享会因此失败并说明）。
 * ⚠ 上限（标题/载荷/单节点条数）只在 ANS 判——此处只把 ANS 的拒因原文上屏。
 * ⚠ 删除只在**本机分享的**行上出现（`source_node_id === localNodeId`）。
 */
import { useEffect, useState } from 'react';
import { BookOpen, Download, RefreshCw, Share2, ShieldCheck, Trash2, Upload, UserRound } from 'lucide-react';
import {
  projects as projectsApi,
  team as teamApi, IpcError, type TeamItem, type TeamItemsPayload, type LocalTeamItem,
} from '../lib/ipc';
import { useLiveQuery } from '../lib/useLiveQuery';
import { FreshnessPill } from '../components/FreshnessPill';
import {
  TEAM_ITEM_KINDS, TEAM_ITEM_KIND_LABEL, type TeamItemKind,
} from '../../../../../packages/shared-types/src/team.js';

type LoadState =
  | { locked: true; message: string }
  | { locked: false; payload: TeamItemsPayload };

function localCandidatesOf(payload: TeamItemsPayload, kind: TeamItemKind): LocalTeamItem[] {
  if (kind === 'template') return payload.local.templates;
  if (kind === 'memory') return payload.local.memories;
  if (kind === 'domain_pack') return payload.local.domainPacks;
  if (kind === 'project_profile') return payload.local.profiles;
  return payload.local.deliverables;
}

function formatWhen(iso: string): string {
  if (!iso) return '';
  return iso.length > 16 ? iso.slice(0, 16).replace('T', ' ') : iso;
}

interface ColumnProps {
  kind: TeamItemKind;
  payload: TeamItemsPayload;
  busy: string | null;
  onShare: (kind: TeamItemKind, localId: string) => void;
  onImport: (item: TeamItem) => void;
  onDelete: (item: TeamItem) => void;
}

function KindColumn({ kind, payload, busy, onShare, onImport, onDelete }: ColumnProps) {
  const remote = payload.remote
    .filter((it) => it.kind === kind)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  const local = localCandidatesOf(payload, kind);
  const label = TEAM_ITEM_KIND_LABEL[kind];

  return (
    <section className="rounded-lg border border-gray-200 bg-white flex flex-col min-h-[280px]">
      <header className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-800">{label}</span>
        <span className="text-[11px] text-gray-400">已共享 {remote.length}</span>
      </header>

      <div className="px-3 py-2 border-b border-gray-100 flex-1">
        {remote.length === 0 ? (
          <div className="text-xs text-gray-400 py-6 text-center">
            {payload.error ? '远端暂不可读，无法确认共享情况。' : `还没有人分享${label}。`}
          </div>
        ) : (
          <ul className="space-y-2 max-h-[320px] overflow-y-auto">
            {remote.map((item) => {
              const mine = item.source_node_id === payload.localNodeId;
              const key = `import:${item.id}`;
              return (
                <li key={item.id} className="rounded border border-gray-100 px-2 py-1.5">
                  <div className="text-sm text-gray-800 break-words">{item.title || '(无标题)'}</div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="text-[10px] text-gray-400">
                      {mine ? '本机分享' : `来自 ${item.source_node_id.slice(0, 8)}`}
                      {item.created_at ? ` · ${formatWhen(item.created_at)}` : ''}
                    </span>
                    <span className="flex items-center gap-1">
                      <button
                        onClick={() => onImport(item)}
                        disabled={busy !== null}
                        className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                        title={`导入到本地${label}表`}
                      >
                        <Download className="w-3 h-3" />导入
                      </button>
                      {mine && (
                        <button
                          onClick={() => onDelete(item)}
                          disabled={busy !== null}
                          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-50"
                          title="从团队共享库删除（其他节点将不再看到）"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="px-3 py-2">
        <div className="text-[11px] text-gray-400 mb-1">
          本机可分享（{local.length}{payload.local.truncated ? '+' : ''}）
        </div>
        {local.length === 0 ? (
          <div className="text-xs text-gray-400 py-2">本机还没有可分享的{label}。</div>
        ) : (
          <ul className="space-y-1 max-h-[220px] overflow-y-auto">
            {local.map((row) => (
              <li key={`${kind}:${row.localId}`} className="flex items-center justify-between gap-2 py-0.5">
                <span className="min-w-0">
                  <span className="text-xs text-gray-700 block truncate" title={row.title}>{row.title}</span>
                  {row.subtitle && <span className="text-[10px] text-gray-400 block truncate">{row.subtitle}</span>}
                </span>
                <button
                  onClick={() => onShare(kind, row.localId)}
                  disabled={busy !== null}
                  className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50 shrink-0"
                >
                  <Share2 className="w-3 h-3" />分享
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export default function TeamLibraryPage() {
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  // 画像导入的落点：目标项目 id（默认第一个项目；读不到列表时留空并在导入时如实拦下）。
  const [targetProjectId, setTargetProjectId] = useState('');
  const [projectOptions, setProjectOptions] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    void projectsApi.list().then((rows) => {
      const opts = rows
        .map((r) => ({ id: String(r.id ?? ''), name: String(r.name ?? r.id ?? '') }))
        .filter((o) => o.id);
      setProjectOptions(opts);
      setTargetProjectId((cur) => cur || opts[0]?.id || '');
    }).catch(() => { /* 读不到项目列表 ⇒ 画像导入前会如实提示，不静默挑一个 */ });
  }, []);

  const q = useLiveQuery<LoadState>(async () => {
    try {
      const payload = await teamApi.items();
      return { locked: false, payload };
    } catch (e) {
      if (e instanceof IpcError && e.code === 'TEAM_REQUIRED') return { locked: true, message: e.message };
      throw e;
    }
  }, []);

  async function run(key: string, fn: () => Promise<string>): Promise<void> {
    setBusy(key);
    setActionError(null);
    setActionNote(null);
    try {
      setActionNote(await fn());
      await q.reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function handleShare(kind: TeamItemKind, localId: string): void {
    void run(`share:${kind}:${localId}`, async () => {
      const item = await teamApi.share(kind, localId);
      return `已分享：${item.title || '(无标题)'}`;
    });
  }

  function handleImport(item: TeamItem): void {
    if (item.kind === 'project_profile' && !targetProjectId) {
      setActionNote(null);
      setActionError('导入项目画像前，请先在「项目画像」栏选择目标项目。');
      return;
    }
    void run(`import:${item.id}`, async () => {
      const result = await teamApi.importItem(item, item.kind === 'project_profile' ? targetProjectId : null);
      if (result.kind === 'domain_pack') {
        // 导入≠启用：不点明这一点，用户会以为"导入完就在用了"。
        return `已导入领域包（尚未启用）：${item.title || '(无标题)'}——到项目详情「领域包」页签启用后才会注入上下文。`;
      }
      if (result.kind === 'project_profile') {
        // 同上：导入画像默认不启用，且**不覆盖**目标项目已有画像（同名即跳过/冲突）。
        const target = projectOptions.find((o) => o.id === result.id)?.name || result.id;
        return `已导入项目画像到「${target}」（默认未启用）：${item.title || '(无标题)'}——到该项目「项目知识包」卡启用后才会注入。`;
      }
      return `已导入到本地（${result.target}）：${item.title || '(无标题)'}`;
    });
  }

  function handleDelete(item: TeamItem): void {
    if (!window.confirm(`从团队共享库删除「${item.title || '(无标题)'}」？其他节点将不再看到它。`)) return;
    void run(`delete:${item.id}`, async () => {
      await teamApi.remove(item.id);
      return `已删除：${item.title || '(无标题)'}`;
    });
  }

  if (q.loading && q.data == null) {
    return <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" /></div>;
  }

  const locked = q.data?.locked === true;
  const payload = q.data?.locked === false ? q.data.payload : null;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2"><BookOpen className="w-5 h-5" />团队共享库</h2>
          <p className="text-[11px] text-gray-400 mt-0.5">
            跨节点共享模板、记忆、成果元数据、领域包与项目画像——成果只元数据、不传文件；每一项都由你显式点击才上传。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <FreshnessPill q={q} />
          <button onClick={() => void q.reload()} className="p-2 hover:bg-gray-100 rounded-lg" title="刷新">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {locked ? (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-indigo-800 mb-1">
            <ShieldCheck className="w-4 h-4" />「团队共享库」属于团队版能力
          </div>
          <div className="text-xs text-indigo-700">{q.data?.locked ? q.data.message : ''}</div>
        </div>
      ) : (
        <>
          {q.error && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              读取共享库失败：{q.error}
            </div>
          )}
          {payload?.error && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              远端共享库暂不可读：{payload.error}（本机候选仍可查看，分享会失败并如实说明原因）
            </div>
          )}
          {actionError && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {actionError}
            </div>
          )}
          {actionNote && (
            <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              {actionNote}
            </div>
          )}
          {payload && payload.total > payload.remote.length && (
            <div className="mb-3 text-[11px] text-gray-500 flex items-center gap-1">
              <Upload className="w-3 h-3" />
              仅显示最近 {payload.remote.length} 条（共 {payload.total} 条）。
            </div>
          )}

          {payload && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-gray-600">
              <UserRound className="w-3.5 h-3.5 text-indigo-400" />
              <span>项目画像导入到：</span>
              <select
                value={targetProjectId}
                onChange={(e) => setTargetProjectId(e.target.value)}
                disabled={busy !== null}
                className="text-xs px-1.5 py-1 rounded border text-gray-600 bg-white disabled:opacity-50"
              >
                {projectOptions.length === 0 && <option value="">(读不到项目列表)</option>}
                {projectOptions.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
              <span className="text-[10px] text-gray-400">
                导入的画像默认不启用；目标项目已有画像时不覆盖（同名跳过或记冲突，原样上屏）。
              </span>
            </div>
          )}

          {payload && (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
              {TEAM_ITEM_KINDS.map((kind) => (
                <KindColumn
                  key={kind}
                  kind={kind}
                  payload={payload}
                  busy={busy}
                  onShare={handleShare}
                  onImport={handleImport}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
