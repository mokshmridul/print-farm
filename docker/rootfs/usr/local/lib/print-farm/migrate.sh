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
log "Database ready"
