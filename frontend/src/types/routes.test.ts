import { describe, expect, it } from 'vitest'
import { NAV_PATHS, PAGE_LABELS, pathToPage, safeReturnPath } from './routes'

/**
 * This guards the post-sign-in redirect. The value reaches it from router
 * state, which an attacker can seed by crafting the link a victim clicks —
 * so anything that is not an in-app path has to come back null.
 */
describe('safeReturnPath', () => {
  it('accepts an in-app path', () => {
    expect(safeReturnPath('/dashboard')).toBe('/dashboard')
    expect(safeReturnPath('/documents/abc?tab=audit')).toBe('/documents/abc?tab=audit')
    expect(safeReturnPath('/')).toBe('/')
  })

  it('rejects a protocol-relative URL, which the browser treats as external', () => {
    expect(safeReturnPath('//evil.example.com')).toBeNull()
    expect(safeReturnPath('//evil.example.com/path')).toBeNull()
  })

  it('rejects absolute URLs', () => {
    expect(safeReturnPath('https://evil.example.com')).toBeNull()
    expect(safeReturnPath('http://evil.example.com')).toBeNull()
    expect(safeReturnPath('javascript:alert(1)')).toBeNull()
  })

  it('rejects a relative path that could escape the app root', () => {
    expect(safeReturnPath('dashboard')).toBeNull()
    expect(safeReturnPath('../etc')).toBeNull()
  })

  it('rejects anything that is not a string', () => {
    for (const value of [undefined, null, 0, 1, {}, [], true, () => '/x']) {
      expect(safeReturnPath(value)).toBeNull()
    }
  })
})

describe('pathToPage', () => {
  it('finds its way back to every screen the sidebar can open', () => {
    // Page setup was missing, so on that screen the sidebar highlighted
    // nothing, the breadcrumb had no name and the tab title fell back to the
    // product name. Asked of every nav path, the next one cannot slip through.
    const roundTrip = Object.entries(NAV_PATHS).map(([page, path]) => [page, pathToPage(path)])
    expect(roundTrip).toEqual(Object.keys(NAV_PATHS).map(page => [page, page]))
  })

  it('names Page setup', () => {
    expect(pathToPage('/admin/page-setup')).toBe('page-setup')
    expect(PAGE_LABELS['page-setup']).toBe('Page setup')
  })
})
