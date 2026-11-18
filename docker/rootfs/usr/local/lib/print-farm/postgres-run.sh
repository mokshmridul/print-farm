#!/bin/bash
# PostgreSQL, loopback only. Its socket is restricted by pg_hba to the postgres
# OS user (peer); app roles authenticate over 127.0.0.1 with SCRAM.
PF_COMPONENT=postgres
# shellcheck source=common.sh
. /usr/local/lib/print-farm/common.sh
exec s6-setuidgid postgres "$PG_BIN/postgres" -D "$PG_DATA" \
  -c listen_addresses="$PG_HOST" \
  -c port="$PG_PORT" \
  -c unix_socket_directories="$PG_SOCKET_DIR" \
  -c hba_file="$RUN_DIR/pg_hba.conf" \
  -c password_encryption=scram-sha-256 \
  -c log_destination=stderr \
  -c logging_collector=off
