import { describe, expect, it } from 'vitest'

import {
  EditHistory,
  GROUP_MS,
  endsWord,
  groupFor,
  restore,
  snapshotOf,
} from './memoHistory'

/**
 * The editor's own undo history.
 *
 * What is pinned here is the shape of an "undo": that it returns to the
 * state from before a change, that a word typed letter by letter is one
 * entry rather than five, that a change after an undo forgets the redo, and
 * that the caret comes back where it was.
 */

const snap = (html: string) => ({ html, selection: null })

/** A history with a clock the test controls. */
function timed() {
  let now = 0
  const history = new EditHistory(200, () => now)
  return { history, tick: (ms: number) => (now += ms) }
}

describe('recording and undoing', () => {
  it('has nothing to undo or redo to begin with', () => {
    const history = new EditHistory()
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(false)
    expect(history.undo(snap('a'))).toBeNull()
    expect(history.redo(snap('a'))).toBeNull()
  })

  it('returns to the state from before the change', () => {
    const history = new EditHistory()
    history.record(snap('<p>one</p>'))

    expect(history.undo(snap('<p>one two</p>'))).toEqual(snap('<p>one</p>'))
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(true)
  })

  it('redoes what was undone, and undoes it again', () => {
    const history = new EditHistory()
    history.record(snap('<p>one</p>'))
    history.undo(snap('<p>one two</p>'))

    expect(history.redo(snap('<p>one</p>'))).toEqual(snap('<p>one two</p>'))
    expect(history.canUndo).toBe(true)
    expect(history.canRedo).toBe(false)
  })

  it('forgets the redo once something new is done', () => {
    // The universal rule: a new edit after an undo starts a new future.
    const history = new EditHistory()
    history.record(snap('a'))
    history.undo(snap('ab'))
    history.record(snap('a'))

    expect(history.canRedo).toBe(false)
  })

  it('drops a record identical to the last one', () => {
    /*
     * Two callers can each take the snapshot for one change - the editor
     * around execCommand, and the browser's beforeinput for the same
     * command. One undo must not then cost two presses.
     */
    const history = new EditHistory()
    history.record(snap('a'))
    history.record(snap('a'))

    expect(history.undo(snap('ab'))).toEqual(snap('a'))
    expect(history.canUndo).toBe(false)
  })

  it('keeps only the newest entries once the limit is reached', () => {
    const history = new EditHistory(3)
    for (const html of ['a', 'b', 'c', 'd']) history.record(snap(html))

    expect(history.undo(snap('e'))).toEqual(snap('d'))
    expect(history.undo(snap('d'))).toEqual(snap('c'))
    expect(history.undo(snap('c'))).toEqual(snap('b'))
    expect(history.undo(snap('b'))).toBeNull()
  })
})

describe('grouping keystrokes', () => {
  it('holds a word typed letter by letter as one entry', () => {
    const { history, tick } = timed()
    history.record(snap(''), 'type')
    tick(100)
    history.record(snap('h'), 'type')
    tick(100)
    history.record(snap('he'), 'type')

    expect(history.undo(snap('hel'))).toEqual(snap(''))
    expect(history.canUndo).toBe(false)
  })

  it('starts a new entry after a pause', () => {
    const { history, tick } = timed()
    history.record(snap(''), 'type')
    tick(GROUP_MS + 1)
    history.record(snap('one '), 'type')

    expect(history.undo(snap('one t'))).toEqual(snap('one '))
    expect(history.undo(snap('one '))).toEqual(snap(''))
  })

  it('starts a new entry when the kind of change changes', () => {
    const { history } = timed()
    history.record(snap(''), 'type')
    history.record(snap('ab'), 'delete')

    expect(history.undo(snap('a'))).toEqual(snap('ab'))
    expect(history.undo(snap('ab'))).toEqual(snap(''))
  })

  it('starts a new entry after the group is broken', () => {
    const { history } = timed()
    history.record(snap(''), 'type')
    history.breakGroup()
    history.record(snap('a'), 'type')

    expect(history.undo(snap('ab'))).toEqual(snap('a'))
  })

  it('ends a group with an undo, so typing afterwards is its own entry', () => {
    const { history } = timed()
    history.record(snap(''), 'type')
    history.undo(snap('a'))
    history.record(snap(''), 'type')
    // Recorded fresh rather than folded into the group the undo closed.
    expect(history.canUndo).toBe(true)
    expect(history.canRedo).toBe(false)
  })

  it('names the groups the browser reports', () => {
    expect(groupFor('insertText')).toBe('type')
    expect(groupFor('insertCompositionText')).toBe('type')
    expect(groupFor('deleteContentBackward')).toBe('delete')
    expect(groupFor('deleteContentForward')).toBe('delete')
    expect(groupFor('insertParagraph')).toBeNull()
    expect(groupFor('insertFromPaste')).toBeNull()
    expect(groupFor('formatBold')).toBeNull()
  })

  it('knows a space ends a word', () => {
    expect(endsWord(' ')).toBe(true)
    expect(endsWord('a ')).toBe(true)
    expect(endsWord('a')).toBe(false)
    expect(endsWord(null)).toBe(false)
    expect(endsWord(undefined)).toBe(false)
  })
})

describe('a snapshot of the region', () => {
  function region(html: string): HTMLElement {
    const element = document.createElement('div')
    element.innerHTML = html
    document.body.appendChild(element)
    return element
  }

  function caretAt(node: Node, offset: number) {
    const range = document.createRange()
    range.setStart(node, offset)
    range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  }

  it('holds the markup and where the caret was', () => {
    const element = region('<p>one</p><p>two</p>')
    caretAt(element.childNodes[1]!.firstChild!, 2)

    expect(snapshotOf(element)).toEqual({
      html: '<p>one</p><p>two</p>',
      selection: {
        anchor: { path: [1, 0], offset: 2 },
        focus: { path: [1, 0], offset: 2 },
      },
    })
  })

  it('records no selection when the caret is elsewhere', () => {
    const element = region('<p>one</p>')
    const other = region('<p>other</p>')
    caretAt(other.firstChild!.firstChild!, 1)

    expect(snapshotOf(element).selection).toBeNull()
  })

  it('puts the markup and the caret back', () => {
    const element = region('<p>one</p><p>two</p>')
    caretAt(element.childNodes[1]!.firstChild!, 2)
    const before = snapshotOf(element)

    element.innerHTML = '<p>changed</p>'
    restore(element, before)

    const selection = window.getSelection()!
    expect(element.innerHTML).toBe('<p>one</p><p>two</p>')
    expect(selection.anchorNode).toBe(element.childNodes[1]!.firstChild)
    expect(selection.anchorOffset).toBe(2)
  })

  it('keeps a selection that runs across two nodes', () => {
    const element = region('<p>one</p><p>two</p>')
    const range = document.createRange()
    range.setStart(element.childNodes[0]!.firstChild!, 1)
    range.setEnd(element.childNodes[1]!.firstChild!, 1)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const before = snapshotOf(element)

    element.innerHTML = ''
    restore(element, before)

    expect(selection.anchorNode).toBe(element.childNodes[0]!.firstChild)
    expect(selection.anchorOffset).toBe(1)
    expect(selection.focusNode).toBe(element.childNodes[1]!.firstChild)
    expect(selection.focusOffset).toBe(1)
  })

  it('leaves the caret at the end when the recorded place no longer exists', () => {
    const element = region('<p>one</p>')
    restore(element, {
      html: '<p>one</p>',
      selection: {
        anchor: { path: [4, 0], offset: 0 },
        focus: { path: [4, 0], offset: 0 },
      },
    })

    const selection = window.getSelection()!
    expect(selection.anchorNode).toBe(element)
    expect(selection.anchorOffset).toBe(element.childNodes.length)
  })

  it('clamps an offset that outruns the node rather than throwing', () => {
    const element = region('<p>one</p>')
    restore(element, {
      html: '<p>one</p>',
      selection: {
        anchor: { path: [0, 0], offset: 40 },
        focus: { path: [0, 0], offset: 40 },
      },
    })

    expect(window.getSelection()!.anchorOffset).toBe(3)
  })
})
