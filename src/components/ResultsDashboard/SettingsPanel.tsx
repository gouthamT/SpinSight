"use client";
import { useEffect, useState } from "react";
import type { WheelType } from "@/types/roulette";
import type { HistorySettings, PhysicsSettings } from "@/types/history";
import { WHEEL_LABEL } from "@/engine/wheel/layout";
import { DEFAULT_SETTINGS, GUIDE_FACTS, resultsStore } from "@/lib/storage/resultsStore";

const PHYSICS_FIELDS: { key: keyof PhysicsSettings; label: string; unit: string; step: number }[] = [
  { key: "ballOmegaMean", label: "Ball launch speed", unit: "rad/s", step: 0.1 },
  { key: "ballOmegaSd", label: "Ball launch speed spread (SD)", unit: "rad/s", step: 0.05 },
  { key: "rotorOmegaMean", label: "Wheel (rotor) speed", unit: "rad/s", step: 0.1 },
  { key: "rotorOmegaSd", label: "Wheel speed spread (SD)", unit: "rad/s", step: 0.05 },
  { key: "rotorDecel", label: "Wheel deceleration", unit: "rad/s²", step: 0.005 },
  { key: "frictionA", label: "Ball friction a", unit: "rad/s²", step: 0.01 },
  { key: "dragB", label: "Ball air drag b", unit: "1/rad", step: 0.001 },
  { key: "dropOmegaMean", label: "Ball speed at drop", unit: "rad/s", step: 0.1 },
  { key: "dropOmegaSd", label: "Ball speed at drop, spread", unit: "rad/s", step: 0.05 },
  { key: "releaseJitterPockets", label: "Release-point jitter", unit: "pockets", step: 0.5 },
  { key: "deflectorHitProb", label: "Deflector hit probability", unit: "0–1", step: 0.05 },
  { key: "deflectorKickMean", label: "Deflector kick (mean)", unit: "pockets", step: 0.5 },
  { key: "deflectorKickSd", label: "Deflector kick (SD)", unit: "pockets", step: 0.5 },
  { key: "bounceMean", label: "Fret bounce travel (mean)", unit: "pockets", step: 0.5 },
  { key: "bounceSd", label: "Fret bounce travel (SD)", unit: "pockets", step: 0.5 },
  { key: "longRollProb", label: "Long-roll chance (ball keeps rolling before landing)", unit: "0–1", step: 0.05 },
  { key: "longRollMeanPockets", label: "Long-roll extra travel (mean)", unit: "pockets", step: 1 },
];

/** Settings tab: defaults from the table guide, editable, persisted in localStorage. */
export function SettingsPanel() {
  const [s, setS] = useState<HistorySettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setS({ ...resultsStore.loadSettings(), wheelType: resultsStore.loadWheel() });
    setLoaded(true);
  }, []);

  const save = (next: HistorySettings) => {
    setS(next);
    resultsStore.saveSettings(next);
    resultsStore.saveWheel(next.wheelType);
    setMsg("Saved");
    setTimeout(() => setMsg(null), 1200);
  };
  const setPhysics = (patch: Partial<PhysicsSettings>) => save({ ...s, physics: { ...s.physics, ...patch } });
  const wheelDirection = s.physics.ballDirection === "clockwise" ? "Counter-clockwise" : "Clockwise";
  const isDefault = JSON.stringify(s) === JSON.stringify(DEFAULT_SETTINGS);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <section className="panel space-y-3 p-4 sm:p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Table rules (from your guide)</h2>
          <span className="text-xs text-ink-400">{msg ?? (loaded ? (isDefault ? "Using guide defaults" : "Custom settings saved in this browser") : "")}</span>
        </div>
        <table className="num w-full text-sm">
          <thead className="text-left text-xs text-ink-400">
            <tr><th className="py-1 font-normal">Wheel</th><th className="py-1 font-normal">Pockets</th><th className="py-1 font-normal">House margin</th><th className="py-1 font-normal">Return to player</th></tr>
          </thead>
          <tbody>
            {(["european", "american"] as const).map((w) => (
              <tr key={w} className="border-t border-ink-700">
                <td className="py-1 font-sans">{GUIDE_FACTS.wheels[w].label}</td>
                <td className="py-1">{GUIDE_FACTS.wheels[w].pockets}</td>
                <td className="py-1">{(GUIDE_FACTS.wheels[w].houseMargin * 100).toFixed(2)}%</td>
                <td className="py-1">{(GUIDE_FACTS.wheels[w].returnToPlayer * 100).toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-ink-400">
          Source: {GUIDE_FACTS.source} (defaults file: <code className="num">src/config/roulette-defaults.json</code>). The guide notes that wheel and ball are spun in opposite directions, and that no
          betting system changes the house margin of a game of chance.
        </p>
      </section>

      <section className="panel space-y-4 p-4 sm:p-6">
        <h2 className="text-lg font-semibold">Wheel</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs text-ink-300">Wheel type</span>
            <select className="input" value={s.wheelType} onChange={(e) => save({ ...s, wheelType: e.target.value as WheelType })}>
              {(Object.keys(WHEEL_LABEL) as WheelType[]).map((w) => <option key={w} value={w}>{WHEEL_LABEL[w]}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs text-ink-300">Ball direction</span>
            <select className="input" value={s.physics.ballDirection} onChange={(e) => setPhysics({ ballDirection: e.target.value as PhysicsSettings["ballDirection"] })}>
              <option value="clockwise">Clockwise</option>
              <option value="counter-clockwise">Counter-clockwise</option>
            </select>
            <span className="block text-[11px] text-ink-400">Wheel spins the opposite way: {wheelDirection.toLowerCase()}.</span>
          </label>
          {(["kinematic", "rapier", "matter"] as const).map((e) => (
            <label key={e} className="space-y-1">
              <span className="text-xs text-ink-300">
                {e === "kinematic" ? "Kinematic" : e === "rapier" ? "Rapier.js" : "Matter.js"} engine: full spins per guess
              </span>
              <select className="input" value={s.engineRuns[e]} onChange={(ev) => save({ ...s, engineRuns: { ...s.engineRuns, [e]: Number(ev.target.value) } })}>
                {(e === "kinematic" ? [100, 200, 400, 1000, 2000] : [20, 40, 60, 120, 240]).map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          ))}
          <label className="space-y-1">
            <span className="text-xs text-ink-300">Quick physics samples per guess</span>
            <select className="input" value={s.simulations} onChange={(e) => save({ ...s, simulations: Number(e.target.value) })}>
              {[20_000, 50_000, 200_000, 500_000, 1_000_000].map((v) => <option key={v} value={v}>{v.toLocaleString()}</option>)}
            </select>
          </label>
        </div>
      </section>

      <section className="panel space-y-4 p-4 sm:p-6">
        <div>
          <h2 className="text-lg font-semibold">Physics assumptions</h2>
          <p className="text-xs text-ink-400">
            The guide gives no speeds or friction values, so these are generic assumptions for a typical wheel. They only shape
            the physics model; the statistical models learn from your history.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {PHYSICS_FIELDS.map((f) => (
            <label key={f.key} className="space-y-1">
              <span className="text-xs text-ink-300">{f.label} <span className="text-ink-400">({f.unit})</span></span>
              <input
                type="number"
                className="input num"
                step={f.step}
                min={0}
                value={s.physics[f.key] as number}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= 0) setPhysics({ [f.key]: v } as Partial<PhysicsSettings>);
                }}
              />
            </label>
          ))}
        </div>
      </section>

      <div className="flex justify-end">
        <button className="btn-ghost" onClick={() => setS(resultsStore.resetSettings())} disabled={isDefault}>
          Reset to guide defaults
        </button>
      </div>
    </div>
  );
}
