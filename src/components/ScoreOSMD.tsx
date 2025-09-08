// src/components/ScoreOSMD.tsx
"use client";

import { useEffect, useRef } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

type OSMDInstance = OpenSheetMusicDisplay & {
  dispose?: () => void;
  clear?: () => void;
  GraphicalMusicSheet?: any;
};

type Props = {
  /** URL under /public, e.g. "/scores/gymnopedie-no-1-satie.mxl" */
  src: string;
  /** If true, container fills its parent (height:100%) */
  fillParent?: boolean;
  /** Fallback fixed height in px when not filling parent (default 600) */
  height?: number;
  className?: string;
  style?: React.CSSProperties;
};

/* Await-if-promise helper (OSMD typings vary by version) */
function isPromise<T = unknown>(x: unknown): x is Promise<T> {
  return typeof x === "object" && x !== null && "then" in (x as Record<string, unknown>);
}

/* rAF x2 helper to ensure DOM/layout is fully painted */
function afterPaint(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

/* Measure visible systems by clustering <g> groups vertically in the rendered SVG */
function analyzeBands(container: HTMLDivElement) {
  const svg = container.querySelector("svg");
  if (!svg) return [] as Array<{ top: number; bottom: number; height: number }>;

  const pageRoots = Array.from(
    svg.querySelectorAll<SVGGElement>(
      'g[id^="osmdCanvasPage"], g[id^="Page"], g[class*="Page"], g[class*="page"]'
    )
  );
  const roots: (SVGGElement | SVGSVGElement)[] = pageRoots.length ? pageRoots : [svg];

  const boxes: Array<{ y: number; bottom: number; height: number; width: number }> = [];
  for (const root of roots) {
    const groups = Array.from(root.querySelectorAll<SVGGElement>("g"));
    for (const g of groups) {
      try {
        const b = g.getBBox();
        if (!isFinite(b.y) || !isFinite(b.height) || !isFinite(b.width)) continue;
        if (b.height < 8 || b.width < 40) continue; // skip tiny fragments
        boxes.push({ y: b.y, bottom: b.y + b.height, height: b.height, width: b.width });
      } catch { /* ignore */ }
    }
  }

  boxes.sort((a, b) => a.y - b.y);

  const GAP = 24; // px gap to start a new band/system
  const bands: Array<{ top: number; bottom: number; height: number }> = [];
  for (const b of boxes) {
    const last = bands[bands.length - 1];
    if (!last || b.y - last.bottom > GAP) {
      bands.push({ top: b.y, bottom: b.bottom, height: b.bottom - b.y });
    } else {
      if (b.y < last.top) last.top = b.y;
      if (b.bottom > last.bottom) last.bottom = b.bottom;
      last.height = last.bottom - last.top;
    }
  }
  return bands;
}

/* Find how many systems fit fully into the container’s clientHeight */
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
      continue;
    }
    return i - 1; // previous line was last fully visible
  }
  return systems.length - 1; // all fit
}

/* Map a system index (on page 1) to its LAST measure number across staves */
function getLastMeasureNumberForSystem(osmd: OSMDInstance, systemIndex: number): number {
  try {
    const gms = osmd.GraphicalMusicSheet;
    const page0 = gms?.MusicPages?.[0];
    const sys = page0?.MusicSystems?.[systemIndex];
    if (!sys) return 0;

    // Try common shapes across OSMD versions:
    // sys.StaffLines[*].Measures[*].SourceMeasure.MeasureNumber
    let best = 0;
    const staffLines = sys.StaffLines ?? sys.staffLines ?? [];
    for (const sl of staffLines) {
      const measures = sl.Measures ?? sl.measures ?? [];
      for (const m of measures) {
        const n =
          m?.SourceMeasure?.MeasureNumber ??
          m?.ParentMeasure?.SourceMeasure?.MeasureNumber ??
          m?.Parent?.SourceMeasure?.MeasureNumber ??
          m?.MeasureNumber ??
          0;
        if (n > best) best = n;
      }
    }
    return best;
  } catch {
    return 0;
  }
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
  const currentUpToRef = useRef<number>(0); // track current drawUpToMeasureNumber we applied

  // Debounced recompute-and-slice: FULL render → measure → SLICE
  const scheduleRecompute = () => {
    if (debounceTimer.current) {
      window.clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    debounceTimer.current = window.setTimeout(async () => {
      const container = boxRef.current;
      const osmd = osmdRef.current;
      if (!container || !osmd) return;

      // Avoid overlapping runs
      if (isSlicingRef.current) return;
      isSlicingRef.current = true;

      try {
        // 1) FULL render (remove measure limits by setting a huge upper bound)
        osmd.setOptions({
          drawFromMeasureNumber: 1,
          drawUpToMeasureNumber: Number.MAX_SAFE_INTEGER,
        } as any);
        osmd.render();
        await afterPaint();

        // 2) Measure systems from DOM
        const systems = analyzeBands(container);
        if (!systems.length) {
          // Nothing measurable — bail
          isSlicingRef.current = false;
          return;
        }

        // 3) Decide how many lines fit fully
        const lastIdx = computeLastFullyVisibleIndex(systems, container);
        if (lastIdx < 0) {
          // Nothing fits (?) — show just the first system
          const upTo = getLastMeasureNumberForSystem(osmd, 0) || 1;
          if (upTo && upTo !== currentUpToRef.current) {
            osmd.setOptions({ drawFromMeasureNumber: 1, drawUpToMeasureNumber: upTo } as any);
            osmd.render();
            currentUpToRef.current = upTo;
          }
          isSlicingRef.current = false;
          return;
        }

        // 4) Map that system to its last measure number
        const upToMeasure = getLastMeasureNumberForSystem(osmd, lastIdx);
        if (!upToMeasure) {
          // Fallback: leave full
          isSlicingRef.current = false;
          return;
        }

        // 5) Apply slice only if changed (prevents loops)
        if (upToMeasure !== currentUpToRef.current) {
          osmd.setOptions({ drawFromMeasureNumber: 1, drawUpToMeasureNumber: upToMeasure } as any);
          osmd.render();
          currentUpToRef.current = upToMeasure;
          await afterPaint();
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("Slice recalculation error:", e);
      } finally {
        isSlicingRef.current = false;
      }
    }, 120); // small debounce to batch reflows
  };

  useEffect(() => {
    (async () => {
      if (!boxRef.current) return;

      // settle layout
      await afterPaint();

      const { OpenSheetMusicDisplay } =
        (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");

      // clean prior
      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }

      const osmd = new OpenSheetMusicDisplay(boxRef.current, {
        autoResize: true, // let OSMD reflow on width changes
        drawTitle: true,
        drawSubtitle: true,
        drawComposer: true,
        drawLyricist: true,
      }) as OSMDInstance;
      osmdRef.current = osmd;

      // load + base render
      const maybe = osmd.load(src);
      if (isPromise(maybe)) await maybe;
      osmd.render();
      currentUpToRef.current = 0; // reset any prior slice

      // Observe real DOM mutations (SVG updates), then recompute-and-slice
      const mo = new MutationObserver(() => scheduleRecompute());
      mo.observe(boxRef.current, { subtree: true, childList: true, attributes: true });

      // Kick initial recompute-and-slice
      scheduleRecompute();

      // Cleanup observer on unmount
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
