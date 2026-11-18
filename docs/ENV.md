# Environment variables

Copy `.env.example` to `.env`, fill in values, and run `chmod 0600 .env`.
Production secrets have no usable defaults and are validated before startup.
Passwords embedded in URLs must be percent-encoded.

## Core

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `APP_ORIGIN` | production | `http://localhost:8080` | Exact public origin used for CSRF, cookies, CSP/HSTS, and generated links. HTTPS unless it is localhost or a private-network address; no path/query. |
| `PRINT_IMAGE` | compose | `ghcr.io/mokshmridul/print-farm:latest` | Image to run. Every commit on main is published as `:sha-<7 hex>` too. |
| `PROXY_BIND` / `PROXY_PORT` | compose | `127.0.0.1` / `8080` | Host address and port the container's :8080 is published on. Use only the private address reached by the public proxy; never `0.0.0.0` on a public server. |
| `TRUSTED_PROXY_CIDR` | behind a proxy | empty | The one transport source allowed to assert the client IP/scheme: one IPv4 host (no prefix or `/32`) or unbracketed IPv6 host (no prefix or `/128`); startup rejects subnets, lists, hostnames, and invalid/config syntax. Empty: nothing is trusted and every peer is served as itself. |
| `REAL_IP_HEADER` | no | `X-Real-IP` | Where that forwarder puts the client address: `X-Real-IP` or `CF-Connecting-IP`. |
| `PRINT_MEMORY` / `PRINT_TMP_SIZE` | compose | `12g` / `3g` | Memory ceiling for the whole container, and the in-memory `/tmp` the slicer stages models in. |

Despite its historical name, `TRUSTED_PROXY_CIDR` is deliberately a single-host
allowlist, not a network. It must match the outer proxy's transport address as
the container sees it — the `peer=` field of its nginx access log. Firewall the
published port to the same source; the container's nginx also returns 403 to
every other transport peer. It overwrites `X-Real-IP` and `X-Forwarded-For` and
passes the original transport peer internally as `X-Proxy-Peer-IP`.

### Generated inside the container

`DATABASE_URL`, `REDIS_URL` and the worker's and schema owner's database URLs
are not configured: on first boot the container generates a distinct 64-hex
password for the schema owner (`print_owner`), the web role (`print_web`), the
worker role (`print_worker`) and Redis, keeps them root-only in `/data/secrets`,
and builds each process's URLs from them. Every start re-applies the role
passwords and least-privilege grants before web and worker run.

## Session/admin secrets

| Variable | Required | Notes |
| --- | --- | --- |
| `SESSION_SECRET` | no | Generated in `/data/secrets/session-secret` when unset. Pin it (at least 32 random bytes) only to keep an existing install's value. Signs purpose-separated quote, admin, and shipping tokens. |
| `ADMIN_PASSWORD` | no | Hashed on first boot only, never stored in plain text. |
| `ADMIN_PASSWORD_HASH` | no | A pinned bcrypt hash (cost 12+); takes precedence over the hash kept in the volume. Without either, a password is generated and printed once in the first boot's log. Change the kept one with `print-farm admin-password`. |

Docker Compose interpolates `$` in `.env`: put a pinned bcrypt hash in single
quotes (`ADMIN_PASSWORD_HASH='$2a$12$…'`), or double every `$` to `$$`.

## Printer

| Variable | Default | Notes |
| --- | --- | --- |
| `PRINTER_MACHINE` | unset | Unset: the committed, hand-tuned Bambu Lab A1 profiles. Otherwise an exact OrcaSlicer machine preset (`docker/selfhost/printers.tsv`); `init` generates its profiles into `/data/printer` and regenerates them when the choice or OrcaSlicer changes. |
| `PRINTER_MULTI_MATERIAL` | `0` | `1` for an AMS/MMU/tool changer (automatic multicolour). |
| `PRINTER_ADVANCED` (`ADVANCED_PROFILES` in the container) | `0` | `1`: the owner uploads OrcaSlicer presets in admin → Slicer profiles. |
| `PRINTER_DISPLAY_NAME` | | The printer's name in customer copy. |

## Business and third-party services

| Variable | Default | Notes |
| --- | --- | --- |
| `WHATSAPP_NUMBER` | empty | International digits only. Fallback for the WhatsApp number in admin → Site; empty in both disables the pre-filled handoff. Customer/order details are sent to WhatsApp when used. |
| `CONTACT_EMAIL` | empty | Unused. The public contact email, phone and address are set in admin → Site. |
| `GOOGLE_MAPS_EMBED_URL` | empty | Optional exact Google Maps HTTPS embed URL; enables Google in CSP `frame-src`. |
| `RESEND_API_KEY` / `MAIL_TO` | none | Contact-form delivery through Resend, used until admin → Settings → Email is saved (which also offers SMTP and replaces all three). Without either, the contact page shows WhatsApp and the shop's details instead of a form. Messages contain the submitted name, email, subject, and message. |
| `CONTACT_FROM` | `print.rish.pw <contact@rish.pw>` | Verified Resend sender (until admin → Settings → Email is saved). |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | empty | Both enable order notifications containing customer/order details and static, PII-free operator alerts. These remain web-only secrets. |
| `TELEGRAM_MESSAGE_THREAD_ID` | empty | Optional positive Telegram forum topic ID. |
| `SHIPROCKET_EMAIL` / `SHIPROCKET_PASSWORD` | none | Optional API-user credentials for shipping estimates; do not use the dashboard login. Used until admin → Shipping is saved, which then replaces all three. Without either, the quote page has no shipping estimator. |
| `SHIPROCKET_PICKUP_PINCODE` | `781001` | Workshop origin pincode (until admin → Shipping is saved). |

Treat third-party configuration as a privacy decision, not only a technical
one. Review vendor retention/access terms before enabling it.

## Files, quotas, and retention

| Variable | Default | Notes |
| --- | --- | --- |
| `UPLOAD_DIR` | `./data/uploads` | Model/thumbnail vault (fixed at `/data/uploads` in the image). |
| `PDF_DIR` | `./data/pdfs` | Quotation PDF vault (fixed at `/data/pdfs` in the image). |
| `MAX_UPLOAD_MB` | `300` | Per-file limit; values above the hard 300 MiB cap are reduced to 300. |
| `MAX_SESSION_UPLOAD_MB` | `900` | Persistent active-upload bytes per anonymous quote session. |
| `UPLOAD_WINDOW_MB` | `900` | Accepted upload bytes per observed IP per 10 minutes. |
| `DOWNLOAD_WINDOW_MB` | `1200` | Model download bytes per observed IP per 10 minutes. |
| `STORAGE_RESERVE_MB` | `2048` | Free-space reserve preserved by capacity reservations and final checks. |
| `MAX_MODELS_PER_SESSION` | `20` | Active models in one quote session. |
| `UPLOAD_RETENTION_HOURS` | `48` | Unattached upload lifetime. This and the two below apply until admin → Settings → File clean-up is saved. |
| `FILE_RETENTION_DAYS` | `30` | Model-file lifetime after all referencing quotations are terminal and old. Quotation/model rows and PDFs remain until the quotation sweep. |
| `QUOTATION_RETENTION_DAYS` | `90` | Deletion threshold measured from `updatedAt` for `COMPLETED`, `DELIVERED`, and `CANCELLED` quotations. Policy caps the threshold at 90 days, so larger values are reduced to 90; the next daily sweep deletes the quotation and its customer/contact/address data, items/history, PDF, and models that become unreferenced. Non-terminal quotations do not age out. |
| `PRINT_DB_DIR`, `PRINT_UPLOAD_DIR`, `PRINT_PDF_DIR`, `PRINT_REDIS_DIR` | none | Required host paths when using `docker-compose.vault.yml`. |

## Worker

| Variable | Default | Notes |
| --- | --- | --- |
| `WORKER_CONCURRENCY` | `1` | Parallel slicers; hard maximum 8. Concurrent slicers share one container CPU/memory quota, so extra concurrency degrades heavy slices into timeouts rather than adding throughput. |
| `SLICE_TIMEOUT_SECONDS` | `600` | Per-slice timeout; hard maximum 900 seconds. Sized for sculpt-detail models on the worker's shared CPU quota. |
| `THUMB_SIZE` | `512` | Square PNG size; hard maximum 1024 px. |
| `ORCA_BIN` | `/opt/orca/AppRun` | Baked-in executable. |
| `ORCA_VERSION` | `2.4.2` | Must agree with the pinned image/cache pipeline version. |
| `STEP_CONVERT_BIN` | `/usr/bin/occt-draw` | OpenCASCADE DRAW harness used to tessellate STEP uploads inside the parse sandbox (baked into the worker image). |
| `STEP_CONVERT_TIMEOUT_SECONDS` | `120` | Per-file STEP→STL conversion timeout; hard maximum 600 seconds. |
| `PROFILES_DIR` | worker profiles | Flattened, committed A1 profiles. |
| `SLICE_WORK_DIR` | `/tmp/slice-jobs` | Private per-job scratch root. |
| `SLICER_UID` / `SLICER_GID` | `1002` / `3000` | Base identity for untrusted per-job slicer processes. |
| `STORAGE_UID` / `STORAGE_GID` | `1001` / `1001` | Durable storage owner. |
| `LOG_LEVEL` | `info` | Structured web/worker log level. |
| `ALLOW_INSECURE_SLICER` | false | Dangerous local-development escape hatch. Ignored in production; never deploy it. |
| `STUB_SLICER` | false | Source-run HTTP-flow harness only. Literal `true` requires `NODE_ENV=development` or `test`; worker startup refuses it otherwise. It writes synthetic cache rows, so use only disposable integration PostgreSQL and Redis stores. Intentionally absent from Compose. |

The worker also receives `MAX_UPLOAD_MB`, `MAX_SESSION_UPLOAD_MB`,
`MAX_MODELS_PER_SESSION`, and `STORAGE_RESERVE_MB`, because the ingest consumer
rechecks those limits authoritatively before it creates `UploadedModel` rows.
Ingest concurrency (globally one), queue admission (25), ticket retention
(about one hour), and temp ownership (at most two hours) are safety constants,
not deployment tuning knobs.

## Process exposure

Each process inside the container gets an environment built from scratch by
its run script (`docker/rootfs/usr/local/lib/print-farm/*-run.sh`); values are
exported, never placed on a command line. The container's own environment
snapshot (`/run/s6/container_environment`) is readable by root only.

- `migrate`: only the owner URL plus the two runtime URLs; exits after
  migrations and grants. The owner holds superuser only for the provisioning
  step, while web and worker are not running.
- `web`: explicit allowlist of its runtime DB URL, Redis URL, session/admin and
  configured provider secrets, and web quota settings. It never receives the
  migration/worker database URLs or any owner password.
- `worker`: worker DB URL, authenticated Redis URL, storage paths, and worker
  knobs only. It receives no session/admin/provider secrets. Heartbeat alerting
  is observed and sent by web. Each Orca process gets a private model copy and
  a minimal explicit, credential-free environment containing only process
  basics such as `PATH`, locale, `HOME`, and `XDG_RUNTIME_DIR`, under its own
  uid, which can read neither `/data`, `/data/secrets`, the environment
  snapshot nor another process's environment. The container's memory and PID
  limits apply to everything in it — database and web included — not
  individually to each Orca process; slicer and parse children run under
  `choom -n 1000` so the kernel reaps them first. The slicer timeout is per
  job. `STUB_SLICER` is never forwarded.
