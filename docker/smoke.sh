#!/usr/bin/env bash
# Boots the stack and verifies the API answers correctly -- with NO Cursor
# credentials and no upstream network calls. /v1/models is served from a static
# list behind auth, which makes it a perfect canary for "did upstream change in
# a way that breaks our adapter?".
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8787}"
TOKEN="${LOCAL_API_TOKEN:-local}"
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

echo "==> waiting for $BASE/health"
for _ in $(seq 1 60); do
  curl -sf "$BASE/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -sf "$BASE/health" >/dev/null || fail "health never came up"

echo "==> health"
curl -s "$BASE/health"; echo

echo "==> unauthenticated /v1/models must be rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/models")
[ "$code" = "401" ] || fail "expected 401 without a token, got $code"

echo "==> authenticated /v1/models must list models"
body=$(curl -sf -H "Authorization: Bearer $TOKEN" "$BASE/v1/models") || fail "models request failed"
echo "$body" | grep -q '"composer-2.5"' || fail "composer-2.5 missing from model list"
count=$(echo "$body" | grep -o '"id":' | wc -l | tr -d ' ')
echo "    $count models advertised"

echo "==> malformed body must be a clean 400"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{bad')
[ "$code" = "400" ] || fail "expected 400 on bad JSON, got $code"

echo "SMOKE PASS"
