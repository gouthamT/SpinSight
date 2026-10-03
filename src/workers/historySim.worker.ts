/** Runs the history-based estimator (physics Monte Carlo + model averaging) off the main thread. */
import type { HistoryWorkerRequest, HistoryWorkerResponse } from "@/types/history";
import { predictFromHistory } from "@/engine/history/historyPredictor";

interface WorkerScope {
  postMessage(msg: HistoryWorkerResponse): void;
  onmessage: ((e: MessageEvent<HistoryWorkerRequest>) => void) | null;
}
const ctx = self as unknown as WorkerScope;

ctx.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === "run") {
      ctx.postMessage({ type: "result", prediction: predictFromHistory(msg.values, msg.settings, msg.seed) });
    }
  } catch (err) {
    ctx.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
