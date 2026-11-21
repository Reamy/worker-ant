/**
 * zx_20261120_2 「明·通·衡·度·实」受控复跑。
 *
 * 分组（与方案 §3 批次一一对应）：
 *   A「明」暂停横幅与自动续跑一致
 *   B「通」工具拒因给对路
 *   C「衡」探索配额跨恢复一本账
 *   D「度」续额按基础上限线性发放
 *   E「实」收口账纳入真实命令失败
 *   F「证」build 钉与源码形状
 *
 * 纪律（承 CLAUDE.md 与 auto-memory）：
 *   · 直引生产函数 / 真实现（被删/改名即编译期失败）。
 *   · 两侧标本同试；计数器类断言给 0→N 的正面值。
 *   · 断言文案不含失败字形；表结构走生产 `initDatabase`。
 *   · 夹具按生产初始化顺序：先 initDatabase，再插数据行。
 *   · 不以轮次字面量做等值断言；build 钉由 `checkBuildPins` 派生核对。
 *   · 未实施组用 `skip()` 如实标注，不记 pass（占位不是绿灯）。
 *   · 并行实施期：A–E 各自独立文件（`scripts/rr_zx_20261120_2_parts/`），
 *     本文件只做汇总与 F 组，避免同文件并发编辑冲突。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { checkBuildPins, buildNotOlderThan } from './lib/rr-pins.js';
import { initDatabase } from '../apps/worker-ant-desktop/src/main/database.js';
import { runA } from './rr_zx_20261120_2_parts/a.js';
import { runB } from './rr_zx_20261120_2_parts/b.js';
import { runC } from './rr_zx_20261120_2_parts/c.js';
import { runD } from './rr_zx_20261120_2_parts/d.js';
import { runE } from './rr_zx_20261120_2_parts/e.js';

let pass = 0;
let fail = 0;
let skipped = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ok ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}
/** 未实施组的如实占位：不进 pass，也不进 fail。 */
function skip(label: string): void { skipped++; console.log(`  · SKIP ${label}`); }

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const SELF = path.basename(__filename).replace(/\.ts$/, '');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261120-2-'));
let dbSeq = 0;
function mkdb(): Database.Database {
  const db = initDatabase(path.join(tmpRoot, `db-${++dbSeq}`));
  db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p','P',?)").run(tmpRoot);
  return db;
}

/** A–E 组共用的小工具（各分组文件只依赖本形状，不直引主文件的可变状态）。 */
export interface RrHarness {
  ok(cond: boolean, label: string, detail?: string): void;
  eq(actual: unknown, expected: unknown, label: string): void;
  skip(label: string): void;
  root: string;
  A: string;
  mkdb(): Database.Database;
}

const h: RrHarness = { ok, eq, skip, root, A, mkdb };

runA(h);
runB(h);
runC(h);
runD(h);
runE(h);

// ── F 组「证」 ───────────────────────────────────────────────────────────────

{
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  const src = fs.readFileSync(path.join(root, A, 'src/main/core/agent-executor.ts'), 'utf-8');
  const m = /build:\s*'(zx_\d{8}(?:_\d+)?)'/.exec(src);
  const tag = m?.[1] ?? '';
  ok(buildNotOlderThan(tag, SELF.replace(/^rr_/, '')), 'F1 build 不早于本套件轮次', `${tag} vs ${SELF}`);
  ok(fs.existsSync(path.join(root, 'plans/improve', `${SELF.replace(/^rr_/, '')}.md`)), 'F2 本轮方案文件在场');
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail === 0 ? 0 : 1);
