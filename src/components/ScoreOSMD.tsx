"use client";

import React, { useEffect, useRef, useState } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

/* Props */
type Props = {
  src: string;                 // e.g. "/scores/gymnopedie-no-1-satie.mxl"
  fillParent?: boolean;        // height: 100% if true
  height?: number;             // px when not filling parent
  debug?: boolean;             // console tables
  allowScroll?: boolean;       // set true to temporarily allow vertical scroll
  className?: string;
  style?: React.CSSProperties;
};

/* Small helpers */
function isPromise<T=unknown>(x:unknown): x is Promise<T> {
  return typeof x === "object" && x !== null && "then" in (x as Record<string, unknown>);
}
function afterPaint() {
  return new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}
function purgeWebGL(node: HTMLElement) {
  for (const c of Array.from(node.querySelectorAll("canvas"))) {
    try {
      const gl = (c.getContext("webgl") as WebGLRenderingContext|null)
              || (c.getContext("experimental-webgl") as WebGLRenderingContext|null)
              || (c.getContext("webgl2") as WebGL2RenderingContext|null);
      gl?.getExtension("WEBGL_lose_context")?.loseContext?.();
      c.remove();
    } catch {}
  }
}

/* Systems measured in CSS pixels */
type Band = { top:number; bottom:number; height:number };
function measureSystemsPx(outer: HTMLDivElement, svgRoot: SVGSVGElement): Band[] {
  // Prefer page groups if present, otherwise scan all <g> descendants
  const pages = Array.from(svgRoot.querySelectorAll<SVGGElement>(
    'g[id^="osmdCanvasPage"], g[id^="Page"], g[class*="Page"], g[class*="page"]'
  ));
  const roots: Array<SVGGElement|SVGSVGElement> = pages.length ? pages : [svgRoot];

  const hostTop = outer.getBoundingClientRect().top;

  type Box = { top:number; bottom:number; height:number; width:number };
  const boxes: Box[] = [];
  for (const root of roots) {
    for (const g of Array.from(root.querySelectorAll<SVGGElement>("g"))) {
      try {
        const r = g.getBoundingClientRect(); // CSS pixels
        if (!Number.isFinite(r.top) || !Number.isFinite(r.height) || !Number.isFinite(r.width)) continue;
        if (r.height < 8 || r.width < 40) continue; // ignore tiny fragments
        boxes.push({ top: r.top - hostTop, bottom: r.bottom - hostTop, height: r.height, width: r.width });
      } catch {}
    }
  }

  boxes.sort((a,b)=>a.top - b.top);

  // Cluster boxes into systems
  const GAP = 18; // px vertical gap between systems
  const bands: Band[] = [];
  for (const b of boxes) {
    const last = bands[bands.length - 1];
    if (!last || b.top - last.bottom > GAP) {
      bands.push({ top:b.top, bottom:b.bottom, height:b.height });
    } else {
      if (b.top < last.top) last.top = b.top;
      if (b.bottom > last.bottom) last.bottom = b.bottom;
      last.height = last.bottom - last.top;
    }
  }
  return bands;
}

function linesThatFit(bands: Band[], containerH: number, pad:number) {
  const limit = containerH - pad;
  let n = 0;
  for (const b of bands) {
    if (b.bottom <= limit) n++;
    else break;
  }
  return Math.max(1, n);
}

/* ============================== Component =============================== */
export default function ScoreOSMD({
  src,
  fillParent = false,
  height = 600,
  debug = false,
  allowScroll = false,
  className = "",
  style
}: Props) {
  // OUTER wrapper we control (position relative; overflow hidden)
  const wrapRef = useRef<HTMLDivElement|null>(null);
  // INNER host OSMD writes into (it may clear its contents)
  const osmdHostRef = useRef<HTMLDivElement|null>(null);

  const osmdRef = useRef<OpenSheetMusicDisplay|null>(null);
  const resizeObsRef = useRef<ResizeObserver|null>(null);

  const [hud, setHud] = useState({ page:1, maxPage:1, perPage:1, total:0 });

  // paging model from DOM only
  const bandsRef = useRef<Band[]>([]);
  const perPageRef = useRef(1);
  const pageRef = useRef(0); // 0-based
  const readyRef = useRef(false);

  const FIT_PAD = 16; // bottom safety margin in px
  const WHEEL_THROTTLE_MS = 140;
  const wheelLockRef = useRef(0);

  function updateHUD() {
    const total = bandsRef.current.length;
    const n = Math.max(1, perPageRef.current);
    const maxPage = Math.max(1, Math.ceil(total / n));
    const page = Math.min(maxPage, pageRef.current + 1);
    setHud({ page, maxPage, perPage:n, total });
  }

  function applyTranslateForPage(p: number) {
    const outer = wrapRef.current!;
    const svg = outer.querySelector("svg") as SVGSVGElement | null;
    if (!svg) return;
    const bands = bandsRef.current;
    const n = Math.max(1, perPageRef.current);
    const total = bands.length;
    const maxPageIdx = Math.max(0, Math.ceil(total / n) - 1);
    const pageIdx = Math.min(Math.max(0, p), maxPageIdx);
    pageRef.current = pageIdx;

    const startBandIdx = pageIdx * n;
    const y = bands[startBandIdx]?.top ?? 0;

    // Translate the whole SVG upward so that the chosen band sits at the top
    svg.style.transform = `translateY(${-Math.round(y)}px)`;
    svg.style.willChange = "transform";

    updateHUD();
  }

  function recomputeLayoutAndPage() {
    const outer = wrapRef.current!;
    const svg = outer.querySelector("svg") as SVGSVGElement | null;
    if (!svg) return;

    // Measure systems in CSS pixels
    const bands = measureSystemsPx(outer, svg);
    bandsRef.current = bands;

    // Decide lines per page for the current outer height
    const n = linesThatFit(bands, outer.clientHeight, FIT_PAD);
    perPageRef.current = n;

    if (debug) {
      // eslint-disable-next-line no-console
      console.table(bands.map((b,i)=>({ line:i+1, top: b.top.toFixed(1), bottom: b.bottom.toFixed(1), height: b.height.toFixed(1) })));
      // eslint-disable-next-line no-console
      console.log(`linesPerPage=${n}, totalSystems=${bands.length}, page=${pageRef.current+1}`);
    }

    // Clamp page index and apply transform
    const maxPageIdx = Math.max(0, Math.ceil(bands.length / n) - 1);
    if (pageRef.current > maxPageIdx) pageRef.current = maxPageIdx;

    applyTranslateForPage(pageRef.current);
  }

  async function nextPage(delta: number) {
    if (!readyRef.current) return;
    const n = Math.max(1, perPageRef.current);
    const total = bandsRef.current.length;
    if (!total) return;

    const maxPageIdx = Math.max(0, Math.ceil(total / n) - 1);
    let p = pageRef.current + delta;
    if (p < 0) p = 0;
    if (p > maxPageIdx) p = maxPageIdx;

    if (p !== pageRef.current) {
      applyTranslateForPage(p);
    }
  }

  // Wheel + keys on window (independent of scrollbars/focus)
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!readyRef.current) return;
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      if (!allowScroll) e.preventDefault();
      const now = Date.now();
      if (now < wheelLockRef.current) return;
      wheelLockRef.current = now + WHEEL_THROTTLE_MS;
      void nextPage(e.deltaY > 0 ? 1 : -1);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!readyRef.current) return;
      if (["PageDown","ArrowDown"," "].includes(e.key)) { e.preventDefault(); void nextPage(1); }
      else if (["PageUp","ArrowUp"].includes(e.key)) { e.preventDefault(); void nextPage(-1); }
      else if (e.key === "Home") { e.preventDefault(); applyTranslateForPage(0); }
      else if (e.key === "End") {
        e.preventDefault();
        const n = Math.max(1, perPageRef.current);
        const total = bandsRef.current.length;
        const last = Math.max(0, Math.ceil(total / n) - 1);
        applyTranslateForPage(last);
      }
    };
    window.addEventListener("wheel", onWheel, { passive: allowScroll });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [allowScroll]);

  // Mount, load OSMD once, then only translate SVG
  useEffect(() => {
    (async () => {
      if (!osmdHostRef.current || !wrapRef.current) return;
      await afterPaint();

      const { OpenSheetMusicDisplay } =
        (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");

      // fresh instance
      if (osmdRef.current) { (osmdRef.current as any).clear?.(); (osmdRef.current as any).dispose?.(); osmdRef.current = null; }

      const osmd = new OpenSheetMusicDisplay(osmdHostRef.current, {
        backend: "svg" as const,  // ensure SVG (no WebGL)
        autoResize: true,
        drawTitle: true,
        drawSubtitle: true,
        drawComposer: true,
        drawLyricist: true,
      });
      osmdRef.current = osmd;

      const maybe = osmd.load(src);
      if (isPromise(maybe)) await maybe;
      osmd.render();
      await afterPaint();

      purgeWebGL(wrapRef.current);

      // First compute
      pageRef.current = 0;
      recomputeLayoutAndPage();
      readyRef.current = true;

      // Watch the OUTER wrapper size (width & height)
      if (!resizeObsRef.current && wrapRef.current) {
        resizeObsRef.current = new ResizeObserver(() => {
          // when size changes, recompute what fits and re-apply transform
          recomputeLayoutAndPage();
        });
        resizeObsRef.current.observe(wrapRef.current);
      }
    })().catch(err => console.error("OSMD init error:", err));

    return () => {
      if (resizeObsRef.current && wrapRef.current) {
        resizeObsRef.current.unobserve(wrapRef.current);
      }
      resizeObsRef.current = null;
      if (osmdRef.current) { (osmdRef.current as any).clear?.(); (osmdRef.current as any).dispose?.(); osmdRef.current = null; }
    };
  }, [src, debug]);

  /* UI */
  const outerStyle: React.CSSProperties = fillParent
    ? { width:"100%", height:"100%", minHeight:0, position:"relative", overflow:"hidden", background:"#fff" }
    : { width:"100%", height: height ?? 600, minHeight: height ?? 600, position:"relative", overflow:"hidden", background:"#fff" };

  const osmdHostStyle: React.CSSProperties = {
    position:"absolute", inset:0,
    overflowY: allowScroll ? "auto" : "hidden",
    overflowX: "hidden"
  };

  const btn: React.CSSProperties = { padding:"6px 10px", borderRadius:8, border:"1px solid #ccc", background:"#fff", cursor:"pointer" };

  return (
    <div ref={wrapRef} className={className} style={{ ...outerStyle, ...style }}>
      {/* OSMD renders into this element (we never clear it; we just translate its <svg>) */}
      <div ref={osmdHostRef} style={osmdHostStyle} />

      {/* Overlay controls (sibling; OSMD won't erase) */}
      <div style={{ position:"absolute", right:10, top:10, display:"flex", gap:8, zIndex:10 }}>
        <button type="button" style={btn} onClick={() => void nextPage(-1)}>Prev</button>
        <button type="button" style={btn} onClick={() => void nextPage(1)}>Next</button>
      </div>

      <div
        style={{
          position:"absolute", right:10, bottom:10, padding:"6px 10px",
          background:"rgba(0,0,0,0.55)", color:"#fff", borderRadius:8,
          font:"12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Arial",
          zIndex:10, pointerEvents:"none"
        }}
      >
        Page {hud.page}/{hud.maxPage} • {hud.perPage} lines/page • {hud.total} systems
      </div>
    </div>
  );
}
