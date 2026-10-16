import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "vitest/config";

/**
 * The integration suite. These tests run the real services against a real
 * Postgres, because what they are checking - a transaction that advances a
 * workflow run, writes an approval action, an audit row and four
 * notifications, and rolls all of it back together - is not a thing a mock can
 * be wrong about convincingly.
 *
 * It is a separate command from `npm test` on purpose. The unit suite runs
 * anywhere, in seconds, with nothing installed; this one needs a database, and
 * tying the two together would have made the fast one as hard to run as the
 * slow one.
 *
 * THE SUITE TRUNCATES EVERY TABLE BETWEEN TESTS. Everything below exists so
 * that it cannot possibly do that to a database anyone cares about.
 */

dotenv.config({ quiet: true });

const url = process.env.TEST_DATABASE_URL?.trim();

if (!url) {
  throw new Error(
    "TEST_DATABASE_URL is not set. The integration suite deletes every row in " +
      "the database it points at, so it has no default and will not fall back " +
      "to DATABASE_URL. See backend/README.md."
  );
}

/** The database name, without any query string. */
const databaseName = url.split("/").pop()?.split("?")[0] ?? "";

if (!databaseName.endsWith("_test")) {
  throw new Error(
    `TEST_DATABASE_URL points at "${databaseName}", and the integration suite ` +
      "only runs against a database whose name ends in `_test`. This is the " +
      "guard that stops a stray environment variable emptying a real database."
  );
}

for (const name of ["DATABASE_URL", "DIRECT_URL"] as const) {
  if (process.env[name]?.trim() === url) {
    throw new Error(
      `TEST_DATABASE_URL is the same url as ${name}. Point it at a separate ` +
        "database - the suite is about to truncate it."
    );
  }
}

if (process.env.NODE_ENV === "production") {
  throw new Error("Refusing to run the integration suite with NODE_ENV=production.");
}

export default defineConfig({
  test: {
    include: ["src/**/*.itest.ts"],
    globalSetup: ["./src/test/migrate.ts"],
    // One database, shared state, truncated between tests: two files running
    // at once would truncate each other's rows mid-test.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      // `src/prisma.ts` builds its client from these at import, and the
      // services import that client. Pointing them here is what puts the real
      // service code on the test database without it knowing.
      DATABASE_URL: url,
      DIRECT_URL: url,
      JWT_SECRET: "integration-test-secret-not-used-outside-the-test-run",
      STORAGE_DIR: path.join(os.tmpdir(), "daws-integration-test-storage"),
      NODE_ENV: "test",
      // Most tests act as administrators with no second factor. The gate is
      // switched back on, and proven, in admin-two-step.itest.ts.
      REQUIRE_ADMIN_TWO_FACTOR: "false",
    },
  },
});
