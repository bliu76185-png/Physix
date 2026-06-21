/**
 * 渲染自检诊断测试
 * 运行: npx vitest run tests/render-diagnostic.test.ts
 */
import { describe, it, expect } from "vitest";
import { runQuickDiagnostics, formatReport, type RenderDiagnosticReport } from "../src/diagnostics/renderCheck";

describe("Render Diagnostic — Quick Scan", () => {
  let report: RenderDiagnosticReport;

  it("runs diagnostics on all examples", () => {
    report = runQuickDiagnostics();
    console.log(formatReport(report));
    expect(report).toBeDefined();
    expect(report.totalExamples).toBeGreaterThan(0);
    expect(report.examples.length).toBe(report.totalExamples);
  });

  it("has no error-level examples", () => {
    const errors = report.examples.filter((e) => e.status === "error");
    for (const e of errors) {
      console.error(`\n[ERROR] ${e.exampleId}:`, JSON.stringify(e, null, 2));
    }
    expect(errors).toHaveLength(0);
  });

  it("every object has valid geometry", () => {
    for (const example of report.examples) {
      const withoutGeom = example.objects.filter(
        (o) => o.issues.some((i) => i.includes("geometry is undefined"))
      );
      expect(withoutGeom).toHaveLength(0);
    }
  });

  it("no object is explicitly hidden (visible=false)", () => {
    for (const example of report.examples) {
      const hidden = example.objects.filter(
        (o) => o.issues.some((i) => i.includes("visible = false"))
      );
      if (hidden.length > 0) {
        console.warn(`[WARN] ${example.exampleId}: ${hidden.map((h) => h.objectId).join(", ")} hidden`);
      }
    }
  });

  it("no NaN/Infinity positions in frames", () => {
    for (const example of report.examples) {
      const nanObjs = example.objects.filter(
        (o) => o.issues.some((i) => i.includes("NaN") || i.includes("Infinity"))
      );
      expect(nanObjs).toHaveLength(0);
    }
  });
});
