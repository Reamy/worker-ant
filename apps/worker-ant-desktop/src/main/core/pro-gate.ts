/**
 * zx_20261018_1 批八（管子·度量衡 / 维特根斯坦·一个规则一处）: **Pro 档能力软闸的唯一判据**。
 *
 * 病根：`pricing.ts` 早已把「项目知识包」写进专业版卖点，`business-plan/license-tiers.md` 也写了同一行，
 *   但**代码里没有任何闸**——社区档照样能导出整册 JSONL。价格表说"这是 Pro 的能力"，
 *   执行面却说"谁都能用"：两把尺量同一件事（承 `feedback_predicate_needs_both_sides_specimen`
 *   的反向：**卖点若无人兑现，就是虚名**）。
 *
 * 一处真源（同 `team-gate.ts` 范式）：判据只此一处——`knowledge-export.ts` 的导出编排只调它，
 *   IPC 不另写档位判断；新增 Pro 能力时**先在此登记**，再穷举接线与面板。
 *
 * ⚠ **软闸（K-3）**：锁定**不删数据、不拦在跑**，只是**该能力不可用**（产品照常可用，fail-open 方向——
 *   判库读不到 ⇒ community ⇒ 锁，但**产品本身**不崩，预览/注入等核心任务路不受影响）。
 * ⚠ **解锁档位＝Pro 及以上**；**试用期内也放行**（试用＝专业版能力）。试用态 `tier` 落 `pro`，
 *   判据仍**特判 `kind === 'trial'`**——与 `team-gate.ts` 同一写法，免得将来试用态换档位语义时两处漂移。
 * ⚠ 零 electron 依赖（只用一个最小 db 接口）——rr 直跑真判据；`now`/`fingerprint` 可注入（不依赖墙钟）。
 */
import { type LicenseTier } from './feature-limits.js';
import { resolveLicenseState, type LicenseSettingDb, type LicenseState, type ResolveLicenseOpts } from './license.js';

/**
 * Pro 档能力词表（**唯一定义处**；新增一项须穷举接线 + 面板）。
 * `knowledge_export` 的接线：`core/knowledge-export.ts`（导出编排）· `ipc/knowledge.ipc.ts`（通道壳）。
 * `image_vision`（zx_20261018_2 批一）的接线：`core/tools/media.ts` 的 `view_image`（子调用编排）·
 *   `agent-executor.ts` 的 `buildTools`（注入 `describeImage`）。**社区档仍看到元数据**，
 *   只是不发起视觉子调用——软闸的边界是"这一跳不可用"，不是"这张图看不了"。
 * `long_video`（zx_20261018_2 批二）的接线：`agent-executor.ts` 装配附件时把
 *   `proFeatureRefusal(db,'long_video') === null` 作 `longVideo` 交下去 → `attachment-inline.ts`
 *   转成抽帧选项 `fullCoverage`。**社区档仍内联音轨 + 前 720s 画面**，只是不摊到全片。
 * `domain_pack`（zx_20261021_3 批一）的接线：`core/domain-pack.ts` 的 `createDomainPack` / `applyDomainPack`
 *   两个动作口——生成与应用都过闸；**已应用的领域包在执行期照常注入**（不因降档而抹掉已注入的知识）。
 * `long_document`（zx_20261018_3 批六）的接线：`core/tools/media.ts` 的 `read_document` 编排口——
 *   请求"第 21 页起"或"单次 >20 页"时才过闸。**社区档仍读前 20 页**；闸只挡**越界的那次请求**，
 *   不挡阅读本身（否则同一份文档在社区档会连前 20 页也读不到）。
 * `knowledge_import`（zx_20261022_3 批七）的接线：`core/knowledge-import.ts` 的
 *   `importKnowledgeForProject`（导入动作口）。**已导入知识的执行期注入不挂闸**——与导出/领域包同一把尺：
 *   闸只挡"搬运"，不挡"使用"（否则降档会把已经带进来的知识也废掉）。
 * `knowledge_cards`（zx_20261023_5 批二）的接线：`core/knowledge-cards.ts` 的 `distillKnowledgeCards`
 *   与 `recordPitfallCandidate`（生成动作口）· `MemoryManager.listKnowledgeCards`（执行期注入口）。
 *   **降档不回收已生成的卡**：卡留在表里，只是当前档位不再注入——与领域包同一把尺。
 */
export const PRO_FEATURES = ['knowledge_export', 'knowledge_import', 'image_vision', 'long_video', 'long_document', 'domain_pack', 'knowledge_cards'] as const;
export type ProFeature = (typeof PRO_FEATURES)[number];

/** 人话能力名（界面/拒因直接上屏用；键类型取 `ProFeature` ⇒ 漏一项是编译期错）。 */
export const PRO_FEATURE_LABEL: Record<ProFeature, string> = {
  // ⚠ 只写"导出"：**预览与执行期注入不挂闸**（社区档照常用）——名实相符，不把整块知识包都圈走。
  knowledge_export: '项目知识包导出',
  // 导入与导出同档：**搬进来**和**搬出去**是同一种能力（"可携带"的两端），不拆成两个卖点。
  knowledge_import: '项目知识包导入',
  // 说清它买到的是什么：**一次视觉模型的二手观察**，不是"把像素塞进主模型上下文"。
  image_vision: '图片内容理解（视觉子调用）',
  // 边界说清：是"8 个采样点摊到全片"，不是"逐帧理解"（§4 挂账：视频全帧/场景切分不做）。
  long_video: '视频全片覆盖（8 帧摊到全片）',
  // 边界说清：是"页窗口"（起始页 + 单次页数），不是 OCR——扫描件仍取不出字（§4 挂账）。
  long_document: '长文档分段阅读（PDF 页窗口）',
  // 边界说清：是"把项目经验装成可携带的包"（生成/应用两跳），不是自动同步——
  //   导入团队共享库**不等于**应用到项目（须显式应用）。
  domain_pack: '领域包（跨项目携带项目经验）',
  // 说清它买到的是什么：**确定性蒸馏的一小把卡**（不是训练出来的小模型），开工前只注入最用得上的几张。
  knowledge_cards: '项目知识卡（蒸馏卡注入）',
};

/** 软闸裁定（界面直接上屏 `detail`；`unlocked` 供动作层放手/拦下）。 */
export interface ProGate {
  unlocked: boolean;
  /** 生效档位（软闸读的就是它） */
  tier: LicenseTier;
  tierLabel: string;
  /** 如实说明：解锁时＝已启用；锁定时＝缺 Pro + 升级指引 */
  detail: string;
}

/**
 * 判据本体的**纯函数形态**：只看生效档位与许可类型，不读库。
 *   `resolveProGate` 真闸与 `tier-catalog.ts` 的对照表**同引这一处**——不各写一份 `||`。
 */
export function proUnlocked(state: Pick<LicenseState, 'tier' | 'kind'>): boolean {
  return state.tier === 'pro' || state.tier === 'team' || state.kind === 'trial';
}

/**
 * Pro 档能力是否已解锁。
 *   解锁 ⇔ 生效档位为 Pro / Team **或** 试用期内（`kind === 'trial'`）。
 *   **不 throw**（承 `resolveLicenseState` 的 fail-open：任何异常都退 community ⇒ 锁定，不是"打不开"）。
 */
export function resolveProGate(db: LicenseSettingDb | null | undefined, opts: ResolveLicenseOpts = {}): ProGate {
  const st = resolveLicenseState(db, opts);
  const unlocked = proUnlocked(st);
  const names = PRO_FEATURES.map((f) => PRO_FEATURE_LABEL[f]).join(' / ');
  return {
    unlocked,
    tier: st.tier,
    tierLabel: st.tierLabel,
    detail: unlocked
      ? `专业版能力已启用（${names}）。`
      : `「${names}」属于专业版能力（当前为${st.tierLabel}）。升级到专业版即可启用。`,
  };
}

/**
 * 某一项 Pro 能力能否使用。
 *   · 返回 `null`  ⇒ **放行**
 *   · 返回字符串   ⇒ **如实拒因**（IPC 直接回给用户，不写"操作失败"四个字了事）
 */
export function proFeatureRefusal(
  db: LicenseSettingDb | null | undefined,
  feature: ProFeature,
  opts: ResolveLicenseOpts = {},
): string | null {
  const gate = resolveProGate(db, opts);
  if (gate.unlocked) return null;
  return `「${PRO_FEATURE_LABEL[feature]}」属于专业版能力（当前为${gate.tierLabel}）。升级到专业版即可启用。`;
}
