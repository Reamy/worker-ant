/**
 * zx_20261107_1 B4「信」: **注入来源词表**——`wa_context_injections.source` 的取值与人话名，只此一处。
 *
 * 写口（`memory-manager.ts` 的 `recordContextInjections`）与读口（`memory-injection-stats.ts`）
 * 同引本模块；界面拿到的行自带 `label`，不在 renderer 再抄一份中文名（承「枚举第二落点」教训）。
 *
 * ⚠ 新增来源＝两步：此处加一项（编译期迫使 `INJECTION_SOURCE_LABEL` 补齐）+ 写口真有用例。
 *   读口对**词表外**的旧值不丢弃，如实以原始 `source` 上屏（不把历史行藏起来）。
 * 零依赖（rr 直跑、渲染层可 import 标签）。
 */

export const INJECTION_SOURCES = [
  'memory',
  'knowledge',
  'knowledge_card',
  'domain_pack',
  'project_profile',
  // zx_20261113_1 B3「用」：岗位块（说明/规范/技能/知识/可迁移经验）逐条一行。
  'position',
] as const;

export type InjectionSource = (typeof INJECTION_SOURCES)[number];

/** 写口用的常量（避免各处手抄字符串；键名即语义）。 */
export const INJECTION_SOURCE = {
  memory: 'memory',
  knowledge: 'knowledge',
  knowledgeCard: 'knowledge_card',
  domainPack: 'domain_pack',
  projectProfile: 'project_profile',
  position: 'position',
} as const satisfies Record<string, InjectionSource>;

export const INJECTION_SOURCE_LABEL: Record<InjectionSource, string> = {
  memory: '记忆',
  knowledge: '项目知识',
  knowledge_card: '知识卡',
  domain_pack: '领域包',
  project_profile: '项目画像',
  position: '岗位',
};

/** 词表外的历史值如实显示原键（不猜、不丢）。 */
export function injectionSourceLabel(source: string): string {
  return (INJECTION_SOURCE_LABEL as Record<string, string>)[source] ?? source;
}
