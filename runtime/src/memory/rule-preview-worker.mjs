// The rule step's history read, off the main thread (rule-preview.mjs startPreviewRead).
import { parentPort, workerData } from "node:worker_threads";
import { readPreviewCalls } from "./rule-preview.mjs";

try {
  const r = await readPreviewCalls({ cwd: workerData.cwd, env: workerData.env, home: workerData.home ?? undefined, now: workerData.now });
  parentPort.postMessage(r);
} catch {
  parentPort.postMessage(null);
}
