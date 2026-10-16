import { afterEach, describe, expect, it } from "vitest";

import {
  assertTestDatabase,
  databaseNameOf,
  effectiveConnectionString,
} from "./assertTestDatabase";

/**
 * The guard that stops a scratch script writing into a real database.
 *
 * It exists because one did. The script set `DATABASE_URL` to the test
 * database and its own header said it must never be pointed at a real one -
 * but `src/prisma.ts` reads `DIRECT_URL ?? DATABASE_URL`, `.env` sets
 * `DIRECT_URL` to the live database, and so every write landed in `daws`
 * while the caller had every reason to believe otherwise.
 *
 * Which is why the first test here is about precedence rather than about
 * names: reading the wrong variable is the failure, and a guard that read it
 * too would pass and protect nothing.
 */

const LIVE = "postgresql://daws:pw@127.0.0.1:15432/daws";
const TEST = "postgresql://daws:pw@127.0.0.1:15432/daws_test";

const original = {
  direct: process.env.DIRECT_URL,
  database: process.env.DATABASE_URL,
};

afterEach(() => {
  process.env.DIRECT_URL = original.direct;
  process.env.DATABASE_URL = original.database;
});

const set = (direct: string | undefined, database: string | undefined) => {
  if (direct === undefined) delete process.env.DIRECT_URL;
  else process.env.DIRECT_URL = direct;

  if (database === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = database;
};

describe("which connection string is the real one", () => {
  it("reads DIRECT_URL when it is set, as the client does", () => {
    set(LIVE, TEST);
    expect(effectiveConnectionString()).toBe(LIVE);
  });

  it("falls back to DATABASE_URL only when DIRECT_URL is absent", () => {
    set(undefined, TEST);
    expect(effectiveConnectionString()).toBe(TEST);
  });

  it("refuses to guess when neither is set", () => {
    set(undefined, undefined);
    expect(() => effectiveConnectionString()).toThrow(/no database to check/i);
  });
});

describe("refusing a database that is not a test one", () => {
  it("stops on the live database even when DATABASE_URL says otherwise", () => {
    // Exactly the case that caused this: the override was real, applied, and
    // beside the point.
    set(LIVE, TEST);
    expect(() => assertTestDatabase("script.ts")).toThrow(/refuses to run against "daws"/);
  });

  it("names the script and says how to run it properly", () => {
    set(LIVE, LIVE);
    try {
      assertTestDatabase("scripts/walkthrough.ts");
      throw new Error("should have refused");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("scripts/walkthrough.ts");
      expect(message).toContain("DIRECT_URL");
    }
  });

  it("allows a database whose name marks it as a test one", () => {
    set(TEST, TEST);
    expect(() => assertTestDatabase("script.ts")).not.toThrow();
  });

  it("refuses a connection string it cannot read", () => {
    // Nobody can vouch for a string this cannot parse, so it is not allowed
    // through on the grounds that it might be fine.
    set("not-a-url", undefined);
    expect(() => assertTestDatabase("script.ts")).toThrow(/unreadable/);
  });

  it.each([
    ["daws", "the live database"],
    ["daws_prod", "a production database"],
    ["postgres", "the default database"],
    ["daws_testing", "a name that merely starts the same way"],
  ])("refuses %s (%s)", (name) => {
    set(`postgresql://u:p@h:5432/${name}`, undefined);
    expect(() => assertTestDatabase("script.ts")).toThrow();
  });
});

describe("reading the name out of a connection string", () => {
  it("takes the path, without its slash", () => {
    expect(databaseNameOf(TEST)).toBe("daws_test");
  });

  it("gives an empty name for something unparseable, rather than throwing", () => {
    expect(databaseNameOf("nonsense")).toBe("");
  });
});
