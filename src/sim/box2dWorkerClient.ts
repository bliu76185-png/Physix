import type { PhysicsGraph, StateFrame } from "../graph/types";

export interface Box2DWorkerOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

type WorkerResponse =
  | { type: "progress"; message: string }
  | { type: "result"; frames: StateFrame[] }
  | { type: "error"; message: string; stack?: string }
  | { type: "aborted" };

export function generateBox2DStateStreamInWorker(
  graph: PhysicsGraph,
  options: Box2DWorkerOptions = {}
): Promise<StateFrame[]> {
  const startedAt = Date.now();
  const worker = new Worker(new URL("./box2dWorker.ts", import.meta.url), { type: "module" });

  return new Promise((resolve, reject) => {
    let settled = false;

    const abort = () => {
      if (settled) return;
      settled = true;
      worker.postMessage({ type: "abort" });
      worker.terminate();
      reject(createAbortError());
    };

    const cleanup = () => {
      options.signal?.removeEventListener("abort", abort);
      worker.terminate();
    };

    options.signal?.addEventListener("abort", abort, { once: true });

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;

      if (message.type === "progress") {
        options.onProgress?.(message.message);
        return;
      }

      if (message.type === "aborted") {
        if (settled) return;
        settled = true;
        cleanup();
        reject(createAbortError());
        return;
      }

      if (message.type === "error") {
        if (settled) return;
        settled = true;
        cleanup();
        const error = new Error(message.message);
        if (message.stack) error.stack = message.stack;
        reject(error);
        return;
      }

      if (settled) return;
      settled = true;
      cleanup();
      resolve(message.frames);
    };

    worker.onerror = (event) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(event.message || "Box2D worker failed."));
    };

    options.onProgress?.(`Box2D worker constructed in ${Date.now() - startedAt}ms. Sending graph...`);
    worker.postMessage({ type: "generate", graph });
  });
}

function createAbortError(): Error {
  const error = new Error("Box2D simulation cancelled.");
  error.name = "AbortError";
  return error;
}
