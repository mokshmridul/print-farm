# shellcheck shell=bash
# shellcheck disable=SC2034  # ANS and CFG are read by the scripts that source this
# Shared helpers for install.sh and update.sh. Sourced, never executed.
#
# Every prompt can also be answered by an environment variable (PS_<NAME>), which
# is how unattended installs and the installer's own end-to-end test work. With
# PS_UNATTENDED=1 nothing is ever read from the terminal: a missing required
# answer is an error instead of a question.

# ── Output ──────────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_BOLD=""; C_DIM=""; C_OFF=""
fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '%s! %s%s\n' "$C_YELLOW" "$*" "$C_OFF"; }
err()  { printf '%s✗ %s%s\n' "$C_RED" "$*" "$C_OFF" >&2; }
die()  { err "$*"; exit 1; }
hint() { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
head_line() { printf '\n%s== %s ==%s\n' "$C_BOLD" "$*" "$C_OFF"; }

unattended() { [ "${PS_UNATTENDED:-0}" = "1" ]; }

# ── Prompts ─────────────────────────────────────────────────────────────────────
# confirm "Question?" [Y|N] — returns 0 for yes. Unattended: the default, or the
# value of PS_CONFIRM_<KEY> when a third argument names one.
confirm() {
  local q="$1" def="${2:-N}" key="${3:-}" hint ans
  if [ -n "$key" ]; then
    local envname="PS_CONFIRM_${key}"
    if [ -n "${!envname:-}" ]; then
      case "${!envname,,}" in y|yes|1|true) return 0 ;; *) return 1 ;; esac
    fi
  fi
  if unattended; then [ "$def" = "Y" ]; return; fi
  if [ "$def" = "Y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  while true; do
    read -r -p "$q $hint " ans </dev/tty || die "Input closed."
    ans="${ans:-$def}"
    case "${ans,,}" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
    esac
  done
}

# Answers collected by the wizard, keyed by name. PS_<NAME> in the environment
# answers a question without asking (validated the same way).
# shellcheck disable=SC2034  # read by install.sh
declare -A ANS=()

# _prompt "Prompt" [default] — one line from the terminal, printed on stdout.
_prompt() {
  local q=$1 a
  if [ $# -ge 2 ]; then
    if unattended; then printf '%s' "$2"; return; fi
    read -r -p "$q [${2:-leave empty}]: " a </dev/tty || die "Input closed."
    printf '%s' "${a:-$2}"
  else
    unattended && die "Unattended install is missing an answer for: $q"
    while true; do
      read -r -p "$q: " a </dev/tty || die "Input closed."
      [ -n "$a" ] && { printf '%s' "$a"; return; }
      warn "This one is required." >&2
    done
  fi
}

# ask NAME "Prompt" [default [validator [message]]] — stores ANS[NAME]. Without a
# default (or with the default "--required") the answer is required. A
# validator (function) is re-asked until it accepts; an env-supplied answer
# that fails it is an error when unattended.
ask() {
  local name=$1 q=$2 env="PS_$1" v check="${4:-}" msg="${5:-That does not look right.}"
  local -a def=()
  [ $# -ge 3 ] && [ "$3" != "--required" ] && def=("$3")
  if [ -n "${!env+x}" ]; then
    v="${!env}"
    if [ -z "$check" ] || "$check" "$v"; then ANS[$name]="$v"; return; fi
    unattended && die "$env: $msg (got '$v')"
    warn "$env: $msg"
  fi
  while true; do
    v=$(_prompt "$q" "${def[@]}")
    if [ -z "$check" ] || "$check" "$v"; then ANS[$name]="$v"; return; fi
    unattended && die "$q: $msg"
    warn "$msg"
  done
}

# ask_secret NAME "Prompt" [validator [message]] — hidden input, required.
ask_secret() {
  local name=$1 q=$2 env="PS_$1" v check="${3:-}" msg="${4:-That does not look right.}"
  if [ -n "${!env:-}" ]; then
    v="${!env}"
    if [ -z "$check" ] || "$check" "$v"; then ANS[$name]="$v"; return; fi
    die "$env: $msg"
  fi
  unattended && die "Unattended install is missing ${env}."
  while true; do
    read -r -s -p "$q: " v </dev/tty || die "Input closed."
    echo
    if [ -z "$v" ]; then warn "This one is required."; continue; fi
    if [ -z "$check" ] || "$check" "$v"; then ANS[$name]="$v"; return; fi
    warn "$msg"
  done
}

mask() {
  local v="${1:-}"
  if [ -z "$v" ]; then echo "(not set)"; else echo "${v:0:4}…(hidden)"; fi
}

# ── Validators ──────────────────────────────────────────────────────────────────
valid_domain()   { [[ "$1" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]]; }
valid_email()    { [[ "$1" =~ ^[^[:space:]@\']+@[^[:space:]@\']+\.[^[:space:]@\']+$ ]]; }
valid_email_or_empty() { [ -z "$1" ] || valid_email "$1"; }
valid_ipv4()     { [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] && \
                   (( BASH_REMATCH[1] <= 255 && BASH_REMATCH[2] <= 255 && BASH_REMATCH[3] <= 255 && BASH_REMATCH[4] <= 255 )); }
valid_rupees()   { [[ "$1" =~ ^[0-9]{1,6}(\.[0-9]{1,2})?$ ]]; }
valid_rate()     { valid_rupees "$1" && [ "$(to_paise "$1")" -ge 1 ] && [ "$(to_paise "$1")" -le 100000 ]; }
valid_whatsapp_or_empty() { local d; d=$(digits "$1"); [ -z "$1" ] || [[ "$d" =~ ^[0-9]{8,15}$ ]]; }
valid_phone_or_empty() { [ -z "$1" ] || [[ "$1" =~ ^\+?[0-9][0-9\ \(\)-]{5,22}$ ]]; }
valid_pincode_or_empty() { [ -z "$1" ] || [[ "$1" =~ ^[1-9][0-9]{5}$ ]]; }
valid_maps_or_empty() { [ -z "$1" ] || [[ "$1" =~ ^https://(www\.)?google\.com/maps/embed[?/][^\'[:space:]]*$ ]]; }
# Free text that ends up in .env or JSON: one line, no quotes that could break
# either format, sensible length.
valid_text()     { [ -n "$1" ] && valid_text_or_empty "$1"; }
valid_text_or_empty() { [ ${#1} -le 120 ] && [[ "$1" != *\'* ]] && [[ "$1" != *\"* ]] && [[ "$1" != *\\* ]]; }
valid_address_or_empty() { [ ${#1} -le 300 ] && [[ "$1" != *\"* ]] && [[ "$1" != *\\* ]]; }
valid_password() { local n; n=$(printf '%s' "$1" | wc -c); [ "$n" -ge 12 ] && [ "$n" -le 72 ]; }

digits() { printf '%s' "$1" | tr -cd '0-9'; }

# "2.5" → 250, "150" → 15000. Callers validate with valid_rupees first.
to_paise() {
  local whole frac
  whole="${1%%.*}"
  if [[ "$1" == *.* ]]; then frac="${1#*.}"; else frac=""; fi
  frac="${frac}00"; frac="${frac:0:2}"
  echo $(( 10#$whole * 100 + 10#$frac ))
}
# 250 → "2.50"
from_paise() { printf '%d.%02d' $(( $1 / 100 )) $(( $1 % 100 )); }

# ── JSON (no jq on a fresh server) ──────────────────────────────────────────────
json_str() {
  local s
  s=$(printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037')
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\t'/\\t}; s=${s//$'\n'/\\n}; s=${s//$'\r'/}
  printf '"%s"' "$s"
}

# ── .env ────────────────────────────────────────────────────────────────────────
declare -A CFG=()

# Parse without sourcing: KEY=value, KEY='literal value'.
load_env() {
  local file="${1:-$ENV_FILE}" line key val
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    if [[ "$val" == \'*\' ]]; then val="${val:1:${#val}-2}"; fi
    CFG[$key]="$val"
  done < "$file"
}

# Compose .env value: single-quoted (taken literally — no $ interpolation, so a
# bcrypt hash needs no doubling) unless it is plainly safe as-is.
env_value() {
  local v="$1"
  if [[ "$v" =~ ^[A-Za-z0-9_./:@,+-]*$ ]]; then printf '%s' "$v"; else printf "'%s'" "$v"; fi
}

# Ordered sections of every key install.sh manages. Keys found in an existing
# .env that are not listed here are kept, under "Other".
ENV_LAYOUT=(
  "# --- Install (managed by install.sh / update.sh) ---"
  SELFHOST SELFHOST_STATE SELFHOST_VERSION SELFHOST_BRANCH SELFHOST_MODE SELFHOST_DOMAIN
  COMPOSE_FILE PRINT_IMAGE_REPO PRINT_IMAGE PRINT_DATA_DIR PRINT_PROFILES_DIR
  "# --- Network ---"
  APP_ORIGIN PROXY_BIND PROXY_PORT TRUSTED_PROXY_CIDR REAL_IP_HEADER DIRECT_ACCESS PRINT_SUBNET PRINT_GATEWAY
  "# --- App secrets (database and Redis passwords are generated inside the container) ---"
  SESSION_SECRET ADMIN_PASSWORD_HASH
  "# --- Integrations (optional) ---"
  GOOGLE_MAPS_EMBED_URL RESEND_API_KEY MAIL_TO CONTACT_FROM
  TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID SHIPROCKET_EMAIL SHIPROCKET_PASSWORD SHIPROCKET_PICKUP_PINCODE
  "# --- Sizing ---"
  MAX_UPLOAD_MB WORKER_CONCURRENCY PRINT_MEMORY
  "# --- Printer (profiles generated inside the container) ---"
  PRINTER_MACHINE PRINTER_MULTI_MATERIAL PRINTER_ADVANCED PRINTER_DISPLAY_NAME
)

# Keys only the old multi-container layout used. update.sh drops them once an
# install has moved to the single image.
LEGACY_ENV_KEYS=(
  SELFHOST_ACME_EMAIL SELFHOST_TLS_INTERNAL
  EDGE_SUBNET EDGE_CADDY_IP TUNNEL_SUBNET TUNNEL_CADDY_IP TUNNEL_CLOUDFLARED_IP CLOUDFLARE_TUNNEL_TOKEN
  LOCAL_PORT LOCAL_BIND
  POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB MIGRATION_DATABASE_URL DATABASE_URL WORKER_DATABASE_URL REDIS_PASSWORD
  SELFHOST_WEB_CPUS SELFHOST_WORKER_CPUS SELFHOST_DB_CPUS
)

write_env() {
  local tmp key line
  local -A written=()
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  {
    echo "# Print shop configuration — written by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "# Contains secrets: keep it private (chmod 600) and back it up."
    echo "# Shop name, contact details and rates live in the admin dashboard, not here."
    for line in "${ENV_LAYOUT[@]}"; do
      if [[ "$line" == \#* ]]; then echo; echo "$line"; continue; fi
      written[$line]=1
      [ -n "${CFG[$line]+x}" ] || continue
      printf '%s=%s\n' "$line" "$(env_value "${CFG[$line]}")"
    done
    local first=1
    for key in $(printf '%s\n' "${!CFG[@]}" | sort); do
      [ -n "${written[$key]+x}" ] && continue
      if [ "$first" = 1 ]; then echo; echo "# --- Other ---"; first=0; fi
      printf '%s=%s\n' "$key" "$(env_value "${CFG[$key]}")"
    done
  } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

rand_hex() { openssl rand -hex "${1:-32}"; }

# ── Docker ──────────────────────────────────────────────────────────────────────
# Compose reads COMPOSE_FILE and the project name from the process before .env,
# so clear anything inherited: this checkout's .env is what counts. Run from the
# install folder — relative COMPOSE_FILE entries resolve against the working
# directory, exactly as when the owner types `docker compose` there.
dc() {
  ( cd "$ROOT_DIR" && env -u COMPOSE_FILE -u COMPOSE_PROJECT_NAME -u COMPOSE_PROFILES \
      -u PRINT_IMAGE -u PRINT_DATA_DIR -u PRINT_PROFILES_DIR -u APP_ORIGIN -u ADMIN_PASSWORD -u ADMIN_PASSWORD_HASH -u SESSION_SECRET \
      docker compose "$@" )
}

SELFHOST_COMPOSE_FILE="docker-compose.yml:docker/selfhost/compose.selfhost.yml"

# ── Where the data lives ──────────────────────────────────────────────────────
# Everything durable is the container's /data: a directory on this server when
# PRINT_DATA_DIR is set (new installs: <install folder>/data), otherwise the
# named Docker volume earlier installs use.

# An absolute path compose can take as a bind source (no ":" or ",", no "." or
# ".." parts), and never the install folder or one of its parents: emptying it
# (uninstall, "start empty") would take the code with it.
valid_data_dir() {
  [[ "$1" =~ ^/[A-Za-z0-9._/@+-]*[A-Za-z0-9._@+-]$ ]] || return 1
  [[ ! "$1" =~ (^|/)\.\.?(/|$) ]] || return 1
  local d=${1%/} root=${ROOT_DIR%/}
  [ "$root/" != "${d}/" ] && [[ "$root/" != "$d/"* ]]
}

# The named data volume, if one exists.
named_data_volume() {
  docker volume ls -q --filter label=com.docker.compose.project=print \
    --filter label=com.docker.compose.volume=data 2>/dev/null | head -n1 || true
}

# "SOURCE:/data" for a one-off container, wherever the data lives. Empty if it
# isn't anywhere yet.
data_mount() {
  if [ -n "${CFG[PRINT_DATA_DIR]:-}" ]; then
    printf '%s:/data' "${CFG[PRINT_DATA_DIR]}"
  else
    local vol; vol=$(named_data_volume)
    [ -z "$vol" ] || printf '%s:/data' "$vol"
  fi
}

# Human-readable location, for messages.
data_location() {
  if [ -n "${CFG[PRINT_DATA_DIR]:-}" ]; then printf '%s' "${CFG[PRINT_DATA_DIR]}"
  else printf 'the Docker volume %s' "$(named_data_volume)"; fi
}

dir_has_files() { [ -d "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; }

# ── The profiles folder ───────────────────────────────────────────────────────
# OrcaSlicer exports the shop slices with, in printer/ process/ filament/; the
# container picks them up as it starts (docs/SELF-HOSTING.md).
profiles_dir() { printf '%s' "${CFG[PRINT_PROFILES_DIR]:-$ROOT_DIR/profiles}"; }

valid_profiles_source() { [ -z "$1" ] || [ -e "$1" ]; }

# import_profiles SOURCE — sort the OrcaSlicer exports at SOURCE (one file or a
# folder of them) into the profiles folder, byte for byte. Runs the image's
# sorter with no network and only the access it needs; CFG[PRINT_IMAGE] must be
# present locally. Returns 1 when nothing usable was found.
import_profiles() {
  local src dest out line kind a b placed=0
  src=$(readlink -f -- "$1") || { err "Can't find $1."; return 1; }
  dest=$(profiles_dir)
  mkdir -p "$dest" && chmod 0755 "$dest"
  local -a mount
  if [ -d "$src" ]; then mount=(-v "$src:/in:ro"); else mount=(-v "$src:/in/$(basename "$src"):ro"); fi
  head_line "Your OrcaSlicer presets"
  out=$(docker run --rm --network none --read-only --cap-drop ALL --cap-add DAC_READ_SEARCH \
    --security-opt no-new-privileges "${mount[@]}" -v "$dest:/out" \
    --entrypoint node "${CFG[PRINT_IMAGE]}" /opt/tools/sort-profiles.mjs /in /out 2>&1) || true
  while IFS=$'\t' read -r kind a b; do
    case "$kind" in
      placed) ok "$a"; placed=$((placed + 1)) ;;
      replaced) say "  Replaced the earlier $a" ;;
      skipped) warn "Not used: $a — $b" ;;
      "") ;;
      *) say "  $kind${a:+ $a}${b:+ $b}" ;;
    esac
  done <<< "$out"
  if [ "$placed" = 0 ]; then
    warn "No OrcaSlicer presets found in $1."
    return 1
  fi
  say "  In $dest — the shop test-slices them when it starts; admin → Filament → Slicer profiles shows the result."
}

# PRINT_DATA_DIR newly set while the data is still in the named volume: copy it
# into the directory once, with the container stopped so PostgreSQL's files are
# consistent. The volume is kept until the owner removes it. Needs
# CFG[PRINT_IMAGE] present locally (it runs the copy).
move_data_to_dir() {
  local dir=${CFG[PRINT_DATA_DIR]:-} vol counts
  [ -n "$dir" ] || return 0
  valid_data_dir "$dir" || die "PRINT_DATA_DIR must be an absolute path like $ROOT_DIR/data, not the install folder or above it (got '$dir')."
  vol=$(named_data_volume)
  [ -n "$vol" ] || return 0
  # Already moved, or the directory is in use: leave both alone.
  dir_has_files "$dir" && return 0
  head_line "Moving the data to $dir"
  say "  From the Docker volume $vol. The site is down while it copies."
  dc stop "$SERVICE" >/dev/null 2>&1 || true
  mkdir -p "$dir" && chmod 0755 "$dir" || die "Could not create $dir."
  counts=$(docker run --rm --network none -v "$vol:/from:ro" -v "$dir:/to" --entrypoint sh "${CFG[PRINT_IMAGE]}" -c '
    set -e
    cp -a /from/. /to/
    a=$(find /from | wc -l); b=$(find /to | wc -l)
    [ "$a" = "$b" ] || { echo "copied $b of $a entries" >&2; exit 1; }
    echo "$b"') || die "Copying the data failed; it is still in $vol, untouched. Empty $dir and try again."
  ok "Data moved to $dir ($counts files and folders)"
  say "  The old volume is kept. Once the site looks right: docker volume rm $vol"
}
SERVICE=print-farm
DEFAULT_IMAGE_REPO="ghcr.io/mokshmridul/print-farm"

# The compose project name is pinned in docker-compose.yml ("print"), so any
# other checkout's stack on this machine would be the SAME project. Refuse to
# touch a stack that was started from a different directory.
assert_project_is_ours() {
  local dirs d
  dirs=$(docker ps -a --filter "label=com.docker.compose.project=print" \
    --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | sort -u)
  for d in $dirs; do
    if [ -n "$d" ] && [ "$(cd "$d" 2>/dev/null && pwd -P)" != "$(cd "$ROOT_DIR" && pwd -P)" ]; then
      die "Another print stack on this machine was started from $d.
  This installer manages exactly one stack per server and will not touch it."
    fi
  done
}

# Waits until the container reports healthy: web, database, Redis and the
# slicing worker all answer (print-farm health).
wait_healthy() {
  local timeout="${1:-300}" waited=0 state id
  printf '  waiting for the site to come up '
  while true; do
    id=$(dc ps -q "$SERVICE" 2>/dev/null || true)
    state=$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo starting)
    if [ "$state" = healthy ]; then echo; ok "Site is up"; return 0; fi
    if [ -n "$id" ] && [ "$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null)" = false ] \
      && [ "$waited" -ge 15 ]; then
      echo; err "The container stopped while starting."
      hint "See what went wrong with: cd $ROOT_DIR && docker compose logs --tail 80"
      return 1
    fi
    if [ "$waited" -ge "$timeout" ]; then
      echo; err "The site did not come up within ${timeout}s (state: $state)."
      hint "See what went wrong with: cd $ROOT_DIR && docker compose logs --tail 80"
      return 1
    fi
    printf '.'; sleep 5; waited=$((waited + 5))
  done
}

# A /24 in 172.30.0.0/16 not used by this host's routes or Docker networks.
pick_subnet() {
  local skip="${1:-}" n used
  # shellcheck disable=SC2046  # one argument per network id
  used="$(ip -4 route 2>/dev/null; docker network inspect $(docker network ls -q) \
    -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null || true)"
  for n in $(seq 10 250); do
    [ "172.30.$n.0/24" = "$skip" ] && continue
    grep -q "172\.30\.$n\." <<<"$used" && continue
    echo "172.30.$n.0/24"; return 0
  done
  die "Could not find a free private subnet for the shop's network."
}
subnet_host() { local s="${1%/*}"; echo "${s%.*}.$2"; }

# ── Image ───────────────────────────────────────────────────────────────────────
# Every commit on the main branch is published as <repo>:sha-<7 hex>, so the
# image always matches this checkout's scripts. `latest` is the fallback for a
# commit whose image is still being built.
image_for_commit() { echo "${CFG[PRINT_IMAGE_REPO]:-$DEFAULT_IMAGE_REPO}:sha-$(git -C "$ROOT_DIR" rev-parse --short=7 HEAD)"; }

# pull_image IMAGE — 0 on success. Quiet unless it fails.
pull_image() {
  local out
  out=$(docker pull "$1" 2>&1) && return 0
  printf '%s\n' "$out" | tail -n 3 | sed 's/^/    /' >&2
  return 1
}

# hash_admin_password IMAGE PASSWORD — prints the bcrypt hash. Runs the image's
# own helper (the library the login route verifies with) with no network.
hash_admin_password() {
  local hash
  hash=$(printf '%s' "$2" | docker run --rm -i --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --entrypoint node "$1" /opt/tools/hash-password.mjs 2>/dev/null | tail -n1) || hash=""
  [[ "$hash" =~ ^\$2[aby]\$1[2-9]\$[./A-Za-z0-9]{53}$ ]] || return 1
  printf '%s' "$hash"
}

# Fill keys a newer version expects, without touching anything already set.
# Returns 0 if something was added.
apply_env_defaults() {
  local changed=1
  _default() { if [ -z "${CFG[$1]+x}" ]; then CFG[$1]="$2"; changed=0; fi; }
  _default SELFHOST_BRANCH "main"
  _default PRINT_IMAGE_REPO "$DEFAULT_IMAGE_REPO"
  _default MAX_UPLOAD_MB "300"
  _default WORKER_CONCURRENCY "1"
  _default PRINTER_MULTI_MATERIAL "0"
  _default PROXY_PORT "8080"
  _default REAL_IP_HEADER "X-Real-IP"
  _default PRINT_MEMORY "$(default_memory_limit)"
  if [ -z "${CFG[PRINT_SUBNET]:-}" ]; then
    CFG[PRINT_SUBNET]=$(pick_subnet)
    CFG[PRINT_GATEWAY]=$(subnet_host "${CFG[PRINT_SUBNET]}" 1)
    changed=0
  fi
  if [ "${CFG[COMPOSE_FILE]:-}" != "$SELFHOST_COMPOSE_FILE" ]; then CFG[COMPOSE_FILE]=$SELFHOST_COMPOSE_FILE; changed=0; fi
  return $changed
}

# The container's memory ceiling: 12 GB, or what this server has less 1 GB.
default_memory_limit() {
  local mem_mb
  mem_mb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
  if [ "$mem_mb" -ge 13312 ]; then echo 12g; else echo "$(( mem_mb > 2048 ? mem_mb - 1024 : mem_mb ))m"; fi
}
