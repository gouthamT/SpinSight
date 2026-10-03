import type { DerivedState, FrameMeasurement, TrackingStats, WheelCalibration } from "@/types/roulette";
import { AngleUnwrapper } from "@/engine/geometry/angles";
import { pocketAtAngle } from "@/engine/wheel/layout";

/**
 * Least-squares slope of (t, y) pairs: a RAW angular-velocity estimate
 * (no model). Phase 3 replaces this with a Kalman filter; the raw series is
 * kept regardless so filtered and unfiltered values can be compared.
 */
export function regressionSlope(ts: readonly number[], ys: readonly number[]): number | null {
  const n = ts.length;
  if (n < 2) return null;
  let mt = 0,
    my = 0;
  for (let i = 0; i < n; i++) {
    mt += ts[i]!;
    my += ys[i]!;
  }
  mt /= n;
  my /= n;
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    const dt = ts[i]! - mt;
    num += dt * (ys[i]! - my);
    den += dt * dt;
  }
  return den > 0 ? num / den : null;
}

interface Track {
  unwrap: AngleUnwrapper;
  ts: number[];
  ys: number[];
  lastOmega: number;
  lastT: number | null;
}

function newTrack(): Track {
  return { unwrap: new AngleUnwrapper(), ts: [], ys: [], lastOmega: 0, lastT: null };
}

/**
 * Turns per-frame measurements into unwrapped angles and windowed raw ω.
 * Uses the previous ω to predict the angular step before unwrapping, so fast
 * balls at low frame rates (|ω·Δt| up to ~1.5π) do not alias.
 */
export class RawKinematics {
  private ball = newTrack();
  private rotor = newTrack();
  private readonly windowMs: number;
  private readonly maxGapMs: number;

  constructor(
    private readonly calibration: WheelCalibration,
    opts: { windowMs?: number; maxGapMs?: number } = {},
  ) {
    this.windowMs = opts.windowMs ?? 120;
    this.maxGapMs = opts.maxGapMs ?? 250;
  }

  reset(): void {
    this.ball = newTrack();
    this.rotor = newTrack();
  }

  private step(tr: Track, t: number, wrapped: number): { u: number; omega: number | null } {
    const tSec = t / 1000;
    if (tr.lastT !== null && t - tr.lastT > this.maxGapMs) {
      // Tracking lost for too long: restart unwrapping, keep old ω only as a hint.
      tr.unwrap.reset();
      tr.ts = [];
      tr.ys = [];
    }
    const predicted = tr.lastT !== null ? tr.lastOmega * ((t - tr.lastT) / 1000) : 0;
    const u = tr.unwrap.push(wrapped, predicted);
    tr.ts.push(tSec);
    tr.ys.push(u);
    while (tr.ts.length > 2 && (tSec - tr.ts[0]!) * 1000 > this.windowMs) {
      tr.ts.shift();
      tr.ys.shift();
    }
    const omega = regressionSlope(tr.ts, tr.ys);
    if (omega !== null) tr.lastOmega = omega;
    tr.lastT = t;
    return { u, omega };
  }

  push(m: FrameMeasurement): DerivedState {
    const out: DerivedState = {
      t: m.t,
      ballThetaUnwrapped: null,
      rotorThetaUnwrapped: null,
      ballOmegaRaw: null,
      rotorOmegaRaw: null,
      pocketUnderBall: null,
    };
    if (m.rotor && m.rotor.confidence > 0.1) {
      const r = this.step(this.rotor, m.t, m.rotor.zeroAngle);
      out.rotorThetaUnwrapped = r.u;
      out.rotorOmegaRaw = r.omega;
    }
    if (m.ball) {
      const b = this.step(this.ball, m.t, m.ball.theta);
      out.ballThetaUnwrapped = b.u;
      out.ballOmegaRaw = b.omega;
      if (m.rotor) {
        out.pocketUnderBall = pocketAtAngle(
          this.calibration.wheelType,
          m.ball.theta,
          m.rotor.zeroAngle,
          this.calibration.pocketSequenceSign,
        );
      }
    }
    return out;
  }
}

/** Frame-timing statistics over a sliding window. */
export class TimingStats {
  private times: number[] = [];
  private proc: number[] = [];
  private balls: boolean[] = [];
  private processed = 0;
  private dropped = 0;

  constructor(private readonly window = 120) {}

  push(m: FrameMeasurement): void {
    this.processed++;
    this.times.push(m.t);
    this.proc.push(m.processingMs);
    this.balls.push(m.ball !== null);
    if (this.times.length > this.window) {
      this.times.shift();
      this.proc.shift();
      this.balls.shift();
    }
  }

  drop(): void {
    this.dropped++;
  }

  reset(): void {
    this.times = [];
    this.proc = [];
    this.balls = [];
    this.processed = 0;
    this.dropped = 0;
  }

  snapshot(): TrackingStats {
    const n = this.times.length;
    const gaps: number[] = [];
    for (let i = 1; i < n; i++) gaps.push(this.times[i]! - this.times[i - 1]!);
    const meanGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    return {
      framesProcessed: this.processed,
      framesDropped: this.dropped,
      effectiveFps: meanGap > 0 ? 1000 / meanGap : 0,
      meanGapMs: meanGap,
      maxGapMs: gaps.length ? Math.max(...gaps) : 0,
      meanProcessingMs: n ? this.proc.reduce((a, b) => a + b, 0) / n : 0,
      ballDetectionRate: n ? this.balls.filter(Boolean).length / n : 0,
    };
  }
}
