#!/bin/sh
# Creates a self-signed TLS certificate on first start (kept in the data volume), then hands off
# to the stock Postgres entrypoint. Clients connect with sslmode=require.
set -e
TLS_DIR=/var/lib/postgresql/tls
if [ ! -f "$TLS_DIR/server.key" ]; then
  mkdir -p "$TLS_DIR"
  openssl req -new -x509 -days 3650 -nodes -newkey rsa:2048 \
    -subj "/CN=${TLS_HOSTNAME:-clinical-db}" \
    -addext "subjectAltName=DNS:${TLS_HOSTNAME:-clinical-db}${TLS_IP:+,IP:$TLS_IP}" \
    -keyout "$TLS_DIR/server.key" -out "$TLS_DIR/server.crt" 2>/dev/null
  chown -R postgres:postgres "$TLS_DIR"
  chmod 600 "$TLS_DIR/server.key"
fi
exec docker-entrypoint.sh "$@"
