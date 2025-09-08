// src/components/ScoreOSMD.tsx
"use client";

import React, { useEffect, useRef, useState } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

/* ---------- minimal structural types ---------- */
interface SourceMeasure { MeasureNumber?: number }
interface GraphicalMeasure {
  SourceMeasure?: SourceMeasure;
  ParentMeasure?: { SourceMeasure?: SourceMeasure };
  Parent?: { SourceMeasure?: SourceMeasure };
  MeasureNumber?: number;
}
interface StaffLine { Measures?: GraphicalMeasure[]; measures?: GraphicalMeasure[] }
interface MusicSystem { StaffLines?: StaffLine[]; staffLines?: StaffLine[] }
interface MusicPage { MusicSystems?: MusicSystem[] }
interface GraphicalMusicSheet { MusicPages?: MusicPage[] }

type OSMDInstance = OpenSheetMusicDisplay & {
  dispose?: () => void;
  clear?: () => void;
  GraphicalMusicSheet?: GraphicalMusicSheet;
};

type Props = {
  src: string;                 // e.g. "/scores/gymnopedie-no-1-satie.mxl"
  fillParent?: boolean;        // height: 100% if true
  height?: number;             // px when not filling parent
  debug?: boolean;             // console tables
  allowScroll?: boolean;       // set true if you want a test scrollbar
  className?: string;
  style?: React.CSSProperties;
};

/* ---------- small helpers ---------- */
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

/* ---------- DOM measurement (CSS pixels, not SVG units) ---------- */
type Band = { top: number; bottom: number; height: number };
function analyzeBandsPx(container: HTMLDivElement): Band[] {
  const svg = container.querySelector("svg");
  if (!svg) return [];

  // Prefer page groups if present
  const pageRoots = Array.from(
    svg.querySelectorAll<SVGGElement>(
      'g[id^="osmdCanvasPage"], g[id^="Page"], g[class*="Page"], g[class*="page"]'
    )
  );
  const roots: Array<SVGGElement | SVGSVGElement> = pageRoots.length ? pageRoots : [svg];

  const containerTop = container.getBoundingClientRect().top;

  type BoxPx = { top:number; bottom:number; height:number; width:number };
  const boxes: BoxPx[] = [];

  for (const root of roots) {
    const groups = Array.from(root.querySelectorAll<SVGGElement>("g"));
    for (const g of groups) {
      try {
        const r = g.getBoundingClientRect(); // ← CSS pixels
        const height = r.height;
        const width = r.width;
        if (!Number.isFinite(r.top) || !Number.isFinite(height) || !Number.isFinite(width)) continue;
        if (height < 8 || width < 40) continue; // ignore tiny fragments
        boxes.push({ top: r.top - containerTop, bottom: r.bottom - containerTop, height, width });
      } catch {}
    }
  }

  boxes.sort((a, b) => a.top - b.top);

  // Cluster into systems using a pixel gap
  const GAP = 18; // px – slightly tighter since rects include real spacing
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

function linesThatFit(bands: Band[], container: HTMLDivElement, padPx: number) {
  const limit = container.clientHeight - padPx;
  let count = 0;
  for (const b of bands) {
    if (b.bottom <= limit) count++;
    else break;
  }
  return Math.max(1, count);
}

/* Build a stable system→lastMeasure map from the full layout (all pages) */
function buildSystemEnds(osmd: OSMDInstance): number[] {
  const ends: number[] = [];
  const pages = osmd.GraphicalMusicSheet?.MusicPages ?? [];
  for (const p of pages) {
    for (const sys of (p.MusicSystems ?? [])) {
      let best = 0;
      for (const sl of ((sys.StaffLines ?? sys.staffLines) ?? [])) {
        for (const m of ((sl.Measures ?? sl.measures) ?? [])) {
          const n = m.SourceMeasure?.MeasureNumber
                 ?? m.ParentMeasure?.SourceMeasure?.MeasureNumber
                 ?? m.Parent?.SourceMeasure?.MeasureNumber
                 ?? m.MeasureNumber ?? 0;
          if (n > best) best = n;
        }
      }
      if (best > 0) ends.push(best);
    }
  }
  return ends;
}

type MeasureSliceOptions = { drawFromMeasureNumber?: number; drawUpToMeasureNumber?: number };
function setMeasureOptions(osmd: OSMDInstance, o: MeasureSliceOptions) {
  (osmd as unknown as { setOptions:(o:MeasureSliceOptions)=>void }).setOptions(o);
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
  const boxRef = useRef<HTMLDivElement|null>(null);
  const osmdRef = useRef<OSMDInstance|null>(null);
  const resizeObsRef = useRef<ResizeObserver|null>(null);
  const debounceRef = useRef<number|null>(null);

  // Stable paging model
  const systemEndsRef = useRef<number[]>([]);
  const startSystemRef = useRef(0);
  const nLinesRef = useRef(1);
  const currentRangeRef = useRef<{from:number; upTo:number}>({from:0, upTo:0});
  const readyRef = useRef(false);

  // UI state for HUD
  const [hud, setHud] = useState({ page: 1, maxPage: 1, perPage: 1, total: 0 });

  const FIT_PAD = 20;     // safety margin at bottom
  const VALIDATE_MAX = 5; // shrink attempts if last line still peeks
  const WHEEL_THROTTLE_MS = 140;
  const wheelLockRef = useRef(0);

  function updateHUD() {
    const total = systemEndsRef.current.length;
    const perPage = Math.max(1, nLinesRef.current);
    const page = Math.floor(startSystemRef.current / perPage) + 1;
    const maxPage = Math.max(1, Math.ceil(total / perPage));
    setHud({ page, maxPage, perPage, total });
  }

  async function renderPage(start:number, n:number) {
    const container = boxRef.current!;
    const osmd = osmdRef.current!;
    const ends = systemEndsRef.current;
    if (!ends.length) return;

    const total = ends.length;
    const lastStart = Math.max(0, total - n);
    const s = Math.min(Math.max(0, start), lastStart);
    const endIdx = Math.min(total - 1, s + n - 1);

    const upTo = ends[endIdx];
    const from = s === 0 ? 1 : ends[s - 1] + 1;

    // Always apply the range (some builds ignore no-op)
    setMeasureOptions(osmd, { drawFromMeasureNumber: from, drawUpToMeasureNumber: upTo });
    osmd.render();
    currentRangeRef.current = { from, upTo };
    await afterPaint();

    // Validate after slice using CSS-pixel bands
    let tries = 0;
    while (tries < VALIDATE_MAX) {
      const bands = analyzeBandsPx(container);
      const limit = container.clientHeight - FIT_PAD;
      const lastBand = bands[bands.length - 1];
      if (!lastBand || lastBand.bottom <= limit) break;

      if (n <= 1) break; // can’t shrink further
      n -= 1;
      const newEndIdx = Math.min(total - 1, s + n - 1);
      const newUpTo = ends[newEndIdx];
      const newFrom = s === 0 ? 1 : ends[s - 1] + 1;

      setMeasureOptions(osmd, { drawFromMeasureNumber: newFrom, drawUpToMeasureNumber: newUpTo });
      osmd.render();
      currentRangeRef.current = { from: newFrom, upTo: newUpTo };
      await afterPaint();

      tries++;
    }

    startSystemRef.current = s;
    updateHUD();
  }

  function scheduleRecompute(immediate=false) {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const run = async () => {
      const container = boxRef.current;
      const osmd = osmdRef.current;
      if (!container || !osmd) return;

      purgeWebGL(container);

      // Full render
      setMeasureOptions(osmd, { drawFromMeasureNumber: 1, drawUpToMeasureNumber: Number.MAX_SAFE_INTEGER });
      osmd.render();
      await afterPaint();

      // Build stable system→measure map
      systemEndsRef.current = buildSystemEnds(osmd);

      // Decide lines/page using **CSS pixel** bands
      const bands = analyzeBandsPx(container);
      const n = linesThatFit(bands, container, FIT_PAD);
      nLinesRef.current = n;

      if (debug) {
        // eslint-disable-next-line no-console
        console.table(bands.map((b,i)=>({ line:i+1, top:b.top.toFixed(1), bottom:b.bottom.toFixed(1), height:b.height.toFixed(1) })));
        // eslint-disable-next-line no-console
        console.log(`linesPerPage=${n}, totalSystems=${systemEndsRef.current.length}, startSystem=${startSystemRef.current}`);
      }

      // Clamp start under new totals
      const lastStart = Math.max(0, systemEndsRef.current.length - n);
      if (startSystemRef.current > lastStart) startSystemRef.current = lastStart;

      await renderPage(startSystemRef.current, n);
      readyRef.current = true;
      purgeWebGL(container);
    };

    if (immediate) void run();
    else debounceRef.current = window.setTimeout(() => { void run(); }, 60);
  }

  async function changePage(deltaPages:number) {
    if (!readyRef.current) return;
    const total = systemEndsRef.current.length;
    const n = Math.max(1, nLinesRef.current);
    if (!total) return;

    const lastStart = Math.max(0, total - n);
    let nextStart = startSystemRef.current + deltaPages * n;
    if (nextStart < 0) nextStart = 0;
    if (nextStart > lastStart) nextStart = lastStart;

    if (nextStart !== startSystemRef.current) {
      await renderPage(nextStart, n);
    }
  }

  // Wheel + Keys on WINDOW (more reliable than container focus)
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!readyRef.current) return;
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      if (!allowScroll) e.preventDefault();
      const now = Date.now();
      if (now < wheelLockRef.current) return;
      wheelLockRef.current = now + WHEEL_THROTTLE_MS;
      void changePage(e.deltaY > 0 ? 1 : -1);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!readyRef.current) return;
      if (["PageDown","ArrowDown"," "].includes(e.key)) { e.preventDefault(); void changePage(1); }
      else if (["PageUp","ArrowUp"].includes(e.key)) { e.preventDefault(); void changePage(-1); }
      else if (e.key === "Home") { e.preventDefault(); void renderPage(0, Math.max(1, nLinesRef.current)); }
      else if (e.key === "End") {
        e.preventDefault();
        const total = systemEndsRef.current.length;
        const n = Math.max(1, nLinesRef.current);
        void renderPage(Math.max(0, total - n), n);
      }
    };
    window.addEventListener("wheel", onWheel, { passive: allowScroll });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [allowScroll]);

  // Mount / load OSMD
  useEffect(() => {
    (async () => {
      if (!boxRef.current) return;
      await afterPaint();

      const { OpenSheetMusicDisplay } =
        (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");

      // Cleanup any prior instance
      if (osmdRef.current) { osmdRef.current.clear?.(); osmdRef.current.dispose?.(); osmdRef.current = null; }

      const osmd = new OpenSheetMusicDisplay(boxRef.current, {
        backend: "svg" as const,
        autoResize: true,
        drawTitle: true,
        drawSubtitle: true,
        drawComposer: true,
        drawLyricist: true,
      }) as OSMDInstance;
      osmdRef.current = osmd;

      const maybe = osmd.load(src);
      if (isPromise(maybe)) await maybe;
      osmd.render();

      // First compute/page immediately
      startSystemRef.current = 0;
      currentRangeRef.current = { from:0, upTo:0 };
      readyRef.current = false;
      scheduleRecompute(true);

      // React to container size changes
      if (!resizeObsRef.current) {
        resizeObsRef.current = new ResizeObserver(() => scheduleRecompute());
        resizeObsRef.current.observe(boxRef.current);
      }
    })().catch(err => { console.error("OSMD init error:", err); });

    return () => {
      if (debounceRef.current) { window.clearTimeout(debounceRef.current); debounceRef.current = null; }
      if (resizeObsRef.current && boxRef.current) resizeObsRef.current.unobserve(boxRef.current);
      resizeObsRef.current = null;
      if (osmdRef.current) { osmdRef.current.clear?.(); osmdRef.current.dispose?.(); osmdRef.current = null; }
    };
  }, [src]);

  /* --------------------- UI ---------------------- */
  const containerStyle: React.CSSProperties = fillParent
    ? { width:"100%", height:"100%", minHeight:0, overflowY: allowScroll ? "auto" : "hidden", overflowX:"hidden", position:"relative", background:"#fff" }
    : { width:"100%", height: height ?? 600, minHeight: height ?? 600, overflowY: allowScroll ? "auto" : "hidden", overflowX:"hidden", position:"relative", background:"#fff" };

  return (
    <div ref={boxRef} className={`osmd-container ${className || ""}`} style={{ ...containerStyle, ...style }}>
      {/* Overlay controls (rendered in React so they always appear) */}
      <div style={{ position:"absolute", right:10, top:10, display:"flex", gap:8, zIndex:10 }}>
        <button
          type="button"
          onClick={() => void changePage(-1)}
          style={{ padding:"6px 10px", borderRadius:8, border:"1px solid #ccc", background:"#fff", cursor:"pointer" }}
          aria-label="Previous page"
        >
          Prev
        </button>
        <button
          type="button"
          onClick={() => void changePage(1)}
          style={{ padding:"6px 10px", borderRadius:8, border:"1px solid #ccc", background:"#fff", cursor:"pointer" }}
          aria-label="Next page"
        >
          Next
        </button>
      </div>

      <div
        style={{
          position:"absolute", right:10, bottom:10, padding:"6px 10px",
          background:"rgba(0,0,0,0.55)", color:"#fff",
          borderRadius:8, font:"12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Arial",
          zIndex:10, pointerEvents:"none"
        }}
      >
        Page {hud.page}/{hud.maxPage} • {hud.perPage} lines/page • {hud.total} systems
      </div>
    </div>
  );
}
