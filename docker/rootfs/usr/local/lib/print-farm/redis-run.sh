#!/bin/bash
PF_COMPONENT=redis
# shellcheck source=common.sh
. /usr/local/lib/print-farm/common.sh
exec s6-setuidgid redis redis-server "$RUN_DIR/redis.conf"
