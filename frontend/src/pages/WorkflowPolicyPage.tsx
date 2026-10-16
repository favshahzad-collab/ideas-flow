import { useEffect, useState } from 'react'
import { AlertTriangle, RotateCcw, ShieldCheck, Timer, UserMinus } from 'lucide-react'
import { Page, PageHeader } from '../components/ui/Page'
import { Card, CardHeader } from '../components/ui/Card'
import { LoadingAnnouncer, Skeleton } from '../components/ui/Skeleton'
import Button from '../components/ui/Button'
import ConfirmDialog from '../components/ui/ConfirmDialog'
import Switch from '../components/ui/Switch'
import OfficeCalendarCard from '../components/policy/OfficeCalendarCard'
import {
  clearWorkflowPolicy,
  fetchWorkflowPolicy,
  saveWorkflowPolicy,
  type WorkflowPolicy,
} from '../services/AdminApi'

/**
 * The two decisions the workflow will not make on an organisation's behalf.
 *
 * Both used to be environment variables, which is the wrong place for either:
 * "no approver has ever been chased" is not a thing anybody notices until a
 * memo is three weeks late, and the only way to change it was a file on the
 * server and a restart.
 *
 * The screen leads with what is true right now rather than with a form,
 * because the question somebody arrives with is "why is nobody being chased",
 * not "what are the fields". It also says where the current answer came from:
 * a deployment that sets these in its environment is a real deployment, and a
 * form that silently overwrote it would be the same bug in a nicer shirt.
 */

/** Empty means no deadline. Kept as a string so the field can be emptied. */
type Form = {
  days: string
  allowStepSkip: boolean
  preparerSignsOnSubmit: boolean
  sealApprovedMemos: boolean
}

const toForm = (policy: WorkflowPolicy): Form => ({
  days: policy.slaDefaultDays === null ? '' : String(policy.slaDefaultDays),
  allowStepSkip: policy.allowStepSkip,
  preparerSignsOnSubmit: policy.preparerSignsOnSubmit,
  sealApprovedMemos: policy.sealApprovedMemos,
})

const message = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback

function describeDeadline(days: number | null): string {
  if (days === null) return 'No deadline'
  return `${days} working ${days === 1 ? 'day' : 'days'}`
}

export default function WorkflowPolicyPage() {
  const [policy, setPolicy] = useState<WorkflowPolicy | null>(null)
  const [form, setForm] = useState<Form>({
    days: '',
    allowStepSkip: false,
    preparerSignsOnSubmit: true,
    sealApprovedMemos: true,
  })
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [confirmingReset, setConfirmingReset] = useState(false)
  /*
   * Off on every load and after every save. A memo keeps the rules its
   * approval cycle started with, and moving the ones in flight onto new rules
   * is a deliberate act each time - never a setting left switched on.
   */
  const [applyToInProgress, setApplyToInProgress] = useState(false)
  /** Bumped by Try again, which is the whole of what that button does. */
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // Once per attempt, and abandoned if the screen goes away first.
    let cancelled = false

    fetchWorkflowPolicy()
      .then((next) => {
        if (cancelled) return
        setPolicy(next)
        setForm(toForm(next))
        setLoadError(null)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // Cleared on success rather than before the request, so a failed
        // retry does not blank the message and put it straight back.
        setLoadError(message(error, 'Could not read the workflow policy.'))
      })

    return () => {
      cancelled = true
    }
  }, [attempt])

  /*
   * The field holds a string so it can be empty, and empty is a real answer.
   * Anything that is not a whole number above zero is refused here rather
   * than sent: the server refuses it too, but a round trip to be told "enter
   * a whole number" is a worse way to find out.
   */
  const parsed = form.days.trim() === '' ? null : Number(form.days.trim())
  const daysInvalid =
    parsed !== null &&
    (!Number.isInteger(parsed) || parsed < 1 || parsed > 365)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (daysInvalid) return

    setPending(true)
    setSaveError(null)
    setSaved(null)
    try {
      const next = await saveWorkflowPolicy({
        slaDefaultDays: parsed,
        allowStepSkip: form.allowStepSkip,
        preparerSignsOnSubmit: form.preparerSignsOnSubmit,
        sealApprovedMemos: form.sealApprovedMemos,
        applyToInProgress,
      })
      setPolicy(next)
      setForm(toForm(next))
      const reach = applyToInProgress
        ? ' Memos already in progress follow these rules from now on too.'
        : policy && policy.memosInProgress > 0
          ? ' Memos already in progress keep the rules they started with.'
          : ''
      setApplyToInProgress(false)
      setSaved(
        (parsed === null
          ? 'Saved. New memos have no deadline, so nobody will be chased about them.'
          : `Saved. Approvers of new memos have ${describeDeadline(parsed).toLowerCase()} before they are chased.`) + reach,
      )
    } catch (error) {
      setSaveError(message(error, 'Could not save the policy.'))
    } finally {
      setPending(false)
    }
  }

  async function handBack() {
    setPending(true)
    setSaveError(null)
    setSaved(null)
    try {
      const next = await clearWorkflowPolicy()
      setPolicy(next)
      setForm(toForm(next))
      setConfirmingReset(false)
      setSaved(
        `Handed back to the server. It says: ${describeDeadline(next.slaDefaultDays).toLowerCase()}.`,
      )
    } catch (error) {
      setSaveError(message(error, 'Could not hand the policy back.'))
    } finally {
      setPending(false)
    }
  }

  if (loadError) {
    return (
      <Page width="narrow">
        <PageHeader title="Workflow policy" />
        <Card>
          <div className="flex flex-col items-start gap-3 p-5">
            <p className="text-ui text-content">{loadError}</p>
            <Button
              variant="secondary"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </Button>
          </div>
        </Card>
      </Page>
    )
  }

  if (!policy) {
    return (
      <Page width="narrow">
        <PageHeader title="Workflow policy" />
        <LoadingAnnouncer loading label="Loading the workflow policy" />
        <div className="flex flex-col gap-4">
          <Skeleton className="h-44 rounded-card" />
          <Skeleton className="h-32 rounded-card" />
        </div>
      </Page>
    )
  }

  const fromEnvironment = policy.source === 'environment'

  return (
    <Page width="narrow">
      <PageHeader
        eyebrow="Administration · Workflow policy"
        title="Workflow policy"
        description="What the workflow does when nobody is watching it: how long an approver has before being chased, and whether anyone may be passed over."
      />

      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <Card>
          <CardHeader
            icon={Timer}
            title="Approval deadline"
            hint="Applies to steps that do not name a deadline of their own."
            meta={describeDeadline(policy.slaDefaultDays)}
          />
          <div className="flex flex-col gap-4 p-5">
            <p className="max-w-prose text-ui leading-relaxed text-content-muted">
              With no deadline set, nothing is ever overdue: the queue shows how
              long a memo has been waiting and no one is chased about it. That is
              a real policy — a deadline nobody agreed to is worse than none,
              because people reorder their day around it — but it is worth
              choosing rather than inheriting.
            </p>

            <div className="max-w-60">
              <label className="field-label" htmlFor="sla-days">
                Working days before an approver is chased
              </label>
              <input
                id="sla-days"
                type="number"
                inputMode="numeric"
                min={1}
                max={365}
                step={1}
                className="field h-8.5 tabular-nums"
                placeholder="No deadline"
                value={form.days}
                aria-describedby="sla-days-hint"
                aria-invalid={daysInvalid || undefined}
                onChange={(event) =>
                  setForm((current) => ({ ...current, days: event.target.value }))
                }
              />
              <p id="sla-days-hint" className="mt-1.5 text-2xs text-content-subtle">
                Leave it empty for no deadline. Weekends are not counted.
              </p>
              {daysInvalid && (
                <p className="field-error">
                  <AlertTriangle size={13} aria-hidden="true" />
                  Enter a whole number between 1 and 365, or leave it empty.
                </p>
              )}
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            icon={UserMinus}
            title="Skipping an approver"
            hint="Off unless an organisation deliberately turns it on."
          />
          <div className="flex flex-col gap-4 p-5">
            <p className="max-w-prose text-ui leading-relaxed text-content-muted">
              The workflow&rsquo;s whole claim is that a memo carries the
              approvals it says it carries. A bypass sits in the hands of the
              person who most wants the memo through, which is the one hole that
              claim does not survive. Where it is switched on, every skip still
              demands a reason and is written to the ledger under the name of
              whoever did it.
            </p>
            <Switch
              checked={form.allowStepSkip}
              onChange={(next) =>
                setForm((current) => ({ ...current, allowStepSkip: next }))
              }
              label="Let a preparer pass over an approver who has not acted"
              hint="Recorded in the audit ledger with the reason given."
            />
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Signing at submission"
            hint="On unless submitters only forward documents they did not write."
          />
          <div className="flex flex-col gap-4 p-5">
            <p className="max-w-prose text-ui leading-relaxed text-content-muted">
              Where this is on, the person submitting a document signs it as
              they send it, and a memo drawn here prints their name under the
              first ruled line. Where it is off, they submit it unsigned and
              the first mark on the page is the first approver&rsquo;s &mdash;
              which is what an organisation wants when the people lodging
              documents did not write them.
            </p>
            <p className="max-w-prose text-ui leading-relaxed text-content-muted">
              A memo type may overrule this either way, so a document somebody
              authors and recommends in their own name keeps the author&rsquo;s
              signature whatever is set here.
            </p>
            <Switch
              checked={form.preparerSignsOnSubmit}
              onChange={(next) =>
                setForm((current) => ({
                  ...current,
                  preparerSignsOnSubmit: next,
                }))
              }
              label="The person submitting a document also signs it"
              hint="Off, documents reach the first approver unsigned."
            />
          </div>
        </Card>

        <Card>
          <CardHeader
            icon={ShieldCheck}
            title="Digital seal on approved memos"
            hint="On unless there is a reason to hand out unsealed files."
            meta={
              !policy.sealCertificate.configured
                ? 'No certificate'
                : policy.sealApprovedMemos
                  ? 'Sealing'
                  : 'Not sealing'
            }
          />
          <div className="flex flex-col gap-4 p-5">
            <p className="max-w-prose text-ui leading-relaxed text-content-muted">
              Where this is on, the final approval seals the approved PDF with
              the organisation&rsquo;s certificate, and a PDF reader such as
              Adobe shows who sealed it and whether the file has changed since.
              Where it is off, memos are still signed, certified and recorded
              in the audit ledger exactly as before &mdash; the PDF just does
              not carry the seal. Memos already approved keep whatever they
              were approved with.
            </p>
            {/* Said instead of offered: without a certificate the switch
                would turn nothing on, which is the one thing a switch must
                not do. The certificate is set up on the server. */}
            {!policy.sealCertificate.configured && (
              <p className="max-w-prose rounded-control border border-line bg-sunken p-3 text-meta text-content-muted">
                The server has no seal certificate, so nothing is sealed
                whatever is set here. It is set up on the server with{' '}
                <code>SEAL_P12_PATH</code> and <code>SEAL_P12_PASSWORD</code>;
                see DEPLOY.md.
              </p>
            )}
            <Switch
              checked={form.sealApprovedMemos}
              onChange={(next) =>
                setForm((current) => ({ ...current, sealApprovedMemos: next }))
              }
              label="Seal every memo when it is fully approved"
              hint={
                policy.sealCertificate.signer
                  ? `Sealed as “${policy.sealCertificate.signer}”.`
                  : 'Takes effect once the server has a seal certificate.'
              }
            />
          </div>
        </Card>

        {/* Which memos a save reaches. By default only those submitted from
            now on: each memo keeps the rules its approval cycle started with,
            so a change here cannot make memos in flight overdue overnight or
            seal one and not the next. Reaching them is a choice made here,
            each time, and recorded with the change. */}
        <Card>
          <div className="flex flex-col gap-3 p-5">
            <p className="max-w-prose text-ui leading-relaxed text-content-muted">
              Each memo keeps the deadline, skipping and sealing rules it
              started with. Changes saved here apply to memos submitted from
              now on, and to memos sent round again after a revision or a
              rejection.
            </p>
            {policy.memosInProgress > 0 && (
              <Switch
                checked={applyToInProgress}
                onChange={setApplyToInProgress}
                label={`Also apply these rules to the ${policy.memosInProgress} ${policy.memosInProgress === 1 ? 'memo' : 'memos'} in progress`}
                hint="Recorded in the audit ledger with the change. Their deadlines are worked out again under the new rules."
              />
            )}
          </div>
        </Card>

        <div
          className="flex flex-wrap items-center gap-3"
          aria-live="polite"
          aria-atomic="true"
        >
          <Button type="submit" pending={pending} disabled={daysInvalid}>
            Save policy
          </Button>

          {!fromEnvironment && (
            <Button
              type="button"
              variant="secondary"
              icon={<RotateCcw size={15} aria-hidden="true" />}
              disabled={pending}
              onClick={() => setConfirmingReset(true)}
            >
              Hand back to the server
            </Button>
          )}

          {saved && <span className="text-meta text-accent-ink">{saved}</span>}
          {saveError && (
            <span className="text-meta text-danger-ink">{saveError}</span>
          )}
        </div>

        {/*
          Said plainly, because the two states behave differently and nothing
          else on the screen distinguishes them: a deployment still on its
          environment has these in a file somewhere, and saving here is what
          takes that over.
        */}
        <p className="max-w-prose text-2xs leading-relaxed text-content-subtle">
          {fromEnvironment ? (
            <>
              This policy is coming from the server&rsquo;s own configuration,
              not from here. Saving takes it over, and it stays taken over until
              somebody hands it back.
            </>
          ) : (
            <>
              This policy is set here. Handing it back returns the server to its
              own configuration, which currently says{' '}
              <span className="text-content-muted">
                {describeDeadline(policy.environment.slaDefaultDays).toLowerCase()}
              </span>{' '}
              and{' '}
              <span className="text-content-muted">
                {policy.environment.allowStepSkip
                  ? 'skipping allowed'
                  : 'no skipping'}
              </span>
              , with approved memos{' '}
              <span className="text-content-muted">
                {policy.environment.sealApprovedMemos ? 'sealed' : 'not sealed'}
              </span>
              .
            </>
          )}
        </p>
      </form>

      {/* Its own saves, outside the policy form: the calendar is not part of
          the snapshot a memo keeps, it is the calendar every deadline reads. */}
      <div className="mt-4">
        <OfficeCalendarCard />
      </div>

      <ConfirmDialog
        open={confirmingReset}
        title="Hand the policy back to the server?"
        confirmLabel="Hand it back"
        pending={pending}
        onConfirm={() => void handBack()}
        onCancel={() => setConfirmingReset(false)}
      >
        The server&rsquo;s own configuration takes over:{' '}
        {describeDeadline(policy.environment.slaDefaultDays).toLowerCase()}, and{' '}
        {policy.environment.allowStepSkip
          ? 'an approver may be passed over'
          : 'no approver may be passed over'}
        . This is different from clearing the deadline, which would store
        &ldquo;no deadline&rdquo; as the policy.
      </ConfirmDialog>
    </Page>
  )
}
