// src/components/ScoreOSMD.tsx
"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

/* Props */
type Props = {
  src: string;
  fillParent?: boolean;   // occupy parent height
  height?: number;        // if not fillParent
  className?: string;
  style?: React.CSSProperties;
  allowScroll?: boolean;  // keep false (we page with wheel/keys)
};

/* Types */
type Band = { top: number; bottom: number; height: number };
type OSMDWithLifecycle = OpenSheetMusicDisplay & { clear?: () => void; dispose?: () => void };

/* ---------- Constants ---------- */
const CONTROLS_H = 44;           // fixed bottom bar height (px)
const OVERLAP_PX = 4;            // bottom mask overlap
const GAP_PX = 18;               // cluster gap for grouping <g> into systems
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.01;
const ZOOM_DEBOUNCE_MS = 180;

/* ---------- Helpers ---------- */

/** wait two paints (type-safe for RAF) */
const afterPaint = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });

const isPromise = (x: unknown): x is Promise<unknown> =>
  typeof x === "object" && x !== null && typeof (x as { then?: unknown }).then === "function";

function getSvg(outer: HTMLDivElement): SVGSVGElement | null {
  return outer.querySelector("svg");
}

/** Measure “bands” (systems) by clustering visible <g> blocks — this was your stable method */
function measureSystemsPxByClusters(outer: HTMLDivElement): Band[] {
  const svg = getSvg(outer);
  if (!svg) return [];

  const hostTop = outer.getBoundingClientRect().top;
  type Box = { top: number; bottom: number; height: number; width: number };
  const boxes: Box[] = [];

  // Look under page roots if present, or the whole svg
  const pageRoots = Array.from(
    svg.querySelectorAll<SVGGElement>(
      'g[id^="osmdCanvasPage"], g[id^="Page"], g[class*="Page"], g[class*="page"]'
    )
  );
  const roots: Array<SVGGElement | SVGSVGElement> = pageRoots.length ? pageRoots : [svg];

  for (const root of roots) {
    for (const g of Array.from(root.querySelectorAll<SVGGElement>("g"))) {
      const r = g.getBoundingClientRect();
      if (!Number.isFinite(r.top) || !Number.isFinite(r.height) || !Number.isFinite(r.width)) continue;
      if (r.height < 8 || r.width < 40) continue; // ignore tiny artifacts
      boxes.push({ top: r.top - hostTop, bottom: r.bottom - hostTop, height: r.height, width: r.width });
    }
  }

  boxes.sort((a, b) => a.top - b.top);

  const bands: Band[] = [];
  for (const b of boxes) {
    const last = bands[bands.length - 1];
    if (!last || b.top - last.bottom > GAP_PX) {
      bands.push({ top: b.top, bottom: b.bottom, height: b.height });
    } else {
      last.top = Math.min(last.top, b.top);
      last.bottom = Math.max(last.bottom, b.bottom);
      last.height = last.bottom - last.top;
    }
  }
  return bands;
}

/** Compute page start *indices* so each page shows only full systems */
function computePageStartIndices(bands: Band[], viewportH: number): number[] {
  if (!bands.length || viewportH <= 0) return [0];
  const starts: number[] = [];
  let i = 0;
  while (i < bands.length) {
    const startTop = bands[i].top;
    let last = i;
    while (last + 1 < bands.length && bands[last + 1].bottom - startTop <= viewportH) last++;
    starts.push(i);
    i = last + 1;
  }
  return starts.length ? starts : [0];
}

/* ---------- Component ---------- */

export default function ScoreOSMD({
  src,
  fillParent = false,
  height = 600,
  className = "",
  style,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMDWithLifecycle | null>(null);

  // Layout model (refs)
  const bandsRef = useRef<Band[]>([]);
  const pageStartsRef = useRef<number[]>([0]); // indices into bands
  const pageIdxRef = useRef<number>(0);        // current page index

  // Guards
  const readyRef = useRef<boolean>(false);
  const isZoomingRef = useRef<boolean>(false);
  const resizeObsRef = useRef<ResizeObserver | null>(null);

  // HUD
  const [hud, setHud] = useState({ page: 1, pages: 1, zoomPct: 100 });

  // Zoom
  const [zoom, setZoom] = useState<number>(1.0);     // 1.00 = 100%
  const zoomApplyTimerRef = useRef<number | null>(null);

  /** Available vertical space = wrapper height minus fixed controls bar height */
  const getAvailableHeight = useCallback((): number => {
    const outer = wrapRef.current;
    if (!outer) return 0;
    return Math.max(0, outer.clientHeight - CONTROLS_H);
  }, []);

  const getMaskEl = useCallback(
    (): HTMLDivElement | null =>
      wrapRef.current?.querySelector<HTMLDivElement>("[data-osmd-mask='1']") ?? null,
    []
  );

  const ensureMask = useCallback((): HTMLDivElement | null => {
    const outer = wrapRef.current;
    if (!outer) return null;
    let mask = getMaskEl();
    if (!mask) {
      mask = document.createElement("div");
      mask.dataset.osmdMask = "1";
      Object.assign(mask.style, {
        position: "absolute",
        left: "0",
        right: "0",
        top: "0",
        bottom: "0",
        background: "#fff",
        pointerEvents: "none",
        zIndex: "5",
        display: "block",
      } as CSSStyleDeclaration);
      outer.appendChild(mask);
    }
    return mask;
  }, [getMaskEl]);

  /** Apply a page index: translate SVG & mask bottom so no partial next line shows */
  const applyPage = useCallback(
    (pageIdx: number) => {
      const outer = wrapRef.current;
      if (!outer) return;
      const svg = getSvg(outer);
      if (!svg) return;

      const bands = bandsRef.current;
      const starts = pageStartsRef.current;
      if (!bands.length || !starts.length) return;

      const pages = starts.length;
      const clampedPage = Math.max(0, Math.min(pageIdx, pages - 1));
      pageIdxRef.current = clampedPage;

      const startIndex = starts[clampedPage];
      const startTop = bands[startIndex].top;

      const nextStartIndex = clampedPage + 1 < starts.length ? starts[clampedPage + 1] : -1;

      // Snap first visible system to top
      const ySnap = Math.ceil(startTop);
      svg.style.transform = `translateY(${-ySnap}px)`;
      svg.style.willChange = "transform";

      // Bottom mask: from top of next page's first system (minus tiny overlap)
      const availH = getAvailableHeight();
      const maskTopPx = (() => {
        if (nextStartIndex < 0) return availH;
        const nextTopRel = bands[nextStartIndex].top - startTop;
        return Math.min(availH - 1, Math.max(0, Math.ceil(nextTopRel - OVERLAP_PX)));
      })();

      const mask = ensureMask();
      if (mask) {
        mask.style.display = "block";
        mask.style.top = `${maskTopPx}px`;
      }

      // HUD
      setHud({ page: clampedPage + 1, pages, zoomPct: Math.round(zoom * 100) });
    },
    [ensureMask, getAvailableHeight, zoom]
  );

  /** Recompute pagination when only height changed (keep current page if possible) */
  const recomputePaginationHeightOnly = useCallback(() => {
    if (isZoomingRef.current) return;
    const bands = bandsRef.current;
    if (!bands.length) return;

    const availH = getAvailableHeight();
    if (availH < 40) return;

    const starts = computePageStartIndices(bands, availH);
    const oldStarts = pageStartsRef.current;
    pageStartsRef.current = starts;

    // keep same page by nearest start index
    const oldPage = pageIdxRef.current;
    const oldStartIdx = oldStarts[Math.max(0, Math.min(oldPage, oldStarts.length - 1))] ?? 0;

    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < starts.length; i++) {
      const d = Math.abs(starts[i] - oldStartIdx);
      if (d < best) { best = d; nearest = i; }
    }
    applyPage(nearest);
  }, [applyPage, getAvailableHeight]);

  /** Full reflow: width change → re-render OSMD, re-measure bands, recompute pages, keep nearest */
  const reflowOnWidthChange = useCallback(async () => {
    if (isZoomingRef.current) return;
    const outer = wrapRef.current;
    const osmd = osmdRef.current;
    if (!outer || !osmd) return;

    // Remember which system index was at the top (by current page start index)
    const oldStarts = pageStartsRef.current;
    const oldPage = pageIdxRef.current;
    const oldTopSystem = oldStarts[Math.max(0, Math.min(oldPage, oldStarts.length - 1))] ?? 0;

    osmd.render();
    await afterPaint();
    await afterPaint();

    // Robustly wait until bands are measurable
    let tries = 0;
    let bands: Band[] = [];
    do {
      bands = measureSystemsPxByClusters(outer);
      if (bands.length) break;
      await afterPaint();
      tries++;
    } while (tries < 8);

    if (!bands.length) return;
    bandsRef.current = bands;

    const availH = getAvailableHeight();
    if (availH < 40) return;

    const newStarts = computePageStartIndices(bands, availH);
    pageStartsRef.current = newStarts;

    // Find page whose start system index is closest to the previous top system
    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < newStarts.length; i++) {
      const d = Math.abs(newStarts[i] - oldTopSystem);
      if (d < best) { best = d; nearest = i; }
    }
    applyPage(nearest);
  }, [applyPage, getAvailableHeight]);

  /** Init OSMD and first layout */
  useEffect(() => {
    let lastW = -1;
    let lastH = -1;

    (async () => {
      const host = hostRef.current;
      const outer = wrapRef.current;
      if (!host || !outer) return;

      const { OpenSheetMusicDisplay } =
        (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");

      // Fresh OSMD
      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }
      const osmd = new OpenSheetMusicDisplay(host, {
        backend: "svg" as const,
        autoResize: false, // we control when to render
        drawTitle: true,
        drawSubtitle: true,
        drawComposer: true,
        drawLyricist: true,
      }) as OSMDWithLifecycle;
      osmdRef.current = osmd;

      const maybe = osmd.load(src);
      if (isPromise(maybe)) await maybe;
      osmd.render();
      await afterPaint();

      // Initial measure (robust)
      let tries = 0;
      let bands: Band[] = [];
      do {
        bands = measureSystemsPxByClusters(outer);
        if (bands.length) break;
        await afterPaint();
        tries++;
      } while (tries < 8);

      if (!bands.length) return;

      bandsRef.current = bands;

      // Pages & first page
      pageStartsRef.current = computePageStartIndices(bands, getAvailableHeight());
      pageIdxRef.current = 0;
      setHud((h) => ({ ...h, zoomPct: Math.round(zoom * 100) }));
      applyPage(0);

      readyRef.current = true;

      // Observe wrapper size; only re-render on width changes; height triggers pagination only.
      const obs = new ResizeObserver(() => {
        if (!readyRef.current || isZoomingRef.current) return;
        const outerNow = wrapRef.current;
        if (!outerNow) return;
        const w = outerNow.clientWidth;
        const h = outerNow.clientHeight;

        const widthChanged = lastW !== -1 && Math.abs(w - lastW) >= 1;
        const heightChanged = lastH !== -1 && Math.abs(h - lastH) >= 1;

        lastW = w;
        lastH = h;

        if (widthChanged) {
          reflowOnWidthChange();
        } else if (heightChanged) {
          recomputePaginationHeightOnly();
        }
      });
      obs.observe(outer);
      resizeObsRef.current = obs;
      // initialize lastW/H
      lastW = outer.clientWidth;
      lastH = outer.clientHeight;
    })().catch(() => {});

    return () => {
      resizeObsRef.current?.disconnect();
      resizeObsRef.current = null;
      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }
      if (zoomApplyTimerRef.current) {
        clearTimeout(zoomApplyTimerRef.current);
        zoomApplyTimerRef.current = null;
      }
    };
  }, [applyPage, getAvailableHeight, recomputePaginationHeightOnly, reflowOnWidthChange, src]); // NO zoom here

  /** Wheel/keyboard paging */
  const goNext = useCallback(() => {
    const pages = pageStartsRef.current.length;
    if (!pages) return;
    const next = Math.min(pageIdxRef.current + 1, pages - 1);
    if (next !== pageIdxRef.current) applyPage(next);
  }, [applyPage]);

  const goPrev = useCallback(() => {
    const prev = Math.max(pageIdxRef.current - 1, 0);
    if (prev !== pageIdxRef.current) applyPage(prev);
  }, [applyPage]);

  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!readyRef.current) return;
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      e.preventDefault();
      if (e.deltaY > 0) goNext();
      else goPrev();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!readyRef.current) return;
      if (["PageDown", "ArrowDown", " "].includes(e.key)) { e.preventDefault(); goNext(); }
      else if (["PageUp", "ArrowUp"].includes(e.key)) { e.preventDefault(); goPrev(); }
      else if (e.key === "Home") { e.preventDefault(); applyPage(0); }
      else if (e.key === "End") {
        e.preventDefault();
        const last = Math.max(0, pageStartsRef.current.length - 1);
        applyPage(last);
      }
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [applyPage, goNext, goPrev]);

  /** Zoom: minimal & safe — debounce, re-engrave, measure via clusters, only commit if valid */
  const scheduleApplyZoom = useCallback(
    (value: number) => {
      const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value));
      setZoom(clamped);
      setHud((h) => ({ ...h, zoomPct: Math.round(clamped * 100) }));

      if (zoomApplyTimerRef.current) {
        clearTimeout(zoomApplyTimerRef.current);
        zoomApplyTimerRef.current = null;
      }

      zoomApplyTimerRef.current = window.setTimeout(async () => {
        const osmd = osmdRef.current;
        const outer = wrapRef.current;
        if (!osmd || !outer) return;

        // transactional zoom
        isZoomingRef.current = true;
        resizeObsRef.current?.disconnect(); // silence resize during zoom
        const mask = getMaskEl();
        if (mask) mask.style.display = "none"; // avoid white overlay mid-zoom

        // remember current top system by page start
        const oldStarts = pageStartsRef.current;
        const oldPage = pageIdxRef.current;
        const oldTopSystem = oldStarts[Math.max(0, Math.min(oldPage, oldStarts.length - 1))] ?? 0;

        osmd.zoom = clamped;
        osmd.render();

        // wait until bands measurable at new zoom
        let tries = 0;
        let bands: Band[] = [];
        do {
          await afterPaint();
          bands = measureSystemsPxByClusters(outer);
          if (bands.length) break;
          tries++;
        } while (tries < 8);

        if (!bands.length) {
          // abort safely (keep previous pagination)
          if (mask) mask.style.display = "block";
          if (wrapRef.current) {
            const ro = new ResizeObserver(() => {
              if (isZoomingRef.current) return;
              recomputePaginationHeightOnly();
            });
            ro.observe(wrapRef.current);
            resizeObsRef.current = ro;
          }
          isZoomingRef.current = false;
          return;
        }

        bandsRef.current = bands;

        const availH = getAvailableHeight();
        if (availH >= 40) {
          const newStarts = computePageStartIndices(bands, availH);
          pageStartsRef.current = newStarts;

          // Snap back to nearest previous system
          let nearest = 0;
          let best = Number.POSITIVE_INFINITY;
          for (let i = 0; i < newStarts.length; i++) {
            const d = Math.abs(newStarts[i] - oldTopSystem);
            if (d < best) { best = d; nearest = i; }
          }
          applyPage(nearest);
        }

        if (mask) mask.style.display = "block";

        if (wrapRef.current) {
          const ro = new ResizeObserver(() => {
            if (isZoomingRef.current) return;
            recomputePaginationHeightOnly();
          });
          ro.observe(wrapRef.current);
          resizeObsRef.current = ro;
        }
        isZoomingRef.current = false;
      }, ZOOM_DEBOUNCE_MS);
    },
    [applyPage, getAvailableHeight, getMaskEl, recomputePaginationHeightOnly]
  );

  /* ---------- Styles ---------- */

  const outerStyle: React.CSSProperties = fillParent
    ? { width: "100%", height: "100%", minHeight: 0, position: "relative", overflow: "hidden", background: "#fff" }
    : { width: "100%", height: height ?? 600, minHeight: height ?? 600, position: "relative", overflow: "hidden", background: "#fff" };

  const hostStyle: React.CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: CONTROLS_H,  // leave room for bottom bar
    overflow: "hidden",  // no native vertical scroll
    minWidth: 0,         // avoid horizontal scrollbar jiggle
  };

  const barStyle: React.CSSProperties = {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: CONTROLS_H,
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "8px 12px",
    background: "linear-gradient(to top, rgba(255,255,255,0.96), rgba(255,255,255,0.9))",
    borderTop: "1px solid #e5e7eb",
    zIndex: 20,
    userSelect: "none",
  };

  const labelStyle: React.CSSProperties = {
    font: "12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Arial",
    color: "#111",
    whiteSpace: "nowrap",
  };

  const sliderStyle: React.CSSProperties = { flex: 1 };

  // Live HUD from refs
  const pages = pageStartsRef.current.length || 1;
  const page = Math.min(pageIdxRef.current + 1, pages);

  return (
    <div ref={wrapRef} className={className} style={{ ...outerStyle, ...style }}>
      <div ref={hostRef} style={hostStyle} />

      {/* Bottom control bar */}
      <div style={barStyle}>
        <div style={labelStyle}>Page {page}/{pages}</div>
        <div style={{ width: 10 }} />
        <div style={labelStyle}>Zoom {hud.zoomPct}%</div>
        <input
          type="range"
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={ZOOM_STEP}
          value={zoom}
          onChange={(e) => scheduleApplyZoom(Number(e.currentTarget.value))}
          style={sliderStyle}
        />
      </div>
    </div>
  );
}
