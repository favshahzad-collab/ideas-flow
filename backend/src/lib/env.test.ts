import { describe, expect, it } from "vitest";
import { trustProxySetting } from "./env";

/**
 * How many proxies are in front, and what happens when nobody says.
 *
 * This one setting decides whether `req.ip` is the approver or the machine
 * that forwarded them, and `req.ip` is what the audit trail records against
 * every approval and what both sign-in caps count. Getting it wrong is quiet
 * in development, where there is no proxy, and wrong in every deployment that
 * follows DEPLOY.md.
 */

describe("when nobody has said", () => {
  it("trusts nothing", () => {
    // The safe answer for an API exposed directly: a client that sends its own
    // X-Forwarded-For must not be believed about where it is.
    expect(trustProxySetting(undefined)).toBe(false);
  });

  it("treats an empty setting as nobody having said", () => {
    expect(trustProxySetting("")).toBe(false);
    expect(trustProxySetting("   ")).toBe(false);
  });
});

describe("a count of proxies", () => {
  it("reads one hop, which is what DEPLOY.md describes", () => {
    expect(trustProxySetting("1")).toBe(1);
  });

  it("reads more than one, for a proxy behind a load balancer", () => {
    expect(trustProxySetting("2")).toBe(2);
  });

  it("reads zero as trusting nothing, spelled out", () => {
    expect(trustProxySetting("0")).toBe(0);
  });

  it("ignores the whitespace an env file collects", () => {
    expect(trustProxySetting(" 1 ")).toBe(1);
  });

  it("is a number, not a numeric string - Express counts hops with one and matches addresses with the other", () => {
    expect(typeof trustProxySetting("1")).toBe("number");
  });
});

describe("the words Express understands", () => {
  it("passes a subnet through untouched", () => {
    expect(trustProxySetting("10.0.0.0/8")).toBe("10.0.0.0/8");
  });

  it("passes a list through untouched", () => {
    expect(trustProxySetting("loopback, 10.0.0.0/8")).toBe("loopback, 10.0.0.0/8");
  });

  it("passes its named ranges through", () => {
    expect(trustProxySetting("uniquelocal")).toBe("uniquelocal");
  });
});

describe("the blunt answers", () => {
  it("accepts true, for somebody who means it", () => {
    expect(trustProxySetting("true")).toBe(true);
    expect(trustProxySetting("TRUE")).toBe(true);
  });

  it("accepts false", () => {
    expect(trustProxySetting("false")).toBe(false);
  });

  it("does not read a fractional or negative count as a count", () => {
    // Neither is a number of hops. They fall through to Express, which will
    // fail loudly on a value it cannot parse rather than silently trusting
    // one hop.
    expect(trustProxySetting("1.5")).toBe("1.5");
    expect(trustProxySetting("-1")).toBe("-1");
  });
});
