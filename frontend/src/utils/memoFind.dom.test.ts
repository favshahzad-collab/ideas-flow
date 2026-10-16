import { describe, expect, it } from 'vitest'

import { htmlToMemoBody, pageBreakHtml } from './memoDom'
import { findAll, findPattern, indexText, replaceAll, replaceRange, tidy } from './memoFind'

/**
 * Finding words in a memo without writing into it, and replacing them the
 * way typing over a selection would.
 *
 * On a real region, because the questions are about the DOM: that a match
 * across a bold word comes back as one range, that a match never crosses a
 * paragraph or a cell, and that what a replacement leaves behind is a body
 * `memoDom` reads cleanly.
 */

function region(html: string): HTMLElement {
  const host = document.createElement('div')
  host.setAttribute('contenteditable', 'true')
  host.innerHTML = html
  document.body.appendChild(host)
  return host
}

const plain = { matchCase: false, wholeWord: false }
const texts = (ranges: Range[]) => ranges.map(range => range.toString())

describe('reading the region as text', () => {
  it('joins the text nodes and keeps a way back to each', () => {
    const host = region('<p>Dear <strong>Sir</strong>,</p>')
    const index = indexText(host)

    expect(index.text).toBe('Dear Sir,')
    expect(index.pieces.map(piece => [piece.node.data, piece.start])).toEqual([
      ['Dear ', 0],
      ['Sir', 5],
      [',', 8],
    ])
  })

  it('separates blocks, so a phrase cannot run across them', () => {
    const host = region(
      '<p>one</p><h1>two</h1><ul><li>three</li></ul><table><tbody><tr><td>four</td><td>five</td></tr></tbody></table>',
    )

    expect(indexText(host).text).toBe('one\ntwo\nthree\nfour\nfive')
  })

  it('leaves out the page break’s own label', () => {
    const host = region(`<p>before</p>${pageBreakHtml()}<p>after</p>`)

    expect(indexText(host).text).toBe('before\nafter')
    expect(findAll(host, 'Page break', plain)).toEqual([])
  })
})

describe('finding', () => {
  it('finds every match, in order, regardless of case', () => {
    const host = region('<p>Approval is solicited. approval was given. APPROVAL</p>')

    expect(texts(findAll(host, 'approval', plain))).toEqual(['Approval', 'approval', 'APPROVAL'])
  })

  it('matches case when asked', () => {
    const host = region('<p>Approval is solicited. approval was given.</p>')

    expect(texts(findAll(host, 'approval', { ...plain, matchCase: true }))).toEqual(['approval'])
  })

  it('finds a whole word only when asked', () => {
    const host = region('<p>Mr and Mrs Khan; Mr. Raza; (Mr)</p>')

    expect(findAll(host, 'Mr', plain)).toHaveLength(4)
    expect(texts(findAll(host, 'Mr', { ...plain, wholeWord: true }))).toEqual(['Mr', 'Mr', 'Mr'])
  })

  it('treats letters of any script as part of a word', () => {
    const host = region('<p>khan khanzada خان خانزادہ</p>')

    expect(findAll(host, 'khan', { ...plain, wholeWord: true })).toHaveLength(1)
    expect(findAll(host, 'خان', { ...plain, wholeWord: true })).toHaveLength(1)
  })

  it('finds a phrase across a bold word in the middle of it', () => {
    const host = region('<p>for <strong>kind</strong> consideration</p>')

    const [match] = findAll(host, 'kind consideration', plain)
    expect(match?.toString()).toBe('kind consideration')
    expect(match?.startContainer.parentElement?.tagName).toBe('STRONG')
  })

  it('does not find a phrase across the end of a paragraph or a cell', () => {
    const host = region(
      '<p>kind</p><p>consideration</p><table><tbody><tr><td>kind</td><td>consideration</td></tr></tbody></table>',
    )

    expect(findAll(host, 'kind consideration', plain)).toEqual([])
    expect(findAll(host, 'kind\nconsideration', plain)).toEqual([])
  })

  it('takes the query as written, not as a pattern', () => {
    const host = region('<p>Rs. 1,200 and Rsx and (net)</p>')

    expect(texts(findAll(host, 'Rs.', plain))).toEqual(['Rs.'])
    expect(texts(findAll(host, '(net)', plain))).toEqual(['(net)'])
    expect(findPattern('a+b', plain)?.test('aab')).toBe(false)
  })

  it('finds nothing for an empty query', () => {
    expect(findAll(region('<p>text</p>'), '', plain)).toEqual([])
    expect(findPattern('', plain)).toBeNull()
  })

  it('finds a match that ends exactly at the end of a node', () => {
    const host = region('<p><strong>Total</strong> due</p>')

    expect(texts(findAll(host, 'Total', plain))).toEqual(['Total'])
  })
})

describe('replacing', () => {
  it('keeps the formatting the match began in', () => {
    const host = region('<p>for <strong>kind</strong> consideration</p>')

    const [match] = findAll(host, 'kind', plain)
    replaceRange(match!, 'favourable')
    tidy(host)

    expect(host.innerHTML).toBe('<p>for <strong>favourable</strong> consideration</p>')
  })

  it('replaces a phrase that ran across formatting, and leaves no empty emphasis', () => {
    const host = region('<p>for <strong>kind</strong> consideration</p>')

    replaceAll(host, 'kind consideration', 'approval', plain)

    expect(host.innerHTML).toBe('<p>for <strong>approval</strong></p>')
    expect(htmlToMemoBody(host).content).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'for ' },
          { type: 'text', text: 'approval', marks: [{ type: 'bold' }] },
        ],
      },
    ])
  })

  it('replaces every match and says how many', () => {
    const host = region(
      '<p>Mr Khan and Mr Raza</p><table><tbody><tr><td>Mr Nawaz</td></tr></tbody></table>',
    )

    expect(replaceAll(host, 'Mr', 'Mr.', plain)).toBe(3)
    expect(indexText(host).text).toBe('Mr. Khan and Mr. Raza\nMr. Nawaz')
  })

  it('replaces matches that touch, and matches in one node', () => {
    const host = region('<p>aaa a</p>')

    expect(replaceAll(host, 'a', 'b', plain)).toBe(4)
    expect(host.textContent).toBe('bbb b')
  })

  it('does not find its own replacement again', () => {
    const host = region('<p>a a</p>')

    expect(replaceAll(host, 'a', 'aa', plain)).toBe(2)
    expect(host.textContent).toBe('aa aa')
  })

  it('leaves a block it emptied able to take a caret', () => {
    const host = region('<p>gone</p><p>stays</p>')

    replaceAll(host, 'gone', '', plain)

    expect(host.innerHTML).toBe('<p><br></p><p>stays</p>')
  })

  it('replaces with nothing, and joins the text back into one node', () => {
    const host = region('<p>one two three</p>')

    replaceAll(host, ' two', '', plain)

    expect(host.firstChild!.childNodes).toHaveLength(1)
    expect(host.textContent).toBe('one three')
  })

  it('replaces nothing when nothing matches', () => {
    const host = region('<p>text</p>')

    expect(replaceAll(host, 'absent', 'x', plain)).toBe(0)
    expect(host.innerHTML).toBe('<p>text</p>')
  })
})
