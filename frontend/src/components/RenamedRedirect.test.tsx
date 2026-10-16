import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import {
  NAV_PATHS,
  PAGE_LABELS,
  RENAMED_PATHS,
  RENAMED_TEMPLATE_PREFIX,
  ROUTES,
  pathToPage,
  type AppPage,
} from '../types/routes'
import { Renamed, RenamedTemplate } from './RenamedRedirect'

/**
 * Six screens moved to a path that says their name. Their old addresses are
 * in bookmarks, browser history and links pasted into chat, and until now
 * each would have fallen through to the catch-all and landed on Documents -
 * a working link that quietly goes to the wrong place.
 */

function Where() {
  const { pathname, search, hash } = useLocation()
  return <p>{`at ${pathname}${search}${hash}`}</p>
}

/** The app's redirect routes, and a page for every place they can land. */
function visit(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        {RENAMED_PATHS.map(({ from, to }) => (
          <Route key={from} path={from} element={<Renamed to={to} />} />
        ))}
        <Route path={`${RENAMED_TEMPLATE_PREFIX}:id`} element={<RenamedTemplate />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('an old address', () => {
  it.each([
    ['/notifications', '/inbox'],
    ['/audit-trail', '/audit-ledger'],
    ['/administration', '/admin/people'],
    ['/admin/approval-oversight', '/admin/control-room'],
    ['/admin/workflow-templates', '/admin/workflow-studio'],
    ['/admin/clauses', '/admin/standard-wording'],
  ])('%s goes to %s', (from, to) => {
    visit(from)
    expect(screen.getByText(`at ${to}`)).toBeInTheDocument()
  })

  it('keeps its query string and hash', () => {
    visit('/audit-trail?action=DOCUMENT_REJECTED#top')
    expect(screen.getByText('at /audit-ledger?action=DOCUMENT_REJECTED#top')).toBeInTheDocument()
  })

  it("takes a template's own address to the same template", () => {
    visit('/admin/workflow-templates/3f1c9e2a')
    expect(screen.getByText('at /admin/workflow-studio/3f1c9e2a')).toBeInTheDocument()
  })

  it('takes the new-template address to the new-template screen', () => {
    visit('/admin/workflow-templates/new')
    expect(screen.getByText('at /admin/workflow-studio/new')).toBeInTheDocument()
  })

  it('covers exactly the screens that moved', () => {
    expect(RENAMED_PATHS.map(({ from }) => from)).toEqual([
      '/notifications',
      '/audit-trail',
      '/administration',
      '/admin/approval-oversight',
      '/admin/workflow-templates',
      '/admin/clauses',
    ])
  })

  it('never shadows a screen that lives at that address today', () => {
    // A redirect from a path still in use would make that screen unreachable.
    const current = new Set(Object.values(NAV_PATHS))
    for (const { from, to } of RENAMED_PATHS) {
      expect(current.has(from), from).toBe(false)
      expect(current.has(to), to).toBe(true)
    }
  })
})

describe('one name per screen', () => {
  it('names each moved screen the same in its key, its path and its label', () => {
    const moved: [AppPage, string, string][] = [
      ['inbox', ROUTES.inbox, 'Inbox'],
      ['audit-ledger', ROUTES.auditLedger, 'Audit ledger'],
      ['people', ROUTES.people, 'People & delegation'],
      ['control-room', ROUTES.controlRoom, 'Control room'],
      ['workflow-studio', ROUTES.workflowStudio, 'Workflow studio'],
      ['standard-wording', ROUTES.standardWording, 'Standard wording'],
    ]
    for (const [page, path, label] of moved) {
      expect({ page, path: NAV_PATHS[page as keyof typeof NAV_PATHS], label: PAGE_LABELS[page] }).toEqual({
        page,
        path,
        label,
      })
      expect(pathToPage(path)).toBe(page)
    }
  })

  it("files a template's own screen under Workflow studio", () => {
    expect(pathToPage(ROUTES.workflowTemplate('3f1c9e2a'))).toBe('workflow-designer')
    expect(pathToPage(ROUTES.workflowStudioNew)).toBe('workflow-designer')
    expect(PAGE_LABELS['workflow-designer']).toBe('Workflow studio')
  })
})
