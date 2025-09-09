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
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.01;
const ZOOM_DEBOUNCE_MS = 180;

/* ---------- Helpers ---------- */

/** wait two paints */
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

/** find OSMD systems (lines) and measure them relative to wrapper */
function measureSystemsPx(outer: HTMLDivElement): Band[] {
  const svg = getSvg(outer);
  if (!svg) return [];

  const hostTop = outer.getBoundingClientRect().top;

  // Prefer true system groups
  const sysGroups = Array.from(
    svg.querySelectorAll<SVGGElement>(
      'g[id*="system" i], g[class*="system" i], g[id^="System"], g[id^="system"]'
    )
  );

  const targets: Element[] =
    sysGroups.length > 0
      ? sysGroups
      : Array.from(svg.querySelectorAll<SVGGElement>('g[id*="Page" i], g[class*="page" i]'));

  const bands: Band[] = [];
  for (const el of targets) {
    const r = el.getBoundingClientRect();
    if (!Number.isFinite(r.top) || !Number.isFinite(r.height) || !Number.isFinite(r.width)) continue;
    if (r.height < 12 || r.width < 80) continue; // ignore tiny artifacts
    const top = r.top - hostTop;
    const bottom = r.bottom - hostTop;
    bands.push({ top, bottom, height: bottom - top });
  }

  // If we selected page blocks, merge into lines by gaps
  if (!sysGroups.length && bands.length) {
    bands.sort((a, b) => a.top - b.top);
    const merged: Band[] = [];
    const GAP_PX = 18;
    for (const b of bands) {
      const last = merged[merged.length - 1];
      if (!last || b.top - last.bottom > GAP_PX) merged.push({ ...b });
      else {
        last.bottom = Math.max(last.bottom, b.bottom);
        last.top = Math.min(last.top, b.top);
        last.height = last.bottom - last.top;
      }
    }
    return merged;
  }

  bands.sort((a, b) => a.top - b.top);
  return bands;
}

/** page starts so each page shows only full systems */
function computePageStarts(bands: Band[], viewportH: number): number[] {
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

  // Layout state (in refs to avoid re-renders)
  const bandsRef = useRef<Band[]>([]);
  const pageStartsRef = useRef<number[]>([0]);
  const pageIdxRef = useRef<number>(0);

  // UI state
  const [hud, setHud] = useState({ page: 1, pages: 1, zoomPct: 100 });
  const [zoom, setZoom] = useState<number>(1.0);

  // guards/timers/observers
  const zoomTimerRef = useRef<number | null>(null);
  const isZoomingRef = useRef<boolean>(false);
  const resizeObsRef = useRef<ResizeObserver | null>(null);

  /** available height = wrapper minus controls bar */
  const getAvailH = useCallback((): number => {
    const outer = wrapRef.current;
    return outer ? Math.max(0, outer.clientHeight - CONTROLS_H) : 0;
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

  /** translate SVG & set bottom mask so no partial next line shows */
  const applyPage = useCallback(
    (idx: number) => {
      const outer = wrapRef.current;
      if (!outer) return;
      const svg = getSvg(outer);
      const bands = bandsRef.current;
      const starts = pageStartsRef.current;
      if (!svg || !bands.length || !starts.length) return;

      const pages = starts.length;
      const page = Math.max(0, Math.min(idx, pages - 1));
      pageIdxRef.current = page;

      const startIndex = starts[page];
      const startTop = bands[startIndex].top;
      const ySnap = Math.ceil(startTop);
      svg.style.transform = `translateY(${-ySnap}px)`;
      svg.style.willChange = "transform";

      const nextStartIndex = page + 1 < pages ? starts[page + 1] : -1;
      const availH = getAvailH();
      const maskTopPx =
        nextStartIndex < 0
          ? availH
          : Math.min(
              availH - 1,
              Math.max(0, Math.ceil(bands[nextStartIndex].top - startTop - OVERLAP_PX))
            );

      const mask = ensureMask();
      if (mask) {
        mask.style.display = "block";
        mask.style.top = `${maskTopPx}px`;
      }

      setHud({ page: page + 1, pages, zoomPct: Math.round(zoom * 100) });
    },
    [ensureMask, getAvailH, zoom]
  );

  /** only height changed → recompute pagination; keep nearest page */
  const repaginateHeightOnly = useCallback(() => {
    if (isZoomingRef.current) return;
    const bands = bandsRef.current;
    if (!bands.length) return;
    const availH = getAvailH();
    if (availH < 40) return;

    const newStarts = computePageStarts(bands, availH);
    const oldStarts = pageStartsRef.current;
    const oldPage = pageIdxRef.current;
    const oldStart = oldStarts[Math.max(0, Math.min(oldPage, oldStarts.length - 1))] ?? 0;

    pageStartsRef.current = newStarts;

    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < newStarts.length; i++) {
      const d = Math.abs(newStarts[i] - oldStart);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    applyPage(nearest);
  }, [applyPage, getAvailH]);

  /** width changed → full OSMD render, re-measure, keep place */
  const reflowOnWidthChange = useCallback(async () => {
    if (isZoomingRef.current) return;
    const outer = wrapRef.current;
    const osmd = osmdRef.current;
    if (!outer || !osmd) return;

    const oldStarts = pageStartsRef.current;
    const oldPage = pageIdxRef.current;
    const oldTop = oldStarts[Math.max(0, Math.min(oldPage, oldStarts.length - 1))] ?? 0;

    osmd.render();
    await afterPaint();
    await afterPaint();

    // Wait for systems to be measurable
    let tries = 0;
    let bands: Band[] = [];
    do {
      bands = measureSystemsPx(outer);
      if (bands.length) break;
      await afterPaint();
      tries++;
    } while (tries < 6);

    if (!bands.length) return;

    bandsRef.current = bands;

    const availH = getAvailH();
    if (availH < 40) return;

    const starts = computePageStarts(bands, availH);
    pageStartsRef.current = starts;

    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < starts.length; i++) {
      const d = Math.abs(starts[i] - oldTop);
      if (d < best) { best = d; nearest = i; }
    }
    applyPage(nearest);
  }, [applyPage, getAvailH]);

  /* ---------- Init OSMD once per src ---------- */
  useEffect(() => {
    let lastW = -1;
    let lastH = -1;

    (async () => {
      const outer = wrapRef.current;
      const host = hostRef.current;
      if (!outer || !host) return;

      const { OpenSheetMusicDisplay } =
        (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");

      // fresh instance
      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }

      const osmd = new OpenSheetMusicDisplay(host, {
        backend: "svg",
        autoResize: false,
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

      // Initial measure (wait until systems exist)
      let tries = 0;
      let bands: Band[] = [];
      do {
        bands = measureSystemsPx(outer);
        if (bands.length) break;
        await afterPaint();
        tries++;
      } while (tries < 6);

      if (!bands.length) return; // nothing to show

      bandsRef.current = bands;
      pageStartsRef.current = computePageStarts(bands, getAvailH());
      pageIdxRef.current = 0;
      setHud({ page: 1, pages: pageStartsRef.current.length, zoomPct: Math.round(zoom * 100) });
      applyPage(0);

      // observe size
      const obs = new ResizeObserver(() => {
        if (isZoomingRef.current) return;
        const w = outer.clientWidth;
        const h = outer.clientHeight;
        const widthChanged = lastW !== -1 && Math.abs(w - lastW) >= 1;
        const heightChanged = lastH !== -1 && Math.abs(h - lastH) >= 1;
        lastW = w; lastH = h;
        if (widthChanged) reflowOnWidthChange();
        else if (heightChanged) repaginateHeightOnly();
      });
      obs.observe(outer);
      resizeObsRef.current = obs;
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
      if (zoomTimerRef.current) {
        clearTimeout(zoomTimerRef.current);
        zoomTimerRef.current = null;
      }
    };
  }, [applyPage, getAvailH, reflowOnWidthChange, repaginateHeightOnly, src]); // <-- NO zoom here

  /* ---------- Paging controls (wheel/keys) ---------- */
  const goNext = useCallback(() => {
    const pages = pageStartsRef.current.length;
    const next = Math.min(pageIdxRef.current + 1, pages - 1);
    if (next !== pageIdxRef.current) applyPage(next);
  }, [applyPage]);

  const goPrev = useCallback(() => {
    const prev = Math.max(pageIdxRef.current - 1, 0);
    if (prev !== pageIdxRef.current) applyPage(prev);
  }, [applyPage]);

  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      e.preventDefault();
      if (e.deltaY > 0) goNext(); else goPrev();
    };
    const onKey = (e: KeyboardEvent) => {
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

  /* ---------- Zoom (debounced, transactional) ---------- */
  const scheduleApplyZoom = useCallback(
    (value: number) => {
      const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value));
      setZoom(clamped);
      setHud((h) => ({ ...h, zoomPct: Math.round(clamped * 100) }));

      if (zoomTimerRef.current) {
        clearTimeout(zoomTimerRef.current);
        zoomTimerRef.current = null;
      }

      zoomTimerRef.current = window.setTimeout(async () => {
        const osmd = osmdRef.current;
        const outer = wrapRef.current;
        if (!osmd || !outer) return;

        // transactional zoom
        isZoomingRef.current = true;
        resizeObsRef.current?.disconnect(); // silence resize during zoom
        const mask = getMaskEl();
        if (mask) mask.style.display = "none";

        const oldStarts = pageStartsRef.current;
        const oldPage = pageIdxRef.current;
        const oldTop = oldStarts[Math.max(0, Math.min(oldPage, oldStarts.length - 1))] ?? 0;

        osmd.zoom = clamped;
        osmd.render();

        // wait until systems exist at new zoom (retry a few frames)
        let tries = 0;
        let bands: Band[] = [];
        do {
          await afterPaint();
          bands = measureSystemsPx(outer);
          if (bands.length) break;
          tries++;
        } while (tries < 8);

        if (!bands.length) {
          // abort safely (do not touch pagination)
          if (mask) mask.style.display = "block";
          // reattach a minimal observer for future resizes
          if (wrapRef.current) {
            const ro = new ResizeObserver(() => {});
            ro.observe(wrapRef.current);
            resizeObsRef.current = ro;
          }
          isZoomingRef.current = false;
          return;
        }

        bandsRef.current = bands;

        const availH = getAvailH();
        if (availH >= 40) {
          const starts = computePageStarts(bands, availH);
          pageStartsRef.current = starts;

          // nearest page to old top system
          let nearest = 0;
          let best = Number.POSITIVE_INFINITY;
          for (let i = 0; i < starts.length; i++) {
            const d = Math.abs(starts[i] - oldTop);
            if (d < best) { best = d; nearest = i; }
          }
          applyPage(nearest);
        }

        if (mask) mask.style.display = "block";

        // reattach resize observer
        if (wrapRef.current) {
          const ro = new ResizeObserver(() => {
            if (isZoomingRef.current) return;
            repaginateHeightOnly();
          });
          ro.observe(wrapRef.current);
          resizeObsRef.current = ro;
        }
        isZoomingRef.current = false;
      }, ZOOM_DEBOUNCE_MS);
    },
    [applyPage, getAvailH, getMaskEl, repaginateHeightOnly]
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

  // Live HUD
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
