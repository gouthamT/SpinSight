import { describe, expect, it } from "vitest";
import { SyntheticSpin, simulateMeasurements, stubCalibration, randomSpinParams } from "@/engine/synthetic/measurementSimulator";
import { MotionEstimator } from "@/engine/tracking/motionEstimator";
import { PredictionEngine } from "@/engine/prediction/ensemblePredictor";
import { newProfile, scatterKernel, geometryOmegaCritical, summarise } from "@/engine/prediction/wheelProfile";
import { circularConvolve, jensenShannon, ringDiff, ringHistogram, uniform } from "@/engine/prediction/uncertaintyModel";
import type { PredictionState } from "@/types/roulette";

describe("uncertainty helpers", () => {
  it("ring histogram and convolution preserve probability mass", () => {
    const h = ringHistogram([0.5, 36.7, 12.25], 37);
    expect(h.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    const k = uniform(37).map((_, i) => (i === 0 ? 0.5 : i === 1 ? 0.5 : 0));
    expect(circularConvolve(h, k).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });
  it("convolving with a uniform kernel gives exactly uniform", () => {
    const h = ringHistogram([3.2], 37);
    circularConvolve(h, uniform(37)).forEach((p) => expect(p).toBeCloseTo(1 / 37, 12));
  });
  it("Jensen–Shannon is 0 for identical and 1 bit for disjoint distributions", () => {
    const a = uniform(4), b = [1, 0, 0, 0], c = [0, 0, 1, 0];
    expect(jensenShannon([a, a], [1, 1])).toBeCloseTo(0, 12);
    expect(jensenShannon([b, c], [1, 1])).toBeCloseTo(1, 12);
  });
});

describe("wheel profile", () => {
  it("starts from track geometry and a uniform scatter prior", () => {
    const p = newProfile("x");
    expect(geometryOmegaCritical(p)).toBeGreaterThan(3);
    const s = summarise(p, 37);
    expect(s.omegaCriticalSource).toBe("geometry-default");
    expect(s.scatterPriorWeight).toBe(1);
    scatterKernel(p, 37).kernel.forEach((v) => expect(v).toBeCloseTo(1 / 37, 12));
  });
});

/** Walk-forward run over consecutive simulated spins of one wheel. */
function walkForward(spins: number, lead = 2000) {
  const cal = stubCalibration();
  const est = new MotionEstimator(cal);
  const eng = new PredictionEngine(cal, null, "test:synthetic", { lockRule: { kind: "lead-time", leadMs: lead } });
  const results: { first: PredictionState | null; locked: PredictionState | null; final: PredictionState; dropT: number | null; physErr: number | null }[] = [];
  let t0 = 0;
  for (let i = 0; i < spins; i++) {
    const spin = new SyntheticSpin(randomSpinParams(1000 + i));
    const ms = simulateMeasurements(spin, { t0Ms: t0, seed: i + 1 });
    let first: PredictionState | null = null;
    let locked: PredictionState | null = null;
    let last: PredictionState | null = null;
    let dropT: number | null = null;
    for (const m of ms) {
      const mo = est.push(m);
      const p = eng.push(m, mo);
      if (!first && p.status === "live") first = p;
      if (!locked && p.status === "locked") locked = p;
      if (dropT === null && mo.spin.events.spinId === i + 1 && mo.spin.events.dropT !== null) dropT = mo.spin.events.dropT;
      last = p;
    }
    t0 = ms[ms.length - 1]!.t + 33;
    const obs = eng.currentProfile.observations.at(-1);
    const m = locked?.models.at(-1);
    results.push({ first, locked, final: last!, dropT, physErr: m && obs && locked?.note === null ? ringDiff(m.dropIndexMean, obs.dropIndex, 37) : null });
  }
  return { results, eng };
}

describe("PredictionEngine walk-forward on simulated spins (synthetic wheel)", () => {
  const { results } = walkForward(50);

  it("first spin (no history) predicts exactly the uniform baseline", () => {
    const p = results[0]!.first!;
    expect(p.profile.scatterSource).toBe("uniform-prior");
    p.probs!.forEach((v) => expect(v).toBeCloseTo(1 / 37, 9));
  });

  it("locks BEFORE the observed drop under the lead-time rule (no future frames)", () => {
    const later = results.slice(2);
    const early = later.filter((r) => r.locked && r.dropT !== null && r.locked.lockedAt! < r.dropT && r.locked.note === null);
    expect(early.length / later.length).toBeGreaterThan(0.9);
  });

  it("projects the drop pocket 2 s ahead to within 3 pockets on average (physics only)", () => {
    const errs = results.slice(2).map((r) => r.physErr).filter((e): e is number => e !== null);
    const mean = errs.reduce((a, b) => a + Math.abs(b), 0) / errs.length;
    expect(errs.length).toBeGreaterThan(40);
    expect(mean).toBeLessThan(3);
  });

  it("beats the uniform baseline out-of-sample (spins 21–50, chronological)", () => {
    const ev = results.slice(20).map((r) => r.final.outcome!).filter(Boolean);
    expect(ev.length).toBe(30);
    const ll = ev.reduce((a, o) => a + o.logLoss, 0) / ev.length;
    expect(ll).toBeLessThan(Math.log(37) - 0.03);
    const w3 = ev.filter((o) => o.within3).length;
    expect(w3).toBeGreaterThan((30 * 7) / 37 + 3); // uniform expectation ≈ 5.7
  });

  it("session score matches the per-spin outcomes", () => {
    const s = results.at(-1)!.final.session;
    expect(s.n).toBe(results.filter((r) => r.final.outcome).length);
    expect(s.baselineLogLoss).toBeCloseTo(Math.log(37), 12);
  });

  it("is deterministic", () => {
    const again = walkForward(3).results;
    expect(again[2]!.locked!.probs).toEqual(results[2]!.locked!.probs);
  });
});
