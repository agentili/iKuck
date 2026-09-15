#!/usr/bin/env sh
set -eu

: "${ARCHIVE_PATH:?ARCHIVE_PATH is required}"
: "${COMPOSE_FILE:?COMPOSE_FILE is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${RESTORE_TARGET:?RESTORE_TARGET is required}"

POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
API_SERVICE="${API_SERVICE:-api}"
BACKUP_DIR="${BACKUP_DIR:-${PRE_RESTORE_BACKUP_DIR:-}}"
ARCHIVE_CHECKSUM_PATH="${ARCHIVE_CHECKSUM_PATH:-$ARCHIVE_PATH.sha256}"
DRY_RUN="${DRY_RUN:-false}"

if [ "$API_SERVICE" = 'none' ]; then
  API_SERVICE=''
fi

case "${1:-}" in
  --dry-run)
    DRY_RUN=true
    ;;
  '')
    ;;
  *)
    printf 'Unknown option: %s\n' "$1" >&2
    exit 1
    ;;
esac

if [ ! -f "$ARCHIVE_PATH" ] || [ ! -s "$ARCHIVE_PATH" ]; then
  printf 'Archive does not exist: %s\n' "$ARCHIVE_PATH" >&2
  exit 1
fi

if [ ! -f "$ARCHIVE_CHECKSUM_PATH" ]; then
  printf 'Archive checksum does not exist: %s\n' "$ARCHIVE_CHECKSUM_PATH" >&2
  exit 1
fi

archive_dir=$(CDPATH= cd -- "$(dirname -- "$ARCHIVE_PATH")" && pwd)
archive_name=$(basename -- "$ARCHIVE_PATH")
checksum_name=$(basename -- "$ARCHIVE_CHECKSUM_PATH")

if command -v sha256sum >/dev/null 2>&1; then
  (CDPATH= cd -- "$archive_dir" && sha256sum -c "$checksum_name")
elif command -v shasum >/dev/null 2>&1; then
  expected_hash=$(awk '{print $1}' "$ARCHIVE_CHECKSUM_PATH")
  actual_hash=$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')
  [ "$expected_hash" = "$actual_hash" ] || {
    printf '%s\n' 'Archive checksum does not match.' >&2
    exit 1
  }
else
  printf '%s\n' 'A SHA-256 utility (sha256sum or shasum) is required.' >&2
  exit 1
fi

case "$archive_name" in
  *.dump) ;;
  *)
    printf '%s\n' 'Archive must use the PostgreSQL custom-format .dump extension.' >&2
    exit 1
    ;;
esac

archive_size=$(wc -c < "$ARCHIVE_PATH" | tr -d '[:space:]')
available_kb=$(df -Pk "$archive_dir" | awk 'NR == 2 { print $4 }')
archive_kb=$(( (archive_size + 1023) / 1024 ))
if [ -z "$available_kb" ] || [ "$available_kb" -lt "$archive_kb" ]; then
  printf '%s\n' 'Insufficient free space for the restore preflight.' >&2
  exit 1
fi

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

compose exec -T "$POSTGRES_SERVICE" pg_restore --version >/dev/null
compose exec -T "$POSTGRES_SERVICE" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc 'SHOW server_version' >/dev/null
compose exec -T "$POSTGRES_SERVICE" pg_restore --list < "$ARCHIVE_PATH" >/dev/null

expected_confirmation="RESTORE $RESTORE_TARGET"
if [ "${RESTORE_CONFIRM:-}" != "$expected_confirmation" ]; then
  printf 'Refusing restore. Set RESTORE_CONFIRM to exactly: %s\n' "$expected_confirmation" >&2
  exit 1
fi

if [ "$DRY_RUN" = 'true' ] || [ "$DRY_RUN" = '1' ]; then
  printf 'Restore preflight passed for %s; no data was changed.\n' "$RESTORE_TARGET"
  exit 0
fi

if [ -z "$BACKUP_DIR" ]; then
  printf '%s\n' 'BACKUP_DIR or PRE_RESTORE_BACKUP_DIR is required for a destructive restore.' >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="$COMPOSE_FILE" \
POSTGRES_DB="$POSTGRES_DB" \
POSTGRES_USER="$POSTGRES_USER" \
POSTGRES_SERVICE="$POSTGRES_SERVICE" \
BACKUP_DIR="$BACKUP_DIR" \
  sh "$script_dir/backup-postgres.sh"

api_stopped=0
restore_cleanup() {
  if [ "$api_stopped" -eq 1 ]; then
    compose up -d "$API_SERVICE" >/dev/null 2>&1 || true
  fi
}
trap restore_cleanup EXIT HUP INT TERM

if [ -n "$API_SERVICE" ]; then
  compose stop "$API_SERVICE"
  api_stopped=1
fi
compose exec -T "$POSTGRES_SERVICE" \
  pg_restore --clean --if-exists --no-owner --exit-on-error --single-transaction \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$ARCHIVE_PATH"

if [ -n "$API_SERVICE" ]; then
  compose up -d "$API_SERVICE" >/dev/null
  for attempt in $(seq 1 30); do
    if compose exec -T "$API_SERVICE" node -e "fetch('http://127.0.0.1:3000/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
      break
    fi
    if [ "$attempt" -eq 30 ]; then
      printf '%s\n' 'API health did not recover after restore; keep the backup and investigate.' >&2
      exit 1
    fi
    sleep 2
  done
fi

compose exec -T "$POSTGRES_SERVICE" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc 'SELECT 1' | grep -qx '1'
api_stopped=0
printf 'Restore completed and post-restore health checks passed for %s.\n' "$RESTORE_TARGET"
