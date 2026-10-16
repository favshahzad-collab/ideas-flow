import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadUserImportTemplate } from './AdminApi'

/**
 * The file an administrator downloads before importing a staff list.
 *
 * A template is not documentation - it is the thing somebody opens in Excel,
 * types over, and uploads. Whatever the example row does, the real file will
 * do for every person in the organisation. So the example carrying
 * `password123` was not a placeholder: it was an instruction to invent a
 * password for all of them and keep the lot in a spreadsheet.
 *
 * Where Microsoft sign-in is on, an account needs no password of its own, and
 * the template says so by leaving the column blank in the row an
 * administrator is most likely to copy.
 */
describe('the user import template', () => {
  let captured: Blob | null

  beforeEach(() => {
    captured = null

    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
      captured = blob as Blob
      return 'blob:stub'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    // jsdom would otherwise try to follow the download.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function templateFor(microsoftSignIn: boolean): Promise<string[]> {
    downloadUserImportTemplate(microsoftSignIn)

    if (!captured) throw new Error('no file was produced')

    const text = await captured.text()

    /*
     * The leading byte-order mark is there so Excel opens the file as UTF-8;
     * it is not part of any row.
     *
     * Built from its code point rather than typed, because typing it puts a
     * real U+FEFF in this source file - which is invisible, and which
     * `no-irregular-whitespace` rightly refuses.
     */
    const bom = String.fromCharCode(0xfeff)

    return (text.startsWith(bom) ? text.slice(bom.length) : text).split('\r\n')
  }

  it('names the same columns either way, so one file suits both', async () => {
    const [withSso] = await templateFor(true)
    const [without] = await templateFor(false)

    expect(withSso).toBe(
      'firstName,lastName,email,password,department,role,designation',
    )
    expect(without).toBe(withSso)
  })

  it('leaves the password blank in the row people will copy', async () => {
    const [, first] = await templateFor(true)

    // Blank, and FIRST - the row an administrator copies down the sheet.
    expect(first).toBe('Jane,Smith,jane@company.com,,Human Resources,USER,Manager')
  })

  it('still shows how to give one, for somebody outside the directory', async () => {
    const rows = await templateFor(true)

    expect(rows).toHaveLength(3)
    expect(rows[2]).toContain('set-a-password')
  })

  it('teaches a password when Microsoft sign-in is not on, because blank would not work', async () => {
    /*
     * Without Microsoft sign-in an account with no password has no way in at
     * all. The template must not suggest one.
     */
    const rows = await templateFor(false)

    expect(rows).toHaveLength(2)
    expect(rows[1]).toBe(
      'Jane,Smith,jane@company.com,three-words-here,Human Resources,USER,Manager',
    )
  })

  it('never ships a real-looking password where a blank one would do', async () => {
    const rows = await templateFor(true)

    expect(rows.join('\n')).not.toContain('password123')
  })
})
