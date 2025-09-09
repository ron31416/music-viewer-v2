import ScoreOSMD from "@/components/ScoreOSMD";

const SCORE_SRC = "/scores/gymnopedie-no-1-satie.mxl";

export default function Page() {
  return (
    <main
      style={{
        height: "100dvh",   // full viewport height (mobile-safe)
        width: "100vw",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: "100%",   // parent container to hold the viewer
          width: "100%",
          overflow: "hidden",
        }}
      >
        <ScoreOSMD src={SCORE_SRC} />
      </div>
    </main>
  );
}
