/**
 * D3: 子Agent类型注册表（从原工蚁 subagent-registry.ts 移植）。
 * 预设子Agent类型定义，支持tool白名单/黑名单+自定义system prompt。
 */

export interface SubagentType {
  name: string;
  description: string;
  allowTools?: string[];
  denyTools?: string[];
  systemPrompt?: string;
  maxSteps: number;
  timeout: number;
}

export const SUBAGENT_TYPES: Record<string, SubagentType> = {
  deploy: {
    name: 'deploy',
    description: '部署配置Agent：安装依赖、启动服务、检查进程',
    allowTools: ['bash', 'run_privileged', 'read_file', 'get_current_time', 'ask_user', 'write_file', 'create_deliverable', 'register_deliverable', 'finalize_task', 'find_mcp_service'],
    denyTools: ['spawn_subagent', 'enter_plan_mode', 'exit_plan_mode', 'create_task', 'escalate_to_human', 'search_web', 'read_web', 'git_clone'],
    systemPrompt: '你是部署配置专家Agent。只做依赖安装和服务启动，不要做代码分析或文档生成。完成后立即创建产出物并注册。',
    maxSteps: 8,
    timeout: 300_000,
  },
  explorer: {
    name: 'explorer',
    description: '探索Agent：文件检索、信息收集、环境检查',
    allowTools: ['read_file', 'list_files', 'get_current_time', 'search_content', 'bash'],
    denyTools: ['write_file', 'create_deliverable', 'register_deliverable', 'create_task', 'spawn_subagent', 'finalize_task', 'run_privileged', 'git_clone'],
    systemPrompt: '你是信息探索Agent。只读操作，收集信息后返回摘要。禁止写入文件或创建任务。',
    maxSteps: 5,
    timeout: 60_000,
  },
  builder: {
    name: 'builder',
    description: '构建Agent：代码编写、测试、产出物注册',
    allowTools: ['read_file', 'write_file', 'execute_command', 'git_clone', 'get_current_time', 'create_deliverable', 'register_deliverable', 'finalize_task'],
    denyTools: ['spawn_subagent', 'enter_plan_mode', 'exit_plan_mode', 'create_task', 'escalate_to_human'],
    systemPrompt: '你是代码构建Agent。编写代码、运行测试、注册产出物。完成后调用finalize_task。',
    maxSteps: 12,
    timeout: 300_000,
  },
  verifier: {
    name: 'verifier',
    description: '验证Agent：检查服务可用性、数据完整性、产出物质量',
    // zx_20261023_2 批一（道德经·「知者不言」）：验证者要能**跑一次**再下结论。
    //   此前只有 `bash`（只读白名单，连 `mvn` 都不在册）⇒ 编译/测试这条路结构上不存在，
    //   "验证 Agent"只能翻文件臆断。`execute_command` 是可写出、无 shell 元字符的那条路。
    allowTools: ['find_mcp_service', 'call_mcp_tool', 'read_file', 'bash', 'execute_command', 'get_current_time', 'read_web'],
    denyTools: ['write_file', 'create_deliverable', 'register_deliverable', 'create_task', 'spawn_subagent', 'finalize_task', 'run_privileged', 'git_clone'],
    // `bash` 只是只读白名单（构建/测试命令不在其中，如 `mvn`）——别用它试，会白费一步。
    systemPrompt: '你是验证Agent。你的工作不是确认实现有效——而是设法找出问题。只验证不修改。构建/测试一律走 execute_command（bash 仅只读白名单，不含 mvn 等构建命令）。',
    // 编译 + 读产物 + 再核一遍，5 步不够；冷缓存下一次 mvn compile 可能吃掉大半分钟。
    maxSteps: 10,
    timeout: 300_000,
  },
};

export function getSubagentType(name: string): SubagentType | undefined {
  return SUBAGENT_TYPES[name];
}

export function listSubagentTypes(): Array<{ name: string; description: string }> {
  return Object.entries(SUBAGENT_TYPES).map(([name, cfg]) => ({ name, description: cfg.description }));
}
