import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearWorkflowPolicy,
  fetchWorkflowPolicy,
  saveWorkflowPolicy,
  type WorkflowPolicy,
} from '../services/AdminApi'
import { renderWithProviders } from '../test/render'
import WorkflowPolicyPage from './WorkflowPolicyPage'

/**
 * The screen that took the approval deadline out of the server's environment.
 *
 * Two things carry the whole feature and both are about honesty rather than
 * plumbing. An empty deadline field means "no deadline" and must not read as
 * "unset, the server will decide" - those are different policies and only one
 * of them chases anybody. And the screen has to say where the answer it is
 * showing came from, because a deployment that manages these in its
 * environment is a real deployment, and a form that quietly overwrote it
 * would be the same bug this screen exists to fix.
 */

vi.mock('../services/AdminApi', () => ({
  fetchWorkflowPolicy: vi.fn(),
  saveWorkflowPolicy: vi.fn(),
  clearWorkflowPolicy: vi.fn(),
}))

/* The office calendar card has its own reads; its behaviour is in
   OfficeCalendarCard.test.tsx. Settled quietly here. */
vi.mock('../services/calendarApi', () => ({
  fetchOfficeCalendar: vi.fn().mockResolvedValue({ timeZone: 'UTC', holidays: [] }),
  saveOfficeTimeZone: vi.fn(),
  addPublicHoliday: vi.fn(),
  removePublicHoliday: vi.fn(),
}))

const read = vi.mocked(fetchWorkflowPolicy)
const save = vi.mocked(saveWorkflowPolicy)
const handBack = vi.mocked(clearWorkflowPolicy)

const policy = (overrides: Partial<WorkflowPolicy> = {}): WorkflowPolicy => ({
  slaDefaultDays: null,
  allowStepSkip: false,
  preparerSignsOnSubmit: true,
  sealApprovedMemos: true,
  sealCertificate: { configured: true, signer: 'Ideas Flow document seal' },
  memosInProgress: 0,
  source: 'environment',
  environment: { slaDefaultDays: null, allowStepSkip: false, preparerSignsOnSubmit: true, sealApprovedMemos: true },
  ...overrides,
})

const deadlineField = () =>
  screen.getByLabelText(/working days before an approver is chased/i)

beforeEach(() => {
  read.mockReset()
  save.mockReset()
  handBack.mockReset()
  read.mockResolvedValue(policy())
})

describe('what it says is in force', () => {
  it('shows no deadline as no deadline, not as an empty form', async () => {
    renderWithProviders(<WorkflowPolicyPage />)

    // The state somebody arrives asking about: nothing is being chased.
    expect(await screen.findByText('No deadline')).toBeInTheDocument()
    expect(deadlineField()).toHaveValue(null)
  })

  it('names the deadline in force when there is one', async () => {
    read.mockResolvedValue(
      policy({ slaDefaultDays: 1, source: 'stored', environment: { slaDefaultDays: null, allowStepSkip: false, preparerSignsOnSubmit: true, sealApprovedMemos: true } }),
    )
    renderWithProviders(<WorkflowPolicyPage />)

    // One day, not "1 working days".
    expect(await screen.findByText('1 working day')).toBeInTheDocument()
  })

  it('says when the answer is the server’s rather than this screen’s', async () => {
    renderWithProviders(<WorkflowPolicyPage />)

    expect(
      await screen.findByText(/coming from the server’s own configuration/i),
    ).toBeInTheDocument()
    // Nothing to hand back: it was never taken over.
    expect(
      screen.queryByRole('button', { name: /hand back to the server/i }),
    ).not.toBeInTheDocument()
  })

  it('says what handing it back would give, before anybody does it', async () => {
    read.mockResolvedValue(
      policy({
        slaDefaultDays: 2,
        source: 'stored',
        environment: { slaDefaultDays: 10, allowStepSkip: true, preparerSignsOnSubmit: true, sealApprovedMemos: true },
      }),
    )
    renderWithProviders(<WorkflowPolicyPage />)

    expect(await screen.findByText('10 working days')).toBeInTheDocument()
    expect(screen.getByText('skipping allowed')).toBeInTheDocument()
  })
})

describe('saving', () => {
  it('sends the number typed', async () => {
    save.mockResolvedValue(policy({ slaDefaultDays: 3, source: 'stored' }))
    renderWithProviders(<WorkflowPolicyPage />)

    await userEvent.type(await screen.findByLabelText(/working days/i), '3')
    await userEvent.click(screen.getByRole('button', { name: /save policy/i }))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        slaDefaultDays: 3,
        allowStepSkip: false,
        preparerSignsOnSubmit: true,
        sealApprovedMemos: true,
        applyToInProgress: false,
      }),
    )
  })

  it('sends an empty field as no deadline, not as a missing value', async () => {
    /*
     * The distinction the design turns on. `null` stores "no deadline";
     * omitting the field would leave the server to fall back to whatever is
     * in its environment, which is the opposite of what clearing it means.
     */
    read.mockResolvedValue(policy({ slaDefaultDays: 4, source: 'stored' }))
    save.mockResolvedValue(policy({ slaDefaultDays: null, source: 'stored' }))
    renderWithProviders(<WorkflowPolicyPage />)

    await userEvent.clear(await screen.findByLabelText(/working days/i))
    await userEvent.click(screen.getByRole('button', { name: /save policy/i }))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        slaDefaultDays: null,
        allowStepSkip: false,
        preparerSignsOnSubmit: true,
        sealApprovedMemos: true,
        applyToInProgress: false,
      }),
    )
  })

  it('says plainly that nobody will be chased', async () => {
    save.mockResolvedValue(policy({ slaDefaultDays: null, source: 'stored' }))
    renderWithProviders(<WorkflowPolicyPage />)

    await userEvent.click(
      await screen.findByRole('button', { name: /save policy/i }),
    )

    expect(
      await screen.findByText(/nobody will be chased/i),
    ).toBeInTheDocument()
  })

  it('refuses a number that is not a number of days, without a round trip', async () => {
    renderWithProviders(<WorkflowPolicyPage />)

    await userEvent.type(await screen.findByLabelText(/working days/i), '999')
    await userEvent.click(screen.getByRole('button', { name: /save policy/i }))

    expect(
      screen.getByText(/whole number between 1 and 365/i),
    ).toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
  })

  it('keeps the refusal on screen rather than clearing the form', async () => {
    save.mockRejectedValue(new Error('The database is not reachable.'))
    renderWithProviders(<WorkflowPolicyPage />)

    await userEvent.type(await screen.findByLabelText(/working days/i), '2')
    await userEvent.click(screen.getByRole('button', { name: /save policy/i }))

    expect(
      await screen.findByText('The database is not reachable.'),
    ).toBeInTheDocument()
    expect(deadlineField()).toHaveValue(2)
  })
})

describe('handing it back to the server', () => {
  beforeEach(() => {
    read.mockResolvedValue(
      policy({
        slaDefaultDays: 2,
        source: 'stored',
        environment: { slaDefaultDays: 7, allowStepSkip: false, preparerSignsOnSubmit: true, sealApprovedMemos: true },
      }),
    )
  })

  it('asks first, and says it is not the same as clearing the deadline', async () => {
    renderWithProviders(<WorkflowPolicyPage />)

    await userEvent.click(
      await screen.findByRole('button', { name: /hand back to the server/i }),
    )

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/7 working days/i)
    // The trap this dialog exists to head off.
    expect(dialog).toHaveTextContent(/different from clearing the deadline/i)
    expect(handBack).not.toHaveBeenCalled()
  })

  it('does it once confirmed', async () => {
    handBack.mockResolvedValue(
      policy({
        slaDefaultDays: 7,
        source: 'environment',
        environment: { slaDefaultDays: 7, allowStepSkip: false, preparerSignsOnSubmit: true, sealApprovedMemos: true },
      }),
    )
    renderWithProviders(<WorkflowPolicyPage />)

    await userEvent.click(
      await screen.findByRole('button', { name: /hand back to the server/i }),
    )
    await userEvent.click(screen.getByRole('button', { name: /hand it back/i }))

    await waitFor(() => expect(handBack).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/handed back to the server/i)).toBeInTheDocument()
  })
})

describe('when it cannot be read at all', () => {
  it('says so and offers to try again, rather than showing an empty form', async () => {
    // An empty form here would read as "no policy set", which is a statement
    // about the deployment rather than about the request that failed.
    read.mockRejectedValueOnce(new Error('Could not reach the server.'))
    renderWithProviders(<WorkflowPolicyPage />)

    expect(
      await screen.findByText('Could not reach the server.'),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText(/working days/i)).not.toBeInTheDocument()

    read.mockResolvedValue(policy({ slaDefaultDays: 5, source: 'stored' }))
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))

    expect(await screen.findByText('5 working days')).toBeInTheDocument()
  })
})

/**
 * Whether submitting a document also means signing it.
 *
 * The switch that answers req 1 for an uploaded file: an organisation whose
 * submitters lodge documents they did not write turns it off, and the first
 * mark on the page becomes the first approver's.
 */
describe('signing at submission', () => {
  const toggle = () =>
    screen.getByLabelText('The person submitting a document also signs it')

  /** The same control, once the screen has finished loading the policy. */
  const findToggle = () =>
    screen.findByLabelText('The person submitting a document also signs it')

  it('shows it on for an organisation that has configured nothing', async () => {
    // The default that matters on upgrade: every document already filed was
    // signed by its preparer.
    renderWithProviders(<WorkflowPolicyPage />)

    expect(await findToggle()).toBeChecked()
  })

  it('shows it off where the organisation has turned it off', async () => {
    read.mockResolvedValue(
      policy({ preparerSignsOnSubmit: false, source: 'stored' }),
    )
    renderWithProviders(<WorkflowPolicyPage />)

    await waitFor(() => expect(toggle()).not.toBeChecked())
  })

  it('sends the change', async () => {
    save.mockResolvedValue(
      policy({ preparerSignsOnSubmit: false, source: 'stored' }),
    )
    renderWithProviders(<WorkflowPolicyPage />)

    await userEvent.click(await findToggle())
    await userEvent.click(screen.getByRole('button', { name: /save policy/i }))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        slaDefaultDays: null,
        allowStepSkip: false,
        preparerSignsOnSubmit: false,
        sealApprovedMemos: true,
        applyToInProgress: false,
      }),
    )
  })

  it('leaves the other policy alone when only this one changes', async () => {
    // Both flags go up together on every save, so a screen that rebuilt the
    // payload from one of them would silently reset the other.
    read.mockResolvedValue(policy({ allowStepSkip: true, source: 'stored' }))
    save.mockResolvedValue(policy({ source: 'stored' }))
    renderWithProviders(<WorkflowPolicyPage />)

    await waitFor(() => expect(toggle()).toBeChecked())
    await userEvent.click(toggle())
    await userEvent.click(screen.getByRole('button', { name: /save policy/i }))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          allowStepSkip: true,
          preparerSignsOnSubmit: false,
        }),
      ),
    )
  })
})

describe('the digital seal', () => {
  const sealSwitch = () =>
    screen.findByRole('switch', { name: /seal every memo when it is fully approved/i })

  it('is on by default and names the certificate it seals with', async () => {
    renderWithProviders(<WorkflowPolicyPage />)

    expect(await sealSwitch()).toBeChecked()
    expect(screen.getByText(/sealed as “ideas flow document seal”/i)).toBeInTheDocument()
    expect(screen.getByText('Sealing')).toBeInTheDocument()
  })

  it('sends the switch off with everything else left as it was', async () => {
    save.mockResolvedValue(policy({ sealApprovedMemos: false, source: 'stored' }))
    renderWithProviders(<WorkflowPolicyPage />)

    await userEvent.click(await sealSwitch())
    await userEvent.click(screen.getByRole('button', { name: /save policy/i }))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        slaDefaultDays: null,
        allowStepSkip: false,
        preparerSignsOnSubmit: true,
        sealApprovedMemos: false,
        applyToInProgress: false,
      }),
    )
    expect(await screen.findByText('Not sealing')).toBeInTheDocument()
  })

  it('says so when the server has no certificate, rather than implying the switch seals anything', async () => {
    read.mockResolvedValue(policy({ sealCertificate: { configured: false, signer: null } }))
    renderWithProviders(<WorkflowPolicyPage />)

    expect(await screen.findByText('No certificate')).toBeInTheDocument()
    expect(screen.getByText(/the server has no seal certificate/i)).toBeInTheDocument()
  })
})

describe('memos already in progress', () => {
  const reachSwitch = () =>
    screen.findByRole('switch', { name: /also apply these rules to the 3 memos in progress/i })

  it('leaves them on the rules they started with unless asked', async () => {
    read.mockResolvedValue(policy({ memosInProgress: 3 }))
    save.mockResolvedValue(policy({ memosInProgress: 3, source: 'stored' }))
    renderWithProviders(<WorkflowPolicyPage />)

    expect(await reachSwitch()).not.toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: /save policy/i }))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ applyToInProgress: false })),
    )
    expect(
      await screen.findByText(/memos already in progress keep the rules they started with/i),
    ).toBeInTheDocument()
  })

  it('moves them onto the new rules when the administrator asks, and resets the choice', async () => {
    read.mockResolvedValue(policy({ memosInProgress: 3 }))
    save.mockResolvedValue(policy({ memosInProgress: 3, source: 'stored' }))
    renderWithProviders(<WorkflowPolicyPage />)

    await userEvent.click(await reachSwitch())
    await userEvent.click(screen.getByRole('button', { name: /save policy/i }))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ applyToInProgress: true })),
    )
    expect(
      await screen.findByText(/memos already in progress follow these rules from now on too/i),
    ).toBeInTheDocument()
    expect(await reachSwitch()).not.toBeChecked()
  })

  it('does not offer the choice when nothing is in progress', async () => {
    renderWithProviders(<WorkflowPolicyPage />)

    await screen.findByRole('button', { name: /save policy/i })
    expect(screen.queryByRole('switch', { name: /also apply these rules/i })).not.toBeInTheDocument()
  })
})
