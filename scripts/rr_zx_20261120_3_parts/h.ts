/**
 * zx_20261120_3 H 组「传·见」——项目详情「岗位」页签。
 *
 * 归属：M8。断言口径：
 *   · 页签在册（activeTab 联合类型 + 按钮）；
 *   · 预演与执行期**同一构造**（`positionBlockDetail` + `selectPositionLessonsForInjection`），不另写一份；
 *   · 沉淀只走 `positions:captureProjectKnowledge`；两类空态如实。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { RrHarness } from '../rr_zx_20261120_3.js';
import { stripKeepingLines } from '../lib/rr-pins.js';

export function runH(h: RrHarness): void {
  const root = h.root;
  const read = (rel: string): string => stripKeepingLines(fs.readFileSync(path.join(root, rel), 'utf-8')).join('\n');

  // ── H1 页签在册 ───────────────────────────────────────────────────────
  const ui = read('apps/worker-ant-desktop/renderer/src/pages/ProjectDetailPage.tsx');
  h.ok(/'positions'/.test(ui) && ui.includes("l:'岗位'"), 'H1 activeTab 联合类型与页签按钮在册');
  h.ok(ui.includes("activeTab === 'positions'"), 'H1 页签渲染块在册');

  // ── H2 预演与执行期同一构造 ───────────────────────────────────────────
  const ipc = read('apps/worker-ant-desktop/src/main/ipc/positions.ipc.ts');
  h.ok(ipc.includes('selectPositionLessonsForInjection(db, id, undefined, query)')
    && ipc.includes('positionBlockDetail(position, lessons, undefined, approvedPositionSkillNames(db, id))'),
    'H2 预演复用生产构造（不另写一份）');
  h.ok(ui.includes('positionsApi.injectPreview('), 'H2 界面调预演出口');

  // ── H3 项目知识沉淀接线 ───────────────────────────────────────────────
  h.ok(ui.includes('positionsApi.captureProjectKnowledge('), 'H3 沉淀按钮走唯一出口');
  h.ok(ui.includes("['recipes', 'criteria', 'domain']"), 'H3 只列可迁移三节');
  h.ok(ui.includes('待审候选') || ui.includes('待审'), 'H3 回执说明落候选');
  h.ok(ui.includes('项目知识以项目为中心'), 'H3 首行说清两条知识线');

  // ── H4 空态如实 ───────────────────────────────────────────────────────
  h.ok(ui.includes('本项目还没有启用岗位'), 'H4 无岗位空态');
  h.ok(ui.includes('尚未派生可迁移知识'), 'H4 无知识空态');

  // ── H5 预演只读（不写注入账） ─────────────────────────────────────────
  const handlerStart = ipc.indexOf("positions:injectPreview");
  const handlerEnd = ipc.indexOf("positions:captureProjectKnowledge", handlerStart);
  const handler = handlerStart >= 0 ? ipc.slice(handlerStart, handlerEnd > handlerStart ? handlerEnd : handlerStart + 2000) : '';
  h.ok(handler.length > 0 && !handler.includes('recordContextInjections') && !handler.includes('wa_context_injections'),
    'H5 预演不写注入账');
}
