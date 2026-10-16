import { useEffect, useId, useState, type FormEvent } from 'react'
import { Archive, ArchiveRestore, Pencil, Plus, TextQuote } from 'lucide-react'

import MemoBodyEditor from '../components/submit/MemoBodyEditor'
import Button from '../components/ui/Button'
import { Card, CardHeader } from '../components/ui/Card'
import { Page, PageHeader } from '../components/ui/Page'
import { LoadingAnnouncer, Skeleton } from '../components/ui/Skeleton'
import {
  createMemoClause,
  fetchMemoClauses,
  updateMemoClause,
  type MemoClause,
} from '../services/memoClausesApi'
import type { MemoBody } from '../types/memo'
import { formatDisplayDate } from '../utils/format'
import { emptyMemoBody } from '../utils/memoDom'

/**
 * The standard wording a preparer can insert into a memo.
 *
 * The usual recommendation paragraph, an approval condition, the sentence a
 * memo of a given kind always opens with: typed the same way a hundred times
 * and slightly differently each time. Kept here once, by an administrator.
 *
 * Two things the screen says outright. A memo takes a COPY of a clause, so
 * editing or archiving one here changes nothing already written - which is
 * what makes both safe to offer. And archiving is not deleting: the wording
 * may sit on many filed memos, and it can be put back.
 */

const message = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback

/** The same test the server applies: something written, in any block. */
const hasWords = (body: MemoBody): boolean =>
  body.content.some(
    block => block.type !== 'paragraph' || (block.content?.length ?? 0) > 0,
  )

type Draft = { id: string | null; title: string; body: MemoBody }

export default function StandardWordingPage() {
  const [clauses, setClauses] = useState<MemoClause[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const titleId = useId()
  const bodyId = useId()
  const bodyLabelId = useId()

  useEffect(() => {
    let cancelled = false

    fetchMemoClauses()
      .then(loaded => {
        if (cancelled) return
        setClauses(loaded.clauses)
        setLoadError(null)
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(message(error, 'Could not read the standard wording'))
      })

    return () => {
      cancelled = true
    }
  }, [attempt])

  const upsert = (clause: MemoClause) =>
    setClauses(current => {
      const rest = (current ?? []).filter(entry => entry.id !== clause.id)
      return [...rest, clause].sort(
        (one, other) =>
          Number(one.archivedAt !== null) - Number(other.archivedAt !== null) ||
          one.title.localeCompare(other.title),
      )
    })

  const startNew = () => {
    setDraft({ id: null, title: '', body: emptyMemoBody() })
    setSaveError(null)
    setNotice(null)
  }

  const startEdit = (clause: MemoClause) => {
    setDraft({ id: clause.id, title: clause.title, body: clause.body })
    setSaveError(null)
    setNotice(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft) return

    const title = draft.title.trim()
    if (!title) {
      setSaveError('Give the wording a title, so a preparer can pick it out of the list.')
      return
    }
    if (!hasWords(draft.body)) {
      setSaveError('Write the wording before saving it.')
      return
    }

    setSaving(true)
    setSaveError(null)
    try {
      const { clause } = draft.id
        ? await updateMemoClause(draft.id, { title, body: draft.body })
        : await createMemoClause({ title, body: draft.body })
      upsert(clause)
      setDraft(null)
      setNotice(`“${clause.title}” saved. Preparers can insert it from now on.`)
    } catch (error: unknown) {
      setSaveError(message(error, 'Could not save the wording'))
    } finally {
      setSaving(false)
    }
  }

  const toggleArchived = async (clause: MemoClause) => {
    setBusyId(clause.id)
    setNotice(null)
    try {
      const { clause: updated } = await updateMemoClause(clause.id, {
        archived: clause.archivedAt === null,
      })
      upsert(updated)
      setNotice(
        updated.archivedAt
          ? `“${updated.title}” is no longer offered. It stays on every memo that already carries it.`
          : `“${updated.title}” is offered again.`,
      )
    } catch (error: unknown) {
      setSaveError(message(error, 'Could not change the wording'))
    } finally {
      setBusyId(null)
    }
  }

  if (loadError) {
    return (
      <Page width="narrow">
        <PageHeader eyebrow="Administration · Standard wording" title="Standard wording" />
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

  if (!clauses) {
    return (
      <Page width="narrow">
        <PageHeader eyebrow="Administration · Standard wording" title="Standard wording" />
        <LoadingAnnouncer loading label="Reading the standard wording" />
        <Card>
          <div aria-hidden="true" className="space-y-3 p-4">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        </Card>
      </Page>
    )
  }

  return (
    <Page width="narrow">
      <PageHeader
        eyebrow="Administration · Standard wording"
        title="Standard wording"
        description="Blocks of wording a preparer can insert into a memo as they write it. A memo takes a copy, so changing a clause here changes nothing already written."
      />

      {notice && (
        <p role="status" className="mb-4 text-ui text-success-ink">
          {notice}
        </p>
      )}

      <div className="space-y-4">
        {draft ? (
          <form onSubmit={submit}>
            <Card>
              <CardHeader
                icon={TextQuote}
                title={draft.id ? 'Edit wording' : 'New wording'}
                hint="Written in the same editor a memo is, so anything a memo can hold - a heading, a list, a table - a clause can hold too."
              />
              <div className="space-y-4 p-4 pt-0">
                <div className="space-y-1">
                  <label htmlFor={titleId} className="field-label">
                    Title
                  </label>
                  <input
                    id={titleId}
                    value={draft.title}
                    maxLength={120}
                    placeholder="How a preparer will recognise it, e.g. Recommendation"
                    onChange={event =>
                      setDraft(current => current && { ...current, title: event.target.value })
                    }
                    className="field"
                  />
                </div>

                <div className="space-y-1">
                  <p id={bodyLabelId} className="field-label">
                    Wording
                  </p>
                  <MemoBodyEditor
                    key={draft.id ?? 'new'}
                    id={bodyId}
                    initialBody={draft.body}
                    onChange={body => setDraft(current => current && { ...current, body })}
                    labelledBy={bodyLabelId}
                    typography={false}
                  />
                </div>

                {saveError && (
                  <p className="text-ui text-danger-ink" role="alert">
                    {saveError}
                  </p>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button type="submit" pending={saving}>
                    {draft.id ? 'Save changes' : 'Add to the library'}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={saving}
                    onClick={() => {
                      setDraft(null)
                      setSaveError(null)
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </Card>
          </form>
        ) : (
          <div className="flex justify-end">
            <Button icon={<Plus size={16} aria-hidden="true" />} onClick={startNew}>
              New wording
            </Button>
          </div>
        )}

        <Card>
          <CardHeader
            icon={TextQuote}
            title="In the library"
            hint="Archiving takes a clause off the preparer's list without deleting it; it can be put back."
          />
          {clauses.length === 0 ? (
            <p className="px-4 pb-4 text-ui text-content-muted">
              Nothing yet. Add the paragraph everybody types.
            </p>
          ) : (
            <ul className="divide-y divide-line-soft">
              {clauses.map(clause => {
                const archived = clause.archivedAt !== null
                return (
                  <li
                    key={clause.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-ui font-medium text-content">
                        <span className="truncate">{clause.title}</span>
                        {archived && (
                          <span className="rounded-chip bg-sunken px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-content-muted">
                            Archived
                          </span>
                        )}
                      </p>
                      <p className="text-meta text-content-subtle">
                        Updated {formatDisplayDate(clause.updatedAt)}
                        {clause.updatedBy
                          ? ` by ${clause.updatedBy.firstName} ${clause.updatedBy.lastName}`
                          : ''}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Pencil size={14} aria-hidden="true" />}
                        disabled={busyId === clause.id}
                        onClick={() => startEdit(clause)}
                        aria-label={`Edit ${clause.title}`}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={
                          archived ? (
                            <ArchiveRestore size={14} aria-hidden="true" />
                          ) : (
                            <Archive size={14} aria-hidden="true" />
                          )
                        }
                        pending={busyId === clause.id}
                        onClick={() => toggleArchived(clause)}
                        aria-label={`${archived ? 'Restore' : 'Archive'} ${clause.title}`}
                      >
                        {archived ? 'Restore' : 'Archive'}
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      </div>
    </Page>
  )
}
