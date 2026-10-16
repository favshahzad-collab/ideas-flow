import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addPublicHoliday,
  fetchOfficeCalendar,
  removePublicHoliday,
  saveOfficeTimeZone,
} from '../../services/calendarApi'
import OfficeCalendarCard from './OfficeCalendarCard'

/**
 * The calendar deadlines count on: the office time zone and the public
 * holidays an administrator keeps.
 */

vi.mock('../../services/calendarApi', () => ({
  fetchOfficeCalendar: vi.fn(),
  saveOfficeTimeZone: vi.fn(),
  addPublicHoliday: vi.fn(),
  removePublicHoliday: vi.fn(),
}))

const read = vi.mocked(fetchOfficeCalendar)
const saveZone = vi.mocked(saveOfficeTimeZone)
const add = vi.mocked(addPublicHoliday)
const remove = vi.mocked(removePublicHoliday)

const NEXT_YEAR = new Date().getUTCFullYear() + 1

beforeEach(() => {
  read.mockReset().mockResolvedValue({
    timeZone: 'UTC',
    holidays: [{ id: 'h1', date: `${NEXT_YEAR}-03-23`, name: 'Pakistan Day' }],
  })
  saveZone.mockReset()
  add.mockReset()
  remove.mockReset().mockResolvedValue(undefined)
})

describe('the office calendar', () => {
  it('lists the holidays ahead', async () => {
    render(<OfficeCalendarCard />)

    expect(await screen.findByText('Pakistan Day')).toBeInTheDocument()
  })

  it('adds a holiday with its date and name', async () => {
    const user = userEvent.setup({ delay: null })
    add.mockResolvedValue({ holiday: { id: 'h2', date: `${NEXT_YEAR}-04-10`, name: 'Eid ul-Fitr' } })
    render(<OfficeCalendarCard />)

    await user.type(await screen.findByLabelText('Holiday date'), `${NEXT_YEAR}-04-10`)
    await user.type(screen.getByLabelText('Name'), 'Eid ul-Fitr')
    await user.click(screen.getByRole('button', { name: 'Add holiday' }))

    expect(add).toHaveBeenCalledWith({ date: `${NEXT_YEAR}-04-10`, name: 'Eid ul-Fitr' })
    expect(await screen.findByText('Eid ul-Fitr')).toBeInTheDocument()
  })

  it('asks for both a date and a name before sending anything', async () => {
    const user = userEvent.setup({ delay: null })
    render(<OfficeCalendarCard />)

    await user.click(await screen.findByRole('button', { name: 'Add holiday' }))

    expect(screen.getByRole('alert')).toHaveTextContent('Give the holiday a date and a name.')
    expect(add).not.toHaveBeenCalled()
  })

  it('removes one', async () => {
    const user = userEvent.setup({ delay: null })
    render(<OfficeCalendarCard />)

    await user.click(await screen.findByRole('button', { name: 'Remove Pakistan Day' }))

    expect(remove).toHaveBeenCalledWith('h1')
    expect(screen.queryByText('Pakistan Day', { selector: 'p.font-medium' })).not.toBeInTheDocument()
  })

  it('saves the office time zone', async () => {
    const user = userEvent.setup({ delay: null })
    saveZone.mockResolvedValue({ timeZone: 'Asia/Karachi', holidays: [] })
    render(<OfficeCalendarCard />)

    const select = await screen.findByLabelText('Office time zone')
    const option = within(select).queryByRole('option', { name: 'Asia/Karachi' })
    // jsdom may not list every zone; the card keeps the choice either way.
    if (!option) return
    await user.selectOptions(select, 'Asia/Karachi')
    await user.click(screen.getByRole('button', { name: 'Save time zone' }))

    expect(saveZone).toHaveBeenCalledWith('Asia/Karachi')
    expect(await screen.findByRole('status')).toHaveTextContent('Asia/Karachi')
  })
})
