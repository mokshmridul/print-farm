#!/bin/bash
# Render the nginx site template (docker/proxy/nginx.conf) into a config file.
#
#   TRUSTED_PROXY_CIDR=192.0.2.10 REAL_IP_HEADER=X-Real-IP render-nginx.sh TEMPLATE OUT
#
# TRUSTED_PROXY_CIDR  empty: trust no forwarder (the TCP peer is the client, and
#                     every peer is served). One host: only it may assert the
#                     client address, and every other peer gets 403.
# REAL_IP_HEADER      which header that forwarder puts the client address in:
#                     X-Real-IP (default) or CF-Connecting-IP (cloudflared).
# DIRECT_ACCESS       1: with a forwarder set, still serve every other peer too,
#                     each identified by its own address and scheme (e.g. LAN
#                     devices opening http://<address>:<port> beside a tunnel).
#                     0 (default): other peers get 403.
#
# Self-contained (no common.sh) so CI can run it on the template directly.
set -euo pipefail

template=${1:?template path}
out=${2:?output path}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cidr=${TRUSTED_PROXY_CIDR:-}
header=${REAL_IP_HEADER:-X-Real-IP}
direct=${DIRECT_ACCESS:-0}

case "${header,,}" in
  x-real-ip) header=X-Real-IP ;;
  cf-connecting-ip) header=CF-Connecting-IP ;;
  *) echo "[nginx] REAL_IP_HEADER must be X-Real-IP or CF-Connecting-IP" >&2; exit 1 ;;
esac

case "$direct" in
  0|1) ;;
  *) echo "[nginx] DIRECT_ACCESS must be 0 or 1" >&2; exit 1 ;;
esac

geo="" realip="" gate="" direct_map=""
if [ -n "$cidr" ]; then
  # Whitelists the complete grammar before the value reaches nginx.conf.
  TRUSTED_PROXY_CIDR=$cidr "$here/validate-trusted-proxy.sh" >&2
  geo="  $cidr 1;"
  realip="  set_real_ip_from $cidr;
  real_ip_header $header;"
  if [ "$direct" = 0 ]; then
    gate='  if ($trusted_forwarder = 0) {
    return 403;
  }'
  else
    direct_map="  0 1;"
  fi
fi

# Every marker must be present exactly once, or the template and this script
# have drifted apart and the trust policy would silently not apply.
for marker in geo realip gate direct; do
  n=$(grep -cxF "  # @trusted-proxy-$marker" "$template" || true)
  [ "$n" = 1 ] || { echo "[nginx] template must contain '# @trusted-proxy-$marker' exactly once (found $n)" >&2; exit 1; }
done

tmp=$(mktemp "$out.XXXXXX")
GEO=$geo REALIP=$realip GATE=$gate DIRECT=$direct_map awk '
  $0 == "  # @trusted-proxy-geo"    { if (ENVIRON["GEO"] != "") print ENVIRON["GEO"]; next }
  $0 == "  # @trusted-proxy-direct" { if (ENVIRON["DIRECT"] != "") print ENVIRON["DIRECT"]; next }
  $0 == "  # @trusted-proxy-realip" { if (ENVIRON["REALIP"] != "") print ENVIRON["REALIP"]; next }
  $0 == "  # @trusted-proxy-gate"   { if (ENVIRON["GATE"] != "") print ENVIRON["GATE"]; next }
  { print }
' "$template" > "$tmp"
mv "$tmp" "$out"
if [ -n "$cidr" ]; then
  if [ "$direct" = 1 ]; then
    echo "[nginx] Trusting $cidr for $header; other peers are served as themselves (DIRECT_ACCESS=1)" >&2
  else
    echo "[nginx] Trusting $cidr for $header; other peers are refused" >&2
  fi
else
  echo "[nginx] No trusted forwarder (TRUSTED_PROXY_CIDR unset): clients are identified by their TCP address" >&2
fi
