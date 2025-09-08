// src/components/ScoreOSMD.tsx
"use client";

import { useEffect, useRef } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

type OSMDInstance = OpenSheetMusicDisplay & {
  dispose?: () => void;
  clear?: () => void;
};

type Props = {
  /** URL under /public, e.g. "/scores/gymnopedie-no-1-satie.mxl" */
  src: string;
  /** Fixed render height (px). Give OSMD space. Default: 600 */
  height?: number;
  className?: string;
  style?: React.CSSProperties;
};

// “await if promise” without lint noise
function isPromise<T = unknown>(x: unknown): x is Promise<T> {
  return typeof x === "object" && x !== null && "then" in (x as Record<string, unknown>);
}

/** Measure systems from the rendered SVG DOM using getBBox(). */
function measureSystemsFromDOM(container: HTMLDivElement) {
  const out: Array<{ index: number; top: number; bottom: number; height: number }> = [];

  const svg = container.querySelector("svg");
  if (!svg) return out;

  // Try common OSMD system group selectors first; fall back to any g with “system” in id/class.
  const sysGroups = Array.from(
    svg.querySelectorAll<SVGGElement>(
      [
        'g[id^="system-"]',
        'g[id^="osmdSystem"]',
        'g[class*="system"]',
        'g[class*="System"]',
      ].join(",")
    )
  );

  const groups = sysGroups.length
    ? sysGroups
    : Array.from(svg.querySelectorAll<SVGGElement>('g[id*="system"], g[class*="system"]'));

  // If we still found nothing, bail early.
  if (!groups.length) return out;

  groups.forEach((g, i) => {
    try {
      const box = g.getBBox(); // SVG user units (pixels in our case)
      if (box && isFinite(box.height) && box.height > 0) {
        out.push({ index: i, top: box.y, bottom: box.y + box.height, height: box.height });
      }
    } catch {
      // getBBox can throw if element is not rendered; ignore and continue
    }
  });

  // Sort by vertical position
  out.sort((a, b) => a.top - b.top);
  return out;
}

export default function ScoreOSMD({ src, height = 600, className = "", style }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMDInstance | null>(null);

  useEffect(() => {
    (async () => {
      if (!boxRef.current) return;

      // Ensure the drawing box has real space before OSMD measures layout
      boxRef.current.style.background = "#fff";
      // Let layout settle (fixes zero-width parent timing)
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));

      // Import OSMD only on the client
      const { OpenSheetMusicDisplay } =
        (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");

      // Clean previous instance (dev hot-reloads / StrictMode)
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

      // LOAD (await only if this OSMD returns a Promise)
      const maybe = osmd.load(src);
      if (isPromise(maybe)) await maybe;

      // RENDER (typed as void in some versions)
      osmd.render();

      // ---- DOM-based system measurements ----
      // One more RAF so the SVG is definitely in the DOM
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const systems = boxRef.current ? measureSystemsFromDOM(boxRef.current) : [];

      // Console readout
      console.table(
        systems.map((s, k) => ({
          line: k + 1,
          top: s.top.toFixed(1),
          bottom: s.bottom.toFixed(1),
          height: s.height.toFixed(1),
        }))
      );
      if (systems.length) {
        const tallest = systems.reduce((a, b) => (b.height > a.height ? b : a), systems[0]);
        console.log(
          `Tallest line → line ${systems.indexOf(tallest) + 1}, height ${tallest.height.toFixed(1)} px`
        );
      } else {
        console.warn("No system groups found in SVG — selectors may need adjustment for this score.");
      }
    })().catch((err) => {
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
