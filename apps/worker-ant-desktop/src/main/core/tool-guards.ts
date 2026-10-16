/**
 * zx_20260911_3 B 线：工具层「沉默错误」的三处判据收敛。
 *
 * 抽为不依赖 electron 的模块，使受控回归能**直接跑真实现**而非复刻判据
 * （承 task-accounting.ts 的同一约定：复刻的断言只是自我印证）。
 *
 * E11 `matches:0` 把「路径不对」与「确实没有」合成同一个符号（维特根斯坦·私人语言批判）；
 * E12 `command.split('|')` 把 shell 的管道与 regex 的交替混为一个符号（语言游戏）；
 * E13 落单 UTF-16 半代理让 JSON.stringify 产出非法转义、压缩请求 400。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';

/**
 * E12 引号感知的管道切分：shell 里**只有引号外的裸 `|` 才是管道**。
 *
 * 此前 `command.split('|')` 把 `grep -n "a\|b" file` 切成两段，段首 token 成了 `"a\|b"`
 * 这类碎片 → 查 SAFE 白名单必不在 → 用户收到「不在只读白名单」而命令其实完全只读。
 * 规则：单/双引号内的 `|` 与转义 `\|` 均不切分；引号状态与反斜杠转义按 shell 通行语义跟踪。
 * **切分方式**改变，`SAFE` 命令集与其余拦截规则**一字不动**（方案 §六 红线）。
 */
export function splitShellPipes(command: string): string[] {
  const segs: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"') {
        if (i + 1 < command.length) { cur += command[i + 1]!; i++; }
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '\\') { cur += ch; if (i + 1 < command.length) { cur += command[i + 1]!; i++; } continue; }
    if (ch === '|') { segs.push(cur); cur = ''; continue; }
    cur += ch;
  }
  segs.push(cur);
  return segs;
}

/** 只读 shell 命令白名单（单一真源；改此集合即改行为，须有方案依据） */
export const SAFE_READONLY_COMMANDS = new Set([
  'cat', 'head', 'tail', 'wc', 'ls', 'find', 'tree', 'pwd', 'grep', 'awk', 'sed', 'echo', 'sort', 'uniq',
  'file', 'du', 'df', 'diff', 'which', 'whoami', 'date', 'env', 'uname', 'git', 'python3', 'node',
]);

const DESTROY_PATTERNS = ['rm -rf', 'mkfs', 'dd if=', 'chmod 777'];

/** 两把 shell 工具的判别式（字符表按它索引）。 */
export type ShellTool = 'execute_command' | 'bash';

/**
 * zx_20260915 M5/P0-7：**被拒字符**的单一真源——判定与「工具能力简报」都读它，不各写一份。
 *
 * ⚠ 刻意是**两张表**而非「一份 BASE + 两次增减」：两把工具的按字符拒绝集**本就不同**——
 * `execute_command` 拒 `$`，而 `bash` 的 `$` 由**另一条**判据（`$(`/`${}`，见 `validateReadonlyBashCommand`）
 * 单独拦、单独的 `$` 是放行的。若强行并成一份含 `$` 的集合，`bash` 下 `echo $HOME` 会从**放行**变**拒绝**，
 * 那是实打实的行为变更（越本节 §7.3 红线），且与既有断言「白名单命令照常放行」相抵。
 * 「一处真源」在这里的正确形态是**两张表同处一文件、由同一条判定读取**，而不是把两把工具并成一把。
 */
export const SHELL_REJECT_CHARS: Record<ShellTool, readonly string[]> = {
  execute_command: [';', '&', '|', '`', '$', '\n'],
  bash: ['\n', ';', '&', '`'],
};

/** 该工具**按字符**拒绝的第一个字符（按命令中的出现顺序）；无则 `null`。 */
export function firstRejectedShellChar(command: string, tool: ShellTool): string | null {
  const set = new Set(SHELL_REJECT_CHARS[tool]);
  for (const ch of command) if (set.has(ch)) return ch;
  return null;
}

/**
 * 字符的**可见写法**（控制符转可读形式）。只用于**句子内部**——`char` 字段一律存原字符，
 * 否则同一概念又分成"存的是哪一个"两套说法。
 *
 * 反引号与 `\n` 各自刻意用文字/转义写法：它们若原样嵌进「…」或 markdown 代码span，
 * 会把句子/span 提前截断（本轮方案文件里正踩过一次）。
 */
function displayChar(ch: string): string {
  if (ch === '\n') return '\\n';
  if (ch === '`') return '反引号(`)';
  return ch;
}

/**
 * zx_20260915 M5/P0-7：被拒字符的**话术**（指名 + 给正解 + 撤掉误导）。
 *
 * 旧文案「请拆分命令或使用 run_privileged 执行特权命令」把**字符级**的语法问题说成**权限**问题——
 * 用户/模型据此去走审批通道，而命令根本不需要特权，只是用错了分隔符（本节病根：系统让模型猜规矩）。
 * 新文案**不再出现 `run_privileged`**：字符级拒绝与特权无关，特权指引留在它该在的地方
 * （`bash` 白名单拒绝那条、`run_privileged` 工具自身）。
 */
export function shellRejectAdvice(char: string, tool: ShellTool, cwd: string): string {
  const d = displayChar(char);
  const how = tool === 'execute_command' && char === '|'
    ? '本工具不支持管道，需要管道请改用 `bash` 工具（它支持 `|`）。'
    : char === '|'
      ? '不支持管道。'
      : char === '`' || char === '$'
        ? '不支持命令替换，请直接写命令、不要用替换结果。'
        : '请拆成多次单独调用（一次一条命令）。';
  return `命令含${tool === 'execute_command' ? '分隔符/替换符' : '换行或分隔符'}「${d}」。${how}`
    + `当前工作目录**已是项目目录** \`${cwd}\`，一般**无需 \`cd\`**；写文件请用 \`write_file\`/\`edit_file\`。`;
}

/**
 * 判定一次 shell 命令是否**按字符**被拒。注意：本函数**不决定"允不允许"**——
 * 允许集仍归各工具（`bash` 额外放行 `|`、`execute_command` 额外放行 `cd`）；
 * 它只决定「拒了哪个字符、该说什么」。**勿把它当作合并两把工具的依据**。
 */
export function classifyShellReject(
  command: string, tool: ShellTool, cwd: string,
): { ok: true } | { ok: false; char: string; advice: string } {
  const char = firstRejectedShellChar(command, tool);
  if (!char) return { ok: true };
  return { ok: false, char, advice: shellRejectAdvice(char, tool, cwd) };
}

/** 由**已知**被拒字符产出如实 payload（`bash` 支路入口：字符判定已在 `validateReadonlyBashCommand` 内完成）。 */
export function shellRejectPayloadForChar(char: string, tool: ShellTool, cwd: string): Record<string, unknown> {
  const advice = shellRejectAdvice(char, tool, cwd);
  return { error: `命令包含非法字符「${displayChar(char)}」。${advice}`, char, advice };
}

/**
 * 两处调用点共用的拒绝 payload。**未命中字符拒绝时返回 `null`**（调用方据此让其它判据接管）。
 *
 * `honest=false` ⇒ 回到**改动前**的两句原文（回退开关 `engine.shell_advice_honest`）。
 * 旧文案刻意与判据**同处一文件同处一函数**：否则"一键回退"会退化成"两个调用点各手改一次"。
 */
export function shellRejectPayload(
  command: string, tool: ShellTool, cwd: string, honest: boolean,
): Record<string, unknown> | null {
  const v = classifyShellReject(command, tool, cwd);
  if (v.ok) return null;
  if (!honest) {
    return {
      error: tool === 'execute_command'
        ? '命令包含非法字符。请拆分命令或使用 run_privileged 执行特权命令。'
        : '命令包含换行/分隔符/命令替换，禁止执行。',
    };
  }
  return shellRejectPayloadForChar(v.char, tool, cwd);
}

/**
 * zx_20260915 M5/P0-7：**工具能力与限制简报**——规矩**告诉**模型，别让模型去猜（本条是根治）。
 *
 * 内容**全部派生**：白名单条数取自 `SAFE_READONLY_COMMANDS.size`、被拒字符取自 `SHELL_REJECT_CHARS`，
 * **不手抄**（写死条数＝下一轮必假且换语法外壳即可躲过检查的哑雷）。
 * 注入方式为**独立一条 system 消息**（见 `agent-executor.ts` 内 `SYSTEM_PROMPT_BASE` 之后），
 * 而非写进模板常量——写进常量就得把条数落成字面量，恰与本函数的存在理由相抵。
 */
export function buildToolConstraintBrief(): string {
  const wl = [...SAFE_READONLY_COMMANDS].join('/');
  // 字符列不开 markdown 代码span：反引号自身若被 span 包住会把 span 截断（本仓踩过一次），
  // 故用「」+ 文字写法，模型读起来反而更无歧义。
  const fmt = (t: ShellTool) => SHELL_REJECT_CHARS[t].map((c) => `「${displayChar(c)}」`).join('、');
  return [
    '## 工具能力与限制（依工具而定，勿混用）',
    `- \`bash\` = **只读**白名单命令（共 ${SAFE_READONLY_COMMANDS.size} 条：${wl}）；**支持 \`|\` 管道**；`
      + `按字符不支持 ${fmt('bash')}；另有命令替换 \`$()\` 与重定向亦不支持。`,
    `- \`execute_command\` = 通用命令（**可 \`cd\`、可写操作**）；**不支持 \`|\` 管道**；`
      + `按字符不支持 ${fmt('execute_command')}。`,
    '- 两者的工作目录**都已是本任务的项目目录**，一般**无需 `cd`**；写文件一律用 `write_file`/`edit_file`。',
  ].join('\n');
}

export type BashVerdict =
  | { ok: true }
  | { ok: false; payload: Record<string, unknown> };

/**
 * `bash` 工具的**校验**部分（与执行分离，使判据可被受控回归直接验证）。
 *
 * 校验顺序与原实现逐条一致：破坏性 → 换行/分隔符/命令替换 → `$()`/`${}` → 逐段
 * （解释器 → `sed -i` → `find -exec/-delete` → 重定向 → 白名单）。切分改用 `splitShellPipes`。
 */
export function validateReadonlyBashCommand(command: string): BashVerdict {
  if (DESTROY_PATTERNS.some((p) => command.includes(p))) return { ok: false, payload: { error: '破坏性命令被拦截' } };
  // zx_20260915 M5/P0-7：字符判定改用真源 `firstRejectedShellChar`（裸正则删除，判据代码只剩一处）。
  // payload 带 `char` 作**界桩**：调用方据此判断"这次拒绝是不是字符级的"，从而决定换不换文案——
  // 本函数其余七支（破坏性/解释器/$()/sed -i/find -exec/重定向/白名单）的文案一字不动（§7.3 红线）。
  const rejCh = firstRejectedShellChar(command, 'bash');
  if (rejCh) return { ok: false, payload: { error: '命令包含换行/分隔符/命令替换，禁止执行。', char: displayChar(rejCh) } };
  if (/\$\s*\(/.test(command) || /\$\{/.test(command)) return { ok: false, payload: { error: '命令替换 $()/${} 禁止执行。' } };
  for (const segment of splitShellPipes(command)) {
    const s = segment.trim();
    if (!s) return { ok: false, payload: { error: '管道存在空段，命令非法。' } };
    const name = s.split(/\s+/)[0]?.split('/').pop() || '';
    if (['sh', 'bash', 'zsh'].includes(name)) {
      return { ok: false, payload: { requires_privilege: true, command, message: '禁止直接执行shell解释器。请使用 ask_user 请求批准，用户批准后 run_privileged 执行。' } };
    }
    if (name === 'sed' && s.includes(' -i')) return { ok: false, payload: { error: 'sed -i 禁止，用 write_file 修改文件' } };
    if (name === 'find' && /-exec|-delete/.test(s)) return { ok: false, payload: { error: 'find -exec/-delete 禁止' } };
    if (/>|>>/.test(s)) return { ok: false, payload: { error: '重定向被禁止，写文件请用 write_file' } };
    if (!SAFE_READONLY_COMMANDS.has(name)) {
      return { ok: false, payload: { error: `${name} 不在只读白名单。特权命令(安装依赖/启动服务)请用 ask_user→run_privileged。` } };
    }
  }
  return { ok: true };
}

/**
 * E13 落单 UTF-16 半代理净化：落单的高/低代理 → U+FFFD。
 *
 * 压缩输入来自对话正文，可能含被截断的字面转义（如 `\ud83d` 单独出现）。
 * `JSON.stringify` 会把它**原样**写成非法转义，请求体被服务端拒为 400
 * （"unexpected end of hex escape"）⇒ 压缩失败回退、上下文不收敛。
 * 只在**发送前**净化，落库文本不动（如实保留用户/模型原话）。
 */
export function sanitizeLoneSurrogates(s: string): string {
  return String(s ?? '').replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '�',
  );
}

/**
 * zx_20260924_1 M10：`search_content` 的**体积闸**（单一真源）。
 *
 * 500,000 字节是**有意为之的性能闸**（不读超大文件的正文），本轮**阈值一字不动**；
 * 它此前只是 `scanFile` 与 `walkDir` 里两处**裸字面量**，被它挡下的文件**一声不吭**——
 * 于是命中 0 时，「查了但没有」与「根本没查」返回同一个符号（同一句 `matches:0`），
 * 模型据此把"大文件里没有 X"当成结论（真库标本：`mini-mp/openapi.yaml` 659,754 字节，从未被搜过）。
 * 抽为常量后，**阈值判定**与**如实说明**同源，不再各写一份。
 */
export const CONTENT_SEARCH_MAX_FILE_BYTES = 500_000;

/** 体积闸的**人类可读**写法（与上同源派生，不手抄一份「500KB」——两份必然drift）。 */
export const CONTENT_SEARCH_MAX_FILE_LABEL = `${CONTENT_SEARCH_MAX_FILE_BYTES / 1000}KB`;

/** `skipped.samples` 只取**前几条**：如实登记不等于把全量路径塞回上下文（那是另一种不诚实）。 */
export const CONTENT_SEARCH_SKIP_SAMPLES_MAX = 5;

/** 本次**扫描面内**因体积闸被跳过的文件（休谟：缺席须说明缘由）。 */
export interface ContentSearchSkipped {
  /** 跳过几个（**0 表示一个都没跳过**；非"跳过了但没说数量"）。 */
  count: number;
  /** 为何跳过（体积上限，含门槛值本身与替代读法）。 */
  reason: string;
  /** 被跳过的文件**相对路径**（≤ `CONTENT_SEARCH_SKIP_SAMPLES_MAX` 条）。 */
  samples: string[];
}

export interface ContentSearchResult {
  path: string;
  scope: 'file' | 'dir';
  matches: number;
  results: Array<{ file: string; line: string }>;
  /** 本次**没查**什么——零命中时尤其必须给出（"查了没有"与"没查"是两回事）。 */
  skipped: ContentSearchSkipped;
}

/**
 * E11 `search_content` 的**判据本体**（与 electron/工具注册解耦，使受控回归能跑真实现）。
 *
 * 分场（维特根斯坦·语言游戏）：`dirPath` 指**文件** → 扫该文件；指**目录** → 递归（跳过隐藏项与
 * node_modules、深度 ≤12、单文件 < `CONTENT_SEARCH_MAX_FILE_BYTES`）；**不存在** → 明确报错
 * （调用方可区分"路径不对"与"确实没有"）。
 * 此前一律进 `readdirSync`，对文件抛 ENOTDIR 被 `catch {}` 吞成 `matches:0`——两个事实一个符号。
 *
 * zx_20260924_1 M10：**体积闸挡下的文件不再静默**。此前 `≥500KB` 早退**不留痕**，命中 0 时
 * 「查了但没有」与「根本没查」仍是同一个符号（语言游戏：两种游戏共用一套棋子的老病根）。
 * 现把被跳过的文件记进 `skipped`（count/reason/前几条 samples）——**单文件模式一并登记**
 * （`dirPath` 直指大文件时同样静默返回 0 命中，是同一条病根的第二处）。
 * ⚠ 只**如实登记**，不扩能力面：阈值、分页行为、其它工具阈值**一律不动**（超大文件的
 * 索引化/分片搜索属能力扩张，本轮不做）。
 *
 * zx_20260916_2 M2：改 `async` + `fs/promises`。判据（分场规则、深度、体积、跳过项、结果顺序与条数）
 * **一字未动**——只把"同步占住事件循环"换成"每次 I/O 都是一个让出点"。
 * 有意**顺序 await、不 `Promise.all`**：① `maxResults` 提前退出依赖遍历顺序，并发会让命中顺序不确定；
 * ② 该结果直接回给模型，顺序变了就是另一场回归。
 */
export async function searchPathForPattern(opts: {
  pattern: string;
  workingDir: string;
  dirPath?: string;
  fileTypes?: string;
  maxResults?: number;
}): Promise<({ ok: true } & ContentSearchResult) | { ok: false; error: string }> {
  const max = opts.maxResults ?? 30;
  const dp = opts.dirPath
    ? (path.isAbsolute(opts.dirPath) ? opts.dirPath : path.join(opts.workingDir, opts.dirPath))
    : opts.workingDir;
  let dpStat: Stats;
  try { dpStat = await fsp.stat(dp); } catch (e) {
    // 与旧实现同尺：旧是 `existsSync` 门 + try 内 `statSync`——只把**不存在**说成"路径不存在"，
    //   权限错/其它读失败仍抛真因（不把两件事压进同一个符号）。
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, error: `路径不存在: ${dp}` };
    return { ok: false, error: (e as Error).message };
  }
  try {
    const regex = new RegExp(opts.pattern, 'i');
    const exts = opts.fileTypes ? opts.fileTypes.split(',').map((s) => s.trim()) : null;
    const results: Array<{ file: string; line: string }> = [];
    // zx_20260924_1 M10：被体积闸挡下的文件（**唯一记数处**，目录模式与单文件模式共用）。
    const skipReason = `文件 ≥ ${CONTENT_SEARCH_MAX_FILE_BYTES} 字节（${CONTENT_SEARCH_MAX_FILE_LABEL}）超出本工具体积上限，`
      + `已跳过、**未搜索其内容**；需读其内容请改用 \`read_file\`（支持 offset/limit 分页）。`;
    const skippedSamples: string[] = [];
    let skippedCount = 0;
    const noteSkipped = (rel: string): void => {
      skippedCount++;
      if (skippedSamples.length < CONTENT_SEARCH_SKIP_SAMPLES_MAX) skippedSamples.push(rel);
    };
    const skippedOf = (): ContentSearchSkipped => ({ count: skippedCount, reason: skipReason, samples: skippedSamples });
    const scanFile = async (full: string, relBase: string): Promise<void> => {
      if (results.length >= max) return;
      // 相对路径口径与 `results[].file` **同一套**（目录模式 `path.relative(relBase, full)`、
      // 单文件模式 `path.relative(workingDir, dp)`）——同一个返回值里两套口径就是又一处"两处口径不一"。
      const rel = path.relative(relBase, full) || path.basename(full);
      try {
        const st = await fsp.stat(full);
        if (st.size >= CONTENT_SEARCH_MAX_FILE_BYTES) { noteSkipped(rel); return; }
        const lines = (await fsp.readFile(full, 'utf-8')).split('\n');
        for (let i = 0; i < lines.length && results.length < max; i++) {
          if (regex.test(lines[i]!)) {
            results.push({ file: rel, line: `${i + 1}:${lines[i]!.slice(0, 200)}` });
          }
        }
      } catch { /* 单文件不可读：跳过，不影响其它文件 */ }
    };
    if (dpStat.isFile()) {
      await scanFile(dp, opts.workingDir);
      return { ok: true, path: dp, scope: 'file', matches: results.length, results, skipped: skippedOf() };
    }
    const walkDir = async (d: string, depth: number): Promise<void> => {
      if (depth > 12 || results.length >= max) return;
      let names: string[];
      try { names = await fsp.readdir(d); } catch { return; /* 目录不可读：跳过 */ }
      for (const name of names) {
        if (depth > 12 || results.length >= max) return;
        const full = path.join(d, name);
        if (name.startsWith('.') || name === 'node_modules') continue;
        try {
          const st = await fsp.stat(full);
          if (st.isDirectory()) { await walkDir(full, depth + 1); }
          // 体积闸**下移到 `scanFile`**（记 skip 的唯一处）：本条件只留 `fileTypes` 这层**用户显式**过滤——
          // 被它排除的文件**本就不在扫描面内**，记成"跳过"是另一种不诚实（如实 ≠ 见大就报）。
          else if (st.isFile() && (!exts || exts.some((e) => full.endsWith(e)))) {
            await scanFile(full, d);
          }
        } catch { /* 单个条目不可读：跳过 */ }
      }
    };
    await walkDir(dp, 0);
    return { ok: true, path: dp, scope: 'dir', matches: results.length, results, skipped: skippedOf() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** `read_file` 单次回传的字符上限（唯一真源）。 */
export const READ_FILE_MAX_CHARS = 50_000;

export interface ReadFilePage {
  /** 回传给模型的内容（必要时含如实说明尾巴）。 */
  text: string;
  /** 全文行数 / 字符数——**无论是否截断都给出**，供调用方自证"我看到的不是全文"。 */
  totalLines: number;
  totalChars: number;
  /** 本次实际返回的首行号（1-based）；空/越界时为 0。 */
  startLine: number;
  /** 本次实际返回的末行号（1-based）；空/越界时为 0。 */
  endLine: number;
  truncated: boolean;
  /** 续读应传的 offset（0-based 行号）；无后续内容时为 null。 */
  nextOffset: number | null;
}

/**
 * zx_20260913 M4-5（名实相符 / 管子·度量衡）：`read_file` 的**分页与截断判据本体**，与 fs 解耦。
 *
 * 旧实现先 `slice(0, 50_000)` **再**按行分页 ⇒ ①「行」与「字符」两把尺错位：超 5 万字符的文件，
 * 其边界之后的行按 `offset` **永远取不到**；② 无参读取超限时**静默截尾**，调用方读到半截却以为拿到全文。
 * 现先取全文、分页在**全文**上进行；无论分页与否，超限一律**如实交代**（总行数/字符数 + 续读 offset）。
 *
 * 返回结构化结果（而非只回字符串），使受控回归能直接断言"边界之后可达"与"超限必交代"。
 */
export function paginateReadFile(
  full: string,
  opts?: { offset?: number; limit?: number; maxChars?: number },
): ReadFilePage {
  const MAX = opts?.maxChars ?? READ_FILE_MAX_CHARS;
  const lines = full.split('\n');
  const totalLines = lines.length;
  const totalChars = full.length;
  const start = Math.max(0, Math.floor(opts?.offset ?? 0));
  const end = opts?.limit != null ? start + Math.max(0, Math.floor(opts.limit)) : totalLines;

  if (start >= totalLines) {
    return {
      text: `[read_file] offset=${start} 已超出文件末尾（文件共 ${totalLines} 行、${totalChars} 字符）。`,
      totalLines, totalChars, startLine: 0, endLine: 0, truncated: false, nextOffset: null,
    };
  }

  const body = lines.slice(start, end).join('\n');

  if (body.length > MAX) {
    const head = body.slice(0, MAX);
    const shown = head.split('\n').length - 1; // 截断处所在行不算完整行
    const nextOffset = start + shown;
    return {
      text: `${head}\n\n[read_file] 超出 ${MAX} 字符上限已截断（文件共 ${totalLines} 行、${totalChars} 字符）——此处仅显示第 ${start + 1}-${nextOffset} 行；续读：offset=${nextOffset}`,
      totalLines, totalChars, startLine: start + 1, endLine: nextOffset, truncated: true, nextOffset,
    };
  }

  const last = Math.min(end, totalLines);
  if (end < totalLines) {
    return {
      text: `${body}\n\n[read_file] 本次为第 ${start + 1}-${last} 行（文件共 ${totalLines} 行、${totalChars} 字符）；续读：offset=${end}`,
      totalLines, totalChars, startLine: start + 1, endLine: last, truncated: true, nextOffset: end,
    };
  }

  return { text: body, totalLines, totalChars, startLine: start + 1, endLine: last, truncated: false, nextOffset: null };
}
