/** Small statistics toolkit (no dependencies). */

/** ln Γ(x) via Lanczos (g = 7, n = 9). */
export function lnGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0]!;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularised upper incomplete gamma Q(s, x) (Numerical Recipes gser/gcf). */
export function gammaQ(s: number, x: number): number {
  if (x <= 0) return 1;
  if (x < s + 1) {
    let sum = 1 / s, del = sum, ap = s;
    for (let n = 0; n < 500; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + s * Math.log(x) - lnGamma(s));
  }
  let b = x + 1 - s, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + s * Math.log(x) - lnGamma(s)) * h;
}

/** Pearson χ² goodness-of-fit against equal frequencies. */
export function chiSquareUniform(counts: readonly number[]): { statistic: number; df: number; pValue: number } {
  const n = counts.reduce((a, b) => a + b, 0);
  const k = counts.length;
  const e = n / k;
  const stat = counts.reduce((s, c) => s + (c - e) ** 2 / e, 0);
  const df = k - 1;
  return { statistic: stat, df, pValue: gammaQ(df / 2, stat / 2) };
}
