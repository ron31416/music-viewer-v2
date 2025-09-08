// src/components/ScoreOSMD.tsx
"use client";

import { useEffect, useRef } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

type OSMDInstance = OpenSheetMusicDisplay & { dispose?: () => void; clear?: () => void };

type Props = {
  src: string;                 // e.g. "/scores/gymnopedie-no-1-satie.mxl"
  height?: number;             // px, default 600
  className?: string;
  style?: React.CSSProperties;
};

// Await-if-promise helper
function isPromise<T = unknown>(x: unknown): x is Promise<T> {
  return typeof x === "object" && x !== null && "then" in (x as Record<string, unknown>);
}

/** Robust DOM-based system measurement: cluster <g> layers by vertical bands */
function measureSystemsFromDOM(container: HTMLDivElement) {
  const svg = container.querySelector("svg");
  if (!svg) return [] as Array<{ top: number; bottom: number; height: number }>;

  const pageGroups = Array.from(
    svg.querySelectorAll<SVGGElement>(
      [
        'g[id^="osmdCanvasPage"]',
        'g[id^="Page"]',
        'g[class*="Page"]',
        'g[class*="page"]',
      ].join(",")
    )
  );
  const roots: SVGGElement[] = pageGroups.length ? pageGroups : [svg as unknown as SVGGElement];

  const boxes: Array<{ y: number; bottom: number; height: number; width: number }> = [];
  roots.forEach(root => {
    const groups = Array.from(root.querySelectorAll<SVGGElement>("g"));
    for (const g of groups) {
      try {
        const b = g.getBBox();
        if (!isFinite(b.y) || !isFinite(b.height) || !isFinite(b.width)) continue;
        if (b.height < 8 || b.width < 40) continue; // ignore tiny elements
        boxes.push({ y: b.y, bottom: b.y + b.height, height: b.height, width: b.width });
      } catch {
        /* ignore */
      }
    }
  });

  if (!boxes.length) return [];

  boxes.sort((a, b) => a.y - b.y);

  const GAP = 24; // px vertical gap to start a new system band
  const bands: Array<{ top: number; bottom: number }> = [];
  for (const b of boxes) {
    const last = bands[bands.length - 1];
    if (!last) {
      bands.push({ top: b.y, bottom: b.bottom });
    } else if (b.y - last.bottom > GAP) {
      bands.push({ top: b.y, bottom: b.bottom });
    } else {
      if (b.y < last.top) last.top = b.y;
      if (b.bottom > last.bottom) last.bottom = b.bottom;
    }
  }

  return bands.map(b => ({ top: b.top, bottom: b.bottom, height: b.bottom - b.top }));
}

export default function ScoreOSMD({ src, height = 600, className = "", style }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMDInstance | null>(null);
  const lastWidthRef = useRef<number | null>(null);
  const rafHandleRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  // Log a concise table of system heights
  const logSystems = (container: HTMLDivElement) => {
    const systems = measureSystemsFromDOM(container);
    if (!systems.length) {
      console.warn("No systems detected during measurement.");
      return;
    }
    console.table(
      systems.map((s, i) => ({
        line: i + 1,
        top: s.top.toFixed(1),
        bottom: s.bottom.toFixed(1),
        height: s.height.toFixed(1),
      }))
    );
    const tallest = systems.reduce((a, b) => (b.height > a.height ? b : a), systems[0]);
    console.log(`Tallest line → line ${systems.indexOf(tallest) + 1}, height ${tallest.height.toFixed(1)} px`);
  };

  // Schedule measurement after OSMD's auto-resize re-render completes
  const scheduleMeasure = () => {
    if (!boxRef.current) return;
    if (rafHandleRef.current !== null) {
      cancelAnimationFrame(rafHandleRef.current);
      rafHandleRef.current = null;
    }
    // Two RAFs to allow OSMD to lay out + the browser to paint
    rafHandleRef.current = requestAnimationFrame(() => {
      rafHandleRef.current = requestAnimationFrame(() => {
        if (boxRef.current) logSystems(boxRef.current);
      });
    });
  };

  useEffect(() => {
    (async () => {
      if (!boxRef.current) return;

      // Ensure space & settled layout before initial render
      boxRef.current.style.background = "#fff";
      await new Promise<void>(r => requestAnimationFrame(() => r()));
      await new Promise<void>(r => requestAnimationFrame(() => r()));

      const { OpenSheetMusicDisplay } =
        (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");

      // Clean previous instance (dev hot-reloads / StrictMode)
      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }

      const osmd = new OpenSheetMusicDisplay(boxRef.current, {
        autoResize: true, // OSMD will re-render on resize
        drawTitle: true,
        drawSubtitle: true,
        drawComposer: true,
        drawLyricist: true,
      }) as OSMDInstance;
      osmdRef.current = osmd;

      const maybe = osmd.load(src);
      if (isPromise(maybe)) await maybe;

      osmd.render();

      // Measure once after initial render
      scheduleMeasure();

      // Observe container width changes and re-measure after OSMD reflows
      if (!resizeObserverRef.current) {
        resizeObserverRef.current = new ResizeObserver(entries => {
          const entry = entries[0];
          const cr = entry?.contentRect;
          if (!cr) return;
          const w = Math.round(cr.width);
          if (w !== lastWidthRef.current) {
            lastWidthRef.current = w;
            // OSMD (autoResize:true) will re-render; we measure right after
            scheduleMeasure();
          }
        });
        resizeObserverRef.current.observe(boxRef.current);
      }
    })().catch(err => {
      console.error("OSMD load/render error:", err);
    });

    return () => {
      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current);
        rafHandleRef.current = null;
      }
      if (resizeObserverRef.current && boxRef.current) {
        resizeObserverRef.current.unobserve(boxRef.current);
      }
      resizeObserverRef.current = null;
      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }
    };
  }, [src]);

  return (
    <div
      ref={boxRef}
      className={className}
      style={{ width: "100%", minHeight: height, height, overflow: "auto", ...style }}
    />
  );
}
