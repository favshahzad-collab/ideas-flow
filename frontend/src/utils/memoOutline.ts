/**
 * The memo's headings, for jumping between them.
 *
 * Read off the region rather than the body, because what is jumped to is
 * an element: the caret goes to the start of it and the page scrolls to
 * it. A heading with nothing in it yet is still listed, named for what it
 * is, so an outline typed in ahead of the text can be moved around.
 */

export interface OutlineEntry {
  level: 1 | 2
  text: string
  element: HTMLElement
}

export const UNTITLED = 'Untitled heading'

export function outlineOf(region: HTMLElement): OutlineEntry[] {
  return Array.from(region.querySelectorAll<HTMLElement>('h1, h2')).map(element => ({
    level: element.tagName === 'H1' ? 1 : 2,
    text: (element.textContent ?? '').replace(/\s+/g, ' ').trim() || UNTITLED,
    element,
  }))
}

/** Put the caret at the start of a block, and bring it onto the screen. */
export function caretToStartOf(element: HTMLElement): void {
  const selection = element.ownerDocument.getSelection()
  if (!selection) return

  const range = element.ownerDocument.createRange()
  const first = element.firstChild
  if (first && first.nodeType === Node.TEXT_NODE) range.setStart(first, 0)
  else range.setStart(element, 0)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)

  // Guarded because a test DOM has no layout to scroll.
  if (typeof element.scrollIntoView === 'function') {
    element.scrollIntoView({ block: 'center' })
  }
}
