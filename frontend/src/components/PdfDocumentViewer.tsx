import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { pdfjs } from '../utils/pdfjs'
import { cropInkFromCanvas } from '../utils/inkCrop'
import {
  clickToPdfPlacement,
  movePdfPlacement,
  pdfPlacementToScreen,
  resizePdfPlacement,
  screenPointToPdf,
  screenRectToPdfPlacement,
  signoffBlockHeight,
  type PdfPlacement,
  type ResizeHandle,
  type ScreenPlacement,
  type SignoffPreview,
} from '../utils/pdfCoordinates'

export interface PdfPageMetrics {
  pdfWidth: number
  pdfHeight: number
  displayWidth: number
  displayHeight: number
}

interface PdfDocumentViewerProps {
  file: Blob | null
  placementMode?: boolean
  placement?: PdfPlacement | null
  onPlacement?: (placement: PdfPlacement, metrics: PdfPageMetrics) => void
  signaturePreviewUrl?: string | null
  allowSignatureDrop?: boolean
  placementHint?: string
  /** Draw freehand ink on the page instead of click-to-place a stamp. */
  drawOnPdf?: boolean
  /** Increment to wipe ink (Clear, mode switch, modal reopen). */
  inkResetKey?: number
  onInkChange?: (dataUrl: string | null) => void
  /**
   * Controlled paging. Omit both and the viewer keeps its own page state and
   * its Previous/Next buttons, which is what the signing modals want. Supply
   * them and the page becomes the caller's — the detail screen drives it from
   * its thumbnail rail.
   */
  page?: number
  onPageChange?: (page: number) => void
  /**
   * What the name/designation block under the signature will say, so the
   * editor can show it and reserve its height.
   *
   * The block is drawn by the backend from the foot of the image downwards,
   * and the backend moves the signature UP to fit it. Without this the box
   * somebody dragged to the bottom of a page came back higher in the PDF than
   * where they put it, with nothing on screen to explain why.
   */
  signoffPreview?: SignoffPreview | null
  /**
   * Where this reader signs, marked on the page when it is their turn: a
   * dashed "Sign here" box at their line. A button, because pressing it is
   * the quickest way into signing. Read-only views only - the signing dialog
   * places the real signature.
   */
  signHere?: { placement: PdfPlacement; name: string; onSign: () => void } | null
  /** Offered beside the zoom controls once something has been placed. */
  onRemovePlacement?: () => void
}

/** Zoom stops, as multiples of the width the page is fitted to. */
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

/** How far one arrow-key press moves the signature, in PDF points. */
const NUDGE_PDF = 1
const NUDGE_PDF_FAST = 10
/** How much one +/- press changes the width, in PDF points. */
const RESIZE_STEP_PDF = 10

const RESIZE_HANDLES: {
  id: ResizeHandle
  className: string
  cursor: string
}[] = [
  { id: 'nw', className: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2', cursor: 'nwse-resize' },
  { id: 'ne', className: 'right-0 top-0 translate-x-1/2 -translate-y-1/2', cursor: 'nesw-resize' },
  { id: 'sw', className: 'left-0 bottom-0 -translate-x-1/2 translate-y-1/2', cursor: 'nesw-resize' },
  { id: 'se', className: 'right-0 bottom-0 translate-x-1/2 translate-y-1/2', cursor: 'nwse-resize' },
]

function configureInkContext(ctx: CanvasRenderingContext2D, dpr: number) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 2
  ctx.strokeStyle = '#1e293b'
}

export default function PdfDocumentViewer({
  file,
  placementMode = false,
  placement = null,
  onPlacement,
  signaturePreviewUrl = null,
  allowSignatureDrop = false,
  placementHint,
  drawOnPdf = false,
  inkResetKey = 0,
  onInkChange,
  page: pageProp,
  onPageChange,
  signoffPreview = null,
  signHere = null,
  onRemovePlacement,
}: PdfDocumentViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const inkCanvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const zoomId = useId()
  // The loaded document is tagged with the file it came from, so `loading`,
  // `error` and `pageCount` derive from whether it matches the current prop.
  // Resetting them at the top of the effect meant a render showing the old
  // document's page count while the new one was still decoding.
  const [loadedDoc, setLoadedDoc] = useState<{
    file: File | Blob
    doc: pdfjs.PDFDocumentProxy | null
    error: string | null
  } | null>(null)
  const [internalPage, setInternalPage] = useState(1)
  const [screenPlacement, setScreenPlacement] = useState<ScreenPlacement | null>(null)
  /* The rendered page's size in PDF points, for overlays drawn in proportion
     to it. The metrics ref holds the same numbers but does not re-render. */
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null)
  /*
   * Zoom is a property of the view, never of the placement. The placement is
   * held in PDF points throughout, so changing this re-renders the page at a
   * different scale and the signature is redrawn over the same PDF location -
   * which is the whole reason the coordinates are not screen pixels.
   */
  const [zoom, setZoom] = useState(1)
  // Failing to render a page is a different failure from failing to load the
  // document, but it shares the error slot. Tag it with the file so switching
  // documents clears it.
  const [renderError, setRenderError] = useState<{
    file: File | Blob | null
    message: string
  } | null>(null)

  const isCurrentFile = Boolean(file) && loadedDoc?.file === file
  const pdfDoc = isCurrentFile ? loadedDoc.doc : null
  const loading = Boolean(file) && !isCurrentFile
  const pageCount = pdfDoc?.numPages ?? 0

  /* Derived, not synced. Mirroring `pageProp` into state through an effect
     would render the old page once before correcting itself, and on a PDF
     that is a visible flash of the wrong page. */
  const isControlled = pageProp !== undefined
  const currentPage = isControlled
    ? Math.min(Math.max(1, pageProp), Math.max(1, pageCount))
    : internalPage

  const goToPage = useCallback(
    (next: number) => {
      const clamped = Math.min(Math.max(1, next), Math.max(1, pageCount))
      if (isControlled) onPageChange?.(clamped)
      else setInternalPage(clamped)
    },
    [isControlled, onPageChange, pageCount],
  )
  const error =
    (isCurrentFile ? loadedDoc.error : null) ??
    (renderError?.file === file ? renderError.message : null)
  const metricsRef = useRef<PdfPageMetrics | null>(null)
  const placementRef = useRef<PdfPlacement | null>(placement)
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null)
  const resizeSessionRef = useRef<{
    handle: ResizeHandle
    pointerId: number
  } | null>(null)
  /*
   * A drag holds the grab offset, not the pointer position: without it the box
   * jumps so its top-left sits under the cursor the moment you touch it, which
   * is what makes a drag feel broken even when the arithmetic is right.
   */
  const dragSessionRef = useRef<{
    pointerId: number
    grabOffsetPdfX: number
    grabOffsetPdfY: number
    moved: boolean
  } | null>(null)
  const drawingRef = useRef(false)
  const strokesRef = useRef<{ x: number; y: number }[][]>([])
  const onInkChangeRef = useRef(onInkChange)
  const onPlacementRef = useRef(onPlacement)
  const currentPageRef = useRef(currentPage)
  const drawOnPdfRef = useRef(drawOnPdf)

  /*
   * Drawing and dragging want the same surface and cannot both have it: a
   * stroke inside the box would be a stroke, or a grab, and there is no way
   * to tell. So drawing has two halves. While the pen is live the page takes
   * strokes and nothing else; once the signature is adopted, what was drawn
   * becomes the same box the saved-signature path uses - dragged, resized by
   * its corners, nudged with the arrow keys.
   *
   * Only the first half existed. Ink landed where it was drawn and stayed
   * there, and the only way to move it a centimetre was to rub it out and
   * draw it again with a steadier hand. Everyone who has not uploaded a
   * signature image signs this way, which in practice is everyone.
   */
  /* Which drawing is on the page. Switching mode or wiping the ink starts a
     new one, and adoption is remembered against the drawing it was given for
     - so the pen comes back by itself when the ink it adopted is gone. Stored
     this way rather than reset through an effect, which would be a render
     showing the old drawing's controls over the new drawing. */
  const inkGeneration = `${drawOnPdf ? 'draw' : 'stamp'}:${inkResetKey}`
  const [adoptedGeneration, setAdoptedGeneration] = useState<string | null>(null)
  const adoptedInk = adoptedGeneration === inkGeneration
  const adoptedInkRef = useRef(adoptedInk)

  /* Set when the drawing had to come up the page to leave room for the block
     under it, which is the one case where adopting moves what was drawn. */
  const [liftedForBlock, setLiftedForBlock] = useState(false)

  /** The pen is live: the page is a drawing surface, not a placement surface. */
  const drawingLive = drawOnPdf && !adoptedInk

  useEffect(() => {
    adoptedInkRef.current = adoptedInk
  }, [adoptedInk])

  /* Recomputed rather than stored: it depends only on what the block will say,
     and the editor must reserve exactly what the backend reserves. */
  const reservedBelow = signoffBlockHeight(signoffPreview)
  const reservedBelowRef = useRef(reservedBelow)

  useEffect(() => {
    reservedBelowRef.current = reservedBelow
  }, [reservedBelow])

  useEffect(() => {
    placementRef.current = placement
  }, [placement])

  useEffect(() => {
    onInkChangeRef.current = onInkChange
  }, [onInkChange])

  useEffect(() => {
    onPlacementRef.current = onPlacement
  }, [onPlacement])

  useEffect(() => {
    currentPageRef.current = currentPage
  }, [currentPage])

  useEffect(() => {
    drawOnPdfRef.current = drawOnPdf
  }, [drawOnPdf])

  const redrawInkStrokes = useCallback((ctx: CanvasRenderingContext2D, metrics: PdfPageMetrics) => {
    ctx.clearRect(0, 0, metrics.displayWidth, metrics.displayHeight)
    for (const stroke of strokesRef.current) {
      if (stroke.length === 0) continue
      ctx.beginPath()
      ctx.moveTo(stroke[0].x * metrics.displayWidth, stroke[0].y * metrics.displayHeight)
      for (let i = 1; i < stroke.length; i += 1) {
        ctx.lineTo(stroke[i].x * metrics.displayWidth, stroke[i].y * metrics.displayHeight)
      }
      if (stroke.length === 1) {
        ctx.lineTo(
          stroke[0].x * metrics.displayWidth + 0.01,
          stroke[0].y * metrics.displayHeight,
        )
      }
      ctx.stroke()
    }
  }, [])

  const setupInkCanvas = useCallback(() => {
    const canvas = inkCanvasRef.current
    const metrics = metricsRef.current
    if (!canvas || !metrics || !drawOnPdfRef.current) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = metrics.displayWidth * dpr
    canvas.height = metrics.displayHeight * dpr
    canvas.style.width = `${metrics.displayWidth}px`
    canvas.style.height = `${metrics.displayHeight}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    configureInkContext(ctx, dpr)
    redrawInkStrokes(ctx, metrics)
  }, [redrawInkStrokes])

  const emitInk = useCallback(() => {
    const canvas = inkCanvasRef.current
    const metrics = metricsRef.current
    if (!canvas || !metrics) return

    if (!drawOnPdfRef.current) return

    const cropped = cropInkFromCanvas(canvas)
    if (!cropped) {
      onInkChangeRef.current?.(null)
      setLiftedForBlock(false)
      return
    }

    onInkChangeRef.current?.(cropped.dataUrl)

    const rect = [
      cropped.left,
      cropped.top,
      cropped.width,
      cropped.height,
      metrics.displayWidth,
      metrics.displayHeight,
      metrics.pdfWidth,
      metrics.pdfHeight,
      currentPageRef.current,
    ] as const

    /* Where it would sit if nothing were drawn under it, so the two can be
       compared. A drawing along the bottom edge has to come up to leave room
       for the block, and it will visibly move when it is adopted - which is
       a surprise unless somebody says why. */
    const whereItWasDrawn = screenRectToPdfPlacement(...rect, 0)
    const nextPlacement = screenRectToPdfPlacement(
      cropped.left,
      cropped.top,
      cropped.width,
      cropped.height,
      metrics.displayWidth,
      metrics.displayHeight,
      metrics.pdfWidth,
      metrics.pdfHeight,
      currentPageRef.current,
      /* Ink gets the same reservation a dropped stamp gets. Without it a
         signature drawn along the bottom edge left no room for the block
         naming the signer, and the backend moved it up to fit - so it was
         filed somewhere other than where it was drawn. */
      reservedBelowRef.current,
    )

    setLiftedForBlock(nextPlacement.signatureY < whereItWasDrawn.signatureY - 0.5)
    onPlacementRef.current?.(nextPlacement, metrics)
  }, [])

  /** Commit a placement to the caller and to the overlay, in one place. */
  const commitPlacement = useCallback((next: PdfPlacement, metrics: PdfPageMetrics) => {
    placementRef.current = next
    onPlacementRef.current?.(next, metrics)
    setScreenPlacement(
      pdfPlacementToScreen(
        next,
        metrics.displayWidth,
        metrics.displayHeight,
        metrics.pdfWidth,
        metrics.pdfHeight,
      ),
    )
  }, [])

  const clearInk = useCallback((notify: boolean) => {
    strokesRef.current = []
    drawingRef.current = false
    const canvas = inkCanvasRef.current
    const metrics = metricsRef.current
    if (canvas && metrics) {
      const ctx = canvas.getContext('2d')
      ctx?.clearRect(0, 0, metrics.displayWidth, metrics.displayHeight)
    }
    /* Not once the ink has been adopted: the canvas is gone by then and the
       cropped image is the signature, so wiping it here would take away a
       signature the person has already placed - by turning a page. */
    if (notify && drawOnPdfRef.current && !adoptedInkRef.current) {
      onInkChangeRef.current?.(null)
    }
  }, [])

  // Keep the overlay in sync when placement changes — do NOT re-render the PDF canvas.
  useEffect(() => {
    const metrics = metricsRef.current
    if (!metrics) return

    if (placement && placement.page === currentPage) {
      setScreenPlacement(
        pdfPlacementToScreen(
          placement,
          metrics.displayWidth,
          metrics.displayHeight,
          metrics.pdfWidth,
          metrics.pdfHeight,
        ),
      )
    } else {
      setScreenPlacement(null)
    }
  }, [placement, currentPage])

  useEffect(() => {
    if (!file) return

    let cancelled = false

    file.arrayBuffer()
      .then(buffer => pdfjs.getDocument({ data: buffer }).promise)
      .then(doc => {
        if (cancelled) return
        setLoadedDoc({ file, doc, error: null })
        setInternalPage(1)
      })
      .catch(() => {
        if (cancelled) return
        setLoadedDoc({ file, doc: null, error: 'Failed to load PDF' })
        setInternalPage(1)
      })

    return () => {
      cancelled = true
    }
  }, [file])

  const renderPage = useCallback(async () => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container || !pdfDoc) return

    renderTaskRef.current?.cancel()
    renderTaskRef.current = null

    const page = await pdfDoc.getPage(currentPage)
    const baseViewport = page.getViewport({ scale: 1 })
    const containerWidth = container.clientWidth
    /* 100% is the page fitted to the panel, which is what this viewer has
       always shown; the zoom multiplies that. Every other size in here stays
       in PDF points, so this scale never reaches a stored coordinate. */
    const scale = (containerWidth / baseViewport.width) * zoom
    const viewport = page.getViewport({ scale })

    const dpr = window.devicePixelRatio || 1
    canvas.width = viewport.width * dpr
    canvas.height = viewport.height * dpr
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const task = page.render({ canvasContext: ctx, viewport, canvas })
    renderTaskRef.current = task

    try {
      await task.promise
    } catch (err) {
      // Cancelled renders throw; ignore those so resize/page changes don't show an error.
      if ((err as { name?: string } | null)?.name === 'RenderingCancelledException') {
        return
      }
      throw err
    } finally {
      if (renderTaskRef.current === task) {
        renderTaskRef.current = null
      }
    }

    const metrics: PdfPageMetrics = {
      pdfWidth: baseViewport.width,
      pdfHeight: baseViewport.height,
      displayWidth: viewport.width,
      displayHeight: viewport.height,
    }
    metricsRef.current = metrics
    setPageSize({ width: metrics.pdfWidth, height: metrics.pdfHeight })

    const currentPlacement = placementRef.current
    if (currentPlacement && currentPlacement.page === currentPage) {
      setScreenPlacement(
        pdfPlacementToScreen(
          currentPlacement,
          metrics.displayWidth,
          metrics.displayHeight,
          metrics.pdfWidth,
          metrics.pdfHeight,
        ),
      )
    } else {
      setScreenPlacement(null)
    }

    setupInkCanvas()
  }, [pdfDoc, currentPage, zoom, setupInkCanvas])

  useEffect(() => {
    let cancelled = false
    renderPage().catch(() => {
      if (!cancelled) setRenderError({ file, message: 'Failed to render page' })
    })
    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
    }
  }, [renderPage, file])

  useEffect(() => {
    const handleWindowResize = () => {
      renderPage().catch(() => undefined)
    }
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [renderPage])

  useEffect(() => {
    clearInk(true)
    setupInkCanvas()
  }, [currentPage, inkResetKey, clearInk, setupInkCanvas])

  useEffect(() => {
    if (!drawingLive) {
      drawingRef.current = false
      return
    }
    setupInkCanvas()
  }, [drawingLive, setupInkCanvas])

  const placeSignatureAtPoint = (
    clientX: number,
    clientY: number,
  ) => {
    if (!placementMode || drawingLive || !onPlacement || !metricsRef.current) return

    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const clickX = clientX - rect.left
    const clickY = clientY - rect.top
    const { pdfWidth, pdfHeight, displayWidth, displayHeight } = metricsRef.current

    /* The size already chosen is carried over. Dropping it somewhere else is a
       move, not a fresh start, and handing back the default box here is what
       made every nudge after a resize undo the resize. A placement on another
       page is a fresh one, so its size does not follow it across. */
    const existing = placementRef.current
    const keepSize = existing && existing.page === currentPage

    const pdfPlacement = clickToPdfPlacement(
      clickX,
      clickY,
      displayWidth,
      displayHeight,
      pdfWidth,
      pdfHeight,
      {
        page: currentPage,
        width: keepSize ? existing.signatureWidth : undefined,
        height: keepSize ? existing.signatureHeight : undefined,
        reservedBelow: reservedBelowRef.current,
      },
    )

    commitPlacement(pdfPlacement, metricsRef.current)
  }

  const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (drawingLive || resizeSessionRef.current) return
    placeSignatureAtPoint(event.clientX, event.clientY)
  }

  const getInkPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = inkCanvasRef.current
    const metrics = metricsRef.current
    if (!canvas || !metrics) return null
    const rect = canvas.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    return {
      cssX: x,
      cssY: y,
      nx: metrics.displayWidth > 0 ? x / metrics.displayWidth : 0,
      ny: metrics.displayHeight > 0 ? y / metrics.displayHeight : 0,
    }
  }

  const handleInkPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingLive) return
    event.preventDefault()
    const canvas = inkCanvasRef.current
    const ctx = canvas?.getContext('2d')
    const point = getInkPoint(event)
    if (!canvas || !ctx || !point) return

    drawingRef.current = true
    canvas.setPointerCapture(event.pointerId)
    strokesRef.current.push([{ x: point.nx, y: point.ny }])
    ctx.beginPath()
    ctx.moveTo(point.cssX, point.cssY)
  }

  const handleInkPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return
    const canvas = inkCanvasRef.current
    const ctx = canvas?.getContext('2d')
    const point = getInkPoint(event)
    if (!canvas || !ctx || !point) return

    const stroke = strokesRef.current[strokesRef.current.length - 1]
    stroke?.push({ x: point.nx, y: point.ny })
    ctx.lineTo(point.cssX, point.cssY)
    ctx.stroke()
  }

  const finishInkStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return
    drawingRef.current = false
    const canvas = inkCanvasRef.current
    canvas?.releasePointerCapture(event.pointerId)
    emitInk()
  }

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!allowSignatureDrop) return
    if (!event.dataTransfer.types.includes('application/x-docflow-signature')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!allowSignatureDrop) return
    if (!event.dataTransfer.getData('application/x-docflow-signature')) return
    event.preventDefault()
    placeSignatureAtPoint(event.clientX, event.clientY)
  }

  const applyResizeFromClientPoint = useCallback((
    handle: ResizeHandle,
    clientX: number,
    clientY: number,
  ) => {
    const current = placementRef.current
    const metrics = metricsRef.current
    const canvas = canvasRef.current
    if (!current || !metrics || !canvas || !onPlacement) return

    const rect = canvas.getBoundingClientRect()
    const { x, y } = screenPointToPdf(
      clientX - rect.left,
      clientY - rect.top,
      metrics.displayWidth,
      metrics.displayHeight,
      metrics.pdfWidth,
      metrics.pdfHeight,
    )

    const next = resizePdfPlacement(
      current,
      handle,
      x,
      y,
      metrics.pdfWidth,
      metrics.pdfHeight,
      true,
      reservedBelowRef.current,
    )

    commitPlacement(next, metrics)
  }, [onPlacement, commitPlacement])

  /**
   * Dragging the placed signature.
   *
   * This is what was missing. The overlay swallowed its pointer events and did
   * nothing with them, so the only way to move a signature was to click
   * somewhere else on the page - which re-placed it at the default size, and
   * could not reach anywhere underneath the box at all, because those clicks
   * were the ones being swallowed.
   */
  const handleOverlayPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!placementMode || drawingLive) return

    const current = placementRef.current
    const metrics = metricsRef.current
    const canvas = canvasRef.current
    if (!current || !metrics || !canvas) return

    event.preventDefault()
    event.stopPropagation()

    const rect = canvas.getBoundingClientRect()
    const pointer = screenPointToPdf(
      event.clientX - rect.left,
      event.clientY - rect.top,
      metrics.displayWidth,
      metrics.displayHeight,
      metrics.pdfWidth,
      metrics.pdfHeight,
    )

    dragSessionRef.current = {
      pointerId: event.pointerId,
      grabOffsetPdfX: pointer.x - current.signatureX,
      grabOffsetPdfY: pointer.y - current.signatureY,
      moved: false,
    }

    // Suppress text selection and page scroll for the length of the drag; both
    // are put back when the pointer is released or cancelled.
    document.body.style.userSelect = 'none'
    document.body.style.touchAction = 'none'

    const onMove = (moveEvent: PointerEvent) => {
      const session = dragSessionRef.current
      const liveMetrics = metricsRef.current
      const live = placementRef.current
      const liveCanvas = canvasRef.current
      if (!session || session.pointerId !== moveEvent.pointerId) return
      if (!liveMetrics || !live || !liveCanvas) return

      moveEvent.preventDefault()
      session.moved = true

      const liveRect = liveCanvas.getBoundingClientRect()
      const to = screenPointToPdf(
        moveEvent.clientX - liveRect.left,
        moveEvent.clientY - liveRect.top,
        liveMetrics.displayWidth,
        liveMetrics.displayHeight,
        liveMetrics.pdfWidth,
        liveMetrics.pdfHeight,
      )

      // Where the box's origin should be, expressed as a delta so the move and
      // the clamp are the same ones the keyboard path uses.
      const next = movePdfPlacement(
        live,
        to.x - session.grabOffsetPdfX - live.signatureX,
        to.y - session.grabOffsetPdfY - live.signatureY,
        liveMetrics.pdfWidth,
        liveMetrics.pdfHeight,
        reservedBelowRef.current,
      )

      commitPlacement(next, liveMetrics)
    }

    const onUp = (upEvent: PointerEvent) => {
      const session = dragSessionRef.current
      if (!session || session.pointerId !== upEvent.pointerId) return
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      dragSessionRef.current = null
      document.body.style.userSelect = ''
      document.body.style.touchAction = ''
    }

    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  /**
   * Moving and resizing from the keyboard.
   *
   * The handles were buttons that only ever listened for a pointer, so a
   * keyboard user could reach them and then do nothing with them. Arrows move
   * by a point, Shift by ten, and +/- resize about the top-left corner.
   */
  const handleOverlayKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!placementMode || drawingLive) return

    const current = placementRef.current
    const metrics = metricsRef.current
    if (!current || !metrics) return

    const step = event.shiftKey ? NUDGE_PDF_FAST : NUDGE_PDF
    let deltaX = 0
    let deltaY = 0

    switch (event.key) {
      case 'ArrowLeft':
        deltaX = -step
        break
      case 'ArrowRight':
        deltaX = step
        break
      case 'ArrowUp':
        deltaY = -step
        break
      case 'ArrowDown':
        deltaY = step
        break
      case '+':
      case '=':
      case '-':
      case '_': {
        event.preventDefault()
        const grow = event.key === '+' || event.key === '='
        const aspect =
          current.signatureHeight > 0
            ? current.signatureWidth / current.signatureHeight
            : 1
        const nextWidth = current.signatureWidth + (grow ? RESIZE_STEP_PDF : -RESIZE_STEP_PDF)
        // Through the same corner maths as a pointer resize, so the limits and
        // the aspect lock cannot drift apart from the mouse path.
        commitPlacement(
          resizePdfPlacement(
            current,
            'se',
            current.signatureX + nextWidth,
            current.signatureY + nextWidth / aspect,
            metrics.pdfWidth,
            metrics.pdfHeight,
            true,
            reservedBelowRef.current,
          ),
          metrics,
        )
        return
      }
      case 'Delete':
      case 'Backspace':
        if (onRemovePlacement) {
          event.preventDefault()
          onRemovePlacement()
        }
        return
      default:
        return
    }

    event.preventDefault()
    commitPlacement(
      movePdfPlacement(
        current,
        deltaX,
        deltaY,
        metrics.pdfWidth,
        metrics.pdfHeight,
        reservedBelowRef.current,
      ),
      metrics,
    )
  }

  const endResizeSession = useCallback(() => {
    resizeSessionRef.current = null
    document.body.style.userSelect = ''
    document.body.style.touchAction = ''
  }, [])

  const handleResizePointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
    handle: ResizeHandle,
  ) => {
    if (!placementMode || !placement || drawingLive) return
    event.preventDefault()
    event.stopPropagation()

    const pointerId = event.pointerId
    resizeSessionRef.current = { handle, pointerId }
    // Suppress text selection and scroll for the duration of the drag; both
    // are restored when the pointer is released. The rule reads `document` as
    // a mutable value captured from an outer scope, but this is ordinary DOM
    // work inside an event handler — moving it into an effect would mean the
    // page could still be selected during the first frames of a resize.
    /* eslint-disable react-hooks/immutability */
    document.body.style.userSelect = 'none'
    document.body.style.touchAction = 'none'
    /* eslint-enable react-hooks/immutability */

    const onMove = (moveEvent: PointerEvent) => {
      const session = resizeSessionRef.current
      if (!session || session.pointerId !== moveEvent.pointerId) return
      moveEvent.preventDefault()
      applyResizeFromClientPoint(session.handle, moveEvent.clientX, moveEvent.clientY)
    }

    const onUp = (upEvent: PointerEvent) => {
      const session = resizeSessionRef.current
      if (!session || session.pointerId !== upEvent.pointerId) return
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      endResizeSession()
    }

    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // Clean up if the viewer unmounts mid-drag.
  useEffect(() => {
    return () => {
      endResizeSession()
    }
  }, [endResizeSession])

  if (!file) {
    return (
      <div className="flex items-center justify-center min-h-[320px] text-ui text-content-muted">
        No document loaded
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[320px] gap-2 text-ui text-content-muted">
        <Loader2 size={18} className="animate-spin text-accent-ink" />
        Loading PDF...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[320px] text-ui text-danger-ink">
        {error}
      </div>
    )
  }

  return (
    <div>
      {pageCount > 1 && (
        <div className="flex items-center justify-between mb-3">
          <button
            type="button"
            disabled={currentPage <= 1}
            onClick={() => goToPage(currentPage - 1)}
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-line text-meta text-content-muted disabled:opacity-40"
          >
            <ChevronLeft size={14} />
            Previous
          </button>
          <span className="text-meta text-content-muted">
            Page {currentPage} of {pageCount}
          </span>
          <button
            type="button"
            disabled={currentPage >= pageCount}
            onClick={() => goToPage(currentPage + 1)}
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-line text-meta text-content-muted disabled:opacity-40"
          >
            Next
            <ChevronRight size={14} />
          </button>
        </div>
      )}

      {placementMode && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-meta font-medium text-accent-ink">
            {drawingLive
              ? (placementHint ?? 'Draw your signature on the document')
              : (drawOnPdf
                  ? 'Now drag it where it belongs, or resize it by a corner'
                  : (placementHint
                      ?? 'Click to place your signature, then drag it into position'))}
          </p>

          <div className="flex items-center gap-1.5">
            <label htmlFor={zoomId} className="text-meta text-content-muted">
              Zoom
            </label>
            <select
              id={zoomId}
              value={zoom}
              onChange={event => setZoom(Number(event.target.value))}
              className="rounded-control border border-line bg-surface px-1.5 py-0.5 text-meta text-content"
            >
              {ZOOM_STEPS.map(step => (
                <option key={step} value={step}>
                  {Math.round(step * 100)}%
                </option>
              ))}
            </select>
            {/* Offered only once there is ink to adopt. Pressing it hands the
                drawing over to the placement controls; until then the page
                belongs to the pen, because a stroke and a grab cannot share
                one surface. */}
            {drawingLive && placement && (
              <button
                type="button"
                onClick={() => setAdoptedGeneration(inkGeneration)}
                className="rounded-control border border-accent bg-accent-soft px-2 py-0.5 text-meta font-medium text-accent-ink transition-colors hover:bg-accent hover:text-on-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Done — adjust placement
              </button>
            )}
            {placement && onRemovePlacement && (
              <button
                type="button"
                onClick={onRemovePlacement}
                className="rounded-control border border-line px-2 py-0.5 text-meta text-content-muted transition-colors hover:bg-sunken hover:text-content"
              >
                Remove signature
              </button>
            )}
          </div>
        </div>
      )}

      {placementMode && !drawingLive && placement && (
        <p className="mb-2 text-meta text-content-subtle">
          Drag the signature to move it, or select it and use the arrow keys.
          Drag a corner, or press + and −, to resize.
        </p>
      )}

      {/* The one case where adopting a drawing moves it. Said while the pen is
          still live, so the move is expected rather than discovered. */}
      {placementMode && drawingLive && liftedForBlock && placement && (
        <p className="mb-2 text-meta text-warning-ink">
          Drawn too close to the bottom edge. It will move up to leave room for
          your name underneath.
        </p>
      )}

      <div
        ref={containerRef}
        className="relative w-full overflow-auto rounded-control border border-line bg-line-soft"
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <div className="relative inline-block">
          <canvas
            ref={canvasRef}
            onClick={handleCanvasClick}
            className={placementMode && !drawingLive ? 'cursor-crosshair' : 'cursor-default'}
          />
          {drawingLive && (
            <canvas
              ref={inkCanvasRef}
              /* Named because it is one of several canvases stacked here and
                 the others arrive as their pages render - anything picking it
                 out by position finds a different one depending on timing. */
              data-testid="pdf-ink-surface"
              className="absolute inset-0 touch-none cursor-crosshair"
              onPointerDown={handleInkPointerDown}
              onPointerMove={handleInkPointerMove}
              onPointerUp={finishInkStroke}
              onPointerLeave={finishInkStroke}
              onPointerCancel={finishInkStroke}
            />
          )}
          {signHere && !placementMode && pageSize && signHere.placement.page === currentPage && (
            <button
              type="button"
              onClick={signHere.onSign}
              aria-label={`Sign here: your line, ${signHere.name}. Opens signing.`}
              className="absolute flex items-center justify-center rounded-control border-2 border-dashed border-accent bg-accent-soft/60 text-meta font-semibold text-accent-ink shadow-sm transition-colors hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              style={{
                left: `${(signHere.placement.signatureX / pageSize.width) * 100}%`,
                top: `${(signHere.placement.signatureY / pageSize.height) * 100}%`,
                width: `${(signHere.placement.signatureWidth / pageSize.width) * 100}%`,
                height: `${(signHere.placement.signatureHeight / pageSize.height) * 100}%`,
                minHeight: 24,
              }}
            >
              <span className="truncate px-1">Sign here</span>
            </button>
          )}
          {!drawingLive && screenPlacement && placement?.page === currentPage && (
            <div
              role={placementMode ? 'group' : undefined}
              aria-label={
                placementMode
                  ? `Signature on page ${placement.page}. Use the arrow keys to move it, plus and minus to resize.`
                  : undefined
              }
              tabIndex={placementMode ? 0 : undefined}
              className={`absolute border-2 border-accent bg-accent-soft/40 overflow-visible focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                placementMode
                  ? 'pointer-events-auto cursor-move touch-none'
                  : 'pointer-events-none'
              }`}
              style={{
                left: screenPlacement.left,
                top: screenPlacement.top,
                width: screenPlacement.width,
                height: screenPlacement.height,
                touchAction: placementMode ? 'none' : undefined,
              }}
              onClick={event => event.stopPropagation()}
              onPointerDown={handleOverlayPointerDown}
              onKeyDown={handleOverlayKeyDown}
            >
              {/* What the backend will draw under the mark. Shown to scale and
                  never interactive: the two move as one block, and somebody
                  placing a signature at the foot of a page has to be able to
                  see that the name goes below it. */}
              {reservedBelow > 0 && placement.signatureHeight > 0 && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute left-0 top-full w-full border-l-2 border-dashed border-accent/50"
                  style={{
                    /* Scaled off the box beside it rather than off the page
                       metrics: the overlay is already in screen units, and the
                       ratio of block to signature is the same in either. */
                    height:
                      screenPlacement.height * (reservedBelow / placement.signatureHeight),
                  }}
                >
                  {signoffPreview?.onOwnLine ? (
                    /* The page prints this person's name already; only a
                       delegate's line is drawn under the mark. */
                    <p className="truncate pt-0.5 text-eyebrow leading-tight text-accent-ink/80">
                      Signed for {signoffPreview.onBehalfOf}
                    </p>
                  ) : (
                    <>
                      <div className="h-px w-full bg-accent/50" />
                      <p className="truncate pt-0.5 text-eyebrow leading-tight text-accent-ink">
                        {signoffPreview?.name}
                      </p>
                      {(signoffPreview?.designation || signoffPreview?.department) && (
                        <p className="truncate text-eyebrow leading-tight text-accent-ink/80">
                          {[signoffPreview?.designation, signoffPreview?.department]
                            .filter(Boolean)
                            .join(', ')}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
              {signaturePreviewUrl && (
                <img
                  src={signaturePreviewUrl}
                  alt="Signature preview"
                  className="w-full h-full object-contain pointer-events-none select-none"
                  draggable={false}
                />
              )}
              {placementMode &&
                RESIZE_HANDLES.map(handle => (
                  <button
                    key={handle.id}
                    type="button"
                    aria-label={`Resize signature ${handle.id}`}
                    className={`absolute z-20 flex items-center justify-center w-11 h-11 sm:w-7 sm:h-7 touch-none select-none ${handle.className}`}
                    style={{ cursor: handle.cursor, touchAction: 'none' }}
                    onPointerDown={event => handleResizePointerDown(event, handle.id)}
                  >
                    <span className="block w-3.5 h-3.5 sm:w-3 sm:h-3 rounded-control bg-surface border-2 border-accent shadow-card pointer-events-none" />
                  </button>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
