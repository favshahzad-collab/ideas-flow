import { afterAll, beforeAll } from "vitest";

/**
 * Turn the approver skip on for one suite.
 *
 * `skipWorkflowStep` is refused unless a deployment switches it on, so the
 * tests that describe what it does when it IS on have to say so themselves.
 * That is deliberate: the default has to be provable, and it is - the memo
 * acceptance suite asks for a skip with nothing set and expects the refusal.
 *
 * Restores whatever was there before rather than deleting the variable, so a
 * developer running the suite with it set in their own `.env` gets it back.
 */
export function allowStepSkipInThisSuite(): void {
  let previous: string | undefined;

  beforeAll(() => {
    previous = process.env.ALLOW_STEP_SKIP;
    process.env.ALLOW_STEP_SKIP = "true";
  });

  afterAll(() => {
    if (previous === undefined) {
      delete process.env.ALLOW_STEP_SKIP;
    } else {
      process.env.ALLOW_STEP_SKIP = previous;
    }
  });
}
