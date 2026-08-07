# Deploying Profile Transformer

The whole app (API + built UI) ships as **one container**. It stores everything
in a single SQLite file, so a deployment is really just "run the image with a
persistent volume mounted at `/app/data`."

## What's in the box

- Multi-stage [`Dockerfile`](Dockerfile) — builds the web UI, then serves it from
  the Node server. `better-sqlite3` uses prebuilt binaries, so no build toolchain
  is needed at runtime.
- [`docker-compose.yml`](docker-compose.yml) — local one-command run.
- [`render.yaml`](render.yaml) / [`fly.toml`](fly.toml) — managed-host blueprints.
- [`.env.example`](.env.example) — every configuration knob (all optional).
- Security headers (`helmet` with a scoped CSP), `TRUST_PROXY` for running behind
  a load balancer, a `/api/health` check, and per-IP auth rate limiting.

## Local

```bash
docker compose up --build
# → http://localhost:4000   (data persists in the `cpt-data` volume)
```

## Render

Push the repo, then **New → Blueprint** and point it at `render.yaml`. It builds
the Docker image, attaches a 1 GB disk at `/app/data`, and health-checks
`/api/health`. After the first deploy, set `APP_URL` to the service URL (so
reset/invite links are correct) and `SMTP_URL` / `MAIL_FROM` to send email.

## Fly.io

```bash
fly launch --no-deploy          # accepts the bundled fly.toml
fly volumes create cpt_data --size 1
fly secrets set APP_URL=https://<app>.fly.dev SMTP_URL=... MAIL_FROM=...
fly deploy
```

## Going-live checklist

- [ ] Mount a **persistent volume** at `/app/data` — without it, the database is
      wiped on every redeploy.
- [ ] Set **`APP_URL`** to the public URL, or password-reset/invite links break.
- [ ] Set **`TRUST_PROXY=1`** so client IPs and HTTPS detection work behind the proxy.
- [ ] Set **`SMTP_URL` + `MAIL_FROM`** to actually send reset/invite emails
      (without them, links are only logged — fine for a demo, not for real users).
- [ ] Take periodic **backups**: an admin can download a full JSON snapshot from the
      admin tab, or `GET /api/org/backup`. (For the SQLite file itself, snapshot the volume.)

## Scaling & the Postgres question

SQLite comfortably handles a single instance with tens of thousands of candidates.
Two honest limits to know before you outgrow it:

1. **One writer / one instance.** SQLite is a file; you can't run multiple app
   instances against the same database safely. The in-memory rate limiter is also
   per-process. Horizontal scale needs a shared database (Postgres) and a shared
   rate-limit store (Redis).
2. **The migration is a real project, not a flag.** The data layer
   (`server/db.js`, `store.js`, `auth.js`, `audit.js`, `analytics.js`) uses
   `better-sqlite3`, which is **synchronous**. Postgres' driver is **asynchronous**,
   so moving to it means turning every query call site into `async/await` — a large,
   careful change that must be tested against a live Postgres, not shipped blind.

**The safe path when you're ready:** the app already has a portable
export/import — `GET /api/org/backup` / `POST /api/org/restore` (and the store's
`exportOrg`/`importOrg`). That's the migration bridge: stand up the Postgres-backed
build, then restore each org's JSON snapshot into it. Do the driver port as its own
focused task with a real Postgres instance and the existing test suite (+ the
`npm run benchmark` quality gate) guarding it.
