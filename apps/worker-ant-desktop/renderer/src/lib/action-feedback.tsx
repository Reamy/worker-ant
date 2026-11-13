/**
 * zx_20261108_1 B5「GUI 交互诚实」：动作反馈的**唯一实现**。
 *
 * 病灶：页面里大量 `try { await invoke(...) } catch {}`——用户点了开关/按钮，写失败
 *   却毫无提示，本地显示仍是"已打开/已保存"，界面与库分家（名实不符）。
 *
 * 治法：动作路径一律经本模块给出**可见**结果；失败时调用方回滚本地乐观值。
 *   不引重依赖：一个内联提示条 + 一条乐观写帮助函数即可（与既有 Tailwind 组件同风格）。
 */
import { useCallback, useState } from 'react';
import { CheckCircle2, AlertTriangle, X } from 'lucide-react';

export interface ActionFeedbackState {
  kind: 'ok' | 'err';
  text: string;
}

/** 把任意抛出物转成一句人话（空的/非 Error 的也不能显示成空白）。 */
export function messageOf(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  const m = (e as { message?: unknown } | null | undefined)?.message;
  if (typeof m === 'string' && m) return m;
  const s = String(e ?? '');
  return s || '（无错误信息）';
}

export function useActionFeedback() {
  const [note, setNote] = useState<ActionFeedbackState | null>(null);
  const fail = useCallback((what: string, e?: unknown) => {
    setNote({ kind: 'err', text: e === undefined ? what : `${what}：${messageOf(e)}` });
  }, []);
  const ok = useCallback((text: string) => setNote({ kind: 'ok', text }), []);
  return { note, setNote, fail, ok };
}

/**
 * 乐观写：先改本地 → 真写 → 失败回滚并给出可见原因。
 * 返回 `undefined` 表示失败（调用方可据此决定是否继续后续刷新）。
 */
export async function optimisticWrite<T>(o: {
  what: string;
  apply: () => void;
  rollback: () => void;
  run: () => Promise<T>;
  onError: (what: string, e: unknown) => void;
}): Promise<T | undefined> {
  o.apply();
  try {
    return await o.run();
  } catch (e) {
    o.rollback();
    o.onError(o.what, e);
    return undefined;
  }
}

/** 动作结果提示条：成功轻提示，失败红底并说明原因（用户可关）。 */
export function ActionFeedback({ note, onClose }: { note: ActionFeedbackState | null; onClose: () => void }) {
  if (!note) return null;
  const ok = note.kind === 'ok';
  return (
    <div
      role="status"
      className={`mb-3 rounded-lg border px-3 py-2 text-xs flex items-start justify-between gap-3 ${
        ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'
      }`}
    >
      <span className="flex items-start gap-1.5">
        {ok ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
        <span>{note.text}</span>
      </span>
      <button type="button" onClick={onClose} className="p-0.5 hover:bg-white/60 rounded shrink-0" title="关闭">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
