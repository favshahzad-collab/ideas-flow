import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchDocumentFile } from '../services/documentDetailApi'
import { downloadDocumentFile, printDocumentFile } from './downloadDocument'

/**
 * Getting the actual PDF onto somebody's disk, and onto paper. Everything
 * here is invisible when it works, and when it does not the person is left
 * with a file called `download` they cannot open, or with nothing at all and
 * no error to explain it. The things worth guarding are the name the file
 * lands under, the object URL - which pins the whole PDF in memory until it is
 * released, and which must outlive the browser's use of it - and, for
 * printing, that what reaches the printer is the PDF rather than the page.
 */

vi.mock('../services/documentDetailApi', () => ({
  fetchDocumentFile: vi.fn(),
}))

const fetchFile = vi.mocked(fetchDocumentFile)

const DOC_ID = '3f2a9b1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c'
/**
 * A different URL per call. A single fixed URL cannot tell "revoked the URL it
 * just made" apart from "revoked a URL it had cached from an earlier download",
 * and the second of those is a click that saves nothing.
 */
const objectUrl = (nth: number) => `blob:http://localhost/9c1f-${nth}`

/** Order matters here, so every observed step is written to one list. */
let steps: string[] = []

/**
 * Longer than any backstop the util sets. Tests advance by this rather than by
 * a copy of the util's own constants: what is being pinned is that a timer
 * exists at all, not the number of seconds somebody picked.
 */
const LONGER_THAN_ANY_BACKSTOP_MS = 10 * 60 * 1000
let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>

interface ClickSnapshot {
  href: string | null
  download: string
  /** Whether the link was in the page at the moment it was clicked. */
  attached: boolean
}

/**
 * The anchor the util builds is never returned to anyone, so it is caught on
 * the way out of `document.createElement` and its click recorded.
 */
function interceptAnchor() {
  const createReal = document.createElement.bind(document)
  const anchor = createReal('a')
  const clicks: ClickSnapshot[] = []

  vi.spyOn(anchor, 'click').mockImplementation(() => {
    steps.push('click')
    clicks.push({
      href: anchor.getAttribute('href'),
      download: anchor.download,
      attached: document.body.contains(anchor),
    })
  })

  const createElement = vi
    .spyOn(document, 'createElement')
    .mockImplementation(((tag: string, options?: ElementCreationOptions) =>
      tag === 'a' ? anchor : createReal(tag, options)) as typeof document.createElement)

  return { anchor, clicks, createElement }
}

/**
 * The print frame is never returned to anyone either, so it is caught the same
 * way. What comes back are the two things a browser would do and jsdom will
 * not: report the PDF viewer as loaded, and run the print dialog.
 */
function interceptFrame() {
  const createReal = document.createElement.bind(document)
  const frame = createReal('iframe')
  const print = vi.fn(() => {
    steps.push('print')
  })
  const focus = vi.fn()

  vi.spyOn(document, 'createElement').mockImplementation(((
    tag: string,
    options?: ElementCreationOptions,
  ) =>
    tag === 'iframe' ? frame : createReal(tag, options)) as typeof document.createElement)

  /** The viewer inside the frame has finished loading the PDF. */
  const finishLoading = () => {
    const view = frame.contentWindow
    if (view) {
      view.print = print
      view.focus = focus
    }
    frame.dispatchEvent(new Event('load'))
  }

  /** The person has printed, or dismissed the dialog. */
  const finishPrinting = () => {
    frame.contentWindow?.dispatchEvent(new Event('afterprint'))
  }

  return { frame, print, focus, finishLoading, finishPrinting }
}

/**
 * The frame only reaches the page once the fetch settles. Waiting on
 * microtasks rather than on the clock, because the clock is faked here and
 * advancing it would fire the util's give-up timer instead.
 */
async function untilInThePage(element: Element) {
  for (let tick = 0; tick < 20 && !document.body.contains(element); tick += 1) {
    await Promise.resolve()
  }
}

/** One whole print, driven the way a browser would drive it. */
async function printAndOpenDialog(documentId = DOC_ID) {
  const framed = interceptFrame()
  const printing = printDocumentFile(documentId)
  await untilInThePage(framed.frame)
  framed.finishLoading()
  await printing
  return framed
}

beforeEach(() => {
  // The object URL is now released on a timer rather than on the line after
  // the click, so the tests that watch it drive the clock themselves.
  vi.useFakeTimers()
  steps = []
  let created = 0
  createObjectURL = vi.fn(() => {
    created += 1
    steps.push('create')
    return objectUrl(created)
  })
  revokeObjectURL = vi.fn(() => {
    steps.push('revoke')
  })
  // jsdom implements neither, so these are assigned rather than spied on.
  window.URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL
  window.URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL
  // `restoreMocks` restores spies, not the call log of a module mock.
  fetchFile.mockReset()
  fetchFile.mockImplementation(async () => {
    steps.push('fetch')
    return new Blob(['%PDF-1.7'], { type: 'application/pdf' })
  })
})

afterEach(() => {
  vi.useRealTimers()
  delete (window.URL as Partial<typeof URL>).createObjectURL
  delete (window.URL as Partial<typeof URL>).revokeObjectURL
})

describe('downloadDocumentFile', () => {
  it('asks the API for the one document it was given, as a download', async () => {
    interceptAnchor()

    await downloadDocumentFile(DOC_ID)

    expect(fetchFile).toHaveBeenCalledTimes(1)
    // A copy is about to be saved to somebody's disk, and the audit row that
    // says so is written from this argument.
    expect(fetchFile).toHaveBeenCalledWith(DOC_ID, 'download')
  })

  it('names the file after the first eight characters of the document id', async () => {
    const { clicks } = interceptAnchor()

    await downloadDocumentFile(DOC_ID)

    // Without a download name the browser saves the blob under a random UUID
    // with no extension, which nothing on the machine will open.
    expect(clicks[0].download).toBe('document-3f2a9b1c.pdf')
  })

  it('prefers the name the caller asked for', async () => {
    const { clicks } = interceptAnchor()

    await downloadDocumentFile(DOC_ID, 'document-3f2a9b1c-v3.pdf')

    // This is how the version number reaches the filename; losing it means
    // downloading v3 quietly overwrites the v1 already in the folder.
    expect(clicks[0].download).toBe('document-3f2a9b1c-v3.pdf')
  })

  it('points the link at the exact blob the API returned', async () => {
    const blob = new Blob(['%PDF-1.7 real bytes'], { type: 'application/pdf' })
    fetchFile.mockResolvedValue(blob)
    const { clicks } = interceptAnchor()

    await downloadDocumentFile(DOC_ID)

    // Re-wrapping the body anywhere in here is how people end up saving a
    // 0-byte PDF that looks like a successful download.
    //
    // Identity, not equality. A Blob has no own enumerable properties, so
    // vitest's structural comparison considers every Blob equal to every
    // other one: `expect(createObjectURL).toHaveBeenCalledWith(blob)` passes
    // unchanged if the util throws these bytes away and hands over
    // `new Blob([])`, which is the exact bug this test claims to catch.
    expect(createObjectURL.mock.calls[0][0]).toBe(blob)
    expect(clicks[0].href).toBe(objectUrl(1))
    // One click, from one URL: a second URL made and not revoked is a whole
    // PDF pinned in memory that nothing will ever release.
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(clicks).toHaveLength(1)
  })

  it('releases the object URL it created', async () => {
    const { clicks } = interceptAnchor()

    await downloadDocumentFile(DOC_ID)
    // Changed: the release is deferred now (see the test below), so the clock
    // has to be run for it. The guarantee itself is unchanged - it happens.
    vi.runOnlyPendingTimers()

    // An unreleased blob URL holds the entire PDF in memory for the life of
    // the tab; a person working through an approval queue would accumulate
    // every document they looked at.
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    // The URL released has to be the one the link was pointed at. Revoking
    // some other string frees nothing and leaks the same PDF.
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl(1))
    expect(revokeObjectURL).toHaveBeenCalledWith(clicks[0].href)
  })

  it('clicks the link before releasing the URL, and only once the bytes are in hand', async () => {
    interceptAnchor()

    await downloadDocumentFile(DOC_ID)
    vi.runOnlyPendingTimers()

    // Revoking first would leave the click pointing at a dead URL and no file
    // would arrive. Clicking before the fetch settles is the other way to save
    // nothing: a URL made from a pending promise is not a URL made from a PDF.
    expect(steps).toEqual(['fetch', 'create', 'click', 'revoke'])
  })

  it('leaves the object URL alive after the click, for the browser to finish reading', async () => {
    const { clicks } = interceptAnchor()

    await downloadDocumentFile(DOC_ID)

    // Changed: this used to revoke on the line after `click()`. Chrome hands
    // the blob to its download manager during the click, but Firefox and
    // Safari read it on a later task - and a URL revoked before they get
    // there produces no file, no error and nothing to retry. The click is
    // done here; the URL must not be.
    expect(clicks).toHaveLength(1)
    expect(revokeObjectURL).not.toHaveBeenCalled()

    vi.runOnlyPendingTimers()

    // ...and it does have to be released eventually, or the whole PDF stays
    // in memory for the life of the tab.
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl(1))
  })

  it('survives a document id shorter than the eight characters it slices', async () => {
    const { clicks } = interceptAnchor()

    await downloadDocumentFile('abc')

    // `slice` is happy to return less; the name just has to stay a usable pdf.
    expect(clicks[0].download).toBe('document-abc.pdf')
  })

  it('lets a failed fetch through and creates no URL to leak', async () => {
    const failure = new Error('Document file not found')
    fetchFile.mockRejectedValue(failure)
    const { clicks } = interceptAnchor()

    // The caller shows the error; swallowing it here would leave the person
    // staring at a Download button that appears to have done nothing. It has
    // to be the same error object, not a lookalike: the button branches on
    // `instanceof Error`, and a re-wrap loses the status a 404 came with.
    await expect(downloadDocumentFile(DOC_ID)).rejects.toBe(failure)
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(clicks).toHaveLength(0)
  })

  it('creates and releases a separate object URL for every download', async () => {
    const { clicks } = interceptAnchor()

    await downloadDocumentFile(DOC_ID, 'first.pdf')
    await downloadDocumentFile(DOC_ID, 'second.pdf')
    vi.runOnlyPendingTimers()

    // Two downloads in a row is the normal case on a document with versions.
    // The second must get its own URL: reusing the first one, which has
    // already been revoked, would produce a click that saves nothing.
    expect(clicks.map(click => click.download)).toEqual(['first.pdf', 'second.pdf'])
    expect(createObjectURL).toHaveBeenCalledTimes(2)
    expect(revokeObjectURL).toHaveBeenCalledTimes(2)
    // Counting the calls is not enough - a util that made a fresh URL and
    // then clicked and revoked the stale one from last time would count the
    // same. Each click has to carry its own URL, and each revoke has to
    // release that same one.
    expect(clicks.map(click => click.href)).toEqual([objectUrl(1), objectUrl(2)])
    expect(revokeObjectURL.mock.calls.flat()).toEqual([objectUrl(1), objectUrl(2)])
  })

  it('puts the link in the document before clicking it', async () => {
    const { anchor, clicks } = interceptAnchor()

    await downloadDocumentFile(DOC_ID)

    // Changed: this used to be an `it.fails` pinning the defect. Firefox
    // ignores a programmatic download click on an anchor that is not in the
    // document, so the download silently never started - no file, no error.
    expect(clicks[0].attached).toBe(true)
    // ...and the anchor is not left behind. One orphan per download would
    // accumulate invisibly at the end of the body all session.
    expect(document.body.contains(anchor)).toBe(false)
  })
})

describe('printDocumentFile', () => {
  it('asks the API for the one document it was given, as a view', async () => {
    await printAndOpenDialog()

    expect(fetchFile).toHaveBeenCalledTimes(1)
    // Nothing is saved here: the bytes go into a frame to raise a print
    // dialog on, and `recordDocumentPrint` writes the row that says a copy
    // went to paper. Asking as a download would put a second, untrue row
    // beside it on every print.
    expect(fetchFile).toHaveBeenCalledWith(DOC_ID, 'view')
  })

  it('sends the PDF itself to the printer, not the page it was clicked from', async () => {
    const pagePrint = vi.spyOn(window, 'print').mockImplementation(() => {})

    const { frame, print, focus } = await printAndOpenDialog()

    // The memo is a signed A4 document. Printing the page instead would put
    // the app's navigation and buttons on the sheet that gets filed, and
    // would leave off whatever the screen had scrolled past.
    expect(frame.getAttribute('src')).toBe(objectUrl(1))
    expect(print).toHaveBeenCalledTimes(1)
    expect(pagePrint).not.toHaveBeenCalled()
    // Safari prints the top document unless the frame holds focus, which is
    // the same wrong sheet by another route.
    expect(focus).toHaveBeenCalled()
  })

  it('raises the dialog only once the viewer has the PDF', async () => {
    const framed = interceptFrame()

    const printing = printDocumentFile(DOC_ID)
    await untilInThePage(framed.frame)

    // Printing a frame whose PDF has not arrived prints a blank sheet, which
    // is indistinguishable from a printer fault to the person holding it.
    expect(framed.print).not.toHaveBeenCalled()

    framed.finishLoading()
    await printing

    expect(steps).toEqual(['fetch', 'create', 'print'])
  })

  it('renders the frame rather than hiding it, and keeps it out of the reading order', async () => {
    const { frame } = await printAndOpenDialog()

    // `display: none` is the obvious way to hide this and it prints nothing:
    // a frame that was never laid out has no pages to send. It is pushed off
    // the corner of the page at zero size instead.
    expect(frame.style.display).not.toBe('none')
    // Nothing in there is for reading, and a screen reader announcing an
    // empty frame mid-page is noise the person has to work around.
    expect(frame.getAttribute('aria-hidden')).toBe('true')
  })

  it('holds the object URL open while the print dialog is still up', async () => {
    const framed = await printAndOpenDialog()

    // The dialog is modal in some browsers and not in others, so the promise
    // resolving does not mean the job is done. Revoking here empties the
    // viewer under the person's cursor and prints a blank page.
    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(document.body.contains(framed.frame)).toBe(true)

    framed.finishPrinting()

    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl(1))
    // The frame goes too - one left per print would keep every PDF somebody
    // printed this session alive in memory.
    expect(document.body.contains(framed.frame)).toBe(false)
  })

  it('releases the frame even when the browser never reports the print finished', async () => {
    const framed = await printAndOpenDialog()

    vi.advanceTimersByTime(LONGER_THAN_ANY_BACKSTOP_MS)

    // Chrome's built-in PDF viewer does not always fire `afterprint`. With no
    // backstop, that browser leaks the whole PDF on every single print.
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(document.body.contains(framed.frame)).toBe(false)
  })

  it('releases what it made exactly once, however printing ends', async () => {
    const framed = await printAndOpenDialog()

    framed.finishPrinting()
    vi.advanceTimersByTime(LONGER_THAN_ANY_BACKSTOP_MS)

    // A second revoke is harmless, but a second `remove()` on a frame the
    // person has since replaced is not - and counting it here is the only
    // way to know the backstop was cancelled rather than merely quiet.
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('gives up when the viewer never loads, instead of spinning forever', async () => {
    const framed = interceptFrame()

    const printing = printDocumentFile(DOC_ID)
    await untilInThePage(framed.frame)
    vi.advanceTimersByTime(LONGER_THAN_ANY_BACKSTOP_MS)

    // Without this the Print button stays busy for the rest of the session,
    // which reads as "still working on it" while nothing is happening.
    await expect(printing).rejects.toThrow('The memo did not open for printing')
    expect(framed.print).not.toHaveBeenCalled()
    // Giving up still has to clean up, or the failed attempt leaks too.
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(document.body.contains(framed.frame)).toBe(false)
  })

  it('reports a dialog that refuses to open, and takes its frame back', async () => {
    const framed = interceptFrame()
    framed.print.mockImplementation(() => {
      throw new Error('Blocked by the browser')
    })

    const printing = printDocumentFile(DOC_ID)
    await untilInThePage(framed.frame)
    framed.finishLoading()

    // The caller shows this. A rejection with the browser's own wording would
    // put "Blocked by the browser" under a button, which tells nobody what to
    // do next; the person needs to know printing did not happen.
    await expect(printing).rejects.toThrow('The print dialog could not be opened')
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(document.body.contains(framed.frame)).toBe(false)
  })

  it('lets a failed fetch through and leaves nothing behind to leak', async () => {
    const failure = new Error('Document file not found')
    fetchFile.mockRejectedValue(failure)
    const { frame } = interceptFrame()

    // Same object, not a lookalike: the button prints the message off it, and
    // a re-wrap loses what a 403 on an unapproved memo actually said.
    await expect(printDocumentFile(DOC_ID)).rejects.toBe(failure)
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(document.body.contains(frame)).toBe(false)
  })

  it('gives every print its own object URL', async () => {
    const first = await printAndOpenDialog()
    first.finishPrinting()
    const second = await printAndOpenDialog()
    second.finishPrinting()

    // Reusing the first URL, already revoked, would open an empty viewer on
    // the second print - and the person would have no idea why.
    expect(createObjectURL).toHaveBeenCalledTimes(2)
    expect(revokeObjectURL.mock.calls.flat()).toEqual([objectUrl(1), objectUrl(2)])
  })

  it('cancels the backstop it no longer needs when printing ends', async () => {
    const framed = await printAndOpenDialog()

    // While the dialog is up the five-minute backstop is the thing keeping
    // the leak bounded, so it has to be armed here...
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    framed.finishPrinting()

    // ...and gone once printing has finished. A backstop left pending holds
    // the frame and the blob alive in its closure for another five minutes
    // after the work is done, on every print of the session.
    //
    // Added after mutation testing: deleting the `clearTimeout` loop broke
    // nothing. "Releases exactly once" could not see it, because the
    // released-once flag alone is enough to keep that count at one - the two
    // guards were covering for each other and neither was pinned.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases nothing a second time when the viewer reports in after the give-up', async () => {
    const framed = interceptFrame()
    // The frame has been taken out of the page by the give-up below, so its
    // browsing context is gone and `contentWindow` reads null - the state a
    // real browser leaves behind after `remove()`.
    Object.defineProperty(framed.frame, 'contentWindow', {
      get: () => null,
      configurable: true,
    })

    const printing = printDocumentFile(DOC_ID)
    await untilInThePage(framed.frame)
    vi.advanceTimersByTime(LONGER_THAN_ANY_BACKSTOP_MS)
    await expect(printing).rejects.toThrow('The memo did not open for printing')

    // The deadline and the frame's own load are two independent things racing:
    // the deadline goes off at twenty seconds and the load lands a moment
    // after. Exactly one of them may release.
    framed.finishLoading()

    // Added after mutation testing: deleting the released-once flag broke
    // nothing. "Releases exactly once, however printing ends" could not see
    // it, because cancelling the timers is enough on its own to hold that
    // count at one - the flag and the `clearTimeout` loop were covering for
    // each other, and neither was pinned on its own.
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('reports a frame the browser gave no window for', async () => {
    const framed = interceptFrame()
    // A frame whose browsing context is gone by the time `load` is handled -
    // the tab is being torn down, or the person navigated while the PDF was
    // still arriving. `contentWindow` is null and every line after it would
    // throw inside a promise nobody is watching.
    Object.defineProperty(framed.frame, 'contentWindow', {
      get: () => null,
      configurable: true,
    })

    const printing = printDocumentFile(DOC_ID)
    await untilInThePage(framed.frame)
    framed.finishLoading()

    // Added after mutation testing: dropping this guard broke nothing, so
    // the message it exists to produce was never once read by a test.
    await expect(printing).rejects.toThrow('The print preview could not be opened')
    // Failing still has to clean up after itself.
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl(1))
    expect(document.body.contains(framed.frame)).toBe(false)
  })
})
