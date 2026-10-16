import { AlertCircle, FileText, PenTool, StickyNote } from 'lucide-react'
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from 'react'

import { fetchMemoTypes } from '../../services/memoApi'
import { fetchStandardWording, type StandardWording } from '../../services/memoClausesApi'
import { addMemoDictionaryWord, fetchDictionaryWords } from '../../services/memoDictionaryApi'
import { CurrentUserContext } from '../../contexts/currentUser'
import { holdsCapability } from '../../types/capability'
import type {
  MemoBody,
  MemoNote,
  MemoPageGeometry,
  MemoTypeDefinition,
} from '../../types/memo'
import type { DraftSaveState } from '../../hooks/useServerMemoDraft'
import { outlineBody } from '../../utils/memoDom'
import { Card, CardHeader } from '../ui/Card'
import { Skeleton } from '../ui/Skeleton'
import MemoBodyEditor from './MemoBodyEditor'
import MemoNotesLayer from './MemoNotesLayer'

/**
 * Writing the memo, rather than attaching one.
 *
 * Three things on one screen, in the order somebody thinks about them: what
 * kind of memo this is, who it is to and from, and then the memo. The header
 * fields are separate inputs rather than the first lines of the body because
 * the template draws them as a block and the server stores them as columns -
 * a memo whose addressee is a sentence somewhere in the prose cannot be
 * listed, filtered or reported on.
 */

/**
 * One column of the printed signature strip, as the page will show it.
 *
 * Name only. The filed page prints a title under each name, but the people
 * picker does not carry one for the approvers - so a title shown for some
 * columns and not others would read as a gap in the memo rather than as a
 * gap in what this screen happens to know.
 */
export interface SheetSignatory {
  key: string
  name: string
}

interface MemoComposeCardProps {
  memoType: string | null
  /** The subject line. The same value the document is titled by. */
  title: string
  memoTo: string
  memoFrom: string
  /** The date the memo bears, as `2026-08-06`. */
  memoDate: string
  body: MemoBody
  /** Shown once a submission has been attempted and something is missing. */
  error: string | null
  /**
   * The chosen type, its starting outline, and whether writing this kind of
   * memo means signing it.
   *
   * The last of those is resolved by the server and passed up rather than
   * worked out anywhere on this side, so the step that says "review and sign"
   * and the dialog that does the signing cannot disagree about whether there
   * is a signature to collect.
   */
  onMemoTypeChange: (
    memoType: string,
    outline: MemoBody,
    preparerSigns: boolean,
  ) => void
  onTitleChange: (value: string) => void
  onMemoToChange: (value: string) => void
  onMemoFromChange: (value: string) => void
  onMemoDateChange: (value: string) => void
  onBodyChange: (body: MemoBody) => void
  /** Notes placed on the page, and the way to change them. */
  notes?: MemoNote[]
  onNotesChange?: (notes: MemoNote[]) => void
  /**
   * Who the foot of the page will print a ruled line for, in order.
   *
   * Empty until the chain is chosen, and then the strip appears - which is
   * the point: the preparer sees the document take its final shape as they
   * build it, rather than meeting it for the first time in the signing
   * dialog.
   */
  signatories?: SheetSignatory[]
  /**
   * Bumped when the body is replaced from outside — restoring a draft, say.
   *
   * The editor is uncontrolled, so it reads `initialBody` once and ignores
   * later changes to it. Without this, restoring a draft put the memo back
   * into state and left the previous text on screen, and the preparer signed
   * whichever of the two they could not see.
   */
  seed?: number
  /**
   * Whether the memo has reached the server yet.
   *
   * Said out loud because a memo typed here is the whole of somebody's work
   * and there is no file on a desktop to fall back on. Silence would leave
   * them guessing, and a failed save that says nothing is the one that costs
   * an afternoon.
   */
  saveState?: DraftSaveState
}

export default function MemoComposeCard({
  memoType,
  title,
  memoTo,
  memoFrom,
  memoDate,
  body,
  error,
  seed = 0,
  saveState = 'idle',
  onMemoTypeChange,
  onTitleChange,
  onMemoToChange,
  onMemoFromChange,
  onMemoDateChange,
  onBodyChange,
  notes = [],
  onNotesChange,
  signatories = [],
}: MemoComposeCardProps) {
  /* Armed by the tool, disarmed the moment a note is placed. A layer that
     stayed armed would swallow the next click meant for the memo itself. */
  const [placingNote, setPlacingNote] = useState(false)
  const [types, setTypes] = useState<MemoTypeDefinition[] | null>(null)
  const [typesError, setTypesError] = useState<string | null>(null)
  /*
     The page the memo will be filed on.

     Null until it arrives, and the sheet then falls back to the delivered
     default through the CSS - so the editor is correct before the request
     lands rather than briefly the wrong width.
  */
  const [page, setPage] = useState<MemoPageGeometry | null>(null)

  /*
     What the load effect needs, without depending on it.

     The effect runs once and picks the only type when there is one. Listing
     either of these as a dependency would re-run the fetch - and re-running
     it would seed the outline again, on top of whatever had been written
     since. Kept in a ref, and refreshed in its own effect rather than during
     render, because a render must not write to one.
  */
  const latest = useRef({ memoType, onMemoTypeChange })

  useEffect(() => {
    latest.current = { memoType, onMemoTypeChange }
  })

  const subjectId = useId()
  const toId = useId()
  const fromId = useId()
  const dateId = useId()
  const bodyId = useId()
  const bodyLabelId = useId()
  const errorId = useId()

  /*
   * The words the spell check should not flag - the organisation's own and
   * the directory's names - and whether this person may add to them. Read
   * off the context rather than the hook so a composer rendered without a
   * signed-in user (a test, say) simply offers no adding.
   */
  const [dictionary, setDictionary] = useState<string[]>([])
  const currentUser = useContext(CurrentUserContext)
  const canAddWords = holdsCapability(currentUser?.user, 'documents.dictionary')

  useEffect(() => {
    let cancelled = false

    fetchDictionaryWords()
      .then(words => {
        if (!cancelled) setDictionary(words)
      })
      .catch(() => {
        // The English dictionary and the browser's check still stand.
      })

    return () => {
      cancelled = true
    }
  }, [])

  const addWord = useCallback(async (word: string) => {
    await addMemoDictionaryWord(word)
    setDictionary(current => (current.includes(word) ? current : [...current, word]))
  }, [])

  /*
   * The standard wording on offer. A convenience: a memo can be written
   * without it, so a failure to load it is not an error the preparer has to
   * see - the control is simply not offered.
   */
  const [wording, setWording] = useState<StandardWording[]>([])

  useEffect(() => {
    let cancelled = false

    fetchStandardWording()
      .then(loaded => {
        if (!cancelled) setWording(loaded.clauses)
      })
      .catch(() => {
        // Not offered, and nothing to say.
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    fetchMemoTypes()
      .then(loaded => {
        if (cancelled) return
        setTypes(loaded.memoTypes)
        setPage(loaded.page)

        /*
         * One type is not a choice.
         *
         * Choosing is required - the step will not continue without it - so a
         * deployment with a single type asked a question with one answer and
         * then blocked on it. It is picked here instead, and the picker is
         * hidden below, so the preparer meets the question only when there is
         * something to decide.
         *
         * Only when nothing has been chosen yet: a draft reopened on the type
         * it was written as must not be reset to the first in the list.
         */
        const only = loaded.memoTypes.length === 1 ? loaded.memoTypes[0] : undefined
        if (only && !latest.current.memoType) {
          latest.current.onMemoTypeChange(
            only.key,
            outlineBody(only.outlineHeadings),
            only.preparerSigns !== false,
          )
        }
      })
      .catch(() => {
        if (!cancelled) {
          /* Named, because without the list there is nothing to choose and
             the step cannot be completed - unlike the conveniences elsewhere
             on this form, a failure here is not something to swallow. */
          setTypesError(
            'The list of memo types could not be loaded. Reload the page, or attach a PDF instead.',
          )
          setTypes([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  /*
     The organisation's page, as proportions of the sheet on screen.

     Margins are a percentage of the page width so the drawing stays right at
     any zoom, and the text column is passed in points because `--memo-pt`
     divides the container by it. Left undefined until the page arrives, which
     leaves the CSS fallbacks - the delivered A4 default - in place.
  */
  const sheetStyle = page
    ? ({
        '--memo-margin-left': `${(page.marginLeft / page.width) * 100}%`,
        '--memo-margin-right': `${(page.marginRight / page.width) * 100}%`,
        '--memo-text-width': `${page.textWidth}`,
      } as CSSProperties)
    : undefined

  return (
    <Card>
      <CardHeader
        icon={PenTool}
        title="Write the memo"
        hint="Typed here and turned into the standard memo PDF when you submit."
        meta={memoType ? types?.find(type => type.key === memoType)?.label : undefined}
      />

      <div className="space-y-4 p-3.5 sm:p-4">
        {/*
          Shown only when there is a decision to make.

          With one type the question has one answer, which is chosen above as
          soon as the list arrives - so asking it put a radio button on the
          screen that could only be pressed one way, and blocked the step
          until somebody pressed it. The kind of memo is still on the card
          header, so it is never a secret.
        */}
        <fieldset hidden={types?.length === 1}>
          <legend className="field-label">What kind of memo is this?</legend>

          {types === null ? (
            <div aria-hidden="true" className="space-y-2">
              <Skeleton className="h-16 w-full rounded-control" />
            </div>
          ) : typesError ? (
            <p role="alert" className="field-error">
              <AlertCircle size={13} aria-hidden="true" className="flex-shrink-0" />
              {typesError}
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {types.map(type => {
                const selected = type.key === memoType
                return (
                  <label
                    key={type.key}
                    className={`flex cursor-pointer gap-2.5 rounded-control border p-3 transition-colors ${
                      selected
                        ? 'border-accent bg-accent-soft'
                        : 'border-line hover:border-content-subtle'
                    }`}
                  >
                    <input
                      type="radio"
                      name="memo-type"
                      value={type.key}
                      checked={selected}
                      onChange={() =>
                        onMemoTypeChange(
                          type.key,
                          outlineBody(type.outlineHeadings),
                          // Absent means an older server, which always
                          // collected the preparer's signature.
                          type.preparerSigns !== false,
                        )
                      }
                      className="mt-0.5 flex-shrink-0 accent-accent"
                    />
                    <span className="min-w-0">
                      <span className="block text-ui font-medium text-content">
                        {type.label}
                      </span>
                      <span className="mt-0.5 block text-meta leading-relaxed text-content-muted">
                        {type.description}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          )}
        </fieldset>

        {/*
          The memo itself, as a sheet of paper.

          Every field the template prints sits where the template prints it,
          and the body is typed straight onto the page below them. There is no
          second representation of the document on this screen any more - the
          form of labelled boxes that used to stand in for it was the thing
          people edited, and it looked nothing like the page they signed.
        */}
        {onNotesChange && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-pressed={placingNote}
              onClick={() => setPlacingNote(current => !current)}
              className={`inline-flex items-center gap-1.5 rounded-control border px-2.5 py-1.5 text-meta font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                placingNote
                  ? 'border-accent bg-accent-soft text-accent-ink'
                  : 'border-line text-content-muted hover:border-content-subtle hover:text-content'
              }`}
            >
              <StickyNote size={13} aria-hidden="true" />
              Write here
            </button>

            <p className="text-meta text-content-subtle">
              {placingNote
                ? 'Click the page where the note goes, or drag out a box.'
                : 'Add a note beside the text, printed where you place it.'}
            </p>
          </div>
        )}

        {/*
          The page, and the layer of notes over it.

          `relative` so the layer can be positioned against the sheet rather
          than against the card, which is what keeps a note in the same place
          on screen as it will be on the filed page.
        */}
        <div className="relative">
        <div className="memo-sheet" style={sheetStyle}>
          {/*
            Where the letterhead goes, named rather than drawn.

            The real one comes from the branding the server holds and can be
            replaced by an administrator, so a copy kept on this side would
            eventually show a logo the filed page does not use. Saying what
            will be there is honest; drawing a stale one is not.
          */}
          <div className="memo-sheet-brand">
            <span className="text-2xs uppercase tracking-wide text-content-faint">
              Letterhead
            </span>
          </div>

          <div className="memo-sheet-rule" />

          <div className="memo-sheet-header">
            <label htmlFor={toId} className="memo-sheet-label">
              To:
            </label>
            <input
              id={toId}
              value={memoTo}
              onChange={event => onMemoToChange(event.target.value)}
              maxLength={200}
              placeholder="Sir BMD"
              className="memo-sheet-value"
            />

            <label htmlFor={fromId} className="memo-sheet-label">
              From:
            </label>
            <input
              id={fromId}
              value={memoFrom}
              onChange={event => onMemoFromChange(event.target.value)}
              maxLength={200}
              placeholder="Human Resource Department"
              className="memo-sheet-value"
            />

            <label htmlFor={subjectId} className="memo-sheet-label">
              Subject:
            </label>
            <input
              id={subjectId}
              value={title}
              onChange={event => onTitleChange(event.target.value)}
              maxLength={500}
              placeholder="What the memo is about"
              className="memo-sheet-value"
            />

            <label htmlFor={dateId} className="memo-sheet-label">
              Date:
            </label>
            <div>
              <input
                id={dateId}
                type="date"
                value={memoDate}
                onChange={event => onMemoDateChange(event.target.value)}
                className="memo-sheet-value"
              />
              {/*
                * Said out loud because the two are genuinely different and the
                * difference is the reason this field exists: a memo written on
                * the 6th and put through the system on the 11th is dated the 6th.
                */}
              <p className="mt-0.5 text-meta text-content-subtle">
                What the memo is dated, not when it is submitted.
              </p>
            </div>
          </div>

          <div className="mt-6">
            <div className="flex items-baseline justify-between gap-2">
              <h3 id={bodyLabelId} className="sr-only">
                The memo
              </h3>
              {/*
                * Polite, so a screen reader hears it between keystrokes rather
                * than interrupting the sentence being typed.
                */}
              <p aria-live="polite" className="ml-auto text-meta text-content-subtle">
                {saveState === 'saving'
                  ? 'Saving…'
                  : saveState === 'saved'
                    ? 'Saved to your drafts'
                    : saveState === 'error'
                      ? 'Not saved to your drafts — this device still has it'
                      : ''}
              </p>
            </div>
            <MemoBodyEditor
              /*
               * Remounted when the memo type changes, and only then.
               *
               * The editor is uncontrolled - the DOM is its model, so it seeds
               * itself once and ignores the prop afterwards, which is what keeps
               * a parent re-render from replacing what somebody is typing. The
               * cost is that choosing a type, which hands over that type's
               * outline, changed the state and nothing on the screen: the
               * headings never appeared and the choice looked like it did
               * nothing at all.
               *
               * A key change is a remount, and a remount reseeds. It is safe
               * here because it happens on one deliberate action, and because
               * the outline only ever replaces a body nobody has written in.
               */
              key={`${memoType ?? 'no-type'}-${seed}`}
              id={bodyId}
              initialBody={body}
              onChange={onBodyChange}
              labelledBy={bodyLabelId}
              describedBy={error ? errorId : undefined}
              invalid={Boolean(error)}
              framed={false}
              wording={wording}
              dictionary={dictionary}
              canAddWords={canAddWords}
              onAddWord={addWord}
              /* A row height is stored in points, so the pixel-to-point
                 conversion has to use the column this memo will be filed at
                 rather than the default one. */
              {...(page ? { textWidth: page.textWidth } : {})}
            />
          </div>

          {/*
            The foot of the page, as it will print.

            Not editable, and not a promise about who: the columns follow the
            approval chain, which is chosen on the next step. It is here so
            the memo reads as a whole document while it is being written
            rather than as a block of text that becomes one later.
          */}
          {signatories.length > 0 && (
            <div
              className="memo-sheet-strip"
              style={{
                gridTemplateColumns: `repeat(${signatories.length}, minmax(0, 1fr))`,
              }}
            >
              {signatories.map(person => (
                <div key={person.key} className="memo-sheet-column">
                  <span className="block text-meta font-semibold text-content">
                    {person.name}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {onNotesChange && (
          <MemoNotesLayer
            notes={notes}
            onChange={onNotesChange}
            placing={placingNote}
            onPlacingChange={setPlacingNote}
          />
        )}
        </div>

        {error && (
          <p id={errorId} role="alert" className="field-error">
            <AlertCircle size={13} aria-hidden="true" className="flex-shrink-0" />
            {error}
          </p>
        )}

        <p className="flex items-start gap-2 rounded-control bg-info-soft px-3 py-2.5 text-meta leading-relaxed text-info-ink">
          <FileText size={13} aria-hidden="true" className="mt-px flex-shrink-0" />
          The letterhead and the reference number are added when this is
          filed. The signature lines follow the approval chain you choose on
          the next step. You will see the finished memo before you sign it.
        </p>
      </div>
    </Card>
  )
}
