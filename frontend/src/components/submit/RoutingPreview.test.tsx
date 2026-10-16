import { render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it } from 'vitest'
import type { AssignableUser } from '../../types/submitDocument'
import RoutingPreview, { type PreviewStep } from './RoutingPreview'

/**
 * The panel that answers "where does this go once I sign it?".
 *
 * It is the only place on the submit screen where the whole route is visible
 * at once, and a preparer signs on the strength of it. So the two things that
 * must never be wrong are the order - the document really does travel down
 * this list - and the names, because signing a document to the wrong Final
 * Approver is not a mistake anyone catches until the queue goes quiet.
 */

function person(overrides: Partial<AssignableUser> = {}): AssignableUser {
  return {
    id: 'user-1',
    email: 'bilal.ahmed@example.com',
    firstName: 'Bilal',
    lastName: 'Ahmed',
    department: null,
    ...overrides,
  }
}

function step(overrides: Partial<PreviewStep> = {}): PreviewStep {
  return {
    key: 'step-1',
    approvalType: 'REVIEWER',
    user: person(),
    ...overrides,
  }
}

function renderPreview(
  overrides: Partial<ComponentProps<typeof RoutingPreview>> = {},
) {
  return render(
    <RoutingPreview
      preparer={{ firstName: 'Ayesha', lastName: 'Khan' }}
      steps={[step()]}
      {...overrides}
    />,
  )
}

describe('who handles the document', () => {
  it('opens with the preparer, who signs before anyone else sees it', () => {
    renderPreview()

    expect(screen.getByText('Ayesha Khan')).toBeInTheDocument()
    expect(screen.getByText('Preparer · signs before submitting')).toBeInTheDocument()
  })

  it('falls back to "You" while the signed-in user is still loading', () => {
    // A blank first row would read as a route with no signer on it, on the
    // screen whose entire job is to say who touches the document.
    renderPreview({ preparer: null })

    // In the first row specifically - a stray "You" further down the list
    // would be a different bug wearing the same word.
    const first = screen.getAllByRole('listitem')[0]
    expect(within(first).getByText('You')).toBeInTheDocument()
    expect(within(first).getByText('Preparer · signs before submitting')).toBeInTheDocument()
  })

  it('names each approver and what they are being asked to do', () => {
    renderPreview({
      steps: [
        step({ key: 's1', approvalType: 'REVIEWER', user: person() }),
        step({
          key: 's2',
          approvalType: 'FINAL_APPROVER',
          user: person({ id: 'user-2', firstName: 'Chandni', lastName: 'Rao' }),
        }),
      ],
    })

    // Asserted row by row. Both names and both roles being *somewhere* on the
    // panel is exactly what a component that paired them the wrong way round
    // would also satisfy - and "Reviewer" and "Final Approver" are different
    // powers: only the final approver's yes closes the workflow, so reading
    // them off the wrong people is the mistake this panel exists to prevent.
    const [, reviewer, finalApprover] = screen.getAllByRole('listitem')

    expect(within(reviewer).getByText('Bilal Ahmed')).toBeInTheDocument()
    expect(within(reviewer).getByText('Reviewer')).toBeInTheDocument()
    expect(within(reviewer).queryByText('Final Approver')).not.toBeInTheDocument()

    expect(within(finalApprover).getByText('Chandni Rao')).toBeInTheDocument()
    expect(within(finalApprover).getByText('Final Approver')).toBeInTheDocument()
  })

  it('says a step is unassigned rather than leaving the row blank', () => {
    renderPreview({ steps: [step({ user: null })] })

    // An empty name reads as a loading row. "Not assigned yet" is the reason
    // the submit button is going to refuse.
    const row = screen.getAllByRole('listitem')[1]
    expect(within(row).getByText('Not assigned yet')).toBeInTheDocument()
    // The role it is waiting to be filled by is still stated, so the gap is
    // "no reviewer yet" rather than an unexplained hole in the route.
    expect(within(row).getByText('Reviewer')).toBeInTheDocument()
  })

  it('adds the department, so two people with one name are told apart', () => {
    renderPreview({
      steps: [
        step({ approvalType: 'APPROVER', user: person({ department: { name: 'Finance' } }) }),
      ],
    })

    expect(screen.getByText('Approver · Finance')).toBeInTheDocument()
  })

  it('leaves the department out rather than trailing a bare separator', () => {
    renderPreview({ steps: [step({ approvalType: 'APPROVER' })] })

    const row = screen.getAllByRole('listitem')[1]
    expect(within(row).getByText('Approver')).toBeInTheDocument()
    // "Approver ·" with nothing after it reads as a department that failed to
    // load, on a row where the department is the disambiguator.
    expect(row.textContent).not.toMatch(/·/)
  })
})

describe('the order it travels in', () => {
  it('keeps the chain in the order the document will actually move', () => {
    renderPreview({
      steps: [
        step({ key: 's1', user: person({ firstName: 'Bilal', lastName: 'Ahmed' }) }),
        step({
          key: 's2',
          approvalType: 'APPROVER',
          user: person({ id: 'u2', firstName: 'Chandni', lastName: 'Rao' }),
        }),
        step({
          key: 's3',
          approvalType: 'FINAL_APPROVER',
          user: person({ id: 'u3', firstName: 'Danish', lastName: 'Iqbal' }),
        }),
      ],
    })

    // Reordering two approvers changes who can still stop the document, so a
    // preview that showed them in any other order would be worse than none.
    const rows = screen.getAllByRole('listitem').map(row => row.textContent ?? '')
    expect(rows[0]).toContain('Ayesha Khan')
    expect(rows[1]).toContain('Bilal Ahmed')
    expect(rows[2]).toContain('Chandni Rao')
    expect(rows[3]).toContain('Danish Iqbal')
    expect(rows[rows.length - 1]).toContain('Approved')
  })

  it('survives a route with a great many steps in it', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      step({
        key: `s${index}`,
        user: person({ id: `u${index}`, firstName: 'Approver', lastName: `${index + 1}` }),
      }),
    )
    renderPreview({ steps: many })

    // preparer + 12 + the Approved terminus
    expect(screen.getAllByRole('listitem')).toHaveLength(14)
  })
})

describe('when there is no route yet', () => {
  it('explains the gap when it is given wording for it', () => {
    renderPreview({ steps: [], emptyLabel: 'No template chosen yet' })

    // Between the preparer and the terminus, in the place the missing
    // approvers would occupy - not appended after "Approved".
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(within(rows[1]).getByText('No template chosen yet')).toBeInTheDocument()
  })

  it('drops the placeholder the moment there is a real route to show', () => {
    // The negative half of the same rule. A placeholder that stayed on once
    // approvers had been added would put a phantom step in the middle of the
    // chain, and the preparer would count one more approval than the document
    // is actually going to need.
    renderPreview({
      steps: [step()],
      emptyLabel: 'No template chosen yet',
    })

    expect(screen.queryByText('No template chosen yet')).not.toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('explains the gap even when it is given no wording', () => {
    // The submit screen passes `emptyLabel` only in template mode, so this
    // component has to carry wording of its own. Without it a hand-built
    // chain with nothing in it yet rendered "Ayesha Khan → Approved" - a
    // route that looks complete and promises the document ends up approved,
    // with no approver on it at all.
    renderPreview({ steps: [] })

    expect(
      screen.getByText(/no approvers|nobody|not routed|add an approver/i),
    ).toBeInTheDocument()
  })
})

describe('what the panel promises', () => {
  it('warns that a conditional template can send it somewhere else', () => {
    // The preview is computed from the title and description typed so far.
    // Without this line a preparer would read a branch-dependent route as a
    // commitment and never look at it again.
    renderPreview({ branching: true })

    expect(screen.getByText(/routes conditionally/i)).toBeInTheDocument()
  })

  it('stays quiet about branching for a chain built by hand', () => {
    renderPreview({ branching: false })

    expect(screen.queryByText(/routes conditionally/i)).not.toBeInTheDocument()
  })

  it('does not promise an approval a chain like this cannot reach', () => {
    // The "Approved · Final approver closes the workflow" terminus is drawn
    // only for a chain that can actually reach it. Drawn unconditionally - as
    // it was - a chain ending in a reviewer showed the document finishing as
    // Approved, when that chain can never complete and the submit button will
    // refuse it outright.
    renderPreview({
      steps: [step({ approvalType: 'REVIEWER' }), step({ key: 's2', approvalType: 'APPROVER' })],
    })

    expect(screen.queryByText('Approved')).not.toBeInTheDocument()
  })
})
