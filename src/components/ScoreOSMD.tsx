// src/components/ScoreOSMD.tsx
"use client";

import { useEffect, useRef } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

type OSMDInstance = OpenSheetMusicDisplay & { dispose?: () => void; clear?: () => void };

type Props = {
  src: string;                // e.g. "/scores/gymnopedie-no-1-satie.mxl"
  height?: number;            // px, default 600
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
  if (!svg) return { systems: [] as Array<{ top: number; bottom: number; height: number }>, debug: "no <svg> found" };

  // Prefer page groups if present, else use the svg root
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

  // Collect BBoxes for immediate/descendant groups under each root
  const boxes: Array<{ y: number; bottom: number; height: number; width: number }> = [];
  roots.forEach(root => {
    const groups = Array.from(root.querySelectorAll<SVGGElement>("g"));
    for (const g of groups) {
      try {
        const b = g.getBBox();
        if (!isFinite(b.y) || !isFinite(b.height) || !isFinite(b.width)) continue;
        // Filter tiny/zero groups (lyrics accents etc.)
        if (b.height < 8 || b.width < 40) continue;
        boxes.push({ y: b.y, bottom: b.y + b.height, height: b.height, width: b.width });
      } catch {
        // getBBox can throw for non-rendered nodes — ignore
      }
    }
  });

  if (!boxes.length) {
    // Dump a quick directory of top-level group ids/classes for inspection
    const topGroups = Array.from(svg.querySelectorAll("g")).slice(0, 40).map(g => ({
      id: (g as SVGGElement).id || "",
      class: (g as SVGGElement).getAttribute("class") || "",
    }));
    // eslint-disable-next-line no-console
    console.warn("No measurable <g> boxes; first groups:", topGroups);
    return { systems: [], debug: "no measurable groups" };
  }

  // Sort by top Y
  boxes.sort((a, b) => a.y - b.y);

  // Cluster vertically: start a new band when there's a gap larger than threshold
  const GAP = 24; // px — conservative; adjust if needed
  const bands: Array<{ top: number; bottom: number }> = [];
  for (const b of boxes) {
    const last = bands[bands.length - 1];
    if (!last) {
      bands.push({ top: b.y, bottom: b.bottom });
    } else {
      if (b.y - last.bottom > GAP) {
        bands.push({ top: b.y, bottom: b.bottom });
      } else {
        // merge into current band
        if (b.y < last.top) last.top = b.y;
        if (b.bottom > last.bottom) last.bottom = b.bottom;
      }
    }
  }

  const systems = bands.map(b => ({ top: b.top, bottom: b.bottom, height: b.bottom - b.top }));
  return { systems, debug: "" };
}

export default function ScoreOSMD({ src, height = 600, className = "", style }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMDInstance | null>(null);

  useEffect(() => {
    (async () => {
      if (!boxRef.current) return;

      // Ensure real space & settled layout before OSMD measures
      boxRef.current.style.background = "#fff";
      await new Promise<void>(r => requestAnimationFrame(() => r()));
      await new Promise<void>(r => requestAnimationFrame(() => r()));

      const { OpenSheetMusicDisplay } =
        (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");

      // Cleanup any prior instance (hot reloads / StrictMode)
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

      // LOAD (await only if Promise)
      const maybe = osmd.load(src);
      if (isPromise(maybe)) await maybe;

      // RENDER
      osmd.render();

      // Measure systems from the **rendered SVG**
      await new Promise<void>(r => requestAnimationFrame(() => r()));
      if (boxRef.current) {
        const { systems, debug } = measureSystemsFromDOM(boxRef.current);
        if (!systems.length && debug) {
          console.warn("System measure fallback:", debug);
        } else {
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
        }
      }
    })().catch(err => {
      console.error("OSMD load/render error:", err);
    });

    return () => {
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
