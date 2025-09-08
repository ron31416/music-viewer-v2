// src/components/ScoreOSMD.tsx
"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

/* ---- Props ---- */
type Props = {
  src: string;
  fillParent?: boolean;
  height?: number;
  debug?: boolean;
  allowScroll?: boolean;
  className?: string;
  style?: React.CSSProperties;
};

/* ---- Helpers ---- */
function isPromise<T = unknown>(x: unknown): x is Promise<T> {
  return typeof x === "object" && x !== null && "then" in (x as { then?: unknown });
}
function afterPaint(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}
function purgeWebGL(node: HTMLElement): void {
  for (const c of Array.from(node.querySelectorAll("canvas"))) {
    try {
      const gl =
        (c.getContext("webgl") as WebGLRenderingContext | null) ||
        (c.getContext("experimental-webgl") as WebGLRenderingContext | null) ||
        (c.getContext("webgl2") as WebGL2RenderingContext | null);
      const ext = gl?.getExtension("WEBGL_lose_context");
      (ext as { loseContext?: () => void } | null)?.loseContext?.();
      c.remove();
    } catch {}
  }
}

/* ---- CSS-pixel system measurement ---- */
type Band = { top: number; bottom: number; height: number };

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
      try {
        const r = g.getBoundingClientRect();
        if (!Number.isFinite(r.top) || !Number.isFinite(r.height) || !Number.isFinite(r.width)) continue;
        if (r.height < 8 || r.width < 40) continue;
        boxes.push({ top: r.top - hostTop, bottom: r.bottom - hostTop, height: r.height, width: r.width });
      } catch {}
    }
  }

  boxes.sort((a, b) => a.top - b.top);

  const GAP = 18; // px
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

function linesThatFit(bands: Band[], containerH: number, padPx: number): number {
  const limit = containerH - padPx;
  let n = 0;
  for (const b of bands) {
    if (b.bottom <= limit) n += 1;
    else break;
  }
  return Math.max(1, n);
}

/* ---- SVG helpers ---- */
function getSvg(outer: HTMLDivElement): SVGSVGElement | null {
  return outer.querySelector("svg") as SVGSVGElement | null;
}
function withUntransformedSvg<T>(
  outer: HTMLDivElement,
  fn: (svg: SVGSVGElement) => T
): T | null {
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

/* ---- OSMD instance type ---- */
type OSMDWithLifecycle = OpenSheetMusicDisplay & { clear?: () => void; dispose?: () => void };

/* ============================== Component =============================== */
export default function ScoreOSMD({
  src,
  fillParent = false,
  height = 600,
  debug = false,
  allowScroll = false,
  className = "",
  style,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const osmdHostRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMDWithLifecycle | null>(null);
  const resizeObsRef = useRef<ResizeObserver | null>(null);

  // DOM-based model
  const bandsRef = useRef<Band[]>([]);
  const perPageRef = useRef<number>(1);
  const pageRef = useRef<number>(0);
  const readyRef = useRef<boolean>(false);

  // Bottom mask overlay (hides any partial next system)
  const maskRef = useRef<HTMLDivElement | null>(null);

  // HUD
  const [hud, setHud] = useState({ page: 1, maxPage: 1, perPage: 1, total: 0 });

  // constants
  const TOP_PAD = 6;   // px: a little headroom so slurs don’t kiss the top
  const FIT_PAD = 22;  // px: bottom safety
  const WHEEL_THROTTLE_MS = 140;
  const wheelLockRef = useRef<number>(0);

  const updateHUD = useCallback(() => {
    const total = bandsRef.current.length;
    const perPage = Math.max(1, perPageRef.current);
    const maxPage = Math.max(1, Math.ceil(total / perPage));
    const page = Math.min(maxPage, pageRef.current + 1);
    setHud({ page, maxPage, perPage, total });
  }, []);

  // Apply translation AND update the bottom mask to hide partials
  const applyTranslateForPage = useCallback((p: number) => {
    const outer = wrapRef.current;
    if (!outer) return;
    const svg = getSvg(outer);
    if (!svg) return;

    const bands = bandsRef.current;
    const perPage = Math.max(1, perPageRef.current);
    const total = bands.length;
    const maxPageIdx = Math.max(0, Math.ceil(total / perPage) - 1);
    const pageIdx = Math.min(Math.max(0, p), maxPageIdx);
    pageRef.current = pageIdx;

    const startIdx = pageIdx * perPage;
    const startTop = bands[startIdx]?.top ?? 0;
    const lastIdx = Math.min(startIdx + perPage - 1, total - 1);
    const lastBottom = bands[lastIdx]?.bottom ?? startTop;

    const ySnap = Math.ceil(startTop - TOP_PAD); // small cushion at the top
    svg.style.transform = `translateY(${-ySnap}px)`;
    svg.style.willChange = "transform";

    // Where to place the bottom mask (relative to container)
    const visibleBottom = (lastBottom - startTop) + TOP_PAD; // last fully visible line bottom relative to top
    const maskTop = Math.max(0, Math.ceil(visibleBottom));
    // position the mask
    if (maskRef.current && wrapRef.current) {
      maskRef.current.style.top = `${maskTop}px`;
      maskRef.current.style.display = "block";
    }

    updateHUD();
  }, [TOP_PAD, updateHUD]);

  const recomputeLayoutAndPage = useCallback(() => {
    const outer = wrapRef.current;
    if (!outer) return;

    const bands = withUntransformedSvg(outer, (svg) => measureSystemsPx(outer, svg)) ?? [];
    bandsRef.current = bands;

    const perPage = linesThatFit(bands, outer.clientHeight, FIT_PAD);
    perPageRef.current = perPage;

    if (debug) {
      // eslint-disable-next-line no-console
      console.table(
        bands.map((b, i) => ({
          line: i + 1,
          top: b.top.toFixed(1),
          bottom: b.bottom.toFixed(1),
          height: b.height.toFixed(1),
        }))
      );
      // eslint-disable-next-line no-console
      console.log(`linesPerPage=${perPage}, totalSystems=${bands.length}, page=${pageRef.current + 1}`);
    }

    const maxPageIdx = Math.max(0, Math.ceil(bands.length / perPage) - 1);
    if (pageRef.current > maxPageIdx) pageRef.current = maxPageIdx;

    applyTranslateForPage(pageRef.current);
  }, [FIT_PAD, applyTranslateForPage, debug]);

  const nextPage = useCallback(
    (deltaPages: number) => {
      if (!readyRef.current) return;
      const total = bandsRef.current.length;
      const perPage = Math.max(1, perPageRef.current);
      if (!total) return;

      const maxPageIdx = Math.max(0, Math.ceil(total / perPage) - 1);
      let p = pageRef.current + deltaPages;
      if (p < 0) p = 0;
      if (p > maxPageIdx) p = maxPageIdx;

      if (p !== pageRef.current) {
        applyTranslateForPage(p);
      }
    },
    [applyTranslateForPage]
  );

  // Wheel + Keys
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!readyRef.current) return;
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      if (!allowScroll) e.preventDefault();
      const now = Date.now();
      if (now < wheelLockRef.current) return;
      wheelLockRef.current = now + WHEEL_THROTTLE_MS;
      nextPage(e.deltaY > 0 ? 1 : -1);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!readyRef.current) return;
      if (["PageDown", "ArrowDown", " "].includes(e.key)) { e.preventDefault(); nextPage(1); }
      else if (["PageUp", "ArrowUp"].includes(e.key)) { e.preventDefault(); nextPage(-1); }
      else if (e.key === "Home") { e.preventDefault(); applyTranslateForPage(0); }
      else if (e.key === "End") {
        e.preventDefault();
        const perPage = Math.max(1, perPageRef.current);
        const total = bandsRef.current.length;
        const last = Math.max(0, Math.ceil(total / perPage) - 1);
        applyTranslateForPage(last);
      }
    };
    window.addEventListener("wheel", onWheel, { passive: allowScroll });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [allowScroll, nextPage, applyTranslateForPage]);

  // Mount & load OSMD once
  useEffect(() => {
    let localResizeObs: ResizeObserver | null = null;
    (async () => {
      const host = osmdHostRef.current;
      const wrapper = wrapRef.current;
      if (!host || !wrapper) return;
      await afterPaint();

      const { OpenSheetMusicDisplay } =
        (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");

      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }

      const osmd = new OpenSheetMusicDisplay(host, {
        backend: "svg" as const,
        autoResize: true,
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

      purgeWebGL(wrapper);

      // First compute/page
      pageRef.current = 0;
      recomputeLayoutAndPage();
      readyRef.current = true;

      // Observe wrapper size
      localResizeObs = new ResizeObserver(() => {
        recomputeLayoutAndPage();
      });
      localResizeObs.observe(wrapper);
      resizeObsRef.current = localResizeObs;
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("OSMD init error:", err);
    });

    return () => {
      if (localResizeObs && wrapRef.current) localResizeObs.unobserve(wrapRef.current);
      resizeObsRef.current = null;

      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }
    };
  }, [src, recomputeLayoutAndPage]);

  /* ---- UI ---- */
  const outerStyle: React.CSSProperties = fillParent
    ? { width: "100%", height: "100%", minHeight: 0, position: "relative", overflow: "hidden", background: "#fff" }
    : { width: "100%", height: height ?? 600, minHeight: height ?? 600, position: "relative", overflow: "hidden", background: "#fff" };

  const osmdHostStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    overflowY: allowScroll ? "auto" : "hidden",
    overflowX: "hidden",
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
    <div ref={wrapRef} className={className} style={{ ...outerStyle, ...style }}>
      {/* OSMD renders here */}
      <div ref={osmdHostRef} style={osmdHostStyle} />

      {/* Bottom mask to hide any partial next system */}
      <div
        ref={maskRef}
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,        // updated dynamically
          bottom: 0,
          background: "#fff",
          pointerEvents: "none",
          zIndex: 5,
          display: "none",
        }}
      />

      {/* Overlay controls */}
      <div style={{ position: "absolute", right: 10, top: 10, display: "flex", gap: 8, zIndex: 10 }}>
        <button type="button" style={btn} onClick={() => nextPage(-1)}>Prev</button>
        <button type="button" style={btn} onClick={() => nextPage(1)}>Next</button>
      </div>

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
        Page {hud.page}/{hud.maxPage} • {hud.perPage} lines/page • {hud.total} systems
      </div>
    </div>
  );
}
