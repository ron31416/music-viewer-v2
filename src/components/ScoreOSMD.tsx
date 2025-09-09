"use client";

import React, {
  CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { OpenSheetMusicDisplay, IOSMDOptions } from "opensheetmusicdisplay";

type ScoreOSMDProps = {
  src: string;
  /** Show bottom status bar (Page X / N). No prev/next buttons; no zoom control. */
  showControls?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Optional fixed viewport height (px). If omitted, defaults to a stable 70vh. */
  viewportHeightPx?: number;
};

type Page = { start: number; end: number };

export default function ScoreOSMD({
  src,
  showControls = true,
  className = "",
  style,
  viewportHeightPx,
}: ScoreOSMDProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);

  const [ready, setReady] = useState(false);
  const [pages, setPages] = useState<Page[]>([]);
  const [pageIndex, setPageIndex] = useState(0);

  /** Compute pages from system heights, using a stable viewport height. */
  const computePages = useCallback((): Page[] => {
    const svgRoot = containerRef.current?.querySelector("svg");
    if (!svgRoot) return [];

    const systems = Array.from(svgRoot.querySelectorAll<SVGGElement>("g.system"));
    if (!systems.length) return [];

    // Use explicit override, else measured clientHeight if non-zero, else a stable fallback (70vh).
    const measured = viewportRef.current?.clientHeight ?? 0;
    const fallback = Math.max(1, Math.round((window?.innerHeight ?? 900) * 0.7));
    const vh = viewportHeightPx ?? (measured > 0 ? measured : fallback);

    const heights = systems.map((g) => g.getBBox().height);

    const next: Page[] = [];
    let start = 0;
    let acc = 0;

    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];

      // If the next system would overflow the page, end before it.
      if (acc > 0 && acc + h > vh) {
        next.push({ start, end: i - 1 });
        start = i;
        acc = 0;
      }
      acc += h;

      // If a single system is taller than the viewport, make it its own page.
      if (h > vh) {
        if (acc !== h) next.push({ start, end: i - 1 });
        next.push({ start: i, end: i });
        start = i + 1;
        acc = 0;
      }
    }

    if (start < heights.length) next.push({ start, end: heights.length - 1 });
    return next;
  }, [viewportHeightPx]);

  /** Show only the systems in the current page (mask partial lines by hiding other systems). */
  const applyPageVisibility = useCallback((page: Page | null) => {
    const svgRoot = containerRef.current?.querySelector("svg");
    if (!svgRoot) return;

    const systems = Array.from(svgRoot.querySelectorAll<SVGGElement>("g.system"));
    if (!systems.length) return;

    if (!page) {
      systems.forEach((g) => (g.style.display = ""));
      return;
    }
    systems.forEach((g, idx) => {
      g.style.display = idx >= page.start && idx <= page.end ? "" : "none";
    });
  }, []);

  /** Initialize OSMD (no zoom changes here). */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!containerRef.current) return;

      const options: Partial<IOSMDOptions> = {
        backend: "svg",
        autoResize: false, // we control when to re-render for stability
        drawTitle: true,
      };

      const osmd = new OpenSheetMusicDisplay(containerRef.current, options);
      osmdRef.current = osmd;

      try {
        await osmd.load(src);
        // Keep default Zoom (1.0). Zoom UI removed for now to avoid blank-page issues.
        osmd.render();
        if (cancelled) return;

        // Defer measurement slightly to ensure SVG is fully laid out
        requestAnimationFrame(() => {
          const nextPages = computePages();
          setPages(nextPages);
          setPageIndex(0);
          setReady(true);
        });
      } catch (err) {
        console.error("OSMD init error:", err);
      }
    })();

    return () => {
      cancelled = true;
      osmdRef.current = null;
    };
  }, [src, computePages]);

  /** Re-apply masking when pages or index changes. */
  useLayoutEffect(() => {
    if (!pages.length) return;
    const clamped = Math.max(0, Math.min(pageIndex, pages.length - 1));
    applyPageVisibility(pages[clamped] ?? null);
  }, [pages, pageIndex, applyPageVisibility]);

  /** Re-paginate on window resize (render synchronously; measure on next frame). */
  useEffect(() => {
    const onResize = () => {
      if (!osmdRef.current) return;

      osmdRef.current.render();

      requestAnimationFrame(() => {
        const next = computePages();
        setPages(next);
        setPageIndex((pi) => Math.min(pi, Math.max(0, next.length - 1)));
      });
    };

    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [computePages]);

  /** Optional: keyboard navigation for paging (no visible buttons). */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!pages.length) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") {
        setPageIndex((p) => Math.min(p + 1, pages.length - 1));
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        setPageIndex((p) => Math.max(p - 1, 0));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pages.length]);

  const totalPages = Math.max(1, pages.length);
  const currentPageSafe = Math.min(pageIndex + 1, totalPages);

  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        ...style,
      }}
    >
      {/* Viewport */}
      <div
        ref={viewportRef}
        style={{
          position: "relative",
          overflow: "hidden",
          // IMPORTANT: default to 70vh unless explicitly overridden to avoid early 0px measurement.
          height: viewportHeightPx ? `${viewportHeightPx}px` : "70vh",
          width: "100%",
          background: "white",
        }}
      >
        {/* OSMD attaches its SVG here */}
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

        {!ready && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              fontSize: 14,
              color: "#666",
            }}
          >
            Loading score…
          </div>
        )}

        {/* Bottom status bar (minimal; no zoom, no prev/next buttons) */}
        {showControls && (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              gap: 12,
              padding: "6px 10px",
              background: "rgba(255,255,255,0.85)",
              borderTop: "1px solid #ddd",
              fontSize: 13,
            }}
          >
            <span>
              Page {currentPageSafe}/{totalPages}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
