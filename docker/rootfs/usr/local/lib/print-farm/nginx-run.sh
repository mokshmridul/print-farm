#!/bin/bash
# The one listener reachable from outside the container: :8080, plain HTTP.
# The master stays root only to open its log streams; workers, which handle
# every request, run as www-data (`user` in /etc/print-farm/nginx.conf).
PF_COMPONENT=nginx
# shellcheck source=common.sh
. /usr/local/lib/print-farm/common.sh
exec nginx -e stderr -c /etc/print-farm/nginx.conf -g 'daemon off;'
