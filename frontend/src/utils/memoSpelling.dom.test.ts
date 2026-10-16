import { describe, expect, it } from 'vitest'

import {
  SpellChecker,
  caretOffset,
  checkable,
  indexText,
  misspellingAt,
  misspellings,
  paintMisspellings,
  tokensOf,
  type Speller,
} from './memoSpelling'

/**
 * Spelling, checked the way the editor checks it: which words are looked
 * at, how the organisation's words and the directory's names are kept out
 * of the way, and what is flagged in a region.
 *
 * With a dictionary of a dozen words standing in for the English one: the
 * questions here are about the checking, not about English.
 */

const ENGLISH = new Set([
  'the', 'approval', 'is', 'solicited', 'for', 'allowance', 'dear', 'sir',
  'of', 'and', 'a', 'to', 'in', 'ms', 'sent', 'from', 'cost', 'pm', 'th',
])

const speller: Speller = {
  correct: word => ENGLISH.has(word.toLowerCase()),
  suggest: word => (word.toLowerCase() === 'aproval' ? ['approval', 'approvals'] : []),
}

/** The token for a word, as the tokeniser cuts it - not the first place its letters occur. */
const token = (text: string, word: string) => tokensOf(text).find(entry => entry.word === word)!

describe('what is looked at', () => {
  it('finds the words, and treats a hyphen as the end of one', () => {
    expect(tokensOf("Eid-ul-Fitr's leave, PKR 5,000").map(entry => entry.word)).toEqual([
      'Eid',
      'ul',
      "Fitr's",
      'leave',
      'PKR',
    ])
  })

  it('checks an ordinary word', () => {
    const text = 'The aproval is solicited.'
    expect(checkable(text, token(text, 'aproval'))).toBe(true)
  })

  it('leaves alone an acronym, a word against a figure, and one letter', () => {
    const text = 'HRD sent it at 5pm on the 19th; see A.'
    expect(checkable(text, token(text, 'HRD'))).toBe(false)
    expect(checkable(text, token(text, 'pm'))).toBe(false)
    expect(checkable(text, token(text, 'th'))).toBe(false)
    expect(checkable(text, token(text, 'A'))).toBe(false)
  })

  it('leaves alone an address, and a word in another script', () => {
    const text = 'Write to moiz.somrow@ideas.com.pk or see https://ideas.com.pk/hr and www.example.com خان'
    expect(checkable(text, token(text, 'somrow'))).toBe(false)
    expect(checkable(text, token(text, 'ideas'))).toBe(false)
    expect(checkable(text, token(text, 'example'))).toBe(false)
    expect(checkable(text, token(text, 'خان'))).toBe(false)
  })
})

describe('the checker', () => {
  it('knows the dictionary, the sentence-initial capital, and the possessive of a known word', () => {
    const checker = new SpellChecker(speller)

    expect(checker.isKnown('approval')).toBe(true)
    expect(checker.isKnown('Approval')).toBe(true)
    expect(checker.isKnown("allowance's")).toBe(true)
    expect(checker.isKnown('aproval')).toBe(false)
  })

  it('never flags the organisation’s words, in any case', () => {
    const checker = new SpellChecker(speller, ['Somrow', 'Gymkhana'])

    expect(checker.isKnown('Somrow')).toBe(true)
    expect(checker.isKnown('SOMROW')).toBe(true)
    expect(checker.isKnown("Somrow's")).toBe(true)
    expect(checker.isKnown('Gymkhana')).toBe(true)
    checker.learn(['Bahria'])
    expect(checker.isKnown('bahria')).toBe(true)
  })

  it('stops flagging a word that was ignored', () => {
    const checker = new SpellChecker(speller)
    expect(checker.isKnown('Aproval')).toBe(false)

    checker.ignore('Aproval')

    expect(checker.isKnown('aproval')).toBe(true)
  })

  it('suggests in the case the word was written', () => {
    const checker = new SpellChecker(speller)

    expect(checker.suggestions('Aproval')).toEqual(['Approval', 'Approvals'])
    expect(checker.suggestions('aproval')).toEqual(['approval', 'approvals'])
  })
})

describe('in a region', () => {
  function region(html: string): HTMLElement {
    const host = document.createElement('div')
    host.innerHTML = html
    return host
  }

  it('flags each unknown word once, in order, as a range over the text', () => {
    const host = region('<p>Dear Sir, aproval is <strong>solicted</strong> for the allowance.</p>')
    const found = misspellings(indexText(host), new SpellChecker(speller))

    expect(found.map(entry => entry.word)).toEqual(['aproval', 'solicted'])
    expect(found[1]!.range.toString()).toBe('solicted')
    expect(found[1]!.range.startContainer.parentElement?.tagName).toBe('STRONG')
  })

  it('leaves out the word being typed', () => {
    const host = region('<p>aproval is solic</p>')
    const index = indexText(host)

    expect(misspellings(index, new SpellChecker(speller), 16).map(entry => entry.word)).toEqual([
      'aproval',
    ])
    expect(misspellings(index, new SpellChecker(speller), null).map(entry => entry.word)).toEqual([
      'aproval',
      'solic',
    ])
  })

  it('finds the flagged word the caret stands in', () => {
    const host = region('<p>aproval is solicted</p>')
    const index = indexText(host)
    const found = misspellings(index, new SpellChecker(speller))
    const text = host.querySelector('p')!.firstChild!

    expect(misspellingAt(found, caretOffset(index, text, 3))?.word).toBe('aproval')
    expect(misspellingAt(found, caretOffset(index, text, 9))).toBeNull()
    expect(misspellingAt(found, caretOffset(index, text, 19))?.word).toBe('solicted')
    expect(caretOffset(index, host, 0)).toBeNull()
  })

  it('paints nothing where there is no registry, and does not fail', () => {
    expect(() => paintMisspellings([])).not.toThrow()
  })
})
