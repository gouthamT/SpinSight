import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAMERA, DEFAULT_SPIN, SyntheticSpin, allocFrame, renderWheel, syntheticCalibrationClicks,
} from "@/engine/synthetic/syntheticWheel";
import { createCalibration, DEFAULT_ZONES } from "@/engine/vision/wheelDetector";
import { WheelTracker } from "@/engine/vision/frameProcessor";
import { MotionEstimator } from "@/engine/tracking/motionEstimator";
import type { MotionState } from "@/types/roulette";

const cam = DEFAULT_CAMERA;

function run(seed: number, fps: number, camera = cam) {
  const spin = new SyntheticSpin({ ...DEFAULT_SPIN, seed });
  const geom = { wheelType: "european" as const, sequenceSign: DEFAULT_SPIN.sequenceSign };
  const render = (ms: number, s: number) => {
    const f = allocFrame(camera.width, camera.height);
    renderWheel(camera, geom, spin.state(ms), f, { frameSeed: s });
    return f;
  };
  const clicks = syntheticCalibrationClicks(camera, spin.state(0).rotorZero);
  const cal = createCalibration({
    wheelType: "european", frame: render(0, 1), userCentre: clicks.centre, rimPoints: clicks.rim,
    zeroPocketPoint: clicks.zeroPocket, zones: DEFAULT_ZONES, pocketSequenceSign: DEFAULT_SPIN.sequenceSign,
  });
  const tracker = new WheelTracker(cal, camera.width, camera.height);
  const est = new MotionEstimator(cal);
  const states: MotionState[] = [];
  const ballOmegaErr: number[] = [];
  const end = spin.settleTimeMs + 1500;
  for (let k = 0, ms = 0; ms < end; k++, ms = (k * 1000) / fps) {
    const r = tracker.process(render(ms, k + 11), ms);
    const s = est.push({ seq: k, t: ms, timeSource: "synthetic", receivedAt: ms, processingMs: 0, ...r });
    states.push(s);
    if (spin.state(ms).phase === "track" && ms > 600 && s.ball) {
      const w = (spin.ballThetaUnwrapped(ms + 1) - spin.ballThetaUnwrapped(ms - 1)) / 0.002;
      ballOmegaErr.push(Math.abs(s.ball.omega - w) / Math.abs(w));
    }
  }
  // First time the true ball radius drops below the track's inner edge.
  let trueLeave = 0;
  for (let ms = spin.dropTimeMs; ms < spin.durationMs; ms++) if (spin.state(ms).ballR < DEFAULT_ZONES.ballTrack.inner) { trueLeave = ms; break; }
  return { spin, states, ballOmegaErr, trueLeave };
}

describe("MotionEstimator end-to-end on rendered synthetic video", () => {
  const { spin, states, ballOmegaErr, trueLeave } = run(42, 60);
  const last = states[states.length - 1]!;

  it("Kalman ball ω within 1 % (median) on the track", () => {
    const med = [...ballOmegaErr].sort((a, b) => a - b)[ballOmegaErr.length >> 1]!;
    expect(med).toBeLessThan(0.01);
  });

  it("detects launch, drop, rotor contact and settle in order", () => {
    const e = last.spin.events;
    expect(e.spinId).toBe(1);
    expect(e.launchT!).toBeLessThan(500);
    expect(Math.abs(e.dropT! - trueLeave)).toBeLessThan(80);
    expect(e.rotorContactT!).toBeGreaterThan(e.dropT!);
    expect(e.settleT!).toBeGreaterThan(e.rotorContactT!);
    expect(last.spin.phase).toBe("settled");
  });

  it("reports the settled pocket", () => {
    expect(last.spin.events.settledPocket).toBe(spin.finalPocket);
  });

  it("fits ball deceleration a, b within 15 % from rendered frames", () => {
    const fits = states.filter((s) => s.spin.phase === "track" && s.ballFit?.valid);
    const f = fits[fits.length - 1]!.ballFit!;
    expect(Math.abs(f.a - DEFAULT_SPIN.frictionA) / DEFAULT_SPIN.frictionA).toBeLessThan(0.15);
    expect(Math.abs(f.b - DEFAULT_SPIN.dragB) / DEFAULT_SPIN.dragB).toBeLessThan(0.15);
  });

  it("rotor ω and α from Kalman/fit match truth", () => {
    const s = states.find((x) => x.t >= 5000)!;
    expect(Math.abs(s.rotor!.omega - spin.rotorOmega(s.t))).toBeLessThan(0.02);
    expect(Math.abs(s.rotorFit!.alpha - DEFAULT_SPIN.rotorAlpha)).toBeLessThan(0.02);
  });
});

describe("MotionEstimator: perspective camera, 30 fps, ball pauses then hops pockets", () => {
  // Seed 7 has a mid-bounce pause long enough to look settled; the machine must
  // revert to "bouncing" when the ball hops, and report the final pocket.
  const { spin, states } = run(7, 30, { ...cam, perspective: 0.12, rotation: -0.6, foreshorten: 0.7 });
  const last = states[states.length - 1]!;
  it("ends settled on the true final pocket", () => {
    expect(last.spin.phase).toBe("settled");
    expect(last.spin.events.settledPocket).toBe(spin.finalPocket);
  });
});
