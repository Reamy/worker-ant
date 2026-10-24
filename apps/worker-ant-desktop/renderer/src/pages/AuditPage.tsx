/**
 * zx_20261017_1 批二（管子·度量衡 / 维特根斯坦·意义即使用）: **审计视图**——一屏回答"谁在什么时候改了什么"。
 *
 * 数据是 main 侧**一个读模型**（`core/audit-log.ts`）：新审计账 + 设备控制账 + 外部终端调用账
 *   投影成同一把尺，按时间倒序。界面不自己拼三张表（那正是本页要消灭的负担）。
 *
 * ⚠ 词表（来源/动作的人话名）与行形状**同引** `core/audit-labels.ts` 一处真源——不在此手抄第二份。
 * ⚠ 锁定档位：main 回 `TEAM_REQUIRED` ⇒ 整页只显示升级提示（与协同面板同形）；不显示一张空表
 *   冒充"没有审计记录"（那两件事不是一回事）。
 */
import { useState } from 'react';
import { ShieldCheck, RefreshCw, Download } from 'lucide-react';
import { audit as auditApi, IpcError } from '../lib/ipc';
import { useLiveQuery } from '../lib/useLiveQuery';
import { FreshnessPill } from '../components/FreshnessPill';
import { formatDbTime } from '../lib/deliverable-view';
import {
  AUDIT_SOURCES, AUDIT_SOURCE_LABEL, auditActionLabel, type AuditEventRow, type AuditSource,
} from '../../../src/main/core/audit-labels.js';

/** 结果徽标：ok / denied / error 三态各一色；新账动作无此概念（空串）⇒ 不渲染。 */
function ResultBadge({ result }: { result: string }) {
  if (!result) return <span className="text-gray-300">—</span>;
  const cls = result === 'ok' ? 'bg-emerald-50 text-emerald-600'
    : result === 'denied' ? 'bg-amber-50 text-amber-600'
    : 'bg-red-50 text-red-600';
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${cls}`}>{result}</span>;
}

function SourceBadge({ source }: { source: AuditSource }) {
  const cls = source === 'device' ? 'bg-sky-50 text-sky-700'
    : source === 'terminal' ? 'bg-violet-50 text-violet-700'
    : source === 'node' ? 'bg-indigo-50 text-indigo-700'
    : 'bg-gray-100 text-gray-600';
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${cls}`}>{AUDIT_SOURCE_LABEL[source]}</span>;
}

function detailText(row: AuditEventRow): string {
  const keys = Object.keys(row.detail);
  if (keys.length === 0) return '';
  try { return JSON.stringify(row.detail); } catch { return ''; }
}

function Row({ row }: { row: AuditEventRow }) {
  const detail = detailText(row);
  const target = [row.targetType, row.targetId].filter(Boolean).join(' / ');
  return (
    <tr className="border-t border-gray-100 align-top">
      <td className="py-2 pr-3 text-xs text-gray-500 whitespace-nowrap">{formatDbTime(row.createdAt)}</td>
      <td className="py-2 pr-3"><SourceBadge source={row.source} /></td>
      <td className="py-2 pr-3">
        <div className="text-sm text-gray-800">{auditActionLabel(row.action)}</div>
        <div className="text-[10px] text-gray-400 font-mono">{row.action}</div>
      </td>
      <td className="py-2 pr-3 text-xs text-gray-600">
        <div>{target || '—'}</div>
        {row.actorRef && <div className="text-[10px] text-gray-400 font-mono">发起者：{row.actorRef}</div>}
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">
        <ResultBadge result={row.result} />
        {row.note && <div className="text-[10px] text-amber-600 mt-0.5">{row.note}</div>}
      </td>
      <td className="py-2 text-[11px] text-gray-500 font-mono max-w-[280px] truncate" title={detail}>
        {detail || '—'}
      </td>
    </tr>
  );
}

type LoadState =
  | { locked: true; message: string; events: AuditEventRow[] }
  | { locked: false; events: AuditEventRow[] };

export default function AuditPage() {
  const [source, setSource] = useState<AuditSource | ''>('');
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // zx_20261018_3 批七：导出吃当前**筛选**（不吃分页——导出的就是这一屏口径的全部行）。
  const doExport = async () => {
    setExporting(true);
    setExportMsg(null);
    try {
      const r = await auditApi.exportCsv(source ? { source } : undefined);
      setExportMsg({ ok: true, text: `已导出 ${r.rows} 行 → ${r.savedTo}` });
    } catch (e) {
      setExportMsg({ ok: false, text: e instanceof IpcError ? e.message : (e as Error)?.message || String(e) });
    } finally {
      setExporting(false);
    }
  };
  const q = useLiveQuery<LoadState>(async () => {
    try {
      const payload = await auditApi.list({ limit: 200, ...(source ? { source } : {}) });
      return { locked: false, events: payload.events };
    } catch (e) {
      if (e instanceof IpcError && e.code === 'TEAM_REQUIRED') {
        return { locked: true, message: e.message, events: [] };
      }
      throw e;
    }
  }, [source], {
    // 审计是可写动作的旁账：这几类事件到达时复取（不是数据源，只是刷新触发）。
    liveTypes: ['node.request_dispatched', 'node.request_result', 'device.discovered', 'device.status_changed'],
    debounceMs: 700,
  });

  if (q.loading && q.data == null) {
    return <div className="flex justify-center py-12"><div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" /></div>;
  }

  const locked = q.data?.locked === true;
  const events = q.data?.events ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold">审计视图</h2>
          <p className="text-[11px] text-gray-400 mt-0.5">改档、派活、许可激活、设备控制与外部终端调用——同一时间线。</p>
        </div>
        <div className="flex items-center gap-2">
          <FreshnessPill q={q} />
          {!locked && (
            <button
              onClick={() => void doExport()}
              disabled={exporting}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              title="把当前筛选下的全部审计记录导出为 CSV"
            >
              <Download className="w-3.5 h-3.5" />
              {exporting ? '导出中…' : '导出 CSV'}
            </button>
          )}
          <button onClick={() => void q.reload()} className="p-2 hover:bg-gray-100 rounded-lg" title="刷新">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {locked ? (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-indigo-800 mb-1">
            <ShieldCheck className="w-4 h-4" />「审计视图」属于团队版能力
          </div>
          <div className="text-xs text-indigo-700">{q.data?.locked ? q.data.message : ''}</div>
        </div>
      ) : (
        <>
          {q.error && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              读取审计记录失败：{q.error}
            </div>
          )}

          {exportMsg && (
            <div className={`mb-3 rounded-lg border px-3 py-2 text-xs ${exportMsg.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
              {exportMsg.text}
            </div>
          )}

          <div className="mb-3 flex items-center gap-2 text-xs text-gray-500">
            <span>来源</span>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as AuditSource | '')}
              className="border border-gray-200 rounded-lg px-2 py-1 bg-white"
            >
              <option value="">全部</option>
              {AUDIT_SOURCES.map((s) => <option key={s} value={s}>{AUDIT_SOURCE_LABEL[s]}</option>)}
            </select>
          </div>

          {events.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-200 px-4 py-10 text-center text-sm text-gray-400">
              还没有审计记录。改档、派活、激活许可、设备控制与外部终端调用都会在这里留一行。
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="text-[11px] text-gray-400 uppercase tracking-wider">
                    <th className="pb-2 pr-3 font-medium">时间</th>
                    <th className="pb-2 pr-3 font-medium">来源</th>
                    <th className="pb-2 pr-3 font-medium">动作</th>
                    <th className="pb-2 pr-3 font-medium">对象</th>
                    <th className="pb-2 pr-3 font-medium">结果</th>
                    <th className="pb-2 font-medium">明细</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((row) => <Row key={`${row.source}:${row.id}`} row={row} />)}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
