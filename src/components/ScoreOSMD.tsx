// src/components/ScoreOSMD.client.tsx
"use client";
import { useEffect, useRef } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

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
