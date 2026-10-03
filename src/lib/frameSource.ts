"use client";
import type { TimeSource } from "@/types/roulette";
import {
  DEFAULT_CAMERA, DEFAULT_SPIN, SyntheticSpin, renderWheel, type SyntheticCamera,
} from "@/engine/synthetic/syntheticWheel";

export interface FrameMeta {
  seq: number;
  /** Monotonic ms for kinematics. */
  t: number;
  timeSource: TimeSource;
  receivedAt: number;
}

export type FrameHandler = (source: CanvasImageSource, meta: FrameMeta) => void;

export interface FrameSource {
  readonly kind: "camera" | "file" | "synthetic";
  readonly element: HTMLVideoElement | HTMLCanvasElement;
  width(): number;
  height(): number;
  start(onFrame: FrameHandler): void;
  stop(): void;
}

type VideoFrameMeta = { mediaTime: number; presentedFrames: number; captureTime?: number };
type RVFC = (cb: (now: number, meta: VideoFrameMeta) => void) => number;

/**
 * Video element source. Prefers requestVideoFrameCallback so each callback
 * corresponds to a distinct decoded frame with its own timestamp:
 *   file   → mediaTime (the video's own clock: true physical time even when
 *            played back slowly)
 *   camera → captureTime when the browser provides it, else performance.now().
 */
export class VideoFrameSource implements FrameSource {
  private running = false;
  private seq = 0;
  private handle = 0;

  constructor(
    readonly kind: "camera" | "file",
    readonly element: HTMLVideoElement,
  ) {}

  width() {
    return this.element.videoWidth;
  }
  height() {
    return this.element.videoHeight;
  }

  start(onFrame: FrameHandler): void {
    this.running = true;
    const v = this.element;
    const rvfc = (v as unknown as { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback?.bind(v);
    if (rvfc) {
      const loop = (now: number, meta: VideoFrameMeta) => {
        if (!this.running) return;
        const receivedAt = performance.now();
        let t: number;
        let timeSource: TimeSource;
        if (this.kind === "file") {
          t = meta.mediaTime * 1000;
          timeSource = "media-time";
        } else if (typeof meta.captureTime === "number" && meta.captureTime > 0) {
          t = meta.captureTime;
          timeSource = "capture-time";
        } else {
          t = now;
          timeSource = "performance-now";
        }
        onFrame(v, { seq: this.seq++, t, timeSource, receivedAt });
        this.handle = rvfc(loop);
      };
      this.handle = rvfc(loop);
    } else {
      // Fallback: poll on animation frames and emit when the media time advances.
      let lastTime = -1;
      const loop = () => {
        if (!this.running) return;
        const ct = v.currentTime;
        if (ct !== lastTime && v.readyState >= 2) {
          lastTime = ct;
          const receivedAt = performance.now();
          const file = this.kind === "file";
          onFrame(v, {
            seq: this.seq++,
            t: file ? ct * 1000 : receivedAt,
            timeSource: file ? "media-time" : "performance-now",
            receivedAt,
          });
        }
        this.handle = requestAnimationFrame(loop);
      };
      this.handle = requestAnimationFrame(loop);
    }
  }

  stop(): void {
    this.running = false;
    const v = this.element as unknown as { cancelVideoFrameCallback?: (h: number) => void };
    v.cancelVideoFrameCallback?.(this.handle);
    cancelAnimationFrame(this.handle);
  }
}

/**
 * Software-rendered wheel with known ground truth. Simulation time advances
 * at `speed` × real time, capped to `fps` frames per simulated second.
 */
export class SyntheticFrameSource implements FrameSource {
  readonly kind = "synthetic" as const;
  readonly element: HTMLCanvasElement;
  private running = false;
  private seq = 0;
  private raf = 0;
  private simMs = 0;
  private lastWall = 0;
  private readonly g: CanvasRenderingContext2D;
  private readonly img: ImageData;
  spin: SyntheticSpin;

  constructor(
    readonly camera: SyntheticCamera = DEFAULT_CAMERA,
    seed = Math.floor(Math.random() * 1e9),
    public speed = 1,
    public fps = 60,
  ) {
    this.element = document.createElement("canvas");
    this.element.width = camera.width;
    this.element.height = camera.height;
    this.g = this.element.getContext("2d")!;
    this.img = this.g.createImageData(camera.width, camera.height);
    this.spin = new SyntheticSpin({ ...DEFAULT_SPIN, seed, ballTheta0: (seed % 628) / 100 });
    this.renderAt(0);
  }

  width() {
    return this.camera.width;
  }
  height() {
    return this.camera.height;
  }

  get simTimeMs() {
    return this.simMs;
  }

  newSpin(seed = Math.floor(Math.random() * 1e9)): void {
    this.spin = new SyntheticSpin({ ...DEFAULT_SPIN, seed, ballTheta0: (seed % 628) / 100 });
    this.simMs = 0;
    this.renderAt(0);
  }

  renderAt(ms: number): void {
    renderWheel(this.camera, this.spin.params, this.spin.state(ms), this.img, { frameSeed: this.seq + 1 });
    this.g.putImageData(this.img, 0, 0);
  }

  start(onFrame: FrameHandler): void {
    this.running = true;
    this.lastWall = performance.now();
    let nextFrameSim = this.simMs;
    const loop = () => {
      if (!this.running) return;
      const now = performance.now();
      this.simMs += (now - this.lastWall) * this.speed;
      this.lastWall = now;
      if (this.simMs >= nextFrameSim) {
        const t = Math.round(this.simMs / (1000 / this.fps)) * (1000 / this.fps);
        nextFrameSim = t + 1000 / this.fps;
        this.renderAt(t);
        onFrame(this.element, { seq: this.seq++, t, timeSource: "synthetic", receivedAt: now });
      }
      if (this.simMs > this.spin.durationMs) this.simMs = this.spin.durationMs;
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}

/** Grab the current frame of any source as ImageData at native resolution. */
export function captureStill(source: FrameSource): ImageData {
  const w = source.width();
  const h = source.height();
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(source.element, 0, 0, w, h);
  return g.getImageData(0, 0, w, h);
}
