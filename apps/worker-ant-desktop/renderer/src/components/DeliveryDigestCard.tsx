import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { projects } from '../lib/ipc';
import { useSettings } from '../lib/settingsStore';
import { useActivity } from '../lib/activity';
import { useDeliverableDrawer } from '../lib/deliverableDrawer';
import { Check, Star, FileText, Trophy } from 'lucide-react';
// zx_20260910_3 M3(G3): 布尔 setting 判据**两侧共用同一文件**——渲染层不再自带第二份写法
import { boolSetting } from '../../../src/main/core/settings-bool.js';
// 类型词表与库内时间——与其他产出物渲染点共此一份真源
import { DELIVERABLE_TYPE_LABEL, formatDbTime } from '../lib/deliverable-view';

/**
 * zx_20260908 M2(B1/B2): 项目「成果交付单」凝练卡——
 * done 里程碑→落地任务、主要成果(primary) 与 已验收 doc、高质已完成任务 单页直达；纯展示聚合不改判。
 * 数据源自 project:deliveryDigest(后端同源派生 acceptance/is_primary/质量)；行内点跳任务详情。
 */
interface DigestRow {
  deliverable_id?: string; name?: string; type?: string; status?: string; is_primary?: boolean;
  task_id?: string | null; task_title?: string | null; quality?: number | null;
  acceptance?: { criteria_total?: number; passed_total?: number; checked_at?: string } | null;
  updated_at?: string | null;
}
interface Digest {
  milestonesDone: Array<Record<string, unknown>>;
  primaryDeliverables: DigestRow[];
  verifiedDocs: DigestRow[];
  highQualityTasks: Array<Record<string, unknown>>;
}

export default function DeliveryDigestCard({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const settings = useSettings();
  const enabled = boolSetting(settings['deliverable.show_delivery_digest']);
  const primaryEnabled = boolSetting(settings['deliverable.primary_marker']);
  // zx_20260908_1 B1(空性·缘起归窗): 交付单窗口切换(全部/近30/近7)——本阶段成果按窗口如实归口; 开关关则隐藏切换条回 all-time
  const windowSwitchOn = boolSetting(settings['deliverable.digest_window_switch']);
  const [win, setWin] = useState<string>('all');
  const [digest, setDigest] = useState<Digest | null>(null);

  const load = useCallback(async () => {
    if (!projectId || !enabled) return;
    try { const d = await projects.deliveryDigest(projectId, windowSwitchOn ? win : 'all'); setDigest(d as unknown as Digest); } catch { setDigest(null); }
  }, [projectId, enabled, windowSwitchOn, win]);

  useEffect(() => { load(); }, [load]);

  // 事件驱动刷新：任务终态/产出物/文件事件到达 → 防抖重取（不轮询）
  const { subscribe } = useActivity();
  useEffect(() => {
    const un = subscribe((e) => {
      const t = e.type;
      // zx_20260909 X2①: 里程碑状态变更由主进程真实事件驱动刷新(删去虚构死监听 'milestone.done')
      if (t === 'task.status_changed' || t === 'deliverable.registered' || t === 'deliverable.status_changed' || t.startsWith('file.') || t === 'project.milestone_changed') load();
    });
    return un;
  }, [subscribe, load]);

  if (!enabled || !digest) return null;
  const mDone = (digest.milestonesDone || []) as Array<{ milestone?: string; impl_task_id?: string; impl_title?: string | null; impl_status?: string | null }>;
  const primary = (digest.primaryDeliverables || []) as DigestRow[];
  const verified = (digest.verifiedDocs || []).filter(r => !primary.some(p => p.deliverable_id === r.deliverable_id)) as DigestRow[];
  const hqTasks = (digest.highQualityTasks || []) as Array<{ task_id?: string; title?: string; quality?: number | null; status?: string }>;
  const sections = [mDone.length > 0, (primaryEnabled && primary.length > 0), verified.length > 0, hqTasks.length > 0].filter(Boolean).length;
  // 下面两节（主要成果 / 已验收文档成果）同为「主成果」，合计即两段之和（verified 已去重掉 primary 的 id）
  const mainCount = (primaryEnabled ? primary.length : 0) + verified.length;
  if (sections === 0) return null;

  return (
    <div className="mt-3 bg-white rounded-lg border p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5 text-gray-700">
          <Trophy className="w-4 h-4 text-amber-500" />本阶段成果交付单
          {mainCount > 0 && <span className="text-[10px] font-normal px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">主成果 {mainCount} 条</span>}
        </h3>
        <span className="text-[10px] text-gray-300">已落地里程碑 / 主要成果·已验收 doc / 高质任务 — 行内点跳直达</span>
      </div>
      {windowSwitchOn && (
        <div className="flex items-center gap-1 mb-2">
          {(['all', '30', '7'] as const).map((w) => (
            <button key={w} type="button" onClick={() => setWin(w)}
              className={`text-[10px] px-2 py-0.5 rounded-full border ${win === w ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'}`}>
              {w === 'all' ? '全部' : `近${w}天`}
            </button>
          ))}
          {win !== 'all' && <span className="text-[10px] text-gray-300 ml-1">已按「{win === '30' ? '近30天' : '近7天'}」归口（primary 为累计位不受窗限制）</span>}
        </div>
      )}
      {mDone.length > 0 && (
        <div className="mb-2">
          <p className="text-[11px] text-gray-400 mb-1">已落地里程碑（点跳落地任务）</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            {mDone.map((m, i) => (
              m.impl_task_id ? (
                <button key={i} type="button" onClick={() => navigate(`/tasks/${m.impl_task_id}`)} title={m.impl_title ? `落地任务：${m.impl_title}` : `落地任务 ${m.impl_task_id}`}
                  className="text-xs px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 hover:bg-teal-100 border border-teal-200">
                  {m.milestone}<span className="ml-1 text-teal-400">✓</span>
                </button>
              ) : (
                <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-gray-50 text-gray-400">{m.milestone}</span>
              )
            ))}
          </div>
        </div>
      )}
      {primaryEnabled && primary.length > 0 && (
        <div className="mb-2">
          <p className="text-[11px] text-gray-400 mb-1">主要成果（★ 已在产出物页标记）</p>
          <ul className="space-y-1">
            {primary.map((r, i) => <DigestRowItem key={r.deliverable_id || i} r={r} navigate={navigate} />)}
          </ul>
        </div>
      )}
      {verified.length > 0 && (
        <div className="mb-2">
          <p className="text-[11px] text-gray-400 mb-1">已验收文档成果</p>
          <ul className="space-y-1">{verified.map((r, i) => <DigestRowItem key={r.deliverable_id || i} r={r} navigate={navigate} />)}</ul>
        </div>
      )}
      {hqTasks.length > 0 && (
        <div>
          <p className="text-[11px] text-gray-400 mb-1">高质量已完成任务（★≥80，点跳任务详情）</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            {hqTasks.map((t, i) => (
              t.task_id ? (
                <button key={i} type="button" onClick={() => navigate(`/tasks/${t.task_id}`)} title={t.title}
                  className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-700 hover:bg-green-100 border border-green-200 max-w-[220px] truncate">
                  {String(t.title || '').slice(0, 18)}<span className="ml-1">★{t.quality}</span>
                </button>
              ) : null
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DigestRowItem({ r, navigate }: { r: DigestRow; navigate: (p: string) => void }) {
  // zx_20260909 X1(可直达·消三跳): 点成果名 → 就地开详情抽屉(deliverable.doc_drawer 门控; 关或无 id 回落跳任务页)
  const settings = useSettings();
  const drawerOn = boolSetting(settings['deliverable.doc_drawer']);
  const { open } = useDeliverableDrawer();
  const openRow = () => { if (drawerOn && r.deliverable_id) open(r.deliverable_id); else if (r.task_id) navigate(`/tasks/${r.task_id}`); };
  const acc = r.acceptance?.checked_at ? r.acceptance : null;
  const accP = Number(acc?.passed_total) || 0;
  const accT = Number(acc?.criteria_total) || 0;
  const accAllPass = accT > 0 && accP >= accT;
  const typeLabel = DELIVERABLE_TYPE_LABEL[String(r.type || '')] || String(r.type || '');
  return (
    <li className="flex items-center gap-2 text-sm bg-gray-50 rounded px-2 py-1 hover:bg-gray-100">
      {r.is_primary && <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-400 shrink-0" />}
      {String(r.type || '') === 'doc' && !r.is_primary && <FileText className="w-3.5 h-3.5 text-gray-400 shrink-0" />}
      <button type="button" onClick={openRow} title={r.name} className="truncate text-left hover:text-blue-600 hover:underline">{r.name}</button>
      <span className="text-[10px] px-1 rounded bg-white text-gray-400 shrink-0">{typeLabel}</span>
      {acc && (
        <span title={`验收 ${accP}/${accT} 通过 · 核验于 ${acc.checked_at}`} className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${accAllPass ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
          {accAllPass ? '✓ 已验收' : '验收未全过'}{' '}{accP}/{accT}
        </span>
      )}
      {/* zx_20260911_2 M4b(Q9 名实相符): 此 quality 是**任务级** quality_score（digest 行上挂的是任务分），紧邻成果名易被读成成果自身质量——标签冠「任务」+ title 明示 */}
      {r.quality != null && <span title={`任务级质量分 ${r.quality}（该成果所属任务 finalize 的评分，非本成果自身质量）`} className={`text-[9px] px-1 py-0.5 rounded-full font-medium shrink-0 ${r.quality >= 80 ? 'bg-green-100 text-green-700' : r.quality >= 60 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-600'}`}>任务★{r.quality}</span>}
      {r.task_id ? (
        <button type="button" onClick={() => navigate(`/tasks/${r.task_id}`)} title={r.task_title || '打开产出任务'} className="ml-auto text-[10px] text-blue-500 hover:underline shrink-0 truncate max-w-[160px]">↳ {r.task_title || r.task_id.slice(0, 8)}</button>
      ) : <span className="ml-auto text-[10px] text-gray-300 shrink-0">{formatDbTime(r.updated_at)}</span>}
    </li>
  );
}
