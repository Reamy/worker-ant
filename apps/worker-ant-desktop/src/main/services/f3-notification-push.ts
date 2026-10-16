/**
 * zx_20261003 M9（纯搬移·零语义变更）: F3 通知推送（通道B）——通知目录扫描、播报发送、守护进程播报健康检查
 * 与整个 `_f3*` 模块态。
 *
 * 搬迁来源：`services/im-router.ts` 原 `:983`–`:1153`（`// ====== F3 通知推送（通道B） ======` 起，
 *   含 `PROBE_NOTIFY_PREFIXES`/`isProbeNotifyFile`、`processF3NotificationFiles`、`triggerF3Notification`、
 *   `checkBroadcastHealth`、`startF3NotificationPush`、`stopF3NotificationPush`），**逐字搬运**。
 *
 * 唯一的机械改写：段内 **3 处**目录兜底（原 `:1035`/`:1103`/`:1143`）
 *   `_notificationDir || path.join(process.cwd(), '../../data/notification_payloads')`
 *   改为 `resolveNotificationDir()`（真源 `core/notify-dir.ts`，全仓**唯一**一处解析式）。
 *   命令侧（`im-router.ts` 的 `tryImCommand`）第 4 处兜底同走该解析式——四处归一，防"两份目录"。
 *
 * `im-router.ts` 保留同名再导出，故既有 import（`ipc/im.ipc.ts`、`core/jobs/ai-task.ts`、rr）不改仍解析。
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { clipWithNotice, IM_ROUTER_OUTPUT_LIMIT } from '../core/im/im-text.js';
import { resolveNotificationDir } from '../core/notify-dir.js';

// ====== F3 通知推送（通道B） ======

let _f3Timer: ReturnType<typeof setInterval> | null = null;
let _f3LastSuccess = 0;
const _f3ProcessedFiles = new Set<string>();
let _f3Db: Database.Database | null = null;
let _f3GetEnabledChannels: (() => Array<{ id: string; channelType: string; sendReply: (toUser: string, text: string) => Promise<void>; lastExternalUser?: string }>) | null = null;

/**
 * 通知目录里**临时/探针类**文件的前缀表——**唯一一份**（zx_20260916 M3）。
 *
 * 病根（跨仓 F3 挂账，A_20260914 登记、已滚两轮）：`processF3NotificationFiles` 的过滤只滤
 * `.endsWith('.txt')`，而 IM 命令路（`tryImCommand`）明确排除 `P0_`——**两路对"哪些文件
 * 是给用户看的"口径不一致**。若某次调试/核实过程在 `NOTIFICATION_PAYLOAD_DIR` 落一个 `_tmp_*.txt`，
 * F3 会把它**原样广播到用户的 IM**。
 *
 * ⚠ **本注释按函数名引用、不写行号**：跨仓 F3 挂账之所以滚两轮，正是因为原锚点写的是行号
 *   （A_20260914 记 `:748-751`），漂到下一轮就指向了无关的 `.filter(...)`，A_20260916 干脆丢掉行号
 *   变成"无法复核的挂账"。行号是**位置**、会漂；函数名是**身份**、不漂。
 *
 * 命名口径**与 a-stock 侧 `check_command_consistency.py` 的探针名对齐**（该仓多处用
 * `("test_", "_tmp", "_verify", "inspect_")`，如 `h17_is_legacy_bypass` 一带的豁免判断），
 * 便于跨仓对读——不是另起一套词。
 *
 * 实测（2026-09-16）：本表在 F3 队列里**零命中** ⇒ 本条是**预防性**的，不是已发生的泄漏。
 * 如实记，不夸大为"已修线上故障"。
 *
 * ⚠ **取数口径订正（初稿此处引错了目录）**：原注释引的是
 * `/Users/devuser/works/my/data/notification_payloads/`（当时 23 个 `.txt`）——**那不是 F3 队列**，
 * 是 a-stock 侧一条**不经桌面 env** 的落盘路径。F3 真正监听的是 `initImIpc(db, dataDir)` 注入的
 * `path.join(dataDir, 'notification_payloads')`（dev 即仓库根 `data/`），**不是** `process.cwd()`
 * 推导出来的那个。在错目录里数 `.txt`，数不出 F3 看什么——a-stock `A_20260912.md` §M6 订正 7
 * 早已写明："worker-ant 的 `data/notification_payloads` 才是 F3 真正会取走并发用户微信的队列"。
 * 复核（任意时刻，应得 0 行）：
 * `ls "$(git rev-parse --show-toplevel)/data/notification_payloads" | grep -E '^(test_|_tmp|_probe|_verify|inspect_|tmp_)'`
 *
 * 实机 E2E 正面证据（2026-09-16）：同批落 `E2E_control_*.txt` 与 `_tmp_probe_e2e_*.txt` 各一 ⇒
 * 对照被消费删除并留下 `outbound/sent` 记录，探针**留在原地、无任何播报记录**。
 */
export const PROBE_NOTIFY_PREFIXES: readonly string[] = ['test_', '_tmp', '_probe', '_verify', 'inspect_', 'tmp_'];

/** 该通知文件名是否为临时/探针类（大小写不敏感）。导出供受控回归直跑真实现。 */
export function isProbeNotifyFile(fileName: string): boolean {
  const n = String(fileName ?? '').toLowerCase();
  return PROBE_NOTIFY_PREFIXES.some((p) => n.startsWith(p));
}

/** F3 通知文件处理（单次扫描+发送），供周期定时器和任务完成后即时触发复用 */
async function processF3NotificationFiles(): Promise<void> {
  if (!_f3Db || !_f3GetEnabledChannels) return;
  const db = _f3Db;
  const getEnabledChannels = _f3GetEnabledChannels;
  const notifyDir = resolveNotificationDir();
  try {
    const channels = getEnabledChannels();
    if (channels.length === 0) return;

    // zx_20260916 M3: 临时/探针类 `.txt` **不播报**——豁免表与 IM 命令路共用 `isProbeNotifyFile`
    //   （同一件事两个滤器各写一份即分家，本仓 G2 病根；此处**刻意不**把 `P0_` 的差异并进来，
    //   那条差异是实质的：`P0_` 是给播报的、不是给命令的）。
    const files = fs.readdirSync(notifyDir)
      .filter(f => f.endsWith('.txt') && !isProbeNotifyFile(f))
      .sort()
      .slice(0, 20);

    for (const file of files) {
      const filePath = path.join(notifyDir, file);
      if (_f3ProcessedFiles.has(filePath)) continue;
      try {
        const stat = fs.statSync(filePath);
        if (Date.now() - stat.mtimeMs < 10_000) continue;
      } catch {}

      try {
        const content = clipWithNotice(fs.readFileSync(filePath, 'utf-8'), IM_ROUTER_OUTPUT_LIMIT);
        if (content.length < 20) { try { fs.unlinkSync(filePath); } catch {} continue; }

        let allSent = true;
        for (const ch of channels) {
          try {
            const lastConv = db.prepare(
              "SELECT external_user_id FROM wa_im_conversations WHERE channel_id = ? AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1"
            ).get(ch.id) as { external_user_id: string } | undefined;
            const toUser = ch.lastExternalUser || lastConv?.external_user_id;
            if (!toUser) { allSent = false; continue; }  // 无目标用户，标记失败避免误删
            await ch.sendReply(toUser, content);
          } catch { allSent = false; }
        }

        if (allSent) {
          _f3ProcessedFiles.add(filePath);
          _f3LastSuccess = Date.now();
          try { fs.unlinkSync(filePath); } catch {}
        } else {
          // 发送失败：保留文件待下次扫描（30秒后）重试，仅当超过 2 小时仍未成功才放弃删除。
          // 覆盖微信长时间中断（如 App Nap 节流数小时）后恢复重发的场景，避免短窗口误删推送。
          try {
            const ageMs = Date.now() - fs.statSync(filePath).mtimeMs;
            if (ageMs > 7200_000) { fs.unlinkSync(filePath); }
          } catch {}
        }
      } catch {}
    }
  } catch (err) {
    console.error('[F3] 通知推送异常:', (err as Error).message);
  }
}

/** F3 通知文件处理（任务完成后立即触发一次） */
export function triggerF3Notification(): void {
  void processF3NotificationFiles();
}

/** 守护进程播报健康检查：读取各项目 context_json.broadcast_health 配置，泛化检测定时播报是否生成，错过则写告警 */
function checkBroadcastHealth(): void {
  try {
    const now = new Date();
    if (now.getDay() === 0 || now.getDay() === 6) return;
    const today = now.toISOString().slice(0, 10);
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const notifyDir = resolveNotificationDir();
    if (!_f3Db) return;

    // 遍历所有活跃项目，读取其 broadcast_health 配置（项目自声明播报点+守护进程名）
    const projects = _f3Db.prepare("SELECT id, name, context_json FROM wa_projects WHERE status = 'active'").all() as Array<{ id: string; name: string; context_json: string }>;
    for (const proj of projects) {
      let ctx: Record<string, unknown> = {};
      try { ctx = JSON.parse(proj.context_json || '{}'); } catch { continue; }
      const health = ctx.broadcast_health as { daemon?: string; slots?: Array<{ time: string; slot: string; label: string }> } | undefined;
      if (!health?.slots?.length) continue;
      const daemonName = health.daemon || '守护进程';

      for (const slot of health.slots) {
        const [h, m] = (slot.time || '').split(':').map(Number);
        if (isNaN(h) || isNaN(m)) continue;
        const minutesPast = currentMinutes - (h * 60 + m);
        if (minutesPast < 5 || minutesPast > 30) continue;
        const expectedFile = `broadcast_${slot.slot}_${today}.txt`;
        const filePath = path.join(notifyDir, expectedFile);
        if (fs.existsSync(filePath)) continue;
        if ([..._f3ProcessedFiles].some(fp => fp.endsWith(expectedFile))) continue;
        if (!fs.existsSync(notifyDir)) continue;
        const hasRetry = fs.readdirSync(notifyDir).some(f => f.includes(slot.slot) && f.includes(today));
        if (hasRetry) continue;
        // v12.1 后 scheduled_broadcast 已合并到 3-push，broadcast_*.txt 不再由守护进程生成，
        // 广播缺失不再代表守护进程异常，仅记录日志避免每天误发 P0 告警。
        console.warn(`[F3] 播报健康检查: ${proj.name}·${slot.label}(${slot.time}) 无 broadcast 文件（已合并到3-push，跳过告警）`);
      }
    }
  } catch { /* 健康检查best-effort */ }
}

export function startF3NotificationPush(
  db: Database.Database,
  getEnabledChannels: () => Array<{ id: string; channelType: string; sendReply: (toUser: string, text: string) => Promise<void>; lastExternalUser?: string }>,
): void {
  if (_f3Timer) return;
  _f3Db = db;
  _f3GetEnabledChannels = getEnabledChannels;

  const notifyDir = resolveNotificationDir();
  if (!fs.existsSync(notifyDir)) fs.mkdirSync(notifyDir, { recursive: true });

  _f3Timer = setInterval(() => { void processF3NotificationFiles(); checkBroadcastHealth(); }, 30_000);

  console.log(`[F3] 通知推送已启动 notifyDir=${notifyDir}`);
}

export function stopF3NotificationPush(): void {
  if (_f3Timer) { clearInterval(_f3Timer); _f3Timer = null; console.log('[F3] 通知推送已停止'); }
}
