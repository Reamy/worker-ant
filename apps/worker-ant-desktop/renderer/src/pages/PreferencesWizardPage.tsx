import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Check, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import { invoke } from '../lib/ipc';
import { MEM_IMPORTANCE_DEFAULT } from '../../../src/main/core/memory-constants.js';

// 5维度17题 — 与原工蚁前端保持一致
const DIMENSIONS = [
  {
    key: 'tech_stack', title: '技术栈偏好',
    why: '了解你的技术栈，AI会优先使用你熟悉的语言和框架生成代码',
    questions: [
      { id: 'q1_language', text: '你主要使用的编程语言是？', multi: true, options: [
        { value: 'typescript', label: 'TypeScript / JavaScript' }, { value: 'python', label: 'Python' },
        { value: 'go', label: 'Go' }, { value: 'rust', label: 'Rust' },
        { value: 'java_kotlin', label: 'Java / Kotlin' }, { value: 'c_cpp', label: 'C / C++' },
      ]},
      { id: 'q2_backend', text: '你偏好的后端技术栈？', multi: false, options: [
        { value: 'nodejs_elysia', label: 'Node.js (Elysia / Express / Fastify)' },
        { value: 'python_fastapi', label: 'Python (FastAPI / Django / Flask)' },
        { value: 'go_gin', label: 'Go (Gin / Echo / Fiber)' },
        { value: 'java_spring', label: 'Java (Spring Boot)' }, { value: 'rust_axum', label: 'Rust (Axum / Actix)' },
      ]},
      { id: 'q3_frontend', text: '你偏好的前端技术栈？', multi: false, options: [
        { value: 'react_nextjs', label: 'React / Next.js' }, { value: 'vue_nuxt', label: 'Vue / Nuxt' },
        { value: 'svelte', label: 'Svelte / SvelteKit' }, { value: 'html_css', label: '纯 HTML/CSS' },
        { value: 'no_frontend', label: '不涉及前端' },
      ]},
      { id: 'q4_database', text: '你偏好的数据库？', multi: true, options: [
        { value: 'sqlite', label: 'SQLite（轻量单文件）' }, { value: 'postgresql', label: 'PostgreSQL' },
        { value: 'mysql', label: 'MySQL / MariaDB' }, { value: 'mongodb', label: 'MongoDB' },
        { value: 'redis', label: 'Redis' },
      ]},
    ],
  },
  {
    key: 'code_style', title: '代码风格偏好',
    why: '了解你的代码风格，AI的代码输出会更符合你的习惯',
    questions: [
      { id: 'q5_comments', text: '代码注释风格？', multi: false, options: [
        { value: 'minimal', label: '极简：仅关键逻辑加必要注释' }, { value: 'moderate', label: '适中：公共API加注释，内部逻辑靠命名' },
        { value: 'detailed', label: '详细：每个文件/函数都有说明注释' }, { value: 'on_demand', label: '按需：复杂逻辑才加注释' },
      ]},
      { id: 'q6_organization', text: '文件/模块组织偏好？', multi: false, options: [
        { value: 'by_layer', label: '按功能分层（routes/services/models分开）' },
        { value: 'by_domain', label: '按领域聚合（每个功能模块自包含）' },
        { value: 'flexible', label: '混合：根据项目大小灵活选择' },
      ]},
      { id: 'q7_quality', text: '代码质量保障偏好？', multi: true, options: [
        { value: 'typescript_strict', label: 'TypeScript 严格模式' }, { value: 'eslint_prettier', label: 'ESLint + Prettier' },
        { value: 'unit_test', label: '单元测试（80%+ 覆盖率）' }, { value: 'integration_test', label: '集成测试' },
        { value: 'cicd', label: 'CI/CD 自动检查' }, { value: 'git_hook', label: 'Git Hook (pre-commit)' },
      ]},
    ],
  },
  {
    key: 'communication', title: '沟通协作偏好',
    why: '了解你的沟通风格，AI的回复节奏和详细程度会更贴合你的习惯',
    questions: [
      { id: 'q8_ai_style', text: 'AI回复风格偏好？', multi: false, options: [
        { value: 'concise', label: '简洁直接：少说多做，一句话说明就行动' },
        { value: 'moderate', label: '适度解释：简要说明关键思路后行动' },
        { value: 'detailed', label: '详细说明：先完整分析再逐步执行' },
        { value: 'auto_adjust', label: '按场景自动调整' },
      ]},
      { id: 'q9_proactive', text: 'AI主动程度？', multi: false, options: [
        { value: 'high', label: '高主动：发现问题立即指出并建议优化方案' },
        { value: 'medium', label: '中等：执行任务时顺带提醒相关问题' },
        { value: 'low', label: '保守：严格按指令执行，不问不答' },
        { value: 'ask_first', label: '先询问：发现建议时先问我是否需要' },
      ]},
      { id: 'q10_permission', text: '任务执行权限偏好？', multi: false, options: [
        { value: 'auto', label: '自动执行：AI直接执行所有操作' },
        { value: 'key_confirm', label: '关键确认：非破坏性操作自动执行，破坏性需确认' },
        { value: 'step_confirm', label: '逐步确认：每一步都需我确认' },
        { value: 'plan_first', label: '计划先行：先出计划，确认后自动执行' },
      ]},
    ],
  },
  {
    key: 'project_exec', title: '项目执行偏好',
    why: '了解你的项目习惯，AI会按照你的节奏和规模偏好来规划和执行',
    questions: [
      { id: 'q11_project_type', text: '项目类型偏好？', multi: true, options: [
        { value: 'web_fullstack', label: 'Web 全栈应用' }, { value: 'api_backend', label: 'API 后端服务' },
        { value: 'cli', label: 'CLI 命令行工具' }, { value: 'data_etl', label: '数据处理 / ETL' },
        { value: 'ai_ml', label: 'AI / ML 模型相关' }, { value: 'devops', label: 'DevOps / 基础设施' },
        { value: 'mobile', label: '移动端应用' },
      ]},
      { id: 'q12_scale', text: '项目规模偏好？', multi: false, options: [
        { value: 'small', label: '小工具/脚本（<10个文件）' }, { value: 'medium', label: '中型模块/微服务（10-50个文件）' },
        { value: 'large', label: '大型应用（50-200个文件）' }, { value: 'platform', label: '平台级项目（>200个文件）' },
      ]},
      { id: 'q13_pace', text: '交付节奏偏好？', multi: false, options: [
        { value: 'fast_mvp', label: '快速迭代：先出MVP再逐步完善' },
        { value: 'steady', label: '稳健推进：完整设计→逐步实现→测试→交付' },
        { value: 'quality_first', label: '质量优先：每步都经过完整测试和文档' },
      ]},
      { id: 'q14_docs', text: '文档偏好？', multi: false, options: [
        { value: 'code_as_doc', label: '代码即文档：命名清晰+最小化README' },
        { value: 'necessary', label: '必要文档：README + API文档' },
        { value: 'complete', label: '完整文档：README + API + 架构 + 部署 + 变更日志' },
      ]},
    ],
  },
  {
    key: 'ai_tools', title: 'AI工具偏好',
    why: '了解你对AI工具的使用习惯和期望，便于系统调整交互方式',
    questions: [
      { id: 'q15_ai_tools', text: '你已经在使用的AI工具？', multi: true, options: [
        { value: 'claude_code', label: 'Claude Code / Claude CLI' }, { value: 'copilot', label: 'GitHub Copilot' },
        { value: 'cursor', label: 'Cursor / Windsurf' }, { value: 'chatgpt', label: 'ChatGPT' },
        { value: 'none', label: '暂未使用' },
      ]},
      { id: 'q16_tolerance', text: '对AI的错误容忍度？', multi: false, options: [
        { value: 'zero', label: '零容忍：任何错误都不可接受（金融/安全场景）' },
        { value: 'low', label: '低容忍：关键逻辑不能出错，辅助内容可容错' },
        { value: 'medium', label: '中等：理解AI偶尔会出错，重点关注结果验证' },
        { value: 'high', label: '高容忍：接受AI的试错过程，最终结果正确即可' },
      ]},
      { id: 'q17_time', text: '偏好使用AI的时段？', multi: false, options: [
        { value: 'work_hours', label: '工作时间（9:00-18:00）' },
        { value: 'off_hours', label: '休息时间（晚上/周末）' },
        { value: 'anytime', label: '随时' }, { value: 'auto', label: '自动：无需关注运行时间' },
      ]},
    ],
  },
];

function answersToPreferences(answers: Record<string, string | string[]>): Array<{ content: string; reasoning: string }> {
  const prefs: Array<{ content: string; reasoning: string }> = [];
  for (const dim of DIMENSIONS) {
    for (const q of dim.questions) {
      const answer = answers[q.id];
      if (!answer) continue;
      const vals = Array.isArray(answer) ? answer : [answer];
      if (vals.length === 0 || (vals.length === 1 && vals[0] === 'none')) continue;
      const labels = vals.map(v => { const opt = q.options.find(o => o.value === v); return opt ? opt.label : v; });
      const questionText = q.text.replace('？', '').replace('?', '');
      prefs.push({ content: `用户偏好${questionText}：${labels.join('、')}`, reasoning: `引导向导「${dim.title}」采集，问题：${q.text}` });
    }
  }
  return prefs;
}

function getUserId(): string {
  try { const t = localStorage.getItem('token'); if (t) { const payload = JSON.parse(atob(t.split('.')[1]!)); return payload.sub || payload.id || 'default'; } } catch {}
  return 'default';
}

// zx_20261005 M14（K-7 释名）：原名 `OnboardingPage`——但它是**偏好采集问卷**，不是安装引导；
//   与新的 `SetupPage`（真·安装向导，路由 `/onboarding`）并存且各司其职，故更名归位。
//   首启判据已改由状态定（`setup:state`），本页**不再写那个 localStorage 首启布尔标志**。
export default function PreferencesWizardPage() {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const navigate = useNavigate();
  const userId = getUserId();
  const isSummary = step === DIMENSIONS.length;
  const dim = isSummary ? null : DIMENSIONS[step];

  const toggleMulti = (qid: string, value: string) => {
    const current = (answers[qid] as string[]) || [];
    if (current.includes(value)) setAnswers(a => ({ ...a, [qid]: current.filter(v => v !== value) }));
    else setAnswers(a => ({ ...a, [qid]: [...current, value] }));
  };
  const setSingle = (qid: string, value: string) => { setAnswers(a => ({ ...a, [qid]: value })); };

  const canNext = dim ? dim.questions.every(q => {
    const a = answers[q.id];
    return a && (Array.isArray(a) ? a.length > 0 : !!a);
  }) : false;

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError('');
    try {
      const prefs = answersToPreferences(answers);
      if (prefs.length > 0 && userId) {
        // zx_20260920_1 M7: 这是写侧第 11 个站点（经 `preferences:batch` 落库）——此前硬写 0.5，
        //   即"新库能读到、新写入读不到"的典型；改引真源。
        const items = prefs.map(p => ({ content: p.content, source: 'user_onboarding', importance: MEM_IMPORTANCE_DEFAULT, reasoning: p.reasoning }));
        await invoke('preferences:batch', { userId, items });
      }
    } catch (e) {
      setSubmitError((e as Error).message || '保存失败');
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    navigate('/preferences');
  };

  // zx_20261005 M14: 偏好向导**可跳过**——跳过与提交都不再写首启布尔标志（首启由状态判，不看标志）。
  const skip = () => { navigate('/'); };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 pt-4 pb-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">偏好设置向导</h1>
          <p className="text-sm mt-1 text-gray-500">帮助AI更好地了解你，生成更符合你习惯的代码和建议</p>
        </div>

        {!isSummary && dim && (
          <>
            {/* 进度条 */}
            <div className="flex items-center gap-2 mt-6 mb-4">
              {DIMENSIONS.map((d, i) => (
                <div key={d.key} className="flex-1 flex items-center gap-2">
                  <button onClick={() => { if (i < step) setStep(i); }}
                    className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                    style={{ backgroundColor: i < step ? '#3b82f6' : i === step ? '#3b82f6' : '#e2e8f0', color: i <= step ? '#fff' : '#64748b' }}>
                    {i < step ? <Check className="w-3.5 h-3.5" /> : i + 1}
                  </button>
                  <span className="text-xs hidden sm:inline text-gray-500">{d.title.slice(0, 4)}</span>
                  {i < DIMENSIONS.length - 1 && <div className="flex-1 h-0.5" style={{ backgroundColor: i < step ? '#93c5fd' : '#e2e8f0' }} />}
                </div>
              ))}
            </div>

            {/* 问题卡片 */}
            <div className="bg-white rounded-xl border p-6 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <span className="bg-blue-500 text-white rounded-full px-2 py-0.5 text-xs font-semibold">维度 {step + 1}/{DIMENSIONS.length}</span>
                <h3 className="text-lg font-semibold text-gray-900">{dim.title}</h3>
              </div>
              <p className="text-xs text-gray-500">{dim.why}</p>
              <div className="mt-5 space-y-5">
                {dim.questions.map((q, qi) => {
                  const answer = answers[q.id];
                  return (
                    <div key={q.id}>
                      <p className="text-sm font-bold text-gray-900 mb-2">
                        {qi + 1}. {q.text}
                        {q.multi && <span className="font-normal text-xs text-gray-400 ml-1">（可多选）</span>}
                      </p>
                      <div className="space-y-2">
                        {q.options.map(opt => {
                          const selected = q.multi ? ((answer as string[]) || []).includes(opt.value) : answer === opt.value;
                          return (
                            <button key={opt.value}
                              onClick={() => q.multi ? toggleMulti(q.id, opt.value) : setSingle(q.id, opt.value)}
                              className="w-full text-left p-3 rounded-lg text-sm transition-colors flex items-center gap-2.5"
                              style={{ border: selected ? '2px solid #60a5fa' : '1px solid #e2e8f0', backgroundColor: selected ? '#eff6ff' : '#fff' }}>
                              <span className="w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0"
                                style={{ borderColor: selected ? '#3b82f6' : '#cbd5e1', backgroundColor: selected ? '#3b82f6' : 'transparent' }}>
                                {selected && <Check className="w-3 h-3 text-white" />}
                              </span>
                              <span style={{ color: selected ? '#1e40af' : '#334155', fontWeight: selected ? 600 : 400 }}>{opt.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 导航按钮 */}
            <div className="flex justify-between mt-6">
              <button onClick={() => step > 0 && setStep(step - 1)} disabled={step === 0}
                className="flex items-center gap-1 px-4 py-2 border rounded-lg text-sm disabled:opacity-40 hover:bg-gray-50">
                <ChevronLeft className="w-4 h-4" />上一步
              </button>
              <button onClick={() => setStep(step === DIMENSIONS.length - 1 ? DIMENSIONS.length : step + 1)} disabled={!canNext}
                className="flex items-center gap-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50 hover:bg-blue-700">
                {step === DIMENSIONS.length - 1 ? '查看摘要' : '下一步'}<ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </>
        )}

        {/* 摘要确认 */}
        {isSummary && (
          <div className="bg-white rounded-xl border p-6 shadow-sm mt-6">
            {(() => {
              const prefs = answersToPreferences(answers);
              return (
                <>
                  <div className="text-center mb-6">
                    <Sparkles className="w-12 h-12 mx-auto mb-2 text-blue-500" />
                    <h2 className="text-xl font-bold text-gray-900">确认你的偏好设置</h2>
                    <p className="text-sm mt-1 text-gray-500">以下是根据你的回答生成的偏好，确认无误后提交</p>
                  </div>
                  <div className="space-y-2 mb-6">
                    {prefs.map((p, i) => (
                      <div key={i} className="rounded-lg border p-3 bg-gray-50"><p className="text-sm text-gray-700">{p.content}</p></div>
                    ))}
                  </div>
                  <div className="flex justify-between">
                    <button onClick={() => setStep(DIMENSIONS.length - 1)}
                      className="flex items-center gap-1 px-4 py-2 border rounded-lg text-sm hover:bg-gray-50"><ChevronLeft className="w-4 h-4" />返回修改</button>
                    {submitError && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded mb-3">保存失败: {submitError}</p>}
                    <button onClick={handleSubmit} disabled={submitting || prefs.length === 0}
                      className="px-6 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">
                      {submitting ? '提交中...' : `确认提交（${prefs.length}条偏好）`}
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        )}

        {/* 跳过 */}
        {!isSummary && <p className="text-center mt-4"><button onClick={skip} className="text-xs text-gray-400 hover:text-gray-600">跳过引导 → 直接开始</button></p>}
      </div>
    </div>
  );
}
