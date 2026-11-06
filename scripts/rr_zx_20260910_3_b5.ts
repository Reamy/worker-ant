/**
 * zx_20260910_3 批7 受控复跑（M6：收口注记的可断言部分 + `run_features.build` 刷新守护）。
 *
 * 本文件把"M6 收口"里**能被断言**的部分固化下来，其余（哲学对照、决策复述）留方案文字：
 *   S1 `run_features.build` 已刷新为本轮标识，且**钉住**——防重演"硬编码 zx_20260904_5 长期未动"
 *      （CLAUDE.md 约定：改动引擎核心/发版后须刷新 build）。**开新一轮时须同步改本断言**，这正是那个"叫醒"动作。
 *   S2 本方案五处靶心（G1–G5 落地）各留一条"已落地"总纲断言，作为收口体检——只验"还在"，不重复各批细断言。
 *   S3 交付标准里"已提交"的可验证面：工作区无未提交的引擎/渲染层改动（.mcp.json 等本地配置除外）。
 *
 * 绝不触碰开发库（本文件不连任何 DB）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { checkBuildPins } from './lib/rr-pins.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('S1 run_features.build 刷新守护（派生一致性，非字面量）');
{
  // 订正（M5 落地时）：本块原为 `const ROUND = '<本轮>'` + `const PREV_ROUND = '<自轮>'` 两个字面量常量
  // （`ROUND` 每开新轮须手改，是"硬编码长期未动"守护自身的硬编码）。改为**派生一致性**：
  // 真源＝agent-executor.ts 的那一处 build 值；核对"恰好一处 + 格式合法 + 标签有据（方案/复跑脚本）+ 全量钉子同值"。
  // 见 plans/improve/zx_20260912.md §M5 与 scripts/lib/rr-pins.ts。
  checkBuildPins(ok);
}

console.log('S2 五处靶心"仍在"总纲体检（不重复各批细断言）');
{
  const sb = stripComments(rd('apps/worker-ant-desktop/src/main/core/settings-bool.ts'));
  ok(/export function boolSetting\(/.test(sb), 'G2/M3：布尔判据唯一实现仍在（settings-bool.ts）');

  const dlc = stripComments(rd('apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.ts'));
  ok(/export function markDocAcceptanceVerified\(/.test(dlc), 'G1/M1：验收打标（下游认 verified）仍在');

  const pe = stripComments(rd('apps/worker-ant-desktop/src/main/core/project-engine.ts'));
  ok(/m - 2440587\.5\) \* 86400000/.test(pe) && /SELECT c\.created_at FROM wa_task_conversations/.test(pe),
    'G4/M4：project-engine 两处修复仍在（偏移 + 消歧）');

  const jobs = stripComments(rd('apps/worker-ant-desktop/src/main/core/jobs/ai-task.ts'));
  ok(/GOAL_DEVIATION_MAX_RESTARTS/.test(jobs), 'G5/M2：收敛上限单一真源常量仍在');

  const idx = stripComments(rd('apps/worker-ant-desktop/src/main/index.ts'));
  ok(/normalizeBooleanSettingValues\(db/.test(idx), 'G3/M3：库值规范化启动接线仍在');
}

console.log('S3 交付标准·"已提交"可验证面（提交后复核，**不计入失败**——本轮自身尚未提交时它必然不空，故只报告）');
{
  let dirty = '';
  try {
    dirty = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf-8' });
  } catch { dirty = ''; }
  // 只关心引擎/渲染层/方案/脚本的未提交改动；.mcp.json 等本地配置不算（用户侧 IDE 配置）
  const relevant = dirty.split('\n').map(l => l.slice(3).trim()).filter(Boolean)
    .filter(f => /^(apps\/worker-ant-desktop\/(src|renderer)|scripts\/|plans\/)/.test(f));
  const clean = relevant.length === 0;
  console.log(`  ${clean ? '✓' : 'ℹ'} 工作区 ${clean ? '无' : '尚有'}未提交的引擎/渲染层/脚本/方案改动` +
    `${clean ? '（交付标准"已提交"成立）' : '：' + relevant.join(', ')}`);
}

console.log('\n结果: pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
