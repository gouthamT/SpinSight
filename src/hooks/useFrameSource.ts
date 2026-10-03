"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { SyntheticFrameSource, VideoFrameSource, type FrameSource } from "@/lib/frameSource";

export type SourceKind = "camera" | "file" | "synthetic";

export interface CameraDevice {
  deviceId: string;
  label: string;
}

function describeCameraError(err: unknown): string {
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "Camera needs a secure connection (https:// or localhost).";
  }
  const name = err instanceof DOMException ? err.name : "";
  switch (name) {
    case "NotAllowedError":
      return "Camera permission was denied. Allow camera access in your browser's site settings, then try again.";
    case "NotFoundError":
      return "No camera was found on this device.";
    case "NotReadableError":
      return "The camera is in use by another app or tab.";
    case "OverconstrainedError":
      return "The selected camera can't provide the requested resolution.";
    default:
      return err instanceof Error ? err.message : "Could not start the camera.";
  }
}

/**
 * Owns the current frame source (camera stream, uploaded video or synthetic
 * wheel) and its underlying media element.
 */
export function useFrameSource() {
  const [source, setSource] = useState<FrameSource | null>(null);
  const [kind, setKind] = useState<SourceKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const urlRef = useRef<string | null>(null);

  const teardown = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const refreshDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(
        all
          .filter((d) => d.kind === "videoinput")
          .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` })),
      );
    } catch {
      /* ignore */
    }
  }, []);

  const startCamera = useCallback(
    async (deviceId?: string) => {
      setBusy(true);
      setError(null);
      teardown();
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser does not support camera capture.");
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            facingMode: deviceId ? undefined : { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 60 },
          },
        });
        streamRef.current = stream;
        const v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.srcObject = stream;
        await v.play();
        await refreshDevices();
        setSource(new VideoFrameSource("camera", v));
        setKind("camera");
      } catch (err) {
        setError(describeCameraError(err));
        setSource(null);
        setKind(null);
      } finally {
        setBusy(false);
      }
    },
    [refreshDevices, teardown],
  );

  const startFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      teardown();
      try {
        const url = URL.createObjectURL(file);
        urlRef.current = url;
        const v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.src = url;
        v.loop = false;
        await new Promise<void>((res, rej) => {
          v.onloadeddata = () => res();
          v.onerror = () => rej(new Error("This video format can't be decoded by the browser."));
        });
        setSource(new VideoFrameSource("file", v));
        setKind("file");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [teardown],
  );

  const startSynthetic = useCallback(() => {
    teardown();
    setError(null);
    setSource(new SyntheticFrameSource());
    setKind("synthetic");
  }, [teardown]);

  const stop = useCallback(() => {
    source?.stop();
    teardown();
    setSource(null);
    setKind(null);
  }, [source, teardown]);

  return { source, kind, error, devices, busy, startCamera, startFile, startSynthetic, stop };
}
