import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    // Keep the ordinary workspace test command service-free. Real Postgres /
    // Redis tests have their own config and are invoked explicitly in CI.
    include: ["test/**/*.test.ts"],
    // A configured printer (the hand-written test set): without one the shop
    // takes no quotes and every customer route answers SHOP_NOT_READY.
    env: { PRINTER_SPEC_FILE: `${root}/../worker/test-fixtures/profile-set/printer.json` },
    coverage: { provider: "v8", reporter: ["text"] },
  },
  resolve: {
    // Mirror the tsconfig `@/*` → `./*` alias. A regex with a `/` boundary is
    // used deliberately so it rewrites `@/lib/x` but leaves workspace scopes
    // like `@print/db` untouched.
    alias: [{ find: /^@\//, replacement: `${root}/` }],
  },
});
