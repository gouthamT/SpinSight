"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WheelType } from "@/types/roulette";
import type { HistoryPrediction, HistorySettings, HistoryWorkerRequest, HistoryWorkerResponse, PredictionLogEntry } from "@/types/history";
import Link from "next/link";
import { parseHistory, formatHistory } from "@/engine/history/parseHistory";
import { pocketCount, pocketLabel, pocketOrder, WHEEL_LABEL } from "@/engine/wheel/layout";
import { DEFAULT_SETTINGS, resultsStore } from "@/lib/storage/resultsStore";
import { HistoryInput } from "./HistoryInput";
import { PocketTile, PredictionResults } from "./PredictionResults";

export function ResultsDashboard() {
  const [hydrated, setHydrated] = useState(false);
  const [wheelType, setWheelType] = useState<WheelType>("european");
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [settings, setSettings] = useState<HistorySettings>(DEFAULT_SETTINGS);
  const [prediction, setPrediction] = useState<HistoryPrediction | null>(null);
  const [log, setLog] = useState<PredictionLogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actual, setActual] = useState("");
  const [actualError, setActualError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const worker = useRef<Worker | null>(null);

  // Load persisted state (client only).
  useEffect(() => {
    const w = resultsStore.loadWheel();
    const t = resultsStore.loadText();
    setWheelType(w);
    setText(t);
    setSavedText(t);
    setSettings({ ...resultsStore.loadSettings(), wheelType: w });
    setPrediction(resultsStore.loadLast());
    setLog(resultsStore.loadLog());
    setHydrated(true);
  }, []);

  useEffect(() => {
    const w = new Worker(new URL("../../workers/historySim.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    return () => w.terminate();
  }, []);

  const parsed = useMemo(() => parseHistory(text, wheelType), [text, wheelType]);
  const valid = parsed.errors.length === 0;
  const dirty = text !== savedText;

  // Auto-save valid input (debounced). Invalid input is never saved over good history.
  useEffect(() => {
    if (!hydrated || !valid || !dirty) return;
    const id = setTimeout(() => {
      resultsStore.saveText(text);
      setSavedText(text);
    }, 500);
    return () => clearTimeout(id);
  }, [text, valid, dirty, hydrated]);

  const say = (m: string) => {
    setFlash(m);
    setTimeout(() => setFlash(null), 2200);
  };

  const changeWheel = (w: WheelType) => {
    setWheelType(w);
    resultsStore.saveWheel(w);
    const s = { ...settings, wheelType: w };
    setSettings(s);
    resultsStore.saveSettings(s);
  };

  const saveNow = () => {
    if (!valid) return;
    const normalised = formatHistory(parsed.values);
    setText(normalised);
    resultsStore.saveText(normalised);
    setSavedText(normalised);
    say(`Saved ${parsed.values.length} results.`);
  };

  const clearHistory = () => {
    if (!window.confirm("Clear all recorded results, the last prediction and the prediction log? This cannot be undone.")) return;
    resultsStore.clearAll();
    setText("");
    setSavedText("");
    setPrediction(null);
    setLog([]);
    say("History cleared.");
  };

  const run = useCallback(
    (seed = Math.floor(Math.random() * 2 ** 31)) => {
      const w = worker.current;
      if (!w || !valid) return;
      setRunning(true);
      setError(null);
      const values = parsed.values;
      w.onmessage = (e: MessageEvent<HistoryWorkerResponse>) => {
        setRunning(false);
        if (e.data.type === "error") {
          setError(e.data.message);
          return;
        }
        const p = e.data.prediction;
        setPrediction(p);
        resultsStore.saveLast(p);
        const entry: PredictionLogEntry = {
          createdAt: p.createdAt,
          historyLength: p.historyLength,
          top10: p.top10.map((r) => r.pocket),
          actual: null,
          inTop10: null,
          probOfActual: null,
        };
        setLog((l) => {
          // Replace an unscored entry for the same history length (a "run again").
          const keep = l.filter((x) => !(x.actual === null && x.historyLength === p.historyLength));
          const next = [...keep, entry];
          resultsStore.saveLog(next);
          return next;
        });
      };
      const req: HistoryWorkerRequest = { type: "run", values, settings: { ...settings, wheelType }, seed };
      w.postMessage(req);
    },
    [parsed.values, settings, valid, wheelType],
  );

  const addActual = () => {
    const p = parseHistory(actual.trim(), wheelType);
    if (p.values.length !== 1 || p.errors.length) {
      setActualError(p.errors[0]?.error ?? "Enter exactly one result.");
      return;
    }
    if (!valid) {
      setActualError("Fix the invalid entries in the history first.");
      return;
    }
    const v = p.values[0]!;
    const next = [...parsed.values, v];
    const t = formatHistory(next);
    setText(t);
    resultsStore.saveText(t);
    setSavedText(t);
    setActual("");
    setActualError(null);
    // Score the latest unscored prediction made on the previous history.
    if (prediction && prediction.historyLength === parsed.values.length && prediction.wheelType === wheelType) {
      const idx = pocketOrder(wheelType).indexOf(v);
      setLog((l) => {
        const out = [...l];
        for (let i = out.length - 1; i >= 0; i--) {
          const e = out[i]!;
          if (e.actual === null && e.historyLength === prediction.historyLength) {
            out[i] = { ...e, actual: v, inTop10: e.top10.includes(v), probOfActual: prediction.probs[idx] ?? null };
            break;
          }
        }
        resultsStore.saveLog(out);
        return out;
      });
      say(`Added ${pocketLabel(v)}. ${prediction.top10.some((r) => r.pocket === v) ? "It was in the last top 10." : "It was not in the last top 10."}`);
    } else {
      say(`Added ${pocketLabel(v)}.`);
    }
  };

  const N = pocketCount(wheelType);
  const scored = log.filter((e) => e.actual !== null);
  const hits = scored.filter((e) => e.inTop10).length;
  const expectedHits = (scored.length * Math.min(10, N)) / N;
  const meanProb = scored.length ? scored.reduce((a, e) => a + (e.probOfActual ?? 1 / N), 0) / scored.length : null;
  const stale = prediction && (prediction.historyLength !== parsed.values.length || prediction.wheelType !== wheelType);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* 1. History input */}
      <section className="panel space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <label htmlFor="history" className="text-lg font-semibold">Previous Roulette Results (Oldest → Newest)</label>
            <p className="text-xs text-ink-400">Separate numbers with spaces. The newest result goes last.</p>
          </div>
          <select className="input w-auto" value={wheelType} onChange={(e) => changeWheel(e.target.value as WheelType)} aria-label="Wheel type">
            {(Object.keys(WHEEL_LABEL) as WheelType[]).map((w) => (
              <option key={w} value={w}>{WHEEL_LABEL[w]}</option>
            ))}
          </select>
        </div>

        <HistoryInput text={text} parsed={parsed} onChange={setText} />

        <div className="flex flex-wrap items-center gap-2">
          <span className="num rounded-lg bg-ink-800 px-3 py-2 text-sm">
            <span className="text-ink-400">Recorded spins </span>{parsed.values.length}
          </span>
          <span className="text-xs text-ink-400">{!valid ? "Not saved (invalid entries)" : dirty ? "Saving…" : hydrated ? "Saved in this browser" : ""}</span>
          <div className="ml-auto flex gap-2">
            <button className="btn-ghost" onClick={clearHistory} disabled={!text && !log.length}>Clear history</button>
            <button className="btn-ghost" onClick={saveNow} disabled={!valid}>Update results</button>
          </div>
        </div>
        {flash && <div className="text-sm text-accent">{flash}</div>}
      </section>

      {/* 2. Guess */}
      <div className="space-y-2">
        <button
          className="w-full rounded-xl bg-accent px-6 py-5 text-lg font-bold tracking-wide text-ink-950 shadow-lg shadow-accent/10 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => run()}
          disabled={!valid || running || !hydrated}
        >
          {running ? "SIMULATING…" : "GUESS NEXT 10 NUMBERS"}
        </button>
        <p className="text-center text-xs text-ink-400">
          {settings.simulations.toLocaleString()} physics simulations + statistical tests on your history. Experimental model, not a verified prediction.
        </p>
        {error && <div className="rounded-lg border border-bad/40 bg-bad/10 p-3 text-sm text-bad">{error}</div>}
      </div>

      {/* 3. Results */}
      {prediction && (
        <>
          {stale && (
            <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm text-warn">
              These results were computed for an earlier history ({prediction.historyLength} results, {WHEEL_LABEL[prediction.wheelType]}). Press Guess to update.
            </div>
          )}
          <PredictionResults p={prediction} running={running} onRunAgain={() => run()} />
        </>
      )}

      {/* 4. Update results */}
      <section className="panel space-y-4 p-4 sm:p-6">
        <div>
          <h2 className="text-lg font-semibold">Update results</h2>
          <p className="text-xs text-ink-400">Enter what actually came up next. It is appended as the newest result and scored against the last guess.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            className="input num w-32 text-lg"
            inputMode="numeric"
            placeholder="e.g. 17"
            value={actual}
            onChange={(e) => {
              setActual(e.target.value);
              setActualError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && addActual()}
            aria-label="Actual next result"
          />
          <button className="btn-primary px-5" onClick={addActual} disabled={!actual.trim()}>UPDATE RESULTS</button>
          {prediction && !stale && (
            <span className="flex items-center gap-1 text-xs text-ink-400">
              Last top 10: {prediction.top10.slice(0, 10).map((r) => <PocketTile key={r.pocket} pocket={r.pocket} />)}
            </span>
          )}
        </div>
        {actualError && <div className="text-sm text-bad">{actualError}</div>}

        <div className="rounded-lg border border-ink-700 p-3">
          <div className="panel-title mb-2">Your guess record (measured accuracy)</div>
          {scored.length === 0 ? (
            <p className="text-xs text-ink-400">No scored guesses yet. Guess, then enter the actual result.</p>
          ) : (
            <div className="num grid grid-cols-2 gap-y-1 text-sm sm:grid-cols-4">
              <span className="text-ink-400">Scored guesses</span><span>{scored.length}</span>
              <span className="text-ink-400">In top 10</span>
              <span>{hits} <span className="text-ink-400">(chance ≈ {expectedHits.toFixed(1)})</span></span>
              <span className="text-ink-400">Hit rate</span>
              <span>{((hits / scored.length) * 100).toFixed(1)}% <span className="text-ink-400">(chance {((Math.min(10, N) / N) * 100).toFixed(1)}%)</span></span>
              <span className="text-ink-400">Avg. prob. of actual</span>
              <span>{meanProb !== null ? `${(meanProb * 100).toFixed(2)}%` : "–"} <span className="text-ink-400">(chance {(100 / N).toFixed(2)}%)</span></span>
            </div>
          )}
          {scored.length > 0 && scored.length < 100 && (
            <p className="mt-2 text-[11px] text-ink-400">With fewer than about 100 scored guesses, differences from chance are expected noise.</p>
          )}
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-700 px-4 py-3 text-xs text-ink-400">
        <span>
          {WHEEL_LABEL[wheelType]} · ball {settings.physics.ballDirection}, wheel opposite · {settings.simulations.toLocaleString()} simulations
        </span>
        <Link href="/settings" className="text-accent hover:underline">Change settings →</Link>
      </div>

      <p className="pb-6 text-center text-[11px] leading-relaxed text-ink-400">
        Past roulette results do not determine future results. On a fair wheel every pocket has the same chance (1/{N}) on every
        spin, and this page will say so when your history shows no real pattern. Probabilities shown are model estimates compared
        against that uniform baseline, not verified predictions. SpinSight has no betting features.
      </p>
    </div>
  );
}
