import { errors } from "../lib/errors";
import { environmentTimeZone, isTimeZone, useOfficeCalendar } from "../lib/officeCalendar";
import { prisma } from "../prisma";
import { auditService } from "./audit.service";

/**
 * The office calendar deadlines are counted on: the time zone a working day
 * ends in, and the public holidays that are not working days.
 *
 * Kept by an administrator with the workflow-policy power, on the Workflow
 * policy screen, and pushed into `lib/officeCalendar` at boot and after every
 * change so the deadline arithmetic reads it without a query.
 */

const SINGLETON = "default";

/** The calendar's fixed id in the trail, like the other singleton settings. */
const CALENDAR_AUDIT_ID = "00000000-0000-4000-8000-000000000005";

const dateKey = (date: Date) => date.toISOString().slice(0, 10);

export type OfficeCalendarView = {
  timeZone: string;
  holidays: { id: string; date: string; name: string }[];
};

/** Push what is stored into the holder the arithmetic reads. */
async function applyStoredCalendar(): Promise<void> {
  const [setting, holidays] = await Promise.all([
    prisma.calendarSetting.findUnique({ where: { id: SINGLETON } }),
    prisma.publicHoliday.findMany({ select: { date: true } }),
  ]);

  useOfficeCalendar({
    timeZone: setting?.timeZone ?? null,
    holidays: holidays.map((holiday) => dateKey(holiday.date)),
  });
}

async function view(): Promise<OfficeCalendarView> {
  const [setting, holidays] = await Promise.all([
    prisma.calendarSetting.findUnique({ where: { id: SINGLETON } }),
    prisma.publicHoliday.findMany({ orderBy: { date: "asc" } }),
  ]);

  return {
    timeZone: setting?.timeZone ?? environmentTimeZone(),
    holidays: holidays.map((holiday) => ({
      id: holiday.id,
      date: dateKey(holiday.date),
      name: holiday.name,
    })),
  };
}

export const calendarService = {
  applyStoredCalendar,
  get: view,

  async setTimeZone(timeZone: string, actorId: string, ipAddress?: string) {
    if (!isTimeZone(timeZone)) {
      throw errors.badRequest("That is not a time zone this server knows. Choose one from the list.");
    }

    const before = await prisma.calendarSetting.findUnique({ where: { id: SINGLETON } });

    await prisma.$transaction(async (tx) => {
      await tx.calendarSetting.upsert({
        where: { id: SINGLETON },
        create: { id: SINGLETON, timeZone, updatedById: actorId },
        update: { timeZone, updatedById: actorId },
      });
      await auditService.createAuditLog({
        actorId,
        action: "OFFICE_TIME_ZONE_CHANGED",
        entityType: "CalendarSetting",
        entityId: CALENDAR_AUDIT_ID,
        oldValue: { timeZone: before?.timeZone ?? environmentTimeZone() },
        newValue: { timeZone },
        ipAddress,
        tx,
      });
    });

    await applyStoredCalendar();
    return view();
  },

  async addHoliday(
    input: { date: string; name: string },
    actorId: string,
    ipAddress?: string
  ) {
    const date = new Date(`${input.date}T00:00:00.000Z`);
    const existing = await prisma.publicHoliday.findUnique({ where: { date } });
    if (existing) {
      throw errors.conflict(`${input.date} is already a holiday: ${existing.name}.`);
    }

    const holiday = await prisma.$transaction(async (tx) => {
      const created = await tx.publicHoliday.create({
        data: { date, name: input.name.trim(), createdById: actorId },
      });
      await auditService.createAuditLog({
        actorId,
        action: "HOLIDAY_ADDED",
        entityType: "PublicHoliday",
        entityId: created.id,
        newValue: { date: input.date, name: created.name },
        ipAddress,
        tx,
      });
      return created;
    });

    await applyStoredCalendar();
    return { holiday: { id: holiday.id, date: dateKey(holiday.date), name: holiday.name } };
  },

  async removeHoliday(id: string, actorId: string, ipAddress?: string) {
    const holiday = await prisma.publicHoliday.findUnique({ where: { id } });
    if (!holiday) throw errors.notFound("That holiday is not on the calendar.");

    await prisma.$transaction(async (tx) => {
      await tx.publicHoliday.delete({ where: { id } });
      await auditService.createAuditLog({
        actorId,
        action: "HOLIDAY_REMOVED",
        entityType: "PublicHoliday",
        entityId: id,
        oldValue: { date: dateKey(holiday.date), name: holiday.name },
        ipAddress,
        tx,
      });
    });

    await applyStoredCalendar();
    return { message: "Holiday removed." };
  },
};
