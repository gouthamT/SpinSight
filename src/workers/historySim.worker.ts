/** Statistical models + quick physics kernel (memoised) for the results dashboard. */
import type { HistoryWorkerRequest, HistoryWorkerResponse } from "@/types/history";
import { predictFromHistory } from "@/engine/history/historyPredictor";
import { calibrateFromHistory } from "@/engine/history/calibrate";

interface WorkerScope {
  postMessage(msg: HistoryWorkerResponse): void;
  onmessage: ((e: MessageEvent<HistoryWorkerRequest>) => void) | null;
}
const ctx = self as unknown as WorkerScope;

ctx.onmessage = (e) => {
  const msg = e.data;
  if (msg.type !== "run") return;
  try {
    const s = msg.settings;
    if (s.autoCalibrate === false) {
      const prediction = { ...predictFromHistory(msg.values, s, msg.seed), calibration: null };
      ctx.postMessage({ type: "result", prediction, runId: msg.runId });
      return;
    }
    // Learn the physics from the history first, then predict with it as the base.
    const run = calibrateFromHistory(msg.values, s);
    const cal = run?.calibration ?? null;
    const applied = !!cal?.applied && !!cal.physics;
    const effective = applied ? { ...s, physics: cal!.physics! } : s;
    const prediction = {
      ...predictFromHistory(msg.values, effective, msg.seed, applied ? run : null),
      calibration: cal,
    };
    ctx.postMessage({ type: "result", prediction, runId: msg.runId });
  } catch (err) {
    ctx.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err), runId: msg.runId });
  }
};
