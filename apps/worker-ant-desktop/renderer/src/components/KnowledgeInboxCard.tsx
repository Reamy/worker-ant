/**
 * zx_20261030_1 M6「荐」: 项目「知识收件箱」——三块。
 *
 *   ① **增量水位**：知识书有 N 条新事件未吸收 + 「现在吸收」（水位只在 main 侧吸收成功后前移）；
 *   ② **建议的领域包**：系统按项目知识派生的 `auto_candidate`，**永不自动启用**——这里只给「启用 / 忽略」；
 *   ③ **相似项目**：确定性相似度前 3，附「为什么像」，**只展示、不自动注入**，点开才去看。
 *
 * ⚠ 判据/闸/派生全在 main 侧（`knowledge-watermark.ts` / `domain-pack.ts` / `project-similarity.ts`）；
 *   本卡不判档位、不造分数、不拼理由——拒因原样上屏（Pro 锁定 → `FEATURE_REQUIRED` 提示行）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Inbox, Lightbulb, RefreshCw, Sparkles, Users } from 'lucide-react';
import { IpcError, knowledge as knowledgeApi, packs as packsApi } from '../lib/ipc';
import type { KnowledgeAbsorbReceipt } from '../lib/ipc';
import type { DomainPackListRow } from '../../../src/main/core/domain-pack.js';
import type { SimilarProject } from '../../../src/main/core/project-similarity.js';

interface UnabsorbedView {
  count: number;
  lastEventId: number;
  lastRunAt: string;
  lastEventAt: string;
}

export default function KnowledgeInboxCard({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const [unabsorbed, setUnabsorbed] = useState<UnabsorbedView | null>(null);
  const [similar, setSimilar] = useState<SimilarProject[]>([]);
  const [suggested, setSuggested] = useState<DomainPackListRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const [u, s, p] = await Promise.all([
        knowledgeApi.unabsorbed(projectId),
        knowledgeApi.similarProjects(projectId),
        packsApi.suggested(projectId),
      ]);
      setUnabsorbed(u);
      setSimilar(s.projects);
      setSuggested(p.packs);
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
    } catch (e) {
      if (e instanceof IpcError && e.code === 'FEATURE_REQUIRED') setLocked(e.message);
      else setError((e as Error).message);
    } finally {
      setBusy(null);
      await load();
    }
  }, [load]);

  const absorb = useCallback(() => run('absorb', async () => {
    const r: KnowledgeAbsorbReceipt = await knowledgeApi.absorbNow(projectId);
    if (r.absorbedEvents === 0) return '没有新的可归属事件——知识书已是本刻最新。';
    return `已吸收 ${r.absorbedEvents} 条新事件：知识册 ${r.sections} 节 · 知识卡 ${r.cards} 张${
      r.candidatePackId ? ' · 已更新一条候选领域包建议' : ''
    }${r.remaining > 0 ? `（仍有 ${r.remaining} 条待下轮）` : ''}。`;
  }), [projectId, run]);

  const applyCandidate = useCallback((packId: string) => run(`apply:${packId}`, async () => {
    const r = await packsApi.apply(projectId, packId);
    setLocked(null);
    return r.already ? '该领域包本来就在启用中。' : '已启用：新任务的上下文将注入本包。';
  }), [projectId, run]);

  const dismissCandidate = useCallback((packId: string) => run(`dismiss:${packId}`, async () => {
    const r = await packsApi.dismiss(packId);
    return r.dismissed ? '已忽略该建议——同一来源项目不再重复推荐。' : '该建议已不在待处理之列。';
  }), [run]);

  if (!projectId) return null;

  return (
    <div className="bg-white rounded-lg border p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5 text-gray-700">
          <Inbox className="w-4 h-4 text-indigo-600" />知识收件箱
          <span className="text-[10px] font-normal text-gray-400">· 增量吸收 / 建议领域包 / 相似项目</span>
        </h3>
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy !== null}
          title="刷新"
          className="p-1 rounded hover:bg-gray-100 disabled:opacity-50"
        >
          <RefreshCw className="w-3.5 h-3.5 text-gray-400" />
        </button>
      </div>

      {locked && (
        <p className="mb-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          领域包是专业版能力：{locked}
        </p>
      )}
      {error && <p className="mb-2 text-xs text-red-600">知识收件箱加载失败：{error}</p>}
      {notice && (
        <p className="mb-2 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">{notice}</p>
      )}

      {/* ① 增量水位 */}
      <div className="mb-3">
        <p className="text-xs font-medium text-gray-600 flex items-center gap-1.5 mb-1">
          <Sparkles className="w-3.5 h-3.5 text-indigo-500" />知识书增量
        </p>
        {unabsorbed && unabsorbed.count > 0 ? (
          <div className="flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
            <p className="text-[11px] text-amber-800">
              有 {unabsorbed.count} 条新事件未吸收——知识书可能已旧。吸收只读本项目事件增量，不训练任何模型。
            </p>
            <button
              type="button"
              onClick={() => void absorb()}
              disabled={busy !== null}
              className="shrink-0 text-xs px-2 py-1 rounded border text-amber-800 border-amber-300 hover:bg-amber-100 disabled:opacity-50"
            >
              {busy === 'absorb' ? '吸收中…' : '现在吸收'}
            </button>
          </div>
        ) : (
          <p className="text-[11px] text-gray-400">
            知识书已吸收到最新可归属事件
            {unabsorbed?.lastRunAt ? `（上次运行 ${unabsorbed.lastRunAt.slice(0, 10)}）` : '（尚无水位记录）'}。
          </p>
        )}
      </div>

      {/* ② 建议的领域包 */}
      <div className="mb-3">
        <p className="text-xs font-medium text-gray-600 flex items-center gap-1.5 mb-1">
          <Lightbulb className="w-3.5 h-3.5 text-teal-600" />建议的领域包
          <span className="text-[10px] font-normal text-gray-400">· 候选永不自动启用</span>
        </p>
        {suggested.length === 0 ? (
          <p className="text-[11px] text-gray-400">暂无建议。系统从其他项目的既有知识派生候选，忽略后不再重复推荐。</p>
        ) : (
          <div className="space-y-1.5">
            {suggested.map((p) => (
              <div key={p.id} className="p-2 bg-gray-50 rounded flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-gray-700">
                    {p.name}
                    <span className="ml-2 text-[10px] font-normal text-gray-400">
                      {p.section_count} 节 · ≈{p.chars} 字
                      {p.source_project_name ? ` · 源项目「${p.source_project_name}」` : ''}
                    </span>
                  </p>
                  {p.description && <p className="mt-0.5 text-[11px] text-gray-500">{p.description}</p>}
                </div>
                <div className="shrink-0 flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void applyCandidate(p.id)}
                    disabled={busy !== null}
                    className="text-xs px-2 py-1 rounded border text-gray-600 border-gray-300 hover:text-teal-700 hover:border-teal-300 disabled:opacity-50"
                  >
                    {busy === `apply:${p.id}` ? '启用中…' : '启用'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void dismissCandidate(p.id)}
                    disabled={busy !== null}
                    className="text-xs px-2 py-1 rounded border text-gray-500 border-gray-300 hover:text-red-600 hover:border-red-300 disabled:opacity-50"
                  >
                    {busy === `dismiss:${p.id}` ? '处理中…' : '忽略'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ③ 相似项目（只展示、不自动注入） */}
      <div>
        <p className="text-xs font-medium text-gray-600 flex items-center gap-1.5 mb-1">
          <Users className="w-3.5 h-3.5 text-blue-600" />相似项目
          <span className="text-[10px] font-normal text-gray-400">· 确定性相似度，有据才推荐、只展示</span>
        </p>
        {similar.length === 0 ? (
          <p className="text-[11px] text-gray-400">暂无依据充分的相似项目（不会为凑数推荐）。</p>
        ) : (
          <div className="space-y-1.5">
            {similar.map((s) => (
              <div key={s.projectId} className="p-2 bg-gray-50 rounded flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-gray-700">
                    {s.name || s.projectId.slice(0, 8)}
                    <span className="ml-2 text-[10px] font-normal text-gray-400">相似度 {Math.round(s.score * 100)}%</span>
                  </p>
                  {s.reasons.map((r, i) => (
                    <p key={i} className="mt-0.5 text-[11px] text-gray-500">{r}</p>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => navigate(`/projects/${s.projectId}`)}
                  className="shrink-0 flex items-center gap-1 text-xs px-2 py-1 rounded border text-gray-600 border-gray-300 hover:text-blue-700 hover:border-blue-300"
                >
                  去看看<ArrowRight className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
