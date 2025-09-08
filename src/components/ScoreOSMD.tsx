// src/components/ScoreOSMD.tsx
"use client";

import { useEffect, useRef } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

/* --------- Minimal structural types to avoid `any` --------- */
interface SourceMeasure { MeasureNumber?: number }
interface GraphicalMeasure {
  SourceMeasure?: SourceMeasure;
  ParentMeasure?: { SourceMeasure?: SourceMeasure };
  Parent?: { SourceMeasure?: SourceMeasure };
  MeasureNumber?: number;
}
interface StaffLine {
  Measures?: GraphicalMeasure[];
  measures?: GraphicalMeasure[]; // some builds use lowercase
}
interface MusicSystem {
  StaffLines?: StaffLine[];
  staffLines?: StaffLine[]; // some builds use lowercase
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
  className?: string;
  style?: React.CSSProperties;
};

/* Await-if-promise helper (OSMD typings differ across versions) */
function isPromise<T = unknown>(x: unknown): x is Promise<T> {
  return typeof x === "object" && x !== null && "then" in (x as Record<string, unknown>);
}

/* rAF x2 to ensure layout + paint finished before DOM reads */
function afterPaint(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
}

/* Measure vertical “bands” (systems) from rendered SVG */
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
        /* skip non-rendered nodes */
      }
    }
  }

  boxes.sort((a, b) => a.y - b.y);

  // Cluster vertically into bands/systems
  const GAP = 24; // px
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

/* Compute index of last fully visible system that fits in container height */
function computeLastFullyVisibleIndex(
  systems: Array<{ top: number; bottom: number; height: number }>,
  container: HTMLDivElement
) {
  const maxH = container.clientHeight;
  let sum = 0;
  for (let i = 0; i < systems.length; i++) {
    const h = Math.max(0, systems[i].height);
    if (h === 0) continue;
    if (sum + h <= maxH) {
      sum += h;
    } else {
      return i - 1; // previous line fit, current would overflow
    }
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

/* Narrowed type for calling setOptions with just the measure slice fields */
type MeasureSliceOptions = {
  drawFromMeasureNumber?: number;
  drawUpToMeasureNumber?: number;
};

/* Safe helper to call osmd.setOptions with our narrow options type */
function setMeasureOptions(osmd: OSMDInstance, opts: MeasureSliceOptions) {
  // Structural call without `any`
  (osmd as unknown as { setOptions: (o: MeasureSliceOptions) => void }).setOptions(opts);
}

export default function ScoreOSMD({
  src,
  fillParent = false,
  height = 600,
  className = "",
  style,
}: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMDInstance | null>(null);

  // control flags
  const debounceTimer = useRef<number | null>(null);
  const isSlicingRef = useRef<boolean>(false);
  const currentUpToRef = useRef<number>(0);

  // Debounced recompute: full render → measure → slice
  const scheduleRecompute = () => {
    if (debounceTimer.current) {
      window.clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    debounceTimer.current = window.setTimeout(async () => {
      const container = boxRef.current;
      const osmd = osmdRef.current;
      if (!container || !osmd) return;
      if (isSlicingRef.current) return;

      isSlicingRef.current = true;
      try {
        // 1) Full render (remove any previous slice)
        setMeasureOptions(osmd, {
          drawFromMeasureNumber: 1,
          drawUpToMeasureNumber: Number.MAX_SAFE_INTEGER,
        });
        osmd.render();
        await afterPaint();

        // 2) Measure systems from DOM
        const systems = analyzeBands(container);
        if (!systems.length) {
          isSlicingRef.current = false;
          return;
        }

        // 3) Decide how many lines fit fully
        const lastIdx = computeLastFullyVisibleIndex(systems, container);
        const safeIdx = Math.max(0, lastIdx); // ensure at least first line

        // 4) Map that system to its last measure number
        const upToMeasure = getLastMeasureNumberForSystem(osmd, safeIdx);
        if (upToMeasure && upToMeasure !== currentUpToRef.current) {
          setMeasureOptions(osmd, { drawFromMeasureNumber: 1, drawUpToMeasureNumber: upToMeasure });
          osmd.render();
          currentUpToRef.current = upToMeasure;
          await afterPaint();
        }
      } catch (err) {
        // Log without disabling eslint rules
        // eslint-disable-next-line no-console
        console.error("Slice recalculation error:", err);
      } finally {
        isSlicingRef.current = false;
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

      const osmd = new OpenSheetMusicDisplay(boxRef.current, {
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

      // Observe DOM mutations (OSMD reflows/updates SVG), then recompute slice
      const mo = new MutationObserver(() => scheduleRecompute());
      mo.observe(boxRef.current, { subtree: true, childList: true, attributes: true });

      // Initial slice
      scheduleRecompute();

      // cleanup observer on effect re-run/unmount
      return () => mo.disconnect();
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("OSMD init error:", err);
    });

    return () => {
      if (debounceTimer.current) {
        window.clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
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
