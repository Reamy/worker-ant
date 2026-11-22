/**
 * zx_20261120_1 M9「运·一页」：运维概览（**只读**）。
 *
 * 八块：调度队列 / 任务态 / 构建锁 / 数据库 / IM 补发 / cron / ANS / 磁盘。
 * 每块三态：有数 / 读不到（写原因）/ 未记录（`null`）——**不把读不到显示成 0**。
 * 本轮**不做任何写操作**（没有一键清理/重置）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, AlertTriangle, CheckCircle, Copy, RefreshCw, XCircle } from 'lucide-react';
import { ops as opsApi, type OpsOverview } from '../lib/ipc';
import { formatBytes } from '../lib/deliverable-view';

function fmtAge(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '未记录';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

function State({ ok, reason }: { ok: boolean; reason?: string }) {
  return ok
    ? <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle className="w-3.5 h-3.5" />可读</span>
    : <span className="inline-flex items-center gap-1 text-red-600"><XCircle className="w-3.5 h-3.5" />读不到：{reason || '未提供原因'}</span>;
}

export default function OpsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<OpsOverview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await opsApi.overview());
      setError('');
    } catch (e) {
      setError((e as Error).message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const issues: string[] = [];
  if (data) {
    if (data.jobs.ok && (data.jobs.value!.pending > 50 || (data.jobs.value!.oldestPendingMs ?? 0) > 10 * 60_000)) issues.push('调度队列有积压');
    if (data.tasks.ok && data.tasks.value!.stale > 0) issues.push(`有 ${data.tasks.value!.stale} 个执行态任务无心跳`);
    if (data.locks.ok && (data.locks.value!.expired > 0 || data.locks.value!.bad > 0)) issues.push('构建锁有过期/坏文件');
    if (data.im.ok && data.im.value!.dead > 0) issues.push(`IM 补发有 ${data.im.value!.dead} 条死信`);
    if (data.cron.ok && data.cron.value!.heartbeatOk === false) issues.push('cron 心跳超过 30 分钟');
    if (data.ans.ok && data.ans.value!.reachable === false) issues.push('ANS 探活失败');
    if (data.disk.ok && (data.disk.value!.freeBytes ?? Infinity) < 1024 ** 3) issues.push('磁盘余量不足 1GB');
  }

  async function copyDiagnostics(): Promise<void> {
    if (!data) return;
    const text = `工蚁运维概览 ${data.generatedAt}\n`
      + `调度：${data.jobs.ok ? JSON.stringify(data.jobs.value) : `读不到（${data.jobs.reason}）`}\n`
      + `任务：${data.tasks.ok ? JSON.stringify(data.tasks.value) : `读不到（${data.tasks.reason}）`}\n`
      + `锁：${data.locks.ok ? JSON.stringify({ total: data.locks.value!.total, active: data.locks.value!.active, expired: data.locks.value!.expired, bad: data.locks.value!.bad }) : `读不到（${data.locks.reason}）`}\n`
      + `数据库：${data.db.ok ? JSON.stringify(data.db.value) : `读不到（${data.db.reason}）`}\n`
      + `IM：${data.im.ok ? JSON.stringify(data.im.value) : `读不到（${data.im.reason}）`}\n`
      + `cron：${data.cron.ok ? JSON.stringify(data.cron.value) : `读不到（${data.cron.reason}）`}\n`
      + `ANS：${data.ans.ok ? JSON.stringify(data.ans.value) : `读不到（${data.ans.reason}）`}\n`
      + `磁盘：${data.disk.ok ? JSON.stringify(data.disk.value) : `读不到（${data.disk.reason}）`}\n`;
    try { await navigator.clipboard.writeText(text); } catch { setError('复制失败：浏览器未授权剪贴板'); }
  }

  // 无数据时的兜底文案要说真话：真在加载才写「加载中」，已失败就别继续假装在加载
  // （2026-11-22：IPC 信封缺失曾令八块恒显示「加载中」，错误态同样会退化成这一句）。
  const emptyLabel = loading ? '加载中' : '读取失败';
  const card = 'bg-white rounded-lg border p-4';
  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2"><Activity className="w-5 h-5 text-cyan-600" />运维</h2>
          <p className="text-xs text-gray-500 mt-1">
            {error ? `读取失败：${error}` : data ? (issues.length === 0 ? '此刻没有发现需要处理的事。' : `此刻有 ${issues.length} 件事值得看一眼：${issues.join('；')}`) : '读取中…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void copyDiagnostics()} disabled={!data} className="flex items-center gap-1 px-3 py-1.5 border rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50"><Copy className="w-3.5 h-3.5" />复制诊断信息</button>
          <button onClick={() => void load()} disabled={loading} className="flex items-center gap-1 px-3 py-1.5 bg-accent text-white rounded-lg text-sm hover:bg-accent/90 disabled:opacity-50"><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />刷新</button>
        </div>
      </div>

      {data && (
        <p className="text-[11px] text-gray-400 mb-3">取样时刻：{data.generatedAt}（数字现算；读不到的项写原因，不写 0）</p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className={card}>
          <div className="flex items-center justify-between mb-2"><h3 className="text-sm font-semibold">调度队列</h3>{data && <State ok={data.jobs.ok} reason={data.jobs.reason} />}</div>
          {data?.jobs.ok ? (
            <div className="text-[12px] text-gray-700 space-y-1">
              <p>待执行 <b>{data.jobs.value!.pending}</b> · 执行中 <b>{data.jobs.value!.running}</b> · 24h 失败 <b className={data.jobs.value!.failed24h > 0 ? 'text-red-600' : ''}>{data.jobs.value!.failed24h}</b></p>
              <p>最老待执行：{fmtAge(data.jobs.value!.oldestPendingMs)}</p>
              <p className="text-[11px] text-gray-500">按类型：{Object.entries(data.jobs.value!.byType).map(([k, v]) => `${k} ${v}`).join(' · ') || '无作业'}</p>
              <button onClick={() => navigate('/tasks')} className="text-[11px] text-accent hover:underline">打开任务列表</button>
            </div>
          ) : <p className="text-[12px] text-gray-400">读不到这块：{data?.jobs.reason ?? emptyLabel}</p>}
        </div>

        <div className={card}>
          <div className="flex items-center justify-between mb-2"><h3 className="text-sm font-semibold">任务态</h3>{data && <State ok={data.tasks.ok} reason={data.tasks.reason} />}</div>
          {data?.tasks.ok ? (
            <div className="text-[12px] text-gray-700 space-y-1">
              <p>执行中 <b>{data.tasks.value!.executing}</b> · 运行 <b>{data.tasks.value!.running}</b> · 暂停 <b>{data.tasks.value!.paused}</b></p>
              <p className={data.tasks.value!.stale > 0 ? 'text-amber-700' : ''}>无心跳执行态：<b>{data.tasks.value!.stale}</b>{data.tasks.value!.staleOldest ? `（最老 ${data.tasks.value!.staleOldest}）` : ''}</p>
              <button onClick={() => navigate('/tasks')} className="text-[11px] text-accent hover:underline">去任务列表处置</button>
            </div>
          ) : <p className="text-[12px] text-gray-400">读不到这块：{data?.tasks.reason ?? emptyLabel}</p>}
        </div>

        <div className={card}>
          <div className="flex items-center justify-between mb-2"><h3 className="text-sm font-semibold">构建锁</h3>{data && <State ok={data.locks.ok} reason={data.locks.reason} />}</div>
          {data?.locks.ok ? (
            <div className="text-[12px] text-gray-700 space-y-1">
              <p>在册 <b>{data.locks.value!.total}</b> · 持有中 <b>{data.locks.value!.active}</b> · 已过期 <b className={data.locks.value!.expired > 0 ? 'text-amber-700' : ''}>{data.locks.value!.expired}</b> · 坏文件 <b className={data.locks.value!.bad > 0 ? 'text-red-600' : ''}>{data.locks.value!.bad}</b></p>
              {data.locks.value!.items.slice(0, 5).map((l) => (
                <p key={`${l.repoRoot}:${l.taskId}`} className="text-[11px] text-gray-500 truncate" title={l.repoRoot}>
                  {l.expired ? '已过期' : '持有中'} · {l.taskId.slice(0, 8)} · {l.command.slice(0, 60)}
                </p>
              ))}
              <p className="text-[11px] text-gray-400">锁在 30 分钟后自愈；本页只读，不替你释放。</p>
            </div>
          ) : <p className="text-[12px] text-gray-400">读不到这块：{data?.locks.reason ?? emptyLabel}</p>}
        </div>

        <div className={card}>
          <div className="flex items-center justify-between mb-2"><h3 className="text-sm font-semibold">数据库文件</h3>{data && <State ok={data.db.ok} reason={data.db.reason} />}</div>
          {data?.db.ok ? (
            <div className="text-[12px] text-gray-700 space-y-1">
              <p>主库 <b>{data.db.value!.dbBytes == null ? '未记录' : formatBytes(data.db.value!.dbBytes)}</b></p>
              <p>WAL <b>{data.db.value!.walBytes == null ? '未记录' : formatBytes(data.db.value!.walBytes)}</b> · SHM <b>{data.db.value!.shmBytes == null ? '未记录' : formatBytes(data.db.value!.shmBytes)}</b></p>
              <p className="text-[11px] text-gray-400">WAL 偏大通常意味着长时间未检查点；本页只读。</p>
            </div>
          ) : <p className="text-[12px] text-gray-400">读不到这块：{data?.db.reason ?? emptyLabel}</p>}
        </div>

        <div className={card}>
          <div className="flex items-center justify-between mb-2"><h3 className="text-sm font-semibold">IM 补发</h3>{data && <State ok={data.im.ok} reason={data.im.reason} />}</div>
          {data?.im.ok ? (
            <div className="text-[12px] text-gray-700 space-y-1">
              <p>待补发 <b>{data.im.value!.pending}</b> · 死信 <b className={data.im.value!.dead > 0 ? 'text-red-600' : ''}>{data.im.value!.dead}</b> · 配额阻塞 <b>{data.im.value!.blocked_quota}</b> · 其它 <b>{data.im.value!.other}</b></p>
              <button onClick={() => navigate('/im')} className="text-[11px] text-accent hover:underline">去 IM 页处理</button>
            </div>
          ) : <p className="text-[12px] text-gray-400">读不到这块：{data?.im.reason ?? emptyLabel}</p>}
        </div>

        <div className={card}>
          <div className="flex items-center justify-between mb-2"><h3 className="text-sm font-semibold">cron 心跳</h3>{data && <State ok={data.cron.ok} reason={data.cron.reason} />}</div>
          {data?.cron.ok ? (
            <div className="text-[12px] text-gray-700 space-y-1">
              <p>在册项目定时：<b>{data.cron.value!.registeredProjects}</b></p>
              <p className={data.cron.value!.heartbeatOk === false ? 'text-amber-700' : ''}>
                最近一次触发：{data.cron.value!.heartbeatAgeMs == null ? '未记录（从未触发）' : fmtAge(data.cron.value!.heartbeatAgeMs)}
                {data.cron.value!.lastSuccess === false ? '（上次失败）' : ''}
              </p>
              <p className="text-[11px] text-gray-400">阈值 30 分钟（与健康自检同一数）。</p>
            </div>
          ) : <p className="text-[12px] text-gray-400">读不到这块：{data?.cron.reason ?? emptyLabel}</p>}
        </div>

        <div className={card}>
          <div className="flex items-center justify-between mb-2"><h3 className="text-sm font-semibold">ANS</h3>{data && <State ok={data.ans.ok} reason={data.ans.reason} />}</div>
          {data?.ans.ok ? (
            <div className="text-[12px] text-gray-700 space-y-1">
              <p className="truncate" title={data.ans.value!.baseUrl}>{data.ans.value!.baseUrl || '未配置地址'}</p>
              <p className={data.ans.value!.reachable === false ? 'text-red-600' : ''}>
                {data.ans.value!.reachable == null ? '未探测' : data.ans.value!.reachable ? `可达（${data.ans.value!.latencyMs ?? '?'} ms）` : `不可达：${data.ans.value!.reason || '未提供原因'}`}
              </p>
              <p className="text-[11px] text-gray-400">探活 2 秒有界；失败不代表任务一定跑不动。</p>
              <button onClick={() => navigate('/settings')} className="text-[11px] text-accent hover:underline">去设置检查</button>
            </div>
          ) : <p className="text-[12px] text-gray-400">读不到这块：{data?.ans.reason ?? emptyLabel}</p>}
        </div>

        <div className={card}>
          <div className="flex items-center justify-between mb-2"><h3 className="text-sm font-semibold">磁盘</h3>{data && <State ok={data.disk.ok} reason={data.disk.reason} />}</div>
          {data?.disk.ok ? (
            <div className="text-[12px] text-gray-700 space-y-1">
              <p>可用 <b className={(data.disk.value!.freeBytes ?? Infinity) < 1024 ** 3 ? 'text-amber-700' : ''}>{data.disk.value!.freeBytes == null ? '未记录' : formatBytes(data.disk.value!.freeBytes)}</b></p>
              <p>总量 {data.disk.value!.totalBytes == null ? '未记录' : formatBytes(data.disk.value!.totalBytes)}</p>
            </div>
          ) : <p className="text-[12px] text-gray-400">读不到这块：{data?.disk.reason ?? emptyLabel}</p>}
        </div>
      </div>

      {issues.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>值得看一眼：{issues.join('；')}。本页只报事实，不替你做处置。</span>
        </div>
      )}
    </div>
  );
}
