/**
 * zx_20261002 M16-③（管子·度量衡 / 黑格尔·合理才存在）: **列存在性**判据的可复用实现。
 *
 * 病根（方案 §1.6）：`db.prepare(...)` 里写了一个**本库不存在的表或列**，SQLite 在**执行那一刻**才报
 * `no such table/column`；而调用点几乎都裹在 `try { } catch { }` 里 ⇒ 查询**恒失败且无人知道**
 * （本轮实打实抓到四处：`admin:toolStats` 的 `tool_name`、自愈项的 `ans_audit_logs` 与 `wa_jobs.updated_at`、
 * 邀请码的 `wa_invite_tokens.used`）。这类病**在源码里长得完全正常**——只有拿真 schema 去核才照得出。
 *
 * 本模块把"核"这件事做成一条**可复跑**的判据：从**生产 DDL** 抽表 → 建内存库 → `PRAGMA table_info`
 * 取权威列 → 扫全仓 `.prepare(...)` 的 SQL，逐个核对引用的表与列。
 *
 * 三条纪律（对上本仓 auto-memory）：
 *   · **夹具即生产**：schema 只从源码里的 `CREATE TABLE` / `ALTER TABLE … ADD COLUMN` **原文**建立，
 *     不手抄一份列清单（手抄的清单会与生产一起漂，判据就成了自我印证）。逐条 DDL 交给 SQLite 自己解析，
 *     列名一律经 `PRAGMA table_info` 取——**不自己解析 SQL 语法**。
 *   · **判据只读原文**（G-5）：读 `.ts` 原文抽 SQL，不去注释（注释里也可能藏着真语句）。
 *   · **可证伪**（G-2）：对 HEAD 版（含不存在的列）**必红**、对修复版**必绿**；「某块内零处 X」须自证块非空
 *     （见 `ColumnScanResult.checked` —— 被核对过的语句数必须 > 0，否则"没扫到"会被当成"没毛病"）。
 *
 * ⚠ 只核 `.prepare()` 直传的**字符串字面量**；含 `${…}` 的模板串（拼出来的 SQL）**跳过并计数**——
 *   拼出来的 SQL 静态判不了（那需要值域），跳过要**如实报数**，不能假装核过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface SqlFinding {
  file: string;
  /** 出错语句片段（截断，便于人看） */
  sql: string;
  kind: 'table' | 'column';
  name: string;
}

export interface ColumnScanResult {
  /** 从源里解析到的 `.prepare(...)` 字符串字面量总数（含被跳过的） */
  parsed: number;
  /** 其中**真被核对**的语句数（引用的表全在 schema 内）——「自证块非空」用 */
  checked: number;
  /** 因引用了 schema 外的表而**未能**核对列的语句数 */
  skippedByUnknownTable: number;
  /** 含 `${…}` 插值、静态判不了而跳过的语句数 */
  skippedInterpolated: number;
  /** `PRAGMA` 语句（本判据只管表/列引用）跳过的语句数 */
  skippedPragma: number;
  /** schema 里的表数（自证"schema 非空"） */
  tableCount: number;
  findings: SqlFinding[];
}

/** SQL 关键字 / 伪列 / 内建函数名——不参与"列名"判定。 */
const KEYWORDS = new Set(
  (
    'select from where group by order having limit offset join left right inner outer full cross on as and or not null is in like glob ' +
    'between exists case when then else end union all distinct insert into values update set delete returning with recursive asc desc ' +
    'cast collate escape primary key unique index using natural default over partition rows range preceding following unbounded current ' +
    'row filter window do conflict nothing matched excluded new old true false integer text real blob numeric begin commit transaction ' +
    'replace ignore pragma vacuum analyze explain query plan temp match against rank'
  ).split(/\s+/).map((s) => s.toUpperCase()),
);

/** 只有 SQLite 内建的系统表——不算"生产 DDL 没建"。 */
const SYSTEM_TABLES = new Set(['sqlite_master', 'sqlite_schema', 'sqlite_temp_master']);

/**
 * 从源码文本里抽所有 `CREATE [VIRTUAL] TABLE [IF NOT EXISTS] <name> ( … )` 的**完整原文**
 * （括号配对取到闭合），交给 SQLite 解析。返回 (表名, 语句) 列表。
 */
export function extractCreateStatements(src: string): Array<{ table: string; ddl: string }> {
  const out: Array<{ table: string; ddl: string }> = [];
  // 末尾 `\s*\(` 是**非回退的**锚：注释里那句「`CREATE TABLE IF NOT EXISTS` 对已存在的表不生效」原本会因
  //   回溯把表名截成 `IF`，再 `indexOf('(')` 一路扫到邻近 ALTER 上（假 DDL ⇒ exec 报错）。锚定 `(` 即根治。
  const re = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?(?:\s+USING\s+\w+)?\s*\(/gi;
  for (const m of src.matchAll(re)) {
    const open = m.index + m[0].length - 1; // m[0] 以 `(` 收尾
    if (src[open] !== '(') continue;
    let depth = 0, i = open;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { i++; break; } }
      i++;
    }
    if (depth !== 0) continue;
    out.push({ table: m[1], ddl: src.slice(m.index, i) });
  }
  return out;
}

/**
 * 从源码文本里抽所有 `ALTER TABLE <t> ADD COLUMN <c>`，归一成可执行的最小 DDL。
 * 只取表名与列名（类型无关紧要——判据只问"列在不在"）。
 */
export function extractAlterAddColumns(src: string): Array<{ table: string; column: string; ddl: string }> {
  const out: Array<{ table: string; column: string; ddl: string }> = [];
  const re = /ALTER\s+TABLE\s+[`"']?(\w+)[`"']?\s+ADD\s+COLUMN\s+[`"']?(\w+)[`"']?/gi;
  for (const m of src.matchAll(re)) {
    out.push({ table: m[1], column: m[2], ddl: `ALTER TABLE "${m[1]}" ADD COLUMN "${m[2]}"` });
  }
  return out;
}

function walkTs(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * 用**生产 DDL 原文**建内存库，返回 `表 → 列名[]`（列名一律经 `PRAGMA table_info`）。
 *
 * DDL 与 ALTER 都尽力 exec；单条 exec 失败**不静默吞**——名字进 `failed` 列表，由调用方决定如何如实呈现
 * （"建不起来"与"没问题"必须分开，否则判据又成了自我印证）。
 */
export function buildSchemaFromSources(
  srcDirs: string[],
): { tables: Map<string, string[]>; failed: string[] } {
  const db = new DatabaseSync(':memory:');
  const failed: string[] = [];
  const files = srcDirs.flatMap((d) => walkTs(d));
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const { table, ddl } of extractCreateStatements(src)) {
      try {
        db.exec(ddl);
      } catch (err) {
        failed.push(`${table}: ${(err as Error).message}`);
      }
    }
    for (const { table, ddl } of extractAlterAddColumns(src)) {
      try {
        db.exec(ddl);
      } catch (err) {
        // 同表在多文件/多处建列 ⇒ 后到的 ALTER 撞"duplicate column"——列已在，非缺陷。
        if (!/duplicate column name/i.test((err as Error).message)) {
          failed.push(`${table} (alter): ${(err as Error).message}`);
        }
      }
    }
  }
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((r) => r.name);
  const tables = new Map<string, string[]>();
  for (const n of names) {
    // sqlite_master 保留（生产查询会 `SELECT name FROM sqlite_master WHERE type='table'`）；
    //   fts5 的内部影子表（`<t>_data` 等）跳过——非生产可用表。
    if (n.startsWith('sqlite_') && n !== 'sqlite_master') continue;
    if (n.endsWith('_data') || n.endsWith('_idx') || n.endsWith('_content') || n.endsWith('_docsize') || n.endsWith('_config')) continue;
    const cols = (db.prepare(`PRAGMA table_info("${n}")`).all() as Array<{ name: string }>).map((c) => c.name);
    tables.set(n, cols);
  }
  // SQLite 不把自身列入 sqlite_master 的行——显式补上（生产确有 `SELECT name FROM sqlite_master`）。
  for (const sys of ['sqlite_master', 'sqlite_schema']) {
    const cols = (db.prepare(`PRAGMA table_info("${sys}")`).all() as Array<{ name: string }>).map((c) => c.name);
    if (cols.length) tables.set(sys, cols);
  }
  return { tables, failed };
}

/**
 * 读一个字符串字面量（从 `i` 处的引号开始），返回字面量内容与结束后的下标。
 * 反引号（模板串）**不跨 `${…}` 拼接**：遇到 `${` 即认为静态判不了，原样保留 `${` 供调用方跳过。
 */
function readLiteral(src: string, i: number): { text: string; end: number } | null {
  const q = src[i];
  if (q !== '`' && q !== "'" && q !== '"') return null;
  if (q === '`') {
    const end = src.indexOf('`', i + 1);
    if (end < 0) return null;
    return { text: src.slice(i + 1, end), end: end + 1 };
  }
  let j = i + 1, buf = '';
  while (j < src.length && src[j] !== q) {
    if (src[j] === '\\') { buf += src[j + 1] ?? ''; j += 2; } else { buf += src[j]; j++; }
  }
  return { text: buf, end: j + 1 };
}

/**
 * 从一个 `.prepare(...)` 里抽出**字符串字面量**参数（单/双引号，正确处理 `\` 转义；反引号取到下一个反引号）。
 * **相邻字面量的 `+` 拼接会合并**——多行长 SQL 常写成 `"…" + "…" + "…"`；不合并就只读到第一段
 * （判据会把整条语句看成"没有 FROM 的残句"，既误报又可能漏报）。
 * 非字面量参数（变量、函数调用）不返回——静态判不了，由调用方计数。
 */
export function extractPrepareLiterals(src: string): string[] {
  const out: string[] = [];
  const re = /\.prepare\(\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const first = readLiteral(src, re.lastIndex);
    if (!first) continue;
    let text = first.text;
    let end = first.end;
    // 吞掉 `+ "…"` 的后续片段
    for (;;) {
      let k = end;
      while (k < src.length && /\s/.test(src[k])) k++;
      if (src[k] !== '+') break;
      k++;
      while (k < src.length && /\s/.test(src[k])) k++;
      const next = readLiteral(src, k);
      if (!next) break;
      text += next.text;
      end = next.end;
    }
    out.push(text);
    re.lastIndex = end;
  }
  return out;
}

/** `WITH [RECURSIVE] a AS (…), b AS (…)` 里的 CTE 名——它们是"临时表"，不算生产表也不算了列名。 */
function cteNames(sql: string): Set<string> {
  const s = new Set<string>();
  for (const m of sql.matchAll(/(?:WITH(?:\s+RECURSIVE)?|,)\s+(\w+)\s*(?:\([^)]*\))?\s+AS\s*\(/gi)) s.add(m[1]);
  return s;
}

/** 语句引用的表名（FROM/JOIN/INTO/UPDATE 之后那个词），排除 CTE 名、系统表与关键字。
 *
 *  ⚠ `UPDATE` 之后那个词未必是表名：upsert 的 `ON CONFLICT(key) DO UPDATE SET value = …` 里
 *    `UPDATE` 紧跟的就是关键字 `SET`（`SET` 已被 `KEYWORDS` 收录）——不过滤就会把一条**完全合法**的
 *    upsert 报成"引用了不存在的表 SET"。关键字本就不可能是合法表名，滤掉只去伪、不漏真：
 *    真写 `UPDATE 不存在的表 SET …` 时表名非关键字，仍会被捕到并上报。 */
export function referencedTables(sql: string): string[] {
  const ctes = cteNames(sql);
  const s = new Set<string>();
  for (const m of sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+[`"']?(\w+)[`"']?/gi)) {
    if (ctes.has(m[1]) || KEYWORDS.has(m[1].toUpperCase())) continue;
    s.add(m[1]);
  }
  return [...s];
}

type Tok = { k: 'id' | 'dot' | 'param' | 'lparen' | 'rparen'; v?: string };

function tokenize(sql: string): Tok[] {
  const toks: Tok[] = [];
  for (const m of sql.matchAll(/@(\w+)|(\w+)|(\()|(\))|(\.)/g)) {
    if (m[1] !== undefined) toks.push({ k: 'param', v: m[1] });
    else if (m[2] !== undefined) toks.push({ k: 'id', v: m[2] });
    else if (m[3] !== undefined) toks.push({ k: 'lparen' });
    else if (m[4] !== undefined) toks.push({ k: 'rparen' });
    else toks.push({ k: 'dot' });
  }
  return toks;
}

/**
 * 语句里"看着像列名"的标识符（未限定）。用于未限定列的存在性核对。
 * 已排除：字面量、关键字、纯数字、`rowid` 伪列、表名、CTE 名、`AS` 别名、隐式别名（紧跟 `)`）、
 *        函数名（紧跟 `(`）、限定前缀（后面是 `.`）。
 */
export function candidateColumns(sql: string, knownTables: Map<string, string[]>): string[] {
  const clean = sql.replace(/'(?:[^']|'')*'/g, " '' ");
  const ctes = cteNames(clean);
  const aliases = new Set<string>();
  for (const m of clean.matchAll(/\bAS\s+(\w+)/gi)) aliases.add(m[1]);
  const tAlias = new Set<string>();
  for (const m of clean.matchAll(/\b(?:FROM|JOIN)\s+(\w+)\s+(?:AS\s+)?(\w+)/gi)) {
    if (knownTables.has(m[1]) && !KEYWORDS.has(m[2].toUpperCase())) tAlias.add(m[2]);
  }
  const toks = tokenize(clean);
  const out = new Set<string>();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== 'id') continue;
    const v = t.v!;
    const prev = toks[i - 1], next = toks[i + 1];
    if (KEYWORDS.has(v.toUpperCase())) continue;
    if (/^\d+$/.test(v)) continue;
    if (v.toLowerCase() === 'rowid') continue;
    if (SYSTEM_TABLES.has(v)) continue;        // sqlite_master 等系统表名
    if (knownTables.has(v)) continue;          // 表名本身
    if (ctes.has(v) || aliases.has(v) || tAlias.has(v)) continue;
    if (next && next.k === 'dot') continue;    // 限定前缀：X.col 里的 X
    if (next && next.k === 'lparen') continue; // 函数名
    if (prev && prev.k === 'rparen') continue; // 隐式别名：COUNT(*) c
    if (prev && prev.k === 'dot') continue;    // 限定列：交给 qualifiedColumns
    out.add(v);
  }
  return [...out];
}

/** 语句里 `X.col` 形式的限定列引用（X 是已知表名时）。 */
export function qualifiedColumns(sql: string, knownTables: Map<string, string[]>): Array<{ table: string; column: string }> {
  const clean = sql.replace(/'(?:[^']|'')*'/g, " '' ");
  const toks = tokenize(clean);
  const out: Array<{ table: string; column: string }> = [];
  for (let i = 2; i < toks.length; i++) {
    if (toks[i].k === 'id' && toks[i - 1].k === 'dot' && toks[i - 2].k === 'id') {
      const table = toks[i - 2].v!;
      if (knownTables.has(table)) out.push({ table, column: toks[i].v! });
    }
  }
  return out;
}

/**
 * 扫一组源目录下所有 `.ts` 的 `.prepare(...)`，核对表存在性与列存在性。
 * `knownTables` 由 `buildSchemaFromSources` 给出（生产 DDL 派生的权威 schema）。
 */
export function scanPreparedSql(rootDir: string, srcDirs: string[], knownTables: Map<string, string[]>): ColumnScanResult {
  const files = srcDirs.flatMap((d) => walkTs(d));
  let parsed = 0, checked = 0, skippedByUnknownTable = 0, skippedInterpolated = 0, skippedPragma = 0;
  const findings: SqlFinding[] = [];

  for (const f of files) {
    const rel = path.relative(rootDir, f);
    const src = fs.readFileSync(f, 'utf8');
    for (const sql of extractPrepareLiterals(src)) {
      parsed++;
      if (sql.includes('${')) { skippedInterpolated++; continue; }
      if (/^\s*PRAGMA\b/i.test(sql)) { skippedPragma++; continue; }
      const snippet = sql.trim().replace(/\s+/g, ' ').slice(0, 120);
      const tables = referencedTables(sql);
      const missingTables = tables.filter((t) => !knownTables.has(t) && !SYSTEM_TABLES.has(t));
      if (missingTables.length) {
        skippedByUnknownTable++;
        for (const t of missingTables) findings.push({ file: rel, sql: snippet, kind: 'table', name: t });
        continue;
      }
      checked++;
      const cols = new Set<string>();
      for (const t of tables) for (const c of knownTables.get(t) ?? []) cols.add(c);
      for (const c of candidateColumns(sql, knownTables)) {
        if (!cols.has(c)) findings.push({ file: rel, sql: snippet, kind: 'column', name: c });
      }
      for (const { table, column } of qualifiedColumns(sql, knownTables)) {
        if (!(knownTables.get(table) ?? []).includes(column)) {
          findings.push({ file: rel, sql: snippet, kind: 'column', name: `${table}.${column}` });
        }
      }
    }
  }
  return { parsed, checked, skippedByUnknownTable, skippedInterpolated, skippedPragma, tableCount: knownTables.size, findings };
}
