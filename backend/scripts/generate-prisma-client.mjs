/**
 * Regenerate the Prisma client after every install.
 *
 * The client in `src/generated/prisma` is built from `prisma/schema.prisma`
 * and is not committed. Pull a change that adds a column, forget
 * `prisma generate`, and the API still starts - then fails with a 500 on the
 * first query that names the new column. That is what Workflow studio and
 * the template picker did after template archiving landed: the database had
 * `archived_at`, the client did not know it existed.
 *
 * Run on `postinstall`, so `npm ci` leaves a client that matches the schema
 * it was installed with. `prebuild` and `predev` run it too, for a pull with
 * no install in between.
 *
 * The CLI is a development dependency. An install that leaves those out
 * (`npm ci --omit=dev`) has no CLI to run - and nothing to build with either,
 * see DEPLOY.md - so that case is reported and skipped rather than failing
 * the install.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let cli;
try {
  cli = require.resolve("prisma/build/index.js");
} catch {
  console.warn(
    "prisma generate skipped: the Prisma CLI is not installed (development dependencies were left out)."
  );
  process.exit(0);
}

const result = spawnSync(process.execPath, [cli, "generate"], { stdio: "inherit" });
process.exit(result.status ?? 1);
