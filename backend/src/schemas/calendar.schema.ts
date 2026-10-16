import { z } from "zod";

/** The office calendar: its time zone and its public holidays. */

export const setOfficeTimeZoneSchema = z.object({
  body: z
    .object({
      timeZone: z.string().trim().min(1, "Choose a time zone.").max(64),
    })
    .strict(),
});

export const addPublicHolidaySchema = z.object({
  body: z
    .object({
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Give the holiday's date as a day, like 2026-04-10.")
        .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "That is not a real date."),
      name: z.string().trim().min(1, "Give the holiday a name.").max(120),
    })
    .strict(),
});

export const publicHolidayIdSchema = z.object({
  params: z.object({
    id: z.uuid("That holiday is not on the calendar."),
  }),
});
