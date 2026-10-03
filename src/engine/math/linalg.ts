/** Small dense linear algebra for n ≤ ~10 (normal equations, LM steps). */

export function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i] ?? 0]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-14) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    const rc = M[c]!;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const row = M[r]!;
      const f = row[c]! / rc[c]!;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) row[k] = row[k]! - f * rc[k]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

export function invert(A: number[][]): number[][] | null {
  const n = A.length;
  const cols: number[][] = [];
  for (let j = 0; j < n; j++) {
    const e = Array.from({ length: n }, (_, i) => (i === j ? 1 : 0));
    const c = solve(A, e);
    if (!c) return null;
    cols.push(c);
  }
  return Array.from({ length: n }, (_, i) => cols.map((c) => c[i]!));
}

/** Ordinary least squares y ≈ X β. Returns β, covariance (σ² (XᵀX)⁻¹), residual σ. */
export function ols(X: number[][], y: number[]): { beta: number[]; cov: number[][]; sigma: number } | null {
  const n = y.length;
  const p = X[0]?.length ?? 0;
  if (n <= p) return null;
  const XtX = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const Xty = new Array<number>(p).fill(0);
  for (let i = 0; i < n; i++) {
    const row = X[i]!;
    for (let a = 0; a < p; a++) {
      Xty[a]! += row[a]! * y[i]!;
      for (let b = 0; b < p; b++) XtX[a]![b]! += row[a]! * row[b]!;
    }
  }
  const beta = solve(XtX, Xty);
  const inv = invert(XtX);
  if (!beta || !inv) return null;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    let f = 0;
    for (let a = 0; a < p; a++) f += X[i]![a]! * beta[a]!;
    ss += (y[i]! - f) ** 2;
  }
  const s2 = ss / (n - p);
  return { beta, cov: inv.map((r) => r.map((v) => v * s2)), sigma: Math.sqrt(s2) };
}
