import ScoreOSMD from "@/components/ScoreOSMD";

const SCORE_SRC = "/scores/gymnopedie-no-1-satie.mxl";

export default function Page() {
  return (
    <main
      style={{
        height: "100dvh",     // full viewport height, mobile-safe
        width: "100vw",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: "100%",
          width: "100%",
          overflow: "hidden", // scrolling handled inside viewer if ever needed
        }}
      >
        <ScoreOSMD src={SCORE_SRC} />
      </div>
    </main>
  );
}
