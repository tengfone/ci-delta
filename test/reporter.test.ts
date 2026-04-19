import { describe, expect, it } from "vitest";
import { buildReport } from "../src/core/report.js";
import { reportToJson } from "../src/reporters/json.js";
import { reportToMarkdown } from "../src/reporters/markdown.js";

describe("reportToMarkdown", () => {
  it("renders default no-change message", () => {
    const report = buildReport({
      provider: "github-actions",
      changedFiles: [],
      findings: [],
    });

    const markdown = reportToMarkdown(report);
    expect(markdown).toContain("## CI Delta Report");
    expect(markdown).toContain("No GitHub Actions workflow changes detected.");
  });
});

describe("reportToJson", () => {
  it("includes a stable schema version", () => {
    const report = buildReport({
      provider: "github-actions",
      changedFiles: [],
      findings: [],
    });

    const json = JSON.parse(reportToJson(report)) as Record<string, unknown>;
    expect(json.schemaVersion).toBe("ci-delta.report.v1");
    expect(json.provider).toBe("github-actions");
  });
});
