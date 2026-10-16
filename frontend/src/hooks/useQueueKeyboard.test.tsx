import { render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  scrollRowIntoView,
  useQueueKeyboard,
  type QueueKeyHandlers,
} from './useQueueKeyboard'

/**
 * My queue is driven from the keyboard: J/K move the cursor, A/R/X act on
 * whatever is under it, Enter moves into the document. That makes every key
 * on this page a loaded one - the row under the cursor is the document a
 * person is about to sign or refuse - so what matters here is not only that
 * the right handler fires, but that nothing fires when the keystroke belonged
 * to somebody else: a text field, an open dialog, or the browser itself.
 *
 * The hook deliberately owns no cursor of its own. It reports the intent and
 * `MyQueuePage` decides what the ends of the list mean (it clamps; see
 * the last test in the first block for why that is the right answer here).
 */

type Handlers = { [K in keyof QueueKeyHandlers]: ReturnType<typeof vi.fn> }

function makeHandlers(): Handlers {
  return {
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    onApprove: vi.fn(),
    onRevision: vi.fn(),
    onReject: vi.fn(),
    onFocusDetail: vi.fn(),
  }
}

/** Every handler counted, so "x fired" always also means "nothing else did". */
function fired(handlers: Handlers): string[] {
  return Object.entries(handlers)
    .filter(([, fn]) => fn.mock.calls.length > 0)
    .map(([name]) => name)
}

function mountHook(enabled = true) {
  const handlers = makeHandlers()
  const view = renderHook(
    ({ on, h }: { on: boolean; h: QueueKeyHandlers }) => useQueueKeyboard(on, h),
    { initialProps: { on: enabled, h: handlers as QueueKeyHandlers } },
  )
  return { handlers, ...view }
}

/** Dispatched by hand where the test needs to read `defaultPrevented`. */
function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  document.dispatchEvent(event)
  return event
}

/** The same keystroke, aimed at one element so the guard sees it as target. */
function pressOn(target: Element, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

describe('which key does what', () => {
  it.each([
    ['j', 'onNext'],
    ['J', 'onNext'],
    ['ArrowDown', 'onNext'],
    ['k', 'onPrevious'],
    ['K', 'onPrevious'],
    ['ArrowUp', 'onPrevious'],
    ['a', 'onApprove'],
    ['A', 'onApprove'],
    ['r', 'onRevision'],
    ['R', 'onRevision'],
    ['x', 'onReject'],
    ['X', 'onReject'],
    ['Enter', 'onFocusDetail'],
  ])('%s asks for %s and for nothing else', (key, expected) => {
    const { handlers } = mountHook()

    press(key)

    // A key that fired two handlers would, on this screen, both move the
    // cursor and open a dialog against the row it just left.
    expect(fired(handlers)).toEqual([expected])
  })

  it('answers the shifted letter as well as the plain one', () => {
    // Caps Lock is on, or the person is holding Shift from typing. Neither is
    // a reason for the queue to stop responding.
    const { handlers } = mountHook()

    press('X', { shiftKey: true })

    expect(handlers.onReject).toHaveBeenCalledTimes(1)
  })

  it('swallows the arrow keys so the page does not scroll under the cursor', () => {
    const { handlers } = mountHook()

    expect(press('ArrowDown').defaultPrevented).toBe(true)
    expect(press('ArrowUp').defaultPrevented).toBe(true)
    // Without preventDefault the list would move the cursor one row and the
    // window would scroll at the same time, so the selected row leaves view.
    expect(handlers.onNext).toHaveBeenCalledTimes(1)
    expect(handlers.onPrevious).toHaveBeenCalledTimes(1)
  })

  it('swallows Enter rather than letting it click the row as well', () => {
    const { handlers } = mountHook()

    // A click leaves focus on the row button. An Enter that reached it would
    // fire the row's own onClick on top of this hook's focus move, so the
    // cursor and the pane could end up on different documents. The letters
    // are swallowed for the same reason a bare "a" must not reach the page.
    expect(press('Enter').defaultPrevented).toBe(true)
    expect(press('x').defaultPrevented).toBe(true)
    expect(fired(handlers)).toEqual(['onReject', 'onFocusDetail'])
  })

  it('leaves keys it does not own completely alone', () => {
    const { handlers } = mountHook()

    const event = press('q')

    expect(fired(handlers)).toEqual([])
    // Swallowing unknown keys would break type-ahead and every browser
    // shortcut that is a bare letter.
    expect(event.defaultPrevented).toBe(false)
  })

  it('never decides what the end of the list means', () => {
    // The hook has no idea how long the queue is: it reports "next" as many
    // times as it is asked. The page clamps rather than wraps, which is the
    // right answer for a signing queue - a J at the bottom that jumped back
    // to the top would silently put a different document under the cursor
    // that X is about to reject.
    const { handlers } = mountHook()

    press('j')
    press('j')
    press('j')

    expect(handlers.onNext).toHaveBeenCalledTimes(3)
    expect(handlers.onNext).toHaveBeenCalledWith()
  })
})

describe('keystrokes that belong to somebody else', () => {
  it('gives the browser back its own shortcuts', () => {
    const { handlers } = mountHook()

    // Ctrl+A is select-all and Cmd+R is reload. Not firing the queue's own
    // handler is only half of leaving them alone: a preventDefault on the way
    // past would cancel the browser's shortcut too, and a page where Cmd+R
    // does nothing reads as broken rather than as one with shortcuts.
    expect(press('a', { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(press('r', { metaKey: true }).defaultPrevented).toBe(false)
    expect(press('ArrowDown', { altKey: true }).defaultPrevented).toBe(false)

    expect(fired(handlers)).toEqual([])
  })

  it('stays out of a text field', async () => {
    const user = userEvent.setup({ delay: null })
    const { handlers } = mountHook()
    render(
      <label>
        Search the queue
        <input />
      </label>,
    )

    await user.click(screen.getByLabelText('Search the queue'))
    await user.keyboard('annexe')

    // Typing "annexe" into a filter box must not fire approve, reject and
    // revision on the way through.
    expect(fired(handlers)).toEqual([])
    expect(screen.getByLabelText('Search the queue')).toHaveValue('annexe')
  })

  it('stays out of a textarea, which is where a rejection reason is typed', async () => {
    const user = userEvent.setup({ delay: null })
    const { handlers } = mountHook()
    render(
      <label>
        Reason for rejection
        <textarea />
      </label>,
    )

    const box = screen.getByLabelText('Reason for rejection')
    await user.click(box)
    await user.keyboard('rejected, wrong annexe')

    expect(fired(handlers)).toEqual([])
    // The reason has to survive being typed. Swallowing the keystroke would
    // leave this dialog demanding a comment it will not let anybody write.
    expect(box).toHaveValue('rejected, wrong annexe')
    expect(pressOn(box, 'x').defaultPrevented).toBe(false)
  })

  it('stays out of a select', async () => {
    const user = userEvent.setup({ delay: null })
    const { handlers } = mountHook()
    render(
      <label>
        Sort
        <select>
          <option>Oldest</option>
        </select>
      </label>,
    )

    screen.getByLabelText('Sort').focus()
    await user.keyboard('j')

    // Bare letters are how a native select is navigated.
    expect(fired(handlers)).toEqual([])
  })

  it('stays out of a rich-text field', () => {
    const { handlers } = mountHook()
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    // jsdom parses the attribute but never derives `isContentEditable` from
    // it, so the property the guard actually reads is stood up here. A jsdom
    // gap, like the layout numbers below - not app behaviour.
    Object.defineProperty(editor, 'isContentEditable', { value: true })
    document.body.appendChild(editor)

    try {
      pressOn(editor, 'x')
      pressOn(editor, 'j')

      // Nothing in the queue is contenteditable today. This guard is what
      // keeps a rejection typed into the next rich-text box from rejecting
      // the document halfway through the word.
      expect(fired(handlers)).toEqual([])
    } finally {
      editor.remove()
    }
  })

  it('lets an open dialog keep every key, including Enter', async () => {
    const user = userEvent.setup({ delay: null })
    const { handlers } = mountHook()
    const confirmTheDialog = vi.fn()
    render(
      <div role="dialog" aria-modal="true" aria-label="Reject document">
        <button type="button" onClick={confirmTheDialog}>
          Reject document
        </button>
      </div>,
    )

    screen.getByRole('button', { name: 'Reject document' }).focus()
    await user.keyboard('x')
    await user.keyboard('{Enter}')

    // The page disables the shortcuts while a dialog is open, but the guard
    // has to hold on its own too: a second reject dialog stacking on top of
    // the first is a confirmation nobody can see they already answered.
    expect(fired(handlers)).toEqual([])
    // Kept, not merely ignored. Enter is how the focused confirm button is
    // pressed; a preventDefault here would leave the dialog unanswerable from
    // the keyboard that opened it.
    expect(confirmTheDialog).toHaveBeenCalledTimes(1)
  })

  it('keeps working while a queue row holds focus', async () => {
    const user = userEvent.setup({ delay: null })
    const { handlers } = mountHook()
    render(<button type="button">Warehouse lease extension</button>)

    screen.getByRole('button', { name: 'Warehouse lease extension' }).focus()
    await user.keyboard('j')

    // Clicking a row leaves focus on it. If a focused button counted as a
    // typing target, the shortcuts would die the moment somebody used the
    // mouse once.
    expect(handlers.onNext).toHaveBeenCalledTimes(1)
  })
})

describe('when the shortcuts are live', () => {
  it('does nothing at all while switched off', () => {
    const { handlers } = mountHook(false)

    press('j')
    press('x')

    // The page switches these off on the narrow layout and while a dialog is
    // open; "off" has to mean off, not merely hidden.
    expect(fired(handlers)).toEqual([])
  })

  it('starts listening when it is switched on', () => {
    const { handlers, rerender } = mountHook(false)

    rerender({ on: true, h: handlers as QueueKeyHandlers })
    press('j')

    expect(handlers.onNext).toHaveBeenCalledTimes(1)
  })

  it('stops listening the moment it is switched off', () => {
    const { handlers, rerender } = mountHook(true)

    press('j')
    rerender({ on: false, h: handlers as QueueKeyHandlers })
    press('j')
    press('x')

    // This is the transition the page actually performs: the shortcuts are
    // live, a dialog opens, and `enabled` goes false. If the effect only
    // skipped binding on a fresh mount, X would keep stacking reject dialogs
    // behind the one already on screen.
    expect(fired(handlers)).toEqual(['onNext'])
    expect(handlers.onNext).toHaveBeenCalledTimes(1)
  })

  it('stops listening once the screen is gone', () => {
    const { handlers, unmount } = mountHook()

    unmount()
    press('x')

    // A leaked listener would still be opening reject dialogs for a queue
    // that is no longer on screen.
    expect(fired(handlers)).toEqual([])
  })

  it('uses the handlers it has now, not the ones it mounted with', () => {
    const first = makeHandlers()
    const second = makeHandlers()
    const { rerender } = renderHook(
      ({ h }: { h: QueueKeyHandlers }) => useQueueKeyboard(true, h),
      { initialProps: { h: first as QueueKeyHandlers } },
    )

    rerender({ h: second as QueueKeyHandlers })
    press('j')

    // The page rebuilds these every time the cursor moves. A stale closure
    // here would move from where the cursor used to be, which after two
    // presses is a different document entirely.
    expect(second.onNext).toHaveBeenCalledTimes(1)
    expect(first.onNext).not.toHaveBeenCalled()
  })
})

describe('keeping the cursor row in view', () => {
  /**
   * jsdom has no layout, so `offsetTop`, `offsetHeight` and `clientHeight`
   * are all zero and `scrollTop` is a read-only zero. These stand in for the
   * browser's numbers - a jsdom gap, not app behaviour.
   */
  function makeScroller({
    scrollTop = 0,
    clientHeight = 300,
    rowTop = 0,
    rowHeight = 80,
  }: {
    scrollTop?: number
    clientHeight?: number
    rowTop?: number
    rowHeight?: number
  } = {}) {
    const container = document.createElement('div')
    const row = document.createElement('button')
    container.appendChild(row)

    Object.defineProperty(container, 'clientHeight', {
      value: clientHeight,
      configurable: true,
    })
    Object.defineProperty(container, 'scrollTop', {
      value: scrollTop,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(row, 'offsetTop', { value: rowTop, configurable: true })
    Object.defineProperty(row, 'offsetHeight', {
      value: rowHeight,
      configurable: true,
    })

    return { container, row }
  }

  it('brings a row above the view back to the top edge', () => {
    const { container, row } = makeScroller({ scrollTop: 400, rowTop: 100 })

    scrollRowIntoView(container, row)

    expect(container.scrollTop).toBe(100)
  })

  it('scrolls only far enough to show a row below the view', () => {
    const { container, row } = makeScroller({
      scrollTop: 0,
      clientHeight: 300,
      rowTop: 900,
      rowHeight: 80,
    })

    scrollRowIntoView(container, row)

    // 980 - 300: the row sits on the bottom edge. Centring it instead would
    // redraw the whole column on every J, which is what makes a keyboard
    // list feel like it is sliding away from you.
    expect(container.scrollTop).toBe(680)
  })

  it('leaves a row that ends exactly on the bottom edge where it is', () => {
    const { container, row } = makeScroller({
      scrollTop: 0,
      clientHeight: 300,
      rowTop: 220,
      rowHeight: 80,
    })

    scrollRowIntoView(container, row)

    // 220 + 80 is exactly 300: the row is fully visible and needs nothing.
    // A `>=` here instead of `>` would scroll by nothing on every J and by a
    // whole row on the boundary, which is the one place the arithmetic is
    // easy to get wrong and impossible to see in a screenshot.
    expect(container.scrollTop).toBe(0)
  })

  it('leaves a row that is already fully visible exactly where it is', () => {
    const { container, row } = makeScroller({
      scrollTop: 50,
      clientHeight: 300,
      rowTop: 100,
      rowHeight: 80,
    })

    scrollRowIntoView(container, row)

    // Nudging on every keypress makes the list feel like it is fighting the
    // person driving it.
    expect(container.scrollTop).toBe(50)
  })

  it('survives a row that has not been rendered yet', () => {
    const { container, row } = makeScroller()

    // `rowRefs` is filled during render, so the first keystroke after a tab
    // change can arrive before the row it names exists.
    expect(() => scrollRowIntoView(container, null)).not.toThrow()
    expect(() => scrollRowIntoView(null, row)).not.toThrow()
    expect(() => scrollRowIntoView(null, null)).not.toThrow()
  })
})
