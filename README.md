# print-farm — Instant 3D-Printing Quotation System

A self-hosted 3D-printing quotation app for your own print shop. Customers
upload STL / 3MF / OBJ / AMF models, every model is **actually sliced** with
OrcaSlicer using your printer's profiles (no mathematical estimation), and they
get a live, itemised quote they can tweak and submit. Submitting generates a
PDF and hands off to WhatsApp. Includes marketing pages and a
password-protected admin dashboard.

The image ships with no shop data: no printer, brand, contact details or
addresses. You choose the printer (any of OrcaSlicer's 300+ single-nozzle
printers, or upload your own OrcaSlicer presets), and the shop takes no quotes
until one is set up.

> Forked from [print.rish.pw](https://github.com/zappymussel380/print.rish.pw).
> **Only the code is MIT licensed** (see `LICENSE`).

## Run your own print shop

One command sets up your own copy on an x86_64 Linux server — your name, rates,
materials and contact details — with automatic HTTPS:

```bash
curl -fsSL https://raw.githubusercontent.com/mokshmridul/print-farm/main/install.sh | sudo bash
```

Update later with `sudo /opt/print-shop/update.sh`. See
[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) for requirements, the HTTPS
options, updates and rollback.

Or run the image directly — everything is in one container with one data
volume:

```bash
docker run -d --name print-farm -p 127.0.0.1:8080:8080 -v print-data:/data \
  -e APP_ORIGIN=http://localhost:8080 -e "PRINTER_MACHINE=Prusa MK4 0.4 nozzle" \
  ghcr.io/mokshmridul/print-farm:latest
docker logs print-farm 2>&1 | grep -A2 "admin password"   # generated on first boot
```

`PRINTER_MACHINE` is any OrcaSlicer printer (list:
`docker/selfhost/printers.tsv`, third column). Leave it out to upload your own
OrcaSlicer presets in the admin's guided setup instead. It serves plain HTTP
on :8080; put your reverse proxy or Cloudflare Tunnel in front for HTTPS. `docker-compose.yml` is the hardened version of the same
(read-only root, dropped capabilities, memory limit).

## What's inside

| Area | Tech |
| --- | --- |
| Web (UI + API) | Next.js 15 App Router, TypeScript, Tailwind v4 |
| 3D preview | three.js (dynamic, client-only) |
| Slicing worker | OrcaSlicer headless + BullMQ |
| Data | PostgreSQL + Prisma |
| Queue / cache / rate limits | Redis |
| PDF | @react-pdf/renderer |
| Deploy | One image: nginx · web · worker · PostgreSQL · Redis under s6-overlay |

## Repository layout

```
print/
├── apps/web/        Next.js app (routes, components, lib)
├── apps/worker/     BullMQ worker: OrcaSlicer runner, thumbnails, retention
├── packages/
│   ├── db/          Prisma schema + client singleton
│   ├── shared/      catalog, pricing engine, zod schemas, helpers
│   └── geometry/    STL/3MF/OBJ/AMF parser (bbox, volume, triangle soup)
├── docker/          the image: Dockerfile, s6 services + scripts (rootfs/), nginx site config
└── docs/            architecture, install, deploy, env, db, api, pricing, …
```

## Quick start (development)

```bash
pnpm install --frozen-lockfile                            # Node.js >= 24
docker compose -f docker-compose.dev.yml up -d        # Postgres + Redis
# create apps/web/.env.local as documented in docs/INSTALL.md
DATABASE_URL=postgresql://print:print@localhost:5433/print \
  pnpm --filter @print/db migrate:dev
pnpm --filter @print/web dev                           # web on :3000
```

The native slicer worker should run inside the image, not under a
credential-bearing local user. See the install guide for end-to-end slicing.

See [docs/INSTALL.md](docs/INSTALL.md) for the full walkthrough and
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for production.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — how the pieces fit together
- [Install](docs/INSTALL.md) — local development
- [Self-hosting](docs/SELF-HOSTING.md) — one-command install, updates, rollback
- [Deployment](docs/DEPLOYMENT.md) — production, proxy topology, the VPS edge
- [Environment](docs/ENV.md) — every variable
- [Database](docs/DATABASE.md) — schema and migrations
- [API](docs/API.md) — endpoint reference
- [Pricing](docs/PRICING.md) — how quotes are computed and how to change rates
- [Orca profiles](docs/ORCA-PROFILES.md) — the slicing profiles and re-flattening
- [Maintenance](docs/MAINTENANCE.md) — backups, retention, upgrades
- [Security](docs/SECURITY.md) — threat model, mitigations, residual risks
- [Hardening review](docs/HARDENING.md) — independent findings and remediation status
- [Storage vault + LXC](docs/STORAGE_VAULT_LXC.md) — encrypted `/dev/sde1` layout and migration
