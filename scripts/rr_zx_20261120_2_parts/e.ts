/**
 * zx_20261120_2 E 组「实」——收口账纳入真实命令失败。
 *
 * 归属：M5。实施者只改本文件与 M5 的生产代码，不碰其它分组。
 *
 * 纪律：直引生产函数（被删/改名即编译期失败）；被拒行与失败行两侧标本同试；
 *   计数器给 0→N 的正面断言；断言文案不含失败字形。
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { RrHarness } from '../rr_zx_20261120_2.js';
import {
  summarizeCommandFailures,
  commandFailureCheckLine,
} from '../../apps/worker-ant-desktop/src/main/core/tool-denials.js';
import { buildCompletionAccount, buildTaskOutcome } from '../../apps/worker-ant-desktop/src/main/core/task-outcome.js';

let evSeq = 0;
/** 插一条运行证据（生产 `recordRuntimeEvidence` 的同列；这里只造形状）。 */
function addEvidence(
  db: Database.Database,
  taskId: string,
  row: { command: string | null; ok: number; denyReason?: string | null; at?: string },
): void {
  db.prepare(
    `INSERT INTO wa_task_runtime_evidence
       (id, task_id, tool, command, ok, exit_code, timed_out, deny_reason, output_path, output_tail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `ev-${++evSeq}`,
    taskId,
    'execute_command',
    row.command,
    row.ok,
    row.ok === 1 ? 0 : 1,
    0,
    row.denyReason ?? null,
    null,
    null,
    row.at ?? new Date().toISOString(),
  );
}

export function runE(h: RrHarness): void {
  // ── E1：空库 ⇒ total=0，收口行为空串（不出空行） ──────────────────────────
  {
    const db = h.mkdb();
    const s = summarizeCommandFailures(db, 'task-empty');
    h.eq({ total: s.total, byKind: s.byKind, samples: s.samples }, { total: 0, byKind: {}, samples: [] }, 'E1 空库零失败（不带 0 账）');
    h.eq(commandFailureCheckLine(s), '', 'E1 空库收口行为空串');
  }

  // ── E2：1 条 mvn 测试失败 ⇒ total=1、test=1、样本含命令 ───────────────────
  {
    const db = h.mkdb();
    addEvidence(db, 'task-mvn', { command: 'mvn -o -Dtest=JpaAuditingWiringTest test', ok: 0 });
    const s = summarizeCommandFailures(db, 'task-mvn');
    h.eq(s.total, 1, 'E2 测试失败计数 0→1');
    h.eq(s.byKind, { test: 1 }, 'E2 归类为 test');
    h.ok(s.samples.length === 1 && s.samples[0]!.includes('JpaAuditingWiringTest'), 'E2 样本含失败命令');
    const line = commandFailureCheckLine(s);
    h.ok(line.includes('失败 1 次') && line.includes('仅记账，不改评分'), 'E2 收口行带次数且声明不改评分', line);
  }

  // ── E3：被拒行与成功行不计入命令失败（两类各归各） ────────────────────────
  {
    const db = h.mkdb();
    addEvidence(db, 'task-mix', { command: 'mvn -o -Dtest=JpaAuditingWiringTest test', ok: 0, at: '2026-11-20T01:00:00.000Z' });
    // 有 deny_reason 的拒绝行：即便命令形态像测试，也归「工具拒绝」而非「命令失败」
    addEvidence(db, 'task-mix', { command: 'bash -lc "npm test"', ok: 0, denyReason: 'deny_kind=exploration_limit; bash 仍可用', at: '2026-11-20T01:00:01.000Z' });
    // 成功跑完的构建命令：不是失败
    addEvidence(db, 'task-mix', { command: 'pnpm run build', ok: 1, at: '2026-11-20T01:00:02.000Z' });
    // 无 deny_reason 但形态不属于测试/构建：不记
    addEvidence(db, 'task-mix', { command: 'cat schema-local.sql', ok: 0, at: '2026-11-20T01:00:03.000Z' });
    const s = summarizeCommandFailures(db, 'task-mix');
    h.eq(s.total, 1, 'E3 拒绝与成功行不计入（仍为 1）');
    h.eq(s.byKind, { test: 1 }, 'E3 只归测试形态那一条');
  }

  // ── E4：评分与封顶逐字节不变（两只标本 + 端到端附加） ─────────────────────
  {
    const acct80 = buildCompletionAccount({ score: 80, goalAchieved: true, via: 'finalize_task', evidence: 'acceptance_passed' });
    h.eq(acct80, { score: 80, goal_achieved: true, via: 'finalize_task', goal_evidence: 'acceptance_passed' }, 'E4 完成账 80 分标本逐字节不变');
    const acct55 = buildCompletionAccount({ score: 55, goalAchieved: false, via: 'run_close', feedback: '未达标', evidence: 'acceptance_failed', premature: true });
    h.eq(acct55, { score: 55, goal_achieved: false, via: 'run_close', goal_evidence: 'acceptance_failed', feedback: '未达标', premature: true }, 'E4 完成账 55 分被迫收尾标本逐字节不变');

    const db = h.mkdb();
    db.prepare('INSERT INTO wa_tasks (id, project_id, title, context_json) VALUES (?, ?, ?, ?)').run(
      'task-e4', 'p', 'E4', JSON.stringify({
        completion_quality: { score: 80, goal_achieved: true, via: 'finalize_task', goal_evidence: 'acceptance_passed' },
      }),
    );
    addEvidence(db, 'task-e4', { command: 'mvn -o -Dtest=JpaAuditingWiringTest test', ok: 0 });
    const out = buildTaskOutcome(db, 'task-e4');
    h.ok(out.quality?.score === 80, 'E4 端到端评分仍为 80', String(out.quality?.score));
    h.eq(out.quality?.command_failures, { total: 1, byKind: { test: 1 }, samples: ['mvn -o -Dtest=JpaAuditingWiringTest test'] }, 'E4 完成事件只附加 command_failures');
    h.ok(out.quality ? !('premature' in out.quality) : false, 'E4 未凭空加 premature');

    const db0 = h.mkdb();
    db0.prepare('INSERT INTO wa_tasks (id, project_id, title, context_json) VALUES (?, ?, ?, ?)').run(
      'task-e4z', 'p', 'E4z', JSON.stringify({
        completion_quality: { score: 80, goal_achieved: true, via: 'finalize_task', goal_evidence: 'acceptance_passed' },
      }),
    );
    const out0 = buildTaskOutcome(db0, 'task-e4z');
    h.ok(out0.quality ? !('command_failures' in out0.quality) : false, 'E4 零失败不带该键（不编 0）');
  }

  // ── E5：两个收口出口共用同一行函数（按调用语句形状钉） ────────────────────
  {
    const core = path.join(h.root, h.A, 'src/main/core');
    const read = (p: string): string => fs.readFileSync(path.join(core, p), 'utf-8');
    const ef = read('exec-finalize.ts');
    const cf = read('tools/control-finalize.ts');
    const td = read('tool-denials.ts');
    h.ok(/export function commandFailureCheckLine/.test(td), 'E5 行函数单一真源在 tool-denials');
    h.ok(/commandFailureCheckLine\(summarizeCommandFailures\(db, taskId\)\)/.test(ef), 'E5 run_close 出口按形状调用共用行函数');
    h.ok(/commandFailureCheckLine\(summarizeCommandFailures\(db, taskId\)\)/.test(cf), 'E5 finalize 出口按形状调用共用行函数');
    h.ok(!/本轮测试\/构建命令失败/.test(ef) && !/本轮测试\/构建命令失败/.test(cf), 'E5 两出口不各写一份文案');
  }
}
