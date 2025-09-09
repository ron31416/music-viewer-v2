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
  zoom?: number;            // initial zoom (1 = 100%)
  showControls?: boolean;
  className?: string;
  style?: CSSProperties;
  viewportHeightPx?: number;
};

type Page = { start: number; end: number };

function debounce<F extends (...args: any[]) => void>(fn: F, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<F>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export default function ScoreOSMD({
  src,
  zoom: zoomProp = 1,
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
  const [zoom, setZoom] = useState(zoomProp);

  // serialize renders to avoid overlap during slider drags
  const renderLock = useRef<Promise<void>>(Promise.resolve());
  const renderUnlock = useRef<(() => void) | null>(null);

  function withRenderQueue<T>(fn: () => Promise<T>): Promise<T> {
    const prev = renderLock.current;
    let resolveNext!: () => void;
    renderLock.current = new Promise<void>((r) => (resolveNext = r));
    renderUnlock.current = resolveNext;
    return prev
      .catch(() => {})
      .then(fn)
      .finally(() => resolveNext());
  }

  const computePages = useCallback((): Page[] => {
    const svgRoot = containerRef.current?.querySelector("svg");
    if (!svgRoot) return [];

    const systemNodes = Array.from(svgRoot.querySelectorAll<SVGGElement>("g.system"));
    if (!systemNodes.length) return [];

    // Avoid mixing ?? and ||. Prefer a simple, ordered fallback.
    const rawClientHeight = viewportRef.current?.clientHeight ?? null;
    const baseHeight = rawClientHeight !== null ? Math.max(1, rawClientHeight) : 600;
    const vh = viewportHeightPx ?? baseHeight;

    const heights = systemNodes.map((g) => g.getBBox().height);

    const next: Page[] = [];
    let start = 0;
    let acc = 0;

    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];

      if (acc > 0 && acc + h > vh) {
        next.push({ start, end: i - 1 });
        start = i;
        acc = 0;
      }
      acc += h;

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

  const rerenderAndPaginate = useCallback(
    async (opts?: { keepPage?: boolean }) => {
      if (!osmdRef.current) return;
      await withRenderQueue(async () => {
        await osmdRef.current!.render();
        const nextPages = computePages();
        setPages(nextPages);
        setPageIndex((pi) =>
          opts?.keepPage ? Math.min(pi, Math.max(0, nextPages.length - 1)) : 0
        );
      });
    },
    [computePages]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!containerRef.current) return;

      const options: Partial<IOSMDOptions> = {
        backend: "svg",
        autoResize: false,
        drawTitle: true,
      };

      const osmd = new OpenSheetMusicDisplay(containerRef.current, options);
      osmdRef.current = osmd;

      try {
        await osmd.load(src);
        osmd.Zoom = zoom;              // <-- set via property, not setOptions
        await osmd.render();
        if (cancelled) return;

        const nextPages = computePages();
        setPages(nextPages);
        setPageIndex(0);
        setReady(true);
      } catch (e) {
        console.error("OSMD init error:", e);
      }
    })();

    return () => {
      cancelled = true;
      renderUnlock.current?.();
      osmdRef.current = null;
    };
  }, [src, computePages, zoom]);

  useLayoutEffect(() => {
    if (!pages.length) return;
    const clamped = Math.max(0, Math.min(pageIndex, pages.length - 1));
    applyPageVisibility(pages[clamped] ?? null);
  }, [pages, pageIndex, applyPageVisibility]);

  useEffect(() => {
    const onResize = debounce(() => {
      if (!osmdRef.current) return;
      rerenderAndPaginate({ keepPage: true });
    }, 120);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [rerenderAndPaginate]);

  const applyZoom = useCallback(
    (z: number, opts?: { keepPage?: boolean }) => {
      const clamped = Math.max(0.5, Math.min(3, z));
      setZoom(clamped);
      if (!osmdRef.current) return;

      withRenderQueue(async () => {
        osmdRef.current!.Zoom = clamped;   // <-- property setter
        await osmdRef.current!.render();

        const nextPages = computePages();
        setPages(nextPages);
        setPageIndex((pi) =>
          opts?.keepPage ? Math.min(pi, Math.max(0, nextPages.length - 1)) : 0
        );
      });
    },
    [computePages]
  );

  const debouncedApplyZoom = useRef(debounce(applyZoom, 60)).current;

  const canPrev = pageIndex > 0;
  const canNext = pageIndex < Math.max(0, pages.length - 1);

  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", gap: 8, ...style }}>
      {showControls && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>Zoom</span>
            <input
              type="range"
              min={50}
              max={300}
              step={5}
              value={Math.round(zoom * 100)}
              onChange={(e) => {
                const value = Number(e.target.value) / 100;
                debouncedApplyZoom(value, { keepPage: true });
              }}
            />
            <span>{Math.round(zoom * 100)}%</span>
          </label>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button type="button" onClick={() => setPageIndex((p) => Math.max(0, p - 1))} disabled={!canPrev}>
              ◀ Prev
            </button>
            <span>
              Page {Math.min(pageIndex + 1, Math.max(1, pages.length))}/{Math.max(1, pages.length)}
            </span>
            <button
              type="button"
              onClick={() => setPageIndex((p) => Math.min(p + 1, Math.max(0, pages.length - 1)))}
              disabled={!canNext}
            >
              Next ▶
            </button>
          </div>
        </div>
      )}

      <div
        ref={viewportRef}
        style={{
          position: "relative",
          overflow: "hidden",
          height: viewportHeightPx ? `${viewportHeightPx}px` : "70vh",
          border: "1px solid #ddd",
          borderRadius: 8,
          background: "white",
        }}
      >
        <div
          ref={containerRef}
          style={{
            width: "100%",
            height: "100%",
          }}
        />
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
      </div>
    </div>
  );
}
