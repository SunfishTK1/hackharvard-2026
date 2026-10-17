#!/usr/bin/env bash
# Turns a fresh Ubuntu 24.04 server into a small multi-app Docker host. Safe to re-run.
# Run as root:  ssh root@<host> 'bash -s' < server/bootstrap.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "== Swap"
# 2 GB of swap gives image builds and several small containers headroom on a 2 GB box.
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
sysctl -q -p /etc/sysctl.d/99-swappiness.conf

echo "== Docker"
# Rotated, compressed container logs so one chatty app can't fill the disk.
install -d /etc/docker
daemon_json='{ "log-driver": "local", "log-opts": { "max-size": "10m", "max-file": "3" } }'
daemon_changed=false
if [ "$(cat /etc/docker/daemon.json 2>/dev/null)" != "$daemon_json" ]; then
  echo "$daemon_json" > /etc/docker/daemon.json
  daemon_changed=true
fi
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
elif $daemon_changed; then
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null

echo "== Firewall"
# SSH plus HTTP/HTTPS for the shared proxy. Note: ports published by Docker bypass ufw,
# so apps publish nothing and are reached through the proxy instead.
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null

echo "== App layout"
# Every app lives in /opt/apps/<name> with its own compose.yaml and .env.
install -d -m 0755 /opt/apps
# Apps that serve HTTP join this network so the proxy can reach them by service name.
docker network inspect web >/dev/null 2>&1 || docker network create web >/dev/null

echo "== Guide for humans and agents"
# The guide is deployed as /opt/apps/docs (server/deploy.sh server/docs docs); these links make it
# the first thing anyone sees in /opt/apps. CLAUDE.md is what Claude Code looks for.
ln -sfn docs/site/README.md /opt/apps/README.md
ln -sfn docs/site/AGENTS.md /opt/apps/AGENTS.md
ln -sfn docs/site/AGENTS.md /opt/apps/CLAUDE.md
cat > /etc/motd <<'MOTD'

  hackharvard2026 team server  ·  https://hackharvard2026.velroi.com
  Every app: /opt/apps/<name>  ·  addresses: <name>.hackharvard2026.velroi.com

  Read first:  /opt/apps/README.md   how the server works and how to deploy
               /opt/apps/AGENTS.md   rules for AI agents (also CLAUDE.md)

MOTD

docker --version
docker compose version
ufw status | head -1
swapon --show=NAME,SIZE --noheadings
