import { circularSmooth, median, robustSigma, type PolarGrid } from "./polarSampler";
import { TWO_PI } from "@/engine/geometry/angles";

export interface BallCandidate {
  /** Wrapped θ in [0, 2π). */
  theta: number;
  r: number;
  snr: number;
  /** Peak positive contrast in luma levels (0–255). */
  contrast: number;
  bin: number;
}

/**
 * Find the strongest compact positive blob in a θ×r "foreground" grid.
 * Used both for the stationary track (foreground = frame − background) and the
 * rotor (foreground = frame − rotated rotor template).
 */
export function findBlob(
  grid: PolarGrid,
  foreground: Float32Array,
  ballAngularWidthBins: number,
): BallCandidate | null {
  const { bins, radialBins } = grid;
  const prof = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    let best = 0;
    for (let j = 0; j < radialBins; j++) {
      const v = foreground[i * radialBins + j]!;
      if (v > best) best = v;
    }
    prof[i] = best;
  }
  const w = Math.max(1, ballAngularWidthBins | 1);
  const sm = circularSmooth(prof, w);
  let peak = 0;
  for (let i = 1; i < bins; i++) if (sm[i]! > sm[peak]!) peak = i;
  const med = median(sm);
  const sigma = Math.max(robustSigma(sm, med), 0.75);
  const snr = (sm[peak]! - med) / sigma;

  // Weighted centroid in a window around the peak, over all radial bins.
  const half = Math.max(2, w);
  let sw = 0,
    sθ = 0,
    sr = 0;
  for (let k = -half; k <= half; k++) {
    const i = (((peak + k) % bins) + bins) % bins;
    for (let j = 0; j < radialBins; j++) {
      const v = foreground[i * radialBins + j]!;
      if (v <= 0) continue;
      const wv = v * v;
      sw += wv;
      sθ += wv * k;
      sr += wv * grid.binCentreR(j);
    }
  }
  if (sw === 0) return null;
  const binF = peak + sθ / sw;
  let theta = ((binF + 0.5) * TWO_PI) / bins;
  theta = ((theta % TWO_PI) + TWO_PI) % TWO_PI;
  return { theta, r: sr / sw, snr, contrast: prof[peak]!, bin: peak };
}

/**
 * Ball tracker for the STATIONARY part of the bowl (outer track + deflector
 * cone). Maintains an exponential running background per polar cell; cells
 * near the detected ball are frozen so the ball is not absorbed.
 */
export class StationaryBallTracker {
  private bg: Float32Array | null = null;
  private readonly fg: Float32Array;
  readonly luma: Float32Array;

  constructor(
    readonly grid: PolarGrid,
    private readonly alpha = 0.08,
    readonly ballAngularWidthBins = 5,
  ) {
    this.fg = new Float32Array(grid.cells);
    this.luma = new Float32Array(grid.cells);
  }

  resetBackground(): void {
    this.bg = null;
  }

  /** Call after `grid.sample(frame, {luma: this.luma})`. */
  detect(): BallCandidate | null {
    const { luma, fg } = this;
    if (!this.bg) {
      this.bg = Float32Array.from(luma, (v) => (Number.isNaN(v) ? 0 : v));
      return null;
    }
    const bg = this.bg;
    for (let c = 0; c < luma.length; c++) {
      const v = luma[c]!;
      fg[c] = Number.isNaN(v) ? 0 : v - bg[c]!;
    }
    return findBlob(this.grid, fg, this.ballAngularWidthBins);
  }

  /** Update background, excluding a window around the ball (if any). */
  updateBackground(ballBin: number | null): void {
    if (!this.bg) return;
    const { bins, radialBins } = this.grid;
    const excl = this.ballAngularWidthBins * 3;
    const a = this.alpha;
    for (let i = 0; i < bins; i++) {
      if (ballBin !== null) {
        const d = Math.min(Math.abs(i - ballBin), bins - Math.abs(i - ballBin));
        if (d <= excl) continue;
      }
      for (let j = 0; j < radialBins; j++) {
        const c = i * radialBins + j;
        const v = this.luma[c]!;
        if (!Number.isNaN(v)) this.bg[c] = this.bg[c]! + a * (v - this.bg[c]!);
      }
    }
  }

  get foreground(): Float32Array {
    return this.fg;
  }
}
