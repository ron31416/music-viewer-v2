"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  src: string;                // e.g. "/scores/test.mxl" (in /public)
  className?: string;
  style?: React.CSSProperties;
  height?: number;            // force a rendering height; default 560
};

export default function ScoreOSMDClient({
  src,
  className = "",
  style,
  height = 560,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<any | null>(null);
  const [status, setStatus] = useState<"idle" | "fetching" | "loaded" | "rendered" | "error">("idle");
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!containerRef.current) return;

        setStatus("fetching");
        setMessage(`GET ${src}`);

        // 1) Fetch as ArrayBuffer to dodge MIME/type oddities with .mxl
        const resp = await fetch(src, { cache: "no-cache" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        const data = await resp.arrayBuffer();
        if (cancelled) return;
        setStatus("loaded");
        setMessage(`Fetched ${data.byteLength} bytes`);

        // 2) Import OSMD client-side only
        const { OpenSheetMusicDisplay } = await import("opensheetmusicdisplay");
        if (cancelled) return;

        // 3) Dispose any previous instance (dev hot-reloads)
        if (osmdRef.current) {
          osmdRef.current.clear?.();
          osmdRef.current.dispose?.();
          osmdRef.current = null;
        }

        // 4) Create OSMD with plain defaults (V1 parity)
        const osmd = new OpenSheetMusicDisplay(containerRef.current!, {
          autoResize: true,
          drawTitle: true,
          drawSubtitle: true,
          drawComposer: true,
          drawLyricist: true,
        });
        osmdRef.current = osmd;

        // 5) Load from the ArrayBuffer, then render
        await osmd.load(data);
        if (cancelled) return;

        await osmd.render();
        if (cancelled) return;

        // Basic sanity check
        const g = osmd?.GraphicalMusicSheet;
        const systems = g?.MeasureList?.length ?? 0;
        setStatus("rendered");
        setMessage(`Rendered. Systems: ${systems}`);
      } catch (err: any) {
        if (!cancelled) {
          setStatus("error");
          setMessage(err?.message ?? String(err));
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
      {/* Tiny inline debug readout */}
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
        {status.toUpperCase()}: {message} — src: {src}
      </div>
      <div
        ref={containerRef}
        className={className}
        style={{
          width: "100%",
          // Give OSMD a real box to draw into
          minHeight: height,
          height,
          ...style,
        }}
      />
    </div>
  );
}
