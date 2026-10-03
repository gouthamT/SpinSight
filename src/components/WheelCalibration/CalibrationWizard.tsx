"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Point2, RotationSign, WheelCalibration, WheelType, WheelZones } from "@/types/roulette";
import { useFrameSource } from "@/hooks/useFrameSource";
import { SourcePicker } from "@/components/CameraFeed/SourcePicker";
import { SourceView } from "@/components/CameraFeed/SourceView";
import { captureStill, SyntheticFrameSource } from "@/lib/frameSource";
import { fitWheelRectification, imageToWheel, wheelToImage } from "@/engine/geometry/ellipse";
import { assessCalibration, createCalibration, DEFAULT_ZONES } from "@/engine/vision/wheelDetector";
import { suggestSequenceSign, suggestZeroPocket } from "@/engine/vision/pocketDetector";
import { syntheticCalibrationClicks } from "@/engine/synthetic/syntheticWheel";
import { saveCalibration } from "@/lib/storage/calibrationStore";
import { COLORS, drawCross, drawLine, drawPocketLabels, drawZones } from "@/components/RouletteOverlay/draw";

const STEPS = [
  { id: "type", title: "Wheel type" },
  { id: "hub", title: "Mark wheel centre" },
  { id: "rim", title: "Mark outer rim" },
  { id: "zones", title: "Fit track & pocket rings" },
  { id: "zero", title: "Identify zero pocket" },
  { id: "direction", title: "Pocket number direction" },
  { id: "review", title: "Review & save" },
] as const;
type StepId = (typeof STEPS)[number]["id"];

export function CalibrationWizard() {
  const src = useFrameSource();
  const liveOverlay = useRef<HTMLCanvasElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [still, setStill] = useState<ImageData | null>(null);
  const [step, setStep] = useState<StepId>("type");
  const [wheelType, setWheelType] = useState<WheelType>("european");
  const [hub, setHub] = useState<Point2 | null>(null);
  const [rim, setRim] = useState<Point2[]>([]);
  const [zones, setZones] = useState<WheelZones>(DEFAULT_ZONES);
  const [zero, setZero] = useState<Point2 | null>(null);
  const [sign, setSign] = useState<RotationSign>(-1);
  const [hint, setHint] = useState<string | null>(null);
  const [hover, setHover] = useState<Point2 | null>(null);
  const [saved, setSaved] = useState<WheelCalibration | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rect = useMemo(() => {
    if (rim.length < 5) return null;
    try {
      return fitWheelRectification(rim, hub);
    } catch {
      return null;
    }
  }, [rim, hub]);

  const draft = useMemo(() => {
    if (!still || !rect || !zero) return null;
    try {
      return createCalibration({
        wheelType,
        frame: still,
        userCentre: hub,
        rimPoints: rim,
        zeroPocketPoint: zero,
        zones,
        pocketSequenceSign: sign,
      });
    } catch {
      return null;
    }
  }, [still, rect, zero, wheelType, hub, rim, zones, sign]);
  const quality = useMemo(() => (draft ? assessCalibration(draft) : null), [draft]);
  const stillCanvas = useMemo(() => {
    if (!still || typeof document === "undefined") return null;
    const c = document.createElement("canvas");
    c.width = still.width;
    c.height = still.height;
    c.getContext("2d")!.putImageData(still, 0, 0);
    return c;
  }, [still]);

  // Draw still + overlay.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !still) return;
    const g = c.getContext("2d")!;
    g.putImageData(still, 0, 0);
    const s = Math.max(1, still.width / 900);
    const lw = 1.5 * s;
    if (rect) drawZones(g, rect, zones, lw);
    rim.forEach((p) => drawCross(g, p, 6 * s, COLORS.click, lw));
    if (hub) drawCross(g, hub, 10 * s, COLORS.zero, lw * 1.5);
    if (rect && zero) {
      const θ = imageToWheel(rect, zero).theta;
      if (step === "direction" || step === "review") {
        drawPocketLabels(g, rect, zones, wheelType, θ, sign, s);
      }
      drawLine(g, wheelToImage(rect, 0, 0), zero, COLORS.zero, lw * 1.5);
      g.beginPath();
      g.fillStyle = COLORS.zero;
      g.arc(zero.x, zero.y, 5 * s, 0, Math.PI * 2);
      g.fill();
    }
    // Loupe for precise clicking.
    if (hover && stillCanvas && (step === "hub" || step === "rim" || step === "zero")) {
      const L = Math.round(160 * s);
      const zoom = 4;
      const sx = hover.x - L / zoom / 2;
      const sy = hover.y - L / zoom / 2;
      const ox = hover.x > still.width / 2 ? 10 : still.width - L - 10;
      g.save();
      g.imageSmoothingEnabled = false;
      g.drawImage(stillCanvas, sx, sy, L / zoom, L / zoom, ox, 10, L, L);
      g.strokeStyle = COLORS.click;
      g.lineWidth = 2;
      g.strokeRect(ox, 10, L, L);
      drawCross(g, { x: ox + L / 2, y: 10 + L / 2 }, 10, COLORS.click, 1.5);
      g.restore();
    }
  }, [still, stillCanvas, rect, rim, hub, zero, zones, sign, wheelType, step, hover]);

  const capture = useCallback(() => {
    if (!src.source) return;
    try {
      setStill(captureStill(src.source));
      setSaved(null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [src.source]);

  const autofillSynthetic = useCallback(() => {
    const s = src.source;
    if (!(s instanceof SyntheticFrameSource)) return;
    const st = s.spin.state(s.simTimeMs);
    const clicks = syntheticCalibrationClicks(s.camera, st.rotorZero);
    setStill(captureStill(s));
    setWheelType(s.spin.params.wheelType);
    setHub(clicks.centre);
    setRim(clicks.rim);
    setZero(clicks.zeroPocket);
    setSign(s.spin.params.sequenceSign);
    setZones(DEFAULT_ZONES);
    setStep("review");
  }, [src.source]);

  const onClick = (p: Point2) => {
    if (step === "hub") setHub(p);
    else if (step === "rim") setRim((r) => [...r, p]);
    else if (step === "zero") setZero(p);
  };

  const toNative = (e: React.PointerEvent<HTMLCanvasElement>): Point2 => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * e.currentTarget.width,
      y: ((e.clientY - r.top) / r.height) * e.currentTarget.height,
    };
  };

  const suggestZero = () => {
    if (!still || !rect) return;
    const z = suggestZeroPocket(still, rect, zones, wheelType);
    const rMid = (zones.pocketRing.inner + zones.pocketRing.outer) / 2;
    setZero(wheelToImage(rect, rMid, z.theta));
    setHint(`Greenest sector found (confidence ${(z.confidence * 100).toFixed(0)}%). Click to override if wrong.`);
  };

  const suggestDirection = () => {
    if (!still || !rect || !zero) return;
    const s = suggestSequenceSign(still, rect, zones, wheelType, imageToWheel(rect, zero).theta);
    setSign(s.sign);
    setHint(
      `Red/black pattern matches ${(s.matchRate * 100).toFixed(0)}% of pockets going ${s.sign === 1 ? "counter-clockwise" : "clockwise"} (separation ${(s.confidence * 100).toFixed(0)}%). Check the labels line up.`,
    );
  };

  const save = async () => {
    if (!draft) return;
    await saveCalibration(draft);
    setSaved(draft);
  };

  const idx = STEPS.findIndex((s) => s.id === step);
  const canNext =
    (step === "type" && !!still) ||
    (step === "hub" && !!hub) ||
    (step === "rim" && !!rect) ||
    step === "zones" ||
    (step === "zero" && !!zero) ||
    step === "direction";

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="panel p-3">
        {!still ? (
          src.source ? (
            <div className="space-y-3">
              <SourceView source={src.source} overlayRef={liveOverlay} />
              <LiveSynthetic source={src.source} />
              <div className="flex flex-wrap gap-2">
                <button className="btn-primary" onClick={capture}>
                  Capture still frame
                </button>
                {src.kind === "synthetic" && (
                  <button className="btn-ghost" onClick={autofillSynthetic}>
                    Auto-fill from synthetic ground truth
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex aspect-video items-center justify-center text-sm text-ink-400">
              Choose a source on the right to begin.
            </div>
          )
        ) : (
          <canvas
            ref={canvasRef}
            width={still.width}
            height={still.height}
            className="w-full rounded-lg"
            style={{ cursor: step === "hub" || step === "rim" || step === "zero" ? "crosshair" : "default", touchAction: "none" }}
            onPointerDown={(e) => onClick(toNative(e))}
            onPointerMove={(e) => setHover(toNative(e))}
            onPointerLeave={() => setHover(null)}
          />
        )}
      </div>

      <div className="space-y-4">
        <div className="panel space-y-3 p-4">
          <div className="panel-title">1 · Source</div>
          <SourcePicker src={src} compact />
          {still && (
            <button className="btn-ghost w-full" onClick={() => setStill(null)}>
              Re-capture frame
            </button>
          )}
          {error && <div className="text-sm text-bad">{error}</div>}
        </div>

        <div className="panel p-4">
          <ol className="mb-4 space-y-1">
            {STEPS.map((s, i) => (
              <li key={s.id}>
                <button
                  className={`w-full rounded px-2 py-1 text-left text-sm ${s.id === step ? "bg-ink-700 text-ink-100" : i < idx ? "text-accent" : "text-ink-400"}`}
                  onClick={() => still && setStep(s.id)}
                  disabled={!still}
                >
                  {i + 2}. {s.title}
                </button>
              </li>
            ))}
          </ol>

          <div className="space-y-3 text-sm">
            {step === "type" && (
              <>
                <p className="text-ink-300">Capture a sharp still with the whole wheel visible, then pick the wheel type.</p>
                <div className="grid grid-cols-1 gap-2">
                  {(["european", "american", "triple-zero"] as const).map((t) => (
                    <button key={t} className={wheelType === t ? "btn-primary" : "btn-ghost"} onClick={() => setWheelType(t)}>
                      {t === "european" ? "European · 37" : t === "american" ? "American · 38" : "Triple zero · 39"}
                    </button>
                  ))}
                </div>
              </>
            )}
            {step === "hub" && (
              <p className="text-ink-300">
                Click the exact centre of the spindle/turret. This point is used to correct camera perspective, so use the loupe.
              </p>
            )}
            {step === "rim" && (
              <>
                <p className="text-ink-300">
                  Click at least 5 points (8–12 is better) evenly around the <b>outer edge of the ball track</b>.
                </p>
                <div className="num text-ink-300">
                  {rim.length} points{rect ? ` · fit residual ${(rect.fitRmsResidual * 100).toFixed(2)}%` : ""}
                </div>
                <div className="flex gap-2">
                  <button className="btn-ghost" onClick={() => setRim((r) => r.slice(0, -1))} disabled={!rim.length}>
                    Undo
                  </button>
                  <button className="btn-ghost" onClick={() => setRim([])} disabled={!rim.length}>
                    Clear
                  </button>
                </div>
              </>
            )}
            {step === "zones" && (
              <>
                <p className="text-ink-300">Drag until the dashed rings sit on the inner edge of the ball track and both edges of the numbered pocket ring.</p>
                <Slider label="Ball track inner edge" value={zones.ballTrack.inner} min={0.75} max={0.97}
                  onChange={(v) => setZones((z) => ({ ...z, ballTrack: { ...z.ballTrack, inner: v } }))} />
                <Slider label="Pocket ring outer edge" value={zones.pocketRing.outer} min={0.5} max={0.85}
                  onChange={(v) => setZones((z) => ({ ...z, pocketRing: { ...z.pocketRing, outer: Math.max(v, z.pocketRing.inner + 0.04) } }))} />
                <Slider label="Pocket ring inner edge" value={zones.pocketRing.inner} min={0.35} max={0.8}
                  onChange={(v) => setZones((z) => ({ ...z, pocketRing: { ...z.pocketRing, inner: Math.min(v, z.pocketRing.outer - 0.04) } }))} />
              </>
            )}
            {step === "zero" && (
              <>
                <p className="text-ink-300">Click the centre of the green 0 pocket, or let SpinSight find the greenest sector.</p>
                <button className="btn-ghost" onClick={suggestZero}>Auto-detect zero</button>
              </>
            )}
            {step === "direction" && (
              <>
                <p className="text-ink-300">The pocket labels should line up with the real numbers. Flip if they run the wrong way.</p>
                <div className="flex gap-2">
                  <button className="btn-ghost" onClick={suggestDirection}>Auto-detect</button>
                  <button className="btn-ghost" onClick={() => setSign((s) => (s === 1 ? -1 : 1))}>
                    Flip ({sign === 1 ? "counter-clockwise" : "clockwise"})
                  </button>
                </div>
              </>
            )}
            {step === "review" && quality && (
              <>
                <dl className="num grid grid-cols-2 gap-y-1 text-xs">
                  <dt className="text-ink-400">Rim fit residual</dt><dd>{(quality.fitRmsResidual * 100).toFixed(2)}%</dd>
                  <dt className="text-ink-400">View axis ratio</dt><dd>{quality.axisRatio.toFixed(2)}</dd>
                  <dt className="text-ink-400">Perspective corr.</dt><dd>{draft?.rectification.projective ? "on" : "off"}</dd>
                  <dt className="text-ink-400">Hub offset</dt><dd>{quality.centreOffset === null ? "–" : `${(quality.centreOffset * 100).toFixed(1)}%`}</dd>
                  <dt className="text-ink-400">Frame coverage</dt><dd>{(quality.frameCoverage * 100).toFixed(1)}%</dd>
                </dl>
                {quality.warnings.map((w) => (
                  <div key={w} className="rounded border border-warn/40 bg-warn/10 p-2 text-xs text-warn">{w}</div>
                ))}
                {saved ? (
                  <div className="space-y-2">
                    <div className="text-accent">Saved on this device.</div>
                    <Link href="/live-analysis" className="btn-primary w-full">Go to live tracking →</Link>
                  </div>
                ) : (
                  <button className="btn-primary w-full" onClick={() => void save()} disabled={!draft}>
                    Save calibration
                  </button>
                )}
              </>
            )}
            {step === "review" && !quality && <p className="text-bad">Calibration is incomplete: check the hub, rim (≥5 points) and zero pocket.</p>}
            {hint && step !== "review" && <p className="text-xs text-ink-400">{hint}</p>}
          </div>

          {step !== "review" && (
            <div className="mt-4 flex justify-between">
              <button className="btn-ghost" disabled={idx === 0} onClick={() => setStep(STEPS[idx - 1]!.id)}>Back</button>
              <button className="btn-primary" disabled={!canNext} onClick={() => { setHint(null); setStep(STEPS[idx + 1]!.id); }}>Next</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Slider({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="block space-y-1">
      <div className="flex justify-between text-xs text-ink-300">
        <span>{label}</span>
        <span className="num">{value.toFixed(3)}</span>
      </div>
      <input type="range" className="w-full accent-[var(--color-accent)]" min={min} max={max} step={0.002} value={value}
        onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

/** Keeps a synthetic source animating while it is shown live (before capture). */
function LiveSynthetic({ source }: { source: unknown }) {
  useEffect(() => {
    if (!(source instanceof SyntheticFrameSource)) return;
    source.start(() => undefined);
    return () => source.stop();
  }, [source]);
  return null;
}
