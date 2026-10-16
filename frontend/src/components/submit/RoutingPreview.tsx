import { Check, GitBranch, PenLine } from 'lucide-react'
import type { ApiApprovalType } from '../../types/document'
import type { AssignableUser } from '../../types/submitDocument'
import { APPROVAL_TYPE_OPTIONS } from '../../utils/submitDocument'
import { formatFullName } from '../../utils/user'

export interface PreviewStep {
  key: string
  approvalType: ApiApprovalType
  user: AssignableUser | null
}

/**
 * Where this document goes once it is signed. Driven by whichever routing mode
 * is active, so a template shows the same answer a hand-built chain does —
 * including for a template whose branches depend on this document's title.
 */
export default function RoutingPreview({
  preparer,
  steps,
  branching,
  emptyLabel,
}: {
  preparer: { firstName: string; lastName: string } | null
  steps: PreviewStep[]
  /** The template routes conditionally, so the answer can change as the title does. */
  branching?: boolean
  emptyLabel?: string
}) {
  /**
   * Whether this route can actually end in an approval.
   *
   * A chain has to finish on a final approver; anything else stalls forever
   * and the submit button refuses it. An empty chain cannot finish either.
   */
  const closesTheWorkflow =
    steps.length > 0 &&
    steps[steps.length - 1]?.approvalType === 'FINAL_APPROVER'

  return (
    <section className="card overflow-hidden">
      <div className="border-b border-line-soft px-4 py-3.5">
        <h2 className="text-ui font-semibold text-content">Routing preview</h2>
        <p className="mt-0.5 text-2xs text-content-subtle">
          Where this document goes once you sign
        </p>
      </div>

      <ol className="p-4">
        <li className="flex gap-3 pb-3">
          <div className="flex flex-col items-center">
            <span
              aria-hidden="true"
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-pill bg-accent text-on-accent"
            >
              <PenLine size={12} />
            </span>
            <span aria-hidden="true" className="mt-1 w-px flex-1 bg-line" />
          </div>
          <div className="min-w-0 pb-1">
            <p className="text-meta font-semibold text-content">
              {preparer
                ? formatFullName(preparer.firstName, preparer.lastName)
                : 'You'}
            </p>
            <p className="text-2xs text-content-subtle">
              Preparer · signs before submitting
            </p>
          </div>
        </li>

        {/* `emptyLabel` used to be the only thing standing between an
            empty chain and a route reading "Ayesha Khan → Approved" - a
            complete-looking path, ending in approval, with no approver on
            it. The submit screen passes the label in template mode only, so
            a hand-built chain got exactly that. The wording is now a default
            rather than a requirement. */}
        {steps.length === 0 && (
          <li className="flex gap-3 pb-3">
            <div className="flex flex-col items-center">
              <span
                aria-hidden="true"
                className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-pill border border-dashed border-line-strong bg-sunken text-2xs text-content-subtle"
              >
                ?
              </span>
              <span aria-hidden="true" className="mt-1 w-px flex-1 bg-line" />
            </div>
            <div className="min-w-0 pb-1">
              <p className="text-meta font-semibold text-content-subtle">
                {emptyLabel ?? 'No approvers yet — add at least one below.'}
              </p>
            </div>
          </li>
        )}

        {steps.map((step, index) => {
          const option = APPROVAL_TYPE_OPTIONS.find(
            item => item.value === step.approvalType,
          )
          return (
            <li key={step.key} className="flex gap-3 pb-3">
              <div className="flex flex-col items-center">
                <span
                  aria-hidden="true"
                  className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-pill border text-2xs font-semibold ${
                    step.user
                      ? 'border-line-strong bg-surface text-content'
                      : 'border-dashed border-line-strong bg-sunken text-content-subtle'
                  }`}
                >
                  {index + 1}
                </span>
                <span aria-hidden="true" className="mt-1 w-px flex-1 bg-line" />
              </div>
              <div className="min-w-0 pb-1">
                <p
                  className={`truncate text-meta font-semibold ${
                    step.user ? 'text-content' : 'text-content-subtle'
                  }`}
                >
                  {step.user
                    ? formatFullName(step.user.firstName, step.user.lastName)
                    : 'Not assigned yet'}
                </p>
                <p className="truncate text-2xs text-content-subtle">
                  {option?.label}
                  {step.user?.department?.name
                    ? ` · ${step.user.department.name}`
                    : ''}
                </p>
              </div>
            </li>
          )
        })}

        {/* Only when the chain can actually get here.
            The terminus used to be drawn unconditionally, so a chain ending
            in a reviewer - which can never complete, and which the submit
            button refuses - still showed the document finishing as Approved.
            A preview that promises an outcome the route cannot reach is
            worse than no preview. */}
        {closesTheWorkflow ? (
          <li className="flex gap-3">
            <span
              aria-hidden="true"
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-pill bg-success-soft text-success-ink"
            >
              <Check size={12} strokeWidth={3} />
            </span>
            <div className="min-w-0">
              <p className="text-meta font-semibold text-content">Approved</p>
              <p className="text-2xs text-content-subtle">
                Final approver closes the approval chain
              </p>
            </div>
          </li>
        ) : (
          <li className="flex gap-3">
            <span
              aria-hidden="true"
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-pill border border-dashed border-line-strong bg-sunken text-2xs text-content-subtle"
            >
              ?
            </span>
            <div className="min-w-0">
              <p className="text-meta font-semibold text-content-subtle">
                Does not finish
              </p>
              <p className="text-2xs text-content-subtle">
                The last step has to be a final approver.
              </p>
            </div>
          </li>
        )}
      </ol>

      {branching && (
        <p className="flex items-start gap-2 border-t border-line-soft px-4 py-3 text-2xs text-content-subtle">
          <GitBranch size={12} aria-hidden="true" className="mt-px flex-shrink-0" />
          This template routes conditionally. Changing the title or description can
          change who it goes to.
        </p>
      )}
    </section>
  )
}
