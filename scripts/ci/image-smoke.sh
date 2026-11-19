#!/usr/bin/env bash
# Boot the print-farm image exactly as docker-compose.yml runs it (read-only
# root, dropped capabilities, tmpfs /run and /tmp, a data folder) and prove the
# whole shop works from the outside, set up the way an owner does it — in the
# browser, with nothing in the environment:
#
#   * a new shop takes no quotes and has no admin password; the first-run setup
#     code from the log creates one, and is refused once it has;
#   * picking a printer from OrcaSlicer's list in the server settings restarts
#     the shop with that printer's profiles;
#   * with no material preset it still takes no quotes, until the owner's
#     OrcaSlicer filament export passes its test slice;
#   * the public pages render and the admin gate redirects;
#   * one real model is sliced by OrcaSlicer through the public API — under the
#     real slicer uid, in the real per-job sandbox, from the shipped bundle;
#   * Orca staged inside its job sandbox, not the shared /tmp path;
#   * a backup restores into the running container, and the shop survives a
#     restart with its data, settings and generated secrets.
#
#   scripts/ci/image-smoke.sh <image>
#
# Uses its own compose project (print-smoke) and data folder, and removes both.
set -euo pipefail

image=${1:?usage: image-smoke.sh <image>}
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
port=${SMOKE_PORT:-18080}
origin="http://localhost:$port"
work=$(mktemp -d)

export COMPOSE_PROJECT_NAME=print-smoke
export PRINT_IMAGE=$image
export PRINT_PORT="127.0.0.1:$port" PRINT_DATA_DIR="$work/data" PRINT_PROFILES_DIR="$work/profiles"
# Whatever the calling environment holds must not leak into the stack: the
# shop is set up from the browser alone.
export APP_ORIGIN="" ADMIN_PASSWORD="" ADMIN_PASSWORD_HASH="" SESSION_SECRET="" TRUSTED_PROXY_CIDR="" PRINTER_MACHINE=""
export PRINT_MEMORY=${PRINT_MEMORY:-8g}

dc() { docker compose -f "$repo/docker-compose.yml" "$@"; }
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "---- container logs (last 200 lines) ----" >&2
    dc logs --no-color --tail 200 >&2 || true
  fi
  dc down --remove-orphans >/dev/null 2>&1 || true
  # The data folder belongs to the container's users: empty it from inside one.
  docker run --rm --entrypoint sh -v "$work:/w" "$image" -c 'find /w -mindepth 1 -delete' >/dev/null 2>&1 || true
  rmdir "$work" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT

wait_healthy() {
  local state
  for _ in $(seq 1 120); do
    state=$(docker inspect -f '{{.State.Health.Status}}' "$(dc ps -q print-farm)" 2>/dev/null || echo starting)
    if [ "$state" = healthy ]; then echo "container healthy"; return 0; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$(dc ps -q print-farm)" 2>/dev/null)" != true ]; then
      echo "container exited" >&2; return 1
    fi
    sleep 5
  done
  echo "container did not become healthy (last state: $state)" >&2
  return 1
}

jar="$work/cookies"
admin() { curl -s -b "$jar" -c "$jar" -H "Origin: $origin" -H "X-Requested-With: XMLHttpRequest" "$@"; }
upload_status() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "$origin/api/uploads" \
    -H "Origin: $origin" -H "X-Requested-With: XMLHttpRequest" \
    -F "file=@$repo/apps/worker/test-fixtures/calibration-cube.stl;type=model/stl"
}
boot() { curl -s "$origin/api/health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("boot",""))'; }

echo "== a new shop: no quotes, no admin password"
dc up -d --no-build
wait_healthy
curl -s "$origin/quote" | grep -q "Coming soon" || { echo "quote page offered quotes with no printer set up" >&2; exit 1; }
code=$(upload_status); echo "$code  POST /api/uploads"
[ "$code" = 503 ] || { echo "upload was not refused" >&2; exit 1; }
code=$(admin -o /dev/null -w '%{http_code}' -X POST "$origin/api/admin/login" -H "Content-Type: application/json" --data '{"password":"anything at all"}')
echo "$code  POST /api/admin/login (no password yet)"
[ "$code" = 409 ] || { echo "login did not ask for the setup code" >&2; exit 1; }

echo "== claim the shop with the setup code from the log"
setup_code=$(dc logs --no-color | sed -n 's/.*First-run setup code: \([0-9A-F]\{4\}-[0-9A-F]\{4\}\).*/\1/p' | tail -n1)
[ -n "$setup_code" ] || { echo "no setup code in the log" >&2; exit 1; }
password="smoke-admin-password-0000"
code=$(admin -o /dev/null -w '%{http_code}' -X POST "$origin/api/admin/claim" -H "Content-Type: application/json" \
  --data "{\"code\":\"0000-0000\",\"password\":\"$password\"}")
echo "$code  POST /api/admin/claim (wrong code)"
[ "$code" = 401 ] || { echo "a wrong setup code was accepted" >&2; exit 1; }
code=$(admin -o /dev/null -w '%{http_code}' -X POST "$origin/api/admin/claim" -H "Content-Type: application/json" \
  --data "{\"code\":\"$setup_code\",\"password\":\"$password\"}")
echo "$code  POST /api/admin/claim"
[ "$code" = 200 ] || { echo "claiming with the setup code failed" >&2; exit 1; }
# (Claiming twice is refused: test/admin-claim.test.ts. Every claim and login
# here counts against the per-address limit of five per 15 minutes.)
jar="$work/cookies-login"   # a fresh session: sign in with the new password
code=$(admin -o /dev/null -w '%{http_code}' -X POST "$origin/api/admin/login" -H "Content-Type: application/json" --data "{\"password\":\"$password\"}")
echo "$code  POST /api/admin/login"
[ "$code" = 200 ] || { echo "the new admin password doesn't sign in" >&2; exit 1; }

echo "== pick a printer from OrcaSlicer's list (server settings)"
before=$(boot)
code=$(admin -o /dev/null -w '%{http_code}' -X PUT "$origin/api/admin/server-settings" -H "Content-Type: application/json" \
  --data '{"siteAddress":"'"$origin"'","printer":{"machine":"Prusa MK4 0.4 nozzle","multiMaterial":false,"displayName":""}}')
echo "$code  PUT /api/admin/server-settings"
[ "$code" = 200 ] || { echo "saving the server settings failed" >&2; exit 1; }
for _ in $(seq 1 90); do
  sleep 2
  now=$(boot 2>/dev/null || true)
  [ -n "$now" ] && [ "$now" != "$before" ] && break
done
[ -n "$now" ] && [ "$now" != "$before" ] || { echo "the shop did not restart with the new settings" >&2; exit 1; }
grep -q '"machine": "Prusa MK4 0.4 nozzle"' "$work/data/printer/printer.json" 2>/dev/null \
  || dc exec -T print-farm grep -q '"machine": "Prusa MK4 0.4 nozzle"' /data/printer/printer.json \
  || { echo "the printer's profiles were not generated" >&2; exit 1; }
dc logs --no-color | grep -q "Server settings applied" || { echo "settings were not applied" >&2; exit 1; }
echo "ok: restarted with the Prusa MK4's profiles"

echo "== still no quotes: no material has a built-in preset"
code=$(upload_status); echo "$code  POST /api/uploads"
[ "$code" = 503 ] || { echo "a shop with no filament preset accepted an upload" >&2; exit 1; }

echo "== the owner uploads a PLA preset (an OrcaSlicer export)"
code=$(admin -o /dev/null -w '%{http_code}' -X POST "$origin/api/admin/slicer-profiles?slot=filament:PLA&name=smoke-pla.json" \
  -H "Content-Type: application/octet-stream" --data-binary "@$repo/apps/worker/test-fixtures/smoke-pla.json")
echo "$code  POST /api/admin/slicer-profiles (filament:PLA)"
[ "$code" = 202 ] || { echo "preset upload refused" >&2; exit 1; }
for _ in $(seq 1 60); do
  state=$(admin "$origin/api/admin/slicer-profiles")
  live=$(python3 -c 'import json,sys; s=json.load(sys.stdin); r=[x for x in s["slots"] if x["slot"]=="filament:PLA"][0]; print("live" if r["live"] else ("failed: "+r["lastError"]) if r["lastError"] else "")' <<<"$state")
  case "$live" in live) break ;; failed*) echo "PLA preset $live" >&2; exit 1 ;; esac
  sleep 5
done
[ "$live" = live ] || { echo "PLA preset never went live" >&2; exit 1; }
echo "ok: PLA preset passed its test slice and is live"

echo "== public pages"
for path in /api/health / /quote /contact /faq /materials /pricing; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$origin$path")
  echo "$code  $path"
  [ "$code" = 200 ] || { echo "expected 200 for $path" >&2; exit 1; }
done
code=$(curl -s -o /dev/null -w '%{http_code}' "$origin/admin")
echo "$code  /admin (admin gate)"
[ "$code" = 307 ] || { echo "admin gate did not redirect" >&2; exit 1; }

echo "== only nginx listens outside loopback"
listeners=$(dc exec -T print-farm sh -c "cat /proc/net/tcp /proc/net/tcp6 | awk '\$4 == \"0A\" {print \$2}'")
while read -r addr; do
  [ -n "$addr" ] || continue
  ip=${addr%:*}; p=$((16#${addr#*:}))
  case "$ip" in
    ??????7F|00000000000000000000000001000000) ;;            # 127.0.0.0/8 / ::1
    *) [ "$p" = 7654 ] || { echo "unexpected listener on port $p ($ip)" >&2; exit 1; } ;;
  esac
done <<<"$listeners"
echo "ok"

echo "== real slice through the queue"
node "$repo/apps/web/scripts/stack-slice-smoke.mjs" "$origin" "$origin"

echo "== Orca staged inside the job sandbox"
# Regression guard for the 2026-08-11 outage: if this shared path exists, some
# run resolved TMPDIR to the default temp dir and the next slice under a
# different uid would fail at 97%.
if dc exec -T print-farm sh -c 'ls -d /tmp/orcaslicer_model' 2>/dev/null; then
  echo "Orca used the SHARED /tmp/orcaslicer_model; TMPDIR is not per-run" >&2
  exit 1
fi
echo "ok"

echo "== backup and restore"
dc exec -T print-farm print-farm backup > "$work/backup.pgdump"
[ -s "$work/backup.pgdump" ] || { echo "backup is empty" >&2; exit 1; }
dc exec -T print-farm print-farm restore < "$work/backup.pgdump"
wait_healthy

echo "== restart keeps data, settings and secrets"
# The setup code is the one secret a restart may drop: it's used up.
secrets_sum() { dc exec -T print-farm sh -c 'cd /data/secrets && sha256sum $(ls | grep -v "^setup-code$") | sha256sum'; }
before=$(secrets_sum)
dc restart
wait_healthy
after=$(secrets_sum)
[ "$before" = "$after" ] || { echo "secrets changed across a restart" >&2; exit 1; }
dc exec -T print-farm test ! -e /data/secrets/setup-code || { echo "the used setup code survived a restart" >&2; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' "$origin/quote")
[ "$code" = 200 ] || { echo "quote page after restart: $code" >&2; exit 1; }
curl -s "$origin/quote" | grep -q "Coming soon" && { echo "the shop forgot its printer or material across a restart" >&2; exit 1; }
jar="$work/cookies-2"
code=$(admin -o /dev/null -w '%{http_code}' -X POST "$origin/api/admin/login" -H "Content-Type: application/json" --data "{\"password\":\"$password\"}")
[ "$code" = 200 ] || { echo "admin login after restart: $code" >&2; exit 1; }
echo "ok"

echo "image smoke test passed"
