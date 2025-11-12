#!/bin/bash
curl -X POST https://heatclick-ai.vercel.app/api/track \
  -H "Content-Type: application/json" \
  -d '{"events":[{"site_id":"CIP_EcwUTHEZdIOAUqum","session_id":"test-004","event_type":"click","timestamp":"2025-11-12 08:00:00","url":"https://bihadashop.jp/","click_x":500,"click_y":300,"viewport_width":1920,"viewport_height":1080,"device_type":"desktop"}]}'
