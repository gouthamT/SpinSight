"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { WheelType } from "@/types/roulette";
import type { EngineView, HistoryPrediction, HistoryWorkerRequest, HistoryWorkerResponse, RankedPocket } from "@/types/history";
import { parseHistory } from "@/engine/history/parseHistory";
import { pocketLabel, pocketOrder, WHEEL_LABEL } from "@/engine/wheel/layout";
import { DEFAULT_SETTINGS, resultsStore } from "@/lib/storage/resultsStore";
import { HistoryInput } from "./HistoryInput";
import { heatColour } from "./PredictionResults";

const pct = (p: number, d = 1) => `${(p * 100).toFixed(d)}%`;

interface Row {
  id: string;
  label: string;
  note: string;
  top: RankedPocket[] | null;
  status?: string;
}

function rank(probs: number[], wheelType: WheelType): RankedPocket[] {
  const order = pocketOrder(wheelType);
  return probs
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .map((x, r) => ({ rank: r + 1, pocket: order[x.i]!, probability: x.p, stdError: 0 }));
}

/** Ten numbers, shaded dark green (strongest) → dark red (weakest) within the ten. */
function TenNumbers({ top, baseline }: { top: RankedPocket[]; baseline: number }) {
  const ten = top.slice(0, 10);
  const mid = (ten[0]!.probability + ten[ten.length - 1]!.probability) / 2;
  const maxDev = Math.max(...ten.map((r) => Math.abs(r.probability - mid)), 1e-12);
  return (
    <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-10">
      {ten.map((r) => {
        const c = heatColour(r.probability, mid, maxDev);
        return (
          <div
            key={r.pocket}
            className="flex aspect-square items-center justify-center rounded-lg"
            style={{ background: c.bg, color: c.fg }}
            title={`#${r.rank} · ${pocketLabel(r.pocket)} · ${pct(r.probability, 2)} (uniform ${pct(baseline, 2)})`}
          >
            <span className="num text-lg font-bold">{pocketLabel(r.pocket)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ResultsDashboard() {
  const [hydrated, setHydrated] = useState(false);
  const [wheelType, setWheelType] = useState<WheelType>(DEFAULT_SETTINGS.wheelType);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [text, setText] = useState("");
  const [prediction, setPrediction] = useState<HistoryPrediction | null>(null);
  const [engineViews, setEngineViews] = useState<EngineView[]>([]);
  const [progress, setProgress] = useState<Partial<Record<EngineView["engine"], string>>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const worker = useRef<Worker | null>(null);
  const runIdRef = useRef(0);

  useEffect(() => {
    const w = resultsStore.loadWheel();
    setWheelType(w);
    setSettings({ ...resultsStore.loadSettings(), wheelType: w });
    setText(resultsStore.loadText());
    setPrediction(resultsStore.loadLast());
    setEngineViews(resultsStore.loadEngines());
    setHydrated(true);
  }, []);

  useEffect(() => {
    const w = new Worker(new URL("../../workers/historySim.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    return () => w.terminate();
  }, []);

  const parsed = useMemo(() => parseHistory(text, wheelType), [text, wheelType]);
  const valid = parsed.errors.length === 0;

  // Auto-save (debounced). Invalid text is never saved over good history.
  useEffect(() => {
    if (!hydrated || !valid) return;
    const id = setTimeout(() => resultsStore.saveText(text), 400);
    return () => clearTimeout(id);
  }, [text, valid, hydrated]);

  const clearHistory = () => {
    if (!window.confirm("Clear all results? This cannot be undone.")) return;
    resultsStore.clearAll();
    setText("");
    setPrediction(null);
    setEngineViews([]);
  };

  const guess = useCallback(() => {
    const w = worker.current;
    if (!w || !valid) return;
    setRunning(true);
    setError(null);
    setEngineViews([]);
    setProgress({});
    const runId = ++runIdRef.current;
    w.onmessage = (e: MessageEvent<HistoryWorkerResponse>) => {
      const m = e.data;
      if (m.runId !== runIdRef.current) return;
      if (m.type === "error") {
        setRunning(false);
        setError(m.message);
      } else if (m.type === "engine-progress") {
        setProgress((p) => ({ ...p, [m.engine]: `${m.done}/${m.total}` }));
      } else if (m.type === "engine") {
        setEngineViews((vs) => {
          const next = [...vs.filter((v) => v.engine !== m.view.engine), m.view];
          resultsStore.saveEngines(next);
          if (next.length === 3) setRunning(false);
          return next;
        });
      } else {
        setPrediction(m.prediction);
        resultsStore.saveLast(m.prediction);
      }
    };
    const req: HistoryWorkerRequest = {
      type: "run",
      values: parsed.values,
      settings: { ...settings, wheelType },
      seed: Math.floor(Math.random() * 2 ** 31),
      runId,
    };
    w.postMessage(req);
  }, [parsed.values, settings, valid, wheelType]);

  const baseline = 1 / pocketOrder(wheelType).length;
  const fresh = prediction && prediction.historyLength === parsed.values.length && prediction.wheelType === wheelType;
  const model = (id: string) => prediction?.models.find((m) => m.id === id);
  const engine = (id: EngineView["engine"]) => engineViews.find((v) => v.engine === id) ?? null;
  const engineStatus = (id: EngineView["engine"]) => {
    const v = engine(id);
    if (v?.error) return v.error;
    if (!v) return running ? (progress[id] ? `Simulating ${progress[id]} spins…` : "Waiting…") : "Press Guess";
    return undefined;
  };

  const rows: Row[] = prediction
    ? [
        { id: "combined", label: "Combined", note: "All models, weighted by how well each predicted your own history", top: prediction.ranked },
        { id: "frequency", label: "Hot numbers", note: "Pocket frequency in your history (wheel bias)", top: model("frequency") ? rank(model("frequency")!.probs, wheelType) : null },
        { id: "offset", label: "Sequence pattern", note: "Wheel distance between consecutive results", top: model("sequence-offset") ? rank(model("sequence-offset")!.probs, wheelType) : null },
        { id: "physics", label: "Physics (quick)", note: "Released from the last result: speeds, drop, deflectors, bounces, long rolls", top: model("physics-release") ? rank(model("physics-release")!.probs, wheelType) : null },
        ...(["kinematic", "rapier", "matter"] as const).map((id) => ({
          id,
          label: id === "kinematic" ? "Kinematic engine" : id === "rapier" ? "Rapier.js engine" : "Matter.js engine",
          note: "Full spins from the last result until the ball lands",
          top: engine(id) && !engine(id)!.error ? engine(id)!.ranked : null,
          status: engineStatus(id),
        })),
      ]
    : [];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <section className="panel space-y-3 p-4 sm:p-6">
        <div className="flex items-start gap-3">
          <div>
            <label htmlFor="history" className="text-lg font-semibold">Previous Roulette Results (Oldest → Newest)</label>
            <p className="text-xs text-ink-400">
              <span className="num text-ink-200">{parsed.values.length}</span> spins · {WHEEL_LABEL[wheelType]} ·{" "}
              <Link href="/settings" className="text-accent hover:underline">Settings</Link>
            </p>
          </div>
          <button className="btn-ghost ml-auto shrink-0" onClick={clearHistory} disabled={!text}>Clear</button>
        </div>
        <HistoryInput text={text} parsed={parsed} onChange={setText} />
      </section>

      <button
        className="w-full rounded-xl bg-accent px-6 py-5 text-xl font-bold tracking-wide text-ink-950 shadow-lg shadow-accent/10 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        onClick={guess}
        disabled={!valid || running || !hydrated}
      >
        {running ? "Guessing…" : "Guess"}
      </button>
      {error && <div className="rounded-lg border border-bad/40 bg-bad/10 p-3 text-sm text-bad">{error}</div>}

      {prediction && (
        <section className="panel space-y-5 p-4 sm:p-6">
          {!fresh && <p className="text-xs text-warn">Results changed since this guess. Press Guess to update.</p>}
          {rows.map((r) => (
            <div key={r.id} className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <h3 className="font-semibold">{r.label}</h3>
                <span className="text-[11px] text-ink-400">{r.note}</span>
              </div>
              {r.top ? <TenNumbers top={r.top} baseline={baseline} /> : <div className="text-xs text-ink-400">{r.status}</div>}
            </div>
          ))}
          <p className="border-t border-ink-700 pt-3 text-[11px] leading-relaxed text-ink-400">
            Ten numbers per row, darkest green first. {prediction.verdictText} On a fair wheel every number has a{" "}
            {pct(baseline, 2)} chance; these are experimental model outputs, not verified predictions.
          </p>
        </section>
      )}
    </div>
  );
}
