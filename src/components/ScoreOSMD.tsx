// src/components/ScoreOSMD.tsx
"use client";

import { useEffect, useRef } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

/* --------- Minimal structural types (no `any`) --------- */
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
  /** URL under /public, e.g. "/scores/gymnopedie-no-1-satie.mxl" */
  src: string;
  /** If true, container fills its parent (height:100%) */
  fillParent?: boolean;
  /** Fallback fixed height in px when not filling parent (default 600) */
  height?: number;
  /** Log measurements to console */
  debug?: boolean;
  className?: string;
  style?: React.CSSProperties;
};

/* Helpers */
function isPromise<T = unknown>(x: unknown): x is Promise<T> {
  return typeof x === "object" && x !== null && "then" in (x as Record<string, unknown>);
}
function afterPaint(): Promise<void> {
  return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => res())));
}
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

/* Measure systems (“bands”) from rendered SVG */
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

  const GAP = 24;
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

/* Choose how many systems fit fully by bottom edge */
function linesPerPage(bands: Band[], container: HTMLDivElement, padPx: number): number {
  const limit = container.clientHeight - padPx;
  let count = 0;
  for (const b of bands) {
    if (b.bottom <= limit) count += 1;
    else break;
  }
  return Math.max(1, count); // always show at least one line
}

/* Map system index → last measure number */
function lastMeasureOfSystem(osmd: OSMDInstance, systemIndex: number): number {
  const gms = osmd.GraphicalMusicSheet;
  const page0: MusicPage | undefined = gms?.MusicPages?.[0];
  const sys: MusicSystem | undefined = page0?.MusicSystems?.[systemIndex];
  if (!sys) return 0;

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
  return best;
}

/* Narrow options type for setOptions */
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

  // Paging state (by system index)
  const startSystemRef = useRef<number>(0);
  const linesPerPageRef = useRef<number>(1);
  const totalSystemsRef = useRef<number>(0);
  const currentUpToRef = useRef<number>(0);
  const recomputingRef = useRef<boolean>(false);

  const FIT_PAD_PX = 16;           // prevents “peek” at bottom
  const VALIDATE_MAX_STEPS = 3;    // post-slice validation cap

  /** Render a specific “page” starting at system index s for n lines */
  const renderPage = async (s: number, n: number) => {
    const container = boxRef.current;
    const osmd = osmdRef.current;
    if (!container || !osmd) return;

    // Boundaries
    const lastStart = Math.max(0, totalSystemsRef.current - n);
    const start = Math.min(Math.max(0, s), Math.max(0, lastStart));
    const endSystemIndex = Math.min(totalSystemsRef.current - 1, start + n - 1);

    // Compute measure range
    const upTo = lastMeasureOfSystem(osmd, endSystemIndex);
    const from = start === 0 ? 1 : lastMeasureOfSystem(osmd, start - 1) + 1;

    // Apply slice only if changed
    if (upTo !== currentUpToRef.current || from === 1 && start !== 0) {
      setMeasureOptions(osmd, { drawFromMeasureNumber: from, drawUpToMeasureNumber: upTo });
      osmd.render();
      currentUpToRef.current = upTo;
      startSystemRef.current = start;
      await afterPaint();
    }

    // Post-slice validate: if end still peeks, drop one system and retry (few times)
    let steps = 0;
    while (steps < VALIDATE_MAX_STEPS) {
      const bands = analyzeBands(container);
      const limit = container.clientHeight - FIT_PAD_PX;
      const lastBand = bands[bands.length - 1];
      if (!lastBand) break;
      if (lastBand.bottom <= limit) break;

      // drop one system (but keep at least 1)
      if (n <= 1) break;
      n -= 1;
      const newEndSys = Math.min(totalSystemsRef.current - 1, start + n - 1);
      const newUpTo = lastMeasureOfSystem(osmd, newEndSys);
      if (newUpTo === currentUpToRef.current) break;

      setMeasureOptions(osmd, {
        drawFromMeasureNumber: start === 0 ? 1 : lastMeasureOfSystem(osmd, start - 1) + 1,
        drawUpToMeasureNumber: newUpTo,
      });
      osmd.render();
      currentUpToRef.current = newUpTo;
      await afterPaint();
      steps += 1;
    }
  };

  /** Recompute layout: measure full, decide n lines per page, render current page */
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

        // Full render
        setMeasureOptions(osmd, { drawFromMeasureNumber: 1, drawUpToMeasureNumber: Number.MAX_SAFE_INTEGER });
        osmd.render();
        await afterPaint();

        // Measure systems & decide lines per page
        const bands = analyzeBands(container);
        totalSystemsRef.current = bands.length;

        const n = linesPerPage(bands, container, FIT_PAD_PX);
        linesPerPageRef.current = n;

        if (debug) {
          // eslint-disable-next-line no-console
          console.table(bands.map((b, i) => ({
            line: i + 1, top: b.top.toFixed(1), bottom: b.bottom.toFixed(1), height: b.height.toFixed(1),
          })));
          // eslint-disable-next-line no-console
          console.log(`linesPerPage = ${n}, totalSystems = ${bands.length}, startSystem = ${startSystemRef.current}`);
        }

        // Ensure current start index is valid under new n/total
        const lastStart = Math.max(0, bands.length - n);
        if (startSystemRef.current > lastStart) startSystemRef.current = lastStart;

        await renderPage(startSystemRef.current, n);
        purgeWebGL(container);
      } finally {
        recomputingRef.current = false;
      }
    }, 120);
  };

  /** Page forward/back by a full set of lines */
  const changePage = async (deltaPages: number) => {
    const n = Math.max(1, linesPerPageRef.current);
    const total = totalSystemsRef.current;
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
      changePage(e.deltaY > 0 ? 1 : -1);
    };

    const onKey = (e: KeyboardEvent) => {
      if (["PageDown", "ArrowDown", " "].includes(e.key)) {
        e.preventDefault();
        changePage(1);
      } else if (["PageUp", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        changePage(-1);
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
      currentUpToRef.current = 0;
      startSystemRef.current = 0;

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

  // Container sizing: note `overflowY: hidden` → no vertical scrollbar
  const containerStyle: React.CSSProperties = fillParent
    ? { width: "100%", height: "100%", minHeight: 0, overflowY: "hidden", overflowX: "hidden" }
    : { width: "100%", height, minHeight: height, overflowY: "hidden", overflowX: "hidden" };

  return (
    <div
      ref={boxRef}
      className={`osmd-container ${className || ""}`}
      style={{ background: "#fff", ...containerStyle, ...style }}
      tabIndex={0} // so the container can receive keyboard focus if needed
    />
  );
}
