import { describe, expect, it } from 'vitest'

import {
  applyBodyAttrs,
  hoistNestedBlocks,
  imageHtml,
  emptyMemoBody,
  htmlToMemoBody,
  memoBodyHasNoProse,
  memoBodyIsEmpty,
  memoBodyLength,
  memoBodyProseLength,
  memoBodyToHtml,
  outlineBody,
  plainTextToBlocks,
} from './memoDom'
import type { MemoBody, MemoTableNode } from '../types/memo'

/**
 * The editor is a contenteditable region, so the DOM is the model and this
 * file is the whole contract with the server.
 *
 * The server refuses an unknown node rather than dropping it - correct for an
 * artefact somebody signs, and it means anything not normalised here is not a
 * cosmetic problem but a memo that cannot be submitted, discovered at the
 * moment of submitting it. Hence the shape of these tests: mostly they feed in
 * the debris browsers actually leave behind.
 */

const read = (html: string): MemoBody => {
  const root = document.createElement('div')
  root.innerHTML = html
  return htmlToMemoBody(root)
}

describe('reading blocks out of the editor', () => {
  it('reads paragraphs', () => {
    expect(read('<p>One</p><p>Two</p>')).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Two' }] },
      ],
    })
  })

  it('keeps an empty paragraph, because it is a deliberate blank line', () => {
    const body = read('<p>One</p><p><br></p><p>Two</p>')
    expect(body.content).toHaveLength(3)
    expect(body.content[1]).toEqual({ type: 'paragraph' })
  })

  it('reads both heading levels', () => {
    const body = read('<h1>BACKGROUND:</h1><h2>Detail</h2>')
    expect(body.content).toEqual([
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'BACKGROUND:' }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Detail' }] },
    ])
  })

  it('folds a deeper heading into the lower of the two the template draws', () => {
    // Only ever arrives by paste, and the alternative is dropping the text.
    const body = read('<h4>Pasted from somewhere</h4>')
    expect(body.content[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } })
  })

  it('reads both kinds of list', () => {
    const body = read('<ul><li>A</li><li>B</li></ul><ol><li>C</li></ol>')

    expect(body.content[0]).toEqual({
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] },
      ],
    })
    expect(body.content[1]).toMatchObject({ type: 'orderedList' })
  })

  it('keeps a half-typed list item, which every list has while it is written', () => {
    const body = read('<ul><li>A</li><li><br></li></ul>')
    // A list item must hold at least one paragraph or the server refuses it.
    expect(body.content[0]).toMatchObject({
      content: [{}, { type: 'listItem', content: [{ type: 'paragraph' }] }],
    })
  })

  it('drops a list with no items rather than emitting an empty one', () => {
    expect(read('<ul></ul>').content).toEqual([])
  })

  it('reads a page break', () => {
    expect(read('<div data-memo-page-break="true">Page break</div>').content).toEqual([
      { type: 'pageBreak' },
    ])
  })

  it('treats a stray element as a paragraph rather than losing its words', () => {
    // Browsers produce divs on Enter in some configurations, and a pasted
    // fragment can contain anything at all.
    const body = read('<div>Typed into a div</div><section>Or worse</section>')
    expect(body.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Typed into a div' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Or worse' }] },
    ])
  })
})

describe('reading emphasis', () => {
  it('reads the tags execCommand produces', () => {
    const body = read('<p><b>Bold</b><i>Italic</i><u>Under</u></p>')
    expect(body.content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'Italic', marks: [{ type: 'italic' }] },
        { type: 'text', text: 'Under', marks: [{ type: 'underline' }] },
      ],
    })
  })

  it('reads the tags other engines produce for the same thing', () => {
    const body = read('<p><strong>A</strong><em>B</em></p>')
    expect(body.content[0]).toMatchObject({
      content: [
        { text: 'A', marks: [{ type: 'bold' }] },
        { text: 'B', marks: [{ type: 'italic' }] },
      ],
    })
  })

  it('reads emphasis a browser expressed as a style', () => {
    /*
     * The editor turns styleWithCSS off, which asks for <b>. A browser that
     * ignores the flag hands back a styled span instead, and reading only
     * tags would lose the emphasis silently on its way into a signed memo.
     */
    const body = read(
      '<p><span style="font-weight: bold">A</span><span style="font-style: italic">B</span></p>',
    )
    expect(body.content[0]).toMatchObject({
      content: [
        { text: 'A', marks: [{ type: 'bold' }] },
        { text: 'B', marks: [{ type: 'italic' }] },
      ],
    })
  })

  it('carries nested emphasis through in a fixed order', () => {
    // Bold-then-italic and italic-then-bold are the same run, and what was
    // submitted should not depend on which button was pressed first.
    const one = read('<p><b><i>Both</i></b></p>')
    const other = read('<p><i><b>Both</b></i></p>')

    expect(one).toEqual(other)
    expect(one.content[0]).toMatchObject({
      content: [{ marks: [{ type: 'bold' }, { type: 'italic' }] }],
    })
  })

  it('merges adjacent runs that say the same thing', () => {
    // A browser splits one word into several text nodes as it is edited.
    const body = read('<p><b>One</b><b> two</b><b> three</b></p>')
    expect(body.content[0]).toMatchObject({
      content: [{ text: 'One two three', marks: [{ type: 'bold' }] }],
    })
  })

  it('keeps unmarked text beside marked text', () => {
    const body = read('<p>Plain <b>bold</b> plain</p>')
    expect(body.content[0]).toMatchObject({
      content: [{ text: 'Plain ' }, { text: 'bold' }, { text: ' plain' }],
    })
  })
})

describe('reading tables', () => {
  const table = (body: MemoBody) => body.content[0] as MemoTableNode

  it('reads a header row and body rows', () => {
    const body = read(
      '<table><tbody><tr><th>Item</th><th>Amount</th></tr><tr><td>Fuel</td><td>50</td></tr></tbody></table>',
    )

    expect(table(body).content[0]!.content.map(cell => cell.type)).toEqual([
      'tableHeader',
      'tableHeader',
    ])
    expect(table(body).content[1]!.content[0]).toMatchObject({
      type: 'tableCell',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fuel' }] }],
    })
  })

  it('pads a ragged table rather than letting the server refuse it', () => {
    /*
     * One deleted cell produces this, and the server refuses a ragged table
     * outright - correctly, because the columns then stop lining up with
     * their headers. Padding costs an empty cell; not padding costs a
     * submission, at the moment of signing.
     */
    const body = read(
      '<table><tbody><tr><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td></tr></tbody></table>',
    )

    const widths = table(body).content.map(row => row.content.length)
    expect(widths).toEqual([3, 3])
  })

  it('drops a table with no rows', () => {
    expect(read('<table><tbody></tbody></table>').content).toEqual([])
  })
})

describe('putting a stored body back into the editor', () => {
  const roundTrip = (body: MemoBody): MemoBody => read(memoBodyToHtml(body))

  it('survives a round trip', () => {
    const body: MemoBody = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'BACKGROUND:' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'It is submitted that ' },
            { type: 'text', text: 'Mr. Inayat Hussain', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' has requested a revision.' },
          ],
        },
        { type: 'paragraph' },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }] },
          ],
        },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item' }] }] },
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fuel' }] }] },
              ],
            },
          ],
        },
        { type: 'pageBreak' },
      ],
    }

    expect(roundTrip(body)).toEqual(body)
  })

  it('escapes text that would otherwise be read as markup', () => {
    // A memo about a policy can perfectly well contain a < or an &, and an
    // unescaped one would silently become an element on the way back in.
    const body: MemoBody = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Fuel < 50 litres & rising <b>not bold</b>' }],
        },
      ],
    }

    expect(roundTrip(body)).toEqual(body)
  })

  it('gives an empty body something to type into', () => {
    expect(memoBodyToHtml(emptyMemoBody())).toContain('<p>')
  })
})

/**
 * A table that was shaped, closed, and opened again.
 *
 * The editor seeds itself by writing this HTML into the region, so anything
 * the writer drops is lost the moment a draft is reopened - the columns
 * somebody sized spring back to even and the merged heading splits in three,
 * with nothing to say it happened. The round trip is the only way to see it.
 */
describe('a table that has been sized and merged', () => {
  const shaped: MemoTableNode = {
    type: 'table',
    attrs: { widths: [0.5, 0.25, 0.25] },
    content: [
      {
        type: 'tableRow',
        content: [
          { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
          { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] },
          { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'C' }] }] },
        ],
      },
      {
        type: 'tableRow',
        attrs: { height: 42 },
        content: [
          {
            type: 'tableCell',
            attrs: { colspan: 3 },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Across' }] }],
          },
        ],
      },
    ],
  }

  const body: MemoBody = { type: 'doc', content: [shaped] }
  const reopened = () => read(memoBodyToHtml(body)).content[0] as MemoTableNode

  it('comes back with the same column widths', () => {
    expect(reopened().attrs?.widths).toEqual([0.5, 0.25, 0.25])
  })

  it('comes back with the merge still merged', () => {
    const row = reopened().content[1]!
    expect(row.content).toHaveLength(1)
    expect(row.content[0]!.attrs?.colspan).toBe(3)
  })

  it('comes back with the row still the height it was given', () => {
    expect(reopened().content[1]!.attrs?.height).toBe(42)
  })

  it('does not pad a merged row out to the column count', () => {
    // Counted by cells rather than by span, the row holding one cell across
    // three columns looks two cells short, and three empty ones would appear
    // beside it every time the draft was opened.
    expect(reopened().content[1]!.content).toHaveLength(1)
  })

  it('leaves a table nobody has shaped carrying nothing extra', () => {
    /*
     * The path every table filed before any of this took, and the one most
     * still take. An `attrs` that appeared on its own would make the widths
     * disagree with the column count, and the server refuses that.
     */
    const plain: MemoBody = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] },
              ],
            },
          ],
        },
      ],
    }

    const table = read(memoBodyToHtml(plain)).content[0] as MemoTableNode
    expect(table.attrs).toBeUndefined()
    expect(table.content[0]!.attrs).toBeUndefined()
    expect(table.content[0]!.content[0]!.attrs).toBeUndefined()
  })
})

describe('pasted text', () => {
  it('becomes one paragraph per line', () => {
    expect(plainTextToBlocks('One\nTwo')).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Two' }] },
    ])
  })

  it('keeps blank lines as blank paragraphs', () => {
    expect(plainTextToBlocks('One\n\nTwo')).toHaveLength(3)
  })

  it('handles the line endings a Windows clipboard produces', () => {
    expect(plainTextToBlocks('One\r\nTwo')).toHaveLength(2)
  })
})

describe('measuring a body', () => {
  it('counts the characters the server counts', () => {
    const body = read('<h1>AB</h1><p>CDE</p><ul><li>F</li></ul>')
    expect(memoBodyLength(body)).toBe(6)
  })

  it('knows an untouched editor is empty', () => {
    expect(memoBodyIsEmpty(read('<p><br></p>'))).toBe(true)
    expect(memoBodyIsEmpty(read('<p>Something</p>'))).toBe(false)
  })

  it('counts the outline headings as characters, because they are', () => {
    const outline = outlineBody(['BACKGROUND:', 'Recommendation'])
    expect(outline.content).toHaveLength(4)
    expect(memoBodyLength(outline)).toBeGreaterThan(0)
  })
})

/**
 * Whether anybody has actually written a memo.
 *
 * Separate from the character count, and this is the distinction that
 * matters: choosing a memo type drops that type's outline into the editor,
 * so every measure based on "is there any text?" answered yes the moment a
 * type was picked - and the checklist ticked "Memo written" for a memo
 * containing nothing but the headings this system had put there itself.
 */
describe('telling a written memo from a blank outline', () => {
  it('sees nothing written in an outline on its own', () => {
    expect(memoBodyHasNoProse(outlineBody(['BACKGROUND:', 'Recommendation']))).toBe(true)
  })

  it('sees a memo as soon as there is a sentence under a heading', () => {
    const body = read('<h1>BACKGROUND:</h1><p>It is submitted.</p>')
    expect(memoBodyHasNoProse(body)).toBe(false)
    expect(memoBodyProseLength(body)).toBe('It is submitted.'.length)
  })

  it('counts a list and a table as writing', () => {
    expect(memoBodyHasNoProse(read('<h1>H</h1><ul><li>One</li></ul>'))).toBe(false)
    expect(
      memoBodyHasNoProse(read('<h1>H</h1><table><tbody><tr><td>Fuel</td></tr></tbody></table>')),
    ).toBe(false)
  })

  it('sees nothing written in an empty editor', () => {
    expect(memoBodyHasNoProse(read('<p><br></p>'))).toBe(true)
  })
})

describe('the line breaks browsers leave behind', () => {
  it('ignores the filler inside an empty block', () => {
    // Every browser puts a <br> in an empty block. Read as a space it made
    // each deliberate blank line a paragraph containing one - so the editor
    // could no longer tell an untouched memo from a written one.
    expect(read('<p><br></p>').content[0]).toEqual({ type: 'paragraph' })
  })

  it('still keeps two words apart when a break genuinely separates them', () => {
    expect(read('<p>One<br>Two</p>').content[0]).toMatchObject({
      content: [{ text: 'One Two' }],
    })
  })

  it('ignores a break with nothing before it', () => {
    expect(read('<p><br>One</p>').content[0]).toMatchObject({
      content: [{ text: 'One' }],
    })
  })

  it('ignores a break with nothing after it', () => {
    expect(read('<p>One<br></p>').content[0]).toMatchObject({
      content: [{ text: 'One' }],
    })
  })
})

/**
 * The editor seeds itself by assigning `memoBodyToHtml` to `innerHTML`, and
 * paste runs through the same path - clipboard text becomes blocks, blocks
 * become HTML. So everything a person can paste reaches the escaper, and
 * these are the tests that say it holds.
 */
describe('text that looks like markup', () => {
  const intoEditor = (text: string): HTMLElement => {
    const root = document.createElement('div')
    root.innerHTML = memoBodyToHtml({ type: 'doc', content: plainTextToBlocks(text) })
    return root
  }

  it('stays text when pasted', () => {
    const root = intoEditor('<script>alert(1)</script>')

    expect(root.querySelector('script')).toBeNull()
    expect(root.textContent).toBe('<script>alert(1)</script>')
  })

  it('does not become emphasis', () => {
    const root = intoEditor('Not <b>actually</b> bold')

    expect(root.querySelector('b')).toBeNull()
    expect(htmlToMemoBody(root).content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'Not <b>actually</b> bold' }],
    })
  })

  it('does not smuggle in an image with a handler on it', () => {
    const root = intoEditor('<img src=x onerror="alert(1)">')

    expect(root.querySelector('img')).toBeNull()
    expect(root.textContent).toContain('onerror')
  })
})

describe('what a pasted document is wrapped in', () => {
  it('steps into a wrapper rather than flattening the table inside it', () => {
    /*
     * Word puts everything in a `<div class=WordSection1>`. Read as a
     * paragraph, that div would turn the table inside it into one line of
     * text - the one thing pasting a table must not do.
     */
    const body = read(
      '<div class="WordSection1"><p>Intro</p><table><tbody><tr><td>a</td></tr></tbody></table></div>',
    )

    expect(body.content.map(block => block.type)).toEqual(['paragraph', 'table'])
  })

  it('steps into an element it has never heard of, for the same reason', () => {
    const body = read(
      '<google-sheets-html-origin><table><tbody><tr><td>a</td></tr></tbody></table></google-sheets-html-origin>',
    )

    expect(body.content.map(block => block.type)).toEqual(['table'])
  })

  it('still reads a div holding only text as the paragraph it is', () => {
    expect(read('<div>Typed into a div</div>').content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Typed into a div' }] },
    ])
  })
})

describe('inline debris at the top level', () => {
  const texts = (body: MemoBody) =>
    body.content.map(block =>
      block.type === 'paragraph' ? block.content?.map(run => run.text).join('|') : block.type,
    )

  it('gathers one line of loose nodes into one paragraph', () => {
    // What a browser leaves when the last paragraph is deleted and typing
    // carries on: text and emphasis with no block around them. They were
    // being shown on one line, so they read as one.
    const body = read('Hello <b>world</b>')

    expect(body.content).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world', marks: [{ type: 'bold' }] },
        ],
      },
    ])
  })

  it('breaks the loose run where a block begins', () => {
    expect(texts(read('before<p>block</p>after'))).toEqual(['before', 'block', 'after'])
  })

  it('does not make a paragraph out of the whitespace between two blocks', () => {
    expect(texts(read('<p>a</p>\n  <p>b</p>\n'))).toEqual(['a', 'b'])
  })
})

describe('a picture', () => {
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

  it('reads the editor picture back as a node, with its description and its share', () => {
    const body = read(imageHtml({ src: PNG, alt: 'The "broken" tray', share: 0.6 }))

    expect(body.content).toEqual([
      { type: 'image', attrs: { src: PNG, alt: 'The "broken" tray', share: 0.6 } },
    ])
  })

  it('writes a picture as a block the caret steps over, with its description made safe', () => {
    const html = imageHtml({ src: PNG, alt: 'The "broken" <tray>' })

    expect(html).toContain('contenteditable="false"')
    expect(html).toContain('alt="The &quot;broken&quot; &lt;tray&gt;"')
    expect(read(html).content[0]).toMatchObject({ attrs: { alt: 'The "broken" <tray>' } })
  })

  it('round-trips through the seed', () => {
    const body: MemoBody = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'The printer:' }] },
        { type: 'image', attrs: { src: PNG, alt: 'Tray', share: 0.45 } },
        { type: 'image', attrs: { src: PNG } },
      ],
    }

    expect(read(memoBodyToHtml(body)).content).toEqual(body.content)
  })

  it('drops a picture the memo could not carry, and keeps the text around it', () => {
    const body = read(
      '<p>Before</p><figure data-memo-image="true"><img src="https://example.com/a.png"></figure><p>After</p>',
    )

    expect(body.content.map(block => block.type)).toEqual(['paragraph', 'paragraph'])
  })

  it('ignores a share outside what the server accepts', () => {
    const html = imageHtml({ src: PNG }).replace(
      'class="memo-image"',
      'class="memo-image" data-memo-share="1.5"',
    )

    expect(read(html).content[0]).toEqual({ type: 'image', attrs: { src: PNG } })
  })

  it('never writes a src that is not a picture carried in the memo', () => {
    expect(imageHtml({ src: 'javascript:alert(1)' })).toContain('src=""')
    expect(imageHtml({ src: 'https://example.com/a.png' })).toContain('src=""')
  })
})

describe('blocks a browser nested', () => {
  /*
   * Chromium, asked for a list with the caret in a paragraph, puts the list
   * inside the paragraph. The editor lifts it out after every command; and
   * should anything still arrive nested, the reader takes it as the
   * paragraphs it is rather than dropping it.
   */
  /*
   * Built with the DOM rather than parsed from markup: an HTML parser closes
   * a paragraph the moment it meets a list, so `<p><ul>` cannot be written -
   * which is why nothing on the way in ever produced this, and only a
   * browser editing the tree in place does.
   */
  function el(tag: string, ...children: (Node | string)[]): HTMLElement {
    const element = document.createElement(tag)
    element.append(...children)
    return element
  }
  const list = (...items: string[]) => el('ul', ...items.map(item => el('li', item)))
  function region(...children: HTMLElement[]): HTMLElement {
    const host = document.createElement('div')
    host.append(...children)
    return host
  }

  it('lifts a list out of the paragraph it was made in', () => {
    const host = region(el('p', list('x')))

    expect(hoistNestedBlocks(host)).toBe(true)
    expect(host.innerHTML).toBe('<ul><li>x</li></ul>')
    expect(hoistNestedBlocks(host)).toBe(false)
  })

  it('keeps the text the holder had around the block, as a block of its own', () => {
    const table = el('table', el('tbody', el('tr', el('td', 'c'))))
    const host = region(el('p', 'before', list('x'), 'after'), el('h1', 'Title', table))

    hoistNestedBlocks(host)

    expect(host.innerHTML).toBe(
      '<p>before</p><ul><li>x</li></ul><p>after</p><h1>Title</h1><table><tbody><tr><td>c</td></tr></tbody></table>',
    )
  })

  it('leaves a paragraph of text alone, and whitespace around a lifted block behind', () => {
    const host = region(el('p', 'plain ', el('strong', 'text')), el('p', ' ', list('x'), ' '))

    hoistNestedBlocks(host)

    expect(host.innerHTML).toBe('<p>plain <strong>text</strong></p><ul><li>x</li></ul>')
  })

  it('keeps the text node the caret is in through the move', () => {
    const host = region(el('p', list('x')))
    document.body.appendChild(host)
    const text = host.querySelector('li')!.firstChild as Text

    hoistNestedBlocks(host)

    expect(text.isConnected).toBe(true)
    expect(text.parentElement?.tagName).toBe('LI')
  })

  it('carries the face and the size on the region, and reads them back', () => {
    const host = document.createElement('div')
    host.innerHTML = '<p>text</p>'

    applyBodyAttrs(host, { font: 'serif', size: 12 })

    expect(host.getAttribute('data-memo-font')).toBe('serif')
    expect(host.getAttribute('data-memo-size')).toBe('12')
    expect(host.style.getPropertyValue('--memo-scale')).toBe('1.2')
    expect(host.style.getPropertyValue('--memo-font')).toContain('Liberation Serif')
    expect(htmlToMemoBody(host).attrs).toEqual({ font: 'serif', size: 12 })
  })

  it('carries nothing for the default, so an unset memo reads as every memo before it', () => {
    const host = document.createElement('div')
    host.innerHTML = '<p>text</p>'

    applyBodyAttrs(host, { font: 'serif', size: 12 })
    applyBodyAttrs(host, { font: 'jakarta', size: 10 })

    expect(host.hasAttribute('data-memo-font')).toBe(false)
    expect(htmlToMemoBody(host)).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'text' }] }],
    })
  })

  it('ignores a setting it does not know', () => {
    const host = document.createElement('div')
    host.setAttribute('data-memo-font', 'comic')
    host.setAttribute('data-memo-size', '13')

    expect(htmlToMemoBody(host).attrs).toBeUndefined()
  })

  it('reads a heading or a list inside a list item as the paragraphs they are', () => {
    const body = read('<ul><li><p>a</p><h1>b</h1><ul><li>c</li><li>d</li></ul></li></ul>')

    expect(body.content).toEqual([
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
              { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
              { type: 'paragraph', content: [{ type: 'text', text: 'c' }] },
              { type: 'paragraph', content: [{ type: 'text', text: 'd' }] },
            ],
          },
        ],
      },
    ])
  })
})
