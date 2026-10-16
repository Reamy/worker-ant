/**
 * 插件依赖解析器。
 * 拓扑排序 + 循环检测 + 传递闭包。
 */
import type Database from 'better-sqlite3';

export interface DepResult {
  resolved: string[]; // 拓扑排序后的安装顺序
  missing: string[]; // 缺失的依赖
  cycle: boolean; // 是否有循环依赖
}

/** 解析插件传递闭包，按拓扑排序返回安装顺序 */
export function resolveDependencies(
  db: Database.Database,
  pluginIds: string[],
  getDeps: (id: string) => string[],
): DepResult {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];
  const missing: string[] = [];
  let cycle = false;

  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      cycle = true;
      return;
    }
    visiting.add(id);
    for (const dep of getDeps(id)) {
      const depPlugin = db.prepare('SELECT id FROM ans_plugins WHERE name = ? AND status = ?').get(dep, 'active') as
        | { id: string }
        | undefined;
      if (depPlugin) {
        visit(depPlugin.id);
      } else {
        missing.push(dep);
      }
    }
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }

  for (const id of pluginIds) visit(id);
  return { resolved: order, missing: [...new Set(missing)], cycle };
}
