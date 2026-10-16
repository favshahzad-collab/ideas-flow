/**
 * Extracted from DocDetailPage, which had grown to 1,725 lines — seven
 * components and the screen itself in one file.
 *
 * The `DocumentDetails` panel that used to sit beside this one is gone: the
 * redesign moved every field it listed into the page header and the meta bar,
 * so it was rendering a second copy of what was already on screen.
 *
 * The step counts went for the same reason. "Total Steps" and "Completed
 * Steps" sat directly under the Approval chain card, which already heads
 * itself with the same two numbers as 3/5 - so the page answered "how far
 * along is this" twice, one card apart. What is left is how the chain is made
 * up, which nothing else on the page says.
 */

export function QuickInfo({
  reviewers,
  approvers,
}: {
  reviewers: number
  approvers: number
}) {
  const rows = [
    { label: 'Reviewers', value: reviewers },
    { label: 'Approvers', value: approvers },
  ]

    return (
    <section className="card p-4 sm:p-5">
      <h2 className="text-section font-semibold text-content mb-4">
          Quick Info
        </h2>
      {/*
        * A description list, not a row of spans. The pairing here is drawn by
        * `justify-between` and nothing else, which is fine to look at and
        * silent to everything that is not looking: both numbers are usually
        * single digits, and often the same digit, so "2, 2" with the labels
        * read separately says nothing at all. <dt>/<dd> inside a shared row
        * is what ties each number to its label, and it costs no layout.
        */}
      <dl className="space-y-3">
        {rows.map(row => (
          <div key={row.label} className="flex items-center justify-between">
            <dt className="text-meta text-content-muted">{row.label}</dt>
            <dd className="text-ui font-medium text-content-muted">{row.value}</dd>
          </div>
        ))}
      </dl>
      </section>
  )
}
