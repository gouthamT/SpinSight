"use client";
import type { SpinPhase, TrackingStats } from "@/types/roulette";
import type { TrackingSample } from "@/hooks/useTracking";
import { deg } from "@/engine/geometry/angles";
import { pocketLabel } from "@/engine/wheel/layout";

type Tone = "good" | "warn" | "bad" | "muted" | undefined;

function Row({ k, v, tone, hint }: { k: string; v: string; tone?: Tone; hint?: string }) {
  const c =
    tone === "good" ? "text-accent" : tone === "warn" ? "text-warn" : tone === "bad" ? "text-bad" : tone === "muted" ? "text-ink-400" : "text-ink-100";
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5" title={hint}>
      <span className="text-xs text-ink-400">{k}</span>
      <span className={`num text-sm ${c}`}>{v}</span>
    </div>
  );
}

const fin = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const fmt = (v: number | null | undefined, d = 2, suffix = "") => (fin(v) ? `${v.toFixed(d)}${suffix}` : "–");
const pm = (v: number | null | undefined, sd: number | null | undefined, d = 2, suffix = "") =>
  fin(v) ? `${v.toFixed(d)} ± ${fin(sd) ? sd.toFixed(d) : "?"}${suffix}` : "–";

const PHASE_LABEL: Record<SpinPhase, string> = {
  idle: "Waiting for launch",
  track: "Ball on track",
  descending: "Ball descending",
  bouncing: "Bouncing on rotor",
  settled: "Settled",
};

export function MeasurementPanel({ latest, stats }: { latest: TrackingSample | null; stats: TrackingStats | null }) {
  const m = latest?.m;
  const d = latest?.d;
  const mo = latest?.motion;
  const ballConf = m?.ball?.confidence ?? 0;
  const rotConf = m?.rotor?.confidence ?? 0;
  const ev = mo?.spin.events;
  const sec = (t: number | null | undefined) => (fin(t) && fin(ev?.launchT) ? `${((t - ev!.launchT!) / 1000).toFixed(2)} s` : "–");

  return (
    <div className="space-y-4">
      <section className="panel p-4">
        <div className="flex items-center justify-between">
          <div className="panel-title">Spin phase</div>
          <span className="num text-xs text-ink-400">spin #{ev?.spinId ?? 0}</span>
        </div>
        <div className={`mt-1 text-lg font-semibold ${mo?.spin.phase === "settled" ? "text-accent" : mo?.spin.phase === "idle" ? "text-ink-300" : "text-warn"}`}>
          {PHASE_LABEL[mo?.spin.phase ?? "idle"]}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-3">
          <Row k="Drop (observed)" v={sec(ev?.dropT)} />
          <Row k="Rotor contact" v={sec(ev?.rotorContactT)} />
          <Row k="Settled" v={sec(ev?.settleT)} />
          <Row k="Pocket" v={fin(ev?.settledPocket) ? pocketLabel(ev!.settledPocket!) : "–"} tone={fin(ev?.settledPocket) ? "good" : undefined} />
        </div>
        <p className="mt-2 text-[11px] text-ink-400">Times are from launch. The settled pocket is measured, not predicted.</p>
      </section>

      <section className="panel p-4">
        <div className="panel-title mb-2">Ball · measured &amp; filtered</div>
        <Row k="Detection" v={m?.ball?.phase ?? "not detected"} tone={m?.ball ? "good" : "warn"} />
        <Row k="Angle θ" v={fmt(m?.ball ? deg(m.ball.theta) : null, 1, "°")} />
        <Row k="Radius (rim = 1)" v={fmt(m?.ball?.r, 3)} />
        <Row k="ω (Kalman)" v={pm(mo?.ball?.omega, mo?.ball?.sdOmega, 2, " rad/s")} />
        <Row k="ω (raw window)" v={fmt(d?.ballOmegaRaw, 2, " rad/s")} tone="muted" />
        <Row k="α (Kalman)" v={pm(mo?.ball?.alpha, mo?.ball?.sdAlpha, 2, " rad/s²")} />
        <Row k="Speed" v={fmt(fin(mo?.ball?.omega) ? Math.abs(mo!.ball!.omega) / (2 * Math.PI) : null, 2, " rev/s")} />
        <Row k="Direction" v={fin(mo?.ball?.omega) ? (mo!.ball!.omega > 0 ? "counter-clockwise" : "clockwise") : "–"} />
        <Row k="Filter" v={`${mo?.ball?.status ?? "–"} · ${mo?.ball?.rejectedTotal ?? 0} rejected`} tone={mo?.ball?.status === "tracking" ? undefined : "warn"} />
        <Row k="Detection confidence" v={`${(ballConf * 100).toFixed(0)}% · SNR ${fmt(m?.ball?.snr, 0)}`} tone={ballConf > 0.6 ? "good" : ballConf > 0.25 ? "warn" : "bad"} />
      </section>

      <section className="panel p-4">
        <div className="panel-title mb-2">Ball deceleration fit</div>
        {mo?.ballFit ? (
          <>
            <Row k="a (friction)" v={pm(mo.ballFit.a, mo.ballFit.seA, 3, " rad/s²")} hint="Constant deceleration term" />
            <Row k="b (drag)" v={pm(mo.ballFit.b, mo.ballFit.seB, 4, " /rad")} hint="Quadratic (air-drag) term" />
            <Row k="ω₀ at fit start" v={fmt(mo.ballFit.omega0, 2, " rad/s")} />
            <Row k="Residual" v={fmt(mo.ballFit.rmsResidual * 180 / Math.PI, 2, "°")} />
            <Row k="Samples / span" v={`${mo.ballFit.n} / ${(mo.ballFit.spanMs / 1000).toFixed(1)} s`} />
            <Row k="Status" v={mo.ballFit.valid ? "well-determined" : "provisional"} tone={mo.ballFit.valid ? "good" : "warn"} />
          </>
        ) : (
          <p className="text-xs text-ink-400">Fits dω/dt = −(a + bω²) once the ball has circled the track for about 0.5 s.</p>
        )}
      </section>

      <section className="panel p-4">
        <div className="panel-title mb-2">Rotor</div>
        <Row k="Zero-pocket angle" v={fmt(m?.rotor ? deg(m.rotor.zeroAngle) : null, 1, "°")} />
        <Row k="ω (Kalman)" v={pm(mo?.rotor?.omega, mo?.rotor?.sdOmega, 3, " rad/s")} />
        <Row k="α (fit, last 6 s)" v={pm(mo?.rotorFit?.alpha, mo?.rotorFit?.seAlpha, 4, " rad/s²")} />
        <Row k="ω (raw window)" v={fmt(d?.rotorOmegaRaw, 3, " rad/s")} tone="muted" />
        <Row k="Template correlation" v={fmt(m?.rotor?.correlation, 2)} />
        <Row k="Confidence" v={`${(rotConf * 100).toFixed(0)}%`} tone={rotConf > 0.6 ? "good" : rotConf > 0.25 ? "warn" : "bad"} />
        <Row k="Pocket under ball" v={fin(d?.pocketUnderBall) ? pocketLabel(d!.pocketUnderBall!) : "–"} />
      </section>

      <section className="panel p-4">
        <div className="panel-title mb-2">Timing</div>
        <Row k="Effective FPS" v={fmt(stats?.effectiveFps, 1)} tone={stats && stats.effectiveFps >= 50 ? "good" : stats && stats.effectiveFps >= 25 ? "warn" : "bad"} />
        <Row k="Mean / max gap" v={`${fmt(stats?.meanGapMs, 1)} / ${fmt(stats?.maxGapMs, 1)} ms`} />
        <Row k="Vision / frame" v={fmt(stats?.meanProcessingMs, 1, " ms")} />
        <Row k="Frames processed" v={String(stats?.framesProcessed ?? 0)} />
        <Row k="Frames dropped" v={String(stats?.framesDropped ?? 0)} tone={stats && stats.framesDropped > 0 ? "warn" : undefined} />
        <Row k="Ball detection rate" v={`${((stats?.ballDetectionRate ?? 0) * 100).toFixed(0)}%`} />
        <Row k="Clock" v={m?.timeSource ?? "–"} />
      </section>

    </div>
  );
}
