#!/usr/bin/env sh
set -eu

test_root=$(mktemp -d)
fake_bin="$test_root/bin"
backup_dir="$test_root/backups"
mkdir -p "$fake_bin" "$backup_dir"
trap 'rm -rf "$test_root"' EXIT

cat > "$fake_bin/docker" <<'EOF'
#!/usr/bin/env sh
set -eu
if [ "${FAKE_DOCKER_FAIL:-0}" = "1" ]; then
  exit 42
fi
printf '%s' 'fake postgres archive'
EOF
chmod +x "$fake_bin/docker"

PATH="$fake_bin:$PATH" \
COMPOSE_FILE='fake-compose.yml' \
POSTGRES_DB='ikuck_test' \
POSTGRES_USER='ikuck' \
BACKUP_DIR="$backup_dir" \
  sh deploy/backup-postgres.sh

archive_count=$(find "$backup_dir" -maxdepth 1 -type f -name '*.dump' | wc -l | tr -d ' ')
[ "$archive_count" = '1' ] || { printf '%s\n' 'Expected one verified archive.' >&2; exit 1; }
[ -f "$(find "$backup_dir" -maxdepth 1 -type f -name '*.dump.sha256' | head -n 1)" ] || { printf '%s\n' 'Expected one checksum file.' >&2; exit 1; }

set +e
FAKE_DOCKER_FAIL=1 PATH="$fake_bin:$PATH" \
COMPOSE_FILE='fake-compose.yml' \
POSTGRES_DB='ikuck_test' \
POSTGRES_USER='ikuck' \
BACKUP_DIR="$backup_dir" \
  sh deploy/backup-postgres.sh >/dev/null 2>&1
failure_status=$?
set -e
[ "$failure_status" != '0' ] || { printf '%s\n' 'Expected pg_dump failure to propagate.' >&2; exit 1; }
[ "$(find "$backup_dir" -maxdepth 1 -type f -name '*.tmp' | wc -l | tr -d ' ')" = '0' ] || { printf '%s\n' 'Temporary archive was not removed.' >&2; exit 1; }

printf '%s\n' 'backup-postgres.test.sh passed'
