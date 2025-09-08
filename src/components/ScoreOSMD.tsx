"use client";

import { useEffect, useRef, useState } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

// Extend the OSMD instance type to include optional methods some versions expose
type OSMDInstance = OpenSheetMusicDisplay & {
  dispose?: () => void;
  clear?: () => void;
};

type Props = {
  src: string;                 // e.g., "/scores/test.mxl"
  className?: string;
  style?: React.CSSProperties;
  height?: number;             // default 560
};

export default function ScoreOSMDClient({
  src,
  className = "",
  style,
  height = 560,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMDInstance | null>(null);
  const [status, setStatus] = useState<"idle" | "fetching" | "loaded" | "rendered" | "error">("idle");
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!containerRef.current) return;

        setStatus("fetching");
        setMessage(`GET ${src}`);

        // 1) Fetch as ArrayBuffer (robust for .mxl/.musicxml)
        const resp = await fetch(src, { cache: "no-cache" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        const data = await resp.arrayBuffer();
        if (cancelled) return;
        setStatus("loaded");
        setMessage(`Fetched ${data.byteLength} bytes`);

        // 2) Dynamic import with proper typing
        const mod = (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");
        const OSMD = mod.OpenSheetMusicDisplay;

        // 3) Clean any prior instance (hot reloads)
        if (osmdRef.current) {
          osmdRef.current.clear?.();
          osmdRef.current.dispose?.();
          osmdRef.current = null;
        }

        // 4) Init + load + render
        const osmd = new OSMD(containerRef.current, {
          autoResize: true,
          drawTitle: true,
          drawSubtitle: true,
          drawComposer: true,
          drawLyricist: true,
        }) as OSMDInstance;

        osmdRef.current = osmd;

        await osmd.load(data);
        if (cancelled) return;

        await osmd.render();
        if (cancelled) return;

        // Minimal sanity readout (systems count can vary by OSMD version)
        const systems = (osmd as unknown as { GraphicalMusicSheet?: { MeasureList?: unknown[] } })
          ?.GraphicalMusicSheet?.MeasureList?.length ?? undefined;

        setStatus("rendered");
        setMessage(`Rendered${typeof systems === "number" ? `; Systems: ${systems}` : ""}`);
      } catch (err) {
        if (!cancelled) {
          setStatus("error");
          setMessage(err instanceof Error ? err.message : String(err));
          console.error("OSMD error:", err);
        }
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
    <div style={{ width: "100%" }}>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
        {status.toUpperCase()}: {message} — src: {src}
      </div>
      <div
        ref={containerRef}
        className={className}
        style={{ width: "100%", minHeight: height, height, ...style }}
      />
    </div>
  );
}
