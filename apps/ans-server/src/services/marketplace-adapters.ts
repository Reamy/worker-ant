/**
 * URL市场适配器——从REST API市场获取插件数据。
 * 将外部API响应统一转换为ans_plugins表格式。
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('mkt-adapters');
// 失败冷却：同一市场5分钟内不重复报错
const failureCooldown = new Map<string, number>();

interface PluginEntry {
  name: string;
  display_name: string;
  description: string;
  language: string;
  category: string;
  tags: string[];
  author?: string;
  version?: string;
  stars?: number;
  install_count?: number;
}

type AdapterFn = (db: Database.Database, marketplaceId: string, sourceUrl: string) => Promise<number>;

const adapters: Record<string, AdapterFn> = {
  /** 通用GitHub市场：读取仓库src目录下子目录名作为插件列表 */
  async 'mcp-registry'(db, marketplaceId, sourceUrl) {
    const repoPath = sourceUrl.replace('https://github.com/', '').replace(/\/$/, '');
    const apiUrl = `https://api.github.com/repos/${repoPath}/contents/src`;
    const headers: Record<string, string> = { 'User-Agent': 'WorkerAnt/1.0', Accept: 'application/vnd.github.v3+json' };
    if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    const resp = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) throw new Error(`GitHub API HTTP ${resp.status} (可能需要GITHUB_TOKEN环境变量)`);
    const dirs = (await resp.json()) as Array<{ name: string; type: string; path: string }>;
    let count = 0;
    for (const d of dirs) {
      if (d.type !== 'dir') continue;
      upsertPlugin(db, marketplaceId, {
        name: `mcp-${d.name}`,
        display_name: d.name,
        description: `MCP服务器: ${d.name}`,
        language: 'en',
        category: 'mcp',
        tags: ['mcp', 'official'],
      });
      count++;
    }
    return count;
  },
  /** GitHub MCP Topic — 从GitHub搜索 topic:mcp-server 仓库 */
  async 'github-mcp-topic'(db, marketplaceId, sourceUrl) {
    const headers: Record<string, string> = { 'User-Agent': 'WorkerAnt/1.0', Accept: 'application/vnd.github.v3+json' };
    if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    const resp = await fetch(sourceUrl, { headers, signal: AbortSignal.timeout(15_000) });
    if (!resp.ok)
      throw new Error(
        `GitHub Search HTTP ${resp.status}${process.env.GITHUB_TOKEN ? '' : ' (匿名限流60次/时，建议配置GITHUB_TOKEN)'}`,
      );
    const data = (await resp.json()) as {
      items?: Array<{
        full_name: string;
        description: string;
        stargazers_count: number;
        topics: string[];
        language: string;
      }>;
    };
    const repos = data.items || [];
    let count = 0;
    for (const repo of repos) {
      const name = repo.full_name.replace('/', '-');
      const topics = repo.topics || [];
      let category = 'mcp';
      if (topics.includes('claude-code-plugin') || topics.includes('skill')) category = 'skill';
      else if (topics.includes('a2a') || topics.includes('agent')) category = 'a2a';
      upsertPlugin(db, marketplaceId, {
        name,
        display_name: repo.full_name,
        description: repo.description || '',
        language: repo.language?.toLowerCase() === 'zh' || repo.language?.toLowerCase() === 'zh-cn' ? 'zh' : 'en',
        category,
        tags: topics.slice(0, 5),
        author: repo.full_name.split('/')[0],
        stars: repo.stargazers_count,
        install_count: repo.stargazers_count,
      });
      count++;
    }
    return count;
  },
  /** A2A Registry: https://a2aregistry.org/api/agents */
  async a2aregistry(db, marketplaceId, sourceUrl) {
    const apiUrl = sourceUrl.includes('/api') ? sourceUrl : `${sourceUrl}/api/agents`;
    const resp = await fetch(apiUrl, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) throw new Error(`A2A Registry HTTP ${resp.status}`);
    const data = (await resp.json()) as
      | { agents?: Array<{ id: string; name: string; description: string }> }
      | Array<{ id: string; name: string; description: string }>;
    const agents = Array.isArray(data) ? data : data.agents || [];
    let count = 0;
    for (const a of agents.slice(0, 50)) {
      const name = a.id || a.name?.toLowerCase().replace(/\s+/g, '-') || '';
      if (!name) continue;
      upsertPlugin(db, marketplaceId, {
        name,
        display_name: a.name || name,
        description: a.description || '',
        language: 'en',
        category: 'a2a',
        tags: ['agent'],
        author: a.id ? 'A2A Registry' : undefined,
      });
      count++;
    }
    return count;
  },

  /** Smithery: https://registry.smithery.ai/servers */
  async smithery(db, marketplaceId, sourceUrl) {
    const apiUrl = sourceUrl.includes('/servers') ? sourceUrl : `${sourceUrl}/servers`;
    const resp = await fetch(apiUrl, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) throw new Error(`Smithery HTTP ${resp.status}`);
    const data = (await resp.json()) as {
      servers?: Array<{ qualifiedName: string; displayName: string; description: string }>;
    };
    const servers = data.servers || [];
    let count = 0;
    for (const s of servers.slice(0, 50)) {
      const name = s.qualifiedName?.replace(/\//g, '-') || '';
      if (!name) continue;
      upsertPlugin(db, marketplaceId, {
        name,
        display_name: s.displayName || name,
        description: s.description || '',
        language: 'en',
        category: 'mcp',
        tags: ['mcp', 'server'],
      });
      count++;
    }
    return count;
  },

  /** SkillsMP: GET https://skillsmp.com/api/v1/skills/search?q=a&limit=50 */
  async skillsmp(db, marketplaceId, sourceUrl) {
    const apiKey = process.env.SKILLSMP_API_KEY;
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'WorkerAnt-Marketplace/1.0' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const apiUrl = sourceUrl.includes('/search') ? sourceUrl : `${sourceUrl}/skills/search`;
    const resp = await fetch(`${apiUrl}?q=a&limit=50&sortBy=stars`, { headers, signal: AbortSignal.timeout(10_000) });
    if (resp.status === 429) throw new Error('SkillsMP API限流: 匿名50次/天，请配置SKILLSMP_API_KEY环境变量');
    if (!resp.ok) throw new Error(`SkillsMP HTTP ${resp.status}${apiKey ? '' : ' (匿名50次/天，可能已达上限)'}`);
    const body = (await resp.json()) as {
      success: boolean;
      data?: { skills: Array<{ id: string; name: string; description: string; author: string; stars: number }> };
      error?: { message: string };
    };
    if (!body.success || !body.data) throw new Error(body.error?.message || 'SkillsMP返回数据为空');
    let count = 0;
    for (const s of body.data.skills.slice(0, 50)) {
      const name = s.id || s.name?.toLowerCase().replace(/\s+/g, '-') || '';
      if (!name) continue;
      const isZh = /[一-鿿]/.test(s.description || '');
      upsertPlugin(db, marketplaceId, {
        name,
        display_name: s.name || name,
        description: s.description || '',
        language: isZh ? 'zh' : 'en',
        category: 'skill',
        tags: ['skill'],
        author: s.author,
        version: '1.0.0',
      });
      count++;
    }
    return count;
  },
};

/** 通用的URL市场刷新入口 */
export async function refreshUrlMarketplace(
  db: Database.Database,
  marketplaceId: string,
  sourceUrl: string,
  name: string,
): Promise<number> {
  const adapter = adapters[name];
  if (!adapter) {
    logger.warn({ name }, 'URL市场无适配器，跳过');
    return 0;
  }
  // 失败冷却：5分钟内不重复报错
  const lastFail = failureCooldown.get(name) || 0;
  if (lastFail > 0 && Date.now() - lastFail < 300_000) {
    return 0; // 静默跳过
  }
  try {
    const count = await adapter(db, marketplaceId, sourceUrl);
    logger.info({ name, count }, 'URL市场刷新完成');
    failureCooldown.delete(name);
    return count;
  } catch (err) {
    failureCooldown.set(name, Date.now());
    logger.error({ name, err: (err as Error).message }, 'URL市场刷新失败');
    throw err;
  }
}

function upsertPlugin(db: Database.Database, marketplaceId: string, entry: PluginEntry): void {
  const existing = db
    .prepare('SELECT id FROM ans_plugins WHERE marketplace_id = ? AND name = ?')
    .get(marketplaceId, entry.name) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      'UPDATE ans_plugins SET display_name=?, description=?, tags=?, language=?, stars=COALESCE(NULLIF(?,0), stars), install_count=MAX(install_count, ?) WHERE id=?',
    ).run(
      entry.display_name,
      entry.description,
      JSON.stringify(entry.tags),
      entry.language,
      entry.stars || 0,
      entry.install_count || 0,
      existing.id,
    );
  } else {
    db.prepare(
      'INSERT INTO ans_plugins (id, marketplace_id, name, version, display_name, description, category, tags, source_path, language, author, stars, install_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      randomUUID(),
      marketplaceId,
      entry.name,
      entry.version || '0.1.0',
      entry.display_name,
      entry.description,
      entry.category,
      JSON.stringify(entry.tags),
      '',
      entry.language,
      entry.author || '',
      entry.stars || 0,
      entry.install_count || 0,
    );
  }
}
