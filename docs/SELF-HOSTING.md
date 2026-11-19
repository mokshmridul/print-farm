# Run your own print shop

The whole shop is **one Docker image** (`ghcr.io/mokshmridul/print-farm`): the
website, the OrcaSlicer worker, PostgreSQL, Redis and nginx run together in one
container, with everything durable in one folder. You deploy it like any other
self-hosted image — Sonarr, Radarr, Immich — with a compose file, and set it
up in the browser on first boot.

## What you need

- A Linux server with an **Intel/AMD (x86_64)** CPU and Docker. ARM servers
  (Raspberry Pi, Oracle Ampere, AWS Graviton) can't run the slicer.
- **8 GB RAM** (4 GB works for small models), **25 GB free disk**, 2+ CPU cores.
- A **single-nozzle printer with a 0.4 mm nozzle**: one of the 360+ printers
  OrcaSlicer ships (Bambu Lab, Prusa, Creality, Voron, Elegoo, Qidi, Anycubic,
  Sovol …), or any printer you have an OrcaSlicer preset for.
- For customers on the internet: a domain and a reverse proxy that provides
  HTTPS (SWAG, Nginx Proxy Manager, Caddy, Traefik, a Cloudflare Tunnel). The
  container itself speaks plain HTTP.
- The shop is India-focused: prices are in rupees, and live shipping quotes
  use Shiprocket (optional).

## Quick start

```bash
mkdir print-farm && cd print-farm
curl -fsSLO https://raw.githubusercontent.com/mokshmridul/print-farm/main/docker-compose.yml
docker compose up -d
docker compose logs | grep "setup code"
```

Open `http://<this computer>:8080/admin`. That's it: everything else is set
in the browser.

Prefer plain `docker run`?

```bash
docker run -d --name print-farm --restart unless-stopped \
  -p 8080:8080 -v ./data:/data -v ./profiles:/profiles:ro \
  --memory 12g --read-only --tmpfs /run:exec,size=64m --tmpfs /tmp:noexec,size=3g \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add KILL \
  --cap-add SETGID --cap-add SETPCAP --cap-add SETUID --security-opt no-new-privileges \
  ghcr.io/mokshmridul/print-farm:latest
```

## First run

1. **Create the admin password.** The first visit to `/admin` asks for the
   **one-time setup code** printed in the container log
   (`docker logs print-farm 2>&1 | grep "setup code"`) and a new password.
   The code proves you run the container, so nobody who merely finds a fresh
   shop can claim it; it stops working once the password exists.
2. **The setup tour** follows (`/admin/setup`):
   1. **Printer.** Pick it from OrcaSlicer's list — its own machine and
      process presets are set up for you, and the shop restarts with them —
      or drop your own OrcaSlicer printer bundle (`.orca_printer`) or preset
      (`.json`); it uploads and starts its test slice straight away. The tour
      can't move past this step without a printer.
   2. **Process presets.** With your own printer: your 0.12, 0.16 and 0.20 mm
      presets, if the printer bundle didn't bring them.
   3. **Filaments.** Drop your filament presets; each is matched to a material
      from its filament type for you to confirm. No material comes with a
      preset, so at least one is needed.
   4. **Shop details.** Shop name (required), web address, city, quotation
      initials (worked out from the name), WhatsApp, email, phone and address.
3. **Switch on** what you sell in **Filament → Catalog**, and set **Rates**.

*Skip setup — I'll do this later* ends the tour; the dashboard shows "Not
taking quotes yet" until a printer and a material are set up.

## Reverse proxy and HTTPS

Customers need HTTPS: point your reverse proxy at the container's port 8080,
then tell the shop about it in **admin → Settings → Server**:

- **Web address**: what customers type, e.g. `https://print.example.com` (for
  links in quotation PDFs, emails and messages).
- **Reverse proxy**: *on this computer* (SWAG, NPM, Caddy or cloudflared on the
  same machine, reaching the published port — the shop trusts its Docker
  gateway), or *at another address* (another machine, or a proxy container with
  its own IP; give that one IP). The shop then believes only that proxy about
  each visitor's real address; rate limits are per visitor, so without it every
  customer would share one. Choose the header: `X-Real-IP` for nginx-style
  proxies, `CF-Connecting-IP` for a Cloudflare Tunnel. Tick *also open to
  devices on my network* to keep `http://<server>:8080` working on your LAN.

Saving restarts the shop for a few seconds. Your proxy must:

- terminate HTTPS;
- **overwrite** `X-Real-IP` (or, with cloudflared, it sends `CF-Connecting-IP`);
- allow 301 MB request bodies on `/api/uploads` (Cloudflare caps uploads at
  100 MB).

A minimal Caddyfile:

```
print.example.com {
	reverse_proxy 127.0.0.1:8080 {
		header_up X-Real-IP {remote_host}
	}
}
```

On a server reachable from the internet, publish the port on loopback or your
LAN address only (`"127.0.0.1:8080:8080"` in the compose file).

## Settings: where they live

| What | Where | Set in |
| --- | --- | --- |
| Admin password | the database | the first visit; `docker exec -it print-farm print-farm admin-password` |
| Web address, reverse proxy, printer from the list | `data/config/settings.json` | admin → Settings → Server, the setup tour |
| Shop details, rates, materials, email, shipping, GST … | the database | the admin dashboard |
| Your own OrcaSlicer presets | the database (uploads) or `profiles/` | Filament → Slicer profiles, the setup tour, the profiles folder |

Every server setting also has an **environment variable** (`APP_ORIGIN`,
`TRUSTED_PROXY_CIDR`, `REAL_IP_HEADER`, `DIRECT_ACCESS`, `PRINTER_MACHINE`, …,
listed in [`.env.example`](../.env.example) and [ENV.md](ENV.md)). Set one in a
`.env` beside the compose file and it wins; the browser then shows that setting
locked. Nothing needs one.

## Your own materials

Print something that isn't in the built-in list — ABS-CF, PC, PA, PETG-GF…? The
admin dashboard has four slots for your own materials, on every install. In
**Your own materials**:

1. **Name it** the way customers should see it, e.g. *PC-PBT-GF*.
2. **Give it an OrcaSlicer filament profile**, either way:
   - **Start from one of OrcaSlicer's generics** (Generic PC, PA-CF, PPA-GF,
     PETG-CF, TPU…) and enter your filament's **density** from the spool or
     its datasheet. Weight is density × volume, and the generics' own
     densities are often placeholders.
   - **Upload the preset you tuned** in OrcaSlicer (the filament's settings →
     Export → `.json`, or a filament bundle).

   Either way it's **test-sliced** on a 20 mm cube before quotes use it. If
   OrcaSlicer rejects it you see why, and nothing changes.
3. **Switch it on** in **Catalog** and add its colours by name and hex code.
4. **Set its prices** in **Rates**: per gram, its filament cost, and its spool
   cost for profit estimates.

A material can't be switched on until it has a name and a live profile, and
removing its profile takes it off sale by itself. Quotations keep the name a
material had when they were submitted, so renaming one later doesn't change
old quotations.


## Your own printer or profiles (advanced mode)

Is your printer missing from OrcaSlicer's list (a Voron, a modded Ender, a
self-build), or do you slice with profiles you've tuned yourself? Then the shop
slices with your own OrcaSlicer presets, **exactly as OrcaSlicer exports
them**: you never edit a file, you hand it over. Choose *Upload my own* at the
tour's printer step (or *My own OrcaSlicer printer preset* in Settings →
Server), then either:

- **In the browser:** the setup tour, or Filament → Slicer profiles (*Guided
  setup* opens the tour again).
- **A folder on the server:** put the files in `profiles/` next to the compose
  file. The shop picks them up every time it starts.

What to export from OrcaSlicer:

- **Your printer:** *File → Export → Export Preset Bundle → Printer bundle*
  gives an `.orca_printer` file: the printer and its process presets. Its 0.12,
  0.16 and 0.20 mm processes are used for those layer heights.
- **Single presets:** a printer, process or filament preset as `.json`, or a
  filament bundle (`.orca_filament`) holding one filament.

Every preset is **test-sliced** on a 20 mm cube with the rest of your live
presets before quotes use it. If OrcaSlicer rejects it, you see its error
(Filament → Slicer profiles) and quotes keep using what was live.

## No built-in filament presets

The image has no stock filament presets: a material (PLA, PETG, your own …)
can only be switched on once your own OrcaSlicer filament preset for it has
passed its test slice, on every install. Upload them in the setup tour or
Filament → Slicer profiles, or put them in `profiles/filament/`. Remove one and
the material comes off sale by itself.

OrcaSlicer's bundled presets stay inside the image as reference data only:
your exports name one as their parent (`inherits`), and a printer or process
preset is test-sliced with OrcaSlicer's generic PLA when you have no filament
live yet. That reference filament is written only into the throwaway test
set; it is never sold or quoted with.

### The profiles folder

```
profiles/
  printer/    your printer: one .orca_printer bundle (or the printer's .json)
  process/    process presets (.json) — each is used for the layer height it prints at
  filament/   filament presets (.json / .orca_filament) — each goes to the material
              its filament type names: PLA, PLA-CF, PETG, ABS, ASA or TPU
    PLA_AESTHETIC/   …or to the material its folder is named for:
    PETG_PREMIUM/    PLA, PLA_AESTHETIC, PLA_CF, PETG, PETG_PREMIUM, ABS, ASA,
    OTHER_1/         TPU, and your own materials OTHER_1 … OTHER_4
```

Silk, matte and other aesthetic PLAs, carbon-fibre PETG and your own materials
share a filament type with another material, so they go in their material's
folder. After changing anything, restart the shop: `docker compose restart`.

The folder is the source of truth for what it holds:

- a new or changed file is test-sliced and goes live when it passes (until then,
  and if it fails, the previous preset stays live);
- a file you take out puts its slot back on the installed preset;
- slots it fills are marked *from the profiles folder* in the admin page, which
  takes no uploads for them. Everything else can still be uploaded there.

A file the shop can't use (two filaments for the same material, a layer height
it doesn't quote, a preset built on one that isn't there) is listed with the
reason under Filament → Slicer profiles → Recent uploads, and the container
log says so too. Presets in the folder turn advanced mode on by themselves.

`PRINT_PROFILES_DIR` (in a `.env` beside the compose file) moves the folder
elsewhere; the container only ever reads it.

Presets that build on one of OrcaSlicer's own ("inherits") are resolved
against the presets this OrcaSlicer ships. Presets that build on another of
your own need to come in the same bundle, or both sit in the profiles folder.
For safety, post-processing scripts and printer-upload settings in a preset are
dropped.

## Updating

```bash
docker compose pull && docker compose up -d
```

(or let Watchtower do it). When a new version starts, it first **backs up the
database** to `data/backups/before-update-<time>.pgdump` (the five newest are
kept), then migrates it. To go back: pin the previous image in the compose file
(`ghcr.io/mokshmridul/print-farm:sha-<commit>`; every commit on `main` is
published with its own tag), `docker compose up -d`, and restore the backup
taken before the update:

```bash
docker exec -i print-farm print-farm restore < data/backups/before-update-<time>.pgdump
```

## Backups

Back up the whole `data/` folder (and `profiles/`, if you use it) — stop the
container first for a consistent copy, or take a live database dump:

```bash
docker exec print-farm print-farm backup > print.pgdump      # database only
docker exec -i print-farm print-farm restore < print.pgdump   # put it back
```

Admin → Settings → *Backup* downloads your shop settings and presets as one
file, to restore on a fresh shop.

## Where things live

| Path | What it holds |
| --- | --- |
| `data/config/settings.json` | Server settings (web address, reverse proxy, printer from the list). |
| `data/postgres/`, `data/redis/` | The database and queue. Root/service-only. |
| `data/uploads/`, `data/pdfs/` | Customer models, thumbnails and quotation PDFs. |
| `data/printer/` | The printer's generated machine and process presets. |
| `data/secrets/` | Generated database, Redis and session secrets; the setup code until it's used. Root-only. |
| `data/backups/` | Database backups taken before each update. |
| `profiles/` | Your OrcaSlicer exports, if you use the profiles folder. Read-only to the shop. |

Useful commands:

```bash
docker compose ps                                   # is it up (and healthy)?
docker compose logs -f --tail 100                   # all of it: web, worker, database…
docker compose restart                              # restart everything
docker exec print-farm print-farm --help            # maintenance commands
```

## Troubleshooting

- **Lost the setup code.** `docker logs print-farm 2>&1 | grep "setup code"`;
  it's printed on every start until the admin password exists.
- **Forgot the admin password.** `docker exec -it print-farm print-farm admin-password`.
- **Every request gets 403.** The shop only accepts the reverse proxy you told
  it about. Fix it in Settings → Server from a LAN device (with *also open to
  devices on my network*), or delete `data/config/settings.json` and restart.
- **The container keeps restarting.** A startup step failed:
  `docker compose logs --tail 80` shows which.
- **Slices fail on big models.** The slicer needs memory; 8 GB is recommended.
- **`ERR_SSL_PROTOCOL_ERROR`, page unstyled.** You opened the shop at its local
  address after setting an `https://` web address: open it at that address.

## Moving from an installer-based install

Earlier versions were set up with `install.sh`. To switch: stop it
(`docker compose down` in its folder), copy its `data/` folder next to the new
compose file, and start the new one. Your database, uploads and admin password
come across (the password is moved into the database on first start). Settings
the installer kept in `.env` (`APP_ORIGIN`, `TRUSTED_PROXY_CIDR`,
`PRINTER_MACHINE`, API keys) still work if you copy that `.env` too; or set them
in the browser and leave it out (a `TRUSTED_PROXY_CIDR` the installer set to the Docker gateway should become *A reverse proxy on this computer* in Settings → Server, as the network is no longer pinned). Data still in the old `print_data` Docker
volume: `docker run --rm -v print_data:/from -v "$PWD/data":/to alpine cp -a /from/. /to/`.

## For the maintainer

CI publishes `ghcr.io/<repo>:sha-<commit>` and `:latest` after every check on
`main` passes; the package must be **public** for shops to pull it.

- **New settings** belong in the admin dashboard (an `AppSetting`) or, if the
  container itself needs them at start, in the server settings
  (`packages/shared/src/server-settings.ts`), never only in the environment.
- **A new process inside the image** is an s6-rc service in
  `docker/rootfs/etc/s6-overlay/` (and an entry in `user-bundles.d/user/contents.d/`).
- **Bumping OrcaSlicer** changes which printers exist; the image builds its
  list (`/etc/print-farm/printers.tsv`) from its own OrcaSlicer. Shops
  regenerate their printer's profiles when the container starts on a new
  OrcaSlicer version.

## How printer profiles are made

`apps/worker/src/profile-gen.ts` builds a shop's slicing profiles from the
presets OrcaSlicer ships, inside the image, when the container starts with
`PRINTER_MACHINE` set:
- the printer's machine preset
- its 0.12 / 0.16 / 0.20 mm process presets (a missing height is derived from
  the printer's closest one)

and no filament presets: each material needs yours (see
[No built-in filament presets](#no-built-in-filament-presets)).

Everything is flattened (the CLI doesn't resolve `inherits`) and written to
`/data/printer` with a `printer.json` describing the printer, which both
the worker and the website read. There is no built-in printer: without
`PRINTER_MACHINE` the shop takes no quotes until your own OrcaSlicer printer
preset is live (guided setup or the profiles folder).

In advanced mode, presets the owner uploads are stored in the database
(`SlicerProfileUpload`). The worker resolves each upload's `inherits` against
the image's OrcaSlicer presets and cleans it the same way. It then writes the
installed set with the live uploads swapped in to a per-revision directory
under the slicer work root. The revision is part of every slice cache key, so
changed presets never reuse old slices.

The profiles folder goes through the same path. When the worker starts it
reads `/profiles`, places each preset in a slot, and compares every file's
path, SHA-256 and preset name (`sourceKey`) with the rows from the folder
(`source = "folder"`). New and changed presets become test batches like
uploads: the printer and processes in one batch, and each filament in its own
batch, so one bad file holds up only itself. Slots the folder no longer fills
are retired. Presets in a folder batch may build on any other preset in the
folder. A failed folder preset is retried on every start, since what it failed
on may have been fixed. Files that can't be placed are recorded as failed rows,
once per version of the file.
