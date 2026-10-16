import { useEffect, useId, useState, type FormEvent } from 'react'
import { Plus, SpellCheck, Trash2 } from 'lucide-react'

import Button from '../components/ui/Button'
import { Card, CardHeader } from '../components/ui/Card'
import { Page, PageHeader } from '../components/ui/Page'
import { LoadingAnnouncer, Skeleton } from '../components/ui/Skeleton'
import {
  addMemoDictionaryWord,
  fetchMemoDictionary,
  removeMemoDictionaryWord,
  type DictionaryWord,
} from '../services/memoDictionaryApi'
import { formatDisplayDate } from '../utils/format'

/**
 * The organisation's dictionary: the words the memo editor's spell check
 * should not flag.
 *
 * Products, terms of trade, the words the organisation writes its own way
 * and an English dictionary has never heard of. Colleagues' names and
 * department names are not kept here - the directory has them, and the
 * editor is given them from there - which the screen says, so nobody types
 * the whole staff list in.
 */

const message = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback

export default function DictionaryPage() {
  const [words, setWords] = useState<DictionaryWord[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const fieldId = useId()

  useEffect(() => {
    let cancelled = false

    fetchMemoDictionary()
      .then(loaded => {
        if (cancelled) return
        setWords(loaded.words)
        setLoadError(null)
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(message(error, 'Could not read the dictionary'))
      })

    return () => {
      cancelled = true
    }
  }, [attempt])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const word = draft.trim()
    if (!word) {
      setSaveError('Type the word to add.')
      return
    }
    if (/\s/.test(word)) {
      setSaveError('One word at a time. A phrase is never what a spell check looks at.')
      return
    }

    setSaving(true)
    setSaveError(null)
    setNotice(null)
    try {
      const { word: added } = await addMemoDictionaryWord(word)
      setWords(current =>
        [...(current ?? []), added].sort((one, other) =>
          one.word.localeCompare(other.word, 'en', { sensitivity: 'base' }),
        ),
      )
      setDraft('')
      setNotice(`“${added.word}” added. The editor stops flagging it from now on.`)
    } catch (error: unknown) {
      setSaveError(message(error, 'Could not add the word'))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (entry: DictionaryWord) => {
    setBusyId(entry.id)
    setNotice(null)
    try {
      await removeMemoDictionaryWord(entry.id)
      setWords(current => (current ?? []).filter(word => word.id !== entry.id))
      setNotice(`“${entry.word}” removed. The editor flags it again.`)
    } catch (error: unknown) {
      setSaveError(message(error, 'Could not remove the word'))
    } finally {
      setBusyId(null)
    }
  }

  if (loadError) {
    return (
      <Page width="narrow">
        <PageHeader eyebrow="Administration · Dictionary" title="Dictionary" />
        <Card>
          <div className="space-y-3 p-4">
            <p className="text-ui text-danger-ink" role="alert">
              {loadError}
            </p>
            <Button variant="secondary" onClick={() => setAttempt(n => n + 1)}>
              Retry
            </Button>
          </div>
        </Card>
      </Page>
    )
  }

  if (!words) {
    return (
      <Page width="narrow">
        <PageHeader eyebrow="Administration · Dictionary" title="Dictionary" />
        <LoadingAnnouncer loading label="Reading the dictionary" />
        <Card>
          <div aria-hidden="true" className="space-y-3 p-4">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </Card>
      </Page>
    )
  }

  return (
    <Page width="narrow">
      <PageHeader
        eyebrow="Administration · Dictionary"
        title="Dictionary"
        description="The words the memo editor's spell check should not flag: products, terms of the trade, the words this organisation writes its own way. Colleagues' names and department names are already known from the directory."
      />

      {notice && (
        <p role="status" className="mb-4 text-ui text-success-ink">
          {notice}
        </p>
      )}

      <div className="space-y-4">
        <form onSubmit={submit}>
          <Card>
            <CardHeader
              icon={SpellCheck}
              title="Add a word"
              hint="One word at a time, spelled the way it should appear. Case does not matter to the check."
            />
            <div className="space-y-3 p-4 pt-0">
              <div className="space-y-1">
                <label htmlFor={fieldId} className="field-label">
                  Word
                </label>
                <input
                  id={fieldId}
                  value={draft}
                  maxLength={80}
                  autoComplete="off"
                  placeholder="e.g. Gymkhana"
                  onChange={event => {
                    setDraft(event.target.value)
                    setSaveError(null)
                  }}
                  className="field"
                />
              </div>
              {saveError && (
                <p className="text-ui text-danger-ink" role="alert">
                  {saveError}
                </p>
              )}
              <div>
                <Button type="submit" icon={<Plus size={16} aria-hidden="true" />} pending={saving}>
                  Add to the dictionary
                </Button>
              </div>
            </div>
          </Card>
        </form>

        <Card>
          <CardHeader
            icon={SpellCheck}
            title="In the dictionary"
            hint="Removing a word means the editor flags it again; nothing already written changes."
          />
          {words.length === 0 ? (
            <p className="px-4 pb-4 text-ui text-content-muted">
              Nothing yet. Add the words the editor keeps underlining.
            </p>
          ) : (
            <ul className="divide-y divide-line-soft">
              {words.map(entry => (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-ui font-medium text-content">{entry.word}</p>
                    <p className="text-meta text-content-subtle">
                      Added {formatDisplayDate(entry.createdAt)}
                      {entry.addedBy ? ` by ${entry.addedBy.firstName} ${entry.addedBy.lastName}` : ''}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Trash2 size={14} aria-hidden="true" />}
                    pending={busyId === entry.id}
                    onClick={() => remove(entry)}
                    aria-label={`Remove ${entry.word}`}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Page>
  )
}
