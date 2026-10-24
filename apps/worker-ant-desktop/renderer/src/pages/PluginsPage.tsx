import { useState, useEffect } from 'react';
import { ansProxy } from '../lib/ipc';
import { Puzzle, RefreshCw, Trash2, Plus, Search, Download, Eye, Globe, X, Tag } from 'lucide-react';

interface Marketplace { id: string; name: string; source_type: string; source_url: string; status: string; last_refresh_at?: string; }
interface Plugin { id: string; marketplace_id: string; name: string; version: string; display_name?: string; description?: string; description_zh?: string; author?: string; language?: string; category?: string; tags?: string; state?: string; installed_version?: string; installed_at?: string; stars?: number; install_count?: number; enabled?: number; }

export default function PluginsPage() {
  const [marketplaces, setMarketplaces] = useState<Marketplace[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [categories, setCategories] = useState<{ category: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [activeCat, setActiveCat] = useState('');
  const [activeMarket, setActiveMarket] = useState('');
  const [sortBy, setSortBy] = useState<'stars' | 'installs' | 'name'>('stars');
  const [stateFilter, setStateFilter] = useState('available');
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [detailPlugin, setDetailPlugin] = useState<Plugin | null>(null);
  const [showMarketplaceForm, setShowMarketplaceForm] = useState(false);
  // zx_20260930 M15-⑤: ANS 侧插件列表**有条数上限**（缺省 100，活库 748 个 active ⇒ 此前静默截断）。
  //   这两个 state 把"条件命中的全量"与"已取到的条数"如实分开，界面据此说清"还有多少没看见"。
  const [pluginsTotal, setPluginsTotal] = useState(0);
  const [pluginsHasMore, setPluginsHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => { load(); }, [stateFilter, activeCat, activeMarket]);

  /** 筛选条件 → 查询串（首屏与"加载更多"共用**同一处**，免得两处各拼一遍漂开）。 */
  function pluginsQuery() {
    return [stateFilter !== 'all' && `state=${stateFilter}`, activeCat && `category=${activeCat}`, activeMarket && `marketplace_id=${activeMarket}`].filter(Boolean).join('&');
  }

  async function load() {
    setLoading(true); setError('');
    try {
      const qs = pluginsQuery();
      const [m, p, c] = await Promise.all([
        ansProxy.get<Marketplace[]>('/api/v1/plugins/marketplaces').catch(() => []),
        // 用 `getPaged`（而非 `get`）：`get` 会把 `total`/`has_more` 连同信封一起剥掉，界面就看不见"还有"。
        ansProxy.getPaged<Plugin>(`/api/v1/plugins${qs ? '?' + qs : ''}`).catch(() => ({ rows: [], total: 0, limit: null, offset: 0, has_more: false })),
        ansProxy.get<{ category: string; count: number }[]>(`/api/v1/plugins/categories${stateFilter !== 'all' ? '?state=' + stateFilter : ''}`).catch(() => []),
      ]);
      setMarketplaces((m as Marketplace[]) || []);
      setPlugins(p?.rows || []);
      setPluginsTotal(p?.total ?? 0);
      setPluginsHasMore(!!p?.has_more);
      setCategories((c as { category: string; count: number }[]) || []);
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  }

  /** 追加下一页（不重置已加载的——筛选一变才 `load()` 回到第一页）。 */
  async function loadMore() {
    setLoadingMore(true);
    try {
      const qs = pluginsQuery();
      const next = await ansProxy.getPaged<Plugin>(`/api/v1/plugins?${qs ? qs + '&' : ''}offset=${plugins.length}`);
      setPlugins(prev => [...prev, ...(next?.rows || [])]);
      setPluginsTotal(next?.total ?? pluginsTotal);
      setPluginsHasMore(!!next?.has_more);
    } catch (e) { setError((e as Error).message); }
    setLoadingMore(false);
  }

  async function handleInstall(id: string) {
    setInstalling(prev => new Set(prev).add(id));
    try { await ansProxy.post(`/api/v1/plugins/${id}/install`); load(); } catch(e) { alert('安装失败: ' + (e as Error).message); }
    setInstalling(prev => { const next = new Set(prev); next.delete(id); return next; });
  }
  async function handleUninstall(id: string) { if (!confirm('确定卸载？')) return; try { await ansProxy.delete(`/api/v1/plugins/${id}`); load(); } catch {} }
  async function handleEnable(id: string) { try { await ansProxy.post(`/api/v1/plugins/${id}/enable`); load(); } catch {} }
  async function handleDisable(id: string) { try { await ansProxy.post(`/api/v1/plugins/${id}/disable`); load(); } catch {} }
  async function handleStart(id: string) { try { await ansProxy.post(`/api/v1/plugins/${id}/start`); load(); } catch {} }
  async function handleStop(id: string) { try { await ansProxy.post(`/api/v1/plugins/${id}/stop`); load(); } catch {} }
  async function handleRefreshMarketplace(id: string) { try { await ansProxy.post(`/api/v1/plugins/marketplaces/${id}/refresh`); load(); } catch {} }
  async function handleDeleteMarketplace(id: string) { if (!confirm('删除市场将同时移除其下所有插件？')) return; try { await ansProxy.delete(`/api/v1/plugins/marketplaces/${id}`); load(); } catch {} }
  async function showDetail(id: string) { try { const r = await ansProxy.get<Plugin>(`/api/v1/plugins/${id}/detail`); setDetailPlugin(r as Plugin); } catch { alert('获取详情失败'); } }

  const filtered = plugins.filter(p => {
    if (search) {
      const q = search.toLowerCase();
      if (![p.name, p.display_name, p.description, p.description_zh].join(' ').toLowerCase().includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    if (sortBy === 'stars') return (b.stars || 0) - (a.stars || 0);
    if (sortBy === 'installs') return (b.install_count || 0) - (a.install_count || 0);
    return (a.display_name || a.name).localeCompare(b.display_name || b.name);
  });

  const marketplaceName = (id: string) => marketplaces.find(m => m.id === id)?.name || id?.slice(0, 8) || '';
  const catLabel = (c: string) => c === 'skill' ? '技能' : c === 'mcp' ? 'MCP' : c === 'a2a' ? 'A2A' : c;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">插件市场</h2>
        <div className="flex items-center gap-2">
          <button onClick={load} className="p-2 hover:bg-gray-100 rounded-lg" title="刷新"><RefreshCw className="w-4 h-4" /></button>
          <button onClick={() => setShowMarketplaceForm(true)} className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"><Globe className="w-3.5 h-3.5" />添加市场</button>
        </div>
      </div>
      {error && <p className="text-red-500 text-sm mb-4">错误: {error}</p>}

      {/* 状态切换 */}
      <div className="flex gap-2 mb-3">
        {[{v:'available',l:'未安装',c:'bg-blue-600'},{v:'installed',l:'已安装',c:'bg-green-600'},{v:'error',l:'错误',c:'bg-red-500'},{v:'all',l:'全部',c:'bg-gray-500'}].map(s => (
          <button key={s.v} onClick={() => setStateFilter(s.v)} className={`px-3 py-1 rounded-lg text-xs font-medium text-white ${stateFilter === s.v ? s.c : 'bg-gray-300'}`}>{s.l}</button>
        ))}
      </div>

      {/* 搜索 + 筛选 */}
      <div className="flex gap-2 mb-3 flex-wrap items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} className="w-full pl-9 pr-3 py-1.5 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="搜索插件..." />
        </div>
        <select value={activeMarket} onChange={e => setActiveMarket(e.target.value)} className="px-2 py-1.5 border rounded-lg text-sm bg-white">
          <option value="">全部市场</option>
          {marketplaces.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value as 'stars' | 'installs' | 'name')} className="px-2 py-1.5 border rounded-lg text-sm bg-white">
          <option value="stars">按评分排序</option>
          <option value="installs">按安装数排序</option>
          <option value="name">按名称排序</option>
        </select>
      </div>

      {/* 分类筛选 */}
      <div className="flex gap-1.5 mb-4 flex-wrap">
        <button onClick={() => setActiveCat('')} className={`px-2.5 py-1 rounded text-xs font-medium ${activeCat === '' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>全部</button>
        {categories.map(c => (
          <button key={c.category} onClick={() => setActiveCat(c.category)} className={`px-2.5 py-1 rounded text-xs font-medium ${activeCat === c.category ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{catLabel(c.category)} ({c.count})</button>
        ))}
      </div>

      {/* 市场来源 */}
      {marketplaces.length > 0 && (
        <div className="mb-4">
          <p className="text-xs text-gray-400 mb-2">市场来源 ({marketplaces.length})</p>
          <div className="flex gap-2 flex-wrap">
            {marketplaces.map(m => (
              <div key={m.id} className="flex items-center gap-2 border rounded-lg px-3 py-1.5 text-xs">
                <Globe className="w-3 h-3 text-blue-500" />
                <span className="font-medium">{m.name}</span>
                <span className="text-gray-400">{m.source_type}</span>
                <button onClick={() => handleRefreshMarketplace(m.id)} className="hover:bg-gray-100 rounded p-0.5" title="刷新"><RefreshCw className="w-3 h-3" /></button>
                <button onClick={() => handleDeleteMarketplace(m.id)} className="hover:bg-red-50 rounded p-0.5" title="删除"><Trash2 className="w-3 h-3 text-red-400" /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 条数如实（zx_20260930 M15-⑤）：总数与已加载分开说，且说清搜索/排序只作用于**已加载**的这批 */}
      {!loading && pluginsTotal > 0 && (
        <p className="text-xs text-gray-500 mb-2">
          共 {pluginsTotal} 个，已加载 {plugins.length} 个
          {pluginsHasMore && <span className="text-amber-600">（还有 {pluginsTotal - plugins.length} 个未显示 · 搜索与排序只作用于已加载的 {plugins.length} 个）</span>}
        </p>
      )}

      {/* 插件列表 */}
      {loading ? <div className="flex justify-center py-8"><div className="animate-spin h-6 w-6 border-2 border-blue-500 border-t-transparent rounded-full" /></div> : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(p => {
            const stars = Math.round(p.stars || 0);
            return (
              <div key={p.id} className="bg-white rounded-lg border p-4 hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between mb-2">
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold text-sm truncate">{p.display_name || p.name}
                      <span className="ml-1.5 text-xs text-gray-400">{p.language === 'zh' ? '🇨🇳' : ''}</span>
                    </h3>
                    <p className="text-xs text-gray-400">{p.name} v{p.version}</p>
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600 flex-shrink-0">{catLabel(p.category || '')}</span>
                </div>
                <p className="text-xs text-gray-500 mb-2 line-clamp-2">{p.description_zh || p.description}</p>
                <div className="flex items-center gap-1 mb-2 text-gray-400 text-xs">
                  <Globe className="w-2.5 h-2.5" />{marketplaceName(p.marketplace_id)}
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-yellow-500">{'★'.repeat(stars)}{'☆'.repeat(5 - stars)}</span>
                    <span className="text-gray-400">{p.install_count || 0}次安装</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => showDetail(p.id)} className="p-1 hover:bg-gray-100 rounded" title="详情"><Eye className="w-3.5 h-3.5 text-blue-500" /></button>
                    {p.state === 'installed' ? (
                      <>
                        {p.enabled === 0
                          ? <button onClick={() => handleEnable(p.id)} className="text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded hover:bg-green-200">启用</button>
                          : <button onClick={() => handleDisable(p.id)} className="text-xs px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded hover:bg-yellow-200">禁用</button>
                        }
                        {(p.category === 'mcp' || p.category === 'a2a') && p.enabled === 1 && (
                          <>
                            <button onClick={() => handleStart(p.id)} className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded hover:bg-blue-200" title="启动">▶</button>
                            <button onClick={() => handleStop(p.id)} className="text-xs px-2 py-0.5 bg-orange-100 text-orange-700 rounded hover:bg-orange-200" title="停止">■</button>
                          </>
                        )}
                        <button onClick={() => handleUninstall(p.id)} className="p-0.5 hover:bg-red-50 rounded"><Trash2 className="w-3 h-3 text-red-400" /></button>
                      </>
                    ) : p.state === 'error' ? (
                      <button onClick={() => handleUninstall(p.id)} className="text-xs px-2 py-0.5 bg-red-100 text-red-700 rounded">重试</button>
                    ) : (
                      <button onClick={() => handleInstall(p.id)} disabled={installing.has(p.id)}
                        className="flex items-center gap-1 text-xs px-2 py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
                        <Download className="w-3 h-3" />{installing.has(p.id) ? '安装中...' : '安装'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {!loading && filtered.length === 0 && (
        <div className="text-center py-10">
          <Puzzle className="w-12 h-12 mx-auto mb-3 text-gray-300" />
          <p className="text-sm text-gray-400">暂无插件。请先添加市场来源或刷新市场。</p>
        </div>
      )}

      {/* zx_20260930 M15-⑤：可翻页——此前超过 100 的部分**根本取不到**（后端硬 LIMIT 100 且无 offset） */}
      {!loading && pluginsHasMore && (
        <div className="flex justify-center mt-4">
          <button onClick={loadMore} disabled={loadingMore}
            className="px-4 py-1.5 border border-blue-300 text-blue-700 rounded-lg text-sm hover:bg-blue-50 disabled:opacity-50">
            {loadingMore ? '加载中...' : `加载更多（还剩 ${pluginsTotal - plugins.length} 个）`}
          </button>
        </div>
      )}

      {showMarketplaceForm && <MarketplaceDialog onClose={() => setShowMarketplaceForm(false)} onSuccess={load} />}
      {detailPlugin && <PluginDetailDialog plugin={detailPlugin} onClose={() => setDetailPlugin(null)}
        onInstall={() => handleInstall(detailPlugin.id)}
        onUninstall={() => { handleUninstall(detailPlugin.id); setDetailPlugin(null); }}
        onEnable={() => { handleEnable(detailPlugin.id); showDetail(detailPlugin.id); }}
        onDisable={() => { handleDisable(detailPlugin.id); showDetail(detailPlugin.id); }}
        installing={installing} />}
    </div>
  );
}

function MarketplaceDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [name, setName] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceType, setSourceType] = useState('github');
  const [sourceRef, setSourceRef] = useState('main');
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!name || !sourceUrl) return;
    setSaving(true);
    try {
      await ansProxy.post('/api/v1/plugins/marketplaces', { name, source_type: sourceType, source_url: sourceUrl, source_ref: sourceRef || undefined });
      onSuccess(); onClose();
      setTimeout(onSuccess, 2000);
    } catch {}
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">添加插件市场</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-3">
          <div><label className="block text-sm font-medium mb-1">市场名称 *</label><input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="如 worker-ant-official" /></div>
          <div><label className="block text-sm font-medium mb-1">来源类型 *</label>
            <select value={sourceType} onChange={e => setSourceType(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="github">GitHub</option>
              <option value="gitee">Gitee</option>
              <option value="url">URL</option>
            </select>
          </div>
          <div><label className="block text-sm font-medium mb-1">来源URL *</label><input value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder={sourceType === 'github' ? 'owner/repo' : 'https://...'} /></div>
          <div><label className="block text-sm font-medium mb-1">分支/标签</label><input value={sourceRef} onChange={e => setSourceRef(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="main" /></div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">取消</button>
          <button onClick={submit} disabled={!name || !sourceUrl || saving} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">{saving ? '保存中...' : '保存并刷新'}</button>
        </div>
      </div>
    </div>
  );
}

function PluginDetailDialog({ plugin, onClose, onInstall, onUninstall, onEnable, onDisable, installing }: {
  plugin: Plugin; onClose: () => void; onInstall: () => void; onUninstall: () => void; onEnable: () => void; onDisable: () => void; installing: Set<string>;
}) {
  const isInstalled = plugin.state === 'installed';
  const isEnabled = plugin.enabled !== 0;
  const stars = Math.round(plugin.stars || 0);
  // 运行时状态 + 插件配置 + 描述翻译内联
  const [runtimeStatus, setRuntimeStatus] = useState<Record<string, unknown> | null>(null);
  const [pluginConfig, setPluginConfig] = useState<Record<string, unknown> | null>(null);
  const [translatedText, setTranslatedText] = useState('');
  const [translating, setTranslating] = useState(false);
  useEffect(() => {
    if (!isInstalled) { setRuntimeStatus(null); setPluginConfig(null); return; }
    ansProxy.get<Record<string, unknown>>(`/api/v1/plugins/${plugin.id}/runtime-status`).then(r => setRuntimeStatus(r as Record<string, unknown>)).catch(() => setRuntimeStatus(null));
    ansProxy.get<Record<string, unknown>>(`/api/v1/plugins/${plugin.id}/config`).then(r => setPluginConfig(r as Record<string, unknown>)).catch(() => setPluginConfig(null));
  }, [plugin.id, isInstalled]);

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-lg p-6 w-full max-w-md max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">{plugin.display_name || plugin.name}</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600">{plugin.category === 'skill' ? '技能' : plugin.category === 'mcp' ? 'MCP' : plugin.category === 'a2a' ? 'A2A' : plugin.category}</span>
            {isInstalled && <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-700">已安装</span>}
            <span className="text-xs text-gray-400">v{plugin.version}</span>
          </div>
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span><span className="text-yellow-500">{'★'.repeat(stars)}{'☆'.repeat(5 - stars)}</span> {plugin.stars?.toFixed(1) || '-'}</span>
            <span><Download className="w-3 h-3 inline" /> {plugin.install_count || 0}次安装</span>
            {plugin.tags && <span><Tag className="w-3 h-3 inline" /> {plugin.tags}</span>}
            {plugin.author && <span>作者: {plugin.author}</span>}
          </div>
          {plugin.description && (
            <div className="p-3 bg-gray-50 rounded text-xs text-gray-600">
              {plugin.description}
              {plugin.language === 'en' && !plugin.description_zh && !translatedText && (
                <button onClick={async ()=>{setTranslating(true);try{const r=await ansProxy.post<{zh?:string}>('/api/v1/plugins/translate',{text:plugin.description||''});if(r&&(r as {zh?:string}).zh){setTranslatedText((r as {zh:string}).zh);}}catch{setTranslatedText('');}setTranslating(false);}} className="ml-2 text-blue-500 hover:text-blue-700 underline text-[10px]">{translating ? '翻译中...' : '翻译'}</button>
              )}
              {translatedText && (
                <div className="mt-2 pt-2 border-t border-gray-200 text-blue-800">中文: {translatedText}</div>
              )}
            </div>
          )}
          {plugin.description_zh && <div className="p-3 bg-blue-50 rounded text-xs text-blue-800">{plugin.description_zh}</div>}
          {/* 运行时状态 */}
          {isInstalled && runtimeStatus && (
            <div className="p-3 bg-gray-50 rounded text-xs">
              <p className="font-medium text-gray-600 mb-1">运行时状态</p>
              {Object.entries(runtimeStatus).map(([k, v]) => (
                <div key={k} className="flex justify-between py-0.5"><span className="text-gray-500">{k}</span><span>{String(v)}</span></div>
              ))}
            </div>
          )}
          {/* 插件配置 */}
          {isInstalled && pluginConfig && (
            <div className="p-3 bg-amber-50 rounded text-xs">
              <p className="font-medium text-amber-700 mb-1">插件配置</p>
              <pre className="text-[10px] font-mono whitespace-pre-wrap">{JSON.stringify(pluginConfig, null, 2)}</pre>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-3 border-t">
            <button onClick={onClose} className="px-3 py-1.5 border rounded-lg text-sm hover:bg-gray-50">关闭</button>
            {isInstalled ? (<>
              {isEnabled
                ? <button onClick={onDisable} className="px-3 py-1.5 border border-yellow-300 rounded-lg text-sm text-yellow-600 hover:bg-yellow-50">禁用</button>
                : <button onClick={onEnable} className="px-3 py-1.5 border border-green-300 rounded-lg text-sm text-green-600 hover:bg-green-50">启用</button>
              }
              <button onClick={onUninstall} className="px-3 py-1.5 border border-red-300 rounded-lg text-sm text-red-500 hover:bg-red-50"><Trash2 className="w-3 h-3 inline mr-1" />卸载</button>
            </>) : (
              <button onClick={onInstall} disabled={installing.has(plugin.id)} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"><Download className="w-3 h-3 inline mr-1" />{installing.has(plugin.id) ? '安装中...' : '安装'}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
