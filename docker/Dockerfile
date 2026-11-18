# syntax=docker/dockerfile:1.7
#
# print-farm: the whole print shop in one image.
#
#   docker run -d --name print-farm -p 127.0.0.1:8080:8080 \
#     -e APP_ORIGIN=https://print.example.com -v print-data:/data \
#     ghcr.io/mokshmridul/print-farm:latest
#
# One container runs, under the s6-overlay supervisor:
#   init      first-boot secrets, data-dir ownership, nginx/redis config, printer profiles
#   postgres  PostgreSQL (127.0.0.1 only), data in /data/postgres
#   redis     Redis (127.0.0.1 only, password-protected), data in /data/redis
#   migrate   prisma migrate deploy + least-privilege runtime roles, then exits
#   web       Next.js as the unprivileged nextjs user, on 127.0.0.1:3000
#   worker    BullMQ slicing worker (root orchestrator; every OrcaSlicer and
#             parse job is dropped to its own credential-free uid)
#   nginx     the only listener visible outside: :8080, plain HTTP
#
# HTTPS is always provided in front of this container (your reverse proxy,
# Cloudflare Tunnel, ...). See docs/SELF-HOSTING.md and docs/DEPLOYMENT.md.
#
# Base is ubuntu:26.04 to match the glibc/webkit the upstream OrcaSlicer
# AppImage is built against; the AppImage is extracted at build time because
# FUSE is unavailable inside containers.

# Base images are written out on every FROM (not through an ARG) so Dependabot
# can see and bump them; keep the ubuntu digests identical.

# ---------- node runtime + build base ----------
FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS node-runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ---------- OrcaSlicer: fetch + extract ----------
# Upstream publishes no 26.04 AppImage; the Ubuntu2404 build is what ships, and
# it runs on this base (verified by an image-level slice of a real STL). Keep
# the AppImage name pinned to 2404 even as the base moves forward.
FROM ubuntu:26.04@sha256:678c6550cc43645e08669028bc177f50be4e7c5b8cca677067b1914d4afc7a03 AS orca
ARG ORCA_VERSION=2.5.1
ARG ORCA_SHA256=073b8105c928356141db0ddbce88b81d52c7a9e2442f9baae0a9089c89ff04eb
ADD https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v${ORCA_VERSION}/OrcaSlicer_Linux_AppImage_Ubuntu2404_V${ORCA_VERSION}.AppImage /tmp/orca.AppImage
# The headless worker never opens Orca's bundled GUI guide/include pages. Their
# Swiper 7 copy is affected by GHSA-hmx5-qpq5-p643; remove the unused JavaScript
# instead of carrying an exploitable package into the runtime. (2.5 no longer
# ships the guide/ copy; the path stays listed in case a release brings it back.)
RUN echo "${ORCA_SHA256}  /tmp/orca.AppImage" | sha256sum -c - \
    && chmod +x /tmp/orca.AppImage \
    && cd /tmp \
    && /tmp/orca.AppImage --appimage-extract >/dev/null \
    && rm -rf /tmp/squashfs-root/resources/web/guide/swiper \
        /tmp/squashfs-root/resources/web/include/swiper \
    && mv /tmp/squashfs-root /opt/orca \
    # Orca runs as a per-job sandbox uid, never as the owner of these files. 2.5
    # extracts ~400 directories (lib/, libexec/ with the AppRun helper, usr/…) as
    # 0700 root, so every real slice failed with "Permission denied" while a
    # root-run check passed. Make the tree world-readable, nothing writable.
    && chmod -R u+rwX,go+rX,go-w /opt/orca \
    && rm /tmp/orca.AppImage

# Since 2.5 the AppImage carries its system presets only as compiled per-vendor
# caches (resources/profiles/<vendor>.opc). Profile generation for a shop's
# printer and resolving an uploaded preset's `inherits`/`include` read them as
# JSON, so take the very presets those caches were built from: the release
# tag's resources/profiles, pinned by commit. ORCA_SOURCE_COMMIT must be the
# commit of tag v${ORCA_VERSION}; the check below fails the build otherwise.
ARG ORCA_SOURCE_COMMIT=eef7710cb102fdb51a9bcdbd9efd61047f44774a
ADD https://github.com/OrcaSlicer/OrcaSlicer.git#${ORCA_SOURCE_COMMIT}:resources/profiles /tmp/orca-profiles
# Keep only the preset JSON (covers, bed models and textures stay in /opt/orca),
# and require every compiled cache to match its JSON's vendor version. The
# cache header is "ZCRO", then little-endian u64 fields: at byte 24 the vendor
# name's length and the name, then the version's length and the version, which
# OrcaSlicer writes with four parts ("03.00.13" in re3D.json is "3.0.0.13").
# So compare the nonzero parts, which survive that either way.
RUN set -e; \
    find /tmp/orca-profiles -type f ! -name '*.json' -delete; \
    nonzero() { tr '.' '\n' | sed 's/^0*//' | grep . | paste -sd. -; }; \
    checked=0; \
    for opc in /opt/orca/resources/profiles/*.opc; do \
        vendor=$(basename "$opc" .opc); \
        json="/tmp/orca-profiles/$vendor.json"; \
        [ -f "$json" ] || { echo "FATAL: no JSON presets for $vendor" >&2; exit 1; }; \
        [ "$(head -c 4 "$opc")" = ZCRO ] || { echo "FATAL: $opc is not an OrcaSlicer preset cache" >&2; exit 1; }; \
        name_len=$(od -An -tu8 -j 24 -N 8 "$opc" | tr -d ' '); \
        ver_len=$(od -An -tu8 -j $((32 + name_len)) -N 8 "$opc" | tr -d ' '); \
        cached=$(dd if="$opc" bs=1 skip=$((40 + name_len)) count="$ver_len" 2>/dev/null); \
        shipped=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[0-9.]+"' "$json" | head -n1 | grep -oE '[0-9][0-9.]*'); \
        [ -n "$shipped" ] && [ "$(printf '%s' "$shipped" | nonzero)" = "$(printf '%s' "$cached" | nonzero)" ] \
            || { echo "FATAL: $vendor presets are $shipped, its OrcaSlicer cache $cached: ORCA_SOURCE_COMMIT is not v${ORCA_VERSION}" >&2; exit 1; }; \
        checked=$((checked + 1)); \
    done; \
    [ "$checked" -gt 0 ] || { echo "FATAL: no OrcaSlicer preset caches found" >&2; exit 1; }; \
    echo "OrcaSlicer presets: $checked vendors match their caches"; \
    mv /tmp/orca-profiles /opt/orca-profiles; \
    chmod -R u+rwX,go+rX,go-w /opt/orca-profiles

# ---------- s6-overlay: the process supervisor ----------
FROM ubuntu:26.04@sha256:678c6550cc43645e08669028bc177f50be4e7c5b8cca677067b1914d4afc7a03 AS s6
ARG S6_OVERLAY_VERSION=3.2.3.2
ADD --checksum=sha256:5379750ed30a84bbd2e2dd74847ba6b5bd29cd0b2e3ea2ec58049b57eb2eda12 \
    https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz /tmp/
ADD --checksum=sha256:e6befcc96a437a3831386ecfc51808c5d3e939dc5fe3c02ae9284599e8aa2408 \
    https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz /tmp/
RUN apt-get update && apt-get install -y --no-install-recommends xz-utils \
    && mkdir /s6root \
    && tar -C /s6root -Jxpf /tmp/s6-overlay-noarch.tar.xz \
    && tar -C /s6root -Jxpf /tmp/s6-overlay-x86_64.tar.xz

# ---------- build: web (Next standalone), worker bundle, migrations, tools ----------
FROM node-runtime AS build
RUN corepack enable && corepack prepare pnpm@11.12.0 --activate
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/geometry/package.json packages/geometry/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter "@print/web..." --filter "@print/worker..."
COPY packages ./packages
COPY apps/web ./apps/web
COPY apps/worker ./apps/worker
# The DB package has no local-workspace runtime dependency. Keep the proven
# pnpm 9 deploy layout without globally injecting workspace packages into
# development installs.
RUN pnpm --filter @print/db generate \
    && pnpm --filter @print/web build \
    && pnpm --filter @print/worker build \
    && pnpm --filter @print/db deploy --legacy /opt/migrate \
    && pnpm --filter @print/worker deploy --legacy --prod /opt/worker-app \
    && find /opt/worker-app -type f \( -name '*.test.ts' -o -name '*.test.js' \) -delete \
    && rm -rf /opt/worker-app/test-fixtures /opt/worker-app/src /opt/worker-app/build.mjs
# Admin-password hashing with the lockfile's own bcryptjs — the library the
# login route verifies with. Next bundles it into the server, so the standalone
# output has no importable copy; bundle the helper into one self-contained file.
RUN cd apps/worker && ./node_modules/.bin/esbuild ../web/scripts/hash-password.mjs \
        --bundle --platform=node --format=esm --target=node24 \
        --outfile=/opt/tools/hash-password.mjs

# ---------- runtime ----------
FROM ubuntu:26.04@sha256:678c6550cc43645e08669028bc177f50be4e7c5b8cca677067b1914d4afc7a03

ARG ORCA_VERSION=2.5.1
ENV ORCA_VERSION=${ORCA_VERSION} \
    NODE_ENV=production \
    DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    PATH=/command:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    # Stop the container when any startup step (init, migrations) fails instead
    # of serving a half-started shop.
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    # Migrations on a large database and the first printer-profile generation
    # can take a while; never time out startup.
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0 \
    # Let PostgreSQL finish a fast shutdown before anything is killed.
    S6_KILL_GRACETIME=10000 \
    S6_SERVICES_GRACETIME=20000 \
    S6_VERBOSITY=1

# OrcaSlicer runtime dependencies (GUI toolkit links even in CLI mode) + xvfb
# for the virtual display; OpenCASCADE's DRAW harness (occt-draw) for STEP→STL
# conversion in the parse sandbox; PostgreSQL, Redis and nginx for the stack.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        xvfb \
        libgl1 \
        libegl1 \
        libglu1-mesa \
        libgtk-3-0 \
        libwebkit2gtk-4.1-0 \
        libgstreamer1.0-0 \
        libgstreamer-plugins-base1.0-0 \
        locales \
        occt-draw \
        openssl \
        util-linux \
        postgresql \
        postgresql-client \
        redis-server \
        redis-tools \
        nginx \
    && rm -rf /var/lib/apt/lists/* \
    # The package creates and would manage a default cluster; this image runs
    # its own, in /data/postgres.
    && pg_lsclusters -h | awk '{print $1, $2}' | while read -r ver name; do pg_dropcluster "$ver" "$name"; done \
    && rm -f /etc/nginx/sites-enabled/default \
    && sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
    # DRAW dlopens its plugins by unversioned soname (libTKXSDRAW.so, ...), but
    # Ubuntu ships those symlinks only in the -dev packages. The versioned
    # suffix tracks the OpenCASCADE release — .so.7 under 24.04's OCCT 7.6,
    # .so.7.9 under 26.04's 7.9.2 — so derive the target rather than hardcode
    # it. A hardcoded suffix that matches nothing is not caught by the shell:
    # the unexpanded pattern is passed through literally and `ln -sf` happily
    # creates a dangling link named "libTK*.so", so the image builds green and
    # STEP conversion fails only at runtime. Assert instead.
    && linked=0 \
    && for f in /usr/lib/x86_64-linux-gnu/libTK*.so.*; do \
           [ -e "$f" ] || continue; \
           target="${f%%.so.*}.so"; \
           [ -e "$target" ] || ln -sf "$f" "$target"; \
           linked=$((linked + 1)); \
       done \
    && if [ "$linked" -eq 0 ] || [ ! -e /usr/lib/x86_64-linux-gnu/libTKXSDRAW.so ]; then \
           echo "FATAL: OpenCASCADE plugin symlinks missing; STEP conversion would break" >&2; \
           exit 1; \
       fi

# Copy the official Node image runtime instead of executing a remote repository
# setup script. npm/Corepack/pnpm are build-time tools only: removing them
# eliminates their archive/config parsers and associated advisory surface.
COPY --from=node-runtime /usr/local /usr/local
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=s6 /s6root/ /
COPY --from=orca /opt/orca /opt/orca
COPY --from=orca /opt/orca-profiles /opt/orca-profiles

# uid/gid 1001 owns the durable files (uploads, thumbnails, PDFs): the web runs
# as it and the worker's STORAGE_UID/GID point at it. Slicer and parser jobs
# get their own uids (1002+, 1003) and gids (3000+, 3100) at run time.
RUN groupadd -g 1001 nextjs \
    && useradd -M -d /nonexistent -s /usr/sbin/nologin -u 1001 -g 1001 nextjs

WORKDIR /app
# Next standalone bundle (monorepo layout: server.js lives at apps/web/server.js).
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /opt/worker-app ./worker
# The schema and migrations arrive inside the deployed package itself, which is
# also where migrate runs `prisma migrate deploy` from.
COPY --from=build /opt/migrate /opt/migrate
COPY --from=build /opt/tools /opt/tools
COPY apps/web/scripts/validate-env.mjs \
     apps/web/scripts/provision-database.mjs \
     apps/web/scripts/seed-settings.mjs \
     /app/scripts/
COPY docker/proxy/nginx.conf /usr/local/lib/print-farm/nginx-site.conf.template
COPY docker/rootfs/ /
ARG VERSION=dev
ARG REVISION=unknown
RUN chmod 0755 /usr/local/bin/print-farm /usr/local/lib/print-farm/*.sh \
    && find /etc/s6-overlay/s6-rc.d -name run -exec chmod 0755 {} + \
    && printf 'print-farm %s (%s)\n' "${VERSION}" "${REVISION}" > /etc/print-farm/version \
    && mkdir -p /data

LABEL org.opencontainers.image.title="print-farm" \
      org.opencontainers.image.description="Instant 3D-printing quotation system: web, slicing worker, PostgreSQL, Redis and nginx in one image" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

# Everything durable: database, Redis, uploads, PDFs, generated secrets and
# printer profiles. Back it up as one unit (docs/MAINTENANCE.md).
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=10s --start-period=180s --retries=5 \
    CMD ["/usr/local/bin/print-farm", "health"]
ENTRYPOINT ["/init"]
