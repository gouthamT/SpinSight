/**
 * Tracking worker: receives ImageBitmaps + timestamps and runs, off the main thread,
 *   vision (WheelTracker) → motion (MotionEstimator) → prediction (PredictionEngine).
 * The learned wheel profile is loaded from / saved to IndexedDB here.
 */
import type {
  LockRule,
  TimeSource,
  TrackingWorkerRequest,
  TrackingWorkerResponse,
  WheelCalibration,
} from "@/types/roulette";
import { WheelTracker } from "@/engine/vision/frameProcessor";
import { MotionEstimator } from "@/engine/tracking/motionEstimator";
import { PredictionEngine } from "@/engine/prediction/ensemblePredictor";
import { deleteProfile, loadProfile, profileKey, saveProfile } from "@/lib/storage/profileStore";

interface WorkerScope {
  postMessage(msg: TrackingWorkerResponse): void;
  onmessage: ((e: MessageEvent<TrackingWorkerRequest>) => void) | null;
}
const ctx = self as unknown as WorkerScope;

let calibration: WheelCalibration | null = null;
let processingWidth = 640;
let tracker: WheelTracker | null = null;
let motion: MotionEstimator | null = null;
let prediction: PredictionEngine | null = null;
let lockRule: LockRule = { kind: "lead-time", leadMs: 2000 };
let canvas: OffscreenCanvas | null = null;
let g: OffscreenCanvasRenderingContext2D | null = null;

function ensure(bitmapW: number, bitmapH: number): { w: number; h: number } {
  if (!calibration) throw new Error("Tracker not configured");
  const aspectCal = calibration.frameWidth / calibration.frameHeight;
  const aspect = bitmapW / bitmapH;
  if (Math.abs(aspect - aspectCal) > 0.02) {
    throw new Error(
      `Video aspect ${bitmapW}×${bitmapH} differs from calibration ${calibration.frameWidth}×${calibration.frameHeight}. Recalibrate for this source.`,
    );
  }
  const w = Math.min(processingWidth, bitmapW);
  const h = Math.round(w / aspect);
  if (!tracker || tracker.width !== w || tracker.height !== h) {
    tracker = new WheelTracker(calibration, w, h);
    canvas = new OffscreenCanvas(w, h);
    g = canvas.getContext("2d", { willReadFrequently: true });
  }
  return { w, h };
}

/** Prediction engine is created on the first frame, once we know if the source is synthetic. */
function ensurePrediction(timeSource: TimeSource): PredictionEngine {
  if (prediction) return prediction;
  const key = profileKey(calibration!.id, timeSource === "synthetic");
  const engine = new PredictionEngine(calibration!, null, key, { lockRule });
  prediction = engine;
  void loadProfile(key).then((p) => {
    // Only adopt the stored profile if nothing was learned in the meantime.
    if (p && prediction === engine && engine.currentProfile.observations.length === 0) {
      engine.loadProfile(p, key);
      ctx.postMessage({ type: "profile-status", key, spins: p.observations.length });
    }
  });
  return engine;
}

ctx.onmessage = (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case "configure":
        calibration = msg.calibration;
        processingWidth = msg.processingWidth;
        tracker = null;
        prediction = null;
        motion = new MotionEstimator(msg.calibration);
        ctx.postMessage({ type: "ready" });
        break;
      case "reset-background":
        tracker?.resetBackground();
        motion?.reset();
        break;
      case "set-lock-rule":
        lockRule = msg.rule;
        prediction?.setLockRule(msg.rule);
        break;
      case "reset-profile":
        if (prediction) {
          prediction.resetProfile();
          void deleteProfile(prediction.currentProfile.key);
          ctx.postMessage({ type: "profile-status", key: prediction.currentProfile.key, spins: 0 });
        }
        break;
      case "frame": {
        const start = performance.now();
        const { w, h } = ensure(msg.bitmap.width, msg.bitmap.height);
        g!.drawImage(msg.bitmap, 0, 0, w, h);
        msg.bitmap.close();
        const img = g!.getImageData(0, 0, w, h);
        const res = tracker!.process(img, msg.t);
        const measurement = {
          seq: msg.seq,
          t: msg.t,
          timeSource: msg.timeSource,
          receivedAt: msg.receivedAt,
          processingMs: performance.now() - start,
          ball: res.ball,
          rotor: res.rotor,
        };
        // The raw measurement is final here; estimators never mutate it.
        const m = motion!.push(measurement);
        const engine = ensurePrediction(msg.timeSource);
        const p = engine.push(measurement, m);
        if (engine.profileChanged) void saveProfile(engine.currentProfile);
        ctx.postMessage({ type: "measurement", measurement, motion: m, prediction: p });
        break;
      }
    }
  } catch (err) {
    if (msg.type === "frame") msg.bitmap.close();
    ctx.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
