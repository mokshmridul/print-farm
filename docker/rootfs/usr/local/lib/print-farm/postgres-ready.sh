#!/bin/bash
# Blocks until PostgreSQL accepts connections (s6-rc oneshot "postgres-ready").
PF_COMPONENT=postgres
# shellcheck source=common.sh
. /usr/local/lib/print-farm/common.sh
for _ in $(seq 1 240); do
  if s6-setuidgid postgres pg_isready -q -h "$PG_SOCKET_DIR" -p "$PG_PORT"; then exit 0; fi
  sleep 0.5
done
die "PostgreSQL did not start within 120 seconds."
