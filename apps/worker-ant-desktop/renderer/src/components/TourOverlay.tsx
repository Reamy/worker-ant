/**
 * zx_20261013_1 批三「称引于人」——首启**一次性**导览浮层（非阻塞、可跳过）。
 *
 * 与 `SetupPage` 的关系是**不同物、不重复**：`SetupPage` 是**唯一阻塞向导**（装／凭据／模型），
 * 本层是它**之后**的**后置**地图——只在 Dashboard 首访弹一次，看不懂也不挡路。
 *
 * 词表**从导航配置派生**（`tourEntries()`，凡带 `tour` 者），本组件不持入口清单、不写一行导航文案——
 * 想改导览说辞，去 `navConfig.ts` 的 `tour` 字段改一处。
 *
 * 状态**不在此落库**：完成由调用方写 `TOUR_SETTING_KEY`，跳过由调用方走会话级软跳过——
 * 本组件只负责"走一遍 → 回调"（一处写口，便于核查）。
 */
import { useEffect, useLayoutEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { tourEntries, type TourEntry } from '../lib/navConfig';

// 词表是**静态**导航配置 ⇒ 模块级求值一次即可（不在 render 里反复派生出新数组）。
const STEPS: TourEntry[] = tourEntries();

interface Rect { top: number; left: number; width: number; height: number }

/** 测量被高亮入口的实框（侧栏 NavLink 带 `data-tour="<to>"`；测不到就给 null，卡片依旧可走完）。 */
function measure(to: string): Rect | null {
  try {
    const el = document.querySelector(`[data-tour="${to}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  } catch { return null; }
}

export default function TourOverlay({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const step: TourEntry | undefined = STEPS[i];
  const last = i >= STEPS.length - 1;

  // 步进/尺寸变化时重新测框（ResizeObserver 太沉；resize 事件足够覆盖"窗口变了"）。
  useLayoutEffect(() => { if (step) setRect(measure(step.to)); }, [step?.to]);
  useEffect(() => {
    const onResize = () => { if (step) setRect(measure(step.to)); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [step?.to]);

  // Esc = 跳过（会话级，不落库）——与「跳过」按钮同义。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onSkip(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSkip]);

  if (!step) return null;

  // 卡片贴着侧栏右侧（侧栏 `w-56`＝224px），纵向对齐被高亮项并夹在视口内。
  const cardTop = rect ? Math.min(Math.max(rect.top - 8, 72), window.innerHeight - 220) : 120;

  return (
    <div className="fixed inset-0 z-[60]">
      {/* 高亮环：`box-shadow` 铺满四周做遮罩，环内即"聚光灯"（无需 SVG 挖洞）。 */}
      {rect ? (
        <div className="pointer-events-none fixed z-[61] rounded-md ring-2 ring-blue-500 transition-all"
          style={{
            top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
          }} />
      ) : (
        <div className="absolute inset-0 bg-black/45" />
      )}

      <div className="fixed z-[62] w-[360px] rounded-xl bg-white shadow-2xl border border-gray-200 p-4"
        style={{ left: 248, top: cardTop }}>
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold text-blue-600 uppercase tracking-wider">
              功能导览 · {i + 1}/{STEPS.length}
            </p>
            <h3 className="text-base font-bold text-gray-800 truncate">{step.label}</h3>
          </div>
          <button type="button" onClick={onSkip} title="跳过（本次会话不再提示）"
            className="shrink-0 p-1 -m-1 text-gray-400 hover:text-gray-700"><X className="w-4 h-4" /></button>
        </div>

        <p className="text-sm text-gray-600 leading-relaxed mb-4 min-h-[40px]">{step.tour}</p>

        {/* 进度点：一眼看出"走到哪、还剩几步"（不是必需，但没有它用户不知何时结束）。 */}
        <div className="flex items-center gap-1 mb-3">
          {STEPS.map((s, k) => (
            <span key={s.to} className={`h-1.5 rounded-full transition-all ${k === i ? 'w-4 bg-blue-500' : 'w-1.5 bg-gray-200'}`} />
          ))}
        </div>

        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={onSkip} className="text-xs text-gray-500 hover:text-gray-800">跳过</button>
          <div className="flex items-center gap-2">
            <button type="button" disabled={i === 0} onClick={() => setI((v) => Math.max(0, v - 1))}
              className="flex items-center gap-1 px-3 py-1.5 text-sm rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">
              <ChevronLeft className="w-3.5 h-3.5" />上一步
            </button>
            <button type="button" onClick={() => (last ? onDone() : setI((v) => v + 1))}
              className="flex items-center gap-1 px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700">
              {last ? '开始使用' : '下一步'}<ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
