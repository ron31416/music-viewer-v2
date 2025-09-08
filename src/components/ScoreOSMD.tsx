"use client";

import { useEffect, useRef, useState } from "react";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

type ScoreOSMDProps = {
  src: string;
  zoom?: number;
  showControls?: boolean;
  className?: string;
  style?: React.CSSProperties;
};

type OSMDCompat = OpenSheetMusicDisplay & {
  /** Older OSMD runtime uses capitalized Zoom */
  Zoom?: number;
  /** Future/variant runtime might expose lowercase zoom */
  zoom?: number;
};

function setOsmdZoom(osmd: OpenSheetMusicDisplay, z: number) {
  const o = osmd as OSMDCompat;
  if (typeof o.Zoom === "number") o.Zoom = z;
  else if (typeof o.zoom === "number") o.zoom = z;
}

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
  const [status, setStatus] = useState<string>("idle");
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useEffect(() => setLocalZoom(zoom), [zoom]);

  // Wait until the container has non-zero size (dialogs/tabs can start at 0)
  const waitForBox = async (): Promise<boolean> => {
    const el = containerRef.current;
    if (!el) return false;
    let tries = 0;
    while (tries < 12) {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      setBox({ w, h });
      if (w > 0 && h > 0) return true;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      tries++;
    }
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  };

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (!containerRef.current) return;

      setStatus("checking src…");
      try {
        const resp = await fetch(src, { method: "GET" });
        if (!resp.ok) {
          setStatus(`file error ${resp.status} (${resp.statusText})`);
          return;
        }
      } catch {
        setStatus("network error");
        return;
      }

      setStatus("waiting for layout…");
      const sized = await waitForBox();
      if (!sized || cancelled) {
        if (!sized) setStatus("container is size 0 — check parent sizing");
        return;
      }

      try {
        if (!osmdRef.current) {
          osmdRef.current = new OpenSheetMusicDisplay(containerRef.current, {
            autoResize: false,
            backend: "svg",
            drawTitle: false,
          });
        }
        const osmd = osmdRef.current;

        setStatus("loading…");
        await osmd.load(src);
        if (cancelled) return;

        setOsmdZoom(osmd, localZoom);
        await new Promise<void>((r) => requestAnimationFrame(() => r()));

        setStatus("rendering…");
        await osmd.render();
        setStatus("rendered");
      } catch (err: unknown) {
        console.error("[ScoreOSMD] load/render failed:", err);
        setStatus("error (see console)");
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [src, localZoom]);

  // Re-render when the box size changes (dialog opens, window resizes, etc.)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setBox({ w: el.offsetWidth, h: el.offsetHeight });
      const osmd = osmdRef.current;
      if (!osmd) return;
      try {
        osmd.render();
      } catch {
        /* noop */
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Cleanup
  useEffect(() => {
    return () => {
      try {
        osmdRef.current?.clear();
      } catch {
        /* noop */
      }
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
            onClick={() =>
              setLocalZoom((z) => Number(Math.max(0.1, z - 0.1).toFixed(2)))
            }
          >
            −
          </button>
          <span className="tabular-nums w-[5ch] text-center">
            {(localZoom * 100).toFixed(0)}%
          </span>
          <button
            type="button"
            className="px-2 py-1 rounded border"
            onClick={() => setLocalZoom((z) => Number((z + 0.1).toFixed(2)))}
          >
            +
          </button>
          <button
            type="button"
            className="px-2 py-1 rounded border"
            onClick={() => setLocalZoom(1)}
          >
            Reset
          </button>
          <span className="ml-3 text-sm opacity-70">
            Status: {status} {box.w > 0 && `• ${box.w}×${box.h}`} • {src}
          </span>
        </div>
      )}

      <div
        ref={containerRef}
        role="region"
        aria-label="Music score"
        style={{ width: "100%", minHeight: 240, overflow: "auto" }}
      />
    </div>
  );
}
