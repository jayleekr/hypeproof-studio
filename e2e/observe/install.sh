#!/bin/bash
# 릴리스 빌드 대기 → 설치 → 디버깅 포트로 기동 → 관측기 부착.
#
# 사용법:  bash e2e/observe/install.sh v0.1.31
#
# 왜 스크립트인가. Mac 빌드가 20분 넘게 걸려 사람이 붙어 있을 이유가 없고, 설치 후
# "포트로 다시 띄우고 관측기 붙이기"를 손으로 하다 두 번 빠뜨렸다(그때마다 원장이
# 채팅을 쳤는데 아무것도 관측되지 않았다).
set -u
TAG="${1:-}"
[ -n "$TAG" ] || { echo "사용법: $0 <tag>   예) $0 v0.1.31"; exit 2; }

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${HPS_OBSERVE_WORK:-$HERE/runs}"
PORT="${HPS_CDP_PORT:-9333}"
APP="/Applications/HypeProof Studio.app"
mkdir -p "$WORK"
log() { echo "[$(date +%H:%M:%S)] $*"; }

# ── 빌드 대기 ────────────────────────────────────────────────────────────────
RUN=$(gh run list --limit 10 --json databaseId,workflowName,headBranch \
        --jq ".[] | select(.headBranch==\"$TAG\" and .workflowName==\"Build macOS\") | .databaseId" | head -1)
[ -n "$RUN" ] || { log "✗ $TAG 의 Mac 빌드를 못 찾음"; exit 1; }
log "Mac 빌드 대기 (run $RUN)…"
gh run watch "$RUN" --exit-status --interval 60 >/dev/null 2>&1
CONC=$(gh run view "$RUN" --json conclusion --jq .conclusion)
log "Mac 빌드: $CONC"
# 실패하면 설치하지 않는다 — 지금 깔려 있는 멀쩡한 버전을 지키는 게 우선이다.
[ "$CONC" = "success" ] || { log "✗ 빌드 실패 — 설치하지 않는다"; exit 1; }

# ── 내려받기 · 검증 ──────────────────────────────────────────────────────────
log "릴리스 내려받는 중…"
gh release download "$TAG" -p "HypeProof-Studio-darwin-arm64.zip" -D "$WORK" --clobber || exit 1
rm -rf "$WORK/new"; mkdir -p "$WORK/new"
ditto -x -k "$WORK/HypeProof-Studio-darwin-arm64.zip" "$WORK/new" || exit 1
NEW="$WORK/new/HypeProof Studio.app"

# 번들 검증은 **ASCII 식별자로만** 한다. 한글 문자열로 grep 하면 거짓 음성이 난다 —
# esbuild 가 일부 문자를 \uXXXX 로 이스케이프해서, 실제로 들어 있는 코드를 "없다"고
# 하루에 세 번 오판했다(2026-07-27).
log "번들 검증"
D="$NEW/Contents/Resources/app/extensions/hypeproof-chat/dist/extension.js"
for k in ${HPS_VERIFY_SYMBOLS:-x-hps-workspace ANTHROPIC_CUSTOM_HEADERS APPROVAL_COPY}; do
  grep -aqF "$k" "$D" && log "  ✓ $k" || log "  ✗ $k  ← 빠졌다"
done
# 이게 없으면 코치가 조용히 프록시 전용으로 격하된다 — SDK 기능이 죽은 채 배포된다.
ls "$NEW/Contents/Resources/app/extensions/hypeproof-chat/dist/vendor/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs" \
  >/dev/null 2>&1 && log "  ✓ sdk.mjs (프록시 격하 방지)" || log "  ✗ sdk.mjs 없음"

# ── 교체 ─────────────────────────────────────────────────────────────────────
log "앱 종료 후 교체"
osascript -e 'tell application "HypeProof Studio" to quit' >/dev/null 2>&1
sleep 4
pkill -f "HypeProof Studio.app/Contents/MacOS" >/dev/null 2>&1
sleep 2
rm -rf "$WORK/previous.app"
mv "$APP" "$WORK/previous.app" 2>/dev/null   # 지우지 않고 대피 — 되돌릴 수 있게
ditto "$NEW" "$APP" || exit 1
log "설치: $(defaults read "$APP/Contents/Info" CFBundleShortVersionString)"
codesign --verify --deep --strict "$APP" 2>&1 && log "서명 ✓"

# ── 기동 · 부착 ──────────────────────────────────────────────────────────────
# 포트 기본값이 9222 가 아닌 이유: 죽은 인스턴스가 남긴 상태 때문에 9222 가 바인드는
# 되는데 응답하지 않는 상황을 겪었다(2026-07-27). 포트를 바꾸니 즉시 붙었다.
log "디버깅 포트 $PORT 로 기동"
open -a "HypeProof Studio" --args --remote-debugging-port="$PORT"
for i in $(seq 1 30); do
  curl -s -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && { log "CDP ✓ (${i}회)"; break; }
  sleep 2
done

log "관측기 부착"
pkill -f "observe/watch.mjs" >/dev/null 2>&1
sleep 1
HPS_CDP_PORT="$PORT" nohup node "$HERE/watch.mjs" > "$WORK/watch.log" 2>&1 &
sleep 8
tail -5 "$WORK/watch.log"
log "완료 — 채팅만 치면 됨"
