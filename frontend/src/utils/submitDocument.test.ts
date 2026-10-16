import { describe, expect, it } from 'vitest'
import {
  MAX_PDF_SIZE_BYTES,
  MAX_TITLE_LENGTH,
  collectSubmitDocumentIssues,
  describeFileType,
  formatFileSize,
  getReadinessChecks,
  toApprovalChainPayload,
  type ApprovalStepForm,
  type SubmitDocumentInput,
} from './submitDocument'
import { validateSupportingFile } from './submitDocument'

/**
 * The submit form's rules. They deliberately duplicate what the API enforces
 * so a preparer is told before they sign rather than after - which means the
 * two have to agree. Where a rule here has a twin in the backend's
 * `findApprovalChainIssues`, the wording is asserted, not just the refusal.
 */

const pdf = (size = 1024, type = 'application/pdf', name = 'lease.pdf') =>
  new File([new Uint8Array(Math.min(size, 1024))], name, { type }) as File &
    Record<string, unknown>

/** A File of a stated size without allocating it. */
const sizedPdf = (size: number) => {
  const file = pdf()
  Object.defineProperty(file, 'size', { value: size })
  return file
}

const step = (
  id: string,
  userId: string,
  approvalType: ApprovalStepForm['approvalType'],
): ApprovalStepForm => ({ id, userId, approvalType })

const form = (overrides: Partial<SubmitDocumentInput> = {}): SubmitDocumentInput => ({
  title: 'Warehouse lease extension',
  file: pdf(),
  steps: [
    step('s1', 'u1', 'REVIEWER'),
    step('s2', 'u2', 'FINAL_APPROVER'),
  ],
  ...overrides,
})

describe('formatFileSize', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '2 KB'],
    [1024 * 1024 - 1, '1024 KB'],
    [1024 * 1024, '1.0 MB'],
    [5.5 * 1024 * 1024, '5.5 MB'],
    [20 * 1024 * 1024, '20.0 MB'],
  ])('renders %i bytes as %s', (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected)
  })

  it('does not render every small attachment as 0.0 MB', () => {
    // Which is what dividing by a megabyte and fixing to one decimal did, and
    // the reason the unit scales.
    expect(formatFileSize(4096)).not.toContain('0.0')
    expect(formatFileSize(200)).not.toContain('0.0')
  })

  it('shows a dash rather than NaN for a size it cannot read', () => {
    expect(formatFileSize(Number.NaN)).toBe('—')
    expect(formatFileSize(-1)).toBe('—')
    expect(formatFileSize(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('describeFileType', () => {
  it.each([
    ['report.pdf', 'PDF'],
    ['scan.PNG', 'PNG image'],
    ['photo.jpeg', 'JPEG image'],
    ['photo.jpg', 'JPEG image'],
    ['notes.docx', 'Word document'],
    ['budget.xlsx', 'Excel workbook'],
    ['data.csv', 'CSV file'],
    ['readme.txt', 'Text file'],
  ])('describes %s as %s', (name, expected) => {
    expect(describeFileType(name)).toBe(expected)
  })

  it('falls back to a word rather than an empty label', () => {
    expect(describeFileType('archive.zip')).toBe('File')
    expect(describeFileType('noextension')).toBe('File')
    expect(describeFileType('')).toBe('File')
  })
})

describe('validateSupportingFile', () => {
  const attachment = (name: string, type: string, size = 1024) => {
    const file = new File([new Uint8Array(8)], name, { type })
    Object.defineProperty(file, 'size', { value: size })
    return file
  }

  it('accepts a file the API accepts', () => {
    expect(validateSupportingFile(attachment('survey.pdf', 'application/pdf'))).toBeNull()
  })

  it('accepts on the extension when the browser reports no type', () => {
    // Windows hands over an empty `type` for plenty of ordinary files, and
    // refusing those would be refusing a valid attachment.
    expect(validateSupportingFile(attachment('survey.docx', ''))).toBeNull()
  })

  it('accepts on the type when the name has no extension', () => {
    expect(validateSupportingFile(attachment('scan', 'image/png'))).toBeNull()
  })

  it('refuses a type the API would refuse, naming the file', () => {
    const message = validateSupportingFile(attachment('payload.exe', 'application/x-msdownload'))

    expect(message).toContain('payload.exe')
    expect(message).toContain('not an allowed supporting file type')
  })

  it('refuses one over the limit, naming the file', () => {
    const message = validateSupportingFile(
      attachment('huge.pdf', 'application/pdf', MAX_PDF_SIZE_BYTES + 1),
    )

    expect(message).toContain('huge.pdf')
    expect(message).toContain('20 MB')
  })

  it('accepts one exactly at the limit', () => {
    expect(
      validateSupportingFile(attachment('big.pdf', 'application/pdf', MAX_PDF_SIZE_BYTES)),
    ).toBeNull()
  })
})

describe('collectSubmitDocumentIssues: the document', () => {
  it('finds nothing wrong with a complete form', () => {
    const issues = collectSubmitDocumentIssues(form())

    expect(issues).toEqual({
      title: null,
      file: null,
      chain: null,
      steps: {},
      firstMessage: null,
    })
  })

  it('requires a title that is not just whitespace', () => {
    expect(collectSubmitDocumentIssues(form({ title: '   ' })).title).toBe(
      'Document title is required.',
    )
  })

  it('refuses a title the API would refuse, before it becomes a 400', () => {
    const issues = collectSubmitDocumentIssues(
      form({ title: 'x'.repeat(MAX_TITLE_LENGTH + 1) }),
    )

    expect(issues.title).toBe(
      `Document title cannot exceed ${MAX_TITLE_LENGTH} characters.`,
    )
  })

  it('accepts a title of exactly the limit', () => {
    expect(
      collectSubmitDocumentIssues(form({ title: 'x'.repeat(MAX_TITLE_LENGTH) })).title,
    ).toBeNull()
  })

  it('requires a file, and requires it to be a pdf', () => {
    expect(collectSubmitDocumentIssues(form({ file: null })).file).toBe(
      'A PDF document is required.',
    )
    expect(
      collectSubmitDocumentIssues(form({ file: pdf(10, 'image/png', 'scan.png') })).file,
    ).toBe('Only PDF files are allowed.')
  })

  it('refuses a pdf over twenty megabytes', () => {
    expect(
      collectSubmitDocumentIssues(form({ file: sizedPdf(MAX_PDF_SIZE_BYTES + 1) })).file,
    ).toBe('File size must not exceed 20 MB.')
    expect(
      collectSubmitDocumentIssues(form({ file: sizedPdf(MAX_PDF_SIZE_BYTES) })).file,
    ).toBeNull()
  })
})

describe('collectSubmitDocumentIssues: the chain', () => {
  it('requires at least one step', () => {
    expect(collectSubmitDocumentIssues(form({ steps: [] })).chain).toBe(
      'At least one approval step is required.',
    )
  })

  it('points at the step that has nobody on it', () => {
    // The whole reason this returns per-field issues: "something is wrong"
    // at the bottom of a five-step form is not an instruction.
    const issues = collectSubmitDocumentIssues(
      form({
        steps: [step('s1', '', 'REVIEWER'), step('s2', 'u2', 'FINAL_APPROVER')],
      }),
    )

    expect(issues.steps.s1).toBe('Select the person who handles this step.')
    expect(issues.steps.s2).toBeUndefined()
    expect(issues.firstMessage).toBe('Each approval step must have an assigned user.')
  })

  it('names which earlier step a duplicate belongs to', () => {
    const issues = collectSubmitDocumentIssues(
      form({
        steps: [
          step('s1', 'u1', 'REVIEWER'),
          step('s2', 'u1', 'APPROVER'),
          step('s3', 'u2', 'FINAL_APPROVER'),
        ],
      }),
    )

    expect(issues.steps.s2).toBe('Already assigned to step 1.')
    expect(issues.chain).toBe('Duplicate users are not allowed in the approval chain.')
  })

  it('requires exactly one final approver', () => {
    expect(
      collectSubmitDocumentIssues(
        form({ steps: [step('s1', 'u1', 'REVIEWER'), step('s2', 'u2', 'APPROVER')] }),
      ).chain,
    ).toBe('Exactly one Final Approver is required.')

    expect(
      collectSubmitDocumentIssues(
        form({
          steps: [
            step('s1', 'u1', 'FINAL_APPROVER'),
            step('s2', 'u2', 'FINAL_APPROVER'),
          ],
        }),
      ).chain,
    ).toBe('Exactly one Final Approver is required.')
  })

  it('requires the final approver to be last', () => {
    // A chain whose final step is not the closer can never complete: the run
    // ends on the step's type, not its position.
    expect(
      collectSubmitDocumentIssues(
        form({
          steps: [
            step('s1', 'u1', 'FINAL_APPROVER'),
            step('s2', 'u2', 'REVIEWER'),
          ],
        }),
      ).chain,
    ).toBe('Final Approver must be the last step.')
  })

  it('reports the first problem in the order the form reads', () => {
    // firstMessage is what the single-string view shows, and it must be the
    // same problem the field-level view highlights first - top to bottom.
    const issues = collectSubmitDocumentIssues(
      form({ title: '', file: null, steps: [] }),
    )

    expect(issues.firstMessage).toBe('Document title is required.')
    expect(issues.title).toBe('Document title is required.')
  })
})

describe('collectSubmitDocumentIssues: routing through a template', () => {
  const templated = (overrides: Partial<SubmitDocumentInput> = {}) =>
    form({ routingMode: 'template', templateId: 't1', ...overrides })

  it('does not judge the step list at all', () => {
    // The chain comes from the template; a stale step list left in state
    // must not block a submission that does not use it.
    const issues = collectSubmitDocumentIssues(
      templated({
        steps: [step('s1', '', 'REVIEWER')],
        templateSteps: [{ approvalType: 'FINAL_APPROVER' }],
      }),
    )

    expect(issues.chain).toBeNull()
    expect(issues.steps).toEqual({})
  })

  it('requires a template to be chosen', () => {
    expect(collectSubmitDocumentIssues(templated({ templateId: null })).chain).toBe(
      'Choose a workflow template.',
    )
  })

  it("shows the server's reason when it cannot route this memo through the template", () => {
    // The route comes from the compiler submission runs, so its refusal is
    // the one the preparer would meet on submitting - said before they sign.
    expect(
      collectSubmitDocumentIssues(
        templated({ templateSteps: null, templateRouteError: 'An approval step has nobody assigned to it.' }),
      ).chain,
    ).toBe('An approval step has nobody assigned to it.')
  })

  it('refuses a template that routes this document nowhere', () => {
    expect(collectSubmitDocumentIssues(templated({ templateSteps: [] })).chain).toBe(
      'This template produces no approval steps for this document.',
    )
  })

  it('refuses a template that could never complete', () => {
    // The compiled chain is per-document, because a decision node can route
    // one title down a branch that has no final approver on it.
    const issues = collectSubmitDocumentIssues(
      templated({ templateSteps: [{ approvalType: 'REVIEWER' }] }),
    )

    expect(issues.chain).toContain('could never complete')
  })

  it('refuses a template whose final approver is not last', () => {
    const issues = collectSubmitDocumentIssues(
      templated({
        templateSteps: [
          { approvalType: 'FINAL_APPROVER' },
          { approvalType: 'REVIEWER' },
        ],
      }),
    )

    expect(issues.chain).toContain('could never complete')
  })

  it('accepts a template that ends properly', () => {
    const issues = collectSubmitDocumentIssues(
      templated({
        templateSteps: [
          { approvalType: 'REVIEWER' },
          { approvalType: 'FINAL_APPROVER' },
        ],
      }),
    )

    expect(issues.chain).toBeNull()
    expect(issues.firstMessage).toBeNull()
  })

  it('still checks the title and the file', () => {
    const issues = collectSubmitDocumentIssues(
      templated({ title: '', templateSteps: [{ approvalType: 'FINAL_APPROVER' }] }),
    )

    expect(issues.title).toBe('Document title is required.')
  })
})

describe('getReadinessChecks', () => {
  const done = (input: SubmitDocumentInput) =>
    getReadinessChecks(input).filter(check => check.done).length

  it('gives an untouched form no credit at all', () => {
    // Two of the five rules are vacuously true of an empty chain, which
    // opened the form on "2 of 5" before the preparer had done anything.
    const empty = form({ title: '', file: null, steps: [] })

    expect(done(empty)).toBe(0)
  })

  it('turns each rule green as it is satisfied', () => {
    expect(done(form({ file: null, steps: [] }))).toBe(1)
    expect(done(form({ steps: [] }))).toBe(2)
    expect(done(form())).toBe(5)
  })

  it('withholds the uniqueness tick until somebody is assigned', () => {
    const unassigned = form({
      steps: [step('s1', '', 'REVIEWER'), step('s2', '', 'FINAL_APPROVER')],
    })
    const checks = getReadinessChecks(unassigned)

    expect(checks.find(check => check.id === 'unique')?.done).toBe(false)
    expect(checks.find(check => check.id === 'final')?.done).toBe(false)
  })

  it('reports five rules for a custom chain and five for a template', () => {
    expect(getReadinessChecks(form())).toHaveLength(5)
    expect(
      getReadinessChecks(form({ routingMode: 'template', templateId: 't1' })),
    ).toHaveLength(5)
  })

  it('tracks the template rules separately', () => {
    const checks = getReadinessChecks(
      form({
        routingMode: 'template',
        templateId: 't1',
        templateSteps: [{ approvalType: 'FINAL_APPROVER' }],
      }),
    )

    expect(checks.map(check => [check.id, check.done])).toEqual([
      ['title', true],
      ['file', true],
      ['template', true],
      ['template-routes', true],
      ['template-completes', true],
    ])
  })

  it('withholds the completion tick from a template that cannot finish', () => {
    const checks = getReadinessChecks(
      form({
        routingMode: 'template',
        templateId: 't1',
        templateSteps: [{ approvalType: 'REVIEWER' }],
      }),
    )

    expect(checks.find(check => check.id === 'template-routes')?.done).toBe(true)
    expect(checks.find(check => check.id === 'template-completes')?.done).toBe(false)
  })

  it('agrees with the validator about whether the form can be submitted', () => {
    // Five green ticks and a blocking error at the same time is the kind of
    // contradiction that makes people stop reading either one.
    for (const input of [
      form(),
      form({ title: '' }),
      form({ steps: [] }),
      form({ steps: [step('s1', 'u1', 'REVIEWER')] }),
      form({ routingMode: 'template', templateId: null }),
      /* With a profile loaded, which is every real submission - and with the
         preparer on their own chain, which is the case that used to show five
         green ticks beside a submission the server would refuse. */
      form({ preparerId: 'me' }),
      form({
        preparerId: 'me',
        steps: [step('s1', 'me', 'REVIEWER'), step('s2', 'u2', 'FINAL_APPROVER')],
      }),
      form({
        preparerId: 'me',
        routingMode: 'template',
        templateId: 't1',
        templateSteps: [
          { approvalType: 'REVIEWER', assignedUserId: 'u1' },
          { approvalType: 'FINAL_APPROVER', assignedUserId: 'me' },
        ],
      }),
    ]) {
      const allGreen = getReadinessChecks(input).every(check => check.done)
      const clean = collectSubmitDocumentIssues(input).firstMessage === null

      expect(allGreen, JSON.stringify({ allGreen, clean })).toBe(clean)
    }
  })
})

describe('toApprovalChainPayload', () => {
  it('sends only what the API asks for', () => {
    // The form's own `id` is a React key; sending it would have the server
    // rejecting a field it does not know.
    expect(
      toApprovalChainPayload([
        step('s1', 'u1', 'REVIEWER'),
        step('s2', 'u2', 'FINAL_APPROVER'),
      ]),
    ).toEqual([
      { userId: 'u1', approvalType: 'REVIEWER' },
      { userId: 'u2', approvalType: 'FINAL_APPROVER' },
    ])
  })

  it('keeps the order the preparer arranged', () => {
    const payload = toApprovalChainPayload([
      step('s3', 'u3', 'REVIEWER'),
      step('s1', 'u1', 'APPROVER'),
      step('s2', 'u2', 'FINAL_APPROVER'),
    ])

    expect(payload.map(entry => entry.userId)).toEqual(['u3', 'u1', 'u2'])
  })

  it('produces an empty payload from an empty chain', () => {
    expect(toApprovalChainPayload([])).toEqual([])
  })
})

/**
 * A chain that routes the document back to whoever is submitting it.
 *
 * The server refuses this - "The document preparer cannot be an approver on
 * their own document" - and the form had no equivalent rule. Every check it
 * did make compares the steps with each other, and the preparer is not one of
 * the steps, so none of them could ever see it: the checklist read 5 of 5,
 * Sign & submit was enabled, and the refusal arrived after the signature had
 * been drawn, with the routing two steps behind.
 *
 * "Reuse that chain" is the likeliest way in. It replays a previous routing,
 * which may well name whoever is submitting this time.
 */
describe('the preparer on their own chain', () => {
  const ME = 'me'
  const mine = (overrides: Partial<SubmitDocumentInput> = {}) =>
    form({ preparerId: ME, ...overrides })

  it('refuses a chain that routes the document back to me', () => {
    const issues = collectSubmitDocumentIssues(
      mine({ steps: [step('s1', ME, 'REVIEWER'), step('s2', 'u2', 'FINAL_APPROVER')] }),
    )

    expect(issues.chain).toBe('You cannot approve your own document.')
    expect(issues.firstMessage).toBeTruthy()
  })

  it('says which step it is, not only that there is one', () => {
    // The chain message says what is wrong; the step says where to fix it.
    const issues = collectSubmitDocumentIssues(
      mine({
        steps: [
          step('s1', 'u1', 'REVIEWER'),
          step('s2', ME, 'APPROVER'),
          step('s3', 'u3', 'FINAL_APPROVER'),
        ],
      }),
    )

    expect(issues.steps.s2).toBe('You cannot approve your own document.')
    expect(issues.steps.s1).toBeUndefined()
    expect(issues.steps.s3).toBeUndefined()
  })

  it('marks every step that names me', () => {
    const issues = collectSubmitDocumentIssues(
      mine({
        steps: [
          step('s1', ME, 'REVIEWER'),
          step('s2', ME, 'FINAL_APPROVER'),
        ],
      }),
    )

    expect(issues.steps.s1).toBeTruthy()
    expect(issues.steps.s2).toBeTruthy()
  })

  it('leaves a step that is already wrong for another reason saying so', () => {
    // A duplicate already names the step it duplicates, which is the more
    // specific complaint. Overwriting it would lose that.
    const issues = collectSubmitDocumentIssues(
      mine({
        steps: [
          step('s1', 'u1', 'REVIEWER'),
          step('s2', 'u1', 'APPROVER'),
          step('s3', ME, 'FINAL_APPROVER'),
        ],
      }),
    )

    expect(issues.steps.s2).toContain('Already assigned to step 1')
    expect(issues.steps.s3).toBe('You cannot approve your own document.')
  })

  it('allows a chain that does not name me', () => {
    expect(collectSubmitDocumentIssues(mine()).firstMessage).toBeNull()
  })

  it('says nothing when there is no profile to judge against', () => {
    // Without knowing who is submitting, the rule cannot be evaluated - and a
    // guess here would refuse a submission the server would have accepted.
    const issues = collectSubmitDocumentIssues(
      form({ steps: [step('s1', ME, 'REVIEWER'), step('s2', 'u2', 'FINAL_APPROVER')] }),
    )

    expect(issues.firstMessage).toBeNull()
  })

  it('refuses a template that routes the document back to me', () => {
    // A template is written once and used for years by whoever it suits,
    // including the people named in it.
    const issues = collectSubmitDocumentIssues(
      mine({
        routingMode: 'template',
        templateId: 't1',
        templateSteps: [
          { approvalType: 'REVIEWER', assignedUserId: 'u1' },
          { approvalType: 'FINAL_APPROVER', assignedUserId: ME },
        ],
      }),
    )

    expect(issues.chain).toContain('routes the document to you')
  })

  it('allows a template that does not name me', () => {
    const issues = collectSubmitDocumentIssues(
      mine({
        routingMode: 'template',
        templateId: 't1',
        templateSteps: [
          { approvalType: 'REVIEWER', assignedUserId: 'u1' },
          { approvalType: 'FINAL_APPROVER', assignedUserId: 'u2' },
        ],
      }),
    )

    expect(issues.firstMessage).toBeNull()
  })
})

describe('the checklist about my own chain', () => {
  const ME = 'me'
  const labels = (input: SubmitDocumentInput) =>
    getReadinessChecks(input).map(check => check.label)
  const check = (input: SubmitDocumentInput, id: string) =>
    getReadinessChecks(input).find(entry => entry.id === id)

  it('shows the rule, unticked, while I am on my own chain', () => {
    const input = form({
      preparerId: ME,
      steps: [step('s1', ME, 'REVIEWER'), step('s2', 'u2', 'FINAL_APPROVER')],
    })

    expect(labels(input)).toContain('You are not one of the approvers')
    expect(check(input, 'not-preparer')?.done).toBe(false)
  })

  it('ticks it once I am off the chain', () => {
    expect(check(form({ preparerId: ME }), 'not-preparer')?.done).toBe(true)
  })

  it('leaves it pending on an untouched chain, like its neighbours', () => {
    // Nothing to judge yet, and a readiness indicator should not open with
    // credit the preparer has not earned.
    expect(
      check(form({ preparerId: ME, steps: [] }), 'not-preparer')?.done,
    ).toBe(false)
  })

  it('does not list a rule it cannot judge', () => {
    // No profile loaded: showing it permanently unticked would put the
    // checklist out of step with what the form actually refuses.
    expect(labels(form())).not.toContain('You are not one of the approvers')
  })
})

describe('the checklist about a template that names me', () => {
  const ME = 'me'
  const viaTemplate = (assignees: string[]) =>
    form({
      preparerId: ME,
      routingMode: 'template',
      templateId: 't1',
      templateSteps: assignees.map((assignedUserId, index) => ({
        approvalType: index === assignees.length - 1 ? 'FINAL_APPROVER' : 'REVIEWER',
        assignedUserId,
      })),
    })

  const check = (input: SubmitDocumentInput) =>
    getReadinessChecks(input).find(entry => entry.id === 'not-preparer')

  it('shows the rule unticked when the template routes to me', () => {
    expect(check(viaTemplate(['u1', ME]))?.done).toBe(false)
  })

  it('ticks it for a template that routes elsewhere', () => {
    expect(check(viaTemplate(['u1', 'u2']))?.done).toBe(true)
  })

  it('leaves it pending before a template has been chosen', () => {
    expect(
      check(form({ preparerId: ME, routingMode: 'template', templateId: null }))?.done,
    ).toBe(false)
  })
})

/**
 * A memo written in the portal is validated by its own rules.
 *
 * The two modes are alternatives, so the important half of this is negative:
 * the upload rules must not fire on a typed memo, and the typed rules must not
 * fire on an upload. A form that demanded a PDF for a memo it was about to
 * send without one would be asking for something the API then rejects.
 */
describe('a memo written in the portal', () => {
  const written = (overrides: Partial<SubmitDocumentInput> = {}): SubmitDocumentInput =>
    form({
      authoring: 'typed',
      file: null,
      memoType: 'APPROVAL_REQUEST',
      memoTo: 'Sir BMD',
      memoFrom: 'Human Resource Department',
      memoDate: '2026-08-06',
      body: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'It is submitted.' }] }],
      },
      ...overrides,
    })

  it('does not ask for a PDF', () => {
    expect(collectSubmitDocumentIssues(written()).file).toBeNull()
  })

  it('asks what kind of memo it is', () => {
    expect(collectSubmitDocumentIssues(written({ memoType: null })).file).toBe(
      'Choose what kind of memo this is.',
    )
  })

  it('asks who it is to and who it is from', () => {
    expect(collectSubmitDocumentIssues(written({ memoTo: '  ' })).file).toContain(
      'addressed to',
    )
    expect(collectSubmitDocumentIssues(written({ memoFrom: '' })).file).toContain(
      'department',
    )
  })

  it('refuses a memo with nothing written in it', () => {
    const empty = written({ body: { type: 'doc', content: [{ type: 'paragraph' }] } })
    expect(collectSubmitDocumentIssues(empty).file).toBe(
      'Write the memo before submitting it.',
    )
  })

  it('refuses one longer than the server will take, and says how long it is', () => {
    const huge = written({
      body: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(120_001) }] },
        ],
      },
    })

    const message = collectSubmitDocumentIssues(huge).file
    expect(message).toContain('120,001')
    expect(message).toContain('supporting document')
  })

  it('still enforces every rule about the chain', () => {
    // The routing rules are about who signs it, not about where the document
    // came from, so switching how the memo is written changes none of them.
    const issues = collectSubmitDocumentIssues(
      written({ steps: [step('s1', 'u1', 'REVIEWER')] }),
    )
    expect(issues.chain).toBe('Exactly one Final Approver is required.')
  })

  it('still enforces the title', () => {
    expect(collectSubmitDocumentIssues(written({ title: '' })).title).toBe(
      'Document title is required.',
    )
  })
})

describe('the checklist for a memo written in the portal', () => {
  const written = (overrides: Partial<SubmitDocumentInput> = {}): SubmitDocumentInput =>
    form({
      authoring: 'typed',
      file: null,
      memoType: 'APPROVAL_REQUEST',
      memoTo: 'Sir BMD',
      memoFrom: 'HR',
      memoDate: '2026-08-06',
      body: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Written.' }] }],
      },
      ...overrides,
    })

  const check = (input: SubmitDocumentInput, id: string) =>
    getReadinessChecks(input).find(entry => entry.id === id)

  it('asks about the memo instead of about an attachment', () => {
    const entry = check(written(), 'file')
    expect(entry?.label).toBe('Memo written, addressed and typed')
    expect(entry?.done).toBe(true)
  })

  it('stays unticked until the memo is complete', () => {
    expect(check(written({ memoTo: '' }), 'file')?.done).toBe(false)
    expect(
      check(written({ body: { type: 'doc', content: [] } }), 'file')?.done,
    ).toBe(false)
  })

  it('still asks for the PDF when one is being attached', () => {
    expect(check(form(), 'file')?.label).toBe('PDF attached (max 20 MB)')
  })

  it('keeps the same number of checks either way, so the count means the same', () => {
    expect(getReadinessChecks(written())).toHaveLength(getReadinessChecks(form()).length)
  })
})

describe('an outline is not a memo', () => {
  /*
   * Choosing a memo type drops that type's headings into the editor. They are
   * text, so a plain length check ticked "Memo written" the moment a type was
   * picked - for a memo containing nothing but the prompts this system had
   * put there itself, which it would then have let somebody submit.
   */
  const outlineOnly: SubmitDocumentInput = {
    title: 'Approval for Revision of Fuel Allowance',
    file: null,
    authoring: 'typed',
    memoType: 'APPROVAL_REQUEST',
    memoTo: 'Sir BMD',
    memoFrom: 'HR',
    memoDate: '2026-08-06',
    body: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'BACKGROUND:' }] },
        { type: 'paragraph' },
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Recommendation' }] },
        { type: 'paragraph' },
      ],
    },
    steps: [step('s1', 'u1', 'REVIEWER'), step('s2', 'u2', 'FINAL_APPROVER')],
  }

  it('refuses a memo that is only the headings we supplied', () => {
    expect(collectSubmitDocumentIssues(outlineOnly).file).toBe(
      'Write the memo before submitting it.',
    )
  })

  it('leaves the checklist unticked for one', () => {
    const entry = getReadinessChecks(outlineOnly).find(check => check.id === 'file')
    expect(entry?.done).toBe(false)
  })

  it('accepts it as soon as there is a sentence under a heading', () => {
    const written: SubmitDocumentInput = {
      ...outlineOnly,
      body: {
        type: 'doc',
        content: [
          ...outlineOnly.body!.content,
          { type: 'paragraph', content: [{ type: 'text', text: 'It is submitted.' }] },
        ],
      },
    }

    expect(collectSubmitDocumentIssues(written).file).toBeNull()
  })
})
