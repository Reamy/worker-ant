/**
 * zx_20260906 批3 (3b): 简化行级 diff——公共前缀/后缀裁剪后，中间"删旧增新"呈现（O(n)，供版本前后对比）。
 * zx_20260909 X1(维特根斯坦·可判定): 抽为共享工具——产出物页版本弹窗与"就地成果抽屉"同源复用，防双实现漂移。
 */
export interface DiffLine { type: 'same' | 'add' | 'del'; line: string }

export function simpleLineDiff(a: string, b: string): DiffLine[] {
  const A = (a || '').split('\n');
  const B = (b || '').split('\n');
  if (A[A.length - 1] === '') A.pop();
  if (B[B.length - 1] === '') B.pop();
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let eA = A.length; let eB = B.length;
  while (eA > s && eB > s && A[eA - 1] === B[eB - 1]) { eA--; eB--; }
  const out: DiffLine[] = [];
  for (let i = 0; i < s; i++) out.push({ type: 'same', line: A[i]! });
  for (let i = s; i < eA; i++) out.push({ type: 'del', line: A[i]! });
  for (let i = s; i < eB; i++) out.push({ type: 'add', line: B[i]! });
  for (let i = eA; i < A.length; i++) out.push({ type: 'same', line: A[i]! });
  return out;
}
