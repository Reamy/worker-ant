/**
 * zx_20261107_1 B9（庄子·庖丁解牛）：任务预算 + 上下文编辑块。
 *
 * 从 TaskDetailPage 抽出——数字全部由页面算好传入（实时 token、带位、费用闸因由），
 * 本组件只负责摆与编辑表单；预算带质变点脉冲（`budgetFlash`）的判据仍在页面。
 */
import { TrendingUp, Edit, Check } from 'lucide-react';
import type { TaskArchetype } from '../../../../src/main/core/task-archetype.js';
import { formatTokens, formatMoney } from '../../lib/format';

export interface TaskCostEstimateView {
  cost?: number;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  sideTokens?: number;
}

export interface TaskCtxForm {
  max_tokens_per_task: string;
  max_cost_usd_per_task: string;
}

export default function TaskCost({
  displayTokens,
  effectiveBudget,
  effBudgetTok,
  budgetFlash,
  curBand,
  curRatio,
  executingNow,
  costUsed,
  costMax,
  costUsageRatio,
  costBand,
  costSrcLabel,
  costNoCapKnown,
  costGateReason,
  costEstimate,
  showContext,
  onToggleContext,
  ctxForm,
  setCtxForm,
  onSaveContext,
  archetypeOverride,
  onArchetypeOverride,
  archetypeOptions,
}: {
  displayTokens: number;
  effectiveBudget: number | undefined;
  effBudgetTok: number;
  budgetFlash: string | null;
  curBand: number;
  curRatio: number | null;
  executingNow: boolean;
  costUsed: number | undefined;
  costMax: number | undefined;
  costUsageRatio: number | undefined;
  costBand: number;
  costSrcLabel: string;
  costNoCapKnown: boolean;
  costGateReason: 'active' | 'no_cap' | 'no_price' | undefined;
  costEstimate: TaskCostEstimateView | undefined;
  showContext: boolean;
  onToggleContext: () => void;
  ctxForm: TaskCtxForm;
  setCtxForm: (v: TaskCtxForm) => void;
  onSaveContext: () => void;
  archetypeOverride: string;
  onArchetypeOverride: (next: string) => void;
  archetypeOptions: Array<{ value: TaskArchetype; label: string }>;
}) {
  return (
    <div className="bg-white rounded-lg border p-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="font-medium text-sm flex items-center gap-1"><TrendingUp className="w-4 h-4 text-orange-500" />任务预算</h4>
        <button onClick={onToggleContext} className="text-xs text-blue-500 hover:text-blue-700"><Edit className="w-3.5 h-3.5 inline" /> 编辑</button>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="bg-gray-50 rounded p-2">
          <p className="text-xs text-gray-400">消耗 / 预算 (tokens){executingNow ? ' · 实时' : ''}</p>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-lg font-bold text-blue-600">{formatTokens(displayTokens)}</span>
            <span className="text-xs text-gray-400">/ {effectiveBudget ? formatTokens(effectiveBudget) : (ctxForm.max_tokens_per_task ? formatTokens(Number(ctxForm.max_tokens_per_task)) : '未设置')}</span>
          </div>
          {effBudgetTok > 0 && (
            <div>
              {/* E1 (2026-09-04_2): band 越界即质变点脉冲气泡 */}
              {budgetFlash && <p className="mt-1 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">{budgetFlash}</p>}
              <div className="mt-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-all ${curBand >= 5 ? 'bg-red-500 animate-pulse' : curBand === 4 ? 'bg-orange-500' : curBand === 3 ? 'bg-yellow-500' : curBand >= 2 ? 'bg-amber-400' : 'bg-blue-500'}`}
                  style={{ width: `${Math.min(100, (curRatio ?? 0) * 100)}%` }} />
              </div>
              <div className="relative mt-0.5 h-3 text-[9px] text-gray-400 select-none">
                <span className="absolute left-[60%] -translate-x-1/2">|60%</span>
                <span className="absolute left-[75%] -translate-x-1/2">|75%</span>
                <span className="absolute left-[95%] -translate-x-1/2">|95%</span>
              </div>
            </div>
          )}
        </div>
        <div className="bg-gray-50 rounded p-2">
          <p className="text-xs text-gray-400">费用（¥ 人民币）{costMax != null && costMax > 0 ? '· 已用/上限' : '· 已花费'}</p>
          <div className="flex items-baseline gap-1 mt-1 flex-wrap">
            <span className="text-lg font-bold text-green-600">{costUsed != null ? formatMoney(costUsed, { digits: 4 }) : (costEstimate?.cost != null ? formatMoney(costEstimate.cost, { digits: 6 }) : '未收口计账')}</span>
            {costMax != null && costMax > 0 ? (
              <span className="text-xs text-gray-400">/ {formatMoney(costMax, { digits: 2 })}{costSrcLabel}</span>
            ) : ctxForm.max_cost_usd_per_task ? (
              <span className="text-xs text-gray-400">/ ¥${ctxForm.max_cost_usd_per_task}</span>
            ) : costNoCapKnown ? (
              <span className="text-xs text-gray-400">（未设置金额上限，仅 Token 闸）</span>
            ) : null}
          </div>
          {costMax != null && costMax > 0 && costUsageRatio != null && (
            <div className="mt-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-all ${costBand >= 5 ? 'bg-red-500 animate-pulse' : costBand === 4 ? 'bg-orange-500' : costBand === 3 ? 'bg-yellow-500' : costBand >= 2 ? 'bg-amber-400' : 'bg-green-500'}`}
                style={{ width: `${Math.min(100, costUsageRatio * 100)}%` }} />
            </div>
          )}
          {costGateReason === 'no_price' && (
            <p className="text-[10px] text-amber-600 mt-0.5">费用闸未生效：所选模型未配置单价，费用无法计量（仅 Token 闸生效）。可在「模型管理」为该模型配置单价。</p>
          )}
          {costGateReason === 'no_cap' && costUsed != null && (
            <p className="text-[10px] text-gray-500 mt-0.5">本任务未设金额上限：费用照常累计，仅按 Token 预算收敛。如需金额硬闸，可在下方「费用预算」填写。</p>
          )}
          {costEstimate?.model && <p className="text-[10px] text-gray-400 mt-0.5">模型: {costEstimate.model} · 输入{formatTokens(costEstimate.inputTokens || 0)}/输出{formatTokens(costEstimate.outputTokens || 0)}</p>}
        </div>
      </div>
      {showContext && (
        <div className="mt-3 pt-3 border-t space-y-2">
          {/* zx_20261030_2 M7: 形态手动覆盖（六档 + 按默认）；只影响下一次运行 */}
          <div>
            <label className="text-xs font-medium">执行形态（覆盖）</label>
            <select
              value={archetypeOverride}
              onChange={(e) => { void onArchetypeOverride(e.target.value); }}
              className="w-full px-2 py-1 border rounded text-xs mt-0.5 bg-white"
            >
              <option value="">按默认（自动判定）</option>
              {archetypeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <p className="text-[10px] text-gray-500 mt-0.5">仅对下一次运行生效，不影响本轮已落的账。</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div><label className="text-xs font-medium">Token 预算</label><input type="number" value={ctxForm.max_tokens_per_task} onChange={e => setCtxForm({ ...ctxForm, max_tokens_per_task: e.target.value })} className="w-full px-2 py-1 border rounded text-xs mt-0.5" placeholder="如 100000" /></div>
            <div><label className="text-xs font-medium">费用预算（¥ 人民币/任务）</label><input type="number" step="0.01" value={ctxForm.max_cost_usd_per_task} onChange={e => setCtxForm({ ...ctxForm, max_cost_usd_per_task: e.target.value })} className="w-full px-2 py-1 border rounded text-xs mt-0.5" placeholder="留空 = 不设金额闸" /></div>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => onToggleContext()} className="px-2 py-1 border rounded text-xs hover:bg-gray-50">取消</button>
            <button onClick={onSaveContext} className="px-2 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700"><Check className="w-3 h-3 inline" /> 保存</button>
          </div>
        </div>
      )}
    </div>
  );
}
