// src/components/ScoreOSMD.tsx
"use client";

import { useEffect, useRef } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

// ---- Minimal shape types (so we don't use `any`) ----
interface Point { y?: number }
interface Size { height?: number }
interface BoundingBox {
  AbsolutePosition?: Point;
  Size?: Size;
  TopBorder?: number;
  BottomBorder?: number;
}
interface MusicSystem { BoundingBox?: BoundingBox; boundingBox?: BoundingBox }
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
  /** Fixed render height in px (give OSMD space). Default: 600 */
  height?: number;
  className?: string;
  style?: React.CSSProperties;
};

// Narrow Promise check (no `any`)
function isPromise<T = unknown>(x: unknown): x is Promise<T> {
  return typeof x === "object" && x !== null && "then" in (x as Record<string, unknown>);
}

// Measure per-system vertical extents after render (no `any`)
function measureSystems(osmd: OSMDInstance) {
  const results: Array<{ pageIndex: number; systemIndex: number; topY: number; bottomY: number; height: number }> = [];
  const gms = osmd.GraphicalMusicSheet;
  const pages = gms?.MusicPages ?? [];

  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    const systems = page?.MusicSystems ?? [];
    for (let s = 0; s < systems.length; s++) {
      const sys = systems[s];
      const bb = sys?.BoundingBox ?? sys?.boundingBox;
      if (!bb) continue;

      const top = bb.AbsolutePosition?.y ?? 0;
      const sizeH = bb.Size?.height ?? 0;

      const topBorder = Number.isFinite(bb.TopBorder) ? (bb.TopBorder as number) : top;
      const bottomBorder = Number.isFinite(bb.BottomBorder) ? (bb.BottomBorder as number) : top + sizeH;

      const topY = Math.min(top, topBorder);
      const bottomY = Math.max(top + sizeH, bottomBorder);
      results.push({ pageIndex: p, systemIndex: s, topY, bottomY, height: bottomY - topY });
    }
  }
  return results;
}

export default function ScoreOSMD({ src, height = 600, className = "", style }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMDInstance | null>(null);

  useEffect(() => {
    (async () => {
      if (!boxRef.current) return;

      // Ensure the drawing box has real space before OSMD measures layout
      boxRef.current.style.background = "#fff";
      // Two RAFs help if parents are toggling visibility/layout
      await new Promise<void>(r => requestAnimationFrame(() => r()));
      await new Promise<void>(r => requestAnimationFrame(() => r()));

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

      // LOAD (await only if it's actually a Promise per this OSMD version)
      const maybe = osmd.load(src);
      if (isPromise(maybe)) await maybe;

      // RENDER (typed as void in some versions)
      osmd.render();

      // MEASURE & LOG per-system vertical envelope
      const systems = measureSystems(osmd);
      console.table(
        systems.map(({ pageIndex, systemIndex, topY, bottomY, height }) => ({
          page: pageIndex + 1,
          line: systemIndex + 1,
          topY: topY.toFixed(2),
          bottomY: bottomY.toFixed(2),
          height: height.toFixed(2),
        }))
      );
      const tallest = systems.reduce(
        (acc, s) => (s.height > acc.height ? s : acc),
        { pageIndex: 0, systemIndex: 0, topY: 0, bottomY: 0, height: 0 }
      );
      console.log(
        `Tallest line → page ${tallest.pageIndex + 1}, line ${tallest.systemIndex + 1}, height ${tallest.height.toFixed(
          2
        )} (engraving units)`
      );
    })().catch(err => {
      console.error("OSMD load/render error:", err);
    });

    // Cleanup
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
