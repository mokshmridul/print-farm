#!/bin/bash
# Applies the owner's server settings when they change. The web saves
# $SETTINGS_FILE (first-run tour, admin → Settings → Server); this notices
# within a few seconds, validates it (load_settings), regenerates the printer's
# profiles if the printer changed, re-renders nginx for the proxy settings and
# restarts web and worker so they start with the new values. A file that
# doesn't validate changes nothing.
PF_COMPONENT=settings
# shellcheck source=common.sh
. /usr/local/lib/print-farm/common.sh

signature() { sha256sum "$SETTINGS_FILE" 2>/dev/null | cut -d' ' -f1 || echo none; }

last=$(signature)
while sleep 2; do
  now=$(signature)
  [ "$now" = "$last" ] && continue
  # Let a save finish (the web writes a temporary file and renames it).
  sleep 1
  now=$(signature)
  last=$now
  log "Server settings changed: applying"
  before=$(cat "$RUN_DIR/settings.env" 2>/dev/null || true)
  load_settings || continue
  if [ "$(cat "$RUN_DIR/settings.env")" = "$before" ]; then
    log "Nothing to change"
    continue
  fi
  if ! "$LIB_DIR/printer-profiles.sh"; then
    log "The printer setting couldn't be applied; the previous printer stays"
  fi
  if render_nginx; then
    s6-svc -h /run/service/nginx
  else
    log "The proxy settings couldn't be applied; nginx keeps the previous ones"
  fi
  svc_restart worker
  svc_restart web
  log "Server settings applied"
done
