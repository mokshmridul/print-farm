// Prisma 7 removed `url` from the datasource block, so Migrate reads the
// connection string from here instead. The runtime gets it separately, through
// the driver adapter in src/index.ts.
//
// Deliberately .mjs rather than .ts: the image's migrate package is a production-only
// `pnpm deploy` of this package and carries no TypeScript, and the config
// loader supports .mjs natively.
//
// `schema` is relative to the directory the CLI runs in, and resolves in both
// places that matter — the workspace (cwd `packages/db`) and the image's
// migrate step (cwd `/opt/migrate`, the `pnpm deploy` of this package that
// docker/Dockerfile copies in).
import { defineConfig } from "@prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
