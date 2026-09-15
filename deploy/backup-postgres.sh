#!/usr/bin/env sh
set -eu

: "${COMPOSE_FILE:?COMPOSE_FILE is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${BACKUP_DIR:?BACKUP_DIR is required}"

POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
BACKUP_RETENTION_COUNT="${BACKUP_RETENTION_COUNT:-7}"

if [ "$BACKUP_DIR" = "/" ]; then
  printf '%s\n' 'BACKUP_DIR must not be the filesystem root.' >&2
  exit 1
fi

case "$BACKUP_RETENTION_COUNT" in
  ''|*[!0-9]*)
    printf '%s\n' 'BACKUP_RETENTION_COUNT must be a non-negative integer.' >&2
    exit 1
    ;;
esac

if [ "$BACKUP_RETENTION_COUNT" -lt 1 ]; then
  printf '%s\n' 'BACKUP_RETENTION_COUNT must be at least 1.' >&2
  exit 1
fi

checksum_command() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1"
  else
    printf '%s\n' 'A SHA-256 utility (sha256sum or shasum) is required.' >&2
    return 1
  fi
}

mkdir -p "$BACKUP_DIR"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
archive_path="$BACKUP_DIR/ikuck-$timestamp.dump"
checksum_path="$archive_path.sha256"
temp_archive="$archive_path.tmp.$$"
temp_checksum="$checksum_path.tmp.$$"
created_archive=0

cleanup() {
  rm -f -- "$temp_archive" "$temp_checksum"
  if [ "$created_archive" -eq 0 ]; then
    rm -f -- "$archive_path" "$checksum_path"
  fi
}
trap cleanup EXIT HUP INT TERM

docker compose -f "$COMPOSE_FILE" exec -T "$POSTGRES_SERVICE" \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$temp_archive"

if [ ! -s "$temp_archive" ]; then
  printf '%s\n' 'Backup failed because the archive is empty.' >&2
  exit 1
fi

docker compose -f "$COMPOSE_FILE" exec -T "$POSTGRES_SERVICE" \
  pg_restore --list < "$temp_archive" >/dev/null

checksum_command "$temp_archive" \
  | sed "s#$(basename "$temp_archive")#$(basename "$archive_path")#" > "$temp_checksum"

mv -- "$temp_archive" "$archive_path"
created_archive=1
mv -- "$temp_checksum" "$checksum_path"

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'ikuck-*.dump' -print \
  | sort -r \
  | tail -n +$((BACKUP_RETENTION_COUNT + 1)) \
  | while IFS= read -r old_archive; do
      [ -n "$old_archive" ] || continue
      rm -f -- "$old_archive" "$old_archive.sha256"
    done

printf 'Backup written to %s\n' "$archive_path"
