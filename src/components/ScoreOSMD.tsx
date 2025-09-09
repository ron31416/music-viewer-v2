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
  allowScroll?: boolean;  // if you ever want native scroll
};

/* Types */
type Band = { top: number; bottom: number; height: number };
type OSMDWithLifecycle = OpenSheetMusicDisplay & { clear?: () => void; dispose?: () => void };

/* ---------- Helpers ---------- */

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

function withUntransformedSvg<T>(outer: HTMLDivElement, fn: (svg: SVGSVGElement) => T): T | null {
  const svg = getSvg(outer);
  if (!svg) return null;
  const prev = svg.style.transform;
  svg.style.transform = "none";
  try {
    return fn(svg);
  } finally {
    svg.style.transform = prev;
  }
}

/** Cluster OSMD <g> to “systems” and measure them relative to wrapper */
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
      if (r.height < 8 || r.width < 40) continue; // ignore tiny artifacts
      boxes.push({ top: r.top - hostTop, bottom: r.bottom - hostTop, height: r.height, width: r.width });
    }
  }

  boxes.sort((a, b) => a.top - b.top);

  const GAP = 18; // px between systems
  const bands: Band[] = [];
  for (const b of boxes) {
    const last = bands[bands.length - 1];
    if (!last || b.top - last.bottom > GAP) {
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
  allowScroll = false,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMDWithLifecycle | null>(null);

  // Layout model
  const bandsRef = useRef<Band[]>([]);
  const pageStartsRef = useRef<number[]>([0]); // indices into bands
  const pageIdxRef = useRef<number>(0);        // current page index
  const readyRef = useRef<boolean>(false);

  // HUD
  const [hud, setHud] = useState({ page: 1, pages: 1 });

  // Prevent WebGL warnings on some platforms
  function purgeWebGL(node: HTMLElement): void {
    for (const c of Array.from(node.querySelectorAll("canvas"))) {
      try {
        const gl =
          (c.getContext("webgl") as WebGLRenderingContext | null) ||
          (c.getContext("experimental-webgl") as WebGLRenderingContext | null) ||
          (c.getContext("webgl2") as WebGL2RenderingContext | null);
        (gl?.getExtension("WEBGL_lose_context") as { loseContext?: () => void } | null)?.loseContext?.();
        c.remove();
      } catch {}
    }
  }

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
      const maskTopPx = (() => {
        const h = outer.clientHeight;
        if (nextStartIndex < 0) return h;
        const nextTopRel = bands[nextStartIndex].top - startTop;
        const overlap = 4; // px
        return Math.min(h - 1, Math.max(0, Math.ceil(nextTopRel - overlap)));
      })();

      // Create/update mask
      let mask = outer.querySelector<HTMLDivElement>("[data-osmd-mask='1']");
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
        } as CSSStyleDeclaration);
        outer.appendChild(mask);
      }
      mask.style.top = `${maskTopPx}px`;

      // HUD
      setHud({ page: clampedPage + 1, pages });
    },
    []
  );

  /** Recompute *only* pagination (height changed), keeping the same page index if possible */
  const recomputePaginationHeightOnly = useCallback(() => {
    const outer = wrapRef.current;
    if (!outer) return;
    const bands = bandsRef.current;
    if (!bands.length) return;

    const starts = computePageStartIndices(bands, outer.clientHeight);
    const oldStarts = pageStartsRef.current;
    pageStartsRef.current = starts;

    // keep same page by nearest start index
    const oldPage = pageIdxRef.current;
    const oldStartIdx = oldStarts[Math.max(0, Math.min(oldPage, oldStarts.length - 1))] ?? 0;

    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < starts.length; i++) {
      const d = Math.abs(starts[i] - oldStartIdx);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    applyPage(nearest);
  }, [applyPage]);

  /** Full reflow: width changed → re-render OSMD, re-measure bands, recompute pages, keep nearest */
  const reflowOnWidthChange = useCallback(async () => {
    const outer = wrapRef.current;
    const osmd = osmdRef.current;
    if (!outer || !osmd) return;

    // Remember which system index was at the top (by current page start index)
    const oldStarts = pageStartsRef.current;
    const oldPage = pageIdxRef.current;
    const oldTopSystem = oldStarts[Math.max(0, Math.min(oldPage, oldStarts.length - 1))] ?? 0;

    osmd.render();
    await afterPaint();

    const newBands = withUntransformedSvg(outer, (svg) => measureSystemsPx(outer, svg)) ?? [];
    if (!newBands.length) return;
    bandsRef.current = newBands;

    const newStarts = computePageStartIndices(newBands, outer.clientHeight);
    pageStartsRef.current = newStarts;

    // Find page whose start system index is closest to the previous top system
    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < newStarts.length; i++) {
      const d = Math.abs(newStarts[i] - oldTopSystem);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    applyPage(nearest);
  }, [applyPage]);

  /** Init OSMD and first layout */
  useEffect(() => {
    let resizeObs: ResizeObserver | null = null;
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

      purgeWebGL(outer);

      // Initial measure
      const bands = withUntransformedSvg(outer, (svg) => measureSystemsPx(outer, svg)) ?? [];
      bandsRef.current = bands;

      // Pages & first page
      pageStartsRef.current = computePageStartIndices(bands, outer.clientHeight);
      pageIdxRef.current = 0;
      applyPage(0);

      readyRef.current = true;

      // Observe wrapper size; only re-render on width changes.
      resizeObs = new ResizeObserver(() => {
        if (!readyRef.current) return;
        const w = outer.clientWidth;
        const h = outer.clientHeight;

        const widthChanged = lastW !== -1 && Math.abs(w - lastW) >= 1;
        const heightChanged = lastH !== -1 && Math.abs(h - lastH) >= 1;

        lastW = w;
        lastH = h;

        if (widthChanged) {
          // Width affects OSMD layout: re-render + re-measure + re-page.
          reflowOnWidthChange();
        } else if (heightChanged) {
          // Height does NOT affect OSMD layout: only recompute pagination/mask.
          recomputePaginationHeightOnly();
        }
      });
      resizeObs.observe(outer);
      // initialize lastW/H
      lastW = outer.clientWidth;
      lastH = outer.clientHeight;
    })().catch(() => {});

    return () => {
      if (resizeObs && wrapRef.current) resizeObs.unobserve(wrapRef.current);
      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }
    };
  }, [applyPage, recomputePaginationHeightOnly, reflowOnWidthChange, src]);

  /** Paging controls */
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

  // Optional: wheel/keyboard paging
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

  /* ---------- Styles ---------- */

  const outerStyle: React.CSSProperties = fillParent
    ? { width: "100%", height: "100%", minHeight: 0, position: "relative", overflow: "hidden", background: "#fff" }
    : { width: "100%", height: height ?? 600, minHeight: height ?? 600, position: "relative", overflow: "hidden", background: "#fff" };

  const hostStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    overflow: "hidden",   // no native scroll; we page by buttons/wheel/keys
    minWidth: 0,          // avoid horizontal scrollbar jiggle
  };

  const btn: React.CSSProperties = {
    padding: "6px 10px",
    borderRadius: 8,
    border: "1px solid #ccc",
    background: "#fff",
    cursor: "pointer",
    fontWeight: 600,
  };

  // Live HUD from refs
  const pages = pageStartsRef.current.length || 1;
  const page = Math.min(pageIdxRef.current + 1, pages);

  return (
    <div ref={wrapRef} className={className} style={{ ...outerStyle, ...style }}>
      <div ref={hostRef} style={hostStyle} />

      {/* Controls */}
      <div style={{ position: "absolute", right: 10, top: 10, display: "flex", gap: 8, zIndex: 10 }}>
        <button type="button" style={btn} onClick={goPrev}>Prev</button>
        <button type="button" style={btn} onClick={goNext}>Next</button>
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
        Page {page}/{pages}
      </div>
    </div>
  );
}
