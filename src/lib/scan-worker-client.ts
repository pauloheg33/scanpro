import { type Remote, wrap } from "comlink";
import type { ScanWorkerApi } from "../workers/scanWorker";

let workerApiPromise: Promise<Remote<ScanWorkerApi>> | null = null;

export function getScanWorker() {
  if (!workerApiPromise) {
    const worker = new Worker(new URL("../workers/scanWorker.ts", import.meta.url), {
      type: "module"
    });
    workerApiPromise = Promise.resolve(wrap<ScanWorkerApi>(worker));
  }
  return workerApiPromise;
}
