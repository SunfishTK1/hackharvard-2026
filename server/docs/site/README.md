# hackharvard2026 team server

One Ubuntu server that hosts the team's apps. Every app gets its own address under **`*.hackharvard2026.velroi.com`** with automatic HTTPS.

Find this guide at **https://hackharvard2026.velroi.com**, at `/opt/apps/README.md` on the server, and at `server/docs/site/README.md` in the [hackharvard-2026](https://github.com/SunfishTK1/hackharvard-2026) repo. Rules for AI agents are in [`AGENTS.md`](/AGENTS.md).

## What's running

| App | Address | Folder in `/opt/apps` | What it is |
| --- | --- | --- | --- |
| Server guide | https://hackharvard2026.velroi.com | `docs` | This page |
| iMessage agent | https://apps.hackharvard2026.velroi.com | `photon-demo` | Photon 2.0 iMessage agent (Claude Haiku 5.5). Hosts the mini-apps it builds at `/m/<id>/`. |
| Clinical trial database | `db.hackharvard2026.velroi.com:5432` (TLS) | `clinical-db` | PostgreSQL 18 + pgvector for the clinical trial project. Read-only browser: https://db.hackharvard2026.velroi.com |
| Patient assistant | https://patient.hackharvard2026.velroi.com | `patient-assistant` | "Sage", the iMessage study assistant (Patient-AI-Agent): prescreen, e-consent with Face ID, scheduling and check-ins as in-chat mini-apps, on the clinical trial database's `assistant` schema. Shares the Photon 1.0 line with Charles Sprint. |
| DB Browser | https://dbview.hackharvard2026.velroi.com | `db-browser` | Read-only viewer of every table in the clinical trial database, with foreign-key links. Shared team password. |
| Trial manager view | https://trial-manager.hackharvard2026.velroi.com | `clinical-trial-manager-view` | Web UI for trial managers |
| Server load view | https://load.hackharvard2026.velroi.com | `server-load-view` | Live server load dashboard |
| Proxy | ports 80 and 443 | `proxy` | Caddy: routes each address to its app and handles HTTPS |

Each app folder has its own README with app-specific details.

## Addresses and HTTPS

- **Any** name under `hackharvard2026.velroi.com` already points at this server: a wildcard DNS record at Cloudflare (DNS only, no Cloudflare proxy). New apps don't need DNS changes.
- The proxy gets a free Let's Encrypt certificate for each name the first time it's requested. Nothing to set up.
- Older `*.74-208-206-131.sslip.io` addresses still work as aliases, so links already sent out keep working.
- Only ports 80 and 443 (and SSH) are reachable from the internet. The hosting provider (IONOS) filters everything else before it reaches the server, so a new public port needs a rule in the IONOS Cloud Panel (Network → Firewall Policies) from the account owner. Prefer HTTPS through the proxy whenever possible.

## How it's organized

```
/opt/apps/
├── README.md        this guide (humans)
├── AGENTS.md        rules for AI agents (CLAUDE.md points here too)
├── proxy/           Caddy; one site file per app in proxy/sites/
├── docs/            this guide, published as a tiny web app
└── <app>/           one folder per app: compose.yaml, .env, code
```

- **Every app is a Docker Compose project** in `/opt/apps/<name>`, so apps can't break each other's dependencies.
- **Web apps don't publish ports.** They join the shared Docker network `web`, and the proxy reaches them by an alias.
- **Secrets live in `/opt/apps/<name>/.env`** (readable only by root). They're never in git and never sent by the deploy script.
- **Data lives in Docker volumes**, which survive restarts and redeploys.
- The `server/` folder in the repo is the source of truth for the proxy, the deploy tooling and this guide.

## Add a web app

1. Give the app a `Dockerfile` and a `compose.yaml` like this:

   ```yaml
   services:
     web:
       build: .
       restart: unless-stopped
       mem_limit: 128m
       environment:
         PORT: "3000"
       networks:
         default:
         web:
           aliases: [myapp]     # how the proxy finds it; must be unique on the server

   networks:
     web:
       external: true
   ```

2. Add `server/proxy/sites/myapp.caddy` to the repo:

   ```
   myapp.hackharvard2026.velroi.com {
   	encode zstd gzip
   	reverse_proxy myapp:3000
   }
   ```

3. Put any secrets in `/opt/apps/myapp/.env` on the server (`chmod 600`).

4. Deploy from the repo root, then reload the proxy so it picks up the new site:

   ```sh
   server/deploy.sh path/to/myapp          # → /opt/apps/myapp
   server/deploy.sh server/proxy proxy
   ```

5. Open `https://myapp.hackharvard2026.velroi.com` (the first load takes a few seconds while the certificate is issued), then add the app to the table above in `server/docs/site/README.md` and run `server/deploy.sh server/docs docs`.

`server/deploy.sh` copies the folder (skipping `node_modules`, `.env`, `.data` and `.git`), rebuilds, and restarts the app's containers. The server's `.env` and data volumes are kept. Without the repo tooling, the same thing on the server is `cd /opt/apps/myapp && docker compose up -d --build`.

## Day to day

```sh
ssh root@hackharvard2026.velroi.com
cd /opt/apps/<app>
docker compose ps                 # this app's containers
docker compose logs -f            # live logs
docker compose restart            # restart
docker ps                         # everything running on the server
docker stats --no-stream          # memory and CPU per container
```

The server is small: 1 vCPU, 1.8 GB of memory plus 2 GB of swap, 58 GB of disk. Give every service a `mem_limit` and check `docker stats --no-stream` before adding something heavy.

## Set up a fresh server

`server/bootstrap.sh` turns a new Ubuntu 24.04 machine into this setup: Docker and Compose, swap, log rotation, the firewall, `/opt/apps`, the shared `web` network, the login banner, and the links to this guide. It's safe to re-run:

```sh
ssh root@<host> 'bash -s' < server/bootstrap.sh
server/deploy.sh server/docs docs
server/deploy.sh server/proxy proxy
```
