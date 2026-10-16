import { afterEach, beforeEach } from "vitest";

/**
 * Give a suite a deployment-wide deadline.
 *
 * Nothing in this product has a deadline unless somebody sets one, so the
 * tests that describe what happens when a step runs over have to set one
 * themselves - and the tests that describe the delivered default must not.
 * That split is the point: "no deadline" is the shipped behaviour and has to
 * be as provable as the other.
 *
 * Restores whatever was there before rather than deleting it, so a developer
 * running the suite with a value in their own `.env` gets it back.
 */
export function defaultSlaDaysInThisSuite(days: number): void {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.SLA_DEFAULT_DAYS;
    process.env.SLA_DEFAULT_DAYS = String(days);
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.SLA_DEFAULT_DAYS;
    } else {
      process.env.SLA_DEFAULT_DAYS = previous;
    }
  });
}
