/**
 * zx_20261011 M10（追加批·三轮）: 「执行方回传」卡片的**一句话摘要**——**一处真源**（纯函数，可被 rr 直跑）。
 *
 * 由来（E2E 第三轮 `9e43726a`）：回传数据改取**产出物原文**后（对外完整、一处真源），
 *   但卡片是 3 行 `line-clamp`，而产出物正文常以 markdown 标题（`# 自我介绍` / `## 一句话介绍`）开头
 *   ⇒ **标题占满 3 行，那句答案被挤出行外**。故**只在展示层**去壳：回传数据不动，卡片摘要改取"正文首段"。
 *
 * ⚠ 只在**像 markdown**（含 `#` 标题或 ``` 围栏）时去壳；**纯文本摘要原样返回**——不误伤既有形态。
 * ⚠ 全篇皆结构（无正文）⇒ **退回原文**（不返回空，宁可照显也不丢字）。
 */
export function briefFromText(text: string): string {
  const lines = text.split('\n');
  if (!lines.some((l) => /^\s*(#{1,6}\s|```)/.test(l))) return text;
  const isScaffold = (l: string): boolean => {
    const t = l.trim();
    return t === '' || /^#{1,6}\s/.test(t) || /^(-{3,}|\*{3,}|_{3,})$/.test(t) || /^>/.test(t) || /^```/.test(t);
  };
  const body: string[] = [];
  for (const l of lines) {
    if (body.length === 0) { if (isScaffold(l)) continue; } else if (isScaffold(l)) break;
    body.push(l.trim());
  }
  return body.join(' ').trim() || text.trim();
}

/** 结果的"一句话"：优先 `summary`（markdown 文档**去壳取正文首段**），退到 `error`，再退到整份 JSON。 */
export function resultBrief(result: Record<string, unknown> | null): string {
  if (!result) return '';
  if (typeof result.summary === 'string' && result.summary) return briefFromText(result.summary);
  if (typeof result.error === 'string' && result.error) return result.error;
  try { return JSON.stringify(result); } catch { return ''; }
}
