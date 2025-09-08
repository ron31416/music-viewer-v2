// src/components/ScoreOSMD.tsx
"use client";

import { useEffect, useRef } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

type OSMDInstance = OpenSheetMusicDisplay & {
  dispose?: () => void;
  clear?: () => void;
};

type Props = {
  /** URL to the score under /public (e.g., "/scores/gymnopedie-no-1-satie.mxl") */
  src: string;
  /** Fixed render height in px (OSMD needs real space). Default: 600 */
  height?: number;
  className?: string;
  style?: React.CSSProperties;
};

/** Narrow Promise type check so we can "await if promise" without TS noise */
function isPromise<T = unknown>(x: unknown): x is Promise<T> {
  return !!x && typeof (x as any).then === "function";
}

/** Measure per-system vertical extents after render */
function measureSystems(osmd: any) {
  const out: Array<{ pageIndex: number; systemIndex: number; topY: number; bottomY: number; height: number }> = [];
  const gms = osmd?.GraphicalMusicSheet;
  const pages = gms?.MusicPages ?? [];
  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    const systems = page?.MusicSystems ?? [];
    for (let s = 0; s < systems.length; s++) {
      const sys = systems[s];
      const bb = sys?.BoundingBox ?? sys?.boundingBox;
      if (!bb) continue;

      const top = bb?.AbsolutePosition?.y ?? 0;
      const sizeH = bb?.Size?.height ?? 0;

      const topBorder = Number.isFinite(bb?.TopBorder) ? bb.TopBorder : top;
      const bottomBorder = Number.isFinite(bb?.BottomBorder) ? bb.BottomBorder : top + sizeH;

      const topY = Math.min(top, topBorder);
      const bottomY = Math.max(top + sizeH, bottomBorder);
      out.push({ pageIndex: p, systemIndex: s, topY, bottomY, height: bottomY - topY });
    }
  }
  return out;
}

export default function ScoreOSMD({ src, height = 600, className = "", style }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMDInstance | null>(null);

  useEffect(() => {
    let disposed = false;

    (async () => {
      if (!boxRef.current) return;

      // Ensure the drawing box has real space before OSMD measures layout
      boxRef.current.style.background = "#fff";
      // Two RAFs help if parents are toggling visibility/layout
      await new Promise(r => requestAnimationFrame(() => r(null)));
      await new Promise(r => requestAnimationFrame(() => r(null)));

      // Import OSMD only on the client
      const { OpenSheetMusicDisplay } = (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");

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

      // --- LOAD (normalize: await only if it returns a Promise) ---
      const maybe = (osmd as any).load(src);
      if (isPromise(maybe)) await maybe;

      // --- RENDER (typed as void in some versions; no await) ---
      osmd.render();

      // --- MEASURE & LOG per-system vertical envelope ---
      try {
        const systems = measureSystems(osmd as any);
        // Console table for quick scan
        /* eslint-disable no-console */
        console.table(
          systems.map(({ pageIndex, systemIndex, topY, bottomY, height }) => ({
            page: pageIndex + 1,
            line: systemIndex + 1,
            topY: topY.toFixed(2),
            bottomY: bottomY.toFixed(2),
            height: height.toFixed(2),
          }))
        );
        const tallest =
          systems.reduce(
            (acc, s) => (s.height > acc.height ? s : acc),
            { pageIndex: 0, systemIndex: 0, topY: 0, bottomY: 0, height: 0 }
          ) || null;
        if (tallest) {
          console.log(
            `Tallest line → page ${tallest.pageIndex + 1}, line ${tallest.systemIndex + 1}, height ${tallest.height.toFixed(
              2
            )} (engraving units)`
          );
        }
        /* eslint-enable no-console */
      } catch (e) {
        // Safe to ignore if internal shapes differ by version
        console.warn("System measurement failed (non-fatal):", e);
      }
    })().catch(err => {
      console.error("OSMD load/render error:", err);
    });

    return () => {
      disposed = true;
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
