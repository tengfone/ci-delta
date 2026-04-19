import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { minimatch } from "minimatch";
import { compareSources } from "../src/core/engine.js";
import type { FileSnapshot, FileSource, Severity } from "../src/core/types.js";
import { GitHubActionsAdapter } from "../src/providers/github-actions/adapter.js";
import { reportToMarkdown } from "../src/reporters/markdown.js";

interface ExpectedFixture {
  changedFiles: string[];
  maxSeverity: Severity | "none";
  findings: Array<{
    id: string;
    severity: Severity;
    job?: string;
  }>;
}

const fixturesRoot = path.join(process.cwd(), "fixtures", "github-actions");

describe("GitHub Actions golden fixtures", async () => {
  const fixtureNames = (await fs.readdir(fixturesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const fixtureName of fixtureNames) {
    it(`matches ${fixtureName}`, async () => {
      const fixtureRoot = path.join(fixturesRoot, fixtureName);
      const expected = JSON.parse(
        await fs.readFile(path.join(fixtureRoot, "expected.json"), "utf8"),
      ) as ExpectedFixture;
      const expectedMarkdown = await fs.readFile(
        path.join(fixtureRoot, "expected.md"),
        "utf8",
      );

      const adapter = new GitHubActionsAdapter();
      const report = await compareSources({
        provider: adapter,
        baseSource: new FixtureFileSource(path.join(fixtureRoot, "base")),
        headSource: new FixtureFileSource(path.join(fixtureRoot, "head")),
        baseRef: "base",
        headRef: "head",
      });

      expect(report.changedFiles).toEqual(expected.changedFiles);
      expect(report.maxSeverity).toBe(expected.maxSeverity);
      expect(
        report.findings.map((finding) => ({
          id: finding.id,
          severity: finding.severity,
          ...(finding.job ? { job: finding.job } : {}),
        })),
      ).toEqual(expected.findings);

      const markdown = reportToMarkdown(report);
      for (const line of expectedMarkdown
        .split("\n")
        .map((entry) => entry.trim())
        .filter(Boolean)) {
        expect(markdown).toContain(line);
      }
    });
  }
});

class FixtureFileSource implements FileSource {
  public constructor(private readonly root: string) {}

  public async listFiles(globs: string[]): Promise<FileSnapshot[]> {
    const paths = await listRelativeFiles(this.root);
    return Promise.all(
      paths
        .filter((filePath) => globs.some((glob) => minimatch(filePath, glob)))
        .map((filePath) => this.readFile(filePath)),
    ).then((snapshots) =>
      snapshots.filter(
        (snapshot): snapshot is FileSnapshot => snapshot !== null,
      ),
    );
  }

  public async readFile(filePath: string): Promise<FileSnapshot | null> {
    try {
      return {
        path: filePath,
        content: await fs.readFile(path.join(this.root, filePath), "utf8"),
      };
    } catch {
      return null;
    }
  }
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  await visit(root, "");
  return results.sort();

  async function visit(
    absoluteDir: string,
    relativeDir: string,
  ): Promise<void> {
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(absoluteDir, entry.name);

      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        results.push(relativePath);
      }
    }
  }
}
