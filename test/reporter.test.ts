import { describe, expect, it } from "vitest";
import { buildReport } from "../src/core/report.js";
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
