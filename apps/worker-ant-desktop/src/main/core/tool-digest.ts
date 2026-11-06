/**
 * `[工具调用] …` 标记行的解析与摘要（zx_20261030_2 M6）。
 *
 * 这类行由 `core/exec-step.ts` 以 `role='system'` 写入；`role='tool'` 行是 `[toolName] 结果`，
 * 两者不相交。简报、恢复摘要、已读清单一律从这里取「做了什么」，不再各写一份正则。
 * 纯字符串处理，不依赖 db，也不引入循环依赖。
 */

export interface ToolMarker {
  tool: string;
  args: string;
}

export interface ToolDigest {
  filesRead: string[];
  filesWritten: string[];
  commands: string[];
  searches: string[];
  children: string[];
  /** 真实调用数（清单有界，计数不截断——「读 5 文件」不能冒充「读了 20 个」）。 */
  counts: { filesRead: number; filesWritten: number; commands: number; searches: number; children: number };
}

const MARKER = '[工具调用] ';
const FILE_LIMIT = 5;
const COMMAND_LIMIT = 3;
const SEARCH_LIMIT = 5;
const CHILD_LIMIT = 5;

const READ_TOOLS = new Set(['read_file']);
const WRITE_TOOLS = new Set(['write_file', 'edit_file']);
const SHELL_TOOLS = new Set(['execute_command', 'bash']);
const SEARCH_TOOLS = new Set(['search_content']);
const CHILD_TOOLS = new Set(['spawn_subagent', 'create_task']);

function baseName(p: string): string {
  const s = p.trim();
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return cut >= 0 ? s.slice(cut + 1) : s;
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function pushUnique(list: string[], value: string, limit: number): void {
  if (!value || list.length >= limit || list.includes(value)) return;
  list.push(value);
}

/**
 * 解析形如 `read_file({"filePath":"a.ts"}); bash({"command":"ls"})` 的标记行。
 *
 * 按括号配对扫描而非按 `; ` 切分——参数内部本身可能出现 `; `（如 shell 命令）。
 * 截断/非法参数照样产出条目，由 `digestToolTurns` 在 JSON.parse 失败时跳过。
 */
export function parseToolMarkers(rows: Array<{ content: string }>): ToolMarker[] {
  const out: ToolMarker[] = [];
  const open = /([A-Za-z_][A-Za-z0-9_]*)\(/g;
  for (const row of rows) {
    const text = String(row?.content ?? '');
    const at = text.indexOf(MARKER);
    if (at < 0) continue;
    let i = at + MARKER.length;
    while (i < text.length) {
      open.lastIndex = i;
      const hit = open.exec(text);
      if (!hit) break;
      const start = hit.index + hit[0].length;
      let depth = 1;
      let j = start;
      let inString = false;
      let escaped = false;
      for (; j < text.length; j++) {
        const ch = text[j]!;
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
        } else if (ch === '"') {
          inString = true;
        } else if (ch === '(') {
          depth++;
        } else if (ch === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      out.push({ tool: hit[1]!, args: text.slice(start, j) });
      if (j >= text.length) break; // 截断在参数中间，本条留给 digest 跳过
      i = j + 1;
    }
  }
  return out;
}

/** 从已解析的调用条目归纳「读了/写了/跑了/搜了/派了」——去重、按出现序、各列表有界。 */
export function digestToolTurns(entries: Array<{ tool: string; args: string }>): ToolDigest {
  const digest: ToolDigest = {
    filesRead: [], filesWritten: [], commands: [], searches: [], children: [],
    counts: { filesRead: 0, filesWritten: 0, commands: 0, searches: 0, children: 0 },
  };
  for (const entry of entries) {
    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(entry.args || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      args = parsed as Record<string, unknown>;
    } catch {
      continue; // JSON 截断/非法：跳过该条，不抛
    }
    if (READ_TOOLS.has(entry.tool)) {
      digest.counts.filesRead++;
      pushUnique(digest.filesRead, baseName(pickString(args, ['filePath', 'path', 'file'])), FILE_LIMIT);
    } else if (WRITE_TOOLS.has(entry.tool)) {
      digest.counts.filesWritten++;
      pushUnique(digest.filesWritten, baseName(pickString(args, ['filePath', 'path', 'file'])), FILE_LIMIT);
    } else if (SHELL_TOOLS.has(entry.tool)) {
      digest.counts.commands++;
      pushUnique(digest.commands, pickString(args, ['command']), COMMAND_LIMIT);
    } else if (SEARCH_TOOLS.has(entry.tool)) {
      digest.counts.searches++;
      pushUnique(digest.searches, pickString(args, ['query', 'pattern', 'keyword', 'q']), SEARCH_LIMIT);
    } else if (CHILD_TOOLS.has(entry.tool)) {
      digest.counts.children++;
      pushUnique(digest.children, pickString(args, ['taskTitle', 'title']), CHILD_LIMIT);
    }
  }
  return digest;
}

/** 一句话摘要；无任何工具痕迹返回空串（调用方据此继续走下一优先级）。 */
export function formatDigest(d: ToolDigest): string {
  const parts: string[] = [];
  if (d.counts.filesRead > 0) parts.push(`读 ${d.counts.filesRead} 文件`);
  if (d.counts.filesWritten > 0) parts.push(`写 ${d.counts.filesWritten} 文件`);
  if (d.counts.commands > 0) parts.push(`跑 ${d.counts.commands} 命令`);
  if (d.counts.searches > 0) parts.push(`搜 ${d.counts.searches} 次`);
  if (d.counts.children > 0) parts.push(`派 ${d.counts.children} 个子任务`);
  return parts.join('、');
}
