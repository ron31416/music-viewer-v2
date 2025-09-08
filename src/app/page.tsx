// app/page.tsx
import ScoreOSMD from "@/components/ScoreOSMD";

export default function Page() {
  return (
    <main style={{ padding: 16 }}>
      <h1>V2 Minimal (diagnostic)</h1>
      <ScoreOSMD height={700} />
    </main>
  );
}
