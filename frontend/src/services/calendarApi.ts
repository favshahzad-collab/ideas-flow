import { apiJson, jsonBody } from './apiClient'

/**
 * The office calendar deadlines are counted on: the time zone a working day
 * ends in, and the public holidays that are not working days.
 */

export interface PublicHoliday {
  id: string
  /** YYYY-MM-DD, a date with no time. */
  date: string
  name: string
}

export interface OfficeCalendar {
  timeZone: string
  holidays: PublicHoliday[]
}

export async function fetchOfficeCalendar(): Promise<OfficeCalendar> {
  return apiJson<OfficeCalendar>('/api/admin/calendar')
}

export async function saveOfficeTimeZone(timeZone: string): Promise<OfficeCalendar> {
  return apiJson<OfficeCalendar>('/api/admin/calendar', {
    method: 'PUT',
    ...jsonBody({ timeZone }),
  })
}

export async function addPublicHoliday(input: {
  date: string
  name: string
}): Promise<{ holiday: PublicHoliday }> {
  return apiJson<{ holiday: PublicHoliday }>('/api/admin/calendar/holidays', {
    method: 'POST',
    ...jsonBody(input),
  })
}

export async function removePublicHoliday(id: string): Promise<void> {
  await apiJson<unknown>(`/api/admin/calendar/holidays/${id}`, { method: 'DELETE' })
}
