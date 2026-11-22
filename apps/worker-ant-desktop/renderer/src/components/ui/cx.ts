/**
 * 原语的类名唯一入口：clsx 拼装 + tailwind-merge 消解冲突。
 *
 * 纪律：页面传入的 className 永远放在最后 —— 覆盖而非叠加；
 * 原语内部不再出现「同一条属性两套写法」（如既写 px-3 又写 px-4）。
 * 依赖 clsx / tailwind-merge 已在 renderer 包内，不新增依赖。
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cx(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
