import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAMERA, DEFAULT_SPIN, SyntheticSpin, allocFrame, renderWheel, syntheticCalibrationClicks,
  type SyntheticCamera,
} from "@/engine/synthetic/syntheticWheel";
import { createCalibration, DEFAULT_ZONES, assessCalibration } from "@/engine/vision/wheelDetector";
import { WheelTracker } from "@/engine/vision/frameProcessor";
import { suggestSequenceSign, suggestZeroPocket } from "@/engine/vision/pocketDetector";
import { RawKinematics } from "@/engine/tracking/angularVelocity";
import { angleDiff, deg } from "@/engine/geometry/angles";
import { fitEllipse, imageToWheel } from "@/engine/geometry/ellipse";
import type { FrameMeasurement } from "@/types/roulette";

const cam = DEFAULT_CAMERA;
const spin = new SyntheticSpin(DEFAULT_SPIN);
const geom = { wheelType: DEFAULT_SPIN.wheelType, sequenceSign: DEFAULT_SPIN.sequenceSign };

function frameAt(ms: number, seed: number) {
  const f = allocFrame(cam.width, cam.height);
  renderWheel(cam, geom, spin.state(ms), f, { frameSeed: seed });
  return f;
}

function calibrate() {
  const ref = frameAt(0, 1);
  const clicks = syntheticCalibrationClicks(cam, spin.state(0).rotorZero);
  return createCalibration({
    wheelType: "european",
    frame: ref,
    userCentre: clicks.centre,
    rimPoints: clicks.rim,
    zeroPocketPoint: clicks.zeroPocket,
    zones: DEFAULT_ZONES,
    pocketSequenceSign: DEFAULT_SPIN.sequenceSign,
  });
}

describe("synthetic spin generator", () => {
  it("is deterministic and physically ordered", () => {
    const again = new SyntheticSpin(DEFAULT_SPIN);
    expect(again.finalPocket).toBe(spin.finalPocket);
    expect(spin.dropTimeMs).toBeGreaterThan(2000);
    expect(spin.settleTimeMs).toBeGreaterThan(spin.dropTimeMs);
  });
});

describe("calibration helpers", () => {
  it("auto-suggests the zero pocket and sequence direction", () => {
    const f = frameAt(0, 1);
    const clicks = syntheticCalibrationClicks(cam, spin.state(0).rotorZero);
    const rect = fitEllipse(clicks.rim);
    const zero = suggestZeroPocket(f, rect, DEFAULT_ZONES, "european");
    const truthZero = imageToWheel(rect, clicks.zeroPocket).theta;
    expect(Math.abs(deg(angleDiff(zero.theta, truthZero)))).toBeLessThan(3);
    const seq = suggestSequenceSign(f, rect, DEFAULT_ZONES, "european", zero.theta);
    expect(seq.sign).toBe(DEFAULT_SPIN.sequenceSign);
    expect(seq.matchRate).toBeGreaterThan(0.9);
  });

  it("reports a clean calibration", () => {
    const q = assessCalibration(calibrate());
    expect(q.fitRmsResidual).toBeLessThan(0.001);
    expect(q.frameCoverage).toBeGreaterThan(0.99);
    expect(q.centreOffset!).toBeLessThan(0.01); // DEFAULT_CAMERA has no perspective
    expect(q.warnings).toEqual([]);
  });
});

function runScenario(camera: SyntheticCamera, fps: number, seed: number) {
  const sp = new SyntheticSpin({ ...DEFAULT_SPIN, seed });
  const render = (ms: number, fseed: number) => {
    const f = allocFrame(camera.width, camera.height);
    renderWheel(camera, geom, sp.state(ms), f, { frameSeed: fseed });
    return f;
  };
  const clicks = syntheticCalibrationClicks(camera, sp.state(0).rotorZero);
  const cal = createCalibration({
    wheelType: "european",
    frame: render(0, 1),
    userCentre: clicks.centre,
    rimPoints: clicks.rim,
    zeroPocketPoint: clicks.zeroPocket,
    zones: DEFAULT_ZONES,
    pocketSequenceSign: DEFAULT_SPIN.sequenceSign,
  });
  const tracker = new WheelTracker(cal, camera.width, camera.height);
  const kin = new RawKinematics(cal);
  const ref = sp.state(0);
  const r = { ballErr: [] as number[], rotorErr: [] as number[], omegaErr: [] as number[],
    trackFrames: 0, trackDetected: 0, pocketMatches: 0, pocketChecked: 0, finalPocket: sp.finalPocket };
  const endMs = sp.settleTimeMs + 1500;
  for (let k = 0, ms = 0; ms < endMs; k++, ms = (k * 1000) / fps) {
    const truth = sp.state(ms);
    const res = tracker.process(render(ms, k + 7), ms);
    const m: FrameMeasurement = { seq: k, t: ms, timeSource: "synthetic", receivedAt: ms, processingMs: 0, ...res };
    const d = kin.push(m);
    if (res.rotor) {
      const meas = angleDiff(res.rotor.zeroAngle, cal.zeroAngleAtReference);
      const tru = angleDiff(truth.rotorZero, ref.rotorZero);
      r.rotorErr.push(Math.abs(deg(angleDiff(meas, tru))));
    }
    if (k === 0) continue; // background initialisation frame
    if (truth.phase === "track") {
      r.trackFrames++;
      if (res.ball) r.trackDetected++;
    }
    if (res.ball && res.rotor) {
      const relMeas = angleDiff(res.ball.theta, res.rotor.zeroAngle);
      const relTrue = angleDiff(truth.ballTheta, truth.rotorZero);
      r.ballErr.push(Math.abs(deg(angleDiff(relMeas, relTrue))));
      if (truth.phase === "track" && d.ballOmegaRaw !== null && ms > 300) {
        const w = (sp.ballThetaUnwrapped(ms + 10) - sp.ballThetaUnwrapped(ms - 10)) / 0.02;
        r.omegaErr.push(Math.abs(d.ballOmegaRaw - w) / Math.abs(w));
      }
    }
    if (truth.phase === "settled" && res.ball && d.pocketUnderBall !== null) {
      r.pocketChecked++;
      if (d.pocketUnderBall === sp.finalPocket) r.pocketMatches++;
    }
  }
  return r;
}

const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)] ?? Infinity;
const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1] ?? Infinity;

const scenarios = [
  { name: "affine camera, 60 fps", camera: cam, fps: 60, seed: 42 },
  {
    name: "strong perspective + oblique, 30 fps",
    camera: { ...cam, perspective: 0.12, rotation: -0.6, foreshorten: 0.7 },
    fps: 30,
    seed: 7,
  },
  // Rotor moves > 1 pocket per frame: exercises alias-safe rotor locking.
  { name: "low frame rate, 10 fps", camera: cam, fps: 10, seed: 12345 },
];

for (const sc of scenarios) {
  describe(`end-to-end tracking on synthetic video: ${sc.name}`, () => {
    const r = runScenario(sc.camera, sc.fps, sc.seed);

    it("tracks the rotor to < 1° (95th pct)", () => {
      expect(r.rotorErr.length).toBeGreaterThan(50);
      expect(p95(r.rotorErr)).toBeLessThan(1);
    });

    it("detects the ball on the track in > 95% of frames", () => {
      expect(r.trackDetected / r.trackFrames).toBeGreaterThan(0.95);
    });

    it("measures ball-relative-to-rotor angle to < 2° (95th pct)", () => {
      expect(p95(r.ballErr)).toBeLessThan(2);
    });

    it("raw ball ω within 3% of truth (median)", () => {
      expect(med(r.omegaErr)).toBeLessThan(sc.fps >= 30 ? 0.03 : 0.06);
    });

    it("identifies the settled pocket", () => {
      expect(r.pocketChecked).toBeGreaterThan(sc.fps >= 30 ? 20 : 5);
      expect(r.pocketMatches / r.pocketChecked).toBeGreaterThan(0.9);
    });
  });
}
