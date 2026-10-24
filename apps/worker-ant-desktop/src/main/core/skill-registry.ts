/**
 * AI 技能注册中心（从原工蚁 skill-registry.ts 移植 + 扩展 .agents 识别）。
 * 统一管理三类技能：
 *   1. 内置技能（code_review/security_check）— 代码执行型
 *   2. ANS 服务端技能（/api/v1/skills）— 插件技能，动态同步
 *   3. .agents 目录技能（~/.agents/skills/{name}/SKILL.md）— 提示词型（markdown 指令）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// zx_20260930 M9: 到 ANS 的请求**只有一条出路**（`ans-signed-request`）——本模块此前只发 `x-api-key`，
//   而 ANS 要三头齐备 ⇒ 恒 401；且 `console.warn` 里没有状态码，看不出是 401 还是网络。
import { ansSignedRequest, ansFailureNote, type AnsCreds } from './ans-signed-request.js';

export interface SkillContext {
  projectId?: string;
  taskId?: string;
  workingDir?: string;
}

export interface SkillDefinition {
  name: string;
  description: string;
  category: 'review' | 'security' | 'utility' | 'custom' | 'agent' | 'ans';
  /** 提示词型技能：markdown 指令内容 */
  content?: string;
  /** 代码执行型技能 */
  execute?: (input: string, ctx: SkillContext) => Promise<string> | string;
}

const skills = new Map<string, SkillDefinition>();

/** 跟踪从 ANS 同步的技能名（用于刷新时清理） */
const _ansSkills = new Set<string>();

/** 已扫过 `.agents/skills` 的 workingDir（zx_20260929 M1）。
 *  ★ 此前是一枚**进程级布尔**（`agent-executor` 的 `_agentSkillsLoaded`）⇒ 只有**首个**执行任务的
 *     `workingDir` 被扫过一次，此后换项目**不再重扫**，项目级 `.agents/skills` 只有第一个项目有效。
 *    记账的键必须是**作用域**（目录），不是「扫过了没」。 */
const _agentSkillDirs = new Set<string>();

/** ANS 技能同步记账（zx_20260929 M1）：**只在成功时**置 ok；失败留痕且**可重试**（带退避，
 *  防 ANS 不可达时每一步都打满 5s 超时）。`attempts` 使「没同步上」与「同步了但本来就没技能」可分。 */
const _ansSync = { ok: false, attempts: 0, lastError: null as string | null, retryAfter: 0 };
/** 同步失败后的退避窗口（ms）。 */
const ANS_SYNC_RETRY_MS = 30_000;

/** 内置技能：代码质量审查 */
export const codeReviewSkill: SkillDefinition = {
  name: 'code_review',
  description: '代码质量审查',
  category: 'review',
  execute: (input: string) => {
    const issues: string[] = [];
    if (input.includes('console.log') && !input.includes('logger.')) issues.push('[质量] 发现console.log，建议使用logger');
    if (/catch\s*\(\s*\)\s*\{/.test(input)) issues.push('[质量] 空的catch块，建议至少记录错误日志');
    if (/\.then\(.*catch\(/.test(input) && !input.includes('.finally(')) issues.push('[质量] Promise链含catch但缺少finally清理');
    if (/(for|while)\s*\([^)]*\)\s*\{[^}]*await\s/.test(input)) issues.push('[性能] 循环内使用await，建议改为Promise.all并发');
    if (issues.length === 0) issues.push('[通过] 未发现明显问题');
    return JSON.stringify({ skill: 'code_review', issues, reviewedAt: new Date().toISOString() });
  },
};

/** 内置技能：深度安全检查 */
export const securityCheckSkill: SkillDefinition = {
  name: 'security_check',
  description: '深度安全检查',
  category: 'security',
  execute: (input: string) => {
    const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
    const injectionPatterns = [/<script/i, /javascript:/i, /onerror=/i, /onclick=/i, /SELECT.*FROM.*WHERE.*=/i, /UNION\s+SELECT/i];
    const hasInjection = injectionPatterns.some(p => p.test(input));
    checks.push({ name: '注入检测', pass: !hasInjection, detail: hasInjection ? '检测到潜在注入模式' : '通过' });
    const secretPatterns = [/sk-[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/, /Bearer\s+[A-Za-z0-9\-_.~+/]+=*/, /-----BEGIN.*PRIVATE KEY-----/];
    const hasSecret = secretPatterns.some(p => p.test(input));
    checks.push({ name: '密钥泄露', pass: !hasSecret, detail: hasSecret ? '检测到疑似密钥/Token' : '通过' });
    const hasUnvalidated = /req\.(body|query|params)/.test(input) && !input.includes('z.object') && !input.includes('validate');
    checks.push({ name: '输入验证', pass: !hasUnvalidated, detail: hasUnvalidated ? '请求参数未使用Schema验证' : '通过或N/A' });
    return JSON.stringify({ skill: 'security_check', checks, scannedAt: new Date().toISOString() });
  },
};

skills.set(codeReviewSkill.name, codeReviewSkill);
skills.set(securityCheckSkill.name, securityCheckSkill);

/** 注册技能 */
export function registerSkill(skill: SkillDefinition): void {
  skills.set(skill.name, skill);
}

/** 注销技能 */
export function unregisterSkill(name: string): void {
  skills.delete(name);
  _ansSkills.delete(name);
}

/** 列出所有技能。`executable` 如实标注本进程能否**真执行**（zx_20260929 M1）：
 *  内置技能有 `execute`；`.agents` 提示词型有 `content`（返回指令供 Agent 参考）；**ANS 插件技能两者皆无**。 */
export function listSkills(): Array<{ name: string; description: string; category: string; executable: boolean }> {
  return [...skills.values()].map(s => ({
    name: s.name,
    description: s.description,
    category: s.category,
    executable: Boolean(s.execute || s.content),
  }));
}

/**
 * 加载 .agents 目录技能（提示词型）——**按目录幂等**（zx_20260929 M1）。
 * 扫描 ~/.agents/skills/{name}/SKILL.md（用户级）+ 项目 .agents/skills/{name}/SKILL.md（项目级）。
 * SKILL.md 格式：YAML frontmatter(name/description) + markdown 指令体。
 *
 * 同一 `projectWorkingDir` 重复调用不重扫（返回 0）；**换目录必扫**——进程级布尔会让第二个项目永远轮不上。
 */
export function loadAgentSkills(projectWorkingDir?: string): number {
  const dirKey = `dir:${projectWorkingDir || ''}`;
  if (_agentSkillDirs.has(dirKey)) return 0;
  _agentSkillDirs.add(dirKey);
  let loaded = 0;
  const dirs = [
    path.join(os.homedir(), '.agents', 'skills'),
    ...(projectWorkingDir ? [path.join(projectWorkingDir, '.agents', 'skills')] : []),
  ];
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(dir, entry.name, 'SKILL.md');
        if (!fs.existsSync(skillMd)) continue;
        try {
          const raw = fs.readFileSync(skillMd, 'utf-8');
          const parsed = parseSkillMarkdown(raw);
          if (!parsed.name) continue;
          if (skills.has(parsed.name)) continue; // 不覆盖内置/ANS技能
          skills.set(parsed.name, {
            name: parsed.name,
            description: parsed.description || parsed.name,
            category: 'agent',
            content: parsed.content,
          });
          loaded++;
        } catch { /* 单个技能解析失败跳过 */ }
      }
    } catch { /* 目录读取失败忽略 */ }
  }
  if (loaded > 0) console.log(`[skill-registry] 已加载 ${loaded} 个 .agents 技能`);
  return loaded;
}

/** 解析 SKILL.md：提取 frontmatter(name/description) + 正文 */
function parseSkillMarkdown(raw: string): { name: string; description: string; content: string } {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { name: '', description: '', content: raw };
  const frontmatter = m[1]!;
  const body = m[2] || '';
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() || '';
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim() || '';
  return { name, description, content: body.trim() };
}

/**
 * 从 ANS 服务端同步技能（插件技能）。
 * 通过 fetch 直接访问 /api/v1/skills，返回 ans_skills 表里的 active 技能。
 *
 * 返回：`>= 0` 为**成功同步的条数**；**`-1` 为同步失败**（网络不可达 / 非 2xx）——zx_20260929 M1：
 *  此前失败与「成功但 0 条技能」同返 `0`，调用方无从区分，于是把失败也当成「同步过了」而**永不重试**。
 *
 * zx_20260930 M9：形参由 `(ansUrl, apiKey)` 改为 **`creds: AnsCreds`**——到 ANS 的请求改走
 *  `ansSignedRequest`（三头齐备、超时与重试一处写）。签名要 secret，而**只传 `ansUrl`+`apiKey`
 *  的签名在结构上不成立**，故此处**必须**改签名（不是顺手改：不改就签不出可被 ANS 认的头）。
 */
export async function syncSkillsFromAns(creds: AnsCreds, opts: { retries?: number } = {}): Promise<number> {
  try {
    const r = await ansSignedRequest(creds, '/api/v1/skills', { method: 'GET', timeoutMs: 5000, retries: opts.retries ?? 1 });
    if (!r.ok) { console.warn(`[skill-registry] ANS 技能同步失败：${ansFailureNote(r)}`); return -1; }
    const data = await r.response!.json() as { data?: Array<{ name: string; description?: string; tags?: string; status?: string }> };
    const ansSkills = data.data || [];

    // 清理上一次同步的 ANS 技能（保留内置/agent 技能）
    for (const name of _ansSkills) {
      if (!['code_review', 'security_check'].includes(name)) skills.delete(name);
    }
    _ansSkills.clear();

    let count = 0;
    for (const s of ansSkills) {
      if (s.status && s.status !== 'active') continue;
      if (!s.name || skills.has(s.name)) continue;
      const category: SkillDefinition['category'] = 'ans';
      skills.set(s.name, { name: s.name, description: s.description || s.name, category });
      _ansSkills.add(s.name);
      count++;
    }
    if (count > 0) console.log(`[skill-registry] 已同步 ${count} 个 ANS 技能`);
    return count;
  } catch (e) {
    console.warn(`[skill-registry] ANS 技能同步异常：${(e as Error).message}`);
    return -1;
  }
}

/**
 * 同步 ANS 技能——**幂等 + 失败可重试**（zx_20260929 M1）。返回是否**已同步**。
 *
 * 此前 `agent-executor` 用进程级布尔 `_ansSkillsSynced`：失败也置位 ⇒ ANS 未起/网络抖一次即**永久失效**。
 * 现在只有**成功**才置位；失败留痕并记退避窗口，窗口过后下次调用**确实重试**。
 *
 * `opts.now` 是**时钟接缝**（仅测试用）：注入一个晚于退避窗口的时刻即可验证「窗口过后确实重试」。
 */
export async function syncSkillsFromAnsOnce(creds: AnsCreds, opts: { now?: number } = {}): Promise<boolean> {
  const now = opts.now ?? Date.now();
  if (_ansSync.ok) return true;
  if (now < _ansSync.retryAfter) return false;
  _ansSync.attempts++;
  const n = await syncSkillsFromAns(creds);
  if (n >= 0) {
    _ansSync.ok = true;
    _ansSync.lastError = null;
    return true;
  }
  _ansSync.lastError = `ANS 技能同步失败（已试 ${_ansSync.attempts} 次，下次退避 ${ANS_SYNC_RETRY_MS / 1000}s 后）`;
  _ansSync.retryAfter = now + ANS_SYNC_RETRY_MS;
  console.warn(`[skill-registry] ${_ansSync.lastError}`); // 留痕：此前是 `catch {}` 里的一声闷响
  return false;
}

/**
 * 技能加载/同步的**账**（只读诊断，zx_20260929 M1）。
 * 让「没同步上」与「同步了但本来就没技能」可分——不再只有 `catch {}` 里的一声闷响。
 */
export function skillLoadState(): {
  agentSkillDirs: string[];
  ansSynced: boolean;
  ansAttempts: number;
  ansLastError: string | null;
} {
  return {
    agentSkillDirs: [..._agentSkillDirs].map(k => k.replace(/^dir:/, '')),
    ansSynced: _ansSync.ok,
    ansAttempts: _ansSync.attempts,
    ansLastError: _ansSync.lastError,
  };
}

/** 执行技能：代码执行型走 execute；提示词型返回指令内容 */
export async function executeSkill(name: string, input: string, ctx: SkillContext = {}): Promise<string> {
  const skill = skills.get(name);
  if (!skill) return JSON.stringify({ error: `未知技能: ${name}。可用: ${[...skills.keys()].join(', ')}` });
  try {
    if (skill.execute) {
      return await skill.execute(input, ctx);
    }
    if (skill.content) {
      // 提示词型技能：返回指令内容（供 Agent 参考执行）
      return JSON.stringify({
        skill: name,
        type: 'prompt',
        description: skill.description,
        instructions: skill.content.slice(0, 4000),
      });
    }
    // 名实对齐（zx_20260929 M1）：**ANS 插件技能**在本进程里只有「名字 + 说明」，没有执行体。
    // 此前一律回「无执行体」，看不出它其实来自 ANS、本轮只供检索；现按来源如实说清。
    return JSON.stringify({
      error: skill.category === 'ans'
        ? `技能 ${name} 来自 ANS 服务端，本进程无本地执行体（本轮仅供检索/选用参考，不能在桌面端直接执行）`
        : `技能 ${name} 无执行体`,
      skill: name,
      category: skill.category,
      executable: false,
    });
  } catch (e) {
    return JSON.stringify({ error: `技能执行失败: ${(e as Error).message}` });
  }
}
