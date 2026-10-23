#!/bin/bash
# 리뷰 봇이 승인 전에 돌리는 검증. CI의 server·app job과 같다(tauri 빌드는 느려서 뺀다).
set -euo pipefail
cd "$(dirname "$0")/.."

(cd server && npm ci --silent && npm test)
(cd app && npm ci --silent && npm run check && npx tsc --noEmit)
