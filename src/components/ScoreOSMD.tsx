import { useEffect, useRef } from "react";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

type ScoreOSMDProps = {
  /** URL to the MXL/MusicXML file, e.g. "/scores/test.mxl" */
  src: string;
  /** Optional CSS class for the container */
  className?: string;
  /** Optional inline style (e.g., fixed height) */
  style?: React.CSSProperties;
};

export default function ScoreOSMD({ src, className = "", style }: ScoreOSMDProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Dispose previous instance if any (prevents duplicates on hot reload)
    if (osmdRef.current) {
      osmdRef.current.clear();
      // @ts-expect-error dispose exists at runtime even if not typed in some versions
      osmdRef.current.dispose?.();
      osmdRef.current = null;
    }

    const osmd = new OpenSheetMusicDisplay(containerRef.current, {
      // Mirror V1 defaults: simple render, no controls
      autoResize: true,
      drawTitle: true,
      drawSubtitle: true,
      drawComposer: true,
      drawLyricist: true,
      // keep layout stable; OSMD chooses systems automatically
    });
    osmdRef.current = osmd;

    let cancelled = false;
    (async () => {
      try {
        await osmd.load(src);          // ✅ load FIRST
        if (!cancelled) osmd.render(); // ✅ render AFTER
        // console.debug("OSMD rendered:", src);
      } catch (err) {
        console.error("OSMD load/render failed:", err);
      }
    })();

    return () => {
      cancelled = true;
      if (osmdRef.current) {
        osmdRef.current.clear();
        // @ts-expect-error dispose may exist
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }
    };
  }, [src]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: "100%", minHeight: 300, ...style }}
    />
  );
}
