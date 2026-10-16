import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { matchOptimalModel, EP_FUNNEL_ANY_CAPABILITY } from '../services/resource-matcher.js';

describe('Resource Matcher', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // 创建测试schema（C1: 含 enabled 启用列）
    db.exec(`
      CREATE TABLE ans_ai_providers (id TEXT PRIMARY KEY, name TEXT, base_url TEXT, status TEXT DEFAULT 'active', enabled INTEGER DEFAULT 1);
      CREATE TABLE ans_ai_models (id TEXT PRIMARY KEY, provider_id TEXT, name TEXT, capabilities TEXT DEFAULT '[]', context_window INTEGER, max_output_tokens INTEGER, input_price_per_1k REAL, output_price_per_1k REAL, status TEXT DEFAULT 'active', enabled INTEGER DEFAULT 1);
      CREATE TABLE ans_model_endpoints (id TEXT PRIMARY KEY, model_id TEXT, url TEXT, api_key_ref TEXT, priority INTEGER DEFAULT 0, weight REAL DEFAULT 1.0, status TEXT DEFAULT 'active', last_latency_ms INTEGER DEFAULT 0);

      INSERT INTO ans_ai_providers VALUES ('p1', 'openai', 'https://api.openai.com', 'active', 1);
      INSERT INTO ans_ai_providers VALUES ('p2', 'anthropic', 'https://api.anthropic.com', 'active', 1);
      INSERT INTO ans_ai_models VALUES ('m1', 'p1', 'gpt-4o', '["chat","vision"]', 128000, 4096, 0.005, 0.015, 'active', 1);
      INSERT INTO ans_ai_models VALUES ('m2', 'p2', 'claude-sonnet', '["chat","vision"]', 200000, 4096, 0.003, 0.015, 'active', 1);
      INSERT INTO ans_model_endpoints VALUES ('e1', 'm1', 'https://api.openai.com', 'enc_key_1', 0, 1.0, 'active', 0);
      INSERT INTO ans_model_endpoints VALUES ('e2', 'm2', 'https://api.anthropic.com', 'enc_key_2', 1, 1.0, 'active', 0);
    `);
  });

  it('excludes disabled model (C1: 启用开关生效)', () => {
    db.prepare("UPDATE ans_ai_models SET enabled = 0 WHERE id = 'm1'").run();
    const result = matchOptimalModel(db, { capabilities: ['chat'] });
    expect(result.primary).not.toBeNull();
    expect(result.primary!.model_id).not.toBe('m1');
    db.prepare("UPDATE ans_ai_models SET enabled = 1 WHERE id = 'm1'").run();
  });

  it('excludes models of disabled provider (C1: 供应商禁用则模型不可用)', () => {
    db.prepare("UPDATE ans_ai_providers SET enabled = 0 WHERE id = 'p1'").run();
    const result = matchOptimalModel(db, { capabilities: ['chat'] });
    expect(result.primary).not.toBeNull();
    expect(result.primary!.model_id).not.toBe('m1');
    db.prepare("UPDATE ans_ai_providers SET enabled = 1 WHERE id = 'p1'").run();
  });

  it('matches model by capabilities', () => {
    const result = matchOptimalModel(db, { capabilities: ['chat'] });
    expect(result.primary).not.toBeNull();
  });

  it('returns null when no model matches capabilities', () => {
    const result = matchOptimalModel(db, { capabilities: ['audio'] });
    expect(result.primary).toBeNull();
  });

  it('filters by cost', () => {
    const result = matchOptimalModel(db, { maxCostPer1k: 100, capabilities: ['chat'] });
    expect(result.primary).not.toBeNull();
  });

  it('prefers provider when specified', () => {
    const result = matchOptimalModel(db, { preferredProvider: 'p2', capabilities: ['chat'] });
    expect(result.primary).not.toBeNull();
    expect(result.primary!.model_id).toBe('m2');
  });

  it('C2: 同优先级下高质量模型被选中（cost-optimal 质量分纳入延迟/token效率）', () => {
    // 自包含独立库，避免共享库跨用例串扰
    const qdb = new Database(':memory:');
    qdb.exec(`
      CREATE TABLE ans_ai_providers (id TEXT PRIMARY KEY, name TEXT, base_url TEXT, status TEXT DEFAULT 'active', enabled INTEGER DEFAULT 1);
      CREATE TABLE ans_ai_models (id TEXT PRIMARY KEY, provider_id TEXT, name TEXT, capabilities TEXT DEFAULT '[]', context_window INTEGER, max_output_tokens INTEGER, input_price_per_1k REAL, output_price_per_1k REAL, status TEXT DEFAULT 'active', enabled INTEGER DEFAULT 1);
      CREATE TABLE ans_model_endpoints (id TEXT PRIMARY KEY, model_id TEXT, url TEXT, api_key_ref TEXT, priority INTEGER DEFAULT 0, weight REAL DEFAULT 1.0, status TEXT DEFAULT 'active', last_latency_ms INTEGER DEFAULT 0);
      CREATE TABLE ans_model_quality_logs (id TEXT PRIMARY KEY, model_id TEXT, project_id TEXT, success INTEGER DEFAULT 1, token_efficiency REAL, latency_ms INTEGER, created_at TEXT DEFAULT (datetime('now')));
      INSERT INTO ans_ai_providers VALUES ('pA', 'A', 'https://a.example', 'active', 1);
      INSERT INTO ans_ai_models VALUES ('mA', 'pA', 'model-good', '["chat"]', 128000, 4096, 0.005, 0.015, 'active', 1);
      INSERT INTO ans_ai_models VALUES ('mB', 'pA', 'model-bad', '["chat"]', 128000, 4096, 0.005, 0.015, 'active', 1);
      -- 同优先级 0 → 由质量分裁决
      INSERT INTO ans_model_endpoints VALUES ('eA', 'mA', 'https://a.example', 'keyA', 0, 1.0, 'active', 0);
      INSERT INTO ans_model_endpoints VALUES ('eB', 'mB', 'https://a.example', 'keyB', 0, 1.0, 'active', 0);
      -- mA 高质：3 成功、低延迟、高效率；mB 低质：3 失败
      INSERT INTO ans_model_quality_logs (id, model_id, success, token_efficiency, latency_ms) VALUES ('qa1','mA',1,0.9,300),('qa2','mA',1,0.95,400),('qa3','mA',1,0.9,500);
      INSERT INTO ans_model_quality_logs (id, model_id, success, token_efficiency, latency_ms) VALUES ('qb1','mB',0,0.2,9000),('qb2','mB',0,0.1,9500),('qb3','mB',0,0.3,8000);
    `);
    const result = matchOptimalModel(qdb, { strategy: 'cost-optimal', capabilities: ['chat'] });
    expect(result.primary).not.toBeNull();
    expect(result.primary!.model_id).toBe('mA'); // 同价 → 高质量模型胜出
    qdb.close();
  });

  it('③: cost-optimal 按成本升序（便宜优先），同价才看质量', () => {
    const qdb = new Database(':memory:');
    qdb.exec(`
      CREATE TABLE ans_ai_providers (id TEXT PRIMARY KEY, name TEXT, base_url TEXT, status TEXT DEFAULT 'active', enabled INTEGER DEFAULT 1);
      CREATE TABLE ans_ai_models (id TEXT PRIMARY KEY, provider_id TEXT, name TEXT, capabilities TEXT DEFAULT '[]', context_window INTEGER, max_output_tokens INTEGER, input_price_per_1k REAL, output_price_per_1k REAL, status TEXT DEFAULT 'active', enabled INTEGER DEFAULT 1);
      CREATE TABLE ans_model_endpoints (id TEXT PRIMARY KEY, model_id TEXT, url TEXT, api_key_ref TEXT, priority INTEGER DEFAULT 0, weight REAL DEFAULT 1.0, status TEXT DEFAULT 'active', last_latency_ms INTEGER DEFAULT 0);
      CREATE TABLE ans_model_quality_logs (id TEXT PRIMARY KEY, model_id TEXT, project_id TEXT, success INTEGER DEFAULT 1, token_efficiency REAL, latency_ms INTEGER, created_at TEXT DEFAULT (datetime('now')));
      INSERT INTO ans_ai_providers VALUES ('pA', 'A', 'https://a.example', 'active', 1);
      -- mCheap 便宜(0.001+0.003)但质量低(全失败)；mExpensive 贵(0.005+0.015)但质量高(全成功)
      INSERT INTO ans_ai_models VALUES ('mCheap', 'pA', 'cheap-bad', '["chat"]', 128000, 4096, 0.001, 0.003, 'active', 1);
      INSERT INTO ans_ai_models VALUES ('mExpensive', 'pA', 'expensive-good', '["chat"]', 128000, 4096, 0.005, 0.015, 'active', 1);
      -- mUnpriced 未定价(0) → 应排最后（成本未知，不当作免费最优）
      INSERT INTO ans_ai_models VALUES ('mUnpriced', 'pA', 'unpriced', '["chat"]', 128000, 4096, 0, 0, 'active', 1);
      INSERT INTO ans_model_endpoints VALUES ('eCheap', 'mCheap', 'https://a.example', 'k1', 0, 1.0, 'active', 0);
      INSERT INTO ans_model_endpoints VALUES ('eExpensive', 'mExpensive', 'https://a.example', 'k2', 0, 1.0, 'active', 0);
      INSERT INTO ans_model_endpoints VALUES ('eUnpriced', 'mUnpriced', 'https://a.example', 'k3', 0, 1.0, 'active', 0);
      INSERT INTO ans_model_quality_logs (id, model_id, success, token_efficiency, latency_ms) VALUES ('qc1','mCheap',0,0.2,3000),('qc2','mCheap',0,0.2,3000),('qc3','mCheap',0,0.2,3000);
      INSERT INTO ans_model_quality_logs (id, model_id, success, token_efficiency, latency_ms) VALUES ('qe1','mExpensive',1,0.9,300),('qe2','mExpensive',1,0.9,300),('qe3','mExpensive',1,0.9,300);
    `);
    const result = matchOptimalModel(qdb, { strategy: 'cost-optimal', capabilities: ['chat'] });
    expect(result.primary).not.toBeNull();
    expect(result.primary!.model_id).toBe('mCheap'); // 便宜优先（成本 0.004 < 0.02；未定价 0 排最后）
    qdb.close();
  });

  it('④: latency-optimal 按延迟升序（未检测排最后）', () => {
    const qdb = new Database(':memory:');
    qdb.exec(`
      CREATE TABLE ans_ai_providers (id TEXT PRIMARY KEY, name TEXT, base_url TEXT, status TEXT DEFAULT 'active', enabled INTEGER DEFAULT 1);
      CREATE TABLE ans_ai_models (id TEXT PRIMARY KEY, provider_id TEXT, name TEXT, capabilities TEXT DEFAULT '[]', context_window INTEGER, max_output_tokens INTEGER, input_price_per_1k REAL, output_price_per_1k REAL, status TEXT DEFAULT 'active', enabled INTEGER DEFAULT 1);
      CREATE TABLE ans_model_endpoints (id TEXT PRIMARY KEY, model_id TEXT, url TEXT, api_key_ref TEXT, priority INTEGER DEFAULT 0, weight REAL DEFAULT 1.0, status TEXT DEFAULT 'active', last_latency_ms INTEGER DEFAULT 0);
      CREATE TABLE ans_model_quality_logs (id TEXT PRIMARY KEY, model_id TEXT, project_id TEXT, success INTEGER DEFAULT 1, token_efficiency REAL, latency_ms INTEGER, created_at TEXT DEFAULT (datetime('now')));
      INSERT INTO ans_ai_providers VALUES ('pA', 'A', 'https://a.example', 'active', 1);
      INSERT INTO ans_ai_models VALUES ('mFast', 'pA', 'fast', '["chat"]', 128000, 4096, 0.005, 0.015, 'active', 1);
      INSERT INTO ans_ai_models VALUES ('mSlow', 'pA', 'slow', '["chat"]', 128000, 4096, 0.005, 0.015, 'active', 1);
      INSERT INTO ans_ai_models VALUES ('mUnmeasured', 'pA', 'unmeasured', '["chat"]', 128000, 4096, 0.005, 0.015, 'active', 1);
      INSERT INTO ans_model_endpoints VALUES ('eFast', 'mFast', 'https://a.example', 'k1', 0, 1.0, 'active', 300);
      INSERT INTO ans_model_endpoints VALUES ('eSlow', 'mSlow', 'https://a.example', 'k2', 0, 1.0, 'active', 2000);
      INSERT INTO ans_model_endpoints VALUES ('eUnmeasured', 'mUnmeasured', 'https://a.example', 'k3', 0, 1.0, 'active', 0);
    `);
    const result = matchOptimalModel(qdb, { strategy: 'latency-optimal', capabilities: ['chat'] });
    expect(result.primary).not.toBeNull();
    expect(result.primary!.model_id).toBe('mFast'); // 最低延迟(300ms)胜出；未检测(0)排最后
    qdb.close();
  });
});

/**
 * zx_20260921_1 M2: 零命中时说得出为什么。
 *
 * 判据**穿过生产入口**（调 `matchOptimalModel` 读 `result.diagnostics`），不直调 `explainMatchFailure`——
 * 后者成了"判据调生产绕开的实现"，正是本轮 §7 点名的头号风险。
 *
 * 四只标本各钉一个成因，且**四只都建在同一个库里**：这样"归因到哪一步"才是被真正分开验的，
 * 而不是四个各自为政的夹具各说各话。
 *
 * ⚠ zx_20261002 M14 **就地更新（有意为之）**：能力由"逐项硬 AND"改为**两段式降级**后，
 *   "只缺一项能力"不再归零（会降级选部分命中）。故这些用例的**入参**改为"**一项都不具备**"
 *   这一真正的零命中形态；漏斗里能力也由逐项步收成**一步** `EP_FUNNEL_ANY_CAPABILITY`。
 *   改动的是**判据的入参**，不是把判据改松——"该命中/该不命中"两面对照仍在（见 M14 一段）。
 */
describe('M2 (zx_20260921_1): 零命中成因逐层可归因', () => {
  /**
   * 一个库同时摆出四种成因各一只：
   *   · mOffProvider     —— 供应商 disabled           ⇒ 想验证「供应商未启用」
   *   · mDisabled        —— 模型 enabled=0            ⇒ 想验证「模型未启用」
   *   · mNoEndpoint      —— 模型可用但无 active 端点    ⇒ 想验证「缺端点但模型在册」
   *   · mChatOnly        —— 模型/端点在册但**不具备请求能力** ⇒ 想验证「无人具备任一请求能力」
   *   · mAudio           —— 唯一真能选中的那个（对照组：证明这套库本身是"选得出来"的）
   */
  const seed = () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE ans_ai_providers (id TEXT PRIMARY KEY, name TEXT, base_url TEXT, status TEXT DEFAULT 'active', enabled INTEGER DEFAULT 1);
      CREATE TABLE ans_ai_models (id TEXT PRIMARY KEY, provider_id TEXT, name TEXT, capabilities TEXT DEFAULT '[]', context_window INTEGER, max_output_tokens INTEGER, input_price_per_1k REAL, output_price_per_1k REAL, status TEXT DEFAULT 'active', enabled INTEGER DEFAULT 1);
      CREATE TABLE ans_model_endpoints (id TEXT PRIMARY KEY, model_id TEXT, url TEXT, api_key_ref TEXT, priority INTEGER DEFAULT 0, weight REAL DEFAULT 1.0, status TEXT DEFAULT 'active', last_latency_ms INTEGER DEFAULT 0);
      INSERT INTO ans_ai_providers VALUES ('pOn','qwen','https://on.example','active',1);
      INSERT INTO ans_ai_providers VALUES ('pOff','openai','https://off.example','active',0);
      INSERT INTO ans_ai_models VALUES ('mAudio','pOn','omni','["chat","audio"]',128000,4096,0.001,0.002,'active',1);
      INSERT INTO ans_ai_models VALUES ('mChatOnly','pOn','plain','["chat"]',128000,4096,0.001,0.002,'active',1);
      INSERT INTO ans_ai_models VALUES ('mDisabled','pOn','off','["chat","audio"]',128000,4096,0.001,0.002,'active',0);
      INSERT INTO ans_ai_models VALUES ('mNoEndpoint','pOn','no-ep','["chat","audio"]',128000,4096,0.001,0.002,'active',1);
      INSERT INTO ans_ai_models VALUES ('mOffProvider','pOff','other','["chat","audio"]',128000,4096,0.001,0.002,'active',1);
      INSERT INTO ans_model_endpoints VALUES ('eAudio','mAudio','https://on.example/v1','k1',0,1.0,'active',0);
      INSERT INTO ans_model_endpoints VALUES ('eChatOnly','mChatOnly','https://on.example/v1','k2',0,1.0,'active',0);
      INSERT INTO ans_model_endpoints VALUES ('eDisabled','mDisabled','https://on.example/v1','k3',0,1.0,'active',0);
      INSERT INTO ans_model_endpoints VALUES ('eOffProvider','mOffProvider','https://off.example/v1','k4',0,1.0,'active',0);
      INSERT INTO ans_model_endpoints VALUES ('eInactive','mAudio','https://on.example/v1','k5',0,1.0,'inactive',0);
    `);
    return db;
  };
  const stepOf = (f: Array<{ step: string; remaining: number }>, step: string) =>
    f.find((s) => s.step === step)?.remaining;

  it('对照组：这只库选得出 audio 模型（证明标本本身不是"怎么都选不出来"）', () => {
    const db = seed();
    const r = matchOptimalModel(db, { capabilities: ['chat', 'audio'] });
    expect(r.primary?.model_id).toBe('mAudio');
    db.close();
  });

  it('纯追加两面之一：成功路**不带** diagnostics（成功路不付这份只读聚合的钱）', () => {
    const db = seed();
    const r = matchOptimalModel(db, { capabilities: ['chat', 'audio'] });
    expect(r.primary).not.toBeNull();
    expect(r.diagnostics).toBeUndefined();
    db.close();
  });

  it('纯追加两面之二：零命中**必带** diagnostics，且漏斗末步与主查询同值（0）', () => {
    const db = seed();
    const r = matchOptimalModel(db, { capabilities: ['__no_such_cap__'] });
    expect(r.primary).toBeNull();
    const f = r.diagnostics!.endpointFunnel;
    expect(f.length).toBeGreaterThan(1);
    expect(f[f.length - 1]!.remaining).toBe(0); // 与主查询的 endpoints.length === 0 同值
    expect(f[0]!.remaining).toBeGreaterThan(0); // 库里确实有端点 ⇒ 不是"空库假绿"
    db.close();
  });

  it('成因④「无人具备任一请求能力」：端点漏斗在「至少命中一项请求能力」这一步归零，且 summary 点名该步', () => {
    const db = seed();
    // 去掉唯一真能收音频的那个 ⇒ 剩下的 active 端点没有一个所属模型具备 audio，但库里仍有 active 端点
    db.prepare("UPDATE ans_model_endpoints SET status='inactive' WHERE id='eAudio'").run();
    const r = matchOptimalModel(db, { capabilities: ['audio'] });
    const d = r.diagnostics!;
    const idx = d.endpointFunnel.findIndex((s) => s.step === EP_FUNNEL_ANY_CAPABILITY);
    expect(idx).toBeGreaterThan(0);
    expect(d.endpointFunnel[idx]!.remaining).toBe(0);
    // 前一步非 0 ⇒ 归零**确由这一步**造成，而不是更早某步就空了
    expect(d.endpointFunnel[idx - 1]!.remaining).toBeGreaterThan(0);
    expect(d.summary).toContain(EP_FUNNEL_ANY_CAPABILITY);
    db.close();
  });

  it('成因①「供应商未启用」：模型漏斗 在册模型→供应商启用 的差 = 1，且端点漏斗在同一步也恰好-1', () => {
    const db = seed();
    const d = matchOptimalModel(db, { capabilities: ['__no_such_cap__'] }).diagnostics!;
    expect(stepOf(d.modelFunnel, '在册模型')! - stepOf(d.modelFunnel, '供应商启用')!).toBe(1);
    // 端点漏斗里同样是这一步筛掉 mOffProvider 的那 1 个端点
    expect(stepOf(d.endpointFunnel, '模型 active 且启用')! - stepOf(d.endpointFunnel, '供应商启用')!).toBe(1);
    db.close();
  });

  it('成因②「模型未启用」：模型漏斗 供应商启用→模型active且启用 的差 = 1（且不含成因①那只）', () => {
    const db = seed();
    const d = matchOptimalModel(db, { capabilities: ['__no_such_cap__'] }).diagnostics!;
    expect(stepOf(d.modelFunnel, '供应商启用')! - stepOf(d.modelFunnel, '模型 active 且启用')!).toBe(1);
    db.close();
  });

  it('成因③「缺端点但模型在册」：模型漏斗末步较前一步 -1，而端点漏斗根本看不到那只模型', () => {
    const db = seed();
    const d = matchOptimalModel(db, { capabilities: ['__no_such_cap__'] }).diagnostics!;
    const before = stepOf(d.modelFunnel, '模型 active 且启用')!;
    const after = stepOf(d.modelFunnel, '有 active 端点')!;
    expect(before - after).toBe(1); // 恰是 mNoEndpoint 那只
    // 端点漏斗里它从未出现（没有端点行）——故"有 active 端点总数"这类端点计数**说不出**这一成因
    const epTotal = stepOf(d.endpointFunnel, '模型 active 且启用')!;
    expect(epTotal).toBe(3); // eAudio/eChatOnly/eOffProvider——不含 mNoEndpoint（压根没有端点行）；eDisabled 的模型 enabled=0 已在本步筛掉，eOffProvider 的供应商禁用留到**下一步**才筛
    db.close();
  });

  it('相邻步之差可归因：能力筛是**最后一步**，且它在四重门槛之后（末步归零 ⟺ 真零命中）', () => {
    const db = seed();
    const d = matchOptimalModel(db, { capabilities: ['__no_such_cap__'] }).diagnostics!;
    const steps = d.endpointFunnel.map((s) => s.step);
    // 漏斗是按"加条件"的次序长的，端点级门槛必须在能力筛**之前**，否则能力筛的剩数已含被门槛挡掉的
    expect(steps.indexOf('供应商启用')).toBeLessThan(steps.indexOf(EP_FUNNEL_ANY_CAPABILITY));
    // M14: 能力由逐项 AND 收成一步"至少一项命中"，且**排在最后**——故"漏斗末步剩数
    //   == 主查询有效候选数"这条性质对所有请求成立（末步归零即真零命中）。
    expect(steps.indexOf(EP_FUNNEL_ANY_CAPABILITY)).toBe(steps.length - 1);
    db.close();
  });

  it('缺省能力仍是 [chat]（本批没动这条既有行为：不带 capabilities 时照常选得出模型）', () => {
    const db = seed();
    const r = matchOptimalModel(db, {});
    // 有 chat 能力模型 ⇒ 不该零命中；这条钉的是"默认能力不是空数组"这个既有行为没被本批改坏
    expect(r.primary).not.toBeNull();
    expect(r.diagnostics).toBeUndefined();
    db.close();
  });
});

/**
 * zx_20261002 M14（孙子·知彼知己）：能力从**硬过滤**改为**两段式排序降级**。
 *
 * 病根：此前 `WHERE EXISTS(json_each …) AND …` 要求模型**同时具备全部**请求能力，
 * 差一项即整条零命中——明明有"能力略差但可用"的模型，却报"没有找到匹配的模型"；
 * 且 `capability-best` 策略**根本不读 capabilities**（只按 priority + 质量分），名不副实。
 *
 * 现规则（用户裁定「丙·两段式」）：
 *   · 全中池非空 ⇒ **只**在全中池里排；
 *   · 全中池为空、但至少一项命中 ⇒ 退用部分命中池，并以 `capabilityMatch:'partial'` 如实标明降级；
 *   · 连一项都不命中 ⇒ 仍走零命中路（如实抛出）。
 *
 * 本段钉三件事：两段式优先序（全中 / 降级 / 真零）、`capabilityMatch` 跨进程事实、
 * 以及 `MODEL_CAPABILITY_META[*].minContext` **真**参与硬门槛（此前只有 function-calling/
 * structured_output 硬编码 32000，表里 vision 8000 / reasoning 32000 等声明从不被读）。
 */
describe('M14 (zx_20261002): 能力两段式降级 + minContext 真门槛', () => {
  const seed = () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE ans_ai_providers (id TEXT PRIMARY KEY, name TEXT, base_url TEXT, status TEXT DEFAULT 'active', enabled INTEGER DEFAULT 1);
      CREATE TABLE ans_ai_models (id TEXT PRIMARY KEY, provider_id TEXT, name TEXT, capabilities TEXT DEFAULT '[]', context_window INTEGER, max_output_tokens INTEGER, input_price_per_1k REAL, output_price_per_1k REAL, status TEXT DEFAULT 'active', enabled INTEGER DEFAULT 1);
      CREATE TABLE ans_model_endpoints (id TEXT PRIMARY KEY, model_id TEXT, url TEXT, api_key_ref TEXT, priority INTEGER DEFAULT 0, weight REAL DEFAULT 1.0, status TEXT DEFAULT 'active', last_latency_ms INTEGER DEFAULT 0);
      INSERT INTO ans_ai_providers VALUES ('pA','A','https://a.example','active',1);
      -- 全中组：具备 chat+vision
      INSERT INTO ans_ai_models VALUES ('mFull','pA','full','["chat","vision"]',128000,4096,0.005,0.015,'active',1);
      -- 部分命中组：只有 chat（缺 vision），且**更便宜**——两段式失效时会误选它
      INSERT INTO ans_ai_models VALUES ('mChat','pA','chat','["chat"]',128000,4096,0.001,0.002,'active',1);
      -- 一项都不具备
      INSERT INTO ans_ai_models VALUES ('mOther','pA','other','["embedding"]',128000,4096,0.001,0.002,'active',1);
      -- 小上下文（2000 < vision 门槛 8000）：**声称**具备 vision 但应被硬门槛挡掉
      INSERT INTO ans_ai_models VALUES ('mSmallVision','pA','small','["chat","vision"]',2000,512,0.001,0.002,'active',1);
      INSERT INTO ans_model_endpoints VALUES ('eFull','mFull','https://a.example','k1',0,1.0,'active',0);
      INSERT INTO ans_model_endpoints VALUES ('eChat','mChat','https://a.example','k2',0,1.0,'active',0);
      INSERT INTO ans_model_endpoints VALUES ('eOther','mOther','https://a.example','k3',0,1.0,'active',0);
      INSERT INTO ans_model_endpoints VALUES ('eSmallVision','mSmallVision','https://a.example','k4',0,1.0,'active',0);
    `);
    return db;
  };

  it("两段式·全中优先：全中池非空 ⇒ 只在全中池里选，且 capabilityMatch='full'（更便宜的部分命中模型不被越池选中）", () => {
    const db = seed();
    const r = matchOptimalModel(db, { strategy: 'cost-optimal', capabilities: ['chat', 'vision'] });
    expect(r.primary?.model_id).toBe('mFull'); // mChat 更便宜但缺 vision ⇒ 不得越池
    expect(r.capabilityMatch).toBe('full');
    db.close();
  });

  it("两段式·降级：全中池为空但至少一项命中 ⇒ 退用部分命中池，capabilityMatch='partial'", () => {
    const db = seed();
    // 请求 chat+audio：无一模型同时具备，但若干模型具备 chat ⇒ 降级而非零命中
    const r = matchOptimalModel(db, { capabilities: ['chat', 'audio'] });
    expect(r.primary).not.toBeNull();
    expect(r.primary!.capabilities).toContain('chat'); // 选中的确是按"部分命中"降下来的
    expect(r.capabilityMatch).toBe('partial');
    db.close();
  });

  it('两段式·真零命中：连一项都不具备 ⇒ 仍走零命中路（primary=null、capabilityMatch 不在场、diagnostics 到场）', () => {
    const db = seed();
    const r = matchOptimalModel(db, { capabilities: ['__no_such_cap__'] });
    expect(r.primary).toBeNull();
    expect(r.capabilityMatch).toBeUndefined(); // 失败路没有"主模型满足度"可说
    expect(r.diagnostics).toBeDefined();
    db.close();
  });

  it('capability-best 名副其实：降级池里按**命中数**降序（缺得少者胜），不再只看 priority/质量', () => {
    const db = seed();
    // 请求 chat+vision+audio：fullPool 空；mFull 命中 2(chat,vision) > mChat 命中 1(chat)
    const r = matchOptimalModel(db, { strategy: 'capability-best', capabilities: ['chat', 'vision', 'audio'] });
    expect(r.capabilityMatch).toBe('partial');
    expect(r.primary?.model_id).toBe('mFull');
    db.close();
  });

  it('minContext 真门槛（表真被读）：vision 要求 ≥8000 ⇒ 声称具备 vision 而 ctx=2000 的模型被硬挡，ctx=128000 的入选', () => {
    const db = seed();
    const r = matchOptimalModel(db, { capabilities: ['vision'] });
    expect(r.primary?.model_id).toBe('mFull');
    expect(r.primary?.model_id).not.toBe('mSmallVision');
    db.close();
  });

  it('minContext 保持：function-calling 仍要求 ≥32000（由表派生，行为与旧硬编码一致）——两面标本：恰好达标入选、不足者被挡', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE ans_ai_providers (id TEXT PRIMARY KEY, name TEXT, base_url TEXT, status TEXT DEFAULT 'active', enabled INTEGER DEFAULT 1);
      CREATE TABLE ans_ai_models (id TEXT PRIMARY KEY, provider_id TEXT, name TEXT, capabilities TEXT DEFAULT '[]', context_window INTEGER, max_output_tokens INTEGER, input_price_per_1k REAL, output_price_per_1k REAL, status TEXT DEFAULT 'active', enabled INTEGER DEFAULT 1);
      CREATE TABLE ans_model_endpoints (id TEXT PRIMARY KEY, model_id TEXT, url TEXT, api_key_ref TEXT, priority INTEGER DEFAULT 0, weight REAL DEFAULT 1.0, status TEXT DEFAULT 'active', last_latency_ms INTEGER DEFAULT 0);
      INSERT INTO ans_ai_providers VALUES ('pA','A','https://a.example','active',1);
      INSERT INTO ans_ai_models VALUES ('mAtFloor','pA','at-floor','["function-calling"]',32000,4096,0.005,0.015,'active',1);
      INSERT INTO ans_ai_models VALUES ('mBelowFloor','pA','below','["function-calling"]',16000,4096,0.005,0.015,'active',1);
      INSERT INTO ans_model_endpoints VALUES ('eAtFloor','mAtFloor','https://a.example','k1',0,1.0,'active',0);
      INSERT INTO ans_model_endpoints VALUES ('eBelowFloor','mBelowFloor','https://a.example','k2',0,1.0,'active',0);
    `);
    const r = matchOptimalModel(db, { capabilities: ['function-calling'] });
    expect(r.primary?.model_id).toBe('mAtFloor'); // ctx 恰好 32000 ⇒ 达标
    expect(r.primary?.model_id).not.toBe('mBelowFloor'); // ctx 16000 ⇒ 被挡
    db.close();
  });
});
