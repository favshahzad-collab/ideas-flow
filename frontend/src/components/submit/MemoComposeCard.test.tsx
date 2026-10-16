import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { fetchMemoTypes } from '../../services/memoApi'
import type {
  MemoBody,
  MemoPageGeometry,
  MemoTypeDefinition,
} from '../../types/memo'
import MemoComposeCard from './MemoComposeCard'

/**
 * Writing the memo rather than attaching one.
 *
 * The header fields are the part worth testing hardest. They look like two
 * more text boxes and they are not: the template draws them as a block and
 * the server stores them as columns, so a memo whose addressee ends up as a
 * sentence somewhere in the prose cannot afterwards be listed, filtered or
 * reported on. Nothing on screen says that, which is exactly why it has to be
 * impossible to type the memo without them.
 */

vi.mock('../../services/memoApi', () => ({ fetchMemoTypes: vi.fn() }))
vi.mock('../../services/memoClausesApi', () => ({
  fetchStandardWording: vi.fn().mockResolvedValue({ clauses: [] }),
}))
vi.mock('../../services/memoDictionaryApi', () => ({
  fetchDictionaryWords: vi.fn().mockResolvedValue([]),
  addMemoDictionaryWord: vi.fn(),
}))

const listTypes = vi.mocked(fetchMemoTypes)

const memoType = (overrides: Partial<MemoTypeDefinition> = {}): MemoTypeDefinition => ({
  key: 'APPROVAL_REQUEST',
  label: 'Approval Request',
  description: 'Revision of a fuel or vehicle maintenance allowance.',
  outlineHeadings: ['BACKGROUND:', 'Recommendation'],
  ...overrides,
})

const emptyBody: MemoBody = { type: 'doc', content: [{ type: 'paragraph' }] }

const body = (text: string): MemoBody => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

function setup(props: Partial<React.ComponentProps<typeof MemoComposeCard>> = {}) {
  const onMemoTypeChange = vi.fn()
  const onTitleChange = vi.fn()
  const onMemoToChange = vi.fn()
  const onMemoFromChange = vi.fn()
  const onMemoDateChange = vi.fn()
  const onBodyChange = vi.fn()

  const render_ = (extra: Partial<React.ComponentProps<typeof MemoComposeCard>>) => (
    <MemoComposeCard
      memoType={null}
      title=""
      memoTo=""
      memoFrom=""
      memoDate="2026-08-06"
      body={emptyBody}
      error={null}
      onMemoTypeChange={onMemoTypeChange}
      onTitleChange={onTitleChange}
      onMemoToChange={onMemoToChange}
      onMemoFromChange={onMemoFromChange}
      onMemoDateChange={onMemoDateChange}
      onBodyChange={onBodyChange}
      {...props}
      {...extra}
    />
  )

  const view = render(render_({}))

  return {
    onMemoTypeChange,
    onTitleChange,
    onMemoToChange,
    onMemoFromChange,
    onMemoDateChange,
    onBodyChange,
    /** Re-render with the same props, plus whatever is passed here. */
    rerender: (extra: Partial<React.ComponentProps<typeof MemoComposeCard>> = {}) =>
      view.rerender(render_(extra)),
  }
}


/**
 * The memo-types call now answers with the page as well as the types.
 *
 * The page is what sizes the column the preparer types into, so the composer
 * asks for both in one request. These tests are about the types, so the page
 * is the delivered default unless a test says otherwise.
 */
const DEFAULT_PAGE: MemoPageGeometry = {
  paper: 'A4',
  marginLeft: 43.2,
  marginRight: 43.2,
  marginTop: 57.6,
  marginBottom: 57.6,
  width: 595.28,
  height: 841.89,
  textWidth: 508.88,
  textHeight: 726.69,
}

const typesResponse = (
  memoTypes: ReturnType<typeof memoType>[],
  page = DEFAULT_PAGE,
) => ({ memoTypes, page })

describe('when there is only one kind of memo', () => {
  /*
   * Choosing is required - the step will not continue without a type - so a
   * deployment with one type asked a question with one answer and then
   * blocked on it. The answer is taken automatically and the picker is not
   * shown, which is the difference between a form and an interrogation.
   */
  it('chooses it without asking', async () => {
    listTypes.mockResolvedValue(typesResponse([memoType()]))
    const { onMemoTypeChange } = setup()

    await waitFor(() => expect(onMemoTypeChange).toHaveBeenCalled())
    expect(onMemoTypeChange).toHaveBeenCalledWith(
      'APPROVAL_REQUEST',
      expect.anything(),
      true,
    )
  })

  it('does not show a question with one answer', async () => {
    listTypes.mockResolvedValue(typesResponse([memoType()]))
    setup()

    await waitFor(() => {
      expect(screen.queryByLabelText(/Approval Request/)).not.toBeVisible()
    })
  })

  it('still asks when there are two', async () => {
    listTypes.mockResolvedValue(
      typesResponse([
        memoType(),
        memoType({ key: 'LEAVE', label: 'Leave Request', description: 'Time off.' }),
      ]),
    )
    const { onMemoTypeChange } = setup()

    expect(await screen.findByLabelText(/Approval Request/)).toBeVisible()
    expect(screen.getByLabelText(/Leave Request/)).toBeVisible()
    // And nothing was chosen on the preparer's behalf.
    expect(onMemoTypeChange).not.toHaveBeenCalled()
  })

  it('still shows the failure when the list could not be loaded', async () => {
    /*
     * A list that failed to load is an empty list, and hiding the picker for
     * "fewer than two" hid the message saying so - leaving a step that
     * refuses to continue and nothing on screen explaining why. Hiding is for
     * exactly one type, never for none.
     */
    listTypes.mockRejectedValue(new Error('nope'))
    setup()

    const alert = await screen.findByRole('alert')
    expect(alert).toBeVisible()
    expect(alert).toHaveTextContent(/could not be loaded/i)
  })

  it('leaves a reopened draft on the type it was written as', async () => {
    /*
     * The seeding trap. A draft already carrying a type must not be reset to
     * the only one in the list - and more importantly must not have that
     * type's outline dropped back on top of what somebody wrote.
     */
    listTypes.mockResolvedValue(typesResponse([memoType()]))
    const { onMemoTypeChange } = setup({ memoType: 'APPROVAL_REQUEST' })

    await screen.findByText(/Write the memo/)
    expect(onMemoTypeChange).not.toHaveBeenCalled()
  })
})

describe('the page the memo will be filed on', () => {
  /*
   * The preparer types into a column, and that column has to be the one the
   * memo is actually filed at - it is where a table's widths are measured and
   * where a wrap is judged. Before page setup existed it was hardcoded to A4;
   * now an administrator can change it, and the sheet has to follow.
   */
  const sheetOf = () => document.querySelector('.memo-sheet') as HTMLElement

  it('sizes the sheet from the page the server sent', async () => {
    listTypes.mockResolvedValue(
      typesResponse([memoType()], {
        ...DEFAULT_PAGE,
        paper: 'LETTER',
        marginLeft: 90,
        marginRight: 36,
        width: 612,
        height: 792,
        textWidth: 486,
        textHeight: 672,
      }),
    )

    setup()
    await screen.findByLabelText(/Approval Request/)

    const sheet = sheetOf()
    // 90/612 and 36/612 as percentages, and the column in points.
    expect(sheet.style.getPropertyValue('--memo-margin-left')).toBe(
      `${(90 / 612) * 100}%`,
    )
    expect(sheet.style.getPropertyValue('--memo-margin-right')).toBe(
      `${(36 / 612) * 100}%`,
    )
    expect(sheet.style.getPropertyValue('--memo-text-width')).toBe('486')
  })

  it('gives the two side margins different values when they differ', async () => {
    // A gutter for a punch hole is the reason they are separate; a single
    // `padding-inline` would have silently averaged them away.
    listTypes.mockResolvedValue(
      typesResponse([memoType()], { ...DEFAULT_PAGE, marginLeft: 90, marginRight: 36 }),
    )

    setup()
    await screen.findByLabelText(/Approval Request/)

    const sheet = sheetOf()
    expect(sheet.style.getPropertyValue('--memo-margin-left')).not.toBe(
      sheet.style.getPropertyValue('--memo-margin-right'),
    )
  })

  it('leaves the delivered default in place until the page arrives', async () => {
    /*
     * Never briefly the wrong width. Setting nothing lets the CSS fallback -
     * A4 less two 43.2pt margins - answer, which is what every memo filed
     * before page setup existed was drawn at.
     */
    listTypes.mockReturnValue(new Promise(() => {}))

    setup()

    expect(sheetOf().style.getPropertyValue('--memo-text-width')).toBe('')
  })
})

describe('choosing what kind of memo this is', () => {
  it('offers every type the server knows about', async () => {
    listTypes.mockResolvedValue(typesResponse([
      memoType(),
      memoType({ key: 'LEAVE', label: 'Leave Request', description: 'Time off.' }),
    ]))

    setup()

    expect(await screen.findByLabelText(/Approval Request/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Leave Request/)).toBeInTheDocument()
  })

  it('hands back the type and an outline to start from', async () => {
    listTypes.mockResolvedValue(typesResponse([memoType()]))
    const { onMemoTypeChange } = setup()

    await userEvent.click(await screen.findByLabelText(/Approval Request/))

    const [key, outline] = onMemoTypeChange.mock.calls[0]!
    expect(key).toBe('APPROVAL_REQUEST')
    // Headings only. The prose is the preparer's, and a memo pre-filled with
    // sentences nobody wrote is worse than a blank page.
    expect(JSON.stringify(outline)).toContain('BACKGROUND:')
    expect(JSON.stringify(outline)).not.toContain('It is submitted')
  })

  it('says so when the list cannot be loaded, and offers the way round it', async () => {
    /*
     * Not swallowed, unlike the conveniences elsewhere on this form. Without
     * the list there is nothing to choose and the step cannot be completed,
     * so silence would leave somebody staring at an empty panel with no idea
     * that attaching a PDF still works.
     */
    listTypes.mockRejectedValue(new Error('offline'))

    setup()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/could not be loaded/i)
    expect(alert).toHaveTextContent(/attach a PDF instead/i)
  })
})

describe('the header block', () => {
  it('collects the addressee and the department as fields of their own', async () => {
    listTypes.mockResolvedValue(typesResponse([memoType()]))
    const { onMemoToChange, onMemoFromChange } = setup()

    await userEvent.type(await screen.findByLabelText('To:'), 'X')
    await userEvent.type(screen.getByLabelText('From:'), 'Y')

    expect(onMemoToChange).toHaveBeenCalledWith('X')
    expect(onMemoFromChange).toHaveBeenCalledWith('Y')
  })

  it('shows what is missing once a submission has been attempted', async () => {
    listTypes.mockResolvedValue(typesResponse([memoType()]))
    setup({ error: 'Say who the memo is addressed to.' })

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('addressed to'),
    )
  })
})

describe('the editor', () => {
  it('is a labelled multi-line region', async () => {
    listTypes.mockResolvedValue(typesResponse([memoType()]))
    setup()

    const region = await screen.findByRole('textbox', { name: 'The memo' })
    expect(region).toHaveAttribute('aria-multiline', 'true')
  })

  it('names the memo as invalid when the step is', async () => {
    listTypes.mockResolvedValue(typesResponse([memoType()]))
    setup({ error: 'Write the memo before submitting it.' })

    const region = await screen.findByRole('textbox', { name: 'The memo' })
    expect(region).toHaveAttribute('aria-invalid', 'true')
    // Pointed at the message rather than merely marked wrong, so a screen
    // reader announces what is wrong and not just that something is.
    expect(region).toHaveAttribute('aria-describedby')
  })

  it('says what will be added by the system, so nobody types it themselves', async () => {
    listTypes.mockResolvedValue(typesResponse([memoType()]))
    setup()

    // By the sentence rather than the word: the sheet itself now carries a
    // "Letterhead" marker where the logo will be printed, so the word alone
    // matches two things on the screen.
    const note = await screen.findByText(/the letterhead and the reference number/i)
    expect(note).toHaveTextContent(/signature lines/i)
    expect(note).toHaveTextContent(/before you sign it/i)
  })
})

describe('choosing a type after the editor is on screen', () => {
  it('puts the outline into the editor, not only into the state', async () => {
    /*
     * The editor is uncontrolled - the DOM is its model - so it seeds itself
     * once and ignores the prop afterwards. That is what stops a parent
     * re-render replacing what somebody is typing, and it also meant that
     * choosing a type changed the state and nothing on the screen: the
     * headings never appeared and the choice looked like it did nothing.
     *
     * Written as a rerender with the new props, which is what the page does.
     */
    listTypes.mockResolvedValue(typesResponse([memoType()]))

    const outline: MemoBody = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'BACKGROUND:' }] },
        { type: 'paragraph' },
      ],
    }

    const { rerender } = render(
      <MemoComposeCard
        memoType={null}
        title=""
        memoTo=""
        memoFrom=""
        memoDate="2026-08-06"
        body={emptyBody}
        error={null}
        onMemoTypeChange={vi.fn()}
        onTitleChange={vi.fn()}
        onMemoToChange={vi.fn()}
        onMemoFromChange={vi.fn()}
        onMemoDateChange={vi.fn()}
        onBodyChange={vi.fn()}
      />,
    )

    const before = await screen.findByRole('textbox', { name: 'The memo' })
    expect(before).not.toHaveTextContent('BACKGROUND:')

    rerender(
      <MemoComposeCard
        memoType="APPROVAL_REQUEST"
        title=""
        memoTo=""
        memoFrom=""
        memoDate="2026-08-06"
        body={outline}
        error={null}
        onMemoTypeChange={vi.fn()}
        onTitleChange={vi.fn()}
        onMemoToChange={vi.fn()}
        onMemoFromChange={vi.fn()}
        onMemoDateChange={vi.fn()}
        onBodyChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('textbox', { name: 'The memo' })).toHaveTextContent(
      'BACKGROUND:',
    )
  })

  it('keeps what was already written when the type changes', async () => {
    // The remount reseeds from whatever body it is given, and the page only
    // hands over an outline for a body nobody has written in - so a change of
    // mind about the type must not cost somebody their memo.
    listTypes.mockResolvedValue(typesResponse([memoType(), memoType({ key: 'LEAVE', label: 'Leave' })]))

    const written = body('Already written by hand.')

    const { rerender } = render(
      <MemoComposeCard
        memoType="APPROVAL_REQUEST"
        title=""
        memoTo=""
        memoFrom=""
        memoDate="2026-08-06"
        body={written}
        error={null}
        onMemoTypeChange={vi.fn()}
        onTitleChange={vi.fn()}
        onMemoToChange={vi.fn()}
        onMemoFromChange={vi.fn()}
        onMemoDateChange={vi.fn()}
        onBodyChange={vi.fn()}
      />,
    )

    await screen.findByRole('textbox', { name: 'The memo' })

    rerender(
      <MemoComposeCard
        memoType="LEAVE"
        title=""
        memoTo=""
        memoFrom=""
        memoDate="2026-08-06"
        body={written}
        error={null}
        onMemoTypeChange={vi.fn()}
        onTitleChange={vi.fn()}
        onMemoToChange={vi.fn()}
        onMemoFromChange={vi.fn()}
        onMemoDateChange={vi.fn()}
        onBodyChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('textbox', { name: 'The memo' })).toHaveTextContent(
      'Already written by hand.',
    )
  })
})

describe('the memo being kept on the server', () => {
  it('says when it is saving and when it is saved', () => {
    const { rerender } = setup({ saveState: 'saving' })
    expect(screen.getByText('Saving…')).toBeInTheDocument()

    rerender({ saveState: 'saved' })

    expect(screen.queryByText('Saving…')).not.toBeInTheDocument()
    expect(screen.getByText('Saved to your drafts')).toBeInTheDocument()
  })

  it('says so when the save failed, without claiming the work is lost', () => {
    setup({ saveState: 'error' })

    // The local draft still holds it, so the message says which of the two
    // has it rather than implying the memo is gone.
    expect(
      screen.getByText(/Not saved to your drafts — this device still has it/),
    ).toBeInTheDocument()
  })

  it('says nothing before anything has been saved', () => {
    setup({ saveState: 'idle' })

    expect(screen.queryByText(/drafts/)).not.toBeInTheDocument()
  })

  it('announces the change politely, between keystrokes', () => {
    setup({ saveState: 'saved' })

    const live = screen.getByText('Saved to your drafts')
    expect(live).toHaveAttribute('aria-live', 'polite')
  })
})

describe('putting a memo back into the editor from outside', () => {
  it('shows the restored memo rather than the one already on screen', () => {
    /*
     * The editor is uncontrolled: it reads `initialBody` once. Restoring a
     * draft used to put the memo into state and leave the old text on the
     * page, so the preparer signed whichever of the two they could not see.
     */
    const { rerender } = setup({ body: body('The first attempt.'), seed: 0 })
    expect(screen.getByRole('textbox', { name: 'The memo' })).toHaveTextContent(
      'The first attempt.',
    )

    rerender({ body: body('The memo that was restored.'), seed: 1 })

    expect(screen.getByRole('textbox', { name: 'The memo' })).toHaveTextContent(
      'The memo that was restored.',
    )
  })

  it('does not reseed while somebody is typing', () => {
    const { rerender } = setup({ body: body('Half a sentence'), seed: 3 })

    // Same seed, new body: this is the editor telling the form what it holds,
    // not the form telling the editor. Reseeding here would fight the cursor.
    rerender({ body: body('Half a sentence and the rest'), seed: 3 })

    expect(screen.getByRole('textbox', { name: 'The memo' })).toHaveTextContent(
      'Half a sentence',
    )
  })
})
