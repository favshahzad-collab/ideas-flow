import { afterEach, describe, expect, it } from "vitest";
import {
  addWorkingDays,
  daysUntil,
  defaultSlaDays,
  dueAtFor,
  endOfDay,
  escalateAtFor,
  slaDaysFor,
  slaStatus,
} from "./sla";
import { useOfficeCalendar } from "./officeCalendar";

/**
 * The arithmetic behind a deadline.
 *
 * All of it is here rather than in a service because a wrong answer is not a
 * crash - it is a memo somebody is chased about a day early, or a week late,
 * and neither shows up as a failure anywhere else.
 */

const original = process.env.SLA_DEFAULT_DAYS;

afterEach(() => {
  if (original === undefined) delete process.env.SLA_DEFAULT_DAYS;
  else process.env.SLA_DEFAULT_DAYS = original;
});

const set = (value: string | undefined) => {
  if (value === undefined) delete process.env.SLA_DEFAULT_DAYS;
  else process.env.SLA_DEFAULT_DAYS = value;
};

// 2026-09-07 is a Monday.
const MONDAY = new Date("2026-09-07T09:00:00.000Z");
const FRIDAY = new Date("2026-09-11T16:00:00.000Z");
const SATURDAY = new Date("2026-09-12T10:00:00.000Z");

describe("whether there is a deadline at all", () => {
  it("says no when nobody has set one", () => {
    set(undefined);

    expect(defaultSlaDays()).toBeNull();
    expect(slaDaysFor(null)).toBeNull();
    expect(dueAtFor(MONDAY, null)).toBeNull();
  });

  it("takes the deployment default when the step names none", () => {
    set("3");

    expect(slaDaysFor(null)).toBe(3);
    expect(slaDaysFor(undefined)).toBe(3);
  });

  it("lets the step override the deployment", () => {
    set("3");

    expect(slaDaysFor(7)).toBe(7);
  });

  it("ignores a default that is not a whole number of days", () => {
    // A misconfigured value must mean "no deadline", not "some deadline I
    // guessed" - the whole point is that nothing here invents one.
    for (const bad of ["0", "-2", "2.5", "soon", ""]) {
      set(bad);
      expect(defaultSlaDays(), `for ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it("ignores a step deadline that is not a whole number of days", () => {
    set(undefined);

    expect(slaDaysFor(0)).toBeNull();
    expect(slaDaysFor(-1)).toBeNull();
    expect(slaDaysFor(1.5)).toBeNull();
  });

  it("is read fresh each time, so an operator can change it without a rebuild", () => {
    set("2");
    expect(defaultSlaDays()).toBe(2);
    set("5");
    expect(defaultSlaDays()).toBe(5);
  });
});

describe("counting working days", () => {
  it("counts from the day after it arrived", () => {
    // Monday plus one working day is Tuesday: a step that arrives today and
    // has "one day" has until the end of tomorrow.
    expect(addWorkingDays(MONDAY, 1).toISOString()).toContain("2026-09-08");
  });

  it("steps over the weekend", () => {
    // Friday afternoon plus two days is Tuesday, not Sunday. This is the
    // whole reason for counting working days at all.
    expect(addWorkingDays(FRIDAY, 2).toISOString()).toContain("2026-09-15");
  });

  it("never lands on a Saturday or a Sunday", () => {
    for (let days = 1; days <= 15; days += 1) {
      const landed = addWorkingDays(MONDAY, days);
      expect([1, 2, 3, 4, 5], `after ${days} days`).toContain(landed.getUTCDay());
    }
  });

  it("moves a step that arrived on a weekend to the next working day", () => {
    // Zero days from a Saturday is Monday, not Saturday: a deadline that has
    // already expired on arrival would chase somebody for an office being shut.
    expect(addWorkingDays(SATURDAY, 0).getUTCDay()).toBe(1);
  });

  it("adds five working days as a whole week", () => {
    expect(addWorkingDays(MONDAY, 5).toISOString()).toContain("2026-09-14");
  });
});

describe("when in the day a deadline falls", () => {
  it("is the last instant of it, so nothing expires early", () => {
    const end = endOfDay(MONDAY);

    expect(end.toISOString()).toBe("2026-09-07T23:59:59.999Z");
  });

  it("gives a memo that arrived at four in the afternoon the whole of its last day", () => {
    // Naively adding twenty-four hours would expire this at four on the
    // following afternoon, which is not what "one day" means in an office.
    const due = dueAtFor(new Date("2026-09-07T16:00:00.000Z"), 1);

    expect(due?.toISOString()).toBe("2026-09-08T23:59:59.999Z");
  });
});

describe("how a deadline reads", () => {
  const due = new Date("2026-09-10T23:59:59.999Z");

  it("says nothing at all when there is no deadline", () => {
    expect(slaStatus(null, MONDAY)).toBe("none");
  });

  it("is ahead while there is more than a day to run", () => {
    expect(slaStatus(due, new Date("2026-09-08T09:00:00.000Z"))).toBe("ahead");
  });

  it("is soon on the last day", () => {
    expect(slaStatus(due, new Date("2026-09-10T09:00:00.000Z"))).toBe("soon");
  });

  it("is soon the day before, not only on the day itself", () => {
    // A warning that first appears on the morning it is due is a warning
    // nobody can act on.
    expect(slaStatus(due, new Date("2026-09-09T23:00:00.000Z"))).toBe("soon");
  });

  it("is overdue only once the day has actually passed", () => {
    expect(slaStatus(due, new Date("2026-09-10T23:59:59.998Z"))).toBe("soon");
    expect(slaStatus(due, new Date("2026-09-11T00:00:00.000Z"))).toBe("overdue");
  });
});

describe("how many days are left", () => {
  const due = new Date("2026-09-10T23:59:59.999Z");

  it("rounds up, because part of a day is still a day you have", () => {
    expect(daysUntil(due, new Date("2026-09-09T09:00:00.000Z"))).toBe(2);
  });

  it("goes negative once it has passed", () => {
    expect(daysUntil(due, new Date("2026-09-13T09:00:00.000Z"))).toBeLessThan(0);
  });
});

describe("the office calendar", () => {
  afterEach(() => {
    useOfficeCalendar({ timeZone: null, holidays: [] });
  });

  // Monday 6 April 2026, nine in the morning UTC.
  const monday = new Date("2026-04-06T09:00:00.000Z");

  it("skips a public holiday the way it skips a weekend", () => {
    useOfficeCalendar({ timeZone: "UTC", holidays: ["2026-04-07"] });

    // Two working days from Monday: Tuesday is a holiday, so Thursday.
    expect(dueAtFor(monday, 2)?.toISOString()).toBe("2026-04-09T23:59:59.999Z");
  });

  it("ends the day at midnight in the office, not in Greenwich", () => {
    useOfficeCalendar({ timeZone: "Asia/Karachi", holidays: [] });

    // Due end of Wednesday in Karachi (UTC+5), which is 18:59:59.999 UTC.
    expect(dueAtFor(monday, 2)?.toISOString()).toBe("2026-04-08T18:59:59.999Z");
  });

  it("counts the office's date, not Greenwich's, for a memo that arrives late in the evening", () => {
    useOfficeCalendar({ timeZone: "Asia/Karachi", holidays: [] });

    // 21:00 UTC on Friday is 02:00 on Saturday in Karachi. One working day
    // from a Saturday is Monday.
    const fridayNightUtc = new Date("2026-04-10T21:00:00.000Z");
    expect(dueAtFor(fridayNightUtc, 1)?.toISOString()).toBe("2026-04-13T18:59:59.999Z");
  });

  it("escalates two working days after the deadline", () => {
    useOfficeCalendar({ timeZone: "UTC", holidays: [] });

    // Due end of Wednesday; escalated at the end of Friday.
    expect(escalateAtFor(monday, 2)?.toISOString()).toBe("2026-04-10T23:59:59.999Z");
  });

  it("does not escalate what has no deadline", () => {
    expect(escalateAtFor(monday, null, null)).toBeNull();
  });

  it("leaves a deployment that never set anything exactly as it was", () => {
    expect(endOfDay(new Date("2026-04-06T09:00:00.000Z")).toISOString()).toBe(
      "2026-04-06T23:59:59.999Z"
    );
    expect(addWorkingDays(monday, 1).toISOString()).toBe("2026-04-07T09:00:00.000Z");
  });
});
