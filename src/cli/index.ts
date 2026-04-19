#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { buildReport } from "../core/report.js";
import { meetsThreshold } from "../core/severity.js";
import type { Severity } from "../core/types.js";
import { LocalGitFileSource } from "../file-sources/local-git.js";
import { GitHubActionsAdapter } from "../providers/github-actions/adapter.js";
import { reportToJson } from "../reporters/json.js";
import { reportToMarkdown } from "../reporters/markdown.js";

const providerAliases = new Set(["github-actions", "gha", "github"]);

async function run(): Promise<void> {
  const program = new Command();

  program
    .name("ci-delta")
    .description("Semantic diff reports for CI/CD config changes")
    .argument("<provider>", "Provider name (github-actions, gha, github)")
    .requiredOption("--base <ref>", "Base git ref")
    .requiredOption("--head <ref>", "Head git ref")
    .option("--format <format>", "markdown or json", "markdown")
    .option("--output <file>", "Write report to file")
    .option("--fail-on <severity>", "none|low|medium|high|critical", "none")
    .option("--repo-root <path>", "Repository root", process.cwd())
    .option("--include <glob>", "Additional include glob", collectIncludes, [])
    .option("--no-color", "Disable color output")
    .showHelpAfterError();

  program.parse(process.argv);

  const providerInput = program.args[0];
  if (!providerAliases.has(providerInput)) {
    program.error(`Unsupported provider: ${providerInput}`, { exitCode: 2 });
  }

  const options = program.opts<{
    base: string;
    head: string;
    format: "markdown" | "json";
    output?: string;
    failOn: Severity | "none";
    repoRoot: string;
    include: string[];
  }>();

  if (!["markdown", "json"].includes(options.format)) {
    program.error(`Invalid --format: ${options.format}`, { exitCode: 2 });
  }

  const adapter = new GitHubActionsAdapter();
  const globs = [...adapter.workflowGlobs, ...options.include];

  const baseSource = new LocalGitFileSource(
    path.resolve(options.repoRoot),
    options.base,
  );
  const headSource = new LocalGitFileSource(
    path.resolve(options.repoRoot),
    options.head,
  );

  const [baseFiles, headFiles] = await Promise.all([
    baseSource.listFiles(globs),
    headSource.listFiles(globs),
  ]);

  const baseSnapshot = await adapter.parse(baseFiles);
  const headSnapshot = await adapter.parse(headFiles);

  const findings = await adapter.diff(baseSnapshot, headSnapshot);
  const changedFiles = unique(
    [...baseFiles, ...headFiles].map((file) => file.path),
  );

  const report = buildReport({
    provider: adapter.id,
    baseRef: options.base,
    headRef: options.head,
    changedFiles,
    findings,
  });

  const rendered =
    options.format === "json" ? reportToJson(report) : reportToMarkdown(report);

  if (options.output) {
    await fs.writeFile(options.output, rendered, "utf8");
  } else {
    process.stdout.write(`${rendered}\n`);
  }

  if (meetsThreshold(findings, options.failOn)) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  process.stderr.write(
    `ci-delta runtime error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 3;
});

function collectIncludes(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
