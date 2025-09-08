"use client";

import { useEffect, useRef } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

type OSMDInstance = OpenSheetMusicDisplay & { dispose?: () => void; clear?: () => void };

type Props = {
  src: string;
  height?: number;            // px, default 600
  className?: string;
  style?: React.CSSProperties;
};

function isPromise<T = unknown>(x: unknown): x is Promise<T> {
  return typeof x === "object" && x !== null && "then" in (x as Record<string, unknown>);
}

/** Cluster <g> boxes vertically; compute band features for filtering. */
function analyzeBands(container: HTMLDivElement) {
  const svg = container.querySelector("svg");
  if (!svg) return { bands: [] as Band[], svgWidth: 0 };

  type Box = { y: number; bottom: number; height: number; width: number; el: SVGGElement | SVGGraphicsElement };
  type Band = { top: number; bottom: number; height: number; maxWidth: number; verticalLines: number };

  const pageRoots = Array.from(
    svg.querySelectorAll<SVGGElement>(
      'g[id^="osmdCanvasPage"], g[id^="Page"], g[class*="Page"], g[class*="page"]'
    )
  );
  const roots: (SVGGElement | SVGSVGElement)[] = pageRoots.length ? pageRoots : [svg];

  const boxes: Box[] = [];
  for (const root of roots) {
    const groups = Array.from(root.querySelectorAll<SVGGElement>("g"));
    for (const g of groups) {
      try {
        const b = g.getBBox();
        if (!isFinite(b.y) || !isFinite(b.height) || !isFinite(b.width)) continue;
        if (b.height < 8 || b.width < 40) continue; // ignore tiny fragments
        boxes.push({ y: b.y, bottom: b.y + b.height, height: b.height, width: b.width, el: g });
      } catch { /* ignore */ }
    }
  }
  if (!boxes.length) return { bands: [] as Band[], svgWidth: (svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width) || svg.clientWidth || 0 };

  boxes.sort((a, b) => a.y - b.y);

  const GAP = 24; // px
  const rawBands: { top: number; bottom: number; members: Box[] }[] = [];
  for (const b of boxes) {
    const last = rawBands[rawBands.length - 1];
    if (!last || b.y - last.bottom > GAP) {
      rawBands.push({ top: b.y, bottom: b.bottom, members: [b] });
    } else {
      if (b.y < last.top) last.top = b.y;
      if (b.bottom > last.bottom) last.bottom = b.bottom;
      last.members.push(b);
    }
  }

  // Feature: count tall vertical lines in each band (barlines/brackets are strong “system” signals)
  function countVerticals(members: Box[]) {
    let count = 0;
    for (const m of members) {
      const lines = Array.from(m.el.querySelectorAll<SVGLineElement>("line"));
      for (const ln of lines) {
        const x1 = Number(ln.getAttribute("x1") || "0");
        const x2 = Number(ln.getAttribute("x2") || "0");
        const y1 = Number(ln.getAttribute("y1") || "0");
        const y2 = Number(ln.getAttribute("y2") || "0");
        const dx = Math.abs(x1 - x2);
        const dy = Math.abs(y1 - y2);
        if (dx <= 1 && dy > 30) count++; // thin & tall
      }
      // Some editions draw barlines as skinny rects/paths; approximate via bbox ratio
      const paths = Array.from(m.el.querySelectorAll<SVGGraphicsElement>("path,rect"));
      for (const p of paths) {
        try {
          const bb = p.getBBox();
          if (bb.width <= 2 && bb.height > 30) count++;
        } catch { /* ignore */ }
      }
    }
    return count;
  }

  const bands: Band[] = rawBands.map(b => {
    const maxWidth = Math.max(...b.members.map(m => m.width));
    return { top: b.top, bottom: b.bottom, height: b.bottom - b.top, maxWidth, verticalLines: countVerticals(b.members) };
  });

  const svgWidth = (svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width) || svg.clientWidth || 0;
  return { bands, svgWidth };
}

/** Drop the top header/title band using stronger heuristics. */
function dropHeaderIfPresent(bands: ReturnType<typeof analyzeBands>["bands"], svgWidth: number) {
  if (bands.length < 2) return bands;
  const [first, second] = bands;

  // Median height among all bands (excluding the first for robustness)
  const restHeights = bands.slice(1).map(b => b.height).sort((a, b) => a - b);
  const median = restHeights.length
    ? restHeights[Math.floor(restHeights.length / 2)]
    : second.height;

  const widthCov = svgWidth ? first.maxWidth / svgWidth : 1; // 0..1
  const looksLikeHeader =
    first.verticalLines <= 1 &&                              // little to no barlines
    (first.height > median * 1.3 || first.height > 80) &&   // unusually tall
    widthCov < 0.9;                                         // usually not full width

  return looksLikeHeader ? bands.slice(1) : bands;
}

export default function ScoreOSMD({ src, height = 600, className = "", style }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMDInstance | null>(null);

  const lastWidthRef = useRef<number | null>(null);
  const debounceTimer = useRef<number | null>(null);
  const resizeObsRef = useRef<ResizeObserver | null>(null);
  const lastSigRef = useRef<string>("");

  const logOnce = () => {
    if (!boxRef.current) return;
    const { bands, svgWidth } = analyzeBands(boxRef.current);
    const systems = dropHeaderIfPresent(bands, svgWidth);

    const sig = `${lastWidthRef.current}|${systems.length}|${systems.map(s => s.height.toFixed(1)).join(",")}`;
    if (sig === lastSigRef.current) return; // dedupe identical results
    lastSigRef.current = sig;

    if (!systems.length) {
      console.warn("No systems detected during measurement.");
      return;
    }
    // Force a fresh array literal so DevTools renders a table reliably
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

  const scheduleLog = () => {
    if (debounceTimer.current) {
      window.clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    // Debounce bursty resize/reflow events
    debounceTimer.current = window.setTimeout(logOnce, 120);
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

      // Initial measure (debounced to allow any immediate auto-resize)
      scheduleLog();

      // Observe width changes
      if (!resizeObsRef.current) {
        resizeObsRef.current = new ResizeObserver(entries => {
          const w = Math.round(entries[0]?.contentRect?.width ?? 0);
          if (w && w !== lastWidthRef.current) {
            lastWidthRef.current = w;
            scheduleLog();
          }
        });
        resizeObsRef.current.observe(boxRef.current);
      }
    })().catch(err => {
      console.error("OSMD load/render error:", err);
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

  return (
    <div
      ref={boxRef}
      className={className}
      style={{ width: "100%", minHeight: height, height, overflow: "auto", ...style }}
    />
  );
}
