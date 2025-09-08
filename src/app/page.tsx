import ScoreOSMD from "@/components/ScoreOSMD";

const SCORE_SRC = "/scores/gymnopedie-no-1-satie.mxl";

export default function Page() {
  return (
    <main
      style={{
        height: "100dvh",     // full viewport height, mobile-safe
        width: "100vw",       // ensure full width
        overflow: "hidden",   // no page-level scrollbars
      }}
    >
      <div
        style={{
          height: "100%",
          width: "100%",
          overflow: "hidden", // we’ll scroll only inside the viewer
        }}
      >
        <ScoreOSMD src={SCORE_SRC} fillParent />
      </div>
    </main>
  );
}
