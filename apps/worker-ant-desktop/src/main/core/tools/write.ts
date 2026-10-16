/**
 * zx_20260920_1 M1（庄子·无用之用 / 金刚经·不住相）: 由 `agent-executor.ts` 的 `buildTools()`
 * **机械搬迁**而来——工具体**逐字节未改**，只把原来靠外层闭包取到的名字，改为从 `deps` 解构。
 * 搬迁纪律：**工具名 / 参数 schema / execute 行为 / 返回形状一律不动**；此处不新增、不删除任何工具。
 * 依赖面（9 项）由 `ToolDeps` 声明式给出，不再依赖隐式闭包。
 */
import type { ToolDeps } from './deps.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { boolSetting, readBoolSetting } from '../settings-bool.js';
import { computeDiff } from '../file-diff.js';
import { eventBus } from '../event-bus.js';
import { jsonSchema } from 'ai';
import { setDeliverableStatus, promoteTaskFileDeliverables, autoAssignPrimary, selectProbeDeliverables, disposeProbeDeliverables, readAcceptanceCheck, docNotProbe, findDeliverableByPath, createDeliverable, isServiceType, isDocPath, isModuleFilePath } from '../deliverable-lifecycle.js';

/**
 * zx_20261002 M17-①（管子·度量衡 / 维特根斯坦「意义即用法」）: 「先读后改」的**一处真源**。
 *
 * 病根：`edit_file` 原先只在 old_string **没找到**时给一句 `hint: '请用 read_file 确认文件内容后重试'`——
 *   那是"改失败了"之后的重试建议，**不是**"改之前必须读"的门禁。一个从没看过文件内容的模型可以直接
 *   `edit_file`，靠猜 old_string。ClaudeCode 的规则是：**未读过的文件不许改**。
 *
 * 本常量**同时**是：① `edit_file.description` 里模型读到的规则句；② 门禁拒绝时回给模型的 error；
 *   ③ `agent-executor.ts` 系统提示词里的那条铁律。三处引用**同一个字符串**——
 *   各写一份就是"提示词说一套、门禁判另一套"（把判据与实现拆成两处的老形状）。
 */
export const EDIT_FILE_READ_FIRST = '先读后改：修改文件前必须先用 read_file 读过该文件；本任务内新建/改写过的文件（write_file）视为已知，无需再读';

export function writeTools(deps: ToolDeps) {
  const { ctx, db, taskId, projectId, workingDir, approvePathWrite, ensureDocDeliverable, ARTIFACT_WRITE_TOOLS, logger } = deps;
  return {
    write_file: {
      description: '写入文件内容。自动创建父目录。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          filePath: { type: 'string', description: '文件路径（可相对working_dir或绝对路径）' },
          content: { type: 'string', description: '文件完整内容' },
        },
        required: ['filePath', 'content'],
      }),
      execute: async (args: { filePath: string; content: string }) => {
        // 硬拒绝：路径遍历 + 非法字符（安全红线，不可审批）
        if (args.filePath.includes('..')) return JSON.stringify({ error: '禁止路径遍历(..)' });
        if (/[;&|`$(){}]/.test(args.filePath)) return JSON.stringify({ error: '路径包含非法字符' });
        if (args.content.length > 500_000) return JSON.stringify({ error: '内容过大(>500KB)，请分段写入' });
        // 沙箱路径围栏：软边界(工作目录外普通路径)可审批，硬边界(敏感/TOCTOU)拒绝
        // zx_20260929 M3（J-1）：import 失败 ⇒ **fail-closed 拒写**。原为空 `catch {}`——
        // "沙箱模块没加载上"与"路径没问题"在调用方看来长得一模一样，围栏**整个不上路**而无人察觉。
        let scope;
        try {
          const { enforcePathScope } = await import('../sandbox.js');
          scope = enforcePathScope(args.filePath, workingDir, 'workspace');
        } catch (e) {
          logger.error({ filePath: args.filePath, err: (e as Error).message }, '沙箱模块加载失败：写路径围栏无法校验，按 fail-closed 拒绝写入');
          return JSON.stringify({ error: '路径围栏不可用（沙箱模块加载失败），已拒绝写入' });
        }
        if (!scope.allowed) {
          if (scope.approvable) {
            const ap = await approvePathWrite(scope.resolvedPath);
            if (!ap.allowed) return ap.response ?? JSON.stringify({ error: ap.reason });
          } else {
            return JSON.stringify({ error: scope.reason || '路径被沙箱拦截' });
          }
        }
        const fp = path.isAbsolute(args.filePath) ? args.filePath : path.join(workingDir, args.filePath);
        const dir = path.dirname(fp);
        // zx_20260916_2 M2: 本执行块内零同步 I/O（原 `existsSync`+`mkdirSync`/`readFileSync`/`writeFileSync`/`statSync`）。
        //   `mkdir({recursive})` 本就幂等（目录已在时不抛），无须先探存在；存在性判定仍与旧 `existsSync(fp)` 同尺。
        await fsp.mkdir(dir, { recursive: true });
        // 版本快照：更新已有文件时保存旧内容
        const existedBefore = await fsp.stat(fp).then(() => true, () => false);
        let isUpdate = false;
        let prevContent: string | null = null;
        if (existedBefore) {
          try {
            prevContent = await fsp.readFile(fp, 'utf-8');
            if (prevContent.length < 50_000 && prevContent !== args.content) {
              // 交付物版本快照仍仅针对文档类文件，避免过度落盘；diff 对所有文本文件生效
              isUpdate = fp.endsWith('.md') || fp.endsWith('.txt') || fp.endsWith('.py');
            }
          } catch {}
        }
        await fsp.writeFile(fp, args.content, 'utf-8');
        // zx_20261002 M17-①「先读后改」的**放行与留痕**：模型自己写的文件，内容本就已知 ⇒ 入册、
        //   后续 edit_file 免读（这是「确实无需读全文」那一类的合法放行；`debug` 落一条痕便于事后追为什么放行）。
        deps.readFiles.add(path.resolve(fp));
        logger.debug({ filePath: args.filePath }, '先读后改：write_file 已入册（该文件后续 edit_file 免读）');
        const stat = await fsp.stat(fp);
        // 自动注册 doc 产出物（upsert）
        let deliverableId = '';
        try {
          // zx_20260917 M4·§6.1-4: 登记形状收一处（`ensureDocDeliverable`）——`edit_file` 与子进程落盘读**同一份**。
          // 本处行为逐字不变，只是搬进了那个函数（含"不夺归属"与 forceEmit 的差别）：
          //   · 已有登记行 ⇒ 不夺归属(zx_20260913 M2-2)、重写回 draft、不发 forceEmit；
          //   · 无登记行 ⇒ 新建 doc/draft 并发事件。
          deliverableId = ensureDocDeliverable(db, { projectId, taskId, absPath: fp, displayPath: args.filePath, via: 'write_file' }).id;
          if (isUpdate && prevContent !== null) {
            const versionCount = (db.prepare('SELECT COUNT(*) as c FROM wa_deliverable_versions WHERE deliverable_id = ?').get(deliverableId) as { c: number }).c;
            db.prepare('INSERT INTO wa_deliverable_versions (id, deliverable_id, file_path, content_snapshot, size, version, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .run(crypto.randomUUID(), deliverableId, fp, prevContent, prevContent.length, versionCount + 1, taskId);
          } else if (!existedBefore && deliverableId) {
            // zx_20260907 M2(B1): 版本"起点基线"——write_file 新建 doc 文件(.md/.txt/.py)且此前无任何版本快照时，
            // 落 v1 基线(内容=首次写入)，补"覆盖已有/edit_file 才快照"留下的第0版缺口(维特根斯坦:可判定事实须有可回溯起点)。
            // 仅对本次新建生效(已存 doc 不补录,不擅改历史)；register_deliverable 后续建行也走"去重已存在"故不重复。
            try {
              const cfgV1 = db.prepare("SELECT value FROM wa_settings WHERE key = 'deliverable.first_write_v1'").get() as { value?: string } | undefined;
              if (boolSetting(cfgV1?.value) && (fp.endsWith('.md') || fp.endsWith('.txt') || fp.endsWith('.py'))) {
                const vc = (db.prepare('SELECT COUNT(*) as c FROM wa_deliverable_versions WHERE deliverable_id = ?').get(deliverableId) as { c: number }).c;
                if (vc === 0) {
                  db.prepare('INSERT INTO wa_deliverable_versions (id, deliverable_id, file_path, content_snapshot, size, version, changed_by) VALUES (?, ?, ?, ?, ?, 1, ?)')
                    .run(crypto.randomUUID(), deliverableId, fp, args.content, args.content.length, taskId);
                }
              }
            } catch { /* v1 基线 best-effort */ }
          }
          // zx_20260906_1 3a: 覆盖已有文件即 bump updated_at——"最近变更"如实(不只随状态流转，内容改写也算变更)
          if (existedBefore) {
            db.prepare("UPDATE wa_deliverables SET updated_at = datetime('now') WHERE id = ?").run(deliverableId);
          }
        } catch {}
        // 实时文件变更事件（Phase 1）：新文件→file.created，覆盖→file.updated（带 diff）
        try {
          if (!existedBefore) {
            eventBus.emit('file.created', { taskId, task_id: taskId, projectId, filePath: fp, action: 'created', content: args.content.slice(0, 20_000), size: stat.size, deliverableId: deliverableId || undefined }).catch(() => {});
          } else {
            const diff = computeDiff(prevContent ?? '', args.content);
            eventBus.emit('file.updated', { taskId, task_id: taskId, projectId, filePath: fp, action: 'updated', size: stat.size, hunks: diff.hunks, additions: diff.additions, deletions: diff.deletions, truncated: diff.truncated, deliverableId: deliverableId || undefined }).catch(() => {});
          }
        } catch { /* 事件失败不影响写文件主流程 */ }
        return JSON.stringify({ ok: true, path: fp, size: stat.size, deliverableId: deliverableId || undefined, updated: isUpdate });
      },
    },
    edit_file: {
      description: '精确修改已有文件——只替换old_string指定的部分，不覆盖整个文件。修改已有文件必须用此工具。'
        + EDIT_FILE_READ_FIRST + '。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          filePath: { type: 'string', description: '要修改的文件路径（可相对working_dir或绝对路径）' },
          old_string: { type: 'string', description: '文件中要替换的精确文本（必须在文件中唯一，若匹配多处需扩大上下文）' },
          new_string: { type: 'string', description: '替换后的新文本' },
        },
        required: ['filePath', 'old_string', 'new_string'],
      }),
      execute: async (args: { filePath: string; old_string: string; new_string: string }) => {
        if (args.filePath.includes('..')) return JSON.stringify({ error: '禁止路径遍历(..)' });
        // 沙箱路径围栏：软边界可审批，硬边界拒绝（与 write_file 一致）
        // zx_20260929 M3（J-1）：同 write_file —— import 失败 ⇒ fail-closed 拒写（原为空 `catch {}`）。
        let scope;
        try {
          const { enforcePathScope } = await import('../sandbox.js');
          scope = enforcePathScope(args.filePath, workingDir, 'workspace');
        } catch (e) {
          logger.error({ filePath: args.filePath, err: (e as Error).message }, '沙箱模块加载失败：写路径围栏无法校验，按 fail-closed 拒绝编辑');
          return JSON.stringify({ error: '路径围栏不可用（沙箱模块加载失败），已拒绝编辑' });
        }
        if (!scope.allowed) {
          if (scope.approvable) {
            const ap = await approvePathWrite(scope.resolvedPath);
            if (!ap.allowed) return ap.response ?? JSON.stringify({ error: ap.reason });
          } else {
            return JSON.stringify({ error: scope.reason || '路径被沙箱拦截' });
          }
        }
        const fp = path.isAbsolute(args.filePath) ? args.filePath : path.join(workingDir, args.filePath);
        // zx_20260916_2 M2: 同上——本块零同步 I/O。回话形状逐字保真：`ENOENT` 走旧 `existsSync` 那条回话，
        //   **其余读错误照旧向上抛**（旧实现 `readFileSync` 亦然，不能把权限错说成"文件不存在"）。
        let content: string;
        try {
          content = await fsp.readFile(fp, 'utf-8');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return JSON.stringify({ error: `文件不存在: ${fp}`, hint: '创建新文件请用 write_file' });
          throw e;
        }
        // zx_20261002 M17-①「先读后改」门禁：本任务内**没读过**（也没自己写过）的文件，先 read_file 再回来改。
        //   · 键归一与 `read_file` 侧同尺（双方都 `path.resolve`）。
        //   · **不是硬墙**：这是一次**可恢复**的拒绝——照 `hint` 调一次 read_file 即可继续；
        //     新建文件走不到这里（上面 `ENOENT` 已按旧路回话、指向 write_file），本任务用 write_file
        //     写过的文件已入册（模型自己写的内容本就已知）⇒ 正常 `write→edit` 流程不受阻。
        const fkey = path.resolve(fp);
        if (!deps.readFiles.has(fkey)) {
          return JSON.stringify({ error: EDIT_FILE_READ_FIRST, hint: `请先 read_file("${args.filePath}")，再重试本次 edit_file` });
        }
        const count = content.split(args.old_string).length - 1;
        if (count === 0) return JSON.stringify({ error: 'old_string未在文件中找到', hint: '请用 read_file 确认文件内容后重试' });
        if (count > 1) return JSON.stringify({ error: `old_string匹配了${count}处，不唯一`, hint: '请扩大old_string包含更多上下文使其唯一' });
        const newContent = content.replace(args.old_string, args.new_string);
        // zx_20260917 M4·§6.1-4 写面②（第二只标本 §1.4-Ⅱ 补上的第二个入口）: `edit_file` 此前**不新建登记**——
        //   对**已登记**的文件只做版本快照，对**未登记**的文件什么都不做 ⇒ 活标本 `4870dd0b` 名下
        //   `wa_deliverables` 只有 1 行（`write_file` 产生的探针），而**真交付物 `alert_dashboard.py`
        //   （9 次 edit_file、+233 行）零登记**——判卷因此看不见它。
        //   判据取**来源**（`ARTIFACT_WRITE_TOOLS` 已把 `write_file`/`edit_file` 并列，两者同为"产出性写入"）：
        //   本工具显式改了某文件 ⇒ 与 `write_file` 同尺登记。**不**按文件名长相判（§6.0bis-e）。
        //   ⚠ 位置必须在**下面那段版本快照之前**：登记后"编辑已注册 doc ⇒ 落版本快照"才对**新建行**生效
        //     （与 `write_file` 的 v1 基线同义；否则新建行永远拿不到第 1 版快照）。
        try {
          ensureDocDeliverable(db, { projectId, taskId, absPath: fp, displayPath: args.filePath, via: 'edit_file' });
        } catch { /* 登记失败不影响编辑主流程 */ }
        // 2026-09-07: edit_file 版本快照——与 write_file 对齐：编辑已注册文档类交付物(.md/.txt/.py、<50KB、内容确有变化)时
        // 把修改前全文写入 wa_deliverable_versions(版本号递增)，并 bump updated_at 如实"最近变更"(原两者皆缺→"多次编辑却无版本历史")
        if (content.length < 50_000 && newContent !== content && (fp.endsWith('.md') || fp.endsWith('.txt') || fp.endsWith('.py'))) {
          try {
            const exDeliv = db.prepare('SELECT id FROM wa_deliverables WHERE project_id = ? AND file_path = ? LIMIT 1').get(projectId, fp) as { id: string } | undefined;
            if (exDeliv) {
              const vc = (db.prepare('SELECT COUNT(*) as c FROM wa_deliverable_versions WHERE deliverable_id = ?').get(exDeliv.id) as { c: number }).c;
              db.prepare('INSERT INTO wa_deliverable_versions (id, deliverable_id, file_path, content_snapshot, size, version, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(crypto.randomUUID(), exDeliv.id, fp, content, content.length, vc + 1, taskId);
              db.prepare("UPDATE wa_deliverables SET updated_at = datetime('now') WHERE id = ?").run(exDeliv.id);
            }
          } catch { /* 快照失败不影响编辑主流程 */ }
        }
        await fsp.writeFile(fp, newContent, 'utf-8');
        // 实时文件变更事件（Phase 1）：局部编辑 → file.edited（带 diff）
        try {
          const diff = computeDiff(content, newContent);
          eventBus.emit('file.edited', { taskId, task_id: taskId, projectId, filePath: fp, action: 'edited', size: newContent.length, hunks: diff.hunks, additions: diff.additions, deletions: diff.deletions, truncated: diff.truncated }).catch(() => {});
        } catch { /* 事件失败不影响编辑主流程 */ }
        return JSON.stringify({ ok: true, path: fp, replaced: 1, size: newContent.length });
      },
    },
    update_project_terms: {
      description: '更新项目的"语言游戏"词典——添加或修改项目特定的术语、编码约定。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          terminology: { type: 'string', description: '术语映射JSON，如{"TP":"目标价","DSA":"决策信号分析"}（可选）' },
          conventions: { type: 'string', description: '新增约定，逗号分隔（可选）' },
        },
        required: [],
      }),
      execute: async (args: { terminology?: string; conventions?: string }) => {
        try {
          const proj = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as { context_json: string } | undefined;
          const ctx = JSON.parse(proj?.context_json || '{}');
          const lg = (ctx.language_game as Record<string, unknown>) || {};
          if (args.terminology) {
            const terms = JSON.parse(args.terminology) as Record<string, string>;
            const existing = (lg.terminology as Record<string, string>) || {};
            lg.terminology = { ...existing, ...terms };
          }
          if (args.conventions) {
            const convs = args.conventions.split(/[,，]/).map(s => s.trim()).filter(Boolean);
            const existing = (lg.conventions as string[]) || [];
            lg.conventions = Array.from(new Set([...existing, ...convs]));
          }
          ctx.language_game = lg;
          db.prepare('UPDATE wa_projects SET context_json = ?, updated_at = datetime(\'now\') WHERE id = ?').run(JSON.stringify(ctx), projectId);
          return JSON.stringify({ status: 'updated' });
        } catch (e) { return JSON.stringify({ error: (e as Error).message }); }
      },
    },
    remember_preference: {
      description: '记住用户的个人偏好、习惯、风格或经验。用户明确表达"记住..."时调用。跨项目生效。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          content: { type: 'string', description: '偏好内容，如"用户偏好使用TypeScript+Elysia+Zod做后端开发"' },
          reasoning: { type: 'string', description: '记录原因（可选）' },
        },
        required: ['content'],
      }),
      execute: async (args: { content: string; reasoning?: string }) => {
        const id = crypto.randomUUID();
        const proj = db.prepare('SELECT owner_id FROM wa_projects WHERE id = ?').get(projectId) as { owner_id: string } | undefined;
        // zx_20261012_1 缺陷修: 原为 `proj?.owner_id || ctx.sendImAskUser ? 'default' : ''`——
        //   `||` 与 `?:` 的优先级令其恒取 `'default'`（**从不**是 owner 本身），于是"记住偏好"写在一个
        //   不存在的用户下，同族的 `forget_preference`（读 `proj.owner_id`）永远找不到 ⇒ 记了等于没记。
        //   与 `forget_preference` 对齐（真源即 owner）。
        const uid = proj?.owner_id || '';
        db.prepare("INSERT INTO wa_memories (id, user_id, project_id, task_id, memory_type, content, source, importance, reasoning, valence, updated_at) VALUES (?, ?, NULL, NULL, 'semantic', ?, 'user_instruction', 0.7, ?, 0, datetime('now'))").run(id, uid, args.content, args.reasoning || '');
        return JSON.stringify({ status: 'remembered', id });
      },
    },
    save_memory: {
      description: '保存重要信息到项目记忆（如关键决策、发现、约束等）。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          content: { type: 'string', description: '要保存的记忆内容' },
          type: { type: 'string', description: '记忆类型: episodic/semantic/procedural（可选）' },
          file_path: { type: 'string', description: '证据来源文件路径（可选，提升记忆可信度）' },
          verified: { type: 'boolean', description: '是否已实际验证（可选）' },
          experience: { type: 'string', description: '经验来源: direct(亲历验证)/inferred(推断)（可选，默认自动推导）' },
        },
        required: ['content'],
      }),
      execute: async (args: { content: string; type?: string; file_path?: string; verified?: boolean; experience?: 'direct' | 'inferred' }) => {
        if (!ctx.memory) return JSON.stringify({ error: '记忆管理器不可用' });
        const evidence = args.file_path || args.verified ? { file_path: args.file_path, verified: args.verified } : undefined;
        const memId = ctx.memory.storeText({ project_id: projectId, task_id: taskId, content: args.content, type: args.type as 'episodic' | 'semantic' | 'procedural' | undefined, evidence, experience: args.experience });
        return JSON.stringify({ memoryId: memId, status: 'saved' });
      },
    },
    update_memory: {
      description: '更新已有记忆内容（再巩固），用于修正过时或错误的知识。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          memoryId: { type: 'string', description: '记忆ID' },
          content: { type: 'string', description: '新的记忆内容' },
          reasoning: { type: 'string', description: '更新原因（可选）' },
        },
        required: ['memoryId', 'content'],
      }),
      execute: async (args: { memoryId: string; content: string; reasoning?: string }) => {
        if (!ctx.memory) return JSON.stringify({ error: '记忆管理器不可用' });
        try { ctx.memory.updateMemory(args.memoryId, args.content, args.reasoning); return JSON.stringify({ memoryId: args.memoryId, status: 'updated' }); }
        catch (e) { return JSON.stringify({ error: (e as Error).message }); }
      },
    },
    merge_memories: {
      description: '合并两条相似记忆为一条高质量记忆。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          memoryIdA: { type: 'string', description: '第一条记忆ID' },
          memoryIdB: { type: 'string', description: '第二条记忆ID' },
        },
        required: ['memoryIdA', 'memoryIdB'],
      }),
      execute: async (args: { memoryIdA: string; memoryIdB: string }) => {
        if (!ctx.memory) return JSON.stringify({ error: '记忆管理器不可用' });
        try { const merged = ctx.memory.mergeMemories(args.memoryIdA, args.memoryIdB); return JSON.stringify({ mergedId: merged, status: 'merged' }); }
        catch (e) { return JSON.stringify({ error: (e as Error).message }); }
      },
    },
    forget_preference: {
      description: '删除用户已记住的某条偏好(用户要求"忘记..."时调用)。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: { index: { type: 'number', description: '偏好序号(从list_my_preferences获取)' } },
        required: ['index'],
      }),
      execute: async (args: { index: number }) => {
        if (!ctx.memory) return JSON.stringify({ error: '记忆管理器不可用' });
        const proj = db.prepare('SELECT owner_id FROM wa_projects WHERE id = ?').get(projectId) as { owner_id: string } | undefined;
        const uid = proj?.owner_id || '';
        if (!uid) return JSON.stringify({ error: '未找到用户身份' });
        const prefs = ctx.memory.getUserPreferences(uid, 50);
        if (args.index < 1 || args.index > prefs.length) return JSON.stringify({ error: `序号${args.index}无效，共${prefs.length}条偏好` });
        const deleted = ctx.memory.deleteUserPreference(prefs[args.index - 1]!.id, uid);
        return JSON.stringify({ status: deleted ? 'forgotten' : 'failed', index: args.index });
      },
    },
    mark_exemplar: {
      description: '将记忆标记为成功范例或失败范例（反例），供后续类似任务参考。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          memoryId: { type: 'string', description: '记忆ID' },
          type: { type: 'string', description: 'good=成功范例, bad=失败反例' },
        },
        required: ['memoryId', 'type'],
      }),
      execute: async (args: { memoryId: string; type: string }) => {
        if (!ctx.memory) return JSON.stringify({ error: '记忆管理器不可用' });
        ctx.memory.markExemplar(args.memoryId, args.type === 'bad' ? 'bad' : 'good');
        return JSON.stringify({ memoryId: args.memoryId, status: 'marked' });
      },
    },
    create_deliverable: {
      description: '创建项目产出物记录(MCP/A2A/UI/文档)。先write_file写入文件，再调用此工具关联。.md/.txt必须用type="doc"。mcp/daemon/a2a/ui 仅用于「独立运行的服务入口」(如 xxx_server.py/main.py)；工具模块(如 tools/xxx.py 被已有 server import)不属于服务入口，登记为 type="doc"。注意：type 只是登记口径(是否服务入口)，与内容校验无关——内容充分性门禁按**扩展名**判型：.md/.txt 按文档校验，.py/.ts 等按代码校验。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: '产出物名称' },
          type: { type: 'string', description: '产出物类型: mcp/a2a/ui/doc/daemon' },
          description: { type: 'string', description: '产出物描述' },
          filePath: { type: 'string', description: '已写入文件的相对路径(可选)' },
        },
        required: ['name', 'type', 'description'],
      }),
      execute: async (args: { name: string; type: string; description: string; filePath?: string }) => {
        // zx_20260930 M3-c: 校验 → 去重 → 落库 → 通报四步收敛为 `createDeliverable`（与 GUI 的
        //   `deliverable:create` IPC **同一个函数**）——此前这里的类型校验是本仓的**唯一**一份，
        //   GUI 那条路一条都没有。归一/存在性判断留在**本处**（须 workingDir 与真实 fs，共享函数不碰盘）。
        let fp = '';
        if (args.filePath) {
          fp = path.isAbsolute(args.filePath) ? args.filePath : path.join(workingDir, args.filePath);
          if (!fs.existsSync(fp)) fp = '';
        }
        // `pathLabel` 传**模型给的原串**：报错文案引用它（与归一前的旧文案逐字相同），
        // 且即便文件不存在（`fp` 已归零）也照旧按原串判型——`notes.md` 标 mcp 一律拦下。
        const r = createDeliverable(db, {
          projectId, taskId, name: args.name, type: args.type,
          description: args.description, filePath: fp, pathLabel: args.filePath, via: 'create_deliverable',
        });
        if (!r.ok) return JSON.stringify({ error: r.message });
        if (!r.created) {
          // 查重命中：`type` 由 `createDeliverable` 回**行里真实的值**，不回请求值
          //   （zx_20260928 M4「名者，实之宾也」）。
          return JSON.stringify({ deliverableId: r.id, name: r.name, type: r.type, status: r.status, filePath: r.filePath, fileLinked: !!fp, deduplicated: true });
        }
        return JSON.stringify({ deliverableId: r.id, name: r.name, type: r.type, status: r.status, filePath: r.filePath, fileLinked: !!fp });
      },
    },
    register_deliverable: {
      description: '注册产出物记录。先write_file写入文件，再用此工具注册到系统。.md/.txt必须用type="doc"；mcp/daemon/a2a/ui 仅用于「独立运行的服务入口」(如 xxx_server.py)；工具模块(如 tools/xxx.py 被已有 server import)不属于服务入口，登记为 type="doc"。注意：type 只是登记口径(是否服务入口)，与内容校验无关——内容充分性门禁按**扩展名**判型：.md/.txt 按文档校验，.py/.ts 等按代码校验。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: '产出物名称' },
          type: { type: 'string', description: '类型: mcp/a2a/ui/doc/daemon' },
          filePath: { type: 'string', description: '对应的文件路径' },
          description: { type: 'string', description: '产出物描述（可选）' },
        },
        required: ['name', 'type', 'filePath'],
      }),
      execute: async (args: { name: string; type: string; filePath: string; description?: string }) => {
        // zx_20260930 M3-c: 两条结构校验的判据（`isServiceType`/`isDocPath`/`isModuleFilePath`）
        //   与 `create_deliverable`、`deliverable:create` 三处**同一个真源**（`deliverable-types.ts`）。
        //   此前这里是字面析取手抄的第二份，改一处忘另一处就会让三条路各判各的。
        if (isServiceType(args.type)) {
          if (isDocPath(args.filePath)) {
            return JSON.stringify({ error: `文件"${args.filePath}"是文档类型(.md/.txt)，不能标记为type="${args.type}"。请使用type="doc"。` });
          }
          if (isModuleFilePath(args.filePath)) {
            return JSON.stringify({ error: `文件"${args.filePath}"位于模块目录(tools/modules/lib/plugins)，是工具模块而非独立服务入口，不能标记为type="${args.type}"。服务类型仅用于服务入口(如 xxx_server.py)；工具模块请用type="doc"。` });
          }
        }
        const fp = path.isAbsolute(args.filePath) ? args.filePath : path.join(workingDir, args.filePath);
        // 去重：原为 **task 级**（`WHERE task_id = ? AND file_path = ?`），改为**工程级**共用语句
        //   （zx_20260928 M3）——同一工程下同一 file_path 至多一行产出物。跨任务命中**只返回既有行、
        //   绝不改它的 `task_id`**（不夺归属，承 zx_20260913 M2-2）。
        const existing = findDeliverableByPath(db, { projectId, filePath: fp });
        if (existing) {
          const ex = existing as { id: string; name: string; type: string; status: string };
          // zx_20260928 M4（D5·名实相符）: `type` 回**行里真实的值**（原为 `args.type`——行是 `doc`、
          //   请求是 `daemon` 时会把"另一个值"报成结果；反证标本见 `rr_zx_20260924_1_b9.ts:151` 的夹具形状）。
          return JSON.stringify({ ok: true, id: ex.id, name: ex.name, type: ex.type, filePath: fp, deduplicated: true });
        }
        const id = crypto.randomUUID();
        db.prepare(
          "INSERT INTO wa_deliverables (id, project_id, task_id, type, name, description, file_path, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')"
        ).run(id, projectId, taskId, args.type, args.name, args.description || '', fp);
        // 版本快照
        // zx_20260916_2 M2: 本块零同步 I/O。`stat` 成功即"存在"（与旧 `existsSync` 同尺）。
        // zx_20260928 M4（D3·道德经六十四章「其安易持」——治于未乱）: 本条 INSERT 原**漏了 NOT NULL 列
        //   `file_path`** （`id, deliverable_id, version, content_snapshot, size`）⇒ 每次执行都撞
        //   `NOT NULL constraint failed: wa_deliverable_versions.file_path`，异常被下方**空 `catch {}`** 吞掉，
        //   于是「注册产出物」长期**没有版本基线行**而无人知晓。补齐后列清单与 `write_file` 的 List A 同形：
        //   `(id, deliverable_id, file_path, content_snapshot, size, version, changed_by)`。
        //   `size` 由 `st.size`（**字节**）改 `content.length`（**字符**）——与 `database.ts` 的 schema 注记
        //   「character count, not bytes」及 List A 同尺（存的是**快照本身**的长度）。`st` 查询保留（它判「文件在不在」）。
        try {
          const st = await fsp.stat(fp).catch(() => null);
          if (st) {
            const content = (await fsp.readFile(fp, 'utf-8')).slice(0, 50_000);
            db.prepare(
              'INSERT INTO wa_deliverable_versions (id, deliverable_id, file_path, content_snapshot, size, version, changed_by) VALUES (?, ?, ?, ?, ?, 1, ?)'
            ).run(crypto.randomUUID(), id, fp, content, content.length, taskId);
          }
        } catch (err) {
          // zx_20260928 M4: 原为空 `catch {}`——正是 D3 长期**隐身**的原因（约束失败无声无息、注册照旧"成功"）。
          //   收窄为**如实记录**：仍是 best-effort（不阻断注册），但"版本行没写成"从此有痕。
          logger.warn({ deliverableId: id, filePath: fp, err: (err as Error).message }, '产出物 v1 版本行写入失败（产出物本身已登记，但无版本基线）');
        }
        setDeliverableStatus(db, id, 'draft', 'register_deliverable', { forceEmit: true });
        // 注：ANS 注册交由 deliverable:start/register 的 registerToAns 处理（真实端点+HMAC），
        // 此处不再内联"硬编码假端点 + 无HMAC"的坏注册。
        return JSON.stringify({ ok: true, id, name: args.name, type: args.type, filePath: fp });
      },
    },
  };
}
