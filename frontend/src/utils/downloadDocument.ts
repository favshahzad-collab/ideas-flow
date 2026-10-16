import { fetchDocumentFile } from '../services/documentDetailApi'

/**
 * Chrome hands the bytes to the download manager while the click is still
 * being handled, but Firefox and Safari finish the save on a later task: a URL
 * revoked in the same tick leaves them reading a URL that no longer resolves,
 * so the file never arrives - no error, no failed download, nothing to retry.
 * Holding one PDF in memory for a few seconds is the cheaper of the two.
 */
const REVOKE_AFTER_CLICK_MS = 10_000

/**
 * How long the print frame gets to bring the browser's PDF viewer up before we
 * give up on it. Without a ceiling, a frame that never loads leaves the Print
 * button spinning for the rest of the session, which reads as "still working
 * on it" when nothing is happening at all.
 */
const PRINT_LOAD_TIMEOUT_MS = 20_000

/**
 * The backstop for releasing the print frame. Release normally waits for
 * `afterprint`, but Chrome's built-in PDF viewer does not always fire it, and
 * a frame nobody removes pins the whole PDF for the life of the tab. Long
 * enough that somebody still choosing a printer or a duplex setting is not cut
 * off mid-dialog.
 */
const PRINT_CLEANUP_MS = 300_000

export async function downloadDocumentFile(
  documentId: string,
  fileName?: string,
): Promise<void> {
  const blob = await fetchDocumentFile(documentId, 'download')
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName ?? `document-${documentId.slice(0, 8)}.pdf`
  // Firefox ignores a programmatic click on an anchor that is not in the
  // document. It reports nothing: the person presses Download, no file
  // appears, and there is no failure anywhere to tell them why.
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => window.URL.revokeObjectURL(url), REVOKE_AFTER_CLICK_MS)
}

/**
 * Opens the document in the browser's own PDF viewer and raises the print
 * dialog on it. Resolves once the dialog has been asked for; the frame and its
 * object URL are released afterwards, on `afterprint` or on the backstop.
 *
 * A hidden iframe rather than `window.open`, because the bytes have to be
 * fetched first and a window opened after an `await` is no longer inside the
 * click that a popup blocker trusts. Blocked, `window.open` returns `null` and
 * the person is left with a button that did nothing and a blocker icon in the
 * URL bar they will not think to look at. A same-document frame is never
 * blocked, so the only failures left are ones this can see and report.
 *
 * It prints the PDF itself, not the page: the memo is laid out and signed at
 * A4, and printing the screen around it would put the app's chrome on
 * something people file.
 */
export async function printDocumentFile(documentId: string): Promise<void> {
  // A view, not a download: nothing is saved here, and `recordDocumentPrint`
  // writes the row that says a copy went to paper. Asking as a download would
  // put a second, untrue row beside it on every print.
  const blob = await fetchDocumentFile(documentId, 'view')
  const url = window.URL.createObjectURL(blob)

  return new Promise<void>((resolve, reject) => {
    const frame = document.createElement('iframe')
    // Off the edge of the page at zero size rather than `display: none`: a
    // frame that was never rendered has no viewer inside it to print.
    frame.style.position = 'fixed'
    frame.style.right = '0'
    frame.style.bottom = '0'
    frame.style.width = '0'
    frame.style.height = '0'
    frame.style.border = '0'
    // Nothing in here is for reading; it exists to own a print dialog.
    frame.setAttribute('aria-hidden', 'true')

    let released = false
    /** Every deadline set, so releasing once cancels whichever is still due. */
    const timers: ReturnType<typeof window.setTimeout>[] = []
    const release = () => {
      if (released) return
      released = true
      for (const timer of timers) window.clearTimeout(timer)
      frame.remove()
      window.URL.revokeObjectURL(url)
    }

    const giveUp = window.setTimeout(() => {
      release()
      reject(new Error('The memo did not open for printing'))
    }, PRINT_LOAD_TIMEOUT_MS)
    timers.push(giveUp)

    frame.onload = () => {
      const view = frame.contentWindow
      if (!view) {
        release()
        reject(new Error('The print preview could not be opened'))
        return
      }

      window.clearTimeout(giveUp)
      // The dialog is modal in some browsers and not in others, so the URL is
      // held until printing says it is finished rather than until `print()`
      // returns - revoking under an open dialog prints a blank sheet.
      view.addEventListener('afterprint', release)
      timers.push(window.setTimeout(release, PRINT_CLEANUP_MS))

      try {
        // Safari prints the top document unless the frame holds focus, which
        // would put the app's own chrome on the page instead of the memo.
        view.focus()
        view.print()
      } catch {
        release()
        reject(new Error('The print dialog could not be opened'))
        return
      }

      resolve()
    }

    frame.src = url
    document.body.appendChild(frame)
  })
}
