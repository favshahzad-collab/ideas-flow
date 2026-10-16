import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import Button from '../ui/Button'
import { Page, PageHeader } from '../ui/Page'
import TwoFactorCard from './TwoFactorCard'
import { useCurrentUser } from '../../contexts/currentUser'

/**
 * What an administrator without two-step sign-in sees in place of the app.
 *
 * The server refuses every request of theirs except setting it up, so the
 * ordinary pages would each fail in their own way - a list that cannot load,
 * a count that reads zero, a sidebar badge that errors. This stands in front
 * of all of them with the one thing that can be done, which is the same card
 * as on Your account.
 *
 * It does not lift itself the moment the factor is switched on. The card shows
 * the recovery codes once, right then, and they can never be shown again, so
 * the person says when they are done with them.
 */
export default function TwoFactorGate({ onSignOut }: { onSignOut: () => void }) {
  const { refetch } = useCurrentUser()
  const [checking, setChecking] = useState(false)
  const [stillOff, setStillOff] = useState(false)

  const carryOn = async () => {
    setChecking(true)
    setStillOff(false)
    try {
      await refetch()
      // If the gate is still up after this, the factor is not on yet; the
      // provider re-renders this component with the same answer.
      setStillOff(true)
    } finally {
      setChecking(false)
    }
  }

  return (
    <main className="min-h-screen bg-canvas text-content">
      <Page width="narrow">
        <PageHeader
          eyebrow="Administrator account"
          title="Set up two-step sign-in"
          description="An administrator can read every memo, change anybody's role and reach every setting, so this account needs a code from your phone as well as your password. Nothing else opens until it is set up."
          actions={
            <Button variant="secondary" onClick={onSignOut}>
              Sign out
            </Button>
          }
        />

        <div className="space-y-4">
          <TwoFactorCard />

          <div className="flex flex-col gap-2">
            <p id="gate-continue-hint" className="text-meta text-content-muted">
              Once the card above says two-step sign-in is on and your recovery codes
              are saved somewhere safe, carry on to the app.
            </p>
            <div>
              <Button
                variant="secondary"
                icon={<ShieldCheck size={15} aria-hidden="true" />}
                onClick={() => void carryOn()}
                pending={checking}
                aria-describedby="gate-continue-hint"
              >
                Continue to Ideas Flow
              </Button>
            </div>
            <div aria-live="polite">
              {stillOff && !checking && (
                <p className="text-meta text-content-muted">
                  Two-step sign-in is not on yet. Scan the square and type the six digits
                  your app shows, then continue.
                </p>
              )}
            </div>
          </div>
        </div>
      </Page>
    </main>
  )
}
