// src/components/ScoreOSMD.tsx
"use client";

import { useEffect, useRef } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

/* ---- minimal shapes (no any) ---- */
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
  src: string;
  fillParent?: boolean;
  height?: number;
  debug?: boolean;
  className?: string;
  style?: React.CSSProperties;
};

function isPromise<T=unknown>(x:unknown): x is Promise<T> {
  return typeof x === "object" && x !== null && "then" in (x as Record<string, unknown>);
}
function afterPaint() {
  return new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

/* belt & suspenders: kill any WebGL canvases */
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

/* DOM measurement of systems */
type Band = { top:number; bottom:number; height:number };
function analyzeBands(container: HTMLDivElement): Band[] {
  const svg = container.querySelector("svg");
  if (!svg) return [];
  const pageRoots = Array.from(
    svg.querySelectorAll<SVGGElement>('g[id^="osmdCanvasPage"], g[id^="Page"], g[class*="Page"], g[class*="page"]')
  );
  const roots: Array<SVGGElement|SVGSVGElement> = pageRoots.length ? pageRoots : [svg];

  type Box = { y:number; bottom:number; height:number; width:number };
  const boxes: Box[] = [];
  for (const root of roots) {
    for (const g of Array.from(root.querySelectorAll<SVGGElement>("g"))) {
      try {
        const b = g.getBBox();
        if (!Number.isFinite(b.y) || !Number.isFinite(b.height) || !Number.isFinite(b.width)) continue;
        if (b.height < 8 || b.width < 40) continue;
        boxes.push({ y: b.y, bottom: b.y + b.height, height: b.height, width: b.width });
      } catch {}
    }
  }
  boxes.sort((a,b)=>a.y-b.y);

  const GAP = 24;
  const bands: Band[] = [];
  for (const b of boxes) {
    const last = bands[bands.length-1];
    if (!last || b.y - last.bottom > GAP) {
      bands.push({ top:b.y, bottom:b.bottom, height:b.height });
    } else {
      if (b.y < last.top) last.top = b.y;
      if (b.bottom > last.bottom) last.bottom = b.bottom;
      last.height = last.bottom - last.top;
    }
  }
  return bands;
}

function linesPerPage(bands: Band[], container: HTMLDivElement, padPx:number) {
  const limit = container.clientHeight - padPx;
  let count = 0;
  for (const b of bands) {
    if (b.bottom <= limit) count++;
    else break;
  }
  return Math.max(1, count);
}

/* full-layout stable mapping: system index -> last measure number */
function buildSystemEnds(osmd: OSMDInstance): number[] {
  const ends:number[] = [];
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

export default function ScoreOSMD({
  src,
  fillParent = false,
  height = 600,
  debug = false,
  className = "",
  style
}: Props) {
  const boxRef = useRef<HTMLDivElement|null>(null);
  const osmdRef = useRef<OSMDInstance|null>(null);
  const resizeObsRef = useRef<ResizeObserver|null>(null);
  const debounceRef = useRef<number|null>(null);

  // paging state
  const systemEndsRef = useRef<number[]>([]);
  const startSystemRef = useRef(0);
  const nLinesRef = useRef(1);
  const currentRangeRef = useRef<{from:number; upTo:number}>({from:0, upTo:0});
  const recomputingRef = useRef(false);
  const readyRef = useRef(false);               // <- new: block paging until model built

  const FIT_PAD = 24;
  const VALIDATE_MAX = 5;
  const WHEEL_THROTTLE_MS = 160;
  const wheelLockRef = useRef(0);

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

    if (currentRangeRef.current.from !== from || currentRangeRef.current.upTo !== upTo) {
      setMeasureOptions(osmd, { drawFromMeasureNumber: from, drawUpToMeasureNumber: upTo });
      osmd.render();
      currentRangeRef.current = { from, upTo };
      await afterPaint();
    }

    // validate (drop one line if still peeking)
    let tries = 0;
    while (tries < VALIDATE_MAX) {
      const bands = analyzeBands(container);
      const limit = container.clientHeight - FIT_PAD;
      const lastBand = bands[bands.length - 1];
      if (!lastBand || lastBand.bottom <= limit) break;

      if (n <= 1) break;
      n -= 1;
      const newEndIdx = Math.min(total - 1, s + n - 1);
      const newUpTo = ends[newEndIdx];
      const newFrom = s === 0 ? 1 : ends[s - 1] + 1;

      if (currentRangeRef.current.from === newFrom && currentRangeRef.current.upTo === newUpTo) break;

      setMeasureOptions(osmd, { drawFromMeasureNumber: newFrom, drawUpToMeasureNumber: newUpTo });
      osmd.render();
      currentRangeRef.current = { from: newFrom, upTo: newUpTo };
      await afterPaint();
      tries++;
    }

    startSystemRef.current = s;
  }

  function scheduleRecompute(immediate = false) {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const run = async () => {
      const container = boxRef.current;
      const osmd = osmdRef.current;
      if (!container || !osmd) return;
      if (recomputingRef.current) return;
      recomputingRef.current = true;

      try {
        purgeWebGL(container);

        // full render
        setMeasureOptions(osmd, { drawFromMeasureNumber: 1, drawUpToMeasureNumber: Number.MAX_SAFE_INTEGER });
        osmd.render();
        await afterPaint();

        // stable system map
        systemEndsRef.current = buildSystemEnds(osmd);

        // decide lines per page
        const bands = analyzeBands(container);
        const n = linesPerPage(bands, container, FIT_PAD);
        nLinesRef.current = n;

        if (debug) {
          // eslint-disable-next-line no-console
          console.table(bands.map((b,i)=>({line:i+1, top:b.top.toFixed(1), bottom:b.bottom.toFixed(1), height:b.height.toFixed(1)})));
          // eslint-disable-next-line no-console
          console.log(`linesPerPage=${n}, totalSystems=${systemEndsRef.current.length}, startSystem=${startSystemRef.current}`);
        }

        // clamp start under new totals
        const lastStart = Math.max(0, systemEndsRef.current.length - n);
        if (startSystemRef.current > lastStart) startSystemRef.current = lastStart;

        await renderPage(startSystemRef.current, n);
        readyRef.current = true;            // <- model ready; enable paging
        purgeWebGL(container);
      } finally {
        recomputingRef.current = false;
      }
    };

    if (immediate) void run();
    else debounceRef.current = window.setTimeout(() => { void run(); }, 80);
  }

  async function changePage(deltaPages:number) {
    if (!readyRef.current) return;           // <- ignore until model built
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

  // wheel / key handlers
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      e.preventDefault();
      const now = Date.now();
      if (now < wheelLockRef.current) return;
      wheelLockRef.current = now + WHEEL_THROTTLE_MS;
      void changePage(e.deltaY > 0 ? 1 : -1);
    };
    const onKey = (e: KeyboardEvent) => {
      if (["PageDown","ArrowDown"," "].includes(e.key)) { e.preventDefault(); void changePage(1); }
      else if (["PageUp","ArrowUp"].includes(e.key)) { e.preventDefault(); void changePage(-1); }
    };

    el.addEventListener("wheel", onWheel, { passive:false });
    window.addEventListener("keydown", onKey);
    el.tabIndex = 0; el.focus();

    return () => {
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // mount / load
  useEffect(() => {
    (async () => {
      if (!boxRef.current) return;
      await afterPaint();

      const { OpenSheetMusicDisplay } =
        (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");

      if (osmdRef.current) { osmdRef.current.clear?.(); osmdRef.current.dispose?.(); osmdRef.current = null; }

      const osmd = new OpenSheetMusicDisplay(boxRef.current, {
        backend: "svg" as const,   // force SVG
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

      // initial compute/page (run immediately once)
      startSystemRef.current = 0;
      currentRangeRef.current = { from:0, upTo:0 };
      readyRef.current = false;
      scheduleRecompute(true);

      // ← FIXED TYPO: attach the real observer
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

  const containerStyle: React.CSSProperties = fillParent
    ? { width:"100%", height:"100%", minHeight:0, overflowY:"hidden", overflowX:"hidden" }
    : { width:"100%", height: height ?? 600, minHeight: height ?? 600, overflowY:"hidden", overflowX:"hidden" };

  return <div ref={boxRef} className={`osmd-container ${className || ""}`} style={{ background:"#fff", ...containerStyle, ...style }} />;
}
