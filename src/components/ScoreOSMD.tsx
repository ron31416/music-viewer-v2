"use client";

import { useEffect, useRef } from "react";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

type OSMDInstance = OpenSheetMusicDisplay & { dispose?: () => void; clear?: () => void };

type Props = {
  src: string;
  height?: number;            // px, default 600
  className?: string;
  style?: React.CSSProperties;
};

function isPromise<T = unknown>(x: unknown): x is Promise<T> {
  return typeof x === "object" && x !== null && "then" in (x as Record<string, unknown>);
}

/** Analyze vertical bands from rendered SVG, with system-like features. */
function analyzeBands(container: HTMLDivElement) {
  const svg = container.querySelector("svg");
  if (!svg) return { bands: [] as Band[], svgWidth: 0 };

  type Box = { y: number; bottom: number; height: number; width: number; el: SVGGElement | SVGGraphicsElement };
  type Band = { top: number; bottom: number; height: number; maxWidth: number; verticalLines: number };

  const pageRoots = Array.from(
    svg.querySelectorAll<SVGGElement>(
      'g[id^="osmdCanvasPage"], g[id^="Page"], g[class*="Page"], g[class*="page"]'
    )
  );
  const roots: (SVGGElement | SVGSVGElement)[] = pageRoots.length ? pageRoots : [svg];

  const boxes: Box[] = [];
  for (const root of roots) {
    const groups = Array.from(root.querySelectorAll<SVGGElement>("g"));
    for (const g of groups) {
      try {
        const b = g.getBBox();
        if (!isFinite(b.y) || !isFinite(b.height) || !isFinite(b.width)) continue;
        if (b.height < 8 || b.width < 40) continue; // ignore tiny fragments
        boxes.push({ y: b.y, bottom: b.y + b.height, height: b.height, width: b.width, el: g });
      } catch { /* ignore */ }
    }
  }

  boxes.sort((a,b)=>a.y-b.y);
  const GAP = 24;
  const raw: { top:number; bottom:number; members:Box[] }[] = [];
  for (const b of boxes) {
    const last = raw[raw.length-1];
    if (!last || b.y - last.bottom > GAP) raw.push({ top:b.y, bottom:b.bottom, members:[b] });
    else {
      if (b.y < last.top) last.top = b.y;
      if (b.bottom > last.bottom) last.bottom = b.bottom;
      last.members.push(b);
    }
  }

  function countVerticals(members: Box[]) {
    let count = 0;
    for (const m of members) {
      const lines = Array.from(m.el.querySelectorAll<SVGLineElement>("line"));
      for (const ln of lines) {
        const x1 = +((ln.getAttribute("x1")||"0")); const x2 = +((ln.getAttribute("x2")||"0"));
        const y1 = +((ln.getAttribute("y1")||"0")); const y2 = +((ln.getAttribute("y2")||"0"));
        if (Math.abs(x1-x2) <= 1 && Math.abs(y1-y2) > 30) count++;
      }
      const rects = Array.from(m.el.querySelectorAll<SVGGraphicsElement>("path,rect"));
      for (const r of rects) {
        try { const bb = r.getBBox(); if (bb.width <= 2 && bb.height > 30) count++; } catch {}
      }
    }
    return count;
  }

  const bands = raw.map(b=>{
    const maxWidth = Math.max(...b.members.map(m=>m.width));
    return { top:b.top, bottom:b.bottom, height:b.bottom-b.top, maxWidth, verticalLines: countVerticals(b.members) };
  });

  const svgWidth = (svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width) || svg.clientWidth || 0;
  return { bands, svgWidth };
}

/** Drop header/title band with stronger heuristic. */
function dropHeaderIfPresent(bands: ReturnType<typeof analyzeBands>["bands"], svgWidth: number) {
  if (bands.length < 2) return bands;
  const [first, second] = bands;

  const restHeights = bands.slice(1).map(b => b.height).sort((a,b)=>a-b);
  const median = restHeights.length ? restHeights[Math.floor(restHeights.length/2)] : second.height;
  const widthCov = svgWidth ? first.maxWidth / svgWidth : 1;

  const looksLikeHeader =
    first.verticalLines <= 1 &&
    (first.height > median * 1.3 || first.height > 80) &&
    widthCov < 0.9;

  return looksLikeHeader ? bands.slice(1) : bands;
}

export default function ScoreOSMD({ src, height = 600, className = "", style }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OSMDInstance | null>(null);

  const lastSigRef = useRef<string>("");
  const moRef = useRef<MutationObserver | null>(null);
  const debounceTimer = useRef<number | null>(null);

  // debounced measurement triggered by DOM mutations (OSMD reflow)
  const scheduleMeasure = () => {
    if (debounceTimer.current) {
      window.clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    debounceTimer.current = window.setTimeout(() => {
      if (!boxRef.current) return;
      const { bands, svgWidth } = analyzeBands(boxRef.current);
      const systems = dropHeaderIfPresent(bands, svgWidth);

      // dedupe identical output
      const sig = `${systems.length}|${systems.map(s=>s.height.toFixed(1)).join(",")}`;
      if (sig === lastSigRef.current) return;
      lastSigRef.current = sig;

      if (!systems.length) {
        console.warn("No systems detected during measurement.");
        return;
      }
      console.table(
        systems.map((s,i)=>({
          line: i+1,
          top: s.top.toFixed(1),
          bottom: s.bottom.toFixed(1),
          height: s.height.toFixed(1)
        }))
      );
      const tallest = systems.reduce((a,b)=> b.height>a.height ? b : a, systems[0]);
      console.log(`Tallest line → line ${systems.indexOf(tallest)+1}, height ${tallest.height.toFixed(1)} px`);
    }, 120); // small debounce so we run after OSMD finishes DOM updates
  };

  useEffect(() => {
    (async () => {
      if (!boxRef.current) return;

      boxRef.current.style.background = "#fff";
      await new Promise<void>(r => requestAnimationFrame(()=>r()));
      await new Promise<void>(r => requestAnimationFrame(()=>r()));

      const { OpenSheetMusicDisplay } =
        (await import("opensheetmusicdisplay")) as typeof import("opensheetmusicdisplay");

      // cleanup previous
      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }

      const osmd = new OpenSheetMusicDisplay(boxRef.current, {
        autoResize: true, // OSMD reflows on width changes
        drawTitle: true,
        drawSubtitle: true,
        drawComposer: true,
        drawLyricist: true,
      }) as OSMDInstance;
      osmdRef.current = osmd;

      const maybe = osmd.load(src);
      if (isPromise(maybe)) await maybe;
      osmd.render();

      // Observe the SVG subtree for **actual DOM changes** (child/attr/text)
      if (!moRef.current) {
        moRef.current = new MutationObserver(() => {
          // Any DOM change in the SVG subtree will land here; measure once debounced
          scheduleMeasure();
        });
      }
      // Attach observer to container (subtree: true so it catches SVG replacements)
      moRef.current.observe(boxRef.current, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: false
      });

      // Kick an initial measurement after first paint
      scheduleMeasure();
    })().catch(err => {
      console.error("OSMD load/render error:", err);
    });

    return () => {
      if (debounceTimer.current) {
        window.clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      if (moRef.current) {
        moRef.current.disconnect();
        moRef.current = null;
      }
      if (osmdRef.current) {
        osmdRef.current.clear?.();
        osmdRef.current.dispose?.();
        osmdRef.current = null;
      }
    };
  }, [src]);

  return (
    <div
      ref={boxRef}
      className={className}
      style={{ width: "100%", minHeight: height, height, overflow: "auto", ...style }}
    />
  );
}
