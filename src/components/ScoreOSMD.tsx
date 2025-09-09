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
  /** Bottom status bar (Page X / N). No prev/next, no zoom UI. */
  showControls?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Optional fixed viewport height (px). If omitted, uses 100% of parent. */
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

  /**
   * Compute pages from system heights, reserving footer space and bleed margin
   * so the next line never shows.
   */
  const computePages = useCallback((): Page[] => {
    const svgRoot = containerRef.current?.querySelector("svg");
    if (!svgRoot) return [];

    const systems = Array.from(svgRoot.querySelectorAll<SVGGElement>("g.system"));
    if (!systems.length) return [];

    // Reserve space for footer (solid bar) and extra bleed margin
    const footerPx = showControls ? 44 : 0;
    const bleedPx = 8; // extra margin to prevent slur/beam peeking

    // Figure available height:
    const measured = viewportRef.current?.clientHeight ?? 0;
    // If no measurement yet, fall back to window height
    const parentOrWindow =
      viewportHeightPx ??
      (measured > 0 ? measured : (typeof window !== "undefined" ? window.innerHeight : 900));
    const usable = Math.max(1, parentOrWindow - footerPx - bleedPx);

    const heights = systems.map((g) => g.getBBox().height);

    const next: Page[] = [];
    let start = 0;
    let acc = 0;

    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];

      // If adding this system would overflow the usable height, close the page
      if (acc > 0 && acc + h > usable) {
        next.push({ start, end: i - 1 });
        start = i;
        acc = 0;
      }
      acc += h;

      // Very tall single system → its own page
      if (h > usable) {
        if (acc !== h) next.push({ start, end: i - 1 });
        next.push({ start: i, end: i });
        start = i + 1;
        acc = 0;
      }
    }

    if (start < heights.length) next.push({ start, end: heights.length - 1 });
    return next;
  }, [viewportHeightPx, showControls]);

  /** Mask: show only systems in current page. */
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

  /** Initialize OSMD; compute pages after render + next frame (so BBoxes are measurable). */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!containerRef.current) return;

      const options: Partial<IOSMDOptions> = {
        backend: "svg",
        autoResize: false, // we control renders for stability
        drawTitle: true,
      };

      const osmd = new OpenSheetMusicDisplay(containerRef.current, options);
      osmdRef.current = osmd;

      try {
        await osmd.load(src);
        // Keep default zoom. No zoom UI in this build.
        osmd.render();
        if (cancelled) return;

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

  /** Apply masking whenever page changes. */
  useLayoutEffect(() => {
    if (!pages.length) return;
    const clamped = Math.max(0, Math.min(pageIndex, pages.length - 1));
    applyPageVisibility(pages[clamped] ?? null);
  }, [pages, pageIndex, applyPageVisibility]);

  /** Re-paginate on resize (render sync, measure next frame). */
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

  /** Optional keyboard paging (no visible buttons). */
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
          // Fill parent by default
          height: viewportHeightPx ? `${viewportHeightPx}px` : "100%",
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

        {/* Bottom status bar (SOLID background; no transparency) */}
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
              padding: "8px 10px",
              background: "#fff",           // solid white, nothing shows through
              borderTop: "1px solid #ddd",
              fontSize: 13,
            }}
          >
            <span>Page {currentPageSafe}/{totalPages}</span>
          </div>
        )}
      </div>
    </div>
  );
}
