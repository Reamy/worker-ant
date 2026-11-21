/**
 * 盘上路径的**真实形态**归一口径（zx_20261118_2 M3「名」）。
 *
 * 为什么单独一格：根围栏（`path-fence.ts`）必须是**零 `node:fs`** 的字符串判据——它被十余个
 * 受控回归直跑，而 `sandbox.ts` 那条链会拖进 pino 的 transport 与日志目录。可"两侧同尺归一"
 * （`/var` ↔ `/private/var`、符号链接指向根外）又离不开 `realpath`。故把这一档单独放在这里：
 * `path-fence` 只做"给定真实路径是否在根内"，取真实路径由本模块负责，两边各自单一。
 *
 * 语义（承 `core/tools/write.ts` 原名实现）：存在 ⇒ `realpathSync`；
 * 不存在 ⇒ 向上找**最近的存在祖先**取 `realpath`，再把剩余段原样拼回。
 * 只对不存在的路径直接 `path.resolve` 会在 macOS 上留下 `/var/...` 与 `/private/var/...` 的前缀差：
 * 根（存在的目录）取真实后是 `/private/var/...`，而候选（尚未落盘）仍是 `/var/...` ⇒ 围栏误判越界。
 * ⚠ 只 realpath **直接父目录**不够：`docs/2026/a.md` 这种一层以上都不存在时父目录也 realpath 失败，
 *   前缀差照样出现（2026-11-18 实测：干净工作目录下 `plans/a.md` 被判成"根外"）。故一路向上。
 *
 * ⚠ 与 `deliverable-path.ts` 的同名私有函数**语义不同**（那份不做祖先兜底，因为它只在文件
 *   确已存在时才判根）。混用会把"尚未落盘的候选"判成根外——不要为了"少一个函数"合并它们。
 */
import fs from 'node:fs';
import path from 'node:path';

export function realOrResolved(p: string): string {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch { /* 不存在：沿祖先取真实前缀 */ }
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur) return abs; // 到文件系统根仍不存在（理论不可达）
    rest.unshift(path.basename(cur));
    try { return path.join(fs.realpathSync(parent), ...rest); } catch { cur = parent; }
  }
}
