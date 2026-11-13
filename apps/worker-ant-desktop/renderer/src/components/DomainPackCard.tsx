/**
 * zx_20261021_3 批五: 项目「领域包」卡——**生成 / 启用 / 撤销 / 注入成效**。
 *
 * ⚠ 闸与判据全在 main 侧（`core/domain-pack.ts`）：本卡不判档位、不算预算，只把拒因原样上屏
 *   （Pro 锁定时 `FEATURE_REQUIRED` → 本卡"锁定"态，其余码 → 错误行）。
 * ⚠ 已启用的包**执行期注入常开、不随降级回收**——卡上如实写这一句（撤销是用户动作，不是系统动作）。
 * ⚠ 导入 ≠ 启用：从共享库拉来的包只会出现在列表里，需在这里显式启用。
 */
import { useCallback, useEffect, useState } from 'react';
import { Boxes, Eye, Plus, RefreshCw } from 'lucide-react';
import { IpcError, packs as packsApi } from '../lib/ipc';
import type { DomainPackDetail, DomainPackListRow, DomainPackStats } from '../../../src/main/core/domain-pack.js';
import TeamItemPreview, { type PreviewView } from './TeamItemPreview';

/** zx_20261113_5 M3「口」：单包详情 → 预览弹层的视图（只做排版，不再解析包体）。 */
function detailView(d: DomainPackDetail): PreviewView {
  const rows = [
    d.description ? { label: '描述', value: d.description } : null,
    { label: '版本', value: `v${d.version}` },
    d.source_project_name ? { label: '出处项目', value: d.source_project_name } : null,
    d.derived_at ? { label: '生成时间', value: d.derived_at } : null,
  ].filter((x): x is { label: string; value: string } => x !== null);
  const sections = d.sections.map((s) => ({ label: s.label, content: s.content }));
  if (d.business) {
    const lines: string[] = [];
    for (const t of d.business.terms) lines.push(`概念：${t.term}${t.meaning ? ` —— ${t.meaning}` : ''}`);
    for (const r of d.business.rules) lines.push(`规则：${r.rule}`);
    for (const s of d.business.scenarios) lines.push(`场景：${s.scenario}`);
    if (lines.length) sections.push({ label: '业务域', content: lines.join('\n') });
  }
  const note = d.omitted_labels.length
    ? `超体量上限，未携带的节：${d.omitted_labels.join(' / ')}`
    : undefined;
  return { title: d.name, rows, sections, note };
}

export default function DomainPackCard({ projectId, onChanged }: { projectId: string; onChanged?: () => void }) {
  const [rows, setRows] = useState<DomainPackListRow[]>([]);
  const [stats, setStats] = useState<DomainPackStats | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // zx_20261113_5 M3「口」：单包只读预览（看不是启用；不挂 Pro 闸）。
  const [preview, setPreview] = useState<PreviewView | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const [l, s] = await Promise.all([packsApi.list(projectId), packsApi.stats(projectId)]);
      setRows(l.packs);
      setStats(s);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const run = useCallback(async (key: string, fn: () => Promise<string | null>) => {
    setBusy(key);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      setError(null);
      // zx_20261113_4 B4：启用/撤销/生成后，首屏「业务知识」行即时刷新。
      onChanged?.();
    } catch (e) {
      if (e instanceof IpcError && e.code === 'FEATURE_REQUIRED') setLocked(e.message);
      else setError((e as Error).message);
    } finally {
      setBusy(null);
      await load();
    }
  }, [load, onChanged]);

  const derive = useCallback(() => run('derive', async () => {
    const r = await packsApi.derive(projectId);
    setLocked(null);
    const omitted = r.pack.omitted_sections.length > 0
      ? `（超体量上限，未携带：${r.pack.omitted_sections.join(' / ')}）`
      : '';
    return `已生成领域包「${r.pack.name}」：${r.pack.sections.length} 节${omitted}——启用后才会注入。`;
  }), [projectId, run]);

  const apply = useCallback((packId: string) => run(`apply:${packId}`, async () => {
    const r = await packsApi.apply(projectId, packId);
    setLocked(null);
    return r.already ? '该领域包本来就在启用中。' : '已启用：新任务的上下文将注入本包。';
  }), [projectId, run]);

  const unapply = useCallback((packId: string) => run(`unapply:${packId}`, async () => {
    const r = await packsApi.unapply(projectId, packId);
    return r.removed ? '已取消启用（包资产仍在库里）。' : '该领域包本未启用。';
  }), [projectId, run]);

  const openPreview = useCallback((packId: string) => {
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    void packsApi.detail(packId)
      .then((d) => setPreview(detailView(d)))
      .catch((e) => setPreviewError((e as Error).message))
      .finally(() => setPreviewLoading(false));
  }, []);

  if (!projectId) return null;

  const appliedCount = rows.filter((r) => r.applied).length;
  const packStats = new Map((stats?.packs ?? []).map((p) => [p.pack_id, p]));

  return (
    <div className="mt-3 bg-white rounded-lg border p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5 text-gray-700">
          <Boxes className="w-4 h-4 text-teal-600" />领域包
          {rows.length > 0 && (
            <span className="text-[10px] font-normal px-1.5 py-0.5 rounded-full bg-teal-50 text-teal-700 border border-teal-200">
              共 {rows.length} 份 · 本项目启用 {appliedCount}
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy !== null}
            title="刷新"
            className="p-1 rounded hover:bg-gray-100 disabled:opacity-50"
          >
            <RefreshCw className="w-3.5 h-3.5 text-gray-400" />
          </button>
          <button
            type="button"
            onClick={() => void derive()}
            disabled={busy !== null}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded border text-gray-600 hover:text-teal-700 hover:border-teal-300 disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" />{busy === 'derive' ? '生成中…' : '从本项目生成'}
          </button>
        </div>
      </div>

      <p className="text-[10px] text-gray-300 mb-2">
        从本项目既有知识派生出可携带的三节（领域与术语 / 验收与失败 / 配方与样板）；<strong>不训练</strong>。
        启用后执行期注入，<strong>撤销前常开</strong>；从共享库导入的包不会自动启用。
      </p>

      {stats && (
        <p className="text-[11px] text-gray-500 mb-2">
          领域包注入 {stats.injections} 次 · ≈{stats.chars} 字
          {stats.injections > 0 && <span className="text-gray-400"> · 成功 {stats.completed} / 失败 {stats.failed}</span>}
        </p>
      )}

      {locked && (
        <p className="mb-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          领域包是专业版能力：{locked}
        </p>
      )}
      {error && <p className="mb-2 text-xs text-red-600">领域包操作失败：{error}</p>}
      {notice && (
        <p className="mb-2 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">{notice}</p>
      )}

      {rows.length === 0 && !error && (
        <p className="text-xs text-gray-400">
          库里还没有领域包——可从本项目生成，或在「团队共享库」导入别人分享的领域包。
        </p>
      )}

      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((r) => {
            const st = packStats.get(r.id);
            return (
              <div key={r.id} className="p-2 bg-gray-50 rounded flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-gray-700 flex items-center gap-2 flex-wrap">
                    {r.name}
                    <span className="text-[10px] font-normal text-gray-400">
                      {r.section_count} 节 · ≈{r.chars} 字
                      {r.source_project_name ? ` · 源项目「${r.source_project_name}」` : ''}
                    </span>
                    {r.applied && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700">注入常开</span>
                    )}
                    {/* zx_20261113_4 B3「注」：逐包成效——注入过几次、其中完成/失败各几件 */}
                    {st && st.injections > 0 && (
                      <span className="text-[10px] text-gray-400">
                        已注入 {st.injections} 次 · 完成 {st.completed} / 失败 {st.failed}
                      </span>
                    )}
                    {r.applied && (!st || st.injections === 0) && (
                      <span className="text-[10px] text-gray-400">尚未注入</span>
                    )}
                  </p>
                  {r.description && <p className="mt-0.5 text-[11px] text-gray-500">{r.description}</p>}
                </div>
                <span className="shrink-0 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => openPreview(r.id)}
                    disabled={busy !== null}
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded border text-gray-600 border-gray-300 hover:text-teal-700 hover:border-teal-300 disabled:opacity-50"
                    title="查看包内三节全文（只读；启用仍走右侧按钮）"
                  >
                    <Eye className="w-3.5 h-3.5" />查看
                  </button>
                  <button
                    type="button"
                    onClick={() => void (r.applied ? unapply(r.id) : apply(r.id))}
                    disabled={busy !== null}
                    className={`text-xs px-2 py-1 rounded border disabled:opacity-50 ${
                      r.applied
                        ? 'text-gray-600 border-gray-300 hover:text-red-600 hover:border-red-300'
                        : 'text-gray-600 border-gray-300 hover:text-teal-700 hover:border-teal-300'
                    }`}
                  >
                    {busy === `apply:${r.id}` || busy === `unapply:${r.id}`
                      ? '处理中…'
                      : r.applied ? '取消启用' : '启用'}
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {(preview || previewLoading || previewError) && (
        <TeamItemPreview
          view={preview}
          loading={previewLoading}
          error={previewError}
          onClose={() => {
            setPreview(null);
            setPreviewError(null);
            setPreviewLoading(false);
          }}
        />
      )}
    </div>
  );
}
