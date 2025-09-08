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

function isPromise<T = unknown>(x: unknown): x is Promise<T> {
  return typeof x === "object" && x !== null && "then" in (x as Record<string, unknown>);
}

/** Cluster <g> boxes vertically; also keep each band's max width. */
function measureBands(container: HTMLDivElement) {
  const svg = container.querySelector("svg");
  if (!svg) return [] as Array<{ top: number; bottom: number; height: number; maxWidth: number }>;

  const pageGroups = Array.from(
    svg.querySelectorAll<SVGGElement>(
      'g[id^="osmdCanvasPage"], g[id^="Page"], g[class*="Page"], g[class*="page"]'
    )
  );
  const roots: SVGGElement[] = pageGroups.length ? pageGroups : [svg as unknown as SVGGElement];

  const boxes: Array<{ y: number; bottom: number; height: number; width: number }> = [];
  for (const root of roots) {
    const groups = Array.from(root.querySelectorAll<SVGGElement>("g"));
    for (const g of groups) {
      try {
        const b = g.getBBox();
        if (!isFinite(b.y) || !isFinite(b.height) || !isFinite(b.width)) continue;
        // ignore very small decorative fragments
        if (b.height < 8 || b.width < 40) continue;
        boxes.push({ y: b.y, bottom: b.y + b.height, height: b.height, width: b.width });
      } catch {
        /* ignore */
      }
    }
  }
  if (!boxes.length) return [];

  boxes.sort((a, b) => a.y - b.y);

  const GAP = 24; // px
  const bands: Array<{ top: number; bottom: number; maxWidth: number }> = [];
  for (const b of boxes) {
    const last = bands[bands.length - 1];
    if (!last || b.y - last.bottom > GAP) {
      bands.push({ top: b.y, bottom: b.bottom, maxWidth: b.width });
    } else {
      if (b.y < last.top) last.top = b.y;
      if (b.bottom > last.bottom) last.bottom = b.bottom;
      if (b.width > last.maxWidth) last.maxWidth = b.width;
    }
  }
  return bands.map(b => ({ top: b.top, bottom: b.bottom, height: b.bottom - b.top, maxWidth: b.maxWidth }));
}

/** Heuristic: drop a top header/title band (common cause of +1 count). */
function filterOutHeader(bands: Array<{ top: number; bottom: number; height: number; maxWidth: number }>) {
  if (bands.length < 2) return bands;
  const [first, second] = bands;
  const firstIsHeader =
    first.top < 40 ||                 // very near top margin
    first.height > second.height * 1.5; // much taller than a staff system
  return firstIsHeader ? bands.slice(1) : bands;
}

export default function ScoreOSMD({ src, height = 600, className = "", style }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMDInstance | null>(null);

  const lastWidthRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const resizeObsRef = useRef<ResizeObserver | null>(null);
  const lastSignatureRef = useRef<string>(""); // for dedupe

  const scheduleMeasure = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = requestAnimationFrame(() => {
        if (!boxRef.current) return;
        const raw = measureBands(boxRef.current);
        const systems = filterOutHeader(raw);

        // Build a signature to suppress duplicate logs from multi-trigger
        const sig = `${lastWidthRef.current}|${systems.length}|${systems.map(s => s.height.toFixed(1)).join(",")}`;
        if (sig === lastSignatureRef.current) return;
        lastSignatureRef.current = sig;

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
        console.log(
          `Tallest line → line ${systems.indexOf(tallest) + 1}, height ${tallest.height.toFixed(1)} px`
        );
      });
    });
  };

  useEffect(() => {
    (async () => {
      if (!boxRef.current) return;

      boxRef.current.style.background = "#fff";
      await new Promise<void>(r => requestAnimationFrame(() => r()));
      await new Promise<void>(r => requestAnimationFrame(() => r()));

      const { OpenSheetMusicDisplay } =
        (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");

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

      // Initial measure
      scheduleMeasure();

      // Observe width changes; OSMD will auto-reflow, then we re-measure
      if (!resizeObsRef.current) {
        resizeObsRef.current = new ResizeObserver(entries => {
          const cr = entries[0]?.contentRect;
          if (!cr) return;
          const w = Math.round(cr.width);
          if (w !== lastWidthRef.current) {
            lastWidthRef.current = w;
            scheduleMeasure();
          }
        });
        resizeObsRef.current.observe(boxRef.current);
      }
    })().catch(err => {
      console.error("OSMD load/render error:", err);
    });

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (resizeObsRef.current && boxRef.current) resizeObsRef.current.unobserve(boxRef.current);
      resizeObsRef.current = null;
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
