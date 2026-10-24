import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { DeliverableDrawer } from '../components/DeliverableDrawer';

/**
 * zx_20260909 X1(黑格尔·部分在整体中成其自身): 「就地成果详情抽屉」全局轻状态。
 * 任意入口(deliverables 行/交付单 primary·verified/项目最近产出物/任务详情 doc/CommandPalette)调 open(id) 即就地展开该 doc
 * 的 状态/★主/验收/版本流+diff/溯源(任务·里程碑)/预览 —— 不再"点 doc 只能跳任务页再找"(消三跳)。
 * 不做独立路由(用户选定"就地抽屉")；由调用方按 deliverable.doc_drawer 门控是否触发。
 */
export interface DeliverableDrawerApi { open: (id: string) => void }

const DeliverableDrawerContext = createContext<DeliverableDrawerApi | null>(null);

export function DeliverableDrawerProvider({ children }: { children: React.ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = useCallback((id: string) => setOpenId(id), []);
  const value = useMemo(() => ({ open }), [open]);
  return (
    <DeliverableDrawerContext.Provider value={value}>
      {children}
      <DeliverableDrawer id={openId} onClose={() => setOpenId(null)} />
    </DeliverableDrawerContext.Provider>
  );
}

export function useDeliverableDrawer(): DeliverableDrawerApi {
  const ctx = useContext(DeliverableDrawerContext);
  if (!ctx) throw new Error('useDeliverableDrawer 必须在 <DeliverableDrawerProvider> 内使用');
  return ctx;
}
