"use client";
import { useEffect, useRef } from "react";
import type { FrameSource } from "@/lib/frameSource";

/**
 * Mounts the source's media element and an overlay canvas sized to the native
 * frame, so overlays are drawn in native pixel coordinates and scale with CSS.
 */
export function SourceView({
  source,
  overlayRef,
  onOverlayPointer,
  onOverlayMove,
  cursor = "default",
}: {
  source: FrameSource;
  overlayRef: React.RefObject<HTMLCanvasElement | null>;
  onOverlayPointer?: (p: { x: number; y: number }) => void;
  onOverlayMove?: (p: { x: number; y: number } | null) => void;
  cursor?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const w = source.width() || 1280;
  const h = source.height() || 720;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const el = source.element;
    el.className = "absolute inset-0 h-full w-full object-contain";
    host.prepend(el);
    if (el instanceof HTMLVideoElement && el.paused) void el.play().catch(() => undefined);
    return () => {
      if (el.parentElement === host) host.removeChild(el);
    };
  }, [source]);

  const toNative = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * w, y: ((e.clientY - r.top) / r.height) * h };
  };

  return (
    <div ref={hostRef} className="relative w-full overflow-hidden rounded-lg bg-black" style={{ aspectRatio: `${w} / ${h}` }}>
      <canvas
        ref={overlayRef}
        width={w}
        height={h}
        className="absolute inset-0 h-full w-full"
        style={{ cursor, touchAction: "none" }}
        onPointerDown={onOverlayPointer ? (e) => onOverlayPointer(toNative(e)) : undefined}
        onPointerMove={onOverlayMove ? (e) => onOverlayMove(toNative(e)) : undefined}
        onPointerLeave={onOverlayMove ? () => onOverlayMove(null) : undefined}
      />
    </div>
  );
}
