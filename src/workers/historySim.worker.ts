/** Statistical models + quick physics kernel (memoised) for the results dashboard. */
import type { HistoryWorkerRequest, HistoryWorkerResponse } from "@/types/history";
import { predictFromHistory } from "@/engine/history/historyPredictor";

interface WorkerScope {
  postMessage(msg: HistoryWorkerResponse): void;
  onmessage: ((e: MessageEvent<HistoryWorkerRequest>) => void) | null;
}
const ctx = self as unknown as WorkerScope;

ctx.onmessage = (e) => {
  const msg = e.data;
  if (msg.type !== "run") return;
  try {
    ctx.postMessage({ type: "result", prediction: predictFromHistory(msg.values, msg.settings, msg.seed), runId: msg.runId });
  } catch (err) {
    ctx.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err), runId: msg.runId });
  }
};
