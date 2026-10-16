/**
 * zx_20260920_1 M1（庄子·无用之用 / 金刚经·不住相）: 由 `agent-executor.ts` 的 `buildTools()`
 * **机械搬迁**而来——工具体**逐字节未改**，只把原来靠外层闭包取到的名字，改为从 `deps` 解构。
 * 搬迁纪律：**工具名 / 参数 schema / execute 行为 / 返回形状一律不动**；此处不新增、不删除任何工具。
 * 依赖面（3 项）由 `ToolDeps` 声明式给出，不再依赖隐式闭包。
 */
import type { ToolDeps } from './deps.js';
import { jsonSchema } from 'ai';

export function memoryTools(deps: ToolDeps) {
  const { ctx, taskId, projectId } = deps;
  return {
    search_project_memory: {
      description: '搜索项目的记忆和知识库（混合BM25词法+向量语义检索），支持自然语言查询。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: '搜索查询，可使用自然语言描述要查找的内容' },
        },
        required: ['query'],
      }),
      execute: async (args: { query: string }) => {
        if (!ctx.memory) return JSON.stringify({ error: '记忆管理器不可用' });
        // Phase 1.3: 生成查询向量启用语义检索（原为 null 仅 BM25 词法）
        const queryEmb = await ctx.memory.embedText(args.query);
        const results = ctx.memory.searchHybrid(args.query, queryEmb, projectId, 5);
        if (results.length === 0) {
          const kw = ctx.memory.searchByKeywords(args.query.split(/\s+/).filter(k => k.length > 1), projectId, 5);
          if (kw.length === 0) return '未找到相关记忆';
          ctx.memory.recordAccess(kw.map(r => r.id));
          return kw.map(r => `[${r.memory_type}] ${r.content}`).join('\n');
        }
        // Phase 1.3: 工具检索命中同样记录访问（意义即使用）
        ctx.memory.recordAccess(results.map(r => r.id));
        return results.map(r => `[${r.memory_type}] ${r.content}`).join('\n');
      },
    },
    remember_intent: {
      description: '登记前瞻记忆——记住未来要做/要提醒的事（当某条件满足或某时间到达时提醒）。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          intent: { type: 'string', description: '要记住的未来意图/待办（如"当用户提到部署时，提醒先跑测试"）' },
          trigger_condition: { type: 'string', description: '触发条件关键词（事件型，可选，逗号分隔）' },
          due_at: { type: 'string', description: '到期时间 ISO 格式（时间型，可选）' },
        },
        required: ['intent'],
      }),
      execute: async (args: { intent: string; trigger_condition?: string; due_at?: string }) => {
        if (!ctx.memory) return JSON.stringify({ error: '记忆管理器不可用' });
        const id = ctx.memory.storeProspective({ projectId, taskId, content: args.intent, triggerCondition: args.trigger_condition, dueAt: args.due_at });
        return JSON.stringify({ memoryId: id, status: 'registered' });
      },
    },
    list_intents: {
      description: '列出项目内待办的前瞻记忆（pending 状态）。',
      parameters: jsonSchema({ type: 'object' as const, properties: {}, required: [] }),
      execute: async () => {
        if (!ctx.memory) return JSON.stringify({ error: '记忆管理器不可用' });
        const list = ctx.memory.listProspective(projectId, 20);
        const pending = list.filter(m => { try { const c = JSON.parse(m.context_json || '{}'); return (c.prospective?.status ?? 'pending') === 'pending'; } catch { return true; } });
        if (pending.length === 0) return '暂无待办的前瞻记忆';
        return pending.map((m, i) => `${i + 1}. ${m.content}`).join('\n');
      },
    },
    note_working_context: {
      description: '记录当前任务的工作记忆：既可用于临时情境（如"正在编辑的文件X""待办子步骤Y"），也可记录值得复用的关键约束、有效做法或踩坑经验（如"某配置需重启才生效"）；后者在任务完成后会被自动沉淀为长期记忆，供后续相似任务召回。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: { content: { type: 'string', description: '情境或经验内容：临时情境记轻量上下文，关键约束/有效做法记可复用的具体结论' } },
        required: ['content'],
      }),
      execute: async (args: { content: string }) => {
        if (!ctx.memory) return JSON.stringify({ error: '记忆管理器不可用' });
        ctx.memory.addWorkingMemory(taskId, args.content);
        return JSON.stringify({ status: 'noted', workingMemoryCount: ctx.memory.getWorkingMemory(taskId).length });
      },
    },
    register_unknown: {
      description: '登记知识盲区——记录你当前解决不了/不确定的问题，后续遇到相关任务会主动提醒，避免重复尝试。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: { issue: { type: 'string', description: '无法解决的问题描述' } },
        required: ['issue'],
      }),
      execute: async (args: { issue: string }) => {
        if (!ctx.memory) return JSON.stringify({ error: '记忆管理器不可用' });
        const id = ctx.memory.storeUnknown(projectId, taskId, args.issue);
        return JSON.stringify({ memoryId: id, status: 'registered' });
      },
    },
    list_unknowns: {
      description: '列出项目内已登记的知识盲区。',
      parameters: jsonSchema({ type: 'object' as const, properties: {}, required: [] }),
      execute: async () => {
        if (!ctx.memory) return JSON.stringify({ error: '记忆管理器不可用' });
        const list = ctx.memory.listUnknowns(projectId, 20);
        if (list.length === 0) return '暂无已登记的知识盲区';
        return list.map((m, i) => `${i + 1}. ${m.content}`).join('\n');
      },
    },
    register_negative: {
      description: '登记负空间记忆——记录你试过但失败/刻意回避的事项，后续遇到相关任务会主动提醒，避免重复踩坑。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          content: { type: 'string', description: '试过失败/刻意回避的事项描述' },
          kind: { type: 'string', description: '类型: tried_failed(试过失败)/avoid(刻意回避)，默认 tried_failed' },
        },
        required: ['content'],
      }),
      execute: async (args: { content: string; kind?: 'tried_failed' | 'avoid' }) => {
        if (!ctx.memory) return JSON.stringify({ error: '记忆管理器不可用' });
        const id = ctx.memory.storeNegative(projectId, taskId, args.content, args.kind ?? 'tried_failed');
        return JSON.stringify({ memoryId: id, status: 'registered' });
      },
    },
    list_negatives: {
      description: '列出项目内已登记的负空间记忆（试过失败/刻意回避）。',
      parameters: jsonSchema({ type: 'object' as const, properties: {}, required: [] }),
      execute: async () => {
        if (!ctx.memory) return JSON.stringify({ error: '记忆管理器不可用' });
        const list = ctx.memory.listNegatives(projectId, 20);
        if (list.length === 0) return '暂无已登记的负空间记忆';
        return list.map((m, i) => `${i + 1}. ${m.content}`).join('\n');
      },
    },
    list_skill_drafts: {
      description: '列出项目内待审批的技能草案（由程序性记忆自动提炼，需用户批准后才会注册为可执行技能）。',
      parameters: jsonSchema({ type: 'object' as const, properties: {}, required: [] }),
      execute: async () => {
        if (!ctx.memory) return JSON.stringify({ error: '记忆管理器不可用' });
        const drafts = ctx.memory.listSkillDrafts(projectId, 20);
        if (drafts.length === 0) return '暂无待审批的技能草案';
        return drafts.map((d, i) => `${i + 1}. [${d.name}] ${d.description}\n${d.steps.map(s => `   - ${s}`).join('\n')}`).join('\n');
      },
    },
    propose_skill: {
      description: '主动提出一个技能草案（供用户审批后注册为可执行技能，审批通过后可用 skill 工具调用）。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: '技能名（英文 snake_case）' },
          description: { type: 'string', description: '技能用途说明' },
          steps: { type: 'string', description: '操作步骤，每行一步' },
        },
        required: ['name', 'description', 'steps'],
      }),
      execute: async (args: { name: string; description: string; steps: string }) => {
        if (!ctx.memory) return JSON.stringify({ error: '记忆管理器不可用' });
        const steps = args.steps.split('\n').map(s => s.trim()).filter(s => s.length > 0);
        if (steps.length === 0) return JSON.stringify({ error: '步骤不能为空' });
        const id = ctx.memory.storeSkillDraft(projectId, { name: args.name, description: args.description, steps });
        return JSON.stringify({ draftId: id, status: 'draft', note: '技能草案已登记，待用户批准后生效' });
      },
    },
    search_knowledge_graph: {
      description: '搜索项目知识图谱（实体-关系-实体三元组，支持1-2跳关联扩展）。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: { query: { type: 'string', description: '搜索查询' } },
        required: ['query'],
      }),
      execute: async (args: { query: string }) => {
        if (!ctx.memory) return JSON.stringify({ error: '记忆管理器不可用' });
        const results = ctx.memory.searchKnowledgeGraph(args.query, projectId, 8);
        if (results.length === 0) return '未找到相关知识关联';
        return results.map(t => `${t.subject} ─[${t.predicate}]→ ${t.object}`).join('\n');
      },
    },
  };
}
