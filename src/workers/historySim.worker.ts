/**
 * Runs the history-based estimator off the main thread:
 *  1. statistical models + physics-release kernel (fast) → "result"
 *  2. engine views (kinematic, Matter.js, Rapier.js), streamed as they finish → "engine"
 * A newer run cancels an older one (runId).
 */
import type { HistoryWorkerRequest, HistoryWorkerResponse } from "@/types/history";
import { predictFromHistory } from "@/engine/history/historyPredictor";
import { engineView } from "@/engine/history/engineRelease";

interface WorkerScope {
  postMessage(msg: HistoryWorkerResponse): void;
  onmessage: ((e: MessageEvent<HistoryWorkerRequest>) => void) | null;
}
const ctx = self as unknown as WorkerScope;
let current = 0;

ctx.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type !== "run") return;
  current = msg.runId;
  const runId = msg.runId;
  try {
    ctx.postMessage({ type: "result", prediction: predictFromHistory(msg.values, msg.settings, msg.seed), runId });
    for (const engine of ["kinematic", "matter", "rapier"] as const) {
      if (current !== runId) return;
      const view = await engineView(engine, msg.values, msg.settings, msg.seed, (done, total) => {
        if (done % 10 === 0 || done === total) ctx.postMessage({ type: "engine-progress", engine, done, total, runId });
      }, () => current !== runId);
      if (current !== runId) return;
      ctx.postMessage({ type: "engine", view, runId });
    }
  } catch (err) {
    ctx.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err), runId });
  }
};
