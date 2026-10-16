import type { DocumentStatus } from '../types/document';

/**
 * Labels are short because the redesigned tables are dense — "Review", not
 * "Pending Review". The long form is still available through `verbose` for
 * the document detail header, where there is room and the extra word
 * removes any doubt about which stage the document is at.
 *
 * The dot is `aria-hidden` and uses the `-mark` hue; the label beside it
 * carries the meaning, so nothing here is conveyed by colour alone.
 */
const STATUS_CONFIG: Record<
  DocumentStatus,
  { label: string; verbose: string; className: string; dotClass: string }
> = {
  draft: {
    label: 'Draft',
    verbose: 'Draft',
    className: 'bg-sunken text-content-muted border border-neutral-line',
    dotClass: 'bg-neutral-mark',
  },
  pending_review: {
    label: 'Review',
    verbose: 'Pending Review',
    className: 'bg-info-soft text-info-ink border border-info-line',
    dotClass: 'bg-info-mark',
  },
  pending_approval: {
    label: 'Approval',
    verbose: 'Pending Approval',
    className: 'bg-warning-soft text-warning-ink border border-warning-line',
    dotClass: 'bg-warning-mark',
  },
  revision_requested: {
    label: 'Revision',
    verbose: 'Revision Requested',
    className: 'bg-revision-soft text-revision-ink border border-revision-line',
    dotClass: 'bg-revision-mark',
  },
  approved: {
    label: 'Approved',
    verbose: 'Approved',
    className: 'bg-accent-soft text-accent-ink border border-accent-line',
    dotClass: 'bg-accent-mark',
  },
  rejected: {
    label: 'Rejected',
    verbose: 'Rejected',
    className: 'bg-danger-soft text-danger-ink border border-danger-line',
    dotClass: 'bg-danger-mark',
  },
  deleted: {
    label: 'Withdrawn',
    verbose: 'Withdrawn',
    className: 'bg-sunken text-content-muted border border-neutral-line',
    dotClass: 'bg-neutral-mark',
  },
};

export default function StatusBadge({
  status,
  size = 'sm',
  verbose = false,
  stage,
}: {
  status: DocumentStatus;
  size?: 'xs' | 'sm';
  /** Use the full sentence label, for headers rather than table cells. */
  verbose?: boolean;
  /**
   * The workflow stage in the requirement's own words - "Pending Approver 2
   * of 3", "Completed" - which says where on the chain the memo is and not
   * merely what kind of state it is in. Overrides the label; the colour and
   * the dot still come from `status`, because the stage is a longer way of
   * saying the same thing and the two must never disagree.
   *
   * Optional: a dense table has no room for it, and `workflowStage` needs the
   * chain, which a table row does not carry.
   */
  stage?: string;
}) {
  /*
   * A status this build has never heard of still has to read as something.
   *
   * A newer API adding one - or an older client meeting one - used to reach
   * `config.className` on `undefined` and take the whole screen down. Falling
   * back to the raw value is not pretty, but a badge that says "archived" is
   * a badge somebody can act on, and a blank page is not.
   */
  const config = STATUS_CONFIG[status] ?? {
    label: String(status).replace(/_/g, ' '),
    verbose: String(status).replace(/_/g, ' '),
    className: 'bg-neutral-soft text-content-muted',
    dotClass: 'bg-neutral-mark',
  };
  const sizeClass =
    size === 'xs' ? 'text-eyebrow px-1.5 py-0.5' : 'text-2xs px-2 py-0.5';

  return (
    <span
      className={`inline-flex items-center rounded-pill font-medium ${sizeClass} ${config.className}`}
    >
      <span
        aria-hidden="true"
        className={`mr-1.5 h-1.25 w-1.25 flex-shrink-0 rounded-pill ${config.dotClass}`}
      />
      {stage ?? (verbose ? config.verbose : config.label)}
    </span>
  );
}
