#!/usr/bin/env bash
# zx_20261005 批五 M20 —— 开源发布前「全历史密钥 / 隐私」硬闸扫描。
#
# 依据：business-plan/materials/open-source-scope.md §6.2（git history ≠ HEAD，历史必扫）。
# 一旦推送到公开远端，历史里的密钥 = 永久泄露（删了当前文件也不够，历史还在）。
#
# 本脚本跑：① gitleaks（全历史，redact）；② 个人绝对路径；③ 疑似真实密钥；
#   ③b iLink 帧钥匙形态（**只扫发布面**，补 gitleaks 的『标识符不紧邻』盲区）；
#   ④ 历次被加入过的 .env；⑤ 现行树受跟踪的 .env（须为空）；⑥ 大文件（防历史塞过 dmg/db）。
# 全部结果 **存档** data/oss-scan-<date>.txt（作发布前固证）。
#
# 用法： bash scripts/oss-secret-scan.sh [YYYYMMDD]
#   若 gitleaks 不在 PATH：GITLEAKS_BIN=/path/to/gitleaks bash scripts/oss-secret-scan.sh
# 退出码：0 = 无阻断项；1 = 有阻断项（**不得推送**，先轮换密钥 / 清历史）。
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT"
DATE="${1:-$(date +%Y%m%d)}"
OUT="data/oss-scan-${DATE}.txt"
GL="${GITLEAKS_BIN:-$(command -v gitleaks || true)}"
mkdir -p data

# 全历史唯一 blob 内容（一次性取出，供 ②③ 复用；避免逐提交 grep 的爆炸耗时）。
BLOBS="$(mktemp)"; CONTENTS="$(mktemp)"
trap 'rm -f "$BLOBS" "$CONTENTS"' EXIT
git cat-file --batch-all-objects --batch-check='%(objecttype) %(objectname)' \
  | awk '$1=="blob"{print $2}' > "$BLOBS"
git cat-file --batch-all-objects --batch 2>/dev/null > "$CONTENTS"

{
  echo "################################################################"
  echo "# 工蚁 · 开源发布前 全历史密钥/隐私扫描（zx_20261005 M20 硬闸）"
  echo "# 日期：${DATE}   HEAD：$(git rev-parse --short HEAD)   全历史提交：$(git rev-list --count --all)   唯一 blob：$(wc -l < "$BLOBS" | tr -d ' ')"
  echo "# 依据：business-plan/materials/open-source-scope.md §6.2"
  echo "################################################################"
  echo

  echo "## 1. gitleaks（全历史，redact）"
  if [ -n "$GL" ]; then
    echo "\$ $GL detect --source . --log-opts=\"--all\" --redact -v"
    "$GL" detect --source . --log-opts="--all" --redact -v --no-banner
    gl_code=$?
    echo "→ gitleaks exit=${gl_code}（0=无泄漏）"
    # 非 0 = 有泄漏（或用例错误）⇒ 一律阻断；『未做』与『做了没过』都不得放行。
    [ "$gl_code" -ne 0 ] && echo "BLOCKER"
  else
    echo "→ 跳过：未找到 gitleaks（设 GITLEAKS_BIN 或安装后重跑）。**此项未做，不算通过。**"
    echo "BLOCKER"
  fi
  echo

  echo "## 2. 个人绝对路径（/Users/<name>/、/home/<name>/）——扫全部唯一 blob"
  hits2="$(grep -aoE '/(Users|home)/[A-Za-z][A-Za-z0-9_.-]*' "$CONTENTS" | sort | uniq -c | sort -rn | head -40 || true)"
  if [ -z "$hits2" ]; then echo "→ ✅ 无命中"; else echo "$hits2"; echo "→ ⚠ 命中（评估：README/脚本常见可接受；含令牌/内网地址则须清）"; fi
  echo

  echo "## 3. 疑似真实密钥（赋值形态 + 高熵串）——扫全部唯一 blob"
  hits3="$(grep -aoE "(api[_-]?key|secret|token|password|passwd|private[_-]?key)['\"]?[[:space:]]*[:=][[:space:]]*['\"]?[A-Za-z0-9/+_-]{20,}" "$CONTENTS" | sort -u | head -40 || true)"
  if [ -z "$hits3" ]; then echo "→ ✅ 无命中"; else echo "$hits3"; echo "→ ⚠ 命中（对照 §6.1：dev-key/test 夹具可接受，真实值须轮换+清历史）"; fi
  echo

  echo "## 3b. iLink 帧钥匙形态 —— 只扫**发布面**（HEAD 树 − publish-oss.ts 的 EXCLUDE_PREFIXES）"
  # ⚠ zx_20261016_5「界」：`plans/` 已整体出局 ⇒ 本项扫面随之收窄（发布面少 5.9 MB）。这不是放宽，
  #   而是**发布面本身变小了**——本项问的始终是「今天的发布面里还有没有钥匙形态」，发布面是谁，由
  #   上面那条 sed 从 `publish-oss.ts` 一处真源派生。**若那条 sed 解析不出排除面，下面有 BLOCKER 兜底。**
  # 何故只扫 HEAD 树：公开仓由 scripts/publish-oss.ts 从 **HEAD 干净树**导出
  #   （--push 是 force 单提交、--append 亦把干净树叠在远端 main 上），**与本地提交历史无关**。
  #   ⇒ 本项问的是「今天的发布面里还有没有钥匙形态」，可长期为绿、且能逮住回归。
  #   （历史里那枚真值已由 §7 裁决『不重写、接受』；若扫全历史，本项会因它永久红透而失去意义。）
  # 由来：gitleaks 的 generic-api-key 需**标识符紧邻**取值；`plans/improve/zx_20260924.md` 里真钥匙
  #   与 `image_item.aeskey` 分处两个子句 ⇒ 2038 提交全扫『no leaks found』，而它当时**正在公开仓里**。
  LEAK_RE='(aes_?key|AES_?KEY|iLink|ilink).*[`'"'"'"]([0-9a-fA-F]{32}|[A-Za-z0-9+/]{43}=)[`'"'"'"]|[`'"'"'"]([0-9a-fA-F]{32}|[A-Za-z0-9+/]{43}=)[`'"'"'"].*(aes_?key|AES_?KEY)'
  EXCL_ARGS=()
  while IFS= read -r p; do [ -n "$p" ] && EXCL_ARGS+=(":(exclude)${p%/}"); done \
    < <(sed -n 's/^const EXCLUDE_PREFIXES = \[\(.*\)\];$/\1/p' scripts/publish-oss.ts | tr -d " '" | tr ',' '\n')
  # 排除面派生失败 ⇒ 本项形同虚设（扫面塌缩）。宁可如实阻断，不可假装通过。
  if [ "${#EXCL_ARGS[@]}" -lt 2 ]; then
    echo "→ ⚠ 排除面未从 publish-oss.ts 派生出来（得 ${#EXCL_ARGS[@]} 条）⇒ 本项扫面不可信。"
    echo "BLOCKER"
  fi
  # 发布面文件数 = 导出归档里的**文件**条数（`tar -t` 的目录条目以 `/` 结尾，滤掉）。
  #   zx_20261018_1 批九：此前用 `git grep -lE '.'` 只数**非空**文件 ⇒ 空文件
  #   `apps/worker-ant-desktop/assets/.gitkeep` 被漏掉，与 `publish-oss.ts` 实测**恒差 1**（586 vs 587）。
  #   改为直接数**同一份 `git archive` 产物**——排除面由 `publish-oss.ts` 一处派生（EXCL_ARGS），
  #   口径不再各算一遍。内容扫描（hits3b）仍走 `git grep`：空文件本来也藏不了钥匙。
  pub_n="$(git archive --format=tar HEAD -- "${EXCL_ARGS[@]}" 2>/dev/null | tar -tf - 2>/dev/null | { grep -v '/$' || true; } | wc -l | tr -d ' ')"
  hits3b="$(git grep -nE "$LEAK_RE" HEAD -- "${EXCL_ARGS[@]}" 2>/dev/null | grep -v 'gitleaks:allow' || true)"
  if [ -z "$hits3b" ]; then
    echo "→ ✅ 无命中（发布面 ${pub_n} 个文件；排除面="${EXCL_ARGS[*]}"）"
  else
    echo "$hits3b"
    echo "→ ⚠ 命中：aes_key/iLink 旁出现 32 位十六进制或 44 位 base64 ⇒ 疑似真钥匙。"
    echo "  处置：先轮换，再定是否清历史；确认系合成样本者行尾加 \`gitleaks:allow\`。"
    echo "BLOCKER"
  fi
  echo

  echo "## 4. 历次被加入过的 .env / 密钥文件（全历史新增）"
  echo "\$ git log --all --diff-filter=A --name-only --format= | grep -iE '(\\.env\$|KEY|\\.pem\$)'"
  hits4="$(git log --all --diff-filter=A --name-only --format= 2>/dev/null | grep -iE '(\.env$|KEY|\.pem$)' | sort -u || true)"
  if [ -z "$hits4" ]; then echo "→ ✅ 无"; else echo "$hits4"; echo "→ ⚠ 存量（.env.desktop 等须已排除/无害）"; fi
  echo

  echo "## 5. 现行树中受跟踪的 .env（必须为空）"
  tracked_env="$(git ls-files | grep -iE '\.env$' || true)"
  if [ -z "$tracked_env" ]; then echo "→ ✅ 空"; else echo "$tracked_env"; echo "BLOCKER"; fi
  echo

  echo "## 6. 大文件（前 20，防历史里塞过 .dmg / .db / 大二进制）"
  git cat-file --batch-all-objects --batch-check='%(objecttype) %(objectsize) %(objectname)' \
    | awk '$1=="blob"{printf "%8d KB  %s\n", $2/1024, $3}' | sort -rn | head -20
  echo

  echo "## 7. 处置（命中裁决 / 允许清单）"
  echo "# gitleaks 的『疑似命中』须逐条裁决。现行允许清单：仓库根 \`.gitleaksignore\`（格式 <commit>:<file>:<rule>:<line>）。"
  echo "# 收录的唯一来源：\`scripts/rr_zx_20260924.ts\` 的 iLink 帧标本 aes_key——"
  echo "#   · f2ef762e:653/655 = zx_20261005 M20 替换进来的**合成样本**（0123…/fedc…；因**变量名含 KEY** 被 generic-api-key 命中，值本身低熵）。"
  echo "#   · b32b97c0:616     = 历史提交里那枚**一次性 iLink 文件钥匙**（真值；仓内无密文、无取件参数 ⇒ 失活，风险≈0）。"
  echo "# ⚠ 后补事实（zx_20261016 B 行）：那枚真钥匙**不止在脚本里**——f2ef762e 只清了 scripts/，漏了"
  echo "#   \`plans/improve/zx_20260924.md\`（该目录**当时在发布面内**）⇒ 它曾随公开仓快照一同上线。今由 85fbc3c4 抹去。"
  echo "#   此事正是新增 §3b 的由来：gitleaks 因『标识符不紧邻取值』漏判，而发布面本可以扫得出来。"
  echo "# ⚠ 后续（zx_20261016_5「界」）：正因这次穿透，\`plans/\` **整目录已出局** ⇒ 该目录自本轮起不在发布面内。"
  echo "# ⚠ 遗留待裁决（创始人）：是否 \`git filter-repo\` 重写全历史以彻底清除 b32b97c0 那枚真钥匙。"
  echo "#   裁定（2026-10-16）：**不做**——本仓以 plans/ 提交哈希固证，重写即打乱全部证据；且公开面已清。"
  echo "# 注：允许清单按 **commit 指纹**匹配 ⇒ 只压制引入该值的那个提交，不会漂移到未来提交；真值（高熵）仍会被通用规则逮住。"
  echo

  echo "################################################################"
  echo "# 判定纪律：命中**真实**密钥 ⇒ 先轮换，再决定 git filter-repo 清历史，绝不『删当前文件就推』。"
  echo "################################################################"
} 2>&1 | tee "$OUT" >/dev/null

# tee 在管道里，变量不外传 ⇒ 以输出文件里的 BLOCKER 标记判定退出码。
if grep -q "BLOCKER" "$OUT"; then
  echo "❌ M20 扫描存在阻断项（见 ${OUT}）——**不得推送公开远端**。"
  exit 1
fi
echo "✅ M20 扫描完成，无阻断项。存档：${OUT}"
echo "   注意：gitleaks 的『疑似命中』仍须人工评估（占位/夹具 vs 真实密钥）。"
exit 0
