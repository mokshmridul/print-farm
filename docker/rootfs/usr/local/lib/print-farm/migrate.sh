#!/bin/bash
# s6-rc oneshot "migrate": make sure the owner role and database exist, apply
# Prisma migrations with the owner credential, then (re)provision the
# least-privilege web and worker roles. web and worker start only after this
# succeeds; a failure stops the container (S6_BEHAVIOUR_IF_STAGE2_FAILS=2).
PF_COMPONENT=migrate
# shellcheck source=common.sh
. /usr/local/lib/print-farm/common.sh

"$LIB_DIR/db-bootstrap.sh"

# run_as_storage NAME=value... -- CMD...: a step as the unprivileged storage
# user, with a clean environment holding just the given variables.
run_as_storage() {
  local -a env=(PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp NODE_ENV=production LANG=C.UTF-8)
  while [ "$1" != -- ]; do env+=("$1"); shift; done
  shift
  ( exec_with_env env s6-setuidgid "$STORAGE_USER" "$@" )
}

# ── Backup before an update ───────────────────────────────────────────────────
# A new image may migrate the database. Before it does, dump the database as
# it was, so `print-farm restore` can always go back. The five newest are kept.
version=$(head -n1 /etc/print-farm/version 2>/dev/null || echo unknown)
previous=$(cat "$DATA_DIR/.image-version" 2>/dev/null || true)
if [ -n "$previous" ] && [ "$previous" != "$version" ]; then
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  file="$BACKUP_DIR/before-update-$stamp.pgdump"
  log "New image ($previous → $version): backing up the database to $file"
  if PGHOST=$PG_HOST PGPORT=$PG_PORT PGDATABASE=$DB_NAME PGUSER=$OWNER_ROLE PGPASSWORD=$(secret postgres-owner-password) \
      pg_dump --format=custom --no-owner --no-privileges > "$file.tmp"; then
    mv "$file.tmp" "$file"
    chmod 0600 "$file"
    find "$BACKUP_DIR" -maxdepth 1 -name 'before-update-*.pgdump' | sort -r | tail -n +6 | xargs -r rm -f
  else
    rm -f "$file.tmp"
    die "The backup before the update failed, so nothing was migrated. The previous image still works with this data."
  fi
fi

log "Applying database migrations…"
# Prisma 7 takes the connection URL from prisma.config.mjs, resolved from the
# working directory: /opt/migrate is where config, schema and node_modules meet.
(cd /opt/migrate && run_as_storage DATABASE_URL="$(owner_db_url)" -- ./node_modules/.bin/prisma migrate deploy)

log "Provisioning least-privilege runtime roles…"
# Defining roles with NOSUPERUSER/NOREPLICATION/NOBYPASSRLS takes a superuser,
# so the owner holds it for this step alone — while web and worker are not
# running (boot, or a paused restore) — and loses it again on any exit.
owner_superuser() { psql_super -d postgres -c "ALTER ROLE $OWNER_ROLE $1"; }
trap 'owner_superuser NOSUPERUSER || log "WARNING: could not drop superuser from $OWNER_ROLE"' EXIT
owner_superuser SUPERUSER
run_as_storage \
  MIGRATION_DATABASE_URL="$(owner_db_url)" \
  WEB_DATABASE_URL="$(web_db_url)" \
  WORKER_DATABASE_URL="$(worker_db_url)" \
  -- node /app/scripts/provision-database.mjs

owner_superuser NOSUPERUSER
trap - EXIT
printf '%s' "$version" > "$DATA_DIR/.image-version"

# ── Admin password ────────────────────────────────────────────────────────────
# The owner's lives in the database (AppSetting "adminPassword"). An install
# from before kept it in a file: move it in once.
sql() { psql_super -d "$DB_NAME" -tA "$@"; }
claimed=$(sql -c "SELECT count(*) FROM \"AppSetting\" WHERE key = 'adminPassword'")
if [ "$claimed" = 0 ] && [ -s "$SECRETS_DIR/admin-password-hash" ]; then
  sql -v hash="$(<"$SECRETS_DIR/admin-password-hash")" <<'SQL'
INSERT INTO "AppSetting" (key, value, "updatedAt") VALUES ('adminPassword', json_build_object('hash', :'hash'), now())
ON CONFLICT (key) DO NOTHING;
SQL
  rm -f "$SECRETS_DIR/admin-password-hash"
  claimed=1
  log "Moved the admin password into the database"
fi

# Not set anywhere yet: whoever opens the shop first creates it, but only with
# this one-time code, shown here (docker logs) and nowhere else.
if [ "$claimed" = 0 ] && [ -z "$(admin_password_hash)" ]; then
  if [ ! -s "$SECRETS_DIR/setup-code" ]; then
    code=$(openssl rand -hex 4 | tr a-f A-F)
    printf '%s-%s' "${code:0:4}" "${code:4:4}" > "$SECRETS_DIR/setup-code"
    chmod 0600 "$SECRETS_DIR/setup-code"
  fi
  where=$(conf APP_ORIGIN "http://<this computer>:8080")
  log "──────────────────────────────────────────────────────────────"
  log " Welcome! Open $where/admin to set up the shop."
  log " First-run setup code: $(<"$SECRETS_DIR/setup-code")"
  log "──────────────────────────────────────────────────────────────"
else
  rm -f "$SECRETS_DIR/setup-code"
fi
log "Database ready"
