/**
 * Project WHERE (relative to the rotor) and WHEN the ball leaves the track.
 *
 * Model A (kinematic):     constant-α extrapolation of the Kalman ball state.
 * Model B (deceleration):  dω/dt = −(a + bω²)·sgn ω with the fitted a, b.
 * Both:                    drop when |ω| = ω_c; rotor extrapolated with its
 *                          measured ω and α (stops rather than reverses).
 *
 * Uncertainty is propagated by seeded Monte Carlo over the filter
 * covariances, the fit standard errors (incl. the a–b correlation) and the
 * uncertainty of ω_c. The result is a cloud of drop positions expressed as a
 * continuous pocket-sequence index (0 = zero pocket).
 */
import type { BallDecelerationFit, FilteredAngle, RotationSign, RotorMotionFit, WheelType } from "@/types/roulette";
import { mulberry32 } from "@/engine/math/random";
import { omegaAt, thetaAt, timeToOmega } from "@/engine/physics/decelerationModel";
import { pocketCount } from "@/engine/wheel/layout";
import { correlatedPair, gaussian, wrapIndex } from "./uncertaintyModel";

export interface DropProjectionInput {
  nowMs: number;
  ball: FilteredAngle;
  rotor: FilteredAngle;
  rotorFit: RotorMotionFit | null;
  ballFit: BallDecelerationFit | null;
  omegaCritical: number;
  omegaCriticalSd: number;
  wheelType: WheelType;
  pocketSequenceSign: RotationSign;
  samples: number;
  seed: number;
}

export interface DropProjection {
  id: "kinematic" | "deceleration";
  /** Seconds from now until drop, per valid sample. */
  tDrop: Float64Array;
  /** Continuous sequence index at drop, per valid sample. */
  dropIndex: Float64Array;
  validFraction: number;
}

const MAX_HORIZON_S = 30;

/** Rotor angle after t seconds; it decelerates to rest rather than reversing. */
function rotorAfter(theta: number, omega: number, alpha: number, t: number): number {
  if (omega !== 0 && alpha * omega < 0) {
    const tStop = -omega / alpha;
    if (t > tStop) t = tStop;
  }
  return theta + omega * t + 0.5 * alpha * t * t;
}

function toIndex(rel: number, n: number, sign: RotationSign): number {
  return wrapIndex((sign * rel * n) / (2 * Math.PI), n);
}

interface RotorSample {
  theta: number;
  omega: number;
  alpha: number;
}

function sampleRotor(inp: DropProjectionInput, rnd: () => number): RotorSample {
  const r = inp.rotor;
  const alpha = inp.rotorFit
    ? inp.rotorFit.alpha + inp.rotorFit.seAlpha * gaussian(rnd)
    : r.alpha + r.sdAlpha * gaussian(rnd);
  return {
    theta: r.theta + r.sdTheta * gaussian(rnd),
    omega: r.omega + r.sdOmega * gaussian(rnd),
    alpha,
  };
}

function sampleOmegaC(inp: DropProjectionInput, rnd: () => number): number {
  return Math.max(0.5, inp.omegaCritical + inp.omegaCriticalSd * gaussian(rnd));
}

export function projectKinematic(inp: DropProjectionInput): DropProjection {
  const rnd = mulberry32(inp.seed ^ 0x9e3779b9);
  const n = pocketCount(inp.wheelType);
  const tD: number[] = [];
  const idx: number[] = [];
  const b = inp.ball;
  for (let s = 0; s < inp.samples; s++) {
    const th = b.theta + b.sdTheta * gaussian(rnd);
    const w = b.omega + b.sdOmega * gaussian(rnd);
    const a = b.alpha + b.sdAlpha * gaussian(rnd);
    const wc = sampleOmegaC(inp, rnd);
    const dir = Math.sign(w) || 1;
    const decel = -a * dir; // > 0 when slowing down
    let t: number;
    if (Math.abs(w) <= wc) t = 0;
    else if (decel <= 0.02) continue; // not decelerating: no drop predicted
    else t = (Math.abs(w) - wc) / decel;
    if (t > MAX_HORIZON_S) continue;
    const thDrop = th + w * t + 0.5 * a * t * t;
    const r = sampleRotor(inp, rnd);
    const rel = thDrop - rotorAfter(r.theta, r.omega, r.alpha, t);
    tD.push(t);
    idx.push(toIndex(rel, n, inp.pocketSequenceSign));
  }
  return {
    id: "kinematic",
    tDrop: Float64Array.from(tD),
    dropIndex: Float64Array.from(idx),
    validFraction: tD.length / inp.samples,
  };
}

export function projectDeceleration(inp: DropProjectionInput): DropProjection | null {
  const f = inp.ballFit;
  if (!f) return null;
  const rnd = mulberry32(inp.seed ^ 0x85ebca6b);
  const n = pocketCount(inp.wheelType);
  const tD: number[] = [];
  const idx: number[] = [];
  const b = inp.ball;
  const dtFit = (inp.nowMs - f.t0) / 1000;
  const sLa = Math.min(f.seA / f.a, 1);
  const sLb = Math.min(f.seB / f.b, 1);
  for (let s = 0; s < inp.samples; s++) {
    const [z1, z2] = correlatedPair(rnd, f.corrAB);
    const p = { a: f.a * Math.exp(sLa * z1), b: f.b * Math.exp(sLb * z2) };
    const wNow = omegaAt(p, f.omega0, dtFit);
    if (wNow === 0) continue;
    const wc = sampleOmegaC(inp, rnd);
    const t = timeToOmega(p, wNow, wc);
    if (!Number.isFinite(t) || t > MAX_HORIZON_S) continue;
    const th = b.theta + b.sdTheta * gaussian(rnd);
    const thDrop = thetaAt(p, th, wNow, t);
    const r = sampleRotor(inp, rnd);
    const rel = thDrop - rotorAfter(r.theta, r.omega, r.alpha, t);
    tD.push(t);
    idx.push(toIndex(rel, n, inp.pocketSequenceSign));
  }
  return {
    id: "deceleration",
    tDrop: Float64Array.from(tD),
    dropIndex: Float64Array.from(idx),
    validFraction: tD.length / inp.samples,
  };
}
