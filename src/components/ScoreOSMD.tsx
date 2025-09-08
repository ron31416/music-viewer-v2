// src/components/ScoreOSMD.client.tsx
"use client";
import { useEffect, useRef } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

// Returns an array of { pageIndex, systemIndex, topY, bottomY, height }
function measureSystems(osmd: any) {
  const result: Array<{ pageIndex: number; systemIndex: number; topY: number; bottomY: number; height: number }> = [];
  const gms = osmd?.GraphicalMusicSheet;
  const pages = gms?.MusicPages ?? [];
  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    const systems = page?.MusicSystems ?? [];
    for (let s = 0; s < systems.length; s++) {
      const sys = systems[s];
      // OSMD exposes a BoundingBox per system (logical units)
      const bb = sys?.BoundingBox ?? sys?.boundingBox;
      if (!bb) continue;

      // AbsolutePosition is the top-left of the system in engraving units.
      // The box also tracks its size; OSMD uses engraving units consistently,
      // so relative comparisons (heights) are reliable.
      const top = bb?.AbsolutePosition?.y ?? 0;
      const height = bb?.Size?.height ?? 0;

      // Some editions have child boxes extending beyond the base height.
      // If available, use the calculated .TopBorder/.BottomBorder as safer extremes.
      const topBorder = (bb?.TopBorder ?? top) as number;
      const bottomBorder = (bb?.BottomBorder ?? top + height) as number;

      const topY = Math.min(top, topBorder);
      const bottomY = Math.max(top + height, bottomBorder);

      result.push({ pageIndex: p, systemIndex: s, topY, bottomY, height: bottomY - topY });
    }
  }
  return result;
}

type OSMDInstance = OpenSheetMusicDisplay & { dispose?: () => void; clear?: () => void };

export default function ScoreOSMD({
  src,
  height = 600,
  className = "",
  style,
}: {
  src: string;
  height?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMDInstance | null>(null);

  useEffect(() => {
    let disposed = false;

    (async () => {
      if (!boxRef.current) return;

      // Give OSMD real space to draw
      boxRef.current.style.background = "#fff";

      // Ensure layout is settled before rendering (fixes zero-width/hidden parents)
      await new Promise(r => requestAnimationFrame(() => r(null)));
      await new Promise(r => requestAnimationFrame(() => r(null)));

      const { OpenSheetMusicDisplay } = await import("opensheetmusicdisplay");

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

      await osmd.load(src);   // simple URL load (V1 parity)
      if (!disposed) await osmd.render();
    })().catch(err => console.error("OSMD load/render error:", err));

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
