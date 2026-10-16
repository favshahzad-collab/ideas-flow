import { useCallback, useEffect, useRef, useState } from 'react'
import { StickyNote, Trash2 } from 'lucide-react'

import type { MemoNote } from '../../types/memo'

/**
 * Notes written onto the page rather than into the text.
 *
 * The body is a flow: paragraphs and tables laid out one after another, and
 * broken across pages by whatever fits. A note is the other kind of thing - a
 * box somebody put in a particular place, beside the paragraph it is about,
 * the way a person writing on paper would. So it is placed, not typed into
 * the text, and nothing above it moves it.
 *
 * The layer sits over the sheet and is transparent to the mouse except where
 * a note is, so writing the memo underneath is unaffected until somebody asks
 * for a note by pressing the tool.
 */

/** A4 in points, as the renderer has it. The layer converts to and from this. */
const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89

/** What a note is when placed with a click rather than dragged out. */
const DEFAULT_WIDTH = 170
const DEFAULT_HEIGHT = 56

/** Below this the renderer draws nothing, so the layer will not make one. */
const MIN_SIZE = 24

/** How far an arrow key moves a note, in points. Shift multiplies it. */
const NUDGE = 4
const NUDGE_FAST = 24

export interface MemoNotesLayerProps {
  notes: MemoNote[]
  onChange: (notes: MemoNote[]) => void
  disabled?: boolean
  /** Turned off while the tool is not armed, so the memo can be typed in. */
  placing: boolean
  onPlacingChange: (placing: boolean) => void
}

type Drag =
  | { kind: 'new'; fromX: number; fromY: number; toX: number; toY: number }
  | { kind: 'move'; index: number; grabX: number; grabY: number }
  | { kind: 'resize'; index: number }

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

export default function MemoNotesLayer({
  notes,
  onChange,
  disabled = false,
  placing,
  onPlacingChange,
}: MemoNotesLayerProps) {
  const layerRef = useRef<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [focused, setFocused] = useState<number | null>(null)

  /** A pointer event's position on the page, in points. */
  const pointToPage = useCallback((clientX: number, clientY: number) => {
    const layer = layerRef.current
    if (!layer) return { x: 0, y: 0 }

    const box = layer.getBoundingClientRect()
    const scale = PAGE_WIDTH / box.width

    return {
      x: clamp((clientX - box.left) * scale, 0, PAGE_WIDTH),
      y: clamp((clientY - box.top) * scale, 0, PAGE_HEIGHT),
    }
  }, [])

  const replace = useCallback(
    (index: number, next: Partial<MemoNote>) => {
      onChange(
        notes.map((note, at) => (at === index ? { ...note, ...next } : note)),
      )
    },
    [notes, onChange],
  )

  const remove = useCallback(
    (index: number) => {
      onChange(notes.filter((_, at) => at !== index))
      setFocused(null)
    },
    [notes, onChange],
  )

  /*
   * Dragging is tracked on the window, not on the note.
   *
   * A pointer that leaves the box mid-drag - which is what dragging a small
   * box quickly always does - stops sending events to it, and the note would
   * stick to the cursor with no way to let go.
   */
  useEffect(() => {
    if (!drag) return

    const move = (event: PointerEvent) => {
      const at = pointToPage(event.clientX, event.clientY)

      if (drag.kind === 'new') {
        setDrag({ ...drag, toX: at.x, toY: at.y })
        return
      }

      const note = notes[drag.index]
      if (!note) return

      if (drag.kind === 'move') {
        replace(drag.index, {
          x: clamp(at.x - drag.grabX, 0, PAGE_WIDTH - note.width),
          y: clamp(at.y - drag.grabY, 0, PAGE_HEIGHT - note.height),
        })
        return
      }

      replace(drag.index, {
        width: clamp(at.x - note.x, MIN_SIZE, PAGE_WIDTH - note.x),
        height: clamp(at.y - note.y, MIN_SIZE, PAGE_HEIGHT - note.y),
      })
    }

    const up = () => {
      if (drag.kind === 'new') {
        const x = Math.min(drag.fromX, drag.toX)
        const y = Math.min(drag.fromY, drag.toY)
        const width = Math.abs(drag.toX - drag.fromX)
        const height = Math.abs(drag.toY - drag.fromY)

        // A click rather than a drag: the box was never pulled out, so it
        // gets a readable default instead of a sliver nothing fits in.
        const placed: MemoNote = {
          page: 1,
          x: clamp(x, 0, PAGE_WIDTH - DEFAULT_WIDTH),
          y: clamp(y, 0, PAGE_HEIGHT - DEFAULT_HEIGHT),
          width: width < MIN_SIZE ? DEFAULT_WIDTH : width,
          height: height < MIN_SIZE ? DEFAULT_HEIGHT : height,
          text: '',
        }

        onChange([...notes, placed])
        setFocused(notes.length)
        onPlacingChange(false)
      }

      setDrag(null)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [drag, notes, onChange, onPlacingChange, pointToPage, replace])

  /** The new note being dragged out, as a box to draw. */
  const pending =
    drag?.kind === 'new'
      ? {
          x: Math.min(drag.fromX, drag.toX),
          y: Math.min(drag.fromY, drag.toY),
          width: Math.abs(drag.toX - drag.fromX),
          height: Math.abs(drag.toY - drag.fromY),
        }
      : null

  const percent = (points: number, of: number) => `${(points / of) * 100}%`

  return (
    <div
      ref={layerRef}
      data-testid="memo-notes-layer"
      /*
       * `pointer-events-none` until the tool is armed. The layer covers the
       * page, and a layer that swallowed clicks would make the memo itself
       * untypable - which is the failure a placement overlay always has.
       */
      className={`absolute inset-x-0 top-0 ${
        placing ? 'cursor-crosshair' : 'pointer-events-none'
      }`}
      style={{ aspectRatio: `${PAGE_WIDTH} / ${PAGE_HEIGHT}` }}
      onPointerDown={event => {
        if (!placing || disabled) return
        const at = pointToPage(event.clientX, event.clientY)
        setDrag({ kind: 'new', fromX: at.x, fromY: at.y, toX: at.x, toY: at.y })
      }}
    >
      {pending && pending.width > 2 && (
        <div
          aria-hidden="true"
          className="absolute rounded-chip border border-dashed border-accent bg-accent-soft/60"
          style={{
            left: percent(pending.x, PAGE_WIDTH),
            top: percent(pending.y, PAGE_HEIGHT),
            width: percent(pending.width, PAGE_WIDTH),
            height: percent(pending.height, PAGE_HEIGHT),
          }}
        />
      )}

      {notes.map((note, index) => (
        <div
          key={index}
          className="memo-note pointer-events-auto absolute"
          style={{
            left: percent(note.x, PAGE_WIDTH),
            top: percent(note.y, PAGE_HEIGHT),
            width: percent(note.width, PAGE_WIDTH),
            height: percent(note.height, PAGE_HEIGHT),
          }}
        >
          <div className="memo-note-bar">
            {/*
              The grab handle, and the keyboard's way in. Dragging is a mouse
              gesture; the same move has to be possible with arrow keys or the
              feature is unusable without one.
            */}
            <button
              type="button"
              disabled={disabled}
              aria-label={`Move note ${index + 1}`}
              className="memo-note-grip"
              onFocus={() => setFocused(index)}
              onPointerDown={event => {
                if (disabled) return
                event.preventDefault()
                const at = pointToPage(event.clientX, event.clientY)
                setDrag({
                  kind: 'move',
                  index,
                  grabX: at.x - note.x,
                  grabY: at.y - note.y,
                })
              }}
              onKeyDown={event => {
                const step = event.shiftKey ? NUDGE_FAST : NUDGE
                const moves: Record<string, [number, number]> = {
                  ArrowLeft: [-step, 0],
                  ArrowRight: [step, 0],
                  ArrowUp: [0, -step],
                  ArrowDown: [0, step],
                }
                const move = moves[event.key]
                if (!move) return

                event.preventDefault()
                replace(index, {
                  x: clamp(note.x + move[0], 0, PAGE_WIDTH - note.width),
                  y: clamp(note.y + move[1], 0, PAGE_HEIGHT - note.height),
                })
              }}
            >
              <StickyNote size={11} aria-hidden="true" />
            </button>

            <button
              type="button"
              disabled={disabled}
              aria-label={`Remove note ${index + 1}`}
              className="memo-note-remove"
              onClick={() => remove(index)}
            >
              <Trash2 size={11} aria-hidden="true" />
            </button>
          </div>

          <textarea
            value={note.text}
            disabled={disabled}
            aria-label={`Note ${index + 1}`}
            placeholder="Write here"
            autoFocus={focused === index}
            onChange={event => replace(index, { text: event.target.value })}
            className="memo-note-text"
          />

          {/*
            Resize by the corner, the same gesture as every other box on the
            page. Hidden from assistive technology: the size of a note is not
            something a screen-reader user can usefully drag, and the text
            inside it wraps either way.
          */}
          <span
            aria-hidden="true"
            className="memo-note-corner"
            onPointerDown={event => {
              if (disabled) return
              event.preventDefault()
              event.stopPropagation()
              setDrag({ kind: 'resize', index })
            }}
          />
        </div>
      ))}
    </div>
  )
}

