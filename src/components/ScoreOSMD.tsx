"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

/* Props */
type Props = {
  src: string;
  fillParent?: boolean;
  height?: number;
  debug?: boolean;
  allowScroll?: boolean;
  className?: string;
  style?: React.CSSProperties;
};

/* Small helpers */
function isPromise<T = unknown>(x: unknown): x is Promise<T> {
  return typeof x === "object" && x !== null && "then" in (x as { then?: unknown });
}
function afterPaint(): Promise<void> {
  return new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r()))
  );
}
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

/* Band = one system line in CSS px, relative to wrapper top */
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
        if (r.height < 8 || r.width < 40) continue; // ignore tiny fragments
        boxes.push({ top: r.top - hostTop, bottom: r.bottom - hostTop, height: r.height, width: r.width });
      } catch {}
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
      if (b.top < last.top) last.top = b.top;
      if (b.bottom > last.bottom) last.bottom = b.bottom;
      last.height = last.bottom - last.top;
    }
  }
  return bands;
}

/* SVG + transform helpers */
function getSvg(outer: HTMLDivElement): SVGSVGElement | null {
  return outer.querySelector("svg") as SVGSVGElement | null;
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
function getCurrentTranslateY(outer: HTMLDivElement): number {
  const svg = getSvg(outer);
  if (!svg) return 0;
  // expect "translateY(-123px)" or empty
  const m = /translateY\((-?\d+\.?\d*)px\)/.exec(svg.style.transform || "");
  return m ? parseFloat(m[1]) : 0;
}

/* OSMD type */
type OSMDWithLifecycle = OpenSheetMusicDisplay & { clear?: () => void; dispose?: () => void };

/* Component */
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

  const bandsRef = useRef<Band[]>([]);
  const perPageRef = useRef<number>(1);
  const pageRef = useRef<number>(0);
  const readyRef = useRef<boolean>(false);

  const maskRef = useRef<HTMLDivElement | null>(null);

  const [hud, setHud] = useState({ page: 1, maxPage: 1, perPage: 1, total: 0 });

  /* Tunables */
  const MASK_OVERLAP = 3;          // px: hide a hair *above* next system top to prevent slur peeking
  const WHEEL_THROTTLE_MS = 140;
  const wheelLockRef = useRef<number>(0);

  /* Debounced resize recompute (wait for OSMD auto-resize to settle) */
  const raf1 = useRef<number | null>(null);
  const raf2 = useRef<number | null>(null);
  const scheduleRecompute = useCallback(() => {
    if (raf1.current != null) cancelAnimationFrame(raf1.current);
    if (raf2.current != null) cancelAnimationFrame(raf2.current);
    raf1.current = requestAnimationFrame(() => {
      raf2.current = requestAnimationFrame(() => {
        recomputeLayoutAndPage(true); // keep position across reflow
      });
    });
  }, []);

  const updateHUD = useCallback(() => {
    const total = bandsRef.current.length;
    const perPage = Math.max(1, perPageRef.current);
    const maxPage = Math.max(1, Math.ceil(total / perPage));
    const page = Math.min(maxPage, pageRef.current + 1);
    setHud({ page, maxPage, perPage, total });
  }, []);

  /* Apply translation + bottom mask (no top padding) */
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
    const nextIdx = lastIdx + 1;

    // Align so that first visible system’s top sits at viewport top (no rounding down)
    const ySnap = Math.ceil(startTop);
    svg.style.transform = `translateY(${-ySnap}px)`;
    svg.style.willChange = "transform";

    // Bottom mask hides anything starting from NEXT system’s top (minus a tiny overlap)
    let maskTop = outer.clientHeight; // default (no extra mask)
    if (nextIdx < bands.length) {
      const nextTopRel = bands[nextIdx].top - startTop;
      maskTop = Math.min(
        outer.clientHeight - 1,
        Math.max(0, Math.ceil(nextTopRel - MASK_OVERLAP))
      );
    }
    if (maskRef.current) {
      maskRef.current.style.top = `${maskTop}px`;
      maskRef.current.style.display = "block";
    }

    if (debug) {
      // eslint-disable-next-line no-console
      console.log({ pageIdx, perPage, startIdx, lastIdx, nextIdx, startTop, ySnap, maskTop });
    }

    updateHUD();
  }, [MASK_OVERLAP, updateHUD, debug]);

  /* Recompute bands + per-page. Optionally keep musical position across reflow. */
  const recomputeLayoutAndPage = useCallback((keepPosition = false) => {
    const outer = wrapRef.current;
    if (!outer) return;

    // capture current aligned Y (relative to wrapper) so we can keep position
    const prevTranslate = keepPosition ? getCurrentTranslateY(outer) : 0;
    const prevAlignedTop = keepPosition ? Math.max(0, -prevTranslate) : 0;

    const bands = withUntransformedSvg(outer, (svg) => measureSystemsPx(outer, svg)) ?? [];
    bandsRef.current = bands;

    // how many systems fit? (we rely on mask for the next line, so no explicit bottom pad)
    const limit = outer.clientHeight;
    let n = 0;
    for (const b of bands) {
      if (b.bottom - (bands[0]?.top ?? 0) <= limit) n += 1;
      else break;
    }
    perPageRef.current = Math.max(1, n);

    // If keeping position, choose the page so that the first visible system
    // is the first whose top >= prevAlignedTop.
    if (keepPosition && bands.length) {
      let startIdx = bands.findIndex((b) => b.top >= prevAlignedTop - 0.5);
      if (startIdx < 0) startIdx = bands.length - 1;
      const perPage = Math.max(1, perPageRef.current);
      const newPage = Math.floor(startIdx / perPage);
      pageRef.current = Math.max(0, Math.min(newPage, Math.ceil(bands.length / perPage) - 1));
    }

    if (debug) {
      // eslint-disable-next-line no-console
      console.table(bands.map((b, i) => ({ line: i + 1, top: b.top.toFixed(1), bottom: b.bottom.toFixed(1), height: b.height.toFixed(1) })));
      // eslint-disable-next-line no-console
      console.log(`linesPerPage=${perPageRef.current}, totalSystems=${bands.length}, page=${pageRef.current + 1}`);
    }

    applyTranslateForPage(pageRef.current);
  }, [applyTranslateForPage, debug]);

  const nextPage = useCallback((deltaPages: number) => {
    if (!readyRef.current) return;
    const total = bandsRef.current.length;
    const perPage = Math.max(1, perPageRef.current);
    if (!total) return;

    const maxPageIdx = Math.max(0, Math.ceil(total / perPage) - 1);
    let p = pageRef.current + deltaPages;
    if (p < 0) p = 0;
    if (p > maxPageIdx) p = maxPageIdx;

    if (p !== pageRef.current) applyTranslateForPage(p);
  }, [applyTranslateForPage]);

  /* Wheel + keys */
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

  /* Mount + OSMD load */
  useEffect(() => {
    let localResizeObs: ResizeObserver | null = null;
    (async () => {
      const host = osmdHostRef.current;
      const wrapper = wrapRef.current;
      if (!host || !wrapper) return;
      await afterPaint();

      const { OpenSheetMusicDisplay } =
        (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");

      // fresh instance
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

      // create bottom mask once
      if (!maskRef.current && wrapper) {
        const mask = document.createElement("div");
        mask.style.position = "absolute";
        mask.style.left = "0";
        mask.style.right = "0";
        mask.style.top = "0";
        mask.style.bottom = "0";
        mask.style.background = "#fff";
        mask.style.pointerEvents = "none";
        mask.style.zIndex = "5";
        mask.style.display = "none";
        wrapper.appendChild(mask);
        maskRef.current = mask;
      }

      pageRef.current = 0;
      recomputeLayoutAndPage(false);
      readyRef.current = true;

      // Debounced resize observer → reflow & keep position
      localResizeObs = new ResizeObserver(() => {
        scheduleRecompute();
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
      if (raf1.current != null) cancelAnimationFrame(raf1.current);
      if (raf2.current != null) cancelAnimationFrame(raf2.current);
    };
  }, [src, scheduleRecompute, recomputeLayoutAndPage]);

  /* Render scaffolding */
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
      <div ref={osmdHostRef} style={osmdHostStyle} />

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
