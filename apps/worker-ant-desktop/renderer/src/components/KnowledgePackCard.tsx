/**
 * zx_20261017_1 批七: 项目「知识包」卡——**预览**（哪些节真会被注入）+ **导出 JSONL**。
 *
 * ⚠ 预览与注入同一把尺：数据由 main 侧 `previewProjectKnowledge` 给（它读同一本册、
 *   调同一个 `selectKnowledgeForInject`、吃同一个 400-token 常量）。本卡不另算预算、不另择节。
 * ⚠ 导出**仅导出，不训练**：文件每行 `training:false`；卡上如实写这一句。
 *
 * zx_20261022_3 批七: 加 **导入**（Pro）——选一份导出的 `.jsonl` 带进本项目。
 *   · `merge`（缺省）只补本项目没有的节；同名不同内容记"冲突"不覆盖；
 *   · `replace` 显式覆盖——**须二次确认**（覆盖的是本项目已有知识，误点代价高）；
 *   · 结果如实上屏（写入/跳过/冲突各几节），并刷新预览——预览看到的即导入后的真册。
 *   ⚠ 导入是把内容**搬进来**；执行期注入对社区档照常（闸只挡搬运，不挡使用）。
 *
 * zx_20261022_3 批八: 加 **项目画像**（200 token 一屏：术语/验收/配方/教训 + 运行面）。
 *   · 本机生成/启停**不挂档位闸**（社区档照常自用）；Team 只挡"分享/从共享库取"。
 *   · 生成是**确定性派生**（零 LLM）：同输入同画像；书/运行面变了**不自动覆盖**，只标"已过期"。
 *   · 预算不增：画像 ≤200 token，知识书余量 = 400 − 画像实际 token。
 */
import { useCallback, useEffect, useState } from 'react';
import { BookOpen, Download, Power, RefreshCw, Upload, UserRound } from 'lucide-react';
import { knowledge } from '../lib/ipc';
import type { KnowledgeProfileView } from '../../../src/main/ipc/knowledge.ipc.js';
import type { KnowledgeExportResult } from '../../../src/main/core/knowledge-export.js';
import type { KnowledgeInjectionStats, ProjectKnowledgePreview } from '../../../src/main/core/project-knowledge.js';
import type {
  KnowledgeImportMode,
  KnowledgeImportRecord,
  KnowledgeImportResult,
} from '../../../src/main/core/knowledge-import.js';

export default function KnowledgePackCard({ projectId }: { projectId: string }) {
  const [preview, setPreview] = useState<ProjectKnowledgePreview | null>(null);
  const [stats, setStats] = useState<KnowledgeInjectionStats | null>(null);
  const [exported, setExported] = useState<KnowledgeExportResult | null>(null);
  const [imports, setImports] = useState<KnowledgeImportRecord[]>([]);
  const [imported, setImported] = useState<KnowledgeImportResult | null>(null);
  const [profile, setProfile] = useState<KnowledgeProfileView | null>(null);
  const [mode, setMode] = useState<KnowledgeImportMode>('merge');
  const [busy, setBusy] = useState<'preview' | 'export' | 'import' | 'profile' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setBusy('preview');
    try {
      // zx_20261018_1 批七 R-66：预览与注入成效一起读（两路互不依赖，并行取）。
      // zx_20261022_3 批七：导入账同批取（三路并行）。
      const [p, s, h, pf] = await Promise.all([
        knowledge.preview(projectId),
        knowledge.stats(projectId),
        knowledge.imports(projectId),
        knowledge.profile(projectId),
      ]);
      setPreview(p);
      setStats(s);
      setImports(h);
      setProfile(pf);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const doExport = useCallback(async () => {
    if (!projectId) return;
    setBusy('export');
    try {
      setExported(await knowledge.export(projectId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [projectId]);

  const doImport = useCallback(async () => {
    if (!projectId) return;
    const api = window.electronAPI;
    if (!api?.openFileDialog) { setError('当前环境不支持文件选择（未运行在桌面端）'); return; }
    let filePath: string | null = null;
    try { filePath = await api.openFileDialog(); } catch (e) { setError((e as Error).message); return; }
    if (!filePath) return;
    // 覆盖是本卡唯一会改写既有知识的动作 ⇒ 二次确认（默认档 merge 不动任何已有节）。
    if (mode === 'replace' && !window.confirm(
      '覆盖模式会用包里的内容替换本项目同名的知识节（含本项目新派生的事实）。确定继续？',
    )) return;

    setBusy('import');
    try {
      const r = await knowledge.import(projectId, filePath, mode);
      setImported(r);
      setError(null);
      await load();
    } catch (e) {
      setImported(null);
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [projectId, mode, load]);

  const doGenerateProfile = useCallback(async () => {
    if (!projectId) return;
    setBusy('profile');
    try {
      setProfile(await knowledge.profileGenerate(projectId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [projectId]);

  const doToggleProfile = useCallback(async (enabled: boolean) => {
    if (!projectId) return;
    setBusy('profile');
    try {
      setProfile(await knowledge.profileEnabled(projectId, enabled));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [projectId]);

  if (!projectId) return null;

  const selected = preview?.selected ?? [];
  const omitted = preview?.omitted ?? [];

  return (
    <div className="mt-3 bg-white rounded-lg border p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5 text-gray-700">
          <BookOpen className="w-4 h-4 text-indigo-500" />项目知识包
          {preview && (
            <span className="text-[10px] font-normal px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
              注入预算 {preview.budgetTokens} token
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy !== null}
            title="刷新预览"
            className="p-1 rounded hover:bg-gray-100 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-gray-400 ${busy === 'preview' ? 'animate-spin' : ''}`} />
          </button>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value === 'replace' ? 'replace' : 'merge')}
            disabled={busy !== null}
            title="导入模式：合并只补缺节；覆盖会替换同名节"
            className="text-xs px-1.5 py-1 rounded border text-gray-600 bg-white disabled:opacity-50"
          >
            <option value="merge">导入：合并（不覆盖）</option>
            <option value="replace">导入：覆盖同名节</option>
          </select>
          <button
            type="button"
            onClick={() => void doImport()}
            disabled={busy !== null}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded border text-gray-600 hover:text-indigo-600 hover:border-indigo-300 disabled:opacity-50"
          >
            <Upload className="w-3.5 h-3.5" />{busy === 'import' ? '导入中…' : '导入 JSONL'}
          </button>
          <button
            type="button"
            onClick={() => void doExport()}
            disabled={busy !== null}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded border text-gray-600 hover:text-indigo-600 hover:border-indigo-300 disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />{busy === 'export' ? '导出中…' : '导出 JSONL'}
          </button>
        </div>
      </div>

      <p className="text-[10px] text-gray-300 mb-2">
        预览的节 = 执行期真注入的节（同一把尺）；导出为整册，<strong>仅导出，不训练</strong>。
        导入是 Pro 能力：合并只补本项目没有的节，覆盖须二次确认。
      </p>

      {stats && (
        <p className="text-[11px] text-gray-500 mb-2">
          知识注入 {stats.injected} 次 · 成功 {stats.completed} / 失败 {stats.failed}
          {stats.pending > 0 && <span className="text-gray-400"> · 待结 {stats.pending}</span>}
        </p>
      )}

      {/* zx_20261022_3 批八：项目画像——确定性派生（零 LLM），生成/启停**不挂档位闸**（社区档照常自用）。 */}
      <div className="mt-2 border-t pt-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-gray-600 flex items-center gap-1.5">
            <UserRound className="w-3.5 h-3.5 text-indigo-400" />项目画像
            {profile && (
              <span className="text-[10px] font-normal px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-200">
                注入预算 {profile.budgetTokens} token（总预算 400 内，与知识书分摊）
              </span>
            )}
          </p>
          <div className="flex items-center gap-2">
            {profile?.profile && (
              <button
                type="button"
                onClick={() => void doToggleProfile(!profile.enabled)}
                disabled={busy !== null}
                title={profile.enabled ? '停用后不再注入（画像仍保留）' : '启用后执行期注入画像'}
                className={`flex items-center gap-1 text-xs px-2 py-1 rounded border disabled:opacity-50 ${
                  profile.enabled
                    ? 'text-emerald-700 border-emerald-300 bg-emerald-50'
                    : 'text-gray-500 border-gray-300 bg-white'
                }`}
              >
                <Power className="w-3.5 h-3.5" />{profile.enabled ? '已启用' : '未启用'}
              </button>
            )}
            <button
              type="button"
              onClick={() => void doGenerateProfile()}
              disabled={busy !== null}
              title="确定性派生（同输入同画像）；过期不会自动覆盖，须手动刷新"
              className="flex items-center gap-1 text-xs px-2 py-1 rounded border text-gray-600 hover:text-indigo-600 hover:border-indigo-300 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${busy === 'profile' ? 'animate-spin' : ''}`} />
              {busy === 'profile' ? '处理中…' : profile?.profile ? '刷新画像' : '生成画像'}
            </button>
          </div>
        </div>

        {profile && !profile.profile && (
          <p className="mt-1 text-[10px] text-gray-400">
            尚无画像。画像由本项目知识书与运行面**确定性派生**（零 LLM，≤{profile.budgetTokens} token）：同输入同画像。
          </p>
        )}

        {profile?.profile && (
          <div className="mt-1.5 space-y-1">
            <p className="text-[10px] text-gray-400">
              {profile.origin === 'imported'
                ? <>导入自 <span className="text-gray-500">{profile.sourceProjectName || '(未记项目名)'}</span>（导入画像默认不启用）</>
                : <>本机生成于 {profile.generatedAt}</>}
              {profile.stale && (
                <span className="ml-1 text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-0.5">
                  已过期：知识书或运行面已变，刷新后才会更新（不自动覆盖）
                </span>
              )}
            </p>
            {profile.profile.terms && (
              <p className="text-[11px] text-gray-600"><span className="text-gray-400">术语 · </span>{profile.profile.terms}</p>
            )}
            {profile.profile.acceptance && (
              <p className="text-[11px] text-gray-600 whitespace-pre-wrap break-words"><span className="text-gray-400">验收 · </span>{profile.profile.acceptance}</p>
            )}
            {profile.profile.recipes && (
              <p className="text-[11px] text-gray-600 whitespace-pre-wrap break-words"><span className="text-gray-400">配方 · </span>{profile.profile.recipes}</p>
            )}
            {profile.profile.lessons.length > 0 && (
              <p className="text-[11px] text-gray-600">
                <span className="text-gray-400">教训 · </span>{profile.profile.lessons.join('；')}
              </p>
            )}
            <p className="text-[10px] text-gray-400">
              运行面：任务 {profile.profile.runtime.tasks.total} · 成果 {profile.profile.runtime.deliverables.total}
              {' · '}外部调用 {profile.profile.runtime.calls.total}
              {profile.profile.runtime.lastModel ? ` · 最近模型 ${profile.profile.runtime.lastModel}` : ''}
            </p>
            <p className="text-[10px] text-gray-400">
              画像注入 {profile.stats.injections} 次 · 成功 {profile.stats.completed} / 失败 {profile.stats.failed}
            </p>
          </div>
        )}
      </div>

      {error && <p className="text-xs text-red-600">知识包操作未完成：{error}</p>}

      {!error && preview && selected.length === 0 && (
        <p className="text-xs text-gray-400">本项目暂无可派生的知识（知识册由 consolidate 作业从既有事实派生）。</p>
      )}

      {!error && selected.length > 0 && (
        <div className="space-y-2">
          {selected.map((s) => (
            <div key={s.section} className="p-2 bg-gray-50 rounded">
              <p className="text-xs font-medium text-gray-600 flex items-center gap-2">
                {s.label}
                <span className="text-[10px] font-normal text-gray-400">{s.lines} 行 · ≈{s.tokens} token</span>
              </p>
              <pre className="mt-1 text-[11px] text-gray-600 whitespace-pre-wrap break-words max-h-40 overflow-auto">{s.content}</pre>
            </div>
          ))}
        </div>
      )}

      {!error && (preview?.emptySections.length ?? 0) > 0 && (
        <p className="mt-2 text-[11px] text-gray-400">
          尚无事实、暂未产出的节（空源不造假壳）：
          {preview!.emptySections.map((s) => ` ${s.label}`).join('、')}
        </p>
      )}

      {!error && omitted.length > 0 && (
        <p className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          受 {preview?.budgetTokens} token 预算所限，以下节**未注入**（仍在册，可导出）：
          {omitted.map((s) => ` ${s.label}（${s.lines} 行 · ≈${s.tokens} token）`).join('；')}
        </p>
      )}

      {exported && (
        <p className="mt-2 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1 break-all">
          已导出 {exported.rows} 行 → {exported.filePath}
          <span className="text-emerald-600">（生成于 {exported.generated_at}；仅导出，不训练）</span>
        </p>
      )}

      {imported && (
        <p className="mt-2 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">
          已导入 {imported.imported} 节 · 跳过 {imported.skipped} 节 · 冲突 {imported.conflicts} 节
          <span className="text-emerald-600">
            （包内 {imported.sections} 节；模式 {imported.mode === 'replace' ? '覆盖同名节' : '合并（不覆盖）'}；
            包指纹 {imported.sourceHash.slice(0, 12)}）
          </span>
        </p>
      )}

      {imports.length > 0 && (
        <p className="mt-2 text-[10px] text-gray-400 break-all">
          最近一次导入：{imports[0]!.imported_at} · 来自项目 {imports[0]!.source_project_id || '(未记)'} ·
          {imports[0]!.mode === 'replace' ? '覆盖' : '合并'} · 写入 {imports[0]!.imported} / 跳过 {imports[0]!.skipped} /
          冲突 {imports[0]!.conflicts}
        </p>
      )}
    </div>
  );
}
