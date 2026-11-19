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
CONFIG_DIR=$DATA_DIR/config
SETTINGS_FILE=$CONFIG_DIR/settings.json
BACKUP_DIR=$DATA_DIR/backups
PRINTERS_LIST=/etc/print-farm/printers.tsv
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

# The session secret may be pinned from the environment (a migrated install
# keeps its old one); otherwise init generated it.
session_secret() { local v; v=$(cenv SESSION_SECRET); [ -n "$v" ] && printf '%s' "$v" || secret session-secret; }

# The admin password set in the environment, if any: ADMIN_PASSWORD_HASH, or
# ADMIN_PASSWORD hashed by init this boot. Empty: the owner's own, which the
# web keeps in the database (created on first visit with the setup code).
admin_password_hash() {
  local v; v=$(cenv ADMIN_PASSWORD_HASH)
  [ -z "$v" ] && [ -s "$RUN_DIR/admin-password-hash" ] && v=$(<"$RUN_DIR/admin-password-hash")
  printf '%s' "$v"
}

# ── Server settings ───────────────────────────────────────────────────────────
# The owner's choices in the browser (web address, reverse proxy, printer from
# OrcaSlicer's list) live in $SETTINGS_FILE, written by the web. load_settings
# validates it (read-settings.mjs) into $RUN_DIR/settings.env, NAME=value per
# line, never evaluated; conf reads one, an environment variable winning.
load_settings() {
  local out=$RUN_DIR/settings.env
  if node /opt/tools/read-settings.mjs "$SETTINGS_FILE" "$PRINTERS_LIST" > "$out.tmp"; then
    mv "$out.tmp" "$out"
    chmod 0600 "$out"
  else
    rm -f "$out.tmp"
    log "WARNING: $SETTINGS_FILE could not be read; keeping the settings in use"
    [ -f "$out" ] || : > "$out"
    return 1
  fi
}

# conf NAME [default]
conf() {
  local v line
  v=$(cenv "$1")
  if [ -z "$v" ] && [ -r "$RUN_DIR/settings.env" ]; then
    while IFS= read -r line; do
      if [ "${line%%=*}" = "$1" ]; then v=${line#*=}; break; fi
    done < "$RUN_DIR/settings.env"
  fi
  printf '%s' "${v:-${2:-}}"
}

# The container's default gateway: where a reverse proxy on the same computer
# connects from (through the published port).
default_gateway() {
  local hex
  hex=$(awk '$2 == "00000000" { print $3; exit }' /proc/net/route)
  [ ${#hex} = 8 ] || return 1
  printf '%d.%d.%d.%d' "0x${hex:6:2}" "0x${hex:4:2}" "0x${hex:2:2}" "0x${hex:0:2}"
}

# Render nginx's site config from the proxy settings. "host" trusts the
# gateway (a proxy on this computer).
render_nginx() {
  local cidr
  cidr=$(conf TRUSTED_PROXY_CIDR)
  if [ "$cidr" = host ]; then
    cidr=$(default_gateway) || { log "Could not find the container's gateway to trust"; return 1; }
    log "Trusting the reverse proxy on this computer ($cidr)"
  fi
  TRUSTED_PROXY_CIDR=$cidr REAL_IP_HEADER=$(conf REAL_IP_HEADER X-Real-IP) DIRECT_ACCESS=$(conf DIRECT_ACCESS 0) \
    "$LIB_DIR/render-nginx.sh" "$LIB_DIR/nginx-site.conf.template" /run/nginx/site.conf.new || return 1
  chown root:www-data /run/nginx/site.conf.new
  chmod 0640 /run/nginx/site.conf.new
  mv /run/nginx/site.conf.new /run/nginx/site.conf
}

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
  if [ "$(cenv ADVANCED_PROFILES 0)" = 1 ] || [ -f "$RUN_DIR/profiles-folder" ] || [ -z "$(conf PRINTER_MACHINE)" ]; then
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
