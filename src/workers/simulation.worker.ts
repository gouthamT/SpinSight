/** Runs Simulation Lab engines off the main thread. */
import type { BatchSummary, SimWorkerRequest, SimWorkerResponse } from "@/types/simulation";
import { engineDisagreement, runBatch, runEngine } from "@/engine/physics/simulationAdapter";

interface WorkerScope {
  postMessage(msg: SimWorkerResponse): void;
  onmessage: ((e: MessageEvent<SimWorkerRequest>) => void) | null;
}
const ctx = self as unknown as WorkerScope;

ctx.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "single") {
      const results = [];
      for (const engine of msg.engines) results.push(await runEngine(engine, msg.params));
      ctx.postMessage({ type: "single", results });
    } else {
      const summaries: BatchSummary[] = [];
      for (const engine of msg.engines) {
        summaries.push(
          await runBatch(engine, msg.params, msg.runs, msg.seed, (done) => {
            if (done % 5 === 0 || done === msg.runs) ctx.postMessage({ type: "progress", engine, done, total: msg.runs });
          }),
        );
      }
      ctx.postMessage({ type: "batch", summaries, disagreement: engineDisagreement(summaries) });
    }
  } catch (err) {
    ctx.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
