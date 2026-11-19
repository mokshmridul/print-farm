# shellcheck shell=bash
# Shared by every print-farm service script and the print-farm CLI. Sourced,
# never executed. Everything here runs as root inside the container.
set -euo pipefail
umask 077
# Supervised services start with s6's minimal environment.
export PATH=/command:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

DATA_DIR=/data
SECRETS_DIR=$DATA_DIR/secrets
PG_DATA=$DATA_DIR/postgres
REDIS_DATA=$DATA_DIR/redis
UPLOAD_DIR=$DATA_DIR/uploads
PDF_DIR=$DATA_DIR/pdfs
PRINTER_DIR=$DATA_DIR/printer
RUN_DIR=/run/print-farm
PROFILES_DIR=/profiles
LIB_DIR=/usr/local/lib/print-farm
# s6-overlay snapshots the container's environment here, one file per variable.
CONTAINER_ENV=/run/s6/container_environment

DB_NAME=print
OWNER_ROLE=print_owner
WEB_ROLE=print_web
WORKER_ROLE=print_worker
PG_HOST=127.0.0.1
PG_PORT=5432
PG_SOCKET_DIR=/run/postgresql
REDIS_PORT=6379

# uid/gid that owns durable files (web runs as it; the worker's STORAGE_UID).
STORAGE_USER=nextjs
STORAGE_UID=1001
STORAGE_GID=1001

PG_BIN=$(find /usr/lib/postgresql -mindepth 2 -maxdepth 2 -type d -name bin 2>/dev/null | sort -V | tail -n1)
PG_MAJOR=$(basename "$(dirname "$PG_BIN")")

log() { printf '[%s] %s\n' "${PF_COMPONENT:-print-farm}" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

# cenv NAME [default] — a variable from the container's environment (docker run
# -e / compose environment). An empty value counts as unset. Reads the s6
# snapshot, so it behaves the same in a supervised service (whose own
# environment is deliberately minimal) and in `docker exec`.
cenv() {
  local v=""
  if [ -r "$CONTAINER_ENV/$1" ]; then
    v=$(<"$CONTAINER_ENV/$1")
  elif [ -n "${!1+x}" ]; then
    v=${!1}
  fi
  printf '%s' "${v:-${2:-}}"
}

secret() {
  [ -s "$SECRETS_DIR/$1" ] || die "Missing secret $SECRETS_DIR/$1 (did init run?)"
  printf '%s' "$(<"$SECRETS_DIR/$1")"
}

# The session secret and admin hash may be pinned from the environment (a
# migrated install keeps its old ones); otherwise init generated them.
session_secret() { local v; v=$(cenv SESSION_SECRET); [ -n "$v" ] && printf '%s' "$v" || secret session-secret; }
admin_password_hash() { local v; v=$(cenv ADMIN_PASSWORD_HASH); [ -n "$v" ] && printf '%s' "$v" || secret admin-password-hash; }

db_url() { # role secret-name
  printf 'postgresql://%s:%s@%s:%s/%s' "$1" "$(secret "$2")" "$PG_HOST" "$PG_PORT" "$DB_NAME"
}
owner_db_url()  { db_url "$OWNER_ROLE" postgres-owner-password; }
web_db_url()    { db_url "$WEB_ROLE" postgres-web-password; }
worker_db_url() { db_url "$WORKER_ROLE" postgres-worker-password; }
redis_url()     { printf 'redis://:%s@127.0.0.1:%s' "$(secret redis-password)" "$REDIS_PORT"; }

# psql as the PostgreSQL superuser over the local socket (peer authentication:
# only the postgres OS user can do this).
psql_super() {
  s6-setuidgid postgres psql -X -q -v ON_ERROR_STOP=1 -h "$PG_SOCKET_DIR" -p "$PG_PORT" -U postgres "$@"
}

# Run a service's environment from scratch: only what is listed reaches it.
# pass_env ARRAY NAME [default] appends NAME=value when the container sets it
# (or a default is given).
pass_env() {
  local -n _arr=$1
  local v
  v=$(cenv "$2" "${3:-}")
  [ -n "$v" ] && _arr+=("$2=$v")
  return 0
}

# Advanced profiles (every slot takes the owner's presets): asked for in the
# environment, or turned on by init because the profiles folder has presets.
# Advanced mode: asked for, presets in the profiles folder, or no printer set
# up at all — then the owner's own printer preset is the only way to one.
advanced_profiles() {
  if [ "$(cenv ADVANCED_PROFILES 0)" = 1 ] || [ -f "$RUN_DIR/profiles-folder" ] || [ -z "$(cenv PRINTER_MACHINE)" ]; then
    echo 1
  else
    echo 0
  fi
}

svc_restart() { s6-svc -r "/run/service/$1"; }

# exec_with_env ARRAY CMD... — exec CMD with exactly the NAME=value pairs in
# ARRAY as its environment. The values are exported, never put on a command
# line: /proc/<pid>/cmdline is readable by every uid, including the slicer's.
exec_with_env() {
  local -n _env=$1
  shift
  local v kv cmd
  # Resolved before PATH is replaced: the new one need not contain /command.
  cmd=$(command -v "$1") || die "command not found: $1"
  shift
  for v in $(compgen -e); do unset "$v" 2>/dev/null || true; done
  for kv in "${_env[@]}"; do export "${kv?}"; done
  exec "$cmd" "$@"
}
