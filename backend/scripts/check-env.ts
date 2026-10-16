/**
 * `npm run check:env` - would this environment start the API?
 *
 * The same checks `src/index.ts` makes before it listens, without listening:
 * run it on a server, with that server's environment, before deploying the
 * version that introduced them, so a typo that used to be silently ignored is
 * found now rather than by an API that will not come back up.
 *
 * Reads the database only to learn whether APP_URL is stored on
 * Administration -> Mail. It writes nothing.
 */
import "dotenv/config";
import { assertAppUrlConfigured, environmentProblems } from "../src/lib/config";

async function main(): Promise<number> {
  const problems = environmentProblems();
  if (problems.length > 0) {
    console.error(`Would not start. ${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }

  // Imported only once the environment is known to be sound: these read it
  // at import time.
  const { prisma } = await import("../src/prisma.js");
  const { mailSettingsService } = await import("../src/services/mailSettings.service.js");
  const { mailSettings } = await import("../src/lib/mailer.js");

  try {
    await mailSettingsService.applyStoredMailSettings();
    assertAppUrlConfigured(mailSettings().appUrlIsDefault);
  } catch (error) {
    console.error(`Would not start: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await prisma.$disconnect();
  }

  console.log("The environment is sound: the API would start with it.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  }
);
