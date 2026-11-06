import type {
  ModelRequirements,
  ModelEndpoint,
  SkillRequirements,
  SkillEndpoint,
  McpRequirements,
  McpServerEndpoint,
  A2ARequirements,
  A2AServerEndpoint,
  AnsNode,
  NodeHeartbeatRequest,
  NodePatch,
  NodeListResult,
  AnsNodeRequest,
  NodeRequestSubmit,
  NodeRequestResultReport,
} from '@worker-ant/shared-types';

import { createHmacSignature } from './crypto.js';
import { LruCache } from './cache.js';
import type { McpClientInstance, McpToolInfo } from './mcp-sdk-client.js';
import type { A2AClientInstance } from './a2a-sdk-client.js';

class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableError';
  }
}

/**
 * zx_20261009 M5：HTTP 层失败的**结构化**错误——`status` 是唯一事实源。
 *
 * 病根：调用方要区分「**未认证（401）**」与「连得上但读不动 / 真没数据」，而旧实现只把 status
 *   塞进 message 文本（`ANS request failed (401): …`）⇒ 下游只能**解析字符串**（依赖偶然形态）。
 *   上游在此处**本就知道** `response.status`，据实带出来即可。
 * `message` 与原实现**逐字**相同（不改既有日志/判据）；判型请用 `instanceof AnsApiError` 或读 `.status`。
 */
export class AnsApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`ANS request failed (${status}): ${body}`);
    this.name = 'AnsApiError';
    this.status = status;
    this.body = body;
  }
}

export interface AnsClientOptions {
  serverUrl: string;
  apiKey: string;
  secretKey: string;
  cacheTTL?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface AnsClientConfig {
  serverUrl: string;
  cacheTTL: number;
  maxRetries: number;
  retryDelayMs: number;
}

export type ConnectionStatus = 'connected' | 'degraded' | 'disconnected';
export type StatusListener = (status: ConnectionStatus, detail?: string) => void;

export class AnsClient {
  private config!: AnsClientConfig;
  private apiKey!: string;
  private secretKey!: string;
  private modelCache!: LruCache<ModelEndpoint>;
  private skillCache!: LruCache<SkillEndpoint>;
  private mcpCache!: LruCache<McpServerEndpoint>;
  private a2aCache!: LruCache<A2AServerEndpoint>;

  constructor(options: AnsClientOptions) {
    this.apiKey = options.apiKey;
    this.secretKey = options.secretKey;
    const ttl = options.cacheTTL ?? 60_000;
    this.config = {
      serverUrl: options.serverUrl,
      cacheTTL: ttl,
      maxRetries: options.maxRetries ?? 3,
      retryDelayMs: options.retryDelayMs ?? 1000,
    };
    this.modelCache = new LruCache(ttl);
    this.skillCache = new LruCache(ttl);
    this.mcpCache = new LruCache(ttl);
    this.a2aCache = new LruCache(ttl);
  }

  // B3: 后台健康监控
  private _status: ConnectionStatus = 'disconnected';
  private _healthInterval: ReturnType<typeof setInterval> | null = null;
  private _statusListeners: Set<StatusListener> = new Set();
  private _consecutiveFails = 0;
  private _healthRunning = false;

  /** 获取当前连接状态 */
  get status(): ConnectionStatus {
    return this._status;
  }

  /** 注册状态变更监听器 */
  onStatusChange(listener: StatusListener): () => void {
    this._statusListeners.add(listener);
    return () => {
      this._statusListeners.delete(listener);
    };
  }

  private _setStatus(status: ConnectionStatus, detail?: string): void {
    if (this._status !== status) {
      this._status = status;
      for (const l of this._statusListeners) {
        try {
          l(status, detail);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** 启动后台健康检查(每30秒) */
  startHealthCheck(): void {
    if (this._healthRunning) return;
    this._healthRunning = true;
    this._healthInterval = setInterval(async () => {
      try {
        const result = await this.healthCheck();
        if (result.status === 'ok') {
          this._consecutiveFails = 0;
          this._setStatus('connected');
        } else {
          this._consecutiveFails++;
          this._setStatus(
            this._consecutiveFails >= 3 ? 'disconnected' : 'degraded',
            `健康检查返回非ok状态: ${result.status}`,
          );
        }
      } catch (err) {
        this._consecutiveFails++;
        const detail = `健康检查失败: ${(err as Error).message || '未知错误'}`;
        this._setStatus(this._consecutiveFails >= 3 ? 'disconnected' : 'degraded', detail);
      }
    }, 30_000);
    // 立即执行首次检查
    this.healthCheck()
      .then((r) => {
        if (r.status === 'ok') this._setStatus('connected');
      })
      .catch(() => {});
  }

  // C3: 个性化推荐 — 记录最近使用成功的供应商，优先推荐
  private _recentProviders: string[] = [];

  /** 记录模型使用成功（供Agent引擎调用，积累偏好） */
  recordModelUse(modelId: string, providerId?: string): void {
    if (providerId) {
      this._recentProviders = [providerId, ...this._recentProviders.filter((p) => p !== providerId)].slice(0, 5);
    }
  }

  /** 获取最近使用成功的供应商列表（个性化推荐） */
  getPreferredProviders(): string[] {
    return [...this._recentProviders];
  }

  /** 停止后台健康检查 */
  stopHealthCheck(): void {
    this._healthRunning = false;
    if (this._healthInterval) {
      clearInterval(this._healthInterval);
      this._healthInterval = null;
    }
  }

  async getOptimalModel(req: ModelRequirements): Promise<ModelEndpoint & { fallback?: ModelEndpoint }> {
    const cacheKey = JSON.stringify(req);
    const cached = this.modelCache.get(cacheKey);
    if (cached) return cached;

    const result = await this.request<ModelEndpoint & { fallback?: ModelEndpoint }>('/api/v1/models/optimal', {
      method: 'POST',
      body: JSON.stringify(req),
    });
    // zx_20260924 M6-e①: 只缓存**真的点到名**的那一份（成功路必带 `id`；零命中/解密失败的 `{error}` 体不带）。
    //   此前按 HTTP 200 一律入缓存，而 ANS 的零命中回的是 **200 + 错误体** ⇒ 一次瞬时漏斗空转
    //   被固化成一分钟内"这批能力没有模型"——可"没有模型"这件事，一分钟后可能就不成立了
    //   （配额刷新、端点恢复）。判据取**正向**（认成功形状）而非"认错误形状"：
    //   将来回包若多出一种没人预料到的失败形状，这里自然不入缓存，不会把它当成功冻住。
    if (result && typeof (result as { id?: unknown }).id === 'string' && result.id) {
      this.modelCache.set(cacheKey, result);
    }
    return result;
  }

  async getOptimalSkill(req: SkillRequirements): Promise<SkillEndpoint> {
    const cacheKey = JSON.stringify(req);
    const cached = this.skillCache.get(cacheKey);
    if (cached) return cached;

    const result = await this.request<SkillEndpoint>('/api/v1/skills/optimal', {
      method: 'POST',
      body: JSON.stringify(req),
    });
    this.skillCache.set(cacheKey, result);
    return result;
  }

  async getOptimalMcp(req: McpRequirements): Promise<McpServerEndpoint> {
    const cacheKey = JSON.stringify(req);
    const cached = this.mcpCache.get(cacheKey);
    if (cached) return cached;

    const result = await this.request<McpServerEndpoint>('/api/v1/mcp/optimal', {
      method: 'POST',
      body: JSON.stringify(req),
    });
    this.mcpCache.set(cacheKey, result);
    return result;
  }

  async getOptimalA2A(req: A2ARequirements): Promise<A2AServerEndpoint> {
    const cacheKey = JSON.stringify(req);
    const cached = this.a2aCache.get(cacheKey);
    if (cached) return cached;

    const result = await this.request<A2AServerEndpoint>('/api/v1/a2a/optimal', {
      method: 'POST',
      body: JSON.stringify(req),
    });
    this.a2aCache.set(cacheKey, result);
    return result;
  }

  async healthCheck(): Promise<{ status: string; latency: number }> {
    const start = Date.now();
    const result = await this.request<{ status: string }>('/api/v1/health');
    return { status: result.status, latency: Date.now() - start };
  }

  // zx_20261004 M1：节点协同——心跳 / 列表 / 改档（均 HMAC）。注册见 `enrollNode`（无 key，不能签名）。
  async heartbeatNode(req: NodeHeartbeatRequest): Promise<AnsNode> {
    const r = await this.post<{ data: AnsNode }>('/api/v1/nodes/heartbeat', req);
    return r.data;
  }

  async listNodes(opts: { all?: boolean; limit?: number; offset?: number } = {}): Promise<NodeListResult> {
    const qs = new URLSearchParams();
    if (opts.all) qs.set('all', '1');
    if (opts.limit !== undefined) qs.set('limit', String(opts.limit));
    if (opts.offset !== undefined) qs.set('offset', String(opts.offset));
    const q = qs.toString();
    return this.get<NodeListResult>(`/api/v1/nodes${q ? `?${q}` : ''}`);
  }

  async updateNode(nodeId: string, patch: NodePatch): Promise<AnsNode> {
    const r = await this.patch<{ data: AnsNode }>(`/api/v1/nodes/${encodeURIComponent(nodeId)}`, patch);
    return r.data;
  }

  // zx_20261004 M12：中转队列——提交（AI 终端）/ 拉取（工蚁）/ 回传（工蚁），均 HMAC。
  /** AI 终端提交**类目级**请求；ANS 选目标，无合适节点则落 `pending`。 */
  async submitNodeRequest(req: NodeRequestSubmit): Promise<AnsNodeRequest> {
    const r = await this.post<{ data: AnsNodeRequest }>('/api/v1/nodes/requests', req);
    return r.data;
  }

  /** 工蚁拉取**派给自己的** assigned 件（越权由 ANS 侧按调用方 key 资源组裁定）。 */
  async listNodeRequests(nodeId: string): Promise<AnsNodeRequest[]> {
    const r = await this.get<{ data: AnsNodeRequest[] }>(
      `/api/v1/nodes/requests?node_id=${encodeURIComponent(nodeId)}`,
    );
    return r.data;
  }

  /** 工蚁回传终态（`done`/`error`）。 */
  async reportNodeRequestResult(id: string, report: NodeRequestResultReport): Promise<AnsNodeRequest> {
    const r = await this.post<{ data: AnsNodeRequest }>(
      `/api/v1/nodes/requests/${encodeURIComponent(id)}/result`,
      report,
    );
    return r.data;
  }

  clearCache(): void {
    this.modelCache.clear();
    this.skillCache.clear();
    this.mcpCache.clear();
    this.a2aCache.clear();
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    return this.requestWithRetry<T>(path, init, 0);
  }

  private async requestWithRetry<T>(path: string, init?: RequestInit, attempt = 0): Promise<T> {
    const timestamp = Date.now().toString();
    const body = init?.body as string | undefined;
    const signature = createHmacSignature(this.secretKey, timestamp, body ?? '');

    try {
      const response = await fetch(`${this.config.serverUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(30_000),
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': this.apiKey,
          'X-Timestamp': timestamp,
          'X-Signature': signature,
          ...init?.headers,
        },
      });

      if (!response.ok) {
        // 5xx服务端错误可重试，4xx客户端错误不重试
        if (response.status >= 500 && attempt < this.config.maxRetries) {
          throw new RetryableError(`Server error ${response.status}`);
        }
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new AnsApiError(response.status, errorText);
      }

      return response.json() as Promise<T>;
    } catch (err) {
      if (err instanceof RetryableError && attempt < this.config.maxRetries) {
        const delay = this.config.retryDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.requestWithRetry<T>(path, init, attempt + 1);
      }
      // 网络错误也可重试
      if (err instanceof TypeError && attempt < this.config.maxRetries) {
        const delay = this.config.retryDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.requestWithRetry<T>(path, init, attempt + 1);
      }
      throw err;
    }
  }

  /**
   * 向ANS服务端发送任意POST请求（含HMAC签名）。
   * 供需要直接调用ANS API的场景使用（如注册产出物）。
   */
  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /** 发送GET请求（含HMAC签名） */
  async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }

  /** 发送PUT请求（含HMAC签名） */
  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  /** 发送DELETE请求（含HMAC签名） */
  async delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' });
  }

  /** 发送PATCH请求（含HMAC签名） */
  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  /**
   * 获取即用型MCP客户端。
   * 自动发现最优MCP服务 → 连接初始化 → 缓存工具列表 → 返回可用实例。
   */
  async getMcpClient(req: import('@worker-ant/shared-types').McpRequirements): Promise<McpClientInstance> {
    const { connectMcpClient } = await import('./mcp-sdk-client.js');
    return connectMcpClient(this, req);
  }

  /**
   * 获取即用型A2A客户端。
   * 自动发现最优A2A Agent → 拉取Agent Card → 返回完整任务生命周期客户端。
   */
  async getA2AClient(req: import('@worker-ant/shared-types').A2ARequirements): Promise<A2AClientInstance> {
    const { connectA2AClient } = await import('./a2a-sdk-client.js');
    return connectA2AClient(this, req);
  }
}
