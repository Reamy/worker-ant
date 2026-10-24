import React, { useState } from 'react';

/**
 * zx_20260914 M2-1(康德·范畴穷尽 / 王阳明·知行合一): 成果正文「读得动」的**唯一渲染处**。
 *
 * 病根(上轮 zx_20260911_5 M3 做到"能翻开"，但面板内只有 `<pre>`): **打开 ≠ 读得动**——
 *   Markdown 原文整块等宽铺开，标题/列表/引用全成了井号与减号，代码块与正文同字号。
 *
 * 口径三条(本模块最容易走偏的地方):
 *  1. **零依赖、禁 `dangerouslySetInnerHTML`**：解析成**结构化块**再由 React 元素渲染，
 *     全程无 HTML 字符串拼装 ⇒ 无注入面。输入 `<script>` 只会是**文本**，不会是元素。
 *     不做语法高亮(零依赖前提下的诚实取舍，如实标注：**代码不染色**)。
 *  2. **链接只认协议白名单**：`javascript:` 等危险协议即便 React 不报错也真能执行，
 *     故非白名单协议**降级为纯文本**，不产出 `<a>`。
 *  3. **纯函数、零副作用**：`parseMarkdownSubset` 不读 IPC、不读 store ⇒
 *     受控复跑可直接 import 跑**真实现**(承既有手法「抽纯函数让 rr 跑真实现」)。
 */

/** 受限子集的一块。**穷尽清单即契约**——不在此列表的语法一律按段落原文显示(不猜、不吞)。 */
export type MdBlock =
  /** 标题，`level` 1–6 */
  | { type: 'heading'; level: number; text: string }
  /** 段落(连续非空行合并) */
  | { type: 'paragraph'; text: string }
  /** 无序列表 */
  | { type: 'ul'; items: string[] }
  /** 有序列表，`start` 为起始序号 */
  | { type: 'ol'; start: number; items: string[] }
  /** 引用块(连续 `> ` 行合并) */
  | { type: 'quote'; text: string }
  /** 围栏代码块，`lang` 为围栏信息串(不去猜语言、只如实显示) */
  | { type: 'code'; lang: string; code: string }
  /** 分隔线 */
  | { type: 'hr' }
  /** 表格：`header` 为表头单元格，`rows` 为数据行 */
  | { type: 'table'; header: string[]; rows: string[][] };

/** 链接协议白名单。**不在名单即降级为纯文本**(见口径 2)。 */
const SAFE_SCHEMES = ['http:', 'https:', 'mailto:'];

/** 有序列表项 `1. ` / `1) `；`start` 取首项序号(不假设从 1 开始，如实呈现)。 */
const OL_RE = /^(\d{1,9})[.)]\s+(.*)$/;
/** 无序列表项 `- ` / `* ` / `+ `。 */
const UL_RE = /^[-*+]\s+(.*)$/;
/** 标题 `#{1,6} `(井号后须有空格，避免把 `#tag` 当标题)。 */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
/** 分隔线：3 个以上同类符号且**整行只有它**(避免把 `---` 表格分隔行当分隔线)。 */
const HR_RE = /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
/** 围栏：``` 或 ~~~，可带语言信息串。 */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
/** 引用 `> ` (允许裸 `>`)。 */
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
/** 表格分隔行：`| --- | :--: |` 之类，至少一个连字符。 */
const TABLE_SEP_RE = /^\s{0,3}\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/** 按 `|` 切表格行，去掉首尾空单元(源里 `| a | b |` 与 `a | b` 同义)。 */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

function isTableSep(line: string): boolean {
  if (!line.includes('-')) return false;
  if (!TABLE_SEP_RE.test(line)) return false;
  return splitRow(line).every((c) => /^:?-+:?$/.test(c));
}

/**
 * 把受限子集 Markdown 解析为**结构化块**。空串/非串 ⇒ 空数组(空内容不是"一段空段落")。
 * 未闭合的围栏按**到文末**收口(不吞掉剩余内容、也不报错——如实呈现作者写下的东西)。
 */
export function parseMarkdownSubset(source: unknown): MdBlock[] {
  const src = typeof source === 'string' ? source : '';
  if (!src.trim()) return [];
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // 空行只作分隔，不产出块
    if (!line.trim()) { i++; continue; }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const lang = fence[2] ?? '';
      const body: string[] = [];
      i++;
      // 收口条件：同为同类围栏且长度不小于开栏(与 CommonMark 同观，避免 ```` 被 ``` 提前结束)
      while (i < lines.length) {
        const close = FENCE_RE.exec(lines[i]!);
        if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) break;
        body.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++; // 吃掉收口围栏(未闭合则本已是文末)
      blocks.push({ type: 'code', lang, code: body.join('\n') });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]!.trim() });
      i++;
      continue;
    }

    if (HR_RE.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

    // 表格：当前行含 `|` 且**下一行是分隔行**才算(否则只是普通段落里带了竖线)
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      const buf: string[] = [quote[1]!];
      i++;
      while (i < lines.length) {
        const next = QUOTE_RE.exec(lines[i]!);
        if (!next) break;
        buf.push(next[1]!);
        i++;
      }
      blocks.push({ type: 'quote', text: buf.join('\n') });
      continue;
    }

    const ol = OL_RE.exec(line);
    if (ol) {
      const start = Number(ol[1]);
      const items: string[] = [ol[2]!];
      i++;
      while (i < lines.length) {
        const next = OL_RE.exec(lines[i]!);
        if (!next) break;
        items.push(next[2]!);
        i++;
      }
      blocks.push({ type: 'ol', start, items });
      continue;
    }

    const ul = UL_RE.exec(line);
    if (ul) {
      const items: string[] = [ul[1]!];
      i++;
      while (i < lines.length) {
        const next = UL_RE.exec(lines[i]!);
        if (!next) break;
        items.push(next[1]!);
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // 段落：吃到空行 / 下一个块起始行为止
    const buf: string[] = [line.trim()];
    i++;
    while (i < lines.length) {
      const next = lines[i]!;
      if (!next.trim()) break;
      if (FENCE_RE.test(next) || HEADING_RE.test(next) || HR_RE.test(next)
        || QUOTE_RE.test(next) || OL_RE.test(next) || UL_RE.test(next)) break;
      buf.push(next.trim());
      i++;
    }
    blocks.push({ type: 'paragraph', text: buf.join('\n') });
  }

  return blocks;
}

/** 行内片段。**富文本一律由元素承载**，不存在"拼好的 HTML 串"。 */
type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string }
  | { type: 'link'; text: string; href: string };

function isSafeHref(href: string): boolean {
  // 相对链接(`/a`、`a.md`)与锚点(`#x`)无协议可言，放行；带协议的须在白名单内。
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href);
  if (!scheme) return true;
  return SAFE_SCHEMES.includes(scheme[1]!.toLowerCase() + ':');
}

/**
 * 行内解析。顺序即契约：**先切行内代码**，其余规则只在非代码段上跑
 * (否则 `` `**not bold**` `` 会被误加粗；反引号内的内容必须原样)。
 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const segs = String(text).split('`');
  segs.forEach((seg, idx) => {
    if (!seg) return;
    // 奇数下标 = 反引号**内**的原文
    if (idx % 2 === 1) { out.push({ type: 'code', text: seg }); return; }
    out.push(...parseEmphasisAndLinks(seg));
  });
  return out;
}

function parseEmphasisAndLinks(seg: string): Inline[] {
  const out: Inline[] = [];
  // 一个够用的扫描器：按 `**` / `*` / `_` / `[..](..)` 顺序贪婪切分，不支持的语法原样留在 text
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(_([^_]+)_)|(\[([^\]]*)\]\(([^)\s]*)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg)) !== null) {
    if (m.index > last) out.push({ type: 'text', text: seg.slice(last, m.index) });
    if (m[2] !== undefined) out.push({ type: 'strong', text: m[2] });
    else if (m[4] !== undefined) out.push({ type: 'em', text: m[4] });
    else if (m[6] !== undefined) out.push({ type: 'em', text: m[6] });
    else if (m[7] !== undefined) {
      // 组号即契约：交替式第 4 支的**整段**在 7、标签在 8、地址在 9。
      // （曾误取 7/8 ⇒ 链接文字成了 `[名](url)` 全文、href 成了标签——`isSafeHref` 因此形同虚设。）
      const label = m[8] ?? '';
      const href = m[9] ?? '';
      // 口径 2：非白名单协议**降级为纯文本**，不产出链接元素
      if (isSafeHref(href)) out.push({ type: 'link', text: label, href });
      else out.push({ type: 'text', text: m[0] });
    }
    last = re.lastIndex;
  }
  if (last < seg.length) out.push({ type: 'text', text: seg.slice(last) });
  return out;
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  return parseInline(text).map((f, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (f.type) {
      case 'code':
        return <code key={key} className="px-1 py-0.5 rounded bg-gray-100 text-pink-600 text-[0.9em] font-mono">{f.text}</code>;
      case 'strong':
        return <strong key={key} className="font-semibold text-gray-900">{f.text}</strong>;
      case 'em':
        return <em key={key}>{f.text}</em>;
      case 'link':
        return <a key={key} href={f.href} target="_blank" rel="noreferrer noopener" className="text-blue-600 underline break-all">{f.text}</a>;
      default:
        return <React.Fragment key={key}>{f.text}</React.Fragment>;
    }
  });
}

/** 围栏代码块：等宽 + 行号 + 复制按钮。**不做语法高亮**(口径 1，如实标注)。 */
export function CodeBlock({ code, lang, keyPrefix }: { code: string; lang: string; keyPrefix: string }): React.ReactNode {
  const [copied, setCopied] = useState(false);
  const lines = code.length ? code.split('\n') : [''];
  const gutter = String(lines.length).length;
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => { /* 剪贴板不可用 ⇒ 如实保持未复制态，不假装已复制 */ });
  };
  return (
    <div className="my-2 rounded border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1 bg-gray-100 border-b border-gray-200">
        <span className="text-[10px] font-mono text-gray-500">{lang || '代码'}</span>
        <button type="button" onClick={copy} title="复制代码" className="text-[10px] px-1.5 py-0.5 rounded hover:bg-gray-200 text-gray-600">
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="text-xs bg-gray-50 p-2 overflow-auto max-h-[480px] m-0">
        <code className="font-mono">
          {lines.map((ln, i) => (
            <div key={`${keyPrefix}-L${i}`} className="flex">
              <span className="select-none text-gray-400 text-right" style={{ minWidth: `${gutter}ch`, paddingRight: '0.75em' }}>{i + 1}</span>
              <span className="whitespace-pre">{ln || ' '}</span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}

/**
 * 把受限子集 Markdown 渲染为 React 元素。**这是四处预览面板共用的唯一入口**
 * (见 M2 细化规划 订正3 —— 实为四处，非方案原文的"三处")。
 */
export default function MarkdownSubset({ source }: { source: unknown }): React.ReactNode {
  const blocks = parseMarkdownSubset(source);
  if (!blocks.length) return null;
  return (
    <>
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.type) {
          case 'heading': {
            const size = ['text-lg', 'text-lg', 'text-base', 'text-sm', 'text-sm', 'text-sm'][b.level - 1] ?? 'text-sm';
            return <div key={key} className={`font-semibold text-gray-900 mt-3 mb-1 ${size}`}>{renderInline(b.text, key)}</div>;
          }
          case 'hr':
            return <hr key={key} className="my-3 border-gray-200" />;
          case 'quote':
            return <blockquote key={key} className="my-2 pl-3 border-l-4 border-gray-300 text-gray-600 whitespace-pre-wrap">{renderInline(b.text, key)}</blockquote>;
          case 'code':
            return <CodeBlock key={key} code={b.code} lang={b.lang} keyPrefix={key} />;
          case 'ul':
            return <ul key={key} className="my-2 pl-5 list-disc space-y-0.5">{b.items.map((it, j) => <li key={`${key}-${j}`}>{renderInline(it, `${key}-${j}`)}</li>)}</ul>;
          case 'ol':
            return <ol key={key} start={b.start} className="my-2 pl-5 list-decimal space-y-0.5">{b.items.map((it, j) => <li key={`${key}-${j}`}>{renderInline(it, `${key}-${j}`)}</li>)}</ol>;
          case 'table':
            return (
              <div key={key} className="my-2 overflow-auto">
                <table className="text-xs border-collapse">
                  <thead><tr>{b.header.map((h, j) => <th key={`${key}-h${j}`} className="border border-gray-200 bg-gray-50 px-2 py-1 text-left font-medium">{renderInline(h, `${key}-h${j}`)}</th>)}</tr></thead>
                  <tbody>{b.rows.map((r, j) => <tr key={`${key}-r${j}`}>{r.map((c, k) => <td key={`${key}-r${j}c${k}`} className="border border-gray-200 px-2 py-1 align-top">{renderInline(c, `${key}-r${j}c${k}`)}</td>)}</tr>)}</tbody>
                </table>
              </div>
            );
          default:
            return <p key={key} className="my-2 whitespace-pre-wrap break-words">{renderInline(b.text, key)}</p>;
        }
      })}
    </>
  );
}
