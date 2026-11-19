#!/bin/bash
# The slicing worker. The orchestrator runs as root (container default
# capabilities) so it can keep storage ownership, reap escaped children and
# launch every OrcaSlicer / parse job through setpriv under its own
# credential-free uid. Its environment carries only what the trusted
# orchestrator reads (apps/worker/src/config.ts): never SESSION_SECRET, the
# admin hash or integration API keys. Orca children get a cleared environment
# and cannot read the orchestrator's /proc environ.
PF_COMPONENT=worker
# shellcheck source=common.sh
. /usr/local/lib/print-farm/common.sh

e=(
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  HOME=/tmp/orca-home
  ORCA_DATADIR=/tmp/orca-data
  LANG=en_US.UTF-8
  LC_ALL=en_US.UTF-8
  NODE_ENV=production
  ORCA_BIN=/opt/orca/AppRun
  "ORCA_VERSION=$(cenv ORCA_VERSION)"
  "DATABASE_URL=$(worker_db_url)"
  "REDIS_URL=$(redis_url)"
  "UPLOAD_DIR=$UPLOAD_DIR"
  "PDF_DIR=$PDF_DIR"
  SLICER_UID=1002
  SLICER_GID=3000
  "STORAGE_UID=$STORAGE_UID"
  "STORAGE_GID=$STORAGE_GID"
)
pass_env e WORKER_CONCURRENCY 1
pass_env e SLICE_TIMEOUT_SECONDS 600
pass_env e THUMB_SIZE 512
pass_env e UPLOAD_RETENTION_HOURS 48
pass_env e FILE_RETENTION_DAYS 30
pass_env e QUOTATION_RETENTION_DAYS 90
pass_env e LOG_LEVEL info
pass_env e MAX_UPLOAD_MB 300
pass_env e MAX_SESSION_UPLOAD_MB 900
pass_env e MAX_MODELS_PER_SESSION 20
pass_env e STORAGE_RESERVE_MB 2048
e+=("ADVANCED_PROFILES=$(advanced_profiles)")
[ -f "$PRINTER_DIR/.stamp" ] && e+=("PROFILES_DIR=$PRINTER_DIR")

install -d -m 0755 /tmp/orca-home /tmp/orca-data
# common.sh's umask 077 is for secrets. The app sets explicit modes where they
# matter, and the sandboxed parse/slice uids must traverse the job directories
# the orchestrator creates: run with the conventional default, as before.
umask 022
cd /app
# No core dumps: a crashing Orca must not leave customer geometry on disk.
ulimit -c 0
exec_with_env e node /app/worker/dist/index.js
