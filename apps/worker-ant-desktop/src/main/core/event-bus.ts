/**
 * A1增强：轻量事件总线 + Webhook通知 + EventStore持久化。
 * 每个emit()自动写入wa_event_log（不可变事件日志），然后通知内存订阅者和Webhook。
 */

/**
 * @layer domain — 领域层（内因）— 决定系统"是什么"的核心：Agent引擎、任务管理、记忆系统、事件溯源
 */
import { createLogger } from './logger.js';
import type { EventStore } from './event-store.js';

const logger = createLogger('event-bus');

export type EventType = 'task.completed' | 'task.failed' | 'task.status_changed' | 'task.awaiting_input' | 'task.answer_recorded' | 'task.step_finished' | 'task.step_streaming' | 'task.memory_injected' | 'task.goal_identified' | 'task.goal_deviation' | 'task.execution_signal' | 'task.estimated' | 'task.heartbeat' | 'presence.update' | 'project.status_changed' | 'project.milestone_changed' | 'channel.started' | 'channel.stopped' | 'channel.status_changed' | 'deliverable.registered' | 'deliverable.status_changed' | 'file.created' | 'file.updated' | 'file.edited' | 'im.message_inbound' | 'im.message_outbound' | 'memory.changed' | 'node.presence_changed' | 'node.heartbeat' | 'device.discovered' | 'device.status_changed' | 'node.request_received' | 'node.request_completed' | 'node.request_dispatched' | 'node.request_result' | 'node.request_question' | 'node.request_answered'
  // zx_20261018_2 批六「见新」：GUI 事件驱动刷新的三个**瞬态**类型。
  //   刻意**不进**下方那张聚合映射表：运行态/门态/一次门内调用是"此刻的投影"，
  //   真相已在 `wa_deliverables.status` / `wa_external_terminals` / `wa_external_calls`，
  //   进不可变事件日志只会洪泛（同 `channel.status_changed` 的取舍）。
  | 'deliverable.runtime_changed' | 'external.status_changed' | 'external.call_recorded'
  // zx_20261023_5 批四：局域网里**看见**一台 AI 终端（内存待接入列表变了）——同样是瞬态投影，不进事件日志。
  | 'external.lan_changed';

export interface AppEvent {
  type: EventType;
  timestamp: string;
  data: Record<string, unknown>;
}

type EventHandler = (event: AppEvent) => void | Promise<void>;

interface WebhookConfig {
  url: string;
  events: EventType[];
}

// 事件类型 → 聚合类型映射
const EVENT_AGGREGATE_MAP: Record<string, { aggregate_type: string; idField: string }> = {
  'task.completed': { aggregate_type: 'task', idField: 'taskId' },
  'task.failed': { aggregate_type: 'task', idField: 'taskId' },
  'task.status_changed': { aggregate_type: 'task', idField: 'taskId' },
  'task.awaiting_input': { aggregate_type: 'task', idField: 'taskId' },
  // zx_20260915 P0-5(a): 答有痕——提问有事件（上方）、答复此前无事件，故"用户已确认"无法从事件溯源自证。
  //   两张表都要有：只加 union 不加本映射 ⇒ emit() 走 `无聚合映射，跳过持久化`，事件**一行都不落库**（静默）。
  'task.answer_recorded': { aggregate_type: 'task', idField: 'taskId' },
  'task.step_finished': { aggregate_type: 'task', idField: 'taskId' },
  'task.memory_injected': { aggregate_type: 'task', idField: 'taskId' },
  'task.goal_identified': { aggregate_type: 'task', idField: 'taskId' },
  'task.goal_deviation': { aggregate_type: 'task', idField: 'taskId' },
  'task.execution_signal': { aggregate_type: 'task', idField: 'taskId' },
  'task.estimated': { aggregate_type: 'task', idField: 'taskId' },
  'project.status_changed': { aggregate_type: 'project', idField: 'projectId' },
  // zx_20260909 X2①(维特根斯坦·可判定): 方案里程碑状态变更事件——前端交付单/里程碑卡订阅即刷(终结前端虚构 'milestone.done' 死监听)
  'project.milestone_changed': { aggregate_type: 'project', idField: 'projectId' },
  'channel.started': { aggregate_type: 'im_channel', idField: 'channelId' },
  'channel.stopped': { aggregate_type: 'im_channel', idField: 'channelId' },
  // channel.status_changed 故意不在此表：运行期状态跃迁高频，走 emitTransient 只到内存订阅者，
  // 不进不可变事件日志、不触发 webhook（真相在 wa_im_channels.status）。
  'deliverable.registered': { aggregate_type: 'deliverable', idField: 'deliverableId' },
  'deliverable.status_changed': { aggregate_type: 'deliverable', idField: 'deliverableId' },
  'file.created': { aggregate_type: 'task', idField: 'taskId' },
  'file.updated': { aggregate_type: 'task', idField: 'taskId' },
  'file.edited': { aggregate_type: 'task', idField: 'taskId' },
  // zx_20261004 M4: 节点档位/在场变更——**持久化**（协同面板的历史可溯：谁何时改了档）。
  //   ⚠ 与 `node.heartbeat`（瞬态）**刻意分开**：心跳是高频运行期噪声，进日志即洪泛不可变事件表；
  //     档位变更低頻且是"人对群蚁的意志"，值得留痕（同 channel.status_changed 的取舍，方向相反）。
  'node.presence_changed': { aggregate_type: 'node', idField: 'nodeId' },
  // zx_20261004 M10: 设备发现与状态变更——**两者皆持久化**（首见是史实；状态流转是"这台设备经历过什么"，
  //   面板的"实时状态"由此可溯）。二者皆**低頻且由人/代理由发**（非心跳那类自动高频），进日志不构成洪泛
  //   ——与 `node.presence_changed`（持久化）/`node.heartbeat`（瞬态）同一取舍方向。
  'device.discovered': { aggregate_type: 'device', idField: 'deviceId' },
  'device.status_changed': { aggregate_type: 'device', idField: 'deviceId' },
  // zx_20261004 M13: AI 终端经 ANS 派来的请求——**到场/收口皆持久化**。
  //   低频（一次派单 = 两条事件）、人可追溯（"谁派的、什么时候、办成没办成"）⇒ 进不可变事件日志，
  //   与 `node.heartbeat`（瞬态）方向相反；两件合看即是这次调用的**完整一生**（M13 面板据此刻画调用记录）。
  'node.request_received': { aggregate_type: 'node_request', idField: 'requestId' },
  'node.request_completed': { aggregate_type: 'node_request', idField: 'requestId' },
  // zx_20261011 M3: **出站**（本机派出去）——与入站（node_request）**刻意分两个聚合**：
  //   同一个 requestId 在两侧语义相反（一是我派的、一是派给我的），合成一个聚合会分不清方向。
  //   两类事件合看即是这次派发的**完整一生**（`node-dispatch-log.ts` 据此刻画出站台账）。
  'node.request_dispatched': { aggregate_type: 'node_dispatch', idField: 'requestId' },
  'node.request_result': { aggregate_type: 'node_dispatch', idField: 'requestId' },
  // zx_20261011_1 M4（双向澄清）: 澄清一问一答——**同属出站聚合 `node_dispatch`**（都是"我派的这一单"的一生）。
  //   低频（一单至多一两轮问答）、人可追溯（"我被问了什么、我答了什么"）⇒ 进不可变日志（同 dispatched/result 的取舍）。
  'node.request_question': { aggregate_type: 'node_dispatch', idField: 'requestId' },
  'node.request_answered': { aggregate_type: 'node_dispatch', idField: 'requestId' },
};

export class EventBus {
  private handlers = new Map<EventType, EventHandler[]>();
  private webhooks: WebhookConfig[] = [];
  private eventStore: EventStore | null = null;

  /** 注入EventStore以启用事件持久化 */
  setEventStore(store: EventStore): void {
    this.eventStore = store;
  }

  /** 订阅事件 */
  on(type: EventType, handler: EventHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  /** 取消订阅事件 */
  off(type: EventType, handler: EventHandler): void {
    const list = this.handlers.get(type);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  }

  /** 注册Webhook */
  registerWebhook(config: WebhookConfig): void {
    this.webhooks.push(config);
  }

  /** 注销Webhook */
  unregisterWebhook(url: string): void {
    this.webhooks = this.webhooks.filter(w => w.url !== url);
  }

  /**
   * 发布事件。
   * 1. 持久化到wa_event_log（不可变）
   * 2. 通知内存订阅者
   * 3. 触发Webhook（异步，不阻塞）
   */
  async emit(type: EventType, data: Record<string, unknown>): Promise<string | null> {
    const timestamp = new Date().toISOString();
    const event: AppEvent = { type, timestamp, data };

    let persistedEventId: string | null = null;

    // 1. 持久化事件到EventStore
    if (this.eventStore) {
      try {
        const aggMap = EVENT_AGGREGATE_MAP[type];
        if (aggMap) {
          const aggregateId = data[aggMap.idField] as string | undefined;
          if (aggregateId) {
            const stored = this.eventStore.append({
              event_type: type,
              aggregate_type: aggMap.aggregate_type,
              aggregate_id: aggregateId,
              payload: data,
              metadata: { source: 'event-bus' },
              occurred_at: timestamp,
            });
            persistedEventId = stored.event_id;
            logger.debug({ type, aggregate_id: aggregateId, event_id: persistedEventId }, '事件已持久化');
          } else {
            logger.warn({ type, data: JSON.stringify(data).slice(0, 200) }, '事件缺少聚合根ID，跳过持久化');
          }
        } else {
          logger.debug({ type }, '事件类型无聚合映射，跳过持久化');
        }
      } catch (err) {
        logger.error({ err, type }, '事件持久化失败，继续内存通知');
      }
    }

    // 2. 内存处理器（同步+异步混合）
    const handlers = this.handlers.get(type) ?? [];
    for (const handler of handlers) {
      try { await handler(event); } catch (err) { logger.error({ err, type }, '事件处理器失败'); }
    }

    // 3. Webhook通知（异步，不阻塞）
    const matching = this.webhooks.filter(w => w.events.includes(type));
    for (const wh of matching) {
      fetch(wh.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => { /* Webhook不可达属正常，静默忽略 */ });
    }

    return persistedEventId;
  }

  /**
   * D1 (2026-09-02): 瞬态事件——token 级高频流式专用。
   * 与 emit 不同：**不持久化到 wa_event_log、不触发 Webhook**，仅通知内存订阅者。
   * 背景：token 级 thinking 逐字推送频率极高，若经 emit 会洪泛不可变事件日志与 Webhook。
   */
  async emitTransient(type: EventType, data: Record<string, unknown>): Promise<void> {
    const timestamp = new Date().toISOString();
    const event: AppEvent = { type, timestamp, data };
    const handlers = this.handlers.get(type) ?? [];
    for (const handler of handlers) {
      try { await handler(event); } catch (err) { logger.error({ err, type }, '瞬态事件处理器失败'); }
    }
  }
}

export const eventBus = new EventBus();
