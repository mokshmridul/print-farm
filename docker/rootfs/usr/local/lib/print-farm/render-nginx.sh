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
#
# Self-contained (no common.sh) so CI can run it on the template directly.
set -euo pipefail

template=${1:?template path}
out=${2:?output path}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cidr=${TRUSTED_PROXY_CIDR:-}
header=${REAL_IP_HEADER:-X-Real-IP}

case "${header,,}" in
  x-real-ip) header=X-Real-IP ;;
  cf-connecting-ip) header=CF-Connecting-IP ;;
  *) echo "[nginx] REAL_IP_HEADER must be X-Real-IP or CF-Connecting-IP" >&2; exit 1 ;;
esac

geo="" realip="" gate=""
if [ -n "$cidr" ]; then
  # Whitelists the complete grammar before the value reaches nginx.conf.
  TRUSTED_PROXY_CIDR=$cidr "$here/validate-trusted-proxy.sh" >&2
  geo="  $cidr 1;"
  realip="  set_real_ip_from $cidr;
  real_ip_header $header;"
  gate='  if ($trusted_forwarder = 0) {
    return 403;
  }'
fi

# Every marker must be present exactly once, or the template and this script
# have drifted apart and the trust policy would silently not apply.
for marker in geo realip gate; do
  n=$(grep -cxF "  # @trusted-proxy-$marker" "$template" || true)
  [ "$n" = 1 ] || { echo "[nginx] template must contain '# @trusted-proxy-$marker' exactly once (found $n)" >&2; exit 1; }
done

tmp=$(mktemp "$out.XXXXXX")
GEO=$geo REALIP=$realip GATE=$gate awk '
  $0 == "  # @trusted-proxy-geo"    { if (ENVIRON["GEO"] != "") print ENVIRON["GEO"]; next }
  $0 == "  # @trusted-proxy-realip" { if (ENVIRON["REALIP"] != "") print ENVIRON["REALIP"]; next }
  $0 == "  # @trusted-proxy-gate"   { if (ENVIRON["GATE"] != "") print ENVIRON["GATE"]; next }
  { print }
' "$template" > "$tmp"
mv "$tmp" "$out"
if [ -n "$cidr" ]; then
  echo "[nginx] Trusting $cidr for $header; other peers are refused" >&2
else
  echo "[nginx] No trusted forwarder (TRUSTED_PROXY_CIDR unset): clients are identified by their TCP address" >&2
fi
