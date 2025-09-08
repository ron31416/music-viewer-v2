"use client";

import { useEffect, useRef } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

type OSMDInstance = OpenSheetMusicDisplay & {
  dispose?: () => void;
  clear?: () => void;
};

type Props = {
  /** URL to the score under /public (e.g., "/scores/test.mxl") */
  src: string;
  /** Optional container class */
  className?: string;
  /** Optional inline styles for the container */
  style?: React.CSSProperties;
  /** Fixed render height in px (OSMD needs space). Default: 560 */
  height?: number;
};

export default function ScoreOSMD({ src, className = "", style, height = 560 }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMDInstance | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!containerRef.current) return;

        // Import OSMD on the client
        const mod = (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");
        const OSMD = mod.OpenSheetMusicDisplay;

        // Clean previous instance (hot reloads)
        if (osmdRef.current) {
          osmdRef.current.clear?.();
          osmdRef.current.dispose?.();
          osmdRef.current = null;
        }

        // Initialize with plain defaults (V1 look/feel)
        const osmd = new OSMD(containerRef.current, {
          autoResize: true,
          drawTitle: true,
          drawSubtitle: true,
          drawComposer: true,
          drawLyricist: true,
        }) as OSMDInstance;

        osmdRef.current = osmd;

        // ✅ Simple URL load (no type issues)
        await osmd.load(src);
        if (cancelled) return;

        await osmd.render();
      } catch (e) {
        console.error("OSMD load/render error:", e);
      }
    })();

    return () => {
      cancelled = true;
      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }
    };
  }, [src]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: "100%", minHeight: height, height, ...style }}
    />
  );
}
