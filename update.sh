#!/usr/bin/env bash
#
# Update this print shop to the latest version: new scripts and the matching
# print-farm image, with a database backup first and an automatic way back if
# the new version doesn't come up.
#
#   sudo ./update.sh              update, if there is anything new
#   sudo ./update.sh --yes        same, without asking (for cron)
#   sudo ./update.sh --rebuild    re-download and restart even when up to date
#   sudo ./update.sh --rollback   go back to the version before the last update
#
# Your settings, rates, colours and quotations are kept: they live in .env and
# the shop's data volume, which an update never replaces.
#
# Installs from before the single image (separate web, worker, database…
# containers) are moved onto it by the first update: the database is copied
# across with a dump and restore, uploads and PDFs are copied, and the old
# volumes are left in place until you delete them.
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
ROOT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"
# shellcheck source=scripts/selfhost/lib.sh
. "$ROOT_DIR/scripts/selfhost/lib.sh"

BACKUP_DIR="$ROOT_DIR/backups"
KEEP_BACKUPS=5
STATE_FILE="$ROOT_DIR/.selfhost/last-update"

YES=0; REBUILD=0; ROLLBACK=0; AFTER_PULL=0

usage() { sed -n '2,18p' "$SELF"; }

preflight() {
  [ "$(id -u)" -eq 0 ] || die "Please run with sudo: sudo $ROOT_DIR/update.sh"
  [ -f "$ENV_FILE" ] || die "No .env in $ROOT_DIR — install first with install.sh."
  load_env
  # The one guard that keeps this script away from any deployment it did not
  # create (print.rish.pw's own server included).
  [ "${CFG[SELFHOST]:-}" = "1" ] || die "$ENV_FILE was not written by install.sh — update.sh only manages installs it created."
  [ "${CFG[SELFHOST_STATE]:-}" = "installed" ] || die "The install never finished. Run: sudo $ROOT_DIR/install.sh"
  docker info >/dev/null 2>&1 || die "Docker is not running (try: systemctl start docker)."
  assert_project_is_ours
  if ! git -C "$ROOT_DIR" diff --quiet || ! git -C "$ROOT_DIR" diff --cached --quiet; then
    err "Files in $ROOT_DIR were edited by hand:"
    git -C "$ROOT_DIR" status --short --untracked-files=no | sed 's/^/    /' >&2
    die "Updating would overwrite them. Undo them with: cd $ROOT_DIR && git checkout -- ."
  fi
}

short() { git -C "$ROOT_DIR" rev-parse --short=7 "${1:-HEAD}"; }

# The multi-container layout (web, worker, postgres… services), from before
# the single image.
legacy_layout() {
  [ -n "$(docker ps -aq --filter label=com.docker.compose.project=print --filter label=com.docker.compose.service=postgres 2>/dev/null)" ]
}

backup_database() {
  local file
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  file="$BACKUP_DIR/$(date +%Y%m%d-%H%M%S)-$(short).pgdump"
  say "  Backing up the database…"
  if legacy_layout; then
    ( umask 077
      dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$file" ) \
      || { rm -f "$file"; die "The database backup failed, so nothing was updated."; }
  else
    ( umask 077; dc exec -T "$SERVICE" print-farm backup > "$file" ) \
      || { rm -f "$file"; die "The database backup failed, so nothing was updated."; }
  fi
  [ -s "$file" ] || { rm -f "$file"; die "The database backup came out empty, so nothing was updated."; }
  ls -1t "$BACKUP_DIR"/*.pgdump 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
  ok "Backup: $file"
  BACKUP_FILE=$file
}

record_state() {
  mkdir -p "$ROOT_DIR/.selfhost"
  printf 'PREV_SHA=%s\nPREV_IMAGE=%s\nBACKUP_FILE=%s\nUPDATED_AT=%s\n' \
    "$1" "$2" "$3" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_FILE"
  chmod 600 "$STATE_FILE"
}
state_value() { sed -n "s/^$1=//p" "$STATE_FILE" 2>/dev/null | head -n1; }

# ── Stage 1: this (old) script decides and fetches ────────────────────────────
stage_fetch() {
  local branch current latest
  branch=${CFG[SELFHOST_BRANCH]:-main}
  head_line "Checking for updates"
  git -C "$ROOT_DIR" fetch --quiet origin "$branch" || die "Could not reach GitHub to check for updates."
  current=$(git -C "$ROOT_DIR" rev-parse HEAD)
  latest=$(git -C "$ROOT_DIR" rev-parse "origin/$branch")
  if [ "$current" = "$latest" ]; then
    ok "Already up to date ($(short))"
    [ "$REBUILD" = 1 ] || exit 0
    say "  Re-downloading and restarting anyway."
  else
    say "  New changes since your version ($(short)):"
    git -C "$ROOT_DIR" log --oneline --no-decorate "HEAD..origin/$branch" | head -25 | sed 's/^/    /'
  fi
  [ "$YES" = 1 ] || confirm "Update now? The site is briefly unavailable while it restarts." Y UPDATE || exit 0

  backup_database
  record_state "$current" "${CFG[PRINT_IMAGE]:-}" "$BACKUP_FILE"

  if [ "$current" != "$latest" ]; then
    if ! git -C "$ROOT_DIR" merge --quiet --ff-only "origin/$branch" 2>/dev/null; then
      # The tree is clean (checked above), so nothing of the owner's is lost.
      warn "The upstream history was rewritten; resetting to it."
      git -C "$ROOT_DIR" reset --quiet --hard "origin/$branch"
    fi
    ok "Code updated to $(short)"
  fi
  # Hand over to the NEW update.sh, so each release's own steps are what run.
  # --after-pull is a stable interface between versions.
  local args=(--after-pull)
  [ "$YES" = 1 ] && args+=(--yes)
  exec bash "$ROOT_DIR/update.sh" "${args[@]}"
}

# ── Stage 2: the new script fetches the image, starts and verifies ────────────
stage_apply() {
  local prev image
  prev=$(state_value PREV_SHA)
  apply_env_defaults || true
  CFG[SELFHOST_VERSION]=$(short)

  head_line "Downloading the new version"
  if [ "${CFG[PRINT_IMAGE]:-}" = print-farm:local ]; then
    write_env
    if ! dc build --pull; then
      err "The build failed. The site is still running the previous version."
      restore_previous_code "$prev"; exit 1
    fi
  else
    image=$(image_for_commit)
    if ! pull_image "$image"; then
      err "The image for $(short) ($image) isn't available yet — it is published a few minutes after each change."
      say "  The site is still running the previous version. Try again later."
      restore_previous_code "$prev"; exit 1
    fi
    CFG[PRINT_IMAGE]=$image
    ok "Downloaded $image"
  fi

  if legacy_layout; then
    move_to_single_image
    return
  fi
  write_env

  head_line "Restarting"
  # Migrations run inside the container before web and worker start; a
  # failure there stops it, which wait_healthy reports like any other.
  if dc up -d --remove-orphans && wait_healthy 600; then
    docker image prune -f >/dev/null 2>&1 || true
    ok "Updated to $(short)"
    say "  If anything looks wrong: sudo $ROOT_DIR/update.sh --rollback"
    return 0
  fi

  err "The new version did not come up."
  if [ "$YES" = 1 ] || confirm "Roll back to the previous version now?" Y ROLLBACK; then
    rollback
  else
    say "  Left as is. Roll back later with: sudo $ROOT_DIR/update.sh --rollback"
  fi
  exit 1
}

# After a failed download nothing was restarted: only the code needs to go back.
restore_previous_code() {
  [ -n "${1:-}" ] || return 0
  git -C "$ROOT_DIR" reset --quiet --hard "$1"
  say "  Code put back to $(short)."
}

# ── One-time move from the multi-container layout ─────────────────────────────
move_to_single_image() {
  local mode=${CFG[SELFHOST_MODE]:-} backup prev
  backup=$(state_value BACKUP_FILE)
  prev=$(state_value PREV_SHA)
  head_line "Moving to the single-container layout"
  say "  This version runs the whole shop in one container. Your database, uploads and"
  say "  PDFs are copied into it; the old containers are removed, the old data kept."

  case "$mode" in
    caddy|tunnel)
      # Those modes had HTTPS (Caddy, or the bundled cloudflared) inside the
      # stack. The image serves plain HTTP only, so going ahead would take the
      # site off HTTPS.
      err "Your site gets its HTTPS from the Caddy/cloudflared containers this version no longer includes."
      say "  Set up HTTPS in front of the shop first (a reverse proxy such as Caddy on this server, or"
      say "  your own Cloudflare Tunnel), then run: sudo $ROOT_DIR/install.sh  and choose option 2."
      say "  docs/SELF-HOSTING.md (\"Moving from the old layout\") walks through it."
      restore_previous_code "$prev"
      exit 1 ;;
  esac
  [ -s "$backup" ] || die "No database backup from this update to move across; nothing was changed."
  [ "$YES" = 1 ] || confirm "Move now? The site is down for a few minutes." Y MOVE || { restore_previous_code "$prev"; exit 1; }

  # Network settings in the new form. The edge network and its Caddy are gone:
  # the shop is published directly where Caddy was.
  local old_bind=${CFG[LOCAL_BIND]:-${CFG[PROXY_BIND]:-127.0.0.1}}
  case "$mode" in
    local) CFG[PROXY_BIND]=$old_bind; CFG[PROXY_PORT]=${CFG[LOCAL_PORT]:-8000}; CFG[TRUSTED_PROXY_CIDR]="" ;;
    owntunnel)
      CFG[SELFHOST_MODE]=tunnel
      CFG[PROXY_BIND]=$old_bind; CFG[PROXY_PORT]=${CFG[LOCAL_PORT]:-8000}
      CFG[REAL_IP_HEADER]=CF-Connecting-IP
      if [ "$old_bind" = 127.0.0.1 ]; then CFG[TRUSTED_PROXY_CIDR]=${CFG[PRINT_GATEWAY]}
      else
        CFG[TRUSTED_PROXY_CIDR]=""
        warn "Tell the shop which address cloudflared connects from, so it sees visitors' real addresses:"
        hint "sudo $ROOT_DIR/install.sh → option 2 (until then every visitor shares one rate limit)."
      fi ;;
    proxy)
      CFG[PROXY_BIND]=${CFG[PROXY_BIND]:-127.0.0.1}; CFG[PROXY_PORT]=8080
      # A proxy on this host reached the old loopback port through Docker too,
      # so it was trusted as the old network's gateway; the new one has its own.
      if [ "${CFG[PROXY_BIND]}" = 127.0.0.1 ]; then CFG[TRUSTED_PROXY_CIDR]=${CFG[PRINT_GATEWAY]}; fi ;;
  esac
  local key
  for key in "${LEGACY_ENV_KEYS[@]}"; do unset "CFG[$key]"; done
  write_env

  say "  Stopping the old containers…"
  docker ps -aq --filter label=com.docker.compose.project=print | xargs -r docker rm -f >/dev/null
  # The old edge/backend networks; anything still attached is not ours to remove.
  docker network ls -q --filter label=com.docker.compose.project=print | xargs -r docker network rm >/dev/null 2>&1 || true

  # Order matters. The worker's cleanup sweep deletes any upload or PDF the
  # database doesn't know, and it runs as soon as the container starts. So the
  # database goes in first, into a container that still has no files, and the
  # files are copied only once every row that names them is back.
  head_line "Starting"
  dc up -d --remove-orphans || die "Starting failed. See: cd $ROOT_DIR && docker compose logs --tail 80"
  wait_healthy 600 || die "The new container didn't come up. The old data is untouched; see docs/SELF-HOSTING.md."
  say "  Restoring the database…"
  dc exec -T "$SERVICE" print-farm restore < "$backup" || die "Restoring the database failed. The old data is untouched; see docs/SELF-HOSTING.md."
  wait_healthy 300 || die "The site didn't come back after the restore."

  say "  Copying uploads and PDFs…"
  local data_vol old_vol
  data_vol=$(docker volume ls -q --filter label=com.docker.compose.project=print --filter label=com.docker.compose.volume=data | head -n1)
  [ -n "$data_vol" ] || die "The new data volume was not created."
  local -a mounts=(-v "$data_vol:/data")
  for old_vol in uploads pdfs; do
    local v
    v=$(docker volume ls -q --filter label=com.docker.compose.project=print --filter "label=com.docker.compose.volume=$old_vol" | head -n1)
    [ -n "$v" ] && mounts+=(-v "$v:/old/$old_vol:ro")
  done
  docker run --rm --network none "${mounts[@]}" --entrypoint sh "${CFG[PRINT_IMAGE]}" -c '
    set -e
    for d in uploads pdfs; do
      mkdir -p /data/$d
      [ -d /old/$d ] && cp -a /old/$d/. /data/$d/
    done
    # What arrived, for the log below: every regular file under each.
    for d in uploads pdfs; do printf "%s=%s\n" $d "$(find /data/$d -type f | wc -l)"; done' \
    | sed 's/^/    /' || die "Copying the files failed. The old data is untouched; see docs/SELF-HOSTING.md."

  ok "Moved to the single container ($(short))"
  say "  The old volumes are still there, in case anything is missing. Once you're happy:"
  say "    docker volume rm $(docker volume ls -q --filter label=com.docker.compose.project=print \
    | grep -E '_(pgdata|redisdata|uploads|pdfs|caddy_data|caddy_config)$' | paste -sd' ' -)"
}

rollback() {
  local prev image backup
  [ -f "$STATE_FILE" ] || die "There is no earlier version to roll back to."
  prev=$(state_value PREV_SHA)
  image=$(state_value PREV_IMAGE)
  backup=$(state_value BACKUP_FILE)
  [ -n "$image" ] || die "The last update came from the old multi-container layout; it can't be rolled back automatically.
  Its database backup is $backup — see docs/SELF-HOSTING.md."
  head_line "Rolling back to $(short "$prev")"
  docker image inspect "$image" >/dev/null 2>&1 || pull_image "$image" \
    || die "The previous image ($image) is gone and can't be downloaded; can't roll back automatically."
  git -C "$ROOT_DIR" reset --quiet --hard "$prev"
  load_env
  CFG[PRINT_IMAGE]=$image
  CFG[SELFHOST_VERSION]=$(short)
  write_env
  dc up -d --remove-orphans || true
  if wait_healthy 600; then
    ok "Back on $(short)"
  else
    err "The previous version didn't come up either."
  fi
  warn "Database changes made by the newer version were NOT undone."
  if [ -n "$backup" ] && [ -f "$backup" ]; then
    say "  If the site misbehaves, restore the backup taken just before the update:"
    say "    cd $ROOT_DIR && docker compose exec -T $SERVICE print-farm restore < $backup"
  fi
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes|-y) YES=1 ;;
      # --full is the old name, kept so existing cron lines keep working.
      --rebuild|--full) REBUILD=1 ;;
      --rollback) ROLLBACK=1 ;;
      --after-pull) AFTER_PULL=1 ;;
      --help|-h) usage; exit 0 ;;
      *) die "Unknown option $1 (try --help)" ;;
    esac
    shift
  done
  [ "$YES" = 1 ] && export PS_UNATTENDED=1
  preflight
  if [ "$ROLLBACK" = 1 ]; then
    [ "$YES" = 1 ] || confirm "Go back to the version before the last update?" N ROLLBACK || exit 0
    rollback
  elif [ "$AFTER_PULL" = 1 ]; then
    stage_apply
  else
    stage_fetch
  fi
}

# Everything above is only definitions, so bash has read the whole file before
# anything runs — the update replacing this file mid-run can't corrupt it.
main "$@"; exit
