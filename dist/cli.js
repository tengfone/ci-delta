#!/usr/bin/env node
import {
  LocalGitFileSource
} from "./chunk-COJGOLHW.js";
import {
  GitHubActionsAdapter,
  compareSources,
  meetsThreshold,
  reportToJson,
  reportToMarkdown
} from "./chunk-QDXXEBL4.js";

// src/cli/index.ts
import { promises as fs } from "fs";
import path from "path";
import { Command } from "commander";
var providerAliases = /* @__PURE__ */ new Set(["github-actions", "gha", "github"]);
async function run() {
  const program = new Command();
  program.name("ci-delta").description("Semantic diff reports for CI/CD config changes").argument("<provider>", "Provider name (github-actions, gha, github)").requiredOption("--base <ref>", "Base git ref").requiredOption("--head <ref>", "Head git ref").option("--format <format>", "markdown or json", "markdown").option("--output <file>", "Write report to file").option("--fail-on <severity>", "none|low|medium|high|critical", "none").option("--repo-root <path>", "Repository root", process.cwd()).option("--include <glob>", "Additional include glob", collectIncludes, []).option("--no-color", "Disable color output").showHelpAfterError();
  program.parse(process.argv);
  const providerInput = program.args[0];
  if (!providerAliases.has(providerInput)) {
    program.error(`Unsupported provider: ${providerInput}`, { exitCode: 2 });
  }
  const options = program.opts();
  if (!["markdown", "json"].includes(options.format)) {
    program.error(`Invalid --format: ${options.format}`, { exitCode: 2 });
  }
  const adapter = new GitHubActionsAdapter();
  const globs = [...adapter.workflowGlobs, ...options.include];
  const baseSource = new LocalGitFileSource(
    path.resolve(options.repoRoot),
    options.base
  );
  const headSource = new LocalGitFileSource(
    path.resolve(options.repoRoot),
    options.head
  );
  const report = await compareSources({
    provider: adapter,
    baseSource,
    headSource,
    globs,
    baseRef: options.base,
    headRef: options.head
  });
  const rendered = options.format === "json" ? reportToJson(report) : reportToMarkdown(report);
  if (options.output) {
    await fs.writeFile(options.output, rendered, "utf8");
  } else {
    process.stdout.write(`${rendered}
`);
  }
  if (meetsThreshold(report.findings, options.failOn)) {
    process.exitCode = 1;
  }
}
run().catch((error) => {
  process.stderr.write(
    `ci-delta runtime error: ${error instanceof Error ? error.message : String(error)}
`
  );
  process.exitCode = 3;
});
function collectIncludes(value, previous) {
  return [...previous, value];
}
