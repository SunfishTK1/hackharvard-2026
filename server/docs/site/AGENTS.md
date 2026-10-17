# Rules for AI agents on the hackharvard2026 server

You are on a small server shared by a hackathon team and several AI agents. Other people's apps are running here. Read this before changing anything. The full guide is `/opt/apps/README.md` (https://hackharvard2026.velroi.com).

## Facts

- Every app is a Docker Compose project in `/opt/apps/<name>`. The proxy (`/opt/apps/proxy`, Caddy) owns ports 80 and 443 and routes `<name>.hackharvard2026.velroi.com` to apps over the shared Docker network `web`.
- Any `*.hackharvard2026.velroi.com` name already resolves here, and HTTPS certificates are automatic. Never ask for DNS changes for a new subdomain.
- Only 22, 80 and 443 are reachable from the internet. IONOS filters other ports upstream, and only the account owner can open them.
- Resources are tight: 1 vCPU, 1.8 GB of memory plus 2 GB of swap.
- The git repo `hackharvard-2026` (folder `server/`, plus one folder per app) is the source of truth.

## Do

- Deploy a web app as its own Compose project in `/opt/apps/<name>`: join the external `web` network with a unique alias, set `mem_limit`, and add `/opt/apps/proxy/sites/<name>.caddy` (in the repo: `server/proxy/sites/<name>.caddy`). The full recipe is in the README under "Add a web app".
- Put secrets in `/opt/apps/<name>/.env` with `chmod 600`.
- Prefer the repo tooling (`server/deploy.sh <dir> [name]`) so the repo and the server stay in sync. If you change files directly on the server, copy the change into the repo too.
- After deploying, check it: `docker compose ps`, `docker compose logs --tail 50`, and an HTTPS request to the new address.
- Add new apps to the table in `server/docs/site/README.md` and redeploy the docs (`server/deploy.sh server/docs docs`).
- Check `docker stats --no-stream` before starting anything memory-hungry.

## Don't

- Don't stop, modify or delete another app's folder, containers, volumes, `.env` or proxy site file unless your human asked for that specific app.
- Don't print, log or commit secrets. Don't copy `.env` files off the server.
- Don't publish host ports (`ports:` in compose) for web apps. Docker-published ports bypass the server's firewall. Use the proxy.
- Don't run `docker system prune -a`, `docker volume prune` or `docker compose down -v`. Volumes hold databases.
- Don't change SSH, firewall (`ufw`) or Docker daemon settings without your human's explicit go-ahead.
- Don't load real patient data into the clinical trial database. It holds synthetic data only. `/opt/apps/clinical-db/README.md` and `docs/ONTOLOGY.md` describe its schema and roles; use the role meant for your job, never the superuser.
- Don't put secrets or security details in this guide or the README: they're published on a public web page.

## Useful commands

```sh
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker stats --no-stream
cd /opt/apps/<name> && docker compose logs --tail 100
cd /opt/apps/proxy && docker compose logs --tail 50     # certificate and routing problems
ls /opt/apps/proxy/sites/                               # which addresses go where
```
