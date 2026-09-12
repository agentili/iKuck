#!/usr/bin/env sh
set -eu

: "${COMPOSE_FILE:?COMPOSE_FILE is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${BACKUP_DIR:?BACKUP_DIR is required}"

if [ "$BACKUP_DIR" = "/" ]; then
  printf '%s\n' 'BACKUP_DIR must not be the filesystem root.' >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
archive_path="$BACKUP_DIR/ikuck-$(date -u +%Y%m%dT%H%M%SZ).dump"

docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$archive_path"

if [ ! -s "$archive_path" ]; then
  printf '%s\n' 'Backup failed because the archive is empty.' >&2
  exit 1
fi

printf 'Backup written to %s\n' "$archive_path"
