"use client";
import { useEffect, useRef } from "react";

export interface Series {
  label: string;
  color: string;
  points: { t: number; v: number | null }[];
}

/** Lightweight canvas time-series plot (no dependencies, redraws on data change). */
export function MotionGraph({ series, windowMs = 8000, unit, height = 160 }: { series: Series[]; windowMs?: number; unit: string; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth;
    const H = height;
    c.width = W * dpr;
    c.height = H * dpr;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const all = series.flatMap((s) => s.points);
    const tMax = all.length ? Math.max(...all.map((p) => p.t)) : windowMs;
    const tMin = tMax - windowMs;
    const vals = all.filter((p) => p.t >= tMin && p.v !== null).map((p) => p.v!);
    let vMin = vals.length ? Math.min(...vals, 0) : -1;
    let vMax = vals.length ? Math.max(...vals, 0) : 1;
    if (vMax - vMin < 1e-6) { vMax += 1; vMin -= 1; }
    const pad = (vMax - vMin) * 0.1;
    vMin -= pad; vMax += pad;
    const L = 44, R = 8, T = 8, B = 18;
    const x = (t: number) => L + ((t - tMin) / windowMs) * (W - L - R);
    const y = (v: number) => T + (1 - (v - vMin) / (vMax - vMin)) * (H - T - B);

    g.strokeStyle = "#1f2734";
    g.fillStyle = "#6b778a";
    g.font = "10px ui-monospace, monospace";
    g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const v = vMin + ((vMax - vMin) * i) / 4;
      g.beginPath(); g.moveTo(L, y(v)); g.lineTo(W - R, y(v)); g.stroke();
      g.fillText(v.toFixed(1), 4, y(v) + 3);
    }
    g.fillText(`${unit} · last ${(windowMs / 1000).toFixed(0)} s`, L, H - 4);
    if (vMin < 0 && vMax > 0) {
      g.strokeStyle = "#2c3646";
      g.beginPath(); g.moveTo(L, y(0)); g.lineTo(W - R, y(0)); g.stroke();
    }
    for (const s of series) {
      g.strokeStyle = s.color;
      g.lineWidth = 1.5;
      g.beginPath();
      let pen = false;
      for (const p of s.points) {
        if (p.t < tMin || p.v === null) { pen = false; continue; }
        if (!pen) { g.moveTo(x(p.t), y(p.v)); pen = true; } else g.lineTo(x(p.t), y(p.v));
      }
      g.stroke();
    }
  }, [series, windowMs, unit, height]);

  return (
    <div>
      <div className="mb-1 flex gap-3 text-[11px]">
        {series.map((s) => (
          <span key={s.label} className="flex items-center gap-1 text-ink-300">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <canvas ref={ref} className="w-full" style={{ height }} />
    </div>
  );
}
