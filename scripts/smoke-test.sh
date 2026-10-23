#!/usr/bin/env sh
# Smoke test contro un endpoint iKuck già deployato (staging o produzione).
# Uso: ./scripts/smoke-test.sh <BASE_URL> [TIMEOUT_SECONDS]
set -eu

BASE_URL="${1:?Usage: smoke-test.sh <BASE_URL> [TIMEOUT_SECONDS]}"
TIMEOUT="${2:-30}"

fail() {
  printf 'SMOKE TEST FAILED: %s\n' "$1" >&2
  exit 1
}

# 1. Homepage raggiungibile
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$BASE_URL/")
[ "$code" = "200" ] || fail "homepage returned $code, expected 200"

# 2. API risponde attraverso Caddy (/v1/auth/session: 200 con sessione, 401 senza, entrambe valide)
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$BASE_URL/v1/auth/session")
case "$code" in
  200|401) ;;
  *) fail "/v1/auth/session returned $code, expected 200 or 401" ;;
esac

# 3. Content-Security-Policy presente e senza unsafe-eval
csp=$(curl -s -D - --max-time "$TIMEOUT" "$BASE_URL/" \
  | awk 'BEGIN{IGNORECASE=1} /^content-security-policy:/{print; exit}' \
  | tr -d '\r')
[ -n "$csp" ] || fail 'Content-Security-Policy header missing'
case "$csp" in
  *unsafe-eval*) fail 'CSP contains unsafe-eval' ;;
esac

printf 'SMOKE TEST PASSED for %s\n' "$BASE_URL"
