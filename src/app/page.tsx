// app/page.tsx
import ScoreOSMD from "@/components/ScoreOSMD";

export default function Page() {
  return (
    <main style={{ padding: 16 }}>
      <h1 style={{ marginBottom: 12 }}>V2 Minimal (V1 parity)</h1>
      <ScoreOSMD src="/scores/gymnopedie-no-1-satie.mxl" height={650} />
    </main>
  );
}
