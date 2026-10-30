/**
 * zx_20260920_1 M1（庄子·无用之用 / 金刚经·不住相）: 由 `agent-executor.ts` 的 `buildTools()`
 * **机械搬迁**而来——工具体**逐字节未改**，只把原来靠外层闭包取到的名字，改为从 `deps` 解构。
 * 搬迁纪律：**工具名 / 参数 schema / execute 行为 / 返回形状一律不动**；此处不新增、不删除任何工具。
 * 依赖面（6 项）由 `ToolDeps` 声明式给出，不再依赖隐式闭包。
 */
import type { ToolDeps } from './deps.js';
import path from 'node:path';
import { readBoolSetting } from '../settings-bool.js';
import { jsonSchema } from 'ai';
import { runShellCommand, truncationNote } from '../shell-exec.js';

import { validateReadonlyBashCommand, sanitizeLoneSurrogates, searchPathForPattern, paginateReadFile, shellRejectPayload, shellRejectPayloadForChar, buildToolConstraintBrief, evaluateMultiSegment } from '../tool-guards.js';
// zx_20261029_3 M3：四个工具在**唯一执行口** `runShellCommand` 前后登记后台进程（账不是闸，失败不阻断）。
import { makeShellHooks, leftoverNote } from '../background-jobs.js';

export function shellTools(deps: ToolDeps) {
  const { db, taskId, projectId, workingDir, pauseForDecision, registerFilesWrittenByCommand } = deps;
  return {
    execute_command: {
      description: '执行通用shell命令（超时30s，配额20次；**可 `cd`、可多步写操作**）。开启 `engine.shell_multi_segment` 时可用 `;`/`&&`/`||` 分段（**每一段都逐段检查**）；**不支持 `|` 管道与后台 `&`**——要管道请用 `bash` 工具。⚠ 工作目录**已经是本任务的项目目录**，一般**无需 `cd`**。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          command: { type: 'string', description: '要执行的命令' },
        },
        required: ['command'],
      }),
      execute: async (args: { command: string }) => {
        // 安全防护：破坏性命令 + shell 解释器直接执行拦截（对齐原版 bash 安全模型）
        const DESTROY = ['rm -rf', 'mkfs', 'dd if=', 'chmod 777', ':(){', 'fork bomb'];
        if (DESTROY.some(p => args.command.includes(p))) return JSON.stringify({ error: '破坏性命令被拦截，禁止执行' });
        // 沙箱意图分类：拦截 Destructive/SystemAdmin 命令（sandbox.ts）
        try {
          const { classifyBashCommand } = await import('../sandbox.js');
          const intent = classifyBashCommand(args.command);
          if (intent === 'Destructive') return JSON.stringify({ error: '破坏性命令被沙箱拦截（rm/mkfs/dd 等）' });
          if (intent === 'SystemAdmin') return JSON.stringify({ error: '系统管理命令被沙箱拦截（sudo/apt/docker 等）。请用 ask_user→run_privileged 请求批准。' });
        } catch {}
        const cmdName = args.command.trim().split(/\s+/)[0]?.split('/').pop() || '';
        if (['sh', 'bash', 'zsh'].includes(cmdName)) {
          return JSON.stringify({ requires_privilege: true, command: args.command, message: '禁止直接执行shell解释器。请使用 ask_user 请求用户批准，用户批准后用 run_privileged 执行。' });
        }
        // E2 (2026-09-03): 仅放行分组括号 ( )（find 分组/sed 片段等常用），其余分隔符/替换符仍拦截。
        // zx_20260915 M5/P0-7：裸正则删去，改由真源判定（两处**调用**、一处**实现**）；
        // 命中时回的是「指名被拒字符 + 给正解」的如实文案，**不再把语法问题说成权限问题**
        // （旧文案建议 `run_privileged`，把只读命令推向审批通道）。回退开关 `engine.shell_advice_honest`。
        // zx_20261029_3 M5：开关开 ⇒ 逐段判定（语法与权限分开看）；关 ⇒ 逐字回字符层的旧行为。
        //   整串原检查（上面 DESTROY / 整串 classify / 解释器首 token）仍先跑；本层是**加一道**。
        if (readBoolSetting(db, 'engine.shell_multi_segment')) {
          const mv = evaluateMultiSegment(args.command, 'execute_command', workingDir);
          if (!mv.ok) return JSON.stringify(mv.payload);
        } else {
          const cmdReject = shellRejectPayload(args.command, 'execute_command', workingDir, readBoolSetting(db, 'engine.shell_advice_honest'));
          if (cmdReject) return JSON.stringify(cmdReject);
        }
        // zx_20260917 M4·§6.1-3: 子进程落盘**零登记**是判卷盲的第二个来源。基准时刻取在命令**启动前**，
        // 命令返回后按它盘点——归因窗口＝该条命令自身（不是"最近 N 分钟"，§6.1-3 红线）。
        const writeBaselineMs = Date.now();
        // zx_20260916_2 M1: 改走异步外壳——命令跑多久不再等于事件循环被占多久
        const tracked = makeShellHooks(db, { projectId, taskId, tool: 'execute_command', command: args.command, cwd: workingDir });
        const r = await runShellCommand(args.command, { cwd: workingDir, timeoutMs: 30_000, maxBuffer: 1024 * 1024, ...tracked.hooks });
        await registerFilesWrittenByCommand(db, { projectId, taskId, workingDir, sinceMs: writeBaselineMs, via: 'execute_command' });
        if (!r.ok) return JSON.stringify({ error: r.error, stdout: r.stdout.slice(0, 5000), stderr: r.stderr.slice(0, 5000) });
        return r.stdout.slice(0, 10000) + truncationNote(r) + leftoverNote(db, tracked.jobId);
      },
    },
    bash: {
      description: '执行**只读**白名单命令（cat/head/tail/wc/ls/find/tree/pwd/grep/awk/sed/sort/uniq/diff/git/python3/node…）。**支持 `|` 管道**；**不支持 `;`/`&`/`cd`/重定向**。写文件用 write_file，特权命令用 ask_user→run_privileged。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: { command: { type: 'string', description: '只读命令' } },
        required: ['command'],
      }),
      execute: async (args: { command: string }) => {
        const command = args.command.trim();
        // E2 (2026-09-03) 语义模式白名单；zx_20260911_3 M3-4 切分改引号感知（`|` 在 shell 是管道、在 regex 是交替，
        // 此前 split('|') 把 `grep -n "a\|b" f` 切成碎片 → 段首 token 不在白名单 → 只读命令被误拒）。
        const verdict = validateReadonlyBashCommand(command);
        if (!verdict.ok) {
          // zx_20260915 M5/P0-7：**只**接管字符级那一支——`char` 是 `validateReadonlyBashCommand` 落下的界桩，
          // 有它才换文案；其余七支（破坏性/解释器/$()/sed -i/find -exec/重定向/白名单）原样返回（§7.3 红线）。
          const rejChar = (verdict.payload as { char?: string }).char;
          if (rejChar && readBoolSetting(db, 'engine.shell_advice_honest')) {
            return JSON.stringify({ ...verdict.payload, ...shellRejectPayloadForChar(rejChar, 'bash', workingDir) });
          }
          return JSON.stringify(verdict.payload);
        }
        const tracked = makeShellHooks(db, { projectId, taskId, tool: 'bash', command, cwd: workingDir });
        const r = await runShellCommand(command, { cwd: workingDir, timeoutMs: 30_000, maxBuffer: 1024 * 1024, ...tracked.hooks });
        if (!r.ok) return JSON.stringify({ error: r.error, stdout: r.stdout.slice(0, 3000), stderr: r.stderr.slice(0, 3000) });
        return r.stdout.slice(0, 10000) + truncationNote(r) + leftoverNote(db, tracked.jobId);
      },
    },
    git_clone: {
      description: '克隆git仓库到项目工作目录。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          repoUrl: { type: 'string', description: '仓库URL' },
          targetDir: { type: 'string', description: '目标目录名（可选）' },
        },
        required: ['repoUrl'],
      }),
      execute: async (args: { repoUrl: string; targetDir?: string }) => {
        if (!/^(https?|git):\/\/.+/.test(args.repoUrl) || /[;&|`$(){}\n]/.test(args.repoUrl)) return JSON.stringify({ error: 'URL不合法' });
        const repoName = args.repoUrl.split('/').pop()?.replace('.git', '') || 'repo';
        const targetPath = path.join(workingDir, args.targetDir || repoName);
        if (!path.resolve(targetPath).startsWith(path.resolve(workingDir))) return JSON.stringify({ error: '路径越界' });
        const cloneCmd = `git clone --depth 1 ${args.repoUrl} ${targetPath}`;
        const tracked = makeShellHooks(db, { projectId, taskId, tool: 'git_clone', command: cloneCmd, cwd: workingDir });
        const r = await runShellCommand(cloneCmd, { cwd: workingDir, timeoutMs: 60_000, maxBuffer: 1024 * 1024, ...tracked.hooks });
        if (!r.ok) return JSON.stringify({ error: `clone失败: ${(r.error || '').slice(0, 200)}` });
        return JSON.stringify({ repoUrl: args.repoUrl, targetPath, status: 'cloned' });
      },
    },
    run_privileged: {
      description: '在用户批准后执行需要特权的命令。仅在 ask_user 获得确认后调用。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          reason: { type: 'string', description: '执行原因说明' },
        },
        required: ['command'],
      }),
      execute: async (args: { command: string; reason?: string }) => {
        // 破坏性命令拦截
        const DESTROY = ['rm -rf', 'mkfs', 'dd if=', 'chmod 777'];
        if (DESTROY.some(p => args.command.includes(p))) return JSON.stringify({ error: '破坏性命令被拦截' });
        // 危险删除路径检测（rm -r / 、rm -rf ~ 等，字面 DESTROY 匹配会漏掉不含 -f 的 rm）
        try {
          const { isDangerousRemovalPath } = await import('../sandbox.js');
          const rmMatch = args.command.match(/\brm(?:dir)?\s+(?:-[a-zA-Z]+\s+)*['"]?([^'";|&>\s]+)/);
          if (rmMatch && isDangerousRemovalPath(rmMatch[1])) {
            return JSON.stringify({ error: `危险删除路径被拦截: ${rmMatch[1]}` });
          }
        } catch {}
        // 沙箱意图分类：破坏性命令不可批准（isPrivilegeRequestable）
        try {
          const { classifyBashCommand, isPrivilegeRequestable } = await import('../sandbox.js');
          const intent = classifyBashCommand(args.command);
          if (!isPrivilegeRequestable(intent, args.command)) return JSON.stringify({ error: '该命令不可通过特权执行（破坏性命令）。' });
        } catch {}
        // 持久化权限：命令指纹（前2 token，如 "pip install"）已批准则自动放行，跳过重复询问
        const fingerprint = args.command.trim().split(/\s+/).slice(0, 2).join(' ');
        const alreadyApproved = (() => {
          try {
            return !!db.prepare("SELECT 1 FROM wa_approvals WHERE project_id = ? AND kind = 'command' AND command_fingerprint = ?").get(projectId, fingerprint);
          } catch { return false; }
        })();
        if (!alreadyApproved) {
          // Phase 2: 实时暂停等待用户决策（替代「最近10条对话含"是"」文本匹配）；拒绝追踪移至 task:respond 处理
          try {
            const taskCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined)?.context_json || '{}') as Record<string, unknown>;
            taskCtx.pending_approval = { type: 'privilege', command: args.command, fingerprint };
            db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(taskCtx), taskId);
          } catch { /* 记录待审批失败不阻断暂停 */ }
          return pauseForDecision('privilege_approval', `是否批准执行特权命令「${args.command.slice(0, 120)}」？`, null, { command: args.command, reason: args.reason ?? '' });
        }
        // 特权命令（用户已批准）执行：不做文件写隔离——pip/git/npm 需写工作目录外(site-packages/克隆目标)。
        // 破坏性/危险删除已在前置步骤拦截，进程隔离沙箱对特权命令不适用。
        // zx_20260917 M4·§6.1-3: 同 `execute_command`——本工具是最能写的一个（pip/git/npm），
        // 而它此前**零登记**。边界如实：写到**工作目录外**的（site-packages 等）本函数看不见（§6.0bis-d）。
        const writeBaselineMs = Date.now();
        // zx_20261029_3 M3：`run_privileged` 是最能起常驻服务的一路（`npm run dev &` 之类——
        //   shell 秒退、进程组由孙进程持有），同样登记；回话里如实补一句"可在活动页查看/停止"。
        const tracked = makeShellHooks(db, { projectId, taskId, tool: 'run_privileged', command: args.command, cwd: workingDir });
        const r = await runShellCommand(args.command, { cwd: workingDir, timeoutMs: 60_000, maxBuffer: 2 * 1024 * 1024, ...tracked.hooks });
        await registerFilesWrittenByCommand(db, { projectId, taskId, workingDir, sinceMs: writeBaselineMs, via: 'run_privileged' });
        if (!r.ok) return JSON.stringify({ error: r.error, stdout: r.stdout.slice(0, 5000), stderr: r.stderr.slice(0, 5000) });
        return r.stdout.slice(0, 10000) + truncationNote(r) + leftoverNote(db, tracked.jobId);
      },
    },
  };
}
