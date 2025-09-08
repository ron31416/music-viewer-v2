// src/components/ScoreOSMD.client.tsx
"use client";

import { useEffect, useRef } from "react";

export default function ScoreOSMD({
  height = 600,
}: { height?: number }) {
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let disposed = false;

    (async () => {
      try {
        if (!boxRef.current) return;

        // 1) Visual box so we KNOW the container has size
        boxRef.current.style.border = "1px solid #999";
        boxRef.current.style.background = "#fff";

        // 2) Load OSMD only on the client
        const { OpenSheetMusicDisplay } = await import("opensheetmusicdisplay");

        // 3) A built-in tiny MusicXML (no fetch, no MIME issues)
        const TINY_XML = `<?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
        <score-partwise version="3.1">
          <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
          <part id="P1">
            <measure number="1">
              <attributes><divisions>1</divisions><key><fifths>0</fifths></key>
              <time><beats>4</beats><beat-type>4</beat-type></time>
              <clef><sign>G</sign><line>2</line></clef></attributes>
              <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
              <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
              <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
              <note><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
            </measure>
          </part>
        </score-partwise>`;

        // 4) Wait a tick so layout settles; render AFTER the box has nonzero size
        await new Promise(r => requestAnimationFrame(() => r(null)));
        await new Promise(r => requestAnimationFrame(() => r(null))); // two RAFs to be extra safe

        const osmd = new OpenSheetMusicDisplay(boxRef.current, {
          autoResize: true,
          drawTitle: false,
          drawSubtitle: false,
          drawComposer: false,
          drawLyricist: false,
        });

        // Newer OSMD accepts raw XML strings; if yours doesn’t, swap to .load("/scores/…")
        //await osmd.load(TINY_XML);
        await osmd.load("/scores/gymnopedie-no-1-satie.mxl")
        if (!disposed) await osmd.render();

        // Force a resize once more in case initial width was 0
        if (!disposed) osmd.zoom = 1.0;
      } catch (e) {
        console.error("OSMD test failed:", e);
      }
    })();

    return () => { disposed = true; };
  }, []);

  return (
    <div
      ref={boxRef}
      style={{
        width: "100%",
        minHeight: height,
        height,
        overflow: "auto",
      }}
    />
  );
}
