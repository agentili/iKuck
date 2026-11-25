#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT
export FAKE_LOG="$test_root/docker.log"
export ONE=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export TWO=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

cat > "$test_root/docker" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_LOG"
case "$*" in
  'compose -p cutover --env-file env.test -f compose.test.yml --profile images ps --all --quiet --no-trunc api image-worker')
    case "$SCENARIO" in
      inventory-error) exit 2 ;;
      empty) exit 0 ;;
      malformed) printf '%s\n' 'unknown'; exit 0 ;;
    esac
    if [ -f "$FAKE_LOG.stopped" ]; then
      [ "$SCENARIO" != mismatch ] || { printf '%s\n' "$TWO"; exit 0; }
      printf '%s\n' "$TWO" "$ONE"
    else
      printf '%s\n' "$ONE" "$TWO"
    fi ;;
  'compose -p cutover --env-file env.test -f compose.test.yml --profile images stop --timeout 420 api image-worker')
    [ "$SCENARIO" != stop-error ] || exit 2
    touch "$FAKE_LOG.stopped" ;;
  'inspect --format {{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}} '*)
    case "$SCENARIO" in
      forced) printf '%s\n' 'exited 137 false' ;;
      running) printf '%s\n' 'running 0 false' ;;
      oom) printf '%s\n' 'exited 0 true' ;;
      inspect-error) exit 2 ;;
      *) case "$*" in *"$ONE") printf '%s\n' 'exited 0 false';; *) printf '%s\n' 'created 0 false';; esac ;;
    esac ;;
  'compose -p cutover --env-file env.test -f compose.test.yml up -d --build')
    [ "$RECIPE_IMAGES_ENABLED" = false ] || exit 3 ;;
  *) exit 4 ;;
esac
EOF
chmod +x "$test_root/docker"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
run() {
  : > "$FAKE_LOG"
  rm -f "$FAKE_LOG.stopped"
  PATH="$test_root:$PATH" RECIPE_IMAGES_ENABLED=true SCENARIO="$1" \
    sh "$root/image-cutover.sh" "$2" "$3" cutover env.test compose.test.yml >"$test_root/output" 2>&1
}
refuses() {
  if run "$1" "$3" "$2"; then fail "$1/$2 unexpectedly succeeded"; fi
  grep -q "$4" "$test_root/output" || { grep . "$test_root/output" >&2; fail "$1/$2 missing diagnostic: $4"; }
  if grep -q 'up -d' "$FAKE_LOG"; then fail "$1/$2 attempted to start services"; fi
  printf 'PASS: refused %s (%s)\n' "$1" "$2"
}
attested=all-db-image-clients-quiesced
refuses ok upgrade '' attestation
[ ! -s "$FAKE_LOG" ] || fail 'Docker called before attestation'
refuses empty upgrade "$attested" empty
refuses ok fresh "$attested" 'not empty'
refuses inventory-error fresh "$attested" inventory
refuses malformed upgrade "$attested" inventory
refuses stop-error upgrade "$attested" stop
refuses mismatch upgrade "$attested" changed
refuses forced upgrade "$attested" cleanly
refuses oom upgrade "$attested" cleanly
refuses running upgrade "$attested" cleanly
refuses inspect-error upgrade "$attested" inspect

run ok "$attested" upgrade || fail 'clean upgrade failed'
expected=$(printf '%s\n' \
  'compose -p cutover --env-file env.test -f compose.test.yml --profile images ps --all --quiet --no-trunc api image-worker' \
  'compose -p cutover --env-file env.test -f compose.test.yml --profile images stop --timeout 420 api image-worker' \
  'compose -p cutover --env-file env.test -f compose.test.yml --profile images ps --all --quiet --no-trunc api image-worker' \
  "inspect --format {{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}} $ONE" \
  "inspect --format {{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}} $TWO" \
  'compose -p cutover --env-file env.test -f compose.test.yml up -d --build')
[ "$(cat "$FAKE_LOG")" = "$expected" ] || fail 'unexpected order or scope of upgrade Docker calls'
printf '%s\n' 'PASS: verified upgrade starts disabled-first'
run empty "$attested" fresh || fail 'attested empty fresh target failed'
grep -q 'up -d --build' "$FAKE_LOG" || fail 'fresh target did not start'
if grep -q ' stop ' "$FAKE_LOG"; then fail 'empty fresh target attempted to stop a worker'; fi
printf '%s\n' 'PASS: attested fresh target starts disabled-first'
