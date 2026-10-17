#!/usr/bin/env bash
# Ships an app folder to /opt/apps/<name> on the server and (re)starts it with Docker Compose.
# Usage: server/deploy.sh <app-dir> [name]
#   server/deploy.sh Photon-Demo            -> /opt/apps/photon-demo
#   server/deploy.sh server/proxy proxy     -> /opt/apps/proxy
# The server comes from Host and User in the repo .env, or DEPLOY_TARGET=user@host.
# Secrets are never shipped: each app's .env is created once on the server (see server/README.md).
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
app_dir=${1:?Usage: server/deploy.sh <app-dir> [name]}
app_dir=$(cd "$app_dir" && pwd)
name=${2:-$(basename "$app_dir" | tr '[:upper:]' '[:lower:]')}
[ -f "$app_dir/compose.yaml" ] || { echo "No compose.yaml in $app_dir" >&2; exit 1; }

# Reads NAME from the repo .env, dropping straight or curly quotes around the value.
env_value() {
  sed -n "s/^$1=//p" "$repo/.env" | head -n 1 | sed -E 's/^[[:space:]]*("|'\''|“|”)*//; s/("|'\''|“|”)*[[:space:]]*$//'
}
target=${DEPLOY_TARGET:-$(env_value User)@$(env_value Host)}

# One SSH connection for rsync and the remote commands, so a password is asked for once.
ssh_opts=(-o ControlMaster=auto -o "ControlPath=~/.ssh/cm-%C" -o ControlPersist=5m)

echo "Deploying $app_dir to $target:/opt/apps/$name"
ssh "${ssh_opts[@]}" "$target" "install -d /opt/apps/$name"
# Excluded paths are also kept on the server, so the server's .env and data survive --delete.
# An app can list more paths to skip in a .deployignore file (rsync filter syntax).
# No -o/-g: files land owned by the server user rather than your local uid.
rsync -rlptz --delete \
  --exclude node_modules --exclude .env --exclude .data --exclude .git --exclude .DS_Store --filter=':- .deployignore' \
  -e "ssh ${ssh_opts[*]}" "$app_dir/" "$target:/opt/apps/$name/"
# --force-recreate: Compose can keep an old container after a rebuild; a deploy should always run the new image.
ssh "${ssh_opts[@]}" "$target" "cd /opt/apps/$name && docker compose build && docker compose up -d --force-recreate --remove-orphans && docker image prune -f >/dev/null && docker compose ps"
