#!/usr/bin/env bash
# Boot the print-farm image exactly as docker-compose.yml runs it (read-only
# root, dropped capabilities, tmpfs /run and /tmp) and prove the whole shop
# works from the outside:
#
#   * with no printer set up (there is no default) the shop takes no quotes;
#   * every service comes up and the container reports healthy;
#   * the public pages render and the admin gate redirects;
#   * one real model is sliced by OrcaSlicer through the public API — under the
#     real slicer uid, in the real per-job sandbox, from the shipped bundle;
#   * Orca staged inside its job sandbox, not the shared /tmp path;
#   * a backup restores into the running container, and the shop survives a
#     restart with its data and generated secrets.
#
#   scripts/ci/image-smoke.sh <image>
#
# Uses its own compose project (print-smoke) and tears it down, volume included.
set -euo pipefail

image=${1:?usage: image-smoke.sh <image>}
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
port=${SMOKE_PORT:-18080}
origin="http://localhost:$port"
work=$(mktemp -d)

export COMPOSE_PROJECT_NAME=print-smoke
export PRINT_IMAGE=$image
export PROXY_BIND=127.0.0.1 PROXY_PORT=$port APP_ORIGIN=$origin
# Whatever the calling environment holds must not leak into the stack.
export ADMIN_PASSWORD_HASH="" SESSION_SECRET="" TRUSTED_PROXY_CIDR="" PRINTER_MACHINE=""
export ADMIN_PASSWORD="ci-admin-password-0000"
export PRINT_MEMORY=${PRINT_MEMORY:-8g}

dc() { docker compose -f "$repo/docker-compose.yml" "$@"; }
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "---- container logs (last 200 lines) ----" >&2
    dc logs --no-color --tail 200 >&2 || true
  fi
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
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

echo "== start with no printer: no quotes"
dc up -d --no-build
wait_healthy
curl -s "$origin/quote" | grep -q "Coming soon" || { echo "quote page offered quotes with no printer set up" >&2; exit 1; }
body=$(curl -s -o - -w '\n%{http_code}' -X POST "$origin/api/uploads" \
  -H "Origin: $origin" -H "X-Requested-With: XMLHttpRequest" \
  -F "file=@$repo/apps/worker/test-fixtures/calibration-cube.stl;type=model/stl")
code=${body##*$'\n'}
echo "$code  POST /api/uploads"
[ "$code" = 503 ] && grep -q SHOP_NOT_READY <<<"$body" || { echo "upload was not refused: $body" >&2; exit 1; }
echo "ok"

echo "== pick a printer from OrcaSlicer's list"
export PRINTER_MACHINE="Prusa MK4 0.4 nozzle"
dc up -d --no-build
wait_healthy

echo "== still no quotes: no material has a built-in preset"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$origin/api/uploads" \
  -H "Origin: $origin" -H "X-Requested-With: XMLHttpRequest" \
  -F "file=@$repo/apps/worker/test-fixtures/calibration-cube.stl;type=model/stl")
echo "$code  POST /api/uploads"
[ "$code" = 503 ] || { echo "a shop with no filament preset accepted an upload" >&2; exit 1; }

echo "== the owner uploads a PLA preset (an OrcaSlicer export)"
jar="$work/cookies"
admin() { curl -s -b "$jar" -c "$jar" -H "Origin: $origin" -H "X-Requested-With: XMLHttpRequest" "$@"; }
admin -o /dev/null -X POST "$origin/api/admin/login" -H "Content-Type: application/json" \
  --data "{\"password\":\"$ADMIN_PASSWORD\"}"
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
    *) [ "$p" = 8080 ] || { echo "unexpected listener on port $p ($ip)" >&2; exit 1; } ;;
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

echo "== restart keeps data and secrets"
before=$(dc exec -T print-farm sh -c 'sha256sum /data/secrets/* | sha256sum')
dc restart
wait_healthy
after=$(dc exec -T print-farm sh -c 'sha256sum /data/secrets/* | sha256sum')
[ "$before" = "$after" ] || { echo "secrets changed across a restart" >&2; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' "$origin/quote")
[ "$code" = 200 ] || { echo "quote page after restart: $code" >&2; exit 1; }
echo "ok"

echo "image smoke test passed"
