import type { PhysicsGraph } from "../graph/types";
import { generateBox2DStateStream } from "./box2dStream";

type WorkerRequest =
  | { type: "generate"; graph: PhysicsGraph }
  | { type: "abort" };

let controller: AbortController | null = null;
const workerStartedAt = Date.now();

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  if (message.type === "abort") {
    controller?.abort();
    return;
  }

  controller?.abort();
  controller = new AbortController();

  try {
    self.postMessage({
      type: "progress",
      message: `Box2D worker received graph after ${Date.now() - workerStartedAt}ms. Preparing simulation...`,
    });
    const frames = await generateBox2DStateStream(message.graph, {
      signal: controller.signal,
      onProgress: (progressMessage) => {
        self.postMessage({ type: "progress", message: progressMessage });
      },
    });
    self.postMessage({ type: "result", frames });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      self.postMessage({ type: "aborted" });
      return;
    }
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
};
