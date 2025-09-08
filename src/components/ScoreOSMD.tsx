"use client";

import { useEffect, useRef, useState } from "react";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

type ScoreOSMDProps = {
  /** URL/path to a MusicXML/MXL file, e.g. "/scores/myPiece.mxl" */
  src: string;
  /** Initial zoom (1 = 100%). */
  zoom?: number;
  /** Show simple zoom controls. */
  showControls?: boolean;
  /** Optional class + inline style passthroughs. */
  className?: string;
  style?: React.CSSProperties;
};

export default function ScoreOSMD({
  src,
  zoom = 1,
  showControls = true,
  className = "",
  style,
}: ScoreOSMDProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const [localZoom, setLocalZoom] = useState(zoom);

  // Keep local zoom in sync if the prop changes
  useEffect(() => setLocalZoom(zoom), [zoom]);

  // (Re)initialize + load + render whenever src changes
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!containerRef.current || !src) return;

      if (!osmdRef.current) {
        osmdRef.current = new OpenSheetMusicDisplay(containerRef.current, {
          autoResize: false, // keep layout predictable; we can re-render manually
          backend: "svg",
          drawTitle: false,
        });
      }

      const osmd = osmdRef.current;

      try {
        await osmd.load(src);           // <— fixes the "load before render" error
        if (cancelled) return;
        osmd.zoom = localZoom;          // set zoom, then render
        await osmd.render();
      } catch (err) {
        console.error("[ScoreOSMD] load/render failed:", err);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [src, localZoom]);

  // Clean up SVG on unmount
  useEffect(() => {
    return () => {
      try {
        osmdRef.current?.clear();
      } catch {}
      osmdRef.current = null;
    };
  }, []);

  return (
    <div className={className} style={style}>
      {showControls && (
        <div className="flex items-center gap-2 mb-2" aria-label="score zoom controls">
          <button
            type="button"
            className="px-2 py-1 rounded border"
            onClick={() => setLocalZoom((z) => Number(Math.max(0.1, z - 0.1).toFixed(2)))}
          >
            −
          </button>
          <span className="tabular-nums w-[4.5ch] text-center">
            {(localZoom * 100).toFixed(0)}%
          </span>
          <button
            type="button"
            className="px-2 py-1 rounded border"
            onClick={() => setLocalZoom((z) => Number((z + 0.1).toFixed(2)))}
          >
            +
          </button>
          <button type="button" className="px-2 py-1 rounded border" onClick={() => setLocalZoom(1)}>
            Reset
          </button>
        </div>
      )}

      <div
        ref={containerRef}
        role="region"
        aria-label="Music score"
        style={{ width: "100%", minHeight: 200, overflow: "auto" }}
      />
    </div>
  );
}
