// src/components/ScoreOSMD.tsx
"use client";

import { useEffect, useRef } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

/* --------- minimal structural types (no `any`) --------- */
interface SourceMeasure { MeasureNumber?: number }
interface GraphicalMeasure {
  SourceMeasure?: SourceMeasure;
  ParentMeasure?: { SourceMeasure?: SourceMeasure };
  Parent?: { SourceMeasure?: SourceMeasure };
  MeasureNumber?: number;
}
interface StaffLine {
  Measures?: GraphicalMeasure[];
  measures?: GraphicalMeasure[];
}
interface MusicSystem {
  StaffLines?: StaffLine[];
  staffLines?: StaffLine[];
}
interface MusicPage { MusicSystems?: MusicSystem[] }
interface GraphicalMusicSheet { MusicPages?: MusicPage[] }

type OSMDInstance = OpenSheetMusicDisplay & {
  dispose?: () => void;
  clear?: () => void;
  GraphicalMusicSheet?: GraphicalMusicSheet;
};

type Props = {
  src: string;                 // e.g. "/scores/gymnopedie-no-1-satie.mxl"
  fillParent?: boolean;        // height:100% if true
  height?: number;             // px when not filling parent (default 600)
  debug?: boolean;             // console tables
  className?: string;
  style?: React.CSSProperties;
};

function isPromise<T = unknown>(x: unknown): x is Promise<T> {
  return typeof x === "object" && x !== null && "then" in (x as Record<string, unknown>);
}
function afterPaint(): Promise<void> {
  return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => res())));
}

/* Paranoid WebGL cleanup (in case something creates canvases) */
function purgeWebGL(node: HTMLElement) {
  const canvases = Array.from(node.querySelectorAll("canvas"));
  for (const c of canvases) {
    try {
      const gl =
        (c.getContext("webgl") as WebGLRenderingContext | null) ||
        (c.getContext("experimental-webgl") as WebGLRenderingContext | null) ||
        (c.getContext("webgl2") as WebGL2RenderingContext | null);
      if (gl) gl.getExtension("WEBGL_lose_context")?.loseContext?.();
      c.remove();
    } catch { /* ignore */ }
  }
}

/* Measure systems from the rendered SVG */
type Band = { top: number; bottom: number; height: number };
function analyzeBands(container: HTMLDivElement): Band[] {
  const svg = container.querySelector("svg");
  if (!svg) return [];

  const pageRoots = Array.from(
    svg.querySelectorAll<SVGGElement>(
      'g[id^="osmdCanvasPage"], g[id^="Page"], g[class*="Page"], g[class*="page"]'
    )
  );
  const roots: Array<SVGGElement | SVGSVGElement> = pageRoots.length ? pageRoots : [svg];

  type Box = { y: number; bottom: number; height: number; width: number };
  const boxes: Box[] = [];

  for (const root of roots) {
    for (const g of Array.from(root.querySelectorAll<SVGGElement>("g"))) {
      try {
        const b = g.getBBox();
        if (!Number.isFinite(b.y) || !Number.isFinite(b.height) || !Number.isFinite(b.width)) continue;
        if (b.height < 8 || b.width < 40) continue;
        boxes.push({ y: b.y, bottom: b.y + b.height, height: b.height, width: b.width });
      } catch { /* non-rendered nodes */ }
    }
  }

  boxes.sort((a, b) => a.y - b.y);

  const GAP = 24; // px to separate bands
  const bands: Band[] = [];
  for (const b of boxes) {
    const last = bands[bands.length - 1];
    if (!last || b.y - last.bottom > GAP) {
      bands.push({ top: b.y, bottom: b.bottom, height: b.height });
    } else {
      if (b.y < last.top) last.top = b.y;
      if (b.bottom > last.bottom) last.bottom = b.bottom;
      last.height = last.bottom - last.top;
    }
  }
  return bands;
}

/* NEW: choose last fully visible system by its bottom edge */
function chooseLastFullyVisibleIndex(bands: Band[], container: HTMLDivElement, padPx: number): number {
  const limit = container.clientHeight - padPx; // pad so next line can’t “peek”
  let last = -1;
  for (let i = 0; i < bands.length; i++) {
    if (bands[i].bottom <= limit) last = i;
    else break;
  }
  return Math.max(0, last); // at least the first line
}

function getLastMeasureNumberForSystem(osmd: OSMDInstance, systemIndex: number): number {
  const gms = osmd.GraphicalMusicSheet;
  const page0: MusicPage | undefined = gms?.MusicPages?.[0];
  const sys: MusicSystem | undefined = page0?.MusicSystems?.[systemIndex];
  if (!sys) return 0;

  const lines: StaffLine[] = (sys.StaffLines ?? sys.staffLines) ?? [];
  let best = 0;
  for (const sl of lines) {
    const measures: GraphicalMeasure[] = (sl.Measures ?? sl.measures) ?? [];
    for (const m of measures) {
      const n =
        m.SourceMeasure?.MeasureNumber ??
        m.ParentMeasure?.SourceMeasure?.MeasureNumber ??
        m.Parent?.SourceMeasure?.MeasureNumber ??
        m.MeasureNumber ??
        0;
      if (n > best) best = n;
    }
  }
  return best;
}

type MeasureSliceOptions = { drawFromMeasureNumber?: number; drawUpToMeasureNumber?: number; };
function setMeasureOptions(osmd: OSMDInstance, opts: MeasureSliceOptions) {
  (osmd as unknown as { setOptions: (o: MeasureSliceOptions) => void }).setOptions(opts);
}

export default function ScoreOSMD({
  src,
  fillParent = false,
  height = 600,
  debug = false,
  className = "",
  style,
}: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMDInstance | null>(null);

  const resizeObsRef = useRef<ResizeObserver | null>(null);
  const debounceTimer = useRef<number | null>(null);
  const recomputingRef = useRef<boolean>(false);
  const currentUpToRef = useRef<number>(0);

  const FIT_PAD_PX = 16; // bigger margin to avoid any “peek”

  const scheduleRecompute = () => {
    if (debounceTimer.current) {
      window.clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    debounceTimer.current = window.setTimeout(async () => {
      const container = boxRef.current;
      const osmd = osmdRef.current;
      if (!container || !osmd) return;
      if (recomputingRef.current) return;

      recomputingRef.current = true;
      try {
        const prevScrollTop = container.scrollTop;

        // Remove stray canvases/WebGL (belt-and-suspenders)
        purgeWebGL(container);

        // Phase 1: full render (clear slice)
        setMeasureOptions(osmd, { drawFromMeasureNumber: 1, drawUpToMeasureNumber: Number.MAX_SAFE_INTEGER });
        osmd.render();
        await afterPaint();

        const bands = analyzeBands(container);
        if (!bands.length) return;

        if (debug) {
          // eslint-disable-next-line no-console
          console.table(bands.map((b, i) => ({
            line: i + 1,
            top: b.top.toFixed(1),
            bottom: b.bottom.toFixed(1),
            height: b.height.toFixed(1),
          })));
        }

        // Phase 2: pick last fully visible by bottom edge
        const lastIdx = chooseLastFullyVisibleIndex(bands, container, FIT_PAD_PX);
        const upToMeasure = getLastMeasureNumberForSystem(osmd, lastIdx);

        if (upToMeasure && upToMeasure !== currentUpToRef.current) {
          setMeasureOptions(osmd, { drawFromMeasureNumber: 1, drawUpToMeasureNumber: upToMeasure });
          osmd.render();
          currentUpToRef.current = upToMeasure;
          await afterPaint();
        }

        container.scrollTop = prevScrollTop;
        purgeWebGL(container);
      } finally {
        recomputingRef.current = false;
      }
    }, 120);
  };

  useEffect(() => {
    (async () => {
      if (!boxRef.current) return;
      await afterPaint();

      const { OpenSheetMusicDisplay } =
        (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");

      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }

      const osmd = new OpenSheetMusicDisplay(boxRef.current, {
        backend: "svg" as const, // ensures SVG backend (no WebGL)
        autoResize: true,
        drawTitle: true,
        drawSubtitle: true,
        drawComposer: true,
        drawLyricist: true,
      }) as OSMDInstance;
      osmdRef.current = osmd;

      const maybe = osmd.load(src);
      if (isPromise(maybe)) await maybe;
      osmd.render();
      currentUpToRef.current = 0;

      // Initial slice
      scheduleRecompute();

      // Observe BOTH width and height: any dimension change can affect wrapping/fit
      if (!resizeObsRef.current) {
        resizeObsRef.current = new ResizeObserver((entries) => {
          const cr = entries[0]?.contentRect;
          if (!cr) return;
          const w = Math.round(cr.width);
          const h = Math.round(cr.height);
          if (w || h) scheduleRecompute();
        });
        resizeObsRef.current.observe(boxRef.current);
      }
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("OSMD init error:", err);
    });

    return () => {
      if (debounceTimer.current) {
        window.clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      if (resizeObsRef.current && boxRef.current) {
        resizeObsRef.current.unobserve(boxRef.current);
      }
      resizeObsRef.current = null;
      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }
    };
  }, [src]);

  const containerStyle: React.CSSProperties = fillParent
    ? { width: "100%", height: "100%", minHeight: 0, overflowY: "auto", overflowX: "hidden" }
    : { width: "100%", height, minHeight: height, overflowY: "auto", overflowX: "hidden" };

  return (
    <div
      ref={boxRef}
      className={`osmd-container ${className || ""}`}
      style={{ background: "#fff", ...containerStyle, ...style }}
    />
  );
}
