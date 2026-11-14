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

  it("renders a GitLab no-change message", () => {
    const report = buildReport({
      provider: "gitlab-ci",
      changedFiles: [],
      findings: [],
    });

    expect(reportToMarkdown(report)).toContain(
      "No GitLab CI config changes detected.",
    );
  });
});

describe("reportToMarkdown changed files heading", () => {
  it("uses provider-specific wording", () => {
    const finding = {
      id: "image-changed",
      title: "Image changed",
      severity: "medium" as const,
      category: "runner" as const,
      file: ".gitlab-ci.yml",
      evidence: [],
    };
    const gitlab = reportToMarkdown(
      buildReport({
        provider: "gitlab-ci",
        changedFiles: [".gitlab-ci.yml"],
        findings: [finding],
      }),
    );
    expect(gitlab).toContain("Changed CI files:");
    expect(gitlab).not.toContain("Changed workflow files:");

    const github = reportToMarkdown(
      buildReport({
        provider: "github-actions",
        changedFiles: [".github/workflows/ci.yml"],
        findings: [],
      }),
    );
    expect(github).toContain("Changed workflow files:");
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
