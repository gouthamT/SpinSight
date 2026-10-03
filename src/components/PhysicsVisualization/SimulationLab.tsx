"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BatchSummary, EngineId, SimParams, SimResult, SimWorkerRequest, SimWorkerResponse } from "@/types/simulation";
import type { WheelType } from "@/types/roulette";
import { DEFAULT_SIM_PARAMS, criticalOmega } from "@/engine/physics/rouletteScene";
import { pocketColour, pocketLabel, pocketOrder, WHEEL_LABEL } from "@/engine/wheel/layout";
import { MotionGraph, type Series } from "@/components/MotionGraph/MotionGraph";
import { PocketTile } from "@/components/ResultsDashboard/PredictionResults";
import { WheelReplay } from "./WheelReplay";

const KEY = "spinsight:simlab:params";
const ENGINES: { id: EngineId; label: string; note: string; color: string }[] = [
  { id: "kinematic", label: "Kinematic reference", note: "Direct integration + idealised contact rules", color: "#f2b84b" },
  { id: "rapier", label: "Rapier.js", note: "Rigid bodies, impulse contact solver, CCD", color: "#5aa9ff" },
  { id: "matter", label: "Matter.js", note: "Position-based 2-D rigid bodies", color: "#34d6a0" },
];

type NumKey = { [K in keyof SimParams]: SimParams[K] extends number ? K : never }[keyof SimParams];
const FIELDS: { key: NumKey; label: string; unit: string; min: number; max: number; step: number }[] = [
  { key: "ballOmega0", label: "Ball launch speed", unit: "rad/s", min: 6, max: 25, step: 0.5 },
  { key: "rotorOmega0", label: "Wheel speed", unit: "rad/s", min: 0, max: 5, step: 0.1 },
  { key: "rotorDecel", label: "Wheel deceleration", unit: "rad/s²", min: 0, max: 0.3, step: 0.005 },
  { key: "frictionA", label: "Ball friction a", unit: "rad/s²", min: 0, max: 1.5, step: 0.05 },
  { key: "dragB", label: "Ball air drag b", unit: "1/rad", min: 0, max: 0.05, step: 0.001 },
  { key: "trackInclineDeg", label: "Track incline", unit: "°", min: 5, max: 60, step: 1 },
  { key: "coneInclineDeg", label: "Cone incline", unit: "°", min: 5, max: 60, step: 1 },
  { key: "restitution", label: "Collision restitution", unit: "0–1", min: 0, max: 0.95, step: 0.05 },
  { key: "contactFriction", label: "Contact friction", unit: "μ", min: 0, max: 1, step: 0.05 },
  { key: "surfaceDrag", label: "Rotor surface drag", unit: "1/s", min: 0.2, max: 10, step: 0.1 },
  { key: "deflectors", label: "Deflectors", unit: "count", min: 0, max: 16, step: 1 },
  { key: "launchAngle", label: "Launch angle", unit: "rad", min: 0, max: 6.28, step: 0.05 },
  { key: "rotorPhase", label: "Wheel phase", unit: "rad", min: 0, max: 6.28, step: 0.05 },
  { key: "seed", label: "Seed", unit: "", min: 1, max: 99999, step: 1 },
];

function loadParams(): SimParams {
  try {
    const s = localStorage.getItem(KEY);
    return s ? { ...DEFAULT_SIM_PARAMS, ...(JSON.parse(s) as Partial<SimParams>) } : DEFAULT_SIM_PARAMS;
  } catch {
    return DEFAULT_SIM_PARAMS;
  }
}

export function SimulationLab() {
  const [params, setParams] = useState<SimParams>(DEFAULT_SIM_PARAMS);
  const [engines, setEngines] = useState<EngineId[]>(["kinematic", "rapier", "matter"]);
  const [results, setResults] = useState<SimResult[] | null>(null);
  const [batch, setBatch] = useState<{ summaries: BatchSummary[]; disagreement: number | null } | null>(null);
  const [runs, setRuns] = useState(30);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const worker = useRef<Worker | null>(null);

  useEffect(() => setParams(loadParams()), []);
  useEffect(() => {
    const w = new Worker(new URL("../../workers/simulation.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    w.onmessage = (e: MessageEvent<SimWorkerResponse>) => {
      const m = e.data;
      if (m.type === "progress") setBusy(`${m.engine}: ${m.done}/${m.total}`);
      else if (m.type === "single") {
        setResults(m.results);
        setT(0);
        setPlaying(true);
        setBusy(null);
      } else if (m.type === "batch") {
        setBatch({ summaries: m.summaries, disagreement: m.disagreement });
        setBusy(null);
      } else {
        setError(m.message);
        setBusy(null);
      }
    };
    return () => w.terminate();
  }, []);

  const duration = useMemo(() => Math.max(1, ...(results ?? []).map((r) => r.samples.at(-1)?.t ?? 0)), [results]);

  // Playback (real time).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      setT((x) => {
        const nx = x + (now - last) / 1000;
        if (nx >= duration) {
          setPlaying(false);
          return duration;
        }
        return nx;
      });
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration]);

  const update = (patch: Partial<SimParams>) => {
    const next = { ...params, ...patch };
    setParams(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const post = (req: SimWorkerRequest, label: string) => {
    if (!worker.current || !engines.length) return;
    setError(null);
    setBusy(label);
    worker.current.postMessage(req);
  };

  const omegaSeries: Series[] = (results ?? []).map((r) => ({
    label: `${ENGINES.find((e) => e.id === r.engine)!.label} ball ω`,
    color: ENGINES.find((e) => e.id === r.engine)!.color,
    points: r.samples.map((s) => ({ t: s.t * 1000, v: s.ballOmega })),
  }));
  const order = pocketOrder(params.wheelType);

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
        Simulated estimates from a simplified 2-D top-down model (slopes are forces, not geometry; no vertical bounce or
        ball spin). Engines run separately on identical parameters and are compared, never blended. Not calibrated to any
        real wheel.
      </div>

      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <section className="panel space-y-4 p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Parameters</h2>
            <button className="text-xs text-accent hover:underline" onClick={() => update(DEFAULT_SIM_PARAMS)}>Reset</button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-xs text-ink-300">Wheel</span>
              <select className="input py-1 text-xs" value={params.wheelType} onChange={(e) => update({ wheelType: e.target.value as WheelType })}>
                {(Object.keys(WHEEL_LABEL) as WheelType[]).map((w) => <option key={w} value={w}>{WHEEL_LABEL[w]}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-ink-300">Ball direction</span>
              <select className="input py-1 text-xs" value={params.ballDirection} onChange={(e) => update({ ballDirection: e.target.value as SimParams["ballDirection"] })}>
                <option value="clockwise">Clockwise</option>
                <option value="counter-clockwise">Counter-clockwise</option>
              </select>
            </label>
          </div>
          {FIELDS.map((f) => (
            <label key={f.key} className="block space-y-0.5">
              <div className="flex justify-between text-xs text-ink-300">
                <span>{f.label}</span>
                <span className="num">{Number(params[f.key]).toFixed(f.step < 0.01 ? 3 : f.step < 1 ? 2 : 0)} {f.unit}</span>
              </div>
              <input type="range" className="w-full accent-[var(--color-accent)]" min={f.min} max={f.max} step={f.step}
                value={params[f.key] as number} onChange={(e) => update({ [f.key]: Number(e.target.value) } as Partial<SimParams>)} />
            </label>
          ))}
          <p className="num text-[11px] text-ink-400">Implied drop speed ω_c = √(g·tanδ/r) = {criticalOmega(params).toFixed(2)} rad/s</p>
          <div className="space-y-1">
            <div className="text-xs text-ink-300">Engines</div>
            {ENGINES.map((e) => (
              <label key={e.id} className="flex items-start gap-2 text-xs">
                <input type="checkbox" className="mt-0.5" checked={engines.includes(e.id)}
                  onChange={(ev) => setEngines((xs) => (ev.target.checked ? [...xs, e.id] : xs.filter((x) => x !== e.id)))} />
                <span><span style={{ color: e.color }}>●</span> {e.label} <span className="text-ink-400">: {e.note}</span></span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary flex-1" disabled={!!busy || !engines.length} onClick={() => post({ type: "single", engines, params }, "Simulating…")}>
              Run one spin
            </button>
            <div className="flex flex-1 gap-1">
              <select className="input w-20 py-1 text-xs" value={runs} onChange={(e) => setRuns(Number(e.target.value))}>
                {[10, 30, 60, 120].map((v) => <option key={v} value={v}>{v}×</option>)}
              </select>
              <button className="btn-ghost flex-1" disabled={!!busy || !engines.length}
                onClick={() => post({ type: "batch", engines, params, runs, seed: params.seed }, "Batch…")}>
                Compare batch
              </button>
            </div>
          </div>
          {busy && <div className="text-xs text-warn">{busy}</div>}
          {error && <div className="text-xs text-bad">{error}</div>}
        </section>

        <div className="space-y-6">
          {results && (
            <section className="panel space-y-4 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <button className="btn-ghost py-1" onClick={() => { if (t >= duration) setT(0); setPlaying((p) => !p); }}>{playing ? "Pause" : "Play"}</button>
                <input type="range" className="flex-1 accent-[var(--color-accent)]" min={0} max={duration} step={0.01} value={t}
                  onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} />
                <span className="num w-20 text-right text-sm">{t.toFixed(2)} s</span>
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                {results.map((r) => {
                  const e = ENGINES.find((x) => x.id === r.engine)!;
                  return (
                    <div key={r.engine} className="space-y-2">
                      <div className="text-center text-sm" style={{ color: e.color }}>{e.label}</div>
                      <WheelReplay result={r} params={params} t={t} size={280} />
                      <dl className="num grid grid-cols-2 gap-y-0.5 text-xs">
                        <dt className="text-ink-400">Leaves track</dt><dd>{r.dropTimeS?.toFixed(2) ?? "–"} s</dd>
                        <dt className="text-ink-400">Reaches rotor</dt><dd>{r.rotorContactTimeS?.toFixed(2) ?? "–"} s</dd>
                        <dt className="text-ink-400">Settles</dt><dd>{r.settleTimeS?.toFixed(2) ?? "–"} s</dd>
                        <dt className="text-ink-400">Collisions</dt><dd>{r.collisions}</dd>
                        <dt className="text-ink-400">Compute</dt><dd>{r.wallMs.toFixed(0)} ms</dd>
                        <dt className="text-ink-400">Pocket</dt>
                        <dd>{r.finalPocket !== null ? <PocketTile pocket={r.finalPocket} /> : <span className="text-bad">{r.error}</span>}</dd>
                      </dl>
                    </div>
                  );
                })}
              </div>
              <MotionGraph series={omegaSeries} unit="ball ω, rad/s (whole spin)" windowMs={duration * 1000} />
            </section>
          )}

          {batch && (
            <section className="panel space-y-4 p-4">
              <div>
                <h2 className="font-semibold">Batch comparison</h2>
                <p className="text-xs text-ink-400">
                  Each run randomises launch angle, wheel phase and launch speed (±3 %). With random launch conditions,
                  every engine is expected to land close to uniform; differences between engines show model sensitivity, not an edge.
                </p>
              </div>
              {batch.summaries.map((s) => {
                const e = ENGINES.find((x) => x.id === s.engine)!;
                const max = Math.max(...s.probs, 2 / order.length);
                return (
                  <div key={s.engine} className="space-y-1">
                    <div className="num flex flex-wrap justify-between gap-2 text-xs">
                      <span style={{ color: e.color }}>{e.label}</span>
                      <span className="text-ink-400">
                        settled {s.settled}/{s.runs} · drop {s.meanDropTimeS?.toFixed(2) ?? "–"} ± {s.sdDropTimeS?.toFixed(2) ?? "–"} s · {(s.wallMs / s.runs).toFixed(0)} ms/run
                      </span>
                    </div>
                    <div className="flex h-16 items-end gap-[2px]">
                      {order.map((num, i) => (
                        <div key={num} className="relative flex-1" style={{ height: "100%" }} title={`${pocketLabel(num)}: ${(s.probs[i]! * 100).toFixed(1)}%`}>
                          <div className="absolute bottom-0 w-full rounded-t" style={{ height: `${(s.probs[i]! / max) * 100}%`, background: e.color, opacity: 0.85 }} />
                          <div className="absolute w-full border-t border-dashed border-warn" style={{ bottom: `${(1 / order.length / max) * 100}%` }} />
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-[2px]">
                      {order.map((num) => (
                        <span key={num} className={`num flex-1 text-center text-[8px] ${pocketColour(num) === "red" ? "text-[#ff6b72]" : pocketColour(num) === "green" ? "text-accent" : "text-ink-400"}`}>{pocketLabel(num)}</span>
                      ))}
                    </div>
                  </div>
                );
              })}
              <p className="num text-xs text-ink-300">
                Engine disagreement (Jensen–Shannon): {batch.disagreement !== null ? `${batch.disagreement.toFixed(3)} bits` : "–"}. With only{" "}
                {batch.summaries[0]?.runs ?? 0} runs per engine, sampling noise alone produces sizeable values; increase runs before drawing conclusions.
              </p>
            </section>
          )}

          {!results && !batch && (
            <div className="panel p-6 text-sm text-ink-400">Set parameters and press <b>Run one spin</b> to watch the engines side by side, or <b>Compare batch</b> for landing distributions.</div>
          )}
        </div>
      </div>
    </div>
  );
}
