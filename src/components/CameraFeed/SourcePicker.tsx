"use client";
import type { useFrameSource } from "@/hooks/useFrameSource";

type Src = ReturnType<typeof useFrameSource>;

export function SourcePicker({ src, compact = false }: { src: Src; compact?: boolean }) {
  return (
    <div className="space-y-3">
      <div className={`grid gap-2 ${compact ? "grid-cols-3" : "sm:grid-cols-3"}`}>
        <button className="btn-ghost" disabled={src.busy} onClick={() => void src.startCamera()}>
          Camera
        </button>
        <label className="btn-ghost cursor-pointer">
          Video file
          <input
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void src.startFile(f);
              e.target.value = "";
            }}
          />
        </label>
        <button className="btn-ghost" onClick={src.startSynthetic}>
          Synthetic wheel
        </button>
      </div>
      {src.kind === "camera" && src.devices.length > 1 && (
        <select className="input" onChange={(e) => void src.startCamera(e.target.value)} defaultValue="">
          <option value="" disabled>
            Switch camera…
          </option>
          {src.devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      )}
      {src.error && <div className="rounded-lg border border-bad/40 bg-bad/10 p-3 text-sm text-bad">{src.error}</div>}
    </div>
  );
}
