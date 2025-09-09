// src/components/ScoreOSMD.tsx
"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

/** Props */
type Props = {
  src: string;
  fillParent?: boolean;           // stretch to parent height
  height?: number;                // if not fillParent
  className?: string;
  style?: React.CSSProperties;
};

/** Internal types */
type Band = { top: number; bottom: number; height: number };
type OSMDWithLifecycle = OpenSheetMusicDisplay & { clear?: () => void; dispose?: () => void };

/** Helpers */
const afterPaint = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });

const isPromise = (x: unknown): x is Promise<unknown> =>
  typeof x === "object" && x !== null && typeof (x as { then?: unknown }).then === "function";

function getSvg(el: HTMLDivElement): SVGSVGElement | null {
  return el.querySelector("svg");
}

function withUntransformedSvg<T>(host: HTMLDivElement, fn: (svg: SVGSVGElement) => T): T | null {
  const svg = getSvg(host);
  if (!svg) return null;
  const prev = svg.style.transform;
  svg.style.transform = "none";
  try {
    return fn(svg);
  } finally {
    svg.style.transform = prev;
  }
}

/** Group <g> into “systems” and measure them relative to the scroll container */
function measureSystemsPx(outer: HTMLDivElement, svgRoot: SVGSVGElement): Band[] {
  const pageRoots = Array.from(
    svgRoot.querySelectorAll<SVGGElement>(
      'g[id^="osmdCanvasPage"], g[id^="Page"], g[class*="Page"], g[class*="page"]'
    )
  );
  const roots: Array<SVGGElement | SVGSVGElement> = pageRoots.length ? pageRoots : [svgRoot];

  const hostTop = outer.getBoundingClientRect().top;
  type Box = { top: number; bottom: number; height: number; width: number };
  const boxes: Box[] = [];

  for (const root of roots) {
    for (const g of Array.from(root.querySelectorAll<SVGGElement>("g"))) {
      const r = g.getBoundingClientRect();
      if (!Number.isFinite(r.top) || !Number.isFinite(r.height) || !Number.isFinite(r.width)) continue;
      if (r.height < 8 || r.width < 40) continue; // ignore tiny fragments
      boxes.push({ top: r.top - hostTop, bottom: r.bottom - hostTop, height: r.height, width: r.width });
    }
  }

  boxes.sort((a, b) => a.top - b.top);

  // Merge consecutive boxes into systems if they are close vertically.
  const GAP = 18; // px between system groups
  const bands: Band[] = [];
  for (const b of boxes) {
    const last = bands[bands.length - 1];
    if (!last || b.top - last.bottom > GAP) {
      bands.push({ top: b.top, bottom: b.bottom, height: b.height });
    } else {
      if (b.top < last.top) last.top = b.top;
      if (b.bottom > last.bottom) last.bottom = b.bottom;
      last.height = last.bottom - last.top;
    }
  }
  return bands;
}

/** Compute snap starts so each “page” shows only full systems (no bottom cut) */
function computePageStarts(bands: Band[], viewportH: number): number[] {
  if (!bands.length || viewportH <= 0) return [0];
  const starts: number[] = [];
  for (let i = 0; i < bands.length; ) {
    const startTop = bands[i].top;
    let last = i;
    // greedily add systems while they still fully fit
    while (last + 1 < bands.length && bands[last + 1].bottom - startTop <= viewportH) last++;
    starts.push(startTop);
    // next page begins at next system after the last that fully fit
    i = last + 1;
  }
  return starts.length ? starts : [0];
}

export default function ScoreOSMD({
  src,
  fillParent = false,
  height = 600,
  className = "",
  style,
}: Props) {
  const outerRef = useRef<HTMLDivElement | null>(null);   // positioned wrapper
  const scrollRef = useRef<HTMLDivElement | null>(null);  // scrolling element (OSMD host)
  const osmdRef = useRef<OSMDWithLifecycle | null>(null);

  // model
  const bandsRef = useRef<Band[]>([]);
  const [pageStarts, setPageStarts] = useState<number[]>([0]);
  const [hud, setHud] = useState({ page: 1, pages: 1 });

  const updateHUDFromScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !pageStarts.length) return;
    const y = el.scrollTop;
    let p = 0;
    for (let i = 0; i < pageStarts.length; i++) {
      if (pageStarts[i] <= y + 1) p = i;
      else break;
    }
    setHud({ page: p + 1, pages: pageStarts.length });
  }, [pageStarts]);

  // Scroll to nearest (or specific) page start
  const scrollToPageIdx = useCallback(
    (idx: number, behavior: ScrollBehavior = "auto") => {
      const el = scrollRef.current;
      if (!el || !pageStarts.length) return;
      const clamped = Math.max(0, Math.min(idx, pageStarts.length - 1));
      el.scrollTo({ top: pageStarts[clamped], left: 0, behavior });
    },
    [pageStarts]
  );

  const nextPage = useCallback(
    (delta: number) => {
      const el = scrollRef.current;
      if (!el || !pageStarts.length) return;
      const y = el.scrollTop;
      let cur = 0;
      for (let i = 0; i < pageStarts.length; i++) {
        if (pageStarts[i] <= y + 1) cur = i;
        else break;
      }
      scrollToPageIdx(cur + delta, "smooth");
    },
    [pageStarts, scrollToPageIdx]
  );

  // Snap markers MUST be children of the scrolling element
  const snapMarkers = useMemo(
    () =>
      pageStarts.map((top, i) => (
        <div
          key={`snap-${i}`}
          style={{
            position: "absolute",
            top,
            left: 0,
            width: 1,
            height: 1,
            scrollSnapAlign: "start",
            scrollSnapStop: "always",
            pointerEvents: "none",
          }}
        />
      )),
    [pageStarts]
  );

  // Recompute bands + page starts (no transforms, native scroll)
  const recomputeLayout = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc) return;

    const bands = withUntransformedSvg(sc, (svg) => measureSystemsPx(sc, svg)) ?? [];
    bandsRef.current = bands;

    const starts = computePageStarts(bands, sc.clientHeight);
    setPageStarts(starts);

    // keep user position by snapping to nearest start to avoid partial lines
    const y = sc.scrollTop;
    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < starts.length; i++) {
      const d = Math.abs(starts[i] - y);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    scrollToPageIdx(nearest, "auto");
    setHud({ page: nearest + 1, pages: starts.length });
  }, [scrollToPageIdx]);

  // Keyboard navigation (wheel/trackpad uses native scroll + snap)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!scrollRef.current) return;
      if (["PageDown", "ArrowDown", " "].includes(e.key)) {
        e.preventDefault();
        nextPage(1);
      } else if (["PageUp", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        nextPage(-1);
      } else if (e.key === "Home") {
        e.preventDefault();
        scrollToPageIdx(0, "smooth");
      } else if (e.key === "End") {
        e.preventDefault();
        scrollToPageIdx(pageStarts.length - 1, "smooth");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nextPage, scrollToPageIdx, pageStarts.length]);

  // Mount + OSMD init (autoResize: false; we re-render on container resizes)
  useEffect(() => {
    let resizeObs: ResizeObserver | null = null;

    (async () => {
      const sc = scrollRef.current;
      if (!sc) return;
      await afterPaint();

      const { OpenSheetMusicDisplay } =
        (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");

      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
      }

      const osmd = new OpenSheetMusicDisplay(sc, {
        backend: "svg" as const,
        autoResize: false, // we’ll handle it explicitly
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

      // Ensure the SVG can't force horizontal scroll jank / black backgrounds
      sc.style.background = "#fff";
      sc.style.minWidth = "0";
      sc.style.overflowX = "hidden";

      recomputeLayout();

      // Observe size changes on the scrolling element itself
      let raf = 0;
      resizeObs = new ResizeObserver(() => {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          osmd.render();
          afterPaint().then(recomputeLayout);
        });
      });
      resizeObs.observe(sc);

      // HUD on scroll (snap will align sections for us)
      const onScroll = () => {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(updateHUDFromScroll);
      };
      sc.addEventListener("scroll", onScroll, { passive: true });

      return () => sc.removeEventListener("scroll", onScroll);
    })().catch(() => {});

    return () => {
      const sc = scrollRef.current;
      if (resizeObs && sc) resizeObs.unobserve(sc);
      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }
    };
  }, [recomputeLayout, updateHUDFromScroll, src]);

  /** Layout styles */
  const outerStyle: React.CSSProperties = fillParent
    ? { width: "100%", height: "100%", minHeight: 0, position: "relative", overflow: "hidden" }
    : { width: "100%", height: height ?? 600, minHeight: height ?? 600, position: "relative", overflow: "hidden" };

  const scrollStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    overflowY: "auto",
    overflowX: "hidden",
    // snap container
    scrollSnapType: "y mandatory",
    WebkitOverflowScrolling: "touch",
    background: "#fff",
    minWidth: 0,
  };

  const btn: React.CSSProperties = {
    padding: "6px 10px",
    borderRadius: 8,
    border: "1px solid #ccc",
    background: "#fff",
    cursor: "pointer",
    fontWeight: 600,
  };

  return (
    <div ref={outerRef} className={className} style={{ ...outerStyle, ...style }}>
      {/* SCROLLING ELEMENT = OSMD HOST (SVG inserted here) */}
      <div ref={scrollRef} style={scrollStyle}>
        {/* Snap markers MUST be children of the scrolling element */}
        <div style={{ position: "relative", width: "100%", height: 0, pointerEvents: "none" }}>
          {snapMarkers}
        </div>
      </div>

      {/* Controls */}
      <div style={{ position: "absolute", right: 10, top: 10, display: "flex", gap: 8, zIndex: 10 }}>
        <button type="button" style={btn} onClick={() => nextPage(-1)}>
          Prev
        </button>
        <button type="button" style={btn} onClick={() => nextPage(1)}>
          Next
        </button>
      </div>

      {/* HUD */}
      <div
        style={{
          position: "absolute",
          right: 10,
          bottom: 10,
          padding: "6px 10px",
          background: "rgba(0,0,0,0.55)",
          color: "#fff",
          borderRadius: 8,
          font: "12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Arial",
          zIndex: 10,
          pointerEvents: "none",
        }}
      >
        Page {hud.page}/{hud.pages}
      </div>
    </div>
  );
}
