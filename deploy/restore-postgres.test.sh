#!/usr/bin/env sh
set -eu

test_root=$(mktemp -d)
fake_bin="$test_root/bin"
archive="$test_root/archive.dump"
checksum="$archive.sha256"
mkdir -p "$fake_bin"
trap 'rm -rf "$test_root"' EXIT
printf '%s' 'fake archive' > "$archive"
sha256sum "$archive" > "$checksum"

cat > "$fake_bin/docker" <<'EOF'
#!/usr/bin/env sh
set -eu
cat >/dev/null
EOF
chmod +x "$fake_bin/docker"

set +e
PATH="$fake_bin:$PATH" \
ARCHIVE_PATH="$archive" \
ARCHIVE_CHECKSUM_PATH="$checksum" \
COMPOSE_FILE='fake-compose.yml' \
POSTGRES_DB='ikuck_test' \
POSTGRES_USER='ikuck' \
RESTORE_TARGET='ikuck_test@postgres' \
RESTORE_CONFIRM='RESTORE ikuck_test@postgres' \
  sh deploy/restore-postgres.sh --dry-run >/dev/null 2>&1
dry_run_status=$?
set -e
[ "$dry_run_status" = '0' ] || { printf '%s\n' 'Expected restore dry-run to pass preflight.' >&2; exit 1; }

set +e
PATH="$fake_bin:$PATH" \
ARCHIVE_PATH="$archive" \
ARCHIVE_CHECKSUM_PATH="$checksum" \
COMPOSE_FILE='fake-compose.yml' \
POSTGRES_DB='ikuck_test' \
POSTGRES_USER='ikuck' \
RESTORE_TARGET='ikuck_test@postgres' \
  sh deploy/restore-postgres.sh >/dev/null 2>&1
confirmation_status=$?
set -e
[ "$confirmation_status" != '0' ] || { printf '%s\n' 'Expected missing confirmation to block restore.' >&2; exit 1; }

printf '%s\n' 'restore-postgres.test.sh passed'
