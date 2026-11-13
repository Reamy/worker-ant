/**
 * zx_20261113_2「明」——连不上、不可用、没做完，各自说清；两本账并成一本。
 *
 * 判据分组（随批次逐步补齐）：
 *   S「基」构建钉 P1–P6 + 本轮方案在册与边界。
 *   T「通」本地网络声明 / IDE 终端闸 / TCP 优先诊断 / 用户侧动作转 awaiting_input。
 *   N「名」模型可用性两把尺 / 端点测试协议 / 嵌入元数据 / 本地无密钥。
 *   J「简」工具语法文案 / 探索配额 A3-D3 归一。
 *   E「省」目标复用 / 摘要去重 / 交付物过滤去重。
 *   X「显」暂停横幅 / 收口未提交提示。
 *
 * 纪律：
 *   - 轮次钉由 checkBuildPins 从真源派生，不写「只为下一轮」的字面量；
 *   - 断言文案禁含失败字形（汇总器按字形计数）；
 *   - 夹具按生产初始化顺序搭：先建服务/表，再插数据行；
 *   - 计数器类断言必须有 0→1 的正面证据。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildNotOlderThan, checkBuildPins, deriveBuildTag, stripKeepingLines } from './lib/rr-pins.js';
import { classifyShellNetworkError, networkHintFor, networkNoteFor } from '../apps/worker-ant-desktop/src/main/core/network-diagnosis.js';
import { looksLikeUserSideRequest } from '../apps/worker-ant-desktop/src/main/core/user-side-request.js';
import { describeModelAvailability } from '../apps/worker-ant-desktop/renderer/src/lib/model-availability.js';
import { embeddingEndpointNeedsKey, isLocalEndpointUrl } from '../apps/worker-ant-desktop/src/main/core/embedding-endpoint.js';
import { buildEndpointTestRequest } from '../apps/ans-server/src/services/endpoint-test.js';
import { evaluateMultiSegment, shellRejectPayloadForChar, stripSafeRedirections, validateReadonlyBashCommand } from '../apps/worker-ant-desktop/src/main/core/tool-guards.js';
import { deriveShellExploreQuota } from '../apps/worker-ant-desktop/src/main/core/tool-registry.js';
import { goalEventType } from '../apps/worker-ant-desktop/src/main/core/goal-event.js';
import { mergeCompactionSummaries } from '../apps/worker-ant-desktop/src/main/core/context-compaction.js';
import { isRuntimeArtifactPath } from '../apps/worker-ant-desktop/src/main/core/deliverable-types.js';
import { CommandWriteQueue } from '../apps/worker-ant-desktop/src/main/core/command-write-queue.js';
import { PAUSE_REASON_ACCEPTANCE_FAILED, PAUSE_REASON_AWAITING_INPUT, PAUSE_REASON_NO_OUTPUT } from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';
import { pausedBannerHeadline, pausedBannerHint } from '../apps/worker-ant-desktop/renderer/src/lib/pause-banner.js';
import { gitWorkingTreeAdvice } from '../apps/worker-ant-desktop/src/main/core/git-advisory.js';
import { DatabaseSync } from 'node:sqlite';
import {
  POSITIONS_DDL,
  createPosition,
  decidePositionLesson,
  insertPositionLessonCandidate,
  promotePositionLesson,
  updatePositionLessonContent,
  type PositionDb,
} from '../apps/worker-ant-desktop/src/main/core/positions.js';
import { isPostTerminalJobType, jobPendingKey } from '../apps/worker-ant-desktop/src/main/core/task-scheduler.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(a: unknown, b: unknown, label: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `${JSON.stringify(a)} = ${JSON.stringify(b)}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const readSrc = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');
const codeOf = (rel: string): string => stripKeepingLines(readSrc(rel)).join('\n');

/* ── S「基」轮次在册与构建钉 ─────────────────────────────────────────────── */

function sectionS(): void {
  console.log('\n【S】构建钉与本轮方案');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });

  const selfRound = path.basename(__filename, '.ts').replace(/^rr_/, '');
  const plan = readSrc(`plans/improve/${selfRound}.md`);
  ok(plan.includes(selfRound), 'S1 本轮方案在册且带轮次名');
  ok(plan.includes('责任应用') && plan.includes('配置可用') && plan.includes('可跑 chat'),
    'S2 方案记下三处核心区分（责任应用 / 配置可用 / 可跑 chat）');
  ok(plan.includes('M16') && plan.includes('B6'), 'S3 方案含 M1–M16 与 B0–B6 分批');
  ok(plan.includes('不改怡寿里后端') && plan.includes('系统 TCC'),
    'S4 方案记下边界（不改怡寿里后端 / 不改系统 TCC）');

  const { tag, count } = deriveBuildTag(readSrc(`${A}/src/main/core/agent-executor.ts`));
  eq(count, 1, 'S5 源码 build 轮次标识恰好 1 处');
  ok(buildNotOlderThan(tag, selfRound), 'S6 构建钉不早于本脚本轮次', `${tag} >= ${selfRound}`);
}

/* ── T「通」本地网络声明、诊断与启动闸（B1） ───────────────────────────── */

function runPreflight(env: NodeJS.ProcessEnv) {
  return spawnSync('bash', [path.join(root, 'scripts/preflight-terminal.sh')], {
    cwd: root, env, encoding: 'utf-8',
  });
}

function sectionT(): void {
  console.log('\n【T】本地网络声明、诊断与启动闸（B1）');

  // T1 一处真源：run.sh 与 desktop dev 脚本都引用同一 preflight。
  const runSh = readSrc(`${A}/run.sh`);
  const pkg = readSrc(`${A}/package.json`);
  ok(runSh.includes('scripts/preflight-terminal.sh'), 'T1 run.sh 引用共享 preflight');
  ok(pkg.includes('scripts/preflight-terminal.sh'), 'T1b desktop dev 脚本引用共享 preflight');

  // T2/T3 两只标本：IDE 终端拒绝、Apple_Terminal/空 放行。
  const baseEnv = { ...process.env, JETBRAINS_HOME: '', VSCODE_PID: '', TERMINAL_EMULATOR: '' };
  const ide = runPreflight({ ...baseEnv, TERM_PROGRAM: 'JetBrains-JediTerm' });
  ok(ide.status === 1, 'T2 IDE 终端退出 1', `status=${String(ide.status)}`);
  ok(String(ide.stdout).includes('Terminal.app') && String(ide.stdout).includes('本地网络'),
    'T2b 拒绝文案说清 Terminal.app 与本地网络原因');
  const ideNoTp = runPreflight({ ...baseEnv, TERM_PROGRAM: '', TERMINAL_EMULATOR: 'JetBrains-JediTerm' });
  ok(ideNoTp.status === 1, 'T2c 真标本：只有 TERMINAL_EMULATOR 也拦住', `status=${String(ideNoTp.status)}`);
  const term = runPreflight({ ...baseEnv, TERM_PROGRAM: 'Apple_Terminal' });
  ok(term.status === 0, 'T3 Apple_Terminal 放行', `status=${String(term.status)}`);
  const none = runPreflight({ ...baseEnv, TERM_PROGRAM: '' });
  ok(none.status === 0, 'T3b 无 TERM_PROGRAM 放行（CLI/CI）', `status=${String(none.status)}`);

  // T4 打包声明：mac.extendInfo 两键 + Bonjour 服务名与代码同源。
  const yml = readSrc(`${A}/electron-builder.yml`);
  ok(yml.includes('NSLocalNetworkUsageDescription'), 'T4 打包声明含 NSLocalNetworkUsageDescription');
  ok(yml.includes('_workerant._tcp') && yml.includes('_workerant-terminal._tcp'),
    'T4b 打包声明含两个 Bonjour 服务名');
  const inboundType = /INBOUND_MDNS_SERVICE\s*=\s*'([^']+)'/.exec(codeOf(`${A}/src/main/core/inbound-gate.ts`))?.[1] ?? '';
  const terminalType = /LAN_TERMINAL_SERVICE_TYPE\s*=\s*'([^']+)'/.exec(codeOf(`${A}/src/main/core/lan-terminals.ts`))?.[1] ?? '';
  ok(inboundType.length > 0 && terminalType.length > 0
    && yml.includes(`_${inboundType}._tcp`) && yml.includes(`_${terminalType}._tcp`),
    'T4c Bonjour 服务名由代码常量派生并与打包声明一致', `${inboundType} / ${terminalType}`);

  // T5 dev 补丁脚本：临时 plist 上幂等（不碰真实 Electron）。
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-plist-'));
  const tmpPlist = path.join(tmpDir, 'Info.plist');
  try {
    execFileSync('plutil', ['-create', 'xml1', tmpPlist]);
    const script = path.join(root, 'scripts/patch-dev-electron-plist.mjs');
    const first = spawnSync(process.execPath, [script, tmpPlist], { encoding: 'utf-8' });
    const second = spawnSync(process.execPath, [script, tmpPlist], { encoding: 'utf-8' });
    ok(first.status === 0 && second.status === 0, 'T5 dev plist 补丁两次均成功（幂等）', `rc=${String(first.status)}/${String(second.status)}`);
    const json = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', tmpPlist], { encoding: 'utf-8' }));
    ok(typeof json.NSLocalNetworkUsageDescription === 'string' && json.NSLocalNetworkUsageDescription.length > 0,
      'T5b 补丁后含用途说明');
    eq(json.NSBonjourServices, ['_workerant._tcp', '_workerant-terminal._tcp'], 'T5c 补丁后 Bonjour 服务名正确且不重复');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // T6 分类三标本 + 反证。
  eq(classifyShellNetworkError('java.net.NoRouteToHostException: No route to host'),
    'ehostunreach', 'T6 EHOSTUNREACH 识别');
  eq(classifyShellNetworkError('connect ECONNREFUSED 127.0.0.1:3306'), 'econnrefused', 'T6b ECONNREFUSED 识别');
  eq(classifyShellNetworkError('curl: (28) Connection timed out'), 'timeout', 'T6c timeout 识别');
  eq(classifyShellNetworkError('Build success in 156ms'), null, 'T6d 正常构建输出不误判');
  ok(networkHintFor('ehostunreach').includes('本地网络') && networkHintFor('ehostunreach').includes('nc'),
    'T7 命中提示含「本地网络」与 nc 复测');
  ok(networkNoteFor({ stderr: 'No route to host' }).length > 0, 'T7b networkNoteFor 命中 EHOSTUNREACH 返回提示');
  eq(networkNoteFor({ stderr: 'ECONNREFUSED' }), '', 'T7c refused 不追加（避免噪音）');

  // T8 接线三层：唯一实现 / 三处工具返回追加 / 反证本文件不另造分类器。
  const shell = codeOf(`${A}/src/main/core/tools/shell.ts`);
  ok((shell.match(/networkNoteFor\(r\)/g) || []).length === 3, 'T8 shell.ts 三处工具返回都接 networkNoteFor');
  ok((shell.match(/network_hint/g) || []).length === 3, 'T8b 三处回包都带 network_hint 键');
  ok(!shell.includes('function classifyShellNetworkError'), 'T8c 反证：shell.ts 不另造分类器');
  ok(codeOf(`${A}/src/main/core/network-diagnosis.ts`).includes('export function classifyShellNetworkError'),
    'T8d 唯一实现在 network-diagnosis.ts');

  // T9 用户侧动作识别：真标本命中 / 正常收尾与"建议"反证。
  ok(looksLikeUserSideRequest('请在仓库根目录执行：python3 backend/tools/verify.py\n跑完把最后 15 行贴给我。'),
    'T9 真标本（请在…执行 + 贴给我）命中');
  ok(!looksLikeUserSideRequest('已在 backend/ 新增 application-dev.yml，配置解析测试 3/3 通过。'),
    'T9b 正常完成收尾不命中');
  ok(!looksLikeUserSideRequest('如需验证可运行 pnpm test。如需帮助请告诉我。'),
    'T9c 仅建议（无请在…执行）不命中');
  ok(looksLikeUserSideRequest('在你本机终端执行以下命令，然后把结果贴给我。'),
    'T9d 无「请」字但「在你本机执行 + 把结果贴给我」仍命中');

  // T10 收口接线：命中后置 awaiting_input，且位置在 acceptance_failed 之前。
  const fin = codeOf(`${A}/src/main/core/exec-finalize.ts`);
  ok(fin.includes('looksLikeUserSideRequest(finalContent)'), 'T10 exec-finalize 接线用户侧识别');
  ok(fin.includes('PAUSE_REASON_AWAITING_INPUT') && fin.includes('persistAwaitingInput'),
    'T10b 命中后落 awaiting_input 与 ctx.awaiting_input');
  const iUser = fin.indexOf('looksLikeUserSideRequest(finalContent)');
  const iFailed = fin.indexOf("closeVerdict === 'failed'");
  ok(iUser >= 0 && iFailed >= 0 && iUser < iFailed, 'T10c 用户侧判定排在验收未通过分支之前');
  ok(fin.includes("closeVerdict === 'failed'") && fin.includes('PAUSE_REASON_ACCEPTANCE_FAILED'),
    'T10d 反证：验收未通过分支仍在（未被替换）');

  // T11 系统提示：用户侧动作铁律与 ask_user 绑定。
  const prompt = codeOf(`${A}/src/main/core/agent-executor.ts`);
  ok(prompt.includes('用户侧动作铁律') && prompt.includes('必须调用 ask_user'),
    'T11 系统提示含「用户侧动作铁律 ⇒ 必须 ask_user」');
}

/* ── N「名」模型可用性两把尺（B2） ─────────────────────────────────────── */

function sectionN(): void {
  console.log('\n【N】模型可用性两把尺（B2）');

  const embBase = { enabled: 1, available: true, has_endpoint: true, capabilities: '["embedding"]', providerEnabled: 1 };
  const embGeneral = describeModelAvailability(embBase);
  ok(embGeneral.usable && embGeneral.reason === null && embGeneral.label === '可用',
    'N1 嵌入模型按「配置可用」为可用（不再是缺 chat）', `${embGeneral.label}/${String(embGeneral.reason)}`);
  const embTask = describeModelAvailability({ ...embBase, requireChat: true });
  ok(!embTask.usable && embTask.reason === 'no_chat_capability',
    'N2 显式要求 chat 时才判缺 chat（另一把尺）', String(embTask.reason));
  const chatModel = describeModelAvailability({ enabled: 1, available: true, has_endpoint: true, capabilities: '["chat"]' });
  ok(chatModel.usable, 'N3 chat 模型仍为可用');
  ok(!describeModelAvailability({ ...embBase, enabled: 0 }).usable, 'N3b 反证：禁用仍不可用');
  ok(!describeModelAvailability({ ...embBase, has_endpoint: false }).usable, 'N3c 反证：无端点仍不可用');
  const unknownAvail = describeModelAvailability({ enabled: 1, available: undefined, has_endpoint: true, capabilities: '["embedding"]' });
  ok(!unknownAvail.usable && unknownAvail.reason === 'unknown', 'N3d 反证：未返回钥匙状态仍不当成可用');

  const page = codeOf(`${A}/renderer/src/pages/ModelsPage.tsx`);
  ok(page.includes('requireChat: opts?.requireChat ?? false'), 'N4 模型页默认不要求 chat');
  ok(page.includes("filter.status === 'task-capable'"), 'N4b 新增「可跑任务（需 chat）」筛选');
  ok(page.includes('嵌入模型：只用于向量/记忆检索'), 'N4c 嵌入模型提示在屏');
  ok(page.includes("caps.length === 1 && caps[0] === 'embedding'"), 'N4d 嵌入模型上下文列有如实说明');

  eq(buildEndpointTestRequest('http://localhost:11434/api/embed', 'nomic'),
    { method: 'POST', url: 'http://localhost:11434/api/embed', body: { model: 'nomic', input: 'ping' } },
    'N5 Ollama 原生 /api/embed 走 POST 原 URL');
  eq(buildEndpointTestRequest('https://api.openai.com/v1'),
    { method: 'GET', url: 'https://api.openai.com/v1/models' }, 'N5b OpenAI 兼容基址仍 GET /models');
  eq(buildEndpointTestRequest('http://h/api/embeddings', 'e'),
    { method: 'POST', url: 'http://h/api/embeddings', body: { model: 'e', prompt: 'ping' } },
    'N5c Ollama 旧版 /api/embeddings 用 prompt');
  const ansRoute = codeOf('apps/ans-server/src/routes/models.ts');
  ok(ansRoute.includes('buildEndpointTestRequest(ep.url, modelName)'), 'N5d ANS 端点测试接协议自适应');
  ok(ansRoute.includes('model_id: string'), 'N5e 端点测试取 model_id 以带出模型名');

  eq([isLocalEndpointUrl('http://localhost:11434/api/embed'), isLocalEndpointUrl('http://127.0.0.1:11434'),
    isLocalEndpointUrl('https://api.openai.com/v1'), isLocalEndpointUrl('http://192.168.6.68:11434')],
    [true, true, false, false], 'N6 本地回环判定四标本');
  eq([embeddingEndpointNeedsKey('http://localhost:11434/api/embed'), embeddingEndpointNeedsKey('https://api.openai.com/v1')],
    [false, true], 'N6b 本机不需要 Key、远端需要');
  const jobs = codeOf(`${A}/src/main/core/jobs/index.ts`);
  ok(jobs.includes('embeddingEndpointNeedsKey(embModel.url)') && jobs.includes('embModel.api_key ?'),
    'N6c embed-memory 作业接「本地免 Key」且不伪造 Authorization');
  ok(codeOf(`${A}/src/main/core/embedding-endpoint.ts`).includes('export function embeddingEndpointNeedsKey'),
    'N6d 唯一实现在 embedding-endpoint.ts');
}

/* ── J「简」工具语法与探索闸（B3） ─────────────────────────────────────── */

function sectionJ(): void {
  console.log('\n【J】工具语法与探索配额（B3）');

  eq(validateReadonlyBashCommand('cat backend/pom.xml 2>&1').ok, true, 'J1 bash 允许 2>&1');
  eq(validateReadonlyBashCommand('cat a > out 2>&1').ok, false, 'J1b 真重定向仍拒');
  const semi = shellRejectPayloadForChar(';', 'bash', root);
  ok(String(semi.advice).includes('execute_command'), 'J2 bash 遇 ; 点名 execute_command');
  const amp = shellRejectPayloadForChar('&', 'bash', root);
  ok(String(amp.advice).includes('execute_command'), 'J2b bash 遇 & 点名 execute_command');
  const cd = validateReadonlyBashCommand('cd backend');
  ok(!cd.ok && String(cd.payload.error).includes('execute_command'), 'J3 bash 遇 cd 点名 execute_command');
  ok(cd.ok || !String(cd.payload.error).includes('run_privileged'), 'J3b 反证：cd 不再被说成特权问题');
  eq(stripSafeRedirections('cat a 2>&1'), 'cat a ', 'J4 安全重定向只在校验前剥离');
  eq(stripSafeRedirections('cat a 1>&2'), 'cat a ', 'J4b 1>&2 同');
  ok(evaluateMultiSegment('ls 2>&1', 'execute_command', root).ok, 'J5 execute_command 多段校验允许 2>&1');

  const q30 = deriveShellExploreQuota(30, 'configuration');
  const q48 = deriveShellExploreQuota(48, 'configuration');
  eq([q30.soft, q30.hard], [9, 15], 'J6 maxSteps=30 派生 9/15');
  eq([q48.soft, q48.hard], [12, 20], 'J6b maxSteps=48 派生 12/20');
  ok(q30.softMsg.includes('硬线 15') && q48.softMsg.includes('硬线 20'), 'J7 软告警写明硬线');
  const step = codeOf(`${A}/src/main/core/exec-step.ts`);
  ok(step.includes('deriveShellExploreQuota(d.maxSteps, d.archetype).hard'), 'J8 D3 阈值由同一派生口给出');
  ok(!step.includes('CONVERGE_CMD_HARD'), 'J8b 反证：D3 不再引用手写常量');
  ok(step.includes('convergeHard'), 'J8c D3 文案用派生值');
  const registry = codeOf(`${A}/src/main/core/tool-registry.ts`);
  ok(registry.includes('硬线 ${hard} 次') && registry.includes('硬线 20 次'), 'J9 静态与派生文案都写明硬线');
}

/* ── E「省」resume 成本与产出账（B4） ───────────────────────────────────── */

async function sectionE(): Promise<void> {
  console.log('\n【E】resume 成本与交付物账（B4）');

  // M11 目标事件分型
  eq(goalEventType(true), 'task.goal_reused', 'E1 复用缓存 ⇒ goal_reused');
  eq(goalEventType(false), 'task.goal_identified', 'E1b 新识别 ⇒ goal_identified');
  const bus = codeOf(`${A}/src/main/core/event-bus.ts`);
  ok((bus.match(/'task\.goal_reused'/g) || []).length >= 2, 'E2 事件 union 与聚合映射两处都在册');
  ok(codeOf(`${A}/src/main/core/memory-manager.ts`).includes('reused: { goal: !needGoal && !!cachedGoal'),
    'E2b prelude 回传 reused 分型');
  ok(codeOf(`${A}/src/main/core/agent-executor.ts`).includes('goalEventType(!!prelude?.reused?.goal)'),
    'E2c 执行体按 reused 分型发事件');

  // M12 摘要去重
  eq(mergeCompactionSummaries('A', 'A'), 'A', 'E3 相同摘要不重复拼接');
  eq(mergeCompactionSummaries('A\n[续]B', 'B'), 'A\n[续]B', 'E3b 旧摘要已含新摘要 ⇒ 不重复');
  eq(mergeCompactionSummaries('A', 'A\n[续]B'), 'A\n[续]B', 'E3c 新摘要已含旧摘要 ⇒ 取新');
  eq(mergeCompactionSummaries('A', 'B'), 'A\n[续]B', 'E3d 不同摘要仍拼接');
  const compRun = codeOf(`${A}/src/main/core/context-compaction-run.ts`);
  ok(compRun.includes("startsWith('[压缩]')") && compRun.includes('mergeCompactionSummaries('),
    'E4 压缩运行段过滤 [压缩] 行并接去重合并');

  // M13 运行期产物过滤 + 去重（纯函数 + 真队列 0→1）
  eq([isRuntimeArtifactPath('/x/a.log'), isRuntimeArtifactPath('/x/a.pid'), isRuntimeArtifactPath('/x/a.rc'),
    isRuntimeArtifactPath('/x/__pycache__/a.pyc'), isRuntimeArtifactPath('/x/node_modules/a.js')],
    [true, true, true, true, true], 'E5 运行期产物五标本');
  eq([isRuntimeArtifactPath('/x/a.ts'), isRuntimeArtifactPath('/x/a.yml'), isRuntimeArtifactPath('/x/a.md')],
    [false, false, false], 'E5b 真产出三标本不误杀');
  const cwq = codeOf(`${A}/src/main/core/command-write-queue.ts`);
  ok(cwq.includes('isRuntimeArtifactPath') && cwq.includes('new Set(files)'), 'E6 补登记接过滤与去重');

  const now = Date.now();
  const q = new CommandWriteQueue();
  q.enqueue({ projectId: 'p', taskId: 't', workingDir: '/tmp/wa', sinceMs: now - 2000, via: 'execute_command' });
  const seen: string[] = [];
  const res = await q.flush({
    limit: 20,
    scan: {
      root: '/tmp/wa',
      files: [
        { abs: '/tmp/wa/a.log', rel: 'a.log', size: 1, mtimeMs: now - 1000 },
        { abs: '/tmp/wa/a.ts', rel: 'a.ts', size: 1, mtimeMs: now - 1000 },
        { abs: '/tmp/wa/a.ts', rel: 'a.ts', size: 1, mtimeMs: now - 1000 },
        { abs: '/tmp/wa/node_modules/x.js', rel: 'node_modules/x.js', size: 1, mtimeMs: now - 1000 },
      ],
      dirsScanned: 1,
      entriesScanned: 4,
      truncatedScan: false,
    },
    register: (abs) => { seen.push(abs); },
  });
  eq(seen, ['/tmp/wa/a.ts'], 'E7 真队列：日志/依赖目录被滤、同路径去重后只登记 1 条');
  eq(res, { found: 1, registered: 1 }, 'E7b 计数如实（0→1 正面）');
}

/* ── X「显」暂停横幅与收口提示（B5） ───────────────────────────────────── */

function sectionX(): void {
  console.log('\n【X】暂停横幅与收口提示（B5）');

  const acc = pausedBannerHeadline({ reason: PAUSE_REASON_ACCEPTANCE_FAILED, failed: 1, total: 1 });
  ok(acc.includes('验收未通过') && acc.includes('1 条未达') && acc.includes('共 1 条'), 'X1 验收未通过横幅报未达/总数', acc);
  ok(pausedBannerHint(PAUSE_REASON_ACCEPTANCE_FAILED).includes('验收标准核对'), 'X1b 提示指向验收块');
  const awaitH = pausedBannerHeadline({ reason: PAUSE_REASON_AWAITING_INPUT });
  ok(awaitH.includes('等待你的回复'), 'X2 等待输入横幅');
  ok(!pausedBannerHint(PAUSE_REASON_AWAITING_INPUT).includes('验收未通过'), 'X2b 反证：等待输入不说验收未通过');
  eq(pausedBannerHeadline({ reason: PAUSE_REASON_NO_OUTPUT }), '未达交付（无产出证据）', 'X3 无产出横幅');
  eq(pausedBannerHeadline({ reason: '', reasonLabel: '' }), '已暂停（因未记录）', 'X4 未记录因由如实说');
  const page = codeOf(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  ok(page.includes('pausedBannerHeadline(') && page.includes('pausedBannerHint('), 'X5 任务详情接横幅分型');
  ok(page.includes('id="acceptance-check"') && page.includes('查看验收块'), 'X5b 验收块锚点与跳转按钮在屏');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-git-'));
  try {
    execFileSync('git', ['init', '-q', tmp]);
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'x');
    const dirty = gitWorkingTreeAdvice(tmp);
    ok(dirty !== null && dirty.includes('未提交'), 'X6 脏工作树给出提示', dirty ?? 'null');
    execFileSync('git', ['-C', tmp, '-c', 'user.name=rr', '-c', 'user.email=rr@example.com', 'add', 'a.txt']);
    execFileSync('git', ['-C', tmp, '-c', 'user.name=rr', '-c', 'user.email=rr@example.com', 'commit', '-qm', 'x']);
    eq(gitWorkingTreeAdvice(tmp), null, 'X6b 干净工作树不提示');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-nogit-'));
  try {
    eq(gitWorkingTreeAdvice(nonGit), null, 'X6c 非 git 目录静默 null');
  } finally {
    fs.rmSync(nonGit, { recursive: true, force: true });
  }
  ok(codeOf(`${A}/src/main/core/exec-finalize.ts`).includes('gitWorkingTreeAdvice(workingDir)'), 'X7 run_close 接提示');
  ok(codeOf(`${A}/src/main/core/tools/control-finalize.ts`).includes('gitWorkingTreeAdvice(workingDir)'), 'X7b finalize_task 接提示');
  const gitMod = codeOf(`${A}/src/main/core/git-advisory.ts`);
  ok(!gitMod.includes("'commit'") && !gitMod.includes("'add'"), 'X8 反证：提示模块不执行 add/commit');
}

/* ── Z「补」岗位经验编辑 + 收口作业键（B7） ─────────────────────────────── */

function sectionZ(): void {
  console.log('\n【Z】岗位经验编辑与收口作业键（B7）');

  const db = new DatabaseSync(':memory:');
  db.exec(POSITIONS_DDL);
  // 生产同源邻表（`decidePositionLesson` 的 LEFT JOIN 读 title/name）。
  db.exec('CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, title TEXT);');
  db.exec('CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT);');
  const pdb = db as unknown as PositionDb;
  const p = createPosition(pdb, { name: '编辑岗', rules: [], skills: [], knowledge: [] });
  ok(p.ok, 'Z1 建岗位');
  if (!p.ok) return;
  const long = '经'.repeat(238);
  ok(insertPositionLessonCandidate(pdb, {
    positionId: p.position.id, taskId: 't1', projectId: 'pr1', content: long, reusable: true, source: 'retrospective',
  }), 'Z2 插入 238 字经验');
  const lesson = db.prepare("SELECT id, content, status FROM wa_position_lessons WHERE position_id = ?")
    .get(p.position.id) as { id: string; content: string; status: string };
  eq([lesson.content.length, lesson.status], [238, 'pending'], 'Z2b 经验本体 238 字、待审');
  ok(decidePositionLesson(pdb, lesson.id, 'accepted').ok, 'Z3 采纳');
  const before = promotePositionLesson(pdb, lesson.id, 'rules');
  ok(!before.ok && before.code === 'LESSON_TOO_LONG', 'Z4 未编辑直接晋升被拒（238>200）', before.ok ? '' : before.message);
  const upd = updatePositionLessonContent(pdb, lesson.id, '经'.repeat(180));
  ok(upd.ok && upd.lesson.content.length === 180 && upd.lesson.status === 'accepted', 'Z5 编辑到 180 字且状态仍采纳');
  const after = promotePositionLesson(pdb, lesson.id, 'rules');
  ok(after.ok && after.position.rules.includes('经'.repeat(180)), 'Z6 编辑后可晋升且段落文本是缩短后的');
  ok(!updatePositionLessonContent(pdb, lesson.id, '再改一次').ok, 'Z7 已晋升的经验不可再编辑（先撤回）');
  ok(!updatePositionLessonContent(pdb, lesson.id, '   ').ok, 'Z8 空内容拒绝');
  ok(!updatePositionLessonContent(pdb, 'nope', 'x').ok, 'Z9 不存在拒绝');

  const ipc = codeOf(`${A}/src/main/ipc/positions.ipc.ts`);
  ok(ipc.includes("positions:updateLesson") && ipc.includes('updatePositionLessonContent'), 'Z10 IPC 接线');
  ok(codeOf(`${A}/renderer/src/lib/ipc.ts`).includes('updateLesson:'), 'Z11 renderer IPC 接线');
  const page = codeOf(`${A}/renderer/src/pages/PositionsPage.tsx`);
  ok(page.includes('setEditingLesson(') && page.includes('saveLessonEdit(') && page.includes('超过晋升单条上限 200 字'),
    'Z12 岗位页编辑入口与 200 字提示');

  eq([
    jobPendingKey('ai-task', 'j1', { taskId: 't' }),
    jobPendingKey('resume-ai-task', 'j2', { taskId: 't' }),
    jobPendingKey('task-postlude', 'j3', { taskId: 't' }),
    jobPendingKey('background-review', 'j4', { taskId: 't' }),
  ], ['t', 't', 'task-postlude:t', 'background-review:t'], 'Z13 同任务的收口作业键不再互相覆盖');
  eq([isPostTerminalJobType('task-postlude'), isPostTerminalJobType('background-review'), isPostTerminalJobType('ai-task')],
    [true, true, false], 'Z14 收口后作业类型不被终态跳过');
  const sch = codeOf(`${A}/src/main/core/task-scheduler.ts`);
  ok(sch.includes('!isPostTerminalJobType(String(job.type))') && sch.includes('jobPendingKey(type, jobId, payload)'),
    'Z15 调度器接线（键分型 + 终态例外）');
  const ex = codeOf(`${A}/src/main/core/agent-executor.ts`);
  ok(ex.includes("promoteTaskFileDeliverables(db, taskId, 'post_command_flush')") && ex.includes("st === 'completed'"),
    'Z16 finalize_task 后命令补登记再归位（防成果被回 draft）');
}

async function main(): Promise<void> {
  sectionS();
  sectionT();
  sectionN();
  sectionJ();
  await sectionE();
  sectionX();
  sectionZ();

  console.log(`\n[rr_zx_20261113_2] ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error('\nrr_zx_20261113_2 未捕获异常（复跑未跑完，不得读作通过）：', e);
  console.log(`\n[rr_zx_20261113_2] ${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
