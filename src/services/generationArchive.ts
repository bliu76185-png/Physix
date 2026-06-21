import type { DSLGenerationResult } from "./dslGenerator";

export interface ArchiveGenerationPayload {
  problem: string;
  result: DSLGenerationResult;
  imageName?: string;
}

export interface ArchiveGenerationResult {
  ok: boolean;
  dir?: string;
  error?: string;
}

export async function archiveGeneration(payload: ArchiveGenerationPayload): Promise<ArchiveGenerationResult> {
  try {
    const response = await fetch("/api/ai-generation-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await response.json().catch(() => ({}))) as ArchiveGenerationResult;
    if (!response.ok) {
      return { ok: false, error: data.error ?? `Archive API failed with HTTP ${response.status}` };
    }
    return data;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Archive API unavailable",
    };
  }
}
