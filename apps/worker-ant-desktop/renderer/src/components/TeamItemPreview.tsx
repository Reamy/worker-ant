/**
 * zx_20261113_5 M2「见」: 团队共享库/领域包的**只读预览**弹层。
 *
 * 判据与组装全在 main（`core/team-library.ts::previewTeamBody` / `core/domain-pack.ts::readDomainPackDetail`）；
 * 本组件只负责把 `{title, rows, sections, note}` 显示出来——**不在渲染层再解析一遍 body**。
 */
import { useEffect } from 'react';
import { X } from 'lucide-react';

export interface PreviewView {
  title: string;
  rows: Array<{ label: string; value: string }>;
  sections: Array<{ label: string; content: string }>;
  note?: string;
}

export default function TeamItemPreview({
  view,
  loading,
  error,
  onClose,
}: {
  view: PreviewView | null;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-lg bg-white shadow-xl border border-gray-200">
        <div className="sticky top-0 bg-white px-4 py-3 border-b border-gray-100 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-800 break-words">
              {view?.title || '预览'}
            </h3>
            <p className="text-[10px] text-gray-400 mt-0.5">只读预览 · 内容与分享/导入使用的载荷同源</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 shrink-0" title="关闭">
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-3">
          {loading && <p className="text-sm text-gray-400">读取中…</p>}
          {error && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">
              读取失败：{error}
            </p>
          )}
          {view && !loading && (
            <>
              {view.rows.length > 0 && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-600">
                  {view.rows.map((r) => (
                    <span key={r.label} className="break-words">
                      <span className="text-gray-400">{r.label} · </span>
                      {r.value}
                    </span>
                  ))}
                </div>
              )}
              {view.sections.length === 0 && (
                <p className="text-xs text-gray-400">这份条目没有可显示的正文。</p>
              )}
              {view.sections.map((s) => (
                <section key={s.label} className="rounded border border-gray-100 bg-gray-50 px-3 py-2">
                  <p className="text-xs font-medium text-gray-600 mb-1">{s.label}</p>
                  <pre className="text-[11px] text-gray-700 whitespace-pre-wrap break-words">{s.content}</pre>
                </section>
              ))}
              {view.note && (
                <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                  {view.note}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
