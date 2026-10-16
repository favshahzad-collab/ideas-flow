/**
 * Extracted from DocDetailPage, which had grown to 1,725 lines — seven
 * components and the screen itself in one file.
 */
import { MessageSquare } from 'lucide-react'
import { useState } from 'react'
import { Avatar } from '../ui/Card'
import type { CommentView } from '../../types/documentDetail'
import Button from '../ui/Button'

export default function CommentsTab({
  comments,
  onAddComment,
  commentLoading,
}: {
  comments: CommentView[]
  onAddComment: (comment: string) => Promise<void>
  commentLoading: boolean
}) {
  const [newComment, setNewComment] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    const trimmed = newComment.trim()
    if (!trimmed) return

    setError(null)
    try {
      await onAddComment(trimmed)
      setNewComment('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add comment')
    }
  }
  
    return (
    <section className="card p-4 sm:p-5">
      <div className="flex items-center justify-between mb-5">
          <div>
          <h2 className="text-section font-semibold text-content">Comments</h2>
          <p className="text-meta text-content-subtle mt-1">Discussion related to this document</p>
          </div>
        <MessageSquare size={18} className="text-content-subtle" />
        </div>
  
        <div className="space-y-5">
        {comments.length === 0 && (
          <p className="text-ui text-content-muted">No comments yet.</p>
        )}
        {comments.map(comment => (
          <div key={comment.id} className="flex gap-3">
            <Avatar initials={comment.initials} tone="info" />
              <div className="flex-1 min-w-0">
              <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
                <span className="text-ui font-medium text-content">{comment.user}</span>
                <span className="text-2xs text-content-subtle">{comment.date}</span>
                </div>
              <p className="mt-2 text-meta sm:text-ui leading-relaxed text-content-muted">
                  {comment.comment}
                </p>
              </div>
            </div>
          ))}
        </div>
  
        <div className="mt-6 pt-5 border-t border-line-soft">
        <label
          htmlFor="doc-add-comment"
          className="block text-meta font-medium text-content-muted mb-2"
        >
          Add comment
        </label>
          <textarea
            id="doc-add-comment"
            value={newComment}
          onChange={e => setNewComment(e.target.value)}
            rows={3}
            placeholder="Write a comment..."
          className="field py-2.5 resize-none"
        />
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
          <div className="flex justify-end mt-2">
            <Button
              size="sm"
              disabled={!newComment.trim()}
              pending={commentLoading}
              onClick={handleSubmit}
            >
              Add comment
            </Button>
          </div>
        </div>
      </section>
  )
}
