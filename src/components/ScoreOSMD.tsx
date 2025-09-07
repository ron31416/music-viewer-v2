'use client'

import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  CSSProperties,
} from 'react'
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'

export type ScoreOSMDProps = {
  /** Path (under /public) to MusicXML/MXL file, e.g. "/scores/example.musicxml" */
  src: string
  /** Initial zoom factor (1 = 100%). */
  zoom?: number
  /** Show basic UI controls (Prev / Next / Zoom). */
  showControls?: boolean
  /** Optional extra class on outer wrapper. */
  className?: string
  /** Optional style for the scroll container. */
  style?: CSSProperties
}

export default function ScoreOSMD({
  src,
  zoom = 1,
  showControls = true,
  className = '',
  style,
}: ScoreOSMDProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null)
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [zoomState, setZoomState] = useState(zoom)

  /** Stable cleanup */
  const dispose = useCallback(() => {
    const osmd = osmdRef.current as any
    if (osmd) {
      try {
        osmd.cursor?.hide?.()
      } catch {}
      // If OSMD exposes clear(), call it; otherwise wipe the host node:
      osmd.clear?.()
    }
    if (hostRef.current) hostRef.current.innerHTML = ''
    osmdRef.current = null
  }, [])

  /** Stable scroll helper */
  const centerCursor = useCallback(() => {
    const osmd = osmdRef.current as any
    const el: HTMLElement | undefined = osmd?.cursor?.cursorElement
    if (el?.scrollIntoView) {
      el.scrollIntoView({
        block: 'center',
        inline: 'nearest',
        behavior: 'auto', // 'instant' isn't standard; 'auto' = immediate
      })
    }
  }, [])

  /** Load / reinitialize OSMD when `src` changes */
  useEffect(() => {
    let cancelled = false
    const node = hostRef.current
    if (!node) return

    dispose()

    const osmd = new OpenSheetMusicDisplay(node, {
      backend: 'svg',
      autoResize: false, // we'll handle via ResizeObserver
      drawTitle: true,
      drawPartNames: true,
      drawingParameters: 'compact',
    })
    osmdRef.current = osmd

    ;(async () => {
      setLoading(true)
      setErr(null)
      setReady(false)
      try {
        await osmd.load(src)
        osmd.Zoom = zoomState
        await osmd.render()
        try {
          osmd.cursor.show()
        } catch {}
        if (!cancelled) {
          setReady(true)
          centerCursor()
        }
      } catch (e: any) {
        if (!cancelled) setErr(e?.message ?? String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      dispose()
    }
  }, [src, zoomState, dispose, centerCursor])

  /** If parent changes the `zoom` prop, adopt it */
  useEffect(() => setZoomState(zoom), [zoom])

  /** Apply internal zoom changes */
  useEffect(() => {
    const osmd = osmdRef.current
    if (!osmd) return
    osmd.Zoom = zoomState
    osmd.render()
    centerCursor()
  }, [zoomState, centerCursor])

  /** Observe host size; re-render and re-center */
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const host = hostRef.current
    if (!host) return

    let rafId: number | null = null
    const ro = new ResizeObserver(() => {
      const osmd = osmdRef.current
      if (!osmd) return
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        osmd.Zoom = zoomState
        osmd.render()
        centerCursor()
      })
    })

    ro.observe(host)
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      ro.disconnect()
    }
  }, [zoomState, centerCursor])

  /** Measure-wise navigation */
  const prevMeasure = useCallback(() => {
    const osmd = osmdRef.current as any
    if (!osmd?.cursor) return
    try {
      if (!osmd.cursor.IteratorAtStart()) {
        const start = osmd.cursor.iterator.CurrentMeasureIndex
        let steps = 0
        do {
          osmd.cursor.previous()
          steps++
        } while (osmd.cursor.iterator.CurrentMeasureIndex === start && steps < 64)
      }
    } catch {}
    centerCursor()
  }, [centerCursor])

  const nextMeasure = useCallback(() => {
    const osmd = osmdRef.current as any
    if (!osmd?.cursor) return
    try {
      if (!osmd.cursor.IteratorAtEnd()) {
        const start = osmd.cursor.iterator.CurrentMeasureIndex
        let steps = 0
        do {
          osmd.cursor.next()
          steps++
        } while (osmd.cursor.iterator.CurrentMeasureIndex === start && steps < 64)
      }
    } catch {}
    centerCursor()
  }, [centerCursor])

  const zoomIn = useCallback(() => setZoomState(z => Math.min(3, Number((z + 0.1).toFixed(2)))), [])
  const zoomOut = useCallback(() => setZoomState(z => Math.max(0.4, Number((z - 0.1).toFixed(2)))), [])
  const zoomReset = useCallback(() => setZoomState(1), [])

  return (
    <div className={'flex flex-col gap-2 ' + className}>
      {showControls && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button className="px-3 py-1 rounded-2xl border shadow" onClick={prevMeasure} disabled={!ready} title="Previous measure">
            ◀ Prev
          </button>
          <button className="px-3 py-1 rounded-2xl border shadow" onClick={nextMeasure} disabled={!ready} title="Next measure">
            Next ▶
          </button>
          <span className="mx-2 opacity-70">|</span>
          <button className="px-3 py-1 rounded-2xl border shadow" onClick={zoomOut} disabled={!ready} title="Zoom out">
            −
          </button>
          <button className="px-3 py-1 rounded-2xl border shadow" onClick={zoomReset} disabled={!ready} title="Reset zoom">
            100%
          </button>
          <button className="px-3 py-1 rounded-2xl border shadow" onClick={zoomIn} disabled={!ready} title="Zoom in">
            +
          </button>
          <span className="ml-3 text-xs opacity-70">
            {loading ? 'Loading…' : err ? `Error: ${err}` : ready ? '' : 'Initializing…'}
          </span>
        </div>
      )}

      {/* Give this container a height in the parent (or via style) if you want internal scrolling. */}
      <div ref={hostRef} className="w-full overflow-auto rounded-xl border p-2 bg-white" style={style} />
    </div>
  )
}
