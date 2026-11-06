/**
 * zx_20261003 M3（维特根斯坦·一个词一个用法）: **读盘上头部若干字节**——"看一眼头"这件事的**唯一实现**。
 *
 * 病根：装配层（`attachment-inline.ts` 的 `defaultIo.readHead`）与选型层（`exec-model-select.ts` 选型前
 * 判族要不要 `vision`）都要"读前 N 字节喂魔数嗅探"。若各写一份 `openSync/readSync`，就是
 * 「同一条规则的第二、第三次实现」——更要命的是，判族的**嗅探口**必须与装配层读的是**同一种字节**，
 * 否则两处对同一件东西会得出不同的族（这正是 M3 病根本身：选型退扩展名、装配看魔数，两把尺）。
 * 故把这段读盘**收成一处**，两侧都引它。
 *
 * ⚠ 与 `attachment-kinds.ts` 的分工：那里是**纯函数**嗅探（零 import，能被 renderer 引），
 *   本模块**只读盘**（`node:fs`），是**注入品**——喂给 `InlineIo.readHead` 或选型层。
 *   判族逻辑一行都不在这里。
 */
import fs from 'node:fs';

/**
 * 读 `p` 的**前 n 字节**。读不到（不存在 / 无权限 / 空文件）一律返回 `null`——
 * **不抛**：嗅探失败是**降级**（落回扩展名判族），不该把装配或选型搞挂。
 *
 * `Buffer.alloc`（非 `allocUnsafe`）零填充：短读时尾部那几格必须是"确定没有字节"，
 * 不能是上一段内存的残留（那会让嗅探**随机**命中）。
 */
export function readHeadFromFile(p: string, n: number): Uint8Array | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(n);
    const got = fs.readSync(fd, b, 0, n, 0);
    return got > 0 ? b.subarray(0, got) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已经关了 */ } }
  }
}
