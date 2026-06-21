import { examples } from "../examples";
import type { PhysicsGraph, ValidationError } from "../graph/types";
import { repairStableConstraintSpec } from "../graph/stableConstraintSpec";
import { generateDSL, repairDSL } from "../services/dslGenerator";

export interface GenerateGraphResult {
  graph: PhysicsGraph;
  source: "llm" | "rule";
  note: string;
}

export async function generateGraph(problemText: string): Promise<GenerateGraphResult> {
  try {
    const dslResult = await generateDSL(problemText);
    if (dslResult.success && dslResult.dsl) {
      const graph = repairStableConstraintSpec(
        structuredClone(dslResult.dsl as unknown as PhysicsGraph)
      );
      return {
        graph,
        source: "llm",
        note: `AI generation succeeded (${dslResult.usage?.totalTokens ?? "?"} tokens).`,
      };
    }
    console.warn("[generateGraph] LLM generation failed; falling back to local rules:", dslResult.error);
  } catch (error) {
    console.warn("[generateGraph] LLM call failed; falling back to local rules:", error);
  }

  const normalized = problemText.trim().toLowerCase();
  const graph = repairStableConstraintSpec(structuredClone(selectGraph(normalized)));
  return {
    graph,
    source: "rule",
    note: "LLM unavailable; used local rule matching. Configure an API key to enable AI generation.",
  };
}

export async function repairGraph(
  problemText: string,
  graphToRepair: unknown,
  errors: ValidationError[]
): Promise<GenerateGraphResult> {
  try {
    const dslResult = await repairDSL(problemText, graphToRepair as Record<string, unknown>, errors);
    if (dslResult.success && dslResult.dsl) {
      const graph = repairStableConstraintSpec(
        structuredClone(dslResult.dsl as unknown as PhysicsGraph)
      );
      return {
        graph,
        source: "llm",
        note: `AI repair succeeded (${dslResult.usage?.totalTokens ?? "?"} tokens).`,
      };
    }
  } catch (error) {
    console.warn("[repairGraph] LLM repair failed; falling back:", error);
  }

  return generateGraph(problemText);
}

function selectGraph(text: string): PhysicsGraph {
  if (text.includes("spring") || text.includes("oscillator")) {
    return examples.find((example) => example.id === "spring-oscillator")!.graph;
  }
  if (text.includes("collision") || text.includes("impact") || text.includes("bounce")) {
    return examples.find((example) => example.id === "two-ball-perfect-elastic-collision")!.graph;
  }
  return examples.find((example) => example.id === "free-fall")!.graph;
}
