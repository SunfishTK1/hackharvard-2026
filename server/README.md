# Server

One Ubuntu 24.04 box (the `Host` in the repo `.env`) that runs every app as a Docker Compose project.

```
/opt/apps/
├── proxy/         Caddy: the only thing on ports 80/443; HTTPS for every web app
├── photon-demo/   iMessage agent; serves its mini-apps at https://apps.74-208-206-131.sslip.io
└── clinical-db/   Postgres 18 for the clinical trial project on :5432 (TLS); read-only browser at https://db.74-208-206-131.sslip.io
```

**Two firewalls:** `ufw` on the server, and IONOS's network firewall in front of it (Cloud Panel → Network → Firewall Policies). IONOS's default policy only lets in 22, 80, 443 and 8443, so a new public port such as Postgres's 5432 needs a rule there too.

**No domain needed:** `<anything>.74-208-206-131.sslip.io` resolves to this server ([sslip.io](https://sslip.io)), and Caddy gets a Let's Encrypt certificate for each name on first use. Give each new app its own name, like `myapp.74-208-206-131.sslip.io`, until you point a real domain here.

Already set up by `bootstrap.sh`: Docker and Compose, 2 GB swap, rotated container logs, a firewall allowing SSH, 80 and 443, and a shared Docker network `web` that the proxy uses to reach web apps. Re-running it is safe:

```sh
ssh root@<host> 'bash -s' < server/bootstrap.sh
```

## Deploy or update an app

```sh
server/deploy.sh Photon-Demo           # → /opt/apps/photon-demo
server/deploy.sh server/proxy proxy    # → /opt/apps/proxy
```

This copies the folder (not `node_modules`, `.env`, `.data` or `.git`) and runs `docker compose up -d --build`. The server's `.env` and data volumes are kept. The host comes from `Host`/`User` in the repo `.env`; override it with `DEPLOY_TARGET=user@host`.

## Add another app

1. Give the app a `Dockerfile` and a `compose.yaml`. Don't publish ports, because Docker-published ports bypass the firewall.
2. If it serves HTTP, put the service on the shared network:
   ```yaml
   services:
     myapp:
       build: .
       restart: unless-stopped
       networks: [web]
   networks:
     web:
       external: true
   ```
   Then add `server/proxy/sites/myapp.caddy`:
   ```
   myapp.example.com {
       reverse_proxy myapp:3000
   }
   ```
   Point the domain's DNS A record at the server. Caddy gets the certificate on its own.
3. Put secrets in `/opt/apps/<name>/.env` on the server (`chmod 600`). They never go through git or `deploy.sh`.
4. Run `server/deploy.sh <app-dir>`, and `server/deploy.sh server/proxy proxy` if you added a site.

## Day to day

```sh
ssh root@<host>
cd /opt/apps/photon-demo
docker compose logs -f            # live logs
docker compose restart            # restart
docker compose down               # stop
docker ps                         # everything running
docker stats --no-stream          # memory per app (box has 1.8 GB + 2 GB swap)
```

## Security to-do

SSH currently allows root login with a password. Before this box hosts anything important, install your SSH key (`ssh-copy-id root@<host>`), check that key login works, then set `PasswordAuthentication no` in `/etc/ssh/sshd_config` and run `systemctl reload ssh`.
