import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // The printer's profile set, as the image generates it into /data/printer:
    // a stock OrcaSlicer Prusa MK4 set (profile-gen.ts), nothing hand-tuned.
    env: { PROFILES_DIR: `${root}/test-fixtures/profile-set` },
  },
});
