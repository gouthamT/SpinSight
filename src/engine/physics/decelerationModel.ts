/**
 * Ball-on-track deceleration model (Small & Tse 2012 style):
 *
 *     dω/dt = −(a + b·ω²)·sgn(ω)
 *
 * a: constant (rolling-friction-like) deceleration, rad/s²
 * b: quadratic (air-drag-like) coefficient, 1/rad
 *
 * Closed form for |ω| (s = sgn ω0), with k = √(ab), φ0 = atan(|ω0|·√(b/a)):
 *     |ω|(t) = √(a/b) · tan(φ0 − k t)                    valid while φ0 − k t > 0
 *     θ(t)   = θ0 + s · (1/b) · ln[ cos(φ0 − k t) / cos φ0 ]
 *     t(|ω| = w) = (φ0 − atan(w·√(b/a))) / k
 */
export interface DecelParams {
  a: number;
  b: number;
}

export function phi0(p: DecelParams, omega0: number): number {
  return Math.atan(Math.abs(omega0) * Math.sqrt(p.b / p.a));
}

/** Time at which the ball would stop under this model (s). */
export function stopTime(p: DecelParams, omega0: number): number {
  return phi0(p, omega0) / Math.sqrt(p.a * p.b);
}

export function omegaAt(p: DecelParams, omega0: number, t: number): number {
  const k = Math.sqrt(p.a * p.b);
  const arg = phi0(p, omega0) - k * t;
  if (arg <= 0) return 0;
  return Math.sign(omega0) * Math.sqrt(p.a / p.b) * Math.tan(arg);
}

export function thetaAt(p: DecelParams, theta0: number, omega0: number, t: number): number {
  const k = Math.sqrt(p.a * p.b);
  const f0 = phi0(p, omega0);
  const arg = Math.max(f0 - k * t, 1e-9);
  return theta0 + (Math.sign(omega0) / p.b) * Math.log(Math.cos(arg) / Math.cos(f0));
}

/** Time until |ω| falls to `w` (s); 0 if already below, Infinity if never. */
export function timeToOmega(p: DecelParams, omega0: number, w: number): number {
  if (Math.abs(omega0) <= w) return 0;
  const k = Math.sqrt(p.a * p.b);
  return (phi0(p, omega0) - Math.atan(w * Math.sqrt(p.b / p.a))) / k;
}
