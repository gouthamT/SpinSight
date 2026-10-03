/**
 * Per-frame motion estimation, run in the tracking worker after vision:
 *   FrameMeasurement → raw kinematics (unchanged, kept for comparison)
 *                    → Kalman-filtered ball & rotor [θ, ω, α]
 *                    → spin-phase state machine
 *                    → throttled physical fits (ball deceleration a, b; rotor ω0, α)
 * Everything here is an ESTIMATE from measurements, not a prediction.
 */
import type {
  BallDecelerationFit,
  FilteredAngle,
  FrameMeasurement,
  MotionState,
  RotorMotionFit,
  WheelCalibration,
} from "@/types/roulette";
import { AngleKalman, BALL_KALMAN, ROTOR_KALMAN } from "./kalmanFilter";
import { RawKinematics } from "./angularVelocity";
import { SpinPhaseMachine } from "./spinPhase";
import { fitDeceleration, fitRotor, type AngleSample } from "./accelerationEstimator";
import { pocketAtAngle } from "@/engine/wheel/layout";

/** Ball process noise multiplier per ball phase (bounces are violent). */
const BALL_Q_SCALE = { track: 1, cone: 25, "pocket-ring": 200, lost: 1 } as const;

const MAX_FIT_SAMPLES = 360;

function decimate(xs: AngleSample[], max: number): AngleSample[] {
  if (xs.length <= max) return xs;
  const step = xs.length / max;
  const out: AngleSample[] = [];
  for (let i = 0; i < max; i++) out.push(xs[Math.floor(i * step)]!);
  out[out.length - 1] = xs[xs.length - 1]!;
  return out;
}

export class MotionEstimator {
  private raw: RawKinematics;
  private ballKf = new AngleKalman(BALL_KALMAN);
  private rotorKf = new AngleKalman(ROTOR_KALMAN);
  private phase: SpinPhaseMachine;
  private ballSamples: AngleSample[] = [];
  private rotorSamples: AngleSample[] = [];
  private ballFit: BallDecelerationFit | null = null;
  private rotorFit: RotorMotionFit | null = null;
  private lastBallFitT = -Infinity;
  private lastRotorFitT = -Infinity;
  private ballEpoch = -1;
  private rotorEpoch = -1;

  constructor(
    private readonly calibration: WheelCalibration,
    private readonly fitIntervalMs = 250,
  ) {
    this.raw = new RawKinematics(calibration);
    this.phase = new SpinPhaseMachine(calibration);
  }

  reset(): void {
    this.raw.reset();
    this.ballKf.reset();
    this.rotorKf.reset();
    this.phase.reset();
    this.ballSamples = [];
    this.rotorSamples = [];
    this.ballFit = null;
    this.rotorFit = null;
    this.lastBallFitT = -Infinity;
    this.lastRotorFitT = -Infinity;
  }

  private static view(kf: AngleKalman, rejected: boolean): FilteredAngle | null {
    if (kf.lastTime === null) return null;
    const x = kf.state;
    const P = kf.covariance;
    return {
      theta: x[0],
      omega: x[1],
      alpha: x[2],
      sdTheta: Math.sqrt(P[0]),
      sdOmega: Math.sqrt(P[4]),
      sdAlpha: Math.sqrt(P[8]),
      status: kf.status,
      rejected,
      rejectedTotal: kf.rejectedTotal,
    };
  }

  push(m: FrameMeasurement): MotionState {
    const ts = m.t / 1000;
    const raw = this.raw.push(m);

    // Rotor filter.
    let rotorRejected = false;
    if (m.rotor && m.rotor.confidence > 0.1) {
      const st = this.rotorKf.update(ts, m.rotor.zeroAngle, Math.max(m.rotor.confidence, 0.2));
      rotorRejected = st?.rejected ?? false;
      if (this.rotorKf.epoch !== this.rotorEpoch) {
        this.rotorEpoch = this.rotorKf.epoch;
        this.rotorSamples = []; // unwrapped angle restarted
      }
      if (st && st.zUnwrapped !== null) {
        this.rotorSamples.push({ t: ts, theta: st.zUnwrapped });
        while (this.rotorSamples.length && ts - this.rotorSamples[0]!.t > 6) this.rotorSamples.shift();
      }
    } else {
      this.rotorKf.update(ts, null);
    }

    // Ball filter.
    let ballRejected = false;
    let ballZ: number | null = null;
    if (m.ball) {
      const qs = BALL_Q_SCALE[m.ball.phase];
      const st = this.ballKf.update(ts, m.ball.theta, Math.max(m.ball.confidence, 0.2), qs);
      ballRejected = st?.rejected ?? false;
      ballZ = st?.zUnwrapped ?? null;
      if (this.ballKf.epoch !== this.ballEpoch) {
        this.ballEpoch = this.ballKf.epoch;
        this.ballSamples = []; // unwrapped angle restarted
      }
    } else {
      this.ballKf.update(ts, null);
    }
    const ball = MotionEstimator.view(this.ballKf, ballRejected);
    const rotor = MotionEstimator.view(this.rotorKf, rotorRejected);

    const pocket =
      m.ball && m.rotor
        ? pocketAtAngle(this.calibration.wheelType, m.ball.theta, m.rotor.zeroAngle, this.calibration.pocketSequenceSign)
        : null;
    const spin = this.phase.update(m, ball?.omega ?? null, pocket);

    if (this.phase.newSpin) {
      // Seed the fit buffer from the launch-hold period so nothing is lost.
      this.ballSamples = this.ballSamples.filter((s) => s.t * 1000 >= (spin.events.launchT ?? m.t));
      this.ballFit = null;
      this.lastBallFitT = -Infinity;
    }

    // Collect measured (accepted, unwrapped) ball angles while circling the track.
    if (ballZ !== null && m.ball?.phase === "track" && (spin.phase === "track" || spin.phase === "idle" || spin.phase === "settled")) {
      this.ballSamples.push({ t: ts, theta: ballZ });
      if (spin.phase !== "track") {
        // Before launch is confirmed keep only a short pre-roll.
        while (this.ballSamples.length && ts - this.ballSamples[0]!.t > 1) this.ballSamples.shift();
      }
    }

    // Throttled fits.
    if (spin.phase === "track" && m.t - this.lastBallFitT >= this.fitIntervalMs) {
      this.lastBallFitT = m.t;
      const f = fitDeceleration(decimate(this.ballSamples, MAX_FIT_SAMPLES));
      if (f) {
        this.ballFit = {
          t0: f.t0 * 1000, omega0: f.omega0, a: f.a, b: f.b, seA: f.seA, seB: f.seB, corrAB: f.corrAB,
          rmsResidual: f.rmsResidual, n: f.n, spanMs: f.span * 1000, valid: f.valid,
        };
      }
    }
    if (m.t - this.lastRotorFitT >= this.fitIntervalMs * 2) {
      this.lastRotorFitT = m.t;
      const f = fitRotor(decimate(this.rotorSamples, MAX_FIT_SAMPLES));
      this.rotorFit = f
        ? { t0: f.t0 * 1000, omega0: f.omega0, alpha: f.alpha, seOmega: f.seOmega, seAlpha: f.seAlpha, n: f.n }
        : null;
    }

    return { t: m.t, raw, ball, rotor, spin, ballFit: this.ballFit, rotorFit: this.rotorFit };
  }
}
