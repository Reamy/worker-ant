/**
 * zx_20261120_1 M6：跨机只读分析的**本机双端**判据。
 *
 * 真事：本地 bare 仓 + 一个真实 clone（A 端项目工作目录）；B 端按 A 随单带来的 `repo{url,ref}`
 *   clone 到 `<dataDir>/remote-workspaces/`，任务上下文落 `remote_readonly` / `remote_workspace`；
 *   回执按只读分支认「结论」。
 *
 * 诚实边界：不调真实模型、不起真实 ANS、不是两台物理机——它证明的是**契约与接线**，
 *   不是"模型在远端真能分析"。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { initDatabase } from '../apps/worker-ant-desktop/src/main/database.js';
import { repoBindingFromDir } from '../apps/worker-ant-desktop/src/main/core/repo-origin.js';
import { sanitizeRepoBinding, prepareRemoteWorkspace, redactUrl } from '../apps/worker-ant-desktop/src/main/core/remote-workspace.js';
import { resolveTaskWorkingDir } from '../apps/worker-ant-desktop/src/main/core/exec-task-dir.js';
import { verifyRemoteReceipt, receiptNote } from '../apps/worker-ant-desktop/src/main/core/node-receipt.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ok ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-zx-20261120-1-'));
  try {
    // ── A 端：真实仓（origin → 本地 bare） ───────────────────────────────
    const bare = path.join(root, 'bare.git');
    fs.mkdirSync(bare);
    execFileSync('git', ['init', '--bare', '-q', bare]);
    const work = path.join(root, 'a-project');
    execFileSync('git', ['clone', '-q', bare, work]);
    fs.writeFileSync(path.join(work, 'README.md'), '# demo\n');
    const g = (args: string[]) => execFileSync('git', ['-C', work, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], { encoding: 'utf-8' });
    g(['add', 'README.md']); g(['commit', '-qm', 'init']); g(['push', '-q', 'origin', 'HEAD']);
    const branch = g(['symbolic-ref', '--short', 'HEAD']).trim();
    const head = g(['rev-parse', 'HEAD']).trim();

    const binding = repoBindingFromDir(work);
    ok(!!binding, 'A 端读到 origin + HEAD');
    ok(binding?.ref === head, 'A 端提交与 HEAD 一致', head.slice(0, 8));
    const safe = sanitizeRepoBinding(binding, { allowFile: true });
    ok(!!safe, 'A 端绑定通过接收端同一份收窄');

    // ── B 端：按绑定 clone + 落任务上下文 ────────────────────────────────
    const dataDir = path.join(root, 'b-data');
    const ws = await prepareRemoteWorkspace({ repo: safe, baseDir: path.join(dataDir, 'remote-workspaces'), allowFile: true });
    ok(ws.ok && ws.commit === head, 'B 端 clone 到同一提交', ws.reason);
    ok(fs.existsSync(path.join(ws.dir, 'README.md')), 'B 端工作区内容在盘');

    const dbDir = path.join(dataDir, 'db');
    const db = initDatabase(dbDir);
    db.prepare("INSERT INTO wa_projects (id, name) VALUES ('relay','AI 终端中转')").run();
    db.prepare(
      `INSERT INTO wa_tasks (id, project_id, title, status, context_json)
       VALUES ('b-task','relay','只读分析','pending',?)`,
    ).run(JSON.stringify({
      remote_readonly: true,
      remote_workspace: ws.dir,
      remote_repo: { url: redactUrl(safe!.url), ref: safe!.ref, commit: ws.commit },
      readonly_deny_tools: ['write_file', 'edit_file', 'register_deliverable', 'execute_command'],
    }));
    const dir = resolveTaskWorkingDir(db, 'b-task');
    ok(dir.source === 'remote' && dir.dir === ws.dir, 'B 端执行目录 = clone 工作区');

    // ── 回执：只读分支认结论 ─────────────────────────────────────────────
    const receipt = verifyRemoteReceipt({
      localTaskId: 'a-task',
      result: {
        taskId: 'a-task', taskStatus: 'completed', readonly: true,
        summary: '只读分析结论：该仓库只有一份 README，无构建脚本；建议补充 CI 与测试入口。',
      },
      hasLocalEvent: true,
      checkedAt: new Date().toISOString(),
    });
    ok(receipt.verdict === 'verified', '回执核对通过（只读结论）', receiptNote(receipt));
    ok(receipt.outputCount === 1 && (receipt.summaryChars ?? 0) > 20, '结论即 1 项产物且字数可核对');

    // ── 失败路：坏远端如实回 repo_unavailable ───────────────────────────
    const bad = await prepareRemoteWorkspace({
      repo: { url: `file://${path.join(root, 'nope.git')}`, ref: branch },
      baseDir: path.join(dataDir, 'remote-workspaces'),
      allowFile: true,
    });
    ok(!bad.ok && bad.reason === 'clone_failed', '坏远端 → clone_failed（调用方回 repo_unavailable）');

    db.close();
    console.log(`\n${pass} passed, ${fail} failed`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.exit(fail === 0 ? 0 : 1);
}

void main();
