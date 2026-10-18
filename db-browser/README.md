# DB Browser

A read-only viewer for the clinical trial database: every schema, table and view with row counts; rows you can page, sort and search across every column; any row in full, with its foreign keys followed both ways (what it points to, and what points back at it). Every query runs in a read-only transaction.

**Deployed:** https://dbview.hackharvard2026.velroi.com, behind a shared password (`BROWSER_PASSWORD` in the server's `/opt/apps/db-browser/.env`; any username). It shows contact details and message text, so keep the password to the team. Without a password set, a public instance hides phone numbers, emails, handles, link tokens, chat ids, keys and IPs, and keeps them out of search and filters.

**Locally** (only on 127.0.0.1, using the developer login in `Clinical-DB/.env`):

```sh
ssh -N -L 15432:localhost:5432 root@<server> &   # Postgres is firewalled; tunnel it
npm install && npm start                         # http://localhost:4321
```

Settings: `DATABASE_URL` (used as given; otherwise Clinical-DB/.env through the tunnel at `DATABASE_HOST`, default `localhost:15432`), `DATABASE_NAME`, `PORT` (4321), `HOST` (127.0.0.1), `BROWSER_PASSWORD` (and optionally `BROWSER_USER`).

Deploy: `server/deploy.sh db-browser db-browser`; the proxy site is `server/proxy/sites/db-browser.caddy`.
