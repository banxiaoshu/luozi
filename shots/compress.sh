#!/bin/bash
# 把 CDP 截下来的 2x/3x PNG 压成落地页用的 JPEG
set -e
cd "$(dirname "$0")"
mkdir -p .

# 桌面：2080 宽（1040 视口 @2x）→ 1560，页面通栏约 1030px 显示，1.5x 超采样
for f in today schedule note graph ocr notes doc unknown; do
  if [ -f "raw/$f.png" ]; then
    sips -s format jpeg -s formatOptions 82 --resampleWidth 1560 "raw/$f.png" --out "$f.jpg" >/dev/null
  fi
done

# 手机：1170 宽 → 720
for f in m-today m-schedule m-notes m-note m-graph m-ocr m-recorder m-share m-doc m-unknown; do
  if [ -f "raw/$f.png" ]; then
    sips -s format jpeg -s formatOptions 84 --resampleWidth 720 "raw/$f.png" --out "$f.jpg" >/dev/null
  fi
done

rm -rf raw
echo "--- 成品 ---"
ls -la *.jpg | awk '{printf "%-18s %8.1f KB\n", $9, $5/1024}'
du -sh .
