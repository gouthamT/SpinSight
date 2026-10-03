import { describe, expect, it } from "vitest";
import { AngleKalman, BALL_KALMAN, ROTOR_KALMAN, nees, rtsSmooth } from "@/engine/tracking/kalmanFilter";
import { DEFAULT_SPIN, SyntheticSpin, mulberry32 } from "@/engine/synthetic/syntheticWheel";
import { wrapAngle } from "@/engine/geometry/angles";

function gauss(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-12), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const spin = new SyntheticSpin(DEFAULT_SPIN);
/** True ball [θ, ω, α] on the track (central differences of the 1 ms generator). */
function truthBall(ms: number): [number, number, number] {
  const th = (m: number) => spin.ballThetaUnwrapped(m);
  const w = (m: number) => (th(m + 1) - th(m - 1)) / 0.002;
  return [th(ms), w(ms), (w(ms + 5) - w(ms - 5)) / 0.01];
}

function runBall(fps: number, sigma: number, opts: { outlierRate?: number; gap?: [number, number] } = {}) {
  const rnd = mulberry32(99);
  const kf = new AngleKalman(BALL_KALMAN, true);
  const rows: { ms: number; x: [number, number, number]; P: number[] }[] = [];
  const end = spin.dropTimeMs - 50;
  let outliers = 0;
  for (let k = 0; (k * 1000) / fps < end; k++) {
    const ms = (k * 1000) / fps;
    if (opts.gap && ms >= opts.gap[0] && ms < opts.gap[1]) {
      kf.update(ms / 1000, null);
      continue;
    }
    let z = wrapAngle(spin.ballThetaUnwrapped(ms) + sigma * gauss(rnd));
    if (opts.outlierRate && rnd() < opts.outlierRate) {
      z = wrapAngle(z + 0.5 + 2 * rnd());
      outliers++;
    }
    kf.update(ms / 1000, z, 1);
    rows.push({ ms, x: kf.state, P: kf.covariance });
  }
  return { kf, rows, outliers };
}

describe("AngleKalman (ball, constant-acceleration)", () => {
  it("estimates ω to < 0.8 % RMS and α to < 0.35 rad/s² RMS at 60 fps", () => {
    const { rows } = runBall(60, 0.005);
    const late = rows.filter((r) => r.ms > 500);
    const eW = late.map((r) => (r.x[1] - truthBall(r.ms)[1]) / truthBall(r.ms)[1]);
    const eA = late.map((r) => r.x[2] - truthBall(r.ms)[2]);
    const rms = (a: number[]) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    expect(rms(eW)).toBeLessThan(0.008);
    expect(rms(eA)).toBeLessThan(0.35);
  });

  it("is statistically consistent (mean NEES on θ,ω within [0.5, 5], 2 dof)", () => {
    const { rows } = runBall(60, 0.005);
    const late = rows.filter((r) => r.ms > 500);
    const v = late.map((r) => nees(r.x, r.P as never, truthBall(r.ms), [0, 1]));
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    expect(mean).toBeGreaterThan(0.5);
    expect(mean).toBeLessThan(5);
  });

  it("rejects outliers (glare) without corrupting ω", () => {
    const clean = runBall(60, 0.005).rows.filter((r) => r.ms > 500);
    const dirty = runBall(60, 0.005, { outlierRate: 0.05 });
    expect(dirty.kf.rejectedTotal).toBeGreaterThan(dirty.outliers * 0.8);
    const last = dirty.rows[dirty.rows.length - 1]!;
    const truth = truthBall(last.ms)[1];
    expect(Math.abs((last.x[1] - truth) / truth)).toBeLessThan(0.01);
    expect(clean.length).toBeGreaterThan(100);
  });

  it("coasts through a 200 ms detection gap and recovers", () => {
    const { rows, kf } = runBall(60, 0.005, { gap: [3000, 3200] });
    const after = rows.find((r) => r.ms >= 3200)!;
    const truth = truthBall(after.ms);
    expect(Math.abs(wrapAngle(after.x[0] - truth[0]))).toBeLessThan(0.05);
    expect(kf.status).toBe("tracking");
  });

  it("works at 10 fps (ω·Δt up to 1.5 rad)", () => {
    const { rows } = runBall(10, 0.005);
    const late = rows.filter((r) => r.ms > 1500);
    const worst = Math.max(...late.map((r) => Math.abs((r.x[1] - truthBall(r.ms)[1]) / truthBall(r.ms)[1])));
    expect(worst).toBeLessThan(0.03);
  });

  it("RTS smoothing reduces ω error versus filtering", () => {
    const { kf } = runBall(60, 0.01);
    const sm = rtsSmooth(kf.history);
    const filt = kf.history;
    let ef = 0, es = 0, n = 0;
    for (let i = 30; i < filt.length - 30; i++) {
      const tr = truthBall(filt[i]!.t * 1000)[1];
      ef += (filt[i]!.x[1] - tr) ** 2;
      es += (sm[i]!.x[1] - tr) ** 2;
      n++;
    }
    expect(Math.sqrt(es / n)).toBeLessThan(0.6 * Math.sqrt(ef / n));
  });
});

describe("AngleKalman (rotor)", () => {
  it("tracks rotor ω to < 0.01 rad/s and α to < 0.02 rad/s²", () => {
    const rnd = mulberry32(5);
    const kf = new AngleKalman(ROTOR_KALMAN);
    let last = { ms: 0 };
    for (let k = 0; k < 60 * 10; k++) {
      const ms = (k * 1000) / 60;
      kf.update(ms / 1000, wrapAngle(spin.rotorAngle(ms) + 0.003 * gauss(rnd)));
      last = { ms };
    }
    const x = kf.state;
    expect(Math.abs(x[1] - spin.rotorOmega(last.ms))).toBeLessThan(0.01);
    expect(Math.abs(x[2] - DEFAULT_SPIN.rotorAlpha)).toBeLessThan(0.02);
  });
});
