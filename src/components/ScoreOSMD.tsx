// src/components/ScoreOSMD.tsx
"use client";

import React, { useCallback, useEffect, useRef } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

/* Props */
type Props = {
  src: string;
  /** Occupy parent height by default */
  fillParent?: boolean;     // default: true
  height?: number;          // used only if fillParent === false
  className?: string;
  style?: React.CSSProperties;
  /** One-time zoom applied before first render; fixed for the session */
  initialZoom?: number;     // default: 1 (0.5..3 suggested)
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
  const prev = (svg.style && svg.style.transform) || "";
  (svg.style as CSSStyleDeclaration).transform = "none";
  try {
    return fn(svg);
  } finally {
    (svg.style as CSSStyleDeclaration).transform = prev;
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
  fillParent = true,
  height = 600,
  className = "",
  style,
  initialZoom = 1,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMDWithLifecycle | null>(null);

  // Layout model
  const bandsRef = useRef<Band[]>([]);
  const pageStartsRef = useRef<number[]>([0]); // indices into bands
  const pageIdxRef = useRef<number>(0);        // current page index
  const readyRef = useRef<boolean>(false);

  // Prevent WebGL warnings on some platforms
  function purgeWebGL(node: HTMLElement): void {
    for (const c of Array.from(node.querySelectorAll("canvas"))) {
      try {
        const gl =
          (c.getContext("webgl") as WebGLRenderingContext | null) ||
          (c.getContext("experimental-webgl") as WebGLRenderingContext | null) ||
          (c.getContext("webgl2") as WebGL2RenderingContext | null);
        const ext = gl?.getExtension("WEBGL_lose_context") as { loseContext?: () => void } | null;
        ext?.loseContext?.();
        c.remove();
      } catch {
        /* noop */
      }
    }
  }

  /** Apply a page index: translate SVG & mask bottom so no partial next line shows */
  const applyPage = useCallback((pageIdx: number) => {
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
    (svg.style as CSSStyleDeclaration).transform = `translateY(${-ySnap}px)`;
    (svg.style as CSSStyleDeclaration).willChange = "transform";

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
  }, []);

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

  /** Init OSMD and first layout (apply one-time initialZoom here) */
  useEffect(() => {
    let resizeObs: ResizeObserver | null = null;

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

      // One-time zoom before first render (no "any")
      const z = Math.max(0.5, Math.min(3, initialZoom ?? 1));
      (osmd as unknown as { Zoom: number }).Zoom = z;

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

      // Observe wrapper size; only re-render on width changes.
      resizeObs = new ResizeObserver(() => {
        const w = outer.clientWidth;
        const h = outer.clientHeight;

        // If width changed: reflow OSMD and recompute bands/pages.
        // If only height changed: recompute pagination/mask only.
        // We don't need to track previous w/h here—the OSMD re-render is idempotent.
        // (If you prefer, you can store the last w/h in refs to skip identical calls.)
        osmd.render();
        requestAnimationFrame(() => {
          const nextBands = withUntransformedSvg(outer, (svg) => measureSystemsPx(outer, svg)) ?? [];
          if (nextBands.length) {
            bandsRef.current = nextBands;
            pageStartsRef.current = computePageStartIndices(nextBands, h);
            // keep current page index bounded
            const maxPage = Math.max(0, pageStartsRef.current.length - 1);
            const clamped = Math.min(pageIdxRef.current, maxPage);
            applyPage(clamped);
          }
        });
      });
      resizeObs.observe(outer);
    })().catch(() => {});

    // capture current outer for cleanup to avoid ref-change warning
    const cleanupOuter = wrapRef.current;

    return () => {
      if (resizeObs && cleanupOuter) resizeObs.unobserve(cleanupOuter);
      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }
    };
  }, [applyPage, initialZoom, src]);

  /** Paging helpers (used by wheel/keys/swipe) */
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

  // Wheel & keyboard paging (desktop)
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

  // Touch swipe paging (tablet/phone)
  useEffect(() => {
    const outer = wrapRef.current;
    if (!outer) return;

    let startY = 0;
    let startX = 0;
    let active = false;

    const onTouchStart = (e: TouchEvent) => {
      if (!e.touches.length) return;
      active = true;
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!active) return;
      // prevent native scroll to keep paging crisp
      e.preventDefault();
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!active) return;
      active = false;
      const t = e.changedTouches[0];
      const dy = t.clientY - startY;
      const dx = t.clientX - startX;

      const THRESH = 40;      // min vertical travel
      const H_RATIO = 0.6;    // ignore if mostly horizontal

      if (Math.abs(dy) >= THRESH && Math.abs(dx) <= Math.abs(dy) * H_RATIO) {
        if (dy < 0) goNext(); // swipe up → next page
        else goPrev();        // swipe down → previous page
      }
    };

    outer.addEventListener("touchstart", onTouchStart, { passive: true });
    outer.addEventListener("touchmove", onTouchMove, { passive: false });
    outer.addEventListener("touchend", onTouchEnd, { passive: true });

    // reduce scroll chaining/bounce
    outer.style.overscrollBehavior = "contain";

    // cleanup uses captured element to avoid ref-change warning
    const cleanupOuter = outer;
    return () => {
      cleanupOuter.removeEventListener("touchstart", onTouchStart);
      cleanupOuter.removeEventListener("touchmove", onTouchMove);
      cleanupOuter.removeEventListener("touchend", onTouchEnd);
    };
  }, [goNext, goPrev]);

  /* ---------- Styles ---------- */

  const outerStyle: React.CSSProperties = fillParent
    ? { width: "100%", height: "100%", minHeight: 0, position: "relative", overflow: "hidden", background: "#fff" }
    : { width: "100%", height: height ?? 600, minHeight: height ?? 600, position: "relative", overflow: "hidden", background: "#fff" };

  const hostStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    overflow: "hidden",   // no native scroll; we page by wheel/keys/swipe
    minWidth: 0,
  };

  return (
    <div ref={wrapRef} className={className} style={{ ...outerStyle, ...style }}>
      <div ref={hostRef} style={hostStyle} />
    </div>
  );
}
