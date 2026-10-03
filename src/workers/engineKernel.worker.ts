/**
 * One engine's offset kernel (kinematic, Rapier.js or Matter.js). The page runs
 * one of these workers per engine, in parallel, in the background whenever the
 * settings change; guesses then read the cached kernel instantly.
 */
import type { KernelWorkerRequest, KernelWorkerResponse } from "@/types/history";
import { engineKernel } from "@/engine/history/engineRelease";

interface WorkerScope {
  postMessage(msg: KernelWorkerResponse): void;
  onmessage: ((e: MessageEvent<KernelWorkerRequest>) => void) | null;
}
const ctx = self as unknown as WorkerScope;
let current = 0;

ctx.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type !== "kernel") return;
  current = msg.jobId;
  const jobId = msg.jobId;
  try {
    const kernel = await engineKernel(
      msg.engine,
      msg.settings,
      msg.seed,
      (done, total) => {
        if (done % 10 === 0 || done === total) ctx.postMessage({ type: "progress", engine: msg.engine, done, total, jobId });
      },
      () => current !== jobId,
    );
    if (current === jobId) ctx.postMessage({ type: "kernel", kernel, jobId });
  } catch (err) {
    ctx.postMessage({ type: "error", engine: msg.engine, message: err instanceof Error ? err.message : String(err), jobId });
  }
};
