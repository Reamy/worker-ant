#!/bin/bash
# 工蚁系统数据库备份脚本
# 用法: ./scripts/backup.sh
# 建议crontab: 0 * * * * cd /opt/worker-ant && ./scripts/backup.sh

set -e

BACKUP_DIR="./data/backups"
KEEP_COUNT=24  # 保留最近24个备份

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M)

# 备份ANS数据库
if [ -f "./data/ans-server.db" ]; then
  cp "./data/ans-server.db" "$BACKUP_DIR/ans-$TIMESTAMP.db"
  echo "[$(date)] ANS数据库已备份: ans-$TIMESTAMP.db"
fi

# 备份工蚁数据库
if [ -f "./data/worker-ant-server.db" ]; then
  cp "./data/worker-ant-server.db" "$BACKUP_DIR/wa-$TIMESTAMP.db"
  echo "[$(date)] 工蚁数据库已备份: wa-$TIMESTAMP.db"
fi

# 清理旧备份（保留最近KEEP_COUNT个）
cleanup() {
  local prefix=$1
  ls -1t "$BACKUP_DIR/$prefix"-*.db 2>/dev/null | tail -n +$((KEEP_COUNT + 1)) | xargs rm -f 2>/dev/null
}
cleanup "ans"
cleanup "wa"

# 统计
ANS_COUNT=$(ls "$BACKUP_DIR"/ans-*.db 2>/dev/null | wc -l)
WA_COUNT=$(ls "$BACKUP_DIR"/wa-*.db 2>/dev/null | wc -l)
echo "[$(date)] 备份完成 (ANS: $ANS_COUNT, 工蚁: $WA_COUNT, 保留: $KEEP_COUNT)"

# WAL完整性检查
sqlite3 ./data/ans-server.db "PRAGMA integrity_check;" > /dev/null 2>&1 || echo "[$(date)] WARNING: ANS数据库完整性检查失败"
sqlite3 ./data/worker-ant-server.db "PRAGMA integrity_check;" > /dev/null 2>&1 || echo "[$(date)] WARNING: 工蚁数据库完整性检查失败"
