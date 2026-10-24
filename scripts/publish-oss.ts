/**
 * zx_20261005 批五 M19 / zx_20261011_5 批五 / zx_20261016_5「界」—— 开源发布导出脚本（导出「产品代码」，不导出「商业计划/内务」）。
 *
 * 病根：本仓同时装着**要开源的东西**（引擎/桌面端/ans-server/SDK/`scripts/`/`docs/`）
 *   与**不该开源的东西**（`apps/_archive/` 的历史包袱、`business-plan/` 的定价与商业策略、
 *   `plans/` 的**规划与实施过程**、`CLAUDE.md` 的**内务协作说明**）。若直接把整仓一推，这些就一并公开了
 *   ——**开源的是产品，不是内务**。
 *
 * 本脚本用 `git archive HEAD`（**只取已提交内容**，工作区脏文件不进）+ 路径排除，
 *   产出一个干净的 tar.gz，并**当场自证**：
 *     ① 归档内**无** `apps/_archive/`、`business-plan/`、`plans/`、`data/`、`CLAUDE.md`、`.gitleaksignore`；
 *     ② 归档内**无**被跟踪的 `.env`（唯一允许 `.env.example`）；
 *     ③ 归档内 LICENSE / README.md / README.en.md / CONTRIBUTING.md / COMMERCIAL_LICENSE.md **在场**；
 *     ④ 解包后扫**私钥**（`BEGIN … PRIVATE KEY`）与签名密钥文件名 ⇒ 命中即失败。
 *   任一不过 ⇒ 非 0 退出、**不交付产物**（承「发布前硬闸」纪律）。
 *
 * `--push <url>`：用**同一份干净树**建一个**全新历史**（`git init` + **单提交**，**丢弃本地历史**）
 *   并推到给定远端。之所以**不推本地历史**：本地 1954 次提交里含内务迭代痕迹与一枚已失活的
 *   一次性 iLink 钥匙（见 `.gitleaksignore`），公开仓只该有**产品快照**——历史留在本仓。
 *   ⚠ **同一份排除面**驱动 tar 导出与 push（`EXCLUDE_PREFIXES` 一处真源），不各写一份。
 *   ⚠ **重推须 `--force`**：远端 main 已存在且与全新历史无共同祖先 ⇒ non-fast-forward；公开仓只该是一份
 *   产品快照，重推＝整体替换（如 zx_20261016_5 把 `plans/project/` 扩为 `plans/`）。故 `pushFreshHistory` 用 `git push --force`。
 *
 * `--append <url>`（zx_20261015_1）：把本次导出树作为**一枚新提交**叠在**远端当前 `main`** 之上
 *   （父节点＝远端 `main`，diff＝自上次公开推送以来的全部变更），**普通推送、无 `--force`**。
 *   用途：让公开仓的历史**累积**（一次发布＝一枚提交），而非每次整体替换 ⇒ 不再孤儿化上一枚提交、
 *   tag 不再被甩在旧历史上（公开仓从"一张快照"变成"一个在长大的项目"）。
 *
 *   **提交信息须说清本次实际内容**（zx_20261018_3）：每枚提交都带 `Local-Head: <本地 sha>` 尾注；
 *   下一次 `--append` 读回上一枚公开提交的尾注，自动取 `git log <上次本地 sha>..HEAD --oneline`
 *   写进提交正文——公开仓的提交不再是一句"开源快照"，而是**这一批到底改了什么**。
 *   无尾注（旧提交/首次）或本地历史对不上 ⇒ 如实回退到 `--message` / `--message-file` 手写摘要，
 *   仍没有就只列本地 HEAD，不编造变更清单。
 *   ⚠ **与 `--push` 的取舍**：`--append` **不可事后擦除**——一旦推错的提交永久留在公开历史里，
 *   只能再补一枚"删除提交"（内容仍可查）；`--push --force` 能整体抹掉重来，代价是孤儿化历史。
 *   误发敏感内容的场景**仍应走 `--push`**（逃生门保留）。
 *   ⚠ **首次推送必须用 `--push`**：远端空仓无 `main` 可作父节点，脚本**显式拒**而非静默退化。
 *
 * ⚠ 本脚本只做**导出与结构自证**；**全历史**密钥扫描是 M20（`data/oss-scan-*.txt`），
 *   两者互补：本脚本看「导出的树」，M20 看「全部历史提交」。
 *
 * 用法：`npx tsx scripts/publish-oss.ts [--out <path>] [--push <git-url> | --append <git-url>]`
 *       `[--message <text> | --message-file <path>]`（发布提交正文摘要；缺省自动由本地 git log 派生）
 *       `[--title <text>]`（发布提交标题；缺省仍为「工蚁 (Worker Ant) — 开源快照 <sha>」）
 *       —— 标题须说清这一版交付了什么，不许只写"快照"。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 开源导出**必须排除**的路径（前缀匹配；文件项如 `CLAUDE.md` 用完整相对路径）。理由见 `business-plan/materials/open-source-scope.md` §3。
 *  `.gitleaksignore` 亦出局：其指纹**绑定本地旧提交 SHA**，与全新单提交历史毫无对应关系，留在公开仓只会误导（真误报已改为 inline `//gitleaks:allow`，随源码走）。
 *  `plans/` **整目录**出局（zx_20261016_5「界」）——它记的是"我们怎么想、怎么试、试错了几次"，是**内务**；
 *  产品仓该公开的是"这系统怎么造"。**推翻** §5 旧定案（原为"`improve/` 开、`project/` 不开"）的两条实测理由：
 *    ① **商业口径已漏**——`plans/improve/zx_20261008.md` 记着「R1 裁定（自然人主体）⇒ 无开票能力 ⇒ Team 暂不售卖、
 *       企业线关闭」这类**路线裁定与理由**，正是排除 `business-plan/` 要挡的东西（⚠ 价格本身不是秘密，见 `README.md` ——
 *       漏的是"为什么这么定、哪些现在卖不了"的推理）；
 *    ② **真钥匙已漏过**——历史提交里的 iLink 文件钥匙曾随 `plans/improve/zx_20260924.md` 一同上线（见 `oss-secret-scan.sh` §7）。
 *  内容资产（工程哲学复盘）改由 `docs/engineering-log.md` 的**公开摘要**承接——留故事，不留细节。
 *  ⚠ **本行须保持单行**：`scripts/oss-secret-scan.sh` 用 sed 按 `^const EXCLUDE_PREFIXES = \[(.*)\];$` 解析它；换行即令扫面**静默塌缩**。 */
const EXCLUDE_PREFIXES = ['apps/_archive/', 'business-plan/', 'plans/', 'data/', 'CLAUDE.md', '.gitleaksignore'];
/** 排除后**必须仍在场**的关键文件（M17/M18 交付物 + 项目入口）。 */
const MUST_HAVE = ['LICENSE', 'README.md', 'README.en.md', 'CONTRIBUTING.md', 'COMMERCIAL_LICENSE.md'];
/** 归档内允许存在的 `.env*`（其余 `.env` / `.env.*` 一律视为泄漏）。 */
const ENV_ALLOWLIST = ['.env.example'];

function sh(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
}

function fail(msg: string): never {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

/**
 * 从**上一枚公开提交**的 `Local-Head:` 尾注派生本次摘要（本地提交列表）。
 * 尾注缺失 / 基线不是 HEAD 祖先 ⇒ 返回空数组（调用方如实回退，不编造变更）。
 */
function summaryFromPreviousPublic(root: string, previousMessage: string): string[] {
  const m = /^Local-Head:\s*([0-9a-f]{7,40})\s*$/m.exec(previousMessage);
  if (!m) return [];
  const base = m[1]!;
  try {
    sh('git', ['merge-base', '--is-ancestor', base, 'HEAD'], root);
  } catch {
    return [];
  }
  const out = sh('git', ['log', '--no-merges', '--format=- %s', `${base}..HEAD`], root).trim();
  if (!out) return [];
  const lines = out.split('\n').filter(Boolean);
  const MAX = 50;
  if (lines.length <= MAX) return lines;
  const head = sh('git', ['rev-parse', '--short', 'HEAD'], root).trim();
  return [...lines.slice(0, MAX), `- …另 ${lines.length - MAX} 笔（完整列表见本地仓 git log ${base.slice(0, 7)}..${head}）`];
}

/**
 * 公开提交信息：**说清这一批实际改了什么**（zx_20261018_3）。
 *   · 摘要优先取 `--message` / `--message-file`，否则取由上一枚公开提交尾注派生的本地提交列表；
 *   · 两者都没有 ⇒ 如实说"未能定位"，只列本地 HEAD，不编造；
 *   · 每枚提交都带 `Local-Head: <sha>`——下一次 `--append` 靠它把本地区间接上。
 */
function buildCommitMessage(title: string, localHead: string, summary: string[], override?: string): string {
  const body = override?.trim() ? override.trim().split('\n') : summary;
  const lines = [title, ''];
  if (body.length > 0) {
    lines.push('本次变更：', '', ...body, '');
  } else {
    lines.push('本次变更未能从上一枚公开提交自动定位（旧提交无 Local-Head 尾注或本地基线不可达）。', '');
  }
  lines.push(
    'AGPL-3.0-only。本仓为**产品代码快照**；不含内部商业计划 / 历史归档 / 内务协作说明。',
    '',
    `Local-Head: ${localHead}`,
  );
  return lines.join('\n');
}

/** ① `git archive HEAD` + 路径排除 → 干净 tar.gz。 */
function buildArchive(root: string, outAbs: string): void {
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  const archiveArgs = ['archive', '--format=tar.gz', '--prefix=worker-ant-oss/', '-o', outAbs, 'HEAD'];
  for (const p of EXCLUDE_PREFIXES) archiveArgs.push(`:(exclude)${p.replace(/\/$/, '')}`);
  sh('git', archiveArgs, root);
}

/** 解包到临时目录，返回 `{ tmp, extracted }`（调用方负责 `rmSync(tmp)`）。 */
function extractArchive(outAbs: string): { tmp: string; extracted: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-export-'));
  sh('tar', ['-xzf', outAbs, '-C', tmp]);
  return { tmp, extracted: path.join(tmp, 'worker-ant-oss') };
}

/** 解包树内的全部文件（相对路径，已排序）。 */
function listFiles(extracted: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(extracted, p));
    }
  };
  walk(extracted);
  return out.sort();
}

/** ②–④ 结构 + 内容自证；返回问题条数（0 = 通过）。 */
function verify(extracted: string, files: string[]): number {
  let red = 0;
  for (const bad of EXCLUDE_PREFIXES) {
    const hit = files.filter((f) => f.startsWith(bad));
    if (hit.length) { console.error(`  ✗ 排除失败：${bad} 仍有 ${hit.length} 项（如 ${hit[0]}）`); red++; }
    else console.log(`  ✓ 已排除：${bad}`);
  }
  for (const must of MUST_HAVE) {
    if (files.includes(must)) console.log(`  ✓ 在场：${must}`);
    else { console.error(`  ✗ 缺失：${must}（M17/M18 交付物未进导出）`); red++; }
  }
  const envFiles = files.filter((f) => /(^|\/)\.env($|\.)/.test(f) && !ENV_ALLOWLIST.includes(path.basename(f)));
  if (envFiles.length) { console.error(`  ✗ 归档内含被跟踪的 .env：${envFiles.join(', ')}`); red++; }
  else console.log(`  ✓ 无被跟踪的 .env（仅允许 ${ENV_ALLOWLIST.join('/')}）`);

  const offenders: string[] = [];
  for (const f of files) {
    if (/license-signing-key.*\.pem$/i.test(f)) { offenders.push(`${f} (签名私钥文件名)`); continue; }
    if (!/\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml|env|example|txt|pem|key)$/i.test(f)) continue;
    const body = fs.readFileSync(path.join(extracted, f), 'utf-8');
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(body)) offenders.push(`${f} (内嵌私钥)`);
  }
  if (offenders.length) { console.error(`  ✗ 导出产物扫出私钥（${offenders.length} 处）：\n  - ${offenders.join('\n  - ')}`); red++; }
  else console.log('  ✓ 解包后无私钥（BEGIN … PRIVATE KEY / 签名密钥文件名）');
  return red;
}

/**
 * 用干净树在**临时目录**建**全新历史**（单提交，**不继承本地历史**）并推到 `url`。
 * 作者署名沿用本仓 `user.name` / `user.email`（不改全局配置）。
 */
function pushFreshHistory(root: string, extracted: string, files: string[], url: string, override?: string, titleOverride?: string): void {
  const git = (args: string[]): string => sh('git', args, extracted);
  const name = sh('git', ['config', 'user.name'], root).trim();
  const email = sh('git', ['config', 'user.email'], root).trim();

  git(['-c', 'init.defaultBranch=main', 'init']);
  git(['config', 'user.name', name]);
  git(['config', 'user.email', email]);
  // `-f`：导出树是**已提交内容**的投影，即使匹配 `.gitignore` 也须原样进仓（如被跟踪的 .env.example）。
  git(['add', '-A', '-f']);
  const committed = sh('git', ['diff', '--cached', '--name-only'], extracted).split('\n').filter(Boolean).length;
  if (committed !== files.length) {
    fail(`全新历史提交数与导出树不符（提交 ${committed} vs 树 ${files.length}）——似有 .gitignore 吞件，不推。`);
  }
  // 首发/重推也记 `Local-Head`：若将来改用 `--append`，它能把公开历史与本地区间接上。
  const localHead = sh('git', ['rev-parse', 'HEAD'], root).trim();
  git(['commit', '-q', '-m', buildCommitMessage(titleOverride ?? '工蚁 (Worker Ant) — 开源首发快照', localHead, [], override)]);
  const sha = sh('git', ['rev-parse', '--short', 'HEAD'], extracted).trim();
  console.log(`  ✓ 全新历史已建：单提交 ${sha}，${files.length} 个文件，作者 ${name} <${email}>`);
  console.log(`  → 推送：git push --force ${url} HEAD:main`);
  // 重推时远端 main 已存在且与全新历史**无共同祖先** ⇒ 必为 non-fast-forward，须 `--force` 整体覆盖。
  // 这是**有意的**：公开仓只该是一份产品快照；重推＝用新快照替换旧快照，非增量叠加。
  git(['push', '--force', url, 'HEAD:main']);
  console.log(`  ✓ 已推送：${url}（main，--force 覆盖）`);
}

/**
 * zx_20261015_1 —— 把干净树作为**一枚新提交**叠在远端 `main` 之上（**增量累积历史**）。
 * 父节点＝远端 `main` ⇒ 该提交的 diff 恰为「自上次公开推送以来的全部变更」；普通推送，无 `--force`。
 * **提交前**自证（索引逐项 == 导出树），不过则**不提交、不推送**——承「慎重初战」（B2 不可事后擦除）。
 */
function pushAppendHistory(root: string, extracted: string, files: string[], url: string, override?: string, titleOverride?: string): void {
  const name = sh('git', ['config', 'user.name'], root).trim();
  const email = sh('git', ['config', 'user.email'], root).trim();
  const localHead = sh('git', ['rev-parse', 'HEAD'], root).trim();

  if (!sh('git', ['ls-remote', '--heads', url, 'main']).trim()) {
    fail(`远端没有 \`main\`（${url}）——首次发布必须用 \`--push\`；\`--append\` 需要一枚既有提交作父节点。`);
  }

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-append-'));
  try {
    const git = (args: string[]): string => sh('git', args, repo);
    // 不依赖 `git clone` 的默认分支启发式：显式 fetch `main` 再 reset，父节点必为远端 main。
    git(['-c', 'init.defaultBranch=main', 'init']);
    git(['remote', 'add', 'origin', url]);
    git(['fetch', '--quiet', 'origin', 'main']);
    git(['reset', '--hard', 'FETCH_HEAD']);
    git(['config', 'user.name', name]);
    git(['config', 'user.email', email]);
    const parent = git(['rev-parse', '--short', 'HEAD']).trim();

    // 清空工作树（保留 .git）→ 覆盖为本次导出树。
    for (const e of fs.readdirSync(repo)) {
      if (e !== '.git') fs.rmSync(path.join(repo, e), { recursive: true, force: true });
    }
    fs.cpSync(extracted, repo, { recursive: true });

    // `-f`：导出树是**已提交内容**的投影，即使匹配 `.gitignore` 也须原样进仓（如被跟踪的 .env.example）。
    git(['add', '-A', '-f']);
    const staged = git(['ls-files']).split('\n').map((s) => s.trim()).filter(Boolean).sort();
    const want = [...files].sort();
    const missing = want.filter((f) => !staged.includes(f));
    const extra = staged.filter((f) => !want.includes(f));
    if (missing.length || extra.length) {
      fail(
        `提交前自证未过（**不提交、不推送**）：索引与导出树不符——缺失 ${missing.length} 项` +
          `${missing[0] ? `（如 ${missing[0]}）` : ''}、多余 ${extra.length} 项${extra[0] ? `（如 ${extra[0]}）` : ''}。`,
      );
    }

    // 导出树与远端 main **逐字节相同** ⇒ 无可提交（再 append 一次只会撞 `nothing to commit`）⇒ 如实跳过。
    if (!git(['diff', '--cached', '--name-only', 'HEAD']).trim()) {
      console.log(`  ✓ 无变更：导出树与远端 main（${parent}）一致，**不新建提交、不推送**。`);
      return;
    }

    // 父提交即上一枚公开快照：读它的 `Local-Head:` 尾注，把「上次公开的本地基线 → 本次本地 HEAD」
    // 之间的提交标题写进提交正文。尾注缺失/不可达 ⇒ 空摘要，由 `--message` 兜底（不编造）。
    const previousMessage = git(['log', '-1', '--format=%B']);
    const summary = summaryFromPreviousPublic(root, previousMessage);
    if (summary.length > 0) {
      console.log(`  ✓ 摘要：自上次公开基线起 ${summary.length} 笔本地提交`);
    } else if (!override) {
      console.log('  ⚠ 摘要：上一枚公开提交无 Local-Head 尾注（或基线不可达），本次如实记"未能自动定位"。');
    }
    const title = titleOverride ?? `工蚁 (Worker Ant) — 开源快照 ${localHead.slice(0, 7)}`;
    git(['commit', '-q', '-m', buildCommitMessage(title, localHead, summary, override)]);
    const sha = git(['rev-parse', '--short', 'HEAD']).trim();
    console.log(`  ✓ 已建新提交：${parent} → ${sha}（父＝远端 main），${files.length} 个文件，作者 ${name} <${email}>`);
    console.log(`  → 推送：git push ${url} HEAD:main（**无** --force）`);
    // 远端在 fetch 之后又动过 ⇒ non-fast-forward，git 自行拒绝；如实报错，**不**静默转 force。
    git(['push', url, 'HEAD:main']);
    console.log(`  ✓ 已推送：${url}（main，增量追加，未 force）`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const outFlag = argv.indexOf('--out');
  const pushFlag = argv.indexOf('--push');
  const appendFlag = argv.indexOf('--append');
  const pushUrl = pushFlag >= 0 ? argv[pushFlag + 1] : undefined;
  const appendUrl = appendFlag >= 0 ? argv[appendFlag + 1] : undefined;
  if (pushUrl && appendUrl) fail('`--push` 与 `--append` 互斥，只能给一个。');

  const titleFlag = argv.indexOf('--title');
  const titleOverride = titleFlag >= 0 ? argv[titleFlag + 1] : undefined;
  if (titleFlag >= 0 && (!titleOverride || titleOverride.startsWith('--'))) {
    fail('`--title` 需要一个字符串参数（一次提交一枚标题，不要换行）。');
  }

  // 发布提交正文摘要：显式文本优先；`--message-file` 供多行摘要（shell 里转义换行不可读）。
  // 两者都不给 ⇒ 由上一枚公开提交的 `Local-Head:` 尾注自动派生（见 pushAppendHistory）。
  const msgFlag = argv.indexOf('--message');
  const msgFileFlag = argv.indexOf('--message-file');
  if (msgFlag >= 0 && msgFileFlag >= 0) fail('`--message` 与 `--message-file` 互斥，只能给一个。');
  let messageOverride: string | undefined;
  if (msgFlag >= 0) {
    const v = argv[msgFlag + 1];
    if (!v) fail('`--message` 需要一个字符串参数（多行请用 `--message-file`）。');
    messageOverride = v;
  } else if (msgFileFlag >= 0) {
    const p = argv[msgFileFlag + 1];
    if (!p) fail('`--message-file` 需要一个文件路径。');
    const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
    if (!fs.existsSync(abs)) fail(`摘要文件不存在：${abs}`);
    messageOverride = fs.readFileSync(abs, 'utf-8');
  }
  const root = sh('git', ['rev-parse', '--show-toplevel']).trim();
  const headShort = sh('git', ['rev-parse', '--short', 'HEAD'], root).trim();
  const outRel = outFlag >= 0 ? argv[outFlag + 1]! : `release/worker-ant-oss-${headShort}.tar.gz`;
  const outAbs = path.isAbsolute(outRel) ? outRel : path.join(root, outRel);

  console.log(`[M19] 开源导出：HEAD=${headShort} → ${path.relative(root, outAbs)}`);
  console.log(`[M19] 排除路径：${EXCLUDE_PREFIXES.join(' , ')}`);
  if (pushUrl) console.log(`[M19] push 目标：${pushUrl}（**全新历史**：单提交，不推本地历史，--force 覆盖）`);
  if (appendUrl) console.log(`[M19] append 目标：${appendUrl}（**增量累积**：一枚新提交叠在远端 main 之上，无 --force）`);

  // ① 导出：git archive 只取 HEAD 已提交内容；:(exclude) 路径排除。
  buildArchive(root, outAbs);
  const size = fs.statSync(outAbs).size;
  console.log(`[M19] 归档已生成：${(size / 1024 / 1024).toFixed(2)} MB`);

  // ②–④ 解包 → 结构/内容自证。
  const { tmp, extracted } = extractArchive(outAbs);
  try {
    const files = listFiles(extracted);
    if (verify(extracted, files) > 0) fail(`导出结构自证未过，**不交付**：${path.relative(root, outAbs)}`);
    console.log(`\n✅ M19 开源导出通过：${path.relative(root, outAbs)}（${files.length} 个文件）`);

    if (pushUrl) {
      console.log(`\n[publish] 建**全新历史**并推送 → ${pushUrl}`);
      pushFreshHistory(root, extracted, files, pushUrl, messageOverride, titleOverride);
    }
    if (appendUrl) {
      console.log(`\n[publish] **增量追加**一枚提交并推送 → ${appendUrl}`);
      pushAppendHistory(root, extracted, files, appendUrl, messageOverride, titleOverride);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('   注：全历史密钥扫描见 M20（data/oss-scan-*.txt）；推送公开远端前两者都须通过。');
}

main();
