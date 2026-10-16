import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * The unit suite never touches a database, a network, or the real storage
 * directory. Two things are needed to keep that true:
 *
 * 1. `lib/env.ts` throws at import time if DATABASE_URL is missing, and
 *    `lib/tokens.ts` imports it - so on a machine with a `.env` the suite
 *    passed, and on a fresh clone (or a CI runner, where there is no `.env`)
 *    it died before the first assertion. A placeholder satisfies the check.
 *    Nothing in the suite opens a connection, so it never has to resolve;
 *    the hostname says so out loud.
 *
 * 2. `lib/storage.ts` resolves its root from STORAGE_DIR once, at import.
 *    Without an override here the storage tests would read and write
 *    `backend/storage/` - the real uploaded documents and signatures.
 *
 * `dotenv` does not overwrite variables that are already set, so these win
 * over a developer's `.env` rather than the other way round.
 */
export default defineConfig({
  test: {
    /*
     * Longer than vitest's 5s default, because a good part of this suite
     * draws real PDFs.
     *
     * Every render embeds four subset fonts and a logo before it draws
     * anything, which is tens of milliseconds of work each and adds up across
     * a file. On an idle machine that fits inside 5s; on a loaded one it does
     * not, and what you get is a timeout at ~5080ms that reads exactly like a
     * failed assertion. One did, on 2026-09-24, and the test passed alone.
     *
     * A timeout is a backstop against a hang, not a performance budget - so it
     * is set where a genuine hang is still caught quickly and a slow machine
     * is not reported as a broken renderer.
     */
    testTimeout: 30_000,
    env: {
      DATABASE_URL: "postgresql://unit-tests-never-connect/none",
      JWT_SECRET: "unit-test-secret-not-used-outside-the-test-run",
      STORAGE_DIR: path.join(os.tmpdir(), "daws-unit-test-storage"),
      // Most tests act as administrators with no second factor. The gate is
      // switched back on, and proven, in admin-two-step.itest.ts.
      REQUIRE_ADMIN_TWO_FACTOR: "false",
    },
  },
});
