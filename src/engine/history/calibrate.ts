/**
 * Calibrate the physics settings from the results history.
 *
 * From a list of results alone the only physical quantity that can be learned
 * is the "release signature": how far round the wheel each result lands from
 * the previous one, d = (index_t − index_{t−1}) mod N. We model it as
 *
 *     P(d) = (1 − q)/N + q · WrappedNormal(d; μ, σ)
 *
 * (a fraction q of spins travel a consistent μ ± σ pockets; the rest are
 * scrambled), with a uniform prior over a grid of (μ, σ, q). The fit is
 * scored WALK-FORWARD: every offset is predicted only from earlier ones, so
 * the evidence against "no pattern" (2·ln Bayes factor) cannot be inflated by
 * fitting and testing on the same spins.
 *
 * When the evidence reaches the "moderate" level (≥ 6) the physics settings are
 * adjusted so the physics simulation reproduces the fitted signature:
 *   • ball launch speed shifts the mean travel to μ,
 *   • every spread (launch/rotor/drop speed SDs, release jitter, deflector and
 *     bounce SDs) is scaled together so the total spread is σ,
 *   • the long-roll chance becomes 1 − q, with long rolls long enough to scramble.
 * Otherwise the base (guide) settings are kept unchanged.
 */
import { thetaAt, timeToOmega } from "@/engine/physics/decelerationModel";
import { pocketOrder } from "@/engine/wheel/layout";
import type { Calibration, HistorySettings, PhysicsSettings } from "@/types/history";
import { releaseKernel } from "./physicsRelease";

export const CALIBRATION_MIN_SPINS = 15;
export const CALIBRATION_EVIDENCE = 6;

const SIGMAS = [1, 1.5, 2, 3, 4, 6, 9] as const;
const QS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] as const;

interface Grid {
  n: number;
  mu: number[];
  sigma: number[];
  q: number[];
  /** logP[g][d] */
  logP: Float64Array[];
  P: Float64Array[];
}
const gridCache = new Map<number, Grid>();

function grid(n: number): Grid {
  const hit = gridCache.get(n);
  if (hit) return hit;
  const g: Grid = { n, mu: [], sigma: [], q: [], logP: [], P: [] };
  for (let mu = 0; mu < n; mu++)
    for (const sigma of SIGMAS) {
      const w = new Float64Array(n);
      let z = 0;
      for (let d = 0; d < n; d++) {
        let s = 0;
        for (let k = -3; k <= 3; k++) s += Math.exp(-0.5 * ((d - mu + k * n) / sigma) ** 2);
        w[d] = s;
        z += s;
      }
      for (const q of QS) {
        const P = new Float64Array(n);
        const L = new Float64Array(n);
        for (let d = 0; d < n; d++) {
          P[d] = (1 - q) / n + (q * w[d]!) / z;
          L[d] = Math.log(P[d]!);
        }
        g.mu.push(mu);
        g.sigma.push(sigma);
        g.q.push(q);
        g.P.push(P);
        g.logP.push(L);
      }
    }
  gridCache.set(n, g);
  return g;
}

export interface SignatureFit {
  offsets: number;
  /** Walk-forward 2·ln Bayes factor of the signature model against uniform. */
  evidence2LnBF: number;
  /** Best (maximum-likelihood) grid point on the whole history. */
  mu: number;
  sigma: number;
  q: number;
  /** Walk-forward predictive P(d) used to score each offset (index = offset number). */
  prequential: number[][];
  /** Posterior-predictive P(d) for the next offset. */
  next: number[];
}

function mixture(gr: Grid, ll: Float64Array): number[] {
  let m = -Infinity;
  for (const v of ll) m = Math.max(m, v);
  const out = new Array<number>(gr.n).fill(0);
  let z = 0;
  for (let i = 0; i < ll.length; i++) {
    const w = Math.exp(ll[i]! - m);
    z += w;
    const P = gr.P[i]!;
    for (let d = 0; d < gr.n; d++) out[d]! += w * P[d]!;
  }
  return out.map((v) => v / z);
}

/** Fit the release signature to a sequence of pocket-sequence indices. */
export function fitSignature(idx: readonly number[], n: number): SignatureFit {
  const gr = grid(n);
  const ll = new Float64Array(gr.mu.length);
  const prequential: number[][] = [];
  let lSig = 0;
  let offsets = 0;
  for (let t = 1; t < idx.length; t++) {
    const d = (((idx[t]! - idx[t - 1]!) % n) + n) % n;
    const pred = mixture(gr, ll);
    prequential.push(pred);
    lSig += Math.log(pred[d]!);
    for (let i = 0; i < ll.length; i++) ll[i]! += gr.logP[i]![d]!;
    offsets++;
  }
  let best = 0;
  for (let i = 1; i < ll.length; i++) if (ll[i]! > ll[best]!) best = i;
  return {
    offsets,
    evidence2LnBF: 2 * (lSig - offsets * Math.log(1 / n)),
    mu: gr.mu[best]!,
    sigma: gr.sigma[best]!,
    q: gr.q[best]!,
    prequential,
    next: mixture(gr, ll),
  };
}

/** Same sign convention as releaseKernel: offset index = round(sign · travel). */
export function relativeSign(settings: HistorySettings): 1 | -1 {
  const ballSign = settings.physics.ballDirection === "clockwise" ? -1 : 1;
  const wheelSign = settings.wheelDirection ?? -ballSign;
  return ballSign * wheelSign === 1 ? 1 : -1;
}

/** Deterministic mean travel (pockets) for a launch speed, as in releaseKernel. */
function meanOffset(p: PhysicsSettings, n: number, wb: number, wc = p.dropOmegaMean): number {
  const law = { a: Math.max(p.frictionA, 1e-4), b: Math.max(p.dragB, 1e-6) };
  const T = timeToOmega(law, wb, wc);
  const ball = thetaAt(law, 0, wb, T);
  const tStop = p.rotorDecel > 0 ? p.rotorOmegaMean / p.rotorDecel : Infinity;
  const tr = Math.min(T, tStop);
  const rotor = p.rotorOmegaMean * tr - 0.5 * p.rotorDecel * tr * tr;
  return ((ball + rotor) * n) / (2 * Math.PI) + p.deflectorHitProb * p.deflectorKickMean + p.bounceMean;
}

const wrapHalf = (x: number, n: number) => ((((x + n / 2) % n) + n) % n) - n / 2;
const round = (x: number, k = 3) => Math.round(x * 10 ** k) / 10 ** k;

/** Physics settings whose release kernel reproduces the fitted signature. */
export function physicsForSignature(
  settings: HistorySettings,
  n: number,
  fit: Pick<SignatureFit, "mu" | "sigma" | "q">,
): PhysicsSettings {
  const base = settings.physics;
  const sign = relativeSign(settings);
  const p: PhysicsSettings = { ...base };
  const wcMin = p.dropOmegaMean + 1;

  // Spread: linearised variance of the offset, then scale every SD together.
  const h = 0.01;
  const slopeB = (meanOffset(p, n, p.ballOmegaMean + h) - meanOffset(p, n, p.ballOmegaMean - h)) / (2 * h);
  const slopeC =
    (meanOffset(p, n, p.ballOmegaMean, p.dropOmegaMean + h) - meanOffset(p, n, p.ballOmegaMean, p.dropOmegaMean - h)) / (2 * h);
  const law = { a: Math.max(p.frictionA, 1e-4), b: Math.max(p.dragB, 1e-6) };
  const T = timeToOmega(law, p.ballOmegaMean, p.dropOmegaMean);
  const slopeR = (T * n) / (2 * Math.PI);
  const hit = p.deflectorHitProb;
  const variance =
    (slopeB * p.ballOmegaSd) ** 2 +
    (slopeC * p.dropOmegaSd) ** 2 +
    (slopeR * p.rotorOmegaSd) ** 2 +
    p.releaseJitterPockets ** 2 +
    hit * p.deflectorKickSd ** 2 +
    hit * (1 - hit) * p.deflectorKickMean ** 2 +
    p.bounceSd ** 2;
  const k = Math.min(1, fit.sigma / Math.sqrt(Math.max(variance, 1e-9)));
  p.ballOmegaSd = round(base.ballOmegaSd * k, 4);
  p.dropOmegaSd = round(base.dropOmegaSd * k, 4);
  p.rotorOmegaSd = round(base.rotorOmegaSd * k, 4);
  p.releaseJitterPockets = round(base.releaseJitterPockets * k);
  p.deflectorKickSd = round(base.deflectorKickSd * k);
  p.bounceSd = round(base.bounceSd * k);

  // Scrambled share: long rolls long enough to land anywhere.
  p.longRollProb = round(1 - fit.q, 2);
  p.longRollMeanPockets = Math.max(base.longRollMeanPockets, 2 * n);

  // Mean: Newton on the launch speed so sign·travel ≡ μ (mod N), nearest solution.
  let wb = Math.max(base.ballOmegaMean, wcMin + 0.5);
  const c0 = meanOffset(p, n, wb);
  const target = c0 + wrapHalf(sign * fit.mu - c0, n);
  for (let i = 0; i < 30; i++) {
    const c = meanOffset(p, n, wb);
    const s = (meanOffset(p, n, wb + h) - meanOffset(p, n, wb - h)) / (2 * h);
    if (!Number.isFinite(s) || Math.abs(s) < 1e-6) break;
    wb = Math.max(wcMin, wb - (c - target) / s);
    if (Math.abs(c - target) < 0.02) break;
  }
  p.ballOmegaMean = round(wb);

  // Correct any residual (bounce truncation, rounding) from the simulated kernel's circular mean.
  const kern = releaseKernel(n, { ...p, longRollProb: 0 }, 20000, 1, null, settings.wheelDirection).kernel; // signature part only
  let cx = 0;
  let sy = 0;
  kern.forEach((v, d) => {
    cx += v * Math.cos((2 * Math.PI * d) / n);
    sy += v * Math.sin((2 * Math.PI * d) / n);
  });
  if (Math.hypot(cx, sy) > 0.05) {
    const simMu = (Math.atan2(sy, cx) * n) / (2 * Math.PI);
    const err = wrapHalf(fit.mu - simMu, n) * sign;
    const s = (meanOffset(p, n, p.ballOmegaMean + h) - meanOffset(p, n, p.ballOmegaMean - h)) / (2 * h);
    if (Number.isFinite(s) && Math.abs(s) > 1e-6) p.ballOmegaMean = round(Math.max(wcMin, p.ballOmegaMean + err / s));
  }
  return p;
}

/** Results used for calibration (most recent); keeps the fit fast on long histories. */
export const CALIBRATION_WINDOW = 1000;

export interface CalibrationRun {
  calibration: Calibration;
  fit: SignatureFit;
  /** Number of offsets in the full history before the calibration window starts. */
  skippedOffsets: number;
}

/** Fit the history and, if the pattern is real enough, return calibrated physics. */
export function calibrateFromHistory(values: readonly number[], settings: HistorySettings): CalibrationRun {
  const order = pocketOrder(settings.wheelType);
  const n = order.length;
  const idxOf = new Map(order.map((p, i) => [p, i]));
  const all = values.map((v) => idxOf.get(v)).filter((i): i is number => i !== undefined);
  const idx = all.slice(-CALIBRATION_WINDOW);
  const fit = fitSignature(idx, n);
  const enough = fit.offsets >= CALIBRATION_MIN_SPINS;
  const applied = enough && fit.evidence2LnBF >= CALIBRATION_EVIDENCE;
  const calibration: Calibration = {
    applied,
    spins: idx.length,
    evidence2LnBF: fit.evidence2LnBF,
    mu: fit.mu,
    sigma: fit.sigma,
    q: fit.q,
    physics: applied ? physicsForSignature(settings, n, fit) : null,
    reason: !enough
      ? `Needs at least ${CALIBRATION_MIN_SPINS + 1} results to calibrate.`
      : applied
        ? `Repeatable travel found: ${fit.mu} pockets ± ${fit.sigma} on about ${Math.round(fit.q * 100)}% of spins.`
        : "No repeatable pattern between consecutive results; guide settings kept.",
  };
  return { calibration, fit, skippedOffsets: Math.max(0, all.length - 1) - fit.offsets };
}
