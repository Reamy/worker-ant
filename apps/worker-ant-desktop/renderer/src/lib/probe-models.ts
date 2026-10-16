/**
 * zx_20261009 M5（维特根斯坦·意义即使用）：「服务可达」之后**三件事要分家说**，不能合成一句——
 *   ① 读得到 N 个模型（N>0）                    ⇒ 绿
 *   ② 可达但**读不动**（401 未认证 / 其它错）   ⇒ 说清"未认证（凭据不被认）"或"读失败"
 *   ③ 可达、读得到、**确实 0 个**               ⇒ 才说"请在 ANS 中配置模型"
 * 旧实现把 ② 与 ③ 合并成"服务可达，但尚无可用模型" ⇒ **401 被说成"没配模型"**（名实不符）。
 *
 * zx_20261010 M3（《论语·子路》名不正则言不顺 + 毛《矛盾论》主次矛盾）：「已接入 N 个模型」的 N
 *   长期取的是**目录条数**（`GET /api/v1/models` 不按可用性过滤，返回全部 `status!='disabled'` 行；
 *   干净 ANS 从 `recommended-models.json` 播种恰 41 条），**零端点也亮绿** ⇒ 用户读成"41 个能用"。
 *   此处改由**可用条数**（`available`）与**两个独立前提**（chat 跑成果 / embedding 喂记忆）分列，
 *   `ok` 取 `hasChat`——本页答的是"**这台机器跑起来没有**"，跑得起来须有可用 chat 模型。
 *
 * zx_20261011_5：`ModelsRead`/`ModelsProbe` 类型**上移 main**（`core/model-availability.ts` 的
 *   `ModelsRead`/`ModelProbe`）——类型一处真源，本文件只留**渲染层专属**的 `probeModelsLine`（用户可见文案）。
 *   独立成**无 React 依赖**的模块：判据可直接调它（G-1「判据一律调生产导出」）。
 */
import type { ModelsRead, ModelProbe } from '../../../src/main/core/model-availability.js';

export type { ModelsRead };
/** 探针形状 = main 的 `ModelProbe`（`read` + `note` + 四数），此处只换名以便渲染层沿用旧称。 */
export type ModelsProbe = ModelProbe;

export function probeModelsLine(p: ModelsProbe): { ok: boolean; text: string } {
  if (p.read === 'auth') {
    return { ok: false, text: '服务可达，但本机 ANS 未认此凭据（401 未认证）。dev：请先 cp .env.example .env 再重启 ANS；生产：在 ANS 中登记该 API Key 与 Secret。' };
  }
  if (p.read === 'error') {
    return { ok: false, text: `服务可达，但读取模型列表失败：${p.note}` };
  }
  if (p.catalog === 0) {
    return { ok: false, text: '服务可达，但 ANS 中尚无可用模型（请在 ANS 中配置模型后再试）。' };
  }
  if (p.available === 0) {
    return { ok: false, text: `服务可达，目录有 ${p.catalog} 个模型，但无一个配置了可用端点——请为至少一个 chat 模型配置端点与 Key。` };
  }
  const tail = p.catalog > p.available ? `（目录另有 ${p.catalog - p.available} 条未配端点）` : '';
  const chat = p.hasChat ? 'chat 已就位（可跑成果）' : '缺可用 chat 模型（跑不出成果）';
  const emb = p.hasEmbedding ? 'embedding 已就位（记忆向量）' : '缺可用 embedding 模型（记忆向量暂不可用）';
  return { ok: p.hasChat, text: `已接入 ${p.available} 个可用模型${tail}；${chat}；${emb}。` };
}
