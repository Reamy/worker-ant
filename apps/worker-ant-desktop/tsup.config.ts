import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { 'main/index': 'src/main/index.ts' },
    outDir: 'dist',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    clean: true,
    // `mqtt` 须 external：`device-mqtt.ts` 用**惰性** `import('mqtt')` 才「不装客户端也照跑、
    // 真连接只在用时建立」；若被 esbuild 打进静态 chunk（实测 514KB 随 `device-mqtt` 的静态可达性
    // 一起被 eager 加载），惰性即失效。external 后 dist 里保留运行时动态 import，同 `bonjour-service`/`node-ssdp`。
    external: ['electron', 'electron-updater', '@worker-ant/ans-client', '@worker-ant/shared-types', 'better-sqlite3', 'bcrypt', 'jose', 'node-cron', 'pino', 'pino-pretty', 'pino-roll', 'ai', '@ai-sdk/openai', 'mqtt'],
  },
  {
    entry: { 'preload/index': 'src/preload/index.ts' },
    outDir: 'dist',
    format: 'cjs',
    outExtension: () => ({ js: '.js' }), // 强制 .js 扩展名（Electron 加载 preload 按路径匹配）
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    external: ['electron'],
  },
]);
