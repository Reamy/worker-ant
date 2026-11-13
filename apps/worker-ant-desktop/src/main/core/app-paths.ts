/**
 * 「打包版的数据根在哪」——**一处真源**（日志目录 / 通知目录的兜底共用）。
 *
 * 病根：打包版由 Finder 启动时 cwd 是 `/`，一切按 `process.cwd()` 上溯 `../../data` 的写法
 *   都会落到 `/data`（创建不了）。实测：pino-roll 的 worker 起不来，主进程此后每条日志
 *   都重复抛 `ENOENT: mkdir '/data'`，退出时 `flushSync` 也一并失败。
 *
 * 真源与 `main/index.ts` 的 `dataDir` **同源**：Electron `app.getPath('userData')`。
 *   延迟 `require('electron')`：本模块也被 rr/tsx（非 Electron）加载，那里的 `electron`
 *   解析成可执行文件路径字符串、取不到 `app` ⇒ 返回 null，调用方回落 dev 布局（仓库 `data/`）。
 */
export function packagedUserDataDir(): string | null {
  try {
    // zx_20261110_2 B7: `node:module` **不得**顶层 import。本模块会随跨 root 引用链被 renderer 打包
    //   （`renderer → … → logger.ts → app-paths.ts`），Vite 把 `node:module` 外部化成浏览器空壳，
    //   rollup 在绑定 `createRequire` 时整包报错——renderer 构建因此失败（与"打包版数据根"这功能无关的连带伤）。
    //   改用运行时取内置模块（Node ≥ 20.16 / Electron 33 都有）；浏览器/无 process 环境拿不到 ⇒ null，
    //   语义仍是"不是打包版"，调用方照旧回落 dev 布局。
    if (typeof process === 'undefined' || typeof process.getBuiltinModule !== 'function') return null;
    const mod = process.getBuiltinModule('module') as
      { createRequire?: (filename: string) => (id: string) => unknown } | undefined;
    const createRequire = mod?.createRequire;
    if (!createRequire) return null;
    const electron = createRequire(import.meta.url)('electron') as
      { app?: { isPackaged?: boolean; getPath(name: string): string } };
    const app = electron?.app;
    if (app?.isPackaged) return app.getPath('userData');
  } catch { /* 非 Electron 运行环境 */ }
  return null;
}
