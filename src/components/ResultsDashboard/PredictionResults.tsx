"use client";
import { useState } from "react";
import type { HistoryPrediction } from "@/types/history";
import { pocketColour, pocketLabel, pocketOrder, WHEEL_LABEL } from "@/engine/wheel/layout";

const pct = (p: number, d = 2) => `${(p * 100).toFixed(d)}%`;

export function PocketTile({ pocket, size = "md" }: { pocket: number; size?: "md" | "lg" }) {
  const c = pocketColour(pocket);
  const bg = c === "green" ? "bg-[#14783c]" : c === "red" ? "bg-[#b0202a]" : "bg-[#111316] ring-1 ring-ink-600";
  const s = size === "lg" ? "h-11 min-w-11 text-lg" : "h-8 min-w-8 text-sm";
  return (
    <span className={`num inline-flex items-center justify-center rounded-lg px-1.5 font-semibold text-white ${bg} ${s}`}>
      {pocketLabel(pocket)}
    </span>
  );
}

type RGB = [number, number, number];
const GREEN_DARK: RGB = [6, 95, 70];
const GREEN_LIGHT: RGB = [187, 247, 208];
const RED_LIGHT: RGB = [254, 202, 202];
const RED_DARK: RGB = [127, 29, 29];
const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as RGB;

/**
 * Colour for a probability relative to the uniform baseline:
 * above baseline → light → dark green, below → light → dark red.
 * Intensity is relative to the largest deviation in this result.
 */
export function heatColour(p: number, base: number, maxDev: number): { bg: string; fg: string } {
  const t = maxDev > 0 ? Math.max(-1, Math.min(1, (p - base) / maxDev)) : 0;
  const c = t >= 0 ? mix(GREEN_LIGHT, GREEN_DARK, t) : mix(RED_LIGHT, RED_DARK, -t);
  const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  return { bg: `rgb(${c[0]},${c[1]},${c[2]})`, fg: lum > 150 ? "#0b0f14" : "#ffffff" };
}

function HeatGrid({ p }: { p: HistoryPrediction }) {
  const maxDev = Math.max(...p.ranked.map((r) => Math.abs(r.probability - p.baseline)));
  const noise = Math.max(...p.ranked.map((r) => r.stdError));
  const withinNoise = maxDev < 2 * noise;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-10">
        {p.ranked.map((r) => {
          const c = heatColour(r.probability, p.baseline, maxDev);
          return (
            <div
              key={r.pocket}
              className="flex flex-col items-center justify-center rounded-lg py-2"
              style={{ background: c.bg, color: c.fg }}
              title={`#${r.rank} · ${pocketLabel(r.pocket)}: ${pct(r.probability)} (baseline ${pct(p.baseline)})`}
            >
              <span className="num text-lg font-bold leading-none">{pocketLabel(r.pocket)}</span>
              <span className="num mt-1 text-[10px] opacity-80">{pct(r.probability, 1)}</span>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-ink-400">
        <span>more likely</span>
        <span
          className="h-2 flex-1 rounded"
          style={{ background: "linear-gradient(90deg, rgb(6,95,70), rgb(187,247,208) 49.9%, rgb(254,202,202) 50.1%, rgb(127,29,29))" }}
        />
        <span>less likely</span>
      </div>
      <p className={`text-[11px] ${withinNoise ? "text-warn" : "text-ink-400"}`}>
        Shades are relative: the highest estimate is {pct(p.ranked[0]!.probability)} and the lowest{" "}
        {pct(p.ranked[p.ranked.length - 1]!.probability)}, against a uniform {pct(p.baseline)}.{" "}
        {withinNoise
          ? `These differences are within the estimation noise (±${pct(noise)}), so treat every number as equally likely.`
          : "Differences exceed the estimation noise, but check the verdict above before trusting them."}
      </p>
    </div>
  );
}

const VERDICT_STYLE: Record<HistoryPrediction["verdict"], string> = {
  "insufficient-data": "border-ink-600 bg-ink-800 text-ink-300",
  "no-evidence": "border-ink-600 bg-ink-800 text-ink-200",
  weak: "border-warn/40 bg-warn/10 text-warn",
  moderate: "border-warn/50 bg-warn/15 text-warn",
  strong: "border-accent/50 bg-accent/10 text-accent",
};

export function copyText(p: HistoryPrediction): string {
  const lines = [
    `SpinSight: next-number estimate (experimental model, not a verified prediction)`,
    `${WHEEL_LABEL[p.wheelType]} · history ${p.historyLength} results · ${p.simulations.toLocaleString()} simulations · seed ${p.seed}`,
    `Uniform baseline: ${pct(p.baseline)} per pocket. Verdict: ${p.verdictText}`,
    ...p.top10.map((r) => `${r.rank}. ${pocketLabel(r.pocket)}  ${pct(r.probability)} (±${pct(r.stdError)})`),
    `Top-10 total: ${pct(p.top10Mass, 1)} (uniform: ${pct(p.baseline * p.top10.length, 1)})`,
  ];
  return lines.join("\n");
}

export function PredictionResults({
  p,
  onRunAgain,
  running,
}: {
  p: HistoryPrediction;
  onRunAgain: () => void;
  running: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const order = pocketOrder(p.wheelType);
  // Bars run from 0 to at least 2× baseline so small deviations are not visually exaggerated.
  const maxP = Math.max(...p.probs, p.baseline * 2);
  const n = order.length;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText(p));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="panel space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Next 10 candidates</h2>
          <p className="text-xs text-ink-400">
            Experimental model output · {new Date(p.createdAt).toLocaleString()} · from {p.historyLength} results
            {p.lastResult !== null ? <> · last result <span className="num text-ink-200">{pocketLabel(p.lastResult)}</span></> : null}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={onRunAgain} disabled={running}>{running ? "Running…" : "Run again"}</button>
          <button className="btn-ghost" onClick={() => void copy()}>{copied ? "Copied ✓" : "Copy results"}</button>
        </div>
      </div>

      <div className={`rounded-lg border p-3 text-sm ${VERDICT_STYLE[p.verdict]}`}>
        <div className="font-medium">
          {p.verdict === "insufficient-data" ? "Not enough history" : p.verdict === "no-evidence" ? "No evidence of a pattern" : `${p.verdict[0]!.toUpperCase()}${p.verdict.slice(1)} evidence of structure`}
        </div>
        <p className="mt-0.5 text-xs opacity-90">{p.verdictText}</p>
      </div>

      <HeatGrid p={p} />

      <h3 className="pt-2 text-sm font-semibold text-ink-200">Top 10 in detail</h3>
      <ol className="grid gap-2 sm:grid-cols-2">
        {p.top10.map((r) => (
          <li key={r.pocket} className="flex items-center gap-3 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
            <span className="num w-6 text-right text-sm text-ink-400">{r.rank}</span>
            <PocketTile pocket={r.pocket} size="lg" />
            <div className="min-w-0 flex-1">
              <div className="relative h-2.5 rounded bg-ink-700">
                <div className="h-2.5 rounded bg-accent" style={{ width: `${(r.probability / maxP) * 100}%` }} />
                <div className="absolute -inset-y-1 w-0.5 bg-warn" style={{ left: `${(p.baseline / maxP) * 100}%` }} title="uniform baseline" />
              </div>
              <div className="num mt-1 flex justify-between text-xs">
                <span>{pct(r.probability)}</span>
                <span className="text-ink-400">±{pct(r.stdError)}</span>
              </div>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-ink-400">
        <span><span className="mr-1 inline-block h-2.5 w-0.5 bg-warn align-middle" /> uniform baseline {pct(p.baseline)} per pocket</span>
        <span>Top-10 total {pct(p.top10Mass, 1)} vs {pct(p.baseline * p.top10.length, 1)} for any 10 pockets by chance</span>
      </div>

      <div>
        <button className="text-sm text-accent hover:underline" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Hide" : "Show"} full probability distribution ({n} pockets)
        </button>
        {showAll && (
          <div className="mt-3 overflow-x-auto">
            <div className="flex min-w-[640px] items-end gap-[3px]" style={{ height: 160 }}>
              {order.map((pocket, i) => {
                const v = p.probs[i]!;
                return (
                  <div key={pocket} className="flex flex-1 flex-col items-center justify-end gap-1" title={`${pocketLabel(pocket)}: ${pct(v)}`}>
                    <div className="relative w-full flex-1">
                      <div className="absolute bottom-0 w-full rounded-t bg-accent/80" style={{ height: `${(v / maxP) * 100}%` }} />
                      <div className="absolute w-full border-t border-dashed border-warn" style={{ bottom: `${(p.baseline / maxP) * 100}%` }} />
                    </div>
                    <span className={`num text-[9px] ${pocketColour(pocket) === "red" ? "text-[#ff6b72]" : pocketColour(pocket) === "green" ? "text-accent" : "text-ink-300"}`}>
                      {pocketLabel(pocket)}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] text-ink-400">Pockets in wheel order. Dashed line: uniform baseline.</p>
          </div>
        )}
      </div>

      <details className="rounded-lg border border-ink-700 p-3 text-xs">
        <summary className="cursor-pointer text-sm text-ink-200">Model configuration &amp; evidence</summary>
        <div className="mt-3 space-y-3">
          <div className="num grid grid-cols-2 gap-y-1 sm:grid-cols-4">
            <span className="text-ink-400">Wheel</span><span>{WHEEL_LABEL[p.wheelType]}</span>
            <span className="text-ink-400">Simulations</span><span>{p.simulations.toLocaleString()}</span>
            <span className="text-ink-400">Seed</span><span>{p.seed}</span>
            <span className="text-ink-400">Compute time</span><span>{p.elapsedMs.toFixed(0)} ms</span>
            <span className="text-ink-400">χ² uniformity</span>
            <span>{p.chiSquare ? `χ²(${p.chiSquare.df}) = ${p.chiSquare.statistic.toFixed(1)}, p = ${p.chiSquare.pValue.toPrecision(2)}` : `needs ≥ ${n} results`}</span>
            <span className="text-ink-400">Evidence vs uniform</span><span>2·ln BF = {p.evidence2LnBF.toFixed(2)}</span>
          </div>
          <table className="num w-full text-left">
            <thead className="text-ink-400">
              <tr>
                <th className="py-1 font-normal">Model</th>
                <th className="py-1 text-right font-normal">Weight</th>
                <th className="py-1 text-right font-normal">Walk-forward log loss</th>
                <th className="py-1 text-right font-normal">Top-10 hit rate</th>
              </tr>
            </thead>
            <tbody>
              {p.models.map((m) => (
                <tr key={m.id} className="border-t border-ink-700">
                  <td className="py-1 font-sans">{m.label}</td>
                  <td className="py-1 text-right">{(m.weight * 100).toFixed(1)}%</td>
                  <td className="py-1 text-right">{m.logLoss === null ? "–" : m.logLoss.toFixed(3)}</td>
                  <td className="py-1 text-right">{m.top10Rate === null ? "–" : pct(m.top10Rate, 1)}</td>
                </tr>
              ))}
              <tr className="border-t border-ink-700 text-ink-400">
                <td className="py-1 font-sans">Chance (reference)</td>
                <td />
                <td className="py-1 text-right">{Math.log(n).toFixed(3)}</td>
                <td className="py-1 text-right">{pct(Math.min(10, n) / n, 1)}</td>
              </tr>
            </tbody>
          </table>
          <p className="text-ink-400">
            Weights come from how well each model would have predicted each of your past results using only the results
            before it (walk-forward). Lower log loss than chance on many spins is the only sign of real predictive value.
            The physics model releases the ball from the previous result&apos;s pocket and simulates launch speeds, the
            deceleration law, the drop, deflector strikes and fret bounces from the assumptions in Simulation settings.
          </p>
        </div>
      </details>
    </section>
  );
}
