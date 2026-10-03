"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DerivedState,
  FrameMeasurement,
  MotionState,
  PredictionState,
  LockRule,
  TrackingStats,
  TrackingWorkerRequest,
  TrackingWorkerResponse,
  WheelCalibration,
} from "@/types/roulette";
import type { FrameSource } from "@/lib/frameSource";
import { TimingStats } from "@/engine/tracking/angularVelocity";

export interface TrackingSample {
  /** Raw measurement (immutable). */
  m: FrameMeasurement;
  /** Raw derived kinematics (unfiltered). */
  d: DerivedState;
  /** Filtered estimates, spin phase and physical fits. */
  motion: MotionState;
  /** Statistical prediction (Phase 4). */
  prediction: PredictionState;
}

const HISTORY_LIMIT = 6000; // ~100 s at 60 fps

/**
 * Pumps frames from a source into the tracking worker with back-pressure
 * (at most one frame in flight; extra frames are counted as dropped, never
 * queued, so latency stays bounded). Raw measurements are retained in full.
 */
export function useTracking(source: FrameSource | null, calibration: WheelCalibration | null) {
  const workerRef = useRef<Worker | null>(null);
  const inFlight = useRef(false);
  const timing = useRef(new TimingStats());
  const history = useRef<TrackingSample[]>([]);
  const [latest, setLatest] = useState<TrackingSample | null>(null);
  const [stats, setStats] = useState<TrackingStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!calibration) return;
    const w = new Worker(new URL("../workers/tracking.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    w.onmessage = (e: MessageEvent<TrackingWorkerResponse>) => {
      const msg = e.data;
      if (msg.type === "measurement") {
        inFlight.current = false;
        const sample: TrackingSample = {
          m: msg.measurement,
          d: msg.motion.raw,
          motion: msg.motion,
          prediction: msg.prediction,
        };
        history.current.push(sample);
        if (history.current.length > HISTORY_LIMIT) history.current.splice(0, history.current.length - HISTORY_LIMIT);
        timing.current.push(msg.measurement);
        setLatest(sample);
      } else if (msg.type === "error") {
        inFlight.current = false;
        setError(msg.message);
      }
    };
    const req: TrackingWorkerRequest = { type: "configure", calibration, processingWidth: 640 };
    w.postMessage(req);
    const statsTimer = setInterval(() => setStats(timing.current.snapshot()), 500);
    return () => {
      clearInterval(statsTimer);
      w.terminate();
      workerRef.current = null;
    };
  }, [calibration]);

  const start = useCallback(() => {
    const w = workerRef.current;
    if (!source || !w) return;
    setError(null);
    source.start(async (el, meta) => {
      if (inFlight.current) {
        timing.current.drop();
        return;
      }
      inFlight.current = true;
      try {
        const bitmap = await createImageBitmap(el);
        const req: TrackingWorkerRequest = { type: "frame", ...meta, bitmap };
        w.postMessage(req, [bitmap]);
      } catch (err) {
        inFlight.current = false;
        setError(err instanceof Error ? err.message : String(err));
      }
    });
    setRunning(true);
  }, [source]);

  const stop = useCallback(() => {
    source?.stop();
    setRunning(false);
  }, [source]);

  const reset = useCallback(() => {
    history.current = [];
    timing.current.reset();
    workerRef.current?.postMessage({ type: "reset-background" } satisfies TrackingWorkerRequest);
    setLatest(null);
    setStats(null);
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => () => source?.stop(), [source]);

  const setLockRule = useCallback((rule: LockRule) => {
    workerRef.current?.postMessage({ type: "set-lock-rule", rule } satisfies TrackingWorkerRequest);
  }, []);

  const resetProfile = useCallback(() => {
    workerRef.current?.postMessage({ type: "reset-profile" } satisfies TrackingWorkerRequest);
  }, []);

  return { latest, stats, error, running, start, stop, reset, history, version, setLockRule, resetProfile };
}
