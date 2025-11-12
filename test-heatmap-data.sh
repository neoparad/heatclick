#!/bin/bash

# 複数のクリックデータを送信してヒートマップを生成
for i in {1..10}; do
  X=$((100 + RANDOM % 800))
  Y=$((200 + RANDOM % 600))

  curl -X POST https://heatclick-ai.vercel.app/api/track \
    -H "Content-Type: application/json" \
    -d "{\"events\":[{\"site_id\":\"CIP_EcwUTHEZdIOAUqum\",\"session_id\":\"test-session-$i\",\"event_type\":\"click\",\"timestamp\":\"2025-11-12 08:0$i:00\",\"url\":\"https://bihadashop.jp/\",\"click_x\":$X,\"click_y\":$Y,\"viewport_width\":1920,\"viewport_height\":1080,\"device_type\":\"desktop\",\"element_tag_name\":\"button\"}]}" \
    -s | grep -o "success.*"

  echo " - Click $i: ($X, $Y)"
  sleep 0.5
done

echo ""
echo "✓ 10個のクリックデータを送信しました"
echo ""
echo "ヒートマップAPIを確認中..."
sleep 2

curl "https://heatclick-ai.vercel.app/api/heatmap?site_id=CIP_EcwUTHEZdIOAUqum&page_url=https://bihadashop.jp/" \
  -s | python3 -m json.tool 2>/dev/null || curl "https://heatclick-ai.vercel.app/api/heatmap?site_id=CIP_EcwUTHEZdIOAUqum&page_url=https://bihadashop.jp/" -s
