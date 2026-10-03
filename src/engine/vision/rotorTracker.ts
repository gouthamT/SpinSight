import type { RotorObservation, RotorReference, WheelCalibration } from "@/types/roulette";
import { TWO_PI, wrapAngle } from "@/engine/geometry/angles";
import { PolarGrid, radialMean, parabolicOffset, type RGBAFrame } from "./polarSampler";
import { pocketPitch } from "@/engine/wheel/layout";

const CHANNEL_WEIGHTS = { luma: 1, redness: 1, greenness: 1.5 } as const;

function normalise(x: Float32Array): Float32Array {
  const n = x.length;
  let m = 0;
  for (let i = 0; i < n; i++) m += x[i]!;
  m /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (x[i]! - m) ** 2;
  const sd = Math.sqrt(v / n) || 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (x[i]! - m) / sd;
  return out;
}

export interface PocketRingSample {
  luma: Float32Array;
  redness: Float32Array;
  greenness: Float32Array;
}

export function allocPocketSample(grid: PolarGrid): PocketRingSample {
  return {
    luma: new Float32Array(grid.cells),
    redness: new Float32Array(grid.cells),
    greenness: new Float32Array(grid.cells),
  };
}

/** Capture the rotor template from a single (still) frame. */
export function buildRotorReference(grid: PolarGrid, frame: RGBAFrame): RotorReference {
  const s = allocPocketSample(grid);
  grid.sample(frame, s);
  const clean = (a: Float32Array) => Array.from(a, (v) => (Number.isNaN(v) ? 0 : v));
  return {
    bins: grid.bins,
    radialBins: grid.radialBins,
    luma: clean(s.luma),
    redness: clean(s.redness),
    greenness: clean(s.greenness),
  };
}

export interface RotorTrackResult extends RotorObservation {
  /** Fractional bin shift of current frame relative to the reference. */
  shiftBins: number;
  /** True when the temporal (predicted) search window was used. */
  locked: boolean;
}

/**
 * Rotor angle by circular cross-correlation of the pocket ring's colour
 * profile against the calibration template. The green zero pocket breaks the
 * red/black 2-pocket periodicity; `peakRatio` reports how decisive that was.
 */
export class RotorTracker {
  private readonly ref: { luma: Float32Array; redness: Float32Array; greenness: Float32Array };
  private readonly refLuma2D: Float32Array;
  private readonly n: number;
  private readonly exclusionBins: number;

  constructor(
    private readonly calibration: WheelCalibration,
    readonly grid: PolarGrid,
    /** Global peak must beat the predicted-window peak by this factor to override it. */
    private readonly relockRatio = 1.1,
  ) {
    const R = calibration.rotorReference;
    if (R.bins !== grid.bins || R.radialBins !== grid.radialBins) {
      throw new Error("Rotor reference resolution does not match the polar grid.");
    }
    this.n = R.bins;
    this.ref = {
      luma: normalise(radialMean(R.luma, R.bins, R.radialBins)),
      redness: normalise(radialMean(R.redness, R.bins, R.radialBins)),
      greenness: normalise(radialMean(R.greenness, R.bins, R.radialBins)),
    };
    this.refLuma2D = Float32Array.from(R.luma);
    this.exclusionBins = Math.max(2, Math.round((0.6 * pocketPitch(calibration.wheelType) * this.n) / TWO_PI));
  }

  /**
   * @param predictedShift Expected shift (bins) from the previous frame and
   *   rotor speed. When given, the search is confined to ±0.9 pocket around it,
   *   which removes the 2-pocket red/black aliasing once the rotor is locked.
   *   A weak local peak triggers a global re-acquisition.
   */
  track(sample: PocketRingSample, predictedShift: number | null = null): RotorTrackResult {
    const { bins, radialBins } = this.grid;
    const cur = {
      luma: normalise(radialMean(sample.luma, bins, radialBins)),
      redness: normalise(radialMean(sample.redness, bins, radialBins)),
      greenness: normalise(radialMean(sample.greenness, bins, radialBins)),
    };
    const n = this.n;
    const wSum = CHANNEL_WEIGHTS.luma + CHANNEL_WEIGHTS.redness + CHANNEL_WEIGHTS.greenness;
    const score = new Float32Array(n);
    for (let s = 0; s < n; s++) {
      let acc = 0;
      for (const ch of ["luma", "redness", "greenness"] as const) {
        const r = this.ref[ch];
        const c = cur[ch];
        let dot = 0;
        for (let i = 0; i < n; i++) {
          const j = i + s;
          dot += r[i]! * c[j < n ? j : j - n]!;
        }
        acc += CHANNEL_WEIGHTS[ch] * dot;
      }
      score[s] = acc / (n * wSum);
    }
    let best = 0;
    for (let s = 1; s < n; s++) if (score[s]! > score[best]!) best = s;
    let locked = false;
    if (predictedShift !== null) {
      const win = Math.floor(this.exclusionBins * 1.5);
      const c = Math.round(predictedShift);
      let lb = ((c % n) + n) % n;
      for (let k = -win; k <= win; k++) {
        const s = (((c + k) % n) + n) % n;
        if (score[s]! > score[lb]!) lb = s;
      }
      // Keep the temporally consistent peak unless the global peak is
      // clearly better (then the prediction itself was wrong → re-acquire).
      if (score[lb]! > 0 && score[best]! <= score[lb]! * this.relockRatio) {
        best = lb;
        locked = true;
      }
    }
    let second = -Infinity;
    for (let s = 0; s < n; s++) {
      const d = Math.min(Math.abs(s - best), n - Math.abs(s - best));
      if (d > this.exclusionBins && score[s]! > second) second = score[s]!;
    }
    const corr = score[best]!;
    const peakRatio = second > 0 ? corr / second : 10;
    const shiftBins = best + parabolicOffset(score, best);
    const zeroAngle = wrapAngle(this.calibration.zeroAngleAtReference + (shiftBins * TWO_PI) / n);
    // When locked, temporal continuity resolves aliasing, so ambiguity matters less.
    const ambiguity = locked ? 1 : clamp01((Math.min(peakRatio, 2) - 1) / 0.25);
    const confidence = clamp01((corr - 0.3) / 0.5) * ambiguity;
    return { zeroAngle, correlation: corr, peakRatio, confidence, shiftBins, locked };
  }

  /**
   * Residual of the current pocket-ring luma against the reference rotated by
   * the measured shift: a white ball sitting on the rotor shows up as a
   * positive residual.
   */
  residual(sample: PocketRingSample, shiftBins: number, out: Float32Array): void {
    const { bins, radialBins } = this.grid;
    const s = Math.round(shiftBins);
    // Global gain/offset compensation for exposure changes.
    let mc = 0,
      mr = 0,
      cnt = 0;
    for (let k = 0; k < sample.luma.length; k++) {
      const v = sample.luma[k]!;
      if (!Number.isNaN(v)) {
        mc += v;
        cnt++;
      }
      mr += this.refLuma2D[k]!;
    }
    mc /= cnt || 1;
    mr /= sample.luma.length;
    for (let i = 0; i < bins; i++) {
      const iref = (((i - s) % bins) + bins) % bins;
      for (let j = 0; j < radialBins; j++) {
        const v = sample.luma[i * radialBins + j]!;
        out[i * radialBins + j] = Number.isNaN(v)
          ? 0
          : v - mc - (this.refLuma2D[iref * radialBins + j]! - mr);
      }
    }
  }
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
