/**
 * 插件市场CRUD路由。
 * 管理插件市场注册、浏览、刷新。
 */
import type Database from 'better-sqlite3';
import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';

// MCP运行时进程管理（借鉴instructkr-claude-code的pluginLoader+McpServerConfig模式）
const mcpProcesses = new Map<string, { process: ChildProcess; port: number; name: string }>();
let _mcpNextPort = 19900;
const MCP_PORT_START = 19900;
const MCP_PORT_END = 19949;

function allocateMcpPort(): number {
  const used = new Set(Array.from(mcpProcesses.values()).map((p) => p.port));
  for (let port = MCP_PORT_START; port <= MCP_PORT_END; port++) {
    if (!used.has(port)) return port;
  }
  return MCP_PORT_START + Math.floor(Math.random() * 50);
}

function stopMcpProcess(pluginName: string): void {
  const entry = mcpProcesses.get(pluginName);
  if (entry) {
    try {
      entry.process.kill('SIGTERM');
    } catch {
      /* already dead */
    }
    mcpProcesses.delete(pluginName);
    logger.info({ pluginName, port: entry.port }, 'MCP插件进程已停止');
  }
}

/** 启动stdio类型的MCP服务器进程，返回监听的端口 */
async function startMcpProcess(
  pluginName: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  pluginDir: string,
): Promise<{ port: number; endpoint: string }> {
  const port = allocateMcpPort();
  const processEnv = {
    ...process.env,
    PORT: String(port),
    MCP_PORT: String(port),
    PLUGIN_ROOT: pluginDir,
    PLUGIN_DATA: resolve(pluginDir, 'data'),
    ...env,
  };

  return new Promise((resolvePromise, reject) => {
    try {
      // 展开命令中的环境变量
      const resolvedCmd = command.replace(/\$\{?(\w+)\}?/g, (_, v) => (processEnv as Record<string, string>)[v] || '');
      const resolvedArgs = args.map((a) =>
        a.replace(/\$\{?(\w+)\}?/g, (_, v) => (processEnv as Record<string, string>)[v] || ''),
      );

      logger.info({ pluginName, command: resolvedCmd, args: resolvedArgs, port }, '启动MCP插件进程');

      const proc = spawn(resolvedCmd, resolvedArgs, {
        cwd: pluginDir,
        env: processEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      });

      const timeout = setTimeout(() => {
        reject(new Error(`MCP进程启动超时(10s): ${pluginName}`));
      }, 10_000);

      let started = false;
      proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        if (
          !started &&
          (text.includes('listening') || text.includes('started') || text.includes('running') || text.includes('ready'))
        ) {
          started = true;
          clearTimeout(timeout);
          _mcpNextPort = port + 1;
          const endpoint = `http://localhost:${port}/mcp`;
          mcpProcesses.set(pluginName, { process: proc, port, name: pluginName });
          logger.info({ pluginName, port, endpoint }, 'MCP插件进程已启动');
          resolvePromise({ port, endpoint });
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        logger.info({ pluginName, stderr: text.slice(0, 200) }, 'MCP stderr');
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        logger.warn({ pluginName, err: err.message }, 'MCP进程启动失败');
        reject(err);
      });

      proc.on('exit', (code) => {
        logger.info({ pluginName, code }, 'MCP进程退出');
        mcpProcesses.delete(pluginName);
      });

      // 如果2秒内没有ready信号，也认为启动成功（有些MCP不走HTTP）
      setTimeout(() => {
        if (!started) {
          started = true;
          clearTimeout(timeout);
          _mcpNextPort = port + 1;
          const endpoint = `http://localhost:${port}/mcp`;
          mcpProcesses.set(pluginName, { process: proc, port, name: pluginName });
          logger.info({ pluginName, port, endpoint }, 'MCP进程已启动（无ready信号，假定成功）');
          resolvePromise({ port, endpoint });
        }
      }, 3000);
    } catch (err) {
      reject(err);
    }
  });
}
import { notFound, AppError, ErrorCode } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { refreshUrlMarketplace } from '../services/marketplace-adapters.js';
import { pluginTranslator } from '../services/plugin-translator.js';
import { resolveDependencies } from '../services/dependency-resolver.js';
import {
  validateMarketplaceSource,
  gitRefreshSteps,
  recordMarketplaceRefreshError,
  recordMarketplaceRefreshOk,
} from '../services/marketplace-source.js';
import { parsePagination, paginationClause, paginationArgs, pageMeta } from '../utils/pagination.js';

/** 从插件tags解析依赖声明（格式: dep:plugin-name） */
function parseDeps(tags: string): string[] {
  try {
    const arr = JSON.parse(tags) as string[];
    return arr.filter((t) => t.startsWith('dep:')).map((t) => t.slice(4));
  } catch {
    return [];
  }
}

const logger = createLogger('plugin-marketplace');

// plugin-cache 移出项目根目录避免 Turbopack EMFILE 溢出
// 默认: ~/works/my/study/worker-ant-data/plugin-cache
// 可通过 WORKER_ANT_DATA_DIR 环境变量覆盖
const DATA_ROOT = process.env.WORKER_ANT_DATA_DIR || resolve(process.cwd(), '../../../worker-ant-data');
const CACHE_DIR = resolve(DATA_ROOT, 'plugin-cache');
const INSTALL_DIR = resolve(process.cwd(), '../../data/plugins');
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
if (!existsSync(INSTALL_DIR)) mkdirSync(INSTALL_DIR, { recursive: true });

/** 借鉴OpenClaw+claude-code: 启动时从文件系统恢复已安装插件 */
export function recoverInstalledPlugins(db: Database.Database): number {
  if (!existsSync(INSTALL_DIR)) return 0;
  let recovered = 0;
  try {
    const dirs = readdirSync(INSTALL_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const dir of dirs) {
      const manifestPath = resolve(INSTALL_DIR, dir.name, 'plugin.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
        const pluginId = manifest.id as string;
        const existing = db.prepare('SELECT id FROM ans_plugins WHERE id = ?').get(pluginId) as
          | { id: string }
          | undefined;
        if (existing) {
          db.prepare(
            "UPDATE ans_plugins SET state = 'installed', installed_at = COALESCE(installed_at, datetime('now')) WHERE id = ? AND state != 'installed'",
          ).run(pluginId);
          recovered++;

          // 恢复MCP/A2A运行时进程（stdio类型需要重启子进程）
          const pluginName = manifest.name as string;
          const category = manifest.category as string;
          const registrations = (manifest.registrations as Array<{ type: string; ansId: string }>) || [];
          if (category === 'mcp') {
            // 从市场缓存读取plugin.json中的mcpServers配置
            const cachedManifest = _findPluginManifest(manifest.name as string);
            const mcpServers = (cachedManifest?.mcpServers as Record<string, Record<string, unknown>>) || {};
            for (const [serverName, mcpConfig] of Object.entries(mcpServers)) {
              const serverType = (mcpConfig?.type as string) || 'stdio';
              if (serverType === 'stdio' && mcpConfig?.command) {
                const command = mcpConfig.command as string;
                const args = (mcpConfig.args as string[]) || [];
                const env = (mcpConfig.env as Record<string, string>) || {};
                startMcpProcess(
                  `${pluginName}/${serverName}`,
                  command,
                  args,
                  env,
                  dir.path || resolve(INSTALL_DIR, pluginName),
                )
                  .then(({ endpoint }) => {
                    logger.info({ pluginName, serverName, endpoint }, 'MCP进程已恢复');
                    // 更新ANS注册的endpoint为实际端口
                    const reg = registrations.find((r) => r.type === 'mcp');
                    if (reg) {
                      db.prepare(
                        "UPDATE ans_mcp_servers SET endpoint = ?, status = 'active', health_check_at = datetime('now') WHERE id = ?",
                      ).run(endpoint, reg.ansId);
                    }
                  })
                  .catch((err) => {
                    logger.warn({ pluginName, serverName, err: (err as Error).message }, 'MCP进程恢复失败');
                  });
              }
            }
          }
        }
      } catch {
        /* skip invalid manifests */
      }
    }
  } catch {
    /* ignore */
  }
  if (recovered > 0) logger.info({ recovered }, '插件启动恢复完成');
  return recovered;
}

/** 从市场缓存中查找插件的完整manifest（含mcpServers配置） */
function _findPluginManifest(pluginName: string): Record<string, unknown> | null {
  const candidateDirs = [resolve(CACHE_DIR, pluginName)];
  try {
    // 搜索所有市场缓存目录
    if (existsSync(CACHE_DIR)) {
      const markets = readdirSync(CACHE_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
      for (const mkt of markets) {
        const p = resolve(CACHE_DIR, mkt.name, pluginName);
        if (existsSync(p)) candidateDirs.push(p);
        const subP = resolve(CACHE_DIR, mkt.name, 'plugins', pluginName);
        if (existsSync(subP)) candidateDirs.push(subP);
      }
    }
  } catch {
    /* ignore */
  }

  for (const dir of candidateDirs) {
    const candidates = [
      resolve(dir, '.claude-plugin', 'plugin.json'),
      resolve(dir, '.kimi-plugin', 'plugin.json'),
      resolve(dir, 'plugin.json'),
    ];
    for (const c of candidates) {
      if (!existsSync(c)) continue;
      try {
        const m = JSON.parse(readFileSync(c, 'utf-8')) as Record<string, unknown>;
        if (m.mcpServers || m.a2aServers || m.skills) return m;
        return m;
      } catch {
        /* skip */
      }
    }
  }
  return null;
}

/**
 * zx_20260930 M15-③：git 的**唯一执行出口**。
 * `execFile('git', argv)` —— argv 里每一项都是**参数**，不经 `/bin/sh` ⇒ 注入面在结构上消失
 *（原为 `execSync(`git reset --hard origin/${sourceRef}`)` 这类模板串拼 shell）。
 * 可注入：判据传 `runGit` 桩，即可在不 spawn 真 git 的前提下把「失败写账」的 0→1 跑出来。
 */
export const defaultRunGit = (argv: string[]): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    execFile('git', argv, { timeout: 30_000 }, (err) => (err ? reject(err) : resolvePromise()));
  });

export interface MarketplaceRefreshOpts {
  /** 跑一条 git 命令（默认 `defaultRunGit`：`execFile('git', argv)`，不经 shell）。 */
  runGit?: (argv: string[]) => Promise<void>;
  /** git 缓存根目录（默认 `CACHE_DIR`）。 */
  cacheDir?: string;
}

/** 刷新所有自动刷新的市场（供定时调度器调用）——异步，不阻塞事件循环 */
export async function refreshAllMarketplaces(
  db: Database.Database,
  opts: MarketplaceRefreshOpts = {},
): Promise<number> {
  const runGit = opts.runGit ?? defaultRunGit;
  const cacheDir = opts.cacheDir ?? CACHE_DIR;
  const markets = db
    .prepare(
      "SELECT id, name, source_type FROM ans_plugin_marketplaces WHERE status = 'active' AND auto_refresh = 1 AND source_type IN ('github', 'gitee')",
    )
    .all() as Array<{ id: string; name: string; source_type: string }>;
  let count = 0;
  for (const m of markets) {
    try {
      const mkt = db.prepare('SELECT * FROM ans_plugin_marketplaces WHERE id = ?').get(m.id) as
        | Record<string, unknown>
        | undefined;
      if (!mkt) continue;
      const name = mkt.name as string;
      // M15-③: 落库来源**先校验**再喂 git——旧行可能带非法 ref（`-` 开头会被 git 当选项解析），
      //   校验不过就记因跳过，绝不把一个可疑串交给 git。
      const check = validateMarketplaceSource({
        source_type: mkt.source_type as string,
        source_url: mkt.source_url as string,
        source_ref: (mkt.source_ref as string | undefined) ?? null,
      });
      if (!check.ok) {
        recordMarketplaceRefreshError(db, m.id, `市场来源不合法：${check.reason}`);
        continue;
      }
      const cachePath = resolve(cacheDir, name);
      const exists = existsSync(resolve(cachePath, '.git'));
      for (const argv of gitRefreshSteps({
        exists,
        sourceRef: check.value.source_ref,
        sourceUrl: check.value.source_url,
        cachePath,
      })) {
        await runGit(argv);
      }
      const manifestPath = resolve(cachePath, '.claude-plugin', 'marketplace.json');
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        for (const p of manifest.plugins || []) {
          const existing = db
            .prepare('SELECT id FROM ans_plugins WHERE marketplace_id = ? AND name = ?')
            .get(m.id, p.name) as { id: string } | undefined;
          if (existing) {
            db.prepare(
              'UPDATE ans_plugins SET version=?, display_name=?, description=?, category=?, tags=?, source_path=?, language=? WHERE id=?',
            ).run(
              p.version || '0.1.0',
              p.display_name || p.name,
              p.description || '',
              p.category || '',
              JSON.stringify(p.tags || []),
              p.source?.path || '',
              p.language || 'en',
              existing.id,
            );
          } else {
            db.prepare(
              'INSERT INTO ans_plugins (id, marketplace_id, name, version, display_name, description, category, tags, source_path, language) VALUES (?,?,?,?,?,?,?,?,?,?)',
            ).run(
              randomUUID(),
              m.id,
              p.name,
              p.version || '0.1.0',
              p.display_name || p.name,
              p.description || '',
              p.category || '',
              JSON.stringify(p.tags || []),
              p.source?.path || '',
              p.language || 'en',
            );
          }
        }
      }
      recordMarketplaceRefreshOk(db, m.id);
      count++;
    } catch (err) {
      // M15-③: 失败**有账**（因 + 时刻）——原为 `catch { /* skip failed market */ }`，静默到读不出因果。
      recordMarketplaceRefreshError(db, m.id, err instanceof Error ? err.message : String(err));
      logger.warn({ err, marketplace: m.id, name: m.name }, '市场自动刷新失败');
    }
  }
  if (count > 0) logger.info({ count }, '市场自动刷新完成');
  return count;
}

export function pluginMarketplaceRoutes(db: Database.Database, opts: MarketplaceRefreshOpts = {}) {
  const runGit = opts.runGit ?? defaultRunGit;
  return (
    new Elysia({ prefix: '/api/v1/plugins' })
      // ===== 市场管理 =====
      .get('/marketplaces', () => {
        const rows = db
          .prepare("SELECT * FROM ans_plugin_marketplaces WHERE status = 'active' ORDER BY created_at DESC")
          .all();
        return { data: rows };
      })
      // M15-③: **入口即校验**——`source_type`/`source_url`/`source_ref` 三者在此判死才落库。
      //   此前零校验：`source_ref = "main; rm -rf ~"` 会被下游拼进 shell 执行。
      .post(
        '/marketplaces',
        ({ body, set }) => {
          const check = validateMarketplaceSource({
            source_type: body.source_type,
            source_url: body.source_url,
            source_ref: body.source_ref ?? null,
          });
          if (!check.ok) throw new AppError(ErrorCode.INVALID_REQUEST, `市场来源不合法：${check.reason}`, 400);
          const id = randomUUID();
          db.prepare(
            'INSERT INTO ans_plugin_marketplaces (id, name, source_type, source_url, source_ref) VALUES (?, ?, ?, ?, ?)',
          ).run(id, body.name, check.value.source_type, check.value.source_url, check.value.source_ref);
          set.status = 201;
          return { data: { id, name: body.name } };
        },
        {
          body: t.Object({
            name: t.String(),
            source_type: t.String(),
            source_url: t.String(),
            source_ref: t.Optional(t.String()),
          }),
        },
      )
      .post('/marketplaces/:id/refresh', async ({ params: { id }, set }) => {
        const mkt = db.prepare('SELECT * FROM ans_plugin_marketplaces WHERE id = ?').get(id) as
          | Record<string, unknown>
          | undefined;
        if (!mkt) throw notFound('Marketplace', id);
        const name = mkt.name as string;
        // M15-③: 落库来源先校验（旧行可能带非法 ref）——不校验就拿去跑 git 等于把注入面留给历史数据。
        const check = validateMarketplaceSource({
          source_type: mkt.source_type as string,
          source_url: mkt.source_url as string,
          source_ref: (mkt.source_ref as string | undefined) ?? null,
        });
        if (!check.ok) throw new AppError(ErrorCode.INVALID_REQUEST, `市场来源不合法：${check.reason}`, 400);
        const sourceUrl = check.value.source_url;
        try {
          // URL类型 + github-topics等API搜索类型通过适配器刷新
          if (check.value.source_type === 'url' || check.value.source_type === 'github-topics') {
            const count = await refreshUrlMarketplace(db, id, sourceUrl, name);
            recordMarketplaceRefreshOk(db, id);
            return { data: { id, name, refreshed: true, pluginCount: count, via: 'adapter' } };
          }
          const cachePath = resolve(opts.cacheDir ?? CACHE_DIR, name);
          const exists = existsSync(resolve(cachePath, '.git'));
          for (const argv of gitRefreshSteps({ exists, sourceRef: check.value.source_ref, sourceUrl, cachePath })) {
            await runGit(argv);
          }
          const manifestPath = resolve(cachePath, '.claude-plugin', 'marketplace.json');
          if (existsSync(manifestPath)) {
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
            const plugins = manifest.plugins || [];
            for (const p of plugins) {
              const existing = db
                .prepare('SELECT id FROM ans_plugins WHERE marketplace_id = ? AND name = ?')
                .get(id, p.name) as { id: string } | undefined;
              if (existing) {
                db.prepare(
                  'UPDATE ans_plugins SET version=?, display_name=?, description=?, category=?, tags=?, source_path=? WHERE id=?',
                ).run(
                  p.version || '0.1.0',
                  p.display_name || p.name,
                  p.description || '',
                  p.category || '',
                  JSON.stringify(p.tags || []),
                  p.source?.path || '',
                  existing.id,
                );
              } else {
                db.prepare(
                  'INSERT INTO ans_plugins (id, marketplace_id, name, version, display_name, description, category, tags, source_path, language) VALUES (?,?,?,?,?,?,?,?,?,?)',
                ).run(
                  randomUUID(),
                  id,
                  p.name,
                  p.version || '0.1.0',
                  p.display_name || p.name,
                  p.description || '',
                  p.category || '',
                  JSON.stringify(p.tags || []),
                  p.source?.path || '',
                  p.language || 'en',
                );
              }
            }
          }
          recordMarketplaceRefreshOk(db, id);
          const pluginCount = db.prepare('SELECT COUNT(*) as c FROM ans_plugins WHERE marketplace_id = ?').get(id) as {
            c: number;
          };
          return { data: { id, name, refreshed: true, pluginCount: pluginCount.c } };
        } catch (err) {
          // M15-③/④: 失败**写账**（因 + 时刻）；响应体不再回 `(err as Error).message`
          //   ——那个串可能带着内网 URL / 命令原文，等于把内部细节交给调用方。
          recordMarketplaceRefreshError(db, id, err instanceof Error ? err.message : String(err));
          logger.warn({ err, marketplace: id, name }, '市场刷新失败');
          set.status = 500;
          return { error: { code: 'REFRESH_FAILED', message: 'Marketplace refresh failed' } };
        }
      })
      .delete('/marketplaces/:id', ({ params: { id } }) => {
        db.prepare("UPDATE ans_plugin_marketplaces SET status = 'disabled' WHERE id = ?").run(id);
        db.prepare("UPDATE ans_plugins SET state = 'available', status = 'disabled' WHERE marketplace_id = ?").run(id);
        return { data: { id, status: 'disabled' } };
      })

      // ===== 插件浏览 =====
      .get('/', ({ query }) => {
        const marketplaceId = query?.marketplace_id as string | undefined;
        const category = query?.category as string | undefined;
        const search = query?.search as string | undefined;
        const state = (query?.state as string) || 'available';
        // M15-⑤: 原为硬 `LIMIT 100`——活库 748 个 active 插件，界面**静默**只看见 100 个
        //   （且客户端"按星排序"只在这 100 里排）。现补 `total` + `limit/offset` + `has_more`：
        //   缺省 limit 仍取 100（**不改 GUI 现阅读到的条数**），够不够由调用方按 `has_more` 决定。
        const where: string[] = ["status = 'active'"];
        const params: unknown[] = [];
        if (marketplaceId) {
          where.push('marketplace_id = ?');
          params.push(marketplaceId);
        }
        if (category) {
          where.push('category = ?');
          params.push(category);
        }
        if (state !== 'all') {
          where.push('state = ?');
          params.push(state);
        }
        if (search) {
          where.push('(name LIKE ? OR display_name LIKE ? OR description LIKE ? OR description_zh LIKE ?)');
          params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
        }
        const whereSql = ` WHERE ${where.join(' AND ')}`;
        const total = (db.prepare(`SELECT COUNT(*) as c FROM ans_plugins${whereSql}`).get(...params) as { c: number })
          .c;
        const page = parsePagination(query as Record<string, unknown>, 100);
        const plugins = db
          .prepare(`SELECT * FROM ans_plugins${whereSql} ORDER BY created_at DESC${paginationClause(page)}`)
          .all(...params, ...paginationArgs(page)) as Array<Record<string, unknown>>;
        // 后台异步翻译（非阻塞）
        pluginTranslator
          .translateBatch(
            plugins.map((p) => ({
              id: p.id as string,
              name: p.name as string,
              description: (p.description as string) || '',
              language: p.language as string,
              description_zh: (p.description_zh as string) || null,
            })),
          )
          .then(() => {
            // 翻译结果写回数据库
            for (const p of plugins) {
              if (p.description_zh && (p.description_zh as string).length > 0) {
                db.prepare('UPDATE ans_plugins SET description_zh = ? WHERE id = ?').run(p.description_zh, p.id);
              }
            }
          })
          .catch(() => {});
        // M15-⑤: `total`/`has_more` 如实告知"后面还有"（原为静默截断到 100）
        return { data: plugins, ...pageMeta(total, page, plugins.length) };
      })
      .get('/categories', ({ query }) => {
        const state = (query?.state as string) || 'available';
        const rows = db
          .prepare(
            `SELECT DISTINCT category, COUNT(*) as count FROM ans_plugins WHERE status = 'active' AND (state = ? OR ? = 'all') GROUP BY category`,
          )
          .all(state, state);
        return { data: rows };
      })
      // 按需翻译（必须在:id动态路由前，避免被拦截）
      .post(
        '/translate',
        async ({ body }) => {
          const text = body?.text as string;
          if (!text || text.length < 10) return { zh: '' };
          try {
            const zh = await pluginTranslator.translateLongText(text);
            return { zh: zh !== text ? zh : '' };
          } catch {
            return { zh: '' };
          }
        },
        { body: t.Optional(t.Object({ text: t.String() })) },
      )
      .get('/:id', ({ params: { id } }) => {
        const plugin = db.prepare("SELECT * FROM ans_plugins WHERE id = ? AND status = 'active'").get(id) as
          | Record<string, unknown>
          | undefined;
        if (!plugin) throw notFound('Plugin', id);
        const registrations = db.prepare('SELECT * FROM ans_plugin_registrations WHERE plugin_id = ?').all(id);
        return { data: { ...plugin, registrations } };
      })

      // 借鉴claude-code: enable/disable独立于install/uninstall
      .post('/:id/enable', ({ params: { id }, set }) => {
        const plugin = db
          .prepare("SELECT id, name, state FROM ans_plugins WHERE id = ? AND status = 'active'")
          .get(id) as Record<string, unknown> | undefined;
        if (!plugin) throw notFound('Plugin', id);
        if (plugin.state !== 'installed') {
          set.status = 400;
          return { error: { code: 'NOT_INSTALLED', message: '只能启用已安装的插件' } };
        }
        // 重新激活ANS资源注册
        const registrations = db
          .prepare('SELECT resource_type, ans_resource_id FROM ans_plugin_registrations WHERE plugin_id = ?')
          .all(id) as Array<{ resource_type: string; ans_resource_id: string }>;
        for (const reg of registrations) {
          if (reg.resource_type === 'skill')
            db.prepare("UPDATE ans_skills SET status = 'active' WHERE id = ?").run(reg.ans_resource_id);
          else if (reg.resource_type === 'mcp')
            db.prepare("UPDATE ans_mcp_servers SET status = 'active' WHERE id = ?").run(reg.ans_resource_id);
          else if (reg.resource_type === 'a2a')
            db.prepare("UPDATE ans_a2a_servers SET status = 'active' WHERE id = ?").run(reg.ans_resource_id);
        }
        db.prepare('UPDATE ans_plugins SET enabled = 1 WHERE id = ?').run(id);
        return { data: { id, enabled: true } };
      })
      .post('/:id/disable', ({ params: { id }, set }) => {
        const plugin = db
          .prepare("SELECT id, name, state FROM ans_plugins WHERE id = ? AND status = 'active'")
          .get(id) as Record<string, unknown> | undefined;
        if (!plugin) throw notFound('Plugin', id);
        if (plugin.state !== 'installed') {
          set.status = 400;
          return { error: { code: 'NOT_INSTALLED', message: '只能禁用已安装的插件' } };
        }
        const registrations = db
          .prepare('SELECT resource_type, ans_resource_id FROM ans_plugin_registrations WHERE plugin_id = ?')
          .all(id) as Array<{ resource_type: string; ans_resource_id: string }>;
        for (const reg of registrations) {
          if (reg.resource_type === 'skill')
            db.prepare("UPDATE ans_skills SET status = 'disabled' WHERE id = ?").run(reg.ans_resource_id);
          else if (reg.resource_type === 'mcp')
            db.prepare("UPDATE ans_mcp_servers SET status = 'disabled' WHERE id = ?").run(reg.ans_resource_id);
          else if (reg.resource_type === 'a2a')
            db.prepare("UPDATE ans_a2a_servers SET status = 'disabled' WHERE id = ?").run(reg.ans_resource_id);
        }
        db.prepare('UPDATE ans_plugins SET enabled = 0 WHERE id = ?').run(id);
        return { data: { id, enabled: false } };
      })

      // ===== 插件安装 =====
      .post(
        '/:id/install',
        async ({ params: { id }, body, set }) => {
          const plugin = db.prepare("SELECT * FROM ans_plugins WHERE id = ? AND status = 'active'").get(id) as
            | Record<string, unknown>
            | undefined;
          if (!plugin) throw notFound('Plugin', id);
          if (plugin.state === 'installed')
            return { data: { id, state: 'installed', message: '已安装，无需重复操作' } };
          db.prepare("UPDATE ans_plugins SET state = 'installing' WHERE id = ?").run(id);
          try {
            // 依赖检查（借鉴claude-code dependencyResolver）
            const deps = parseDeps((plugin.tags as string) || '[]');
            if (deps.length > 0) {
              const { missing, cycle } = resolveDependencies(db, [id], (pid) => {
                // 从marketplace缓存读取manifest获取依赖
                try {
                  const p = db.prepare('SELECT tags FROM ans_plugins WHERE id = ?').get(pid) as
                    | { tags: string }
                    | undefined;
                  return parseDeps(p?.tags || '[]');
                } catch {
                  return [];
                }
              });
              if (cycle) {
                set.status = 400;
                return { error: { code: 'CYCLE', message: '插件依赖存在循环引用' } };
              }
              if (missing.length > 0) {
                set.status = 400;
                return { error: { code: 'MISSING_DEPS', message: `缺少依赖: ${missing.join(', ')}` } };
              }
            }
            if (body?.config) {
              db.prepare('UPDATE ans_plugins SET user_config = ? WHERE id = ?').run(JSON.stringify(body.config), id);
            }
            const category = (plugin.category as string) || 'skill';
            const marketplaceId = plugin.marketplace_id as string;
            const pluginName = plugin.name as string;
            const sourcePath = (plugin.source_path as string) || '';

            // 20.1: 从市场缓存提取插件代码（多路径搜索）
            const market = db.prepare('SELECT * FROM ans_plugin_marketplaces WHERE id = ?').get(marketplaceId) as
              | Record<string, unknown>
              | undefined;
            const marketName = (market?.name as string) || '';
            const cachePath = resolve(CACHE_DIR, marketName);
            // 搜索顺序: 市场内子目录 > 市场根目录 > 独立缓存(data/plugin-cache/{pluginName})
            const candidateDirs = [
              sourcePath ? resolve(cachePath, sourcePath) : null,
              resolve(cachePath, pluginName),
              resolve(CACHE_DIR, pluginName), // 外部git源独立缓存
            ].filter(Boolean) as string[];
            let pluginDir = '';
            let manifestPath = '';
            for (const dir of candidateDirs) {
              // 检查.claude-plugin/plugin.json
              const claudeManifest = resolve(dir, '.claude-plugin', 'plugin.json');
              const plainManifest = resolve(dir, 'plugin.json');
              const kimiManifest = resolve(dir, '.kimi-plugin', 'plugin.json');
              if (existsSync(claudeManifest)) {
                pluginDir = dir;
                manifestPath = claudeManifest;
                break;
              }
              if (existsSync(plainManifest)) {
                pluginDir = dir;
                manifestPath = plainManifest;
                break;
              }
              if (existsSync(kimiManifest)) {
                pluginDir = dir;
                manifestPath = kimiManifest;
                break;
              }
              // 无plugin.json但有子目录(可能是skills插件)
              if (existsSync(dir) && !pluginDir) pluginDir = dir;
            }
            if (!pluginDir) pluginDir = resolve(cachePath, pluginName);

            // 20.2: 从候选目录中选择包含扩展点(skills/mcpServers/a2aServers)的最优manifest
            let bestManifest: Record<string, unknown> | null = null;
            const candidates = [
              resolve(pluginDir, '.claude-plugin', 'plugin.json'),
              resolve(pluginDir, '.kimi-plugin', 'plugin.json'),
              resolve(pluginDir, 'plugin.json'),
            ];
            for (const c of candidates) {
              if (!existsSync(c)) continue;
              try {
                const m = JSON.parse(readFileSync(c, 'utf-8')) as Record<string, unknown>;
                if (!bestManifest) {
                  bestManifest = m;
                  manifestPath = c;
                }
                if (m.skills || m.mcpServers || m.a2aServers) {
                  bestManifest = m;
                  manifestPath = c;
                  break;
                }
              } catch {
                /* skip */
              }
            }

            if (!bestManifest) {
              // 无manifest但有插件元数据，允许安装（使用数据库元数据兜底）
            } else if (!bestManifest.name || !bestManifest.version) {
              set.status = 400;
              return { error: { code: 'INVALID_MANIFEST', message: 'plugin.json缺少name或version字段' } };
            }

            const regId = randomUUID();
            const registrations: Array<{ type: string; ansId: string }> = [];

            // 按分类注册到ANS（优先用plugin.json，无则用数据库元数据兜底）
            if (category === 'skill' || (category !== 'mcp' && category !== 'a2a')) {
              // 借鉴claude-code: skills字段可以是字符串(目录路径)或数组
              const skillsDir = typeof bestManifest?.skills === 'string' ? (bestManifest.skills as string) : null;
              const skillNames: string[] = [];
              if (skillsDir) {
                const skillsFullPath = resolve(pluginDir, skillsDir);
                if (existsSync(skillsFullPath)) {
                  try {
                    const dirs = readdirSync(skillsFullPath, { withFileTypes: true }).filter((d) => d.isDirectory());
                    skillNames.push(...dirs.map((d) => d.name));
                  } catch {
                    /* ignore */
                  }
                }
              }
              const skills = (bestManifest?.skills as Array<Record<string, unknown>>) || [];
              if (skillNames.length > 0) {
                // 从目录名注册多个技能
                for (const sn of skillNames) {
                  const skillId = randomUUID();
                  const skillMdPath = resolve(pluginDir, skillsDir!, sn, 'SKILL.md');
                  const desc = existsSync(skillMdPath)
                    ? readFileSync(skillMdPath, 'utf-8').slice(0, 500)
                    : ((plugin.description || sn) as string);
                  db.prepare(
                    'INSERT OR IGNORE INTO ans_skills (id, name, description, input_schema, tags, status) VALUES (?, ?, ?, \'{"type":"object","properties":{},"required":[]}\', ?, \'active\')',
                  ).run(skillId, sn, desc, JSON.stringify([category, sn]));
                  registrations.push({ type: 'skill', ansId: skillId });
                }
              } else if (skills.length > 0) {
                for (const skill of skills) {
                  const skillId = randomUUID();
                  const inputSchema = skill.input_schema
                    ? JSON.stringify(skill.input_schema)
                    : '{"type":"object","properties":{},"required":[]}';
                  db.prepare(
                    "INSERT OR IGNORE INTO ans_skills (id, name, description, input_schema, tags, status) VALUES (?, ?, ?, ?, ?, 'active')",
                  ).run(
                    skillId,
                    (skill.name || pluginName) as string,
                    (skill.description || plugin.description) as string,
                    inputSchema,
                    JSON.stringify([category]),
                  );
                  registrations.push({ type: 'skill', ansId: skillId });
                }
              } else {
                // 无manifest兜底：用插件元数据注册基础技能
                const skillId = randomUUID();
                db.prepare(
                  'INSERT OR IGNORE INTO ans_skills (id, name, description, input_schema, tags, status) VALUES (?, ?, ?, \'{"type":"object","properties":{},"required":[]}\', ?, \'active\')',
                ).run(
                  skillId,
                  pluginName,
                  (plugin.description || plugin.display_name || pluginName) as string,
                  JSON.stringify([category || 'skill']),
                );
                registrations.push({ type: 'skill', ansId: skillId });
              }
            } else if (category === 'mcp') {
              // 借鉴instructkr-claude-code: 支持stdio(本地进程)/sse/http(远程)三种MCP服务器类型
              const mcpServers = (bestManifest?.mcpServers as Record<string, Record<string, unknown>>) || {};
              const mcpEntries = Object.entries(mcpServers);
              for (const [serverName, mcpConfig] of mcpEntries) {
                const mcpId = randomUUID();
                const serverType = (mcpConfig?.type as string) || 'stdio';
                let endpoint: string;
                let transport: string;
                let status = 'active';

                if (serverType === 'stdio') {
                  // 本地进程模式：启动MCP服务器子进程
                  const command = mcpConfig?.command as string;
                  const args = (mcpConfig?.args as string[]) || [];
                  const env = (mcpConfig?.env as Record<string, string>) || {};
                  if (!command) {
                    logger.warn({ pluginName, serverName }, 'stdio类型MCP缺少command，标记healing');
                    status = 'healing';
                    endpoint = `http://localhost:${allocateMcpPort()}/mcp`;
                    transport = 'streamable-http';
                  } else {
                    try {
                      const result = await startMcpProcess(
                        `${pluginName}/${serverName}`,
                        command,
                        args,
                        env,
                        pluginDir,
                      );
                      endpoint = result.endpoint;
                      transport = 'streamable-http';
                      logger.info({ pluginName, serverName, endpoint }, 'stdio MCP进程已启动');
                    } catch (err) {
                      logger.warn({ pluginName, serverName, err }, 'stdio MCP进程启动失败，标记healing');
                      status = 'healing';
                      endpoint = `http://localhost:${allocateMcpPort()}/mcp`;
                      transport = 'streamable-http';
                    }
                  }
                } else if (serverType === 'sse' || serverType === 'http' || serverType === 'ws') {
                  // 远程服务模式：直接使用提供的URL
                  endpoint =
                    (mcpConfig?.url as string) ||
                    (mcpConfig?.endpoint as string) ||
                    `http://localhost:${allocateMcpPort()}/mcp`;
                  transport = serverType === 'ws' ? 'ws' : 'streamable-http';
                } else {
                  // 无类型声明 → 假设是streamable-http
                  endpoint =
                    (mcpConfig?.endpoint as string) ||
                    (mcpConfig?.url as string) ||
                    `http://localhost:${allocateMcpPort()}/mcp`;
                  transport = (mcpConfig?.transport as string) || 'streamable-http';
                }

                db.prepare(
                  'INSERT OR IGNORE INTO ans_mcp_servers (id, name, endpoint, transport, status) VALUES (?, ?, ?, ?, ?)',
                ).run(mcpId, (mcpConfig?.name || serverName || pluginName) as string, endpoint, transport, status);
                registrations.push({ type: 'mcp', ansId: mcpId });
              }
              // 无mcpServers声明：metadata-only插件（如brave），注册标记healing
              if (mcpEntries.length === 0) {
                const mcpId = randomUUID();
                const port = allocateMcpPort();
                db.prepare(
                  "INSERT OR IGNORE INTO ans_mcp_servers (id, name, endpoint, transport, status) VALUES (?, ?, ?, ?, 'healing')",
                ).run(mcpId, pluginName, `http://localhost:${port}/mcp`, 'streamable-http');
                registrations.push({ type: 'mcp', ansId: mcpId });
                logger.info({ pluginName }, 'MCP插件无mcpServers声明，标记healing（需用户手动配置）');
              }
            } else if (category === 'a2a') {
              // 借鉴同MCP的模式，支持stdio和http两种A2A服务器类型
              const a2aServers = (bestManifest?.a2aServers as Record<string, Record<string, unknown>>) || {};
              const a2aEntries = Object.entries(a2aServers);
              for (const [serverName, a2aConfig] of a2aEntries) {
                const a2aId = randomUUID();
                const serverType = (a2aConfig?.type as string) || 'http';
                let agentCardUrl: string;
                let status = 'active';

                if (serverType === 'stdio') {
                  const command = a2aConfig?.command as string;
                  const args = (a2aConfig?.args as string[]) || [];
                  const env = (a2aConfig?.env as Record<string, string>) || {};
                  if (!command) {
                    status = 'healing';
                    agentCardUrl = `http://localhost:${19950 + Math.floor(Math.random() * 49)}/.well-known/agent.json`;
                  } else {
                    try {
                      const result = await startMcpProcess(
                        `${pluginName}/${serverName}`,
                        command,
                        args,
                        env,
                        pluginDir,
                      );
                      agentCardUrl = result.endpoint.replace('/mcp', '/.well-known/agent.json');
                      logger.info({ pluginName, serverName, agentCardUrl }, 'stdio A2A进程已启动');
                    } catch (err) {
                      status = 'healing';
                      agentCardUrl = `http://localhost:${19950 + Math.floor(Math.random() * 49)}/.well-known/agent.json`;
                    }
                  }
                } else {
                  agentCardUrl =
                    (a2aConfig?.agentCardUrl as string) ||
                    (a2aConfig?.url as string) ||
                    `http://localhost:${19950 + Math.floor(Math.random() * 49)}/.well-known/agent.json`;
                }

                db.prepare(
                  'INSERT OR IGNORE INTO ans_a2a_servers (id, name, agent_card_url, status) VALUES (?, ?, ?, ?)',
                ).run(a2aId, (a2aConfig?.name || serverName || pluginName) as string, agentCardUrl, status);
                registrations.push({ type: 'a2a', ansId: a2aId });
              }
              if (a2aEntries.length === 0) {
                const a2aId = randomUUID();
                db.prepare(
                  "INSERT OR IGNORE INTO ans_a2a_servers (id, name, agent_card_url, status) VALUES (?, ?, ?, ?, 'healing')",
                ).run(
                  a2aId,
                  pluginName,
                  `http://localhost:${19950 + Math.floor(Math.random() * 49)}/.well-known/agent.json`,
                );
                registrations.push({ type: 'a2a', ansId: a2aId });
              }
            }

            // 记录注册关联
            for (const reg of registrations) {
              db.prepare(
                'INSERT OR IGNORE INTO ans_plugin_registrations (id, plugin_id, resource_type, ans_resource_id) VALUES (?, ?, ?, ?)',
              ).run(randomUUID(), id, reg.type, reg.ansId);
            }

            // 借鉴OpenClaw+claude-code: 写文件系统(重启恢复用)
            const pluginInstallDir = resolve(INSTALL_DIR, pluginName);
            if (!existsSync(pluginInstallDir)) mkdirSync(pluginInstallDir, { recursive: true });
            writeFileSync(
              resolve(pluginInstallDir, 'plugin.json'),
              JSON.stringify(
                {
                  id,
                  name: pluginName,
                  display_name: plugin.display_name,
                  version: plugin.version,
                  category,
                  description: plugin.description,
                  installed_at: new Date().toISOString(),
                  registrations: registrations.map((r) => ({ type: r.type, ansId: r.ansId })),
                },
                null,
                2,
              ),
            );

            db.prepare(
              "UPDATE ans_plugins SET state = 'installed', installed_at = datetime('now'), installed_version = version, install_count = install_count + 1 WHERE id = ?",
            ).run(id);
            return {
              data: {
                id,
                state: 'installed',
                category,
                registrations: registrations.length,
                manifest: !!bestManifest,
                installDir: pluginInstallDir,
              },
            };
          } catch (err) {
            db.prepare("UPDATE ans_plugins SET state = 'error' WHERE id = ?").run(id);
            throw err;
          }
        },
        { body: t.Optional(t.Object({ config: t.Optional(t.Record(t.String(), t.Unknown())) })) },
      )
      .post('/:id/uninstall', ({ params: { id } }) => {
        const plugin = db.prepare('SELECT name FROM ans_plugins WHERE id = ?').get(id) as { name: string } | undefined;
        // 0. 停止MCP/A2A运行时进程
        if (plugin?.name) {
          stopMcpProcess(plugin.name);
        }
        // 1. 清理ANS资源注册 (disable但不删除记录)
        const registrations = db
          .prepare('SELECT resource_type, ans_resource_id FROM ans_plugin_registrations WHERE plugin_id = ?')
          .all(id) as Array<{ resource_type: string; ans_resource_id: string }>;
        for (const reg of registrations) {
          if (reg.resource_type === 'skill')
            db.prepare("UPDATE ans_skills SET status = 'disabled' WHERE id = ?").run(reg.ans_resource_id);
          else if (reg.resource_type === 'mcp')
            db.prepare("UPDATE ans_mcp_servers SET status = 'disabled' WHERE id = ?").run(reg.ans_resource_id);
          else if (reg.resource_type === 'a2a')
            db.prepare("UPDATE ans_a2a_servers SET status = 'disabled' WHERE id = ?").run(reg.ans_resource_id);
        }
        // 2. 清理注册关联
        db.prepare('DELETE FROM ans_plugin_registrations WHERE plugin_id = ?').run(id);
        // 3. 清理文件系统 (借鉴OpenClaw: 安全检查后递归删除)
        if (plugin?.name) {
          const pluginDir = resolve(INSTALL_DIR, plugin.name);
          if (existsSync(pluginDir) && pluginDir.startsWith(INSTALL_DIR)) {
            try {
              rmSync(pluginDir, { recursive: true, force: true });
            } catch {
              /* best-effort */
            }
          }
        }
        // 4. 重置DB状态
        db.prepare(
          "UPDATE ans_plugins SET state = 'available', installed_at = NULL, installed_version = NULL, user_config = '{}' WHERE id = ?",
        ).run(id);
        return { data: { id, state: 'available' } };
      })
      // 运行时管理
      .post('/:id/start', ({ params: { id }, set }) => {
        const plugin = db
          .prepare("SELECT name, state, category FROM ans_plugins WHERE id = ? AND status = 'active'")
          .get(id) as Record<string, unknown> | undefined;
        if (!plugin) throw notFound('Plugin', id);
        if (plugin.state !== 'installed') {
          set.status = 400;
          return { error: { code: 'NOT_INSTALLED', message: '插件未安装' } };
        }
        return { data: { id, status: 'started', message: `插件${plugin.name}已就绪` } };
      })
      .post('/:id/stop', ({ params: { id }, set }) => {
        const plugin = db.prepare("SELECT name, state FROM ans_plugins WHERE id = ? AND status = 'active'").get(id) as
          | Record<string, unknown>
          | undefined;
        if (!plugin) throw notFound('Plugin', id);
        return { data: { id, status: 'stopped' } };
      })
      .get('/:id/runtime-status', ({ params: { id } }) => {
        const plugin = db.prepare('SELECT name, state, category FROM ans_plugins WHERE id = ?').get(id) as
          | Record<string, unknown>
          | undefined;
        if (!plugin) throw notFound('Plugin', id);
        const registrations = db.prepare('SELECT * FROM ans_plugin_registrations WHERE plugin_id = ?').all(id) as Array<
          Record<string, unknown>
        >;
        return { data: { pluginName: plugin.name, state: plugin.state, category: plugin.category, registrations } };
      })
      // 获取插件配置
      .get('/:id/config', ({ params: { id } }) => {
        const plugin = db.prepare('SELECT user_config FROM ans_plugins WHERE id = ?').get(id) as
          | { user_config: string }
          | undefined;
        if (!plugin) throw notFound('Plugin', id);
        return { data: JSON.parse(plugin.user_config || '{}') };
      })
  );
}
