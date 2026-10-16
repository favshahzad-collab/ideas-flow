import { describe, expect, it } from 'vitest'

import { mentionAtCaret, personLine, rankByName } from './memoMention'

/**
 * Recognising `@name` under the caret, and writing a person's line.
 *
 * The cases that matter are the ones where an `@` is NOT an invitation to
 * look somebody up: the middle of an email address, a selection rather than
 * a caret, text somewhere else on the page.
 */

function region(html: string): HTMLElement {
  const element = document.createElement('div')
  element.innerHTML = html
  document.body.appendChild(element)
  return element
}

function caret(node: Node, offset: number) {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

describe('the mention under the caret', () => {
  it('finds @ and what follows it, up to the caret', () => {
    const element = region('<p>Dear @ina</p>')
    const text = element.querySelector('p')!.firstChild!
    caret(text, 9)

    expect(mentionAtCaret(element)).toEqual({ node: text, start: 5, end: 9, query: 'ina' })
  })

  it('finds a bare @ with nothing typed yet', () => {
    const element = region('<p>Dear @</p>')
    const text = element.querySelector('p')!.firstChild!
    caret(text, 6)

    expect(mentionAtCaret(element)).toMatchObject({ start: 5, end: 6, query: '' })
  })

  it('finds an @ at the very start, and after an opening bracket', () => {
    const one = region('<p>@k</p>')
    caret(one.querySelector('p')!.firstChild!, 2)
    expect(mentionAtCaret(one)).toMatchObject({ start: 0, query: 'k' })

    const two = region('<p>Refer (@k</p>')
    caret(two.querySelector('p')!.firstChild!, 9)
    expect(mentionAtCaret(two)).toMatchObject({ start: 7, query: 'k' })
  })

  it('ignores an @ in the middle of a word, which is an email address', () => {
    const element = region('<p>Write to kazim@ideas</p>')
    const text = element.querySelector('p')!.firstChild!
    caret(text, 20)

    expect(mentionAtCaret(element)).toBeNull()
  })

  it('ignores an @ the caret has moved past a space from', () => {
    const element = region('<p>See @ina then</p>')
    const text = element.querySelector('p')!.firstChild!
    caret(text, 13)

    expect(mentionAtCaret(element)).toBeNull()
  })

  it('ignores a selection, since there is no caret to type at', () => {
    const element = region('<p>Dear @ina</p>')
    const text = element.querySelector('p')!.firstChild!
    const range = document.createRange()
    range.setStart(text, 5)
    range.setEnd(text, 9)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    expect(mentionAtCaret(element)).toBeNull()
  })

  it('ignores a caret outside the region', () => {
    const element = region('<p>Dear @ina</p>')
    const other = region('<p>@elsewhere</p>')
    caret(other.querySelector('p')!.firstChild!, 10)

    expect(mentionAtCaret(element)).toBeNull()
  })

  it('gives up on a name longer than anybody has', () => {
    const element = region(`<p>@${'a'.repeat(41)}</p>`)
    caret(element.querySelector('p')!.firstChild!, 42)

    expect(mentionAtCaret(element)).toBeNull()
  })
})

describe('ranking what the directory answered', () => {
  const person = (firstName: string, lastName: string) => ({ firstName, lastName })
  const names = (people: { firstName: string; lastName: string }[]) =>
    people.map(p => `${p.firstName} ${p.lastName}`)

  it('puts a name that starts with the letters before one that merely matched', () => {
    // As the directory answers "ina": Finance first, alphabetically.
    const answered = [person('Aamir', 'Raza'), person('Bilal', 'Ahmed'), person('Inayat', 'Hussain')]

    expect(names(rankByName('ina', answered))).toEqual([
      'Inayat Hussain',
      'Aamir Raza',
      'Bilal Ahmed',
    ])
  })

  it('matches a surname and a full name typed with a space', () => {
    const answered = [person('Aamir', 'Raza'), person('Inayat', 'Hussain'), person('Kazim', 'Zaidi')]

    expect(names(rankByName('hus', answered))[0]).toBe('Inayat Hussain')
    expect(names(rankByName('kazim z', answered))[0]).toBe('Kazim Zaidi')
  })

  it('ranks a name containing the letters above one that does not', () => {
    const answered = [person('Aamir', 'Raza'), person('Farina', 'Ali')]

    expect(names(rankByName('rin', answered))).toEqual(['Farina Ali', 'Aamir Raza'])
  })

  it('keeps the directory order among equals and stops at the limit', () => {
    const answered = Array.from({ length: 12 }, (_, at) => person(`Person${at}`, 'X'))

    const ranked = rankByName('', answered)
    expect(ranked).toHaveLength(8)
    expect(ranked[0]!.firstName).toBe('Person0')
    expect(rankByName('', answered, 3)).toHaveLength(3)
  })
})

describe("a person's line", () => {
  it('is the name, the designation and the department', () => {
    expect(
      personLine({
        firstName: 'Inayat',
        lastName: 'Hussain',
        designation: 'Security Executive',
        department: { name: 'Security & Loss Prevention' },
      }),
    ).toBe('Inayat Hussain, Security Executive, Security & Loss Prevention')
  })

  it('leaves out what the record does not have, without a dangling comma', () => {
    expect(
      personLine({ firstName: 'Areeba', lastName: 'Khan', designation: null, department: null }),
    ).toBe('Areeba Khan')
    expect(
      personLine({ firstName: 'Areeba', lastName: 'Khan', designation: '  ', department: { name: 'HR' } }),
    ).toBe('Areeba Khan, HR')
  })
})
