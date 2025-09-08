"use client";

import { useEffect, useRef, useState } from "react";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

type ScoreOSMDProps = {
  /** Absolute or root-relative path to a MusicXML/MXL file (e.g., "/scores/example.mxl"). */
  src: string;
  /** Initial zoom (1 = 100%). */
  zoom?: number;
  /** Show minimal zoom controls + status. */
  showUI?: boolean;
  /** Optional class + inline style passthroughs for the outer wrapper. */
  className?: string;
  style?: React.CSSProperties;
  /** Draw the title from score metadata (OSMD option). */
  drawTitle?: boolean;
};

/** Support both OSMD.Zoom and OSMD.zoom without using 'any'. */
type OSMDCompat = OpenSheetMusicDisplay & { Zoom?: number; zoom?: number };
function setOsmdZoom(osmd: OpenSheetMusicDisplay, z: number) {
  const o = osmd as OSMDCompat;
  if (typeof o.Zoom === "number") o.Zoom = z;
  else if (typeof o.zoom === "number") o.zoom = z;
}

/** Wait until an element has non-zero width & height (dialogs/tabs can start at 0). */
async function waitForNonZeroSize(el: HTMLElement, maxFrames = 30): Promise<boolean> {
  let frames = 0;
  if (el.offsetWidth > 0 && el.offsetHeight > 0) return true;
  return new Promise<boolean>((resolve) => {
    const step = () => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) return resolve(true);
      if (frames++ >= maxFrames) return resolve(false);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

export default function ScoreOSMD({
  src,
  zoom = 1,
  showUI = true,
  className = "",
  style,
  drawTitle = false,
}: ScoreOSMDProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const [localZoom, setLocalZoom] = useState(zoom);
  const [status, setStatus] = useState<"idle" | "waiting" | "loading" | "rendering" | "rendered" | "error" | "file-error" | "no-size">("idle");
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Keep internal zoom synchronized with prop.
  useEffect(() => setLocalZoom(zoom), [zoom]);

  // Initialize / load / render when src changes (or on first mount).
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const el = containerRef.current;
      if (!el) return;

      setStatus("waiting");
      const okSize = await waitForNonZeroSize(el);
      if (cancelled) return;
      if (!okSize) {
        setStatus("no-size");
        return;
      }

      try {
        // (Re)create OSMD once per container lifecycle.
        if (!osmdRef.current) {
          osmdRef.current = new OpenSheetMusicDisplay(el, {
            autoResize: false,   // we manage resizing below with ResizeObserver
            backend: "svg",
            drawTitle,
          });
        }

        const osmd = osmdRef.current;
        setStatus("loading");
        // If src 404s, OSMD throws; we surface that cleanly.
        await osmd.load(src);
        if (cancelled) return;

        setOsmdZoom(osmd, localZoom);
        setStatus("rendering");
        await osmd.render();
        setStatus("rendered");
      } catch (err) {
        console.error("[ScoreOSMD] load/render failed:", err);
        // Distinguish file path problems a bit for quicker diagnosis.
        setStatus(String(err).toLowerCase().includes("404") ? "file-error" : "error");
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [src, localZoom, drawTitle]);

  // Re-render when the container size changes (dialog opens, window resizes, etc.)
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
        /* ignore transient render issues during layout */
      }
    });

    ro.observe(el);
    setBox({ w: el.offsetWidth, h: el.offsetHeight });

    return () => ro.disconnect();
  }, []);

  // Cleanup on unmount (remove SVG, drop instance).
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
      {showUI && (
        <div className="flex items-center gap-2 mb-2" aria-label="score controls">
          <button
            type="button"
            className="px-2 py-1 rounded border"
            onClick={() => setLocalZoom((z) => Number(Math.max(0.1, z - 0.1).toFixed(2)))}
          >
            −
          </button>
          <span className="tabular-nums w-[5ch] text-center">{(localZoom * 100).toFixed(0)}%</span>
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
          <span className="ml-3 text-sm opacity-70">
            {status === "rendered"
              ? `Rendered • ${box.w}×${box.h}`
              : status === "waiting"
              ? `Waiting for layout…`
              : status === "loading"
              ? `Loading…`
              : status === "rendering"
              ? `Rendering…`
              : status === "no-size"
              ? `Container size is 0 (give the wrapper width/height)`
              : status === "file-error"
              ? `File error (check src path or 404)`
              : status === "error"
              ? `Error (see console)`
              : `Idle`}
            {" • "}
            {src}
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
