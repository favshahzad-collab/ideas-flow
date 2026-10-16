/**
 * Refuse to run against anything but a test database.
 *
 * Written after a scratch script did exactly what its own header said it must
 * never do. The script set `DATABASE_URL` to `daws_test` and ran - but
 * `src/prisma.ts` reads `DIRECT_URL ?? DATABASE_URL`, and `.env` sets
 * `DIRECT_URL` to the live database. So the override was real, applied, and
 * beside the point: every write landed in `daws`.
 *
 * A comment saying "this must never be pointed at a real one" is not a guard.
 * This is, and it checks the string the client will actually connect with
 * rather than the one the caller believes they set.
 */

/** The same precedence `src/prisma.ts` applies. */
export function effectiveConnectionString(): string {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

  if (!url) {
    throw new Error(
      "Neither DIRECT_URL nor DATABASE_URL is set, so there is no database to check."
    );
  }

  return url;
}

export function databaseNameOf(connectionString: string): string {
  try {
    return new URL(connectionString).pathname.replace(/^\//, "");
  } catch {
    // A connection string this cannot parse is one nobody can vouch for.
    return "";
  }
}

/**
 * Stop unless the database is plainly a test one.
 *
 * An allow-list by suffix, not a deny-list of known live names: a new
 * environment somebody adds next year is then refused by default rather than
 * written to by default, and the failure costs a flag while the alternative
 * costs live rows.
 */
export function assertTestDatabase(scriptName: string): void {
  const connectionString = effectiveConnectionString();
  const database = databaseNameOf(connectionString);

  if (database.endsWith("_test")) return;

  throw new Error(
    `${scriptName} creates people and memos, so it refuses to run against "${database || "an unreadable connection string"}".\n` +
      `\n` +
      `The client connects with DIRECT_URL when it is set, and falls back to\n` +
      `DATABASE_URL only when it is not - so setting DATABASE_URL alone changes\n` +
      `nothing. Set both:\n` +
      `\n` +
      `  DIRECT_URL=$TEST_DATABASE_URL DATABASE_URL=$TEST_DATABASE_URL npx tsx ${scriptName}\n`
  );
}
