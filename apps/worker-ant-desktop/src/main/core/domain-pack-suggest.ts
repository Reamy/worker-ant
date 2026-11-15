/**
 * zx_20261115_3 M5「传」（管子·因势 / 维特根斯坦·意义即用法）：
 * **按任务文本**给候选领域包一次"就地建议"——不是自动启用，也不是列表里躺着的死资产。
 *
 * 病根（真库）：9 个 `auto_candidate` 领域包（10-30 生成）**0 个启用**。它们只在项目详情
 *   的「知识」卡里出现，用户建单时看不到；而"这个任务像哪个领域"这件事，题面本身就有信号。
 *
 * 三条纪律：
 *   ① 候选与"已忽略/已启用/本项目派生"的过滤**复用** `listSuggestedDomainPacks`（一处筛选）；
 *   ② 建议**只读**：本函数不写库、不启用；启用仍走 `packs:apply`（Pro 闸）；
 *   ③ **0 命中不推**：宁可没有建议，也不拿相似度硬凑一条（相似 ≠ 命中）。
 */
import { listSuggestedDomainPacks, parseDomainPackJson, type DomainPackListRow } from './domain-pack.js';

type SuggestDb = Parameters<typeof listSuggestedDomainPacks>[0];

export interface DomainPackTaskSuggestion {
  id: string;
  name: string;
  /** 命中的词条（真名，不是打分）——界面据此说"为什么像"。 */
  hits: string[];
  /** 既有相似度（无来源项目/读不到 ⇒ 缺席，不编 0）。 */
  similarity?: { score: number; reasons: string[] };
}

/** 太泛的词不当"命中证据"（否则每条建议都能被"项目/任务"命中）。 */
const GENERIC_TERMS = new Set([
  '项目', '任务', '文件', '服务', '系统', '问题', '说明', '规则', '术语', '验收', '配方',
  '约定', '场景', '流程', '目标', '结果', '原因', '方法', '入口', '配置', '数据',
]);

function collectTerms(packJson: string, packName: string): string[] {
  const out = new Set<string>();
  const add = (raw: string): void => {
    const t = String(raw ?? '').trim();
    if (t.length < 2 || t.length > 24) return;
    if (GENERIC_TERMS.has(t)) return;
    out.add(t);
  };
  const pack = parseDomainPackJson(packJson);
  if (pack) {
    for (const t of pack.business?.terms ?? []) {
      add(t.term);
      for (const a of t.aliases ?? []) add(a);
    }
    // 三节里的"术语：释义"行（只取冒号前的词；不接受整句）
    for (const s of pack.sections) {
      if (s.section !== 'domain') continue;
      for (const line of s.content.split('\n')) {
        const m = /^\s*(?:[-*•]|\d+[.、])?\s*([^\s：:，。；、（）()]{2,24})\s*[：:]/.exec(line);
        if (m?.[1]) add(m[1]);
      }
    }
  }
  // 包名去掉"· 领域包"后缀（如「A股智能投资顾问」）
  add(packName.replace(/[·\s]*领域包\s*$/, ''));
  return [...out];
}

/**
 * 给一个任务题面挑 ≤limit 个**有词条命中**的候选领域包。只读、零 LLM、确定性。
 * 排序：命中词条多者先；同分按既有相似度；再按 id（跨机同序）。
 */
export function suggestDomainPacksForTask(
  db: SuggestDb,
  projectId: string,
  taskText: string,
  limit = 2,
): DomainPackTaskSuggestion[] {
  const pid = String(projectId ?? '').trim();
  const text = String(taskText ?? '').toLowerCase();
  if (!pid || text.trim().length === 0) return [];
  const lim = Math.max(1, Math.floor(Number(limit) || 2));
  let rows: DomainPackListRow[];
  try {
    rows = listSuggestedDomainPacks(db, pid, 20, { withPackJson: true });
  } catch {
    return [];
  }
  const scored: DomainPackTaskSuggestion[] = [];
  for (const r of rows) {
    const terms = collectTerms(String(r.pack_json ?? ''), r.name);
    const hits = terms.filter((t) => text.includes(t.toLowerCase()));
    if (hits.length === 0) continue;
    scored.push({
      id: r.id,
      name: r.name,
      hits: [...new Set(hits)].slice(0, 5),
      ...(r.similarity ? { similarity: { score: r.similarity.score, reasons: r.similarity.reasons } } : {}),
    });
  }
  scored.sort(
    (a, b) =>
      b.hits.length - a.hits.length
      || (b.similarity?.score ?? -1) - (a.similarity?.score ?? -1)
      || a.id.localeCompare(b.id),
  );
  return scored.slice(0, lim);
}
