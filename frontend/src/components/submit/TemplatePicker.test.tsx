import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchActiveTemplate,
  fetchActiveTemplates,
} from '../../services/workflowTemplateApi'
import type {
  WorkflowTemplate,
  WorkflowTemplateSummary,
} from '../../types/workflowTemplate'
import TemplatePicker from './TemplatePicker'

/**
 * Picking a saved approval route instead of building one by hand.
 *
 * This is a list a preparer chooses from once and then trusts, so the states
 * around the list matter more than the list: an organisation with no
 * published templates must be told that is what it is looking at rather than
 * left with a blank panel, a failed load must be recoverable without
 * reloading the page, and choosing must actually fetch the template's graph -
 * the summary alone cannot say where this document would go.
 */

vi.mock('../../services/workflowTemplateApi', () => ({
  fetchActiveTemplates: vi.fn(),
  fetchActiveTemplate: vi.fn(),
}))

const listTemplates = vi.mocked(fetchActiveTemplates)
const openTemplate = vi.mocked(fetchActiveTemplate)

function summary(overrides: Partial<WorkflowTemplateSummary> = {}): WorkflowTemplateSummary {
  return {
    id: 'tpl-1',
    name: 'Standard purchase approval',
    description: 'Line manager, then finance, then the CFO.',
    isActive: true,
  archivedAt: null,
    createdById: 'admin-1',
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    ...overrides,
  }
}

function full(overrides: Partial<WorkflowTemplate> = {}): WorkflowTemplate {
  return {
    ...summary(),
    graph: { nodes: [], edges: [] },
    ...overrides,
  }
}

const CAPEX = summary({
  id: 'tpl-2',
  name: 'Capital expenditure',
  description: null,
})

/** A promise the test decides when to settle, for asserting the in-flight state. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

function renderPicker(
  overrides: { selectedId?: string | null; problem?: string | null } = {},
) {
  const onSelect = vi.fn()
  render(
    <TemplatePicker
      selectedId={overrides.selectedId ?? null}
      problem={overrides.problem ?? null}
      onSelect={onSelect}
    />,
  )
  return { onSelect }
}

beforeEach(() => {
  // `restoreMocks` restores spies, not the call log of a module mock.
  listTemplates.mockReset()
  openTemplate.mockReset()
  listTemplates.mockResolvedValue([summary(), CAPEX])
  openTemplate.mockResolvedValue(full())
})

describe('the list', () => {
  it('offers every published template as a choice a person can make', async () => {
    renderPicker()

    expect(
      await screen.findByRole('radio', { name: /Standard purchase approval/ }),
    ).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Capital expenditure/ })).toBeInTheDocument()
  })

  it('groups them so a screen reader knows only one can be chosen', async () => {
    renderPicker()

    expect(
      await screen.findByRole('radiogroup', { name: 'Workflow template' }),
    ).toBeInTheDocument()
  })

  it('shows the description, which is the only clue to what a route does', async () => {
    renderPicker()

    // Read as part of the radio it belongs to. A description rendered loose on
    // the panel, or under the wrong template, is how a preparer picks the
    // route that matches the sentence they read rather than the one they
    // pressed.
    expect(
      await screen.findByRole('radio', {
        name: /Standard purchase approval.*Line manager, then finance, then the CFO\./,
      }),
    ).toBeInTheDocument()
    // ...and not attached to the other one.
    expect(
      screen.getByRole('radio', { name: 'Capital expenditure' }),
    ).toBeInTheDocument()
  })

  it('copes with a template that was saved without a description', async () => {
    listTemplates.mockResolvedValue([CAPEX])
    renderPicker()

    expect(
      await screen.findByRole('radio', { name: 'Capital expenditure' }),
    ).toBeInTheDocument()
  })

  it('marks the chosen one in words, not by tinting the card', async () => {
    renderPicker({ selectedId: 'tpl-2' })

    // aria-checked is the whole answer here: the selected card differs only
    // by background colour and a tick drawn inside an aria-hidden span.
    const chosen = await screen.findByRole('radio', { name: 'Capital expenditure' })
    expect(chosen).toBeChecked()
    expect(
      screen.getByRole('radio', { name: /Standard purchase approval/ }),
    ).not.toBeChecked()
  })
})

describe('when there is nothing to choose from', () => {
  it('says the organisation has published none, and what to do instead', async () => {
    // A blank panel here is indistinguishable from a broken one. The preparer
    // needs to know the hand-built chain is the way forward.
    listTemplates.mockResolvedValue([])
    renderPicker()

    expect(
      await screen.findByText('No workflow templates are published yet'),
    ).toBeInTheDocument()
    expect(screen.getByText(/build the approval chain by hand/i)).toBeInTheDocument()
  })

  it('offers no phantom radio group when the list came back empty', async () => {
    listTemplates.mockResolvedValue([])
    renderPicker()

    await screen.findByText('No workflow templates are published yet')
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  })
})

describe('when the list cannot be loaded', () => {
  it('says what went wrong instead of showing an empty picker', async () => {
    // "No templates published" and "the server did not answer" call for two
    // different actions from the person reading it.
    listTemplates.mockRejectedValue(new Error('Network request failed'))
    renderPicker()

    expect(await screen.findByRole('alert')).toHaveTextContent('Network request failed')
    expect(
      screen.queryByText('No workflow templates are published yet'),
    ).not.toBeInTheDocument()
  })

  it('recovers on Try again without the page being reloaded', async () => {
    const user = userEvent.setup({ delay: null })
    listTemplates.mockRejectedValueOnce(new Error('Network request failed'))
    renderPicker()

    await user.click(await screen.findByRole('button', { name: /Try again/ }))

    expect(
      await screen.findByRole('radio', { name: /Standard purchase approval/ }),
    ).toBeInTheDocument()
    expect(listTemplates).toHaveBeenCalledTimes(2)
    // The stale failure has to go with it. A red "Network request failed"
    // sitting above a list that loaded fine is the picker telling a preparer
    // not to trust what they are looking at.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Network request failed')).not.toBeInTheDocument()
  })

  it('never flashes "none published" at a list that is still loading', async () => {
    // The three states are mutually exclusive and the order they are checked
    // in is load-bearing. Checking `templates.length === 0` before `loading`
    // would show "No workflow templates are published yet" to every preparer
    // on every visit, and some of them would believe it and stop looking.
    // (What the loading branch does say is covered separately below.)
    const pending = deferred<WorkflowTemplateSummary[]>()
    listTemplates.mockReturnValue(pending.promise)
    renderPicker()

    expect(
      screen.queryByText('No workflow templates are published yet'),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    pending.resolve([summary()])
    expect(
      await screen.findByRole('radio', { name: /Standard purchase approval/ }),
    ).toBeInTheDocument()
  })

  it('announces the wait while the templates are being fetched', () => {
    // The skeletons are aria-hidden, correctly - they carry no information.
    // That leaves nothing for a screen reader to hear, so the wait has to be
    // announced separately or the person gets silence and then, without
    // warning, a radio group. `LoadingAnnouncer` exists for exactly this and
    // is used on five other pages.
    listTemplates.mockReturnValue(deferred<WorkflowTemplateSummary[]>().promise)
    renderPicker()

    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })
})

describe('choosing one', () => {
  it('fetches the full template, since the summary cannot say where this goes', async () => {
    const user = userEvent.setup({ delay: null })
    const { onSelect } = renderPicker()

    await user.click(await screen.findByRole('radio', { name: /Standard purchase approval/ }))

    // The routing preview and the "can this template even complete?" check
    // both read the graph, which only the detail response carries.
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(full()))
    expect(openTemplate).toHaveBeenCalledWith('tpl-1')
  })

  it('lets the preparer un-choose it and go back to a hand-built chain', async () => {
    const user = userEvent.setup({ delay: null })
    const { onSelect } = renderPicker({ selectedId: 'tpl-1' })

    await user.click(await screen.findByRole('radio', { name: /Standard purchase approval/ }))

    expect(onSelect).toHaveBeenCalledWith(null)
    // Un-choosing is local, so asking the server again would be a wasted
    // round trip on a click that cannot fail.
    expect(openTemplate).not.toHaveBeenCalled()
  })

  it('refuses a second choice while the first is still opening', async () => {
    const user = userEvent.setup({ delay: null })
    const pending = deferred<WorkflowTemplate>()
    openTemplate.mockReturnValue(pending.promise)
    const { onSelect } = renderPicker()

    await user.click(await screen.findByRole('radio', { name: /Standard purchase approval/ }))

    // Two overlapping fetches can land out of order, and the document would
    // then be routed through a template the preparer sees unticked.
    const other = screen.getByRole('radio', { name: 'Capital expenditure' })
    expect(other).toBeDisabled()

    // Disabled has to mean the press does nothing, not merely that the card
    // looks faded: the second fetch never starts and the parent is never told
    // about a template the preparer did not end up on.
    await user.click(other)
    expect(openTemplate).toHaveBeenCalledTimes(1)
    expect(openTemplate).toHaveBeenCalledWith('tpl-1')
    expect(onSelect).not.toHaveBeenCalled()

    // ...and the lock lifts once the fetch lands, rather than stranding the
    // group disabled for the rest of the session.
    pending.resolve(full())
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(full()))
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Capital expenditure' })).toBeEnabled(),
    )
  })

  it('says so when the chosen template will not open', async () => {
    const user = userEvent.setup({ delay: null })
    openTemplate.mockRejectedValue(new Error('Template was withdrawn'))
    const { onSelect } = renderPicker()

    await user.click(await screen.findByRole('radio', { name: /Standard purchase approval/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Template was withdrawn')
    // Silence plus an unticked radio would read as a dead control.
    expect(onSelect).not.toHaveBeenCalled()
    // And the failure is recoverable in place. A picker that swallowed the
    // click, left the group disabled and offered no way back would force a
    // page reload, which on this screen means retyping the whole form.
    expect(screen.getByRole('button', { name: /Try again/ })).toBeEnabled()
  })

  it('moves between templates with the arrow keys, as a radio group should', async () => {
    // These are `role="radio"` inside a `role="radiogroup"`, and that role
    // is a promise: a screen-reader user in forms mode will arrow through the
    // group and conclude it is broken if nothing moves. Claiming the role
    // without honouring the keys is worse than not claiming it.
    const user = userEvent.setup({ delay: null })
    renderPicker()

    const first = await screen.findByRole('radio', { name: /Standard purchase approval/ })
    first.focus()
    await user.keyboard('{ArrowDown}')

    expect(screen.getByRole('radio', { name: 'Capital expenditure' })).toHaveFocus()
  })

  it('is still fully reachable by Tab, whatever the arrow keys do', async () => {
    const user = userEvent.setup({ delay: null })
    const { onSelect } = renderPicker()

    await screen.findByRole('radio', { name: /Standard purchase approval/ })
    await user.tab()
    expect(screen.getByRole('radio', { name: /Standard purchase approval/ })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('radio', { name: 'Capital expenditure' })).toHaveFocus()

    openTemplate.mockResolvedValue(full({ id: 'tpl-2', name: 'Capital expenditure' }))
    await user.keyboard('{Enter}')

    await waitFor(() => expect(openTemplate).toHaveBeenCalledWith('tpl-2'))
    // The keyboard press has to complete the same choice a click does, all
    // the way to the parent - stopping at "the fetch was started" would pass
    // for a picker that never handed the template on.
    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(full({ id: 'tpl-2', name: 'Capital expenditure' })),
    )
  })
})

describe('a template that cannot route this document', () => {
  it('warns about it where the choice was made', async () => {
    // The compiled chain depends on this document's title, so a template that
    // is fine in the designer can still produce a route with no final
    // approver here. Finding that out after signing is the failure to avoid.
    renderPicker({
      selectedId: 'tpl-1',
      problem:
        'This template does not end in exactly one final approver for this document.',
    })

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This template does not end in exactly one final approver for this document.',
    )
  })

  it('keeps quiet when the chosen template routes cleanly', async () => {
    renderPicker({ selectedId: 'tpl-1' })

    await screen.findByRole('radio', { name: /Standard purchase approval/ })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
