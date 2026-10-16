/**
 * 诊断脚本：实测任务文本 vs 6 原型描述 / 4 模板描述的 embedding 相似度范围，
 * 验证 B1 阈值 0.4、A1 阈值 0.55 是否匹配实际。
 */
import { AnsClient } from '@worker-ant/ans-client';
import { ANS_DEFAULT_BASE_URL } from '../packages/shared-types/src/ans-defaults.js';

const FAMILY: Record<string, string> = {
  code: '编写代码实现功能，修复bug，重构代码，开发新模块或组件，修改现有代码逻辑，写脚本',
  research: '调查研究技术问题，分析代码库架构，搜索最新资料，了解技术实现方案，评估技术选型',
  document: '生成技术文档、项目报告、方案计划、API文档、README文件，撰写总结报告',
  analysis: '统计分析数据，计算指标趋势，制作图表可视化，分析日志数据，生成数据报告',
  configuration: '安装配置环境，部署服务，搭建开发环境，配置依赖，启动MCP服务，配置系统参数',
  conversation: '回答技术问题，提供建议，交流讨论，解释概念，帮助理解技术知识',
};

const TEMPLATES: Record<string, string> = {
  mcp_deploy: '部署MCP服务：克隆仓库→安装依赖→启动服务→注册产出物',
  web_app: '搭建Web应用：初始化项目→编写代码→测试→部署',
  data_analysis: '数据分析任务：获取数据→处理分析→生成报告',
  doc_generation: '文档生成：收集信息→撰写文档→注册产出物',
};

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function emb(ans: AnsClient, text: string): Promise<number[] | null> {
  const m = await ans.getOptimalModel({ capabilities: ['embedding'] }) as { url?: string; api_key?: string; model_name?: string } | undefined;
  if (!m?.url) return null;
  const base = m.url.replace(/\/$/, '');
  const url = base.includes('/api/embed') || base.includes('/embeddings') ? base : `${base}/embeddings`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${m.api_key || ''}` }, body: JSON.stringify({ input: text.slice(0, 4000), model: m.model_name || 'text-embedding-3-small' }), signal: AbortSignal.timeout(30_000) });
  if (!r.ok) return null;
  const j = await r.json() as { data?: Array<{ embedding: number[] }>; embeddings?: number[][] };
  return j.data?.[0]?.embedding || j.embeddings?.[0] || null;
}

async function main(): Promise<void> {
  const ans = new AnsClient({ serverUrl: ANS_DEFAULT_BASE_URL, apiKey: 'dev-key', secretKey: 'dev-secret' });
  const tests = ['重构认证模块', '部署一个MCP服务', '搭一个网站', '分析用户数据生成报告'];

  for (const t of tests) {
    const te = await emb(ans, t);
    if (!te) { console.log(`${t}: 无 embedding`); continue; }
    console.log(`\n=== 任务「${t}」vs 6 原型 ===`);
    const proto = Object.entries(FAMILY).map(([a, d]) => ({ a, s: 0 })).map(() => ({ a: '', s: 0 }));
    let idx = 0;
    for (const [a, d] of Object.entries(FAMILY)) {
      const de = await emb(ans, d);
      proto[idx] = { a, s: de ? cosine(te, de) : 0 };
      idx++;
    }
    proto.sort((x, y) => y.s - x.s);
    console.log(proto.slice(0, 3).map(p => `  ${p.a}: ${p.s.toFixed(3)}`).join('\n'));

    console.log(`  任务「${t}」vs 4 模板 ===`);
    const tpl = [];
    for (const [a, d] of Object.entries(TEMPLATES)) {
      const de = await emb(ans, d);
      tpl.push({ a, s: de ? cosine(te, de) : 0 });
    }
    tpl.sort((x, y) => y.s - x.s);
    console.log(tpl.slice(0, 2).map(p => `  ${p.a}: ${p.s.toFixed(3)}`).join('\n'));
  }
}

main();
