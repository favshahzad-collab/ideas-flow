import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import SignatureInput from './SignatureInput'

/**
 * The panel inside the sign-and-approve modal where somebody chooses how they
 * are going to sign. Three things here have consequences outside the modal:
 * which signature is actually attached to the approval, whether a stray click
 * deletes the signature stored on their profile, and whether a failed upload
 * says so. The rest is instructions.
 */

type Props = ComponentProps<typeof SignatureInput>

const SAVED_URL = 'blob:http://localhost/saved-signature'

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    mode: 'draw',
    onModeChange: vi.fn(),
    onChange: vi.fn(),
    savedSignatureUrl: null,
    hasSavedSignature: false,
    onUploadSavedSignature: vi.fn<(file: File) => Promise<void>>().mockResolvedValue(undefined),
    onRemoveSavedSignature: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  }
}

/**
 * The file input is `display: none` and driven by the visible "Choose
 * image"/"Replace" buttons, which is the intended shape: it is out of the
 * accessibility tree and off the tab order, and those buttons are what carry
 * the name and the focus. Nothing to query it by, then - a querySelector is
 * the right way to reach it here, not a workaround for a missing label.
 */
function renderInput(overrides: Partial<Props> = {}) {
  const props = makeProps(overrides)
  const view = render(<SignatureInput {...props} />)
  const fileInput = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
  return { ...view, props, fileInput }
}

/** A promise the test settles when it wants the parent's request to finish. */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const savedProps = { mode: 'saved', savedSignatureUrl: SAVED_URL, hasSavedSignature: true } as const

describe('choosing how to sign', () => {
  it('offers both ways of signing at once', () => {
    renderInput()

    expect(screen.getByRole('button', { name: 'Draw' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Saved signature' })).toBeInTheDocument()
    // Both tabs are offered, but only the one in the props is showing. A
    // panel that ignores `mode` puts the upload prompt in front of somebody
    // who chose to draw, and neither button changes what they are reading.
    expect(screen.queryByText('Upload your signature once')).not.toBeInTheDocument()
  })

  it('attaches the stored signature as soon as the saved mode is showing one', () => {
    const { props } = renderInput(savedProps)

    // Nothing else attaches it. Without this the person sees their signature
    // on screen, presses Confirm, and submits an approval with no signature.
    expect(props.onChange).toHaveBeenCalledWith(SAVED_URL)
    // Once, not on every render. The parent turns this straight into state,
    // so an effect that re-fires each pass is a render loop inside a modal.
    expect(props.onChange).toHaveBeenCalledTimes(1)
  })

  it('attaches the replacement when the stored signature changes underneath it', () => {
    const { props, rerender } = renderInput(savedProps)
    const replaced = 'blob:http://localhost/replaced-signature'

    rerender(<SignatureInput {...props} savedSignatureUrl={replaced} />)

    // This is what Replace looks like from in here: same mode, new URL. If
    // the attach only watched the mode, the person would see the signature
    // they just uploaded and approve with the one they overwrote.
    expect(props.onChange).toHaveBeenLastCalledWith(replaced)
  })

  it('attaches nothing when the saved mode has nothing stored yet', () => {
    const { props } = renderInput({ mode: 'saved' })

    expect(props.onChange).not.toHaveBeenCalled()
  })

  it('does not attach the stored signature to a drawing', () => {
    // A person with a signature on file who chooses to draw instead: the
    // stored URL is still in props the whole time.
    const { props } = renderInput({
      mode: 'draw',
      savedSignatureUrl: SAVED_URL,
      hasSavedSignature: true,
    })

    // Attaching it here means the approval carries the profile signature
    // while the person watches themselves draw a different one.
    expect(props.onChange).not.toHaveBeenCalled()
  })

  it('drops the attached signature when you switch back to drawing', async () => {
    const user = userEvent.setup({ delay: null })
    const { props } = renderInput(savedProps)

    await user.click(screen.getByRole('button', { name: 'Draw' }))

    // Otherwise the saved image stays attached while the person believes they
    // are about to draw, and the document is signed with the wrong one.
    expect(props.onModeChange).toHaveBeenCalledWith('draw')
    expect(props.onChange).toHaveBeenLastCalledWith(null)
  })

  it('asks the parent to switch when the saved tab is pressed', async () => {
    const user = userEvent.setup({ delay: null })
    const { props } = renderInput()

    await user.click(screen.getByRole('button', { name: 'Saved signature' }))

    expect(props.onModeChange).toHaveBeenCalledWith('saved')
    // Only the draw direction clears. Detaching here would wipe a drawn
    // signature the moment somebody looked at the saved tab and came back.
    expect(props.onChange).not.toHaveBeenCalled()
  })

  // FIXED: was `it.fails`. `handleModeChange` now returns early when the
  // pressed tab is the one already showing.
  it('leaves the drawing alone when the mode it is already in is pressed again', async () => {
    const user = userEvent.setup({ delay: null })
    const { props } = renderInput({ mode: 'draw' })

    // Draw is already the active tab. Pressing it is a reflex - people tap
    // the mode they want before they start - and it should be a no-op.
    await user.click(screen.getByRole('button', { name: 'Draw' }))

    // Firing unconditionally had the parent clear the attached image, drop
    // the placement and bump the ink reset key: a signature already drawn on
    // the PDF vanished, with no warning beforehand and no way back after.
    expect(props.onChange).not.toHaveBeenCalled()
    expect(props.onModeChange).not.toHaveBeenCalled()
  })

  it('leaves the saved signature attached when the saved tab is pressed again', async () => {
    const user = userEvent.setup({ delay: null })
    const { props } = renderInput(savedProps)
    // The mount-time attach is the call this test is not interested in.
    vi.mocked(props.onChange).mockClear()

    await user.click(screen.getByRole('button', { name: 'Saved signature' }))

    // Same reflex from the other side. The parent clears the attached image
    // on any mode change, so a re-press that reached it would detach the
    // signature the person is looking at and refuse the approval afterwards.
    expect(props.onChange).not.toHaveBeenCalled()
    expect(props.onModeChange).not.toHaveBeenCalled()
  })

  // FIXED: was `it.fails`. The toggle is now a group of two aria-pressed
  // buttons instead of two plain ones told apart by fill colour.
  it('tells a screen reader which of the two modes is active', () => {
    renderInput()

    // The active mode used to be carried by background colour alone, so
    // somebody using a screen reader - or anyone who cannot separate the
    // accent from the surface - could not tell whether they were about to
    // draw or to use the signature on file. The two modes send completely
    // different requests.
    expect(screen.getByRole('button', { name: 'Draw' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Saved signature' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('moves the pressed state with the mode rather than pinning it to the first tab', () => {
    renderInput(savedProps)

    // A hard-coded `aria-pressed="true"` on Draw would pass the test above
    // and then lie in every other state, which is worse than saying nothing.
    expect(screen.getByRole('button', { name: 'Saved signature' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Draw' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('names the pair of tabs as one choice', () => {
    renderInput()

    // Two buttons announced back to back with nothing joining them are two
    // unrelated actions; the group name is what says they are one decision
    // about how this document gets signed.
    const group = screen.getByRole('group', { name: 'How to sign' })
    expect(within(group).getAllByRole('button')).toHaveLength(2)
  })

  /**
   * ADDED after mutation testing, and honest about what it can prove:
   * deleting the hand-written `aria-hidden` from an icon changes nothing,
   * because lucide-react supplies it for any icon with no a11y prop of its
   * own. So no test can tell those source lines apart - they are belt over
   * braces. What is worth pinning is the rendered outcome, which stops
   * holding the moment someone gives a glyph an `aria-label`, a `title` or
   * children: each one then becomes an unnamed "graphic" a screen reader
   * stops on, between the tab labels and the buttons that matter.
   */
  it('hides every decorative glyph from the screen reader', () => {
    const { container, rerender, props } = renderInput()

    const hiddenEverywhere = () => {
      const glyphs = [...container.querySelectorAll('svg')]
      expect(glyphs.length).toBeGreaterThan(0)
      glyphs.forEach(glyph => expect(glyph).toHaveAttribute('aria-hidden', 'true'))
    }

    // Draw mode: the tick on the active tab and the Clear eraser.
    hiddenEverywhere()

    // The saved panel with nothing stored yet: the upload arrow.
    rerender(<SignatureInput {...props} mode="saved" />)
    hiddenEverywhere()

    // And with a signature on file: the Replace eraser and the Remove bin.
    rerender(<SignatureInput {...props} {...savedProps} />)
    hiddenEverywhere()
  })
})

describe('drawing on the document', () => {
  it('says where to sign, since there is no canvas in this panel', () => {
    renderInput()

    // The drawing surface is the PDF itself, several hundred pixels away.
    // With no instruction people wait for a box to appear in the modal.
    expect(
      screen.getByText(/Sign anywhere on the PDF with your mouse, stylus, or finger/),
    ).toBeInTheDocument()
  })

  it('does not say "anywhere" when the document prints a line for them', () => {
    /*
     * A memo typed in the portal has already decided where this signature
     * goes, and the dialog around this panel says so two lines further up.
     * Leaving "sign anywhere" here contradicted it on the same screen.
     */
    renderInput({ hasOwnLine: true })

    expect(screen.queryByText(/Sign anywhere on the PDF/)).not.toBeInTheDocument()
    expect(
      screen.getByText(/sit on your line at the foot of the memo/),
    ).toBeInTheDocument()
  })

  it('lets a bad stroke be undone', async () => {
    const user = userEvent.setup({ delay: null })
    const onClearInk = vi.fn()
    const { props } = renderInput({ onClearInk })

    await user.click(screen.getByRole('button', { name: 'Clear' }))

    expect(onClearInk).toHaveBeenCalledTimes(1)
    // Calling the handler is not the whole contract - Clear must do that and
    // nothing else. Detaching the signature from here as well would fight the
    // parent, which clears its own state in response; flipping the mode would
    // throw the person out of the panel they are drawing in.
    expect(props.onChange).not.toHaveBeenCalled()
    expect(props.onModeChange).not.toHaveBeenCalled()
  })

  it('does nothing at all on Clear with no handler wired up', async () => {
    const user = userEvent.setup({ delay: null })
    const { props } = renderInput({ onClearInk: undefined })

    await user.click(screen.getByRole('button', { name: 'Clear' }))

    // Both callers pass one, but a crash here would take the whole approval
    // modal down with it rather than doing nothing. "Nothing" is the point:
    // Clear must not fall through to detaching the signature or flipping the
    // mode, which is what a stray onClick on this button would do.
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument()
    expect(props.onChange).not.toHaveBeenCalled()
    expect(props.onModeChange).not.toHaveBeenCalled()
  })

  it('keeps the profile-signature controls out of the drawing panel', () => {
    renderInput()

    // Remove deletes from the profile. It has no business being reachable
    // from a panel that is about ink on this one document.
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Choose image/ })).not.toBeInTheDocument()
  })
})

describe('the first upload', () => {
  it('explains that the file is kept, not used once', () => {
    renderInput({ mode: 'saved' })

    // This is the only place the person is told the image is stored on their
    // profile. Uploading a wet-ink signature is not a decision to make blind.
    expect(screen.getByText('Upload your signature once')).toBeInTheDocument()
    expect(
      screen.getByText('It will be saved to your profile for future approvals.'),
    ).toBeInTheDocument()
  })

  it('says what will be accepted before the file dialog opens', () => {
    renderInput({ mode: 'saved' })

    // Cheaper than an error after a 4 MB upload has already been sent.
    expect(screen.getByText('PNG or JPEG, up to 2 MB')).toBeInTheDocument()
  })

  it('holds the file dialog to the formats that sentence promises', () => {
    const { fileInput } = renderInput({ mode: 'saved' })

    // The copy above is only advice; this is what the OS picker enforces.
    // Without it the person browses their whole disk, picks a 30 MB HEIC and
    // finds out it was refused only after the round trip.
    expect(fileInput).toHaveAttribute('accept', 'image/png,image/jpeg')
  })

  it('opens the file picker from the visible button', async () => {
    const user = userEvent.setup({ delay: null })
    const { fileInput } = renderInput({ mode: 'saved' })
    const openPicker = vi.spyOn(fileInput, 'click').mockImplementation(() => {})

    await user.click(screen.getByRole('button', { name: 'Choose image' }))

    // The input is hidden, so this button is the only way in. Unwired, it is
    // a dead end with no signature ever getting uploaded.
    expect(openPicker).toHaveBeenCalledTimes(1)
  })

  it('hands the chosen file up, and only switches view once it has been stored', async () => {
    const user = userEvent.setup({ delay: null })
    const upload = deferred()
    const onUploadSavedSignature = vi.fn(() => upload.promise)
    const { props, fileInput } = renderInput({ mode: 'saved', onUploadSavedSignature })
    const file = new File(['png'], 'signature.png', { type: 'image/png' })

    await user.upload(fileInput, file)

    expect(onUploadSavedSignature).toHaveBeenCalledWith(file)
    // Switching before the upload lands would show the saved panel with a
    // broken image in it while the request was still going.
    expect(props.onModeChange).not.toHaveBeenCalled()

    upload.resolve()
    await waitFor(() => expect(props.onModeChange).toHaveBeenCalledWith('saved'))
  })

  it('takes a signature dropped onto the panel, not only one picked from the dialog', async () => {
    const onUploadSavedSignature = vi
      .fn<(file: File) => Promise<void>>()
      .mockResolvedValue(undefined)
    const { props } = renderInput({ mode: 'saved', onUploadSavedSignature })
    const file = new File(['png'], 'signature.png', { type: 'image/png' })

    // The panel is a dashed drop zone and says nothing about clicking, so
    // dragging the file in is what most people try first. Unhandled, the
    // browser navigates away from the modal and opens the PNG instead.
    fireEvent.drop(screen.getByText('Upload your signature once').closest('div')!, {
      dataTransfer: { files: [file], types: ['Files'] },
    })

    await waitFor(() => expect(onUploadSavedSignature).toHaveBeenCalledWith(file))
    await waitFor(() => expect(props.onModeChange).toHaveBeenCalledWith('saved'))
  })

  it('does nothing when the file dialog is closed without choosing anything', async () => {
    const onUploadSavedSignature = vi
      .fn<(file: File) => Promise<void>>()
      .mockResolvedValue(undefined)
    const { props, fileInput } = renderInput({ mode: 'saved', onUploadSavedSignature })

    // Cancelling the picker fires a change with an empty file list.
    fireEvent.change(fileInput, { target: { files: [] } })

    // Uploading `undefined` is a 400 the person never asked for, and moving
    // to the saved panel would show an empty frame where a signature is not.
    await waitFor(() => expect(onUploadSavedSignature).not.toHaveBeenCalled())
    expect(props.onModeChange).not.toHaveBeenCalled()
    expect(screen.getByText('Upload your signature once')).toBeInTheDocument()
  })

  it('lets the same file be chosen again after it was refused', async () => {
    const user = userEvent.setup({ delay: null })
    const onUploadSavedSignature = vi
      .fn<(file: File) => Promise<void>>()
      .mockRejectedValue(new Error('File is too large'))
    const { fileInput } = renderInput({ mode: 'saved', onUploadSavedSignature })
    const file = new File(['png'], 'signature.png', { type: 'image/png' })

    await user.upload(fileInput, file)
    await waitFor(() => expect(onUploadSavedSignature).toHaveBeenCalledTimes(1))

    // A file input holds on to its selection, and re-picking the identical
    // path fires no change event. Someone who fixes the file in place and
    // picks it again would get no response at all from the button.
    expect(fileInput.value).toBe('')
    expect(fileInput.files).toHaveLength(0)
  })

  it('stays on the upload panel when the upload is rejected', async () => {
    const user = userEvent.setup({ delay: null })
    const onUploadSavedSignature = vi
      .fn<(file: File) => Promise<void>>()
      .mockRejectedValue(new Error('File is too large'))
    const { props, fileInput } = renderInput({ mode: 'saved', onUploadSavedSignature })

    await user.upload(fileInput, new File(['png'], 'huge.png', { type: 'image/png' }))

    await waitFor(() => expect(onUploadSavedSignature).toHaveBeenCalled())
    // Moving to the saved view after a failure would show an empty panel and
    // no explanation of where the signature went.
    expect(props.onModeChange).not.toHaveBeenCalled()
    expect(screen.getByText('Upload your signature once')).toBeInTheDocument()
  })

  it('blocks a second upload while the first is in flight', async () => {
    const user = userEvent.setup({ delay: null })
    const { fileInput } = renderInput({ mode: 'saved', uploading: true })
    const openPicker = vi.spyOn(fileInput, 'click').mockImplementation(() => {})

    const button = screen.getByRole('button', { name: 'Choose image' })

    // Two uploads racing means whichever request lands last wins, and the
    // person cannot tell which of the two files they ended up with.
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')

    // Disabled has to mean the picker stays shut, not just that the button
    // looks dimmed while still opening it.
    await user.click(button)
    expect(openPicker).not.toHaveBeenCalled()
  })

  /**
   * ADDED after mutation testing: deleting the `if (uploading) return` from
   * `handleFile` left the suite green, because the only test of that latch
   * went through the "Choose image" button - and the button's disabled
   * attribute is not the way a second file gets in. The panel is a drop
   * zone for the whole time the first upload is running.
   */
  it('refuses a second file dropped on the panel while the first is still uploading', async () => {
    const onUploadSavedSignature = vi
      .fn<(file: File) => Promise<void>>()
      .mockResolvedValue(undefined)
    renderInput({ mode: 'saved', uploading: true, onUploadSavedSignature })

    // Nothing about a drop consults the disabled button beside it.
    fireEvent.drop(screen.getByText('Upload your signature once').closest('div')!, {
      dataTransfer: {
        files: [new File(['png'], 'second.png', { type: 'image/png' })],
        types: ['Files'],
      },
    })

    // Two uploads racing means whichever lands last wins, and the person
    // cannot tell which of the two signatures they ended up with.
    await waitFor(() => expect(onUploadSavedSignature).not.toHaveBeenCalled())
  })

  /**
   * ADDED after mutation testing: swapping the two error sources round -
   * `uploadError ?? refusedFile` instead of `refusedFile ?? uploadError` -
   * left the suite green. Nothing had the two on screen at once.
   */
  it('puts its own refusal in front of the older one from the last attempt', async () => {
    const onUploadSavedSignature = vi
      .fn<(file: File) => Promise<void>>()
      .mockResolvedValue(undefined)
    renderInput({
      mode: 'saved',
      // What the parent is still showing from the attempt before this one.
      uploadError: 'Signature storage is unreachable',
      onUploadSavedSignature,
    })

    fireEvent.drop(screen.getByText('Upload your signature once').closest('div')!, {
      dataTransfer: {
        files: [new File(['pdf'], 'contract.pdf', { type: 'application/pdf' })],
        types: ['Files'],
      },
    })

    // The refusal that has just happened is the newer of the two and the
    // only one the person can act on. Leaving the stale server error on top
    // sends them off to retry an outage that is not why this file bounced.
    expect(
      await screen.findByText('contract.pdf is not a PNG or JPEG image.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Signature storage is unreachable')).not.toBeInTheDocument()
    expect(onUploadSavedSignature).not.toHaveBeenCalled()
  })

  it('shows the reason an upload was refused', () => {
    renderInput({ mode: 'saved', uploadError: 'File is larger than 2 MB' })

    expect(screen.getByText('File is larger than 2 MB')).toBeInTheDocument()
  })

  // FIXED: was `it.fails`. The message now sits in a live region that is
  // already mounted and empty before the upload is attempted.
  it('announces a refused upload to a screen reader', () => {
    renderInput({ mode: 'saved', uploadError: 'File is larger than 2 MB' })

    // The error appears after an async round trip with no focus change, so
    // painting it red announced nothing: a blind user was left with a file
    // picker that closed and a signature that never arrived.
    const region = screen.getByText('File is larger than 2 MB').closest('[aria-live]')
    expect(region).not.toBeNull()
    // Polite so it does not cut off whatever is being read, atomic so one
    // message replacing another is not announced as half a sentence.
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toHaveAttribute('aria-atomic', 'true')
  })

  it('keeps the live region standing and empty before anything has failed', () => {
    const { container } = renderInput({ mode: 'saved' })

    // A live region inserted at the same moment as its first message is not
    // announced by most screen readers, so mounting it with the error would
    // leave the refusal silent for exactly the person who needs to hear it.
    const region = container.querySelector('[aria-live]')
    expect(region).not.toBeNull()
    expect(region).toBeEmptyDOMElement()
  })

  it('refuses a file the server would only reject after uploading it', async () => {
    const onUploadSavedSignature = vi
      .fn<(file: File) => Promise<void>>()
      .mockResolvedValue(undefined)
    renderInput({ mode: 'saved', onUploadSavedSignature })

    // `accept` filters the OS picker, but a file dragged onto the panel never
    // meets it, and the picker itself can be switched to "All files".
    fireEvent.drop(screen.getByText('Upload your signature once').closest('div')!, {
      dataTransfer: {
        files: [new File(['pdf'], 'contract.pdf', { type: 'application/pdf' })],
        types: ['Files'],
      },
    })

    // Sending it would spend the round trip to be told what the panel already
    // knew, and the person would watch a spinner to learn nothing.
    await waitFor(() =>
      expect(screen.getByText('contract.pdf is not a PNG or JPEG image.')).toBeInTheDocument(),
    )
    expect(onUploadSavedSignature).not.toHaveBeenCalled()
    // In the live region with every other refusal, so it is announced too.
    expect(
      screen.getByText('contract.pdf is not a PNG or JPEG image.').closest('[aria-live]'),
    ).not.toBeNull()
  })

  it('refuses an image bigger than the limit it advertises', async () => {
    const onUploadSavedSignature = vi
      .fn<(file: File) => Promise<void>>()
      .mockResolvedValue(undefined)
    const { fileInput } = renderInput({ mode: 'saved', onUploadSavedSignature })
    const huge = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'scan.png', {
      type: 'image/png',
    })

    await userEvent.setup({ delay: null }).upload(fileInput, huge)

    // 2 MB is what the panel promises. Uploading past it anyway means the
    // person waits out a slow upload for a refusal that was predictable.
    await waitFor(() =>
      expect(screen.getByText('scan.png is larger than 2 MB.')).toBeInTheDocument(),
    )
    expect(onUploadSavedSignature).not.toHaveBeenCalled()
  })

  it('clears its own refusal once an acceptable file is chosen', async () => {
    const user = userEvent.setup({ delay: null })
    const onUploadSavedSignature = vi
      .fn<(file: File) => Promise<void>>()
      .mockResolvedValue(undefined)
    const { fileInput } = renderInput({ mode: 'saved', onUploadSavedSignature })

    // Dropped rather than picked: `user.upload` obeys the input's `accept`,
    // so the picker cannot even produce the file this refusal is about.
    fireEvent.drop(screen.getByText('Upload your signature once').closest('div')!, {
      dataTransfer: {
        files: [new File(['pdf'], 'contract.pdf', { type: 'application/pdf' })],
        types: ['Files'],
      },
    })
    await screen.findByText('contract.pdf is not a PNG or JPEG image.')

    await user.upload(fileInput, new File(['png'], 'signature.png', { type: 'image/png' }))

    // A refusal left on screen beside a signature that did upload says the
    // second attempt failed too, and the person tries again indefinitely.
    await waitFor(() => expect(onUploadSavedSignature).toHaveBeenCalledTimes(1))
    expect(
      screen.queryByText('contract.pdf is not a PNG or JPEG image.'),
    ).not.toBeInTheDocument()
  })
})

describe('the signature already on file', () => {
  it('shows the stored signature with a name, not an anonymous image', () => {
    renderInput(savedProps)

    // A person with two similar signatures on file, or with images off, needs
    // to know what this picture is before dragging it onto a contract.
    expect(screen.getByRole('img', { name: 'Saved signature' })).toBeInTheDocument()
    expect(
      screen.getByText('Drag this signature onto the PDF, or click on the document to place it.'),
    ).toBeInTheDocument()
  })

  it('hands the PDF the key it drops on when the signature is dragged', () => {
    renderInput(savedProps)
    const setData = vi.fn()
    const dataTransfer = { setData, effectAllowed: 'none' }

    fireEvent.dragStart(screen.getByRole('img', { name: 'Saved signature' }), {
      dataTransfer,
    })

    // This string is a contract with PdfDocumentViewer, which ignores any
    // drag that does not carry it. Change it on one side only and the
    // signature can be dragged all over the page and will never land -
    // no error, no cursor change, nothing to tell the person why.
    expect(setData).toHaveBeenCalledWith('application/x-docflow-signature', 'saved')
    // A move cursor over a page that keeps the image would say the signature
    // is being taken out of the panel rather than stamped onto the document.
    expect(dataTransfer.effectAllowed).toBe('copy')
  })

  it('does not offer the first-upload panel once a signature exists', () => {
    renderInput(savedProps)

    expect(screen.queryByText('Upload your signature once')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument()
  })

  it('falls back to the upload panel when the stored image has no URL', () => {
    // The two callers derive `hasSavedSignature` from the URL, so today this
    // state is unreachable - but the props allow it, and if it ever happened
    // the person would be invited to upload a signature they already have.
    renderInput({ mode: 'saved', hasSavedSignature: true, savedSignatureUrl: null })

    expect(screen.getByText('Upload your signature once')).toBeInTheDocument()
  })

  it('opens the file picker to replace it without deleting first', async () => {
    const user = userEvent.setup({ delay: null })
    const { fileInput } = renderInput(savedProps)
    const openPicker = vi.spyOn(fileInput, 'click').mockImplementation(() => {})

    await user.click(screen.getByRole('button', { name: 'Replace' }))

    // Replace exists so nobody has to Delete-then-upload and risk being left
    // with no signature at all if the upload then fails.
    expect(openPicker).toHaveBeenCalledTimes(1)
  })

  /**
   * ADDED after mutation testing: taking `disabled={uploading}` off Replace
   * left the suite green - the in-flight latch was only ever tested on the
   * first-upload panel's "Choose image", never on the replace path, which is
   * the one somebody presses twice because they already have a signature on
   * screen and cannot tell the second press did anything.
   */
  it('keeps Replace shut while a replacement is already uploading', async () => {
    const user = userEvent.setup({ delay: null })
    const { fileInput } = renderInput({ ...savedProps, uploading: true })
    const openPicker = vi.spyOn(fileInput, 'click').mockImplementation(() => {})

    const replace = screen.getByRole('button', { name: 'Replace' })
    expect(replace).toBeDisabled()

    // Disabled has to mean the picker stays shut, not just that the control
    // looks dimmed while still opening it: the second file would race the
    // first and the person could not tell which signature they kept.
    await user.click(replace)
    expect(openPicker).not.toHaveBeenCalled()
  })

  it('asks before deleting, and does not delete on the first press', async () => {
    const user = userEvent.setup({ delay: null })
    const { props } = renderInput(savedProps)

    await user.click(screen.getByRole('button', { name: 'Remove' }))

    // Remove sits one pixel from Replace and destroys the signature on the
    // profile, not just its use here. A single click must not be enough.
    expect(props.onRemoveSavedSignature).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    // The controls that started this have to go with it. Leaving Remove there
    // lets a second press queue a second delete behind the first, and leaving
    // Replace there opens a file picker over a question nobody answered.
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Replace' })).not.toBeInTheDocument()
  })

  it('says the deletion reaches the profile, not just this approval', async () => {
    const user = userEvent.setup({ delay: null })
    renderInput(savedProps)

    await user.click(screen.getByRole('button', { name: 'Remove' }))

    // "Are you sure?" would not tell anyone what they are actually losing.
    expect(
      screen.getByText('Delete the signature saved to your profile?'),
    ).toBeInTheDocument()
    // The image stays on screen so it is clear which signature is going.
    expect(screen.getByRole('img', { name: 'Saved signature' })).toBeInTheDocument()
  })

  it('backs out of the deletion without touching the stored signature', async () => {
    const user = userEvent.setup({ delay: null })
    const { props } = renderInput(savedProps)

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(props.onRemoveSavedSignature).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Saved signature' })).toBeInTheDocument()
    // The panel has to come back the way it was, not settle into a state with
    // no way to replace or remove the signature short of reopening the modal.
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument()
  })

  it('deletes only once the confirmation is pressed', async () => {
    const user = userEvent.setup({ delay: null })
    const { props } = renderInput(savedProps)

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    expect(props.onRemoveSavedSignature).toHaveBeenCalledTimes(1)
    // Asked once, and the question is taken down. A confirmation bar still on
    // screen after Delete reads as though the press did not register, and the
    // second press it invites deletes nothing but returns an error.
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(
      screen.queryByText('Delete the signature saved to your profile?'),
    ).not.toBeInTheDocument()
  })

  it('leaves the signature on screen when the deletion fails', async () => {
    const user = userEvent.setup({ delay: null })
    const onRemoveSavedSignature = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('Server unavailable'))
    renderInput({ ...savedProps, onRemoveSavedSignature })

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(onRemoveSavedSignature).toHaveBeenCalled())
    // A rejected delete must not take the modal down, and must not leave the
    // person believing a signature that is still on their profile is gone.
    expect(screen.getByRole('img', { name: 'Saved signature' })).toBeInTheDocument()
  })

  it('is reachable by keyboard from Remove through to Delete', async () => {
    const user = userEvent.setup({ delay: null })
    const { props } = renderInput(savedProps)

    screen.getByRole('button', { name: 'Remove' }).focus()
    await user.keyboard('{Enter}')
    screen.getByRole('button', { name: 'Delete' }).focus()
    await user.keyboard(' ')

    // Deleting your own signature must not require a mouse.
    expect(props.onRemoveSavedSignature).toHaveBeenCalledTimes(1)
  })

  // FIXED: was `it.fails`. The confirmation bar now stays up while
  // `removing` is true, so the spinner has a control to land on.
  it('keeps the Delete button on screen while the deletion is in flight', async () => {
    const user = userEvent.setup({ delay: null })
    const removal = deferred()
    const { rerender, props } = renderInput({
      ...savedProps,
      onRemoveSavedSignature: vi.fn(() => removal.promise),
    })

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    rerender(<SignatureInput {...props} removing />)

    // Torn down in the same tick the request started, `removing` had no
    // button left to put its spinner on: the person pressed Delete and the
    // screen went back to looking exactly as it had.
    const confirm = screen.getByRole('button', { name: 'Delete' })
    expect(confirm).toBeInTheDocument()
    expect(confirm).toHaveAttribute('aria-busy', 'true')
    expect(confirm).toBeDisabled()
    // Backing out of a deletion that is already on its way is not a thing
    // the panel can honour, so it must not offer it.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('puts the panel back once a failed deletion has finished', async () => {
    const user = userEvent.setup({ delay: null })
    const onRemoveSavedSignature = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('Server unavailable'))
    renderInput({ ...savedProps, onRemoveSavedSignature })

    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(onRemoveSavedSignature).toHaveBeenCalled())
    // The request is over, so the bar has to come down with it - a Delete
    // button still standing after a failed attempt reads as a deletion that
    // is still running, and the person waits for something that ended.
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
  })
})

describe('somebody with no saved signature', () => {
  it('is told one can be saved, and taken there in one press', async () => {
    const user = userEvent.setup({ delay: null })
    const { props } = renderInput()

    expect(screen.getByText('You haven’t saved a signature yet')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save a signature' }))
    expect(props.onModeChange).toHaveBeenCalledWith('saved')
  })

  it('can still draw this once', () => {
    renderInput()
    expect(screen.getByText('Draw on the document')).toBeInTheDocument()
  })

  it('is not told again once a signature is saved', () => {
    renderInput({ savedSignatureUrl: SAVED_URL, hasSavedSignature: true })
    expect(screen.queryByText('You haven’t saved a signature yet')).not.toBeInTheDocument()
  })
})
