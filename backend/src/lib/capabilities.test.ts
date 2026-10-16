import { describe, expect, it } from "vitest";
import { LoginRole } from "../generated/prisma/client";
import { CAPABILITIES, capabilitiesFor, accessControlMatrix } from "./capabilities";

/**
 * A description of the rules is only worth having if it cannot drift from
 * them. These are the checks that make the Access Control screen quotable:
 * that every claim names a route, that every claim is internally consistent,
 * and - in `routes.itest.ts`, over real HTTP - that the routes named as
 * administrator-only actually refuse an ordinary user.
 */

describe("the capability matrix", () => {
  it("gives every capability a route or a stated reason not to", () => {
    /*
     * Three capabilities describe how *contents* are scoped rather than which
     * endpoint may be called - every document route applies them - so there is
     * no route to name. They are listed by hand here so that a fourth one
     * appearing with an empty route list is a test failure rather than a
     * silent claim about behaviour nothing checks.
     *
     * Each of the three is checked where the rule actually lives, in
     * `documentAccess.test.ts`: the first two say who may read their own and
     * their assigned memos, and `memos.view.all` says an administrator reads
     * every one of them.
     */
    const scopingRules = new Set([
      "memos.view.own",
      "memos.view.assigned",
      "memos.view.all",
    ]);

    for (const capability of CAPABILITIES) {
      if (scopingRules.has(capability.id)) {
        expect(capability.routes).toHaveLength(0);
        continue;
      }
      expect(capability.routes.length, `${capability.id} names no route`).toBeGreaterThan(0);
    }
  });

  it("writes every route in the form the route test can match", () => {
    for (const capability of CAPABILITIES) {
      for (const route of capability.routes) {
        expect(route, `${capability.id}: ${route}`).toMatch(
          /^(GET|POST|PUT|PATCH|DELETE) \/api\/[\w\-/:.]*$/
        );
      }
    }
  });

  it("has no capability nobody holds", () => {
    // A row of empty cells on the screen is a rule that does not exist. Either
    // somebody was meant to have it, or it should not be described.
    for (const capability of CAPABILITIES) {
      expect(capability.roles.length, `nobody holds ${capability.id}`).toBeGreaterThan(0);
    }
  });

  it("gives an administrator everything an ordinary user has", () => {
    /*
     * Not a truism - it is the property that makes the screen readable as two
     * columns rather than two unrelated lists, and the one that would break
     * first if somebody described a capability as "USER only" by mistake.
     */
    const user = capabilitiesFor(LoginRole.USER);
    const admin = new Set(capabilitiesFor(LoginRole.ADMINISTRATOR));

    for (const id of user) {
      expect(admin.has(id), `an administrator cannot ${id}`).toBe(true);
    }
  });

  it("keeps administration to administrators", () => {
    const user = new Set(capabilitiesFor(LoginRole.USER));

    for (const capability of CAPABILITIES) {
      if (capability.group !== "Administration") continue;
      expect(user.has(capability.id), `${capability.id} is not admin-only`).toBe(false);
    }
  });

  it("describes ids that are unique", () => {
    const ids = CAPABILITIES.map((capability) => capability.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("offers a column for every role the schema has", () => {
    // A role added to the enum and forgotten here would otherwise be invisible
    // on the screen rather than visibly empty.
    expect(accessControlMatrix().roles).toEqual(Object.values(LoginRole));
  });

  it("says what each capability buys, not only its name", () => {
    for (const capability of CAPABILITIES) {
      expect(capability.title.length, capability.id).toBeGreaterThan(3);
      // The detail is where the limits live - "only once the workflow has
      // reached their step" is the part somebody actually needs.
      expect(capability.detail.length, capability.id).toBeGreaterThan(30);
    }
  });
});
