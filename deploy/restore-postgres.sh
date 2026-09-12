#!/usr/bin/env sh
set -eu

: "${ARCHIVE_PATH:?ARCHIVE_PATH is required}"
: "${COMPOSE_FILE:?COMPOSE_FILE is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"

if [ ! -f "$ARCHIVE_PATH" ]; then
  printf 'Archive does not exist: %s\n' "$ARCHIVE_PATH" >&2
  exit 1
fi

docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner < "$ARCHIVE_PATH"
