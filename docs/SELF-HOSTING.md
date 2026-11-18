# Run your own print shop

This site is open source. One command sets up your own copy — your name, your
rates, your materials, your contact details — on a server of your own.

The whole shop is **one Docker image** (`ghcr.io/mokshmridul/print-farm`): the
website, the OrcaSlicer worker, PostgreSQL, Redis and nginx run together in one
container, with everything durable in one volume. The installer below sets it
up for you; you can also [run the image yourself](#run-the-image-yourself).

## What you need

- A Linux server with an **Intel/AMD (x86_64)** CPU. ARM servers (Raspberry Pi,
  Oracle Ampere, AWS Graviton) can't run the slicer. Debian or Ubuntu is easiest.
- **8 GB RAM** (4 GB works for small models), **25 GB free disk**, 2+ CPU cores.
- A **domain name** you control, e.g. `print.example.com`, and something that
  provides HTTPS for it: your own reverse proxy (nginx, Caddy, Nginx Proxy
  Manager, Traefik…) or a Cloudflare Tunnel. The container itself speaks plain
  HTTP. (Not needed to [try it locally](#try-it-locally-first).)
- A **single-nozzle printer with a 0.4 mm nozzle** that OrcaSlicer supports —
  321 of them from 57 brands (Bambu Lab, Prusa, Creality, Voron, Elegoo, Qidi,
  Anycubic, Sovol …). Every quote is sliced with that printer's own profiles.
- The shop is India-focused: prices are in rupees, and live shipping quotes
  use Shiprocket (optional).

Docker is installed for you if it's missing.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/zappymussel380/print.rish.pw/main/install.sh | sudo bash
```

It downloads the code to `/opt/print-shop` (you can pick another folder) and
asks, in plain language, the questions below. Don't worry about getting them
perfect: almost all of it can be changed later, in the admin dashboard or by
running the installer again (see [after that](#after-install)).

1. **Your shop:** name, the initials your quotation numbers start with
   (e.g. `AP-2026-0001`), a one-line tagline, and your city.
2. **Your printer:** pick the brand, then the model (with its build volume),
   and say whether it has an AMS/MMU for automatic multicolour. Using your own
   tuned OrcaSlicer presets? Choose **2) Skip** and upload them in the admin
   dashboard later (see [below](#your-own-printer-or-profiles-advanced-mode)).
3. **Web address:** your domain, and what provides HTTPS in front of the shop
   (see [HTTPS options](#https-options)).
4. **Admin password:** for `https://your-domain/admin`.
5. **Materials and rates:** which materials you print (PLA, Aesthetic PLA,
   PLA-CF, PETG, PETG Premium, ABS, ASA, TPU), the price per gram of each, and your
   setup fee per order.
6. **Materials page:** which materials `/materials` compares for customers.
7. **Contact details:** WhatsApp (every quote hands off to it), email, phone,
   address, and an optional Google Maps embed.
8. **Optional extras:**
   - contact-form email (Resend)
   - live courier prices (Shiprocket)
   - Telegram alerts for new quotes

Then it downloads the image (about 3 GB the first time) and starts it. When
it's done it prints your site and admin addresses.

<a id="after-install"></a>
After that, **the admin dashboard is where you change things**. Its menu has
five pages:

- **Home:** the numbers (revenue, profit, print hours) and every quotation,
  with status changes, PDFs, the model files as a ZIP, and CSV export.
- **Filament:**
  - **Catalog:** which materials, colours and layer heights you offer. ABS and
    ASA start with black and white; add any colour by name and hex code.
  - **Material helper:** "Help me choose" on the quote page. Customers tick
    what matters (looks, strength, heat resistance, outdoor use, or up to four
    needs of your own) and the material you rate best for those is picked for
    them. You rate each material and can switch any need off.
  - **Your own materials:** up to four materials beyond the built-in list, each
    with an OrcaSlicer profile.
  - **Rates:** prices, the setup fee, lead time, and your real filament and
    running costs (for profit estimates).
  - **Slicer profiles**, if you skipped the printer step (see
    [advanced mode](#your-own-printer-or-profiles-advanced-mode)).
- **Site:** shop name, tagline, city, quotation initials, contact details,
  accent colour, footer, the Materials page, and the FAQ.
- **Recent prints:** showcase photos.
- **Settings:** live courier prices on the quote page (Shiprocket): switch them
  on or off, or change the API user and pickup pincode. With them off, the
  quote page has no shipping box and checkout says delivery is arranged after
  the quotation. **Email:** where contact-form messages go, sent through
  Resend or any SMTP server (a Gmail or Zoho app password works), with a
  "Send test email" button. With email off, the contact page shows WhatsApp
  and your details instead of a form. **GST:** switch it on with your rate,
  HSN/SAC code and GSTIN, and it is added on top of printing, setup and
  shipping, with the GSTIN and a GST row on every quotation PDF.
  **File clean-up:** how long uploads, finished quotations' model files and
  finished quotations are kept (or keep quotations for good), and **Purge
  now** to free disk space at once — it deletes only files, never quotations
  or anything still open. Once saved here, these settings replace the ones
  the installer wrote.

The web address, the admin password, the printer, and Telegram change by
running `sudo /opt/print-shop/install.sh` again.

If the first run is interrupted (for example the download fails on a network
blip), just run the command again: it picks up where it stopped.

## Try it locally first

Want to see it working before you put anything online? Choose
**1) Try it on this computer or your home network first** when the installer
asks how people will reach the site. You don't need a domain. It's the complete
site: real slicing, admin dashboard, quotations. The installer then asks who
should be able to open it, and which port to use (press Enter for 8080):

- **Only this computer:** `http://localhost:8080`.
- **Devices on my home network:** `http://<this computer's address>:8080`, for
  example `http://192.168.1.50:8080`. Pick this when the server has no screen
  and you want to open the site on your laptop. The installer finds the
  computer's home-network address (10.x, 172.16–31.x or 192.168.x) and listens
  on that address alone.

Either way nothing on the internet can reach it. The site is plain http,
though, so on the network option anyone on your network can open it and the
admin password travels unencrypted. Use a network you trust.

Already installed on "this computer only"? Update, then switch:
`sudo /opt/print-shop/update.sh`, then `sudo /opt/print-shop/install.sh` →
**2) Change the web address** → **1** → **2) Devices on my home network**.

**Linux:** run the install command as usual.

**Windows 10/11:**
1. Install **WSL2 with Ubuntu** — in PowerShell as administrator: `wsl --install`, then restart.
2. Install **Docker Desktop**, and in *Settings → Resources → WSL integration* switch on your Ubuntu.
3. Open the **Ubuntu** terminal and run the install command there.
4. Open `http://localhost:8080` in your normal Windows browser.

Give WSL enough memory: slicing big models needs several GB (Docker Desktop →
Resources, or a `.wslconfig`). Macs aren't supported, because the slicer only
runs on Intel/AMD Linux.

Happy with it? Run `sudo /opt/print-shop/install.sh`, pick **2) Change the web
address**, and choose one of the options below. Your settings, rates and
quotations come along.

## Your own materials

Print something the installer doesn't list — ABS-CF, PC, PA, PETG-GF…? The
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
self-build), or do you slice with profiles you've tuned yourself? At the
printer question, choose **2) Skip — I'll upload my own tuned OrcaSlicer
presets**. The installer then only asks the printer name customers see (e.g.
*Voron 2.4 300*) and whether it does automatic multicolour. Until you upload,
quotes use a generic Klipper preset, so upload before you share the site.

The admin dashboard then has a **Slicer profiles** section. There you upload
the presets you use in OrcaSlicer:
- **A whole printer:** in OrcaSlicer, *File → Export → Export Preset Bundle →
  Printer bundle* gives an `.orca_printer` file. Upload it on the **Printer**
  row. Its process presets at 0.12, 0.16 and 0.20 mm are used for those layer
  heights; anything else in it is listed as skipped.
- **Single presets:** export a printer, process or filament preset as `.json`
  (or a filament bundle, `.orca_filament`) and upload it on the row it's for:
  a layer height, or a material.

Every upload is **test-sliced** on a 20 mm cube with the rest of your live
presets before it replaces anything. If OrcaSlicer rejects it, you see its
error and quotes keep using what was live. A row you haven't uploaded to uses
the installed generic preset, and **Use installed** puts a row back on it.

Presets that build on one of OrcaSlicer's own ("inherits") are resolved
against the presets this OrcaSlicer ships. Presets that build on another of
your own need to come in the same bundle. For safety, post-processing scripts
and printer-upload settings in a preset are dropped.

## HTTPS options

The shop listens on one port in plain HTTP; HTTPS is always provided in front
of it. The installer offers two ways (plus [local test mode](#try-it-locally-first)):

**2. Your own reverse proxy** (nginx, Caddy, Nginx Proxy Manager, Traefik…).
Your proxy must:

- terminate HTTPS
- **overwrite** `X-Real-IP` and `X-Forwarded-For` with the visitor's IP
- allow 301 MB request bodies on `/api/uploads`

See the nginx example in [DEPLOYMENT.md](DEPLOYMENT.md#4-public-reverse-proxy).
No proxy yet? [Caddy](https://caddyserver.com) installed on the server gets and
renews a Let's Encrypt certificate by itself; this Caddyfile is enough:

```
print.example.com {
	reverse_proxy 127.0.0.1:8080 {
		header_up X-Real-IP {remote_host}
	}
}
```

**3. A Cloudflare Tunnel** (cloudflared). For a server at home or behind a
router, with no open ports. Your domain must use Cloudflare's DNS. Create a
tunnel in **Zero Trust → Networks → Tunnels** (or use one you already run),
install cloudflared as it shows, and add a **public hostname**: your domain →
service **HTTP**, URL `<address>:<port>` (the installer prints it). Cloudflare
caps uploads at 100 MB, so model uploads are limited to 95 MB in this mode.

For both, the installer asks where the proxy or cloudflared runs:

- **On this server, installed directly:** the shop listens on
  `127.0.0.1:<port>`. The connection reaches the container through Docker, so
  the installer pins the shop's Docker network and trusts its gateway address —
  only that one — to tell the shop each visitor's real address.
- **In Docker, or on another computer:** the shop listens on an address of
  this server you choose (never `0.0.0.0`), and you give the **one** IP the
  proxy connects from. Any other machine connecting gets 403. Docker containers
  can't reach the host's `127.0.0.1`.

The real visitor address matters: rate limits are per visitor, so without it
every customer would share one.

Don't put local test mode (option 1) behind a proxy or tunnel. The site then
thinks it lives at `http://localhost:8080`, so links in emails and quotations
point there. Switch with `sudo ./install.sh` → option 2 (web address).

## Run the image yourself

No installer needed: the repository's `docker-compose.yml` is the whole
deployment.

```bash
git clone https://github.com/mokshmridul/print-farm.git && cd print-farm
cp .env.example .env        # set APP_ORIGIN, and the rest as you like
docker compose up -d
docker compose logs | grep -A2 "admin password"    # the generated admin password
```

Or with plain `docker run`:

```bash
docker run -d --name print-farm --restart unless-stopped \
  -p 127.0.0.1:8080:8080 -v print-data:/data \
  -e APP_ORIGIN=https://print.example.com \
  --memory 12g --read-only --tmpfs /run:exec,size=64m --tmpfs /tmp:noexec,size=3g \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add KILL \
  --cap-add SETGID --cap-add SETPCAP --cap-add SETUID --security-opt no-new-privileges \
  ghcr.io/mokshmridul/print-farm:latest
```

Every variable is documented in [`.env.example`](../.env.example) and
[ENV.md](ENV.md). Maintenance commands run inside the container:

```bash
docker exec -it print-farm print-farm admin-password       # new admin password
docker exec print-farm print-farm backup > shop.pgdump      # database backup
docker exec -i print-farm print-farm restore < shop.pgdump  # restore one
docker exec -i print-farm print-farm seed-settings < settings.json
```

## Updating

```bash
sudo /opt/print-shop/update.sh
```

It shows what's new and asks before doing anything. Then it:

1. backs up the database (the last 5 backups are kept in `backups/`)
2. pulls the latest scripts
3. downloads the image published for exactly that version (`:sha-<commit>`)
4. restarts; database migrations run inside the container before the site starts
5. checks the site is healthy

If the new version doesn't come up, it offers to roll straight back. An image
is published a few minutes after each change; until then the update says so
and leaves the site as it is.

| Command | What it does |
| --- | --- |
| `update.sh --yes` | Update without asking. Suitable for a weekly cron job. |
| `update.sh --rebuild` | Re-download and restart even when there is nothing new. |
| `update.sh --rollback` | Go back to the version before the last update. |

Rolling back puts the old scripts and image back, but database migrations only
go forward. If the older version misbehaves after a rollback, `update.sh`
prints the command to restore the backup it took just before updating.

Your settings are never touched by an update. They live in `.env` and the
data volume, not in the code.

### Moving from the old layout

Installs from before the single image ran separate web, worker, database,
Redis, nginx and Caddy containers. The first `update.sh` to this version moves
them over by itself:

- the database is copied across with the backup it takes first (dump and
  restore — the new image runs a newer PostgreSQL);
- uploads and quotation PDFs are copied into the new volume;
- your admin password and session secret carry over in `.env`;
- the old containers are removed, but the **old volumes are kept** — it prints
  the `docker volume rm` command for when you've checked everything is there.

Two of the old ways of reaching the site had HTTPS **inside** the stack, which
the image no longer includes:

- **"Public server" (Caddy).** Install Caddy on the server itself (see the
  Caddyfile [above](#https-options)), then run `sudo ./install.sh` → **2** →
  **2) own reverse proxy** → **1) on this server**, and update.
- **"Cloudflare Tunnel" (the installer's own cloudflared).** Install
  cloudflared on the server with your tunnel's token, point the tunnel's
  public hostname at `http://127.0.0.1:8080`, then `sudo ./install.sh` →
  **2** → **3) Cloudflare Tunnel** → **1) on this server**, and update.

For those two, `update.sh` stops before changing anything and says so.

If the move fails part-way, nothing of the old data is lost: the old volumes
are untouched, and the database backup is in `backups/`. To go back to the old
version, `git -C /opt/print-shop reset --hard <old commit>` (in
`.selfhost/last-update`) and `docker compose up -d` there.

## Changing settings or uninstalling

Run the installer again from the install folder:

```bash
sudo /opt/print-shop/install.sh
```

It offers to:

- restart with the current settings
- change the web address
- change the admin password
- change the optional extras
- change the printer
- start over with new shop settings
- uninstall

Uninstalling removes the container. Your data (database, uploaded models,
quotation PDFs) is only deleted if you confirm twice. Data you keep stays in
Docker even if you delete the install folder.

## Backing up your settings (before a reinstall or a move)

**Admin → Settings → Backup & restore → Download backup** saves one JSON file
with everything you've set up in the admin:

- rates
- catalog and colours
- your own materials and their OrcaSlicer presets
- the material helper
- shop profile
- FAQ
- GST
- file clean-up
- shipping and email

After installing again (or on the new machine), sign in and use **Restore from
file…** on the same card:

- Your own materials' presets are test-sliced again and go live once they pass.
- Passwords and API keys are never in the file, so re-enter the Shiprocket
  password and the email key or password; the restore says which.
- Quotations, uploads and showcase photos aren't in this file. They're in the
  database and the data volume. See [MAINTENANCE.md](MAINTENANCE.md) for backing
  those up.

## Unattended install

Set `PS_UNATTENDED=1` and answer every question with a variable. With `sudo`,
put the variables after `sudo`, or they are dropped:

```bash
curl -fsSL https://raw.githubusercontent.com/zappymussel380/print.rish.pw/main/install.sh | sudo \
  PS_UNATTENDED=1 PS_DIR=/opt/print-shop \
  PS_BRAND="Acme Prints" PS_CITY=Pune PS_DOMAIN=print.acme.in PS_MODE_CHOICE=2 \
  PS_ADMIN_PASSWORD='a long admin password' PS_MATERIALS=1,4,6 PS_SETUP_FEE=120 \
  PS_RATE_PLA=2 PS_RATE_PETG=2.5 PS_RATE_ABS=3 PS_WHATSAPP=919876543210 bash
```

| Variable | Question |
| --- | --- |
| `PS_DIR`, `PS_BRANCH`, `PS_REPO` | Install folder (`/opt/print-shop`), branch (`main`), repository |
| `PS_IMAGE_REPO` | Image repository to pull from (default `ghcr.io/mokshmridul/print-farm`) |
| `PS_BUILD` | `1` builds the image on this server from the checkout instead of downloading it (10–25 minutes) |
| `PS_BRAND`, `PS_TAGLINE`, `PS_CITY` | Shop name, tagline, city |
| `PS_QUOTE_PREFIX` | Quotation-number initials, 2–5 letters (default: the shop name's initials) |
| `PS_PRINTER_SETUP` | `1` a printer from OrcaSlicer's list (default), `2` skip — your own presets, uploaded in the admin dashboard |
| `PS_PRINTER` | Printer: the exact OrcaSlicer preset, e.g. `Prusa MK4 0.4 nozzle` (list: `docker/selfhost/printers.tsv`, 3rd column). With `PS_PRINTER_SETUP=2`, optional: the preset quotes use until you upload yours |
| `PS_PRINTER_BASE` | With `PS_PRINTER_SETUP=2` and no `PS_PRINTER`, optional: `1` generic Klipper (default), `2` Marlin, `3` RepRapFirmware, `4` Repetier |
| `PS_PRINTER_NAME` | With `PS_PRINTER_SETUP=2`: the printer name customers see (default "3D printer") |
| `PS_CONFIRM_MULTI_MATERIAL` | `y` if the printer has an AMS/MMU for automatic multicolour |
| `PS_DOMAIN` | Domain name (not needed for local test mode) |
| `PS_MODE_CHOICE` | `1` local test (no domain needed), `2` own reverse proxy, `3` Cloudflare Tunnel |
| `PS_PROXY_PORT` | Port the shop listens on (default 8080) |
| `PS_LOCAL_ACCESS` | Local test mode: `computer` (default when unattended) or `network` for the devices on your home network |
| `PS_LOCAL_ADDRESS` | With `PS_LOCAL_ACCESS=network`, optional: which of this computer's private addresses to use (default: the one its default route uses) |
| `PS_FORWARDER_ACCESS` | Modes 2 and 3: `host` (proxy/cloudflared installed on this server, default) or `other` (in Docker or on another computer) |
| `PS_PROXY_BIND`, `PS_PROXY_IP` | With `PS_FORWARDER_ACCESS=other`: the address of this server to listen on, and the one IP the proxy connects from |
| `PS_ADMIN_PASSWORD` | Admin password (12–72 characters) |
| `PS_MATERIALS` | Materials offered, by number: 1 PLA, 2 Aesthetic PLA, 3 PLA-CF, 4 PETG, 5 PETG Premium, 6 ABS, 7 ASA, 8 TPU |
| `PS_SETUP_FEE`, `PS_RATE_<ID>` | Setup fee and per-gram rate in ₹, e.g. `PS_RATE_PLA_CF=3.5` |
| `PS_MATERIALS_PAGE` | Materials on `/materials`, by number (defaults to those offered) |
| `PS_WHATSAPP`, `PS_EMAIL`, `PS_PHONE`, `PS_ADDRESS`, `PS_MAPS_URL` | Contact details |
| `PS_CONFIRM_RESEND` + `PS_RESEND_KEY`, `PS_MAIL_TO`, `PS_CONTACT_FROM_EMAIL` | Contact-form email |
| `PS_CONFIRM_SHIPROCKET` + `PS_SHIPROCKET_EMAIL`, `PS_SHIPROCKET_PASSWORD`, `PS_PINCODE` | Shiprocket |
| `PS_CONFIRM_TELEGRAM` + `PS_TELEGRAM_TOKEN`, `PS_TELEGRAM_CHAT` | Telegram alerts |
| `PS_EXISTING_DATA` | Only asked when the server still has the data volume of an earlier install: `keep` (default) or `delete` (also needs `PS_CONFIRM_DELETE_TEXT=DELETE`) |

## Where things live

| Path | What it holds |
| --- | --- |
| `.env` | Web address, admin password hash, API keys and printer choice. Private (`chmod 600`); back it up. |
| `.selfhost/` | Update state. |
| `backups/` | Database backups taken before each update. |
| Docker volume `print_data` | Everything else: database, Redis, uploads, quotation PDFs, the generated database/session secrets (`secrets/`) and printer profiles. It stays when the install folder is deleted. |

Useful commands, run from the install folder:

```bash
docker compose ps                                   # is it up (and healthy)?
docker compose logs -f --tail 100                   # all of it: web, worker, database…
docker compose logs | grep '\[worker\]\|"msg"'       # roughly, just the app
docker compose restart                              # restart everything
docker compose exec print-farm print-farm --help    # maintenance commands
```

## Troubleshooting

- **"Port … is already in use".** Something else listens there; pick another
  port when the installer asks.
- **The site isn't reachable over HTTPS.** That's your proxy or tunnel: check
  it forwards to the address the installer printed. `curl http://127.0.0.1:8080/api/health`
  on the server (or your port) tells you whether the shop itself is up.
- **Every request gets 403.** Only the one trusted forwarder may connect
  (`TRUSTED_PROXY_CIDR` in `.env`). If your proxy moved, run `sudo ./install.sh`
  → option 2 again.
- **The container keeps restarting.** A startup step failed:
  `docker compose logs --tail 80` shows which. A bad `PRINTER_MACHINE` (not an
  exact OrcaSlicer preset name) is the usual one.
- **Slices fail on big models.** The slicer needs memory; 8 GB is recommended.
- **Uploads over 95 MB fail with a tunnel.** That is Cloudflare's limit.
- **`ERR_SSL_PROTOCOL_ERROR` in the browser console, page unstyled.** You
  opened the site at its local address (`http://192.168.x.x:8080` or
  `http://localhost:8080`) after setting it up for a domain. The site tells
  the browser to fetch everything over HTTPS, and that port only speaks plain
  HTTP. Open it at `https://<your domain>` instead; signing in to admin only
  works there too. If the domain itself shows Cloudflare's 502 page, check the
  tunnel's public hostname: service type must be **HTTP**, not HTTPS.
- **"The image for … isn't available yet".** Each version's image is published
  a few minutes after it lands; run the update again later.

## For the maintainer: shipping updates to self-hosters

`update.sh` tracks `main`. Whatever is merged there is what every self-hosted
shop gets on its next update: CI publishes `ghcr.io/<repo>:sha-<commit>` (and
`:latest`) after every check passes, and `update.sh` pulls the image matching
the commit it just checked out. The package must be **public** on GHCR for
installs to pull it without logging in.

- **A new required env var** needs a default in `apply_env_defaults`
  (`scripts/selfhost/lib.sh`). Existing installs get it on their next update.
- **A new process inside the image** is an s6-rc service in
  `docker/rootfs/etc/s6-overlay/` (and an entry in `user-bundles.d/user/contents.d/`).
- **`update.sh --after-pull`** is the interface between an installed updater
  and the one it just pulled. Keep it working.
- **New settings** that shops should set belong in the admin dashboard (an
  `AppSetting`), not in `.env`.
- **Bumping OrcaSlicer** changes which printers exist. Regenerate the list
  the installer offers from the new image, and commit it:
  `docker run --rm --entrypoint node <image> /app/worker/dist/profile-gen.js list > docker/selfhost/printers.tsv`.
  Installed shops regenerate their printer's profiles when the container starts
  on a new OrcaSlicer version.

## How printer profiles are made

`apps/worker/src/profile-gen.ts` builds a shop's slicing profiles from the
presets OrcaSlicer ships, inside the image, when the container starts with
`PRINTER_MACHINE` set:
- the printer's machine preset
- its 0.12 / 0.16 / 0.20 mm process presets (a missing height is derived from
  the printer's closest one)
- one filament preset per material tier: the printer vendor's own "Generic"
  preset where it has one, otherwise OrcaSlicer's universal library

Everything is flattened (the CLI doesn't resolve `inherits`) and written to
`/data/printer` with a `printer.json` describing the printer, which both
the worker and the website read. The Bambu Lab A1 keeps the hand-tuned
Numakers profiles print.rish.pw uses.

In advanced mode, presets the owner uploads are stored in the database
(`SlicerProfileUpload`). The worker resolves each upload's `inherits` against
the image's OrcaSlicer presets and cleans it the same way. It then writes the
installed set with the live uploads swapped in to a per-revision directory
under the slicer work root. The revision is part of every slice cache key, so
changed presets never reuse old slices.
