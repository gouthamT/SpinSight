/**
 * Fast measurement simulator: produces FrameMeasurement streams straight from
 * SyntheticSpin ground truth plus Gaussian angle noise, skipping rendering
 * and vision. Used for Phase 4+ tests and backtests over many spins.
 * (Vision accuracy itself is covered by the rendered-frame tests.)
 */
import type { FrameMeasurement, RotationSign, WheelCalibration, WheelType } from "@/types/roulette";
import { mulberry32 } from "@/engine/math/random";
import { wrapAngle } from "@/engine/geometry/angles";
import { DEFAULT_ZONES } from "@/engine/vision/wheelDetector";
import { DEFAULT_SPIN, SyntheticSpin, type SpinParams } from "./syntheticWheel";

/** Calibration stand-in for engine-only tests (no rectification or template needed). */
export function stubCalibration(wheelType: WheelType = "european", sign: RotationSign = DEFAULT_SPIN.sequenceSign): WheelCalibration {
  return {
    id: "stub",
    createdAt: "1970-01-01T00:00:00.000Z",
    wheelType,
    frameWidth: 640,
    frameHeight: 480,
    userCentre: null,
    rimPoints: [],
    zeroPocketPoint: { x: 0, y: 0 },
    rectification: {
      centre: { x: 320, y: 240 }, forward: [1, 0, 0, 1], inverse: [1, 0, 0, 1],
      semiMajorPx: 200, semiMinorPx: 200, tiltRad: 0, fitRmsResidual: 0, projective: null,
    },
    zones: DEFAULT_ZONES,
    pocketSequenceSign: sign,
    zeroAngleAtReference: 0,
    rotorReference: { bins: 0, radialBins: 0, luma: [], redness: [], greenness: [] },
    notes: ["stub calibration for simulation"],
  };
}

/** Plausible spin-to-spin variation for one physical wheel (fixed a, b, ω_c). */
export function randomSpinParams(seed: number, base: SpinParams = DEFAULT_SPIN): SpinParams {
  const r = mulberry32(seed * 2654435761);
  return {
    ...base,
    seed,
    ballOmega0: -(12 + 6 * r()),
    ballTheta0: 2 * Math.PI * r(),
    rotorTheta0: 2 * Math.PI * r(),
    rotorOmega0: 1.6 + 1.2 * r(),
  };
}

export interface SimOptions {
  fps: number;
  sigmaBall: number; // rad
  sigmaRotor: number; // rad
  /** Probability a frame has no ball detection. */
  missRate: number;
  /** Extra time recorded after settling (ms). */
  tailMs: number;
  seed: number;
  /** Clock offset so consecutive spins have increasing timestamps. */
  t0Ms: number;
}

export function simulateMeasurements(spin: SyntheticSpin, o: Partial<SimOptions> = {}): FrameMeasurement[] {
  const opt: SimOptions = { fps: 30, sigmaBall: 0.005, sigmaRotor: 0.003, missRate: 0.02, tailMs: 2500, seed: 1, t0Ms: 0, ...o };
  const rnd = mulberry32(opt.seed);
  const g = () => {
    const u = Math.max(rnd(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  const out: FrameMeasurement[] = [];
  const end = spin.settleTimeMs + opt.tailMs;
  for (let k = 0; (k * 1000) / opt.fps < end; k++) {
    const ms = (k * 1000) / opt.fps;
    const s = spin.state(ms);
    const t = opt.t0Ms + ms;
    const phase = s.ballR >= DEFAULT_ZONES.ballTrack.inner ? "track" : s.ballR >= DEFAULT_ZONES.pocketRing.outer ? "cone" : "pocket-ring";
    const seen = rnd() >= opt.missRate;
    out.push({
      seq: k,
      t,
      timeSource: "synthetic",
      receivedAt: t,
      processingMs: 0,
      ball: seen
        ? { phase, x: 0, y: 0, r: s.ballR, theta: wrapAngle(s.ballTheta + opt.sigmaBall * g()), snr: 40, confidence: 1 }
        : null,
      rotor: { zeroAngle: wrapAngle(s.rotorZero + opt.sigmaRotor * g()), correlation: 0.95, peakRatio: 1.3, confidence: 1 },
    });
  }
  return out;
}

export { SyntheticSpin };
