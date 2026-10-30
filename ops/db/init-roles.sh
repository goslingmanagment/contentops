#!/usr/bin/env bash
# First start of `db` (docker-entrypoint-initdb.d, runs only on an empty data directory):
# the two roles of the app and the database owned by the migrate role (PR #5, SPEC §12.1).
#   contentops_migrate — owner of the schema, used only by the one-shot `migrate`
#   contentops_app     — everything else (`web`, workers); DML only, granted by migration 0001
# Passwords come from .env (MIGRATE_DB_PASSWORD, APP_DB_PASSWORD). Idempotent: a role or
# database that exists is left as it is, only its password is set again.
set -euo pipefail

: "${MIGRATE_DB_PASSWORD:?MIGRATE_DB_PASSWORD is not set}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is not set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v migrate_password="$MIGRATE_DB_PASSWORD" -v app_password="$APP_DB_PASSWORD" <<'SQL'
SELECT 'CREATE ROLE contentops_migrate LOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'contentops_migrate') \gexec
SELECT 'CREATE ROLE contentops_app LOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'contentops_app') \gexec
ALTER ROLE contentops_migrate PASSWORD :'migrate_password';
ALTER ROLE contentops_app PASSWORD :'app_password';
SELECT 'CREATE DATABASE contentops TEMPLATE template0 OWNER contentops_migrate'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'contentops') \gexec
SQL
