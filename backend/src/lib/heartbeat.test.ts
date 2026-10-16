import { beforeEach, describe, expect, it } from "vitest";
import {
  jobHealth,
  jobsHealthy,
  registerJob,
  reportJob,
  resetJobs,
} from "./heartbeat";

/**
 * Whether the background work is still happening.
 *
 * The point of this file is a monitor that stays worth reading. Two ways to
 * ruin one, and both are tested here: crying about a sweep that is merely a
 * little late, and staying silent about one that has stopped.
 */

const MINUTE = 60_000;

beforeEach(() => {
  resetJobs();
});

describe("a job nobody started", () => {
  it("is off, not broken", () => {
    // A deployment with no mail server configured is not failing to send
    // mail. Reporting that as a fault is how a monitor gets muted.
    expect(jobHealth().mail).toBe("off");
    expect(jobsHealthy()).toBe(true);
  });
});

describe("a job that is running", () => {
  it("is ok immediately after it starts", () => {
    registerJob("mail", MINUTE);

    expect(jobHealth().mail).toBe("ok");
  });

  it("stays ok while it keeps reporting", () => {
    registerJob("ledger", 30_000);
    reportJob("ledger", true);

    expect(jobHealth(Date.now() + 20_000).ledger).toBe("ok");
  });

  it("is still ok when a pass overruns its own interval", () => {
    // Ordinary under load. A monitor that pages for it will be muted within
    // the week, and then it is not a monitor.
    registerJob("mail", MINUTE);

    expect(jobHealth(Date.now() + MINUTE * 2).mail).toBe("ok");
  });

  it("is stalled once it has missed several in a row", () => {
    registerJob("mail", MINUTE);

    expect(jobHealth(Date.now() + MINUTE * 4).mail).toBe("stalled");
    expect(jobsHealthy(Date.now() + MINUTE * 4)).toBe(false);
  });

  it("gives a very frequent sweep a floor, so one slow query is not an alert", () => {
    // A five-second sweep three intervals late is fifteen seconds late, which
    // is nothing. The floor is a minute.
    registerJob("ledger", 5_000);

    expect(jobHealth(Date.now() + 30_000).ledger).toBe("ok");
    expect(jobHealth(Date.now() + MINUTE * 2).ledger).toBe("stalled");
  });
});

describe("a job that is failing", () => {
  it("treats one failure as a blip", () => {
    // Networks. A single failed pass that the next one fixes is not worth
    // waking anybody for.
    registerJob("mail", MINUTE);
    reportJob("mail", false);

    expect(jobHealth().mail).toBe("ok");
  });

  it("calls it failing once it is a pattern", () => {
    registerJob("mail", MINUTE);
    reportJob("mail", false);
    reportJob("mail", false);
    reportJob("mail", false);

    expect(jobHealth().mail).toBe("failing");
    expect(jobsHealthy()).toBe(false);
  });

  it("forgets the failures as soon as one pass works", () => {
    registerJob("mail", MINUTE);
    reportJob("mail", false);
    reportJob("mail", false);
    reportJob("mail", false);
    reportJob("mail", true);

    expect(jobHealth().mail).toBe("ok");
  });

  it("is failing rather than stalled when it is both", () => {
    // "Failing" is the more actionable word: it says the pass ran and threw,
    // which is a log to go and read.
    registerJob("mail", MINUTE);
    reportJob("mail", false);
    reportJob("mail", false);
    reportJob("mail", false);

    expect(jobHealth(Date.now() + MINUTE * 10).mail).toBe("failing");
  });
});

describe("reports from a job that was never registered", () => {
  it("are ignored rather than inventing one", () => {
    reportJob("deadlines", true);

    expect(jobHealth().deadlines).toBe("off");
  });
});

describe("the summary", () => {
  it("is unhealthy if any single job is", () => {
    registerJob("mail", MINUTE);
    registerJob("ledger", MINUTE);
    reportJob("ledger", false);
    reportJob("ledger", false);
    reportJob("ledger", false);

    expect(jobHealth().mail).toBe("ok");
    expect(jobsHealthy()).toBe(false);
  });
});
