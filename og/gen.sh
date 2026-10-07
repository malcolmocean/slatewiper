#!/bin/sh
# Renders site/og.png (the 1200x630 link-preview card) from og/og.html. Serves the parent of
# this repo so og.html can borrow the creations site's font; the icon comes from app/icon/.
set -e
cd "$(dirname "$0")/.."; ROOT=$(cd .. && pwd)
python3 -m http.server 8798 -d "$ROOT" >/dev/null 2>&1 & srv=$!
trap 'kill $srv' EXIT
sleep 1
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --virtual-time-budget=5000 --window-size=1200,630 --screenshot="$PWD/site/og.png" "http://localhost:8798/$(basename "$PWD")/og/og.html" 2>/dev/null
echo "wrote site/og.png"
