"use client";

import { useEffect, useRef } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

/* ---- Minimal structural types (no `any`) ---- */
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
  /** If true, container fills its parent (height: 100%) */
  fillParent?: boolean;
  /** Fallback fixed height in px when not filling parent (default 600) */
  height?: number;
  /** Log measurements to console on each recompute */
  debug?: boolean;
  className?: string;
  style?: React.CSSProperties;
};

/* Await-if-promise helper */
function isPromise<T = unknown>(x: unknown): x is Promise<T> {
  return typeof x === "object" && x !== null && "then" in (x as Record<string, unknown>);
}

/* rAF x2 to ensure layout + paint finished before DOM reads */
function afterPaint(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
}

/* Explicitly kill any WebGL contexts inside a node (paranoid cleanup) */
function purgeWebGL(node: HTMLElement) {
  const canvases = Array.from(node.querySelectorAll("canvas"));
  for (const c of canvases) {
    try {
      const gl =
        (c.getContext("webgl") as WebGLRenderingContext | null) ||
        (c.getContext("experimental-webgl") as WebGLRenderingContext | null) ||
        (c.getContext("webgl2") as WebGL2RenderingContext | null);
      if (gl) {
        const lose = gl.getExtension("WEBGL_lose_context");
        if (lose && typeof lose.loseContext === "function") {
          lose.loseContext();
        }
      }
      // Remove the canvas to ensure the context is GC'ed
      if (c.parentNode) c.parentNode.removeChild(c);
    } catch {
      /* ignore */
    }
  }
}

/* Measure vertical bands (systems) from rendered SVG */
function analyzeBands(container: HTMLDivElement) {
  const svg = container.querySelector("svg");
  if (!svg) return [] as Array<{ top: number; bottom: number; height: number }>;

  const pageRoots = Array.from(
    svg.querySelectorAll<SVGGElement>(
      'g[id^="osmdCanvasPage"], g[id^="Page"], g[class*="Page"], g[class*="page"]'
    )
  );
  const roots: Array<SVGGElement | SVGSVGElement> = pageRoots.length ? pageRoots : [svg];

  type Box = { y: number; bottom: number; height: number; width: number };

  const boxes: Box[] = [];
  for (const root of roots) {
    const groups = Array.from(root.querySelectorAll<SVGGElement>("g"));
    for (const g of groups) {
      try {
        const b = g.getBBox();
        if (!Number.isFinite(b.y) || !Number.isFinite(b.height) || !Number.isFinite(b.width)) continue;
        if (b.height < 8 || b.width < 40) continue; // ignore tiny fragments
        boxes.push({ y: b.y, bottom: b.y + b.height, height: b.height, width: b.width });
      } catch {
        /* non-rendered nodes */
      }
    }
  }

  boxes.sort((a, b) => a.y - b.y);

  const GAP = 24; // px gap to start a new band/system
  const bands: Array<{ top: number; bottom: number; height: number }> = [];
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

/* Index of last fully visible system that fits in container height */
function computeLastFullyVisibleIndex(
  systems: Array<{ top: number; bottom: number; height: number }>,
  container: HTMLDivElement,
  safetyPadPx: number
) {
  const maxH = container.clientHeight - safetyPadPx; // <- subtract margin to avoid peeking
  let sum = 0;
  for (let i = 0; i < systems.length; i++) {
    const h = Math.max(0, systems[i].height);
    if (h === 0) continue;
    if (sum + h <= maxH) sum += h;
    else return i - 1; // previous fit, current would overflow
  }
  return systems.length - 1; // all fit
}

/* Map a page-1 system index to its LAST measure number across staves */
function getLastMeasureNumberForSystem(osmd: OSMDInstance, systemIndex: number): number {
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
        m.MeasureNumber ??
        0;
      if (n > best) best = n;
    }
  }
  return best;
}

/* Narrow options type for setOptions */
type MeasureSliceOptions = {
  drawFromMeasureNumber?: number;
  drawUpToMeasureNumber?: number;
};

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
  const recomputingRef = useRef<boolean>(false);
  const currentUpToRef = useRef<number>(0);

  // Small margin to prevent “peek” of next system (slurs/phrases)
  const FIT_PAD_PX = 8;

  // Debounced recompute driven by WIDTH changes (and initial load)
  const scheduleRecompute = () => {
    if (debounceTimer.current) {
      window.clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    debounceTimer.current = window.setTimeout(async () => {
      const container = boxRef.current;
      const osmd = osmdRef.current;
      if (!container || !osmd) return;
      if (recomputingRef.current) return; // guard

      recomputingRef.current = true;
      try {
        // Preserve scroll position so the view doesn't jump
        const prevScrollTop = container.scrollTop;

        // Paranoid: clear any stray WebGL canvases before rendering
        purgeWebGL(container);

        // Phase 1: full render (remove slice)
        setMeasureOptions(osmd, {
          drawFromMeasureNumber: 1,
          drawUpToMeasureNumber: Number.MAX_SAFE_INTEGER,
        });
        osmd.render();
        await afterPaint();

        // Measure systems from DOM
        const systems = analyzeBands(container);
        if (!systems.length) {
          recomputingRef.current = false;
          return;
        }

        // (Optional) debug output
        if (debug) {
          // eslint-disable-next-line no-console
          console.table(
            systems.map((s, i) => ({
              line: i + 1,
              top: s.top.toFixed(1),
              bottom: s.bottom.toFixed(1),
              height: s.height.toFixed(1),
            }))
          );
        }

        // Decide how many lines fit fully (at least 1), with safety pad
        const lastIdx = Math.max(
          0,
          computeLastFullyVisibleIndex(systems, container, FIT_PAD_PX)
        );

        // Map that system to its last measure number
        const upToMeasure = getLastMeasureNumberForSystem(osmd, lastIdx);

        // Phase 2: apply slice only if changed
        if (upToMeasure && upToMeasure !== currentUpToRef.current) {
          setMeasureOptions(osmd, {
            drawFromMeasureNumber: 1,
            drawUpToMeasureNumber: upToMeasure,
          });
          osmd.render();
          currentUpToRef.current = upToMeasure;
          await afterPaint();
        }

        // Restore scrollTop (prevents bouncing to top)
        container.scrollTop = prevScrollTop;

        // Paranoid again after render
        purgeWebGL(container);
      } finally {
        recomputingRef.current = false;
      }
    }, 120);
  };

  useEffect(() => {
    (async () => {
      if (!boxRef.current) return;
      await afterPaint();

      const { OpenSheetMusicDisplay } =
        (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");

      // Cleanup any prior instance
      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }

      // Force SVG backend to avoid canvas/WebGL contexts
      const osmd = new OpenSheetMusicDisplay(boxRef.current, {
        backend: "svg" as const,
        autoResize: true,
        drawTitle: true,
        drawSubtitle: true,
        drawComposer: true,
        drawLyricist: true,
      }) as OSMDInstance;
      osmdRef.current = osmd;

      // Load + initial render
      const maybe = osmd.load(src);
      if (isPromise(maybe)) await maybe;
      osmd.render();
      currentUpToRef.current = 0;

      // Recompute once after first paint
      scheduleRecompute();

      // Observe container **width** only; OSMD auto-resizes on width changes
      if (!resizeObsRef.current) {
        resizeObsRef.current = new ResizeObserver((entries) => {
          const w = Math.round(entries[0]?.contentRect?.width ?? 0);
          if (w) scheduleRecompute();
        });
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

  // Container sizing
  const containerStyle: React.CSSProperties = fillParent
    ? { width: "100%", height: "100%", minHeight: 0, overflowY: "auto", overflowX: "hidden" }
    : { width: "100%", height, minHeight: height, overflowY: "auto", overflowX: "hidden" };

  return (
    <div
      ref={boxRef}
      className={`osmd-container ${className || ""}`}
      style={{ background: "#fff", ...containerStyle, ...style }}
    />
  );
}
