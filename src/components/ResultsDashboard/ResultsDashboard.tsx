"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { WheelType } from "@/types/roulette";
import type {
  EngineKernel,
  EngineView,
  HistoryPrediction,
  HistoryWorkerRequest,
  HistoryWorkerResponse,
  KernelWorkerRequest,
  KernelWorkerResponse,
  RankedPocket,
} from "@/types/history";
import { parseHistory } from "@/engine/history/parseHistory";
import { kernelKey, viewFromKernel } from "@/engine/history/engineRelease";
import { KERNEL_SEED } from "@/engine/history/historyPredictor";
import { pocketLabel, pocketOrder, WHEEL_LABEL } from "@/engine/wheel/layout";
import { DEFAULT_SETTINGS, resultsStore } from "@/lib/storage/resultsStore";
import { HistoryInput } from "./HistoryInput";
import { heatColour } from "./PredictionResults";

const pct = (p: number, d = 1) => `${(p * 100).toFixed(d)}%`;
const ENGINES = ["kinematic", "rapier", "matter"] as const;
type EngineId = (typeof ENGINES)[number];

// Default order: physics first, then the three engines, then the statistical views.
const ROW_META: Record<string, { label: string; note: string }> = {
  physics: { label: "Physics", note: "Released from the last result: speeds, drop, deflectors, bounces, long rolls" },
  kinematic: { label: "Kinematic", note: "Full spins from the last result until the ball lands" },
  rapier: { label: "Rapier", note: "Full spins from the last result until the ball lands" },
  matter: { label: "Matter", note: "Full spins from the last result until the ball lands" },
  combined: { label: "Combined", note: "All models, weighted by how well each predicted your own history" },
  frequency: { label: "Hot numbers", note: "Pocket frequency in your history (wheel bias)" },
  offset: { label: "Sequence pattern", note: "Wheel distance between consecutive results" },
};
const DEFAULT_ORDER = Object.keys(ROW_META);

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
    <div className="grid grid-cols-10 gap-1 sm:gap-1.5">
      {ten.map((r) => {
        const c = heatColour(r.probability, mid, maxDev);
        return (
          <div
            key={r.pocket}
            className="flex aspect-square min-w-0 items-center justify-center rounded-md sm:rounded-lg"
            style={{ background: c.bg, color: c.fg }}
            title={`#${r.rank} · ${pocketLabel(r.pocket)} · ${pct(r.probability, 2)} (uniform ${pct(baseline, 2)})`}
          >
            <span className="num text-[13px] font-bold tracking-tighter sm:text-lg sm:tracking-normal">{pocketLabel(r.pocket)}</span>
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
  const [guessedValues, setGuessedValues] = useState<number[] | null>(null);
  const [kernels, setKernels] = useState<Partial<Record<EngineId, EngineKernel>>>({});
  const [progress, setProgress] = useState<Partial<Record<EngineId, string>>>({});
  const [order, setOrder] = useState<string[]>(DEFAULT_ORDER);
  const [dragging, setDragging] = useState<string | null>(null);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statsWorker = useRef<Worker | null>(null);
  const kernelWorkers = useRef<Partial<Record<EngineId, Worker>>>({});
  const jobIds = useRef<Record<EngineId, number>>({ kinematic: 0, rapier: 0, matter: 0 });
  const runIdRef = useRef(0);

  // ---- load persisted state ------------------------------------------------
  useEffect(() => {
    const w = resultsStore.loadWheel();
    setWheelType(w);
    setSettings({ ...resultsStore.loadSettings(), wheelType: w });
    const t = resultsStore.loadText();
    setText(t);
    const last = resultsStore.loadLast();
    setPrediction(last);
    if (last) setGuessedValues(parseHistory(t, w).values.slice(0, last.historyLength));
    const saved = resultsStore.loadRowOrder();
    if (saved.length) setOrder([...saved.filter((id) => id in ROW_META), ...DEFAULT_ORDER.filter((id) => !saved.includes(id))]);
    setHydrated(true);
  }, []);

  // ---- workers -----------------------------------------------------------------
  useEffect(() => {
    statsWorker.current = new Worker(new URL("../../workers/historySim.worker.ts", import.meta.url), { type: "module" });
    for (const id of ENGINES) {
      kernelWorkers.current[id] = new Worker(new URL("../../workers/engineKernel.worker.ts", import.meta.url), { type: "module" });
    }
    return () => {
      statsWorker.current?.terminate();
      for (const id of ENGINES) kernelWorkers.current[id]?.terminate();
    };
  }, []);

  // ---- background engine kernels: computed once per settings, cached ------------
  useEffect(() => {
    if (!hydrated) return;
    const s = { ...settings, wheelType };
    const cache = resultsStore.loadKernels();
    const next: Partial<Record<EngineId, EngineKernel>> = {};
    for (const id of ENGINES) {
      const key = kernelKey(id, s, KERNEL_SEED);
      const hit = cache[key];
      if (hit && !hit.error) {
        next[id] = hit;
        continue;
      }
      const w = kernelWorkers.current[id];
      if (!w) continue;
      const jobId = ++jobIds.current[id];
      w.onmessage = (e: MessageEvent<KernelWorkerResponse>) => {
        const m = e.data;
        if (m.jobId !== jobIds.current[id]) return;
        if (m.type === "progress") setProgress((p) => ({ ...p, [id]: `${m.done}/${m.total}` }));
        else if (m.type === "kernel") {
          if (!m.kernel.error) resultsStore.saveKernel(m.kernel);
          setKernels((k) => ({ ...k, [id]: m.kernel }));
        } else setKernels((k) => ({ ...k, [id]: { ...emptyKernel(id, key), error: m.message } }));
      };
      setProgress((p) => ({ ...p, [id]: "starting" }));
      w.postMessage({ type: "kernel", engine: id, settings: s, seed: KERNEL_SEED, jobId } satisfies KernelWorkerRequest);
    }
    setKernels(next);
  }, [hydrated, settings, wheelType]);

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
    setGuessedValues(null);
  };

  const guess = useCallback(() => {
    const w = statsWorker.current;
    if (!w || !valid) return;
    setRunning(true);
    setError(null);
    const runId = ++runIdRef.current;
    const values = parsed.values;
    w.onmessage = (e: MessageEvent<HistoryWorkerResponse>) => {
      const m = e.data;
      if (m.runId !== runIdRef.current) return;
      setRunning(false);
      if (m.type === "error") return setError(m.message);
      setPrediction(m.prediction);
      setGuessedValues(values);
      resultsStore.saveLast(m.prediction);
    };
    w.postMessage({ type: "run", values, settings: { ...settings, wheelType }, seed: KERNEL_SEED, runId } satisfies HistoryWorkerRequest);
  }, [parsed.values, settings, valid, wheelType]);

  // ---- drag-to-reorder -------------------------------------------------------
  const move = (id: string, to: number) => {
    setOrder((o) => {
      const next = o.filter((x) => x !== id);
      next.splice(Math.max(0, Math.min(to, next.length)), 0, id);
      resultsStore.saveRowOrder(next);
      return next;
    });
  };

  const baseline = 1 / pocketOrder(wheelType).length;
  const fresh = prediction && prediction.historyLength === parsed.values.length && prediction.wheelType === wheelType;
  const model = (id: string) => prediction?.models.find((m) => m.id === id);
  const engineView = (id: EngineId): EngineView | null => {
    const k = kernels[id];
    return k && guessedValues ? viewFromKernel(k, guessedValues, wheelType) : null;
  };

  const rowTop = (id: string): { top: RankedPocket[] | null; status?: string } => {
    if (!prediction) return { top: null };
    switch (id) {
      case "combined":
        return { top: prediction.ranked };
      case "frequency":
        return { top: model("frequency") ? rank(model("frequency")!.probs, wheelType) : null };
      case "offset":
        return { top: model("sequence-offset") ? rank(model("sequence-offset")!.probs, wheelType) : null };
      case "physics":
        return { top: model("physics-release") ? rank(model("physics-release")!.probs, wheelType) : null };
      default: {
        const e = id as EngineId;
        const v = engineView(e);
        if (v?.error) return { top: null, status: v.error };
        if (!v) return { top: null, status: `Preparing simulations ${progress[e] ?? ""}… (one-off for these settings)` };
        return { top: v.ranked };
      }
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4 sm:space-y-6">
      <section className="panel space-y-3 p-3 sm:p-6">
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
        className="sticky bottom-3 z-10 w-full rounded-xl bg-accent px-6 py-4 text-xl font-bold sm:static sm:py-5 tracking-wide text-ink-950 shadow-lg shadow-accent/10 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        onClick={guess}
        disabled={!valid || running || !hydrated}
      >
        {running ? "Guessing…" : "Guess"}
      </button>
      {error && <div className="rounded-lg border border-bad/40 bg-bad/10 p-3 text-sm text-bad">{error}</div>}

      {prediction && (
        <section className="panel space-y-1 p-2 sm:p-4">
          {!fresh && <p className="text-xs text-warn">Results changed since this guess. Press Guess to update.</p>}
          {order.map((id, idx) => {
            const meta = ROW_META[id]!;
            const r = rowTop(id);
            return (
              <div
                key={id}
                ref={(el) => {
                  rowRefs.current[id] = el;
                }}
                className={`rounded-xl border p-2 transition-colors ${dragging === id ? "border-accent/70 bg-ink-850 shadow-lg" : "border-transparent"}`}
              >
                <div className="mb-2 flex items-center gap-1">
                  {/* Drag handle: pointer events work for touch, pen and mouse. */}
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={`Drag ${meta.label} to reorder`}
                    className="-ml-1 flex h-10 w-10 shrink-0 cursor-grab touch-none select-none items-center justify-center rounded-lg text-lg text-ink-400 active:cursor-grabbing active:bg-ink-800"
                    onPointerDown={(e) => {
                      e.currentTarget.setPointerCapture(e.pointerId);
                      setDragging(id);
                    }}
                    onPointerMove={(e) => {
                      if (dragging !== id) return;
                      const y = e.clientY;
                      let target = 0;
                      order.forEach((other) => {
                        if (other === id) return;
                        const el = rowRefs.current[other];
                        if (el) {
                          const b = el.getBoundingClientRect();
                          if (y > b.top + b.height / 2) target++;
                        }
                      });
                      if (target !== idx) move(id, target);
                    }}
                    onPointerUp={() => setDragging(null)}
                    onPointerCancel={() => setDragging(null)}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowUp") move(id, idx - 1);
                      if (e.key === "ArrowDown") move(id, idx + 1);
                    }}
                  >
                    ⠿
                  </span>
                  <div className="min-w-0">
                    <h3 className="font-semibold leading-tight">{meta.label}</h3>
                    <p className="truncate text-[11px] text-ink-400">{meta.note}</p>
                  </div>
                </div>
                {r.top ? <TenNumbers top={r.top} baseline={baseline} /> : <div className="px-1 text-xs text-ink-400">{r.status}</div>}
              </div>
            );
          })}
          <p className="border-t border-ink-700 pt-3 text-[11px] leading-relaxed text-ink-400">
            Ten numbers per row, darkest green first. Hold ⠿ and drag to reorder. {prediction.verdictText} On a fair wheel
            every number has a {pct(baseline, 2)} chance; these are experimental model outputs, not verified predictions.
          </p>
        </section>
      )}
    </div>
  );
}

function emptyKernel(engine: EngineId, key: string): EngineKernel {
  return { engine, key, runs: 0, settled: 0, offsetCounts: [], longRollShare: 0, meanDropS: null, meanSettleS: null, elapsedMs: 0, error: null };
}
