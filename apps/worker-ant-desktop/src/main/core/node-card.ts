/**
 * zx_20261004 M11（王阳明·知行合一 / 维特根斯坦·意义即用法 / 米勒 7±2）:
 * 工蚁**能力卡**（K-10 类目级）——"他者凭什么认得我能干什么"的**唯一一处派生**。
 *
 * 三件事各自一处：
 *   ① **类目词表**在 `shared-types/nodes.ts` 的 `NODE_CARD_CATEGORIES`（两侧同引，勿在此另抄）；
 *   ② **逐类目判据** `nodeCanDo`——"本机做不做得了这一类"只在此回答；
 *   ③ **组卡** `buildNodeCard`——卡的形状只在 `shared-types` 的 `NodeCard`，此处只**填值**。
 *
 * 派生原则（承 K-10 "仅列本机实际可做者"）：
 *   - `text` / `project_task` —— **内建恒在**：本机就是一台工蚁，对话与任务引擎随构建而来；
 *   - `code` / `research` —— **由工具面派生**（`availableToolNames` 非空）⇒ 面收窄则卡跟着收窄；
 *   - `media` —— **由工具面档位派生**（`ARCHETYPE_TOOL_CATEGORIES` 并集含 `media`）；
 *   - `device` —— **唯一运行期信号**：设备台账非空（`listDevices`）。空台账的机器**不**自称能控设备。
 *   ⚠ 一律**读表/读面**，不手抄工具名单——手抄的那份会随 `TOOL_METAS` 增删而漂（"预设"之弊）。
 *
 * ⚠ 本模块**不触网**：只读本地工具注册表与设备台账。上送由 `node-heartbeat.ts` 的注入 `send` 负责，
 *   故受控回归可直引 `deriveNodeCategories` 跑真实现（承 `node-identity.ts` / `memory-lifecycle.ts` 范式）。
 */
import {
  NODE_CARD_CATEGORIES,
  type NodeCard,
  type NodeCardCategory,
} from '@worker-ant/shared-types';
import { ARCHETYPE_TOOL_CATEGORIES, availableToolNames } from './task-archetype.js';
import { listDevices, type DeviceDb } from './device-registry.js';
import type { NodeIdentity } from './node-identity.js';

/**
 * 本机**做不做得了**某一类目——逐类目的**唯一判据**。
 *
 * `switch` **刻意不写 `default`**：`NodeCardCategory` 由 `NODE_CARD_CATEGORIES` 派生，词表加一格
 * ⇒ 此处缺一个 `case` ⇒ 函数可能不返回值 ⇒ **编译期**报错（不是运行期静默漏一类目）。
 */
export function nodeCanDo(category: NodeCardCategory, db: DeviceDb): boolean {
  switch (category) {
    case 'text':
    case 'project_task':
      return true;
    case 'code':
      return availableToolNames('code').length > 0;
    case 'research':
      return availableToolNames('research').length > 0;
    case 'media':
      return Object.values(ARCHETYPE_TOOL_CATEGORIES).some((cats) => cats.includes('media'));
    case 'device':
      return listDevices(db).length > 0;
  }
}

/**
 * 派生本机能力类目。序＝`NODE_CARD_CATEGORIES` 序（**不另排一套**——两处各排一种序，比的就不是同一件事）。
 */
export function deriveNodeCategories(db: DeviceDb): NodeCardCategory[] {
  return NODE_CARD_CATEGORIES.filter((c) => nodeCanDo(c, db));
}

/**
 * 组卡（M11）：能力卡随**既有心跳**上送。`platform` 由调用方给（心跳里的 `env.platform`），
 * 不在此另采一次——"卡上的平台"与"status 里的平台"必须是同一次采集的同值。
 */
export function buildNodeCard(identity: NodeIdentity, db: DeviceDb, platform: string): NodeCard {
  return { name: identity.name, node_id: identity.id, platform, categories: deriveNodeCategories(db) };
}
