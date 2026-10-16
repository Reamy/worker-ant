/**
 * zx_20261004 M15（K-8 轻得下 / 维特根斯坦·一个规则一处）: **守护进程监督整段**——自
 * `ipc/project.ipc.ts` 机械搬迁而来（来源符号区间：原 `RuntimeEntry` 接口 … `stopAllRuntimeProcesses`，
 * 即该文件 52–373 行；含 `db_for_stop` 与健康检查定时器）。**逐字节行为不变**。
 *
 * 为什么能搬：本簇只依赖「一个库 + OS 进程控制」；而 `project.ipc.ts` 顶层 import electron ⇒ node 侧
 * 跑不了。**`runtimeProcesses` 是导出面**——留在 `project.ipc.ts` 的 MCP/服务型成果自身 spawn/exit
 * handler（不属本簇）仍按原名读写该 Map，故其切块锚（`runtimeProcesses.set(id,`）留在原文件、原断言不动。
 *
 * 状态注入：`db_for_stop`（退出路径清账用）与健康检查定时器经 `initDaemonSupervisor(db)` /
 * `startDaemonHealthCheck(db)` 落定，避免模块级持有 electron 侧引用。
 */
import type Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { setDeliverableStatus } from './deliverable-lifecycle.js';

export interface RuntimeEntry {
  process: ChildProcess | null; // null=收养的孤儿进程（C2）
  port?: number;
  endpoint?: string;
  pid?: number; // 孤儿进程PID，用于kill
  name?: string;
  // D1: 自动重启追踪
  restartCount?: number;
  lastRestartAt?: number;
  startedAt: number;
}
export const runtimeProcesses = new Map<string, RuntimeEntry>();

// D1: 退避重启配置
const RESTART_DELAYS = [1_000, 5_000, 30_000, 300_000]; // 1s→5s→30s→300s
const MAX_RESTARTS_PER_HOUR = 3;

// D2: 健康检查定时器
let _healthCheckTimer: ReturnType<typeof setInterval> | null = null;

// 引用db用于stop清理（由 `initDaemonSupervisor` 注入）
let db_for_stop: Database.Database | null = null;

/** 注入退出路径清账所需的库（`initProjectIpc` 内调用一次）。 */
export function initDaemonSupervisor(db: Database.Database): void {
  db_for_stop = db;
}

/** D1: 处理daemon退出，判断是否需要自动重启 */
export function handleDaemonExit(db: Database.Database, id: string, name: string, code: number | null, filePath: string): void {
  const entry = runtimeProcesses.get(id);
  if (!entry) return;

  const now = Date.now();
  const runtime = now - entry.startedAt;

  // 正常退出 → 不需要重启
  if (code === 0) {
    console.log(`[daemon:${name}] 正常退出，标记 completed`);
    runtimeProcesses.delete(id);
    setDeliverableStatus(db, id, 'completed', 'daemon:exit');
    return;
  }

  // 启动确认窗内退出 → 启动失败，不重启。
  // zx_20260930 M3-b(庄子「名者，实之宾也」): **此前这一支不写任何状态** —— `runtimeProcesses` 已删
  //   （绿点变红点），库里却仍是 `running`：徽章写「运行中」而进程早已不在，与"退出复位"是同一个谎的两半。
  //   这也是 `failed` 的**真生产者**（此前全仓 `setDeliverableStatus(…,'failed')` 零调用 ⇒ 成果页筛选「失败」恒空）：
  //   进程**根本没起来**，既不是用户停的（`stopped`），也不是正常跑完（`completed`）——正该叫失败。
  if (runtime < 5_000) {
    console.log(`[daemon:${name}] 启动失败(runtime=${runtime}ms)，不重启`);
    runtimeProcesses.delete(id);
    setDeliverableStatus(db, id, 'failed', 'daemon:start_fail');
    return;
  }

  // D1: 异常退出 → 退避重启
  const restartCount = entry.restartCount || 0;
  // 检查1小时内重启次数
  const hourAgo = now - 3600_000;
  if (entry.lastRestartAt && entry.lastRestartAt < hourAgo) {
    entry.restartCount = 0; // 超过1小时重置计数
  }

  if (restartCount >= MAX_RESTARTS_PER_HOUR) {
    console.log(`[daemon:${name}] 已达最大重启次数(${MAX_RESTARTS_PER_HOUR}/h)，停止自动重启`);
    runtimeProcesses.delete(id);
    setDeliverableStatus(db, id, 'stopped', 'daemon:max_restarts');
    return;
  }

  const delay = RESTART_DELAYS[Math.min(restartCount, RESTART_DELAYS.length - 1)]!;
  console.log(`[daemon:${name}] 异常退出(code=${code})，${delay/1000}s后自动重启(第${restartCount+1}次)`);
  runtimeProcesses.delete(id);

  setTimeout(async () => {
    const ext = path.extname(filePath).toLowerCase();
    const command = ext === '.py' ? `python3 "${filePath}"` : ext === '.js' ? `node "${filePath}"` : filePath;
    try {
      const proc = spawn(command, [], { cwd: path.dirname(filePath), stdio: 'pipe', shell: true, env: { ...process.env, DAEMON_ID: id } });
      proc.stdout?.on('data', (data: Buffer) => console.log(`[daemon:${name}] ${data.toString().trim()}`));
      proc.stderr?.on('data', (data: Buffer) => console.error(`[daemon:${name}] ${data.toString().trim()}`));
      proc.on('exit', (exitCode: number | null) => handleDaemonExit(db, id, name, exitCode, filePath));
      runtimeProcesses.set(id, { process: proc, startedAt: Date.now(), restartCount: restartCount + 1, lastRestartAt: now });
      setDeliverableStatus(db, id, 'running', 'daemon:auto_restart');
      console.log(`[daemon:${name}] 自动重启成功(第${restartCount+1}次)`);
    } catch (e) {
      console.error(`[daemon:${name}] 自动重启失败:`, (e as Error).message);
    }
  }, delay);
}

/** 清理孤儿进程（按文件名 + 扫描代码中的端口号） */
export async function killOrphan(filePath: string): Promise<void> {
  const basename = path.basename(filePath).replace(/"/g, '\\"');
  try { execSync(`pkill -9 -f "${basename}"`, { timeout: 5000 }); } catch {}
  const stem = basename.replace(/\.[^.]+$/, '').replace(/"/g, '\\"');
  if (stem !== basename) {
    try { execSync(`pkill -9 -f "${stem}"`, { timeout: 3000 }); } catch {}
  }
  // 扫描代码中的端口号，精准清理
  const dir = fs.existsSync(filePath) ? (fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath)) : null;
  if (dir) {
    const ports = new Set<number>();
    try {
      const walkDir = (d: string, depth: number): void => {
        if (depth > 2) return;
        try {
          for (const name of fs.readdirSync(d)) {
            const full = path.join(d, name);
            try {
              const st = fs.statSync(full);
              if (st.isDirectory() && !name.startsWith('.') && name !== 'node_modules' && name !== '__pycache__' && name !== '.git') {
                walkDir(full, depth + 1);
              } else if (st.isFile() && /\.(py|js|ts|json|yaml|yml|toml|env|conf|sh)$/.test(name)) {
                const content = fs.readFileSync(full, 'utf-8').slice(0, 50_000);
                const portRegex = /\b(?:port\s*[=:]\s*|PORT\s*[=:]\s*|--port\s+|listen\s*\(.*?)(\d{4,5})\b/g;
                let m: RegExpExecArray | null;
                while ((m = portRegex.exec(content)) !== null) {
                  const p = parseInt(m[1]!, 10);
                  if (p >= 1024 && p <= 65535) ports.add(p);
                }
              }
            } catch {}
          }
        } catch {}
      };
      walkDir(dir, 0);
    } catch {}
    for (const port of ports) {
      try {
        const out = execSync(`lsof -ti :${port}`, { timeout: 5000 }).toString().trim();
        if (out) {
          for (const pid of out.split('\n').filter(Boolean)) {
            try { execSync(`kill -9 ${pid}`, { timeout: 3000 }); console.log(`[IPC] 已清理端口 ${port} 的进程 PID=${pid}`); } catch {}
          }
        }
      } catch {}
    }
  }
  await new Promise(r => setTimeout(r, 1500));
}

/** 清理占用指定端口的进程（M15 随族搬入；现仓内零调用，原样保留以备运行期手动清理） */
export function killPort(port: number): void {
  try {
    const out = execSync(`lsof -ti :${port}`, { timeout: 5000 }).toString().trim();
    if (out) {
      const pids = out.split('\n').filter(Boolean);
      for (const pid of pids) {
        try { execSync(`kill -9 ${pid}`, { timeout: 3000 }); console.log(`[IPC] 已清理端口 ${port} 的进程 PID=${pid}`); } catch {}
      }
    }
  } catch {}
}

/** E5/C2: 扫描 MCP 端口收养孤儿进程并注册到 runtimeProcesses Map */
export function adoptMCPOrphans(db: Database.Database): void {
  const PORT_START = 19900;
  const PORT_END = 19999; // 对齐原工蚁 19900-19999
  const mcpDeliverables = db.prepare("SELECT id, name FROM wa_deliverables WHERE type = 'mcp' AND status NOT IN ('running')").all() as Array<{ id: string; name: string }>;
  if (mcpDeliverables.length === 0) return;

  setTimeout(async () => {
    for (let port = PORT_START; port <= PORT_END; port++) {
      try {
        // 检查端口是否被占用并获取 PID
        let pid: number | undefined;
        try {
          const out = execSync(`lsof -i :${port} -t`, { timeout: 2000 }).toString().trim();
          if (!out) continue;
          pid = parseInt(out.split('\n')[0]!, 10) || undefined;
        } catch { continue; }

        // 探测 MCP 服务名
        const resp = await fetch(`http://localhost:${port}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'worker-ant', version: '1.0' } } }),
          signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok) continue;
        const text = await resp.text();
        const dataMatch = text.match(/data:\s*(\{.*\})/);
        if (!dataMatch) continue;
        const data = JSON.parse(dataMatch[1]!);
        const svcName = data?.result?.serverInfo?.name;
        if (!svcName) continue;

        // 匹配 deliverable 名称
        const matched = mcpDeliverables.find(d => d.name.includes(svcName) || svcName.includes(d.name));
        if (matched) {
          setDeliverableStatus(db, matched.id, 'running', 'adopt_orphan');
          // C2: 注册孤儿进程到 Map（process=null 表示收养，stop 时用 pid 清理）
          runtimeProcesses.set(matched.id, {
            process: null,
            pid,
            port,
            endpoint: `http://localhost:${port}/mcp`,
            startedAt: Date.now(),
            name: matched.name,
          });
          console.log(`[MCP] 收养孤儿进程: ${svcName} port=${port} pid=${pid} deliverable=${matched.name}`);
        }
      } catch {}
    }
  }, 5000); // 延迟5秒等MCP服务启动
  console.log(`[MCP] 孤儿收养扫描已排程 (候选: ${mcpDeliverables.length} 个MCP deliverable)`);
}

/** 开机自动启动守护进程 */
export function autoStartDaemons(db: Database.Database): void {
  setTimeout(async () => {
    try {
      const daemons = db.prepare("SELECT * FROM wa_deliverables WHERE type = 'daemon' AND status IN ('running', 'stale', 'completed')").all() as Array<Record<string, unknown>>;
      for (const d of daemons) {
        const filePath = (d.file_path as string) || '';
        if (!filePath || !fs.existsSync(filePath)) continue;
        const ext = path.extname(filePath).toLowerCase();
        const command = ext === '.py' ? `python3 "${filePath}"` : ext === '.js' ? `node "${filePath}"` : filePath;
        await killOrphan(filePath);
        try {
          const proc = spawn(command, [], { cwd: path.dirname(filePath), stdio: 'pipe', shell: true, env: { ...process.env, DAEMON_ID: d.id as string } });
          proc.stdout?.on('data', (data: Buffer) => console.log(`[daemon:${d.name}] ${data.toString().trim()}`));
          proc.stderr?.on('data', (data: Buffer) => console.error(`[daemon:${d.name}] ${data.toString().trim()}`));
          proc.on('exit', (code: number | null) => handleDaemonExit(db, d.id as string, d.name as string, code, filePath));
          runtimeProcesses.set(d.id as string, { process: proc, startedAt: Date.now() });
          setDeliverableStatus(db, d.id as string, 'running', 'auto_start');
          console.log(`[IPC] 守护进程自动启动: ${d.name}`);
        } catch (e) { console.error(`[IPC] 守护进程启动失败: ${d.name}`, (e as Error).message); }
      }
    } catch {}
  }, 2000); // 延迟2秒，等ANS和其他服务就绪
}

/** D2: 守护进程健康检查心跳（每分钟；清死进程 + 刷新 updated_at 防 self-healing-monitor 误判 stale） */
export function startDaemonHealthCheck(db: Database.Database): void {
  _healthCheckTimer = setInterval(() => {
    for (const [id, entry] of runtimeProcesses) {
      if (entry.process && entry.process.exitCode !== null && entry.process.exitCode !== undefined) {
        if (runtimeProcesses.has(id)) runtimeProcesses.delete(id);
      } else {
        // 心跳: 每分钟刷新 updated_at，避免 self-healing-monitor 误判为 stale（对齐原 daemon-manager）
        try { db.prepare("UPDATE wa_deliverables SET updated_at = datetime('now') WHERE id = ? AND type = 'daemon'").run(id); } catch {}
      }
    }
  }, 60_000);
}

/** 停止所有运行中的进程（退出时调用） */
export function stopAllRuntimeProcesses(): void {
  if (_healthCheckTimer) { clearInterval(_healthCheckTimer); _healthCheckTimer = null; }
  for (const [id, rt] of runtimeProcesses) {
    try {
      if (rt.process) {
        rt.process.kill('SIGTERM');
        // 等待500ms让进程优雅退出
        try { execSync('sleep 0.5'); } catch {}
        // 如果还活着，SIGKILL 强制终止
        if (rt.process.exitCode === null && rt.process.killed === false) {
          try { rt.process.kill('SIGKILL'); } catch {}
        }
      } else if (rt.pid) {
        // C2: 收养孤儿进程 → 用OS信号kill
        try { process.kill(rt.pid, 'SIGKILL'); } catch {}
      }
    } catch {}
    // 最后兜底：按文件名 pkill -9 清理残留
    try {
      const d = db_for_stop?.prepare('SELECT file_path FROM wa_deliverables WHERE id = ?').get(id) as { file_path: string } | undefined;
      if (d?.file_path) {
        const basename = path.basename(d.file_path);
        try { execSync(`pkill -9 -f "${basename.replace(/"/g, '\\"')}"`, { timeout: 5000 }); } catch {}
      }
    } catch {}
  }
  runtimeProcesses.clear();
  // zx_20260929 M12-续: 退出路径此前**不记账**。`deliverable:stop` 那侧会落 `'stopped'`，但退出走的是
  // `stopAllA2AServers()` → `stopA2AServer()`，而后者先 `removeAllListeners('exit')`——M12 刻意如此，
  // 为的是"主动停止"不被 exit 回调误报成"运行中死了"；代价是**经退出关机的 a2a 成果库里永远停在
  // `running`**：重启后徽章仍显示「运行中」、`isRunning` 已是假故只有红点「已停止」可辨且无 ■ 可点
  // （实测标本 `zx29-a2a-good`：status=running 跨 20:33 重启一字未动，而 19952 已无监听）。
  // daemon/mcp 不受影响（启动时 `auto_start` 会自愈），a2a 没有自启 ⇒ 这个账只能在这里补。
  if (db_for_stop) {
    const runningA2A = db_for_stop
      .prepare("SELECT id FROM wa_deliverables WHERE type = 'a2a' AND status = 'running'")
      .all() as Array<{ id: string }>;
    for (const r of runningA2A) setDeliverableStatus(db_for_stop, r.id, 'stopped', 'app:quit');
  }
  // 停止 A2A 运行时 + MCP 连接池（优雅关机）
  try { void import('./a2a-runtime.js').then(({ stopAllA2AServers }) => stopAllA2AServers()); } catch {}
  try { void import('./mcp-client-pool.js').then(({ disconnectAll }) => disconnectAll()); } catch {}
  console.log('[IPC] 已停止所有运行时进程 + 健康检查');
}
