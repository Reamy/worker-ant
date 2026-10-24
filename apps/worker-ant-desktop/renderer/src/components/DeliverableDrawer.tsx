import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invoke, deliverables, ACCEPT_REASON_TEXT } from '../lib/ipc';
import { useSettings } from '../lib/settingsStore';
import { simpleLineDiff, type DiffLine } from '../lib/diff';
import { X, Star, Copy, FileText, Check, ArrowRight, FolderOpen } from 'lucide-react';
// zx_20260910_3 M3(G3): 布尔 setting 判据**两侧共用同一文件**——渲染层不再自带第二份写法
import { boolSetting } from '../../../src/main/core/settings-bool.js';
// zx_20260914 M2-1(王阳明·知行合一): 正文「读得动」——与列表页 `:535`/`:597`、任务详情 `:1266` 共用同一渲染器
import MarkdownSubset from '../lib/markdown-subset';
// zx_20260914 M2-4: 验收类型判据引**同一份代码**（renderer 是词表的第二个落点，不手抄）
import { isAcceptanceType } from '../../../src/main/core/deliverable-types.js';
// 类型/状态词表、库内时间、版本大小换算——四处渲染点共此一份真源（源在本行所示模块）
import { DELIVERABLE_TYPE_LABEL, DELIVERABLE_STATUS_LABEL, formatDbTime, versionSizeText } from '../lib/deliverable-view';

/**
 * zx_20260909 X1(就地成果详情抽屉 · 黑格尔"部分在整体中成其自身"/维特根斯坦"可判定"):
 * 单条成果就地展开——状态/★主/验收(任务级派生)/版本流历次 v 快照+与上一版 diff/溯源(所在任务·项目·支撑里程碑)/当前内容预览。
 * 数据源 = deliverable:preview(main 已含 versions+溯源+acceptance)。本组件为展示聚合、操作仅★置主/复制路径/跳任务, 不改判。
 */

type Ver = { version: number; created_at?: string; size?: number; changed_by?: string; content_snapshot?: string };

type DrawerData = {
  id: string; name: string; type: string; status: string; is_primary?: number | null; description?: string;
  file_path?: string | null; registry_id?: string | null; created_at?: string; updated_at?: string | null;
  task_id?: string | null; task_title?: string | null; project_id?: string | null; project_name?: string | null;
  milestones?: Array<{ milestone: string; status: string }> | null;
  acceptance?: { criteria_total?: number; passed_total?: number; checked_at?: string } | null;
  content_snapshot?: string; version?: number; versions?: Ver[];
  file_exists?: boolean; file_mode?: string; preview_url?: string;
  // zx_20260911_5 M3-4: 由 deliverable:preview 如实回报——截断 / 内容来源(file|snapshot|description|none)
  content_truncated?: boolean; content_source?: string;
};

const TYPE_CLS: Record<string, string> = { mcp: 'bg-blue-100 text-blue-700', a2a: 'bg-green-100 text-green-700', ui: 'bg-purple-100 text-purple-700', doc: 'bg-amber-100 text-amber-700', daemon: 'bg-orange-100 text-orange-700', code: 'bg-slate-100 text-slate-700' };
const STATUS_CLS: Record<string, string> = { completed: 'bg-green-100 text-green-700', retired: 'bg-gray-200 text-gray-500 line-through', running: 'bg-green-100 text-green-700', registered: 'bg-blue-100 text-blue-700', stopped: 'bg-orange-100 text-orange-600', stale: 'bg-yellow-100 text-yellow-600', failed: 'bg-red-100 text-red-600' };

export function DeliverableDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const navigate = useNavigate();
  const settings = useSettings();
  const primaryMarkerOn = boolSetting(settings['deliverable.primary_marker']);
  const [data, setData] = useState<DrawerData | null>(null);
  const [loading, setLoading] = useState(false);
  const [selVer, setSelVer] = useState<Ver | null>(null);
  const [diffView, setDiffView] = useState<DiffLine[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  // zx_20260914 M2-4: 打标结果**就地如实说明**（失败原因写在抽屉里，不弹一个笼统的"操作失败"）
  const [accMsg, setAccMsg] = useState<{ text: string; ok: boolean } | null>(null);
  // zx_20260914 M2-2: 图片成果的内联预览载荷（三种失败各自的 reason 一并留住，供如实告知）
  const [img, setImg] = useState<{ dataUrl?: string; reason?: string; size?: number; limit?: number } | null>(null);

  useEffect(() => { void load(); // eslint-disable-line react-hooks/exhaustive-deps
  }, [id]);

  async function load() {
    if (!id) { setData(null); setSelVer(null); setDiffView(null); return; }
    setLoading(true);
    try {
      const r = (await invoke<DrawerData | null>('deliverable:preview', id)) || null;
      setData(r);
    } catch { setData(null); }
    setLoading(false);
    setSelVer(null); setDiffView(null);
  }

  const versions = useMemo(() => data?.versions || [], [data]);

  const togglePrimary = async () => {
    if (!data || busy) return;
    setBusy(true);
    try { await deliverables.setPrimary(data.id, !(data.is_primary === 1)); await load(); } catch { /* 失败忽略 */ }
    setBusy(false);
  };

  const copyPath = async () => {
    if (!data?.file_path) return;
    try { await navigator.clipboard.writeText(data.file_path); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };

  // zx_20260911_5 M3-3(上手状态): 抽屉内本地直达——仅本地绝对路径出此按钮（与 main handler 同一判据）
  const isLocalPath = (p?: string | null): boolean => !!p && p.startsWith('/');
  const showInFolder = async () => {
    if (!data?.file_path) return;
    const api = window.electronAPI;
    if (!api?.showItemInFolder) return;
    try { await api.showItemInFolder(data.file_path); } catch { /* 失败不阻断抽屉 */ }
  };

  // zx_20260914 M2-4(王阳明·知行合一): 「标为已验收」——总门控与列表页同源(boolSetting 同一份)，
  //   且仅 ACCEPTANCE_TYPES 内可标；已带 acceptance 的行不显示(无可再标)。
  const accept = async () => {
    if (!data || busy) return;
    setBusy(true);
    setAccMsg(null);
    try {
      const r = await deliverables.accept(data.id);
      if (r?.ok) {
        setAccMsg({ text: r.changed > 0 ? '已标记为验收' : '该成果此前已标记，无需重复', ok: true });
        await load();
      } else {
        setAccMsg({ text: ACCEPT_REASON_TEXT[r?.reason || 'error'] || ACCEPT_REASON_TEXT.error!, ok: false });
      }
    } catch {
      setAccMsg({ text: ACCEPT_REASON_TEXT.error!, ok: false });
    }
    setBusy(false);
  };

  // zx_20260914 M2-2: 抽屉打开即问主进程"这能不能当图片内联"——判据全在 main(白名单/上限/存在性)，
  //   本层只负责显示它给的结果。非图片成果返回 unsupported，静默跳过(不为每条成果占一行"不支持")。
  useEffect(() => {
    let alive = true;
    setImg(null);
    if (!id) return () => { alive = false; };
    void deliverables.previewImage(id)
      .then((r) => { if (alive) setImg(r?.dataUrl ? { dataUrl: r.dataUrl } : (r?.reason === 'oversize' ? { reason: r.reason, size: r.size, limit: r.limit } : null)); })
      .catch(() => { /* 取图失败 ⇒ 不显示图，不阻断抽屉其余内容 */ });
    return () => { alive = false; };
  }, [id]);

  const openVersion = (v: Ver) => { setSelVer(v); setDiffView(null); };
  const diffWithPrev = (v: Ver) => {
    const idx = versions.findIndex((x) => x.version === v.version);
    const prev = idx > 0 ? versions[idx - 1] : null;
    if (!prev) return;
    setSelVer(v);
    setDiffView(simpleLineDiff(String(prev.content_snapshot || ''), String(v.content_snapshot || '')));
  };

  if (!id) return null;
  const acc = data?.acceptance;
  const accPass = !!acc && (acc.checked_at || '') !== '' && Number(acc.criteria_total || 0) > 0 && Number(acc.passed_total || 0) >= Number(acc.criteria_total || 0);
  const content = (diffView ? null : (selVer?.content_snapshot ?? data?.content_snapshot ?? '')) as string | null;
  const canStar = primaryMarkerOn && !!data && data.status !== 'retired';
  // zx_20260914 M2-4(D2 裁定: 入口放列表行 + 抽屉两处): 可标 = 验收开关开 + 类型可验收 + 尚未带验收 + 非退休
  const canAccept = boolSetting(settings['deliverable.show_acceptance']) && !!data
    && isAcceptanceType(data.type) && !acc && data.status !== 'retired';
  const isDoc = data?.type === 'doc';
  const isCode = data?.type === 'code';

  return (
    <div className="fixed inset-0 bg-black/30 flex justify-end z-[70]" onClick={onClose}>
      <div className="bg-white h-full w-full max-w-4xl flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* 头 */}
        <div className="px-5 py-4 border-b flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${TYPE_CLS[data?.type || ''] || 'bg-gray-100 text-gray-600'}`}>{DELIVERABLE_TYPE_LABEL[data?.type || ''] || data?.type || '—'}</span>
              {data && <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full ${STATUS_CLS[data.status] || 'bg-gray-100 text-gray-500'}`}>{DELIVERABLE_STATUS_LABEL[data.status] || data.status}</span>}
              {data && data.is_primary === 1 && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">★ 主要成果</span>}
              {acc && accPass && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">✓ 已验收 {acc.passed_total}/{acc.criteria_total}</span>}
              {acc && !accPass && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">验收 {acc.passed_total}/{acc.criteria_total}</span>}
            </div>
            <h3 className="font-bold text-lg mt-1.5 break-all leading-snug">{data?.name || '加载中…'}</h3>
            {data?.file_path && <p className="text-xs text-gray-400 font-mono mt-1 truncate" title={data.file_path}>{data.file_path}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {canStar && (
              <button type="button" onClick={togglePrimary} disabled={busy} title={data?.is_primary === 1 ? '取消为主要成果' : '标记为主要成果'}
                className={`p-2 rounded hover:bg-gray-100 border ${data?.is_primary === 1 ? 'border-amber-200 bg-amber-50' : 'border-gray-200'}`}>
                <Star className={`w-4 h-4 ${data?.is_primary === 1 ? 'text-amber-500 fill-amber-400' : 'text-gray-400'}`} />
              </button>
            )}
            {/* zx_20260914 M2-4(王阳明·知行合一): 验收有入口——此前徽标只是"看得到"，想标只能等引擎自己打 */}
            {canAccept && (
              <button type="button" onClick={accept} disabled={busy} title="标为已验收（落该成果所属任务已有的验收结论）"
                className="px-2 py-1.5 rounded hover:bg-green-50 border border-green-200 text-[11px] text-green-700 disabled:opacity-50">
                <Check className="w-3.5 h-3.5 inline mr-0.5" />标为已验收
              </button>
            )}
            {data?.file_path && (
              <button type="button" onClick={copyPath} title="复制路径" className="p-2 rounded hover:bg-gray-100 border border-gray-200">
                {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4 text-gray-500" />}
              </button>
            )}
            {/* zx_20260911_5 M3-3: 在系统文件管理器中显示——免"复制路径→再翻目录" */}
            {isLocalPath(data?.file_path) && (
              <button type="button" onClick={showInFolder} title="在文件夹中显示" className="p-2 rounded hover:bg-gray-100 border border-gray-200">
                <FolderOpen className="w-4 h-4 text-gray-500" />
              </button>
            )}
            <button type="button" onClick={onClose} className="p-2 rounded hover:bg-gray-100"><X className="w-5 h-5 text-gray-500" /></button>
          </div>
        </div>

        {/* zx_20260914 M2-4: 打标结果就地如实说明——成功/已标/被拒各有各的话，不笼统报"失败" */}
        {accMsg && (
          <div className={`px-5 py-2 text-xs border-b ${accMsg.ok ? 'bg-green-50 text-green-700 border-green-100' : 'bg-amber-50 text-amber-700 border-amber-100'}`}>
            {accMsg.text}
            <button type="button" onClick={() => setAccMsg(null)} className="ml-2 underline opacity-70">知道了</button>
          </div>
        )}

        {/* 溯源 */}
        {(data?.task_id || data?.project_name || data?.milestones?.length || data?.registry_id) ? (
          <div className="px-5 py-2.5 border-b bg-gray-50/60 text-xs text-gray-600 space-y-1">
            {data?.project_name && <div>项目：<span className="font-medium">{data.project_name}</span></div>}
            {data?.task_id && (
              <button type="button" onClick={() => { onClose(); navigate(`/tasks/${data.task_id}`); }}
                className="flex items-center gap-1 text-blue-600 hover:underline">
                产出任务：{data.task_title || data.task_id.slice(0, 8)} <ArrowRight className="w-3 h-3" />
              </button>
            )}
            {/* zx_20260914 M2-5a(D5 裁定: 渲染而非停写): `registry_id` 此前**只写不读**——库里有值、
                类型里声明了、界面上从不显示(a2a/mcp 成果的注册端点对用户本是有用信息)。
                如实标注为"注册端点"，不叫"ID"——它是端点地址，名实要相符。 */}
            {data?.registry_id && (
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="shrink-0">注册端点：</span>
                {/^https?:\/\//.test(data.registry_id) ? (
                  <button type="button" onClick={() => { void invoke('shell:openExternal', data.registry_id).catch(() => {}); }}
                    className="font-mono text-[11px] text-blue-600 hover:underline truncate" title={`在浏览器中打开：${data.registry_id}`}>
                    {data.registry_id}
                  </button>
                ) : (
                  <span className="font-mono text-[11px] text-gray-500 truncate" title={data.registry_id}>{data.registry_id}</span>
                )}
              </div>
            )}
            {!!data?.milestones?.length && (
              <div className="flex items-center gap-1.5 flex-wrap">支撑里程碑：
                {data.milestones.map((m, i) => (
                  <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded-full ${m.status === 'done' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{m.milestone}{m.status === 'done' ? ' ✓' : ''}</span>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {/* 主内容 */}
        <div className="flex-1 overflow-auto p-5">
          {loading && <div className="text-center text-gray-400 py-10 text-sm">加载中…</div>}
          {!loading && !data && <div className="text-center text-gray-400 py-10 text-sm">该产出物不存在或已删除。</div>}
          {data && (
            <>
              {/* 版本流 */}
              {versions.length > 0 && (
                <div className="mb-4">
                  <div className="text-xs font-semibold text-gray-500 mb-1.5">版本流（{versions.length}）— 点击版本看快照 · 「与上一版对比」看 diff</div>
                  <div className="flex flex-wrap gap-1.5">
                    {versions.map((v) => (
                      <span key={v.version}>
                        <button type="button" onClick={() => openVersion(v)}
                          className={`text-xs px-2 py-1 rounded-lg border ${selVer?.version === v.version ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                          v{v.version}
                        </button>
                        {versions.length > 1 && (
                          <button type="button" onClick={() => diffWithPrev(v)} disabled={v.version === versions[0]?.version}
                            title={v.version === versions[0]?.version ? '最早版本无前版可对比' : `对比 v${v.version} 与上一版`}
                            className="text-[9px] text-blue-500 ml-1 hover:underline disabled:text-gray-300 disabled:no-underline">对比</button>
                        )}
                      </span>
                    ))}
                  </div>
                  {selVer && (() => {
                    const sz = versionSizeText(selVer.size, selVer.content_snapshot);
                    return (
                      <div className="text-[11px] text-gray-400 mt-1.5">v{selVer.version} 快照 · {formatDbTime(selVer.created_at)}{selVer.changed_by ? ` · 由 ${selVer.changed_by}` : ''}{` · `}<span title={sz.title}>{sz.text}</span></div>
                    );
                  })()}
                </div>
              )}
              {versions.length === 0 && isDoc && <div className="mb-4 text-[11px] text-gray-400">（无版本快照记录）</div>}

              {/* 内容预览 */}
              <div className="text-xs font-semibold text-gray-500 mb-1.5">{diffView ? 'diff（绿增/红删）' : (selVer ? `快照内容 v${selVer.version}` : '当前内容')}</div>
              {/* zx_20260914 M2-2(夏克特·七宗罪·信息失落): 图片成果**就地看得到**——主进程读盘转 data URL 内联。
                  渲染层**不抄白名单**(那会是第二个落点)：直接请求，`unsupported` 即"不是图片"，静默不显；
                  只有 oversize(确为图片但超 10MB 上限) 值得占用版面如实说明——那是用户能采取行动的差异。 */}
              {img?.dataUrl && (
                <div className="mb-3">
                  <img src={img.dataUrl} alt={data?.name || '图片成果'} className="max-w-full max-h-[46vh] rounded border border-gray-200 bg-white" />
                </div>
              )}
              {img?.reason === 'oversize' && (
                <div className="mb-2 px-3 py-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-700">
                  图片超过内联上限（{((img.limit || 0) / 1024 / 1024).toFixed(0)}MB，实际 {((img.size || 0) / 1024 / 1024).toFixed(1)}MB），未内联显示——可用上方「在文件夹中显示」打开原图。
                </div>
              )}
              {/* zx_20260906_1 3d: 溯源诚实——磁盘文件缺失时快照为"历史版本"，显式标注不再静默冒充当前版。
                  zx_20260911_5 M3-4: 门开至 code；并只在**确实展示快照**（未选特定版本/diff）且来源为 snapshot 时声明。 */}
              {!selVer && !diffView && !data.file_exists && (isDoc || isCode) && data.content_source === 'snapshot' && (
                <div className="mb-2 px-3 py-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-700">
                  磁盘文件已缺失/被移动——当前展示的是{data.version && data.version > 1 ? `版本历史快照 v${data.version}` : '既有快照'}，非实时文件内容。
                </div>
              )}
              {/* zx_20260911_5 M3-4(夏克特·错误归属): 截断 / 以描述代之——如实标注，不再静默冒充全文 */}
              {!selVer && !diffView && data.content_truncated && (
                <div className="mb-2 px-3 py-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-700">
                  文件较大——以下仅为开头 100KB 的内容，非全文。
                </div>
              )}
              {!selVer && !diffView && data.content_source === 'description' && (
                <div className="mb-2 px-3 py-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-700">
                  未取到文件内容（文件缺失或非文本）——以下为成果描述，非文件正文。
                </div>
              )}
              {diffView ? (
                <div className="text-xs font-mono bg-gray-50 p-3 rounded border max-h-[46vh] overflow-auto">
                  {diffView.length === 0 ? <span className="text-gray-400">两版内容一致</span> : diffView.map((l, i) => (
                    <div key={i} className={`whitespace-pre-wrap ${l.type === 'add' ? 'bg-green-50 text-green-700' : l.type === 'del' ? 'bg-red-50 text-red-600' : 'text-gray-600'}`}>
                      <span className="w-4 inline-block text-gray-400 select-none">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>{l.line || ' '}
                    </div>
                  ))}
                </div>
              ) : content ? (
                <div className="text-xs bg-gray-50 p-3 rounded border max-h-[46vh] overflow-auto">
                  <MarkdownSubset source={content} />
                </div>
              ) : (
                <div className="text-center text-gray-400 py-8 text-sm bg-gray-50 rounded border">(无内容可预览)</div>
              )}
              {data.type !== 'doc' && data.preview_url && (
                <div className="mt-3">
                  <button type="button" onClick={async () => { try { await invoke('shell:openExternal', data.preview_url); } catch { window.open(data.preview_url!, '_blank'); } }}
                    className="text-xs px-3 py-1.5 rounded-lg border border-blue-200 text-blue-600 hover:bg-blue-50">
                    <FileText className="w-3.5 h-3.5 inline mr-1" />在浏览器中打开
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
