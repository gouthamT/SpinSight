/**
 * Constant-acceleration Kalman filter for an angular track.
 *
 *   state x = [θ, ω, α]ᵀ (θ unwrapped, rad; ω rad/s; α rad/s²), time in seconds
 *   x_k = F x_{k−1} + w,  F = [[1, Δt, Δt²/2], [0, 1, Δt], [0, 0, 1]]
 *   w ~ N(0, Q), Q = white-jerk model with spectral density q
 *   z_k = θ_k (wrapped) + v,  v ~ N(0, R)
 *
 * The innovation is computed on the circle (angleDiff), so the state stays
 * unwrapped while measurements are wrapped. Innovations failing a χ²(1) gate
 * are rejected (outliers, e.g. a glare spot detected instead of the ball);
 * several consecutive rejections trigger re-initialisation.
 */
import { angleDiff } from "@/engine/geometry/angles";

export type Vec3 = [number, number, number];
/** Row-major 3×3. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

// ---- 3×3 helpers -----------------------------------------------------------
export const m3 = {
  mul(a: Mat3, b: Mat3): Mat3 {
    const r = new Array(9).fill(0) as Mat3;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += a[i * 3 + k]! * b[k * 3 + j]!;
        r[i * 3 + j] = s;
      }
    return r;
  },
  t(a: Mat3): Mat3 {
    return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
  },
  add(a: Mat3, b: Mat3): Mat3 {
    return a.map((v, i) => v + b[i]!) as Mat3;
  },
  sub(a: Mat3, b: Mat3): Mat3 {
    return a.map((v, i) => v - b[i]!) as Mat3;
  },
  mulVec(a: Mat3, v: Vec3): Vec3 {
    return [
      a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
      a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
      a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
    ];
  },
  inv(a: Mat3): Mat3 | null {
    const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a;
    const c0 = a4 * a8 - a5 * a7;
    const c1 = a5 * a6 - a3 * a8;
    const c2 = a3 * a7 - a4 * a6;
    const det = a0 * c0 + a1 * c1 + a2 * c2;
    if (Math.abs(det) < 1e-300) return null;
    const d = 1 / det;
    return [
      c0 * d, (a2 * a7 - a1 * a8) * d, (a1 * a5 - a2 * a4) * d,
      c1 * d, (a0 * a8 - a2 * a6) * d, (a2 * a3 - a0 * a5) * d,
      c2 * d, (a1 * a6 - a0 * a7) * d, (a0 * a4 - a1 * a3) * d,
    ];
  },
  sym(a: Mat3): Mat3 {
    const r = [...a] as Mat3;
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++) {
        const v = (a[i * 3 + j]! + a[j * 3 + i]!) / 2;
        r[i * 3 + j] = v;
        r[j * 3 + i] = v;
      }
    return r;
  },
};

export function transition(dt: number): Mat3 {
  return [1, dt, (dt * dt) / 2, 0, 1, dt, 0, 0, 1];
}

/** Discrete white-jerk process noise. */
export function processNoise(dt: number, q: number): Mat3 {
  const d2 = dt * dt, d3 = d2 * dt, d4 = d3 * dt, d5 = d4 * dt;
  return [
    (q * d5) / 20, (q * d4) / 8, (q * d3) / 6,
    (q * d4) / 8, (q * d3) / 3, (q * d2) / 2,
    (q * d3) / 6, (q * d2) / 2, q * dt,
  ];
}

export interface KalmanOptions {
  /** Jerk spectral density (rad²/s⁵). */
  q: number;
  /** Measurement σ for confidence = 1 (rad). */
  sigmaTheta: number;
  /** Initial σ of ω and α. */
  initSigmaOmega: number;
  initSigmaAlpha: number;
  /** χ²(1) gate; 6.63 ≈ 99 %. */
  gate: number;
  /** Consecutive rejections before re-initialising. */
  maxRejects: number;
  /** Gap after which the track is considered lost and re-initialised (s). */
  maxGap: number;
}

export const BALL_KALMAN: KalmanOptions = {
  q: 4,
  sigmaTheta: 0.006,
  initSigmaOmega: 25,
  initSigmaAlpha: 8,
  gate: 6.63,
  maxRejects: 4,
  maxGap: 0.4,
};

export const ROTOR_KALMAN: KalmanOptions = {
  q: 0.02,
  sigmaTheta: 0.004,
  initSigmaOmega: 8,
  initSigmaAlpha: 1,
  gate: 6.63,
  maxRejects: 4,
  maxGap: 1.0,
};

export type TrackStatus = "init" | "tracking" | "coasting" | "lost";

export interface KalmanStep {
  t: number; // seconds
  xPred: Vec3;
  PPred: Mat3;
  x: Vec3;
  P: Mat3;
  F: Mat3;
  /** Unwrapped measurement (null when no/rejected measurement). */
  zUnwrapped: number | null;
  innovation: number | null;
  nis: number | null;
  rejected: boolean;
}

export class AngleKalman {
  private x: Vec3 = [0, 0, 0];
  private P: Mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  private tLast: number | null = null;
  private rejects = 0;
  private _status: TrackStatus = "init";
  private readonly steps: KalmanStep[] = [];
  readonly opts: KalmanOptions;
  rejectedTotal = 0;
  /** Incremented on every (re-)initialisation: unwrapped θ is discontinuous across these. */
  epoch = 0;

  constructor(
    opts: Partial<KalmanOptions> = {},
    private readonly keepHistory = false,
  ) {
    this.opts = { ...BALL_KALMAN, ...opts };
  }

  get status(): TrackStatus {
    return this._status;
  }
  get state(): Vec3 {
    return [...this.x] as Vec3;
  }
  get covariance(): Mat3 {
    return [...this.P] as Mat3;
  }
  get history(): readonly KalmanStep[] {
    return this.steps;
  }
  get lastTime(): number | null {
    return this.tLast;
  }

  reset(): void {
    this.tLast = null;
    this.rejects = 0;
    this._status = "init";
    this.steps.length = 0;
  }

  private initialise(t: number, z: number, R: number, keepVelocity: boolean): void {
    const o = this.opts;
    this.epoch++;
    const ω = keepVelocity ? this.x[1] : 0;
    const α = keepVelocity ? this.x[2] : 0;
    this.x = [z, ω, α];
    this.P = [R, 0, 0, 0, o.initSigmaOmega ** 2, 0, 0, 0, o.initSigmaAlpha ** 2];
    this.tLast = t;
    this.rejects = 0;
    this._status = "tracking";
    if (this.keepHistory) {
      this.steps.push({
        t, xPred: [...this.x] as Vec3, PPred: [...this.P] as Mat3, x: [...this.x] as Vec3,
        P: [...this.P] as Mat3, F: transition(0), zUnwrapped: z, innovation: 0, nis: 0, rejected: false,
      });
    }
  }

  /** State predicted to time t (s) without modifying the filter. */
  peek(t: number): { x: Vec3; P: Mat3 } | null {
    if (this.tLast === null) return null;
    const dt = t - this.tLast;
    const F = transition(dt);
    return {
      x: m3.mulVec(F, this.x),
      P: m3.add(m3.mul(m3.mul(F, this.P), m3.t(F)), processNoise(Math.max(dt, 0), this.opts.q)),
    };
  }

  /**
   * Advance to time t (s) and optionally fuse a wrapped angle measurement.
   * @param confidence 0..1 scales the measurement variance (R = σ²/conf²).
   * @param qScale multiplies q (e.g. larger while the ball bounces).
   */
  update(t: number, zWrapped: number | null, confidence = 1, qScale = 1): KalmanStep | null {
    const o = this.opts;
    const R = (o.sigmaTheta / Math.max(confidence, 0.05)) ** 2;
    if (this.tLast === null) {
      if (zWrapped === null) return null;
      this.initialise(t, zWrapped, R, false);
      return this.steps[this.steps.length - 1] ?? null;
    }
    const dt = t - this.tLast;
    if (dt <= 0) return null;
    if (dt > o.maxGap) {
      this._status = "lost";
      if (zWrapped === null) return null;
      this.initialise(t, zWrapped, R, true);
      return this.steps[this.steps.length - 1] ?? null;
    }
    const F = transition(dt);
    const xPred = m3.mulVec(F, this.x);
    const PPred = m3.sym(m3.add(m3.mul(m3.mul(F, this.P), m3.t(F)), processNoise(dt, o.q * qScale)));

    let x = xPred;
    let P = PPred;
    let zU: number | null = null;
    let innov: number | null = null;
    let nis: number | null = null;
    let rejected = false;

    if (zWrapped !== null) {
      const y = angleDiff(zWrapped, xPred[0]);
      const S = PPred[0] + R;
      nis = (y * y) / S;
      if (nis > o.gate) {
        rejected = true;
        this.rejects++;
        this.rejectedTotal++;
        if (this.rejects >= o.maxRejects) {
          this.initialise(t, zWrapped, R, false);
          return this.steps[this.steps.length - 1] ?? null;
        }
      } else {
        this.rejects = 0;
        const K: Vec3 = [PPred[0] / S, PPred[3] / S, PPred[6] / S];
        x = [xPred[0] + K[0] * y, xPred[1] + K[1] * y, xPred[2] + K[2] * y];
        // Joseph-free form is fine for this well-conditioned 3-state problem; symmetrise.
        const KH: Mat3 = [K[0], 0, 0, K[1], 0, 0, K[2], 0, 0];
        const I_KH = m3.sub([1, 0, 0, 0, 1, 0, 0, 0, 1], KH);
        P = m3.sym(m3.mul(I_KH, PPred));
        zU = xPred[0] + y;
        innov = y;
      }
    }
    this.x = x;
    this.P = P;
    this.tLast = t;
    this._status = zWrapped === null || rejected ? "coasting" : "tracking";
    const step: KalmanStep = { t, xPred, PPred, x, P, F, zUnwrapped: zU, innovation: innov, nis, rejected };
    if (this.keepHistory) this.steps.push(step);
    return step;
  }
}

/**
 * Rauch–Tung–Striebel smoother over a recorded filter history (offline use:
 * spin history, backtest training). Returns smoothed states and covariances.
 */
export function rtsSmooth(steps: readonly KalmanStep[]): { t: number; x: Vec3; P: Mat3 }[] {
  const n = steps.length;
  if (!n) return [];
  const out: { t: number; x: Vec3; P: Mat3 }[] = new Array(n);
  const last = steps[n - 1]!;
  out[n - 1] = { t: last.t, x: last.x, P: last.P };
  for (let k = n - 2; k >= 0; k--) {
    const cur = steps[k]!;
    const next = steps[k + 1]!;
    const PPredInv = m3.inv(next.PPred);
    if (!PPredInv || next.F[1] === 0) {
      // Re-initialisation boundary: no smoothing across it.
      out[k] = { t: cur.t, x: cur.x, P: cur.P };
      continue;
    }
    const C = m3.mul(m3.mul(cur.P, m3.t(next.F)), PPredInv);
    const sm = out[k + 1]!;
    const dx: Vec3 = [sm.x[0] - next.xPred[0], sm.x[1] - next.xPred[1], sm.x[2] - next.xPred[2]];
    const cdx = m3.mulVec(C, dx);
    const x: Vec3 = [cur.x[0] + cdx[0], cur.x[1] + cdx[1], cur.x[2] + cdx[2]];
    const P = m3.sym(m3.add(cur.P, m3.mul(m3.mul(C, m3.sub(sm.P, next.PPred)), m3.t(C))));
    out[k] = { t: cur.t, x, P };
  }
  return out;
}

/** Normalised estimation error squared for consistency tests. */
export function nees(x: Vec3, P: Mat3, truth: Vec3, dims: (0 | 1 | 2)[] = [0, 1, 2]): number {
  if (dims.length === 3) {
    const Pi = m3.inv(P);
    if (!Pi) return NaN;
    const e: Vec3 = [x[0] - truth[0], x[1] - truth[1], x[2] - truth[2]];
    const Pe = m3.mulVec(Pi, e);
    return e[0] * Pe[0] + e[1] * Pe[1] + e[2] * Pe[2];
  }
  // Sub-block (1 or 2 dims).
  if (dims.length === 1) {
    const i = dims[0]!;
    return (x[i] - truth[i]) ** 2 / P[i * 3 + i]!;
  }
  const [i, j] = dims as [0 | 1 | 2, 0 | 1 | 2];
  const a = P[i * 3 + i]!, b = P[i * 3 + j]!, d = P[j * 3 + j]!;
  const det = a * d - b * b;
  const ei = x[i] - truth[i], ej = x[j] - truth[j];
  return (d * ei * ei - 2 * b * ei * ej + a * ej * ej) / det;
}
