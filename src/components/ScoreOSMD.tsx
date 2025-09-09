"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

/* Props & types */
type Props = {
  src: string;
  fillParent?: boolean;
  height?: number;
  debug?: boolean;
  allowScroll?: boolean;
  className?: string;
  style?: React.CSSProperties;
};

type Band = { top: number; bottom: number; height: number };
type OSMDWithLifecycle = OpenSheetMusicDisplay & { clear?: () => void; dispose?: () => void };

/* Utils */
function isPromise<T = unknown>(x: unknown): x is Promise<T> {
  return typeof x === "object" && x !== null && "then" in (x as { then?: unknown });
}
function afterPaint(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}
function purgeWebGL(node: HTMLElement): void {
  for (const c of Array.from(node.querySelectorAll("canvas"))) {
    try {
      const gl =
        (c.getContext("webgl") as WebGLRenderingContext | null) ||
        (c.getContext("experimental-webgl") as WebGLRenderingContext | null) ||
        (c.getContext("webgl2") as WebGL2RenderingContext | null);
      (gl?.getExtension("WEBGL_lose_context") as { loseContext?: () => void } | null)?.loseContext?.();
      c.remove();
    } catch {}
  }
}
function getSvg(outer: HTMLDivElement): SVGSVGElement | null {
  return outer.querySelector("svg") as SVGSVGElement | null;
}
function withUntransformedSvg<T>(outer: HTMLDivElement, fn: (svg: SVGSVGElement) => T): T | null {
  const svg = getSvg(outer);
  if (!svg) return null;
  const prev = svg.style.transform;
  svg.style.transform = "none";
  try {
    return fn(svg);
  } finally {
    svg.style.transform = prev;
  }
}

/* Measure OSMD systems (SVG <g> clusters) in px relative to wrapper */
function measureSystemsPx(outer: HTMLDivElement, svgRoot: SVGSVGElement): Band[] {
  const pageRoots = Array.from(
    svgRoot.querySelectorAll<SVGGElement>(
      'g[id^="osmdCanvasPage"], g[id^="Page"], g[class*="Page"], g[class*="page"]'
    )
  );
  const roots: Array<SVGGElement | SVGSVGElement> = pageRoots.length ? pageRoots : [svgRoot];

  const hostTop = outer.getBoundingClientRect().top;
  type Box = { top: number; bottom: number; height: number; width: number };
  const boxes: Box[] = [];

  for (const root of roots) {
    for (const g of Array.from(root.querySelectorAll<SVGGElement>("g"))) {
      try {
        const r = g.getBoundingClientRect();
        if (!Number.isFinite(r.top) || !Number.isFinite(r.height) || !Number.isFinite(r.width)) continue;
        if (r.height < 8 || r.width < 40) continue; // ignore fragments
        boxes.push({ top: r.top - hostTop, bottom: r.bottom - hostTop, height: r.height, width: r.width });
      } catch {}
    }
  }

  boxes.sort((a, b) => a.top - b.top);

  const GAP = 18; // px
  const bands: Band[] = [];
  for (const b of boxes) {
    const last = bands[bands.length - 1];
    if (!last || b.top - last.bottom > GAP) {
      bands.push({ top: b.top, bottom: b.bottom, height: b.height });
    } else {
      if (b.top < last.top) last.top = b.top;
      if (b.bottom > last.bottom) last.bottom = b.bottom;
      last.height = last.bottom - last.top;
    }
  }
  return bands;
}

export default function ScoreOSMD({
  src,
  fillParent = false,
  height = 600,
  debug = false,          // retained for potential toggles; not logging by default
  allowScroll = false,
  className = "",
  style,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const osmdHostRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMDWithLifecycle | null>(null);
  const resizeObsRef = useRef<ResizeObserver | null>(null);

  // Layout model
  const bandsRef = useRef<Band[]>([]);
  const perPageRef = useRef<number>(1);
  const startIdxRef = useRef<number>(0);      // ★ authoritative first-visible system index
  const readyRef = useRef<boolean>(false);

  // UI
  const maskRef = useRef<HTMLDivElement | null>(null);
  const [hud, setHud] = useState({ page: 1, maxPage: 1, perPage: 1, total: 0 });

  // Tunables
  const MASK_OVERLAP = 4; // px: hide slightly above next system top
  const WHEEL_THROTTLE_MS = 140;
  const wheelLockRef = useRef<number>(0);

  /* ---------- STABILIZER: wait until wrapper+SVG stop changing ---------- */
  const reflowTokenRef = useRef<number>(0);
  const waitForStableLayout = useCallback(async (outer: HTMLDivElement) => {
    const svg = getSvg(outer);
    if (!svg) return;
    const NEED_STABLE = 4;   // consecutive frames unchanged
    const TIMEOUT_MS = 400;  // hard cap
    let stable = 0;
    let prev = { w: -1, h: -1, cw: -1, ch: -1 };
    const t0 = performance.now();
    while (stable < NEED_STABLE && performance.now() - t0 < TIMEOUT_MS) {
      await new Promise((r) => requestAnimationFrame(r));
      const br = svg.getBoundingClientRect();
      const now = { w: Math.round(br.width), h: Math.round(br.height), cw: outer.clientWidth, ch: outer.clientHeight };
      if (now.w === prev.w && now.h === prev.h && now.cw === prev.cw && now.ch === prev.ch) stable += 1;
      else { stable = 0; prev = now; }
    }
  }, []);

  /* HUD update (derived from startIdx + perPage) */
  const updateHUD = useCallback(() => {
    const total = bandsRef.current.length;
    const perPage = Math.max(1, perPageRef.current);
    const page = Math.floor(startIdxRef.current / perPage) + 1;
    const maxPage = Math.max(1, Math.ceil(total / perPage));
    setHud({ page: Math.min(page, maxPage), maxPage, perPage, total });
  }, []);

  /* Core apply: align by startIdx (NOT by page) */
  const applyFromStartIdx = useCallback((startIdx: number) => {
    const outer = wrapRef.current;
    if (!outer) return;
    const svg = getSvg(outer);
    if (!svg) return;

    const bands = bandsRef.current;
    if (!bands.length) return;

    const clampedStart = Math.max(0, Math.min(startIdx, bands.length - 1));
    startIdxRef.current = clampedStart;

    const perPage = Math.max(1, perPageRef.current);
    const total = bands.length;

    const startTop = bands[clampedStart].top;
    const lastIdx = Math.min(clampedStart + perPage - 1, total - 1);
    const nextIdx = lastIdx + 1;

    // snap to top; ceil avoids tiny top gaps
    const ySnap = Math.ceil(startTop);
    svg.style.transform = `translateY(${-ySnap}px)`;
    svg.style.willChange = "transform";

    // mask from NEXT system top (with overlap)
    let maskTop = outer.clientHeight;
    if (nextIdx < total) {
      const nextTopRel = bands[nextIdx].top - startTop;
      maskTop = Math.min(outer.clientHeight - 1, Math.max(0, Math.ceil(nextTopRel - MASK_OVERLAP)));
    }
    if (maskRef.current) {
      maskRef.current.style.top = `${maskTop}px`;
      maskRef.current.style.display = "block";
    }

    updateHUD();
  }, [MASK_OVERLAP, updateHUD]);

  /* Recompute bands + perPage; keep same startIdx across reflow */
  const recomputeLayoutAndKeepIdx = useCallback(() => {
    const outer = wrapRef.current;
    if (!outer) return;

    const bands = withUntransformedSvg(outer, (svg) => measureSystemsPx(outer, svg)) ?? [];
    bandsRef.current = bands;

    const limit = outer.clientHeight;
    let n = 0;
    for (const b of bands) {
      if (b.bottom - (bands[0]?.top ?? 0) <= limit) n += 1;
      else break;
    }
    perPageRef.current = Math.max(1, n);

    // clamp startIdx and re-apply
    if (bands.length === 0) return;
    if (startIdxRef.current > bands.length - 1) startIdxRef.current = bands.length - 1;

    applyFromStartIdx(startIdxRef.current);
  }, [applyFromStartIdx]);

  /* Debounced + stabilized recompute on resize */
  const scheduleRecompute = useCallback(() => {
    const outer = wrapRef.current;
    if (!outer) return;
    const myToken = ++reflowTokenRef.current;
    requestAnimationFrame(async () => {
      if (myToken !== reflowTokenRef.current) return;
      await waitForStableLayout(outer);
      if (myToken !== reflowTokenRef.current) return;
      recomputeLayoutAndKeepIdx();
    });
  }, [recomputeLayoutAndKeepIdx, waitForStableLayout]);

  /* Paging uses startIdx directly */
  const nextPage = useCallback((deltaPages: number) => {
    if (!readyRef.current) return;
    const perPage = Math.max(1, perPageRef.current);
    const total = bandsRef.current.length;
    if (!total) return;

    let nextStart = startIdxRef.current + deltaPages * perPage;
    nextStart = Math.max(0, Math.min(nextStart, Math.max(0, total - 1)));
    applyFromStartIdx(nextStart);
  }, [applyFromStartIdx]);

  /* Wheel + keys */
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!readyRef.current) return;
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      if (!allowScroll) e.preventDefault();
      const now = Date.now();
      if (now < wheelLockRef.current) return;
      wheelLockRef.current = now + WHEEL_THROTTLE_MS;
      nextPage(e.deltaY > 0 ? 1 : -1);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!readyRef.current) return;
      if (["PageDown", "ArrowDown", " "].includes(e.key)) { e.preventDefault(); nextPage(1); }
      else if (["PageUp", "ArrowUp"].includes(e.key)) { e.preventDefault(); nextPage(-1); }
      else if (e.key === "Home") { e.preventDefault(); applyFromStartIdx(0); }
      else if (e.key === "End") {
        e.preventDefault();
        const total = bandsRef.current.length;
        const perPage = Math.max(1, perPageRef.current);
        const lastStart = Math.max(0, total - perPage);
        applyFromStartIdx(lastStart);
      }
    };
    window.addEventListener("wheel", onWheel, { passive: allowScroll });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [allowScroll, nextPage, applyFromStartIdx]);

  /* Mount & OSMD init */
  useEffect(() => {
    let localResizeObs: ResizeObserver | null = null;
    (async () => {
      const host = osmdHostRef.current;
      const wrapper = wrapRef.current;
      if (!host || !wrapper) return;
      await afterPaint();

      const { OpenSheetMusicDisplay } =
        (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");

      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }

      const osmd = new OpenSheetMusicDisplay(host, {
        backend: "svg" as const,
        autoResize: true,
        drawTitle: true,
        drawSubtitle: true,
        drawComposer: true,
        drawLyricist: true,
      }) as OSMDWithLifecycle;
      osmdRef.current = osmd;

      const maybe = osmd.load(src);
      if (isPromise(maybe)) await maybe;
      osmd.render();
      await afterPaint();

      purgeWebGL(wrapper);

      // one-time bottom mask
      if (!maskRef.current && wrapper) {
        const mask = document.createElement("div");
        mask.style.position = "absolute";
        mask.style.left = "0";
        mask.style.right = "0";
        mask.style.top = "0";
        mask.style.bottom = "0";
        mask.style.background = "#fff";
        mask.style.pointerEvents = "none";
        mask.style.zIndex = "5";
        mask.style.display = "none";
        wrapper.appendChild(mask);
        maskRef.current = mask;
      }

      startIdxRef.current = 0; // start on first system
      recomputeLayoutAndKeepIdx();
      readyRef.current = true;

      // Stabilized resize observer
      localResizeObs = new ResizeObserver(() => {
        scheduleRecompute();
      });
      localResizeObs.observe(wrapper);
      resizeObsRef.current = localResizeObs;
    })().catch(() => {});

    return () => {
      if (localResizeObs && wrapRef.current) localResizeObs.unobserve(wrapRef.current);
      resizeObsRef.current = null;
      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }
    };
  }, [src, recomputeLayoutAndKeepIdx, scheduleRecompute]);

  /* Styles */
  const outerStyle: React.CSSProperties = fillParent
    ? { width: "100%", height: "100%", minHeight: 0, position: "relative", overflow: "hidden", background: "#fff" }
    : { width: "100%", height: height ?? 600, minHeight: height ?? 600, position: "relative", overflow: "hidden", background: "#fff" };

  const osmdHostStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    overflowY: allowScroll ? "auto" : "hidden",
    overflowX: "hidden",
  };

  const btn: React.CSSProperties = {
    padding: "6px 10px",
    borderRadius: 8,
    border: "1px solid #ccc",
    background: "#fff",
    cursor: "pointer",
    fontWeight: 600,
  };

  /* UI */
  const total = bandsRef.current.length;
  const perPage = Math.max(1, perPageRef.current);
  const curPage = Math.min(Math.floor(startIdxRef.current / perPage) + 1, Math.max(1, Math.ceil(total / perPage)));
  const maxPage = Math.max(1, Math.ceil(total / perPage));

  return (
    <div ref={wrapRef} className={className} style={{ ...outerStyle, ...style }}>
      <div ref={osmdHostRef} style={osmdHostStyle} />

      <div style={{ position: "absolute", right: 10, top: 10, display: "flex", gap: 8, zIndex: 10 }}>
        <button type="button" style={btn} onClick={() => nextPage(-1)}>Prev</button>
        <button type="button" style={btn} onClick={() => nextPage(1)}>Next</button>
      </div>

      <div
        style={{
          position: "absolute",
          right: 10,
          bottom: 10,
          padding: "6px 10px",
          background: "rgba(0,0,0,0.55)",
          color: "#fff",
          borderRadius: 8,
          font: "12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Arial",
          zIndex: 10,
          pointerEvents: "none",
        }}
      >
        Page {curPage}/{maxPage} • {perPage} lines/page • {total} systems
      </div>
    </div>
  );
}
