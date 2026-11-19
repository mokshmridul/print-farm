#!/usr/bin/env bash
#
# Print shop installer — sets up your own copy of this 3D-printing quote site.
#
#   curl -fsSL https://raw.githubusercontent.com/zappymussel380/print.rish.pw/main/install.sh | sudo bash
#
# It asks for your shop's name, web address, rates, materials and contact
# details, then downloads the print-farm image and starts it: one container
# with everything inside (web, slicer, database). Run it again from the install
# folder (sudo ./install.sh) to change the web address, admin password or
# integrations, reset the shop settings, or uninstall. Update with:
#
#   sudo /opt/print-shop/update.sh
#
# Unattended installs: set PS_UNATTENDED=1 and answer with PS_* variables
# (see docs/SELF-HOSTING.md), e.g. `curl … | sudo PS_UNATTENDED=1 PS_BRAND=… bash`.
set -euo pipefail

PS_REPO="${PS_REPO:-https://github.com/zappymussel380/print.rish.pw.git}"
PS_BRANCH="${PS_BRANCH:-main}"

# ── Bootstrap: piped from curl, or run outside a checkout ─────────────────────
# Fetch the code, then hand over to the checkout's own copy of this script with
# the terminal re-attached (stdin is the script itself under `curl | bash`).
bootstrap() {
  local dir answer
  if [ "$(id -u)" -ne 0 ]; then
    echo "Please run the installer with sudo:" >&2
    echo "  curl -fsSL https://raw.githubusercontent.com/zappymussel380/print.rish.pw/main/install.sh | sudo bash" >&2
    exit 1
  fi
  echo "Print shop installer"
  dir="${PS_DIR:-/opt/print-shop}"
  if [ "${PS_UNATTENDED:-0}" != "1" ] && [ -z "${PS_DIR:-}" ]; then
    { exec 3</dev/tty; } 2>/dev/null || { echo "No terminal to ask questions on. Use PS_UNATTENDED=1 (see docs/SELF-HOSTING.md)." >&2; exit 1; }
    read -r -p "Install folder [$dir]: " answer <&3 || true
    exec 3<&-
    dir="${answer:-$dir}"
  fi
  if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      echo "Installing git and curl…"
      DEBIAN_FRONTEND=noninteractive apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates openssl >/dev/null
    else
      echo "Please install git and curl, then run this again." >&2
      exit 1
    fi
  fi
  if [ -d "$dir/.git" ]; then
    echo "Using the existing install in $dir"
    # A first install that never finished picks up fixes published since. A
    # finished one only ever changes through update.sh (backup + rollback).
    if ! grep -q '^SELFHOST_STATE=installed' "$dir/.env" 2>/dev/null \
      && git -C "$dir" diff --quiet 2>/dev/null && git -C "$dir" fetch --quiet origin 2>/dev/null; then
      # .env and .selfhost/ are git-ignored, so the answers so far survive this.
      git -C "$dir" reset --quiet --hard "origin/$(git -C "$dir" rev-parse --abbrev-ref HEAD)" 2>/dev/null || true
    fi
  elif [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    echo "$dir already exists and is not empty. Choose another folder with PS_DIR=/some/path." >&2
    exit 1
  else
    echo "Downloading into $dir…"
    git clone --quiet --branch "$PS_BRANCH" "$PS_REPO" "$dir"
  fi
  if [ "${PS_UNATTENDED:-0}" = "1" ]; then
    exec bash "$dir/install.sh" "$@"
  fi
  exec bash "$dir/install.sh" "$@" </dev/tty
}

SELF="${BASH_SOURCE[0]:-}"
if [ -z "$SELF" ] || [ ! -f "$SELF" ] || [ ! -f "$(dirname "$SELF")/scripts/selfhost/lib.sh" ]; then
  bootstrap "$@"
fi

ROOT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"
# shellcheck source=scripts/selfhost/lib.sh
. "$ROOT_DIR/scripts/selfhost/lib.sh"
trap 'echo; die "Stopped."' INT

# ── Materials offered out of the box (ids, names and default rates) ───────────
MATERIALS=(PLA PLA_AESTHETIC PLA_CF PETG PETG_PREMIUM ABS ASA TPU)
declare -A MAT_NAME=(
  [PLA]="PLA" [PLA_AESTHETIC]="Aesthetic PLA (silk, matte, metallic…)" [PLA_CF]="PLA-CF (carbon fibre)"
  [PETG]="PETG" [PETG_PREMIUM]="PETG Premium (translucent, carbon fibre)" [ABS]="ABS" [ASA]="ASA"
  [TPU]="TPU (flexible)"
)
declare -A MAT_RATE=([PLA]=2 [PLA_AESTHETIC]=3 [PLA_CF]=3.5 [PETG]=2.5 [PETG_PREMIUM]=3.5 [ABS]=2.5 [ASA]=3 [TPU]=5)

# ── Preflight ─────────────────────────────────────────────────────────────────
preflight() {
  head_line "Checking this server"
  [ "$(id -u)" -eq 0 ] || die "Please run with sudo: sudo $ROOT_DIR/install.sh"
  [ "$(uname -s)" = "Linux" ] || die "This installer supports Linux servers only."
  [ "$(uname -m)" = "x86_64" ] || die "This server is $(uname -m). The slicer (OrcaSlicer) only ships for x86_64 (Intel/AMD) servers."
  ok "Linux, x86_64"

  local t
  for t in git curl openssl; do
    command -v "$t" >/dev/null 2>&1 || die "'$t' is missing — install it and run this again."
  done

  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker is not installed."
    say "  The official script (https://get.docker.com) can install it for you."
    if confirm "Install Docker now?" Y DOCKER; then
      curl -fsSL https://get.docker.com | sh || die "Docker installation failed."
      ok "Docker installed"
    else
      die "Install Docker Engine with the Compose plugin, then run this again: https://docs.docker.com/engine/install/"
    fi
  fi
  docker info >/dev/null 2>&1 || die "Docker is installed but not running (try: systemctl start docker)."
  docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is missing: https://docs.docker.com/compose/install/"
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) with Compose"

  local mem_gb disk_gb cpus
  mem_gb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
  disk_gb=$(( $(df -Pk "$ROOT_DIR" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
  cpus=$(nproc)
  if [ "$mem_gb" -ge 7 ]; then ok "${mem_gb} GB memory"
  else warn "${mem_gb} GB memory — 8 GB is recommended; big models may fail to slice."; fi
  if [ "$disk_gb" -ge 25 ]; then ok "${disk_gb} GB free disk"
  else warn "${disk_gb} GB free disk — 25 GB is recommended (the image alone is ~3 GB)."; fi
  if [ "$cpus" -ge 2 ]; then ok "${cpus} CPU cores"
  else warn "1 CPU core — slicing will be slow."; fi
  assert_project_is_ours
}

# ── Wizard sections ───────────────────────────────────────────────────────────
sec_shop() {
  head_line "Your shop"
  hint "This is how customers see you: in the header, page titles, PDFs and WhatsApp messages."
  ask BRAND "Shop name (e.g. Acme Prints)" "" valid_brand "Use 1–40 plain characters (no quotes or backslashes)."
  ask QUOTE_PREFIX "Initials for quotation numbers (e.g. $(initials_for "${ANS[BRAND]}")-2026-0001)" "$(initials_for "${ANS[BRAND]}")" valid_quote_prefix "Use 2 to 5 capital letters, like AP."
  ANS[QUOTE_PREFIX]=${ANS[QUOTE_PREFIX]^^}
  ask TAGLINE "One-line tagline" "instant 3D printing quotes" valid_tagline "Up to 80 plain characters, please."
  ask CITY "City you print from (shown as '3D printing · City')" "" valid_city "Up to 60 plain characters, please."
}

# ── Printer ───────────────────────────────────────────────────────────────────
PRINTERS_FILE="$ROOT_DIR/docker/selfhost/printers.tsv"
vendor_label() { case "$1" in BBL) echo "Bambu Lab" ;; *) echo "$1" ;; esac; }
MENU_MAX=0
valid_menu_index() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le "$MENU_MAX" ]; }

# Every single-nozzle, 0.4 mm printer OrcaSlicer ships (docker/selfhost/printers.tsv:
# vendor, model, Orca machine preset, build volume). Quotes are sliced with the
# chosen printer's own profiles, generated after the build.
valid_printer_setup() { [[ "$1" =~ ^(1|2|list|advanced)$ ]]; }
valid_printer_name() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9\ ._+/()-]{0,59}$ ]]; }

sec_printer() {
  head_line "Your printer"
  hint "Every quote is sliced with your printer's own OrcaSlicer profiles, so weight, time and fit match it."
  [ -f "$PRINTERS_FILE" ] || die "Missing $PRINTERS_FILE — the download looks incomplete."
  say "   1) Pick it from OrcaSlicer's list  (recommended — 300+ printers)"
  say "   2) Skip — I'll upload my own tuned OrcaSlicer presets in the admin dashboard after setup"
  ask PRINTER_SETUP "Choose 1–2" "$([ "${CFG[PRINTER_ADVANCED]:-0}" = 1 ] && echo 2 || echo 1)" valid_printer_setup "Please answer 1 or 2."
  local machine
  ANS[PRINTER_ADVANCED]=0
  ANS[PRINTER_NAME]=""
  case "${ANS[PRINTER_SETUP]}" in
    2|advanced)
      ANS[PRINTER_ADVANCED]=1
      hint "Until you upload, quotes use a generic preset. After setup: admin → Slicer profiles → upload a"
      hint "printer bundle (OrcaSlicer: File → Export → Export Preset Bundle → Printer bundle)."
      hint "Every upload is test-sliced before quotes use it."
      # No base question: the owner's uploads replace it. Unattended installs
      # can still start from a listed printer (PS_PRINTER) or PS_PRINTER_BASE.
      case "${PS_PRINTER_BASE:-}" in
        2) machine="MyMarlin 0.4 nozzle" ;;
        3) machine="MyRRF 0.4 nozzle" ;;
        4) machine="MyRepetier 0.4 nozzle" ;;
        5) [ -n "${PS_PRINTER:-}" ] || die "PS_PRINTER_BASE=5 needs PS_PRINTER, the listed printer to start from." ;;
        ""|1) machine="MyKlipper 0.4 nozzle" ;;
        *) die "PS_PRINTER_BASE: pick a number from 1 to 5 (got '$PS_PRINTER_BASE')." ;;
      esac
      if [ -n "${PS_PRINTER:-}" ]; then pick_listed_printer; machine=$PICKED_MACHINE; fi
      # The name lands in customer copy ("a real ___ profile"), so the default
      # has to read well there.
      ask PRINTER_NAME "Printer name customers see (e.g. Voron 2.4 300)" "${CFG[PRINTER_DISPLAY_NAME]:-3D printer}" valid_printer_name \
        "Use 1–60 letters, numbers, spaces and . _ + / ( ) -" ;;
    *) pick_listed_printer; machine=$PICKED_MACHINE ;;
  esac
  ANS[PRINTER_MACHINE]=$machine
  ANS[PRINTER_MULTI]=0
  if confirm "Does it have an AMS, MMU or tool changer for automatic multicolour?" N MULTI_MATERIAL; then
    ANS[PRINTER_MULTI]=1
  fi
  if [ "${ANS[PRINTER_ADVANCED]}" = 1 ]; then
    ok "Printer: ${ANS[PRINTER_NAME]} (your own OrcaSlicer presets — upload them in admin → Slicer profiles)"
  else
    ok "Printer: $(awk -F'\t' -v m="$machine" '$3==m {print $2; exit}' "$PRINTERS_FILE")"
  fi
}

# Brand, then model, from OrcaSlicer's list, into PICKED_MACHINE (the machine
# preset name). Not a $(…) helper: the menus print to stdout, and a die in a
# subshell would not end the installer.
PICKED_MACHINE=""
pick_listed_printer() {
  local machine="" i=1 vendor row def
  if [ -n "${PS_PRINTER:-}" ]; then
    machine=$(awk -F'\t' -v p="$PS_PRINTER" '$3==p || $2==p {print $3; exit}' "$PRINTERS_FILE")
    [ -n "$machine" ] || die "PS_PRINTER: no printer called '$PS_PRINTER' (see $PRINTERS_FILE)."
  else
    local -a vendors models
    mapfile -t vendors < <(cut -f1 "$PRINTERS_FILE" | awk '!seen[$0]++')
    def=1
    for vendor in "${vendors[@]}"; do
      [ "$vendor" = BBL ] && def=$i
      printf '  %3d) %-24s' "$i" "$(vendor_label "$vendor")"
      [ $((i % 3)) -eq 0 ] && echo
      i=$((i + 1))
    done
    echo
    MENU_MAX=${#vendors[@]}
    ask PRINTER_VENDOR "Printer brand (number)" "$def" valid_menu_index "Pick a number from the list."
    vendor=${vendors[$((ANS[PRINTER_VENDOR] - 1))]}
    mapfile -t models < <(awk -F'\t' -v v="$vendor" '$1==v' "$PRINTERS_FILE")
    i=1; def=1
    for row in "${models[@]}"; do
      IFS=$'\t' read -r _ _ mach bed <<<"$row"
      [ "$mach" = "$A1_MACHINE" ] && def=$i
      # The preset name, not the model: a few models come in variants that share one.
      printf '  %3d) %-44s %s mm\n' "$i" "${mach% 0.4 nozzle}" "${bed//x/ × }"
      i=$((i + 1))
    done
    MENU_MAX=${#models[@]}
    ask PRINTER_MODEL "Which $(vendor_label "$vendor") printer (number)" "$def" valid_menu_index "Pick a number from the list."
    machine=$(cut -f3 <<<"${models[$((ANS[PRINTER_MODEL] - 1))]}")
  fi
  PICKED_MACHINE=$machine
}

# Where the finished site lives: https://<domain>, or http://localhost:<port>
# in local test mode.
site_url() {
  local mode=${ANS[MODE]:-${CFG[SELFHOST_MODE]:-}}
  if [ "$mode" = local ]; then
    local host=${ANS[PROXY_BIND]:-${CFG[PROXY_BIND]:-127.0.0.1}}
    [ "$host" = 127.0.0.1 ] && host=localhost
    echo "http://$host:${ANS[PROXY_PORT]:-${CFG[PROXY_PORT]:-8080}}"
  else
    echo "https://${ANS[DOMAIN]:-${CFG[SELFHOST_DOMAIN]:-}}"
  fi
}

# The shop serves plain HTTP on one port; HTTPS is always something in front
# of it. Three ways to set that up.
sec_address() {
  head_line "Web address"
  say "  How will people reach the site?"
  say "   1) Try it on this computer or your home network first  ${C_DIM}(plain http — nothing on the internet can reach it; go live later)${C_OFF}"
  say "   2) Through my own reverse proxy that handles HTTPS  ${C_DIM}(nginx, Nginx Proxy Manager, Traefik, Caddy…)${C_OFF}"
  say "   3) Through a Cloudflare Tunnel  ${C_DIM}(cloudflared; no open ports needed)${C_OFF}"
  local current=1
  case "${CFG[SELFHOST_MODE]:-}" in proxy) current=2 ;; tunnel|owntunnel) current=3 ;; esac
  ask MODE_CHOICE "Choose 1–3" "$current" valid_mode_choice "Please answer 1, 2 or 3."
  ANS[TRUSTED_PROXY]=""
  ANS[DIRECT_ACCESS]=0
  ANS[REAL_IP_HEADER]=X-Real-IP
  case "${ANS[MODE_CHOICE]}" in
    1|local)
      ANS[MODE]=local
      ANS[DOMAIN]=localhost
      sec_local_access
      ask PROXY_PORT "Port to open it on" "${CFG[PROXY_PORT]:-8080}" valid_local_port "Pick a free port between 1024 and 65535."
      check_local_port_free "${ANS[PROXY_PORT]}" ;;
    2|proxy|3|tunnel|owntunnel)
      if [[ "${ANS[MODE_CHOICE]}" =~ ^(2|proxy)$ ]]; then ANS[MODE]=proxy; else ANS[MODE]=tunnel; fi
      hint "You need a domain (e.g. print.example.com) — a public site only runs over HTTPS."
      # Coming from local test mode the stored "domain" is localhost — no default then.
      local domain_default=${CFG[SELFHOST_DOMAIN]:-}
      [ "${CFG[SELFHOST_MODE]:-}" = local ] && domain_default=""
      ask DOMAIN "Domain name" "$domain_default" valid_domain "Enter just the domain, like print.example.com (no https://)."
      sec_forwarder_access
      ask PROXY_PORT "Port for it to connect to" "${CFG[PROXY_PORT]:-8080}" valid_local_port "Pick a free port between 1024 and 65535."
      check_local_port_free "${ANS[PROXY_PORT]}"
      say ""
      if [ "${ANS[MODE]}" = proxy ]; then
        say "  Point your reverse proxy at ${C_BOLD}http://${ANS[PROXY_BIND]}:${ANS[PROXY_PORT]}${C_OFF}. It must terminate HTTPS for"
        say "  ${ANS[DOMAIN]}, OVERWRITE X-Real-IP with the visitor's address, and allow request"
        say "  bodies up to 301 MB on /api/uploads. Full nginx example: docs/DEPLOYMENT.md"
      else
        ANS[REAL_IP_HEADER]=CF-Connecting-IP
        say "  In the Cloudflare dashboard (Zero Trust → Networks → Tunnels), add a public hostname to your tunnel:"
        say "  ${C_BOLD}${ANS[DOMAIN]}${C_OFF} → Service type ${C_BOLD}HTTP${C_OFF}, URL ${C_BOLD}${ANS[PROXY_BIND]}:${ANS[PROXY_PORT]}${C_OFF}"
        hint "No tunnel yet? Create one there and install cloudflared as it shows (on this server is simplest)."
        warn "Cloudflare limits uploads to 100 MB per file, so model uploads are capped at 95 MB in this mode."
      fi ;;
  esac
}
valid_mode_choice() { [[ "$1" =~ ^(1|2|3|local|proxy|tunnel)$ ]]; }

# Where the reverse proxy / cloudflared runs, which decides the address the
# shop listens on and the one forwarder it trusts to name the visitor.
sec_forwarder_access() {
  local what="your reverse proxy" access_default=1
  [ "${ANS[MODE]}" = tunnel ] && what="cloudflared"
  if [ -n "${CFG[PROXY_BIND]:-}" ] && [ "${CFG[PROXY_BIND]}" != 127.0.0.1 ] && [ "${CFG[SELFHOST_MODE]:-}" != local ]; then access_default=2; fi
  say ""
  say "  Where does $what run?"
  say "   1) On this server, installed directly (not in Docker)"
  say "   2) In Docker, or on another computer"
  ask FORWARDER_ACCESS "Choose 1–2" "$access_default" valid_forwarder_access "Please answer 1 or 2."
  case "${ANS[FORWARDER_ACCESS]}" in
    2|other)
      ask PROXY_BIND "Address on THIS server for it to connect to (never 0.0.0.0)" "${CFG[PROXY_BIND]:-$(lan_address)}" valid_bind_address \
        "Enter one IPv4 address of this server (not 0.0.0.0)."
      local stored=""
      [ "${CFG[TRUSTED_PROXY_CIDR]:-}" != "${CFG[PRINT_GATEWAY]:-x}" ] && stored=${CFG[TRUSTED_PROXY_CIDR]:-}
      hint "The shop only believes the visitor address from this one machine; everything else is refused."
      ask PROXY_IP "IP address $what connects FROM (exactly one host)" "$stored" valid_ipv4 "Enter one IPv4 address, like 192.168.1.20."
      ANS[TRUSTED_PROXY]=${ANS[PROXY_IP]}
      # Devices on the same network can reach that address too; refused unless asked for.
      local direct_default=N
      [ "${CFG[DIRECT_ACCESS]:-0}" = 1 ] && direct_default=Y
      say "  Other devices on your network can reach ${ANS[PROXY_BIND]} too. Let them open the shop there"
      say "  directly (plain http), as well as through $what?"
      if confirm "  Allow direct access from your network?" "$direct_default" DIRECT_ACCESS; then
        ANS[DIRECT_ACCESS]=1
        hint "Plain http on your network: the admin password travels unencrypted there. Use a network you trust."
      else
        ANS[DIRECT_ACCESS]=0
      fi ;;
    *)
      ANS[PROXY_BIND]=127.0.0.1
      # Docker relays a loopback connection from its network gateway, which
      # configure_env pins and trusts.
      ANS[TRUSTED_PROXY]=gateway
      ANS[DIRECT_ACCESS]=0 ;;
  esac
}
valid_forwarder_access() { [[ "$1" =~ ^(1|2|host|other)$ ]]; }
valid_bind_address() { valid_ipv4 "$1" && [ "$1" != "0.0.0.0" ]; }

# Local test mode: this computer only, or the devices on its home network too.
# The shop then listens on that one private address — never on every address, or
# a server with a public interface would publish a plain-http site to the internet.
sec_local_access() {
  local lan stored="" access_default=1
  lan=$(lan_address)
  if [ "${CFG[SELFHOST_MODE]:-}" = local ] && [ -n "${CFG[PROXY_BIND]:-}" ] && [ "${CFG[PROXY_BIND]}" != 127.0.0.1 ]; then
    stored=${CFG[PROXY_BIND]}
  fi
  if [ -z "$lan" ] && [ -z "$stored" ]; then
    case "${PS_LOCAL_ACCESS:-}" in 2|network) die "PS_LOCAL_ACCESS=network: this computer has no home-network address (10.x, 172.16–31.x or 192.168.x)." ;; esac
    ANS[PROXY_BIND]=127.0.0.1
    hint "Only this computer can open it: it has no home-network address (10.x, 172.16–31.x or 192.168.x)."
    return 0
  fi
  # Windows reaches WSL through localhost; its own network address is internal.
  # Unattended installs only open it to the network when asked to
  # (PS_LOCAL_ACCESS=network), so an existing script never starts exposing it.
  if [ -n "$stored" ] || { [ -n "$lan" ] && ! is_wsl && ! unattended; }; then access_default=2; fi
  if [ "${CFG[SELFHOST_MODE]:-}" = local ] && [ "${CFG[PROXY_BIND]:-}" = 127.0.0.1 ]; then access_default=1; fi
  say ""
  say "  Who should be able to open it?"
  say "   1) Only this computer            ${C_DIM}http://localhost${C_OFF}"
  say "   2) Devices on my home network    ${C_DIM}http://${stored:-$lan}${C_OFF}  (e.g. a laptop, when this is a server without a screen)"
  ask LOCAL_ACCESS "Choose 1–2" "$access_default" valid_local_access "Please answer 1 or 2."
  case "${ANS[LOCAL_ACCESS]}" in
    2|network)
      ask LOCAL_ADDRESS "This computer's address on your network" "${stored:-$lan}" valid_lan_address \
        "Enter one of this computer's own private addresses: $(private_ipv4s | paste -sd' ' -)."
      ANS[PROXY_BIND]=${ANS[LOCAL_ADDRESS]}
      warn "Anyone on your network can open it, and it's plain http: use a network you trust."
      hint "The admin password travels unencrypted on it. Nothing on the internet can reach it." ;;
    *)
      ANS[PROXY_BIND]=127.0.0.1
      hint "Only this computer can open it. On Windows (WSL2), open the address in your Windows browser." ;;
  esac
}
valid_local_access() { [[ "$1" =~ ^(1|2|computer|network)$ ]]; }
is_wsl() { grep -qi microsoft /proc/version 2>/dev/null; }
# Private IPv4 (10/8, 172.16/12, 192.168/16): the addresses the app accepts for
# a plain-http APP_ORIGIN (isPrivateNetworkHost in apps/web/lib/env.ts).
is_private_ipv4() {
  local a b
  valid_ipv4 "$1" || return 1
  IFS=. read -r a b _ <<<"$1"
  [ "$a" -eq 10 ] || { [ "$a" -eq 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ]; } || { [ "$a" -eq 192 ] && [ "$b" -eq 168 ]; }
}
# This computer's private addresses, leaving out Docker's and other virtual
# bridges (172.17.0.1 and friends): nothing on the home network can reach those.
private_ipv4s() {
  local a
  for a in $(ip -4 -o addr show 2>/dev/null \
      | awk '$2 !~ /^(docker|br-|veth|virbr|cni|flannel|cali|vxlan|lxcbr)/ {print $4}' | cut -d/ -f1 || true); do
    if is_private_ipv4 "$a"; then echo "$a"; fi
  done
}
# One of this computer's own private addresses.
# (The list is captured first: `private_ipv4s | grep -q` would let grep's early
# exit SIGPIPE the loop, and pipefail would then fail a valid address.)
valid_lan_address() {
  local own
  is_private_ipv4 "$1" || return 1
  own=$(private_ipv4s)
  grep -qxF -- "$1" <<<"$own"
}
# The address other devices most likely use: the source of the default route,
# else this computer's first private address. Empty when it has none.
lan_address() {
  local src own
  src=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") {print $(i + 1); exit}}' || true)
  if [ -n "$src" ] && valid_lan_address "$src"; then echo "$src"; return 0; fi
  own=$(private_ipv4s)
  echo "${own%%$'\n'*}"
}
valid_local_port() { [[ "$1" =~ ^[0-9]{4,5}$ ]] && [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]; }
check_local_port_free() {
  # The shop's own container holding the port (a re-run) is fine.
  if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "(^|:)$1\$" \
    && ! docker ps --filter label=com.docker.compose.project=print --format '{{.Ports}}' | grep -q ":$1->"; then
    die "Port $1 is already in use on this computer. Run again and pick another port."
  fi
  ok "Port $1 is free"
}
# Lengths match the site profile's own limits (packages/shared/src/site-profile.ts),
# or the app would quietly replace an over-long value with its default.
valid_brand()   { valid_text "$1" && [ ${#1} -le 40 ]; }
valid_quote_prefix() { [[ "${1^^}" =~ ^[A-Z]{2,5}$ ]]; }
# "Acme Prints" → AP, "Printery" → PRI (matches initialsFor in packages/shared).
initials_for() {
  local w out=""
  for w in $(printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9\n' ' '); do
    w=${w//[^A-Z]/}; [ -n "$w" ] && out+=${w:0:1}
  done
  if [ ${#out} -lt 2 ]; then out=$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr -cd 'A-Z' | cut -c1-3); fi
  out=${out:0:5}
  [[ "$out" =~ ^[A-Z]{2,5}$ ]] && echo "$out" || echo RSP
}
valid_tagline() { valid_text_or_empty "$1" && [ ${#1} -le 80 ]; }
valid_city()    { valid_text_or_empty "$1" && [ ${#1} -le 60 ]; }
sec_admin() {
  head_line "Admin password"
  hint "You'll use this at $(site_url)/admin to manage quotes, rates and colours."
  local again
  while true; do
    ask_secret ADMIN_PASSWORD "Choose an admin password (12+ characters, hidden)" valid_password "Use 12 to 72 characters."
    [ -n "${PS_ADMIN_PASSWORD:-}" ] && break
    read -r -s -p "Type it again: " again </dev/tty; echo
    [ "$again" = "${ANS[ADMIN_PASSWORD]}" ] && break
    warn "Those didn't match — try again."
  done
}

sec_materials() {
  head_line "Materials and rates"
  hint "Customers pay: grams of filament (from the real slicer) × the material's rate, plus one setup fee per order."
  local i=1 m
  for m in "${MATERIALS[@]}"; do say "   $i) ${MAT_NAME[$m]}"; i=$((i + 1)); done
  ask MATERIALS "Which do you print? Numbers, comma-separated" "1,4" valid_material_list "Use numbers from the list, e.g. 1,4,6"
  OFFERED=()
  local n
  for n in ${ANS[MATERIALS]//,/ }; do OFFERED+=("${MATERIALS[$((n - 1))]}"); done
  mapfile -t OFFERED < <(printf '%s\n' "${OFFERED[@]}" | awk '!seen[$0]++')

  ask SETUP_FEE "One-time setup fee per order, in ₹" "150" valid_rupees "Enter an amount like 150 or 99.50."
  for m in "${OFFERED[@]}"; do
    ask "RATE_$m" "Price per gram for ${MAT_NAME[$m]}, in ₹" "${MAT_RATE[$m]}" valid_rate "Enter a price like 2 or 2.50 (₹0.01 to ₹1000)."
  done
  if [[ " ${OFFERED[*]} " == *" ABS "* || " ${OFFERED[*]} " == *" ASA "* ]]; then
    warn "ABS/ASA print best in an enclosure; on an open-frame printer large flat parts can warp."
    hint "They start with black and white; add more colours by hex code in admin → Catalog."
  fi
  hint "Colours, internal costs and lead time are managed in the admin dashboard later."
  hint "Printing something else (ABS-CF, PC, PA…)? Add up to 4 of your own materials, each with its own"
  hint "OrcaSlicer profile, in admin → Your own materials after setup."

  say ""
  say "  The Materials page compares materials side by side for customers."
  local default_page="" idx
  for m in "${OFFERED[@]}"; do
    for idx in "${!MATERIALS[@]}"; do [ "${MATERIALS[$idx]}" = "$m" ] && default_page+="${default_page:+,}$((idx + 1))"; done
  done
  ask MATERIALS_PAGE "Which should it explain? Numbers, comma-separated" "$default_page" valid_material_list "Use numbers from the list above."
}
valid_material_list() {
  local n
  [[ "$1" =~ ^[0-9]+(,[[:space:]]*[0-9]+)*$ ]] || return 1
  for n in ${1//,/ }; do [ "$n" -ge 1 ] && [ "$n" -le ${#MATERIALS[@]} ] || return 1; done
}
material_ids() {  # "1,4" → "PLA PETG" (deduplicated, in the order given)
  local n out=()
  for n in ${1//,/ }; do out+=("${MATERIALS[$((n - 1))]}"); done
  printf '%s\n' "${out[@]}" | awk '!seen[$0]++'
}

sec_contact() {
  head_line "Contact details"
  hint "Shown on the Contact page. WhatsApp matters most: every quote hands off to it."
  ask WHATSAPP "WhatsApp number with country code (e.g. 91 98765 43210)" "" valid_whatsapp_or_empty "Enter 8–15 digits including the country code."
  [ -n "${ANS[WHATSAPP]}" ] || warn "Without a WhatsApp number, customers can't send you their quote after submitting."
  ask EMAIL "Contact email (optional)" "" valid_email_or_empty "That doesn't look like an email address."
  ask PHONE "Phone number (optional)" "" valid_phone_or_empty "Digits, spaces, + and dashes only (up to 24)."
  ask ADDRESS "Address or area (optional)" "" valid_address_or_empty "Up to 300 characters, no double quotes."
  ask MAPS_URL "Google Maps embed link for the Contact page (optional)" "${CFG[GOOGLE_MAPS_EMBED_URL]:-}" valid_maps_or_empty "Paste the https://www.google.com/maps/embed?... link from Share → Embed a map."
}

sec_integrations() {
  head_line "Optional extras (you can skip all of these)"
  hint "Contact-form email (Resend or any SMTP server) can also be set up later, in the admin dashboard (Settings)."
  if confirm "Email contact-form messages to you (needs a free resend.com account)?" N RESEND; then
    ask_secret RESEND_KEY "Resend API key (input hidden)"
    ask MAIL_TO "Send contact-form messages to" "${ANS[EMAIL]:-${CFG[MAIL_TO]:-}}" valid_email "Enter an email address."
    ask CONTACT_FROM_EMAIL "Send them from (an address on a domain verified in Resend)" "contact@${ANS[DOMAIN]}" valid_email "Enter an email address."
  fi
  hint "Live courier prices can also be set up later, in the admin dashboard (Shipping)."
  if confirm "Show live courier shipping prices (needs a Shiprocket API user)?" N SHIPROCKET; then
    ask SHIPROCKET_EMAIL "Shiprocket API user email" "" valid_email "Enter an email address."
    ask_secret SHIPROCKET_PASSWORD "Shiprocket API user password (input hidden)"
    ask PINCODE "Pickup pincode" "" valid_pincode_or_empty "Enter a 6-digit pincode."
  fi
  if confirm "Get a Telegram message for every new quotation?" N TELEGRAM; then
    ask_secret TELEGRAM_TOKEN "Telegram bot token from @BotFather (input hidden)"
    ask TELEGRAM_CHAT "Telegram chat id" "" valid_text "Enter the chat id."
  fi
}

summary() {
  head_line "Summary"
  local m rates=""
  for m in "${OFFERED[@]}"; do rates+="${rates:+, }$m ₹$(from_paise "$(to_paise "${ANS[RATE_$m]}")")/g"; done
  say "  Shop:        ${ANS[BRAND]}${ANS[CITY]:+ · ${ANS[CITY]}}  (quotes numbered ${ANS[QUOTE_PREFIX]:-RSP}-$(date +%Y)-0001)"
  say "  Address:     $(site_url)  (${ANS[MODE]})"
  if [ "${ANS[PRINTER_ADVANCED]:-0}" = 1 ]; then
    say "  Printer:     ${ANS[PRINTER_NAME]} — your own OrcaSlicer presets, uploaded in admin → Slicer profiles$([ "${ANS[PRINTER_MULTI]:-0}" = 1 ] && echo " (automatic multicolour)")"
  else
    say "  Printer:     ${ANS[PRINTER_MACHINE]% 0.4 nozzle}$([ "${ANS[PRINTER_MULTI]:-0}" = 1 ] && echo " (automatic multicolour)")"
  fi
  say "  Materials:   $rates"
  say "  Setup fee:   ₹$(from_paise "$(to_paise "${ANS[SETUP_FEE]}")") per order"
  say "  Materials page: $(material_ids "${ANS[MATERIALS_PAGE]}" | paste -sd, - | sed 's/,/, /g')"
  say "  WhatsApp:    ${ANS[WHATSAPP]:-(none)}"
  say "  Install dir: $ROOT_DIR"
  confirm "Download and start the site now? (about 3 GB the first time)" Y START || die "Nothing was changed."
}

# ── Resume support ────────────────────────────────────────────────────────────
# The wizard's answers (never the admin password) are kept in a private file
# until the install finishes, so a failed build can be resumed without asking
# everything again.
ANSWERS_FILE="$ROOT_DIR/.selfhost/answers"

save_answers() {
  local k tmp
  mkdir -p "$ROOT_DIR/.selfhost"
  tmp=$(mktemp "$ANSWERS_FILE.XXXXXX")
  for k in "${!ANS[@]}"; do
    [ "$k" = ADMIN_PASSWORD ] && continue
    printf '%s=%s\n' "$k" "$(env_value "${ANS[$k]}")"
  done > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ANSWERS_FILE"
}

load_answers() {
  local -A saved_cfg=()
  local k
  for k in "${!CFG[@]}"; do saved_cfg[$k]=${CFG[$k]}; done
  CFG=()
  load_env "$ANSWERS_FILE"
  for k in "${!CFG[@]}"; do ANS[$k]=${CFG[$k]}; done
  CFG=()
  for k in "${!saved_cfg[@]}"; do CFG[$k]=${saved_cfg[$k]}; done
}

# ── Apply ─────────────────────────────────────────────────────────────────────
configure_env() {
  local mode=${ANS[MODE]}
  CFG[SELFHOST]=1
  CFG[SELFHOST_MODE]=$mode
  CFG[SELFHOST_DOMAIN]=${ANS[DOMAIN]}
  CFG[SELFHOST_VERSION]=$(git -C "$ROOT_DIR" rev-parse --short=7 HEAD)
  # update.sh follows the branch this checkout was installed from.
  local branch; branch=$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)
  [ "$branch" = HEAD ] || CFG[SELFHOST_BRANCH]=$branch
  [ -n "${PS_IMAGE_REPO:-}" ] && CFG[PRINT_IMAGE_REPO]=$PS_IMAGE_REPO
  apply_env_defaults || true
  CFG[APP_ORIGIN]=$(site_url)
  CFG[PROXY_BIND]=${ANS[PROXY_BIND]}
  CFG[PROXY_PORT]=${ANS[PROXY_PORT]}
  CFG[REAL_IP_HEADER]=${ANS[REAL_IP_HEADER]:-X-Real-IP}
  CFG[DIRECT_ACCESS]=${ANS[DIRECT_ACCESS]:-0}
  case "${ANS[TRUSTED_PROXY]:-}" in
    "") CFG[TRUSTED_PROXY_CIDR]="" ;;
    gateway) CFG[TRUSTED_PROXY_CIDR]=${CFG[PRINT_GATEWAY]} ;;
    *) CFG[TRUSTED_PROXY_CIDR]=${ANS[TRUSTED_PROXY]} ;;
  esac
  if [ "$mode" = tunnel ]; then
    CFG[MAX_UPLOAD_MB]=95
  elif [ "${CFG[MAX_UPLOAD_MB]:-300}" = 95 ]; then
    CFG[MAX_UPLOAD_MB]=300
  fi
  if [ -n "${ANS[PRINTER_MACHINE]:-}" ]; then
    CFG[PRINTER_MACHINE]=${ANS[PRINTER_MACHINE]}
    CFG[PRINTER_MULTI_MATERIAL]=${ANS[PRINTER_MULTI]:-0}
    CFG[PRINTER_ADVANCED]=${ANS[PRINTER_ADVANCED]:-0}
    CFG[PRINTER_DISPLAY_NAME]=${ANS[PRINTER_NAME]:-}
  fi
  # Menu 2 asks no printer questions: the test above then fails, and that
  # status must not become the function's, or set -e ends the installer.
  return 0
}

configure_integrations() {
  CFG[GOOGLE_MAPS_EMBED_URL]=${ANS[MAPS_URL]:-${CFG[GOOGLE_MAPS_EMBED_URL]:-}}
  if [ -n "${ANS[RESEND_KEY]:-}" ]; then
    CFG[RESEND_API_KEY]=${ANS[RESEND_KEY]}
    CFG[MAIL_TO]=${ANS[MAIL_TO]}
    local sender="${ANS[BRAND]:-${CFG[CONTACT_FROM]% <*}}"
    [ -n "$sender" ] && [ "$sender" != "${CFG[CONTACT_FROM]:-}" ] || sender="Print shop"
    CFG[CONTACT_FROM]="$sender <${ANS[CONTACT_FROM_EMAIL]}>"
  fi
  if [ -n "${ANS[SHIPROCKET_EMAIL]:-}" ]; then
    CFG[SHIPROCKET_EMAIL]=${ANS[SHIPROCKET_EMAIL]}
    CFG[SHIPROCKET_PASSWORD]=${ANS[SHIPROCKET_PASSWORD]}
    CFG[SHIPROCKET_PICKUP_PINCODE]=${ANS[PINCODE]:-}
  fi
  if [ -n "${ANS[TELEGRAM_TOKEN]:-}" ]; then
    CFG[TELEGRAM_BOT_TOKEN]=${ANS[TELEGRAM_TOKEN]}
    CFG[TELEGRAM_CHAT_ID]=${ANS[TELEGRAM_CHAT]}
  fi
}

# The image published for this checkout's commit, or `latest` while that one
# is still being built. PS_BUILD=1 builds it here from the checkout instead
# (no registry access needed; takes 10–25 minutes).
fetch_image() {
  head_line "Downloading the shop (about 3 GB the first time)"
  if [ "${PS_BUILD:-0}" = 1 ]; then
    CFG[PRINT_IMAGE]=print-farm:local
    write_env
    dc build --pull || die "The build failed. Scroll up for the first error, or run: cd $ROOT_DIR && docker compose build"
    ok "Image built"
    return 0
  fi
  local image latest
  image=$(image_for_commit)
  latest="${CFG[PRINT_IMAGE_REPO]:-$DEFAULT_IMAGE_REPO}:latest"
  if pull_image "$image"; then
    CFG[PRINT_IMAGE]=$image
  elif pull_image "$latest"; then
    warn "The image for this exact version isn't published yet; using the latest one."
    CFG[PRINT_IMAGE]=$latest
  else
    die "Could not download ${CFG[PRINT_IMAGE_REPO]:-$DEFAULT_IMAGE_REPO}.
  If the image is private, log in first: docker login ghcr.io
  Or build it on this server instead: sudo PS_BUILD=1 $ROOT_DIR/install.sh"
  fi
  write_env
  ok "Downloaded ${CFG[PRINT_IMAGE]}"
}

set_admin_password() {
  local hash
  # Resuming with a hash already in place and no new password: keep it.
  if [ -z "${ANS[ADMIN_PASSWORD]:-}" ] && [ -n "${CFG[ADMIN_PASSWORD_HASH]:-}" ]; then
    return 0
  fi
  say "  Hashing the admin password…"
  hash=$(hash_admin_password "${CFG[PRINT_IMAGE]}" "${ANS[ADMIN_PASSWORD]}") || die "Hashing the admin password failed."
  CFG[ADMIN_PASSWORD_HASH]=$hash
  write_env
  ok "Admin password set"
}

# Everything durable (database, uploads, generated secrets) lives in one Docker
# volume, which outlives the install folder. Picking up one left by an earlier
# install just works — its secrets are inside it — but say so, and offer a
# clean start.
valid_existing_data() { [[ "$1" =~ ^(1|2|3|keep|delete|quit)$ ]]; }
reconcile_data_volume() {
  local vol created typed
  vol=$(docker volume ls -q --filter label=com.docker.compose.project=print \
    --filter label=com.docker.compose.volume=data 2>/dev/null | head -n1 || true)
  [ -n "$vol" ] || return 0
  [ -z "$(dc ps -aq "$SERVICE" 2>/dev/null)" ] || return 0
  created=$(docker volume inspect -f '{{.CreatedAt}}' "$vol" 2>/dev/null || true)
  created=${created:0:16}
  head_line "Data from an earlier install"
  warn "This server still has the data of an earlier install${created:+ (created ${created/T/ })}."
  say "   1) Keep it  ${C_DIM}(its quotes and uploads stay; the shop settings you entered replace its old ones)${C_OFF}"
  say "   2) Delete it and start empty  ${C_DIM}(its database, uploaded models and PDFs)${C_OFF}"
  say "   3) Quit without changing anything"
  ask EXISTING_DATA "Choose 1–3" 1 valid_existing_data "Please answer 1, 2 or 3."
  case "${ANS[EXISTING_DATA]}" in
    1|keep) ok "Keeping the earlier data" ;;
    2|delete)
      typed="${PS_CONFIRM_DELETE_TEXT:-}"
      unattended || read -r -p "Type DELETE to confirm: " typed </dev/tty
      [ "$typed" = "DELETE" ] || die "Nothing was deleted. Run this again to choose."
      docker volume rm "$vol" >/dev/null || die "Could not delete $vol."
      ok "Deleted the earlier install's data" ;;
    *) die "Nothing was changed. Run this again to choose." ;;
  esac
}

start_stack() {
  head_line "Starting"
  dc up -d --remove-orphans || die "Starting failed. See: cd $ROOT_DIR && docker compose logs --tail 80"
  # The first boot creates the database and the printer's profiles.
  wait_healthy 600 || die "The site didn't come up."
}

# The seed payload. Kept out of a command substitution: a heredoc nested in
# $( … ) that itself contains $( … ) is where bash's parser gives up.
settings_json() {
  local json_page=$1 json_rates=$2 json_offered=$3 json_colours=$4 json_customs=$5
  cat <<EOF
{
  "siteProfile": {
    "brandName": $(json_str "${ANS[BRAND]}"),
    "tagline": $(json_str "${ANS[TAGLINE]}"),
    "city": $(json_str "${ANS[CITY]}"),
    "contact": {
      "whatsappNumber": $(json_str "$(digits "${ANS[WHATSAPP]}")"),
      "email": $(json_str "${ANS[EMAIL]}"),
      "phone": $(json_str "${ANS[PHONE]}"),
      "address": $(json_str "${ANS[ADDRESS]}")
    },
    "footerNote": "",
    "quotationPrefix": $(json_str "${ANS[QUOTE_PREFIX]:-RSP}"),
    "materialsPage": [$json_page]
  },
  "pricing": {
    "setupFeePaise": $(to_paise "${ANS[SETUP_FEE]}"),
    "materials": {$json_rates}
  },
  "catalogAvailability": {
    "materials": {$json_offered},
    "colours": {$json_colours},
    "customColours": [$json_customs]
  }
}
EOF
}

# The shop's settings go straight into the database, where the admin dashboard
# edits them from then on.
seed_shop_settings() {
  local m first json_offered="" json_rates="" json_page="" json_colours="" json_customs="" id
  for m in "${MATERIALS[@]}"; do
    if [[ " ${OFFERED[*]} " == *" $m "* ]]; then json_offered+="${json_offered:+,}\"$m\":true"; else json_offered+="${json_offered:+,}\"$m\":false"; fi
  done
  for m in "${OFFERED[@]}"; do
    json_rates+="${json_rates:+,}\"$m\":{\"sellPerGramPaise\":$(to_paise "${ANS[RATE_$m]}")}"
  done
  while read -r m; do json_page+="${json_page:+,}\"$m\""; done < <(material_ids "${ANS[MATERIALS_PAGE]}")
  # ABS/ASA have no supplier palette: start them with black and white.
  for m in ABS ASA; do
    [[ " ${OFFERED[*]} " == *" $m "* ]] || continue
    id=${m,,}
    json_customs+="${json_customs:+,}{\"id\":\"custom-$id-black\",\"name\":\"Black\",\"hex\":\"#1A1A1A\",\"material\":\"$m\"}"
    json_customs+=",{\"id\":\"custom-$id-white\",\"name\":\"White\",\"hex\":\"#F4F4F0\",\"material\":\"$m\"}"
    json_colours+="${json_colours:+,}\"$m\":[\"custom-$id-black\",\"custom-$id-white\"]"
  done
  # TPU starts with the one Numakers colour it's stocked in.
  if [[ " ${OFFERED[*]} " == *" TPU "* ]]; then
    json_colours+="${json_colours:+,}\"TPU\":[\"outrageous-orange\"]"
  fi
  local payload
  payload=$(settings_json "$json_page" "$json_rates" "$json_offered" "$json_colours" "$json_customs")
  printf '%s' "$payload" | dc exec -T "$SERVICE" print-farm seed-settings >/dev/null || die "Saving the shop settings failed."
  ok "Shop settings saved"
}

finish() {
  head_line "Done"
  local url; url=$(site_url)
  say "  Your site:  ${C_BOLD}$url${C_OFF}"
  say "  Admin:      ${C_BOLD}$url/admin${C_OFF}  (the password you chose)"
  case "${CFG[SELFHOST_MODE]}" in
    local)
      local where="in your browser" who="Only this computer can open it."
      if [ "${CFG[PROXY_BIND]:-127.0.0.1}" != 127.0.0.1 ]; then
        where="on any device on your network"; who="Devices on your network can open it (plain http)."
      fi
      if curl -fsS --max-time 15 "$url/api/health" >/dev/null 2>&1; then ok "Open $url $where"
      else warn "The site isn't answering on $url yet — give it a minute, then check: docker compose ps"; fi
      hint "$who Happy with it? Put it online with: sudo $ROOT_DIR/install.sh (option 2)" ;;
    proxy|tunnel)
      local target="http://${CFG[PROXY_BIND]}:${CFG[PROXY_PORT]}"
      if curl -fsS --max-time 15 "$url/api/health" >/dev/null 2>&1; then ok "Reachable at $url"
      elif [ "${CFG[SELFHOST_MODE]}" = tunnel ]; then
        hint "In your tunnel, point the public hostname ${CFG[SELFHOST_DOMAIN]} at $target."
      else
        hint "Point your reverse proxy for ${CFG[SELFHOST_DOMAIN]} at $target (HTTPS, X-Real-IP overwritten; docs/DEPLOYMENT.md)."
      fi
      if [ -n "${CFG[TRUSTED_PROXY_CIDR]:-}" ]; then
        hint "Only ${CFG[TRUSTED_PROXY_CIDR]} may connect to $target; anything else gets 403."
      fi ;;
  esac
  say ""
  say "  Next, in the admin dashboard:"
  if [ "${CFG[PRINTER_ADVANCED]:-0}" = 1 ]; then
    say "   • Slicer profiles — upload your OrcaSlicer presets (quotes use a generic preset until you do)"
  fi
  say "   • Catalog — switch on the colours you actually stock"
  say "   • Rates — your filament costs, so profit estimates are right"
  say "   • Site — name, contact details and the Materials page, any time"
  say ""
  say "  Update to the latest version any time:  ${C_BOLD}sudo $ROOT_DIR/update.sh${C_OFF}"
  say "  Change settings or uninstall:           ${C_BOLD}sudo $ROOT_DIR/install.sh${C_OFF}"
  say "  Back up everything:                     ${C_BOLD}cd $ROOT_DIR && docker compose exec -T print-farm print-farm backup > shop.pgdump${C_OFF}"
}

# ── Existing install ──────────────────────────────────────────────────────────
uninstall() {
  head_line "Uninstall"
  [ "${CFG[SELFHOST]:-}" = "1" ] || die "This .env wasn't written by install.sh — refusing to uninstall anything."
  confirm "Stop and remove the site's containers?" N UNINSTALL || die "Nothing was changed."
  dc down --remove-orphans
  ok "Containers removed (your data is still there)"
  warn "The database, uploaded models and quotation PDFs are kept in a Docker volume."
  local deleted=0
  if confirm "Delete ALL of that data permanently?" N DELETE_DATA; then
    local typed="${PS_CONFIRM_DELETE_TEXT:-}"
    unattended || read -r -p "Type DELETE to confirm: " typed </dev/tty
    if [ "$typed" = "DELETE" ]; then
      dc down -v --remove-orphans
      ok "Data deleted"
      deleted=1
    else
      say "  Kept the data."
    fi
  fi
  if [ "$deleted" = 1 ]; then
    say "  The code is still in $ROOT_DIR — delete that folder to remove everything."
  else
    say "  The code is still in $ROOT_DIR, and its .env holds your settings and admin login:"
    say "  keep it, and bring the site back any time with: sudo $ROOT_DIR/install.sh"
    say "  To remove everything, uninstall again and delete the data, then delete the folder."
  fi
  exit 0
}

existing_menu() {
  head_line "This site is already installed"
  say "  1) Restart with the current settings"
  say "  2) Change the web address / how people reach it"
  say "  3) Change the admin password"
  say "  4) Change optional extras (email, shipping, Telegram, map)"
  say "  5) Change the printer"
  say "  6) Start over with new shop settings  ${C_DIM}(replaces name, rates, materials and contact set in admin)${C_OFF}"
  say "  7) Uninstall"
  say "  8) Quit"
  ask MENU "Choose" "1" valid_menu "Please answer 1–8."
}
valid_menu() { [[ "$1" =~ ^[1-8]$ ]]; }

# Shown before the first question of a fresh install, so nobody agonises over
# an answer that the admin dashboard can change in a minute afterwards.
changeable_later() {
  say ""
  say "  ${C_BOLD}Good to know:${C_OFF} almost everything here can be changed later."
  say "   • In the admin dashboard, any time:"
  say "       shop name, tagline, city, quotation initials, contact details and footer;"
  say "       per-gram rates, setup fee, your costs and lead time; which materials and"
  say "       colours you offer; the Materials page, FAQ and showcase photos; live"
  say "       courier prices (Shiprocket); contact-form email; and your own OrcaSlicer"
  say "       presets if you skip the printer step."
  say "   • By running ${C_BOLD}sudo $ROOT_DIR/install.sh${C_OFF} again:"
  say "       web address and HTTPS, admin password, printer, and Telegram."
  hint "So don't worry about getting everything perfect now."
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  say "${C_BOLD}Print shop installer${C_OFF}  ${C_DIM}($ROOT_DIR)${C_OFF}"
  if [ -f "$ENV_FILE" ]; then
    load_env
    [ "${CFG[SELFHOST]:-}" = "1" ] || die "$ENV_FILE was not written by this installer (it has no SELFHOST=1).
  It looks like a hand-configured deployment — this installer will not touch it."
  fi
  case "${1:-}" in
    --uninstall) preflight; uninstall ;;
    --help|-h) sed -n '2,16p' "$SELF"; exit 0 ;;
    "") ;;
    *) die "Unknown option $1 (try --help)" ;;
  esac
  preflight

  if [ "${CFG[SELFHOST]:-}" = "1" ] && [ "${CFG[SELFHOST_STATE]:-}" != "installed" ]; then
    resume_install
    exit 0
  fi

  if [ "${CFG[SELFHOST]:-}" = "1" ]; then
    existing_menu
    case "${ANS[MENU]}" in
      1) apply_env_defaults || true; write_env; start_stack; finish ;;
      2) sec_address; configure_env; write_env; start_stack; finish ;;
      3) ANS[DOMAIN]=${CFG[SELFHOST_DOMAIN]}; sec_admin; set_admin_password; dc up -d; wait_healthy 240; ok "Password changed" ;;
      4) ANS[DOMAIN]=${CFG[SELFHOST_DOMAIN]}
         ask MAPS_URL "Google Maps embed link (optional)" "${CFG[GOOGLE_MAPS_EMBED_URL]:-}" valid_maps_or_empty "Paste the https://www.google.com/maps/embed?... link."
         sec_integrations; configure_integrations; write_env; dc up -d; wait_healthy 240; ok "Saved" ;;
      5) sec_printer
         local -A old=()
         local k
         for k in PRINTER_MACHINE PRINTER_MULTI_MATERIAL PRINTER_ADVANCED PRINTER_DISPLAY_NAME; do old[$k]=${CFG[$k]:-}; done
         CFG[PRINTER_MACHINE]=${ANS[PRINTER_MACHINE]}; CFG[PRINTER_MULTI_MATERIAL]=${ANS[PRINTER_MULTI]}
         CFG[PRINTER_ADVANCED]=${ANS[PRINTER_ADVANCED]}; CFG[PRINTER_DISPLAY_NAME]=${ANS[PRINTER_NAME]}
         write_env
         # The container generates the new printer's profiles as it starts.
         if ! { dc up -d && wait_healthy 420; }; then
           for k in "${!old[@]}"; do CFG[$k]=${old[$k]}; done
           write_env
           dc up -d >/dev/null 2>&1 || true
           die "That printer's profiles could not be built; kept the previous printer."
         fi
         ok "Now quoting for ${CFG[PRINTER_DISPLAY_NAME]:-${CFG[PRINTER_MACHINE]% 0.4 nozzle}}" ;;
      6) ANS[DOMAIN]=${CFG[SELFHOST_DOMAIN]}; sec_shop; sec_materials; sec_contact
         confirm "Replace the shop settings in the admin dashboard with these?" N RESET || die "Nothing was changed."
         seed_shop_settings ;;
      7) uninstall ;;
      8) exit 0 ;;
    esac
    exit 0
  fi

  say "This sets up the whole site: shop details, web address, rates, then downloads and starts it."
  hint "Press Enter to accept a [default]. Ctrl+C stops at any point without changing anything."
  changeable_later
  sec_shop
  sec_printer
  sec_address
  sec_admin
  sec_materials
  sec_contact
  sec_integrations
  summary

  configure_env
  configure_integrations
  CFG[SELFHOST_STATE]=configured
  write_env
  save_answers
  ok "Settings written to $ENV_FILE"
  install_from_image
}

# Everything after the questions; also where an interrupted install resumes.
install_from_image() {
  reconcile_data_volume
  fetch_image
  set_admin_password
  start_stack
  seed_shop_settings
  CFG[SELFHOST_STATE]=installed
  write_env
  rm -f "$ANSWERS_FILE"
  finish
}

resume_install() {
  head_line "Finishing the previous install"
  say "  An earlier run stopped before the site was fully set up. Picking up where it left off."
  if [ -f "$ANSWERS_FILE" ]; then
    load_answers
  else
    warn "The earlier answers were lost; please answer the shop questions again."
    ANS[DOMAIN]=${CFG[SELFHOST_DOMAIN]}
    sec_shop; sec_materials; sec_contact
    save_answers
  fi
  mapfile -t OFFERED < <(material_ids "${ANS[MATERIALS]}")
  if [ -z "${CFG[ADMIN_PASSWORD_HASH]:-}" ]; then
    ANS[DOMAIN]=${CFG[SELFHOST_DOMAIN]}
    sec_admin
  fi
  apply_env_defaults || true
  write_env
  install_from_image
}

main "$@"
