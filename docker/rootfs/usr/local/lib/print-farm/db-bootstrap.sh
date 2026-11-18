#!/bin/bash
# Create the schema-owner role and the database if missing, and keep the role's
# password in step with /data/secrets. The owner is not a superuser; migrate.sh
# raises it only for the moment provision-database.mjs (re)defines the runtime
# roles, and this resets it first thing on every boot either way. Runs as the PostgreSQL superuser over the
# peer-authenticated socket. The password travels on stdin, never in argv.
PF_COMPONENT=migrate
# shellcheck source=common.sh
. /usr/local/lib/print-farm/common.sh

pw=$(secret postgres-owner-password)
[[ "$pw" =~ ^[0-9a-f]{64}$ ]] || die "Unexpected owner password format in $SECRETS_DIR/postgres-owner-password"
psql_super -d postgres <<SQL
\\set owner $OWNER_ROLE
\\set db $DB_NAME
\\set pw '$pw'
SET client_min_messages = warning;
SELECT format('CREATE ROLE %I LOGIN', :'owner')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'owner') \\gexec
ALTER ROLE :"owner" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'pw';
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'owner')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \\gexec
SQL
