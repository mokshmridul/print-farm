# Deployment

Production is one container — the print-farm image — behind one public reverse
proxy. The edge terminates TLS and reaches the container's port 8080 only over
a private/LAN/Tailscale route.

```text
Internet -> public reverse proxy (TLS) -> private route -> :8080 print-farm container
                                                            nginx -> web (127.0.0.1:3000)
                                                            worker, PostgreSQL, Redis (127.0.0.1 only)
```

Inside, the s6-overlay supervisor starts `init` (data-dir ownership, first-boot
secrets, rendered configs, printer profiles), PostgreSQL, Redis, a one-shot
`migrate` (Prisma migrations + least-privilege roles), then the web, the worker
and nginx. If `init` or `migrate` fails, the container stops instead of serving
a half-started shop. See [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. Prerequisites

- Docker Engine and Docker Compose v2
- This repository checked out (for `docker-compose.yml`; the image itself comes
  from `ghcr.io/mokshmridul/print-farm`)
- DNS pointing at the public reverse proxy
- A valid TLS certificate at that proxy
- Encrypted off-host backup storage

## 2. Configure

```bash
cp .env.example .env
chmod 0600 .env
```

There are no database or Redis passwords to generate: the container creates
them on first boot (64 hex characters each, from `openssl rand`) and keeps them
root-only in `/data/secrets`, along with the session secret. The web role, the
worker role and the schema owner each get their own.

Set:

- `APP_ORIGIN=https://print.example.com`
- `PRINT_PORT` to `<private host address>:8080`, the address reached by the
  edge, never all interfaces on a public server
- `TRUSTED_PROXY_CIDR` to the exact source host seen from inside the
  container: one IPv4 address (no prefix or `/32`) or unbracketed IPv6 address
  (no prefix or `/128`). Docker preserves the source address of traffic arriving
  on a non-loopback published address; a proxy on the same host using a loopback bind
  appears as the Docker network's gateway instead.
- the admin login: neither `ADMIN_PASSWORD` nor `ADMIN_PASSWORD_HASH`, and
  create it on the first visit with the setup code from the logs; or pin one of
  them (a hash in single quotes)
- optional provider/business values documented in [ENV.md](ENV.md)

Moving an existing deployment here? Pin its `SESSION_SECRET` in `.env` (admin
settings sealed with it stay readable) and see [MAINTENANCE.md](MAINTENANCE.md#moving-an-existing-database-in)
for the database.

## 3. Start

```bash
docker compose config --quiet
docker compose pull            # or: docker compose build
docker compose up -d
docker compose ps              # wait for "healthy"
docker compose logs --tail 80
```

The renderer validates `TRUSTED_PROXY_CIDR` before nginx starts and refuses
broad prefixes, hostnames, lists, malformed addresses and configuration
metacharacters; the container then stops with the reason in its log. Empty, no
forwarder is trusted: every peer is served as itself. That suits a local test,
never production behind a proxy, where every visitor would share the proxy's
rate limits.

Migrations and role provisioning run on every start, before web and worker.
To rerun them deliberately (after restoring a dump, say), restart the
container, or use `print-farm restore`, which re-provisions by itself.

The image is large because it includes OrcaSlicer. For encrypted bind-mounted
storage, include `docker-compose.vault.yml` as described in
[STORAGE_VAULT_LXC.md](STORAGE_VAULT_LXC.md).

Check health from inside the container, where the transport allowlist does not
apply:

```bash
docker compose exec print-farm print-farm health && echo healthy
```

After the outer edge is configured, also verify the complete trusted path with
`curl --fail --silent --show-error https://print.example.com/api/health`. A host-side
curl to the private bind may correctly receive 403 because the container's
nginx accepts HTTP only from `TRUSTED_PROXY_CIDR`.

## 4. Public reverse proxy

There must be only one public ingress. Firewall port 8080 so only that
exact proxy host can reach it. The outer edge must redirect HTTP, terminate TLS,
**overwrite** (not append or preserve) `X-Real-IP` and `X-Forwarded-For` with the
TCP client's address, set the original scheme, omit query strings and referrers
from logs, and grant the large body allowance only to the exact upload endpoint.
The container's nginx independently overwrites both IP headers before they reach
the application and returns 403 to any transport peer other than the configured
outer edge host. The firewall remains mandatory as the first boundary.

### Plain nginx example

```nginx
log_format print_no_args '$remote_addr - $remote_user [$time_local] '
                         '"$request_method $uri $server_protocol" $status $body_bytes_sent '
                         '"-" "$http_user_agent"';

server {
    listen 80;
    server_name print.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name print.example.com;
    # ssl_certificate / ssl_certificate_key managed by your ACME client

    access_log /var/log/nginx/print.access.log print_no_args;
    # Routine nginx errors can include the full request target/query. Preserve
    # only critical events; use service health and application logs for diagnosis.
    error_log /var/log/nginx/print.error.log crit;
    add_header Strict-Transport-Security "max-age=31536000" always;
    server_tokens off;

    # Small by default. Upload is the sole exception below.
    client_max_body_size 64k;
    client_body_timeout 15s;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;

    location = /api/uploads {
        client_max_body_size 301m;
        client_body_timeout 120s;
        proxy_request_buffering off;
        proxy_pass http://<PROXY_BIND_ADDRESS>:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Connection "";
    }

    location / {
        proxy_pass http://<PROXY_BIND_ADDRESS>:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Connection "";
    }
}
```

Using `$uri` rather than `$request_uri` prevents customer search values and
other sensitive query data from entering access logs. Do not add
`$http_referer` to this vhost's log format. Nginx error messages can contain
the complete request target, so the example records only `crit` and higher;
this trades routine proxy warnings for
query privacy. Use web logs, edge health, and `docker compose ps` for ordinary
diagnosis. Keep the 301 MiB streaming exception exact; granting it to `/` lets
small JSON endpoints become buffering/slow-body targets at the edge.

### Nginx Proxy Manager

- Enable Let's Encrypt, Force SSL, HTTP/2, HSTS, and Block Common Exploits.
- Set the default advanced body limit to `64k` and body timeout to `15s`.
- Add an exact custom location `/api/uploads` with `client_max_body_size 301m`,
  `client_body_timeout 120s`, and `proxy_request_buffering off`.
- Configure an access log that excludes query strings and referrers, or disable
  access logging for this host if NPM cannot provide a safe format.
- Suppress request-level error logging (retain only critical events) if NPM's
  error format includes full request targets. This reduces proxy diagnostics but
  prevents legacy query capabilities or PII entering error logs.
- Confirm NPM's generated location overwrites both `X-Real-IP` and
  `X-Forwarded-For` with `$remote_addr`; it must not pass a browser-supplied
  forwarding chain through unchanged.
- Set `TRUSTED_PROXY_CIDR` and the port-8080 firewall allowlist to the one NPM
  source host as observed by the container.

### Verify the proxy trust cutover

Perform this before opening production traffic:

1. Firewall port 8080 to the expected outer edge source first. Do not temporarily
   expose it publicly to discover the source address. Set the expected exact host
   in `TRUSTED_PROXY_CIDR`; if NAT makes it uncertain, use a deliberately
   nonmatching host such as `127.0.0.1` for this short discovery window.
2. Send a request with a unique path through the outer edge. A wrong provisional
   value safely returns 403 but still writes an access entry. Inspect
   `docker compose logs`: each nginx line records `peer=<transport>` and
   `client=<adopted browser>`, without query strings or referrers. Set
   `TRUSTED_PROXY_CIDR` to that exact `peer` host and recreate the container
   with `docker compose up -d`.
3. Request through the edge from two known client networks. Their log entries
   must have the same expected `peer` but distinct, correct `client` addresses.
   If `peer` and `client` remain identical, the trusted host is wrong or the
   outer edge did not overwrite `X-Real-IP`.
4. From the trusted edge host only, make a direct probe to port 8080 with a
   reserved test address such as `X-Real-IP: 192.0.2.123`; the container log should
   show the edge as `peer` and the marker as `client`. Then confirm a non-edge
   host cannot connect to port 8080 at all. If a controlled firewall test does
   let that host connect, the container's nginx must return 403 without proxying it.

Trust a NAT/subnet-router address only when the firewall guarantees that other
clients sharing that source cannot reach port 8080. The validator intentionally
does not permit trusting an entire Docker, LAN, or tailnet subnet.

For local-only routing use a separate LAN name or split DNS. Do not create a
second publicly reachable path to port 8080.

## 5. Operations

```bash
docker compose logs -f --tail 100
docker compose restart
docker compose pull && docker compose up -d     # new image
docker compose exec -T print-farm print-farm backup > print.pgdump
```

Review migration SQL, image-digest updates, CI scans, backups, and the Orca
smoke gate before deploying. See [MAINTENANCE.md](MAINTENANCE.md) and
[SECURITY.md](SECURITY.md).

Only the container's nginx listens outside it. PostgreSQL, Redis and the web
listen on 127.0.0.1 inside the container, each password-protected; the web and
worker connect with separate least-privilege database roles.
