import Link from "next/link";
import { CalibrationStatus } from "./CalibrationStatus";

const PHASES = [
  { n: 1, title: "Project, auth, camera, calibration UI", status: "done" },
  { n: 2, title: "Wheel mapping, ball & rotor tracking", status: "done" },
  { n: 3, title: "Kalman filtering, deceleration fit, spin phases", status: "done" },
  { n: 4, title: "Drop-time projection, scatter model, pocket probabilities", status: "done" },
  { n: 5, title: "Rapier.js / Matter.js simulation adapters", status: "next" },
  { n: 6, title: "Spin history (IndexedDB + Supabase)", status: "planned" },
  { n: 7, title: "Backtesting & calibration vs uniform baseline", status: "planned" },
  { n: 8, title: "Simulation lab & final dashboard", status: "planned" },
  { n: 9, title: "Performance, tests, documentation", status: "planned" },
] as const;

export default function Dashboard() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <div className="grid gap-4 md:grid-cols-3">
        <CalibrationStatus />
        <Link href="/live-analysis" className="panel block p-4 hover:border-ink-600">
          <div className="panel-title">Live analysis</div>
          <div className="mt-2 text-sm text-ink-300">Track ball and rotor from camera, video file or the synthetic wheel.</div>
        </Link>
        <Link href="/limitations" className="panel block p-4 hover:border-ink-600">
          <div className="panel-title">Read first</div>
          <div className="mt-2 text-sm text-ink-300">What this tool can and can’t measure, and why predictions are probabilistic.</div>
        </Link>
      </div>
      <div className="panel p-4">
        <div className="panel-title mb-3">Build progress</div>
        <ul className="space-y-2">
          {PHASES.map((p) => (
            <li key={p.n} className="flex items-center gap-3 text-sm">
              <span className={`num w-16 text-xs ${p.status === "done" ? "text-accent" : p.status === "next" ? "text-warn" : "text-ink-400"}`}>{p.status}</span>
              <span className="text-ink-400">Phase {p.n}</span>
              <span>{p.title}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
