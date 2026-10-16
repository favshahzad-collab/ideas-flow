import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Route, Routes } from 'react-router-dom'
import { AdminOnly } from './AppLayout'
import { ROUTES } from '../types/routes'
import { makeUser, renderWithProviders, ADMIN_CAPABILITIES, STAFF_CAPABILITIES } from '../test/render'

/**
 * The guard on an administration screen.
 *
 * It decides which of two screens somebody is shown, and nothing more - the
 * route behind the screen refuses the request on its own authority whatever
 * this concludes. What matters here is that it asks the *same question the
 * sidebar asks*, so a row can never open a page that turns the person away.
 */

const at = (
  path: string,
  needs: Parameters<typeof AdminOnly>[0]['needs'],
  capabilities: readonly string[],
  role: 'USER' | 'ADMINISTRATOR' = 'ADMINISTRATOR'
) =>
  renderWithProviders(
    <Routes>
      <Route
        path={path}
        element={
          <AdminOnly needs={needs}>
            <h1>The administration screen</h1>
          </AdminOnly>
        }
      />
      <Route path={ROUTES.dashboard} element={<h1>Documents</h1>} />
    </Routes>,
    {
      route: path,
      currentUser: { user: makeUser({ role, capabilities: capabilities as never }) },
    }
  )

describe('opening an administration screen', () => {
  it('lets in somebody holding the capability it names', () => {
    at('/admin/login-activity', 'sessions.view', ADMIN_CAPABILITIES)

    expect(screen.getByRole('heading', { name: 'The administration screen' })).toBeInTheDocument()
  })

  it('turns away somebody without it, whatever their role says', () => {
    /*
     * The case the two guards used to disagree on. An administrator who does
     * not hold this particular capability is sent to the documents screen -
     * because the sidebar would not have offered them the row either, and the
     * route behind it would refuse them regardless.
     */
    at(
      '/admin/login-activity',
      'sessions.view',
      ADMIN_CAPABILITIES.filter(capability => capability !== 'sessions.view')
    )

    expect(screen.getByRole('heading', { name: 'Documents' })).toBeInTheDocument()
  })

  it('turns away ordinary staff', () => {
    at('/admin/login-activity', 'sessions.view', STAFF_CAPABILITIES, 'USER')

    expect(screen.getByRole('heading', { name: 'Documents' })).toBeInTheDocument()
  })

  it('falls back to the role when no capability is named', () => {
    // Nothing passes `needs` today, but the guard has to behave for a screen
    // added without one rather than letting everybody through.
    at('/admin/anything', undefined, [], 'USER')

    expect(screen.getByRole('heading', { name: 'Documents' })).toBeInTheDocument()
  })

  it('waits rather than redirecting while the user is still loading', () => {
    /*
     * The redirect-on-load bug this shape avoids: capabilities arrive with
     * `/api/auth/me`, so a guard that decided before it landed would bounce
     * every administrator to the documents screen on a cold navigation.
     */
    renderWithProviders(
      <AdminOnly needs="sessions.view">
        <h1>The administration screen</h1>
      </AdminOnly>,
      { currentUser: { user: null, loading: true } }
    )

    expect(screen.queryByRole('heading', { name: 'The administration screen' })).not.toBeInTheDocument()
    expect(screen.getByText(/Loading your workspace/i)).toBeInTheDocument()
  })
})

describe('against a server that does not report capabilities', () => {
  /*
   * A browser holding this build while the server is older, or mid-deploy.
   * `getMe` has no list to pass on, and an empty list read as a refusal would
   * lock an administrator out of every administration screen at once - the
   * whole navigation group gone, every URL bouncing to the documents list,
   * and nothing on screen to say why.
   *
   * An empty list cannot honestly mean "may do nothing": every signed-in
   * person holds the everyday capabilities. It means the server did not say,
   * and the answer to that is the rule this replaced.
   */
  it('lets an administrator in on the strength of their role', () => {
    at('/admin/login-activity', 'sessions.view', [], 'ADMINISTRATOR')

    expect(screen.getByRole('heading', { name: 'The administration screen' })).toBeInTheDocument()
  })

  it('still keeps ordinary staff out', () => {
    at('/admin/login-activity', 'sessions.view', [], 'USER')

    expect(screen.getByRole('heading', { name: 'Documents' })).toBeInTheDocument()
  })
})
