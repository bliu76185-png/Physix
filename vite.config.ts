import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export default defineConfig({
  plugins: [react(), aiGenerationArchivePlugin()],
  optimizeDeps: {
    exclude: ["box2d-wasm"],
  },
  worker: {
    format: "es",
  },
});

function aiGenerationArchivePlugin() {
  return {
    name: "ai-generation-archive",
    configureServer(server: { middlewares: { use: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void } }) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url === "/api/list-generated" && req.method === "GET") {
        try {
          const dir = path.resolve(process.cwd(), "examples", "generated");
          const files = await import("node:fs").then(m => m.promises.readdir(dir)).catch(() => [] as string[]);
          const items: { name: string; prompt: string }[] = [];
          for (const f of files) {
            if (!f.endsWith(".json")) continue;
            try {
              const raw = JSON.parse(await readFile(path.join(dir, f), "utf-8"));
              if (raw._prompt) items.push({ name: f.replace(".json",""), prompt: raw._prompt });
            } catch { /* skip */ }
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(items));
        } catch { res.statusCode = 500; res.end("[]"); }
        return;
      }

      if (req.url === "/api/problems" && req.method === "GET") {
        try {
          const p = path.resolve(process.cwd(), "scripts", "problems-100.txt");
          const text = await readFile(p, "utf-8").catch(() => "");
          const problems = text.split("\n").map((l: string) => l.trim()).filter((l: string) => l && !l.startsWith("#"));
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(problems));
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify("[]"));
        }
        return;
      }

      if (req.url === "/api/save-generated-example" && req.method === "POST") {
          try {
            const payload = await readJsonBody(req);
            if (!payload.dsl || typeof payload.dsl !== "object") {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: "Missing dsl object" }));
              return;
            }
            const problem = typeof payload.problem === "string" ? payload.problem : "generated";
            const result = await saveGeneratedExample(problem, payload.dsl as Record<string, unknown>);
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, ...result }));
          } catch (error) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : "Unknown save error",
            }));
          }
          return;
        }

        if (req.url !== "/api/ai-generation-records" || req.method !== "POST") {
          next();
          return;
        }

        try {
          const payload = await readJsonBody(req);
          const saved = await saveGenerationRecord(payload);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, ...saved }));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : "Unknown archive error",
          }));
        }
      });
    },
  };
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function saveGenerationRecord(payload: Record<string, unknown>) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const problem = typeof payload.problem === "string" ? payload.problem : "";
  const slug = slugify(problem.slice(0, 36)) || "ai-generation";
  const root = path.resolve(process.cwd(), "ai-generation-records");
  const dir = path.join(root, `${timestamp}-${slug}`);
  await mkdir(dir, { recursive: true });

  const result = isRecord(payload.result) ? payload.result : {};
  const stages = Array.isArray(result.stages) ? result.stages.filter(isRecord) : [];
  const analysis = stages.find((stage) => stage.name === "analysis")?.output;
  const draft = stages.find((stage) => stage.name === "dsl")?.output;

  await writeJson(path.join(dir, "request.json"), {
    savedAt: new Date().toISOString(),
    problem,
    imageName: payload.imageName ?? null,
  });
  await writeJson(path.join(dir, "result.json"), result);
  await writeJson(path.join(dir, "stages.json"), stages);
  await writeJson(path.join(dir, "analysis-ir.json"), analysis ?? null);
  await writeJson(path.join(dir, "dsl-draft.json"), draft ?? null);
  await writeJson(path.join(dir, "final-dsl.json"), result.dsl ?? null);
  await writeJson(path.join(dir, "diagnostics.json"), result.diagnostics ?? null);

  return { dir };
}

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function saveGeneratedExample(problem: string, dsl: Record<string, unknown>) {
  const slug = slugify(problem.slice(0, 36)) || "ai-generated";
  const fileName = `generated-${slug}.json`;
  const filePath = path.resolve(process.cwd(), "examples", "generated", fileName);

  // Derive a readable title from object labels
  const objects = Array.isArray(dsl.objects) ? dsl.objects as Array<Record<string, unknown>> : [];
  const title = objects.length > 0
    ? objects.map((obj) => (typeof obj.label === "string" ? obj.label : obj.id)).join("、")
    : (problem.slice(0, 20) || "AI Generated");

  // Prepend metadata for auto-indexing
  const dslWithTitle = { _title: title, _prompt: problem, _generatedAt: new Date().toISOString(), ...dsl };
  await writeJson(filePath, dslWithTitle);

  return { fileName, filePath };
}
