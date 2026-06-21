#!/usr/bin/env node

import { readFileSync, writeFileSync } from "fs";
import type { DeepSeekConfig } from "./deepseekClient";
import { formatDSL, generateDSL } from "./dslGenerator";

async function main() {
  const args = process.argv.slice(2);
  let problem: string;

  if (args.length === 0) {
    console.error("Usage: npx tsx src/services/cli.ts <physics problem>");
    console.error("       npx tsx src/services/cli.ts --file <problem file path>");
    console.error("");
    console.error("Environment variables:");
    console.error("  DEEPSEEK_API_KEY   DeepSeek API key");
    console.error("  DEEPSEEK_MODEL     Model name, defaults to deepseek-chat");
    process.exit(1);
  }

  if (args[0] === "--file" && args[1]) {
    problem = readFileSync(args[1], "utf-8").trim();
  } else {
    problem = args.join(" ");
  }

  if (!problem) {
    console.error("Error: problem text is empty.");
    process.exit(1);
  }

  const apiConfig: DeepSeekConfig = {
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
  };

  console.log("Generating DSL...");
  console.log(`Problem: ${problem.slice(0, 80)}${problem.length > 80 ? "..." : ""}`);
  console.log("");

  const result = await generateDSL(problem, { apiConfig });
  if (!result.success) {
    console.error(`Generation failed: ${result.error}`);
    process.exit(1);
  }

  console.log("DSL generated.");
  console.log(
    `Token usage: ${result.usage?.totalTokens} (input ${result.usage?.promptTokens}, output ${result.usage?.completionTokens})`
  );
  console.log("");

  const output = formatDSL(result.dsl!);
  const outputPath = "generated-dsl.json";
  writeFileSync(outputPath, output, "utf-8");

  console.log(`Saved to: ${outputPath}`);
  console.log("");
  console.log("--- DSL preview (first 500 characters) ---");
  console.log(output.slice(0, 500));
  if (output.length > 500) console.log("... truncated");
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
