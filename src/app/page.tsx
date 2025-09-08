import ScoreOSMD from "@/components/ScoreOSMD";

// Put your actual file under /public/scores so it serves at /scores/...
const SCORE_SRC = "/scores/test.mxl";

export default function Page() {
  return (
    <main style={{ padding: 16 }}>
      <h1 style={{ marginBottom: 12 }}>V2 Minimal (V1 parity)</h1>
      <ScoreOSMD src={SCORE_SRC} height={600} />
    </main>
  );
}
