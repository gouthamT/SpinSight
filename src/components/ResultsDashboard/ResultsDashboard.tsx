"use client";
import { kernelKey, viewFromKernel } from "@/engine/history/engineRelease";
import { KERNEL_SEED } from "@/engine/history/historyPredictor";
import { parseHistory } from "@/engine/history/parseHistory";
import { pocketLabel, pocketOrder, WHEEL_LABEL } from "@/engine/wheel/layout";
import { DEFAULT_SETTINGS, resultsStore } from "@/lib/storage/resultsStore";
import type {
  EngineKernel,
  EngineView,
  HistoryPrediction,
  HistorySettings,
  HistoryWorkerRequest,
  HistoryWorkerResponse,
  KernelWorkerRequest,
  KernelWorkerResponse,
  RankedPocket,
} from "@/types/history";
import type { WheelType } from "@/types/roulette";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HistoryInput } from "./HistoryInput";

const pct = (p: number, d = 1) => `${(p * 100).toFixed(d)}%`;
const ENGINES = ["kinematic", "rapier", "matter"] as const;
type EngineId = (typeof ENGINES)[number];

// Default order: physics first, then the three engines, then the statistical views.
const ROW_META: Record<string, { label: string; note: string }> = {
  physics: {
    label: "Physics",
    note: "Released from the last result: speeds, drop, deflectors, bounces, long rolls",
  },
  kinematic: {
    label: "Kinematic",
    note: "Full spins from the last result until the ball lands",
  },
  rapier: {
    label: "Rapier",
    note: "Full spins from the last result until the ball lands",
  },
  matter: {
    label: "Matter",
    note: "Full spins from the last result until the ball lands",
  },
  combined: {
    label: "Combined",
    note: "All models, weighted by how well each predicted your own history",
  },
  frequency: {
    label: "Hot numbers",
    note: "Pocket frequency in your history (wheel bias)",
  },
  offset: {
    label: "Sequence pattern",
    note: "Wheel distance between consecutive results",
  },
};
const DEFAULT_ORDER = Object.keys(ROW_META);
/** Statistical rows, hidden unless switched on in the results header. */
const STATS_ROWS = ["combined", "frequency", "offset"];
/** Rows whose first five feed the "Top picks" row. */
const PICK_ROWS = ["physics", "kinematic", "rapier", "matter"] as const;
const PICK_COLOURS = ["", "hsl(210 15% 80%)", "hsl(55 95% 60%)", "hsl(95 85% 58%)", "hsl(135 90% 58%)"];

/** Unique numbers from the first five of each physics view, most-agreed first. */
function TopPicks({ lists }: { lists: { id: string; top: RankedPocket[] }[] }) {
  const seen = new Map<number, { count: number; first: number; from: string[] }>();
  let k = 0;
  for (let rank = 0; rank < 5; rank++)
    for (const l of lists) {
      const r = l.top[rank];
      if (!r) continue;
      const e = seen.get(r.pocket) ?? { count: 0, first: k++, from: [] };
      e.count++;
      e.from.push(ROW_META[l.id]!.label);
      seen.set(r.pocket, e);
    }
  const picks = [...seen.entries()].sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first);
  return (
    <div className="grid grid-cols-10 gap-0.5">
      {picks.map(([pocket, e]) => {
        const c = PICK_COLOURS[Math.min(4, e.count)]!;
        return (
          <div
            key={pocket}
            className="relative flex min-w-0 items-center justify-center rounded-md border py-0.5"
            style={{ color: c, borderColor: c }}
            title={`${pocketLabel(pocket)} · in the first five of ${e.from.join(", ")}`}
          >
            <span className="num text-base font-extrabold tracking-tight sm:text-xl">{pocketLabel(pocket)}</span>
            {e.count > 1 && (
              <span className="num absolute right-0.5 top-0 text-[9px] font-bold leading-none opacity-80">{e.count}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function rank(probs: number[], wheelType: WheelType): RankedPocket[] {
  const order = pocketOrder(wheelType);
  return probs
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .map((x, r) => ({
      rank: r + 1,
      pocket: order[x.i]!,
      probability: x.p,
      stdError: 0,
    }));
}

/**
 * Ten numbers as coloured text (no tile background): bright green for the
 * strongest of the ten through yellow to bright red for the weakest. Colours
 * are chosen for contrast on the dark panel.
 */
function heatText(p: number, mid: number, maxDev: number): string {
  const t = Math.max(-1, Math.min(1, (p - mid) / maxDev));
  const hue = Math.round(65 + 65 * t); // 130 green … 65 yellow … 0 red
  return `hsl(${hue} 90% 62%)`;
}

function TenNumbers({
  top,
  baseline,
}: {
  top: RankedPocket[];
  baseline: number;
}) {
  const ten = top.slice(0, 10);
  const mid = (ten[0]!.probability + ten[ten.length - 1]!.probability) / 2;
  const maxDev = Math.max(
    ...ten.map((r) => Math.abs(r.probability - mid)),
    1e-12,
  );
  return (
    <div className="grid grid-cols-10 gap-0.5">
      {ten.map((r) => (
        <div
          key={r.pocket}
          className="flex min-w-0 items-center justify-center rounded-md border py-0.5"
          style={{ color: heatText(r.probability, mid, maxDev), borderColor: heatText(r.probability, mid, maxDev) }}
          title={`#${r.rank} · ${pocketLabel(r.pocket)} · ${pct(r.probability, 2)} (uniform ${pct(baseline, 2)})`}
        >
          <span className="num text-base font-extrabold tracking-tight sm:text-xl">
            {pocketLabel(r.pocket)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ResultsDashboard() {
  const [hydrated, setHydrated] = useState(false);
  const [wheelType, setWheelType] = useState<WheelType>(
    DEFAULT_SETTINGS.wheelType,
  );
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [ballDirection, setBallDirection] = useState<
    HistorySettings["physics"]["ballDirection"]
  >(DEFAULT_SETTINGS.physics.ballDirection);
  const [wheelDirection, setWheelDirection] = useState<
    HistorySettings["wheelDirection"]
  >(DEFAULT_SETTINGS.wheelDirection);
  const [startingPointIndex, setStartingPointIndex] = useState<number | null>(
    DEFAULT_SETTINGS.startingPointIndex,
  );
  const [text, setText] = useState("");
  const [prediction, setPrediction] = useState<HistoryPrediction | null>(null);
  const [guessedValues, setGuessedValues] = useState<number[] | null>(null);
  const [kernels, setKernels] = useState<
    Partial<Record<EngineId, EngineKernel>>
  >({});
  const [progress, setProgress] = useState<Partial<Record<EngineId, string>>>(
    {},
  );
  const [order, setOrder] = useState<string[]>(DEFAULT_ORDER);
  const [showStats, setShowStats] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statsWorker = useRef<Worker | null>(null);
  const kernelWorkers = useRef<Partial<Record<EngineId, Worker>>>({});
  const jobIds = useRef<Record<EngineId, number>>({
    kinematic: 0,
    rapier: 0,
    matter: 0,
  });
  const runIdRef = useRef(0);

  // ---- load persisted state ------------------------------------------------
  useEffect(() => {
    const w = resultsStore.loadWheel();
    const loaded = resultsStore.loadSettings();
    setWheelType(w);
    setSettings({
      ...loaded,
      wheelType: w,
      startingPointIndex: loaded.startingPointIndex ?? null,
      wheelDirection: loaded.wheelDirection,
      physics: {
        ...loaded.physics,
        ballDirection: loaded.physics.ballDirection,
      },
    });
    setBallDirection(loaded.physics.ballDirection);
    setWheelDirection(loaded.wheelDirection);
    setStartingPointIndex(loaded.startingPointIndex ?? null);
    const t = resultsStore.loadText();
    setText(t);
    const last = resultsStore.loadLast();
    setPrediction(last);
    if (last)
      setGuessedValues(parseHistory(t, w).values.slice(0, last.historyLength));
    setShowStats(resultsStore.loadShowStats());
    const saved = resultsStore.loadRowOrder();
    if (saved.length)
      setOrder([
        ...saved.filter((id) => id in ROW_META),
        ...DEFAULT_ORDER.filter((id) => !saved.includes(id)),
      ]);
    setHydrated(true);
  }, []);

  // ---- workers -----------------------------------------------------------------
  useEffect(() => {
    statsWorker.current = new Worker(
      new URL("../../workers/historySim.worker.ts", import.meta.url),
      { type: "module" },
    );
    for (const id of ENGINES) {
      kernelWorkers.current[id] = new Worker(
        new URL("../../workers/engineKernel.worker.ts", import.meta.url),
        { type: "module" },
      );
    }
    return () => {
      statsWorker.current?.terminate();
      for (const id of ENGINES) kernelWorkers.current[id]?.terminate();
    };
  }, []);

  // Physics learned from the history (by the stats worker) is the base for every physics view.
  const calibratedPhysics =
    settings.autoCalibrate !== false && prediction?.calibration?.applied
      ? prediction.calibration.physics
      : null;
  const calibratedKey = JSON.stringify(calibratedPhysics);
  const effectiveSettings = useMemo<HistorySettings>(
    () =>
      calibratedPhysics
        ? { ...settings, physics: { ...calibratedPhysics, ballDirection: settings.physics.ballDirection } }
        : settings,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings, calibratedKey],
  );

  // ---- background engine kernels: computed once per settings, cached ------------
  useEffect(() => {
    if (!hydrated) return;
    const s = { ...effectiveSettings, wheelType };
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
        if (m.type === "progress")
          setProgress((p) => ({ ...p, [id]: `${m.done}/${m.total}` }));
        else if (m.type === "kernel") {
          if (!m.kernel.error) resultsStore.saveKernel(m.kernel);
          setKernels((k) => ({ ...k, [id]: m.kernel }));
        } else
          setKernels((k) => ({
            ...k,
            [id]: { ...emptyKernel(id, key), error: m.message },
          }));
      };
      setProgress((p) => ({ ...p, [id]: "starting" }));
      w.postMessage({
        type: "kernel",
        engine: id,
        settings: s,
        seed: KERNEL_SEED,
        jobId,
      } satisfies KernelWorkerRequest);
    }
    setKernels(next);
  }, [hydrated, effectiveSettings, wheelType]);

  const parsed = useMemo(
    () => parseHistory(text, wheelType),
    [text, wheelType],
  );
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

  useEffect(() => {
    setSettings((previous) => {
      const nextSettings: HistorySettings = {
        ...previous,
        wheelType,
        startingPointIndex,
        wheelDirection,
        physics: {
          ...previous.physics,
          ballDirection,
        },
      };
      if (JSON.stringify(previous) === JSON.stringify(nextSettings))
        return previous;
      resultsStore.saveSettings(nextSettings);
      return nextSettings;
    });
  }, [ballDirection, startingPointIndex, wheelDirection, wheelType]);

  const toggleBallDirection = useCallback(() => {
    const nextDirection =
      ballDirection === "clockwise" ? "counter-clockwise" : "clockwise";
    setBallDirection(nextDirection);
  }, [ballDirection]);

  const toggleWheelDirection = useCallback(() => {
    const nextDirection: HistorySettings["wheelDirection"] =
      wheelDirection === 1 ? -1 : 1;
    setWheelDirection(nextDirection);
  }, [wheelDirection]);

  const setStartPocket = useCallback((nextIndex: number | null) => {
    setStartingPointIndex(nextIndex);
  }, []);

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
    w.postMessage({
      type: "run",
      values,
      settings: {
        ...settings,
        wheelType,
        startingPointIndex,
        physics: { ...settings.physics, ballDirection },
        wheelDirection,
      },
      seed: KERNEL_SEED,
      runId,
    } satisfies HistoryWorkerRequest);
  }, [
    ballDirection,
    parsed.values,
    settings,
    startingPointIndex,
    valid,
    wheelDirection,
    wheelType,
  ]);

  // Auto-guess: re-run (debounced) whenever valid results or settings change.
  useEffect(() => {
    if (!hydrated || !valid) return;
    setRunning(true); // show the loading state immediately while typing
    const id = setTimeout(guess, 600);
    return () => clearTimeout(id);
  }, [hydrated, valid, guess]);

  // ---- drag-to-reorder -------------------------------------------------------
  const visibleOrder = order.filter((id) => showStats || !STATS_ROWS.includes(id));
  // `to` is a position among the VISIBLE rows; hidden rows keep their place after them.
  const move = (id: string, to: number) => {
    setOrder((o) => {
      const vis = o.filter((x) => showStats || !STATS_ROWS.includes(x));
      const hidden = o.filter((x) => !vis.includes(x));
      const next = vis.filter((x) => x !== id);
      next.splice(Math.max(0, Math.min(to, next.length)), 0, id);
      const full = [...next, ...hidden];
      resultsStore.saveRowOrder(full);
      return full;
    });
  };
  const toggleStats = () => {
    setShowStats((v) => {
      resultsStore.saveShowStats(!v);
      return !v;
    });
  };

  const ballClockwise = ballDirection === "clockwise";
  const wheelClockwise = wheelDirection === 1;
  const ballArrow = ballClockwise ? "↻" : "↺";
  const wheelArrow = wheelClockwise ? "↺" : "↻";

  const baseline = 1 / pocketOrder(wheelType).length;
  const fresh =
    prediction &&
    prediction.historyLength === parsed.values.length &&
    prediction.wheelType === wheelType;
  const model = (id: string) => prediction?.models.find((m) => m.id === id);
  const engineView = (id: EngineId): EngineView | null => {
    const k = kernels[id];
    return k && guessedValues
      ? viewFromKernel(k, guessedValues, wheelType, startingPointIndex)
      : null;
  };

  const rowTop = (
    id: string,
  ): { top: RankedPocket[] | null; status?: string } => {
    if (!prediction) return { top: null };
    switch (id) {
      case "combined":
        return { top: prediction.ranked };
      case "frequency":
        return {
          top: model("frequency")
            ? rank(model("frequency")!.probs, wheelType)
            : null,
        };
      case "offset":
        return {
          top: model("sequence-offset")
            ? rank(model("sequence-offset")!.probs, wheelType)
            : null,
        };
      case "physics":
        return {
          top: model("physics-release")
            ? rank(model("physics-release")!.probs, wheelType)
            : null,
        };
      default: {
        const e = id as EngineId;
        const v = engineView(e);
        if (v?.error) return { top: null, status: v.error };
        if (!v)
          return {
            top: null,
            status: `Preparing simulations ${progress[e] ?? ""}… (one-off for these settings)`,
          };
        return { top: v.ranked };
      }
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-3 sm:space-y-4">
      <section className="panel space-y-3 p-3 sm:p-6">
        <div className="flex items-start gap-3">
          <div>
            <label htmlFor="history" className="text-lg font-semibold">
              Previous Roulette Results (Oldest → Newest)
            </label>
            <p className="text-xs text-ink-400">
              <span className="num text-ink-200">{parsed.values.length}</span>{" "}
              spins · {WHEEL_LABEL[wheelType]} ·{" "}
              <span
                title="Wheel configuration"
                className="inline-flex items-center gap-2"
              >
                <button
                  type="button"
                  className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 align-middle text-left transition ${
                    ballClockwise
                      ? "border-sky-500/60 bg-sky-500/10 text-sky-200"
                      : "border-sky-700 bg-sky-950/20 text-sky-300 hover:border-sky-500/60 hover:text-sky-200"
                  }`}
                  onClick={toggleBallDirection}
                  title="Toggle ball direction"
                  aria-label="Toggle ball direction"
                  aria-pressed={ballClockwise}
                >
                  <span>ball</span>
                  <span
                    aria-hidden="true"
                    className={`inline-flex h-4 w-4 items-center justify-center rounded-full border border-current/40 text-[10px] ${ballClockwise ? "bg-sky-500/15" : "bg-sky-900/40"}`}
                  >
                    {ballArrow}
                  </span>
                </button>
                <button
                  type="button"
                  className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 align-middle text-left transition ${
                    wheelClockwise
                      ? "border-amber-500/60 bg-amber-500/10 text-amber-200"
                      : "border-amber-700 bg-amber-950/20 text-amber-300 hover:border-amber-500/60 hover:text-amber-200"
                  }`}
                  onClick={toggleWheelDirection}
                  title="Toggle wheel direction"
                  aria-label="Toggle wheel direction"
                  aria-pressed={wheelClockwise}
                >
                  <span>wheel</span>
                  <span
                    aria-hidden="true"
                    className={`inline-flex h-4 w-4 items-center justify-center rounded-full border border-current/40 text-[10px] ${wheelClockwise ? "bg-amber-500/15" : "bg-amber-900/40"}`}
                  >
                    {wheelArrow}
                  </span>
                </button>
              </span>{" "}
              <span className="inline-flex items-center gap-1.5 rounded-md border border-ink-700 bg-ink-900 px-1.5 py-0.5">
                <span>start</span>
                <select
                  value={String(startingPointIndex ?? -1)}
                  onChange={(e) =>
                    setStartPocket(
                      e.target.value === "-1" ? null : Number(e.target.value),
                    )
                  }
                  className="bg-transparent text-ink-200 outline-none"
                  aria-label="Ball start pocket"
                  title="Ball start pocket"
                >
                  <option value="-1">auto</option>
                  {pocketOrder(wheelType).map((pocket, index) => (
                    <option key={pocket} value={String(index)}>
                      {pocketLabel(pocket)}
                    </option>
                  ))}
                </select>
              </span>
            </p>
          </div>
          <button
            className="btn-ghost ml-auto shrink-0"
            onClick={clearHistory}
            disabled={!text}
          >
            Clear
          </button>
        </div>
        <HistoryInput text={text} parsed={parsed} onChange={setText} />
      </section>

      {error && (
        <div className="rounded-lg border border-bad/40 bg-bad/10 p-3 text-sm text-bad">
          {error}
        </div>
      )}

      {(prediction || running) && (
        <section className="panel relative p-1.5 sm:p-3" aria-busy={running}>
          <div className="flex items-center justify-between px-1.5 pb-1 text-[11px] text-ink-400">
            <span className="flex items-center gap-2">
              Next spin
              <button
                type="button"
                onClick={toggleStats}
                aria-pressed={showStats}
                className="rounded border border-ink-600 px-1.5 py-0.5 text-[10px] text-ink-300 hover:border-accent hover:text-accent"
              >
                {showStats ? "Hide" : "Show"} stats rows
              </button>
            </span>
            <span
              className={`flex items-center gap-1.5 ${running ? "text-accent" : ""}`}
              role="status"
              aria-live="polite"
            >
              {running ? (
                <>
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                  Updating…
                </>
              ) : fresh ? (
                "Up to date"
              ) : (
                ""
              )}
            </span>
          </div>
          {prediction?.calibration && settings.autoCalibrate !== false && (
            <p
              className={`px-1.5 pb-1 text-[11px] ${prediction.calibration?.applied ? "text-accent" : "text-ink-400"}`}
              title={`Learned from your last ${prediction.calibration.spins} results, scored walk-forward (2·ln BF ${prediction.calibration.evidence2LnBF.toFixed(1)}; 6+ needed). Turn off in Settings.`}
            >
              {prediction.calibration?.applied ? "Calibrated from history: " : "Calibration: "}
              {prediction.calibration.reason}
            </p>
          )}
          {(() => {
            const lists = PICK_ROWS.map((id) => ({ id, top: rowTop(id).top })).filter(
              (l): l is { id: (typeof PICK_ROWS)[number]; top: RankedPocket[] } => !!l.top,
            );
            if (!lists.length) return null;
            return (
              <div className={`rounded-lg border border-accent/30 px-1.5 py-0.5 ${running ? "opacity-50" : ""}`}>
                <div className="mb-0.5 flex items-baseline gap-2 pl-1">
                  <h3 className="shrink-0 text-sm font-semibold">Top picks</h3>
                  <p className="truncate text-[11px] text-ink-400">
                    Unique first fives of {lists.map((l) => ROW_META[l.id]!.label).join(", ")}; small number = how many agree
                  </p>
                </div>
                <TopPicks lists={lists} />
              </div>
            );
          })()}
          {visibleOrder.map((id, idx) => {
            const meta = ROW_META[id]!;
            const r = rowTop(id);
            return (
              <div
                key={id}
                ref={(el) => {
                  rowRefs.current[id] = el;
                }}
                className={`rounded-lg border px-1.5 py-0.5 transition ${dragging === id ? "border-accent/70 bg-ink-850 shadow-lg" : "border-transparent"} ${running ? "opacity-50" : ""}`}
              >
                <div className="mb-0.5 flex items-center gap-1">
                  {/* Drag handle: pointer events work for touch, pen and mouse. */}
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={`Drag ${meta.label} to reorder`}
                    className="-ml-1 flex h-8 w-8 shrink-0 cursor-grab touch-none select-none items-center justify-center rounded-lg text-lg text-ink-400 active:cursor-grabbing active:bg-ink-800"
                    onPointerDown={(e) => {
                      e.currentTarget.setPointerCapture(e.pointerId);
                      setDragging(id);
                    }}
                    onPointerMove={(e) => {
                      if (dragging !== id) return;
                      const y = e.clientY;
                      let target = 0;
                      visibleOrder.forEach((other) => {
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
                  <div className="flex min-w-0 items-baseline gap-2">
                    <h3 className="shrink-0 text-sm font-semibold">
                      {meta.label}
                    </h3>
                    <p className="truncate text-[11px] text-ink-400">
                      {meta.note}
                    </p>
                  </div>
                </div>
                {r.top ? (
                  <TenNumbers top={r.top} baseline={baseline} />
                ) : r.status ? (
                  <div className="px-1 text-xs text-ink-400">{r.status}</div>
                ) : (
                  <div className="grid grid-cols-10 gap-0.5">
                    {Array.from({ length: 10 }, (_, i) => (
                      <div
                        key={i}
                        className="mx-auto my-1 h-5 w-5 animate-pulse rounded bg-ink-800 sm:h-6 sm:w-6"
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <p className="mt-1 border-t border-ink-700 px-1.5 pt-2 text-[11px] leading-relaxed text-ink-400">
            Updates automatically as you type. Green first; hold ⠿ to
            reorder. {prediction?.verdictText} On a fair wheel every number has
            a {pct(baseline, 2)} chance; these are experimental model outputs,
            not verified predictions.
          </p>
        </section>
      )}
    </div>
  );
}

function emptyKernel(engine: EngineId, key: string): EngineKernel {
  return {
    engine,
    key,
    runs: 0,
    settled: 0,
    offsetCounts: [],
    longRollShare: 0,
    meanDropS: null,
    meanSettleS: null,
    elapsedMs: 0,
    error: null,
  };
}
