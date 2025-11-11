#!/bin/bash

# ClickInsight Pro - Hetzner Server Setup Script
# このスクリプトはHetzner Ubuntu 22.04サーバーでClickHouseとRedisをセットアップします

set -e

echo "=========================================="
echo "ClickInsight Pro - Server Setup"
echo "=========================================="
echo ""

# 色の定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# パスワードの入力を求める
echo -e "${YELLOW}ClickHouse default ユーザーのパスワードを入力してください:${NC}"
read -s CLICKHOUSE_PASSWORD
echo ""

echo -e "${YELLOW}Redis のパスワードを入力してください:${NC}"
read -s REDIS_PASSWORD
echo ""

echo -e "${GREEN}セットアップを開始します...${NC}"
echo ""

# 1. システムアップデート
echo ">> システムを更新中..."
apt update && apt upgrade -y

# 2. 必要なパッケージをインストール
echo ">> 必要なパッケージをインストール中..."
apt-get install -y apt-transport-https ca-certificates dirmngr curl gnupg2

# 3. ClickHouseのインストール
echo ">> ClickHouseをインストール中..."

# GPGキーを追加
GNUPGHOME=$(mktemp -d)
export GNUPGHOME
gpg --no-default-keyring --keyring /usr/share/keyrings/clickhouse-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys 8919F6BD2B48D754
rm -rf "$GNUPGHOME"
unset GNUPGHOME

# リポジトリを追加
echo "deb [signed-by=/usr/share/keyrings/clickhouse-keyring.gpg] https://packages.clickhouse.com/deb stable main" | tee /etc/apt/sources.list.d/clickhouse.list

# パッケージリストを更新
apt-get update

# ClickHouseをインストール（パスワードを自動設定）
echo "clickhouse-server clickhouse-server/default-password password $CLICKHOUSE_PASSWORD" | debconf-set-selections
DEBIAN_FRONTEND=noninteractive apt-get install -y clickhouse-server clickhouse-client

# 4. ClickHouseの設定
echo ">> ClickHouseを設定中..."

# リモート接続を有効化
if ! grep -q "<listen_host>0.0.0.0</listen_host>" /etc/clickhouse-server/config.xml; then
    sed -i 's|<!-- <listen_host>::1</listen_host> -->|<listen_host>0.0.0.0</listen_host>|' /etc/clickhouse-server/config.xml
fi

# ClickHouseを起動
systemctl start clickhouse-server
systemctl enable clickhouse-server

# 5. ClickHouseデータベースとテーブルを作成
echo ">> ClickHouseデータベースを作成中..."

sleep 3  # ClickHouseが完全に起動するまで待機

clickhouse-client --password="$CLICKHOUSE_PASSWORD" --query="CREATE DATABASE IF NOT EXISTS clickinsight;"

clickhouse-client --password="$CLICKHOUSE_PASSWORD" --query="
CREATE TABLE IF NOT EXISTS clickinsight.events (
    id String,
    site_id String,
    session_id String,
    user_id String,
    event_type String,
    timestamp DateTime,
    url String,
    referrer String,
    user_agent String,
    viewport_width UInt16,
    viewport_height UInt16,
    element_tag_name String,
    element_id String,
    element_class_name String,
    element_text String,
    element_href String,
    click_x UInt16,
    click_y UInt16,
    scroll_y UInt16,
    scroll_percentage UInt8,
    received_at DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (site_id, timestamp)
PARTITION BY toYYYYMM(timestamp);
"

# 6. Redisのインストール
echo ">> Redisをインストール中..."
apt-get install -y redis-server

# 7. Redisの設定
echo ">> Redisを設定中..."

# bind設定を変更
sed -i 's/^bind 127.0.0.1 -::1/bind 0.0.0.0/' /etc/redis/redis.conf

# パスワードを設定
sed -i "s/^# requirepass foobared/requirepass $REDIS_PASSWORD/" /etc/redis/redis.conf

# protected-modeを無効化
sed -i 's/^protected-mode yes/protected-mode no/' /etc/redis/redis.conf

# Redisを再起動
systemctl restart redis-server
systemctl enable redis-server

# 8. ファイアウォール設定（UFW）
echo ">> ファイアウォールを設定中..."
ufw --force enable
ufw allow 22/tcp    # SSH
ufw allow 8123/tcp  # ClickHouse HTTP
ufw allow 9000/tcp  # ClickHouse Native
ufw allow 6379/tcp  # Redis

# 9. 接続情報を表示
echo ""
echo -e "${GREEN}=========================================="
echo "セットアップ完了！"
echo -e "==========================================${NC}"
echo ""
echo "サーバーIP: $(curl -s ifconfig.me)"
echo ""
echo -e "${YELLOW}ClickHouse 接続情報:${NC}"
echo "  ホスト: $(curl -s ifconfig.me)"
echo "  HTTPポート: 8123"
echo "  Nativeポート: 9000"
echo "  ユーザー: default"
echo "  パスワード: $CLICKHOUSE_PASSWORD"
echo "  データベース: clickinsight"
echo ""
echo -e "${YELLOW}Redis 接続情報:${NC}"
echo "  ホスト: $(curl -s ifconfig.me)"
echo "  ポート: 6379"
echo "  パスワード: $REDIS_PASSWORD"
echo ""
echo -e "${YELLOW}.env.local に追加する設定:${NC}"
echo ""
echo "CLICKHOUSE_HOST=$(curl -s ifconfig.me)"
echo "CLICKHOUSE_PORT=8123"
echo "CLICKHOUSE_DATABASE=clickinsight"
echo "CLICKHOUSE_USER=default"
echo "CLICKHOUSE_PASSWORD=$CLICKHOUSE_PASSWORD"
echo "CLICKHOUSE_URL=http://default:$CLICKHOUSE_PASSWORD@$(curl -s ifconfig.me):8123/clickinsight"
echo ""
echo "REDIS_HOST=$(curl -s ifconfig.me)"
echo "REDIS_PORT=6379"
echo "REDIS_PASSWORD=$REDIS_PASSWORD"
echo "REDIS_URL=redis://:$REDIS_PASSWORD@$(curl -s ifconfig.me):6379"
echo ""
echo -e "${GREEN}接続テスト:${NC}"
echo "ClickHouse: clickhouse-client --host $(curl -s ifconfig.me) --user default --password $CLICKHOUSE_PASSWORD"
echo "Redis: redis-cli -h $(curl -s ifconfig.me) -a $REDIS_PASSWORD ping"
echo ""
