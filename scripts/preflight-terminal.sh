#!/bin/bash
# zx_20261113_2 M1「通」——桌面启动的 IDE 终端自检（run.sh 与 pnpm desktop:dev 共用**一处**）。
#
# 为什么要有这道闸：从 IntelliJ/VS Code 集成终端启动 Electron 时，macOS 会把它的子进程
# 本地网络访问归属到**IDE 本身**。IDE 未获「本地网络」权限时，Python/Java/Node 连局域网
# 一律 EHOSTUNREACH，而 /usr/bin/nc 等 Apple 网络工具走豁免仍能通——于是"同一台机器、
# 同一时刻、不同进程结果不同"（2026-11-13 真标本 0396cfbc）。
#
# 退出码：0 = 可启动；1 = 请在 macOS Terminal.app 中运行。

set -u

# 注意：IntelliJ 的内置终端不一定设 TERM_PROGRAM（实测只有 TERM/TERMINAL_EMULATOR），
# 故 `TERMINAL_EMULATOR` 非空也必须拦——这是 2026-11-13 真标本实际落入的形态。
if [ -n "${JETBRAINS_HOME:-}" ] || [ -n "${VSCODE_PID:-}" ] || [ -n "${TERMINAL_EMULATOR:-}" ] \
   || { [ -n "${TERM_PROGRAM:-}" ] && [ "${TERM_PROGRAM}" != "Apple_Terminal" ]; }; then
  echo ""
  echo "⚠️  检测到 IDE 集成终端（TERM_PROGRAM=${TERM_PROGRAM:-未设置} / TERMINAL_EMULATOR=${TERMINAL_EMULATOR:-未设置}）。"
  echo "    请在 macOS Terminal.app 中启动工蚁桌面："
  echo "      cd $(pwd)"
  echo "      pnpm desktop:dev   # 或 cd apps/worker-ant-desktop && bash run.sh"
  echo ""
  echo "    原因：从 IDE 终端启动时，Electron 的本地网络访问会被 macOS 归属到 IDE；"
  echo "          若 IDE 未获「本地网络」权限，执行体连局域网会报 EHOSTUNREACH。"
  echo "          若确要留在 IDE 终端：系统设置 → 隐私与安全性 → 本地网络，给该 IDE 授权。"
  echo ""
  exit 1
fi

exit 0
