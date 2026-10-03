"use client";
import { useState } from "react";
import type { LockRule, PredictionState, WheelType } from "@/types/roulette";
import { pocketColour, pocketLabel, pocketOrder } from "@/engine/wheel/layout";

const pct = (p: number, d = 1) => `${(p * 100).toFixed(d)}%`;

function Chip({ pocket }: { pocket: number }) {
  const c = pocketColour(pocket);
  const bg = c === "green" ? "bg-[#14783c]" : c === "red" ? "bg-[#a81a20]" : "bg-black";
  return (
    <span className={`num inline-flex h-6 min-w-6 items-center justify-center rounded px-1 text-xs font-semibold text-white ${bg}`}>
      {pocketLabel(pocket)}
    </span>
  );
}

function TopBars({ probs, type, count = 8 }: { probs: number[]; type: WheelType; count?: number }) {
  const order = pocketOrder(type);
  const n = order.length;
  const base = 1 / n;
  const ranked = probs.map((p, i) => ({ p, pocket: order[i]! })).sort((a, b) => b.p - a.p).slice(0, count);
  const max = Math.max(ranked[0]?.p ?? base, base * 1.5);
  return (
    <div className="space-y-1">
      {ranked.map(({ p, pocket }) => (
        <div key={pocket} className="flex items-center gap-2">
          <Chip pocket={pocket} />
          <div className="relative h-3 flex-1 rounded bg-ink-800">
            <div className="h-3 rounded bg-accent/80" style={{ width: `${(p / max) * 100}%` }} />
            <div className="absolute inset-y-[-3px] w-px bg-warn" style={{ left: `${(base / max) * 100}%` }} title="uniform baseline" />
          </div>
          <span className="num w-12 text-right text-xs">{pct(p)}</span>
        </div>
      ))}
      <div className="flex items-center gap-2 text-[10px] text-ink-400">
        <span className="inline-block h-2 w-px bg-warn" /> uniform baseline {pct(base)}
      </div>
    </div>
  );
}

const STATUS_STYLE: Record<PredictionState["status"], string> = {
  waiting: "bg-ink-700 text-ink-300",
  live: "bg-warn/20 text-warn",
  locked: "bg-accent/20 text-accent",
  resolved: "bg-ink-700 text-ink-100",
};

export function PredictionPanel({
  prediction,
  wheelType,
  onLockRule,
  onResetProfile,
}: {
  prediction: PredictionState | null;
  wheelType: WheelType;
  onLockRule: (r: LockRule) => void;
  onResetProfile: () => void;
}) {
  const [rule, setRule] = useState("lead-2000");
  const p = prediction;
  const n = pocketOrder(wheelType).length;
  const order = pocketOrder(wheelType);
  const top = p?.probs ? p.probs.indexOf(Math.max(...p.probs)) : -1;
  const s = p?.session;
  const prof = p?.profile;
  const priorHeavy = (prof?.scatterPriorWeight ?? 1) > 0.5;

  return (
    <section className="panel space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div className="panel-title">Prediction · statistical estimate</div>
        <span className={`rounded px-2 py-0.5 text-[11px] font-medium uppercase ${STATUS_STYLE[p?.status ?? "waiting"]}`}>
          {p?.status ?? "waiting"}
        </span>
      </div>

      {p?.probs && top >= 0 ? (
        <>
          <div className="flex items-end justify-between">
            <div>
              <div className="text-[11px] text-ink-400">Most likely pocket</div>
              <div className="flex items-center gap-2">
                <span className="scale-125"><Chip pocket={order[top]!} /></span>
                <span className="num text-sm">{pct(p.probs[top]!)} </span>
                <span className="text-[11px] text-ink-400">vs {pct(1 / n)} uniform</span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-ink-400">Drop in</div>
              <div className="num text-sm">
                {p.timeToDropMs !== null ? `${(p.timeToDropMs / 1000).toFixed(2)} s` : "–"}
                {p.sdDropMs ? <span className="text-ink-400"> ± {(p.sdDropMs / 1000).toFixed(2)}</span> : null}
              </div>
            </div>
          </div>
          <TopBars probs={p.probs} type={wheelType} />
          {p.dropProbs && (
            <div className="text-[11px] text-ink-400">
              Projected drop sector (physics only):{" "}
              {p.dropProbs
                .map((v, i) => ({ v, pocket: order[i]! }))
                .sort((a, b) => b.v - a.v)
                .slice(0, 3)
                .map((x) => `${pocketLabel(x.pocket)} ${pct(x.v, 0)}`)
                .join(" · ")}
            </div>
          )}
          <dl className="num grid grid-cols-2 gap-y-0.5 text-[11px]">
            <dt className="text-ink-400">Models</dt>
            <dd>{p.models.map((m) => `${m.id === "kinematic" ? "A" : "B"} ${(m.weight * 100).toFixed(0)}%`).join(" · ")}</dd>
            <dt className="text-ink-400">Model disagreement</dt>
            <dd>{p.disagreement !== null ? `${p.disagreement.toFixed(2)} bits` : "–"}</dd>
            <dt className="text-ink-400">Entropy</dt>
            <dd>{p.entropyBits !== null ? `${p.entropyBits.toFixed(2)} / ${Math.log2(n).toFixed(2)} bits` : "–"}</dd>
            <dt className="text-ink-400">Generated / locked</dt>
            <dd>{p.generatedAt !== null ? `${(p.generatedAt / 1000).toFixed(2)} s` : "–"} / {p.lockedAt !== null ? `${(p.lockedAt / 1000).toFixed(2)} s` : "–"}</dd>
            <dt className="text-ink-400">Frames analysed</dt>
            <dd>{p.framesAnalysed}</dd>
            <dt className="text-ink-400">Model version</dt>
            <dd>{p.modelVersion}</dd>
          </dl>
          {p.note && <p className="text-[11px] text-warn">{p.note}</p>}
        </>
      ) : (
        <p className="text-xs text-ink-400">{p?.note ?? "Starts once the ball is circling the track and the rotor is tracked."}</p>
      )}

      {p?.outcome && (
        <div className="rounded-lg border border-ink-600 p-2 text-xs">
          <div className="flex items-center gap-2">
            Landed <Chip pocket={p.outcome.actualPocket} />
            <span className={p.outcome.within1 ? "text-accent" : "text-ink-300"}>
              {p.outcome.hit ? "exact hit" : `${Math.abs(p.outcome.errorPockets)} pocket(s) from top prediction`}
            </span>
          </div>
          <div className="num mt-1 text-ink-400">
            log loss {p.outcome.logLoss.toFixed(2)} vs uniform {p.outcome.baselineLogLoss.toFixed(2)} (lower is better)
          </div>
        </div>
      )}

      {s && s.n > 0 && (
        <div className="text-xs">
          <div className="panel-title mb-1">This session (walk-forward, {s.n} spins)</div>
          <table className="num w-full text-[11px]">
            <thead className="text-ink-400">
              <tr><th className="text-left font-normal">metric</th><th className="text-right font-normal">model</th><th className="text-right font-normal">uniform</th></tr>
            </thead>
            <tbody>
              <tr><td>exact</td><td className="text-right">{s.hits}</td><td className="text-right">{(s.n / n).toFixed(1)}</td></tr>
              <tr><td>±1 pocket</td><td className="text-right">{s.within1}</td><td className="text-right">{((3 * s.n) / n).toFixed(1)}</td></tr>
              <tr><td>±3 pockets</td><td className="text-right">{s.within3}</td><td className="text-right">{((7 * s.n) / n).toFixed(1)}</td></tr>
              <tr><td>log loss</td><td className="text-right">{s.meanLogLoss.toFixed(3)}</td><td className="text-right">{s.baselineLogLoss.toFixed(3)}</td></tr>
              <tr><td>Brier</td><td className="text-right">{s.meanBrier.toFixed(4)}</td><td className="text-right">{s.baselineBrier.toFixed(4)}</td></tr>
            </tbody>
          </table>
          {s.n < 30 && <p className="mt-1 text-[10px] text-ink-400">Fewer than 30 spins: differences from uniform are not statistically meaningful yet.</p>}
        </div>
      )}

      <div className="space-y-2 border-t border-ink-700 pt-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="text-ink-400">Lock point</span>
          <select
            className="input w-auto py-1 text-xs"
            value={rule}
            onChange={(e) => {
              setRule(e.target.value);
              const v = e.target.value;
              onLockRule(v === "drop" ? { kind: "drop" } : { kind: "lead-time", leadMs: Number(v.split("-")[1]) });
            }}
          >
            <option value="lead-1000">1 s before drop</option>
            <option value="lead-2000">2 s before drop</option>
            <option value="lead-3000">3 s before drop</option>
            <option value="drop">At observed drop</option>
          </select>
        </div>
        <div className="text-ink-400">
          Wheel profile: <span className="num text-ink-100">{prof?.spins ?? 0}</span> spins · ω<sub>c</sub>{" "}
          <span className="num text-ink-100">{prof ? prof.omegaCritical.toFixed(2) : "–"}</span> rad/s ({prof?.omegaCriticalSource === "learned" ? "learned" : "geometry default"}) ·
          scatter prior {prof ? pct(prof.scatterPriorWeight, 0) : "–"}
        </div>
        {priorHeavy && (
          <p className="text-[11px] text-warn">
            Landing probabilities stay close to uniform until the wheel profile has learned from about 10 completed spins on this wheel.
          </p>
        )}
        <button className="btn-ghost w-full py-1 text-xs" onClick={onResetProfile}>Reset learned profile</button>
        <p className="text-[10px] leading-snug text-ink-400">
          Probabilities come from a physics projection plus scatter learned from earlier spins on this wheel. They are not
          guarantees. Real and synthetic spins are learned separately.
        </p>
      </div>
    </section>
  );
}
