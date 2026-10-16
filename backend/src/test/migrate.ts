import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where the integration suite writes its PDFs and signature images.
 *
 * Must match `STORAGE_DIR` in vitest.config.integration.mts. Vitest's `env`
 * block does not reach global setup - it runs in the main process, before the
 * workers exist - so the path is rebuilt here rather than read.
 */
const STORAGE_ROOT = path.join(os.tmpdir(), "daws-integration-test-storage");

/**
 * Start every run from an empty storage root.
 *
 * The database is truncated between tests; this directory was never cleaned
 * at all, so every run left its uploads behind and the next one started with
 * more. After a day of running the suite it held 25,420 files across 12,656
 * directories.
 *
 * That is not merely untidy. `documents.service.itest.ts` asks what is in the
 * storage tree before and after a refused submission, to prove a rejected memo
 * leaves no orphaned file - and it asks with a recursive `readdir`, whose cost
 * is the size of everything ever written rather than the size of what this
 * test wrote. It passed for months, slowed with every run, and eventually took
 * longer than the 30-second test timeout: a hang, in a test about orphaned
 * uploads, caused by orphaned uploads, pointing at a service that was working
 * correctly the whole time.
 *
 * CI never sees it, because a runner starts empty. Only a person running the
 * suite repeatedly does - which is to say, only somebody in the middle of
 * changing something, being told the thing they changed is broken.
 */
function emptyStorageRoot(): void {
  rmSync(STORAGE_ROOT, { recursive: true, force: true });
}

/**
 * Bring the test database up to the current migrations, once per run.
 *
 * `migrate deploy` applies what is missing and does nothing when there is
 * nothing to apply, so this costs a second on an already-current database and
 * means a developer who has just pulled a migration does not have to remember
 * anything.
 *
 * Vitest's `env` block does not reach this file - global setup runs in the
 * main process, before the workers exist - so the url is passed explicitly.
 */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL;

  if (!url) {
    // vitest.config.integration.mts refuses to load without it; this is here
    // so that a mistake shows up as a sentence rather than a Prisma stack.
    throw new Error("TEST_DATABASE_URL is not set");
  }

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });

  emptyStorageRoot();
}
