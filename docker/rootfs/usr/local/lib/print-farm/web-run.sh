#!/bin/bash
# Next.js as the unprivileged nextjs user on 127.0.0.1:3000 — reachable only
# through nginx. Its environment is built from scratch: an explicit allowlist,
# so nothing else the container was given (or the worker's credential) leaks in.
PF_COMPONENT=web
# shellcheck source=common.sh
. /usr/local/lib/print-farm/common.sh

e=(
  PATH=/usr/local/bin:/usr/bin:/bin
  HOME=/tmp
  LANG=en_US.UTF-8
  NODE_ENV=production
  PORT=3000
  HOSTNAME=127.0.0.1
  "APP_ORIGIN=$(conf APP_ORIGIN http://localhost:8080)"
  "DATABASE_URL=$(web_db_url)"
  "REDIS_URL=$(redis_url)"
  "SESSION_SECRET=$(session_secret)"
  "UPLOAD_DIR=$UPLOAD_DIR"
  "PDF_DIR=$PDF_DIR"
)
for name in WHATSAPP_NUMBER CONTACT_EMAIL GOOGLE_MAPS_EMBED_URL RESEND_API_KEY MAIL_TO \
    TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID TELEGRAM_MESSAGE_THREAD_ID \
    SHIPROCKET_EMAIL SHIPROCKET_PASSWORD; do
  pass_env e "$name"
done
pass_env e CONTACT_FROM
pass_env e SHIPROCKET_PICKUP_PINCODE
pass_env e MAX_UPLOAD_MB 300
pass_env e MAX_SESSION_UPLOAD_MB 900
pass_env e UPLOAD_WINDOW_MB 900
pass_env e DOWNLOAD_WINDOW_MB 1200
pass_env e STORAGE_RESERVE_MB 2048
pass_env e MAX_MODELS_PER_SESSION 20
# The same retention the worker sweeps with, so admin and the FAQ show it
# until admin -> Settings -> File clean-up is saved.
pass_env e UPLOAD_RETENTION_HOURS 48
pass_env e FILE_RETENTION_DAYS 30
pass_env e QUOTATION_RETENTION_DAYS 90
pass_env e LOG_LEVEL info
e+=("ADVANCED_PROFILES=$(advanced_profiles)")
# The admin password from the environment, if one is set there; otherwise the
# web reads the owner's from the database, and until there is one it accepts
# the first-run setup code (migrate.sh) to create it.
hash=$(admin_password_hash)
[ -n "$hash" ] && e+=("ADMIN_PASSWORD_HASH=$hash")
[ -s "$SECRETS_DIR/setup-code" ] && e+=("SETUP_CODE=$(<"$SECRETS_DIR/setup-code")")
unset hash
# The owner's server settings: where the web saves them, the printers they may
# pick from, and which ones the environment overrides (shown as locked).
e+=("SERVER_SETTINGS_FILE=$SETTINGS_FILE" "PRINTERS_FILE=$PRINTERS_LIST")
locked=""
for name in APP_ORIGIN TRUSTED_PROXY_CIDR PRINTER_MACHINE; do
  [ -n "$(cenv "$name")" ] && locked+="${locked:+,}$name"
done
e+=("SERVER_SETTINGS_LOCKED=$locked")
# The web needs its address now and then for links (PDFs, messages), so it
# gets it from the settings at start; a change restarts it (settings-run.sh).
# The generated printer set (init → printer-profiles.sh) names the printer and
# its build volume; without one no printer is set up and no quotes are taken.
[ -f "$PRINTER_DIR/.stamp" ] && e+=("PRINTER_SPEC_FILE=$PRINTER_DIR/printer.json")

cd /app
# common.sh's umask 077 is for secrets. The app sets explicit modes where they
# matter, and the sandboxed parse/slice uids must traverse the job directories
# the orchestrator creates: run with the conventional default, as before.
umask 022
exec_with_env e s6-setuidgid "$STORAGE_USER" \
  sh -c 'node /app/scripts/validate-env.mjs && echo "[web] Starting Next.js on 127.0.0.1:${PORT}" && exec node apps/web/server.js'
