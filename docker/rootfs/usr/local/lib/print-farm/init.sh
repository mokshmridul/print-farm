#!/bin/bash
# First step of every boot (s6-rc oneshot "init"), as root, before any other
# service starts: lock down the environment snapshot, create and own the data
# directories, generate first-boot secrets, and render the PostgreSQL, Redis
# and nginx configuration.
PF_COMPONENT=init
# shellcheck source=common.sh
. /usr/local/lib/print-farm/common.sh

# ── Environment snapshot ──────────────────────────────────────────────────────
# s6-overlay writes every container variable (integration API keys among them)
# to world-readable files. Only root may read them: the web gets an explicit
# allowlist from its run script, and the untrusted slicer uids get nothing.
chmod 0700 "$CONTAINER_ENV"

# ── Data directories ──────────────────────────────────────────────────────────
[ -n "$PG_BIN" ] || die "PostgreSQL binaries not found in the image."

install -d -m 0755 -o root -g root "$DATA_DIR"
install -d -m 0700 -o root -g root "$SECRETS_DIR"
install -d -m 0700 -o postgres -g postgres "$PG_DATA"
install -d -m 0700 -o redis -g redis "$REDIS_DATA"
install -d -m 0755 -o root -g root "$PRINTER_DIR" "$RUN_DIR"
install -d -m 2775 -o postgres -g postgres "$PG_SOCKET_DIR"
install -d -m 0700 -o www-data -g www-data /run/nginx

# Durable files belong to the storage uid; the untrusted slicer never receives
# direct vault access (it works on private staged copies). A volume restored or
# migrated from elsewhere may arrive with other owners: fix the tree once.
for dir in "$UPLOAD_DIR" "$UPLOAD_DIR/thumbs" "$UPLOAD_DIR/tmp" "$PDF_DIR"; do
  install -d -m 0700 -o "$STORAGE_UID" -g "$STORAGE_GID" "$dir"
done
for dir in "$UPLOAD_DIR" "$PDF_DIR"; do
  if [ -n "$(find "$dir" \( ! -user "$STORAGE_UID" -o ! -group "$STORAGE_GID" \) -print -quit)" ]; then
    log "Taking ownership of $dir"
    chown -R "$STORAGE_UID:$STORAGE_GID" "$dir"
  fi
done
find "$UPLOAD_DIR" "$UPLOAD_DIR/thumbs" "$PDF_DIR" -maxdepth 1 -type f ! -perm 0600 -exec chmod 0600 {} +

# The database: a PostgreSQL data directory belongs to one major version.
if [ -s "$PG_DATA/PG_VERSION" ]; then
  have=$(<"$PG_DATA/PG_VERSION")
  [ "$have" = "$PG_MAJOR" ] || die "$PG_DATA holds a PostgreSQL $have database, but this image runs PostgreSQL $PG_MAJOR.
  Move the data across with a dump and restore (docs/MAINTENANCE.md, \"Upgrading PostgreSQL\")."
  chown -R postgres:postgres "$PG_DATA"
  chmod 0700 "$PG_DATA"
fi
chown -R redis:redis "$REDIS_DATA"

# ── Secrets (generated once, kept in the volume) ──────────────────────────────
gen_secret() {
  [ -s "$SECRETS_DIR/$1" ] && return 0
  openssl rand -hex 32 > "$SECRETS_DIR/$1.tmp"
  mv "$SECRETS_DIR/$1.tmp" "$SECRETS_DIR/$1"
  log "Generated $1"
}
gen_secret postgres-owner-password
gen_secret postgres-web-password
gen_secret postgres-worker-password
gen_secret redis-password
[ -n "$(cenv SESSION_SECRET)" ] || gen_secret session-secret

if [ -z "$(cenv ADMIN_PASSWORD_HASH)" ] && [ ! -s "$SECRETS_DIR/admin-password-hash" ]; then
  password=$(cenv ADMIN_PASSWORD)
  generated=0
  if [ -z "$password" ]; then
    password=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)
    generated=1
  fi
  hash=$(printf '%s' "$password" | node /opt/tools/hash-password.mjs | tail -n1)
  [[ "$hash" =~ ^\$2[aby]\$1[2-9]\$ ]] || die "Hashing the admin password failed (it must be 12–72 characters)."
  printf '%s' "$hash" > "$SECRETS_DIR/admin-password-hash"
  if [ "$generated" = 1 ]; then
    printf '%s\n' "$password" > "$SECRETS_DIR/initial-admin-password"
    log "──────────────────────────────────────────────────────────────"
    log " No admin password was given, so one was generated:"
    log "   $password"
    log " Change it with: docker exec -it <container> print-farm admin-password"
    log " (also saved, root-only, in $SECRETS_DIR/initial-admin-password)"
    log "──────────────────────────────────────────────────────────────"
  else
    log "Admin password set from ADMIN_PASSWORD"
  fi
  unset password hash
fi
chmod 0600 "$SECRETS_DIR"/*

# ── PostgreSQL ────────────────────────────────────────────────────────────────
if [ ! -s "$PG_DATA/PG_VERSION" ]; then
  log "Creating the database cluster (PostgreSQL $PG_MAJOR)"
  s6-setuidgid postgres "$PG_BIN/initdb" -D "$PG_DATA" -U postgres \
    --encoding=UTF8 --locale=C.UTF-8 --auth-local=peer --auth-host=scram-sha-256 >/dev/null
fi
# Only the postgres OS user may use the socket (peer auth: maintenance and
# backups); the three app roles connect over loopback with SCRAM passwords.
cat > "$RUN_DIR/pg_hba.conf" <<EOF
# Written by print-farm init on every boot.
local   all          postgres                                     peer
host    $DB_NAME     $OWNER_ROLE,$WEB_ROLE,$WORKER_ROLE  127.0.0.1/32  scram-sha-256
EOF
chown root:postgres "$RUN_DIR/pg_hba.conf"
chmod 0640 "$RUN_DIR/pg_hba.conf"

# ── Redis ─────────────────────────────────────────────────────────────────────
# The password goes in a file only redis can read, never on a command line
# (/proc/<pid>/cmdline is world-readable).
{
  echo "# Written by print-farm init on every boot."
  echo "bind 127.0.0.1"
  echo "port $REDIS_PORT"
  echo "protected-mode yes"
  echo "daemonize no"
  echo "dir $REDIS_DATA"
  echo "appendonly yes"
  echo "save 3600 1 300 100"
  echo "logfile \"\""
  echo "requirepass $(secret redis-password)"
} > "$RUN_DIR/redis.conf"
chown redis:redis "$RUN_DIR/redis.conf"
chmod 0600 "$RUN_DIR/redis.conf"

# ── nginx ─────────────────────────────────────────────────────────────────────
TRUSTED_PROXY_CIDR=$(cenv TRUSTED_PROXY_CIDR) REAL_IP_HEADER=$(cenv REAL_IP_HEADER X-Real-IP) \
  DIRECT_ACCESS=$(cenv DIRECT_ACCESS 0) \
  "$LIB_DIR/render-nginx.sh" "$LIB_DIR/nginx-site.conf.template" /run/nginx/site.conf
chown root:www-data /run/nginx/site.conf
chmod 0640 /run/nginx/site.conf

# ── Printer profiles ──────────────────────────────────────────────────────────
# PRINTER_MACHINE set: slice with that OrcaSlicer printer's own presets,
# generated from this image's Orca (and regenerated when Orca or the choice
# changes). Unset: the committed, hand-tuned Bambu Lab A1 set.
"$LIB_DIR/printer-profiles.sh"

log "Ready"
