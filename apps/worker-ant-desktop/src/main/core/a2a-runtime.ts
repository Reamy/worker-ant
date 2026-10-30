/**
 * A2A Agent运行时（从原工蚁 a2a-runtime.ts 移植）。
 * 管理Agent产出的A2A服务进程生命周期。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from './logger.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
// zx_20261029_2 M3：A2A 卡与门牌共享**同一份技能词汇**（仅类型，打包期擦除）。
//   不把节点能力硬塞进交付物卡——这里只是让"一条技能条目"在两处叫同一个名字。
import type { CapabilitySkill } from './capability-vocabulary.js';
// zx_20261030_1 M5「限」：并发 A2A 服务数按档位设闸（只拦**启动**；已运行的实例不回收）。
import { resolveLicenseTier, type LicenseSettingDb } from './license.js';
import { capacityRefusal } from './tier-capacity.js';

const logger = createLogger('a2a-runtime');

interface RuntimeEntry {
  deliverableId: string;
  name: string;
  port: number;
  process: ChildProcess;
  startedAt: Date;
  endpoint: string;
  agentCardUrl: string;
  workingDir: string;
  /** 探活通过**之后**才置真——"登记了"与"起得来"是两件事（zx_20260929 M12）。 */
  ready: boolean;
}

const processes = new Map<string, RuntimeEntry>();
const PORT_START = 19950;
const PORT_END = 19999;

let nextPort = PORT_START;

function allocatePort(): number {
  const usedPorts = new Set(Array.from(processes.values()).map(e => e.port));
  for (let i = 0; i < (PORT_END - PORT_START); i++) {
    const port = PORT_START + ((nextPort - PORT_START + i) % (PORT_END - PORT_START + 1));
    if (!usedPorts.has(port)) {
      nextPort = port + 1;
      if (nextPort > PORT_END) nextPort = PORT_START;
      return port;
    }
  }
  throw new Error('No available ports in range');
}

export async function startA2AServer(
  deliverableId: string,
  name: string,
  workingDir: string,
  entryFile = 'server.js',
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void,
  opts: { db?: LicenseSettingDb } = {},
): Promise<{ endpoint: string; agentCardUrl: string; port: number }> {
  // 同一交付物重启：先停旧的（它不占"新增"额度，见下面的计数时机）。
  if (processes.has(deliverableId)) await stopA2AServer(deliverableId);
  // zx_20261030_1 M5「限」：spawn **之前**判容量（上限由 `TIER_LIMITS[tier].maxA2AServers` 派生，0=不限）。
  //   到顶抛带中文说明的 Error（IPC 壳会原样上屏）；已在跑的实例一条不停——只拦"再起一个"。
  const verdict = capacityRefusal(resolveLicenseTier(opts.db), 'maxA2AServers', processes.size);
  if (!verdict.ok) throw new Error(`A2A 服务无法启动：${verdict.note}`);
  const port = allocatePort();
  const endpoint = `http://localhost:${port}`;
  const agentCardUrl = `${endpoint}/.well-known/agent.json`;
  const child = spawn('node', [entryFile], {
    cwd: workingDir,
    env: { ...process.env, A2A_PORT: String(port), MCP_PORT: String(port), A2A_SERVER_NAME: name },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const entry: RuntimeEntry = { deliverableId, name, port, process: child, startedAt: new Date(), endpoint, agentCardUrl, workingDir, ready: false };
  processes.set(deliverableId, entry);
  child.stdout?.on('data', (data: Buffer) => logger.info({ deliverableId, name, output: data.toString().trim() }, 'A2A agent stdout'));
  child.stderr?.on('data', (data: Buffer) => logger.warn({ deliverableId, name, output: data.toString().trim() }, 'A2A agent stderr'));
  // zx_20260929 M12: 子进程**起来之后**又死了，此前的实现只 `delete` 不记账 ⇒ 库里的 `status` 永远停在
  // `running`、GUI 也一直显示"运行中"，与事实相反。现补 `onExit` 回调交调用方如实落 `stopped`。
  // 只在「这条 entry 仍是当前那条」**且**「探活曾通过」时才回调：探活失败路径下面已 `delete`，
  // `stopA2AServer` 又 `removeAllListeners('exit')` ⇒ 起不来与主动停止都不会误报成"运行中死了"。
  child.on('exit', (code, signal) => {
    logger.info({ deliverableId, name, code, signal }, 'A2A agent exited');
    const wasCurrent = processes.get(deliverableId) === entry;
    processes.delete(deliverableId);
    if (wasCurrent && entry.ready) onExit?.(code, signal);
  });
  child.on('error', (err) => { logger.error({ deliverableId, name, err }, 'A2A agent error'); processes.delete(deliverableId); });
  // zx_20260929 M2: 此前是固定 `setTimeout(1000)` ⇒ 子进程根本没起来也照样返回成功、IPC 随后置
  // `status='running'`（名实不符）。现改**真探活**：子进程未退出 **且** 端口真的在 listen 才算起得来。
  const notReady = await waitForListen(port, child);
  if (notReady) {
    try { child.kill('SIGKILL'); } catch { /* 已退出则忽略 */ }
    processes.delete(deliverableId);
    throw new Error(`A2A 服务启动失败：${notReady.message}（entry=${entryFile}, cwd=${workingDir}）`);
  }
  entry.ready = true;
  return { endpoint, agentCardUrl, port };
}

/** 等端口真正可连（zx_20260929 M2）。返回 `null` = 就绪；否则返回失败原因。 */
async function waitForListen(port: number, child: ChildProcess, timeoutMs = 5000): Promise<Error | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return new Error(`子进程已退出（code=${child.exitCode} signal=${child.signalCode}）`);
    }
    if (await canConnect(port)) return null;
    if (Date.now() >= deadline) return new Error(`端口 ${port} 在 ${timeoutMs}ms 内未监听`);
    await new Promise(r => setTimeout(r, 150));
  }
}

/** 两端点试连（IPv4 与 IPv6 各试一次）：只试 `127.0.0.1` 会把「只绑 ::1」的服务误判为没起来。 */
async function canConnect(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '::1']) {
    if (await connectOnce(port, host)) return true;
  }
  return false;
}

function connectOnce(port: number, host: string): Promise<boolean> {
  return new Promise(resolve => {
    const sock = net.connect({ port, host });
    const done = (ok: boolean) => { sock.removeAllListeners(); sock.destroy(); resolve(ok); };
    sock.setTimeout(1000);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
  });
}

export async function stopA2AServer(deliverableId: string): Promise<void> {
  const entry = processes.get(deliverableId);
  if (!entry) return;
  entry.process.removeAllListeners('exit');
  entry.process.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => { if (entry.process.exitCode === null) entry.process.kill('SIGKILL'); resolve(); }, 5000);
    entry.process.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
  processes.delete(deliverableId);
}

// zx_20260929 M12: `startedAt` 一律**序列化成字符串**再出这个模块。此前直接返回 `Date`，Electron IPC 的
// 结构化克隆会把它原样送达渲染层（`Date` 不是字符串），渲染层 `formatTime` 的 `|| s` 兜底把一个对象塞进
// JSX ⇒ React error #31（`args[]=[object Date]`）。**模块边界上不递活对象**——这里就是那条边界。
export function getA2AServerStatus(deliverableId: string): { running: boolean; name?: string; port?: number; endpoint?: string; agentCardUrl?: string; startedAt?: string } {
  const entry = processes.get(deliverableId);
  if (!entry) return { running: false };
  return { running: entry.process.exitCode === null, name: entry.name, port: entry.port, endpoint: entry.endpoint, agentCardUrl: entry.agentCardUrl, startedAt: entry.startedAt.toISOString() };
}

export function listA2AServers(): Array<{ deliverableId: string; name: string; port: number; endpoint: string; agentCardUrl: string; startedAt: string }> {
  return Array.from(processes.values()).map(e => ({ deliverableId: e.deliverableId, name: e.name, port: e.port, endpoint: e.endpoint, agentCardUrl: e.agentCardUrl, startedAt: e.startedAt.toISOString() }));
}

export async function stopAllA2AServers(): Promise<void> {
  await Promise.all(Array.from(processes.keys()).map(id => stopA2AServer(id)));
}

export interface AgentCardTemplate {
  name: string;
  description?: string;
  version?: string;
  capabilities?: { streaming?: boolean; pushNotifications?: boolean; stateTransitionHistory?: boolean };
  /**
   * 技能条目与门牌同形（zx_20261029_2 M3）：`id/name/description/tags` 取自 `CapabilitySkill`；
   * 故 `agentSkillsFromCapabilities(...)` 的结果可**原样**传进来，不必再转一手。
   */
  skills?: Array<Pick<CapabilitySkill, 'id' | 'name'> & Partial<Pick<CapabilitySkill, 'description' | 'tags'>> & { inputModes?: string[]; outputModes?: string[] }>;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
}

export function generateAgentCard(workingDir: string, template: AgentCardTemplate): string {
  const wellKnownDir = path.join(workingDir, '.well-known');
  if (!existsSync(wellKnownDir)) mkdirSync(wellKnownDir, { recursive: true });
  const card = {
    name: template.name,
    description: template.description || `${template.name} — AI-generated A2A agent`,
    version: template.version || '0.1.0',
    capabilities: {
      streaming: template.capabilities?.streaming ?? true,
      pushNotifications: template.capabilities?.pushNotifications ?? false,
      stateTransitionHistory: template.capabilities?.stateTransitionHistory ?? true,
    },
    skills: template.skills || [],
    defaultInputModes: template.defaultInputModes || ['text'],
    defaultOutputModes: template.defaultOutputModes || ['text'],
  };
  const cardPath = path.join(wellKnownDir, 'agent.json');
  writeFileSync(cardPath, JSON.stringify(card, null, 2), 'utf-8');
  return cardPath;
}

export function ensureAgentCard(deliverableId: string, name: string, workingDir: string, description?: string): string {
  const cardPath = path.join(workingDir, '.well-known', 'agent.json');
  if (existsSync(cardPath)) return cardPath;
  return generateAgentCard(workingDir, { name, description: description || `${name} — 工蚁自动生成的A2A服务` });
}
