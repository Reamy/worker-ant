/**
 * zx_20261014_1 批一/批三（道德经·名可名非常名 / 维特根斯坦·意义即用法）:
 * **设备"叫什么"的单一真源**——两处都要这条规则：主进程（按名列候选、写提示语）与
 * 渲染层（设备行主标题、控制留痕）。若各写一份，改名后就会出现"面板叫 A、留痕叫 B"。
 *
 * ⚠ 本文件**零依赖**（不引 node: / 不引 electron）——故渲染层可**运行期 import**它
 *   （同 `im-media-view.ts` / `deliverable-types.ts` 范式）。`device-registry.ts` 因引 `node:crypto`
 *   不可被渲染层运行期 import，这正是不把本函数放进那里的原因。
 */

/**
 * 我们**叫它什么**：用户起的别名优先，无别名则用设备自述名。
 * 注意与"设备的自称"（`name`）是两件事——`name` 每次发现会被覆写，`alias` 不会。
 */
export function deviceCallName(dev: { name: string; alias?: string | null }): string {
  return (dev.alias ?? '').trim() || dev.name;
}
