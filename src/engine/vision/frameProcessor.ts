import type {
  BallObservation,
  BallPhase,
  EllipseRectification,
  RotorObservation,
  WheelCalibration,
} from "@/types/roulette";
import { wheelToImage } from "@/engine/geometry/ellipse";
import { wrapAngle } from "@/engine/geometry/angles";
import type { PolarGrid, RGBAFrame } from "./polarSampler";
import { StationaryBallTracker, findBlob, type BallCandidate } from "./ballTracker";
import { RotorTracker, allocPocketSample, clamp01, type PocketRingSample } from "./rotorTracker";
import { buildPocketGrid, buildStationaryGrid, scaleCalibrationRect } from "./wheelDetector";

export interface FrameResult {
  ball: BallObservation | null;
  rotor: RotorObservation | null;
}

export interface WheelTrackerOptions {
  /** Minimum SNR for a ball detection. */
  minSnr: number;
  /** Minimum luma contrast (0–255) for a ball detection. */
  minContrast: number;
}

const DEFAULTS: WheelTrackerOptions = { minSnr: 6, minContrast: 18 };

/**
 * Per-frame measurement pipeline (pure: no DOM, runs in a worker or Node).
 *   1. Sample the stationary bowl and the rotating pocket ring into polar grids.
 *   2. Rotor angle ← cross-correlation with the calibration template.
 *   3. Ball on stationary zone ← background subtraction.
 *   4. Ball on rotor ← residual against the rotated template.
 * Output coordinates are in the calibration's native pixel space.
 */
export class WheelTracker {
  readonly rect: EllipseRectification;
  private readonly stationaryGrid: PolarGrid;
  private readonly pocketGrid: PolarGrid;
  private readonly stationary: StationaryBallTracker;
  private readonly rotor: RotorTracker;
  private readonly pocketSample: PocketRingSample;
  private readonly pocketResidual: Float32Array;
  private readonly scaleX: number;
  private readonly scaleY: number;
  private readonly opts: WheelTrackerOptions;
  /** Rotor lock state for temporal search. */
  private lastShift: number | null = null;
  private lastT: number | null = null;
  private shiftRate = 0; // bins per ms
  /** Consecutive mutually consistent rotor-rate observations; lock only once ≥ 2. */
  private rateSamples = 0;

  constructor(
    readonly calibration: WheelCalibration,
    readonly width: number,
    readonly height: number,
    opts: Partial<WheelTrackerOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.rect = scaleCalibrationRect(calibration, width, height);
    this.scaleX = calibration.frameWidth / width;
    this.scaleY = calibration.frameHeight / height;
    this.stationaryGrid = buildStationaryGrid(this.rect, calibration.zones, width, height);
    this.pocketGrid = buildPocketGrid(this.rect, calibration.zones, width, height);
    // Ball ≈ 2.5% of rim radius ⇒ angular width in bins at r ≈ 0.9.
    const ballBins = Math.max(3, Math.round((0.05 / 0.9 / (2 * Math.PI)) * this.stationaryGrid.bins));
    this.stationary = new StationaryBallTracker(this.stationaryGrid, 0.08, ballBins);
    this.rotor = new RotorTracker(calibration, this.pocketGrid);
    this.pocketSample = allocPocketSample(this.pocketGrid);
    this.pocketResidual = new Float32Array(this.pocketGrid.cells);
  }

  resetBackground(): void {
    this.stationary.resetBackground();
    this.lastShift = null;
    this.lastT = null;
    this.shiftRate = 0;
    this.rateSamples = 0;
  }

  /** @param tMs monotonic timestamp of the frame (used for rotor lock prediction). */
  process(frame: RGBAFrame, tMs: number): FrameResult {
    this.stationaryGrid.sample(frame, { luma: this.stationary.luma });
    this.pocketGrid.sample(frame, this.pocketSample);

    const n = this.pocketGrid.bins;
    const dt = this.lastT !== null ? tMs - this.lastT : 0;
    const fresh = this.lastShift !== null && dt > 0 && dt < 500;
    // Only search locally once the rotor rate is established: at low frame
    // rates the rotor can move more than one pocket per frame, and an unknown
    // rate would let the tracker lock onto the 2-pocket red/black alias.
    const predicted = fresh && this.rateSamples >= 2 ? this.lastShift! + this.shiftRate * dt : null;
    const rotorRes = this.rotor.track(this.pocketSample, predicted);
    if (rotorRes.confidence > 0.2 || rotorRes.locked) {
      if (fresh) {
        let d = rotorRes.shiftBins - this.lastShift!;
        d -= Math.round(d / n) * n;
        const rate = d / dt;
        const tol = Math.max(0.3 * Math.abs(this.shiftRate), 0.004);
        if (rotorRes.locked || (this.rateSamples > 0 && Math.abs(rate - this.shiftRate) <= tol)) {
          this.shiftRate = 0.7 * this.shiftRate + 0.3 * rate;
          this.rateSamples++;
        } else {
          this.shiftRate = rate;
          this.rateSamples = 1;
        }
      } else {
        this.rateSamples = 0;
      }
      this.lastShift = rotorRes.shiftBins;
      this.lastT = tMs;
    }
    const rotor: RotorObservation = {
      zeroAngle: rotorRes.zeroAngle,
      correlation: rotorRes.correlation,
      peakRatio: rotorRes.peakRatio,
      confidence: rotorRes.confidence,
    };

    const statCand = this.stationary.detect();
    this.rotor.residual(this.pocketSample, rotorRes.shiftBins, this.pocketResidual);
    const pocketBallBins = Math.max(3, Math.round((0.05 / 0.65 / (2 * Math.PI)) * this.pocketGrid.bins));
    const rotorCand =
      rotorRes.confidence > 0.2 ? findBlob(this.pocketGrid, this.pocketResidual, pocketBallBins) : null;

    const ok = (c: BallCandidate | null) =>
      c !== null && c.snr >= this.opts.minSnr && c.contrast >= this.opts.minContrast;

    let chosen: { c: BallCandidate; zone: "stationary" | "rotor" } | null = null;
    if (ok(statCand) && (!ok(rotorCand) || statCand!.snr >= rotorCand!.snr)) {
      chosen = { c: statCand!, zone: "stationary" };
    } else if (ok(rotorCand)) {
      chosen = { c: rotorCand!, zone: "rotor" };
    }

    this.stationary.updateBackground(chosen?.zone === "stationary" ? chosen.c.bin : null);

    if (!chosen) return { ball: null, rotor };
    const { c, zone } = chosen;
    const phase: BallPhase =
      zone === "rotor"
        ? "pocket-ring"
        : c.r >= this.calibration.zones.ballTrack.inner
          ? "track"
          : "cone";
    const p = wheelToImage(this.rect, c.r, c.theta);
    const ball: BallObservation = {
      phase,
      x: p.x * this.scaleX,
      y: p.y * this.scaleY,
      r: c.r,
      theta: wrapAngle(c.theta),
      snr: c.snr,
      confidence: clamp01((c.snr - this.opts.minSnr) / 12) * clamp01(c.contrast / 60),
    };
    return { ball, rotor };
  }
}
