/**
 * `npm run admin:recover -- --email <address> [--reset-two-step] [--temporary-password]`
 *
 * The way back in when the one Super Administrator cannot act: they lost the
 * phone their two-step sign-in is on, forgot their password, or left.
 *
 * Only the Super Administrator can reset another administrator, manage
 * administrators, single sign-on or mail, or hand the role on. That is the
 * point of having one - and it means that without this, losing them meant
 * editing the database by hand. This runs on the server, with the server's
 * own environment and database credentials: whoever can run it already
 * controls everything the application holds, so it asks nothing more of them.
 *
 * What it does, all recorded in the audit trail as done by this script:
 *   - makes the named, active person the Super Administrator (a transfer:
 *     any other Super Administrator becomes an administrator with every power
 *     that can be given);
 *   - with --reset-two-step, switches their two-step sign-in off, so they can
 *     sign in and set it up again;
 *   - with --temporary-password, gives them a new random password, printed
 *     once here, and ends every session they have. They should change it at
 *     once under Your account.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { environmentProblems } from "../src/lib/config";

const VIA = "server recovery script";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const email = argument("--email")?.trim().toLowerCase();
  const resetTwoStep = process.argv.includes("--reset-two-step");
  const temporaryPassword = process.argv.includes("--temporary-password");

  if (!email) {
    console.error(
      "Usage: npm run admin:recover -- --email <address> [--reset-two-step] [--temporary-password]"
    );
    return 2;
  }

  const problems = environmentProblems();
  if (problems.length > 0) {
    console.error("This environment would not start the API, so nothing was changed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }

  // Imported only once the environment is known to be sound: these read it
  // at import time.
  const { prisma } = await import("../src/prisma.js");
  const { adminService } = await import("../src/services/admin.service.js");
  const { totpService } = await import("../src/services/totp.service.js");
  const { sessionsService } = await import("../src/services/sessions.service.js");
  const { auditService } = await import("../src/services/audit.service.js");
  const { hashPassword } = await import("../src/lib/password.js");

  try {
    const person = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        isSuperAdmin: true,
        loginRole: true,
        deactivatedAt: true,
        totpActivatedAt: true,
      },
    });

    if (!person) {
      console.error(`Nobody has the email address ${email}. Nothing was changed.`);
      return 1;
    }
    if (person.deactivatedAt) {
      console.error(
        `${person.firstName} ${person.lastName}'s account is switched off. Nothing was changed.`
      );
      return 1;
    }

    const name = `${person.firstName} ${person.lastName} <${person.email}>`;

    if (person.isSuperAdmin && person.loginRole === "ADMINISTRATOR") {
      console.log(`${name} is already the Super Administrator.`);
    } else {
      const result = await adminService.transferSuperAdmin(person.id, undefined, undefined, VIA);
      console.log(`${name} is now the Super Administrator.`);
      if (result.madeLimited.length > 0) {
        console.log(
          `${result.madeLimited.length} former Super Administrator(s) are now administrators with every power that can be given.`
        );
      }
    }

    if (resetTwoStep) {
      if (person.totpActivatedAt) {
        await totpService.resetFor(person.id, undefined);
        console.log("Two-step sign-in switched off. They set it up again when they next sign in.");
      } else {
        console.log("Two-step sign-in was not switched on for them.");
      }
    }

    if (temporaryPassword) {
      // 18 random bytes: 24 characters, well past the 12-character minimum and
      // never in a list of common passwords.
      const password = randomBytes(18).toString("base64url");
      await prisma.user.update({
        where: { id: person.id },
        data: { passwordHash: await hashPassword(password) },
      });
      await sessionsService.endAll(person.id, {});
      await auditService.createAuditLog({
        action: "PASSWORD_RESET",
        entityType: "User",
        entityId: person.id,
        // That there is a new password, never the password.
        newValue: { password: true, via: VIA },
      });
      console.log("");
      console.log(`Temporary password (shown once): ${password}`);
      console.log("Every session they had is ended. Ask them to change it under Your account.");
    }

    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
