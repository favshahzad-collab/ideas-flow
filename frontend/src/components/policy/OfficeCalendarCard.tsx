import { useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { CalendarDays, Plus, Trash2 } from 'lucide-react'
import Button from '../ui/Button'
import { Card, CardHeader } from '../ui/Card'
import {
  addPublicHoliday,
  fetchOfficeCalendar,
  removePublicHoliday,
  saveOfficeTimeZone,
  type OfficeCalendar,
} from '../../services/calendarApi'

/**
 * The calendar deadlines are counted on.
 *
 * Agreed after the fit-gap review: a deadline ends at the end of the working
 * day in the office's own time zone, and public holidays - Eid, which moves
 * every year - are not working days. Nothing here can know those, so an
 * administrator keeps them, here beside the deadline they change.
 */

const message = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback

/** The zones this runtime knows, with the current one kept if it is not listed. */
function zoneOptions(current: string): string[] {
  const known =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  const zones = known.includes('UTC') ? known : ['UTC', ...known]
  return zones.includes(current) ? zones : [current, ...zones]
}

const formatHoliday = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })

export default function OfficeCalendarCard() {
  const [calendar, setCalendar] = useState<OfficeCalendar | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [zone, setZone] = useState<string | null>(null)
  const [date, setDate] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const zoneId = useId()
  const dateId = useId()
  const nameId = useId()

  useEffect(() => {
    let cancelled = false
    fetchOfficeCalendar()
      .then(loaded => {
        if (cancelled) return
        setCalendar(loaded)
        setLoadError(null)
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(message(error, 'Could not read the office calendar.'))
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  const chosenZone = zone ?? calendar?.timeZone ?? 'UTC'
  const zones = useMemo(() => zoneOptions(chosenZone), [chosenZone])

  const today = new Date().toISOString().slice(0, 10)
  const upcoming = (calendar?.holidays ?? []).filter(holiday => holiday.date >= today)
  const past = (calendar?.holidays ?? []).filter(holiday => holiday.date < today)

  const saveZone = async () => {
    setBusy('zone')
    setProblem(null)
    setNotice(null)
    try {
      const saved = await saveOfficeTimeZone(chosenZone)
      setCalendar(saved)
      setZone(null)
      setNotice(`Deadlines now end at the end of the working day in ${saved.timeZone}.`)
    } catch (error) {
      setProblem(message(error, 'Could not save the time zone.'))
    } finally {
      setBusy(null)
    }
  }

  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (!date || !name.trim()) {
      setProblem('Give the holiday a date and a name.')
      return
    }
    setBusy('add')
    setProblem(null)
    setNotice(null)
    try {
      const { holiday } = await addPublicHoliday({ date, name: name.trim() })
      setCalendar(current =>
        current
          ? {
              ...current,
              holidays: [...current.holidays, holiday].sort((a, b) => a.date.localeCompare(b.date)),
            }
          : current,
      )
      setDate('')
      setName('')
      setNotice(`${holiday.name} added. It is not counted as a working day from now on.`)
    } catch (error) {
      setProblem(message(error, 'Could not add the holiday.'))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (id: string, label: string) => {
    setBusy(id)
    setProblem(null)
    setNotice(null)
    try {
      await removePublicHoliday(id)
      setCalendar(current =>
        current ? { ...current, holidays: current.holidays.filter(h => h.id !== id) } : current,
      )
      setNotice(`${label} removed. It counts as a working day again.`)
    } catch (error) {
      setProblem(message(error, 'Could not remove the holiday.'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader
        icon={CalendarDays}
        title="Office calendar"
        hint="Deadlines count working days: Monday to Friday, less the public holidays below, each ending at midnight in the office's time zone."
      />
      <div className="space-y-4 p-4 pt-0">
        {loadError ? (
          <div className="space-y-3">
            <p role="alert" className="text-ui text-danger-ink">
              {loadError}
            </p>
            <Button variant="secondary" onClick={() => setAttempt(n => n + 1)}>
              Retry
            </Button>
          </div>
        ) : !calendar ? (
          <p className="text-ui text-content-muted">Reading the office calendar…</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <label htmlFor={zoneId} className="field-label">
                  Office time zone
                </label>
                <select
                  id={zoneId}
                  value={chosenZone}
                  onChange={event => setZone(event.target.value)}
                  className="field"
                >
                  {zones.map(option => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                variant="secondary"
                onClick={() => void saveZone()}
                pending={busy === 'zone'}
                disabled={chosenZone === calendar.timeZone}
              >
                Save time zone
              </Button>
            </div>

            <form onSubmit={add} className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <label htmlFor={dateId} className="field-label">
                  Holiday date
                </label>
                <input
                  id={dateId}
                  type="date"
                  value={date}
                  onChange={event => setDate(event.target.value)}
                  className="field"
                />
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <label htmlFor={nameId} className="field-label">
                  Name
                </label>
                <input
                  id={nameId}
                  value={name}
                  maxLength={120}
                  placeholder="e.g. Eid ul-Fitr"
                  onChange={event => setName(event.target.value)}
                  className="field"
                />
              </div>
              <Button
                type="submit"
                icon={<Plus size={16} aria-hidden="true" />}
                pending={busy === 'add'}
              >
                Add holiday
              </Button>
            </form>

            {problem && (
              <p role="alert" className="text-ui text-danger-ink">
                {problem}
              </p>
            )}
            {notice && (
              <p role="status" className="text-ui text-success-ink">
                {notice}
              </p>
            )}

            {upcoming.length === 0 ? (
              <p className="text-ui text-content-muted">
                No public holidays ahead. Add them as they are announced.
              </p>
            ) : (
              <ul className="divide-y divide-line-soft rounded-control border border-line-soft">
                {upcoming.map(holiday => (
                  <li
                    key={holiday.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-ui font-medium text-content">{holiday.name}</p>
                      <p className="text-meta text-content-subtle">{formatHoliday(holiday.date)}</p>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Trash2 size={14} aria-hidden="true" />}
                      pending={busy === holiday.id}
                      onClick={() => void remove(holiday.id, holiday.name)}
                      aria-label={`Remove ${holiday.name}`}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {past.length > 0 && (
              <p className="text-meta text-content-subtle">
                {past.length} past {past.length === 1 ? 'holiday is' : 'holidays are'} kept, so
                deadlines already counted over them stay as they were.
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  )
}
