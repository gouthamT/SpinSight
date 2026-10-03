import type { Annulus, EllipseRectification } from "@/types/roulette";
import { TWO_PI } from "@/engine/geometry/angles";
import { wheelToImage } from "@/engine/geometry/ellipse";

/** Minimal RGBA frame (compatible with ImageData). */
export interface RGBAFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Precomputed lookup from a polar grid (θ bins × r bins over an annulus) to
 * image pixels. Built once per calibration; sampling is then O(cells) with no
 * trigonometry per frame. Each cell averages `supersample²` pixels to reduce
 * aliasing on the fine pocket pattern.
 */
export class PolarGrid {
  readonly cells: number;
  /** Pixel indices (y*width+x) per cell per subsample, −1 when outside the frame. */
  private readonly lut: Int32Array;
  private readonly sub: number;

  constructor(
    readonly rect: EllipseRectification,
    readonly annulus: Annulus,
    readonly bins: number,
    readonly radialBins: number,
    readonly width: number,
    readonly height: number,
    supersample = 2,
  ) {
    this.cells = bins * radialBins;
    this.sub = supersample * supersample;
    this.lut = new Int32Array(this.cells * this.sub);
    const dθ = TWO_PI / bins;
    const dr = (annulus.outer - annulus.inner) / radialBins;
    let k = 0;
    for (let i = 0; i < bins; i++) {
      for (let j = 0; j < radialBins; j++) {
        for (let si = 0; si < supersample; si++) {
          for (let sj = 0; sj < supersample; sj++) {
            const θ = (i + (si + 0.5) / supersample) * dθ;
            const r = annulus.inner + (j + (sj + 0.5) / supersample) * dr;
            const p = wheelToImage(rect, r, θ);
            const x = Math.round(p.x);
            const y = Math.round(p.y);
            this.lut[k++] = x >= 0 && y >= 0 && x < width && y < height ? y * width + x : -1;
          }
        }
      }
    }
  }

  binCentreTheta(i: number): number {
    return ((i + 0.5) * TWO_PI) / this.bins;
  }

  binCentreR(j: number): number {
    const dr = (this.annulus.outer - this.annulus.inner) / this.radialBins;
    return this.annulus.inner + (j + 0.5) * dr;
  }

  /** Fraction of the annulus that lies inside the frame (calibration sanity check). */
  coverage(): number {
    let inside = 0;
    for (let k = 0; k < this.lut.length; k++) if (this.lut[k]! >= 0) inside++;
    return inside / this.lut.length;
  }

  /**
   * Sample the frame. Outputs (length = cells): luma (Rec.601), redness
   * (R − (G+B)/2), greenness (G − max(R,B)). Missing pixels yield NaN.
   */
  sample(
    frame: RGBAFrame,
    out: { luma: Float32Array; redness?: Float32Array; greenness?: Float32Array },
  ): void {
    if (frame.width !== this.width || frame.height !== this.height) {
      throw new Error(
        `Frame ${frame.width}×${frame.height} does not match grid ${this.width}×${this.height}`,
      );
    }
    const d = frame.data;
    const sub = this.sub;
    const { luma, redness, greenness } = out;
    for (let c = 0; c < this.cells; c++) {
      let sr = 0,
        sg = 0,
        sb = 0,
        n = 0;
      const base = c * sub;
      for (let s = 0; s < sub; s++) {
        const idx = this.lut[base + s]!;
        if (idx < 0) continue;
        const o = idx * 4;
        sr += d[o]!;
        sg += d[o + 1]!;
        sb += d[o + 2]!;
        n++;
      }
      if (n === 0) {
        luma[c] = NaN;
        if (redness) redness[c] = NaN;
        if (greenness) greenness[c] = NaN;
        continue;
      }
      const r = sr / n,
        g = sg / n,
        b = sb / n;
      luma[c] = 0.299 * r + 0.587 * g + 0.114 * b;
      if (redness) redness[c] = r - (g + b) / 2;
      if (greenness) greenness[c] = g - Math.max(r, b);
    }
  }
}

/** Average a θ×r grid over r → θ profile (NaN-aware). */
export function radialMean(grid: ArrayLike<number>, bins: number, radialBins: number): Float32Array {
  const out = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    let s = 0,
      n = 0;
    for (let j = 0; j < radialBins; j++) {
      const v = grid[i * radialBins + j]!;
      if (!Number.isNaN(v)) {
        s += v;
        n++;
      }
    }
    out[i] = n ? s / n : 0;
  }
  return out;
}

/** Circular moving-average smoothing with odd window. */
export function circularSmooth(x: Float32Array, window: number): Float32Array {
  const n = x.length;
  const h = Math.floor(window / 2);
  const out = new Float32Array(n);
  let s = 0;
  for (let k = -h; k <= h; k++) s += x[((k % n) + n) % n]!;
  for (let i = 0; i < n; i++) {
    out[i] = s / (2 * h + 1);
    s += x[(i + h + 1) % n]! - x[(((i - h) % n) + n) % n]!;
  }
  return out;
}

export function median(values: ArrayLike<number>): number {
  const a = Array.from(values).filter((v) => !Number.isNaN(v)).sort((p, q) => p - q);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

/** Robust σ via median absolute deviation. */
export function robustSigma(values: ArrayLike<number>, med = median(values)): number {
  const dev = Array.from(values, (v) => Math.abs(v - med));
  return 1.4826 * median(dev);
}

/** Parabolic sub-bin refinement of a peak at index i in a circular array. */
export function parabolicOffset(y: ArrayLike<number>, i: number): number {
  const n = y.length;
  const a = y[(i - 1 + n) % n]!;
  const b = y[i]!;
  const c = y[(i + 1) % n]!;
  const den = a - 2 * b + c;
  if (Math.abs(den) < 1e-12) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
}
