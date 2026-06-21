/**
 * Batch AI DSL generation tester with smart retry (thinking ON for failures).
 * Usage: npx tsx scripts/batch-test.ts [--file problems.txt] [--concurrency 4] [--provider glm|deepseek|qwen|minimax] [--baseUrl url] [--model name] [--apikey key]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { generateDSL, type DSLGenerationResult, type StageUpdate } from "../src/services/dslGenerator";
import { validateGraph } from "../src/graph/validateGraph";
import { repairStableConstraintSpec } from "../src/graph/stableConstraintSpec";
import type { PhysicsGraph } from "../src/graph/types";

// ── Save successful DSLs ────────────────────────────────────────────
const GEN_DIR = path.resolve(process.cwd(), "examples", "generated");
fs.mkdirSync(GEN_DIR, { recursive: true });

function saveDSL(problem: string, dsl: unknown) {
  const slug = problem.slice(0, 30).replace(/[^a-z0-9一-龥]+/g, "-").slice(0, 40);
  const f = path.join(GEN_DIR, `gen-${slug}.json`);
  const obj = dsl as Record<string, unknown>;
  const d = { _title: problem.slice(0, 40), _prompt: problem, _generatedAt: new Date().toISOString(), ...obj };
  fs.writeFileSync(f, JSON.stringify(d, null, 2), "utf-8");
}

// ── Config ──────────────────────────────────────────────────────────
const PROVIDERS: Record<string, { baseUrl: string; model: string; envKey: string }> = {
  deepseek:  { baseUrl: "https://api.deepseek.com/v1",            model: "deepseek-v4-flash", envKey: "DEEPSEEK_API_KEY" },
  glm:       { baseUrl: "https://open.bigmodel.cn/api/paas/v4",   model: "glm-5.2",           envKey: "GLM_API_KEY" },
  qwen:      { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-max", envKey: "QWEN_API_KEY" },
  minimax:   { baseUrl: "https://api.minimax.chat/v1",            model: "minimax-m3",        envKey: "MINIMAX_API_KEY" },
};

const args = process.argv.slice(2);
const getArg = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : ""; };
const scriptDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/+/, ""));
const inputFile = getArg("--file") || path.join(scriptDir, "problems.txt");
const concurrency = Math.max(1, Number(getArg("--concurrency") || 4));
const providerName = (getArg("--provider") || "deepseek").toLowerCase();
const customBaseUrl = getArg("--baseUrl");
const customModel = getArg("--model");
const apiKey = getArg("--apikey");

const provider = PROVIDERS[providerName] ?? PROVIDERS.deepseek;
const finalBaseUrl = customBaseUrl || provider.baseUrl;
const finalModel = customModel || provider.model;
const finalApiKey = apiKey || process.env[provider.envKey] || process.env.GENERIC_API_KEY || "";
if (!finalApiKey) { console.error(`❌ API key required. Set ${provider.envKey} or pass --apikey.`); process.exit(1); }

console.log(`🔑 Provider: ${providerName} (${finalModel} @ ${finalBaseUrl})`);

// ── Types ───────────────────────────────────────────────────────────
interface BatchResult {
  index: number; problem: string; success: boolean; error?: string;
  stageLog: StageUpdate[]; tokens?: { prompt: number; completion: number; total: number }; elapsedMs: number;
}
function pad(s: string, len: number) { return s + " ".repeat(Math.max(0, len - s.length)); }
function icon(ok: boolean) { return ok ? "✅" : "❌"; }
function printResult(r: BatchResult) {
  const short = r.problem.length > 40 ? r.problem.slice(0, 38) + "…" : r.problem;
  const stages = r.stageLog.map((s: any) => `${s.status === "completed" ? "✓" : s.status === "started" ? "⏳" : "✗"}${s.stage}`).join("→");
  const tok = r.tokens ? ` | ${r.tokens.total}t` : "";
  console.log(`  ${icon(r.success)} ${pad(short, 42)} ${stages}${tok} | ${(r.elapsedMs / 1000).toFixed(1)}s`);
}

// ── Core ────────────────────────────────────────────────────────────
async function runPass(problems: string[], label: string, disableThinking: boolean, conc: number): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  for (let i = 0; i < problems.length; i += conc) {
    const batch = problems.slice(i, i + conc).map(p => ({ problem: p }));
    const batchResults = await Promise.all(batch.map(async ({ problem }) => {
      const started = Date.now();
      const log: StageUpdate[] = [];
      try {
        const r = await generateDSL(problem, {
          apiConfig: { apiKey: finalApiKey, baseUrl: finalBaseUrl, model: finalModel, timeout: 180_000, maxRetries: 2, disableThinking },
          staged: true, onStageUpdate: (u) => log.push(u),
        });
        const elapsed = Date.now() - started;
        let ok = r.success && !!r.dsl;
        let err = r.error;
        if (ok && r.dsl) {
          try {
            const g = repairStableConstraintSpec(structuredClone(r.dsl as unknown as PhysicsGraph));
            const v = validateGraph(g);
            if (!v.valid) { ok = false; err = v.errors.map(e => `${e.path}: ${e.message}`).join("; "); }
            else { saveDSL(problem, g); }
          } catch (e) { ok = false; err = e instanceof Error ? e.message : String(e); }
        }
        return { problem, success: ok, error: err, stageLog: log, tokens: r.usage ? { prompt: r.usage.promptTokens, completion: r.usage.completionTokens, total: r.usage.totalTokens } : undefined, elapsedMs: elapsed, index: 0 } as BatchResult;
      } catch (e) {
        return { problem, success: false, error: e instanceof Error ? e.message : String(e), stageLog: log, elapsedMs: Date.now() - started, index: 0 } as BatchResult;
      }
    }));
    for (const r of batchResults) { results.push(r); printResult(r); }
  }
  return results;
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const allProblems = fs.readFileSync(inputFile, "utf-8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (!allProblems.length) { console.error("❌ No problems found."); process.exit(1); }
  console.log(`📋 ${allProblems.length} problems | ⚡ Concurrency: ${concurrency}\n`);

  // Pass 1: thinking OFF
  console.log(`🚀 Pass 1 — Thinking OFF\n`);
  const p1 = await runPass(allProblems, "P1", true, concurrency);
  const p1ok = p1.filter(r => r.success).length;
  console.log(`\n   Pass 1: ${p1ok}/${p1.length} (${(p1ok/p1.length*100).toFixed(0)}%)\n`);

  // Pass 2: thinking ON for failures
  const failed = p1.filter(r => !r.success);
  let p2results: BatchResult[] = [];
  if (failed.length > 0) {
    console.log(`🧠 Pass 2 — Thinking ON (${failed.length} failed)\n`);
    p2results = await runPass(failed.map(r => r.problem), "P2", false, Math.min(2, concurrency));
    const recovered = p2results.filter(r => r.success).length;
    console.log(`\n   Pass 2 recovered: ${recovered}/${failed.length}\n`);
  }

  // Merge
  const final: BatchResult[] = [];
  let idx = 0;
  for (const r of p1) {
    idx++;
    if (r.success) { final.push({ ...r, index: idx }); }
    else {
      const rec = p2results.find(p => p.problem === r.problem);
      final.push({ ...(rec?.success ? rec : r), index: idx });
    }
  }

  const passed = final.filter(r => r.success);
  const totalTokens = final.reduce((s, r) => s + (r.tokens?.total ?? 0), 0);
  const totalTime = final.reduce((s, r) => s + r.elapsedMs, 0);
  console.log(`${"═".repeat(70)}`);
  console.log(`📊 FINAL: ${passed.length}/${final.length} (${(passed.length/final.length*100).toFixed(0)}%) | P1: ${p1ok} P2 recovered: ${p2results.filter(r=>r.success).length} | ${totalTokens}t ${(totalTime/1000).toFixed(0)}s`);
  if (final.some(r => !r.success)) {
    console.log(`\n❌ Still failed:`);
    for (const r of final.filter(r => !r.success)) console.log(`   [${r.index}] ${r.problem.slice(0,60)}\n       → ${r.error}`);
  }
  fs.writeFileSync(path.join(scriptDir, "batch-report.json"), JSON.stringify({ timestamp: new Date().toISOString(), total: final.length, passed: passed.length, p1Passed: p1ok, p2Recovered: p2results.filter(r=>r.success).length, totalTokens, totalMs: totalTime, results: final.map(r => ({ index: r.index, problem: r.problem, success: r.success, error: r.error, stageLog: r.stageLog.map(s=>({stage:s.stage,status:s.status})), tokens: r.tokens, elapsedMs: r.elapsedMs })) }, null, 2), "utf-8");
  console.log(`📄 Report saved`);
}
main().catch(e => { console.error("Fatal:", e); process.exit(1); });
