import type { EllipseRectification, Point2 } from "@/types/roulette";

/**
 * Wheel rectification.
 *
 * A circular wheel rim viewed by a camera projects to (very nearly) an ellipse.
 * We fit that ellipse to user-clicked rim points and build the affine map that
 * turns it back into the unit circle. The residual rotation of that map is
 * irrelevant: we only ever use angles RELATIVE to the rotor's zero pocket,
 * which is measured in the same frame.
 *
 * Assumption: the camera is far enough / overhead enough that perspective
 * foreshortening across the wheel is close to affine. Strongly oblique views
 * shift the true centre away from the ellipse centre; the calibration UI
 * reports that offset so the user can reposition the camera.
 */

type Sym2 = [number, number, number, number]; // [a, b, b, d]

function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i] ?? 0]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(M[pivot]![col]!) < 1e-12) return null;
    [M[col], M[pivot]] = [M[pivot]!, M[col]!];
    const rowC = M[col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const row = M[r]!;
      const f = row[col]! / rowC[col]!;
      if (f === 0) continue;
      for (let k = col; k <= n; k++) row[k] = row[k]! - f * rowC[k]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

function symEigen(a: number, b: number, d: number) {
  const tr = a + d;
  const det = a * d - b * b;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc; // larger
  const l2 = tr / 2 - disc; // smaller
  // Eigenvector for l2 (major axis of the ellipse xᵀQx = 1).
  let vx: number, vy: number;
  if (Math.abs(b) > 1e-15) {
    vx = l2 - d;
    vy = b;
  } else if (a <= d) {
    vx = 1;
    vy = 0;
  } else {
    vx = 0;
    vy = 1;
  }
  const n = Math.hypot(vx, vy);
  return { l1, l2, v2: { x: vx / n, y: vy / n } };
}

/** Q^{power} for symmetric positive-definite Q. */
function symPow(q: Sym2, power: number): Sym2 {
  const [a, b, , d] = q;
  const { l1, l2, v2 } = symEigen(a, b, d);
  // v1 ⟂ v2
  const v1 = { x: -v2.y, y: v2.x };
  const p1 = Math.pow(l1, power);
  const p2 = Math.pow(l2, power);
  const xx = p1 * v1.x * v1.x + p2 * v2.x * v2.x;
  const xy = p1 * v1.x * v1.y + p2 * v2.x * v2.y;
  const yy = p1 * v1.y * v1.y + p2 * v2.y * v2.y;
  return [xx, xy, xy, yy];
}

export class EllipseFitError extends Error {}

interface ConicFit {
  coeffs: [number, number, number, number, number]; // A..E with F = −1, in q = (p − m)/scale
  mx: number;
  my: number;
  scale: number;
}

function fitConic(points: readonly Point2[]): ConicFit {
  if (points.length < 5) throw new EllipseFitError("At least 5 rim points are required.");
  const mx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const my = points.reduce((s, p) => s + p.y, 0) / points.length;
  const scale =
    Math.sqrt(points.reduce((s, p) => s + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / points.length) ||
    1;
  const ATA: number[][] = Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);
  const ATb = [0, 0, 0, 0, 0];
  for (const p of points) {
    const x = (p.x - mx) / scale;
    const y = (p.y - my) / scale;
    const row = [x * x, x * y, y * y, x, y];
    for (let i = 0; i < 5; i++) {
      ATb[i]! += row[i]!;
      for (let j = 0; j < 5; j++) ATA[i]![j]! += row[i]! * row[j]!;
    }
  }
  const sol = solveLinear(ATA, ATb);
  if (!sol) throw new EllipseFitError("Rim points are degenerate (collinear or duplicated).");
  return { coeffs: sol as ConicFit["coeffs"], mx, my, scale };
}

/** Least-squares conic fit (Ax²+Bxy+Cy²+Dx+Ey = 1 in centred coordinates). Needs ≥5 points. */
export function fitEllipse(points: readonly Point2[]): EllipseRectification {
  const { coeffs, mx, my, scale } = fitConic(points);
  const [A, B, C, D, E] = coeffs;
  const F = -1;
  if (4 * A * C - B * B <= 0) throw new EllipseFitError("Rim points do not form an ellipse.");

  // Centre: ∇ = 0  →  [2A B; B 2C][x y]ᵀ = −[D E]ᵀ
  const det = 4 * A * C - B * B;
  const cx = (B * E - 2 * C * D) / det;
  const cy = (B * D - 2 * A * E) / det;
  const Fc = A * cx * cx + B * cx * cy + C * cy * cy + D * cx + E * cy + F;
  if (Fc >= 0) throw new EllipseFitError("Conic fit is not a real ellipse.");
  // (q−c)ᵀ M (q−c) = −Fc, M = [[A, B/2],[B/2, C]]; normalise and undo scaling (p = m + s q).
  const k = -Fc * scale * scale;
  const Q: Sym2 = [A / k, B / 2 / k, B / 2 / k, C / k];

  const forward = symPow(Q, 0.5);
  const inverse = symPow(Q, -0.5);
  const centre = { x: mx + cx * scale, y: my + cy * scale };
  const { l1, l2, v2 } = symEigen(Q[0], Q[1], Q[3]);

  const rect: EllipseRectification = {
    centre,
    forward,
    inverse,
    semiMajorPx: 1 / Math.sqrt(l2),
    semiMinorPx: 1 / Math.sqrt(l1),
    tiltRad: Math.atan2(v2.y, v2.x),
    fitRmsResidual: 0,
    projective: null,
  };
  const res = points.map((p) => imageToWheel(rect, p).r - 1);
  rect.fitRmsResidual = Math.sqrt(res.reduce((s, r) => s + r * r, 0) / res.length);
  return rect;
}

export interface PolarPoint {
  r: number;
  theta: number;
}

/** Image px → wheel polar (r normalised, θ counter-clockwise on screen). */
export function imageToWheel(rect: EllipseRectification, p: Point2): PolarPoint {
  const q = toAffineSpace(rect, p);
  const [a, b, , d] = rect.forward;
  const dx = q.x - rect.centre.x;
  const dy = q.y - rect.centre.y;
  const ux = a * dx + b * dy;
  const uy = b * dx + d * dy;
  return { r: Math.hypot(ux, uy), theta: Math.atan2(-uy, ux) };
}

/** Wheel polar → image px. */
export function wheelToImage(rect: EllipseRectification, r: number, theta: number): Point2 {
  const [a, b, , d] = rect.inverse;
  const ux = r * Math.cos(theta);
  const uy = -r * Math.sin(theta);
  return fromAffineSpace(rect, {
    x: rect.centre.x + a * ux + b * uy,
    y: rect.centre.y + b * ux + d * uy,
  });
}

function toAffineSpace(rect: EllipseRectification, p: Point2): Point2 {
  const h = rect.projective;
  if (!h) return p;
  const x = p.x - h.ox;
  const y = p.y - h.oy;
  const w = 1 + h.l1 * x + h.l2 * y;
  return { x: x / w, y: y / w };
}

function fromAffineSpace(rect: EllipseRectification, q: Point2): Point2 {
  const h = rect.projective;
  if (!h) return q;
  const w = 1 - h.l1 * q.x - h.l2 * q.y;
  return { x: q.x / w + h.ox, y: q.y / w + h.oy };
}

/**
 * Projective rectification from the rim ellipse plus the image of the wheel
 * hub. The hub's polar line w.r.t. the rim conic is the image of the line at
 * infinity; mapping it back to infinity removes perspective, after which the
 * rim is an exact ellipse centred on the hub and the affine step finishes the
 * job. Falls back to affine-only when the hub click is implausible.
 */
export function fitWheelRectification(
  rimPoints: readonly Point2[],
  hub: Point2 | null,
): EllipseRectification {
  const affine = fitEllipse(rimPoints);
  if (!hub) return affine;
  const { coeffs, mx, my, scale } = fitConic(rimPoints);
  const [A, B, C, D, E] = coeffs;
  // Conic in q-coordinates; q = (p̃ + hub − m)/scale where p̃ = p − hub.
  const tx = (hub.x - mx) / scale;
  const ty = (hub.y - my) / scale;
  // Third column of Tᵀ Cq T with T = [[1/s,0,tx],[0,1/s,ty],[0,0,1]]:
  const c02 = (A * tx + (B / 2) * ty + D / 2) / scale;
  const c12 = ((B / 2) * tx + C * ty + E / 2) / scale;
  const c22 = A * tx * tx + B * tx * ty + C * ty * ty + D * tx + E * ty - 1;
  if (c22 >= 0) return affine; // hub outside the rim
  const l1 = c02 / c22;
  const l2 = c12 / c22;
  // Plausibility: the correction must stay mild across the wheel.
  const maxW = Math.max(...rimPoints.map((p) => Math.abs(l1 * (p.x - hub.x) + l2 * (p.y - hub.y))));
  if (maxW > 0.35) return affine;
  const projective = { ox: hub.x, oy: hub.y, l1, l2 };
  const warped = rimPoints.map((p) => {
    const x = p.x - hub.x,
      y = p.y - hub.y;
    const w = 1 + l1 * x + l2 * y;
    return { x: x / w, y: y / w };
  });
  const inner = fitEllipse(warped);
  const rect: EllipseRectification = { ...inner, projective };
  const res = rimPoints.map((p) => imageToWheel(rect, p).r - 1);
  rect.fitRmsResidual = Math.sqrt(res.reduce((s, r) => s + r * r, 0) / res.length);
  return rect;
}

/** Scale a rectification fitted at one resolution to another (e.g. processing width). */
export function scaleRectification(
  rect: EllipseRectification,
  sx: number,
  sy: number,
): EllipseRectification {
  // p' = S p.  u = F (p − c) = F S⁻¹ (p' − c')  → new forward = F S⁻¹ (not symmetric unless sx = sy).
  // We keep aspect-preserving scaling (sx ≈ sy) in practice; use the mean for robustness.
  const s = (sx + sy) / 2;
  const [a, b, , d] = rect.forward;
  const [ia, ib, , id] = rect.inverse;
  const h = rect.projective;
  return {
    ...rect,
    projective: h ? { ox: h.ox * sx, oy: h.oy * sy, l1: h.l1 / s, l2: h.l2 / s } : null,
    centre: { x: rect.centre.x * s, y: rect.centre.y * s },
    forward: [a / s, b / s, b / s, d / s],
    inverse: [ia * s, ib * s, ib * s, id * s],
    semiMajorPx: rect.semiMajorPx * s,
    semiMinorPx: rect.semiMinorPx * s,
  };
}

/** Distance (normalised units) between the user-clicked hub and the fitted ellipse centre. */
export function centreOffset(rect: EllipseRectification, userCentre: Point2 | null): number | null {
  if (!userCentre) return null;
  return imageToWheel(rect, userCentre).r;
}
