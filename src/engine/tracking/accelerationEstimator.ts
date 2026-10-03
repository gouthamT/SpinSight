/**
 * Fit physical deceleration parameters from MEASURED angles.
 *
 * Ball: Levenberg–Marquardt on the closed-form θ(t) of
 *       dω/dt = −(a + bω²)·sgn ω, parameters [θ0, ω0, ln a, ln b]
 *       (log-space keeps a, b > 0). Using θ directly, rather than
 *       differentiated ω/α, avoids amplifying measurement noise.
 * Rotor: quadratic least squares θ = θ0 + ω0 t + ½ α t².
 */
import { invert, ols, solve } from "@/engine/math/linalg";
import { stopTime, thetaAt } from "@/engine/physics/decelerationModel";

export interface AngleSample {
  /** seconds */
  t: number;
  /** unwrapped measured angle (rad) */
  theta: number;
}

export interface DecelerationFit {
  t0: number; // s, reference time of theta0/omega0
  theta0: number;
  omega0: number;
  a: number;
  b: number;
  seA: number;
  seB: number;
  corrAB: number;
  rmsResidual: number; // rad
  n: number;
  span: number; // s
  /** Enough data and well-conditioned (relative SE of a and b < 50 %). */
  valid: boolean;
}

export interface RotorFit {
  t0: number;
  theta0: number;
  omega0: number;
  alpha: number;
  seOmega: number;
  seAlpha: number;
  rmsResidual: number;
  n: number;
  span: number;
}

export function fitRotor(samples: readonly AngleSample[]): RotorFit | null {
  if (samples.length < 6) return null;
  const t0 = samples[0]!.t;
  const span = samples[samples.length - 1]!.t - t0;
  if (span < 0.3) return null;
  const X = samples.map((s) => [1, s.t - t0, 0.5 * (s.t - t0) ** 2]);
  const y = samples.map((s) => s.theta);
  const r = ols(X, y);
  if (!r) return null;
  return {
    t0,
    theta0: r.beta[0]!,
    omega0: r.beta[1]!,
    alpha: r.beta[2]!,
    seOmega: Math.sqrt(r.cov[1]![1]!),
    seAlpha: Math.sqrt(r.cov[2]![2]!),
    rmsResidual: r.sigma,
    n: samples.length,
    span,
  };
}

function residuals(p: number[], ts: number[], ys: number[], out: number[]): number {
  const [th0, w0, la, lb] = p as [number, number, number, number];
  const prm = { a: Math.exp(la), b: Math.exp(lb) };
  const tStop = stopTime(prm, w0);
  let ss = 0;
  for (let i = 0; i < ts.length; i++) {
    // Model invalid past the stop time: penalise heavily.
    const r = ts[i]! >= tStop ? 1e3 : ys[i]! - thetaAt(prm, th0, w0, ts[i]!);
    out[i] = r;
    ss += r * r;
  }
  return ss;
}

export function fitDeceleration(
  samples: readonly AngleSample[],
  opts: { minSamples?: number; minSpan?: number; maxIter?: number } = {},
): DecelerationFit | null {
  const minSamples = opts.minSamples ?? 12;
  const minSpan = opts.minSpan ?? 0.4;
  const n = samples.length;
  if (n < minSamples) return null;
  const t0 = samples[0]!.t;
  const ts = samples.map((s) => s.t - t0);
  const ys = samples.map((s) => s.theta);
  const span = ts[n - 1]!;
  if (span < minSpan) return null;

  // Initialise from a quadratic fit: ω0 ≈ c1, mean |α| ≈ |2 c2|.
  const q = ols(ts.map((t) => [1, t, t * t]), ys);
  if (!q) return null;
  const w0 = q.beta[1]!;
  if (Math.abs(w0) < 0.5) return null;
  const decel = Math.max(0.05, Math.abs(2 * q.beta[2]!) * Math.sign(-w0 * q.beta[2]!) || 0.05);
  const wMean = Math.abs(w0) - (decel * span) / 2;
  const a0 = Math.min(decel * 0.5, 1);
  const b0 = Math.max(1e-4, (decel - a0) / Math.max(wMean * wMean, 1));
  let p = [q.beta[0]!, w0, Math.log(a0), Math.log(b0)];

  const r = new Array<number>(n).fill(0);
  const rTry = new Array<number>(n).fill(0);
  let ss = residuals(p, ts, ys, r);
  let lambda = 1e-3;
  const maxIter = opts.maxIter ?? 40;
  let JtJ: number[][] = [];
  for (let it = 0; it < maxIter; it++) {
    // Numerical Jacobian of the MODEL (= −∂r/∂p).
    const J: number[][] = Array.from({ length: n }, () => [0, 0, 0, 0]);
    for (let k = 0; k < 4; k++) {
      const h = k < 2 ? 1e-6 * Math.max(1, Math.abs(p[k]!)) : 1e-6;
      const pp = [...p];
      pp[k]! += h;
      residuals(pp, ts, ys, rTry);
      for (let i = 0; i < n; i++) J[i]![k] = (r[i]! - rTry[i]!) / h;
    }
    JtJ = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    const Jtr = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const Ji = J[i]!;
      for (let a = 0; a < 4; a++) {
        Jtr[a]! += Ji[a]! * r[i]!;
        for (let b = 0; b < 4; b++) JtJ[a]![b]! += Ji[a]! * Ji[b]!;
      }
    }
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
      const step = solve(A, Jtr);
      if (!step) break;
      const pNew = p.map((v, i) => v + step[i]!);
      const ssNew = residuals(pNew, ts, ys, rTry);
      if (ssNew < ss) {
        const rel = (ss - ssNew) / Math.max(ss, 1e-18);
        p = pNew;
        ss = ssNew;
        for (let i = 0; i < n; i++) r[i] = rTry[i]!;
        lambda = Math.max(lambda / 3, 1e-9);
        improved = true;
        if (rel < 1e-10) it = maxIter;
        break;
      }
      lambda *= 4;
    }
    if (!improved) break;
  }

  const dof = Math.max(1, n - 4);
  const s2 = ss / dof;
  const cov = invert(JtJ);
  const a = Math.exp(p[2]!);
  const b = Math.exp(p[3]!);
  // Delta method: se(a) = a · se(ln a).
  const seLa = cov ? Math.sqrt(Math.max(0, cov[2]![2]! * s2)) : Infinity;
  const seLb = cov ? Math.sqrt(Math.max(0, cov[3]![3]! * s2)) : Infinity;
  const corrAB = cov ? cov[2]![3]! / Math.sqrt(cov[2]![2]! * cov[3]![3]!) : NaN;
  const seA = a * seLa;
  const seB = b * seLb;
  return {
    t0,
    theta0: p[0]!,
    omega0: p[1]!,
    a,
    b,
    seA,
    seB,
    corrAB,
    rmsResidual: Math.sqrt(ss / n),
    n,
    span,
    valid: Number.isFinite(seA) && seA / a < 0.5 && seB / b < 0.5 && span >= 1,
  };
}
