/**
 * zx_20260920_1 M1（庄子·无用之用 / 金刚经·不住相）: 由 `agent-executor.ts` 的 `buildTools()`
 * **机械搬迁**而来——工具体**逐字节未改**，只把原来靠外层闭包取到的名字，改为从 `deps` 解构。
 * 搬迁纪律：**工具名 / 参数 schema / execute 行为 / 返回形状一律不动**；此处不新增、不删除任何工具。
 * 依赖面（5 项）由 `ToolDeps` 声明式给出，不再依赖隐式闭包。
 */
import type { ToolDeps } from './deps.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { jsonSchema } from 'ai';
import { validateReadonlyBashCommand, sanitizeLoneSurrogates, searchPathForPattern, paginateReadFile, shellRejectPayload, shellRejectPayloadForChar, buildToolConstraintBrief, CONTENT_SEARCH_MAX_FILE_BYTES, CONTENT_SEARCH_MAX_FILE_LABEL } from '../tool-guards.js';
// 只读围栏：与 `tools/write.ts` 的两条硬红线同尺（`..` / 敏感路径），但**不带**软边界与审批流。
import { readPathGuard } from '../path-fence.js';
// zx_20260930 M12: 整读字节上限（`readCapBytes`）与解码闸（`decodePlainText`）各**只有一份实现**，
//   `read_file` 与 `view_image`/`read_document`/附件装配层读同一张表、同一个函数。
import { readCapBytes } from '../attachment-kinds.js';
import { decodePlainText } from '../doc-text.js';

export function readonlyTools(deps: ToolDeps) {
  const { ctx, db, taskId, projectId, workingDir } = deps;
  return {
    read_file: {
      description: '读取**文本**文件内容（单次回传上限 50000 字符；超限会如实告知并给出续读 offset）。'
        + '可用 offset(0-based 起始行)/limit(行数) 分页。'
        + '⚠ 有**整读字节上限**（按扩展名判族，认不出的 20MB）：超限会如实拒并给出取片段的可行路径；'
        + '按 BOM 解码，判为二进制或非 UTF-8（如 GBK）时**如实告知**而不返回 U+FFFD 乱码。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          filePath: { type: 'string', description: '文件路径' },
          offset: { type: 'number', description: '起始行号（0-based）' },
          limit: { type: 'number', description: '读取行数' },
        },
        required: ['filePath'],
      }),
      execute: async (args: { filePath: string; offset?: number; limit?: number }) => {
        // zx_20260929 M3（J-1）：只读侧补上写侧既有的两条硬红线（`..` 遍历 / 敏感路径），
        //   同一把尺 = `path-fence.readPathGuard`（**不是** `enforcePathScope`：那会把工作目录外的
        //   普通路径变成待审批，而只读侧的裁定是"普通工作目录外绝对路径仍可读"）。
        // ⚠ 本块不得出现同步 I/O（`rr_zx_20260916_2` 的 BLOCKING_SYNC 按工具体逐块扫）：守则是纯路径运算。
        const g = readPathGuard(args.filePath, workingDir);
        if (!g.ok) return JSON.stringify({ error: g.error });
        const fp = g.resolved;
        // zx_20260930 M12（文件读的闸·其一）：**先 `stat` 判限、再整读**。
        //   旧实现是一次 `readFile(…, 'utf-8')`：无参读一个 2GB 的日志会先把整件吃进主进程内存
        //   （引擎就跑在 Electron 主进程里），而且**读不完也不说**。上限口径**取自那一张表**
        //   （`attachment-kinds.readCapBytes`），与 `view_image`/`read_document` 同一把尺——
        //   差别只在"族上限为 0"怎么读：那边 0 是"此路不通，如实拒绝"，这里 0 是"补兜底再读"
        //   （`read_file` 是**点名要读这一件**，不是"要不要内联"那个判决）。
        //   `stat` 失败与旧 `existsSync` 失败**同一句回话**（判据 C-* 钉的是这类串）。
        let st: Awaited<ReturnType<typeof fsp.stat>>;
        try {
          st = await fsp.stat(fp);
        } catch (e) {
          return JSON.stringify({ error: `文件不存在或不可读: ${fp}（${e instanceof Error ? e.message : String(e)}）` });
        }
        const ext = path.extname(fp).toLowerCase();
        const cap = readCapBytes(ext);
        if (st.size > cap) {
          // 拒绝**必须给出可行动的下一步**（只说"太大了"等于把活儿退回去）：三条路都在本工具集里真成立
          //   ——`search_content` 是只读工具、`bash` 的白名单含 `sed`/`head`/`tail` 且支持管道。
          return JSON.stringify({
            path: fp, bytes: st.size, limit: cap,
            error: `文件 ${st.size} 字节超过 ${cap} 字节的整读上限（${ext || '无扩展名'}）。`
              + '可行路径：① 用 search_content 直接定位要看的片段；'
              + `② 用 bash 取区段，例如 sed -n '1,200p' "${fp}" 或 head -n 200 / tail -n 200；`
              + `③ 先把它截取到 ${cap} 字节以内，再对截取件调 read_file。`,
          });
        }
        // zx_20260913 M4-5(名实相符 / 管子·度量衡): 旧实现先 `slice(0, 50_000)` **再**按行分页 ⇒
        // ① 「行」与「字符」两把尺错位：超 5 万字符的文件，其边界之后的行按 offset 永远取不到；
        // ② 无参读取超限时**静默截尾**，调用方无从得知文件被截（读到半截还以为是全文）。
        // 现先整读全文，分页在**全文**上进行；判据外置为纯函数（tool-guards.ts）以便回归跑真实现。
        // zx_20260916_2 M2: 整读改异步——大文件整读本是本工具最重的一跳（全库 2615 步），
        //   同步读等于让界面陪着等。分页判据（`paginateReadFile`）是纯函数，一字未动。
        let buf: Buffer;
        try {
          buf = await fsp.readFile(fp);
        } catch (e) {
          return JSON.stringify({ error: `文件不存在或不可读: ${fp}（${e instanceof Error ? e.message : String(e)}）` });
        }
        // zx_20260930 M12（文件读的闸·其二）：**编码闸**。旧实现按 `'utf-8'` 硬解——一份 GBK 文件
        //   会**静默**变成一坨 U+FFFD 交给模型（模型对乱码的反应是**编**）。这里调的是
        //   `doc-text.decodePlainText`，与附件那条路**同一个函数**：判不了就如实说，并把盘上路径带上
        //   （"读不了"与"读到了但内容是 X"不是一回事）。
        const d = decodePlainText(buf);
        if (!d.ok) {
          return JSON.stringify({
            path: fp, bytes: buf.length, ok: false, reason: d.reason, detail: d.detail,
            note: `原件在 ${fp}。这不是一份可按 UTF-8/BOM 解出的纯文本：`
              + '图片用 view_image、PDF/Word 用 read_document；'
              + '音频/视频请在任务开局作为附件发进来（走进站内联转写），本工具只读文本。',
          });
        }
        const full = d.text;
        // zx_20261002 M17-①「先读后改」：读成功即入册（`edit_file` 据同一份 Set 设门禁）。
        //   键归一 `path.resolve`——与 `edit_file` 侧同一把尺（否则同一文件两种写法被当两件）。
        deps.readFiles.add(path.resolve(fp));
        return paginateReadFile(full, { offset: args.offset, limit: args.limit }).text;
      },
    },
    get_current_time: {
      description: '获取当前日期和时间。',
      parameters: jsonSchema({ type: 'object' as const, properties: {}, required: [] }),
      execute: async () => new Date().toISOString(),
    },
    list_project_tasks: {
      description: '列出当前项目的所有任务。',
      parameters: jsonSchema({ type: 'object' as const, properties: {}, required: [] }),
      execute: async () => {
        const ts = db.prepare('SELECT id, title, status, priority FROM wa_tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT 20').all(projectId);
        return JSON.stringify(ts);
      },
    },
    get_project_info: {
      description: '获取当前项目详情。',
      parameters: jsonSchema({ type: 'object' as const, properties: {}, required: [] }),
      execute: async () => {
        const p = db.prepare('SELECT * FROM wa_projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined;
        return JSON.stringify(p ?? {});
      },
    },
    task_get: {
      description: '获取指定任务详情。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: { targetTaskId: { type: 'string', description: '目标任务ID' } },
        required: ['targetTaskId'],
      }),
      execute: async (args: { targetTaskId: string }) => {
        const t = db.prepare('SELECT * FROM wa_tasks WHERE id = ?').get(args.targetTaskId) as Record<string, unknown> | undefined;
        if (!t) return JSON.stringify({ error: '任务不存在' });
        const convCount = (db.prepare('SELECT COUNT(*) as count FROM wa_task_conversations WHERE task_id = ?').get(args.targetTaskId) as { count: number }).count;
        return JSON.stringify({ ...t, conversationCount: convCount });
      },
    },
    list_agents: {
      description: '列出指定任务的直接子Agent（spawn_subagent/spawn_debate/recruit_swarm 创建的子任务）。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: { parentTaskId: { type: 'string', description: '父任务ID（默认当前任务）' } },
        required: [],
      }),
      execute: async (args: { parentTaskId?: string }) => {
        const pid = args.parentTaskId || taskId;
        const children = db.prepare('SELECT id, title, status FROM wa_tasks WHERE parent_task_id = ? ORDER BY created_at ASC').all(pid) as Array<{ id: string; title: string; status: string }>;
        return JSON.stringify({ parentTaskId: pid, count: children.length, agents: children.map(c => ({ id: c.id, title: c.title, status: c.status })) });
      },
    },
    file_retrieval: {
      description: '递归搜索文件或列出目录结构。通过关键词搜索文件名或递归列出目录。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: '文件名搜索关键词（可选）' },
          dirPath: { type: 'string', description: '要搜索/列出的目录（相对working_dir，默认根目录）' },
        },
        required: [],
      }),
      execute: async (args: { query?: string; dirPath?: string }) => {
        try {
          const baseDir = args.dirPath ? path.resolve(workingDir, args.dirPath) : workingDir;
          if (!baseDir.startsWith(path.resolve(workingDir))) return JSON.stringify({ error: '路径遍历被拒绝' });
          if (!fs.existsSync(baseDir)) return JSON.stringify({ error: `目录不存在: ${args.dirPath || '/'}` });
          const results: string[] = [];
          // zx_20260916_2 M2: 递归目录列举改异步（全库 169 步）——本工具的递归 `readdirSync` 与
          //   `search_content` 同病根。判据（深度 ≤4、条数 ≤100、跳过隐藏项与 node_modules、相对路径口径）
          //   **一字未动**；`withFileTypes` 也照旧（不需要逐条 stat，Dirent 已带类型）。
          //   与旧实现一处**有意收紧**：旧 `try/catch` 包着整个循环 ⇒ 中途任一条目出错会**丢掉整次列举**；
          //   现改为"某个目录不可读就跳过该目录"，与 `searchPathForPattern` 同款取舍。
          const walk = async (dir: string, depth: number): Promise<void> => {
            if (depth > 4 || results.length >= 100) return;
            let entries;
            try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; /* 目录不可读：跳过 */ }
            for (const entry of entries) {
              if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
              const full = path.join(dir, entry.name);
              const rel = path.relative(workingDir, full);
              if (entry.isDirectory()) {
                results.push(`${rel}/`);
                await walk(full, depth + 1);
              } else {
                if (args.query && !entry.name.toLowerCase().includes(args.query.toLowerCase())) continue;
                results.push(rel);
              }
            }
          };
          await walk(baseDir, 0);
          return JSON.stringify({ path: args.dirPath || '/', count: results.length, files: results.slice(0, 100) });
        } catch (e) { return JSON.stringify({ error: (e as Error).message }); }
      },
    },
    list_my_preferences: {
      description: '列出当前用户已记住的所有偏好/习惯。',
      parameters: jsonSchema({ type: 'object' as const, properties: {}, required: [] }),
      execute: async () => {
        if (!ctx.memory) return JSON.stringify({ error: '记忆管理器不可用' });
        const proj = db.prepare('SELECT owner_id FROM wa_projects WHERE id = ?').get(projectId) as { owner_id: string } | undefined;
        const uid = proj?.owner_id || '';
        if (!uid) return '未找到用户身份';
        const prefs = ctx.memory.getUserPreferences(uid, 20);
        if (prefs.length === 0) return '暂无用户偏好记录';
        return prefs.map((p, i) => `${i + 1}. [${p.source}] ${p.content}${p.reasoning ? ' (原因: ' + p.reasoning + ')' : ''}`).join('\n');
      },
    },
    search_content: {
      // zx_20260924_1 M10：体积上限写进**工具说明**——此前它只存在于判据代码里，模型无从知道
      //   「某个大文件根本没被搜过」，只能靠"搜不到"自行推断（真库那只 659KB openapi.yaml 就是这么被误判的）。
      //   门槛值**派生**自 `CONTENT_SEARCH_MAX_FILE_BYTES`，不手抄第二份。
      description: `搜索文件内容（类似grep）。返回匹配行和文件名。`
        + `⚠ 单个文件 ≥ ${CONTENT_SEARCH_MAX_FILE_BYTES} 字节（${CONTENT_SEARCH_MAX_FILE_LABEL}）会被**跳过**（不读其正文），`
        + `被跳过的文件在返回的 \`skipped\` 字段里如实列出——**若 skipped.count > 0，本次结果不含这些文件**，`
        + `不得据此断定"里面没有"；需要它们的内容请改用 \`read_file\`（支持 offset/limit 分页逐段读）。`,
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          pattern: { type: 'string', description: '搜索的正则表达式' },
          dirPath: { type: 'string', description: '搜索目录（默认working_dir）' },
          fileTypes: { type: 'string', description: '文件扩展名过滤（如 .ts,.js）' },
        },
        required: ['pattern'],
      }),
      execute: async (args: { pattern: string; dirPath?: string; fileTypes?: string }) => {
        // zx_20260911_3 M3-3: 判据本体抽到 tool-guards.searchPathForPattern（受控回归跑真实现）。
        // 分场：dirPath 指文件→扫该文件；指目录→递归；不存在→明确报错（不再与"无匹配"共用一个 0）。
        const r = await searchPathForPattern({ pattern: args.pattern, workingDir, dirPath: args.dirPath, fileTypes: args.fileTypes });
        // zx_20260924_1 M10：`skipped` 一并带出（含零命中时）——"查了没有"与"没查"在**返回值上**必须分得开。
        return JSON.stringify(r.ok
          ? { path: r.path, scope: r.scope, matches: r.matches, results: r.results, skipped: r.skipped }
          : { error: r.error });
      },
    },
    list_files: {
      description: '列出目录中的文件',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          dirPath: { type: 'string', description: '目录路径（相对working_dir或绝对）' },
          pattern: { type: 'string', description: '文件名过滤（可选，如 *.ts）' },
        },
        required: ['dirPath'],
      }),
      execute: async (args: { dirPath: string; pattern?: string }) => {
        const dp = path.isAbsolute(args.dirPath) ? args.dirPath : path.join(workingDir, args.dirPath);
        if (!fs.existsSync(dp)) return JSON.stringify({ error: `目录不存在: ${dp}` });
        try {
          // zx_20260916_2 M2: 目录列举 + 逐条 stat 改异步（全库 446 步）。返回结构字段一字未动。
          const dirents = await fsp.readdir(dp, { withFileTypes: true });
          let files = await Promise.all(dirents.map(async (f) => ({
            name: f.name, isDir: f.isDirectory(),
            size: f.isFile() ? await fsp.stat(path.join(dp, f.name)).then(s => s.size) : 0,
          })));
          if (args.pattern) {
            const regex = new RegExp('^' + args.pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
            files = files.filter(f => regex.test(f.name));
          }
          return JSON.stringify({ path: dp, count: files.length, files: files.slice(0, 50) });
        } catch (e) { return JSON.stringify({ error: (e as Error).message }); }
      },
    },
  };
}
