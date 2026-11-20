#!/bin/sh
# Run from the verified v2-compatible release checkout on the selected Docker host.
set -efu

fail() { printf 'Image cutover refused: %s\n' "$*" >&2; exit 1; }

[ "${1:-}" = all-db-workers-quiesced ] || fail 'positive attestation for all workers sharing this DB is required (including other projects and hosts)'
[ "$#" -eq 5 ] || fail 'expected attestation, target (upgrade or fresh), Compose project, env file and Compose file'
target=$2
project=$3
env_file=$4
compose_file=$5
case "$target" in upgrade|fresh) ;; *) fail 'invalid cutover target';; esac
case "$project" in ''|[-_]*|*[!a-z0-9_-]*) fail 'invalid Compose project name';; esac

compose() { docker compose -p "$project" --env-file "$env_file" -f "$compose_file" "$@"; }
inventory() {
  # --all includes stopped containers and --profile covers old profile-gated workers.
  ids=$(compose --profile images ps --all --quiet --no-trunc image-worker) || fail 'cannot read worker inventory'
  if [ -n "$ids" ]; then
    # IDs can arrive in either order. Reject malformed or duplicate entries.
    valid=$(printf '%s\n' "$ids" | LC_ALL=C grep -E '^[0-9a-f]{64}$') || fail 'invalid worker inventory'
    [ "$ids" = "$valid" ] || fail 'invalid worker inventory'
    sorted=$(printf '%s\n' "$ids" | LC_ALL=C sort) || fail 'cannot sort worker inventory'
    unique=$(printf '%s\n' "$sorted" | uniq) || fail 'cannot verify worker inventory'
    [ "$sorted" = "$unique" ] || fail 'duplicate worker inventory entries'
    printf '%s\n' "$sorted"
  fi
}

before=$(inventory) || exit 1
case "$target" in
  fresh) [ -z "$before" ] || fail 'fresh target inventory is not empty';;
  upgrade)
    [ -n "$before" ] || fail 'empty worker inventory for upgrade; verify the project and existing workers before migration'
    compose --profile images stop --timeout 420 image-worker || fail 'Compose stop failed'
    after=$(inventory) || exit 1
    [ "$before" = "$after" ] || fail 'worker inventory changed during stop'
    for worker in $after; do
      state=$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}' "$worker") || fail 'cannot inspect worker state'
      case "$state" in 'exited 0 false'|'created 0 false') ;; *) fail 'worker did not stop cleanly';; esac
    done
    ;;
esac

# Process environment takes precedence over --env-file in both supported Compose files.
# Do not edit the host env file or start this migration-capable stack enabled.
RECIPE_IMAGES_ENABLED=false compose up -d --build
