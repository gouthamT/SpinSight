"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { WheelCalibration } from "@/types/roulette";
import { useFrameSource } from "@/hooks/useFrameSource";
import { useTracking } from "@/hooks/useTracking";
import { loadCalibration } from "@/lib/storage/calibrationStore";
import { SyntheticFrameSource } from "@/lib/frameSource";
import { SourcePicker } from "./SourcePicker";
import { SourceView } from "./SourceView";
import { drawLiveOverlay } from "@/components/RouletteOverlay/draw";
import { MeasurementPanel } from "@/components/PredictionPanel/MeasurementPanel";
import { PredictionPanel } from "@/components/PredictionPanel/PredictionPanel";
import { MotionGraph, type Series } from "@/components/MotionGraph/MotionGraph";
import { deg } from "@/engine/geometry/angles";
import { pocketLabel } from "@/engine/wheel/layout";

export function LiveAnalysis() {
  const [cal, setCal] = useState<WheelCalibration | null | undefined>(undefined);
  const src = useFrameSource();
  const trk = useTracking(src.source, cal ?? null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const [rate, setRate] = useState(1);

  useEffect(() => {
    void loadCalibration().then(setCal);
  }, []);

  // Overlay redraw per measurement.
  useEffect(() => {
    const c = overlay.current;
    if (!c || !cal) return;
    const g = c.getContext("2d");
    if (!g) return;
    const h = trk.history.current;
    const trail = h.slice(-24).filter((s) => s.m.ball).map((s) => ({ x: s.m.ball!.x, y: s.m.ball!.y }));
    // Map from calibration pixel space to this canvas (sources can differ in resolution but not aspect).
    const sx = c.width / cal.frameWidth;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.setTransform(sx, 0, 0, c.height / cal.frameHeight, 0, 0);
    drawLiveOverlay(g, cal, {
      rotorZero: trk.latest?.m.rotor?.zeroAngle ?? null,
      ball: trk.latest?.m.ball ?? null,
      trail,
      pocketUnderBall: trk.latest?.d.pocketUnderBall ?? null,
      probs: trk.latest?.prediction.probs ?? null,
    });
    g.setTransform(1, 0, 0, 1, 0, 0);
  }, [trk.latest, cal, trk.history]);

  // Playback rate for files (media-time timestamps keep kinematics correct).
  useEffect(() => {
    const el = src.source?.element;
    if (el instanceof HTMLVideoElement && src.kind === "file") el.playbackRate = rate;
    if (src.source instanceof SyntheticFrameSource) src.source.speed = rate;
  }, [rate, src.source, src.kind]);

  const graphs = useMemo(() => {
    const h = trk.history.current.slice(-900);
    const omega: Series[] = [
      { label: "ball ω (raw)", color: "rgba(255,255,255,0.35)", points: h.map((s) => ({ t: s.m.t, v: s.d.ballOmegaRaw })) },
      { label: "ball ω (Kalman)", color: "#ffffff", points: h.map((s) => ({ t: s.m.t, v: s.motion.ball?.omega ?? null })) },
      { label: "rotor ω (Kalman)", color: "#5aa9ff", points: h.map((s) => ({ t: s.m.t, v: s.motion.rotor?.omega ?? null })) },
    ];
    const alpha: Series[] = [
      { label: "ball α (Kalman)", color: "#ffffff", points: h.map((s) => ({ t: s.m.t, v: s.motion.ball?.alpha ?? null })) },
      {
        label: "ball α (fit −(a+bω²))",
        color: "#f2b84b",
        points: h.map((s) => {
          const f = s.motion.ballFit;
          const w = s.motion.ball?.omega;
          return { t: s.m.t, v: f && w !== undefined && s.motion.spin.phase === "track" ? -(f.a + f.b * w * w) * Math.sign(w) : null };
        }),
      },
      { label: "rotor α (Kalman)", color: "#5aa9ff", points: h.map((s) => ({ t: s.m.t, v: s.motion.rotor?.alpha ?? null })) },
    ];
    const angle: Series[] = [
      { label: "ball θ", color: "#ffffff", points: h.map((s) => ({ t: s.m.t, v: s.m.ball ? deg(s.m.ball.theta) : null })) },
      { label: "rotor zero θ", color: "#5aa9ff", points: h.map((s) => ({ t: s.m.t, v: s.m.rotor ? deg(s.m.rotor.zeroAngle) : null })) },
    ];
    return { omega, alpha, angle };
  }, [trk.latest, trk.version]);

  const startTracking = () => {
    const el = src.source?.element;
    if (el instanceof HTMLVideoElement && el.paused) void el.play();
    trk.start();
  };

  const stopTracking = () => {
    trk.stop();
    const el = src.source?.element;
    if (el instanceof HTMLVideoElement && src.kind === "file") el.pause();
  };

  const exportJson = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      calibrationId: cal?.id,
      source: src.kind,
      note: "Per frame: m = raw measurement (t = monotonic ms), d = unfiltered derived values, motion = Kalman estimates, spin phase and physical fits, prediction = statistical landing estimate (probs indexed by pocket-sequence position, 0 = zero pocket).",
      samples: trk.history.current,
    };
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `spinsight-session-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (cal === undefined) return <div className="text-sm text-ink-400">Loading calibration…</div>;
  if (cal === null) {
    return (
      <div className="panel max-w-lg space-y-3 p-6">
        <div className="font-medium">No calibration yet</div>
        <p className="text-sm text-ink-300">Tracking needs a wheel calibration (centre, rim, zero pocket) for this camera position.</p>
        <Link href="/calibration" className="btn-primary">Calibrate wheel</Link>
      </div>
    );
  }

  const synth = src.source instanceof SyntheticFrameSource ? src.source : null;
  const truth = synth ? synth.spin.state(trk.latest?.m.t ?? 0) : null;

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
      <div className="space-y-4">
        <div className="panel p-3">
          {src.source ? (
            <SourceView source={src.source} overlayRef={overlay} />
          ) : (
            <div className="flex aspect-video items-center justify-center text-sm text-ink-400">Choose a source to start.</div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!trk.running ? (
              <button className="btn-primary" onClick={startTracking} disabled={!src.source}>Start tracking</button>
            ) : (
              <button className="btn-ghost" onClick={stopTracking}>Stop</button>
            )}
            <button className="btn-ghost" onClick={trk.reset}>Reset</button>
            {synth && (
              <button className="btn-ghost" onClick={() => { synth.newSpin(); trk.reset(); }}>New synthetic spin</button>
            )}
            {(src.kind === "file" || synth) && (
              <select className="input w-auto" value={rate} onChange={(e) => setRate(Number(e.target.value))}>
                {[0.25, 0.5, 1].map((r) => <option key={r} value={r}>{r}× speed</option>)}
              </select>
            )}
            <button className="btn-ghost ml-auto" onClick={exportJson} disabled={!trk.history.current.length}>Export raw JSON</button>
          </div>
          {trk.error && <div className="mt-3 rounded-lg border border-bad/40 bg-bad/10 p-3 text-sm text-bad">{trk.error}</div>}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="panel p-4">
            <div className="panel-title mb-2">Angular velocity</div>
            <MotionGraph series={graphs.omega} unit="rad/s" />
          </div>
          <div className="panel p-4">
            <div className="panel-title mb-2">Angular acceleration</div>
            <MotionGraph series={graphs.alpha} unit="rad/s²" />
          </div>
          <div className="panel p-4 lg:col-span-2">
            <div className="panel-title mb-2">Angular position (measured)</div>
            <MotionGraph series={graphs.angle} unit="deg (wrapped)" height={120} />
          </div>
        </div>

        {synth && truth && (
          <div className="panel p-4 text-xs">
            <div className="panel-title mb-2">Synthetic ground truth (for verification)</div>
            <div className="num grid grid-cols-2 gap-1 sm:grid-cols-4">
              <span className="text-ink-400">phase</span><span>{truth.phase}</span>
              <span className="text-ink-400">drop at</span><span>{(synth.spin.dropTimeMs / 1000).toFixed(2)} s</span>
              <span className="text-ink-400">final pocket</span><span>{truth.phase === "settled" ? pocketLabel(synth.spin.finalPocket) : "hidden until settled"}</span>
              <span className="text-ink-400">sim time</span><span>{((trk.latest?.m.t ?? 0) / 1000).toFixed(2)} s</span>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-4">
        <div className="panel p-4">
          <div className="panel-title mb-2">Source</div>
          <SourcePicker src={src} compact />
          <p className="mt-2 text-[11px] text-ink-400">
            Use the same camera position, zoom and resolution as calibration. Calibration: {cal.wheelType}, {cal.frameWidth}×{cal.frameHeight}.
          </p>
        </div>
        <PredictionPanel
          prediction={trk.latest?.prediction ?? null}
          wheelType={cal.wheelType}
          onLockRule={trk.setLockRule}
          onResetProfile={trk.resetProfile}
        />
        <MeasurementPanel latest={trk.latest} stats={trk.stats} />
      </div>
    </div>
  );
}
