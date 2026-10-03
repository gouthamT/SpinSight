export const TWO_PI = Math.PI * 2;

/** Wrap to (−π, π]. */
export function wrapAngle(a: number): number {
  let x = a % TWO_PI;
  if (x <= -Math.PI) x += TWO_PI;
  else if (x > Math.PI) x -= TWO_PI;
  return x;
}

/** Wrap to [0, 2π). */
export function wrapPositive(a: number): number {
  const x = a % TWO_PI;
  return x < 0 ? x + TWO_PI : x;
}

/** Smallest signed difference a − b in (−π, π]. */
export function angleDiff(a: number, b: number): number {
  return wrapAngle(a - b);
}

/**
 * Incremental unwrapper. Each new wrapped sample is placed on the branch
 * closest to the previous unwrapped value, optionally guided by a predicted
 * angular step (needed when |ω·Δt| approaches π, i.e. fast balls / low fps).
 */
export class AngleUnwrapper {
  private last: number | null = null;

  reset(): void {
    this.last = null;
  }

  push(wrapped: number, predictedStep = 0): number {
    if (this.last === null) {
      this.last = wrapped;
      return wrapped;
    }
    const expected = this.last + predictedStep;
    const value = expected + angleDiff(wrapped, expected);
    this.last = value;
    return value;
  }

  get value(): number | null {
    return this.last;
  }
}

/** Batch unwrap. */
export function unwrapSeries(wrapped: readonly number[]): number[] {
  const u = new AngleUnwrapper();
  return wrapped.map((w) => u.push(w));
}

export const deg = (rad: number): number => (rad * 180) / Math.PI;
export const rad = (degrees: number): number => (degrees * Math.PI) / 180;
