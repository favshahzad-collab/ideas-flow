import { describe, expect, it } from "vitest";
import {
  actingAs,
  delegationsOverlap,
  isDelegationActive,
} from "./delegation";

/**
 * A delegation says somebody else may sign in your place. Every question here
 * is about a boundary, and every boundary is one somebody will land on: the
 * day it starts, the day it ends, the minute it is revoked.
 */

const at = (iso: string) => new Date(iso);

const window = (overrides: Partial<Parameters<typeof isDelegationActive>[0]> = {}) => ({
  startsAt: at("2026-09-01T00:00:00Z"),
  endsAt: at("2026-09-30T23:59:59Z"),
  revokedAt: null,
  ...overrides,
});

describe("isDelegationActive", () => {
  it("is in force between its dates", () => {
    expect(isDelegationActive(window(), at("2026-09-15T10:00:00Z"))).toBe(true);
  });

  it("is not in force before it starts", () => {
    expect(isDelegationActive(window(), at("2026-08-31T23:59:59Z"))).toBe(false);
  });

  it("is not in force after it ends", () => {
    expect(isDelegationActive(window(), at("2026-10-01T00:00:00Z"))).toBe(false);
  });

  it("covers the first moment and the last", () => {
    // Somebody told "you are covering from the 1st until the 30th" signs on
    // the 30th. Refusing them on a boundary nobody explained is how a system
    // starts to feel arbitrary.
    expect(isDelegationActive(window(), at("2026-09-01T00:00:00Z"))).toBe(true);
    expect(isDelegationActive(window(), at("2026-09-30T23:59:59Z"))).toBe(true);
  });

  it("runs until revoked when it has no end", () => {
    const openEnded = window({ endsAt: null });

    expect(isDelegationActive(openEnded, at("2027-06-01T00:00:00Z"))).toBe(true);
  });

  it("stops the moment it is revoked, whatever the dates said", () => {
    const revoked = window({ revokedAt: at("2026-09-10T09:00:00Z") });

    expect(isDelegationActive(revoked, at("2026-09-10T08:59:59Z"))).toBe(true);
    expect(isDelegationActive(revoked, at("2026-09-10T09:00:00Z"))).toBe(false);
    expect(isDelegationActive(revoked, at("2026-09-20T00:00:00Z"))).toBe(false);
  });

  it("was still in force before it was revoked", () => {
    // Which is why the row is kept: an approval given on the 5th under a
    // delegation revoked on the 10th was authorised when it was given.
    const revoked = window({ revokedAt: at("2026-09-10T09:00:00Z") });

    expect(isDelegationActive(revoked, at("2026-09-05T12:00:00Z"))).toBe(true);
  });
});

describe("delegationsOverlap", () => {
  const span = (startsAt: string, endsAt: string | null) => ({
    startsAt: at(startsAt),
    endsAt: endsAt === null ? null : at(endsAt),
  });

  it("sees an overlap when one starts inside the other", () => {
    expect(
      delegationsOverlap(
        span("2026-09-01T00:00:00Z", "2026-09-30T00:00:00Z"),
        span("2026-09-15T00:00:00Z", "2026-10-15T00:00:00Z")
      )
    ).toBe(true);
  });

  it("sees no overlap when one ends before the other starts", () => {
    expect(
      delegationsOverlap(
        span("2026-09-01T00:00:00Z", "2026-09-10T00:00:00Z"),
        span("2026-09-11T00:00:00Z", "2026-09-20T00:00:00Z")
      )
    ).toBe(false);
  });

  it("treats an open-ended delegation as overlapping everything after it", () => {
    expect(
      delegationsOverlap(
        span("2026-09-01T00:00:00Z", null),
        span("2027-01-01T00:00:00Z", "2027-01-31T00:00:00Z")
      )
    ).toBe(true);
  });

  it("does not read an open-ended delegation backwards", () => {
    expect(
      delegationsOverlap(
        span("2026-09-01T00:00:00Z", null),
        span("2026-01-01T00:00:00Z", "2026-01-31T00:00:00Z")
      )
    ).toBe(false);
  });

  it("is the same answer whichever way round it is asked", () => {
    const a = span("2026-09-01T00:00:00Z", "2026-09-30T00:00:00Z");
    const b = span("2026-09-30T00:00:00Z", "2026-10-30T00:00:00Z");

    expect(delegationsOverlap(a, b)).toBe(delegationsOverlap(b, a));
  });
});

describe("actingAs", () => {
  it("always includes the person themselves", () => {
    expect(actingAs("u1", [])).toEqual(["u1"]);
  });

  it("adds the people who delegated to them", () => {
    expect(actingAs("u1", ["u2", "u3"])).toEqual(["u1", "u2", "u3"]);
  });

  it("never lists the same person twice", () => {
    // A list used in `assignedUserId: { in: ... }`; a duplicate would not be
    // wrong, but it is the shape a self-delegation would arrive in and that
    // is worth not carrying any further.
    expect(actingAs("u1", ["u1", "u2"])).toEqual(["u1", "u2"]);
  });
});
