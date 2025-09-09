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

type Page = { start: number; end: number; topY: number; bottomY: number };

export default function ScoreOSMD({
  src,
  showControls = true,
  className = "",
  style,
  viewportHeightPx,
}: ScoreOSMDProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);   // overflow-hidden window
  const containerRef = useRef<HTMLDivElement | null>(null);  // OSMD mounts <svg> here
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);

  const [ready, setReady] = useState(false);
  const [pages, setPages] = useState<Page[]>([]);
  const [pageIndex, setPageIndex] = useState(0);

  /**
   * Measure systems and build pages.
   * We reserve footer space and add a small "bleed" so ornaments/slurs don’t peek.
   * Instead of hiding systems, we’ll window the SVG via translateY.
   */
  const computePages = useCallback((): Page[] => {
    const svg = containerRef.current?.querySelector("svg");
    if (!svg) return [];

    // OSMD systems are grouped; use a broad selector to be robust across versions
    const systems = Array.from(
      svg.querySelectorAll<SVGGElement>("g.system, g.graphical-measuresystem, g[id^='system-']")
    );
    if (!systems.length) return [];

    const footerPx = showControls ? 44 : 0;
    const bleedPx = 10;

    // available window height
    const measured = viewportRef.current?.clientHeight ?? 0;
    const parentOrWindow =
      viewportHeightPx ??
      (measured > 0 ? measured : (typeof window !== "undefined" ? window.innerHeight : 900));
    const vh = Math.max(1, parentOrWindow - footerPx - bleedPx);

    // Build per-system geometry
    const sys = systems.map((g) => {
      const bb = g.getBBox(); // SVG units; effectively pixels here
      return { g, y: bb.y, h: bb.height, bottom: bb.y + bb.height };
    });

    // Sort by y just in case (top to bottom)
    sys.sort((a, b) => a.y - b.y);

    // Paginate by stacking systems until we’d overflow vh
    const pagesNext: Page[] = [];
    let startIdx = 0;
    let acc = 0;

    for (let i = 0; i < sys.length; i++) {
      const h = sys[i].h;

      if (acc > 0 && acc + h > vh) {
        const topY = sys[startIdx].y;
        const bottomY = sys[i - 1].bottom;
        pagesNext.push({ start: startIdx, end: i - 1, topY, bottomY });
        startIdx = i;
        acc = 0;
      }
      acc += h;

      if (h > vh) {
        // Single very tall line: its own page
        if (acc !== h) {
          const topY = sys[startIdx].y;
          const bottomY = sys[i - 1].bottom;
          pagesNext.push({ start: startIdx, end: i - 1, topY, bottomY });
        }
        pagesNext.push({ start: i, end: i, topY: sys[i].y, bottomY: sys[i].bottom });
        startIdx = i + 1;
        acc = 0;
      }
    }

    if (startIdx < sys.length) {
      const topY = sys[startIdx].y;
      const bottomY = sys[sys.length - 1].bottom;
      pagesNext.push({ start: startIdx, end: sys.length - 1, topY, bottomY });
    }

    return pagesNext;
  }, [viewportHeightPx, showControls]);

  /**
   * Apply the "window": translate the SVG upward so that the current page's top aligns with the viewport.
   * The viewport itself is overflow-hidden, so nothing else shows.
   */
  const applyWindow = useCallback(
    (page: Page | null) => {
      const svg = containerRef.current?.querySelector<SVGSVGElement>("svg");
      if (!svg) return;

      if (!page) {
        svg.style.transform = "";
        svg.style.willChange = "";
        return;
      }

      // Slide the SVG up so that page.topY is at the top edge
      svg.style.transform = `translateY(${-page.topY}px)`;
      svg.style.willChange = "transform";
    },
    []
  );

  /** Initialize OSMD and compute pages after render + next frame. */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!containerRef.current) return;

      const options: Partial<IOSMDOptions> = {
        backend: "svg",
        autoResize: false, // we control re-renders to avoid races
        drawTitle: true,
      };

      const osmd = new OpenSheetMusicDisplay(containerRef.current, options);
      osmdRef.current = osmd;

      try {
        await osmd.load(src);
        // Keep default Zoom (1.0). No zoom UI in this build.
        osmd.render();
        if (cancelled) return;

        // Defer to next frame so <svg> and clientHeight are ready
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

  /** When pages/index change, slide to the correct band. */
  useLayoutEffect(() => {
    if (!pages.length) return;
    const clamped = Math.max(0, Math.min(pageIndex, pages.length - 1));
    applyWindow(pages[clamped] ?? null);
  }, [pages, pageIndex, applyWindow]);

  /** Recompute pagination on resize; measure on next frame; keep current page if possible. */
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
      {/* Viewport: overflow-hidden window */}
      <div
        ref={viewportRef}
        style={{
          position: "relative",
          overflow: "hidden",
          height: viewportHeightPx ? `${viewportHeightPx}px` : "100%",
          width: "100%",
          background: "white",
        }}
      >
        {/* OSMD mounts its <svg> inside this container */}
        <div ref={containerRef} style={{ width: "100%", height: "auto" }} />

        {!ready && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              fontSize: 14,
              color: "#666",
              background: "white",
            }}
          >
            Loading score…
          </div>
        )}

        {/* Bottom status bar (solid) */}
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
              background: "#fff",
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
