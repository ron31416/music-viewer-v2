// src/components/ScoreOSMD.tsx
"use client";

import { useEffect, useRef } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

/* --------- minimal structural types (no `any`) --------- */
interface SourceMeasure { MeasureNumber?: number }
interface GraphicalMeasure {
  SourceMeasure?: SourceMeasure;
  ParentMeasure?: { SourceMeasure?: SourceMeasure };
  Parent?: { SourceMeasure?: SourceMeasure };
  MeasureNumber?: number;
}
interface StaffLine {
  Measures?: GraphicalMeasure[];
  measures?: GraphicalMeasure[];
}
interface MusicSystem {
  StaffLines?: StaffLine[];
  staffLines?: StaffLine[];
}
interface MusicPage { MusicSystems?: MusicSystem[] }
interface GraphicalMusicSheet { MusicPages?: MusicPage[] }

type OSMDInstance = OpenSheetMusicDisplay & {
  dispose?: () => void;
  clear?: () => void;
  GraphicalMusicSheet?: GraphicalMusicSheet;
};

type Props = {
  src: string;                 // e.g. "/scores/gymnopedie-no-1-satie.mxl"
  fillParent?: boolean;        // height:100% if true
  height?: number;             // px when not filling parent (default 600)
  debug?: boolean;             // console tables
  className?: string;
  style?: React.CSSProperties;
};

function isPromise<T = unknown>(x: unknown): x is Promise<T> {
  return typeof x === "object" && x !== null && "then" in (x as Record<string, unknown>);
}
function afterPaint(): Promise<void> {
  return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => res())));
}

/* belt-and-suspenders: nuke any WebGL contexts that might appear */
function purgeWebGL(node: HTMLElement) {
  const canvases = Array.from(node.querySelectorAll("canvas"));
  for (const c of canvases) {
    try {
      const gl =
        (c.getContext("webgl") as WebGLRenderingContext | null) ||
        (c.getContext("experimental-webgl") as WebGLRenderingContext | null) ||
        (c.getContext("webgl2") as WebGL2RenderingContext | null);
      if (gl) gl.getExtension("WEBGL_lose_context")?.loseContext?.();
      c.remove();
    } catch {}
  }
}

/* ---- DOM measurement of systems (“bands”) ---- */
type Band = { top: number; bottom: number; height: number };
function analyzeBands(container: HTMLDivElement): Band[] {
  const svg = container.querySelector("svg");
  if (!svg) return [];

  const pageRoots = Array.from(
    svg.querySelectorAll<SVGGElement>(
      'g[id^="osmdCanvasPage"], g[id^="Page"], g[class*="Page"], g[class*="page"]'
    )
  );
  const roots: Array<SVGGElement | SVGSVGElement> = pageRoots.length ? pageRoots : [svg];

  type Box = { y: number; bottom: number; height: number; width: number };
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

  boxes.sort((a, b) => a.y - b.y);

  const GAP = 24; // px between systems
  const bands: Band[] = [];
  for (const b of boxes) {
    const last = bands[bands.length - 1];
    if (!last || b.y - last.bottom > GAP) {
      bands.push({ top: b.y, bottom: b.bottom, height: b.height });
    } else {
      if (b.y < last.top) last.top = b.y;
      if (b.bottom > last.bottom) last.bottom = b.bottom;
      last.height = last.bottom - last.top;
    }
  }
  return bands;
}

/* how many systems fit fully (by bottom edge) */
function linesPerPage(bands: Band[], container: HTMLDivElement, padPx: number): number {
  const limit = container.clientHeight - padPx;
  let count = 0;
  for (const b of bands) {
    if (b.bottom <= limit) count += 1;
    else break;
  }
  return Math.max(1, count);
}

/* ------------ FULL-LAYOUT mapping: system index -> last measure number (for ALL pages) ----------- */
function buildSystemMeasureEnds(osmd: OSMDInstance): number[] {
  const ends: number[] = [];
  const gms = osmd.GraphicalMusicSheet;
  const pages: MusicPage[] = gms?.MusicPages ?? [];
  for (const page of pages) {
    const systems: MusicSystem[] = page.MusicSystems ?? [];
    for (const sys of systems) {
      const lines: StaffLine[] = (sys.StaffLines ?? sys.staffLines) ?? [];
      let best = 0;
      for (const sl of lines) {
        const measures: GraphicalMeasure[] = (sl.Measures ?? sl.measures) ?? [];
        for (const m of measures) {
          const n =
            m.SourceMeasure?.MeasureNumber ??
            m.ParentMeasure?.SourceMeasure?.MeasureNumber ??
            m.Parent?.SourceMeasure?.MeasureNumber ??
            m.MeasureNumber ?? 0;
          if (n > best) best = n;
        }
      }
      if (best > 0) ends.push(best);
    }
  }
  return ends;
}

/* narrow options type for setOptions */
type MeasureSliceOptions = { drawFromMeasureNumber?: number; drawUpToMeasureNumber?: number; };
function setMeasureOptions(osmd: OSMDInstance, opts: MeasureSliceOptions) {
  (osmd as unknown as { setOptions: (o: MeasureSliceOptions) => void }).setOptions(opts);
}

export default function ScoreOSMD({
  src,
  fillParent = false,
  height = 600,
  debug = false,
  className = "",
  style,
}: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMDInstance | null>(null);

  const resizeObsRef = useRef<ResizeObserver | null>(null);
  const debounceTimer = useRef<number | null>(null);

  // Paging state & cached mapping
  const startSystemRef = useRef<number>(0);
  const linesPerPageRef = useRef<number>(1);
  const systemEndsRef = useRef<number[]>([]); // system k -> last measure number
  const currentRangeRef = useRef<{ from: number; upTo: number }>({ from: 0, upTo: 0 });
  const recomputingRef = useRef<boolean>(false);

  const FIT_PAD_PX = 16;
  const VALIDATE_MAX_STEPS = 3;
  const WHEEL_COOLDOWN_MS = 180;
  const wheelLockRef = useRef<number>(0);

  /* render a page: systems [start .. start + n - 1], using PRECOMPUTED systemEndsRef */
  const renderPage = async (start: number, n: number) => {
    const container = boxRef.current;
    const osmd = osmdRef.current;
    const ends = systemEndsRef.current;
    if (!container || !osmd || ends.length === 0) return;

    const totalSystems = ends.length;
    const lastStart = Math.max(0, totalSystems - n);
    const s = Math.min(Math.max(0, start), lastStart);
    const endIndex = Math.min(totalSystems - 1, s + n - 1);

    const upTo = ends[endIndex];
    const from = s === 0 ? 1 : ends[s - 1] + 1;

    // Only re-render if the measure range actually changes
    if (currentRangeRef.current.from !== from || currentRangeRef.current.upTo !== upTo) {
      setMeasureOptions(osmd, { drawFromMeasureNumber: from, drawUpToMeasureNumber: upTo });
      osmd.render();
      currentRangeRef.current = { from, upTo };
      await afterPaint();
    }

    // Post-slice validation: drop one system if the last still “peeks”
    let steps = 0;
    while (steps < VALIDATE_MAX_STEPS) {
      const bands = analyzeBands(container);
      const limit = container.clientHeight - FIT_PAD_PX;
      const lastBand = bands[bands.length - 1];
      if (!lastBand || lastBand.bottom <= limit) break;

      if (n <= 1) break; // cannot shrink further
      n -= 1;

      const newEndIdx = Math.min(totalSystems - 1, s + n - 1);
      const newUpTo = ends[newEndIdx];
      const newFrom = s === 0 ? 1 : ends[s - 1] + 1;

      if (currentRangeRef.current.from === newFrom && currentRangeRef.current.upTo === newUpTo) break;

      setMeasureOptions(osmd, { drawFromMeasureNumber: newFrom, drawUpToMeasureNumber: newUpTo });
      osmd.render();
      currentRangeRef.current = { from: newFrom, upTo: newUpTo };
      await afterPaint();

      steps += 1;
    }

    startSystemRef.current = s;
  };

  /* Full recompute on size change: full render → build mapping → measure -> decide N -> render page */
  const scheduleRecompute = () => {
    if (debounceTimer.current) {
      window.clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    debounceTimer.current = window.setTimeout(async () => {
      const container = boxRef.current;
      const osmd = osmdRef.current;
      if (!container || !osmd) return;
      if (recomputingRef.current) return;
      recomputingRef.current = true;

      try {
        purgeWebGL(container);

        // 1) FULL render (clear any previous slice)
        setMeasureOptions(osmd, { drawFromMeasureNumber: 1, drawUpToMeasureNumber: Number.MAX_SAFE_INTEGER });
        osmd.render();
        await afterPaint();

        // 2) Build a STABLE system→lastMeasure mapping for the entire score
        systemEndsRef.current = buildSystemMeasureEnds(osmd);

        // 3) DOM-measure page to decide how many lines fit
        const bands = analyzeBands(container);
        const n = linesPerPage(bands, container, FIT_PAD_PX);
        linesPerPageRef.current = n;

        if (debug) {
          // eslint-disable-next-line no-console
          console.table(bands.map((b, i) => ({
            line: i + 1, top: b.top.toFixed(1), bottom: b.bottom.toFixed(1), height: b.height.toFixed(1),
          })));
          // eslint-disable-next-line no-console
          console.log(`linesPerPage = ${n}, totalSystems = ${systemEndsRef.current.length}, startSystem = ${startSystemRef.current}`);
        }

        // 4) Clamp current start index under new totals
        const total = systemEndsRef.current.length;
        const lastStart = Math.max(0, total - n);
        if (startSystemRef.current > lastStart) startSystemRef.current = lastStart;

        // 5) Render that page
        await renderPage(startSystemRef.current, n);
      } finally {
        recomputingRef.current = false;
      }
    }, 120);
  };

  /* Page forward/back by a full set of lines */
  const changePage = async (deltaPages: number) => {
    const total = systemEndsRef.current.length;
    const n = Math.max(1, linesPerPageRef.current);
    if (!total) return;

    const lastStart = Math.max(0, total - n);
    let nextStart = startSystemRef.current + deltaPages * n;
    if (nextStart < 0) nextStart = 0;
    if (nextStart > lastStart) nextStart = lastStart;

    if (nextStart !== startSystemRef.current) {
      await renderPage(nextStart, n);
    }
  };

  // Wheel / keyboard paging (no vertical scroll)
  useEffect(() => {
    const container = boxRef.current;
    if (!container) return;

    const onWheel = (e: WheelEvent) => {
      // Only vertical intent
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      e.preventDefault();

      const now = Date.now();
      if (now < wheelLockRef.current) return; // throttle bursts
      wheelLockRef.current = now + WHEEL_COOLDOWN_MS;

      void changePage(e.deltaY > 0 ? 1 : -1);
    };

    const onKey = (e: KeyboardEvent) => {
      if (["PageDown", "ArrowDown", " "].includes(e.key)) {
        e.preventDefault();
        void changePage(1);
      } else if (["PageUp", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        void changePage(-1);
      }
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    return () => {
      container.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    (async () => {
      if (!boxRef.current) return;
      await afterPaint();

      const { OpenSheetMusicDisplay } =
        (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");

      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }

      const osmd = new OpenSheetMusicDisplay(boxRef.current, {
        backend: "svg" as const, // force SVG backend
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
      startSystemRef.current = 0;
      currentRangeRef.current = { from: 0, upTo: 0 };

      // Initial compute/page
      scheduleRecompute();

      // React to BOTH width and height changes
      if (!resizeObsRef.current) {
        resizeObsRef.current = new ResizeObserver(() => scheduleRecompute());
        resizeObsRef.current.observe(boxRef.current);
      }
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("OSMD init error:", err);
    });

    return () => {
      if (debounceTimer.current) {
        window.clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      if (resizeObsRef.current && boxRef.current) {
        resizeObsRef.current.unobserve(boxRef.current);
      }
      resizeObsRef.current = null;
      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }
    };
  }, [src]);

  // Container: NO vertical scrollbar (we page instead of scrolling)
  const containerStyle: React.CSSProperties = fillParent
    ? { width: "100%", height: "100%", minHeight: 0, overflowY: "hidden", overflowX: "hidden" }
    : { width: "100%", height, minHeight: height, overflowY: "hidden", overflowX: "hidden" };

  return (
    <div
      ref={boxRef}
      className={`osmd-container ${className || ""}`}
      style={{ background: "#fff", ...containerStyle, ...style }}
      tabIndex={0}
    />
  );
}
