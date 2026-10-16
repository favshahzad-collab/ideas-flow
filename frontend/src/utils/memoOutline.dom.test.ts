import { describe, expect, it } from 'vitest'

import { UNTITLED, caretToStartOf, outlineOf } from './memoOutline'

/**
 * The headings of a memo, read off the region, and the caret sent to one.
 */

function region(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  return host
}

describe('the outline', () => {
  it('lists the headings in order, with their level', () => {
    const host = region(
      '<h1>BACKGROUND:</h1><p>text</p><h2>Cost</h2><p>more</p><h1>Recommendation</h1>',
    )

    expect(outlineOf(host).map(entry => [entry.level, entry.text])).toEqual([
      [1, 'BACKGROUND:'],
      [2, 'Cost'],
      [1, 'Recommendation'],
    ])
  })

  it('names an empty heading for what it is, and tidies the text of one', () => {
    const host = region('<h1><br></h1><h2>  Two   words </h2>')

    expect(outlineOf(host).map(entry => entry.text)).toEqual([UNTITLED, 'Two words'])
  })

  it('is empty for a memo with no headings', () => {
    expect(outlineOf(region('<p>Just text.</p>'))).toEqual([])
  })
})

describe('jumping to a heading', () => {
  it('puts the caret at the start of it', () => {
    const host = region('<p>Above</p><h1>Recommendation</h1><p>Below</p>')
    const [heading] = outlineOf(host)

    caretToStartOf(heading!.element)

    const selection = window.getSelection()!
    expect(selection.isCollapsed).toBe(true)
    expect(selection.anchorNode).toBe(heading!.element.firstChild)
    expect(selection.anchorOffset).toBe(0)
  })

  it('copes with a heading that has nothing in it yet', () => {
    const host = region('<h1><br></h1>')
    const [heading] = outlineOf(host)

    caretToStartOf(heading!.element)

    expect(window.getSelection()!.anchorNode).toBe(heading!.element)
  })
})
