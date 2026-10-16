import { useEffect, useState } from 'react'
import { FileText, RotateCcw, Ruler } from 'lucide-react'

import { Page, PageHeader } from '../components/ui/Page'
import { Card, CardHeader } from '../components/ui/Card'
import { LoadingAnnouncer, Skeleton } from '../components/ui/Skeleton'
import Button from '../components/ui/Button'
import {
  fetchPageSetup,
  savePageSetup,
  type PageSetup,
  type PageSetupResponse,
  type PaperName,
} from '../services/AdminApi'

/**
 * The paper a generated memo is drawn on.
 *
 * Until this screen existed the page was four constants: A4 with a 0.6in side
 * margin, and no way to change either. An organisation whose memo standard is
 * Letter, or whose paper form leaves a wider gutter down one side for a
 * binder, could not produce its own document at all.
 *
 * Two things the screen has to be honest about, both stated on it rather than
 * left for somebody to discover:
 *
 *  - It changes the NEXT memo drawn, and nothing already filed. Each version
 *    records the page it was drawn on and the stored artefact is never
 *    re-rendered, because the audit trail cites its checksum.
 *  - Margins are typed in millimetres, because nobody thinks in points. The
 *    conversion happens here; what the server stores and the renderer draws
 *    in is points.
 */

const PT_PER_MM = 72 / 25.4

const toMm = (points: number) => Math.round((points / PT_PER_MM) * 10) / 10
const toPoints = (mm: number) => mm * PT_PER_MM

type Edge = 'marginLeft' | 'marginRight' | 'marginTop' | 'marginBottom'

const EDGES: { key: Edge; label: string }[] = [
  { key: 'marginLeft', label: 'Left' },
  { key: 'marginRight', label: 'Right' },
  { key: 'marginTop', label: 'Top' },
  { key: 'marginBottom', label: 'Bottom' },
]

/** Held as strings so a field can be emptied while somebody retypes it. */
type Form = Record<Edge, string> & { paper: PaperName }

const toForm = (setup: PageSetup): Form => ({
  paper: setup.paper,
  marginLeft: String(toMm(setup.marginLeft)),
  marginRight: String(toMm(setup.marginRight)),
  marginTop: String(toMm(setup.marginTop)),
  marginBottom: String(toMm(setup.marginBottom)),
})

const message = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback

export default function PageSetupPage() {
  const [data, setData] = useState<PageSetupResponse | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false

    fetchPageSetup()
      .then((next) => {
        if (cancelled) return
        setData(next)
        setForm(toForm(next.setup))
        setLoadError(null)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // Cleared on success rather than before the request, so a failed
        // retry does not blank the message and put it straight back.
        setLoadError(message(error, 'Could not read the page setup.'))
      })

    return () => {
      cancelled = true
    }
  }, [attempt])

  const sheet = data?.papers.find((paper) => paper.name === form?.paper)

  /*
   * Refused here as well as on the server.
   *
   * The server is the authority and says which edge to change; checking here
   * too is so the person sees it as they type rather than after a round trip,
   * and so Save is not offered for something that cannot be saved.
   */
  const points = form
    ? (Object.fromEntries(
        EDGES.map(({ key }) => [key, toPoints(Number(form[key]))]),
      ) as Record<Edge, number>)
    : null

  const anyBlank = form
    ? EDGES.some(({ key }) => form[key].trim() === '' || !Number.isFinite(Number(form[key])))
    : true

  const outOfBounds =
    points && data
      ? EDGES.some(
          ({ key }) =>
            points[key] < data.bounds.minMargin ||
            points[key] > data.bounds.maxMargin,
        )
      : false

  const columnWidth =
    sheet && points ? sheet.width - points.marginLeft - points.marginRight : 0
  const columnHeight =
    sheet && points ? sheet.height - points.marginTop - points.marginBottom : 0

  // The server's own floors. Repeated as a number here only to say which way
  // to move; the message a save is refused with is still the server's.
  const tooNarrow = Boolean(sheet && points && columnWidth < 200)
  const tooShort = Boolean(sheet && points && columnHeight < 200)

  const invalid = anyBlank || outOfBounds || tooNarrow || tooShort

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!form || !points || invalid) return

    setPending(true)
    setSaveError(null)
    setSaved(null)

    try {
      const next = await savePageSetup({ paper: form.paper, ...points })
      setData(next)
      setForm(toForm(next.setup))
      setSaved(
        `Saved. The next memo will be drawn on ${next.setup.paper === 'A4' ? 'A4' : 'Letter'}. Memos already filed are unchanged.`,
      )
    } catch (error) {
      setSaveError(message(error, 'Could not save the page setup.'))
    } finally {
      setPending(false)
    }
  }

  function restoreDefault() {
    if (!data) return
    setForm(toForm(data.default))
    setSaved(null)
    setSaveError(null)
  }

  if (loadError) {
    return (
      <Page width="narrow">
        <PageHeader eyebrow="Administration · Page setup" title="Page setup" />
        <Card>
          <div className="space-y-3 p-4">
            <p className="text-ui text-content">{loadError}</p>
            <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </div>
        </Card>
      </Page>
    )
  }

  if (!data || !form) {
    return (
      <Page width="narrow">
        <PageHeader eyebrow="Administration · Page setup" title="Page setup" />
        <LoadingAnnouncer loading label="Reading the page setup" />
        <Card>
          <div className="space-y-3 p-4">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-24 w-full" />
          </div>
        </Card>
      </Page>
    )
  }

  return (
    <Page width="narrow">
      <PageHeader
        eyebrow="Administration · Page setup"
        title="Page setup"
        description="The paper and margins every memo this system generates is drawn on."
      />

      <form onSubmit={submit} className="space-y-4">
        <Card>
          <CardHeader icon={FileText} title="Paper" />
          <div className="space-y-3 p-4 pt-0">
            <fieldset className="space-y-2">
              <legend className="sr-only">Paper size</legend>
              {data.papers.map((paper) => (
                <label
                  key={paper.name}
                  className="flex cursor-pointer items-center gap-3 rounded-control border
                             border-line p-3 hover:bg-surface-muted
                             focus-within:outline-2 focus-within:outline-offset-2
                             focus-within:outline-accent"
                >
                  <input
                    type="radio"
                    name="paper"
                    value={paper.name}
                    checked={form.paper === paper.name}
                    onChange={() =>
                      setForm({ ...form, paper: paper.name })
                    }
                    className="size-4 accent-accent"
                  />
                  <span className="flex-1">
                    <span className="block text-ui font-medium text-content">
                      {paper.name === 'A4' ? 'A4' : 'US Letter'}
                    </span>
                    <span className="block text-2xs text-content-faint tabular-nums">
                      {Math.round((paper.width / PT_PER_MM) * 10) / 10} ×{' '}
                      {Math.round((paper.height / PT_PER_MM) * 10) / 10} mm
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          </div>
        </Card>

        <Card>
          <CardHeader
            icon={Ruler}
            title="Margins"
            hint="In millimetres. Left and right are separate, so a wider gutter down one side for a binder is a setting rather than a compromise."
          />
          <div className="space-y-4 p-4 pt-0">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {EDGES.map(({ key, label }) => {
                const value = Number(form[key])
                const bad =
                  form[key].trim() === '' ||
                  !Number.isFinite(value) ||
                  toPoints(value) < data.bounds.minMargin ||
                  toPoints(value) > data.bounds.maxMargin

                return (
                  <div key={key} className="space-y-1">
                    <label
                      htmlFor={`margin-${key}`}
                      className="block text-2xs font-medium uppercase tracking-wide text-content-faint"
                    >
                      {label}
                    </label>
                    <div className="flex items-center gap-1">
                      <input
                        id={`margin-${key}`}
                        type="number"
                        inputMode="decimal"
                        step="0.5"
                        min={Math.ceil(data.bounds.minMargin / PT_PER_MM)}
                        max={Math.floor(data.bounds.maxMargin / PT_PER_MM)}
                        value={form[key]}
                        aria-invalid={bad}
                        onChange={(event) =>
                          setForm({ ...form, [key]: event.target.value })
                        }
                        className="w-full rounded-control border border-line bg-surface px-2 py-1.5
                                   text-ui tabular-nums text-content
                                   focus-visible:outline-2 focus-visible:outline-offset-2
                                   focus-visible:outline-accent
                                   aria-[invalid=true]:border-danger"
                      />
                      <span className="text-2xs text-content-faint">mm</span>
                    </div>
                  </div>
                )
              })}
            </div>

            {/*
              What the numbers add up to.

              Each margin can be perfectly legal on its own and the pair still
              leave nothing to write on, which is the case a per-field message
              cannot explain.
            */}
            <p
              className="text-2xs text-content-faint tabular-nums"
              aria-live="polite"
            >
              Text column:{' '}
              <span className={tooNarrow ? 'text-danger-ink' : undefined}>
                {Math.round(columnWidth)}pt wide
              </span>
              {' · '}
              <span className={tooShort ? 'text-danger-ink' : undefined}>
                {Math.round(columnHeight)}pt tall
              </span>
            </p>

            {(tooNarrow || tooShort) && (
              <p className="text-ui text-danger-ink" role="alert">
                {tooNarrow
                  ? 'The left and right margins leave too little to write on. Reduce one of them.'
                  : 'The top and bottom margins leave too little to write on. Reduce one of them.'}
              </p>
            )}
          </div>
        </Card>

        {/*
          Said on the screen, not left to be discovered.

          Somebody changing a margin reasonably wonders whether the memos
          already in the system move too. They do not, and the reason is worth
          one sentence: they are the documents people signed.
        */}
        <p className="text-2xs text-content-faint">
          This changes the next memo drawn. Memos already filed keep the page
          they were drawn on — they are the documents people signed, and their
          checksums are recorded in the audit ledger.
        </p>

        {saveError && (
          <p className="text-ui text-danger-ink" role="alert">
            {saveError}
          </p>
        )}

        {saved && (
          <p className="text-ui text-success-ink" role="status">
            {saved}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending || invalid}>
            {pending ? 'Saving…' : 'Save page setup'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            icon={<RotateCcw size={16} />}
            disabled={pending}
            onClick={restoreDefault}
          >
            Restore the default
          </Button>
        </div>
      </form>
    </Page>
  )
}
